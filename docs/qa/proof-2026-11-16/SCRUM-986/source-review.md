# SCRUM-986 payment choice recovery review

Reviewed source candidate: `211a5adee4965b4f48e3aaa00f6a363222dfd98a`.
Integrated product-equivalent commit: `25e8dafa4` (approval documentation is the other difference from main).

## Finding and prescribed fix

High: a new sale id can arrive after staff selects Cash or enters a partial amount. The sale-recovery read confirms there are no attempts, then clears the method and partial form. The corresponding native control disappears. A deferred write/read regression reproduced two failures before the repair.

Preserve the earlier unsent form only for a fresh sale id, ready phase, no earlier attempt or settlement, unchanged confirmed balance and a still-enabled method. Do not carry the form across orders, changed balances, recorded or unresolved payments, or disabled methods.

## Review outcome

No actionable source finding remains in the two-file candidate. The review traced the no-attempt branch, recorded-payment branches, current-context guard, form locking and the seven behavior regressions. Existing recovery still rejects unconfirmed records and resolves actual money first. The new logic neither submits a payment nor finalises a sale.

The integrated source and test blobs are unchanged from the tested candidate. All nine recorded validation-log hashes were independently matched. The full POS compiler output was read: all three compiler configurations passed with no diagnostics. Touched-file lint produced zero bytes.

Complete POS suite: 275 files and 3,920 tests passed. Seven final regression cases passed after test-only type annotations; 11 existing API review pins passed. The earlier interrupted suite and initial test-only typing failures are retained, not called successful runs. Product logic did not change after the complete POS suite.

## Remaining release proof

The original failing complete native spec passed on the repaired source: one case in 13.3 seconds with the built Chromium/embedded PostgreSQL harness, exit zero, database removed. Its earlier pass on the original source is not repair acceptance. Exact main CI and named staging deployment results must be recorded separately. No live staging or final acceptance claim is made in this source review.
