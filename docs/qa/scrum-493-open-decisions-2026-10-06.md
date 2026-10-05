# SCRUM-493 decision checkpoint - 6 October 2026

Existing SCRUM-497 questions keep their recorded prototype defaults until answered.

## Add time: partial-band identity (SCRUM-495 item 14)

Actual prototype source: components/history/AddTimeModal.tsx accepts a count,
duration and payment method. mockApi.ts recordExtension records those fields
against the sale; it never selects or changes specific band identities.
The options are 30 minutes / THB 60, 60 minutes / THB 100, and 120 minutes /
THB 180 per bracelet. These are source evidence, not newly chosen prices.

Question sent to the owner and commented on SCRUM-497: for a partial
extension, should staff scan/select the specific bands before payment,
or keep the prototype count/payment-only record? No inferred band choice
has been implemented. Continue independent mismatch work while waiting.

## Corrected orders: historical missing detail

Sale records have frozen components but no full cart snapshot. Rebuild
only exact recorded inputs; never convert supervised or prepaid lines to
ordinary lines when their identity cannot be recovered. The implementation
is inspecting real stay/entitlement relationships and will require explicit
re-entry where the original detail was never retained. This is a data
limitation to disclose, not permission to invent a different sale.

## Owner answer received

The owner answered: "GIVE AN OPTION FOR BOTH". Provide selected/scanned-band
extensions and a count-only payment/audit option. Count-only must clearly
state that unidentified band validity is not changed. Selected-band changes
need the existing signed-band/gate contract checked before implementation.
The answer is commented on SCRUM-495 and SCRUM-497.

## Add time follow-up questions

Two narrow questions are pending while independent work continues: whether selected-band extra play also extends the separate Drop-off/Nanny timer, and whether partial extension refunds are allowed while keeping all minutes or only a full refund cancels the extension. The prototype defines neither. Keep supervision separate; do not invent proportional minutes. These choices are not claimed as implemented or approved.

## Offline prepaid serving

Owner question sent 6 October: assign each child?s prepaid meals to one food-counter box for offline serving, or require internet for prepaid meals while keeping offline food/allergy details visible. Two independent cached meal counts cannot guarantee single use or concurrent pickup reconciliation. No exclusive allocation scheme is inferred.

## Cross-park wallet liability

Register30 requires global wallet spending with the spend recorded at the spending park. This is implemented in the isolated wallet and cache slices. Existing per-park wallet reports compare issuing-park wallet balances with spending-park ledger movements; those scopes diverge after cross-park use. Operator-wide totals remain coherent. A transfer/liability attribution policy is not inferred; reports must distinguish those scopes before claiming park-level reconciliation.
