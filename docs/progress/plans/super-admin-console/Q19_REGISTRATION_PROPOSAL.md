# SCRUM-637 Q19 ? held registration proposal

**UNAPPLIED. Planner approval is still pending.** Only this external patch and note are written. No repository files, tests, configuration, sessions, jobs or external destinations were changed or executed. Existing service19 GREEN was reported by the coordinator; this registration patch has not been compiled or tested.

The patch touches exactly `apps/api/src/env.ts`, `apps/api/src/services/jobs.ts`, and `.env.example`. It is based on the current frozen 637 files; recheck the base hashes before any application.

## Behavior proposed

- Strict typed boolean `CONSOLE_DIGEST_ENABLED`, default false. Optional `ALERT_WEBHOOK_URL` accepts only HTTPS without userinfo/fragment; blank is unset. Validation errors name the variable, never include its value. The example has only the false flag and empty destination.
- `NODE_ENV=test` clears inherited digest enablement/destination unless each is explicitly overridden, following the existing credential/model-job suppression pattern. Opted-in tests must still inject a fake sender; no real webhook is part of QA.
- `buildDefaultJobs` adds only `job:console.digest` when both flag and usable URL are configured. Constructing the sender performs no request. Existing jobs, order, interval, engine dependencies, and channels remain unchanged.
- The new job uses existing `ROLLUP_INTERVAL_S`, `exclusive:true` and the claimed `JobContext.now`; no new interval setting or calendar scheduler. `runConsoleDigest` owns native local-start eligibility, current-day catch-up, live owned branch scope, phase receipts and uncertainty holds. It is not exact-at-the-minute or exactly-once delivery.
- Each branch uses the real `overviewForScopeOf` with `includeOperatorWide:false` and the same `statusSummary` text. Registration explicitly supplies the runtime `PAYMENT_PENDING_MIN`, rather than relying on the internal reader's default.
- The private generic HTTPS adapter sends only JSON `{text}`; it promises no provider-specific format/support. Redirects are refused, the timeout includes body disposal, and only safe code/status/IDs/hashes are recorded. Destination and raw responses/errors are not logged or returned.
- A narrow optional `JobDeps.consoleDigestSender` supports capturing local tests. It cannot bypass the flag/destination gate, does not alter other callers, and no new HTTP route is added.

## Persistent expectation detail included for review

The existing runner creates persistent `ops_expectation` rows; omitting a formerly registered job does not remove or disable its row. The existing watchdog reads all enabled rows. Without a new-job-specific check, enabling and then disabling this optional digest would create false missing/failing alerts indefinitely.

Therefore the proposed patch adds an exact-name watchdog branch only for `job:console.digest` while disabled/unconfigured. It closes only that job's missing/failing conditions with the explicit reason `digest_disabled` (not "recovered") and skips new ones. It does not edit/delete historical expectations/runs, change enabled/muted decisions, suppress other jobs, or change any engine. The coordinator/planner should review this hunk together with conditional registration.

## Actual tests required after authorization, before application/release claims

1. Existing env/boot harness: omitted flag is false; explicit true/false are booleans; other spellings refuse. Empty destination is unset; malformed/non-HTTPS/userinfo/fragment values refuse with static messages. A test process cannot inherit an active real destination. Do not print the test or deployment URL in assertions/output.
2. Existing `ops-jobs.test.ts`: build all native jobs with default-off and enabled-but-unset config; assert digest absent, no injected sender call, all prior jobs unchanged. With explicit synthetic configuration plus capturing `JobDeps.consoleDigestSender`, assert exactly one typed digest definition, exclusive lock and existing rollup interval. Building definitions itself must make zero sends.
3. Execute only the extracted digest definition through the normal exclusive runner with fake delivery: select the real trusted scope; confirm actual decisions/summary honor non-default runtime `PAYMENT_PENDING_MIN`, include no global bucket and use exact Copy text. The existing19 digest tests remain unchanged.
4. Preserve all existing runner tests and prove two runner instances/forced Retry do not concurrently dispatch the same branch/day; default API-only process remains idle. Neither tests nor staging may use a real external webhook.
5. Seed a previously enabled digest expectation/old missing or failing alert, then disable/unconfigure: no new digest-missing/failing alert; old exact conditions resolve with the disabled reason. Unrelated overdue/failing jobs still alert and owner enabled/mute settings remain byte-for-byte unchanged.
6. Run API compiler with whole zero-diagnostic output, actual forced lint of every touched file, full existing jobs/boot suites and normal full release gates. No new migration or 638 setting dependency. Keep the flag false and destination unset on staging.

## Base and proposed byte bindings

- `apps/api/src/env.ts`: before `9028b5f0b3d14ba990bfb138319777130846dda339d7c882910045ede67559ca`, proposed `66dd272d181528ebb399d25da53f3c96ab89c0634819781cdd7cac90f74ab382`; +16 lines.
- `apps/api/src/services/jobs.ts`: before `010c65d2fe0b0e4216e164c6a417f3392697184d1474bb8b3e38e599d9e1ffd9`, proposed `7f78e0a844f92c2a1443da2d7931c4a87a97a01f647dca229c8f0d4a8e8cbdb0`; +35 lines.
- `.env.example`: before `e387f23a82e13d4d3168cbeb69abc521a104f9e3e760eadbc7518ec07e2a3f4c`, proposed `1d5751a89de768439085c3d70e1b0d1b6f8acfab04888b514db3b776d2cd14db`; +5 lines.

Patch SHA256: `a227dd9d9acfb756f4c53617755299c3c12f766f43454796e3bb33ffa911828a`.
