# SCRUM-730 paid online drop-off: local proof

Taken 2026-11-03 on a disposable local database with the real API and till in a browser (`apps/pos/e2e/run.mjs`). Nothing here touched staging. The staging proof with a ZZ TEST booking is still to do, and the ticket asks for its first half before this lands; the steps are at the end. Keep the ticket short of Deployed until those screens are attached.

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

## Staging proof

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
