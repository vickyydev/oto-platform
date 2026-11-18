# The park's day at midnight: the sweep and the plan

Written 18 November 2026. Read only, against `main` at d751e2b10 in
`C:/oto-lanes/tom-feedback-coordination-20261116`. Nothing was changed, built,
run or deployed, and no Jira ticket was touched.

**Authorisation.** The owner ruled on 18 November 2026 on his decisions page
(SCRUM-497, till details for the owner to confirm). On point 3, "Should prices
and promotion dates change at 05:00 or at midnight?", he ticked **Midnight**.
On point 24, "A sale made after the day is closed, before 05:00", he wrote:
"we dont need this 5 am figure. lets keep it midnight like normal 24 hour day
and count according to that". This file is the sweep that comes before that
build. It is a plan with decisions, not a go to build.

**Marks.** V means the code was read in this sweep, by me or by one of two
read-only helpers whose findings I spot-checked. I means inferred and not read
line by line. Line numbers are at d751e2b10.

## The short answer

1. The 05:00 boundary already lives in one place: the park's setting
   `core.branch.business_day_start` (a time, default `05:00`), read through
   `businessDate()` in `packages/shared/src/business-date.ts`. About 150 call
   sites in about 80 source files work out a day this way, plus nine SQL
   expressions and one database trigger. Almost every one passes the park's own
   setting. (V)
2. So the switch is small in code: set the setting to `00:00` and fix about a
   dozen places that fall back to 05:00, freeze it, or assume it. The weight is
   in the tests: 37 test files put a moment between midnight and 05:00 and name
   the day start, and about 27 more must be read.
3. The counter box and the booth box read the setting from the cloud and take a
   new value at their next heartbeat. The switch needs no box release. (V)
4. The park trades 10:00 to 20:00. Inside those hours nothing visible changes.
   Everything that changes happens between midnight and 05:00.
5. Size: about 3 to 4 working days for one lane, more if the owner picks a
   build option in decision 1 or 2.

## 1. The map

### 1.1 Where the boundary lives

| Where | What it is | |
| --- | --- | --- |
| `packages/db/src/schema/tenancy.ts:66`; `packages/db/migrations/0009_fleet.sql:164` | Column `core.branch.business_day_start`, `time NOT NULL DEFAULT '05:00'`. Every park on every database holds 05:00 because nobody set it. Adding the column wrote 05:00 into each existing row, so changing the default later does not move existing parks. | V |
| `packages/shared/src/business-date.ts:42` `DEFAULT_BUSINESS_DAY_START_MINUTES = 5 * 60` | The code's default when a caller passes no setting. | V |
| `packages/shared/src/business-date.ts:157` `businessDate()` | Before the start on the park's wall clock, a moment belongs to the previous date. With `00:00` it returns the plain calendar date, because no minute is below zero. `parseDayStart` (line 47) accepts "00:00" and "00:00:00". | V |
| `apps/api/src/routes/branches.ts:61, 367`; `apps/console/src/pages/Branches.tsx:335, 394, 480-489` | The Console edits it (Branches, Edit, "Business day start"). Anyone with `admin:branch:update` can set any hour. No warning, no confirmation. | V |
| `packages/db/src/schema/sales.ts:260-278` | Each sale stores its `business_date` and a frozen copy of the park's start and timezone, so a later change never re-answers an old sale's day. | V |

### 1.2 Till prices: weekday, weekend and holiday mode

| Where | Today | With a midnight day | |
| --- | --- | --- | --- |
| `apps/api/src/services/sale.ts:750` `resolvePricingScope` | The server prices every sale by the business date. A sale at 00:30 on Saturday gets Friday's weekday price and Friday's date. The till cannot send its own date. | Saturday from 00:00: weekend price and Saturday's date. | V |
| `packages/shared/src/pricing-mode.ts:75` `rateModeToday` | Same rule; uses the 05:00 default when no setting is passed. Its comment records the 05:00 pricing rule as "ruling 3, ours". | Follows the setting. The default and the comment must change. | V |
| `apps/api/src/routes/catalog.ts:973` (`GET /branches/:id/pricing-mode`); `apps/pos/src/components/shared/PricingModeIndicator.tsx:37-47` | The till's "Weekday pricing" label, asked every 60 seconds. | Turns at midnight. | V |
| `apps/pos/src/lib/pricingMode.ts:80-92, 108, 192, 269-276` | The till's own reading of the day. Holds 05:00 until the park's setting arrives, and on a missing or bad value. Trusts the server's answer for 10 minutes. | Follows the setting once loaded; the fallback must change. | V |
| `packages/admin-screens/src/lifted/lib/pricingMode.ts:100-113` | A copy of the same, also behind the reports' month-to-date default (`packages/admin-screens/src/lifted/lib/reporting.ts:399`). | Same as above. | V |
| `apps/api/src/services/sale.ts:2368`; `apps/pos/src/api/sales.ts:508` | A cart left open across the day start is priced on the new day; the answer records the difference. | Across midnight instead. | V |
| `apps/api/src/services/inbox/ai-knowledge.ts:397` | The inbox assistant's "today's prices". | Follows. | V |
| `apps/pos/src/components/fnb/FnbCustomerDisplay.tsx:149`; `apps/pos/src/components/merch/MerchCustomerDisplay.tsx:114` | The customer display uses the device's rate mode when a line carries none. | Follows. | V |

### 1.3 Promotions and voucher dates

