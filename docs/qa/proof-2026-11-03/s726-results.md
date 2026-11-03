# SCRUM-726 new POS load and soak

Recorded 2026-11-03T14:14:59.861Z. The new staging POS address was measured from this Bangkok machine. API and forwarder both ran **5069944660dfd43571d39f097aa90a77b1092c36**, [green CI 41556479254](https://github.com/vickyydev/oto-platform/actions/runs/41556479254). The small early-disconnect fix is source commit ba1b2fb4562dc4910b6b0472b890573dfa1a7a94; its local red/green test and full gates are in [stream-fix.md](s726/stream-fix.md) and [release-checks.json](s726/release-checks.json).

The assumed normal mix was six tills, six displays and two check-in boards, two band lookups per till/minute and one cash sale per till/two minutes. Device counts and rates are estimates. One till and its display, and every board, used native Edge 156.0.4314.58; additional tills used authenticated API calls, actual quotes and three streams through the same POS address. All stations shared one dedicated hosted test box and scans used a synthetic family. Repeated sales were a one-baht, stock-free F&B item; paid ticket/check-in creation occurred in setup, not on every iteration. Complex carts, stock writes and independent family arrivals are not represented. This does not establish real Pi, iPad, offline, electronic-payment, or many-physical-box capacity.

## Idle cost

| Case | Calls/min | Shared changed rows/min | p50 / p95 ms | Errors |
|---|---:|---:|---:|---:|
| background_hosted_agent | 0.00 | 183.67 | — / — | 0 |
| idle_till | 59.97 | 181.01 | 73.07 / 88.82 | 0 |
| idle_display | 0.00 | 217.60 | — / — | 0 |
| idle_pair | 63.33 | 226.92 | 74.27 / 92.56 | 0 |
| idle_board | 20.65 | 187.01 | 78.41 / 163.56 | 0 |
| idle_locked_till | 0.00 | 187.96 | — / — | 0 |

Database numbers count changed rows, not SQL statements; they include background work. The no-screen hosted-agent baseline is reported alongside the other cases, so they must not all be attributed to a browser. The normal two-minute lock is unchanged. Display presence is the largest repeated read and has a live connection/ownership consumer; no unused recurring request was identified. The small stream fix prevents a subscriber attaching after an early disconnect, without changing polling cadence. [Before and after idle detail](s726/idle-summary.md).

## Ramp and soak

| Phase | Seconds | Tills/displays/boards | Calls | p50 / p95 ms | Errors | Exact cash attempts |
|---|---:|---|---:|---:|---:|---:|
| ramp_1 | 180.30 | 1/1/1 | 275 | 79.56 / 140.10 | 0 | 2 |
| ramp_2 | 180.32 | 2/2/1 | 467 | 78.40 / 132.52 | 0 | 3 |
| ramp_4 | 180.77 | 4/4/2 | 935 | 76.52 / 131.32 | 0 | 6 |
| ramp_6 | 180.31 | 6/6/2 | 1337 | 75.31 / 128.87 | 0 | 9 |
| ramp_8 | 180.01 | 8/8/3 | 1803 | 73.53 / 116.16 | 0 | 12 |
| ramp_12 | 180.76 | 12/12/4 | 2674 | 74.37 / 121.58 | 0 | 18 |
| ramp_24 | 180.80 | 24/24/8 | 5368 | 76.76 / 151.67 | 0 | 36 |
| ramp_32 | 180.57 | 32/32/11 | 7177 | 79.63 / 150.02 | 0 | 48 |
| soak_2h | 7200.60 | 1/1/1 | 10952 | 76.92 / 162.08 | 0 | 60 |

The soak ran continuously from 2026-11-03T07:58:39.533Z to 2026-11-03T09:58:40.130Z: **7200.60 seconds**, 451 successful lease renewals and 60 independently reconciled cash sales. The first sample saw two station streams; every later sample saw three. The observed range was 2–3 and returned to zero after all clients closed. The shared API pool's maximum waiting count was 0. The native display samples and scripted sequence acknowledgements are retained separately; they are not interchangeable measurements. At six pairs the two native display samples were 463 and 359 ms. At 24 pairs one of the two samples was 553 ms; at 32 they were 377 and 354 ms. Thus this run does not establish sub-500-ms native updates at every tested load. The one-second workload stop line was not crossed. For the 60 native soak updates, p50 was 387.34 ms, p95 498.99 ms and the maximum 999.37 ms. This Bangkok machine reached 99.88% host CPU, with p95 72.53%; browser rendering timings include that local contention and cannot be attributed to the server alone. Native and scripted distributions are kept separately in analysis.json. [Every call's p50/p95 and error count](s726/per-call-latency.md).

