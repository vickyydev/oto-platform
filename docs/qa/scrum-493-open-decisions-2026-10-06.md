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
