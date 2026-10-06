# Analytics, Today > Performance and the booth report: the build plan for S2-15b (DRAFT)

_Draft 2026-10-06, SCRUM-216. Not committed. Built from a read of the
prototype (imports/oto-pos/artifacts/oto-till/src) and of main. The owner
rule applies: the prototype's rules are ported as they are; only
data-reliability fixes are made on our own authority; rule choices the
prototype does not settle are listed in section 9 as questions, with the
prototype's behaviour as the default until answered._

## 1. What the park sees

- **Today > Performance** (till and mobile) looks exactly as it does now:
  the Revenue card with "N transactions" and "excl. ฿X paid via credit",
  Guests checked in (kids / adults), Parties today, Drop-off kids in park,
  the five revenue bars (Tickets, F&B, Merch, Parties, Drop-off) and the
  ticket mix (1 hour, 2 hours, Full day). The difference is that the
  figures now come from the platform, are the same on every till and phone,
  and survive a reload. Today's figures refresh within the rollup interval.
- **One added control:** a branch picker option "All branches", shown only
  to someone who can read analytics on more than one branch. It shows the
  sum of the branch rows.
- **Admin > Reports** (Sales, Profitability, Discounts and Comps, Tax and
  VAT) stop being browser-only mock panels and read the platform's daily
  rows. Same panels, same columns, same CSV buttons. The Wallet and Promo
  panel already reads the platform and is unchanged.
- **Console > Booths > Report** (new, no prototype screen): the booth
  funnel by day, booth, staff and prize; redemption rate, lag, uptime and
  prize cost; CSV.
- **Health:** a "Run now" control for the daily rollup (like the demo-day
  control) and the time of the last rollup per branch.

## 2. The reference

- `mockApi.ts` getFloorReport (2032-2145): the one per-day figure set.
  Both `components/floor/PerformanceTab.tsx` and
  `components/mobile/today/MobilePerformanceTab.tsx` call it and re-derive
  nothing. `pages/Today.tsx` owns one date picker and the branch.
- `components/floor/RevenueBars.tsx`, `StatCard.tsx`: bucket order,
  percentages, bar widths, colours.
- `lib/reporting.ts` and `components/admin/reports/*`: the five manager
  panels.
- `lib/pricingMode.ts` (weekday / weekend / holiday), `lib/sale.ts` and
  `lib/tax.ts` (totals and the tax breakdown, re-derived, never stored).
- On the platform today: `apps/pos/src/mockApi.ts` getFloorReport is a
  byte-identical copy, fed by a per-browser mirror (Till.tsx:2640,
  OrderStation.tsx:1197, MerchStation.tsx:572 call recordSale /
  recordFnbOrder / recordMerchOrder after the platform sale commits). Only
  "Drop-off kids in park" is live (boardApi.today().inPark).

