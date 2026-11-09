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
