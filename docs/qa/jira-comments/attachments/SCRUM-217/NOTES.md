# SCRUM-217 events walkthrough on staging - capture notes

Captured 8 Oct 2026, about 03:22 to 04:22 Bangkok time, which is still trading
day 2026-10-07 at Demo Branch 2 (the business day rolls at 05:00; every screen
below reads "Wednesday, 07 Oct 2026"). All six staging services (api, pos,
console, launcher, booth, oto-app) were read back from `render.mjs status` as
live on `c6194664` at the start of the run.

How it was driven: Playwright scripts (kept in the session scratchpad, not
committed) signed in as the seeded platform admin (Khun Anan, Owner; the
account the repo seed defines) on the staging POS and Console. No secret is
printed or stored in this folder. Nothing was committed and Jira was not
touched.

How the POS was put at Demo Branch 2: the same way as the SCRUM-216 capture.
The page's own session was moved with `PUT /me/session/branch`, "Reception
Till 1" at Demo Branch 2 was taken, then Demo Branch 2 was picked in the
header's park dropdown. The header in every till shot reads "Demo Branch 2".
Two screens were opened by client-side navigation inside that same signed-in
page (a full page load puts the app back on Central Floresta): the public
booking page `/book` and the Admin panel `/admin?panel=events`. See problem 3.

Demo day: `GET /events` for Demo Branch 2 was empty at the start, so the
Console Health control "Add demo sales to Demo Branch 2 (today)" was pressed
once. Its result line read: "Demo day 2026-10-07 at Demo Branch 2: 0 sales
added, 11 already present; booth: 0 spins added, 5 already present. Events: 4
events added (11 children), 0 already present; walk-up prices set."

Rules kept: only Demo Branch 2 and its demo data were driven. FWBooth1, payment
run 0d008153, the package "Native payment adult ticket 0d008153" (it appears in
the ticket lists at Demo Branch 2; it was never selected) and the OTO App
check-ins outside the demo branch were not opened, selected or written. No
staff benefit card was issued, so there is nothing to revoke. No card
terminal, real money or real 2C2P account was involved (see problem 4).

## Records written (everything is at Demo Branch 2)

| What | Name / reference | State left |
|---|---|---|
| Camp walk-up added at the board, ฿600 cash | child "ZZ TEST Walkup Camper 217", parent "ZZ TEST Parent 217" (+66999217001), allergy "Peanuts (ZZ TEST)", diet "No pork (ZZ TEST)", parent attending | checked in 03:44 (kid band D2-MS6RCM, parent band D2-VV4KSG), checked out 03:51 |
| Workshop pass sold at the till, ฿350 cash | child "ZZ TEST Till Kid 217"; new member "ZZ TEST Parent 217B" (+66999217002) made by the name-capture step | left as booked, not checked in |
| Workshop pass booked online, ฿350 on the test payment page | booking OTO-H3CE-ZS90, child "ZZ TEST Online Kid 217", parent "ZZ TEST Online Parent 217", guest "ZZ TEST Online 217" (+66999217003) | redeemed at the till 04:11, child checked in (band D2-KTCT4Y), still checked in |
| Party tab charge and payment on the seeded "Sophia's 5th Birthday Party" | one extra-tickets charge ฿1,240 (2 Hours Play, 1 kid + 1 adult), one cash payment ฿2,000 | party outstanding now ฿6,240 (was ฿7,000). The seeded party cannot carry a "ZZ TEST" name; the charge and payment carry no label |
| Console Failures | one press of Retry on the `otoapp:attendee.create` group | it failed again (problem 2) |

Whether the online booking's guest name created a member record was not checked.

## Shots

Wording: every image below is a real screen. Facts that are NOT in an image
(sync state, band codes read from the API) are marked "text read-back".

