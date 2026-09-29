# SCRUM-201 separate display checkpoint

29 September 2026. Online ticket identification and order/payment/thank-you checked; full story remains In Progress. This checkpoint
uses local disposable-database evidence, not staging acceptance.

## Implemented contract

The browser at `/display` generates its own 256-bit credential, sends it
only in the Authorization header and stores it under its own display key.
Only hashes are kept on the platform. A ten-minute six-digit code is shown
once, rotated on request and consumed by a permitted manager's Console claim.
Credential responses are excluded from stored idempotency replies and logs.
Station and code locks plus the active-display index settle concurrent claims.
Revocation writes `display.revoked` and live reads recheck device scope,
operator, park and station. Credentials survive staff lock and sign-out.

Existing shared names stay intact: `StationSessionDocument`,
`StationIntent`, `actionId`, `lastSeenSequence` and `leaseId`.
The staff publisher holds its own lease. Display actions are lease-free,
stage-valid and fenced by prompt `requestId`; the box uses sequence CAS
for typed answers. A retry reuses its action and input. Out-of-order replies
cannot restore an older visitor. The first answer wins for each prompt.
The display sees a redacted document without staff lease or medical records.
Finite polling currently uses the cloud API and existing virtual box; it
does not establish the physical box's LAN/offline transport.

Staff lock retains the desktop ticket visitor, but unmounts child surfaces,
portals and toasts. Scans, quotes, publishing and payment work pause. Unlock
reads the authoritative answer before publishing. Sign-out or a context
change discards the visitor, while the display remains paired. Shell updates
wait while a retained visitor or connected display prompt is in use.

## Local browser evidence

The native POS and Console ran against a fresh migrated and seeded database.
Three isolated browser contexts exercised manager, staff and display roles.
No trading or physical hardware was used in this identification proof.

- Fresh display setup without staff login; pairing code masked in evidence.
- Console claims the actual code for Reception Till 1.
- Display at 1024 by 768 and staff at 1280 by 800 have no horizontal overflow.
- Reload retains the independently paired device.
- All five display languages persist across reload; staff remains English.
- A visitor identifies while staff are locked and the reply is deliberately
  dropped after server acceptance; unlock opens the seeded member's children.
- Lock removes the staff dialog; unlock restores the same visitor.
- Authoritative polling clears the uncertain-reply message.
- Staff lock and sign-out do not require the display to sign in again.
- Console revocation returns the display to setup on the next polling cycle.

Validation: **328 affected existing-file tests pass** (API 130, database 28,
box station 24, POS scan/display 40, payment writer 64, till voucher 40 and
Console browser controls 2). Eleven additional native browser checks pass.
All five touched packages pass typecheck and full lint; POS and Console
production builds pass. Fresh/repeat migrations and schema verification match
0031. Independent review found a queued-payment lock race; its final fence
and existing-file regression now pass. No new suite or dependency.
Six reviewed local screenshots are attached to SCRUM-201 as 10882-10887 and
named in the push comment. They do not justify Deployed.

Screenshots (all LOCAL CHECK, pairing and password fields masked):

- 01-local-display-setup.png (10882)
- 02-local-console-paired.png (10883)
- 03-local-till-member-found.png (10884)
- 04-local-display-member-welcome.png (10885)
- 05-local-display-revoked.png (10886)
- 06-local-lock-hides-staff-details.png (10887)

The payment pause checks include a known pending attempt, a late start reply,
a late cash reply, an unreadable cash reply with the original retry action,
a true scope reset and a queued gesture paused before its first write.
No collection runs merely because staff unlock.


## Ticket flow and diagnostics checkpoint

The second slice sends captured line breakdowns, translated labels, quote
totals/tax/discounts, selected payment-part amount and real QR/expiry metadata.
The visitor browser never recalculates against its own catalog. Thank-you
shows bracelet counts and entitlement summaries with redeemable identifiers
omitted. Invalid or unsupported data shows the safe waiting screen. Staff
money actions and supervision policy remain on their existing paths.

Shared schemas are applied on publication, cached customer reads, the display
and Console diagnostics. Scan details use a dedicated common helper so poll
and stream remain identical without weakening the cart schema. An existing
scan parity check caught this integration regression; the corrected test passes.

