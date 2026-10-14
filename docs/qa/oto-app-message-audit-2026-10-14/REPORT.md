# OTO App misleading-messages audit — merged report, 14 October 2026

Read-only audit of every confirmation dialog, all 586 server refusal sites,
and a vocabulary-driven sweep of the client's toasts, cross-checked against
the server code that actually runs. **32 serious findings and 25 minor
wording issues.** About half of the serious ones are real behaviour bugs
behind the message, not bad wording. The five lanes' full tables with
file:line citations live beside this file (confirms-A/B, refusals-1/2,
client-toasts); the raw extraction is in the session records.

## The headline findings, worst first (full detail in the lane files)

1. **Employee delete** archives, then permanently deletes contracts (signed
   included), assets, documents and time records with no transaction; with a
   linked login it fails midway on a raw error, leaving a half-deleted state.
2. **Supplier-token revoke never sends** (a miscalled request helper), so
   the token stays live after "revoked"; the same mistake breaks every
   payroll statutory-rule write. The type error sits grandfathered in the
   app's typecheck baseline — the ceiling has been hiding a dead button.
3. **A schedule-template restore wipes assignments across all weeks** (the
   delete has no date filter) and returns only one week.
4. **The event "Cancel" button hard-deletes** the event, and 500s when the
   event has tasks.
5. **Branch delete** has no safety check: raw database error when anything
   points at it, silent deletion of its schedules when nothing does.
6. **Advisor delete** removes the login first, then fails for any advisor
   who ever clocked in, leaving them listed with no login.
7-8. **The launcher-era cluster:** password screens, "must change password"
   traps and dead reset flows surviving the move to launcher sign-in —
   substantially cured by SCRUM-539 (shipped 14 Oct); the remainder is
   closing the legacy reset routes server-side.
9-32 and the minor list: see the lane files.

**Security-grade side findings:** location PATCH/DELETE without a park-group
filter; task-question delete before the tenant check; the employee
reset-password route not refusing admin targets the way the user route does.

## Remediation shape

- **Batch 1 — security and data loss (server fixes first):** findings 1, 2,
  3, 4, 5, 6, 21 plus the three security side findings.
- **Batch 2 — launcher-era remainder:** close the app's legacy reset/forgot
  routes server-side; fix Create Login's missing link; align the admin role
  check; retire the kiosk PIN leftovers. (The bulk shipped with SCRUM-539.)
- **Batch 3 — behaviour bugs behind messages:** findings 9, 10, 11, 15, 16,
  17, 18, 20, 25, 26, 27, 28, 29, 32 and the bug-grade minors.
- **Batch 4 — wording only:** every remaining line, one pass, no behaviour
  change.
- **Owner notes, not fixes:** the child-profile merge rule (allergy notes
  overwritten), the leave-policy branch rule (ported from the original),
  and whether ungrouped shift rows should exist.