| Where | Today | With a midnight day | |
| --- | --- | --- | --- |
| `apps/api/src/services/promo-codes.ts:461-466` | A code's first and last day are checked against the sale's business date. A code "valid until 30 Nov" still works at 03:00 on 1 Dec. | Ends at midnight. | V |
| `apps/api/src/services/voucher-promotions.ts:131, 140-155, 671` | Lucky Wheel voucher promotions' windows, on the business date. | Follows. | V |
| `packages/shared/src/promo.ts:54` `promoValidityDate` | A helper with the 05:00 default. No app calls it (only comments). | Default changes; the helper could go. | V |
| `apps/pos/src/pages/Till.tsx:1648`; `apps/pos/src/components/mobile/MobileTill.tsx:1010` | The ticket till's own early promo check uses the **UTC** date (`new Date().toISOString().slice(0, 10)`), which in Bangkok changes at 07:00. The server's answer is the one that counts. | Still 07:00 unless fixed. A half-moved promo date; fix in this lane. | V |
| `packages/admin-screens/src/lifted/components/admin/discounts/DiscountCodesSection.tsx:508-511` | The Console's "Expired" and "Not yet valid" badges use the UTC date. | Same fault; fix in this lane. | V |
| `apps/pos/src/lib/itemPromo.ts:193` | Food and shop promo checks use the till's business date. | Follows. | V |
| `packages/box-agent/src/booth.ts:1675` | A booth voucher's expiry uses the calendar date. | Already midnight. | V |
| `packages/box-agent/src/offline-pricing.ts:600-609` | Promo codes are refused while the box is offline, so no offline date check. | No change. | V |

### 1.4 The date a sale, refund, booking, redemption or visit is recorded on

| Where | Today | With a midnight day | |
| --- | --- | --- | --- |
| `apps/api/src/services/sale.ts:759` | `sale.business_date`, and the same day on `sale_line`, `sale_discount`, `payment_attempt`. Every report and End of Day counts on these. | A sale at 00:30 is on the new day. | V |
| `apps/api/src/services/refunds.ts:597` | The day the refund puts stock back is worked out with the **sale's frozen** start, not the park's current one. Refund money comes off the original sale's day (`apps/api/src/services/end-of-day.ts:342-347`). | Refunds of sales made before the switch keep using 05:00 for their restock day. A half-moved boundary; fix in this lane. | V |
| `apps/api/src/services/sale-extensions.ts:158` | Extra time is a sale on the park's current day. | Follows. | V |
| `apps/api/src/services/parties.ts:450, 664`; `apps/api/src/services/party-deposit.ts:456`; `apps/api/src/services/inbox/prebooking.ts:432` | Party payments at a counter and party deposits paid online carry the business date of the moment paid. | A deposit paid online at 01:00 is on that calendar day. | V |
| `apps/api/src/services/booking-checkout.ts:543, 592, 598, 837` | Online bookings: the money is dated the day it is paid; the visit date defaults to, and cannot be earlier than, the business date. | Paid at 01:00 counts on that calendar day. | V |
| `apps/api/src/services/payments/gateway.ts:255-316` | Web invoice numbers carry the paid day and count up per day stem. | Follows; no collision, because the count reads every number already minted with that stem. | V |
| `apps/api/src/routes/visits.ts:128` | A visit's `visit_date` defaults to the **calendar** date, while the sale beside it uses the business date. | The two agree. | V |
| `apps/api/src/services/sync.ts:3852-3860` | A box's record is dated by the cloud from its stamped time (or from arrival time if the box clock is not trusted), with the park's current setting. | Follows. | V |
| `apps/api/src/services/booking-redemption.ts` | No day check when a booking is redeemed (searched). | No change. | V |

### 1.5 End of Day, cash movements, shifts and cash sessions

| Where | Today | With a midnight day | |
| --- | --- | --- | --- |
| `apps/api/src/services/end-of-day.ts:342-420` `expectedInputsOf` | A day's End of Day holds the counter payments dated that day (cash, card, PromptPay), refunds of that day's sales, voucher credit and party money for parties held that day. All read from stored dates. | Same rule. Only rows made between 00:00 and 05:00 move day. | V |
| `apps/api/src/services/end-of-day.ts:244` `currentBusinessDate`; `:925-929` `closeEndOfDay` | Close Day refuses a day that has not started. A day can be closed at any later time. | Same. | V |
| `apps/pos/src/pages/Today.tsx:18, 37, 71`; `apps/pos/src/components/mobile/today/MobileTodayPage.tsx:16, 37, 63` | Today and End of Day open on the business date (server first, then the device). At 00:30 they open on the evening that is finishing. | At 00:30 they open on the new, empty day. Closing last night means picking yesterday's date. See decision 2. | V |
| `apps/api/src/services/end-of-day.ts:1114-1120, 1150-1211` | Paid-outs and safe drops always go on the current business day and are refused once that day is closed. `apps/pos/src/components/shared/CashMovementButton.tsx:138` sends no date. | One recorded at 00:15 goes on the new day. See decision 2. | V |
| `apps/api/src/services/sale.ts` (no closed-day check, searched) | A sale after Close Day is dated to the closed day, is on no End of Day (a closed day keeps the lines it was closed with) and warns nobody. Possible from Close Day until 05:00. | Possible from Close Day until midnight; after midnight the sale is on the new, open day. See decision 1. | V |
| `apps/api/src/services/end-of-day.ts:270` `floatCarryover` | The float comes from the last closed day before this one. | No change. | V |
| `apps/api/src/services/settlement.ts:52, 107, 195` | Card terminal settlement batches are matched to payments by business date; staff pick the date. | Follows. | V |
| `apps/api/src/services/console-decisions.ts:110-130` | The Console decisions panel reads "today's" close for cash variances. | At 00:30 it reads the new day. | V |
| Station and cash sessions | No day logic found on staff station sessions (searched `station-session`, `shift`, `cash session`). | No change. | V |
| `apps/pos/src/auth/OperatorContext.tsx:517, 651`; `apps/pos/src/auth/sessionEnd.ts:198-202` | A till kept for the same person is offered again only on the same business date. | A session that ends at 23:55 and resumes at 00:05 starts fresh. | V |

### 1.6 Held sales

