# Current status — read this first when resuming

_Last updated: 2026-09-24, 06:29 (`main` at `5ed7c5b` plus this checkpoint; staging at `003dac7`)_

> **Resuming?** Read **`SESSION_HANDOVER.md`** first — its block "2026-09-24 —
> closing S2-09", then "State at the end of 2026-09-23". Together they carry the
> live commit on every service, what landed, what is
> in flight, every open defect with its key, and the recommended next order. The
> ticket-by-ticket detail for today is `TICKET_REGISTER_2026-09-23.md`. The
> precise sprint checkpoint is in `SPRINT_2_PROGRESS.md` (Status block first).
> The technical plan an agent follows is `../architecture/DEVELOPMENT_PLAN.md`;
> the tickets are in `SPRINT_2_PLAN.md`.

## Where we are

- **Sprint 1 is complete** and reviewed by the owner (tag `sprint-1`): accounts,
  scoped permissions, audit, idempotency, file storage, members, children, tier
  verification, catalogue, pricing, tax, public booking. Report:
  `SPRINT_1_REPORT.md`.
- **Sprint 2 is being built, and most of it is now live on staging.** The suite
  launcher, the Console, stations and boxes, the box agent's sync core and print
  pipeline, the Lucky Wheel booth, the sales ledger and the F&B/shop lanes, the
  member and booking work are all deployed. On 24 September at 06:29 **137 tickets read
  Deployed** (SCRUM-392, 204 and 202 joined that morning), 2 are In Progress
  (SCRUM-191, 206), none are in Testing and 62 are open (SCRUM-393 was raised
  on the 24th).
- **Money can now be taken.** SCRUM-206 (S2-10a, tenders) is the work of the day:
  six of its seven slices landed — the tender ledger (`3317360`), payment methods
  admin (`8ee9a5d`), the cash tender and part-paid sales (`a232059`+`b616191`),
  the card terminal adapters on the box (`51fd025`), the card tender in the cloud
  (`83ffc36`), the 2C2P QR tender with its signed webhook and gateway simulator
  (`24e608d`), and offline sales replay with the box's own drawer kick
  (`d435db4`). **Slice F — the POS payment stage — is not started**, and
  SCRUM-206 stays In Progress.
- **S2-09 (checkout and sales ledger) is closed — Deployed on the 24th at
  06:27.** S2-09b's two halves are on `main` (`f5e5572` — every screen reads
  members from the platform; `4cad79e` — a shop product carries its sizes, the
  shop screen asks for one, a box scan lands on the shop screen) and proven on
  staging. The one gap found there — a scan never reached the shop screen,
  because the POS site's `/api/*` rewrite holds the station channel's stream
  back — was **SCRUM-392 (High)**, fixed at `003dac7` (the screen polls when
  the stream cannot open) and proven on staging at 06:14; 392, 204 and 202 are
  Deployed.
- **The repository is the suite monorepo**: platform at the root, docs split by
  purpose, `imports/` as the local-only drop zone. Remote:
  `github.com/vickyydev/oto-platform` (private).
- **Everything the park runs has been read**: the three real apps
  (`../architecture/EXISTING_SYSTEMS.md`, `intake-2026-09-19/`), the OTO App
  production dump (structure only), the wheel specification, the previous
  developer's POS rules (`../briefs/POS_BACKEND_LOGIC.md`, reconciled in
  `../architecture/POS_RULES_RECONCILIATION.md`), the proposal document for the
  OTO App (`../briefs/AGENCY_PROPOSAL.md` — what that contract still owes), the
  park's hardware reference and the four gate documents
  (`../architecture/DEVICE_INVENTORY.md`), the Inbox prototype
  (`../features/inbox.md`).
- **The owner's direction of 2026-09-20** (`../briefs/OWNER_DIRECTION.md`) sets
  the sprint: one sprint, in priority order — (1) the POS complete with the Lucky
  Wheel booth, on simulators of the park's real devices and with real QR payments
  through the 2C2P sandbox; (2) the OTO App on the central database with one
  sign-on; (3) Radar live with a per-branch source preference; (4) the Unified
  Inbox data pillars and a styled shell.

## What is next

**The owner has said no new tickets are to be picked up; the next order is the
owner's to confirm.** The recommendation, with the reasoning in
`SESSION_HANDOVER.md`:

1. The D↔C2 seam and **SCRUM-391** — a `qr` tender never reaches the gateway —
   then drive D's QR path on staging end to end.
2. **SCRUM-388 (High)** — reserve in-flight tenders, before Slice F.
3. **SCRUM-382** — refuse a disabled or archived tender in the attempt service.
4. **Slice F** — the POS payment stage on all four tills — then SCRUM-206's
   end-to-end Deployed evidence.
