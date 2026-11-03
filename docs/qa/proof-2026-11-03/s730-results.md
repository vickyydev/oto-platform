# SCRUM-730 paid online drop-off: proof

Staging proof done: SCRUM-730 is Deployed, with the before and after screens shown inside [Jira comment 13251](https://oto-suite-dev.atlassian.net/browse/SCRUM-730?focusedCommentId=13251). The local proof comes first below, then staging before the change, then staging after it.

## Local proof

Taken 2026-11-03 on a disposable local database with the real API and till in a browser (`apps/pos/e2e/run.mjs`).

## Before the change (source at 234636a3)

A real booking, paid through the simulated gateway, then the API walked the way the till walks it:

| Step | Answer |
|---|---|
| The till's load path reads the waiting list | Loads the paid child as a line |
| `POST /sales` under the stay's id | 200, ฿740.00 rung up |
| Finalise, then `POST /checkin/check-in-now` | 200, child in the park |
| `POST /bookings/:id/redeem` afterwards | 409 `CHECKIN_NOT_REGISTERED`: "Ploy is already checked in." |
| A nanny child's card says Booked & paid, `POST /checkin/check-in-booked` | 409 `CHECKIN_NOT_BOOKED`: "Tam has not been paid for yet" |

The screens: [the board](./s730/local-before-01-board.png) offers Check in with nothing saying the family paid, and pressing it [loads a line to charge](./s730/local-before-02-check-in-loads-a-line-to-charge.png) at the tourist rate.

## After the change

| Screen | What a person sees |
|---|---|
| [Board, drop-off](./s730/local-after-01-board-booked-and-paid.png) | Booked & paid, no payment needed |
| [Check in pressed](./s730/local-after-02-check-in-opens-the-booking.png) | The booking's redeem dialog: ฿645 paid, Confirm & Issue. Behind it, no line and total ฿0 |
| [Redeemed](./s730/local-after-03-redeemed-no-payment.png) | "Payment is complete", Check in now |
| [Back on the board](./s730/local-after-04-board-checks-in-with-no-payment.png) | "Already booked & paid, no payment needed", the visit photo, Check in & issue band |
| [Board, nanny](./s730/local-after-05-nanny-board-booked-and-paid.png) | Booked & paid with the booked start |
| [Nanny Check in pressed](./s730/local-after-06-nanny-check-in-opens-the-booking.png) | The booking's redeem dialog, not a refusal |
| [Phone family screen](./s730/local-after-07-phone-family-booked-and-paid.png) | Booked & paid |
| [Phone Check In pressed](./s730/local-after-08-phone-check-in-opens-the-booking.png) | The booking's redeem dialog on the phone till. Behind it, "No items yet" |
| [Add drop-off picker](./s730/local-after-09-picker-paid-online.png) | The family's button reads Paid online and is disabled, the child reads Paid online, Add sibling stays |
| [Sibling added at the door](./s730/local-after-10-picker-sibling-on-the-sale.png) | The sibling alone is on the sale, at the till's ฿915. The paid child is not on it |

The band itself needs a camera for the visit photo, so the browser run stops at that step. `apps/api/test/booking-paid-online-no-second-charge.test.ts` and `booking-supervised.test.ts:192` take the child into the park with one band and no second sale.

Rerun: `PAYMENTS_SIMULATOR=on POS_E2E_BROWSER=chromium POS_E2E_BUILT=1 pnpm --filter @oto/pos e2e e2e/dropoff-paid-online.spec.ts`, with `POS_E2E_SHOTS` naming a folder for the screens. The Till end-to-end step in CI runs it the same way, on its own disposable database. On that harness a skip fails the gate.

## The checks can fail

Each check was run against a till changed on purpose, then the change was taken back out:

| Change | Result |
|---|---|
| The iPad board fires both hand-overs and the till loads a paid child | The spec fails at "No items added yet", behind the dialog |
| The phone board fires both hand-overs and the till loads a paid child | The spec fails at "No items yet", behind the dialog |
| The picker treats a paid child as chargeable | Three of the picker's render tests fail in `apps/pos/test/s730-paid-online-board.test.ts` |

## Staging before the change

Captured 3 November 2026, 16:00 to 16:02 UTC, on staging's live source `4e515c61217770396da4dd86119cc0666cdc1d29`, before this landed. ZZ TEST records only, on the dedicated till `ZZ TEST SCRUM-730 till` on Virtual box 1 (simulated devices). PAYMENTS_SIMULATOR read back as on. The fixture is recorded in [staging-fixture.json](./s730/staging-fixture.json).

| Step | What a person sees |
|---|---|
| [The guest's page](./s730/staging-before-00b-simulated-hosted-page.png) | The booking site's card route reaches the simulated hosted page for booking OTO-06IT-O26H, ฿915. No real money moves |
| [The guest's confirmation](./s730/staging-before-00c-booking-paid.png) | "You're booked", ฿915 paid, one supervised child |
| [The board](./s730/staging-before-01-board.png) | The family's card offers Check in. Nothing on the child's row says the family paid |
| [Check in pressed](./s730/staging-before-02-check-in-loads-a-line-to-charge.png) | The till holds the child as a line to charge: "Drop-off service", "Choose length", the tier step, and Pay |
| [Cancel pressed](./s730/staging-before-03-cancelled-no-payment.png) | Back on an empty till. No payment taken, and the booking still reads paid |

## Staging after the change

Captured 3 November 2026, 16:58 to 17:14 UTC (23:58 to 00:14 Bangkok), after the deploys went live at 16:47 UTC, on source `2e5ff3f1d2f1aa093e9edd7b003a16d0d9b5118e`, green [CI 41672927125](https://github.com/vickyydev/oto-platform/actions/runs/41672927125). API `dep-dbl0uhjbc2fs738gbic0` and POS web `dep-dbl0uhjbc2fs738gbje0` were live on that exact commit. PAYMENTS_SIMULATOR read back as on and no setting changed. A real Chromium at `oto-pos-web-staging`, signed in as reception, on the dedicated `ZZ TEST SCRUM-730 till` on Virtual box 1. Every image below was opened and read.

| Step | What a person sees |
|---|---|
| 4 | The nanny family [on the simulated page](./s730/staging-after-00a-nanny-simulated-hosted-page.png), booking OTO-FMC9-RIVN, ฿1,020. No real money moves |
| 5 | [Drop-off family](./s730/staging-after-01-board-dropoff-booked-and-paid.png) and [nanny family](./s730/staging-after-02-board-nanny-booked-and-paid.png): each card reads "Booked & paid · no payment needed" |
| 6 | [Check in pressed](./s730/staging-after-03-check-in-opens-the-booking.png) on the same booking as the before screens, OTO-06IT-O26H: the redeem dialog, ฿915 paid, Confirm & Issue. Behind it, "No items added yet", Total ฿0, Pay ฿0 |
| 7 | [Confirm & Issue](./s730/staging-after-04-redeemed-no-payment.png): "Payment is complete". [The board's check-in](./s730/staging-after-05-board-checks-in-with-no-payment.png): "already booked & paid, no payment needed". [Photo taken](./s730/staging-after-06-visit-photo-taken.png), Check in & issue band answered 200, and [the child is in the park](./s730/staging-after-07-child-in-the-park.png) with band Z730-JQD4DR printed |
| 7, the money | [History](./s730/staging-after-07b-history-one-sale.png) has one line for the booking. [The sale](./s730/staging-after-07c-the-sale-the-booking-paid.png) is Z730-000001, ฿915, "Online booking OTO-06IT-O26H", with one payment marked Paid online |
| 8 | [Check in on the nanny family](./s730/staging-after-08-nanny-check-in-opens-the-booking.png): the redeem dialog at ฿1,020 paid, not "has not been paid for yet". Behind it, Total ฿0 |
| 9 | [Add drop-off child](./s730/staging-after-09-picker-paid-online.png): the paid families read Paid online, with the button greyed out. [The sibling alone on the sale](./s730/staging-after-10-picker-sibling-on-the-sale.png) at the till's ฿915; the paid child is not on it. Cancel pressed, no payment taken |
| 10 | Phone width, a third paid family: [the family screen](./s730/staging-after-11-phone-family-booked-and-paid.png) reads Booked & paid, and [Check In](./s730/staging-after-12-phone-check-in-opens-the-booking.png) opens the redeem dialog with "No items yet ฿0" behind it |

Beyond the plan: the nanny child was also [checked in with a test nanny, with no payment](./s730/staging-after-13-nanny-child-checks-in-with-no-payment.png), band issued, and picked up. Every family then went through pick-up, so the path is walked to the end for all four paid bookings.

Read back in [staging-after-readback.json](./s730/staging-after-readback.json) and independently, read-only, in [staging-cleanup-read.json](./s730/staging-cleanup-read.json):

| Booking | Status | Booking total | Sale | Sale total | Payments | Child |
|---|---|---|---|---|---|---|
| OTO-06IT-O26H | redeemed | ฿915 | Z730-000001 | ฿915 | 1, ฿915 | out, 1 release |
| OTO-CF20-HA1S | redeemed | ฿915 | Z730-000002 | ฿915 | 1, ฿915 | out, 1 release |
| OTO-I5TP-DT02 | redeemed | ฿915 | Z730-000003 | ฿915 | 1, ฿915 | out, 1 release |
| OTO-FMC9-RIVN | redeemed | ฿1,020 | Z730-000004 | ฿1,020 | 1, ฿1,020 | out, 1 release |

The test till holds exactly those four sales, no other sale names these bookings, and all eight print jobs (four kids' bands, four receipts) finished on simulated printers.

Limits of this proof:

- The photos came from Chromium's fake camera, and the bands and receipts from simulated printers. No real camera or printer was used.
- The nanny booking went through the routes the booking site itself calls, then the simulated page in a browser. After 21:00 the site offers no nanny start time for today (`generateTimeSlots` in `BookTickets.tsx`). The two drop-off bookings walked the booking site's pages.
- A real Pi box gets the box-side refusal only from its next box release. No box release was shipped or installed, and no park device was used.

### Clean-up

- Stays: Ploy, Bua, Mint and Tam are out through the real pick-up, one release each. All four bookings are redeemed.
- The till: archived with `DELETE /stations/:id`, 200, and off the branch's list. Its devices belong to Virtual box 1 and were not touched.
- The nanny: the shift was cut short at 17:15 UTC with `DELETE /branches/:id/nannies/shifts/:shiftId`. The Console has no control to archive a nanny, so the row was archived by exact id in [job-dbl1fijm8hqs738ru5o0](./s730/staging-cleanup-write.json), as the SCRUM-699 proof did. The roster is back to Aor, Bow, Jum and Pim.
- Sign-ins: every run signed out. One session from the pre-landing run, on this till, had stayed open; the same job ended it through the normal sign-out service. The read-only check reads zero live sessions on the till.
- **One record is left:** ZZ TEST SCRUM-730 Nok, the sibling from step 9, is still registered under Upcoming, on family OTO-CF20-HA1S, with no sale, no band and no money. Nothing in the product removes a waiting child. A first job tried to mark him out and the database refused it (`checkin_in_park_check`, job-dbl1dlijnfac73a7ktug): a child who never entered the park cannot be out. It rolled back, and the guard was not worked around.
- Kept for the record, as on other proofs: the four sales and their receipts, the bands, the registrations and the audit rows. The bookings created no member rows.

### Notes for the owner

None of these stopped the proof. Each is a decision, not something this change was meant to settle.

1. **A child paid for at the till and left as booked is still offered Add to sale in Add drop-off child.** Seen on staging for another family's child, who is on a paid sale. It was not pressed, because the record is not this proof's. From the code, a second sale would take the money and then Check in now would refuse with "was paid for on another sale". The prototype lists every waiting child the same way. This change covers families who paid online, not this case.
2. **A family with a paid child and an unpaid sibling** shows [one Booked & paid label and two Check in buttons with the same name](./s730/staging-after-14-family-with-paid-child-and-sibling.png). The first opens the booking and the second takes the unpaid child to the till. Neither charges the paid child, but the label reads for the whole family.
3. **The redeem dialog calls a nanny child "Drop-off"**: "Drop-off: Tam" and "Drop-off check-in for Tam". This is the prototype's wording and it is unchanged.
4. **Nothing removes a waiting child from the board.** A sibling added at the door whose sale is then cancelled stays under Upcoming and in the picker. The prototype has no way either.
5. **Real Pi boxes** get the box-side refusal only from their next box release, and the planner decides when that goes out.

## The plan this followed

Before landing, while staging still runs the earlier source:

1. As ZZ TEST, pay a booking for one drop-off child through the booking site.
2. On the Check-in board, press Check in on that family. Screen: the till with the child as a line to charge.
3. Press Cancel at the till. Take no payment: the same booking serves step 6 below.

After landing:

4. As ZZ TEST, pay a booking for a nanny child as well.
5. Sign in at a till on the Check-in board. Screen: each family says Booked & paid.
6. Press Check in on the drop-off family. Screen: the redeem dialog, with no line and total ฿0 behind it.
7. Confirm & Issue, then Check in now. Screen: the board's payment-free check-in. Take the visit photo and issue the band. Read the sale: one sale, the booking's, at what was paid.
8. Press Check in on the nanny family. Screen: the redeem dialog, not "has not been paid for yet".
9. Add a sibling to a paid family with Add drop-off child. Screen: the paid child reads Paid online and the sibling goes on the sale at the till's price.
10. Close out the ZZ TEST bookings and stays as the other staging proofs do.
