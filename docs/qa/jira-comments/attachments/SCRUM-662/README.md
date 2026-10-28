# SCRUM-662 watchdog evidence

The watchdog used a fallback zero when a supporting fleet read failed, allowing a real quarantine alert to close. The repair retains the failed/denied availability and skips fleet alert changes for that tick. Independent job checks and silent-box marking still run. All fleet conditions wait for the next readable tick; this conservative limit is deliberate. No route, schema, migration or provider wiring changed.

The private PostgreSQL review first reproduced three real failures: denied general quarantine, denied epoch quarantine, and an observed native lock reaching the existing deadline. The same six tests pass after repair, including readable recovery exactly once and independent checks. An earlier epoch-zero fixture violation is recorded separately and was corrected before the clean red baseline. Nearby tests: 129 passes across eight files.

The full original-base API run passed 5,774 cases across 407 files, with 401 inherited skips and five TODOs. All three shard receipts bind unchanged source/test hashes and their complete external logs. Independent review verifies the exact file union and test-owned process cleanup. Docker was not started. This full run predates the planner's Inbox landing and is not described as a full rerun on the newer base.

On the newer main, API typecheck has zero diagnostics, the six regressions pass, changed-file lint is empty, and generated API contracts match. The complete candidate CI is run on ae329681e4974ae3e47e3673d7930d701e52d35a (40712080315); its result and the final main/deploy/staging receipts must be appended before release acceptance. Subsequent rebases over documentation retain the identical source tree.

Staging proof will read the native Health page and bind a labelled regression card to the live source. It will not revoke staging permissions, lock tables, invoke the watchdog or alter a real alert: the watchdog can perform external effects before reaching this guard. Local native fault tests prove alert preservation; a staging Health screenshot proves deployment and current readability only.

Post-rebase validation: all 3,972 tracked non-doc files match candidate ae329681 exactly. API compiler, six native tests, lint and generated contracts passed again on bebeab5a after the parent documentation landing. The v2 independent review and cleanup receipts bind that comparison.
