# Seven held tickets: the rule questions, 18 November 2026

On 18 November the owner ticked yes on his decisions page to "Seven tickets held
open by rule questions: shall I write these out as numbered questions with
today's behaviour as the default?". This is that list. Each of the seven tickets
has delivered parts on staging and stays In Progress only because a rule is his
to choose.

How to read it. The questions are numbered 1 to 19 across the whole file.
"Today" is what the system does now, read in the code on `main` at d751e2b10,
with the file named in brackets. Option A is always today's behaviour, and it
stays until he chooses another. "If changed" says in one line what would have to
be built. Nothing in this file is built or changed.

Ruled on 18 November and not asked again:

- An item on the adults' list is billed, and adding it stores "Different for
  adults" as on: SCRUM-998 (an item added to the adults list before Save is not
  billed).
- A billed and paid party item can be neither reduced nor removed: SCRUM-1002
  (rulings for a party's additional bills).
- An additional bill gets its own receipt and shows on End of Day by how it was
  paid: SCRUM-1002 (rulings for a party's additional bills).

Where one of these, or the ruling of 16 November on additions after a party is
settled, already answers a point of the seven, the ticket's section says so.

## SCRUM-945: Kitchen plan to the till, points left by the reviews of the whole kitchen plan build

On staging: a real change to a party's kitchen plan sends the right UPDATED or
VOID slip, also across a release (platform release 41158d231, proved
14 November), and an extra dish no longer marks the set menu's dish of the same
name "kids only" (OTO App view at e4e7bca46, proved 14 November). It stays open
for two rules on older parties and the set menu. Its other points (one slip
wording, stale notes in the code, small code and test points) need no ruling.

### 1. On parties saved before the "Different for adults" switch existed, the adults' list often repeats the kids' list. Should the till count that repeat as the same food?

- Today: the till's party page and the kitchen slip show each repeated dish
  twice, and a priced extra on both lists is charged twice. When the two lists
  are the same, the BEO editor reads them as one list, and its first Save
  rewrites the party as one list. On newer parties a repeated dish is shown and
  charged once. How many older parties are affected has not been counted.
  (`apps/oto-app/migrations/0052_otoapp_beo_bar_charge_provenance.sql`, the
  adults' part of the plan view; `apps/oto-app/shared/kitchenAdults.ts`)
- Options:
  - A. Both lists in full, each dish twice and charged twice, until someone
    saves the BEO (as today).
  - B. A dish the adults' list repeats (same name, count and till code) counts
    once, as on newer parties.
  - C. The older parties are re-saved once, after he has seen the list of them.
- If changed: B needs a new OTO App view migration that changes no past
  receipt; C needs a one-off re-save with a before and after list.
- Not answered by the ruling under SCRUM-998 (an item added to the adults list
  before Save is not billed): that ruling is about an item staff add to the
  adults' list, not about an old copied list.

### 2. When staff delete a set-menu dish from a party's BEO, should it stay off the till and the kitchen slip?

- Today: it leaves the BEO but comes back from the set menu's template on the
  till's party page and on the kitchen slip.
  (`apps/oto-app/migrations/0052_otoapp_beo_bar_charge_provenance.sql`, the part
  "a set-menu item no BEO line answers")
- Options:
  - A. It comes back from the template (as today).
  - B. It stays off everywhere.
  - C. It comes back marked "removed in the BEO", so the kitchen can check.
- If changed: the BEO records the removal, and a new OTO App view migration
  leaves the dish out (B) or marks it (C).

## SCRUM-966: Kitchen plan on the till, the BEO's "kitchen required" switch, the extras' amounts with a service charge, and points left by the reviews

On staging: Settle party shows each named extra at what the till really charges
(release d37ea80c2), the release-day slip mark (release 41158d231), the saved
cake count with a checked day-of save (OTO App 1916bfbd7) and the toast's capital
letter (tills 5bf409ee4), each proved on 13 or 14 November. It stays open for the
three rules below and nothing else.

Already answered, not asked again: point 6, a dish added on the till after the
party is settled. The owner ruled on 16 November that it goes on a new
additional bill linked to the party, built and proved under SCRUM-990 (show
party-linked extras and bill later additions separately); the till's kitchen
edit now sends such a dish to that bill
(`apps/oto-app/server/directory/kitchenPlanRoutes.ts`). The ruling of
18 November under SCRUM-1002 (rulings for a party's additional bills) adds that
a billed and paid item can be neither reduced nor removed.

### 3. When a BEO's Kitchen Plan is set to "Not Needed", should the till and the slips follow it?

- Today: the switch stays in the OTO App only. The till's party page shows
  kitchen service as needed whenever the plan holds food or a cake, both slips
  print every line, and priced extras on the food lists are charged. The editor
  keeps the food lists when "Not Needed" is chosen and only hides them.
  (`apps/pos/src/lib/partyKitchenEdit.ts`, kitchenServiceNeeded;
  `apps/oto-app/client/src/components/beo/beo-event-editor.tsx`, the kitchen
  plan Save; the plan view in
  `apps/oto-app/migrations/0052_otoapp_beo_bar_charge_provenance.sql` carries no
  such field)
- Options:
  - A. The till and the slips ignore the switch (as today).
  - B. "Not Needed" means no kitchen card on the till, no kitchen slip and no
    charge for the food lists.
  - C. The till shows "The BEO says no kitchen service" but still prints and
    charges.
- If changed: a new OTO App view migration carrying the switch, then the plan
  reader, the slips, the settlement and both tills.

### 4. A drink on the kids' menu that is made at the bar: should it be ready with the kids' food, or at the bar's service time?

- Today: everything on the bar slip carries the bar's service time as READY BY
  (the kids' food time only when the BEO has no bar time).
  (`packages/shared/src/party-slips.ts`, partyBarReadyBy)
- Options:
  - A. The bar's service time (as today).
  - B. The kids' food time for a kids' drink.
  - C. The bar slip prints both times, each drink under its own.
- If changed: the slip composer splits the bar's lines by who they are for.

### 5. If a park adds a service charge, should the prices on a BEO and on the till's menu already include it?

- Today: a service charge is always added on top of a price; there is no
  setting for prices that include it. The BEO's "Extras charged at the till"
  shows the price before service. The park has no service charge today, so
  nothing differs now. (`packages/shared/src/tax.ts`;
  `apps/oto-app/shared/beoExtras.ts`)
- Options:
  - A. Added on top, and the BEO shows the price before service (as today).
  - B. Added on top, and the BEO's total adds the park's service charge so it
    matches the till.
  - C. A park setting "prices include service", where the till takes the
    service out of the price instead of adding it.
- If changed: B needs the OTO App to read the park's service rate; C is a new
  money rule in the pricing, the receipts and the reports.

## SCRUM-968: BEO extras and the fill, the holiday price in the hint, a coded line the till menu does not list, and points left by the reviews

On staging: an adults' line that only repeats the kids' menu is the copy of the
kids' line and charged once, Fetch from chat compares a kids' choice with the
kids' lines only (OTO App 1916bfbd7, proved 13 November), and a till code the
BEO cannot price reads "Price unresolved" instead of looking free (OTO App
7455bb8ad, proved 14 November). It stays open for six rules; the rest of its
point 7 (small display points) needs no ruling. Question 7 comes from the
till-menu picker build, SCRUM-905 (the POS menu inside the BEO), and is asked
here because it decides the same money as question 6.

### 6. On a park holiday that falls on a weekday, should the BEO show the holiday price the till will charge?

- Today: for a till item with no price typed, the BEO's hint, its extras total
  and its PDF use the weekend price only on a Saturday or Sunday. The till
  charges the weekend price on Saturdays, Sundays and park holidays, so on a
  weekday holiday the BEO shows less than the till charges.
  (`apps/oto-app/shared/beoExtras.ts`, isWeekendDate;
  `apps/api/src/services/party-settlement.ts`, rateModeOf)
- Options:
  - A. The BEO knows weekends only (as today).
  - B. The OTO App reads the park's holidays and shows the holiday price.
  - C. The till charges party extras the weekday price on a holiday, as the BEO
    shows.
- If changed: B needs a holiday read from the platform into the OTO App; C
  changes the till's party settlement.

### 7. When staff pick an extra from the till menu for a weekend or holiday party, which price should it carry?

- Today: the pick writes the till's weekday price into the line's price box,
  and the till charges a typed price as typed. A weekend or holiday party pays
  the weekday price for that dish unless staff change the box.
  (`apps/oto-app/shared/tillMenu.ts`, lineWithTillItem;
  `apps/api/src/services/party-settlement.ts`, partyExtraChargesOf)
- Options:
  - A. The weekday price (as today).
  - B. The price for the party's day (holidays too, once the OTO App knows
    them, as in question 6).
  - C. The box is left empty, so the till charges its own price for the day.
- If changed: a change to the picker; B on a holiday needs the same holiday read
  as question 6.

### 8. When a BEO extra carries the code of a till item that is switched off, belongs to another park, or is not on the kitchen or bar menu, should the till still charge it?

- Today: the till charges it at that item's own price (any item of the group
  with that code that is not archived). The BEO cannot see such items and shows
  "Price unresolved". (`apps/api/src/services/party-settlement.ts`,
  partyExtraChargesOf; `apps/api/src/services/party-menu-catalogue.ts`;
  `apps/oto-app/shared/beoExtras.ts`)
- Options:
  - A. Charge it, and the BEO shows "Price unresolved" (as today).
  - B. Charge it, and let the BEO see these items so it shows the price.
  - C. Do not charge it, and the BEO marks it "not on the till menu".
- If changed: B widens the till menu the platform gives the OTO App (the open
  point 8 of SCRUM-983, BEO editor and PDF); C makes the settlement charge only
  items on sale at the party's park.

### 9. When the AI fill gives the adults their own menu, should it also copy the kids' extra dishes onto it, as the staff switch does?

- Today: the fill copies only the kids' set-menu dishes for the adults;
  turning "Different for adults" on by hand copies the whole kids' list. A
  copied dish is charged once, with the kids' line, either way.
  (`apps/oto-app/server/lib/beoAiApprove.ts`;
  `apps/oto-app/client/src/components/beo/beo-event-editor.tsx`, switchAdults;
  `apps/oto-app/shared/beoExtras.ts`)
- Options:
  - A. The fill copies the set-menu dishes only (as today).
  - B. The fill copies the whole kids' list, as the switch does.
  - C. The switch copies only the set-menu dishes, as the fill does.
- If changed: a small change to the fill (B) or to the switch (C); no money
  changes.

### 10. "Fried rice for the kids" with no option named: should it become the kids' set-menu fried rice, with staff picking the option, instead of a charged extra?

- Today: it is written as a charged EXTRA at the till's price. The same words
  for the adults already become the adults' set-menu dish, with the option
  picked by staff before Approve. (`apps/oto-app/server/lib/beoCatalogueFill.ts`)
- Options:
  - A. A charged extra (as today).
  - B. The kids' set-menu fried rice, with staff picking the option before
    Approve, as for the adults.
- If changed: the fill reads the kids' case the way it reads the adults'.

### 11. A drink made for one party that sits on the Bar Plan of a BEO saved before 16 November: should the till charge it?

- Today: since 16 November, SCRUM-989 (reuse dishes made for one party across
  parties), such a drink carries a charge mark when staff add it and is
  charged. One saved before has no mark, is charged nowhere, and the BEO says
  "not charged". How many exist has not been counted.
  (`apps/api/src/services/party-settlement.ts`, partyExtraChargesOf;
  `apps/oto-app/shared/beoExtras.ts`;
  `apps/oto-app/migrations/0052_otoapp_beo_bar_charge_provenance.sql`)
- Options:
  - A. The older ones stay uncharged (as today).
  - B. The older ones are charged at settlement, as new ones are.
- If changed: the settlement and the BEO's hint treat an older unmarked line as
  marked; no paid bill changes.

## SCRUM-975: Counter display after the display fix, button sizes, offline screens and small points

On staging (both tills at 239ef4824, proved 13 November): "Ask the team" pressed
while offline reaches the till by itself when the connection is back, the French
heading clears the language button and the English reconnecting line fits one
line; the photo resend, a time limit on display messages and the display taking
a new build when idle are covered by automated checks. It stays open for two
display choices. The ticket also records three wishes that are new features
rather than rules, and they could move to a ticket of their own: Thai versions
of the park's own "Please confirm" lines, which today show as typed in the
Console (`apps/pos/src/components/till/ConsentCapture.tsx`); more on a phone
sale's History card; and a Shop tab in History, which today has All, Tickets and
F&B (`apps/pos/src/pages/History.tsx`).

### 12. On the counter display's first screen and details screen, should the WhatsApp, Telegram and LINE buttons and the language choices be the larger 44 pixel size the family form uses?

- Today: 40 pixels on those two screens, 44 on the family's form.
  (`apps/pos/src/components/shared/PhoneInput.tsx`;
  `apps/pos/src/components/till/CustomerDisplay.tsx`)
- Options:
  - A. 40 pixels (as today).
  - B. 44 pixels, as on the form.
- If changed: a size change on two display screens and a till release.

### 13. When a family picks a language while the display has no connection, should the first screen and the returning family's review stay usable, as the family form does?

- Today: those two screens lock under a Retry bar until the connection is back,
  then free themselves (about 1.5 seconds on staging). The family's form stays
  open. (`apps/pos/src/pages/Display.tsx`)
- Options:
  - A. Locked, so no press can be lost (as today).
  - B. Open, with presses kept and sent when the connection is back.
- If changed: the display keeps a press made while the language is waiting, as
  the form already does.

## SCRUM-979: Card payments after the refused-command fix

On staging (platform 0ea85faa and tills 239ef4824, proved 13 November on the
simulator): a card payment the terminal was never asked for reads "Card payment
not started" with the true reason, a lost terminal answer is taken from the
command, History can void a held payment and Health stops counting it, and a
refund void that expires falls back to cash. It stays open for two money rules
and one test-system setting. Its point 10 (small box points) needs no ruling.

### 14. A card terminal takes only part of the amount and the box cannot send the void that hands it back. What should staff do?

- Today: the sale stays held with the part charge still on the guest's card,
  and the till offers no way forward.
  (`apps/api/src/services/payments/terminal.ts`, endVoidNotSent;
  `packages/shared/src/payments.ts`, isPaymentReversalPending)
- Options:
  - A. The sale stays held until the team sorts it out (as today).
  - B. Staff hand that amount back in cash and a manager marks it settled.
  - C. A manager sends the void again once the box works.
- If changed: a manager action on the held payment in History, written to the
  log.

### 15. A refund's card void may or may not have reached the terminal. May a manager settle it after reading the terminal's slip?

- Today: it stays "Void sent to the terminal" with no way forward.
  (`apps/api/src/services/refunds.ts`;
  `apps/api/src/services/payments/terminal.ts`)
- Options:
  - A. No, it stays as it is (as today).
  - B. Yes: the manager marks it returned to the card, or hands it back in cash.
- If changed: a manager action on the refund in History, written to the log.

### 16. On the test system, should the simulated card terminal get a test void password, so card refunds can be tried there?

- Today: it has none, so every card void on staging's simulated Digio terminal
  is refused and the refund falls back to cash. (`apps/api/src/services/box.ts`,
  the test box starts with no terminal settings;
  `packages/box-agent/src/terminal/digio.ts`)
- Options:
  - A. Leave it (as today).
  - B. Give it a test password.
- If changed: a staging setting only; nothing changes at the park.

## SCRUM-981: A second person continuing a kept sale, the approved rate, the display and points left by the reviews

On staging (tills at 3e29803bf, proved 14 November with SCRUM-982, a waiting
payment kept when another person continues a kept sale): a waiting or paid
payment survives the hand-over on the ticket till, F&B, Shop and the phone, and
the hand-over notice, the family line, long dish names and the stock refusal are
fixed. It stays open for three rules. Work that needs no ruling: End of Day's
sentence for an order still being paid on its counter, the phone till offering a
rung-up sale again after a reload, and two automatic test fixes.

### 17. When a second staff member continues a cart, should the member rate or discount the first person approved carry over?

- Today: an approved member rate is dropped and the cart is priced again at the
  member's own or the standard rate, with no message. A manual discount stays,
  but the second person must hold the discount permission to pay, and it is
  recorded under whoever rings the sale up.
  (`apps/api/src/services/sale-tier.ts`, findClaim;
  `apps/api/src/routes/sales.ts`, requireDiscountPermission;
  `apps/api/src/services/sale.ts`)
- Options:
  - A. The rate drops without a word and the discount needs the second
    person's permission (as today).
  - B. The same, but the till says so when a rate is dropped.
  - C. The first person's approvals carry over to whoever continues, recorded
    under the first person.
- If changed: B is a till message; C makes the platform accept an approval made
  on the same sale by another staff member.

### 18. When a second person finishes a sale the first person rang up, whose name should it carry as seller?

- Today: "sold by" is the person who rang the sale up.
  (`apps/api/src/services/sale.ts`, soldBy)
- Options:
  - A. The person who rang it up (as today).
  - B. The person who took the money.
  - C. Both names.
- If changed: History and the reports show the second name.

### 19. When a staff session ends while the counter display shows that person's cart or payment code, should the display clear at once?

- Today: the display keeps the ended person's last screen for up to about a
  minute, until the box's hold runs out, and the next person's till says the
  display follows it within a minute.
  (`packages/box-agent/src/station-session.ts`)
- Options:
  - A. Kept for up to a minute, so a family part way through paying keeps the
    code on screen (as today).
  - B. Cleared at once.
- If changed: the box ends its display hold with the session, which needs a box
  release on the counter Pi.

## SCRUM-983: BEO editor and PDF, points left by the reviews of the leftovers lane

On staging (OTO App 7455bb8ad, proved 14 November; till toast 5bf409ee4): the +
button adds to a count stored as text, the PDF prints "1x" instead of "nullx",
and the read-only, review note, parent date and Thai "per" faults are fixed. It
has no question of its own: its point 8 is question 8, and its point 10 is a
notice rather than a choice (see the last section).

## Could close without an answer

SCRUM-983 (BEO editor and PDF, points left by the reviews of the leftovers
lane). Every fault it names is fixed and proved: OTO App
7455bb8adf83f1466c2baab178ece6e72a840958 on staging, with inspected staging
pictures and PDFs and the cleanup in
`docs/qa/proof-2026-11-14/SCRUM-983/README.md`, and the till toast on both tills
at 5bf409ee4. Its point 8 is the same choice as question 8 and is asked once,
there. Its point 10 asked the owner only to object: a price stored as text
("120") is ignored alike by the till and by the BEO's own charge hint until the
party's next day-of change turns it into a number, after which both charge it,
and the ticket records that no such line is known in the park's data (the plan
view reads only a number,
`apps/oto-app/migrations/0052_otoapp_beo_bar_charge_provenance.sql`; the day-of
save turns "120" into 120, `apps/oto-app/server/lib/kitchenPlanBody.ts`). The
small notes of its point 9, such as no lint running on the OTO App's files, can
go to a follow-up ticket.

None of the other six can close yet: each still holds at least one choice above.

## Not covered here

The plan notes hold older questions that none of these seven tickets holds, for
example whether a cake marked EXTRA is charged at its BEO price
(`docs/progress/plans/beo-inbox/KITCHEN_PLAN_AND_POS_2026-11-12.md`). They are
left where they are and are not part of this list.
