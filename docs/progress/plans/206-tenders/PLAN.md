Copied from the session scratchpad on 2026-09-23 as the checkpoint; the slices’ landed state is in SESSION_HANDOVER.md and the SCRUM-206 comments — where this plan and the landed code disagree, the code and the ticket’s comments win (see the Slice A fix-round facts, B’s drawer-kick deviation, C1’s exchange gate).

# SCRUM-206 (S2-10a) — slice plan

**Basis.** Ticket text read via `read-desc.mjs SCRUM-206` and cross-read against
`docs/progress/SPRINT_2_PLAN.md:1714-1806` (identical Includes/Excludes/acceptance).
Code facts below are HEAD `adff73c` unless a line says "working tree"; the five
reader findings in `plan-206/` (`sale-ledger-map.md`, `device-plumbing.md`,
`payment-gateway-contract.md`, `vendor-protocols.md`, `payment-ui-map.md`) are the
evidence behind every citation and are not repeated here.

**Shape of the answer.** Eight slices. One is blocking-first (the vocabulary and the
migration), three pairs can run in parallel, two are tails. Every slice owns files no
other slice writes. Where a file is genuinely shared the plan names the one owner and
tells the others "read only, report the line".

---

## 0. Ground rules that bind every slice

1. **One migration, and it is Slice A's.** Next number is `0019` —
   `packages/db/migrations/meta/_journal.json` ends at `idx: 18`,
   `0018_booking_redemption`. Slice A lands the **complete** column set for every later
   slice (including columns only Slice D or G will write). No other slice writes a
   migration; a slice that discovers a missing column files it back to Slice A rather
   than adding `0020`.
2. **Nothing new under `/sales/*`.** `apps/api/test/sales.test.ts:1310-1318` pins the
   OpenAPI path list for `/sales` and `:1320-1353` pins the six route guards, both
   exact. Terminal and gateway routes therefore live under `/payments/*` and
   `/webhooks/*`, where those filters do not reach. Only Slice B may change those two
   pins.
3. **`apps/api/src/app.ts` belongs to Slice B**, which creates
   `apps/api/src/routes/payments.ts` and `apps/api/src/routes/webhooks.ts` as empty
   registered plugin shells and hands them to Slices C2 and D. No other slice edits
   `app.ts`.
4. **The four-copy rule** (`packages/box-agent/src/protocol.ts:407-418`): a box command
   kind exists in `protocol.ts`, `packages/db/src/schema/edge.ts`,
   `apps/api/src/routes/fleet.ts` and `apps/console/src/api/fleet.ts`, and
   `apps/api/test/contract-drift.test.ts` compares two of them. **Slice A lands all four
   copies in one commit** so the drift test is never red between slices.
5. **Redaction is not optional and is already card-aware.** `packages/telemetry/src/redact.ts:148-236`
   denies `pan/cvv/track2/cardnumber/cardholder/approvalcode/approvalnumber` and sweeps
   bare Luhn-valid digit runs; `apps/api/src/services/ops.ts:172` pushes every
   `ops_run.detail` through it. Consequence every slice must know: **an approval code
   stored on `payment_attempt` is correct; the same code in an `ops_run.detail` is
   redacted and will not show on Failures.** Do not "fix" that.
6. **Never print or commit a secret.** The Digio void password (`<the Digio void password — vendor spec §5.5; configuration, never in the repository>`, vendor spec
   §5.5) is config, not a fixture constant. `PGW_*` values never enter the repo; the
   Console shows presence flags only (`PAYMENT_GATEWAY.md:713-722`,
   `SPRINT_2_PLAN.md:888`).
7. **`imports/` is never committed.** Vendor fixtures are hex/XML files written into
   `packages/box-agent/test/fixtures/terminal/` with a page/line citation in the header,
   not copies of the PDF/HTML.
8. **The excludes stay excluded**: no voucher redemption (S2-10b), no refund/void UI or
   History actions (S2-11), no cash session/EOD/settlement screens (S2-15a), no wallet
   tender (S2-14a), no real hardware adapters (simulators only, same messages).
   `QrPayment.refund` and `processType V/R` are built **as the package's API, honoured by
   the simulator** — the ticket says so — but no POS refund button appears.

---

## 1. Slice table

| Slice | Title | Depends on | Parallel with |
|---|---|---|---|
| **A** | Ledger schema, vocabulary, seed | — | — (everything waits) |
| **B** | Cash tender, attempt ledger service, attempts on the sale read + Attempts list | A | C1, E |
| **C1** | Box terminal adapters, simulators, fixtures, ref counter | A | B, D, E |
| **C2** | Card tender in the cloud: routing, inquiry, staff confirmation, manual entry, terminal simulator panel | A, B, C1 | D, E |
| **D** | 2C2P QR: `packages/payments-2c2p`, webhook, poller job, env, gateway simulator panel | A, B | C1, C2, E |
| **E** | Payment methods admin wired | A | B, C1, C2, D |
| **F** | POS payment stage (cash / card / QR / manual / split) + customer display | A, B, C2, D | G |
| **G** | Offline: `box_seq` stamping, sale outbox, sync handler, PAX-QR `awaiting_settlement` | A, B, C1 | F |

**Launch order.** `A` alone → then `{B, C1, E}` in parallel → then `{C2, D}` in parallel
→ then `{F, G}` in parallel. Five waves. If only two agents are free, the critical path
is `A → B → C2 → F`.

---

## Slice A — Ledger schema, vocabulary and seed

**Goal.** Every table, column, constraint, enum, zod schema and command kind this ticket
needs exists and is exported, so no later slice writes a migration or re-declares a
union. Migration applies twice from empty; `seed:demo-day` exists.

### Owns
- `packages/db/src/schema/sales.ts` — replace the `payment_attempt` placeholder
  (`:868-890`, whose own comment says "S2-10a owns its columns").
- `packages/db/src/schema/catalog.ts` — new `payment_method` (operator-wide; the POS
  store says so at `apps/pos/src/store/catalogStore.ts:71`).
- `packages/db/src/schema/edge.ts` — box command kinds (CHECK at `:154`) and the
  `terminal_ref` counter scope note beside `box_counter` (`:368-383`).
- `packages/db/src/schema/index.ts`
- `packages/db/migrations/0019_payment_tenders.sql`, `meta/_journal.json`,
  `meta/0019_snapshot.json`
- `packages/shared/src/payments.ts` **(new)** and `packages/shared/src/index.ts`
- `packages/shared/src/simulator.ts` — `terminal.*` and `gateway.*` actions added to
  `SimulatorActionSchema` (`:45-91`) and to `SIMULATOR_ACTIONS_WITH_SECRETS` (`:105-108`)
- `packages/box-agent/src/protocol.ts` — `BOX_COMMAND_KINDS` (`:419-437`) only
- `apps/api/src/routes/fleet.ts` — `RoutingSchema` at `:113` becomes the real
  `PaymentRoutingSchema` from `@oto/shared`; command-kind copy
