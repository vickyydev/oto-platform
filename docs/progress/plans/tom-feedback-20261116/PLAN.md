# Birthday BEO and Inbox feedback implementation

## Approval and scope

The owner reviewed the interactive decision board and pasted the answers into chat on 16 November 2026. The later explicit ruling was: custom dishes can be reused across BEOs, and implementation of the reconciled scope, including point 3, is approved. This supersedes the form's review-only boilerplate and point 3 Pending state. The preserved answer record is `owner-decisions.json`. No additional approval is needed for this scope. Production rollout and unrelated historical holds are not included.

| Unit | Jira | Approved outcome | Current state |
| --- | --- | --- | --- |
| CI payment race | SCRUM-986 | An unsent payment choice survives completion of the same new sale write; recorded money remains authoritative | Deployed on both staging tills; owner acceptance pending |
| 1 Deposit before booking | SCRUM-987 | Gateway-confirmed full deposit before explicit staff booking creation | Deployed; staging proof and cleanup complete; owner review pending |
| 1.1 Complete reviewed fill | SCRUM-988 | Apply available structured chat details with sources, review and stale-save protection | Deployed; staging proof and cleanup complete; owner review pending |
| 2 Reusable BEO menu and sync | SCRUM-989 | Reusable BEO-only dishes in appropriate Kitchen/Bar choices across parties, without ordinary POS catalogue exposure | Deployed; staging proof and cleanup complete; owner review pending |
| 3 Party extras and bills | SCRUM-990 | Extras stay linked to the main party; post-settlement additions receive a new additional bill | Deployed; staging proof and cleanup complete; owner review pending |
| 4 Parent review and prices | SCRUM-991 | Saved menu choices and selling prices visible; parent confirms choices only | Deployed; staging proof and cleanup complete; owner review pending |
| 5 Inbox states | SCRUM-992 | Accessible OTO-themed unread and next-action emphasis | Deployed; staging proof and cleanup complete; owner review pending |
| 6 Inbox permissions | SCRUM-993 | Manage category and channel restrictions within existing Inbox permissions | Deployed; staging proof and cleanup complete; owner review pending |

The existing Inbox & BEO sprint is Jira sprint 69 (currently marked Future in Jira). Its state was not changed. The CI defect uses the existing platform sprint 3. Existing delivered tickets are dependencies, not reopened claims that their work never existed.

## Decisions in force

1. Create booking is blocked in both UI and API until the deposit is requested and the full required amount is verified received by the gateway. A slip, customer statement, AI interpretation or staff receipt checkbox cannot satisfy it. Use the existing configured or agreed amount and its current authorized editing controls; no new amount authority was provided.
2. A prebooking draft is not a calendar reservation. Payment enables staff creation but never creates a booking automatically. Check payment and applicable date/availability rules again at creation. Prevent duplicate bookings, charges, receipts and deposit transfers under concurrent/repeated requests. Preserve old bookings and the original retained-deposit refund ruling. Paid drafts that cannot be booked need staff resolution; no automatic refund policy is inferred.
3. Reuse the existing broad extraction. Structured menu, activities and entertainment changes must be reviewable and applicable, with current/proposed/source context. Preserve manual edits and reject stale application. Unknown items/prices remain unresolved; relevant unsupported requests remain visible for staff review. Chat-derived deposit data is informational.
4. Managers can create dishes for reuse across BEOs. Reuse the BEO-only catalogue foundation; do not make these ordinary POS selling products. Items created from the BEO backend appear in the appropriate Kitchen/Bar modify-item dropdown and relevant chat matching. Existing kitchen plan, actual order, payment and preparation states remain distinct.
5. Extra sales use an explicit party association and remain on the same main party record. Matching a customer's phone number is insufficient. After settlement, a new additional bill is linked to that party. The old receipt is immutable; its original balance is not reopened. This resolves SCRUM-966 point 6 only, not its other holds.
6. Show quantity, unit selling price, line total and explicit Included/Free states; an unknown price is not zero. Internal cost stays private and existing VAT/service behavior is unchanged. Parent confirmation means menu choices only. A staff draft never implies parent acceptance of new charges.
7. The Birthday/category clarification concerns displaying BEO-added menu items and the BEO sections/dropdowns, not introducing a new general POS category.
8. Unread is per viewer. Next-action states distinguish staff reply needed, AI replying, AI sent/waiting for customer, unsent shadow preview and handled. Queued or failed delivery is not a successful AI reply. Keep selection visible and contrast accessible within the OTO theme; preserve ordering/routing.
9. Add access management within existing Inbox permissions for categories and channels. Reuse role/action capabilities and intersect operator/branch/team boundaries. Assignment cannot bypass restrictions. Cover direct URLs, messages/media, search/counts and existing export/realtime/AI-context paths. Administrators retain management. No initial staff roster or grant changes were requested; do not remove existing access by inference.

