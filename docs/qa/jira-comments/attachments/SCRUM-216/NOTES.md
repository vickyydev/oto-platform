# SCRUM-216 closing walkthrough on staging - capture notes

Captured 7 Oct 2026, about 08:17 to 08:45 Bangkok time, on the five platform
staging services (api, pos, console, launcher, booth) running `ca6322a7`
(read back from `render.mjs status`; the OTO App service runs its own build).

How it was driven: a Playwright script (kept in the session scratchpad, not
committed) signed in as the seeded platform admin account (Khun Anan, Owner;
the account the repo seed defines) on the staging POS and Console. No secret
is printed or stored anywhere in this folder. Nothing was committed and Jira
was not touched.

Rules kept: only Demo Branch 2 and demo data were written to. Nothing was
created that needs a "ZZ TEST" name (the demo control writes its own fixed
labelled sales). FWBooth1, payment run 0d008153, the package "Native payment
adult ticket 0d008153" and the OTO App check-ins were not opened, selected or
written. Three views below use "All branches" (6 Oct, 22 Sep and today); the
first two sum in the other two parks' stored days. They were looked at, never
written.

Wording: "READ-BACK" images are text cards rendered from a file or an API
answer read in the same session. They are not screens, and are labelled as
such on the image itself.

How the POS was put at Demo Branch 2 (needed for shots 2 to 4, 9): the till's
station picker has no park switch, so the page's own session was moved with
`PUT /me/session/branch` (the call the header's park dropdown makes), the
Demo Branch 2 till "Reception Till 1" was taken, then Demo Branch 2 was chosen
in the header's park dropdown (which hands the till back, so it was taken
again). The header in the shots reads "Demo Branch 2".

## Shots

