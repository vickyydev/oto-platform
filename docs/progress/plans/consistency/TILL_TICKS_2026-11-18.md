# Till details as ticks for the owner (SCRUM-497)

18 November 2026. The owner asked for these on his decisions page that day:
he ticked "Show me the twelve as ticks" and "Bring them as ticks" for the
smaller questions. This file is the source for those ticks. It changes
nothing in the till. Until he ticks a change, the till keeps what it does
today.

How this was checked: every "Today" line was read in the code on `main`
(d751e2b10) on 18 November 2026; the file named in brackets is where it was
read. The wording and the alternatives come from the list of 18 November
beside this file (TILL_DETAILS_2026-11-18.md), the register (REGISTER.md,
entries 44 to 65), `docs/progress/OPEN_ITEMS.md`,
`docs/progress/decisions/OWNER_QUESTIONS_2026-10-14.md` and the comments on
SCRUM-497.

His rulings of 18 November are applied and not asked again: the park's day
is the calendar day, midnight to midnight; an additional party bill gets its
own receipt and shows on End of Day by how it was paid; refunds need a
manager's approval; credit vouchers are issued by managers only, staff ask
and a manager approves; a returning family's online changes are saved to the
family record; a card refund goes back to the card where the terminal
allows.

Counts: 12 ticks in part 1, 23 ticks in part 2, 1 settled by the rulings of
18 November, 5 not his to choose. Part 2 covers the 14 questions from the
ticket's comments and the 7 from the list of 14 October; two of the seven
hold more than one question and are split (the outage rules into three ticks,
the staff benefits into two), and one comment question has no screen that
reaches it (see "Not his to choose").

In each tick, option A is what the till does today.

---

## Part 1. The twelve points that kept the recorded behaviour on 14 October

### k1. Promo code for one part of an order

Question: Should a code meant for one part of the order, such as tickets only, stop at what is left of that part?

Today: It stops there. Example: tickets ฿600, socks and lockers ฿300, and two tickets-only codes of ฿500 each: the first takes ฿500, the second only the ฿100 left on the tickets, and the family pays ฿300. (packages/shared/src/cart-totals.ts)

- [ ] A. Stop at what is left of that part (today)
- [ ] B. Take from the rest of the order too, as the approved design does: in the example the second code takes ฿400 and the family pays ฿0

If changed: small, one rule in the price calculation.

### k2. Ticket with no price for a customer type

Question: When a ticket has no price for a customer type (Tourist, Expat, Thai), should the till refuse it or sell it at ฿0?

Today: Refused. The ticket card shows "Not priced" and tells staff to set the price under Admin, Tickets. Example: if the 2 hour ticket has no Expat price, it cannot be sold to an Expat family until it is priced. (apps/api/src/services/sale.ts, apps/pos/src/lib/pricing.ts)

- [ ] A. Refuse until it is priced (today)
- [ ] B. Sell it at ฿0, as the approved design does

If changed: medium, the "not priced" states on the till, the phone till, the customer display and admin all change.

### k5. Holiday dates after a sale used them

Question: Once a sale has been priced by a holiday range, may a manager still move its dates or remove it?

Today: No. Its name can still be corrected, but its dates are fixed and it cannot be removed. Example: Songkran typed as 12 to 16 April by mistake stays that way after the first sale under it. (apps/api/src/routes/catalog.ts)

- [ ] A. Dates fixed and removal refused (today)
- [ ] B. Dates can be moved and the range removed, as in the approved design; each past sale keeps the holiday name and price it was sold under

If changed: small.

### k8. Refunding the same item a second time

Question: After an item has been refunded once, should "By item" still offer it for a second refund?

Today: No. An item an earlier refund covered drops off the "By item" list and is refused; a second correction on it is done with "Amount". (apps/api/src/services/refunds.ts)

- [ ] A. Hide it once refunded (today)
- [ ] B. Offer every item every time, capped at what is left of the sale, as the approved design does

If changed: small.

### k9. Ticket sale that comes to ฿0

Question: When a ticket sale comes to ฿0, should staff still pick a payment method?

