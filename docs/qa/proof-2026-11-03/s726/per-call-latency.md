# SCRUM-726 per-call latency

Times are milliseconds from this Bangkok machine through the new POS address. Native browser calls include response-body completion; scripted calls include JSON receipt. Quantiles are nearest rank. Stream rows measure opening, not lifetime. Monitoring calls are excluded from request rates.

## background_hosted_agent

2026-11-03T01:32:32.525Z to 2026-11-03T01:35:33.319Z (180.794 seconds).

| Call | Samples | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|

## idle_till

2026-11-03T01:36:06.266Z to 2026-11-03T01:39:06.370Z (180.104 seconds).

| Call | Samples | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| GET /stations/:id/displays | 115 | 0 | 71.87 | 80.20 |
| GET /branches/:id/occupancy | 35 | 0 | 76.17 | 91.97 |
| GET /stations/:id/printers | 6 | 0 | 73.52 | 88.82 |
| GET /me/station/link | 9 | 0 | 75.89 | 113.31 |
| GET /kiosk-desk | 9 | 0 | 72.66 | 75.99 |
| GET /branches/:id/pricing-mode | 3 | 0 | 88.66 | 90.42 |
| GET /checkin/board | 3 | 0 | 108.58 | 130.39 |

## idle_display

2026-11-03T01:39:39.229Z to 2026-11-03T01:42:39.444Z (180.215 seconds).

| Call | Samples | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|

## idle_pair

2026-11-03T01:43:15.112Z to 2026-11-03T01:46:16.078Z (180.966 seconds).

| Call | Samples | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| GET /branches/:id/occupancy | 36 | 0 | 76.80 | 85.84 |
| GET /stations/:id/displays | 114 | 0 | 72.45 | 88.38 |
| GET /stations/:id/printers | 6 | 0 | 79.06 | 80.99 |
| POST /box/v1/station/:id/lease/renew | 11 | 0 | 85.69 | 110.83 |
| GET /me/station/link | 9 | 0 | 73.21 | 84.07 |
| GET /kiosk-desk | 9 | 0 | 71.60 | 86.69 |
| GET /branches/:id/pricing-mode | 3 | 0 | 79.31 | 79.53 |
| GET /checkin/board | 3 | 0 | 100.24 | 105.72 |

## idle_board

2026-11-03T01:46:50.804Z to 2026-11-03T01:49:50.992Z (180.188 seconds).

| Call | Samples | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| GET /branches/:id/occupancy | 35 | 0 | 78.55 | 124.03 |
| GET /stations/:id/printers | 6 | 0 | 76.54 | 95.81 |
| GET /checkin/board | 9 | 0 | 106.52 | 196.87 |
| GET /me/station/link | 9 | 0 | 72.66 | 101.17 |
| GET /branches/:id/pricing-mode | 3 | 0 | 74.63 | 76.68 |

## idle_locked_till

2026-11-03T01:52:35.066Z to 2026-11-03T01:55:35.858Z (180.792 seconds).

| Call | Samples | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|

## ramp_1

2026-11-03T02:18:58.897Z to 2026-11-03T02:21:59.201Z (180.304 seconds).

| Call | Samples | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| GET /wallets/scan | 6 | 0 | 133.43 | 143.83 |
| GET /stations/:id/displays | 113 | 0 | 77.67 | 90.07 |
| GET /branches/:id/occupancy | 71 | 0 | 79.36 | 96.80 |
| GET /stations/:id/channel [stream open] | 1 | 0 | 93.55 | 93.55 |
| GET /me/station/link | 18 | 0 | 75.94 | 94.78 |
| GET /branches/:id/pricing-mode | 6 | 0 | 78.56 | 94.81 |
| GET /ops/demo-reset | 1 | 0 | 94.65 | 94.65 |
| GET /stations/:id/printers | 12 | 0 | 79.05 | 104.72 |
| POST /box/v1/station/:id/lease/release | 1 | 0 | 95.59 | 95.59 |
| GET /box/v1/station/:id/channel [stream open] | 1 | 0 | 86.43 | 86.43 |
| POST /box/v1/station/:id/lease | 1 | 0 | 91.71 | 91.71 |
| POST /sales/quote | 2 | 0 | 81.93 | 122.01 |
| POST /box/v1/station/:id/intents | 14 | 0 | 97.60 | 140.85 |
| POST /sales | 2 | 0 | 151.53 | 208.50 |
| POST /sales/:id/finalise | 2 | 0 | 179.18 | 210.01 |
| GET /branches/:id/stock/sellable | 2 | 0 | 83.11 | 100.60 |
| GET /sales/:id | 2 | 0 | 113.89 | 114.62 |
| GET /checkin/board | 9 | 0 | 112.28 | 287.17 |
| POST /box/v1/station/:id/lease/renew | 11 | 0 | 90.12 | 114.87 |

