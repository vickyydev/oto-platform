# SCRUM-847 Golden Ticket drop-off: the customer screen waits with the staff screen

Both tills were live at 8bb78f578a836feb6d1eece2690afff51fda5e4e (oto-pos-staging dep-dbq99ctg1s2s7380osu0 from 16:16:43Z, oto-pos-web-staging dep-dbq99dajnfac73d8eu8g from 16:19:01Z, both read live again at 16:35Z). The till was loaded in a new browser profile and its bundle carried both new markers. Main CI 43056567671 was still running; it was not waited for.

The harness is the committed SCRUM-807 one, adapted (proof.mjs, flow.mjs): an own ZZ TEST till, a Golden Ticket bought in Shop for cash, redeemed for a ZZ TEST seven-year-old's drop-off, and the first pricing request after "Continue to payment" answered by the test.

| Step | Result | What the screens read |
|---|---|---|
| a. price held | Pass | Staff: Amount Due "—", "Waiting for the voucher price...", Confirm disabled, no sale written. The till's own customer half: "Waiting for the cashier to confirm…", no "Please pay", no ฿ figure. The separate display paired on the till: "Please follow the staff screen.", no amount. |
| b. price released | Pass | Staff: Amount Due "฿0", "No payment needed — This sale is fully covered — nothing to collect." Customer half: "Golden Ticket ฿0 Complimentary — enjoy!". The zero sale was completed, the child checked in, the voucher reads redeemed. |
| c. price refused (409 VOUCHER_NOT_HELD) | Pass | Amber box: "The voucher price could not be fetched: Scan the voucher at this till first — it is not held for this sale. Go Back to change the order, or Cancel the sale." Amount Due "—", Confirm disabled, Back enabled, customer half and separate display unchanged, no sale written, not asked again in 4 s. Cancel returned the till to a new order. |
| d. nothing answers (optional) | Not as expected | With the pricing request aborted the till moved to its counter box and the box read "The voucher price could not be fetched: Member not found. Go Back to change the order, or Cancel the sale." — not "Vouchers can only be redeemed online". In the picture Amount Due is "—", Confirm is greyed and the customer half is neutral; the till's sales read back with nothing written for it. The harness stopped at the wording, then cancelled the sale. |
| e. plain ticket sale | Pass | Staff: Amount Due "฿1040". Customer half: "Please pay ฿1040.00 to our staff". Cancel voided the sale (read back). |

Pictures, all opened and inspected: 847-a2 (both halves while the display is paired), 847-a3 (the separate display), 847-b1, 847-b2, 847-c1, 847-c2, 847-d1, 847-e1. The staff identity, the voucher card and the voucher entry are covered with boxes; no page text was changed. The picture of the same moment before this change is ../../SCRUM-807/staging/s807-waiting-for-voucher-price.png ("Please pay ฿1315.00 to our staff").

Notes. The till draws its own customer half for the wait even while a display is paired, as it did before the change; 847-a2 shows both. Under "Hold sale" the step still reads "The sale is still being saved — wait a moment." during the wait and the refusal, when no sale is being written. Step d's wording appears to come from the counter box lane (the hold note in 847-d1 says the till is working through its counter box); most likely the box did not know the guardian the family form had saved seconds earlier. Not looked into further here.

Two attempts. On the first, step c and the SCRUM-848 step passed; the later passes stopped at the member lookup because the family form of step c had saved the guardian as a member under the one test number. The second used one unused ZZ TEST number per pass and redeemed the voucher bought on the first.

Clean-up, read back: the redemption sale is finalised at zero and the plain sale voided; the child of step a was picked up with a separate synthetic photo (as cleanup-pickup.mjs of SCRUM-807) and reads out; the three guardian members, both tills and all five displays are archived or revoked; every session read 401 after sign-out. Left as records: the cash voucher purchase, and the registrations of steps c and d with the test child still "registered" (never checked in; there is no call that removes a registration).
