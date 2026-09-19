<!-- Read-only analysis of the imported Replit export, 2026-09-19. File references are relative to the export under imports/ (local only, not in git). No secret values are recorded here - variable names and locations only. -->

> **OTO Radar — Papaya (Chalong) sales pipeline** - intake analysis, 2026-09-19. Markers: [V] verified by reading code, [I] inferred, [U] unknown.

I read all of `server/papaya.ts` (2,627 lines), the three Papaya test files, `posStaleness.ts`, the heatmap spec, the listed memory notes, and every call site in `routes.ts` and `index.ts`. I also read the client merge code, `sourceRegistry.ts`, `marketingSummary.ts` and enough of `funtopia.ts` to make the comparison. Git history was used read-only to recover the pagination bug and the revenue-definition history; env files were inspected for variable names only. Nothing was run or modified, and no database was queried, so every data-dependent fact is listed under unknowns.

Base path: `imports/oto-radar`. Short names below:
- `papaya.ts` = `<base>/server/papaya.ts`
- `routes.ts` = `<base>/server/routes.ts`
- `posStaleness.ts` = `<base>/server/posStaleness.ts`
- `funtopia.ts` = `<base>/server/funtopia.ts`
- `sourceRegistry.ts` = `<base>/server/sourceRegistry.ts`
- `marketingSummary.ts` = `<base>/server/marketingSummary.ts`
- `dashboard.tsx` = `<base>/client/src/pages/funtopia-dashboard.tsx`
- `activityHeatmap.ts` = `<base>/client/src/lib/activityHeatmap.ts`

Tags used: [V] verified by reading code, [G] from git history or commit messages, [I] inferred.

---

## 1. Papaya API

**Base URL** [V]: `https://api.papaya.co.th/api/v1`, hardcoded at `papaya.ts:8`.

**Authentication** [V]:
- A static bearer token per outlet, sent as `Authorization: Bearer <token>` (`papaya.ts:163`).
- There is no login, refresh, store id or merchant id. The token itself scopes the outlet.
- Two tokens map to two "terminals", `reception` (the park) and `restaurant` (the cafe), selected by ternary at `papaya.ts:1535, 1635, 1725, 2354`.

**Endpoints** [V]: exactly one is called. A grep for `PAPAYA_API_URL` finds only lines 8 and 154. No menu, product, category or customer endpoint is used.

| Method | Path | Params | Response envelope |
|---|---|---|---|
| GET | `/orders` | `from`, `to`, each URL-encoded as `YYYY-MM-DDTHH:mm:ss+07:00` (`papaya.ts:154`). Originally also `next=<cursor>` [G]. | `{ orders: [...], next?: <cursor> }`. `orders` is read at `papaya.ts:169`; `next` is known only from history (commit `de1d07b0`). |

**Order fields the code reads** [V]:

| Level | Fields | Where read |
|---|---|---|
| Order, core | `id` or `orderId`; `status` (only `"complete"` counts); `orderDate` (ISO UTC); `total`, `billTotal`, `discountTotal`; `channelName`; `orderNumber`, `receiptNumber` | `papaya.ts:172, 415, 447-450, 475, 1238-1245` |
| Order, invoice feature only | `number`, `created`, `createdAt`, `completedAt`, `channelType`, `serviceCharge`, `totalBeforeTax`, `tax`, `tipTotal`, `isTaxInclusive`, `posNo` / `posNumber` / `deviceName` | `papaya.ts:2563-2583, 2329, 2378` |
| `items[]` | `name`, `quantity`, `itemTotal`, `menuItemCategoryId`, `status`, `customerName` | `papaya.ts:482-503, 1264-1268, 2017-2020, 2563` |
| `payments[]` | `offlineMethod` or `method`, `amount`, `status` (`cancelled`, `succeeded`), `paid` | `papaya.ts:52-58, 469-473, 2372` |
| `appliedDiscounts[]` | `name`, `total` | `papaya.ts:457-467` |

The repeated fallbacks (`o.number || o.orderNumber`, `o.posNo || o.posNumber || o.deviceName`) show the developer was guessing field names without API documentation. The stored `raw_json` is the only ground truth for the payload.

