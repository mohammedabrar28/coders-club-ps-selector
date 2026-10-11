// Creates the 46 team accounts (T001–T046), the administrator account, their
// profile rows, and the six problem statements.
//
//   npm run provision                    create anything that is missing
//   npm run set-admin-password           explicitly set the admin password (from ADMIN_PASSWORD)
//   node --env-file=.env scripts/provision-users.mjs --reset-team T017
//                                        explicitly reset ONE team's password
//                                        (to TEAM_NEW_PASSWORD, or to the team ID if unset)
//
// SAFE TO RE-RUN. Existing users, passwords, profiles, problem statements and
// assignments are never modified or deleted unless you pass one of the two
// explicit flags above.
//
// This script needs the Supabase SERVICE-ROLE key. Run it only on your own
// computer, with the key in a private .env file. Never put that key in
// public/, never commit .env, never deploy it.

import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_USERNAME = 'Coderscrew',
  ADMIN_PASSWORD,
  TEAM_NEW_PASSWORD,
  EMAIL_DOMAIN = 'coders-club.example',
  PASSWORD_PREFIX = 'csps::',
} = process.env;

const TEAM_COUNT = 46;
const PS_COUNT = 6;
const PS_CAPACITY = 8;

function fail(message) {
  console.error(`\nError: ${message}\n`);
  process.exit(1);
}

if (!SUPABASE_URL || /YOUR-PROJECT/i.test(SUPABASE_URL)) {
  fail('SUPABASE_URL is missing. Copy .env.example to .env and fill it in.');
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  fail('SUPABASE_SERVICE_ROLE_KEY is missing. Copy .env.example to .env and fill it in.');
}

const args = process.argv.slice(2);
const setAdminPassword = args.includes('--set-admin-password');
const resetIndex = args.indexOf('--reset-team');
const resetTeam = resetIndex >= 0 ? (args[resetIndex + 1] || '').toUpperCase() : null;
if (resetIndex >= 0 && !/^T0(0[1-9]|[1-3][0-9]|4[0-6])$/.test(resetTeam || '')) {
  fail('--reset-team needs a team ID between T001 and T046, e.g. --reset-team T017');
}

const emailFor = (username) => `${username.toLowerCase()}@${EMAIL_DOMAIN}`;
// The browser prepends the same prefix before signing in. It exists only because
// Supabase requires 6+ characters and a team password like "T001" has four.
const authPassword = (password) => `${PASSWORD_PREFIX}${password}`;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function listAllUsers() {
  const byEmail = new Map();
  const perPage = 1000;
  for (let page = 1; ; page += 1) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage });
    if (error) fail(`Could not list users: ${error.message}`);
    for (const user of data.users) byEmail.set((user.email || '').toLowerCase(), user);
    if (data.users.length < perPage) break;
  }
  return byEmail;
}

async function ensureUser(byEmail, username, password, label) {
  const email = emailFor(username);
  const existing = byEmail.get(email);
  if (existing) return { user: existing, created: false };

  const { data, error } = await sb.auth.admin.createUser({
    email,
    password: authPassword(password),
    email_confirm: true,
  });
  if (error) fail(`Could not create ${label} (${username}): ${error.message}`);
  byEmail.set(email, data.user);
  return { user: data.user, created: true };
}

async function ensureProfile(user, { username, team_code, role }) {
  // ignoreDuplicates => INSERT ... ON CONFLICT DO NOTHING (never overwrites)
  const { error } = await sb
    .from('profiles')
    .upsert({ id: user.id, username, team_code, role }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) fail(`Could not write profile for ${username}: ${error.message}`);
}

