# Independent source review: SCRUM-910 / scoped SCRUM-966

Candidate: `857535fd9baefced3e7118d3dd9f80f452992312`, reviewed read-only in `C:/oto-lanes/codex-deposit-910-20261114` on 14 November 2026. No source edits or test repeats were made by this reviewer.

## Verdict

APPROVED for the root's conditional delivery sequence. No unresolved HIGH or CRITICAL finding, and no demonstrated actionable source defect found in the reviewed candidate. This is an independently delegated source verdict; it does not claim root personally read every financial diff. Root authorized delivery only after this verdict, valid recorded gates, current migration/rebase checks and SCRUM-844 landing. Native staging acceptance and final full-SHA CI are still owed.

## Reviewed behavior and evidence

- `refunds.ts:200-225` checks operator, branch and manager approval before ordinary execution or action replay, locks the sale, and refuses action reuse for a different sale. The zero-money exception at 298-341 is confined to finalised party whole closure with a positive retainable allocation; ordinary zero/custom refunds remain refused. Deposit attempts are excluded from actual returned-money allocation at 391-394. Closure, numbered refund delta and cancellation of the original deposit allocation remain in the same transaction at 557-641.
- `party-deposit-balance.ts:28-139` binds historical deposit returns to the exact settlement deposit attempt, party and settlement payload, operator/branch and amount. Completed genuine deposit slices reduce availability; malformed, pending or failed deposit returns flag only the affected party. Retained allocations are separate from historical handbacks. Amount conservation and duplicate/over-return checks prevent a returned slice becoming fresh credit. The source intentionally does not describe an unresolved ordinary till refund as a new deposit return.
- `party-settlement.ts:703-819` scopes replay, takes the party lock, checks the live settlement, and rereads received/available deposit before creating the replacement allocation. Repeated or competing settlement/refund paths are pinned by the complete adversarial review. Existing tab/walk-up policy is unchanged.
- `party-tab.ts`, `parties.ts` and the POS adapters carry effective available credit while preserving the original editable received figure. The exact-party review fence leaves authenticated reads available and refuses affected money writes. Sale detail scopes the sale before the history lookup; the new helper queries only settlement IDs selected at the requested branch. No new cross-park data path was found.
- `analytics-rollup.ts`, shared analytics, Console money and `sale-printing.ts` keep released allocation distinct from actual returned money, reverse its revenue once and retain original receipt coverage. The Console integrity query binds cancellation to the original settlement allocation and numbered retention record instead of counting an arbitrary cancelled tender as cash.
- SCRUM-966's named extras use the deterministic add-ons cartLineId and exact componentKey, sum the engine gross (including allocated VAT/service), and strip internal correlation metadata from the public quote. Entered per-unit prices remain unchanged. Exclusive VAT/service and same-code/different-price integration cases exercise preview and commit. No pricing-engine or service-inclusive policy change was found.
- Migration 0125 is additive apart from replacing the refund amount check to admit a positive-retention whole zero return. It has a one-positive-release-per-sale index. No applied migration file changed. Independent JSON comparison confirms 0125 chains from 0124, only pos.refund differs, and unrelated snapshot sections are identical; there are no grant changes.

## Gate receipt verification

Read `review.md` and `validation.json`. Independently hashed every recorded source path and every recorded gate log: zero mismatches. API compiler log is exactly zero bytes. POS and Console logs each run all three compiler configurations. Complete-file summaries match 187 tests/14 API files, 57 tests/5 reader follow-up files and 9/9 final adversarial tests. Other recorded POS/Console/shared/build/lint/contract gates have matching log hashes and successful receipt statuses. These focused batches overlap and are not a full monorepo run. No new checks were rerun just for this review.

## Delivery limits and conditions

Before landing: SCRUM-844 must be on main; fetch/rebase, inspect the exact own commit list and fresh migration journal, renumber/regenerate only if needed and verify identical SQL; refresh gates for relevant drift. Then watch hosted CI by full SHA, deploy only named affected staging services and complete bounded native proof, inspected images, exact cleanup and Jira readback.

The recorded historical-data caveat remains: if an old app received-deposit field was manually reduced to a net amount after a handback, safe applicability requires exact read-only census/reconciliation; this candidate must not silently subtract twice or rewrite cash history. The ordinary newly recorded approved journey is covered. No production, real-money/message or physical-printer acceptance is implied, and only the owner moves Done.
