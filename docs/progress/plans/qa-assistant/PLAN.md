# OTO App issue reporting assistant

18 October 2026. Implementation task **SCRUM-548** in **Sprint 2 - Complete build** (Jira sprint ID3).

## Purpose and boundary

Maria and other signed-in park testers can report a problem from the OTO App, attach screenshots or a short video, receive an evidence-based explanation and obtain a complete Jira record for later review. The assistant records reports even when the evidence is incomplete, another report is related, or the current rule explains the outcome. It never implements a reported change: no repository writes, business-record mutations, deployments, development workflow transitions or automatic fixing agents.

The owner reserves Done for final acceptance. The implementation and its children stop at Deployed with inspected staging evidence.

## Tracking

| Work | Ticket | Current state |
| --- | --- | --- |
| Complete feature | SCRUM-548 | Deployed |
| Scoped saved reports and private evidence | SCRUM-549 | Deployed |
| In-app reporting conversation and history | SCRUM-550 | Deployed |
| Bounded analysis, source inspection and Jira publishing | SCRUM-551 | Deployed |
| Release and staging acceptance | SCRUM-552 | Deployed |

New reports belong to **OTO App - QA and Bug Triage**, sprint36, under intake **SCRUM-553**. The intake is separate from this implementation task and the earlier Maria group SCRUM-524. Existing reports and their statuses are retained. New report subtasks inherit the configured QA parent's sprint; the publisher refuses the Sprint2 destination.

## Delivery contract

1. The authenticated app offers Report an issue without changing its current work screen. A dedicated responsive page lists the current reporter's conversations.
2. Save each message before analysis. Attach screenshots and short MP4/WebM recordings privately, with file-type and size checks. Pasted screenshots are supported.
3. Automatically record the source page without query strings, selected branch, role, browser, viewport and server-proven deployed version. Do not collect passwords, session storage, full request payloads or unrestricted console logs.
4. A durable report queue and leased worker recover interrupted processing. New messages invalidate older results. Repeated submissions and processing retries retain one report and Jira issue.
5. Create the Jira record regardless of AI availability, then add an analysis and follow-up evidence to that same record. Publishing failures remain visible and retryable.
6. Claude receives bounded text, approved source excerpts and screenshots or timestamped video frames. Source is pinned to the app release at report time. A private versioned source snapshot avoids copying workstation GitHub credentials into the worker.
7. Assessments produced in this release are Reported, Supported by code, Guidance provided or Needs investigation. The assistant never invents a Reproduced claim. It names missing evidence and explains a documented rule politely.
8. Model output is structured report content, never an executable command or unrestricted tool call. Only bounded QA storage, analysis and configured Jira publishing capabilities exist.
9. Conversations and evidence require both the current reporter and park. Another reporter, another park and a signed-out request cannot read them.
10. Video analysis is visual. Audio is not transcribed in this release; the upload screen asks for the explanation in chat and the analysis names this limit.

## Infrastructure and configuration

Reuse existing app authentication, Postgres and private S3-compatible storage. Add one small Render background worker, built from the app source, without a public URL. The app image also bundles a versioned source index. Worker secrets stay server-side; do not expose or record values.

The existing Anthropic credential's model-list request passed on18October. The configured analysis model will be claude-sonnet-4-6, which that account advertises. Set explicit per-report token, image/frame, attempt and daily-analysis limits. Credit or provider failures preserve the report and Jira recording.

The first new app migration is provisional0016; current app SQL0000-0015 stays immutable. No platform migration is planned. Root verifies the free number and SQL/snapshot at landing.

## Acceptance and evidence

- Launcher entry; actual text report, screenshot paste/upload and short-video upload; conversation reload and follow-up.
- Actual Claude response with honest source/evidence labeling and a Jira subtask under553/sprint36, including attachments and later comments.
- Same-report retry and repeated request keep one Jira record; provider/publishing interruption does not lose a report.
- Own versus other-reporter/other-park/anonymous refusals, including direct attachment reads.
- Prompt asking for a code/data change receives a reporting-only explanation, without any fixing capability.
- Worker boot, leased processing, published source snapshot version and observed deployed SHA.
- Focused tests, whole compiler outputs with no new/increased diagnostic bucket, build and the main release checks. Current inherited app ratchet is430 from15October; the older467 ceiling is not permission to add errors.
- Inspect evidence images before attachment, commit under docs/qa/jira-comments/attachments/SCRUM-548/, and keep statuses truthful.

Staging records created for acceptance use ZZ TEST. Preserve the seeded cast, FWBooth1 and protected payment0d008153. Use only synthetic screenshots/recordings. No SMS or production-data action is required.

## Current progress

