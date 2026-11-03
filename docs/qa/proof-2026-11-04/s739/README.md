# SCRUM-739: review an ordinary sale's held gateway QR

Local work in progress. No source landing or staging acceptance is claimed.

4 November, 05:13 Bangkok: complete local gates are now green. The three
API shards passed all 447 files: 6,224 passed, 401 inherited skips and four
existing TODOs unchanged. Final POS passed 1,776 tests and eleven browser
journeys. The latest main Console harness passed typecheck, eslint and all
357 browser cases on the combined source. Complete workspace type, lint,
contract, test, tool and build checks also passed. Raw receipts and log
fingerprints are in `complete-local-gates/` and `gate-checkpoint-0449/`.

Branch run 41723536314 on d1404fb0613418e81d6a03a4f6811af295c0a46e
passed five jobs but failed API shard 1 while starting the existing consent
browser harness. Its complete six-case file passed unchanged on an isolated
checkout of that exact SHA. The failed shard is being rerun once; CI is not
yet green. The original failure is retained. No timeout, retry or assertion
was changed. The current rebase adds only main's documentation; application,
package, test and build bytes match the previously checked abb18abf source.

The final six-case staging-fixture rehearsal used only dedicated one-baht
products and a ticket package with no credit or gate access. Independent
reads confirm six finished sales, six payments and one confirmation and
finalisation audit each. Cleanup archived the exact fixtures, revoked the
two unscanned synthetic bands and retired their six alerts and inactive
working document with audit. All own session and queue counts are zero.
`staging-rehearsal/` retains the receipt and three opened images; guarded
staging helper snapshots are in `prepared-staging-harness/`.

SCRUM-732 is still Testing and holds the proof/API slot. No SCRUM-739
runtime source is on main and no staging fixture or setting has changed.
The older checkpoints below describe the work at their recorded times.

4 November, 04:35 Bangkok: six native local cases now pass on the built POS:
ticket, food and shop at 1440px desktop and 390px phone width. Each simulator
late payment stays held until the shared review is answered, requires both
the note and checkbox, and reads back as one finalised sale with one approved
payment. `local-native/result.json` records the six distinct sale/attempt IDs,
receipts and tested source-file fingerprints. The isolated database was
dropped after the run. These are local simulator results, not staging proof.

The phone shell had no Shop route. It now mounts the existing shop screen,
stacks its products and existing cart, and leaves the shared payment panel
intact. Its staff lock pauses controls and retains the original attempt; the
native proof locks, unlocks and confirms that same payment. The old desktop
layout remains the same. No setting or business-rule change is required.

Opened images: all six `*-04-review-ready.png` files in `local-native/`.
Other frames and helper snapshots are retained there for review. A previous
phone-ticket probe matched the collection button and its QR redisplay button
together; its failed receipt remains beside the passing full rerun. The
corrected selector checks the collection button inside the payment step.
Initial route-component typing was corrected before the passing typecheck;
the final component uses the same mobile breakpoint as the application.

The phone follow-up passes 128 focused POS tests, typecheck, lint and build.
Complete types, lint, contracts, tools and builds passed on frozen 2cc09fb0;
its API, workspace and Console acceptance runs continue. Backend bytes are
unchanged in the phone follow-up. Full final-source checks remain required.

The ticket till, F&B and shop now offer SCRUM-732's shared review for a
gateway QR awaiting staff confirmation. The existing panel asks staff to
check the bank slip and gateway report, enter a note, then answer Money taken
or No money. The platform still requires `pos:payment:confirm`.

The old `sale-writer.test.ts` pin intentionally forbade this button. It was
deliberately changed to allow the review while preserving the expiry hold.
Five frontend checks failed before the fix and passed after it. Additional
pins cover concurrent presses, a denied answer, staff locking and resuming
the original attempt. The terminal route and box PAX QR are unchanged.

## Initial focused checks

- POS: 113 passing tests across the complete sale-writer and 732 files.
- API: 91 passing tests across the new five-case review, QR cancellation,
  terminal and gateway files. Real routes and independent database reads
  confirm one payment, one final receipt and one answer audit for ticket,
  food and shop sales. A capture-only account is refused; No money leaves
  the sale unpaid. Cancellation and void cannot escape the held attempt.
- POS and API typechecks, touched-file ESLint and POS build passed.
- At that checkpoint native desktop/phone proof and complete release gates
  were outstanding; the newer result above supersedes it.

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
