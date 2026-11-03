# SCRUM-727 release evidence

## 3 November independent review follow-up

Current work is on `lane/codex-box-unlock-review-20261103-r1`. The earlier complete
gates below cover the pre-review candidate only. The manager-end reason and
freshness fixes now pass the 16-case real API/local HTTP review after four
failures were reproduced. The expanded complete suite is running; do not infer
release readiness from the historical green receipts. Q727-1 and Q727-2 remain
open in the offline plan. No main or staging action has occurred. SCRUM-728 was
started locally under updated direction and is checkpointed at `afbefec2` on
`lane/codex-box-outage-20261103-r2` while these fixes take priority.

## Earlier candidate evidence

Status: **In Progress; local checks only**. Source
`2a714b783d703925ae9b715af9fbd4f426f01dea` was rebased over documentation only
and backed up as `8e99e33e6561a04f8b5c6da5dabae805ba538bb6` on
[`lane/codex-box-unlock-20261103`](https://github.com/vickyydev/oto-platform/tree/lane/codex-box-unlock-20261103).
Runtime code and tests are identical. Main has not received this source.
The owner requires a lane push after every commit; branch backup deploys nothing.
SCRUM-726 reserves the staging source/API window through 17:30 Bangkok or its
exact cleanup record. No staging proof, API restart, Render change or
BOX_AGENT_TEST_SLOT change has been made. SCRUM-728 was queued at the time of this earlier candidate.

The configured zone is enforced at save, read and independently by the till.
Invalid tokens stay refused, ended shifts cannot reopen by omitting a token,
and the OD-6 setting reaches both box hosts. Older caches lacking latest-shift
metadata refuse fresh sign-in until a complete refresh. Production requires
the existing signing key. Installer origins are explicit; Caddy is version and
checksum pinned and DNS credentials stay scoped to Caddy.

The [workspace gate receipt](local-gates.json) records all 15 non-API test
tasks passing: box 877, POS 1,673, database 384, shared 883 and Console 588
(with three existing TODOs), plus the other packages. All 16 typecheck tasks
passed; lint has zero errors and eight existing warnings; generated contracts
match. All five application builds, display and runner builds pass. All seven
native till smoke journeys pass. Bash syntax and ShellCheck's error gate pass.
The [complete final API suite](final-api-gate.json) passed in three isolated
shards: 6,153 tests, zero failures, 401 existing skips and four TODOs across
442 files (434 passed, eight skipped). All three processes exited zero.
The [source comparison](source-equivalence.json) confirms that the tested and
backed-up runtime code and tests are identical. Its earlier failed run is [retained](../../proof-2026-11-03/s727/initial-api-gate.json).
The earlier timing failures passed in complete serial workspace reruns with
unchanged assertions and deadlines.

[The new local browser receipt](local/browser.json) records the rebuilt real
agent and Edge rehearsal from 08:24 to 08:26 UTC on 3 November. All application
URLs and the database were local. It passed the trusted test-zone save,
single online password/token send, forged-token refusal, outage token/password
unlock, clearly marked fresh sign-in on desktop and mobile, notice removal
after a new online sign-in, and ended-shift refusal with or without the token.
The exact ZZ TEST box/till were retired, bridge cleared, sessions signed out,
agent stopped and disposable database removed. No sale, payment or SMS occurred.

These local images were opened and inspected; they are not staging acceptance:

- [Dedicated test-zone address](local/s727-configured-test-zone.png)
- [Desktop notice](local/s727-fresh-sign-in-desktop.png)
- [Mobile notice](local/s727-fresh-sign-in-mobile.png)
- [Ended-shift refusal](local/s727-ended-shift-refused.png)

The desktop image also shows the existing configured-box Test harness state,
which belongs to the queued SCRUM-728 specification. This proof does not claim
that unit's floor-flow parity or physical Pi, iPad, DNS, certificate, printer
or power-cut acceptance. The owner's final OD-6 ruling remains one setting.

Automatic approval review rejected deletion of the first disposable agent's
private local cache with `blocked by policy`. That cache and later rehearsal
caches remain outside Git; their agents are stopped and local databases are
retired. The [initial cleanup receipt](../../proof-2026-11-03/s727/local-cache-cleanup.json)
records the rejected action. No deletion was retried through another method.

Next: rebase and check main CI after 726 releases its
window, push source and walk Testing, watch exact-SHA CI, then prove staging
with the dedicated test-zone local agent. Clear the fixture, restore temporary
settings with signing-key and unrelated-setting preservation, open the images and show them inside a commentWithImages Jira comment and only then walk Deployed. Never Done.
