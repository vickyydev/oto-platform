# Hosted session handover — the platform lane

_For a Claude Code session running on a hosted (cloud) machine with a fresh
clone of this repository. It carries everything the local session knew that
is not already in the repo: where the work stands, the order of work, how
work is landed and proven, and the tools. Kept current at every landing._

## 1. Read first, in this order

1. `CLAUDE.md` (repo root): the standing brief. Sections 3, 7 and 8 and the
   header block are in force.
2. This file, all of it.
3. `docs/progress/STATUS.md` (top paragraph) and the newest blocks of
   `docs/progress/SPRINT_2_PROGRESS.md`.
4. `docs/briefs/OWNER_DIRECTION.md` (owner decisions; newest wins).
5. The plan of the story you are on (section 3 names it).

## 2. Where the work stands

**13 October 2026, 17:43 Bangkok, story complete:** SCRUM-191 and all twelve child tickets are Done. Eleven linked lift items remain Deployed with images. All six services were observed live on main `2850d89178232f421fbea18cbc4ea583cf3c1910`; the app deployment completed at 16:37 Bangkok. All six main jobs passed in [run 38374525197](https://github.com/vickyydev/oto-platform/actions/runs/38374525197): 4,033 API tests, 32 scheduling controls, 89 feature runtime controls and 30 Console browser checks, plus build and genuine hosted restore/replay. Whole workspace/API compiler output is clean. The app remains at 442 diagnostics across 59 files and 118 file/code buckets, with the 457 ceiling retained. App migrations remain through `0015`.

[Scheduling acceptance](../qa/oto-app-lift/round-8/scheduling-scope.md) records own saves/edits and all ten foreign/mixed/replay refusals with unchanged readbacks. The inspected labelled API card is attached to SCRUM-523 and SCRUM-191. Exact cleanup `job-db70ka4s728c73d239u0` removed 13 temporary records and one app session, confirmed absence and preserved the existing park and seeded platform identity. The former session returns 401 after cleanup. Supported unlink alone had retained that active app session; SCRUM-288 now records this additional access-lifecycle case. This cleanup is separate from the earlier 297 content rows, ten files, seven parents and two sessions.

No owner answer is pending for this story. Recorded feature limits remain: face mode off, no positive Xero sandbox exchange, repeated import Apply unproven, no deleted-SOP recovery, staff-inbox delivery only, saved-family API save after UI verification, and existing employee approval rules. The owner decision document is separate from story acceptance. Next is OPEN_ITEMS section 2, beginning with SCRUM-276. Local databases remain off; SCRUM-223 stays paused.

**13 October 2026, 17:38 Bangkok, scheduling staging proof complete:** All six services are observed live on green main2850d89178232f421fbea18cbc4ea583cf3c1910. The main gate passed API4,033, scheduling32, feature runtime89 and Console browser30; workspace/API compiler zero and app442 diagnostics/59files/118buckets. Two launcher-entered park sessions completed own saves and edits, all ten foreign/mixed/replay refusals, and unchanged owned readbacks. The inspected labelled staging API card records that scope; no UI save or payroll calculation is claimed. Exact cleanup is in progress. Supported unlink returned200, while the existing active app session remained200; its exact temporary user/session removal and final401 are still owed. SCRUM-523 stays Testing and191 In Progress. No owner decision blocks this story. The requested plain-language owner decision document is being reconciled separately. Local databases stay off and223 stays paused.

**13 October 2026, 16:36 Bangkok, main release gate complete:** Main2850d89178232f421fbea18cbc4ea583cf3c1910 passed all six jobs in run38374525197, without a retry: API4,033, scheduling32, feature runtime89 and Console browser30 passed. Whole workspace/API compiler output is clean; app442 diagnostics/59files/118buckets is unchanged. Build and genuine restore/replay passed. Five services are now observed live on this source. The OTO App had no queued automatic deployment; explicit deployment dep-db6vmc8u01pc73bp7s10 is building the same green SHA. Wait for its observed completion before the prepared own/foreign/replay staging probe. Inspected scheduling images, exact temporary identity/content cleanup and final Jira closure remain. SCRUM-523 stays Testing and191 In Progress. No owner answer is pending. The existing test-notes PDF is a practice guide, not a completed findings report; it establishes no additional story blocker and remains untracked.

**13 October 2026, 16:11 Bangkok, scheduling source landing:** Candidate915d13ef0ad22679bc8b81cedb3aae0c16571ec3 passed all six jobs in run38372589946: API4,033 passed/364 skipped/5 todo (284 passing files,7 skipped), scheduling32/32, feature runtime89/89 and Console browser30. Workspace/API compiler output is clean; the app remains442 diagnostics/59files/118buckets with every full diagnostic unchanged. Build, documents, finance imports and genuine restore/replay passed. Touched lint and the independent review are complete. Rebase retained all four source commits and an empty application/workflow diff from that green candidate. This landing now requires its own full-SHA main gate and observed Render rollout before the prepared staging proof and exact fixture cleanup. SCRUM-523 remains Testing;191 remains In Progress. No owner answer is pending; local databases remain off and223 stays paused. No migration is introduced; app0015 remains current.

**13 October 2026, 16:03 Bangkok, scheduling runtime complete:** Exact candidate 915d13ef0ad22679bc8b81cedb3aae0c16571ec3 passed all 32 scheduling controls and all 89 feature runtime controls in hosted run38372589946. The app build, document checks, finance imports and genuine restore/replay passed. Whole app compiler output is unchanged at442 diagnostics/59files/118buckets. The bounded finance test coordination completed in about one second. Remaining workspace/API jobs still determine the complete candidate gate; no main source landing or new deployment is claimed. SCRUM-523 remains Testing and SCRUM-191 In Progress. All six staging services still run5b2f049f. Prepared isolated scheduling proof and exact fixture cleanup follow the green candidate/main gates and observed deployment. No owner answer is pending; local databases remain off and223 stays paused.

**13 October 2026, 15:49 Bangkok, bounded release-check follow-through:** The scheduling candidate 186f1f02 completed build, restore/replay and compiler checks, but its existing finance concurrency check stalled before the feature and scheduling suites. Two independent source reviews identified an unbounded request-arrival interleaving in that test. The run was cancelled; the test-only arrival barrier and timeout are now prepared, retaining every finance assertion. A forced reversed-arrival reproduction reaches its deadline with the old coordination and passes with the corrected ordering; touched lint and independent review passed. The previous complete API run passed 4,033 tests; this cancelled run is not a release pass. SCRUM-523 remains Testing, main remains green and all six staging services remain on 5b2f049f. Final candidate/main gates, observed rollout, scheduling proof and exact test cleanup remain. No owner answer is pending.

**13 October 2026, 15:34 Bangkok, scheduling response checkpoint:** SCRUM-523 remains Testing. Candidate a5023a18 passed the existing document checks and all 89 feature runtime controls. Its scheduling suite passed 31 of 32 checks: the remaining descendant-protection check preserved every selected row but received 500 instead of the guard's intended 404. The terminal error handler now maps ScheduleScopeError to 404; unrelated errors keep their existing handling. Independent review and touched-file lint passed. This corrected source still requires its complete hosted gate before main landing and staging proof. Whole compiler output remains workspace/API clean and app 442 diagnostics across 59 files/118 buckets. Main remains green and staging stays on 5b2f049f. Exact ZZ TEST scheduling fixture cleanup is owed after release. No owner answer is pending; local databases stay off and SCRUM-223 stays paused.

**13 October 2026, 15:27 Bangkok, scheduling candidate checkpoint:** Source candidate a5023a185086d04132a1cce5ed7b838de4817148 is published on lane/s217b-scheduling with32 real-handler review pins. Its corrected hosted run38368317606 is active; build, compiler and POS checks have passed so far. The preceding candidate completed all three API shards, POS and workspace successfully; its app job stopped at the established reassignment response check, now preserved in source with exact compatibility pins. A complete candidate pass is still required before the source lands on main.

Main7e1633d5 already holds the inspected department create/edit/reload/deactivate proof and exact two-row cleanup, attached to193. All eleven delivered child items and eleven linked lift items remain Deployed. SCRUM-523 is Testing;191 remains In Progress. Staging still runs5b2f049f through app0015. Scheduling verification fixtures comprise one isolated ZZ TEST park, two branches and a temporary app identity reached through the launcher; no employees or messages were created, and exact cleanup remains owed after post-release checks. There is no pending owner answer. Local databases remain off;223 stays paused.

**13 October 2026, 15:17 Bangkok, scheduling release verification:** SCRUM-523 is Testing. Candidate0e7b6f8f contains the51 scheduling/rota/duty guards and30 independent runtime pins. Its hosted build, restore/replay and compiler checks passed: workspace/API compiler clean, app442 diagnostics/59files/118buckets with no new or increased bucket. The app job stopped in the existing document checks because reassignment refusal wording/status must retain its established contract. The narrow compatibility adjustment keeps404 Assignment not found and400 New employee not found while retaining parent ownership checks; the corrected candidate still requires its hosted gate. Other source jobs are not yet a full-pass claim. Main remains green; staging still runs5b2f049f.

Department staging proof and exact cleanup are committed on main7e1633d5 and attached to193. Scheduling proof preparation has created one ZZ TEST park and two branches, plus a temporary app identity linked through the existing seeded second-park account and opened through the launcher. No employee or provider message was created. Exact scheduling fixture cleanup is owed after post-release checks. No owner answer is pending; local databases remain off and223 stays paused.

**13 October 2026, 14:54 Bangkok, department staging proof complete:** On live5b2f049f, the launcher-signed administrator used the actual Departments screen to create one ZZ TEST department assigned only to Demo Branch2 (201), edit its description (200), reload and read the saved change (200), then deactivate it (200). It had zero employees. The inspected `department-action-staging-20261013.png` shows the saved card. Guarded cleanup job-db6u6g59fdbs73ecnlgg checked30 incoming reference columns and removed exactly one department and one branch assignment; the final API detail read is404. No branch or employee was edited. SCRUM-523 scheduling ownership remains the active story item; source and independent review are in progress, not released.

**13 October 2026, 14:46 Bangkok, story completion priority:** SCRUM-191 completion is the active work. The live Jira check confirms eleven child items Deployed with image evidence and all eleven linked lift items Deployed. SCRUM-523 is now In Progress for the remaining scheduling park-group boundary. Its route/storage implementation and independent review proceed in parallel; existing within-park behavior is retained. A final acceptance read also identified the department action evidence still to capture with exact fixture cleanup. No owner answer is pending. SCRUM-276 remains To Do and its completed read-only source assessment is retained; the remaining fix block follows this story. Current staging remains5b2f049f through app0015; no new source release is claimed. Local databases remain off.

**13 October 2026, 14:20 Bangkok, lift release acceptance recorded:** Jira193 and516 are now Deployed with inspected job-recovery and cleanup proofs attached. All seven original feature items under194 are also Deployed. A live child-ticket check shows eleven SCRUM-191 children Deployed and only SCRUM-523 To Do. The umbrella191 remains In Progress for that scheduling follow-through; it is not marked fully complete.

All six services still run green source5b2f049fba750403fe60284bf2b8b4855eb934b4, with app0015. The app deployed at04:33:44 Bangkok; later commits contain documentation and evidence only. No new deployment is implied. The full source gate remains API4033 passed,89 feature runtime controls,30 Console browser checks, workspace/API compiler zero and app446 diagnostics/59files/118buckets with the457 ceiling retained; genuine hosted restore/replay passed.

Exact cleanup is complete:297 content rows and ten fingerprinted files, then seven remaining test parent rows and two app sessions. Supported unlink returned200; the former app /api/user returns401. Seeded platform account/employee/operator/branch and administrator assignment were preserved. The original content transaction matched protected employee/sick-day fingerprints before and after its deletions. A later Som row hash differs; Som is active with no leaving date and the sick day matches. No writer is established, no value was reverted and no claim of unchanged contents throughout later staging use is made. The cleanup record states this limit precisely.

Practice employee census is zero. All four recorded Console API retries returned200/outcome ok; fresh Health and independent last-success readbacks passed with zero failed/unkeyed parks. Midnight/reconcile correctly report today's work already done. The inspected current Health image retains the separate historical demo.fail entry; no whole-deployment all-clear claim is made.

Next: follow OPEN_ITEMS section2, beginning SCRUM-276's read-only advance/calculated-run check before implementation. Q39 remains BROKEN as SCRUM-523 in that same fix block, after the first three existing money/identity items; its within-park branch behavior remains the default and its expected-failure pin stays named. All pending original feature/source/restore/cleanup notes below are dated history. Face-enabled positive staging evidence remains unavailable underQ9; Xero positive exchange still waits for a sandbox. Local databases stay off; SCRUM-223 stays paused.

**13 October 2026, 13:35 Bangkok, deployment and cleanup checkpoint:** Render's deployment API confirms all six services still run green source5b2f049fba750403fe60284bf2b8b4855eb934b4. The app completed deployment at04:33:44 Bangkok and API at04:32:16; the other services completed around04:30. Later main commits contain documents and evidence only; application, migrations, scripts and workflow source have an empty diff from that live release. Staging walkthroughs were performed against this release, rather than a new deployment.

The refreshed exact census job-db6s2jnf3r2c73carnq0 selected297 rows across70 tables and ten objects. Guarded transaction job-db6sbsjncjis73em8v2g committed all297 removals, confirmed selected-ID readback zero and preserved the seeded employee, sick day, retained app user and week fingerprints. Object job-db6sfegn74is738sbcq0 removed the ten fingerprinted files and confirmed their absence. Shared parent/identity records remain for separate reference review; no platform seed or protected payment was selected. Post-cleanup published employee-view readback and current scheduled-job Retry/last-success proof remain before parent closure.

SCRUM-194 and517..522 are Deployed with inspected evidence attached. SCRUM-191 remains In Progress;193 and516 remain Testing for this last follow-through. Attendance's positive face-enabled staging upload is unavailable under standing Q9; its hosted controls and staging face_off refusals are recorded without a live approval claim. Local databases stay off. Next: complete readback, supported temporary-identity cleanup where proven, and Console Retry evidence, then reconcile story acceptance. The fix block begins withSCRUM-276 afterward; SCRUM-223 stays paused.

**13 October 2026, seven-feature evidence complete:** All six staging services remain live on green5b2f049fba750403fe60284bf2b8b4855eb934b4 through app0015. Import and Fix preview are already Deployed with their inspected images attached. SOP versioned edit/history/archive/restore, employee review/title/transfer history, and inbox Pending/Delivered/Failed with exact replay and actual Retry now have inspected staging evidence. Real SMS receipt/verification and saved-family prefill passed twice with the recipient's authorization. The saved-family API returns the same registration with attendance/signature/agreement date unchanged; used grant403 and valid foreign-camp403 followed by same-grant owned200 are observed.

Attendance evidence is built and its saved hosted controls pass:9 evidence pins,6 reviewer pins, multipart controls and6 real-handler/database reviewer scenarios. Staging manual and unscheduled confirmations return403/face_off under the standing Q9 decision; no positive face-enabled upload or live approval is claimed. The normal kiosk and manager-review screens are recorded, with own/foreign pending reads200/count0. The labelled test-run card separates these limits from the hosted proof. No face flag or identity result was changed.

The exact read-only combined cleanup census succeeded in job-db6rjcaj9qps73a91j50:70 tables/296 rows/ten objects, preservation and incoming-reference guards passed, mutated=false. That snapshot preceded the second authorized SMS challenge; a fresh two-challenge census and reviewed manifests are required before cleanup. No cleanup has run. Next: attach this evidence and update the feature tickets, perform exact guarded cleanup, require zero practice employees in the published view, Retry the recorded jobs and capture current last-success evidence. Parent191, lift193 and consistency516 remain open for those steps. Local databases stay off; SCRUM-223 stays paused. The recorded fix block begins with SCRUM-276 afterward.

**13 October 2026, feature staging acceptance checkpoint:** All six services are observed live on green main5b2f049fba750403fe60284bf2b8b4855eb934b4. Read-only job-db6quk59fdbs73e0sa50 confirms16 app journal entries through0015 and required document ownership columns. The real import screen previewed one each New/Changed/Unchanged/Invalid with two Matched rows, applied only Changed/New (one created, one updated, zero errors), then re-previewed three Unchanged/one Invalid with three matches. Fix preview shows one eligible member and the empty state; selection leaves saved routing unchanged. Other-park404, signed-in staff403 and anonymous401 are observed. Four inspected staging PNGs and two module records evidence these completed journeys.

The synthetic probation action returned200; exact replay200 retains the same completion time and another park receives404. The title-only action returned201; exact replay201 returns the same change and one history row with actor/time. Changed payload409 and another park404. Transfer history and the remaining staged journeys continue. The single authorized SMS request returned200 and a challenge; receipt/code verification is awaiting the recipient. No actual receipt or verified-family claim is made. Exact fixture cleanup and final job Retry/read-back remain before parent story closure. Docker and local databases remain off. Documentation-only checkpointc8b05338 has no CI run because the workflow excludes docs; the feature source gate5b is green. Continue acceptance, then the fix block startingSCRUM-276; SCRUM-223 remains paused.

**13 October 2026, seven features on green main:** Main 5b2f049fba750403fe60284bf2b8b4855eb934b4 passed all six jobs in run38309414401. API4033 tests passed; API compiler zero diagnostics; app446 diagnostics across59 files/118 buckets exactly match the green candidate. The89 feature runtime controls, restore/replay and30 Console browser checks passed. All seven original feature items are committed to main; PR10 is merged and earlier integrated feature PRs are closed. SCRUM-194 and516..522 remain Testing; SCRUM-191 remains In Progress until staging acceptance and cleanup finish.

Feature app deployment dep-db6l2ts9v7es73fudqj0 is building from that exact green SHA. The last observed app remains4dcc6664 through0010; no feature staging or SMS delivery is claimed. Isolated preparation is complete: an unlinked ZZ TEST employee for import/history, a four-outcome workbook (preview200, one each changed/new/unchanged/invalid, no Apply), and one manager-added ZZ TEST family with the authorized receiving number held privately. Exact IDs/fingerprints are retained in the ignored s194 fixture ledger. No SMS has been sent. A separate read-only combined cleanup census preserves the original R7 guards; cleanup is still pending.

Continue the seven staged journeys after the release is live, attach inspected evidence, finish exact practice-record cleanup and capture successful job Retry/read-back. Attendance face mode remains off; its unavailable positive staging attachment path must stay explicit. Local databases remain stopped. Complete this story before the OPEN_ITEMS fix block beginningSCRUM-276; SCRUM-223 stays paused.

**13 October 2026, seven-feature landing gate complete:** Exact candidate5aa3a826990d7456f9c4b08ba89a571f726dcf7d passed all six jobs in run38307721854. This includes app build, full restore/replay,89 feature runtime controls, the corrected eighteen-writer ownership inventory, the full API shards, workspace lint/tests and30 Console browser checks. Whole workspace output has zero diagnostics, including API zero; the whole app output is446 diagnostics across59 files/118 buckets, with no new or increased baseline bucket. The existing457 ratchet stays unchanged. All later changes are documents and four inspected staging evidence cards; application, migrations, tooling and workflow source remain identical to this green candidate.

This landing completes source for all seven original SCRUM-194 items: import preview/results, Fix recipient preview, SOP history/archive/restore with its Studio entry, optional attendance evidence, staff inbox delivery state/retry, returning-family SMS verification, and explicit employee action/history continuity. Final app migrations are0011 SOP,0012 attendance,0013 presence,0014 family verification and0015 employee actions. Staging is currently through0010 on app4dcc6664; the five platform services are live atR8main8aef1822. Watch the new main landing SHA before feature deployment and perform the prepared seven staging journeys. No actual SMS has been sent; one controlled delivery is authorized. Feature tickets remain Testing until their actual inspected staging proof is attached.

SCRUM-193 is Testing: lift source/main gate and five remaining platform action/read cases are evidenced. Final job success requires exact practice-record cleanup, zero practice employees in the published view, then Retry and last-success read-back. Historical success/forced-failure/Retry evidence is recovered. Keep the seeded cast, protected payment and Som's sick-day unchanged. Local databases remain off. Complete story acceptance and cleanup, then OPEN_ITEMS fix block beginningSCRUM-276; SCRUM-223 stays paused.


**13 October 2026, round 8 main gate green:** Exact main8aef1822641102548b20afa7684c0e0511c4e17b passed all six jobs in run38307445025; the required full-SHA watcher completed successfully. Whole workspace compiler is clean (API zero diagnostics), and the app's457 diagnostic lines are identical to the green candidate. The main-SHA restore artifact confirms184 source tables/1108 rows,76 platform and11 app migrations,187 restored tables/five views on both runs with identical counts/journals and complete cleanup. SCRUM-193 was checked and moved from In Progress to Testing with a plain-words comment. It remains open for final acceptance and exact cleanup.

The final feature gate still runs on5aa3a826 in38307721854. Current PR10 head02a27f16 adds only documents and inspected evidence; application/migration/tooling/workflow source is identical, so no duplicate candidate run is started. App89 runtime checks,446/59/118 compiler, workspace/browser and POS checks pass; remaining API shard outcomes are pending. All six staging services were observed on R7b4dcc6664 through app0010; R8 platform auto-deploy is proceeding. The recorded practice-park cleanup/census/Retry remains the final jobs follow-through. Local databases remain off.


**13 October 2026, live ownership and platform evidence checkpoint:** All six staging services are observed on green R7b main4dcc6664fc2892a0becaaa0fe179f80f40646bde. Read-only job-db6kmb5g1s2s739ntp20 confirms eleven app journal entries through0010, with tenant_id required on asset_catalog, leave_policies, policy_documents and templates. Four inspected staging cards now record this release, separate-park Settings/Activity/Attention, all twelve Directory HR read/refusal cases and the POS seeded-event seam. The two temporary Directory identities were revoked and removed, with403 then absence verified. Exact broader cleanup remains pending.

R8 main8aef1822 and final feature candidate5aa3a826 are still completing API shards; their app, POS and workspace jobs are green. Final feature app proof is89 runtime checks, whole compiler446 diagnostics/59 files/118 buckets with no increase; workspace/API compiler is clean and30 Console browser tests pass. No full final-gate or feature-staging claim yet. The current jobs completeness alert is restricted to the retained practice park without a scheduled-job key; the existing park groups succeed. After feature acceptance, remove exact practice records, require zero practice employees in the published view, Retry and capture last-success evidence. Historical forced-failure/Retry records are recovered; today's final jobs gate remains open. Local databases remain off and SCRUM-223 remains paused.


**13 October 2026, round 8 landing checkpoint:** R7b main 4dcc6664fc2892a0becaaa0fe179f80f40646bde passed all six jobs in run 38305074975. R8 is rebased onto that main with all seven source commits retained and an empty application/tooling/workflow diff against green candidate b4fa425d309c08fe14b810c74b773b2c888df30c. Run 38303242637 passed the full battery, genuine restore/replay and measured compiler gate: API zero diagnostics; app 457 diagnostics/61 files/120 buckets. The real rehearsal restored 184 source tables/1108 rows and finished with 187 app tables, five views and eleven app migrations twice with identical counts and complete scratch cleanup.

This landing adds the restore/compiler gates, current event ownership record and an evidence-backed acceptance register. Main's actual landing SHA must now be watched. Last observed staging app remains d18d3fd8 through0009; staged0010 read-back is still pending. SCRUM-193 remains In Progress for six named platform evidence cases, final screen limits and exact cleanup. A guarded cleanup preview found 261 rows across 60 tables and ten exact objects, with no mutation. The practice park remains for feature acceptance.

PR10 contains all seven feature items and the active SOP editor entry. Its preceding candidate passed 89 feature runtime checks, app build, workspace/browser checks and two API shards; the remaining shard identified an Attention writer inventory expectation still pointing to the prior file location. The bounded test correction preserves all eighteen ownership checks. No full feature gate or staging release is claimed. Local databases remain off; SCRUM-223 remains paused. Complete current story acceptance before the recorded fix block beginning SCRUM-276.


**13 October 2026, R7b landing gate complete:** Full hosted run38303168097 passed all six jobs on2b84a5afdc3fd2ced31e2df05f1d7b153ab6b1ab. Whole workspace typecheck is clean, API has zero diagnostic lines, touched review lint passes and the current-chain replay proof passes with required document ownership. Rebase on origin/main d18d3fd8 was a no-op and all six candidate commits remain. Subsequent changes are staging evidence and checkpoint documents only; application, migration and test source are identical to the green candidate.

This landing carries app0010 after the new owning document writer was observed on staging. Main's landing run must be watched by full SHA; staged0010 verification is still owed. The last observed app remainsd18d3fd8 through0009. R8b4fa425d also passed all six jobs in38303242637, including the genuine eleven-migration restore and457/61/120 compiler baseline; land it after the R7b main gate. Combined feature PR10 is separately checking142cc3dd. Feature acceptance, one authorized SMS test and exact broader cleanup remain. Local databases stay off; SCRUM-223 stays paused.

**13 October 2026, combined feature runtime gate:** PR10's b4265ee1 app job passed all five feature runtime files (87 tests), build, migrations and restore. Its full compiler measured446 diagnostics in59 files, with no baseline bucket increase; the measured457 ceiling is retained until the final source is checked. The two historical API fixture diagnostics are addressed by e030d971 with touched lint clean. Presence recovery outside both live tabs is now integrated at07a99a9f; its five pure checks passed, while the final hosted runtime recheck remains. The new read-only recovery path retains the original request details and checks current park/branch access. No source finding is silently dropped.

This checkpoint publishes the final recovery and fixture correction plus inspected private-file staging evidence. Feature staging acceptance and exact broader cleanup remain; no new deployment or SMS delivery is claimed. R7b and R8 gates are still watched by their exact SHAs. Main remains green; local databases stay stopped.

**13 October 2026, private-file release evidence:** On stagingd18d3fd8, all four existing synthetic payroll CSVs and the payslip PDF returned own200/foreign403/anonymous401. The Fix image and test drop-off signature returned own200/foreign404/anonymous401. The event PDF returned own302/download200 with a49106-byte PDF, foreign404 and anonymous401; its exact object fingerprint is refreshed for cleanup. The inspected r7-private-files-release-rechecks-20261013.png and module page record these results. The recorded R7 module rechecks are complete; exact broader fixture/object cleanup and final acceptance reconciliation remain.

Combined features are published in PR10 atb4265ee1; all matching ticket statuses were checked and commented. Final presence recovery outside both live tabs is committed at07a99a9f but not yet published. The combined candidate's hosted workspace compiler identified two nullable fixture accesses in the historical R6 review; that bounded correction is in progress. R7b2b84a5af and R8b4fa425d gate jobs continue; their workspace/API typechecks are clean, and R8's full app compiler is exactly457/61 files/120 buckets. Hosted restore counts repeat exactly across both restores:184 source tables/1108 rows,187 app tables,5 views and11 migration entries; cleanup complete. Do not claim a full candidate pass until every job finishes. Local databases remain stopped; main stays green.

**13 October 2026, administration and voucher staging evidence:** The isolated person was created201 in the expected park, read200, assigned a selected-branch policy200 and updated through own bulk permission control200 (one update). Foreign person/policy reads, policy writes, deletion and Data Admin read/update/delete each returned 404; a foreign branch replacement returned403. Foreign bulk update reported zero updates/one skipped and left the policy unchanged. Exact person/policy cleanup returned200 and both reads404. All seven legacy voucher mutation routes returned409/vouchers_moved; no voucher was issued or redeemed. The inspected r7-administration-voucher-rechecks-20261013.png records these controls. Remaining R7 work is final private-file rechecks and guarded fixture/object cleanup; the shared practice park is still retained. R7b2b84a5af and R8b4fa425d are published with their corrected historical expectation; hosted gates continue. Combined feature integration and presence recovery checks continue separately. Main remains green atd18d3fd8; no additional release is claimed. Local databases remain stopped.

**Newest checkpoint, 13 October:** main d18d3fd8 is green and observed live. Camp attendance, payroll access and actual form save/reload rechecks pass with two inspected frames. R7b3c8 and R8 973 each have one historical complete-chain nullable assertion corrected at84829a82; five other jobs passed, including R8's final eleven-migration restore. Combined candidate da21a661 has cumulative0011..0015 migrations and employee-history/current-access delivery controls; hosted runtime checks and two presence display/retry follow-ups remain. Read newest STATUS. Keep local databases/heavy checks off. One coordinator publishes; isolated agents work in parallel. Land R7b then R8, finish staged checks/cleanup and feature acceptance, then the fix block. No feature/SMS delivery is claimed.

**13 October 2026, R7a live writer and SMS service evidence:** The app is live on Render at `7402a8da2614214c41085277a86b0c4637abff66` (deployment dep-db6j2btg1s2s739gqjcg), after all jobs in CI38294258814 passed. The read-only staged census reports ten app journal entries through0009, with zero unplaced templates, policy documents, asset catalog entries or leave policies. The second park's new Data Admin asset writer returned201 with its correct owner; own read200 and another park's read404. Its exact ZZ TEST row was then removed204 and read back404. The inspected `r7a-document-writer-staging-20261013.png` records this prerequisite. R7b/0010 may now proceed through its release gate. Other recorded R7 acceptance rechecks and full fixture cleanup remain.

Twilio runtime status now reports configured=true, enabled=true, twilioConfigured=true and sessionSecretConfigured=true. The inspected `sms-provider-config-staging-20261013.png` records configuration only. The controlled receiving number is present in the local environment; no SMS has been sent. SCRUM-522 is now Testing with built source `cb27d078` in PR8 and23 focused controls passing. The feature itself is not yet live. Real receipt, code entry and verified family access remain release acceptance.

Updated source checkpoints: Fix PR4/a347b853 includes the captured-result compiler guard; SOP PR5/5924faac has16 passing controls and clear touched lint after R7 integration; attendance PR6/aeab3a23 has nine controls, actual multipart proof and its app CI step; presence PR7/f077aaea has eight controls and retains unconfirmed retry identity independently of browser clock. Attendance reviewer consistency is committed at01bf0fa5 with six real handler/database scenarios plus six house pins, pending integration and hosted checks under SCRUM-516. Original manager approval/history scope remains the existing explicit actions; its bounded consistency work continues separately.

The owner needs workstation memory: Docker may be stopped; all local DB checks have finished, their fixture databases were removed, and the coordinator's native15433 helper was shut down. Do not start local database processes or broad suites until the owner makes them available. Continue source integration and hosted CI. Main isd18d3fd8 with its full-SHA run38296316898 in progress; app/workspace/POS jobs passed at this checkpoint. Preserve test outcomes and label unrun or interrupted work honestly. SCRUM-223 remains paused.

**13 October 2026, published feature batches and SMS configuration:** R7a landed on main at `7402a8da2614214c41085277a86b0c4637abff66`; PR1 is merged with its individual commits preserved. Main CI38294258814 passed all six jobs. App deployment dep-db6j2btg1s2s739gqjcg has started on that exact SHA; runtime confirmation remains pending. Staging app remains633cae41, with app migrations through0008 last observed. No new live release is claimed.

Five feature batches are published and Testing: employee import PR3/db51ee5c; Fix preview PR4/3af75edd with its R7 canonical-person integration complete and seven focused controls; SOP history PR5/5924faac with 16 controls and all touched-file lint passing after R7 integration; attendance evidence PR6/9e79dacc with nine controls, actual multipart and browser checks; presence inbox delivery PR7/7c911c02 with eight real-route/database controls. Final migration numbering, combined release checks and staging proof remain. SOP R7 integration is complete; its provisional migration SQL is unchanged. Preserve applied migrations and R7a/new-writer/R7b release order.

SCRUM-522 returning-family SMS verification is building. The owner provided the three existing Twilio settings in the root environment; a read-only provider request returned200 with matching account/service and six-digit codes. Those settings are saved on oto-app-staging and their readback matches. The running instance still reports SMS unconfigured until an eligible deployment activates the saved settings. No SMS was sent. The owner authorized one controlled delivery test and will provide TWILIO_TEST_RECIPIENT in the local environment; do not copy that test-only setting into the service. Real receipt/code entry and saved-family read/write acceptance remain owed.

Original item7 is implemented by existing explicit manager Complete/Save Changes/Transfer Employee actions and actor/time history; no second approval stage is inferred. Its staged journey remains owed. Source review identified bounded attendance-reader and employee-history consistency work, recorded under SCRUM-516 in OPEN_ITEMS and the feature plan. Attendance integration preserves existing approval intent and the face switch. SCRUM-191/193/194/516/522 remain In Progress; SCRUM-223 stays paused.

**13 October 2026, R7a main release checkpoint:** the complete Linux gate passed in CI38291346882 on67eadb261f8220444dc2cfa336339aff0003425c, including all API shards and app ownership/migration jobs. Later source is identical; final API compiler output is zero bytes and six historical reruns passed228 controls. The older local full runs were stopped with partial logs preserved. R7a carries0009 and nullable document ownership; watch the actual landing SHA and observe new document writers on staging before R7b/0010. App633cae41 is still the last observed deployment. New feature lanes continue separately; detailed source and gate evidence are in newest STATUS.

**13 October 2026, visible feature batches:** draft PR1 R7, PR2 R8, PR3 employee import and PR4 Fix recipient preview are published. SCRUM-518 is Testing; SCRUM-517 still requires R7 canonical-person integration. SCRUM-519 SOP history and SCRUM-520 attendance attachments are locally built and in focused review. SCRUM-521 presence delivery is building for the staff in-app inbox, following the owner's Q3 answer. Preserve individual commits and publish frequent PRs with one coordinator. The newest STATUS block names exact source and verification; no new release is live yet.

**13 October 2026, development-first delivery:** Read the new [delivery board](../progress/plans/otoapp-lift/DELIVERY.md) for completed source by feature and ticket. The owner requested focused checks during implementation and consolidated release verification, with visible development checkpoints. Finish independent approved batches while existing checks complete; do not restart broad suites for documentation or repeat passing checks without a relevant change. R7 application development is on its published lane, R8 tooling is prepared separately, and SCRUM-194's seven original items are being reconciled into concrete implementation batches. Main/staging remain unchanged. Preserve R7a/new-writer observation/R7b/R8 order, the landing gate and exact cleanup. The newest STATUS block wins.

**13 October 2026, final build checks and nanny walkthrough:** The frozen API typecheck passed with zero diagnostic lines; all15 changed API test-file hashes stayed unchanged during that run. App production build passed including all three telemetry files. Forced lint covered all39 touched JS/TS files with zero errors,472 existing no-explicit-any warnings and no ignored files. The complete app compiler remains457 diagnostics/61 files, with no per-file/code increase. Six historical review files now preserve their original migration boundaries as0009 follows; source scans prune dependencies before descent. The full277-file API battery is still running, with focused historical, interrupted and timing reruns required before landing. These checks do not yet establish a green full battery.

Staging nanny assignment, entry and checkout each returned200 using the isolated ZZ TEST employee and disposable on-duty fixture; the Out screen showed completion. Issued drop-off photo200 without capability404; private signature own200/foreign404/anonymous401. Four old voucher addresses displayed the Console notice. Xero status200 connected=false, report400 and staff403; no sandbox connection or positive sync is claimed. Three additional inspected frames and module pages record these results. Exact cleanup remains owed. Main and live app remain unchanged; R7 is on its published lane. SCRUM-191/193/516 remain In Progress, SCRUM-223 paused. Next: finish/recheck the battery, landR7a and observe its owning writer, thenR7b and the staged ownership rechecks. No owner answer blocks that work.

**13 October 2026, round-7 release checks and drop-off evidence:** The final whole app compiler read measures 457 diagnostics across 61 files, down from the inherited 467. No file or file/code bucket increased; the final reader batch removed five more permission-context diagnostics. Applied app SQL and snapshots 0000..0008 are byte-identical to main; 0009 alone is new, and the four document ownership columns remain nullable for the first release. Platform migrations are unchanged.

The DB cleanup and POS header checks both passed their focused whole-file reruns (7 and 75 tests). Booth and box suites passed; box reports 740 tests. The full API battery continues. Historical round-4/5/6 migration/source expectations require their original release boundaries to remain explicit now that 0009 exists; the separate print timing check requires a focused rerun after the heavier work. Main remains a81fcb899e8376dd84bbe0bdf1320d3ce2d52368 with green CI 38240328400. R7 remains on its published lane, not deployed.

On staging app633cae41, the isolated public drop-off screen submitted200 and showed its success screen. The resulting age-five nanny registration appeared in its park's list only. Owned detail200; other-park detail, entry and nanny assignment each404. The inspected frame is r7-dropoff-submitted-tablet-20261013.png. It uses synthetic ZZ TEST guardian/child details, a labelled generated photo and a test signature. Nanny assignment/completion and exact new record/object cleanup remain owed. No owner answer is blocking the current release. SCRUM-191/193/516 remain In Progress; SCRUM-223 stays paused.

**12 October 2026, final round-7 reader and payroll review saved:** The coordinator recovered the saved lanes after service-capacity interruptions and completed the recorded correction batch. Integrated payroll review passed all24 checks; the seven prescribed ownership cases are now passing pins, including zero-value private exports and direct staff self-read controls. The form/home-branch review first recorded two expected failures, then passed all4 checks after the fixes: owned version saves, refused foreign replay, checked draft/published translations, owned home-branch selection despite historical foreign links, and missing-context refusal. Client saves now send the displayed version and refresh its translation cache. Source is local on lane/s217b-r7, not landed or deployed.

The current staging supplier test passed validate/detail/media200, comment201, close200, repeat409, revoke204 and former-link401; its inspected labelled card is committed. The isolated ZZ TEST form saved/published200 and its public read200 retained the English title; its inspected publication frame is committed. The builder's stored-label screen recheck remains owed after release. Exact fixture/object cleanup is still owed. Main remains a81fcb899e8376dd84bbe0bdf1320d3ce2d52368 with green CI38240328400; app remains633cae41. The previously completed whole compiler read was462 diagnostics/62 files with no per-file/code increase; the final reader batch's compiler/build is next. Platform typechecks passed, including API zero diagnostic lines. Local batteries passed the shared/print/telemetry/payments and Console suites; DB236 assertions and POS1365 assertions passed, with one DB cleanup deadline and one POS header navigation deadline requiring focused whole-file rechecks. Full API battery and remaining booth/box suites are next. Docker was reopened by the owner and its local5433 connection is verified; current checks finish on the shared local PostgreSQL16 instance at15433. All seven original SCRUM-194 items remain the working scope in its new coverage plan; only concrete behavior/provider questions remain. SCRUM-191/193/516 remain In Progress; SCRUM-223 stays paused.


**12 October 2026, round-7 review checkpoint published on the lane:** Main remains a81fcb899e8376dd84bbe0bdf1320d3ce2d52368, with CI 38240328400 green. This checkpoint is on lane/s217b-r7 for review; it is not a main landing or a deployment. Rounds 5 and 6 evidence and cleanup are complete. Ten inspected round-7 staging frames now record events, menus, parent/RSVP, camps, SOP, training, Vault, payroll exports and Fix on app 633cae416ff7e4a1c253ec4904cdc22351cf7df1. The walkthrough index records the exact actions and limitations. Camp attendance and payroll foreign-export cases remain BROKEN on staging until release and recheck.

Three approved isolated lanes continue: access/payroll delivery, independent payroll review, and restore/typecheck tooling. Finance imports, Xero placement, administration, people, camp, permission replacement and payroll file guards are built locally. The independent permission/private-photo recheck passed all 15 bounded pins against cf6c21a4884de26822fdc4a7bf03b34b99e569b7; shared-role question Q54 alone stands. Payroll review covers all 45 registrations and records seven ownership findings; prescribed parent/context guards are being applied together under SCRUM-516. No payroll calculation or existing salary advance was changed. R8 has 17 green tooling pins; its genuine final 11-migration restore rehearsal is running separately. The last access compiler measured 463 diagnostics, four fewer than the inherited 467; the coordinator still owes the whole integrated output and per-file comparison before tightening the ratchet.

Release order is R7a (0009, nullable document columns and new owning writers), then R7b (0010, document placement replay and NOT NULL) only after those writers are observed live, then R8. This protects the still-serving round-6 Data Admin writer during pre-deploy. Independent R7b rerun passed four migration pins, including nullable gate failure and successful retry/replay. Platform next migration remains 0076; staging app remains applied through 0008. Final integrated battery, typechecks, touched-file lint, rebase, main push, full-SHA CI and staged rechecks remain owed. Exact ZZ TEST record/object cleanup, including the shared practice park/user, remains owed before closure. SCRUM-191, SCRUM-193 and SCRUM-516 remain In Progress; SCRUM-194 remains To Do pending its existing scope decision, and SCRUM-223 stays paused. No owner answer is required for the current release work. After the lift, follow OPEN_ITEMS section 2 in its worked order.

Read the newest CODEX_HANDOVER resume note for exact continuation. The shared practice park/user and round-7 fixtures require guarded cleanup before closure. Preserve seeded accounts and Som's 14 October sick day.

## 3. Order of work (owner priority, 9 October - supersedes 2 October)

1. **Finish S2-17b**: land round 6 on its final recheck's MERGE (the lane
   state and deploy order are in section 2), then rounds 7 and 8 per
   PLAN.md section 8, each as a lane build-review cycle with the same gate.
