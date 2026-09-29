# Agent instructions for this repository

You are the coding agent for the OTO Park platform (a pnpm + Turborepo monorepo: Fastify 5
API, PostgreSQL 16 with Drizzle, React + Vite front ends, a Raspberry Pi "box" agent). The
owner reads every commit, every Jira comment and every document. Work as a careful
colleague, not a generator.

## Read in this order, every session

1. `docs/handover/CODEX_HANDOVER.md` — the hand-over written for this session: where the
   work stands, the exact next steps, the rules, the environment, how to test and deploy.
2. `docs/progress/STATUS.md` → `docs/progress/SESSION_HANDOVER.md` (its newest STOP POINT
   block) — the live state of the work; older blocks are historical.
3. `CLAUDE.md` — the original brief and the standing engineering standards (sections 3, 7
   and 8 stay in force; the rest is superseded by `docs/progress/SPRINT_2_PLAN.md` and
   `docs/architecture/DEVELOPMENT_PLAN.md`).
4. `CONTRIBUTING.md` — commit format.

## Rules that are absolute

- **No attribution lines of any kind** in commits, pull requests or files: no co-author, no
  "generated with", no assistant trailer, whatever your tooling adds by default.
- **Write about the system, never about the commercial arrangement.** History is read by
  people outside the team: never name the commissioning party or the contracting company
  in code, comments, commits or documents, and never call the park's people customers of
  ours; say "the owner", "the park", "the booth", "the till". (`CONTRIBUTING.md` has the
  same rule; the landing scripts grep for the usual phrasings and refuse the commit.)
- **Never commit** `imports/` (except its READMEs), `.env`, `render.yaml` (it carries
  another session's uncommitted block), `services/`, or
  `apps/pos/src/components/merch/MerchCustomerDisplay.tsx` while it shows as modified with
  no real change. Commit by explicit file list.
- **Never print or record secret values** (tokens, PINs, claim codes, passwords, database
  URLs, box secrets). Variable names and file locations only. `.env` stays ignored.
- **Migrations are forward-only**, numbered after the last one in `packages/db/migrations`;
  never edit an applied migration.
- **Checkpoint constantly:** after every substantial step update `docs/progress/STATUS.md`
  and the STOP POINT block of `docs/progress/SESSION_HANDOVER.md`, commit, push.
- **Jira protocol:** a status change and a comment on the ticket in the same turn as every
  push; **"Deployed" requires a screenshot from staging attached to the ticket and named
  in the comment** (a test-run card when a screen cannot show it); comments are written
  for a non-engineer. **Tickets:** a piece of work that is significant on its own — a
  feature, a story-sized or task-sized change, a defect that needs its own tracking —
  gets its own ticket, created in the current sprint. Small fixes, residual findings and
  follow-ups are handled under the bigger ticket they belong to, as progress comments
  that say what changed and where, so the ticket carries the tracking. Do not file every
  observation as a ticket; do not bury a real feature in a comment.
- **Be honest about lost or partial work.** Never claim something is built, tested or
  deployed that you did not see built, tested or deployed. Three answers only to "is X
  built?": WORKS / BROKEN / NOT BUILT, read from the code and from staging.

## Current direction (30 September 2026)

Complete the existing release checkpoint, then stop and await the next instruction.
Do not select another ticket or revive the historical bench branch. Bench round 1
and the physical Lucky Wheel demo are complete. Current checkpoint scope is
SCRUM-201, the already-started SCRUM-206 follow-ups, and SCRUM-285 verification.
Read STATUS and the newest STOP POINT for exact deployed versions and acceptance.
SCRUM-206 must remain open while separate To Do SCRUM-269 prevents offline trading;
do not start that dependency as part of the break checkpoint.

Use existing affected tests, package typecheck and lint; no new test suites.
Manual Render deployment is authorised while Actions cannot start because of
billing. Deploy the verified API before matching frontends; keep normal automatic
deployment settings. After migration 0033, never roll API back before 85d35e0.
Do not call CI green or deliver a release as CI-packed without actual CI evidence.
Every temporary Playwright configuration must use its own absolute output directory.
Keep unresolved simulated payment records identified in the QA notes untouched.