| Where | Today | With a midnight day | |
| --- | --- | --- | --- |
| `apps/api/src/services/sale-holds.ts:597-641`; `packages/shared/src/sale-hold.ts:44`; job `job:sales.held_midnight` (`apps/api/src/services/jobs.ts:719-735`) | Held sales are voided (no money) or flagged (part paid) at **calendar midnight**, the owner's ruling of 4 November, while the sale's day runs to 05:00. | The two moments become the same. Keep the job on calendar midnight, since it is a ruling of its own. | V |
| `apps/pos/src/lib/leftBehindSale.ts:169` | The till's "left behind" list shows today's business date only. | A sale left at 23:50 drops off the list at 00:00. | V |

### 1.7 Reports and dashboards

| Where | Today | With a midnight day | |
| --- | --- | --- | --- |
| `apps/api/src/services/analytics-summary.ts:113` `summaryBranchToday`; `apps/api/src/services/console.ts:136, 169`; `apps/api/src/services/console-money.ts:210, 709`; `apps/api/src/services/aggregates.ts:47` | "Today" on the Console Overview, Money, and the till's Today page is the business date. | Turns at midnight. | V |
| `apps/api/src/services/analytics-rollup.ts:108, 135, 550` | The daily, hourly and booth summaries are built from stored dates; "ended days" are found with the park's setting in SQL. | Follows. Past summaries stay as they are. | V |
| `packages/db/migrations/0064_analytics_summaries.sql:498` | Database trigger: a wallet entry with no stored day is placed on a day with the park's current setting, to mark that day for re-summing. | Follows. | V |
| `apps/pos/src/api/history.ts:620-690` `businessDateToday`; `apps/pos/src/pages/History.tsx:162-174`; `apps/pos/src/components/mobile/history/MobileHistory.tsx:127-147` | History opens on the business date, with a fallback to the calendar date. The fallback is wrong today between 00:00 and 05:00. | Fallback and rule agree. | V |
| `apps/pos/src/components/floor/PerformanceFreshness.tsx:86-91` | Falls back to midnight when no setting; an extra calendar clause covers 00:00 to 05:00. | The extra clause becomes redundant but harmless. | V |
| `apps/api/src/services/stock.ts:1621, 3111, 4081` | Stock movements store the business date of the moment. | Follows. | V |
| `apps/api/src/services/stock.ts:3598, 3721` | Stock count discrepancies (the shrinkage report) and purchase orders are placed on a day **when read**, from their time and the park's **current** setting. | A count done at 00:30 before the switch moves one day later in reports after it. See section 3 and decision 3. | V |
| `apps/api/src/services/voucher-ledger.ts:139, 764`; `apps/api/src/services/kiosk-staff.ts:46, 89, 300` | Older vouchers with no stored spin day, and guest kiosk sessions, are placed on a day when read, with the current setting. | Same as the line above. | V |
| `apps/console/src/pages/BoothReport.tsx:53-57` | The booth report's "today" uses the 05:00 default when "all parks" is picked. | Fix with the default. | V |
| `apps/console/src/pages/MoneyOversight.tsx:45-48`; `apps/console/src/pages/AnalyticsSources.tsx:37-38` | Default date ranges use the browser's or UTC date, not the park's. | Not part of this boundary; listed in section 7. | V |
| `apps/radar/server/sources/otoPos.ts:182-184, 269-273` | Radar guesses the Bangkok calendar date, then takes the platform's business date. | The two agree. | V |

### 1.8 Bands, gate rights, visit expiry and occupancy

| Where | Today | With a midnight day | |
| --- | --- | --- | --- |
| `packages/box-agent/src/gate/decision.ts` | The gate decides on band status and gate access only. No day rule (searched). | No change. | V |
| Band and visit expiry | No job or rule expires a band or a visit by day (searched `apps/api/src/services`, `packages/shared/src`). | No change. | V |
| `apps/api/src/services/occupancy.ts:83-90, 158-170, 663-700` | The head count's window restarts at the day start; a job writes one audit row per park per ended day naming groups still counted inside. | Window restarts at midnight. Days already cleared are not redone. | V |
| `apps/api/src/services/occupancy.ts:297` `strandedOf`, called from `apps/api/src/services/end-of-day.ts:558, 948` | Close Day asks to resolve anyone still counted inside that day. | Follows. | V |

### 1.9 Check-in, drop-off, care time and nannies

| Where | Today | With a midnight day | |
| --- | --- | --- | --- |
| `apps/api/src/services/checkin.ts:341-354, 386-391, 525, 1615-1630` | The check-in board's "today", the waiting list (a stay shows on the day it is for), and the start of the current trading day, all from the setting. | Roll at midnight. | V |
| `apps/pos/src/api/events.ts:52-55` `eventsToday`; used by `apps/pos/src/pages/Events.tsx:50`, `apps/pos/src/pages/DropOff.tsx:114`, `apps/pos/src/components/mobile/dropoff/MobileDropOffBoard.tsx:59`, `apps/pos/src/components/mobile/parties/MobileParties.tsx:65`, `apps/pos/src/components/mobile/parties/MobileEventsList.tsx:51`, `apps/pos/src/pages/Till.tsx:1204` | Events, parties and drop-off boards use the business date. | Roll at midnight. | V |
| `apps/api/src/services/nanny-duty.ts:376, 420-423, 1276` | A nanny's shift window runs from one day start to the next. | Midnight to midnight. | V |
| Care time and extra time (`packages/shared/src/extra-hour.ts`, `packages/shared/src/supervision.ts`) | Counted in minutes, no day rule (searched). | No change. | V |

### 1.10 The booking site

| Where | Today | With a midnight day | |
| --- | --- | --- | --- |
| `apps/api/src/routes/public.ts:220`; `apps/api/src/services/booking-checkout.ts:543-598` | The earliest visit date offered is the business date. A family booking at 01:00 on Saturday is offered Friday (already over) and quoted Friday's price. | Offered Saturday, at Saturday's price. | V |
| `apps/pos/src/pages/Book.tsx:444-451, 526-532`; `apps/pos/src/lib/visitDate.ts:17-32` | The site starts from the device's business date, then takes the server's; dates run from today to 60 days ahead. | Follows. | V |
| `apps/console/src/pages/Bookings.tsx:569-571` | Labels a visit "today" by the calendar date, which disagrees with the visit dates between 00:00 and 05:00. | Agrees. | V |