2. **Then the FIX BLOCK**: every verified-open defect and small task, in
   the worked order of docs/progress/OPEN_ITEMS.md section 2 (money and
   safety first; pairings as marked). The owner ruled this comes BEFORE
   any new story.
3. Only then the next story (S2-18 Radar, S2-19 Inbox, S2-22 data,
   S2-23 Console, S2-16 acceptance; S2-24 bench when hardware time is
   scheduled - it is paused at the bench freeze, brief in AGENTS.md +
   docs/handover/CODEX_HANDOVER.md).

## 4. How behaviour is decided

- **The approved design is the prototype's code**, at
  `imports/oto-pos/artifacts/oto-till/src` (reference only, never committed;
  the setup script clones it, see section 8). Port its rules as they are,
  including its edge cases and its visible words and layout.
- The platform adds only data reliability on its own authority: the branch's
  own records, the branch's business day, real ids, money in satang,
  persistence, sign-in and permissions, audit, idempotency, offline boxes
  and real devices.
- Any other difference is a rule choice. Do not build it. Add it to SCRUM-497
  as a short question with the design's behaviour as the default, and keep
  building to the design.
- Where the design has nothing, the story's own acceptance criteria apply.
- Code comments state constraints only. Never describe earlier platform
  behaviour as a bug or a mistake.