Expire code now invalidates only that pending display request. Repeated expiry
is harmless; a concurrent successful claim makes expiry refuse without revoking
the paired device. Lost replies keep pairing paused for same-credential retry.
Automatic minting hides the old code and fences expiry until mint completion;
stale polls cannot restore a code after expiry. No code enters logs or audit.

Console Snapshot is explicitly a current customer view, not an archived last
delivery. It omits payment QR contents and private data. Revoked displays are
still inspectable and labelled Access revoked; Last seen records authenticated
activity and does not imply every handler succeeded.

506 existing tests pass: API fleet68 + station37 + scan polling10 + stream5;
POS scan44 + till voucher40; box station26; Console display controls4; shared272.
Typecheck and full lint pass for API/POS/Console/box/shared. POS and Console
builds pass, with existing POS chunk warnings. No new suite or migration.

Nineteen native checks pass against a fresh disposable database using manager,
staff and visitor browser contexts. The report is ticket-local-results.json.
It includes the full known-member cash sale, display split-part change before
payment, final recorded amount, thank-you counts, next visitor reset, expiry
lost-reply retry, real Console snapshot and revocation, plus the earlier lock,
language and identification failure cases. Virtual print paths only; no physical
hardware or bank charge. An empty payment panel was initially asserted visible
before selecting a method; the proof now checks the visible Amount Due heading.

Reviewed local screenshots attached to SCRUM-201:

- 07-local-ticket-order.png (10888)
- 08-local-ticket-payment.png (10889)
- 09-local-ticket-thankyou.png (10890)
- 11-local-code-expired.png (10891)
- 12-local-console-snapshot.png (10892)
- 13-local-console-revoked.png (10893)

All carry LOCAL CHECK. These do not satisfy the staging Deployed gate.

## Diagnostic refusal checkpoint

Send test intent checks a finite stage/intent choice on a private clone using
the same box validator as live intents. Existing session state, sequence,
nested visitor data, lease and channel traffic stay untouched. An absent or
wrong-box session is refused; testing does not create a live session. The
manager needs the target park's pairing permission and an active paired display.
Its safe Console test event and replay response commit together under the same
action/key. Box logs show these station refusals separately from uploaded logs.

The credential guard records actual protected-session/intent 401 refusals for
known revoked displays through the retained pairing-request hash relation. No
bearer, hash or request body is written. Unknown, pending and merely expired
pairing-status requests write nothing. A credential lock limits observations
to one per minute across concurrent requests. Fleet reads verify the current
station/box/park/operator binding before exposing Last protected call rejected.
The independent display polls its protected session once paired, so revocation
produces the observed refusal before the screen returns to setup.

223 existing checks pass: API 147 (fleet 70, station 41, auth 15, route inventory 12,
guards 9), box 27, POS 44 and Console 5. Four package typechecks/full lint and both
front-end builds pass. The unchanged shared/database packages were not retested
for this slice. Independent review found and closed absent-session creation,
wrong-box rejection attribution and stale target UI state. The route inventory
now explicitly covers independent display replay exceptions; it caught the
missing entries. Two locator-only errors were fixed without widget changes.

Native report diagnostic-local-results.json records 22 passed checks. It proves
the real Console welcome/consent rejection, matching station event in the Box
drawer, unchanged visitor state, and actual 401/Console rejection after revoke,
alongside the prior full ticket flow. Reviewed local attachments:

- 14-local-consent-test-refused.png (10894)
- 15-local-box-refusal-log.png (10895)
- 16-local-revoked-call-rejected.png (10896)

All are LOCAL CHECK; staging acceptance remains pending.

## Sign-out handover and repeatable smoke

Normal sign-out releases the signing-out till's own lease, even while locked,
through an optional server-validated stationLeaseId hint. Another account,
station or replacement lease is protected; missing or failed release never
prevents ordinary session revocation. The publisher stops immediately and
waits at most three seconds for an in-flight claim. An unknown network outcome
uses TTL recovery. Subsequent sign-in waits for the earlier cookie clear.

