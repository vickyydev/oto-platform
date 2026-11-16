# SCRUM-908 independent source review

Approved 16 November 2026 by the assigned independent source reviewer after read-only inspection. The reviewer ran no test, build or browser. Exact file fingerprints are retained in validation.json.

The initial P2 finding was that already-sent sandbox notices could fill the escalation batch and starve ordinary overdue conversations. The final correlated, tenant-fenced NOT EXISTS excludes the exact sandbox sender before grouping and LIMIT. A 28-notice / 27-turn historical fixture now checks the real overdue control and preserves original sent facts.

The sandbox guard uses the canonical test-line predicate plus the exact Twilio sandbox sender, with queue, old pending delivery and escalation execution boundaries. The non-sandbox Twilio control requeues under its actual provider, not only under the simulator. The refresh path covers an empty selected test-line inbox and a selected test chat reached through All or General, pauses hidden-tab requests, and shares one fast timer with the simulator. No other actionable source finding remained.

Initial new-review failures were test-fixture setup errors: missing known KB/advice setup, then the unique sender collision and cross-case pending-notice contamination. They were corrected without weakening the assertions; retained attempt logs are not acceptance. Final API batch: 33/33.
