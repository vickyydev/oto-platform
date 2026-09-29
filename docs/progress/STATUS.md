# Current status - read this first when resuming

## Release checkpoint - 29 September 2026 late evening

The no-reader API85d35e0 is LIVE. Both retired mailbox endpoints return404
and the ordinary authenticated station read returns200. Forward migration0033
now removes only the two old session lookup columns. The existing database
checks pass43/43, schema verification matches the0033 snapshot, and DB
typecheck/lint pass. The populated-upgrade test preserves account, park,
station and staff-session identity. Independent snapshot review found no
unrelated change.0033 is checked and pending the final API deployment.

After0033 is applied, the earliest rollback-compatible API is85d35e0 or a
verified descendant. Never restore88140af or an older API against this schema.
Physical display credentials, staff sessions and station leases are retained.

SCRUM-201 remains In Progress. Shop native proof passes; its display layout
is under visual review. Consent native proof found accepted acknowledgement
loss on unlock while a fresh quote rotated the prompt. The bounded fix pauses
typed prompt publication during online quote refresh;92 POS checks pass and
the focused browser retest is running. Real offline and private policy changes
still invalidate stale answers. Foundation staging screenshots10908-10916
are attached; final guest-order/consent staging proof remains.

SCRUM-285 is Deployed with screenshot10905. SCRUM-206 stays In Progress:
partial reversal plus cash, disabled QR plus cash and zero-value finalisation
pass native staging checks. A running GHL simulation was stranded when the
API deployed during its no-response wait. It is retained for safe recovery;
no second SALE, invented confirmation or cash was sent. The existing payment
follow-up must fix restart recovery and prove the result before final release.
The older retained uncertain simulation is untouched. Full offline trading
still depends on separate To Do SCRUM-269; no new ticket is being started.

The requested break follows completion of current checked work, staging
verification, Jira comments/statuses and a final saved stop point. Manual
Render releases are authorised; normal autoDeploy/checksPass remains intact.
GitHub billing prevents jobs starting and no new CI-packed Pi artifact exists.

## Previous checkpoint

_Last updated: 2026-09-29 - saved-child display review checked locally._

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

The last green CI-packed Desktop pair is `oto-box-0.1.0-0468c38.tgz`
and its `.tgz.sha256`, verified SHA-256
`044edbb9a474a945eadcc91e82598bee86b7b3f472e1630b79dceabcd1fbf1ea`.
Older pairs are in `old-oto-box-releases`. No physical Pi installation was
performed. Download the new exact-source CI artifact only after green CI and
LIVE staging, verify its checksum and replace the Desktop pair as documented.

The earlier releases below are retained as history.

OTO Park has completed the physical Lucky Wheel bench test and shared the
walkthrough. Sprint 2 now resumes in the documented order: SCRUM-391 (QR
routing), SCRUM-388 (pending money reservation), SCRUM-382 (unavailable
tenders), then SCRUM-206 Slice F across the four tills.

The three source changes are on main at `b02f7e0`, with the work branch
`fix/payment-prerequisites` preserved. SCRUM-388
now checks every new tender under the sale lock: accepted money and unresolved
attempts leave only the unreserved balance available. Declined, cancelled and
not-found attempts release their reservation. Outstanding remains the amount
actually unpaid, so a pending attempt cannot close a sale. All 21 existing
cash-suite tests and 23 offline replay tests pass, including simultaneous
presses and cash/manual bypass. API typecheck, changed-file lint and an
independent money/locking review pass.

SCRUM-382 now refuses disabled or archived methods with
`PAYMENT_METHOD_UNAVAILABLE`, including the legacy card alias. A live replacement
wins over archived history; classification fallback remains only for an absent
row. All 23 existing method tests pass. Offline money refused by this rule is
retained in quarantine, with no partial sale; after correction, Console Replay
applies it once. That recovery passes in the existing 23-test sync file.
The shared taken-status list and drawer audit comment follow-ups are included.

SCRUM-391 now dispatches QR using the station's saved gateway/terminal/disabled
setting. POST and polling responses carry the shared attempt vocabulary plus
nullable QR payload, image and expiry metadata. Retries keep their original
route even after routing changes or payment; external gateway calls happen
after the durable attempt commits. The existing gateway and terminal files pass
66 tests, including paid-after-disable and final HTTP idempotency replay.

The three separate commits are reservation `e333994`, method availability
`c0aefae`, and routing `b02f7e0`.
All three tickets are Deployed in active sprint id 3, Sprint 2. Seven existing
API files pass 196 tests; API typecheck, changed-file lint and independent review
pass. No new suite, migration or dependency.

