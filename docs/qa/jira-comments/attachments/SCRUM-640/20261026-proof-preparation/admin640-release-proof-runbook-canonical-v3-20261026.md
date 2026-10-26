# SCRUM-640 release proof runbook — 26 October 2026

Preparation only. No command below was executed for this runbook. The coordinator supplies and reviews every final source, CI, deployment and output path. Planner Q23 delivery `d3c1c520` must first be integrated and its actual release checks completed; delivery alone is not a release result.

This runbook uses only the versioned helper set in `C:/w/admin640-staging-proof-canonical-v3/`. Original flat `C:/w/` helpers and the first runbook remain immutable history.

## 1. Bind the final release before authentication

Use the final committed source in `C:/w/admin-operator-switch`. Require the complete local release, the exact full-SHA main push CI with all six jobs successful, and the latest automatic **API then Console** deployment rows both live at that source. Preserve superseded red results and their separate closures. Do not substitute a documentation push or the old partial validation checkpoint.

The strict release-input JSON has exactly these keys:

```text
approved, ticket, sourceSha, ciRunId, deployments,
sourceManifestSha256, runtimeBindingsSha256, routeSha256,
localRelease, helperSha256, auditHelperSha256, contractSha256,
collectorSha256
```

`approved:true`, `ticket:"SCRUM-640"`. `deployments` is ordered `[oto-api-staging, oto-console-staging]`; each row has exactly `{name,serviceId,id,finishedAt,sourceSha}`. Use the actual full feature SHA and final observed IDs/times, never placeholders or an older source.

`localRelease:{path,sha256}` refers to the **committed** SCRUM-640 JSON under `docs/qa/jira-comments/attachments/SCRUM-640/`; it must contain `ticket:"SCRUM-640"`, `localReleaseGreen:true` and the exact final `sourceManifestSha256`. The helper checks working bytes against the committed feature tree, installed pnpm lock, its native runtime bindings, `me.ts` route bytes, pure contract and audit helper. `runtimeBindingsOf()` supplies the actual Node/runtime-file projection; bind its canonical digest. Original private support `env.mjs`/`evidence.mjs` must match the lane copies. Never copy or display their secret values.

Versioned helper bytes below passed44 offline checks after a42-pass/two-failure RED. The prior39 cases and original files are unchanged. Independent source review remains a separate gate; these results do not approve live execution.

| File under `C:/w/admin640-staging-proof-canonical-v3/` | SHA256 |
|---|---|
| `admin640-staging-proof-executor.mjs` | `67ec2fffbc1887bbe4d03a4f572283a44ce5fc0da25aa8ee1668ab62c6f3dedd` |
| `admin640-staging-proof-audit-draft.mjs` | `620834cd98eaca9305a4cfdc94074f8bd54023a9c8e6a3479f7d5955eef75636` |
| `admin640-staging-contract-draft.mjs` | `f3a0d90a0622c8cc23dafec1888ffb8049526a924e464cc242c41e1b08735563` |
| `admin640-staging-proof-release-collector.mjs` | `bfe5e6c0397d5933c0c1d7fe62809444e65ebb907dcae4b60d23d92455344a7e` |
| `admin640-staging-proof-metadata-collector.mjs` | `8ff7f8e7b52396197b702721f2620bdfb2f8b5f246865bb6d6cc69cafca568aa` |

The release input's `collectorSha256` is the release collector; metadata input's separate `collectorSha256` is the metadata collector.

## 2. Collect public bytes first

```text
node C:/w/admin640-staging-proof-canonical-v3/admin640-staging-proof-release-collector.mjs --collect <reviewed-release-input.json> C:/w/admin640-staging-proof-assets-<fresh-attempt>.json
```

This is public-only collection of `/branches`, equivalent `/index.html`, favicon and the actual recursively discovered asset closure. Review `complete:true`, exact source/CI/deployments, the native raster MIME/body digests and the flat `assets`/`assetManifestSha256`. Reuse these exact values in the proof plan. No alternative PNG/WebP hash is accepted. A mismatch stops that attempt; preserve it and explicitly recollect before another reviewed attempt.

## 3. Obtain and approve a fresh read-only preflight

Prepare a strict metadata input with exactly:

