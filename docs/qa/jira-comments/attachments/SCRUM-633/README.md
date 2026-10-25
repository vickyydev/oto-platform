# SCRUM-633 — employee sign-in and lifecycle

Staging proof is complete on source `704bb3e3aea9f4348762521b886f2f7aef868021`. Jira remains Testing until the committed screenshots are attached and Deployed is read back. Final acceptance belongs to the owner.

Employee Create Login uses the owned platform provisioning service, with atomic local reservation, fresh actor/branch checks on retry, recovery after reload and once-only credentials. Existing legacy, advisor, role and branch rules remain. Platform reactivation enables the same linked app user. Every app-side disable queues an event atomically; the identity seam checks ownership and the last-administrator rule, disables the account, evicts sessions, audits and settles together. Old delivery after reactivation is harmless. Expand-only app migration0031 is applied; no core migration or applied-history edit.

All six jobs in [CI40146207019](https://github.com/vickyydev/oto-platform/actions/runs/40146207019) passed on that exact source. The three automatic deployments below were live before every staging observation and screenshot. No manual trigger was used.

| Service | Deployment | Finished UTC |
|---|---|---|
| oto-api-staging | `dep-dbekul3bc2fs738cavq0` | 2026-10-25T00:40:47.457261Z |
| oto-console-staging | `dep-dbekulbbc2fs738cb1t0` | 2026-10-25T00:38:23.683527Z |
| oto-app-staging | `dep-dbekul3bc2fs738cb0og` | 2026-10-25T00:40:31.724651Z |

The actual demo lifecycle used exactly two business writes: app Users disable, then platform account reactivation. Both completed200. The same app user and platform account are active again; all12 preservation hashes match across nine snapshots, including actor authority, raw user (expected active/timestamp fields excluded), the app-derived employee and its original branch, identity, grants and branch reach. The existing app derives that employee through its email fallback; its stored user link and different employee branch were preserved. No demo relinking or data repair was performed. The final read-only census records one delivered event, attempts1, one matching audit and pending0. Both lifecycle contexts signed out200/current-user401.

- `SCRUM-633-01-existing-demo-user-controls.png` — actual staging screen, captured 2026-10-25T01:19:05.353Z.
- `SCRUM-633-02-retired-studio-redirect.png` — actual staging screen, captured 2026-10-25T01:19:18.801Z.
- `SCRUM-633-03-lifecycle-and-local-invite-proof.png` — labelled test-run card, captured 2026-10-25T01:19:24.861Z.

The first screen opens only the existing demo's Users menu; no menu action is submitted. The second opens `/studio/troubleshooting` and shows the actual `/studio` page. The third is explicitly a labelled card bound to the actual lifecycle receipt and local invite receipt. Native capture completed 2026-10-25T01:19:34.173Z; both native auth contexts closed200/401. All source checks match, browser/network error counts are zero, and no native business write or fixture was created. Both reviewers viewed all three original PNGs and checked their hashes, visible controls and full source/timestamp captions.

The browser loads real deployed assets pinned to the265-asset public collection. It allows only exact page reads plus Studio's read-only avatar-status POST for the signed-in actor/date. Exact known photos and external font CSS are suppressed; masks conceal names, contacts and private dates. Original photo/font rendering is untested. The overlay is capture-only and changes no application source or persisted data.

Positive new-login proof is local captured-upstream HTTP and extracted native wizard closures using the actual MutationCache:15 employee HTTP/database,9 wizard,11 lifecycle and4 restricted-role migration cases. It is not a full rendered React browser or a staged invitation. Phone-form staging rendering and Today/Fix redirect screenshots are unclaimed; the other retired routes have local route-test coverage. No real SMS, payment, check-in, hardware or channel-mode action occurred.

Local broad checks: full API5339 passing cases/361files (3skip/5TODO), POS1437, Box749, all13 other package test tasks,16 workspace typechecks,5builds, generated contracts, schema and no-mock checks. The app fresh install,29-command build/release and PostgreSQL16 restore rehearsal pass. The whole compiler retains418 diagnostics/54files/109file-code buckets; all local and CI output was reviewed. Forced lint of17 touched app TypeScript files retains3 inherited errors and adds none. Post-rebase101tests and API0/contracts/schema pass.

Broad source99162fd2de839885ab82652145f20810197293db14407a43da2c3c221972c590 is bridged to final29d46a6af64025ee2e8701d688009d79e0d0d2f4410f1e483225bdca95f83dd2 by only two separately executed/linted CI test files. Production, API and dependencies match. Original local failures and the final lock regression's actual RED/GREEN remain recorded in local-release.json. No Booth production fix or cause is claimed and no guard was weakened.

Earlier staging readiness and capture attempts remain failed in qa-history.json. The final proof binds the actual derived employee/branch and the list DTO's branch-access tenant rather than invented fields. Studio's source-owned avatar read and exact photo rewrite are narrowly understood; the caption is clear of sidebar/bottom-nav masks and receives capture-only pointer events while the menu is open. No production source changed after release. Both ticket-owned Docker containers were removed after testing; all ten pre-existing containers, images, volumes and networks remain.

Bound receipts: staging-release.json indexes the screenshots and staging inputs; staging-lifecycle.json, event-census.json, staging-review.json and native-capture.json hold actual observations and cleanup. native-source-review.json and native-pixel-review.json separate source checks from image inspection. local-invite.json is local-only; ci-review.json, post-rebase-review.json and cleanup.json retain their actual scopes. Historical local-release.json deliberately keeps its original prelanding flags; it is not rewritten as deployment proof.