**Pagination bug** [G, commit `f73841b3`, 2026-04-02, plus the `replit.md` diff in that commit]:
- Papaya's cursor pagination returned the same page indefinitely, and about 25% of daily orders were being missed.
- The fix was to drop the cursor entirely. `_maxPages` is a dead parameter (`papaya.ts:209`).
- `fetchPapayaOrders` (`papaya.ts:205-237`):
  - Ranges of 2 hours or less are fetched in a single call (`:218-220`).
  - Longer ranges are cut into 2-hour slices (`:222`) with boundaries formatted by `toBangkokISO` (`:194-203`), fetched sequentially with a 220 ms pause (`:233`).
  - One day is 12 requests per terminal.
- `fetchPapayaOrdersSlice` (`papaya.ts:148-192`) dedupes across slices with a shared `seenIds` set on `id || orderId` (`:171-176`). Adjacent slices share a boundary instant, so the dedupe covers inclusive or exclusive bounds.
- **Residual risk [I]:** the page size is unknown. Any 2-hour window busier than one page silently loses orders. Commit `f73841b3` reports about 25% of a day's orders were missing under cursor pagination, so one page held roughly 75% of a day's orders.

**Retries and timeouts** [V]:
- Each request has a 45 s abort timeout and at most 2 attempts, and the retry applies only to timeouts, with a 1 s pause (`papaya.ts:155-186`).
- After the final timeout the slice returns `[]` silently (`:186`), so a timed-out slice looks like an empty slice.
- Any HTTP error, including the 429 rate limit documented in `<base>/.agents/memory/pos-backfill-quirks.md`, is thrown immediately with no retry or backoff (`:167, 188`).
- Because a day's orders are stored only after all 12 slices return, one 429 discards the whole day.

**Timezone** [V]:
- `+07:00` is hardcoded in request windows.
- Hour buckets use `(getUTCHours() + 7) % 24` (`papaya.ts:608`).
- "Today" is `Date.now() + 7h` (`papaya.ts:1538`).
- Several paths silently require the Node process to run in UTC. These include the pg DATE to `toISOString()` conversion at `papaya.ts:1344, 1369` and the day loop at `:1639-1643`. If this code is run on a machine set to Bangkok time, dates shift by one day.

---

## 2. Sync

| Trigger | What it does | Reference |
|---|---|---|
| Automatic, 5 s after boot and every 5 minutes, in every running process | Today only, both terminals, run in parallel alongside the Pisell sync. The DB is warmed with 3 retries first. | `routes.ts:102-141` |
| `POST /api/sync-today` with optional `{branch}` | `chalong` means both terminals, today only | `routes.ts:76-100` |
| `POST /api/papaya/sync` with `{from, to, terminal?, mode}` | Asynchronous. Terminals run sequentially, days sequentially, 300 ms between days. | `routes.ts:490-540`, `papaya.ts:1628-1714` |
| UI "Quick Sync" | Yesterday to today, mode `quick` | `dashboard.tsx:12377-12389` |
| UI "Full Sync" | Last 90 days or a custom range, mode `full` | same, and `:14955-14995` |
| `POST /api/papaya/resync-date` | Destructive single-day re-fetch (see section 9) | `routes.ts:1143-1155`, `papaya.ts:1716-1799` |
| `POST /api/papaya/process` or `/regenerate-summaries` | Rebuilds summaries from stored raw orders with no API call. Also covers days that only have an override. | `papaya.ts:1286-1380` |
| Lazy rebuild on read | Any cached summary whose `formulaVersion` is not `v21` is rebuilt from raw | `papaya.ts:1495-1523` |
| Dev to production push | Copies the three Papaya tables to the published app over HTTP | `routes.ts:1873-2060` writes through `/api/funtopia/import-data` (`:1522-1727`) |

**Guards** [V]:
- `POST /api/papaya/sync` has an in-memory single-flight flag (`routes.ts:487, 496`). It is per process and does not cover the auto-sync or `resync-date`.
- There is no cross-process lock, unlike the Floresta sync.
- Drop protection skips caching when the new order count is below 97% of the cached count. It applies only in `full` mode or for dates that are not today or yesterday (`papaya.ts:1675-1687`). `syncPapayaToday` only logs a warning (`:1561-1568`).
- Summaries are always built from stored raw orders, which are a superset upsert (`papaya.ts:1546-1547`). A partial fetch therefore cannot shrink a day that already has data.
- Locked months protect Floresta only. They do not apply to Papaya.

