# SCRUM-802 / SCRUM-783: History and the shown phone number

SCRUM-802 is Deployed on its completed counter History proof and green main CI.
The three inspected pictures are attached as 13018/13019/13020; see
history-closeout.json. SCRUM-783 remains In Progress, so Unit 3 is incomplete.
Units 1-2 are Deployed; Units 4-8 are unbuilt. The SCRUM-832 follow-up planner lane currently holds the landing/deploy slot.
This lane makes no claim. The owner's 15:25 direction now permits proof and
CI to run alongside later landings; Deployed still requires green landed CI.

The original source is 1774278145af7a37b6d4855f87eacff7710d5f21, live on
both named tills. All six main CI jobs in 42975235170 passed; the full-SHA
watcher exited zero. Its workspace typecheck was read whole, zero API
diagnostics. The app was path-skipped on main; the original full candidate
869a73add71fe4b41550dd4370e6cfcd487a8e48 passed all six jobs in 42971207054
and its whole app output held at 418/418. See main-ci.json, candidate-ci.json,
candidate-app-check.json and landing.json.

History paste and automatic paid Add time receipt refresh passed twice in
real staging screens. The New member offer and customer details show the
corrected number. Attempt 03 found the staff waiting label still raw;
agreements remain unproved. All three attempts are preserved and cleaned up.

The follow-up formats StepAwaitCustomer and StepIdentify with the existing
display helper. Its full candidate 6d4553cf581f0047df826fe516aa7ba7f0d81c53
passed all six jobs in CI 42978766224: 6,799 API tests, 2,333 POS tests,
357 Console browser checks, workspace tests/build and built-till journeys.
All 141 workspace typecheck lines were read: 16 successful tasks, no API
diagnostics. All 667 app typecheck lines were read: 418/418 in 54 files.
See followup-ci.json and followup-app-check.json.

The worktree is C:/oto-lanes/codex-history-phone-20261111, current branch
lane/codex-history-phone-labels-20261111. After the docs-only rebase, the
single source commit is 14ea34f613d8afe3392032e374e40acb404e3712; runtime,
tests and build inputs were compared byte-identical with the green candidate.
The remote candidate branch and local lane/codex-unit3-labels-candidate-20261111
retain the complete pre-rebase history. The follow-up is not deployed yet.

Local follow-up checks passed: all 169 POS files / 2,333 tests; five API
review pins; whole POS/API typechecks with zero diagnostics; ESLint on all
four touched platform files; POS production build with its existing bundle
warning. The first POS run hit timeouts in three unchanged suites while
other local gates ran. The complete rerun passed without changing timeouts.
Both runs and the initial expected-failure review are hashed in
followup-local-gates.json. Original local gates are in local-gates.json.
No protected file, storage rule or payment rule changed.

Both History layouts reuse the existing F&B scanner/paste hook. Hand typing
still waits for Enter or Find; leaving the field cancels its timer. Paid
Add time charges refresh the containing list and search; closing an unpaid
dialog does not. Phone changes only format readonly labels with the shared
normalization and grouping helpers. Input composition and writes are intact.

The staging harness is staging/proof.mjs. It checks both tills at the landed
full SHA and matching API runtime, uses only an own ZZ TEST till/display,
proves paste lookup, verifies the automatic list response contains the paid
time charge, and captures the three phone locations plus the staff mirror.
Independent guarded cleanup voids open sales, waits for paid test print jobs,
revokes the display, archives the till without printers, checks test members
and signs both sessions out with 401 readback. Paid synthetic receipts remain.

Attempt 01 stopped before phone entry because the harness omitted the existing
language choice. No sale was made. The own display/till were retired and both
sessions read back 401. The exact harness, receipt and inspected masked
failure picture are in staging/attempt-01/.

Attempt 02 passed the offer and both History checks, then stopped because the
harness expected the older Thai document selector. The current approved screen
has Confirm Thai rate. All six images were inspected. Its two paid test
receipts remain with every print job printed; display revoked, till archived
without printers, both sessions 401. See staging/attempt-02/.

Attempt 03 passed those checks again. Its inspected display picture shows the
correct details phone; its inspected staff picture exposed the remaining raw
label. The harness stopped at a redundant Pay click after Continue had already
opened details. That click is removed, and the staff correction is now built
and fully gated. Its two paid test receipts remain with all print jobs printed;
display revoked, till archived without printers, both sessions 401. See
staging/attempt-03/. The finding picture is attached to SCRUM-783 as attachment
13017, s783-staff-waiting-before.png. Positive final pictures are still owed.

Next: wait for SCRUM-827 to release its slot, read current main, claim by a
docs push, rebase and inspect the own commit list, land fast-forward, deploy
both named tills at the full SHA and watch that main SHA. Finish the screen
proof, inspect and attach masked pictures, record cleanup, move Testing then
Deployed only with green landed CI, and release the slot in the checkpoint.