### 1.11 Wallet credit and staff benefits

| Where | Today | With a midnight day | |
| --- | --- | --- | --- |
| `packages/shared/src/wallet.ts:349-374`; `apps/api/src/services/wallet.ts:115-125` | When credit is granted, its expiry moment is **stored** (`wallet_entry.expires_at`): same-day credit ends at 05:00 the next morning. | New credit ends at midnight. Credit granted before the switch keeps its stored 05:00. | V |
| `apps/api/src/services/wallet.ts:1610-1700`; job `job:wallet.expiry` | Every five minutes, each ended day's expired credit is taken off, dated that day. | On the night of the switch, credit granted before it is still live until 05:00 and is taken off in the next day's run, dated one day late. One night only. | V |
| `apps/api/src/services/wallet.ts:1840`; `apps/api/src/services/sync-wallet.ts:150, 388, 613-620` | Older entries with no stored day are placed when read. Offline wallet spends take the box's day when its clock is trusted. A missing park falls back to midnight UTC. | Follows; see section 4 for the box gap. | V |
| `apps/api/src/services/benefits.ts:40-60, 150`; `apps/api/src/services/analytics-benefits.ts:255-316`; job `job:benefit.period_rollover` | Staff benefit days and months turn over at the day start. The code notes this as the owner's open question (plan Q6). A session with no park falls back to 05:00. | Turn over at midnight. The ruling ("normal 24 hour day") answers Q6; recorded, not asked again. | V |
| `packages/box-agent/src/agent.ts:1851`; `packages/box-agent/src/station-bridge.ts:1881`; `packages/shared/src/benefit-credential.ts:241` | Which day's staff allowance a staff QR uses at the box. | Midnight. | V |

### 1.12 The Lucky Wheel booth

| Where | Today | With a midnight day | |
| --- | --- | --- | --- |
| `packages/box-agent/src/booth.ts:888, 960-968, 1101-1121, 1302-1316, 1350-1372` | The spin's day decides the daily spin cap, per-prize daily caps, the press de-duplication and the roster named on the slip. | Caps reset at midnight. | V |
| `apps/api/src/services/booth.ts:461`; `apps/api/src/services/booth-admin.ts:541`; `apps/api/src/services/ops.ts:2756-2760`; `apps/api/src/services/analytics-booth.ts:218-224` | The cloud's spin day, the Console booth figures and the watchdog's booth conditions; the comment says a booth spinning at 00:30 stays on the afternoon's figures. | Midnight. | V |
| `apps/console/src/components/booth/BoothBoxCard.tsx:141-143`; `docs/ops/PI_BOOTH.md:111` | A note explains that after midnight the count stays on the day before while the slip shows the calendar day. | The note becomes wrong; remove it. | V |
| `apps/api/src/services/booth-duty.ts:464, 544, 1135-1141`; job `job:booth.duty_sync` | The day's booth staff are read from the OTO App once per day, at the first tick when the park is open. With no opening hours set, that is the day start. | With no opening hours set, the sync runs just after midnight instead of 05:00. Same for `job:nanny.duty_sync`. Step 0 checks whether opening hours are set. | V |

### 1.13 The counter box and booth box code (`packages/box-agent`)

| Where | Today | With a midnight day | |
| --- | --- | --- | --- |
| `apps/api/src/services/box.ts:1230-1244, 1268`; `packages/box-agent/src/protocol.ts:572-586` | The cloud sends the park's `businessDayStart` and timezone in the box's config bundle; the bundle's version hash covers them. | Changing the setting changes the version. | V |
| `packages/box-agent/src/agent.ts:2359-2376, 2598-2624, 3640-3641`; `packages/box-agent/src/runner/runtime.ts:174-182` | The box keeps the bundle in memory and in `config-bundle.json`. Each heartbeat answer carries the cloud's version; on a difference the box fetches the bundle. An offline box keeps its last copy, across reboots. | The new value arrives at the next heartbeat with no restart and no release. | V |
| `packages/box-agent/src/offline-pricing.ts:610-611, 988, 1059` | Offline weekday or weekend price mode, from the bundle's setting. | Midnight. | V |
| `packages/box-agent/src/station-bridge.ts:1067, 1881, 2355-2361` | The box's "today" for the check-in desk, events desk, offline wallet cap, default visit date and offline reprints. With no park it falls back to the UTC date. | Midnight. | V |
| `packages/box-agent/src/sale-queue.ts:767-788, 1090` | Sale logs from earlier days lose their paper copy; reprints are today's sales only. | Midnight. | V |
| `packages/box-agent/src/terminal/index.ts:155-162, 444`; `packages/box-agent/src/terminal/counter.ts:110-117`; `packages/box-agent/src/store-sqlite.ts:218-226`; `packages/box-agent/src/store-sql.ts:199-202, 1333-1363` | The card terminal reference counter is kept per business date (`box_counter.business_date`). GHL references carry the date. | Counter turns at midnight. | V |
| Offline day rollover | No explicit "close the day" on the box; days turn through date-keyed counters only. | No change. | V |

### 1.14 The customer display

Rate mode comes from the platform's quote (`apps/pos/src/pages/Till.tsx:3807`,
`apps/pos/src/lib/displaySession.ts:119`), with the device fallback in 1.2. No
display screen checks a promotion or anything else by date. Nothing else
changes. (V)

### 1.15 The Console

The Branches field (1.1), BoothReport and the booth card note (1.7, 1.12), the
discount badges (1.3), Overview, Money and decisions (1.5, 1.7). Booths, booth
spins, Health tiles, today's nannies and today's booth staff only show dates
the server chose (`apps/console/src/pages/Booths.tsx:1039`,
`apps/console/src/components/booth/TodayStaffPanel.tsx:69`,
`apps/console/src/components/care/TodayNanniesPanel.tsx:73`). The morning
digest, see 1.17. (V)

### 1.16 The HR app (`apps/oto-app`)

