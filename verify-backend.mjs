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
