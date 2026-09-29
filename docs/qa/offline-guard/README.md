# SCRUM-285 staging acceptance

29 September 2026. Tested source 88140af is live on API, POS, Console,
Launcher and Booth after an explicitly authorised manual Render deployment.
GitHub Actions billing still prevents jobs starting; this is not green CI.

All 11 staging API checks pass. A selected forced-offline virtual station
refuses lookup, terminal start and cash collection before idempotency replay.
Reporting, unbound Console administration, another box and recovery remain
available. Reconnect accepts the original cash gesture once; a later offline
request refuses even its cached success; the next online request replays the
same result. The virtual box was restored online and both dedicated stations
were archived. The physical booth and historical partial payment are untouched.

Reviewed test-run card: SCRUM-285-staging-offline-guard.png, Jira attachment
10905. It records real staging endpoint checks, not native UI acceptance.
The API checks cannot be shown together by one product screen.

The first run passed its first ten checks but used order-sensitive JSON text
comparison for the cached response. The corrected run uses deep equality and
passes. Its earlier completed simulated cash sale remains in audit history,
as does the successful rerun sale; no bank or physical payment occurred. Both
runs restored the box and archived only their own stations.

The current offline capability matrix is in docs/architecture/ARCHITECTURE.md.
This defect closes the cloud-test guard, not SCRUM-269 local till transport or
full offline cash/card acceptance under SCRUM-206. Pi bootstrap was separately
implemented and bench-tested earlier; this ticket's original absence is stale.
