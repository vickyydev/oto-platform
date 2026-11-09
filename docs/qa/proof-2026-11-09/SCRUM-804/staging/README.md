# SCRUM-804 staging proof: settle a birthday party as one real sale

Run on 9–10 November 2026, from 23:35 Bangkok time on Monday 9 November to 00:14 on Tuesday 10 November. The run was on staging at main
9f92a316 (api, POS web, POS, Console). The OTO App was live at 3802ced5. The deploys were read the same before and after; nothing
was deployed or restarted.

One ZZ TEST party in the OTO App and one ZZ TEST till (ZZ TEST SCRUM-804 till, receipt prefix Z804X) served this proof and
SCRUM-805. The till was on Virtual box 1 at Central Floresta, with its simulated band printers and Receipt Printer 1. The reception
account signed the till in. Real names are covered in every picture. Band codes and the credit QR are blacked out because whoever
holds them can spend them.

**The date.** The branch's business day starts at 05:00, so between midnight and 05:00 the till and the slips job still treat
Monday 9 November as today. The party is dated 9 November, a weekday, and is priced at the weekday rate. Its package was applied
just after midnight, so its default 11:00 slip time was not due yet.

## What was done, in order

1. **The party in the OTO App.** "ZZ TEST 804 party" was created at Central Floresta for 9 November with 10 children and 4 adults.
   The billing deposit of 3,000 was set through the BEO billing route. The kitchen plan was set with the set menu "Birthday set
   menu, Central Floresta" switched on, kids' food at 14:00 and the ready offset at 20. The parent's choice of Margherita was made
   through the set-menu selection link's own routes. "Juice pitcher" ×2 was put on the bar plan. Then "Birthday package, Central
   Floresta" was applied (package snapshot, 201), and the "Reserved table for adults" add-on was set to quantity 1.
2. **The plan on the till** (GET /parties/:id, plan "ready"). It shows the package at 16,900 weekday and 20,900 weekend: 10
   children, 4 adults, socks for all, 350 per extra adult on a weekday. It shows the table add-on (5,000, with 5,000 F&B credit),
   the set menu with Margherita, kids' food 14:00, ready 20 minutes before, and slip time 11:00.
   Picture **804-st-02-party-page-plan**: the header shows Settle party and Add F&B to party, and no Add tickets.
3. **Settle party form.**
   - At 10 children and 4 adults: Package 16,900, socks 10 free, Add-ons 5,000, Total 21,900, F&B credit 5,000, Deposit paid
     −3,000, Balance 18,900 (**804-st-03**).
   - With adults set to 6: Extras · 2 adults 700, Total 22,600, Balance 19,600 (**804-st-04**).
4. **Confirm, then cash.** The balance of 19,600 was paid in cash on the normal payment screen, with the full amount on one tap.
   The screen showed "Settled, receipt Z804X-000001" (**804-st-05**).
   - **The sale lines:**
     - the package line at 16,900;
     - the six included items at 0;
     - Children (in the package) ×10 at 0;
     - Adults (in the package) ×4 at 0;
     - Extra adult ×2 at 350;
     - Regular Socks (free) ×10 at 0;
     - the reserved table at 5,000.
   - **Payments:** the deposit 3,000, then cash 19,600, for a total of 22,600.
   - **Credit:** a 5,000 F&B credit was granted.
   - **Printing:** 17 jobs printed on Virtual box 1: the receipt, 10 kids bands and 6 adult bands. The credit voucher prints on
     the receipt itself ("CREDIT VOUCHER, Credit loaded ฿5,000"), not as its own job. The receipt printout is **804-st-06** and
     the Console print record is **804-st-09**.
   - **Socks:** the shelf was at 0, so 12 ZZ TEST pairs were added first (**804-st-01**). The sale took 10, leaving 2. The 2
     left over were taken back, so the shelf is at 0 again (**804-st-08**).
5. **Back on the party page:** "Settled, receipt Z804X-000001", and the bill reads "Party settled" (**804-st-07**). A second
   Settle on the same party was refused **409 PARTY_ALREADY_SETTLED**.

## What did not pass

- **The sale id did not reach the OTO App.** The billing's pos_order_ref stayed empty. The settlement's write-back was refused
  by the OTO App with "OTOAPP_INVALID_DIRECTORY_KEY: the key is not one this app issued, or it has been revoked". The party page
  shows a red REFUSED chip (804-st-07). On the Console's Health page, job:otoapp.presence fails with the same error, starting 9
  November at 23:26. So this is staging's directory key between the api and the OTO App, not the settlement itself. Once the key
  is fixed, the write-back can be retried from Failures.
- **A deposit set on the BEO billing does not reach the POS.** The plan read a deposit of 0. The app's event packages view takes
  the deposit from the event's own "Prepayment" field, not from the BEO billing. To carry on, the ZZ TEST event's prepayment was
  set to 3,000, and the plan then read 3,000. Staff who enter a deposit only in the BEO billing module would see no deposit on the
  till.

## Smaller notes

- **The deposit's label.** The deposit payment is stored with method "other". The payment screen lists it as "other · ฿3000.00".
  The printed receipt calls it "Deposit paid in advance".
- **The party bill before settling.** Before the settlement, the party bill read ฿0 and "Fully paid", because the event carries
  no base price.

## Clean-up, read back

- **The till:** its printers were unassigned (0 devices), it was signed out (/me 401) and archived.
- **The sale:** the paid sale Z804X-000001 stays on record and was not voided.
- **The parties:** both ZZ TEST parties were deleted in the OTO App (204). Each event, its package snapshot and the till's party
  read now answer 404, and no "ZZ TEST 804/805" events are left.
- **Socks:** the Regular Socks shelf is back at 0.
- **Sessions:** the Console, the admin api and the OTO App sessions were signed out, and /me and /api/user answer 401.
- **The other tills:** Reception Till 1, Till 1 (Pi), Till 2 (test) and FWBooth1 were not touched.

All figures, ids and statuses are in receipt.json. Money there is in satang.
