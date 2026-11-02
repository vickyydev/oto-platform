# SCRUM-723 ? a fresh booked-arrival page honors forced offline

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

Full release checks, exact-source CI and staging proof remain pending. The proof
will use a new ZZ TEST virtual box and till on the current staging POS origin,
hard-load Check-in after Console Go offline, observe the refused platform call
and accepted box intent, then compare platform state before and after reconnect.
No park device, real person, payment or SMS is part of the proof. SCRUM-722's
separate small-control correction follows 723 Deployed.

## Release preparation

Rebased onto `07f4393b`, including the completed forwarder and staging-link
changes, with all progress blocks preserved. All 16 workspace typecheck tasks
and five production builds passed; the full POS suite passed 1,645 tests in
122 files. Changed-file lint and generated contracts also passed after rebase.
The full three-shard API regression remains in progress.

A new dedicated fixture is prepared in [s723-box-fixture.json](s723-box-fixture.json).
Its box is `01a19d64-335b-7d9d-8d3b-b5b7eb59280c`, station
`45492e2d-438c-4772-9276-edfbf384f4f1`, and receipt prefix `Z723`.
Preparation sessions signed out successfully and returned 401 afterward. Its
agent is not enabled yet, and no test registration or sale has been made.
The proof will use `https://oto-pos-web-staging.onrender.com`, which SCRUM-725
made the current staging destination. No service address or other lane setting
is changed by this unit.
