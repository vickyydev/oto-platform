# SCRUM-206 (S2-10a) — the sale ledger at HEAD, and the exact seam a tender slice attaches to

**Read at HEAD `adff73c64b3d1de4df7c5ceff415edf4829365d8`**, via `git show HEAD:<path>`.
`git diff --stat HEAD` over `apps/api/src/services/sale.ts`, `apps/api/src/routes/sales.ts`,
`packages/db/src/schema/sales.ts`, `apps/api/test/sales.test.ts` and `packages/db/migrations/`
returns **empty** — the working tree is identical to HEAD for every file in this map, so every
line number below is valid for both. (Other agents are editing `routes/members.ts`,
`services/members.ts`, `plugins/*`, `apps/pos/*`; none of those are on this path.)

---

## 1 · The tender data model, exactly as it stands

### `pos.payment_attempt` — `packages/db/src/schema/sales.ts:878-890`

Still the Sprint 1 placeholder, and the file says so in as many words
(`sales.ts:868-877`: *"Still the Sprint 1 placeholder shape. S2-10a owns its columns"*).
The whole table is:

| column | type | notes |
|---|---|---|
| `id` | uuid PK (`idPk()`) | `sales.ts:881` |
| `sale_id` | uuid → `pos.sale.id`, **nullable**, ON DELETE no action | `sales.ts:882`; FK re-created at `packages/db/migrations/0014_sales_ledger.sql:367` |
| `method` | text NOT NULL | `sales.ts:883` — free text, no check |
| `amount_satang` | bigint NOT NULL default 0 | `sales.ts:884` |
| `status` | text NOT NULL default `'recorded'` | `sales.ts:885` — no check constraint |
| `payload` | jsonb | `sales.ts:886` |
| `created_at`, `updated_at` | timestamptz | `...timestamps`, `sales.ts:887` |

One index: `payment_attempt_sale_idx` on `sale_id` (`sales.ts:889`).
**No** `operator_id`, `branch_id`, `business_date`, `station_id`, `action_id`, `box_seq`,
`provider`, `terminal_ref`, `TID/MID`, `approval_code`, `last4`, `invoice_no`, `tran_ref`,
`expires_at`, `paid_at`, `staff_confirmed_by`, `offline`. No unique constraint. **No freeze
trigger** (the `sale_freeze` / `sale_child_freeze` triggers cover `sale`, `sale_line`,
`sale_discount` only — `0014_sales_ledger.sql:386-436`). Migration `0014` deliberately left the
table alone (`0014_sales_ledger.sql:57-59`).

### The only writer, and the only values ever written

`apps/api/src/services/sale.ts:2206-2227`, inside `finaliseSale`:

- `method` = `tender.method ?? 'cash'` (`sale.ts:2204`) — **cash by default, and the only tender
  the till has today**
- `amountSatang` = `tender.amountSatang ?? owed` (`sale.ts:2196`)
- `status` = `'approved'` — the module constant `TENDER_APPROVED` at `sale.ts:1507`; `'recorded'`
  (the column default) is never written by anything
- `payload` jsonb, the only place non-cash facts could live today (`sale.ts:2212-2226`):
  `{ kind?, tenderedSatang?, changeSatang?, tillChangeSatang?, reference?, takenByAccountId, actionId? }`
  - `tillChangeSatang` only when the till's change figure disagrees with the platform's
    (`sale.ts:2220-2222`)

So: **cash only in practice, one free-text `method` string, one status value, and everything a
card or QR attempt needs has neither a column nor a jsonb convention.**

### The only reader

`outstandingOf(db, row)` — `sale.ts:1518-1527`. Sums `amount_satang` over attempts whose
`status === 'approved'` for that sale and returns `sale.gross_satang − taken`. This is the single
predicate finalisation turns on; it is called at `sale.ts:1714` (commit replay) and `sale.ts:2186`
(finalise).

### Split tenders: allowed by the table, forbidden by the path

The schema and `outstandingOf` already sum N rows per sale. `finaliseSale` does not:

