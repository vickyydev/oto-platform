# Prompt for a new session: put the HR app (the OTO App) live

Paste everything below the line into a fresh Claude Code session opened in this
repository. Written on 12 November 2026 by the planning session, which is busy
landing till and inbox lanes and must not be disturbed. Revised the same day
after the owner corrected the first version: this is the real go-live, not a
rehearsal, and it is meant to be simple.

---

You are the lead engineer for one job: put the park's HR app (the OTO App: HR,
timekeeping, scheduling, payroll, tasks, SOPs, events and BEO) live on our own
platform, as the first piece of going live. Be careful and exact, and do not
make it more complicated than the owner's plan below.

## The owner's plan, in his words (12 November 2026)

"We have tested the HR app in staging already and fixed the bugs. So now we are
planning to start going live and hr app is the first component of going live.
So we need the production environment APIs, db, app and launcher, later we
bring pos, inbox and radar and lucky wheel. For now, I need a live link for
prod of hr main app with live db which is basically same as latest live dump of
current app data. We dont need to freeze old app, we simply switch the domains
and connect the new deployed production app with the current domain and staff
will not know what happened. They will simply be redirected to launcher to sign
in and then taken to the new deployed app with pre existing db of current app
meaning they can all use their own staff logins same as before as we discussed
earlier for staging. The envs remain the same for prod but just with different
db and APIs."

Earlier the same day: "We need to be very careful with it. The live dump is in
the downloads folder. Deploy the app to live with render temp domain for now.
Later i will replace domains when i get dns access."

This is his go to create the production environment and load the dump. Do not
turn it into a questionnaire. Stop and ask only at the three points named under
"Where you stop".

## What to build

1. PRODUCTION ON RENDER, in the project "OTO Platform", environment
   "production" (it exists and is empty; ids in memory oto-render-staging):
   a Postgres database, the platform api, the launcher and the HR app. Same
   region (Singapore), same plans and the same settings as their staging twins
   (`oto-db-staging`, `oto-api-staging`, `oto-launcher-staging`,
   `oto-app-staging`), read from Render (staging is NOT driven by
   `render.yaml`; the dashboard and API settings are what runs). Add each new
   service to the production environment in the same step that creates it.
   Auto-deploy OFF on every production service: production deploys a named
   commit that is already live on staging.
2. SETTINGS: copy each staging service's settings to its production twin
   service-to-service through the Render API, one key at a time, without ever
   printing, logging or saving a value. Change only what must differ: the
   database connection, the addresses that name the api, the launcher and the
   app (use the Render addresses for now), the environment names that switch
   production behaviour on, a separate storage prefix or bucket if staging and
   production would otherwise share files, and everything that is demo or test
   only: no demo seed (reference data comes from `platform-sync`), every
   simulator off, the QA report worker not deployed. The api refuses to start
   in production with a simulator on: fix the setting, never the guard. List
   for the owner, by NAME only, every setting you changed and why.
3. THE DATA: the dump is `C:\Users\waqar\Downloads\public-oto-prod-12Nov.sql`
   (43 MB, 12 November 13:40). Copy it to
   `C:\oto-data\dumps\otoapp-prod-2026-11-12.sql` and load it with the tool
   proven on staging on 9 November (SCRUM-791): runbook
   `docs/progress/plans/data-restore/PLAN.md`, `tools/data/restore-otoapp.mjs`
   (prepare on the local scratch server first, then apply, then verify),
   `packages/db/scripts/otoapp-branch-reconcile.ts`. Memory: oto-data-restore.
   Verify by counts and hashes.
4. THE STAFF LOGINS, as on staging: `packages/db/scripts/otoapp-staff-accounts.ts`
   (dry run, read the exceptions, then apply). Everyone signs in on the
   launcher with their phone number and the app password they already have;
   the first sign-in keeps it. People who have left must not get access. Link
   the owner's own administrator account as the runbook describes.
5. THE LAUNCHER shows every user only the HR app for now. Confirm it on the
   live link with an ordinary staff account and an administrator.
6. PROVE IT on the Render address: sign in through the launcher, open the app,
   and check the main areas read the park's own data (counts, never names, in
   anything you write down). Then give the owner the live link and a short
   list of what you checked.

## Where you stop and ask the owner

1. Before anything that would send a message to a real staff member (a sign-in
   code by SMS, an email, a notification), and before switching on background
   jobs if any of them sends or changes something on first start against the
   loaded data. Say what would be sent and to how many people, and let him
   choose.
2. If the dump does not load cleanly, the structure differs from what our
   migrations expect, or the staff-accounts dry run shows people who cannot be
   given a login (no phone, a shared phone): report it with your fix, in plain
   words, and carry on with everything that does not depend on the answer.
3. The domain switch. He does it when he has DNS access. Have the steps ready
   (the custom domain on each production service, the addresses in the
   settings, what staff see). One real consequence to put to him then, once
   and briefly: whatever staff entered in the old app after the dump was taken
   (12 November 13:40) is not in the new one. If the switch is more than a day
   after the dump, offer to load a fresh dump just before it (about ten
   minutes with the same tool, after closing, no freeze). His call.

Things the restore does not carry and staging already lives with: stored files
(photos, documents, checklist and SOP media sit in a bucket, not in the dump)
and face templates. Find out how staging behaves for each today and make
production behave the same; mention it to the owner in one line each, do not
block on it.

## Another session is working in this repository right now

It lands lanes on `main` many times an hour and deploys the STAGING services.
- Do not deploy, restart or change any `*-staging` service or its settings;
  you only READ them.
- Do not touch any worktree under `C:/oto-lanes/` you did not create, any
  running workflow, or the session scratchpads.
- `git fetch` and rebase before every push; push docs only. If a code change
  is needed, build it in your own worktree
  (`git worktree add -b lane/golive-<date> C:/oto-lanes/golive-<date> origin/main`),
  test it and put the landing to the owner; never land code on your own.
- The memory note that going live is parked (3 November) no longer applies to
  the HR app. Memory: oto-main-app-golive.

## How you work

- Plain words to the owner; short; every ticket key with its title; say your
  reading of an instruction back to him when you act on it.
- Checkpoint as you go: `docs/progress/plans/go-live/PROGRESS.md` (a Status
  block a fresh session can resume from: what exists on Render by name, what
  is loaded, what is left) and a dated block at the top of
  `docs/progress/STATUS.md`. Commit and push docs after every substantial step
  (CONTRIBUTING.md; no attribution lines of any kind).
- Jira (`scripts/agent/jira.mjs`): record the work under SCRUM-110 (P7
  Cutover) and SCRUM-12 (migrate and reconcile data from the existing system);
  nothing moves to Done.
- Read first: memory index; `docs/progress/plans/data-restore/PLAN.md`;
  `docs/architecture/DEPLOYMENT_TOPOLOGY.md`; `docs/features/oto-app.md`;
  `render.yaml` as documentation only; `scripts/agent/render.mjs`.

## Rules that are absolute

- Never print, log, commit or post a secret, a setting's value, a connection
  string, or any person's name, phone, photo or record. Setting names, counts
  and hashes only. The dump and its work files stay in `C:\oto-data`, outside
  the repo and OneDrive.
- Never connect to, change or load the agency's live system. Work from the
  dump.
- On the production database, write only through the restore tools, the
  scripts named above and the services' own migrations. No hard deletes of
  business records.
- Gates and tests run unpiped or with pipefail; report failures as they are.
- If anything here disagrees with what you find in the code or on Render, the
  code and Render win: say so and adjust.