[Main CI 36486990526](https://github.com/vickyydev/oto-platform/actions/runs/36486990526)
and the final branch run 36485272336 are green. One deployment put API, POS,
Console, Launcher and Booth live on `b02f7e0`; the OTO App remains on `c416065`.
All 21 staging behaviour checks passed after the resumed instruction authorised
the scoped proof. Saved QR routing, callback-free recovery, unavailable tender
refusal and pending money reservation work. The dedicated proof configuration
was disabled or archived; test sales remain in audit history. Six reviewed
screenshots and the sanitised [report](../qa/payment-prerequisites/README.md)
are saved. Jira attachments 10855-10860 provide native Console/POS screens and
clearly labelled API test-run cards. The History capture used the native station
picker and reused the passing checks without repeating financial tests.

Main now includes the Slice F foundation and current release batch at `5fb8525`.
Exact-source branch CI 36521169654 and main CI 36521266122 are green. Main passed
on one failed-job rerun after an existing concurrent voucher assertion; no
voucher source or test was changed. One staging deployment put API, POS,
Console, Launcher and Booth live on `5fb8525`; the OTO App remains `c416065`.
The foundation adds the cloud payment client, keeps partial
tenders in the writer's committed state, gives deliberate split parts separate
stable identities, and closes settled payments with explicit `NO_TENDER`.
Late responses are fenced by sale identity and epoch, including cart changes,
reset and unmount. All 38 tests in the existing sale-writer file pass, as do
POS typecheck, package lint and independent review. The foundation is deployed.
SCRUM-387 is Deployed on main: first-transaction response ownership, complete
inquiry/confirmation envelopes and public sale/print responses are implemented;
all 147 tests in five existing files, API typecheck and lint pass. Test print
and reprint now commit their job, command, audit and complete answer together;
six failure/retry cases prove rollback and one effect.
SCRUM-452 is Deployed on main: the Lucky Wheel gets a ten-second default and a
Console draft setting for whole seconds from 2 to 20. Migration 0028 passed
22 existing database tests and DB typecheck/lint; shared and wheel tests and
all touched front-end/API typechecks and lint pass. Existing API booth files
pass 44 tests (84 tests across the spin-duration changes).
SCRUM-387 is committed as `233113e` with atomic print follow-up `5fb8525`;
SCRUM-452 is `3dd57d4`. All six replay checks and nine duration checks passed.
Reviewed evidence is attached to Jira: replay card 10861, duration screenshots
10862-10867. Duration measured 12,015 ms online, 12,006 ms after offline
restoration and 10,002 ms at the default; every print followed the visible
reveal. The wheel proof used native staging assets on an isolated local box.
Dedicated proof inventory was archived; existing booth versions are unchanged.
See [duration evidence](../qa/booth-spin-duration/README.md).

The CI-packed `oto-box-0.1.0-5fb8525.tgz` and its `.tgz.sha256` are on the
Desktop, verified against SHA-256
`f82baa9a6053df514ebfd75a27529aba25b44b33d6ca012aba61b704c61a49f2`.
The older pair is in `old-oto-box-releases`. Update the physical Pi using
[the Update guide](../ops/PI_BOOTH.md#7-checking-and-fixing) before publishing
a non-default duration. This session did not install it over SSH.

The four-screen Slice F UI checkpoint `cf67d86` is pushed on
`feat/payment-stage-ui` under `test-results/payment-ui-worktree`.
The till, handheld till, food station and shop share one controller; the mobile
food-station caller is included. The existing writer suite passes 53 checks;
POS typecheck, package lint and production build pass. The GHL capability guard
permits staff confirmation without offering unsupported inquiry. This separate
source checkpoint has green branch CI 36523891229 and is not deployed;
native staging UI proof is still pending.
Its complete offline and separate-display acceptance
also needs the existing SCRUM-269/285 and S2-08 seams. Real 2C2P sandbox
confirmation still needs credentials; the simulator is available for approved proof.

## Historical checkpoint - 28 September

_Last updated: 2026-09-28, 23:23 Bangkok - physical bench walkthrough captured._

The owner reports the physical Pi update is working. A live Console inspection
at 23:12-23:16 confirmed FortuneWheelBox (booth-1), FWBooth1 (prefix B1), the
reachable Booth Voucher Printer, and published/running wheel configuration 5
with seven active prizes. Today's booth totals match: 24 spins, 24 printed,
zero redeemed. Three 22:57 prints continued while cloud calls failed; all three
are now in the cloud ledger and the box's outbox is zero. Fifteen earlier spins
are unattributed and one has an uncertain-clock flag. A pending draft sort-order
value was left unchanged. See the [15-step walkthrough](../qa/booth-walkthrough/README.md),
also saved on the Desktop as PDF and numbered screenshots. This follow-up under
SCRUM-451 changes only documentation and does not deploy an application.

Bench round 1 WORKS on staging. Four feature commits are on main:
- SCRUM-448: `8df6482`, print when the result is revealed.
- SCRUM-449: `94042b3`, button-only staff selection, five-digit pad and staff menu.
- SCRUM-450: `652d933`, five-digit PIN set/generate/expiry/remove, migration 0027.
- SCRUM-451: `b9d68e3`, Vouchers ledger/CSV, booth Spins and setup checklist.

The stopped `wip/bench-round-1` remains intact. Its useful changes were reviewed
and completed from main `5c0eb91`, rather than merging the unchecked branch.
All four tickets are in sprint id 3, linked to SCRUM-198, and Deployed with
named staging screenshots attached (attachments 10841 through 10848).

[CI 36432299165](https://github.com/vickyydev/oto-platform/actions/runs/36432299165)
is green, including typecheck, lint, existing tests, migration replay, builds,
Pi packaging and Console browser checks. No new test suite was added.
API, POS, Console, Launcher and Booth are live on `b9d68e3` after one deployment;
the OTO App remains on `c416065`. The final documentation push skips deployment.

The staging proof used Booth 2 (proof) and a simulated receipt printer. Staff
selection and all five PIN digits used only Space gestures. The spin returned
queued, and the print call arrived 6,651 ms later with the result visible; it
printed, repeated safely, and refused an unknown spin with 404. Five-digit PIN
generation, setting, expiry storage, invalid-length refusal and removal passed.
The same printed voucher appeared in Spins, Vouchers and CSV. Temporary booth,
staff, PIN and screen settings were restored. Screenshots and the measured report
are in [bench-round-1](../qa/bench-round-1/README.md).

The CI-packed `oto-box-0.1.0-b9d68e3.tgz` and its `.tgz.sha256` are on the Desktop.
Both the download and Desktop copy matched SHA-256:
`ab4f98cff2408f9ac8f5f6b610e82bb46155d52fd27d43e5654d9bce455b3a0d`
The previous Desktop release pair is in `old-oto-box-releases`.

Next is the owner's physical demonstration video, matching a fresh printed slip
to its row in the Console. The owner performed the Pi update; this session did
not install it over SSH. [PI_BOOTH.md, Update](../ops/PI_BOOTH.md#7-checking-and-fixing)
remains the update guide. Counter-issued rows do not record an issuing
station in the existing table; the ledger says so rather than inventing one.

The newest STOP POINT in SESSION_HANDOVER.md is authoritative. The sections below
retain the earlier sprint background; their dated figures are historical.

## Where we are

- **Sprint 1 is complete** and reviewed by the owner (tag `sprint-1`): accounts,
  scoped permissions, audit, idempotency, file storage, members, children, tier
  verification, catalogue, pricing, tax, public booking. Report:
  `SPRINT_1_REPORT.md`.
- **Sprint 2 is being built, and most of it is now live on staging.** The suite
  launcher, the Console, stations and boxes, the box agent's sync core and print
  pipeline, the Lucky Wheel booth, the sales ledger and the F&B/shop lanes, the
  member and booking work are all deployed. On 24 September at 06:29 **137 tickets read
  Deployed** (SCRUM-392, 204 and 202 joined that morning), 2 are In Progress
  (SCRUM-191, 206), none are in Testing and 62 are open (SCRUM-393 was raised
  on the 24th).
- **Money can now be taken.** SCRUM-206 (S2-10a, tenders) is the work of the day:
  six of its seven slices landed — the tender ledger (`3317360`), payment methods
  admin (`8ee9a5d`), the cash tender and part-paid sales (`a232059`+`b616191`),
  the card terminal adapters on the box (`51fd025`), the card tender in the cloud
  (`83ffc36`), the 2C2P QR tender with its signed webhook and gateway simulator
  (`24e608d`), and offline sales replay with the box's own drawer kick
  (`d435db4`). **Slice F — the POS payment stage — is not started**, and
  SCRUM-206 stays In Progress.
- **S2-09 (checkout and sales ledger) is closed — Deployed on the 24th at
  06:27.** S2-09b's two halves are on `main` (`f5e5572` — every screen reads
  members from the platform; `4cad79e` — a shop product carries its sizes, the
  shop screen asks for one, a box scan lands on the shop screen) and proven on
  staging. The one gap found there — a scan never reached the shop screen,
  because the POS site's `/api/*` rewrite holds the station channel's stream
  back — was **SCRUM-392 (High)**, fixed at `003dac7` (the screen polls when
  the stream cannot open) and proven on staging at 06:14; 392, 204 and 202 are
  Deployed.
- **The repository is the suite monorepo**: platform at the root, docs split by
  purpose, `imports/` as the local-only drop zone. Remote:
  `github.com/vickyydev/oto-platform` (private).
- **Everything the park runs has been read**: the three real apps
  (`../architecture/EXISTING_SYSTEMS.md`, `intake-2026-09-19/`), the OTO App
  production dump (structure only), the wheel specification, the previous
  developer's POS rules (`../briefs/POS_BACKEND_LOGIC.md`, reconciled in
  `../architecture/POS_RULES_RECONCILIATION.md`), the proposal document for the
  OTO App (`../briefs/AGENCY_PROPOSAL.md` — what that contract still owes), the
  park's hardware reference and the four gate documents
  (`../architecture/DEVICE_INVENTORY.md`), the Inbox prototype
  (`../features/inbox.md`).
- **The owner's direction of 2026-09-20** (`../briefs/OWNER_DIRECTION.md`) sets
  the sprint: one sprint, in priority order — (1) the POS complete with the Lucky
  Wheel booth, on simulators of the park's real devices and with real QR payments
  through the 2C2P sandbox; (2) the OTO App on the central database with one
  sign-on; (3) Radar live with a per-branch source preference; (4) the Unified
  Inbox data pillars and a styled shell.

## What is next

**The Lucky Wheel booth is the first priority (owner, 24 September, afternoon):**
the Pi as a real box beside the virtual box, voucher redemption at the till,
switched-off prizes off the wheel, staff sign-in by account or PIN with an
admin-set session length, then a closing audit and the owner's bench test. The
plan is `plans/booth/PLAN.md`; the audit behind it is `plans/booth/AUDIT-2026-09-24.md`.
Rounds 1 and 2 landed (`1de320c` the Pi runtime, `13a6e70` the redemption api,
`c4f8b4e` the till, `9673e39` the Console; 398, 399, 400, 207 and the four Bugs in
Testing). The end-to-end proof on staging held at 9673e39 (a real box process on this
machine, the slip decoded from the printer bytes, the voucher redeemed once at the
staging till) and the eight booth tickets are Deployed (03:41). The closing audit's fix
round landed as `79a1c0e`…`4d0e24e` (the eight lanes); its 29 follow-ups are
SCRUM-401…429; the Pi release is packed at `4d0e24e`. The staging proof of the four
big fixes held at `8ffe856` (three small History gaps → SCRUM-430, Low). **READY for
the owner's bench test**: the release `oto-box-0.1.0-8ffe856.tgz` is with him, the
guides are `docs/ops/PI_BOOTH.md`, `BOOTH_SETUP.md` and `COUNTER_VOUCHERS.md`, the
bench steps are in `plans/booth/PLAN.md`. Everything below waits behind the bench.
While he benches, the audit's small follow-ups land as quick rounds (the handover's
"Quick rounds after READY"): SCRUM-409, 411, 413, 414, 417, 418, 424 and 427 are
**Deployed** on staging proof; 420, 429 and 430 are on `main` in Testing (small
remainders → SCRUM-435 and the next quick round); the proof pass raised SCRUM-432–437.
SCRUM-401 (`4dfcb34`) and 402 (`7b360cd`), the two Highs, landed on Opus with gates
and are Deployed with 409–437's screen-facing set on the second proof pass; 406, 408, 431 and
438 are Deployed on the third proof pass (CI fixed at the root in `64d856e`); 439 is Deployed; 403,
444, 440, 442 and 423 are in Testing; 433 is in In Progress with its round running (migration
0025); 443 waits on the owner's choice for the branch chip; 446 and 447 are new from 403's gate. The owner's rule since 25 Sept: small
defects on Fable quick rounds, stories on Opus with full gates.

**Then the recommended order, still the owner's to confirm**, with the reasoning in
`SESSION_HANDOVER.md`:

1. The D↔C2 seam and **SCRUM-391** — a `qr` tender never reaches the gateway —
   then drive D's QR path on staging end to end.
2. **SCRUM-388 (High)** — reserve in-flight tenders, before Slice F.
3. **SCRUM-382** — refuse a disabled or archived tender in the attempt service.
4. **Slice F** — the POS payment stage on all four tills — then SCRUM-206's
   end-to-end Deployed evidence.
5. The Console and box items (378, 381, 385, 386, 387, 389, 390), the promotion
   items (373, 374, 375, 368), the small light-theme and till items (370, 372,
   379, 380), then testing (369, 383).
6. The owner decisions listed below.

## The staging deployment

Render project **OTO Platform** in the Oto dev workspace, environment `staging`:
Postgres 16, and six services — `oto-api-staging`, `oto-pos-staging`,
`oto-console-staging`, `oto-launcher-staging`, `oto-booth-staging`,
`oto-app-staging`. All six auto-deploy on a push to `main`, but only once the
GitHub checks are green. On 28 September at 21:25 Bangkok the first five are live
at **`b9d68e3`** and `oto-app-staging` at `c416065`, which deploys only on its own files. The full account is
`DEPLOYMENT_STAGING.md`; the topology is `../architecture/DEPLOYMENT_TOPOLOGY.md`.

Two rules that cost time today, now recorded in memory `oto-render-staging`:
compare **every** service's live commit before calling a ticket Deployed (one
service's auto-deploy trigger had been off for three days), and anything a screen
cannot work without is converged by `platform-sync`, never left to the demo seed
(SCRUM-384 — staging's payment-method table was empty after a deploy and the till
could not take money).

## Blocked on the owner

1. **Which gateway portal the park holds** — a 2C2P sandbox merchant
   (developer.2c2p.com) or an SCB Developer Portal application — and its sandbox
   credentials into `.env` (`PGW_*`), never into the repository. This is decision
   **O-1**; it blocks only the real-QR half of SCRUM-206, since the gateway
   simulator carries the acceptance.
2. **O-2** — whether offline sales (Slice G, built inside SCRUM-206 today) stay in
   that ticket or become one of their own.
3. **O-6** — the vendor questions for GHL Thailand and Digio, including the TID
   and MID for the park's two PAX terminals, which are not on file.
4. **Policy and scope decisions** raised by today's work: 371 (does the sale
   survive the inactivity lock?), 345 (may a branch carry another branch's product
   or discount code?), 306, 327, 326, 357, 268, and 254's two open questions.
