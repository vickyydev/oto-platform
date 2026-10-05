# SCRUM-495 verification - 6 October 2026

**6 October 2026, SCRUM-495 Other payments verified:** Used payment methods may be archived after the prototype warning. Other has its own ledger classification and is supported through the till, box restart/replay, refunds and End of Day without a cash drawer action. Review added configured/enabled/matching-kind guards and refusal of cash-shaped Other payloads; already-recorded offline Other remains replayable after later disable. Forward migration0060 only expands the payment-method check; schema verification passes. Root checks: initial API77, follow-up API65 (including legacy pricing replay), POS114, shared24, box35, DB shape/migration18 pass; all five touched package typechecks, lint and POS build pass. API/POS905fe6c0 are live for History. Pricing screenshot11275 is attached; phone History review is being captured. SCRUM-495/493 remain In Progress. SCRUM-496 stock entries31-39 started independently; Add time0061 and stock0062 are allocated to their workflows. CI905fe6c0 is running; the superseded63d7307e run was cancelled after its known registry issue was repaired.

## Staging proof

01-staging-pricing-proof.png (11275): real signed-in till cart, no sale/payment created. THB1040 at 3 percent gives THB31 discount and THB1009 total after the platform quote. Refused test promo remains visible; document options are the three prototype values. POS session4adb82c7, API905fe6c0.

Fresh context with service workers blocked verifies current POS905fe6c0 phone History: Yesterday requests 2026-10-05 using the park business date; eight recorded sales appear, no horizontal overflow. Refund preview is on existing labelled QA sale T1-000059, no confirmation/payment mutation. A new controlled sale is still needed for actual Other/refund/corrected-order evidence.

## Remaining

Deploy migration0060/API before POS, then actual Other payment, archive warning, refund and corrected-order proof. Add time UI/backend not integrated yet; timer and partial refund choices are pending. Wallet/display parity is separate active work. SCRUM-496 stock workflow is independent. All parent work is still open.
