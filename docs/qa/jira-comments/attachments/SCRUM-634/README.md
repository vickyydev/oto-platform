# SCRUM-634 — Staff and HR summary

The Staff & HR page reads on-shift, attendance issues, leave entries today and company payroll month status through the OTO App as the signed-in person. Each card opens its fixed native source through a fresh handoff. App salary/advisor rules and both platform section permissions remain. The selected live owned park must map uniquely to a reachable app park. Refusals and failures remain distinct from zero; payroll is explicitly company-wide.

The platform reads no HR/payroll tables. A separate app-owned SELECT-only status endpoint avoids payroll setup reads that lazily create defaults or return financial/person data. No migration, original attendance/leave/payroll calculation, shared dependency or protected production file changes.

Local coverage is recorded in [local-release.json](local-release.json). The three-shard API frame covers364 files and has one stale ordered-inventory failure; its original receipt remains failed. Adding exactly the missing protected GET expectation and running the complete25-case file plus138 focused cases gives5410 current passing cases,3 skipped and5 TODOs. [The source bridge](source-bridge.json) proves every production/dependency byte and every other test is identical; no fresh full-command rerun is claimed. The source release still requires exact-SHA full CI.

All16 workspace compilers,5 builds, generated contracts, global lint and no-mock checks pass. Full Console281 units/3 TODOs and204 browser cases, POS1437, Box749 and13 other package tasks pass. App fresh install, native9 status checks, genuine armed CI entry (prior39 plus new9),29-command release and actual restore pass. Whole compiler output is read:418 diagnostics/54files/109 buckets exactly match baseline. Forced lint of6 changed app files adds no errors or warnings.

Real review defects have failing-before/passing-after checks: an acknowledged temporary session is closed even after malformed/oversized/stalled auth data, and an explicit park filter resets when authority narrows. Every prior guard assertion remains. [History](history.json) keeps setup/timing failures, the stopped143 superseded run and the first inventory failure separate from successful checks.

This checkpoint is local only. Source landing, exact-source CI, automatic API/Admin/OTO App rollout and actual staging PNGs remain. The prepared staging helper has10 passing offline pins and a preserved failing counterfactual; that is preparation, not staging acceptance. Its owned contexts must close200/401 and screenshots must be inspected before attachment. No staged invitation, SMS, payment, check-in, hardware or channel action is planned. Two own test containers will be removed after testing while the ten other containers/data remain.

## Source CI and cleanup

Implementation `b91e957c779cb74a0c1495f24257bd69218286ae` passed all six jobs in CI `40154287659`; the exact-SHA watcher exited0. Fresh source CI is fully green. The whole668-line app compiler review retains418/54/109 with no increases; its one inherited display-only continuation difference is recorded in [ci-compiler-review.json](ci-compiler-review.json). Both own test containers are removed and all ten other containers/data plus images/volumes/networks are preserved: [cleanup.json](cleanup.json). Automatic same-source API/Admin/OTO App rollout and native staging proof are in progress; this is not Deployed acceptance yet.

## Live rollout and staging proof

All three automatic deployments are live on the six-green source, with the final deployment at2026-10-25T02:45:13.564893Z: [rollout.json](rollout.json). The public collector stopped before authentication because its regular expression confused a permission label with an import; [staging-qa-history.json](staging-qa-history.json) preserves that failed attempt and diagnostic. A narrow external QA parser correction and actual native comparisons/screenshots are pending. No production failure or staging acceptance is claimed.

## Native staging evidence

Actual proof completed 2026-10-25T03:21:42.735Z after all three exact-source deployments. Desktop and phone headlines matched stable same-actor native OTO App results; the existing restricted demo was checked. Every owned session closed200/current-user401, original authority hashes match, and there were no business writes, fixtures or network errors. The three PNGs were viewed by two reviewers. Source buttons prove fresh handoff and fixed navigation intent; destination UI was deliberately not loaded. Company names and signed-in identity are masked; external font CSS is suppressed.

- `SCRUM-634-01-admin-staff-desktop.png` — 2026-10-25T03:20:23.574Z, SHA256 `270c64d7ec7dec634e9f6456d5e5f71aa604d027b59e954ebca41b8ec2e0ad0f`.
- `SCRUM-634-02-admin-staff-phone.png` — 2026-10-25T03:20:36.211Z, SHA256 `cc903c62f26e7ac6bf7bb2a2ed6f7fc8992d0acb3b01d10edf6487cc8fe27577`.
- `SCRUM-634-03-reception-staff-desktop.png` — 2026-10-25T03:21:31.409Z, SHA256 `089e614ea59513c8e8a4aadf878fabf7c6624bb39a1e92793e9406d5d79a8fcc`.

Receipts: [staging-result.json](staging-result.json), [staging-summary.json](staging-summary.json), [staging-image-review.json](staging-image-review.json), [staging-independent-review.json](staging-independent-review.json). Prior public-collector failure remains in [staging-qa-history.json](staging-qa-history.json). Jira remains Testing until these committed screenshots are attached and Deployed is read back.
