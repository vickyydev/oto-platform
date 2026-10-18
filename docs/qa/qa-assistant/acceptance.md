# Reporting assistant acceptance - SCRUM-548

18 October 2026. **Not deployed. All staging acceptance remains pending.**
This records the reported local release checks and the live evidence still
required by the [implementation plan](../../progress/plans/qa-assistant/PLAN.md).
It establishes no new staging result or final acceptance.

## Source and release gate

| Record | Observed state |
| --- | --- |
| Candidate source | `315a6fd2c86e1d1717a37035306b55ae3d1d3e4a` |
| Candidate review | [PR 11](https://github.com/vickyydev/oto-platform/pull/11) |
| Hosted CI | [Run 39115175218](https://github.com/vickyydev/oto-platform/actions/runs/39115175218), in progress at preparation; complete candidate gate passed, all six jobs green |
| Final main release SHA and its CI | Pending landing and exact-SHA gate |
| Observed Render app SHA/deployment | Pending live read-back |
| Observed Render worker SHA/deployment | Pending live read-back |
| Applied app migration `0016` | Pending staging read-back |
| Worker source snapshot/version | Pending deployed app/worker version match |

## Recorded local checks

The source checkpoint reports these completed results; this document did not
rerun them. Mocked controls do not establish a live model response, Jira
publication or staging access result.

| Check | Recorded result |
| --- | --- |
| Browser controls | 9 passed with mocked services |
| Independent source/analysis boundaries | 11 passed locally |
| Worker controls | 11 passed with mocked services |
| House review wrapper | 36 pins passed in the hosted app gate; exact log review is being recorded |
| Whole app compiler | 430 diagnostics across 57 files and 114 file/code buckets; unchanged from the current baseline |
| API compiler | 0 output bytes |
| Production builds | App and worker builds passed; worker bundle and private source index produced |

The complete candidate gate passed in run39115175218. The main release gate and live staging acceptance remain pending. The hosted database checks, rather than the local mocks, establish the17 backend controls.

## Actual staging journeys

| Journey | Result/evidence |
| --- | --- |
| Enter from the launcher; open Report an issue with its source page recorded | Pending |
| Submit a ZZ TEST text report; reopen saved conversation and history | Pending |
| Paste/upload a synthetic screenshot and attach a short synthetic video | Pending |
| Add a follow-up and observe an answer for the latest saved revision | Pending |
| Receive an actual Claude response with honest code/evidence references and missing-evidence wording | Pending |
| Observe report/Jira recording when analysis is unavailable, then recover on the same report | Pending |
| Repeat a submission/processing request and verify the report and Jira identity | Pending |
| Request a code or data change; observe the reporting-only explanation and unchanged product records | Pending |
| Observe worker boot, leased processing and the source version used for the report | Pending |

## Private access

Owned conversation, message and attachment reads are pending positive proof.
The following refusals also remain pending, including direct evidence reads:

- A different reporter in the same park.
- A reporter in another park.
- A signed-out request.

Record actual responses and unchanged owned read-backs. Keep session values,
private evidence URLs and model/provider credentials out of this record.

## Jira placement and evidence

Implementation belongs to SCRUM-548 and children 549-552 in Sprint 2. New QA
reports belong to **OTO App - QA and Bug Triage**, sprint **36**, under
**SCRUM-553**. Earlier Maria reports remain under SCRUM-524.

Actual created report keys, their parent/sprint read-back, complete report
text, accepted attachments and later follow-up comments are **pending**.
The source checkpoint alone does not establish this publishing journey.

No staging screenshot or labelled test-run card has been recorded here yet.
Save real evidence under
`docs/qa/jira-comments/attachments/SCRUM-548/`, inspect each image, and record
its exact filename and Jira attachment when available. Deployed status awaits
that live proof; the owner reserves Done for final acceptance.

## Limits and cleanup

- Video review samples the first 40 seconds visually. Audio is not
  transcribed; the explanation belongs in chat. Actual upload/analysis proof
  remains pending.
- The versioned index contains code; decision documents are not included.
  Code citations alone do not establish an owner policy decision. Any answer
  relying on unavailable decision context must state that limit.
- Ambiguous Jira publication recovery remains unproven on staging. If the
  create response is uncertain, reconcile the saved report and Jira identity
  before claiming a successful retry or exactly one issue.
- All staged records and media must be synthetic and use ZZ TEST names.
  Exact fixture/object cleanup and final absence read-backs remain pending;
  no staging cleanup is claimed in this preparation.
