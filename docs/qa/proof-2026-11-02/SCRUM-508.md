# SCRUM-508: Today Performance party proof

Source: `8417b72005ff7df668df66dbc81cf6b4315ab506`. [All six CI jobs passed](https://github.com/vickyydev/oto-platform/actions/runs/41364323533); the eight-case party review ran in API shard 3. API and POS were both live on this exact commit before capture.

The [inspected proof card](scrum-508-party-performance-proof.png) includes the [native Today Performance screenshot](scrum-508-performance.png). At 2026-11-02T00:26:25.951Z, the verified Till 2 (test) session showed Parties today **1**, up from **0**, after creating only `ZZ TEST SCRUM-508 Performance 2026-11-02T00:24:10.884Z` through the OTO App. Its ID, deployment timestamps and live summary values are in [the proof record](scrum-508-party-proof.json).

The staging party was unpaid: no charge, payment, SMS or hardware action was created. The local regression used the real party endpoints: an F&B charge and a payment made the count 1, party takings 25,000 satang and transaction count 1. The sales-only implementation failed the count, money and hourly assertions before the fix. All 79 targeted checks passed, with clean API typecheck and touched-file lint. The eight review cases also cover earlier payments, future parties, camps, unpaid/cancelled/archived parties, confirmed date changes, branch isolation, cancelled tenders and repeat rollups. Q3 timing remains unchanged.

The exact test event was archived at 2026-11-02T00:27:16.751Z; the event list no longer contains it. At 2026-11-02T00:30:42.460Z, a fresh signed-in check confirmed the summary returned to its original count **0**, with zero party takings and transactions. Every proof session was signed out successfully. The first capture attempts stopped before creating any event: the proof script needed the native station picker and the current session-context response. An idle lock during cleanup waiting was resolved by signing in again; no lock policy changed.

The existing box-offline and stock banners in the screenshot were left intact. This proof certifies the party reporting correction, not hardware health.
