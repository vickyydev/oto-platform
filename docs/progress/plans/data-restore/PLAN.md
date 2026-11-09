# The park's own data on staging: restoring the OTO App production database

_Written 2026-11-09. The first step of S2-22 (`docs/progress/SPRINT_2_PLAN.md`),
cut down to what is needed now: the OTO App's live rows into staging's
`otoapp` schema, so the HR app can be tested on real data and made ready for
production. The platform seeding, Radar history and member derivation that the
full ticket describes are not part of this step._

## What exists

- **The procedure** is the one `apps/oto-app/script/restore-rehearsal.mjs`
  proves in CI on sample rows, run on a real dump:
  `tools/data/restore-otoapp.mjs` (`prepare`, `apply`, `verify`) and
  `packages/db/scripts/otoapp-branch-reconcile.ts`.
- **The dry run** on the 19 September dump, 2026-11-09 against a local
  platform database at platform migration 105 and app migration 0035:
  prepare 1 min 25 s (the 33 MB Navicat file loads in 82 s), apply 12 s.
  184 tables, 46,767 rows; the structure equals the committed baseline
  (184 tables, 65 enums, no sequences); all 35 app migrations applied on the
  real rows; 183 of 184 tables keep the dump's counts (the 184th is `session`,
  cleared on purpose); the eight `otoapp_v` seam views come back; both parks
  joined by name, Head Office app-only; 69 employees, 72 users and 153 events
  visible through the views. A second apply on the same target gives the same
  result.

## The staging run, 2026-11-09

Done at 11:40-11:43 Bangkok on the owner's go, from the Navicat dump taken at
11:34 (Structure and Data of `public`; a first attempt was dropped by the
server mid-table, the second completed). prepare: 184 tables, 63,641 rows,
structure equal to the baseline, 107 s to load, 9.4 MB archive. apply against
`oto-db-staging`: backup 21 s, restore 89 s, 35 migrations, 40 sessions
cleared, 14 stale identities removed, both parks joined, Head Office app-only.
Verification: 182 of 184 counts equal; `session` cleared on purpose and
`branches` up by the one row the platform's reconciliation created for the
demo park "Demo Branch 2" (verify names both). `oto-app-staging` redeployed by
name on its current commit afterwards. The pre-restore backup stays in
`C:\oto-data\work\restore-20261109T043620\` until the owner says the restored
data stands.

Two scratch scripts drove it, both outside the repository: one adds or removes
this laptop's address on the database's allow list (read first, one entry,
removed when done); one reads the staging connection string from Render's
connection info and hands it to `restore-otoapp.mjs` in the environment, so
it is never typed or printed. When the restore is repeated at cutover the
same two steps apply; the Twilio and photo notes below still hold.

## How it works

1. **prepare** (local Docker Postgres, container `oto-restore-pg`, data folder
   `C:\oto-data` mounted at `/data`): copy the dump into the work folder; load
   it with `psql -v ON_ERROR_STOP=1` into a scratch database's `public`
   (the Navicat file hard-codes `"public".`); compare the table list with the
   app's baseline and stop on any difference; assert no sequences; rename
   `public` to `otoapp`; `pg_dump -Fc -n otoapp` into the work folder; write a
   manifest with counts and hashes; drop the scratch database.
2. **apply** (target = the platform database): refuse unless
   `RESTORE_CONFIRM` equals the target database name; refuse unless the
   target's app ledger holds every committed migration (the deployed code and
   the rows must agree); refuse if anything outside `otoapp` and `otoapp_v`
   depends on app tables; back up the current `otoapp` and `otoapp_v` with
   `pg_dump -Fc` into the work folder; `DROP SCHEMA otoapp CASCADE`;
   `pg_restore` the archive; record `0000_otoapp_baseline` as applied (the
   dump is the baseline shape); run `apps/oto-app/script/migrate.mjs` for
   0001 onwards; truncate `otoapp.session` (nobody's old session travels);
   delete `core.app_identity` rows for `oto_app` whose user no longer exists;
   join app branches to parks by folded name and run the platform's own
   reconciliation; verify.
3. **verify**: per-table counts against the manifest, the ledger against the
   journal (hash and timestamp of every file), the seam views present.

Reports (`prepare-*.json`, `apply-report.json`, tool output) hold counts,
hashes and statuses only, in `C:\oto-data\work`. Nothing under `C:\oto-data`
is in the repository or in OneDrive.

## Running it against staging

Needed from the owner: the fresh Navicat dump (Structure and Data) at a path
under `C:\oto-data\dumps`; this laptop's public address added to
`oto-db-staging`'s allow list for the duration; the yes to replace staging's
`otoapp`; the name of the owner's own user in the app; the decision on Twilio
during testing; the decision on files and photos.

```
# 1. prepare, on the local scratch server
RESTORE_DUMP_PATH=C:/oto-data/dumps/<file>.sql \
SCRATCH_DATABASE_URL=postgres://oto:oto@localhost:55432/postgres \
node tools/data/restore-otoapp.mjs prepare

