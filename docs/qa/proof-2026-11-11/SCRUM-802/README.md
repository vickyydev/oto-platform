# SCRUM-802 / SCRUM-783: History and the shown phone number

Original source `1774278145af7a37b6d4855f87eacff7710d5f21` is live on both
named tills and all six main CI jobs (`42975235170`) are green. The full-SHA
watcher exited zero. Workspace typechecks were read whole with zero API
diagnostics; the app was path-skipped on main, with the full candidate
ratchet already read at 418/418. `main-ci.json` retains the evidence.

History paste and automatic paid receipt refresh passed twice on staging.
The member offer and customer details show the corrected number. Attempt 03
found the staff waiting screen still raw; agreements remain unproved.
All three attempts are preserved below and cleaned up. Neither ticket is
Deployed.

Follow-up source `2f699cd7d7d5216a2b2f7a7f0da28f6315a0215f` formats both staff mirrors using the
existing helper. Five review pins, 2,333 POS tests in 169 files, whole POS/API
typechecks with zero diagnostics, four-file lint and the POS build pass.
The first local POS run had three timeout failures while other gates ran;
the complete rerun passed without changing timeouts. Both logs are hashed
in `followup-local-gates.json`. The current branch is
`lane/codex-history-phone-labels-20261111`; full candidate CI, landing,
deployment and the complete final proof are still next. The slot is released.

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
contains the paid charge before searching the screen. The first attempt stopped before phone entry; its test till and display
were retired and both sessions signed out. Its cleanup attempts each independent step even if a prior step
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

The first attempt is retained under `staging/attempt-01/`: the receipt,
inspected masked failure picture and exact harness. It waited for the phone
form without choosing the existing first-screen language. No sale was
created. Cleanup read back the display revoked, the till archived with no
printers, and both sessions at 401. The corrected harness chooses English
and captures both screens on a failure; the deployed product is unchanged.

Attempt 02 passed the member-offer phone label, pasted-band lookup and
automatic Add time receipt refresh (including the HTTP list response).
It stopped at the Thai-rate modal because the harness still expected a
document selector; the current approved screen has Confirm Thai rate.
All six attempt images were inspected. Two paid test receipts remain as
evidence, with every print job printed; the display was revoked, the till
archived without printers, and both sessions read back 401. The receipt,
images and exact harness are preserved under `staging/attempt-02/`. The
harness now presses the current confirmation. Product source is unchanged;
the details and agreements labels still need their screen proof.

Attempt 03 again passed History and the member offer. Its inspected display
picture shows the details number correctly formatted. The harness timed
out on a redundant Pay click: Continue had already opened Customer Details,
and payment waits for the missing name. That click is removed. The paired
image also exposed a real remaining display-only gap: the staff waiting
screen still printed the raw leading-zero number. StepAwaitCustomer and
StepIdentify need the same existing formatter before SCRUM-783 is closed.
No phone write or payment rule needs changing. Attempt 03 is preserved under
`staging/attempt-03/`; its two paid test receipts remain as evidence with all
print jobs printed. Display/till retirement and both 401 sign-out checks
passed. Agreements proof is still outstanding. The source/proof slot is
released during this small follow-up build and will be claimed again.
