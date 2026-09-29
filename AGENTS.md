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

## Two parallel lanes (30 September 2026, evening)

Two agent sessions work this repository at once, on disjoint areas:

- **Lane 1 (Claude session): SCRUM-208 (S2-11)** — owns `packages/db`,
  `packages/shared`, `apps/api`, `packages/box-agent`, `packages/print`,
  `apps/pos` while its story runs.
- **Lane 2 (Codex session): SCRUM-193 (S2-17b, the OTO App full lift)** — owns
  `apps/oto-app/**`; folds in SCRUM-261 and SCRUM-262 where the lift touches
  those paths, closing their tickets properly.

Rules while both run: **only lane 1 creates `packages/db/migrations`** — if the
lift needs a platform-side change (a central migration, an API route, a shared
package change), lane 2 records the need as a comment on its Jira ticket and a
"Needs from the platform lane" line in its STATUS stop block, and lane 1 builds
it; lane 2 works on a feature branch and lands to `main` in verified slices,
pulling latest `main` before every land; both lanes pull before landing and
never edit the other's area; `apps/launcher` changes only by a recorded
coordination note. Each lane updates its own Jira tickets and its own stop
block, never the other's.

## Current direction (30 September 2026, evening — the owner approved the next phase)

SCRUM-201 is closed. The main story now under way is **SCRUM-208 (S2-11): sale
printing and signed bands, the History tab with refunds, voids and reprints** —
the sprint plan's section S2-11 is the brief, and CP3 (the park's play-test)
follows it. After S2-11: the offline-selling cluster (SCRUM-269 with 270, 271,
295), which is also what lets SCRUM-206/205 close; then S2-12 → S2-15 per the
plan's order. Work SCRUM-208 under the one ticket with a progress comment per
part; its two deliberate scope notes are recorded on the ticket (bands are
minted on the platform at finalise for now, box-verifiable by format, and move
to the box with SCRUM-269; box-side offline minting is not this ticket).

Use existing affected tests, package typecheck and lint; follow the repo's
existing test patterns for new endpoints and services, no new frameworks.
Manual Render deployment is authorised while Actions cannot start because of
billing. Deploy the verified API before matching frontends; keep normal automatic
deployment settings. After migration 0033, never roll API back before 85d35e0.
Do not call CI green or deliver a release as CI-packed without actual CI evidence.
Every temporary Playwright configuration must use its own absolute output directory.
Keep unresolved simulated payment records identified in the QA notes untouched.
