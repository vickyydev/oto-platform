# BEO approved feedback implementation notes

16 November 2026. Isolated lane: C:/oto-lanes/tom-beo-approved-20261116, base398478b5d6faba98bdc3586bacb77c8f58aa8af3. No main push, deployment or shared status write by this lane. Root owns Jira/release/evidence.

## Implemented source, verification in progress

- SCRUM-988: reuse broad delivered extraction. Saved structured review state and current prices are shown alongside proposed/source fields. Under the BEO write lock, an outdated version refuses the entire approval. Existing manual menu/bar/entertainment rows not named in the proposal are retained. Unknown shows remain unresolved Other requests, never price-zero free products.
- SCRUM-989: reusable BEO-only products stay branch/operator scoped and absent from general selling menus. Kitchen/Bar modify-item pickers include them, with station/category/selling-price display. New custom bar creation reuses the existing idempotent product route. Existing PARTY bar lines remain held/unbilled; only new typed chargeApproved provenance is billed. Provisional forward app0052 adds that boolean to the existing view; applied0050/0051 remain immutable.
- SCRUM-990: new persistent additional bills reference the same party and original main settlement. Existing party charges/payments link by FK. New extras join an open bill; payment closes it; a later extra creates a distinct bill. Targeted payments use their own bill balance, allow the final satang, reserve pending tenders and cannot switch bills on replay. No original sale/receipt/deposit mutation. Historical unassigned ledger remains separate.
- Newly approved BEO Add/Save and explicit till kitchen additions carry source-line/quantity/price provenance, durable pending status and idempotent reconciliation after the app write. Only positive quantity deltas beyond the current main-settlement baseline are billed. Engine gross is read by exact cartLineId/componentKey, including existing VAT/service. Decreases/repricing already billed source lines require a separate adjustment. Included/free additions remain plan-only.
- SCRUM-991: parent menu page shows sanitized saved BEO kids/adult/bar custom and extra item price/quantity snapshots, with unknown prices unresolved and included/free explicit. Catalogue-choice information is separate; no internal cost is returned. Confirmation records menu choices only, not agreement to extra charges.

## Schema and ownership

Platform provisional0127 creates party_additional_bill and adds nullable FKs on existing party_charge/party_payment. Deposit owns0126; Inbox owns0128. Platform snapshot chain must be regenerated after integration, preserving SQL equivalence. App0052 is a view-only replacement and schema-equivalent snapshot. Source spans API party billing/kitchen/settlement, shared party contracts, POS party UI, app BEO review/menu/save/public menu/directory kitchen blocks. No Inbox booking/draft gateway or usePaymentStage changes.

## Evidence so far

First app compiler found one introduced undefined-variable diagnostic (414/413); corrected. First API/POS compilers printed zero diagnostics, but source continued during early work, so they are diagnostic feedback, not frozen final gates. The first full four-file API run passed68/68, including the new exact-satang/overpayment/retry/source-delta/VAT7%+service10% controls; source was still being completed, so a frozen affected repeat remains. Full logs are external C:/oto-lanes/tom-beo-*.log and will be summarized with final hashes/results.

## Explicit limits and next work

No staging/native/provider/fiscal-receipt/physical-printer acceptance is claimed. Additional bills reuse the existing party payment ledger; this work does not build a new tax receipt or refund UI. Actual taken-status/reversal facts are read; unsupported additional-bill refund workflows are not claimed. Original retained-deposit/refund910 behavior must pass its existing files unchanged. Other945/966/968 holds remain held.

Finish regression-driven fixes; run full app ratchet, API/POS whole compiler scripts, touched lint, full relevant API/POS/app files and build. Produce explicit source commit list for root review. No work is ready for deployment until these final local gates are recorded.
