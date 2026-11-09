# SCRUM-798 Golden Ticket: staging proof (9 November 2026)

**Result: passed.** All six checks passed on staging. One till screen in the drop-off path misbehaved (finding 1 below).

## Where and with what

- **Code:** main at `85b18b5c2ac0b16cb7a5e7e3243b7c3b3cf67551`. All three services were live at that commit before the run started:
  - oto-api-staging went live at 11:34:40Z. Its pre-deploy applied the migrations and ran platform-sync.
  - oto-pos-web-staging went live at 11:33:36Z.
  - oto-pos-staging went live at 11:31:33Z.
- **Till:** a new ZZ TEST till, "ZZ TEST SCRUM-798 till" (prefix Z798), on Virtual box 1 at Central Floresta. It used the box's simulated printers. It was archived at the end. No real till, the Pi, Reception Till 1 or FWBooth1 was touched.
- **Accounts:**
  - Reception (Som) made the sales.
  - The manager (Khun Lek) made the refunds, because reception does not have refund approval.
  - The admin made the API reads and the Console checks.
- **Payment:** cash only. No SMS was sent and no setting was changed.
- **Browser:** headless Chromium 153, 1440×900, Bangkok time.
- **Pictures:** band codes, QR grids and phone numbers are hidden in magenta. The voucher codes are shown in full. They are ZZ TEST vouchers, and this run used or voided every one of them.

## Results

