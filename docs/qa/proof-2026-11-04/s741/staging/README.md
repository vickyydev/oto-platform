# SCRUM-741 staging proof, 4 November 2026

Run from 20:56 to 21:08 Bangkok (13:56 to 14:08 UTC) against staging, in a real
Microsoft Edge (156) driven by Playwright, one step at a time (`harness/`). Live
commit on every service the run touched: `ba64e70baf91b0de9146e644672dfa82fcee78d7`.
oto-pos-web-staging (dep-dbljebavcj2c738r8u8g), oto-pos-staging
(dep-dbljebavcj2c738r8ucg), oto-api-staging (dep-dbljebavcj2c738r8t90) and
oto-console-staging (dep-dbljebavcj2c738r8ug0) were live on it from 13:50 UTC and
were still on those deploys after the run (`live-readback.json`). Main CI
41837416939 passed all six jobs on that SHA. Password fields are masked in every
screen. Staging's text messages go to the console adapter (checked as a yes/no by
`harness/sms-check.mjs`; no value printed), so no message left the system.

## Fixture (ZZ TEST only)

- A till, `ZZ TEST SCRUM-741 till` (prefix `Z741`), made through the admin API on
  Virtual box 1 with its simulated kids band, adults band and receipt printers, as
  the SCRUM-730 proof did. Cards recorded by hand, QR not taken; read back "ready".
- Two ZZ TEST families booked a drop-off on the booking site as a guest walks it and
  paid on the simulated hosted page ("no real money moves"):
  `ZZ TEST SCRUM-741 Ying` with child `ZZ TEST SCRUM-741 Bua` (OTO-YJLN-QLDK, ฿915)
  and `ZZ TEST SCRUM-741 Dao` with child `ZZ TEST SCRUM-741 Mint` (OTO-S81C-0DP5, ฿915)
  ([hosted page](s741-st-00a-guest-simulated-hosted-page.png),
  [booked](s741-st-00b-guest-booking-paid.png)).
- The sibling `ZZ TEST SCRUM-741 Nok` (5) joined the Ying family at the door: the
  till's Add drop-off child, the family's Add sibling, Add & attach; the sale it opened
  was cancelled ([screen](s741-st-01-desktop-sibling-added-at-the-door.png)).
- The staging reception test account signed in on the ZZ TEST till at 1440 x 1024
  and, in a separate phone context, at 390 x 844.

## What was run, and what was seen

| Step | Screen | Seen |
|---|---|---|
| Before (3 Nov, SCRUM-730 proof) | [before](../../../proof-2026-11-03/s730/staging-after-14-family-with-paid-child-and-sibling.png) | One green "Booked & paid · no payment needed" and two presses both named "Check in" |
| 2. Board, Drop-off > Upcoming, 1440 | [after](s741-st-02-desktop-board-paid-and-to-pay.png) | Green "Booked & paid · ZZ TEST SCRUM-741 Bua", amber "To pay · ZZ TEST SCRUM-741 Nok" with the wallet icon, no "no payment needed", no plain "Check in", presses "Check in ZZ TEST SCRUM-741 Bua" and "Check in ZZ TEST SCRUM-741 Nok" |
| 3. Press "Check in ZZ TEST SCRUM-741 Bua" | [screen](s741-st-03-desktop-paid-child-opens-the-booking.png) | Redeem Online Booking for OTO-YJLN-QLDK, "Drop-off: ZZ TEST SCRUM-741 Bua", ฿915 paid; Nok not in it; behind it "No items added yet" and "Pay ฿0". Closed with no change |
| 4. Press "Check in ZZ TEST SCRUM-741 Nok" | [screen](s741-st-04-desktop-sibling-goes-to-the-till.png) | Current Order holds ZZ TEST SCRUM-741 Nok only (drop-off, play length to choose); Bua is not on it. Cancelled, no payment |
| 5. Phone 390, the family's screen | [screen](s741-st-06-phone-family-paid-and-to-pay.png) | The same two pills and "Check In ZZ TEST SCRUM-741 Bua" / "Check In ZZ TEST SCRUM-741 Nok"; no plain "Check In" |
| 6. Regression: a family all paid online | [screen](s741-st-05-desktop-all-paid-family-unchanged.png) | "Booked & paid · no payment needed" and one plain "Check in", as before |

Every count behind these rows is in `receipt.json` (`steps`). No page error was
raised in any context.

## Cleanup (read back)

As the SCRUM-730 proof did, each paid ZZ TEST child went the real way through the
ZZ TEST till with no new payment: redeem the paid booking (200), check in with a
synthetic camera picture (Chromium's test pattern, no person) and a band on the
simulated printer (200), pick-up with a synthetic picture (200). Readback
(`receipt.json` `readback`): both bookings `redeemed`; Bua and Mint `out`; sales
Z741-000001 and Z741-000002, channel `booking`, ฿915 each, each carrying the
booking's own payment (no new money), band and receipt printed on the simulated
printers. Those two are the only sales at the ZZ TEST till: the cancelled orders
left nothing. Both till sessions signed out (`/api/me` 401 after each), the driver
signed its admin API session out as it stopped, and the ZZ TEST till was archived
(200; not in the live list; no SCRUM-741 station live).

One record is left, as in the SCRUM-730 proof: `ZZ TEST SCRUM-741 Nok` is still
registered under Upcoming on family OTO-YJLN-QLDK, with no sale, no band and no
money. Nothing in the product removes a waiting child, and the database refuses
"out" for a child who never entered the park (seen in the SCRUM-730 proof), so
nothing was forced.

No real payment, SMS, setting, real box or park device was touched.

## Jira

SCRUM-741 got the before screen (3 November) and the five after screens attached, and
one plain comment (13470) showing them with how to retest. It was walked to Deployed
(`node scripts/agent/jira.mjs walk SCRUM-741 Deployed`, one commit link added) and read
back as Deployed (`jira-publication.json`).
