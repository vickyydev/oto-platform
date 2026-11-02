# SCRUM-723 - a fresh booked-arrival page honors forced offline

**Deployed:** Jira read-back at `2026-11-02T19:07:15.846Z` confirms Deployed.
Inspected proof images are attached as 12237 and 12238. Evidence commit:
`eaf5e0360476b9db9d21f61486a746a4bd846580`.
[Jira closeout receipt](s723-jira-closeout.json). Final acceptance remains with the owner.

The booked-arrival route now opts into the existing station offline guard.
The guard returns `503 STATION_FORCED_OFFLINE` before a platform mutation or
idempotency replay. The existing client falls back to the box on its first
arrival action, including after a successful platform board read. No earlier
quote or other trade is needed. Online route behavior is unchanged.

## Review and local checks

Two HIGH findings reproduced before the correction: a new arrival and a stored
online answer each returned 200 instead of 503. They first ran as `it.fails`
findings with four passing controls, then failed as ordinary assertions. With
the route flag added, all six review pins passed, including real box queueing,
unchanged platform state while offline, reconnect and one source-fact consent
audit. The online consent/idempotency, authentication, branch/operator scope,
body validation, no-station Console and disabled-test-controls cases passed.

Focused regression run: 28 API tests across the review, consent replay, booked
board and existing offline-switch files; 20 POS tests across fresh-page fallback
and the lane arbiter. Whole API and POS typechecks, touched-file eslint and
generated API contract checks passed. Review receipt: [s723-review.json](s723-review.json).

Exact-source CI and the native staging proof passed. A hard-loaded Check-in
page refused its first platform arrival and accepted the box intent without
an earlier quote or trading action. The platform stayed unchanged while the
box queued the arrival, then reconnect filed the same acknowledgement time.
SCRUM-722's separate small-control correction follows 723 Deployed.

## Release preparation

Published source: `de29ebf481f179431a1ff8166ed86ddfcd5077a9`.
Exact-source [CI 41500821248](https://github.com/vickyydev/oto-platform/actions/runs/41500821248)
passed all six jobs. The unchanged OTO App remains path-gated; this is not a
claim of full app coverage. [CI receipt](s723-ci.json). The API, POS-web and
Console were verified live on this exact source before the proof.

Rebased onto `07f4393b`, including the completed forwarder and staging-link
changes, with all progress blocks preserved. All 16 workspace typecheck tasks
and five production builds passed; the full POS suite passed 1,645 tests in
122 files. Changed-file lint and generated contracts also passed after rebase.
The full API regression completed across three shards: 6,108 passed initially,
with three failures (one route-inventory assertion and two dependent nanny-duty
fixture assertions). The new route was added to the guarded-route inventory.
The nanny fixture now starts eight hours earlier so its active shift overlaps
the returned trading-day window even between midnight and the seeded 05:00
cutoff; no production behavior or assertion changed. Both corrected files then
passed all 46 tests, with lint and whole API typecheck passing again. The combined
result is 6,111 passing API cases; 401 existing skips and four TODOs remain.
No application source changed after the full regression began. Details are in
[s723-release-checks.json](s723-release-checks.json).

A new dedicated fixture is prepared in [s723-box-fixture.json](s723-box-fixture.json).
Its box is `01a19d64-335b-7d9d-8d3b-b5b7eb59280c`, station
`45492e2d-438c-4772-9276-edfbf384f4f1`, and receipt prefix `Z723`.
Preparation sessions signed out successfully and returned 401 afterward. Its
test-agent option was added at `2026-11-02T18:56:15.477Z`, preserving all 56
existing environment values. The same-source API restart became live at
`2026-11-02T19:00:01.532402Z`. The setting read-back is in
[s723-agent-env.json](s723-agent-env.json), and the automatic deployment receipt
is in [s723-deployments.json](s723-deployments.json).
The proof will use `https://oto-pos-web-staging.onrender.com`, which SCRUM-725
made the current staging destination. No service address or other lane setting
is changed by this unit.

## Staging proof and cleanup

The proof completed at `2026-11-02T19:03:45.803Z`, after the deployments. The
new synthetic family used registration `2cdfa5d5-1e88-4944-8e0d-203b286e28bd`
and retained cash audit receipt `Z723-000001`. Its consent was cleared once,
under an exact-identity guard, to represent a booked record missing consent;
its photo was a generated test card with no person photographed.

After Console Go offline, the native till hard-loaded `/drop-off`. The first
arrival POST returned `503 STATION_FORCED_OFFLINE`, then the box accepted it.
The counter acknowledgement was `2026-11-02T19:02:28.798Z`; the box held that
time with one queued fact while the platform still showed null consent and a
registered child. Reconnect stored that same time and changed the child to
in-park. Independent database read-back found exactly one consent audit naming
box fact `01a19da4-41e0-709c-88b2-0dcc0ab1b0ab`; the queue drained to zero.

The synthetic child was released through the ordinary pickup API. Independent
cleanup at `2026-11-02T19:04:07.396Z` confirmed the child out, platform lane,
empty queue, no lease, and the primary `virtual-1` selector unchanged. Every
proof and cleanup session signed out and returned 401. The dedicated box,
till and test-agent option are retained for SCRUM-722 and will be retired
after that proof. The API proof window is closed.

Evidence: [inspected proof card](s723-staging-proof.png),
[native offline board](s723-offline-in-park.png),
[reconnected board](s723-reconnected.png), [proof receipt](s723-staging-proof.json),
[independent cleanup](s723-cleanup.json), and
[same-source agent deployment](s723-agent-deployments.json).

The existing small-checkbox defect still reproduced; clicking the consent
sentence enabled confirmation. That is SCRUM-722 and was not changed here.
No physical Pi, printer, park station, real person, real payment or SMS was
used. This proves the Console's forced-offline path on a virtual staging box;
it does not claim a fresh staff unlock or a physical network-outage test.
