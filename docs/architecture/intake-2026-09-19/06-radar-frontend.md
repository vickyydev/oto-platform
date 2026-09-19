<!-- Read-only analysis of the imported Replit export, 2026-09-19. File references are relative to the export under imports/ (local only, not in git). No secret values are recorded here - variable names and locations only. -->

> **OTO Radar — frontend dashboard** - intake analysis, 2026-09-19. Markers: [V] verified by reading code, [I] inferred, [U] unknown.

# OTO Radar frontend analysis for re-platforming

Snapshot: git `2fbd4deb`, 2026-09-19. Read-only; nothing was run or modified, and no secret values were printed.

**Method.** I read these directly:
- `App.tsx`, `main.tsx`, `queryClient.ts`, `staff-gate.tsx` and the root configs
- `lib/paceForecast.ts`, `lib/plannerModel.ts` and `lib/dashboardDateRange.ts`
- the main component (`funtopia-dashboard.tsx` lines 11739–15354)
- the forecast model, `mergeDashboardData`, the calendar data layer, the pace helpers and the planner wiring

The rest of the 15,354-line file was read line by line in seven sections, plus the other pages and components. Surprising claims were spot-checked in code or git history.

**Tags.** [V] means read in code. [I] means inferred. "FD" is `client/src/pages/funtopia-dashboard.tsx`.

## 0. Headlines

1. **There is no authentication anywhere.**
   - `StaffGate` exists but is imported by no page (`staff-gate.tsx:12`).
   - The server's `requireStaff` is never applied to any route. This covers sync, locked months, production push and production wipe [V, light server check].
   - `client/public/robots.txt` says `Allow: /`.
2. **Tab deep-links to `#events` and `#accounting` do not restore.** Seven tabs are rendered (FD:13757-13805). The hash-restore whitelist at FD:11746 lists only six values, including a dead `weekly` and missing `events` and `accounting` [V].
3. **The voucher face-value → channel editor is dead code.**
   - It sits at FD:3449-3791.
   - It was unmounted on 2026-04-29 by commit `109bc69b` "Remove manual voucher to channel mapping configuration" [V via git].
   - `replit.md` still advertises it.
4. **About 1,900 lines (~12%) of the big file are dead.** Dead components [V]:
   - `RevenueComparisonChart`, referenced only in a JSX comment at FD:14445-14449
   - `DailyRevenueChart`, `HourlyActivityHeatmap`, `DiscountBreakdownCard`, `CustomerTypeSplitCard`, `CollapsibleSection`
   - the Unattributed drill-down and its dialog, which are unreachable because the bucket is filtered out at FD:2598
5. **The main dashboard data never auto-refreshes.**
   - `refetchToday()` is called only after sync, process or resync handlers [V grep].
   - Only three things poll: POS staleness every 5 min, the source watchdog every 60 min, and the survey every 30 s while its card is open.
6. **The forecast model, all targets, the pace forecast, the planner, holiday tables and the multi-branch merge are computed in the browser.** They use hardcoded constants, including the ฿4,929,457 (Floresta) and ฿700,000 (Chalong) base months at FD:573-634.
7. **Several hardcoded 2026 lunar holidays are wrong, and they feed the pace model.**
   - Chinese New Year is listed as 25–26 Jan, Makha Bucha 17 Feb, Visakha Bucha 15 May and Asalha Bucha 13 Jul (FD:210-349) [V].
   - My recollection is that the real 2026 dates are about 17 Feb, 3 Mar, 31 May and 29 Jul [I; check against an official calendar].
   - They feed the model's holiday uplift through `isEventDay: hasAnyHoliday` (FD:6589, 6930) [V].
8. **Branch logic is strictly two branches and two POS systems.**
   - Endpoint families differ: `/api/funtopia/*?start&end` versus `/api/papaya/*?from&to`.
   - The merge takes exactly two inputs.
   - There are about 134 `hasFloresta`/`hasChalong`-style checks.
   - Branch scope is written three ways: `"chalong,floresta"`, `"chalong+floresta"` and `"all"`.
9. **Code-path hazards in the combined view.**
   - The live-today hourly merge mixes Floresta's 72 twenty-minute slots with Chalong's 24 hours, so Chalong's hours fall outside the chart windows.
   - The future-month baseline lacks the last-year scope guard (FD:6947-6958).
   - From December 2026 the combined target double-counts Floresta's last-year revenue.
10. **The project's own doc says `tsc` reports about 70 errors and builds do not typecheck.** The big file has 129 `any` occurrences, and the UI reads several fields that no interface declares: `ongoing*`, `freeAdults`, `channelBreakdown` and `subCategories`.
11. **Some root files are leftovers from the HR fork and should be ignored.**
    - `README.md`, `design_guidelines.md`, the Playwright `tests/`, about 60% of `package.json` dependencies and 34 of the 55 shadcn `ui/` files are leftovers.
    - `replit.md` and `docs/FUNTOPIA_DATA_CALCULATIONS.md` are the real docs, and both are partly stale.
12. **The UI is English-only.** No Thai script appears anywhere in `client/`; only the "฿" sign. There is no i18n layer. `shared/localization.ts` is unused.

## 1. Routing and authentication