## ramp_2

2026-11-03T02:22:50.581Z to 2026-11-03T02:25:50.903Z (180.322 seconds).

| Call | Samples | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| GET /wallets/scan | 12 | 0 | 81.35 | 132.52 |
| GET /stations/:id/displays | 222 | 0 | 76.44 | 88.36 |
| POST /box/v1/station/:id/intents | 17 | 0 | 91.91 | 127.96 |
| GET /branches/:id/occupancy | 105 | 0 | 79.75 | 103.17 |
| POST /sales/quote | 3 | 0 | 93.53 | 152.81 |
| GET /me/station/link | 27 | 0 | 74.98 | 96.58 |
| POST /sales | 3 | 0 | 107.50 | 186.93 |
| POST /sales/:id/finalise | 3 | 0 | 148.58 | 248.87 |
| GET /branches/:id/stock/sellable | 2 | 0 | 83.06 | 96.12 |
| GET /sales/:id | 2 | 0 | 96.11 | 99.96 |
| POST /box/v1/station/:id/lease/renew | 23 | 0 | 88.94 | 149.69 |
| GET /branches/:id/pricing-mode | 9 | 0 | 85.23 | 128.14 |
| GET /stations/:id/printers | 18 | 0 | 80.91 | 133.05 |
| GET /kiosk-desk | 9 | 0 | 121.48 | 134.21 |
| GET /checkin/board | 12 | 0 | 115.62 | 211.74 |

## ramp_4

2026-11-03T02:26:41.721Z to 2026-11-03T02:29:42.492Z (180.771 seconds).

| Call | Samples | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| GET /stations/:id/displays | 445 | 0 | 73.62 | 91.00 |
| GET /wallets/scan | 24 | 0 | 80.43 | 131.32 |
| POST /box/v1/station/:id/lease/renew | 48 | 0 | 87.54 | 115.53 |
| POST /box/v1/station/:id/intents | 26 | 0 | 87.99 | 104.25 |
| GET /branches/:id/occupancy | 208 | 0 | 77.69 | 123.83 |
| POST /sales/quote | 6 | 0 | 85.71 | 91.36 |
| POST /sales | 6 | 0 | 102.48 | 125.04 |
| POST /sales/:id/finalise | 6 | 0 | 144.22 | 307.59 |
| GET /branches/:id/stock/sellable | 2 | 0 | 80.92 | 86.05 |
| GET /sales/:id | 2 | 0 | 89.39 | 97.50 |
| GET /stations/:id/printers | 36 | 0 | 80.35 | 135.07 |
| GET /checkin/board | 27 | 0 | 101.71 | 181.01 |
| GET /me/station/link | 54 | 0 | 74.58 | 123.72 |
| GET /kiosk-desk | 27 | 0 | 78.04 | 155.37 |
| GET /branches/:id/pricing-mode | 18 | 0 | 77.64 | 163.20 |

## ramp_6

2026-11-03T02:30:45.823Z to 2026-11-03T02:33:46.136Z (180.313 seconds).

| Call | Samples | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| GET /stations/:id/displays | 666 | 0 | 72.78 | 94.36 |
| GET /wallets/scan | 36 | 0 | 79.82 | 140.56 |
| GET /branches/:id/occupancy | 276 | 0 | 76.88 | 105.80 |
| POST /box/v1/station/:id/intents | 35 | 0 | 89.33 | 242.79 |
| POST /sales/quote | 9 | 0 | 88.40 | 120.35 |
| POST /box/v1/station/:id/lease/renew | 71 | 0 | 86.04 | 145.82 |
| POST /sales | 9 | 0 | 102.43 | 270.66 |
| POST /sales/:id/finalise | 9 | 0 | 138.39 | 159.23 |
| GET /branches/:id/stock/sellable | 2 | 0 | 92.70 | 92.73 |
| GET /sales/:id | 2 | 0 | 108.04 | 109.06 |
| GET /me/station/link | 72 | 0 | 73.62 | 87.59 |
| GET /kiosk-desk | 45 | 0 | 75.53 | 123.13 |
| GET /stations/:id/printers | 48 | 0 | 78.35 | 135.59 |
| GET /branches/:id/pricing-mode | 24 | 0 | 80.32 | 129.96 |
| GET /checkin/board | 33 | 0 | 101.78 | 186.88 |

