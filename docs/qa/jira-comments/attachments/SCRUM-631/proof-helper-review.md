# SCRUM-631 resumed release and proof review

Read-only review of `C:/w/admin-department-mirror` and the external staging preparation. No authentication, staging request, test execution, container command, Git mutation or source edit was performed. This file is the only review output.

## Result

HOLD execution of the current proof helper until F1 is corrected and its offline regression is observed. No additional source blocker was found in the reviewed department seam, projection/member integration, directory or migration shape. This review does not certify the final release battery, actual role privileges, exact-source CI/deployment or staging evidence.

Main reference observed: `405b6ff55b121685f37e5c1f79a803074ba63582`. The newest STATUS resumes631 under the planner's approved Q16 ownership extension;632 remains isolated and no632 source is to land before631 is Deployed. The seed edit is owned by the other workflow and is not certified by this review.

## F1 - medium - unexpected successful mutation responses are classified as refusals

Location: `C:/w/admin631-proof.mjs:81-84`, `DispatchLedger.send`.

The code marks any nonmatching HTTP status below500 as `refused`, with `uncertain=false`. A create that returns200 or202 instead of201 can already have written the department. A redirect can also follow a write. Neither is evidence that the write was refused. The current code throws before parsing/capturing the returned source ID, yet its ledger calls the result a terminal refusal and permits later business dispatches. The complete proof ultimately fails, but its recovery record understates the unknown effect.

Required correction: accept only the exact expected status as confirmed; classify ordinary4xx as refused; latch `effect_unknown` and `uncertain=true` for unexpected2xx/3xx and5xx. Preserve the independent auth-cleanup exception and do not repair uncertainty after logout. Pin create200,202 and302 using the inert ledger, assert that a subsequent business transport never runs, and assert that logout is still attempted. Retain the existing transport-timeout,500,403 and broken-journal pins. The reviewer did not execute these tests.

Reviewed helper SHA256: `3b21290ffd38488042d5df4c0931818b9c8fb273977d8ecb8c36f0c085654fad`.
Reviewed offline test SHA256: `0e6db747c5e207cfe59191a943dc6455cc6871513119a73f14639e64e3c12440`.
Reviewed preparation SHA256: `53bed035d894c57c253d940e1f266ffebdff9e6a4898ba1bf96c887cbc44ef93`.

## Checked properties

- Import is inert. Execution requires a concrete approved631 plan, reviewed helper hash, existing exact ADMIN identity, a unique ZZ TEST name, two distinct app/core branch mappings, and new output paths. The rejected predecessor SHA list is only an extra check; the coordinator still must bind the actual feature SHA.
- Every phase rechecks completed six-job CI for the exact SHA and the latest live API/Admin/OTO deployments by exact deployment ID, source SHA and finished timestamp. A final check prevents acceptance after deployment drift. No manual deployment is performed by the proof.
- Authentication uses only the existing demo account and acting-user handoff. Secrets, cookies, handoff tokens, raw responses and child errors stay in memory; durable output uses safe IDs, enums, hashes and timestamps. No new account, invitation, employee, payment, check-in, hardware or channel-mode operation is present.
- The only source business actions are create, rename and `deactivate(force:false)` for the captured source ID. They use the OTO App's own HTTP routes. No Console write into app storage, raw SQL business write, employee assignment or role/grant/flag change is present.
- Fresh census requires the exact own-tenant demo user, current platform authority and both current owned branch mappings. Source reads require exact ID/name/tenant/two-branch set/zero members, with creation after the latest deploy. Directory reads require exactly two owned expected branch projections of the same source ID and stable core IDs through all phases.
- Copy dispatch uses only the existing staging employee-sync control, with no duplicate retry. It requires both the exact successful outcome text and a successful health job timestamp after the source mutation, plus directory convergence. The job is global; other department/member copies may legitimately change. The proof does not claim unrelated core records stay unchanged.
- Screenshots are of the actual native Admin directory section, with real fixture headings, source badges, exact park labels and zero member counts; the last phase requires Archived badges. Only a timestamp/source caption is inserted. There are no substituted API responses or replacement business rows. Both rows must fit inside the screenshot and the capture time must follow the latest deploy.
- The browser fence permits only the necessary same-origin Console metadata/static GETs. Employee/pay/private-media reads and all browser writes are blocked. The exact font stylesheet is intentionally suppressed, so original font rendering remains untested. Capturing a section excludes the surrounding account chrome.
- Durable intent is fsynced before dispatch, retries and redirects are disabled, transport/5xx uncertainty stays latched, and broken journaling prevents later business work. F1 is the remaining classification gap.
- On an ordinary failure with known confirmed source identity and no uncertainty, cleanup first closes the native page, revalidates exact own empty source and release bindings, then deactivates only that fixture and confirms its archived projections. Unknown effects or nonempty sources stop cleanup instead of forcing or deleting. An inactive ZZ TEST source row and archived projections intentionally remain as evidence.
- Both contexts attempt sign-out and current-user readback even when the journal is broken. Acceptance requires a confirmed200 sign-out followed by401 for both, all expected dispatch labels confirmed, no browser errors or blocked requests, exact final-source confirmation and the unchanged ADMIN/mapping census hash.

