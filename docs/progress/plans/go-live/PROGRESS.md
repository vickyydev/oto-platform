# Go-live of the HR app (the OTO App): progress

The first piece of going live: the HR app on our own platform, with the
launcher in front of it, on Render's own addresses until the domains are
switched. Brief: `docs/handover/GO_LIVE_MAIN_APP_PROMPT.md`. Counts, names of
settings and hashes only: never a value, a connection string or a person.

## Status

_Updated 12 November 2026, 17:10 Bangkok._

**The live link: https://oto-launcher-production.onrender.com** (sign in
there; the HR app itself is https://oto-app-production.onrender.com).

- **Production is built and running** on Render (project OTO Platform,
  environment production, Singapore, auto-deploy off on every service; each
  service runs the commit its staging twin was live on):

  | Service | Id | Commit | Check |
  | --- | --- | --- | --- |
  | `oto-db-production` | `dpg-dbqmrnbbc2fs73ds1ec0-a` | Postgres 16, staging's plan and disk | allow list empty |
  | `oto-api-production` | `srv-dbqn4ubbc2fs73dsqg6g` | `6944d5381` | `/ready` 200 |
  | `oto-launcher-production` | `srv-dbqn52ifngtc7384cbk0` | `d255250bf` | page 200, `/api/*` to the production api |
  | `oto-app-production` | `srv-dbqn50lbedkc73e5nmf0` | `14a7bcdf1` | `/api/status` 200 |