| Route (`App.tsx:31-37`) | Page | Audience | Client gating |
|---|---|---|---|
| `/survey` | `visitor-survey.tsx` | Public or kiosk customers | None |
| `/c/:id` | `qr-landing.tsx` | Public customers (campaign QR voucher) | None; the server sets a per-device cookie |
| `/redeem` | `qr-redeem.tsx` | Reception staff, deliberately public (memory note `public-reception-redemption.md`) | None |
| `/tax-invoices` | `tax-invoices.tsx` | Back-office, Chalong only | None |
| anything else | `funtopia-dashboard.tsx` (lazy) | Management | None |

- **Routing and tab state.**
  - Routing is wouter 3.
  - The dashboard tab is a Radix `Tabs` state, mirrored into the URL hash with `replaceState` (FD:11743-11758).
  - Tabs rendered: Dashboard (`today`), Calendar, Trends, Events, Campaigns, Accounting, Config (FD:13757-13805).
  - The Trends tab is `forceMount`ed (FD:14458). The others remount on each visit and lose local state.
- **Auth plumbing.**
  - `apiRequest` and the default `queryFn` send `credentials:"include"`.
  - 401 responses are turned into `null` (`queryClient.ts:49-75`).
  - Many raw `fetch` calls omit `credentials` (FD:2514, 5319, 8079, 8321, 8570, 9857, 11205, 11917).
  - That works only because the API is same-origin. A separate API origin behind SSO will break these.
- **Header link.** The sticky header carries a "Redeem" link to `/redeem` (FD:13230-13247).

## 2. Dashboard map

### 2.1 Global bar (FD:13194-13863, always visible)

| Element | Data source | Fields |
|---|---|---|
| Branch toggle "Floresta/FL", "Chalong/CL" (13202-13226) | localStorage `oto_branches` | None |
| Live / Offline / Syncing pill and panel (`SyncStatusToggle`, 10683-10855) | `GET /api/funtopia/sync-status` when Floresta is selected; `GET /api/papaya/sync-status` when Chalong is selected (11979-12034) | `funtopiaConnected`, `lastSyncedAt`, `lastFullSyncAt`, `cachedDates`, `earliestDate`, `latestDate`. No staleness threshold. In both-branch mode it shows Floresta's cached range only. |
| Period selector: today / yesterday / week / month / custom, with prev/next offset (13266-13382) | Client state; `getTodayPeriodDatesWithOffset` (6137-6210) | Week starts Monday. At offset 0, week and month end today (to-date). |
| Holiday badges (13391-13415) | Hardcoded tables (FD:210-448) | None |
| In-park pill (13419; Floresta and live today only) | The `/today` response | `guestBreakdown.ongoingKids/ongoingAdults/ongoingTotal/totalInPark`. Park hours are hardcoded 10:00–20:45 (10882). |
| Compare popover (13422-13550) | Range fetch under key `["/api/branch/range", branchKey, start, end, "compare"]` (12182), staleTime 10 min | Options depend on the period. "vs Model Forecast" is hidden when Chalong-only. "vs Same Time Last Year" shows only when Chalong is selected. |
| Voucher toggle "A→Tickets / A→F&B" (13551-13576) | Client only | `paymentBreakdown.Voucher` plus Chalong "parent credit" items (13130-13146) |
| Birthday toggle(s) "BD→Bday / BD→Tix/F&B" (13577-13689) | `GET`/`PUT /api/funtopia/preferences/birthday-allocation` with `{branch:"chalong", allocation:"bday"\|"split"}` (11824-11868) | `birthdayLinks.partyFnbRevenue`, `birthdayMovedAmount`, `birthdayChannelSplit` |
| Delta mode "%" / "#" (13692-13703) | Client state | None |
| POS staleness banners (13810-13830) | `GET /api/pos-staleness`, polled every 5 min (11998-12000) | `alerts[].{branch, branchLabel, stale, message}` |
| Source-gap notice (13832-13863; Floresta) | `GET /api/funtopia/source-watchdog`, polled every 60 min (12024-12027) | `alerts[].{source, lastSeenDate, consecutiveZeroDays, activeDaysInWindow, windowDays}` |

### 2.2 Dashboard tab (`today`, FD:13866-14443)

**Main data queries.**

| Query | Key | Fetches | Options |
|---|---|---|---|
| Live today | `["/api/branch/today", branchKey]` (11948-11954) | `/api/funtopia/today` and/or `/api/papaya/today` | staleTime 5 min, no polling; `placeholderData` keeps the previous data. After a branch toggle the previous scope's numbers show until the new fetch lands. |
| Other periods | `["/api/branch/range", branchKey, start, end]` (11965-11977) | `/api/funtopia/range?start=&end=` and/or `/api/papaya/range?from=&to=` | Same options; enabled when not live today |

- When both branches are selected, the two results are merged by `mergeDashboardData`.
- The full response shape is `DashboardSummaryData` (FD:1536-1605).

