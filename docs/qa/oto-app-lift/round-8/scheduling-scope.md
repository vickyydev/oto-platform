# Scheduling park group acceptance

13 October 2026. SCRUM-523 under SCRUM-191.

## Release and hosted checks

Main `2850d89178232f421fbea18cbc4ea583cf3c1910` passed all six jobs in [run 38374525197](https://github.com/vickyydev/oto-platform/actions/runs/38374525197). API 4,033 passed; scheduling 32/32; feature runtime 89/89; Console browser 30. Workspace and API compiler output is clean. The app retains 442 diagnostics across 59 files and 118 buckets, without an increase; the existing 457 ceiling remains. Build and hosted restore/replay passed. No migration was added.

All six services were observed live on this exact source at 17:29 Bangkok. The app deployment was explicitly started after no automatic deployment was queued and completed at 16:37 Bangkok.

## Staging results

Two administrator sessions entered through the launcher. Isolated ZZ TEST branches contained no employees. Between 17:29:32 and 17:29:39 Bangkok:

- Each park created its own week, group and row. Park A saved and read its own template.
- Park A edited a row and read the saved label back, both HTTP 200.
- Eight other-park requests for week, groups, create, edit, replay, delete, template and template preview returned 404.
- Mixed-parent creation and mixed-row reordering returned 404.
- After every refusal, both owned week/group responses and the saved template matched their prior state.

![Inspected staging API test-run card](../../jira-comments/attachments/SCRUM-523/scheduling-boundary-staging-20261013.png)

This is authenticated API evidence. The isolated branch is not listed in the platform-backed branch selector, so no saved-row screen or UI-action proof is claimed. No staff assignment or payroll calculation was performed. Existing choices between branches in one park and shared role definitions remain the default.

## Exact temporary record cleanup

Pending the guarded preview and removal. Supported unlink returned 200 and cleared the platform account stamp. The existing app session still returned 200 while the app user remained active. Exact removal of this newly created app user and its one session, followed by a 401 readback, remains required. The existing access lifecycle follow-through belongs to SCRUM-288; it is not represented as a scheduling delivery or as immediate session revocation.
