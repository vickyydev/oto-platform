# Timekeeping - 12 October 2026

**WORKS** for the checks below, observed on OTO App staging source
`633cae416ff7e4a1c253ec4904cdc22351cf7df1`.

The owned employee detail returned 200 with two raw events and zero face events. The tablet shows one paired session. Another park group’s employee-detail request returned 404. The restricted manager could read its selected practice branch (200) and was refused its other practice branch (403). These checks do not claim a full scheduled-shift calculation or a physical camera run.

Evidence inspected before attachment: [r5-timekeeping-tablet-20261012.png](../../jira-comments/attachments/SCRUM-191/r5-timekeeping-tablet-20261012.png).

Fixtures and cleanup are tracked in the [round index](README.md). Remaining
choices retain the app’s existing behavior; this page claims only these actions.
