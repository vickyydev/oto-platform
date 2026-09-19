<!-- Read-only analysis of the imported Replit export, 2026-09-19. File references are relative to the export under imports/ (local only, not in git). No secret values are recorded here - variable names and locations only. -->

> **OTO Radar — Pisell (Floresta) sales pipeline** - intake analysis, 2026-09-19. Markers: [V] verified by reading code, [I] inferred, [U] unknown.

# OTO Radar: Pisell ("Funtopia") pipeline analysis for re-platforming

This was a read-only analysis. No files were created or changed, and no secret values are printed.

ROOT is `imports/oto-radar`. All `file:line` references below are relative to ROOT.

**How I verified things:**
- I read all 9,206 lines of `server/funtopia.ts`, its helper modules and the project's memory notes, the funtopia-related parts of `server/routes.ts` and `server/index.ts`, and `server/sourceRegistry.ts`, `server/db.ts`, `server/ensureSchema.ts`, `database-schema.sql`, `replit.md` and `.replit`.
- "Verified" means read in code. "Inferred" and "undetermined" are marked.
- I had no database access, so anything about actual stored data is from code or from the audit export only.

## Five findings to read before the detail

1. **Radar's stored history is incomplete.**
   - The August 2026 audit export shows 7,686 orders live in Pisell versus 6,502 stored in the database it audited. Payments were 8,301 versus 7,037.
   - Several days were nearly or entirely empty in storage:

     | Date | Stored / live orders | Note |
     |---|---|---|
     | Aug 2 | 82 / 310 | |
     | Aug 6 | 1 / 249 | |
     | Aug 14 | 0 / 213 | |
     | Aug 21 | 236 / 306 | |
     | Aug 22 | 0 / 291 | no cache row |
     | Aug 28 | 0 / 132 | no cache row |

   - Plan to re-fetch from Pisell while the credentials still work. I could not tell whether that audit ran against the dev or the published database.

2. **A formula version bump can zero out history.**
   - The read-path self-heal rebuilds a day from raw rows without checking that raw rows exist (`funtopia.ts:6473-6479`, `4096-4101`, `2994-2998`).
   - A day that has a cache row but no raw rows is overwritten with zeros.
   - Only `regenerateSummaries` has the guard (`funtopia.ts:2926-2933`).

3. **Two VAT bases are mixed and the code never applies VAT.**
   - Line `payment_price` and `original_price` are VAT-exclusive. Payments and order `total_amount` are VAT-inclusive.
   - I checked this against the audit: all nine clean paid party orders show `total_amount / Σ payment_price` of exactly 1.0700. Five of the twelve linked F&B orders also show 1.07 (rounding aside), including ordinary F&B receipts. The other events involve vouchers, a partial refund, or line-net totals above the order total.
   - `totalRevenue` and the payment breakdown are therefore VAT-inclusive. Category, product, ticket, hourly and source revenue are VAT-exclusive.

4. **The gap from point 3 is hidden from users.**
   - `reconcileCategoryBreakdown` puts the difference into an "Other (Unattributed)" bucket.
   - The UI hides that bucket (`client/src/pages/funtopia-dashboard.tsx:2593-2599`).

5. **No authentication on any `/api/funtopia/*` endpoint** (`replit.md:51`).
   - `POST /api/funtopia/push-to-production` sends the `FUNTOPIA_CLIENT_SECRET` value as a header to a caller-supplied URL with no host validation (`routes.ts:1875-1900`, `2010-2012`).
   - Anyone who can reach the server can obtain that credential and the full dataset.
   - Rotate the Pisell credentials after migration.

## 1. Pisell API

All of this section is verified in code unless marked.

**Base URL and client**
- Base URL comes from env `FUNTOPIA_API_URL`, with a hardcoded default of `https://ap.pisellapi.com` (`funtopia.ts:424`).
- The client is the global `fetch`. There is no SDK.

**Authentication** (`funtopia.ts:3032-3047`)
- There is no token exchange. Client id and secret never become a token.
- Every request sends these headers:
  - `Client-Id`
  - `Access-Token`, a static value from env `FUNTOPIA_ACCESS_TOKEN`
  - `Timestamp`, unix seconds
  - `Sign`
  - `Content-Type: application/json`
- `Sign` is the uppercase hex MD5 of the three strings [timestamp, client id, client secret], sorted with JavaScript's default lexicographic `.sort()` and joined with `&`.
- There is no refresh logic, no 401 handling and no expiry tracking. Token lifetime is undetermined.
- `isFuntopiaConfigured()` requires only the secret and the token (`funtopia.ts:8609-8611`).

