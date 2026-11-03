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
| [Check in pressed](./s730/local-after-02-check-in-opens-the-booking.png) | The booking's redeem dialog: ฿645 paid, Confirm & Issue. No line, no Pay |
| [Redeemed](./s730/local-after-03-redeemed-no-payment.png) | "Payment is complete", Check in now |
| [Back on the board](./s730/local-after-04-board-checks-in-with-no-payment.png) | "Already booked & paid, no payment needed", the visit photo, Check in & issue band |
| [Board, nanny](./s730/local-after-05-nanny-board-booked-and-paid.png) | Booked & paid with the booked start |
| [Nanny Check in pressed](./s730/local-after-06-nanny-check-in-opens-the-booking.png) | The booking's redeem dialog, not a refusal |
| [Phone family screen](./s730/local-after-07-phone-family-booked-and-paid.png) | Booked & paid |
| [Phone Check In pressed](./s730/local-after-08-phone-check-in-opens-the-booking.png) | The booking's redeem dialog on the phone till |

The band itself needs a camera for the visit photo, so the browser run stops at that step. `apps/api/test/booking-paid-online-no-second-charge.test.ts` and `booking-supervised.test.ts:192` take the child into the park with one band and no second sale.

Rerun: `PAYMENTS_SIMULATOR=on POS_E2E_BROWSER=chromium node e2e/run.mjs e2e/dropoff-paid-online.spec.ts` from `apps/pos`, with `POS_E2E_SHOTS` naming a folder for the screens.

## Staging proof

Before landing, while staging still runs the earlier source:

1. As ZZ TEST, pay a booking for one drop-off child through the booking site.
2. On the Check-in board, press Check in on that family. Screen: the till with the child as a line to charge.
3. Press Cancel at the till. Take no payment: the same booking serves step 6 below.

After landing:

4. As ZZ TEST, pay a booking for a nanny child as well.
5. Sign in at a till on the Check-in board. Screen: each family says Booked & paid.
6. Press Check in on the drop-off family. Screen: the redeem dialog, with no line and no Pay.
7. Confirm & Issue, then Check in now. Screen: the board's payment-free check-in. Take the visit photo and issue the band. Read the sale: one sale, the booking's, at what was paid.
8. Press Check in on the nanny family. Screen: the redeem dialog, not "has not been paid for yet".
9. Add a sibling to a paid family with Add drop-off child. Screen: the paid child reads Paid online and the sibling goes on the sale at the till's price.
10. Close out the ZZ TEST bookings and stays as the other staging proofs do.
