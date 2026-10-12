// End-to-end check of the LIVE backend, using the same public key the website uses.
//
//   npm run verify -- --allow-clear
//
// It signs in as real team accounts, rolls concurrently, checks capacity,
// permissions, persistence, and the admin reset functions. It finishes by
// calling "clear all", so it REFUSES to run if any team already has an
// assignment, and it needs --allow-clear to confirm you understand that.
// Run it BEFORE the event, never during it.
//
// Optional: --teams=N  (default 46) use fewer team accounts.
//
// Heads-up: signing in 46 accounts from one computer in a few seconds can hit
// Supabase's per-IP sign-in rate limit (default 30 per 5 minutes). Either raise
// the limit temporarily (Authentication → Rate Limits) or use --teams=25.

import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_USERNAME = 'Coderscrew',
  ADMIN_PASSWORD,
  EMAIL_DOMAIN = 'coders-club.example',
  PASSWORD_PREFIX = 'csps::',
} = process.env;

const args = process.argv.slice(2);
const teamArg = args.find((a) => a.startsWith('--teams='));
const TEAM_N = teamArg ? Number(teamArg.split('=')[1]) : 46;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !ADMIN_PASSWORD) {
  console.error('Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and ADMIN_PASSWORD in .env first.');
  process.exit(1);
}
if (!args.includes('--allow-clear')) {
  console.error('This test finishes by clearing ALL assignments. Re-run with --allow-clear to confirm.');
  process.exit(1);
}
if (!Number.isInteger(TEAM_N) || TEAM_N < 2 || TEAM_N > 46) {
  console.error('--teams must be a whole number from 2 to 46.');
  process.exit(1);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(username, password) {
  const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: `${username.toLowerCase()}@${EMAIL_DOMAIN}`,
    password: `${PASSWORD_PREFIX}${password}`,
  });
  if (error) throw new Error(`Sign-in failed for ${username}: ${error.message}`);
  return client;
}

const rpc = async (client, fn, params) => client.rpc(fn, params);
const teamCode = (i) => `T${String(i).padStart(3, '0')}`;