async function main() {
  // Probe the schema early so a missing schema.sql gives a clear message.
  const probe = await sb.from('problem_statements').select('id', { head: true, count: 'exact' });
  if (probe.error) {
    fail(
      `The database tables are not ready (${probe.error.message}).\n` +
        'Run supabase/schema.sql in the Supabase SQL Editor first.'
    );
  }

  const byEmail = await listAllUsers();

  // ---- explicit, opt-in password operations -------------------------------
  if (setAdminPassword) {
    if (!ADMIN_PASSWORD) fail('Set ADMIN_PASSWORD in .env before using --set-admin-password.');
    const admin = byEmail.get(emailFor(ADMIN_USERNAME));
    if (!admin) fail('The admin account does not exist yet. Run `npm run provision` first.');
    const { error } = await sb.auth.admin.updateUserById(admin.id, {
      password: authPassword(ADMIN_PASSWORD),
    });
    if (error) fail(`Could not update the admin password: ${error.message}`);
    console.log('Admin password updated.');
    return;
  }

  if (resetTeam) {
    const user = byEmail.get(emailFor(resetTeam));
    if (!user) fail(`${resetTeam} does not exist yet. Run \`npm run provision\` first.`);
    const next = TEAM_NEW_PASSWORD || resetTeam;
    const { error } = await sb.auth.admin.updateUserById(user.id, { password: authPassword(next) });
    if (error) fail(`Could not reset ${resetTeam}: ${error.message}`);
    console.log(`${resetTeam} password reset. (Their saved assignment, if any, is unchanged.)`);
    return;
  }

  // ---- normal provisioning (create-if-missing only) -----------------------
  const { error: psError } = await sb
    .from('problem_statements')
    .upsert(
      Array.from({ length: PS_COUNT }, (_, i) => ({
        id: `PS${String(i + 1).padStart(3, '0')}`,
        max_capacity: PS_CAPACITY,
      })),
      { onConflict: 'id', ignoreDuplicates: true }
    );
  if (psError) fail(`Could not seed problem statements: ${psError.message}`);

  let createdTeams = 0;
  for (let n = 1; n <= TEAM_COUNT; n += 1) {
    const code = `T${String(n).padStart(3, '0')}`;
    // Initial password pattern: the team ID itself (T001 → T001).
    const { user, created } = await ensureUser(byEmail, code, code, `team ${code}`);
    await ensureProfile(user, { username: code, team_code: code, role: 'team' });
    if (created) createdTeams += 1;
  }

  if (!ADMIN_PASSWORD) {
    const hasAdmin = byEmail.has(emailFor(ADMIN_USERNAME));
    if (!hasAdmin) fail('ADMIN_PASSWORD is missing in .env (needed to create the admin account).');
  }
  const { user: adminUser, created: adminCreated } = await ensureUser(
    byEmail,
    ADMIN_USERNAME,
    ADMIN_PASSWORD,
    'the administrator'
  );
  await ensureProfile(adminUser, { username: ADMIN_USERNAME, team_code: null, role: 'admin' });

  // ---- verify -------------------------------------------------------------
  const count = async (table, filter) => {
    let q = sb.from(table).select('*', { head: true, count: 'exact' });
    if (filter) q = q.eq(...filter);
    const { count: c, error } = await q;
    if (error) fail(`Verification failed on ${table}: ${error.message}`);
    return c;
  };
  const teams = await count('profiles', ['role', 'team']);
  const admins = await count('profiles', ['role', 'admin']);
  const statements = await count('problem_statements');

  console.log('\nProvisioning finished.');
  console.log(`  Team accounts created this run : ${createdTeams} (existing ones were left untouched)`);
  console.log(`  Admin account                  : ${adminCreated ? 'created' : 'already existed, left untouched'}`);
  console.log(`  Team profiles in database      : ${teams} / ${TEAM_COUNT}`);
  console.log(`  Admin profiles in database     : ${admins} / 1`);
  console.log(`  Problem statements             : ${statements} / ${PS_COUNT}`);
  if (teams !== TEAM_COUNT || admins !== 1 || statements !== PS_COUNT) {
    fail('Counts do not match what was expected. Re-run the script and check the messages above.');
  }
  console.log('\nAll good. Remember to change the admin password before the event:');
  console.log('  1) edit ADMIN_PASSWORD in .env   2) npm run set-admin-password\n');
}

main().catch((err) => fail(err?.message || String(err)));
