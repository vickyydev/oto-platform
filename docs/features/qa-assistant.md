# OTO App issue reporting

Delivery: SCRUM-548. [Implementation and acceptance plan](../progress/plans/qa-assistant/PLAN.md).

## For a tester

Enter the OTO App through the launcher. Choose **Report issue**, describe what you tried, what you expected and what appeared. Paste a screenshot or attach an image or short MP4/WebM video. Hide private information before uploading. A report accepts up to ten files, each up to 25 MiB. Video review samples the first 40 seconds and does not transcribe audio.

The message is saved before review begins. You can leave the page and return to **Your reports**, which shows your latest 50 conversations. Add details in the same conversation; use **Retry** for an interrupted upload or review. A Jira link appears when the report has been recorded.

An assessment describes the evidence available: reported, supported by code, usage guidance or needs investigation. Code support does not mean a person reproduced the issue on staging. A report with incomplete evidence is still recorded. The assistant can ask for useful details and explain the existing workflow; it cannot change records, implement a change or mark an issue fixed.

## For the reviewer

New reports are subtasks of **SCRUM-553** in **OTO App - QA and Bug Triage**, sprint 36. Implementation remains in Sprint 2. Earlier Maria reports under SCRUM-524 are retained. Review the reported behavior, source version, explanation, evidence and follow-up comments before scheduling development. The reporting worker never moves a ticket through development or acceptance statuses.

Analysis uses selected excerpts from the recorded app release, with visible file and line references. A source reference supports review; the reviewer checks the explanation before accepting a reported defect. The assistant can leave a report as Needs investigation when the excerpts or supplied evidence do not settle it.

Conversation history and original evidence in the app are private to the current reporter and park. Jira access follows the project's existing permissions. Only the screenshot/video supplied by the reporter is forwarded; browser sessions, passwords and unrestricted console logs are not collected.

## Deployment

The app exposes authenticated report routes behind QA_REPORTS_ENABLED. A separate Render background worker, oto-qa-worker-staging, leases saved reports from Postgres, calls Claude and publishes to the configured QA parent. It has no public URL and no fixing or deployment interface. Both images bundle a private source index tagged with their full release SHA. Analysis uses the report's source version; a missing matching snapshot is stated in the result.

The deployed build context contains app source and its README. Repository decision documents are not currently bundled. The assistant therefore uses implemented code as its default and cannot settle an unanswered owner choice.

Configuration names and secret placeholders are documented in render.yaml. Worker credentials are server-side. Claude uses an explicitly configured model and bounded output, context and visual evidence. Staging allows 100 analyses per day and 12 per report; repeated delivery attempts reuse saved analysis. Automated visual review uses at most eight sampled images, while all accepted original files reach Jira. Original evidence remains available when automated analysis cannot read it. Publishing and provider interruptions preserve the saved conversation for retry.
