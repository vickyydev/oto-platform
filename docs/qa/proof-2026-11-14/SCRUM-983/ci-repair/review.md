# CI response-contract repair

Exact source7455 failed the complete party-deposit check because its response assertion still expected only success:true. The approved parent receipt now also returns the saved timestamp. The same complete file reproduced the failure locally.

The repair keeps an exact response assertion and binds submittedAt to the persisted row with explicit UTC interpretation, then retains every once-only platform notification, idempotency header/body, kitchen-plan and replay assertion. The whole file now passes all8 checks; touched lint adds no diagnostics. Product source is unchanged, and prior native/PDF proof and exact cleanup remain valid. The original CI failure and local red/green are preserved. Independent review precedes the normal push; CI remains background only.
