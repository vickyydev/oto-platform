# CI Typecheck heap repair

The assigned independent reviewer approved the two-line Typecheck-step env change. The existing condition, pnpm command and all checks are unchanged. NODE_OPTIONS is not otherwise defined in the checked repository config. Installed Turbo2.10.12 forwards NODE_OPTIONS in strict mode as a built-in passthrough, confirmed against its tagged source: https://github.com/vercel/turborepo/blob/v2.10.12/crates/turborepo-env/src/lib.rs . The reviewer ran no heavy check.

Exact d25 API source reproduces the CI failure locally with a 2048MiB allowance: tsc exits134 at the heap ceiling, with no TypeScript diagnostic. With4096, the whole workspace command passes16/16 tasks:15 executed, one unchanged telemetry task cached. API and Inbox tasks executed. The earlier direct whole API and Inbox compiler outputs remain empty. No test, assertion, package or runtime behavior is relaxed.

Product source stays d25 and the five reviewed source/test fingerprints still match validation.json. This maintenance commit needs no product redeployment or repeat customer message. The original failed run remains failure; the maintenance full-SHA run is watched separately.
