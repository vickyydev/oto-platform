# SCRUM-910 phone parity follow-up

The original candidate correctly supported desktop zero-return closure, but phone History still described a verified deposit-only finalised party as fully refunded and its separate three-step flow rejected zero. This correction uses the existing server eligibility and unchanged authenticated shared controller.

A zero-return exception requires the server flag, a positive retained allocation, whole mode and a reason; the user cannot choose item/custom under that exception. Ordinary zero stays disabled and a busy confirmation refuses a repeat. The screen says no money is returned and keeps the allocation label separate. Exact-party review holds are visible instead of claiming fully refunded. After closure, PaymentRow receives the retained allocation remainder just as desktop does.

## Adversarial verification

The complete sale-detail-label file ran with only the two phone components restored to their pre-fix versions: three meaningful failures and 56 passes. Failures showed the missing phone closure action, missing review hold and absent whole-only zero path. The fixed code passed all 108 tests in six complete History/refund files, all three POS type configurations, touched-file lint and the production build. Existing mixed-import and large-chunk build warnings are preserved; no warning was suppressed.

The new actual MobileTransactionDetail -> MobileRefundFlow -> shared-controller journey advances the steps, selects a reason, confirms once, asserts POST whole mode without amount or tender, then reads the money-returned and retained labels. Separate controls cover incomplete eligibility, required reason and a busy repeat. Hook tests mock networking; they do not replace the final native staging journey. Log/source fingerprints are in mobile-validation.json; raw logs remain in the scratch audit directory.

The API, money services, shared contracts and provisional migration are unchanged from independently reviewed857535fd9baefced3e7118d3dd9f80f452992312. Source delivery remains held:844 proof is incomplete and current-main CI43517660340 has six independently reproduced live-weekend fixture failures. The844 exact fixture is archived and its browser/sessions are closed. This lane has no staging fixture/session and no running gate. Independent review of this additional UI delta is required before landing.