| UI element | Endpoint | Fields consumed |
|---|---|---|
| Tile "{Period} Revenue" (13939-13973) | Main | `totalRevenue`, `dailyRevenue[].date`, `cashReportsDailyTotals[]`, `paymentBreakdown.Voucher` |
| Sync-health badge with "Re-sync" (13974-14124) | `GET /api/funtopia/sync-health?dates=csv` and `GET /api/papaya/sync-health?dates=csv` (12778-12817), staleTime 60 s. `POST /api/funtopia/resync-date {date}` and `POST /api/papaya/resync-date {date}` (12819-12846). | `health[].{date, status, ordersExpected, ordersReceived, errorMessage, warnings, revenueDivergence{cached, fresh, diff}}` |
| Tile "Avg. Order Value" (14126-14148) | Main | `totalRevenue`, `totalOrders`, `avgOrderValue` |
| "Guest Overview" (`GuestBreakdownCard`, 1624-1965) | Main | `guestBreakdown.{kidTickets, adultTickets, estimatedTotalAdults, kidRevenue, adultRevenue, totalInPark, avgStayHours, stayDistribution[]}`, `customerTypeSplit[]` including the undeclared `freeAdults` |
| "Revenue by Category" (2477-2715) | Main | `categoryBreakdown{revenue, quantity, items[], subCategories}`, `birthdayLinks`, `birthdayChannelSplit` |
| "Ticket Revenue by Source" (3793-4012; Floresta) | Main | `sourceBreakdown[].{source, orders, revenue, discount, variants[]}` |
| "Activity Heatmap" (`MultiDayHeatmap`, 4597-4925) | Main | `dailyHourly[]` or `hourlyBreakdown[]` with `{hour, orders, revenue, ticketsSold, summerCamp}` |
| "Performance Graph" (5707-6119) | Main | `hourlyBreakdown[]` for a single day; `dailyRevenue[].{revenue, kids, adults, categories, customerTypes}` for ranges |
| "Sales Insights" (1216-1365) | Main | `paymentBreakdown`, `topProducts[]` |
| "Discount Breakdown" (1059-1214) | Main, plus a lazy drill-down to `GET /api/papaya/orders-by-discount?from&to&discount` (1103). The drill-down is Papaya-only. | `discountBreakdown[]`; `orders[].{time, channel, revenue, discountTotal, items, payments}` |
| "Daily Adjustments & Audit" (11159-11545; single day, Floresta) | `GET /api/funtopia/adjustments?date=` | `summary`, `redFlags[]`, `adjustments[]` |
| "Visitor Survey" (11574-11737) | `GET /api/visitor-survey/summary?date[&end]`, polled every 30 s while open | `overall`, `perBranch`, `visitorTypes`, `discoveryChannels`, `branches` |
| Order dialogs (2367, 2864) | `GET /api/funtopia/order/:id`, staleTime 60 s | `order`, `items[]`, `payments[]` |

### 2.3 Other tabs

| Tab / element | Endpoint(s) | Notes |
|---|---|---|
| **Calendar** year heatmap, month cards, month detail, day dialog (9816-10657, 6497-7493) | `GET /api/funtopia/calendar-range?start&end` and `GET /api/papaya/calendar-range?from&to` (9848-9882), staleTime 10 min | Fetches a 24-month window, from (year−1)-01-01 to year-12-31. Fields: `dailyRevenue[].{date, revenue, orders}`, `cashReportsDailyTotals[]`. The default year is the literal `2026` (9830). |
| Calendar notes | `GET /api/funtopia/calendar-notes?start&end`; `POST {date, note}` (9884-9931) | An empty note deletes the row. Notes are keyed by date only, with no branch. |
| Staff birthdays | `GET /api/staff-birthdays?branches=` (`birthdays-widget.tsx:41-54`), staleTime 1 h | `name`, `birthMonth`, `birthDay` |
| Pace snapshots | `POST /api/pace-snapshots` (6443); `GET /api/pace-snapshots/:branch/:month` (6968-6971) | Body: `{date, branch, forecastRevenue, revenueToDate, elapsedDays, target, model}` |
| Revenue Planner (`revenue-planner.tsx`) | `GET`/`PUT /api/planner/target`, `GET`/`PUT /api/planner/plan`, plus three month-window `/range` fetches per source (:122-244) | Target body: `{branch, month, target}`. Plan body: `{branch, month, values, projectedRevenue, target}`. |
| **Trends** (9449-9814) | `POST /api/funtopia/trends-parse {message, today, previousChart}`; `POST /api/funtopia/chart-builder {metrics, groupBy, chartType, dateFrom, dateTo, aggregation, branches}` (9507-9530, 9575-9583) | Response: `{data[], series[], rawBreakdown}`. Six presets bypass the language model (7596-7603). The metric catalogue is at 7495-7572. Saved chats live in localStorage `oto-trends-history`, capped at 20. |
| **Events** (8527-9447) | `GET /api/events/range?from&to&branch=all\|floresta\|chalong` (8567-8577), staleTime 60 s | `events[].{date, branch, partyOrderId, partyOrderCode, packageName, packageRevenue, fnbRevenue, otherRevenue, reconciliationRevenue, totalRevenue, entertainmentItems[], link}` |
| Events "Link F&B" (Floresta only) | `GET /api/events/candidates?date&partyOrderCode&branch=floresta`; `POST`/`DELETE /api/events/link` (8076-8127) | Writes a manual override and rebuilds the day's summary |
| Events "Refresh POS" (Floresta filter only) | `POST /api/funtopia/sync {mode:"full", start, end, force:true, exactReportDates:true}`; polls `/api/funtopia/sync-progress` every 2 s (8321-8403) | No time-out |
| Events exports | None; client-side only | `xlsx` and `jspdf` are dynamically imported (8693-9146) |
| **Campaigns** (`campaigns-tab.tsx`, lazy) | `GET /api/campaigns/stats` (30 s poll); `GET /api/campaigns/timeseries?start&end&granularity`; `GET /api/booth/claims` (30 s poll); `POST`/`PATCH`/`DELETE /api/campaigns[/:id]` | Uses the dashboard's period and compare range |
| **Accounting** (14497-14678) | `GET /api/funtopia/reports/cash-collections?from&to` and `GET /api/funtopia/reports/detail-transactions?from&to`, both xlsx blobs; a link to `/tax-invoices` | Floresta reports; Chalong tax invoices |
| **Config** (14681-15350) | `GET /api/sync-status/overview` and `GET /api/sync-status/calendar?year&month` (`sync-status-section.tsx`); `GET /api/funtopia/product-registry`; `GET /api/funtopia/locked-months`; `GET /api/funtopia/formulas` (12043) | Write actions are listed in §5 |