| # | What was checked | Result | Pictures |
|---|---|---|---|
| 1 | **Platform-sync did its part.**<br>• The pre-deploy log reads "Golden Ticket: created the voucher type for 1 operator(s), linked 2 shop item(s)."<br>• `GET /voucher-definitions` has `golden-ticket`: kind `free_ticket`, on the Full Day Pass (Central Floresta), offline policy refuse, single use, never expires, cost 0, active.<br>• The ledger reads the gift-day offer as "Gift day for one child: Full Day Pass".<br>• The menu has CF-TK-GOLDEN, "Golden Ticket", ฿1,500, active.<br>• On the till, the "Issue a voucher…" list leaves the Golden Ticket out.<br>• Asking the till to issue it is refused: 409 `VOUCHER_SOLD_AS_ITEM`, "Golden Ticket is sold as a shop item — selling it issues the voucher".<br>• The sale in step 2 minted its code through the item link. | Pass | `s798-st-01a-console-voucher-types-golden-ticket.png`, `s798-st-01b-till-issue-picker-no-golden-ticket.png`, `s798-st-01c-api-reads-sync-definition-item-link.png` |
| 2 | **Golden Ticket sold on the Shop tab** (Tickets & passes, ฿1,500, guest, cash): **Z798-000001**.<br>• Sale Confirmed shows "Golden Ticket TV8FKTBZHBT — Give this code to the family — it is on the receipt, and redeemed at the ticket till."<br>• From the API, the sale's `issuedVouchers` has one `golden-ticket` voucher with that code, status issued.<br>• The receipt print job was printed on Receipt Printer 1. The simulated printer's picture shows "1× Golden Ticket ฿1,500" with "Voucher code: TV8FKTBZHBT" under it. | Pass | `s798-st-02a-shop-golden-ticket-on-the-order.png`, `s798-st-02b-shop-sale-confirmed-voucher-code.png`, `s798-st-02c-receipt-printout-voucher-code.png` |
| 3 | **Parent stays, age 4, socks: Z798-000002.**<br>• A walk-in Tourist sale, with the code typed into Redeem voucher. The voucher card and the Golden Ticket card appear: what it gives, "Child's age", "Parent stays" / "Drop-off", and "Free pair of Regular Socks".<br>• At age 4 only Parent stays can be pressed, with the note "Under 5, the parent stays with the child — drop-off is from age 5."<br>• With socks ticked, "Ring up the Golden Ticket" gives one Full Day Pass line: Kids 1, Adults 1, Regular Socks 1. The Golden Ticket takes −฿1,500, and Total and Amount Due are ฿0.<br>• The platform prices Kids, Adults and Regular Socks at ฿0 each.<br>• Complete Sale shows "Payment Successful … ฿0" and "Voucher TV8FKTBZHBT used". One child bracelet and one adult bracelet were issued and printed.<br>• `grants: []` on the sale: no food credit.<br>• The voucher now reads **redeemed** on Z798-000002 at the ZZ TEST till.<br>• Regular Socks stock went −1. | Pass | `s798-st-03a-console-adjust-regular-socks-plus-1-zz-test.png`, `s798-st-03b-golden-ticket-card-appears.png`, `s798-st-03c-age-4-parent-stays-only-socks-ticked.png`, `s798-st-03d-rung-up-full-day-pass-1-child-1-adult-socks-total-0.png`, `s798-st-03e-rung-up-card-on-this-sale-total-0.png`, `s798-st-03f-payment-screen-amount-due-0.png`, `s798-st-03g-complete-sale-success-bands-no-credit.png`, `s798-st-03h-receipt-printout-golden-ticket-sale-0.png` |
| 4 | **Refusals.**<br>• The same code on a new sale is refused: 409 `ALREADY_REDEEMED`, "Already redeemed on 9 Nov 2026 18:47 at Oto Play Park, Central Floresta / ZZ TEST SCRUM-798 till by Som".<br>• A made-up code, ZZTEST798XQ, is refused: 422 `INVALID_CODE`, "Invalid code". | Pass | `s798-st-04a-same-code-again-refused-already-redeemed.png`, `s798-st-04b-made-up-code-refused-invalid.png` |
| 5 | **Drop-off, age 7.**<br>• A second Golden Ticket was sold for cash (**Z798-000003**, code TV25N7JN9WM).<br>• On a new walk-in sale, at age 7 both choices are offered. Drop-off gives "Ring up and open the Drop-Off form". The family's half opens "Tell us about your child" with **Age 7 yrs already filled**.<br>• Filled with ZZ TEST details: child "ZZ TEST 798 Child", guardian "ZZ TEST 798 Guardian", the ZZ TEST number from the start (+66897980011, kept and not asked again), a photo, and all four agreements. The till lists each agreement as ticked by the family.<br>• After that, Done on the family's half and the till's continue.<br>• The drop-off line reads "ZZ TEST 798 Child ฿1315 (Full Day Pass ฿1090, Drop-off service ฿225)". The Golden Ticket takes −฿1,315 and Amount Due is ฿0.<br>• Complete Sale gives **Z798-000004**, ฿0, `grants: []`. On the API sale, both Kids and the Drop-off service line read gross 0. Left as booked.<br>• On the Check-in board the child reads "Booked & paid · no payment needed". Checked in from the board ("already booked & paid — no payment needed"), then checked out with the pickup photo. The board shows "Out · 19:01", so no child from this run is still in care. | Pass, with finding 1 | `s798-st-05a-second-golden-ticket-sold-voucher-code.png` … `s798-st-05n-board-checked-out.png` |
| 6 | **Refund.**<br>• The manager's whole refund of the **first** sale (Z798-000001) is refused, as designed: 409 `SOLD_VOUCHER_USED`, "The Golden Ticket sold on this sale (code ending ZHBT) has already been used (receipt Z798-000002), so it cannot be refunded." Nothing was refunded.<br>• A third Golden Ticket was sold (**Z798-000005**, code TVMCW4CBX5J) and refunded whole, unused: **Z798-R-000001**, ฿1,500 cash, with manager approval. The sale reads refunded.<br>• The voucher reads **void**. The audit has `voucher.void` (codeLast4 BX5J), and `sale.refund` lists `soldVouchersVoided`.<br>• At the till the code is refused: 409 `VOUCHER_VOID`, "This voucher has been cancelled". | Pass | `s798-st-06a-third-golden-ticket-sold-to-refund-unused.png`, `s798-st-06b-manager-refund-first-golden-ticket-sale-dialog.png`, `s798-st-06c-refund-refused-golden-ticket-code-already-used.png`, `s798-st-06d-manager-refund-unused-golden-ticket-dialog.png`, `s798-st-06e-unused-golden-ticket-refunded.png`, `s798-st-06f-refunded-code-refused-void.png` |

Picture `s798-st-01c` is not a product screen. It is a plain drawing of the API's own answers, read as the admin at the time printed on it, because no screen shows these together. Pictures `02c` and `03h` are the PNGs that the simulated receipt printer drew (`GET /devices/:id/printouts/:seq/preview.png`).

## Findings and notes

