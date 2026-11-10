# SCRUM-809: a receipt prefix stays with its earlier till

Unit 2 of the till round. Built in `C:/oto-lanes/codex-receipt-prefix-20261111`,
branch `lane/codex-receipt-prefix-20261111`. Not landed or proved on staging yet.

The station service is `apps/api/src/services/fleet.ts` (the plan calls it
`stations.ts`). Its create and update transactions now refuse a till or kiosk
prefix belonging to another till at the same park, including archived tills
and prefixes retained in issued receipt series. The refusal names that till.
Concurrent assignments serialize by park and prefix. Another park may use the
same letters; a station keeps its own counter when restoring its old prefix.
No migration, route shape or counter-continuation policy changed.

Existing duplicate prefixes can still reach payment. Receipt constraint
failures now return `RECEIPT_PREFIX_IN_USE`, naming the prefix and explaining
the manager's correction in the Console. The whole tender rolls back. The
till keeps the order and explains how to return and confirm after correction.

## Local verification

Commands ran unpiped, each to its own ignored log under `local/`.

- API review plus fleet, sales, cash, receipt high-water and longer-code suites:
  6 files, 179 passing tests. The six adversarial review cases cover archived
  create, update, park isolation, retained series, concurrent assignment and a
  legacy collision followed by correction of the same sale. Cash attempts and
  the failed allocator roll back; the earlier receipt remains unchanged.
- Entire POS suite: 167 files, 2,319 passing tests.
- Entire Console suite: 63 files, 611 passing tests, 3 pre-existing todo cases.
- API, POS and Console typechecks: no diagnostics; output read whole.
- ESLint: all six changed platform files, no errors or warnings.
- POS and Console production builds pass, with existing bundle-size warnings.

The full hosted gate, main landing, named API/Console/both-till deploys and
Console screen proof remain pending. SCRUM-809 remains In Progress. The
planner holds source/API/proof for SCRUM-829; this lane has not claimed it.

## Staging proof to run after the slot is available

Create and archive an isolated ZZ TEST till. In Console's New station form,
try its prefix on a second ZZ TEST till: expect HTTP 409, the earlier till's
name visible and no replacement saved. Change to an unused prefix in the
same form and save successfully. Archive both exact test records, sign out
and read back 401. Mask the signed-in badge in pictures. Never create a
duplicate through direct database writes on staging: the legacy-payment
case is covered by the local integration test.
