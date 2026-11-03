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

## Staging proof, 4 November 2026

Driven 05:04 to 05:12 Bangkok (22:04 to 22:12 UTC on 3 November) in a real Edge browser at
`oto-pos-web-staging`, on live source `65c22edf1832e5927536c28ea3db94222ef681e3` (main CI 41720268210,
all six jobs green; api, POS web and old POS live on it from 04:43). Signed in as reception on our own
`ZZ TEST SCRUM-732 mw18diqh till` on Virtual box 1, with QR routed to the gateway and card to our own
simulated Digio terminal. The gateway was read back as the simulator and the api's 57 setting names were
unchanged, values not printed. Only ZZ TEST records; no real money, no SMS, no park device.
Every image below was opened and read. Fixtures, network calls and read-backs: `s732/staging/receipt.json`;
preflight and postflight reads: `s732/staging/preflight.json`, `postflight.json`; the harness: `s732/staging/harness/`.

| Screenshot (`s732/staging/`) | What a person sees | Read back at that moment |
| --- | --- | --- |
| `staging-01-pass-who-is-attending.png` | The member's saved children: ZZ TEST Lin picked | |
| `staging-02-pass-qr-chosen-no-code-yet.png` | PromptPay chosen, not started: "Your payment code will appear here", no code | |
| `staging-03-pass-qr-pending-real-code.png` | The gateway's code on the staff panel and the customer pane, ฿350, 20:01 | roster 0, sale `tendering` |
| `staging-04-pass-qr-paid-check-in-choice.png` | After the simulator's paid event: "Pass paid — check in now?" | one sale `finalised` (Z70-000001), one roster entry |
| `staging-05-pass-cash-unchanged.png`, `staging-06-pass-cash-paid.png` | Cash: one press, no tender panel, paid | one sale, one roster entry |
| `staging-07-pass-card-sent-to-terminal.png`, `staging-08-pass-card-approved.png` | Card sent to the terminal, then paid on approval | pending: roster 0, sale `tendering`; after: one sale, one entry |
| `staging-09-party-qr-before-start.png`, `staging-10-party-qr-pending-real-code.png` | ฿5,000 of the party's ฿9,000 by PromptPay: the real code, pending | bill ฿9,000 owed, End of Day party line unmoved |
| `staging-11-party-qr-paid-recorded.png` | After the paid event: ฿5,000 recorded, ฿4,000 left | End of Day party line +฿5,000; the QR line unmoved |
| `staging-12-party-card-before-start.png`, `staging-13-party-card-recorded.png` | The other ฿4,000 by card on the terminal: recorded, ฿0 left | End of Day party line ฿9,000 |
| `staging-14-party-bill-balance-zero.png` | The bill: payments taken ฿9,000, outstanding ฿0, Fully paid | |
| `staging-15-party-b-qr-pending.png`, `staging-16-party-b-qr-paid-recorded.png` | A second party's ฿500 by PromptPay, pending, then recorded | Performance party facts 3 while pending, 4 after paid; End of Day the same |

By API with the same till session: `POST /events/:id/passes` with QR or card answered 409
`EVENT_PASS_TENDER_ROUTED` and wrote no sale; with cash it recorded. `POST /parties/:id/payments` with QR,
or with a card and no slip, answered 409 `PARTY_TENDER_ROUTED` and wrote nothing; with cash it recorded.

Database read (Render one-off job, read only): four pass sales, all `finalised`, each with one approved attempt;
the two pass holds `applied` at the second the money landed; four roster links; party payments with no sale
behind them; both card attempts and both terminal commands on our own terminal, both `succeeded`.

The gateway's paid event was fired through `POST /webhooks/2c2p/simulator` as an administrator, the same
call as the Console's Integrations → QR payment gateway → Customer paid.

Jira: the sixteen images are attached to SCRUM-732 and thirteen are shown inside comment 13348, checked by
attachment id (`s732/staging/jira-render-check.json`). SCRUM-732 reads Deployed.

Cleanup, read back from the database: the till, its terminal, the member, its three children and the three
events are archived; both sessions signed out (`/me` 401); no live session on the station; nothing waiting.
The four pass sales and their payments, the party payments and the audit history stay as records.

Render redeployed every staging service on `e978578f` (a Console test-only commit) at 05:16, after the proof
screens; its `apps/api`, `apps/pos` and `packages` are identical to `65c22edf`.

Still open, filed and waiting for this landing: a customer display running as its own device does not show
the code yet (SCRUM-738); a ticket, F&B or shop QR that needs a person has no answer button yet (SCRUM-739).

Observed outside this ticket (`s732/staging/finding-repro-*.png`): after the till locks and the page is
reloaded, Unlock lands on "Which station are you on?" with "This session is locked — unlock to continue"
twice and "No station here is yours to work". Try again lists the stations, one stale lock line stays, and
the screen asks for a station again. Reproduced twice.
