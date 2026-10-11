# Coders Club PS Selector

**Roll the Dice. Get Your Problem Statement.**

A static website plus a Supabase backend that randomly assigns one of six problem
statements (PS001–PS006, eight teams each) to 46 team leaders. The database picks
and saves every result; the browser only plays the animation and shows what the
database returned.

> **Status:** the code is complete, but it has **not been connected to a real
> Supabase project or deployed**. See [What has and hasn't been tested](#what-has-and-hasnt-been-tested).

---

## What's in the box

```
coders-club-ps-selector/
├── public/                  ← the website (this is the only folder you deploy)
│   ├── index.html
│   ├── style.css
│   ├── script.js
│   └── config.js            ← you paste your PUBLIC Supabase URL + key here
├── supabase/
│   ├── schema.sql           ← tables, RLS, secure functions (run once)
│   └── tests.sql            ← database self-test (rolls back, changes nothing)
├── scripts/
│   ├── provision-users.mjs  ← creates T001–T046 + admin (run locally, safe to re-run)
│   └── verify-backend.mjs   ← live end-to-end check (run before the event)
├── .github/workflows/pages.yml   ← deploys /public to GitHub Pages
├── .env.example  .gitignore  package.json  README.md
```

---

## Setup (about 20 minutes)

You need: a free [Supabase](https://supabase.com) account, a GitHub account, and
[Node.js 20.6+](https://nodejs.org) on your computer.

### 1. Create the Supabase project
Supabase dashboard → **New project**. Pick any name and region, set a database
password (store it somewhere safe), wait for it to finish starting.

### 2. Run the SQL schema
Dashboard → **SQL Editor → New query** → paste the entire contents of
`supabase/schema.sql` → **Run**. It should finish with "Success".

Safe to re-run later: it never drops tables or data. It intentionally **replaces**
functions, RLS policies and the capacity trigger so they always match the file.

### 3. Configure Supabase Auth  (do not skip)
Dashboard → **Authentication**:

1. **Sign In / Providers → Email**: keep *Email* enabled. Turn **off** *Confirm email*
   (accounts are created by the script, already confirmed).
2. **Sign In / Providers**: turn **off** *Allow new users to sign up*. Otherwise anyone
   with your public key could create accounts. (They couldn't roll or see anything,
   since they'd have no team profile, but there's no reason to allow it.)
3. **Rate Limits**: see the warning below.

> **⚠ Campus Wi-Fi rate limit.** Supabase limits sign-ins to about **30 per 5 minutes
> per IP address** by default. If all 46 leaders sit on the same campus network they
> share one IP and some will see "Too many requests". Before the event, raise
> *Rate limit for sign-ups and sign-ins* (Authentication → Rate Limits) to something
> like 300 per 5 minutes, or stagger when teams log in.

### 4. Get your keys
Dashboard → **Project Settings → API** (or **API Keys**):

- **Project URL**: public.
- **Publishable key** (older projects call it *anon*): public, goes in the website.
- **service_role / secret key**: **private**. Only ever used on your own computer.

### 5. Provision the accounts (on your computer)
```bash
cd coders-club-ps-selector
npm install
cp .env.example .env        # Windows PowerShell: copy .env.example .env
```
Open `.env` and fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_PUBLISHABLE_KEY`. Change `ADMIN_PASSWORD` now if you like. Then:
```bash
npm run provision
```
Expected ending: `Team profiles in database : 46 / 46`, `Admin profiles : 1 / 1`,
`Problem statements : 6 / 6`.

Re-running it later is safe: existing accounts, passwords and assignments are left
alone. Passwords only change when you ask explicitly (see
[Changing passwords](#changing-passwords)).

### 6. Point the website at your project
Edit `public/config.js`: paste the **Project URL** and **Publishable key**.
Leave `EMAIL_DOMAIN` and `PASSWORD_PREFIX` as they are (they must match `.env`).
Never put the service_role key here.

### 7. Run the database test (recommended)
SQL Editor → paste `supabase/tests.sql` → **Run**. You should see a result grid
reading **ALL SQL TESTS PASSED**. It runs in a transaction that is rolled back, so
nothing is changed. If it prints `FAIL: …`, fix that before going further.

### 8. Try it locally
```bash
npm run serve        # opens http://localhost:5173
```
Sign in as `T001` / `T001` and roll. Then sign in as `Coderscrew` / your admin
password and look at the dashboard. Localhost is only on your computer; it is **not**
a public website.

Optional full backend check (signs in as real teams, rolls concurrently, tests
permissions, then clears everything):
```bash
npm run verify -- --allow-clear
```
See the note about rate limits at the top of `scripts/verify-backend.mjs`.

### 9. Put it on GitHub and deploy
1. Create a **new GitHub repository** (public or private; Pages on private repos needs a paid plan).
2. In the project folder:
   ```bash
   git init
   git add .
   git status                     # confirm .env is NOT listed
   git commit -m "Coders Club PS Selector"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
3. GitHub repo → **Settings → Pages → Source: GitHub Actions**.
4. The **Actions** tab shows "Deploy to GitHub Pages" running. When it's green, your
   link is `https://<you>.github.io/<repo>/`.

Any static host works too (Netlify, Cloudflare Pages, Vercel): publish the `public`
folder, no build command.

### 10. Test the live site from a phone on mobile data
Turn Wi-Fi off, open the link, sign in as a team, roll, close the tab, reopen: the
same result must show. Then log in as admin and confirm the numbers moved.
**Clear all assignments** afterwards (admin → Teams → Clear All Assignments).

### 11. Share the link
Give all 46 leaders the one URL plus their own ID and password.

---

## Before the real hackathon

- [ ] **Change the admin password** (`ADMIN_PASSWORD` in `.env`, then `npm run set-admin-password`).
- [ ] Decide on team passwords. The starting password equals the team ID (T001 → `T001`), which is
      easy to guess. Options: tell leaders to keep it private, or reset a team with
      `node --env-file=.env scripts/provision-users.mjs --reset-team T017` (set `TEAM_NEW_PASSWORD`
      in `.env` first, otherwise it resets to the team ID).
- [ ] Raise the Auth sign-in rate limit (step 3).
- [ ] Confirm *Allow new users to sign up* is **off**.
- [ ] Run `supabase/tests.sql` and `npm run verify -- --allow-clear`.
- [ ] Make sure **Clear All Assignments** has been run so nothing is left over from testing.
- [ ] Check the service_role key is in no file under `public/` and `.env` is not on GitHub.
- [ ] Supabase's free tier pauses projects after about a week of inactivity. Open the dashboard
      the day before and make sure the project is running.

### Changing passwords
| Goal | Command |
|---|---|
| Set the admin password | edit `ADMIN_PASSWORD` in `.env`, then `npm run set-admin-password` |
| Reset one team's password | `node --env-file=.env scripts/provision-users.mjs --reset-team T017` |

Neither command touches assignments.

---

## How allocation works

`roll_problem_statement()` (in `schema.sql`) runs as one database transaction:

1. Locks the six `problem_statements` rows in a fixed order, so every roll is processed one at a time.
2. If the team already has an active assignment, returns it. Nothing changes.
3. Otherwise picks **one random free slot** across all problem statements (a problem with more free
   slots is proportionally more likely, which keeps the final spread even) and saves it.
4. If no slots remain, returns `full` and saves nothing.

Back-stops that hold even if the function were bypassed: a unique partial index (one active assignment
per team) and a trigger that rejects an insert pushing a problem statement over its capacity.

Clearing an assignment sets `active = false`; the row stays as history.

## Security model

- **Roles live in the database** (`profiles.role`). `is_admin()` reads it from the verified login, never
  from anything the browser sends. Every admin function checks it again inside.
- **No browser writes.** Row Level Security is on for every table and there are no insert/update/delete
  policies. All changes go through `SECURITY DEFINER` functions with a fixed `search_path`.
- **A team can only read its own row** and its own active assignment. It cannot read other teams, the
  counts, the audit log, or call any admin function. Signed-out visitors can call nothing.
- **Hiding buttons is cosmetic.** If someone edits the page's JavaScript, the database still refuses.
- The **service_role key** is used only by local scripts and is git-ignored.
- **Login errors are generic** ("Incorrect username or password"). The browser also slows repeated
  failures, but that is a convenience; the real limit is Supabase's server-side Auth rate limit.
- Every admin reset is written to `audit_logs`.

**About the password prefix.** Supabase requires passwords of 6+ characters; `T001` has four. So the
site and the provisioning script both add a fixed prefix (`csps::`) before talking to Supabase. The prefix
is public and not a secret: it changes nothing about how guessable a password is, it only makes short
passwords possible. A weak password such as `T001` is weak either way. Plan for that (see the checklist).

---

## What has and hasn't been tested

**Run here, and passed:**
- `node --check` on every script (syntax).
- **82 browser checks** (headless Chromium, Playwright) of the full interface against an
  **in-memory mock of the Supabase calls** that follows the same function contract as `schema.sql`:
  login validation and generic errors, show/hide password, client-side lockout, connection-failure message,
  roll flow (button disabled, status text, result reveal, locked state), result equals the saved row,
  refresh and logout/login persistence, the dice landing on the correct face for all six results,
  "all full" message, admin stats/cards/progress bars, live search and both filters, empty state, single
  clear and clear-all dialogs (including type-to-confirm), all three CSV downloads (filenames, headers,
  UTF-8 BOM, 46 / unassigned-only / summary rows, no secrets), the activity log, tab keyboard navigation,
  reduced-motion behaviour, keyboard-only login, visible focus.
- **No page-level horizontal scroll** at 320, 375, 768, 1024 and 1440 px (login, student, admin).

**Written but NOT run, because no Supabase project or credentials were available:**
- `supabase/schema.sql` has not been executed on a real Postgres/Supabase. It may need a small fix on first
  run; if the SQL Editor reports an error, send it over.
- `supabase/tests.sql`, `scripts/provision-users.mjs`, `scripts/verify-backend.mjs`: syntax-checked only.
- Therefore these are **unverified against a real database**: concurrency under simultaneous requests,
  RLS behaviour, the capacity trigger, the admin permission checks, account creation, and the audit log.
  `tests.sql` and `verify-backend.mjs` exist to prove exactly those things. Run both (steps 7 and 8).
- Not tested: real phones (Android/iOS Safari), screen readers, the live deployment, the Google Fonts
  look (the sandbox had no internet, so a fallback font was used in screenshots).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "This site isn't connected to a database yet" | `public/config.js` still has the placeholder URL/key |
| "The database isn't set up correctly yet" | `schema.sql` wasn't run, or ran with errors |
| "Incorrect username or password" for a correct login | `provision` not run, or `EMAIL_DOMAIN` / `PASSWORD_PREFIX` differ between `.env` and `config.js` |
| "Too many requests" for several students | Auth rate limit (step 3) |
| `npm run provision` says tables not ready | run `schema.sql` first |
| Page works locally but not on GitHub Pages | check the Actions run is green and Pages source is "GitHub Actions" |