**Other pages.**
- **Tax invoices:** `GET /api/papaya/invoices?from&to[&terminal]`, and `GET`/`PUT /api/papaya/invoice-settings`.
- **QR landing:** `POST /api/public/campaigns/:id/qr` and `POST /api/public/qr/:token/saved`.
- **Redeem:**
  - `GET /api/spin-wheel/rewards`
  - `GET /api/spin-wheel/report`
  - `POST /api/spin-wheel/redeem {code}`
  - `POST /api/qr/redeem {code|token, redeemedBy?}`
- **Survey:** `GET /api/visitor-survey/branches` and `POST /api/visitor-survey {branch, visitorType, discoveryChannel}`.

## 3. Metric definitions: browser versus server

**Computed on the server and consumed as-is.**
- Revenue, orders, payment and category breakdowns, including sub-categories and the proportional attribution of partially-paid orders
- Guest estimation (bundle solving, Thai free guardians)
- Customer types, source attribution, the birthday link heuristic and discounts
- Hourly buckets, sync health, adjustments and red flags, event rows and chart-builder aggregation
- The formula registry. The Config tab "Formula Definitions" section renders `/api/funtopia/formulas` (15281-15349).

**Computed in the browser.**

| Metric or label | Formula | Ref |
|---|---|---|
| Revenue tile | POS `totalRevenue` plus cash-report days that have no POS row. Subtitle is one of "POS net sales (cash basis)", "From cash reports" or "POS net sales + cash reports". | FD:13049-13075 |
| Avg. Order Value | `totalRevenue / totalOrders` | 14128-14131 |
| Voucher amount and A→F&B toggle | `paymentBreakdown.Voucher` plus Chalong items whose name contains "parent" and "credit". The toggle moves `min(voucher, tickets)` from Tickets to F&B. | 13130-13146, 2542-2552 |
| Birthday shift (Floresta) | Moves `birthdayLinks.partyFnbRevenue` between "Events / Birthdays" and "F&B". It is not applied to comparison data. | 13177-13190, 2560-2571 |
| Chalong birthday split | Re-buckets `birthdayChannelSplit` into natural categories. It includes a Food/Drinks keyword classifier copied from the server. | 12663-12750 |
| Two-branch merge | See §4 | 10960-11157 |
| Compare ranges | Yesterday; −7 days; −1 month; −1 year on the same calendar date (not weekday-aligned); custom | 12086-12176 |
| Live-today compare "(by h:mm)" | Cuts the comparison day at the current Bangkok hour. Guests, customer types, categories and payments are scaled pro-rata by the order or revenue ratio, so they are approximations. | 12913-13017 |
| "Model Forecast" | `daily = base × seasonality[month] × dayWeight / monthWeight`. Static per-branch constants; no holidays and no growth. | 573-788 |
| Delta chip | `(current − previous) / previous`; changes under 0.5% count as flat; no "lower is better" inversion | 792-865 |
| Sync accuracy % | `Σ received / Σ expected`; any failed sync gives 0. Green at ≥99, orange at ≥90. A revenue divergence above ฿1 downgrades green to orange. | 12859-12903 |
| Heatmap | Ratio to the maximum cell with four colour bands; hours 9–20 only; busiest hour and quietest day | 4656-4832 |
| Performance graph | Hours 8–21; totals are the sum of plotted points, so off-hours sales are excluded | 5866, 5911 |
| Calendar heat | Revenue ÷ the year's best day (steps .15/.3/.5/.7/.85). Forecast and last-year modes use ≥110/90/70/50%. | 6212-6311 |
| Monthly target (derived, not stored) | Floresta: the static model. Chalong: the full same month last year. Both: Floresta model plus last-year actuals for all branches. | 6593-6595, 6910-6912 |
| Progress bar | Percent of target, not percent of the month elapsed | 6599-6601 |
| Pace forecast | Described below this table | `lib/paceForecast.ts:153-346` |
| Pace colour | Above +2% green; within ±2% orange; below −2% red | `paceForecast.ts:75-81` |
| Forecast accuracy | For a closed month, uses the snapshot nearest day 15; bands at 5% and 10% | FD:6457-6473, 6964-6979 |
| Future-month baseline | Last-year same month (≥20 days) × year-on-year growth (84-day lookback, ≥21 pairs, clamped 0.6–1.8). Falls back to the 56-day average, then to the target. | `paceForecast.ts:384-508` |
| Month Pace chart | Cumulative actual and forecast lines; the target line is straight (`target / days × d`) | FD:6991-7020 |
| Revenue Planner | Four levers: parties (linked events only), visitors/day ±30%, ticket spend ±20%, F&B spend ±30%. Also three recommended plans, an opportunity score and warnings. | `lib/plannerModel.ts` |
| Events KPIs | Count, sum, average and the most common package. Extras = `otherRevenue − reconciliationRevenue`. | FD:8610-8644 |
| Trends insight text | Rule-based sentences; "How was this calculated?" always sums | 7676-7900 |