157 existing-file checks pass: API 108, POS 47 and two native browser cases.
Both package typechecks/full lint, smoke TypeScript and POS build pass.
The smoke now uses isolated staff and display contexts and real API records,
waits for the new staff prompt, and covers both existing member flows. It is
restricted to a disposable seeded local API. It needs POS_E2E_PHONE/PASSWORD
and POS_E2E_ADMIN_PHONE/PASSWORD in the process environment; values stay in
memory. Optional POS_E2E_EVIDENCE_DIR receives masked LOCAL CHECK screenshots.
PLAYWRIGHT_NO_COPY_PROMPT suppresses unmasked failure DOM; tracing, video and
automatic screenshots are disabled. Run the existing e2e/smoke.spec.ts against
the local seeded API and POS with the edge role running, using one worker.

Report: handover-local-results.json. Reviewed local attachments:

- 17-local-two-browser-children.png (10897)
- 18-local-fresh-shift-display.png (10898)

No new suite, dependency or migration. A duplicate station fixture name and
outdated retained-screen assertions were corrected. The smoke waits for the
native sign-out response and avoids racing it with cleanup; it does not
manually release the lease before the handover assertions. These local images
do not satisfy the staging/Deployed gate.

## Recorded response Snapshot

Migration 0032 adds core.display_response_snapshot, one row per credential.
The protected session/intent transport stores a finite diagnostic projection
and the scoped Console read returns it through DisplaySnapshotResponse.
QR contents, contact answers and private records are removed before storage
and read. Pairing/probes/401s never replace history. An empty record stays
empty. Recording is best effort and does not make display availability depend
on diagnostics. Its time means response preparation; browser receipt is not
verified. Current and captured park permissions are checked separately.

Credential/station locks, active park/operator/box checks and a reset epoch
frozen before document preparation protect attribution. Changed or archived
targets, revoked credentials and unassigned displays retain historical labels.
Same-sequence language responses are recorded in their locked preparation order.
The Console validates target IDs and fences old selection replies. Refresh
reads only the stored response. It does not obtain current station state.

187 existing checks pass: API 165, shared 6, DB 14 and Console 2. Four package
typechecks/full lint, Console build and schema verification against 0032 pass.
Source and migration review passes. No new suite or dependency.

Report: snapshot-local-results.json. Reviewed local attachments:

- 20-local-console-recorded-response.png (10899)
- 21-local-console-disconnected-history.png (10900)
- 22-local-console-revoked-response.png (10901)

The regenerated proof passes six checks using real protected API/browser
traffic and a synthetic public order, without executing a sale/payment.
It covers disconnection while the till advances, reconnection, revocation
and identical saved history after API restart. The earlier complete ticket
run passed 23 checks, but its temporary report/images were cleared by an
ad-hoc Playwright default output directory. Committed evidence is intact;
lost temporary payment/offline helpers need rebuilding before post-deploy use.
All temporary configs must set a dedicated absolute outputDir (and native
CLI --output). Current ignored runner/evidence: output/snapshot-verification.
The two existing Console cases also cover unassigned history and wrong-park
grants. All images are LOCAL CHECK; staging acceptance is pending.

## Remaining acceptance

The story is NOT BUILT as a whole. Preserve these boundaries in Jira:

1. Integrate F&B/shop displays separately; ticket online presentation is checked.
   Keep money operations on the staff-authorised path.
2. Add typed consent, child-slot edits and completion with authoritative
   policy checks. Supervision steps 7/8 stay inline until that is proven.
3. Verify recorded-response Snapshot and the other diagnostics on staging.
   A separate Console expiry action is not claimed; unused-code expiry stays
   on the unpaired display setup screen.
4. After the independent-display POS is verified live, remove the legacy
   staff-session pending-lookup routes. Keep the columns through that release,
   then remove them in a later forward migration after old API readers retire.
5. Complete the story's two-browser staging smoke, both layouts, failure
   cases and reviewed screenshots before moving SCRUM-201 to Deployed.

Requirements: SPRINT_2_PLAN S2-08; PLATFORM_PLAN section 6;
POS_RULES_RECONCILIATION R-54; DEVELOPMENT_PLAN separate-display sequence.
Full reload recovery of a visitor/cart and physical/offline display transport
are not established by this first slice.

