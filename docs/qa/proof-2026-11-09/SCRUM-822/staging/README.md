# SCRUM-822 the party's money in one place — the BEO reads the till: staging proof

Run on Wednesday 11 November 2026, from 02:07 to 02:18 Bangkok time, on staging. SCRUM-833 (the Day-of POS section printed
the package's satang as baht, ฿1,690,000) is covered by step 6. The run used one ZZ TEST party and one ZZ TEST workshop in
the OTO App, and one ZZ TEST till. The till's business day starts at 05:00, so the whole run fell on the business day of
10 November (a Tuesday); the party itself is dated Wednesday 18 November, a weekday.

**Live on staging**, read with `scripts/agent/render.mjs deploys` before the run (02:01) and after it (02:18). Both readings
were the same, and nothing was deployed or restarted during the run. All five services were live at
d14ba1c65321a3710064145132d1b4c33b5eec42 from 01:50–01:53 Bangkok.

| Service | Live commit | Deploy | Live since (Bangkok) |
|---|---|---|---|
| oto-api-staging | d14ba1c6 | dep-dbpmedrl550s73dplf70 | 01:53 |
| oto-app-staging | d14ba1c6 | dep-dbpmeeetlv9c73dofkl0 | 01:51 |
| oto-pos-staging | d14ba1c6 | dep-dbpmeesipgvc7385uuhg | 01:50 |
| oto-pos-web-staging | d14ba1c6 | dep-dbpmef59fdbs73fbom0g | 01:52 |
| oto-console-staging | d14ba1c6 | dep-dbpmeflg1s2s73dv4v90 | 01:50 |

No migration shipped with 822 (platform at 0114, app at 0047).

## The set-up

- **The party:** "ZZ TEST 822 Floresta" was created in the OTO App by the staging administrator, signed in through the
  launcher: a birthday at Oto Play Park, Central Floresta, Wednesday 18 November 2026, 13:00–16:00, 10 children, 4 adults
  (`POST /api/admin/events`, 201). "Birthday package, Central Floresta" was applied through the Birthday Package section's own
  route (`POST /api/beo/events/:eventId/package-snapshot`, 201). The snapshot's base price field reads 1690000 — satang, the
  figure SCRUM-833 printed as baht.
- **The workshop (step 10):** "ZZ TEST 822 workshop", a workshop at the same park on the same day, made the same way (201).
- **The till:** "ZZ TEST SCRUM-822 till", receipt prefix Z822X, set up on Virtual box 1 with the simulated kids band printer,
  adult band printer and Receipt Printer 1 through the Console's station route; the reception account signed it in. Never the
  Pi, its tills, Reception Till 1 or FWBooth1.
- **Socks:** the Regular Socks shelf at Central Floresta read 0 and the settlement hands out 10 free pairs, so +10 were put in
  through the Console's Inventory › Adjust ("ZZ TEST SCRUM-822: 10 pairs in for the party settlement", 200). The sale took
  them, and the shelf read 0 again at the end.
- **Pictures:** 1440 wide, light, en-GB, Asia/Bangkok (the Billing, POS and Day-of pictures taller so the section fits). Real
  names are covered with solid magenta boxes and the signed-in user's avatar chip is masked. In the OTO App's BEO pictures the
  events board behind the sheet is hidden, because its cards carry customers' party names. A magenta box over a word of the
  till's own "Hide customer display" label (pictures 08, 09) is the harness over-covering; nothing is hidden there. The PDF
  pictures are the saved files' pages drawn by pdf.js.

## The figures

The till priced the party at **฿17,025**: the package at its weekday price ฿16,900, every included line and the guests at
"Included" (Children × 10, Adults × 4, Regular Socks × 10), and the ZZ TEST 822 bubble tea ฿125. Deposit paid ฿3,000.
Outstanding ฿14,025. The till's own Settle preview (`POST /parties/:id/settle/preview`) answered the same satang: 1702500 /
300000 / 1402500, the same eleven lines. These are the builder's expected figures.

## Checks

| # | Check | Result | What showed | Picture |
|---|---|---|---|---|
| 1 | The ZZ TEST party at Central Floresta, Wed 18 Nov, 10/4; the Floresta package applied in the Birthday Package section | Pass | The section reads "Birthday package, Central Floresta · Applied", "Up to 10 children · 4 adults included · Socks for all children · 3 hours · Weekday / weekend ฿16,900.00 / ฿20,900.00 · Extra child ฿1,300.00 / ฿1,500.00 · Extra adult ฿350.00 / ฿500.00", six package items. The header badge read "No Deposit" before any deposit | 01-beo-birthday-package-applied |
| 2 | Kitchen Plan › Adults menu › New item: "ZZ TEST 822 bubble tea", bar, ฿125; Save the BEO | Pass | The route answered 200 (02:08:53), code PARTY-B73D36CC; toast "New item added: ZZ TEST 822 bubble tea is on the till as PARTY-B73D36CC, for this party only." Save answered 200, "BEO data saved successfully"; after a fresh load the Adults list still shows "EXTRA 1 ZZ TEST 822 bubble tea PARTY-B73D36CC" | 02-beo-new-item-bubble-tea |
| 3 | Billing section: Deposit Paid 3000 typed, the field left — one write; "Refresh from the till" pressed | Pass | Before the deposit the panel already read Expected total ฿17,025 / Deposit paid ฿0 / Outstanding ฿17,025. Typing 3000 and leaving the field sent **one** `PUT /api/events/:eventId/beo/billing` (200) carrying `{depositPaidAmount: 3000, depositPaid: true}`. Refresh re-read `GET /api/events/:eventId/beo/till-billing` (200, status ok, state quote, read 02:09) | 04-billing-from-the-till-quote |
| 4 | "From the till": the Quote badge, the three figures, the breakdown, "The app's own invoice rows" beneath | Pass | Badge **Quote**. Expected total **฿17,025**, Deposit paid **฿3,000**, Outstanding **฿14,025**. Breakdown: Birthday package, Central Floresta ฿16,900; six package lines Included; Children (in the package) × 10 Included; Adults (in the package) × 4 Included; Regular Socks (free) × 10 Included; ZZ TEST 822 bubble tea ฿125. "The till's figures, read 02:09. Nothing here is typed twice." The Quote PDF button is there. Below: "The app's own invoice rows — Kept for the staff who use them…" heading the unchanged billing module (Deposit Paid 3000) | 04-billing-from-the-till-quote |
| 5 | Party Details (the POS section): "Total · from the till" and Outstanding with the Deposit between; the badges | Pass | Tiles: Total · from the till **฿17,025**, Deposit **3,000**, Outstanding **฿14,025**; under them "The till's quote, read 02:10." The POS section badge reads ฿17,025, the Billing badge "฿14,025 outstanding", the header badge "฿14,025 Due". No price input in the section: "What the POS team should know is included or extra. The prices are the till's." | 05-party-details-tiles-and-badges, 05b-beo-header-due-badge |
| 6 | Day-of Execution view (SCRUM-833): the POS header badge, the package price, "The till's quote", the money rows | Pass | The POS badge ฿17,025; the package "Birthday package, Central Floresta" at **฿16,900** (not ฿1,690,000: the old figure appears nowhere on the page); "THE TILL'S QUOTE" with the eleven lines; Expected total ฿17,025 / Deposit paid ฿3,000 / Outstanding ฿14,025 | 06-day-of-pos-section-quote |
| 7 | Quote PDF from the Billing section's button | Pass, with a note | The button is `GET /api/events/:eventId/beo/quote.pdf`; pressing it downloaded "Quote_ZZ_TEST_822_Floresta_2026-11-18.pdf" (200, application/pdf, inline, 69 KB, saved here as quote-ZZ-TEST-822-Floresta-2026-11-18.pdf). It carries the park header (Oto Play Park, Central Floresta and its address), "Party quote · Issued 11/11/2026", Party, Date Wednesday 18 November 2026, Time 13:00 – 16:00, Guests 10 children, 4 adults, Package "Birthday package, Central Floresta (weekday price)", all eleven lines with Qty and Amount, Total ฿17,025, Deposit paid -฿3,000, Balance to pay ฿14,025, and the validity note. **Note:** the validity note lands alone on page 2 (the table fills page 1) | 07-quote-pdf-page-1, 07b-quote-pdf-page-2-validity-note |
| 8 | The ZZ TEST till: the party on 18 Nov, Settle with 10 children / 4 adults, the preview the same as the app; Confirm; cash | Pass | Events stepped to "Wednesday, 18 Nov 2026" (Next day ×8); the party opened with "Settle party". The form opened at 10 / 4 / 10 socks (the plan's counts). Preview: Birthday package, Central Floresta · weekday ฿16,900; Socks · 10 free ฿0; Add-ons ฿125; **Total ฿17,025; Deposit paid −฿3,000; Balance ฿14,025**; the customer pane "To pay ฿14,025". `POST /parties/:id/settle` 200 (02:14:18); Cash, Confirm Payment Received → `POST /sales/:saleId/finalise` 200 (02:14:23); "Party settled — Settled, receipt **Z822X-000001**". The sale read back: finalised, gross 1702500, eleven lines, 10 socks out of stock (shelf 10 → 0) | 08a-till-party-page, 08-till-settle-preview, 09-till-settled-receipt |
| 9 | Billing section after the settle: Refresh from the till | Pass | Badge **Settled**. Total ฿17,025, Deposit paid ฿3,000, **Outstanding ฿0**. "Receipt Z822X-000001 · ZZ TEST SCRUM-822 till — Settled 11 Nov 2026, 02:14". "The sale" lists the eleven lines; Payments: "Deposit paid in advance ฿3,000", "Cash ฿14,025". "The till's figures, read 02:14." **No Quote PDF button**; `GET …/beo/quote.pdf` now answers **409 PARTY_SETTLED** "This party is settled at the till: its receipt is the record, not a quote." The POS tiles read ฿17,025 / 3,000 / ฿0, "Settled at the till, read 02:14."; the Billing badge and the header badge read "Paid". The Day-of POS section reads "THE TILL'S SALE · RECEIPT Z822X-000001", Total ฿17,025 / Deposit paid ฿3,000 / Outstanding ฿0, POS Ref = the sale's id | 10-billing-from-the-till-settled, 10b-beo-header-paid-after-settle, 11-day-of-pos-section-settled |
| 10 | An event the till never settles (the ZZ TEST workshop) says "Not settled at the till" | Pass | `GET …/beo/till-billing` answers status **not_a_party** ("The till settles birthdays, private events and school groups, so it holds no money for this event."); `GET …/beo/quote.pdf` answers **409 NOT_A_PARTY**. In its BEO the From the till panel and both POS tiles read "Not settled at the till" with that sentence, no figure, no Quote PDF button, no badge; "Till not reachable" appears nowhere on the sheet. Its Day-of view has nothing for the POS and nothing from the till, so it draws no POS section (by design), and says "Till not reachable" nowhere | 12-workshop-not-settled-at-the-till, 12b-workshop-day-of-view |
| 11 | The BEO PDF of the party carries the till's figures | Pass | `GET /api/events/:eventId/beo/pdf` (the Print / Download PDF route; on staging it answers 302 to a short-lived signed link, as before 822, and the file followed it): one page; "POS: BIRTHDAY PACKAGE, CENTRAL FLORESTA — Total (from the till): ฿17,025 · Deposit paid: ฿3,000 · Outstanding: ฿0 · Receipt: Z822X-000001". None of "POS Total", "Base Price" or "Outstanding Balance" is on it | 13-beo-pdf-page-1 |
| — | Read-back through the app's API as the signed-in administrator | Pass | `GET /api/events/:eventId/beo/till-billing`: ok, state sale, receipt Z822X-000001, settled at ZZ TEST SCRUM-822 till, gross 1702500, paid 1702500, deposit 300000, outstanding 0, kids 10, adults 4, payments deposit_paid_in_advance 300000 + cash 1402500. The app's own billing row: posOrderRef = the sale's id, depositPaid true, 3000. The till's party read: settlement settled, writeBack synced | — |

## Findings

1. **Quote PDF, cosmetic:** with eleven lines the validity note alone spills onto page 2. A smaller top margin or a tighter
   table would keep a one-page quote (07b).
2. **The app's own billing module (kept whole, unchanged by 822):** with no invoice rows and a deposit of 3,000 its Financial
   Summary reads "PAID — Overpaid: ฿3,000" under the till's "฿14,025 outstanding" (04, 10). The module's own arithmetic, not
   the till's; the owner may want that summary to stop calling a deposit "overpaid" when the till holds the party's money.
3. **The module's Deposit Paid field, cosmetic:** typing 3000 into the field that held 0 left it reading "03000" until the
   next load (the module's number input appends after its 0; the write carried 3000, and after a reload it reads 3000).
4. **The till's own party page, outside 822:** before the settle its "Party bill" card read Birthday package ฿0 / Total ฿0 /
   Deposit paid −฿3000 / Outstanding ฿0 with a "Fully paid" button (08a) — the tab's figures, not the quote; the Settle form
   is where the till quotes the party. Worth a look in the till's own round.

## Clean-up, each read back

- The ZZ TEST till signed out (its `/me` 401), its printers unassigned (200), archived (200): read back archived, 0 devices.
  Till 1 (Pi), Till 2 (test), Reception Till 1 and FWBooth1 untouched (read only).
- The settled sale Z822X-000001 stays on the archived till: nothing voided.
- "ZZ TEST 822 Floresta" and "ZZ TEST 822 workshop" archived through the app's own archive route (200), read back archived.
  The party keeps its settlement.
- The socks shelf read 0 at the end (10 in, 10 taken by the sale).
- Every session signed out and read back: the Console 401, the OTO App 401, the launcher 401, the till 401, the admin api
  session 401.

The receipt (`receipt.json`) holds every route, status, id and satang figure of the run; no name, phone number or key.
