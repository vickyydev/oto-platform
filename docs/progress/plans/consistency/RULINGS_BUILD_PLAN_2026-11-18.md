# Five rulings of 18 November: what to build

**State, 18 November 2026: planned, nothing built.** The owner ruled on his
decisions page on 18 November. This file turns the five rulings that change
what the system does into build specs. Each build waits for his tick on the
numbered decisions below; the owner-review halt stands until then.

Read on 18 November against `main` at d751e2b10 (checkout
`C:/oto-lanes/tom-feedback-coordination-20261116`), with
`TILL_DETAILS_2026-11-18.md` and `REGISTER.md` beside this file. Nothing was
changed, run or deployed to write it.

The tickets: SCRUM-482 (Rulings needed: who may issue credit vouchers, and
what the promotions report counts) carries A and B. SCRUM-497 (Till details
for the owner to confirm) carries C (its point 10), D (point 7) and E
(point 21).

Not planned, by his ruling: a refunded sale's voucher keeps counting as given
away in the promotions report. Nothing changes there.

Sizes: S is about a day, M two to three days, L about a week, each with its
tests, the staging proof and the notes.

---

## A. Credit vouchers: a manager issues them; reception asks and a manager approves (SCRUM-482)

### Today

- **What a credit voucher is in the data.** A voucher type with kind
  `wallet_credit` (`VOUCHER_KINDS` in `packages/db/src/schema/promo.ts`;
  the amount in `value_satang`). The other kinds are `discount`, `free_item`,
  `free_ticket` and `manual` (a hand-over prize). Nothing else in the data
  model is a credit voucher. It is rung up as a ฿0 sale; when that sale
  closes, a new wallet is made with the amount as a grant from source
  `promo_voucher` (`consumeSaleVouchers` in `apps/api/src/services/vouchers.ts`,
  `loadWalletFromVoucher` in `apps/api/src/services/wallet.ts`). The till then
  offers "Print credit voucher" with the wallet's QR (`VoucherCreditLoaded` in
  `apps/pos/src/components/till/RedeemVoucher.tsx`).