**Catch-up and staleness** [V]:
- There is no automatic catch-up for yesterday and no stale-day detector. Floresta has both (`funtopia.ts:2372-2416`).
- Staleness alerts fire when today's newest order is more than 120 minutes old. They apply only between 12:00 and 20:00 Bangkok time, and both parks are hardcoded as open 10:00 to 20:00 (`posStaleness.ts:18, 30-33, 86-102`).
- The Chalong staleness query takes the latest `order_date` across both terminals and all statuses (`posStaleness.ts:67-72`).
- Sync health is weak. `orders_expected` is the completed count of what was just fetched, so it cannot detect a missing slice (`papaya.ts:1552-1559, 1658-1666`). Health rows are pruned after 90 days (`papaya.ts:1094`).

---

## 3. Storage

All five Papaya tables are created by raw SQL, lazily, in `initPapayaCache` (`papaya.ts:1171-1178`). None of them is defined in Drizzle. The comment at `papaya.ts:857-858` that says otherwise is stale. The definitions match `<base>/database-schema.sql:352-405`.

| Table | Key | Columns | Notes |
|---|---|---|---|
| `papaya_orders` (`papaya.ts:804-821`) | PK `(id, terminal)` | `status`, `order_date` TIMESTAMPTZ, `total`, `bill_total`, `discount_total`, `channel_name`, `order_number`, `receipt_number`, `payments` JSONB, `applied_discounts` JSONB, `raw_json` JSONB (the full payload), `synced_at` | Upserted on conflict (`:1219-1250`). A zero `billTotal` or `discountTotal` is stored as NULL because of `|| null` (`:1241-1242`). Indexed on `order_date` and `terminal`. |
| `papaya_order_items` (`:823-834`) | SERIAL `id`, no unique key | `papaya_order_id`, `terminal`, `name`, `quantity` INT, `item_total`, `menu_item_category_id`, `status` | Write-only. Nothing in the app reads it, because all analytics use `raw_json.items`. Rows are replaced with a non-transactional delete-then-insert (`:1252-1271`), so duplicates and orphans are possible. |
| `papaya_daily_cache` (`:793-799`) | PK `date` TEXT, formatted `<terminal>:<YYYY-MM-DD>` | `terminal`, `synced_at`, `summary_json` (a `PapayaDailySummary`) | Also holds a `__meta__` row with `terminal='meta'` and the last sync timestamps (`:2413-2435`). |
| `papaya_birthday_overrides` (`:847-856`) | PK `(order_date DATE, terminal)` | `party_total`, `fnb_total`, `note`, `created_at` | 16 rows for March 2026 are re-seeded on every boot (`:871-898`). No route writes to this table. |
| `papaya_sync_health` (`:1037-1048`) | SERIAL | `date`, `terminal` (may be `'combined'`), `status`, `orders_expected`, `orders_received`, `error_message`, `warnings` | Rolling 90 days. |

Chalong data also lives in three shared tables.
- `funtopia_branch_settings` (`funtopia.ts:906-913`) uses these branch keys:
  - `chalong`
  - `all`
  - the pseudo-branch `papaya_invoice`
- `pace_forecast_snapshots` stores rows with `branch` set to `chalong` or `all` (`routes.ts:2483-2493`).
- The three Papaya table definitions are duplicated inside the import route (`routes.ts:1550-1599`).

---

## 4. Compilation into the dashboard shape

`buildPapayaSummary` (`papaya.ts:408-789`) builds one summary per terminal per Bangkok day.

**Revenue** [V, history G]:
- Revenue is `order.total`, falling back to `billTotal`, summed over orders with `status === "complete"` (`papaya.ts:450`).
- The definition was changed five times on 2 to 3 April 2026: `billTotal`, then `billTotal - discount`, then `min(billTotal, payments)`, then `total` with adjustments, then a cafe-specific formula, and finally `total`.
- Commit `c34542aa` states that the restaurant's `total` includes an 8% service charge and that reception has none. The next commit, `dd757ad1`, reverted to `total` anyway.
- The result is that Chalong revenue is gross of 7% VAT and probably includes the restaurant service charge.
- Revenue is recognised at order completion and is not based on payments. Deposits on incomplete orders are invisible.

**Categories** [V]:
- Reception items are classified at `papaya.ts:26-50`, first matching rule wins:
  1. Name contains "birthday", "bday", "party" or "deposit": Events / Birthdays.
  2. Whole word "camp": Camp.
  3. `menuItemCategoryId` is one of four hardcoded ids (`:19-24`): Tickets & Packages or Socks.
  4. Name keywords otherwise, defaulting to Extras.
