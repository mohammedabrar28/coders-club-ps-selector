-- =====================================================================
-- Coders Club PS Selector — database setup
-- Run this once in: Supabase Dashboard → SQL Editor → New query → Run.
--
-- SAFE TO RE-RUN. What happens on a second run:
--   * Tables, rows, assignments and audit logs are NEVER dropped or truncated
--     (create table if not exists / insert ... on conflict do nothing).
--   * Functions are intentionally REPLACED (create or replace function) so you
--     can ship fixes to the logic without losing data.
--   * Row Level Security policies and the capacity trigger are intentionally
--     REPLACED (drop ... if exists, then create) so they always match this file.
--   * Table privileges are re-applied (revoke, then grant) to the values below.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------

-- One row per Supabase Auth user. Holds the role. The browser never writes here.
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  username    text not null,
  team_code   text,
  role        text not null default 'team',
  created_at  timestamptz not null default now(),
  constraint profiles_team_code_key unique (team_code),
  constraint profiles_role_check check (role in ('team', 'admin')),
  -- Teams must be T001..T046; the admin has no team code.
  constraint profiles_team_code_check check (
    (role = 'team'  and team_code ~ '^T0(0[1-9]|[1-3][0-9]|4[0-6])$')
    or (role = 'admin' and team_code is null)
  )
);
create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

-- Exactly six rows (PS001..PS006), each with a capacity.
create table if not exists public.problem_statements (
  id            text primary key,
  max_capacity  integer not null default 8,
  constraint problem_statements_id_check       check (id ~ '^PS00[1-6]$'),
  constraint problem_statements_capacity_check check (max_capacity > 0)
);

-- History of every allocation. active = true means "currently holds a slot".
-- Clearing an assignment sets active = false; the row is kept as history.
create table if not exists public.assignments (
  id                    bigint generated always as identity primary key,
  team_id               uuid not null references public.profiles (id) on delete cascade,
  problem_statement_id  text not null references public.problem_statements (id),
  assigned_at           timestamptz not null default now(),
  active                boolean not null default true,
  cleared_at            timestamptz,
  cleared_by            uuid references public.profiles (id) on delete set null
);

-- A team can hold at most ONE active assignment (enforced by the database).
create unique index if not exists assignments_one_active_per_team
  on public.assignments (team_id) where active;
-- Fast "how many active teams on this problem statement" counts.
create index if not exists assignments_active_ps_idx
  on public.assignments (problem_statement_id) where active;
create index if not exists assignments_team_idx
  on public.assignments (team_id);

create table if not exists public.audit_logs (
  id                bigint generated always as identity primary key,
  actor_id          uuid references public.profiles (id) on delete set null,
  action            text not null,
  target_team_code  text,
  details           jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);
create index if not exists audit_logs_created_idx
  on public.audit_logs (created_at desc);


-- ---------------------------------------------------------------------
-- 2. SEED THE SIX PROBLEM STATEMENTS (never overwrites existing rows)
-- ---------------------------------------------------------------------
insert into public.problem_statements (id, max_capacity) values
  ('PS001', 8), ('PS002', 8), ('PS003', 8),
  ('PS004', 8), ('PS005', 8), ('PS006', 8)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- 3. ROLE CHECK
--    Reads the role from the database using the verified JWT user id.
--    The browser can never supply or override it.
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
  );
$$;


-- ---------------------------------------------------------------------
-- 4. CAPACITY TRIGGER (last line of defence)
--    Even a direct INSERT/UPDATE cannot push a problem statement past its
--    capacity. It locks the problem statement row so concurrent writers queue.
-- ---------------------------------------------------------------------
create or replace function public.enforce_assignment_capacity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max   integer;
  v_count integer;
begin
  if new.active then
    select max_capacity into v_max
    from public.problem_statements
    where id = new.problem_statement_id
    for update;

    select count(*) into v_count
    from public.assignments
    where problem_statement_id = new.problem_statement_id
      and active
      and id is distinct from new.id;

    if v_count >= v_max then
      raise exception 'problem_statement_full' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists assignments_capacity on public.assignments;
create trigger assignments_capacity
  before insert or update on public.assignments
  for each row execute function public.enforce_assignment_capacity();


-- ---------------------------------------------------------------------
-- 5. STUDENT FUNCTIONS
-- ---------------------------------------------------------------------

-- Who am I, and what is my current assignment? (own data only)
create or replace function public.get_my_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_profile    public.profiles%rowtype;
  v_assignment public.assignments%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  if not found then
    return jsonb_build_object('role', null);
  end if;

  select * into v_assignment
  from public.assignments
  where team_id = v_uid and active;

  return jsonb_build_object(
    'username',  v_profile.username,
    'team_code', v_profile.team_code,
    'role',      v_profile.role,
    'assignment', case
      when v_assignment.id is null then null
      else jsonb_build_object(
        'problem_statement_id', v_assignment.problem_statement_id,
        'assigned_at',          v_assignment.assigned_at)
    end
  );
end;
$$;