| File | What the viewer literally sees | What was done to produce it |
|---|---|---|
| `SCRUM-216-staging-1-health-before-demo-press.png` | Console Health, scrolled to three cards. "Analytics rollup" with six lines: Oto Play Park Central Floresta and Robinson Chalong each as the day line, "report figures" line and "booth figures" line, every one "last rolled up 7 Oct, 08:18 - trading day 2026-10-07", "2m ago". No Demo Branch 2 line yet. Then the "Booths" card (FWBooth1 B1, Booth 2 B2, Booth 3 B3, FortuneWheelBooth FW) and the "Test controls" card with the text "The demo day is added at Demo Branch 2, never at a live park, and existing records are kept." and the first button "Add demo sales to Demo Branch 2 (today)". | Signed in to the Console, opened Health, widened the window so the three cards show together. Nothing pressed. |
| `SCRUM-216-staging-1-health-demo-pressed.png` | The Test controls card with its result line under the buttons: "Demo day 2026-10-07 at Demo Branch 2: 11 sales added, 0 already present. Existing records and closed-day totals were kept." | Pressed "Add demo sales to Demo Branch 2 (today)" once. The line does not mention the legacy fixture days. The shot 9 read-back (`-9-readback-3-summary-pisell.png`) shows a populated 12 Sep row (Pisell) and an all-zero 13 Sep row with null computedAt, so only the 12 Sep fixture is evidenced by an image; a 13 Sep fixture is not. |
| `SCRUM-216-staging-1-health-rollup-after-demo.png` | Same page after a reload: the Analytics rollup card now has nine lines, three of them new for "Demo Branch 2" (day, "report figures", "booth figures"), all "last rolled up 7 Oct, 08:21 - trading day 2026-10-07", "just now". Test controls card below. | Pressed "Run the analytics rollup now" (an existing staging control; page said "The analytics rollup ran (daily ok, hourly ok, booth ok)." - read from page text, not in the image), reloaded. That press was mine, not asked for; later shots show the schedule also rolled the day (Updated 08:33, 08:43). |
| `SCRUM-216-staging-2-performance-demo-branch-today.png` | POS Today > Performance. Header "Demo Branch 2"; Branch picker "Demo Branch 2" (other choice "All branches"); Date 10/07/2026. Line "Provisional - still being added up - Updated 08:33". Revenue ฿7,716, 10 transactions; Guests checked in 28, 14 kids - 14 adults; Parties today 0; Drop-off kids in park 0; Revenue split Tickets ฿7,716 100%, F&B/Merch/Parties/Drop-off ฿0; Ticket mix 0 (1 hour), 16 (2 hours), 11 (Full day). | Sign-in and Demo Branch 2 set-up as described above; opened Today > Performance at the default date. |
| `SCRUM-216-staging-2-performance-phone-demo-branch-today.png` | Same screen at 390x844: "Provisional - still being added up - Updated 08:33", Revenue ฿7,716 / 10 transactions, Guests 28 / 14 kids - 14 adults, start of Revenue split. The phone page scrolls inside itself, so only the top is in the picture. Bottom bar Tickets, F&B, Check-in, Events, History, Today (selected), Messages. | Fresh phone-size session, same set-up, opened Today. |
| `SCRUM-216-staging-3-performance-demo-branch-yesterday-empty.png` | Performance at Demo Branch 2 for 10/06/2026: line "Not updated yet", Revenue ฿0, 0 transactions, all splits ฿0, "No sales recorded for this day yet." | Changed the Date to 6 Oct. The image shows 6 Oct empty and nothing more; "no past demo day exists" is an inference from the code (problem 1) plus the empty 12 Sep shots in shot 9, not something the screen states. |
| `SCRUM-216-staging-3-performance-closed-day-all-branches-6-oct.png` | A past day with stored figures (the screen does not print "closed" or "final"; what it shows is no Provisional mark and an Updated time after the day ended). Subtitle "All branches", Date 10/06/2026, line "Updated 7 Oct, 05:03" with no "Provisional" mark. Revenue ฿6,795, "15 transactions - excl. ฿390 paid via credit"; Guests 12 (7 kids - 5 adults); Drop-off kids in park 1; Tickets ฿2,880 42%, F&B ฿260 4%, Merch ฿410 6%, Parties ฿0, Drop-off ฿3,245 48%; Ticket mix 10 / 2 / 0. | Picked "All branches" in the Branch picker and set the Date to 6 Oct. This is NOT the demo day: it sums the other two parks' stored days and is the nearest thing to "a closed day's own age" that exists (problem 1). Read-back (API, same session; text only, no image in this folder shows it): Central Floresta 6 Oct row 679,500 satang, 14 transactions, computed 2026-10-06T22:03Z (= 7 Oct 05:03 Bangkok); Robinson Chalong 0 satang, 1 transaction. |
| `SCRUM-216-staging-4-performance-all-branches-today.png` | Subtitle "All branches", Date 10/07/2026: "Provisional - still being added up - Updated 08:33", Revenue ฿7,716, 10 transactions, Guests 28, Drop-off kids in park 1, Ticket mix 0 / 16 / 11. | Branch picker set to "All branches" (offered because the account may read more than one branch). The figures equal Demo Branch 2's row in shot 2 (that equality is visible). Why (the other two parks having 0 today, and the "1" drop-off being a live count across parks) is a text read-back from the session, not pictured. |
| `SCRUM-216-staging-4-performance-all-branches-22-sep.png` | Subtitle "All branches", Date 09/22/2026, "Updated 7 Oct, 02:24", Revenue ฿6,416, 5 transactions, Guests 10 (5 kids - 5 adults), Tickets ฿6,416 100%, Ticket mix 0 / 4 / 6. | Same picker, Date set to 22 Sep, a day where both real parks have rows. Read-back (API; text only, not pictured): Central Floresta 482,600 satang + Robinson Chalong 159,000 satang = 641,600 = ฿6,416; transactions 4 + 1 = 5. |
| `SCRUM-216-staging-5-reports-ticket-type-sales.png` | POS admin Reporting > Sales, From 10/07/2026 To 10/07/2026 Branch Demo Branch 2. "Revenue by category - ฿7,816.00 total": Tickets ฿7,428.66 (9 txns), Add-ons ฿387.34 (3). Payment mix Card ฿2,966 (4), Cash ฿2,600 (4), Promptpay ฿2,070 (2), Wallet Credit ฿80 (1). Ticket sales by tier Tourist ฿5,550 (8), Expat ฿1,796 (1), Thai ฿470 (1). "Ticket type breakdown": Full Day Pass 3 lines, 6 kids, 5 adults, ฿3,726.00; 2 Hours Play 6 lines, 8 kids, 8 adults, ฿3,540.00. Weekday / weekend: Weekday 10 sales ฿7,816.00. Drop-off, events, F&B and merch tables say "No data in this range." | Opened `/admin?panel=reports-sales`, set the three filters. |
| `SCRUM-216-staging-6-reports-discounts-voucher-masked.png` | POS admin Discounts & Comps, same filters. Tiles: Total comps ฿0.00, Manual discounts ฿0.00, Promo codes ฿100.00, Free-item benefit ฿0.00, Total impact ฿100.00. "Promo code impact (1)": Txn D2-000008, At 10/7/2026 1:55:00 PM, Code "...F608" with "100 THB Voucher" under it, Type Fixed, ฿100.00. "By operator" and "Transactions (0)" say "No data in this range." | Opened `/admin?panel=reports-discounts`, set the filters. The code is shown masked (last four characters only). See problem 2 for the Manual discounts figure. |
| `SCRUM-216-staging-6-discounts-csv-first-lines.png` | READ-BACK of the downloaded file `promo-discount-impact_2026-10-07_2026-10-07.csv` (134 bytes, 2 lines): header `Transaction,At,Operator,Code,Label,Type,Amount` and the row `D2-000008,2026-10-07T06:55:00.000Z,Som (Reception),...F608,100 THB Voucher,fixed,100.00`. The code is masked in the file too. | Pressed "Export CSV" on the Promo code impact card; saved the browser download in the scratchpad and printed its first lines onto a card. |
| `SCRUM-216-staging-7-reports-tax-vat-receipts.png` | POS admin Tax & VAT, same filters. "VAT summary - ฿511.32 tax on ฿7,816.00 gross": Tickets net ฿7,428.66, incl. tax ฿485.99; Add-ons ฿387.34, incl. tax ฿25.33. "Bulk tax-receipt export (10 transactions)": the heading says 10, but the picture (1500x1126) is cut off after seven rows, ticket/D2-000010 down to ticket/D2-000004 (the top of an eighth row is clipped). D2-000003, D2-000002 and D2-000001 are NOT visible. Operator Som (Reception) on each visible row, with category, payment (Promptpay, Card, Cash, Wallet Credit, Card, Split, Cash), Subtotal, Tax, Total (for example D2-000008 Cash subtotal ฿450.00, tax ฿22.90, total ฿350.00; D2-000005 Split subtotal ฿1,896.00, total ฿1,796.00). | Opened `/admin?panel=reports-tax`, set the filters. The window was not tall enough for the whole list; retake it taller if all ten rows must be shown. |
| `SCRUM-216-staging-8-console-booth-report-demo-branch.png` | Console Booth report, Console - Demo Branch 2, Branch Demo Branch 2, From/To day 10/07/2026. Tiles Spins 0 ("0 prizes won"), Vouchers issued 0, Redeemed 0, Prize cost "-". Panel "No spins in these days - No booth was spun at these branches between the two days." Note text "Figures brought up to date 4m ago (7 Oct, 08:38)." No funnel, rate or prize cost figures can be shown here: problem 3. | Opened Booth report, chose Demo Branch 2 and 7 Oct for both days, pressed Refresh. Deliberately NOT run on "All branches" or Central Floresta, which would show FWBooth1's figures. |
| `SCRUM-216-staging-8-booth-csv-first-lines.png` | READ-BACK of `booth-report_2026-10-07_2026-10-07.csv` (183 bytes): one line only, the header `"Trading day","Branch","Booth","Staff","Prize","Spins","Prizes won","Vouchers issued","Vouchers redeemed","Redemption rate (%)","Mean redemption lag (minutes)","Prize cost (THB)"`; no data rows. | Pressed "Download CSV"; saved the download and printed it onto a card. |
| `SCRUM-216-staging-9-performance-before-switch-12-sep-oto-pos.png` | Demo Branch 2 Performance for 09/12/2026 while the source is the platform's own (oto_pos): ฿0, 0 transactions, "No sales recorded for this day yet." | Set Date to 12 Sep, source untouched. |
| `SCRUM-216-staging-9-readback-1-sources-before.png` | READ-BACK `GET /analytics/sources` for Demo Branch 2 before: source oto_pos, preference oto_pos, switchedAt null, actorAccountId null. | Read through the admin's POS session. |
| `SCRUM-216-staging-9-readback-2-sources-pisell.png` | READ-BACK after the switch: source pisell, preference oto_pos, switchedAt 2026-10-07T01:44:35.694Z, an actor account id. | `PUT /analytics/sources/<Demo Branch 2>` with `{source: "pisell", preference: "oto_pos"}` from the admin's POS session (the card says it answered HTTP 200; `changed: true` is not on the card). There is no screen for this switch; only the API. The preference was left as it was. |
| `SCRUM-216-staging-9-performance-pisell-frozen-12-sep.png` | Demo Branch 2 Performance for 09/12/2026 on Pisell: "Updated 13 Sept, 08:15" with no "Provisional" mark. Revenue ฿67,330, 142 transactions; Guests 177 (96 kids - 81 adults); Parties 2 "Booked for this day"; Tickets ฿38,450 57%, F&B ฿11,540 17%, Merch ฿1,860 3%, Parties ฿12,500 19%, Drop-off ฿2,980 4%; Ticket mix 22 / 61 / 94. The word "final" (or "frozen") is not printed anywhere on the screen, and the screen does not name Pisell as the source either; "final" here means the absence of the Provisional mark plus `provisional: false` in the read-back below, and the source is evidenced only by the read-back cards (-9-readback-2 and -3). | Changed the Date to 13 Sep and back to 12 Sep to force a fresh read. |
| `SCRUM-216-staging-9-readback-3-summary-pisell.png` | READ-BACK `GET /analytics/summary` (Demo Branch 2, 12-13 Sep, group=day) on Pisell: source "pisell"; 2026-09-12 provisional false, formulaVersion 30, computedAt 2026-09-13T01:15:00.000Z, revenueSatang 6,733,000, txnCount 142, guestsKids 96, guestsAdults 81; 2026-09-13 provisional false, formulaVersion null, computedAt null, zeros (the card does not say why; "a Papaya day Pisell does not serve" is from the code, not the card, and the all-zero row with null computedAt looks the same as an empty day). | Read through the admin's POS session; selected fields only. |
| `SCRUM-216-staging-9-performance-pisell-today-not-served.png` | Same screen on Pisell for today 10/07/2026: "Not updated yet", ฿0, 0 transactions, "No sales recorded for today yet." (a legacy source serves only its frozen days). | Date set to 7 Oct while on Pisell. |
| `SCRUM-216-staging-9-readback-4-sources-restored.png` | READ-BACK after switching back: source oto_pos, preference oto_pos, switchedAt 2026-10-07T01:44:52.402Z. | `PUT` with `{source: "oto_pos", preference: "oto_pos"}` (the card says HTTP 200; `changed: true` and the script's `finally` are not on the card). |
| `SCRUM-216-staging-9-performance-restored-today.png` | Demo Branch 2 Performance for 10/07/2026 showing the platform's own figures again (the screen does not name the source; shot -9-readback-4 shows oto_pos): "Provisional - still being added up - Updated 08:43", ฿7,716, 10 transactions, Guests 28, Ticket mix 0 / 16 / 11 (same as shot 2). | Date set to 6 Oct, then 7 Oct, after the restore. |
| `SCRUM-216-staging-9-performance-restored-12-sep-empty.png` | 09/12/2026 at Demo Branch 2 again empty: ฿0, "No sales recorded for this day yet." | Date set to 12 Sep after the restore. |

## Restored state

Demo Branch 2's reporting source is back on `oto_pos` with preference
`oto_pos`. A final independent read (a separate sign-in; text only, no image in this folder shows it) listed: Demo Branch 2
oto_pos / oto_pos, switchedAt 2026-10-07T01:44:52Z; Central Floresta and
Robinson Chalong oto_pos / oto_pos, never switched (switchedAt null). The
switch left a trace that cannot be put back to null: Demo Branch 2 now has a
switchedAt time and an actor, and the route's description says each switch is
audited (not checked in the audit log).

## What stays on staging

- The demo day for 7 Oct at Demo Branch 2 (11 sales as the Test controls line
  says; the Performance and Tax screens show 10 transactions), the 12 Sep
  legacy fixture day (evidenced in shot 9; a 13 Sep fixture is claimed but no
  image evidences it), Demo Branch 2 itself (made by the first press), and its
  analytics rows. The demo control keeps them by design.
- The admin's browser sessions from the script were not signed out; they end
  with their own expiry.
- Reception Till 1 at Demo Branch 2 was taken by these sessions (a session
  setting, no record).

## Problems found (photographed, not fixed)

1. **No closed demo day exists to photograph.** The demo control writes only
   the current business date at Demo Branch 2 (`seedDemoDay`, no date
   argument from the control), so Demo Branch 2 has one stored day, today's,
   still Provisional, and nothing before it under `oto_pos` (6 Oct and 12 Sep
   are empty in shots 3 and 9). Shot 3's "stored figures, the day's own age"
   is therefore shown on the real parks' closed 6 Oct through All branches,
   not on the demo day. It will exist for the demo day itself once the trading
   day ends and the rollup runs after it.
2. **Discounts & Comps does not count the demo day's staff discount.** The
   screen shows Manual discounts ฿0.00, "By operator" no data, "Transactions
   (0)" and Total impact ฿100.00, while the same day's summary row (read-back,
   API) has discountsSatang 20,000 (฿200) and refundsSatang 10,000, and the
   tax list shows D2-000005 at subtotal ฿1,896.00 against total ฿1,796.00
   (฿100 off). From the code (`demo-day.ts`, not from a screen): the split sale
   carries a ฿100 discount on the sale row but only the voucher sale gets a
   `sale_discount` row, which is probably why the report omits it. So either the
   demo seed should write that row, or the report should read the sale's own
   figure. Not decided or fixed here.
