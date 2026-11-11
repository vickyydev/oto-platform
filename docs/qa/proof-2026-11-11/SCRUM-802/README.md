# SCRUM-802 / SCRUM-783: History and the shown phone number

Unit 3 is built in `C:/oto-lanes/codex-history-phone-20261111`, branch
`lane/codex-history-phone-20261111`. It has not landed or been deployed.

Both History layouts now use the F&B field's existing paste and scanner
timing rule through `useScanField`. Hand typing still waits for Enter or
Find. Leaving the field clears its timer. F&B keeps its existing wallet
lookup and scanner-presence behavior; History keeps its own ledger lookup.

A completed Add time payment notifies the containing History screen to
reread its list and search. Closing an unpaid dialog does not emit that
notification. This is wired through both counter and phone layouts.

The New member offer, customer details and agreements show the normalized,
internationally formatted number using existing shared helpers. The paired
display agreement uses the same formatter. Input composition, stored values,
lookup and payment rules are unchanged.

Local commands ran unpiped, each to its own log under the uncommitted `local/`:

- Full POS suite: 169 files, 2,332 tests passed.
- Focused scan, History, phone and Add time cases: 106 passed.
- Four API adversarial review pins passed; no unresolved finding.
- POS and API typecheck output read whole, zero diagnostics.
- ESLint passed on all 17 touched platform files.
- POS production build passed with the existing bundle-size warning.

The first dependency-build command found no build script in the two source
packages and did no build; it is not counted as a pass. The actual POS build
above passed. `local-gates.json` retains log hashes and the checked source.

Next: full hosted candidate gate, an explicitly released slot, main landing,
both named till deploys and real staging screen proof. Proof must show a
pasted ZZ TEST band opening History, a paid Add time receipt appearing without
leaving History, and the leading-zero ZZ TEST number correctly shown in the
three reported places. Use an own till and paired display, retire the exact
fixtures, sign out and read back 401, inspect masked PNGs, attach to both
tickets, Testing on proof and Deployed only with green landed-SHA CI.
