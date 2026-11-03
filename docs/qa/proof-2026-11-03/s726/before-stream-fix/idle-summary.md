# SCRUM-726 idle baseline

Completed 2026-11-02T23:41:08.484Z. API and new POS source 7a00aa1ce44af50622d3cde0bd5e84f80607c2a6, CI 41532107227. Native Edge 156.0.4314.58; every screen measured separately after warm-up. The existing two-minute lock is unchanged.

| Case | Seconds | Requests/min | Shared DB row changes/min | p50 ms | p95 ms | Errors | Server streams |
|---|---:|---:|---:|---:|---:|---:|---:|
| background_hosted_agent | 196.5 | 0.00 | 200.81 | no calls | no calls | 0 | 0-0 |
| idle_till | 180.3 | 60.58 | 198.98 | 74.3 | 88.5 | 0 | 1-1 |
| idle_display | 180.6 | 0.00 | 196.00 | no calls | no calls | 0 | 1-1 |
| idle_pair | 180.1 | 63.63 | 210.30 | 75.6 | 101.4 | 0 | 3-3 |
| idle_board | 197.2 | 21.00 | 188.25 | 78.3 | 141.2 | 0 | 0-0 |
| idle_locked_till | 181.4 | 0.00 | 202.20 | no calls | no calls | 0 | 0-0 |

Database figures count inserted, updated and deleted rows across the shared schemas, not SQL calls. They include the hosted agent and existing background work. The no-screen hosted-agent baseline was 200.81 row changes/min; variation around it must not be attributed wholly to one browser. Exact table deltas are retained in each phase receipt.

The raw idle client debug tally did not subtract closed browser contexts. The independently sampled server count is authoritative here: 1 till, 1 display, 3 paired, 0 board and 0 locked. The client tally was corrected before the ramp; no product code changed.

The till's largest read is display presence: 116 calls in 180.259 seconds (38.61/min). It drives the paired/connected indicator and decides when to acquire a publisher lease. Other recurring reads feed occupancy, printer/link state, kiosk requests, pricing mode and check-in counts. No request without a live consumer was identified. Removing the presence poll would require an equivalent presence signal and preserved disconnect/revocation behavior; it is not silently removed for this measurement.

No cash sale or load step is included in this baseline.
