# SCRUM-739: review an ordinary sale's held gateway QR

Staging proof and cleanup passed on 4 November 2026, 06:02:27-06:06:24
Bangkok. Jira image publication is pending; the ticket remains Testing.

Source and live platform commit: `dde3887aa3162d6b6c006c4135ad2ef20e163b6c`.
[Main CI 41731884131](https://github.com/vickyydev/oto-platform/actions/runs/41731884131)
passed on its first attempt. API, POS web, old POS, Console, launcher and
booth were live on this exact commit before and after the proof. OTO App
remained at 773fd25f: its complete actual build context is byte-identical at
both commits. Its main job was path-skipped; the earlier full branch run
checked it. See [live receipt](live-before-proof.json),
[unchanged app receipt](unchanged-oto-app.json), and [main CI](main-ci.json).

The till now reuses SCRUM-732's bank-slip/gateway review for an ordinary
gateway QR awaiting a person. The existing Shop is reachable on a phone.
The old sale-writer pin that deliberately hid this button was changed on
purpose. Expiry holds, the confirmation permission and the box PAX route
remain guarded. No API runtime, schema, setting or displaySession changed.

## Staging result

The simulator reported a payment after the QR closed. Every sale stayed
tendering with no receipt while awaiting staff confirmation. Both answers
stayed disabled without the note and acknowledgement. Money taken then
finished the sale exactly once. The phone Shop also survived a staff lock
with the same attempt. Independent database reads before and after cleanup
found one approved payment, one answer audit and one finalisation audit each.

| Sale | Width | Receipt | Finished sales | Payments |
|---|---|---|---:|---:|
| food | 1440px desktop | Z30-000001 | 1 | 1 |
| shop | 1440px desktop | Z30-000002 | 1 | 1 |
| tickets | 1440px desktop | Z30-000003 | 1 | 1 |
| food | 390px phone | Z30-000004 | 1 | 1 |
| shop | 390px phone | Z30-000005 | 1 | 1 |
| tickets | 390px phone | Z30-000006 | 1 | 1 |

Every test sale was one baht, using only dedicated ZZ TEST products and a
no-credit/no-gate ticket package. No real bank payment, SMS, person or park
device was involved. No real box address was saved. The 57 API setting
fingerprints and all deployment identities were unchanged.

## Cleanup

The exact box, till, two products, two categories and ticket package are
archived. Both unused synthetic bands are revoked. Six synthetic payment
alerts and one inactive working document were retired with audit entries.
No wallet credit was created. All seven queue/session counts are zero,
sign-out reads 401, and all six financial records remain readable.

Independent proof job: `job-dbl6gaijnfac73eqcdr0`.
Retirement job: `job-dbl6gtjm8hqs73cfhg5g`.
Independent cleanup read: `job-dbl6heqjnfac73eqgck0`.
The [complete result](staging/mw1amatj/result.json) retains the exact
identities, audits, unchanged settings and cleanup receipt. The existing
confirmation does not automatically resolve its Health alert; this proof
retired only its own synthetic alerts and adds no production rule.

## Opened images

All twelve images below were opened through view_image. Their repository
copies match the inspected source bytes; see
[inspection fingerprints](opened-staging-images.json) and
[publication manifest](staging-proof.json). Password input alone is masked.

- [s739-food-desktop-02-held.png](../../jira-comments/attachments/SCRUM-739/s739-food-desktop-02-held.png)
- [s739-food-desktop-03-review-locked.png](../../jira-comments/attachments/SCRUM-739/s739-food-desktop-03-review-locked.png)
- [s739-food-desktop-04-review-ready.png](../../jira-comments/attachments/SCRUM-739/s739-food-desktop-04-review-ready.png)
- [s739-food-desktop-05-completed.png](../../jira-comments/attachments/SCRUM-739/s739-food-desktop-05-completed.png)
- [s739-food-phone-04-review-ready.png](../../jira-comments/attachments/SCRUM-739/s739-food-phone-04-review-ready.png)
- [s739-shop-desktop-04-review-ready.png](../../jira-comments/attachments/SCRUM-739/s739-shop-desktop-04-review-ready.png)
- [s739-shop-phone-02b-staff-locked.png](../../jira-comments/attachments/SCRUM-739/s739-shop-phone-02b-staff-locked.png)
- [s739-shop-phone-04-review-ready.png](../../jira-comments/attachments/SCRUM-739/s739-shop-phone-04-review-ready.png)
- [s739-shop-phone-05-completed.png](../../jira-comments/attachments/SCRUM-739/s739-shop-phone-05-completed.png)
- [s739-tickets-desktop-04-review-ready.png](../../jira-comments/attachments/SCRUM-739/s739-tickets-desktop-04-review-ready.png)
- [s739-tickets-phone-04-review-ready.png](../../jira-comments/attachments/SCRUM-739/s739-tickets-phone-04-review-ready.png)
- [s739-tickets-phone-05-completed.png](../../jira-comments/attachments/SCRUM-739/s739-tickets-phone-05-completed.png)

## Validation and limits

Complete local gates passed: 447 API files / 6,224 tests, with 401 inherited
skips and four existing TODOs unchanged; 1,776 POS tests; eleven till browser
journeys; 357 Console cases; workspace tests, types, lint, contracts, tools
and builds. API typecheck emitted no diagnostics. Evidence is in
[complete-local-gates](complete-local-gates/receipts.json) and
[the earlier gate receipt](gate-checkpoint-0449/receipts.json).

Branch CI 41723536314 initially timed out starting the existing consent
browser harness. That complete six-case file passed unchanged on an isolated
checkout of the exact SHA, and its one permitted failed-shard rerun passed.
The original failure is retained. No timeout, retry or assertion changed.
Main CI then passed first time. No-money and permission-refusal paths are
automated-test evidence; these staging screenshots show Money taken.

Physical printing, real bank payments and a separate customer-display
device remain unproven by this unit. The visible no-printer warnings are
retained. Local precursor runs and their initial harness failures remain in
local-native, staging-rehearsal and local-gates; they are not staging proof.
The final staging helpers are backed up in prepared-staging-harness.