Today: No. The screen shows "No payment needed" and a "Complete Sale" button. Example: a voucher covers the whole ticket and the sale closes with no payment method. (apps/pos/src/components/till/StepPayment.tsx)

- [ ] A. No payment method needed (today)
- [ ] B. Always pick a payment method, as the approved design does
- [ ] C. No method for booth voucher sales only; pick a method for every other ฿0 ticket sale

If changed: small.

### k11. Paid online booking after a tax change

Question: If the tax or service charge set-up changes between an online booking and the visit, should the family still get their bands?

Today: No. If the sale would now come to a different sum than they paid, the counter issues nothing and says to ask a manager, and there is no manager override. Bookings can be made up to 60 days ahead. (apps/api/src/services/booking-redemption.ts)

- [ ] A. Refuse and ask a manager (today)
- [ ] B. Let them in: file the sale at what they paid, with the tax as it was when they booked, and flag the difference for a manager to review
- [ ] C. Let them in and price the sale at today's set-up, as the approved design does

If changed: small.

### k12. How far ahead families book online

Question: How far ahead may families book online?

Today: From today up to 60 days ahead. (apps/pos/src/lib/visitDate.ts, apps/api/src/services/booking-checkout.ts)

- [ ] A. 60 days (today)
- [ ] B. A different number of days (say how many in a note)
- [ ] C. A setting each park chooses for itself

If changed: small for B; small to medium for C, which needs a setting on an admin screen.

### k13. Drop-off walk-in becomes a member

Question: When a family with no membership leaves a child for drop-off or nanny care and gives a phone number, should the till make a member record for them?

Today: Yes. The till finds or makes a member under that phone and saves the children, allergies included, for next time. Example: a mother drops off her son; on the next visit his details come up when her number is typed. (apps/pos/src/pages/Till.tsx)

- [ ] A. Make the member record (today)
- [ ] B. Do not, as the approved design: a family with no membership is not saved, so their child's details are typed again next time

If changed: small.

### k14. Taking someone off the pickup list

Question: May staff take a person off a child's authorised pickup list?

Today: Yes. The pickup sheet has a "Take off the pickup list" button, and that person is then refused at pickup. Nothing is deleted; who removed them is recorded. (apps/pos/src/components/shared/AuthorizedPickupSheet.tsx, apps/api/src/services/release.ts)

- [ ] A. Keep the button (today)
- [ ] B. Remove the button: people can only be added or edited, as in the approved design

If changed: small.

### k15. Board edits to a child's details

Question: When staff correct a child's name, age, allergies or food notes on the drop-off board, should the child's saved record change too?

Today: Yes. The correction also changes the saved child for future visits, and it is logged. Example: staff change a child's allergy from none to peanuts today; on the next visit it already says peanuts. (apps/api/src/services/checkin.ts)

- [ ] A. Change the saved record too (today)
- [ ] B. Change today's stay only, as the approved design does

If changed: small.

### k19. Food menu tile when one size is out

Question: When one flavour or size of a menu item is out of stock, should the whole tile show "Out"?

Today: No. The tile shows "Out" only when every size is out; otherwise it shows "Low" and only the missing size cannot be picked. Example: a Slushie with mango sold out still sells in the other flavours. (apps/pos/src/components/fnb/MenuGrid.tsx)

- [ ] A. "Out" only when every size is out (today)
- [ ] B. Grey out the whole tile as "Out" as soon as one size is out, as the approved design does

If changed: small.

### k22. Saved children on the customer display

Question: On the customer display, may the parent add a new child or remove a saved one themselves?

Today: No. The parent picks from the saved children and checks each name and age; the new child and remove choices only call staff over. The display offers ages up to 17, while the till's own picker stops at 12. Online, by your ruling of 18 November, a family's changes will be saved to their record. (apps/pos/src/components/shared/SavedChildrenReview.tsx)

- [ ] A. Staff add and remove children (today)
- [ ] B. The parent adds and removes children on the display and the till receives them, as in the approved design, with its wording and ages up to 12

If changed: medium.

---

## Part 2. The smaller questions

### m1. "Leave as booked" after a service switch

