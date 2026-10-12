# Camps - staging walkthrough, 12 October 2026

**BROKEN for the recorded owned check-in; creation and history WORKS.**
On staging app `633cae41`, the ZZ TEST camp and child registration each saved
with 201. The owning park's history returned 200; another park's history
returned 404. Check-in for the owned nondefault-park registration returned
404. That path is assigned to SCRUM-516 and still needs its staging recheck.

Evidence: [camp screen at 820 x 1180](../../jira-comments/attachments/SCRUM-191/r7-camp-tablet-20261012.png),
already inspected. The frame establishes the camp state, not successful
check-in. [The round record](README.md) names the serving source; the local
round-7 consistency delivery is not established as deployed here.

Cleanup owed: camp `44a30b06-df05-45d7-9693-d86294078829`, registration
`be4d4e3f-d85a-48e8-b7dc-9d1547202030` and their exact child/history relations.
Final removal read-back remains outstanding.