-- Roll the dice. The database — not the browser — picks the result.
--
-- Concurrency strategy:
--   1. Lock all six problem_statements rows (always in id order → no deadlocks).
--      Every roll and every admin reset takes this lock, so allocations are
--      fully serialised. With 46 users this costs nothing and removes every
--      race condition (double assignment, capacity overflow).
--   2. Re-check for an existing assignment AFTER the lock is held.
--   3. Pick one random free SLOT (not just a random problem statement), so a
--      problem statement with more free slots is proportionally more likely.
--      That makes the final spread as even and fair as possible.
--   4. The unique partial index and the capacity trigger back this up.
create or replace function public.roll_problem_statement()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_profile  public.profiles%rowtype;
  v_existing public.assignments%rowtype;
  v_row      public.assignments%rowtype;
  v_choice   text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  if not found or v_profile.role <> 'team' then
    raise exception 'not_a_team_account' using errcode = '42501';
  end if;

  -- (1) serialise all allocation work
  perform 1 from public.problem_statements order by id for update;

  -- (2) already assigned? return the saved result, change nothing
  select * into v_existing
  from public.assignments
  where team_id = v_uid and active;
  if found then
    return jsonb_build_object(
      'status',               'existing',
      'team_code',            v_profile.team_code,
      'problem_statement_id', v_existing.problem_statement_id,
      'assigned_at',          v_existing.assigned_at);
  end if;

  -- (3) one random free slot across all problem statements
  select pick.id into v_choice
  from (
    select ps.id
    from public.problem_statements ps
    cross join lateral generate_series(
      1,
      ps.max_capacity - (
        select count(*)::integer
        from public.assignments a
        where a.problem_statement_id = ps.id and a.active
      )
    ) as slot
  ) pick
  order by random()
  limit 1;

  if v_choice is null then
    return jsonb_build_object('status', 'full', 'team_code', v_profile.team_code);
  end if;

  begin
    insert into public.assignments (team_id, problem_statement_id)
    values (v_uid, v_choice)
    returning * into v_row;
  exception when unique_violation then
    -- Extremely unlikely given the lock; return the winner's row if it happens.
    select * into v_row from public.assignments where team_id = v_uid and active;
    return jsonb_build_object(
      'status',               'existing',
      'team_code',            v_profile.team_code,
      'problem_statement_id', v_row.problem_statement_id,
      'assigned_at',          v_row.assigned_at);
  end;

  return jsonb_build_object(
    'status',               'assigned',
    'team_code',            v_profile.team_code,
    'problem_statement_id', v_row.problem_statement_id,
    'assigned_at',          v_row.assigned_at);
end;
$$;


-- ---------------------------------------------------------------------
-- 6. ADMINISTRATOR FUNCTIONS (each one checks is_admin() itself)
-- ---------------------------------------------------------------------

-- Everything the dashboard and the CSV exports need, in one consistent snapshot.
create or replace function public.admin_get_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'generated_at', now(),
    'total_teams',  (select count(*) from public.profiles where role = 'team'),
    'assigned_teams', (select count(*) from public.assignments where active),
    'unassigned_teams', (
      select count(*) from public.profiles pr
      where pr.role = 'team'
        and not exists (
          select 1 from public.assignments a where a.team_id = pr.id and a.active)
    ),
    'total_capacity', (select coalesce(sum(max_capacity), 0) from public.problem_statements),
    'remaining_slots', (
      (select coalesce(sum(max_capacity), 0) from public.problem_statements)
      - (select count(*) from public.assignments where active)
    ),
    'problem_statements', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'id',           x.id,
          'max_capacity', x.max_capacity,
          'active_count', x.active_count,
          'remaining',    x.max_capacity - x.active_count,
          'status', case
            when x.active_count >= x.max_capacity then 'Full'
            when x.max_capacity - x.active_count <= 2 then 'Almost Full'
            else 'Available'
          end
        ) order by x.id), '[]'::jsonb)
      from (
        select p.id, p.max_capacity,
               (select count(*)::integer from public.assignments a
                where a.problem_statement_id = p.id and a.active) as active_count
        from public.problem_statements p
      ) x
    ),
    'teams', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'team_code',            pr.team_code,
          'assigned',             a.id is not null,
          'problem_statement_id', a.problem_statement_id,
          'assigned_at',          a.assigned_at
        ) order by pr.team_code), '[]'::jsonb)
      from public.profiles pr
      left join public.assignments a on a.team_id = pr.id and a.active
      where pr.role = 'team'
    )
  ) into v_result;

  return v_result;
end;
$$;