3. **Booth report has no funnel at Demo Branch 2.** The demo day makes no booth
   spins, so shot 8 shows "No spins in these days" and a header-only CSV, not
   the funnel, rate and prize cost the brief expected. A funnel with figures
   does exist on staging at Central Floresta (seen in an exploratory look at
   All branches: hundreds of spins, a prize cost, all from FWBooth1 and one ZZ QA
   booth), but it was not photographed because it is FWBooth1's data.
4. **Demo sales are timed later than the staging clock.** The demo day's
   sales carry times from 10:00 to 15:00 (Tax receipt list: 3:00:00 PM for
   D2-000010) while the page clocks read 08:17 to 08:45 at capture. Same day,
   so it passes the date filters, but a screen that sorts or filters by time
   of day would see sales from the future.
5. Observation, not a defect: Performance says ฿7,716 where Sales and Tax say
   ฿7,816.00. The summary row's refundsSatang is 10,000, which is the ฿100
   partial cash refund the demo seeds. Ticket-type rows cover package lines
   only (adults 5 + 8 = 13 against 14 on Performance); `demo-day.ts` has a
   separate "Adult Admission" line without a package, which would explain it.

## Not shot / out of scope

- Papaya source (13 Sep fixture) was not switched to.
- The Performance phone shot covers the top of the page only (the page scrolls
  inside itself).