Where the prototype has nothing (booth report, marketing channel, hourly
rows, the All-branches merge, Radar's feed), the S2-15b ticket and the
S2-18 Radar contract (SPRINT_2_PLAN.md 2349-2394, 2609-2696;
DEVELOPMENT_PLAN §3.8, §6.2) define it.

## 3. The prototype behaviour, ported as it is

Formula version 1 is the prototype's Performance rule. Every
`daily_summary` row records `formula_version = 1`.

| Figure | The prototype's rule (kept) |
|---|---|
| Revenue | Tickets + F&B + Merch + Parties + Drop-off, the sum of the five bars. Gross of VAT and service charge, after discounts and comps (the sale total already carries them). |
| Tickets / Drop-off | Per sale: max(0, sale total − refunds). The whole sale goes to Drop-off if any line is the drop-off service; otherwise the whole sale goes to Tickets. Never split by line. |
| F&B and Merch | Money taken other than credit: cash + card + QR (and configured other tenders) minus the cash part of refunds (refund − credit restored). Floor at 0. Credit spent is not revenue here: it was counted when the ticket or top-up was sold. |
| Paid via credit | Shown only when above 0: credit used on F&B and merch minus credit restored by their refunds. |
| Transactions | Ticket sales + F&B orders + merch orders + party payments. A fully refunded sale still counts. A 100% comp counts. |
| Guests checked in | Bands issued on the day's ticket sales (children, adults), not people at the gate. Drop-off check-ins issue bands and count. |
| Ticket mix | Guests (kids + adults) per ticket line by the ticket type's hours: 1, 2, 3 or more ("Full day"). Service lines skipped; promo stub lines add 0. |
| Parties | Count of parties held on the date at the branch. Party revenue = party payments taken on the date for parties held on that date. |
| Drop-off kids in park | Live, not date-bound; same number on any picked date. Stays a live read, not a rollup figure. |
| Refunds | Netted on the original sale's day (they hang off the sale). Matches End of Day and Radar v30. |
| Revenue bars | Fixed order Tickets, F&B, Merch, Parties, Drop-off; pct = round(amount / total × 100); bar width relative to the largest bucket. |
| Empty state | "No sales recorded for today / this day yet." when revenue and transactions are both 0. |
| Weekday / weekend | Recomputed from the date and the branch holidays with the pricing resolver, never stored on the sale. |
| Tax and VAT | Re-derived with the platform tax resolver, never a separate stored figure. |
| Reports panels | As in lib/reporting.ts: revenue by category (gross, with tax and service), payment mix, sales by tier, ticket type breakdown, weekday / weekend split, drop-off sessions, top 15 F&B and merch items, profitability with the "margin is understated" banner, discounts and comps (five tiles, by type, by operator, per code), VAT summary by day or month and the bulk tax-receipt rows. Each with CSV. |

## 4. Fixed, because the prototype's figures come from the wrong place

These are data-reliability fixes, not rule changes:

- **Wrong calendar day.** The prototype slices the UTC date, so 00:00 to
  07:00 in Phuket lands on the previous day. The platform uses the
  branch's business date, which every sale, line, attempt and wallet entry
  already carries (day start `branch.business_day_start`, default 05:00).
  This is the same fix End of Day already made.
- **Records with no branch counted in every branch.** Impossible on the
  platform (branch_id is required); it would double-count in an
  All-branches merge, so the merge sums branch rows only.
- **Ticket hours from the active branch's catalog.** The platform reads
  the hours carried on the sale line (`stay_hours`), recorded at sale time.
- **Guests multiplied by units.** `pos.sale_line` is one row per unit and
  carries kid / adult counts on every unit. Guests and ticket mix are
  summed once per cart line (or from bands issued), never over units.
- **Voided and unfinished sales.** Only finalised and refunded sales count;
  tendering and voided never do. A refunded sale counts net of its refund.
- **A booking counted twice or not at all.** A booking-site sale counts
  once, as revenue on its own business date. Its redemption at the till
  (the paid_online tender) is not counted again. Revenue reads sales, not
  End of Day's till-takings filter, which drops booking money.
- **Figures that vanish on reload.** Rows are stored; every till and phone
  sees the same figures.
- **Demo sales in the real park.** The staging demo-day control's sales
  are kept out of HKT Central's rows (see question 12 and hazard H11).
- **Simulated booth spins** never reach the booth figures.
- **Estimated event revenue.** The prototype's estimate (attendees ×
  today's entry price) is not ported; event and camp pass money is read
  from the sales that took it.

## 5. From S2-15b, where the prototype has nothing

- `daily_summary` per (branch, business_date, source) with
  `formula_version` and `by_channel`; the open day is written as a
  provisional row and replaced as the day fills.
- `hourly_summary` (the same money buckets per hour) for the Radar
  15-minute refresh and the hourly chart in Radar.
- `dirty_date` queue: any late fact marks its day at the moment it lands.
- `dim_date` from `branch_holiday` (weekday / weekend / holiday per branch
  per day).
- `fact_booth_daily`: spins, vouchers issued, vouchers redeemed, redemption
  rate, mean lag, uptime, prize cost, by booth, staff and prize.
- `branch_source_switch`: which source a branch reports (`oto_pos`,
  `pisell`, `papaya`) and Radar's preference; read by S2-18.
- `by_channel`: revenue by marketing channel, from redemptions
  (`promo.voucher_redemption` kind consumed → `promo.voucher.source`).
  "Sales Booth" = the sales that redeemed a booth voucher.
- `GET /analytics/summary?branches=a,b&from&to&group=day|total`, merged on
  the server, `analytics:read` per branch. Unpermitted branches are left out
  and listed in the answer as `omitted`, never folded into a total. The
  answer carries each branch's timezone and day start.
- Two frozen legacy fixture days (source `pisell` and `papaya`) and "Demo
  Branch 2" with one day of sales in `seed:demo-day`.

## 6. Known effects of following the prototype

Flagged, not changed:

- **Performance and a closed End of Day can differ.** A refund of an old
  sale reduces that sale's day; if End of Day for that day is closed, its
  saved figures stay as they are while Performance moves. Performance
  shows a small "End of Day closed at ฿X" note under Revenue for a closed
  day whose figures have since moved. The closed day is never rewritten.
- **Different revenue views on purpose.** Today / Performance is money in,
  net of refunds, without credit spend. Reports "Revenue by category" is
  gross taxable sales, not refund-netted, and includes credit-paid orders.
  End of Day includes the credit line in its total. All three are kept as
  the prototype has them, each labelled; they are never added together.
- **Party timing.** A deposit taken earlier for today's party, or a payment
  today for a future party, appears on neither day.
- **Parties bucket is 0 until S2-20/21.** The platform has no party
  payments yet; the bucket and count stay at 0 rather than show mock data.

## 7. The data model (migration 0063)

All tables in the `analytics` schema, all with operator_id and branch_id,
created_at / updated_at, indexes on every FK and lookup column. Writes only
from the jobs process.

- `analytics.daily_summary`: unique (branch_id, business_date, source).
  formula_version, provisional bool, computed_at, the five buckets (satang),
  revenue, txn_count, credit_paid, guests_kids, guests_adults, mix_1h,
  mix_2h, mix_full_day, parties_count, refunds_satang, discounts_satang,
  comps_satang, vat_satang, service_satang, `by_channel` jsonb (channel →
  {revenue, txn_count}), input_fingerprint (to skip unchanged rewrites),
  frozen bool (legacy fixture days).
- `analytics.hourly_summary`: unique (branch_id, business_date, hour,
  source), the five buckets, revenue, txn_count, guests.
- `analytics.daily_category_summary`, `daily_tender_summary`,
  `daily_item_summary`, `daily_discount_summary`: the Reports panels' rows
  per (branch, business_date, key). Detail per transaction (the
  per-transaction discount rows and the bulk tax-receipt export) is read
  from the sales tables through a dedicated, date-bounded report query,
  since a per-transaction list is not a summary (see question 13).
- `analytics.fact_booth_daily`: unique (branch_id, business_date, booth_id,
  staff_account_id, prize_id). spins, vouchers_issued, vouchers_redeemed,
  redemption_lag_sum_s, uptime_s, prize_cost_satang.
- `analytics.dim_date`: unique (branch_id, date). weekday, rate_mode
  (weekday / weekend / holiday), holiday_name.
- `analytics.dirty_date`: unique (branch_id, business_date, kind) where kind
  is sales / booth / wallet; marked_at, reason, claimed_at, claimed_by.
- `analytics.branch_source_switch`: unique (branch_id). source, preference
  (for Radar), switched_at, actor.
- `fact_occupancy_15min` and `fact_wallet_liability_daily` already exist
  and are not changed; the wallet liability job gains the dirty-date hook.
- Env: `ROLLUP_INTERVAL_S` (default 300) in env.ts, `.env.example` and
  render.yaml.

## 8. The rounds

| Round | Scope | Acceptance |
|---|---|---|
| 1 | Migration 0063. The revenue-category check: every line kind (ticket, drop-off service, event / camp pass, F&B item, merch item, stored value) gets a non-null revenue category, with a backfill for existing rows. The `dirty_date` hook at every fact write: sale finalise and void, refund, payment settle, wallet entry, and the sync apply path (a late offline sale marks its own business date). `dim_date` filled from branch holidays. | Migration runs clean twice from empty. A test per call site asserts the dirty row. A box sale synced two days late marks the sale's business date, not the arrival date. |
| 2 | `job:rollup.daily` and the hourly summariser under `PROCESS_ROLES=jobs`, advisory lock, `ROLLUP_INTERVAL_S`. Each run: today (provisional), the dirty days it claims, and ended days not yet rolled. Formula version 1 per section 3, with the fixes in section 4. Upsert only when the fingerprint moved; frozen rows are never touched. Health "Run now" and "last rollup". by_channel with "Sales Booth". | HKT Central / today / oto_pos row exists with formula_version 1. Row figures equal a direct SQL sum over the same sales (test, including refunds of old sales, a credit-paid F&B order, a booking and its redemption, a voided sale, a multi-unit ticket line). "Sales Booth" equals the redeemed booth vouchers' sales. A late offline sale is corrected on the next run. Two runs in parallel produce one row. |
| 3 | `GET /analytics/summary` (route, zod, OpenAPI, `analytics:read` per branch, omitted branches listed). Today > Performance and the mobile twin on the endpoint, look and words unchanged; the per-browser mirror (recordSale / recordFnbOrder / recordMerchOrder) removed from the Performance path. "All branches" option. The closed-day note. "Demo Branch 2" in seed:demo-day. | Merged total for HKT + Demo 2 equals the sum of the two rows (test). Performance figures equal the row (test). A caller without analytics:read on Demo 2 sees HKT only and `omitted: [Demo 2]`. Screenshots: Performance, All branches, the Raw record. |
| 4 | The Reports panels (Sales, Profitability, Discounts and Comps, Tax and VAT) on the daily report rows and the dedicated report query, with their CSVs; `localOnly` removed. | Each panel's totals equal a direct SQL sum for a seeded range (test). CSV downloads. |
| 5 | `fact_booth_daily` and Console > Booths > Report: funnel by day, booth, staff, prize; rate, lag, uptime, prize cost; CSV. Simulated spins excluded. | The demo day's funnel, rate and prize cost shown; CSV downloads; a simulated spin changes nothing (test). |
| 6 | The two frozen legacy fixture days, `branch_source_switch`, the closing audit, the staging walkthrough, Jira evidence. | Re-running the loader and the rollup leaves the fixture rows byte-identical (test). Walkthrough screenshots per the ticket's QA steps. |

Permissions: `analytics:read` (exists) guards the summary route, the
Reports panels and the booth report, per branch. Performance on the till
is shown to whoever can open Today today; see question 9.

## 9. Questions for Tony (the prototype's behaviour is the default)

1. **Which day is "today"?** Prototype: the UTC date. Default on the
   platform: the branch's business date (data-reliability fix, as End of
   Day). Confirm, and confirm the 05:00 day start.
