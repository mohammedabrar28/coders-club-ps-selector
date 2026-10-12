-- =====================================================================
-- Migration 001 — confidential problem statement content (admin only)
--
-- ADDITIVE ONLY. This migration:
--   * creates ONE new table (problem_statement_content) and new functions;
--   * does NOT alter, drop, truncate or rewrite profiles, assignments,
--     audit_logs, problem_statements, auth users, or any existing function;
--   * keeps max_capacity at 8 (it never touches problem_statements);
--   * is safe to run more than once (create ... if not exists; functions and
--     policies are replaced with identical definitions).
--
-- Prerequisite: supabase/schema.sql has already been run (it defines
-- is_admin(), problem_statements, profiles and audit_logs).
--
-- Run: Supabase Dashboard → SQL Editor → paste this whole file → Run.
-- The whole file runs as one transaction: if anything fails, nothing is applied.
-- =====================================================================
begin;

-- Fail early with a clear message if the base schema is missing.
do $$
begin
  if to_regclass('public.problem_statements') is null
     or to_regclass('public.profiles') is null
     or to_regclass('public.audit_logs') is null
     or to_regprocedure('public.is_admin()') is null then
    raise exception 'Run supabase/schema.sql first (base tables / is_admin() are missing).';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. TABLE  (one row per problem statement; absence of a row = "Not Added")
-- ---------------------------------------------------------------------
create table if not exists public.problem_statement_content (
  id                       bigint generated always as identity primary key,
  problem_statement_id     text not null
                             references public.problem_statements (id) on delete restrict,
  title                    text not null default '',
  description              text not null default '',
  category                 text not null default '',
  requirements             text not null default '',
  constraints_limitations  text not null default '',
  expected_outcome         text not null default '',
  additional_notes         text not null default '',
  status                   text not null default 'draft',
  version                  integer not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  updated_by               uuid references public.profiles (id) on delete set null,

  -- exactly one record per problem statement (no duplicates)
  constraint problem_statement_content_ps_key unique (problem_statement_id),
  constraint problem_statement_content_status_check check (status in ('draft', 'published')),
  constraint problem_statement_content_length_check check (
    char_length(title) <= 200
    and char_length(category) <= 100
    and char_length(description) <= 20000
    and char_length(requirements) <= 20000
    and char_length(constraints_limitations) <= 20000
    and char_length(expected_outcome) <= 20000
    and char_length(additional_notes) <= 20000
  ),
  -- a published statement must be complete (additional notes stay optional)
  constraint problem_statement_content_published_complete check (
    status <> 'published' or (
      btrim(title) <> '' and btrim(description) <> '' and btrim(category) <> ''
      and btrim(requirements) <> '' and btrim(constraints_limitations) <> ''
      and btrim(expected_outcome) <> ''
    )
  )
);

-- ---------------------------------------------------------------------
-- 2. ROW LEVEL SECURITY + PRIVILEGES
--    RLS is on and only an admin policy exists. In addition, NO table
--    privileges are granted to the browser roles, so a team leader's direct
--    query fails with "permission denied" before RLS is even consulted.
--    The admin dashboard uses the SECURITY DEFINER functions below.
-- ---------------------------------------------------------------------
alter table public.problem_statement_content enable row level security;

drop policy if exists problem_statement_content_select_admin on public.problem_statement_content;
create policy problem_statement_content_select_admin on public.problem_statement_content
  for select to authenticated using ((select public.is_admin()));
-- (no insert / update / delete policies: the browser can never write directly)

revoke all on table public.problem_statement_content from anon, authenticated;

-- Make sure this table is never broadcast through Supabase Realtime.
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'problem_statement_content'
  ) then
    alter publication supabase_realtime drop table public.problem_statement_content;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. ADMIN FUNCTIONS (each re-checks is_admin() from the verified login)
-- ---------------------------------------------------------------------

-- Summary of all six (title/category/status/last update). Admin only.
create or replace function public.admin_list_problem_statements()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id',         ps.id,
             'status',     coalesce(c.status, 'not_added'),
             'title',      c.title,
             'category',   c.category,
             'version',    coalesce(c.version, 0),
             'updated_at', c.updated_at
           ) order by ps.id)
    from public.problem_statements ps
    left join public.problem_statement_content c on c.problem_statement_id = ps.id
  ), '[]'::jsonb);
end;
$$;