- Radar and the OTO App were not opened.

## Retakes after the demo-seed fix (main db2e89ff)

Captured 7 Oct 2026, about 10:41 to 10:50 Bangkok time (file times 10:43 to
10:48), on the five platform staging services, which `render.mjs status` read
back as live on `db2e89ff` (the OTO App service runs its own build, `547532f2`).
Same driver as above: the seeded platform admin (Khun Anan, Owner), signed in
from the repo seed; no secret printed or stored. Demo Branch 2 and demo data
only. Nothing was created, so no "ZZ TEST" name was needed. FWBooth1, payment
run 0d008153, the package "Native payment adult ticket 0d008153" and the OTO App
check-ins were not selected or written; no branch's reporting source was
switched. All report filters are as in the originals: Demo Branch 2, 10/07/2026
to 10/07/2026. Nothing was committed and Jira was not touched.

Order of events: (1) on Console > Health, "Add demo sales to Demo Branch 2
(today)" pressed once; (2) "Run the analytics rollup now" pressed once and the
page reloaded (the page said "The analytics rollup ran (daily ok, hourly ok,
booth ok)." - read from page text, not in an image; the reloaded Analytics
rollup card listed nine lines, each "last rolled up 7 Oct, 10:43 - trading day
2026-10-07" - text read-back, not pictured); (3) the POS and Console shots below.