## ramp_8

2026-11-03T02:34:42.407Z to 2026-11-03T02:37:42.419Z (180.012 seconds).

| Call | Samples | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| GET /wallets/scan | 48 | 0 | 76.46 | 133.23 |
| GET /stations/:id/displays | 887 | 0 | 71.39 | 85.92 |
| GET /branches/:id/occupancy | 380 | 0 | 75.12 | 107.44 |
| POST /box/v1/station/:id/intents | 44 | 0 | 84.41 | 97.63 |
| POST /sales/quote | 12 | 0 | 86.37 | 333.70 |
| POST /sales | 12 | 0 | 97.73 | 274.03 |
| POST /sales/:id/finalise | 12 | 0 | 133.13 | 246.41 |
| GET /branches/:id/stock/sellable | 2 | 0 | 74.55 | 83.39 |
| GET /sales/:id | 2 | 0 | 85.80 | 97.54 |
| GET /kiosk-desk | 63 | 0 | 73.52 | 90.79 |
| GET /me/station/link | 99 | 0 | 71.28 | 88.82 |
| GET /stations/:id/printers | 66 | 0 | 74.37 | 129.27 |
| GET /checkin/board | 48 | 0 | 90.08 | 173.37 |
| POST /box/v1/station/:id/lease/renew | 95 | 0 | 84.21 | 104.87 |
| GET /branches/:id/pricing-mode | 33 | 0 | 74.67 | 123.69 |

## ramp_12

2026-11-03T02:38:53.236Z to 2026-11-03T02:41:53.999Z (180.763 seconds).

| Call | Samples | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| GET /wallets/scan | 72 | 0 | 79.75 | 134.39 |
| GET /branches/:id/occupancy | 553 | 0 | 75.93 | 110.26 |
| GET /stations/:id/displays | 1330 | 0 | 72.14 | 90.11 |
| POST /box/v1/station/:id/lease/renew | 143 | 0 | 84.73 | 151.58 |
| POST /box/v1/station/:id/intents | 62 | 0 | 85.40 | 106.57 |
| POST /sales/quote | 18 | 0 | 90.48 | 105.05 |
| POST /sales | 18 | 0 | 101.27 | 152.07 |
| GET /me/station/link | 144 | 0 | 73.12 | 105.76 |
| GET /kiosk-desk | 99 | 0 | 72.64 | 134.96 |
| POST /sales/:id/finalise | 18 | 0 | 139.10 | 290.63 |
| GET /branches/:id/stock/sellable | 2 | 0 | 76.48 | 83.51 |
| GET /sales/:id | 2 | 0 | 89.85 | 96.47 |
| GET /stations/:id/printers | 96 | 0 | 77.62 | 132.77 |
| GET /checkin/board | 69 | 0 | 88.16 | 173.78 |
| GET /branches/:id/pricing-mode | 48 | 0 | 74.63 | 119.85 |

## ramp_24

2026-11-03T02:43:16.420Z to 2026-11-03T02:46:17.216Z (180.796 seconds).

