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
window closed on 2 November at 20:46 UTC. Its signing key remains and our
dedicated test-agent option is preserved. The consent fix was rebased again;
the product tree is identical to the combined source tested above.

This source is landing for full-SHA CI and staging proof. No SCRUM-722
staging family or setting has been changed.
The native proof will use a new ZZ TEST family on the retained SCRUM-723
dedicated box/till, then retire only that fixture and its test-agent option
while preserving the neighboring lane's settings and source.
