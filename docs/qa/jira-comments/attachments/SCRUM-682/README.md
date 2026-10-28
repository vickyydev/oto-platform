# SCRUM-682 local repair evidence

The integrated source `30e90eb3257a05ab3f59411a7c6f70b65adb328b` passed 351 native Console browser cases, including nine error-recovery and five Support cases. Package checks passed 2,141 cases: Console 544, AdminScreens 156 and POS 1,441; three inherited Console TODOs remain separate. All six compiler configurations and 47-file lint passed. Inputs stayed unchanged and private database cleanup completed.

The [integrated summary](integrated-results.json), [browser receipt](browser-all.json) and [package checks](checks.json) retain the actual results. The [frontend binding](browser-all-frontend.json) and its [manifest](browser-all-frontend-source.json) are an explicitly derived subset of that same run, not additional tests. They bind 320 frontend files and all 37 executed browser specifications to the original whole-input receipt.

The native API receipts cover 461 checks: [37 contract/reference cases](api-green.json), [102 guard cases](api-guards.json) and [322 affected cases](api-affected.json), plus [ten generated-client seam cases](api-seam.json). Their original source is recorded in each receipt; the API bytes are unchanged in the combined repair. [Contracts](api-contracts.json), [API compilation](api-compiler2.json) and [API lint](api-lint.json) passed.

Known service refusals retain fixed public reasons. Unexpected server diagnostics stay private. Tax validation retains and focuses the draft; conflict or an uncertain save requires an explicit fresh read; rate limits retain the wait; a confirmed save with failed refresh retries only the read. Support retains safe request references and wait information. The missing-route envelope and twelve operation output contracts preserve existing rules and fields.

The [prior UI history](ui-local-history.json), [Support checkpoint](support-checkpoint.json) and [classification of the earlier browser failures](browser-failure-classification.json) retain failed attempts honestly. The earlier 25 failures were 24 obsolete private-server-text expectations and one changed Tax conflict/read interaction. Three later locator failures were corrected without removing state assertions. The final complete browser run exercises all current assertions.

The documentation-only rebase onto main `5930fd1b5c4a404bd7a28cde09655f9eec8b1692` changes no tested product file. API compilation and generated-contract comparison were repeated successfully afterward. Local results do not establish deployment or staging acceptance; those require their own exact CI, automatic rollout and inspected proof.


The exact [main CI](main-ci.json) passed all six jobs and the [native CI summary](main-native-ci.json) records its browser count. The [post-deploy staging receipt](staging-proof.json) records 43 successful native page responses and two distinct read-only 404s, with unchanged authority and verified sign-out. [All five PNGs were inspected](image-review.json). The local-regression card explicitly separates local failed-write/readback cases from staging. No business setting or payment changed.