**Pace forecast layers.**
- 56-day weekday averages over non-event days
- A holiday uplift factor, clamped 0.7–2.5
- A last-year growth factor with 364-day alignment, a 28-day window and at least 14 paired days, clamped 0.6–1.8
- A 50/50 blend with last year's actual
- Partial-today rule: if today is under 30% of expected, it is projected rather than counted
- Falls back to a simple run-rate

Memory note `events-quantity-not-event-count.md`: category `quantity` counts POS line items. Only `birthdayLinks.partyOrderCount` counts parties. The planner respects this (`plannerModel.ts:57-67`).

## 4. Branch handling

**Toggle.**
- The toggle is multi-select; it cannot deselect the last branch. Every toggle calls a global `queryClient.invalidateQueries()` (FD:11876-11891).
- The product intent is single-select, but the combined views are live (memory note `branch-toggle-single-select.md`).
- Storage key is `oto_branches`; the legacy key `oto_branch` is read without validation (10946-10958); the default is Floresta.

**Scope strings.**

| Format | Used where |
|---|---|
| Sorted `"chalong,floresta"` | Query keys (11897) |
| `"chalong+floresta"` | An unused prop (14191) |
| `"all"` / `"chalong"` / `"floresta"` | Pace snapshots, planner target and plan (6410-6416, 7084) |
| `branch=all` | The events API |

**`mergeDashboardData(a, b)` (10960-11157).**
- It spreads `a` (Floresta) first. Chalong's values are dropped for `date`, `sourceBreakdown`, `birthdayLinks`, `birthdayMovedAmount`, `voucherSwingAmount` and `papayaConnected`.
- Totals, payments and discounts are summed.
- Category `items` are concatenated, so products sold by both branches appear twice. Categories are then rescaled to match `totalRevenue`.
- `topProducts` is merged by name and cut to 20.
- `avgStayHours` is forced to 0, and `customerTypeSplit` is concatenated rather than merged by type.
- The hourly merge ignores per-hour `categories` and `customerTypes`.

**Branch-specific features.**

| Floresta only | Chalong only |
|---|---|
| Source card | Summer-camp toggle on the heatmap |
| Adjustments audit | Tax invoices |
| Product registry | Last-year compare and the last-year heat mode |
| Locked months | Park and Cafe terminal syncs |
| Accounting exports | Birthday split metadata |
| Birthday links, order drill-down and the F&B linker | Parent-credit vouchers |
| Events POS refresh | — |
| In-park pill | — |
| Customer types in hourly data | — |

**Hardcoded two-branch spots.**
- `Branch` union (FD:547)
- `getForecastConfig` (654-700). The combined market split silently uses Floresta's.
- Hardcoded `new Set(["floresta"])` at 6557, 6710, 7188, 10131 and 10604
- Labels at 10941-10944, 13204-13205, 10324 and 11618-11621, with drift between "Robinson Chalong" and "Robinsons Chalong"
- `getActivityBranchStatus` takes two booleans
- "Central Floresta, Floor B" is baked into the QR voucher image (`qr-landing.tsx:282, 716`)
- The spelling "Funtovia" appears in `index.html:16` and the manifest
- Survey and birthday enums in `shared/schema.ts`
- The Trends hero text says "Funtopia data" even when only Chalong is selected

**Known hazards in the combined view.**
- **Pace guard.** `makeScopedPaceCallbacks` hides dates older than 180 days from the pace model, because last-year data is Chalong-only (6475-6495; memory note `pace-forecast-mixed-scope.md`).
- **Future-month baseline.** The guard is not applied to `computeFutureMonthBaseline` (6947-6958), and the same growth factor goes into the planner [V code, I effect].
  - The baseline becomes Chalong-only last year × growth, where growth is combined this year ÷ Chalong last year, clamped at 1.8.
  - That is well below combined revenue.
- **Target double count.**
  - The combined target is the Floresta model plus last-year actuals for all branches.
  - Floresta history starts 2025-12-01, so from December 2026 the last-year part will include Floresta and the target will count it twice [I timing].
- **Cash reports.** In `revenueMap`, a Floresta cash-report day is overwritten by a Chalong-only POS value in combined mode (9933-9960).
- **Live-today hourly merge.** I did not run the app, so the visible effect is inferred.
  - `/api/funtopia/today` returns 72 twenty-minute slots where `hour` is the slot index.
  - Compaction to 24 hours happens only for ranges (`server/routes.ts:2257`).
  - `/api/papaya/today` uses real hours, and the client merges by `hour` and then collapses with `floor(hour/3)`.
  - Chalong's hours 9–20 therefore land at 3–6, outside the chart windows.
  - The port needs one canonical hourly contract.

## 5. Admin, config and write features