- `apps/console/src/api/fleet.ts` — command-kind + routing type copies (`:188-191`)
- `apps/api/src/services/demo-reset.ts` — `FACT_ENTITY_TYPES` (`:67-79`) and the FK-safe
  delete order (`:113-115`) for every new table
- `packages/db/src/seed/demo-day.ts` **(new)**, `packages/db/src/seed/index.ts`,
  `packages/db/package.json` (the `seed:demo-day` script)
- Tests: `packages/shared/test/payments.test.ts`, `packages/db/test/migration-0019.test.ts`

### Reads only (report the line, do not edit)
`apps/api/src/services/sale.ts` (Slice B), `packages/db/src/seed/menu.ts` (in flight),
`docs/architecture/PAYMENT_GATEWAY.md`, `docs/architecture/DEVICE_INVENTORY.md`.

### Must not touch
`apps/api/src/services/sale.ts`, `apps/api/src/routes/sales.ts`, any `apps/pos/**`,
any `apps/console/**` except `api/fleet.ts`, `packages/box-agent/src/agent.ts`.

### Acceptance — mapped to the ticket's Includes
- **`payment_attempt` with every field the ticket lists.** Columns, with types:
  `id uuid pk`; `operator_id`, `branch_id`, `sale_id` (nullable — an attempt can exist
  before the sale is priced), `station_id`, `device_id` (→ `core.device`),
  `business_date date`; `method text` CHECK
  `cash|card|qr|wallet|voucher|transfer`; `provider text` CHECK
  `simulator|ghl|digio|2c2p|manual`; `status text` CHECK `created|sent_to_terminal|
  approved|declined|cancelled|unknown|inquiring|not_found|awaiting_staff_confirmation|
  awaiting_settlement`; `amount_satang bigint`, `tendered_satang bigint null`,
  `change_satang bigint null`; `terminal_ref text`, `tid text`, `mid text`,
  `approval_code text`, `last4 text`, `invoice_no text`, `tran_ref text`,
  `payment_id text`, `qr_payload text`, `expires_at timestamptz`,
  `paid_at timestamptz`, `staff_confirmed_by uuid → core.account`, `offline boolean
  default false`, `box_seq bigint null`, `action_id uuid`, `payload jsonb`, timestamps.
  Constraints: `unique(invoice_no)` **forever, partial `where invoice_no is not null`**
  (`PAYMENT_GATEWAY.md:616-637`); `unique(operator_id, action_id)` so a retried tender
  cannot mint a second attempt (the finalise path has no idempotency net today beyond
  `status='finalised'`, `sale.ts:2154-2156`); `unique(device_id, business_date,
  terminal_ref)` — the ticket's "refs are unique per terminal per day"; indexes on
  `sale_id`, `(status, created_at)` for `job:payments.pending`, `(operator_id,
  business_date)`, `tran_ref`.
  A second table **`payment_notification`** (`invoice_no`, `tran_ref`, `payment_id`,
  `received_at`, `raw jsonb`, `ops_run_id`) with `unique(invoice_no, tran_ref)` — the
  webhook's idempotency key per `PAYMENT_GATEWAY.md:650-654`; it cannot be a unique
  index on the attempt because several notifications legitimately land on one attempt.
- **Split tenders (schema half).** Nothing new: `outstandingOf` already sums N approved
  attempts (`sale.ts:1518-1527`). The column set above simply must not assume one row
  per sale — no unique index on `sale_id`.
- **`terminal_counter (device_id, next_ref)`.** **Decision D-1 (see §Open decisions):**
  reuse `edge.box_counter` (`edge.ts:368-383`, PK `(box_id, scope, counter_key,
  business_date)`, no CHECK on `scope`) with `scope='terminal_ref'`,
  `counter_key=<device id>` — `BoxStore.bumpCounter(boxId, key, by, now)` already exists
  (`packages/box-agent/src/store.ts:571-572`, implemented at `store-sql.ts:1160`) and is
  already transactional with the job that consumes it. **Zero migration, zero store
  change, and the per-day reset the uniqueness test wants is the PK.** Slice A's only
  job here is the doc comment naming the scope; C1 does the minting.
- **`payment_method`.** `id, operator_id, code (the token stored on sales), label,
  kind cash|card|qr|other, enabled, sort_order, archived_at`, `unique(operator_id, code)`.
  Seeded with the three the POS ships (`catalogStore.ts:786-790`: `cash`, `card`,
  `promptpay`).
- **Command/simulator vocabulary.** New box command kind `drawer_kick` (Slice B's
  fallback, see D-2) and the terminal tender kind `terminal_sale`; `SimulatorAction`
  gains `terminal.outcome` (`approved|declined|partial|no_response|inquiry_unavailable|
  timeout`), `terminal.advance_clock`, `gateway.paid|decline|expire|late_paid|
  suppress_webhook`. Terminal actions carrying an approval code go on
  `SIMULATOR_ACTIONS_WITH_SECRETS` (`services/fleet.ts:1605-1611` refuses them on the
  command queue — that refusal is the reason they travel by the station channel).
- **`packages/shared/src/payments.ts`** exports: the three CHECK unions as const arrays +
  types; `PaymentRoutingSchema` (`{ card?: 'card_terminal'|'manual', qr?: 'gateway'|
  'qr_terminal'|'none', cash?: 'drawer'|'none' }` — the shape the Console already writes,
  `apps/console/src/api/fleet.ts:188-191`, and the "S2-10a names the tenders" note at
  `packages/db/src/schema/fleet.ts:352-359`); `buildInvoiceNo({prefix, stationCode,
  businessDate, seq})` with the `[≤5]STATION(3)YYMMDD(6)SEQ(6) ≤ 20, A-Z0-9` rule
  (`PAYMENT_GATEWAY.md:616-637`); `ATTEMPT_ALLOW_LIST` — the only keys an adapter payload
  may keep (TID, MID, approval code, last4, amount, status, invoice number;
  `DEVELOPMENT_PLAN.md:381-385`); the `PaymentAttemptView` type every read answers with.
- **`seed:demo-day`.** It **does not exist** — `SPRINT_2_PLAN.md:1596` said S2-09a would
  start it and `SPRINT_2_PROGRESS.md:1504` lists it as still missing. Slice A creates
  `packages/db/src/seed/demo-day.ts` and the `seed:demo-day` script, seeding a trading
  day of sales **across all tenders on the two seeded TIDs** — `EDC 1` NEXGO
  `ghl_linkpos` TID `65703235` and `EDC 3` PAX `digio_tlv` (`packages/db/src/seed/index.ts:887-901`).
  It is written so S2-10b/S2-13/S2-15a extend it, not replace it.

### Tests and plants
- `pnpm db:migrate` from empty **twice in a row** (CLAUDE.md §SCRUM-10 rule; expand/contract
  per `DEVELOPMENT_PLAN.md:606-612`).
- Unit: `buildInvoiceNo` length/charset/uniqueness across a day boundary and a 6-digit
  rollover; the three unions match the CHECK text character-for-character.
