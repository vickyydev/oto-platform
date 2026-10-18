# OTO App issue reporting assistant

18 October 2026. Implementation task **SCRUM-548** in **Sprint 2 - Complete build** (sprint3).

## Purpose and boundary

Maria and other signed-in park testers can report a problem from the OTO App, attach screenshots or a short video, receive an evidence-based explanation and obtain a complete Jira record for later review. The assistant records reports even when the evidence is incomplete, another report is related, or the current rule explains the outcome. It never implements a reported change: no repository writes, business-record mutations, deployments, development workflow transitions or automatic fixing agents.

The owner reserves Done for final acceptance. The implementation and its children stop at Deployed with inspected staging evidence.

## Tracking

| Work | Ticket | Initial state |
| --- | --- | --- |
| Complete feature | SCRUM-548 | In Progress |
| Scoped saved reports and private evidence | SCRUM-549 | In Progress |
| In-app reporting conversation and history | SCRUM-550 | In Progress |
| Bounded analysis, source inspection and Jira publishing | SCRUM-551 | In Progress |
| Release and staging acceptance | SCRUM-552 | To Do |

New reports belong to **OTO App - QA and Bug Triage**, sprint36, under intake **SCRUM-553**. The intake is separate from this implementation task and the earlier Maria group SCRUM-524. Existing reports and their statuses are retained. New report subtasks inherit the configured QA parent's sprint; the publisher refuses the Sprint2 destination.

## Delivery contract

1. The authenticated app offers Report an issue without changing its current work screen. A dedicated responsive page lists the current reporter's conversations.
2. Save each message before analysis. Attach screenshots and short MP4/WebM recordings privately, with file-type and size checks. Pasted screenshots are supported.
3. Automatically record the source page without query strings, selected branch, role, browser, viewport and server-proven deployed version. Do not collect passwords, session storage, full request payloads or unrestricted console logs.
4. A durable report queue and leased worker recover interrupted processing. New messages invalidate older results. Repeated submissions and processing retries retain one report and Jira issue.
5. Create the Jira record regardless of AI availability, then add an analysis and follow-up evidence to that same record. Publishing failures remain visible and retryable.
6. Claude receives bounded text, approved source excerpts and screenshots or timestamped video frames. Source is pinned to the app release at report time. A private versioned source snapshot avoids copying workstation GitHub credentials into the worker.
7. Assessments are Reported, Supported by code, Guidance provided, Needs investigation or Related report found. The assistant never invents a Reproduced claim. It names missing evidence and explains a documented rule politely.
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

18October: implementation task and four children created; QA sprint36 and parent553 created. Backend, UI and worker development are running in parallel under one publisher. Main's last source gate is green. No new implementation is deployed yet.