It reads no till day, no takings and no End of Day: its server has no
`business_date`, sale or End of Day read (searched). Party money is read per
party (`apps/oto-app/server/lib/tillBilling.ts:34`); a deposit's paid date
comes from the platform as a calendar date
(`apps/api/src/services/inbox/book-date.ts:412`). The "business days" hits in
`apps/oto-app/server/routes.ts:6792` and
`apps/oto-app/migrations/0018_flexible_leave_types.sql` are a leave type. Its own
00:01 job (`job:otoapp.midnight`, `apps/api/src/services/jobs.ts:1267`) already
runs at Bangkok midnight. Nothing changes. (V)

### 1.17 Scheduled jobs (`apps/api/src/services/jobs.ts`)

| Job | Today | With a midnight day | |
| --- | --- | --- | --- |
| `job:sales.held_midnight` (719) | Calendar midnight. | No change. | V |
| `job:occupancy.facts`, `job:wallet.expiry`, `job:wallet.liability`, `job:stock.daily`, `job:benefit.period_rollover` (800-960) | Each closes the days that have ended, a week back, at the day start. | Close at midnight. Days already closed are not redone. | V |
| `job:rollup.daily`, `job:rollup.hourly`, `job:rollup.booth` (880-920) | "Today" is provisional until the day start passes. | Midnight. | V |
| `job:booth.duty_sync`, `job:nanny.duty_sync` (737-773) | At open, or the day start if no hours are set. | See 1.12. | V |
| `job:parties.slips` (775-797) | A party's slips at its slip time, for parties of the business date. | Follows; slip times are daytime. | V |
| `job:events.cache_refresh` (961) | Today's events for the boxes. | Midnight. | V |
| `job:console.digest` (`apps/api/src/services/console-digest.ts:72-111`; jobs.ts 580-596) | The morning digest posts once per park after the day start. Off by default (`.env.example:100-104`); whether it is on in the Render settings is not known. | It would post just after midnight. Give it its own 05:00 send time so it stays a morning digest. | V |

### 1.18 Database columns and indexes

Stored business dates (all `date`, written once when the row is made): (V)

- Sales: `pos.sale.business_date` and its frozen `business_day_start` and `timezone`; `pos.sale_line`, `pos.sale_discount`, `pos.payment_attempt` (unique index `payment_attempt_terminal_ref_unique` on device, business date, terminal reference, migration 0019).
- Cash: `pos.end_of_day` (unique per park and day, migration 0052), `pos.cash_movement`, `pos.settlement_batch`, `pos.occupancy_resolution`.
- Stock and wallet: `pos.stock_movement`, `pos.wallet_entry` (may be empty on older rows) and its stored `expires_at`.
- Bookings and care: `pos.booking.business_date` (the visit date), `pos.nanny_shift` (may be empty), `pos.nanny_sync`.
- Booth and benefits: `booth.spin`, `booth.booth_duty_assignment`, `booth.booth_duty_sync`, `promo.benefit_application`.
- Boxes: `edge.sync_event`, `edge.box_counter`, and the box's own `box_counter` in SQLite.
- Figures: `analytics.daily_summary`, `hourly_summary`, `daily_category_summary`, `daily_tender_summary`, `daily_item_summary`, `daily_ticket_summary`, `daily_discount_summary`, `fact_booth_daily`, `fact_benefit_daily`, `fact_occupancy_15min`, `dirty_date`, `fact_stock_daily`, `fact_wallet_liability_daily`.

No database check ties a stored date to the boundary (searched the
migrations). No index has to change.

### 1.19 Seeds, fixtures and tests that pin 05:00

- **Seeds.** `packages/db/src/seed/demo-day.ts:720-729` and
  `packages/db/src/seed/demo-booth.ts:126-131` place each demo sale and spin as
  "minutes after the day start" (`5 * HOUR // 10:00`). With a midnight start the
  10:00 demo sale lands at 05:00. This drives the staging Health page's "Add demo
  sales". Must change. `packages/db/src/seed/index.ts:980-989` and
  `packages/db/src/seed/stock.ts:253-269` follow the setting. No seed sets the
  column; all take the default. (V)
- **Shared fixtures.** `packages/shared/src/fixtures/pricing-regression.json`
  holds 27 day fixtures (BD-1 to BD-10, BD-DST-1 to BD-DST-7 with 3b, TD-1 to
  TD-9). Each passes its own day start, so they stay true as tests of the rule;
  one already pins the midnight twin (the note at line 2116). (V)
- **Test files that name the day start: 168.** apps/api 121, apps/console 15,
  packages/box-agent 17, packages/db 5, apps/pos 4, packages/shared 4,
  apps/radar 1, apps/oto-app 1 (`apps/oto-app/tests/checklist-overdue-today.check.ts`,
  unrelated: its own calendar day). Most pass `'05:00'` or `'05:00:00'` as data
  and keep passing. (V by search)
- **Test files that name the day start and put a moment between 00:00 and
  05:00 Bangkok: 37.** These are the ones that can flip or need re-reading: (V by search; individual outcomes I)
  - apps/api (26): `aggregates-ai`, `arrival-r1-gate2`, `benefits-r4`, `booking-checkout`, `box-api`, `catalog`, `console-staff`, `eod-r1-gate`, `inbox-read`, `occupancy`, `payments-cash`, `prebooking-review`, `print-restart`, `promo-codes`, `s216-review`, `s220-e3-review`, `s220-e4-review-readday`, `s220-e4-review`, `s220-e5-review`, `s620-organisation-review`, `s620-organisation-routes`, `s637-digest-review`, `s638-pricing-review`, `sales-ledger-schema`, `vouchers-r5-promotions`, `wallet-gate-r3-final` (all `apps/api/test/*.test.ts`).
  - packages/box-agent (4): `booth` (00:30 is the previous day, 690; cap holds at 04:30 and resets at 05:30, 1076-1093), `clock-measure` (1385-1410), `offline-wallet-gate-r4` (`DAY_START = 5*60`, 246-260), `terminal-simulator` (03:00 settles under the day before, 727-746).
  - apps/pos (3): `s216-r3-freshness-fix`, `s216-r3-performance-hook`, `s216-r3-review-recheck`.
  - packages/shared (3): `test/business-date.test.ts` (every minute before 05:00 is the previous date, 36-42), `test/pricing-engine.test.ts`, the regression JSON.
  - apps/console (1): `e2e/reports.spec.ts`.