| File | What the viewer literally sees | What was done to produce it |
|---|---|---|
| `SCRUM-216-staging-10-health-repress.png` (NEW) | Console Health, bottom of the page. At the top, a sliver of one line, "FortuneWheelBox (booth-1)" (read as the box line of the booth above Booth 2 in the list, which shot 1 names as FWBooth1; that inference is from the list order, the card itself is out of frame). Then the full cards for "Booth 2 (proof) (B2)", "Booth 3 (fixes) (B3)" and "FortuneWheelBooth (FW)", then the Test controls card with its button rows and, under the buttons, the result line "Demo day 2026-10-07 at Demo Branch 2: 0 sales added, 11 already present (1 manual discount row added to them); booth: 5 spins added, 0 already present. Existing records and closed-day totals were kept." The sidebar reads "Central Floresta" under OTO Console. The Booths list above the card is just part of the page; nothing in it was opened. | Pressed "Add demo sales to Demo Branch 2 (today)" once and photographed the page when the line appeared. The line says "0 sales added, 11 already present", so the 11 sales from the first press were kept and not duplicated; the new work was the manual discount row and the five booth spins. |
| `SCRUM-216-staging-7-reports-tax-vat-receipts.png` (REPLACED, 1500x1128) | POS admin Tax & VAT, From 10/07/2026 To 10/07/2026, Branch Demo Branch 2. "VAT summary - ฿511.32 tax on ฿7,816.00 gross": Tickets net ฿7,428.66, incl. tax ฿485.99; Add-ons ฿387.34, incl. tax ฿25.33. "Bulk tax-receipt export (10 transactions)" with all ten rows visible, ticket/D2-000010 at the top to ticket/D2-000001 at the bottom, and the card's lower edge in view. Operator Som (Reception) on every row. Payment / Subtotal / Tax / Total per row: 000010 Promptpay 690.00 / 45.14 / 690.00; 000009 Card 450.00 / 29.44 / 450.00; 000008 Cash 450.00 / 22.90 / 350.00; 000007 Wallet Credit 80.00 / 5.23 / 80.00; 000006 Card 1,250.00 / 81.78 / 1,250.00; 000005 Split 1,896.00 / 117.49 / 1,796.00; 000004 Cash 450.00 / 29.44 / 450.00; 000003 Promptpay 1,380.00 / 90.28 / 1,380.00; 000002 Card 470.00 / 30.74 / 470.00; 000001 Cash 900.00 / 58.88 / 900.00. | Window made 1500x2600 so nothing clips, opened `/admin?panel=reports-tax`, set the three filters, cropped the picture to the bottom of the page content. One frame was enough, so no -7a / -7b. In the same page the DOM held ten receipt rows and the heading said 10 (page text, same session). |
| `SCRUM-216-staging-6-reports-discounts-voucher-masked.png` (REPLACED, 1500x1198) | POS admin Discounts & Comps, same filters. Tiles: Total comps ฿0.00, Manual discounts ฿100.00, Promo codes ฿100.00, Free-item benefit ฿0.00, Total impact ฿200.00. "Promo impact by type": Fixed, 1, ฿100.00. "By operator": Som (Reception), Comps 0, Comp ฿0.00, Discounts 1, Discount ฿100.00. "Promo code impact (1)": D2-000008, 10/7/2026 1:55:00 PM, code shown as "...F608" with "100 THB Voucher" under it, Fixed, ฿100.00 (masked: last four characters only). "Transactions (1)": sale/D2-000005, 10/7/2026 12:50:00 PM, type Fixed, reason Loyalty, applied by Som (Reception), ฿100.00. | Opened `/admin?panel=reports-discounts`, set the filters, cropped to the page content. All four cards sit in one frame. |
| `SCRUM-216-staging-6b-manual-csv-first-lines.png` (NEW) | READ-BACK card (labelled "not a screen itself") of the downloaded file `discount-comp-transactions_2026-10-07_2026-10-07.csv` (159 bytes, 2 lines): header `Source,Transaction,At,Operator,Type,Reason,Note,Amount,Applied by` and the row `sale,D2-000005,2026-10-07T05:50:00.000Z,Som (Reception),fixed,Loyalty,,100.00,Som (Reception)`. | Pressed "Export CSV" on the Transactions card, saved the browser download in the scratchpad, printed its first lines onto a card. This is the manual-discount file (the Transactions card); the earlier `-6-discounts-csv-first-lines.png` is the Promo code impact file and is unchanged. |
| `SCRUM-216-staging-8-console-booth-report-demo-branch.png` (REPLACED, 1500x1165) | Console Booth report, "Console - Demo Branch 2", Branch Demo Branch 2, From day 10/07/2026, To day 10/07/2026, "Figures brought up to date 3m ago (7 Oct, 10:43)". Tiles: Spins 5 ("5 prizes won"), Vouchers issued 5 ("slips that reached the platform"), Redeemed 0 ("0.0% - typically - after the spin"), Prize cost ฿700 ("as costed when each prize was won"). By booth: Demo Booth 1 / Demo Branch 2, 5 spins, 5 prizes won, 5 issued, 0 redeemed, 0.0%, ฿700. By prize: 100 THB Voucher 2 spins / 2 won / 2 issued / 0 redeemed / ฿200; 150 THB Voucher 2 / 2 / 2 / 0 / ฿300; 200 THB Voucher 1 / 1 / 1 / 0 / ฿200. By staff: Som (Reception), Demo Booth 1, 5 / 5 / 5 / 0 / ฿700. | Opened Booth report, chose Demo Branch 2 and 7 Oct for both days, pressed Refresh, enlarged the window to the page height so all three tables show. The booth on screen is "Demo Booth 1" at Demo Branch 2, not FWBooth1; the screen shows no other booth. |
| `SCRUM-216-staging-8-booth-csv-first-lines.png` (REPLACED) | READ-BACK card of `booth-report_2026-10-07_2026-10-07.csv` (528 bytes, 4 lines): the header row (Trading day, Branch, Booth, Staff, Prize, Spins, Prizes won, Vouchers issued, Vouchers redeemed, Redemption rate (%), Mean redemption lag (minutes), Prize cost (THB)) and three data rows, each starting "2026-10-07","Demo Branch 2","Demo Booth 1","Som (Reception)", then: "100 THB Voucher","2","2","2","0","0.0","","200.00"; "150 THB Voucher","2","2","2","0","0.0","","300.00"; "200 THB Voucher","1","1","1","0","0.0","","200.00". | Pressed "Download CSV", saved the download, printed its first lines onto a card. The rows match the By prize table on the Booth report screen. |
| `SCRUM-216-staging-11-performance-demo-branch-today-after-repress.png` (NEW, comparison) | POS Today > Performance, header "Demo Branch 2", Branch Demo Branch 2, Date 10/07/2026, "Provisional - still being added up - Updated 10:43". Revenue ฿7,716, 10 transactions; Guests checked in 28, 14 kids - 14 adults; Parties today 0; Drop-off kids in park 0; Tickets ฿7,716 100%, F&B / Merch / Parties / Drop-off ฿0; the Ticket mix card is cut off at the bottom edge (the counts are only partly in view). | Taken after the retakes so the Tax and Performance screens can be compared at the same hour (see R2). Top of the page only, 1500x1000. The Performance figures did not move after the press and rollup (still ฿7,716 / 10 / 28, as in shot 2). |
| `SCRUM-216-staging-12-readback-summary-after-repress.png` (NEW) | READ-BACK card (labelled "not a screen") of `GET /analytics/summary` for Demo Branch 2, 2026-10-07, group=day, selected fields: status 200, branch "Demo Branch 2", businessDate "2026-10-07", provisional true, computedAt "2026-10-07T01:21:17.912Z", revenueSatang 771600, refundsSatang 10000, discountsSatang 20000, compsSatang 0, vatSatang 51132, txnCount 10. The card's own line says "after the demo press and rollup", which says when it was read; its computedAt is 08:21 Bangkok, earlier than the 10:43 press (see R3), so the row was not recomputed by the press. The figures agree with the screens: 771600 = ฿7,716 (Performance), vatSatang 51132 = ฿511.32 (Tax & VAT), discountsSatang 20000 = ฿200 (Discounts total impact), txnCount 10. | Read through the admin's Console session with the page's own fetch; the fields were chosen by the script, not the whole answer. |