- `apps/api/test/contract-drift.test.ts` stays green with the new command kinds.
- **Plant:** insert two attempts with the same `invoice_no` → unique index fires; insert
  an attempt with `status='paid'` (a word from the QR lifecycle that is *not* in the enum)
  → CHECK refuses. Screenshot the two refusals for the Jira comment.

---

## Slice B — Cash tender, the attempt ledger, and Attempts on the sale read

**Goal.** A cash tender records what was handed over and what came back, kicks the
drawer, finalises, and is visible as an attempt row on the Sale detail. Every later
tender writes through the one service this slice builds.

### Owns
- `apps/api/src/services/sale.ts` **(hot — SCRUM-333 is in this file now; rebase before
  starting and again before committing)**
- `apps/api/src/services/payments/attempt.ts` **(new — the shared API: `openAttempt`,
  `settleAttempt`, `failAttempt`, `attemptsForSale`, `outstandingAfter`)**
- `apps/api/src/routes/sales.ts`
- `apps/api/src/app.ts`, and the two **empty shells** it registers:
  `apps/api/src/routes/payments.ts` (→ C2) and `apps/api/src/routes/webhooks.ts` (→ D)
- `apps/api/src/services/print.ts` (the drawer-kick enqueue)
- `packages/print/src/**` and `packages/box-agent/src/printing/queue.ts` (`ROLE_FOR_KIND`
  at `:76-86` only) — see D-2
- `apps/api/test/sales.test.ts`, `apps/api/test/payments-cash.test.ts` (new)
- `apps/pos/src/api/history.ts`, `apps/pos/src/components/history/SaleDetail.tsx`
  **(both modified in the working tree right now — rebase)**

### Reads only (report the line)
`packages/db/src/schema/sales.ts` (A owns it), `apps/api/src/services/sale-tier.ts`,
`apps/api/src/services/menu.ts`, `apps/pos/src/pages/Till.tsx` (F owns it).

### Must not touch
Pricing and claims — `priceCart` (`sale.ts:915-1216`), `resolvePricingScope` (`:336-385`),
`resolveTier` (`:391-410`), `buildPricedLines` (`:1235-1365`), `quoteSale` (`:1374-1422`),
the `SALE_TOTAL_MISMATCH` check (`:1748-1758`), all of `services/sale-tier.ts`,
`resolveItemLines` (`:746-907`) and the pick-up-code rule (`:639-677`) — the **ordering**
of the pick-up gate before the tender (`:2161-2184`) must survive, its logic must not
change. Not `packages/box-agent/src/terminal/**` (C1), not `apps/pos/src/pages/Till.tsx`
or `components/till/**` (F).

### Acceptance — mapped to the Includes
- **Cash: tendered/change, drawer kick, finalisation.** `changeFor` already refuses a
  short tender (`sale.ts:2104-2114`) — keep it. `tendered_satang`/`change_satang` move
  from `payload` jsonb onto columns; `payload.tillChangeSatang` (the disagreement case,
  `:2220-2222`) stays as jsonb because it is evidence, not a figure. Drawer kick per D-2.
- **Cash tenders stamped for S2-15a.** Every attempt carries `business_date`,
  `station_id`, `operator_id`/`branch_id` and `paid_at` so the EOD ticket can group
  without a backfill. Nothing else of S2-15a is built.
- **Split tenders.** *The control-flow change of this ticket.* Today `finaliseSale`
  refuses a part payment and the refusal rolls the attempt back
  (`sale.ts:2198-2242`; pinned by `sales.test.ts:544-561`). New model: an attempt is
  recorded when it is taken (`openAttempt` → `settleAttempt`), the sale may sit with
  `outstanding > 0` and one or more approved attempts, and the sale closes — receipt
  number allocated, status `finalised` — the moment outstanding reaches zero, whether
  that is the till's second tender or Slice D's webhook. `sales.test.ts:544-561` is
  **rewritten, not deleted**: a part payment now leaves an attempt and no receipt number.
  The `'paid'` status in `SALE_STATUSES` (`schema/sales.ts:106`), which nothing writes
  today, becomes the state "attempts cover the total, receipt not yet allocated" only if
  D-3 says so; the default is that it stays unused and `tendering → finalised` remains
  the one transition.
- **Attempts list on the Sale detail (read).** `getSaleDetail` (`sale.ts:2433-2518`)
  joins attempts and answers `attempts: PaymentAttemptView[]` (status, provider,
  reference, amount, last4, TID, approval code, action id, `paid_at`). `listSales`
  (`:2343-2431`) gains a tender summary only if it is free; it is not an acceptance item.
- **UI half:** `SaleDetail.tsx` renders the list in both `layout='columns'` and
  `layout='stacked'` (`:43-56`), replacing the "what it cannot show" comment at `:27-42`.
- **Idempotency.** `saleFinaliseIdempotencyKey` (`apps/pos/src/api/sales.ts:424-450`)
  hashes the tender — read `:428-443` before touching it. The server-side net is now the
  `unique(operator_id, action_id)` on the attempt from Slice A; `status='finalised'`
  alone is no longer sufficient once a sale can be part-paid.
- **Route conformance.** Any new mutating route is in one transaction, records its audit
  with that same handle, and takes an idempotency key
  (`apps/api/test/route-write-conformance.test.ts:203-452`, lists exact in both
  directions). Keep new paths off `/sales/*` except the finalise route that already exists.

### Tests and plants
- Rewrite/extend `sales.test.ts:456-657` (the nine pinned tender cases) — each one is a
  constraint, none may silently change meaning.
- New: two attempts settle one sale; a third over the balance is refused; an attempt
  replayed on the same `action_id` writes nothing and answers the same body; the audit
  row's `after.tender` still matches (`sale.ts:2271-2292`).
- **Plant:** send the same finalise twice with the same action id from two connections →
  one attempt, one receipt number. Plant a tender 1 satang over the balance → 400 and no
  row.

---

## Slice C1 — Box terminal adapters, simulators, fixtures and the ref counter

**Goal.** Two dialects that encode and parse the vendors' real messages, two simulators
that answer on those same messages, and a per-terminal-per-day reference counter — all
inside `packages/box-agent`, testable with no database and no cloud.

### Owns
- `packages/box-agent/src/terminal/**` **(new)**: `contract.ts` (`PaymentTerminal`:
  `sale`, `inquire`, `void`, `health`), `serial-channel.ts`, `ghl.ts`, `digio.ts`,
  `simulator-ghl.ts`, `simulator-digio.ts`, `counter.ts`, `index.ts`
- `packages/box-agent/src/agent.ts` (capability registration beside `printing()` /
  `scanner()` / `booth()` at `:1812-1843`; `executeCommand` cases at `:1408-1688`)
- `packages/box-agent/test/terminal-*.test.ts` and
  `packages/box-agent/test/fixtures/terminal/**`