Question: If staff switch a child between Drop-Off and Nanny on the cart, take payment and then choose "Leave as booked", which service should the child get when checked in later?

Today: The service they were registered with, not the one paid for. Example: registered as Drop-Off, switched to Nanny and the nanny fee paid, then left as booked: checked in later from the board as Drop-Off. "Check in now" already uses the paid service. (apps/api/src/services/checkin.ts, apps/pos/src/pages/Till.tsx)

- [ ] A. The service they were registered with (today)
- [ ] B. The service paid for on the cart

If changed: small.

### m2. "Mark Arrived" on the phone

Question: On the phone's drop-off board, should "Mark Arrived" for a booked child who has already paid check them straight in?

Today: Yes. It opens the check-in straight away, with nanny, consent and photo, and no second payment. (apps/pos/src/components/mobile/dropoff/MobileDropOffBoard.tsx)

- [ ] A. Straight to check-in (today)
- [ ] B. A separate "arrived, not yet checked in" step first

If changed: medium.

### m3. Adult band on a ticket without gate access

Question: Is this the right handling for an adult band on a ticket with Gate access switched off?

Today: The gate reader shows "Band not valid, see reception" and does not open, on the way in and on the way out. The in-park count counts that adult with the children while an adult band from the same sale is inside. Example: a grandparent on such a ticket goes in and out with the family's gate adult. (packages/box-agent/src/gate/decision.ts, apps/api/src/services/occupancy.ts)

- [ ] A. Keep it as it is (today)
- [ ] B. Change it (I will say how in a note)

If changed: small.

### m4. Wording for an expired document

Question: When an Expat member's document has expired, is the button wording "Document expired — re-verify" right?

Today: The member keeps the Expat rate, and the till shows that amber button beside "Expat · verified". A Thai rate confirmed at the till carries no expiry, so in practice this shows for Expat only. (apps/pos/src/components/till/StepCustomerType.tsx)

- [ ] A. Keep the wording (today)
- [ ] B. Change the wording (I will say how in a note)

If changed: small.

### m5. Wording for a prepaid meal held on another order

Question: When two counters try to serve the same prepaid meal, is this message to the second counter right?

Today: The second counter sees, for example: "Mia's prepaid Nuggets is on another order that is still open — finish or cancel that order first." (packages/shared/src/band-food.ts)

- [ ] A. Keep the wording (today)
- [ ] B. Change the wording (I will say how in a note)

If changed: small.

### m6. Refunding an order with a served prepaid meal

Question: If an order with a child's served prepaid meal is refunded, should the meal go back on the child's band?

Today: No. The meal stays used. Checked by search: no refund gives a served meal back. (apps/api/src/services/band-food.ts, apps/api/src/services/refunds.ts)

- [ ] A. The meal stays used (today)
- [ ] B. The meal goes back on the band, to be served again

If changed: small.

### m7. Prepaid meal not served before pickup

Question: If a child is collected before the order with their prepaid meal is paid, should the receipt still list the meal as "settled at pickup"?

Today: No. The meal is not served, its line stays on the sale at ฿0, and it is printed on neither the receipt nor the kitchen ticket. (apps/api/src/services/sale-printing.ts, apps/api/src/services/band-food.ts)

- [ ] A. Leave it off the receipt (today)
- [ ] B. List it on the receipt as "settled at pickup"

If changed: small.

### m8. Food refund at pickup while extra time is unpaid

Question: At pickup, if unused prepaid food is due back but the family's extra time is not yet paid, should the food refund still go ahead?

Today: No. The child is released, the food refund is held back, and staff refund it by hand later. (apps/api/src/services/release.ts, apps/api/src/services/sale-extension-lifecycle.ts)

- [ ] A. Hold it back for staff to refund by hand (today)
- [ ] B. Refund it anyway

If changed: small.

### m9. Food counter offline, child not yet known

Question: With the internet down, should the food counter keep refusing a band for a child its box has not heard of yet, even a paid one?

Today: Yes. A child checked in moments before the connection dropped may be unknown to the counter's box; it refuses food on their band, telling staff the band is not checked in, and serves again once the connection is back. It refuses because it cannot check that child's allergies or food permission. (packages/box-agent/src/checkin-desk.ts)

