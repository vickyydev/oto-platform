# SCRUM-631 staging preflight

PASS for the bounded metadata preflight. The collected succeeded job matches source `1462f5158f236c957523bd81b40355ad67fbfc49`, CI `40092931105`, the original job/intent and the release plan. No census, authentication, synthetic fixture, copy or screenshot acceptance is certified by this review.

The release plan contains exactly these three deployments:

| Service | Deployment | Finished UTC |
|---|---|---|
| API | `dep-dbeaaqg473hc738sudf0` | 2026-10-24T12:35:50.862284Z |
| Admin | `dep-dbeaaqg473hc738sug9g` | 2026-10-24T12:33:29.84063Z |
| OTO App | `dep-dbeaaqg473hc738suee0` | 2026-10-24T12:35:19.797903Z |

The original metadata job is `job-dbeae98ae00c73cg7g4g`, now `succeeded`. Its durable intent and job log-window start both remain 2026-10-24T12:40:05.245Z, after all three deployments. Actual safe readiness output is timestamped 12:40:47.803Z and was collected at 12:43:27.919Z. Its API deployment ID/finishedAt match the original intent and the API row above; source and CI match everywhere. The existing final CI capture independently records all six exact-source jobs completed successfully.

Actual readiness reports schema USAGE=true, SELECT=true for each of `otoapp_v.departments`, `otoapp_v.department_branches` and `otoapp_v.employee_departments`, plus both core columns `archived_at` and `external_id`. It records readOnly=true and businessRowsRead=0. The reviewed command uses a read-only transaction and `SELECT ... LIMIT 0`: this proves view readability without returning business rows. It does not assert that these views contain no records. No grant operation or business mutation was performed by the command.

The parser correction collected the same original job; no replacement job is represented by this receipt. The coordinator reports that the echoed start command was ignored by the corrected strict parser after its offline regression. This review certifies the resulting bounded receipt and its bindings, not a fresh independent execution of that parser or its tests.

Hashes inspected:

- Release plan: `bf2bde6c3fe76ec215a3bba51837aad609c71dc3cc1c56a809a3e6287811e477`.
- Readiness receipt: `a16941db0f1f85d39bcdf88aee2d75c7f0364e5b9efe2a4846a43d341a820cb4`.
- Original intent: `77be4ea73b03a01a51f4a94d36953bb085f29ef44b8ca148bbb1221c6c8a0268`.
- Original job binding: `ea8cccf9c3bb46f092e1bf6760100b327b04729786b9d1acb481d19f5ac2dd91`.

The previous three-view privilege/readability prerequisite is closed for this exact postdeploy preflight. The next existing-demo census and the proof's fresh own-app identity/tenant/mapping census remain separate checks before any synthetic department write. This reviewer read local receipts only; no network, auth, runtime, Git or source mutation occurred. Latest-live Render identities were enforced by the reviewed helper and supplied plan, and were not fetched again independently here. Deployment drift after these receipts must still be caught by the proof's live release checks.


## Concrete proof plan - 2026-10-24T12:45:07.942Z

PROCEED with the reviewed bounded proof. The concrete approved plan at C:/w/admin631-proof-plan.json, SHA256`4c58cd384654e7f4af33fe716227f7264121bd134726ec59c891f318a4211a2a`, matches exact source/CI above, all three release deployment IDs/times, the existing four-field ADMIN actor and both exact mapping tuples from the fresh completed census. Run ID`ffefbe00-7cec-4932-bf80-8170f30d7af9` determines the unique ZZ TEST source and renamed names. The proof helper still hashes`c4bcd6a21ef69df48f17dbcf84117196a5b5e85a48597f6d731de37b541abbe8`; no source change invalidates its earlier review.

Census receipt SHA256`39ce6f7b18495a4dca1fdc1a5e3f3c831a0a108a0c132b6749c7109864ad8662` reports complete=true, businessWrites=0, exactly two confirmed auth operations, no uncertainty/broken journal and sign-out200/current-user401. Its metadata read starts after actual succeeded readiness collection and all three deployments; its helper hash matches the reviewed census. The concrete plan's actor matches the helper's required existing account/app-user/operator/tenant tuple. Fresh app authentication, exact own app identity/tenant and both app/core mapping anchors are still checked by execute before any fixture creation, not inferred from the platform-only census.

The wrapper C:/w/admin631-run-proof.mjs, SHA256`fc1e4e73c6211060bff8adad15ec8656b7688434130a1f736515904f161c0afc`, only validates the explicit reviewed plan, calls the frozen execute function and emits a fixed safe failure message on rejection. It was read, not executed. Its safe catch does not turn an incomplete proof into success. The proof's live release rechecks, zero-member exact-source fences, no-retry uncertainty, native-frame checks and final cleanup/sign-outs remain required.

All twelve local plan/census/seam binding checks passed in this review. This is a proceed verdict for coordinator execution, not a claim that a department mutation, screenshot or final cleanup has occurred. The reviewer performed no auth, network, runtime, Git or staging action.