2. **Camp and event passes:** Performance sweeps them into Drop-off; the
   Reports module keeps them out of Drop-off. Default: the Reports rule
   (only the drop-off service is Drop-off), passes stay in Tickets. Should
   passes have their own bar? Default: no, five bars as now.
3. **Party money timing:** payments taken on the date for parties held on
   that date only (default), or all party payments taken on the date?
4. **Refund of an old sale:** reduces the original sale's day (default),
   including after that day's End of Day is closed?
5. **Revenue with VAT and service charge** (gross, default) or without?
6. **Credit:** counted at the ticket sale, spend excluded (default). What
   happens to expired credit (no rule in the prototype; default: nothing,
   it stays counted at sale)?
7. **Which formula a branch reports:** formula version 1 = the prototype's
   Performance rule (default). Open decision 15 says Radar's own formulas
   (v30 Pisell, v21 Papaya). The ticket says formula_version 1. Default:
   version 1 for OTO POS branches; legacy sources keep their own version.
8. **Provisional today in Radar:** shown and labelled (default), or closed
   days only?
9. **Who sees Performance and All branches:** prototype lets anyone who
   opens Today see Performance. Default: same for one branch; All branches
   only across the branches a person holds analytics:read on.
10. **Wallet report scope:** network-wide (default, bands carry no branch).
11. **Booth vouchers on End of Day:** typed by hand (default). Should the
    booth figures be shown beside the typed counts for comparison?