- [ ] A. Keep refusing until the connection is back (today)
- [ ] B. Change it (I will say how in a note)

If changed: medium.

### m10. Party overpaid after a refused price change

Question: If a party price change made during an outage is refused later, should the party bill show the money owed back to the family?

Today: No. The party balance never shows below ฿0, so money taken at the higher price shows as "Fully paid" with nothing owed back. The balance rule was read in the code; the outage path itself was not traced. (packages/shared/src/events.ts, apps/pos/src/lib/party.ts)

- [ ] A. Show ฿0, "Fully paid" (today)
- [ ] B. Show the credit owed back

If changed: small.

### m11. The party's own payments on End of Day

Question: Should the party's own balance and settlement payments show on End of Day by how they were paid, as additional party bills will?

Today: Every payment taken at the party desk goes on one "Party prepayments" line, never on the cash, card or QR lines, even when paid in cash. By your ruling of 18 November, additional party bills move to the line of how they were paid; this asks only about the rest. (apps/api/src/services/end-of-day.ts)

- [ ] A. Their own "Party prepayments" line (today)
- [ ] B. By how they were paid, cash with cash and QR with QR

If changed: small to medium.

### m12. Party desk with the connection down

Question: When a party charge is waiting for an answer and the connection stays down, should staff have a "leave without confirming" exit?

Today: No. The order stays locked as it was sent, so nothing is billed twice; staff press charge again until it is confirmed, or reload the till. (apps/pos/src/components/parties/usePartyChargeHold.ts)

- [ ] A. Press again or reload (today)
- [ ] B. Add an exit that keeps the waiting charge safe for later

If changed: small to medium.

### m13. Credit spent at another park

Question: When credit bought at one park is spent at another, do either park's records need more than they show today?

Today: Credit can be spent at any park. The selling park keeps the sale and the credit still owed; the spending park's End of Day shows the spend on its own Credit line. Nothing else links the two. Only one park runs on the new till today. (apps/api/src/services/wallet.ts)

- [ ] A. Nothing more (today)
- [ ] B. Add what the parks need to settle between them (I will say how in a note)

If changed: medium.

### m14. Which day party money counts on

Question: On which day should money taken at the till for a party count?

Today: Only when it is taken on the party's own day. Money taken on another day for that party is on no End of Day line and in no day's party revenue. Example: a ฿5,000 cash balance taken on 10 December for a party on 20 December shows on neither day, though the cash is in the drawer on the 10th. (apps/api/src/services/end-of-day.ts, apps/api/src/services/analytics-parties.ts)

- [ ] A. On the party's day, and only if taken that day (today)
- [ ] B. On the day it is taken, whatever the party's date
- [ ] C. On the party's date, whenever it is taken

If changed: medium.

### m15. Card approval code with the internet down

Question: With the internet down, if the card terminal took the money but the till got no answer, may staff type the terminal's approval code to record the sale?

Today: Yes. Staff check the terminal's screen and type the approval code; the sale is recorded on the counter box under that person's name and flagged for End of Day. Reception may do it. (packages/box-agent/src/station-bridge.ts)

- [ ] A. Yes (today)
- [ ] B. No, not while offline

If changed: small.

### m16. Credit spending cap with the internet down

Question: With the internet down, how much credit may one band spend in a day?

Today: ฿300 a day at each counter; above that the counter asks for cash or card. It is a stored setting with no screen to change it. (packages/shared/src/station-bridge.ts, packages/db/src/schema/wallet.ts)

- [ ] A. ฿300 a day (today)
- [ ] B. A different amount (write it in a note)

If changed: small, one stored setting.

### m17. When credit on a band ends

Question: When should credit on a band end?

Today: At the end of the day it was bought, which becomes midnight under your ruling of 18 November. The system can also keep credit for a number of days, or never end it; no screen changes this today. (packages/shared/src/wallet.ts, packages/db/src/schema/wallet.ts)

- [ ] A. At the end of the same day (today)
- [ ] B. After a number of days (say how many in a note)
- [ ] C. Never

