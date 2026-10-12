# Organisation chart - staging walkthrough, 12 October 2026

**WORKS for the recorded vacancy and park-group boundary.** Before opening the
chart on [the recorded staging source](README.md), read-only checks found zero
employees in the isolated practice park and its budget read returned 200. The
chart's write-on-read therefore had no missing employee nodes to create there.

That park's administrator created one ZZ TEST live vacancy (201). Its chart read
returned 200 and exactly one node. The default park group's attempt to rename
that node returned 404; its title remained unchanged. The actual 820 x 1180 chart
showed one vacancy and the fixture's 100-baht expected salary.

Evidence: [actual practice-park chart](../../jira-comments/attachments/SCRUM-191/r6-org-chart-20261012-tablet.png),
inspected. The long vacancy title truncates within its card, while its branch and
controls remain readable. The exact vacancy was physically removed in
[the cleanup](README.md#cleanup-read-back).

No default-park nodes were opened or regenerated. This vacancy case does not
establish a reporting-line edit or concurrent employee-node creation; Q52 retains
the app's concurrent-read behavior and its standing review pin.
