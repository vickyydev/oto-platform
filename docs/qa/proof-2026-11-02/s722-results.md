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

Release checks, full-SHA CI and staging proof are pending. SCRUM-713 owns the
next source/proof slot; this unit will rebase onto it and wait for that window
to close before publishing source. The retained SCRUM-723 ZZ TEST box/till is
online with no queued fact or lease. The native proof will use a new ZZ TEST
family, then retire only this dedicated fixture and test-agent option while
preserving the neighboring lane's settings and source.
