# Sprint 2 progress

## Status

- Current checkpoint: **pre-build — Sprint 2 plan v2 in revision, awaiting
  owner approval.** Nothing of Sprint 2 is built.
- Last completed step: plan widened for the owner's 2026-09-20 direction
  (POS + booth first, then OTO App, Radar, Inbox; 2C2P sandbox for real QR;
  real device protocols); OTO App proposal captured; Inbox import reviewed;
  device and gate references filed (see "Done on 2026-09-20").
- Next step: finish the plan revision (list below), write
  `docs/architecture/DEVELOPMENT_PLAN.md` and
  `docs/architecture/PAYMENT_GATEWAY.md`, present the approval summary, then
  create the Jira tickets and start S2-01a.
- Resume instructions: read `docs/progress/STATUS.md`, then this file, then
  `docs/progress/SPRINT_2_PLAN.md` (the whole thing — it is the ticket
  source), `docs/briefs/OWNER_DIRECTION.md` (section 2026-09-20 wins),
  `docs/architecture/DEVICE_INVENTORY.md`, `docs/briefs/AGENCY_PROPOSAL.md`
  §6–§7, `docs/features/inbox.md`, and the two research notes in
  `docs/architecture/research/`. Work on `main` (docs only so far); commit per
  `CONTRIBUTING.md`, no attribution lines; never commit `imports/` beyond its
  READMEs.

## Done on 2026-09-20 (all committed)

- `docs/briefs/OWNER_DIRECTION.md`: new section "2026-09-20 — scope of Sprint
  2 widened; decisions changed" (order of work, launcher, payments = 2C2P
  sandbox for real QR with SCB as acquirer, devices from the real inventory,
  revenue/prices/receipts from the Replit code, agent process).
- `docs/progress/SPRINT_2_PLAN.md` revised: title/status/sources, sprint
  goal, milestones M0–M11, readiness rows for OTO App / Radar / Inbox /
  gateway, scope in/out, "Contract coverage" map (proposal §6 → tickets),
  design decisions (2C2P kept, foreign apps as own schemas, Radar contract,
  launcher design, adapters on real devices), S2-02 rewritten as the styled
  landing page, S2-10a/S2-12/S2-15a moved to the 2C2P sandbox and the real
  gate protocol, new tickets **S2-17 (OTO App a/b/c), S2-18 (Radar), S2-19
  (Inbox)**, execution order with S2-17a before CP1 and CP1–CP7, open
  decisions 10/15/16/22/23 resolved and 29–32 added, definition of done.
- `docs/architecture/DEVICE_INVENTORY.md` (new): LAN, the eleven devices with
  addresses/ids/roles, flows, the hardware note's open decisions D1–D6 and our
  resolutions, ECR facts, the full gate section (reader HTTP contract, HX-X1
  wiring/settings/faults, GE-X2 frames and passage feedback, simulator
  duties, unknowns), voucher/wristband/receipt design references. **Section 9
  (web research per device) is still "(pending)"** — the material is in
  `research/2026-09-20-device-research.md`.
- `docs/briefs/AGENCY_PROPOSAL.md` (new, 991 lines): the agency proposal site
  captured in full (24 features, 121 stories, 33 workflows, roadmap), each
  story assessed against the OTO App export, §6 "what remains", §7 questions.
- `docs/features/inbox.md` (new): the unified-inbox import reviewed (briefs,
  design language, what exists, proposed `inbox` schema, env names, open
  questions); `docs/features/README.md` row added.
- `imports/_vendor-docs/`: the park's hardware reference copied (local only);
  README lists the gate documents and the voucher sample as received in chat.
- `docs/architecture/research/`: two research notes preserved from the
  interrupted research pass — device models (4B-2082A = 4BARCODE, Zebra
  DS2278 + CR2278 cradle, Welltech G4 = rebadged Xprinter XP-C260, Xprinter
  XP-80 family, NEXGO/PAX physical ECR links, Pi vs mini PC) and the SCB
  Developer Portal direct API (kept as the alternative provider).

## Pending — in this order

_Checkpoint 2026-09-20 (second session): items 1, 2 and 4 are being written
by agents that save their files incrementally (`PAYMENT_GATEWAY.md`,
`DEVICE_INVENTORY.md` §2/§4/§9, `DEVELOPMENT_PLAN.md`); if a file exists in
DRAFT state, finish it from its own headings rather than restarting. S2-06
already carries the researched printer/scanner facts (commit 460779c)._

1. **Re-run the 2C2P research** (agent cut off by the session limit before
   writing): developer.2c2p.com — API 4.x Payment Token, Do Payment for
   PromptPay/Thai QR (channel codes, `type: "URL"` vs raw payload, expiry),
   Redirect API for the booking site, backend notification (JWT, fields,
   retries), Payment Inquiry codes, Payment Maintenance (refund/void, JWE/JWS
   keys), sandbox base URL and demo credentials, **how a QR payment is
   simulated in the sandbox**, invoiceNo/amount constraints, settlement
   reports; then write `docs/architecture/PAYMENT_GATEWAY.md` (2C2P primary,
   SCB direct as alternative from `research/2026-09-20-scb-direct-api-research.md`,
   `PGW_*` variable names, credential checklist, design implications).
