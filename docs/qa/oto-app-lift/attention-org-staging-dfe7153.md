# SCRUM-193: Attention pause and Org Chart read-only staging proof

On 1 October 2026, `oto-app-staging` reported exact source
`dfe7153676e89276c1dabe7bb8b19514a3a968d2` live. The documented
administrator signed in through the staging launcher and opened the OTO App
in Playwright Chromium. No staging record was created or changed during this
check.

## Attention

`GET /api/attention-items?limit=100` returned 200 with `paused: true`, a
null last-calculated time and 43 saved items; counts returned 200. An unknown
branch in the list request returned 404. In the real 820 x 1180 staging view,
the pause notice was visible and Refresh, Snooze and Resolve were all disabled.
The reviewed screenshot is
`scrum-193-attention-paused-dfe7153-tablet-2026-10-01.png`.

This verifies the visible containment behavior for the signed-in
administrator. It does not prove another tenant's isolation, restricted staff
behavior, a successful reconciliation job or new alert generation. Automatic
alert writes remain paused until the platform tenant-key migration and
job-run contract are available.

## Org Chart budget

The safe read-only budget endpoint returned 200 for company scope and an
existing own-branch scope. Its live, draft and delta objects were present;
live and draft each counted eight people, and the salary totals were finite
numbers. Monetary totals were neither printed nor recorded. An invalid scope
returned 400 and an unknown branch returned 403. This confirms the budget
read and scope validation at the deployed revision for this administrator.

`GET /api/org-chart/nodes` was deliberately not called: the route can
auto-insert missing active employees on a read, and a read-only missing-node
count was not available. The Org Chart screen, reporting-line actions and
restricted or second-tenant reads remain outside this staging proof.