- **Issuing at the till.** "Issue a voucher…" sits under Redeem voucher in the
  till's order panel, shown to anyone holding `pos:print:voucher`
  (`apps/pos/src/pages/Till.tsx`; `IssueVoucherEntry` in `RedeemVoucher.tsx`).
  The picker lists every switched-on type whose promotion has not ended,
  credit types included, except a type the park sells (the Golden Ticket of
  SCRUM-798, Golden Ticket: sell a 1,500 gift voucher and redeem it as a
  full-day entry for one child) (`GET /vouchers/issuable`,
  `issuableDefinitionsAt` in `apps/api/src/services/voucher-promotions.ts`).
  "Issue & print" calls `POST /vouchers/issue` (`apps/api/src/routes/vouchers.ts`),
  which checks only `pos:print:voucher` at the till's branch. That permission
  is in the counter bundle `SELL`, so reception and branch managers hold it
  alike (`packages/shared/src/permissions.ts`). The service refuses a
  switched-off type, an ended promotion, a type sold as an item, and a type
  whose usage limit is used up. Otherwise it mints a code, records the voucher
  as source `manual` issued by the person at the till, writes one
  `voucher.issue` audit row (the code's last four only) and queues the slip on
  the till's receipt printer (`issueVoucherAtTill`). Online only.
- **Two side doors with the same effect.**
  1. A credit type with a fixed code (SCRUM-499, Lucky Wheel: voucher types
     with a fixed code). Typing the shared code at any till mints a voucher on
     the spot (source `fixed`, issued by the person typing) and the credit
     loads when that sale closes (`fixedCodeDefinition` and
     `fixedRedemptionRow` in `vouchers.ts`). Nothing stops a credit type from
     carrying a fixed code (`apps/api/src/services/voucher-definitions.ts`).
  2. A Lucky Wheel prize may point at a credit type; the booth then issues it
     with nobody signed in. `apps/api/src/services/booth-admin.ts` checks only
     that the type exists and is switched on. Prizes, types and campaign
     batches all need `admin:booth:manage`, which only operator
     administrators hold, so these two are a manager's set-up, not a
     receptionist's press.
- **Seen, not changed.** `pos:wallet:grant` ("Grant credit to a member's
  wallet") is in the reception bundle, but no route uses it: there is no hand
  grant of credit. The Console's voucher type editor does not offer the credit
  kind, and a credit type made through the API shows there as "No till redeems
  one yet", which is no longer true (`apps/console/src/components/booth/voucherTypes.ts`,
  `VoucherTypeEditor.tsx`).
- **Tests that pin today.** `apps/api/test/vouchers-r5-promotions.test.ts`
  ("printed at the till … issued by the person", with the reception account),
  `apps/api/test/vouchers-r5-gate.test.ts` (a credit voucher raced, replayed,
  reported), `apps/pos/test/vouchers-r5-surfaces.test.ts`.

### Is there already a "request, then a manager approves" mechanism?

Not on the till. What exists:

1. **Refunds** (`POST /sales/:id/refunds` in `apps/api/src/routes/sales.ts`;
   `apps/api/src/services/refunds.ts`; the History screen,
   `apps/pos/src/components/history/SaleDetail.tsx` and `RefundModal.tsx`,
   SCRUM-208, S2-11 Sale printing and signed bands, History tab with refunds,
   voids and reprints). There is no request and no queue. Reception sees
   Refund, fills the dialog and is refused `REFUND_APPROVAL_REQUIRED` ("A
   refund needs a manager's approval", then "ask a manager to make it")
   unless the signed-in account holds `pos:refund:approve`. A manager has to
   take over the till ("Sign out and hand over the till" on
   `apps/pos/src/components/auth/LockScreen.tsx`) and press it; the refund row
   keeps the approver. Offline, the till writes a "refund requested" note in
   that browser only (`apps/pos/src/lib/refundRequests.ts`); nothing reaches
   the platform or a manager.
2. **End of Day paid-out** (`recordMovement` in
   `apps/api/src/services/end-of-day.ts`). The person recording picks a second
   person from the list of people holding `pos:cash:approve` at the branch;
   picking oneself is refused. The named approver proves nothing: no password,
   no tap.
3. **Super admin dual control** (`apps/api/src/services/suite-control-approvals.ts`,
   SCRUM-648, P5-6 Support tools: cross-app lookup, the one-action trace,
   audited impersonation). The only real request, approve and use flow in the
   platform: a request is `pending`, a second administrator approves it
   (never the one who asked), the asker uses it once, and it lapses after 10
   minutes. Platform administrators only, for the kill switch and write
   impersonation.
4. **A waiting slot already on the Console.** The Overview's decisions list
   has "Approval requests awaiting action", shown today as "The
   approval-request queue is not built yet."
   (`apps/api/src/services/console-decisions.ts`,
   `apps/console/src/pages/Overview.tsx`).
5. **How a manager is told today.** Alerts reach the Console only
   (`apps/api/src/services/alert-routing.ts`). The one push to a person is the
   OTO App (HR app) bell, rung for the park's named birthday manager when a
   party deposit is paid (`ringBirthdayManager` in
   `apps/api/src/services/party-deposit.ts`, the door of SCRUM-823, In
   Birthdays & Events, advice and choice questions go to a person at once, who
   is notified). The till has no notice, no PIN and no countersign: a second
   person cannot prove themselves on a till without signing the first out.

**Which fits best.** For a manager standing at the counter: the refund rule
(the manager must be at the till), but without signing reception out. That
is a countersign box: the manager types their own phone and password on the
receptionist's till, checked like a sign-in and throttled the same way
(`findAccountByPhone`, `throttleCheck` and `throttleFail` in
`apps/api/src/services/auth.ts`). It is new, but small, and the same box
would also serve the refund choice "reception, with a manager signing on the
spot" (point 6) if he ever picks it. For a request that can wait: copy the
shape of the SCRUM-648 dual control (pending, approved, used or lapsed, never
the asker) in a small table of its own, and show it in the Console's
existing "Approval requests awaiting action" slot.

### What he asked for

He ticked "Managers only" and wrote: "Staff should be able to request
permission from manager and manager has some way to approve it."

My reading: only a manager can issue a credit voucher. Reception keeps the
button, but for a credit voucher it asks a manager, and the slip prints only
once a manager says yes. A manager issues one directly.

### The smallest build that does it

**The part every choice needs (S):**

- A new permission, `pos:voucher:issue_credit`, in the `branch_manager`
  bundle (operator and platform administrators get it through `ALL`); not in
  `reception` or `staff`. Its words in `packages/shared/src/permission-words.ts`.
  It reaches staging on the next deploy, because the deploy's platform sync
  rewrites the system roles (`platformSync` in `packages/db/src/seed/index.ts`).
- `POST /vouchers/issue` refuses a credit type to an account without it:
  403 `VOUCHER_CREDIT_NEEDS_MANAGER`, "A credit voucher needs a manager's
  approval." Every other kind works as today.
- `GET /vouchers/issuable` marks credit types `needsManager: true` for such
  an account, and the picker names them "(needs a manager)".
- The side door closes: a credit type cannot be saved with a fixed code, and a
  fixed code of a credit type already saved is refused at the till to an
  account without the permission, in the same words.
- The approver is stored: a new nullable column
  `promo.voucher.approved_by_account_id` (one migration), in the audit row,
  and in the Console's voucher ledger beside "Issued by"
  (`apps/api/src/services/voucher-ledger.ts`, `apps/console/src/pages/Vouchers.tsx`).

**Then the way the manager approves (decision 1):**

- **On the spot (M).** Choosing a credit type opens "Needs a manager" with
  two fields, the manager's phone and password, and "Approve and print". The
  till sends them with the issue. The platform checks: an active account not
  forced to change its password, the right password (throttled per phone as
  sign-in is), the new permission at this branch, and not the same person as
  the one at the till. Nobody else is signed in; the receptionist stays on the
  till. The slip prints as today; the ledger reads "Ana, approved by Ben".
- **The request waits (L).** Choosing a credit type shows "Ask a manager"
  with an optional note. The till then shows "Waiting for a manager" with
  Cancel, and reads the request again every few seconds. The manager sees the
  count in the Console Overview's "Approval requests awaiting action" and a
  list with Approve and Decline (a reason is asked on Decline). On Approve the
  platform issues the voucher as the receptionist's, approved by the manager,
  and queues the slip on the asking till's printer; that till shows
  "Approved by Ben, printing". Stored in a new table
  `promo.voucher_issue_request` (state pending, approved, declined, cancelled
  or lapsed; who asked, at which till, for which type and member, who decided,
  when). New routes: ask, read one's own, list for the branch, approve,
  decline, cancel. Lapse per decision 2; the bell per decision 3.
- **Both (L, about a day more than the wait alone).**

**Files to touch.** `packages/shared/src/permissions.ts`,
`packages/shared/src/permission-words.ts`, `packages/shared/src/voucher-promo.ts`
(the issue body and answer), `apps/api/src/routes/vouchers.ts`,
`apps/api/src/services/voucher-promotions.ts`, `apps/api/src/services/vouchers.ts`
(the fixed-code door), `apps/api/src/services/voucher-definitions.ts`,
`apps/api/src/services/voucher-ledger.ts`, a migration in `packages/db`,
`apps/pos/src/components/till/RedeemVoucher.tsx`, `apps/pos/src/api/vouchers.ts`,
`apps/console/src/pages/Vouchers.tsx`; for the waiting request also
`apps/api/src/services/console-decisions.ts`, `apps/console/src/pages/Overview.tsx`
and a new Console list. OpenAPI regenerated (`packages/api-types`).

**Checks to add.** API: reception refused a credit type and still issues a
discount; a manager issues alone (or per decision 4); the countersign with a
right and a wrong password, the asker as approver, an approver without the
permission, the throttle; a fixed-code credit type refused at save and at the
till; for the waiting request: ask, approve, decline, cancel, lapse, a second
approve, approve after cancel, a replayed press; the approver on the ledger.
The existing reception issue test moves to a discount type and gains a credit
case. Till: the picker label and the dialog. New routes added to the route
lists in `apps/api/test/routes-guarded.test.ts` and
`apps/api/test/route-write-conformance.test.ts`.

**Staging proof.** Deploy oto-api-staging and the two tills (oto-pos-staging,
oto-pos-web-staging), and oto-console-staging for the waiting request. A
ZZ TEST ฿1 credit type with a usage limit of 1, made through the API (the
Console editor does not offer the kind). As the seeded reception account on
Reception Till 1: the picker says "needs a manager"; issuing without approval
is refused; with a manager's approval the slip is queued; the ledger and the
audit row carry both names. Screenshots of each step.

**Size.** The common part S, plus M on the spot, or L for the waiting request.

### Still his to choose

1. **Where does the manager approve?** A: at the same till, on the spot (the
   manager types their own phone and password). B: from their own screen
   later; the request waits in a Console list. C: both.
2. **If a request can wait, when does it lapse?** A: at the end of the park's
   trading day (05:00). B: after 30 minutes. C: never; it waits until someone
   approves, declines or cancels it.
3. **If a request can wait, how does the manager hear of it?** A: the Console
   list only; managers look. B: also the HR app bell of one manager the park
   names, as the birthday deposits do today.
4. **A manager issuing a credit voucher themself:** A: alone, nobody else
   needed. B: a second manager approves it too.
5. **Which vouchers need a manager at the till?** A: credit vouchers only
   (kind `wallet_credit`). B: every voucher issued at the till.

---

## B. Lucky Wheel vouchers get their own line in the promotions report (SCRUM-482)

### Today

- **The report.** Console, Reports, "Wallet & promo", card
  `Promotional vouchers — foregone revenue`
  (`packages/admin-screens/src/lifted/components/admin/reports/WalletPromoReportPanel.tsx`,
  mounted at `/reports/wallet-promo` by `apps/console/src/pages/Reports.tsx`).
  It reads `GET /vouchers/promotions/report` (needs `analytics:read`), built
  by `promoVoucherReportOf` in `apps/api/src/services/voucher-promotions.ts`:
  one row per voucher type with redemptions, foregone revenue (each voucher's
  own discount row on its sale) and credit loaded, and one total; a CSV with
  the same columns. Rows are grouped by type only, whoever issued the voucher:
  a type won at the booth and also issued at a till is one row, and the total
  mixes everything. That is what "counted together" means.
- **Elsewhere.** Voucher discounts also sit inside "Promo codes" in the
  Discounts & Comps report ("Promo impact by type"), because they are `promo`
  discount rows; that report reads the daily discount summary, which has no
  voucher mark (`discountReportOf` in `apps/api/src/services/analytics-reports.ts`).
  The Console's Booth report already counts wheel vouchers issued and
  redeemed per booth and prize, and the prize cost, but not the money not
  charged (`apps/api/src/services/analytics-booth.ts`).
- **How a Lucky Wheel voucher is told apart.** `promo.voucher.source` is
  `booth`, and its spin names it (`booth.spin.voucher_id`). The voucher ledger
  already sorts by this (place booth, counter or import,
  `apps/api/src/services/voucher-ledger.ts`). Two catches:
  1. A fixed-code wheel prize (SCRUM-499; the codes the owner set up himself,
     point 26) prints the shared code. Redeeming it at a till mints a new
     voucher with source `fixed`, not linked to any spin. It is still a wheel
     voucher, and its type says so: a wheel prize names its type
     (`booth.booth_prize.voucher_definition_id`; `VoucherTypeEditor.tsx` is
     where those types are set up).
  2. A slip printed with the old system's QR (`legacy_qr_payload`) is
     redeemed in the park's existing till, not ours, so it can never reach this
     report. The old system's imported codes (source `legacy`, Radar's ledger
     and older campaign QRs) are redeemed on our till.
- **Tests that pin today.** `apps/api/test/vouchers-r5-promotions.test.ts`
  ("foregone revenue is its own line …"), `apps/api/test/vouchers-r5-gate.test.ts`
  ("report: …"), `apps/console/test/reports-api.test.ts`,
  `apps/console/e2e/reports.spec.ts`, `packages/admin-screens/test/wallet-report-ports.test.ts`.

### What he asked for

He ticked "Yes, their own line". My reading: in that report, the wheel's
vouchers are shown apart from the vouchers issued at a till or by a campaign,
with their own redemptions and their own money not charged.

### The smallest build that does it

- **What staff see.** The card gets two lines with their totals, "Lucky
  Wheel" and "Other vouchers", each with its types beneath it as today. The
  card's total stays the sum of both. The CSV gains an "Origin" column.
- **What is stored.** Nothing new. Each redeemed voucher is given an origin
  when the report is read: Lucky Wheel when its source is `booth`, or `fixed`
  and its type is a wheel prize's (plus the imported codes if decision 6 is
  B); otherwise "other". Rows group by origin, then type.