2. Fold `research/2026-09-20-device-research.md` into
   `DEVICE_INVENTORY.md` §9 (adapter parameter blocks, simulator duties,
   unknowns) and correct §2 where the research changed a fact (Welltech G4 =
   XP-C260 family, DS2278 cradle, NEXGO dock is a router, PAX Ethernet only
   via the -BE/-BM base).
3. Update ticket bodies in `SPRINT_2_PLAN.md` with the researched values:
   S2-06 (printer/scanner adapters per device), S2-10a (2C2P sandbox flow
   and simulator), S2-12 (Redirect API details), S2-15a (2C2P settlement
   fixture).
4. Write `docs/architecture/DEVELOPMENT_PLAN.md` — the technical plan for
   agents: purpose and resume protocol; sources and precedence; target
   architecture at the end of the sprint (deployables, schemas
   `core/crm/pos/promo/booth/analytics/edge/otoapp/radar/inbox`, packages,
   box agent, adapters ↔ real devices, payments, analytics contract,
   observability, Render services, environment-variable registry by name);
   work order P1–P4 and ticket map; how each foreign app is lifted (OTO App
   lift-as-is with `search_path`, sign-on middleware, provisioning; Radar;
   Inbox); engineering conventions (withTx, audit, idempotency, logging
   contract, no PII, tests, migrations, flags); the commit-per-function and
   record-keeping protocol (this file's ticket log, ARCHITECTURE decisions
   log, Jira evidence, never changing Jira statuses); research index with
   one-paragraph conclusions per document; open-questions register pointer.
5. `docs/progress/STATUS.md` rewrite for the widened sprint; `docs/README.md`
   mention of `research/`; `docs/features/pos.md`, `oto-app.md`,
   `oto-radar.md` status lines pointing at S2-17/S2-18.
6. Commit per CONTRIBUTING.md and push; update the agent memory.
7. Present the approval summary to the owner (readiness answers, the ticket
   list with milestones, the contract-coverage map with the deferred items
   to confirm, open decisions 29–32, the inputs needed); on approval create
   the Jira tickets (descriptions, acceptance criteria, QA steps; never
   change statuses) and start S2-01a.

## Owner inputs needed (asked 2026-09-20)

- Which portal the park actually has: a **2C2P sandbox merchant**
  (developer.2c2p.com — the link the owner sent) or an **SCB Developer
  Portal application** (developer.scb). The plan assumes 2C2P; SCB direct is
  a second provider if it exists. Sandbox merchant id + secret into `.env`
  (`PGW_*`), never into the repo.
- Drop the four gate PDFs and the voucher sample image into
  `imports/_vendor-docs/` (their content is already captured).
- Confirm the "Deferred — owner confirms" column of the plan's "Contract
  coverage" table (catalog clone, wallet expiry/promo vouchers, gate stranded
  list, events/kiosk, predictive reorder, benefit profiles, live messaging).
- Open decisions 29 (OTO App face clock-in on staging), 30 (contract list),
  31 (Inbox brief conflicts), 32 (gateway credentials).
- A printed sale receipt (for the tax-invoice header) when convenient.

## Answers given to the owner on 2026-09-20 (for the record)

- **"How did the POS prototype work with no API?"** — It did not have one.
  `imports/oto-pos/artifacts/oto-till/src/mockApi.ts` (5,835 lines) is a fake
  API that mutates JavaScript objects held in the browser's memory; a refresh
  resets everything (CLAUDE.md §2 says the same). `artifacts/api-server` is a
  stub with one health route. Its functions (e.g. `registerWalkInChildren`,
  `checkInFamilyWithPayment`, `recordSale`) are the business rules we port —
  cited by name in the plan. The "intake notes" are
  `docs/architecture/intake-2026-09-19/` (README + 8 reports), written from
  reading the exported code: OTO App's 796 Express routes (note 01) and
  Radar's 107 (note 05) are enumerated there, so those two backends have been
  read; the POS backend is ours to build (Sprint 1 built its first 63 routes).
- **Payments** — the owner's link is 2C2P's portal; 2C2P is the gateway, SCB
  the acquirer; PROJECT_CONTEXT §7.2 stands.

## Ticket log

(Empty until building starts. One entry per ticket: ported from, added per
the plan, UI additions, tests, deferred/notes — as in `SPRINT_1_PROGRESS.md`.)

## Deviations recorded

(None yet — the plan lists the ones it expects: booth order, Pi image, edge +
jobs inside api, face-scan removal, occupancy model, OTO App lifted as-is,
2C2P kept over a bank API.)
