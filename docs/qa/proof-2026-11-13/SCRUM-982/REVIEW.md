# Payment handover repair review, in progress

Base396a63751, lane/codex-payment-handover-20261113. Not landed or staged yet. Owner scope:982 and the reliability points of981. The owner-review stop follows stage3, not this lane.

The original964 hunt1 calls show no second Cash tender: B confirmed Cash after the QR had paid, the browser called finalise200 and falsely labelled the QR sale Cash. Hunt2 is more severe: F&B Charge created a second cash sale while the original QR remained payable. These are separate acceptance cases.

The payment scope now excludes the staff identity in all five mounted selling screens. It keeps the order epoch and the fields describing the cart, so an unrelated cart still invalidates late answers. Scope must not switch from a draft key to a sale-id key mid-request: that would discard the first tender's answer. Instead the recorded sale id is passed separately into the existing recovery path, guarded by the same scope/epoch. A rung-up payment reuses its recorded sale; Back must successfully void it before an edited cart can be rung up. The platform's seller remains unchanged. The current authenticated session still identifies the confirmer; no platform authorization or money rule is edited.

Recovery reads GET /sales/:id, checks sale and attempt identity, restores settled methods, then reads the current attempt. Waiting QR/card stays waiting; cancelled QR returns to methods; paid QR finalises with no tender and its actual QR method. Already-finalised sales restore their settlements before local completion. A recovery arriving during the first tender waits for that operation, then reconciles. Local box sales have no platform row and keep the existing box path. F&B/Shop callbacks follow the current render, instead of retaining A's callback after B continues.

981: own-display lease hint persists only lease/account identifiers and renewal time in this tab's sessionStorage; no family details. It requires the exact refused lease id before calling the refusal this tab's handover. Other displays' refusals stay unchanged. Last known family open/Done survives unavailable reads and the lock-to-ended transition. Read-only kitchen names wrap; stock refusal identifies the shortage. The full existing local scope test is preserved, with operator fields deliberately removed from its expected payment identity.

## Findings and prescribed fixes

- HIGH, fixed during review: passing every recorded id to platform recovery would try to read locally rung-up box sales from the platform. Exclude box-owned rows, preserve their existing tender path, cover with focused box/payment suites.
- HIGH, fixed during review: an existing committed sale guard without a successful void on Back would let an edited cart collect against old money. Back now waits for void/refusal before allowing changes; real F&B two-account test and full payment suites must pass.
- HIGH, fixed during review: resume of a finalised sale returned before restoring settlements; that could retain Cash wording. Restore verified attempts before completion and test paid/finalised QR without any Cash press.
- HIGH, fixed and reviewed: scope and callbacks remain current after asynchronous void/prepare. Desktop Back awaits letOrderGo with lock/epoch/scope guards; phone F&B checks all three, and phone tickets check lock/epoch before leaving the disabled payment fields.
- HIGH, fixed by the second review: the old unlock path discarded sale.attempts when no attempt had been retained. Pause now invalidates explicit platform recovery and unlock reads the full sale/attempt history; a QR created and paid during the lock completes with QR. A nonzero finalised sale with no verified taken attempt blocks. Both new failure cases were red before the fix; all nine recovery cases, including manual-form preservation, pass afterward.
- MEDIUM, moved to the approved stage3 app migration:981 point9 originates in applied app migration0050. Its set-menu audience test matches an added extra by name, assigning kids-only to the base set line. Do not hide all set-menu audience marks in the till: valid different-adults marks would disappear. Repair the view forward-only with945/983 and prove the extra/base-name collision there.
- Out of this till-only lane by the written brief:981 point12 End-of-Day refusal composer lives in packages/shared/src/sale-hold.ts, not apps/pos. Retain the recorded issue for the owner review.
- Owner questions unchanged: rate approval carry-over, discount attribution, seller display and the box's held-minute QR blanking. These choices are not silently changed.

## Gates so far

Scope regression first failed2/5 on the old behavior. Focused run:73 passed, one source-text assertion failed solely on CRLF after editing; files restored to repository LF, assertion unchanged. Includes six new recovery cases, seven display-handover checks and measured long names at1440,1024 and split1440. Initial types passed; second run found one test resolver type mismatch, corrected. Full final gates and staging proof remain owed.

Prior977 CI43419051479 finished5/6: workspace strict mirror timing measured1000ms against less-than1000ms. Exact239ef48248d7ec1af739f432db7c91dda778c2c0 local production-build smoke passed10/10 in3.7minutes, unchanged threshold and cleaned disposable database. Early rerun request was rejected while the run was active; after completion one failed-job rerun was accepted. Do not call it green until read back. Its source worktree is temporarily detached at that exact SHA; original lane branch and closeout commits remain preserved.

## Final source review

Independent source review approved the second recovery fix subject to the final rerun, ordinary clean rebase and commit-list check. The initial full production-build end-to-end run passed 12 of 12 and removed its disposable database. After the second review the final rerun has passed POS types, zero-output API types, 672 POS tests in 52 files, 11 API review pins and touched-file lint; its rebuilt end-to-end run passed all 12 journeys and removed the disposable database. No staging fixture has been made. Staging SMS_ADAPTER reads Twilio: the proof never calls POST /accounts, and reuses only the two committed, retired ZZ TEST 964 staff identities after fresh inactive/zero-live-session checks. All selling fixtures and display credentials are new SCRUM-982 records.
