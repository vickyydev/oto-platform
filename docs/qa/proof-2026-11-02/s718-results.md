# SCRUM-718: POS forwarding path

**SCRUM-718 and SCRUM-710 are Deployed. Final staging measurements passed on `796a3724505ee9cd46f93584c975971ad50a3e4d`**,
[CI 41452442131](https://github.com/vickyydev/oto-platform/actions/runs/41452442131). See [the final acceptance report](final/README.md)
for all current numbers, live service commits and safety/cleanup evidence.
Image attachment and the required Jira walk are recorded in the newest STATUS
block. No park device or production address has switched.

The sections below preserve the initial c2fdd28f proof and before-change baseline.
The later [540 ms miss and trace](f8c4d429/README.md) remain part of the record;
the final report explains the narrow item-quote scheduling fix and three fresh
passing display runs.

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

## Live staging setup

The new address is https://oto-pos-web-staging.onrender.com, service `srv-dbk7qu8n74is73bm894g`.
It is in the API's workspace, Singapore region and existing staging project,
on Starter with one instance. `checksPass` and the POS-specific build filter
were read back. The documentation-only checkpoint did not trigger another
build: the new service still has exactly one deploy. No build-minute limit was hit.
The manual settings match the commented `render.yaml` block.

| Service | Live deploy | Finished (UTC) | Live source |
| --- | --- | --- | --- |
| oto-pos-web-staging | dep-dbk7qv0n74is73bm8cmg | 2026-11-02T12:12:21.064195Z | `c2fdd28fdc9e944d058af62dec1347e5f2b7a56f` |
| oto-api-staging | dep-dbk7sns9v7es73bvie50 | 2026-11-02T12:16:46.029843Z | `c2fdd28fdc9e944d058af62dec1347e5f2b7a56f` |
| oto-pos-staging | dep-dbk7qmrm8hqs738hvbo0 | 2026-11-02T12:09:52.050901Z | `c2fdd28fdc9e944d058af62dec1347e5f2b7a56f` |

The new service's own job `job-dbk7sch42hec73et4n8g` resolved the API privately
and received health 200. Only `ALLOWED_ORIGINS` changed on the existing API,
through `appendEnvList` after private reads and a ticket note. It has 56
variable names before and after, no added or removed names, and every other
value was verified unchanged. The allow-list gained one entry. The API then
redeployed the same live source; the new native sign-in proved it active.
`HANDOFF_APP_ORIGINS`, `TRUST_PROXY_ADDRS`, launcher destinations and old POS
settings remain unchanged. No shared public Render range was trusted.

Receipts: `s718-new-service.json`, `s718-new-private-network.json`,
`s718-api-env-receipt.json`, `s718-ci.json`. The old page and API path answered
200 on all 466 checks from 11:17:59 to 12:18:42 UTC, covering creation and both
API deployments (`s718-old-path-availability.json`).

## After: direct API, old POS and new POS

Bangkok machine, 2026-11-02T12:18:32.412Z to 2026-11-02T12:20:18.689Z. Thirty per
path/tool/mode, interleaved; all 360 reads returned 200. Service commits were
read before and after and stayed live and unchanged. First means fresh curl
process/browser context, not a deliberately stopped service.

| Tool / connection | Direct p50 / p95, ms | Old p50 / p95, ms | New p50 / p95, ms | Added p50 / p95, ms |
| --- | ---: | ---: | ---: | ---: |
| curl, first | 126.8 / 232.2 | 542.2 / 938.8 | 128.9 / 203.2 | 2.0 / -29.1 |
| curl, warm | 56.9 / 100.9 | 466.8 / 766.0 | 59.4 / 67.8 | 2.5 / -33.0 |
| browser, first | 118.7 / 143.1 | 532.7 / 625.9 | 123.4 / 141.1 | 4.7 / -2.0 |
| browser, warm | 57.7 / 62.4 | 460.0 / 518.1 | 61.3 / 65.4 | 3.6 / 3.0 |

Added latency uses the same calculation as the earlier local check: the new
path's p50/p95 minus the direct path's matching percentile in this window.
Every comparison is below 50 ms. Negative differences reflect network variation,
not an API speed-up. This is not a maximum bound on every internet request;
individual outliers are retained, without trimming, in `s718-after-paths.json`.
Percentiles use nearest rank. Browser measurements used Microsoft Edge.

## Stream opening

Window: 2026-11-02T12:20:57.801Z to 2026-11-02T12:22:32.487Z. Thirty per path/tool.

| Path / tool | Opened within 3 seconds | First-byte p50 / p95, ms |
| --- | ---: | ---: |
| direct-api, curl | 30 / 30 | 147.9 / 190.4 |
| direct-api, browser | 30 / 30 | 76.5 / 130.9 |
| old-pos, curl | 0 / 30 | No first byte within 3 seconds |
| old-pos, browser | 0 / 30 | No first byte within 3 seconds |
| new-pos, curl | 30 / 30 | 151.5 / 201.4 |
| new-pos, browser | 30 / 30 | 80.6 / 130.6 |

All measuring sessions signed out. The new event streams were uncompressed;
32 streams were also held open together for the capacity check below.
Raw receipt: `s718-after-streams.json`.

## Native cash journey and first page

Both paths ran the same current source, after SCRUM-720's polling change.
The earlier before-change journey remains separate because it predates that change.

| Measurement | Old address | New address |
| --- | ---: | ---: |
| Sign-in, item and cash completion | 9,057 ms | 3,327 ms |
| API calls during that journey | 39 | 39 |
| Finalise POSTs | 1 | 1 |
| First locked page visible | 1,823 ms | 533 ms |
| Initial encoded script/style bytes | 696,797 | 580,651 |

Each path recorded one synthetic 9,000-satang cash sale at the isolated ZZ TEST
virtual station. No gateway or real payment was involved. The retained receipts
are Z718-000002 and Z718-000003; Z718-000001 is the original baseline.
All three were independently read back finalised at the exact test station.
The lower asset byte count comes from this server's precompression of the same
build; it is not a smaller application. These are single native journeys, not
statistical page-load measurements. JSON request timings and inspected native
PNGs: `s718-after-old-journey.*`, `s718-after-new-journey.*`.

## SCRUM-710 on the new path

Harness source and both affected live commits:
`c2fdd28fdc9e944d058af62dec1347e5f2b7a56f`, CI 41439428324.
This includes SCRUM-720 polling source `2513e1fb385190c38f494d81006cfc1e44302f79`.

| Native action | Stream receipt | Visible screen |
| --- | ---: | ---: |
| Till adds an item -> customer display | 431 ms | 448 ms |
| Customer submits synthetic phone -> till response | 84 ms | 242 ms |

Both directions are below 500 ms. These are the two native harness actions,
not a p95 distribution. Ten seconds offline retained the last display with
Reconnecting; at twenty seconds the paused notice hid the total; online recovery
was automatic. The display was revoked through Console, returned to pairing,
and its replacement code was expired. Sessions on POS, Console and launcher
signed out, and each subsequent `/me` was 401. The timestamped card names both
live service commits. `s710-new-staging-proof.png` was opened and inspected,
and attached to SCRUM-710 as attachment 12227; raw receipt and native screens
are beside it. The station is the dedicated ZZ TEST SCRUM-718 path virtual setup.

## Login, offline, scans and static safety

The new path gives the API the real caller address. Two failed synthetic
sign-ins with different forged forwarded addresses produced two failures in
this machine's actual address bucket, zero forged buckets and zero other
address buckets in the observed window. A read-only job checked fingerprints,
without recording IP addresses or credentials. Normal successful sign-in then
cleared the measuring address's failure count. The local real-API test separately
exercised the actual 429 boundary and showed a forged address cannot buy another
allowance. Staging was not deliberately driven to its shared sign-in limit.
The live cookie is host-only, Secure, HttpOnly and SameSite=Lax; its Set-Cookie
header stays separate. Foreign Origin was refused 403 without CORS, and the
existing login remained usable. See `s718-forwarded-address.json`.

The installed worker controls the shell with nine cached entries and no API
responses. Offline `/today` opens and `/api/health` rejects as a real network
failure; online recovery returns 200. The native station scan stream delivered
one synthetic unknown scan in 81 ms. The first scan harness attempt selected the
server station but omitted the browser's local station picker, so no till hook
was mounted. Using the normal picker fixed the harness; no product source changed.
That attempt is retained as `s718-browser-safety-attempt1.json`. The final checks
are `s718-browser-safety.json`; the offline image was recaptured after its
entrance animation settled, with credential inputs masked (`s718-offline-capture.json`).

The new index and worker are no-store, hashed assets have one-year immutable
cache, and text assets arrive Brotli-compressed. The old site's HSTS and nosniff
headers match. Missing hashed assets return 404, not the shell; raw traversal,
hidden-file and encoded-backslash probes return 400 (`s718-static-safety.json`).
The API-down response and unchanged box-lane selection were pinned locally.
A physical Pi/offline unlock is not claimed: no park box was touched, and staging
lacks the offline-sign-in key documented by SCRUM-719. The browser network
failure itself was verified on this deployed service.

## Starter resources and disconnects

From 12:32:57.746 to 12:35:27.970 UTC, the new service held 32 uncompressed
streams and answered 562 health reads. All 32 readers closed after cancellation.
Render's 30-second samples in that load window gave:

| Resource | Sampled maximum | Limit | Headroom |
| --- | ---: | ---: | ---: |
| CPU | 0.0062 cores | 0.5 cores | 98.8% |
| Memory | 114.4 MiB | 512 MiB | 77.7% |

These are sampled resources for this workload, not a saturation limit or an
instantaneous peak guarantee. The local 100-connect/disconnect controls count
upstream connections directly and leave zero. Render's active-connections metric
is for database/cache resources, so no staging upstream count is inferred from it.
Receipts: `s718-staging-capacity.json`, `s718-staging-metrics.json`.

## Cleanup, evidence and owner's next step

Independent read-back found no active display and no lease on either station
session route. All test sessions signed out; the final `/me` was 401. The three
synthetic cash audit records remain, identified by the ZZ TEST station and line
notes; no financial record was deleted, replayed or voided. The isolated virtual
box/station remain for identifiable QA history, with no active device pairing.
See `s718-cleanup.json`.

The final timestamped `s718-staging-proof.png` was opened and inspected. It names
API, old POS and new POS live commits and distinguishes measured staging results
from local safety controls. `s718-staging-proof.json` is the combined receipt.
The same PNGs are copied under `docs/qa/jira-comments/attachments/SCRUM-718/`
and `SCRUM-710/`. Jira is walked to Deployed only after this evidence lands and
is attached; Done remains the owner's decision.

The forward steps and rollback are complete in `docs/ops/POS_WEB_SWITCHOVER.md`.
The old site, launcher destinations and park devices stay as they are. Switching
staff, iPads or a Pi to the new address is the owner's separate operation.
