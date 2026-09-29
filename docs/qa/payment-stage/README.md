# Online till payment stage - 29 September 2026

SCRUM-206 remains In Progress. Online source `0468c38` is live on API, POS,
Console, Launcher and Booth after
[green CI 36547262414](https://github.com/vickyydev/oto-platform/actions/runs/36547262414).
The OTO App remains `c416065`. All 53 existing sale-writer checks, POS
typecheck, full package lint and build pass.

The native staging proof uses the actual POS screens to create carts, request
payments and complete sales. Setup and simulator results use the public staging
API. Temporary stations and simulated devices are on the existing virtual box;
the physical booth and existing payment methods are unchanged. No bank payment
or physical printing is claimed. Completed test sales remain in audit history.

Six cases pass: desktop cash/change, handheld cash/manual split, food QR/
reconnect, shop terminal approval, decline/cash fallback and timeout/inquiry/
audited staff confirmation. [Sanitised results](staging-results.json) retain
the six facts and the unresolved partial outcome. The full proof is incomplete.

Cash staging screenshots are already attached to SCRUM-206 as 10868-10869:
`SCRUM-206-native-desktop-cash-change.png` and
`SCRUM-206-native-desktop-cash-completed.png`.

| Native staging evidence | Jira attachment |
|---|---|
| [Cash received and change](SCRUM-206-native-desktop-cash-change.png) | 10868 |
| [Cash completion](SCRUM-206-native-desktop-cash-completed.png) | 10869 |
| [Handheld split balance](SCRUM-206-native-handheld-split.png) | 10870 |
| [Manual-card entry](SCRUM-206-native-handheld-manual.png) | 10871 |
| [Split completion](SCRUM-206-native-mobile-split-manual-completed.png) | 10872 |
| [Gateway QR and countdown](SCRUM-206-native-food-qr-pending.png) | 10873 |
| [Interrupted connection retains the attempt](SCRUM-206-native-food-qr-reconnect.png) | 10874 |
| [QR completion after reconnect](SCRUM-206-native-fnb-qr-completed.png) | 10875 |
| [Approved terminal completion](SCRUM-206-native-shop-approved-completed.png) | 10876 |
| [Decline returns to method selection](SCRUM-206-native-shop-declined.png) | 10877 |
| [Unknown terminal outcome keeps collection locked](SCRUM-206-native-shop-inquiry-confirm-pending.png) | 10878 |
| [Staff evidence and acknowledgement](SCRUM-206-native-shop-inquiry-confirm-confirmation.png) | 10879 |
| [Same-attempt confirmation completion](SCRUM-206-native-shop-inquiry-confirm-completed.png) | 10880 |
| [Unresolved partial outcome - failure evidence](SCRUM-206-native-shop-partial-refused-failure.png) | 10881 |

The [attachment map](jira-attachments.json) records the uploaded files. All
images were reviewed; approval fields are masked. The printed-item warnings
are expected because these disposable payment stations have no bracelet or
kitchen printer assignment. They do not establish physical printing acceptance.

The customer display in this proof is the native same-page preview or handheld
handoff. SCRUM-201 independent display acceptance and SCRUM-269 local till
transport are NOT BUILT; this online evidence does not satisfy either.

A proof assertion initially assumed a simulated terminal would report the
physical provider. Its already approved sale was retained and closed using
explicit zero tender; no second payment was collected. It is recorded as
recovery, without claiming native completion. A fresh, separate native approval
case subsequently passed. Earlier unused QR fixtures were expired through the
official simulator, checked for zero accepted money, voided and archived.
One timeout proof also hit the real inactivity lock before confirmation. Its
unused simulated outcome was resolved without money and voided. The resumed
proof kept ordinary keyboard activity while waiting; the lock setting was
unchanged.

The simulated GHL card path exposes an unsupported inquiry control on the live
UI. Optional `PaymentAttemptView.inquirySupported` fixes that on branch
`fix/payment-request-copy` (`9a54d58`), without changing provider names.
The GHL confirmation case is deferred until this source deploys.

Partial approval is **BROKEN in this staging run**. The simulated terminal
command reports partial_approval, but sale `01a0ecb8-f168-7b26-96e4-9ccaabe14cbf`
retains a sent_to_terminal attempt and no rescue VOID appears. The scoped
process was stopped before generic cleanup could declare no money incorrectly.
Eight dedicated rows from run `0d008153` remain retained. No second collection,
refund or no-money confirmation was performed. The virtual box log contains
a generic outcome-refusal warning without exposed HTTP status, so the exact
callback cause remains unresolved. Do not repeat collection or archive its
inventory until that outcome is recovered. QR-disabled and zero-price native
cases also remain unverified.

The same branch carries a checked partial-reversal reservation fix: pending,
failed, unknown and unvoidable reversal facts keep the original amount reserved;
sale void and zero-balance close refuse; the UI stays locked and polls until
explicit `reversalPending:false`. An omitted flag cannot clear known pending
money. Existing terminal/cash/sales/writer/shared-payment files pass **189
checks** (25/26/58/58/22), with API/POS/shared typechecks and full package lint
passing. No new suite, migration or dependency. This fixes the reservation gap
after an accepted partial report; it does not claim to fix the separate live
callback problem. Branch HEAD is `d43a92b`; neither this nor the inquiry/wording
follow-up is deployed. Latest CI 36558144943 did not start a step because of
GitHub billing/spending availability.

SCRUM-285's forced-offline cloud guard is checked on branch `fix/offline-proof`
at `d38eb3e` (44 existing API checks, typecheck and full package lint pass).
It is Testing and not live. Both new branch CI runs were prevented from starting
by GitHub account billing/spending availability. Exact-source CI, main landing,
deployment and SCRUM-285 staging evidence remain required.

Green CI packed `oto-box-0.1.0-0468c38.tgz`. The archive and its `.tgz.sha256`
are on the Desktop; both downloaded and delivered hashes were verified:
`044edbb9a474a945eadcc91e82598bee86b7b3f472e1630b79dceabcd1fbf1ea`.
Older pairs are in `old-oto-box-releases`. No physical Pi update was performed.
