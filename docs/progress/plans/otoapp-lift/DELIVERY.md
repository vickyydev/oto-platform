# OTO App delivery board - SCRUM-191

**13 October 2026, integrated feature release checkpoint:** All 27 feature commits are rebased onto round-8 main 8aef1822641102548b20afa7684c0e0511c4e17b. Application, migration, tooling and workflow source is byte-identical to the pre-rebase 47085180 tree; only newer main documents differ. The SOP editor is reachable through Studio, with three focused controls passing. The final Attention writer inventory now follows the two extracted employee-action writers while preserving all eighteen ownership expectations; its isolated static pin passed seven assertions and touched lint has zero warnings/errors.

The preceding 142cc3dd candidate passed five of six jobs, including app build, restore/replay, 89 feature runtime checks, workspace compiler/lint/tests, 30 Console browser checks and two API shards. The remaining shard's sole failure was that file-location expectation, now corrected; no flake rerun or full-pass claim is made. The rebased final candidate needs its full hosted gate. R8 main is being watched separately; feature staging acceptance and one authorized SMS delivery remain. Local databases stay off.

**13 October 2026, feature screen entry checkpoint:** SOP history now has an active Studio route, navigation entry and landing card. The existing manager/administrator Studio access remains, with editing limited to administrators. Three focused route/access review controls pass; touched-file lint has zero errors and one inherited warning. This closes the source navigation finding; the screen still needs its staged journey after release.

The preceding combined candidate 142cc3dd passed its app build, restore/replay and all 89 feature runtime controls. Its whole app compiler output is 446 diagnostics across 59 files and 118 buckets, with no increased bucket against the 457 baseline. The workspace compiler, lint, tests and 30 Console browser checks passed; three API shards are still running, so a full candidate pass is not yet claimed. Main 4dcc6664 is separately completing its last API shard. The SOP entry is a later source change and will receive its own hosted gate. R7 exact cleanup preview passed for 60 tables, 261 rows and ten objects without mutation; cleanup remains pending while feature acceptance reuses the isolated practice park. Local databases remain off.

Updated 13 October 2026. Development and release are recorded separately.
R7a is landed at 7402a8da with all main CI jobs passing. Source on other
published lanes is available for review; it is not a staging delivery. The newest STATUS block remains the live release record.

## Development batches

**Latest integration:** all six new feature implementations are present in combined candidate da21a661, with employee-history and attendance-reviewer consistency. Final0011..0015 migrations are sequenced. Hosted feature runtime verification and staged acceptance remain; two presence display/retry controls are being completed. R7a is live and its camp/payroll/form rechecks pass. R8's hosted restore passed; the candidate gate awaits the historical current-chain assertion correction. The table below preserves individual source-batch references.

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
| SCRUM-517, Fix recipient preview | [PR4](https://github.com/vickyydev/oto-platform/pull/4), `3af75edd`: staff names/count/empty state before Save; seven focused handler/database controls passed, including R7 canonical person ownership. | Testing; final release checks and staging proof. |
| SCRUM-519, SOP revisions | [PR5](https://github.com/vickyydev/oto-platform/pull/5), `5924faac`: history, versioned edit/restore and status controls; 16 focused controls and all touched-file lint passed after R7 integration. | Testing; final migration number, release gate and staging proof. |
| SCRUM-520, attendance evidence | [PR6](https://github.com/vickyydev/oto-platform/pull/6), `9e79dacc`: optional preview and issue-bound private storage; nine controls, multipart and browser checks passed. | Testing; integration, final migration number and release gate. Face-clock-disabled paths and existing manager-review limitations remain explicit. |
| SCRUM-521, presence delivery | [PR7](https://github.com/vickyydev/oto-platform/pull/7), `7c911c02`: inbox delivery state and reliable retry; eight real-route/database controls passed. | Testing; integration, final migration number, release gate and staging proof. |
| SCRUM-522, returning-family SMS | Development underway; Twilio account/service validated read-only with six-digit codes and settings saved on staging. | Complete record-bound verification, focused controls and release. Runtime activation and one authorized controlled SMS proof remain; recipient comes from local environment. |
| SCRUM-194, review/movement history | Existing explicit manager actions and actor/time history meet normal original scope by source inspection. | Staged journey; bounded consistency controls under SCRUM-516, recorded in the feature plan. |

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
and touched-file lint without errors. The full Linux gate passed on equivalent
source 67eadb26; landing 7402a8da also passed every job in CI38294258814.
Existing round-7 screenshots show the currently deployed source, not the new
ownership release. Exact test-record/object cleanup remains outstanding.

R7a, observed new document writers, R7b and R8 remain the release order.
Complete the existing SCRUM-191 scope; OPEN_ITEMS section 2 remains ahead of
any new story. SCRUM-223 stays paused.
