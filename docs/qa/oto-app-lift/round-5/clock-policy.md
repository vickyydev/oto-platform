# Face, PIN and phone clock policy - 12 October 2026

**WORKS** for the checks below, observed on OTO App staging source
`633cae416ff7e4a1c253ec4904cdc22351cf7df1`.

The paired device accepted the fixture’s PIN IN and verified-phone OUT (200 each). No device returned 401; a forged photo receipt returned 400. The generated PNG is test evidence, not a physical camera capture. Face identification answered matched:false both before and after the isolated fixture was marked enrolled; face clock returned 403 with face_off. The recorded events contain PIN and PHONE_FALLBACK, never FACE.

Evidence inspected before attachment: [r5-attendance-access-20261012-card.png](../../jira-comments/attachments/SCRUM-191/r5-attendance-access-20261012-card.png).

Fixtures and cleanup are tracked in the [round index](README.md). Remaining
choices retain the app’s existing behavior; this page claims only these actions.
