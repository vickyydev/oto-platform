# Stock — the build plan for S2-14b

_Written 2026-10-02 from the requirement (SPRINT_2_PLAN §S2-14b, lines
2220-2274, coverage row 281, open decisions 8 and 27), the rules R-08,
R-71..R-77 and conflict C12 (POS_RULES_RECONCILIATION), and two read-only
studies: the prototype's complete stock domain and the platform's landed
seams. The prototype's code is the binding behaviour (CLAUDE.md). Where the
sprint plan contradicts it, this plan follows the prototype and raises the
conflict for the owner (section 4). S2-14a is Deployed; its ledger, offline
cap and anomaly patterns are the model here._

## 1. Stock, in the park's terms

The park keeps merchandise, grip socks and food stock in a few places: the
store room (bulk), the back of house, and the counter shelf, which is the
one sell point. A sale takes from the counter shelf first and then from the
other places, so a sale never fails because stock sits in the wrong room.
The till never offers what is not there: an out-of-stock cap cannot be
added, four small socks cannot be sold when three are left, and the strip
along the top of every station says what is low or out. Staff move stock
between places, receive deliveries against purchase orders, and count
stock. A count that differs from the record adjusts it, and a big
difference is flagged and audited. A refund puts stock back. When the
internet is down, the counter's box still knows what it can sell; an
oversell discovered on reconnect is recorded honestly and raised on
Failures. The office sees what moved, what was lost, and what the shelves
are worth.

## 2. The architecture

### 2.1 Data model (migration 0048, round 1)

The landed placeholders (`pos.stock_item`, `pos.stock_location`,
`pos.stock_level`, all empty) are reshaped forward-only:

- `pos.stock_item` becomes branch-scoped. It gets a name, category, active
  flag, a link to the sellable it stocks (product + size, or add-on +
  size), unit cost in satang, and reorder settings (reorder point, reorder
  quantity, lead time, supplier name and contact as free text, which is
  prototype parity). One row per stocked SIZE: the prototype's
  InventoryVariant is a row, and `productVariantRef` maps it to the
  landed product sizes.
- `pos.stock_unit` (NEW): pack conversions per item, purchase unit →
  stocking unit → selling unit as an integer factor of eaches. Quantities
  are always stored as whole eaches; packs exist only at entry and display
  (`lib/stockUnits.ts`). A fractional pack that does not land on a whole
  each is refused, not rounded.
- `pos.stock_location` gains operator_id, type (bulk / back_of_house /
  rotation), sell_point (exactly one active rotation per branch, enforced
  by a partial unique index), active, archived_at.
- `pos.stock_level` gets a unique (location, item) index and is a
  PROJECTION of the movements, only ever written inside the transaction
  that writes its movement. A CHECK `quantity >= 0` applies to every
  online movement kind; offline replay is the one path that may record a
  shortfall (section 2.5).
- `pos.stock_movement` (NEW, append-only): the ledger. Each row has a kind
  (sale, refund, receive, transfer_out, transfer_in, adjust, count,
  offline_sale), signed quantity in eaches, item, location, the source
  (sale_line id, refund id, PO line, transfer, count line), an action_id
  unique per operator (the idempotency and double-count defence),
  business_date, actor, station and box ids, and an offline flag. The
  level always equals the sum of its movements; a test asserts it after
  every flow.