- Restaurant items are F&B unless the name indicates Camp or a ticket (`:239-250`). F&B is split into Food and Drinks by keyword (`:256-270`).
- Every line on an order whose channel name contains "birthday" is forced into Events / Birthdays. Its natural category is kept in `birthdayChannelSplit` so the client can flip the view (`:493-533`, `dashboard.tsx:12683`).
- Line revenue is `round(itemTotal * total / billTotal)` (`:504-505`). The range endpoint then rescales categories so they sum to the day's total (`routes.ts:234-259`).

**Guests, customer types and payments** [V]:
- Guest counts are parsed from item names by regex, on the reception terminal only (`papaya.ts:301-402, 562`).
- Stay durations are inferred from the name:
  - 2 hours by default
  - 3 hours for birthday items
  - "Full Day" for camp and all-day items
- There are no customer types. The `today` endpoint returns `customerTypeSplit: []` (`routes.ts:159`).
- Payment methods are collapsed to Cash, PromptPay/QR, Card or Other, and cancelled payments are skipped (`papaya.ts:52-58, 470`).
- Papaya has no voucher concept. The client treats "Parent Restaurant Credit" items as the voucher equivalent (`dashboard.tsx:13130-13146`).
- Revenue source is attributed by the name of the first discount on the order (`sourceRegistry.ts:186`). Birthday-channel orders are pulled into a separate "Birthdays" bucket (`papaya.ts:634-668`).

**Events, camp, heatmap and VAT** [V]:
- An event is any complete order whose channel contains "birthday". Cancelled lines are excluded and revenue is allocated in cents (`papaya.ts:2061-2163`).
- A manual per-day override replaces the Events category revenue but does not change `totalRevenue` (`papaya.ts:920-963`).
- Summer Camp is identified by `/\bcamp\b/i` on `channelName`, at order level, across both terminals (`papaya.ts:404-406`).
- The heatmap uses 24 hourly buckets with orders, revenue, tickets sold and a nested Summer Camp subtotal. The Exclude Summer Camp button appears only in the Chalong-only view (`dashboard.tsx:14259`, `activityHeatmap.ts:91`).
- VAT, service charge and tips appear only in the tax-invoice feature (`papaya.ts:2550-2586`). That feature exists only for Chalong.

**Where Chalong is weaker than Floresta** [V]:
- The following features exist for Floresta only:
  - customer-type split
  - hourly `categories` and `customerTypes` (Papaya emits empty objects, `papaya.ts:722-723`)
  - voucher payments, wallet passes and the voucher-to-channel map
  - `voucherSwingAmount`
  - party-to-F&B linking and the real party count (`birthdayLinks`)
  - the manual event linker (`routes.ts:2166, 2185, 2209`)
  - cash reports
  - locked months
  - the void/refund adjustments audit
  - the product registry with manual overrides
  - proportional attribution of partially paid orders
  - the Excel transaction reports
  - the AI Trends assistant (`routes.ts:2572-2585`)
  - the model forecast (Chalong uses same-time-last-year instead)
  - yesterday catch-up, the stale-day check and the cross-process sync lock
- The "Ticket Revenue by Source" card renders only when Floresta is selected and shows only Floresta data even in the combined view. `mergeDashboardData` never merges `sourceBreakdown` (`dashboard.tsx:14196, 10960-11157`).
- The chart builder drops the Chalong categories Camp, Socks, Memberships and Workshop from every category metric (`routes.ts:3007-3027`).

---

## 5. Branch model

- Branches are the string slugs `floresta` and `chalong`, redeclared in at least five places:
  - `<base>/shared/schema.ts:280, 486`
  - `posStaleness.ts:21`
  - `dashboard.tsx:547`
  - `marketingSummary.ts:22`
  - the validators at `routes.ts:79, 2127`
- There is no branch table and no numeric id.
- Display labels are inconsistent: "Robinson Chalong" (`dashboard.tsx:10943`) versus "Robinsons Chalong" (`shared/schema.ts:308`).
- The server has no single branch-parameterised dashboard endpoint. The client chooses `/api/funtopia/*` or `/api/papaya/*`, fetches both when both branches are active, and merges in the browser with `mergeDashboardData` (`dashboard.tsx:11915-11941, 10960-11157`).
- The merge is numeric addition, with category totals reconciled to the merged revenue.
- The merged object starts as a copy of the first result, which is always Floresta. Fields not merged explicitly are therefore inherited from Floresta alone.
- The branch toggle is still multi-select and the selection is stored in `localStorage` under `oto_branches` (`dashboard.tsx:11876`).
- Server-side merging exists in two places:
  - the chart builder, when exactly two branches are requested (`routes.ts:2926`)
  - the external marketing summary, which always merges both (`marketingSummary.ts:98-141`)
