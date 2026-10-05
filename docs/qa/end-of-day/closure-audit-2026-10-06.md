# End of Day closure audit — 6 October 2026

Read-only review of SCRUM-214 and SCRUM-215 against live Jira, the revised cash plan, source, tests and staging evidence. This note is not a deployment claim.

## Ticket relationship and governing rule

SCRUM-214 is the parent S2-15 story. Its two children are SCRUM-215 (S2-15a, End of Day, In Progress) and SCRUM-216 (S2-15b, analytics, To Do). SCRUM-214 says the work has "Two stories: the cash/EOD close, and the analytics summaries". Therefore completing SCRUM-215 does not complete SCRUM-214; SCRUM-216 remains a separate required child.

SCRUM-215 still says `cash_session` per drawer and asks to spot-check `cash_session.close`. The owner's 2 October ruling in SCRUM-488 comment 11483 says to "count all drawers together as one combined total" and otherwise follow the End of Day process already built. The revised `docs/progress/plans/cash/PLAN.md` explicitly withdraws drawer sessions. The implementation audits `end_of_day.close`; closure evidence must name that replacement and explain the superseded Jira wording, not claim that drawer sessions exist.

## Proven in source or staging

- API tests cover branch/day expected sums, float carry-over, ฿1 verdict, refund on original sale day, paid-out approval, safe-drop witness, close sign-off/audit, frozen close, second-close refusal, provisional/occupancy guards and receipt. Round-4 seed tests cover eleven deterministic sales with cash, QR, two non-null card TIDs, wallet credit and spend, voucher discount/redemption and a cash refund; they run concurrent and repeat seeding on an isolated date. The Health `demo.day` staging-only control has an ops API test, but is not deployed at this audit point.
- Settlement source/tests cover simulator batch evidence, reference-and-amount matching, `awaiting_settlement` approval without new payment, unmatched fixture rows, TID CSV, idempotency, audit and frozen EOD. Physical Digio/GHL settle commands return unsupported. The documented H/D fixture import is a guarded manual Console action; no scheduled SFTP import job is implemented.
- Jira SCRUM-215 comments and attached staging cards 01–04 show real signed-in paid-out, provisional/clock/occupancy refusal, close/override, duplicate-close refusal, Activity read-back and simulated receipt original/reprint. Comment 11550 names attached cards 05–07 (IDs 11268–11270): two simulated terminal batches matched, a newly recorded PAX pending payment approved, one TID export row, one matched and one unmatched H/D fixture line, replay, receipt auto-refresh and phone view. These are simulator/fixture proofs, not physical printer, terminal or production bank-file certification.

## Exact remaining closure evidence

1. Deploy the verified round-4 Health/seed source, check that the Health control is visible on staging, and attach a labelled test-run card for its safe/idempotent behavior. Avoid seeding the shared Central park solely for screenshots; use the existing disposable-database test evidence and an isolated ZZ TEST park for the final visible close flow.
2. In the isolated park, capture one combined cash count with paid-out approver and safe-drop witness, expected versus counted with a deliberate ฿50 off line, corrected count, locked close/receipt and second-close refusal. Existing screenshots show paid-out and zero-value close, but do not visibly prove safe drop or the nonzero ฿50 sequence.
3. Spot-check Activity for `end_of_day.close`, `cash_movement.paid_out`, `cash_movement.safe_drop` and `settlement.run`. The service-level audit tests exist; the prior staging card names close and gate/reprint audits, but does not visibly show all four actions.
4. Keep the historical seeded PAX `awaiting_settlement` row distinct from the new simulated sale in card 05. It predates simulator history, so a fresh terminal batch cannot contain it. If closing literally against that seeded row, use explicit matching fixture evidence; otherwise state the distinction and why the new PAX proof satisfies the behavior.
5. The plan/Jira includes a fixture "imported by a job" but current code has a manual guarded import. Production files are expressly excluded, and live comment 11550 labels fixture-only proof. Before closing, either implement the bounded fixture job or record an explicit accepted scope deviation; do not describe manual upload as scheduled SFTP import. The CSV criterion mentions approved card/QR rows, TID, approval and 2C2P invoice: card 05 reports one exported PAX row, while a separate QR/invoice CSV proof is not yet visible in the attached cards.

SCRUM-215 can move to Deployed only after the relevant staging screenshot/test card is attached and named in its comment, with the actual release verified. SCRUM-214 must remain In Progress while SCRUM-216 remains To Do.

## Follow-up after the audit

581c7c4a is live on API/POS/Console. The isolated QA park completed the safe-drop, paid-out and deliberate THB50/corrected close sequence. Health control visibility is captured; disposable tests cover the seed write path. The fixture-job gap is now implemented locally as a real on-demand operation with atomic import/audit/run records; 8 existing API checks pass. Deployment and named screenshots remain. CI schema parent mapping is repaired (14 checks); the separate worker timeout is not called green.

## Final staging export and cleanup

API dep-db21n8rtqb8s73bnum5g and POS dep-db21r0rtqb8s73bobim0 are live at 63d7307e. The real signed-in Download CSV control returned settlement-2026-10-05-all.csv, exactly three approved rows (PAX QR, NEXGO card, gateway QR with blank TID), matching the API response byte-for-byte. Reviewed screenshot 11-staging-all-payment-export.png is attachment 11274. Earlier single-TID exports remain one row each. The on-demand import job and cash/Health/Activity cards 11271-11273 close the remaining functional evidence gaps. CI37378514082 is pending, not green.

Revoked QA role assignment 01a10df8-dfdc-7d99-9b4b-06ba0c146448; disabled then archived QA box, archived its station and three devices, and archived ZZ TEST End of Day 1006. Simulator stopped. Closed financial rows, audit and override history were preserved. The physical park box and earlier unresolved payments were untouched.
