# Employee documents - staging walkthrough, 12 October 2026

**WORKS for the recorded private document lifecycle.** On [the recorded staging
source and sessions](README.md), the administrator uploaded a generated ZZ TEST
PNG as an `other` employee document (201). The employee's Offboarding section
displayed it at 820 x 1180. Its authenticated file read returned 200 and 12,219
bytes; the other park group's document list returned 404.

Evidence: [actual uploaded-document panel](../../jira-comments/attachments/SCRUM-191/r6-employee-document-20261012-tablet.png),
inspected. The long test filename truncates in the tile; its controls remain
reachable. The app shows this document type in Offboarding; this frame does not
claim an ID-card or passport action.

Deletion through the document route returned 204 and a subsequent file read 404.
The final employee-document count was zero in
[the exact cleanup](README.md#cleanup-read-back). Restricted employee self-download
and every document type are outside this case.
