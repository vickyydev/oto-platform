import { readFileSync, writeFileSync } from 'node:fs';
const read = path => readFileSync(path, 'utf8');
const write = (path, body) => writeFileSync(path, body);
const block = `SCRUM-201 now includes online saved-child review on the separate display.
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

The prior main checkpoint c8f6375 added recorded display responses. Its CI
36585794087 ran zero steps due to GitHub Actions billing/spending availability.
Render's checksPass gate remains intact. Last verified live API/POS/Console/
Launcher/Booth is 0468c38; OTO App is c416065. Recheck the next exact main CI
and deployment after push. No new CI-packed Pi artifact is available yet.

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

`;
for (const [path, heading] of [
  ['docs/progress/STATUS.md', '# Current status - read this first when resuming\n\n_Last updated: 2026-09-29 - saved-child display review checked locally._\n\n'],
  ['docs/progress/SPRINT_2_PROGRESS.md', '# Sprint 2 progress\n\n## Status\n\n_Current checkpoint: 2026-09-29 - saved-child display review._\n\n'],
]) {
  const source = read(path);
  const start = source.indexOf('Current staging: SCRUM-206');
  if (start < 0) throw new Error('Progress anchor missing');
  write(path, heading + block + source.slice(start));
}
const handover = 'docs/progress/SESSION_HANDOVER.md';
const old = read(handover);
const anchor = old.indexOf('## STOP POINT');
if (anchor < 0) throw new Error('Handover anchor missing');
write(handover, old.slice(0, anchor) + '## STOP POINT - 29 September 2026 evening - saved-child display review\n\n' + block + old.slice(anchor));
const qa = 'docs/qa/separate-display/README.md';
let text = read(qa);
text = text.replace('The next bounded implementation is existing-member saved-child review at', 'This checkpoint implements existing-member saved-child review at');
text = text.replace('The active child-review implementation keeps a retained save operation with', 'The checked child-review implementation keeps a retained save operation with');
text = text.replace('These are implementation and verification requirements, not\ncompleted acceptance claims.', 'These rules are covered by the local source and native checks below; full\nstory and staging acceptance remain incomplete.');
const evidence = `## Saved-child review verification - 29 September 2026

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

`;
if (!text.includes('## Release gate')) throw new Error('QA anchor missing');
write(qa, text.replace('## Release gate', evidence + '## Release gate'));
console.log('Status, STOP POINT, sprint progress and QA checkpoint saved.');
