# Till details for the owner to confirm (SCRUM-497), brought up to date

Read on 18 November 2026 against the code on `main` (87218a090), the
register beside this file, `docs/progress/OPEN_ITEMS.md`,
`docs/progress/decisions/OWNER_QUESTIONS_2026-10-14.md` and the ticket's
comments. The owner asked for the list that day; the open points are on his
decisions page as choices. Until he chooses, the till keeps what it does
today.

**Count.** Of the 26 points on the ticket's list of 6 October: 9 are still
the owner's to choose, 1 is asked under SCRUM-482, 12 kept the recorded
behaviour on 14 October without an answer from the owner
(`docs/progress/OPEN_ITEMS.md`, the consistency entries), 1 was closed by a
project ruling of 14 October, and 3 by later work.

Two things to keep in mind when reading older notes:

- The 12 points that "keep the recorded platform behaviour" were closed by
  the project's own default, not by an owner ruling. They can be reopened; the
  owner is asked on his page whether he wants to see them.
- No owner answers are recorded for the question list of 14 October.

## A. The 26 points

| No. | Point | Where it stands | What the till does today (file) |
| --- | --- | --- | --- |
| 1 | Promo code for one part of the order | Kept, 14 Oct | A tickets-only code takes at most what is left of the tickets (`packages/shared/src/cart-totals.ts`) |
| 2 | Ticket with no price for a tier | Kept, 14 Oct | Refused (`apps/api/src/services/sale.ts`) |
| 3 | Prices and promo dates: 05:00 or midnight | **Open** | The 05:00 business day (`packages/shared/src/pricing-mode.ts`, `promo.ts`). Held sales are voided at calendar midnight by the owner's ruling of 4 November |
| 4 | Ending a member's verified tier | **Open** | Managers only (`apps/api/src/routes/members.ts`) |
| 5 | Holiday range already used by a sale | Kept, 14 Oct | Dates locked, removal refused (`apps/api/src/routes/catalog.ts`) |
| 6 | Refunds | **Open** | Reception opens a refund; it needs a manager's approval (`apps/api/src/routes/sales.ts`) |
| 7 | Card refunds, partial or after the cancel window | **Open**; also waits on what the terminals support | Only a whole, never-refunded card payment is cancelled on the terminal; otherwise cash (`packages/shared/src/refund.ts`) |
| 8 | Second "By item" refund | Kept, 14 Oct | Refunded lines hidden and refused (`apps/api/src/services/refunds.ts`) |
| 9 | ฿0 ticket sale | Kept, 14 Oct | Completes with no payment method (`apps/pos/src/components/till/StepPayment.tsx`) |
| 10 | Online booking for a returning member | Loading built (SCRUM-357); **saving back is open** | Saved children and contact preference fill the form after an SMS code; nothing typed online is saved to the member (`apps/pos/src/pages/Book.tsx`, `apps/api/src/routes/public.ts`) |
| 11 | Redeeming a paid booking after a tax change | Kept, 14 Oct | Refused, ask a manager (`apps/api/src/services/booking-redemption.ts`) |
| 12 | How far ahead families book online | Kept, 14 Oct | Up to 60 days (`apps/pos/src/lib/visitDate.ts`) |
| 13 | Drop-off walk-in with a phone number | Kept, 14 Oct | A member record is made (`apps/pos/src/pages/Till.tsx`) |
| 14 | Authorised pickup list | Kept, 14 Oct | A person can be removed (`apps/pos/src/components/shared/AuthorizedPickupSheet.tsx`) |
| 15 | Board edits to a child | Kept, 14 Oct | They also change the saved child, logged (`apps/api/src/services/checkin.ts`) |
| 16 | Credit vouchers | Asked under SCRUM-482 | Any reception account can issue (`apps/api/src/routes/vouchers.ts`) |
| 17 | Stock permissions | **Open**, never put to the owner | Reception counts, moves, receives; floor staff look; managers order (`packages/shared/src/permissions.ts`) |
| 18 | A place's first stock count | Closed by a project ruling, 14 Oct | The first count of each storage place is its opening and is not flagged (`apps/api/src/services/stock.ts`). The prototype's count screen flags every row that differs by more than 3 and has no opening; the ruling stands, its stated reason does not |
| 19 | F&B tile with one size out | Kept, 14 Oct | "Out" only when every size is out (`apps/pos/src/components/fnb/MenuGrid.tsx`) |
| 20 | Which store a sale takes from first | **Open**, never put to the owner | Sell point, back of house, store room (`packages/shared/src/stock.ts`) |
| 21 | Shrinkage report | **Open**, never put to the owner | Count shortfalls plus hand write-downs; upward corrections ignored (`apps/api/src/services/stock.ts`) |
| 22 | Customer display, saved children | Kept, 14 Oct | The parent cannot add or remove children (`apps/pos/src/components/shared/SavedChildrenReview.tsx`) |
| 23 | Closing the day away from a counter with a box | Closed by the build, 6 Oct | Anyone allowed to close can; the receipt prints later (`apps/api/src/services/end-of-day.ts`) |
| 24 | Sales after the day is closed, before 05:00 | **Open**; the flow is SCRUM-513 | Dated to the closed day, on no End of Day, no warning (`apps/api/src/services/sale.ts`) |
| 25 | "Add demo sales" on the staging Health page | Closed by the build, 7 Oct | Always adds to the demo branch (`apps/api/src/routes/ops.ts`) |
| 26 | Lucky Wheel prize codes | No choice needed; set up by the owner, SCRUM-499 Deployed | A fixed code, or a separate QR field (`apps/console/src/components/booth/VoucherTypeEditor.tsx`) |