- **A further 27 worth reading**: test files that put a moment between 00:00 and
  05:00 Bangkok without naming the day start, so a seeded park gives them the
  column default: apps/api 14, apps/pos 13 (among them `book-visit-date`,
  `s216-r6-sweep`, `s768-ticket-free-items`, `s768-free-socks-counter`,
  `s959-split-view-measured`). Another 22 hits in the same search are unrelated
  timestamps (the HR app's 13 among them). (V by search; outcomes I)
- **Console end-to-end fixtures** that serve `businessDayStart: '05:00:00'` as
  data: 10 specs in `apps/console/e2e` (care-print, catalogue, menu,
  health-integrations-review, organisation, error-recovery-review,
  payment-discovery-filters, operator-switch, money, operations). They keep
  passing; change them only to keep the fixtures honest. (V)

### 1.20 The places that do not follow the setting (the fix list)

| No. | Where | Fault | |
| --- | --- | --- | --- |
| F1 | `packages/db/src/schema/tenancy.ts:66` | Column default `05:00`. | V |
| F2 | `packages/shared/src/business-date.ts:42` | Code default 05:00, reached by `packages/shared/src/pricing-mode.ts:79`, `packages/shared/src/promo.ts:57`, `packages/shared/src/business-date.ts:160`, `apps/api/src/services/benefits.ts:150`, `apps/pos/src/lib/pricingMode.ts:80-90`, `packages/admin-screens/src/lifted/lib/pricingMode.ts:100-111`, `apps/console/src/pages/BoothReport.tsx:57`. | V |
| F3 | `apps/api/src/services/refunds.ts:597` | Restock day on the sale's frozen start. | V |
| F4 | `apps/api/src/services/console-digest.ts:76-80, 109-111` | Digest send time tied to the day start. | V |
| F5 | `packages/db/src/seed/demo-day.ts:728-729`; `packages/db/src/seed/demo-booth.ts:126-131` | Demo times placed after the day start. | V |
| F6 | `apps/pos/src/pages/Till.tsx:1648`; `apps/pos/src/components/mobile/MobileTill.tsx:1010`; `packages/admin-screens/src/lifted/components/admin/discounts/DiscountCodesSection.tsx:508-511` | Promo dates on the UTC day. | V |
| F7 | `apps/console/src/components/booth/BoothBoxCard.tsx:141-143`; `docs/ops/PI_BOOTH.md:111` | Copy that explains the 05:00 split. | V |
| F8 | Comments that state 05:00 as the rule: `business-date.ts`, `pricing-mode.ts`, `promo.ts`, `packages/shared/src/wallet.ts:344`, `packages/db/src/schema/sales.ts:260-266`, `apps/api/src/services/occupancy.ts:83, 663`, `jobs.ts:723`, `catalog.ts:950`, `booking-checkout.ts:533-536`, `sale.ts:742`, `apps/pos/src/api/history.ts:626, 668`, `apps/pos/src/api/catalogBridge.ts:101`, `apps/pos/src/api/platform.ts:365`, `apps/pos/src/lib/pricingMode.ts:72`, box comments (`booth.ts:1306`, `store.ts:356`, `store-sqlite.ts:217`, `checkin-desk.ts:145`); docs `docs/architecture/DEVELOPMENT_PLAN.md:1052` and the two handovers. Applied migrations (0014) keep their text. | V |

Fallbacks that already use midnight or UTC and need nothing:
`PerformanceFreshness.tsx:86` (midnight), `sync-wallet.ts:619` (midnight UTC
for a missing park), `station-bridge.ts:2359` (UTC date for a box with no park).

## 2. What changes for staff

During opening hours, 10:00 to 20:00, **nothing visible changes**. Prices,
promotions, receipts, History, Today and End of Day show the same dates as
before. Every change is in the hours between midnight and 05:00:

- The weekend and holiday price starts at midnight on Saturday, not at 05:00.
  Nobody is selling then.
- A promo code's last day ends at midnight, not at 05:00 the next morning.
- Held sales are still cleared at midnight, as ruled on 4 November. That is now
  also the moment the day changes, so nothing is left in between.
- A sale made after Close Day still lands on the closed day, but only until
  midnight; after midnight it is on the new day (decision 1).
- If the day is ever closed after midnight, End of Day opens on the new, empty
  day, and staff pick yesterday's date to close it. A safe drop or paid-out
  recorded after midnight counts on the new day (decision 2).
- A family booking online at 01:00 on Saturday sees Saturday as the first date,
  at Saturday's price. Today they see Friday, which has already ended. Their
  payment, and party deposits paid online at night, count on that calendar day.
- Lucky Wheel daily limits, staff allowances, the check-in board, drop-off and
  events boards all start the new day at midnight. The booth slip's date and the
  Console's booth count now agree, so the Console note about it goes.
- Same-day wallet credit stops at midnight instead of 05:00. The park is closed,
  so no guest notices.
- The Console's Branches page shows the day start as 00:00 (decision 4).
- Past days keep their figures (section 3, decision 3).

The code itself disagrees on whether staff work after midnight:
`packages/shared/src/pricing-mode.ts:57-60` says the park trades 10:00 to 20:00
and no guest sale falls after midnight, while `packages/db/src/schema/sales.ts:260-266`
says "the late party, the cash count and the day-close print all land after
midnight". Step 0 below settles it from the staging records before the build.

## 3. Stored data

- **Yes, stored values carry a date worked out with 05:00**: every column in
  1.18, every sale's frozen `business_day_start` of `05:00`, every End of Day
  row, every analytics figure, and the stored `expires_at` of wallet credit not
  yet expired. (V)
- **For almost all of them the date is the same under either rule.** A row only
  differs if it was made between 00:00 and 05:00 Bangkok: a late cash count or
  safe drop, an online booking or deposit paid at night, a booth spin after
  midnight, a box record whose clock was not trusted, and demo or test data.
  (I; Step 0 counts them.)
- **No migration of past data is needed, and none is proposed.** Stored dates
  stay. Closed End of Day records are not touched. Past analytics rows stay.
- **What does move.** A few readers place a past row on a day when they read it,
  using the park's current setting (stock count discrepancies and purchase
  orders, older vouchers with no stored spin day, older wallet entries with no
  stored day, guest kiosk sessions, waiting check-in stays). A past row of these
  kinds made between 00:00 and 05:00 would show one day later after the switch.
  Whether that is acceptable is decision 3.