| Phase | Resource | Peak CPU/allocation | Peak memory/allocation | Server streams | Working-DB connections | Render DB connections peak |
|---|---|---:|---|---:|---:|---:|
| ramp_1 | oto-api-staging | 6.82% | 362.42 MiB (17.70%) | 3–3 | 9–16 | — |
| ramp_1 | oto-pos-web-staging | 1.48% | 113.08 MiB (22.09%) | 3–3 | 9–16 | — |
| ramp_1 | oto-db-staging | 6.07% | 674.92 MiB (32.95%) | 3–3 | 9–16 | 16 |
| ramp_2 | oto-api-staging | 5.34% | 354.93 MiB (17.33%) | 6–6 | 9–16 | — |
| ramp_2 | oto-pos-web-staging | 1.20% | 111.68 MiB (21.81%) | 6–6 | 9–16 | — |
| ramp_2 | oto-db-staging | 9.76% | 677.85 MiB (33.10%) | 6–6 | 9–16 | 16 |
| ramp_4 | oto-api-staging | 8.99% | 362.18 MiB (17.68%) | 12–12 | 9–14 | — |
| ramp_4 | oto-pos-web-staging | 1.85% | 114.37 MiB (22.34%) | 12–12 | 9–14 | — |
| ramp_4 | oto-db-staging | 9.38% | 663.28 MiB (32.39%) | 12–12 | 9–14 | 14 |
| ramp_6 | oto-api-staging | 10.52% | 368.13 MiB (17.98%) | 18–18 | 9–15 | — |
| ramp_6 | oto-pos-web-staging | 1.95% | 114.34 MiB (22.33%) | 18–18 | 9–15 | — |
| ramp_6 | oto-db-staging | 10.50% | 677.93 MiB (33.10%) | 18–18 | 9–15 | 15 |
| ramp_8 | oto-api-staging | 11.16% | 409.54 MiB (20.00%) | 24–24 | 9–16 | — |
| ramp_8 | oto-pos-web-staging | 2.58% | 113.37 MiB (22.14%) | 24–24 | 9–16 | — |
| ramp_8 | oto-db-staging | 15.71% | 691.36 MiB (33.76%) | 24–24 | 9–16 | 16 |
| ramp_12 | oto-api-staging | 18.83% | 414.23 MiB (20.23%) | 36–36 | 10–16 | — |
| ramp_12 | oto-pos-web-staging | 3.10% | 114.85 MiB (22.43%) | 36–36 | 10–16 | — |
| ramp_12 | oto-db-staging | 20.29% | 684.76 MiB (33.44%) | 36–36 | 10–16 | 16 |
| ramp_24 | oto-api-staging | 27.55% | 419.04 MiB (20.46%) | 72–72 | 15–16 | — |
| ramp_24 | oto-pos-web-staging | 5.31% | 116.43 MiB (22.74%) | 72–72 | 15–16 | — |
| ramp_24 | oto-db-staging | 36.31% | 735.05 MiB (35.89%) | 72–72 | 15–16 | 16 |
| ramp_32 | oto-api-staging | 33.30% | 425.92 MiB (20.80%) | 96–96 | 15–16 | — |
| ramp_32 | oto-pos-web-staging | 7.31% | 117.26 MiB (22.90%) | 96–96 | 15–16 | — |
| ramp_32 | oto-db-staging | 50.60% | 725.94 MiB (35.45%) | 96–96 | 15–16 | 16 |
| soak_2h | oto-api-staging | 8.11% | 368.62 MiB (18.00%) | 2–3 | 8–17 | — |
| soak_2h | oto-pos-web-staging | 1.00% | 108.19 MiB (21.13%) | 2–3 | 8–17 | — |
| soak_2h | oto-db-staging | 8.30% | 684.49 MiB (33.42%) | 2–3 | 8–17 | 16 |

Resource samples are roughly 30 seconds apart; the read-only DB monitor sampled every 15 seconds. Render and current-database connection counts cover different scopes. The raw sample windows, estimated mix, client CPU/event-loop data and stop checks remain in [analysis.json](s726/analysis.json) and [load-results.json](s726/load-results.json).

## Long-run memory

| Resource | First 20 min mean MiB | Last 20 min mean MiB | Change MiB | Linear trend MiB/hour |
|---|---:|---:|---:|---:|
| oto-api-staging | 347.03 | 347.53 | 0.50 | -0.76 |
| oto-pos-web-staging | 106.53 | 102.14 | -4.39 | -3.12 |
| oto-db-staging | 656.98 | 638.85 | -18.13 | -10.17 |

The API first/last twenty-minute means changed by 0.50 MiB, and the forwarder by -4.39 MiB. Both stayed bounded with no sustained upward memory trend over the measured two hours.

See [the full two-hour trend image](s726/s726-soak-trends.png), with stream/connection counts and lease renewal beside memory and CPU. Interpret sampled RSS after the ramp as an operating trend, not proof that every internal allocation is constant.

## Bend, limit and sizing

