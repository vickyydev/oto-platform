# Handover - where this is, and what to do next

## STOP POINT - 6 October 2026 - SCRUM-495 first verified slice

**6 October 2026, SCRUM-495 first verified slice:** Manual percentage discounts use the prototype whole-baht rounding; fixed discounts, promos and taxes retain their existing policies. Versioned offline replay preserves earlier satang-priced sales and quarantines unknown future engine versions before writing money. The exact three document choices, retained promo inputs, cash confirmation wording, kitchen order notes and stock guidance are restored; the inert badge/PIN unlock field is removed. Root verification: shared pricing 131, POS 87, API 57 and box 37 existing tests pass; all four package typechecks, changed-file lint, POS production build and diff check pass. This source is not yet deployed. SCRUM-495 remains In Progress for History, payment methods, Add time, wallet and shop-display work. The owner approved both Add time modes. EOD source 63d7307e is staging-verified; CI remains pending.

## STOP POINT - 6 October 2026 - all-payments export ready for final proof

## STOP POINT - 6 October 2026 - final export proof and QA cleanup

**6 October 2026, final End of Day staging proof saved:** API and POS 63d7307e are live. The actual all-payments CSV download contains three approved simulated card/QR rows, including the gateway invoice with blank TID; reviewed screenshot 11-staging-all-payment-export.png is attached to SCRUM-215 as 11274. The temporary QA manager grant was revoked; the isolated box was disabled and archived, its station/three devices and park archived. Financial/audit records and prior unresolved payments remain. SCRUM-215 stays Testing pending CI37378514082; no green CI claim. SCRUM-493/495 remain In Progress. The owner approved both selected/scanned-band and count-only Add time options, recorded on 495/497. Next: finish CI gate, then land verified SCRUM-495 slices and continue the remaining mismatch groups.

## STOP POINT - 6 October 2026 - all-payments export ready for final proof

**6 October 2026, complete settlement export verified locally:** The all-card-and-QR CSV now includes approved till gateway payments with no terminal ID and preserves per-TID exports. Existing API checks 9/9 and POS 21/21 pass; API/POS/shared typecheck, lint and POS build pass. Sequential print raster files pass 268/268 without changing test assertions or timeouts, addressing two repeated CI worker-reporting timeouts. Final staging cards 11271-11273 cover cash movement, discrepancy/corrected close, Health, Activity and the live import job. Next: deploy API then POS for all-payments export, capture its three-row fixture CSV, archive only the QA fleet/revoke the temporary QA grant, then complete SCRUM-215 when final verification is green. SCRUM-493 stays In Progress; SCRUM-495 pricing/proof/UI and History/tender slices are progressing in isolated worktrees. The partial Add-time band selection question is recorded on SCRUM-497 and in docs/qa/scrum-493-open-decisions-2026-10-06.md.

Integration worktree: oto-pos-eod-round-2. API b61448cf is live;
POS/Console 581c7c4a are live. The latest CSV slice is seven explicit
files; print vitest config is the bounded CI resource follow-up.
Exact staging facts: docs/qa/end-of-day/round-4-staging-2026-10-06.md.
Temporary QA grant 01a10df8-dfdc-7d99-9b4b-06ba0c146448 must be revoked
from seeded manager 01a0c9ae-5377-7b34-a9ab-22bf8086f5f7 after proof.
Only archive the branch/box/station/devices named in the round-2/3 notes.
Keep immutable QA finance/audit history and all earlier unresolved payments.

SCRUM-495 small source is in oto-pos-s495-small, including engine bump and
legacy offline rounding preservation; not yet landed. History/corrected
orders are in their separate workflow. Other tenders/used-method archive
now own forward-only migration 0060; no other workflow may allocate 0060.
The original checkout remains read-only. Parent 493 cannot close yet.

## STOP POINT - 6 October 2026 - final End of Day import job ready

**6 October 2026, final End of Day follow-up:** API/POS/Console 581c7c4a are live. The isolated QA park recorded a witnessed THB100 safe drop and approved THB60 paid-out; a THB50 count difference was corrected before the day closed with expected/actual minus THB160 and its own receipt. The Health demo control is visible; its mutations remain tested on disposable databases. The fixture importer now runs as an actual on-demand operations job with atomic import/audit/run success, harmless replay and safe failure recording; 8 affected API tests pass. CI37373685349 exposed a missing settlement-line parent mapping in the schema contract (fixed; 14/14 checks pass) and a print-worker reporting timeout. Current CI is not green. Next: deploy the import job, capture final Activity/Health/close and job evidence, finish QA cleanup and SCRUM-215 closure, then land SCRUM-495 prototype parity with versioned offline rounding compatibility.

Worktree remains oto-pos-eod-round-2. Only the settlement import job/API route/test,
schema-shape parent contract and checkpoint/audit docs belong to this slice.
No migration. Source tests8, DB shape14, API/DB typecheck and scoped lint pass.
The staged job preserves Console response and uses a real one-shot ops_run;
no automatic SFTP or production file support is claimed. API deploy follows
push; frontends already at 581c7c4a need no new deployment for this API-only change.

QA branch clock was changed to 00:00 by guarded job-db21dgek1f9s738o8gk0
to permit an isolated 6 October close without touching the prior 5 October close.
A temporary branch-manager grant on this QA branch permitted witness/approver
selection; revoke it during cleanup. Source/staging specifics and screenshots
are in round-3 note and pending round-4 note. Physical box credentials live only in memory.
Do not seed/reset shared Central or alterprior unresolved payments.

SCRUM-495 small slice is ready in oto-pos-s495-small, under compatibility review:
manual rounding needs an engine version bump and acceptance of already-queued legacy
facts. No SCRUM-495 source has landed yet. Mobile History/corrected order follows in its
isolated workflow. SCRUM-214 still needs 216; 493 still needs 495/496/498/497.

## STOP POINT - 6 October 2026 - settlement proof and round-4 release checkpoint

Use oto-pos-eod-round-2, feat/eod-round-2-review. API abc007af and
POS/Console de2f90ce are live. Settlement proof is attached on SCRUM-215
as 05-staging-terminal-settlement.png (11268), 06-staging-settlement-import.png
(11269), 07-staging-receipt-refresh-phone.png (11270). Exact fixtures and
limits: docs/qa/end-of-day/round-3-staging-2026-10-06.md. Physical terminal
settlement is unsupported; bank import uses the documented fixture only.

Round-4 source adds wallet/voucher/refund demo scenarios, transactional
advisory-lock seed replay safety and the guarded/audited Health demo.day
control. The staging park-switch race is repaired with server-confirmed
selection and stale station response guards. Existing EOD/ops tests 52/52,
POS lane/receipt 23/23; touched typechecks/lint/build pass. No staging
demo seed/reset was run. Land this explicit slice, deploy API before
POS/Console, verify Health visibility and park-switch behavior, then finish
isolated cash-movement/closing audit proof. Keep prior unresolved payment
fixtures and real park records untouched. CI37373685349 is running.

SCRUM-495 is In Progress in oto-pos-s495-small, independently preparing
small prototype parity repairs; do not land before the End of Day release.
SCRUM-496/498 still follow; 497 defaults remain until answers arrive.
SCRUM-214 cannot close just because 215 closes: child216 analytics is To Do.
Older CLOUD_HANDOVER close214 wording is superseded by this live Jira audit.
Parent 493 stays In Progress until all of its mismatch work is verified.

## STOP POINT - 6 October 2026 - settlement staging walkthrough running

API, POS and Console abc007af are live; 0059 applied. The local simulated
box has been restarted from the matching source. Two terminal simulations
approved; guarded fixture job job-db21156i0phs73cspo0g recorded the exact
references plus one gateway fixture in the isolated ZZ TEST park. Earlier
fixture attempts failed the invoice-format constraint and rolled back;
the corrected fixture succeeded. No real payment or real park record changed.

The match views now retain a visible terminal reference when no gateway
reference exists. POS 11/11 and both app typechecks/lint/build pass. Land
this small follow-up and redeploy only frontends. Then drive settlement,
fixture import, CSV and queued-receipt refresh from the signed-in screens.
Round-4 seed work is isolated with the API lane: wallet/voucher/refund
scenarios, no migration. 495/496/498 remain after End of Day; prototype
source maps are prepared. SCRUM-215 and parent493 stay In Progress.


## STOP POINT - 6 October 2026 - settlement integrated for release

Root checkout oto-pos-eod-round-2 now holds all 37 explicit files from the
three settlement worktrees, plus demo-reset.ts to delete settlement facts
before their referenced payment attempts. No prohibited paths are staged.
Migration 0059 was generated on 0058 and remains unapplied on staging.

Integrated checks: API EOD 39/39, POS 27/27, box terminal/runner 36/36,
six touched-package typechecks, scoped ESLint and POS/Console builds pass.
The final settlement run including the reset follow-up passes 8/8. Earlier box regression coverage was
143/143 and the disposable Console import phone smoke passed 1/1.
Exact contracts/limits are in ROUND_3_API_NOTES, ROUND_3_BOX_NOTES and
ROUND_3_UI_NOTES under docs/progress/plans/cash.

The review fixed durable callbacks without queue redelivery, matching
and reference retention, concurrent duplicate evidence, original-command
box ownership, schema-sized callback bodies, and uncertain UI retry IDs.
The original receipt status poll is included. Physical Digio/GHL settlement
still returns unsupported honestly; this release proves simulated batches
and the documented H/D fixture, not real bank settlement files.

Next: final reset check, explicit source commit, pull latest main and push
with Jira SCRUM-215 progress/status update. Deploy API first (0059), then
POS/Console, replace the local staging simulator with this source, prove
terminal batch, PAX confirmation, fixture mismatch/import, CSV, audit and
receipt status refresh. Finish seed:demo-day wallet/voucher/refund coverage
and the round-4 close walkthrough. SCRUM-215 and SCRUM-493 remain In Progress;
SCRUM-494 is Deployed, 495/496/498 still require the prototype mismatch work.

## STOP POINT - 6 October 2026 - round-2 staging evidence saved

Use oto-pos-eod-round-2 on feat/eod-round-2-review; main source 33681345 is
live on API and POS. Original checkout remains read-only. Real staging
proof is attached on SCRUM-215 as 02-staging-close-safeguards.png (11265),
03-staging-close-reprint.png (11266), and 04-staging-receipt-output.png
(11267). The latter is explicitly simulated printer output, not paper.
QA details and exact isolated fixture IDs are in
 docs/qa/end-of-day/round-2-staging-2026-10-06.md.

Round-2 source passed CI 37356476121 before the docs-only rebase. Main run
37368987245 could not acquire a hosted runner and has been retried. Do not
call that run green. SCRUM-215 remains In Progress; rounds 3 and 4 remain.
The closed-receipt queued-status refresh defect was repaired in the UI
slice and passes 11 existing hook checks; staging retest follows landing.

Uncommitted settlement work is isolated in oto-pos-eod-settlement-api,
oto-pos-eod-settlement-box and oto-pos-eod-settlement-ui, all based on
33681345. API owns migration 0059; do not generate another migration with
that number. Review found reference-matching/preservation, box reassignment
ownership and concurrent matching edges; the API slice is fixing them.
Box durable callback retry now survives a restart with an empty platform
command queue; 143 affected checks pass. Physical terminal settlement is
explicitly unsupported until verified vendor wire responses are available.
Fixture import is not a claim of production 2C2P file compatibility.

Next: finish integration review, copy explicit paths into this checkout,
run affected tests/typecheck/lint/build, commit/push with Jira update,
deploy API before POS/Console, and capture real settlement/import/CSV and
receipt-refresh evidence. Keep the isolated simulated box online for this
walkthrough; archive its QA branch/station/devices/box afterward. Do not
close or reseed real park records. Then complete round 4 and SCRUM-214/215,
followed by 495, 496, 498 and 497 per CLOUD_HANDOVER before closing 493.

## STOP POINT - 6 October 2026 - verified round-2 source ready to land

Work from clean oto-pos-eod-round-2 on feat/eod-round-2-review. Rebased
round-2 source 057e7023 is application/package-identical to green CI
37356476121 at 9d5a50cd. Migration 0058 follows applied 0057. Main CI
37352932512 is green and source 59cb2cf5 is live on platform staging.
SCRUM-494 and SCRUM-213 are now Deployed with named staging cards attached;
stock follow-up card 11264 explicitly labels the date-boundary test proof.
No real park stock was reseeded or changed.

Receipt review: locked figures, date and channel keys are immutable;
descriptive terminal, method and account names are resolved like existing
receipts. No extra schema change is required by the round-2 brief.
Next: push this verified slice to main with a SCRUM-215 comment/status
check, deploy API before POS, then use labelled staging fixtures for
provisional close, manual occupancy resolution, manager override, receipt
and reprint. Do not close the park's real day for a test. Attach actual
desktop and phone evidence. Rounds 3 (settlement) and 4 (demo-day walkthrough)
remain before SCRUM-215/214 can close. The prepared 495 source map confirms
17 remaining entries; continue by the recorded priority after End of Day.
SCRUM-497 has no answers; preserve prototype defaults and record uncertainty.


## STOP POINT - 6 October 2026, 01:33 Bangkok - SCRUM-494 proof filed

Use clean `oto-pos-voucher-slip` on `feat/till-consistency-493` for the
SCRUM-494 evidence checkpoint. Five reviewed real-staging cards for all nine
items are in `docs/qa/jira-comments/attachments/SCRUM-494/` and attached to
the Jira ticket with a comment naming every file. They redact booking and
band credentials. Card 1 labels the expired-document half as existing-test
evidence because staging UI cannot create a past-expiry verification. POS
staging is live at `9673107c`; its signed-in phone empty F&B cart no longer
shows a false pricing warning. SCRUM-494 is Testing, awaiting CI for
`59cb2cf5` before Deployed; the CI run is still in progress, not green.

The separate stock trading-day seed repair is on main at `59cb2cf5` under
SCRUM-213, which is In Progress. Its two affected API suites pass 16/16
locally. CI must pass before the stock ticket returns to Deployed. The
database platform-sync suite could not start its embedded database in the
first local attempt and was not claimed passing.

SCRUM-215 round 2 was saved separately at `9d5a50cd` on
`feat/eod-round-2-review` in `oto-pos-eod-round-2`. It is not on main or
staging; the branch's own newest STOP POINT and ROUND_2_BRIEF.md carry the
details. Next: finish CI for SCRUM-494/213, move them only with honest staging
evidence, then rebase/review the End of Day branch and land its verified
round-2 slice before rounds 3 and 4. Every push gets a same-turn Jira comment
and status check. Never print or attach credentials or secret values.

## STOP POINT - 6 October 2026, 01:27 Bangkok - End of Day round 2 isolated

The clean `oto-pos-eod-round-2` worktree on `feat/eod-round-2-review` holds
the round-2 transplant from `wip/eod-round-2-inflight`; do not use the
original dirty checkout. The branch remains based on main `59cb2cf5` and
has not been landed or deployed. The unrelated arrival audit file in the WIP
snapshot was excluded. Migration 0058 was generated against main's 0057
snapshot, then given the manual append-only occupancy trigger; 0055-0057
were not changed. Its four database migration checks pass.

The focused review found and fixed these round-2 close gates: a failed
outbox row is still undelivered; a disabled box with pending records must
hold the day; a manual-resolution action ID cannot replay with a different
day, reason or note; and close/reprint must print on the counter taken by
the signed-in session. Round-2 API checks pass 28/28, round-1 API checks
44/44, POS End of Day checks 19/19, shared End of Day checks 11/11. Database,
API, POS and shared typecheck, scoped lint, POS build and diff check pass.
No staging deployment or screenshot exists for round 2 yet. The reviewer
also observed that the receipt renderer looks up present-day terminal and
payment-method labels; decide whether to freeze those names at close before
landing. Historical manual resolutions use the day-end effective timestamp
and the actual action time in `createdAt`; keep that distinction explicit.

Next: inspect the full landing list and receipt behavior, checkpoint/push
this branch with a same-turn SCRUM-215 progress comment, then rebase on
latest main after SCRUM-494's proof commit. Land only after review and tests,
deploy API before POS, drive signed-in desktop and phone staging flows,
attach and name screenshots on SCRUM-215. Then build rounds 3 and 4 from
the cash plan. SCRUM-494 remains Testing with five real staging cards already
attached; CI at `59cb2cf5` is still running. No ticket is Deployed from this
branch checkpoint.


## STOP POINT - 6 October 2026, 01:00 Bangkok - stock CI repair

Work in `oto-pos-voucher-slip` on `feat/till-consistency-493`; the original
checkout is read only. POS staging is live at `9673107c`; the signed-in phone
F&B empty cart no longer displays the false platform-pricing warning. Five
reviewed real-staging cards for SCRUM-494 items 1-9 are ready in
`docs/qa/jira-comments/attachments/SCRUM-494/`. Booking references and band
credentials are covered; the expired-document branch in card 1 is supported
by existing tests because staging cannot create a past-expiry verification.

CI `37342943714` failed two stock fact tests. Their 18-unit gap reproduced
after midnight in Bangkok: the full stock seed used calendar date for opening
movements, while stock activity and reports use the branch's 05:00 trading
boundary. `packages/db/src/seed/stock.ts` now uses the branch timezone and
business-day start with the shared date helper; its one caller no longer
passes a hard-coded timezone. Both affected API suites pass (16/16), database
and API typecheck and scoped lint pass. The database platform-sync test suite
could not start its embedded database locally; its seven tests were skipped,
not passed. CI for prior POS head `9673107c` is still running. This follow-up
belongs under SCRUM-213, not SCRUM-494.

Next: checkpoint the stock fix with a same-turn SCRUM-213 status/comment,
push, and inspect CI. Attach all five cards to SCRUM-494, name them in a
plain-language comment, and move SCRUM-494 to Deployed only after its source
and staging evidence are verified. Then proceed with SCRUM-215 rounds 2-4
per CLOUD_HANDOVER section 3. Every push needs same-turn Jira status and
comment. Never print or attach secret values, band credentials, booking
references, or pickup codes.


## STOP POINT - 6 October 2026, after midnight - SCRUM-494 nine-item proof

Continue in the clean sibling worktree `oto-pos-voucher-slip` on
`feat/till-consistency-493`; keep the original dirty checkout untouched.
API staging is `8db35d3e`, POS staging is `326ad33c`. The signed-in normal
customer-display registration and photo flow passed: file creation 200,
same-origin photo content PUT 204, registration photo attach 200. A labelled
Nanny child was attached to a Tourist cash sale, switched from Drop-Off to an
on-shift synthetic Nanny, and paid ฿1,020 (฿690 play plus one ฿330 hour).
The staff chose Check in now. Read-back showed in_park, Nanny assigned, band
and photo; phone and desktop boards showed NANNY. Phone pickup took a fresh
photo and released the child; desktop Out board showed the same child. The
temporary Nanny shift was archived after release. An earlier unpaid test
registration remains labelled ZZ TEST because its browser closed during the
photo upload; it has no photo and was never added to a sale.

Five review cards are drafted in `docs/qa/jira-comments/attachments/SCRUM-494/`
for items 1-9. They use real staging captures; booking references and band
codes are covered. Item 1's expired-document half is existing-test evidence
because staging cannot create a past-expiry verification. Check card 4's
redaction and adjust the booking line so the Already redeemed heading remains
fully visible. The food screens exposed a phone-only empty-cart notice saying
the platform did not price a cart with no lines. A one-line suppression is
local in `MobileOrderStation.tsx`; existing `s494-food` 10/10, POS typecheck,
scoped lint and production build pass. Deploy the verified POS fix, recapture
the three F&B warning states, rebuild and inspect the five cards, attach them
to SCRUM-494, name each in a plain-language comment, then move it to Deployed.

CI `37342943714` for `326ad33c` failed two stock closing/gate-recheck test
assertions after typecheck, lint and 177 other API test files passed. Do not
call it green. Investigate whether those tests reproduce independently before
deciding on a fix or retry; do not fold unrelated changes into SCRUM-494.
Every push gets a same-turn Jira status check/change and progress comment.
Then proceed with SCRUM-215 rounds 2-4 per CLOUD_HANDOVER section 3. Never
print or attach band credentials, booking references, pickup codes or secrets.

## STOP POINT - 5 October 2026, near midnight - SCRUM-494 meal and pickup

POS staging `b4299ea4` now shows readable safety and prepaid panels. The
allergy child's prepaid Hot Dog was served once on the phone counter; a fresh
scan shows it `Served` with the control disabled. Cash receipt T1-000060 is
finalised; its kitchen ticket is printed and a masked simulator preview shows
the Peanut allergy line. All three labelled children were released through
signed-in pickup-photo uploads (204) and release writes (200); all now read
`out`. The original cash sale T1-000059 has one ฿95 refund for A's two
unserved items, none for B's served ฿110 meal or C's no-food state. Two exact
unpaid rehearsal sales were voided; the older unrelated tendering record was
left alone. The pickup summary's light-theme color fix is local.

CI `37337702987` failed its static route-conformance check: the new
storage-only PUT needed inclusion in the no-database-write list. That
classification is corrected locally; its existing 12 tests, POS release tests
(11), API/POS typecheck, scoped lint, POS build and diff check pass. These
changes are not yet pushed or staged. SCRUM-494 stays Testing. Next: push with
same-turn Jira status/comment, deploy POS, obtain CI evidence, then complete
the nanny switch and phone check-in/release with a safe synthetic on-shift
nanny. Assemble at most five reviewed screenshot cards for all nine items,
attach and name them in Jira before Deployed. Never record band or pickup codes.

## STOP POINT - 5 October 2026, late evening - SCRUM-494 paid food walkthrough

API and POS staging are live at `8db35d3e`. The same-origin photo route
returned 204 and the existing three-child ZZ TEST registration attached its
labelled image with 200. A cash-only test sale (receipt T1-000059) was
finalised and its three children checked in through the platform with 200;
all now read `in_park`, paid, banded and photographed. Phone and desktop
Check-in boards show them. The phone F&B screen recognizes their bands and
shows a restriction-only warning, an allergy warning, prepaid choices and a
no-food refusal. Real captures revealed pale text on light-theme safety and
prepaid panels. A contrast correction is local in the shared banner and both
counter layouts; `s494-food` 10/10, POS typecheck, scoped lint, production
build and diff check pass. This correction is not yet pushed or staged.
Two exact unpaid rehearsal sales were voided; an older unrelated tendering
sale was untouched. SCRUM-494 stays Testing. Next: push this correction with
same-turn Jira status/comment, deploy POS, recapture safe screenshots, then
serve prepaid items once, prove second-use refusal and kitchen allergy, and
release with the correct unserved-meal refund. Finish the remaining nine-item
cards before the ticket can move to Deployed. Never record band credentials.

## STOP POINT - 5 October 2026, late evening - SCRUM-494 photo repair ready

The staging browser cannot PUT photos to R2 directly because its preflight is
403 without CORS headers. A signed-in same-origin photo-content route is now
implemented for consent and pickup photos, with operator, branch and owner
checks, image type and 2 MiB limit, and an attached-file overwrite guard. POS
uses the route for both online flows; the offline box path stays as before.
Existing API file tests (5), affected check-in tests (16), and POS release API
tests (11) pass. API/POS typecheck, scoped lint, POS build and diff check pass;
the API has no build script. CI `37322129021` attempt 2 succeeded for the
previous checkpoint. This repair is local only and SCRUM-494 stays Testing.
Next: commit and push with same-turn Jira status/comment, deploy API first and
POS second, then retry the labelled staging registration and finish all nine
proof items. No band credential, secret or photo belongs in Jira or logs.

## STOP POINT - 5 October 2026, late evening - SCRUM-494 staging photo upload

POS staging is live at `14d03c97`. The restriction-only warning needs a real
staging screenshot. A Reception Till 1 browser rehearsal saved a labelled
three-child ZZ TEST registration with consent, photos taken through a synthetic
test camera, a restriction-only child, an allergy child, prepaid item choices
and a no-food child. It did not take cash or check anyone in. The registration
and its three children remain `registered`, with no stored consent photo.
Browser PUT to the R2 presigned URL failed: OPTIONS returned 403 and no CORS
headers. The same signed PUT from Node returned 200. The bucket has no CORS
policy, and the available R2 object credential and Cloudflare token were denied
permission to set one. Implement and test a permission-bound same-origin upload
path, deploy API before POS, then retry the photo and complete the cash,
check-in, F&B and release walkthrough. Avoid recording band credentials or
photos in logs or Jira. CI `37322129021` attempt 1 failed on a print Vitest
worker timeout after its 268 tests passed; attempt 2 is running. SCRUM-494
stays Testing. The earlier STOP POINT below carries the other evidence work.

## STOP POINT - 5 October 2026, evening - SCRUM-494 restriction-only warning

SCRUM-494 stays Testing. Review of its food-counter acceptance found that a
child with a food restriction but no separate allergy/medical note had no
visible warning on desktop or phone. A shared F&B safety banner now shows the
restriction on its own and preserves the combined allergy/restriction case.
The existing `s494-food` test file passes 10 tests; POS typecheck, scoped
lint and production build pass. This fix awaits push, POS deployment and a
real staging screenshot using an owned ZZ TEST child band. The preceding
SCRUM-493 takeover stop point lists all other remaining evidence and the
later End of Day work. Do not transition SCRUM-494 to Deployed yet.

## STOP POINT - 5 October 2026, evening - SCRUM-493 takeover, SCRUM-494 evidence

The owner approved completing SCRUM-493 in the hosted handover's order:
SCRUM-494 staging evidence; SCRUM-215 End of Day rounds 2-4; SCRUM-495,
SCRUM-496 and SCRUM-498; then resolve SCRUM-497's decisions and close the
parent with evidence. The clean working branch is `feat/till-consistency-493`
at `C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos-voucher-slip`, based on
current `origin/main` (`e8dd0b1e`). Do not touch the original dirty checkout.

SCRUM-494 is still Testing. Its nine changes landed at `9a14af81` and remain
on the current API/POS staging deployment `0c641b7e`. Existing focused
`s494` tests passed on 5 October: POS 58, shared 19, box agent 12, API 72,
database 6. The current staging POS accepted an administrator sign-in and
opened Reception Till 1; no credential was printed or saved. Old authentic
staging screenshots for items 1-5 live in the previous session's temporary
`scratchpad/s494-evidence/shots` folder; they have not been attached or
committed, and some show band codes that require redaction before use. Items
6-9 remain to drive on staging. A prior expired-document case cannot be
created through the staging UI; use the existing test-run evidence and label
that limit. Do not call SCRUM-494 Deployed until all nine paths have named,
reviewed evidence on the ticket.

Read-only review of `wip/eod-round-2-inflight` found it unreviewed, based on
pre-voucher main, and carrying migration `0055` while current main is at
`0057`. Rebase its additive migration as `0058` with a fresh snapshot and
journal. Review failed outbox rows, disabled boxes with pending facts, and
close/receipt behavior; omit unrelated `arrival-r5-audit.test.ts`.

Next: finish SCRUM-494 staging workflows and screenshot cards, attach and
comment, then transition it to Deployed. Continue with SCRUM-215 only after
that checkpoint, per `docs/handover/CLOUD_HANDOVER.md` section 3. Jira status
and a plain-language comment travel with every pushed checkpoint. Never
include a secret value, claim code or band credential in documents or Jira.

## STOP POINT - 5 October 2026, evening - staging proof and park update package

## STOP POINT - 5 October 2026, evening - 100 THB QR mismatch under investigation

**5 October, park QR follow-up:** the owner reports the Pi update completed, but a NEW 100 THB spin still printed a QR scanning to the previous URL after an override edit and publish. SCRUM-499 is reopened In Progress for diagnosis. Live version 14 had saved/published plain codes for 100/200/300 THB and the physical box reported running 14; config_apply succeeded. During checking, the owner cleared the 100 THB override and published version 15, now also reported running; no settings were changed by the investigation. Latest observed 100 THB print was 18:34 Bangkok, before version 15. Direct SSH from this environment timed out. A read-only Pi command has been requested to report release path and whether the last eight remembered print jobs contain URLs or plain codes, never actual QR values. Await this evidence; do not assume a restart fixes the cause. Keep the owner's latest draft/prize edits.

Console CI 37292071118 attempt 2 is now SUCCESS; API, Console, Booth, POS and Launcher staging are observed live at 0c641b7e. The CI-packed 7eca661 Pi archive is still correct. SCRUM-500 stays Deployed; its English/Thai terms fields were verified live as enabled multiline controls, 2000 characters each, with Print the terms on in the latest park draft. Physical paper/current-POS acceptance is still not claimed.

**5 October 2026, evening - Lucky Wheel slip and prize QRs:** SCRUM-499 and SCRUM-500 are Deployed for verified staging software, with named screenshots attached (11252-11258) and comments 11515/11516. Physical print/current-POS scan remains an on-site acceptance step. API/Booth/Pi source 7eca6612 passed CI 37289763344; Console 0c641b7e is live and locally/staging verified. Its separate CI 37292071118 attempt 1 hit a print-worker onTaskUpdate timeout; attempt 2 is pending, not called green. The earlier proof-booth draft was restored from its guarded audit snapshot; all temporary QA fixtures are archived.

FWBooth1 has six exact current-POS QR mappings and bilingual showcase saved as a draft. The approved seventh prize, Kids Pizza, shares the former 300 THB 10% slot: each has 5%; all other chances remain, total 100%. 300 THB stays generated. Published/running version was still 11; do not publish until the park Pi update. The owner is now at the park with SSH to 192.168.0.240 and is copying the package. Physical update, reboot, draft publish and scan have not yet been confirmed.

The green CI-packed oto-box-0.1.0-7eca661.tgz and checksum are on the Desktop; hash verified twice: 970d5340b45f892174de2167ef5806c2858480e3a5239cf031f7a69e4cdf063e. Older 0468c38/d10d78f pairs moved into old-oto-box-releases. Exact CMD/PowerShell copy, Pi install/reboot, five-second polling explanation and static/dynamic QR switching steps are in docs/qa/voucher-slip/update-at-park.md and a Desktop copy. CMD requires %USERPROFILE%, not PowerShell $env:USERPROFILE.

See docs/qa/voucher-slip/README.md for checks, source, fixture cleanup and evidence limits. Six original QRs and twelve printer renders matched exactly; no actual redeemable values are in source, Jira or evidence. Normal publish queues config_apply; the box and TV poll every five seconds. No supported standalone five-second fetch CLI exists. An idle-box service restart reloads published settings. Current-POS redemptions do not update the platform ledger.

Continue in sibling worktree oto-pos-voucher-slip, branch feat/booth-slip-design; do not land unrelated changes from the original dirty checkout. Next: help with the on-site install, confirm the release path and active services, publish FWBooth1 only after compatibility is confirmed, verify its reported running version, and record new paper/current-POS scan results under SCRUM-499/500. Check the Console CI rerun and record its actual conclusion. Do not start another story. The legacy OTO App work and platform work remain separate.

## STOP POINT - 5 October 2026, afternoon - six current-POS prize QRs verified locally

Continue in sibling worktree `oto-pos-voucher-slip`, branch
`feat/booth-slip-design`; the original checkout is dirty and not this landing.
`b6b77d71` passed CI run 37283125632 but was not deployed. The owner added six
existing prize QRs (200 THB, Bracelet Workshop, 150 THB, Kids Pizza, 100 THB,
1+1 Kids Ticket). They are URLs, not compatible with the short fixed-code field.
SCRUM-499 returned to In Progress with comment 11509 for this follow-up;
SCRUM-500 remains Testing. The optional `legacyQrPayload` on voucher definitions
is carried in the published bundle and saved print job, with an optional
`qrPayload` in the spin answer for printer-failure fallback. The internal code
and ledger stay unchanged; external-POS redemptions are not mirrored. Clearing
the setting and publishing restores generated/fixed QR behaviour. Audits redact
both configurable redeemable values. No actual QR payload is in source/evidence.

Migration 0057 is additive. Existing affected tests pass: API 65, print 33,
box slip 4, shared 8, Console 38 plus 2 old todo. All seven packages typecheck,
scoped lint passes, both frontend builds pass and schema verification passes.
The first database test caught a PostgreSQL regex repeat-limit error, fixed in
the unshipped migration with a separate length check; rerun is green. All six
supplied images and both 512/576-dot software renders were decoded and compared
in memory, with exact matches. `docs/qa/voucher-slip/qr-scan-verification.json`
records booleans only. Physical print/current-POS scan remains pending.

Next: commit/push this verified slice and same-turn Jira status/comments; deploy
API before Console/Booth; run the isolated staging harness, attach reviewed real
screenshots and name them in Jira. Adapt the harness to prove legacy QR as well
as fixed codes; never log its generated credentials or QR values. Temporary
`packages/box-agent/tmp-staging-voucher-proof.ts` and original checkout's
`scripts/agent/tmp-voucher-stage.mjs` must be removed, never committed. Configure
the six supplied URLs through authenticated Console API after staging verification;
read the URLs only from this conversation's supplied images, not from documents.
Do not guess values. The active park booth is FWBooth1, published/running v11,
physical box online; no SSH. Preserve its prize odds and existing settings.
Download final successful CI's packed release, verify checksum, move older
Desktop releases into old-oto-box-releases and place the new archive/checksum on
the Desktop. Final checkpoint/push and Jira evidence remain. No physical update
has happened; the owner will update the Pi at the park.

## STOP POINT — 5 October 2026, afternoon — CI schema expectation corrected

Main contains `0edb2aac` for SCRUM-499 and SCRUM-500; both Jira tickets are
Testing with progress comments 11506 and 11507. CI run 37282116890 passed
typecheck, lint and empty-database migration apply twice but failed its Test
step: migration-0039's exact current voucher-column list omitted the new
nullable design column. The existing test now includes it and passes 5/5
locally; db typecheck and scoped lint pass. This fix and this checkpoint await
commit/push, followed by fresh CI. No SCRUM-500 staging deploy or Pi release
has been verified. Staging sign-in through the existing headless browser was
re-established without printing credential values; temporary browser helper
`scripts/agent/tmp-voucher-stage.mjs` in the original checkout must be removed
after evidence capture and must never be committed. Continue from the next
STOP POINT below for the full feature context.

## STOP POINT — 5 October 2026, afternoon — Lucky Wheel slip build verified locally

SCRUM-499 is In Progress: fixed-code source `33e1831e` is on main and staging,
with CI workspace checks green, but the park Pi has not been updated and no
fixed-code paper proof exists. SCRUM-500 is In Progress for the editable
bilingual 80 mm slip. Clean sibling worktree `oto-pos-voucher-slip`, branch
`feat/booth-slip-design`, starts at `33e1831e`; the original checkout is dirty
with other work and must not be used to land this feature. Migration 0056 adds
nullable `booth_settings.voucher_design`; an untouched booth retains its prior
published bundle and classic paper. The box print job captures the design and
code mode for stable reprints; a fixed/shared code omits the one-use promise.
Publish queues `config_apply`, which pulls the box cache and reports its running
version; the TV checks its local box every five seconds and applies a new wheel
between spins. The Console edits shared slip text and layout, while each
voucher type owns its prize title, instructions and terms.

The affected existing tests pass: print 32, box slip 4, shared slip 7,
Console slip 9, embedded-Postgres API booth-admin 37. All seven touched
packages typecheck, and scoped lint is clear. A sample render was visually
inspected at 576 dots; 512-dot rendering passed. No push, CI or staging deploy
of SCRUM-500 has happened yet. Next: review/commit by explicit file list,
pull current main, push with Jira comments and status in the same turn, run CI,
then deploy API before Console/Booth. Capture real staging screenshots on
SCRUM-500 and test the fixed-code flow on a virtual booth for SCRUM-499;
do not call either Deployed without its named staging evidence. Prepare a
checksum-verified Pi release on the Desktop but do not claim a park print until
the physical Pi is updated and a real slip is checked.

## STOP POINT — 2 October 2026, late night — local session hands over

Main and staging are at 9a14af81, CI green. Landed today:
- End of Day round 1 (one combined count);
- SCRUM-494, all nine till-consistency items: phone till redemption,
  Drop-Off/Nanny to check-in, phone-size check-in, gate access (0053),
  allergy and prepaid meals at the food counters, tier expiry and pick
  (0054), and refund restock;
- CI stability fixes;
- the hosted-session handover kit.

In flight:
- SCRUM-494 staging evidence (2 of 9 items captured);
- End of Day round 2 (wip/eod-round-2-inflight).

Everything needed to continue is in docs/handover/CLOUD_HANDOVER.md
(sections 2, 3 and 10) and docs/progress/plans/cash/ROUND_2_BRIEF.md.

## STOP POINT — 2 October 2026, late — S2-14 Deployed; S2-15a in progress; SCRUM-494 after its round 1

**Done:** S2-14 wallets and stock (SCRUM-211) Deployed with staging evidence
on both subtasks; SCRUM-486 Deployed.

**In progress:** S2-15a End of Day (SCRUM-215), re-planned to the owner's 2
October ruling on SCRUM-488 (all drawers counted together as one total for
the day; the existing End of Day behaviour for everything else). Plan:
docs/progress/plans/cash/PLAN.md. Round 1 is being built; rounds 2 to 4
follow.

**Priority set by the owner side (2 October):** as soon as S2-15a round 1
lands, take up SCRUM-494 (band details and services carried through, part
of SCRUM-493, till behaviour consistency across delivered areas). Then
S2-15a rounds 2-4, then SCRUM-495 and SCRUM-496 before any other story,
applying SCRUM-497's confirmed details as each part runs.
Register: docs/progress/plans/consistency/REGISTER.md. After it, S2-15b and
the agreed order.

## STOP POINT — 2 October 2026, early — S2-12 Deployed whole; the console redesign live; the push the owner asked for, delivered

**The arrival story (SCRUM-209, S2-12) is Deployed** — all five rounds built,
gated, landed and proven on staging inside the owner's two-day push: the real
checkout with the signed QR and the server-enforced visit window; the gate box
on the true GE-X2/HX-X1 and reader protocols with anti-passback that refuses
what it cannot credit (NO simulator app, per the owner's directive — scripted
doubles in tests only); till redemption to the satang with one sale ever under
racing tills; live occupancy ordered by each box's own journal with honest
staleness; and offline redemption on the box with the cross-box quarantine.
The closing audit read CLEAN after killing two money holes pre-ship: a cash
sale that could launder itself into a booking redemption, and a crash-abandoned
claim that could band a second family. Closing evidence: sales T1-000035
(online) and T1-000036 (box offline, synced exactly once). Residuals live in
**SCRUM-477** (the band key never reaches the bridge host — staging-confirmed,
one line plus a test — the bridge lookup path, History's labels for paid-online
sales, the chip's stale wording, a clipped roster name, a noisy 503). The two
real-hardware questions (a suspect close-frame example, settings byte width)
are the bench-day checklist on the story.

**Also Deployed this push:** SCRUM-473 (the rota-synced day roster with its
fallback ladder and merged names), SCRUM-474 (the console redesign complete —
shell, all ten pages, from the approved canvas
claude.ai/artifact/CkikCVjnknyNEnBvZK9Jny), SCRUM-475 (the station-link crash:
284 errors a day to zero, fixed at the driver-decode root), SCRUM-476 (test
prints route only through the named station). Earlier in the same arc: 461,
470, 471, 472 Deployed; 469 and 477 open as the follow-up queue.

**Working-method changes that now stand:** CI queues instead of cancelling on
main (a cancelled run had left the workspace unproven while app-only pushes
went green by path gate); landing sweeps print per-file +/- splits and treat
untracked files by CONTENT diff (the "+0/-N" tracked-diff on an untracked file
was this session's own false-stale trap, and restores over it destroyed real
work twice before the rule was fixed); the only trusted typecheck is `npx tsc`
run inside the package; worker briefs forbid restoring from any git ref.
Models per the owner's directive: strong only where money or protocol earns
the full gate, light for prescribed fixes and restyles, gates focused on named
invariants.

**Next by the agreed order:** S2-13 child check-in and supervision is the next
platform story (docs: SPRINT_2_PLAN §S2-13; the booked drop-off case S2-12
handed over is in scope). A quick round clears SCRUM-477 first. The Codex lane
continues 17b→17c→Radar per the recorded plan. Waiting on the owner: Xero, the
2C2P sandbox credentials, the card-refund default, pricing rulings, SCRUM-467
park observations, SCRUM-469's go.

## STOP POINT — 1 October 2026, night — the arrival checkout landed; the booth trio built; the console learns its design

**S2-12 round 1 (SCRUM-209) is landed and CI-green, not yet Deployed.** The
checkout landed as `3eb6530e` plus the date-window follow-up `76fabbd0` after
three adversarial gate passes: a booking is created pending with a chosen visit
date (a new step on /book per CLAUDE.md §7; the window is enforced on the
server after the gate proved past-dated bookings could be minted), and becomes
paid ONLY on the gateway's verified notification or the inquiry. The signed QR,
the Console bookings page and migration 0038 ride the landing. The gate's other
catches — the trading-day pricing mismatch at small hours, abandoned checkouts
raising the till's pending alert, declines closing a live payment page, the
full-scan invoice counter — are fixed with their reproductions kept as tests.
CI went green on a RERUN: the concurrency rule had cancelled the original run
and a staff-app push's green had skipped the platform suite by path gate — a
green run must be one that actually ran the workspace jobs. **Deployed waits on
the staging walkthrough screenshots; that drive launches when today's landing
queue settles.** Then round 2, the gate box, per
`docs/progress/plans/arrival/PLAN.md` (rounds 3–5 follow: till redemption,
occupancy, offline redemption + closing audit).

**The booth trio (owner-approved with the plan's defaults):** SCRUM-471, the
per-booth voucher slip, landed `e6caf97c`, CI green — byte-identical by default
across 48 renders, migration 0039, the Voucher slip card with live preview.
SCRUM-472, the template editor redesign, landed `94bea99e` (CI running at this
writing) — grouped controls, eye toggles, save bar, attached test print, and
underneath it a real platform fix: the box command queue's claiming query
returned rows in effectively random order; ordering is now guaranteed.
SCRUM-473, the duty sync, is BUILDING (workflow `wf_8596be2e-fee`, relaunched
with a read-the-tree-first preamble after a session cut killed the first
builder before it saved anything). Landing order is strict because migrations
38→39→40 share the journal.

**The console redesign (SCRUM-474) is owner-approved from the design canvas**
(12 artboards, claude.ai/artifact/CkikCVjnknyNEnBvZK9Jny: the booth page, the
grouped sidebar shell, and every console page on one twelve-column sheet).
Phase 1 — the shell plus eight non-booth pages, tokens only, behaviour
untouched, failed reads now honest — passed its gate (resumed from journal
after the same session cut) and lands right after 472's green. Phase 2 (Booths
and Bookings pages) starts once 473 lands.

**Also today:** SCRUM-461 Deployed — the staff app's AI features switched to
the Anthropic API (`f2548609`) on the owner's key, proven by a staff-scoped
Ask OTO answer citing its article and the other branch's article staying out;
an env change needs a redeploy to reach a running service (memory + ticket).
SCRUM-470 Deployed (panel deep link, true-scale preview). SCRUM-469 opened
(branch-scoped app provisioning is API-only; staging setup codes fail).
Booth plan landed: `docs/progress/plans/booth/TEMPLATES_AND_DUTY_PLAN.md`.

**The Codex lane** is finishing its tickets and is staging-testing with
screenshots (the owner's report); it landed camp-scoping fixes through the day
and the temp-index landings absorbed every push without conflict.

**Resume from here:** read the landing queue's state with `gh run list`; the
proof drive for 209/471/472 (plus a 474 progress capture) targets the newest
landed sha; 473's report decides its landing (journal 40 follows 39);
`docs/progress/plans/arrival/PLAN.md` round 2 is the next build after the
drives. Waiting on the owner: Xero, the card-refund default, pricing rulings,
SCRUM-467 park observations.

## STOP POINT — 1 October 2026, evening — M2 complete: offline selling Deployed; booth dashboard live; Testing queue swept

**The offline cluster and the payments story are closed.** Round 5 proved it on
staging with the box forced offline: cash sale T1-000033 and terminal sale
T1-000034, receipts and wristbands printed from the box's own queue, refusals in
counter words, and after reconnect each sale exactly once in History under its
printed number. The polish round landed the five refinements the drive surfaced
(`6c6161b8` + `ecc1f059`: tier honoured as the till chose it, band codes shown on
both box-closed paths, truthful degraded station link, counter wording). SCRUM-269,
270, 271, 295, 206 and story SCRUM-205 are all Deployed with attached evidence.
M2's last promise — the park keeps selling when the internet dies — is delivered.

**The booth dashboard (SCRUM-468) is Deployed.** `8a37b8a9` regrouped the Booths
page (header chips, six-of-six checklist, five titled sections, settings in a side
drawer, no sideways scroll 390–1440 px), added prize unarchive with its audit and
the 409 guard, the show-archived listing, and the receipt-templates link to the
till back office. Four staging captures landed (`1f15b14f`) and closed the ticket.
The owner's booth FWBooth1 was never touched; archived-restore was proven on the
proof booth with a ZZ TEST prize.

**Twilio Verify (SCRUM-455) is Deployed** (`3c7a4fdf`): the `twilio_verify` adapter
with the anchor-first ordering that closed the enumeration leak. Every environment
still runs `SMS_ADAPTER=console` until the owner flips a service and sets the three
TWILIO_ variables there. CI was trimmed the same day (cancel-in-progress plus
what-changed gates).

**Testing queue cleared.** SCRUM-456, 457, 458 and 463 closed whole; then the
refusal-proofs driver provisioned a ZZ TEST staff user on staging (created,
captured, then deactivated and verified un-signable) and every refusal fired:
SCRUM-453, 454, 460, 462 and 464 closed on those captures and 463's open sub-check
completed. No security leak was found. Only SCRUM-461 stays Testing, on the
owner's OPENAI_API_KEY; SCRUM-453's positive Xero exchange also waits on the
owner. The drive's findings became SCRUM-469 (branch-scoped OTO App provisioning
is API-only, and staging setup codes answer SMS_DELIVERY_FAILED) and a comment on
SCRUM-193 (user delete answers a bare 500 when referenced).

**The park thread:** the owner ran the wheel demo with `docs/ops/BOX_QUICKSTART.md`;
the sleep/Wi-Fi engineering record is in `docs/ops/PI_BOOTH.md` §7. SCRUM-467 (the
installer's awake pins and the button observations) waits on his answers from the
park. The second button is programmed at this Windows PC when he is back.

**Next build:** the arrival story, SCRUM-209 / S2-12, from
`docs/progress/plans/arrival/PLAN.md` — its OD-A defaults hold unless the owner
objects. Waiting on the owner besides the above: the card-refund-after-window
default and the pricing rulings in `docs/progress/OPEN_QUESTIONS.md`.

## STOP POINT — 1 October 2026, 15:32 — S2-11 Deployed; offline rounds 1–4 landed; round 5 (proof) is next

**Closed on evidence:** SCRUM-208 (S2-11, 23 staging proofs; the honest negative became
SCRUM-459 — the F&B tab screen is still the prototype's mock, so no kitchen allergy
line until real wristband tabs), SCRUM-201/285 (other lane), SCRUM-256 (Console test
runner + the CI card), SCRUM-423 (undo notes + test hygiene, card attached), SCRUM-455
(twilio_verify adapter — landed 3c7a4fdf, Testing, needs its CI card; nothing switched).
**The offline cluster (docs/progress/plans/offline/PLAN.md is the brief, its
fourteen recorded decisions hold, seven owner-marked with defaults):**
round 1 `2026836a` ids minted at the till (SCRUM-270 Testing), round 2 `0f0ee0c9`
one satang-exact calculator (SCRUM-271 Testing; two pricing questions for the owner
sit in OPEN_QUESTIONS — the scoped-code-after-comp ruling and history re-derivation),
round 3 `d10d78fa` the station bridge (members, children, visits, pricing through
the box; a revoked-token hole found and closed), round 4 `75ad7c76` the box sells
(cash + terminal offline, write-ahead recovery for both power-cut directions proven
by the check's own reproductions, bands minted on the box, printing from the box
queue, replay exactly once). **Round 5 = the proof pass:** every capability row green
with the toggle on, staging evidence + cards, then Deployed walks for 269, 295, 270,
271, 206 and the story 205. **The park trip:** the owner is demoing the wheel at the
park — docs/ops/BOX_QUICKSTART.md is his card (Wi-Fi without keyboard, hotspot trick,
resets, button triage), SCRUM-467 tracks the button dropout pending his observation,
and the release handed over is `oto-box-0.1.0-d10d78f.tgz` (SHA-256 `ba386355…f415`)
which carries the Console spin-duration setting. CI is healthy (public repo) with
cancel-in-progress and What-changed gates (`b7fd246d`). Codex's lane continues on
SCRUM-193/453 in apps/oto-app. Landing method while lanes share this checkout: temp
index from origin/main, explicit paths, push commit:refs/heads/main, never HEAD.


## STOP POINT — 30 September 2026, night — S2-11 landed and proven, its findings in a fix round

Two lanes ran all day under AGENTS.md "Two parallel lanes". This lane (platform):
**SCRUM-208 (S2-11) is BUILT, LANDED (`cc61e716`) and PROVEN on staging** — the
story round (platform → box+print ∥ pos → integration gate, all suites green,
~3,000 tests, the gate's seam test kept as `apps/api/test/sales-printing-box-seam.test.ts`),
the gate's four findings fixed before landing (virtual box band key, BAND_HMAC_KEY
in .env.example and set on staging Render — value nowhere recorded, a station
prefix rule at the station save, minting failure degrades to a note). CI went
green once the owner made the repository public; the fleet deployed (migration
0034 ran). The staging walkthrough attached 23 images to SCRUM-208 and CAUGHT
REAL DEFECTS — the till drops the visit so kids bands print nameless; the food
station never sends the member so the printed kitchen ticket lacks the allergy
line (safety-relevant); dishonest food confirmation; reprint attribution lost on
reload; refunded bands stay active (decision: revoke on whole-sale refund) —
being fixed NOW in round wf_1ac0bade-dbd (pos on the Opus 4.8 trial, platform,
console labels; checks on Fable). After it lands: redeploy, re-prove the two
failed captures (kids band with child+allergy; kitchen ticket allergy),
correct PLAYTEST_GUIDE.md's mismatched wording (list in the proof report,
task wuxaj8jr9), then SCRUM-208 → Deployed. Also today: SCRUM-201 closed by
the other lane; SCRUM-256 Deployed on the green run card; SCRUM-423's parked
remainder running (wf_460e71f5-d30: undo notes for 0021/0022 WITHOUT touching
applied SQL, box/booth/shared test hygiene); CI trimmed (`b7fd246d`:
cancel-in-progress + What-changed gates, conservative fallback); the arrival
plan written (docs/progress/plans/arrival/PLAN.md, 15 decisions);
PLAYTEST_GUIDE.md issued; Twilio's new Verify-route variables recorded
(OPEN_QUESTIONS §3: the auth token in .env is still 13 chars — owner re-pastes;
the trial API key pair must be removed; TWILIO_VERIFY_SERVICE_SID is now a
known env var; the verify adapter is a small build after the token works).
Waiting on the owner (OPEN_QUESTIONS top): the card-refund-after-window
question; the arrival plan's decisions. NEXT after 208 closes: the
offline-selling cluster (SCRUM-269 + 270 + 271 + 295), which also closes
SCRUM-206/205; the other lane continues SCRUM-193 (its voucher-contract
question answered on the ticket: the module counts as moved, nothing rebuilt).

## STOP POINT - 1 October 2026, SCRUM-193 app lane, break checkpoint after live staging proof

SCRUM-193 remains **In Progress**. Clean app worktree: `C:\Users\waqar\AppData\Local\Temp\oto-app-lift-orglog`, branch `feat/oto-app-lift-orglog`; feature/main source and checkpoint should be verified before new work. OTO App staging deployment `dep-dauteck1nsns73fl4pkg` is LIVE at exact `547532f2`, health `200`. Its source includes tenant/branch-scoped offboarding, serialized duplicate refusal, full Fix photo preview, visible Timekeeping tablet actions and honest Phone event labels. Combined production build passed; TypeScript has 468 inherited diagnostics, forced scoped lint only old-file findings, and existing offboarding/timekeeping specs cannot collect because `fixtures/users.json` is absent. CI runs for `547532f2` were in progress at checkpoint time; inspect their actual jobs before claiming any CI result.

Real staging proof is attached to SCRUM-193: Timekeeping Review 11225 and Detail 11226, Offboarding result 11227, post-fix Fix form 11228, plus earlier Fix success/list/detail 11222-11224. The Timekeeping probe accepted PIN IN/phone OUT and denied no-device, forged-photo and anonymous calls; its guarded residual audit found zero matching rows. Offboarding saved one synthetic resignation with six checklist items, rejected a repeat with `409`, and exact cleanup removed 6 checklist, 3 activity, 1 change, 1 offboarding and 1 employee row; final employee `404` and linked lists zero. Fix upload/report/private-image reads passed, and its exact report/original/thumbnail cleanup left no matching media. `docs/qa/oto-app-lift/{timekeeping,org-hr-verification,supplier-portal}.md` and `docs/qa/SPRINT_2_ACCEPTANCE.md` hold the limits. Do not re-create these fixtures just to repeat proof.

Next app-owned work when the owner resumes: fix Offboarding Reason's raw `personal_reasons` label under SCRUM-193, then test linked-user deactivation and offboarding partial-failure behavior with an isolated database; finish the remaining module action/role/desktop-tablet walkthroughs from the acceptance index. The outstanding restricted-role staging identity must be one that does not send a new setup message; a request for an existing safe identity is pending. The owner decided display-only Ask OTO titles suffice, so no title migration; Xero sandbox is not connected, so its positive exchange is disabled on staging until available. Face clock stays off on staging. Preserve permanent existing and new check-in photo-share links.

Needs from the platform lane before SCRUM-193 can close: `otoapp_v.events/employees/children` with POS view-only read/grep test; tenant-bearing Directory identity; tenant columns/backfill for settings, policy documents, asset catalogue, templates, Activity Log and Attention; persisted leave approval; the nullable/approved shift-group contract; an OTO App job register/claim/complete/expectation path under advisory locks with Health/Failures/retry; and the CI structure-only restore rehearsal with sample row counts. Audit historical duplicate offboardings before adding a forward-only unique employee constraint. The app lane does not edit platform migrations/API/POS/CI files. Jira must receive an In Progress status and comment in the same turn as the checkpoint push. Do not transition SCRUM-193 to Deployed until all five S2-17b acceptance gates and named staging screenshots/test cards are proven. Stop for the requested break after the checkpoint is pushed and Jira is updated.

## STOP POINT - 1 October 2026, SCRUM-193 app lane, tablet source fixes and job boundary

The signed-in Fix flow has Jira images 11222-11224 and exact cleanup. Source `bb5ba1c9` fits its selected photo fully in the 820px tile; source `593c72c1` keeps Timekeeping Review's row action at the tablet's right edge with a readable accessible name; source `e2261837` labels phone fallback honestly in raw and session events. Exact combined app build passed. TypeScript has 468 inherited diagnostics; forced scoped lint reports inherited findings, none on changed lines. Existing Timekeeping browser spec cannot collect because `fixtures/users.json` is absent. The PIN/phone staging clock action and exact fixture cleanup passed, but post-fix Review/Detail screenshots are still required. Deploy these source fixes together, then repeat real 820px proof and the synthetic offboarding walkthrough. Needs from the platform lane: the earlier POS, Directory, legacy ownership, leave/shift and CI gates; for jobs specifically, either platform runner registration with authenticated OTO job invocation or a tenant-aware service register/claim/complete/expectation contract supporting lock, Health, Failures and retry. Current app timers cannot honestly count as those Health jobs. SCRUM-193 remains In Progress.

## STOP POINT - 1 October 2026, SCRUM-193 app lane, Fix proof and offboarding duplicate finding

Live `0296f26b` passed the ordinary signed-in Fix flow: gallery upload `200`, report create `201`, own list/detail/private image `200`, anonymous detail `401`. Real 820px success, My Reports and detail images are attached to SCRUM-193 as 11222-11224; source files and full cleanup evidence are in `docs/qa/oto-app-lift/supplier-portal.md`. Exact guarded cleanup removed the synthetic report, original and thumbnail; final detail/media `404`. The selected image tile clipped at tablet width; repair is pending. Offboarding guard source `a80da9fc` passed 43 disposable two-tenant assertions but revealed duplicate POSTs. Follow-up source `4b557c77` passed 47 fresh assertions, including concurrent 201/409 requests with one record and six checklist items; build and changed-line checks passed. Deploy that source next, then use a synthetic no-login employee for a real 820px UI departure and exact cleanup. Needs from the platform lane: the previously recorded POS views, Directory tenant identity, legacy ownership/backfills, leave/shift contracts, locked jobs/Health/Failures, CI restore, plus an audit of historical duplicate offboardings before a unique constraint. The SCRUM-193 parent stays In Progress; a safe restricted staging sign-in remains outstanding.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, Offboarding route guard built

Source `a80da9fc` binds all seven offboarding and checklist routes to the signed-in tenant and permitted branch; staff reads only their linked employee. Build passed with inherited TypeScript/lint findings and none on changed guard lines. The existing departed spec cannot collect due missing fixture; a disposable two-tenant probe is under way. Land this source/checkpoint with same-turn In Progress Jira comment, deploy only after the probe, then use a disposable no-login employee for a positive UI action and exact cleanup of its checklist/change/activity rows. Never offboard existing staff for proof. Needs from the platform lane remain POS views, tenant-bearing Directory and legacy owner columns, leave/shift contracts, job-run/Health/Failures and CI restore. SCRUM-193 stays In Progress.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, platform gates re-audited

Committed `origin/main` `e33664e8` still has parent integration gaps: NOT BUILT POS `otoapp_v` views/read test, persisted leave approval, CI structure-only restore; BROKEN tenant-bearing Directory, legacy settings/policy/catalog/template/Activity/Attention ownership, ungrouped shift-group contract, and durable locked OTO App `ops_run`/Health/Failures. Exact source classification is in the closure plan. Needs from the platform lane: forward-only tenant columns/backfill, Directory service identity, POS views/test, approval/shift-group contracts, locked OTO App jobs and CI restore. No app-lane migration/API/POS/CI files were changed. A safe existing restricted staging account is needed for role proof; fresh supported provisioning sends SMS and has no exact API removal. Offboarding app-route guard is being built independently. Land this audit/index checkpoint with same-turn In Progress Jira comment; SCRUM-193 cannot be Deployed until the five acceptance criteria have evidence.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, Users create/edit staged and cleaned

On live `0296f26b`, a launcher-signed administrator used the new Create User control at 820px to create a synthetic staff user (`201`), edit its name (`200`) and confirm invalid branch access refusal (`403`) with no password hashes. Reviewed real screenshot is Jira 11221. Password was generated only in memory; this handler has no outbound sender. Exact-ID Data Admin removal deleted the user, access and activity rows; final detail `404`, access/activity searches zero. Land image/docs/features status with same-turn In Progress Jira comment. The Users module is WORKING WITH CAVEATS: restricted-role and real foreign-tenant staging proof still need a safe identity; platform Directory tenant identity remains open. Other parent gates (POS views, legacy tenant columns, leave approvals, shift groups, jobs/Health/Failures and CI restore) are unchanged. SCRUM-193 remains In Progress.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, Users create control repaired locally

Live `30624922` served the scoped Users list/detail without password hashes (`200`), anonymous `401`; reviewed 820px list screenshot is Jira 11219. The list revealed no trigger for its existing create dialog and weak tablet table discoverability. A small Create User button/scroll-cue repair passes app build, 469 inherited TypeScript diagnostics with none in the page, scoped lint zero errors/one inherited warning. Land source and this checkpoint with same-turn Jira In Progress comment, deploy exact source, then perform a reversible no-message synthetic `/api/users` create/edit and exact cleanup with real screenshot. Needs from the platform lane: tenant-bearing Directory identity, POS views/read proof, tenant-safe legacy columns/backfills, persisted leave approval, shift-group contract, job-run/Health/Failures, CI restore. SCRUM-193 remains In Progress.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, Check-ins tenant guard staged

At live `30624922`, signed-in authorized branch check-ins and nanny availability returned `200`, unknown branch `403`, missing check-in `404`, anonymous check-ins `401`. The reviewed real 820px empty board is Jira attachment 11220. No staging record was created; second-tenant proof remains the nine-case disposable local HTTP probe, and POS/OTO check-in ownership needs the platform lane. Land this evidence with same-turn In Progress Jira comment. Users UI source is locally verified but still uncommitted; finish and deploy it next. Needs from the platform lane: POS views/read proof, tenant-bearing Directory, tenant-safe legacy columns/backfills, persisted leave approval, shift-group contract, job-run/Health/Failures and CI restore. SCRUM-193 stays In Progress.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, birthday package UI staged and cleaned

Live `30624922` passed a signed-in UI package apply and read-only Day-of snapshot. Real reviewed 820px editor and Day-of screenshots (Jira 11217/11218) show the saved package; BEO API returned it. Guarded exact-ID cleanup removed eight synthetic rows; final event/snapshot/selection/BEO/kitchen/package reads were `404` and menu absent. `BeoViewOnly` is unmounted; the actual read-only page uses `BeoDayOfView`. Land these docs/screenshots with same-turn In Progress comment, then finish Users UI and live route proof. Needs from the platform lane: POS views/read proof, tenant-bearing Directory, tenant-safe legacy columns/backfills, persisted leave approval, shift-group contract, job-run/Health/Failures and CI restore. SCRUM-193 remains In Progress.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, birthday package UI source landed

Source `a35b6744` mounts saved birthday packages in the event editor and read-only BEO. Isolated build/targeted lint and local settled 820px sheet check passed; app TypeScript stayed at the inherited normalized baseline. Land the checkpoint with same-turn In Progress Jira comment, deploy exact source after final combined checks, then capture saved-package and settled BEO staging images with exact fixture cleanup. The Users/permissions and check-in guards are also pushed but await staging proof. Needs from the platform lane: POS `otoapp_v` views/read proof, tenant-bearing Directory identity, tenant-safe legacy columns/backfills, persisted leave approval, shift-group contract, durable advisory-locked `ops_run`/Health/Failures, and CI structure-only restore. SCRUM-193 remains In Progress.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, Users and permissions tenant guard

Source `15d1efde` has the Users/permissions tenant and branch guard with password hashes removed from responses. Thirty disposable two-tenant HTTP assertions, the storage auto-link check, existing platform sign-on test and build passed. TypeScript's 469 diagnostics and lint findings are inherited, none on edited lines; deactivated-session spec lacks its repository fixture. Land this checkpoint with a same-turn In Progress Jira comment, then land BEO package UI and deploy verified source. Live user creation can invoke SMS, so use a safe no-message identity before that action. Needs from the platform lane: tenant-bearing Directory identity, POS views/read proof, tenant-safe legacy columns/backfills, persisted leave approval, shift-group contract, durable advisory-locked `ops_run`/Health/Failures, and CI structure-only restore. SCRUM-193 remains In Progress.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, check-in tenant routes verified locally

Check-in and nanny routes now use the signed-in or kiosk tenant and verify branch ownership before reading or mutating. The affected existing browser test and nine disposable two-tenant HTTP assertions passed; clone and fixture removed. App build passed, 473 inherited TypeScript diagnostics with none in the edited route, and scoped lint had no errors. Land this slice with an In Progress Jira comment, then integrate the isolated Users/permissions and BEO package UI commits, deploy the verified source and capture real staging proof. Needs from the platform lane: `otoapp_v` POS views/read proof, tenant-bearing Directory identity, tenant-safe legacy columns/backfills, persisted leave approval, shift-group contract, durable advisory-locked `ops_run` and Health/Failures, and CI structure-only restore. SCRUM-193 remains In Progress until full module and integration acceptance is proved on staging.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, Supplier media and expiry complete

Exact `4baed2aa` remains live. A separate guarded synthetic Fix report with one labelled PNG proved allowed supplier media 200, other-branch media 403 and unlinked image 404; supplier and staff comments both returned 201 and appeared in the portal. A separate 90-second supplier link was valid before expiry and then naturally denied validate/list/media with 401; the portal showed Access Denied and the admin list marked it Expired. Four reviewed real 820px screenshots `scrum-193-supplier-{media,staff-reply,natural-expiry,expired-token-admin}-tablet-2026-10-01.png` are attached to SCRUM-193 (11213-11216). Guarded exact-ID and object-key cleanup removed one report, two comments, three tokens and the PNG; report 404, object absent, branch count zero, both branches retained. Supplier Portal is WORKS for its own actions. Normal staff upload/create is still a separate Fix report acceptance gap; its media report was set up with a guarded one-off job.

The BEO event editor image 11212 was a sheet transition frame, not proof of persistent clipping; Jira comment 11419 corrects the previous finding and these docs are updated. The check-in tenant/branch guard patch is verified locally: existing checkout-photo browser test 1/1, nine two-tenant kiosk HTTP checks, app build, edited-line lint clear and TypeScript at 473 inherited errors with zero in the touched route. The scratch database was dropped and the temporary dependency junction restored. Its source is still uncommitted in `apps/oto-app/server/checkin-routes.ts`; commit by explicit path after final diff review. Isolated source commits `88bc1b1b` (Users/permissions) and `5018cc4b` (mounted BEO package UI) are ready to cherry-pick after this checkpoint. Push latest main/feature with a same-turn SCRUM-193 In Progress transition and comment naming these four Supplier attachments; then land and deploy verified source together. Platform needs from the preceding block are still open. Do not mark SCRUM-193 Deployed.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, BEO event-use proof and tablet recheck

Exact `4baed2aa` remains live. A disposable birthday event applied a one-line package snapshot and a set-menu choice; snapshot, selection, kitchen and compound BEO readbacks were 200 with the expected synthetic values. Anonymous event/snapshot reads returned 401 and a nonexistent snapshot returned 404. The reviewed real 820px submitted-menu screenshot `scrum-193-beo-set-menu-submitted-tablet-2026-10-01.png` (11211) shows the chosen and included items and the received state. The companion `scrum-193-beo-synthetic-event-tablet-2026-10-01.png` (11212) was taken while the side sheet was sliding in; it is inconclusive for settled width, as corrected in Jira comment 11419. Source review found the package component is unmounted. The PDF request timed out in this run; do not claim its result. A guarded one-off preflight and exact-ID transaction removed all eight QA rows, with post-cleanup 404/absent reads. No BEO fixture remains.

SCRUM-193 stays In Progress with five parent gates open. The BEO evidence is committed and Jira comment 11418 names both attachments; comment 11419 corrects the animation-frame interpretation. Commit and push this QA correction with the next verified app slice, with a same-turn Jira status/comment. The BEO package UI placement and settled-width recheck are assigned in an isolated app worktree. Users/permissions tenant/credential-response repair is in another isolated app worktree. This lane's `checkin-routes.ts` has an uncommitted request-tenant/branch guard patch; app build, scoped lint and TypeScript baseline check passed, but affected route tests and two-tenant proof still need to run before landing. Its local node_modules junction was temporarily swapped for the main repo dependency tree; restore it after validation and never stage `node_modules_orglog_backup`. Supplier media/reply/expiry staging remains under way. Platform needs and CI limits are in the preceding OTO App block.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, Supplier Portal live action

Exact `4baed2aa` remains live. A guarded disposable, text-only Fix report and two branch-limited supplier tokens were exercised through the real 820px staging portal. Allowed list had one report and the other branch zero; wrong-branch detail/comment/close each returned 403. A supplier comment saved (201), close saved (200), completed list/detail displayed the outcome, and repeat close returned 409. Both tokens were revoked and returned 401. Guarded exact-ID cleanup removed the report, comment and token rows; report detail then returned 404, both tokens were absent, the branch report count returned to zero and the existing branches remained. Six reviewed screenshots `scrum-193-supplier-{token-admin,open-list,comment,done-action,completed-list,completed-detail}-tablet-2026-10-01.png` are attached to SCRUM-193 as 11205-11210. Live media, staff reply and natural expiry remain unverified. The app source did not change for this evidence slice.

SCRUM-193 stays In Progress with five parent gates open. Commit these docs/images by explicit list, push after latest-main check and post a same-turn In Progress transition/comment naming all attachments. BEO package snapshot/menu selection staging proof and a Users/permissions tenant-scope source repair are in progress separately. CI run 36803241985 at source `4baed2aa` executed Turbo workspace Typecheck, Lint, Test and Build successfully; it did not typecheck the separately packaged OTO App or run structure-only restore. Needs from the platform lane remain: `otoapp_v` POS views/read proof, tenant-bearing Directory identity, tenant-safe legacy columns/backfills, persisted leave approval, shift-group contract, durable advisory-locked `ops_run` and Health/Failures, and CI structure-only restore. Do not mark the parent Deployed until the complete module and integration evidence is attached.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, Packages/Menu saved and removed

Exact `4baed2aa` remains live on oto-app-staging. A launcher-signed administrator saved a uniquely labelled birthday package, its line item and a one-item set menu, then read them back. The two real 820px screenshots `scrum-193-package-saved-tablet-2026-10-01.png` and `scrum-193-set-menu-saved-tablet-2026-10-01.png` were reviewed and attached to SCRUM-193 (11203, 11204). An anonymous package-line read returned 401. Because the app DELETE only soft-disables tenant-wide templates, a Render one-off job ran a read-only exact-ID/tenant/reference preflight and a second job repeated the guards in one transaction to delete exactly the three synthetic rows. Both succeeded. Authenticated package/line reads then returned 404, and package/menu lists omitted the fixture. No QA template remains. This closes save/read, not event snapshot/selection or signed-in foreign-tenant proof.

SCRUM-193 remains In Progress with five parent gates open. Commit these screenshots and records by explicit paths, push latest main/feature, transition In Progress with a same-turn Jira progress comment naming the attachments; no app redeploy is needed for evidence-only changes. Supplier Portal positive staging action is being prepared with exact cleanup. Needs from the platform lane: tenant-bearing Directory identity; tenant-safe legacy settings/policy/asset/template/Activity/Attention columns and backfills; persisted leave approval; shift-group nullability or approved group contract; `otoapp_v` POS views/read proof; advisory-locked durable `ops_run` and Health/Failures; CI structure-only restore. Full CI has not passed because the latest green wrapper skipped workspace jobs. Continue app-owned module checks and obtain a safe restricted identity without sending setup messages.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, Organization live action

Exact `4baed2aa` is live on oto-app-staging with `/api/status` 200. The normal launcher-signed administrator created a unique unassigned operator through the 820px Operators UI. Detail/branches/users were 200 with no assignments, a tenant-move PATCH returned 400, and anonymous detail returned 401. The reviewed real screenshot `scrum-193-operator-created-tablet-2026-10-01.png` is attached to SCRUM-193. Exact-ID DELETE returned 200, later detail 404, and the list had zero matching rows. This is a positive default-tenant operator action; signed-in foreign-tenant/lower-role refusal, department action and tenant-bearing user assignment remain open.

SCRUM-193 is In Progress, all five parent gates open. Next commit this evidence and same-turn Jira status/comment, then run the validated exact-cleanup package/menu and Supplier Portal positive staging actions. Keep any raw supplier token only in browser memory, revoke before cleanup, and recheck both selected branches have zero unrelated Fix reports before creating a token. Platform needs and CI limits are in the preceding OTO App block.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, Organization source ready

App-owned source `5d5b4150` scopes operator and department read/write/assignment routes to the signed-in tenant and permitted branches. Operator user responses omit password hashes. A disposable two-tenant HTTP probe passed 26 assertions and removed its database; build passed, TypeScript retained 473 inherited diagnostics, and scoped lint found zero edited-line errors. This source has not yet been deployed or tested on staging. A synthetic unassigned operator can be created and fully deleted by exact ID for positive staging proof. Department DELETE only deactivates, so a synthetic department needs exact cleanup first. The legacy users table has no tenant key; an operator assignment without explicit tenant-bearing user branch access fails closed, needing a platform identity contract.

SCRUM-193 remains In Progress with all five parent gates open. Land the verified Organization source on latest main with a same-turn Jira status/comment, deploy oto-app-staging, prove one operator lifecycle and a foreign refusal with a real screenshot, then continue package/menu and Supplier positive checks with validated exact cleanup. Other platform needs remain POS `otoapp_v` views/read proof, Directory tenant identity, tenant-safe legacy backfills, persisted leave approval, shift-group contract, durable locked `ops_run`/Health/Failures and CI structure-only restore rehearsal. No full CI green claim.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, Knowledge PDF action proof

On live oto-app-staging, a synthetic one-page PDF uploaded through Knowledge Files reached `indexed`, produced one chunk with its unique fact and yielded the correct Ask OTO answer with its own file ID cited. The real 820px answer and expanded-source screenshots were reviewed and attached to SCRUM-193 under `scrum-193-knowledge-pdf-answer-tablet-2026-10-01.png` and `scrum-193-knowledge-pdf-source-tablet-2026-10-01.png`. The exact-ID DELETE returned 204 and later detail read 404 for every probe. The QA index, Knowledge/Ask notes and module status register now reflect this action; lower-role, other file types and other AI helpers remain open. No app source changed in this slice.

SCRUM-193 remains In Progress with the five parent gates open. Continue the app-owned Organization scope repair, then stage an exact-cleanup operator action and the package/menu and Supplier positive paths only with safe removal. Needs from the platform lane: `otoapp_v` POS views/read proof, tenant-bearing Directory identity, tenant-safe legacy columns/backfills, persisted leave approval, shift-group contract, durable locked `ops_run`/Health/Failures and CI structure-only restore rehearsal. The CI wrapper skipped workspace checks; do not call full CI green.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, live package guard and module status

This is the newest OTO App lane block. Source `9c0bed04` is live on oto-app-staging with `/api/status` 200. Direct package line-item list/create/edit/delete/reorder now verify the parent package belongs to the signed-in tenant, and mutable template identifiers are server-owned. A disposable two-tenant probe passed 54 assertions and removed its database; build passed, TypeScript stayed at 478 inherited diagnostics with none in the edited file, and scoped lint had no errors. On live staging, the normal launcher hand-off returned `/api/user` 200, a missing package's line-item list and reorder returned 404, and a separate anonymous context got 401. No foreign real package was touched. This is a narrow access check, not positive package/menu acceptance.

The feature register now names each module's current WORKS / WORKING WITH CAVEATS / DISABLED ON STAGING / NOT YET VERIFIED state and limits. Draft exact-ID cleanup scripts exist outside the repository for disposable package/menu and Supplier Portal staging fixtures. A benign read-only Render one-off job succeeded, but fixture jobs and cleanup are unexecuted; one-off job logs were unavailable through the attempted Logs API query. Do not create fixtures until the ID and cleanup path is confirmed. A source audit found unscoped Organization operator/department routes; an app-owned repair is being prepared. Package/menu, Supplier Portal and broader module proof remain open. Parent SCRUM-193 is In Progress, all five acceptance gates open. Needs from the platform lane remain `otoapp_v` POS views/read proof, tenant-bearing Directory identity, tenant-safe legacy data columns/backfills, persisted leave approval, shift-group contract, durable locked `ops_run`/Health/Failures and CI structure-only restore rehearsal. The latest CI wrapper skipped workspace checks, so no full CI green claim.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, Activity and read-only module gates

This is the newest OTO App lane block. Live `dfe71536` produced a branch-scoped Employee Added Activity Log entry from a labelled synthetic employee; a reviewed real 820px screenshot is attached to SCRUM-193. The entry and employee were deleted by exact IDs; final Data Admin and Activity searches were empty. The initial nickname-search attempt's sole synthetic activity row was identified by branch/time and deleted by exact ID as well. `docs/qa/oto-app-lift/org-hr-verification.md` records the action and limits; branchless legacy history and foreign-tenant staging denial remain open.

Event Settings Packages and Set Menus both returned 200 with zero templates, and their reviewed real 820px empty-state screenshots are attached and named on SCRUM-193. They do not prove template save/use or BEO package results. Tenant-wide template DELETE only soft-disables; a safe exact cleanup path is needed before synthetic staging writes. A code audit found direct package line-item routes lack parent tenant authorization, now being repaired in the app lane; current event package/set-menu helpers already check permitted branch. Supplier Portal anonymous endpoints returned 401 and a malformed link showed Access Denied in another real attached screenshot. No positive supplier report was created because report close leaves a row and branch deletion is FK-restricted. A Render one-off job in the staging service's private network is a potential exact-ID fixture setup/cleanup path; no job or fixture has been run. `docs/qa/oto-app-lift/{events-camps,supplier-portal}.md` records these limits. Do not mark either module accepted from empty/refusal screens.

SCRUM-193 remains In Progress with five parent gates open. Continue the package route repair, review and if sound use a no-media synthetic Fix fixture with one-off-job cleanup for positive Supplier Portal comment/close, then finish package/menu staging using safely removable synthetic templates. The prior block has the complete platform needs, CI caveat, Attention pause and live short-break proof. Pull latest main before a source land; keep changes inside this lane, commit explicit files, and transition/comment Jira in the same turn as each push.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, Org/Attention source live

This is the OTO App lane's newest block; leave the platform lane's top block untouched. Main and `feat/oto-app-lift` now contain `13a726f2` Org Chart tenant/branch guards, `c2e9768c` scoped legacy Attention reads, `4b303c48` fail-closed Attention writers, `072484c4` paused Attention UI, and `dfe71536` short-shift break omission. Exact `dfe71536` is live on oto-app-staging and `/api/status` returned 200. The combined app build passed, TypeScript remains at 478 inherited diagnostics with none in these module files, and the changed Attention page lints clean; existing route lint has unrelated inherited findings. A disposable two-tenant Org HTTP probe passed 31/31 and removed its database; the Attention SQL probe passed 8 cases and cleaned up. Jira SCRUM-193 stayed In Progress with a same-push status/comment. GitHub CI run 36799266325 succeeded only in its wrapper and skipped workspace Typecheck/Lint/Test/Build; do not call it a full green CI run.

Separate live action proof: a synthetic BEO event and manual timeline step saved and read back, then both deleted with later 404s; a private branch-scoped Knowledge File PNG uploaded, returned exact bytes, refused anonymous media, and deleted with later 404s. Three real reviewed 820px screenshots are attached and named on SCRUM-193. `docs/qa/oto-app-lift/{events-camps,knowledge-ask-oto,employee-documents}.md` records evidence and limits. Restricted manager BEO/employee-file proof and Knowledge File indexing remain open. The live repeat on `dfe71536` returned Attention `paused=true` with 43 saved items, showed the paused banner and disabled actions in a real 820px screenshot; bogus branch 404. Org budget company/own-branch reads returned 200 with finite totals, invalid scope 400 and unknown branch 403. The Org nodes screen was not opened because its GET can insert rows. Synthetic two- and seven-hour shifts showed respectively no generated break and a valid break, including after exact-row regeneration, in two reviewed real screenshots; all assignments, rows, groups, plans and employees were deleted by exact ID and final searches were empty. These three newer captures are attached and named on SCRUM-193, with results in `docs/qa/oto-app-lift/{scheduling,attention-org-staging-dfe7153}.md`.

SCRUM-193 still has five unchecked parent criteria. Needs from the platform lane: additive tenant/backfill/cutover for Attention items, Activity Log branchless rows, policies, asset catalogue, contract templates and settings; tenant-bearing Directory API; persisted time-off approvals; nullable shift-group column or approved group contract; POS `otoapp_v.events/employees/children` views/read proof; advisory-locked job ownership and durable `ops_run` for Health/Failures; CI structure-only restore rehearsal. A safe non-SMS staging identity or designated test account is needed for restricted employee-document/checklist proof. Keep face clock off by the owner's direction. Next record the staging repeats, continue remaining independent module action paths, and keep the ticket In Progress until every acceptance gate has real staging evidence. Pull main before each land, commit by explicit files, and status/comment Jira in the push turn.

## STOP POINT - 1 October 2026 morning - SCRUM-193 OTO App lane, Org/Activity and staging modules

This is the OTO App lane's current block; the platform lane's newer top block is separate. SCRUM-193 remains In Progress, with five S2-17b criteria unchecked. Main and `feat/oto-app-lift` include `d76c6d2d` Org Chart budget fix, `071ee9cf` Activity Log tenant/branch guard and `05888b19` tablet branch-selector containment. Exact `05888b19` is live on oto-app-staging. Local production build passed; typecheck has 478 inherited errors and no new edited-region error; focused lint is clear. A disposable two-tenant HTTP probe passed 33 Org/Activity assertions and removed its database. Jira transitioned In Progress with module comments 11388-11390 in the same turn as the push. Post-deploy staging Org budget returned 200/numeric totals with 8 live and 8 draft people; Activity list returned 13 total entries, 30-day summary zero, and bogus-branch list/summary 404. Three reviewed real 820px captures show the Activity page and long branch selector with no header overlap. No activity action or foreign-tenant denial was staged. Avoid `GET /api/org-chart/nodes` on real staging until a read-only missing-node count is known: that GET can insert chart nodes for active employees.

New live parent walkthroughs: Nanny reservation/overlap/status flow, Casual Worker create/assignment/deactivation/picker removal, and SOP publish/revise/Find article each passed with exact fixture cleanup. Eight real staging screenshots are attached and named in Jira comment 11392; `docs/qa/oto-app-lift/{nanny-booking,casual-workers,sops}.md` has limits. A no-group shift-row create still returns 500 because `schedule_shift_rows.shift_group_id` is NOT NULL while route/UI permit null; platform migration or approved group contract is requested in comment 11391. Public drop-off form builder publish was deliberately not attempted on the shared tenant: it changes a global form, invokes translation, and leaves versions/jobs without rollback. Use an isolated tenant or safe fixture. Platform-account creation sends setup SMS, so do not create a new account for proof without a designated safe test identity.

Attention Engine is BROKEN for tenant isolation: item and settings tables lack tenant scope, list/count/item/refresh paths can see or mutate shared rows, and timers lack advisory lock/`ops_run`. Read-only staging endpoints answered for the existing admin, but no safe item action or denial was claimed. `docs/qa/oto-app-lift/attention-engine.md` and Jira comment 11393 record it; an app-side fail-closed patch is under way. Needs from the platform lane: additive tenant/backfill/cutover for Attention items, Activity Log branchless rows, policies, asset catalogue, contract templates and settings; tenant-bearing Directory API; persisted time-off approvals; nullable shift-group column or agreed contract; POS `otoapp_v.events/employees/children` views and read test; advisory-locked job/Health/Failures `ops_run`; CI structure-only restore rehearsal. Keep face clock off behind the approved staging flag. Ask OTO title persistence and positive Xero exchange remain owner/external dependencies. Do not mark SCRUM-193 Deployed until every S2-17b acceptance gate has staging evidence and named Jira attachments.

Next: attach/name the new Org/Activity real screenshots; stage/test the Attention fail-closed patch after local proof; finish independent module actions/denials and app-owned UI defects; reconcile platform dependencies. Before every land, pull latest main and use explicit file lists. With each push, transition/comment SCRUM-193 in the same turn, then verify the exact Render source revision. Do not edit the platform lane's files or migrations, and never print secrets.

## STOP POINT - 30 September 2026 - SCRUM-193 OTO App lane, module checkpoint

This block belongs to the OTO App lane on `feat/oto-app-lift`; the platform lane's stop block is separate. SCRUM-193 remains In Progress. SCRUM-261 and SCRUM-262 are Deployed with named staging cards attached and Jira comments checked. Their kiosk-security source landed at `5bdf2623` and is live on oto-app-staging (`dep-dau21rrncjis73aetds0`). The isolated 12-case kiosk spec, configured-device ceilings, and staging configured-device checks passed; see `docs/qa/oto-app-lift/README.md`.

The PDF slice at `d7e0156c` edits only `apps/oto-app/server/{pdf,pdf-storage,routes,beo-routes}.ts` and the existing `tests/contracts.spec.ts`. Finalized contract output now stores actual PDF bytes in the configured object store; signed contract and letter downloads use record-scoped checks plus five-minute object URLs; the old public signed-PDF route requires staff scope; public tokens expire; BEO PDFs use object storage on S3; branch logos resolve from storage. The isolated full-seed browser suites passed 4/4; the contract suite checks actual PDF bytes at both download routes. BEO rendering and finalized/signed private MinIO round-trips passed. The production build passed, typecheck count is 578 versus inherited 583, changed-line ESLint found zero diagnostics. The temporary fixture link was removed; its source remains. Render deployment `dep-dau2ne093c1s73cgcg40` is live. Staging health returned 200, anonymous PDF routes 401 and generic PDF paths 404. An authenticated staging signing/download walkthrough remains. `docs/qa/oto-app-lift/contracts-pdfs.md` holds the evidence.

The employee-document/object-storage and Excel-preview slice landed on latest main at `b3af4e52` and is live on oto-app-staging (`dep-dau2vtp7lnhs73f7k8rg`). The document route now checks branch and record ownership, uses object storage, refuses the generic path and deletes the object with the record; Excel preview parses in memory. The existing browser flow passed upload/read/delete and preview, a local MinIO adapter round-trip passed and cleaned its bucket, the production build passed, typecheck stayed at 578 inherited errors with no new changed-area diagnostics, and changed-line ESLint found zero diagnostics. Staging health returned 200, anonymous document list/file routes 401, generic employee-document path 404. An authenticated staging upload/download remains open. Its first local browser attempt timed out on a loading page, then passed after the navigation wait was raised. The temporary fixture link was removed again. `docs/qa/oto-app-lift/employee-documents.md` records the exact checks.

The payroll export/payslip module landed on latest main at `649735bf` and is live on oto-app-staging (`dep-dau3btdg1s2s73b9vge0`). Four CSVs and one PDF round-tripped through disposable MinIO storage; authenticated local API downloads returned 200, staff refusals 403 and generic-object refusal 404. The old payslip PDF route collided with the payslip record route and returned 500; distinct routing now passes. The Exports screen called nonexistent GET routes; it downloaded all four CSV types after using the POST generation and scoped download routes. Test files/bucket and the temporary fixture link were removed after that slice. Production build and changed-line ESLint passed, typecheck stayed at 578 inherited errors with no new payroll-area diagnostic. The malformed-ID follow-up `54a5d714` is live as `dep-dau3firncjis73ajt0bg`; staging health returned 200, anonymous scoped payroll routes 401 and generic payroll file paths 404. Positive staging generation remains open. The seeded staff account has no payroll summaries, so positive self-download remains untested. `docs/qa/oto-app-lift/payroll-files.md` records the checks.

The isolated full-seed organization/access browser checks passed 9/9 and the platform sign-on contract check passed. HR, templates, timekeeping, departed deactivation and advisor attendance passed 18/18 after updating three pre-lift test assumptions in two existing specs. Scoped lint has zero diagnostics and the changed files have zero type errors; app typecheck remains at 578 inherited errors. `docs/qa/oto-app-lift/org-hr-verification.md` records what was and was not proved. A temporary fixture hardlink is present only for the current local module run; remove it after browser checks and verify the source fixture remains.

The scheduling/My Shifts slice is live on oto-app-staging at `f0f1bf2f` (`dep-dau3qph7lnhs73fah5u0`). The full-seed week plans include Sunday starts; `/api/rota` reconstructed Monday starts and omitted valid assignments. It now selects actual stored plans overlapping the requested range before applying the existing employee and branch filters. The two failing My Shifts checks and the full 16-check scheduling batch passed. The production build passed; typecheck remains at 578 inherited errors with zero edited-line diagnostics, and edited-line ESLint is clear. Staging health returned 200 and anonymous rota access returned 401; positive signed-in staging proof remains. `docs/qa/oto-app-lift/scheduling.md` has the evidence.

The tasks, checklists and Fix Board batch passed 16/22 first, then all six failed checks passed after two existing specs were updated for the local `otoapp` pool, direct midnight job invocation and the current Fix Board route. No runtime task behavior changed. Scoped ESLint found zero diagnostics in the changed specs; app typecheck stays at 578 inherited errors with none in them. This is local evidence only; Health/Failures job-run visibility and signed-in staging proof remain. `docs/qa/oto-app-lift/tasks-checklists.md` records the coverage and limits.

Events, BEO and camps passed six existing browser checks, the event-color logic check and the archived calendar-color reconciliation check. The latter now reads the current schema without writing to app rows and exercises pre-platform backfill only in a disposable schema that was removed. The changed test lints cleanly and adds no type errors. Signed-in staging proof and the platform POS event view remain open. `docs/qa/oto-app-lift/events-camps.md` holds the coverage and limits.

SCRUM-453 is Testing under the lift. Staff could read Xero status and finance sync history despite the admin-only analytics screen. The app-owned router mount now requires admin access; raw advisor accounts are also refused, including at the OAuth callback. The isolated local probe returned anonymous 401, staff 403 and admin 200 for the relevant reads; callback refusal was checked for anonymous and staff. Build passed, typecheck remains at 578 inherited errors with no changed-line diagnostic, and changed-line lint is clear. Commit `aeccaa7f` is live on staging; health returned 200 and anonymous Xero status, finance history and callback requests returned 401. Signed-in staging staff/admin proof and a named attachment are pending, so the defect is not Deployed. `docs/qa/oto-app-lift/finance-access.md` records the proof and limits. Render's service-level listing did not include Xero, AI, Twilio or SMTP variable names; inherited groups were not checked, and positive external integrations cannot be claimed. The app-owned `.env.example` lists names only; see `docs/qa/oto-app-lift/environment.md`.

A temporary local browser scan opened 24 module entry routes as the seeded admin without page errors or unexpected redirects. It proves navigation only, not writes or staging behavior. `/studio/vouchers` intentionally shows the “moved to Console” notice. The platform lane confirmed on SCRUM-193 that this is the S2-17b end state: the central ledger is the only active voucher system, with management in the Console and redemption at the till. Manager issuance and staff QR viewing belong to S2-17c/S2-21. The scan was removed; `docs/qa/oto-app-lift/module-entry-smoke.md` lists the routes and limits.

The isolated public check-in/staff-board probe passed invalid token 403, missing consent 400, valid registration 201, staff list/status/checkout/revert 200. The multi-child drop-off submission passed with two linked child rows, age-based nanny/drop-off suggestions and photo/signature byte round-trips. Synthetic rows and files were removed and absence confirmed. The form now checks the server's 10 MB upload limit after compression. Staging health, anonymous staff-list guard and invalid-token guard returned 200/401/403. This does not cover a positive signed-in staging flow. See `docs/qa/oto-app-lift/checkins.md`.

Next: continue the app-owned module walk-through, then obtain authenticated staging evidence. The scheduled-job audit found timers running without a platform `ops_run` write contract; several jobs swallow errors and finance sync is manual. The needed job-run write contract, advisory-lock ownership and Health/Failures visibility were requested in a SCRUM-193 comment. Main advanced in the parallel printing lane, so this lane's local feature branch and remote main have diverged; land verified slices by cherry-picking into a clean worktree from latest `origin/main`, then push main and the remote feature ref together. Leave the other lane's uncommitted files untouched. Do not claim positive staging PDF, employee upload or payroll generation tests ran before they do. Do not edit API, POS, Console, shared packages, scripts or migrations here. Needs from the platform lane: S2-17b POS views (`otoapp_v.events`, `otoapp_v.employees`, `otoapp_v.children`), the platform job-run/Health/Failures contract and restore rehearsal in CI. Staff vouchers are moved to the central ledger for S2-17b; no OTO App voucher rebuild is needed.

The published-form repair passed local refusal and browser submission probes, then landed at `53c39e95` and went live on oto-app-staging (`dep-dau4v7qd0e5s73e95urg`). Post-deploy health/anonymous-list/invalid-token guards returned 200/401/403. A positive staging submission is not yet claimed. All local synthetic rows/media and the temporary published-form pointer were restored. See `docs/qa/oto-app-lift/checkins.md`.

SCRUM-454 is Testing and linked to SCRUM-193. Its app-owned guard scopes all check-in records/actions, board list, QR token/image and nanny-availability reads to the staff or kiosk branch. A synthetic two-branch probe passed other-branch refusals and own-branch operations; the other-branch record did not change. All synthetic accounts, sessions, device and rows were removed. Commit `7a167807` is live on oto-app-staging (`dep-dau58kid0e5s73ea8p10`), where health and anonymous staff/nanny guards returned 200/401/401. Signed-in staging branch comparison and a named attachment remain before Deployed. See `docs/qa/oto-app-lift/branch-checkin-access.md`.

The SCRUM-193 nanny booking slice passes local isolated kiosk checks: no role, off duty, wrong branch, marked unavailable and duplicate assignment refused; eligible assignment succeeded; a cross-branch booking link refused; two concurrent identical reservations produced one row; a conflicting service edit preserved its old booking and a non-conflicting replacement updated both rows; invalid and final status transitions refused while on-duty activation/completion succeeded. Every temporary row/device/session was removed. The production build passed, typecheck remains 577 inherited errors with none in the edited route, and changed-line ESLint is clear. Commit `aa726625` is live on oto-app-staging (`dep-dau5l11srm7s73asptag`), where health and anonymous availability/reservation-write guards returned 200/401/401. Complete the signed-in nanny walkthrough before claiming S2-17b acceptance. See `docs/qa/oto-app-lift/nanny-booking.md`. POS check-in coexistence/ownership remains open.

SCRUM-456 is Testing, linked to SCRUM-193. The parent invitation renderer previously interpolated editable text/photo URLs into Chromium and read artwork from a source path absent in the runtime image. The app-owned fix escapes text, embeds only bounded local/object-store invitation images, disables scripts and uses packaged artwork. An isolated local image rendered its normal photo/artwork; hostile markup displayed literally, an external photo URL made zero sentinel requests, and two simultaneous RSVP posts left one row. Synthetic event, token, RSVP, design and media fixtures were removed. Build passed; typecheck remains 577 inherited errors, with its one existing token-query diagnostic in this route unchanged; changed-line lint is clear. Commit `428f6bdc` is live on oto-app-staging (`dep-dau5saflot8c739ps8s0`); health/artwork/invalid-token guards returned 200/200/404. Obtain a positive signed-in staging image and named attachment before Deployed. Existing parent/guest links last until revocation; do not invent an expiry policy. Needs from the platform lane if expiry is required: an additive token-expiry migration after the owner chooses the duration. See `docs/qa/oto-app-lift/parent-invitation.md`.

SCRUM-457 is Testing, linked to SCRUM-193. The supplier portal's detail route checked `branchId` on a storage wrapper instead of the report, so a valid magic link was refused. Its comment insert used nonexistent field names and its images pointed to staff-only media. The app-owned fix returns flat detail, corrects comment fields, gates media by token/report/tenant/branch, and allows one close. Admin token creation validates tenant branches and expiry, and revoke disables the record; all public supplier routes check expired/disabled tokens. The login diagnostic that logged session IDs was removed during local verification. The isolated full-seed probe passed 36 status/data checks across admin and supplier flows, including tenant and branch refusals; all synthetic rows, sessions and media were removed, with zero fixture counts. Build passed, typecheck remains 573 inherited errors with none in edited supplier/auth lines, and changed-line lint is clear. Commit `95d2c0be` is live on oto-app-staging (`dep-dau69degekts73d4pmqg`); health/anonymous management/token-required route guards returned 200/401/401. Obtain positive signed-in supplier link/image/comment/close screenshots and a named attachment before Deployed. See `docs/qa/oto-app-lift/supplier-portal.md`.

SCRUM-458 is Testing, linked to SCRUM-193. The Learn page linked to an unregistered path, its detail API returned no questions, and the quiz POST was missing; a known ID also bypassed branch filtering. Studio Training & Quizzes crashed on nonexistent `departments`. The app-owned repair scopes list/detail/quiz by tenant and branch, hides correct answers from learners, validates and scores answers, records attempts and one completion after a pass, and allows content-only completion. Studio can create/edit/delete modules, questions and audience. The isolated full-seed probe passed staff/admin and cross-tenant refusals, failed/pass/retry and zero-question flows, then browser checks completed a quiz and created/edited a module without errors. Original staff branch access was restored; synthetic modules, questions, attempts, completions, tenant and sessions were removed. Build passed, typecheck remains 566 inherited errors with no touched-training diagnostics, and changed-line lint is clear. Commit `40841060` is live on oto-app-staging (`dep-dau6kntg1s2s73blm5ng`); health and anonymous list/detail/edit/quiz guards returned 200/401. Obtain signed-in staging learner and Studio screenshots and a named attachment before Deployed. Existing completions remain after question edits; the owner has not set a retake rule. Next app-owned module: SCRUM-460 SOP browse/scope. See `docs/qa/oto-app-lift/training-quiz.md`.

Open owner coordination: a signed-in launcher-to-OTO-App staging session is needed for the positive module screenshots, and Xero sandbox configuration is needed for its positive exchange. Enter credentials through the deployment environment; never put values in Jira, commits or these documents. Continue independent app-owned checks while those are pending.

SCRUM-460 is Testing, linked to SCRUM-193. The SOP slice at `c93d0e07` fixes tenant/branch/status list and detail reads; tenant- and branch-validated admin writes; source-branch inheritance for AI-generated SOPs; Find/article navigation; null-safe cards and unavailable article handling; HTML sanitization. Build passed, app typecheck has 554 inherited errors and no changed-area diagnostic, and scoped lint is clear. The command environment rejected local test-server startup, so no signed-in route probe is claimed. Commit `9531cf41` is live on oto-app-staging (`dep-dau6vmqd0e5s73egt5ug`); health and anonymous SOP guards returned 200/401/401/401. Signed-in staging and named screenshot proof remain before Deployed. SCRUM-461 is In Progress for KB/Ask OTO knowledge-file and chunk scoping, then signed-in staging acceptance. See `docs/qa/oto-app-lift/sops.md`. Needs from the platform lane: S2-17b POS views (`otoapp_v.events`, `otoapp_v.employees`, `otoapp_v.children`), platform job-run/Health/Failures contract and CI restore rehearsal.

SCRUM-461 is Testing under SCRUM-193. The KB/Ask OTO source slice `d4aa5901` repairs the actual `SELECTED` branch scope; tenant/branch guards on article and file actions; staff published and assigned-job-role browse; scoped Ask OTO answer, chunk and media sources; literal keyword scoring; the Browse URL; safe article HTML; and thread/message writes against the current schema. Build passed, typecheck remains at 543 inherited errors with no touched-area diagnostic, and scoped lint is clear. There are no existing KB/Ask OTO tests; the local signed-in test-server command was rejected, so no route probe is claimed. Commit `8de9d552` is live on oto-app-staging (`dep-dau7bk893c1s73d1fb30`); health and anonymous KB/file/Ask guards returned 200/401. Signed-in staff/admin branch and answer-source screenshots remain before Deployed. SCRUM-462 is In Progress for casual-worker branch and pay-rate access. Needs from the platform lane: a forward-only nullable `otoapp.ask_oto_threads.title` migration if titled conversations are required, plus S2-17b POS views (`otoapp_v.events`, `otoapp_v.employees`, `otoapp_v.children`), job-run/Health/Failures contract and CI restore rehearsal.

SCRUM-462 is Testing under SCRUM-193. The casual-worker source slice `bd286d48` closes the staff/API pay-rate gap, scopes list/detail/scheduling and all mutations by tenant and permitted branch, validates branch/department/role references and date/rate values, and fixes the page's inclusive end date and branch name. Build passed; app typecheck remains at 542 inherited errors with none in the touched files; scoped lint is clear. No existing casual-worker test exists. The local signed-in test-server command was rejected, so no positive route probe is claimed. Commit `702e184f` is live on oto-app-staging (`dep-dau7hqm0tbcc739u2l10`); health returned 200 and anonymous list/scheduling/detail returned 401. Signed-in manager/staff branch and scheduling proof and named screenshots remain before Deployed. Continue app-owned vault, directory, data-admin, files/settings and notification modules after this slice. Needs from the platform lane remain POS views, the job-run/Health/Failures contract, CI restore rehearsal and a nullable `otoapp.ask_oto_threads.title` migration if titled conversations are required.

SCRUM-463 is Testing under SCRUM-193. Vault source `a8f5aa8a` closes the default-tenant and unaudited-detail gap, seals credentials with a tenant-specific key, validates branch references, removes access-item data admin registration and gives the page a single audited reveal/copy operation. Existing unsealed rows reseal when revealed; a legacy row never visited will remain unsealed until a deliberate backfill. Build passed, typecheck stays at 542 inherited errors with no vault-area diagnostic, scoped lint is clear, and a disposable seal/open, wrong-tenant, tamper and legacy probe passed. No existing vault test file exists. Commit `b39d0ed5` is live on oto-app-staging (`dep-dau7p67avr4c7381v260`); health 200 and anonymous vault list/detail/reveal and data admin 401. Signed-in role/branch and reveal/audit proof with named screenshots remain before Deployed. Continue directory, data admin, files/settings and notifications. Needs from the platform lane remain POS views, the job-run/Health/Failures contract, CI restore rehearsal and a nullable `otoapp.ask_oto_threads.title` migration if titled conversations are required.

SCRUM-464 is Testing under SCRUM-193. Notification source `6f564c64` scopes the existing task notification list, unread count and mark-one/all-read operations to the signed-in tenant and recipient. Missing tenant fails closed, out-of-scope IDs return 404 and pagination is bounded; S2-17c delivery-state controls are separate. Production build passed, typecheck stays at 542 inherited errors with no notification-area diagnostic, and scoped lint is clear. No existing notification test file exists. Commit `32d69b3a` is live on oto-app-staging (`dep-dau7t1uk1f9s73anm07g`); health 200 and anonymous list/count/mark-one/mark-all 401. Signed-in two-tenant list/count/read and task-link proof plus named screenshots remain before Deployed.

The data-admin route gate source `732bf0fd` now matches the global/legacy-admin-only server API; build passed, typecheck stays at 542 inherited errors with none in `App.tsx`, and scoped lint is clear. Commit `43a6b1e5` is live on oto-app-staging (`dep-dau7va7lot8c73a1qdk0`); health 200 and anonymous model-index/list 401. Global/legacy admin walkthrough, operator-admin denial and registry review remain. Needs from the platform lane: a forward-only tenant-scoping migration for `otoapp.settings` with a legacy-global-key cutover rule, and a tenant-bearing service-to-service Directory API contract agreed with the platform consumer; also the existing POS views (`otoapp_v.events`, `otoapp_v.employees`, `otoapp_v.children`), job-run/Health/Failures contract, CI restore rehearsal and optional nullable `otoapp.ask_oto_threads.title` migration. Settings has a globally unique key and no tenant ID today, so do not claim tenant-safe settings behavior. Directory's one shared key has no tenant identity, so do not claim multi-tenant isolation.

SCRUM-465 is In Progress under SCRUM-193. File source `36b2b33a` rejects invalid path segments, applies private no-store headers to authenticated generic files in object storage and legacy local fallback, and disables type sniffing. Commit `0604c536` is live on oto-app-staging; anonymous private-media and invalid-path guards passed. The 30 September follow-up found that current and legacy Fix media reads still check only sign-in, not the owning report's tenant, branch and reader role, and thumbnails are publicly cacheable. A report-scoped local patch built, left typecheck at the 542-error baseline and had no edited-line lint finding, but it was reverted before commit/deploy because the available local database lacks OTO App tables for the affected browser checks. Next set up an isolated populated app database, verify pre-save preview behavior and report-media association, then test and land the access change. Public drop-off photo/signature links also need a replacement access policy before exposure changes. Do not call the files module verified; see `docs/qa/oto-app-lift/files.md`.

SCRUM-466 is Deployed under SCRUM-193. Data-admin source `f5c1061f` removes the generic session, Xero OAuth token and reset-token models while leaving normal auth/Xero routes intact; user list/detail/write responses omit password hashes. Build passed, typecheck stays at 542 inherited errors with no data-admin-router diagnostic, scoped lint is clear. Commit `75331db7` is live on oto-app-staging (`dep-dau844favr4c73839geg`); health 200 and anonymous model-index/removed-model/user requests 401. Signed-in staging API checks returned 200 for model index and Users list/detail, 404 for each removed model, and no password field in either Users response. Three actual staging screenshots are attached and named in the SCRUM-466 Deployed comment. Operator-admin and wider maintenance-registry checks remain on parent SCRUM-193. SCRUM-465's file slice is live at commit `0604c536` (`dep-dau8192d0e5s73el0nd0`): health 200, anonymous private media 401, public missing and invalid paths 404, and public cache header present. Private cache and record-scope checks still need sign-in.

SCRUM-193 remains In Progress. The in-app browser screenshot service timed out even on a blank external page; the repository's existing browser-test tooling captured and reviewed 15 actual staging screenshots. They show signed-in Today, Analytics, Check-ins, Supplier Access Tokens, Learn/Quizzes, Find, Knowledge Base/Ask OTO, Casual Workers, Vault, Notifications and Data Admin index/Users list/detail. The images are attached to the respective child tickets and parent SCRUM-193, and Jira comments name them. Earlier observation cards remain clearly labelled as cards. SCRUM-466 is Deployed after direct API checks and three named screenshots. Other children remain Testing because their staging lists are empty or role, branch and action cases are still missing; a page opening is not full module proof. SCRUM-465 remains In Progress because generic authenticated media lacks owning-record/tenant authorization, and externally shared drop-off photo/signature links need a replacement access policy before their exposure can change. Needs from the platform lane: tenant scope and legacy-key cutover for `otoapp.settings`, tenant identity in the Directory API service contract, POS views, job-run/Health/Failures contract, CI restore rehearsal, and optional Ask OTO thread title migration. `docs/qa/oto-app-lift/directory-settings.md` records the two new contracts. Continue file access design and signed-in acceptance; do not claim CI green without a new CI run. Screenshot index: `docs/qa/oto-app-lift/staging-screenshots-2026-09-30.md`.

Closure restart on 30 September: the isolated local oto_app_lift_acceptance_0930 database now has the app migrations, sample data and a synthetic administrator. The existing fix-checklist-scope browser check passed 1/1 against its local server. The full seed is unavailable because its fixtures/users.json import is absent; the temporary test fixture must not be committed. docs/qa/oto-app-lift/closure-plan.md defines app module actions, the Fix record/media access slice, platform seams and final staging proof. The platform lane source audit found the POS views, OTO App job-run registration, CI restore rehearsal, tenant-scoped settings migration and tenant-bearing Directory API contract still missing on main f3f4cd6d. Continue app-owned checks while those contracts are coordinated. The platform lane stop blocks above are untouched.

SCRUM-465 Fix file-access checkpoint: report detail/comments/status/close/update and current/legacy media reads require the owning report's tenant, branch and reader role. Thumbnail responses are private; generic thumbnail and public legacy private-upload paths refuse access. Uploads issue a short-lived user/tenant media claim, verified and removed before report creation or completion-photo append, so a known file URL cannot be attached to an unrelated report. The five existing affected browser checks passed against the isolated app database; a disposable two-tenant/branch probe passed owner, denial, forged-attachment and cache cases and removed its rows/media. Production build passed; app typecheck stays at 542 inherited errors with no changed-area diagnostic; edited-line lint has no error. Temporary fixture and probe files were removed. Source `c7668cc3` landed on main and the feature ref; Render deployment `dep-dauggcad0e5s73flih50` is live on oto-app-staging. A signed-in synthetic Fix report appeared in the inbox and its 400-pixel photo decoded; anonymous current/legacy media returned 401, direct thumbnail and private legacy upload returned 404. Screenshot capture timed out, so no screenshot is claimed and SCRUM-465 is not Deployed. The owner requires existing raw drop-off photo links to keep working indefinitely. New photos need a separate private path and expiring share links; link duration is pending. Public signature access and other generic folders still need review. Needs from the platform lane: POS views, job-run/Health/Failures contract, CI restore rehearsal, tenant-scoped settings and tenant-bearing Directory API; optional Ask OTO title column only if titles are required.

SCRUM-465 profile-photo checkpoint: current and legacy filename URLs require sign-in and an owning account or permitted employee record; `/uploads/profile-photos` is closed. Employee-ID reads and manager uploads check tenant and branch, and My Account refuses a linked employee belonging to another tenant or user. A disposable isolated-database probe passed authorized reads, anonymous/branch/tenant denials, private caching and three denied uploads/syncs, then removed its fixtures. Production build passed. Typecheck stays at 542 inherited errors and edited-line lint has no new finding. The existing employee browser spec timed out at its stale `Bangkok` branch choice before reaching this change; it is not proof. Source `9c724c1c` is pushed to main and the feature ref; Render deployment `dep-dauhfp1srm7s73c9htu0` is live on oto-app-staging. Health passed, anonymous current/legacy/employee-ID photo routes refused access and the former public upload path returned 404. The signed-in My Account and Employees pages loaded but have no profile image for a positive staging read. Screenshot capture timed out, so SCRUM-465 remains In Progress without a named attachment. Next finish positive staging image evidence, private new check-in photo sharing, signatures and the other generic file folders. The owner requires indefinitely working existing raw check-in photo links; the new-link lifetime decision remains open. See `docs/qa/oto-app-lift/files.md`.

SCRUM-465 check-in-media checkpoint, local only: new public drop-off submissions store photos and signatures in separate private folders. The staff board substitutes a seven-day signed photo link for new rows so its WhatsApp/Telegram messages and thumbnails work; already-shared raw photo URLs remain public and continue to work indefinitely. The signed route refuses expired/tampered links and changed/deleted records; direct private media is closed, while signatures require owning check-in tenant and branch. Seven days is a provisional default pending the owner's new-link lifetime answer. A disposable full public submission and direct access probe passed and removed all synthetic data/media. The existing kiosk camp-checkin test passed 1/1. Production build passed; typecheck remains at 542 inherited errors, and touched-line lint has no new finding. Source 2e4d8491 is pushed to main and the feature ref; Render deployment dep-daui12893c1s73eat6dg is live on oto-app-staging. A synthetic public submission succeeded and its signed 400-pixel photo loaded on the staff board; anonymous private-file guards returned 401/404. Screenshot capture timed out, so the labelled row remains for the required attachment. Next obtain named staging evidence and review the remaining generic file folders. See `docs/qa/oto-app-lift/files.md`.

SCRUM-465 next folder checkpoint: generic `knowledge-files` reads bypassed the scoped Knowledge Base media handler; `test-uploads` was also unnecessarily reachable by a signed-in account. Both now return 404 at the generic route, while `/api/knowledge-files/:id/media` remains unchanged. Production build passed, typecheck remains at 542 inherited errors and edited-line lint is clear. Source `5485154a` is pushed to main and the feature ref; Render deployment `dep-dauifs7lot8c73b990h0` is live. Staging health returned 200, both generic paths 404, and anonymous scoped media 401. Other generic folders still need per-record access: kiosk PIN evidence, checklist/checker media, checkout photos, task photos and camp photos. Do not close the files ticket until those and named staging screenshots are covered.

SCRUM-465 kiosk PIN evidence checkpoint, live on staging: generic filename access closes; current and legacy PIN image reads require a manager, an exact owning time event, advisor session or kiosk attempt, and tenant/branch scope. A new upload receipt binds the image to the kiosk device, tenant and branch for 30 minutes; clock requests reject forged or wrong-device receipts and store the canonical URL. Empty evidence still permits clocking when capture failed. Timekeeping review and per-employee event reads now filter tenant and branch. A fresh disposable database was migrated and seeded with synthetic branches; the existing kiosk authorization spec passed 12/12 and expanded advisor-attendance spec passed 10/10, including real upload, forged/other-device refusal, manager and branch image reads, private cache and timekeeping visibility. Build passed; typecheck stays at 542 inherited errors; scoped lint found no new diagnostic. The separate timekeeping-review spec cannot import the absent `fixtures/users.json`. Source `0dc62f3f` is pushed to main and the feature ref; Render deployment `dep-daujd2dg1s2s73d5oal0` is live. Staging health returned 200, anonymous current/legacy/local PIN photo and timekeeping reads 401, and signed-in Timekeeping Review loaded with no records for the selected date. Screenshot capture timed out, so positive staging media and a named attachment remain; checklist/checker, checkout, task and camp media remain. Needs from the platform lane remain POS views, job-run/Health/Failures contract, CI restore rehearsal, tenant-scoped settings and tenant-bearing Directory API.

SCRUM-465 checkout/checklist/task photo checkpoint, live on staging: the owner chose permanent signed links for new check-in photos while preserving already-shared raw links indefinitely. Checkout photos require an owning check-in/tenant/branch and valid bounded image bytes. Checklist evidence uploads bind to an authorized item; short-lived claims prevent attaching another item's URL; image reads are item/tenant/branch scoped. Task upload URLs, multipart uploads, completion attachment and image reads bind to an owning task/tenant/branch. Generic filename access closes for these folders; current and legacy scoped paths use private caching. Existing kiosk/check-in tests passed 2/2 and checklist scope passed 1/1; a disposable task route probe passed positive and wrong-task/branch/anonymous cases and removed its fixtures and media. Build passed with two inherited warnings; typecheck remains at 542 inherited diagnostics and scoped lint has no new edited-line error. The old task specs still import missing `fixtures/users.json`. Source `ce5b3cd6` is pushed to main and the feature ref; Render deployment `dep-daukc48jo6nc73dhbj30` is live. Staging health 200 and anonymous current/legacy media guards 401 passed; the labelled synthetic Check-ins row loaded its permanent signed photo at 400 pixels. Screenshot capture timed out, so no named attachment is claimed. Positive staging checkout/checklist/task reads and camp-photo ownership remain; the camp route needs event-bound upload claims, exact registration ownership and safe public/kiosk preview links. Needs from the platform lane remain POS views, job-run/Health/Failures contract, CI restore rehearsal, tenant-scoped settings and tenant-bearing Directory API.

SCRUM-465 camp-photo checkpoint, live on staging: public and manager uploads bind to a camp event, validate bounded JPEG/PNG/WebP bytes and return a short-lived attachment claim for private storage. Registration, profile update and conversion reject forged or cross-event photo URLs. Current and legacy reads require the owning registration and tenant/branch; public phone lookup and reception roster receive short-lived signed previews instead of a raw public read. Public upload attempts are throttled and signed image responses suppress caching and referrers. All three existing camp/check-in tests passed against the frozen source. Build passed; app typecheck remains at 542 inherited diagnostics and edited-line lint is clear. Source `b96a9652` is pushed to main and the feature ref; Render deployment `dep-daul1mp42hec73est5g0` is live. A disposable staging probe passed upload, registration, lookup, authorized kiosk current/legacy reads, roster preview and anonymous, other-branch, cross-event and tampered-link refusals, then removed all its rows and image. `scrum-465-staging-camp-media-proof.png` is attached to SCRUM-465 as an HTTP test-run card. It is not a UI screenshot: capture still times out even in a fresh browser tab. Other positive file-route reads and named UI evidence remain before SCRUM-465 can be Deployed. The single labelled synthetic Check-ins photo link exposed during inspection was revoked by clearing only its synthetic photo reference; all other shared links remain unchanged. Needs from the platform lane remain POS views, job-run/Health/Failures contract, CI restore rehearsal, tenant-scoped settings and tenant-bearing Directory API.

SCRUM-465 camp child-profile checkpoint, live on staging: `edd28317` filters child search, duplicate review, history, merge and propagated photo/profile updates to the signed-in manager's tenant and permitted camp branches. All-branch managers retain across-branch access. The full existing camp/check-in spec passed 4/4 on the isolated database; the build passed, app typecheck stayed at 542 inherited diagnostics with no changed-line finding, and scoped lint found no new error. Manual Render deployment `dep-daulhk49v7es73a1o570` is live on oto-app-staging; the duplicate auto-deploy for the same commit was canceled. Staging app returned 200, anonymous child list 401 and private camp photo 401. SCRUM-465 moved to Testing with a same-push comment, and SCRUM-193 received its progress comment. Next: authenticated staging branch-scope proof, positive remaining file-route reads and real UI screenshots attached and named on SCRUM-465 before Deployed. The in-app screenshot command times out even on a neutral page; Opera Browser Connector is installed but not connected to this chat, and its recorder has not supplied evidence. Needs from the platform lane remain POS views, job-run/Health/Failures contract, CI restore rehearsal, tenant-scoped settings and tenant-bearing Directory API.

SCRUM-465 real staging screenshot checkpoint, 1 October: the existing Playwright Chromium runtime captured the live app after a normal launcher sign-in. `studio-children.png` (empty state) and `scrum-465-staging-synthetic-child-list.png` (populated state) are attached to SCRUM-465 and named in Jira comments. One disposable Central Floresta camp and labelled synthetic child produced authenticated search and camp-history responses of 200 with one result each; registration cleanup returned 200, event cleanup 204, and final child search zero. The captured image was reviewed and contains only synthetic child/parent labels. This resolves the screen-capture blocker, but does not prove restricted-manager branch refusal, cross-tenant sign-in or positive reads of all remaining private media. Keep SCRUM-465 open for those cases and SCRUM-193 In Progress for the wider lift. No app code or deployment changed. Needs from the platform lane remain POS views, job-run/Health/Failures contract, CI restore rehearsal, tenant-scoped settings and tenant-bearing Directory API.

SCRUM-465 task-attachment STOP POINT, 1 October, local only: the previously overlooked `task-attachments` folder now has an exact owning-task file route; list, upload and delete require signed-in tenant and task branch, and delete matches the task ID. Active HTML and other non-image attachments download; unknown private folders fail closed at the generic route; new filenames include a UUID. A disposable local probe passed 13 authorized, anonymous, branch, tenant, wrong-task, cache, byte and safe-download checks, then removed its rows and file. The existing camp/check-in spec passed 4/4 against `oto_app_lift_acceptance_0930` with local-only legacy sign-in enabled. Build passed; typecheck stayed at 542 inherited diagnostics without edited-route findings; scoped lint had zero edited-region errors. Next pull latest main, land this verified slice, deploy oto-app-staging, then collect signed-in restricted-manager/foreign-tenant and positive private-media proof with real staging screenshots. Keep SCRUM-465 in Testing until those acceptance cases pass. Needs from the platform lane remain POS views, job-run/Health/Failures contract, CI restore rehearsal, tenant-scoped settings and tenant-bearing Directory API.

SCRUM-465/SCRUM-193 STOP POINT, 1 October, staging branch proof and local Events repair: `24dd9091` is live on oto-app-staging as `dep-daun6v49v7es73a7bdkg`. Health/unknown-private/anonymous attachment probes returned 200/404/401. A disposable Central Floresta manager signed in through the launcher; child search returned only its own synthetic row, own history 200 and Chalong history 404. The reviewed real staging screenshot `scrum-465-staging-restricted-children.png` is attached to SCRUM-465 and named in comment 11347. Both registrations and events were deleted, the app user removed, the platform link withdrawn and the account deactivated. An earlier unplaced synthetic app user was removed. A signed-in foreign-tenant rehearsal then found Events create still wrote the default tenant; registration failed 404 and all its synthetic resources were removed (event/branch/tenant 204, app user 204, platform link/account 200). The app-owned Events list/detail/create/update/archive/delete repair is local only, pending land/deploy: a disposable two-tenant route probe passed ten create, read, refusal and delete checks; existing camp/check-in spec passed 4/4; event-color check passed; build passed; typecheck stayed at 542 inherited errors; edited-region lint is clear. Next land this Events slice on latest main, deploy, repeat foreign-tenant staging proof, attach a real screenshot, then finish positive private-media reads before SCRUM-465 can move to Deployed. SCRUM-193 remains In Progress. Needs from the platform lane remain POS views, job-run/Health/Failures contract, CI restore rehearsal, tenant-scoped settings and tenant-bearing Directory API.

SCRUM-465 STOP POINT, 1 October, live foreign-tenant proof and final media repair: Events source `57e01a9b` is live (`dep-daunkt0u01pc738e12lg`). A launcher-signed second-tenant manager created and saw only its own synthetic child; the default admin saw zero, own history was 200 and cross-tenant history 404. The reviewed real screenshot `scrum-465-staging-foreign-tenant-children.png` is attached and named on SCRUM-465 (comment 11354). The event/user/link/account/branch/tenant were removed; direct registration DELETE returned 404 due to an older default-tenant route, while event deletion removed the registration. The remaining private-media audit found tenant gaps in employee-document and contract/letter-PDF access and checklist-media routes. App-owned guards and final-owner task-object cleanup built, with 542 inherited typecheck errors and no edited-area lint finding. The existing contracts browser suite cannot import absent `fixtures/users.json` and is not counted as a pass. This slice is not yet pushed or deployed. Next land on latest main with Jira status/comment, manually deploy oto-app-staging, run signed-in synthetic media probes, attach named UI proof, then move SCRUM-465 to Deployed only if those checks pass. SCRUM-193 remains In Progress. Needs from the platform lane remain POS views, job-run/Health/Failures contract, CI restore rehearsal, tenant-scoped settings and tenant-bearing Directory API.

SCRUM-465 STOP POINT, 1 October, live task/HR proof and checklist follow-up local: source `c8afae1d` is live on oto-app-staging (`dep-dauo1359fdbs739micbg`). A disposable task attachment returned exact PNG bytes (200), private no-store caching, anonymous 401 and post-delete 404; attachment/task removal returned 200/200. The reviewed real screenshot `scrum-465-staging-task-attachment.png` is attached to SCRUM-465. A synthetic employee document returned 200 to the default-tenant admin and 404 to an all-branch second-tenant manager; document/employee and all second-tenant fixtures were removed. That manager's branch list included five rows across tenants; the separate org-route gap is commented under SCRUM-193. Checklist pending lookup/association and reorder were then found to lack tenant/record scope. The local follow-up now enforces tenant and uploader ownership for pending media, validates item mapping, and checks template/branch access for URL/delete/reorder. Build passed, typecheck stayed at 542 inherited errors with none in checklist media, and scoped lint has zero errors. Next land this verified follow-up on latest main with same-push Jira updates, deploy oto-app-staging, run the disposable checklist signed-URL and foreign-tenant refusal probe, then decide whether SCRUM-465 meets Deployed evidence. Keep SCRUM-193 In Progress. Needs from the platform lane remain POS views, job-run/Health/Failures contract, CI restore rehearsal, tenant-scoped settings and tenant-bearing Directory API.

SCRUM-465 STOP POINT, 1 October, Deployed with real staging evidence: `104b319d` is live on oto-app-staging (`dep-dauo7s41nsns73f2bt9g`), health 200. A disposable checklist image returned a signed URL and exact image bytes (200/200); an all-branch second-tenant manager received 404 for that URL, reorder and delete, saw no pending record, and associated zero pending attachments. The reviewed real staging screenshot `scrum-465-staging-checklist-media.png` is attached. HR document owner/foreign reads were 200/404, child own/foreign history 200/404, and every synthetic checklist, media, HR, event, account, branch and tenant fixture was removed. Earlier real branch-limited/foreign Children and Tasks screenshots and the permanent public-link staging card remain attached and named in Jira closure comment 11362. SCRUM-465 status is Deployed. Continue SCRUM-193 for the wider module walkthrough plus cross-tenant `/api/branches` and foreign camp-registration DELETE follow-ups; no new ticket was opened for those findings. Needs from the platform lane remain POS views, job-run/Health/Failures contract, CI restore rehearsal, tenant-scoped settings and tenant-bearing Directory API.

SCRUM-193 STOP POINT, 1 October, branch/camp source ready to land: the app-owned branch list/detail/admin-write/logo routes now require the signed-in tenant, ignore a supplied tenant at creation and refuse a tenant change. Camp registration DELETE and attendance-day edits now require the signed-in tenant and a permitted camp branch. A disposable local two-tenant probe passed 19 own/cross-tenant/branch assertions and removed its fixtures. Build passed with two inherited duplicate-key warnings; app typecheck has 541 inherited errors with no new edited-region diagnostic, and scoped lint has no edited-region error. Jira's child defects SCRUM-261/262, 453/454, 456-458 and 460-466 are all Deployed with named attachments; older Testing text in STATUS is historical. SCRUM-193 remains In Progress with all five parent acceptance gates open. Next land this source against latest main with the parent status/comment, manually deploy oto-app-staging, repeat signed-in two-tenant branch/camp proof and capture a real screenshot. In parallel, the PDF and knowledge module staging walkthroughs are running with disposable fixtures. Needs from the platform lane: `otoapp_v` views and POS read test, OTO App job-run/advisory-lock ownership plus Health/Failures, CI structure-only restore rehearsal, tenant-scoped settings migration/cutover and tenant-bearing Directory API identity. Do not claim those gates built or CI green without their evidence.

SCRUM-193 STOP POINT, 1 October, knowledge/training staging action batch: `60f7256e` is live on oto-app-staging (`dep-dauonbk1nsns73f427kg`), health 200. A launcher-signed administrator created and read a published SOP and KB FAQ (201/200), with unknown-branch reads 404. Ask OTO answered the synthetic fact and cited the FAQ and SOP; a training module saved, wrong/right quiz attempts produced fail/pass, and the learner completion reached 100%. Seven reviewed real staging images are named in `docs/qa/oto-app-lift/{sops,knowledge-ask-oto,training-quiz}.md`; the 820x1180 Learn capture had no blocking overflow. All SOP/FAQ/training fixtures were deleted (204). This is a parent-story action slice, not blanket acceptance for knowledge files, other AI helpers, role scope or all modules. The contract/letter/BEO PDF and second-tenant branch/camp staging probes continue separately. A signing-date discrepancy (Bangkok success screen 1 October; signed PDF 30 September) is a new app-owned SCRUM-193 follow-up being repaired before PDF closure. Parent remains In Progress. Next commit these proof files, attach and name them on SCRUM-193 with a same-push status/comment, then finish PDF/tenant probes and the wider module walkthrough. Needs from the platform lane remain `otoapp_v` views and POS read test, OTO App job-run/advisory-lock ownership plus Health/Failures, CI structure-only restore rehearsal, tenant-scoped settings migration/cutover and tenant-bearing Directory API identity.

SCRUM-193 STOP POINT, 1 October, live second-tenant branch/camp action proof: `60f7256e` is live on oto-app-staging (`dep-dauonbk1nsns73f427kg`). A launcher-signed second-tenant administrator saw only its two labelled synthetic branches and could not read, edit, remove or remove a logo from a default-tenant branch (404); moving its branch between tenants failed (400), and creating with a foreign tenant ID still saved inside its signed-in tenant. Its synthetic camp registration gained a second attendance day (200, read back), then direct removal returned 200 and a repeat returned 404; the default-tenant administrator could not use the foreign event or registration endpoints (404). Four reviewed real staging images are in `docs/qa/oto-app-lift/`; all synthetic app/platform resources were removed or deactivated. Next attach/name the four screenshots on SCRUM-193 with a same-push In Progress comment, then fix the recent event-activity route's default-tenant and explicit-branch gap. The signed-PDF Bangkok date discrepancy remains an app-owned open follow-up awaiting source fix, deploy and repeat proof. Parent acceptance remains open, including POS views, Health job ownership, CI restore, tenant-safe settings and Directory identity from the platform lane.

SCRUM-193 STOP POINT, 1 October, signed-PDF date fix and Events/BEO follow-ups: `5e46b1a1` and `c534c3ea` are on main and the feature ref; Jira comment 11368 kept the parent In Progress and four real second-tenant branch/camp images are attached. OTO App deployment `dep-daup0341nsns73f5009g` is live. Fresh launcher-signed contract and letter e-sign success screens match their signed PDF pages at 01/10/2026, as does the BEO footer. Authenticated PDF routes redirected with private no-store to signed object URLs; exact `%PDF` bytes loaded, while anonymous, changed token and changed object signatures were refused. The five final reviewed real captures are in `docs/qa/oto-app-lift/` and need Jira attachment/comment. All synthetic employee/template/contract/letter/event and object-store files were removed and verified absent. BEO branch-scope access and recent event activity are locally under repair after source/local probe showed a restricted manager could reach another branch's BEO setup. Announcements were also found to use the default tenant; a local tenant/audience patch is built, with typecheck and lint retained at their inherited baseline, awaiting a disposable probe and staging proof. Tasks/Checklists staging action probe runs independently. Parent remains In Progress; platform gates still need POS views/test, jobs/Health/Failures, CI restore, tenant-safe settings and tenant-bearing Directory API.

SCRUM-193 STOP POINT, 1 October, Tasks/Checklists live action proof: on `dep-daup0341nsns73f5009g`, a launcher-signed administrator created/completed one labelled task (201/200; fresh status completed), created a one-item checklist (201), uploaded and byte-verified its synthetic reference image (200), and completed item and run (200; fresh status completed). Anonymous task/run detail returned 401; attachment, template/run and task were deleted (200 each; later detail 404). Real screenshots `tasks-checklists-ops-tablet-2026-10-01.png` and `tasks-checklists-run-tablet-2026-10-01.png` were visually reviewed at 820x1180. They need Jira attachment/comment. Source review still finds default-tenant reads/writes in `server/core/tasksRoutes.ts` and `server/core/compat/tasksCompat.ts`, so the Tasks module is BROKEN for a second tenant and cannot close from this positive probe. The platform job/Health gate also remains open. Announcements tenant/audience fix passed 15 signed-in local checks in a disposable two-tenant/two-branch fixture but is not staged; next land it with the Events/BEO branch-scope repair, deploy, then recheck signed-in staging.

SCRUM-193 STOP POINT, 1 October, Policies/Assets live action proof: on `dep-daup0341nsns73f5009g`, a launcher-signed administrator created/published/read a labelled policy (201/200/200; latest-published selected it) and created/assigned/returned a labelled asset (201/201/200, persisted Returned; repeat return 400). Anonymous policy/asset reads were 401. Three reviewed real 820x1180 staging images and precise cleanup are in `docs/qa/oto-app-lift/policies-assets.md`; attach/name them on SCRUM-193 with the next docs push. Synthetic policy, employee, asset/catalog and activity rows were removed; final searches were empty. Role/branch refusal is still unproven on staging. `otoapp.policy_documents` and `otoapp.asset_catalog` lack `tenant_id`, and company-wide policies lack a branch ID: full tenant separation requires an additive platform migration and legacy-row cutover; the app lane is repairing employee-asset guards independently. At 820px the HR navigation labels overlap; a local icons-only tablet ModeSwitcher fix needs build, deployment and visual repeat. The parent stays In Progress. Needs from the platform lane: POS views/test, Health jobs/Failures, CI restore, tenant-safe settings, tenant-bearing Directory identity, plus tenant columns/cutover for policies and asset catalog.

SCRUM-193 STOP POINT, 1 October, Scheduling/Leave live action proof: on `dep-daup0341nsns73f5009g`, a launcher-signed administrator saved and read the 28 September-4 October week, assigned a labelled employee to a 2 October shift, read that shift from My Shifts, submitted a 3 October annual leave and created a 6 October holiday. Duplicate leave returned 409; anonymous week, rota, leave and holiday reads returned 401. Four real reviewed 820x1180 staging images and fixture cleanup are in `docs/qa/oto-app-lift/{scheduling,leave-holidays}.md`; attach and name them on SCRUM-193 with the next docs push. At 820px navigation blocks branch selection; a generated break appeared after the shift ended; Bangkok-midnight 3 October leave was treated as 2 October and rejected against that shift. A local rota display guard now says the break needs review, and the date route and responsive header repairs require build/deploy/staging repeat. Restricted branch/role and leave approval remain unproven. The parent is In Progress. Needs from the platform lane remain POS views/test, jobs/Health/Failures, CI restore, tenant-safe settings and Directory identity, plus policy/asset catalog tenant cutovers.

SCRUM-193 STOP POINT, 1 October, employee documents and payroll files: on `dep-daup0341nsns73f5009g`, a launcher-signed administrator uploaded, privately read and deleted a synthetic employee document with exact 4,859-byte recovery; anonymous and wrong-employee paths failed. An isolated future-dated draft payroll run produced one header-only bank CSV and one synthetic payslip PDF; private staged downloads matched exact object bytes, anonymous reads failed, and all synthetic rows/objects were deleted and HEAD-verified absent. Two real reviewed 820x1180 screenshots are in `docs/qa/oto-app-lift/{employee-documents,payroll-files}.md`; attach/name on SCRUM-193 with the next docs push. Restricted-role, employee self-download, other CSVs and tablet card proof remain. The app-owned tenant-route patch passed 72 disposable local checks and build, but is uncommitted/unstaged. A small Exports card wrap and wording change is local. Needs from the platform lane: the existing POS views/test, jobs/Health/Failures, CI restore, tenant-safe settings and Directory identity; additive tenant columns/backfill for `policy_documents`, `asset_catalog` and `templates`; and persisted `employee_time_off` approval fields before approval transitions can work. Until then, non-default legacy policy/catalog/contract finalization returns 503 and approval PATCH returns 503. SCRUM-193 remains In Progress.

SCRUM-193 STOP POINT, 1 October, app source live and staging repeat under way: announcements `effb350d`, Tasks `7a4f521c`, Events/HR `03626e1f` and tablet controls `858df417` are on main and feature ref. Manual oto-app-staging deployment `dep-daupqp60tbcc73c7ehv0` is live at exact `858df417`, with `/api/status` 200. The production build passed, app typecheck has 479 inherited errors but no new edited-region diagnostic, changed-line lint is clear, event-color checks passed, and disposable local route probes passed 15 announcement, Tasks two-tenant and 72 Events/HR checks with fixture cleanup. GitHub CI for `858df417` is pending, not green. Three independent signed-in staging probes have started for Tasks/Announcements, Events/HR and tablet layout; wait for their exact screenshots, denials and cleanup before calling those modules verified. Platform dependencies: `otoapp_v` POS views/test, job-run/Health/Failures contract, CI structure-only restore, tenant-safe settings, tenant-bearing Directory identity, additive tenant columns/backfill for `policy_documents`, `asset_catalog`, `templates`, and persisted `employee_time_off` approval fields. Until schema cutover, non-default legacy policy/catalog/contract finalization and approval PATCH fail closed with 503. SCRUM-193 remains In Progress.

SCRUM-193 STOP POINT, 1 October, tablet retest and leave-approval guard: five real 820x1180 screenshots on live `858df417` verify branch selection on Scheduling, Policies and blank employee editor, a visible short-shift break review warning, and contained Bank/Journal export controls. Synthetic shift and payroll records were removed. The photos and precise results are in `docs/qa/oto-app-lift/{scheduling,payroll-files}.md`; attach and name them on SCRUM-193 with this checkpoint. The warning does not fix the break-generation rule. Local follow-up `c04cf268` refuses explicit leave approval when no approval state can be persisted and removes Scheduling's `approved:true` request; build passed, app typecheck stayed at 479 inherited diagnostics with none in the changed lines, and edited-region lint is clear. It is not yet pushed or staged; after the independent live probes clean their fixtures, land and deploy it, then test ordinary manager leave creation and explicit approval refusal. SCRUM-193 remains In Progress. Needs from the platform lane: `otoapp_v` POS views/test, job-run/Health/Failures contract, CI restore, tenant-safe settings, tenant-bearing Directory identity, additive tenant columns/backfill for policies/catalog/templates, and persisted time-off approval fields.

SCRUM-193 STOP POINT, 1 October, signed-in tenant and leave-route staging proof: live `858df417` passed task create/read/complete and branch/tenant refusals, targeted announcement publish/read and branch/tenant refusals, restricted own/foreign event-parent-BEO route checks, Bangkok-midnight leave create/edit/conflicts, default-tenant policy/asset actions and non-default 503 fail-closed policy/catalog/contract paths. Nine real reviewed 820x1180 screenshots and complete synthetic-fixture cleanup are in `docs/qa/oto-app-lift/{tasks-checklists,announcements,events-camps,policies-assets,leave-holidays}.md`; attach and name them on SCRUM-193 with this checkpoint. The restricted event/BEO route probe stopped before a screenshot because it expected 403 rather than the safe 404, so a named visual/test-run card still remains. Live `858df417` exposed explicit approval POST creating an unapproved record; the record was deleted. Follow-up `b20ed05b` is live: signed-in explicit approval POST/PATCH return 503 without mutating a row, and an ordinary Scheduling-shaped POST without that flag creates leave 201; the synthetic leave/employee were removed. Actual form click-through and a persisted approval workflow still remain. GitHub CI run 36793711295 completed successfully but skipped workspace Typecheck/Lint/Test/Build; local app build passed, typecheck retained 479 inherited errors with no changed-line diagnostic, and edited-region lint is clear. A further checklist/document restricted-role account was not created: staging `/api/accounts` invokes a delivering SMS provider. Previous synthetic account setup may have initiated messages, but delivery was not verified. Avoid another account setup until a designated safe test identity or no-message fixture exists. SCRUM-193 stays In Progress. Needs from the platform lane: POS views/test, job-run/Health/Failures, CI restore, tenant-safe settings, tenant-bearing Directory API, additive tenant columns/backfill for policies/catalog/templates, persisted time-off approval fields, and a safe no-message staging account fixture if no designated test identity is available.

SCRUM-193 STOP POINT, 1 October, public RSVP staging result: on live `b20ed05b`, an anonymous 820px browser submitted an attending reply to a labelled disposable invite. The signed-in event ledger held one matching RSVP; the summary showed one guest, one child and one adult. Random invalid read/write links returned 404. Three real reviewed screenshots are in `docs/qa/oto-app-lift/parent-rsvp.md`; attach/name them with the pending tenant-route evidence. The event was deleted (204), its former detail and invite returned 404, and no outbound sender was invoked. Public delivery, edit and language variants remain. Continue the org-chart/activity walkthrough independently. The parent remains In Progress with the preceding platform and safe-test-identity needs.

## STOP POINT - 30 September 2026 - break checkpoint saved

The current release checkpoint is complete. Stop here and await the next
instruction; do not select another Jira ticket. No current subtasks remain.

Live staging: POS 0683ffd10a859465aaa14c0b09f241edf555e581; API, Console,
Launcher and Booth b31b01b71a3846047a9a7beb3fb273cb4bd02b7d. OTO App remains
c416065. Main includes the source plus subsequent evidence/documentation.
Manual Render deployment was authorised because Actions cannot start. Normal
checksPass/auto-deploy settings are unchanged. Migration 0033 completed in the
API pre-deploy step, followed by working station access and removed routes 404.
There was no direct staging database inspection. Never roll the API back before
85d35e0 after this migration. Exact deployment IDs are in the QA release record.

SCRUM-201 is Deployed with named, reviewed staging screenshots. Foundation
checks passed, followed by 21 food/shop checks and 7 consent checks. The final
POS-only header spacing fix was verified at 1024x768 and 1280x800 without sale
or payment writes. Consent preserves private data and staff authority, retries
the same action after a lost reply, and survives lock/unlock. Current staging
policy requires a real joint photo before Done; that positive completion is
proven locally, not fabricated on staging. Physical display hardware remains
outside this software acceptance. Owned fixtures were archived/revoked; completed
synthetic sales remain for audit. Evidence: docs/qa/separate-display.

SCRUM-206 current payment follow-ups are deployed and verified. A retained
no-response simulation recovered with one original SALE and full reservation;
the known simulator outcome was resolved through an audited staff API action.
A fresh native GHL case passed 11 checks, recorded staff confirmation and
collected the unchanged balance once as cash. Earlier partial-reversal,
disabled-QR and zero-sale follow-ups also pass. Evidence: docs/qa/payment-stage.
The full story stays In Progress: separate To Do SCRUM-269 is required for
offline trading. It has not been started, and neither story has subtasks.
The historical uncertain partial run 0d008153 and its eight setup rows remain
untouched; never replay SALE, invent an acknowledgement or confirm no money.

SCRUM-285 remains Deployed with its 11-check staging card, attachment 10905.
The cloud offline-test guard is verified; full offline till trading is not built.
No other story or old To Do item was selected for this checkpoint.

Existing checks passed: six native browser flows; POS 92, shared 19, box 40,
terminal 33 and DB 43; affected package typechecks/lint, POS production build,
standalone smoke typing and schema verification. The final two-class layout
change passed POS typecheck/lint/build and native staging geometry. No new
test suite or dependency. Build chunk/import notices remain nonblocking.

GitHub runs 36619796693 (base source) and 36621089212 (final POS) ran zero steps
because account billing/spending availability prevented startup. CI is not green.
No new CI-packed Pi archive exists. Desktop keeps oto-box-0.1.0-0468c38.tgz
and its checksum; no physical Pi update was performed in this checkpoint.

Resume rules: read this block, STATUS, CODEX_HANDOVER and AGENTS before acting.
Keep explicit commit file lists, no attribution or secrets, Jira status/comment
with every push and named staging screenshot before Deployed. Use a dedicated
absolute output directory for every temporary browser runner. Excluded dirt
in render.yaml, services/ and MerchCustomerDisplay.tsx is preserved. Remaining
questions, protected evidence and rejected temporary cleanup are recorded in
OPEN_QUESTIONS.md. Wait for the next instruction.

## STOP POINT - 29 September 2026 evening - saved-child display review

Main 88140af is pushed and includes SCRUM-201 online saved-child review.
F&B guest display integration is in progress on feat/display-fnb-guest.
This checkpoint adds the finite child_review prompt and display.child_review
actions while preserving StationSessionDocument, StationIntent, actionId,
lastSeenSequence and leaseId. Full SCRUM-201 remains In Progress and NOT BUILT
as a whole; staging acceptance and the remaining display integrations remain.

At ticket step 8, an existing member can select a saved child, edit public
name/DOB/age and Confirm. The authorised till performs the real child PATCH;
only its successful response confirms the slot. Done requires every slot to
be confirmed and returns to staff supervision at step 7. New-child entry and
removal use explicit staff fallback. Private health/food/photo/waiver fields
remain on the till; recorded diagnostics still contain prompt metadata only.
This does not establish registration, check-in or persisted supervision consent.

Visitor, epoch, member, station and saved-child assignment fence late results.
The visit referenceDate drives the age picker and confirmation, within one
calendar day of server time; child confirmation uses the existing 0-17 range.
Lost or timed-out replies retain the original PATCH body/key. Eight seconds
bounds the transport wait; Retry is explicit. Lock/offline pause adoption and
do not repeat the save. Other local child drafts survive polling; dirty edits
invalidate their old confirmation. Oversized/malformed review uses staff fallback.

All 149 affected existing checks pass: shared station 10, box station 32,
API station 50, POS scan-channel 54 and native POS smoke 3. Shared/box/POS
typechecks and full package lint pass; POS build and standalone smoke typing
pass. No new suite, dependency or migration. Native proof uses a fresh seeded
database and separate staff/display contexts, verifies real profile readback,
same-key/body lost-reply retry, both display widths and staff handoff, and
observes no registration/visit/sale/payment POST during review. Its own
processes and database were removed after the run.

Reviewed LOCAL CHECK screenshots on SCRUM-201: 23-local-child-save-pending.png
(10902), 24-local-child-save-retry.png (10903), and
25-local-child-review-confirmed.png (10904). Sanitised results and the exact
business boundaries are in docs/qa/separate-display. Initial browser failures
and the fixed public-step rendering mismatch are recorded there. This is
local evidence, not a staging deployment or physical-device acceptance.

Exact-main CI 88140af run 36589992120 / check 109480274224 ran zero steps
due to GitHub Actions billing/spending availability.
Render's checksPass gate remains intact. Last verified live API/POS/Console/
Launcher/Booth is 0468c38; OTO App is c416065. Render was checked after the
push and has not advanced. No new CI-packed Pi artifact is available yet.

Continue with F&B guest display integration, then shop, under SCRUM-201.
Use captured quoted rows and real payment/completion facts, finite public
projection, retained station state across lock and explicit staff fallback
for unsupported wallet/prepaid/party paths. The scoped plan is saved in the
QA document. Keep live legacy lookup routes until the new POS is deployed;
retire columns only after old API readers retire in a later release.
Rebuild the lost temporary payment/offline proof helpers before post-deploy
verification; the retained simulated partial payment remains untouched.

After every substantial part: update this checkpoint and Jira status/comment
in the same turn as the push. Deployed still requires named, attached staging
screenshots. Pending decisions and operational blockers are in OPEN_QUESTIONS.md.

## STOP POINT - 29 September 2026 evening - recorded display Snapshot

SCRUM-201's per-display recorded response Snapshot is committed and pushed
on main c8f6375. Online saved-child review is now in progress on
feat/display-child-review.
Full SCRUM-201 stays In Progress and NOT BUILT as a whole until its remaining
work and staging acceptance are complete.

GET /credentials/:id/display-snapshot now reads a saved response for that
credential. Protected display session and intent responses save a finite
projection before returning; pairing, Console probes, rejected credentials
and absent refusal documents do not replace history. QR contents, contact
answers, health records, staff lease and credentials are omitted before
storage and again on read. Failed recording retains the last good response
without preventing the display response. No browser receipt is claimed.

Station/credential locks and checks of park, operator, box and reset epoch
fence recording. Current and historical park grants are required on reads.
Revoked, moved, unassigned and archived targets retain correctly labelled
history. The Console validates the shared DisplaySnapshotResponse contract,
shows prepared time and status, and never substitutes a fresh station view.
Refresh does not make a delivery. An empty record remains empty.

Forward migration 0032 adds only core.display_response_snapshot, one row per
credential, with restrictive foreign keys and finite checks. No existing
table or applied migration changes. Database verification matches the new
snapshot. All 187 affected existing checks pass: API 165 (station 50, fleet
70, auth 24, route conformance 12, guards 9), shared 6, database shape 14,
Console 2. Shared/DB/API/Console typechecks and full lint pass; Console build
passes. Independent source/migration review passes. No new suite/dependency.

The first native full ticket/browser run passed 23 checks, but its temporary
report and images were later cleared by an ad-hoc Playwright output-path
mistake. Committed source and earlier evidence remain intact. The isolated
replacement proof passes six checks and regenerates reviewed LOCAL CHECK
images: 20-local-console-recorded-response.png (10899),
21-local-console-disconnected-history.png (10900), and
22-local-console-revoked-response.png (10901), attached to SCRUM-201. It uses
a synthetic public order through the real protected API and browser, with no
sale/payment. It proves empty history, recording, disconnection while staff
advance, reconnection, revocation and persistence through a cold API restart.

The path mistake also cleared ignored payment/display helpers and three
temporary worktree directories. Branch commits remain available. Old helper
paths in dated notes are not runnable until rebuilt. Every temporary browser
config now needs an explicit dedicated absolute output directory. See
OPEN_QUESTIONS.md. Windows shell filtering and temporary config startup errors
were corrected without changing product behaviour. Two regression assertions
were corrected for valid stale actions and closed-park session refusal; the
anonymous pairing table now has a precise existing tenancy-test exception.

Exact-main CI c8f6375 run 36585794087 / check 109465628907: zero steps,
GitHub Actions
billing/spending availability. Render's checksPass gate stays intact. Last
verified live API/POS/Console/Launcher/Booth is 0468c38; OTO App is c416065.
No new staging deployment or CI-packed Pi release is claimed. Render was
rechecked after the push and remains on those live commits. Rebuild lost
temporary payment/offline proof
helpers before the post-deploy checks; the retained simulated partial outcome
is untouched. No physical Pi action was taken.

Next SCRUM-201 slice: online existing-member saved-child review at ticket
step 8 using the separate display. Use a typed finite child_review prompt
and display.child_review actions, stable visitor/request/slot bindings and
existing sequence CAS. Confirm must await the staff-authorised child PATCH;
late replies must be fenced from another visitor. New children/removal and
step 7 supervision retain explicit staff fallback. Generic prompt answers
must not bypass validation. Health, food, photos and waiver data stay on the
till. This transport slice does not establish S2-13 registration/check-in.
The detailed plan is in docs/qa/separate-display/README.md. F&B/shop display
integration and full story staging proof remain. Keep the live legacy lookup
routes until the independent-display POS is verified deployed; remove columns
only in a later forward migration after old API readers retire.

Continue independent work while deployment or an owner decision is pending.
After each substantial part update checkpoint docs, push by explicit file
list, and update Jira status and progress in the same turn. Deployed requires
reviewed staging screenshots attached and named. No secret values in evidence.

Current staging: SCRUM-206 online Slice F source `0468c38` is LIVE on
API, POS, Console, Launcher and Booth after green CI 36547262414. OTO App
remains `c416065`. Six native cases pass: cash/change, handheld split/manual,
food QR/reconnect, shop approval, decline/cash fallback and timeout/inquiry/
audited confirmation. Reviewed screenshots are attached to SCRUM-206 as
10868-10881; the final image records failure evidence. See
`docs/qa/payment-stage`. No physical booth, bank charge or printing is claimed.

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

After corrected source is LIVE, prove fresh partial reversal, GHL confirmation,
QR-disabled refusal and zero-price checkout in an isolated report using
`test-results/payment-stage-native-proof.mts`, `--output-dir` and `--only`.
The helper protects the historical records and original report; completion
applies only to requested cases. Then run `test-results/offline-guard-proof.mts`
on independent disposable fixtures, restoring the forced-offline flag afterward.
These proofs must not change the retained historical failure into a success.

Worktrees: `test-results/payment-release-worktree` on
`release/payment-follow-ups`, `test-results/payment-ui-worktree` on
`fix/payment-request-copy` (875294b), and `test-results/offline-guard-worktree`
on `fix/offline-proof` (d38eb3e). Preserve unrelated root modifications to
render.yaml and MerchCustomerDisplay.tsx; neither is in this release.

The last green CI-packed Desktop pair is `oto-box-0.1.0-0468c38.tgz`
and its `.tgz.sha256`, verified SHA-256
`044edbb9a474a945eadcc91e82598bee86b7b3f472e1630b79dceabcd1fbf1ea`.
Older pairs are in `old-oto-box-releases`. No physical Pi installation was
performed. Download the new exact-source CI artifact only after green CI and
LIVE staging, verify its checksum and replace the Desktop pair as documented.

The earlier release narrative below is retained as history.

OTO Park has finished the physical booth bench test and shared the demo.
Resume the remaining Sprint 2 software in the plan's order. The active Jira
sprint is id 3, named Sprint 2 - Complete build. Parallel work is authorised.
Write new history and progress comments about OTO Park and the park.

The deployed source on main is `5fb8525`; the documentation checkpoint follows
it with deployment skipped. Exact-source branch CI 36521169654 and main CI 36521266122
are green; main passed on one failed-job rerun after an existing concurrent
voucher assertion. No voucher source/test was changed. The single staging
deployment put API, POS, Console, Launcher and Booth live on `5fb8525`;
the OTO App remains `c416065`.
The completed work branch `fix/payment-prerequisites`, based
on `a4a79d7`, is preserved. The first batch is SCRUM-391, SCRUM-388 and
SCRUM-382. All three are Deployed, with starting, implementation and landing
comments. SCRUM-206 remains In Progress.
SCRUM-388 adds one common sale-locked reservation check in
`services/payments/attempt.ts`. Every writer reserves pending money before
requesting another payment; failed attempts release it, while the paid-only
outstanding calculation stays unchanged. The existing cash suite passes 21
tests, including two distinct simultaneous presses, all five unresolved
statuses, cash/manual refusals and a split remainder; all 23 existing offline
replay tests also pass. API typecheck, changed-file lint and independent
review pass.

SCRUM-382 is complete in the common resolver: configured disabled or archived
methods refuse with 409 PAYMENT_METHOD_UNAVAILABLE. A live replacement wins
over archived history; the declared-kind fallback applies only when no row
exists. Its two comment follow-ups are included. The method suite passes 23
tests. The sync suite now passes 23, including offline refusal retaining the
complete signed fact, no partial money, and successful Replay after re-enable.
Such offline facts need Console Failures correction and Replay; the box does
not automatically re-send an acknowledged quarantined event.

SCRUM-391 is complete: the till-facing start route honours the saved gateway,
terminal or disabled QR setting. POST and polling responses add nullable
qrPayload/qrImageUrl/expiresAt/expiryTimerMs, using the existing attempt statuses.
Action replay keeps its original route and validates sale, token, amount and
tender. Gateway I/O follows its committed attempt; only the final HTTP response
is cached. Existing gateway/terminal files pass 66 tests, including changed
routing replay, full HTTP idempotency, pending reservations and paid-after-disable.

Reservation commit e333994, availability commit c0aefae and routing commit
b02f7e0 are pushed on main. Seven existing API
files pass 196 tests (cash21, methods23, terminal24, gateway42, sync23, sales58,
redaction5); API typecheck, changed-file lint and independent review pass.
No new suite, migration or dependency. Branch CI 36485272336 and main CI
36486990526 are green. One deployment put API, POS, Console, Launcher and Booth
live on b02f7e0; the OTO App remains c416065.

The resumed instruction authorised scoped staging proof. All 21 behaviour
checks passed: routing, missing-callback recovery, disabled/archived tender
refusal, existing outcome settlement and pending balance reservation. Dedicated
proof methods were disabled and its station/terminal archived; test sales remain
in audit history. Six reviewed screenshots and the sanitised report are in
docs/qa/payment-prerequisites, attached to Jira as 10855-10860. Native Console
routing and paid POS History are separate from clearly labelled API test-run
cards. The final capture used the native station picker, reusing the 21 checks
without repeating financial records. The three tickets are Deployed.

Each push needs a ticket status change and progress comment. Deployed still
requires a named staging screenshot.

Independent SCRUM-206 Slice F work is now on `feat/payment-stage`, from
main checkpoint `11d216d`. The shared foundation adds `api/payments.ts` using
`PaymentAttemptView` and the existing QR/expiry fields; `api/sales.ts` supports
separate stable tender identities and explicit zero-tender closing; the writer
keeps successful partial tenders committed, with authoritative remaining money.
Epoch and sale-identity guards reject stale adoption after cart change, reset
and unmount. All 38 tests in the existing sale-writer file pass, including API
body/key contracts, split completion and stale responses. POS typecheck, package
lint and independent review pass. Foundation `2f694e1` is now deployed.
UI work is isolated on `feat/payment-stage-ui` at
`test-results/payment-ui-worktree`: the shared controller and adapters for the
till, handheld till, food station and shop are pushed as `cf67d86`, including the
mobile food-station caller. Branch CI 36523891229 is green. Existing writer
checks pass 53; POS typecheck, package lint
and production build pass. GHL permits staff confirmation without unsupported
inquiry. This separate source checkpoint is not deployed; native staging UI
proof is still pending.

SCRUM-387 is Deployed on main. Its changes keep the first transaction's answer,
cache complete inquiry/confirmation envelopes, remove internal drawer routing
from sale replies and preserve complete print responses. Existing affected
tests pass (147 in five files); API typecheck and lint pass. Test print/reprint
commit job, command, audit and complete answer atomically. Six failure/retry
cases prove zero orphans after failure and one effect after retry; a failed
first transaction releases response ownership for a successful skipped fallback.
All six live staging replay checks passed, with dedicated proof cleanup complete.
The reviewed API test-run card is attached as 10861 and named in the completion
comment. Evidence is in docs/qa/payment-prerequisites. No new defect ticket.

SCRUM-452 is Deployed, the spin-duration task in sprint 3, linked to SCRUM-198.
The ten-second default and whole-second Console control (2-20) are on main.
A duration is frozen for each spin; it travels through the existing
publish flow and cached bundle. Default 10 is omitted from published settings
to preserve old version/hash bytes. Migration 0028 passed 22 existing DB tests;
shared 13, wheel 5 and API 44 tests, all touched typechecks/lint pass (84 tests
total). Source commit `3dd57d4` and SCRUM-387's `233113e`/`5fb8525` deployed
together. Nine live duration checks passed; the six reviewed screenshots are
attached as 10862-10867 and named in the completion comment. Native staging
assets on an isolated local box measured 12,015 ms online, 12,006 ms after an
offline instance restart and 10,002 ms at default. Each printed with the result
visible; offline made zero cloud calls. The last two checks used a fresh scope,
retaining the first seven passing facts and screenshots. Proof inventory was
archived, and existing booth published versions remain unchanged. Evidence is
in docs/qa/booth-spin-duration.

Green main CI 36521266122 packed `oto-box-0.1.0-5fb8525.tgz`. After staging was
live, its downloaded checksum and Desktop copy were verified as
`f82baa9a6053df514ebfd75a27529aba25b44b33d6ca012aba61b704c61a49f2`.
The `.tgz` and `.tgz.sha256` are on the Desktop; the older pair was moved into
`old-oto-box-releases`. No physical Pi installation was performed.
Update the physical Pi using PI_BOOTH.md's Update step before
publishing a non-default duration; cloud deployment alone does not update it.

Next, verify the current online UI deployment on staging for SCRUM-206 Slice F.
The original `cf67d86` branch had green CI; current-release proof is pending.
Do not mark the story Deployed yet.
Its UI must use the
authoritative sale and a distinct stable identity per deliberate split tender;
an approved electronic attempt must not be charged again through cash-style
finalise. Offline browser-to-box transport is missing (SCRUM-269/285), and the
independent customer display route belongs to S2-08. Do not claim complete
offline or cross-device acceptance from an online same-page demonstration.
Real 2C2P sandbox proof requires credentials; the existing simulator is usable.

Unrelated `render.yaml`, `services/`, `output/` and
`apps/pos/src/components/merch/MerchCustomerDisplay.tsx` remain excluded.
Do not print secret values. The completed booth and Pi release below are
historical evidence; no physical booth configuration has been changed.

## STOP POINT - 28 September 2026, evening - bench round 1 deployed

23:23 follow-up: the owner reports the physical Pi update and bench testing work.
Read-only staging inspection at 23:12-23:16 verified FortuneWheelBox / booth-1
(hostname booth), FWBooth1 / B1, Booth Voucher Printer reachable with paper OK,
and published/running wheel version 5 with seven active prizes. The 28 September
Spins and Vouchers totals agree: 24 spins, 24 printed, zero redeemed. Nine rows
name staff; 15 earlier rows are unattributed and one is clock-uncertain.
Three prints at 22:57 occurred between failed cloud calls; outcomes ending 3NR3,
BPJM and SE26 are now in the cloud ledger. Recent heartbeats show outbox zero.
A single draft sort-order value for the 300 THB prize remains different from
version 5; nothing was saved or published. Three gift prizes lack cost entries.

The 15-step numbered walkthrough is in docs/qa/booth-walkthrough, with a PDF,
numbered PNGs and ZIP in Desktop/OTO Booth Walkthrough. Every PDF page was
rendered and visually reviewed. Forms were opened only for reference and
cancelled; a diagnostic log refresh was the only box command. No new spins,
configuration changes, application code, tests or deployment. This is a
documentation follow-up under SCRUM-451, linked to SCRUM-198. Next is the owner's
video of the physical press, reveal, print and matching Console voucher row.
Five named staging screenshots are attached to SCRUM-451 as 10849-10853;
the progress comment records the evidence and the ticket is Deployed again.
The earlier deployment checkpoint below remains historical evidence.

The round is complete on main. `wip/bench-round-1` is preserved; useful pieces
were reviewed and completed from main 5c0eb91 on feat/bench-round-1. The four
feature commits are:
- SCRUM-448: 8df6482, print at reveal, 30-second held-job fallback, idempotent print.
- SCRUM-449: 94042b3, button gestures, assigned staff list, five-digit pad and menu.
- SCRUM-450: 652d933, set/generate/expiry/remove PIN, migration 0027, pinExpiresAt cache.
- SCRUM-451: b9d68e3, Vouchers ledger/CSV, booth Spins and six-step setup checklist.

All four tickets are Deployed in sprint id 3 and linked in comments to SCRUM-198.
Staging attachments 10841-10848 are named in their completion comments. Screenshots
and the measured result are in docs/qa/bench-round-1. Main has a final docs-only
checkpoint after the four feature commits, with [skip render] to keep one deploy.

CI 36432299165 passed on b9d68e3de1db3f4e6629d12595c1188150dbeaf8:
typecheck, lint, migration replay twice, tests, builds, Pi scripts/package and
Console browser checks. No new test suite. Local verification used the existing
touched-file tests; disposable manual probes also checked ledger/CSV/Spins branch
scope and invalid dates, and API-to-box PIN generation, exact length, expiry and
removal. Migration 0027 matches its snapshot. CI's old four-digit fixtures were
corrected inside the PIN commit before this release; the earlier tips never deployed.

One staging deployment: API, POS, Console, Launcher and Booth are live on b9d68e3;
OTO App is unchanged on c416065. The real staging proof used the published Booth 2
(proof) on the virtual box with its simulated receipt printer. It selected staff
and entered all five PIN digits using Space only, opened the staff menu by holding,
and spun on the first press. The press answered queued; print was requested 6,651 ms
later while the result card was visible and answered printed. A duplicate returned
the same outcome; an unknown spin returned 404. The code and QR were hidden after
printing. PIN generation/set/expiry storage/invalid-length refusal/removal passed.
Spins, Vouchers and CSV contained the printed voucher and issuing staff.

Temporary station assignments, manager assignment, PIN and screen credential were
restored or revoked after the proof. The physical Pi and FWBooth1 were not changed.
Two proof spins remain as normal staging records (the first capture had a browser
selector issue; the completed repeat produced verification.json).

The CI artifact, not a local build, was downloaded from run 36432299165. Desktop:
- oto-box-0.1.0-b9d68e3.tgz
- oto-box-0.1.0-b9d68e3.tgz.sha256
SHA-256: ab4f98cff2408f9ac8f5f6b610e82bb46155d52fd27d43e5654d9bce455b3a0d
The download and Desktop copy both matched. The older 08ffe66 pair was moved into
Desktop/old-oto-box-releases alongside the previously archived releases.

At the earlier 21:25 checkpoint, the Pi update and physical checks remained for
the owner; the 23:23 follow-up above supersedes that next step. Counter-issued vouchers have no issuing station
in the existing table; the ledger labels that absence. No other bench-round work
is outstanding. Unrelated render.yaml, services/ and MerchCustomerDisplay.tsx
remain excluded and uncommitted.

## 2026-09-24, afternoon — the Lucky Wheel booth is the first priority

The owner has his Raspberry Pi 5, the receipt printer, the vertical TV and the
red button and will bench-test the booth against staging himself before the
mall. He asked for a complete audit first, then commanded the build. **Read
`docs/progress/plans/booth/PLAN.md` (his decisions, the rounds, the bench
test) and `AUDIT-2026-09-24.md` beside it (58 requirements against the old
game and the platform: 18 proven, 1 unproven, 16 partial, 18 not built, 5
different; the Pi runtime and the counter were not built at all).**

- **Decided by the owner, final:** the Pi is a real box beside the virtual
  box; codes stay minted on the box (never raise it again); redemption is
  held at the scan and used up at payment, priced on the server, online only;
  switched-off prizes never on the wheel; staff sign-in stays — account or
  PIN, only if assigned, a session of the admin-set length that never ends on
  idle; the Pi plug-and-play; a closing audit before "ready".
- **Tickets (16:07):** SCRUM-398 (S2-24a, the Pi runs the booth box, under
  223), SCRUM-399 (S2-07c, sign-in by account or PIN, the booth picker, the
  session length, reprint, the staff name on the slip, under 198), SCRUM-400
  (S2-07d, voucher types, booth staff and PINs, the session length in the
  Console, under 198), SCRUM-207 (S2-10b, redemption — reopened); Bugs
  SCRUM-394 (a switched-off prize still on the wheel, High), 395 (reprint
  404), 396 (the slip's staff row, venue and wording), 397 (voucher types
  default offline-allow). 207, 223, 398, 399 and 400 are In Progress; 199
  carries a correction (its comments claimed nobody can spin unsigned; the
  code and the spec say otherwise).
- **In flight — round 1, two gated workflows on `claude-opus-5-5`:** P1 the
  Pi runtime, sign-in, reprint, slip, inactive filter (`wf_1c7d851c`) and P2
  the redemption api with the check character and migration 0021
  (`wf_eafdc0e2`). Disjoint file lists (the plan's table); both may add one
  registration line to `apps/api/src/app.ts` — pick that hunk into the right
  commit. Round 2 (P3 the till, P4 the Console) follows their landing; then
  the end-to-end proof with a real agent process on this machine against
  staging, the adversarial audit, and "ready" to the owner, who then names the
  printer and connects the Pi.
- **The remaining Sprint 2 order (391, 388, 382, Slice F …) waits behind the
  booth**, by the owner's instruction.
- **Round 1's first gates (evening): both refused on real points, both in fix
  rounds.** P2 (redemption api): built and green (api 1,385, shared 24 for the
  check character, db 14 for migration 0021), refused on a voucher taken back
  off a rung-up sale that could then be paid by card or QR, discount codes of
  booth shape refused, the demo reset failing after a redemption, a declined
  tender stranding the voucher; plus a dropped character reading "not synced"
  and a free item's markdown split across lines — fix round `wf_20885386`
  (adds a void route for a rung-up sale with no money taken and guards every
  tender start); wip ref `wip/207-redemption` (`8dd1d9b`). P1 (Pi runtime):
  built and driven end to end on this machine as a real box (claim, picker,
  account and PIN sign-in, print, reprint, printer down, offline, sync),
  refused on a test harness broken by the check character, a box that waits
  out a stalled cloud for minutes before serving the TV page, and guide gaps;
  low findings on a Thai font offline, false comments, a throttle bucket
  cleared too early, 401/404 shown as "offline" — fix round `wf_1fa9b7c2`;
  wip ref `wip/223-pi-runtime` (`9f8f315`). **Carried to round 2:** the
  staging voucher definitions' terms still name "HKT Central" and no route
  edits terms (S2-07d, SCRUM-400, plus a data fix on staging); `app.ts`
  carries one registration line from each round — pick the hunk into the
  right commit; `packages/shared/test/cart-totals-line-target.test.ts` is
  P2's. Both gates' full verdicts are the last result lines of their
  workflow journals.
- **Round 1 landed (21:57), one push, two commits:** `1de320c` — the Pi runs the
  booth box (P1: claim/run, the loopback server serving the page and the
  `/booth/*` contract, the page before the cloud with a 15 s transport
  timeout, the booth picker, sign-in by account under the box credential or by
  PIN with the published session length, reprint, the staff name on the slip,
  inactive prizes off the wheel, one press one slip, `scripts/pi` and
  `docs/ops/PI_BOOTH.md`; three gates — refused on a harness broken by the
  check character and a box waiting out a stalled cloud, then on a double
  slip on a stalled boot, then MERGE); `13a6e70` — the redemption api (P2:
  lookup/hold/consume/release, server pricing aimed at one line, the void
  route and tender guards, the persisted guess throttle, migration 0021, the
  MOD 37-2 check character; three gates — refused on a voucher taken off a
  rung-up sale and three more, then on the line-removal race against Pay,
  then MERGE). `app.ts` carried one line from each: hunk-picked. Jira:
  398, 399, 207, 394, 395, 396, 397 in **Testing** with the cards; the wip refs
  dropped. CI on `13a6e70`: see `gh run list`. **Round 2 launched at once:**
  P3 the till (`wf_b50b366a`: the box classifies a voucher code, the ticket
  and F&B tills hear it over the channel, from a USB scanner burst or typed,
  hold → pay → refusals, the void with a reason, a voucher never on an
  offline sale, a cart of one free item allowed) and P4 the Console
  (`wf_a685de68`: voucher types with wording TH/EN, links, expiry or never;
  booth staff and PINs; the session length; migration 0022; a set-up guide
  for the owner). Their app.ts lines are hunk-picked again at landing.
  Then: the end-to-end proof with a real agent process against staging, the
  closing adversarial audit, "ready".
- **CI after the landing:** `13a6e70` went red on one test only — the check
  character's conformance test (60,000 comparisons) ran 0.4 s past vitest's
  5 s default on the runner; `d630749` gives it 30 s; green; staging live on
  it at 22:2x (api healthy, migration 0021 applied, the voucher route answers
  401 unsigned, the booth and POS sites serve).
- **Round 2's first gates (night): both refused, both in fix rounds.** P4
  (Console: voucher types with wording TH/EN, links, expiry or never; booth
  staff and PINs; the session length; migration 0022; `docs/ops/BOOTH_SETUP.md`)
  — built and green (api 1,427, db 75, Console e2e 9/9), refused on text only:
  the slip's terms reached paper at the box's next pull, not at publish, while
  the guide and five comments said otherwise — the fix round (`wf_d1fe8608`)
  freezes title, instruction and terms at publish and corrects every statement
  (including three lines of `PI_BOOTH.md`); wip ref `wip/400-console`
  (`2b3bfc2`). P3 (the till: the box classifies a voucher code, both tills hear
  it over the channel, from a USB burst or typed, hold → pay → refusals, the
  void with a reason, a voucher never on an offline sale) — 35/35 browser
  checks, refused on: a voucher-only ฿0 sale finalised the moment the payment
  screen opened (and Cancel threw it away), a menu-item voucher redeemable at
  the ticket till with no kitchen ticket, the platform's quote refusal hidden
  behind the offline message; decisions taken in the fix round
  (`wf_8ee96f72`): `issuedBy` on the api's voucher view and the card, the F&B
  band field accepting a typed voucher, Cancel voiding any rung-up sale that
  took no money, the handler listed; wip ref `wip/207-till` (`fce502c`).
  Landing order when both pass: P4 then P3 (P3 edits `vouchers.ts` viewOf;
  P4 edits `sync-booth.ts` comments only — disjoint); `app.ts` carries P4's
  line only (hunk-pick if anything else appears).
- **Round 2 landed (25 Sept, 02:24), two commits:** `c4f8b4e` — the till
  (P3: the box classifies a voucher code and answers with it, validating
  nothing; both tills hear it over the channel, from a USB burst or typed;
  the card with prize, booth, printed by whom, valid until, the platform's
  amount; hold → pay → the platform's own refusals; a ฿0 sale rung up open
  and closed only on confirmation; Cancel voids any rung-up sale that took
  no money; a menu-item voucher refused at the ticket till and redeemed at
  the restaurant till onto the kitchen ticket; a voucher never on an offline
  sale; `issuedBy` on the api's voucher view; two gates — refused on a ฿0
  sale closed when the payment screen opened, a menu-item voucher at the
  ticket till, a refusal hidden behind the offline message; then MERGE on
  93 + 28 browser checks). `9673e39` — the Console (P4: Voucher types with
  wording TH/EN, links, expiry or never; Booth staff and PINs; the session
  length; migration 0022; the wheel carries each worded type's words and
  the box prints them from the version it runs; `docs/ops/BOOTH_SETUP.md`;
  three gates — refused twice on the truthfulness of "when the words reach
  paper", then MERGE). Jira: 207 and 400 in Testing with their cards; the
  wip refs dropped. CI: `c4f8b4e` and `9673e39` — see `gh run list`.
- **Now: P5, the end-to-end proof on staging** (`wf_48780591`; the closing
  adversarial audit runs beside it as `wf_4cc5255f`): the set-up through the new Console screens as
  the owner will do it, a real agent process on this machine claimed as a
  box against staging with a fake network printer capturing the slip bytes,
  a second booth on it, sign-in by account and by PIN, spins online and with
  the internet cut, the vouchers synced, redeemed once at the staging till
  by typed code and by the Console's scanner, refused the second time, the
  demo mode on the virtual box still working. Then 398, 399, 400, 207 and
  394–397 → Deployed by the walker, the closing adversarial audit, and
  "ready" to the owner.
- **P5 held on staging (02:37–03:37, `wf_48780591`): every step of the bench
  test works except one that is not the booth's.** Through the Console as the
  owner will: a Bracelet Workshop add-on created in the POS admin (staging had
  none), Kids Pizza linked to Margherita Pizza and set to never expire, the
  1+1 to 1 Hour Play, all six types worded TH/EN with new terms (the "HKT
  Central" ones gone), som on Booth 1 with a minted PIN, the session 10 h,
  Booth 1 published v3, "Proof box (25 Sept)" added and claimed by the runner
  on this machine (online in 43 s), a fake ESC/POS printer on the loopback
  (the override alone is not enough: the Console must hold the printer row),
  Booth 2 (proof) on it with three prizes and the 200 THB switched off. The
  TV: the picker, account sign-in in 0.2 s "Until 12:53", the spin and the
  slip decoded from the printer bytes (the type's own words, the code, the
  QR, "Staff: Som (Reception) (S-QWT6)", the expiry or "No expiry"), sign
  out, PIN, reprint with the same code, the internet cut (account refused
  with "No internet — sign in with your PIN", the PIN working, two offline
  spins printed with the orange dot), the sync on restore (4 spins in the
  Console within 100 s). The till: the typed code → the card with "Printed
  by Som" → a free Bracelet line → cash T1-000019 → "Already redeemed on …
  by Som (Reception)"; "Invalid code"; "not synced yet"; Kids Pizza refused
  at the ticket till and redeemed at the restaurant till (T1-000020); the
  offline-printed voucher redeemed after the sync (T1-000021); the Console's
  scanner → the ticket till's card through the polling fallback in 3.4 s
  (T1-000022); the till offline refusing in 20 ms with no request; six wrong
  codes → the lock. Demo mode: Booth 1's paired page on the virtual box spins
  on v3 with the new words. **BROKEN, not the booth's: the kitchen ticket
  never reaches the simulated kitchen printer** — no F&B sale sends a print
  job to the box today (the order station's banner says kitchen printing is
  S2-11, **SCRUM-208**); the voucher's free pizza shows on the till's own
  ticket only. Cards: `staging-398-pi-box.png`, `staging-399-signin.png`,
  `staging-400-console.png`, `staging-207-till.png` (opened and checked).
  **Deployed by the walker at 03:41: SCRUM-398, 399, 400, 207, 394, 395, 396,
  397** (commits linked). Left on staging: the Proof box (offline, credential
  deleted — archive it), its printer row, Booth 2 (proof), Booth 3 archived,
  the six worded and linked types, the Bracelet Workshop add-on, Booth 1 on
  v3 with 10 h, **som's PIN on Booth 1 and 2 (the owner resets it)**, sales
  T1-000019–22, two unredeemed vouchers, a Health warning from the wrong
  codes.
- **The guides need twelve corrections before the owner follows them** (from
  the pass; go into the audit's fix round): Add a box needs a Slot; a new booth
  cannot publish until a Layout is chosen; the station's "Who may use it" step
  ("All staff" puts the booth in every POS picker); §5.1 says "network", the
  Console says "LAN" (Model and Protocol may stay empty); the printer override
  does not replace adding the printer in the Console; the number beside the
  offline dot counts records (about three per spin), not vouchers; the
  Screens panel on a Pi booth says the TV shows "ask our staff" until a screen
  is paired, contradicting PI_BOOTH; BOOTH_SETUP step 1 assumes a "kids pizza"
  product and the POS admin F&B page shows a "'HKT Central' has no record"
  banner; the link pickers list look-alike duplicates (two Ice Cream Cones,
  two Grip Socks); step 6 should name Receipt Printer 2; the Console preview
  still says a switched-off prize is drawn on the TV; after midnight "Spins
  today" shows the trading day while slips print the calendar day. Also seen:
  the order station's menu grid at Reception Till 1 showed only "Ice Cream
  Cone ฿60" — not investigated.
- **Running: the closing adversarial audit** (`wf_4cc5255f`: five finders,
  a skeptic per medium-or-worse finding, a ranked list with a fix plan). Its
  confirmed findings and the guide corrections go into one fix round, then
  "ready" to the owner with the printer question.
- **The closing audit (`wf_4cc5255f`, 02:36–04:40; 39 agents): "not yet, but one
  fix round away."** 79 findings, 33 attacked by a skeptic, 30 confirmed, 3
  refuted, 46 low. Critical: C1 — a voucher on a sale rung up and then left
  (the two-minute lock, a header tab, a reload) is refused everywhere with
  "pay or void that sale first" and no screen can pay or void it; C2 (latent)
  — a hand-over-prize slip on its own can never be used up. High: H1 — a
  printer silent to status queries turns every press into "Booth not ready"
  while the slip prints (depends on the owner's printer); H2 — a booth saved
  with an empty code prefix publishes and is dead. Mediums M1–M18 (wrong
  Console and TV words, expiry at the minute of the win, a branch manager
  setting another park's PIN, shared PINs, a raceable PIN lock, a second
  screen voiding a live cash sale, Google Fonts blocking the TV, a stalled
  printer hanging the box, the clock, the store's growth and damage, promo
  codes priced by the till). Full text committed as
  `docs/progress/plans/booth/AUDIT-CLOSING-2026-09-25.md` (§5 the fix plan
  with eight disjoint lanes, §5.6 the 29 tickets for later, §6 the owner's
  questions Q1–Q13). **The fix round is launched** (`wf_` in the next
  checkpoint): lanes A–H per §5.2, with the owner's questions answered by
  the audit's recommendations until he says otherwise — Q1 A (expiry at the
  end of the printed date), Q2 A (a hand-over prize at reception as a ฿0
  sale), Q3 A (any cashier with the void permission), Q5 A (the release
  file sent with its checksum), Q6 A (Kids Pizza is the pizza only); Q4 (the
  printer) waits for the owner. After it: CI, a staging proof of C1, C2, H1,
  H2, the release packed at the merged commit, the tickets of §5.6, then
  "ready".
- **The audit's fix round landed (25 Sept, 08:59) as eight commits by lane,
  `79a1c0e` → `4d0e24e`** (B the api's hand-over prize at ฿0; C the booth
  prefix rule and the branch-and-rank checks on booth staff and PINs; D the
  box's bounded press, the named prefix refusal, expiry at the end of the
  printed day, the serialised PIN lock and the ambiguous-PIN refusal; E the
  printing's one-second status give-up and the write deadline; F the
  television's duplicate_press line, the unpublished-wheel line online vs
  offline, the prefix hint, Google Fonts after mount; G the Console's
  required prefix, the Screens panel on an own box, the preview without
  switched-off prizes, the hints; A the till's void offer and History's Void,
  a screen voiding only its own sale, the ฿0 "No payment needed", the
  hand-over prize on both tills, the smoke spec reading its sign-in from the
  environment; H the guides corrected and `docs/ops/COUNTER_VOUCHERS.md`
  new, with the text fixes outside every lane). Workflow `wf_3bb37ea4`
  (eight lanes, eight lane gates, one integration gate — every bench
  scenario passed on the combined tree, the merge held on comments and one
  Linux-only test) then `wf_c10bc803` (the text and the test; MERGE). The
  wip ref `wip/booth-p7` dropped. **CI on `4d0e24e` went red on one
  wall-clock bound in the new printer tests (1.25 s on the shared runner);
  `8ffe856` loosens the bounds to hang guards (the status queries are the
  proof) and is green. The release for the Pi is packed at `8ffe856`:**
  `packages/box-agent/dist/oto-box-0.1.0-8ffe856.tgz` (1,022,558 bytes,
  SHA-256 `7e98001b93d2ffcb61490f9b784c9a823ca871eada761a83fe312351055cb609`),
  sent to the owner with its checksum file at 09:4x (`dist/` is ignored by
  git; re-pack with `pnpm --filter @oto/box-agent pack:pi`).
  **The audit's follow-ups are SCRUM-401 to SCRUM-429** (29, in the sprint:
  401 promo codes priced by the platform and 402 the Pi's clock at High; the
  damaged store, the outbox growth, free products at other parks, the
  retried unsynced slip, the till's sale through a lock, the CI tests and
  the CI pack step at Medium; the rest Low). **In flight: P8** (`wf_eb9c1b9f`; the first run `wf_f1376481` stopped
  correctly at the red CI), the staging proof of C1, C2, H1, H2 and the
  counter guide once staging is live at `8ffe856`; then "ready".
- **P8 held on staging at `8ffe856` (09:19–09:48, `wf_eb9c1b9f`): every fix of
  the closing audit works as a person sees it.** H2: an empty prefix refused
  with the red line and Create greyed, "PI1" cut to "PI", "B-" refused by the
  api's own sentence in the drawer, the api refusing null/PI1/B-/b3 on create
  and update, the box's television naming the prefix rule before any booth
  exists. H1: with the stand-in printer silent to status queries the wheel
  turned 2.2 s after the press and the slip printed (decoded from the bytes),
  never "Booth not ready"; answering, 0.18 s; a reprint on the silent printer
  went through. C2: a "Proof gift" hand-over type created, its slip alone →
  "Ring up to use it, then hand over", Pay ฿0 → "No payment needed" → Complete
  Sale (T1-000023) → a second scan "Already redeemed … by Som"; the type
  archived with the Console's warning about the prize that points at it. C1:
  Pay, the padlock, the same slip on a new cart → the refusal named the unpaid
  sale (till, time, ฿890) and offered the void → voided with its reason, the
  voucher on the new sale, paid (T1-000024), a third scan refused; History's
  own "Void unpaid sale" with a reason works. M6: the slip's "Expires 09 Oct
  2026", the card "valid until 9 Oct 2026", the api's moment the end of that
  day in Bangkok. The counter guide walked at both tills (Bracelet at the
  ticket till, Kids Pizza refused there and taken at the F&B tab, a scanned
  slip landing by itself in 6.6 s, the bin before Pay, Cancel after Pay). The
  demo wheel spins. Cards: `staging-207-fixes.png`, `staging-398-printer.png`,
  `staging-399-prefix.png`, `staging-400-console-fixes.png` (all four opened
  and checked; comments 10:08–10:09 on 207, 398, 399, 400, which stay
  Deployed). **Three small gaps → SCRUM-430 (Low):** History shows a sale
  voided from the till's offer as Voided without its reason; the list says
  "Unpaid" after a void until a reload; a voided sale keeps a greyed Refund;
  the code stays in the Redeem box after the offer's void. One guide sentence
  corrected in this commit: the counter guide's Pay step now names the
  Customer Details screen the till shows first. Left on staging: "Proof box 2
  (26 Sept)" offline with its credential deleted, its printer row at a
  loopback address, "Booth 3 (fixes)" (B3, v1; its Proof gift prize points at
  the archived type, so its next publish is refused until the prize is
  changed), sales T1-000023–26 and three voided unpaid sales, two unused
  Bracelet slips, **som's booth PIN minted by the pass (the owner resets it —
  a PIN belongs to the person, so it applies at Booths 1, 2 and 3)**; Booth
  1's odds, the six launch types, the shop untouched.
- **READY (10:14).** Told to the owner with: the release
  `oto-box-0.1.0-8ffe856.tgz` and its SHA-256 (sent 09:4x); the bench steps
  of `docs/progress/plans/booth/PLAN.md` with the three guides; what to reset
  on staging first (som's PIN; archive the two proof boxes and their booths;
  clear the Health warning); the printer question (Q4) and the decisions
  still open (the audit's Q1–Q3, Q5, Q6 taken by recommendation; the
  multi-staff attribution plan's six choices). Next after the bench: the
  audit's follow-ups SCRUM-401…430 in their priority order, then the Sprint 2
  order that waited (391, 388, 382, Slice F, …).
- **Quick rounds after READY (25 Sept, 11:00–15:12).** The owner's instruction
  of the afternoon: small defects and minor changes go on Fable quick rounds (one
  fix agent, one light check, no long gates); stories and functional tasks stay on
  Opus with full gates and every test case; every landing gets a Jira comment with
  its proof; layout and responsiveness fixes are allowed, no design change without
  permission; nothing extra without approval. His printer is an **Epson TM-T82IV
  on Ethernet** — the Pi guide names it and how to read its address (`a34acb0`);
  the red button stays Space, changeable in Console → Booths → Booth settings →
  Button key (already built). Landed, each with a comment and the ticket in
  Testing: `cf9b9df` CI packs the Pi release and checks the Pi scripts (the CI
  part of SCRUM-422); `51e1988` + `815e7db` SCRUM-409 (the Console asks before
  changing a voucher type's worth and names the unredeemed count); `494b6d6`
  SCRUM-430 (History shows who voided and why, re-reads the list, hides Refund)
  + SCRUM-424 (a timeout per scan poll, away from visibility); `4dc6cd7`
  SCRUM-411 (migration 0023: a BEFORE TRUNCATE trigger on the ledger — the
  non-owner database role half is a hosting step, flagged on the ticket);
  `1bdc8d4` SCRUM-413 + 427 (a print fact must name the booth's own voucher and
  a requester on its staff list; a voucher's type must have been on a published
  wheel of that booth); `b39d39b` SCRUM-417 (the 1+1 aims at the line with the
  most kid value left; a void gives the tier check back); `befdcf1` SCRUM-418
  (atomic credential, the claim code at a prompt, status before claim, 32-bit
  refusal, persistent journal, the SSH state named — keys-only stays opt-in,
  flagged); `4bbb4fd` SCRUM-414 (the box remembers its minted codes and draws
  again; a booth prefix is unique per operator; the collision test re-staged as
  a second booth's fact, since one box no longer repeats itself). Staging ran
  `494b6d6` on all five services at 14:35. **In flight:** SCRUM-429 (Opus, gated — a printer that answered before the job and is silent after it is failed with `PRINTER_SILENT_AFTER_JOB`, never recorded printed; `wf_753dddc0`), the sale view's `voidedAt`/`voidedByAccountId`/`voidReason` for History (`wf_30ab5eb0`), SCRUM-420 paper width (`wf_b71ff105`).
  **Next:** land what is in flight; re-pack the Pi release at the batch's head
  and send it with its SHA-256 (the owner's `8ffe856` release still benches —
  nothing landed since blocks the bench); one combined staging pass with a
  screenshot per ticket → Deployed for the screen-facing ones (409, 430, 424,
  420), the api-only ones with the staging answer or the test run as the image;
  then Opus rounds SCRUM-402 (the Pi's clock) and SCRUM-401 (promo codes priced
  by the platform), then the rest of 401–429 by priority. Deployed still needs
  a staging screenshot per ticket.
- **The quick rounds proven and closed (25 Sept, 16:28).** SCRUM-429 landed as
  `f851037` (a printer that answered before the job and is silent after it ends the
  job failed with `PRINTER_SILENT_AFTER_JOB`, never printed; its residual — the next
  job to a still-stopped printer looks like a never-answering unit — is SCRUM-431).
  CI packs the Pi release per commit: the artifact of `f851037`
  (`oto-box-0.1.0-f851037+local.tgz`, SHA-256 `27fcb3df…d349`; the "+local" is a CI
  naming slip noted on SCRUM-422) was handed to the owner and copied to his Desktop.
  **The combined staging pass** (`wf_16250ee9`, staging at `a3552e8`, then
  `f851037`) produced nineteen images (`e7c3c80`): real screens for 409 (the worth
  question with the count of 2), 414 (B1 refused at both branches, nothing created),
  424 (a card: polls 9 / 0 / 10 across visible, hidden, visible), 420 (the Paper
  width field) and 430 (the three voided sales and their pages); test-run cards for
  411, 413, 427, 417 and 418. **Deployed:** 409, 411, 413, 414, 417, 418, 424, 427.
  **Testing:** 420 (its labels clip in the half-width column → SCRUM-435 first), 430
  (a void read back shows when and why but not who; "and a voucher it held is free
  again" also on a sale with no voucher — both in the next quick round), 429. **New
  from the pass:** SCRUM-432 (after a confirmed change of worth the type's words
  still say the old number; quick round running), 433 (the full voucher code in the
  discount line label, readable in History and the sale answer), 434 (a new booth
  station is asked how money reaches it — a question for the owner), 435 (the
  Devices branch select and the Paper width labels clip), 436 (the till's
  Membership Check column clips at 1600 wide with the second screen open), 437 (an
  empty cart shows the amber "Priced on this till" note). CI on `4bbb4fd` went red
  only on the auth-enumeration timing assertion (noted on SCRUM-423). **Running on
  Opus with gates:** SCRUM-401 (`wf_427cc7e6`) and SCRUM-402 (`wf_4c05abc5`).
  **Next:** land 432, 401, 402; then quick rounds for 430's remainder + 437 + 436 +
  433 (apps/pos and vouchers.ts, after 401) and 435 (Console, after 402); Deployed
  for 420 and 430 after those; then the rest of the audit's tickets by priority.
- **The two High fixes landed (25 Sept, 19:46).** **SCRUM-402** `7b360cd`: the box
  measures its clock against the platform on every heartbeat — also off a refused
  one, which now carries the platform's time (400 BOX_CLOCK_SKEW and 409
  BOX_HEARTBEAT_STALE both) — and from then on stamps events, the slip's time and
  expiry, the trading day and the daily cap on the corrected clock; the
  measurement is kept with the boot identity and set aside after a reboot or a
  step of the clock; before the first measurement events are untrusted with no
  offset; the outbox's retries are held to their backoff cap; Health says the
  clock as a person would. Three gates; the third added the one missing test
  (the `believable` guard). Residuals: SCRUM-438 (sync.ts files a clock anomaly
  even when the days agree), SCRUM-439 (an alert summary, print retries and
  station leases that move with a correction, a stale comment). **SCRUM-401**
  `4dfcb34` (+ `a63d0b5`, the sync test's claim helper scoped to the operator —
  the seed deliberately gives the second operator a box in `virtual-1`): promo
  codes are priced by the platform from `pos.discount_definition` (new
  `services/promo-codes.ts`), judged by window on the trading day, branch,
  stacking and limits counted on paid sales; unknown/archived/inactive refused
  by name; quote and commit agree; the tills and the F&B and shop stations drop a
  refused code with its reason; an offline replay is filed as recorded, counted,
  and raised as `sale.offline_promo` alert when it differs. Four gates (the third
  found the stations' stuck code, the offline lower-case count and four sales-fnb
  tests; the fourth passed with a real drive of both stations on a local stack).
  SCRUM-374's platform half is covered. **Three owner questions on the ticket:**
  a one-use code rung up twice before either sale is paid (suggested: re-check at
  payment); a free item and its paid extras; refunded sales and limits. Also
  landed: `b1fd08c` SCRUM-432 (the worth question names the words that still say
  the old worth), `31ced64` SCRUM-435 (the Paper width field and the Devices
  branch select get a full row). The Pi release of `f851037` was handed over
  (SHA-256 `27fcb3df…d349`); CI packs one per commit (artifact
  `oto-box-<fullsha>`; take that rather than packing a dirty tree). **In flight:** SCRUM-431 on Opus (`wf_39d4c199`: the box remembers per printer that the unit answers status, so a stopped printer's next job is held, not printed blind); quick rounds r11 (`wf_afc4bd15`: SCRUM-433's masked code in the discount line, `voidedByName` on the sale view) and r12 (`wf_07b16c5e`: 430's remainder on History, 437, 436, the stale itemPromo comment); CI, the Pi artifact and staging watched at `a63d0b5`.
  **Next:** land 431, r11, r12; a staging pass with a screenshot each for 429,
  432, 435, 402, 401, 431 → Deployed, and 420/430 → Deployed; a fresh Pi release
  at that head; then 438/439, the remaining audit tickets by priority (403, 404,
  406, 407, 408, 412, 415, 419, 421, 422, 423, 425, 428; 405, 410, 426 wait on
  the owner), SCRUM-434's answer, and behind the booth the Sprint 2 order.
- **Evening landings (25 Sept, 20:39).** `2246aef` SCRUM-433 (a sale's voucher line
  names only the code's last four characters; the sale answer's own code field
  stays for the till, noted on the ticket) + SCRUM-430's `voidedByName` on the
  sale view; `1620de7` SCRUM-422's CI naming (pnpm's chmod of the box's bin on
  Linux was the "+local" cause — the bin is tracked executable, the packer ignores
  mode bits, the pack step prints the tree's state; proven: the run of `1620de7`
  packed `oto-box-0.1.0-1620de7.tgz`) and the Console's vendor chunks;
  `08c3162` SCRUM-430's till half (Voided by <name>, the voucher sentence only
  when one was held), SCRUM-437 (no amber note on an empty cart), SCRUM-436 (the
  event-pass card and the identify rows wrap, so the Membership Check column no
  longer clips beside the second screen), the itemPromo comment; `e86d6f2`
  SCRUM-431 (the box remembers per printer that the unit answers status; a
  remembered printer silent before a job holds the job with
  `PRINTER_SILENT_BEFORE_JOB` and the ordinary retry prints it; residual
  SCRUM-440: held jobs delay the heartbeat tick) + `2ae20a8` (the till header
  names both silences). **Releases handed over:** `oto-box-0.1.0-f851037+local`
  and `oto-box-0.1.0-a63d0b5+local` (the first with the clock fix; SHA-256
  `1b91af90…5eaf`), both on the owner's Desktop. Staging ran `08c3162` on all
  five at 21:0x; the second proof pass runs on it (`wf_228ca0fb`: 402, 401,
  432, 435/420, 430, 433, 436, 437 on staging; cards for 429, 431, 422).
  **Building:** SCRUM-403 on Opus (`wf_27c27ae1`: listen first, a needs-service television, the outbox salvaged, no fact before a fresh epoch), SCRUM-406 on Opus (`wf_78fc771e`: a code hash beside each miss, distinct codes counted; migration 0024), SCRUM-408 on Opus, bounded (`wf_9fde98f9`: a vitest runner and tests for the till's pure libraries in CI), quick rounds r14 (`wf_210d12f9`: SCRUM-438 and the unlock test's timing flake) and r15 (`wf_00dfe73c`: SCRUM-439's alert summary, print retries and station leases held to a cap). CI on `2ae20a8` and staging watched.
  **Owner questions open:** SCRUM-401's three (one-use code rung up twice; a free
  item and paid extras; refunded sales and limits), SCRUM-434 (a new booth asked
  how money reaches it), the bench measurement for SCRUM-431 (how long the Epson
  takes to answer the first status question), SCRUM-433's code field.
- **The night batch (25 Sept, pushed 22:19 as `2160f3a`).** CI had gone red on
  `2ae20a8` for seven printer tests on Linux only; the cause was not Linux but
  the slow runner: seven slips rendering at once held the box's thread past the
  channel's timeouts, and Node ran the expired timers before reading the
  sockets, so a made connection read as unreachable and a reply already in the
  socket as silence. Fixed at the root in `64d856e` (the connect and status
  timeouts let the sockets be read first; the fake printers run on a worker
  thread; two new tests fail on the old code on both systems; 401/401 three
  times under a runner-like throttle in a container). Landed with it:
  `fae4b71` SCRUM-438 (the clock anomaly only across a day boundary), `970ce02`
  SCRUM-423's unlock case (proven by work done, no stopwatch), `d5cafd1` +
  `2160f3a` SCRUM-439 (the alert wording; leases and print retries held to a
  cap), `cb0f65a` SCRUM-406 (a code hash beside each miss, distinct codes
  counted; migration 0024), `7ea7d95` SCRUM-408 (a vitest runner for the till,
  137 tests pinning the scan poll, the voucher on the cart, the promo helpers,
  the cart quote and the sale writer; 43 mutants caught; the browser tests in
  CI and the booth smoke are left), `4fdc63f` the second proof pass's images.
  **The second staging proof (`wf_228ca0fb`, staging at `08c3162`):** Deployed
  402, 401, 432, 435, 420, 430, 436, 437, 429; 431 stays Testing (its commits
  were not yet on staging); **433 back to In Progress** — old sales keep the
  whole code in their label and the sale answer's code field is still full
  (a round runs: mask the field, relabel old rows by migration 0025, keep the
  last four visible; with SCRUM-441's wording). New tickets from the pass:
  441 (the platform's unknown-code sentence differs from the till's), 442 (the
  till keeps a typed code in its promo box), 443 (the header's branch chip
  clips at 1600). **Building:** SCRUM-403 on Opus (`wf_27c27ae1`, the damaged store), SCRUM-433's remainder with 441 on Opus (`wf_ae8cd82b`), and a quick till round r16 (`wf_2538ca76`: 442, 443, the stale runner comments). CI, the Pi artifact and staging watched at `2160f3a`; the next Pi release goes to the owner when that run is green.
  **Owner questions open:** SCRUM-401's three, SCRUM-434, the Epson's first
  status answer time (SCRUM-431), SCRUM-433's code field.
- **After the batch (25 Sept, 22:55).** CI green on `2160f3a`; staging live on it;
  the release `oto-box-0.1.0-2160f3a.tgz` (SHA-256 `84993a59…83ca`, clean name)
  handed to the owner — the one to install. **Proof pass 3** (`wf_bfff49f6`,
  images `357fc3e`): 406 driven on staging (the same made-up code six times,
  every answer "not found" with the offline-booth sentence, no lock), cards for
  431 (387/387 on CI's Linux runner, the seven once-failing cases included),
  408 (the till's 137 tests in CI's test step), 438 and 439 → **Deployed 406,
  431, 408, 438**; 439 waits for its booth-page comment (with 403). `d4f3fc5`
  SCRUM-442 (the ticket till's promo box clears once the code is applied or
  refused; four stale runner comments corrected) → Testing. **SCRUM-443 not
  landed, on purpose:** widening the branch chip to fit the seeded name takes
  the pixels from the tab band (at 1600 "Today" is cut and the Messages badge
  hides until the band scrolls), so the owner chooses — (a) the chip without
  the park prefix, (b) the wider chip, (c) a short name per branch in the
  Console. SCRUM-403's second gate refused with three defects (the salvage
  reads through the partial index; the epoch-note read fails open; a claim
  window race) and, via the Atlassian MCP, filed SCRUM-444 (the watchdog
  restarts a needs-service box; a blank TV after reboot) and SCRUM-445 (Health
  files a needs-service box under the wrong heading); round 3 also takes the
  watchdog and kiosk scripts. Local housekeeping: 31 idle leftover test
  databases dropped from the Docker Postgres (10 remain, held open by old
  processes). **Building:** SCRUM-403's third round on Opus (`wf_58e9db7e`), SCRUM-433's remainder with 441 on Opus (`wf_ae8cd82b`, migration 0025).
- **Late landings (25 Sept, 23:34).** `6a6af44` SCRUM-440 (a printer that does not
  answer gets one attempt a tick; a printer that answers again drains its slips
  in that tick); `9505189` SCRUM-423's second case (the sign-in refusal test
  asserts the work done for six classes, no stopwatch; 4.3 s → 0.15 s);
  `d4f3fc5` SCRUM-442 (the ticket till's promo box clears; four stale runner
  comments); `9ccc893` SCRUM-422's e2e-against-the-built-bundle switch, set in
  CI (its first run watched); **`e33bf12` SCRUM-403** after three gates — the
  kiosk listens before the store opens, a damaged or unreadable store keeps the
  process up with a needs-service notice (EN/TH) and a 503 naming the reason,
  retrying once a minute; the unsent outbox is salvaged from the table (never
  through an index); no fact is sealed before a fresh journal epoch, a refused
  read of the note counts as waiting, the claim window race is closed; the
  watchdog treats a needs-service box as alive and the kiosk opens on any
  answer (SCRUM-444 with it); `3cc8963` the Pi guide's retry sentence (406).
  **Deployed:** 439 (its fourth item went with 403). **Testing:** 403, 444, 440,
  442, 423 (two cases; left: undo SQL for 0021/0022 and — running — honest
  names plus the booth fake). New from 403's gate: SCRUM-446 (a stale send
  index passes quick_check) and SCRUM-447 (a re-registered box gets no fresh
  journal number from the platform — an api fix). SCRUM-443 waits on the
  owner's choice. **Running:** SCRUM-433's remainder with 441 on Opus (`wf_ae8cd82b`, migration 0025), r20 (`wf_8b932364`: 423's honest names and the booth fake). Watchers: the first CI run with the Console tests against the built bundle (`9ccc893`), and CI, the Pi artifact and staging at `e33bf12`; the next Pi release goes to the owner when that run is green.
- **STOP POINT (26 Sept, 23:57).** The owner: the defect rounds and the ticket creation
  were "never ending"; the sprint's stories cover the rest; the focus is the booth, the
  voucher wheel and sales, and the next step is HIS bench test with the real devices.
  Rule from here: no new audit or defect rounds, no new tickets unless he asks or a defect
  blocks the bench; a gate's residuals go in one line of the ticket's comment, never
  into a new ticket. The five rounds that were mid-flight when he wrote (SCRUM-445, 446,
  412, 422's till lint, 425) were stopped and their unverified working-tree edits
  reverted; at his word they were relaunched fresh from their saved scripts to finish
  and land, after which the tree stays at the last pushed commit. Everything landed is
  pushed (`01423b6`, CI running; staging at `3cc8963`); the release for the bench is
  `oto-box-0.1.0-3cc8963.tgz` on his Desktop; the guides are `docs/ops/PI_BOOTH.md`,
  `BOOTH_SETUP.md`, `COUNTER_VOUCHERS.md`; the bench steps are in
  `plans/booth/PLAN.md`. His open questions (443, 407, 428, 401's three, 434, 431's
  timing, 433's code field) are answered by the narrowest reading; none blocks the bench.
  **Done (01:59):** the five finished and landed — `9600129` SCRUM-445, `4f38e1f`
  SCRUM-446, `cb0ccb0` SCRUM-412, `afc9d3e` SCRUM-422's till lint (the whole ticket is on
  main), `c4ce3aa` SCRUM-425 (its first gate found a burst race, closed under a database
  lock in a second round; migration 0026). All in Testing. CI green through `afc9d3e` and
  staging live on it; `c4ce3aa` follows. **The tree holds here.** Nothing starts until the
  owner's bench results; then one quick round per reported defect, no new tickets.
  **Testing queue closed (27 Sept, 15:45) at the owner's request:** one proof pass
  (`wf_c5d49988`, images `aa376c3`) — History's masked labels after migration 0025, the
  promo box, the platform's "was not found" wording on staging; test-run and CI cards for
  403, 412, 422, 425, 440, 444, 445, 446 — walked 433, 442, 441, 403, 444, 440, 446, 412,
  425, 445 and 422 to **Deployed**; **423 back to In Progress** (undo SQL for 0021/0022 and
  the box/booth/shared test files' hygiene still open). Nothing is in Testing now. One
  flaky Console browser case since the built-bundle switch (one failure in nine runs) is
  noted on 422, not ticketed.
- **Bench prep (28 Sept, 01:57).** At the owner's request, not a defect round:
  `c34ec17` — the Pi installer's `--printer-direct` option (one NetworkManager
  profile, `printer-link` on eth0: 192.168.192.10/24 beside a link-local
  address, no internet route over the cable, applied again on every run,
  never switched on while eth0 carries the Pi's internet) and the Pi guide's
  direct-cable standard (sections 1, 3, 5, 7 and 8; the park's router stays
  the alternative). CI green; the release `oto-box-0.1.0-c34ec17.tgz` (SHA-256
  `b220c181…c40c`) verified and on the owner's Desktop — **the one to
  install**. Note on SCRUM-418; no new ticket. The owner benches from his
  MacBook: Imager (Legacy 64-bit, Bookworm desktop), `scp` to `booth.local`,
  the install over Wi-Fi with the option, claim, the printer cabled straight
  into the Pi, its self-test page's address followed by `:9100` in the Console.
  **The red button** is a Tezuo foot-switch board (USB `8088:0015`, calls
  itself "LinTx Keyboard"): programmable, and today it sends **no key** —
  presses reach the PC only on its vendor setup channel (65-byte reports
  `00 66 CC 03 00 01 07 …`), nothing on the keyboard or mouse channel (a
  Windows-level hook and a tap on the channel proved it, the test key
  injected into the hook as the control). The maker's setup program (the
  manual's QR code; step 4 picks Space on the on-screen keyboard, step 5
  saves) sets it to Space. **Resolved at 02:12:** the owner found the maker's
  program on a Lanzou share (`2026gaijian V2.exe`, "LinTxKeyboard-B" 1.5; a
  Defender scan of the folder was clean, the warning was SmartScreen's
  unknown-publisher notice; its config switched to English) and set the
  button to Space with it — the Pi-side adapter is not needed. The old Replit wheel
  accepted Space or Enter and its site button sent Enter, which TV Bro ate —
  Space-only stands. `button-test.html` (a browser key test) is on his Desktop.
- **The first real Pi run (28 Sept, afternoon, 16:34).** The owner imaged a USB
  stick (his card reader failed; the Pi 5 boots from the stick with the card
  slot empty), copied the release by `scp` to the Pi's address (his network
  does not pass `booth.local` around), and ran the installer with
  `--printer-direct`: clean, printer-link up, the box claimed and running
  ("FortuneWheelBox", booth "FortuneWheelBooth", prefix FW, printer from the
  Console). Three findings, each fixed the same hour and applied to his Pi by
  hand: (1) **the printer had no address** — its self-test page said
  *IP Address: None*; Epson's reference guide: DHCP on, link-local fallback
  off, 192.168.192.168 only in manual mode — `5838eb6` puts a one-address
  dnsmasq on the printer socket inside `--printer-direct` (the guide's old
  "factory address reachable" story was wrong and is gone); (2) **the
  television never opened** — `oto-kiosk.service` looped *Missing X server or
  $DISPLAY*: Chromium with `--ozone-platform-hint=auto`, run as a system
  service with no session environment, picked X11 on the Wayland desktop —
  `08ffe66` passes `--ozone-platform=wayland|x11` outright and names the
  session bus; (3) **the red button sent no key** (the morning's finding),
  set to Space with its maker's program. Notes on SCRUM-418 for both Pi
  fixes; no new tickets. **The release to install from here:**
  `oto-box-0.1.0-08ffe66.tgz` (SHA-256 `de9c90e4…6fd3`), on the owner's Desktop; his
  bench Pi runs `c34ec17` plus the two repairs by hand, which is the same
  behaviour. Harmless noise seen: `perl: Setting locale failed` at the top of
  the installer's output when run over SSH from a Mac.
- **STOP POINT (28 Sept, 17:01) — the bench round, approved and then stopped for
  tokens.** After playing the wheel on the real Pi the owner approved "bench
  round 1": (1) print at the reveal, not at the press; (2) sign-in from the red
  button alone — a staff list, then a PIN pad, one press moves, two select,
  hold repeats, a 3-second hold opens the staff menu, the list steps aside after
  30 s so the wheel still plays unattributed; (3) booth PINs of exactly five
  digits that an admin types or has generated, with an optional expiry and a
  remove, carried to the box as `pinExpiresAt` in the staff scope; (4) in the
  Console a Vouchers ledger with totals and a CSV, a per-booth Spins panel and a
  "Set up this booth" checklist with the panels in that order; (5) the OTO
  App's old voucher module switched off; (6) the launcher's wheel tile live.
  His rules: quick, no new test suites, one deploy. **Landed on main today:**
  `c34ec17` printer cable, `5838eb6` printer address, `08ffe66` television,
  `42564c3` the Box log route (GET /boxes/:id/log reads the newest collect_logs
  answer; the drawer re-reads every minute and Refresh asks the box first),
  `c416065` the OTO App's voucher module off (five pages and a section
  removed, every old address shows "Vouchers have moved to the Console"), and
  `VITE_BOOTH_URL` set on the staging launcher through the Render API (no
  code; render.yaml still lacks it because that file carries another
  session's uncommitted block). **Stopped part-way and kept on the branch
  `wip/bench-round-1` (`3bd9b06`, on top of main, NOT merged, unchecked):** the box
  side of print-at-reveal (the press no longer waits on the printer, the job
  is held for a later print call; the call, the kiosk route, the page's part,
  the staff list and the button-only sign-in were not reached), migration
  0027 with the PIN expiry column in the schema and seed, and the API's
  half-written PIN rule, generate and expiry in the booth routes and admin
  service, the staff scope's `pinExpiresAt`, and a voucher-ledger service
  draft with its route stub (none of it typechecks yet; the Console's
  Vouchers page, Spins panel and checklist were not started). **To resume:** either finish from
  that branch (the full brief is in the round's script,
  `workflows/scripts/bench-round-1-wf_59dbbe78-482.js` under the session
  folder, and in this block) or start the round again from main; then land,
  let CI pack the release, and the owner updates the Pi once (guide section
  7, "Update"). The bench Pi runs `c34ec17` plus the printer-address and
  television repairs by hand, which equals `08ffe66`. Notes on SCRUM-418
  (three Pi fixes), SCRUM-195 (box log) and SCRUM-198 (this stop); no new
  tickets. Vouchers: SCRUM-207 is Deployed (slips redeem at the tills, the
  same ledger); reports and the Radar feed are SCRUM-216, To Do.
- **Open with the owner: multi-staff attribution at one booth** (his
  question of the evening). Today one session per booth; proposed a roster
  with a claim per spin (a number-pad digit or a badge) and shared credit as
  the fallback; six choices put to him; nothing started.

## 2026-09-24 — S2-09 (SCRUM-202) closed at 06:27: the last of SCRUM-204, and SCRUM-392 on the way

The owner's decision (morning): sizes are defined on the shop product now,
not deferred to inventory. Two gated rounds on `claude-opus-5-5` (every
workflow agent runs there from today — `CLAUDE_CODE_SUBAGENT_MODEL` in
`~/.claude/settings.json`, and `model` on every `agent()` call).

- **02:05 — the member half landed** (`f5e5572`, gate MERGE after one
  comment blocker — two comments still claimed the booking site wrote to the
  browser's copy; my CRLF-blind edit missed them and the commit went out
  uncorrected, fixed in `3fff2d8`): the phone till, the booking site's
  identify step, the party builder and the counter till's drop-off hand-off
  read members from the platform; `scripts/check-no-mock-members.mjs` runs
  in CI after Lint and fails on any fixture member reader or writer outside
  `mockApi.ts`. Three files outside the round's list were needed for the
  guard to pass (`Till.tsx`'s drop-off hand-off, `Book.tsx`,
  `VerifyTierModal.tsx`) — accepted. Known gap in the guard: a destructured
  `const { x } = mock` slips past it. The booking site saves nothing back to
  a member — noted on 357.
- **The sizes half landed** (`4cad79e`, 03:28; the fix round
  `wf_ade3ffcd` returned MERGE — api 1,317/1,317, db 54/54, box-agent
  259/259, the migration applied twice identical, the three plants
  reproduced; CI green; `wip/204-variants` dropped): migration 0020
  `product.variants`, the API rules (ids, labels, barcode collisions across
  the operator, 409 `BARCODE_IN_USE`), the scan resolving a size's barcode,
  the sale line carrying the size ("Grip Socks — M" in the ledger), the shop
  screen's picker on platform variants with the prototype's "(M)" on screen,
  the platform refusing a sized item sold without a size, the Merch form's
  Sizes editor, and the first station-channel client in any screen
  (`lib/scanChannel.ts`; the virtual box's scans relayed onto the api's
  session manager by `services/station-scans.ts`). The first gate had
  refused on a deleted uniqueness test, a wrong prototype citation, and a
  stale screen dropping a scanned size. 204 is in **Testing** with the four
  cards attached and the comment posted (03:31); 202 carries a status
  comment.
- **204's staging pass ran 03:52–04:21** (`wf_f5b585d1`; staging live at
  `4cad79e` from 03:43): **five of seven steps hold, two are broken at the
  hosting.** Through the back office the old separate "Grip socks M" was
  withdrawn (its barcode freed) and S/M/L put on "Grip Socks" with
  8850000000017 on M; the shop screen's picker asks for the size and the cart
  reads "Grip Socks (M)"; the cash sale T1-000018 names its line
  "Grip Socks — M" in History; the phone till, the counter till's drop-off
  hand-off, the booking site and the party builder all read the seeded member
  from the platform (proved by a nickname written and put back). **Broken: a
  scan never reaches the shop screen.** The box reads it and the api's channel
  streams it on the api origin (200 in 141 ms, both scans live), but the POS
  site's `/api/*` rewrite on Render holds the never-ending stream back (no
  headers in 3 min 45 s; `x-accel-buffering: no` and the keepalives do not
  help), so a screen behind the rewrite hears nothing, and the unknown-barcode
  message is lost the same way. Cards `staging-204-sizes.png` and
  `staging-204-members.png` on 204 (comment 04:22) and on 202. Raised:
  **SCRUM-392 (High)** — the rewrite holds the station channel back; the fix
  decided: a finite `GET /stations/:id/scans?after=n` fed at the source and
  the shop screen polling it every 1.5 s when the stream has not opened in
  4 s (works on any hosting; the hosting alternatives — a streaming web
  service per static site, or custom domains with a cross-site cookie — are
  on the ticket for the owner). **SCRUM-393 (Low)** — the booking site's
  "Stored as" hint shows +660811111111 for a typed leading 0 (the lookup still
  finds the member). **204 stays in Testing on 392 as its single blocker
  (comment 04:29); 202 stays In Progress (comment 04:29).**
- **392 landed** (`003dac7`, 05:59; gate MERGE — api 1,327/1,327 with ten
  new tests, the POS build, root lint and the mock-members check; two plants
  and a local browser proof with the stream held: the scan on the cart 4.08 s
  after Scan, 1.0 s after the box read it; with the stream free, no poll at
  all): `lib/station-scan-tape.ts` keeps each station's last hundred scans
  with a running number, fed where scans are published (the in-process box's
  manager through `tapeScansOf`, and the api's own scan route in
  `routes/scanning.ts`); `GET /stations/:id/scans?after=n` reads it under the
  channel's standing checks and the customer-view redaction, a first call
  takes the cursor and replays nothing, and a poll never counts on `/ready`;
  `lib/scanChannel.ts` tries the stream first and polls every 1.5 s when it
  has not opened in 4 s or the browser reports it closed. Accepted from the
  gate's notes: a product scan's answer carries the catalogue SKU, which for
  a size's barcode is the digits on the label (printed on the product, no
  secret; a band code never travels); `after=0` returns the whole tape to
  anyone allowed to watch the station — an age limit is due when a handler
  puts personal data in `detail`; the in-process tap goes in on a station's
  first channel or poll, so scans before it are not on the tape; the stream
  is judged by `open` alone — a proxy that passed headers but held the body
  would need the first snapshot as the test instead. 392 is in **Testing**
  (cards `392-poll-fallback.png`, `392-plant.png`; comment 06:00).
- **The staging pass of the scan steps held** (`wf_f6d189f0`, 06:13–06:17,
  staging live at `003dac7` from 06:12): the shop screen's channel request
  through the rewrite was never answered, the screen gave up on it after
  4.00 s and polled every ~2 s (1.5 s after each answer; answers 0.44–1.08 s
  through the rewrite); the Console's scan of 8850000000017 landed on the
  cart as "Grip Socks (M)" 5.3 s after Scan with nothing touched (most of it
  the box collecting the command on its own poll), 0000000000000 showed
  "Unknown barcode" 6.6 s after Scan and added nothing, sixty seconds
  untouched brought 30 polls and nothing else, and the box's history shows
  both Simulate rows succeeded for Reception Till 1. Card
  `staging-392-scan-lands.png` on 392 and 204 (comments 06:24). **Deployed
  by the walker, with the commits linked: SCRUM-392 (06:27), SCRUM-204
  (06:27) and SCRUM-202 (06:27) — S2-09 is closed.** Left on staging: the
  two simulated scans in the box's history; no sale, no catalogue change.
- **Learned today:** the static sites' `/api/*` rewrite never passes a
  streaming answer — anything a screen must hear live through it needs a
  finite fallback (memory `oto-render-staging`).

## State at the end of 2026-09-23 — read this first

_This block replaces the running notes that used to sit here. Everything below
it is the chronological log of the day, newest first; it is kept as written._

### Where the code is

`main` is **`d435db4`**, committed at **20:47** — "sales taken while the box is
offline replay once, and the box opens the drawer itself" (tenders Slice G).
There were 191 commits on `main` today.

Staging (Render project **OTO Platform**, environment `staging`) — the live
commit on each service, read from Render at the time of writing:

| Service | Live commit | Went live |
|---|---|---|
| `oto-api-staging` | `d435db4` | 21:01 |
| `oto-pos-staging` | `d435db4` | 21:01 |
| `oto-console-staging` | `d435db4` | 21:01 |
| `oto-launcher-staging` | `d435db4` | 21:01 |
| `oto-booth-staging` | `d435db4` | 21:01 |
| `oto-app-staging` | `16c621a` | 12:24 |

So the five root-built services match `main`; `oto-app-staging` deploys only on
its own files. Auto-deploy is on for all six and waits for the GitHub checks.

**CI.** Green through `d435db4` (its run started at 20:47 and was green at 20:59;
the deploy that followed went live at 21:01).
Two runs went red today and both were fixed forward within minutes: `a232059`
(Slice B's commit left out `routes/webhooks.ts`, which `app.ts` registers —
`b616191`) and `54160b0` (a `no-empty` lint error in the committed
`scripts/session/jira-lib.mjs` — `97d738c`).

### What landed today

**The tenders — SCRUM-206, six of seven slices.** Every slice was built, gated by
an independent reviewer, and only then committed.

- **A — the tender ledger** (`3317360`, 16:36). Migration 0019: `payment_attempt`
  widened, `payment_method`, `payment_notification`, the shared vocabulary.
  Fix-round gate MERGE — full api suite 1,156 green, two-database dumps identical.
- **E — payment methods on the platform** (`8ee9a5d`, 17:27). Five routes under
  `/payment-methods`, the back-office panel saving for real, tenders hydrated on
  every catalogue load. Gate MERGE — 20 tests, three plants.
- **B — the cash tender** (`a232059` + `b616191`, 18:10 and 18:12). The attempt
  ledger, part-paid sales, the replay net on `action_id`, the drawer kick as a box
  command, payments on the Sale detail. Fix-round gate MERGE — full api suite
  1,203 green, the header-path retry proven both ways.
- **C1 — the card terminals on the box** (`51fd025`, 18:19). The PaymentTerminal
  contract, the GHL and Digio adapters, two simulators answering on the same
  bytes, 22 cited fixtures, the per-terminal counter. The gate refused twice on
  statements in comments that were not true of the code; both corrected by hand
  before the commit. 251 box-agent tests.
- **C2 — the card tender in the cloud** (`83ffc36`, 19:29). The terminal service,
  the `/payments` routes, the box's result route, the Console's terminal
  simulator panel. Gate MERGE — 22 + 5 tests end to end through the real command
  queue. Proven on staging at 19:55: approved in 4.4 s, declined, a partial
  approval refused and voided, the PAX's no-answer path walked to the end.
- **D — the 2C2P QR tender** (`24e608d`, 20:12). `packages/payments-2c2p` on
  `node:crypto` alone, the signed webhook, the polling safety net, the gateway
  simulator, 19 `PGW_*` variables. Fix-round gate MERGE — boot guard 20/20, full
  api suite 1,282 green, six findings folded in.
- **G — offline sales** (`d435db4`, 20:47). The replay through B's commit and
  finalise, `box_seq`, two sync handlers, the box's sale queue with provisional
  receipts, and the drawer pulse with `case 'drawer_kick'`. Landed after a fix
  round that closed two blockers its gate found: the offline price guard was
  opt-in, and no test reached the drawer-kick case.
- **F — the POS payment stage — is not started.** Its first item is the D↔C2 seam
  (below).

**206 stays In Progress** and must not be walked on tonight's evidence.

**Deployed today with staging evidence — 66 tickets walked from 11:46** (98
reached Deployed today in all; 32 of those in the overnight run, 01:58–06:09). The large ones, in the
order they went: the booth and its security (199, 244, 278, 298, 336, 320, 231,
315, 317, 321); the box cache and redemption work (305, 322, 323, 311, 316, 257,
309); the tenancy and API-surface fixes (318, 319, 252, 254, 304, 233, 306, 253,
255); the light-theme back-office sweep and the till's pricing honesty (325, 327,
328, 329, 330, 331, 333, 334, 335, 341, 342, 346, 349, 350, 351, 353, 354, 355,
337, 338, 343, 347, 348, 356, 344, 352, 359); the Console and printing work (358,
364, 365, 377); then 361, 366, 363, 362, 332, 367, 376, 384. The launcher halves
of 192 (Deployed on 20 Sept) and 251 (walked to Deployed at 11:46 today) were
added with a plain addendum after the launcher's own deploy was found three
days stale.

**Nothing is sitting in Testing.** Every ticket walked today reached Deployed.
**In Progress tonight: 191, 202, 204, 206.** 360 was closed Done at 21:13 by its
direct transition (not reproducible; 371 carries the decision) — the walker's
ladder has no Done step, which is why the 16:45 banner's "closed Done" was not
true until now.

### In flight right now

Nothing. G's staging pass ran 21:02–21:08 at `d435db4` and its result is on 206
(comment 21:08, two cards, committed `60b8459`): a box paired on staging took a
cash sale with its connection cut (provisional T2-000003), replayed it once on
reconnect to one sale and one attempt; a verbatim re-send answered as a
duplicate and a re-queued one carried both numbers on the audit row with a
`late_arrival` anomaly; the till's cash sale's `drawer_kick` read `succeeded`
(T1-000017) where six earlier rows read `UNKNOWN_COMMAND`. Left on staging:
two evidence boxes (361, 206-G) paired and offline with no stations.

### Raised today and still open

Ninety-six tickets were created today; sixty-eight of them were fixed and
Deployed the same day, one is the defect epic (324), and these twenty-seven
are still open:

**Payments (all from the tenders slices' gates and staging passes)**
- **391** — a station routed to the gateway for QR still sends the tender to its
  card terminal; the saved setting does nothing. *This is the D↔C2 seam.*
- **388 (High)** — two presses of Card while the first is at the terminal open two
  full tenders on one sale.
- **382** — a sale can still be recorded against a disabled or archived tender.
- **390** — a late progress report can overwrite the references on an attempt
  already settled.
- **389** — the box's payment result route carries no per-address ceiling.
- **387** — only the outermost transaction under an idempotency key may write the
  stored answer; `print.ts` still carries the dormant class.

**Console, boxes and printing**
- **378** — a box can be created but never retired.
- **381** — the till's own Station Setup test print records no print job, so the
  box's outcome is refused.
- **385** — a wrong booth screen credential is never throttled on its own.
- **386** — the throttle table is never swept, and an invented box id opens a row.

**Promotions**
- **368** — a free-item promo code takes nothing off on the F&B and shop lanes.
- **373** — a code used at those stations is invisible to the till's reports and
  receipt.
- **374** — a code's usage limit is enforced nowhere on the platform.
- **375** — fold the station promo quote hook into the shared one.

**The till and the light theme**
- **360 (In Progress)** — the phone till's hand-to-customer overlay appears to
  reset the sale. Driven for 45 s with the network captured and nothing moved;
  what loses the sale is the 120 s inactivity lock unmounting the till. The
  ticket is still open in Jira even though the finding is settled — see
  "What Jira does not agree with" below.
- **371** — the lock policy that 360 turned into: should the sale survive a lock?
- **372** — the phone's Pay button carries no reason, and a refusal on the payment
  step draws no note.
- **370** — the refusal note's "Fix this to charge" line measures 3.86:1.
- **380** — the clone warning's triangle is a shade too light.
- **379** — the Merch panel's low-stock notice and stock badges can never show.

**Testing and the rest**
- **369** — the till's own browser checks never run in CI.
- **383** — the till has no unit-test runner.
- **339** — a family confirmed twice gets two draft visits.
- **340** — the drop-off registration lookup still reads the prototype's store.
- **345** — product and discount codes are unique per operator, so a coded item
  cannot be cloned into a second branch (a decision, not only a defect).
- **357** — the booking site's saved-children step is unreachable.
- **326** — the booth's result card runs past a 16:9 stage by 36 logical pixels.

### What Jira does not agree with

One thing the log below says that Jira does not: the 16:45 banner records **360
closed Done, not reproducible**. In Jira, **SCRUM-360 is In Progress** (last
updated 16:47). Nobody walked it, and the helper's status ladder
(`To Do → In Progress → Testing → Deployed`) has no *Done* step, so it could not
have been walked with the tooling. The finding itself is settled and 371 carries
the decision; the ticket still needs closing by hand. Everything else in the log
matches Jira as queried tonight.

### Decisions still with the owner

Taken inside the tenders plan without the owner, each already a recommendation on
the ticket: **O-3** (the counter is a `box_counter` scope, not a table), **O-4(a)**
(the drawer opens by its own command now, folded into receipt printing later),
**O-5** (yes, a sale may sit part-paid), **O-7** (the server refuses a used
tender's delete and offers disable).

Still the owner's to settle:

- **O-1 — the 2C2P sandbox.** Which portal the park holds and its sandbox
  credentials. Blocks only the real-QR half; the simulator carries the acceptance.
- **O-2 — the offline scope.** G was built inside SCRUM-206, so the question is
  now whether to accept that or split it out as its own ticket.
- **O-6 — the vendor questions** for GHL Thailand and Digio (serial parity, the
  `pos_ref_no` length, whether a card can be recalled, whether a PromptPay QR can
  be voided, and the TID/MID for the park's two PAX terminals).
- **371** — the lock policy: does the sale survive the inactivity lock?
- **254's two** — what the API description should show once signing in is required.
- **306** — whether a read-only member of staff needs its own grant.
- **327** — whether a retried pairing should mint a new code.
- **345** — may a branch carry the same product or discount code as another?
- **326** — the booth's result card on a true 16:9 stage.
- **357** — the booking site's saved-children step.
- **268** — the "HKT Central" row that exists only in the OTO App.
- **The deploy-bot** — its `render.yaml` entry creates a paid service on sync.

**The owner has said no new tickets are to be picked up. The order below is a
recommendation; the next order is the owner's to confirm.**

### Recommended next order

1. **The D↔C2 seam and 391**, then drive D's QR path on staging end to end (open
   → paid by the signed notification → receipt; decline; mismatch parked;
   suppressed webhook → the poller).
2. **388 (High)** — reserve in-flight tenders, before F touches the payment stage.
3. **382** — refuse a disabled or archived tender in the attempt service, with its
   two fold-ins.
4. **Slice F** — the POS payment stage on all four tills (cash keypad, card
   states, QR on the display, manual entry, split) — then SCRUM-206's end-to-end
   Deployed evidence.
5. Then, in order: the Console and box items **378, 381, 385, 386, 387, 389, 390**;
   the promotion items **373, 374, 375, 368**; the small light-theme and till items
   **370, 372, 379, 380**; and the testing items **369, 383**.
6. Then the owner decisions above.

### Working rules learned today

- **A commit's file list is never filtered by a word.** Slice B's list filtered on
  "payments" and missed `routes/webhooks.ts`, which `app.ts` registers; CI on
  `a232059` alone would have been red. List the files the work touched, all of
  them. (Memory `oto-commit-style`; `CONTRIBUTING.md`.)
- **A credential is searched for in every encoding.** The gate found the Digio
  void password a seventh time, hex-encoded inside a sample frame, after the plain
  form had already been redacted. (`scripts/session/README.md` → Credentials;
  memory `oto-session-working-rules`.)
- **A reviewer never stashes a shared tree.** The C2 gate ran
  `git stash push --keep-index` and `git checkout -- .` mid-review with several
  slices live in the tree, then popped them back at once; the tree was verified
  identical afterwards, but nothing about that was safe. (Memory
  `oto-session-working-rules`.)
- **A deploy writes no reference data unless the sync writes it.** Staging's
  `payment_method` table was empty after E's deploy and the till could not take
  money for nineteen minutes; only the full demo seed wrote the three tenders and
  the pre-deploy runs `platform-sync`. Anything a screen cannot work without is
  converged by the sync, never left to the seed (SCRUM-384). (Memory
  `oto-render-staging`.)
- **Compare every service's live commit before calling a ticket Deployed.** The
  launcher's Render auto-deploy trigger had been `off` for three days, so two
  tickets read Deployed with their launcher half never on staging. (Memory
  `oto-render-staging`.)

### How to resume

1. `docs/progress/STATUS.md` — the short version of where the programme is.
2. **This block**, then the chronological log below it for the detail of any one
   hour.
3. `docs/progress/plans/206-tenders/PLAN.md` — the slice plan and §4, the owner
   decisions.
4. `docs/progress/SPRINT_2_PROGRESS.md` → Status, and its SCRUM-206 section.
5. `docs/progress/TICKET_REGISTER_2026-09-23.md` — every ticket touched today,
   what proved it, and the open list in the recommended order.
6. `scripts/session/README.md` — the Jira and Render helpers, and what each one
   is allowed to print.

---

> ## Status on 2026-09-23 20:35 — `main` is `ee4d618`; staging is `24e608d` on the api and Console (POS at `83ffc36`+); CI green through `24e608d`
>
> **Since 16:02:** **341 Deployed** with staging evidence (`4698326`);
> landed **363's first pass** (`a0d8cab` — nine panels' notices, accent
> and error text on the light recipes; the whole ticket is now in);
> the booth's Render service grouped under OTO Platform → staging at the
> owner's request (`e730697`). Launched the 7faf1d0 evidence pass — 352,
> 358, 359, 363's form half (`wf_4cefb317`). The superseded deploy
> watchers were stopped; one waits for Render at `a0d8cab`.
>
> **16:22 — the staging launcher was three days stale.** Its Render
> auto-deploy trigger was `off` (the other five are `checksPass`), so it
> sat at `f0c710c` and never received `26bd73b` (SCRUM-251's sign-in copy)
> or `5fe007d` (SCRUM-192's launcher sign-on) — both tickets read Deployed
> with the launcher half not on staging. Trigger set to `checksPass`, the
> tip deployed by hand, `DEPLOYMENT_TOPOLOGY.md` corrected (`7c2a89b`), a
> launcher evidence pass launched (`wf_01b1b4bd`) to add the two screens
> to 251 and 192 with a plain addendum. Rule: compare every service's live
> commit before calling a ticket Deployed (memory `oto-render-staging`).
>
> **16:24 — Deployed with staging evidence:** 350, 355, 349, 354, 351
> (the beacb6d batch's POS half, `e7b913f`).
>
> **16:26 — Deployed with staging evidence:** 347, 348, 356, 343, 344,
> 337, 338 (the batch's api half, `ee2d7a6`). 347's card shows the
> setup-code row's shape only (argon2id, 97 chars) beside seven expired
> 64-hex rows and a measured recovery cost per shape; 348's timing proof
> stays the committed test — staging's network noise is twenty times the
> effect. Left on staging by the pass: an invited throwaway account
> (+66 80 000 0347), one archived child on the evidence family, two small
> station sales (T1-000008 fnb, T1-000009 shop). The 344 pass found that a
> **free-item code takes nothing off on the F&B and shop lanes** — only the
> ticket till adds the free item as a line for the markdown to land on —
> raised as **368** (depends on 362's code box; linked to both).
>
> **16:30 — the launcher's missing halves are on staging.** Its deploy of
> `326fd4c` went live at 16:18; the addenda are on **251** (a real account
> and an unknown number with a wrong password get the identical refusal;
> the first-shift line points at set-up) and **192** (launcher sign-in →
> Open OTO App → the app names Anan with no second password and nothing
> left in the URL), each saying plainly why the launcher half was late
> (`9a72d81`). Both tickets were already Deployed; neither was walked. The
> scratchpad `commentWithImages` helper cannot inline images on this Jira
> (the ADF media node wants a media-services id the REST attachment API
> does not expose) — comments name their attached files instead.
>
> **16:31 — landed 365's harness** (`7f3b00d`, gate MERGE — Testing): the
> Console's Playwright set on a throwaway database it makes and drops
> itself, four cases (358's Test print drive, a booth's spins figure, both
> branches, a wrong password), config refuses to run without the harness
> so it can never reach a working box. Its CI half is a second round
> (`wf_a49a824d`): Chromium on the Linux runners, Edge locally — decided,
> not reopened. The POS's own set is not in CI either — raised as a Task
> (see below). 365 stays in Testing until the first green run on GitHub.
>
> **16:36 — landed 367 and the tenders Slice A.** **367** (`cb977c7`, gate
> MERGE after its one comment defect was corrected by hand — proxy-addr
> compiles the list at construction, so the env check's worth is the
> diagnosis, not the refusal; the rate-limit plugin's stale comment fixed
> in the same commit): `TRUST_PROXY_ADDRS` set on the staging api from
> render.yaml's value (23 entries — first PUT carried the yaml's quote,
> re-set clean); Testing until 353's four series re-run on the live
> deploy. **Slice A** (`3317360`, fix-round gate MERGE — full api suite
> 1,156 green, two-database dumps identical, five plants; `wip/206-A`
> dropped): 0019 lands `payment_attempt` widened, `payment_method`,
> `payment_notification`, the shared vocabulary, four command-kind copies
> in step, `finaliseSale` resolving the method token and refusing an
> unresolvable one; 206 commented with the three cards. Fourteen facts
> for later slices are in the fix-round report (`wf_042f927c` journal) —
> `CASH_ROUTES = ['cash_drawer','none']`, `method_code`, the notification
> key CHECK Slice D must pre-empt, `tenderMethodOf` moving to
> `services/payments/attempt.ts` in B, E must not create an `other`
> tender without a ledger word. **7faf1d0 evidence:** 352, 359, 358
> Deployed; 363's form half commented (`ec21582`, which also swept in the
> three tickets' build-time cards that had never been committed). Raised:
> **369** (the POS's own Playwright set is not in CI), **370** (the refusal
> note's "Fix this to charge" line measures 3.86:1 — land after 360/366).
>
> **16:42 — wave 2 launched.** Tenders **B** (cash, the attempt service,
> part-paid sales, attempts on the sale read — `wf_d5e69115`; kept out of
> `services/print.ts` because 364 is in it: the drawer kick writes the
> print-job row from `services/payments/drawer.ts` if no export fits),
> **C1** (the GHL and Digio terminal adapters, simulators, fixtures, the
> `box_counter` ref scope — `wf_0685188f`; its gate greps for the vendor
> documents' literals), **E** (payment methods admin wired, O-7 refuse a
> used tender's delete — `wf_8090465a`); **364** (Console test print
> records a print job — `wf_ac4191fc`); evidence — **367**'s four-series
> re-measurement once the api runs with the variable (`wf_65113495`,
> Deployed only if the caller keys every bucket), **363** whole and **361**
> (a paired evidence box replaying a bad visit, or a local card and no
> walk — `wf_00be1ca9`). Decisions taken from the plan's §4 without the
> owner: O-3, O-4 (a), O-5 yes, O-7 refuse+disable — all recommendations
> already on the ticket; O-1, O-2, O-6 stay with the owner.
>
> **16:45 — landed 366 and 365's CI half.** **366** (`3368e82`, gate
> MERGE, Testing): the phone reads its quote error by kind — a refusal
> draws the note and keeps Pay off on Review and the cart sheet alike,
> a fault leaves Pay live; two plants each way. **360 closed Done, not
> reproducible**: the hand-over overlay sat 45 s with the network captured
> and nothing moved; what loses the sale is the 120 s inactivity lock
> unmounting the phone till — a policy decision, raised as a Task with a
> recommendation (keep the sale across a lock). Raised too: a Low Task
> for the phone's button carrying no title and a refusal landing on the
> payment step drawing no note (lands with Slice F). **365's CI job**
> (`186316e`): Chromium on the runners, Edge locally, report on failure;
> the FIRST Linux run is the proof — an agent watches it (`wf_51fc683a`)
> and walks 365 to Deployed only on green; a red run holds deploys at
> `3368e82` until fixed.
>
> **16:54 — landed 362** (`f212a5d`, gate MERGE, Testing): the F&B and
> shop stations take a promo code in the till's design, price it locally
> the way the platform does (item lines mapped into the engine's terms
> with kind and category walk; local = platform proved on the wire on
> every quote), and send it with the sale; a free-item code is refused at
> the entry with the reason. Raised from it: **373** (the station's
> receipt and the till's own reports don't see the code — the ledger
> does), **374** (a code's usage limit is enforced nowhere on the
> platform; the stations count nothing), **375** (fold the twin quote
> hook into `cartQuote.ts`); 368 updated (a free-item line has no
> platform id until SCRUM-203's id question is settled). The lock
> decision from 360 is **371**; the Pay-button reason is **372**.
>
> **16:54 — 367 measured on the live deploy: 3 of 4, NOT walked.** Direct
> to the api host the caller keys the buckets, the forgery is ignored,
> nothing keys on an edge — but through the POS site's `/api/*` rewrite,
> the path EVERY till uses, the platform sees Render's egress
> (`74.220.48.5`, oregon-egress, a /20 shared with other tenants) as the
> caller: every till shares one throttle bucket. Trusting that range is
> not the fix (any tenant could forge past the throttle). Raised **376**
> (High, blocks 367); an investigation run (`wf_78e9c6ef`) measures what
> the rewrite carries and proposes the shape — no code until it returns.
> The measured card is on 367 (`staging-367-measured.png`).
>
> **16:58 — 365 Deployed.** The first GitHub run with the Console job
> (CI #128 on `186316e`) is green: 10m 59s in all, the Chromium install
> 23 s, the Console end-to-end 27 s — four cases passed on a throwaway
> database the job made and dropped; the report step skipped as designed.
> Card on the ticket (`ci-365-first-linux-run.png`). Two GitHub-side
> deprecation notices on the run (Node 20 actions; the `ubuntu-latest`
> label moving to 26 on 19 Oct) — not ours, worth a line when they bite.
>
> **17:02 — 366 Deployed** with staging evidence at `186316e` (POS and
> api both live by 16:59): a real refusal on the phone — the package's
> tourist weekday price moved ฿5 under an open cart, the cart grown →
> `SALE_LINE_PRICE_MISMATCH` → the note and Pay off on Review and on the
> sheet; price restored (verified by API and database), Pay back. The
> fault path is not forceable on staging; the comment points at the
> build's card. Left on staging: the two price-move audit rows only.
>
> **17:06 — 361 and 363 Deployed** (`979626f`). **361** by the real
> route: a box "Evidence box 361" paired on staging through the Console,
> the agent run locally against the staging api, a `visit.created`
> naming another member's child → quarantined `SYNC_VISIT_CHILD_NOT_SAVED`,
> nothing written; the same visit with her own child applied. Left on
> staging: that box row (offline, no stations), one open quarantine row,
> one counter-proof draft visit. **363**: seven panels measured from the
> painted pixels (4.47–4.96:1). Found on the way: **377** (High — the
> Console's add-a-box dialog is painted over by the panel behind it; an
> administrator cannot add a box by mouse — building, `wf_03dc00ee`),
> **378** (no control to retire a box), **379** (the Merch panel's stock
> notice and badges can never show — dead reads), **380** (the clone
> warning's triangle one shade light). 362's staging pass queued behind
> Render (`wf_cd6372b0`).
>
> **17:11 — landed 364** (`bce63ad`, Testing; gate DO NOT MERGE on one
> false cross-reference in a comment — the till's test print does carry
> a key per press — corrected by hand with the drawer's opening line,
> then committed): the Console's Test print presses the station
> print-jobs route, so the `print_job` row exists before the box prints,
> the outcome is accepted and the Printing panel lists it; the bare
> command route is still the trap — the till's Station Setup test print
> uses it → **381**. Staging pass queued behind Render (`wf_362f0ec3`).
>
> **17:12 — 362 Deployed** with staging evidence at `f212a5d`: a
> temporary food-scoped code (STAGING10) created through the back office
> as Anan, applied on the F&B station (−฿21 on ฿210, the platform's gross
> equal to the station's on the wire), an unknown code and ICECREAM
> refused with their reasons, the food code refused on the shop and the
> seeded STAFF10 applied there; the code archived afterwards. Left on
> staging: the archived definition and its two audit rows; no sale.
>
> **17:20 — 376 investigated; shape decided.** Measured
> (`docs/qa/TRUST_PROXY_REWRITE_MEASUREMENT_2026-09-23.md`): through a
> static site's rewrite the api sees the region's SHARED proxy fleet
> (`74.220.48.0/24`, `74.220.56.0/24` — Render's API says
> `"type":"shared"`; the POS and the launcher landed on one address and
> one bucket within a minute); the till's forwarded address does not
> survive the hop in any form a trust list could use; Render's own
> request log resolves the caller the same way. Consequence today: five
> mistyped passwords anywhere lock every till, the Console and the
> launcher for five minutes. **Decision: shape (D)** — throttles key on
> the credential a request carries (station/account for signed-in
> traffic; the box and booth credential throttles on the identity the
> request names), the address kept only for sign-in, `/public/*` and
> booth pairing, and the sign-in throttle's address half raised to a
> ceiling sized for a shared address (the phone half is the security).
> (A) refused — useless or dangerous depending on an unmeasurable fact;
> (C) direct calls to the api host is the complete answer only on a real
> parent domain. Build launched (`wf_ae659bf6`; new env
> `AUTH_MAX_FAILURES_PER_ADDRESS`, default 50, to set on the Render api
> service when it lands — or leave the default).
>
> **17:22 — landed 377** (`4e67aab`, gate MERGE, Testing): the Devices
> page's dialog renders through a portal to the body — the blurred panel
> it lived in was the containing block and stacking context for a fixed
> child, so it was sized to the panel and painted under the Stations
> section; Pair a screen shared it and is fixed by the same change; a
> Console e2e case hit-tests both buttons and adds a box. Staging pass
> queued (`wf_b77cdffb` — Cancel only, since a box cannot be retired on
> staging yet, 378). Note from the gate: the root typecheck was red at
> 17:20 on C1's untracked `terminal-channel.test.ts` — C1's own gate
> will see it; not 377's.
>
> **17:27 — landed tenders Slice E** (`8ee9a5d`, gate MERGE): five thin
> routes under `/payment-methods` (operator-wide; list with the in-use
> count, create, update, move, archive), the prototype's rules in
> `services/payment-methods.ts`, the back-office panel saving for real
> (its not-saved notice gone, the two mock mutators wired plus `move`),
> tenders hydrated on every catalogue load; 20 tests, three plants. Two
> files E owns that the plan's list did not name: `apps/pos/src/api/
> platform.ts`, `catalogBridge.ts`. **Carried forward:** the ledger still
> records a sale against a disabled or archived tender — `tenderMethodOf`
> falls back to the declared kind; the grid is the only enforcement —
> pinned by two tests, raised as **382** to land right after B (attempt.ts
> is B's); **383** the till has no unit-test runner. O-7 is in (refuse a
> used tender's delete, offer disable).
>
> **17:31 — 364 Deployed** with staging evidence at `bce63ad`: one Test
> print from the drawer → `POST /stations/:id/test-print` → the Printing
> panel reads `printed · test page · Receipt Printer 1`, the `print_job`
> row raised 11 ms before its command and the box's result naming it;
> before the press, 0 test-page jobs across 16 test_print commands on
> staging (358's press had none). Left on staging: that command and its
> job row. E's staging pass queued (`wf_ef2bc5c4`).
>
> **17:38 — C1's gate: DO NOT MERGE, fix round launched**
> (`wf_0d8bd0bd`; the pre-fix tree is on `wip/206-C1` = `89534f5`, 41
> files, +6,927). The protocol work held against the vendor documents
> (the CRC generator, the two code spaces, the tag tables, the counter);
> two blockers: the amount-mismatch rule lives in the shared answer
> readers and so reads a successful void or an amount-less GHL inquiry as
> `partial_approval` — under the handover's own mapping that would
> decline-and-void a sale the guest paid for; and the contract comment
> "no path from a wire frame to a log" is false — the simulators' tape
> records raw frames (masked PAN and cardholder on a Digio A1) through
> `TerminalController.events`. Also: `packages/box-agent/src/index.ts`
> gained a barrel export (six lines, outside the plan's list — needed so
> C2 can import the contract); the report's "one 6+ digit literal" was
> nine, all benign.
>
> **17:39 — 377 Deployed** with staging evidence at `4e67aab`: both
> dialogs on `body` at the full viewport, a press at each button's centre
> lands on the button, Cancel closes creating nothing; nothing left on
> staging.
>
> **17:44 — B's gate: DO NOT MERGE, fix round launched** (`wf_140102f5`; the pre-fix
> tree on `wip/206-B`). One blocker the suite could not see: the drawer
> kick's `queueCommand` runs its own `withTx` under the request's
> idempotency claim AFTER the finalise wrote its answer, so a cash
> finalise sent with the till's Idempotency-Key stores the command's
> `{commandId, actionId}` under the key and the dropped-connection retry
> replays that — no sale, no receipt. No test sent the header. Everything
> else green (171 tests, the full api suite 1190/1191 with the one red
> E's transient probe), both plants reproduced plus the gate's own
> (`paid_at` guarded). B's deviations, accepted: the drawer kick is a
> `drawer_kick` BOX COMMAND with `finish.drawerKick`, not a print job
> (`PrintKind` is a closed union in three copies); the box side —
> `case 'drawer_kick'` in `executeCommand` — is still missing and goes to
> G (agent.ts's sale-facing part); until then the box answers
> `UNKNOWN_COMMAND` and the drawer opens by hand. Part payment (O-5) is
> live: a short tender answers 200 `finalised:false`, `SALE_NOT_PAID` is
> gone; the replay net on `action_id` is armed; `tenderMethodOf` moved to
> `attempt.ts` (382's fix lands there).
>
> **17:57 — E's staging pass found the deploy had left the till unable
> to take money.** `pos.payment_method` was EMPTY on staging: only the
> full demo seed writes the three tenders, the pre-deploy runs
> `platform-sync` (roles and permissions only), and E's hydration
> replaces the built-in three with the platform's list — so from 17:41
> Som's till had ฿1,040 owing and an empty method grid. The pass typed
> Cash/Card/PromptPay back in through the panel (17:46) and then proved
> everything (untick → grid loses it, delete cash refused 409 with 12
> attempts, order survives a reload, a tender added and archived;
> `53c84fc`). Raised **384** (High); a build makes `platformSync`
> converge the three defaults for a park with none (`wf_581116c6`).
> Rule recorded in memory: anything a screen cannot work without is
> converged by the sync, never left to the demo seed.
>
> **18:01 — landed 376** (`9b86938`, gate DO NOT MERGE on one comment
> paragraph — corrected by hand: the box's named bucket is the CLAIMED
> id with an address bucket beside it, and the booth screen has no
> throttle of its own; then committed): the rate-limit key is the
> session's station, else account; `AUTH_MAX_FAILURES_PER_ADDRESS` (50,
> set on the Render api service too); box refusals counted under the
> named id + address; 183 tests, three plants. Raised: a booth screen's
> wrong credential is never throttled on its own; the throttle table is
> never swept and an invented box id opens a row (**385**, **386**).
> Measurement pass launched (`wf_f1d12c3d`).
>
> **18:10 — landed tenders Slice B** (`a232059`, fix-round gate MERGE:
> the full api suite 1,203 green, the header-path retry proven both ways;
> `wip/206-B` dropped). The cash tender writes the attempt ledger through
> `services/payments/attempt.ts`; part-paid sales live (O-5); the replay
> net on `action_id` armed; the drawer kick a `drawer_kick` box command
> under a context WITHOUT the request's idempotency claim; the Sale
> detail lists payments. **Slip, fixed at once:** the commit's file list
> filtered on "payments" and missed `routes/webhooks.ts`, which app.ts
> registers — committed from the wip snapshot's blob one minute later
> (`b616191`); CI on `a232059` alone would have been red.
> Raised: the idempotency-claim class in `tx.ts` (print.ts still carries
> it, dormant — **387**); 382 gets two small fold-ins.
> **Slice D launched** (`wf_987e09f1` — 2C2P QR on B's service; the
> simulator carries the acceptance; refinement: a missing merchant id
> selects the simulator on local/staging only and refuses the boot on
> production). C2 waits for C1's fix round.
>
> **18:19 — landed tenders Slice C1** (`51fd025`, 42 files; the fix
> round's gate refused once more on one surviving sentence in
> `contract.ts` — the payload doc still said an inquiry's answer is
> compared against its amount — corrected by hand, then committed;
> `wip/206-C1` dropped). The PaymentTerminal contract, GHL and Digio
> adapters, two simulators answering on the same bytes, 22 cited
> fixtures, the `terminal_ref` counter scope, 251 box-agent tests. Facts
> for C2/G: only a sale is judged against the amount asked; a void's
> amount is the amount taken; an inquiry needs no amount; the tape is
> codes/amounts/references only; `drawer_kick` is NOT handled by the box
> yet (G). **C2 launched** (`wf_5922a49a` — the card tender in the cloud on
> B's service and C1's contract).
>
> **18:19 — 376 Deployed** with the staging measurement at `9b86938`:
> two tills signed in from one machine, seated at Reception Till 1 and
> Counter 2, spent two separate allowances (119→115 each, keyed on the
> stations, no address row moved); five wrong passwords on five phones
> from one address — spread by the host over THREE egress addresses —
> locked nobody and a sixth signed in; five on one phone locked that
> phone for 300 s (Som, deliberate, self-clearing); the four
> unauthenticated series unchanged from 367's pass. The rewrite path is
> still the egress for what has not signed in — by definition, with its
> ceiling at 50. 367 walked to Deployed on the same evidence.
>
> **18:28 — landed 384** (`c61289d`, gate MERGE — the gate's own live
> probe: archived all three then synced → nothing resurrected, the guard
> is "zero rows including archived"; the full api suite 1,203 green
> beside it): `platformSync` writes cash/card/promptpay for a park with
> none through `seed/tenders.ts`, the seed sharing the one list; seven
> tests. Staging keeps the three E's pass typed in; its staging pass
> reads the rows unchanged across the deploy and shows the fresh case on
> a throwaway database (`wf_dcbd81d4`). Known and pinned: the demo seed's
> second park gets its tenders on the following sync.
>
> **18:31 — G launched** (`wf_fdfec96a`): the offline sales replay, `box_seq`, the two sync handlers, the PAX-QR flag and the box side of the drawer kick — C1 is landed and nothing else is in `agent.ts`, so the plan's "never beside C1" holds; O-2 stays open with the owner (kept in the ticket, built on the evidence of the earlier slices).
>
> **18:47 — 384 Deployed** on the staging deploy of `c61289d`: the park's
> three rows byte-identical across the deploy (ids and both stamps), the
> archived evidence tender still archived, a fresh throwaway database
> given its three once and silent on the rerun. The deploy log DID carry
> "wrote the 3 default tenders for 4 park(s)": staging holds four other
> operators (three archived test ones and the second demo park) with no
> tenders, and the rule converges them too — by design (archived parks
> included). My pass mark had assumed one park; the agent rightly did
> not walk, and I did with that said. Left on staging by the deploy: 12
> rows on those four operators.
>
> **18:45 — B proven on staging at `b616191`:** a till cash sale
> (T1-000010) → one approved attempt with every stamp and a `drawer_kick`
> command the virtual box answers `UNKNOWN_COMMAND` (expected until G);
> a part payment by API on a ฿1,930 sale → ฿500 recorded, sale open,
> the same press replayed to the same attempt, ฿1,530 against ฿1,430
> owing refused 400, ฿1,430 closed it as T1-000013; the Sale detail
> lists both payments. Left on staging: T1-000010..13 and six attempts.
> Two observations, folded into 387: the replayed answer carries the
> internal `drawerKick` object the live answer strips; and EVERY cash
> tender kicks the drawer, part payments included — deliberate (cash
> goes in the drawer each time), stated so it is a decision when the
> box handler lands.
>
> **19:29 — landed tenders Slice C2** (`83ffc36`, gate MERGE — 22+5
> tests end to end through the real command queue and result route, the
> Console e2e driving the simulator panel, four plants incl. the gate's
> own two): the card tender in the cloud — `services/payments/terminal.ts`,
> the `/payments` routes (attempts, poll, inquire, confirm, manual, the
> box's result route under a box credential), the Console's terminal
> simulator panel; nothing in it closes a sale (an approved tender covers
> the balance; finalise allocates the receipt — F wires that). Raised from
> its gate: **388** (High) a second Card press while the first
> is at the terminal opens a second full tender (before F); **390** a late
> progress report can overwrite a settled attempt's references; **389**
> the box's result route has no per-address ceiling. **Gate incident, recovered:**
> the C2 gate ran `git stash push --keep-index` + `git checkout -- .`
> mid-review — every live slice's tracked edits stashed — and popped
> them back at once; the tree was verified identical (24 files, same
> diffstat, untracked never touched). A lint error in the committed
> `scripts/session/jira-lib.mjs` (`no-empty`) would have held CI —
> fixed (`97d738c`). `route-write-conformance.test.ts` carries D's and
> an unclaimed refactor's hunks (readSourceFiles walking subdirectories;
> `test/route-source.ts` +45 — D-flavoured); C2's two entries were
> hunk-picked. Staging pass queued (`wf_61eb87e3`).
>
> **19:36 — D's gate: DO NOT MERGE, fix round launched** (`wf_b6ffb273`;
> the pre-fix tree on `wip/206-D` = `558776c`, 35 files, render.yaml's
> api hunk only). The slice held on substance — the nine webhook steps
> read hunk by hunk against PAYMENT_GATEWAY.md, 67 package + 30 api
> tests, both plants reproduced, the gate's own three (dedupe, signature,
> production refusal) red as required, zero secrets, no third-party
> dependency (node:crypto for HS256/RSA-OAEP/A256GCM/PS256). One blocker:
> `resolveGatewayProvider` dereferences `PGW_MERCHANT_ID.trim()` unguarded
> and `assertProductionSafe` now calls it, so `boot-guard.test.ts` (a
> partial Env) throws on all 13 assertions — the production boot guard's
> test masked. Six small findings folded into the round (the poller
> comment's arithmetic, a >200-char token answering 400, the currency
> check skipped when absent, an unused export, the poller's order
> starving the oldest past 200, the stamp's timezone). D's facts for F
> are in its build report (openQrAttempt → qrPayload rendered locally;
> poll the attempt at ~3 s; created → sent_to_terminal → approved /
> cancelled / awaiting_staff_confirmation; no push).
>
> **19:45 — G's gate: DO NOT MERGE, fix round launched** (`wf_1bc3a29f`; the pre-fix
> tree on `wip/206-G`). The slice: `services/payments/offline.ts` (the
> replay through B's commit/finalise and attempt service), two sync
> handlers `sale.finalised` / `payment.recorded` beside the six, the
> box's `agent.sales()` queue with provisional receipts from the cached
> high-water mark, and the drawer pulse (`pulseDrawer` through
> `printing/**` — additive, nobody else was in it; ESC/POS `ESC p` with
> no paper blocker, TSPL unsupported) with `case 'drawer_kick'`; 17 + 7
> tests, box-agent 258 green, the full api suite green but D's
> boot-guard. Two blockers: the offline price guard is OPT-IN —
> `expectedTotalSatang` optional on the wire and nothing caps what a box
> may bank (a stale-catalogue box could finalise a sale with more money
> than its gross, no quarantine); and the `drawer_kick` case is reached
> by no test while a test title claims it. Plan facts corrected: the
> replay net never doubles money (A's unique refuses the second insert);
> what the read-back buys is the ANSWER, else the delivery parks as
> `Error`. Non-blocking: a ฿0 offline cart quarantines forever on
> `sale_freeze`; a fully comped offline sale cannot be expressed (F).
>
> **19:55 — C2 proven on staging at `83ffc36`:** through the Console's
> terminal panel and the payments routes as Som — approved in 4.4 s
> (approval code, last4, TID/MID learned and written onto the device
> row, a 12-char GHL reference) then finalise with no body → T1-000014;
> declined with the vendor's words, nothing spent; a ฿689 partial
> approval refused and voided on a FRESH reference within the second;
> the PAX (routed qr_terminal on every seeded station, so driven as a QR
> tender): silent for the 120 s budget → unknown → the platform's own
> inquiry → silent → awaiting staff → asked by hand → not_found. No
> masked PAN or name anywhere in attempts, commands, runs or audit. One
> wrinkle for a demo: the first panel press seconds after the api went
> live answered 409 (the in-process box not yet up); fine 40 s later.
> Left on staging: T1-000014 paid by card; three ฿690 sales open with
> nothing taken; EDC 1's next outcome left at Decline, EDC 3's at
> Approve (in-process; reset on restart — set before a demo).
>
> **20:12 — landed tenders Slice D** (`24e608d`, 37 files; fix-round gate
> MERGE — boot-guard 20/20, the full api suite 1,282 green, six findings
> folded: the poller comment, an over-long path token now 200 + a run,
> an absent currency is a mismatch, `isAboutTheMerchant` called at the
> top of the non-paid path, the poller oldest-first, the stamp kept
> unparsed; one false citation `:527` → `:349` corrected by hand in four
> places; `wip/206-D` dropped). `packages/payments-2c2p` (node:crypto
> only), `services/payments/gateway.ts`, the webhook, two jobs, 19
> `PGW_*`/`PAYMENT_PENDING_MIN` variables (names in `.env.example` and
> render.yaml's api block; the three non-secret ones set on the Render api
> service: provider simulator, prefix SBX, inquiry 10 s), the Console's
> gateway simulator panel. Open for the sandbox session: the gateway
> stamp's zone (paid_at is our receipt clock until 2C2P settles it);
> O-1 the credentials. Staging pass queued (`wf_52e1356a`).
>
> **20:35 — D on staging at `24e608d`: the announcement holds, the QR
> flow is not yet reachable.** Integrations shows the simulator (chosen
> by `PGW_PROVIDER=simulator`, so `fellBack` is false), names and
> presence only. But `openQrAttempt` has NO caller outside its test, and
> `payment_routing.qr` has no reader: a `qr` tender on `/payments/
> attempts` goes to the station's EDC 3 whatever the routing says (driven
> both ways, T1-000015/16 closed by the terminal simulator; 0 rows in
> `payment_notification` on all of staging; the pending job ticking).
> This is the D↔C2 seam the plan gave to F ("C2's route calling D's
> service") — nobody wired it. **First item of F, or a small seam round:**
> route a `qr` tender to the gateway when the station's `qr` routing is
> `gateway`, then drive the QR path on staging (open → paid by the signed
> notification → receipt; decline; mismatch parked; suppressed webhook →
> the poller). The pass raised **391** (a station routed `gateway` for QR
> still sends the tender to its card terminal — the saved setting does
> nothing). 206 must not be Deployed on tonight's evidence.
>
> **Running:** G fix round (`wf_1bc3a29f`).
> checkpoint part 1 landed: the tenders plan and its five reader findings in `docs/progress/plans/206-tenders/` (the void password redacted in its plain AND hex forms — the gate found the seventh, hex-encoded in a sample frame), the session helpers in `scripts/session/` with a README (the two mutating Render scripts now need `--apply`). After wave 3: F and G (G after C1 — now free — and
> never beside a slice in `agent.ts`).
> C2 and D (D needs O-1 only for the real-QR half; the simulator carries
> the acceptance), then F and G (G after C1, never beside it).

> ## Status on 2026-09-23 16:02 — `main` was `0e5e2c6`; staging was `ce8a9d9`; CI green through `ce8a9d9`
>
> **Since 15:51:** landed **358** (`4f4188a` — the Console's Test print
> names the printer), **363's menu item form** (`88749d7`), **352**
> (`c3c0aa9` — the shop's Charge gate; the phone's F&B never quotes, so
> nothing to gate there), **359** (`7faf1d0` — the refusal, source and
> failure notes legible on the light theme). **353 Deployed** with its
> post-deploy measurement (`0e5e2c6`): the forgery is ignored and the
> POS rewrite adds no hop, but the buckets key on **Cloudflare's edge
> addresses** — one trusted hop reaches the edge, the caller sits one
> entry further left → **367** (trust the balancer and the edge by
> address — building; the Render variable is set by the parent when it
> lands). Raised: 364 (a Console test print writes no print-job row —
> after A frees the Console's fleet client), 365 (Console harness —
> building), 366 (the phone till hides a refusal — building with 360).
>
> **Running:** builds — 363 first pass (`wf_0834f8e9`), 365
> (`wf_243eed56`), 360+366 (`wf_24c97017`), 362 (`wf_a0a8fac3`), 367
> (`wf_f27b330d`); the tenders Slice A fix round (`wf_042f927c`);
> evidence — the beacb6d batch (`wf_300def37`), 341 (`wf_bc39bddd`).
> Watchers wait for Render at `4f4188a` and `7faf1d0` (the superseded
> watchers on earlier shas were stopped). **341 Deployed** with staging
> evidence (`4698326`, 16:02).
>
> **Owner request (16:08):** `oto-booth-staging` sat in Render's "Ungrouped
> Services" because it was created through the API without naming the
> project's environment. Moved into **OTO Platform → staging**
> (`POST /v1/environments/evm-danh1brtqb8s73bt5pk0/resources`); from now
> on every service created through the API is added to that environment
> in the same step (recorded in memory `oto-render-staging`).

> ## Status on 2026-09-23 15:51 — `main` was `bc05e47`; staging was `2731962`; CI green through `2731962`
>
> **Since 15:47:** staging reached `2731962` (341 included) — the 341
> evidence pass launched (`wf_bc39bddd`); the beacb6d batch is capturing.

> ## Status on 2026-09-23 15:47 — `main` is `ce8a9d9`; staging was `097b73b`; CI green through `2731962`
>
> **Since 15:40:** landed **361** (`ce8a9d9` — a box's replayed visit is
> refused whole when a child is not the member's own or is archived).
> **Slice A of the tenders (206) was held at its gate**: the schema is
> verified (migration from empty twice, the backfill proved on a 0018
> database, demo-day seeded twice), but the one writer of
> `payment_attempt` — the `settleSale` insert in `sale.ts` — still
> supplies the old column set, so every cash finalise would fail the
> moment the schema landed; and the gate caught a **vendor void password
> typed into a test fixture** — replaced with a placeholder before
> anything was committed. A's state is on ref `wip/206-A`; the fix round
> (`wf_042f927c`) owns the insert region of `sale.ts` and closes the
> small findings (a notification dedupe CHECK, a restrict FK, a stale
> sweep entry, the four undeclared plan deviations).
>
> **Running:** builds — 352 (`wf_efab2ab6`), 358 (`wf_69884d8d`), 359
> (`wf_4aea465b`), 363 (`wf_0834f8e9`), 363b (`wf_b2d75153`); the A fix
> round; evidence — the beacb6d batch (`wf_300def37`). Watchers wait for
> Render at `6faf3fb` … `ce8a9d9`.

> ## Status on 2026-09-23 15:40 — `main` is `2845135`; staging is `097b73b` (Render is deploying `803428b` → `2845135`); CI green through `4155ab9`
>
> **Since 15:40:** the 353 fix round's gate came back MERGE and landed
> (`2845135` — the hop count reaches Fastify as a function; the value
> stays 1, fail-closed; render.yaml's two comment hunks picked out from
> the other session's deploy-bot block; ref `wip/353` dropped). **The
> deploy of `2845135` is the first on which `TRUST_PROXY` takes effect** —
> after it, the measurement written beside the setting decides whether the
> Cloudflare and Render hops must be trusted by address.
>
> **Running:** gates — 361 (`wf_6be21778`), 206-A (`wf_9a136b60`); builds
> — 352 (`wf_efab2ab6`), 358 (`wf_69884d8d`), 359 (`wf_4aea465b`), 363
> (`wf_0834f8e9`), 363b (`wf_b2d75153`); evidence — the beacb6d batch
> (`wf_300def37`). Watchers wait for Render at `803428b` … `2845135`.

> ## Status on 2026-09-23 15:40 — `main` is `2731962`; staging is `097b73b` (Render is deploying `803428b` → `2731962`); CI green through `6faf3fb`
>
> **Since 15:34:** landed **341** (`2731962` — the F&B item and category
> forms save to the platform and re-read; the dead stockItemId dropped;
> F&B Menu and F&B Categories leave `localOnly` for `catalog:menu:manage`
> — the two adminSections lines added by the parent). Launched the
> MenuItemForm sweep 363 had to leave for 341 (`wf_b2d75153`).
>
> **Running:** builds — 206-A (`wf_9a136b60`), 353 fix (`wf_4493be0c`),
> 359 (`wf_4aea465b`), 358 (`wf_69884d8d`), 352 (`wf_efab2ab6`), 361
> (`wf_6be21778`), 363 (`wf_0834f8e9`), 363b (`wf_b2d75153`); evidence —
> the beacb6d batch (`wf_300def37`). Watchers wait for Render at `803428b`
> … `2731962`.

> ## Status on 2026-09-23 15:34 — `main` is `5d32f16`; staging is `097b73b` (Render is deploying `803428b` → `beacb6d`; CI has seven pushes queued); CI green through `237ca54`
>
> **Since 15:32:** **Deployed with staging evidence:** 329, 342, 346, and
> the 204 fixes evidenced on the ticket (`5d32f16`). Launched the next
> evidence batch, waiting for Render at `beacb6d`: 347, 348, 356, 343,
> 344, 337, 338 (api side) and 350, 355, 349, 354, 351 (POS side)
> (`wf_300def37`).
>
> **Running:** builds — 206-A (`wf_9a136b60`), 341 (`wf_d527428e`), 353
> fix (`wf_4493be0c`), 359 (`wf_4aea465b`), 358 (`wf_69884d8d`), 352
> (`wf_efab2ab6`), 361 (`wf_6be21778`), 363 (`wf_0834f8e9`); evidence —
> the beacb6d batch. Watchers wait for Render at `803428b`, `237ca54`,
> `6faf3fb`, `beacb6d`.

> ## Status on 2026-09-23 15:32 — `main` is `beacb6d`; staging is `097b73b` (Render is deploying `803428b` → `beacb6d`; CI has seven pushes queued); CI green through `237ca54`
>
> **Since 15:28:** landed **343/344** (`6e5926d` — a sale records its lane,
> checked against the station; promotion scopes reach F&B and shop
> lines), **348** (`4155ab9` — the unlock refusal equalised), **354**
> (`beacb6d` — seventeen back-office panels on the light recipes; the
> CategoriesPanel hunk picked out from 341's in-flight edits). Raised: 362
> (no promo code entry on the F&B/shop stations — after 352), 363 (second
> sweep pass — building, MenuItemForm excluded until 341 lands).
>
> **Running:** builds — 206-A (`wf_9a136b60`), 341 (`wf_d527428e`), 353
> fix (`wf_4493be0c`), 359 (`wf_4aea465b`), 358 (`wf_69884d8d`), 352
> (`wf_efab2ab6`), 361 (`wf_6be21778`), 363 (`wf_0834f8e9`); evidence —
> the second half of the 097b73b batch (`wf_ea63e5b1`). Watchers wait for
> Render at `803428b`, `237ca54`, `6faf3fb`, `beacb6d`.
>
> **Note for Slice A's gate:** its uncommitted `payment_attempt` widening
> (NOT NULL operator/branch/station/device/business_date, `$type<PaymentMethod>`)
> reds eleven finalise-path tests and one tsc error in `sale.ts` while in
> the tree — A must carry the `settleSale` insert with it or the landing
> is red; 343/344's gate proved the reds are A's by reverting its slice.

> ## Status on 2026-09-23 15:28 — `main` is `6faf3fb`; staging is `097b73b` (Render is deploying `803428b` → `6faf3fb`); CI green through `803428b`
>
> _(Times in this banner and in Jira comments are now taken from `date`
> and `git log`; the two banners below ran a few minutes ahead.)_
>
> **Since the previous banner:** landed **349** (`9e7d7f9` — the phone
> sheet and bar show the platform's quote), **356** (`2da33da` — a visit
> refuses an archived child), **355** (`2ce3543` — the visitor's screen
> titles a drop-off line "choose a play length"), and 349's stale comment
> in OrderSummary (`6faf3fb`). Raised: 360 (the phone's hand-to-customer
> overlay may reset the sale — to reproduce, after 352), 361 (the box's
> replayed visit writes visit_child rows with no child check — building).
> Launched 352 (shop and mobile Charge gate) now that 351 and 349 are in.
>
> **Running:** gates — 343/344 (`wf_bc7823ac`), 354 (`wf_5f8a746b`);
> builds — 206-A (`wf_9a136b60`), 341 (`wf_d527428e`), 348 (`wf_f270a2cf`),
> 353 fix (`wf_4493be0c`), 359 (`wf_4aea465b`), 358 (`wf_69884d8d`), 352
> (`wf_efab2ab6`), 361 (`wf_6be21778`); evidence — the second half of the
> 097b73b batch (`wf_ea63e5b1`). Watchers wait for Render at `803428b`,
> `237ca54`, `6faf3fb`; CI has five pushes queued behind each other.

> ## Status on 2026-09-23 15:24 — `main` is `237ca54`; staging is `097b73b` (Render is deploying `803428b` → `237ca54`); CI green through `4ceb798`
>
> **Since 15:20:** landed **351** (`237ca54` — the quote hook carries the
> error kind; a fault leaves Charge enabled with its own note). Raised:
> 358 (the Console's Test print sends no printer → 400; found by the
> evidence pass — building), 359 (the F&B refusal/source notes washed out
> on the light theme — building). SCRUM-353's fix round runs with `app.ts`
> in its owned set.
>
> **Running:** gates — 343/344 (`wf_bc7823ac`), 354 (`wf_5f8a746b`), 355
> (`wf_93411d0f`); builds — 206-A (`wf_9a136b60`), 341 (`wf_d527428e`),
> 349 (`wf_6e37179b`), 348 (`wf_f270a2cf`), 356 (`wf_bd56c962`), 353 fix
> (`wf_4493be0c`), 359 (`wf_4aea465b`), 358 (`wf_69884d8d`); evidence —
> the second half of the 097b73b batch (`wf_ea63e5b1`). Watchers wait for
> Render at `803428b` and `237ca54`.

> ## Status on 2026-09-23 15:20 — `main` is `4a1cc90`; staging is `097b73b` (Render is deploying `803428b`); CI green through `4ceb798`
>
> **Since 15:14:** **Deployed with staging evidence:** 328, 325, 333, 334
> (`4a1cc90`). **SCRUM-353's gate found the real defect:** Fastify 5.12
> fails a numeric `trustProxy` closed, so `TRUST_PROXY` has been inert on
> every deployment — `req.ip` is Render's front socket for everyone, all
> callers share two rate-limit buckets, and the per-address sign-in and
> booth/box credential throttles were degraded. Cloudflare IS in front of
> the api (`server: cloudflare`). The value stays 1 (fail-closed); the fix
> is `app.ts:112` handing the count over as a function. The slice's state
> is on ref `wip/353`; the fix round (`wf_4493be0c`) owns `app.ts` for
> that one line. After it deploys: one request through the POS `/api/*`
> rewrite with a junk `X-Forwarded-For` and one without decide whether the
> Cloudflare/Render hops must be trusted by address.
>
> **Running:** gates — 343/344 (`wf_bc7823ac`), 351 (`wf_b2308782`), 354
> (`wf_5f8a746b`), 355 (`wf_93411d0f`); builds — 206-A (`wf_9a136b60`),
> 341 (`wf_d527428e`), 349 (`wf_6e37179b`), 348 (`wf_f270a2cf`), 356
> (`wf_bd56c962`), 353 fix round (`wf_4493be0c`); evidence — the second
> half of the 097b73b batch (329/342/346/204 fixes, `wf_ea63e5b1`).

> ## Status on 2026-09-23 15:14 — `main` is `803428b`; staging is `097b73b` (Render is deploying `10b1242` → `803428b`); CI green through `10b1242`
>
> **Since 15:08:** the resumed 337/338 gate came back MERGE and landed
> (`803428b` — DELETE /members/children/:childId archives a child; the
> till's "Remove from saved" uses it and keeps the member in hand; the
> review names its store). Raised: 356 (a visit still accepts an archived
> child's id — building), 357 (the booking site's saved-children step is
> unreachable — a design decision for S2-12).
>
> **Running:** evidence — the 097b73b batch (`wf_ea63e5b1`); builds —
> 206-A (`wf_9a136b60`), 343/344 (`wf_bc7823ac`), 341 (`wf_d527428e`), 353
> (`wf_41ee7069`), 351 (`wf_b2308782`), 349 (`wf_6e37179b`), 354
> (`wf_5f8a746b`), 348 (`wf_f270a2cf`), 355 (`wf_93411d0f`), 356
> (`wf_bd56c962`). Watchers wait for Render at `10b1242`, `4ceb798`,
> `803428b`; then evidence for 347, 350, 337/338.

> ## Status on 2026-09-23 15:08 — `main` is `4ceb798`; staging is `097b73b` (Render is deploying `10b1242` → `40c69bb`); CI green through `097b73b`
>
> **Since 14:58:** the resumed gates for **347** and **350** came back MERGE
> and both landed (`10b1242` — codes hashed with argon2id and a per-code
> salt, a legacy read path until the old codes expire; `40c69bb` — the
> customer display's dashes while a drop-off child awaits a length).
> Raised: 355 (the placeholder line title "1 Hour Play" before a length —
> building). Launched 348 behind 347 (same file). The monitor now reads
> the session-limit message as a stopped agent and a resumed run's state
> from the last agent of each label.
>
> **Running:** gate — 337/338 (`wf_438d7369`, resumed); evidence — the
> 097b73b batch (`wf_ea63e5b1`, resumed); builds — 206-A (`wf_9a136b60`),
> 343/344 (`wf_bc7823ac`), 341 (`wf_d527428e`), 353 (`wf_41ee7069`), 351
> (`wf_b2308782`), 349 (`wf_6e37179b`), 354 (`wf_5f8a746b`), 348
> (`wf_f270a2cf`), 355 (`wf_93411d0f`). Watchers wait for Render at
> `10b1242` and `4ceb798`; then evidence for 347 and 350.

> ## Status on 2026-09-23 14:58 — `main` is `d6e1592`; staging is `097b73b`; CI green through `097b73b`
>
> **14:37–14:50: the session limit cut every running agent.** Three builds
> had finished (337/338, 350, 347 — their reports are in the journals) and
> their gates died; seven builds died mid-edit with partial edits in the
> tree (349, 343/344, 351, 341, 354, 206-A, 353); the evidence pass died.
> Relaunched at 14:52–14:58: gate-only resumes for the three finished
> builds (`Workflow({scriptPath, resumeFromRunId})` replays the cached
> build result and runs the gate live), the evidence pass, and the seven
> builds from their scripts with a "RESUMING AN INTERRUPTED ATTEMPT"
> preamble prepended to RULES (read git diff on the owned files first,
> keep what is right, finish). Ten runs live again. Nothing was committed
> from the interrupted work; the tree holds only their partial edits.
>
> **Running:** gates — 337/338 (`wf_438d7369`), 350 (`wf_a39c3940`), 347
> (`wf_5543a1c8`); evidence — 328/325/333/334 and 329/342/346/204-fixes at
> `097b73b` (`wf_ea63e5b1`); builds — 206-A (`wf_9a136b60`), 343/344
> (`wf_bc7823ac`), 341 (`wf_d527428e`), 353 (`wf_41ee7069`), 351
> (`wf_b2308782`), 349 (`wf_6e37179b`), 354 (`wf_5f8a746b`).
>
> **Next:** as before — land each on its gate; 352 after 351 and 349; 348
> after 347; tenders wave 2 after A; set `TRUST_PROXY` on Render when 353
> lands.

> ## Status on 2026-09-23 14:36 — `main` is `097b73b`; staging is `7b746f1` (Render is deploying `604ef31` → `097b73b`); CI green through `3ba0840`
>
> **Since 14:14:** landed **333/334** (`bb8be9a` — the sale read names its
> document check; dashes until a play length is chosen), **342** (`604ef31`
> — Charge disabled during a platform refusal, enabled through an outage),
> **346** (`097b73b` — the Discounts rows on the light admin). **Deployed:**
> 335 (its pass also confirmed live that `TRUST_PROXY=1` is one hop short
> behind Cloudflare + Render → 353). Raised: 350 (customer display ฿0 for a
> drop-off child awaiting a length — building), 351 (the quote hook should
> carry the error kind — building), 352 (mobile sheet and shop cart charge
> gate — after 351 and 349), 353 (proxy hops — building), 354 (back-office
> dark-surface sweep — building).
>
> **Running:** gates — 337/338 (`wf_438d7369`); builds — 341
> (`wf_6eb93633`), 347 (`wf_5543a1c8`), 206-A (`wf_60563353`), 343/344
> (`wf_af0f3e9b`), 349 (`wf_d3ec6f47`), 350 (`wf_a39c3940`), 351
> (`wf_017e29f0`), 353 (`wf_e71240e6`), 354 (`wf_ccf15052`); evidence —
> 328/325/333/334 and 329/342/346/204-fixes waiting for Render at `097b73b`
> (`wf_ea63e5b1`). Watchers wait for Render at `604ef31` and `097b73b`.
>
> **Next:** 352 after 351 and 349; 348 after 347; tenders wave 2 (B, C1, E)
> after A lands. When 353 lands, set `TRUST_PROXY` on the Render api
> service to the value its report names (a redeploy). Owner decisions
> outstanding: 206's three, 254's two, 306's read-only staff, 327's retried
> pairing, 345, 326, the "HKT Central" app-only row (268), the deploy-bot
> paid service.

> ## Status on 2026-09-23 14:14 — `main` is `3ba0840`; staging is `7b746f1`; CI green through `b458650`
>
> **Since 13:41:** landed the 204 panel fixes (`bbf1792` — its gate was DO NOT
> MERGE for one line: the scanning test now reads the seeded socks row), **328**
> (`e977b49` — an offline box polls for go_online only), **325** (`b458650` —
> every refusal costs one argon2 verification), **329** (`3ba0840`).
> **Deployed with staging evidence:** 331 (one registration, zero refusals
> across a real ~61 s two-instance overlap), 253, 255, 327. Raised: 347
> (codes stored as plain SHA-256 of six digits — building), 348 (unlock
> route timing, after 347), 349 (the phone sheet prices itself).
> **SCRUM-206 tenders:** the read-only planning fan-out produced
> `scratchpad/plan-206/PLAN.md` (eight slices, five waves — A → B/C1/E →
> C2/D → F/G); the plan and the owner decisions (2C2P sandbox, offline
> scope, vendor questions) are on the ticket; **Slice A is building**
> (`wf_60563353`: migration 0019, payment_attempt/notification/method,
> shared vocabulary, seed:demo-day).
>
> **Running:** gates — 333/334 (`wf_e70284a0`); builds — 337/338
> (`wf_438d7369`), 342 (`wf_eb99843a`), 346 (`wf_d83140b5`), 341
> (`wf_6eb93633`), 347 (`wf_5543a1c8`), 206-A; evidence — 335
> (`wf_af70868e`). A watcher waits for Render at `3ba0840`; then evidence
> for 328, 325, 329, the 204 fixes and 341 when they land.
>
> **Next:** 343/344 after 333/334 free `sale.ts`; tenders wave 2 (B, C1, E)
> after A lands — B must follow 333 (both in `sale.ts`); 348 after 347.
> Owner decisions outstanding: 206's three (above), 254's two, 306's
> read-only staff, 327's retried pairing, 345, 326, the "HKT Central"
> app-only row (268), the deploy-bot paid service.

> ## Status on 2026-09-23 13:41 — `main` is `96523cd`; staging is `adff73c` (Render is deploying `b7d7b67` → `7b746f1`); CI green through `adff73c`
>
> **Since 13:12:** landed the branch clone R-03 (`2740291` + the two
> `app.ts` lines), **331** (`adff73c` — advisory-lock lease, refusal
> back-off; a failed box start gives the lease back, statement timeout on
> the probe), **253/255/327** (`b7d7b67` — archived tenancy stops trading,
> record scope and foreign file owners refused, the code-minting routes
> declare secretResponse; 327's premise — an ERROR line per pairing — was
> false and the comments now say what was true), **335** (`7b746f1` — the
> rate-limit builder now raises an AppError, so a capped request answers
> 429 not 500). **Deployed with staging evidence:** 233, 306; 204's three
> landed halves are evidenced and commented (ticket stays In Progress).
> Raised: 345 (codes unique per operator block cloning coded items — owner
> decision), 346 (Discounts panel styled for a dark screen). Left on
> staging by the passes: member +66800000233 with one child and a draft
> visit, one unpaid `tendering` sale, booking OTO-734160-3268 redeemed,
> product "Grip socks M" 8850000000017, sales T1-000006/7.
>
> **Running:** gates — 204 panel fixes (`wf_7d83497d`); builds — 337/338
> (`wf_438d7369`), 328 (`wf_384ce931`), 333/334 (`wf_e70284a0`), 329
> (`wf_3d5b8bf8`), 325 (`wf_27963949`), 342 (`wf_eb99843a`), 346
> (`wf_d83140b5`); planning — SCRUM-206 tenders read-only fan-out
> (`wf_66f5e63a` → `scratchpad/plan-206/PLAN.md`); evidence — 331/253/255/
> 327 waiting for Render at `b7d7b67` (`wf_969f6625`). Watchers wait for
> Render at `b7d7b67` and `7b746f1`.
>
> **Next:** land each on its gate; 341 after the 204 fixes free
> `api/menu.ts`; 343/344 after 333/334 free `sale.ts`; then the tenders
> slices from PLAN.md (206), 207, 208. Owner decisions outstanding: 254's
> two calls, 306's read-only staff, 327's retried pairing minting a second
> credential, 345, 326, the "HKT Central" app-only row (268), the
> deploy-bot paid service.

> ## Status on 2026-09-23 13:12 — `main` is `2a9dd25`; staging is `deaf34d` (Render is deploying `849bc17`); CI green through `fa3785a`
>
> **Since 12:30:** landed 252/254 (`6ea6220`), 330 (`deaf34d`), 233
> (`3d0cfb6` — the supervision gate writes through the member API), the
> 204 barcode + admin panels (`fa3785a`), 306 (`28d2e65` — the booking
> permission pair), the **204 carts** (`849bc17` — F&B and shop orders
> through the sale ledger, priced on the platform, pick-up code before the
> tender) and their evidence. **Deployed with staging evidence:** 318, 319,
> 304, 332, 336, 252, 254, 330. Raised: 337–340 (233's follow-ups: no
> child-archive route, the review's stale "held in memory" note, two draft
> visits, the mock drop-off lookup), 341 (F&B item form still tab-only),
> 342–344 (carts follow-ups: Charge stays enabled after a refusal,
> sales_channel always "till", promo scopes miss F&B lines).
>
> **Running:** gates — tenancy 253/255/327 (`wf_0532c182`), branch clone
> R-03 (`wf_70c3b1f2` — the parent adds its one `app.ts` line), 331
> (`wf_0cb720ff`); builds — 337/338 (`wf_438d7369`), 204 panel fixes
> (`wf_7d83497d`: localOnly flags, merch-under-F&B category, seed barcode),
> 335 (`wf_e175b9c5`: the 21st booking answers 429). Watchers wait for
> Render at `849bc17`; then one evidence pass for 233, 306 and the two 204
> halves.
>
> **Next:** 341 after the 204 fixes free `api/menu.ts`; 333/334 now that
> `sale.ts` and the staff panel are free; 328 after 331 frees `agent.ts`;
> then tenders (206), 207, 208. Owner decisions outstanding: 254's two
> judgement calls (docs gated everywhere; branch managers can read it),
> 306's read-only staff losing the arrivals list, 326's fix choice, the
> stale "HKT Central" app-only row (268), the deploy-bot paid service.

> ## Status on 2026-09-23 12:30 — `main` is `1875f56`; staging is `16c621a`; CI green
>
> _(The two banners below are labelled 12:00 and 13:00 but were written about
> an hour earlier than they say; times from here on are the machine clock,
> Asia/Bangkok.)_
>
> **Since the previous banner:** landed 257 (`69af2fb`), 309 (`cc686cc`), 318/319
> (`16c621a`), the claim-refusal ordering (`77080e9`), **304** (`c6338d6` —
> `pos.booking_redemption`, migration 0018 with a backfill) and the 336 hint
> (`1875f56`). **Deployed with staging evidence:** 322/305/323, 316 (+311's
> live refusal), 257, 309. Raised: 331 (the virtual box re-registers in a
> storm around every deploy — 637 refusals a day), 332 (**every staging
> deploy re-ran the full demo seed** — Render's pre-deploy was
> `db:seed`, not the `db:platform-sync` render.yaml documents, with
> `SEED_PROFILE=staging`; changed on Render to `pnpm db:migrate && pnpm
> db:platform-sync` at 12:20, verified by the next deploy's log line), 333
> (sale read lacks the claim id), 334 (Subtotal ฿0 beside a real Total),
> 335 (21st booking in a minute answers 500), 336. New Bugs go under
> SCRUM-324 by default (`createInSprint` in the scratchpad).
>
> **Running:** builds — 233 (`wf_f769bf02`), carts 204 (`wf_cde4e3cd`),
> tenancy 253/255/327 (`wf_0532c182`), barcode + admin panels
> (`wf_344f565a`), 330 (`wf_b892a282`), branch clone R-03 (`wf_70c3b1f2`),
> **331** (`wf_0cb720ff` — advisory-lock lease + refusal back-off); gate —
> 252/254 (`wf_effd34f0`); evidence — 318/319 (`wf_22423a2a`). A watcher
> waits for Render at `c6338d6`; then an evidence pass for 304, 332 (the
> "Platform sync only" log line) and 336.
>
> **Next:** land each on its gate; 306 after 304 (redeem's own permission);
> 333/334 after the carts slice frees `sale.ts` and the staff panel; then
> tenders (206), 207, 208.

> ## Status on 2026-09-23 13:00 — `main` is `b9438cd`; staging is `d1d0bd7`; CI green again
>
> **Since 12:00:** the box slice landed (`d1d0bd7`, 322/305/323 Testing;
> its first gate answered the monitoring question instead — re-run and
> MERGE); the till slice landed (`a872d9d`, SCRUM-316 Testing) and its
> finding is fixed on the platform (`77080e9`: a spent claim answers as
> itself, not as the price mismatch it causes); the booth is **Deployed
> with staging photographs** — SCRUM-199, 244, 278 and the **S2-07 story**
> — one screen paired to Booth 1 on staging by design, one spin. Raised:
> SCRUM-328 (Go online cannot reach an offline box), 329 (phone cart
> sheet). The Defects epic is SCRUM-324.
>
> **Running:** Round B builds — 257 (spin cap, `wf_88a379f8`), 309 (holiday
> rename, `wf_1a4a0748`), 318/319 (`wf_aad4bc77`), 304 (redemption table,
> `wf_fe4ec6dc`), 252/254 (public surface, `wf_effd34f0`); evidence passes
> for the seven Round A tickets (`wf_890979a3`) and the box (`wf_77dec1e1`).
> Watch with `node scripts/workflows-status.mjs`.
>
> **Next:** land those on their gates; 233 (supervision-gate child — Till.tsx
> is free now); 306 after 318/319 releases `permissions.ts`; 255; then the
> carts (204) and tenders (206).

> ## Status on 2026-09-23 12:00 — `main` was `6f266d0`; staging was `0da5441` (CI was red for four pushes, fixed; deploy pending)
>
> **Owner decisions this morning:** every Bug/Task lives in the sprint
> (88 moved into "Sprint 2 – Complete build", id 3); defects sit under the
> red-ish epic **SCRUM-324** (`dark_orange` — Jira's palette has no red) with
> `defect`/`gap`/`ci-check` + area labels; GitHub is linked to Jira and
> **`scripts/jira-walk.mjs` links the shipping commits on the ticket when it
> reaches Deployed** (`--link-only` backfilled 132 links on 68 tickets); parent
> stories get a status paragraph whenever a child moves; the other session is
> paused and `render.yaml`/Render are ours now (its deploy-bot block stays
> uncommitted — a paid service is the owner's call).
>
> **Landed since 08:00:** the booth's Render service
> **https://oto-booth-staging.onrender.com** (created through the API — no
> blueprint is linked; `1a6ba2b` carries the yaml entry; the api's
> `ALLOWED_ORIGINS` on Render now includes it); the television frame ported
> from the prototype (rotate/scale, `#cw/#ccw/#off/#lite`) and **screen
> pairing** closing SCRUM-244 (`451c7b3` — 199/244/278 Testing); handheld
> History (`482912e`, 320); auth hardening 251/298 (`23edaf8`, `26bd73b`);
> members fields 231/321/317/315 (`8bcbd0f`); walker + monitor scripts.
> Raised: SCRUM-325 (timing side-channel), 326 (result card 36px over a
> 16:9 stage), 327 (station pairing route's secretResponse).
>
> **Running:** the till slice (`wf_b8035d08`: SCRUM-316 + the refusal on the
> till) and the re-run box gate (`wf_e9a9d2b3`: SCRUM-322/305/323 — its first
> gate answered an unrelated question). Monitor with
> `node scripts/workflows-status.mjs [--watch]` (`/workflows` is not in this
> editor). **A Stop key or a declined permission prompt cuts every running
> subagent at once** — five slices died that way at 10:15 and were relaunched
> with a resume preamble.
>
> **Next:** CI green on `6f266d0` → Render → booth staging photographs
> (rotation on the live URL, a real pairing) → 199/244/278 Deployed and the
> S2-07 story with them; land the till and box slices; then Round B
> (233, 257, 304/306, 309, 318/319), the carts (204), tenders (206).

> ## Status on 2026-09-23 08:00 — `main` was `0a669f0`; staging was `0a669f0`; the tree was clean
>
> **Since 06:00:** SCRUM-268 Deployed with its Console Branches page on
> staging; SCRUM-275's last two halves landed (`b673948` — `edge.box_cache`,
> migration 0016; the receipt mark from `pos.receipt_series`); SCRUM-311
> landed (`0a669f0` — `pos.sale_tier_claim`, migration 0017, single-use
> claims, the sale names its claim, the demo reset cuts the cycle). Both in
> **Testing**; an evidence pass (`wf_bcf526b9`) is putting their staging
> screenshots on and walking them to Deployed. Raised: **SCRUM-322** (the
> receipt mark moves the bundle etag, so a selling box pulls its whole
> bundle each minute — plan on the ticket).
>
> **Next, in order:** SCRUM-322 (split the mark out of the etag);
> SCRUM-320 (handheld History); SCRUM-316/317/321/315 (each under an
> hour; 316 should also show `tierClaimRefusal` on the counter till);
> SCRUM-304/305/306 (bookings follow-ups); SCRUM-204's carts (S2-09b);
> S2-10a tenders (SCRUM-206). SCRUM-199 stays blocked on the booth's
> Render service; the stale "HKT Central" app row awaits the owner
> (SCRUM-268 comment).

> ## Status on 2026-09-23 06:00 — `main` was `9bcf46e`; staging was `1634f82`
>
> **Everything launched tonight has landed.** Since 04:30: SCRUM-268 branch
> mapping (`6e7d557`, Testing — staging reconciled, Central Floresta and
> Robinson Chalong mapped, Head Office app-only, plus a stale app-only
> "HKT Central" row that needs the owner's decision); the seed writes the
> demo menu (`3dc0359`) and the F&B category carries a code (`178567a`);
> the four menu fixtures that collided with the seeded menu (`1634f82`,
> CI red for two commits, fixed the same hour); History reads the ledger
> (`a21d12d`, SCRUM-238). **Deployed with staging screenshots:** 232,
> 230, 292, 302, 310, 312, 241 — on top of the thirteen at 03:30. Raised:
> SCRUM-318 (operator-wide by role name), 319 (no unique on
> core_branch_id), 320 (handheld History still sample rows), 321 (admin
> Members dialog writes a WhatsApp channel nobody chose).
>
> **Running:** one evidence pass (`wf_dd187784`) — SCRUM-268's Console
> Branches page and History on staging; 268 walks to Deployed on it.
>
> **Staging:** the seed was run once from this machine (the database's
> temporary IP allow-list entry now points at this machine's address —
> `scratchpad/db-allow.mjs`; it is the same single "remove after" entry
> as before, re-pointed). Staging holds sales T1-000001/T1-000002 (expat),
> T2-000001/T2-000002 (tourist), booking OTO-1590237-7290 (redeemed), the
> renamed holiday, the archived evidence menu rows; James is back on Expat.
>
> **Next, in order:** SCRUM-275's two remaining halves (edge.box_cache
> table; receipt high-water mark from the ledger); SCRUM-311 (claim table
> + `sale.tier_claim_id`); SCRUM-320 (handheld History); SCRUM-316/317/
> 321/315 (each under an hour); SCRUM-204's carts (S2-09b); then S2-10a
> tenders (SCRUM-206), which the ledger's Pay → Confirm flow is waiting on.
> SCRUM-199 stays blocked on the booth's Render service (other session).

> ## Status on 2026-09-23 04:30 — `main` was `de069c1`; staging was `d26e21c`
>
> **Since the 03:00 banner:** the menu slice passed its second gate and
> landed (`d26e21c` — SCRUM-232/230, SCRUM-204's catalogue half, the
> SCRUM-292 schema-shape test with its lockfile, SCRUM-302); CI green,
> migration 0015 applied on staging, the menu routes answer there. The
> Deployed-evidence pass put staging screenshots on 296/297/299/300/301/
> 200/307/228/308/313/234/238/314 — all **Deployed**. POS round 3 landed:
> the phone till's tier claim (`d16b27f`, SCRUM-310), the visitor display
> dashes (`b9c9584`, SCRUM-312), revoking a verified tier (`dd54c79`,
> SCRUM-241) — all Testing with images; SCRUM-308's last piece
> (`de069c1`). Raised: SCRUM-315 (member route's free-text evidenceType),
> 316 (staff-half ฿0), 317 (register's revoked shape).
>
> **Running:** SCRUM-268 branch mapping (`wf_884722ad`; owns
> `routes/{branches,app-identities}.ts`, `services/oto-app-*.ts`,
> `packages/db/src/{seed/index,schema/otoapp}.ts`, Console `Branches.tsx`),
> History reading the ledger (`wf_a242658f`; owns `pages/History.tsx`,
> `components/history/**`, `api/history.ts`, `listSales`'s select),
> the menu evidence pass on staging (`wf_3a89e172`; SCRUM-232/230/292/302
> → Deployed). **After 268 lands:** add `await seedMenu(db, { operatorId,
> branchId })` to `packages/db/src/seed/index.ts` after the branch tax
> config (the demo menu is dead code until then — staging holds one item).
>
> **Staging holds from tonight's evidence:** sale T1-000001 (expat, ฿973)
> at Central Floresta, booking OTO-1590237-7290 (redeemed), the renamed
> holiday; the evidence tier was removed. The other session's
> `render.yaml` and `services/` are still uncommitted in the tree.

> ## Status on 2026-09-23 03:00 — `main` was `b8029f2`
>
> **Landed since the banner below:** SCRUM-308 (chip and receipt agree on
> the trading day, `155a251`); the box pulls whole after an outage
> (`72e97fd`); the five ledger items 296/297/299/300/301 (`bcf32d5`,
> assembled hunk-by-hunk from a tree three slices shared); the tier claim
> 307/228/203 (`b8029f2`). All in **Testing**; they move to Deployed when
> Render has `b8029f2` and a screenshot is on each. SCRUM-303 is Deployed
> (the eight tenancy tickets carry images). Follow-ups raised from the
> gates: **SCRUM-310** (phone till still cannot sell an Expat walk-in),
> **311** (claim table + `sale.tier_claim_id`), **312** (visitor display
> ฿0), **313** (epoch guard on `handleVerified`), **314** (etag vs a bad
> local bundle while online).
>
> **The menu slice is NOT on main.** Its gate said DO NOT MERGE; the slice
> is saved at `wip/menu-catalogue` (`d79038e`) and a fix round
> (`wf_cf412d0b`) is working in the tree on: Apply refused (POS sends
> `{previewToken}` only), the POS Export as a second writer, `sale.ts`
> reading the now-nullable `taxable_category` raw, re-import with
> `action=archive` refused, modifier-group archive leaving links. When it
> lands: commit by explicit list, then `packages/db/{package.json,
> tsconfig.json,test/**}` with the lockfile (SCRUM-302), then the one-line
> `setBranchDayStart(active.businessDayStart)` in `catalogBridge.ts`
> (SCRUM-308's last piece, held back because the menu owns that file).
>
> **Mixed-file discipline that worked:** `scratchpad/hunks.mjs list|pick`
> splits `git diff` by hunk; a temp index (`GIT_INDEX_FILE` + `read-tree
> HEAD` + `git apply --cached <picked>` + hand-built blobs via
> `hash-object` + `update-index --cacheinfo`) makes a commit that carries
> one slice's hunks and leaves the shared working copy untouched; then
> `git reset -q` aligns the main index. Never `git checkout -- <file>` to
> "restore" — it restores HEAD, and it wiped a fix once tonight.

> ## Status on 2026-09-23 (early hours) — `main` was `0662fcb`
>
> **Landed since the 22nd banner, in order:** the two-branch park with its
> branch managers and the eight leaks it exposed (SCRUM-248–250, 263–267,
> Deployed); the tenancy leaks and the three conformance tests that keep them
> closed (280–284, 289–291, Testing); bookings found and redeemed at the
> counter (234/238, Testing); screenshots on the 22 tickets that had none;
> the booth admin panel driven against a live box (SCRUM-200, **Testing**,
> `388b7c8`); and **the box now refreshes its cache on a timer** (`72a1c48`,
> SCRUM-275 In Progress) — until then a published wheel, a withdrawn booth
> PIN or a dismissed employee's revocation reached a running box only at its
> next restart, and "Apply config" on the Console reported success while
> changing nothing.
>
> **CI note:** `05beeca` was red — it carried `import { menuRoutes }` while
> `routes/menu.ts` is still the menu slice's uncommitted file. `0662fcb`
> drops the import from `main` without touching the shared working copy of
> `app.ts` (built from HEAD's blob through a temp index). When the menu
> lands, its `app.ts` re-adds the import together with the file.
>
> **In flight at the moment of writing — three workflows at their gate
> stage, all with explicit file ownership, none committed:**
> - **tier-claim** (`wf_72cfced7`): SCRUM-307/228/203 — `services/sale-tier.ts`,
>   `routes/sale-tier.ts`, one call site in `services/sale.ts`, till gaps in
>   `StepPayment/StepConfirmation/OrderSummary/TicketCard.tsx`, `lib/pricing.ts`,
>   `lib/tierProof.ts`, `MobileTill.tsx`, `VerifyTierModal.tsx`.
> - **cheap-fixes** (`wf_5694e79e`): SCRUM-296/297/299/300/301 —
>   `routes/{auth,files,sales,ops}.ts`, `services/{auth,handoff,ops,access-control}.ts`,
>   `plugins/session.ts`, `console/src/lib/reach.ts`, `pages/{Failures,Health}.tsx`,
>   `test/{auth-handoff-files-tx,sales-reach}.test.ts`.
> - **menu** (`wf_25c76908`): SCRUM-232/230/204 — migration `0015_menu_catalogue`,
>   `packages/shared/src/menu-shapes.ts`, `services/{menu,menu-sheet}.ts`,
>   `routes/menu.ts`, `packages/db/src/seed/menu.ts`, `pos/src/api/menu.ts`,
>   `pos/src/components/admin/menu/*`, `apps/api/package.json`, `pnpm-lock.yaml`.
>   **After it lands:** commit `packages/db/{package.json,tsconfig.json,test/**}`
>   with the reconciled lockfile (SCRUM-302).
>
> Each result is read in full, its files committed by explicit list (never
> `git add -A`), the commit checked against its message, Jira moved in the
> same turn, and nothing reaches Deployed without a screenshot on the ticket.
> If a gate says DO NOT MERGE, the slice goes to a `wip/` branch through a
> temp index BEFORE any fix round.
>
> **Raised this turn:** SCRUM-309 (a holiday that has priced a sale can be
> neither removed nor renamed — the staging test holiday was renamed directly).
> **Staging:** the "zz-shot evidence" holiday at Robinson Chalong is now
> "Weekend pricing test (22 Sept)"; it priced one sale on the 22nd, so the
> platform correctly refuses to delete it.
>
> **Still blocked on the other session:** SCRUM-199's Render service for
> `apps/booth` (`render.yaml` and `services/deploy-bot/` are theirs — the
> working tree shows both modified; leave them).

> ## Status on 2026-09-22 — the banner below it is RESOLVED
>
> Everything that banner asked for is done and live. SCRUM-242, 243, 245,
> 247, 259 and 260 are **Deployed**; 246 is Deployed on the api. Every kiosk
> path now requires a device credential, stays inside its own park, and
> refuses with one uniform answer. Two small kiosk findings remain as
> tickets: SCRUM-261 (anonymous image upload) and SCRUM-262 (unthrottled
> failure log).
>
> **The park's real staff rows ARE on staging** — 10 staff, 959 clock-ins,
> 59 tasks. The workflow stopped on the 21st had reached the load step
> before the stop landed, and its report never returned, so they were there
> about a day with the kiosk findings open. **Ten rows carried face
> enrolment, which was cleared directly**: the mock matcher clocks anyone in
> as the first enrolled person, so an enrolled row was an impersonation.
> The seed (`e5649ad`) no longer carries face enrolment for anybody.
>
> **Also on 2026-09-22:** the sale ledger (SCRUM-203) is on `main` and
> **Deployed** — a real sale was rung through staging, receipt `T2-000001`.
> The booth admin panel (SCRUM-200) is on `main`, In Progress pending its
> first browser run against a live server. `main` is **`e5649ad`**; §1 and
> §8 below describe the 21st and are superseded by this.
>
> **Next, in order:** the booth's Render service (still the other session's
> blueprint); S2-07b's first integration run; S2-09b (SCRUM-204), the F&B and
> shop carts; SCRUM-232, the product tables, which the menu import lands on;
> then the register's remaining broken items (230, 231, 233, 234, 238).

> ## ⚠ READ THIS BEFORE ANYTHING ELSE — as written on the 21st; resolved above
>
> **Staging is not safe to leave on the public internet with the park's real
> staff rows on it.** An authorization sweep at the end of this session
> confirmed fourteen findings (SCRUM-242 to SCRUM-255, all Bugs under epic
> SCRUM-181, labelled `security` + `authz-sweep`).
>
> The one that decides it is **SCRUM-242**: the OTO App's kiosk
> clock-by-phone endpoint takes an **anonymous** request with no device
> credential, and its only rate limit sits *inside* a branch that is skipped
> when no credential is presented. A number that belongs to staff comes back
> naming the employee and files a clock event; one that does not says so.
> Reproduced live — fifteen malformed numbers, fifteen refusals, no throttle.
> Against invented rows that is harmless. Against real phone numbers it is a
> staff directory and a time-clock anybody can drive.
>
> **So the seed was deliberately NOT loaded onto staging** and the deploy was
> not triggered. The work is committed at `fb07411`; the load is the step
> that was stopped. The seed is find-or-create and re-runnable, so nothing is
> lost by waiting.
>
> **Do these before running that seed against staging or telling the owner to
> look:**
> 1. Put `oto-app-staging` behind access control, or take it off the public
>    internet.
> 2. **SCRUM-242** — move the rate limit outside the credential branch and
>    require the device credential.
> 3. **SCRUM-247** — the kiosk device id is currently a 30-day bearer token:
>    `refreshKioskSession` matches the id and `active` only, never the secret
>    hash.
> 4. **SCRUM-245** — the null-scope invite fix is committed but the *deployed
>    POS bundle still contains the old code*, and staging's only
>    administrator is platform-wide, so the server accepts the null. Ship it.
> 5. **SCRUM-246** — `GET /members` with no search term returns the whole
>    register with every child's allergies and medical notes, on the same
>    permission that looks up one member. One shared till session is the lot.
>
> Two things the sweep did **not** find, which is worth knowing: no
> cross-operator escalation has any live reach on staging today (one operator,
> one branch), and **the pay figures in the seed are not exposed by any
> defect** — that is purely a question of who holds the admin password.
>
> Full detail, reproductions and what was touched on staging (read-only, two
> sign-ins, nothing created) are in the sweep's own report referenced from
> the tickets.

**The one rule that matters most here:** establish what is built from the
**code** and from **driving staging**, never from a document. A stale line in
`CLAUDE.md` §11 cost this project a week — it said a member's tier had no UI
to change it, which was false, and the owner's real problem was a *bug* that
nobody looked for because the document said the feature did not exist. Every
claim below carries a commit or a measurement. If you find one that does not
match the code, the document is wrong and fixing it is part of your work.

---

## 1. Where the code is

| | |
|---|---|
| Branch | `main`, and everything is on it — no open branches |
| HEAD | `0abc9ea` |
| Deployed to staging | `fdcf99e` on all five services; `0abc9ea` was still building at wind-up |
| Tests | 577 api · 209 print · 197 shared · 167 box-agent · 36 telemetry |
| Migrations | `0013_box_local` is the latest; apply twice from empty to an identical catalogue |

**Check before you trust this table:** `git log --oneline -1`,
`gh run list --branch main --limit 3`, and the Render status helper described
in §6. The deploy state in particular will have moved on.

---

## 2. What was delivered this session

Twenty commits from `6440761` to `0abc9ea`. In order of what matters:

**S2-06 (SCRUM-197) finished and Deployed.** The device half — printer
adapters and simulators, the print queue, scanning, the signed staff badge,
the offline shell, the simulator panel. Ten defects were found by two review
rounds and a merge gate, three of them security, and every one was reproduced
before it was fixed. Evidence with six screenshots is on the ticket.

**S2-07a (SCRUM-199) built, merged, Testing.** The Lucky Wheel booth: the box
draws the outcome, records the spin *before* the wheel turns, mints the
voucher, prints it and syncs it. Migration 0012 (booth and promo schema, the
signing keyring, credentials) and 0013 (the box-local tables). It is
**Testing rather than Deployed for exactly one reason** — see §4.

**Five POS defects fixed and Deployed** (SCRUM-225 to 229), including the one
the owner reported himself: a member's tier change was discarded on Save.

**Five more fixed and in Testing** (SCRUM-235, 236, 237, 239, 240): the admin
gate, eleven screens that saved nothing, roles that could not be given back,
branch creation, and the temporary-password dead end.

**The OTO App** no longer errors on save, and is seeded from the park's own
rows rather than invented ones.

**`POS_GAP_REGISTER.md`** — every POS capability classified from the code and
from driving staging: **33 work, 15 are broken, 36 are not built**, 84 items,
with SCRUM-225 to SCRUM-241 raised from it. This is the most useful document
in the repo for planning; read it before you pick anything up.

---

## 3. The two most serious things found, and why they hid

Both were found sideways, while doing something else. Assume there are more.

**An invitation could give away the whole platform.** Inviting an
`operator_admin` from the POS panel sent a null scope id, and a null operator
scope means *every operator there is*. Somebody invited to help run one park
became an administrator of the platform. It stayed hidden because of **who**
it happened to: the only account that could successfully send that invitation
was already platform-wide, so nothing looked wrong; anybody else had it
refused outright. Fixed in `0abc9ea`.

**The test that guarantees no route is unguarded accepted a promise as
proof.** A route may declare `dynamicPermission: true`, meaning "I check in my
own handler". The test counted that declaration as evidence. It installs
nothing, and authentication is not global here — so a route that declares it
and forgets answers **anyone, with no session**. Proved with a route written
to do exactly that: 200, anonymously. The test now drives every non-public
route with no cookie. Fixed in `0abc9ea`.

The pattern behind both: **a guarantee asserted rather than enforced.** That
is also the shape of the recurring defect below.

---

## 4. Blocked, and on whom

| What | Blocked on | Detail |
|---|---|---|
| **The booth is not reachable** | the session that owns `render.yaml` | Its platform side is live, but `apps/booth` has no Render service, so there is no address to open. About five lines of blueprint. This is the only thing between SCRUM-199 and Deployed. |
| SMS: no code can be delivered | the owner | Twilio 422 error `572002` — the trial account owns no number and has no verified recipient. And Thailand has required a registered sender since Oct 2025, so buying a US number will not help. Twilio **Verify** is the route that avoids a 10-day registration. |
| Photo upload from a browser | the owner | The storage token now writes; the bucket still has **no CORS policy**. The exact rule to paste is in `OWNER_ACTIONS_AND_NEXT_BUILD.md`. Separately, nothing in any front end calls `POST /files` and `PATCH /me` has no caller either — there is no profile-editing screen. |
| `VITE_HR_APP_URL` unset on the OTO App | the owner | Declared in the blueprint with a value, absent from the live service. Unset, three screens send people to an old Replit address. It is a build argument, so it needs a **deploy, not a restart**. |
| `STAFF_TOKEN_PRIVATE_KEY` unset on the api | the owner | `openssl genpkey -algorithm ed25519`. Nothing visible fails without it; the till simply cannot be unlocked with no internet. |

`docs/progress/OWNER_ACTIONS_AND_NEXT_BUILD.md` is the list written for the
owner. `docs/qa/STAGING_READINESS.md` is what he can try today.

---

## 5. What to pick up next, in order

0. **The five security items in the banner at the top**, before anything
   else and before the owner is told to look at staging again. Everything
   below assumes those are done.
1. **Finish what is in Testing.** SCRUM-235/236/237/239/240 need staging to
   pick up `0abc9ea`, then a look, then Deployed with evidence. Shipping that
   build also closes SCRUM-245, because the null-scope fix is in it.
2. **The booth's Render service**, so SCRUM-199 can be Deployed and the wheel
   can be opened in a browser. Coordinate with the `render.yaml` session.
3. **SCRUM-203 — the ticket cart and the sale ledger.** Was the biggest real
   gap: admission reached "Pay ฿1,440" and **nothing after Pay existed**.
   **All three parts are now built in this tree and none is committed or
   deployed** — migration `0014_sales_ledger`, the till's quote-and-write
   path, and `apps/api/src/services/sale.ts` + `routes/sales.ts` behind
   `POST /sales/quote`, `POST /sales`, `POST /sales/:id/finalise`,
   `GET /sales` and `GET /sales/:id`. The next step is the one neither half
   can claim: commit, deploy and **drive it from a browser**. Tenders are
   S2-10a.
4. **SCRUM-229's sibling — one pricing engine.** Was one caller (the public
   booking quote) while the till priced in the browser from the prototype's
   copy. Now three: the booking quote, the till through `@oto/shared`
   directly, and `POST /sales/quote`, which is what the till asks and what
   the sale is written from. The two-engines problem is closed in the tree;
   it is closed *in production* on the day the above is deployed. SCRUM-226
   is what it cost.
5. **SCRUM-232 — the product tables cannot hold the park's menu.** `product`
   is a five-field placeholder with no write path anywhere. Every catalogue
   ticket lands on this, and the menu import/export the owner asked for
   arrives *with* the menu's first real persistence, not after it. The
   spreadsheet template is already specified column by column in the workflow
   output referenced from `OWNER_ACTIONS_AND_NEXT_BUILD.md`.
6. **S2-07b (SCRUM-200)** — the booth admin panel.
7. Then the register's remaining BROKEN items: SCRUM-230, 231, 233, 234, 238.

---

## 6. How to work on this

**Ultracode is on.** Use workflows for substantive work; several agents can
share the tree if — and only if — each slice owns named files and the others
are told not to open them. That worked all session with up to three workflows
running; it works because the file list is explicit in every prompt.

**Commit by explicit file list, never by directory.** Agents share this tree
and a `git add .` sweeps in another workflow's half-written work. It has
happened three times.

**Never switch branches while agents are running.** Committing is safe;
switching pulls the tree out from under them.

**`services/deploy-bot/` and `render.yaml` belong to another session.** Read
them if you must; never edit.

**Jira moves in the same turn as the push.** In Progress when work starts,
Testing when committed, Deployed when live with evidence; *Done* is the
owner's alone. The owner has caught this lapse three times. Verify the
transition landed by re-reading the status — a naive loop stalls at In
Progress, so walk the board's order one step at a time. Comments are for a
non-engineer: what was wrong, what it does now, what it cost, what is open.

**Useful helpers**, written this session, in the session scratchpad (they do
not survive; rewrite from these notes if you need them): a Render service and
env-var lister, a deploy waiter that polls until a commit is live, and a Jira
status walker. Credentials come from the gitignored `.env` and are never
printed.

---

## 7. The recurring defect, stated so it can be checked

Five tickets in a row shipped **a service with no caller**, and each time the
tests passed because each test mirrored **one side of a seam**: S2-04's fleet
API while both front ends called it; S2-05's station-session document; S2-06's
offline unlock and a preview URL no browser could resolve; the anomalies
panel's missing route.

Two rules came out of it and they hold:

- **A service with no caller is not built.**
- **A test that talks to the server directly does not prove a browser can
  reach it.** The booth's seam tests drive the real page, the real outbox and
  the real route, and no envelope is hand-written anywhere — which caught,
  immediately, that the plan named a fact type the box does not send. Every
  real voucher would have been quarantined as an unknown type.

And the related one, which has now been found in **fifteen consecutive
reviews**: a comment or a test asserting a guarantee the code does not give.
Sweep for "never", "cannot", "always", "the same", "only". Measure each.

`POS_GAP_REGISTER.md` §6 proposes rules that can be checked rather than
intentions — an assumption must carry a Jira key or a closing commit,
verified by a grep in CI, and **no comment may cite a document as a reason
not to build something**; cite a ticket, which has a status. The comment that
left a live member form wired to nothing cited `CLAUDE.md` §6.

---

## 8. Work in flight when this session ended — READ BEFORE TOUCHING THE TILL OR THE BOOTH

Two workflows were building when the session wound up, and **their code is
on disk, uncommitted, and may be half-written.** Nothing of theirs is
committed, so `main` is clean and green — the working tree is not.

**First thing to do: find out what state it is in.** `git status`, then
`pnpm turbo run typecheck` and `pnpm turbo run test`. If it does not build,
the fastest honest route is `git stash` (never `git checkout --`, you would
lose the lot) and rebuild from the design below, which is complete.

### Where the real record is

Both workflows persist to disk and **survive this session**:

| | |
|---|---|
| Their scripts, carrying the full brief and every design decision | `~/.claude/projects/C--Users-waqar-OneDrive-Desktop-Projects-oto-pos/317fcfce-2754-44c9-bec5-9a762ab18d03/workflows/scripts/s2-09a-sale-ledger-wf_62d14e91-eb9.js` and `…/s2-07b-booth-admin-wf_a761b608-c23.js` |
| What each agent actually did and returned | `~/.claude/projects/c--Users-waqar-OneDrive-Desktop-Projects-oto-pos/317fcfce-2754-44c9-bec5-9a762ab18d03/subagents/workflows/wf_62d14e91-eb9/journal.jsonl` and `…/wf_a761b608-c23/journal.jsonl` |

**Read the journals first.** One `{"type":"result"}` line per completed
agent, carrying its whole report — what it built, what it measured, what it
could not do. That is worth more than re-deriving from the diff. The scripts
can be re-run with `Workflow({scriptPath, resumeFromRunId})`, but **resume is
same-session only**, so in a new session treat them as documentation, not as
something to replay.

### SCRUM-203 — the ticket cart and the sale ledger (the biggest gap)

**What it is for.** The till reaches "Pay ฿1,440" and nothing after Pay
exists: no sale recorded, no tender recorded. `sale` and `sale_line` were the
empty Sprint 1 placeholders in `future.ts`; the POS's `recordSale` pushed
into an in-memory array and a refresh lost it. **The park could take money
and the platform would hold no record of it.**

**The design, decided and not to be relitigated:**

- **Migration 0014** replaces the placeholders. A sale must carry, on day
  one, the things that cannot be added cheaply later: operator, branch,
  station, box; the **business date** resolved from the branch's
  `business_day_start` (a sale at 00:30 belongs to the day that is
  finishing, not the calendar day); the pricing mode that applied and which
  holiday if any; **the member's tier at the time of sale**; totals split
  into net, VAT and service charge rather than one number, so a receipt is
  reproducible years later from the row alone; the account that rang it up;
  the receipt number; and a lifecycle column so a void or refunded sale is
  distinguishable from one that never happened (refunds themselves are
  S2-11 — build the column, not the feature).
- A line carries what was sold, quantity, unit price, the tier, **the
  adult/child split and free-adult allowance that produced it**, any
  discount with its reason, and the tax for that line.
- **The till mints the sale id**, so Pay pressed twice through a dropped
  connection is one sale. The constraint must say so.
- **One pricing engine.** The quote endpoint prices with
  `packages/shared` — the same engine the booking site uses. Before this, the
  tested engine (~1,600 lines, 1,694 lines of tests) had exactly **one**
  caller and the till priced in the browser in baht floats from the
  prototype's copy. They agreed because both are ports of the same rules;
  they were still two engines and the tested one was not the one taking
  money. SCRUM-226 is what that cost.
- **The price charged is the price the platform quoted.** If the till sends
  its own totals, compare and refuse on a mismatch. A server that trusts a
  client-supplied total is a discount anybody can give themselves.
- **The tier is resolved server-side** from the member, never taken from the
  body.
- **A ฿0 sale finalises like any other** — an acceptance criterion, not an
  edge case: a fully comped visit still leaves a record.

**Out of scope, deliberately:** how it was paid (S2-10a), the receipt print
and refunds (S2-11).

**The seam to prove:** a sale rung up through the built till lands as a row
with every column right. A test that posts to the route and asserts a row is
only half of it — five tickets here shipped a service with no caller.

**Where to resume: check out `wip/s2-09a-sales-ledger` at `4a34037`.** All
three slices are there — schema, till, service+routes — and nothing of it is
on `main`. Answer blocker 1 with S2-10a's tender design in hand, fix 2 and 3,
then merge; they are the only things between this and deployable.

What is already proved: the arithmetic (69/69 carts on the till's own check),
28 api tests driving the real routes with a real session and reading the rows
back, the till's payload shape accepted as it is actually sent, and migrations
twice from empty.

**The sync and box changes that were sitting beside it in the tree are now on
`main`** at the commit after `14201bc` — they were the booth's two PIN fixes,
described in `14201bc`'s message but missing from its file list, which turned
CI red until they were committed separately. If you diff the branch against
main and see them missing there, that is why.

**CHECKPOINTED, so none of it can be lost: branch
`wip/s2-09a-sales-ledger` at `4a34037`, pushed to origin.** It carries the
whole slice — migration 0014, the schema, the service, the routes, the till,
the tests and these documents — and **only** that slice: the sync and box
changes still in the working tree belong to another workstream and
`render.yaml` and `services/` to a third, so they were left for their owners.
It is a branch and not `main` on purpose: `CONTRIBUTING.md` says main is
always deployable, and a till that refuses every paid sale is not. The
working tree was not touched and `main` still points at `14201bc`, so the
other two workflows carried on undisturbed. Continue on that branch.

**An integration check then drove a real server on a real port with the till's
own commit body and read the rows out of Postgres. It found the seam, and it
is one boolean wide. FIX THESE THREE FIRST — do not deploy this as it stands:**

1. **A paid sale cannot be recorded.** The till sends `finalise: true` on every
   commit (`apps/pos/src/api/sales.ts:802`); the service refuses to finalise a
   sale that still owes money (`services/sale.ts:1169`, because `outstanding()`
   returns the gross until tenders land in S2-10a). Live: the till's verbatim
   body for a ฿1,440 admission → **409 `SALE_NOT_PAID`, zero rows**. The same
   cart with `finalise: false` → one row, two lines, audited. Only a ฿0 comp
   goes through. And the panel tells staff *"Trying again will not help… go
   back, check the order, call a manager"*, because `isRetryable()` reads a 409
   as a judgement about the cart. The comment at `api/sales.ts:170` claims
   "฿0 comps and paid sales both finalise here"; they do not. **Decide which
   side moves** — the till sends `finalise: false` and the sale waits in
   `tendering` without a receipt number, or `outstanding()` counts the till's
   `paymentMethod`. It is a decision about when a receipt number is allocated,
   so it belongs with S2-10a's design, not to whoever is fastest.
2. **After any refusal the cart can only be sold by discarding it.** The sale
   id, and the idempotency key `sale:<id>` derived from it, are minted once per
   Pay press and cleared only by `reset()`; `handlePaymentBack`
   (`Till.tsx:1672`) does not clear them. So *Back to the order* → fix the
   order → Pay → **409 `IDEMPOTENCY_MISMATCH`**, for ever, and Cancel is the
   only way out. Mint a new sale id whenever the cart changes after a refusal.
3. **A branch-scoped account can write a sale at another branch.** `POST
   /sales`, `POST /sales/quote` and `POST /sales/:id/finalise` declare their
   permission with **no `target`**, so the scope is never checked against
   `cart.branchId`. Driven as seeded reception (HKT Central only) against a
   second branch: quote 200, commit 200, row written at the other branch on its
   own station — and then `GET /sales/:id` refuses the same account 403, which
   is the proof the write should have been refused too.

Smaller, from the same run: `sale_line.revenue_category` is NULL on every row
(S2-09a's own acceptance criterion says the Sale detail view shows it
populated; the schema defers it to S2-09b); and **removing a holiday now
fails** — `sale.holiday_id` is `ON DELETE restrict` while
`DELETE /branches/:branchId/holidays/:id` hard deletes, so once a sale exists
on a holiday date the admin panel raises an unhandled Postgres 23503.

What that run *did* prove, by reading the rows: quote total equals the stored
`gross_satang` on all thirteen shapes (weekday, a holiday range as weekend,
three tiers, free adult, overflow, socks, fixed and percent staff discounts, a
promo code, ฿0 comp); the tier comes from the member even when the body lies;
the business date, day start, timezone, station, box, account, pricing mode,
tax snapshots and the four-way money split all land; two presses make one sale
and an aborted connection makes one; underpaying is refused; no session is
401; the freeze trigger fires; a six-hour clock skew is recorded as `skewed`
and cannot move the trading day.

### SCRUM-200 — the booth admin panel

**What it is for.** The wheel runs on a seeded prize list; this is where a
manager changes prizes, odds, daily caps, expiry, layout, the button key and
who may sign in — and publishes.

**The design, decided:**

- **Publishing is the heart of it, and a published version is immutable.**
  Publishing mints a new version; the box picks it up by version, about a
  minute later, and applies it **whole and only between spins**. Editing a
  published bundle would change what a spin that already happened was drawn
  from — `booth.spin` records its version for exactly that reason.
- **Validate before publishing, not after.** Weights are integer basis
  points summing to **exactly 10000**; every prize needs a voucher
  definition; a prize cannot be active with no expiry. A booth running an
  invalid bundle hands out wrong prizes and cannot tell.
- **Refuse a publish that leaves the wheel unplayable** — every prize
  inactive, or every prize capped. The draw handles that state correctly by
  accident; publishing it deliberately is different.
- **The Console shows real percentages, not basis points**, with the running
  total and what each prize costs at its chance. A manager should never do
  that arithmetic, and "what does this wheel cost me a day" is the first
  question the owner will ask.
- **Show what is about to change before Publish takes effect.** It is a live
  change to a machine in a public place.
- **A PIN must never travel on the box command queue** — its payload is
  stored and rendered on a Console screen. That is why S2-07a deliberately
  left badge and PIN out of the simulator panel. Any PIN management here
  needs a path that does not store what it carries.
- It registers its routes **inside `apps/api/src/routes/booth.ts`**, not in
  `app.ts`, to stay clear of the sale work.

**The seam to prove:** change a weight in the Console, publish, and watch a
**real** box pick that version up and draw from it. Asserting a row landed is
not the ticket.

### File ownership these two were working to

Keep it if you resume both; it is what let them run together.

| Workflow | Owns |
|---|---|
| Sale ledger | `packages/db/migrations`, `schema/{sales,future,index}.ts`, `apps/api/src/services/sale.ts`, `routes/sales.ts`, `app.ts`, `apps/pos/**`, `packages/shared` cart code |
| Booth admin | `apps/api/src/services/booth-admin.ts`, `routes/booth.ts`, `apps/console/src/pages/Booth*`, `components/booth/**` |

## 9. Known gaps in our own tooling

- **`apps/pos` has no unit-test runner** — no vitest, no `test` script, two
  Playwright specs. And **`apps/pos/**` is in eslint's ignore list**
  (`eslint.config.mjs`, "linted separately later" — it never was). So the
  compiler is the only automated check on the till. That is how a child's
  price sat on the Adults row for a whole sprint. Standing vitest up there
  and covering `lib/pricing.ts` and `lib/pricingMode.ts` first is cheap and
  overdue.
- The lifted OTO App carries ~586 pre-existing typecheck errors. Establish
  the baseline before and after any change there; do not try to fix them.
- CI has twice been red for a reason nobody noticed: a lockfile that was
  never committed, and a rasterising test hitting vitest's 5s default. Check
  `gh run list` after pushing, not only the local suite.
