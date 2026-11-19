# Drop-off and the BEO form: the plan from the park team's requests

**State, 19 November 2026, afternoon: ANSWERED IN PART AND APPROVED TO BUILD.**
The owner answered 47 of the 56 questions and said to start on what is cleared.
His answers are the build specification in `ANSWERS.md` beside this file; the
tickets are SCRUM-1017 (drop-off) and SCRUM-1026 (the BEO) with the steps as
sub-tasks. Three BEO steps of section 4 fall away by his answers (4, 9, 10),
and no layout example is drawn first. The text below is the plan as proposed.

**State when proposed: not approved, nothing built.** The owner
asked for the park team's requests of 20 October to 19 November to be compared
with what is built, and for a plan with questions on its own page. No ticket is
filed and no code changes before his answers. A tick on the page is the go for
that item only.

- The plan page with the questions (private, 56 questions, answers saved in
  the page): https://claude.ai/artifact/WsbwvABPnVcBFbjWiX4PP1
- The comparisons it is drawn from, beside this file:
  `DROPOFF_AND_TILL_COMPARISON.md` (drop-off, till, HR app, inbox) and
  `BEO_COMPARISON.md` (the operations lead's "Simplified BEO Editor" brief of
  12 November, and eight smaller requests). Both were read from the code on
  the main line, read only; staging was not driven.
- The chats themselves are not kept in the repository, in Jira or on a page.

## 1. Where the requests stand

62 requests checked: 20 work as asked, 30 partly, 12 not built.

- Drop-off and check-in, 17: 5 work, 8 partly, 4 not built.
- The BEO brief, 18 points: 2 work, 13 partly, 3 not built.
- The rest: the till, the HR app, the inbox and smaller requests.

## 2. Findings nobody had reported

1. A child on a ticket with food credit included who is dropped off or has a
   nanny pays for the ticket and gets no credit from it.
2. The children staff tick as visiting do not decide who is on the drop-off
   form; the form takes the saved list in order.
3. A friend's child added to a family's drop-off is saved onto that family's
   record.
