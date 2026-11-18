# A paid birthday deposit shows on the chat (SCRUM-996)

**State, 19 November 2026: built with the owner's six answers (section 7).**
On 18 November 2026 the owner ticked 1(c) with the label, 2(b), 3(b), 4(b),
5(a) and 6(b).

Asked for by the owner on 18 November 2026 in his review of SCRUM-987 (a
birthday booking needs a gateway-confirmed deposit): "keep it but add some
notification or label that will highlight the chats or bring them up when a
deposit is paid so staff is notified and can review and book the date."

The booking rule of SCRUM-987 stays: a booking is made only when a person
presses Book date after the full deposit is confirmed. This adds the missing
signal to staff.

## 1. What happens today (read from the code on 18 November)

When the gateway confirms a pre-booking deposit:

- The payment attempt is marked approved and one `payment.settled` audit row
  is written (`apps/api/src/services/payments/gateway.ts`, `settlePaidAttempt`
  / `settleWithin`). The two handlers asked afterwards (a ticket booking, an
  after-booking party deposit) both answer "not mine" for this kind.
- Nothing else: no line in the thread, no message to the family, no bell, no
  change to the conversation (last-message time, preview, status) and none to
  the draft. The thread keeps only the "Deposit requested" line from when the
  link was sent (`apps/api/src/services/inbox/prebooking.ts`).
- In the list nothing changes. The next-action label of SCRUM-992 most likely
  still reads "AI sent · waiting for customer", because that label looks only
  at messages (`packages/shared/src/inbox.ts`, `inboxNextAction`): the list
  tells staff to wait exactly when they should act.
- The paid state is visible only after somebody opens the Book Date dialog
  (`apps/inbox/src/components/BookDateDialog.tsx`).

For comparison, the after-booking deposit of SCRUM-825 already does more when
it is paid: a "received" line to the family, a `deposit_paid` line in the
thread (which moves the chat to the top, because the list is ordered by last
activity) and the HR app bell of the park's birthday manager
(`apps/api/src/services/party-deposit.ts`).

Also found: the pre-booking payment reuses the after-booking deposit's return
page, which tells the family "You will get a message in the chat as soon as it
is in" (`apps/api/src/routes/public.ts`). For a pre-booking deposit no such
message is sent. It is choice 6 below.

Other facts the build rests on:

- The list is ordered newest activity first with no pinned group
  (`apps/api/src/services/inbox/read.ts`); SCRUM-992 kept that order on
  purpose.
- The Inbox re-reads the list every 30 seconds while its tab is visible
  (3 seconds on test lines). It has no sound, browser notice or badge.
- "Paid" is already decided in one place, `view()` in
  `apps/api/src/services/inbox/prebooking.ts`: an open draft, exactly one
  eligible gateway-settled receipt of the exact amount, no refund or reversal.
  A part payment, a wrong amount or a payment after the link ran out is never
  "paid": it goes to staff confirmation with a Console alert.
- "Paid" ends when Book Date succeeds, when the receipt is refunded or
  reversed, or when the chat is archived. A draft cannot be cancelled today.
  When the party date has passed, the draft stays paid and Book Date refuses
  it for staff to resolve.
- Reading the deposit state already needs booking authority
  (`authorizePrebooking`): the birthdays team at the chat's team, or the
  assign right. Category and channel limits (SCRUM-993) are part of every list
  read, so a label read inside the list inherits them.

## 2. The smallest build

What staff see:

- A label on the chat's row in the list: **"Deposit paid · book the date"**,
  or **"Deposit paid · date passed, needs staff"**. It stands beside the
  SCRUM-992 label and is read out by screen readers.
- A line beside Book Date in the chat: "Deposit ฿X paid and gateway verified
  at <time>. Check capacity, then Book Date." Pressing it opens the existing
  dialog. A simulator payment is named as one.

When: on the next list refresh after the confirmation (30 seconds or less on
an open Inbox). It goes when the date is booked, the receipt is refunded or
reversed, or the chat is archived.

Stored: nothing new, no migration. One cheap per-row check beside the
SCRUM-992 columns finds chats with an open draft and an approved attempt; for
those few rows the existing `view()` rule decides. The money rule is not
copied and the payment code is not changed (with the smallest choices).

Files: `apps/api/src/services/inbox/prebooking.ts` (a small helper on
`view()`), `next-action.ts` or a file beside it (the check), `read.ts` (the
field on the row and the detail), `apps/api/src/routes/inbox-read.ts`,
`packages/shared/src/inbox.ts` (an optional field), the generated api types;
`apps/inbox/src/lib/list-state.ts`, `components/ConversationList.tsx`,
`components/ChatPanel.tsx`.

