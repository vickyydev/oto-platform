# BEO PDF - staging walkthrough, 12 October 2026

**WORKS for the recorded private download.** On staging app `633cae41`, the
ZZ TEST event's BEO request returned 302 to a 300-second private object. The
object returned 200, 45,910 bytes and a `%PDF` header. Another park's request
returned 404; a signed-out request returned 401. A changed signature returned
403 and an unsigned object request returned 400.

The [event detail frame](../../jira-comments/attachments/SCRUM-191/r7-event-tablet-20261012.png)
is related screen context, not a capture of the PDF or its access checks.
Those results come from the observed requests in [the round record](README.md).
No private URL is recorded here. New round-7 source remains local.

Cleanup owed: the generated BEO object for event
`2d06f702-9406-42bf-b842-97c9cc75334a`, after its recorded content fingerprint
matches, followed by the event's exact record cleanup. No final removal
read-back has been recorded yet.