## Deployment and evidence prerequisites still open

1. Rebind the proof after the final source landing and final helper bytes. The preparation's `executionApproved:false` is correct; it is a proposal, not a run or acceptance.
2. Confirm API-role USAGE on `otoapp_v` and SELECT on all three new views before the first fixture write. The additive0030 migration intentionally adds no grants; the old employee readback checks only `otoapp_v.employees`. Owner/default privileges might already cover the new views, but that was not verified here. The helper's sourceGate verifies CI/deploy identities, not database privileges. Record a bounded metadata/readiness result independently; do not claim readiness from migration success alone.
3. Inspect the actual native staging PNGs twice before attachment, including caption/readability/row visibility. The existing offline tests exercise pure validators/ledger, not Playwright browser execution or the actual staging application.
4. Staging does not prove seeded Reception adoption or every team/grant reference unchanged: this synthetic fixture has a unique new name and zero members, and the safe census deliberately avoids broad staff/grant reads. Keep those claims tied to actual local regression/seed replay/restore gates.
5. For stronger timestamp reporting, record/check archived projection timestamps against the final source mutation. The current validator requires a finite archivedAt plus the observed active-to-archived stable-ID transition; it does not independently assert archivedAt is after that mutation. Do not claim a stricter timestamp check than the helper performs.

## Migration numbering

Read from `origin/main` journals at405b6ff55b121685f37e5c1f79a803074ba63582:

- Platform journal ends at idx85, `0085_account_ui_preferences`, when1792618896318. Local appended idx86 is `0086_department_mirror`, when1792832256866.
- OTO App journal ends at idx29, `0029_platform_roles_enabled`, when1792773345454. Local appended idx30 is `0030_department_read_seam`, when1792831817751.

There is no numbering collision at this read. Recheck main at landing; if another migration lands, renumber and regenerate/diff the snapshot with identical SQL as required. Core0086 is nullable columns plus partial unique indexes which reserve archived source identity. App0030 adds three metadata-only views, preserves raw invalid references for validation and leaves the applied employee view unchanged. This is source review only, not a new verify-schema or restore execution.

## Source and receipt limits

Reviewed current source diff and the new reader/helper, together with `admin631-model-audit.json`, `admin631-worker-independent-review.json`, `admin631-worker-final-review.json` and `admin631-migrations-generated-review.json`. The earlier partial-feed defect is visibly corrected by holding still-referenced missing owned masters, while foreign references cannot hold own removals. Stable operator/exact-branch adoption, branch archive/restore and membership tenant/branch fences remain in the operator transaction. Existing worker receipts report26 passing cases, but this reviewer has not rerun them and does not relabel the earlier full-battery seed failure as green. Q16 seed replay, final source gates and restore/replay must be supplied by the coordinator's current run.


## F1 closure - independently reviewed 2026-10-24T11:48:30.504Z

F1 is CLOSED on the updated external helper. This closure supersedes the original F1 HOLD above for that defect only; execution still requires the separate release, privilege, census and native-image prerequisites.

The actual helper SHA256 is `c4bcd6a21ef69df48f17dbcf84117196a5b5e85a48597f6d731de37b541abbe8`; the actual tests SHA256 is `88db3e0fa63a88c445e8bfc3292ed7de49f4cacbde7d7a5caa33aa82be0440bd`. Exact before/after comparison confirms that the helper's only source change is the status-classification block and its matching error selection. An exact expected2xx is confirmed; ordinary4xx is refused; unexpected2xx/3xx and5xx latch effect_unknown and uncertainty. The existing business-write block and auth-cleanup exception remain intact.

Both complete offline TAP logs were read. The same test bytes against the preserved old helper produce10passing cases and3actual failures, exit1/no signal, for unexpected create200,202 and302 allowing a second business transport. With the narrow fix, all13cases pass, exit0/no signal. Each new case checks that no second business dispatch occurs, logout still runs exactly once, and uncertainty remains latched after logout. The existing timeout,500,403 and broken-journal cases remain passing. No rerun or runtime action was performed by this reviewer.

- RED: `C:/w/admin631-status-classification-1792842158993-red/result.json`, receipt SHA256`df418ccd6539ce47481441929519ea26ed5f020f11170f19a2e0f0297c88c7ef`; log SHA256`e4d89595da641c10dcc65ceefca1c22790c630c2aaf2069d3c4748c7999fbaeb`; preserved old helper SHA256`3b21290ffd38488042d5df4c0931818b9c8fb273977d8ecb8c36f0c085654fad`.
- GREEN: `C:/w/admin631-status-classification-1792842192513-green/result.json`, receipt SHA256`e595cead41fd8d373738b398230c5c0964d4ee538ae78802f66b1161b1bd855a`; log SHA256`366642608ca9d3822d1a18434691de1e7662993501c64737912a835911c21f98`.
- Both receipts explicitly record network=false, auth=false and staging=false. The current helper/test hashes and both actual log hashes match their receipts.

The independent pre-create API-role USAGE/SELECT readiness check for all three new views remains OPEN until the actual postdeploy metadata/readiness job is inspected. No staging or release completion is inferred from these offline results.
