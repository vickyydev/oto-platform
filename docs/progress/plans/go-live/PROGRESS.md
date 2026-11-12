# Go-live of the HR app (the OTO App): progress

The first piece of going live: the HR app on our own platform, with the
launcher in front of it, on Render's own addresses until the domains are
switched. Brief: `docs/handover/GO_LIVE_MAIN_APP_PROMPT.md`. Counts, names of
settings and hashes only: never a value, a connection string or a person.

## Status

_Updated 12 November 2026, 15:25 Bangkok._

- **Production exists on Render** (project OTO Platform, environment
  production, Singapore, auto-deploy off on every service):
  - `oto-db-production` (`dpg-dbqmrnbbc2fs73ds1ec0-a`): Postgres 16, the same
    plan and disk as `oto-db-staging`, no outside access (one temporary entry
    for the restore laptop, removed when the load is done).
  - `oto-api-production` (`srv-dbqn4ubbc2fs73dsqg6g`),
    https://oto-api-production.onrender.com: live at `6944d5381`, the commit
    live on `oto-api-staging`. `/health` and `/ready` answer 200.
  - `oto-launcher-production` (`srv-dbqn52ifngtc7384cbk0`),
    https://oto-launcher-production.onrender.com: live at `d255250bf`, the
    commit live on `oto-launcher-staging`; `/api/*` is rewritten to the
    production api.
  - `oto-app-production` (`srv-dbqn50lbedkc73e5nmf0`),
    https://oto-app-production.onrender.com: building at `14a7bcdf1`, the
    commit live on `oto-app-staging`.
- **Settings** were copied from each staging twin key by key through the
  Render API and read back (59 on the api, 33 on the app, 2 on the launcher).
  What differs is listed under "Settings that differ from staging".
- **The dump** (`C:\oto-data\dumps\otoapp-prod-2026-11-12.sql`, taken 12
  November 13:32, sha256 `296e76dbde163866…`) is prepared: 184 tables, 65,433
  rows, structure equal to the committed baseline, no sequences; manifest
  `C:\oto-data\work\prepare-20261112T074220.json`.
- **Rehearsed locally** on a database built the production way (platform
  migrations and `platform:sync` on an empty database, the app's 48
  migrations, then the restore): 183 of 184 tables hold the dump's counts
  (`session` is cleared on purpose), the company and two parks made from the
  dump's own branch rows, both parks joined and Head Office the app's own, the
  real till catalogue loaded (152 products at Central Floresta, 149 at
  Robinson Chalong, 27 categories), the birthday seed's plan read, the staff
  accounts dry run read.
- **Not yet done on production**: the data load, the company and parks, the
  till catalogue and birthday packages, the staff logins, the launcher showing
  only the HR app, the sign-in proof.

## What the code required that the brief did not expect

1. **The api refuses to start in production without 2C2P merchant details.**
   None exist yet. Owner's decision, 12 November: a placeholder in the two
   merchant settings until the till goes live. The pretend gateway is off; no
   QR payment can be taken or faked.
2. **A database built from the dump has no company, no parks and no account.**
   The dump is the HR app's own database; the launcher's side came from the
   demo seed on staging, and `platform:sync` writes none of it. A one-off
   script, `packages/db/scripts/production-bootstrap.ts` (branch
   `lane/golive-2026-11-12`, not landed), makes the company, one park for each
   of the app's two trading branches from the app's own row (name, address,
   timezone) and one administrator. Without them the staff accounts script
   stops at "found 0 operators".
3. **Staging's administrator login uses the demo seed's published number and
   password.** It is not copied. Production's first administrator is made by
   the script above with a random password kept in a file on the laptop.
4. **The storage credentials cannot make a second bucket.** Production keeps
   its files in the same bucket under its own folder (the app's
   `STORAGE_ENV_PREFIX`; the api keys every object by company id, and
   production's differs from staging's). A separate bucket needs the owner in
   the storage console.

## Settings that differ from staging (names only)

`oto-api-production`:
`DATABASE_URL` (the production database); `DEPLOY_ENV`, `SEED_PROFILE`,
`OPS_TEST_CONTROLS` (production, no demo seed, no test controls);
`INBOX_SIMULATOR`, `PAYMENTS_SIMULATOR` (off); `PGW_PROVIDER`,
`PGW_MERCHANT_ID`, `PGW_SECRET_KEY` (the placeholder above); `PROCESS_ROLES`
(the virtual box role dropped: it stands in for a box staging has seeded and
production has not); `ALLOWED_ORIGINS`, `HANDOFF_APP_ORIGINS`,
`OTOAPP_DIRECTORY_URL` (the production launcher and HR app only). Not set:
`INBOX_SIMULATOR_SECRET`; `OTOAPP_JOBS_KEYS` (the app's night jobs are held
until the domain switch, the owner's decision); `OTOAPP_DIRECTORY_KEY` (the
till's and the inbox's calls into the app, neither live here);
`OTOAPP_PROVISION_KEYS` (set once the company exists).

`oto-app-production`:
`DATABASE_URL`; `DEPLOY_ENV`, `APP_ENV`; `STORAGE_ENV_PREFIX`;
`PLATFORM_API_URL`, `OTOAPP_PUBLIC_ORIGIN`, `LAUNCHER_URL`;
`QA_REPORTS_ENABLED` (off; the QA report worker is not deployed);
`VITE_HR_APP_URL` (added: unset, three admin pages link to the old Replit
address). Not set: `VITE_CONSOLE_URL` (no Console on production yet);
`OTOAPP_PROVISION_KEY` (set with the api's half).

`oto-launcher-production`: `VITE_OTO_APP_URL`. The other five tile addresses
are not set.

## Left to do, in order

1. `oto-app-production` live (its pre-deploy lays the app's 48 migrations).
2. Restore: `apply`, then `verify`, against `oto-db-production`.
3. The company, the parks and the first administrator; the branch
   reconciliation.
4. The provisioning key pair on the app and the api; redeploy both.
5. The real till catalogue (both parks) and the birthday packages, on top of
   the dump (the owner's instruction, 12 November).
6. The employee copy, then the staff accounts dry run, its exceptions to the
   owner, then apply.
7. The launcher shows only the HR app.
8. Proof on the Render address; remove the laptop from the allow list.
9. The domain switch: the owner's, when he has DNS access.

## Where things are

- Scratch scripts (this session's scratchpad, not in the repository):
  inventory, create-db, create-services, settings, routes, deploy, dbaccess,
  prodrun, job.
- Work files: `C:\oto-data\work` (manifests, the rehearsal's reports),
  `C:\oto-data\golive` (the administrator's password file).
- Worktrees: `C:/oto-lanes/golive-2026-11-12` (the script),
  `C:/oto-lanes/golive-docs-2026-11-12` (these documents).
