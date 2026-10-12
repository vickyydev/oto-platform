# In-app notifications - 12 October 2026

**WORKS** for the checks below, observed on OTO App staging source
`633cae416ff7e4a1c253ec4904cdc22351cf7df1`.

A labelled notification was prepared for the isolated practice user. Its own list returned 200. Mark read was clicked through the tablet panel, returned 200 and read back isRead:true. The other park’s list omitted this exact notification and its direct mark-read request returned 404. No seeded user’s notifications were marked read.

Evidence inspected before attachment: [r5-notification-read-tablet-20261012.png](../../jira-comments/attachments/SCRUM-191/r5-notification-read-tablet-20261012.png).

Fixtures and cleanup are tracked in the [round index](README.md). Remaining
choices retain the app’s existing behavior; this page claims only these actions.
