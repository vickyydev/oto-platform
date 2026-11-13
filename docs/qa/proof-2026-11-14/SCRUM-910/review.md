# Review: retained party deposits and named settlement extras

This local candidate implements the owner's 13 November ruling for SCRUM-910. A full settlement cancellation returns only till-paid money and releases the original deposit allocation back to the same party. It does not create a new deposit receipt, return a deposit slice or spend returned money again. SCRUM-966 point 2 shows named extras at their exact priced component gross, preserving entered/catalogue unit prices and existing pricing rules.

## Financial invariants

For a fully paid sale, original gross equals till-paid money plus its applied deposit. After whole closure, the same gross equals actual till refunds plus genuine historical deposit returns plus the retained allocation release. Only actual refunds enter refundedSatang and cash/provider slices. Retained release is a separate immutable numeric delta on the numbered refund document and a net-revenue reversal, never a second payment or cash refund.

The new provisional platform migration 0125 adds the retained amount, a nonnegative/zero-whole constraint, and one retained-release document per sale. No applied migration is edited. Every non-pos.refund object in the new snapshot matches 0124 structurally.

The historical balance reader binds each deposit to its settlement's exact depositAttemptId, validates its original party/settlement metadata and refund allocations, and subtracts only completed genuine deposit handbacks from the app's recorded received figure. Pending, failed, over-returned or malformed history flags only that party for review. Authenticated party/History reads remain available; affected money writes are refused. Retained releases never subtract from party availability again.

Whole/items/custom refunds share the actual till-money ceiling. Partial refunds leave the deposit allocated until whole closure. Zero returned money is allowed only for a verified finalised party's explicit whole closure with an available allocation to retain; ordinary zero refunds remain refused. Existing manager approval, sale lock, action replay and transaction boundaries apply unchanged. Replacement settlements recompute credit after the party lock and retain the one-live-settlement constraint.

History list/detail honor closed ledger status even when actual returned money is below gross or zero. Received deposit remains the original editable figure; optional availableDeposit is used for bills and staff/customer payment displays. A partial legacy handback shows only its retained remainder as staying with the party. Console money shows retention separately from actual returned money. Its integrity reader recognizes exact released original allocation coverage without counting it as cash. Receipt copies preserve the original paid deposit allocation instead of omitting a now-canceled allocation.

For SCRUM-966, internal cartLineId plus componentKey binds each named descriptor to its engine contribution. No label/code guessing, proportional allocation or service-inclusive feature/configuration change is introduced.

## Adversarial results and meaningful checks

| Check | Result |
|---|---|
| Original refund service against new complete review | 5 real assertion failures; 4 controls passed |
| Original966 quote against complete party file | 2 VAT/service contribution failures; 40 controls passed |
| Original Console integrity reader against new review | 1 false-underpayment failure; 8 controls passed |
| Original print snapshot reader against new review | 2 original-tender omission failures; 7 controls passed |
| Fixed broad API batch | 187 tests in 14 complete files passed |
| Fixed final printing/integrity batch | 57 tests in 5 complete files passed |
| Final full910 review with stronger rollback assertions | 9/9 passed |
| POS History/party/payment/display batch | 347 tests in 15 complete files passed |
| Console money markup | 8/8 passed |
| Shared refund/analytics arithmetic | 18 tests in 2 complete files passed |
| Compiler output |API zero bytes; all 3 POS and all 3 Console configurations passed |
| Other gates |Touched authored TS/TSX lint, both production builds and generated-contract check passed |

These are overlapping focused batches, not additive unique counts or a fresh full monorepo run. Validation/source hashes and original log hashes are in validation.json. Independent readback found zero live owned Postgres servers among the exact recorded test server PIDs (local-cleanup.json). Docker stayed off. No staging fixture, session, real money, real message or physical hardware was used.

The review exercises 14,900 baht returned with 2,000 retained on a 16,900 sale; partial then whole; deposit-only zero return; genuine old 500 baht deposit handback leaving 1,500 credit; entirely returned old deposit leaving no credit; repeated and competing resettlements; action/idempotency replay; branch/manager authority; full rollback of sale/refund/deposit allocation; readable scoped review holds; actual net revenue; integrity and original receipt preservation. Exclusive VAT with 0/10 percent service, quantities, same code/different entered prices, ordinary add-ons/entertainment/included lines are covered in SCRUM-966.

## Preserved failed attempts

The first contracts wrapper stopped on the existing Fastify deprecation warning under PowerShell ErrorAction=Stop. Its warning and output are retained; the rerun captured native warnings and returned 0. Console types initially found one old markup fixture missing the new retained amount; it now explicitly supplies 0 with a separate retention render case. A strict API check found a test lookup of an optional receipt tender list; the safe optional lookup preserves the positive amount assertion. The 3072 MB compiler attempt exhausted its heap; unchanged source passed with 4096 MB after a stronger 10 GB commit-headroom gate. No test assertion, compiler scope, timeout or lint rule was weakened. Build warnings are the existing mixed static/dynamic import and large chunk warnings; they were read, not suppressed.

## Remaining before release

Root review of this concrete candidate is required. Do not land it before SCRUM-844. Fetch/rebase onto then-current origin/main, inspect the own commit list, renumber/regenerate the provisional migration only if needed and prove its SQL unchanged, and refresh affected gates on any source drift. Current source has no hosted full-SHA CI or staging acceptance.

After approved landing, watch exact-SHA CI and named API/till/Console deployments; run the bounded native proof in README.md, inspect images, publish/attach/name them and read back Jira. Census actual old deposit-return records read-only before claiming applicability: an app deposit already manually reduced to a net value may need exact-record reconciliation rather than another subtraction. Never rewrite historical cash rows or infer an owner's choice. No new policy ruling is needed for the ordinary approved journey. SCRUM-966 remains open for its other partitions/owner-held points. Only the owner moves Done. Stop after the whole approved stage 3 for owner review.
