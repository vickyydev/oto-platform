# SCRUM-732 local proof, 3 November 2026

Driven in a real browser (Edge, Playwright) against a disposable local database, with
ZZ TEST events, the simulated gateway and the virtual box's simulated terminal. No real
payment was taken, and staging was not touched. The staging proof follows when this lands.

| Screenshot | What it shows |
| --- | --- |
| `02-pass-qr-chosen-no-code-yet.png` | PromptPay chosen and not started: nothing to scan on the customer's side |
| `03-pass-qr-pending-real-code.png` | The pass shown pending, with the gateway's code on both sides and nothing recorded |
| `04-pass-qr-paid-check-in-choice.png` | The simulated gateway said paid: only now "Pass paid" and the check-in choice |
| `05-pass-cash-unchanged.png`, `06-pass-cash-paid.png` | Cash stays the one press it was, with no tender panel |
| `06b-pass-card-sent-to-terminal.png`, `06c-pass-card-approved.png` | A card sent to the terminal, then paid when it approved |
| `07-party-collect-qr-before-start.png`, `08-party-qr-pending-real-code.png` | A party balance by QR: the real code, pending |
| `09-party-qr-paid-recorded.png` | Recorded once the gateway said paid |
| `10-party-card-before-start.png`, `11-party-card-recorded.png` | The rest of the balance by card on the terminal |

The party run took ฿5,000 of its ฿9,000 balance by QR and the remaining ฿4,000 by card.

A tender the gateway flags for a person, and a press refused because another tender waits, driven the same way:

| Screenshot | What it shows |
| --- | --- |
| `12-pass-qr-waits-for-a-person.png`, `13-pass-review-dialog.png` | A pass's QR paid after its time: nothing on the roster yet, and a review in the QR's own words |
| `14-pass-money-taken-check-in-choice.png` | "Money taken": the sale closes, the child lands, the check-in choice follows |
| `15-party-refused-another-counter-keeps-back.png`, `16-party-back-on-the-bill.png` | A press over a QR waiting at another counter: told so, and Back works |
| `17-party-brought-back-as-itself-with-its-door.png` | That QR once it waits for a person: a Card press for ฿9,000 brings back the ฿5,000 QR as itself, with its review and Back |
| `18-party-money-taken-recorded.png` | "Money taken": ฿5,000 recorded on the bill |

Automated: `apps/api/test/scrum-732-routed-tenders.test.ts` (38 cases),
`apps/pos/test/scrum-732-routed-tenders.test.ts` (37 cases) and
`packages/db/test/s732-event-pass-hold-migration.test.ts` (4 cases).

These two screens draw the real code on the customer pane beside the till and on the staff panel. A
customer display linked as its own device follows the ticket till's session only, so it does not show
a pass or a party balance; it shows no placeholder either.
