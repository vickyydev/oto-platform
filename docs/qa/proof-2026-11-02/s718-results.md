# SCRUM-718: POS forwarding path

2 November 2026. Local implementation and before measurements are complete.
Main recovery CI 41436309930 is green. This source lands dark; service creation
and after measurements wait for its own full-SHA CI.
This report does not yet claim a deployed service or passing staging targets.

## Before any source or service change

Bangkok machine, 09:47:03-09:48:49 UTC. Thirty samples per group, interleaved
between paths. All returned 200. First calls use fresh curl processes or browser
contexts; warm calls reuse a process/context. The always-on API was not restarted
to manufacture a cold start. Browser means Microsoft Edge driven by Playwright.

| Tool / connection | Direct API p50 / p95, ms | Old POS p50 / p95, ms |
| --- | ---: | ---: |
| curl, first | 124.9 / 208.5 | 522.6 / 622.6 |
| curl, warm | 57.7 / 72.9 | 452.7 / 539.5 |
| browser, first | 143.3 / 233.9 | 576.7 / 938.5 |
| browser, warm | 61.4 / 170.2 | 473.9 / 675.3 |

Both services ran `b36267b34c8da83f614fa3ed4578d6c764c03fca` for this baseline.
API finished deploying at 08:27:42 UTC; old POS at 08:24:46 UTC.
Raw samples and measured live security/cache headers: `s718-before-paths.json`.

Stream opening, 09:54:20-09:55:56 UTC, thirty per path and tool:

| Path / tool | Opened within 3 seconds | First-byte p50 / p95, ms |
| --- | ---: | ---: |
| Direct API, curl | 30 / 30 | 165.4 / 327.7 |
| Direct API, browser | 30 / 30 | 79.0 / 175.7 |
| Old POS, curl | 0 / 30 | No first byte within the deadline |
| Old POS, browser | 0 / 30 | No first byte within the deadline |

Raw receipt: `s718-before-streams.json`. Every measuring session signed out.

The native old-POS journey on **ZZ TEST SCRUM-718 path**, attached to its own
virtual box, took **9,547 ms**, made **42 API calls**, and sent **one finalise**.
It signed in, added one French Fries item and recorded a synthetic 9,000-satang
cash sale. No gateway or real money was involved. The test lease was released;
sign-out returned 200 and the next `/me` returned 401. Receipt and inspected
native capture: `s718-before-journey.json` and `.png`. The initial harness input
doubled the phone prefix and was rejected before creating a session; that failed
attempt remains in `s718-before-journey-attempt1.json`.

## Local safety and efficiency

Final local checks: 1,633 POS tests; seven existing built till browser journeys;
17 real API/login/trust controls; touched-file lint; whole POS and API typechecks.
The installed shell opens offline, never caches API responses, preserves a genuine
network failure for the box-lane classifier, and resumes online.

The 32 server controls cover write bytes, idempotency/action headers, separate
cookies, no write retries, the single stale-socket GET retry, API-down errors,
stream delivery/cancellation, 100 connect/disconnect rounds, static compression,
cache policy, missing assets and traversal. The real API review demonstrates
that forged forwarded addresses do not buy another sign-in allowance, including
an untrusted direct peer; host-only Secure HttpOnly Lax login and Origin refusal
remain intact.

Adversarial controls were run against the implementation. Removing Idempotency-Key
made all four write-header tests fail; restoring it passed. An earlier normal-close
mutation did not cause the suspected socket loss and is not claimed as a defect.
A later test held a connected write response for 31 simulated seconds and exposed
a premature 502. The fix bounds connection setup only; it adds no response deadline
after connection, and the write now returns its original answer exactly once.
Receipts: `s718-mutation.json` and `s718-slow-write-review.json`.

The final 100-sample local real-API check added **0.56 / 1.13 ms p50 / p95**.
`s718-local-final.json` binds the result to the server source fingerprint and
records the installed-worker checks. The earlier measurement is retained in
`s718-local-check.json`.

Separate-process local load: 32 streams with 500 ms heartbeats plus 925 ordinary
reads in 20 seconds; peak server RSS **61.6 MiB**, CPU **0.034 cores**, and zero
upstream connections after disconnect. `s718-local-capacity.json` is a local
measurement, not Render Starter capacity proof; actual container CPU and memory
must still be measured after deployment.

## Staging acceptance still to run

After green exact-SHA CI, create the single approved staging Starter service in
the API's owner/region and project. Verify checksPass, the build filter, its actual
URL and private-network health. Only ALLOWED_ORIGINS needs an additive API edit;
read/count first, append through the guarded helper, verify every other value,
then redeploy the same live API commit. The old site and launcher stay in place.

Repeat all three paths within the same few minutes, at least thirty per tool and
connection mode, including stream opening. Repeat the native cash journey on old
and new addresses against the same current client code. Re-run the SCRUM-710
harness with exact live client/API commits, explicitly including SCRUM-720's
polling changes. Check native scan delivery, installed-app offline behavior,
caller address/forged-header buckets and actual Starter resources under streams.

Targets are under 50 ms added per call and under 500 ms in both display
directions. A miss remains Testing. Proof must be timestamped after deployment,
name all affected live commits, be visually inspected and attached before either
ticket moves to Deployed. Test displays, leases and sessions are cleaned up;
synthetic cash audit facts remain identifiable. No park device is switched.
The owner's forward/rollback procedure is `docs/ops/POS_WEB_SWITCHOVER.md`.