No read-latency bend reached the declared threshold within the completed 32-pair ceiling. The p95 rose from 122 ms at 12 pairs to 152 ms at 24, then held at 150 ms at 32. At 32, the API database pool briefly had two waiting requests; database CPU reached 50.6%, API 33.3% and forwarder 7.3%. This points to the database/pool as the first observed pressure, not a proven ultimate limit. This is a bounded result, not a measured failure point.

The forwarder shares a pool of 128 sockets between GET/HEAD/OPTIONS requests (apps/pos/server/server.ts). Each active pair used three long streams. The run was capped at 32 pairs / 96 streams to leave 32 sockets for ordinary reads; 48 pairs would require 144 streams alone. This ceiling is calculated from the configured pool, not an observed failure. The 32-pair cap replaced the initial 48-pair proposal before busy testing. More CPU or memory alone does not enlarge that pool. Writes use their existing separate connection behavior.

For the estimated six-till/six-display/two-board demand, the measured starting sizes are the existing forwarder Starter, API Standard and database 1c-2g. That step passed 1337 calls at p95 128.87 ms with zero errors. Across measured steps and soak, peak CPU/memory against allocation were forwarder 7.31%/22.90%, API 33.30%/20.80%, and database 50.60%/35.89%. Final sizing requires the actual park device count and arrival rate; these are estimates, and this run is not a high-availability or failover test. Keep a conservative operating budget below the largest clean step and the stream-pool ceiling. No plan, size or service was changed. The largest 32-pair step lasted three minutes; the two-hour soak covered one pair and one board.

## Safety, exactness and cleanup

All data was prefixed ZZ TEST and every payment was synthetic cash. Each attempted workload sale has one finalised sale and one approved cash attempt; native finalise requests were sent once. The cumulative independent read checked 238 cash sales, including setup and earlier diagnostic receipts, and the one known unpaid diagnostic void separately. No unknown sale was found. No POST/PATCH/DELETE retry was introduced.

The first two-hour soak stopped after about nine minutes on a Render deployment-metadata fetch failure. A later setup stopped before workload sales on other staging sessions. A further soak stopped after 494 calls with zero application errors because a monitoring response body could not be read after HTTP 200. Its three cash sales were reconciled and its streams closed. A later 2,419-second run stopped when the Windows client lost Wi-Fi for about eighteen minutes; both POS and Render requests then failed DNS resolution. Its 21 cash sales were independently reconciled after reconnection and its interrupted cleanup was completed. These partial intervals remain preserved and are excluded from the completed two-hour interval. The resumed soak required a five-minute quiet check and retained every original stop guard.

The first busy attempt on the older source stopped on harness selectors; it exposed the early-disconnect subscriber leak, which was fixed with real-socket red/green pins, full gates, exact-source CI and native staging rechecks. A later setup stopped before load on an unavailable Render monitoring result; the test child was checked out and streams closed. That receipt is retained. Only read-only monitoring GETs gained bounded retries for network/429/5xx and response-body read failures; missing fresh samples still stop. A second rehearsal exposed an active-tab selector error and incomplete display-pairing warm-up; three repeated cash orders passed after correcting the harness. Batched resource reads and a 20-second monitoring cache reduced calls under the observed quota without changing any resource stop line. See [measurement-harness-corrections.md](s726/measurement-harness-corrections.md).

Independent cleanup job-dbkum4rncjis73fd52ig confirms 43 archived stations, the exact box disabled/archived, product/category retired, zero active test credentials/sessions, all children out with one release each, and no queued/failed print jobs or box-queue rows. All three simulated printer records were also archived and read back. The preserved print history contains 474 printed jobs and two exact skipped jobs from 01:31 UTC, before the successful measured ramp/soak. Both were the first receipt/kitchen jobs for the second newly configured till and reported NO_DEVICE_FOR_ROLE; the creation request included printer assignments. [SCRUM-737](https://oto-suite-dev.atlassian.net/browse/SCRUM-737) records that observed first-sale problem; a configuration-refresh race remains a hypothesis. No historical print status was rewritten. The first full cleanup read-only job failed on Render without returning a result; its larger serialized input was reduced to the exact fields each assertion uses, and the complete independent readback was repeated. No cleanup write or sale was retried. Cash audit and synthetic consent/photo records remain for traceability. BOX_AGENT_TEST_SLOT was removed through its single-key endpoint: **58 to 57 setting names**, every remaining value byte-identical. The same-source restart dep-dbkumptg1s2s73dqokng is live and health/readiness passed at 2026-11-03T14:14:30.972Z. No park device, real person, SMS, Render size/plan or production setting was touched.

Live service receipts: [live-commits.json](s726/live-commits.json). Cleanup: [database-cleanup.json](s726/database-cleanup.json), [env-restore.json](s726/env-restore.json). Images: s726-staging-proof.png, s726-soak-trends.png, s726-native-till.png and s726-native-display.png. Image inspection, attachments and Jira status are recorded separately after generation.
