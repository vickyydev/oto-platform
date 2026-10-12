# Children - staging walkthrough, 12 October 2026

**WORKS for the recorded camp registration and scoped history.** The
ZZ TEST child registration on staging app `633cae41` returned 201. Its own
park history returned 200 and another park's history returned 404. The
registration identifier recorded for this child is
`be4d4e3f-d85a-48e8-b7dc-9d1547202030`.

**BROKEN for this registration's owned camp check-in**, which returned 404
and is assigned to SCRUM-516. See [the camp record](camps.md). The inspected
[camp frame](../../jira-comments/attachments/SCRUM-191/r7-camp-tablet-20261012.png)
is related context; no separate children's-directory frame was captured.
This proof does not establish every child edit, saved-family lookup or SMS
verification flow. New round-7 source remains local.

Cleanup owed: this exact registration and its recorded child/history
relations, then the camp. [The round record](README.md) carries the cleanup
limits; final removal read-back remains open.