1. **Drop-off path: the payment screen briefly asked for ฿1,315.** This needs a ticket.
   - What happened: after the family's form was filled, "Continue to payment" registered the child and opened the payment screen. That screen read **Amount Due ฿1315** with Cash, Card and PromptPay. At the same time the order panel read Total ฿0 and Pay ฿0, and the voucher box said "The platform is still pricing the voucher — press again in a moment".
   - Under the hood: no sale was written. Confirm Payment Received stayed disabled, with "The sale is still being saved — wait a moment".
   - Cause, as I read it: the drop-off line needs a new price, and the till tried to save the sale before the price came back. It did not try again.
   - Recovery: Back, then Pay ฿0 again, then Done on the family's half. That saved the sale at ฿0, and it then closed normally. Nothing was charged.
   - A cashier could still read ฿1,315 as money to take.
   - Pictures: `s798-st-05e-…`, `s798-st-05f-…`, then `s798-st-05g-…` and `s798-st-05h-…`.
2. **"Credit issued" on the parent-stays receipt.** The receipt of Z798-000002 has a "Credit issued" heading, but the only line under it is "1× Regular Socks to collect". That is the pickup slip for the free socks. The success screen calls it "Credit Grants to Print: Regular Socks ×1 to collect". There is no food credit or wallet credit: the sale's `grants` is empty, and the finalise answer's `grants` is `[]`. The lane's own proof notes expected no "Credit issued" heading at all, so the wording is for the owner to judge.
3. **The till did not see the extra socks until it reloaded.** Regular Socks was at 0. To let the free socks sell, one ZZ TEST pair was added in the Console ("ZZ TEST SCRUM-798: one pair for the Golden Ticket's free socks"), as the SCRUM-799 proof did.
   - The till had read its stock before that, so at Pay it said "Insufficient stock … Regular Socks (need 1, have 0)" and wrote nothing.
   - The voucher was released, the cart cancelled, the till page reloaded, and the redemption done again.
   - The sale then took the pair: the stock movement is −1, the level after is 0, and Regular Socks is back to 0, as before the run.
   - This is the till's existing stock cache (it refreshes on load and after a sale), not SCRUM-798.
4. **Where a sold voucher came from.** The ledger read (`/vouchers/by-code`) gives a sold Golden Ticket the place "Counter (station not recorded)" and the source "manual". The audit row `voucher.issue` does carry the ZZ TEST till's stationId and `issuedSaleId`. The till's card calls it "Till voucher". The lane's review raised the same point about the source.
5. **Console label.** Console > Voucher types shows the Golden Ticket's worth as "Second kids ticket free — Full Day Pass", which is the 1+1 wording. This was already known and left open by the lane.
6. **History screen.** The History screen for the selling sale does not show the code. The API (`GET /sales/:id` `issuedVouchers`) and the receipt do.
7. **Drop-off side effects.**
   - The drop-off form found or created the parent as a member, "ZZ TEST 798 Guardian", with the child. That member was archived at the end.
   - The board shows the WhatsApp confirmation for the ZZ TEST number as "Awaiting confirmation". None of its buttons (Resend, Sim: parent confirms, Couldn't reach) was pressed.
8. **Test set-up only.** Headless Chromium could not start its built-in fake camera. The browser was restarted with a small synthetic video file (`--use-file-for-fake-video-capture`) so the drop-off photo and the pickup photo could be taken. The first drop-off attempt was backed out before anything was written: the voucher was released and the order cancelled.

## What this run left on staging

- **Sales:** Z798-000001 to Z798-000005 stay recorded.
  - Z798-000001 and Z798-000003 are ฿1,500 cash, still finalised. Their codes were used.
  - Z798-000002 and Z798-000004 are ฿0 redemptions.
  - Z798-000005 is refunded by Z798-R-000001.
- **Vouchers:** …ZHBT and …N9WM are redeemed, and …BX5J is void.
- **Bands:** the bands of Z798-000002 (one kid, one adult) and the drop-off child's band from check-in stay as issued. They are ZZ TEST bands with no credit.
- **Drop-off:** the registration for ZZ TEST 798 Child is checked out. The member "ZZ TEST 798 Guardian" is archived, and the walk-in number now finds no member.
- **Stock:** Regular Socks reads 0, as before the run (+1 ZZ TEST, −1 sold).
- **Till and sessions:** the ZZ TEST till is archived with no printers. Every session of the run is signed out: reception, manager, Console and the admin API.

## Files

- `receipt.json`: everything the run read and wrote, with timestamps. Band codes are withheld.
- The harness is kept outside the repo, in the session scratchpad (`s798p/driver.mjs` and `s798p/steps/`).
