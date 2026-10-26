# SCRUM-640 held collection path

Preparation only. No metadata endpoint, staging page, authentication, browser, SQL transaction or Render job has been executed by these collectors. All concrete future source, run and deployment IDs must come from the coordinator's final reviewed release. The tests use synthetic RAM-only data and transport functions; they are not staging evidence.

`admin640-staging-proof-release-collector.mjs` accepts one strict release-input object. It contains `approved:true`, ticket640, the final source/manifest/runtime/route/committed-local-release hashes, the executor/audit/pure-contract hashes, the release collector's own hash, the exact six-job CI run and the latest ordered API/Console deployments. The collector verifies local committed bytes before loading the original private credential helper. It checks the actual main push CI and unique latest live services before and after collection. Imports are inert.

The explicit public-only mode is:

```
node C:/w/admin640-staging-proof-release-collector.mjs --collect <reviewed-release-input.json> C:/w/admin640-staging-proof-assets-<fresh-attempt>.json
```

Only unauthenticated `/branches`, `/index.html`, the exact favicon and discovered same-origin `/assets/*` resources are fetched. HTML aliases must match. The closure reads real module/asset syntax through the installed TypeScript parser and records its actual path/version/hash. Computed business API templates and permission words are not treated as static assets; computed module imports and unresolved asset templates refuse collection. Public responses must be200 with exact URLs, no Set-Cookie, allowed MIME and at most8MB each/64MB total/2,999 referenced assets. The known Google stylesheet is not fetched. Raster images use a fresh cookie-free native Chromium context at1440×1000 and retain only the actual response SHA/MIME/byte length and safe request fingerprints. Context and browser closure are both attempted. Original HTML/JS/media bodies are never written. Exact byte hashes are retained; there is no PNG/WebP alternative-digest acceptance.

`admin640-staging-proof-metadata-collector.mjs` accepts a strict job input: `approved:true`, ticket640, the above release object, the metadata collector's own SHA, mode `preflight` or `audit`, and a new ticket-named output directory. Preflight has null `proofPlan`/`nativeReceipt`. Audit has the exact proof plan and original native result paths/SHA256s. All read-only jobs use the actual current API image, verify `RENDER_GIT_COMMIT`, and run bounded parameterized reads in one repeatable-read/read-only transaction. The preflight imports the native read-only `readAppBranchMapping` under the app's real `tsx` loader, on that same client/transaction; it does not invent another tenant-anchor rule.

```
node C:/w/admin640-staging-proof-metadata-collector.mjs --dispatch <reviewed-job-input.json>
node C:/w/admin640-staging-proof-metadata-collector.mjs --collect <same-job-input.json>
```

Dispatch persists/fsyncs an exclusive intent before its sole POST. An absent/invalid acknowledgement becomes a preserved uncertain dispatch and cannot be retried. Collection uses only the original acknowledged job ID/service/program; it returns promptly for pending work. Exact-source checks surround metadata acceptance. Only one anchored structurally valid result marker is accepted; command echoes, duplicate/malformed markers and potentially truncated logs are refused. Raw log responses remain in RAM and are recorded only by SHA. An observed actual terminal state remains terminal, with its real status, even when later log/source/disk checks fail. A failed result is never relabelled successful.

Preflight emits only known actor IDs, safe counts/fingerprints, live operator/branch/app-branch IDs, and own photo-file IDs. It neither creates aB operator nor guesses one. The actual existing candidates are returned in `targets`; the coordinator chooses one. The native same-assignment null-operator switch-permission join is copied literally, not inferred from a role name or a flattened union. Photo lookup follows `/me`'s latest account-owned file-object query. No contacts, credential/hash columns, employee name/pay data or private response bodies are emitted. The `IDENTITY_SQL` projection is exactly the one reused after cleanup by the audit job.

Raw preflight is held with `approved:false`. The coordinator inspects the result, chooses an actual returnedB UUID, then separately approves:

```
node C:/w/admin640-staging-proof-metadata-collector.mjs --approve-preflight <same-job-input.json> <actual-censused-B-UUID> C:/w/admin640-staging-proof-preflight-<fresh-name>.json
```

Approval binds the original input/result/helper hashes. It never changes `checkedAt`. The120-second limit includes collection, human review and the start of the native proof; an expired result refuses approval or execution. It must be refreshed with a new explicitly reviewed read-only attempt, not a fabricated timestamp or retry of an unknown job. The new approved preflight schema uses `accountEligible`, derived from an active account with an active home operator and no password change requirement. It does not claim the future session is unlocked. The existing actual post-sign-in `/me` handshake still requires `sessionLocked:false`. This narrow correction has actual offline RED1/1 before the field rename and GREEN coverage afterwards; the old42d572 helper remains preserved.

The audit collector uses the existing exact ten-minute account/session/time-bounded audit SQL. A tiny image-source guard wraps its unchanged program; receipts bind both the actual wrapper SHA and original reviewed audit-program SHA. Its original-job result must be explicitly reviewed through `approveAudit(...)` before the existing finalizer accepts it. This export produces the exact reviewed terminal envelope expected by the finalizer. It does not claim that a real job, tag pair, cleanup or native PNG exists now. All actual images still require human inspection before publication.

Offline calibration covers39 cases: the previous27 proof safety cases, the2 eligibility contracts and10 collector checks, including actual extracted dispatch/collection branches with lost acknowledgement, disk failure, malformed logs and source failure. Imports/validators/parser construction only were executed. Real released-schema import, Render API shapes, compiled-job loader/imports/SQL privileges, deployment metadata, public image representation and native pixels remain unexecuted and require independent review plus the final concrete plan. No protected or tracked source, shared resource or repository state was changed.
