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
