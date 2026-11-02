# SCRUM-722 - one consent change per click or key press

The booked-arrival dialog now uses one checkbox inside its associated label.
The checkbox owns the state change; the surrounding row no longer reverses it.
The consent sentence, missing-photo check, acknowledgement requirement and
server contract are unchanged. The product change is confined to
`apps/pos/src/components/dropoff/CheckInBookedModal.tsx`.

## Adversarial review

The review serves the actual React dialog and Radix checkbox in a browser,
with a synthetic family and an observed confirmation callback. It supplies no
replacement click handlers and uses no camera, API or staging data.

Before the fix, two expected findings reproduced. As ordinary assertions they
failed with `expected false to be true` after clicking the small control and
after pressing Space. Four controls passed: text-click toggles, photo blocking,
reset on reopening and existing consent. With the correction, all six cases
pass, including one positive acknowledgement delivered to the confirmation
callback and the labelled checkbox's keyboard behavior. The review lives in
`apps/api/test/s722-consent-control-review.test.ts`; its browser harness lives
under `apps/pos/test/support/consent-harness/`.

## Local release checks

Three full API shards passed on frozen source
`c195b4de60d78d86b703e7fafbd2acab4e27db1d`: 6,137 tests across 431 passing
files. The existing 401 skips, four TODOs and eight skipped files remain.
All six consent browser cases passed as part of that full run.

The unit then rebased onto SCRUM-713's final display follow-up
`f3b793dcc35d296a03582d617a9a94a3b555da60`. The API and package trees are
identical across that rebase. Combined source
`a0c05f5969e4b4631b7652ed19e1e0a9f5e2a536` passed all 16 workspace
typecheck tasks, touched-file eslint, five production builds, all six consent
browser cases again, all 1,659 POS tests and all seven built browser journeys.
The disposable browser-test database was removed. Generated API contracts
matched before the follow-up, which changed no API schema.

Commands ran unpiped with failure propagation. API suites ran whole files;
the full battery used three isolated embedded databases with Docker off.
Counts and source identities are in `s722-release-checks.json`.

## Release and staging

SCRUM-713 recorded its successful staging proof and cleanup with the API
window closed on 2 November at 20:46 UTC. Its signing key remains; our
dedicated test-agent option was preserved for this proof. The fix was rebased again;
the product tree is identical to the combined source tested above.

Source `8963cd2e71f2484f8e53174aa5d3c85671c611de` passed all six jobs in
[CI 41522382629](https://github.com/vickyydev/oto-platform/actions/runs/41522382629).
The full-SHA watcher exited successfully. CI independently passed all 6,137
API and 1,659 POS cases, including the six actual consent browser cases.
The unchanged OTO App remains path-gated; its skipped checks were not run.
The exact job outcomes and test summaries are in `s722-ci.json`.

The proof services were live on that exact source before the native run:

| Service | Live at (2 November, UTC) |
| --- | --- |
| API | 21:13:53.270 |
| POS web | 21:12:58.998 |
| Console | 21:11:13.021 |

The real-browser proof ran from `21:14:58.121Z` to `21:18:15.958Z`.
It used a new synthetic family on the retained `ZZ TEST SCRUM-723 till`
and dedicated virtual box. Registration
`badbe496-f7a6-4533-839d-93195ccf4d5d`, child
`a524230a-c593-402b-8450-e1dd174135af` and cash audit receipt
`Z723-000002` identify the fixture. Consent was cleared once under an
exact-identity database guard to represent a booked record missing consent.
The uploaded image was a generated test card; no person was photographed.

| Native check | Observed result |
| --- | --- |
| Small checkbox, twice | Selected once, then cleared once; confirmation followed the state |
| Consent sentence, twice | Selected once, then cleared once |
| Space, twice | Selected once, then cleared once |
| Small checkbox for arrival | Selected once and sent acknowledged consent |
| Missing photo with consent selected | Confirmation remained disabled |
| First arrival on the hard-loaded offline page | Platform refused with 503 STATION_FORCED_OFFLINE; box accepted |
| Offline state | Platform consent remained null; box retained the counter time with one queued fact |
| Reconnect | Original time filed once, one consent audit, queue zero |

The original counter time was `2026-11-02T21:16:59.372Z`. Independent
database job `job-dbkfrlc9v7es73bv7tk0` found one consent audit naming
box fact `01a19e1f-674c-7ad0-86ff-848a62478b6c`, with that same time in
the fact and registration. The child was released through the ordinary pickup
API, the lease was released, and POS, Console and launcher sessions signed out
and returned 401. The browser reported no page error.

## Fixture retirement

Independent readback confirmed both the SCRUM-722 and previous SCRUM-723
children out, an empty queue and no held lease. Only their dedicated test box
and station were archived; the primary virtual box remained unarchived.
Only `BOX_AGENT_TEST_SLOT` was removed: 58 environment names became 57,
with every other value byte-identical, including the SCRUM-713 signing key.
The same-source cleanup restart `dep-dbkfshu1egvs7393c7b0` became live at
`2026-11-02T21:22:47.900932Z`. Final readback at `21:24:24.718Z`
confirmed health and readiness 200, 57 environment names, no test-agent
option, both children still out and the exact fixture archived. The primary
`virtual-1` heartbeat at `21:23:51.801Z` is after the deployment went live.
Cleanup sessions signed out and returned 401. The API proof window is closed.

## Evidence and scope

The [proof card](s722-staging-proof.png),
[small-checkbox capture](s722-direct-checkbox.png) and
[missing-photo capture](s722-missing-photo.png) were opened and inspected.
The [offline board](s722-offline-in-park.png) and
[reconnected board](s722-reconnected.png) were also inspected.
The [proof receipt](s722-staging-proof.json),
[deployment receipt](s722-deployments.json) and
[cleanup receipt](s722-cleanup.json) hold the timestamps and guarded readbacks.

This proves the browser control and its existing virtual-box consent path on
staging. No physical Pi, printer, park station, real person, real payment or
SMS was used. The separate physical bench work remains outside this unit.
Cleanup is complete. Evidence commit
`943858c42cc885224f883368b8fc241e2bf7019c` is published. Jira readback at
`2026-11-02T21:27:41.395Z` confirms **Deployed**, with the inspected proof
card (12242), direct-checkbox capture (12243) and missing-photo capture
(12244) attached and named in the plain comment. The
[Jira closeout receipt](s722-jira-closeout.json) records that transition.
Final acceptance remains with the owner; the ticket was not moved to Done.
