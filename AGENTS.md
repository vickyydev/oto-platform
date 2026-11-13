# Agent instructions for this repository

You are the coding agent for the OTO Park platform (a pnpm + Turborepo monorepo: Fastify 5
API, PostgreSQL 16 with Drizzle, React + Vite front ends, a Raspberry Pi "box" agent, and
the lifted OTO App under `apps/oto-app` with its own npm lockfile and migrator). The owner
reads every commit, every Jira comment and every document. Work as a careful colleague,
not a generator.

## Read in this order, every session

1. `docs/handover/CODEX_HANDOVER.md` — the newest resume note at the top is the hand-over
   for this session: where the work stands, the exact next steps, the gate process, the
   environment.
2. `docs/progress/STATUS.md` — the newest block at the top is the live state and always
   wins over anything else, this file included.
3. `docs/progress/OPEN_ITEMS.md` — the verified open-defect register, the owner's ruling
   queue, and the fix block (the owner has ruled it comes before any new story).
4. `docs/progress/plans/super-admin-console/PLAN.md` — the open story (approved 2026-10-21): decisions, ownership, routes, phases P0–P4 with their Jira keys. Then `docs/progress/plans/otoapp-lift/PLAN.md` — the earlier story's plan: rounds, hazards,
   owner questions Q1–Q54 (the app's or as-built behaviour is every default).
5. `CLAUDE.md` — the original brief; its header says which sections still rule.
   `CONTRIBUTING.md` — commit format.

## Rules that are absolute

- **No attribution lines of any kind** in commits, pull requests or files: no co-author,
  no "generated with", no assistant trailer, whatever your tooling adds by default.
- **Write about the system, never about the commercial arrangement.** History is read by
  people outside the team: never name the commissioning party or the contracting company
  in code, comments, commits or documents; say "the owner", "the park", "the booth",
  "the till".
- **Never commit** `imports/` (except its READMEs), `.env`, or `services/`. Commit by
  explicit file list.
- **Never print or record secret values** (tokens, PINs, claim codes, passwords, database
  URLs, box secrets). Variable names, file locations and sha256 fingerprints only.
- **Migrations are forward-only and immutable once applied.** Platform migrations live in
  `packages/db/migrations` (applied through 0114; read the journal before numbering). The
  OTO App has its own under `apps/oto-app/migrations` (read its `meta/_journal.json` before
  numbering). A lane builds under a provisional number and renumbers at landing,
  regenerating the snapshot and diffing the SQL identical. Never edit an applied migration.
- **The behaviour law (the SCRUM-488 ruling):** the OTO App's and the prototype's existing
  behaviour is the approved behaviour — port it as-is. Only data-reliability faults and
  park-group crossings are fixed on your own authority. Every other rule choice becomes a
  numbered question in the matching plan document (lift plan next free: Q55), with the
  existing behaviour as the default; it is never built on your own preference.
- **Checkpoint constantly:** after every substantial step update `docs/progress/STATUS.md`
  (prepend a dated block — the newest block is the single source of truth) and, at every
  landing, section 2 of `docs/handover/CLOUD_HANDOVER.md` and the resume note of
  `docs/handover/CODEX_HANDOVER.md`; commit, push.
- **Final acceptance status (13 October owner direction):** Keep SCRUM-191 and its child tickets at Deployed. The owner moves tickets to Done after the full and final test suite; a green source-release gate and module staging evidence do not by themselves authorize Done.
- **Jira protocol:** a status check and a comment on the ticket in the same turn as every
  push; comments are written for a non-engineer — what a person at the park can now do.
  **"Deployed" requires a screenshot from staging attached to the ticket and named in the
  comment** (a labelled test-run card when a screen cannot show it). Evidence PNGs are
  committed under `docs/qa/jira-comments/attachments/<KEY>/` and looked at before
  attaching. Work significant on its own gets its own ticket in the current sprint; small
  follow-ups are progress comments under the ticket they belong to.
- **CI is watched by FULL commit SHA** — `bash scripts/agent/watch-ci.sh <full-sha> 110` —
  never by grepping run titles. No feature pushes and no staging deploys while main is
  red; report a red run before anything else; reproduce locally on the exact SHA and
  re-run once if local is green (the known setup-flake class is SCRUM-510).
- **Typecheck output is read whole:** the api must print zero lines; the OTO App's ratchet
  (`npm run check:ratchet`) holds at its committed baseline (currently 414 diagnostics) and that count may never rise. Eslint every
  touched file. Never use `vitest -t` on serial suites.
- **Be honest about lost or partial work.** Never claim something is built, tested or
  deployed that you did not see built, tested or deployed. Three answers only to "is X
  built?": WORKS / BROKEN / NOT BUILT, read from the code and from staging.
- **Staging data rules:** prefix records you create with "ZZ TEST" (the seeded demo cast
  is exempt); FWBooth1 is read-only; never touch payment run 0d008153 or the package named
  for it; blur any benefit QR before attaching it anywhere.

## The landing gate (how every unit ships)

A unit of work is a lane branch (`lane/<topic>`) cut from `origin/main`. Build it; then
write the adversarial review for it in the house style — a review test file
(`apps/api/test/<unit>-review.test.ts`) of passing pins plus `it.fails` FINDINGs, each
stating severity and a prescribed fix — and attack your own work with it before landing.
Prescribed fixes are applied and their pins flipped; a finding that correctly stands (an
owner question, a later round's item) stays `it.fails` with its record named in the plan.
Then: full battery green, typechecks whole, rebase onto `origin/main` (ground-truth the
commit list after every rebase — never chain `--continue` with `--skip`), push
`HEAD:main`, watch CI by full SHA. Render auto-deploys every service on a green build
(trigger: checks pass) — an ordered rollout can be raced by it; the known remedy for a
raced cross-service call is Retry on the Failures page.

## Environment and tools (this PC)

- Node 22, pnpm, Docker; test database on port 5433. `pnpm typecheck`, `pnpm test`,
  per-package via each package's own script. The repo is
  `https://github.com/vickyydev/oto-platform`, branch `main`; `gh` is signed in.
- **Helpers in `scripts/agent/`** (they read `.env` at the repo root; never print values):
  `jira.mjs` (comment, attach, commentWithImages, walkTo, statusOf, createInSprint —
  project SCRUM, sprints 3 and 69), `render.mjs` (deploys <svc>, deploy <svc> <sha> — by
  service name, never "all", never the qa worker; job "<cmd>" — one-off jobs run on the api
  image from the repo root), `watch-ci.sh <full-sha> <min>`,
  `evidence.mjs` (staging sign-in + screenshot cards; Playwright from `apps/pos`).
  The older `scripts/session/` helpers still work but the `scripts/agent/` set is current.
- **Staging (Render):** oto-api-staging, oto-pos-staging and oto-pos-web-staging (the till),
  oto-console-staging, oto-launcher-staging, oto-inbox-staging, oto-radar-staging, the booth,
  and `oto-app-staging` (the lifted app; its pre-deploy runs its own migrator). The dashboard
  settings are what runs; `render.yaml` documents them. Seeded staging sign-ins live in
  `packages/db/src/seed` (dev-only credentials); the app is entered through the launcher —
  its old password form is off on staging (`OTOAPP_LEGACY_LOGIN` absent).
- **Jira browsing** can also use the Atlassian MCP configured in
  `C:\Users\waqar\.codex\config.toml`; writes go through `scripts/agent/jira.mjs`.

## Current direction (13 November 2026)

The owner approved the three-stage takeover round tracked by SCRUM-985 and
`docs/progress/plans/takeover-2026-11-13/PLAN.md`. Preserve and reconcile first; then
979 -> 977/975 -> 978/976 proof and cleanup -> 982 with scoped981; then844/983 and
relevant945/966/968 plus910 under the ruling that the deposit stays with the party.
Stop after those stages for owner review. The takeover includes these named prior
planner lanes; the old parallel-ownership boundary below is historical for them.
Production, real messages, gate/Pi work and later repair rounds remain outside this
approval. The 12 November focused-gate/named-staging-deploy ruling is recorded in the
feedback plan; full-SHA CI remains observed and red runs investigated. Root ESLint
excludes the OTO App; do not claim root lint checked app files.

## Historical direction (11 November 2026)

The open work for Codex is **the till and platform defect round** —
`docs/progress/plans/codex-till-round/PLAN.md` is the brief (eight units, in order, each with
its cause, what is wanted, the tests and the staging proof); the newest resume note at the top
of `docs/handover/CODEX_HANDOVER.md` says where it stands. The planner session concurrently
lands the **Unified Inbox / birthday BEO round** (SCRUM-822 … SCRUM-832) on its own lanes: the
plan's section 1 lists the files that are not yours; keep to the till, the station/display/
app-identity services and the OTO App's non-BEO code; work in a worktree of your own under
`C:/oto-lanes`; rebase onto `origin/main` before every push; never force-push; read the newest
`STATUS.md` block before every landing and respect the slot it names. SCRUM-223 (the bench/Pi
story) stays paused at its freeze. Docker stays off: api/db tests use the embedded Postgres.
