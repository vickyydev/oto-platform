# SCRUM-819 display pairing proof

Prepared, not yet run. No staging fixture has been created for this unit.

Run `node docs/qa/proof-2026-11-11/SCRUM-819/staging/proof.mjs <full-landed-sha>`
from the display lane after the named API deployment is live and main is not red.
The harness records the exact API, Console and till versions before and after.

The browser pairs a new ZZ TEST display through Console. Its first protected
request is briefly held so the pairing timestamp and first sighting can be read
independently. Console Health is then refreshed every 30 seconds for ten real
minutes, with the display connected. Closing that browser begins the real
silence check: one alert must appear and keep the same ID on the next sweep.
No service setting, opening hour or park screen is changed.

The native pictures mask unrelated rows, sign-in fields and pairing codes. A
labelled test-run card describes the elapsed observation. Delivery of the alert
notification is verified by the integration review; this staging screen proof
checks the alert row and does not claim an external notification was received.

The receipt holds IDs, HTTP statuses, presence readings and own alert IDs only.
Cleanup verifies the exact new till before revoking its display and archiving
the till, waits for its alert to close, signs out and reads back 401. Any failed
attempt and cleanup failure must be preserved before another run.
