# SCRUM-799 Free Socks: staging proof

Run on 9 November 2026 from 18:03 to 18:27 Bangkok time, on commit
`a04e555feb18c2f455c73066b9392334738619f5`. oto-api-staging, oto-console-staging and
oto-pos-web-staging were live on that commit before and after the run (`liveBefore` and `liveAfter`
in `receipt.json`). Nothing was deployed or restarted during the run, and no setting was read or
changed. No SMS was sent.

Browser: headless Chromium 1440 x 900, Bangkok time zone. The Console was used as the staging platform
admin (Khun Anan, Owner). The till was used as the staging reception account (Som, Reception).

Only ZZ TEST records were used, and only cash:

- One till made for this run on Virtual box 1: "ZZ TEST SCRUM-799 till" (prefix Z799). It shared
  Virtual box 1's simulated Band Printer (kids), Band Printer (adults) and Receipt Printer 1. Its
  printers were unassigned and the till archived at the end.
- Walk-in number +66 89 799 0011. It was not a member before or after the run.
- Not used: the park's Pi, Till 1 (Pi), Till 2 (test), Reception Till 1 and FWBooth1. They are
  unchanged.
- The only notice pressed on the till was the refusal this run caused itself ("Back to the order").

## The one lasting change, made on purpose

Console, Catalogue, Add-ons, Park Central Floresta: Free Socks (CF-AO-FREE-SOCKS, ฿0) now has
"Takes stock from" set to Regular Socks. This is the ticket's setting for staging and it stays in
place. It is recorded in Activity as one `product.stock_share` row (18:07:49, before: nothing, after:
the Regular Socks stock item `01a0fa0b-8a6f…`, shares with product Regular Socks `01a0cb02-…f9da`).
No price changed: Free Socks is still ฿0 and Regular Socks still ฿60.

## Counts

- Before the run, Regular Socks at Central Floresta was N = 0 (FOH, BOH and Store all 0, "Out").
- After the run it is 0 again, at every place, and reads "Out".

N − 1 cannot happen when N is 0, so the run added 5 ZZ TEST pairs first. The one free pair sold came
out of those 5. The other 4 were taken back at the end. All the ZZ TEST adjustments together come to
+1, which exactly covers the pair that was sold, so Regular Socks reads exactly N.

## What a person sees

| Step | Result | Pictures |
| --- | --- | --- |
| 1. Console, Inventory, Park Central Floresta: Regular Socks reads "Out" (N = 0). Adjust +5 with the reason "ZZ TEST SCRUM-799: stock for the free socks proof". The card then reads "Low · 5". | Pass | `s799-st-01a-inventory-regular-socks-before.png`, `s799-st-01b-adjust-plus-5-zz-test.png`, `s799-st-01c-inventory-regular-socks-5.png` |
| 2. Console, Catalogue, Add-ons, Central Floresta: the list shows Free Socks ฿0 and Regular Socks ฿60. Edit Free Socks: "Takes stock from" first reads "Nothing — not counted". Opened, it offers Glow Band, Locker Rental, Refillable Drink Cup and Regular Socks. Choose Regular Socks and save (PATCH 200, body `stockShareItemId` = the Regular Socks stock item). Reopen the form: it reads Regular Socks, with the price still 0. The menu read now returns Free Socks with `stockShareItemId` = the Regular Socks item and no stock links of its own. Activity shows the `product.stock_share` row. | Pass | `s799-st-02a-add-ons-list.png`, `s799-st-02b-free-socks-form-before.png`, `s799-st-02c-takes-stock-from-options.png`, `s799-st-02d-takes-stock-from-regular-socks-chosen.png`, `s799-st-02e-free-socks-form-reopened-share-set.png`, `s799-st-02f-activity-product-stock-share.png` |
| 3. Till: walk-in Tourist, 1 Hour Play, 1 kid and 1 adult, Free Socks added once on the Extras & Add-ons grid. The socks counter (Regular Socks ฿60) stayed at 0, so no paid pair was added. The order panel shows "Free Socks ฿0". The customer display shows "Free Socks 1 × ฿0". The total is ฿1,040 (Kids ฿690 + Adults ฿350), and the platform's quote has an add-on line "Free Socks 1 × 0". Paid in cash: "Payment Successful, Receipt Z799-000001 • ฿1040 • Cash". | Pass | `s799-st-03a-order-panel-free-socks-0.png`, `s799-st-03b-add-on-grid-free-socks-1.png`, `s799-st-03c-payment-successful.png` (band codes and QR grids hidden) |
| 3. Read back. The sale is finalised and its lines are Kids ฿690, Adults ฿350 and "Free Socks" (add-on) 1 × ฿0. Its stock movements are a single movement: kind sale, −1, on the Regular Socks stock item at the FOH sell point, on the Free Socks line, level after 4. The Console's Inventory reads Regular Socks "Low · 4", which is 5 − 1 (N + 5 ZZ TEST − 1). Activity `stock.sale` for that sale shows the same −1 on the Regular Socks item, with no shortfall. | Pass | `s799-st-03d-inventory-regular-socks-4-after-free-pair-top.png` (Park chip in view), `s799-st-03d-inventory-regular-socks-4-after-free-pair.png`, `s799-st-03e-activity-stock-sale.png` |
| 4. Out of stock. Console Adjust −4 with the reason "ZZ TEST SCRUM-799: out of stock check" takes Regular Socks to "Out" (0). On the till, a new walk-in 1 Hour Play with Free Socks × 1: at Pay the platform refuses with 409 STOCK_SHORT, "Regular Socks is out of stock. Nothing was saved." (shortage: Regular Socks, requested 1, available 0). The payment panel reads "This sale has not been saved. Regular Socks is out of stock. Nothing was saved. … Nothing was charged." The refused sale id reads 404 afterwards, and the till still holds only Z799-000001. "Back to the order", then Cancel, emptied the order. The adjustment was then reversed: +4 with the reason "ZZ TEST SCRUM-799: reverse the out of stock check", back to 4. | Pass | `s799-st-04a-adjust-minus-4-to-0.png`, `s799-st-04b-inventory-regular-socks-out.png`, `s799-st-04c-till-refuses-regular-socks-out-of-stock.png`, `s799-st-04d-inventory-regular-socks-4-restored.png` |
| 5. The Adjust dialog's reason chips are Received shipment, Inventory recount, Damaged / shrinkage, Staff use and "Complimentary / staff use". A −1 with the "Complimentary / staff use" chip tapped (the chip turns highlighted and the reason field reads the same words) took the count to 3. Read back, the movements list's newest row is adjust −1, level after 3, reason "Complimentary / staff use". Activity `stock.adjust` shows delta −1 and the same reason. Reversed with +1, reason "ZZ TEST SCRUM-799: reverse the complimentary check". | Pass | `s799-st-05a-adjust-minus-1-complimentary-chip.png`, `s799-st-05b-inventory-regular-socks-3.png`, `s799-st-05c-activity-stock-adjust-complimentary.png` |
| 6. Clean-up: −4 with the reason "ZZ TEST SCRUM-799: take back the 4 unused test pairs". Regular Socks reads "Out", 0, as before the run. The whole ledger of this run is in the movements list. | Pass | `s799-st-06a-adjust-minus-4-take-back.png`, `s799-st-06b-inventory-regular-socks-back-to-0.png`, `s799-st-06c-movements-list-api-read.png` |