-- Release one team's assignment. History is kept (active = false).
create or replace function public.admin_clear_assignment(p_team_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := auth.uid();
  v_team_id uuid;
  v_code    text := upper(btrim(coalesce(p_team_code, '')));
  v_ps      text;
  v_aid     bigint;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select id into v_team_id
  from public.profiles
  where role = 'team' and team_code = v_code;
  if not found then
    raise exception 'unknown_team' using errcode = 'P0002';
  end if;

  -- same lock as roll_problem_statement, so a clear and a roll never interleave
  perform 1 from public.problem_statements order by id for update;

  update public.assignments
     set active = false, cleared_at = now(), cleared_by = v_actor
   where team_id = v_team_id and active
  returning id, problem_statement_id into v_aid, v_ps;

  if v_aid is null then
    return jsonb_build_object('cleared', false, 'team_code', v_code);
  end if;

  insert into public.audit_logs (actor_id, action, target_team_code, details)
  values (v_actor, 'clear_assignment', v_code,
          jsonb_build_object('problem_statement_id', v_ps, 'assignment_id', v_aid));

  return jsonb_build_object(
    'cleared', true, 'team_code', v_code, 'problem_statement_id', v_ps);
end;
$$;

-- Release every active assignment. Accounts and passwords are untouched.
create or replace function public.admin_clear_all_assignments()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor     uuid := auth.uid();
  v_count     integer;
  v_breakdown jsonb;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  perform 1 from public.problem_statements order by id for update;

  select coalesce(jsonb_object_agg(s.problem_statement_id, s.n), '{}'::jsonb)
    into v_breakdown
  from (
    select problem_statement_id, count(*) as n
    from public.assignments where active
    group by problem_statement_id
  ) s;

  update public.assignments
     set active = false, cleared_at = now(), cleared_by = v_actor
   where active;
  get diagnostics v_count = row_count;

  insert into public.audit_logs (actor_id, action, target_team_code, details)
  values (v_actor, 'clear_all_assignments', null,
          jsonb_build_object('cleared_count', v_count, 'released_by_problem_statement', v_breakdown));

  return jsonb_build_object('cleared_count', v_count);
end;
$$;

-- Recent administrator activity (admin only).
create or replace function public.admin_get_audit_logs(p_limit integer default 100)
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
             'id',               t.id,
             'created_at',       t.created_at,
             'actor_username',   t.username,
             'action',           t.action,
             'target_team_code', t.target_team_code,
             'details',          t.details
           ) order by t.created_at desc, t.id desc)
    from (
      select l.id, l.created_at, l.action, l.target_team_code, l.details, p.username
      from public.audit_logs l
      left join public.profiles p on p.id = l.actor_id
      order by l.created_at desc, l.id desc
      limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) t
  ), '[]'::jsonb);
end;
$$;


-- ---------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY
--    There are NO insert/update/delete policies, so the browser cannot write
--    to any table. All writes go through the SECURITY DEFINER functions above.
-- ---------------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.problem_statements enable row level security;
alter table public.assignments        enable row level security;
alter table public.audit_logs         enable row level security;

drop policy if exists profiles_select_own   on public.profiles;
drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_select_admin on public.profiles
  for select to authenticated using ((select public.is_admin()));

drop policy if exists assignments_select_own   on public.assignments;
drop policy if exists assignments_select_admin on public.assignments;
create policy assignments_select_own on public.assignments
  for select to authenticated using (team_id = (select auth.uid()) and active);
create policy assignments_select_admin on public.assignments
  for select to authenticated using ((select public.is_admin()));

drop policy if exists problem_statements_select_admin on public.problem_statements;
create policy problem_statements_select_admin on public.problem_statements
  for select to authenticated using ((select public.is_admin()));

drop policy if exists audit_logs_select_admin on public.audit_logs;
create policy audit_logs_select_admin on public.audit_logs
  for select to authenticated using ((select public.is_admin()));


-- ---------------------------------------------------------------------
-- 8. PRIVILEGES
--    Supabase grants broad default privileges to anon/authenticated.
--    Strip them, then grant back only what is needed.
-- ---------------------------------------------------------------------
revoke all on table
  public.profiles, public.problem_statements, public.assignments, public.audit_logs
  from anon, authenticated;

-- Read-only, and RLS still limits which rows come back.
grant select on public.profiles, public.assignments to authenticated;

-- Functions: nobody by default, then only signed-in users. Anonymous visitors
-- cannot call any of them. Admin functions additionally check is_admin().
revoke all on function public.is_admin()                        from public, anon;
revoke all on function public.get_my_state()                    from public, anon;
revoke all on function public.roll_problem_statement()          from public, anon;
revoke all on function public.admin_get_overview()              from public, anon;
revoke all on function public.admin_clear_assignment(text)      from public, anon;
revoke all on function public.admin_clear_all_assignments()     from public, anon;
revoke all on function public.admin_get_audit_logs(integer)     from public, anon;
revoke all on function public.enforce_assignment_capacity()     from public, anon, authenticated;

grant execute on function public.is_admin()                     to authenticated;
grant execute on function public.get_my_state()                 to authenticated;
grant execute on function public.roll_problem_statement()       to authenticated;
grant execute on function public.admin_get_overview()           to authenticated;
grant execute on function public.admin_clear_assignment(text)   to authenticated;
grant execute on function public.admin_clear_all_assignments()  to authenticated;
grant execute on function public.admin_get_audit_logs(integer)  to authenticated;

-- ---------------------------------------------------------------------
-- Done. Next: create the accounts with `npm run provision` (see README).
-- ---------------------------------------------------------------------