## Remaining clarification and external proof dependencies

- Q1 RESOLVED, 16 November 2026: allow multiple birthday parties at the same park/date/start time. Staff checks capacity before creating the booking. Do not introduce full-day, duration or same-slot exclusivity; preserve actual date validity, permissions and the gateway deposit gate.
- Gateway credentials and real provider confirmation must be verified for live acceptance. Controlled/simulated gateway proofs cannot be reported as real bank payment acceptance. This does not block building the approved gate.
- No new manual amount-change permission is inferred from the repeated D1/D2 labels in the form. Existing authorized behavior remains the default.

## Execution and ownership

Root coordinates Jira, shared checkpoint files, integration, source review, service rollout and acceptance. Sol 6.1 performs routine implementation and checks. Worktrees are isolated and rebase onto current main before landing; only one heavy test/build process uses the local machine at a time.

- Payment repair: `C:/oto-lanes/codex-payment-choice-recovery-20261116`, SCRUM-986. Owns `usePaymentStage` and its regression tests.
- Deposit: `C:/oto-lanes/tom-deposit-gate-20261116`, SCRUM-987. Owns draft schema/service, booking gate, gateway settlement integration and BookDate UI. Provisional platform migration 0126 must be checked/renumbered at landing.
- BEO: `C:/oto-lanes/tom-beo-approved-20261116`, SCRUM-988 through 991. Owns reusable catalogue, structured BEO review, party extra billing and parent view. Coordinates directory contract blocks with deposit lane.
- Coordination: `C:/oto-lanes/tom-feedback-coordination-20261116` owns this plan, approved decisions, shared STATUS/handover updates and Jira receipts.
- Inbox state/access units start when a routine implementation slot is available. No broad reassignment of unrelated historical lanes.

First resolve the concrete payment race. Build deposit and BEO work in independent units, then integrate their shared contracts. Establish catalogue and billing integrity before dependent review/presentation changes. Inbox highlighting can land independently; permissions need full server boundary review before rollout. No production work.

## Verification and delivery

Each unit requires meaningful adversarial tests and applied fixes, whole serial test files (no `vitest -t`), complete relevant compiler output, touched-file lint and required package gates. Use embedded PostgreSQL; Docker remains off. Preserve original failures and exact source bindings. Standard repository browser tests are software verification; user-browser operations use the available browser tool.

Only reviewed, checked source lands through a normal non-force push. The current owner release direction keeps CI as a reported background check rather than a staging wait: deploy only the named affected staging services at the reviewed SHA and immediately verify them. Do not weaken tests or call a red run green. Record same-push Jira status/comments, staging evidence, actual coverage limits and exact fixture/session cleanup. Deployed requires inspected staging evidence attached; Done remains the owner's decision.

Main at approval: `398478b5d6faba98bdc3586bacb77c8f58aa8af3`. CI `43845560647` remains red after one failed-job retry: original database timeout did not repeat (465/465), then the partial-payment native click failed. Local reproduction now demonstrates an actual new-sale reconciliation race; SCRUM-986 tracks its repair. Earlier successful jobs do not certify the pending repair.

Stop after this approved feedback scope and report completed work, proof and any remaining limits for owner review. Do not resume unrelated sprints or historical held behavior automatically.