// ---------------------------------------------------------------------------
// Confidential problem statement checks (needs migration 001 applied).
// Uses the content you've already entered; if none exists it writes a temporary
// marker draft to PS001 and removes it again with the service-role key
// (local .env only). Without that key and without content, the checks are skipped.
// ---------------------------------------------------------------------------
async function contentChecks(admin, team, anon) {
  const list = await rpc(admin, 'admin_list_problem_statements');
  if (list.error) {
    check('Problem statement functions exist (apply migration 001)', false, list.error.message);
    return;
  }
  check('Admin can list the six problem statements', list.data.length === 6);

  const needles = [];
  let marker = null;
  const filled = list.data.filter((x) => x.status !== 'not_added');
  if (filled.length === 0) {
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      console.log('SKIP  content leak checks: no problem statements entered yet and no SUPABASE_SERVICE_ROLE_KEY to clean up a test one.');
      console.log('      Enter content in the admin dashboard, then re-run this (it will be left untouched).');
      return;
    }
    marker = `LEAKCHECK-${Date.now()}`;
    const w = await rpc(admin, 'admin_save_problem_statement', {
      p_id: 'PS001', p_title: `${marker}-title`, p_description: `${marker}-description`, p_category: `${marker}-category`,
      p_requirements: `${marker}-requirements`, p_constraints: `${marker}-constraints`,
      p_expected_outcome: `${marker}-outcome`, p_additional_notes: `${marker}-notes`,
      p_status: 'draft', p_expected_version: 0,
    });
    check('Admin can save a draft', !w.error, w.error?.message);
    needles.push(marker);
  } else {
    for (const item of filled) {
      const full = (await rpc(admin, 'admin_get_problem_statement', { p_id: item.id })).data;
      for (const key of ['title', 'description', 'requirements', 'constraints_limitations', 'expected_outcome', 'additional_notes']) {
        const piece = String(full[key] || '').trim().slice(0, 40);
        if (piece.length >= 8) needles.push(piece);
      }
    }
    console.log(`      using ${needles.length} text snippets from your real content as leak markers`);
  }
  const leaks = (value) => needles.some((n) => JSON.stringify(value ?? null).includes(n));

  try {
    const back = await signIn(ADMIN_USERNAME, ADMIN_PASSWORD);
    const again = await rpc(back, 'admin_get_problem_statement', { p_id: marker ? 'PS001' : filled[0].id });
    check('Admin reads saved content back after a fresh sign-in', !again.error && String(again.data.title || '').length > 0);

    // direct table access by a team leader
    const direct = await team.from('problem_statement_content').select('*');
    check('Team cannot read problem_statement_content directly', direct.error != null || (direct.data ?? []).length === 0, direct.error?.code);
    check('…and gets none of the content back', !leaks(direct.data));
    // Non-destructive probes: they match nothing / use an invalid id, so even if
    // security were broken they could not change your content.
    const ins = await team.from('problem_statement_content').insert({ problem_statement_id: 'PS999', title: 'x' });
    check('Team cannot insert into problem_statement_content', ins.error?.code === '42501', ins.error?.code);
    const upd = await team.from('problem_statement_content').update({ title: 'x' }).eq('title', '__no_such_title__').select();
    check('Team cannot update problem_statement_content', upd.error?.code === '42501' || (upd.data ?? []).length === 0, upd.error?.code);
    const del = await team.from('problem_statement_content').delete().eq('title', '__no_such_title__').select();
    check('Team cannot delete from problem_statement_content', del.error?.code === '42501' || (del.data ?? []).length === 0, del.error?.code);
    const anonRead = await anon.from('problem_statement_content').select('*');
    check('Signed-out visitor cannot read problem_statement_content', anonRead.error != null || (anonRead.data ?? []).length === 0);

    // admin functions
    for (const [fn, params] of [
      ['admin_list_problem_statements', undefined],
      ['admin_get_problem_statement', { p_id: 'PS001' }],
      ['admin_save_problem_statement', { p_id: 'PS999', p_title: 'x', p_description: 'x', p_category: 'x', p_requirements: 'x', p_constraints: 'x', p_expected_outcome: 'x', p_additional_notes: '', p_status: 'draft', p_expected_version: 1 }],
    ]) {
      const t = await rpc(team, fn, params);
      check(`Team cannot call ${fn} (permission denied)`, t.error?.code === '42501' && !leaks(t.data), t.error?.code);
      const a = await rpc(anon, fn, params);
      check(`Signed-out visitor cannot call ${fn}`, a.error != null && !leaks(a.data), a.error?.code);
    }

    // everything a team (or an export) can legitimately receive is content-free
    const mine = await rpc(team, 'get_my_state');
    const roll = await rpc(team, 'roll_problem_statement');
    check('get_my_state response has no content', !mine.error && !leaks(mine.data));
    check('roll response has no content (only PS id)', !roll.error && !leaks(roll.data) && roll.data.problem_statement_id !== undefined);
    for (const table of ['profiles', 'assignments', 'problem_statements', 'audit_logs']) {
      const r = await team.from(table).select('*');
      check(`Team's view of ${table} has no content`, !leaks(r.data));
    }
    const overview = await rpc(admin, 'admin_get_overview');
    check('Admin overview (source of all CSV exports) has no content', !leaks(overview.data));
    const logs = await rpc(admin, 'admin_get_audit_logs', { p_limit: 200 });
    check('Audit log has no content', !leaks(logs.data));
    if (marker) check('Audit log recorded the draft save', (logs.data || []).some((l) => l.action === 'problem_statement_saved'));
  } finally {
    if (marker && SUPABASE_SERVICE_ROLE_KEY) {
      const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      const del = await svc.from('problem_statement_content').delete().eq('problem_statement_id', 'PS001').like('title', 'LEAKCHECK-%');
      console.log(del.error ? `      WARNING: could not remove the temporary PS001 draft: ${del.error.message}` : '      temporary PS001 draft removed');
    }
  }
}

