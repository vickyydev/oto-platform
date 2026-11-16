# SCRUM-992 Inbox unread and next action

Base: `10e73db6c446226e60ae5e8979236ac6d5b351b1`. This unit changes list presentation and adds a server-derived next-action field; it does not change routing, ordering, the unanswered filter or the per-viewer read-marker calculation. No migration or staff grant change.

The list keeps unread, selection and next action separate. Queued AI output is replying, confirmed sent/delivered/read AI output waits for the customer, failed/withdrawn output needs staff, a pending shadow turn is preparing an unsent preview, and only a stored shadow message is called a preview. A handled conversation can still be unread for this viewer. Current pause, erasure, staff action, manual assignment and handover holds prevent stale pending work from looking active. The hold floor follows the existing assistant eligibility episode/Resume rule.

The optional wire field permits staged service rollout; the new server always supplies it. The client fallback uses the previous staff-unanswered facts and never invents an AI delivery state. API reads project only outbound author/status metadata and pending-turn facts, never additional message bodies.

Source review caught and corrected two draft findings: pending shadow work must not claim a preview exists, and stale pending AI must not outrank a person or pause. The real-SQL review file includes those boundaries, newer inbound after a successful reply and a failed line after an earlier sent line.

Completed local proof:

- Shared delivery-state file: 13/13.
- Actual list markup and installed OTO palette contrast: 12/12; every next-action/unread text meets 4.5:1 and selection ring meets 3:1 in both themes.
- Whole Inbox suite: 465/465 across 28 files. Its first run retained one historical dark-palette assertion; the assertion now pins the approved selection/staff-needed palette, and the complete replay passes.
- Whole real-PostgreSQL API review: 10/10, including stale pending work, human/pause holds and failed delivery after an earlier sent line.
- Whole API compiler: zero output; shared and both Inbox compiler configurations: zero diagnostics.
- Inbox production build passed. Final authored-file lint: zero output.

The first API compiler run found one test-only typing mismatch: the established database-only shadow status uses the same explicit cast as the existing shadow writer. The correction does not change test inputs or product behavior; the whole compiler replay passes. Original failed and successful receipts remain local. All owned test/database/build processes ended and the heavy slot returned to the BEO lane.

Pending: root's final independent source review, fresh-main integration, exact-source background CI and named staging proof. This source is not deployed and has no staging acceptance claim. Root owns integration, independent review, Jira and shared checkpoint documents.

Local receipts: `C:/oto-lanes/inbox-992-all-tests-final.log`, `inbox-992-api-review.log`, `inbox-992-api-types-final.log`, `inbox-992-shared-types.log`, `inbox-992-inbox-types.log`, `inbox-992-build.log`, `inbox-992-lint-final.log` in the same local directory. The review file is `apps/api/test/inbox-next-action-992-review.test.ts`.

## Live verification

Reviewed product ea7212974dfdb8c2062cf34b2448859939ec406d is live on the API and Inbox. See runtime-proof.json for exact deployment IDs, served asset hash, real API response state counts and session cleanup. Both staging screenshots were inspected. Browser capture opened no conversation and attempted no write. Theme class changes were local rendering checks, not saved account preferences. The screenshots demonstrate actual waiting/customer and AI-sent rows; other states, personal unread and selection boundaries retain the local test coverage recorded above. No native interaction with a real customer thread or new message was performed.