-- Full content of one statement. Admin only.
create or replace function public.admin_get_problem_statement(p_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.problem_statement_content%rowtype;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_id is null or p_id !~ '^PS00[1-6]$' then
    raise exception 'invalid_problem_statement' using errcode = '22023';
  end if;

  select * into v_row from public.problem_statement_content where problem_statement_id = p_id;
  if not found then
    return jsonb_build_object(
      'id', p_id, 'status', 'not_added', 'version', 0,
      'title', '', 'description', '', 'category', '', 'requirements', '',
      'constraints_limitations', '', 'expected_outcome', '', 'additional_notes', '',
      'created_at', null, 'updated_at', null);
  end if;

  return jsonb_build_object(
    'id',                      v_row.problem_statement_id,
    'status',                  v_row.status,
    'version',                 v_row.version,
    'title',                   v_row.title,
    'description',             v_row.description,
    'category',                v_row.category,
    'requirements',            v_row.requirements,
    'constraints_limitations', v_row.constraints_limitations,
    'expected_outcome',        v_row.expected_outcome,
    'additional_notes',        v_row.additional_notes,
    'created_at',              v_row.created_at,
    'updated_at',              v_row.updated_at);
end;
$$;

-- Create or overwrite one statement as 'draft' or 'published'.
--   * p_expected_version guards against overwriting a newer save (0 = "new").
--   * 'published' requires every field except additional notes.
--   * The audit log records WHO did WHAT to WHICH id, never the content.
create or replace function public.admin_save_problem_statement(
  p_id               text,
  p_title            text,
  p_description      text,
  p_category         text,
  p_requirements     text,
  p_constraints      text,
  p_expected_outcome text,
  p_additional_notes text,
  p_status           text,
  p_expected_version integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := auth.uid();
  v_row     public.problem_statement_content%rowtype;
  v_title   text := btrim(coalesce(p_title, ''));
  v_desc    text := btrim(coalesce(p_description, ''));
  v_cat     text := btrim(coalesce(p_category, ''));
  v_req     text := btrim(coalesce(p_requirements, ''));
  v_con     text := btrim(coalesce(p_constraints, ''));
  v_out     text := btrim(coalesce(p_expected_outcome, ''));
  v_notes   text := btrim(coalesce(p_additional_notes, ''));
  v_missing text[] := '{}';
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_id is null or p_id !~ '^PS00[1-6]$' then
    raise exception 'invalid_problem_statement' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('draft', 'published') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  if char_length(v_title) > 200   then raise exception 'too_long: title'   using errcode = '22023'; end if;
  if char_length(v_cat)   > 100   then raise exception 'too_long: category' using errcode = '22023'; end if;
  if char_length(v_desc)  > 20000 then raise exception 'too_long: description' using errcode = '22023'; end if;
  if char_length(v_req)   > 20000 then raise exception 'too_long: requirements' using errcode = '22023'; end if;
  if char_length(v_con)   > 20000 then raise exception 'too_long: constraints' using errcode = '22023'; end if;
  if char_length(v_out)   > 20000 then raise exception 'too_long: expected outcome' using errcode = '22023'; end if;
  if char_length(v_notes) > 20000 then raise exception 'too_long: additional notes' using errcode = '22023'; end if;

  if p_status = 'published' then
    if v_title = '' then v_missing := v_missing || 'title'; end if;
    if v_desc  = '' then v_missing := v_missing || 'description'; end if;
    if v_cat   = '' then v_missing := v_missing || 'category'; end if;
    if v_req   = '' then v_missing := v_missing || 'requirements'; end if;
    if v_con   = '' then v_missing := v_missing || 'constraints'; end if;
    if v_out   = '' then v_missing := v_missing || 'expected outcome'; end if;
    if cardinality(v_missing) > 0 then
      raise exception 'missing_fields: %', array_to_string(v_missing, ', ') using errcode = '22023';
    end if;
  end if;

  -- same lock the allocation functions use for this statement: saves serialise
  perform 1 from public.problem_statements where id = p_id for update;

  select * into v_row from public.problem_statement_content where problem_statement_id = p_id;
  if found then
    if p_expected_version is distinct from v_row.version then
      raise exception 'stale_version' using errcode = '40001';
    end if;
    update public.problem_statement_content
       set title = v_title, description = v_desc, category = v_cat,
           requirements = v_req, constraints_limitations = v_con,
           expected_outcome = v_out, additional_notes = v_notes,
           status = p_status, version = version + 1,
           updated_at = now(), updated_by = v_actor
     where problem_statement_id = p_id
    returning * into v_row;
  else
    if coalesce(p_expected_version, 0) <> 0 then
      raise exception 'stale_version' using errcode = '40001';
    end if;
    insert into public.problem_statement_content
      (problem_statement_id, title, description, category, requirements,
       constraints_limitations, expected_outcome, additional_notes, status, updated_by)
    values
      (p_id, v_title, v_desc, v_cat, v_req, v_con, v_out, v_notes, p_status, v_actor)
    returning * into v_row;
  end if;

  insert into public.audit_logs (actor_id, action, target_team_code, details)
  values (
    v_actor,
    case when p_status = 'published' then 'problem_statement_published' else 'problem_statement_saved' end,
    null,
    jsonb_build_object('problem_statement_id', p_id, 'status', p_status, 'version', v_row.version));

  return jsonb_build_object(
    'id', v_row.problem_statement_id, 'status', v_row.status, 'version', v_row.version,
    'created_at', v_row.created_at, 'updated_at', v_row.updated_at);
end;
$$;

-- ---------------------------------------------------------------------
-- 4. FUNCTION PRIVILEGES: signed-in users only; each function then checks admin
-- ---------------------------------------------------------------------
revoke all on function public.admin_list_problem_statements()  from public, anon;
revoke all on function public.admin_get_problem_statement(text) from public, anon;
revoke all on function public.admin_save_problem_statement(
  text, text, text, text, text, text, text, text, text, integer) from public, anon;

grant execute on function public.admin_list_problem_statements()  to authenticated;
grant execute on function public.admin_get_problem_statement(text) to authenticated;
grant execute on function public.admin_save_problem_statement(
  text, text, text, text, text, text, text, text, text, integer) to authenticated;

commit;