Implementation notes for the remaining work: pending-lookup wrappers have no
current POS callers and are removed from the current POS API module. The live
0468c38 POS still calls both mailbox routes from Till.tsx. Keep the server
routes for the first independent-display rollout, verify the new POS live,
then retire those routes. Keep the database columns through route retirement
because the older API still selects them; remove them in a later forward
migration after that rollout is verified. Repository searches must include
the live release, not just the working tree, before compatibility is removed.
ConsentCapture and SavedChildrenReview have editable medical/photo fields.
Their display integration must not republish saved medical data in the public
snapshot. Typed slot changes need prompt, visitor and slot identity fences;
the staff-authorised path must continue to enforce supervision policy and
write the member record. Reusing the layout alone does not complete that work.

The next consent slice is a typed draft handoff through the existing display
intent endpoint: child review, child selection/edit, acknowledgement and Done.
Each action needs the current prompt and declared slot/choice binding, plus
the existing device/stage/sequence fences. The till must await real child-save
success before progressing; lost replies keep the same action and body, and
failed writes stay retryable. Public fields may include names, dates of birth,
guardian contact and required confirmation labels; saved health/food records,
photos, staff waiver state and registration records must stay on the till.
Transport acknowledgement does not establish persisted supervision consent,
registration or check-in. Those effects still require S2-13. Photo format and
retention decisions belong to that later work and do not block safe handoff.

This checkpoint implements existing-member saved-child review at
ticket step 8. Reuse stage input and a finite child_review prompt with
requestId, stable visitorId, declared slots/choices, public name/DOB/age and
confirmation/save state. display.child_review carries select, confirm, done,
back, retry or staff_help. Confirm sends one draft, not per-keystroke writes.
The box must bind visitor/request/slot/choice and refuse generic answers.
Allow DOB only through that finite prompt projection, never by relaxing the
generic private-field filter. Recorded diagnostics still keep prompt metadata
only. The till owns the real PATCH, preserves private saved fields, advances
only on confirmed success and fences late replies by epoch/member/visitor.
A prompt revision acknowledges processing and permits the next action on the
same step. Retry retains the original frozen body/key. New-child entry and
removal fall back to staff; completed review opens step 7 inline. Prove real
profile readback, retry/lock/context fences and absence of registration,
check-in or money calls. Full S2-13 remains separate.

## Saved-child review verification - 29 September 2026

149 checks pass in existing files: shared station 10, box station 32, API
station 50, POS scan-channel 54 and the existing POS smoke's three cases.
Shared/box/POS typecheck and full lint pass. POS build and standalone smoke
TypeScript pass. The build retains the existing chunk-size/import warnings.
No new suite, dependency or migration was added.

The third native case uses a fresh database and the real staff/display API.
It checks a public name/DOB correction against the saved member record, holds
and then loses the actual successful reply, verifies controls stay locked,
and retries with exactly the same body/key. Other-slot drafts survive; a
dirty confirmed field disables Done. Both 1024x768 and 1280x800 fit without
horizontal scrolling. Done opens the staff supervision screen. No
registration, visit, sale or payment POST occurs during the review portion.
The earlier membership-confirm setup still creates its normal draft visit.

Local evidence attached to SCRUM-201:

- 23-local-child-save-pending.png (10902): real write answered at the API,
  but the display still waits for the till's confirmed reply.
- 24-local-child-save-retry.png (10903): lost reply with explicit Retry.
- 25-local-child-review-confirmed.png (10904): both children confirmed and
  Done enabled after successful readback/retry.

The sanitised child-review-local-results.json records the three passing
native cases and successful cleanup of owned processes and the disposable DB.
The ignored runner is output/child-review-verification/pos-run.mjs; every run
sets its own absolute outputDir under that directory. Credentials remain in
memory and screenshots are masked and stamped LOCAL CHECK.

Review fixed retained-save loss on disconnect, lock/failure replay, stale
epoch/slot adoption, canonical returned field adoption and picker day drift.
The first browser run failed an existing new-member setup assertion and the
new review. On stable source both unchanged baseline cases passed. The new
review failure exposed a real rendering bug: the public response deliberately
sets step to null, so the display must use its validated child_review prompt,
not staff step 8. Redaction stays intact. The corrected full run passes all
three cases. The lint dependency warning and optional test callback typing
error were also fixed and rechecked. No failed run is counted as acceptance.

