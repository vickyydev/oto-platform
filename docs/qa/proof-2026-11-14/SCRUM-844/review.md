# SCRUM-844 source review candidate

The older free-text fill could put a requested deposit into the Deposit field as received money. The fix keeps requested/unconfirmed amounts separate. A received proposal needs an explicit flag and the source message's quoted words; the route checks the quote against the actual text. In the free-text preview, staff must confirm receipt before applying the amount. A new read starts unticked. The ordinary Save and its existing deposit guard remain the only writer.

Base: `f7df3150f9405dd6aa3480d11c6ab166abf345b2`. Worktree `C:/oto-lanes/codex-beo-money-stage3-20261114`, branch `lane/codex-beo-money-stage3-20261114`. Product source is five app files; four test files cover it. No migration, payment engine, catalogue approval policy, EventExtraction helper or tax/service configuration change.

The mandatory extraction instruction follows saved advice/output fields for form-read shapes. Catalogue-only conversation reads keep their own existing prompt. An old amount-only answer becomes requested/unconfirmed, never received. A date without a confirmed receipt cannot overwrite the stored receipt date. The exact-quote check establishes that the words occurred in the message; it cannot establish that a payment actually occurred. The fresh staff confirmation remains necessary, as in the catalogue review's deposit control.

## Adversarial checks

- Original HEAD editor with the new regression: an old amount-only answer changed the actual Deposit field from2000 to3000. `ui-baseline.log` records the red regression; the runner restored candidate source in `finally`. The first harness attempt forgot to unfold Party Details and is separately retained in `ui-harness-first.log`.
- Fixed whole editor suite:13 checks, including old amount-only, requested, received unticked, received explicitly confirmed and catalogue `Load into Editor`. Actual Save payloads retain the existing amount/date unless the received proposal is confirmed. The first fixed run found the missing Checkbox import, which was corrected; both attempt logs remain.
- Schema/runtime helper:19 whole-file checks, including an old saved prompt/output format, mixed requested3000/received1000 and amount-only compatibility. Old date-only expectations were updated to the new receipt rule; the positive received-date case remains pinned.
- Actual no-catalogue route:15 whole-file checks on a freshly migrated disposable embedded Postgres, including fabricated source quotes and an existing received deposit in the form baseline. Migrations pass on first run and idempotent second run. The first route run caught its older amount/date fixture expectation; the corrected whole file passed. Existing deposit approval7/7 and catalogue fill22/22 pass unchanged.
- API house review:11 tests cover old answers, requests/future promises in three languages, fabricated evidence, real source quotes, mixed amounts and invalid figures.

Whole app ratchet:414/414 inherited diagnostics in54 files; all652 output lines were read. Build succeeds with existing PostCSS/chunk-size warnings and the pre-existing duplicate keys in tasksRoutes1613/1614. Scoped ESLint used the root rules with the app ignore removed only in scratch:78 inherited diagnostics remain identical by rule/message/source line across touched files,0 added. New helper, review and both changed pure/UI test files are lint-clean. No root lint configuration or inherited debt ceiling changed. API typecheck status is recorded in validation.json once complete.

## Release boundary

Root source review approved exactd4c873ff4d2be64daf0baa831d88dd5e698ae629 with no blocking finding. No source push, staging deploy, live model call, fixture or Jira change has happened in this candidate. Local model answers are deliberate stubs; they do not establish native staging behavior or a live model's accuracy. Next: root review, ordinary rebase/commit-list check, exact-source landing and named app staging deployment; prove requested versus received in both free-text paths, inspect/attach evidence, clean exact fixtures/sessions and read Jira back. Keep Deployed below Done; the owner alone accepts Done.

Following units remain separate:983/968 editor/PDF reliability, then945/981p9 forward-only view repair. Deposit910/966 and slip-baseline work are owned by their separate agents. Existing owner-held behavior and the Maria read-only pricing answer stay unchanged.