| File (all start `SCRUM-217-staging-`) | What the viewer literally sees | What was done to produce it |
|---|---|---|
| `1-events-tab-camp-event-party.png` | POS header Events tab at Demo Branch 2, "Wednesday, 07 Oct 2026 - 4 events", filters All / Parties / Camps / Events. Rows: 09:00-17:00 "Oto Summer Camp - Week 1" CAMP IN PROGRESS, "2026-10-05 - 2026-10-09", Main Hall + Outdoor Area, 6 registered; 10:00-11:00 "Story Time" EVENT UPCOMING, 0 registered; 13:00-15:30 "Sophia's 5th Birthday Party" PARTY UPCOMING, "Sophia - 5 yrs", Party Room A, 12 kids - 18 adults, OUTSTANDING ฿7000; 14:00-16:00 "Kids' Art & Craft Workshop" EVENT UPCOMING, Art Studio, 3 registered. Header says "Weekday pricing". | Demo day pressed once, then signed in, moved to Demo Branch 2, opened Events. 7 Oct is the middle day (third) of the 5 to 9 Oct camp. |
| `1-camp-roster-middle-day.png` | The camp opened: "Mon, 05 Oct 2026 - Fri, 09 Oct 2026 - 09:00-17:00 - Main Hall + Outdoor Area - 6 registered - 18 expected kids", "2 with allergy/medical note", "2 with dietary restriction". Read-only roster: Arjun Mehta with five attendance-day chips (Mon 05 to Fri 09 Oct), Emma Wattanasin with the red "Medical/allergy: Peanut allergy - carry EpiPen (kept at front desk)" bar, Lily Chen with "Dietary: Halal only" and three day chips; the next row (Lucas Bernard) is cut off at the bottom. | Clicked the camp row in the header Events tab. Mia (days 8-9 Oct only) and the other rows are below the picture. |
| `1-phone-events-list.png` | Phone width 390x844: "Wed, 07 Oct 2026 - 4 events", the same four rows (camp with date range, Story Time, Sophia's party "12k - 18a" with DUE ฿7000, the workshop), bottom bar Tickets, F&B, Check-in, Events (selected), History, Today, Messages. | Fresh 390x844 session, Demo Branch 2, tapped Events in the bottom bar. |
| `2-board-walkup-form-filled.png` | Takeover "Sell event pass - Oto Summer Camp - Week 1". Left: Child's name "ZZ TEST Walkup Camper 217", age 6 yrs, language English, Allergy switch on with "Peanuts (ZZ TEST)", Dietary switch on with "No pork (ZZ TEST)", Parent "ZZ TEST Parent 217", phone 999217001 with "Stored as: +66999217001", Parent attending on, the note, "Also register for the full camp" off, button "Continue to payment - ฿600". Right: the customer-display copy "Tell us about your child" with the same fields; on that copy the Age tile and the phone digits are almost illegible (pale text on the dark pane, white on white), so only the name, notes and "Stored as" lines can be read there. | Check-in board > Events > the camp > Add attendee, typed the fields (age by the 3-tap picker: 6, Mar, 12). |
| `2-board-walkup-payment-cash-selected.png` | "Take entry payment": Amount Due ฿600; tiles Cash, Card, PromptPay and "ZZ TEST Other 495" (a tender left from an earlier walkthrough, not made here); customer pane "Amount due ฿600". Cash is the tile pressed. | Pressed Continue to payment, then the Cash tile. |
| `2-board-walkup-paid-checkin-choice.png` | "Check in - Oto Summer Camp - Week 1": "Pass paid - check in now?", "ZZ TEST Walkup Camper 217 is on the Oto Summer Camp - Week 1 roster...", buttons "Check in now + parent band" and "Leave as booked"; customer pane "Payment complete - Welcome to Oto Summer Camp - Week 1! Our staff will hand you your band." | Pressed "Confirm Payment Received". This is the sale's success screen. |
| `2-board-walkup-on-roster-booked.png` | The camp roster now "7 registered - 0 in", "3 with allergy/medical note", "3 with dietary restriction", "0 / 6 checked in". Row 6 "ZZ TEST Walkup Camper 217" with chips Parent attending and PENDING, red Allergy / Medical and yellow Dietary badges, "Medical/allergy: Peanuts (ZZ TEST)", "Dietary: No pork (ZZ TEST)", attendance days (1) Wed 07 Oct, parent ZZ TEST Parent 217 +66999217001, the note. | Pressed "Leave as booked". The picture shows a chip that reads PENDING; that it is the OTO App sync state comes from a text read-back of `GET /events` (`syncState: "pending"`, problem 2), not from the picture. |
| `2-till-event-pass-cards-phone-entered.png` | Tickets step 1 (Membership Check) with the customer display on the right showing "+66 999217002". Left panel EVENT PASSES, "Flat day entry - no membership needed": "Oto Summer Camp - Week 1" CAMP ฿600 per day, "Story Time" EVENT ฿0 per day, "Kids' Art & Craft Workshop" EVENT ฿350 per day, each with a "Sell pass" button; no party card. | Typed 999217002 on the customer display keypad (viewport made tall enough for all three cards). |
| `2-till-new-guest-name-capture.png` | The same page dimmed with a dialog "New guest - enter name": "Phone +66999217002 is not recognised. Enter the guest's name to register them so they're remembered next time.", field "Name / nickname", buttons Cancel and "Register & continue". | Pressed "Sell pass" on the workshop card for a phone the platform does not know. |
| `2-till-pass-form-member-prefilled.png` | Takeover "Sell event pass - Kids' Art & Craft Workshop" with a green note "Pre-filled from ZZ TEST Parent 217B's profile - confirm or edit below." Parent / guardian "ZZ TEST Parent 217B", phone 999217002 "Stored as: +66999217002"; the child's fields are empty; button "Continue to payment - ฿350". | Typed "ZZ TEST Parent 217B" and pressed "Register & continue". |
| `2-till-pass-paid-success.png` | "Check in - Kids' Art & Craft Workshop": "Pass paid - check in now?", "ZZ TEST Till Kid 217 is on the Kids' Art & Craft Workshop roster...", buttons "Check in now" and "Leave as booked"; customer pane "Payment complete - Welcome to Kids' Art & Craft Workshop! Our staff will hand you your band." | Filled the child (7 yrs), Continue to payment, Cash, Confirm Payment Received. |
| `2-till-after-pass-leave-booked.png` | Back on the till: member card "ZZ TEST Parent 217B - Member - +66999217002 - Tourist rate", "Recognised member - pick an event below to sell them a pass (the form pre-fills)." and a toast "Pass sold - left as booked. ZZ TEST Till Kid 217 added to Kids' Art & Craft Workshop. Check in later from the roster. The OTO App has not confirmed them yet." | Pressed "Leave as booked". |
| `2-console-failures-otoapp-directory-not-configured.png` | Console Failures, Last 24 hours, "2 problems - 7 failed runs in this window": `otoapp:attendee.create` integration x 5 "OTOAPP_DIRECTORY_NOT_CONFIGURED: This deployment has no OTO App directory configured, so the child was not written there yet" (action `booking.pay:...`), and `otoapp:attendee.checkin` x 2 "OTOAPP_ATTENDEE_NOT_SYNCED: The child is not in the OTO App yet, so their check-in waits for them", each with Details and Retry. Right side: a Quarantine card (Evidence box 361, not mine). | Opened Console Failures after seeing every attendee stay PENDING. |
| `2-console-failures-retry-pressed-attendee-create.png` | The same page after pressing Retry on the first group: `otoapp:attendee.create` now x 6 (the header now says 8 failed runs), "last just now", its button now reads "Retried"; the check-in group is unchanged. | Pressed Retry once on `otoapp:attendee.create`. It failed again with the same error. The Quarantine card was not touched. The pictures do not show which park the failed runs belong to (the Console's own header in both reads Central Floresta); that they are all this walkthrough's is inferred, not pictured: the group's first failure is 03:40, the time of the first walk-up, and the count rose by exactly one on Retry. |
| `3-board-checked-in-toast-band-codes.png` | Camp roster at the board with "1 / 6 checked in", tabs "Checked in 1 / Outstanding 5", a progress bar, and the walk-up's row now ending "In - 03:44 - Band D2-MS6RCM - Parent D2-VV4KSG - by Khun Anan (Owner)" with buttons "Reprint band" and "Check out". Toast: "Checked in - ZZ TEST Walkup Camper 217 - band D2-MS6RCM - parent D2-VV4KSG". | Pressed "Check in" on the walk-up's row. The toast does not say whether anything printed (problem 1). |
| `3-fnb-lookup-event-band-allergy-diet-food-not-authorised.png` | F&B counter: red "ALLERGY / MEDICAL ALERT - ZZ TEST WALKUP CAMPER 217 - Peanuts (ZZ TEST) - Restriction: No pork (ZZ TEST)", amber "FOOD NOT AUTHORIZED - Parent did not authorize food orders for this child.", the band chip "ZZ TEST Walkup Camper 217 - B0 credit - #D2-MS6RCM", an empty order. Customer pane "Welcome back, ZZ TEST Walkup Camper 217! Your credit balance B0". The menu list under the search box is empty (Demo Branch 2 has no menu). | Typed the kid band's short code D2-MS6RCM, read from the toast above, into "Wristband code" and pressed Load Tab. NOT a scan of a printed band: nothing prints at Demo Branch 2 (problem 1). |
| `4-board-reprint-band-toast.png` | The same roster row (In - 03:44, Reprint band, Check out) and a red toast "Band not reprinted - Reception Till 1 is not attached to a box, so nothing on it can print". | Pressed "Reprint band". A refusal, photographed as it is. |
| `4-board-check-out-toast.png` | Row now reads "Out - 03:51 / In - 03:44 - by Khun Anan (Owner)" with the label "Checked out"; tabs "Checked in 0 / Outstanding 5"; toast "Checked out - ZZ TEST Walkup Camper 217 has been checked out." | Pressed "Check out". No confirmation dialog appeared. |
| `4-board-after-check-out.png` | The roster about 6 s later with a group "Checked out 1" holding "ZZ TEST Walkup Camper 217" (Parent attending, PENDING, Allergy / Medical, Dietary), still "1 / 6 checked in" at the top. | Waited, scrolled to the row. |
| `5-party-tab-bill-before-charge.png` | Header Events > "Sophia's 5th Birthday Party" UPCOMING, "Sophia - turning 5 - 13:00-15:30 - Party Room A"; buttons Message parent, Edit party, Add tickets, Add F&B to party, "Take balance ฿7000". Party bill: Base package ฿12000, Total ฿12000, Deposit paid -฿5000, Outstanding ฿7000. | Opened the party from the Events list (window 780 high, so the lower cards are cut off). |
| `5-party-add-tickets-builder-2-hours-1-kid-1-adult.png` | "Charging to: Sophia's 5th Birthday Party (Sophia)": "Configure: 2 Hours Play", Kids 1, Adults 1, order card "2 Hours Play EDITING ฿1240 (Kids ฿890 each x1, Adults ฿350 each x1)", VAT included ฿81.12, button "Charge ฿1240 to party"; customer pane "Charging to Sophia's 5th Birthday Party - Sophia ... Total ฿1240". | Add tickets > Tourist > 2 Hours Play (defaults of one kid and one adult). "Add F&B to party" was not used: the F&B menu at Demo Branch 2 is empty. |
| `5-party-tab-bill-with-charge.png` | The bill now has "Extra charges +฿1240", Total ฿13240, Deposit paid -฿5000, Outstanding ฿8240, button "Take balance ฿8240". | Pressed "Charge ฿1240 to party" (the modal closed on its own). |
| `5-party-take-balance-review-with-settlement-screen.png` | Take balance payment: bill summary (Package total ฿12000, Added on the day: Extra tickets +฿1240, Deposit paid -฿5000, Outstanding ฿8240), "Partial amount" selected with 2000 typed, Cash selected, "Amount to collect ฿2000", button "Take ฿2000 by Cash". Right is the settlement customer screen "Sophia's 5th Birthday Party - Sophia - turning 5": Party package ฿12000, Added on the day (2 Hours Play Kids ฿890, Adults ฿350, Extra tickets subtotal +฿1240), Total ฿13240, Less deposit paid -฿5000, "Outstanding due now ฿8240". | Take balance > Partial amount > 2000 > Cash. |
| `5-party-take-balance-collect-customer-screen.png` | Left "Cash payment - Sophia's 5th Birthday Party - ฿2000 - Collect the cash from the customer, then confirm." with Back and "Payment received". Right: "Please pay ฿2000 by Cash - Paying now ฿2000 - Remaining after ฿6240 - Waiting for the cashier to confirm...". | Pressed "Take ฿2000 by Cash". |
| `5-party-payment-recorded.png` | Left "Payment recorded - Collected now ฿2000 - Outstanding ฿6240" with Done; right "Payment received - Paid now ฿2000 - Outstanding ฿6240". | Pressed "Payment received". |
| `5-party-tab-bill-after-payment.png` | Party bill: Base ฿12000, Extra charges +฿1240, Total ฿13240, Deposit paid -฿5000, Payments taken -฿2000, Outstanding ฿6240, button "Take balance ฿6240". A "POS activity" card lists "Extra tickets +฿1240 - 1x 2 Hours Play - Kids, 1x 2 Hours Play - Adults - Khun Anan (Owner) - 08 Oct, 03:56" and "Payment - Cash -฿2000 - Khun Anan (Owner) - 08 Oct, 03:57". | Pressed Done. |
| `5-end-of-day-party-prepayments-line.png` | Today > End of Day, Demo Branch 2, date 10/07/2026, "Counts outstanding - Expected ฿10,666". "Reconciliation by channel": Cash ฿3,550, PromptPay / QR ฿2,070, Card DEMONEX1 ฿920, Card DEMOPAX1 ฿2,046, E-wallet ฿0, Bank transfer ฿0, **Party prepayments ฿2,000**, Credit ฿80, each with an empty Actual box. | Opened Today > End of Day after the party payment. Nothing was typed or closed. |
| `5-phone-party-screen.png` | Phone 390x844: "Sophia's 5th Birthday Party" UPCOMING, DUE ฿6240, Party bill (Base ฿12000, Extra charges +฿1240, Total ฿13240, Deposit paid -฿5000, Payments taken -฿2000, Outstanding ฿6240), Event info card, and pinned at the bottom "Add F&B to party tab" and "Take payment - ฿6240". | 390x844 session > Events > the party. |
| `5-performance-parties-today-line.png` | Today > Performance, Demo Branch 2: "Provisional - still being added up - Updated 04:19", Revenue ฿9,016 - 13 transactions, "Guests checked in 31 - 17 kids - 14 adults", **"Parties today 0 - None booked"**, Revenue split Tickets ฿9,016 100%, Parties ฿0. | Taken as an oddity (problem 6): the party is on the Events tab for the same day. |
| `6-console-devices-demo-branch-2-no-box.png` | Console Devices at Demo Branch 2: "0 boxes - 0 online - 2 stations"; "No box at this branch yet - Add one to get a claim code; the Pi redeems it the first time it boots on site." Stations: "Demo Booth 1" (BOOTH, "on Demo booth box") and "Reception Till 1" (TILL, "no box assigned" with a warning mark). The "New station" button is greyed. "Paired screens: Nothing is paired yet". | Console Devices, Branch picker set to Demo Branch 2. This is why shot 6 could not be taken (problem 1). |
| `6-console-new-station-greyed-pair-dialog-no-kiosk-station.png` | The same page dimmed behind a "Pair a screen" dialog. The Station select is CLOSED and shows only "Demo Booth 1 - Booth"; "What is being paired" shows "Booth"; the Label field shows its placeholder "Counter 1 iPad"; buttons Cancel and "Get a code". The select's option list is not open in the picture, so the picture does not itself show "Reception Till 1" as the other option or the absence of a kiosk option; "New station" is only faintly visible behind the dimming. What does show that no kiosk station exists is the Devices picture above: "2 stations", Demo Booth 1 (BOOTH) and Reception Till 1 (TILL). | Pressed "Pair a screen" and cancelled; "Get a code" was NOT pressed, so nothing was paired. Read-back (text, not pictured): the greyed button's tooltip is "A station sits on a box, and this branch has none yet". |
| `7-book-choose-ticket-event-passes-demo-branch-2.png` | The public booking page (narrow single-column layout, 1000 px wide picture): "Choose a ticket" with six tickets (2 Hours Play ฿890, 1 Hour Play ฿690, "Native payment adult ticket 0d008153" ฿200, "ZZ TEST Gate off 494" ฿100, Full Day Pass ฿1090, Eat & Play Kids Pass ฿1300) and an "Event passes" heading with the camp (Mon, Oct 5 - Fri, Oct 9, 09:00, ฿600) and Story Time (Wed, Oct 7, 10:00, ฿0), each "Add pass". The picture ends at the top edge of a third card: the workshop (฿350) is NOT readable in this picture (it is in the basket picture). The page does not say which park it is for, so the picture does not prove the park: the event passes suggest it (only Demo Branch 2 has events), and the statement that the page asked for `demo-branch-2`'s catalog and event passes is a network read-back (text), not pictured. The 0d008153 package is on this list (not selected). | Opened `/book` inside the Demo Branch 2 session (problem 3), typed 999217003 and the guest name, Continue. |
| `7-book-pass-form-filled.png` | "EVENT PASS - Kids' Art & Craft Workshop - ฿350 entry - tell us who's coming": child "ZZ TEST Online Kid 217", age 6 yrs, parent "ZZ TEST Online Parent 217", phone with "Stored as: +66999217003", note, button "Add pass - ฿350". | Clicked Add pass on the workshop and filled it. |
| `7-book-basket-with-pass.png` | "Your booking - Tourist", Visit date 10/07/2026 "Weekday prices", the basket row "ZZ TEST Online Kid 217 - Kids' Art & Craft Workshop ฿350" with edit and delete icons, the three pass cards again, Total ฿350, "Continue to payment". | Pressed "Add pass". A passes-only booking is accepted. |
| `7-book-payment-step.png` | "Payment - Pay online now to lock in your booking.", Amount due ฿350, "Credit / Debit card" and "PromptPay", "Pay ฿350", "You'll pay on our payment partner's secure page." | Pressed Continue to payment. |
| `7-book-hosted-test-payment-page.png` | The partner's page, which is the platform's own test page: "Simulated payment page - no real money moves. The real one is 2C2P's.", ฿350, "OTO Park booking OTO-H3CE-ZS90", "Invoice SBXWEB261007000001 - CC", buttons Pay and Fail. | Chose Credit / Debit card, pressed Pay ฿350, landed here. Then pressed "Pay". |
| `7-book-confirmation.png` | "You're booked, ZZ TEST Online 217! - ฿350 paid - see you at the park - Your visit: Wednesday, October 7, 2026", a QR with "BOOKING REFERENCE OTO-H3CE-ZS90", "Event passes booked: ZZ TEST Online Kid 217 - Kids' Art & Craft Workshop ฿350 - Scan your booking QR at reception - staff will check each attendee into the event and issue bracelets. No further payment needed." | The site returned from the test page by itself. |
| `7-till-redeem-lookup-event-pass-listed.png` | Tickets with "Redeem Online Booking" open: OTO-H3CE-ZS90, Tourist, "Event pass: ZZ TEST Online Kid 217", Card ฿350 paid, "Will issue at the door: Event check-in for ZZ TEST Online Kid 217", "Confirming checks this attendee into the event and prints bracelets - already paid online, no further charge.", buttons Back and "Confirm & Issue". | Redeem Booking > typed OTO-H3CE-ZS90 > Look up. |
| `7-till-redeem-event-pass-checked-in-toast.png` | The till with a toast "Event passes checked in - 1 attendee(s) checked into their event - bracelets printed." The redemption dialog has closed. | Pressed "Confirm & Issue", picture taken 1.5 s later. The word "printed" is fixed text in the till (`bookingRedemption.ts:131`) and appears with no box at this till (problem 5). |
| `7-board-online-pass-child-checked-in-after-redeem.png` | Check-in board > Events > Kids' Art & Craft Workshop: "5 registered - 1 in", "1 / 5 checked in", tabs "Checked in 1 / Outstanding 4". A "Checked in 1" group holds "ZZ TEST Online Kid 217" (PENDING chip), parent ZZ TEST Online Parent 217 +66999217003, the note, "In - 04:11 - Band D2-KTCT4Y - by Khun Anan (Owner)", Reprint band and Check out. | Opened the board after redeeming, scrolled to the row. The note on the row reads "Walk-up added by Online booking (today only)". |
| `8-admin-events-panel-walk-up-prices.png` | Admin > Operations > Events: "Set the walk-up prices for a camp day, a one-off event and a party guest." Camp day weekday 600, weekend/holiday 600; Event day 350 / 350; Party guest 450 / 450; the help lines ("A camp pass at the till is priced from the camp's own entry price", "Added to the party's tab for each walk-up guest - no door payment"); "Save changes" greyed. The panel does not name the park. | Opened `/admin?panel=events` inside the Demo Branch 2 session. Text read-back (not pictured): `GET /branches/<Demo Branch 2>/event-drop-in-pricing` answered campDay 60000/60000, eventDay 35000/35000, partyGuest 45000/45000 satang, `configured: true`. Nothing was edited. |

## Not captured

- **Shot 6 (kiosk redeem, done screen, pass child checked in afterwards): NOT captured.** A kiosk needs a kiosk station and a box. Demo Branch 2 has no box, the Console's "New station" button is greyed for that reason, and the pairing dialog offers no kiosk station. The two `6-` images show that. No booking was made for the kiosk.
- **Shot 3, the printed-band scan on the virtual box, and shot 4, a reprint that prints:** the band was looked up by its typed short code and the reprint was refused, both because Demo Branch 2 has no box.
- **Shot 7, "check-in on the redemption":** captured, but the till's toast says bracelets printed while there is no box (problem 5).

## Problems

1. **Demo Branch 2 has no box.** The till says "Reception Till 1 is yours - No box is assigned to this station yet, so nothing will print.", the reprint is refused ("not attached to a box"), Console Devices says "No box at this branch yet", and no station (so no kiosk) can be created. The only running virtual box belongs to Central Floresta (slot virtual-1) and a station can only sit on a box of its own branch (`fleet.ts` returns BOX_NOT_FOUND otherwise), so it could not be borrowed. The demo seed needs a virtual box and a kiosk station at Demo Branch 2 before kiosk, print, scan and reprint can be walked there.
2. **The OTO App write-back does not work on staging.** Every attendee write fails with OTOAPP_DIRECTORY_NOT_CONFIGURED and every check-in waits with OTOAPP_ATTENDEE_NOT_SYNCED (`oto-api-staging` has no `OTOAPP_DIRECTORY_URL` / `OTOAPP_DIRECTORY_KEY`, by the error text; the env was not read). All three ZZ TEST attendees read `syncState: "pending"` (text read-back from `GET /events` at 03:5x and again at 04:2x, about 40 minutes after the first write). Retry from Failures was pressed once and failed the same way. So the "forced write-back failure and retry" was seen, but a successful write-back was not.
3. **The public booking site cannot choose a park.** A fresh `/book` load serves `hkt-central` (Central Floresta); the store defaults to it and the page has no park picker. The Demo Branch 2 booking was only possible by opening `/book` inside the staff session that had switched to Demo Branch 2. A real guest cannot book Demo Branch 2's passes online as the site stands.
4. **The "sandbox" is the platform's simulated payment page**, not 2C2P's own sandbox (its own text says so). Real 2C2P credentials were not used.
5. **"bracelets printed" is said when nothing printed.** The till's redemption toast for event passes carries that wording unconditionally while the same till has no box and refuses a reprint. The board's check-in toast is silent about printing.
6. **Today > Performance does not see the party.** At 04:19 it reads "Parties today 0 - None booked" and Parties ฿0 while the Events tab lists Sophia's party today with a ฿1,240 charge and a ฿2,000 payment. (Parties revenue at ฿0 may be by design, since the tab takes no sale; "None booked" is not.) Separately, "Guests checked in" rose from 28 (14 kids, 14 adults; this earlier figure is in no saved picture, only 31 / 17 kids / 14 adults is) to 31 (17 kids, 14 adults) with the three passes sold: it looks like it counts passes sold, not event check-ins (only two children were ever checked in, and one was checked out); inferred from the figures, not confirmed in code.
7. **Smaller oddities:** the F&B screen at Demo Branch 2 shows no menu items; a "ZZ TEST Other 495" tender from an earlier walkthrough is offered at every payment step here; the Console's Boxes list shows none while the booth station card says "on Demo booth box"; the roster header still reads "1 / 6 checked in" after the child is checked out (arrived of expected, which may be by design).

## What is readable in the pictures (independent check, 8 Oct, every PNG opened)

- **No password, session token, benefit QR or typed wallet-credit code** is visible in any SCRUM-217 picture. The sign-in is never shown.
- **Band short codes are readable**: `D2-MS6RCM` and `D2-VV4KSG` (walk-up camper and parent, in the check-in toast, the roster row and the F&B chip) and `D2-KTCT4Y` (online workshop child, roster row). They belong to ZZ TEST children at Demo Branch 2 with ฿0 credit; the first two are checked out. They are band identifiers, not credit codes, but the F&B counter accepts a typed band code, so they are named here rather than left unmentioned.
- **The booking QR in `7-book-confirmation.png` is machine-readable** (a QR decoder reads it at 1x: a `BK1:` payload of 47 characters, beside the printed reference OTO-H3CE-ZS90). It is a booking QR (not a benefit QR) for a ZZ TEST booking that was redeemed at 04:11, so it is spent.
- Roster, party and phone figures that are not ZZ TEST (Arjun Mehta, Emma Wattanasin, Lily Chen, Mia Tanaka, "Khun Ploy" +66812345678, Sophia's party) are the seeded demo events the Health control adds; nothing in them was edited, and the party was only charged and paid as listed in "Records written".
- Console pictures carry the header "OTO Console / Central Floresta" and a Quarantine card (Evidence box 361). Those are the Console's own scope label and an existing item; neither was opened or acted on.

---

# Closing retake, 8 Oct 2026 (second pass), about 06:00 to 07:45 Bangkok time

Staging on `c6194664` (all six services read back as live from `render.mjs
status` at the start). Demo Branch 2 only. The Demo counter box ("virtual-1",
registered and online) was already there; the first pass's missing box is the
thing this pass set up. Signed in as the seeded platform admin (Khun Anan,
Owner). No secret is printed or stored here. Nothing was committed and Jira was
not touched. FWBooth1, payment run `0d008153` and the protected package were not
opened, selected or written. The first pass's pictures stay in the folder; the
two `6-` pictures that show "No box at this branch yet" are the state before
this pass.

One disclosure first: the Console's Devices page was opened once while its list
still showed Central Floresta's boxes (the park picker already said Demo Branch
2 but the list had not reloaded). One box drawer (FortuneWheelBox) and one
station drawer were opened there and closed; nothing was pressed or saved, and
the three pictures taken in that state were deleted and retaken once the page
had Demo Branch 2's own box on it. The helper now waits for "Demo counter box"
to be on the page before it does anything.

## Records written (all at Demo Branch 2, all "ZZ TEST")

| What | Name / reference | State left |
|---|---|---|
| Four simulated devices on the Demo counter box | ZZ TEST Sim Receipt Printer, ZZ TEST Sim Kids Band Printer, ZZ TEST Sim Adult Band Printer, ZZ TEST Sim Scanner | Declared with the Simulated transport; first with no address (see problem 3), then given an address (192.168.88.221 to .223, port 9100), model and protocol (escpos, tspl2, hid) |
| Reception Till 1 attached to the box | the station edit | on "Demo counter box", the three printers and the scanner assigned, config v2 |
| New kiosk station | ZZ TEST Kiosk 1 (kind Kiosk, code prefix ZK, the same three printers) | on the box, config v1 |
| Paired kiosk screen | ZZ TEST Kiosk screen 1, paired with a K code at 06:10 | paired, last seen minutes before each look |
| Event-pass booking, camp, paid on the simulated page | OTO-5SRY-MUGZ, ฿600; child ZZ TEST Kiosk Kid 217, parent ZZ TEST Kiosk Parent 217, guest ZZ TEST Kiosk Guest 217 (+66999217004) | redeemed at the kiosk at 06:19, child checked in (band ZK-JKAH6S), sale ZK-000001 |
| Board walk-up, camp, ฿600 cash | child ZZ TEST Board Camper 217R, parent ZZ TEST Board Parent 217R (+66999217005, attending) | checked in at the board 06:22 (D2-HQYX8C, parent D2-ZY7CXA), band reprinted 06:24; still checked in |
| Console Failures | one press of Retry, on the old `otoapp:attendee.create` group | it reached the directory and was refused (problem 1) |

Not claimed: whether the online booking's guest name made a member record.

## Shots (file names start `SCRUM-217-staging-`)

Wording: every image is a real screen. Facts that are not in an image are
marked "text read-back".

| File | What the viewer literally sees | What was done to produce it |
|---|---|---|
| `6a-kiosk-paired.png` | Console Devices, branch picker "Demo Branch 2", "1 box - 1 online - 3 stations". Box card "Demo counter box" (VIRTUAL, virtual-1, 4 devices - 2 stations, Online). Stations: Demo Booth 1; Reception Till 1 "4 devices assigned - config v2 - on Demo counter box"; ZZ TEST Kiosk 1 (ZK, KIOSK) "3 devices assigned - config v1 - on Demo counter box". Paired screens: "ZZ TEST Kiosk screen 1" (Kiosk) "on ZZ TEST Kiosk 1 - Paired 8 Oct, 06:10", a Revoke button. | Opened Devices, picked Demo Branch 2, after the pairing below. The page's own scope label in the sidebar reads "Central Floresta" (the Console's own label, not this park's). |
| `6a-pair-dialog-paired-message.png` | The "Pair a kiosk" dialog over a dimmed Devices page: "ZZ TEST Kiosk screen 1 is paired to ZZ TEST Kiosk 1. The kiosk shows its attract screen within a few seconds." and a Done button. | New station made, the kiosk page opened, its K code typed in the dialog (the code is cleared when sent). |
| `6a-kiosk-setup-code-screen.png` | The kiosk's own first screen: "Set up this kiosk - In the Console, open Devices, choose Pair a kiosk, and enter this code for the kiosk station.", the code "K 438 075" (readable in the picture), "This code expires at 06:20 AM." and "Expire code now". The code is single-use, was consumed by the pairing at 06:10 and had expired by 06:20, so nothing in it can be used again. | `/kiosk#debug` opened on a browser with no staff session. |
| `6a-kiosk-attract-after-pairing.png` | The kiosk after pairing: "SELF CHECK-IN - Collect your wristbands - Booked online? Scan the QR code from your booking confirmation and your wristbands print right here.", a Tap to start button, "Demo Branch 2 - ZZ TEST Kiosk 1" at the foot, and the rehearsal field "Simulated scan" with a Scan button bottom left (what `#debug` adds). | A few seconds after pairing. |
| `6a-reception-till-1-on-box-with-devices.png` | The station drawer "Reception Till 1 - Till - config v2 - at Demo Branch 2": box "Demo counter box - virtual-1", prefix D2, Tickets and F&B ticked, receipt printer "ZZ TEST Sim Receipt Printer", kids' band "ZZ TEST Sim Kids Band Printer", adult band "ZZ TEST Sim Adult Band Printer", scanner "ZZ TEST Sim Scanner", the other jobs "Nothing on this box fits" or "Not set". | Station edit, devices picked, Save the station; reopened to photograph. |
| `6a-box-drawer-four-simulated-devices-first-declared-no-address-error.png` | The Demo counter box drawer at 06:12: the four devices (Adult Band Printer, Kids Band Printer, Receipt Printer, Scanner), each Simulated, the three printers with a red `DEVICE_NO_ADDRESS` under them. | Taken right after the devices were declared with no address (last heartbeat 06:12:02 in the picture). The kiosk's first press failed with DEVICE_NO_ADDRESS at 06:16 (the Failures picture below shows `device:kiosk.print`, first 06:16), four minutes after this picture. The press itself is not pictured, so the link between this drawer and that failure is the error name and the times, not anything in this picture (problem 3). |
| `6a-box-drawer-four-simulated-devices-with-addresses-printing.png` | The same drawer later (heartbeat 43 s old, "applied 5m ago (14 copies)"): the printers with model, protocol and address (4B-2082A tspl2 192.168.88.223:9100 and .222:9100, Xprinter XP-80 escpos 192.168.88.221:9100), "paper ok", the scanner Zebra DS2278 hid; Controls with "Go offline queued. The box takes it on its next poll." (a later round's press, see the SCRUM-503 folder). | Devices edited with an address, model and protocol each, then Apply config. WHEN, from the picture: last heartbeat 07:15:02 and uptime 1h 17m, so it was taken at about 07:15, an hour after the devices were given addresses (the print queue shows them printing from 06:19). The top row of Command history reads "succeeded Go offline - just now - queued 8 Oct, 07:15", so the Go offline switch was ON when this was taken (it was put back with Go online at 07:18, see the SCRUM-503 folder). The picture shows no print activity; the file name says "printing", what it shows is "paper ok". |
| `6b-kiosk-scan-your-booking-qr-screen.png` | The kiosk: "Scan your booking QR - Hold the QR code from your confirmation - on your phone or printed - under the scanner." and a Start over button. | Tap to start. |
| `6b-kiosk-done-screen-youre-all-set-bands-listed.png` | "You're all set!", "OTO-5SRY-MUGZ", "Take your wristbands from the tray below and enjoy your play!", "1 Child bracelet", "0 Adult bracelets", "Your wristband codes: ZK-JKAH6S child", a Done button. | The booking's signed QR was fetched by script (`GET /public/bookings/:id/status`, field `qr`, text read-back) and pasted into the "Simulated scan" field with Scan: the same call a scanner burst makes, but no camera or scanner was used. The pass has no parent ticked, so no adult band. The Simulated scan field in the picture shows only its grey placeholder "BK1:...", not a pasted QR. IT IS THE REAL SCREEN: the English strings "You're all set!", "Take your wristbands from the tray below and enjoy your play!" and "Your wristband codes" are the app's own `kiosk.done.title`, `kiosk.done.subtitle` and `kiosk.done.codes` entries in `apps/pos/src/i18n/dictionary.ts` (as are `kiosk.attract.title` and `kiosk.scan.title` for the two screens before it), and the band code ZK-JKAH6S on it is the one the board roster (6c) and the print queue (kids wristband at 6:19:26) show for the same child. |
| `6c-board-kiosk-pass-child-checked-in-after-kiosk-redeem.png` | Check-in board > Events > Oto Summer Camp - Week 1: "8 registered - 1 in", "1 / 6 checked in", a "Checked in 1" group: "ZZ TEST Kiosk Kid 217" with a red REFUSED chip, 6 yrs, attendance day Thu 08 Oct, parent ZZ TEST Kiosk Parent 217 +66999217004, the note "ZZ TEST kiosk pass for the SCRUM-217 closing retake - Walk-up added by Online booking (today only)", and "In - 06:19 - Band ZK-JKAH6S - by ZZ TEST Kiosk 1" with Reprint band and Check out. | Opened the board after the kiosk press. The word REFUSED is the sync chip (problem 1). |
| `6d-board-check-in-toast-band-codes-printing-box-attached.png` | The camp roster "2 / 7 checked in" with a toast "Checked in - ZZ TEST Board Camper 217R - band D2-HQYX8C - parent D2-ZY7CXA". The toast does not say whether anything printed. | Walk-up paid in cash and left as booked, then Check in pressed on its row. |
| `6d-board-reprint-band-succeeded-toast.png` | The same roster with the row "ZZ TEST Board Camper 217R" (Parent attending, REFUSED chips, "In - 06:22 - Band D2-HQYX8C - Parent D2-ZY7CXA - by Khun Anan (Owner)") and a toast "Band reprinted - ZZ TEST Board Camper 217R - band D2-HQYX8C - parent D2-ZY7CXA". | Reprint band pressed. The first pass's same press was refused ("not attached to a box"); this one succeeded. |
| `6d-console-box-printing-queue-bands-printed-and-reprinted.png` | The Demo counter box drawer, Printing panel: eight jobs, every one marked "printed": adult wristband and kids wristband at 6:24:12 AM (the reprint), adult and kids wristbands at 6:22:38 AM (the board check-in), a receipt at 6:22:26, a receipt and a kids wristband at 6:19:26 (the kiosk), a test page at 6:19:01. Below, the simulated adult band as the printer rendered it twice (#2 and #1, 400 by 283 dots): "ZZ TEST Board Parent 217R", "09:00 - 17:00 - 2026-10-08", "Oto Summer Camp - Week" (that line is cut off at the label's edge), a QR whose bottom row the barcode overlaps, a barcode and "D2-ZY7CXA". The jobs carry no station label: which job belongs to which press is read from the times (kiosk 06:19, board check-in 06:22, reprint 06:24), not from the list. | Console > Devices > the box > scrolled to Printing. The QR on the rendered band is a band code for a ZZ TEST parent, not a credit code. |
| `6e-console-failures-attendee-groups-before-retry.png` | Console Failures, Last 24 hours, "5 problems - 17 failed runs": `otoapp:attendee.create` x 4 "OTOAPP_SCOPE_REQUIRED: This directory key does not carry events:write"; `otoapp:attendee.checkin` x 4 "OTOAPP_ATTENDEE_NOT_SYNCED"; `device:kiosk.print` x 1 "DEVICE_NO_ADDRESS"; `http:POST /benefits/credentials` x 2 (an old benefit-key refusal); `otoapp:attendee.create` x 6 "OTOAPP_DIRECTORY_NOT_CONFIGURED" (first 03:40, last 2h 5m ago). Retry buttons sit on three groups (the SCOPE_REQUIRED attendee.create, attendee.checkin and the old attendee.create); the kiosk.print and benefits groups have Details only. Counts: 4 + 4 + 1 + 2 + 6 = 17 failed runs, as the header says. The right column holds the Quarantine card (Evidence box 361, not mine) and, under it, "Refused events - waiting: 1 event the cloud would not file". | Opened Failures. The Console's header reads Central Floresta (its own label); the groups are not filtered to a park, so which are this walkthrough's is inferred from their ids and times, not pictured. |
| `6e-console-failures-retry-pressed-write-back-reaches-directory-scope-refused.png` | The same page after one press of Retry on the old `attendee.create` x 6 group: its button now reads "Retried" and the group still reads x 6 "DIRECTORY_NOT_CONFIGURED", while the `OTOAPP_SCOPE_REQUIRED` group above it rose from x 4 to x 5 (last just now, action `booking.pay:01a11833-...`, the old group's action) and the run count from 17 to 18. | One press of Retry. NOTHING CLEARED: before, 17 failed runs in 5 groups (4 + 4 + 1 + 2 + 6); after, 18 failed runs in 5 groups (5 + 4 + 1 + 2 + 6). The old group stayed at 6 and only changed its button to "Retried". |

## What was NOT achieved

- **The write-back proof (step 3).** The directory is configured now (the
  refusal changed from "not configured" to "This directory key does not carry
  events:write"), so the call reaches the OTO App and its key authenticates, but
  the OTO App refuses every write for want of that scope. By the code, the OTO App
  side defines one directory scope, `events:write`
  (`apps/oto-app/server/db/coreSchema.ts`), and its directory-client script grants
  it by default, so the staging key's client row was made without it or has it
  switched off (an inference from the error text and the code; the OTO App's
  database was not read). No roster chip left PENDING: text read-back of
  `GET /events` for 8 Oct gives ZZ TEST Walkup Camper 217 (7 Oct) `pending`, and
  both of today's attendees `failed` (the REFUSED chip). The fix is one setting on
  the directory client; nothing in this run was allowed to change it.

## Problems

1. The write-back refusal above. The chips read PENDING for the three 7 Oct
   attendees and REFUSED for the two made today; a staff reader sees a red
   REFUSED chip on a child who was checked in without trouble.
2. **The kiosk's first press ended at "Please see our team at the desk"** (the
   booking reference, "We couldn't finish this here. Our team will help you right
   away.", a Done button). The audit row `kiosk.abort` (text read-back) says stage
   `print`, reason `DEVICE_NO_ADDRESS`, 0 bands printed, outcome `failed`. That
   picture was overwritten by the next capture and is NOT in the folder; the
   Failures picture above shows its trace (`device:kiosk.print`). After the
   devices got addresses the same booking redeemed.
3. A device declared with the Simulated transport and no address cannot print
   (the printer answers "has no address, so there is nothing to open"), though
   "Simulated" suggests it needs none. The Add device form's address field says
   "192.168.88.204:9100, or /dev/ttyACM0." and does not say it is required for a
   simulated printer.
4. The board's check-in toast is silent about printing (it names the band codes
   only); the proof it printed is the Console print queue. The till's redemption
   toast saying "bracelets printed" (first pass, problem 5) was not retaken.
5. The public booking page still cannot choose a park (first pass, problem 3):
   the booking was made inside the signed-in Demo Branch 2 session. Today's page
   offered only the camp pass (Story Time and the workshop were 7 Oct events).
6. Also left on staging: sale `ZK-000001` (the kiosk's), sale D2-000016 (the board
   walk-up), the unfinished `tendering` sales other tickets of this run left (see
   the SCRUM-218 and SCRUM-502 folders), and the ZZ TEST stations, devices, kiosk
   screen and bookings above. The Demo counter box was not archived.

## What is readable in the closing-retake pictures (independent check, 8 Oct, every new PNG opened)

- **No password, session token, benefit QR or credit code** is readable in any of the fifteen closing-retake pictures. A QR decoder was run over all 111 PNGs in the SCRUM-217, -218, -443, -502 and -503 folders: the only picture that decodes is the first pass's `7-book-confirmation.png` (already disclosed above, a spent booking QR). The small adult band image in the print-queue picture does not decode at its size.
- **Readable and harmless, named here rather than left unmentioned:** the kiosk setup code `K 438 075` (spent at 06:10, expired 06:20), the booking reference `OTO-5SRY-MUGZ` (redeemed 06:19), band codes `ZK-JKAH6S`, `D2-HQYX8C` and `D2-ZY7CXA` (ZZ TEST children and a ZZ TEST parent at Demo Branch 2 with no credit, the same code class as the first pass's), the simulated printers' private LAN addresses (192.168.88.221 to .223:9100) and box command ids.
- **The roster picture also shows seeded demo data**: Khun Daeng Prasert +66854567788 (the seeded parent of Noah Prasert in `packages/db/src/seed/demo-events.ts`), not a ZZ TEST record and not edited.
- **The Failures groups did not clear**: 17 failed runs before the one Retry and 18 after (shot 6e). Nothing in this folder claims a cleared group.

## Shot 6f - the write-back retake, after the directory key gained events:write (8 Oct, about 08:13 Bangkok time)

Staging, Demo Branch 2, ZZ TEST records only, the seeded owner account (no secret
printed). One press of Retry, on the top `otoapp:attendee.create` group
(OTOAPP_SCOPE_REQUIRED x 5). Nothing else on the page was pressed; the
`attendee.checkin` group was NOT pressed (the brief named attendee.create only).
FWBooth1 and the protected payment run were not touched. No commits, no Jira.

| File | What the viewer literally sees | What was done to produce it |
|---|---|---|
| `6f-writeback-failures-before-retry.png` | Console Failures, Last 24 hours: "5 problems - 18 failed runs in this window". Groups: `otoapp:attendee.create` x 5 "OTOAPP_SCOPE_REQUIRED: This directory key does not carry events:write" (first 8 Oct 06:15, Details and Retry); `otoapp:attendee.checkin` x 4 "OTOAPP_ATTENDEE_NOT_SYNCED" (Details, Retry); `device:kiosk.print` x 1 DEVICE_NO_ADDRESS; `http:POST /benefits/credentials` x 2; `otoapp:attendee.create` x 6 "OTOAPP_DIRECTORY_NOT_CONFIGURED" (Details, Retry). 5+4+1+2+6 = 18, the same counts as the end of shot 6e. Quarantine card x 1. | Opened Failures, photographed before touching anything. |
| `6f-writeback-failures-retry-pressed-button-reads-retried.png` | The same page 3.5 s after the press: the top group's button now reads "Retried"; every count is unchanged (x 5, x 4, x 1, x 2, x 6; "18 failed runs"). | One click on that group's Retry (script clock 01:13:24 UTC). No toast is visible in the picture. |
| `6f-writeback-failures-after-retry-reloaded.png` | Failures after a fresh sign-in, a load and a reload, about 45 s after the press: the identical five groups and counts, "18 failed runs", the top group still first 06:15 with its Retry button back. | Waited, signed in again, reloaded the page. |
| `6f-writeback-roster-checked-in-rows-no-chip.png` | Check-in board > Events > Oto Summer Camp - Week 1, the "Checked in 2" filter: "ZZ TEST Board Camper 217R" (Parent attending, 7 yrs) and "ZZ TEST Kiosk Kid 217" (6 yrs), each with its Thu 08 Oct day, parent, note, and the In line (06:22 Band D2-HQYX8C Parent D2-ZY7CXA; 06:19 Band ZK-JKAH6S). Neither name carries a REFUSED or PENDING chip. Header "2 / 7 checked in". | Board opened after the press, Checked in filter clicked. Compare 6c and 6d, where the same two children carry a red REFUSED chip. |
| `6f-writeback-roster-kiosk-kid-row-chip-gone.png` | The same roster on the All filter, framed as 6c was: the Kiosk Kid 217 card with no chip beside its name, In - 06:19 - Band ZK-JKAH6S, by ZZ TEST Kiosk 1. The Board Camper card sits above it, also with no chip on the part shown. | Same session, scrolled to the row. 6c is the before picture of this exact row. |
| `6f-writeback-roster-7-oct-walkup-row-chip-gone.png` | The "Not in today's session" group: "ZZ TEST Walkup Camper 217" (Parent attending, 6 yrs, Allergy / Medical and Dietary tags) with no PENDING chip beside its name. Above it, the end of a seeded demo card (Dietary: Halal only, parent Mei Chen +66865678899; not ZZ TEST, not edited). | Same session, scrolled to the row. The 7 Oct walk-up was PENDING in the first pass (text read-back; no earlier picture of its chip is in this folder). |

Text read-back, not a picture: `GET /events?branchId=<Demo Branch 2>&date=2026-10-08` as the signed-in owner, taken after the press, gives for the three ZZ TEST attendees `syncState` = `synced` for all three (Board Camper 217R, Kiosk Kid 217, Walkup Camper 217), no `syncError`. Before the press the same read gave `pending` for the 7 Oct walk-up and `failed` for the two checked in today (first pass, above).

### What the pictures prove and do not prove

- Proven by pixels: after one Retry the roster chips for the three ZZ TEST children are gone (6c and 6d before, 6f after), and the press produced no new failed run (the top group stayed x 5; in 6e the same kind of press raised it from x 4 to x 5).
- NOT proven by pixels, and not so: the Failures counts did not drop and no group resolved. The page reads 18 failed runs in five groups before and after. By the code (`failureGroups` in `apps/api/src/services/ops.ts`) the page counts every failed run in the window and nothing marks a run resolved when a later send succeeds, so these groups age out of the 24-hour window rather than clearing on a good retry. That is an inference from reading the query, not from a picture.
- Still waiting (text read-back only, the roster has no chip for it): the two check-ins, `ZZ TEST Board Camper 217R` and `ZZ TEST Kiosk Kid 217`, read `syncState: pending` on their `checkins` entry. Their group, `otoapp:attendee.checkin` x 4 "child is not in the OTO App yet, so their check-in waits for them", is still on the page with its own Retry button (visible in 6f after). It was not pressed. The children are in the OTO App now, so a press there is the next step, and it is a separate decision from this one.

### Problems from this shot

1. A successful Retry leaves the Failures page looking unchanged (same counts, same groups, button back to "Retry"), so a reader cannot tell from that page that anything drained. The proof is on the Check-in roster and in the read-back. A line such as "Retry sent N children, M now in the OTO App" on the page (the route already returns `sent`, `synced` and `waiting`) would show it; the toast, if any, was not caught in the picture.
2. The board roster shows a sync chip for the child's own write-back only. A check-in that is still `pending` toward the OTO App shows nothing on the roster, so "REFUSED gone" there does not mean the check-in has reached the app.