## What the retakes show about the earlier problems (read from the new pixels)

- Earlier problem 2 (Discounts & Comps showed Manual discounts ฿0.00): the
  screen now shows Manual discounts ฿100.00, a By operator row, one Transactions
  row (sale/D2-000005, Loyalty, ฿100.00), and the masked voucher row still
  present. Total impact ฿200.00 equals the summary row's discountsSatang 20000
  in the read-back card (-12), and the tax list still shows D2-000005 at
  subtotal ฿1,896.00 against total ฿1,796.00.
- Earlier problem 3 (booth report empty at Demo Branch 2): now 5 spins, 5 prizes
  won, 5 vouchers issued, 0 redeemed, ฿700 prize cost, with a breakdown by
  booth, prize and staff, and a CSV with three data rows.
- Earlier problem 4 (sales timed later than the staging clock): unchanged. The
  Tax list still shows D2-000010 at 3:00:00 PM while the pages read 10:43.
- Earlier problem 1 (no closed demo day): unchanged, not retaken.

## New observations (photographed or read, not fixed)

R1. Booth "Redeemed" is 0 at Demo Branch 2 while the Discounts screen counts
    one "100 THB Voucher" code (...F608) applied on D2-000008. The two screens
    count different things: the booth report counts slips the booth issued and
    that were later redeemed; the Discounts screen counts a promo code applied
    on a sale. Nothing on either screen says that code came from Demo Booth 1,
    so no claim is made that it should show as a booth redemption. If the demo
    day is meant to show a redeemed booth voucher, the two are not linked.
    Photographed: -8-console-booth-report (Redeemed 0) and
    -6-reports-discounts (promo code row D2-000008).