12. **The staging demo button** adds sales to the real HKT Central. Default
    proposed: demo sales go to Demo Branch 2 only. (This is already on the
    Tony question list from the Jira tidy-up.)
13. **Reports per-transaction lists** (discount rows, tax-receipt export)
    are not summaries. Default: read through a date-bounded report query
    (the "analytics endpoints only" line read as "no live sales queries
    from the browser").
14. **Booth report figures with no prototype rule:** redemption lag
    (issue to redeem), uptime (heartbeat minutes), prize cost (prize cost
    price × prizes won). Defined by plan; confirm.

## 10. Hazards, each with its test

| # | Hazard | Test |
|---|---|---|
| H1 | Business day: a 00:00-05:00 sale on the wrong day; mixed day starts in a merge. | Sale at 02:00 Bangkok lands on the previous business date; merge answer carries each branch's day start. |
| H2 | Branch leak: a total includes a branch the caller cannot read. | Summary for two branches with permission on one: one row, the other listed as omitted, totals equal the permitted row. |
| H3 | Refund of a sale outside any look-back window is missed. | Refund a 10-day-old sale: dirty row for that day; next run corrects it; a closed End of Day for it is unchanged. |
| H4 | Credit counted twice (grant plus spend) or credit-paid orders dropped. | Ticket with credit grant, then F&B paid by credit: revenue counts the ticket once, F&B 0, paid-via-credit = spend. |
| H5 | Late offline sale after its day rolled or closed. | Sync a two-day-late box sale: its day is marked dirty on insert and corrected on the next run. |
| H6 | Guests multiplied by units. | One cart line of 3 kid units: guests = 3, not 9. |
| H7 | Voided or tendering sales counted; refunded sale counted as 0. | Voided and tendering excluded; a partly refunded sale counts net. |
| H8 | Booking counted twice or lost. | Booking sale + till redemption: counted once, on the booking's date. |
| H9 | Two job instances write twice. | Two concurrent runs: one row, one ops_run claim. |
| H10 | Frozen legacy days rewritten. | Re-run loader and rollup: fixture rows byte-identical. |
| H11 | Demo-day sales reach HKT Central figures. | Demo control writes only to Demo Branch 2 (or flagged rows are excluded). |
| H12 | Simulated spins in booth figures. | A simulated spin leaves fact_booth_daily unchanged. |
| H13 | Lines with a null revenue category fall out of the buckets. | After backfill, no finalised line has a null category; bucket sum = revenue. |
| H14 | Member data in the summary or logs. | Summary schema has no member fields; ops_run detail holds counts only. |
| H15 | Whole-sale Drop-off rule lost (split by line). | Sale with a ticket line and a drop-off line: whole sale in Drop-off. |
