# SCRUM-640 combined workspace checks

All five local batches pass on the same 3,809 source inputs, manifest6640afe780d69234f365dd583d25bddef3ca586f0b5c87ab3530c9f7cc7e4506. Source checkpoint025c9929 and later docs-onlyee05af58 have identical source bytes. This is partial release coverage, not a combined API or staging pass.

- Database:336 cases across46files; shared:775 across51files. Native schema matches0088; main's0087 is unchanged.
- Workspace:all16 package typecheck tasks and five frontend builds, forced and serial. Whole output was read; zero compiler diagnostics. Existing bundle-size/dynamic-import warnings remain.
- Ten remaining package suites:1,311 passes (telemetry36,api-types10,admin-screens120,messaging78,payments81,assistant434,print271,Inbox176,Booth33,launcher72).
- Box:native package script with test-concurrency1,749passes/zero skipped or TODO.
- Generated API contracts match; lint covers108 changed TS/TSX paths with zero errors and one existing ignored-generated-file warning.

Each batch uses its own native PostgreSQL, whole unpiped commands under Git Bash set-eo-pipefail and a frozen source/install manifest before and after every command. All five servers end with zero test databases and are stopped. No staging, provider, message, payment or shared-container action runs.

The single complete source manifest is stored under db-shared; all batches bind its same hash. index.json records original and archived hashes; text line endings are normalized to repository LF before hashing. Original terminal receipts and sanitized logs are preserved. Separate Console286/363 checks, App/API/POS evidence and planner Q23 closures must be considered separately. No local-release binder or Deployed claim is made here.

The prepublication whitespace check flagged native log spacing. Archive display text now also removes trailing spaces and excess blank EOF lines; the index records every normalized archived hash beside the unchanged original raw hash. No test result, diagnostic or source byte changed.