- A server `branch` parameter appears on these routes:
  - `/api/sync-today`
  - `/api/events/range` (`all`, `floresta` or `chalong`)
  - `/api/funtopia/chart-builder` (a `branches[]` array)
  - birthday-allocation preferences
  - `/api/planner/*`
  - `/api/pace-snapshots/:branch/:month`
- The planner and pace-snapshot routes also accept `all`.

**Assumptions hardcoded for exactly two branches** [V]:
- The table family is the branch key. `funtopia_*` tables hold Floresta and `papaya_*` tables hold Chalong, and neither family has a branch column.
- The client assumes at most two results (`results.length === 2`) when merging.
- The chart builder uses two fixed forecast constant blocks, `FC_CENTRAL` and `FC_CHALONG` (`routes.ts:3041-3076`).
- `BRANCH_CONFIG` is a two-element array in `posStaleness.ts`.
- The marketing response type fixes `parks` to the tuple `["floresta","chalong"]`.
- The default branch is `floresta` everywhere.
- Chalong is assumed to be exactly the `reception` and `restaurant` terminals (`papaya.ts:2353, 2406-2411`).
- Only Chalong has last-year data, because Floresta history starts 2025-12-01 (`<base>/.agents/memory/pace-forecast-mixed-scope.md`).
- The pace forecast relies on that fact with a scoping workaround (`dashboard.tsx:6477-6490`).
- Pseudo-keys `all`, `papaya_invoice`, `combined` and `meta` are stored in branch and terminal columns.

---

## 6. Model differences that matter for one neutral feed contract

| Aspect | Pisell (Floresta) | Papaya (Chalong) |
|---|---|---|
| Revenue basis | Cash basis from payments: `pay_amount - refund_amount`, minus voucher redemptions. Partial payments count. | `order.total` on complete orders. Payments are informational only. |
| Identity | `order_id` plus a human `order_code` such as A48963 or T007 | `id`, `orderNumber` and `receiptNumber`, stored under the key `(id, terminal)` |
| Time | `created_at` is a Bangkok wall-clock string. `order_date` is a report date and can repeat across reports. | `orderDate` is ISO UTC. The business day is derived with a +07:00 offset. |
| Status | `payment_status`: paid, partially paid, pending, voided | Order `status`, a separate item `status`, and a payment `status` plus `paid` flag. Complete orders can contain cancelled lines. |
| Lines | `product_id`, `variant_id`, category title, quantity, `unit_price`, subtotal, discount, tax | `name`, `quantity`, `itemTotal`, `menuItemCategoryId`, `status`. No SKU is extracted and there is no unit price or per-line discount or tax. |
| Payments | Separate rows with a stable id, refund amount, surcharge and `payment_at` | An embedded array with method, amount and status. No refund field is read. |
| Discounts and vouchers | Product and order discounts, wallet passes with codes, and a Voucher payment method | Order-level `appliedDiscounts` with name and total only. Prepaid credit is an item at reception and a discount at the restaurant. |
| Customer | Name, phone, email and notes, with customer type derived from products | None, apart from `items[0].customerName` |
| Channel and outlet | `order_sales_channel`, one store | `channelName` (Walk-in, Birthday, Camp) and two token-scoped outlets |
| Tax and service charge | Tax per line | Order-level `serviceCharge`, `tax`, `totalBeforeTax`, `isTaxInclusive`, `tipTotal` |
| Summary time grain | 20-minute slots, compacted by `rangePerformance.ts` | 1-hour buckets |
| Birthdays | Package SKU detection, note codes, heuristic F&B linking and per-order overrides | Channel-name detection and per-day manual totals |

Recommendations for our own feed contract:
- Classify category and sub-category explicitly from the product catalogue, never from item names.
- Carry guest type, guest count and stay duration as product attributes.
- Give every line its own status, and send payments as separate rows with their own id and refund amount.
- Include the voucher or discount code together with its campaign.
- Model prepaid credit as a sale and a later redemption.
- Link a party's package order and its F&B orders with a party id.
- Include outlet and branch ids, both a UTC timestamp and a business date, and both net and gross amounts with VAT and service charge shown separately.