- **The data is loaded.** The 12 November dump (taken 13:32, sha256
  `296e76dbde163866…`, 184 tables, 65,433 rows) was restored into
  `oto-db-production` with `tools/data/restore-otoapp.mjs` at 15:30 to 15:34:
  183 of 184 tables hold exactly the dump's counts; the one difference is
  `session` (42 rows cleared on purpose); the app's 48 migrations are on the
  real rows; 9 seam views. An independent `verify` afterwards agrees. The
  pre-restore backup of the (empty) schema is in
  `C:\oto-data\work\restore-20261112T074220\`.
- **The company and the parks** were made from the dump's own branch rows
  (`production-bootstrap.ts`): one operator, two parks (`hkt-central`,
  `robinson-chalong`) with the app's names, addresses and timezones; both app
  branches joined, Head Office stays the app's own, as on staging.
- **On top of the dump, as the owner asked on 12 November:** the real till
  catalogue (`real-catalog.ts`: 27 categories, 152 products at Central
  Floresta, 149 at Robinson Chalong, 301 in all) and the printed birthday
  catalogue (`seed-birthday-packages.mjs`: 3 set menus, 19 entertainment
  lines, 3 packages with 29 lines; a second run changes nothing).
- **Logins.** The administrator the owner asked for exists (platform and
  operator administrator; number and password are his, the phone is not
  counted as verified, so no SMS reset reaches it until it is). The staff
  accounts script was applied under that administrator: **52 people have
  their login** (6 admins, 12 managers, 33 staff, 1 advisor; 50 phones
  verified, 2 not; 1 carries a forced password change; 47 linked to their
  employee record), with no platform password, so the first launcher sign-in
  keeps the app password they have. 13 users are switched off in the app and
  get nothing. **14 active people (2 managers, 12 staff) have no phone number
  recorded and cannot sign in at the launcher yet**: their names are in
  `C:\oto-data\golive\staff-without-phone.csv`, on the owner's laptop only.
  A second dry run reads provision 0, already linked 52.
- **The launcher shows only the HR app.** The other five apps are `hidden` in
  the suite registry. Seen on the live page as the administrator: one tile,
  OTO App (pictures in `docs/qa/proof-2026-11-12/SCRUM-110/`). For a moment
  while the page loads, a manager or administrator sees the other tiles as
  "Coming soon" before they go; staff, who hold only the HR app, never do.
- **The app's night jobs are held** until the domain switch (the owner's
  decision): the app runs no timers (`OTOAPP_JOBS` as on staging) and the api
  holds no jobs key, so nothing changes the loaded data. The platform's own
  jobs run; the staff copy has run (63 employee records).
- **Temporary access is closed.** The laptop's two outside addresses were on
  the database's allow list from 15:17 to 16:50 and are removed; the allow
  list is empty.

## Proved on the live addresses

1. Launcher page loads; the api answers through the launcher's own `/api`.
2. A wrong password is refused (`INVALID_CREDENTIALS`); the administrator's
   right one signs in; the cookie is httpOnly, secure and same-site.
3. The administrator is a platform administrator and holds the HR app tile.
4. The tile list the api gives the launcher: OTO App open, the other five
   hidden; the live page draws one tile.
5. The hand-off into the HR app is minted for the production HR app and the
   app exchanges it with the production api server to server.
6. Sign-out ends the session; the old cookie is refused afterwards.
7. The main areas hold the dump's counts on production: employees 77, users
   79, time events 11,550, schedule assignments 2,392, time off 4,077,
   checklist runs 2,545, tasks 515, service check-ins 2,694, drop-off
   check-ins 1,801, notifications 942.

**Not proved yet, and why:**

- **Inside the HR app as the administrator.** The app answers the
  administrator's hand-off with `not_provisioned`: the new administrator has
  no profile inside the HR app. It needs a name and an email from the owner
  (one call, `POST /admin/apps/oto_app/users`, as on staging on 9 November).
- **A real staff sign-in.** Nobody's password is known here. The first
  sign-in with an app password was proved on staging (SCRUM-795); on
  production it waits for one real person to try.

## What the code required that the brief did not expect

1. **The api refuses to start in production without 2C2P merchant details.**
   None exist yet. Owner's decision, 12 November: a placeholder in the two
   merchant settings until the till goes live. The pretend gateway is off; no
   QR payment can be taken or faked.
2. **A database built from the dump has no company, no parks and no account.**
   The dump is the HR app's own database; staging got the launcher's side from
   the demo seed, and `platform:sync` writes none of it.
   `packages/db/scripts/production-bootstrap.ts` makes them from the dump's
   own branch rows. It also hides the tiles of apps that are not live
   (`--show-only oto_app`; `--show-also <app>` opens one again), because the
   suite registry has no screen or route that hides a tile. **The script is
   on branch `lane/golive-2026-11-12` in the worktree
   `C:/oto-lanes/golive-2026-11-12` (three local commits, not pushed, not
   landed): landing it is the owner's call.** It was rehearsed on a local
   database built the production way before it ran on production.
3. **Staging's administrator login is the demo seed's published number and
   password.** It was not copied.
4. **The storage credentials cannot make a second bucket.** Production keeps
   its files in the same bucket under its own folder (the app's
   `STORAGE_ENV_PREFIX`; the api keys every object by company id, and
   production's differs from staging's). A separate bucket needs the owner in
   the storage console.
5. **This laptop's connection leaves through two outside addresses**, turn
   about. One allow-list entry let half the connections in; the restore's
   first try stopped at its backup step with nothing changed. Both addresses
   were allowed for the load (`dbaccess.mjs` samples with fresh connections),
   and the Postgres client tools ran in a container of the session's own that
   reaches the database through a forwarder on the laptop's loopback.

## Settings that differ from staging (names only)

`oto-api-production`:
`DATABASE_URL` (the production database); `DEPLOY_ENV`, `SEED_PROFILE`,
`OPS_TEST_CONTROLS` (production, no demo seed, no test controls);
`INBOX_SIMULATOR`, `PAYMENTS_SIMULATOR` (off); `PGW_PROVIDER`,
`PGW_MERCHANT_ID`, `PGW_SECRET_KEY` (the placeholder above); `PROCESS_ROLES`
(the virtual box role dropped: it stands in for a box staging has seeded and
production has not); `ALLOWED_ORIGINS`, `HANDOFF_APP_ORIGINS`,
`OTOAPP_DIRECTORY_URL` (the production launcher and HR app only);
`OTOAPP_PROVISION_KEYS` (a new pair with the app, bound to the production
company). Not set: `INBOX_SIMULATOR_SECRET`; `OTOAPP_JOBS_KEYS` (night jobs
held); `OTOAPP_DIRECTORY_KEY` (the till's and the inbox's calls into the app,
neither live here).

`oto-app-production`:
`DATABASE_URL`; `DEPLOY_ENV`, `APP_ENV`; `STORAGE_ENV_PREFIX`;
`PLATFORM_API_URL`, `OTOAPP_PUBLIC_ORIGIN`, `LAUNCHER_URL`;
`QA_REPORTS_ENABLED` (off; the QA report worker is not deployed);
`VITE_HR_APP_URL` (added: unset, three admin pages link to the old Replit
address); `OTOAPP_PROVISION_KEY` (the new pair). Not set: `VITE_CONSOLE_URL`
(no Console on production yet).

`oto-launcher-production`: `VITE_OTO_APP_URL`. The other five tile addresses
are not set.

Everything else was copied from the staging twin key by key through the
Render API and read back: 46 on the api, 24 on the app, 1 on the launcher.

## As on staging, not carried by the restore

- **Stored files.** Photos, documents, signed PDFs and checklist media sit in
  the old system's bucket, not in the dump: their links are broken, as on
  staging, until the bucket is copied. New uploads work.
- **Face clock-in.** Off, as on staging; the face templates are not in the
  dump. PIN and phone clock-in remain.
- **Kiosks, check-in QR posters and advisor PINs** depend on secrets the old
  system holds: at the switch each kiosk is activated again, the posters are
  reprinted and advisor PINs reset, as planned for staging.

## The domain switch (the owner's, when he has DNS access)

1. If the switch is more than a day after 12 November 13:32, load a fresh
   dump just before it, after closing: about ten minutes with the same tool
   (`prepare`, allow the laptop, `apply`, `production-bootstrap.ts` writes
   nothing new, `otoapp-staff-accounts.ts` picks up new people, remove the
   laptop). Whatever staff entered in the old app after the dump is otherwise
   not in the new one.
2. On Render, add the custom domain to `oto-launcher-production` (the
   address staff type today) and one to `oto-app-production`; add the DNS
   records Render shows; wait for the certificates.
3. Settings to change, then redeploy the same commits:
   `oto-api-production`: `ALLOWED_ORIGINS`, `HANDOFF_APP_ORIGINS`,
   `OTOAPP_DIRECTORY_URL`. `oto-app-production`: `OTOAPP_PUBLIC_ORIGIN`,
   `LAUNCHER_URL`, `VITE_HR_APP_URL` (a rebuild). `oto-launcher-production`:
   `VITE_OTO_APP_URL` (a rebuild). The launcher's `/api/*` rewrite keeps
   pointing at the api's Render address.
4. Switch the night jobs on: issue a `jobs:run` key in the production app for
   its one park group, set `OTOAPP_JOBS_KEYS` on the api, redeploy the api.
5. What staff see: the old address opens the launcher's sign-in; they type
   their phone number and their usual app password; the first sign-in keeps
   it; they land on one tile, OTO App.

## Left to do

1. The owner: a name and an email for the administrator's HR app profile;
   then the in-app proof.
2. The owner: phone numbers for the 14 people without one (or they are added
   in the old app before the final dump).
3. One real staff sign-in on the live link.
4. The owner's call on landing `production-bootstrap.ts`.
5. Before the till goes live on production: the real 2C2P merchant details,
   the virtual box role, `OTOAPP_DIRECTORY_KEY`, and the till's own
   configuration (packages, prices, tax), none of which is in the dump.
6. The domain switch above.

## Where things are

- Scratch scripts (this session's scratchpad, not in the repository):
  inventory, create-db, create-services, settings, routes, deploy, dbaccess,
  prodrun, job, provision-key, proof-admin, shots.
- Work files: `C:\oto-data\work` (manifests, reports, logs),
  `C:\oto-data\golive` (the administrator's number and password, the list of
  people without a phone).
- Worktrees: `C:/oto-lanes/golive-2026-11-12` (the script, branch
  `lane/golive-2026-11-12`), `C:/oto-lanes/golive-docs-2026-11-12` (these
  documents).
- Jira: SCRUM-110 (P7 Cutover) and SCRUM-12 (migrate and reconcile data from
  the existing system), both In Progress, and the follow-ups under SCRUM-110.
