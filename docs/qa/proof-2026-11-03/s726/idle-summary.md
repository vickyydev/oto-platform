# SCRUM-726 idle remeasurement

Completed 2026-11-03T01:55:43.926Z. API and new POS: 5069944660dfd43571d39f097aa90a77b1092c36; green CI 41556479254. Native Edge 156.0.4314.58. Each case ran separately for at least three minutes after warm-up. The ordinary two-minute lock is unchanged.

| Case | Seconds | Requests/min | Shared DB row changes/min | p50 ms | p95 ms | Errors | Server streams |
|---|---:|---:|---:|---:|---:|---:|---:|
| background_hosted_agent | 180.79 | 0.00 | 183.67 | no calls | no calls | 0 | 0-0 |
| idle_till | 180.10 | 59.97 | 181.01 | 73.07 | 88.82 | 0 | 1-1 |
| idle_display | 180.22 | 0.00 | 217.60 | no calls | no calls | 0 | 1-1 |
| idle_pair | 180.97 | 63.33 | 226.92 | 74.27 | 92.56 | 0 | 3-3 |
| idle_board | 180.19 | 20.65 | 187.01 | 78.41 | 163.56 | 0 | 0-0 |
| idle_locked_till | 180.79 | 0.00 | 187.96 | no calls | no calls | 0 | 0-0 |

The shared database counters count changed rows, not SQL statements or browser-attributable writes. They include the hosted agent and existing background activity. The no-screen hosted-agent background was 183.67 row changes/minute. Exact database snapshot intervals and table deltas remain in each phase receipt.

| Case | Before fix, calls/min | After fix, calls/min |
|---|---:|---:|
| idle_till | 60.58 | 59.97 |
| idle_display | 0.00 | 0.00 |
| idle_pair | 63.63 | 63.33 |
| idle_board | 21.00 | 20.65 |
| idle_locked_till | 0.00 | 0.00 |

Before-fix source 7a00aa1ce44af50622d3cde0bd5e84f80607c2a6 and its raw data remain in before-stream-fix. The runtime change prevents a subscriber being attached after its browser already disconnected; it does not change polling cadence. The earlier client debug-count issue is recorded with the old data. In this remeasurement, the board debug tally retained one request from its old document, while the independently sampled server count stayed at zero. The browser accounting is corrected before the ramp; server counts remain authoritative throughout. The raw measurements are retained unchanged.

The largest recurring read remains display presence: 115 responses in 180.10 seconds (38.31/minute). It drives connection state and publisher ownership. Other repeated reads feed occupancy, printer/link status, kiosk requests, pricing mode and check-in counts. No read without a live consumer was identified. Removing presence polling requires a replacement presence signal that preserves disconnect and revocation behavior.

No cash journey is included in these idle intervals. The separate native/scripted smoke checks and their cash reconciliation are in mixed-smoke.json. The busy ramp and two-hour soak are separate measurements.
