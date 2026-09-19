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

_Checkpoint 2026-09-20, second session (commits 5dabf05 → 45d3997): items 1
and 2 of the earlier list are done —  (3f8827d) and
 §2/§4/§9 (beb9385); tickets S2-06 (460779c), S2-10a
and S2-15a (45d3997) carry the researched values; STATUS.md rewritten
(d0d31c9); feature pages and the docs index point at the tickets (36b02d7)._

1.  — being written by an agent that
   saves incrementally (DRAFT line at the top until it finishes). If it is
   still marked DRAFT when resuming, finish it from its own headings:
   resume protocol, sources and precedence, target architecture, work order,
   per-ticket recipe, how each foreign app is lifted, conventions, env
   registry, research index, open-questions register, definition of done.
2. Read the finished development plan once against  and
   fix any inconsistency it reports; commit.
3. Present the approval summary to the owner: readiness answers, the 19
   tickets with milestones and checkpoints, the contract-coverage map with
   the deferred items to confirm, open decisions 29–32, the inputs needed
   (gateway portal question first).
4. On approval: create the Jira tickets (descriptions, acceptance criteria,
   QA steps; never change statuses) and start S2-01a; from then on the
   ticket log below is the record.

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