- `pos.stock_take` + `pos.stock_take_line` (NEW): expected, counted,
  difference, flagged (|difference| > 3, the prototype's threshold).
- `pos.purchase_order` + `pos.purchase_order_line` (NEW): the prototype's
  state machine to_order → ordered → received, with the receive location.
- `analytics.fact_stock_daily` (NEW): per branch, item and date: opening,
  sold, refunded, received, transferred, adjusted, counted, closing, value.

### 2.2 Sales take stock (round 1)

- **Guard at commit:** the till cart is checked against the sell point plus
  the other locations of this branch, per size. The check honours
  `variantBreakdown` (the prototype's guard ignored it, which is fixed here
  and not ported). Refusals are in the counter's words: "Only 3 Grip Socks
  S left".
- **Decrement at finalise, which never refuses:** a card can be approved
  long after commit, so finalise writes the movements with an atomic
  conditional update in a fixed lock order (item id order, the
  `allocateReceipt` pattern). It takes from the sell point first and
  cascades in the transfer-source order: back of house, then bulk. The
  prototype's two orders disagreed; the transfer order wins and is
  recorded. A race that loses the last unit between commit and finalise
  records the sale and a stock_shortfall attention, never a refused paid
  sale.
- Both finalise points (`commitSale` ฿0 close and `finaliseSale`) carry
  the hook, so till, booking redemption, gateway and offline replays are
  all covered.
- Add-on sizes (`variantBreakdown`) are carried onto the sale-line payload
  online and offline; today they survive only in the label.
- F&B sizes are validated against the catalogue like merch, instead of
  free text.
- Refunds apply the landed `restock` decisions (refunds.ts:245-263,
  shared/refund.ts:235-262) as refund movements. They go back to the
  location the units were taken from, not always the sell point (the
  prototype's limitation is corrected). Refund rows written before 0048
  are not replayed: stock starts from a clean opening count (OD-S5).
- The catalogue link becomes real: products and add-ons carry their stock
  item, the till's MerchGrid, MenuGrid and AddOnsGrid read levels from the
  platform, and an F&B item is disabled only for its out-of-stock size,
  not the whole item (prototype bug, fixed).

### 2.3 The stock module live (round 2)

The existing mobile Stock module and the admin Inventory panels (ported
unchanged from the prototype, mock today) move to platform routes with
their exact look:
- Transfers clamp to what the source holds and log what moved.
- Receive works ad hoc (reason required) or against a PO line (clamped to
  outstanding; the PO closes when every line is received).
- POs: one open to_order per supplier and branch, repeat lines merge, lines
  are editable only while to_order.
- Stock take: auto-adjust with a flag above 3 and audit (OD-S1).
- Admin items and locations with the prototype's validations; the sell
  point cannot be retired.
- Low-stock attention: deduped per item and branch, carries the rule that
  produced it ("Below par at Counter" or "≤ reorder point"), and is
  suppressed while an open PO covers it (requirement).
- The station header's "N out · N low" strip reads the platform, not the
  seed.

### 2.4 Offline (round 3)

A new volatile `stock` cache scope (the S2-14a wallets pattern, kept OUT
of the catalogue scope so its version hash does not churn) ships level
snapshots per sell point. The box guards the cart against its snapshot
minus its own sales since the snapshot, and writes its decrements ahead
with the sale in one store transaction. On sync the platform replays them
as offline_sale movements, once (action-keyed). A replay that takes more
than the platform level records the shortfall (the level may go below
zero ONLY here) and raises a `stock_oversold` anomaly with one critical
alert on Failures, the wallet_overdraft pattern. The anomaly kind needs a
migration (CHECK + both SYNC lists).

### 2.5 Reports, trend and closing (round 4)

Usage, Shrinkage (counts and adjustments), Purchases and Value
(unit_cost × on hand, with "no cost set" flagged) are built from the
ledger, replacing the prototype's mocked Usage and Shrinkage. Unit cost is
frozen onto the sale line from round 1 so cost of goods is reportable. The
consumption-trend reorder rule takes over from the static reorder point
once 30 days of movements exist (OD-27; the attention shows which rule
fired). A closing audit walks receive → sale → refund → transfer → count →
offline sale → sync and checks the level equals the sum of movements
throughout; then the staging walkthrough with evidence.

### 2.6 Not this story

Recipes and bills of materials (no prototype logic). Booth prize stock
(OD-S3). Supplier records beyond free text (the prototype's choice).
Party F&B decrements (the prototype has none, and the party story owns
it).

## 3. The rounds

| Round | Scope | Lands |
|---|---|---|
| 1 | Migration 0048, the ledger and projection, sale guard and decrement, refund restock, sizes carried, the catalogue link and the till's grids on real levels | first |
| 2 | Stock module and admin live: transfers, receive, POs, stock take, locations, attention with rule and suppression, the header strip | after 1, in parallel with 3 |
| 3 | Offline: the stock scope, box guard and decrement, sync-once, the oversell anomaly on Failures | after 1, in parallel with 2 |
| 4 | Reports from the ledger, the trend rule, the closing audit, the staging walkthrough | last |

File fences for rounds 2 and 3: round 2 owns the stock routes and service
(read side), apps/pos stock and admin screens, and the header; round 3
owns packages/box-agent, sync.ts, the bridge schemas and apps/console.
Neither touches sale.ts after round 1.

## 4. Open decisions (the recommended answer holds unless the owner objects)

**OD-S1: Stock-take approval.** The sprint plan requires `pos:stock:approve`
above a variance of 3 (STOCK_APPROVAL_REQUIRED; its own open decision 8
calls this "unsourced"). The prototype (StockTakeFlow.tsx:102) and rules
R-74 and R-08 auto-adjust with no approval, flag the difference and audit
it. Recommended: the prototype's rule, flag + audit, no gate. A gate can
be added later as a branch setting if wanted.

**OD-S2: Seed values.** The sprint plan's example seed (small socks 3,
medium 20, "Cap" out of stock, one threshold of 5) contradicts the
prototype's seed (socks S 25 / M 40 / L 20, Cap 25, Mascot Keyring out,
thresholds per size). Recommended: the prototype's seed. The acceptance
scenarios are re-expressed on it (for example "only N Grip Socks S left").

**OD-S3: Booth prizes.** The sprint plan lists inventory-linked prizes
both in and out of scope, and the schema defers them to S2-15a.
Recommended: out of this story; the prize stock link lands with S2-15a.

**OD-S4: Who may move stock.** R-76 says all staff do stock operations
and managers do setup. The landed permission seed gives reception count
only. Recommended: R-76 (reception gets transfer and receive; purchase
orders and setup stay manager).

**OD-S5: The opening position.** Refunds before 0048 recorded restock
flags that were never applied, and no movement history exists.
Recommended: each branch starts from a counted opening (a stock take that
writes the first movements); older refunds are not replayed.

**OD-27 (from the sprint plan):** the static reorder point until 30 days
of history exist, then the trend rule. Accepted as written.

## 5. Known hazards (from the seams study; each gets a test)

The last unit between two tills (the guard at commit, plus a decrement at
finalise that never refuses, records a shortfall and locks in a fixed
order). Offline oversell (record + anomaly, never quarantine a paid sale).
Refund restock replay (action-keyed, once). Pack rounding (whole eaches
only; a fractional entry is refused). Catalogue hash churn (stock never
rides the catalogue scope). The duplicated SYNC_ANOMALY_KINDS lists
(db/schema/sync.ts and box-agent contract.ts) move together.
