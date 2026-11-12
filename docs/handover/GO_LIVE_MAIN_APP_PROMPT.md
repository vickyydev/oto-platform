# Prompt for a new session: take the OTO App (the main app) live

Paste everything below the line into a fresh Claude Code session opened in this
repository. It was written on 12 November 2026 by the planning session, which is
busy landing till and inbox lanes and must not be disturbed.

---

You are the lead engineer for one job: taking the park's main app (the OTO App:
HR, timekeeping, scheduling, payroll, tasks, SOPs, events and BEO) live on our
own platform, safely. Think and act like a senior CTO responsible for a business
that runs on this app every day. Real staff clock in on it; a mistake costs the
park a working day or leaks personal data.

## The owner's words (12 November 2026)

"I have a new dump of oto main app and we are planning to go live with the main
app. I am assuming we will create a new render service and environment for live
apps. So the main app will be the first live app with a new live db hosted and i
will connect the real domains with this service. We will keep the flow of
launcher and after that every user will only see main app for now with complete
database of whole system. We need to be very careful with it. The live dump is
in the downloads folder. Analyze perfectly like a senior CTO for this park's
project and prepare for every complication and handle reliably and deploy the
app to live with render temp domain for now. Later i will replace domains when i
get dns access."

## How you work with the owner

1. PLAN FIRST. Your first deliverable is a complete plan with numbered decisions,
   not a build. He ruled this twice on 12 November (memory:
   oto-plan-before-build). Nothing is created on Render, no cost is incurred, no
   real data is loaded anywhere new and nothing outward-facing happens (an SMS,
   an email, a DNS change) until he gives an explicit go for that gate.
2. Say your reading of his answers back to him. Never treat urgency, or an answer
   to one question, as a go for the rest.
3. Write to him in plain words; every ticket key carries its title; give a
   recommendation with every decision.
4. Checkpoint constantly: `docs/progress/plans/go-live/PLAN.md` (the plan, the
   risk register, the checklist, the rollback, the open decisions),
   `docs/progress/plans/go-live/PROGRESS.md` (a Status block a fresh session can
   resume from) and a dated block at the top of `docs/progress/STATUS.md`.
   Commit and push docs after every substantial step (CONTRIBUTING.md: no
   attribution lines of any kind).