- **Files to touch.** `apps/api/src/services/voucher-promotions.ts`
  (`promoVoucherReportOf`), `packages/shared/src/voucher-promo.ts`
  (`PromoVoucherReportSchema`: `origin` on each row, a per-origin summary),
  `WalletPromoReportPanel.tsx`, OpenAPI regenerated (`packages/api-types`).
- **Checks to add.** An API test with a booth voucher, a fixed-code wheel
  voucher and a till-issued voucher of the same type: two lines, and the two
  totals add up to today's single total. The admin-screens test for the two
  lines; the Console end-to-end marker.
- **Staging proof.** On staging, one spin of the staging booth (ZZ TEST) and
  its slip redeemed at Reception Till 1; one voucher issued and redeemed at
  the till; the Console's Wallet & promo shows both lines. Screenshot.
- **Size.** S. With decision 7 B, M: the daily discount summary needs a
  voucher origin, which is a change to the analytics rollup and a re-roll of
  past days.

### Still his to choose

6. **Which vouchers count as Lucky Wheel?** A: the booth's spins, including
   the fixed-code wheel prizes. B: those, and the old system's imported codes
   as a separate "Lucky Wheel (old system)" line.
7. **Where does the line show?** A: in the Wallet & promo voucher card only.
   B: also in Discounts & Comps, where "Promo codes" would split into promo
   codes, Lucky Wheel vouchers and other vouchers.

