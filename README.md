# Scholarship Monitor — SAD Exam Section B

Browser-based MVP for the Scholarship Office: scholars submit semester grade summaries; staff verify evidence, evaluate compliance against persisted program policies, and record renewal decisions. Stack: HTML + CSS + JavaScript (no build step) with Supabase (PostgreSQL, Auth, row-level security). All data is synthetic.

## Folder layout

| Path | Contents |
|---|---|
| `supabase/schema.sql` | Tables, keys, row-level security, privileges, and all business-logic functions |
| `supabase/seed.sql` | Two programs and the six seeded test records B01–B06 |
| `web/` | `index.html`, `style.css`, `app.js`, `config.js` |
| `docs/Part_I_Analysis_Report.docx` | Part I: A1–A6, use case diagram, two detailed use cases, ERD, traceability |
| `tests/run-tests.mjs` | Automated database-level run of TC01–TC10 |
| `TEST_RESULTS.md` | Results table produced by that run |

## Environment variable names

The app is static, so the two values live in `web/config.js` instead of a `.env` file:

- `SUPABASE_URL` — project URL
- `SUPABASE_ANON_KEY` — the public **anon** key

Never put the `service_role` key or any password in the source code or screenshots.

## Setup

1. Create a Supabase project. In **Authentication → Providers → Email**, turn off "Confirm email" (so test accounts can sign in immediately).
2. In **SQL Editor**, run `supabase/schema.sql`, then `supabase/seed.sql`.
3. Put your project URL and anon key in `web/config.js`.
4. Create the two test accounts:
   - **Scholar test account:** open the app, choose *Create a scholar account*, and sign up.
   - **Staff test account:** sign up the same way, then in SQL Editor run
     `update public.profiles set role = 'staff' where email = 'YOUR-STAFF-TEST-EMAIL';`
     and sign in again. (Sign-up always creates a scholar; the role is never taken from the browser.)
5. Run locally (ES modules need http, not file://):
   ```
   cd web
   python3 -m http.server 8080      # or: npx serve .
   ```
   Open http://localhost:8080. For hosting, upload `web/` to any static host (GitHub Pages, Netlify, Supabase hosting).
6. As staff: **Scholars** tab → assign your scholar test account to a program. As that scholar: submit grades for a new semester.
7. Capture screenshots for the submission checklist: submission, verification, compliance, renewal, dashboard, and the scholar's **Access self-check** panel (role-access evidence).

Seeded scholars B01–B06 appear on the staff dashboard (AY 2026-2027, Semester 1) and cannot sign in. If inserting into `auth.users` is blocked in your project, create six users in the dashboard with the emails in `seed.sql` and re-run it.

## How the requirements are met

- **Role access is enforced in the database.** Row-level security limits reads; browser users have no INSERT/UPDATE/DELETE privilege on any table; every write is a `SECURITY DEFINER` function that checks the caller's role.
- **Policies are data.** `evaluate_submission()` reads thresholds and the deadline from the scholar's `programs` row. Changing a program row changes results (test EXTRA-2).
- **Three separate statuses:** verification (Pending/Verified/Returned), compliance (Not Evaluated/Compliant/With Deficiency), renewal (None/Approved/Held), plus `award_status` on the assignment. A deficiency never changes award status.
- **Deadline:** compared as `timestamptz` against `2026-11-06 17:00 +08`; exact deadline is on time, one minute later is late.
- **History:** every submit, resubmit, verification, evaluation, renewal decision and program assignment writes an `audit_log` row (actor, role, time, details) in the same transaction.

## Run the automated tests

```
cd tests
npm install
npm test
```

This runs the schema and seed in a local PostgreSQL engine (PGlite) with Supabase-style roles and writes `TEST_RESULTS.md`. It covers the database and security layer only; the browser UI must be checked by hand.

## Known defects and limitations

- Scholars self-register; staff "register" them by assigning a program (no service-role key is used in the browser).
- One deadline per program, not per semester.
- A resubmission keeps the original `submitted_at` for the deadline test and records `last_resubmitted_at` separately (documented design decision).
- A duplicate student ID at sign-up shows Supabase's generic "Database error saving new user".
- The UI was not exercised in a real browser against a hosted Supabase project in this build; run the setup steps and report any defect here.
- Test-account credentials are supplied privately to the instructor.
