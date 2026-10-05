# Sprint 2 progress

## Platform checkpoint - 6 October 2026 - Other tender

**6 October 2026, SCRUM-495 Other payments verified:** Used payment methods may be archived after the prototype warning. Other has its own ledger classification and is supported through the till, box restart/replay, refunds and End of Day without a cash drawer action. Review added configured/enabled/matching-kind guards and refusal of cash-shaped Other payloads; already-recorded offline Other remains replayable after later disable. Forward migration0060 only expands the payment-method check; schema verification passes. Root checks: initial API77, follow-up API65 (including legacy pricing replay), POS114, shared24, box35, DB shape/migration18 pass; all five touched package typechecks, lint and POS build pass. API/POS905fe6c0 are live for History. Pricing screenshot11275 is attached; phone History review is being captured. SCRUM-495/493 remain In Progress. SCRUM-496 stock entries31-39 started independently; Add time0061 and stock0062 are allocated to their workflows. CI905fe6c0 is running; the superseded63d7307e run was cancelled after its known registry issue was repaired.

## Platform checkpoint - 6 October 2026 - History and corrected orders

**6 October 2026, SCRUM-495 History verified locally:** Desktop and phone now share real sale actions, with the prototype phone detail/refund/reprint flow and date filters. Corrected orders recover stored ticket/F&B inputs, notes, modifiers, sizes and the exact linked band context; paid supervision and already-served prepaid items require explicit re-entry/reselection. Root checks: POS 128 and API 49 tests pass, API/POS typechecks, changed-file lint and POS build pass. The first pricing/input slice 4adb82c7 is live on API/POS; History awaits deployment and screenshots. The Other-payment slice is ready for integration with migration0060; Add time backend/UI are separate workflows, migration0061 reserved. Wallet/payment display parity is underway. SCRUM-493/495 remain In Progress; SCRUM-215 waits for CI after registry repair944646e7.

## Platform checkpoint - 6 October 2026 - settlement route registry repair

**6 October 2026, settlement CI registry repair:** CI37377006485 failed three conformance assertions because the terminal-run and authenticated box callback were missing from the explicit route/ID registries. Their existing retry contracts were verified and documented in those registries; all 30 affected checks pass. No runtime route or financial behavior changed. API typecheck and scoped lint pass. The final EOD staging evidence remains valid; SCRUM-215 stays Testing for a fresh successful CI run.

## Platform checkpoint - 6 October 2026 - SCRUM-495 pricing and till parity

**6 October 2026, SCRUM-495 first verified slice:** Manual percentage discounts use the prototype whole-baht rounding; fixed discounts, promos and taxes retain their existing policies. Versioned offline replay preserves earlier satang-priced sales and quarantines unknown future engine versions before writing money. The exact three document choices, retained promo inputs, cash confirmation wording, kitchen order notes and stock guidance are restored; the inert badge/PIN unlock field is removed. Root verification: shared pricing 131, POS 87, API 57 and box 37 existing tests pass; all four package typechecks, changed-file lint, POS production build and diff check pass. This source is not yet deployed. SCRUM-495 remains In Progress for History, payment methods, Add time, wallet and shop-display work. The owner approved both Add time modes. EOD source 63d7307e is staging-verified; CI remains pending.

## Platform checkpoint - 6 October 2026 - complete settlement CSV

## Platform checkpoint - 6 October 2026 - final export proof

**6 October 2026, final End of Day staging proof saved:** API and POS 63d7307e are live. The actual all-payments CSV download contains three approved simulated card/QR rows, including the gateway invoice with blank TID; reviewed screenshot 11-staging-all-payment-export.png is attached to SCRUM-215 as 11274. The temporary QA manager grant was revoked; the isolated box was disabled and archived, its station/three devices and park archived. Financial/audit records and prior unresolved payments remain. SCRUM-215 stays Testing pending CI37378514082; no green CI claim. SCRUM-493/495 remain In Progress. The owner approved both selected/scanned-band and count-only Add time options, recorded on 495/497. Next: finish CI gate, then land verified SCRUM-495 slices and continue the remaining mismatch groups.

## Platform checkpoint - 6 October 2026 - complete settlement CSV

**6 October 2026, complete settlement export verified locally:** The all-card-and-QR CSV now includes approved till gateway payments with no terminal ID and preserves per-TID exports. Existing API checks 9/9 and POS 21/21 pass; API/POS/shared typecheck, lint and POS build pass. Sequential print raster files pass 268/268 without changing test assertions or timeouts, addressing two repeated CI worker-reporting timeouts. Final staging cards 11271-11273 cover cash movement, discrepancy/corrected close, Health, Activity and the live import job. Next: deploy API then POS for all-payments export, capture its three-row fixture CSV, archive only the QA fleet/revoke the temporary QA grant, then complete SCRUM-215 when final verification is green. SCRUM-493 stays In Progress; SCRUM-495 pricing/proof/UI and History/tender slices are progressing in isolated worktrees. The partial Add-time band selection question is recorded on SCRUM-497 and in docs/qa/scrum-493-open-decisions-2026-10-06.md.

## Platform checkpoint - 6 October 2026 - fixture import job and CI contract

**6 October 2026, final End of Day follow-up:** API/POS/Console 581c7c4a are live. The isolated QA park recorded a witnessed THB100 safe drop and approved THB60 paid-out; a THB50 count difference was corrected before the day closed with expected/actual minus THB160 and its own receipt. The Health demo control is visible; its mutations remain tested on disposable databases. The fixture importer now runs as an actual on-demand operations job with atomic import/audit/run success, harmless replay and safe failure recording; 8 affected API tests pass. CI37373685349 exposed a missing settlement-line parent mapping in the schema contract (fixed; 14/14 checks pass) and a print-worker reporting timeout. Current CI is not green. Next: deploy the import job, capture final Activity/Health/close and job evidence, finish QA cleanup and SCRUM-215 closure, then land SCRUM-495 prototype parity with versioned offline rounding compatibility.

## Platform checkpoint - 6 October 2026 - End of Day settlement proof

**6 October 2026, settlement evidence saved and final End of Day source verified:** Real staging cards 11268-11270 prove simulated terminal matching, pending-payment confirmation without changing its payment time, filtered CSV, fixture import/replay, immutable closed totals and automatic receipt refresh. Round-4 demo scenarios now include real wallet, voucher and partial-refund records with concurrent/repeated seed safety; the guarded Health control is covered by existing disposable-database tests. EOD/ops tests pass 52/52 and POS lane/receipt checks 23/23; touched package typechecks, scoped lint and both frontend builds pass. The park-switch race is fixed locally. Next: land/deploy this verified slice, capture Health and corrected park-switch screens, finish cash-movement/closing audit evidence, then complete 495/496/498 and retain prototype defaults for 497. SCRUM-215/493 remain In Progress; 495 has started in an isolated workflow. SCRUM-214 also has undeployed analytics child216 and must remain open. Current main CI37373685349 is running, not green.

## Platform lane checkpoint - 4 October 2026 - SCRUM-499 fixed-code vouchers landed

At the user's request (the owner wants the Lucky Wheel live with Papaya codes
before the new till is): a voucher type can print one fixed code on every
slip (migration 0055: voucher_definition.code_mode / fixed_code; voucher source
'fixed'). The box prints and shows the fixed code (cache carries fixedCode);
the till redeems the code against the type (a 'fixed' row minted at the hold,
window and limits as for any voucher); code batches refused for fixed types;
Console editor "Code on the slip". Tests: vouchers + definitions 117, db 160,
box-agent 679. Then: deploy staging, evidence, then the box update at the
park. End of Day round 2 is now on wip/eod-round-2-inflight (13f7b3c6) and
must renumber its migration to 0056.

## Platform lane checkpoint - 2 October 2026 (late night) - HAND-OVER POINT

The local session winds up here. Resume from docs/handover/CLOUD_HANDOVER.md
(sections 2, 3 and 10).
- main and staging: 9a14af81, CI green, migrations through 0054.
- SCRUM-494: Testing. All nine items on main and on staging. Evidence half
  done: item 1 no-expiry WORKS, and its expired half shown as a test-run card
  (no way to record a past expiry on staging); item 2 WORKS (T1-000055);
  items 3-9 to capture.
- SCRUM-215: round 1 on staging; round 2 partial on
  wip/eod-round-2-inflight (migration 0055, provisional, stranded, receipt
  server side), brief in docs/progress/plans/cash/ROUND_2_BRIEF.md; rounds
  3-4 to do.
- Then SCRUM-495, SCRUM-496, SCRUM-498; then S2-15b.

## Platform lane checkpoint - 2 October 2026 (night, 4) - SCRUM-494 all nine entries on main

Entries 1-3 (member tier: expiry optional everywhere incl. the box offline
and walk-in claims, migration 0054; the tier staff pick honoured; full-scope
refund restock once) and 8-9 (band safety data and prepaid meals at F&B and
Shop) landed together after three fix cycles (workflows wf_7e59b225-3d6,
wf_432e37cc-cac; final review MERGE, 63 files). Nothing is both refunded at
pickup and served; a late payment after pickup sets the prepaid line aside;
a card-approved counter confirm sets a used-up line aside (a box replay
records it served short); box registrations get the same prepaid checks
(mismatch quarantined with an alert). Tests: api 358, box-agent 679, db 160,
tsc x5, eslint clean.
Follow-ups: SCRUM-498 (box lane band details and prepaid offline), SCRUM-497
questions. Next: deploy staging, SCRUM-494 evidence for all nine, then End
of Day rounds 2-4.

## Platform lane checkpoint - 2 October 2026 (night, 3) - SCRUM-494 gate access landed

SCRUM-494 entry 4 (workflow wf_50f6dbb9-910, MERGE): each adult band
carries its ticket's Gate access from the moment it is issued (online, at
the till, and offline on the box), the gate refuses an adult band without
it as it refuses kids' bands, and occupancy counts such a band with its
group, as the design does. Migration 0053 (renumbered from 0054: no 0053
was needed by the food unit). eod-r1-migration no longer asserts 0052 is
the newest. Tests: db 157/157, box-agent 677/677, api gate suites 27/27.
CI on 4fc79674 red, two causes, both fixed: packages/db migration suites
ran files side by side against one Postgres (now --no-file-parallelism in
its test script; 160/160 locally), and a vouchers.test.ts burst race (a
request refused before its till locked names the person; both end
together; 102/102 three times).
Questions for SCRUM-497: the reader's wording for a no-gate adult; such an
adult shown under kids on the occupancy chip (design behaviour); refused on
exit as kids are.
Entries 1-3 (money) MERGE and 8-9 (food) one blocker: a fix round runs,
then both land together (shared sale.ts).

## Platform lane checkpoint - 2 October 2026 (night, 2) - staging deployed; End of Day round 1 evidence

Staging was still on 35a8ed68 (deploys do not follow main). Deployed all
five services at 6b5f08f8 (render.mjs deploy all). On staging as Khun Lek
at Reception Till 1: Today > End of Day reads the day (cash expected
B360), one whole-branch count with the B6,000 float; a ZZ TEST paid-out of
B60 approved by Khun Anan took expected cash to B300. Card attached to
SCRUM-215 (stays In Progress: rounds 2-4 remain).

## Platform lane checkpoint - 2 October 2026 (night) - SCRUM-494 check-in and phone till landed

SCRUM-494 entries 5, 6, 7 (workflows wf_f85be821-c40, wf_3654455e-4e4,
both MERGE; check-in after three cycles): the phone till redeems a
booking once through the platform (shared lib/bookingRedemption.ts, the
desktop unchanged); the Drop-Off/Nanny service paid on the cart line is
applied at check-in on the platform, on the box and on replay, with the
nanny check; the phone board, release, registration, waiver, hand-over
and paid check-in all run on the platform. 18 files.
Open (prototype behaviour kept, for SCRUM-497): "Leave as booked" keeps
the registration's service; the phone's "Mark Arrived" opens the
payment-free booked check-in.
Still running: food counters (entries 8-9), then gate (4) and money
(1-3). End of Day rounds 2-4 follow SCRUM-494.

## Platform lane checkpoint - 2 October 2026 (evening) - End of Day round 1 landed

S2-15a round 1 (SCRUM-215), built to the revised plan and gated MERGE
after one fix cycle (workflow wf_a80cd2d3-559): migration 0052
(pos.end_of_day, pos.cash_movement); services/end-of-day.ts and
routes/end-of-day.ts (day record from payment attempts and refunds by
business date, one combined cash count, float carry-over or B6,000, B1
per line, server re-derives at close, second close 409, closed day
frozen, any pos:cash:day_close holder closes, paid-out with approver and
safe drop with witness reducing expected cash, audit, idempotency); the
POS End of Day tabs on the API with the prototype's look; a Cash action
on the station header (UI addition) and the day's movement list.
Tests: API 94/94 (eod-r1, gate, recheck, wallet, id-conformance,
demo-reset), shared 478/478, in-package tsc x4, eslint on the list.

Open points for the owner, defaulting as built: the approver/witness is
named, not signed with their own PIN; staff role may close (prototype:
anyone); no paid-out or safe drop on a closed day; a refund comes off the
tender it was actually paid back through.
Note: packages/db migration suites need --no-file-parallelism locally.
CI on 320c396d: 2415/2415 tests passed but the run failed on one unhandled
57P01 at teardown: eod-r1-gate-recheck stopped the test server without
closing its own pool first. Fixed (ctx.close() before teardownAll), the
only test file missing it.

NEXT (priority): SCRUM-494, then End of Day rounds 2-4.

## Platform lane checkpoint - 2 October 2026 (late, 2) - till consistency register

Each delivered area was compared line by line with the approved till
design (imports/oto-pos), so the whole till follows one set of rules:
docs/progress/plans/consistency/REGISTER.md (65 entries). Story
SCRUM-493 with four subtasks:
- SCRUM-494 (High, first): band details at food counters (allergies,
  food permission, prepaid meals), the phone till's redemption, Gate
  access on adult bands, the Drop-Off/Nanny change, phone-size check-in,
  the full-refund restock, the tier expiry and the tier pick.
- SCRUM-495 / SCRUM-496: 34 details brought back to the design.
- SCRUM-497: 22 details for the owner to confirm; the design's behaviour
  stays unless the owner chooses otherwise.
Planning rule (memory oto-prototype-rules-not-bugs): a plan changes only
data reliability on its own; every rule choice is confirmed first, with
the design as the default.

PRIORITY (2 Oct): S2-15a round 1 (workflow running) -> SCRUM-494
immediately -> S2-15a rounds 2-4 -> SCRUM-495 -> SCRUM-496, before any
other story, applying SCRUM-497 as confirmed.
Then S2-15b and the agreed order (SPRINT_2_PLAN execution order).

## Platform lane checkpoint - 2 October 2026 (late) - S2-15a re-planned to the owner's ruling

SCRUM-488 ruling (Tony, 2 Oct, via Antonie): count all drawers together
as one combined total for the day; for everything else follow the
existing End of Day process (the prototype's Today > End of Day, which
SCRUM-214 names as its source) and do not invent parallel rules unless
something is clearly missing or broken.

Done: the per-drawer round 1 (workflow wfg37uw41) was stopped before
landing and saved on branch wip/cash-round-1-per-drawer (010fabfc), for
reference only. docs/progress/plans/cash/PLAN.md is rewritten
prototype-first: one combined count per day, float carry-over or
B6,000, B1 tolerance per line, any signed-in staff member may close,
close allowed with off/pending lines, closed day frozen, refunds on the
original sale's day, credit as its own line inside the totals. Fixed
only where the prototype is clearly broken: branch leak, UTC day, card
TID by hash, NO-TERMINAL drop, nothing persisted, non-till money. From
SCRUM-215 where the prototype has nothing: paid-out (approver) and safe
drop (witness) against the day, provisional close, stranded occupancy,
EOD receipt, audit, settlement.

Working tree note: the tree still holds the stopped per-drawer files
(untracked cash.ts, 0052_cash_sessions, cash-r1 tests). Round 1 is
rebuilt from origin/main; do not land those files.

Next: round 1 of the revised plan (migration 0052 end_of_day +
cash_movement; End of Day service and screens on real data; Cash
action). Migrations landed through 0051.

## Platform lane checkpoint - 2 October 2026 (night) - S2-14 wallets and stock DEPLOYED

The story SCRUM-211 (S2-14, wallets and stock) is Deployed: both subtasks
closed with staging evidence (docs/qa/jira-comments/attachments/SCRUM-212
and SCRUM-213, seven cards each).

S2-14a wallets (SCRUM-212): plan docs/progress/plans/wallet/PLAN.md;
rounds 966e77a9, bc09ec24, bbe30fcd, 1f117138, 463d78e9; CI repairs
e9e22ec9 and 08bbdb73; walkthrough fixes 8a58ad4c. The ledger is the
truth; the platform writes the wallet tender (never the drawer, never
takings); last-baht race; wallet-first refunds; same-day expiry with
audited reactivation; B300/day offline cap with the overdraft anomaly;
promotional vouchers. Migrations 0045-0047.

