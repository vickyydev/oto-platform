# Fix recipient preview - SCRUM-517

## Staging evidence - 13 October 2026

**WORKS for the recorded preview and access cases.** The staging application ran `5b2f049fba750403fe60284bf2b8b4855eb934b4`.

The Fix department screen showed who would receive a report before saving the department choice. Selecting the seeded SalesBooth department displayed one member, Teststaff1. Selecting No department then displayed zero recipients.

| Observed case | Result |
| --- | --- |
| Preview the owned department | HTTP 200; the screen showed one recipient. |
| Select No department | The screen showed zero recipients. |
| Read settings before and after changing the selection | The saved setting was unchanged. |
| Preview another park's department | HTTP 404. |
| Preview as Som, authenticated as staff through the launcher | HTTP 403. |
| Preview without authentication | HTTP 401. |

This was a preview-only journey. Save was not pressed, no Fix report was submitted, and no notifications were sent. The result establishes recipient visibility before saving; it does not claim report delivery.

## Inspected staging images

- [Department recipient preview](../../jira-comments/attachments/SCRUM-517/fix-recipient-preview-staging-20261013.png) - the seeded department and its one recipient.
- [Empty recipient preview](../../jira-comments/attachments/SCRUM-517/fix-empty-preview-staging-20261013.png) - No department and zero recipients.

Both images were inspected before being named in this record.

## Remaining acceptance

The other feature acceptance journeys and final fixture cleanup remain tracked under the parent story. This record covers the named preview cases and does not close the parent story or establish unobserved routing and delivery behavior.
