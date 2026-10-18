# Reporting assistant acceptance - SCRUM-548

18 October 2026. **The final reporting release is observed live, with desktop
and mobile entry, real model replies, private evidence and Jira delivery
checked. SCRUM-548 and all four delivery subtasks are Deployed with attached,
inspected evidence.** This records the completed checks and limits against the
[implementation plan](../../progress/plans/qa-assistant/PLAN.md). It does not
establish final owner acceptance or reproduction of a reported product issue.

## Source and release gate

| Record | Observed state |
| --- | --- |
| Candidate source | `315a6fd2c86e1d1717a37035306b55ae3d1d3e4a` |
| Candidate review | [PR 11](https://github.com/vickyydev/oto-platform/pull/11) |
| Candidate CI | [Run 39115175218](https://github.com/vickyydev/oto-platform/actions/runs/39115175218), complete; all six jobs green |
| Initial main release SHA | `b358aaf7986745c309a211fde923bdfc5c7c1135` |
| Main CI | [Run 39116331856](https://github.com/vickyydev/oto-platform/actions/runs/39116331856), complete; all six jobs green |
| Current live app | `0e2e87eb45807194b952ecaa12a4f4d6581988ed`, deployment `dep-dbaah8142hec73ddabdg` |
| Current live worker | `0e2e87eb45807194b952ecaa12a4f4d6581988ed`, deployment `dep-dbaah8142hec73ddac10` |
| Source snapshot probes | Both jobs succeeded: app `job-dbaaj8brjlhs739hohe0`, worker `job-dbaaj8jrjlhs739hoil0`; 520 files, identical private-index digest and both matching the private stored snapshot |
| Applied app migration `0016` | Confirmed before restricted-role setup, with the migration hash guard |
| Report source/version | SCRUM-554 and SCRUM-555 retain source `b358aaf7986745c309a211fde923bdfc5c7c1135`; SCRUM-556 retains `c0422d18fb9297f882de3d9c1b5c07f1b9e27f38`, including its final-worker follow-up; SCRUM-557 records `0e2e87eb45807194b952ecaa12a4f4d6581988ed` |
| Desktop/mobile entry release | Source `c0422d18fb9297f882de3d9c1b5c07f1b9e27f38`; [run 39120053840](https://github.com/vickyydev/oto-platform/actions/runs/39120053840) complete, all six jobs green; deployed and normal-click entry observed on desktop and mobile |
| Final guidance release gate | Source `0e2e87eb45807194b952ecaa12a4f4d6581988ed`; [run 39121598434](https://github.com/vickyydev/oto-platform/actions/runs/39121598434) completed its app-scoped gate: 36 QA, 89 feature and 32 scheduling controls, with the unchanged 430/57/114 compiler baseline. Eleven worker controls, build and lint also passed locally |

The initial app and worker deployment read-back was recorded at 17:39 Bangkok on
18 October. Restricted worker setup job `job-dba9hjbrjlhs739e5bq0` succeeded:
four QA tables, one sequence, connection limit two, zero business-table write
grants and zero unexpected readable relations. Worker configuration was
verified and the temporary setup secret was removed. No credential value is
recorded here. Final app and worker deployments were read back live at
18:12 Bangkok; the source probes subsequently confirmed their private snapshots.

## Recorded release checks

The local source checkpoint and the completed full main gate at `c0422d18`
record these results. The final `0e2e87eb` gate is app-scoped; it does not
establish a fresh API suite run. Mocked controls do not establish a live model response, Jira
publication or staging access result. Skipped and todo cases are excluded
from passed counts.

| Check | Recorded result |
| --- | --- |
| Browser controls | 9 passed with mocked services |
| Independent source/analysis boundaries | 11 passed locally |
| Worker controls | 11 passed with mocked services |
| House review wrapper | 36 pins passed in the hosted main app gate; 0 skipped |
| Whole app compiler | 430 diagnostics across 57 files and 114 file/code buckets; exact baseline match and whole output identical to the reviewed candidate |
| API compiler | 0 output bytes |
| Production builds | App and worker builds passed; worker bundle and private source index produced |
| Main API suites | 4,078 passed; 400 skipped and 5 todo; 285 passing files and 8 skipped files |
| Main POS suites | 1,413 passed across 97 files |
| Main Console suites | 125 unit checks passed across 11 files, with 3 todo; 30 browser checks passed |
| Main print suites | 271 passed across 11 files |
| Other main workspace suites | Telemetry 36, payments2c2p 81, API types 8, shared 671 and database 240 passed |
| Existing app journeys | 89 feature controls and 32 scheduling controls passed in main CI |
| Restore/replay | Main artifact identical to the green candidate's artifact |

The complete candidate and exact-SHA main gates passed. The hosted database
checks establish the backend controls separately from the local mocks.
The live results below include the initial `b358aaf7` release, `c0422d18`
entry follow-up and final `0e2e87eb` guidance release.

## Actual staging journeys

| Journey | Result/evidence |
| --- | --- |
| Launcher entry and report source context | Observed; saved path and server version match. At 1440-pixel desktop width the saved context excludes the query string |
| Desktop/mobile entry | Normal clicks opened the final release above navigation on both layouts; the mobile panel fits the viewport |
| Text report, saved conversation and history reload | Observed; SCRUM-556 and the final-release SCRUM-557 were saved, and the original conversation reloads |
| Screenshot paste and short-video upload | Both synthetic files saved privately; owned downloaded bytes match their fixture hashes |
| Follow-up and real analysis | Follow-up saved and an actual Claude response retained on the same report; recorded source SHA matches `b358aaf7` |
| Incomplete report | Saved and published as SCRUM-555; the response asks for missing details |
| Assessment wording | SCRUM-554 and SCRUM-555 completed with `needs_investigation`; SCRUM-556 and SCRUM-557 completed with `guidance`. Source references are visible. These responses do not establish semantic certainty or runtime reproduction |
| Queue and worker startup | A saved report waited before worker startup and was subsequently processed; app/worker version and report source match |
| Submission and message replay | The saved report/message identity is retained; altered replay text returns 409. Jira search finds one issue per report |
| Cross-release replay | Repeating the initial create after deployment retained its original report and `b358aaf7` source context |
| Attachment replay | Identical upload replay returned 201; altered content returned 409; another reporter received 404, and retained evidence bytes were unchanged |
| Cross-origin write | Refused on staging |
| Reporting-only request boundary | The actual response explains the reporting-only boundary; no business fixtures were created or modified for acceptance |
| Provider/Jira outage and ambiguous-create recovery | Covered by hosted controls only; no such outage was injected on staging |

The final worker's actual Claude replies acknowledge that the host has saved
the report, both for fresh SCRUM-557 and a follow-up to SCRUM-556. The latter
retains its original `c0422d18` source context after the worker release.

## Private access

Owned conversation/history reads succeeded, and the two private evidence
downloads matched their fixture bytes. Another signed-in reporter received
404 for report detail, a direct attachment and a follow-up write. Signed-out
report and attachment reads returned 401. The private source index was not
served as a public JSON response.

Cross-park access controls passed in the hosted tests. No active other-park
app identity was used for this staging acceptance, so a live cross-park
refusal is not claimed. Session values, private evidence URLs and provider
credentials are excluded from this record.

## Jira placement and evidence

Implementation belongs to SCRUM-548 and children 549-552 in Sprint 2. New QA
reports belong to **OTO App - QA and Bug Triage**, sprint **36**, under
**SCRUM-553**. Earlier Maria reports remain under SCRUM-524.

| Actual report | Parent / effective sprint | State | Evidence and comments |
| --- | --- | --- | --- |
| SCRUM-554 | SCRUM-553 / 36 | To Do | Synthetic PNG and MP4 attached; five comments |
| SCRUM-555 | SCRUM-553 / 36 | To Do | Incomplete report, no media; one comment |
| SCRUM-556 | SCRUM-553 / 36 | To Do | Guidance report, no media; three comments |
| SCRUM-557 | SCRUM-553 / 36 | To Do | Final-release guidance report, no media; one comment |

Jira read-back confirms all four destinations, source SHA and visible source
references. Exact report-identity searches found one issue for each report.
Follow-up publication stays on the original issue. These reports remain
records for later review; this acceptance does not move them into development.

Inspected staging evidence is attached to SCRUM-549 as attachment **11574**,
`private-reports-staging-20261018.png`, and SCRUM-550 as attachment **11575**,
`report-entry-staging-20261018.png`. All five delivery tickets, SCRUM-548 and
SCRUM-549 through SCRUM-552, are **Deployed** after final attachment/status
read-back. The owner reserves Done for final acceptance.

All final PNGs were visually inspected before attachment. Final Jira read-back
confirms the named files:

- SCRUM-548: `qa-entry-staging-20261018.png`,
  `qa-conversation-staging-20261018.png`, `qa-mobile-staging-20261018.png` and
  `qa-delivery-staging-20261018.png`.
- SCRUM-550: `qa-conversation-staging-20261018.png`, alongside its earlier
  attached `report-entry-staging-20261018.png`.
- SCRUM-551: `qa-analysis-jira-staging-20261018.png`.
- SCRUM-552: `release-staging-20261018.png`.

Each file is under `docs/qa/jira-comments/attachments/<ticket>/`.

## Limits and cleanup

- Video review samples the first 40 seconds visually. Audio is not
  transcribed; the explanation belongs in chat. The accepted synthetic short
  video establishes its upload and processing, not audio comprehension or
  complete review of a longer recording.
- The versioned index contains code; decision documents are not included.
  Code citations alone do not establish an owner policy decision. Any answer
  relying on unavailable decision context must state that limit.
- Provider/Jira outages and ambiguous Jira-create recovery have hosted proof
  only. They were not injected on staging; the observed deduplication checks
  do not establish recovery from a lost create response.
- The four ZZ TEST reports and their synthetic media are intentionally
  retained as acceptance examples. No business fixtures were created or
  modified, and no report/media deletion is claimed.


Final attachment receipts: SCRUM-548: 11576-11579; SCRUM-549: 11574; SCRUM-550: 11575/11580; SCRUM-551: 11581; SCRUM-552: 11582. The SCRUM-551 card is shared parent SCRUM-548 acceptance evidence, stored under the worker ticket. The entry image establishes launcher placement; it is not evidence for Today data loading. The conversation images show SCRUM-557 and the saved confirmation. Final status read-back confirms Deployed for all five delivery tickets; none was moved to Done.
