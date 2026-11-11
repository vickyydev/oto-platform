# The feedback round — the 8 November topics built (12 November 2026)

The owner's go, 12 November: build, test, deploy and prove every change noted from the
8 November feedback, each deployed by name as it finishes and proved on staging, with a
hunt for defects across the till before the demo at the park. CI never gates a ticket.

## Lanes

| Lane | Ticket | What it builds | Surface |
|---|---|---|---|
| lane/dropnumber863-20261112 | SCRUM-863 | The drop-off and nanny forms ask for and confirm the messaging number again, as the prototype does | till, shared |
| lane/membertier858-20261112 | SCRUM-858 | A verified member sees only their own rate | till |
| lane/payscreen859-20261112 | SCRUM-859 | The customer's payment screen shows the order lines | till, shared |
| lane/contacts860-20261112 | SCRUM-860 | Create a contact and edit a contact's name | api, inbox |
| lane/voidslip861a-20261112 | SCRUM-861 part 1 | VOID and UPDATED slips to the kitchen and the bar | api, box agent |
| lane/dropband861b-20261112 | SCRUM-861 part 2 | A wristband printer role for drop-off bands, kids printer as fallback | db, api, box agent, console |
| lane/dropcancel862-20261112 | SCRUM-862 | Cancel a waiting drop-off booking; earlier days leave the list | api, till |
| (after SCRUM-863 lands) | SCRUM-857 | Staff screen mirrors every family form live; Done without the receptionist; the photo on the paired display | till, shared |

Each lane: build with tests, two independent reviews, a fix round, then land fast-forward,
deploy the changed services by name, prove on staging with ZZ TEST records, post the
pictures and walk the ticket to Deployed.

## Held for the owner

- SCRUM-857: where the second number comes from; whether drop-off belongs in the inbox;
  automatic check-in (members have none today, so "the same as members" has no model).
- SCRUM-862: who may cancel a waiting booking (built as: whoever may register one).
- SCRUM-861: the park's box needs a release for the new printer role and slips; the box
  is not touched in this round.

## The defect hunt

Five read-only readers, one per area (ticket sale; drop-off and nanny; the customer
display; food, shop, party and History; trouble such as a double tap or a lost
connection), each finding checked by a second reader. Confirmed findings are fixed in
this round or ticketed.

## Interruption on 12 November, 03:33

Every agent stopped at once on the account's usage limit, a few minutes after launch.
Nothing was lost: SCRUM-863's unfinished edits were intact in its lane and its agent was
resumed; the other lanes had not yet written code and were relaunched with a script that
continues from whatever a lane already holds and commits each step.

## State at 04:11 on 12 November

- SCRUM-863 landed (b0b645939, follow-up 0a7a9c7ce: an ordinary group is not asked the
  number on a paired display) and is deployed to both till services and the api; its
  staging proof is running. Ticket in Testing.
- SCRUM-857 is building in lane/dropflow857-20261112, four parts in order: the number
  confirmed, the staff mirror of every family form, the photo on the display, Done
  without the receptionist. Owner's answers: the second number is the form's own field;
  drop-off in the inbox is not needed now; automatic check-in is researched, not built
  (two readings, one question for Maria or Tom, on the ticket).
- SCRUM-862: whoever may register a child may cancel a waiting booking, with a log
  (owner's answer).

## The defect hunt's outcome: SCRUM-864 and its subtasks

Sixteen points confirmed by a second reader, eight set aside (five are prototype rules,
noted for the owner on SCRUM-864).

| Lane | Tickets | What |
|---|---|---|
| lane/salefu865-20261112 | SCRUM-865, 866, 867, 868 | A corrected order after Pay replaces the first sale; the shop lets go of a cleared sale; the payment screen keeps its method; an expired rate confirmation says so |
| lane/displayfu869-20261112 | SCRUM-869, 870 | The paired display holds the order while a price refreshes; it returns to welcome when staff leave the Tickets tab |
| lane/dropfu871-20261112 | SCRUM-871, 872, 873 | Each child written once on a retry; saved children matched; the nanny's name carried |
| lane/historyfu876-20261112 | SCRUM-876, 877 | A party settlement left open can be cancelled; a part-paid food or shop sale can be refunded from History |
| with SCRUM-857 | SCRUM-874, 875 | The family's form survives a connection drop; the screen says why Done is not available |
| not started | SCRUM-878 | A staff session ending in a long shift: plan on the ticket, session length is the owner's decision |
