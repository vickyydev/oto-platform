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
