# Sprint 2 progress

## Status

- Current checkpoint: **pre-build — Sprint 2 plan v2 complete, awaiting
  owner approval.** Nothing of Sprint 2 is built.
- Last completed step: plan v2 complete for the owner's 2026-09-20 direction
  (POS + booth first, then OTO App, Radar, Inbox; 2C2P sandbox for real QR;
  real device protocols) with `PAYMENT_GATEWAY.md` and `DEVICE_INVENTORY.md`
  finished and their facts carried into the tickets (see "Done on
  2026-09-20").
- Next step: the owner's approval of plan v2 (approval summary given in chat
  2026-09-20); on approval create the Jira tickets and start S2-01a.
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
  duties, unknowns), voucher/wristband/receipt design references; section 9
  (web research per device: TSPL2 for the 4B-2082A, DS2278 in CDC host mode
  on the box, XP-C260/XP-80 ESC/POS parameters, terminal cabling, host notes)
  folded in from `research/2026-09-20-device-research.md`, with sections 2
  and 4 corrected where the hardware note was wrong (beb9385).
- `docs/architecture/PAYMENT_GATEWAY.md` (new, 3f8827d): 2C2P API 4.3 facts
  with sources (JWT envelope, Payment Token, Do Payment on `PPQR` with the raw
  EMVCo payload, notification field names, inquiry codes, Payment Maintenance,
  Redirect API, sandbox, constraints, SFTP settlement file), our integration
  design, `PGW_*` variable names, the owner's checklist, the SCB direct API as
  the alternative provider; UNCERTAIN items listed (first: how the sandbox
  marks a PromptPay QR as paid).
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

_Plan v2 is complete as of commit set 5dabf05 → this one: SPRINT_2_PLAN.md,
DEVELOPMENT_PLAN.md (1,849 lines), PAYMENT_GATEWAY.md, DEVICE_INVENTORY.md,
AGENCY_PROPOSAL.md, features/inbox.md; CLAUDE.md points at the two plans._

1. Owner approval of `docs/progress/SPRINT_2_PLAN.md` (see "Owner inputs
   needed").
2. On approval: create the Jira tickets (one issue per ticket, lettered parts
   as sub-tasks; descriptions, acceptance criteria and QA steps copied from
   the plan; statuses never changed by us).
3. Start S2-01a; from then on the ticket log below is the record, updated in
   the same commit series as the code.

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