**The one endpoint called**

| Method | Path | Body |
|---|---|---|
| POST | `/openapi/report/gateway` (`funtopia.ts:3163`) | `{ type, payload }` |

Payload fields (`funtopia.ts:3079-3088`):
- `skip` is a 1-based page number, not an offset.
- `size` is the page size.
- `start_at` and `end_at` are `"YYYY-MM-DD HH:mm:ss"` local wall-clock strings.
- `local_timezone` is always `"Asia/Bangkok"`.
- `sales_channel`, `pay_status` and `pay_method` are typed but never sent.

Response handling:
- The response shape is `{status, code, message, data:{count,size,skip,refreshed_at?,list[]}}`.
- `refreshed_at` is never read.
- Response keys can arrive wrapped in square brackets. `cleanKeys` strips them before anything is stored (`funtopia.ts:3146-3157`).
- The error rule is `!status && code !== 200` (`funtopia.ts:3194`).

**Report types**

The field lists below come from the audit export's `sampleFieldKeys` (Aug 2026) plus the TypeScript interfaces at `funtopia.ts:3103-3144`.

| `type` | Fields Pisell returns | Fields consumed | Returned but unused |
|---|---|---|---|
| `order_basic_information` | order_id, order_code, created_at, payment_status, total_amount, payment_amount, product_original_amount, product_discount, order_discount, surcharge_fee, tax, is_price_include_tax, order_sales_channel, order_notes, pay_detail_list, count, skip | order_id, order_code, created_at, payment_status, total_amount, product_discount, order_discount, order_sales_channel, order_notes. From `raw_json` later: surcharge_fee and tax (Excel report only), pay_detail_list (adjustments fallback) | payment_amount, product_original_amount, is_price_include_tax |
| `order_products_information` | order_id, product_id, product_title, category_title, product_tag_title, option, product_quantity, original_price, product_discount, payment_price, order_sales_channel, payment_status, pay_detail_list | order_id, product_id, product_title, category_title, product_quantity, payment_price, product_discount, and `original_price` (only via the `raw_json` spread at `funtopia.ts:4034-4036`) | option, product_tag_title |
| `order_payments_information` | id, order_id, pay_amount, refund_amount, payment_surcharge, payment_at, pay_method, payment_status, order_sales_channel | id, order_id, pay_method, pay_amount, refund_amount, payment_at. payment_surcharge is stored only | payment_status |
| `order_wallet_pass_usage_information` | full list undetermined (not in the audit) | order_id, title, code, code_type, action, redeem_amount (`funtopia.ts:1338-1346`) | unknown |
| `order_guest_information` | unknown | never called. It is declared at `funtopia.ts:3074` only | n/a |

