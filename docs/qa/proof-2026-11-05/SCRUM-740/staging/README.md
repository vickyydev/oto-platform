# SCRUM-740 A child paid for at the till is never charged again: staging proof

Run on 5 November 2026, 19:12-19:27 Bangkok (clean-up 19:41-19:43), on the live commit
`fe6181bdb1edefd0f100b9c19be177446991ad0d` (main CI run 42020809305 green on that SHA, the Till
end-to-end step included). oto-api-staging, oto-pos-web-staging, oto-pos-staging and
oto-console-staging were live on that commit before and after the run (`../live-before.json` read
19:12, `../live-after.json` read 19:43); the api's live deploy finished at 19:09. Nothing was deployed
or restarted during the run and no setting was read or changed. No migration ships with this change.

A real Edge browser (Playwright, `channel: msedge`, Edge 156, a simulated camera for the consent and
pickup photos) in the Bangkok time zone: the till at 1600 wide with its customer display beside it
(the test harness), the Console at 1500 wide. ZZ TEST records only, cash only, no SMS. The park's Pi,
Till 1 (Pi), Till 2 (test), FWBooth1 and Reception Till 1 were not used.

## Set-up

- Two tills made for this run on Virtual box 1 at Central Floresta, "ZZ TEST SCRUM-740 till" (Z740)
  and "ZZ TEST SCRUM-768 till" (Z768), no devices, signed in as the staging reception account,
  Som (Reception). Both archived afterwards.
- Two walk-in families registered at the till's door, with no phone number (so no member was made):
  "ZZ TEST 740 Family" with ZZ TEST 740 Ploy (6) and ZZ TEST 740 Tam (7), and "ZZ TEST 740 Second
  Family" with ZZ TEST 740 Nok (5).
- A first attempt at the same ring-up stopped at the photo step (the browser's simulated camera did
  not start); nothing was written by it (the till's sale list read empty), and the browser was
  restarted before the run below.

## What a person sees

| Plan step | Result | Screenshot |
| --- | --- | --- |
| 1. 2 Hours Play, two kids and no adult: "Children playing alone" names both children (6 and 7, Drop-off required); the customer display takes the photos, the parent's name, the consent and the three confirmations | Pass | `st-01a-two-children-registered-for-drop-off.png` |
| 1. Both on one sale, ฿2,230 (two drop-off lines of ฿890 + ฿225), paid in cash: "Payment Successful, Receipt Z740-000001", then "Check in the drop-off child?" for both | Pass | `st-01b-paid-in-cash-receipt-and-door-choice.png` |
| 1. Leave as booked: "Left as booked — ZZ TEST 740 Ploy, ZZ TEST 740 Tam — checkable later from the Drop-Off board" | Pass | `st-01c-left-as-booked-receipt-z740-000001.png` |
| 2. A third child, ZZ TEST 740 Nok, on a second walk-in sale, ฿1,115 cash, Receipt Z740-000002; the till reloaded while "Check in the drop-off child?" was still open, so no choice was made (no leave-as-booked or check-in call was sent) | Pass | `st-02a-third-child-paid-door-choice-not-made.png`, `st-02b-till-reloaded-before-any-choice.png` |
| 3. Add drop-off child picker: all three children read "Paid at till · Z740-000001" or "Paid at till · Z740-000002", both family buttons read "Paid at till" and are greyed out, no Add to sale on either family, Add sibling stays | Pass | `st-03-picker-three-children-paid-at-till-no-add-to-sale.png` |
| 4. A second sale for a paid child, sent with curl to POST /api/sales as reception (the till's own route) for Nok and for Ploy: 409 CHECKIN_PAID_AT_TILL, "ZZ TEST 740 Nok is already paid for at the till on receipt Z740-000002, so there is nothing to charge. Check them in from the Drop-Off board. Nothing was saved." (Ploy's names Z740-000001); each refused sale reads 404 afterwards | Pass | `st-04-second-sale-refused-409-nothing-saved.png`, `st-04-second-sale-refused.txt` |
| 4. Console Activity, filtered to checkin.second_charge_refused: two rows by Som (Reception) at Central Floresta, 19:23; Nok's row opened: code CHECKIN_PAID_AT_TILL, paid on sale 01a1aba8-f480-…, receipt Z740-000002, refused sale 01a1abaa-2e52-… | Pass | `st-04b-console-activity-second-charge-refused-rows.png`, `st-04c-console-activity-row-opened-paid-sale-receipt-refused-sale.png` |
| 5. Check-in board: both families read "Booked & paid · no payment needed" (Nok is the child whose till reloaded) | Pass | `st-05a-board-booked-and-paid-no-payment-needed.png` |
| 5. Check in on Nok: "Check in child — ZZ TEST 740 Second Family · already booked & paid — no payment needed", Check in & issue band; no payment screen (no Amount Due on the page); one call, POST /checkin/check-in-booked 200; Nok in the park with no new sale | Pass | `st-05b-check-in-pressed-no-payment-screen.png`, `st-05c-checked-in-in-park-no-payment-taken.png` |
| 6. Regression (SCRUM-730): a ZZ TEST family paid online, ZZ TEST Family 496 waiting, still reads "Paid online" on its paid child, and Add to sale on that family adds only its unpaid siblings | Pass | `st-06-regression-paid-online-child-still-reads-paid-online.png` |

Read back after step 5: the ZZ TEST SCRUM-740 till holds exactly two sales, Z740-000001 (฿2,230) and
Z740-000002 (฿1,115), both finalised; no third sale exists.

## Not shown on staging

- The box path (a sale taken on the counter box or the booth while offline): covered by the
  box-agent tests in the lane record (`s494-checkin-box`, `offline-checkin`, `station-bridge`) and
  reaches the park's boxes only with the next box release install.

## Clean-up (19:41-19:43, read back)

- Ploy and Tam checked in from the board (no payment, one POST /checkin/check-in-booked), then all
  three children checked out with a pickup photo to their own family; none of this run's
  registrations is still waiting.
- The three paid cash sales stay on record as paid (Z740-000001, Z740-000002 and SCRUM-768's
  Z768-000001), as in earlier proofs.
- Every session this run opened was signed out (GET /me 401 afterwards, the curl session too); both
  ZZ TEST tills archived; Reception Till 1, Till 1 (Pi), Till 2 (test) and FWBooth1 unchanged.
- `receipt.json` holds every step's read-back, the fixture, the created records and the clean-up.

## Jira

Eight of these images are attached to SCRUM-740 and shown inside comment 13509
(`jira-comment-740.txt`, `jira-publication.json`); the ticket was walked to Deployed (five commit
links added) and read back Deployed, never Done. The harness that drove both tickets' runs is in
`harness/` (setting names only, never a value).
