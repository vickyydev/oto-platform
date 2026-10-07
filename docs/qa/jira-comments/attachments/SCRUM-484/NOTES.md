# SCRUM-484 success-screen smalls on staging - capture notes

Captured 8 Oct 2026, about 05:05 to 05:20 Bangkok time (trading day 2026-10-08
at Demo Branch 2; the day rolled at 05:00). Staging services on `c6194664`.
Driven with Playwright as the seeded platform admin (Khun Anan, Owner) in a
signed-in page moved to Demo Branch 2, Reception Till 1; nothing committed, Jira
not touched. Customer display open (the till's split view) in every shot.

## Shots (file names all start `SCRUM-484-staging-`)

| File | What the viewer sees | What was done |
|---|---|---|
| `success-screen-badges-whole-display-open.png` | Ticket sale "Payment Successful", Receipt D2-000014, 1650 baht, Cash. "Bracelets to Print - 2 TOTAL": 1x Child bracelet and 1x Adult bracelet, each with its badge reading "ALL DAY + MEAL" whole (not "ALL"). The customer display beside it shows "Thank you!", 1 Child bracelet, 1 Adult bracelet and two Credit Grants cards reading 350 and 1300 baht (numbers visible); each card also carries a small credit QR (52 px wide in the picture) that a QR decoder could not read, so no credit code can be taken from the PNG. Below the rows: "No band codes came back for this sale. Reprint its bands from History to issue them." | Tickets > Walk-in > Tourist > Eat & Play Kids Pass (1 kid, 1 adult, 1650 baht) > Continue; the phone 999484001 and nickname "ZZ TEST Guest 484" typed on the customer display; Cash; Confirm Payment Received. |
| `voucher-picker-prompt-whole.png` | The current order panel with the "Issue a voucher..." row open: the select reads "Choose a promotion..." in full on its own first line, with "Issue & print" and the close button on the line below. | Tickets > Walk-in > Tourist > Issue a voucher. Nothing issued. |
| `voucher-picker-promotion-name-whole.png` | The same select with "ZZ TEST F6 recheck 50 (0/1 used)" chosen, drawn whole. | Chose it in the select. Nothing issued. |
| `voucher-picker-long-name-cut-full-name-in-tooltip.png` | The select with the 70-character "ZZ TEST SCRUM-484 a voucher type with a name far too long for one line" chosen: the closed select draws one line and cuts it ("ZZ TEST SCRUM-484 a voucher type ..."). TEXT READ-BACK (not in the image): the select's `title` attribute, which is the tooltip, reads the full 70-character name; the picture does not show a tooltip. | A ZZ TEST voucher type was made for this in Console > Voucher types and ARCHIVED right after (see below). Nothing issued. |
| `fnb-success-wallet-ledger-shows-spend.png` | F&B "Order Confirmed", Order #0001, Receipt D2-000015, 1x ZZ TEST Espresso 60 baht, "F&B credit 60", "Remaining credit - Walk-in guest 1240". WALLET LEDGER: "Spend - Fnb Order - Khun Anan (Owner) -60" above "Grant - Ticket Sale - Khun Anan (Owner) +1300". The customer display shows the pick-up code 48 and remaining credit 1240. | Typed the kid wallet's credit code from sale D2-000014 (read from `GET /sales/:id`) into F&B "Wristband code", Load Tab (1300 credit), added ZZ TEST Espresso, Charge, pick-up code 48, Complete Order (credit covered all of it). |

The ticket text asked for "a long promotion name whole" in the picker. What the
picture shows: a name that fits the panel is whole; a name longer than the panel
is cut by the closed select and carries its full text only as a tooltip.

## Records written (all at Demo Branch 2)

| What | State left |
|---|---|
| Sale D2-000014, 1650 baht cash, Eat & Play Kids Pass, customer "ZZ TEST Guest 484" +66999484001 | Finalised. It made two wallets: adult 350, kid now 1240 after the order below; both expire at 05:00 Bangkok on 9 Oct |
| F&B order D2-000015, 60 baht, ZZ TEST Espresso, paid from the kid wallet | Finalised |
| Two drafts left by aborted runs of mine (1650 and 60 baht, status tendering) | VOIDED with reason "ZZ TEST abandoned capture draft (SCRUM-218 run)"; the seeded 450 baht tendering draft of 7 Oct was not touched |
| Voucher type "ZZ TEST SCRUM-484 a voucher type with a name far too long for one line" (1 baht off) | Created in the Console's voucher catalogue (shared by every park), then archived; not offered by any picker now |
| Three ZZ TEST menu items (Espresso, Latte, Toastie) | Made for the SCRUM-218 walkthrough; left in place |

## Observations

- "F\&B credit" on the staff side of the F&B success screen has a stray backslash
  (visible in the image); the customer side reads "F&B credit".
- The ticket sale printed no bands because Demo Branch 2 has no box ("No band codes
  came back"); the wallet was reached by its credit code instead of a scanned band.
- Independent check of the pictures (8 Oct): no typed credit code, password or token is
  readable in any of the five; the only QR images are the two 52 px credit QRs on the
  customer display of the success picture, which a decoder could not read. The F&B
  success picture labels the wallet "Walk-in guest"; that it is the kid wallet rests on
  the ledger line (Grant +1300) and the code typed from sale D2-000014, not on a name.