async function main() {
  console.log(`\nVerifying backend at ${SUPABASE_URL} with ${TEAM_N} team accounts\n`);

  // --- admin + baseline ------------------------------------------------------
  const admin = await signIn(ADMIN_USERNAME, ADMIN_PASSWORD);
  check('Administrator can sign in', true);

  let { data: ov, error } = await rpc(admin, 'admin_get_overview');
  if (error) throw new Error(`admin_get_overview failed: ${error.message}`);
  check('Overview lists 46 teams', ov.total_teams === 46, `got ${ov.total_teams}`);
  check(
    'Six problem statements, capacity 8 each',
    ov.problem_statements.length === 6 && ov.problem_statements.every((p) => p.max_capacity === 8)
  );
  if (ov.assigned_teams > 0) {
    throw new Error('Some teams already have assignments. Clear them first; this test will not run on live data.');
  }

  // --- sign in teams ---------------------------------------------------------
  const teams = [];
  for (let i = 1; i <= TEAM_N; i += 1) {
    teams.push({ code: teamCode(i), client: await signIn(teamCode(i), teamCode(i)) });
    await sleep(120);
  }
  check(`${TEAM_N} team accounts can sign in`, teams.length === TEAM_N);

  // --- simultaneous requests for the SAME team --------------------------------
  const t0 = teams[0];
  const dup = await Promise.all([rpc(t0.client, 'roll_problem_statement'), rpc(t0.client, 'roll_problem_statement')]);
  const dupOk = dup.every((r) => !r.error);
  const dupStatuses = dup.map((r) => r.data?.status).sort().join(',');
  check('Two simultaneous rolls from one team succeed', dupOk);
  check('…exactly one "assigned" and one "existing"', dupStatuses === 'assigned,existing', dupStatuses);
  check('…and both return the same problem statement', dup[0].data?.problem_statement_id === dup[1].data?.problem_statement_id);

  // --- every other team rolls at the same moment ------------------------------
  const rolls = await Promise.all(teams.slice(1).map((t) => rpc(t.client, 'roll_problem_statement')));
  check('All simultaneous rolls succeeded', rolls.every((r) => !r.error), rolls.find((r) => r.error)?.error?.message);
  const assigned = new Map([[t0.code, dup[0].data.problem_statement_id]]);
  teams.slice(1).forEach((t, i) => assigned.set(t.code, rolls[i].data?.problem_statement_id));

  ({ data: ov } = await rpc(admin, 'admin_get_overview'));
  check('Assigned teams = number of teams that rolled', ov.assigned_teams === TEAM_N, `${ov.assigned_teams}/${TEAM_N}`);
  check('No problem statement exceeds 8 active teams', ov.problem_statements.every((p) => p.active_count <= 8));
  check(
    'Per-problem counts add up to the total',
    ov.problem_statements.reduce((s, p) => s + p.active_count, 0) === TEAM_N
  );
  console.log('      spread:', ov.problem_statements.map((p) => `${p.id}=${p.active_count}`).join('  '));

  // --- repeat rolls and persistence ------------------------------------------
  const again = await Promise.all(teams.map((t) => rpc(t.client, 'roll_problem_statement')));
  check(
    'Repeated rolls return the same saved assignment',
    again.every((r, i) => r.data?.status === 'existing' && r.data.problem_statement_id === assigned.get(teams[i].code))
  );
  const reLogin = await signIn(t0.code, t0.code);
  const { data: state } = await rpc(reLogin, 'get_my_state');
  check('Logout + login keeps the assignment', state?.assignment?.problem_statement_id === assigned.get(t0.code));

  // --- permissions -------------------------------------------------------------
  const probe = teams[1].client;
  const seen = await probe.from('assignments').select('*');
  check('A team can read only its own assignment rows', !seen.error && seen.data.length === 1 && seen.data[0].active === true);
  const profs = await probe.from('profiles').select('*');
  check('A team can read only its own profile', !profs.error && profs.data.length === 1);
  check('A team cannot read problem_statements directly', (await probe.from('problem_statements').select('*')).data?.length === 0);
  const aud = await probe.from('audit_logs').select('*');
  check('A team cannot read audit logs', aud.error != null || aud.data.length === 0);
  const ins = await probe.from('assignments').insert({ team_id: (await probe.auth.getUser()).data.user.id, problem_statement_id: 'PS001' });
  check('A team cannot insert into assignments', ins.error != null);
  const upd = await probe.from('assignments').update({ active: false }).neq('id', 0).select();
  check('A team cannot update assignments', upd.error != null || (upd.data ?? []).length === 0);
  const del = await probe.from('assignments').delete().neq('id', 0).select();
  check('A team cannot delete assignments', del.error != null || (del.data ?? []).length === 0);
  for (const fn of ['admin_get_overview', 'admin_clear_all_assignments']) {
    const r = await rpc(probe, fn);
    check(`A team cannot call ${fn}`, r.error != null);
  }
  check('A team cannot call admin_clear_assignment', (await rpc(probe, 'admin_clear_assignment', { p_team_code: teams[0].code })).error != null);
  check('A team cannot call admin_get_audit_logs', (await rpc(probe, 'admin_get_audit_logs', { p_limit: 5 })).error != null);
  const anon = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  check('Signed-out visitors cannot roll', (await rpc(anon, 'roll_problem_statement')).error != null);
  check('The admin account cannot roll', (await rpc(admin, 'roll_problem_statement')).error != null);

  // --- confidential problem statements ---------------------------------------
  await contentChecks(admin, teams[1].client, anon);

  // --- admin: clear one -------------------------------------------------------
  const before = ov.assigned_teams;
  const cleared = await rpc(admin, 'admin_clear_assignment', { p_team_code: t0.code });
  check('Admin can clear one assignment', cleared.data?.cleared === true);
  ({ data: ov } = await rpc(admin, 'admin_get_overview'));
  check('…which releases exactly one slot', ov.assigned_teams === before - 1);
  const reroll = await rpc(t0.client, 'roll_problem_statement');
  check('…and that team can roll again', reroll.data?.status === 'assigned');

  // --- admin: clear all ---------------------------------------------------------
  const all = await rpc(admin, 'admin_clear_all_assignments');
  check('Admin can clear all assignments', all.data?.cleared_count === TEAM_N, `released ${all.data?.cleared_count}`);
  ({ data: ov } = await rpc(admin, 'admin_get_overview'));
  check('…leaving 0 assigned and all 48 slots free', ov.assigned_teams === 0 && ov.remaining_slots === 48);
  const { data: logs } = await rpc(admin, 'admin_get_audit_logs', { p_limit: 20 });
  check(
    'Audit log recorded both admin actions',
    logs.some((l) => l.action === 'clear_assignment') && logs.some((l) => l.action === 'clear_all_assignments')
  );
  console.log('\n(History rows are checked by supabase/tests.sql — the browser role cannot read inactive rows.)');
}

main()
  .catch((e) => {
    check(`Unexpected error: ${e.message}`, false);
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed.\n`);
    process.exit(failed ? 1 : 0);
  });