| Feature | Location | Request | Notes |
|---|---|---|---|
| Locked months | Config tab, 15079-15129; handler 12051-12064 | `POST /api/funtopia/locked-months {months:[YYYY-MM]}` | Floresta only. Completed months only. The month list starts at the hardcoded `2026-01-01` (12070). UI copy: locked months are "skipped during sync and preserved during push". |
| Voucher face-value → channel mapping | FD:3449-3791 | `GET`/`PUT`/`DELETE /api/funtopia/voucher-mappings` | Not mounted (see headline 3). Built-in channels (3180-3190): Airport, School, Mascot, Sales-booth, Tops Daily, Department Store, Review Rewards, Staff Rewards, Indian Package. Several channels per face value split revenue evenly. Its success path invalidates a non-existent key, `["/api/dashboard/summary"]`. |
| Product category override (replaced the voucher editor) | 3245-3447 | `POST`/`DELETE /api/funtopia/product-registry/:key/override {revenueCategory, fnbSubCategory}` | Seven categories. Decision source: `pisell_category`, `keyword_rescue`, `manual_override` or `unclassified`. Applies on the next re-sync. |
| Birthday F&B link overrides | Events tab, 8062-8221 | `POST`/`DELETE /api/events/link` | Floresta only. Its "success" invalidation of `["/api/funtopia"]` matches no query, so the dashboard is not refreshed. |
| Birthday allocation preference | Header pills | `PUT …/birthday-allocation` | Live for Chalong (`bday` or `split`). The Floresta version (`fnb` or `events`) is wired at 2506-2540 but never called. |
| Calendar notes | Day dialog | `POST /api/funtopia/calendar-notes` | Global, not per branch. No error UI. |
| Monthly target and saved plan | Planner dialog | `PUT /api/planner/target` and `PUT /api/planner/plan` | Stored per branch string, including `"all"`. The saved target only affects the planner; the calendar, the detail view and snapshots use the derived target. It cannot be cleared from the UI. |
| Pace snapshots | Side effect of rendering the Calendar | `POST /api/pace-snapshots` | Once per day and branch per page session. No matching call was found in the server code [V by grep]. Days when nobody opens the Calendar probably have no snapshot [I]. |
| Floresta sync and processing | Config tab and header | `POST /api/funtopia/sync {mode:"quick"\|"full", start?, end?, force?}`; `POST /api/funtopia/process {from, to}`; `POST /api/funtopia/resync-date {date}` | Progress is polled every 2 s. |
| Chalong sync and processing | Config tab and header | `POST /api/papaya/sync {from, to, mode, terminal?}`; `POST /api/papaya/process {from, to}`; `POST /api/papaya/resync-date {date}` | The `setInterval` pollers at 12392, 12446, 12543, 12583 and 12623 have no unmount cleanup. |
| Push to production, wipe production | Config tab, 15131-15251 | `POST /api/funtopia/push-to-production {productionUrl, fromDate?, toDate?}`; `POST /api/funtopia/wipe-production {productionUrl}` | A Replit dev-to-prod artefact. The URL is kept in localStorage `funtopia_prod_url`. Wipe is protected only by typing "DELETE EVERYTHING". The client supplies the target URL, and the server attaches an `x-push-secret` header when calling it. Drop this in the port. |
| Cash reports | Config card | None | Static text only ("72 manual cash report records … Jan 12 – Mar 24, 2026"). There is no entry UI. |
| Campaigns, invoice settings, redemption, survey | Other pages | See §2.3 | The campaign `description` field is never saved by the server (analyst-verified in `server/storage/campaigns.ts`). |

## 6. Stack details for porting

- **Core stack.** React 18.3, Vite 7.3, TypeScript 5.6 strict.
- **Tailwind.**
  - Tailwind is 3.4 through PostCSS.
  - `@tailwindcss/vite` 4.1 is installed but not used.
  - `index.css` starts with `@tailwind base/components/utilities`.
  - Colour tokens are HSL triplets with `<alpha-value>`.
  - Moving to Tailwind 4 needs the tokens converted to `@theme` and the custom utilities in `index.css` re-declared:
    - `hover-elevate` and friends
    - `neu-*`
    - `dash-*`
    - `glass-header`
    - `heatmap-cell`
    - `animate-*`
  - About 40% of that file is HR leftovers (kanban, `shiftBadge`, `PhoneInput`).
- **shadcn/ui.** Style "new-york", base colour neutral, CSS variables on (`components.json`). Only 21 `ui/` components are live.
  - The two non-stock live ones are `date-picker` and `date-range-picker`.
  - `react-day-picker` is version 8. Current shadcn uses version 9, so `calendar.tsx` will need regenerating.
- **Charts.**
  - Recharts 2.15 (Line, Bar, Area, Pie) appears in the Month Pace chart, Performance Graph, Trends, the survey and Campaigns.
  - Heatmaps, bars and rings are plain HTML, CSS or SVG.
  - shadcn's `ui/chart.tsx` is unused.
- **State.**
  - TanStack Query 5 with `staleTime: Infinity`, no retry and no refetch on focus. The default `queryFn` joins the key with `/`.
  - Everything else is local `useState`: 131 in the big file, about 60 in the main component. There is no store and no context beyond the theme.