## 5. How work is built and landed

- **Plan, build, focused review, fix, re-review.** Larger units use
  subagents or workflows, with an explicit list of files each one owns so
  parallel builders never edit the same file. Every subagent or workflow
  agent runs on `claude-opus-5-5`.
- **Before landing**, run these yourself:
  - `npx tsc -p tsconfig.json --noEmit` inside every package touched (the
    only trusted typecheck);
  - `npx eslint <every file landing>` from the repo root;
  - the relevant tests with `TEST_DATABASE_URL=postgres://oto:oto@localhost:5433/oto`
    (packages/db migration suites need `--no-file-parallelism`).
- **Migrations**: the next free number after main's highest (0054 is the
  latest on main), add-only, journal entry ordered after the previous one.
  Never edit an applied migration.
- **The landing list** is built by comparing files with `origin/main` by
  content, never from memory.
- **Landing**: on a working branch, `git fetch origin && git rebase
  origin/main`, re-run the checks, then `git push origin HEAD:main`
  (fast-forward). Another lane may also push to main, so always rebase first.
  If pushing to main is refused, push the branch and merge it with `gh pr
  create` + `gh pr merge --rebase`.
- **The progress update rides in the same commit**: a short checkpoint block
  at the top of `docs/progress/SPRINT_2_PROGRESS.md`, and section 2 of this
  file updated.