### Reads only (report the line)
`packages/box-agent/src/printing/{channel,adapter,queue,simulator,index}.ts` — the
pattern to copy, **not to edit**: `PrinterChannel` (`channel.ts:93-105`), the
simulator-behind-the-same-adapter switch (`index.ts:112-130`), `routeTo`
(`queue.ts:307-321`), `serialise(deviceId, fn)` (`queue.ts:524-536`), `recover()`
(`queue.ts:435-490`). `packages/box-agent/src/protocol.ts` (A owns it).

### Must not touch
`printing/**` (Slice B owns the one `ROLE_FOR_KIND` line), `store.ts` / `store-sql.ts` /
`store-sqlite.ts` / `store-postgres.ts` (`bumpCounter` already exists — using it is not
editing it), `outbox.ts` (Slice G), anything in `apps/`.

### Acceptance — mapped to the Includes
- **GHL LinkPOS XML.** `<xml>` with the sample's element order
  (vendor PDF p.18: `trade_type, pos_ref_no, amount, invoice_no, transaction_id,
  transaction_type, service_type, cashier`); parse order-independently; accumulate bytes
  until `</xml>` — **there is no framing, length, STX/ETX, checksum or ACK layer**.
  `amount` is **decimal major units** `100.25` → satang round-trip.
  **Two disjoint response-code spaces on one field**: ISO for card SALE (`00` approved,
  `05` do-not-honor, `10` partial approval, p.8-10), `00/01` for wallets, QUERY and every
  VOID (p.11/13/16/17) — branch on `trade_type` *before* reading `response_code`.
  **`pos_ref_no` is 12 characters** (the intersection of the doc's 20/12/32, and what the
  ticket asks for). **There is no QUERY for CARD** (p.13) — the adapter must not invent
  one; that is what forces the staff-confirmation path in C2.
  **The void key is `invoice_no` (+ `card_approval_code`), never the sale's
  `pos_ref_no`** — a void draws a **fresh** ref.
- **Digio 3E55 BER-TLV.** `[3E 55][BER length][content][XOR CRC]`, CRC over header
  through last content byte (spec §4). **Generate the CRC; do not copy it from the
  document's examples — seven of ten printed CRCs are wrong** (verified; the §5.4.1 Sale
  request `…41311F` is one of the three that are right and is the generator's proof).
  Tags are single binary octets *except* the ASCII-named `QR`, `0M`, `CN`, `R1-R3` —
  parse with a per-action tag table, not generic BER, and **ignore the per-row "TLV for
  Sample Value" column, which is systematically corrupt**. Amounts are satang as ASCII
  digits. **Tag numbers move between action codes** (TID is tag `13` on `A1`, tag `16` on
  `A3`/`A18`) — one shared "look up tag 13" helper is a bug. Approved is **`100`**, not
  `00`. A QR sale is a **two-response exchange**: `A18` carrying the payload in tag `QR`,
  then `A3` when the customer pays — keep reading after the first complete frame and
  dispatch on tag `21`. `T0/T1` Terminal Info is the health probe; `T2` inquiry answers
  with the **sale** response when found and `T3`+`22=203` when not.
- **Fixtures.** Written into `test/fixtures/terminal/` as hex/XML with a citation header,
  generated by the encoder and asserted byte-for-byte against the spec's three
  trustworthy frames; the park's real identities from `DEVICE_INVENTORY.md:38-41`
  (NEXGO TID `65703235` / MID `4648434010`; PAX SN `1854355548`).
- **`terminal_counter`.** `counter.ts` mints via `bumpCounter(boxId, {scope:
  'terminal_ref', key: deviceId, businessDate}, 1)` → 12-char `pos_ref_no` for
  `ghl_linkpos` devices, 6-digit for `digio_tlv`; **voids and inquiries draw from the
  same counter** (both vendors require a unique new ref for a void). Mapped to the
  attempt id by C2 when it records the attempt.
- **Simulators, same messages.** Six outcomes — approved, declined, **partial approval**
  (GHL `10` with a lower `amount`; Digio has no partial code, so `100` with tag `01`
  below the request, which drives the same refuse-and-void branch), no-final-response
  (write nothing back), inquiry-unavailable (no answer to QUERY/`T2`, and the *permanent*
  state for a NEXGO card), timeout (Digio `401`) — plus **"Advance terminal clock"**,
  which is what makes the void windows real: GHL card-before-settlement and wallet-before
  23:00 (p.15), Digio `205` "already settled". `THAIQRCODE` must refuse a void (p.15);
  Digio answers `333` to a void outside credit/Alipay/WeChat.
- **The 120 s customer-interaction budget** (`DEVICE_INVENTORY.md:948`) and the by-id
  serial path that disappears and comes back on a different `ttyACM` (`:946, :949-957`)
  are the transport requirements; `CHANNEL_TIMEOUTS` (`printing/channel.ts:30-37`) has no
  such budget — the terminal channel defines its own.

### Tests and plants
- Encode/parse round-trip per dialect against every fixture; `SALE_REQ` reproduces the
  spec example byte-for-byte.
- Ref uniqueness: 1,000 mints on one device on one day are distinct; a day roll resets;
  two devices never collide.
- **Plant:** flip one byte of a fixture's CRC → the parser refuses rather than reading
  garbage. Plant a `QR`-tagged frame through a generic BER parser → show it mis-reads,
  which is why the tag table exists.

---

## Slice C2 — Card tender in the cloud

**Goal.** Pressing Card routes to the station's terminal, the outcome lands on an
attempt, and every path the acceptance names — decline, no-final-response → inquiry,
inquiry-unavailable → audited staff confirmation, partial approval → reject and void,
manual entry — is real and observable.

