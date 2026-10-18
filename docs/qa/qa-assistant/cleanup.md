# Reporting assistant synthetic-example cleanup

18 October 2026, 19:36 Bangkok. The owner requested a clear QA intake for
Maria. Only the four synthetic acceptance reports listed below were selected.
The [acceptance record](acceptance.md) and implementation evidence remain
available as historical release proof.

| Jira example | Exact app report |
| --- | --- |
| SCRUM-554 | `19d9968e-7d86-4b86-a428-1c1ab1c96e95` |
| SCRUM-555 | `fc4e311e-ee3f-4da1-8a4e-855cc827ea63` |
| SCRUM-556 | `7c0fe4d0-5000-4eb1-89f8-6a7547716007` |
| SCRUM-557 | `295ac73a-67e5-4b02-bcee-2b0771807a33` |

Each Jira example had the ZZ TEST title, intake SCRUM-553 and its matching
report-identity label. The app rows had matching Jira keys, one seeded
reporter/park, completed revisions and no pending publication or processing
lease. There were no other saved reports at the initial census.

The app rows were removed first in a guarded transaction, before Jira
deletion, so no queued work for these examples remains. The three verified
child relationships cascade only to QA messages, attachments and analysis
attempts. No business tables were selected for deletion.

| Cleanup/read-back | Observed result |
| --- | --- |
| App reports | 4 removed |
| Saved messages | 14 removed |
| Attachment metadata | 2 rows removed |
| Analysis attempts | 7 removed |
| Separate staging database read-back | 0 target reports or child rows remain; no other reports present |
| Private synthetic files | 2 objects removed; exact key, size, content type and SHA-256 validated before deletion; both HEAD requests return 404 |
| Jira examples | Each DELETE returned 204; each direct issue read-back returned 404 |
| QA intake | SCRUM-553 remains In Progress, in sprint36, with no child reports at read-back |
| Implementation tickets | SCRUM-548 and549-552 remain Deployed with their existing evidence |
| Reporting service | App and worker observed live on `0e2e87eb45807194b952ecaa12a4f4d6581988ed`; reporting remains enabled on both |

Staging job receipts:

- Initial census: `job-dbabpt61egvs73a49g30`.
- Guarded app deletion: `job-dbabqavbtjjs73eigmk0`, completed at 12:35:59 UTC.
- File deletion and absence checks: `job-dbabqeu7bikc73e1hjrg`, completed at 12:36:36 UTC.
- Separate database absence check: `job-dbabqi3bc2fs73aq9rf0`, observed at 12:36:27 UTC.

The QA sprint and intake, earlier Maria reports under SCRUM-524, versioned
source indexes and implementation screenshots were preserved. No feature
source, migration, credentials or deployment configuration changed. This
cleanup creates no new test result or release claim; the existing release
gates remain the implementation proof. Maria can enter through the launcher,
open the OTO App and use Report issue.
