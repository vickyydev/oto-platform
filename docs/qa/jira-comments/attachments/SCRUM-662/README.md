# SCRUM-662 watchdog evidence

The watchdog used a fallback zero when a supporting fleet read failed, allowing a real quarantine alert to close. The repair retains the failed/denied availability and skips fleet alert changes for that tick. Independent job checks and silent-box marking still run. All fleet conditions wait for the next readable tick; this conservative limit is deliberate. No route, schema, migration or provider wiring changed.

The private PostgreSQL review first reproduced three real failures: denied general quarantine, denied epoch quarantine, and an observed native lock reaching the existing deadline. The same six tests pass after repair, including readable recovery exactly once and independent checks. An earlier epoch-zero fixture violation is recorded separately and was corrected before the clean red baseline. Nearby tests: 129 passes across eight files.

The full original-base API run passed 5,774 cases across 407 files, with 401 inherited skips and five TODOs. All three shard receipts bind unchanged source/test hashes and their complete external logs. Independent review verifies the exact file union and test-owned process cleanup. Docker was not started. This full run predates the planner's Inbox landing and is not described as a full rerun on the newer base.

On the newer main, API typecheck has zero diagnostics, the six regressions pass, changed-file lint is empty, and generated API contracts match. The complete candidate CI is run on ae329681e4974ae3e47e3673d7930d701e52d35a (40712080315); its result and the final main/deploy/staging receipts must be appended before release acceptance. Subsequent rebases over documentation retain the identical source tree.

Staging proof will read the native Health page and bind a labelled regression card to the live source. It will not revoke staging permissions, lock tables, invoke the watchdog or alter a real alert: the watchdog can perform external effects before reaching this guard. Local native fault tests prove alert preservation; a staging Health screenshot proves deployment and current readability only.

Post-rebase validation: all 3,972 tracked non-doc files match candidate ae329681 exactly. API compiler, six native tests, lint and generated contracts passed again on bebeab5a after the parent documentation landing. The v2 independent review and cleanup receipts bind that comparison.

Candidate CI40712080315 completed successfully on ae329681e4974ae3e47e3673d7930d701e52d35a at 2026-10-28T15:25:15Z (last job), with all six jobs successful and no rerun. The terminal receipt is included. The eventual main commit additionally carries only documentation; its own exact-SHA CI and deployment are still required. Receipt hashes referring to external original files bind those retained originals; Git normalizes JSON text line endings in three cleanup receipts without changing their parsed contents.

The first post-deploy capture attempt returned native readiness and Health HTTP200, including an observed watchdog run after deployment, but captured no PNG: its response tracker admitted an older sign-in bootstrap body and failed to drain. It remains a failed helper attempt in SCRUM-662-staging-attempt1.json; sign-out200 and original-session401 were verified. The retry enrolls only requests dispatched for the fresh Health document. No product code or proof gate was weakened.

## Main and staging proof

Main adce7c4feac9f9989056e34ec42bc86f5c3da5a2 passed all six jobs in CI40716035735 and reached the bound API/Console deployments. Native Health generated 2026-10-28T15:57:29.012Z; observed state down, readiness ready. The three inspected screenshots are SCRUM-662-01-health-viewport.png, SCRUM-662-02-services-viewport.png, SCRUM-662-03-watchdog-regression.png. These are two explicitly partial native viewports and a labelled local-regression/staging-observation card. The original sign-in was revoked and its old cookie refused. No staging fault injection or manual watchdog invocation was performed.

The updated candidate's three native API summaries total 5,783 passes, 401 inherited skips, five TODOs and zero failures across 407 files, separately bound in s662-candidate-api-counts.json.