---

## C. A returning family's online changes are saved to the family record (SCRUM-497, point 10)

### Today

- **The SMS code.** On the booking site (`apps/pos/src/pages/Book.tsx`) a
  family types a phone. `GET /public/member-tier` answers nickname, tier and
  contact app only. For a member, the page offers the code:
  `POST /public/saved-children/code` sends six digits (10 minutes; limited per
  phone and per address; the same answer whether or not the phone is a
  member's), and `POST /public/saved-children/verify` spends the code and
  answers the saved children's name, date of birth, age, allergies and food
  restrictions, nothing else (`apps/api/src/routes/public.ts`,
  `apps/api/src/services/member-code.ts`, built under SCRUM-357, The booking
  site's saved-children step is unreachable: the public member lookup answers
  a nickname and tier only). No session is opened.
- **Logged.** `member.saved_children_code` and `member.saved_children_read`
  audit rows, with no staff actor.
- **What a family can change or add online.** Only children who come without
  an adult (drop-off or nanny); a child with an adult on the booking is not
  named at all. Per child: name, age or date of birth, one "allergies and
  medical" field, food restrictions; also the food choice and the nanny's
  start time, which belong to that booking. Saved children fill these fields;
  the review step lets the parent confirm, edit, pick another saved child or
  "remove" one, which only empties that place on the booking. The contact app
  goes on the booking only. Event pass attendees go to the OTO App, not the
  family record.
- **What is sent.** Each supervised line carries childName, ageYears,
  dateOfBirth, allergies, foodRestrictions, foodProvision and nannyStartTime
  (`packages/shared/src/booking-supervision.ts`). No link to the saved child
  is sent.
- **When paid.** `registerPaidBookingChildren`
  (`apps/api/src/services/booking-supervision.ts`) makes a registration and a
  check-in per child from those details. The check-in is not linked to the
  saved child, and the family's children are never written.
- **The phone alone picks the family.** A booking is put on a member by its
  phone (`apps/api/src/services/booking-checkout.ts`), code or no code. The
  code is the only proof that the person holds the phone.
- **What families read.** "These details come from your family's saved
  record. Changes you make here apply to this booking only", then "to update
  the saved record, ask at reception" (`childReview.noteBooking` in
  `apps/pos/src/i18n/dictionary.ts`).
