# Drop-off and the BEO: the owner's answers of 19 November 2026

The owner answered all 56 questions on the plan page
(https://claude.ai/artifact/WsbwvABPnVcBFbjWiX4PP1): 47 first, with the word
to start on what was cleared, then the last nine (section 6). This file is the
build specification. Where an answer says "as today", nothing changes.

Read with `PLAN.md` (the steps) and the two comparisons beside this file (the
code as it stands, with file names).

## 1. How to work

| Question | Answer |
|---|---|
| Which work goes first | Both side by side: drop-off at the counter and the new BEO print |
| A layout example for the operations lead first | Not needed; build from these answers |
| Tickets | Filed now: SCRUM-1017 (drop-off) and SCRUM-1026 (the BEO), the steps as sub-tasks |

## 2. Drop-off at the counter

SCRUM-1018, a returning family in three steps:

- **The number on the drop-off and nanny forms** is shown filled in, with no
  tick; only staff can change it. This replaces the ruling of 12 November
  (the family ticks to confirm the number, SCRUM-863).
- **What a returning family is asked at each visit:** only the three
  agreement ticks. No name (it comes from the profile) and no new photo.
- **The photo of child and guardian:** the last visit's photo may be reused if
  staff confirm it still matches. Read together with the answer above: the
  family is asked nothing; the till shows staff the last photo with "still
  matches" or "take a new one". A child with no earlier photo has one taken.
- **Unticking a saved child** asks no reason (as today).
- **After a waiver** the older sibling who covers the younger one plays on a
  normal ticket: no free drop-off form, straight to payment.
- The plan's step 1 itself: the children staff tick as visiting become the
  form's children and the ticket count.

SCRUM-1019, the number, the rate, the document:

- **A number the system does not know** creates the customer by itself; the
  name is added when it is known. No "New member?" choice.
- **A member with a valid Expat rate** skips the rate step and goes straight to
  tickets; the rate shows on the order with a "change" link.
- **The expiry date on a rate document** is required on every kind, "Other"
  included, except the Thai ID card (his note: nationality does not expire).

SCRUM-1020, Edit details and the care notes:

- **"Edit details" at reception** adds a child or changes details in the middle
  of a check-in without clearing the ticks already made.
- **A friend's child added to the same order** stays saved on this family's
  record (as today). No separate record is built.
- **A saved child's allergy and medical notes** are shown to the parent on the
  customer display and the parent may update them there.

SCRUM-1021, food credit:

- **A supervised child on Eat & Play:** the ticket's credit loads on the
  child's band and the form shows "included, no extra charge".
- **Who chooses extra food credit:** the parent, on the display and (later) the
  phone form; staff see it.
- **Extra food credit** can be added on any child ticket, as its own line on
  the order.
- **At pickup** the screen says "You still have X baht remaining", for staff to
  tell the parent. Not printed, not sent.
- **The remaining credit** pays for a take-away until the end of the park's day
  (as today).
- **The credit left** is printed on every food and shop receipt paid from a
  band.

The no-refund choice is not part of this: it is recorded on SCRUM-709 and
switches on with the payment gateway.

## 3. The form on the parent's own phone (SCRUM-1022, SCRUM-1023)

- A separate drop-off form for the queue now, joined with the booking site
  later.
- A form filled on a phone creates no family record: it saves a waiting form;
  the record is found or made when reception attaches it.
- The agreement ticks made on the phone count, and the parent confirms with one
  press on the park's display.
- The photo is taken at the counter.
- A returning family gets a code by SMS before their saved children show.
  (Depends on the SMS sender being proved on a real phone, SCRUM-1011.)
- A waiting form is kept until the end of the park's day.

## 4. Family profiles (SCRUM-1024, SCRUM-1025)

- Any signed-in reception staff may add another parent or guardian, recorded
  with who and when.
- With two parents on a family, the check-in messages go to both.
- Two parents with separate records and the same children: reception links
  them and says which children are the same; nothing joins by itself. His note:
  reception must see the choices in an easy, understandable way.
- A family's own nanny who gives a different number: the messages go to both
  the nanny and the parents.
- Children known from camps are found by any parent number on a camp
  registration and offered to be saved to the family.
- The line on the form about linking another parent is added with family
  profiles, not before.

## 5. The BEO

Kept as today by his answers (so three of the plan's ten steps fall away):

- **Money:** the Billing section stays as it is, under the four sections. The
  plan's step 4 (money clean-up) is not built.
- **Prices on extra dishes and drinks:** the price box stays in the editor and
  prices stay on the print.
- **Fields the brief does not name** (booking name, WhatsApp number, room,
  final message to the parent): all kept, unchanged, inside the new sections.
- **A dish with no quantity** counts as 1 (his note: "if there is no quantity,
  default it as 1"). The plan's step 9 is not built.
- **"Adult Waffles":** unchanged (his note: no menu item of the kitchen is
  changed on a guess). The plan's step 10 is not done. The request came from
  the operations lead's brief of 12 November.

To build:

- **SCRUM-1027, one timeline made by the system.** A timed step that is
  neither an activity nor a food service lives in a short "Other timed step"
  list inside Entertainment & Program.
- **SCRUM-1028, the Staff BEO print rebuilt:** header, the one timeline,
  Kitchen left; Setup, Bar, Entertainment, Cake, Notes right; long orders flow
  onto more pages. When the adults differ from the kids they print as their
  own list with their own quantities; "Same as kids" folds them into the kids'
  rows. A note may carry an amount the family agreed.
- **SCRUM-1029, the editor in four sections.** Event Info shows the package
  name, its allowance and a summary; add-ons are handled at the till; the time
  the kitchen and bar slips print moves to Food & Drinks. The "Same as kids"
  switch stays. A small "No food for this party" tick in Food & Drinks.
- **SCRUM-1030, Kitchen Notes** in the editor, on the print and in AI Fill.
- **SCRUM-1031, expected extra guests and the Socks choice:** on the BEO and
  the Staff BEO print only, not on the till.
- **SCRUM-1032, people on an activity:** staff by name, one or several, or a
  role with a number ("1 host") filled in later; notes per activity.
- **SCRUM-1033, a time per dish or group:** on the BEO, its print and also the
  till's kitchen and bar slips.
- **SCRUM-1034, the deposit typed by hand:** kept, for managers only, for a
  deposit taken in cash.
- **SCRUM-1035, AI Fill:** a question the team asked and the family never
  answered is never written as agreed, on every field.

## 6. The smaller requests (answered later the same day; all 56 are now answered)

To build:

- **SCRUM-1036, Scheduling order:** repair it. The drag saves the order shown;
  a new employee takes a place at the end.
- **SCRUM-1037, leave types:** Training and Other off; staff see annual leave
  and holidays; the other legal types for managers only.
- **SCRUM-1038, a former employee invited to a single shift:** on the old
  contract; his note: "with an option to switch and work on casual day rate
  as well."
- **SCRUM-1039, the option editor:** a wider name and one price.
- **SCRUM-1040, Mystery Box stock:** a stock item, and the voucher scan takes
  one off.
- **SCRUM-1041, more than one customer display on a till:** build it now.
  Built straight after the counter flow lands, because both change what the
  display shows.

Kept or held (nothing built):

- **Service charge inside food and drink prices:** "Not now". The question on
  the older page is answered the same way.
- **VAT on the service charge:** he will ask accounting; "keep it on hold for
  now".
- **The price of an extra party guest:** the package's own extra price, as
  today.
- **The booth game with nobody at the booth:** runs always, as today.

## 7. Build order

1. Now, side by side: the counter flow (SCRUM-1018 to 1021) on the till, and
   the timeline and print (SCRUM-1027, 1028) in the HR app.
2. Next: the editor and its fields (SCRUM-1029 to 1035) in the HR app; the
   phone form (SCRUM-1022, 1023) on the till once the SMS sender is proved.
3. Then family profiles (SCRUM-1024, 1025), with their own migration plan and
   staging run.