If changed: small, one stored setting.

### m18. Different VAT for some kinds of product

Question: Does any park need a different VAT or service charge for some kinds of product, for example food taxed differently from tickets?

Today: No. Every product at a park uses that park's one VAT and service charge rule. A per-category exception exists in the system, but no screen sets it and sales do not use it. (apps/api/src/services/tax.ts, apps/api/src/routes/catalog.ts)

- [ ] A. One rule for everything (today)
- [ ] B. Different rules by category, set on an admin screen and used on every sale

If changed: medium.

### m19. Making a whole order free

Question: Who may make a whole order free of charge?

Today: Anyone who may give discounts, reception included, can pick "Comp (100% off)" for the whole order, with a reason. It is logged; nobody else approves it. The list of 14 October said a manager; the till lets reception do it too. (apps/api/src/routes/sales.ts, packages/shared/src/permissions.ts)

- [ ] A. Reception or a manager, on their own (today)
- [ ] B. Managers only
- [ ] C. A second person approves it first

If changed: small for B; medium for C.

### m20. Ringing up your own staff benefit

Question: May a cashier ring up their own staff benefit purchase at the till they are working?

Today: Yes. They may scan their own benefit on their own order, and both names are recorded. Checked by search: no rule refuses it. (apps/api/src/services/benefit-checkout.ts)

- [ ] A. Yes (today)
- [ ] B. No, another staff member must serve them

If changed: small.

### m21. Discounts during an outage

Question: While the internet is down, should any discount or comp need a second person?

Today: No. Discounts and comps follow the same rules as online, so reception may give them. Refunds and voids cannot be done offline at all. (packages/box-agent/src/station-bridge.ts, packages/shared/src/station-bridge.ts)

- [ ] A. Same as online (today)
- [ ] B. A second person for any discount or comp while offline

If changed: medium.

### m22. Staff benefit amounts

Question: Are these the right staff benefit amounts?

Today: Owner: everything free. Manager: 2 free coffees a day, ฿500 credit a month, 30% off food. Staff: 2 free coffees a day, 30% off food. These are the starting figures, and an administrator can change them at any time on the Staff Benefits screen. What production holds now was not read. (packages/db/src/seed/benefits.ts, apps/console/src/pages/StaffBenefits.tsx)

- [ ] A. Keep them (today)
- [ ] B. Change them (write the amounts in a note)

If changed: nothing to build; an administrator changes them.

### m23. Where staff benefits can be used

Question: Should staff benefits also be accepted at the ticket till?

Today: No. A benefit can be scanned at the food counters only, and any other counter refuses it. (apps/api/src/services/benefit-checkout.ts, apps/pos/src/pages/OrderStation.tsx)

- [ ] A. Food counters only (today)
- [ ] B. Food counters and the ticket till

If changed: medium.

---

## Settled by the rulings of 18 November

- Party cash on its own End of Day line, apart from cash sales (ticket comment of 7 October): settled for additional party bills, which get their own receipt and show by how they were paid, cash with cash and QR with QR. Only the party's own balance and settlement payments are left, asked as m11.

## Not his to choose

- Reducing stock at a named place that never held that size (ticket comment of 6 October): no screen names a place when adjusting stock; the admin Adjust always starts at the sell point (packages/admin-screens/src/lifted/components/admin/inventory/InventoryPanel.tsx). If a place is ever named, the stock service takes the units from the other places, not nothing as the list of 18 November says (apps/api/src/services/stock.ts).
- The note inside the ticket pricing code that misdescribes the approved design (point 2): a wording fix in the code, nothing staff see.
- Retiring the unused per-category tax option if m18 stays as today: housekeeping in the code.
- How the party desk keeps a waiting charge from being billed twice (m12): engineering; only the exit is his.
- Where a spend at another park is filed (spend at the spending park, live balance at the selling park, m13): already how the records work; only the report question is his.

Already settled before 18 November and not asked again: Add time offers picking bands or a count only (SCRUM-797); care time stays separate from extra play time; only a full refund cancels extra time; with the internet down only a child's assigned food counter serves their prepaid meals.
