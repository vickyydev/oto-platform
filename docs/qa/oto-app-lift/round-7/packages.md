# Event packages - staging walkthrough, 12 October 2026

**WORKS for the recorded package application.** On staging app `633cae41`,
the ZZ TEST package, its line and its application to the test event each
returned 201. Another park's package request returned 404. The observed
application used the app's existing package flow.

The [event detail frame](../../jira-comments/attachments/SCRUM-191/r7-event-tablet-20261012.png)
provides event context; no separate package-editor frame is recorded. The
request results are the evidence for package creation and application.
See [the round record](README.md) for the serving source and release limits.
New round-7 source has not been established as live by this walkthrough.

Cleanup owed: package `5f284a7a-f073-4d72-996f-0c5d970b0df4`, line
`d405e983-2efe-4df5-9a2d-45bf5dba6c93` and the event's recorded applied
package rows. Their exact removal and read-back remain outstanding.
