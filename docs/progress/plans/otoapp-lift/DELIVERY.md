# OTO App delivery board - SCRUM-191

**13 October 2026, 17:43 Bangkok, story complete:** SCRUM-191 and all twelve child tickets are Done. Eleven linked lift items remain Deployed with images. All six services were observed live on main `2850d89178232f421fbea18cbc4ea583cf3c1910`; the app deployment completed at 16:37 Bangkok. All six main jobs passed in [run 38374525197](https://github.com/vickyydev/oto-platform/actions/runs/38374525197): 4,033 API tests, 32 scheduling controls, 89 feature runtime controls and 30 Console browser checks, plus build and genuine hosted restore/replay. Whole workspace/API compiler output is clean. The app remains at 442 diagnostics across 59 files and 118 file/code buckets, with the 457 ceiling retained. App migrations remain through `0015`.

[Scheduling acceptance](../../../qa/oto-app-lift/round-8/scheduling-scope.md) records own saves/edits and all ten foreign/mixed/replay refusals with unchanged readbacks. The inspected labelled API card is attached to SCRUM-523 and SCRUM-191. Exact cleanup `job-db70ka4s728c73d239u0` removed 13 temporary records and one app session, confirmed absence and preserved the existing park and seeded platform identity. The former session returns 401 after cleanup. Supported unlink alone had retained that active app session; SCRUM-288 now records this additional access-lifecycle case. This cleanup is separate from the earlier 297 content rows, ten files, seven parents and two sessions.

No owner answer is pending for this story. Recorded feature limits remain: face mode off, no positive Xero sandbox exchange, repeated import Apply unproven, no deleted-SOP recovery, staff-inbox delivery only, saved-family API save after UI verification, and existing employee approval rules. The owner decision document is separate from story acceptance. Next is OPEN_ITEMS section 2, beginning with SCRUM-276. Local databases remain off; SCRUM-223 stays paused.

**13 October, 15:39 Bangkok status check:** Eleven child tickets are Deployed with evidence. SCRUM-523 is Testing and is the final active child under SCRUM-191. Its corrected scheduling candidate is in the hosted release gate; source landing, staging proof and exact fixture cleanup remain. The owner has prioritized completing this story before returning to SCRUM-276 and the remaining fix block. No owner answer is pending.

## Current delivery - 13 October 2026

All seven original SCRUM-194 features remain live on the current main source recorded above. They were first observed on `5b2f049fba750403fe60284bf2b8b4855eb934b4` at 04:33 Bangkok on 13 October. App migrations through `0015` are applied: `0011` SOP history, `0012` attendance evidence, `0013` inbox delivery, `0014` family verification and `0015` employee actions.

SCRUM-191 and its twelve child tickets are Done with their recorded proof and limits. The eleven linked lift items remain Deployed. The newest STATUS block is the live release record.

| Ticket / scope | Verified delivery | Remaining limits or acceptance |
| --- | --- | --- |
| SCRUM-193, lift rounds 1-8 | Source is landed and live. Module walkthroughs, platform action/read cases, restore/replay, main release gate and current scheduled-job recovery are recorded. | Done with final proof attached. Preserve the named module limits and recorded owner decisions. |
| SCRUM-516, consistency work | Finance, administration, camps, payroll ownership, permissions, form labels, employee actions/history and attendance-reviewer controls are landed and live. The consolidated gate and the recorded staged journeys passed. | Done with final inspected consistency and cleanup proof. Positive Xero sync still needs a connected sandbox; attendance's face-enabled staging path remains unavailable under Q9. Salary calculations and advance repayment remain in their existing fix-block work. |
| SCRUM-194, original seven items | **Done.** All seven original items are implemented and their observed staging cases are recorded in the [feature plan](../otoapp-features/PLAN.md) and linked evidence below. | These bounded results retain the named limits; the separate recorded fix-block items follow this completed story. |
| SCRUM-518, employee import | **Done.** [Preview, selected-row Apply and re-preview](../../../qa/oto-app-lift/round-8/feature-import.md) showed the expected New, Changed, Unchanged, Invalid and Matched outcomes. | The re-preview proves resulting classification; repeated Apply idempotency was not established. Existing matching and selection behavior remain. |
| SCRUM-517, Fix recipient preview | **Done.** [Recipient preview evidence](../../../qa/oto-app-lift/round-8/feature-fix-preview.md) records the staff list/count, empty state and access boundaries before Save. | Preview does not send a notification or establish supplier-message delivery. |
| SCRUM-519, SOP history | **Done.** [Versioned edit, history, archive and restore](../../../qa/oto-app-lift/round-8/feature-sop-history.md) record replay handling, original content restored with the current archived status and branch scope preserved, and other-park/staff refusals. | Restoration follows current editing permission and publication choices; deleted-row recovery is outside this feature. |
| SCRUM-520, attendance evidence | **Done.** Optional attachment input, private issue-bound storage and manager reader are live. [Evidence](../../../qa/oto-app-lift/round-8/feature-attendance-evidence.md) records face-off refusals, reviewer reads and inspected hosted-control proof. | Q9 remains unchanged: face mode is off. A successful face-enabled staging upload, its private attachment read and approval were not observed. The reviewer screen had no Pending Approvals; no Approve action was performed. |
| SCRUM-521, inbox delivery | **Done.** [Delivery and recovery evidence](../../../qa/oto-app-lift/round-8/feature-inbox-delivery.md) records the current inbox delivery states and retry controls. | Delivery means the existing staff inbox. It does not establish SMS, email or push delivery. |
| SCRUM-522, returning-family SMS | **Done.** [Actual SMS receipt, screen verification/prefill and saved-registration API controls](../../../qa/oto-app-lift/round-8/feature-family-verification.md) passed, including consumed-grant and other-park boundaries. | The saved-registration write used the API after real screen verification; the normal screen Submit action was not exercised. Existing signature/consent fields were retained, with no new consent or signature claimed. |
| SCRUM-194 / SCRUM-516, review and movement history | [Explicit manager Complete, terms Save and transfer](../../../qa/oto-app-lift/round-8/feature-employee-history.md) passed on the disposable employee, with replay and ownership controls. Reload retained the saved changes; actor/time were present in the API. | Existing immediate actions and contract prompts remain. No additional approval stage or contract generation was exercised; the history screen itself does not display the actor. |
| SCRUM-523, scheduling scope (Q39) | **Done.** Full main gate and 32 scheduling controls passed; all six services are live. | [Staging proof and exact cleanup](../../../qa/oto-app-lift/round-8/scheduling-scope.md) complete. Existing within-park branch behavior remains unchanged. |

## Release and job evidence

The earlier feature-release SHA `5b2f049fba750403fe60284bf2b8b4855eb934b4` passed all six CI jobs in run `38309414401`, matching the green candidate `5aa3a826990d7456f9c4b08ba89a571f726dcf7d`. The gate included 4,033 passing API tests, app build and restore/replay, 89 feature runtime controls, the eighteen-writer ownership inventory, workspace lint/tests and 30 Console browser checks. Whole workspace compiler output has zero diagnostics, including the API. That feature gate measured 446 diagnostics across 59 files and 118 file/code buckets, with no increased bucket against the unchanged 457 ceiling.

[Current job recovery](../../../qa/oto-app-lift/round-8/jobs-recovery.md) is complete for the recorded cases. Four sequential authenticated Console API retries returned HTTP 200 with `outcome: ok` and fresh Health reads. Independent database read-back confirmed all five app jobs' latest outcomes and success times, with zero unkeyed park groups. Attention and presence ran; midnight and reconcile recognized work already completed for today's Bangkok date. The earlier forced presence failure and successful Retry, plus Attention recovery, remain separately evidenced. No current Retry UI button click is claimed.

## Cleanup and recorded limits

Exact cleanup removed 297 rows and ten objects, followed by seven parent rows and two app sessions. The supported account unlink returned HTTP 200; after the exact user/session cleanup, the former app session's `/api/user` read returned HTTP 401. The seeded platform account, employee, operator, branch and administrator assignment were preserved.

Protected-row fingerprints matched immediately before and after cleanup. A later Som fingerprint differed, with its cause still unattributed; the cleanup comparison does not establish that his whole row remains unchanged afterward. Preserve this distinction in the final acceptance record.

SCRUM-191 and its twelve children are Done. The remaining OPEN_ITEMS section 2 fix block starts with SCRUM-276 before any new story. SCRUM-223 stays paused and local databases stay off.

## Historical source checkpoints

The following references record the development batches that were integrated into the live release. They are source history, not pending release dependencies.

| Batch | Historical source reference |
| --- | --- |
| Round 7 finance | `afcb68b1`, `7e27a40b`, `01371e9d`, `8e56d054`, `59ba84ee` |
| Administration and camps | `f5d5e9f8`, `e5d721f0` |
| Payroll and permissions | `086bb4ae`, `78c91e85`, `e4b1e2f5`, `b1f1f48d`, `fae7ce1d` |
| Form labels | `fa4a8e36` |
| Round 8 tooling | [PR2](https://github.com/vickyydev/oto-platform/pull/2): `0f017a3d`, `9deab023`, `0e8d9072`, `5670d497`, `7a01be11` |
| Import preview/results | [PR3](https://github.com/vickyydev/oto-platform/pull/3): `db51ee5c` |
| Fix recipient preview | [PR4](https://github.com/vickyydev/oto-platform/pull/4): `3af75edd` |
| SOP revisions | [PR5](https://github.com/vickyydev/oto-platform/pull/5): `5924faac` |
| Attendance evidence | [PR6](https://github.com/vickyydev/oto-platform/pull/6): `9e79dacc` |
| Inbox delivery | [PR7](https://github.com/vickyydev/oto-platform/pull/7): `7c911c02` |

## Development and verification sequence

Independent approved implementation can proceed in isolated lanes, with one coordinator integrating and publishing. Use focused checks during development; preserve completed broad-run results. Documentation-only updates do not require restarting passing suites. Each final source release still passes the full landing gate, with further checks directed at source changes or unresolved results. Record incomplete and skipped checks accurately, and retain staging limits beside each delivery claim.