5. The Console and box items (378, 381, 385, 386, 387, 389, 390), the promotion
   items (373, 374, 375, 368), the small light-theme and till items (370, 372,
   379, 380), then testing (369, 383).
6. The owner decisions listed below.

## The staging deployment

Render project **OTO Platform** in the Oto dev workspace, environment `staging`:
Postgres 16, and six services — `oto-api-staging`, `oto-pos-staging`,
`oto-console-staging`, `oto-launcher-staging`, `oto-booth-staging`,
`oto-app-staging`. All six auto-deploy on a push to `main`, but only once the
GitHub checks are green. Tonight the first five are live at **`d435db4`** (21:01) and
`oto-app-staging` at `16c621a`, which deploys only on its own files. The full account is
`DEPLOYMENT_STAGING.md`; the topology is `../architecture/DEPLOYMENT_TOPOLOGY.md`.

Two rules that cost time today, now recorded in memory `oto-render-staging`:
compare **every** service's live commit before calling a ticket Deployed (one
service's auto-deploy trigger had been off for three days), and anything a screen
cannot work without is converged by `platform-sync`, never left to the demo seed
(SCRUM-384 — staging's payment-method table was empty after a deploy and the till
could not take money).

## Blocked on the owner

1. **Which gateway portal the park holds** — a 2C2P sandbox merchant
   (developer.2c2p.com) or an SCB Developer Portal application — and its sandbox
   credentials into `.env` (`PGW_*`), never into the repository. This is decision
   **O-1**; it blocks only the real-QR half of SCRUM-206, since the gateway
   simulator carries the acceptance.
2. **O-2** — whether offline sales (Slice G, built inside SCRUM-206 today) stay in
   that ticket or become one of their own.
3. **O-6** — the vendor questions for GHL Thailand and Digio, including the TID
   and MID for the park's two PAX terminals, which are not on file.
4. **Policy and scope decisions** raised by today's work: 371 (does the sale
   survive the inactivity lock?), 345 (may a branch carry another branch's product
   or discount code?), 306, 327, 326, 357, 268, and 254's two open questions.
5. The deploy-bot's `render.yaml` entry, which creates a paid service on sync.
6. Later: real dumps of Radar's and the wheel's databases; Pisell/Papaya
   credentials from Replit Secrets (history export before any cancellation); S3
   contents; DNS for the `otoplay` domains; a Raspberry Pi 5 on the desk.

## Build order

S2-01 → S2-02 → S2-03 → S2-17a → **CP1** → S2-04…S2-07 → **CP2** →
S2-08…S2-11 → **CP3, POS play-test opens** → S2-12…S2-15 → **CP4** →
S2-17b/c → **CP5** → S2-18, S2-19 → **CP6** → S2-16 → **CP7**. (The full order
with every lettered part is at the end of `SPRINT_2_PLAN.md`.) The sprint is
inside S2-10 (payments) now, with S2-09b (SCRUM-204) still open beside it. Every
function is committed as it lands; the ticket log in `SPRINT_2_PROGRESS.md` is
updated in the same commit series.

## Known defects

The Sprint 1 list that S2-01 existed to fix is closed: the role-assignment
privilege hole, the lock model, the PII in logs, the proxy trust and the
Postgres-backed throttles all landed, and transactions and the atomic idempotency
claim followed in S2-01b.

The open list is now the one raised during Sprint 2 itself. Twenty-seven tickets
raised today are still open — the payments six (391, 388, 382, 390, 389, 387), the
Console and box four (378, 381, 385, 386), the promotions four (368, 373, 374,
375), the till and light-theme six (360, 371, 372, 370, 380, 379), and the rest
(369, 383, 339, 340, 345, 357, 326). Each is one line with its key in
`SESSION_HANDOVER.md`, and one row with its evidence in
`TICKET_REGISTER_2026-09-23.md`.

## Working rules that are easy to forget

- Nothing under `imports/` is committed except the READMEs. The exports contain
  real credentials and the dumps contain real staff and children's data: structure
  and counts only, never values, never uploaded anywhere.
- Never run `drizzle-kit push` or an imported app's reset scripts against a shared
  database.
- Commits follow `/CONTRIBUTING.md` (no attribution lines). **A commit's file list
  is never filtered by a word** — list every file the work touched, or CI finds
  the one you dropped.
- **A credential is searched for in every encoding**, not only the one it was
  typed in. The vendor void password turned up a seventh time hex-encoded inside a
  sample frame.
- **A reviewer never stashes a shared working tree.** Several slices are usually
  live in it at once.
- Checkpoint the progress file and commit after every substantial step; research
  agents run on Opus and save their output early.
- `services/deploy-bot/` and `render.yaml` belong to a separate session — do not
  touch either.
- To play with what is deployed: `docs/qa/SIMULATION_AND_TEST_CONTROLS.md`.