- **The cut-over is the moment the setting changes.** No separate cut-over
  date is needed if the switch lands in daytime. Example, switching at 14:00 on
  Thursday 20 November: Wednesday 19 ran from 05:00 on the 19th to 05:00 on the
  20th as before; Thursday 20 runs from 05:00 to midnight (a short day); Friday
  21 runs midnight to midnight. Nothing is lost or counted twice.
- **The switch must never land between 00:00 and 05:00.** Then the day in
  progress would be split, a box terminal reference counter could restart on the
  same date (unique index in 1.18), and the night's rows would sit on two days.
- **One-night seams, known and small** (V): same-day wallet credit granted
  before the switch stays spendable until its stored 05:00 and its expiry is
  dated the next day (1.11); refunds of old sales use the frozen 05:00 for the
  restock day until F3 is fixed.

## 4. The boxes

- **Neither box carries the boundary in its own code.** Both read
  `businessDayStart` from the cloud's config bundle, and every use passes that
  value; the 05:00 default in the shared code is never reached on a box.
  (V, section 1.13)
- **No box release is needed for the switch.** The protocol has carried the
  setting since 20 September 2026 (commit 566bf4473), before the counter Pi's
  first release (08ffe662d, 28 September), so any installed release reads it.
  (V from git history; the version on the device was not checked: I.)
- **When it arrives.** At the next heartbeat after the cloud changes, with no
  restart (V). The counter Pi is offline and waiting for the owner's go: it
  keeps 05:00 in its `config-bundle.json` until it is online again, then fetches
  the new value on its first heartbeat. The booth box behaves the same.
- **If the cloud switches before a box does** (I, from the code): it only
  matters for records the box makes between 00:00 and 05:00 while it still holds
  05:00.
  - An offline sale is dated by the cloud with the new rule; the box priced it
    on the previous day. Across a weekday and weekend edge the totals differ, and
    with an unchanged catalogue version the sale is held back for review
    (`apps/api/src/services/payments/offline.ts:628-646`).
  - An offline wallet spend keeps the box's day when its clock is trusted
    (`apps/api/src/services/sync-wallet.ts:613-616`).
  - Booth caps, the roster day and the events desk would disagree with the cloud
    for those hours.
  - Booth facts carry a day the cloud ignores; it recomputes its own
    (`apps/api/src/services/sync-booth.ts:363-373`).
  With the park closed in those hours, the practical risk is nil, provided the
  switch lands in daytime.
- **What a later box release carries**: updated comments and the 17 box tests;
  no behaviour.

## 5. The build

**The single place.** `core.branch.business_day_start`, read through
`businessDate()`. Keep the setting rather than deleting the idea of a business
day: about 150 call sites already speak it, and a park abroad may need another
hour. After the build no code may assume an hour.

**Steps, smallest safe first.**

0. **Evidence, read only, before any code.** On staging (and production, if a
   till trades there), count for the last 60 days the rows made between 00:00
   and 05:00 Bangkok in: `pos.sale` (by `occurred_at`), `pos.payment_attempt`,
   `pos.cash_movement`, `pos.end_of_day` (by `closed_at`), `booth.spin`,
   `pos.stock_take_line` (by `counted_at`), purchase orders, `pos.wallet_entry`
   with no stored day, `pos.booking` (by `paid_at`). Also read whether HKT
   Central has opening hours set, and whether `CONSOLE_DIGEST_ENABLED` is on in
   the Render settings. This gives numbers for decisions 2 and 3.
1. **Defaults, with no change in behaviour** (one commit). Set
   `DEFAULT_BUSINESS_DAY_START_MINUTES` to 0; a new migration sets the column
   default to `'00:00'`; `tenancy.ts` to match (F1, F2). Existing parks still
   hold `05:00` explicitly, so nothing moves yet.
2. **The places that do not follow** (one commit each or grouped): F3 refund
   restock day on the park's current start; F4 the digest gets its own 05:00 send
   time; F5 demo seeds place times after midnight; F6 till and Console promo
   dates on the park's day, as food and shop already do; F7 and F8 copy,
   comments and docs; regenerate `packages/api-types/openapi.json` if route
   descriptions change.
3. **Tests.** Re-read the 37, read the 27, update what flips. Add:
   - shared: with `'00:00'`, `businessDate` equals the calendar date for every
     minute of a day (beside the 05:00 sweep in `business-date.test.ts:36`);
     TD fixtures for the park at midnight (00:30 Saturday is weekend and
     Saturday; 23:59 Friday is weekday and Friday);
   - api: after the switch migration every park reads `00:00` and the default is
     `00:00`; a sale at 00:10 Saturday is dated Saturday at the weekend price; a
     code valid until Friday is refused at 00:10 Saturday; Close Day at 23:50
     then a sale at 00:10 lands on the next day's open record; a sale at 23:55
     after Close Day lands on the closed day (today's rule, pinned until decision
     1); same-day credit ends at midnight and pre-switch credit keeps its stored
     time; the held-sale void and the day change agree; the digest still posts
     after 05:00;
   - box-agent: with a `00:00` bundle the booth cap resets at midnight and an
     offline 00:30 Saturday sale is weekend;
   - a guard: no source file outside fixtures holds `'05:00'` as a day start.