5. The deploy-bot's `render.yaml` entry, which creates a paid service on sync.
6. Later: real dumps of Radar's and the wheel's databases; Pisell/Papaya
   credentials from Replit Secrets (history export before any cancellation); S3
   contents; DNS for the `otoplay` domains; a Raspberry Pi 5 on the desk.

## Build order

S2-01 → S2-02 → S2-03 → S2-17a → **CP1** → S2-04…S2-07 → **CP2** →
S2-08…S2-11 → **CP3, POS play-test opens** → S2-12…S2-15 → **CP4** →
S2-17b/c → **CP5** → S2-18, S2-19 → **CP6** → S2-16 → **CP7**. (The full order
with every lettered part is at the end of `SPRINT_2_PLAN.md`.) The sprint is
inside S2-10 (payments) now, with S2-09b (SCRUM-204) still open beside it. Every
function is committed as it lands; the ticket log in `SPRINT_2_PROGRESS.md` is
updated in the same commit series.

## Known defects

The Sprint 1 list that S2-01 existed to fix is closed: the role-assignment
privilege hole, the lock model, the PII in logs, the proxy trust and the
Postgres-backed throttles all landed, and transactions and the atomic idempotency
claim followed in S2-01b.

The open list is now the one raised during Sprint 2 itself. Twenty-seven tickets
raised today are still open — the payments six (391, 388, 382, 390, 389, 387), the
Console and box four (378, 381, 385, 386), the promotions four (368, 373, 374,
375), the till and light-theme six (360, 371, 372, 370, 380, 379), and the rest
(369, 383, 339, 340, 345, 357, 326). Each is one line with its key in
`SESSION_HANDOVER.md`, and one row with its evidence in
`TICKET_REGISTER_2026-09-23.md`.

## Working rules that are easy to forget

- Nothing under `imports/` is committed except the READMEs. The exports contain
  real credentials and the dumps contain real staff and children's data: structure
  and counts only, never values, never uploaded anywhere.
- Never run `drizzle-kit push` or an imported app's reset scripts against a shared
  database.
- Commits follow `/CONTRIBUTING.md` (no attribution lines). **A commit's file list
  is never filtered by a word** — list every file the work touched, or CI finds
  the one you dropped.
- **A credential is searched for in every encoding**, not only the one it was
  typed in. The vendor void password turned up a seventh time hex-encoded inside a
  sample frame.
- **A reviewer never stashes a shared working tree.** Several slices are usually
  live in it at once.
- Checkpoint the progress file and commit after every substantial step; research
  agents run on Opus and save their output early.
- `services/deploy-bot/` and `render.yaml` belong to a separate session — do not
  touch either.
- To play with what is deployed: `docs/qa/SIMULATION_AND_TEST_CONTROLS.md`.