- **The approved design saved them.** "Still correct?" updated the saved child;
  "Remove from saved" removed it; at Pay every supervised child was updated or
  added as "Online booking"; the contact app was saved to the member; the
  photo never (`imports/oto-pos/artifacts/oto-till/src/pages/Book.tsx`, lines
  249, 376, 432, 457, 540 to 550).
- **Parts to reuse.** The check-in board already writes a correction back to
  the saved child (name, age, allergies, food restrictions) with a
  `child.update` audit row holding before, after and a source
  (`apps/api/src/services/checkin.ts`). The member carries
  `children_review_since`, "staff confirm who is who at the next visit",
  cleared by the next visit that confirms the children
  (`packages/db/src/schema/members.ts`, `apps/api/src/services/visit-children.ts`);
  today only an offline merge sets it, and the till does not show it.
- **Tests that pin today.** `apps/api/test/public.test.ts` ("public saved
  children behind a code to the phone").

### What he asked for

He ticked "Save it to the family record", knowing that anyone who passes the
SMS code can then change saved details, allergies included.

My reading: when a returning family who passed the SMS code changes a saved
child's details, or adds a child, the family record changes too, so the next
booking and the till see it.

### The smallest build that does it

- **A family pass.** The code check answers, beside the children, a one-time
  pass for that member, good for 60 minutes (random, stored hashed the way the
  code is: a `core.auth_throttle` row keyed `mpass:`). Without a pass nothing
  is saved, so a person who only knows the phone changes nothing.
- **The booking says which child is which.** It sends the pass and, for each
  supervised child that came from a saved one, `savedChildId`. The platform
  checks that the pass is for the booking's member and that each id is a
  child of that member, and stores "family checked" on the booking.
- **Saved when the money is confirmed** (inside `registerPaidBookingChildren`,
  same transaction): a linked child gets its name, date of birth or age,
  allergies and food restrictions where they changed; an unlinked child is
  added to the family, noted "Online booking". Each check-in is linked to its
  child, so a correction on the board later reaches the record as it does
  today. Every change is a `child.update` or `child.create` audit row with
  before and after, source `booking_site`, the booking id, and no staff
  actor. The photo, the food choice and the nanny time stay on the booking.
- **Words.** The review note says the change will be saved to the family's
  record (every language in the dictionary).
- **The guarded version adds** (decision 8 B): when allergies or food
  restrictions change, or a child is added, the member's
  `children_review_since` is set. The till's Membership Check
  (`apps/pos/src/components/till/StepIdentify.tsx`) then shows "Details
  changed online on 18 Nov: check each child's allergies with the parent"
  until staff confirm the children for a visit, which already clears it.
- **Files to touch.** `apps/api/src/services/member-code.ts`,
  `apps/api/src/routes/public.ts`, `packages/shared/src/booking-supervision.ts`,
  `apps/api/src/services/booking-checkout.ts`,
  `apps/api/src/services/booking-supervision.ts`, `apps/pos/src/pages/Book.tsx`,
  `apps/pos/src/components/book/BookVerifyFamily.tsx`, `apps/pos/src/api/platform.ts`
  (the booking site's client, `publicApi`), `apps/pos/src/i18n/dictionary.ts`; guarded also
  `apps/api/src/routes/members.ts` (it already answers the field) and
  `StepIdentify.tsx`. No migration for either version.
- **Checks to add.** API: no pass, nothing saved; a pass for another family
  refused; a `savedChildId` of another family refused; an unpaid booking
  writes nothing; a paid one updates and adds with its audit rows; a replayed
  confirmation writes once; guarded: the flag is set and a visit confirm
  clears it. Till: the new wording; the booking site sends the pass and the
  ids.
- **Staging proof.** A ZZ TEST member with one saved child on staging. On the
  staging booking site: the phone, the code (from the staging SMS adapter or
  the test phone), an allergy changed, a sibling added, paid with the gateway
  simulator. Then the till's Membership Check shows the new allergy and the
  new child (and the line, if guarded), and the Console audit shows before and
  after. Screenshots.
- **Size.** Plain M. Guarded about a day more. Decision 9 B adds a public
  write route and about a day; decision 10 B and 11 B under half a day each.

### Still his to choose

8. **Plain or guarded?** A: plain; save the changes and log each one with
   before and after. B: guarded; as A, and a changed allergy, a changed food
   restriction or a new child is flagged for reception to confirm with the
   parent at the next visit.
9. **When is the record changed?** A: when the booking is paid. B: when the
   parent confirms each child online, paid or not (the approved design).
10. **Removing a saved child online:** A: not online; the parent asks at the
    desk (today). B: "Remove from saved" takes the child off the record (the
    approved design).
11. **The family's contact app (WhatsApp, Telegram, LINE):** A: stays on the
    booking only (today). B: also saved to the family record (the approved
    design).

---

## D. Card refunds go back to the card where the terminal allows (SCRUM-497, point 7)

### Today

- **The rule** (`allocateRefund` and `routeFor` in
  `packages/shared/src/refund.ts`): the money goes back to the wallet first,
  then through the sale's own tenders, newest first, then cash. A tender taken
  on a counter terminal goes back through the terminal only as a cancel
  (void) of the whole tender, never refunded before, and never Thai QR.
  Anything else is cash from the drawer. A cancel the terminal refuses (its
  window closed, that is after the card batch was settled) or that the box
  never sent also turns into cash (`apps/api/src/services/refunds.ts`,
  `apps/api/src/services/payments/terminal.ts`). Gateway payments go back
  through the gateway, a part too (`settleGatewayRefunds`).
- **What staff see.** For a card sale the History refund dialog says nothing
  in advance about where the money goes; the refund's record lists each part
  afterwards ("cash" for these) (`refundHint` in `SaleDetail.tsx`,
  `RefundModal.tsx`). End of Day takes a cash part off the cash line
  (`channelOfRefundSlice` in `apps/api/src/services/end-of-day.ts`).
- **The terminals on file** (`docs/architecture/DEVICE_INVENTORY.md` sections
  2 and 5; `docs/progress/plans/206-tenders/vendor-protocols.md`; the
  adapters `packages/box-agent/src/terminal/ghl.ts` and `digio.ts`, built
  under SCRUM-206, S2-10a Tenders: cash, EDC terminal simulators in the NEXGO
  and PAX dialects with inquiry-on-no-response, real 2C2P sandbox QR with PAX
  QR offline fallback, manual recording, payment methods admin):
  - Two NEXGO N5 on SCB, GHL LinkPOS XML, spec v1.4 (read again for this
    plan): messages SALE, QUERY and VOID only. **No refund message.** A card
    cancel only before the cashier's settlement; e-wallets before 23:00; Thai
    QR never. The routing on file sends card here.
  - Two PAX A920Pro by Digio, BER-TLV, spec v2.21: sale, cancel, inquiry, and
    a **refund message, A52 and A53** (section 5.14): "This request allows only
    Credit Card, QR Credit." Its request has **no amount field**: it names the
    sale's references, an optional refund type (RF1 to RF4; without it the
    terminal shows "Select Refund Type") and a fixed password; the answer
    carries the amount. So a part amount is probably typed on the terminal,
    not sent by us; that is unconfirmed. The spec says nothing about how long
    after a sale a refund works. The park's PAX app is named "OTO, Sale / Void
    / Settlement", which suggests refund is not switched on. The routing on
    file sends QR and wallets here, not card.
  - The box adapters do sale, inquiry and cancel for both; settlement answers
    "unsupported"; no refund command exists anywhere (`TERMINAL_EXCHANGES` in
    `packages/box-agent/src/terminal/contract.ts`).
  - No real terminal has taken money on the platform yet; the real payment
    test leaves card at the till out (`docs/progress/plans/real-payment-test/PLAN.md`).
- **Tests that pin today.** `packages/shared/test/refund.test.ts`, the refund
  tests under `apps/api/test`, and the terminal simulators
  (`simulator-ghl.ts`, `simulator-digio.ts`).

### What he asked for

He ticked "Back to the card, where the terminal allows".

My reading: when a card payment cannot simply be cancelled (a part refund, or
after the window), the money should go back to the guest's card rather than
out of the drawer, wherever the park's terminals can do that.

### Known, only the provider can answer, and what can be built now

**Known.** The card terminal on file (NEXGO, GHL) has no refund command for
the till to send. The PAX (Digio) has one, for credit cards and QR credit,
without an amount in the request. Nothing on the platform sends either.

**Only the providers can answer** (SCB or GHL for the NEXGO, Digio for the
PAX):

- Can the NEXGO's own app refund a settled card sale from its menu, whole or
  in part? Is there a LinkPOS version with a refund message?
- Digio A52: can it refund part of a sale, and where is the amount given? For
  how many days after the sale? For which cards (RF1 to RF4), and QR credit?
  Can the park's app have refund switched on, and what is the password?
- If only the PAX can refund, may card payments be routed to the PAX?
- Can the bank refund a settled card payment from its merchant portal, in
  part, with a reference staff can record?

**What can be built now without those answers** (decision 12; nothing is a
valid answer):

- **Nothing.** Cash stays until a provider confirms; then build the terminal
  refund: a box command for A52, the simulator, the platform's refund route,
  and a bench run on the real PAX at the park. Size now 0; later L.
- **A card refund done by hand.** Where the terminal cannot cancel, the
  refund dialog offers "Back to the card, on the terminal or through the bank"
  beside "Cash from the drawer". Choosing it takes nothing from the drawer and
  records the part as owed to the card; History shows it waiting until staff
  type the terminal's or the bank's reference; End of Day takes it off that
  terminal's card line, not cash. It works whatever the terminals can do, as
  long as someone can refund the card. Risk: recorded and forgotten, so a
  "waiting card refunds" list goes with it. Files:
  `packages/shared/src/refund.ts`, `apps/api/src/services/refunds.ts`,
  `apps/api/src/services/refund-slices.ts`, `apps/api/src/services/end-of-day.ts`,
  `apps/pos/src/components/history/RefundModal.tsx`, `SaleDetail.tsx`. Proof on
  the staging till with the terminal simulator: a card sale, a part refund
  sent to the card by hand, a reference typed, End of Day's cash unchanged.
  Size M.
- **A part refund while the window is open: cancel and charge again.** The
  whole card payment is cancelled on the terminal and the part the guest keeps
  is charged again (the guest taps the card again). It uses only the cancel
  and sale we already have. Risks: a second charge declined leaves the sale
  part paid; the guest sees two lines on the statement. Size L.

### Still his to choose

12. **What do we build before the providers answer?** A: nothing; cash stays
    until they confirm, then the terminal refund is built. B: a card refund
    done by hand on the terminal or through the bank, recorded with its
    reference and taken from no drawer. C: for a part refund while the window
    is open, cancel the whole card payment and charge the kept part again.

---

## E. The loss (shrinkage) report: keep it, make it more reliable, show more (SCRUM-497, point 21)

### Today

- **Where.** The stock module's Reports, tab Shrinkage
  (`ShrinkageReport` in `apps/pos/src/components/mobile/stock/StockReports.tsx`),
  from `GET /branches/:branchId/stock/reports` (`apps/api/src/routes/stock.ts`;
  needs `pos:stock:read`; the money figures only for holders of
  `pos:stock:order`, "—" for others). Built by `stockShrinkage` in
  `apps/api/src/services/stock.ts` (SCRUM-213, S2-14b Stock: items,
  locations, sale decrements, transfers, purchase orders, stock take, stock
  guards).
- **What it adds up**, per stock size, over the trading days in the chosen
  range (From and To are already there, the last 30 days by default): every
  count difference, counted minus the record, both ways, leaving out each
  storage place's first count (its opening; `placeOpeningSql`); plus every
  correction down (an Adjust with a minus). Corrections up are left out. The
  loss at cost uses the cost frozen on each movement.
- **What it shows.** Two tiles (items with shrinkage; estimated loss at cost)
  and one card per size whose total is below zero: "-N ea", "Counted short
  N×", "counts found N more", "corrections -N", and the loss at cost or "no
  cost set". Sizes at zero or above are hidden. No split by storage place, no
  download, no list of the write-downs.
- **Why it can mislead.**
  1. A correction up is ignored: a write-down made by mistake and corrected
     shows a loss that never happened. But Adjust is also used for deliveries:
     the Admin Inventory help still says "Use 'Adjust' for receive, shrinkage,
     or recount corrections"
     (`packages/admin-screens/src/lifted/components/admin/inventory/InventoryPanel.tsx`),
     and only a free-text reason tells them apart. Counting every correction
     up against the losses would hide real losses behind deliveries.
  2. The loss tile adds sizes with no cost as if their uncosted units were
     free; only the size's card says "no cost set".
  3. A storage place that got stock by a delivery or a move before its first
     count has no opening. Its first count is an ordinary count, and its
     difference holds everything since go-live, shown as one period's loss.
  4. A count made while a counter box still holds sales it has not sent:
     the record is too high, the count shows a loss, the late sale then takes
     the record down, and the next count shows a find. Nothing checks this at
     the count (`commitStockTake`); End of Day has such a check
     (`provisionalBoxesOf` in `apps/api/src/services/end-of-day.ts`).
  5. A paid sale the record did not hold is raised as a "sold beyond the
     record" attention row, not a loss; the report does not mention them.
  6. One figure per size for the whole branch: a loss at the counter and a
     find in the store room cancel out unseen.
- **The data for more is already kept.** The ledger (`pos.stock_movement`:
  every kind, place, person, reason and cost) and a daily fact per size
  (`analytics.fact_stock_daily`: opening, sold, refunded, received, moved,
  adjusted, counted, sold beyond the record, closing), written by the
  `job:stock.daily` job and read by nothing yet.
- **One fact for the owner.** Read from the ledger, the period method
  (opening plus received, minus sold, minus closing) equals all count
  differences plus all corrections, both ways. Today's method and the period
  method differ only by the corrections up and the openings.
- **Tests that pin today.** `apps/api/test/stock-r4.test.ts` ("Shrinkage:
  counted −2 and +1, one write-off: total −2, ฿240 lost at cost"), and the
  stock-r4 gate tests.

### What he asked for

He did not tick; he wrote: "Can we keep the current and refine it more to make
it more reliable and adding additional data in report?"

My reading: keep today's figure (shortfalls plus write-downs) as the headline;
make it easier to trust; show more figures beside it. Each refinement below
keeps today's figure as it is.

### Refinements, each a tick on its own (none picked)

- **E1. Corrections up and a net figure (S).** Each size also shows
  "corrected up +N" and "net"; two tiles join, "Corrected up" and "Net".
  The loss figure is unchanged. The deliveries entered as Adjust (above) can
  inflate "Corrected up"; E5 fixes that at the source.
- **E2. The period columns (M).** Per size: opening, received, sold net of
  refunds, closing, and "not explained" (opening plus received, minus sold,
  minus closing, the storage places' openings left out), read from the
  ledger, beside today's figure.
- **E3. Per storage place (M).** Each size's figures per place (the counter
  shelf, back of house, the store room), with moves in and out, and a place
  filter.
- **E4. Warnings on the figures (S, with one part M).** (a) "N sizes have no
  cost: the loss leaves them out", on the tile. (b) "First count at this
  place, with no opening count before it", on the size. (c) "Counted while a
  counter box had sales it had not sent", on the size; this needs the count to
  store the boxes' state when it is committed (a small migration), so it is
  the M part. (d) "Sold beyond the record: N" in the range, from the attention
  rows.
- **E5. A reason type on every correction (M).** Staff pick one: delivery,
  found, recount, damaged, expired, theft, other; the free text stays. Losses
  can then be split by cause, and deliveries never count as finds. The Admin
  Inventory help text points deliveries to Receive. One more tap for staff on
  every correction.
- **E6. The list and a download (S).** The write-downs and count
  differences in the range, with who, when, where and why, and a CSV.

**Files to touch** (by pick): `apps/api/src/services/stock.ts`
(`stockShrinkage`, `commitStockTake` for E4 c, `adjustStock` for E5),
`packages/shared/src/stock.ts` (`StockShrinkageRowSchema`),
`apps/api/src/routes/stock.ts`, `apps/pos/src/components/mobile/stock/StockReports.tsx`,
the adjust dialogs for E5 (`StockAdjustModal.tsx`, `MerchStockAdjustModal.tsx`,
`InventoryPanel.tsx` in `packages/admin-screens`), a migration for E4 c and E5,
OpenAPI regenerated.

**Checks to add.** The pinned test keeps its −2 and ฿240; new cases: a
correction up shows beside it and in the net; the period columns add up to the
ledger; a per-place split that sums to the branch; each warning raised and not
raised; a reason type required and reported.

**Staging proof.** A ZZ TEST size at a staging branch: 10 received, 3 sold, a
count 2 short, 1 written down, 1 corrected up. On the staging till's stock
Reports at phone size: today's figure still reads −3, and the ticked additions
show beside it. Screenshots.

### Still his to choose

Tick any or none; nothing here is picked for him.

13. **E1, corrections up and a net figure beside the losses?** A: yes. B: no.
14. **E2, the period columns (opening, received, sold, closing, not
    explained)?** A: yes. B: no.
15. **E3, figures per storage place?** A: yes. B: no.
16. **E4, warnings on the figures?** A: all four (no cost, first count with
    no opening, counted with unsent sales, sold beyond the record). B: only
    no cost and first count with no opening. C: none.
17. **E5, a reason type on every correction?** A: yes. B: no.
18. **E6, the list of write-downs and count differences, with a download?**
    A: yes. B: no.

---

## All decisions at a glance

Option A is the default wherever one is named: the smallest, or the closest
to his words. For 13 to 18 he asked for options, so none is the default.

| id | ticket | question | option A | option B | option C | default |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | SCRUM-482 | Where does the manager approve a credit voucher? | At the same till, on the spot (manager's phone and password) | From their own screen; the request waits in a Console list | Both | A |
| 2 | SCRUM-482 | If a request can wait, when does it lapse? | End of the trading day (05:00) | After 30 minutes | Never; until decided or cancelled | A |
| 3 | SCRUM-482 | If a request can wait, how does the manager hear of it? | Console list only | Also the HR app bell of one manager the park names | | A |
| 4 | SCRUM-482 | A manager issuing one themself | Alone | A second manager approves too | | A |
| 5 | SCRUM-482 | Which vouchers need a manager at the till? | Credit vouchers only | Every voucher issued at the till | | A |
| 6 | SCRUM-482 | Which vouchers count as Lucky Wheel? | Booth spins, fixed-code wheel prizes included | Those, plus the old system's imported codes as their own line | | A |
| 7 | SCRUM-482 | Where does the Lucky Wheel line show? | Wallet & promo voucher card only | Also Discounts & Comps | | A |
| 8 | SCRUM-497 | Saving online changes: plain or guarded? | Plain: save and log before and after | Guarded: as A, and allergy, food and new-child changes flagged for reception to confirm | | A |
| 9 | SCRUM-497 | When is the family record changed? | When the booking is paid | When the parent confirms online, paid or not | | A |
| 10 | SCRUM-497 | Removing a saved child online | Not online; ask at the desk | "Remove from saved" takes the child off | | A |
| 11 | SCRUM-497 | The family's contact app | Booking only | Also saved to the family record | | A |
| 12 | SCRUM-497 | Card refunds: what to build before the providers answer | Nothing; cash until they confirm | Card refund done by hand, recorded with its reference | Part refund in the window: cancel and charge the kept part again | A |
| 13 | SCRUM-497 | Loss report: corrections up and a net figure | Yes | No | | none |
| 14 | SCRUM-497 | Loss report: period columns | Yes | No | | none |
| 15 | SCRUM-497 | Loss report: per storage place | Yes | No | | none |
| 16 | SCRUM-497 | Loss report: warnings on the figures | All four | No cost and first count only | None | none |
| 17 | SCRUM-497 | Loss report: a reason type on every correction | Yes | No | | none |
| 18 | SCRUM-497 | Loss report: list of write-downs with a download | Yes | No | | none |
