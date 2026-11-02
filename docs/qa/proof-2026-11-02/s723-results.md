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
