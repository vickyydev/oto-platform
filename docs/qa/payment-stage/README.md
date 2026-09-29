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

The checked payment follow-ups and SCRUM-285 guard are assembled on the
latest main checkpoint as five linear source commits: wording `2899439`,
inquiry capability `4817aa1`, partial reversal `f1b122e`, invoice scope
`c215757` and forced-offline guard `346bfae`. Main release checkpoint `fe9c683` landed that
combined source on origin/main; the original work branches remain preserved.
All **305 affected existing-file checks pass**: API terminal 27, gateway 44,
cash 26, sales 58, station session 35 and guarded routes 9; POS writer 58,
shared payments 22 and database migration 26. One local guarded-route suite
hit a PostgreSQL port collision; its isolated rerun passed all nine checks.
API/POS/DB/shared typechecks and full package lint, POS production build,
database schema verification against 0029 and independent combined review pass.
Temporary verification configs are removed. No new suite or dependency.

Shared contract names remain unchanged. Optional `inquirySupported` hides
unsupported GHL card inquiry; optional `reversalPending` retains the original
reservation and blocks abandonment/zero-close until explicit false after a
successful reversal. Forward migration 0029 permits repeated hardware invoice
numbers, keeps device-less gateway invoices unique and fences all five gateway
reads from hardware attempts. It does not rewrite payment rows. Roll forward
after 0029 rather than reverting behind these matching filters.
The offline guard runs before idempotency and refuses trading only for the
authenticated station's persisted forced-offline virtual box. Reporting,
setup, Go online and box callbacks remain available with original permissions.

Exact-main [CI 36565169997](https://github.com/vickyydev/oto-platform/actions/runs/36565169997)
on `fe9c68374449a867254992c0f0e4d869876b6b34` stopped with zero steps.
Check job 109395214284 explicitly reports failed recent account payments or
an insufficient spending limit. This is an external Actions availability
block, not a source-test failure. Render's normal checksPass gate stays intact;
all five platform services were rechecked LIVE on 0468c38. No corrected source
or migration is deployed yet. Restore Actions billing/spending availability,
rerun 36565169997, then deploy its tested source and complete isolated staging
proof, named Jira screenshots and the new CI artifact delivery. Documentation
checkpoints do not change the tested release source. SCRUM-206 remains In Progress
pending SCRUM-269 local till transport and SCRUM-201 separate display acceptance.
SCRUM-285 remains Testing until named staging screenshot evidence is attached.

The original simulated partial outcome is still **BROKEN/unresolved**:
sale `01a0ecb8-f168-7b26-96e4-9ccaabe14cbf`, attempt
`01a0ecb8-f870-798f-b893-37d9871d4bcd`, run `0d008153` on virtual-1.
Its command reports partial approval, but the cloud attempt remains pending
with no rescue VOID. Eight dedicated inventory rows remain retained. Existing
controls cannot retrieve the lost final result after restart or safely replay
it. Do not repeat SALE, fabricate a callback, confirm no money or archive these
records. The logged invoice unique violation and old-migration regressions
support the corrected callback path; they do not establish recovery of this row.

The ignored helpers `test-results/payment-stage-native-proof.mts` and
`test-results/offline-guard-proof.mts` were cleared by a temporary Playwright
output-path mistake during the later SCRUM-201 check. Their old commands are
not runnable. Committed reports/screenshots and the retained simulated payment
are intact. Rebuild and review those helpers before post-deployment use, with
dedicated absolute output directories and explicit protection of the IDs above.
After corrected source is LIVE, prove fresh partial reversal, GHL confirmation,
QR-disabled refusal and zero-price checkout in an isolated report. Completion
applies only to requested cases. Prove the offline guard on independent
disposable fixtures and restore its forced-offline flag afterward. These
proofs must not change the retained historical failure into a success.

Green CI packed `oto-box-0.1.0-0468c38.tgz`. The archive and its `.tgz.sha256`
are on the Desktop; both downloaded and delivered hashes were verified:
`044edbb9a474a945eadcc91e82598bee86b7b3f472e1630b79dceabcd1fbf1ea`.
Older pairs are in `old-oto-box-releases`. No physical Pi update was performed.

## Release checkpoint follow-ups - 29 September late evening

Three fresh native follow-ups pass on POS88140af/API85d35e0 (unchanged payment
source across the API rollout). Automatic partial approval reversal precedes
one cash collection. Disabled F&B QR produces409QR_DISABLED_FOR_STATION before
an attempt, then cash completes. Zero-value shop finalises without a tender.
Reviewed staging attachments10917-10920 respectively:
SCRUM-206-shop-partial-refused-completed.png,
SCRUM-206-fnb-qr-disabled-refused.png,
SCRUM-206-fnb-qr-disabled-completed.png,
SCRUM-206-shop-zero-completed.png.
The disabled-QR public wording still said checking in that version; the current
display slice directs refused submissions to staff instead. Completed dedicated
fixtures were archived; native receipts remain as staging audit records.

Initial partial verification had two helper errors: public attempts deliberately
omit deviceId, and the canonical outcome is partial_approval. The actual one SALE
and one approved VOID were verified. That known-reversed unpaid proof was voided
and its four owned setup rows archived, without replaying SALE.

The rollout interrupted a new GHL no-response simulation. Its exact retained
sale01a0edf5-de2e-733c-b08f-1b33d4e09928 and
attempt01a0edf6-6f88-787a-9dc3-6091c2c2428a need post-deploy recovery. This differs
from the older retained uncertain partial, which stays untouched. Recovery source
passes31 existing terminal tests and API typecheck/lint. It preserves reservation,
never resends SALE, records missing-result diagnostic after150seconds, and offers
inquiry only when frozen protocol/reference allow it; otherwise staff confirmation.
A genuine late response can settle an unresolved attempt; duplicates cannot
settle twice. Commands remain running until their actual acknowledgement.
This current206 fix is checked, not yet deployed or staging-proven.