`s799-st-06c` is not a product screen, because no screen lists stock movements. It is the API's
movements list (`GET /branches/:id/stock/movements?stockItemId=…`), drawn as a plain table for the
record. Every row of this run is in it, newest first:

| Time | Change | Level after | Reason or line |
| --- | --- | --- | --- |
| 18:25:56 | −4 | 0 | take back |
| 18:25:34 | +1 | 4 | reverse the complimentary check |
| 18:16:26 | −1 | 3 | Complimentary / staff use |
| 18:16:01 | +4 | 4 | reverse the out of stock check |
| 18:13:29 | −4 | 0 | out of stock check |
| 18:11:14 | sale −1 | 4 | the Free Socks line of Z799-000001 |
| 18:04:43 | +5 | 5 | stock for the free socks proof |

All of them are at the FOH sell point.

## Clean-up (read back at 18:26)

- Stock: Regular Socks is back to 0 at FOH, BOH and Store, as before the run.
- The Free Socks share is kept on purpose (see above). The menu read still returns it.
- The paid cash sale Z799-000001 (฿1,040) stays on record as paid, as in earlier proofs.
- No unpaid sale exists on the till. The out-of-stock attempt saved nothing.
- The ZZ TEST SCRUM-799 till was signed out (its `/me` then answered 401), its printers were
  unassigned, and it was archived (it reads archived with 0 devices).
- Reception Till 1 (7 devices), Till 1 (Pi), Till 2 (test) and FWBooth1 are unchanged.
- Console: signed out with its own Sign out button. The sign-in form showed again and `/me` answered
  401.
- The admin API session the script used for read-backs was signed out at the end.

## Notes

- Once, the Console tab stopped answering: its page script froze, and even a screenshot timed out.
  It happened just after Activity was filtered by `stock.adjust` (the first try at step 5's
  read-back). That session was signed out with its own cookie (sign-out 200, then `/me` 401) and the
  tab closed. In a fresh tab the same filter and the same row opened normally. It did not happen
  again, so it is recorded here only as something seen.
- Reading Activity unmasked adds `audit.read_sensitive` rows against the admin account, as the
  Console says it will.
- As the lane's notes say, the till's add-on grid shows Free Socks without a count or an
  "Out of stock" label, even with Regular Socks at 0. The guard is the platform's, at Pay. In the
  same minutes, the till's header strip still listed Regular Socks as "low", and the grid's Regular
  Socks card had no "Out of stock" label. The till had not yet re-read the counts after the Console
  adjustment. The platform's refusal was correct.
- On payment the till also issued its usual collect voucher for the add-on ("Free Socks ×1 to
  collect", sent to the simulated Receipt Printer 1 with the receipt and the two bands). The stock
  left the shelf when the sale was finalised, the same way a priced Regular Socks pair does.