S2-14b stock (SCRUM-213): plan docs/progress/plans/stock/PLAN.md; rounds
27c0651e (ledger + sales, 0048), af0bb635 (stock screens), 6bdca9a7
(offline, 0049), 50bcea40 (reports + trend rule, 0050); walkthrough
fixes 35a8ed68 (per-place opening decided under the locks, Alerts from
the platform, 0051). Staging walkthrough: opening counts, guard
refusals, sale T1-000052 + refund T1-R-000004 once, transfer, PO
received in two deliveries, the platform's low-stock list with its rule,
reports from the ledger, offline sales T1-000053/54 with the box
refusing an oversell; level == sum(movements) everywhere. Known bound:
the daily stock fact is rewritten for the last 7 days only.

Also Deployed in this arc: SCRUM-486 (High: the box adopts the
platform's era durably; no offline sale lost) with a test-run card.

Open tickets from the arc: SCRUM-481, SCRUM-482, SCRUM-485 (owner
rulings); SCRUM-483, SCRUM-484, SCRUM-487 (small fixes). Still waiting on
the owner: SCRUM-480 (R2 CORS for photos), Xero, 2C2P sandbox, pricing
rulings, SCRUM-467, SCRUM-469.

Working rules now standing (memory): CI watched by exact commit SHA;
eslint over every landing list before push; every gate handover actioned
the moment it is read (brief or ticket); every workflow agent on Opus 5.5
while the Fable limit is spent; docs-only commits trigger no CI; the
progress update rides in the same commit as each landing.

Next by the agreed order: S2-15a (cash sessions, End of Day
reconciliation per tender and terminal, settlement export -
SPRINT_2_PLAN.md line 2290). The wallet work left it a correct
countsAsTillTakings (wallet and paid-online are never till takings) and
business_date on every payment attempt. Then S2-15b, S2-23, S2-22, S2-16;
S2-24 rolling.

Migrations landed through 0051. To resume: read this block, then the
latest Jira story comments, then `git log main`.

## Platform lane checkpoint - 1 October 2026 (evening) - S2-13 Deployed whole

This is the platform lane's block (the Codex lane's release checkpoint
follows below and is untouched).

S2-13 (SCRUM-210, child check-in and supervision) is Deployed whole: all
four rounds landed (11fce4cb, 5b22d7aa, a3eaa307, 403bb5ae + efd7649c),
migrations 0043 and 0044, CI green on every landing, and the staging
walkthrough driven end to end with six evidence cards attached to the
ticket. Proven live: the kids-only gate with birthday ages and display
consent (phone stored E.164 as typed), the fee law to the satang (flat
225 drop-off, 330/hr nanny billed once), the on-shift roster refusing
Aor, cash receipt T1-000039 and the one-stroke check-in with bands, the
live board with countdown/allergy/honest contact chip, occupancy "kids
2 adults 0, no gate reporting", the R-92 release photo rule holding, and
the WHOLE flow repeated offline (T1-000040, bands T1-8GWRQ5/T1-KX67PV
minted on the box, synced exactly once after reconnect). SCRUM-478 is
also Deployed: the server itself now refuses a kids-only sale without a
registration (409 proven by direct API on staging).

Owner actions and residuals: SCRUM-480 (High) - the staging R2 bucket
has NO browser CORS rule, so every photo upload from the till fails; one
Cloudflare dashboard setting fixes it (production will need the same).
SCRUM-479 - the mobile drop-off board still runs on demo data.
SCRUM-477 stays open for its staging captures and one recorded one-line
fix. Staging received a seeded nanny roster (Pim/Jum/Bow on 14 days of
shifts, Aor off) via a one-off job; walkthrough fixtures were cleaned,
the two completed ZZ TEST families remain as audited records.

Next by the agreed order: S2-14a (wallets - cash-up must use
countsAsTillTakings), then 14b stock, S2-15, S2-23, S2-22, S2-16;
S2-24 rolling. Waiting on the owner: Xero, 2C2P sandbox credentials,
card-refund default, pricing rulings, SCRUM-467 observations, SCRUM-469
go, and now the SCRUM-480 CORS setting.

Migration chain landed through 0044. Resume rule for a fresh session:
read docs/progress/plans/checkin/PLAN.md section status via Jira
SCRUM-210, then git log main.

## Release checkpoint - 30 September 2026 - break checkpoint saved

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

## Previous checkpoint

## Status

_Current checkpoint: 2026-09-29 - saved-child display review._

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

The earlier releases below are retained as history.

The Lucky Wheel bench test and walkthrough are complete. Sprint 2 resumes
with SCRUM-391, SCRUM-388 and SCRUM-382 landed on main at `b02f7e0`, then
SCRUM-206 Slice F. All three prerequisites are Deployed in active sprint id 3.
The common writer reserves unresolved money; unavailable configured methods
refuse, with offline facts retained for correction and Replay; the till-facing
QR route honours the station's saved setting and returns QR/expiry metadata.
Seven existing API files pass 196 tests; API typecheck, changed-file lint and
independent review pass. No new suite, migration or dependency. The first two
commits are e333994 and c0aefae; routing is b02f7e0. Main CI 36486990526 and
branch CI 36485272336 are green. API, POS, Console, Launcher and Booth are live
on b02f7e0 after one deployment; the OTO App remains c416065.

All 21 staging behaviour checks passed after the resumed instruction authorised
the scoped proof. Six reviewed screenshots are attached as 10855-10860; the
native Console/POS captures and labelled API cards are saved with the report
in docs/qa/payment-prerequisites. Proof configuration was disabled or archived;
test sales remain in audit history. The three tickets are Deployed.
Read the newest STOP POINT in `SESSION_HANDOVER.md`.

Slice F foundation `2f694e1` is deployed on main `5fb8525`: shared cloud
payment client, partial-state handling, separate stable tender identities,
explicit zero-tender closing and stale-response guards. All 38 existing-file
tests, POS typecheck, package lint and independent review pass. UI source is
pushed as `cf67d86` on `feat/payment-stage-ui`, with four till adapters and the
mobile food-station caller. The existing writer suite passes 53; POS typecheck,
package lint and production build pass; branch CI 36523891229 is green.
This branch has not deployed and native staging UI proof is pending. The
inquiry/confirmation response-envelope and
atomic print follow-ups are under SCRUM-387, with 147 affected tests passing.
SCRUM-452 adds a ten-second wheel default and Console control for whole seconds
from 2 to 20 through the existing publish flow. Its 84 existing-file tests pass;
touched package typechecks and lint pass. Both parts deployed together on
`5fb8525`, main CI 36521266122 green. Both are Deployed after six replay and
nine duration checks passed. Reviewed Jira evidence is attached as 10861-10867.
The duration proof used native staging assets on an isolated local box and
verified online twelve seconds, offline restored twelve and default ten,
printing at the visible reveal. Existing booth versions are unchanged.
The verified Pi release pair is on the Desktop; see
`docs/qa/booth-spin-duration/README.md` for its checksum and Update requirement.

Slice F also depends on the existing offline transport work (269/285) and
S2-08 for separate-device display acceptance. Simulator payment evidence and
real 2C2P sandbox evidence must remain distinct.

### Historical status - 25 September

_Last updated 2026-09-25, 23:34._

> **Resuming? Read `SESSION_HANDOVER.md` → "2026-09-24 — closing S2-09", then
> "State at the end of 2026-09-23".** It carries the live commit on every staging service, what landed
> today, what is in flight, every open defect with its key, the owner decisions
> outstanding and the recommended next order. `TICKET_REGISTER_2026-09-23.md`
> has the ticket-by-ticket evidence. This block is the summary; those files are
> the detail.

- **Current checkpoint.** The booth is **ready for the owner's bench test** (25 Sept,
  10:14): four slices, the closing audit's fix round and its staging proof landed;
  the Pi release at `8ffe856` is with the owner; SCRUM-401…430 are the follow-ups.
  CP1 passed; the sprint is inside **S2-10 (payments)**,
  and **S2-09 is closed** — SCRUM-202, 204 and 392 Deployed on the 24th at 06:27
  (392, the scan stream held back by the POS site's rewrite, fixed at `003dac7`
  and proven on staging). CP2's remaining line is
  SCRUM-206's own end-to-end evidence, which waits on Slice F.

- **Last landed.** `main` is **`3cc8963`** — SCRUM-403 (a damaged store no longer kills the
  booth, `e33bf12`), 440, 442, 422's e2e switch, 423's second case; before them the night batch (the Linux CI fix at the root,
  SCRUM-406 migration 0024, SCRUM-408's till runner, 438, 439, 423's case; `fae4b71`…`2160f3a`),
  then the evening's quick rounds (SCRUM-433, 430, 437,
  436, 431, 422's CI naming; `2246aef`…`2ae20a8`), then SCRUM-402 (the Pi's clock, `7b360cd`) and
  SCRUM-401 (promo codes priced by the platform, `4dfcb34`), then the audit's follow-ups as quick rounds on
  25 Sept (SCRUM-409, 411, 413/427, 417, 418, 414, 430/424, 420, 429; `494b6d6`…`f851037`,
  proof images `e7c3c80`; eight of them Deployed on staging proof), after
  the CI pack step (`cf9b9df`) and the printer guide (`a34acb0`). Before them, the
  closing audit's fix round, eight commits by lane (`79a1c0e`…`4d0e24e`: the void offer and History's Void, the
  hand-over prize at ฿0, the booth prefix rule, the bounded press and the
  silent-printer give-up, the expiry at the end of the printed day, the PIN lock
  under a burst, the Console's prefix field and honest hints, the guides and the
  counter guide). Before it, the booth's round 2: `c4f8b4e` (the
  till redeems a voucher: scanned by the box, typed, or read by a USB scanner;
  held, priced by the platform, used up at payment; the platform's own
  refusals; a ฿0 sale closed only on confirmation; Cancel voids) and `9673e39`
  (the Console: voucher types with the park's wording, booth staff and PINs,
  the session length; migration 0022). Before them, round 1: `1de320c` (the Pi
  runs the booth box: claim, run, the page served on the box, sign-in by account
  or PIN with the admin-set session, reprint, the staff name on the slip,
  inactive prizes off the wheel, one press one slip, the Pi install kit) and
  `13a6e70` (a booth voucher looked up, held, used up once at payment, priced on
  the platform; the void route; migration 0021; the check character). Before
  them, **`003dac7`** (05:59 — SCRUM-392: the shop screen polls a
  finite scan tape when its stream cannot open; gate MERGE) over **`4cad79e`**,
  03:28 on the 24th — S2-09b's sizes half: a shop product carries its sizes, the
  shop screen asks for one, a box scan lands on the shop screen; and `f5e5572`,
  02:05 — every screen reads members from the platform, with a CI check that
  refuses a screen reading the fixture). Staging runs `4cad79e` on the api, POS,
  Console, launcher and booth (`oto-app-staging` at `16c621a`, which deploys
  only on its own files). Before those, `d435db4` (23rd, 20:47) — tenders
  **Slice G**, offline sales replay and the box's own drawer kick. **Six of
  SCRUM-206's seven slices are in** — see "S2-10a — the tenders (SCRUM-206) —
  landed 2026-09-23" in the ticket log below for the commit and gate outcome of
  each.

- **Next — the booth, by the owner's instruction of the 24th (afternoon).** The
  Pi as a real box beside the virtual box (SCRUM-398), sign-in by account or PIN
  with an admin-set session, reprint, the slip (SCRUM-399, Bugs 394/395/396),
  voucher redemption held at the scan and used up at payment (SCRUM-207, Bug
  397), voucher types and booth staff in the Console (SCRUM-400), then the
  closing audit and the owner's bench test; the plan is
  `plans/booth/PLAN.md`. Behind it, the recommendation: (1) the D↔C2 seam and
  **SCRUM-391** — a `qr` tender never reaches the gateway — then drive D's QR
  path on staging; (2) **SCRUM-388 (High)**, reserve in-flight tenders, before F;
  (3) **SCRUM-382**, refuse a disabled or archived tender in the attempt service;
  (4) **Slice F**, the POS payment stage on all four tills, then SCRUM-206's
  Deployed evidence; (5) the Console and box items (378, 381, 385, 386, 387, 389,
  390), the promotion items (373, 374, 375, 368), the small light-theme and till
  items (370, 372, 379, 380), then 369 and 383; (6) the owner decisions.

- **Where the ticket board stands (24 Sept, 04:30).** 200 SCRUM issues were
  touched on the 23rd; now **137 Deployed, 62 To Do, 2 In Progress** (SCRUM-191,
  206) and none in Testing (SCRUM-392, 204 and 202 Deployed on the 24th; 360
  was closed Done; 393 was raised on the 24th). Ninety-six were raised on the 23rd and sixty-eight of those were
  fixed and Deployed the same day.

- **Two registers still govern the till.** `POS_GAP_REGISTER.md` (the screen-by-
  screen audit that produced SCRUM-225…241) and
  `ARCHITECTURE_CONFORMANCE_REGISTER.md`. Read the first before planning anything
  on the till.

- **The standing rule that keeps being earned.** A service with no caller is not
  built, and a test that talks to Fastify directly does not prove a browser can
  reach the route. Today's proof: D's `openQrAttempt` has no caller outside its
  own test, which is why the QR path cannot yet be driven on staging (SCRUM-391).
  Every ticket gets an independent reviewer whose job is to reproduce rather than
  to read.

- **Jira.** Sprint **"Sprint 2 - Complete build"** (id 3) on board 1 of project
  SCRUM. Keys and the full account: `SPRINT_2_JIRA_MAP.md`. Status moves with the
  work — **In Progress** when it starts, **Testing** when it is committed,
  **Deployed** when it is live with evidence; *Done* stays the owner's to set.
  Evidence comments carry screenshots.

- **Resume instructions.** Read `docs/progress/STATUS.md`, then
  `SESSION_HANDOVER.md` → the 2026-09-23 block, then this file, then
  `docs/progress/plans/206-tenders/PLAN.md` (the slice plan and §4, the owner
  decisions) and `docs/architecture/DEVELOPMENT_PLAN.md` §5 for the build recipe,
  plus `docs/briefs/OWNER_DIRECTION.md` (section 2026-09-20 wins). The session
  helpers and what each is allowed to print are in `scripts/session/README.md`.
  Branch off `main`; commit per `CONTRIBUTING.md`, no attribution lines, and
  never filter a commit's file list by a word; never commit `imports/` beyond its
  READMEs. `pnpm test` needs no Docker — the API tests start an embedded Postgres
  per file. **`services/deploy-bot/` and `render.yaml` belong to a separate
  session — do not touch either.** To play with what is deployed:
  `docs/qa/SIMULATION_AND_TEST_CONTROLS.md`.

## Done on 2026-09-20 (all committed)

- `docs/briefs/OWNER_DIRECTION.md`: new section "2026-09-20 — scope of Sprint
  2 widened; decisions changed" (order of work, launcher, payments = 2C2P
  sandbox for real QR with SCB as acquirer, devices from the real inventory,
  revenue/prices/receipts from the Replit code, agent process).
- `docs/progress/SPRINT_2_PLAN.md` revised: title/status/sources, sprint
  goal, milestones M0–M11, readiness rows for OTO App / Radar / Inbox /
  gateway, scope in/out, "Contract coverage" map (proposal §6 → tickets),
  design decisions (2C2P kept, foreign apps as own schemas, Radar contract,
  launcher design, adapters on real devices), S2-02 rewritten as the styled
  landing page, S2-10a/S2-12/S2-15a moved to the 2C2P sandbox and the real
  gate protocol, new tickets **S2-17 (OTO App a/b/c), S2-18 (Radar), S2-19
  (Inbox)**, execution order with S2-17a before CP1 and CP1–CP7, open
  decisions 10/15/16/22/23 resolved and 29–32 added, definition of done.
- `docs/architecture/DEVICE_INVENTORY.md` (new): LAN, the eleven devices with
  addresses/ids/roles, flows, the hardware note's open decisions D1–D6 and our
  resolutions, ECR facts, the full gate section (reader HTTP contract, HX-X1
  wiring/settings/faults, GE-X2 frames and passage feedback, simulator
  duties, unknowns), voucher/wristband/receipt design references; section 9
  (web research per device: TSPL2 for the 4B-2082A, DS2278 in CDC host mode
  on the box, XP-C260/XP-80 ESC/POS parameters, terminal cabling, host notes)
  folded in from `research/2026-09-20-device-research.md`, with sections 2
  and 4 corrected where the hardware note was wrong (beb9385).