---

## 7. Historical import

**What must be copied from Radar's database:**
- **`papaya_orders`**, in full with `raw_json`, for both terminals. Everything else can be derived from it.
- **`papaya_birthday_overrides`.** Its 16 seeded March 2026 rows hold ฿194,900 of party revenue and ฿21,600 of F&B. Those amounts are manual corrections for parties missing from Papaya data, so they are not part of `totalRevenue`. The seed can also be reproduced from `papaya.ts:872-889`.
- **`papaya_daily_cache`**, as the baseline for reconciliation and as the only record for any day that has no raw orders. This should be rare, because raw storage was added one day after the integration was first written [G: `de1d07b0` on 2026-04-02, `b7bebcc2` on 2026-04-03].
- **Chalong rows in `funtopia_branch_settings`**: the birthday allocation, invoice settings and planner targets and plans. Optionally also the `pace_forecast_snapshots` rows.
- **Not needed:** `papaya_order_items` and `papaya_sync_health` can be skipped.

**What could be re-fetched from Papaya:**
- All orders through `GET /orders` could be fetched again. Doing so needs the two tokens, which exist only in Replit Secrets and appear in no file in the repository, including `.env.example`, `.env.local` and `.replit`.
- A re-fetch must reuse the 2-hour slicing and must add backoff for HTTP 429.
- How far back the API retains orders is unknown. It probably serves at least 12 months, because 2025 data was backfilled in April 2026 [I].

**What is lost regardless:**
- Chalong history contains no customer identity, customer types, voucher codes, SKUs or unit prices, and no refund or void audit trail. Headcount is only what the name regexes could parse.

**Reconciliation warning:**
- Recomputed category and guest figures will not match Radar's cached figures on days that had cancelled lines (see section 9). Total revenue should still match.

**Before exporting:**
- Decide whether the dev or the production database is authoritative. They can differ, and a push from dev replaces the production Papaya tables wholesale (`routes.ts:1921-1923`).
- `<base>/.agents/memory/pos-birthday-audit-cautions.md` records that the August 2026 audit found production short of raw birthday orders.

---

## 8. Environment variables and hardcoded configuration

**Environment variables (names only):**

| Variable | Where read | Purpose |
|---|---|---|
| `PAPAYA_RECEPTION_TOKEN` | `papaya.ts:9` | Bearer token for the park outlet |
| `PAPAYA_RESTAURANT_TOKEN` | `papaya.ts:10` | Bearer token for the cafe outlet |
| `DATABASE_URL` | `<base>/server/db.ts:7, 14` | Postgres connection |
| `FUNTOPIA_CLIENT_SECRET` | `routes.ts:1526, 1732, 1899` | Reused as the `x-push-secret` header that guards the Papaya table import and wipe |
| `OTO_RADAR_MARKETING_API_KEY` | `marketingSummary.ts:9` | Bearer key for the external marketing summary |
| `PORT`, `NODE_ENV`, `LOG_RESPONSE_BODY` | `<base>/server/index.ts` | Runtime settings |

**Hardcoded configuration:**

| Item | Location |
|---|---|
| Four `menuItemCategoryId` values | `papaya.ts:19-24` |
| Category, F&B and ticket keyword lists | `papaya.ts:26-50, 239-270, 301-402` |
| Stay durations and the 45-minute grace period | `papaya.ts:301-402, 750` |
| `PAPAYA_FORMULA_VERSION = "v21"` | `papaya.ts:82` |
| Categories allowed in the birthday split | `papaya.ts:87-94` |
| 2-hour slice, 220 ms pause, 45 s timeout, 2 attempts | `papaya.ts:155-156, 222, 233` |
| 300 ms pause between days | `papaya.ts:1700` |
| 97% drop-protection threshold | `papaya.ts:1556, 1676, 1779` |
| 90-day sync-health retention | `papaya.ts:1094` |
| Birthday override seed (16 rows) | `papaya.ts:872-889` |
| Default invoice header: legal entity, address, tax id and POS tax id | `papaya.ts:2499-2511` |
| Opening hours 10:00 to 20:00 and the 120-minute staleness threshold | `posStaleness.ts:18, 30-33` |
| 5-minute auto-sync interval | `routes.ts:102` |
| Range response cache, 2 minutes and 24 entries | `routes.ts:23` |
| Chalong forecast constants (`FC_CHALONG`), base ฿900,000 per month | `routes.ts:3048-3054` |
| Quick sync is 1 day back, full sync is 90 days back | `dashboard.tsx:12385` |

