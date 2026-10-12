-- =====================================================================
-- Database self-test for migration 001 (confidential problem statements)
--
-- Run in the Supabase SQL Editor after schema.sql, `npm run provision`, and
-- migration 001. It runs inside ONE transaction that is ROLLED BACK, so
-- nothing is kept: real problem statements you've already entered are safe
-- (the test temporarily empties the content table inside the transaction).
--
-- It switches into the real `authenticated` and `anon` database roles to prove
-- that team leaders and signed-out visitors are refused by PostgreSQL itself.
--
-- Success: the result grid shows "ALL PROBLEM STATEMENT TESTS PASSED".
-- Failure: an error starting with "FAIL:".
-- =====================================================================
begin;

do $$
declare
  v_admin uuid;
  v_team  uuid;
  v_team2 uuid;
  r       jsonb;
  n       integer;
  i       integer;
  v_ver   integer;
begin
  select id into v_admin from public.profiles where role = 'admin' limit 1;
  select id into v_team  from public.profiles where role = 'team' and team_code = 'T001';
  select id into v_team2 from public.profiles where role = 'team' and team_code = 'T002';
  if v_admin is null or v_team is null or v_team2 is null then
    raise exception 'ABORT: run `npm run provision` first (admin + teams missing).';
  end if;
  if to_regclass('public.problem_statement_content') is null then
    raise exception 'ABORT: apply supabase/migrations/001_problem_statement_content.sql first.';
  end if;

  -- (rolled back at the end) start from an empty content table
  delete from public.problem_statement_content;

  -- ---------------- admin: add all six as drafts ----------------
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  for i in 1..6 loop
    r := public.admin_save_problem_statement(
      'PS00' || i, 'SECRET-TITLE-' || i, 'SECRET-DESC-' || i, 'SECRET-CAT-' || i,
      'SECRET-REQ-' || i, 'SECRET-CON-' || i, 'SECRET-OUT-' || i, 'SECRET-NOTES-' || i,
      'draft', 0);
    if r->>'status' <> 'draft' or (r->>'version')::int <> 1 then
      raise exception 'FAIL: draft save for PS00% returned %', i, r;
    end if;
  end loop;

  r := public.admin_list_problem_statements();
  if jsonb_array_length(r) <> 6 then raise exception 'FAIL: list should return 6, got %', r; end if;
  select count(*) into n from jsonb_array_elements(r) e where e->>'status' = 'draft';
  if n <> 6 then raise exception 'FAIL: expected 6 drafts, got %', n; end if;

  r := public.admin_get_problem_statement('PS003');
  if r->>'title' <> 'SECRET-TITLE-3' or r->>'constraints_limitations' <> 'SECRET-CON-3' then
    raise exception 'FAIL: admin could not read back saved content: %', r;
  end if;

  -- ---------------- optimistic concurrency (no silent overwrite) ----------------
  begin
    perform public.admin_save_problem_statement('PS003','x','x','x','x','x','x','x','draft', 0);
    raise exception 'FAIL: stale save (version 0 on existing row) was accepted';
  exception when serialization_failure then null;
  end;

  -- ---------------- publish rules ----------------
  begin
    perform public.admin_save_problem_statement('PS001','t','d','','r','c','o','','published', 1);
    raise exception 'FAIL: publish with an empty category was accepted';
  exception when invalid_parameter_value then null;
  end;
  r := public.admin_save_problem_statement(
    'PS001','SECRET-TITLE-1','SECRET-DESC-1','SECRET-CAT-1','SECRET-REQ-1','SECRET-CON-1','SECRET-OUT-1','',
    'published', 1);
  if r->>'status' <> 'published' or (r->>'version')::int <> 2 then
    raise exception 'FAIL: publish returned %', r;
  end if;
  if (public.admin_get_problem_statement('PS001')->>'title') <> 'SECRET-TITLE-1' then
    raise exception 'FAIL: published content not readable by admin';
  end if;
  begin
    perform public.admin_save_problem_statement('PS001','a','b','c','d','e','f','g','draft', 99);
    raise exception 'FAIL: wrong expected_version was accepted';
  exception when serialization_failure then null;
  end;
  begin
    perform public.admin_save_problem_statement('PS007','a','b','c','d','e','f','g','draft', 0);
    raise exception 'FAIL: invalid problem statement id was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.admin_save_problem_statement('PS002', repeat('x', 201), 'b','c','d','e','f','g','draft', 1);
    raise exception 'FAIL: over-long title was accepted';
  exception when invalid_parameter_value then null;
  end;

  -- ---------------- database-level safeguards (as table owner) ----------------
  begin
    insert into public.problem_statement_content (problem_statement_id, title) values ('PS001', 'duplicate');
    raise exception 'FAIL: a duplicate record for PS001 was accepted';
  exception when unique_violation then null;
  end;
  begin
    update public.problem_statement_content set title = '' where problem_statement_id = 'PS001';
    raise exception 'FAIL: published row with empty title was accepted';
  exception when check_violation then null;
  end;

  -- ---------------- audit log: events recorded, content NEVER stored ----------------
  select count(*) into n from public.audit_logs where action in ('problem_statement_saved','problem_statement_published');
  if n < 7 then raise exception 'FAIL: expected audit rows for saves/publish, got %', n; end if;
  select count(*) into n from public.audit_logs where details::text ilike '%SECRET%' or target_team_code ilike '%SECRET%';
  if n <> 0 then raise exception 'FAIL: confidential text leaked into audit_logs'; end if;

  -- ---------------- existing admin outputs contain no content ----------------
  if public.admin_get_overview()::text ilike '%SECRET%' then
    raise exception 'FAIL: admin overview (used for CSV exports) contains problem statement content';
  end if;
  if public.admin_get_audit_logs(500)::text ilike '%SECRET%' then
    raise exception 'FAIL: audit log API contains problem statement content';
  end if;

  -- ---------------- TEAM LEADER, as the real `authenticated` role ----------------
  perform set_config('request.jwt.claim.sub', v_team::text, true);
  set local role authenticated;

  begin
    perform 1 from public.problem_statement_content limit 1;
    raise exception 'FAIL: team leader could SELECT from problem_statement_content';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.problem_statement_content (problem_statement_id, title) values ('PS004','hack');
    raise exception 'FAIL: team leader could INSERT into problem_statement_content';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.problem_statement_content set title = 'hack';
    raise exception 'FAIL: team leader could UPDATE problem_statement_content';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.problem_statement_content;
    raise exception 'FAIL: team leader could DELETE from problem_statement_content';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_list_problem_statements();
    raise exception 'FAIL: team leader called admin_list_problem_statements';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_get_problem_statement('PS001');
    raise exception 'FAIL: team leader called admin_get_problem_statement';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_save_problem_statement('PS001','a','b','c','d','e','f','g','draft', 2);
    raise exception 'FAIL: team leader called admin_save_problem_statement';
  exception when insufficient_privilege then null;
  end;

  -- the team's normal workflow still works and returns only the PS id
  r := public.get_my_state();
  if r::text ilike '%SECRET%' then raise exception 'FAIL: get_my_state leaked content: %', r; end if;
  -- roll as the real role (an assignment may already exist; either result is fine)
  r := public.roll_problem_statement();
  if r::text ilike '%SECRET%' then raise exception 'FAIL: roll result leaked content: %', r; end if;
  if r->>'status' not in ('assigned','existing','full') then raise exception 'FAIL: roll workflow broken: %', r; end if;
  if (r ? 'title') or (r ? 'description') then raise exception 'FAIL: roll result has content keys'; end if;
  reset role;

  -- a second team leader: same refusals
  perform set_config('request.jwt.claim.sub', v_team2::text, true);
  set local role authenticated;
  begin
    perform 1 from public.problem_statement_content limit 1;
    raise exception 'FAIL: second team leader could SELECT content';
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- ---------------- signed-out visitor, as the real `anon` role ----------------
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  begin
    perform 1 from public.problem_statement_content limit 1;
    raise exception 'FAIL: anonymous visitor could SELECT content';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_list_problem_statements();
    raise exception 'FAIL: anonymous visitor called an admin content function';
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- ---------------- untouched things ----------------
  select count(*) into n from public.problem_statements where max_capacity = 8;
  if n <> 6 then raise exception 'FAIL: problem statement capacity changed (% of 6 still 8)', n; end if;
end
$$;

select 'ALL PROBLEM STATEMENT TESTS PASSED' as result;

rollback;
