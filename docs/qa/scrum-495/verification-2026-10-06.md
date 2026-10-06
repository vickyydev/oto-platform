# SCRUM-495 verification - 6 October 2026

**6 October 2026, SCRUM-495 Other payments verified:** Used payment methods may be archived after the prototype warning. Other has its own ledger classification and is supported through the till, box restart/replay, refunds and End of Day without a cash drawer action. Review added configured/enabled/matching-kind guards and refusal of cash-shaped Other payloads; already-recorded offline Other remains replayable after later disable. Forward migration 0060 only expands the payment-method check; schema verification passes. Root checks: initial API 77, follow-up API 65 (including legacy pricing replay), POS 114, shared 24, box 35, DB shape/migration 18 pass; all five touched package typechecks, lint and POS build pass. API/POS 905fe6c0 are live for History. Pricing screenshot 11275 is attached; phone History review is being captured. SCRUM-495/493 remain In Progress. SCRUM-496 stock entries 31-39 started independently; Add time 0061 and stock 0062 are allocated to their workflows. CI 905fe6c0 is running; the superseded 63d7307e run was cancelled after its known registry issue was repaired.

## Staging proof

01-staging-pricing-proof.png (11275): real signed-in till cart, no sale/payment created. THB 1040 at 3 percent gives THB 31 discount and THB 1009 total after the platform quote. Refused test promo remains visible; document options are the three prototype values. POS session 4adb82c7, API 905fe6c0.

Fresh context with service workers blocked verifies current POS 905fe6c0 phone History: Yesterday requests 2026-10-05 using the park business date; eight recorded sales appear, no horizontal overflow. Refund preview is on existing labelled QA sale T1-000059, no confirmation/payment mutation. A new controlled sale is still needed for actual Other/refund/corrected-order evidence.

## Remaining

Deploy migration 0060/API before POS, then actual Other payment, archive warning, refund and corrected-order proof. Add time UI/backend not integrated yet; timer and partial refund choices are pending. Wallet/display parity is separate active work. SCRUM-496 stock workflow is independent. All parent work is still open.

## Add time integration review checkpoint

**6 October 2026, Add time integration checkpoint (not deployed):** Both selected/scanned-band and count-only modes are integrated with separate charges, unfinished-payment recovery and forward migration 0061. Root checks pass: API 180, POS 120, DB shape 14, API/POS/DB typechecks, scoped lint, POS build and migration verification. Focused review reproduced a late offline band-replacement case that strands a partially paid extension; the correction and its regression coverage have since landed on the feature branch (commit 64741ea9). This checkpoint is on the feature branch only. API/POS 8c21b5e8 are live for Other payments. Real phone History screenshot 11276 is attached to SCRUM-495; no refund was submitted in that preview. A labelled staging Other method zztest_495_other_1006 was created for controlled proof and must be archived afterward. Stock 0062 and booking 22-28 slices are verified in isolated workflows; wallet/display and offline wallet-cache slices await integration. SCRUM-493/495/496 stay In Progress; SCRUM-498 work is starting and SCRUM-215 still awaits CI. No new green CI claim.

02-staging-phone-history.png (11276) is a reviewed real staging refund preview. Actual new-sale Other/refund/correction proof remains. Temporary method: zztest_495_other_1006. In-progress browser cart: one adult 1 Hour Play THB 350, not yet paid.

## Other payment executed

03-staging-other-payment.png: API/POS 8c21b5e8, recorded sale 01a10e3a-db73-7f0b-a358-f32f707a0158, receipt T1-000063, THB 350, one adult 1 Hour Play. One approved Other attempt, tendered/change null. No source refund yet: use for Add time proof first. Band identifiers masked.

**6 October 2026, wallet/display integration verified:** Global operator wallet lookup and spending, Card as the credit remainder default, the three-column selector and shop payment layout are integrated. Offline cache/replay accepts same-operator wallets across parks while retaining the spending park cap/day and refusing a moved-box stale snapshot. Root verification: API wallet 26 plus replay 3, POS 14, box 10, four package typechecks, scoped lint and POS build pass. Reports explain movement-location versus issuing-wallet live balance; inter-park liability policy is recorded as an open decision. Real staging Other sale T1-000063 (THB 350) is finalised with one approved Other attempt and no cash tender/change values; screenshot 03 is reviewed. This remains a feature-branch checkpoint until the Add time replacement recovery is integrated. Main/staging stay 8c21b5e8. Stock 0062 and booking 22-28 await integration; supervised booking and offline food safety are active workflows.

Other-payment evidence attached as 11277.

## Fix round after review (lane A)

Migration 0061 gives both new tables created_at and updated_at and indexes `sale_extension.created_by_account_id`; it is still chained to 0060 and not applied anywhere. Add time follows the approved History after a part refund of the admission: it stays available while the admission is finalised and its bracelets are active, and ends only with a whole refund. `packages/db/test/migration-0061.test.ts` and a new case in `apps/api/test/sales.test.ts` cover both.
