# SCRUM-728 release evidence

## Testing: exact-SHA CI passed, deployment underway

Source `00f414ba0f78d91b0e87813924c3c53a64dddf5b` is on main and backed
up on `lane/codex-box-outage-20261104-r9`.
[Main CI 41693411235](https://github.com/vickyydev/oto-platform/actions/runs/41693411235)
passed all six jobs for that exact SHA. The changed-area tests, types, lint,
builds and native till/Console browser gates ran and passed. Unchanged OTO App
and migration steps were path-gated; full step outcomes are in [ci.json](ci.json).
All local gates and the complete branch CI also passed.
SCRUM-727 is Deployed with [its separate evidence](../s727/README.md).
SCRUM-728 retains the source, API, proof and cleanup slot released by 730.
No SCRUM-728 staging fixture, restart or setting change has occurred yet.

## Behavior and review

| Finding | Implemented behavior | Checks |
| --- | --- | --- |
| A cold till page has no outage door | A complete ordinary online sign-in prepares the selected trusted station and public catalogue. A cold outage restores a locked page; the box must authenticate the password. Saved browser data grants no permission. | `s728-offline-preparation`, `s728-auth-resume`; native cold-page rehearsal. |
| First box-required action refuses with no password screen | `BOX_SESSION_REQUIRED` from a staff action opens the existing lock screen. The refused action is not silently retried. | `s728-bridge-recovery`; the native mounted board read opens the lock, then an F&B order proceeds after password entry. |
| Display startup mistakes a temporary failure for a different release | Bounded version reads retry temporary startup/network failures. An actual different build still requires reload. | `s728-display-boot`; two injected startup 503 responses, real agent restart, empty display asset cache and a real mismatch response. |
| A configured box appears disconnected online | The authenticated presence read uses the same typed contract on both hosts. The shared display publisher supplies presence to the existing ticket, F&B, Shop and mobile surfaces. Local cache entries currently show the generic name Customer display. | API review for station/tenant isolation, no credentials, expiry and revocation; box display-channel tests; publisher tests; native online connected banner and hidden harness. |
| Saving the bridge freezes a web-hosted display | The save form warns that the display must use the box URL. Bench and quickstart include pairing, preparation and the URL change. | Native Console save screenshot; Console and full workspace gates. |
| Staff stream cannot recover after an unlock race | Staff streams wait for a fresh box session and reconnect; paired-display 401 remains terminal. | `s728-bridge-recovery`, publisher tests and native lock/unlock/restart. |
| Lost answers can duplicate non-sale changes | Add-children shares one operation ID and the original visit across lanes. Tier grant/revocation shares one verification ID. Locked, scoped durable replay checks prevent a second mutation and reject foreign IDs. | Four API adversarial review cases exercise the real agent and signed facts, repeated replay, concurrent requests, family/tenant fences and preserved timestamps/audits. |
| Returning box link races the browser's API path and lock | Recovery requires both the box and a bounded browser `/me` read with an unlocked session. Unlock checks recovery immediately; a cold prepared page hydrates authoritative permissions and station selection after online unlock. | `s728-lane-recovery`, auth lifecycle and counter-switch review; native online recovery. OD-4 receipt-collision behavior is unchanged. |
| Remembered unboxed station returns 409 | Both unboxed/not-ready refusals clear the remembered choice and display the picker and setup explanation. They do not activate the outage lane. | Entire lane suite, including both explicit 409 cases. A production census is still a prerequisite before production rollout. |
| Legacy cloud unlock fallback | The current POS caller is removed. The deprecated API endpoint remains for previously built virtual-box clients during rollout, retaining session/selected-station guards, reviewed verifier, shared cooldown and atomic audit. It cannot bypass an unavailable API. | Existing endpoint guards remain; seam inventory records the compatibility reason. Remove only after old clients retire. |
| Stale operating notes | Forwarder comment, loopback guidance, live-origin/handoff counts and deploy/wait rollback instructions now match the system. | Whole lint/contracts, checked scripts and read-only settings comparison. No Render setting was changed. |

## Completed local browser proof

The [native rehearsal](local/mw0xvp2f/browser-mw0xvp2f.json) passes on
`35dd6ac5acae613ed7c17a0f0d0ae0c4a820add2`, using the built till, real
bundled agent, Edge and a disposable local database. All eleven images were
[opened and inspected](local/mw0xvp2f/image-inspection.json). It proves the
startup, initial refusal/password door, cold-page restore, fresh sign-in,
online display presence, actual agent/display restart, true build mismatch,
cash sale replay, and ended-shift refusal with and without the token.

[Independent read-only cleanup](local/mw0xvp2f/database-cleanup.json)
confirms exactly one sale and one approved cash payment of 9,000 satang,
zero sync anomalies, archived box/till/printer, cleared bridge, inactive test
account, zero grants/sessions, revoked shift and display credentials, and the
unchanged public signing key. Both sessions signed out, the agent stopped
and the disposable database was removed. This is local evidence, not staging
acceptance. The exact executed local helper is archived beside its receipt.

A [second complete local rehearsal](local/mw0y9zig/browser-mw0y9zig.json)
on `3fa77e0613f3a2d0ce87a2782d54a0915b405830` also passes and independently
cleans up. It adds the explicit before-save warning assertion and
[opened image](local/mw0y9zig/s728-before-save-display-warning.png), closing
the first run's after-save screenshot limit. Its executed helper and
[inspection receipt](local/mw0y9zig/inspection.json) are archived alongside it.

## Gate evidence

All 16 workspace typechecks pass; API output is empty. Whole lint has zero
errors and eight existing warnings. Generated contracts, app/display/agent
builds, tooling checks and seven native smoke journeys pass on product source
`1694037b`. Subsequent commits change test fixtures and notes only; product
files are [identical](source-equivalence.json). The complete POS suite passes
all 1,734 tests across 130 files with one worker and unchanged deadlines.
The other 14 non-API workspace tasks pass. Console end-to-end passes all
357 cases against built apps. [Receipts and log hashes](local-gates/index.json)
retain the runs. The [completed original API run](local-gates/api-complete-run-before-inventory-correction.json)
covers 444 files: 6,173 passes, the one corrected inventory failure, 401 existing
skips and four TODOs. Shards 2 and 3 exited zero. The entire failed shard
passed on frozen source `682dfdc43475e9ddb03df2dd2268826cde1bb4f2`: 2,130
tests and zero failures, process exit zero. The [completed final API battery](local-gates/api-final.json)
has the same 444-file inventory: **6,174 passed, zero failed, 401 existing
skips and four TODOs**. All three process receipts exited zero, and API runtime
is identical across the runs.
[Full branch CI](branch-ci.json) for
`35dd6ac5acae613ed7c17a0f0d0ae0c4a820add2` passed all six jobs, including
all three API shards, the complete POS set, OTO App checks and Console
end-to-end. The release branch has identical product and test files; only
notes and evidence differ. Rebased typechecks, lint and contracts also pass
on `edf18cb491560eaa918b4106fb2dd75df90fa397`, with the whole output read.
The initial failures are retained, not counted as green runs:

- The first full API run found the old ID inventory still classified tier
  verification as platform-named. The complete corrected ID file and review
  pass, with a new pin requiring its shared caller ID and scoped replay check.
- The first workspace run found the missing display-presence API description
  and stale caller/type registries. The route now has authorization, the shared
  schema and generated response types; all ten seam checks pass. The hand-typed
  allowance decreased.
- The final API run found the new route absent from the exact guarded-route
  inventory. Its complete 26-test guard file plus four review cases pass after
  adding it; anonymous and foreign-station checks remain.
- [Lane CI 41679577544](https://github.com/vickyydev/oto-platform/actions/runs/41679577544)
  and the complete local POS run found the same one failure among 1,734 tests:
  the older recovery fixture supplied only the box answer. The updated fixture
  explicitly supplies and asserts the unlocked platform read. Its whole file
  and dedicated recovery suite pass 17 tests. The complete workspace rerun and
  [CI 41680736455](https://github.com/vickyydev/oto-platform/actions/runs/41680736455)
  check the corrected full SHA. The known failed older branch run was cancelled
  to release the queued corrected run; its POS failure log is retained.
- A later default-concurrency workspace run timed out in three unchanged
  display-holder tests, the mock-benefit source scan and browser-close cleanup.
  The whole POS suite then passed with one worker, without changing assertions
  or deadlines; all 14 other workspace tasks also pass.
- An API shard rerun was deliberately stopped after a rebase briefly changed
  its checkout. Its nonzero exit is retained as an interrupted run, not a
  test result. The completed replacement ran in a frozen worktree; all release
  edits and rebases use a separate checkout.

Native browser rehearsals exposed and pinned two actual recovery faults:
unlock could choose the old lane before probing, and cold-page online recovery
did not hydrate platform permissions. Both have failing-then-passing regression
tests. [Earlier rehearsal hashes and reasons](local-gates/earlier-browser-attempts.json)
retain the failures. Later harness corrections account
for the real generic display label, fresh password after an agent restart,
and cutting both internet paths for the ended-shift case. The completed local
run above supersedes them; staging acceptance remains required.

## Release conditions and limits

The explicit STATUS release and reservation are recorded, and all local
gates plus full branch CI pass. Rebase over the later documentation-only
closeout, inspect main CI, push the lane and main, and watch the exact full SHA.
Only after the exact API, POS web and Console deployments are live: take the
read-only staging census, apply the isolated test zone, and prove the native
flows with one new ZZ TEST box, local agent, dedicated staff and cash only.
Retire the exact fixtures, independently verify the one sale and cleanup,
restore all original setting fingerprints, and verify same-source deployments.
Open the native proof images and show them inside a Jira `commentWithImages`
comment before walking the ticket to Deployed. Never Done.

No real box address, park device, SMS or electronic payment is authorized by
this proof. Physical Pi/iPad, private HTTPS/certificate, printer and power-cut
acceptance are separate. The signing key stays, BOX_AGENT_TEST_SLOT stays
untouched, and OD-4 plus open Q727-1/Q727-2 retain their existing behavior.
Physical boxes need the corresponding agent release; these checks do not
install anything on a park device.