# 2. apply, against staging (the URL is read from Render's connection info, never typed into a terminal)
TARGET_DATABASE_URL=<staging external url> RESTORE_CONFIRM=<staging database name> \
node tools/data/restore-otoapp.mjs apply
```

Then: redeploy `oto-app-staging` by name at its current commit so its pool
and caches start clean; in the Console, link the owner's platform account to
the owner's user in the app (`listUnlinkedOtoAppUsers` / `linkOtoAppUser`,
`apps/api/src/routes/app-identities.ts`); the owner gives the tester access
inside the app; remove the laptop's address from the allow list; keep the
`target-*-before.dump` backup until the owner says the restored data stands.

## Staff accounts

_SCRUM-795._ The restore brings the app's users (about 78: 55 staff, 16
managers, 6 admins, 1 advisor) without a platform account or an identity link,
so none of them can open the HR app from the launcher. A one-off script gives
each of them one, with no platform password: their first sign-in on the
launcher checks the app password they already have against the app's own hash
once, keeps an argon2 copy, and from then on the account is like any other.

- **The script**: `packages/db/scripts/otoapp-staff-accounts.ts`, logic in
  `packages/db/src/otoapp-staff-accounts.ts`. Dry run by default; `--apply`
  writes one transaction per person; a second run finds nothing to do.
- **The sign-in**: `signIn` in `apps/api/src/services/auth.ts`. A wrong
  password on a new account is refused and counted exactly as anywhere else;
  an account that already has a platform password never looks at the app's.
- **Each person gets**: an active account in the operator (their phone; no
  password yet; the forced password change the app still owes them, if it owes
  one; the phone counted as verified only where the app proves it — questions
  1 and 2 below), their employee record when the app links exactly one
  employee to them, the identity link and the stamp on their app user, the OTO
  App tile for the whole operator (as a Console link without a branch choice
  gives it), and a platform role where the table gives one (question 3):

  | App role | Platform role | Where |
  | --- | --- | --- |
  | staff, advisor | none: the OTO App tile alone | — |
  | manager | `branch_manager` | each park in their app branch access |
  | admin, operator_admin | `operator_admin` | the whole operator |
  | global_admin | none: skipped, listed by id | linked by hand in the Console |

- **The phone** comes from the app user (`phone_e164`, then `phone_number`),
  then from their employee record, normalised to `+66…`. Nobody is given a
  number another account already holds, or one two of them share.

### Questions for the owner

The script runs with the safer answer to each of these until the owner rules;
each is one place in `packages/db/src/otoapp-staff-accounts.ts` to change.

1. **A temporary app password.** The OTO App gives every new user, and every
   user an administrator resets, a temporary password the administrator sees,
   and asks for a change at the next sign-in. The first launcher sign-in keeps
   whatever app password the person has, so the script carries the app's
   "must change" onto the suite account: such a person signs in with the
   temporary password once and must choose a new one before anything else,
   the OTO App included. The dry run counts them ("forced password change
   carried"). The app's own "must change" is left on, because the app's own
   password is still the temporary one and the app's old sign-in form (kept
   for the cutover rehearsal) must not take it as permanent. Confirm both.
2. **Which phones count as verified.** A verified phone lets "Forgot password"
   send a reset code to that number, which opens the account without the app
   password, administrators' accounts included. The script counts a phone as
   verified only when it is the user's own `phone_e164` and the app itself
   marks it verified (the rule the app's own SMS sign-in and reset use);
   everybody else signs in with their app password and gets no SMS reset until
   their phone is verified (an administrator's temporary password from Login
   Users does it). The dry run counts verified and unverified. Confirm, or say
   which numbers the park stands behind.
3. **What each app role may do in the suite beyond the OTO App.** The table
   gives a platform role only where the OTO App needs one to keep the person's
   app role (where the app reads roles from the suite): none for staff and
   advisors, `branch_manager` for managers, `operator_admin` for admins.
   - Staff and advisors (about 56): the platform `staff` role would add the
     till, the booth, the counter's reads, staff benefits and the assistant.
     Give them that, or keep the tile alone?
   - Managers: `branch_manager` at their parks also carries the Login Users
     screen there (temporary passwords included, so the accounts at that park),
     role assignment, refund and cash approval and device pairing. A manager
     whose app branches join no park gets the tile alone, and the app would
     then read them as staff.
   - Admins: `operator_admin` is every permission across the whole operator,
     where an app admin's reach is one park group.
   - App `operator_admin`: the suite reads `operator_admin` back as the app's
     `admin`, so where the app takes roles from the suite, the next opening of
     the app rewrites them to `admin`, which loses the owner-only payroll lock.

### Running it on staging

1. Commit and push; deploy the api at that SHA:
   `node scripts/agent/render.mjs deploy oto-api-staging <sha>`, then
   `node scripts/agent/render.mjs deploys oto-api-staging` until it is live.
2. The employee copy must have run since the restore (every quarter-hour, or
   Console Health, "Copy the OTO App's staff now"): the employee record and the
   phone fallback come from it.
3. Dry run, which writes nothing:
   `node scripts/agent/render.mjs job "pnpm --filter @oto/db exec tsx scripts/otoapp-staff-accounts.ts"`
4. Apply, naming the administrator recorded as who made each link (the owner's
   own account, one of the ids the dry run lists last):
   `node scripts/agent/render.mjs job "pnpm --filter @oto/db exec tsx scripts/otoapp-staff-accounts.ts --apply --actor <account id>"`
5. The dry run again: `provision 0`, everybody provisioned now `already_linked`.

### What the dry run prints

Counts and ids only, never a name or a phone number: the operator; app users
read; one count per outcome (`provision`, `inactive`, `already_linked`,
`global_admin`, `unknown_role`, `other_park_group`, `no_phone`, `phone_taken`,
`phone_shared`, `employee_held`, and `failed` on apply); the outcomes per app
role; where the phones come from; how many phones count as verified and how
many do not; how many people carry a forced password change from the app; how
many employee records are linked; the role assignments per platform role; how
many people get the tile alone, by the table (staff, advisors) and because
their mapped role joins no park; the `global_admin` user ids; and the account
ids that may be named with `--actor`. Exit 1 when refused or a person failed.

Everybody counted under anything but `provision` is left as they were and is
done by hand in the Console (Login Users, Apps) once their data is right.

### For staff

> Sign in on the launcher with your phone number and your usual app password;
> the first sign-in keeps it for the suite. If you are still on a temporary
> password an administrator gave you, the launcher asks you to choose a new one
> first.

## What the restore does not do

- It does not touch the platform's own schemas. Parks, tills, boxes,
  accounts, tenders and settings stay. ZZ TEST sales and records are a
  separate clean-up, done when the real menus and prices are seeded.
- It does not carry files. Profile photos, documents and checklist media live
  in a storage bucket, not in the dump; links to them are broken on staging
  until the bucket is copied (the app's `import:core-uploads` script exists
  for part of that).
- It does not migrate face templates; they are not in the dump.
- It does not add the four composite keys and the `pl_facts` unique index the
  intake found missing in production (`SPRINT_2_PLAN.md`, S2-22 post-import):
  the committed baseline lacks them too, so staging already runs without them.
  Finance Sync's upserts are affected either way; a follow-up.
- Staff keep using the live app, so staging drifts from production from the
  moment the dump is taken. The same procedure runs again on a fresh dump at
  cutover; the timing above is what to expect.

## Known risks

- Outbound SMS. `oto-app-staging` has Twilio configured; it is used only for
  the phone code at sign-in and the camp family verification code. With real
  numbers restored, a tester pressing either sends a real message. Owner's
  choice: Twilio off on the staging app for the test period, or the tester
  told not to use those two features.
- The production structure may have moved since 19 September. `prepare` stops
  at the table comparison and writes the difference to the work folder; the
  answer is then a migration review, not a forced load.
- `DROP SCHEMA otoapp CASCADE` on staging makes the running app error for
  the ten seconds until the restore completes. Do it when nobody is testing.