| Call | Samples | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| GET /wallets/scan | 144 | 0 | 86.36 | 168.15 |
| GET /stations/:id/displays | 2661 | 0 | 73.96 | 112.83 |
| GET /branches/:id/occupancy | 1104 | 0 | 76.94 | 113.92 |
| POST /box/v1/station/:id/lease/renew | 289 | 0 | 84.99 | 179.12 |
| GET /kiosk-desk | 206 | 0 | 76.89 | 128.56 |
| GET /me/station/link | 287 | 0 | 74.10 | 143.58 |
| POST /box/v1/station/:id/intents | 116 | 0 | 86.35 | 249.43 |
| POST /sales/quote | 36 | 0 | 90.33 | 202.24 |
| GET /stations/:id/printers | 192 | 0 | 82.77 | 167.04 |
| POST /sales | 36 | 0 | 127.46 | 404.85 |
| POST /sales/:id/finalise | 36 | 0 | 150.85 | 296.57 |
| GET /branches/:id/stock/sellable | 2 | 0 | 78.82 | 82.06 |
| GET /sales/:id | 2 | 0 | 91.07 | 115.17 |
| GET /branches/:id/pricing-mode | 96 | 0 | 77.87 | 150.72 |
| GET /checkin/board | 141 | 0 | 94.25 | 246.21 |
| GET /files/:id/url | 20 | 0 | 90.29 | 101.38 |

## ramp_32

2026-11-03T02:47:34.244Z to 2026-11-03T02:50:34.817Z (180.573 seconds).

| Call | Samples | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| POST /box/v1/station/:id/lease/renew | 384 | 0 | 85.45 | 157.90 |
| GET /branches/:id/occupancy | 1481 | 0 | 78.91 | 129.90 |
| GET /stations/:id/displays | 3547 | 0 | 77.03 | 127.81 |
| GET /wallets/scan | 192 | 0 | 88.41 | 180.44 |
| GET /kiosk-desk | 278 | 0 | 79.19 | 136.57 |
| GET /me/station/link | 386 | 0 | 76.46 | 148.51 |
| GET /stations/:id/printers | 258 | 0 | 82.08 | 163.50 |
| POST /box/v1/station/:id/intents | 152 | 0 | 85.18 | 106.33 |
| POST /sales/quote | 48 | 0 | 96.72 | 226.77 |
| POST /sales | 48 | 0 | 107.11 | 142.02 |
| GET /branches/:id/pricing-mode | 129 | 0 | 81.12 | 185.33 |
| GET /checkin/board | 192 | 0 | 99.83 | 278.98 |
| POST /sales/:id/finalise | 48 | 0 | 133.83 | 200.02 |
| GET /branches/:id/stock/sellable | 2 | 0 | 75.85 | 90.28 |
| GET /sales/:id | 2 | 0 | 89.79 | 105.82 |
| GET /files/:id/url | 30 | 0 | 130.97 | 138.80 |

## soak_2h

2026-11-03T07:58:39.533Z to 2026-11-03T09:58:40.130Z (7200.597 seconds).

| Call | Samples | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| GET /wallets/scan | 240 | 0 | 142.59 | 206.14 |
| GET /stations/:id/displays | 4487 | 0 | 73.20 | 103.43 |
| GET /branches/:id/pricing-mode | 240 | 0 | 77.74 | 103.76 |
| GET /ops/demo-reset | 1 | 0 | 71.16 | 71.16 |
| GET /me/station/link | 720 | 0 | 74.81 | 95.54 |
| GET /stations/:id/channel [stream open] | 1 | 0 | 78.88 | 78.88 |
| GET /branches/:id/occupancy | 2829 | 0 | 77.63 | 109.69 |
| GET /stations/:id/printers | 480 | 0 | 78.07 | 105.67 |
| POST /box/v1/station/:id/lease/release | 1 | 0 | 96.94 | 96.94 |
| GET /box/v1/station/:id/channel [stream open] | 1 | 0 | 107.68 | 107.68 |
| POST /box/v1/station/:id/lease | 1 | 0 | 168.30 | 168.30 |
| POST /box/v1/station/:id/intents | 420 | 0 | 87.14 | 149.25 |
| POST /sales/quote | 60 | 0 | 86.51 | 141.00 |
| POST /sales | 60 | 0 | 102.10 | 137.53 |
| POST /sales/:id/finalise | 60 | 0 | 147.71 | 260.74 |
| GET /branches/:id/stock/sellable | 60 | 0 | 83.16 | 112.41 |
| GET /sales/:id | 60 | 0 | 98.72 | 160.44 |
| GET /checkin/board | 360 | 0 | 99.44 | 220.69 |
| POST /box/v1/station/:id/lease/renew | 451 | 0 | 85.26 | 129.25 |
| GET /files/:id/url | 420 | 0 | 193.82 | 289.26 |