- **Dates and timezone.** No timezone library. The code mixes four techniques:
  - `new Date(new Date().toLocaleString("en-US", {timeZone:"Asia/Bangkok"}))`
  - a `T12:00:00` local-noon trick
  - a `Date.now() + 7h` trick (12382, 14763)
  - plain browser-local time in `formatSyncTime`, candidate times and the sync calendar
- **Currency.** A hardcoded "฿" prefix with at least five separate formatters. Values just under ฿1M print as "1000k".
- **Replit-only pieces.**
  - `@replit/vite-plugin-runtime-error-modal` is always on. The cartographer and dev-banner plugins load in dev only.
  - The `@assets` alias points at a folder that no longer exists.
  - `client/replit_integrations/audio/*` is unused.
  - The language-model call depends on Replit's OpenAI integration env vars on the server.
  - Sentry packages and a `VITE_SENTRY_DSN` variable exist, but the client never initialises Sentry.
- **Assets and fonts.**
  - About 1 MB of PNG icons in `src/assets`, wrapped by `oto-icons.tsx` (nine exports unused).
  - Google Fonts (Inter, Montserrat, Roboto Mono) load from a CDN link.
  - Two PWA manifests; no service worker.
- **Bundle.**
  - Each page is a lazy chunk.
  - The dashboard chunk holds the whole 670 KB source file plus Recharts and day-picker.
  - `xlsx`, `jspdf`, `jspdf-autotable`, `jszip` and `html5-qrcode` are dynamic imports.
  - Production sourcemaps are on.
  - `xlsx` 0.18.5 comes from npm. It is used only to write exports, and I believe it has open advisories [I].
- **Packages the client actually imports.**
  - react, lucide-react, @tanstack/react-query, class-variance-authority, wouter
  - date-fns, recharts, react-day-picker, qrcode
  - jspdf (+autotable), xlsx, jszip, html5-qrcode
  - zod, react-hook-form, Radix packages
  - Everything else in `package.json` is HR residue, including tiptap, uppy, dnd-kit, framer-motion, the AWS SDK, xero and twilio.
- **Coupling to the server schema.** `visitor-survey.tsx` imports runtime values from `@shared/schema`, which is a Drizzle `pgTable` module. That pulls ORM code into the client bundle.
- **Splitting the 15k-line file: moderate effort.**
  - It is a flat list of about 75 top-level functions.
  - Only three pieces of module state exist: the constants, a snapshot-dedupe `Set` (6428) and the holiday lookup built at import time.
  - The hard part is the 3,600-line main component, which needs its period/compare state machine, sync orchestration and Config panels extracted.
  - The 318 `data-testid` attributes give good regression anchors.
  - Expect the ~70 type errors to surface under a strict monorepo `tsc`.
  - Churn is high: 356 commits in six months, with 26.9k lines added and 11.6k deleted.

## 7. Reuse assessment

**Copy almost as-is.**
- `lib/paceForecast.ts`, `lib/plannerModel.ts`, `lib/activityHeatmap.ts` and `lib/dashboardDateRange.ts`, with their `node:test` suites
- `lib/utils.ts`
- `theme-provider` and `theme-toggle`
- `oto-icons` and the PNGs
- The presentational components:
  - `MetricCard`, `ComparisonDelta`, `CollapsibleCard`
  - `SubGroupRow`, `ProductList`, `SalesInsights`
  - `GuestBreakdownCard`, `SourceRevenueBreakdown`, `MultiDayHeatmap`
  - `PerformanceGraph`, `TrendsChart`, `PaceInfoPopover`
- The `neu-*` and `dash-*` CSS

**Refactor.**
- **One branch-parameterised API.** For example `GET /analytics/summary?branches=&from=&to=`.
  - Do the merge on the server for N sources.
  - Use one param convention and one 0–23 hourly contract.
  - This retires `mergeDashboardData`, `applyChalongBdSplit` and the two fetch functions.
- **Move configuration to the central database.**
  - The forecast constants and the holiday calendar, with corrected dates and years beyond 2026
  - Targets, so the calendar and the planner agree
- **Extract hooks.** A period/compare hook backed by URL params; a generic sync-job hook.
- **Add shared utilities.** Bangkok-date helpers; one currency formatter; zod-typed response contracts in a shared package.
- **Replace the absent auth with suite SSO.** Add role gating for sync and config actions.

**Drop.**
- The dead components listed in §0
- Push and wipe production
- `StaffGate`, the Replit plugins and the HR leftovers
- The discount drill-down hardwired to Papaya, unless it is generalised

**Suggested module layout.**

| Module | Source today (FD lines) |
|---|---|
| `features/filters` (branch, period, compare, toggles) | 11742-11913, 12086-12231, 13194-13706 |
| `features/overview` (tiles, guests, categories, sources, insights, discounts, audit, survey) | 792-2118, 2120-3120, 3122-3166 and 3793-4038, 11159-11737 |
| `features/activity` (heatmap, performance graph) | 4597-4925, 5701-6119, `lib/activityHeatmap` |
| `features/calendar` (year, month, day, notes, pace, accuracy) | 6137-7493, 9816-10657, `lib/paceForecast` |
| `features/planner` | `revenue-planner.tsx`, `lib/plannerModel` |
| `features/trends` | 7495-8018, 9449-9814 |
| `features/events` | 8020-9447 |
| `features/campaigns` | `campaigns-tab.tsx`, `qr-landing`, `qr-redeem`, the spin-wheel components |
| `features/accounting` | 14497-14678, `tax-invoices.tsx` |
| `features/admin` (sync, health, registry, locked months, formulas) | 3206-3447, 10659-10855, 12233-12654, 12758-12903, 14681-15350, `sync-status-section.tsx` |
| `config` (forecast, holidays, categories, metric catalogue) | 178-788, 1367-1418, 7495-7603 |
| `api` (typed client and schemas) | 1536-1622, 2120-2192, 2834-2862, 8023-8060 |

