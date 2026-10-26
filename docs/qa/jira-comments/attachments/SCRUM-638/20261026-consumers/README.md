# SCRUM-638 protected-consumer integration checkpoint

The saved Console settings work is rebased onto main `0aff040b` and the planner's delivered consumer commit `be612ca0` is consumed unchanged at `92539d7e59a66c5a9da6404dc78176ceffde48f5`. Both earlier lane commits are retained. Released Platform routes, guard tests and navigation filters remain beside the settings additions.

The actual two-file counterfactual differs only in the three consumer source files: it reproduces three failures and 100 passes. The same tests pass all 103 cases with the delivered consumers (57 internal assistant, 46 Inbox). Invalid/foreign settings preserve native defaults. The four route guards pass 83 cases; the whole API compiler has zero diagnostics, eleven integration files pass eslint, and generated contracts match. All integrated gates bind the unchanged 3,789-input manifest `f60ba3191d70681ca72618297347e0507d31292407c7d84585c93712c3d27263`.

Each native test server is private, holds credentials only in process memory, starts and finishes with zero test databases, and is stopped. No shared Docker resource, staging data, real AI/provider, SMS or payment operation is used. Logs remain external with exact hashes in `external-artifacts.json`; JSON receipts and manifests are copied byte for byte.

This is focused integration evidence. Fresh combined whole-package/browser/release checks are next, and initial provider-list USD rates remain planner-supplied at combined landing. Migration 0087 remains provisional until landing. The assistant ask-pinning work belongs to the planner under SCRUM-640. No main landing, CI, Render rollout, staging screenshot or Deployed result is claimed.
