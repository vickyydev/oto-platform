# Refreshed proof on f8c4d429: display miss retained

Source `f8c4d4294c4a1b350e37635d1e17eaa92f7079fa`, all six jobs green in
CI 41443707967. API restart finished 12:51:10 UTC; the new POS was live at
12:46:07 UTC. This refresh followed SCRUM-717's payment/readiness release.
It is **not passing acceptance**: neither ticket was moved to Deployed.

The first native display run measured 533 ms to stream receipt and 540 ms to
visible F&B display, over the 500 ms limit. The customer answer direction was
74/226 ms and passed. The ordinary outage/recovery, revocation and sign-out
checks passed. The inspected failing card is `s710-new-staging-proof.png`.

A separate unchanged diagnostic run, retained under `trace/`, measured 491/497 ms
for till-to-display and 80/230 ms for the customer answer. This near-boundary
repeat does not erase the earlier miss. It recorded request timing without
headers, bodies, credentials or query strings:

| Event after Add | Time |
| --- | ---: |
| Item price request starts | 210 ms |
| Price response completes | 298 ms |
| Display publication starts | 368 ms |
| Publication response and display snapshot | 491 ms |
| Visible customer item | 497 ms |

The existing item quote hook waits 200 ms before asking the platform. The brief
allows client changes when a test shows one is needed. The narrow follow-up
shortens only the item-counter wait to 50 ms; ticket-till timing and all price,
sequence, pending, lock, commit and offline guards remain. The plan refinement
was posted on both tickets before source edits. No protected SCRUM-720 file is
changed. Local red/green evidence is `../s718-quote-review.json`.

The route itself still passes the 50 ms matching-percentile comparison. All 360
health calls succeeded, thirty per path/tool/mode, with stable live commits:

| Tool / mode / path | p50, ms | p95, ms |
| --- | ---: | ---: |
| curl / first / direct-api | 118.1 | 259.6 |
| curl / first / old-pos | 548.8 | 956.0 |
| curl / first / new-pos | 132.7 | 158.1 |
| curl / warm / direct-api | 57.2 | 84.9 |
| curl / warm / old-pos | 483.0 | 817.7 |
| curl / warm / new-pos | 60.2 | 103.8 |
| browser / first / direct-api | 123.3 | 182.2 |
| browser / first / old-pos | 548.5 | 576.7 |
| browser / first / new-pos | 128.3 | 192.9 |
| browser / warm / direct-api | 58.5 | 62.7 |
| browser / warm / old-pos | 477.1 | 854.8 |
| browser / warm / new-pos | 62.3 | 79.0 |

New streams opened 30/30 in both tools; old streams 0/30 within three seconds.
The native old/new cash journeys took 9,369/3,282 ms, with 38/39 API calls and
exactly one finalise each. The sole call-count difference was one additional
occupancy GET; all six mutation counts matched, including one quote, one sale
creation and one finalise. Receipts Z718-000004 and Z718-000005 remain finalised.

Installed-worker, genuine offline network failure, recovery, native scan and
foreign-Origin controls passed again. Static missing assets and traversal
passed. Independent cleanup found zero active displays, no lease on either
session route, all five known synthetic cash receipts intact, and sign-out
200 followed by `/me` 401. No park device or service setting was changed here.
