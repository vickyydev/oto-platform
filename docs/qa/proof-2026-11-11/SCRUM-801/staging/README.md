# SCRUM-801 / SCRUM-800 staging proof

Passed on 11 November 2026, 05:41 Bangkok, through Edge on the live till.
Source: `3f0bc5ddd04ccd609d901d540955ce74de09c1ae`. Both named POS services
were live at this SHA at the start and end; deployment IDs are in receipt.json.

Main CI [42915618825](https://github.com/vickyydev/oto-platform/actions/runs/42915618825)
was running during the proof. The full six-job candidate gate was green on
`589fe3968e33607a09e113d9872063c228dcb359`; git diff verified runtime,
tests and workflow were identical. The landed-SHA run subsequently passed
all six jobs; ci.json records the job/step results. The complete app
typecheck output was byte-identical to the already-read candidate output
(418/418 in 54 files); the workspace output was read whole, with no API
compiler diagnostics. Both tickets then read Deployed with images attached.

- A newly created ZZ TEST till on the online virtual box was used.
- Phone at 375 x 812: Tourist, ticket, customer details, Pay, then Cash.
  The payment column measured 343 px (left 16, right 359). All measured
  controls fit within the viewport with no horizontal clipping; Confirm
  was enabled and PromptPay visible. The full Confirm text is visible
  after normal vertical scrolling. No payment was confirmed.
- Back then Cancel called the real void route: HTTP 200. GET the exact
  sale returned voided. Phone reload showed no items; counter reload
  showed an empty order and no payment/resume screen.
- Both staff and admin sign-outs returned 200 and subsequent /me returned
  401. The test till was archived and read back archived. The voided
  synthetic sale remains as history; no open sale remains from this pass.

Pictures were opened and inspected before copying to Jira attachments:

- s800-payment-375.png: amount and tender labels, including PromptPay.
- s800-confirm-375.png: complete Confirm button within the phone width.
- s801-reloaded-phone.png: empty phone order after cancellation/reload.
- s801-reloaded-counter.png: empty counter order after reload.
- s801-void-readback.png: labelled card of recorded API readbacks and
  cleanup; it explicitly identifies itself as a test-run card.

The staff badge and input fields are masked. No family benefit QR was
created. Existing stock/overdue/gate banners are outside this proof.

The first attempt is retained as attempt-1.json, passed=false: all product
checks passed, but the staff sign-out API request used a relative URL
without a baseURL. Its test till was archived and sale voided. The browser
closed before that session could be signed out through its cookie. A
guarded one-off job called the existing signOut service for exactly the
sole session on that archived ZZ TEST till within the recorded attempt
window. Its final count query selected an invalid column and failed; the
independent read-only job `job-dbpprh0n74is738m37bg` succeeded and confirmed
the session revoked with reason sign_out and zero active shift tokens.
See attempt-1-cleanup.json. The harness now sets baseURL; the complete
second attempt is receipt.json and includes both 401 readbacks.

No park till, real payment, payment run, setting or physical device was
changed. Only the created ZZ TEST records were cleaned up.