R2. The ฿100 gap between Performance (฿7,716, 10 transactions, -11) and Sales /
    Tax & VAT (฿7,816.00 gross, 10 transactions, -7) is still there. The -12
    read-back shows refundsSatang 10000 in the same summary row as
    revenueSatang 771600. The subtraction (7,816 - 100 = 7,716) is arithmetic
    done here, not something either screen states. Carried from earlier
    observation 5.
R3. The summary row's computedAt (08:21 Bangkok, `2026-10-07T01:21:17.912Z`) is
    earlier than the Performance line's "Updated 10:43". The code comment in
    `analytics-summary.ts` says a row's computed_at moves only when its figures
    moved, and the line takes the newest computed_at across the day's rows, so
    10:43 is read as the newest of several tables. That is from the code, not
    from a screen. The figures themselves agree (7,716 / 10 on Performance,
    771600 / 10 in the row).
R4. Console > Vouchers was opened once, read-only, to look for the five booth
    vouchers behind the Booth report. Its default listing showed three vouchers
    from FWBooth1 (the screen follows the Console's own park, Central Floresta,
    per its sidebar; this is an inference) and none from Demo Booth 1; its booth
    filter did not list Demo Booth 1. Nothing on that page was selected,
    changed or photographed, and FWBooth1 was not interacted with. No claim is
    made about whether the Vouchers page should list Demo Branch 2's slips.

## Still on staging after the retakes

Same as above, plus: the 7 Oct demo day at Demo Branch 2 now has one manual
discount row (D2-000005's Loyalty ฿100) and five labelled booth spins at Demo
Booth 1. The admin sessions from the scripts were not signed out. Demo Branch
2's reporting source stayed oto_pos.
