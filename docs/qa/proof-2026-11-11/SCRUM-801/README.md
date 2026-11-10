# SCRUM-801 / SCRUM-800 — phone payment

Unit 1 landed on main at `3f0bc5ddd04ccd609d901d540955ce74de09c1ae`.
Both `oto-pos-staging` and `oto-pos-web-staging` were live at that SHA during
the passed staging proof. Main CI run 42915618825 passed all six jobs. The release
worktree is `C:/oto-lanes/codex-phone-payment-ci-20261111`.

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
  output was read. The later full hosted candidate checked every workspace
  package afresh and the OTO App ratchet held at 418/418 in 54 files; its
  complete output was read.
- Workspace build: all five tasks passed. Generated API types match.
- Touched platform files: eslint passed. The prepared staging harness passes
  syntax and separate lint checks. The staging run and cleanup passed;
  see staging/README.md for the retained first-attempt harness failure.
- Other workspace test batteries passed all 14 tasks. The original full
  local API battery still runs on its frozen worktree and is not counted
  as passed.
- Full candidate CI [42909977358](https://github.com/vickyydev/oto-platform/actions/runs/42909977358)
  passed all six jobs on `589fe3968e33607a09e113d9872063c228dcb359`. The
  landed runtime, tests and workflow are byte-identical; the rebase added
  documentation only. All three API shards passed (479 files passed,
  eight existing skipped); POS 167 files passed; the CI browser step
  includes both phone payment journeys and the seven standard smoke flows.

Development failures retained locally: the first typecheck named an incorrect
refusal-component import, which was corrected; the first browser attempt used
incorrect participant button names, which were corrected. A workspace gate
invocation gave Turbo an unsupported worker flag and started no tests; the
corrected invocation uses its concurrency flag. None is counted as a pass.

The staging proof passed through the real screens. All five final images
were inspected. Both tickets read Deployed with the pictures attached;
owner acceptance remains outstanding. The slot was released after proof.

No inbox/BEO source, migration, setting, real payment, park till or device
was changed. SCRUM-801 and SCRUM-800 move to Testing with the inspected
staging pictures. Units 2–8 are unstarted.

The later planner release fcd1a08b3bcc75b1afbda8d6ef548db1bbd438e3 now
runs on both till services. It descends from the proved source and leaves
both phone files unchanged. See staging/deployments-after-ci.json; the
planner owns its current SCRUM-829 proof slot.