- **Commits** follow `CONTRIBUTING.md`: `type(scope): summary`, a bullet
  body, a `Refs: SCRUM-n` footer. No attribution or co-author lines of any
  kind. Write about the system, never about the commercial arrangement.
- **CI**: after every push, `scripts/agent/watch-ci.sh <full-sha>` in the
  background. A red run is diagnosed and fixed in the same turn, and the
  ticket is told plainly.
- **A problem found** is fixed now, or becomes a Jira ticket with its plan,
  or gets a workflow launched. Never only noted.
- **Answering "is X built?"**: read the code and drive staging. The three
  answers are WORKS, BROKEN or NOT BUILT.

## 6. Jira and staging evidence

- Helpers: `node scripts/agent/jira.mjs status|comment|walk|attach|images`
  (library functions in the same file, including `createSubtask`).
- Statuses go To Do, then In Progress (work starts), then Testing
  (committed), then Deployed (live on staging **with a screenshot**). Done
  belongs to the owner.
- **Same turn as every push**: a plain-words comment for a non-engineer
  (what a person at the park can now do; no file names or internal tools)
  and the status move. Re-read the status afterwards.
- **Deployed needs a staging screenshot** attached to the ticket and
  referenced in the comment, showing the change as a person sees it. Use
  `scripts/agent/evidence.mjs` (`posSignIn`, `card`). Open every image
  before using it. Commit the PNGs under
  `docs/qa/jira-comments/attachments/SCRUM-<n>/`. `walkTo(key,'Deployed')`
  refuses without an image.
