# SCRUM-739: review an ordinary sale's held gateway QR

Local work in progress. No source landing or staging acceptance is claimed.

The ticket till, F&B and shop now offer SCRUM-732's shared review for a
gateway QR awaiting staff confirmation. The existing panel asks staff to
check the bank slip and gateway report, enter a note, then answer Money taken
or No money. The platform still requires `pos:payment:confirm`.

The old `sale-writer.test.ts` pin intentionally forbade this button. It was
deliberately changed to allow the review while preserving the expiry hold.
Five frontend checks failed before the fix and passed after it. Additional
pins cover concurrent presses, a denied answer, staff locking and resuming
the original attempt. The terminal route and box PAX QR are unchanged.

## Checks so far

- POS: 113 passing tests across the complete sale-writer and 732 files.
- API: 91 passing tests across the new five-case review, QR cancellation,
  terminal and gateway files. Real routes and independent database reads
  confirm one payment, one final receipt and one answer audit for ticket,
  food and shop sales. A capture-only account is refused; No money leaves
  the sale unpaid. Cancellation and void cannot escape the held attempt.
- POS and API typechecks, touched-file ESLint and POS build passed.
- Native desktop/phone proof and complete release gates remain outstanding.

Raw test receipts in `local-gates/` preserve both the intentional red run and
initial fixture failures. Those setup corrections supplied a valid manual
card route, a three-character gateway invoice prefix and the required food
pickup code. No product guard or assertion was removed to pass them.

Main run 41714895181 failed in SCRUM-732's source. That lane supplied the
typed API-call and offline receipt-clock corrections; replacement main run
41720268210 is still running at this checkpoint. SCRUM-732 remains Testing
and holds the source/API/proof slot. SCRUM-739 stays In Progress until its
own source is on main, and cannot land before 732 Deployed and a released
slot is claimed in STATUS.

`ticket-mapping-before.json` retains the descriptions as read before aligning
the reversed 738/739 summaries with the owner's assignment and 732 comment
13321. Issue histories were preserved. Separate-display work remains with
738's lane; `displaySession.ts` is untouched.
