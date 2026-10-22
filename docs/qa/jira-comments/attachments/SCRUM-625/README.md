# SCRUM-625 Reports acceptance

Jira is Deployed with acceptance comment 12520 and seven inspected staging attachments. The owner retains Done acceptance. Source `448dd0d6e6247a7656dd245eee7cc5aef0e14014` passed all six jobs in [CI 39867146335](https://github.com/vickyydev/oto-platform/actions/runs/39867146335) and is live automatically on API, Console and POS. Parent SCRUM-618 remains In Progress.

Admin now hosts the five approved native report panels. The existing Booth report addresses and POS wrappers remain available. Reachable report parks and canonical trading-day defaults come from the existing analytics summary, without a branch-directory prerequisite. The Q9 corrections fence corrupt operator/park references in the two analytics readers; formulas, date/source/status semantics, response shapes, valid cross-park vouchers and all nineteen CSV mappings remain unchanged.

| Staging image | Native check | Captured UTC |
|---|---|---|
| [SCRUM-625-01-sales-phone390.png](SCRUM-625-01-sales-phone390.png) | native Sales with current canonical trading dates | 2026-10-22T23:07:02.283Z |
| [SCRUM-625-02-profitability.png](SCRUM-625-02-profitability.png) | native profitability without changing cost rules | 2026-10-22T23:07:09.332Z |
| [SCRUM-625-03-discounts.png](SCRUM-625-03-discounts.png) | native discount and comp totals | 2026-10-22T23:07:16.849Z |
| [SCRUM-625-04-tax-vat.png](SCRUM-625-04-tax-vat.png) | native VAT summary; receipt detail hidden | 2026-10-22T23:07:24.547Z |
| [SCRUM-625-05-wallet-promo.png](SCRUM-625-05-wallet-promo.png) | native wallet and promo totals; all detail keys hidden | 2026-10-22T23:07:32.306Z |
| [SCRUM-625-06-booth-report-oldalias.png](SCRUM-625-06-booth-report-oldalias.png) | native old Booth report address and trading-day filters | 2026-10-22T23:07:38.888Z |
| [SCRUM-625-07-radar-tile.png](SCRUM-625-07-radar-tile.png) | native Radar offer; no handoff issued | 2026-10-22T23:07:44.811Z |

The fresh read-only run passes ten checks, keeps the demo account's park and preferences unchanged and closes with sign-out 200 followed by /me 401. All seven captures follow the exact-source deployments. Detail cells and identity are hidden, including late-arriving rows. Aggregate report values are observations and may change with live trading. No fixture, business setting, payment, SMS, check-in or equipment action was made. CSV generation/download behavior and Radar handoff request/navigation behavior have automated coverage using controlled responses. Actual Radar arrival was not verified. Staging checks only opened native controls and the Radar offer. The images do not claim to show complete long reports.

The immutable local gate verifies 3,578 inputs around each suite. All sixteen compiler tasks, five builds, generated API and repository guards pass; full lint has zero errors and eight inherited warnings. Full API recovery shards pass 4761 tests with 401 inherited skips and 5 todo. POS passes 1,433, built browsers 165, AdminScreens 117, Console 227 plus three inherited todo, API types 10, Box 749 and the remaining package suites pass. The affected whole files and four route guards pass again after rebasing.

The interrupted original API logs have no final receipts and remain incomplete. One earlier Booth empty-pull assertion failed with no confirmed cause; the unchanged whole 39-case recheck passes, followed by the fresh full API recovery. Earlier product failures, the initial POS source-inspection failure and both incomplete voucher-fixture attempts remain distinct from successful replacements. No append-only rule or guard was weakened. Seven local mock-backed geometry frames and ten offline helper checks establish proof preparation only; those local images are not staging attachments. The parent phase's actual Till price/tender/tax round trip remains separate.