- **Staging deploys do not follow main by themselves.** Deploy with
  `node scripts/agent/render.mjs deploy all <sha>`, then confirm with
  `node scripts/agent/render.mjs status`. The api's pre-deploy runs
  `pnpm db:migrate && pnpm db:platform-sync`. Sites:
  `https://oto-pos-staging.onrender.com`,
  `https://oto-console-staging.onrender.com`.
- **Staging data rules**:
  - name test records with the prefix `ZZ TEST`;
  - FWBooth1 is read-only;
  - never touch payment run 0d008153 or the package "Native payment adult
    ticket 0d008153";
  - never write the OTO App's `otoapp.*_checkins` tables;
  - never photograph identity documents;
  - never print, log or commit a secret.
- One-off database reads on staging: `node scripts/agent/render.mjs job
  "cd apps/api && node -e \"...one line...\""` (no `$`, no newlines, schema
  `core` for branches).

## 7. Open points waiting on the owner

- The consolidated ruling list: docs/progress/OPEN_ITEMS.md section 3
  (ticket rulings 481/482/485/428/434, SCRUM-497, the 277 remainder) and
  every plan's question list (lift Q1-Q54; benefits; events; analytics -
  Q3 blocks SCRUM-508's fix).
- Waiting on outside parties: Xero connection, 2C2P sandbox credentials.
- SCRUM-510 (flake cause-naming) is queued for the first hygiene lane of
  the fix block, not on the owner.