18 October final checkpoint: SCRUM-548 and549-552 are Deployed with inspected staging evidence. Live app and worker source0e2e87eb passed its complete app gate39121598434; the prior full platform gate is39120053840/c0422d18. Four ZZ TEST examples554-557 remain To Do under553/sprint36. R1-R13 delivery controls are completed. The [acceptance record](../../../qa/qa-assistant/acceptance.md) names exact releases, checks, live journeys, images and limits. Done remains owner acceptance.

### Earlier delivery checkpoints

18October: implementation task and four children created; QA sprint36 and parent553 created. Backend, UI and worker development are running in parallel under one publisher. Main's last source gate is green. No new implementation is deployed yet.


18October source checkpoint: backend and UI slices are complete; worker orchestration is integrated. The production build passes and emits dist/qa-worker.cjs and a520-file private source index. The current app compiler ratchet passes; whole-output review and hosted runtime acceptance are being completed. No staging deployment is claimed.

### Review records

All recorded findings below have prescribed corrections in the candidate and passing focused pins, with database pins awaiting the hosted gate. Nothing is silently omitted.

| Record | Severity | Delivery control |
| --- | --- | --- |
| R1 | Medium | A replay after a release change keeps its original report and source context. |
| R2 | Medium | Stable upload IDs retain one evidence row/object; altered reuse is refused. |
| R3 | Medium | Bounded analysis always retains the newest user turn and labels omitted history. |
| R4 | Medium | Unsupported runtime-success claims and forged source references become Needs investigation. |
| R5 | Medium | A stale processing failure queues the newer report revision. |
| R6 | Medium | All ten accepted files reach Jira; the separate model frame limit stays eight. |
| R7 | Medium | Private evidence reads have both a byte limit and a total stream deadline. |
| R8 | Medium | Long Jira paragraphs retain their full permitted report/follow-up text. |
| R9 | Medium | Private UI state and caches are scoped to both reporter and current park. |


18October hosted gate: candidate e099fcdb stopped at the report runtime review after20 independent/worker pins passed. R10 (medium): normal one-file multipart upload must fit the parser boundary. Correction applied: parts2, files1 and fields0, with a real HTTP single-file acceptance/second-file and field refusal control. The local three-key media/parser check passes. Review failure messages now expose only control names and setup tags. Backend proof now contains17 controls; full candidate rerun is pending.


R11 (medium), source-reference visibility: validated citations are appended to the response and Jira analysis, alongside the inspectedSHA, rather than retained only in private processing metadata. The existing worker check now passes11 controls, including visible references and refusal of unsupported ranges or missingSHA. Raw source is not published.


Landing checkpoint: candidate315a6fd2 passed the complete hosted release gate before landing. Its app gate passed 36 review pins with zero skipped, 17 backend controls, 11 worker controls and 11 independent controls, plus 89 existing feature and 32 scheduling tests. Compiler output is unchanged at430 diagnostics / 57 files / 114 buckets. Restore/replay preserved 1,108 rows and stable migration ledgers across two runs at 195 tables. The PR merge checkout and candidate have identical Git trees. Main and staging verification remain the next steps; the release checkpoint changes documentation only.


R12 (medium), entry clearance: Report issue retains bottom clearance above Core navigation on desktop and mobile, with its existing stacking level below dialogs. The normal-click browser controls pass at1440x1000 and390x844 using real CSS and a representative navigation overlay; authentication/HTTP are mocked. The source follow-up repeats the main release gate before final staging confirmation. The prior live release b358aaf7 already saved private screenshot/video evidence, passed owned-byte and reporter/anonymous refusals, retained history, and obtained a real Claude answer and Jira recordSCRUM-554.


18 October staging checkpoint: R12 is confirmed by ordinary desktop and mobile clicks on live c0422d18, whose full six-job gate passed. SCRUM-549/550 are Deployed with inspected evidence. Reports554-556 each have one issue under553/sprint36 and remain To Do. Private reads, original bytes, report/message/upload replay and cross-release source preservation passed. Both source-index probes succeeded at520 files with matching private stored snapshots.

R13 (medium), saved-report confirmation: guidance reflects the host already saving the conversation and linking its Jira issue before model review. Source0e2e87eb adds a trusted confirmation and normalizes a model self-denial about recording this QA request, without altering business-screen guidance. Existing worker controls remain11/11; production build and touched-file lint pass. The app release gate39121598434 and final live reply remain pending. No new suite or business action is introduced.


Final R13 proof: both fresh557 and older556 follow-up replies confirmed the report and conversation are saved; the older report retained sourcec0422d18 while running through the final worker. Final source0e2e87eb app/worker/private stored indexes match at520 files. App gate36/89/32 and compiler430/57/114 passed; platform suites were not rerun in this app-only gate. Actual final-release privacy, file bytes, normal desktop/mobile entry, cross-origin and replay controls passed. All feature tickets are Deployed with image attachment read-back; there is no remaining implementation finding under this plan. Video audio, unavailable owner-decision documents and hosted-only outage/cross-park coverage retain the stated limits.
