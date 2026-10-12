# OTO App delivery board - SCRUM-191

Updated 13 October 2026. Development and release are recorded separately.
Source on a published lane is available for review; it is not a staging
delivery. The newest STATUS block remains the live release record.

## Development batches

| Ticket / batch | Development delivered | Remaining development or release dependency |
| --- | --- | --- |
| SCRUM-193, rounds 1-6 | Landed; running on staging. Round-5 and round-6 module evidence is attached to SCRUM-191. | Preserve existing behavior and recorded owner questions. |
| SCRUM-516, finance | Transactional imports, finance ownership keys, serialized cash imports and park-bound Xero connections are built on `lane/s217b-r7`. Source: `afcb68b1`, `7e27a40b`, `01371e9d`, `8e56d054`, `59ba84ee`. | Consolidated release checks and staged ownership checks. A positive Xero sync needs a connected sandbox; the unconnected screen is evidenced. |
| SCRUM-516, administration and camps | Owned administration records, document writers, people placement and camp actions are built. Source: `f5d5e9f8`, `e5d721f0`. | Ship nullable document columns with the new writers in R7a; observe those writers before R7b makes ownership required. |
| SCRUM-516, payroll and permissions | Payroll parent/run/file ownership, atomic permission replacement and resolved park context are built. Source: `086bb4ae`, `78c91e85`, `e4b1e2f5`, `b1f1f48d`, `fae7ce1d`. | Release and repeat the recorded staged payroll/camp cases. Salary calculations and advance repayment remain in their existing fix-block work. |
| SCRUM-516, form labels | Owned form/version label reader, displayed-version saves and refreshed label cache are built. Source: `fa4a8e36`. | Staged save, reload and publication evidence after release. |
| SCRUM-193, round 8 | Restore rehearsal, input protections, CI integration and compiler ratchet tooling are built in [PR2](https://github.com/vickyydev/oto-platform/pull/2). Source: `0f017a3d`, `9deab023`, `0e8d9072`, `5670d497`, `7a01be11`; the ceiling is now 457. | Integrate after R7b; run the final eleven-migration restore in CI; reconcile acceptance and Decision 25. |
| SCRUM-194, original seven items | Original scope and current implementation are mapped in the [feature plan](../otoapp-features/PLAN.md). Import preview/results and direct manager history already have code; other requested workflows are incomplete. | Complete concrete feature batches using the original requirements and existing defaults. Resolve only behavior/provider choices that the documents do not answer. Keep each item's implementation and staging result separate. |
| SCRUM-518, employee import | [PR3](https://github.com/vickyydev/oto-platform/pull/3), `db51ee5c`: requested labels and every existing match are visible. Five focused controls and a real-page mocked-HTTP browser check passed. | Testing; consolidated release checks and staging proof. Matching, selection and row application remain unchanged. |
| SCRUM-517, Fix recipient preview | [PR4](https://github.com/vickyydev/oto-platform/pull/4), `6551f0e9`: staff names/count/empty state before Save; six focused handler/database controls passed. | R7 canonical `people.tenantId` integration and foreign-person control, final checks and staging proof. |
| SCRUM-519, SOP revisions | Locally built: prior-content history, versioned edit/restore and editor history/status controls. | Focused review, source checkpoint, final migration number, release gate and staging proof. |
| SCRUM-520, attendance evidence | Locally built: optional photo/document preview and issue-bound private storage in the existing request paths. | Focused review, source checkpoint, final migration number and release gate. Face-clock-disabled paths and existing manager-review limitations remain explicit. |
| SCRUM-521, presence delivery | In development for the staff in-app inbox, following the owner's Q3 answer. | Pending/Delivered/Failed state, reliable retry and replay, scoped reader, then focused review and release gate. |

## Development and verification sequence

The owner requested development-first delivery on 13 October: complete
approved feature batches and record their source before consolidating release
verification. Independent implementation runs in isolated lanes, with one
coordinator integrating and publishing.

Use focused checks while developing. Preserve the broad runs already in
progress and their results; do not restart them for documentation changes or
repeat passing suites without a relevant source change or unresolved result.
Run the required full gate once for each final release candidate, then recheck
only failures or changes that invalidate earlier results. Do not mark incomplete
or skipped checks as passing. The main/staging landing gate remains in force.

The current R7 candidate has a successful production build, a zero-diagnostic
API compiler, 457 inherited app diagnostics with no per-file/code increase,
and touched-file lint without errors. Its full API battery is not yet green.
Existing round-7 screenshots show the currently deployed source, not the new
ownership release. Exact test-record/object cleanup remains outstanding.

R7a, observed new document writers, R7b and R8 remain the release order.
Complete the existing SCRUM-191 scope; OPEN_ITEMS section 2 remains ahead of
any new story. SCRUM-223 stays paused.
