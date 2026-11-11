# SCRUM-802 / SCRUM-783: History and the shown phone number

Unit 3 is built in `C:/oto-lanes/codex-history-phone-20261111`, branch
`lane/codex-history-phone-20261111`. It landed fast-forward at
`1774278145af7a37b6d4855f87eacff7710d5f21`. Both named till deployments
are building; main CI `42975235170` is running. Staging proof is not run.
`landing.json` records the source and deploy requests.

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

Full candidate CI `42971207054` passed all six jobs at
`869a73add71fe4b41550dd4370e6cfcd487a8e48`. The saved source and local
gate logs survived the interruption. The staging harness is prepared and
syntax-checked at `staging/proof.mjs`; it asserts the automatic list reread
contains the paid charge before searching the screen. It has not run and has created no
fixtures. Its cleanup attempts each independent step even if a prior step
fails, and records failures without discarding the other cleanup receipts.

The full candidate passed 6,798 API tests, 2,332 POS tests and 357 Console
browser checks, plus the workspace build, tests and built-till journeys.
Workspace typechecks were read whole: 16 successful tasks, zero API
diagnostics. All 667 lines of the app typecheck were read: 418/418 in 54
files. `candidate-ci.json` and `candidate-app-check.json` retain the receipts.

Next: both named till deploys live and real staging screen proof. Proof must show a
pasted ZZ TEST band opening History, a paid Add time receipt appearing without
leaving History, and the leading-zero ZZ TEST number correctly shown in the
three reported places. Use an own till and paired display, retire the exact
fixtures, sign out and read back 401, inspect masked PNGs, attach to both
tickets, Testing on proof and Deployed only with green landed-SHA CI.
