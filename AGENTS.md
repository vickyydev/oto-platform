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
4. `docs/progress/plans/otoapp-lift/PLAN.md` — the open story's plan: rounds, hazards,
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
  `packages/db/migrations` (applied through 0075; next free 0076). The OTO App has its own
  under `apps/oto-app/migrations` (applied through 0008 on staging; next free 0009).
  A lane builds under a provisional number and renumbers at landing, regenerating the
  snapshot and diffing the SQL identical. Never edit an applied migration.
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
- **Typecheck output is read whole:** the api must print zero lines; the OTO App inherits
  exactly 467 errors and that count may never rise (compared per file). Eslint every
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
  project SCRUM, sprint 3), `render.mjs` (status, deploy name|all <sha>, job "<cmd>" —
  one-off jobs run on the api image from the repo root), `watch-ci.sh <full-sha> <min>`,
  `evidence.mjs` (staging sign-in + screenshot cards; Playwright from `apps/pos`).
  The older `scripts/session/` helpers still work but the `scripts/agent/` set is current.
- **Staging (Render): six services** — api, pos, console, launcher, booth, and
  `oto-app-staging` (the lifted app; its pre-deploy runs its own migrator). The dashboard
  settings are what runs; `render.yaml` documents them. Seeded staging sign-ins live in
  `packages/db/src/seed` (dev-only credentials); the app is entered through the launcher —
  its old password form is off on staging (`OTOAPP_LEGACY_LOGIN` absent).
- **Jira browsing** can also use the Atlassian MCP configured in
  `C:\Users\waqar\.codex\config.toml`; writes go through `scripts/agent/jira.mjs`.

## Current direction (12 October 2026)

The open story is **S2-17b (SCRUM-191)** — the OTO App lifted whole. Rounds 1–6 are landed
and live on staging. The order of work is: round 7, round 8, then the fix block of
`docs/progress/OPEN_ITEMS.md` before any new story (the owner's standing ruling). The
newest resume note in `docs/handover/CODEX_HANDOVER.md` carries the exact next steps.
SCRUM-223 (the bench/Pi story) stays paused at its freeze — its brief is further down in
that same handover file; do not touch it unless the owner schedules bench time. Only one
agent session works this repository at a time.