- `docs/architecture/PAYMENT_GATEWAY.md` (new, 3f8827d): 2C2P API 4.3 facts
  with sources (JWT envelope, Payment Token, Do Payment on `PPQR` with the raw
  EMVCo payload, notification field names, inquiry codes, Payment Maintenance,
  Redirect API, sandbox, constraints, SFTP settlement file), our integration
  design, `PGW_*` variable names, the owner's checklist, the SCB direct API as
  the alternative provider; UNCERTAIN items listed (first: how the sandbox
  marks a PromptPay QR as paid).
- `docs/briefs/AGENCY_PROPOSAL.md` (new, 991 lines): the delivery proposal site
  captured in full (24 features, 121 stories, 33 workflows, roadmap), each
  story assessed against the OTO App export, §6 "what remains", §7 questions.
- `docs/features/inbox.md` (new): the unified-inbox import reviewed (briefs,
  design language, what exists, proposed `inbox` schema, env names, open
  questions); `docs/features/README.md` row added.
- `imports/_vendor-docs/`: the park's hardware reference copied (local only);
  README lists the gate documents and the voucher sample as received in chat.
- `docs/architecture/research/`: two research notes preserved from the
  interrupted research pass — device models (4B-2082A = 4BARCODE, Zebra
  DS2278 + CR2278 cradle, Welltech G4 = rebadged Xprinter XP-C260, Xprinter
  XP-80 family, NEXGO/PAX physical ECR links, Pi vs mini PC) and the SCB
  Developer Portal direct API (kept as the alternative provider).

### S2-01c — Render deploy of API + POS (SCRUM-188) — **code complete, deploy waiting on the owner**

Built by two parallel agents on Opus 5 and reviewed here. Commit `9f3488d`.

**`render.yaml`.** One staging environment, three resources, all in the
`singapore` region and all named `-staging`, so a production environment of
the same shape sits beside them later instead of colliding with them:

- `oto-api-staging` — a `standard` web service, not `starter`: argon2id on
  every sign-in and unlock makes this process CPU-bound, one container also
  carries `edge` and `jobs` (`PROCESS_ROLES=api,edge,jobs`), and Render's
  autoscaling starts at `standard`. One instance, health check on `/ready`,
  `TRUST_PROXY=1`, and `pnpm db:migrate && pnpm db:platform-sync` as its
  pre-deploy step. The scaling block that replaces `numInstances: 1` is
  written out beside it, commented, with the three things that must happen
  first — so it is not invented under pressure on a busy afternoon.
- `oto-pos-staging` — a static site that rewrites `/api/*` to the api, so the
  session cookie stays same-origin and dev and production are one code path.
  Nothing to size: a static site is built once and served from the CDN.
- `oto-db-staging` — Postgres 16 on `basic_4gb`, not the cheapest paid type.
  It is sized for work already scheduled: the S2-22 restore holds the 33 MB
  production dump twice while `pg_restore -j4` runs, the Radar and analytics
  rollups scan the sales tables beside the till's own queries, and the
  connection ceiling is what the api's commented `maxInstances: 3` is budgeted
  against (a pool of 10 per instance; 68 of 97 accounted for, written out in
  the file).

Plus a commented-out worker for when `jobs` splits out of the api — enabling
it means removing `jobs` from the api's roles, or the runner competes with
itself for its own locks.