---

## 9. Fragile, surprising or undocumented

1. **Public, destructive endpoints.** All `/api/papaya/*` routes are unauthenticated. `requireStaff` exists but is applied to none of them, and `<base>/replit.md:51` records "No Auth" as a deliberate decision. This includes the destructive `resync-date` and the tax invoices.
2. **`resync-date` can lose data.** `resyncPapayaDate` clears the date's cached summaries for both terminals and then deletes its raw orders before fetching (`papaya.ts:1717, 1732-1735`). Combined with silent timeouts, a bad run loses the day's data and caches a partial summary with no drop protection. It also orphans rows in `papaya_order_items` and deletes the date's health history.
3. **Broken route.** `POST /api/papaya/clear-cache` imports `clearPapayaCache`, which does not exist (`routes.ts:585`). Calling it throws a TypeError at runtime.
4. **Dead code.** These are unused:
   - `getLastKnownReceptionSummary`
   - `fetchPapayaOrdersByDiscount`
   - `clearPapayaCacheByTerminal`
   - `getPapayaBirthdayAllocationForTerminal`
   - the `_maxPages` parameter
5. **Cancelled lines are counted.** `buildPapayaSummary` never filters cancelled item lines (`papaya.ts:482-605`). Category totals, top products and guest counts are inflated by them. Only the Events row builder excludes them. Tax invoices also include cancelled lines (`papaya.ts:2551`).
6. **Overrides distort range views.** A birthday override changes the Events category revenue but not `totalRevenue`. The range endpoint then rescales every category on that day (`routes.ts:243-259`), which distorts the override.
7. **"Ongoing guests" is wrong.** The calculation compares a Bangkok-shifted pseudo-timestamp against real epoch values (`papaya.ts:744-756`). It is off by 7 hours, so the live in-park count for Chalong is wrong.
8. **Drop protection blocks real corrections.** In `full` mode it skips caching when more than 3% of a day's orders are later voided, so legitimate corrections never reach the cache. Cached summaries and raw data can therefore disagree. Recompute from raw rather than trusting the cache.
9. **A moved order can be double-counted.** An order whose `orderDate` moves is upserted in place, but the old day's cached summary is never invalidated [I].
10. **Concurrent sync.** Dev and production run the same 5-minute sync, possibly against the same database, and Papaya has no lock.
11. **`__meta__` leaks into the chart builder.** `getAllPapayaDailySummaries` does not exclude the `__meta__` row and does not check the formula version (`papaya.ts:2244`). The row reaches the chart builder whenever `dateTo` is omitted.
12. **Parent Restaurant Credit shifts revenue.** It is recognised as ticket revenue at reception. When it is redeemed it appears as a restaurant discount, so Chalong F&B is understated by the amount redeemed.
13. **Committed config.** `.replit` and `.env.local` are tracked in git. `.replit` has the keys `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` under `[userenv.production]`, left over from the HR fork. I did not print the values. They should be rotated.

---

## Unknowns that need database or API access

- The earliest and latest Chalong dates and any gap days. The category id prefixes, read as ULID timestamps, suggest the Papaya menu dates from about February 2025 [I].
- Whether any order id appears under both terminals.
- The full key set of `raw_json`, and the real vocabularies for order status, item status, payment status, payment method and channel name. In particular, how Papaya represents refunds is unknown.
- Whether `from` and `to` filter on order creation time or completion time.
- The API's page size, the 429 rate-limit threshold and how far back history is retained.
- Whether `total` really includes the restaurant service charge.
- Whether anyone has manually added override rows beyond the 16 seeded ones.
- The size of the divergence between the dev and production databases.

Checks I suggest running first, none of which I executed:
- List the distinct keys of `raw_json`, and the distinct keys of its items and payments.
- Count orders grouped by `status` and by `channel_name`.
- Find ids that appear under more than one terminal.
- Look for gaps with a `generate_series` over the Bangkok dates for each terminal.
- For each day and terminal, compare the cached `totalRevenue` with `SUM(COALESCE(total, bill_total))` over orders where `status='complete'`.
