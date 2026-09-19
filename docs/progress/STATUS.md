# Current status — read this first when resuming

_Last updated: 2026-09-20 (Sprint 2 plan v2 — the whole suite, in the owner's
priority order; awaiting approval)_

> **Resuming?** The precise checkpoint — what is done, what is pending in
> order, and what the owner still has to supply — is in
> `SPRINT_2_PROGRESS.md` (Status block first). The technical plan an agent
> follows is `../architecture/DEVELOPMENT_PLAN.md`; the tickets are in
> `SPRINT_2_PLAN.md`.

## Where we are

- **Sprint 1 is complete** and reviewed by the client (tag `sprint-1`):
  accounts, scoped permissions, audit, idempotency, file storage, members,
  children, tier verification, catalogue, pricing, tax, public booking.
  Report: `SPRINT_1_REPORT.md`.
- **The repository is the suite monorepo**: platform at the root, docs split
  by purpose, `imports/` as the local-only drop zone (five imports now: POS
  prototype, OTO App, Radar, wheel, the Inbox prototype). Remote:
  `github.com/vickyydev/oto-platform` (private), CI green.
- **Everything the client runs has been read**: the three real apps
  (`../architecture/EXISTING_SYSTEMS.md`, `intake-2026-09-19/`), the OTO App
  production dump (structure only), the wheel specification, the previous
  developer's POS rules (`../briefs/POS_BACKEND_LOGIC.md`, reconciled in
  `../architecture/POS_RULES_RECONCILIATION.md`), the agency's proposal site
  (`../briefs/AGENCY_PROPOSAL.md` — what the OTO App contract still owes),
  the park's hardware reference and the four gate documents
  (`../architecture/DEVICE_INVENTORY.md`), the Inbox prototype
  (`../features/inbox.md`).
- **The owner's direction of 2026-09-20** (`../briefs/OWNER_DIRECTION.md`)
  sets the sprint: one sprint, in priority order — (1) the POS complete with
  the Lucky Wheel booth, on simulators of the park's real devices and with
  real QR payments through the 2C2P sandbox; (2) the OTO App on the central
  database with one sign-on (its schema and sign-on before the first
  checkpoint, then the full lift, then the contract features); (3) Radar
  live with a per-branch source preference (seeded legacy vs real OTO POS
  analytics); (4) the Unified Inbox data pillars and a styled shell.
- **The plan is written**: `SPRINT_2_PLAN.md` — 19 tickets (S2-01…S2-19),
  milestones M0–M11, checkpoints CP1–CP7, a contract-coverage map of the
  proposal onto tickets, open decisions with defaults. Companion documents:
  `../architecture/DEVELOPMENT_PLAN.md` (how an agent builds it),
  `../architecture/PAYMENT_GATEWAY.md` (2C2P), `../architecture/DEVICE_INVENTORY.md`.

**Nothing of Sprint 2 is built.** The Jira board is loaded and waiting: sprint
"Sprint 2 - Complete build" (future state) holds the 24 stories under four
epics with their sub-tasks, and the 177 pre-existing issues were labelled, not
deleted (`SPRINT_2_JIRA_MAP.md`). Building starts at S2-01a / SCRUM-186 on the
owner's go-ahead.

## Waiting on the owner

1. **Approval of `SPRINT_2_PLAN.md`**, including the "Deferred — owner
   confirms" column of its contract-coverage table and Open decisions 29–32
   (OTO App face clock-in on staging; the contract list; the Inbox brief
   conflicts; gateway credentials).
2. **Which gateway portal the park holds** — a 2C2P sandbox merchant
   (developer.2c2p.com, the link the owner sent) or an SCB Developer Portal
   application — and its sandbox credentials into `.env` (`PGW_*`), never
   into the repository.
3. The four gate PDFs and the voucher sample image dropped into
   `imports/_vendor-docs/` (content already captured); a printed sale
   receipt when convenient.
4. Render account access — needed at S2-01c.
5. Later: real dumps of Radar's and the wheel's databases; Pisell/Papaya
   credentials from Replit Secrets (history export before any cancellation);
   S3 contents; DNS for the `otoplay` domains; a Raspberry Pi 5 on the desk.

## Next steps once approved, in order

1. Create the Sprint 2 Jira tickets from `SPRINT_2_PLAN.md` (one issue per
   ticket, lettered parts as sub-tasks; descriptions, acceptance criteria and
   QA steps copied; statuses never changed by us).
2. Build in the plan's order: S2-01 → S2-02 → S2-03 → S2-17a → **CP1** →
   S2-04…S2-07 → **CP2** → S2-08…S2-11 → **CP3, POS play-test opens** →
   S2-12…S2-15 → **CP4** → S2-17b/c → **CP5** → S2-18, S2-19 → **CP6** →
   S2-16 → **CP7**. Every function committed as it lands; the ticket log in
   `SPRINT_2_PROGRESS.md` updated in the same commit series.
3. Sprint 3: live messaging channels, events tab and kiosk surfaces, staff
   benefits checkout, migration rehearsals and cutover
   (`../architecture/PLATFORM_PLAN.md` §12).

## Known defects to fix first (S2-01a/b)

- `apps/api/src/routes/accounts.ts`: anyone holding `admin:role:assign` can
  grant any role at any scope; temp-password and phone-change routes have the
  same missing dominance check.
- No database transactions anywhere in `apps/api`; audit rows are not atomic
  with the change they describe.
- The POS inactivity lock signs the session out server-side, which prevents
  the offline unlock the target design requires.
- Phone numbers reach the logs (request URL, SMS adapter, pg error detail);
  the idempotency claim is not atomic; Fastify runs without `trustProxy`.

## Working rules that are easy to forget

- Nothing under `imports/` is committed except the READMEs. The exports
  contain real credentials and the dumps contain real staff and children's
  data: structure and counts only, never values, never uploaded anywhere.
- Never run `drizzle-kit push` or an imported app's reset scripts against a
  shared database.
- Commits follow `/CONTRIBUTING.md` (no attribution lines). Checkpoint the
  progress file and commit after every substantial step; research agents run
  on Opus and save their output early.