4. Until the no-refund setting is on, pickup refunds unused food credit by
   itself. (The owner's choice of 19 November switches it on with the gateway.)
5. Scheduling: the saved employee order does not match the drag.
6. The BEO print has no Entertainment part, and the food service times never
   reach its timeline.

Each is a question on the page; none is repaired.

## 3. Drop-off: proposed steps

| # | Step | Size |
|---|---|---|
| 1 | Returning family in three steps: ticked children become the form's children and the ticket count; the parent's name from the profile; one flow | 1 to 2 days |
| 2 | "Edit details" at reception: add a child without clearing ticks; a friend's child in its own registration | 1 to 2 days |
| 3 | Food credit on the form and at pickup; the "You still have X baht" message | 1 to 2 days |
| 4 | The form on the parent's own phone with a QR code per park (migration: a fourth registration source) | 3 days or more |
| 5 | Reception attaches the waiting form by phone number | 1 to 2 days |
| 6 | Family profiles: several guardians per family (migration and backfill of every member and child; the counter box's offline copy follows) | 4 to 6 days |
| 7 | "Add another parent" in Edit details, and the line on the form | under a day |

## 4. The BEO: proposed steps

| # | Step | Size |
|---|---|---|
| 1 | One timeline made by the system | 1 to 2 days |
| 2 | The Staff BEO print rebuilt (header, timeline, Kitchen left, Setup, Bar, Entertainment, Cake, Notes right) on today's data | 3 days or more |
| 3 | The editor regrouped into Event Info, Food & Drinks, Entertainment & Program, Internal Notes; Parent Experience unchanged | 3 days or more |
| 4 | Money clean-up: "Open in POS", one money line from the till | 1 to 2 days |
| 5 | Kitchen Notes in the editor, the print and AI Fill | 1 to 2 days |
| 6 | Expected extra guests and the Socks choice | 3 days or more |
| 7 | Activities with several staff and notes (app migration) | 3 days or more |
| 8 | A time per dish or group; kids or adults on bar lines | 1 to 2 days |
| 9 | A missing quantity flagged, never read as 1 | under a day |
| 10 | "Adult Waffles" on the birthday set menu (data, no build) | under a day |

Every server step on the BEO also runs the platform's text pins on its routes.

## 5. Smaller requests asked on the page

Service charge inside the price for food and bar only (a new tax mode; one
accounting choice: VAT on the service charge); the price of an extra party
guest; Mystery Box stock; the option editor; the scheduling order repair;
several displays per till; the booth game with nobody on shift; a single shift
for a former employee; leave types.

## 6. After the answers

The owner promised the operations lead a layout example before the drop-off
changes are built. Proposed: clickable screens for drop-off and the BEO drawn
from his answers, shown to her, then tickets (one story each, the steps as
sub-tasks), then the builds: one till lane and one HR app lane side by side.

## 7. Questions from the counter build (19 November)

The counter flow (SCRUM-1018 to 1021) met these while it was built and
reviewed. None is built on a guess: today's behaviour, or the reading named,
stays until the owner answers. Each is for the owner's page.

- **Q-F1 (SCRUM-1019) A number the system does not know, with no name.** The
  answer says the customer is created by itself and the name is added when it
  is known. A member record needs a name today (`crm.member.nickname` is
  required). Built: a member is created by itself when the display's nickname
  box was filled. Not built: with no nickname the till still opens the "New
  member?" box. Options: A. Hold the member under the number as its name
  until the real name is known (no migration). B. Allow a member with no name
  (a migration). C. Keep the box only when no name was given (today's build).
- **Q-F2 (SCRUM-1021) Which credit a counter spend uses first.** A
  dropped-off Eat & Play child's ticket credit and any extra prepaid food sit
  on one band (a band names one wallet). Today a spend counts against the
  prepaid food first, so at pickup under "refund" the family gets back only
  what is left of the prepaid food, and a refund of the food line from
  History is refused once the prepaid part is spent. Example: ฿1,300
  included, ฿500 prepaid, ฿500 spent: ฿0 back. A. Prepaid food first (today's
  build, kept as the default). B. The ticket's credit first: in the example
  ฿500 back and ฿800 left on the band.
- **Q-F3 (SCRUM-1019) A rate document recorded before the expiry date became
  required, with no date.** Built reading: it still counts as a valid Expat
  rate and skips the rate step, as it did; documents recorded from now on
  must carry a date. A. Keep (built). B. Ask the rate again at the next visit.
- **Q-F4 (SCRUM-1020, for awareness) A saved child's allergy and medical
  notes now show on the customer display** to whoever typed that family's
  number at the counter, beside the children's names SCRUM-1014 already shows
  there. This follows the answer; nothing to change unless the owner asks.
- **Q-F1 answered (R1, 19 November evening) and built on the lane of
  SCRUM-1052:** a number with no name makes the member with the number as
  the name ("+66 61 919 1101"), with no "New member?" box. No new field: the
  name is replaced where a member's name is edited today (the Console's
  Members page). A member held under their number counts as having no name:
  the drop-off and nanny forms ask the parent's name (so such a family gets
  the full form, not the agreements-only one), an event pass asks staff, the
  booking site neither greets nor books by it, the display's welcome uses its
  greeting without a name ("Welcome to Oto"), and receipts, kitchen and bar
  slips and an adult's band print no name for it. Staff screens show the
  number where the name would be.
- **Q-F5 (SCRUM-1019, for the owner) The name given on the drop-off form.**
  The parent's name typed on the form is kept on that visit's registration,
  as for every family today; it does not rename the member. So a member held
  under their number keeps it, and is asked the name on the form at each
  visit, until staff change the name in the Console. A. Keep (built). B. The
  name given on the form also names the member while the member's name is
  still their number.
- **SCRUM-1054 built (R3):** the tick "may order food with the included
  credit", on the display, the till's own half and the phone till's form,
  while no extra food is chosen; ticked, the stay's food permission is given
  and the counter asks no manager. The counter box's lane does not know the
  tick yet: while the till works through its box the tick is not asked (the
  family is never asked for something that would not take effect), and a
  registration that falls to the box after the parent ticked names the
  children to staff ("the food counter will ask a manager"). A stay
  registered online is read from the box's copy of the board with the tick.
  The tick gives the stay's food permission, as paid extra food does: what
  the child can spend is the band's balance.
- **SCRUM-1048, which band carries an extra food credit:** the receipt's
  "Prepaid food" row says "On band <short code>", with the child's name when
  the band carries one, and the credit section counts the extra credit in
  what that QR holds (or lists the credit's own wallet and QR when the ticket
  earns no credit). The till's order still names the child "Kid 1", "Kid 2":
  which saved child a kid band is named after is decided by the platform as
  the bands are minted, so the till does not guess it. Printing the credit on
  the band itself is the owner's choice and is not built.
- **SCRUM-1041, removing a display served through a counter box:** the box
  is asked to fetch its copy of the station's settings at once (its "apply
  config" command, picked up within seconds), and its open display streams
  close once the copy drops the display. The till keeps the row as
  "Removing" until the box no longer lists it, and says "within a minute".
- **Known limits until the next counter box release (no box release is
  made by this lane):** a box from before this change drops the form's food
  credit lines and the new care-note fields, so a display served through it
  shows the form as before; receipts the box composes while the link is down
  print no "Credit left" line (on its paper and on the platform's copy); and
  the paper a box composes itself while its link is down (receipts, kitchen
  and bar slips, an adult's band) still prints a member held under their
  number (R1) in full as the name, until the box runs this change's shared
  composer.