## B. The nine open points as asked

3. When the park's day changes for prices and promotions: 05:00 (today) or
   midnight.
4. Who may remove a family's saved local rate: managers only (today) or any
   reception staff.
6. Refunds: a manager must approve (today), any signed-in staff, or reception
   with a manager signing on the spot (needs building).
7. Card refunds that can no longer be cancelled on the terminal: cash from
   the drawer (today) or back to the card where the terminal allows.
10. A returning family's changes online: for that booking only (today) or
    saved to the family record.
17. Stock work: reception does it and managers order (today); floor staff
    too with managers ordering; or everyone, with reception ordering.
20. The store a sale takes from first: back of house then store room (today),
    or the other way round.
21. The loss report: shortfalls and write-downs (today), or opening plus
    received, minus sold, minus closing.
24. A sale after the day is closed: leave it (today), warn staff, move it to
    the next day, or a manager accepts it into the closed day (SCRUM-513).

## C. Further detail questions with no answer yet

From the ticket's comments (today's behaviour is the default each comment
states; "verified" where it was read in code on 18 November):

- A child paid for at the till but checked in with "Leave as booked": the
  cart line's service or the registered one (today: registered).
- On the phone, "Mark Arrived" for a booked, paid child: straight to check-in
  (today) or a separate arrived step.
- An adult band on a ticket without gate access shows "Band not valid, see
  reception" (verified, `packages/box-agent/src/gate/decision.ts`), is counted
  as a child following its group's gate adult, and is refused on the way out.
- The wording "Document expired — re-verify" (verified); since SCRUM-772 it
  applies to Expat only.
- The wording when two counters hold the same prepaid meal in open orders.
- A served prepaid meal later refunded: does the meal go back on the band.
- A prepaid meal unpaid at pickup: listed on the receipt as "settled at
  pickup" or kept off it (today: off; the sale line is kept at ฿0, verified in
  `apps/api/src/services/band-food.ts`).
- At pickup, a refund of unused prepaid food while an extra-time charge is
  unpaid: held back and done by hand (today), or go ahead.
- A manager reduces stock at a place that never held that size: nothing
  (today) or take it from the other places.
- With the internet down, the food counter's box refuses a band for a child
  it has not heard of, even a paid one.
- A party price change made offline and refused later: show the overpaid
  credit owed back (today: a zero balance).
- Party cash has its own End of Day line, apart from cash sales (verified,
  `apps/api/src/services/end-of-day.ts`).
- At the party desk with the connection down while a charge waits: a "leave
  without confirming" exit (today: reload and retry).
- Credit bought at one park and spent at another: whether either park's
  records need more.

From the list of 14 October, outside the 26: which day a party's money counts
on; offline approval codes and the offline spending cap; different VAT by
product category; whether a full comp needs a second approver; whether a
cashier may ring up their own staff purchase; whether discounts during an
outage need a second person; staff benefit amounts and where they can be
used.

Already settled, for completeness: Add time offers picking bands and a
count-only option (the owner, 6 October; built under SCRUM-797); care time
stays separate from extra play time; only a full refund cancels extra time;
with the internet down only a child's assigned food counter serves their
prepaid meals.