Tests: an api file on the fixtures of `apps/api/test/prebooking-review.test.ts`
(no label while unpaid; label after a simulator payment for a birthdays-team
member and for an assign holder; none for a person who sees the chat but
cannot book; a restricted viewer does not get the row; gone after Book Date
and not back on a replay; gone after a refund; no "paid" label for a part or
late payment; the date-passed wording; order and next-action unchanged), and
an Inbox file beside `apps/inbox/test/list-state-992.test.ts`.

## 3. Staging proof

Simulator only, on a ZZ TEST chat, following
`docs/progress/plans/tom-feedback-20261116/deposit-staging-proof.md`: the row
with no label after a ฿1 request; the label and the line after the simulator
payment, as a birthdays-team account; no label as a person who cannot book;
the label gone after Book Date. Then the test event and chat archived, the
payment history kept.

## 4. Choices with the owner (the smallest is the default until he answers)

1. **The paid chat's place in the list.** (a) Label only, the chat stays where
   it is. (b) Label plus a "Deposit paid" line in the chat, as the
   after-booking deposit already writes, which lifts the chat to the top.
   (c) Label plus a "Ready to book" group pinned at the top. His words
   ("highlight the chats or bring them up") point at (b); (b) and (c) add
   about half a day.
2. **Telling someone outside the Inbox.** (a) No. (b) Also the HR app bell of
   the park's named birthday manager, as the after-booking deposit does: one
   person per park, and tapping the bell does not open the chat today.
3. **Who sees the label.** (a) Only people who may book the date, which is
   today's rule for seeing the deposit. (b) Everyone who sees the chat.
4. **A payment that went wrong** (part-paid, wrong amount, paid after the link
   ran out). (a) No label; it stays a Console alert and a note inside Book
   Date. (b) Also "Deposit needs checking" on the chat.
5. **A chat already marked Handled.** (a) It stays in Handled with the label.
   (b) It is opened again, as a customer message does.
6. **A message to the family.** (a) None, as today. (b) A "deposit received"
   line in the chat, as the payment page already promises and the
   after-booking deposit already sends.

Choices 1(b), 2(b), 5(b) and 6(b) add a step that runs straight after the
payment is saved; such a step can never undo the payment.

## 5. Not part of this

Booking by itself, any change to the deposit rule, sound or browser notices
(none exist in the Inbox), reminders when nobody books.

## 6. Size

About two days with the smallest choices (build, tests, staging proof). Each
larger choice adds a quarter to half a day; a bell that opens the chat adds
about a day in the HR app.

## 7. As built (19 November 2026)

- Row label for everyone the list already shows the chat to: "Deposit paid ·
  book the date", "Deposit paid · date passed, needs staff" or "Deposit needs
  checking" (`depositSignal`, words only), in the row's spoken label too.
  "Paid" is `view()`'s paid (`standingOf` in `prebooking.ts`); "needs
  checking" is money on the draft that does not count and was not given back
  (flagged by the gateway, recorded by a person, or a second payment).
- The next action reads "Staff action needed" while a deposit is to book or
  to check, in place of any "wait" state; "Staff reply needed" and Handled
  stay as they are.
- "Ready to book": the first page carries the tab's paid chats (same filters)
  in last-activity order; the Inbox pins them above the list. Not "needs
  checking". A chat Handled before the money stays Handled, with the label,
  in the Handled tab's group.
- After the settlement commits (`settlePaidAttempt`), only from the
  settlement that approved the attempt: the family's `party_deposit_received`
  line with its `deposit_paid` pill, then the park's birthday manager's bell
  (`inbox.prebooking.notify` audit). Never throws; the line's id is derived
  from the attempt, the bell rings with the line posted now.
- Beside Book Date, for people who may book: "Deposit ฿X paid and gateway
  verified at <time>. Check capacity, then Book Date." (a simulator payment
  says so first); it opens the dialog.
- No migration. Tests: `apps/api/test/prebooking-notice-996-review.test.ts`,
  `apps/inbox/test/deposit-notice-996.test.ts`,
  `packages/shared/test/inbox-next-action.test.ts`.

Found while building, kept as built (owner questions, not changed):

- The family's own lines name the amount to everyone who sees the chat, the
  row's preview included: the request line since SCRUM-987, now the received
  line. The label itself carries none.
- The reused received line says "your party on <date> is confirmed" when the
  money is verified, as the request line promises ("Your booking is confirmed
  as soon as the deposit arrives"), while the calendar booking waits for
  Book Date. Pinned as an `it.fails` FINDING in the review test; a
  pre-booking wording would be a new template key in three languages.
