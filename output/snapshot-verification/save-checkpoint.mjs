import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const checkpoint=`SCRUM-201's per-display recorded response Snapshot is checked locally on
feat/display-response-snapshot, ready to fast-forward to main after cbce199.
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

Last verified CI is cbce199 run 36581970114: zero steps, GitHub Actions
billing/spending availability. Render's checksPass gate stays intact. Last
verified live API/POS/Console/Launcher/Booth is 0468c38; OTO App is c416065.
No new staging deployment or CI-packed Pi release is claimed. Check the exact
new main run after this push. Rebuild lost temporary payment/offline proof
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

`;
for(const [file,header] of [
 ['docs/progress/STATUS.md','# Current status - read this first when resuming\n\n_Last updated: 2026-09-29 - recorded display Snapshot checked locally._\n\n'],
 ['docs/progress/SESSION_HANDOVER.md','# Handover - where this is, and what to do next\n\n## STOP POINT - 29 September 2026 evening - recorded display Snapshot\n\n'],
 ['docs/progress/SPRINT_2_PROGRESS.md','# Sprint 2 progress\n\n## Status\n\n_Current checkpoint: 2026-09-29._\n\n'],
]){const p=resolve(root,file),old=readFileSync(p,'utf8'),index=old.indexOf('Current staging: SCRUM-206');if(index<0)throw new Error('Checkpoint anchor missing');writeFileSync(p,header+checkpoint+old.slice(index));}
const qaPath=resolve(root,'docs/qa/separate-display/README.md');let qa=readFileSync(qaPath,'utf8');
const completed=`## Recorded response Snapshot

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

`;
qa=qa.replace('## Remaining acceptance',completed+'## Remaining acceptance');
qa=qa.replace(/3\. Complete the archived last-delivery Snapshot requirement\.[\s\S]*?4\. After/,'3. Verify recorded-response Snapshot and the other diagnostics on staging.\n   A separate Console expiry action is not claimed; unused-code expiry stays\n   on the unpaired display setup screen.\n4. After');
qa=qa.replace(/The archived Snapshot follow-up must be per display credential,[\s\S]*?## Release gate/,'The next bounded implementation is existing-member saved-child review at\nticket step 8. Reuse stage input and a finite child_review prompt with\nrequestId, stable visitorId, declared slots/choices, public name/DOB/age and\nconfirmation/save state. display.child_review carries select, confirm, done,\nback, retry or staff_help. Confirm sends one draft, not per-keystroke writes.\nThe box must bind visitor/request/slot/choice and refuse generic answers.\nAllow DOB only through that finite prompt projection, never by relaxing the\ngeneric private-field filter. Recorded diagnostics still keep prompt metadata\nonly. The till owns the real PATCH, preserves private saved fields, advances\nonly on confirmed success and fences late replies by epoch/member/visitor.\nA prompt revision acknowledges processing and permits the next action on the\nsame step. Retry retains the original frozen body/key. New-child entry and\nremoval fall back to staff; completed review opens step 7 inline. Prove real\nprofile readback, retry/lock/context fences and absence of registration,\ncheck-in or money calls. Full S2-13 remains separate.\n\n## Release gate');
writeFileSync(qaPath,qa);
const proof=JSON.parse(readFileSync(resolve(import.meta.dirname,'native-evidence/report.json'),'utf8'));
proof.limitations=proof.limitations.map(s=>s.replace('Earlier23','Earlier 23'));
writeFileSync(resolve(root,'docs/qa/separate-display/snapshot-local-results.json'),JSON.stringify({ticket:'SCRUM-201',date:'2026-09-29',environment:'local only',result:'PASS',existingChecks:{api:165,shared:6,database:14,console:2,total:187},staticChecks:['shared/db/api/console typecheck and full lint','Console build','database schema verification against 0032','independent source and migration review'],native:proof,attachments:[{id:'10899',file:'20-local-console-recorded-response.png'},{id:'10900',file:'21-local-console-disconnected-history.png'},{id:'10901',file:'22-local-console-revoked-response.png'}]},null,2)+'\n');
writeFileSync(resolve(import.meta.dirname,'commit.txt'),`feat(display): retain the last protected display response

Console Snapshot was a fresh station read and could not show what a
disconnected display last requested. It now reads per-device history.

- add forward migration 0032 for one finite response per credential
- omit QR contents and visitor answers before storage and scoped reads
- retain revoked or changed-target history with honest preparation time
- verify 187 existing checks, six native checks and schema parity
- record temporary evidence loss and regenerate reviewed local images

Refs: SCRUM-201
`);
writeFileSync(resolve(import.meta.dirname,'checkpoint-comment.txt'),`The recorded-response Snapshot is complete as a checked local part of this story. Each display keeps its last safe response and preparation time. The Console can show it while the display is disconnected, revoked or unassigned; Refresh cannot replace it with current till state. QR contents and contact answers are excluded. Historical records require the appropriate park permissions.

All 187 affected existing checks pass, along with the four package typechecks/lint, Console build, database verification for additive migration0032 and independent review. The regenerated native proof passes six checks, including an unchanged saved order while the till moves to payment, reconnection, revocation and a cold API restart. It uses a disposable synthetic presentation; it does not execute a payment.

Reviewed LOCAL CHECK screenshots attached:20-local-console-recorded-response.png (10899),21-local-console-disconnected-history.png (10900),22-local-console-revoked-response.png (10901). The earlier 23-step run passed but its temporary images/report were cleared by a browser-test output-path mistake. That loss, replacement verification, lost helper rebuild work and corrected test expectations are saved in the checkpoint documents. Committed source and earlier evidence remain intact.

This push includes STATUS.md, the newest STOP POINT, sprint progress, open follow-ups and QA evidence. Full SCRUM-201 remains In Progress. Next is saved-child review on the separate display with real staff-authorised saves and safe inline fallback. Staging acceptance is pending the GitHub Actions billing gate; these local screenshots do not qualify the story as Deployed.
`);