Two findings worth keeping. `--prod=false` on the install is load-bearing:
`NODE_ENV=production` is set on the service and both `tsx` (the start
command's runtime) and `drizzle-kit` (the migrator) are devDependencies, so
without it the build succeeds and the start fails. And Render's blueprint
schema has **no PITR field** — point-in-time recovery is a property of any
paid instance type, so it is encoded as the paid plan plus a comment.

**CI.** A `deploy` job that runs only on a push to `main`, only after `ci`
passes, calls the Render deploy hooks, and **skips green** while the secrets
are unset — which they are until the account is connected.

**"Reset demo data".** Platform-wide caller, a typed confirmation in the
request body as well as the UI, one transaction, an `ops.demo_reset` audit
row. It deletes what a day of play produces — visits, bookings, sales,
payments, wallets, bands, stock levels and the members created during the
session — and keeps what the operator set up. Seeded demo families survive
by `created_via` (`import` from the seed, `pos` from the till), so the QA
lookups for `+66811111111` still find Mali and her two children. Known
residue, recorded rather than hidden: a child added to a *seeded* member
during play survives, because `pnpm db:seed` skips a member that exists; a
clean demo set is a re-seed against a fresh database.

**`DEPLOY_ENV`, the conflict the blueprint exposed.** DEVELOPMENT_PLAN said
the api should refuse to boot when `NODE_ENV=production` and any of
`OPS_TEST_CONTROLS`, `SEED_PROFILE=staging` or `SMS_ADAPTER=console` is set —
but the staging service is `NODE_ENV=production` with exactly those three,
because staging runs the production *build* against throwaway data. Taken
literally, staging could not start. Resolved with a separate discriminator:
`DEPLOY_ENV=local|staging|production`. A development default is still
refused on any deployment; the two playground settings — `OPS_TEST_CONTROLS`
and `SEED_PROFILE=staging` — are refused on `DEPLOY_ENV=production` only,
because staging is entitled to both. `SMS_ADAPTER=console` turned out not to
belong in that group at all: it is refused on every deployment, staging
included (see below). `apps/api/test/boot-guard.test.ts` covers each refusal —
seven cases for the development defaults under `NODE_ENV=production`, eight
for the staging-versus-production split and the SMS adapter.

**Still needed from the owner:** a Render API key in the gitignored `.env`; an
S3-compatible bucket, because there is no MinIO on Render and
`assertProductionSafe` refuses to boot while the object-storage keys are still
the demo ones; and a Twilio sender. The SMS credentials are no longer
optional. Staging sends real codes to real phones: `buildSmsSender` throws at
boot when `SMS_ADAPTER=twilio` and any of `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN` or `TWILIO_FROM` is missing, and `assertProductionSafe`
refuses `SMS_ADAPTER=console` whenever `DEPLOY_ENV` is not `local` — so the
service does not start until all three are set. The reason it stopped being a
staging convenience: a verification code in a hosted log stream is a live
credential where every log reader can see it, and a delivery path exercised
only in production is a delivery path nobody has tested. Sentry is still
optional — the error hook is a no-op while `SENTRY_DSN` is empty.

## Pending — in this order

_Plan v2 is complete as of commit set 5dabf05 → this one: SPRINT_2_PLAN.md,
DEVELOPMENT_PLAN.md (1,849 lines), PAYMENT_GATEWAY.md, DEVICE_INVENTORY.md,
AGENCY_PROPOSAL.md, features/inbox.md; CLAUDE.md points at the two plans._

1. **Done 2026-09-20:** the Jira board is set up — sprint 3 "Sprint 2 -
   Complete build", four epics, 24 stories in execution order, 16 sub-tasks,
   old issues labelled and explained (`SPRINT_2_JIRA_MAP.md`).
2. **Done 2026-09-20:** S2-01a (SCRUM-186) — see the ticket log.
3. **Done 2026-09-20:** S2-01b (SCRUM-187), S2-01c (SCRUM-188), S2-02
   (SCRUM-189), S2-03 (SCRUM-190) and S2-17a (SCRUM-192) — see the ticket
   log. **CP1 is reached.**
4. **Done 2026-09-21:** S2-04 (SCRUM-195), S2-05 (SCRUM-196) and S2-06's
   print renderer (SCRUM-197) — merged, deployed, evidenced with
   screenshots. S2-06's device half is on `wip/s2-06-devices` pending six
   fixes; see its ticket-log entry.
5. **Next:** land those fixes and merge, then **S2-07a** (SCRUM-199), the
   Lucky Wheel booth → **CP2**.

   The ticket log below is the record, updated in the same commit series as
   the code, and an evidence comment goes on each story or sub-task as its
   work merges. Status moves with the work — In Progress when it starts,
   Testing when it is committed, Deployed when it is live with evidence;
   *Done* stays the owner's to set. See `SPRINT_2_JIRA_MAP.md` →
   Conventions.

## Owner inputs needed (asked 2026-09-20)

- Which portal the park actually has: a **2C2P sandbox merchant**
  (developer.2c2p.com — the link the owner sent) or an **SCB Developer
  Portal application** (developer.scb). The plan assumes 2C2P; SCB direct is
  a second provider if it exists. Sandbox merchant id + secret into `.env`
  (`PGW_*`), never into the repo.
- Drop the four gate PDFs and the voucher sample image into
  `imports/_vendor-docs/` — **archival only**; their content is already
  captured in `DEVICE_INVENTORY.md` §6 and §7 and nothing waits on them.
- Answered 2026-09-20 (later), no longer open: the deferred column (nothing
  is deferred — there is no Sprint 3), decision 29 (face clock-in off behind
  a flag), decision 30 (the whole proposal list is in), the production data
  (use the real dump).
- Still open: decision 31 (Inbox brief conflicts — the IT Brief is taken as
  the latest word until the owner confirms), decision 32 (gateway
  credentials), decision 14 (wallet expiry policy values), decision 17
  (alert channel and recipients), the role map in S2-22 (which OTO App
  access level becomes which platform role) and the consent basis for
  re-using OTO App guardians and pickups in the POS.
- A printed sale receipt (for the tax-invoice header) when convenient.

## Answers given to the owner on 2026-09-20 (for the record)

- **"How did the POS prototype work with no API?"** — It did not have one.
  `imports/oto-pos/artifacts/oto-till/src/mockApi.ts` (5,835 lines) is a fake
  API that mutates JavaScript objects held in the browser's memory; a refresh
  resets everything (CLAUDE.md §2 says the same). `artifacts/api-server` is a
  stub with one health route. Its functions (e.g. `registerWalkInChildren`,
  `checkInFamilyWithPayment`, `recordSale`) are the business rules we port —
  cited by name in the plan. The "intake notes" are
  `docs/architecture/intake-2026-09-19/` (README + 8 reports), written from
  reading the exported code: OTO App's 796 Express routes (note 01) and
  Radar's 107 (note 05) are enumerated there, so those two backends have been
  read; the POS backend is ours to build (Sprint 1 built its first 63 routes).
- **Payments** — the owner's link is 2C2P's portal; 2C2P is the gateway, SCB
  the acquirer; PROJECT_CONTEXT §7.2 stands.

## Ticket log

### S2-01a — Security and lock-model fixes (SCRUM-186) — **done**

Branch `feat/s2-01a-security-lock-model`; commits `84010cb`, `12753a3`,
`52a7a11`, `d130cb1`. 81 API tests + 19 shared tests green; typecheck, lint
and build clean.

**Role assignment and account actions.** New
`apps/api/src/services/access-control.ts` holds the three rules the plan
names — tenancy (another operator's account is **404**, never 403, so an id
cannot be confirmed), scope ownership (a branch/department must belong to the
caller's operator; the platform-wide scope only from a platform-wide caller),
and dominance (you cannot grant, or strip, a role carrying a permission you
do not hold at a covering scope). Applied to POST and DELETE
`/accounts/:id/role-assignments`, PATCH `/accounts/:id`,
`/accounts/:id/temp-password` and GET `/accounts/:id/permissions`. Codes:
`ROLE_NOT_DOMINATED`, `SCOPE_NOT_OWNED`, `ACCOUNT_NOT_FOUND`. Roles are now
validated **before** the account row is inserted, so a bad role no longer
leaves an account behind.

Order note: the platform-wide scope (`scopeType: operator`, `scopeId: null`)
is refused by scope ownership **before** dominance is weighed, so that case
answers `SCOPE_NOT_OWNED`; an operator-scoped grant of a role the caller does
not hold answers `ROLE_NOT_DOMINATED` as the ticket describes. Both are
covered by tests.

**Lock model.** `session` gained `class`, `locked_at`, `revoked_at`,
`revoked_reason` (migration `0003_session_lock_model`, plus a CHECK on the
class). `POST /auth/lock` and `POST /auth/unlock` (unlock re-verifies the
password against the SAME session, under the sign-in throttle keyed
`unlock:<sessionId>` and `unlock-account:<accountId>`). Sign-out and force
sign-out **revoke** rather than delete, so "who ended this session, when and
why" survives; `loadAuth` refuses a revoked session like an expired one. On
the POS, inactivity now locks: the lock screen names who is signed in and
asks only for the password, a 423 from any call puts the POS into that
state, and a reload inside a locked session comes back locked
(`/me.sessionLocked`). Sign out is the only user sign-out. Inactivity
timings moved from `mockApi.ts` to `apps/pos/src/auth/timings.ts`.

**Public-deploy security.** `TRUST_PROXY` (hop count) decides `req.ip`; with
it at 0 a forged `X-Forwarded-For` cannot move a caller into a fresh bucket.
The sign-in throttle and the new rate limits both count in Postgres
(`auth_throttle`, migrations `0003`/`0004`), so a Render restart no longer
clears a cooldown — the Sprint 1 counters were a `Map`. Two buckets by
design: a tight per-phone bucket first (`limitPrincipal`, 5 in 15 min) and a
generous per-IP bucket behind it (`@fastify/rate-limit` on a Postgres store,
120/min), because the mall shares very few public addresses. Five wrong
setup/reset codes invalidate every outstanding code for that account and
purpose; a newly issued code starts a fresh budget. Origin check on
state-changing requests (`ALLOWED_ORIGINS`, same-origin allowed, no Origin
allowed). `x-request-id` only honoured as `^[A-Za-z0-9._-]{8,64}$`.
`findAccountByPhone` takes an optional operator, and `/public/member-tier`
now **requires** its branch — phone is unique per operator, so the unscoped
lookup could have answered from another tenant. `mustChangePassword` and the
session lock are enforced in `requireAuth`, not only `requirePermission`,
with a small exempt list (sign-out, lock, unlock, change-password, GET `/me`
and `/me/permissions`) — otherwise a temp-password account reached every
requireAuth-only route.

**PII.** Fastify's own request logging is off in favour of one completion
line per request with the query string stripped (`scrubUrl`); the error
reporter gets the same scrubbed URL; the SMS adapter logs `phoneHash` only
(the console adapter still prints the message — that is how a code is
delivered on a developer's machine, and S2-01c went on to refuse that adapter
on any deployment); pg errors are reduced to `code`/`constraint`/`table`/`routine`
before reaching a log or the reporter (`detail` is where Postgres puts
`Key (phone)=(+66…)`); a unique violation becomes a typed 409 naming the
constraint, never the value. `MEMBER_EXISTS`/`ACCOUNT_EXISTS` renamed to
`MEMBER_PHONE_EXISTS`/`ACCOUNT_PHONE_EXISTS` so the pre-check and the racing
path answer with one code.

**Denials.** Every refusal by a known caller writes an `access.denied` audit
row (code, message, method, scrubbed URL); `GET /audit` gained an `action`
filter; the Login Users panel shows the last ten as "Recent denials", plus a
per-account session list and "Sign out everywhere".

**UI additions** (CLAUDE.md §7.2): locked state on the lock screen; Sessions
dialog, "Sign out everywhere" and "Recent denials" on the Login Users panel.

**Tests** (`apps/api/test/security.test.ts`, 17 cases): dominance (three
refusals), denial rows, forged XFF (nine forged addresses, one bucket keyed
`ip:127.0.0.1`), throttle surviving an api rebuild on the same database,
pg-error redaction from a 23505 fixture, duplicate member → 409 without the
phone, per-phone reset limit, code invalidation, origin refusal, request-id
validation, locked and temp-password sessions, force sign-out. `helpers.ts`
gained `restart()` and per-test env overrides.

**Deferred to S2-01b, as the ticket says:** transactions (`withTx`), the
schema move, and the atomic idempotency claim.

### S2-01b — Transactions, schema move and idempotency (SCRUM-187) — **done**

Branch `feat/s2-01b-transactions-schema`. Three of its tracks — the
permission vocabulary with `platform:sync`, the architecture documents, and
the catalogue/branch transactions — were built by parallel agents on Opus 5
and reviewed here before committing.

**Named schemas (migration `0005_schema_move`).** `core` (tenancy, fleet and
the platform's own records), `crm` (tiers, members, children, visits), `pos`
(catalogue, bookings, sales, payments, bands, wallets, stock), plus empty
`promo`, `booth`, `analytics`, `edge` for the tickets that fill them. Every
table moved with `ALTER TABLE … SET SCHEMA`, so nothing is recreated and no
data is lost. Two placement calls the plan left open, recorded here: the
**catalogue sits in `pos`**, because a package, its holiday calendar and its
tax rules are only ever read together and only by the POS; **`tier` sits in
`crm`**, because a tier is what a person *is* and the catalogue merely prices
by it.

Renames while the tables are still empty: `transaction→sale`,
`transaction_line→sale_line`, `payment→payment_attempt`, `wristband→band`,
`item→stock_item`, with their columns, indexes and FK constraint names moved
too (Postgres does not rename a constraint when its table is renamed).

Constraint corrections: `child→member` is RESTRICT, so deleting a guardian
cannot silently take a child's allergies with it; the wallet and sale ledgers
lose CASCADE for the same reason; `station` carries its operator; `role`
gains `is_system` and is unique per operator, with a **partial** unique index
so two system roles cannot share a name (null operator ids are distinct in
Postgres, which the plain index would have allowed); `role_assignment` and
`branch_holiday` gain `archived_at`.

**Enumerations became text + CHECK** — all seven, not only the two the plan
named. Adding a value to a pg enum takes a DDL lock and cannot happen in a
transaction that also reads the type; a CHECK is replaced in one statement.
`station_kind` gains `booth`, `contact_channel` gains `instagram`.

**How the migration is kept honest.** `drizzle-kit generate` answers a schema
move with DROP + CREATE and, for a rename, asks table by table — and refuses
to guess without a TTY. So the SQL is hand-written and two scripts stand
behind it: `packages/db/scripts/snapshot.ts` writes the matching Drizzle
snapshot without the prompts, and `packages/db/scripts/verify-schema.ts`
(`pnpm --filter @oto/db verify-schema`) migrates a throwaway database
**twice**, then compares the live catalogue with the snapshot — tables,
columns, nullability, foreign-key names *and* their ON DELETE, indexes and
their uniqueness, check constraints — and fails if anything of ours is left
in `public`. `schemaFilter` keeps Drizzle away from the schemas other tools
own (`otoapp`, `radar`, `inbox`, `pgboss`).

**Permissions declared on the route.** `config: { permission, target }` with
a preHandler that enforces it before the handler runs; scope targets are
paths into the request (`params.branchId`). Routes that are deliberately
open, need only a session, are gated platform-wide, or resolve their
permission from the request each say which. `routes-guarded.test.ts` walks
the registry and fails if a route declares none of those — a new route with
no `config` fails on the day it is written — and a second case pins the open
surface so widening it shows up in a diff.

**`withTx(db, ctx, opName, fn)`** written: the success audit row is written
inside the transaction by the service, the failure row after the rollback on
a separate connection, and one log line carries the operation name.

**Transactions.** `withTx(db, ctx, opName, fn)`: the success audit row is
written inside the transaction with the `tx` handle, the failure row after
the rollback on the pool — the record of an attempt has to outlive the
transaction that failed. Every mutating route is wrapped: accounts (create,
role grant and removal, update, temporary password, force sign-out),
operators (create, rename, administrator), members (create, update, archive,
tier verification), children, visits, the catalogue (packages, holidays, tax
config, overrides), branches and public bookings. The cases that matter are
the multi-row ones: a visit with half its children on it is a child nobody
knows is in the park; a tier verification writes the evidence and moves the
member's tier together; deactivating an account also ends its sessions.
`transactions.test.ts` forces a failure with a Postgres trigger that raises
on the audit insert — inside the transaction, after everything the handler
wrote — and asserts the rows are gone, the success audit row is gone, and
exactly one `.failed` row remains.

**Idempotency.** The key is claimed in one statement (`insert … on conflict
do nothing returning`), so two retries racing a dropped connection cannot
both decide they are first — Sprint 1 read then wrote, which is that race. A
duplicate arriving while the original runs gets 409 `IDEMPOTENCY_IN_FLIGHT`
with `Retry-After`; a replay carries `x-oto-replay`; a 5xx **releases** the
key so a real retry does the work rather than replaying a failure for a day;
an expired key is taken over atomically; `purgeExpiredIdempotencyKeys` gives
the housekeeping job its sweep. Where a handler builds its response inside
`withTx` the response is stored in that same transaction; where it reads the
response back after committing, the client-minted id covers the gap —
`POST /members` and `POST /visits` accept a UUIDv7 from the till and answer a
repeat with the row that already exists.

**Permission vocabulary and `platform:sync`.** 28 strings became 99, grouped
by the ticket that will enforce them (selling, payments, refunds, printing,
cash and day close, check-in, wallets, stock, fleet, booths, analytics, and
the `app:*:access` tiles). The seed is now re-runnable and is the
`platform:sync` step: system roles and their permissions converge on every
run — a permission removed from a bundle is withdrawn, not merely left
behind — while the demo rows are created once and then left alone, so a
password changed on staging survives a sync. Sprint 1's "operator exists →
return" early exit is gone. `pnpm db:platform-sync` runs the platform half
alone, which is what the deploy step will call.

**Pool and process.** Pool capped at 10 with a 10-second statement timeout,
idle and connection timeouts, idle-in-transaction cut off, and an
`application_name`; a pool error is logged rather than fatal. SIGTERM drains
instead of dropping. Production refuses to boot on a development default —
a localhost database, the `oto:oto` credentials, the demo MinIO keys, or a
cookie that would travel in the clear — reporting every problem at once.

**Documents.** ARCHITECTURE.md now carries the schema map, the transaction
rule, ids and idempotency, the dominance rule and why the platform-wide
scope is refused before dominance is weighed, the lock model, the route
guard, and what never reaches a log line; its entity diagram is
schema-qualified and renamed. CONTRIBUTING.md carries the expand/contract
policy from 0006 and how to write and verify a hand-written migration.

Still to do in this ticket: nothing. **Known follow-ups, not blockers:**
ARCHITECTURE.md §3 and §6 still describe the pre-2026-09-19 repository
layout; the new permission strings are defined and seeded but nothing
enforces them yet — their own tickets wire them; `purgeExpiredIdempotencyKeys`
is exported but not yet scheduled (S2-03's job runner).

**Deviation recorded:** the plan calls this migration `0003`. S2-01a had
already taken `0003` (the session lock model) and `0004` (the auth throttle),
so the schema move is **`0005`**. Nothing else about it changed.

### S2-02 — Suite launcher and the signed hand-off (SCRUM-189) — **done and deployed**

Commit `c3d94ff` on `main`. 185 API tests + 22 shared tests green; typecheck,
lint and build clean. Live at <https://oto-launcher-staging.onrender.com>,
with the whole hand-off exercised against the real origins —
`DEPLOYMENT_STAGING.md` lists what was checked.

**Why not simply share a cookie.** The suite is several apps on several
origins and the design is one platform session behind all of them, so the
obvious answer is a cookie on the parent domain. It is not available:
`onrender.com` is on the **public suffix list**, which is exactly the list
browsers consult to refuse a cookie set for a domain that many unrelated
people share — a cookie for `.onrender.com` is not "rejected by Render", it is
rejected by the browser, and no configuration changes that. Nor would the
trick survive its own success: the booking site lands on a domain of its own,
and a parent-domain cookie would not reach it either. So the mechanism here is
the permanent one rather than a stand-in for a real domain — the launcher
mints a short-lived token aimed at ONE app, the browser carries it there, and
that app exchanges it for a cookie of its own bound to the same session row.
A real domain later makes it faster, not different.

**The fragment, not the query string.** The token travels as
`https://app/#handoff=…`. A fragment is never sent to a server: it reaches no
access log, no proxy, no load balancer and no `Referer` on the next click. The
same token in `?handoff=` would be written down by every hop between the two
apps and then sit in whichever of those logs is kept longest — which is how a
60-second credential becomes a 90-day one. The POS strips the fragment with
`replaceState` as it reads it, before anything can copy the address bar.

**Replay is stopped by the jti, not by the signature.** A signature proves a
token was minted by us; it says nothing about whether it has already been
spent. So every token carries a `jti` with a row of its own, and the exchange
claims it in a single statement — `update … where jti = $1 and consumed_at is
null returning` — the same lesson as the idempotency claim in S2-01b: two tabs
racing the same fragment cannot both read "unused" and both win. Every outcome
is audited (`auth.handoff_issue`, `auth.handoff_exchange`,
`auth.handoff_rejected` with the reason), and the launcher's account page
shows a person their own recent rejections.

**A keyring, not a key.** `HANDOFF_SIGNING_KEY` is `<kid>:<secret>` pairs,
newest first: the first entry signs, the rest still verify. Rotation is
therefore expand and contract, exactly like a migration — prepend the new key,
deploy, and drop the old entry once every token it signed has expired, which
at a 60-second TTL is the next minute. The `kid` in the header is what lets
the old key keep verifying in the meantime, instead of every launch failing at
the moment of the swap. Unset, the hand-off is **unavailable** (both routes
answer 503) rather than improvised: a key minted at boot would differ between
restarts and between instances, and a key nobody chose is a key nobody can
rotate.

**The sealed session token, and the trade-off it carries.** The app's cookie
holds the platform session's own opaque token, so revoking the session ends
every app at once — there is no second credential anyone can forget to revoke.
Getting that token across means carrying it, so it travels sealed:
AES-256-GCM under a key derived per `jti` (HKDF, the jti as salt and as
associated data), wiped from the row the moment the jti is claimed. A database
dump therefore cannot produce a usable cookie, and a ciphertext copied onto
another row fails to open.

The trade-off, recorded rather than hidden: **one bearer value is shared
across the app origins.** Whoever holds the POS cookie holds the same string
the launcher holds. The alternative is a credential per origin — a
`session_credential` table with one row per app, each with its own token, all
pointing at one session — which is strictly better isolation and is not free:
it needs the new table, a change to `loadAuth` so a lookup resolves a
credential to its session rather than reading the session directly, and a
revoke path that sweeps the children. **Follow-up to weigh before the console
and the lifted apps multiply the origins (S2-03, S2-17, S2-18).** The cost of
deferring is bounded: the session TTL and the existing revoke-everywhere path
already bound the damage, and nothing about the token format changes when the
table lands.

**Idempotency, deliberately released.** `POST /auth/handoff` releases its
idempotency claim instead of storing its response. The response *is* a
credential, and the replay store keeps a body for a day: a retried request
would otherwise be answered with a token that was already spent, and the token
would sit in a table for twenty-four hours after it stopped being useful.

**The launcher itself.** `apps/launcher` is a designed front door, not a list
of links: the POS design tokens verbatim, sign-in in the lock-screen language,
tiles filtered by `app:<name>:access` showing each app's state (open / coming
soon / no access), coming-soon shells for what is not built, and an account
page listing the session and its recent hand-off rejections. It also carries a
temporary-password panel, which closed a real hole found while building it: an
account owing a password change could sign in and then met a 403 on every
guarded route, with nowhere to change it.

**UI additions and removals** (CLAUDE.md §7.2): the launcher is new in full;
on the POS, the **"Scan my face" placeholder is removed** — PROJECT_CONTEXT
§13 rules biometrics out of scope, so the button led nowhere and invited a
question with no answer — and a "Back to the suite" link takes its place when
`VITE_LAUNCHER_URL` is set. The POS lock screen otherwise keeps the Sprint 1
design.

**A flaky test, fixed rather than retried.** The tampered-signature case
flipped the **last** base64url character of the signature — but 32 bytes
encode as 43 characters, and the final character carries only four meaningful
bits: its low two are padding a decoder discards. So the flip sometimes
changed nothing at all (it swapped `A` for `B`, which differ only in those
padding bits), the "tampered" token decoded to **identical bytes**, verified
perfectly, and the case failed whenever a signature happened to end that way —
a rare, unreproducible red build rather than an honest one. It now mutates the
middle of the signature and asserts the decoded bytes actually differ before
asserting the token is refused. Worth writing down because the shape recurs:
any test that corrupts the tail of a base64 value is as likely to be
corrupting padding as data.

**Deployment.** Three services now, all on Render's `checksPass` trigger.
`ALLOWED_ORIGINS` carries **both** static origins — the `/api` rewrite makes
`Origin` differ from `Host`, so each app's writes arrive under its own origin
and neither is covered by the other. `HANDOFF_APP_ORIGINS` carries **only real
targets** (`pos=…` today): the launcher is the issuer and is not one of the
audiences, and naming it there made the api **refuse to boot** — which is how
we learned the validator does its job. `render.yaml` now describes all three
services and both variable groups.

**Deferred, and named so it is not mistaken for done:** the plan's
"Expire hand-off now" test control (S2-02 QA step 3) is not built — expiry is
covered by tests, but not by a button on the account page. It belongs with the
other operational test controls under `OPS_TEST_CONTROLS` in S2-03. The
console, OTO App, Radar, booth and Inbox tiles stay "coming soon" until their
own tickets give them an origin.

### S2-03 — Observability and Console v1 (SCRUM-190) — **done and deployed**

**One redactor, not four.** `@oto/telemetry` is the single place a phone
number, a password, a token or a card number is turned into `[redacted]`, and
it redacts by key AND by value shape — a Luhn-valid 13-to-19 digit run is a
PAN wherever it appears, whatever the key is called. Three weaker copies were
deleted: `lib/scrub.ts` is now a thin binding to it, `services/ops.ts` binds
`scrubDetail` to the same function, and the pino logger is wrapped ONCE at
creation so every child inherits redaction rather than every caller
remembering it. Budgets on depth, node count and string length, plus cycle
detection, so a redactor can never be the thing that hangs a request.

**The operational record.** `ops_run` holds what ran and whether it worked;
`ops_last` and `ops_expectation` hold the register the watchdog compares. A
failure's fingerprint is a hash of kind, name and error code, which is what
makes sixty failures read as one problem. Alerts dedupe against an open alert
of the same key, auto-resolve when the thing recovers, and suppress a flap.

**The job runner, and how it was found not to be running.** `createJobRunner`
and twenty tests existed; nothing constructed it. `/ready` on the deployment
said `jobs.configured: false` — no test caught it, reading the deployment did.
It now starts from `index.ts`, which is the one place that knows this is a
real process and not a test building an app per file. `PROCESS_ROLES` gates
it, so the day the worker splits out the api stops competing with it.

**The routes the Console reads.** `GET /ops/health` reads the job register
from `ops_expectation` joined to `ops_last`, never from the process answering
the request, so an instance without the jobs role still answers correctly.
Lateness is measured from the last **success** against interval + grace — the
same arithmetic the watchdog uses, so the page and the alert cannot disagree
— while age is measured from the last **finish**, so "runs and fails" and
"stopped running" read as the two different problems they are.
`GET /ops/failures` groups by fingerprint with a keyset cursor;
`POST /ops/runs/:id/retry` re-runs a job and refuses every other kind,
because each of those has already half-happened by the time it failed.
`GET /ops/integrations` reports names and states only: where a provider is
unconfigured it names the **variable** that is unset, never a value and never
a masked one, because the page is read over shoulders in a back office.

**Evidence, and a correction.** The first screenshot set was attached while
three of those routes did not exist, so Health, Failures and Integrations
photographed their empty states. They were removed from the ticket and
re-captured against the live deployment with the staging test controls
pressed first, so every page shows real rows. The lesson is recorded rather
than smoothed over: evidence is checked by looking at it, not by counting it.

**Deferred, named:** OpenTelemetry traces and the OTLP bridge,
`POST /telemetry/client` for browser errors, the `audit_log` classification
columns with a BRIN index, and a scheduled ping of `/ready` from outside the
platform. All additive; none blocks the next ticket. See `OPEN_QUESTIONS.md`
for the two decisions this ticket surfaced (`job.fail` raises no
`ops.failing`; an acknowledged alert does not say who took it).

### S2-17a — The OTO App on the central database (SCRUM-192) — **done and deployed**

**The lift, not a rewrite.** The app arrived as a 619 MB export; what came
into `apps/oto-app/` is the source only, 17 MB, with the runtime output and
the real uploads left behind. Two scripts were deliberately not copied:
`post-merge.sh` ran `drizzle-kit push --force` on every merge and
`db-reset.sh` drops the public schema. Against a database several apps now
share, either one is a data-loss event with no migration to review, and the
README says so where somebody would otherwise restore them from the export
by reflex.

**The migration history had drifted, and the number is the argument.** 184
tables are declared in the TypeScript; the chain Drizzle would actually apply
creates 112; fourteen `.sql` files sit in the folder unreferenced by the
journal. That is what `push --force` leaves behind: the live database is
right, the history is a partial record of how it got there. Replaying it into
an empty database produces one the app cannot start on. So `0000_otoapp_
baseline` is a single generated migration for a fresh database and the old
chain is kept, unapplied, in `pre-platform/` for whoever needs to read how a
table came to look the way it does. Faking the missing 53 tables into a
history that never ran was the alternative.

**Two guards that pay for themselves.** The migrator refuses if `otoapp` does
not exist, and refuses any migration that qualifies a name with `public` —
because a stray `public` copy of 184 tables would shadow every other app on
the database. The app refuses to start unless `search_path` resolves to
`otoapp`, set as a connection startup parameter rather than a `SET` on
connect, which a query can win the race against. Measured: with no option at
all the app writes to `public`, which is exactly the accident. **The first
deploy hit the first guard** — the api had not yet run the migration that
creates the schema — and stopped with the missing step named, rather than
creating 184 tables in the wrong place.

**One sign-on, and one way out.** The browser posts the fragment to the app's
own origin, the server exchanges it with the platform, resolves its user
strictly by `platform_user_id` — no fallback on email or name, which is how
one person ends up inside another's record — and calls `req.login()`. Nothing
downstream changed. Sign out on the launcher ends the app's session within
ten seconds through a liveness check that fails *open* on anything but a
clear 401, so a platform restart cannot sign the whole park out at once.

**The gap that would have stopped the demo.** The provisioning route recorded
the link and nothing wrote the app's own column, so the sign-on would have
resolved nobody. The route now creates or stamps the app's user in the same
transaction, through one seam file that says at the top why the boundary is a
function call and not an HTTP one. The rollback is proved rather than
asserted: the grant is fault-injected to fail after the app user is written.

**Not done, and it needs the owner.** Which *branch* and which *operator* a
person belongs to inside the OTO App. Its branches and operators are
different records with different ids from the platform's and no
correspondence exists, so writing ours into its fields would make a link that
looks right and is not. Role is set from the platform; branch is still set
inside the app. That mapping blocks nothing today and must be settled before
S2-17b.

**Also:** taking the app in turned `eslint .` red with 854 inherited errors,
which — because every service deploys on `checksPass` — stopped the whole
suite deploying, not just the new app. The app is excluded from the platform
lint run and holds itself to its own; the one rule that must not be lost is
enforced inside it by a byte-for-byte copy of the platform's redactor, with a
CI step that fails if the copy drifts.

### S2-04 — stations, boxes and devices (SCRUM-195) — **done and deployed**

**What it is.** The model everything physical hangs off: a *box* (the
Raspberry Pi at the counter, or a cloud stand-in), the *devices* it drives,
and the *stations* a member of staff stands at. The Console's Devices area
registers a box, watches its heartbeat and edits its devices; the POS asks
"which station are you on?" after sign-in.

**Who belongs where is the administrator's call, not an inference.** A box is
claimed to a branch; devices are attached to the box; a station names the box
it sits on and may be restricted to named staff. A restricted station is
**absent** from everybody else's picker — not greyed out, not refusing — which
is the rule the owner described. Staff never set a station up; they pick one.

**A box's secret is stored as SHA-256 only.** That single decision changed
S2-05's signing scheme: the cloud cannot compute an HMAC over a secret it
does not hold, so box→cloud provenance is Ed25519 with the box holding the
private half, not the HMAC the ticket's wording implied.

**What review found.** The fleet API the Console and the POS both called did
not exist — the first instance of the pattern above. `atBranch` was also too
narrow: an operator-wide administrator did not count as branch staff. Widened
per the owner's ruling to accept an `operator`-scoped role assignment
(including a null scope id) as well as a branch-scoped one.

### S2-05 — the box agent sync core (SCRUM-196) — **done and deployed**

**What it is.** The till stops talking straight to the cloud. The box owns
what is happening: a *station session document* with lease fencing (15s
heartbeat, 60s TTL), a durable outbox, and a *sync ledger* the cloud files
facts into — `sync_event` unique on `(box_id, journal_epoch, box_seq)`,
with `payload_hash` for identity and `sig` for provenance, plus
`sync_cursor`, `sync_quarantine`, `sync_anomaly` and `sync_change`. A dropped
connection stops being an incident.

**Six rounds, four of them fixing the previous round.** The findings worth
keeping in mind:

- *Nothing a real Pi produced would ever have synced.* Box and cloud
  canonicalised slightly different bytes, so every fact from real hardware
  would have been quarantined — and three existing tests all passed, because
  each mirrored one side of the join. The test that caught it seals with the
  real box code and pushes at the real server.
- *A till could lose its station mid-sale*, and *a till refused a takeover
  could take over anyway* — the lease id was published to everyone who could
  read the screen, and quoting it was the whole permission check. Now the
  lease only fences; the **account** authorises.
- *One damaged message cost the other 199.*
- *"Inject poison event" jammed the box it was aimed at* so every later sale
  was silently discarded as a duplicate.
- *Facts could vanish without a trace* — counted as already-seen with no row
  behind it. Now a critical alert.

**Still open:** a box that re-registers after a redeploy rotates its signing
key, so facts queued before the restart need re-signing. A Raspberry Pi keeps
its identity and does not hit this; the cloud stand-in does.

### S2-06 — the print pipeline: adapters, simulators, the job queue, the panel (SCRUM-197)

**What this half is.** `packages/print` had already turned a template into
device bytes and had them verified against an independent decoder. This is
everything between those bytes and paper: the socket, the status query, the
queue that survives a printer being out of paper, the simulator that lets all
of it be rehearsed with no hardware, and the two screens a person uses.

**One adapter per family, parameterised per unit.** The Welltech G4 and the
three XP-80s share one ESC/POS implementation (§9.4 is explicit that status,
cut, drawer kick and raster are identical across them); the 4B-2082A band
printers get a TSPL2 one. What differs per unit — 576 versus 512 dots per
line, band stock, cutter, whether a drawer hangs off the RJ11 — comes from the
S2-04 device row and its new `settings` document, never from a constant.
`GS v 0` discards anything wider than the head **without an error**, so a wrong
width is a receipt silently missing its price column; that is why the number
is a per-unit fact and not a model default.

**The simulator is a byte-stream device, not a stub.** It takes exactly the
bytes the adapter writes, answers `DLE EOT n` / `ESC ! ?` with the real bit
frames (including mid-job and while in error, as the manual promises),
injects the five faults, refuses a second connection, and rebuilds the picture
with **the renderer's own reader** — `packages/print/test/escpos-reader.ts`,
which its author wrote "to be lifted". Lifting it rather than writing a second
parser is the point: it is the same code that proves, in `emit.test.ts`, that
the emitted bytes carry the rendered dots, so a preview that differs from the
renderer's means the transport lost something. A test asserts the two PNGs are
**byte for byte identical**.

**The defect that test found.** The simulator scanned the byte stream for
real-time commands one byte at a time — and a raster band is arbitrary binary,
so a receipt whose dots happened to spell `10 04 01` lost three bytes out of
the middle of the picture. One fixture did. It showed up as a kitchen ticket
that came out truncated in one run and whole in the next, which is the shape
of a bug that survives a suite. A real printer does not have the problem
because it reads the length first; now neither does this. The same applies to
TSPL's `BITMAP` payload.

**Four decisions written down rather than discovered at a counter**, in
`packages/box-agent/src/printing/queue.ts` and each with a test:

- *The cable is pulled mid-job.* `failed`, and **no timer retries it**. Bytes
  that reached the head are already paper in a guest's hand; an unattended
  retry produces a second, complete receipt beside a torn-off first one and
  nobody can afterwards say which is real. A person pressing reprint is a
  different act and mints its own job.
- *The printer answers no status query.* Printed to anyway, reported
  `statusUnknown`. §9.3 leaves open whether every firmware in this family
  answers `DLE EOT` over the LAN board; a till that refused to sell because a
  printer was silent would be the worse failure.
- *Two jobs race one printer.* Serialised per device. Neither vendor document
  says whether a second TCP session is refused or stalls — both list it as
  "confirm on site" — so we never open two.
- *The printer left the box while the job waited.* Re-resolved from the
  current bundle on every attempt, so it ends `skipped` with `DEVICE_GONE`,
  not `failed`. Nobody can fix that by waiting.

And the fifth, which is an acceptance criterion rather than a failure: a job
for a role no station has a printer for is **skipped**, the till says "not
printed", and nothing is raised — a station with no band printer is a choice
somebody made in Station Setup.

**What the cloud keeps.** `edge.print_job` rows with the outcome, one
`ops_run` per failure whose fingerprint groups sixty paper-outs into one
problem, and the 90-day retention sweep wired into
`job:housekeeping.retention` — which the schema left named and uncalled.
Reports arrive on their own route (`POST /box/v1/print-jobs/:id/result`)
rather than on the command result, because a job that waited half an hour on
an empty roll reports long after the command that queued it was acknowledged;
a second report of a terminal job is answered `replayed` and changes nothing.

**Health in the heartbeat, and the red indicator.** The box now pings every
assigned printer before each heartbeat and reports what they said, so the
worst case between a roll running out and the till going red is one interval.
Before this, every printer reported `reachable`/`ok` because nothing had asked
it anything — the one answer a health indicator must never give by default; an
unprobed printer now reports `unknown`. The POS header reads the device rows
the heartbeat updates rather than asking the box, because the case that
matters most is the box being unreachable, and a thing that cannot answer
cannot report its own silence.

**Two screens.** The POS's Print Templates panel is wired to
`pos.print_template` with the prototype's design untouched — the list, the
editor and the live preview are unchanged; what is new is that saving is a
`PATCH` that bumps the version, and a **Test print** button (a UI addition)
that puts the template's sample on a real printer through the box. The
Console's Devices drawer gains a **Printing** panel beside the Simulators
panel: the box's queue, and the pictures the simulator rebuilt.

**One door, not two.** The Console's Simulators panel sends a fault through
`POST /boxes/:id/commands` like every other control on that drawer, and
`POST /boxes/:id/simulate` is a typed spelling of the same thing. The two
checks such a command needs — **no badge or PIN in a stored payload** that the
Console renders, and a device that is really on this box — live in
`queueCommand`, where both spellings pass. They were on the route first; that
would have made one of the two spellings the unguarded one.

**Drift, closed where it could be.** `apps/api/test/print-api.test.ts`
compares the renderer's `TEMPLATE_FOR_KIND` / `APPLICABLE_FIELDS` /
`TEMPLATE_TYPE_ORDER` with `@oto/shared`'s, and the agent's
`BOX_COMMAND_KINDS` with the schema's — the api is the one place all of them
are importable. `simulate` was added to the agent's copy; the schema and the
api already had it.

**Tests.** 32 new cases: `apps/api/test/printing-box.test.ts` (16, the box
pipeline by itself) and `apps/api/test/print-api.test.ts` (16, driven through
the real routes with the real agent behind `app.inject`), plus the existing
box-agent and route-guard suites updated. They live in `apps/api/test` rather
than `packages/box-agent/test` because that package runs on Node's own runner
with `--experimental-strip-types`, which refuses TypeScript parameter
properties — and `Bitmap1`'s constructor uses them, so `@oto/print` cannot be
imported there at all.

**Deferred, named:** sale-specific print jobs and reprints from the till
(S2-11 — the reprint route exists and is tested, but nothing on the POS calls
it yet); the booth voucher's content (S2-07a); `catalog:template:*` as a
permission pair of its own, which is why editing a template currently asks for
`admin:branch:update` and a test print for `admin:box:command`; and a box-side
queue that survives a restart — a job waiting on paper today lives in the
agent's memory, the cloud row stays `queued`, and a restarted box does not
resume it.

#### The device half — on `wip/s2-06-devices`, not on main

Committed as `6440761`, 96 files: `print_job` / `print_template` /
`staff_token` schema (migration 0011), the printer adapters and their
simulators, the scanning service and scanner simulator, the signed staff
token with offline unlock, the PWA shell, and the Console's simulator panel.
Twenty routes, every one registered and guarded. Tests green.

**Two reviewers then found six things, three of them security.** They are on
a branch rather than main for that reason:

1. **Revocation fails open.** `packages/box-agent/src/staff-token.ts:275-280`
   — `if (deny) { … }`. A box holding a `staff` list but no `deny_list`
   admits a revoked token silently. Two reachable routes into that state were
   measured: a partial cache apply (`agent.ts:689-699` writes scopes in
   order, `staff` before `deny_list`, and the caller at `:1190` swallows the
   error), and `GET /box/v1/cache?scopes=staff`, which lets a box hold one
   and not the other permanently. A dismissed employee keeps working until
   the token expires.
2. **The offline unlock has no offline caller.** `POST /auth/unlock-offline`
   declares `auth: 'session'`, which reads `core.session` joined to
   `core.account` live, so on a Pi with the link down there is no door. Three
   comments assert the opposite, one calling it *"the one that has to work
   when nothing else does"*. The test calls `agent.setOffline(true)` and then
   posts to the route **in the same process with the same database open**.
3. **Retiring a compromised key does not stop it.** `snapshotForBox` filters
   signing keys on purpose and `active` only — no `retiredAt`, no
   `expiresAt` — where `services/box.ts`, which feeds a real box, filters
   correctly.
4. **The Console's printout preview is a broken image.** `previewUrl` misses
   the `/api` prefix every Console request goes through, so the browser asks
   its own origin. The byte test passes because `app.inject` never sees a
   prefix.
5. **"The same renderer that drew the preview" is false.**
   `PrintTemplatePreview.tsx` is 291 lines of React sharing only
   `APPLICABLE_FIELDS` with `packages/print`. `single-renderer.test.ts`,
   written to forbid exactly this, only walks `packages/print/src`.
6. **A cover left open is invisible above the box**, and the paper-out alert
   is gated on opening hours where the criterion does not say so — so a QA
   run before 10:00 fails and reads like a bug.

**Fixed on the branch — findings 1, 2 and 3 (the staff token).**

1. **Not being able to check revocation is now its own refusal.** An absent
   deny-list is `STAFF_TOKEN_REVOCATION_UNKNOWN` in the verifier and
   `OFFLINE_REVOCATION_UNKNOWN` in the unlock, which refuses before the
   password is looked at and on both doors — the token path and the 30-day
   sign-in. The decision was *refuse* rather than *admit with a caveat*: the
   state is only ever reached through a fault, and the window it would open —
   up to sixteen hours — is the one in which a dismissed employee matters
   most. The cost is honest and bounded: a till in that state cannot unlock
   offline until the box completes one pull.
   Both routes into the state are closed at their sources as well.
   `planCacheApply` (new, `packages/box-agent/src/cache-apply.ts`, unit
   tested) writes the deny-list **first** and refuses to apply a staff list
   without it, and `syncCache` abandons a pull at the first write that fails
   instead of filling in around it — so every state the loop can stop in has
   revocations at least as fresh as the staff list beside them.
   `GET /box/v1/cache?scopes=staff` now serves `deny_list` with it. And the
   fault is visible rather than silent: the agent counts skipped scopes and
   reports them in the heartbeat's `errors` (fingerprint, code, count — never
   contents), which raises a `box.cache_incomplete` alert from the watchdog
   and closes on the next complete pull.
2. **The offline unlock's comments were narrowed to what is true, and the
   gap is the next ticket's work.** There is no box-side surface: the agent
   has no local HTTP server (only the printer simulator listens), so nothing
   on a Pi constructs `OfflineAuth` and every offline unlock in the park goes
   through the cloud route. Building that server was not attempted here —
   half of it, reachable from nothing, is the very defect this list is about.
   What the route does prove is kept and stated: the *decision* needs nothing
   but the box's cached staff list, deny-list and signing keys. The three
   sentences that claimed more are rewritten, the OpenAPI description with
   them, and the test file now says in its own header what
   `agent.setOffline(true)` does and does not demonstrate.
   **Next ticket:** a local HTTP surface on the box that calls `OfflineAuth`
   directly and records the unlock into the outbox, plus a POS that falls
   back to the box's origin when the cloud does not answer. Until that lands,
   an outage stops a locked till from being unlocked, and nothing in the code
   should be read as saying otherwise.
3. **One filter now answers "which key is still good"** —
   `apps/api/src/lib/signing-keys.ts`, used by both the config bundle a real
   box pulls and the snapshot the unlock path builds. It honours `retired_at`,
   `expires_at`, `not_before` and the operator. A test retires the key and
   shows a token signed with it refused as `STAFF_TOKEN_UNKNOWN_KEY`.

### S2-07b — the booth admin control panel (SCRUM-200) — **Console half built, against the real routes**

**What this half is.** Console > Booths: the screen a manager uses to decide
what the Lucky Wheel gives away. The prize list with its real odds, the prize
editor, the booth's settings, a wheel preview, the version history, and a
Publish that states what it is committing to before it commits.

**It was built against a stated contract and then re-pointed at the real one.**
The API half (`apps/api/src/routes/booth.ts`, `services/booth-admin.ts`)
landed in the same working tree while this was being written, so the guessed
paths were replaced by the routes that exist and every shape was re-copied
from `BoothDraftView`, `BoothListItem` and `PublishBlocker` rather than
inferred. Three of the guesses were wrong and are worth recording, because
they are the kind of thing two halves discover at integration and not before:
the booth list is **branch-nested** (`GET /branches/:branchId/booths`, so the
page needed the branch picker Devices already has); the draft is
`GET /booths/:id/draft`, not `/config`; and layouts and voucher definitions
are **the operator's own collections** (`GET /booth-layouts`,
`GET /voucher-definitions`), not fields inside the draft.

**Files.** `apps/console/src/pages/Booths.tsx`; `apps/console/src/components/booth/`
— `boothApi.ts` (the contract), `readState.ts`, `odds.ts`, `publishPlan.ts`,
`PrizeTable.tsx`, `PrizeEditor.tsx`, `BoothSettingsPanel.tsx`,
`WheelPreview.tsx`, `PublishPanel.tsx`. Plus the nav entry in
`consoleSections.tsx` and the route in `App.tsx`.

**The odds are the point of the screen.** Weights are integer basis points
summing to 10,000 and nobody is asked to do that arithmetic. Each row shows
the chance a child actually has — the weight **renormalised over the prizes
the box will draw from**, which is the draw's own rule (D5) — so switching one
prize off visibly moves every other row, which is the mistake this page exists
to prevent. The running total is a verdict ("adds to 100%", or the gap named
in the units somebody has to type), not a sum left for the reader to check.
Each row also carries its share of the day's giveaway, because *14.5% of the
spins and 40% of the money* is the sentence a list of weights never says.

**Integers decide; floats only paint.** `odds.ts` computes every verdict in
basis points and satang. A typed decimal is parsed **digit by digit**
(`parseHundredths`) rather than through `Number`, because `Number('0.07') * 100`
is 7.000000000000001 and a list of those rounds to a total one basis point out
with no typed number to blame. Money is multiplied before it is divided, once.

**Publish states what it commits to, and the refusals are the API's.** The
draft route returns `blockers` — computed by the same code that validates the
publish inside the transaction that writes it — so the panel shows that list
verbatim, all of it at once, with the field each one belongs to. It does not
re-derive them: a second list would agree today and drift the first time
either side gains a rule, and the screen would be the one that is wrong. The
confirmation is two presses, the first being what puts the odds, the money and
the settings on screen, and it sends the draft's `expectedBundleHash` back
with the publish — so a colleague's edit made since the page was read is
refused rather than published by somebody who never saw it.

**One thing the panel cannot do, and says so.** A field-by-field comparison
with the wheel the booths are running is not possible: the draft carries the
published version's number and hash but **not its document**, so "the ฿200
voucher went from 14.5% to 20%" cannot be computed in the Console. `changed`
(a boolean, from comparing hashes) is what there is. The panel therefore
states what version N+1 *will be* and says in as many words that it is not a
before-and-after. Worth closing from the API side — the draft returning the
published bundle beside its hash would be enough.

**The wheel preview matches the booth, including the part that surprises
people.** `apps/booth/src/components/Wheel.tsx` computes `360 / slices.length`:
on the television **every wedge is the same width whatever its odds**, so the
2.5% grand prize looks exactly as big as the 27.5% sticker. The preview copies
that geometry — slice order, labels at 0.62r rotated radially, the same
font-size steps — and prints the real chance beside each label, rather than
drawing proportional wedges that would be prettier, wrong, and wrong again the
moment a prize is switched off. Slices with no colour of their own are drawn
in a labelled placeholder ramp: the layout's palette lives in its design
document, which this page does not read.

**What is proven and what is not, plainly.** `GET /booths/:id/status` ships
(S2-07a) and everything on the "What this booth is running" panel comes from
it. The other routes now **exist in this tree** but are not deployed to
staging, and **no request from this page has been run against a live server**
— the panel compiles against their shapes and has not spoken to them. Where a
route answers 404 the page says the route is not on this deployment and names
SCRUM-200, rather than showing an empty screen that reads as "this booth has
no prizes". Every reading carries what it is worth — unread, read, stale,
failed or absent — by the same four-state discipline as `lib/deviceList.ts`,
generalised in `readState.ts`, so a failed request is never drawn as a booth
with nothing on its wheel. **First integration run is the next step**, and
the S2-04/05/06 lesson applies: a type that lines up is not a browser that
reached the route.

**Tests: none automated, and that is a gap, not an omission.** `apps/console`
has **no test runner** — the same hole as `apps/pos`, and the compiler is the
only automated check on either. The arithmetic was proved by running `odds.ts`
under `node --experimental-strip-types` with the owner's launch list
(23.5/27.5/17.5/14.5/14.5/2.5): **38 checks, all passing** — the balanced
total, the renormalisation when the grand prize is switched off (the sticker
rises 23.5% → 24.1%), the exact-decimal parser against the `Number()` trap,
the money (฿72.75 a spin, ฿14,550 over 200 spins, ฿5,800 of it from the one
prize at 14.5%), and the degenerate lists that must not divide by zero. That
run is a scratchpad artefact and **CI does not know about any of it**. Raised
as a defect.

**Findings raised from building it:**
1. `apps/console` has no unit-test runner, so this page's arithmetic, its
   publish refusals and its diff are unverified by CI.
2. `booth_settings.daily_spin_cap` is a setting **nothing reads** — the column
   says so. The form offers it with that stated in the hint, which is the
   honest minimum, but a manager can still set a cap that does not cap.
3. Badge sign-in at a booth is an unresolved contract, not a to-do:
   `BoothStaffCacheFields.badgeHash` notes that argon2id cannot be a lookup
   key, so a scan cannot find an account offline. S2-07b owns settling it —
   either a keyed digest with the credential row saying which, or a badge
   resolves to a staff code and PIN is the only path.

4. The Console cannot show a before-and-after on publish, because the draft
   does not carry the published bundle (above).

**Not built in this half, named:** the Console screens for voucher-definition,
marketing-channel and layout *authoring* — the routes for all three exist and
this page only *reads* them into its pickers; staff PIN/badge management
screens (routes exist: `/booths/:id/staff`, `.../pin`); drag-to-reorder
slices (`PUT /booths/:id/prize-order` exists, the editor sets `sortOrder` by
number instead); the `platform:sync` seed of "Booth 1"; the booth report
(S2-15b).

### S2-07b — the booth admin control panel (SCRUM-200) — **API half built, and a real box runs what it publishes**

**The other half of the entry above.** `apps/api/src/services/booth-admin.ts`
(new), the Console section of `apps/api/src/routes/booth.ts` (20 routes) and
`apps/api/test/booth-admin.test.ts` (19 cases, all passing). Prizes (create,
edit, reorder, switch on and off, weight, expiry, daily cap, cost), voucher
definitions, wheel layouts, the booth's own settings, its staff list and their
PINs — and **publish**, which is what the rest of it is for.

**Publishing is minted whole, validated before it exists, and never edited.**
Validation, the bundle and the insert are one transaction: validating outside
it would let a colleague's edit land in between, and the version published
would be one nothing ever checked. The refusals — all of them at once, each
naming its field, so a manager fixing a list one refusal at a time does not
spend four version numbers finding the fifth problem:

| Refusal | Why it is refused rather than defaulted |
|---|---|
| active weights ≠ 10000 bp | the box renormalises per draw; a list that does not add up is odds nobody chose. The message names the sum and the percentage |
| an active prize with no voucher definition, or one archived/switched off | winning it would produce nothing to redeem |
| an active prize with no expiry (its own or its definition's) | null on a definition means *never expires*, which is true of the legacy Radar codes and is a liability with no end date on a slip printed today |
| no layout | there is no wheel to publish |
| every prize off, **or every active prize capped out today** | the box refuses the press with "Booth not ready — please call staff" (D5). Right for an accident, wrong to publish on purpose. The cap check names the trading day, because tomorrow the same bundle is playable |
| eligibility `band` / `phone` | *not available until the park booth exists* — both modes are built; neither makes sense where a visitor has no band and the television asks for no phone (D15) |

**The draft is the live rows, and the entry says so.** There is no draft table:
`booth_settings`, `booth_prize` and `booth_layout` ARE the draft, one per booth
and shared. Two managers edit the same rows — last write wins per field, with
the audit row naming who moved what — and a publish carries everything saved,
a colleague's edit included. `GET /booths/:id/draft` therefore returns the
exact bundle that would be minted, its hash, the **published bundle beside it**
(which closes the Console half's finding 4 — a before-and-after is now
computable), when it was last edited, and the blockers. `POST .../publish`
takes an optional `expectedBundleHash`, so a manager can be refused rather than
publish a draft they never saw; publishing an identical bundle is refused too
("nothing has changed since version N"), because a version spent on nothing
tells a booth to re-apply a wheel it is already running. Two managers pressing
Publish together produce one version and one 409 —
`booth_config_version_unique` settles the race, not the read.

**The seam, which is the point.** The test publishes through the real route
with a real session and a real permission check, then the **real box agent**
(`createBoxAgent` + `SqlBoxStore` on Postgres, the same code a Pi runs) pulls
its cache, adopts the version and spins: one prize forced to 10000 bp,
published, and the next press lands on it with `configVersion: 2` and
`bundle.prizes[prizeIndex].id === prizeId`. Version 1 is then re-read and is
byte-for-byte what it was, with its six live slices, while the draft has five
switched off.

**Two defects found and fixed, both of which would have read as "the PIN
doesn't work" with nothing to blame:**
1. the `staff` cache scope carried no `pinHash`, so a PIN set in the Console
   reached no booth at all — `BoothStaffCacheFields.pinHash` in `@oto/shared`
   was declared for it and nothing wrote it (`services/sync.ts`; the pinned
   field list in `sync-api.test.ts` was edited deliberately, because a field
   added there is a field that lands on a Pi in a mall);
2. `startVirtualBox` passed the booth no `verifySecret`, so `createBooth`
   matched nobody and **every** booth sign-in was refused whatever PIN was set
   (`services/box.ts`).

**Where the four digits are not.** The PIN route declares `secretResponse`, so
the idempotency plugin claims no key — a plain SHA-256 over a body holding four
digits is ten thousand guesses, and that hash would otherwise sit in
`idempotency_key.request_hash` for a day. The audit row says a PIN was set, by
whom, for whom, and carries neither the PIN nor its hash. Nothing goes on the
box command queue, whose payloads are stored and rendered on a Console screen.
All three are asserted in the test, not claimed in a comment.

**Permissions, and the split is deliberate:** `admin:booth:read` to look,
`admin:booth:manage` to edit the draft, `admin:booth:publish` to put it on a
booth, `admin:booth:staff_assign` for the staff list and PINs. A branch manager
holds read and staff_assign and neither of the other two, so the person who
decides who works the booth is not the person who decides the odds. Reception
is refused both the prize edit and the publish (asserted). Layouts and voucher
definitions pass no branch target, so only an operator-scoped grant covers
them — they are shared by every booth of the operator.

**Not built, named with its reason:**
1. **`promo.marketing_channel` and `promo.campaign`** — in the ticket, and both
   are new tables. A migration is another workflow's file in this tree today,
   so `voucher_definition` carries neither and the API does not pretend to. The
   conversion question the wheel exists to answer ("which booth, which staff
   member, which prizes convert") stays unanswerable until they land, and the
   definition body gains two required fields that day.
2. **Product and ticket-package links on a voucher definition** — the columns
   exist; validating that a product belongs to this operator is the catalogue
   admin's, which is SCRUM-204.
3. **Badge sign-in remains an open decision**, exactly as
   `BoothStaffCacheFields.badgeHash` states: argon2id cannot be a lookup key,
   so a scan cannot find an account offline. Either the credential row says it
   holds a keyed digest, or a badge resolves to a staff code and PIN is the
   only path. Not guessed here.
4. **`booth_settings.daily_spin_cap` is still read by nothing** (the Console
   half's finding 2 stands): the API accepts it, publishes it in the bundle,
   and no code caps on it.
5. **No browser has called any of this.** The Console half compiles against
   these shapes and has not spoken to a live server; first integration run is
   the next step, and the S2-04/05/06 lesson applies — a type that lines up is
   not a browser that reached the route.

**Checked:** 19/19 in `booth-admin.test.ts`; 614/615 across the api suite
(`safeguards.test.ts` hit a Windows `EBUSY` on the temp Postgres directory and
passes on its own); `pnpm exec eslint apps packages` clean. **Not committed** —
this tree is shared with two other workflows.

### S2-09a — the sales ledger (SCRUM-203) — **the schema half is built; nothing writes it yet**

**The hole this fills.** The audit drove admission end to end and found the
till reaching "Pay ฿1,440" with nowhere to put the sale. `pos.sale` and
`pos.sale_line` were the Sprint 1 placeholders — operator, branch, status, one
`total_satang`, a jsonb — with no station, box, business date, pricing mode,
tier, VAT/service split or receipt number, and the only code referencing
either was `demo-reset` deleting them. `recordSale` in the POS pushes onto an
in-memory array a refresh empties.

**What landed.** `packages/db/src/schema/sales.ts` and migration
`0014_sales_ledger`: `pos.sale`, `pos.sale_line`, `pos.sale_discount`,
`pos.receipt_series`, with `payment_attempt` moved across from `future.ts`
unchanged (it is a row on a sale, and the move removes an import cycle;
S2-10a still owns its columns). `future.ts` keeps bookings, wallets, bands and
stock.

**The column list is the engine's own output, not a fresh design.** The park's
rules are the prototype's (`lib/sale.ts` — `buildSale`, `computeTotals`,
`tillTaxInputs` — and `mockApi.ts:1295`), already ported and tested in
`@oto/shared`. So `TicketCartTotals` → the totals block, `TaxBreakdown` →
`tax_breakdown` and the per-line tax columns, `CartUnit`/`LineBreakdownItem` →
one `sale_line` per unit, `ManualDiscountRecord`/`AppliedPromo` → one
`sale_discount` per instrument. Reading a sale back needs no re-derivation,
which matters because `cart-totals.ts` documents what re-deriving a historical
sale under today's context does to it (a ฿520 sale reported as ฿620).

**A line is a UNIT, not a cart line** — the kids row, the paid adults row, the
free adults row, socks, each add-on, the service fee, prepaid food, a
free-item promo's item — grouped by `cart_line_id`. One cart line can hold
three taxable categories at once (tickets, an add-on with a category override,
a drop-off fee), so a per-line tax rate is only meaningful on the unit, and
these are exactly the units the engine already computes.

**Four decisions.**

1. **`business_date` is stored, not derived.** Resolved once from
   `branch.business_day_start` (05:00): a sale at 00:30 belongs to the day
   that is finishing. Ruling 3 in `pricing-mode.ts` already says the same date
   chose the price, so the cash-up, the till roll, the price and promo expiry
   all agree. `business_day_start` and `timezone` are frozen on the row too —
   a branch that moves its day start must not silently re-answer which day
   every past sale was on.

2. **Receipt numbers are per STATION, gapless within that station's series,
   allocated on the box** — `<code_prefix>-<seq>`, the shape
   `packages/print` already prints. A branch-wide gapless counter needs a
   single allocator, and a single allocator stops the counter when the mall's
   internet or one box goes down — the thing the Pi exists to survive. Per-POS
   running numbers are also the Revenue Department's own practice for
   abbreviated tax invoices. `pos.receipt_series` is the CLOUD's high-water
   mark (the `receipt_series` sync scope already ships it to boxes with
   `highWaterMark: 0` and a note that the money path fills it), so a reimaged
   box resumes rather than restarts. Two allocators in one series collide on
   `sale_receipt_unique` instead of printing one number twice; the two
   explainable gaps are a voided sale keeping its number and a box resuming
   from the cloud's mark.

3. **Totals are split and the database checks them.** net / service charge /
   VAT-already-inside / VAT-added-on-top, with `sale_totals_check` refusing a
   row whose parts do not add up to what the guest paid, and
   `sale_discount_parts_check` refusing a discount total that is not its own
   manual and promo halves. Inclusive and exclusive VAT are separate columns
   because they are different money — `tax.ts` warns against adding them.

4. **A finalised sale is frozen by a TRIGGER** (`pos.sale_freeze`,
   `pos.sale_child_freeze`), not by convention, so no service, script or psql
   session can quietly rewrite what somebody was charged; status may only move
   finalised → voided/refunded, and a void needs a reason. It guards UPDATE
   only — the demo reset deletes a day of play on purpose — so the guarantee
   is "no silent rewrite", not "indestructible".

**Idempotency.** The till mints the sale id, so pressing Pay twice through a
dropped connection is a primary-key replay. `sale_action_unique` on
`(station_id, action_id)` is the second net: a retry that minted a NEW id but
carried the same `x-oto-action-id` is refused rather than written.

**Tests.** `apps/api/test/sales-ledger-schema.test.ts`, 19 of them, aimed at
what `verify-schema` **cannot see**: it compares check constraints by NAME
only and does not look at triggers at all. So each check and each freeze is
driven with a bad write and asserted to be refused *by the named constraint*
— reading the Postgres error off `cause`, because Drizzle wraps it in "Failed
query" and matching that would pass for a typo.

**Gate.** Migrations apply twice from empty to an identical catalogue (1,921
catalogue rows both passes); `verify-schema` green; 595/596 api tests pass —
the one failure is the booth-admin workstream's uncommitted `pinHash` in the
staff cache bundle, ahead of its own test, and is not this work; `@oto/db`
typecheck clean; eslint clean on these files.

**Deliberately not done here (the rest of SCRUM-203):** the cart intents and
the service that writes a sale, ฿0 comp finalise, `GET /sales` and the Sale
detail view, member tier change, `seed:demo-day`, and pointing the till at the
tested engine instead of its browser copy in baht floats.

**Open, for whoever takes the next part:** a PARTIAL refund has no status of
its own — the plan lists five and `refunded` means fully refunded, so a
partial leaves `status = finalised` with `refunded_satang > 0`. Recorded on
the table; if S2-11 needs that distinction in a `where` clause it is a
decision to raise, not a column to add quietly.

**Two tooling defects found on the way.** (1) `scripts/snapshot.ts` picks the
LATEST snapshot as the previous one, so running it twice for the same tag
chains a snapshot onto itself (`prevId` = its own `id`) and silently corrupts
the migration chain — it happened here and was caught by hand. It needs to
take the previous tag, or refuse when the file it is about to write already
exists. (2) `scripts/verify-schema.ts` compares check constraints by name
only and ignores triggers entirely, so a check that allows everything, or a
deleted trigger, passes the gate that exists to catch schema drift.

### S2-09a — the till side of the cart and the sale (SCRUM-203) — **the till now prices from the platform's engine and writes what it sells**

**The hole this fills.** The entry above gave the sale somewhere to live. This
is the other end of the wire: until now the till priced the cart in the
browser, in baht floats, from the prototype's own copy of the rules, and
pressing Pay called `recordSale`, which pushes an object onto an array a
refresh empties. Both halves of that are now different.

**Where the number on the screen comes from.** One hook,
`src/lib/cartQuote.ts`, answers "what does this cart cost" for the staff
panel, the visitor's own display and the payment screen — the three surfaces
that must never disagree — and it asks the platform. The components were not
redesigned: `OrderSummary` and `CustomerDisplay` take an optional `totals`
prop in exactly the shape `computeTotals` already returned, so the layout is
untouched and only the source of the figures moved. A caller that passes
nothing (the party tab, the booking screen, the mobile cart sheet) prices as
it always did.

**Three sources, and the screen names the one it used.** The platform's quote;
failing that this device running **the platform's own engine** (`@oto/shared`,
integer satang, the tested one) when there is no pricing route on the
deployment, no station, or no answer; failing that the prototype's own
arithmetic, and ONLY when the engine refuses the cart outright. When it is not
the platform, a note appears under the total saying so — because a till that
has quietly stopped agreeing with the platform is the failure this ticket
exists to make impossible, and nobody at a counter can see it otherwise. When
it IS the platform nothing is drawn.

**The service landed in this tree while this was being written**, and the two
halves were reconciled against each other rather than against a guess:
`apps/api/src/routes/sales.ts` was built to the contract in
`apps/pos/src/api/sales.ts` and accepts the cart nested under `cart`, the
action id in the body or the header, and `finalise`. The till's client was then
aligned to what the route actually returns — `{ quote, ...quote }`, the totals
block, `rejectedPromoCodes` and `disagreements`. **No deployment carries either
half yet**, so today every till still shows the "priced on this till" note and
prices locally on the tested engine.

**Reading one half against the other found a defect no type-check could:
every call from the real till would have been refused.** The route requires
`z.string().uuid()` for a cart line id and a manual discount id; the cart mints
`Math.random().toString(36).substring(7)` for a ticket line,
`line-<checkInId>` for a drop-off child, `promo-<CODE>` for a free-item promo
line, and `md-<random>` for a staff discount. Not one is a uuid, so `POST
/sales/quote` and `POST /sales` would both have answered 400 and no sale would
ever have been written. `platformId` in `cartWire.ts` now translates at the
wire — a uuid passes through, anything else is derived deterministically from
its own text — and `localIdFor` translates the answer back, without which every
staff discount would have rendered as ฿0 under a correct total. 413 sample ids
check out as well-formed, unique and stable.

**That translation is a workaround and is labelled as one.** The cost: the
`cart_line_id` on a sale line is a derived value, so "this row came from the
promo line for ICECREAM" is no longer readable off the ledger (grouping within
a sale, which is what the column is documented for, still works). The real fix
is one of two decisions and neither is the till's alone — the platform accepts
the till's id as text, or the cart mints UUIDv7 everywhere, which needs
`freeItemLineId` in `@oto/shared` to stop encoding the promo code in the line
id. Raised on SCRUM-203; the function is written to be deleted in one edit.

**A ticket package id is deliberately NOT translated.** It is the platform's
own row key; inventing one would ask the platform to price a package that does
not exist. A till holding the prototype's seeded catalogue (`t-2h`) is refused,
which is correct, and the refusal is what the screen shows.

**What Pay does now.** `src/lib/saleWriter.ts` mints the sale's id (UUIDv7)
and an action id ONCE per press and reuses both for every retry of that press,
so three separate things have to fail before a second sale can exist: the
idempotency key (`sale:<id>`), the primary key on `pos.sale`, and
`sale_action_unique`. Nothing else happens until the platform has answered —
no receipt, no band, no wallet, no confirmation screen. A refusal leaves the
till on the payment screen with a panel that says the sale was not saved, says
whether trying again can help, and carries the sale number; pressing Try again
finishes the sale that was started rather than starting a second one. The
local record, the promo counters, the wallets and the paper now all hang off
`finalizeSale`, which runs only on success and carries the platform's own sale
id, so the row in the ledger and the record on the till are one sale by
number. **`MobileTill` goes through the same writer** — a second till quietly
selling into memory would be the same defect with a smaller screen.

**Where a sale is still saved on the till alone, and it SAYS SO.** Two cases:
the deployment has no sales route (today, everywhere), or the device is not on
a platform station. Both are certainties rather than doubts — nothing was
half-written and no retry can change them — so the confirmation screen carries
an amber "Saved on this till only" notice naming the reason, instead of
looking exactly like a saved sale. Every other failure is a real failure and
is not finalised at all.

**An async answer never lands on the next visitor.** The writer keeps its own
epoch, bumped by `reset()`, and both tills check `saleEpochRef` after the
await. The quote hook drops any answer whose sequence has been overtaken. This
is the defect the project keeps producing; the guard is the one already in
`Till.tsx`, used rather than reinvented.

**A drop-off line with no length chosen is not quoted at all.** The engine's
`findStaleLines` cannot tell "not yet priced" from "priced under another rate
mode" and says so at length, leaving the choice to S2-13. This till does not
make that choice: while such a line is in the cart the platform is not asked,
the running total stays the prototype's, and the existing preflight still
refuses to take money for it.

**`apps/pos` has no test runner, so the money was checked another way.**
`src/dev/checkCartPricing.ts` walks the seeded catalogue — 4 packages × 3
tiers × 5 cart shapes, weekday and weekend, plus a multi-line cart, order and
line fixed discounts, a comp and a fixed promo code — and asserts the engine
and the prototype agree to the satang. **69 of 69 carts agree.** Run it with
`cd apps/pos && node_modules/.bin/tsx src/dev/checkCartPricing.ts`. It is not
in CI and is not a substitute for one; it is what can be run today by anyone
who touches the pricing path, and it is deliberately blind to the shapes where
the two are MEANT to differ (rulings 1 and 2, and percent discounts now
rounding to the satang). A development-only divergence warning does the same
comparison in the browser on every quote.

It earned its keep immediately: it found `import.meta.env.DEV` read
unguarded, which is fine in Vite and throws under any plain node runner — the
one place a check like this would be run.

**Checked.** `apps/pos` typecheck clean; `pnpm --filter @oto/pos build` green
and byte-identical in bundle hash (the dev check is not bundled); `pnpm exec
eslint apps packages` reports two errors and both are another workstream's
(`apps/api/test/zz-verify-s207b.test.ts`) — `apps/pos` is in eslint's ignore
list, which is its own defect and not one this ticket closed. **Not
committed** — this tree is shared with two other workflows.

**One more edge, handled rather than left:** press Cancel while a sale is being
saved and the epoch guard correctly stops the answer landing on the next
visitor — but the sale is on the platform. Both tills now say so, by receipt
number, instead of leaving a sale nothing on the screen will mention again.

**Not done, and named rather than implied:** **no browser has driven any of
this against a running server.** Neither half is deployed, and the two were
reconciled by reading each other's code — which caught the uuid defect above,
and is still not the same as a request arriving. The S2-04/05/06 lesson applies
in full: a type that lines up is not a browser that reached the route, and the
first integration run is the next step on this ticket. What is proved: the
arithmetic (69/69 carts), the id translation (413/413), the typecheck and the
bundle. What is not: a single real request. Still missing from SCRUM-203
overall: the Sale detail view in the POS, the member tier change, and
`seed:demo-day`.

### S2-09a — the service and the routes (SCRUM-203) — **pressing Pay now has somewhere to land**

**What was missing.** The two entries above built the ledger and the till. The
wire between them did not exist: there was no `POST /sales`, so the till's
writer had nothing to call and every deployment showed "Saved on this till
only". `apps/api/src/services/sale.ts`, `apps/api/src/routes/sales.ts` and one
registration line in `app.ts` are that wire, with 28 tests in
`apps/api/test/sales.test.ts` that drive the real routes with a real reception
session and then read the rows out of Postgres.

**Five routes.** `POST /sales/quote` prices a cart and writes nothing;
`POST /sales` records one; `POST /sales/:id/finalise` allocates the receipt
number and closes it; `GET /sales` and `GET /sales/:id` are the day's list and
the Sale detail. Each declares its guard — selling takes `pos:sale:create`,
finalising `pos:sale:update`, reading `pos:sale:read`, and **a cart carrying a
discount of any kind is checked separately for `pos:sale:discount`**, because
"may take money" and "may decide how much less a guest pays" are different
questions and there is no manager-approval step behind them (R-08).

**The pricing engine now has two callers instead of one.** Everything the
route answers comes from `computeTicketCartTotals` in `@oto/shared` — the same
1,600 lines under the same 1,694-line suite that the public booking quote uses
and that the till now prices with. Nothing in the api re-derives a rule.

**Two rules decide whose number wins, and both are tested.**
*The price is the platform's*: the unit prices, the rate mode, the trading day,
the tax and every discount amount are resolved on this side from the catalogue
and the branch configuration. The till may send `expectedTotalSatang` and a
`lineTotalSatang` per line, and the only thing either can do is cause a
refusal — `SALE_TOTAL_MISMATCH` or `SALE_LINE_PRICE_MISMATCH`, with nothing
written. *The tier is resolved from the member*, never from the body: a sale
for James is priced expat because his record says so, and a walk-in gets the
operator's default tier. A request sending `tier: 'thai'` and its own prices is
priced exactly as one that sends neither — there is a test that does it.

**A sale line is a UNIT, and the units are the engine's own.** `cartUnits` in
`cart-totals.ts` was made exported (two words, no behaviour changed) so the
ledger stores what the engine computed rather than a second decomposition of
it in the api — the copy-of-the-rules defect this whole ticket is about. Each
category's post-discount base, service charge and tax are then apportioned
across its units by largest remainder, so the line rows sum back to the sale
exactly; the test asserts that on base, net, tax, service and gross.

**Receipt numbers** are allocated per station out of `pos.receipt_series`, the
row locked `FOR UPDATE` inside the same transaction, formatted `T1-000001`.
Consecutive within a station, and the high-water mark advances past everything
issued. A second finalise of the same sale returns the number it already has
rather than taking another.

**A ฿0 comp finalises; anything with a balance does not.** A fully comped visit
commits and finalises in one transaction, with the comp recorded as a
`sale_discount` naming the reason and the account that gave it, and the
subtotal still saying what the visit was worth. A sale that owes money is
refused with `SALE_NOT_PAID` — `pos.payment_attempt` has no status vocabulary
until S2-10a, so nothing can yet reduce what a sale owes, and that one
predicate (`outstanding`) is the single line S2-10a changes.

**The two halves were reconciled at the wire, in both directions.** The route
was built to the contract in `apps/pos/src/api/sales.ts` and takes the cart
nested under `cart` or flat, the action id in the body or the `x-oto-action-id`
header, `occurredAt`, `businessDate` on the list, and answers `{ quote,
...quote }` and `{ sale, replay }`. One test sends the till's exact payload —
nested cart, socks block, `packageName`, the tier and rate mode it believed —
and asserts the row that lands. What that reconciliation cost on this side:

- **Add-ons, socks, service fees, prepaid food and a free-item's item are
  priced from the till's snapshot when the platform has no row for them**, and
  the line records `payload.priceSource = 'till_snapshot'` when it did. The
  add-on catalogue is S2-09b and the prototype's ids (`a-locker`) are not
  platform uuids; refusing them would mean a park that cannot sell socks until
  that ticket lands. An id that IS a `pos.product` is priced from that row
  whatever the till sent — including its taxable category, so the seeded ice
  cream books to F&B — and there is a test for both halves.
- **A promo code arrives with its definition**, because there is no promo-code
  table to validate one against (S2-09b again). It grants no authority a staff
  member does not already have: it takes `pos:sale:discount`, it is recorded as
  a `sale_discount` row with its code and sequence, and it is audited. A code
  with no definition is refused by name and takes nothing off. The order is the
  engine's and therefore the prototype's — manual discounts first, then each
  code against the running balance — and the test asserts the sequence, not
  just the total, because reversing the two moves the bill.
- **A till clock more than 60 s from the platform's is called `skewed`** and
  the platform's instant is recorded, the same tolerance and the same rule the
  sync ledger already applies to a box (`CLOCK_TOLERANCE_MS`). The trading day
  is always the platform's, so a wrong till clock cannot move a sale onto
  another day's takings.

**Defects and decisions raised rather than buried.**

1. **`pos.sale_line.cart_line_id` is a `uuid` and the till's cart line ids are
   not uuids.** The till works around it by deriving one deterministically, at
   the cost of the column no longer naming the real cart line. The fix is a
   decision for one of the two sides — the column becomes text, or the cart
   mints UUIDv7 everywhere (which needs `freeItemLineId` in `@oto/shared` to
   stop encoding the promo code in the line id). Not taken here: it is a
   migration, and 0014 is already claimed in a shared tree.
2. **`sale_discount.allocations` is written null.** `computeTicketCartTotals`
   keeps the per-discount allocations internal and returns only the totals, so
   the reproducible record of where a discount landed is the sale's stored
   `tax_breakdown` plus the per-line split. S2-11 (refunds) is the ticket that
   needs them per instrument; exposing them means restructuring the engine's
   discount loop, which is not a change to make in passing.
3. **A refused sale cannot be retried under the same sale id with a corrected
   cart.** The till derives its idempotency key from the sale id, and a 4xx is
   stored like any other answer, so a second attempt with a different body gets
   `IDEMPOTENCY_MISMATCH`. That is the platform behaving as designed — a
   changed cart is a different sale — but it is a contract note the till has to
   hold: **after a refusal, mint a new sale id before retrying.**
4. **The demo reset would have failed on any day with a discount on it.** It
   deletes `sale_line` before `sale` but knew nothing about `sale_discount`,
   which points at the sale with `ON DELETE RESTRICT`. Two lines, fixed here,
   because leaving it would break the button the park's team use to start over.
5. Carried from the schema half: a *partial* refund has no status of its own,
   and `scripts/snapshot.ts` / `verify-schema.ts` both have the gaps named
   above.

**Checked.** api 643 tests (39 files), shared 197, print 209, telemetry 36, all
green; `pnpm -r typecheck` clean; `pnpm exec eslint apps packages` exits 0.
**Not committed** — three workflows share this tree.

**Still missing from SCRUM-203:** the Sale detail VIEW in the POS (the API
behind it is built), the member tier change, `seed:demo-day`, and the thing
neither half can claim yet — **a browser driving a running server**. The
routes have been driven with the till's own payload shape through Fastify;
that is closer than reading each other's code and it is still not a request
that crossed a network.

### S2-09a — the integration check (SCRUM-203) — **the three halves do not meet: a paid sale cannot be recorded**

**What was done, and why it is different from the three entries above.** Each
of those halves tested its own side. This drove a **real Fastify server on a
real port against a real seeded Postgres**, signed in over HTTP as the seeded
reception account, sent the till's **own commit body verbatim**, and then read
the rows out of the database rather than the response. Thirteen cart shapes,
the idempotency paths, the refusals, the scope checks and the freeze trigger.

**THE BLOCKER, and it is one line on each side.** The till sends
`finalise: true` on every commit (`apps/pos/src/api/sales.ts:802`). The service
refuses `finalise: true` while the sale still owes money
(`apps/api/src/services/sale.ts:1169`), because `outstanding()` returns the
gross until tenders exist (S2-10a). So:

```
quote  a tourist Full Day, 1 kid + 1 adult   → 200, gross 144000 (฿1,440)
commit the till's exact body, finalise:true  → 409 SALE_NOT_PAID
rows in pos.sale                             → 0
the same cart with finalise:false            → 200, one row, two lines, audited
```

**Every sale except a ฿0 comp is refused, and the screen tells staff the wrong
thing about it.** `isRetryable()` in `lib/saleWriter.ts` treats a 409 as a
judgement, so the panel reads *"Trying again will not help — the platform
looked at this sale and refused it. Go back, check the order, and call a
manager"* — for a fault that is in neither the order nor the manager's gift.
The claim is also written above the field that causes it:
`apps/pos/src/api/sales.ts:170` says *"฿0 comps and paid sales both finalise
here"*, and a paid sale does not. Which side moves is a decision, not a typo:
either the till sends `finalise: false` until S2-10a and the sale sits in
`tendering` with no receipt number, or `outstanding()` counts the till's
`paymentMethod` as money taken. **Until it is taken, SCRUM-203's acceptance
criteria cannot pass.**

**Second blocker: after any refusal the cart can only be sold by throwing it
away.** The sale id — and the idempotency key `sale:<id>` derived from it — is
minted once per Pay press and cleared only by `reset()`. `handlePaymentBack`
(`Till.tsx:1672`) does not clear it. Proven live: first attempt refused,
corrected cart under the same key → `409 IDEMPOTENCY_MISMATCH`, also
classed non-retryable. So *Back to the order* → fix the order → Pay answers
IDEMPOTENCY_MISMATCH for ever, and the only escape is Cancel, which discards
the visitor's whole order. The service half's own contract note 3 predicted
the mechanism; the till was not changed to mint a new id.

**Third blocker: a branch-scoped account can write a sale at a branch it has no
permission on.** `POST /sales` and `POST /sales/quote` declare
`permission: 'pos:sale:create'` with **no `target`**, so the scope is never
checked against `cart.branchId`. As the seeded reception account, scoped to
HKT Central alone, with a second branch and its own station and package:

```
quote for the other branch          → 200
commit  for the other branch        → 200
sale row branch_id                  → the other branch  (station: its own)
GET /sales/:id for that same sale   → 403
```

The 403 on the read is the proof the write should have been refused too.
`POST /sales/:id/finalise` (`pos:sale:update`, no target) has the same hole: it
reached SALE_NOT_PAID rather than 403, so a ฿0 sale at another branch could be
finalised from here and consume that station's receipt number.

**Defects, smaller.**
1. `sale_line.revenue_category` is NULL on every row written (34 of 34). The
   schema comment defers it to S2-09b, which is honest, but S2-09a's own
   acceptance criterion says the Sale detail view shows it populated and
   `getSaleDetail` returns the null. Not a thing to close quietly.
2. **Removing a holiday now fails.** `sale.holiday_id` is `ON DELETE restrict`
   and `DELETE /branches/:branchId/holidays/:id` (`routes/catalog.ts:474`) hard
   deletes. Once one sale has been rung up on a holiday date the admin panel's
   Remove raises an unhandled Postgres 23503
   (`sale_holiday_id_branch_holiday_id_fk`). An existing screen broken by this
   round's schema; `archived_at` is on the table and is the path the route
   should take.
3. A replay returns `lines: []` (second identical commit → 200, `replay` true,
   no lines). Nothing reads them today.
4. `GET /sales` with no `branchId` **and** no active branch on the session
   queries the whole operator with no branch check. Narrow — every seeded
   account has an active branch — and one line to close.
5. **The confirmation screen and the receipt still carry the prototype's
   total, not the platform's.** The amount due on the order panel and the
   payment screen is the platform's (`cart.totals.total`), and so is the
   stored sale. But `finalizeSale` in both tills builds the local record with
   `buildSale(...)`, which recomputes the total through the prototype's
   `computeTotals`, and that record is what StepConfirmation, the printed
   receipt and the prototype's History and Today read.
   `MobileConfirmation` (`MobileTill.tsx:94`) does the same for its VAT lines.
   The two arithmetics agree on the 69 carts the till's own check covers and
   are **documented to differ** on stacked or scoped promo codes and on
   percent discounts: `manualDiscount.ts:11` rounds a percent discount to the
   whole baht (`Math.round(base * pct/100)` on a baht base) while the engine
   works in satang. So a 10 % staff discount on an expat 2-hour ticket (฿623)
   takes ฿62 off on the receipt and ฿62.30 off in the ledger. Pass the
   platform's figures into the sale record rather than recomputing them.

**What was proved to work, and these were driven, not read.**
- **One price, not two.** Quote total equals the stored `gross_satang` on all
  thirteen shapes: weekday, a holiday range covering today (weekend prices),
  tourist / expat / thai, the free-adult rule, an overflow adult, socks,
  a fixed staff discount, a percent staff discount, a promo code, and a ฿0
  comp. The sum of the line `gross_satang` equals the sale's.
- **The tier is the member's.** Sending `tier: 'thai'` for James (expat) priced
  him at 62300 and stored `customer_tier = expat`.
- **The ledger row carries what the ticket asked for**: business date
  2026-09-21 against a 05:00 day start, `business_day_start` and `timezone`
  frozen on the row, station, box, account, pricing mode and its reason,
  holiday id and name, engine version, the tax configuration and the whole
  breakdown as snapshots, and the four-way net / service / VAT-inside /
  VAT-on-top split.
- **Pressing Pay twice.** Same id twice → one row and `x-oto-replay: true`. A
  new id under the same action id → `409 SALE_ACTION_REPLAY`. Two genuine
  presses → two sales. A connection aborted mid-flight → exactly one row, and
  the retry returns it.
- **Paying less than quoted is refused**: `SALE_TOTAL_MISMATCH` on the order,
  `SALE_LINE_PRICE_MISMATCH` on a line.
- **No session** → 401 on quote, commit and list.
- **A ฿0 comp** finalises: status `finalised`, receipt `T1-000001`, the
  station's series advanced to 2, and a `sale_discount` row naming the reason,
  the amount and who gave it.
- **The freeze trigger fires**: an UPDATE on a finalised sale is refused by the
  database.
- **A skewed till clock cannot move a day's takings**: six hours out →
  `clock_trust = skewed`, the platform's instant and trading day; an
  unparseable clock → `untrusted`.
- **The totals did not change where they were already right.** OrderSummary,
  CustomerDisplay and StepPayment each take an optional `totals` prop that
  falls back to `computeTotals`, so every caller that is not the Till is
  untouched; the Till hands one hook's answer to both the staff panel and the
  visitor's screen, so the two cannot disagree.

**Verdict: not ready for `main`.** The schema and the service are sound and the
pricing is right. The seam between the till and the service is one boolean
wide, and on the wrong side of it the park cannot take money.

**Checkpointed anyway, so nothing is at risk: branch
`wip/s2-09a-sales-ledger` at `4a34037`, pushed.** The whole slice and these
documents are on it, and nothing else — the sync/box edits and
`render.yaml`/`services/` in the working tree belong to two other workstreams
and were left alone. `main` stays at `14201bc` and the working tree was not
disturbed, so neither of those workflows lost a step. Resume on the branch by
taking the finalise decision above.

## S2-10a — the tenders (SCRUM-206) — landed 2026-09-23

Six of the seven slices are on `main`. Each was built by its own agent, held at
an independent gate, and committed only on the gate's verdict. The ticket stays
**In Progress**: Slice F is not started, and nothing in tonight's evidence shows
a guest paying end to end from the till.

**A — the tender ledger. Landed 2026-09-23 at `3317360` (16:36).** Migration 0019
widens `payment_attempt` and adds `payment_method` and `payment_notification`,
with the shared payment vocabulary and `finaliseSale` resolving the method token.
*Gate: MERGE on the fix round* — the full api suite 1,156 green, two-database
dumps identical, five plants. Its first pass was refused: the schema was sound
but the one writer of `payment_attempt` still supplied the old column set, and
the gate found a vendor void password typed into a test fixture, replaced with a
placeholder before anything was committed.

**E — payment methods on the platform. Landed 2026-09-23 at `8ee9a5d` (17:27).**
Five thin routes under `/payment-methods`, the prototype's rules in
`services/payment-methods.ts`, the back office saving for real, tenders hydrated
on every catalogue load. *Gate: MERGE* — 20 tests, three plants. Carried forward:
a sale can still be recorded against a disabled or archived tender (**SCRUM-382**).

**B — the cash tender. Landed 2026-09-23 at `a232059` (18:10), completed by
`b616191` (18:12).** The attempt ledger through `services/payments/attempt.ts`,
part-paid sales (O-5), the replay net on `action_id`, the drawer kick as a box
command, and payments listed on the Sale detail. *Gate: MERGE on the fix round* —
the full api suite 1,203 green, the header-path retry proven both ways. Its first
pass was refused on one blocker no test could see: the drawer kick ran under the
request's idempotency claim after the finalise had written its answer, so a
retried cash finalise would have replayed the command instead of the sale. The
second commit added `routes/webhooks.ts`, which the first commit's file list
missed.

**C1 — the card terminals on the box. Landed 2026-09-23 at `51fd025` (18:19).**
The `PaymentTerminal` contract, the GHL and Digio adapters, two simulators
answering on the same bytes, 22 cited fixtures, the per-terminal reference
counter as a `box_counter` scope (O-3). *Gate: MERGE, after two refusals* — both
on statements in comments that were not true of the code (the amount-mismatch
rule's reach, and a claim that a wire frame could not reach a log), corrected by
hand before the commit. 251 box-agent tests.

**C2 — the card tender in the cloud. Landed 2026-09-23 at `83ffc36` (19:29).**
`services/payments/terminal.ts`, the `/payments` routes, the box's result route
under a box credential, and the Console's terminal simulator panel. *Gate: MERGE*
— 22 + 5 tests end to end through the real command queue and result route, four
plants. Proven on staging the same evening: approved in 4.4 s with the TID, MID
and reference learned onto the device row; declined in the vendor's own words; a
partial approval refused and voided on a fresh reference; the PAX's no-answer
path walked to `not_found`. Raised from its gate: **388**, **389**, **390**.

**D — the 2C2P QR tender. Landed 2026-09-23 at `24e608d` (20:12).**
`packages/payments-2c2p` on `node:crypto` alone, `services/payments/gateway.ts`,
the signed webhook, two jobs, 19 `PGW_*` variables and the Console's gateway
simulator panel. *Gate: MERGE on the fix round* — the boot guard 20/20, the full
api suite 1,282 green, six findings folded in. Its first pass was refused because
an unguarded read of `PGW_MERCHANT_ID` masked every production boot-guard
assertion. On staging the announcement holds but **the QR path has no caller**:
`openQrAttempt` is reached by nothing outside its own test and `payment_routing.qr`
has no reader, so a `qr` tender still goes to the station's card terminal
(**SCRUM-391**).

**G — offline sales. Landed 2026-09-23 at `d435db4` (20:47).**
`services/payments/offline.ts` replaying through B's commit and finalise, `box_seq`,
the `sale.finalised` and `payment.recorded` sync handlers, the box's sale queue
with provisional receipts, and the drawer pulse with `case 'drawer_kick'`. Landed
after a fix round that closed the two blockers its first gate found: the offline
price guard was opt-in, so nothing capped what a box could bank; and no test
reached the drawer-kick case while a test title claimed it. **Its staging pass held
on every point** (21:02–21:08: an offline cash sale replayed once, a re-send
answered with both receipt numbers, the drawer opened on the command) and is on
the ticket. O-2 — whether this half
belongs to SCRUM-206 at all — is still the owner's.

**F — the POS payment stage — not started.** Its first item is the D↔C2 seam:
route a `qr` tender to the gateway when the station's `qr` routing says gateway
(**SCRUM-391**), then drive the QR path on staging. After that, the payment stage
itself on all four tills — cash keypad, card states, QR on the display, manual
entry and split — and only then SCRUM-206's end-to-end Deployed evidence.

## D-3 — the two payment status vocabularies, mapped once (S2-10a, SCRUM-206)

`docs/architecture/PAYMENT_GATEWAY.md:594-613` describes a QR's life in one set
of words and the ticket's `pos.payment_attempt.status` CHECK uses another.
Neither document maps one onto the other, and the risk is not ambiguity but
divergence: each slice inventing its own reading makes the Attempts list on a
Sale detail unreadable, because "cancelled" would mean three different things
depending on which writer produced the row. The mapping below is the only one.
It lives in code at `packages/payments-2c2p/src/contract.ts`
(`GATEWAY_STATE_TO_ATTEMPT_STATUS`), is used by
`apps/api/src/services/payments/gateway.ts` and by nothing else, and
`packages/payments-2c2p/test/wire.test.ts` checks that every gateway word is
covered exactly once and that every answer is a word the column's CHECK allows.

| Gateway word (§3.2) | `payment_attempt.status` | Why |
|---|---|---|
| `created` | `created` | The row exists; nothing has been asked of the gateway. |
| `qr_shown` | `sent_to_terminal` | The QR is on the display and the till is waiting. The ledger's word is about instruments generally, and a display is this tender's terminal. |
| `pending` (`0001`/`2001`) | `sent_to_terminal` | 2C2P has it and nobody has paid. A fact about their record, not about our screen, but the same state to a till. |
| `paid` (`0000`) | `approved` | And only with the amount **and** the currency matching. |
| `expired` (`5009`/`9020`) | `cancelled`, plus `payload.expired = true` | The ledger has no `expired`, and `declined` would be a lie: nobody refused this payment, the clock ran out on it. The flag is what tells the two apart on the row. |
| `cancelled` (`0003`) | `cancelled` | Staff or the guest abandoned it. |
| `late_paid` (`5017`) | `awaiting_staff_confirmation` | Money for a sale somebody has probably already settled another way. Never `approved` without a person: apply it or refund it is a judgement about a guest who is standing there or has gone home. |
| `amount_mismatch` (`5015`/`5016`) | `awaiting_staff_confirmation` | `PAYMENT_GATEWAY.md:612-613` is explicit — these never mark a sale paid. |
| `not_found` (`2002`) | `not_found` | Our invoice never reached 2C2P. A fault on our side of the wire, not a guest who declined. |
| `duplicate_invoice` (`5005`/`9015`) | `declined` | We reused an invoice number. Our bug, and the attempt cannot be settled against a payment belonging to an earlier one. It also raises a critical alert, because a number generator is what has to be fixed. |
| `refunded` (`4120`) | *not written* | S2-11's word. `refund()` reports it; this slice never writes it. |
| `failed` (anything unread) | `unknown` | The honest word for a code nobody here has read. |

Two codes are deliberately not payment states at all. `9999` means 2C2P could
not reach **our** webhook, which is a fact about our availability and says
nothing about the money. `1005` is a payment-*flow* code that arrives on Do
Payment rather than on an inquiry, and it means the QR is up.

### Slice D's fix round — what the gate found, and what changed

**The blocker.** `resolveGatewayProvider` read `PGW_MERCHANT_ID` and
`PGW_SECRET_KEY` unguarded, and `assertProductionSafe` now calls it. The boot
guard's own tests build a **partial `Env`** naming only the fields each rule
reads, so every production assertion in `apps/api/test/boot-guard.test.ts` threw
a `TypeError` before reaching its own check: twelve tests about the database,
the storage credentials, the cookie, the demo controls and the seed profile
stopped testing what they are named after. Both reads are now
`(x ?? '').trim()`, and the production gateway refusal is unchanged. Card
`206-D-4-the-boot-guard-that-could-not-fail.png` plants it again: 12 failed of
20, green on restore.

The rest of the round, each with a test where behaviour changed:

- **An absent `currencyCode` is a mismatch**, not a pass. It is mandatory on
  both the notification and the inquiry (`PAYMENT_GATEWAY.md:296`), so a
  delivery cannot release money by leaving the field out: the attempt goes to
  `awaiting_staff_confirmation` and the sale stays open.
- **The webhook's path token is validated loosely and refused inside.** A
  `max()` on its schema made an over-long token a **400** from the validator,
  before the handler ran, and a 400 is what makes 2C2P redeliver all evening.
- **The poller reads oldest first.** A tick reads at most 200 waiting attempts;
  newest-first meant that past 200 the oldest were never read at all — never
  inquired about, never reaching the exhaustion rule. Asserted on the query's
  own `order by` rather than on 201 planted rows.
- **`paid_at` is our own clock, not the gateway's stamp.** `transactionDateTime`
  arrives as `yyyyMMddHHmmss` with **no time zone stated anywhere** in
  `PAYMENT_GATEWAY.md` (`:297`, `:349`); the only zones the document does state
  are the acquirer cut-offs and the business date, both Asia/Bangkok. Since
  `paid_at` feeds end of day (S2-15a), reading a Bangkok stamp as UTC would move
  a payment across a business-day boundary. The stamp is kept unparsed on the
  attempt's payload as `gatewayStamp`, for support and for whoever settles the
  zone in the first sandbox session. **Open question for that session.**
- **`isAboutTheMerchant` is now called** where a non-paid state closes an
  attempt: `9999` says nothing about the payment, so it must never cancel one.
  The status filter already dropped it; the call is what says why.
- The poller job's comment said "roughly 3,000 at ten seconds"; 86400/10 is
  about 8,600.

## Deviations recorded

(None yet — the plan lists the ones it expects: booth order, Pi image, edge +
jobs inside api, face-scan removal, occupancy model, OTO App lifted as-is,
2C2P kept over a bank API.)