**Views a suite-wide super-admin dashboard would reuse.**
- KPI tile with delta chip
- The period and compare bar
- Revenue by Category
- Performance Graph
- Activity Heatmap
- The year heatmap with pace and target card
- The chart builder, with its metric catalogue turned into a cross-app metric registry
- A generalised "data source health" widget, built from the sync-health badge and the staleness banners
- The events table and the survey summary

Build these against a source-agnostic summary contract so our own POS is just another source.

## 8. Fragile, surprising or undocumented

**Dead or stale code.**
- The hash whitelist bug and the dead voucher-mapping editor (see §0).
- The Unattributed category drill-down is unreachable (FD:2598 versus 2630-2634). `replit.md` claims it works.

**Cache and invalidation.**
- The calendar's `range-slim` key is never invalidated after a sync, so it stays stale for 10 minutes.
- Three invalidation keys match nothing:
  - `["/api/funtopia"]` (8102, 8122)
  - `["/api/dashboard/summary"]` (3491, 3512)
  - `["/api/campaigns"]`

**Trends tab.**
- A stale closure: `TrendsTab.handleSend` memoises on `[loading]` only (9561). The first question after a branch toggle uses the old branches.
- "How was this calculated?" always says "sum", even for averaged charts such as the "Best Day of Week" preset.

**Dashboard, calendar and planner.**
- The discount drill-down always queries Papaya (1103). Its cache is keyed by discount name only, so it goes stale when the date changes.
- Every hardcoded year is 2026:
  - the calendar default (9830)
  - the holiday table
  - the locked-months start (12070)
  - the cash-report text (15262)
  - the term dates (10511-10551)
  - the server prompt "Data starts from 2026-01-01" [V]
- The "Same Time Last Year" target for Chalong compares month-to-date against the full month last year.

**Events exports.**
- The PDF export strips all non-ASCII text, so Thai names would disappear.
- The Excel formats rely on hardcoded cell addresses.

**Accessibility.**
- `CollapsibleCard` headers are clickable `div`s with no keyboard access (2013-2016).
- The `icon` prop on `MetricCard` and `CollapsibleCard` is never rendered.

**Repo and security hygiene.**
- `.env.local`, `cookies.txt` and `core_export.json` are tracked in git. I did not inspect their contents.
- A migration seeds about 58 real staff names and birth dates [V].
- `robots.txt` points its sitemap at `https://oto-hr.replit.app`.

**QR campaigns.**
- Poster QRs encode `window.location.origin` (`campaigns-tab.tsx:194-196`). Printed posters will point at the old host after re-platforming [I].
- The QR landing page shows the raw POS promo code to the customer.

## 9. Unknowns

- The production domain, and whether `STAFF_PASSWORD` is set. It is unused either way.
- Whether Floresta cash reports or POS rows exist before 2025-12-01. That decides when the last-year double count starts.
- The full `/range` and `/today` shapes for Papaya. The read found `customerTypeSplit: []` and no `birthdayLinks`, but did not cover every server path.
- Where the forecast base and seasonality constants came from.
- Whether package or item names ever contain Thai. That would break the PDF exports.
- Whether legacy 6-character voucher codes are still in circulation.
- Hosting and contract of the external Spin & Win game.
- Exact semantics of `exactReportDates`, link `score`/`signals` and the `reason` vocabulary.
- What the `privacy-sensitive` CSS class was for; it has no definition.

## Key files

All under `imports/oto-radar/`.

**Client**
- `client/src/App.tsx`
- `client/src/pages/funtopia-dashboard.tsx`
- `client/src/pages/campaigns-tab.tsx`
- `client/src/pages/tax-invoices.tsx`
- `client/src/pages/qr-landing.tsx`
- `client/src/pages/qr-redeem.tsx`
- `client/src/pages/visitor-survey.tsx`
- `client/src/lib/paceForecast.ts`
- `client/src/lib/plannerModel.ts`
- `client/src/lib/activityHeatmap.ts`
- `client/src/lib/queryClient.ts`
- `client/src/components/revenue-planner.tsx`
- `client/src/components/staff-gate.tsx`
- `client/src/components/sync-status-section.tsx`
- `client/src/components/birthdays-widget.tsx`
- `client/src/index.css`
- `client/public/robots.txt`

**Root configs**
- `vite.config.ts`
- `tailwind.config.ts`
- `components.json`
- `package.json`

**Docs and memory notes**
- `replit.md`
- `docs/FUNTOPIA_DATA_CALCULATIONS.md`
- `.agents/memory/pace-forecast-mixed-scope.md`
- `.agents/memory/branch-toggle-single-select.md`
- `.agents/memory/events-quantity-not-event-count.md`
- `.agents/memory/dashboard-range-response-hygiene.md`

**Server (light checks only)**
- `server/staffAuth.ts`
- `server/routes.ts`
- `server/rangePerformance.ts`
