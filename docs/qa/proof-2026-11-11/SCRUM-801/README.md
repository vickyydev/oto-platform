# SCRUM-801 / SCRUM-800 — phone payment

Unit 1 is built locally on `lane/codex-phone-payment-20261111`, in
`C:/oto-lanes/codex-phone-payment-20261111`. It is not landed or deployed yet.

The phone uses the counter's sale writer for all three order Cancel controls.
It clears only after the void succeeds. A refusal keeps the order and the
platform's message; pending money and duplicate cancellation remain guarded.
The shared payment panel uses two tender columns and stacked actions on a phone.

Local checks observed on 11 November:

- POS suite: 167 files, 2,318 tests passed, including the four new phone
  cancellation cases. The focused writer/payment run passed 93 tests.
- API adversarial review: three passing pins for the two resolved findings
  and the pending-payment/refusal protections.
- Real Edge, disposable embedded PostgreSQL: both phone journeys passed.
  The sale was voided through the real route after Pay, Back, Cancel; a fresh
  phone and desktop page offered no sale to resume. A deliberately refused
  void retained the order and its message. Both sessions read back 401 after
  sign-out. The database was removed by the runner.
- The standard seven-journey till smoke also passed against the built app;
  its disposable database was removed.
- Measured at 375 px: the payment column and its controls stay within the
  viewport, with no horizontal clipping. The two local PNGs were opened and
  inspected; they show the top of the payment screen and the lower actions.
  The outgoing station toast is visible at the edge of the local captures.
- Own POS/API typecheck scripts: no compiler diagnostics. Workspace
  typecheck: all 16 tasks passed, 13 reused from the shared cache; the whole
  output was read. The untouched OTO App was not freshly checked.
- Workspace build: all five tasks passed. Generated API types match.
- Touched platform files: eslint passed. The prepared staging harness passes
  syntax and separate lint checks, but has not run.
- Full API and other workspace test batteries are still running.

Development failures retained locally: the first typecheck named an incorrect
refusal-component import, which was corrected; the first browser attempt used
incorrect participant button names, which were corrected. A workspace gate
invocation gave Turbo an unsupported worker flag and started no tests; the
corrected invocation uses its concurrency flag. None is counted as a pass.

`staging/proof.mjs` is prepared for the slot and requires green CI plus both
changed POS services live on the full supplied SHA. It creates only an own
ZZ TEST till, records an unpaid synthetic sale, checks the native cancel and
reload, saves masked images and a receipt, voids the exact sale if necessary,
archives the till, and reads both signed-out sessions back as 401. The proof
is not evidence until it has run and the images and cleanup are inspected.

No inbox/BEO source, migration, setting, real payment, park till or device
was changed. SCRUM-801 and SCRUM-800 remain In Progress. Units 2–8 are unstarted.
