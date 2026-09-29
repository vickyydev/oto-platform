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

## Remaining acceptance

The story is NOT BUILT as a whole. Preserve these boundaries in Jira:

1. Integrate F&B/shop displays separately; ticket online presentation is checked.
   Keep money operations on the staff-authorised path.
2. Add typed consent, child-slot edits and completion with authoritative
   policy checks. Supervision steps 7/8 stay inline until that is proven.
3. Complete the archived last-delivery Snapshot requirement. Current public
   Snapshot, test intents, Box refusals and observed rejection diagnostics are
   checked. Unused-code expiry is on the unpaired display setup screen; a
   separate Console expiry action is not claimed.
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

The archived Snapshot follow-up must be per display credential, not a fresh
station read. Save only a finite diagnostic projection of protected display
responses; omit QR contents and all private fields before storage. Pairing,
Console probes and rejected credentials must not replace that record.
Recheck credential/park/station/box bindings at capture and at the scoped
manager read. Retain revoked history without labelling an old station or box
epoch as the current target. Response preparation needs its own ordering:
document sequence alone cannot distinguish language responses. The label must
say last recorded response prepared by OTO Park, with a time; browser receipt
is not verified. A missing record stays empty rather than substituting current
state. An additive migration and existing API/database/Console tests belong
with that implementation, not with this compatibility checkpoint.

## Release gate

Main 02813cb has the checked diagnostics, ticket flow and payment follow-ups.
GitHub Actions run 36576638516 stopped before any step because billing/spending availability
prevented jobs starting. Render still gates deployment on successful checks;
no bypass or billing change is made. Restore Actions, verify the exact release
SHA, then use one normal deployment and run staging proof. The retained
simulated partial payment remains untouched. Pending actions are saved in
docs/progress/OPEN_QUESTIONS.md.
