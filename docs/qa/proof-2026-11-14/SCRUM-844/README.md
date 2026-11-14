# SCRUM-844 staging proof

WORKS in the bounded requested-versus-received legacy AI fill paths. On 14 November 2026 the actual catalogue review's **Load into Editor instead** path kept a stored received deposit of 2,000 baht and its 14 November receipt date when the new text requested 3,000. An explicit received proposal also preserved 2,000 when its fresh confirmation was unticked. Reading it again, ticking the confirmation, applying, saving and reopening stored 3,000 with the stated date. The baseline is synthetic bookkeeping, not a payment taken.

Five actual no-event/no-catalogue API reads returned HTTP 200: requested, ambiguous amount and future transfer produced requested 3,000 with no received value/date; explicit receipt produced received 3,000; mixed requested 3,000/received 1,000 kept both amounts separate. This is live model/API evidence, not a second native no-catalogue UI journey. Local adversarial tests separately cover old amount-only model shapes and invented receipt quotes. A live model sample is not a guarantee of every wording; the fresh staff confirmation and saved-value preservation were exercised directly.

## Source and CI binding

- Reviewed app source/live runtime: `c3186fee7ab0ea034a8adefc8da90e6c23a2eced`; named oto-app-staging deployment `dep-dbronrs9v7es73ch6s30` is live. Runtime reads at authentication and final read-only cleanup agree. `staging/render-final.json` records the deployment readback.
- Original CI 43517660340: all 122 app steps passed, zero skipped; overall red from six POS weekday fixtures meeting the new Saturday. Exact original reproduction (6 failed/80 passed) is preserved, not retried away.
- Independently reviewed Date-only repair landed `43ec4059de4e222b1cc9d88170d0b33da0f09159`. CI 43563010484 passes all six jobs, including 3,902 POS tests in 274 files. Its app job has 7 passed setup steps and 113 path-skipped steps; it is not fresh app coverage.
- Both commits have the identical app Git tree `e7de30197bc98ee97fd102d50f1c92c4b9cc61e0`; no app/product/pricing configuration or measured geometry changed in the test repair. The complete-file local repair gate is 86/86, three POS type configurations clean and lint clean.
- Root source review approved app candidate d4c873ff; delegated peer approved test candidate 36f910d8. Both reviews and local receipts are retained. Full CI was watched alongside native proof under root's focused-gate authorization and finished green during proof.

## Evidence and cleanup

All eight attempt-02 PNGs were opened and inspected. Five selected native preview/detail images and the explicitly labelled API/readback card are copied byte-identically to the ticket attachment directory; names and SHA256 values are in `staging/images.json`. Images 01/03/06 have less useful viewport crops and overzealous account-name masks; they remain attempt evidence and are not attached. The final saved detail image clearly shows 3,000 and its receipt date.

Own event `faf22df4-bd73-439a-b4ac-a481f4ad914a`, title `ZZ TEST 844 Legacy deposit 20261114061347617`, app branch `6427e84d-723f-4dbd-be58-8ef89cf7dc99`, is archived. The archive POST succeeded; the harness then wrongly asserted an `archived` boolean rather than the actual `archivedAt` field. That failure is retained in attempt-02. A fresh read-only attempt-03 verified persisted archivedAt `2026-11-14T06:17:36.639Z`, the exact prior attempt-01 fixture remains archived, and zero active own upcoming events remain. Attempt-02 and attempt-03 app/launcher sessions both signed out with 200 and independently read 401; browsers closed. Readback ledgers are retained without secret values.

No customer record was edited, no real message/account creation, payment, catalogue/settings change, production or physical hardware action occurred. The first interrupted native attempt and its cleanup remain preserved. This acceptance is for 844's legacy deposit guard; other stage-3 behavior and owner-held choices are separate. Jira stays below Done.
