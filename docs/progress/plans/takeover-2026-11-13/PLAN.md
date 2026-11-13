# Approved takeover execution

13 November 2026, 17:50 Bangkok. Tracking: [SCRUM-985](https://oto-suite-dev.atlassian.net/browse/SCRUM-985). The owner approved the first three audit stages and requires a stop with a progress report after them. Later work needs that review.

## Execution order

| Stage | Work | Acceptance |
|---|---|---|
| 1 | Preserve local commits/proof and reconcile Jira/document state, priorities and dependencies | Verified bundles and hashes, current-state Jira descriptions with readback, committed audit and handover |
| 2.1 | 979 API recovery guard, existing five-commit lane | Actual GET collision regression; focused integration gates; named API deployment; held-payment staging proof and cleanup |
| 2.2 | 977/975 and the already scoped 979 till points | Finish the second review on the saved fourteen commits; rotation/form/sale retention and display/payment tests; both tills deployed and proved |
| 2.3 | 978/976 | Census and retire only the interrupted run's exact fixtures first; complete privacy/adults-switch proof, inspect/publish images and verify cleanup |
| 2.4 | 982 and scoped 981 reliability points | Same sale and waiting/paid payment survive staff change on ticket/F&B/shop/phone; correct payment method; no second sale; exact simulator proof |
| 3 | 844, 983, relevant 945/966/968; ruled 910 | Requested/received deposits, quantities/PDF and relevant accounting consistency; owner-held choices stay separate; regression and native staging proof per unit |
| Stop | Report delivered work, unfinished points and any decisions | Owner review before stage 4 or later work |

Only one till lane builds/lands at a time. Preserve each lane's own commits, rebase before each push and never force-push. Read the newest STATUS block before landing. Existing app/prototype behavior governs unless a reliability fault or an explicit owner ruling authorizes change.

## Owner decisions

D1, 13 November: **Keep the deposit with the party** when a fully settled party is refunded in full (SCRUM-910). Refund only the money taken at the till. A later settlement may use the retained deposit; returned money is never credited again. This resolves the refund policy hold, not the implementation or proof.

Unresolved historic adult-menu interpretation, kitchen-required/after-settlement behavior, holiday/coded-item exposure and other numbered choices remain explicit in their matching plans. Investigate current behavior and affected records before asking; do not silently choose a new rule. Production, real messages, the paused gate story and hardware changes remain outside this three-stage approval.

## Release and evidence rules

The 12 November owner ruling in feedback-round/PLAN.md governs this defect round: focused local gates, named staging deployment after landing, full-SHA CI watched alongside and every red investigated. Do not relabel pending, failed or skipped checks as passed. Use the current headroom gate before heavy commands, one heavy run at a time, embedded PostgreSQL and no Docker start. Source-only or simulator checks do not establish physical hardware acceptance.

API typecheck must be clean; app check:ratchet must not exceed its current committed 414 diagnostics. Root ESLint currently excludes the app and is not evidence that an app file was linted. Run meaningful applicable checks and report that limitation; any scoped lint configuration repair must preserve inherited debt and be reviewed. Review adversarial cases and retain meaningful failing pins for recorded holds.

Every landing updates STATUS, CODEX_HANDOVER and CLOUD_HANDOVER section2, and posts Jira progress with a status readback in the same turn. Deployed needs inspected, committed, attached and named staging evidence, source identity and exact cleanup. Only the owner moves Done. Keep failed attempts and limits.

## Audit findings that change priority

- 982: ticket Cash confirmation after paid QR only called finalise and falsely labelled Cash; the proof's stored payment was QR. F&B Charge again created a second cash sale while the first QR stayed payable. Treat these as distinct regression cases.
- 979: recoverTerminalAttempt remains unguarded in its local status route; the unique terminal-reference collision must return 200 with the attempt held and a log.
- 910: the old 'built now' description conflicts with the later hold and main's part-paid-only deposit exclusion. D1 now authorizes a fix.
- 844: the older free-text fill does not inherit catalogue deposit approval safeguards.
- 945: legacy repeated adults/kids lines retain money risk; do not edit applied migration 0050.
- 983: stored text quantity plus one produces 21 and PDF renders nullx; existing partial images and source agree.
- 966/968: display extras/holidays/coded lines must state what settlement does, within the ruled behavior.

## Reconciliation limits

The audit is a complete ticket census and traceability pass with targeted code/proof inspection, not a fresh acceptance run of 784 tickets. 639 Deployed tickets have source/tool/workflow commits naming them; 679 of 682 have images. 205/211/303 point to related-ticket proof instead of carrying an image themselves. Forty staging image attachments sampled by the filename-gap check lack byte-identical current tracked copies; three production images are a separate intentional archive exception. Historical Git/renames/encoding and the local originals must be reconciled before calling evidence lost. No existing delivery is revoked merely for an automated trace miss.

The audit report and all 75 remaining-item assessments are under docs/qa/takeover-2026-11-13. Current Jira descriptions supersede old 'not started' text while preserving older specifications/comments. Future-state sprint metadata is recorded but not changed into invented dates or bulk closure.

## Current stage

Stage 1: local preservation and reconciliation complete. All 75 open tickets have current descriptions, priorities, progress comments and verified readbacks in jira-reconciliation-receipt.json. Seven partially delivered tickets were corrected from To Do to In Progress. The audit exceptions remain explicit; no delivery evidence was invented. No feature gate, deployment, new cleanup or final acceptance is claimed in this checkpoint.