This is online saved-profile review only. Step 7, registration, consent
effects, new-child creation and removal remain staff-owned; physical/offline
transport and staging acceptance are not established here.

## Release gate

The next independent display slice is F&B guest trading, then shop. Publish
captured quoted rows, resolved modifier labels, quantities, manual amounts,
tax/discount totals, the actual payment attempt and finalised completion.
Never send a whole order, catalog or wristband record. F&B currently derives
prices from the local catalog/clock; its separate display needs supplied
public rows. Wallet, prepaid, staff-benefit and party-charge paths retain
explicit staff fallback until their own authoritative business work lands.

App.AuthGate currently retains only the ticket till across a staff lock.
Before connecting another station, extend that same-session retention and
pause scans, quotes, payment polling and late callbacks while locked. Keep
the sign-out lease handover. Shop must preserve its existing real-payment
overlay; the excluded MerchCustomerDisplay.tsx cannot be edited or used to
show its prototype payment QR. These are scoped implementation requirements,
not completed or deployed acceptance.

The checked child-review implementation keeps a retained save operation with
the original PATCH body and idempotency key. A lost reply stays unresolved
until an explicit retry; unlock alone must not issue the PATCH again. Both
inline and separate Confirm need an awaitable result and a scope fence so a
late response cannot update another member's screen. Switching offline or
handing review to staff invalidates the public prompt even on the same step.
The shared prompt is bounded to 50 slots and 100 saved choices; exceeding the
bound must show staff fallback, never silently drop children. Calendar dates
must be valid and age/DOB handling must follow the existing review rules.
Display-local edits make Continue unavailable until confirmed, including
when an older server snapshot still marks that slot confirmed. Drafts for
other slots survive polling; changing visitor or assigned child discards a
stale draft. These rules are covered by the local source and native checks below; full
story and staging acceptance remain incomplete.

Confirm also names the savedChildId, checked against both the box prompt and
the till's current assignment. Slot identity alone does not protect a reply
that arrives between a staff reassignment and its next publication. DOB age
uses a staff-published referenceDate for the visit/local day, bounded within
one calendar day of server time. Display actions cannot change that date.
This avoids UTC/local birthday drift while rejecting impossible/future DOBs
and confirmations outside the existing child API's 0-17 age range. Older
legacy read values may be shown for staff help but cannot be confirmed here.

Main 88140af includes saved-child review, recorded responses and the earlier display/payment work.
GitHub Actions run 36589992120 / check 109480274224 stopped before any step because billing/spending availability
prevented jobs starting. Render still gates deployment on successful checks;
no bypass or billing change is made. Restore Actions, verify the exact release
SHA, then use one normal deployment and run staging proof. The retained
simulated partial payment remains untouched. Pending actions are saved in
docs/progress/OPEN_QUESTIONS.md.

## Guest food order checkpoint

The separate F&B screen shows server-captured item/base/modifier prices, note,
manual discount, tax and total. Captured quote components remain correct even
when base and modifier prices change in opposite directions. Money stays on
the authorised till; thank-you requires the actual finalised sale and tender
sum and shows the real pickup code. Lock pauses quote, scan, publisher and
payment effects while preserving the current order. Unsupported wallet,
prepaid, benefit, promo, voucher and local-price paths clear the public frame
and retain the staff/inline fallback. Shared contract names are unchanged.

223 relevant checks pass across existing files and browser cases. API/POS/
shared/box typechecks and full lint pass; POS build passes. Native proof used
fresh databases and two contexts. All three earlier cases passed; the focused
fourth case then passed after correcting native navigation, required pickup
entry and a stale-sequence language retry assumption. Its order and completed
images are reviewed LOCAL CHECK evidence, 26-local-fnb-order.png and
27-local-fnb-completed.png. The payment image was captured during its fade-in
and excluded. No new suite, dependency or migration.

F&B reviewed local attachments: 26-local-fnb-order.png (10906) and
27-local-fnb-completed.png (10907). Both are LOCAL CHECK, not staging proof.