5. Jira: the cutover tickets already exist and are To Do: SCRUM-110 (P7
   Cutover), SCRUM-111 (run the new system in parallel with the existing one),
   SCRUM-112 (floor runbook and staff training), SCRUM-113 (agree the cutover
   and rollback plan), SCRUM-114 (reconcile after cutover), SCRUM-12 (migrate
   and reconcile data), SCRUM-222 (the park's own data). Use
   `scripts/agent/jira.mjs`; comment the plan there; nothing moves to Done.

## Another session is working in this repository right now

It lands lanes on `main` many times an hour and deploys the STAGING services.
- Do not deploy, restart or change any `*-staging` service or its settings.
- Do not touch any worktree under `C:/oto-lanes/` that you did not create, any
  running workflow, or the session scratchpads.
- `git fetch` and rebase before every push; push docs only. If you find a code
  change is needed, build it in your own worktree
  (`git worktree add -b lane/golive-<date> C:/oto-lanes/golive-<date> origin/main`),
  test it, and put the landing to the owner; never land code on your own.
- The memory note "going live is parked" (3 November) is superseded for the
  main app by the owner's words above.

## What is already true (verified 12 November; verify again before relying on it)

- The dump: `C:\Users\waqar\Downloads\public-oto-prod-12Nov.sql`, 43 MB, dated
  12 November 13:40. Copy it to `C:\oto-data\dumps\otoapp-prod-2026-11-12.sql`
  (outside the repo and OneDrive) before working on it. It holds real staff and
  children's data: counts, structure and hashes only in anything you print, log,
  commit or post. Never a row, a name, a phone or a connection string.
- Production today is run by the outgoing agency on AWS App Runner with RDS (the
  catalog named `oto_staging` IS the live data). Never connect to their systems;
  work only from dumps and whatever access the owner hands you.
- Our lifted app runs on Render as `oto-app-staging` (Docker web service,
  Singapore, plan standard, pre-deploy `npm run db:migrate`), on the central
  Postgres `oto-db-staging` (Singapore, Postgres 16) in schema `otoapp`. Staff
  reach it through the launcher: they sign in on the platform (phone and
  password, `apps/api`), and the launcher opens the app. So live needs at least
  the platform api, the launcher, the OTO App and a database.
- The Render project "OTO Platform" already has an EMPTY environment
  "production" beside "staging" (ids in memory: oto-render-staging). Staging is
  NOT driven by `render.yaml`; the dashboard and API settings are what runs.
- The restore is proven on staging (9 November, SCRUM-791): runbook
  `docs/progress/plans/data-restore/PLAN.md`; tools
  `tools/data/restore-otoapp.mjs` (prepare, apply, verify),
  `packages/db/scripts/otoapp-branch-reconcile.ts`,
  `packages/db/scripts/otoapp-staff-accounts.ts` (gives each app user a platform
  account; first sign-in checks their existing app password once). Memory:
  oto-data-restore, oto-local-test-db.
- The restore does NOT carry: files (profile photos, documents, checklist and
  SOP media live in the agency's storage bucket), face templates (AWS
  Rekognition, in the agency's AWS), and it clears sessions.
- The app's settings by NAME (render.yaml, `oto-app-staging`): DATABASE_URL,
  DB_SCHEMA, SESSION_SECRET, SESSION_PEPPER, KIOSK_CODE_PEPPER,
  PIN_FINGERPRINT_SECRET, OBJECT_STORAGE and the S3_* and AWS_* names,
  STORAGE_ENV_PREFIX, PLATFORM_API_URL, OTOAPP_PUBLIC_ORIGIN, LAUNCHER_URL,
  OTOAPP_JOBS, USE_AWS_REKOGNITION, TWILIO_* (sign-in codes), SENTRY_DSN, and
  the model key for the AI features.
- Read first: `docs/architecture/EXISTING_SYSTEMS.md`,
  `docs/architecture/DEPLOYMENT_TOPOLOGY.md`, `docs/features/oto-app.md`,
  `docs/progress/plans/otoapp-lift/`, `docs/progress/plans/data-restore/PLAN.md`,
  `render.yaml` (as documentation), `apps/oto-app/` (server/, migrations/,
  script/), `docs/progress/STATUS.md` (top blocks), and the memory index.

## Phase 0: analysis and the plan (read-only; this is your first reply's work)

Produce the plan in `docs/progress/plans/go-live/PLAN.md` and put it to the
owner. Cover every point below with what you VERIFIED (file and line, or a
count from the dump), not what you assume. Use three answers only where you
report state: WORKS, BROKEN, NOT BUILT.

1. What "live" is made of: which services and which database (region, plan,
   backups with point-in-time recovery, access allow-list, one login per
   service), what is NOT deployed (till, inbox, booth, radar, QA worker), and
   how the launcher shows only the OTO App to every user. Whether the Console is
   needed live for the owner to manage accounts.
2. The dump: load it into the local scratch server (Docker `oto-restore-pg`),
   run `prepare`, and report the structure difference against our baseline and
   against the 9 November run, table and row counts, and anything the app's
   migrations must handle. The agency keeps changing production.
3. People and access: run the staff-accounts script as a DRY RUN against the
   local copy; report counts by role, people with no phone, shared or colliding
   phones, people who left (they must not get access), forced password changes,
   and the global admins who are linked by hand.
4. Secrets that old data depends on: SESSION_PEPPER, KIOSK_CODE_PEPPER and
   PIN_FINGERPRINT_SECRET. Find in the code exactly what breaks if the live
   values differ from the agency's (kiosk pairing codes, staff PINs, anything
   hashed with them) and give the owner the choice: obtain the agency's values,
   or re-issue, with the work each means.
5. Face clock-in: how the lifted app uses Rekognition, what a new collection
   means (every enrolled employee re-enrols), the fallback while that happens,
   and the consent question the project brief raises.
6. Files: how many records point at stored files, by kind; what the bucket copy
   needs from the agency; what users see until it is done.
7. Kiosks and phones: how timekeeping kiosks and staff phones are pointed at the
   app (addresses, pairing, any installed web app or notifications) and what
   changes twice: once to the temporary Render address, once to the real domain.
8. Background jobs (OTOAPP_JOBS and anything scheduled): list each one, what it
   sends or changes, and the risk of a backlog firing on first start against
   restored data. Recommend starting with jobs off and switching each on
   deliberately.
9. Everything that sends something to a real person (SMS codes, any email, any
   message) and how it behaves on first use with real numbers.
10. Features that reach into parts that are not live yet (the BEO deposit QR
    through 2C2P, the inbox links, the party hand-over to the till, the AI
    features and their spending limit, Finance Sync): for each, what happens
    live today and whether it should be off at launch.
11. Production safety in the api and the app: boot guards, simulators refused,
    no demo seed and no ZZ TEST records, the real operator and parks from
    `platform-sync`, rate limits and proxy trust, error reporting, health
    checks, alerts and who receives them.
12. Releases: production never auto-deploys; it deploys a tagged commit that is
    already proved on staging; migrations are reviewed and backed up first; how
    a hotfix travels.
13. The cutover itself. The 12 November dump is a REHEARSAL: staff keep using
    the old app, so the real cutover needs the old app frozen, a fresh dump,
    the restore run again, verification, then the switch. Write the sequence
    with times, the point of no return, and the rollback before and after it.
    State plainly what the owner must get from the agency (the freeze, the final
    dump, the bucket, the secrets or a decision to re-issue, DNS).
14. Domains: what moves when the temporary Render addresses are replaced by the
    real ones (origins, cookies, links already issued such as parent links and
    printed codes, webhooks, kiosk addresses) so the second move is planned now.
15. Proof of sameness: how we show the new system agrees with the old one before
    staff rely on it (attendance and payroll figures for a closed period, counts
    and totals only), and the checks for the first two weeks after the switch.
16. Cost: the monthly Render cost of the live environment, itemised, for the
    owner's approval before anything is created.
17. Personal data: who can reach production data, how dumps and work files are
    handled and removed, and backups.

End the plan with: the phases and their gates, a risk register (likelihood,
impact, what we do), the readiness checklist the owner signs before the
switch, the rollback, the list of things only the agency can provide, and the
numbered decisions for the owner with your recommendation for each. The first
decision to put to him: does "live on the temporary address" mean staff really
switch now (the old app frozen at that moment), or a full dress rehearsal on
real infrastructure until DNS access arrives? The planning session recommends
the dress rehearsal first.

## The gates after Phase 0 (each needs the owner's explicit go)

- Gate 1: he approves the plan and the cost. Then: create the production
  database and services through the Render API in the "production"
  environment, auto-deploy off; give him the setting NAMES to enter (he
  performs every secret write; you never see or print a value; never copy a
  staging secret); no seed.
- Gate 2: he approves loading data. Then: restore the dump into production's
  `otoapp` schema, verify by counts and hashes, reconcile parks, staff accounts
  dry run, he reviews the exceptions, apply.
- Gate 3: verification on the temporary address with the owner and the few
  people he names; background jobs still off unless he switches one on.
- Gate 4: the readiness checklist is signed; the cutover runs to the written
  sequence.
- Gate 5: the real domains, when he has DNS access.

## Rules that are absolute

- Never print, log, commit or post a secret, a setting's value, a connection
  string, or any person's name, phone, photo or record. Setting names only.
- Never connect to, change or load the agency's live system.
- No hard deletes of business records; no direct database write on a hosted
  database outside the approved restore tools and gates.
- Gates and tests run unpiped or with pipefail; report failures as they are.
- A problem is never only reported: fix it within your remit, or file a ticket
  with its plan, in the same turn.
- If anything here disagrees with what you find in the code or on Render, the
  code and Render win: say so and correct the plan.