## 8. The hosted environment

- Setup: `bash scripts/agent/cloud-setup.sh` (also the environment's setup
  script). It installs dependencies, starts Postgres on localhost:5433
  (`oto`/`oto`), clones the design reference into `imports/oto-pos` when
  `PROTOTYPE_REPO` and `GH_TOKEN` are set, installs Chromium, and writes a
  repo-root `.env` for the helpers from the session's environment.
- Settings the session needs (names only; values live in the environment):
  `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `RENDER_API_KEY`,
  `GH_TOKEN`, `PROTOTYPE_REPO`, `STAGING_ADMIN_PHONE`,
  `STAGING_ADMIN_PASSWORD`, `STAGING_RECEPTION_PHONE`,
  `STAGING_RECEPTION_PASSWORD`, `STAGING_MANAGER_PHONE`,
  `STAGING_MANAGER_PASSWORD`.
- Network: npm, GitHub, Docker Hub, the Playwright CDN, `*.atlassian.net`,
  `api.render.com`, `*.onrender.com`.

## 9. Known pitfalls

- Workflow scripts must have LF line endings.
- Builders sharing a checkout must never run git checkout/reset/stash or
  restore a file from a git ref; they edit forward and report a complete
  file list.
- When a gate hands something over, act on it at once: put it in the next
  round's brief, or file a ticket.
- `gh run list` truncates titles, so always match CI by commit SHA.

## 10. Work in flight at the hand-over

### The one open thread: round 6's final gate

The second fix round + final recheck workflow was running when this
hand-over was written (lane lane/s217b-r6, worktree C:/w/k1). What it is
closing: the id-less /api/employees* doors (the list, the Excel import
preview/apply, reorder), the storage.getEmployee call-site family (time
override, timekeeping read, role-holder writes), and the create body -
each either fenced to the caller's park group or dispositioned to its
named round in the census (server/lib/employeeParkGroups.ts). The final
recheck recounts both censuses itself and drives every door as another
park group before it may say MERGE.

**If this session is resumed locally:** read the workflow result, then
follow section 2's land-or-wip instruction. **If the cloud session takes
over:** git fetch; if lane/s217b-r6 exists on origin as wip, read
STATUS's newest block for where the gate stopped; the lane's review file
(apps/api/test/s217b-r6-review.test.ts) states every finding as a test.

### Standing debts that ride along (no action until their moment)

- Round 5+6 walkthrough pages (capture-agent passes at the next staging
  window; the SPRINT_2_ACCEPTANCE rows).
- The staging offboarding census before 0008 deploys (section 2's order).
- The 03:00 departed-login door and pre-existing cross-park login links
  (recorded in PLAN section 10; check staging for such links before
  round 7 closes).
- SCRUM-509's phone-bar design rule; SCRUM-503's scroll-hint choices.