### Owns
- `apps/api/src/services/payments/terminal.ts` **(new)**
- `apps/api/src/routes/payments.ts` (the shell Slice B registered)
- `apps/api/src/services/fleet.ts` (only if `queueCommand`'s guards need the new kind)
- `apps/console/src/components/devices/TerminalSimulatorPanel.tsx` **(new)**,
  `apps/console/src/components/devices/simulatorApi.ts`,
  `apps/console/src/pages/Devices.tsx`
- `apps/api/test/payments-terminal.test.ts`, `apps/api/test/payments-redaction.test.ts`

### Reads only (report the line)
`apps/api/src/services/payments/attempt.ts` (B), `apps/api/src/services/print.ts` (B),
`apps/api/src/services/box.ts` (`pollCommands` `:1049`, `completeCommand` `:1098`,
config devices `:936`), `apps/api/src/services/ops.ts` (`recordRun` `:158-226`),
`packages/box-agent/src/terminal/**` (C1).

### Must not touch
`apps/api/src/services/sale.ts` and `routes/sales.ts` (B), `app.ts` (B),
`packages/box-agent/**` (C1/G), `apps/console/src/pages/Integrations.tsx` (D),
`apps/pos/**` (F).

### Acceptance — mapped to the Includes
- **Station routing.** `core.station.payment_routing` (schema `fleet.ts:352-360`, now
  typed by Slice A's `PaymentRoutingSchema`) picks `card_terminal` or `manual`;
  `station_device` gives the device for the role, one per role per station
  (`fleet.ts:610-651`). The device's `protocol` (`ghl_linkpos` | `digio_tlv`),
  `terminal_id`, `merchant_id`, `serial_number` come off `core.device`
  (`fleet.ts:531-562`) and reach the box already (`protocol.ts:270-307`).
- **The command path, and why the result comes back its own way.** A tender is a queued
  `box_command` of the new kind (`services/fleet.ts:1646-1669`), and the **outcome
  travels on its own route** — `POST /payments/attempts/:id/result` — exactly as a print
  job's outcome does rather than being squeezed into the command ack
  (`packages/box-agent/src/agent.ts:474-484`, `services/print.ts:616`). Latency to design
  around: command poll is **5 s** (`agent.ts:328`), and a heartbeat ack with
  `commandsPending > 0` also triggers a poll (`agent.ts:1320-1322`).
- **Approved** finalises with approval code, TID, last4 and the 12-char reference. For
  GHL **TID/MID are not on the card wire** — they come from `device.terminal_id` /
  `device.merchant_id`; for Digio they arrive on tags `13`/`14` (or `16`/`17`) and are
  **written back onto the device row** the first time a terminal answers (the park's PAX
  rows have no TID/MID on file, `DEVICE_INVENTORY.md:40-41`).
- **Declined** → attempt `declined`, sale untouched, till returns to method selection.
- **No final response** → attempt `unknown`, the till blocks, the inquiry rule runs
  (`T2` for Digio, `QUERY` for GHL wallets); an approved inquiry **completes the sale
  without a second charge** — the returned frame carries the same transaction id and
  approval code, so it settles the existing attempt rather than opening one.
- **Inquiry unavailable** → attempt `awaiting_staff_confirmation`; the dialog's answer is
  written with `staff_confirmed_by` and an audit row naming the account. For a **NEXGO
  card this is permanent, not degraded** — the dialect has no card QUERY.
- **Approved amount ≠ requested → reject and void.** Compare **satang after the
  round-trip**, never the strings; on mismatch send the void (fresh ref, `invoice_no` +
  `card_approval_code` for GHL; `A10` + transaction id for Digio) and leave the attempt
  `declined` with the void recorded.
- **Manual entry** (approval code + TID) → `provider='manual'`, audited, no device.
- **Every adapter call an `ops_run`** of kind `device`/`integration` under the action id
  (`services/ops.ts:158-226`; `ops.ts:40-50` already permits both kinds — **no
  migration**). Follow the existing device precedent so the fingerprint groups by failure
  rather than by sale (`services/print.ts:666-697`).
- **Allow-list projection.** Stored payloads keep only Slice A's `ATTEMPT_ALLOW_LIST`.
  The redaction fixture is **a raw Digio `A1` frame containing tag `09` (masked PAN) and
  tag `0A` (cardholder name)** plus a GHL `card_no`, asserting neither survives; the
  Digio void password (tag `06`) never reaches a log or a fixture.
- **Console panel.** Six outcomes + "Advance terminal clock", one queued command per
  press, simulated devices only — same rules the printer panel states
  (`SimulatorPanel.tsx:1-40`); actions carrying an approval code go by the station channel
  because `services/fleet.ts:1605-1611` refuses secret-bearing commands.

### Tests and plants
- Integration per outcome against a simulated device; the audited confirmation asserts
  the account id on the audit row.
- Redaction fixture (above) and an `ops_run` payload key-set assertion.
- **Plant:** make the simulator approve ฿1 less than requested → the sale is refused and
  a void frame is sent (assert the frame, not just the status). Plant a second result for
  an attempt already `approved` → ignored, no second charge.

---

## Slice D — 2C2P QR

**Goal.** `packages/payments-2c2p` behind a `QrPayment` interface, a signed webhook, a
polling safety net, and a gateway simulator good enough that CI, demos and a fresh
checkout never need the sandbox.

### Owns
- `packages/payments-2c2p/**` **(new package; `packages/*` is already a workspace glob)**
  — `QrPayment` contract, `TwoC2PQrPayment`, `SimulatorQrPayment`, JWT HS256 envelope,
  `respCode` map, maintenance (JWE RSA-OAEP+A256GCM / JWS PS256) client
- `apps/api/src/services/payments/gateway.ts` **(new)**
- `apps/api/src/routes/webhooks.ts` (the shell Slice B registered)
- `apps/api/src/services/jobs.ts` (`job:payments.pending` + the inquiry poller)
- `apps/api/src/env.ts`, `.env.example`, `render.yaml`
- `apps/console/src/components/integrations/GatewaySimulatorPanel.tsx` **(new)**,
  `apps/console/src/pages/Integrations.tsx`
- `apps/api/test/payments-2c2p.test.ts`, `packages/payments-2c2p/test/**`

### Reads only (report the line)
`docs/architecture/PAYMENT_GATEWAY.md` (the authority — **do not re-research 2C2P**,
`DEVELOPMENT_PLAN.md:1532`), `apps/api/src/services/payments/attempt.ts` (B),
`apps/api/src/services/ops.ts`, `apps/api/src/routes/public.ts` (the unauthenticated-route
precedent).

### Must not touch
`app.ts`, `routes/sales.ts`, `services/sale.ts` (B); `apps/console/src/pages/Devices.tsx`
(C2); `apps/pos/**` (F); `packages/box-agent/**`.

### Acceptance — mapped to the Includes
- **Nothing outside the package knows 2C2P exists** (`PAYMENT_GATEWAY.md:571-573`). Money
  crosses the boundary as **integer satang**, formatted to D(12,5) only on the wire
  (`:590`).
- **Payment Token** → `paymentToken`, `currencyCode "THB"` (alphabetic, **not 764**),
  `invoiceNo` **one per attempt** from Slice A's generator, `paymentExpiry` from
  `PGW_PAYMENT_EXPIRY_MIN`; proceed only on `respCode 0000`.
- **Do Payment** on channel **`PPQR`** (configurable — `THQR` is a category code and is
  wrong), `qrType: RAW`, flow **`1005`** with `expiryTimer` (ms); the EMVCo payload comes
  back in `extras.qrData` and is stored on the attempt so **the display renders it
  locally and never calls 2C2P**.
- **Webhook `POST /webhooks/2c2p/payment`**, nine steps exactly as
  `PAYMENT_GATEWAY.md:641-670`: verify HS256 under `PGW_SECRET_KEY` → check `merchantID`
  → write an `ops_run` with the raw envelope and source IP → idempotent on
  `(invoiceNo, tranRef)` falling back to `paymentID`, unique-indexed (Slice A's
  `payment_notification`) → match the invoice → compare amount **and** currency →
  on `0000` mark paid **inside the sale transaction, the same `withTx` path a cash tender
  uses** → **answer 200 within a second, always, even when refusing** → push the new
  state to till and display. **A 4xx here is a bug, not a defence.** `PGW_WEBHOOK_SECRET`
  is a path filter, **not authentication**.
- **Inquiry is the truth.** The notification is a trigger; a Payment Inquiry on the same
  `invoiceNo` must agree before anything is released (`:668-670`).
- **Poller**: every `PGW_INQUIRY_INTERVAL_S` (3) for two minutes, then 10 s jittered,
  stopping on a terminal state or 60 s after `expiresAt`; `job:payments.pending` flags
  anything in `sent_to_terminal|unknown|inquiring` older than **`PAYMENT_PENDING_MIN`
  (10)** on Failures. **These two dials are different things** —
  `PGW_INQUIRY_MAX_MIN` (30) stops polling. Job registration is mechanical:
  `buildDefaultJobs` (`services/jobs.ts:344-407`), advisory-locked, `PROCESS_ROLES`-gated,
  and registering it writes its `ops_expectation` so the watchdog measures it (`:496-520`).
- **`respCode` map**: `0000` paid · `0001`/`2001` pending · `0003` cancelled ·
  `9020`/`5009` expired · `5015`/`5016` amount mismatch → **`awaiting_staff_confirmation`,
  never paid** · `2002` not found · `5005`/`9015` duplicate invoice (our bug) · `9999`
  our webhook failed.
- **Status reconciliation (D-3).** `PAYMENT_GATEWAY.md:594-613` uses
  `created|qr_shown|paid|expired|cancelled|late_paid|refunded`; the ticket's column enum
  does not contain those words. The mapping is written down in `packages/payments-2c2p`'s
  header and in `SPRINT_2_PROGRESS.md`: `qr_shown→sent_to_terminal`, `paid→approved`,
  `expired→cancelled` (+ `payload.expired`), `late_paid→awaiting_staff_confirmation`,
  `refunded` is S2-11's word and is not written here.
- **Maintenance** `processType V` (same-day void) and `R` (refund after settlement) on
  its **own host** with the `PGW_MAINT_*` RSA keys; **honoured by the simulator**, which
  is all the acceptance needs — no POS refund button (S2-11).
- **Gateway simulator panel**, five controls — "customer paid", "decline", "expire",
  "late payment", **"Suppress webhook"** — each posting a synthetic notification **signed
  with the configured secret to the real webhook route**, so the production path is what
  is exercised. Active when `PGW_PROVIDER=simulator` **or when
  `PGW_MERCHANT_ID`/`PGW_SECRET_KEY` are absent**, and that silent selection is announced
  in the startup log and on Integrations — the one deliberate exception to
  `assertProductionSafe` (`apps/api/src/env.ts`).

### Tests and plants
- Envelope: sign → verify → decode round-trip; a response with a bad signature is
  refused before its claims are read.
- Webhook: replay changes nothing; wrong merchant, unmatched invoice, amount mismatch all
  answer **200** and write no payment; a `5015` raises the alert and leaves the sale open.
- Poller: with the webhook suppressed the attempt still reaches `approved` within one
  interval.
- **Plant:** a notification whose `amount` is 1 satang off → not paid, alerted.
  Plant a leaked `PGW_SECRET_KEY` in a log line → the redaction/secret test fails it.

---

## Slice E — Payment methods admin wired

**Goal.** The prototype's `PaymentMethodsSection` stops being mock: the list, its order
and its enabled flags persist, and the two `SCRUM-206` mock mutators disappear.

### Owns
- `apps/api/src/routes/catalog.ts` (there is no `services/catalog.ts` — catalogue logic
  sits in the route file today) and `apps/api/src/services/payment-methods.ts` **(new —
  the `payment_method` CRUD, operator-wide, so the route stays a thin caller per
  CLAUDE.md §8)**
- `apps/pos/src/components/admin/payments/PaymentMethodsSection.tsx`
- `apps/pos/src/store/CatalogStoreContext.tsx` (delete the two `'SCRUM-206'` entries at
  `:270-272`), `apps/pos/src/store/catalogStore.ts`,
  `apps/pos/src/components/admin/adminSections.tsx` **(in flight — its payment comment is
  being rewritten right now; coordinate, do not race)**
- `apps/api/test/catalog-payment-methods.test.ts`

### Reads only (report the line)
`packages/db/src/schema/catalog.ts` (A), `apps/pos/src/lib/payments.ts` (the rules below
are ported, not rewritten).

### Must not touch
`apps/pos/src/pages/Till.tsx`, `components/till/**` (F); any API payment service (B/C2/D).

### Acceptance — the prototype rules that must survive
- The tender list is **data, never hardcoded** (`lib/payments.ts:17`,
  `catalogStore.ts:1144`); behaviour keys off **`kind`**, not the token
  (`payments.ts:41,56,65`); a legacy token still resolves (`normalizePaymentMethod`,
  `:12`) and `makeId` can never re-mint `credit_card`
  (`PaymentMethodsSection.tsx:20-33`); reorder is a swap of two `sortOrder`s (`:69-77`);
  **deleting a tender in use is a warning, not a refusal** (`:56-67`) — but the count now
  comes from the ledger and **the refusal, if any, is the server's**.
- Scope is **operator-wide** (`catalogStore.ts:71`), which the route must match.
- Deleting the two mutator entries is compile-enforced: they must move to
  `wiredMutators` in the same edit or every `NotSavedNotice` naming them stops compiling.

### Tests and plants
- API: create, rename, reorder, disable, delete-in-use; audit rows on each.
- **Plant:** disable `promptpay` in admin → the till's method grid loses it and a sale
  cannot be recorded against it (the prototype's "never record against a hidden tender"
  rule, `FnbPayment.tsx:82`).

---

## Slice F — The POS payment stage

**Goal.** One screen, four tenders and a split, in the prototype's design language, on
the four tills that share the writer.

### Owns
- `apps/pos/src/components/till/StepPayment.tsx`,
  `apps/pos/src/components/till/CustomerDisplay.tsx`,
  `apps/pos/src/components/till/` new panels (cash keypad, terminal state, QR, manual,
  split)
- `apps/pos/src/pages/Till.tsx`, `apps/pos/src/components/mobile/MobileTill.tsx`
  **(both in flight — rebase)**, `apps/pos/src/pages/OrderStation.tsx`,
  `apps/pos/src/pages/MerchStation.tsx`
- `apps/pos/src/lib/saleWriter.ts`, `apps/pos/src/api/sales.ts`,
  `apps/pos/src/api/payments.ts` **(new)**
- `apps/pos/src/i18n/dictionary.ts` (new display keys in all five locales)
- `apps/pos/test/**` for the above; the Playwright smoke

### Reads only (report the line)
`apps/pos/src/components/history/SaleDetail.tsx` and `api/history.ts` (B),
`apps/pos/src/components/admin/payments/**` (E), `apps/pos/src/lib/promptpay.ts`
(**keep it** — it becomes the PAX/booking payload path, not dead code).

### Must not touch
Any `apps/api/**`, any `packages/**`, `apps/pos/src/store/**` (E).

### Acceptance — mapped to the Includes
- **Design is preserved** (CLAUDE.md §7.1). `StepPayment`'s `KIND_STYLE` (`:17-49`), the
  grid sized from the method list (`:65`), the footer (`:101-113`) and the `notice` /
  `busy` / `unpriced` props S2-09a added stay as they are; everything new hangs off them.
- **Cash**: tendered/change on the existing `NumberKeypad` / `TouchKeypad` design; the
  hard-coded `tenderedSatang`/`changeSatang` at `Till.tsx:2006-2012` (whose comment names
  this ticket) become real.
- **Card**: sent → approved/declined/inquiring/awaiting-confirmation on the till, the
  blocked state, the audited confirmation dialog, manual entry (approval code + TID).
- **QR**: the display's violet panel is **fixed furniture** (`CustomerDisplay.tsx:534-602`)
  — the one line that changes is `<QrCode seed={...}>` at `:568`, which now renders the
  EMVCo payload from the attempt, with the `expiryTimer` countdown beside the amount.
  "Customer paid" flips to thank-you **within 5 s**; display QR render < 2 s
  (`SPRINT_2_PLAN.md:534`).
- **Split**: port `FnbPayment.tsx:62-102` — buckets chosen **by kind** from the
  configured list, `remainderValid` so a disabled tender cannot settle a balance,
  `canConfirm`; a ฿0 sale still has no tender step (`FnbPayment.tsx:107`,
  `Till.tsx:1948`).
- **The epoch guard is load-bearing.** Every async tender must keep honouring
  `saleEpochRef` / `noteSaleLeftBehind` (`Till.tsx:1919-1926`) or a late approval prints
  a band for the next family.
- **Offline flag**: when the till is writing offline the attempt carries `offline=true`
  and the screen says so (the ledger half is Slice G).
- **All four tills** inherit the payload change (`Till`, `MobileTill`, `OrderStation`
  — whose `tenderMethodOf` comment at `:66-75` is exactly the split-tender debt —
  and `MerchStation`).

### Tests and plants
- Playwright smoke: cash sale end to end; card approved; QR paid via the simulator.
- **Plant:** make the API answer `declined` → the till returns to method selection and
  no receipt number is shown. Plant a stale epoch (finish a sale, answer the previous
  one) → the answer is dropped.

---

## Slice G — Offline sales and `box_seq`

**Goal.** The acceptance line "with the box offline a cash sale and a terminal-approved
sale finalise and appear on the Sale list after reconnect **exactly once**".

> **Read this before launching G.** At HEAD **no sale event exists in the box→cloud sync
> path at all**: `HANDLERS` in `apps/api/src/services/sync.ts:826` registers six kinds
> (`member.created/updated`, `child.created/updated`, `visit.created`,
> `station.takeover`) and none of them is a sale or a payment. `commitSale` hardcodes
> `origin: 'cloud'` (`sale.ts:1851`) and never sets `box_seq` or `source_event_id`,
> though both columns exist (`schema/sales.ts:282, 288`). This slice is therefore **new
> plumbing, not wiring**, and it is the one part of SCRUM-206 that could plausibly be its
> own ticket. See open decision **O-2**.

### Owns
- `apps/api/src/services/sync.ts` (two new handlers: `sale.finalised`, `payment.recorded`)
- `packages/box-agent/src/outbox.ts` and the sale-facing part of
  `packages/box-agent/src/agent.ts` **(conflict with C1, which also edits `agent.ts` —
  run G after C1, never beside it)**
- `apps/api/test/sync-sales.test.ts`, `packages/box-agent/test/offline-sale.test.ts`

### Must not touch
`services/sale.ts` (B) beyond calling it; the terminal adapters (C1); anything in
`apps/pos/**`.

### Acceptance
- A cash sale and a terminal-approved sale taken while the box is offline are queued on
  the box's outbox, carry `box_seq` from the gapless generator the store already keeps
  (`packages/box-agent/src/store.ts:44, 70` — `nextBoxSeq`, "the generator whose row lock
  is what makes `box_seq` gapless"), replay on reconnect, and appear **once** on the Sale
  list — the duplicate net being Slice A's `unique(operator_id, action_id)` plus the
  existing sync idempotency.
- A QR tender is **not** offline-capable — minting a 2C2P QR is a server call
  (`PAYMENT_GATEWAY.md:51-54`); the offline path is the **PAX terminal's own QR** (Digio
  `A3`/`A18`), and that attempt is flagged **`awaiting_settlement`**.
- Receipt numbering stays inside the finalise transaction (`allocateReceipt`,
  `sale.ts:1549-1611`); the box resumes from the receipt-series high-water mark already
  shipped in the cache bundle (`sync.ts:3531-3583`).
- **`pos.sale_freeze`** (`0014_sales_ledger.sql:386-415`) means a late fact can never
  edit a finalised sale outside the seven mutable columns — a late webhook or a late
  replay lives on the attempt row, never on the sale.

### Tests and plants
- Replay the same offline batch twice → one sale, one receipt number, one attempt.
- **Plant:** deliver the batch out of order (seq 3 before seq 2) → the ledger still ends
  with one of each.

---

## 2. What can run in parallel

- **Wave 1:** `A` alone. Everything downstream imports its unions, so starting anything
  beside it means re-writing types twice.
- **Wave 2:** `B`, `C1`, `E` — disjoint (`apps/api/src/services/sale.ts` + `packages/print`
  vs `packages/box-agent/src/terminal` vs `apps/pos/src/store` + `routes/catalog.ts`).
- **Wave 3:** `C2`, `D` — disjoint (`routes/payments.ts` + Devices page vs
  `routes/webhooks.ts` + `packages/payments-2c2p` + Integrations page). Both need B's
  attempt service, neither touches it.
- **Wave 4:** `F`, `G` — disjoint (`apps/pos/**` vs `apps/api/src/services/sync.ts` +
  `box-agent`). **G must not overlap C1**: both edit `packages/box-agent/src/agent.ts`.

**Hot files to rebase before and after every wave** (other agents are in them now):
`apps/api/src/services/sale.ts` (SCRUM-333 is adding ~88 lines after `:1496` and editing
`getSaleDetail`), `apps/pos/src/pages/Till.tsx`, `apps/pos/src/components/mobile/MobileTill.tsx`,
`apps/pos/src/components/admin/adminSections.tsx`, `apps/pos/src/api/history.ts`,
`apps/pos/src/components/history/SaleDetail.tsx`, `packages/db/src/seed/menu.ts`,
`render.yaml`.

---

## 3. Environment variables to add (names and meaning only — values never)

Both `.env.example` (which has **none** of these today; it runs `DATABASE_URL` →
`VITE_LAUNCHER_URL` with no payment section) and `render.yaml` (api service env block).
`PAYMENT_GATEWAY.md:766-784` is the authority; `PGW_*` replaces the `2C2P_*` names
because a leading digit is not shell-safe. **API server only — none of these reaches a
box or a browser.**

| Variable | What it is | Default |
|---|---|---|
| `PGW_PROVIDER` | `2c2p` or `simulator` — which `QrPayment` is active | `simulator` |
| `PGW_ENV` | `sandbox` or `production`; selects hosts and marks every record | `sandbox` |
| `PGW_BASE_URL` | Payment API host | from `PGW_ENV` |
| `PGW_MERCHANT_ID` | merchant id sent in every payload | empty |
| `PGW_SECRET_KEY` | HS256 signing/verifying key (**secret**) | empty |
| `PGW_CURRENCY_CODE` | alphabetic currency | `THB` |
| `PGW_BACKEND_RETURN_URL` | public HTTPS URL 2C2P notifies | — |
| `PGW_FRONTEND_RETURN_URL` | browser return for the booking hosted page (S2-12) | — |
| `PGW_WEBHOOK_SECRET` | path token, a cheap filter — **not authentication** (**secret**) | empty |
| `PGW_QR_CHANNEL_CODE` | Do Payment channel | `PPQR` |
| `PGW_QR_TYPE` | `RAW` so the display renders locally | `RAW` |
| `PGW_PAYMENT_EXPIRY_MIN` | minutes → `paymentExpiry` | `20` |
| `PGW_INVOICE_PREFIX` | ≤ 5 chars, keeps sandbox invoices off production ones | empty |
| `PGW_INQUIRY_INTERVAL_S` | seconds between inquiries while a QR is shown | `3` |
| `PGW_INQUIRY_MAX_MIN` | minutes after which polling stops and the attempt is flagged | `30` |
| `PGW_MAINT_BASE_URL` | Payment Action host — a **different** host | from `PGW_ENV` |
| `PGW_MAINT_PRIVATE_KEY` | our RSA private key, PEM (**secret**) | empty |
| `PGW_MAINT_2C2P_PUBLIC_KEY` | 2C2P's RSA public key, PEM | empty |
| `PAYMENT_PENDING_MIN` | **ours, not 2C2P's** — minutes before an unresolved attempt is flagged on Failures | `10` |

On Render every secret-marked row is `sync: false` (set in the dashboard, never in the
file). A missing `PGW_MERCHANT_ID` or `PGW_SECRET_KEY` **silently selects the simulator**
and says so in the startup log and on the Console's Integrations page — the one
deliberate exception to the boot-refusal rule in `apps/api/src/env.ts`.

---

## 4. Open decisions for the owner

**O-1 (blocks only the real-QR half). The 2C2P credentials and how a sandbox QR is
marked paid.** Open decision 32 is still open (`STATUS.md:63-66`,
`SPRINT_2_PROGRESS.md:286-288`): which portal the park holds — a 2C2P sandbox merchant or
an SCB Developer Portal application — and the sandbox merchant id, secret, enabled QR
channel and return URLs. Separately, **how the sandbox marks a PromptPay QR paid is
UNCERTAIN in the public docs** (`PAYMENT_GATEWAY.md:492-508`) and is settled by the first
sandbox session with 2C2P support. **Neither blocks the ticket**: the acceptance runs on
our simulator, and the public demo pair (`JT04`) can prove the wire format without an
account. What they block is the "real QR on the display" claim and the one Payment Option
call that confirms `PPQR` against the park's own merchant.

**O-2 (scope). Is the offline half (Slice G) inside S2-10a or its own ticket?** The
acceptance criterion asks for it, and at HEAD there is no sale event in the sync path at
all — six handlers, none of them a sale. G is new plumbing of a size comparable to C1. If
the sprint wants S2-10a closed sooner, G becomes "S2-10c — offline sales replay" and
S2-10a's fourth acceptance line moves with it. **Recommendation: keep it in the ticket
but build it last, so the decision can be taken on the evidence of waves 1-3.**

**O-3 (design, low cost). `terminal_counter` as a table or a `box_counter` scope.** The
ticket names a table; `edge.box_counter` + `BoxStore.bumpCounter` already give
(device, day) → next value atomically, with no migration and no store change.
**Recommendation: the scope.** Cost of being wrong later: one migration.

**O-4 (design). How the cash drawer opens.** The drawer pulse is a property of the sale
and rides the **printer**, not a device call (`packages/shared/src/device-settings.ts:49-53`,
`printing/queue.ts:100-115`), but **the platform does not print a receipt on finalise
yet** — `services/print.ts` has only the test print. Options: (a) a `drawer_kick` print
job through the existing queue — `edge.print_job.kind` is free text with no CHECK
(`schema/edge.ts:315`), so this is *not* a migration, and the kick shows on the Print jobs
list with its own result; (b) a `drawer_kick` box command; (c) wait for receipt printing
(S2-13) and pass `finish.drawerKick`. **Recommendation: (a) now, folded into (c) later.**

**O-5 (behaviour). May a sale sit part-paid?** Split tenders and an asynchronous QR both
require an approved attempt on an unfinalised sale, which today's finalise path forbids
and a test pins (`sales.test.ts:544-561`). **Recommendation: yes** — attempts are recorded
as they are taken and the sale closes when outstanding reaches zero. The owner-visible
consequence: a sale can be left open with money taken against it, which is exactly what
the Failures/pending job and S2-15a's EOD are for. Say no and split tenders and webhook
settlement both become impossible.

**O-6 (vendor confirmations — do not block, but ask now).** **GHL Thailand:** the serial
parity (spec says nothing, the sample code says Odd), the `pos_ref_no` length (the
document says 20, 12 and 32 in three tables), whether the LinkPOS app has any
"last transaction" recall for **cards** — if not, the audited staff-confirmation dialog is
permanent for NEXGO cards, not a fallback — and what a still-unpaid QR returns to QUERY.
**Digio (02-026-3485):** whether A4 is WeChat or Alipay (the spec contradicts itself),
whether a PromptPay QR can be voided (the prose forbids it, the tables document `A13` for
it — we assume forbidden), and the TID/MID for the park's two PAX terminals, which are
not on file.

**O-7 (policy). Deleting a payment method that has been used.** The prototype warns and
lets it through (`PaymentMethodsSection.tsx:56-67`). On a real ledger the count is real.
**Recommendation: the server refuses a delete and offers disable**, keeping the
prototype's warning copy for the disable path.

---

## 5. Risks, stated plainly

1. **`apps/api/src/services/sale.ts` is the busiest file in the repository this week.**
   Slice B owns it; SCRUM-333 is inside it now, including `getSaleDetail`, which B must
   change. Sequence B after 333 lands, or accept a merge.
2. **The GHL fixtures are partly reconstructed.** The vendor PDF prints exactly one
   literal message — a request builder — and **no response XML at all**; the response
   envelopes are inferred from the parameter tables. Mark those fixtures as inferred and
   capture one real exchange before the GHL adapter is called verified. The Digio
   fixtures need no such caveat, but **seven of the spec's ten printed CRCs are wrong** —
   generate, never copy.
3. **Two status vocabularies** (`PAYMENT_GATEWAY.md` §3.2 vs the ticket's column enum)
   with no mapping written anywhere. D-3 above writes it down once; if each slice invents
   its own, the Attempts list becomes unreadable.
4. **Slice G is plumbing that does not exist**, not wiring that needs connecting (O-2).
5. **Four tills share one writer.** Any change to the tender payload lands on Till,
   MobileTill, OrderStation and MerchStation at once — which is why F is one slice and
   not three.