```text
{approved:true, ticket:"SCRUM-640", release:<same release object>,
 collectorSha256:<metadata helper SHA>, mode:"preflight",
 outputDirectory:"C:/w/admin640-staging-proof-preflight-<fresh-attempt>",
 proofPlan:null, nativeReceipt:null}
```

```text
node C:/w/admin640-staging-proof-canonical-v3/admin640-staging-proof-metadata-collector.mjs --dispatch <reviewed-preflight-input.json>
node C:/w/admin640-staging-proof-canonical-v3/admin640-staging-proof-metadata-collector.mjs --collect <same-preflight-input.json>
```

Dispatch once only. Collection may be repeated while the acknowledged original job is pending and returns promptly. A lost/invalid acknowledgement is **unknown, no retry**; do not create a replacement job to hide uncertainty. Preserve actual terminal status even if later source/log/disk validation fails.

Inspect the original terminal `result.json`: `terminal:true`, `status:"succeeded"`, `passed:true`, read-only metadata, exact service/program/input/helper bindings. It returns held `approved:false` metadata and actual existing candidate `targets`; do not create B. Verify the two fixed demo accounts, eligible active home identities, ADMIN's genuine same-assignment null-operator platform/switch grant, Reception's absence of that authority, identity/employee/grant/app-identity and other-session fingerprints, exact branches and private-photo paths.

Choose exactly one returned active B distinct from home A, then:

```text
node C:/w/admin640-staging-proof-canonical-v3/admin640-staging-proof-metadata-collector.mjs --approve-preflight <same-preflight-input.json> <actual-censused-B-UUID> C:/w/admin640-staging-proof-preflight-<fresh-name>.json
```

The original `checkedAt` must be postdeploy and at most **120 seconds old when approval and native execution start**. Prepare the other inputs before dispatch so review fits. If it expires, preserve the attempt and explicitly obtain a new read-only preflight; never edit its timestamp. `accountEligible` is not an unlocked-session claim: actual sign-in must still prove `sessionLocked:false`.

## 4. Review the exact native plan and execute once

Plan keys are exactly the release keys **without `collectorSha256`**, plus:

```text
preflight:{path,sha256}, assets, assetManifestSha256,
privatePhotoPaths, outputDirectory
```

Use the approved preflight file's actual byte SHA, its exact photo paths, collected assets and a nonexistent `C:/w/admin640-staging-proof-<fresh-attempt>` directory. Save the reviewed plan as `C:/w/admin640-staging-proof-plan-<fresh-attempt>.json`. The coordinator explicitly approves the concrete plan before:

```text
node C:/w/admin640-staging-proof-canonical-v3/admin640-staging-proof-executor.mjs --execute C:/w/admin640-staging-proof-plan-<fresh-attempt>.json
```

The actual native sequence is ADMIN sign-in; `/me` → `/me/permissions` → `/me` authority handshake; home A Branches/picker frame; native picker A→B; canonical handshake and direct/native B directory comparison; working B frame; native picker B→A and restored handshake; exact original-cookie logout200/me401. Reception then signs in, has no picker, receives the real switch403, remains at home, is captured and closes200/401. Real platform authority stays tied to the unchanged home account.

The healthy journal has seven acknowledged operations: two sign-ins, ADMIN's two successful session selections, Reception's refused selection and two sign-outs. The only allowed mutation families are these auth POSTs and exact armed `PUT /api/me/session/operator` bodies `{operatorId,expectedRevision}`. No employee, grant, app identity, business setting or fixture write. No SMS, AI/provider call, payment, channel, check-in, hardware or OTO handoff. Native revision and canonical authority are observed; no public React epoch is claimed.

Wait for terminal native output, then inspect `result.json`: `nativeComplete:true`, **`complete:false`**, `awaitingReadOnlyAudit:true`; zero pending/nativePending/unresolved/unknown issuance and network errors; healthy journal; no business writes/fixtures; both original cookies confirmed closed. Failed or uncertain output is not sufficient for the audit/finalizer. Retain original-cookie cleanup and exact-session recovery evidence honestly if the process crashes; do not retry a mutation or claim cleanup from a missing receipt.

## 5. Collect the bounded audit, approve and finalize

Prepare a new strict metadata input with `mode:"audit"`, the same release, a fresh `C:/w/admin640-staging-proof-audit-<fresh-attempt>` directory and:

```text
proofPlan:{path:<original reviewed plan>,sha256:<actual plan byte SHA>},
nativeReceipt:{path:<native outputDirectory>/result.json,sha256:<actual byte SHA>}
```

Use the same `--dispatch` / `--collect` commands against that audit-input file. It executes only bounded repeatable-read/read-only SQL on the exact API image: the original proof interval (maximum ten minutes), two exact owned session IDs and fixed actor IDs. Require two switch audit rows with **captured request** tags A/A then A/B (event owner A), unchanged preflight identity/employee/grant/app-identity fingerprints, revoked retained own sessions with null overrides and all other sessions unchanged. Do not use an audited privileged audit GET to manufacture extra audit rows.

There is **no audit-approval or finalizer CLI**. After inspecting the actual original-job terminal receipt, the coordinator imports the existing exports and calls:

```text
envelope = approveAudit(rawAuditResult, plan, nativeProof, originalPreflight,
                       SHA256(originalNativeReceiptBytes), {explicitApproval:true})
final = await finalizeWithReviewedAudit(plan, envelope, {explicitFinalize:true})
```

`approveAudit` is exported by the metadata collector; `finalizeWithReviewedAudit` by the audit draft. Persist the approved envelope exclusively for evidence. The finalizer validates the real original-job/program binding, rechecks source/CI/latest deployments and original PNG bytes, creates the fourth network-free labelled actual-staging result card, and writes **`final-result.json`** exclusively. Preserve the original `result.json` unchanged.

## 6. Inspect and publish; parent remains a separate gate

Open all four actual PNGs and check source/ticket/postdeploy timestamps, native controls, privacy masks and honest labels:

1. `SCRUM-640-01-home-operator.png`
2. `SCRUM-640-02-working-operator.png`
3. `SCRUM-640-03-reception-refused.png`
4. `SCRUM-640-04-restored-session-and-audit.png` — actual checked facts on a result card, **not another native screen**.

Only the final complete proof, successful reviewed audit and actual human image inspection support the SCRUM-640 attachment/outcome and Deployed readback. Keep failed attempts and raw-byte bindings separate; never print cookies, tokens, credentials or private response bodies.

For parent **SCRUM-635**, after the final640 rollout capture a **fresh native Overview image** and combine it with the actual640 switch/audit evidence. The frozen executor visits Branches and does **not** allow Overview requests; use a separately reviewed bounded read-only capture rather than silently extending its allowlist. Inspect and attach the fresh Overview and switch/audit evidence to635, name their exact filenames/source/times in the parent outcome and verify Deployed. Older637 images remain historical, not new post640 screens. Final Done belongs to the owner; P5 waits for P4 Deployed.

## Evidence already available; limits still open

- `C:/w/admin640-staging-proof-collectors-independent-review-v1.json`: preparation-only source review, actual39 offline passes; not live approval.
- `C:/w/admin640-staging-proof-local-sql-review-v1.json`: six actual local SQL/loader checks passed on the earlier calibrated frame; read-only/repeatable-read and attempted-write refusal observed. It does not prove final deployed privileges or existing staging target B.
- `C:/w/admin635-parent-acceptance-20261026.json`:636–639 Deployed/evidence checked;635 and640 incomplete at that readback. Its pending list is preparation, not parent acceptance.
- Final released-schema loading, native UI geometry, Render result collection, actual public representations, real auth cleanup and final screenshots remain coordinator execution gates. The final product SHA/run/deployment IDs are deliberately not invented here.
- Deployment timestamp correction: this v2 accepts native UTC timestamps with zero through nine fractional digits only for deployment `finishedAt`. It retains the exact original string and latest-source/deployment equality. All other clocks still require milliseconds; the original120-second preflight age is unchanged. Actual RED42/2 and GREEN44/0 are preserved under `C:/w/admin640-staging-proof-native-time-{red,green}-v1.{json,log}`. No new live calibration or staging execution is claimed.

Canonical-manifest correction: v3 hashes the release binder's exact canonical source rows. Root .env.example and .gitignore remain mandatory regular committed blobs at the same feature SHA with exact working-byte checks and separate auxiliaryInputs hashes. No source coverage is removed. Actual offline RED46/1 to GREEN47/0 retains all44 earlier cases; original flat and v2 files remain immutable. The raw native deployment timestamp correction is preserved.