Consequences of the payload shape (inferred from the audit's field keys):
- `storeRawOrders` reads fields Pisell does not send: `p.price`, `p.tax`, `p.created_at`, `p.variant_id`, `p.payment_name`, `o.customer_*` and `o.source`.
- The following stored columns are therefore always 0 or NULL:

  | Table | Always-empty columns |
  |---|---|
  | `funtopia_orders` | `unit_price`, `tax`, `created_at`, `variant_id` |
  | `funtopia_raw_payments` | `payment_name` |
  | `funtopia_raw_orders` | `customer_name`, `customer_phone`, `customer_email`, `source` |

- Radar holds no customer data from Pisell.
- Product rows have no line-item id. Exact-duplicate rows cannot be told apart from legitimately identical lines.

**Pagination** (`funtopia.ts:3205-3251`)
- Page size is 100 and the maximum is 50 pages, so the cap is about 5,000 rows per call.
- The loop stops when the accumulated row count reaches the reported `count`, or on an empty page.
- `isPartial` is set when fewer than 97% of the expected rows arrived.
- In the audit, the payments report returned more rows per page than the requested `size`. It appears to page by order rather than by payment row (inferred).

**Retries and rate limiting**

| Path | Code | Behaviour |
|---|---|---|
| Range sync | `funtopia.ts:2685-2728` | On HTTP 429, wait 30 s × attempt, up to 5 tries. On abort, timeout or network error, wait 15 s × attempt, up to 3 tries. |
| Range sync pacing | `funtopia.ts:2736-2738`, `2767` | 10 s between chunks. 2 s between per-day count probes. |
| HTTP 500 | `funtopia.ts:2707-2726`, `3183-3185` | Not retried. One 500 fails a whole 3-day chunk. |
| Single-day path | `funtopia.ts:4744-4764` | No retry at all. This is the 5-minute auto-sync and `resync-date`. |
| Wallet-pass backfill | `funtopia.ts:1217`, `1222` | 500 ms pacing, then 2 s after a failure. |

**Timeout:** 120 s per request via `AbortController` (`funtopia.ts:3166-3170`).

**Timezone handling**
- Every request sends `local_timezone: "Asia/Bangkok"`.
- "Today" is computed as `Date.now() + 7h` in `funtopia.ts` and with `Intl sv-SE / Asia/Bangkok` in routes.
- Pisell timestamps are local strings such as `"02/May/2026 15:18:51"`. Different helpers parse them inconsistently:
  - `extractDateFromCreatedAt` (`2951`) takes the date by regex.
  - `parsePisellCreatedAt` (`3390-3407`) treats the string as UTC+7.
  - `parsePisellCreatedAtDate` (`8859`) treats it as UTC wall-clock, for formatting only.
  - `extractSlot` (`7857`) takes HH:MM by regex.
- `getAdjustmentsData` feeds the raw string to `new Date(...)` (`funtopia.ts:8513`). The late-void check is therefore fragile (behaviour unverified).

## 2. Sync

| Trigger | Where | What it does |
|---|---|---|
| Boot + 5 s, then every 5 min | `routes.ts:102`, `119-141` | Runs `syncFuntopiaToday()` |
| Boot + 3 s | `index.ts:122-149` | Seeds cash reports. Runs `backfillWalletPassesOnStartup` (cache migration flag, duplicate cleanup, product registry load, wallet-pass backfill for up to 200 dates within 365 days). Starts the daily revenue-divergence monitor. |
| `POST /api/sync-today` | `routes.ts:76-100` | Same as the 5-minute sync |
| `POST /api/funtopia/sync` mode `quick` | `routes.ts:1345-1363` | Runs synchronously for yesterday through today |
| `POST /api/funtopia/sync` mode `full` | `routes.ts:1365-1439` | Runs in the background. Start date defaults to hardcoded `2026-01-01`. The maximum range is 366 days. Optional `exactReportDates`. Progress is held in memory. |
| `POST /api/funtopia/resync-date` | `routes.ts:1093` | Synchronous single day |
| `POST /api/funtopia/regenerate` and `/process` | `routes.ts:1285`, `1483` | Rebuild summaries from raw rows. No API call. |
| `POST /api/funtopia/wallet-passes/backfill` | `routes.ts:1229` | Wallet passes only |
| On read | `funtopia.ts:5481`, `6431`, `2968`, `6271` | Re-summarises from raw when the stored `formulaVersion` differs. Reads never call Pisell. |

**What one sync cycle does**
- `syncFuntopiaToday` (`funtopia.ts:2361-2422`) always pulls today.
- Before 12:00 Bangkok it also pulls yesterday (`2370-2385`).
- It then runs `checkStaleRecentDays` for the previous day and the day before (`2452-2507`):
  - A size-1 probe gets Pisell's order count for the day.
  - A full re-pull happens when Pisell reports at least 3 more orders than are stored.
  - An in-memory memo stops repeat re-pulls when the same gap persists.
- The whole cycle is skipped for 30 minutes after a dev-to-prod push (`2312`, `2364-2368`).

**Locks**
- A session advisory lock named `funtopia:api-sync` spans fetch, replace, summarise and cache write, across processes (`funtopia.ts:1715-1749`).
- A transaction advisory lock named `funtopia:store-raw-orders` sits inside the write (`1829-1832`).
- `funtopiaSyncState.running` is per process only.

**Range sync** (`funtopia.ts:2631-2905`)
- Dates are fetched in contiguous chunks of at most 3, newest first. With `exactReportDates` the chunk size is 1.
- Orders in a chunk are assigned to days by `created_at`. Orders that fit no day go to the last date (`2545-2580`).
- A payment joins a day if its `payment_at` date matches or its order is in that day (`2791-2794`).
- In the single-day path, every returned row gets the requested date as its `order_date`.

**Protections**

| Protection | Code | Rule |
|---|---|---|
| Blank feed | `funtopia.ts:4790-4816`, `2809-2821` | Zero returned orders never wipes today or yesterday |
| Drop guard | `funtopia.ts:2823-2840` | Range sync skips a day when new orders are fewer than 97% of existing, unless the mode is quick and the day is recent |
| Partial flag | `funtopia.ts:3245` | Partial data is flagged but still stored |
| Sync health log | `funtopia.ts:5690-5722` | Status clean, partial, failed or skipped, written to `funtopia_sync_health` and kept 90 days |

The 5-minute single-day path has the blank guard but not the 97% drop guard.

**Staleness detection**
- The order-count check described above.
- `posStaleness.ts`: today's last order is compared to the current time with a 120-minute threshold. Both branches are configured 10:00 to 20:00, so alerts fire from 12:00 to 20:00.
- A divergence monitor (`funtopia.ts:5671-5688`) runs every 24 h with a 14-day lookback and a ฿1 threshold. It only logs. It compares the cache to Radar's own raw tables, not to Pisell.
- `sourceWatchdog.ts` flags marketing sources with zero orders on consecutive days.

**Locked months**
- Stored in `funtopia_locked_months` as `YYYY-MM`.
- Locks are honoured only by range sync (`funtopia.ts:2649-2659`), the stale check (`2460-2464`) and import `clearFirst` (`routes.ts:1601-1618`).
- Locks are not honoured by `resync-date`, the 5-minute sync, regenerate, override link/unlink rebuilds, or formula self-heal.
- A locked month's numbers therefore still change.

**Deployment (inferred from `.replit:17`)**
- The target is `autoscale`.
- The `setInterval` sync only runs while an instance is alive.
- Background full syncs can die when the instance idles.
- All in-memory state is per instance.

## 3. Storage

- All funtopia tables are raw SQL `CREATE TABLE IF NOT EXISTS` statements inside `server/funtopia.ts`. `pace_forecast_snapshots` is created in `routes.ts`.
- None are managed by Drizzle. `ensureSchema.ts` only runs Drizzle migrations for unrelated tables.
- `database-schema.sql:194-331` corroborates the columns.

| Table | DDL at | Key | Raw JSON kept | Notes |
|---|---|---|---|---|
| `funtopia_raw_orders` | `funtopia.ts:438-459` | `id` serial. `order_id` has no unique constraint. | yes | `order_date` is text and holds the report date. `created_at` is text. `channel` holds `order_sales_channel`. `note` holds `order_notes`. |
| `funtopia_orders` (line items, despite the name) | `461-483`, `519-521` | `id` serial | yes | `subtotal` holds `payment_price`. `payment_method` holds the order's last payment method. `original_price` exists only in `raw_json`. |
| `funtopia_raw_payments` | `485-500` | `id` serial | yes | The stable Pisell payment `id` exists only inside `raw_json`. |
| `funtopia_raw_wallet_passes` | `503-517` | `id` serial | yes | Replaced per date |
| `funtopia_daily_cache` | `431-436` | `date` text | summary JSONB | A row with `date = '__meta__'` holds sync timestamps, push timestamp and migration flags. |
| `funtopia_birthday_overrides` | `546-554` | (`order_code`, `order_date`) | no | Seed list at `563-599`, plus links made in the UI |
| `funtopia_voucher_channel_map` | `524-543` | `face_value` | no | `channels` is a text array. Seeds at `1542-1565`. |
| `funtopia_branch_settings` | `904-914` | (`branch`, `key`) | value JSONB | Keys: `birthday_fnb_allocation`, `planner_target_YYYY-MM`, `planner_plan_YYYY-MM` (`routes.ts:828-935`) |
| `funtopia_product_registry` | `7054-7076` | `product_key` = `productId::variantId` | no | Has a `manual_override` flag |
| `funtopia_daily_revenue` (manual cash reports) | `1567-1583` | `UNIQUE(date, branch)` | no | Seeded from a hardcoded array at `8635-8780` |
| `funtopia_calendar_notes` | `1585-1593` | `date` | no | |
| `funtopia_locked_months` | `1595-1602` | `month` | no | |
| `funtopia_sync_health` | `1604-1623` | `id` serial | warnings JSONB | 90-day retention |
| `pace_forecast_snapshots` | `routes.ts:2483-2495` | (`date`, `branch`) | no | |

**Write rules** (`storeRawOrders`, `funtopia.ts:1751-2025`)
- Orders and line items are deleted by date and re-inserted.
- An order that Pisell has moved to a new date is removed from its old date. The old date's summary is rebuilt (`1857-1885`, `2010-2024`).
- A payment that has a stable id is replaced only when Pisell returns it again. It is never deleted because Pisell omitted it (`1836-1855`).
- Payments without an id are replaced per date.
- Incoming orders are de-duplicated by `order_id`. Payments are de-duplicated by `id`.
- Product rows are never de-duplicated.

**Read-path safety net** (`funtopiaDedup.ts`)
- The latest row wins, by `synced_at` then `id`, per `order_id` and per payment id.
- `cleanupDuplicateOrdersOnStartup` runs at `funtopia.ts:2051-2238`.

## 4. How a daily summary is compiled

The code is `buildSummaryFromDatabase` (`funtopia.ts:4012-4094`) and `buildSummaryFromRawData` (`4107-4563`).

**Core definitions**
- Active orders are those whose status is not `voided`. Paid orders are those whose status is exactly `paid`.
- Payments are taken from rows stored under the date.
  - If a payment's order lives under another date, that order is pulled in by a cross-date lookup (`4061-4082`).
  - Those cross-date orders also count in `totalOrders` and `discountTotal`.

**Revenue** (`funtopia.ts:4161-4178`)

```
totalRevenue = Σ(pay_amount − refund_amount) over active payments
             − Σ(pay_amount − refund_amount) over Voucher-method payments
```

- This is cash basis and is meant to match Pisell's Net Sales (Cash Basis).
- A refund reduces the day of the original payment. Pisell exposes no refund date.
- `payment_surcharge` is ignored.
- `fixCachedRevenue` repeats the same calculation in SQL (`5204-5286`).

**Formula version and registry**
- `FORMULA_VERSION` is `v30` (`funtopia.ts:14`).
- `FORMULA_REGISTRY` (`183-422`) is descriptive text only and is served at `/api/funtopia/formulas`.
- Parts of the registry text are stale against the code. For example it names the card bucket "Credit Card", while the code produces "Card".

**Payment methods** (`funtopia.ts:7968-7977`)
- Methods are matched by substring, in this order: cash, then credit / debit / edc (mapped to "Card"), then promptpay / qr, stripe, gift, voucher. Anything else keeps its raw name.
- The payment breakdown only includes methods with a positive net amount.

**Categories**
- Every SKU is resolved through the product registry (`funtopia.ts:7156-7207`).
- The first time a SKU is seen, `bootstrapClassifyProduct` decides its category (`7100-7154`):
  - First nanny or drop-off, then birthday package.
  - Then `classifyCategory` on the raw category title (`7441-7455`; lists at `6992-7005`).
  - Then name-based rescues: Eat & Play or adult ticket, merchandise list, "OTO CS" workshop items, and the food and drink keyword lists at `7469-7486`.
  - Otherwise Extras, marked unclassified.
- A manual override on a SKU always wins.
- Every line on a party order is forced into Events / Birthdays (`7631-7634`).
- Sub-categories:
  - Tickets split into Indian, Tourist, Expat, Thai, Extra Tickets, Eat & Play Package and Other (`7533-7542`).
  - F&B splits into Food and Drinks.
- Item lists are trimmed to the top 10 product names per category per day.
- Guest counts, customer types, hourly buckets, the BD-ticket figure and source attribution still use the old string classifier and ignore the registry. Overrides do not reach them.

**Customer types** (`funtopia.ts:7746-7855`)
- The type is read from the category title on ticket lines only. No customer data is involved.
- A standalone adult ticket takes the type of the order's first kid ticket.
- Product id `431415` is hardcoded as excluded (`7760`, `7782`). I could not find out what it is.
- Thai orders with a kid ticket get one free adult each.

**Guest and gate estimate** (`funtopia.ts:6724-6988`)
- Eat & Play bundles count as quantity kids plus quantity adults.
- An Indian package counts as quantity × 2 kids.
- Other kid packages go through `solveKidsAndAdults` (`6659-6722`). It works out kid and adult counts from `original_price` using hardcoded VAT-exclusive prices (`6650-6657`) and ignores quantity.
- Drop-off kids are added on top.
- Kid count has a floor of `ceil(socks quantity × 0.9)`.
- Stay hours are read from the product name. Full day and Eat & Play count as 8 hours.
- The "ongoing in park" figures use the clock at build time (45-minute grace, close at 20:45). For any past day that gets rebuilt they are meaningless.
- The top-level `totalGuests` field is hardcoded to 0 (`4548`).

**Top products, hourly and voucher swing**
- Top products are the 10 highest-revenue product names from paid orders, by `payment_price`.
- The hourly view has 72 twenty-minute slots based on order `created_at`, paid orders only.
- Voucher swing matches `/(\d+)\s*voucher/` and multiplies face value by quantity.
- Pure ticket revenue is ticket category revenue minus voucher swing.

**Source and channel**
- There is no sales-channel aggregation. Only `sourceBreakdown` exists, and it credits ticket revenue only.
- It has two diverging implementations:
  - The sync path (`funtopia.ts:4397-4516`) checks the wallet-pass code registry, then title regex, then the face-value map.
  - The read path (`5288-5479`) additionally lets `order_sales_channel` override everything. It does not filter to paid orders and does not de-duplicate.
- Which implementation last wrote a day depends on the code path taken.
- Party orders go to a "Birthdays" bucket.
- Orders whose only vouchers are non-channel vouchers are dropped entirely.

**Birthday linkage** (`computeBirthdayLinks`, `funtopia.ts:3485-4010`)
- A party order has a line matching `isBirthdayPackage` (`7507-7518`), or a staff note with a party keyword (`3424-3436`), or is nominated by an override.
- F&B-side orders are marked by `BDAY_FNB_TOKEN_REGEX` (`3449`).
- Links are assigned greedily, one to one, in three tiers:
  - Tier A: an order-code cross-reference in a note, or an override.
  - Tier B: a bare BDAY tag, paired with the same-day party closest in time.
  - Tier C: a heuristic score of 8 or more (`3845-3873`).
- Display values use the booking amount (`total_amount`). `partyFnbRevenue` and the v30 "cash" fields use non-voucher payments.
- The allocation toggle defaults to "events". It moves `min(partyFnbRevenue, F&B revenue)` from F&B into Events (`1044-1123`).

**Partially paid orders** (`funtopia.ts:4262-4343`)
- Each line is scaled by `min(1, netCollected / productSum)`. Quantity is scaled too, so quantities become fractional.
- An order with payment but no lines becomes a residual entry.

**Cache and self-heal**
- A version mismatch triggers a full rebuild from raw rows.
- Otherwise the older repair helpers run: `fixCachedRevenue`, `reclassifyCachedCategories` and `backfillBirthdayLinks`.
- Cache writes are optimistic. `setCachedSummaryIfUnchanged` compares the whole JSONB (`1689-1703`).

**Ranges and performance**
- A range is a merge of cached days via `aggregateDailySummaries` (`funtopia.ts:5890-6248`).
- Because each day keeps only a top 10, range top lists are approximate.
- A 2-minute in-memory cache holds 24 range responses and de-duplicates in-flight requests (`routes.ts:23`, `2248`). Syncs never invalidate it.
- Twenty-minute slots are compacted to hourly for range responses (`rangePerformance.ts`).
- Large response bodies are omitted from logs.
- `calendar-range` reads the two totals straight from the JSONB in SQL.

**Manual cash overlay**
- The client adds a manual cash-report figure only for dates that have no POS row (`funtopia-dashboard.tsx:13049-13064`).

## 5. Proposed canonical feed contract

R means required for identical analytics. O means optional. Declare the VAT basis explicitly, and send all timestamps as timestamptz together with an Asia/Bangkok business date.

**order**

| Field | R/O | Why |
|---|---|---|
| `order_id` (globally unique) | R | identity |
| `branch_id` | R | |
| `business_date` | R | day attribution |
| `created_at` | R | hourly buckets, birthday time-gap scoring, staleness |
| `status` (paid, partially_paid, pending, voided, partially_refunded) | R | paid/voided rules. Radar's full status list is undetermined. |
| `total_amount_gross` | R | booking value and link scoring |
| `product_discount_total`, `order_discount_total` | R | discount total |
| `updated_at` or `version` | R | de-duplication |
| `order_code` | R | note cross-references and overrides. T-series codes repeat daily, as the seed list shows (`563-599`). |
| `sales_channel` | O | source attribution override |
| `note` | O | birthday linking. An explicit `event_id` or `linked_order_id` would be better. |
| tax, surcharge, customer reference | O | Excel report only, or unused |

**order_line**

| Field | R/O | Why |
|---|---|---|
| `line_id` | R | Pisell lacks one, which causes duplicate ambiguity |
| `order_id` | R | |
| `product_id`, `variant_id` | R | registry key |
| `product_name` | R | name-based rules |
| `category_name` | R | classification and customer type |
| `quantity` | R | |
| `net_amount` | R | the equivalent of `payment_price` |
| `list_amount` (the equivalent of `original_price`) | R only if the price solver is kept | headcount |
| `discount_amount`, `tax_amount` | O | |
| `kid_count`, `adult_count`, `duration_minutes`, `market`, `revenue_category`, `fnb_subcategory`, `is_party_package`, `voucher_face_value` | O, strongly recommended | retires every name and price heuristic |

**payment**
- R: stable `payment_id`, `order_id`, `method` (with a reliable voucher flag), `amount` (gross), `refunded_amount`, `paid_at`.
- O: `surcharge`, `status`.

**refund**
- Pisell has no refund entity. It only exposes a cumulative amount on the payment row, with no timestamp.
- Proposed fields: `refund_id`, `payment_id`, `amount`, `refunded_at`.
- To reproduce Radar's numbers exactly, fold refunds back onto the original payment's date.

**voucher_redemption**
- R: `order_id`, `voucher_title`, `action`.
- R: a `redemption_id` of our own, because Pisell has none.
- `voucher_template_code` is matched before the title. `amount` is optional, and only clearly positive amounts are rejected.
- An explicit `marketing_channel_id` is recommended.

**customer**
- Not needed. No Radar computation uses customer data.

**Manual inputs kept outside the POS feed**
- Voucher face-value to channel map.
- SKU category overrides.
- Birthday link overrides.
- Allocation setting.
- Locked months.
- Calendar notes.
- Manual cash reports.
- Planner targets and plans.

## 6. Historical import

**Copy both the raw tables and the cache.**

Raw tables:
- `funtopia_raw_orders`, `funtopia_orders`, `funtopia_raw_payments`, `funtopia_raw_wallet_passes`.
- Copy them with `raw_json` intact.
- The payment id and `original_price` exist only inside `raw_json`, so they are lost without it.

Cache:
- Copy `funtopia_daily_cache` and handle its `__meta__` row separately.
- It is the only record for days whose raw rows are missing.
- It also serves as a frozen v30 reference for parity testing.
- Never run imported cache through Radar's self-heal, because of finding 2.

**Recomputable from raw:** every summary field.

**Not recomputable:**
- `funtopia_birthday_overrides` (links made in the UI)
- `funtopia_voucher_channel_map`
- `funtopia_branch_settings` (allocation, targets and plans)
- `funtopia_calendar_notes`
- `funtopia_locked_months`
- `funtopia_daily_revenue` (any manual rows beyond the hardcoded seed)
- `funtopia_product_registry` rows with `manual_override = true`
- `pace_forecast_snapshots`
- Item detail below each day's top 10, wherever raw rows are absent

**Which database to copy from**
- Dev and published are separate databases.
- The push tool copies only these tables from dev to production: raw orders, raw payments, cache, daily revenue, notes, line items and locked months (`routes.ts:1913-1924`).
- It does not copy wallet passes, overrides, the voucher map, branch settings, the product registry or sync health.
- The two environments therefore diverge. Identify the authoritative one and run a per-day coverage query on both.

**Data that exists only in Pisell**

| Item | Detail |
|---|---|
| Missing and partial days | see the August numbers under finding 1 |
| Late refunds | Refunds made after a day's last sync. Only the previous day and the day before are re-checked, and only on order count. |
| Missing `order_sales_channel` and `order_notes` | Rows last synced before Pisell added these fields (May and July 2026) |
| Wallet passes beyond 365 days | the backfill window limit |
| Guest data | `order_guest_information` was never fetched |

**Re-fetch safely**
- Re-fetch one day at a time into staging.
- Wide fetch windows return an advance-booked order's products more than once.
- A re-fetch replaces the orders and line items stored for that date.

## 7. Environment variables and hardcoded configuration

Environment variables, names only:

| Variable | Read at | Note |
|---|---|---|
| `FUNTOPIA_API_URL` | `funtopia.ts:424` | |
| `FUNTOPIA_CLIENT_ID` | `funtopia.ts:425` | a hardcoded default client id sits in source here |
| `FUNTOPIA_CLIENT_SECRET` | `funtopia.ts:426` | |
| `FUNTOPIA_ACCESS_TOKEN` | `funtopia.ts:427` | |
| `DATABASE_URL` | `db.ts:7` | pool max 10 |
| `FUNTOPIA_CLIENT_SECRET` (as `x-push-secret`) | `routes.ts:1526`, `1732`, `1798`, `1899` | reused as the dev-to-prod push secret |
| `OTO_RADAR_MARKETING_API_KEY` | `marketingSummary.ts:9` | external consumer at `/api/external/marketing-summary` |
| `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_OPENAI_BASE_URL` | `routes.ts:2575-2576` | trends assistant |
| `PORT`, `NODE_ENV`, `LOG_RESPONSE_BODY` | `index.ts:56`, `92`, `99` | |

`replit.md:8` mislabels `FUNTOPIA_ACCESS_TOKEN` as the client ID.

Hardcoded values:
- There are no store or branch ids. Branch is implicit: `funtopia_*` tables mean Floresta.
- Kid base prices 393, 486, 645, 832 and 778, and the adult price 327.10 (`funtopia.ts:6650-6657`).
- Category and keyword lists (`6992-7005`, `7469-7486`).
- Birthday keywords and regexes (`3409-3453`).
- Excluded product id `431415`.
- Voucher face-value seeds (`1544-1556`).
- Birthday override seeds (`563-599`).
- The cash report array (`8635-8780`).
- The source regexes (`sourceRegistry.ts:6-28`).
- Fifteen wallet-pass code-to-channel mappings (`sourceRegistry.ts:44-66`). I have not reproduced the codes.
- Opening hours 10 to 20 (`posStaleness.ts:30-33`).
- A 20:45 close, a 45-minute grace and a 4 h 30 m drop-off window (`funtopia.ts:6912`, `6941`, `6976`).
- The default sync start date `2026-01-01`.

## 8. Fragile, surprising or undocumented

1. **The single-day read path stamps the new version without recomputing.**
   - `funtopia.ts:5511` writes the new `formulaVersion` before the rebuild check at `5527`.
   - A stale day read through this path is marked current and never recomputed.

2. **A wallet-pass fetch failure wipes the day's attribution.**
   - A failed fetch is swallowed and returns an empty list.
   - `storeWalletPasses` then deletes that date's rows (`funtopia.ts:4746-4750`, `4819-4823`, `1327`).
   - Attribution stays lost until the next successful sync or boot backfill.

3. **"Net Revenue" subtracts vouchers twice.**
   - The chart builder and AI assistant compute `totalRevenue − Voucher`.
   - `totalRevenue` already excludes vouchers (`routes.ts:2985`, `2595`).

4. **The chart builder's card metric is always 0 for Floresta.**
   - It reads `paymentBreakdown["Credit Card"]` (`routes.ts:2998`).
   - The code emits the key `"Card"`.

5. **Possible connection-pool deadlock.**
   - The advisory lock holds one pooled connection. The rebuild queries run on other pool connections.
   - In `getDateRangeSummary` (`funtopia.ts:6489-6509`), many failed-stale rows each wait for the lock concurrently.
   - With a pool of 10, the waiters can use every connection and starve the lock holder.

6. **`docs/FUNTOPIA_DATA_CALCULATIONS.md` is outdated.**
   - It documents the old `payment_price` revenue definition.
   - It says "today" is fetched live. `/api/funtopia/today` actually reads the cache (`routes.ts:1011-1061`).

7. **Broken and dead code.**
   - `getDailyProductDump` is broken. It calls `.filter` on the object that `fetchAllPages` returns (`funtopia.ts:5794-5803`).
   - Dead code: `fetchRangeWithChunking`, `extractDate`, `attributeOrdersByVoucherChannels`, `syncDailySummary`.
   - The `forceAll` parameter is logged but never used.
   - `shared/vat-utils.ts` is not imported by this pipeline. It is a leftover from the HR app.

8. **Adult counts are computed two ways.**
   - Daily adult counts come from `guestBreakdown`.
   - Range adult counts are rebuilt from `customerTypeSplit`.
   - The two can disagree.

9. **Pisell fields drift silently.**
   - `redeem_amount` changed from negative to 0.00 in June 2026 and dropped redemptions for months (`funtopia.ts:1404-1412`).
   - Keep `raw_json` and re-inspect its keys before trusting any "field unavailable" conclusion.

10. **Reporting feed lag.**
    - Per the project's memory note, Pisell's reporting feed lagged the admin UI by 30 minutes or more.
    - A faster poll interval does not fix that.

**Undetermined**
- Token lifetime.
- The Pisell report date-filter semantics. Evidence says it is not purely `created_at`.
- The wallet-pass payload field list.
- The meaning of product `431415`.
- The earliest stored date and the real data volumes.
- Which database the audit examined.
- How voucher redemption changes `payment_price`.

Other files worth opening:
- `exports/floresta_aug2026_pisell_direct_audit.json`. Its top-level keys are `audit`, `api`, `sourceRows`, `liveBirthdayTotals`, `discounts`, `events`, `focusDates`, `cacheComparison`, `coverageByDate` and `overrides`.
- `.agents/memory/pos-birthday-audit-cautions.md`. It documents the dev-versus-published data gap and the duplicate product payloads.
