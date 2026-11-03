# SCRUM-727 review candidate: local evidence

This is local evidence for product source `0f400710d05b0c86fa8bae27301615b7ecd80613`.
The built browser/agent source `5df58b98f77ed070f5f9ff6764843e75ffc75e4f` differs only in documentation.
All three complete API shards pass: 6160 passed, zero failures,
401 existing skips and 4 TODOs across 442 files.
All 15 non-API workspace tasks passed. This is not staging acceptance.

[API inventory](final-api-gate.json) and [completion receipts](completed-checks.json)
bind the results to their source. The original Windows cleanup failure remains
in [its receipt](initial-workspace-stop.json); the complete unchanged rerun passed.
No assertion, timeout or cleanup guard changed.

[Completed checks](completed-checks.json): 16 source-matched typecheck tasks, zero
lint errors with eight existing warnings, matching API contracts, all five app
builds, display and agent builds, Bash/ShellCheck, and seven actual browser smoke journeys.
The [focused API review](focused-api-green.json) has 16 passes; two further pins
are included in the completed full suite. The [earlier failure](focused-api-earlier-failure.json) is retained.

[Native browser proof](browser.json) ran against a real bundled agent, local API
and disposable database. It covers a trusted test destination, exactly one
online token/password send, forged-token refusal, outage token/password unlock,
marked password-only sign-in on desktop and mobile, clearing that notice after
new online sign-in, and manager-ended-shift refusal with or without its token.
The staff subject is a dedicated ZZ TEST account; no SMS, sale or payment was sent.

[Independent database cleanup](database-cleanup.json) confirms the exact box,
till and simulated printer are archived, the address is cleared, the staff
account is inactive with no role grant or active session, its shift is revoked,
and sales and sync anomalies are zero. The local API/database and agent stopped.
Private local-agent caches remain outside Git. No deletion was retried after the
earlier automatic approval rejection recorded in the parent report.

All four PNGs were opened; [inspection records](image-inspection.json) bind their hashes.
The existing Test harness strip is part of SCRUM-728, not a repaired behavior in this proof.
The [initial helper stop](initial-helper-stop.json) was a local database hostname
assertion before fixture creation; it was corrected to the embedded helper's
literal localhost address. The database was removed. The proof then passed.

The source copies under `harness-source` document this local run. They contain
setting names, no secret values; paths identify the local lane used. Physical
Pi/iPad, private HTTPS/certificates, printers and power-cut recovery remain bench work.

SCRUM-726 has released its window. Rebase 727, check
main CI, land, watch the exact full SHA and confirm its deploy. Only the resulting
staging proof may move 727 to Deployed, after the opened image is shown inside
`commentWithImages`. SCRUM-728 follows that acceptance. Never Done.