- `sale.ts:2198-2203` refuses `amountSatang > owed` (400)
- after the insert, `sale.ts:2236-2242` throws `SALE_NOT_PAID` 409 when anything is still owed —
  **and that refusal rolls the just-inserted attempt back with the transaction.**
  Pinned by test `apps/api/test/sales.test.ts:545-561` ("refuses a part payment, and leaves
  neither a number nor a tender behind", asserting 0 payment_attempt rows at `:561`).

A split-tender slice therefore has to change the control flow, not the table's cardinality.

---

## 2 · The tender seam — `finaliseSale`, step by step

`apps/api/src/services/sale.ts:2137-2295`. Signature
`finaliseSale(tx: Tx, actor: ActorContext, saleId: string, input: FinaliseSaleInput = {}, now = new Date())`
→ `{ replay, replayed, pickupCode, sale: SaleView }`.

1. `select … for('update')` on the sale; 404 on operator mismatch — `sale.ts:2144-2145`
2. `actor.assertBranchAllowed(row.branchId)` — the branch scope check the route cannot make,
   because the branch is the sale's, not the URL's — `sale.ts:2146-2148`
3. load `fnb_item` lines + `recordedPickupCode` — `sale.ts:2149-2153`
4. **replay**: `row.status === 'finalised'` → return unchanged, no second number, no second
   tender — `sale.ts:2154-2156`
5. `voided|refunded` → `SALE_CLOSED` 409 — `sale.ts:2157-2159`
6. **pick-up-code gate** (S2-09b): food lines and no code → take `input.pickupCode`, else
   `PICKUP_CODE_REQUIRED` 409; stamps the code onto the lines *before* the status moves so
   `sale_line_freeze` does not bite — `sale.ts:2161-2184`, helpers `normalisePickupCode`
   (`sale.ts:642-652`), `pickupCodeRequired` (`sale.ts:671-677`), `recordedPickupCode`
   (`sale.ts:663-669`)
7. `owed = await outstandingOf(tx, row)` — `sale.ts:2186`
8. if `owed > 0`: build and insert the attempt — `sale.ts:2189-2234`
   - *calling the route is the confirmation the money was taken*; an empty body settles the
     balance in cash (`sale.ts:2190-2195`)
   - `amountSatang <= 0` → 400 (`:2197`); `> owed` → 400 (`:2198-2203`)
   - `changeFor(amount, tendered)` — `sale.ts:2104-2114`, refuses short cash with 400 rather than
     recording negative change
   - insert (`:2206-2227`), then `owed -= amountSatang`, and `taken` is kept for the audit row
9. `owed > 0` → `SALE_NOT_PAID` 409 with `details.outstandingSatang` — `sale.ts:2236-2242`
10. re-read the station; **no `code_prefix` → 400** — `sale.ts:2244-2249`
11. `allocateReceipt(tx, …)` — `sale.ts:1549-1611`, `SELECT … FOR UPDATE` on
    `pos.receipt_series`, bumps `next_seq`, formats `T1-000428`
12. `update sale set status='finalised', finalised_at, receipt_series/seq/number` —
    `sale.ts:2257-2267`
13. `audit.record` action `sale.finalise`, with `after.tender = { method, amountSatang,
    changeSatang }` — `sale.ts:2271-2292`
14. return; the route sets `x-oto-replay` on a replay — `routes/sales.ts:421`

### The sale never passes through `paid`

`SALE_STATUSES` (`sales.ts:106`) contains `'paid'` and the schema doc says it means "tenders cover
the total (`pos.payment_attempt`, S2-10a)" (`sales.ts:91`), but **nothing writes it**: the row goes
`tendering` → `finalised` in the one update at `sale.ts:2257-2265`. A tender slice that introduces
an intermediate `paid` state is introducing it for the first time.

### The ฿0 comp path writes NO tender at all

`commitSale` finalises in its own transaction when the cart owes nothing — `sale.ts:1815-1837`:
`owedAtCommit = priced.money.grossSatang` (`:1818`), `finalising = input.finalise === true &&
owedAtCommit === 0` (`:1819`), the pick-up-code gate again at `:1827-1829`, `allocateReceipt` at
`:1830-1837`, status written `'finalised'` at `:1869`, and a second audit row `sale.finalise` at
`sale.ts:2033-2052`. **No `payment_attempt` row is inserted on this path** — asserted at
`apps/api/test/sales.test.ts:772`. A caller that asks to finalise a cart that *does* owe money is
not refused: the sale is committed unfinalised and the answer carries `finalised:false` and
`outstandingSatang` (`sale.ts:2056-2065`, test `sales.test.ts:471-489`).

### Idempotency on the tender, such as it is

- **commit**: three nets — the till-minted `sale.id` replay (`sale.ts:1706-1725`), the explicit
  action-id pre-check → `SALE_ACTION_REPLAY` (`sale.ts:1767-1778`), and the
  `sale_action_unique` index caught at insert (`sale.ts:1880-1882`; index at `sales.ts:441-443`).
- **finalise**: the *only* net is `status === 'finalised'` → replay (`sale.ts:2154-2156`), plus the
  row-level `FOR UPDATE` serialising concurrent calls. `input.actionId` is recorded **only** inside
  `payload.actionId` (`sale.ts:2225`) and on the audit row (`sale.ts:2278`) — there is **no unique
  index on any attempt column**. The generic `Idempotency-Key` middleware
  (`apps/api/src/plugins/idempotency.ts:9`, `MUTATING`) covers the route like any other POST.
  → The moment partial tenders are allowed, `status === 'finalised'` stops being a sufficient
  replay guard and the slice must supply its own key on `payment_attempt`.

### `box_seq` / offline stamping — nothing exists yet

- `pos.sale.box_seq` (`sales.ts:282`), `source_event_id` (`sales.ts:288`), `clock_trust`
  (`sales.ts:278`), `origin` (`sales.ts:279`) all exist. `commitSale` hardcodes
  `origin: 'cloud'` (`sale.ts:1851`) and `salesChannel: 'till'` (`sale.ts:1853`), and **never sets
  `boxSeq` or `sourceEventId`** — they are absent from the insert values at `sale.ts:1839-1875`.
- Clock handling that does exist: `resolveOccurredAt` (`sale.ts:1631-1642`) with
  `CLOCK_TOLERANCE_MS = 60_000` (`sale.ts:1618`) → `clock_trust` `trusted|skewed|untrusted`.
- **There is no sale event in the box→cloud sync path.** `HANDLERS` in
  `apps/api/src/services/sync.ts:826` registers exactly six kinds: `member.created` (`:842`),
  `member.updated` (`:959`), `child.created` (`:1018`), `child.updated` (`:1088`),
  `visit.created` (`:1156`), `station.takeover` (`:1225`). No `sale.*`, no `payment.*`.
  The receipt-series high-water mark the box resumes from is already shipped in the cache bundle
  (`sync.ts:3531-3583`), which is the only sale-adjacent box plumbing that exists.
- `pos.payment_attempt` has no `box_seq` column at all. The ticket's "cash tenders stamped for
  S2-15a" and "box offline … appear on the Sale list after reconnect exactly once" therefore rest
  on plumbing **that does not exist at HEAD** and that this slice would be inventing.

---

## 3 · The route surface

`apps/api/src/routes/sales.ts`.

- **`POST /sales/:id/finalise`** — `routes/sales.ts:387-424`.
  `config: { permission: 'pos:sale:update' }` with **no branch target** (deliberate; the branch
  check is in the service). Body `FinaliseBody` = `Tender.extend({ tender, actionId, pickupCode })
  .nullish()` — `routes/sales.ts:263-268`; `Tender` itself at `routes/sales.ts:238-255`:
  `{ method?: string≤40, kind?: string≤20, amountSatang?, tenderedSatang?, changeSatang?,
  reference?: string≤120 }`. The handler reads the tender **nested first, flat as fallback**
  (`routes/sales.ts:404-411`) and takes the action id from body or `x-oto-action-id`
  (`:412-417`). Runs under `withTx(app.db, opCtx(req), 'sale.finalise', …)` (`:413`).
  `.nullish()` is load-bearing: a POST with no payload arrives as `null` and must still settle in
  cash (`routes/sales.ts:257-262`).
- **`POST /sales`** — `routes/sales.ts:333-379`. `CommitBody` (`:224-235`) already carries a
  vestigial `paymentMethod: z.string().max(40).nullish()` (`routes/sales.ts:232`) commented
  *"A tender token. Recording the money itself is S2-10a"* — **it is parsed and then dropped**;
  `CommitSaleInput` has no such field (`sale.ts:257-280`).
- **`GET /sales/:id`** — `routes/sales.ts:494-511` → `getSaleDetail` (`sale.ts:2433-2518`).
  Returns `sale`, `pickupCode`, `taxBreakdown`, `taxConfig`, `lines[]`, `discounts[]`.
  **No attempts are joined**, which is what the ticket's "Attempts list on the Sale detail" needs
  and what `apps/pos/src/components/history/SaleDetail.tsx:36-42` documents as the gap.
- **`GET /sales`** — `routes/sales.ts:426-492` → `listSales` (`sale.ts:2343-2431`);
  `SaleListItem` (`sale.ts:2335-2341`) carries no tender information either.
- `SaleView` (`sale.ts:1427-1459`) / `viewOf` (`sale.ts:1461-1495`) — the shape every read
  answers with. Adding a tender block to a read means touching `viewOf` or wrapping it.

### Two pinned assertions a new `/sales/*` route will break

- `apps/api/test/sales.test.ts:1310-1318` — `Object.keys(paths).filter(p => p.startsWith('/sales'))`
  must equal exactly `['/sales/quote','/sales/','/sales/{id}/finalise','/sales/{id}','/sales/tier-claims']`.
- `apps/api/test/sales.test.ts:1320-1353` — `expect(guards).toEqual([…])` pins the six
  `method url permission target` strings, including
  `'POST /sales/:id/finalise pos:sale:update no-target'` (`:1346`).

Both must be updated deliberately if the slice adds `/sales/:id/tenders` or similar.

---

## 4 · Migration number

`packages/db/migrations/meta/_journal.json` — last entry is `idx: 18`, `tag:
"0018_booking_redemption"`, `version "7"`. The directory's last file is
`packages/db/migrations/0018_booking_redemption.sql`. The working tree adds none.
**The next migration a tender schema slice writes is `0019_…`.**

---

## 5 · What a tender slice MUST touch

**Schema / migration**
- `packages/db/src/schema/sales.ts:878-890` — replace the `payment_attempt` placeholder
  (method enum, status enum, provider, device, refs, amounts, cash tendered/change, expiry,
  offline flag, `paid_at`, `staff_confirmed_by`, tenancy columns, `box_seq`, an idempotency key,
  indexes, checks). Its doc block (`sales.ts:868-877`) is the note to rewrite.
- `packages/db/migrations/0019_*.sql` + `meta/_journal.json` + a `meta/0019_snapshot.json`.
  A status/method check constraint and a unique key are the two things nothing has today.
- The ticket's `terminal_counter (device_id, next_ref)` is box-local: the box-local schema is
  `packages/db/src/schema/edge.ts`, and the nearest existing precedent is `edge.box_counter`
  (`edge.ts:368-383`, composite PK `(box_id, scope, counter_key, business_date)`) — a rolling
  per-device ref either extends that pattern or gets its own `edge.*` table beside it.
- `packages/db/src/schema/index.ts` must export anything new (it re-exports the schema files).

**Service**
- `apps/api/src/services/sale.ts:1497-1527` — `TENDER_APPROVED` and `outstandingOf`: the status
  vocabulary widens (approved / declined / cancelled / unknown / inquiring / …), so "what counts
  as taken" has to become a set, not a string equality.
- `apps/api/src/services/sale.ts:2068-2114` — `TenderInput`, `FinaliseSaleInput`, `changeFor`.
- `apps/api/src/services/sale.ts:2137-2295` — `finaliseSale`: steps 7-9 and 13 above. Note the
  ordering constraints already encoded there: pick-up code before the tender, tender before the
  receipt number, all inside one transaction.
- `apps/api/src/services/sale.ts:1815-1837` + `2033-2052` — the ฿0-comp branch in `commitSale`:
  the one path that closes a sale with no attempt row. If comps must appear in the Attempts list,
  this is where a zero-amount `comp` attempt would be written.
- `apps/api/src/services/sale.ts:2433-2518` (`getSaleDetail`) and `2343-2431` (`listSales`) /
  `SaleView`+`viewOf` (`1427-1495`) — to surface attempts on the Sale detail.
- `apps/api/src/services/demo-reset.ts:113-115` deletes `payment_attempt` in FK-safe order and
  `demo-reset.ts:67-79` lists `'payment_attempt'` in `FACT_ENTITY_TYPES`; any new child table
  (attempt events, terminal counters) has to be added there or the staging reset breaks.
- `apps/api/src/services/ops.ts` / `packages/db/src/schema/ops.ts:92` (`ops_run`) —
  `OPS_KINDS` already includes `device` and `adapter` (`ops.ts:39-45`), and `ops_run.name`'s own
  doc already uses `adapter:2c2p.do_payment` as its example, so the adapter/ops_run requirement
  needs no schema change, only callers.

**Route**
- `apps/api/src/routes/sales.ts:238-268` (`Tender`, `FinaliseBody`) and `:387-424` (the handler);
  plus whatever new routes the EDC/QR/webhook flows need — and then
  `apps/api/test/sales.test.ts:1310-1318` and `:1320-1353`.
- `routes/sales.ts:232` — decide whether the dangling `paymentMethod` on the commit body is wired
  or deleted.
- Permissions already exist and are **unused anywhere in `apps/api/src`** (verified by grep):
  `pos:payment:read|capture|confirm|void|settle` — `packages/shared/src/permissions.ts:139-144`,
  granted in the role bundles at `permissions.ts:264, 279-281, 344`. The tender routes are the
  first callers.

**Station routing / devices (already modelled, nothing reads it for tenders)**
- `core.station.payment_routing` jsonb — `packages/db/src/schema/fleet.ts:352-360`, explicitly
  "the set of tenders is still growing (S2-10a)". Its API schema is still the open
  `RoutingSchema = z.record(z.string(), z.unknown())` — `apps/api/src/routes/fleet.ts:113`;
  read/write at `apps/api/src/services/fleet.ts:1028, 1094` and shipped to the box at
  `apps/api/src/services/box.ts:936`.
- `STATION_DEVICE_ROLES` already has `card_terminal`, `qr_terminal`, `cash_drawer` —
  `fleet.ts:597-609`, one device per role per station (`station_device_role_unique`).

**POS**
- `apps/pos/src/api/sales.ts:271-282` (`SaleTenderPayload`, whose doc at `:264-270` says S2-10a
  fills these in), `:293-296` (`SaleFinaliseBody`, sent nested **and** flat), `:1321-1334`
  (`finaliseSale`). Caller: `apps/pos/src/lib/saleWriter.ts`.
- `apps/pos/src/components/history/SaleDetail.tsx:36-42` — the Attempts list's intended home.
- `apps/pos/src/components/admin/payments/PaymentMethodsSection.tsx` — the prototype panel the
  ticket says to wire; today it reads `useCatalogStore()` and `countTransactionsUsingPaymentMethod`
  from `@/mockApi` (`:1-8`), i.e. pure mock, no platform table behind it.

**Seed**
- `seed:demo-day` "extended with sales across all tenders on two TIDs" — the demo-day seed lives
  under `packages/db/src/seed/`.

---

## 6 · What a tender slice must NOT touch

The pricing, claim and item-line paths landed by SCRUM-307 / 311 / 204. All of these are upstream
of the tender and none of them has a reason to move:

**Pricing (S2-09a, SCRUM-203/204)**
- `priceCart` — `sale.ts:915-1216` (the whole function, including the two
  `SALE_LINE_PRICE_MISMATCH` refusals at `:1073-1087` and `:1100-1110`)
- `resolvePricingScope` — `sale.ts:336-385`
- `resolveTier` — `sale.ts:391-410` (rule 2: the tier is the member's, never the body's)
- `loadCatalogue` — `sale.ts:549-617`, and `UUID` at `sale.ts:547`
- `buildPricedLines` — `sale.ts:1235-1365` (the apportionment)
- `lineKindOf` — `sale.ts:620-629`
- `quoteSale` — `sale.ts:1374-1422` (and the quote route, `routes/sales.ts:316-331`)
- the `SALE_TOTAL_MISMATCH` check in `commitSale` — `sale.ts:1748-1758`
- `PricedCart` / `PricedLine` / `SaleLinePayload` shapes — `sale.ts:425-538`

**Tier claim (SCRUM-307 / 311)**
- `apps/api/src/services/sale-tier.ts` in full — `resolveTierClaim`, `spendTierClaim`,
  `TierClaimRefusal` (imported at `sale.ts:60`)
- the refusal in `commitSale` — `sale.ts:1780-1798`
- the conditional spend inside the sale transaction — `sale.ts:1895-1907`
- `pos.sale_tier_claim` — `sales.ts:532-588`; `sale.tier_claim_id` — `sales.ts:343-345`;
  `sale_tier_claim_unique` — `sales.ts:451-453`
- `POST /sales/tier-claims` and the `tierClaimActionId` pointer on the cart body —
  `routes/sales.ts:191`
- the claim-unspend dance in `demo-reset.ts` (documented at `demo-reset.ts:116-125`)

**F&B / shop item lines (S2-09b, SCRUM-204)**
- `resolveItemLines` — `sale.ts:746-907`, and `ITEM_LINE_PACKAGE_KEY` (`sale.ts:689`),
  `CartItemLineInput` (`sale.ts:154-173`)
- the modifier/prep-station helpers it calls from `apps/api/src/services/menu.ts`
  (`assertModifierSelection`, `effectiveModifierGroups`, `resolveItemPrepStations`,
  `resolveItemTaxCategories` — imported at `sale.ts:53-59`)
- the item-line reconciliation loop — `sale.ts:1095-1112`
- `PICKUP_CODE` / `normalisePickupCode` / `recordedPickupCode` / `pickupCodeRequired` —
  `sale.ts:639-677`. The pick-up-code **gate** at `sale.ts:2175-2184` is in the finalise path and
  the slice has to preserve its ordering (before the tender, before the status moves) — but it
  should not change the rule.
- `pos.sale_line` and its kinds — `sales.ts:612-756`; `pos.sale_discount` — `sales.ts:774-866`
- the line/discount insert loops in `commitSale` — `sale.ts:1909-2010`

**Ledger invariants that constrain the slice rather than being edited by it**
- `pos.sale_freeze` — `0014_sales_ledger.sql:386-415`. Once a sale is
  `finalised|voided|refunded`, the **only** mutable columns are `status`, `voided_at`,
  `voided_by_account_id`, `void_reason`, `refunded_at`, `refunded_satang`, `updated_at`
  (`0014:388-389`). A tender slice cannot add a column to `pos.sale` and then write it after
  finalisation — a late webhook that "marks the sale paid" must therefore either arrive before
  finalisation or live entirely on the attempt row.
- `pos.sale_child_freeze` on `sale_line` / `sale_discount` — `0014:419-436`.
- `allocateReceipt` — `sale.ts:1549-1611`, and `sale_receipt_unique` /
  `sale_receipt_number_unique` (`sales.ts:434-439`). A tender slice must keep numbering inside the
  same transaction as the status move.
- `resolveOccurredAt` / `CLOCK_TOLERANCE_MS` — `sale.ts:1618-1642`.
- `violates()` constraint sniffing — `sale.ts:1645-1652`.

---

## 7 · How a sale is finalised in the tests

`apps/api/test/sales.test.ts` — real routes, real reception session (`app.inject` + cookie), rows
asserted in Postgres. Fixtures documented at `sales.test.ts:28-47`; helpers `commit()` at
`:104-112`, `b()` (baht→satang) at `:64`, `line()` at `:76-81`.

The tender suite is **`describe('pay commits the sale, the tender finalises it')` at
`sales.test.ts:456-657`**, with the local helper

```ts
async function finalise(saleId, payload?) {          // sales.test.ts:465-472
  return ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`,
    headers: { cookie }, ...(payload ? { payload } : {}) });
}
```

and `paidCart()` at `:457-463` (which still sends `finalise: true`, "verbatim what the till has
been sending"). The cases, each one a constraint on the slice:

| test | line | what it pins |
|---|---|---|
| commit writes an open sale, no receipt number, no attempt | `:471-489` | `outstandingSatang === grossSatang`; 0 attempts at `:488` |
| cash at Confirm: attempt + receipt | `:491-525` | `method 'cash'`, `status 'approved'`, `amount === owed`, `payload.tenderedSatang/changeSatang`, receipt `^T1-\d{6}$`, one `sale.finalise` audit row whose `after.tender` matches |
| empty body settles in cash | `:527-542` | default method `cash`, `payload` has **no** `tenderedSatang` |
| part payment refused, nothing left behind | `:544-561` | `SALE_NOT_PAID` 409 + `details.outstandingSatang`; sale still `tendering`; **0 attempts** |
| short cash refused | `:563-575` | 400, sale still `tendering` |
| second Confirm replays | `:577-587` | same receipt number, `x-oto-replay: true`, still exactly **1** attempt |
| the till's real body, nested **and** flat | `:589-616` | `{ ...tender, actionId, tender }` both readings agree; no `tillChangeSatang` when they do |
| till/platform change disagreement | `:618-635` | `payload.changeSatang` is the platform's, `tillChangeSatang` the till's |
| tender nested under `tender` | `:637-648` | same result |

Other touchpoints: `describe('a ฿0 comp finalises like any other sale')` at `:345-445` (comp
finalises at commit; `:418-443` "a second finalise takes no second number"); the branch-scope
refusal on finalise at `:745-776`; `sales.test.ts:900-940` finalises a sale to make it readable;
`sales.test.ts:1253` and `apps/api/test/catalog.test.ts:581` delete `payment_attempt` rows in
fixture cleanup (any new tender table needs the same).

Static conformance that a new write route must satisfy:
`apps/api/test/route-write-conformance.test.ts:16-38` — a mutating route writes in one
transaction, records its audit with that same transaction handle, and takes an idempotency key;
its lists are exact in both directions, so a newly-conforming route also fails until its entry is
removed.
