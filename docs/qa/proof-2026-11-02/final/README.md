# SCRUM-718 and SCRUM-710: final staging acceptance

Measured after deployment on 2 November 2026. Source `796a3724505ee9cd46f93584c975971ad50a3e4d`,
[CI 41452442131](https://github.com/vickyydev/oto-platform/actions/runs/41452442131), all six jobs successful. The dedicated new POS
address is https://oto-pos-web-staging.onrender.com. Both timing gates passed; the evidence is ready for
the required image attachment and Deployed walk. No park device has switched.

## Exact live versions

| Service | Live commit | Deploy | Finished UTC |
| --- | --- | --- | --- |
| oto-pos-web-staging | `796a3724505ee9cd46f93584c975971ad50a3e4d` | `dep-dbk986bm8hqs738k1tgg` | 2026-11-02T13:48:30.723553Z |
| oto-api-staging | `796a3724505ee9cd46f93584c975971ad50a3e4d` | `dep-dbk986bm8hqs738k1shg` | 2026-11-02T13:49:22.62076Z |
| oto-pos-staging | `796a3724505ee9cd46f93584c975971ad50a3e4d` | `dep-dbk986jm8hqs738k1tkg` | 2026-11-02T13:46:48.368302Z |

Every measured service's application/dependency tree was checked against the
validated source. An older API SHA, if shown, has an identical API runtime tree;
it is not relabelled as the newer POS commit. All deployments preceded this proof
and stayed stable through the corresponding measurement windows.
SCRUM-720 polling source: `2513e1fb385190c38f494d81006cfc1e44302f79`.
Initial forwarder source: `c2fdd28fdc9e944d058af62dec1347e5f2b7a56f`.

## Why the final source differs from the first proof

The first new-route proof passed at 448/242 ms visible display timing. A later
fresh run on f8c4d429 missed at 540 ms till-to-display. That failed proof and a
497 ms diagnostic repeat remain in [the earlier refresh](../f8c4d429/README.md);
the near-threshold repeat did not erase the miss.

The trace spent 210 ms before requesting a platform item price. The approved
test-demonstrated client exception permitted one scheduling change: item-counter
quotes wait 50 ms instead of 200 ms. The ticket-till debounce remains 200 ms.
Prices, money totals, current-platform-price requirement, pending/stale-answer,
lock/commit and offline guards remain unchanged. No protected display or bridge
file changed. Two new regression pins failed on the old implementation, then all
31 quote tests, 1,635 POS tests, seven built till journeys, full POS typecheck,
touched-file lint and build passed. Exact-source CI passed as well. OTO App and
migration steps were path-skipped; this is not a claim they were rerun.

## Path latency from this Bangkok machine

2026-11-02T13:53:19.723Z to 2026-11-02T13:55:16.713Z. Thirty samples for every
path/tool/mode, interleaved within this window; 360 calls, all HTTP 200.
First means a fresh process/browser context, not a forced restart of an always-on
service. Warm calls reuse their connection/context. Browser means real Edge.

| Tool / mode | Direct API p50 / p95, ms | Old POS p50 / p95, ms | New POS p50 / p95, ms | Added p50 / p95, ms |
| --- | ---: | ---: | ---: | ---: |
| curl, first | 126.8 / 204.5 | 559.4 / 628.4 | 124.0 / 190.4 | -2.8 / -14.1 |
| curl, warm | 59.7 / 69.5 | 482.7 / 541.2 | 61.0 / 73.0 | 1.3 / 3.5 |
| browser, first | 140.1 / 187.7 | 567.0 / 907.3 | 137.0 / 212.9 | -3.1 / 25.2 |
| browser, warm | 61.8 / 64.8 | 480.4 / 795.8 | 64.3 / 82.8 | 2.5 / 18.0 |

Added is new-path percentile minus the matching direct-API percentile, the same
definition used before deployment in the local overhead check. All four p50/p95
comparisons are under 50 ms. It is not a maximum for every internet request;
negative differences reflect network variation. All raw outliers are retained in
`s718-after-paths.json`. The original before-change matrix is retained in
[the main report](../s718-results.md).

## Stream opening

2026-11-02T13:55:17.270Z to 2026-11-02T13:56:53.077Z. Thirty samples per
path/tool. The old proxy has a three-second observation deadline; a missing frame
is reported as such, never as zero latency. The new stream is uncompressed.

| Path / tool | Opened | First frame p50 / p95, ms |
| --- | ---: | ---: |
| direct-api, curl | 30 / 30 | 153.6 / 198.5 |
| direct-api, browser | 30 / 30 | 81.7 / 94.0 |
| old-pos, curl | 0 / 30 | no frame / no frame |
| old-pos, browser | 0 / 30 | no frame / no frame |
| new-pos, curl | 30 / 30 | 155.8 / 194.3 |
| new-pos, browser | 30 / 30 | 82.2 / 99.3 |

## Native sign-in, item and cash journey

Old: **9023 ms**, 39 API calls, receipt Z718-000006.
New: **3351 ms**, 39 API calls, receipt Z718-000007.
Each used the same ZZ TEST virtual station, one item, a 9,000-satang synthetic
cash sale and exactly one finalise. Mutation counts match exactly. Count differences: GET /api/stations/:id/displays: old 3, new 2.
No payment gateway, SMS, real-person record or physical box was used.

Fresh page elapsed time: old 1724 ms, new
636 ms. Transferred asset bytes: old
697809, new
581284. The raw browser navigation and
resource timing, phases and call list are in the two journey JSON receipts.

## Display timing and recovery

Three independent fresh native browser runs, each without an added warm-up wait.
Both stream receipt and visible UI completion are below 500 ms in every run.
These are native action measurements, not a statistical display distribution.

| Run | Till to display: stream / visible, ms | Customer answer to till: stream / visible, ms |
| --- | ---: | ---: |
| 1 | 311 / 325 | 86 / 298 |
| 2 | 325 / 338 | 79 / 268 |
| 3 | 287 / 301 | 79 / 257 |

Each run also checks the ten-second reconnect grace, the twenty-second paused
screen hiding the total, automatic recovery, revocation and expiry of the next
unpaired code. Raw screenshots, network trace and receipt are in `display-1/`,
`display-2/` and `display-3/`. All test sessions signed out.

## Money, login, caller address and offline controls

Native login on both final paths returned the same host-only Secure HttpOnly
SameSite=Lax cookie. Foreign Origin is refused without CORS and preserves the
valid session. The original live caller test showed two forged addresses still
incremented the real caller's bucket twice, with zero forged or other buckets.
That receipt is retained from c2fdd28f: the relevant auth, forwarder and lane code
and ALLOWED_ORIGINS/HANDOFF_APP_ORIGINS/TRUST_PROXY_ADDRS fingerprints match this
release. The local actual-API test also exercised the 429 boundary. Staging was
not deliberately pushed into the shared sign-in lockout. No trust range was added.

The forwarder never retries a write. Only a bodyless GET reset on a reused socket,
before response headers, may retry once. Exact bytes, action/idempotency headers,
separate Set-Cookie headers, a slow connected write and disconnect cleanup are
pinned in the existing server/review tests. The earlier local 100-sample overhead
was 0.56/1.13 ms p50/p95, explicitly local.

The deployed installed shell opens `/today` offline; API fetch fails as a genuine
network failure and recovers online. Its cache contains nine shell entries and no
API responses. A native scan arrived once in 90 ms.
Static files are compressed, hashed assets cache long, index/worker do not cache;
missing hashed assets return 404 and traversal/hidden-file probes are refused.
The old site's HSTS and nosniff headers remain. Local tests pin API-down behavior
and the existing lane decision. No physical Pi or box offline-unlock proof is
claimed; staging lacks the offline sign-in key recorded by SCRUM-719.

## Starter capacity and cleanup

2026-11-02T13:57:31.090Z to 2026-11-02T14:00:01.311Z: 32 open streams plus
559 health reads over 150 seconds. All 32 streams closed.
Render samples at 30-second resolution measured peak CPU
0.0105/0.5 cores and memory
141.6/512.0 MiB:
97.9% CPU and 72.3% memory
headroom. This is a workload measurement, not a saturation or instantaneous peak
claim. Local repeated disconnect tests count zero remaining upstream connections;
Render does not expose that web-service count through its database-only connection
metric, so no staging upstream count is invented.

Independent cleanup found zero active paired displays, no test lease on either
station session route, sign-out 200 and `/me` 401. All seven exact synthetic cash
receipts remain as audit facts: Z718-000001, Z718-000002, Z718-000003, Z718-000004, Z718-000005, Z718-000006, Z718-000007.
No financial record was deleted, voided or replayed.

## Configuration, evidence and stop point

Only one Starter service was created, under the API owner in Singapore and the
specified project environment. Private DNS/API health from that service passed.
The only existing-service change was ALLOWED_ORIGINS through appendEnvList:
56 environment names before and after, every other value preserved. The current
57th name is BOX_AGENT_TEST_SLOT from SCRUM-717, not this lane. Relevant settings
were read back unchanged. Three source builds match the filter; documentation-only
landings did not rebuild. checksPass, Starter and one instance were read back.
During creation/API redeployment, the old address passed 466/466 probes; it also
passes the final comparison and native cash journey.

`s718-staging-proof.png` and `s710-staging-proof.png` are the final combined proof
cards. The matching JSON records the actual source/live commits, timing windows,
resource samples and acceptance assertions. The cards must be opened before
attachment and the required Deployed walks. Earlier failures remain available.

The [owner's forward and rollback checklist](../../../ops/POS_WEB_SWITCHOVER.md)
is complete. Staff, iPads, Pi configuration, launcher destination, old-site
settings and production remain unchanged. Switching devices is the owner's step.
