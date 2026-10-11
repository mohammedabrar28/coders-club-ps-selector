-- =====================================================================
-- Coders Club PS Selector — database self-test
--
-- Run in the Supabase SQL Editor AFTER schema.sql and `npm run provision`,
-- and BEFORE the event. Everything happens inside one transaction that is
-- rolled back at the end, so no data is changed.
--
-- It temporarily shrinks every problem statement to capacity 1 so that the
-- "full" path can be tested with only a handful of teams. Capacity 8 is
-- restored automatically by the rollback.
--
-- Success: the final result grid shows "ALL SQL TESTS PASSED".
-- Failure: you get an error that starts with "FAIL:".
-- =====================================================================
begin;

do $$
declare
  v_admin uuid;
  v_teams uuid[];
  r       jsonb;
  i       integer;
  n       integer;
  v_first text;
begin
  if (select count(*) from public.assignments where active) > 0 then
    raise exception 'ABORT: active assignments exist. Run this before the event, or clear them first.';
  end if;

  select id into v_admin from public.profiles where role = 'admin' limit 1;
  select array_agg(id order by team_code) into v_teams
  from public.profiles where role = 'team';

  if v_admin is null or coalesce(array_length(v_teams, 1), 0) <> 46 then
    raise exception 'ABORT: expected 1 admin and 46 teams. Run `npm run provision` first.';
  end if;

  update public.problem_statements set max_capacity = 1;

  -- 1. Six teams fill six slots, each on a different problem statement
  for i in 1..6 loop
    perform set_config('request.jwt.claim.sub', v_teams[i]::text, true);
    r := public.roll_problem_statement();
    if r->>'status' <> 'assigned' then
      raise exception 'FAIL: team % expected "assigned", got %', i, r;
    end if;
  end loop;

  select count(distinct problem_statement_id) into n
  from public.assignments where active;
  if n <> 6 then
    raise exception 'FAIL: expected 6 distinct problem statements, got %', n;
  end if;

  -- 2. Capacity is enforced: the 7th team is told everything is full
  perform set_config('request.jwt.claim.sub', v_teams[7]::text, true);
  r := public.roll_problem_statement();
  if r->>'status' <> 'full' then
    raise exception 'FAIL: 7th team should get "full", got %', r;
  end if;
  select count(*) into n from public.assignments where team_id = v_teams[7];
  if n <> 0 then
    raise exception 'FAIL: a full roll must not create an assignment row';
  end if;

  -- 3. Re-rolling returns the existing assignment and creates no second row
  perform set_config('request.jwt.claim.sub', v_teams[1]::text, true);
  select problem_statement_id into v_first
  from public.assignments where team_id = v_teams[1] and active;
  r := public.roll_problem_statement();
  if r->>'status' <> 'existing' or r->>'problem_statement_id' <> v_first then
    raise exception 'FAIL: re-roll should return existing %, got %', v_first, r;
  end if;
  select count(*) into n from public.assignments where team_id = v_teams[1] and active;
  if n <> 1 then
    raise exception 'FAIL: team 1 has % active rows, expected 1', n;
  end if;

  -- 4. The database itself refuses a duplicate active row and an overfull slot
  begin
    insert into public.assignments (team_id, problem_statement_id)
    values (v_teams[1], 'PS001');
    raise exception 'FAIL: duplicate active assignment was accepted';
  exception when unique_violation or check_violation then
    null;
  end;
  begin
    insert into public.assignments (team_id, problem_statement_id)
    values (v_teams[8], v_first);
    raise exception 'FAIL: over-capacity insert was accepted';
  exception when check_violation then
    null;
  end;

  -- 5. A team account cannot use admin functions
  begin
    perform public.admin_clear_assignment('T001');
    raise exception 'FAIL: a team cleared an assignment';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.admin_clear_all_assignments();
    raise exception 'FAIL: a team cleared all assignments';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.admin_get_overview();
    raise exception 'FAIL: a team read the admin overview';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.admin_get_audit_logs(10);
    raise exception 'FAIL: a team read the audit log';
  exception when insufficient_privilege then
    null;
  end;

  -- 6. The admin cannot roll
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  begin
    perform public.roll_problem_statement();
    raise exception 'FAIL: the admin account was allowed to roll';
  exception when insufficient_privilege then
    null;
  end;

  -- 7. Admin clears team 1: slot is released, history is kept, audit row exists
  r := public.admin_clear_assignment('t001');
  if (r->>'cleared')::boolean is not true then
    raise exception 'FAIL: clear_assignment returned %', r;
  end if;
  select count(*) into n from public.assignments where team_id = v_teams[1] and not active;
  if n <> 1 then
    raise exception 'FAIL: expected 1 historical row for team 1, got %', n;
  end if;
  select count(*) into n from public.audit_logs where action = 'clear_assignment';
  if n < 1 then
    raise exception 'FAIL: no audit log for clear_assignment';
  end if;

  -- 8. The released slot is usable again (team 7 can now roll successfully)
  perform set_config('request.jwt.claim.sub', v_teams[7]::text, true);
  r := public.roll_problem_statement();
  if r->>'status' <> 'assigned' or r->>'problem_statement_id' <> v_first then
    raise exception 'FAIL: team 7 should take the released slot %, got %', v_first, r;
  end if;

  -- 9. Team 1 can roll again after being cleared (and gets a free slot: none left)
  perform set_config('request.jwt.claim.sub', v_teams[1]::text, true);
  r := public.roll_problem_statement();
  if r->>'status' <> 'full' then
    raise exception 'FAIL: team 1 should find everything full again, got %', r;
  end if;

  -- 10. Clear all: no active rows, history kept, audit row written
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  r := public.admin_clear_all_assignments();
  if (r->>'cleared_count')::integer <> 6 then
    raise exception 'FAIL: clear_all expected 6 released, got %', r;
  end if;
  select count(*) into n from public.assignments where active;
  if n <> 0 then
    raise exception 'FAIL: % active rows remain after clear all', n;
  end if;
  select count(*) into n from public.assignments;
  if n <> 7 then
    raise exception 'FAIL: expected 7 historical rows, got %', n;
  end if;
  select count(*) into n from public.audit_logs where action = 'clear_all_assignments';
  if n < 1 then
    raise exception 'FAIL: no audit log for clear_all_assignments';
  end if;

  -- 11. Overview reports correct numbers from the database
  r := public.admin_get_overview();
  if (r->>'total_teams')::integer <> 46
     or (r->>'assigned_teams')::integer <> 0
     or (r->>'remaining_slots')::integer <> 6 then
    raise exception 'FAIL: overview numbers wrong: %', r;
  end if;
end
$$;

select 'ALL SQL TESTS PASSED' as result;

rollback;