4. **The switch** (its own commit): a migration that sets every park's
   `business_day_start` to `'00:00'`. Push and deploy between 06:00 and 23:00
   Bangkok, never between midnight and 05:00. It reaches production with
   production's next deploy, at the same rule. Undoing it is the reverse update;
   nothing is lost.
5. **The decision builds**, if the owner picks one in decision 1 or 2: a
   separate lane after the switch, unless Step 0 shows days closed after
   midnight, in which case decision 2 lands with the switch.

**What to prove on staging.**

- Before: Console, Branches shows 05:00; screenshot the till's indicator and an
  evening's History and End of Day.
- After the deploy: Branches shows 00:00; `GET /branches/:id/pricing-mode`
  returns the calendar date; the booth card note is gone; "Add demo sales" puts
  the demo day at 10:00 to 16:15; the virtual box's Health line shows the new
  config version.
- The midnight edge itself, without staying up: a ZZ TEST park on
  `America/Los_Angeles` reaches its midnight at 15:00 Bangkok in November. A
  holiday range starting on its next date shows the price turning at its
  midnight, and a sale either side lands on the right day. This needs the test
  park set up with a station, tax and a package (I; the Console allows the
  timezone). The alternative is an evening session at the real park past
  midnight.
- The counter Pi, when the owner lets it online: its first heartbeat fetches the
  new bundle (Health shows the version).

**Honest size.** Step 0: one to two hours. Steps 1 and 2: half a day to a day,
about 15 source files. Step 3: one and a half to two days; this is the bulk.
Steps 4 and the proof: half a day, plus the test park. **About 3 to 4 working
days in one lane.** Decision 1 B adds about half a day, 1 C about a day and a
half; 1 D is SCRUM-513, several days in its own lane. Decision 2 B or C adds half
a day to a day. Decision 3 B adds about a day. Decision 4 B or C adds an hour or
two.

## 6. Decisions for the owner

The question "between midnight and closing on a late night, which day's prices
and which day's End of Day" is not asked on its own. The map shows no guest sale
after midnight in normal trading, and the ruling already answers it for any
that happens: the calendar day's prices and the calendar day's End of Day. The
part that is real is a late close, which is decision 2. Answered by the ruling
and recorded, not asked: staff allowances, Lucky Wheel limits, wallet credit,
online booking dates and night-time deposits all follow midnight. The morning
digest keeps posting at 05:00, as today.

**Decision 1. A sale made after Close Day was pressed, but before midnight.**
Today the sale is dated to the closed day, is on no End of Day, and nobody is
warned. Today this can happen until 05:00; after the switch, only until
midnight. A paid-out or safe drop on a closed day is already refused.

- A. Leave it as today. The sale shows in History and the reports on the closed
  day, and the late-sale correction (SCRUM-513) deals with it later.
- B. Warn the cashier before payment that today is closed and this sale will be
  on no End of Day. The sale still goes ahead as in A, and the manager sees a
  list of them.
- C. Put it on the next day: counted on tomorrow's End of Day and dated
  tomorrow, but priced at tonight's prices. The receipt's date and the price's
  day would then differ.
- D. A manager accepts it into the closed day, and that day's End of Day is
  reopened and corrected (the SCRUM-513 flow, its own build).

**Decision 2. Closing the day after midnight.** Only matters if the day is ever
closed after midnight; Step 0 shows how often. Today, until 05:00, End of Day
opens on the evening just finished, and safe drops and paid-outs count on it.
After the switch, at 00:15 it opens on the new, empty day.

- A. Accept it: staff pick yesterday's date to close, and money moved after
  midnight counts on the new day.
- B. Until yesterday is closed, End of Day opens on yesterday, and safe drops and
  paid-outs go on yesterday.
- C. As B, and the till also shows "Yesterday is not closed yet" until it is.

**Decision 3. Past days.** Today nothing stored is ever re-dated.

- A. Keep every stored date. Nothing closed changes. A few past records whose
  day is worked out when read (stock counts, purchase orders, older vouchers and
  wallet entries) and that happened between midnight and 05:00 show one day
  later from the switch on. Step 0 counts them first.
- B. As A, but those readers keep using 05:00 for anything before the switch,
  so old reports read exactly as they did.
- C. Re-date every past record to the calendar day, **including closed End of
  Day records and their cash counts**. Not recommended: it changes cash-ups
  people have already closed.

**Decision 4. The day-start setting in the Console.** Today anyone allowed to
edit a park can set any hour, with no warning.

- A. Keep it editable as today; it will show 00:00.
- B. Show it read only as "Midnight"; changing it again needs a build.
- C. Remove it from the screen; the setting stays in the database for a park in
  another country.

## 7. Found on the way, not part of this change

- `apps/console/src/pages/MoneyOversight.tsx:45-48`: the default range uses the
  browser's local date, not the park's.
- `apps/console/src/pages/AnalyticsSources.tsx:37-38` and
  `apps/console/src/pages/AnalyticsSourcesPanel.tsx:56`: default date is UTC.
- `apps/pos/src/components/shared/VerifyTierModal.tsx:55, 304`: a document's
  expiry is compared with the UTC date.
- `apps/pos/test/arrival-r1-gate2.test.ts`: a comment says the platform quotes
  the calendar date; it now quotes the business date.

## 8. Against one lane

- Decision 1 D is SCRUM-513 and should stay its own lane.
- The switch must be its own commit, deployed at a controlled hour; it cannot
  ride in a push that might deploy at night.
- Splitting the defaults, the fixes and the switch across lanes would leave a
  half-moved boundary between them, which the project rule calls a fault. So the
  switch is one lane, and only the decision builds are separate.
- The lane touches apps/api, apps/pos, apps/console, packages/shared and
  packages/box-agent. It must run the box-agent suite and the apps/api text
  pins, which is heavy on the laptop's memory.
- No box release is needed; do not tie this lane to the counter box release.