## Staging foundation and safe mailbox retirement

Staging88140af passed nine foundation checks in staging-foundation-results.json.
The actual native revoke succeeded; its final Console assertion initially
used the stale loaded row. A fresh Console page confirmed the recorded
protected-call rejection. The log image was recaptured with its refusal rows
in view. Dedicated station/member were archived and display credential revoked.

Reviewed staging attachments on SCRUM-201:
- SCRUM-201-staging-pairing.png10908 and expired-code.png10909.
- SCRUM-201-staging-console-paired.png10910 and till-child-found.png10911.
- SCRUM-201-staging-recorded-snapshot.png10912 and intent-refused.png10913.
- SCRUM-201-staging-box-refusal-log-visible.png10914.
- SCRUM-201-staging-revoked-call.png10915 and revoked-display.png10916.
All abbreviated filenames above retain the SCRUM-201-staging- prefix.

Mailbox retirement first removes old routes and Drizzle fields, while keeping
physical columns.94 API checks and14 schema-shape checks pass. Only after
this API is LIVE may forward0033 drop the obsolete columns. The no-reader
API commit is the earliest compatible rollback after that migration.

0033 release gate: API85d35e0 verified LIVE, removed routes404 and ordinary
session/station read200. Existing DB tests43/43 and verify-schema pass with
0033; DB typecheck/lint pass. Exact snapshot delta is the two removed columns
plus snapshot identity/journal entry. After deployment,85d35e0 is the earliest
API rollback;88140af and older must not run against0033. Migration deployment
and final feature verification remain pending at this checkpoint.

## Final local display verification - 30 September

All six existing native POS flows pass together; the sanitised result is
final-local-browser-results.json. The run removed its own database/processes.
POS typecheck, full lint, build and standalone browser-test typing pass.
Existing affected suites pass: POS92, shared19 and box40, with shared/box
typecheck and lint. No new suite or dependency was added.

Shop presentation uses captured quoted variant rows, discounts, tender state
and actual settlement, retaining the order across lock and switching to the
inline staff view when the display disconnects. Unsupported benefit/payment
paths retain explicit staff fallback. Public consent captures only guardian
acknowledgements; private child health, photos and waiver policy remain at the
till. Done never performs registration or payment or replaces staff Continue.
An online quote refresh now pauses typed publication, preserving the accepted
answer through unlock; real offline/error still invalidates stale answers.

Reviewed local captures28-local-shop-completed.png and
29-local-consent-completed.png are marked LOCAL CHECK. Focused native reruns
confirmed viewport and language-control bounds before and after capture;
no clipping or retained document scroll was reproduced. Finite transition
waits remain in the existing screenshot helper; temporary diagnostics were
removed. Staging acceptance remains required before SCRUM-201 is Deployed.

## Staging feature verification - 30 September

Source b31b01b7 is LIVE on API, POS, Console, Launcher and Booth. Deployment
and migration/readiness evidence is in release-deployment.json. Actions run
36619796693 ran zero steps because billing prevented startup; manual Render
deployment was authorised, and normal automatic settings remain unchanged.

Guest food/shop proof passes21 checks, including actual quoted rows, both
required widths, lock retention, real pickup, split cash and display disconnect
fallback. Two finalised synthetic sales remain for audit; owned setup rows
were archived and the display revoked. See staging-guest-order-results.json
and its publishedEvidence images. Final screenshot review found a small order
header/language-control overlap; the current POS-only spacing correction
reserves room for the control without changing payment or API behaviour.

Consent proof passes7 checks with an explicit staging limit. Current park
policy requires a real joint photo before private staff readiness. No photo
or clinical data was fabricated, so successful public Done is proven locally,
not on staging. Staging proves acknowledgement while locked, identical-action
lost-reply retry, actual staff adoption, privacy at both widths, Done disabled
and a real typed Done403, plus staff-help fallback and zero business writes.
All own fixtures were cleaned up. See staging-consent-results.json and its
publishedEvidence images. Two earlier helper-only failures (pairing label
selector and discounted-tier verification) were fully cleaned before rerun;
the passing run uses Tourist tier without fabricated identity verification.
