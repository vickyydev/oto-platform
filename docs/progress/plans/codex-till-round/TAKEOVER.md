# The till and platform round — review and take-over (11 November 2026)

The second agent stopped on its usage limit after landing all eight units of `PLAN.md`
(13 tickets, all Deployed). The owner asked for its work to be verified, then for the
planner session to take the round over: fix what the review found, and clear the next
Sprint 2 tickets that are fully specified.

## 1. What the review found

Four independent reviews read every ticket, comment, diff, test and proof picture.

| Unit | Tickets | Verdict | Follow-up |
|---|---|---|---|
| 1 Phone till payment | SCRUM-801, SCRUM-800 | Correct | SCRUM-849 (the e2e check overwrites committed pictures) |
| 2 Receipt prefix | SCRUM-809 | Correct, one side effect | SCRUM-846 (the check runs on every save of a till; a restored-box clash was reworded) |
| 3 History, phone format | SCRUM-802, SCRUM-783 | Correct; two staff cards reformatted beyond the ticket | SCRUM-848 (one dialog still raw); owner question on the two cards |
| 4 Golden Ticket drop-off | SCRUM-807 | Correct, one gap reported and not ticketed | SCRUM-847 (the customer screen shows the old amount during the wait) |
| 5 Display pairing | SCRUM-819 | Correct | none |
| 6 Login lifecycle | SCRUM-778, SCRUM-781, SCRUM-810 | Correct on its own terms; a real switch-off can be parked silently | SCRUM-852 |
| 7 App checks, SOP model | SCRUM-784, SCRUM-785 | Correct | SCRUM-851 (raw provider answer shown to staff; two pictures to re-mask) |
| 8 Checklist upload | SCRUM-748 | Correct; photo proved, video not; whole file held in memory | SCRUM-850 |

Established facts: no fenced surface was touched; no attribution lines; no test deleted,
skipped or weakened; the app migration 0049 was NOT edited after being applied (the three
commits were pushed together); CI was green on every landed commit; a read of staging on
11 November shows no live person's lifecycle event parked (four events for deleted logins
settled, one pay-only event delivered).

Things it chose without asking, kept as built unless the owner says otherwise: the ceiling
numbers of the lifecycle retries; a new admin read route for lifecycle events; the wording
of the prefix refusals; the phone till's stacked Back-over-Confirm layout and the freeze of
the screen while a sale is voided; the two staff phone cards' format; the "Waiting for the
voucher price..." line; a helper rule that drops a sampling setting on the default model.

## 2. The take-over lanes

All under the parent task SCRUM-845 (consistency follow-ups) or their own tickets. Each:
build with tests, focused gates, land fast-forward under the slot, deploy by name, staging
proof with pictures, Deployed on that proof.

| Lane | Tickets | Surface |
|---|---|---|
| lane/prefix846-20261111 | SCRUM-846 | api |
| lane/tillfu845-20261111 | SCRUM-847, SCRUM-848, SCRUM-849 | till |
| lane/appfu845-20261111 | SCRUM-850, SCRUM-851 | OTO App |
| lane/lifecycle852-20261111 | SCRUM-852 | OTO App |
| lane/unlock780-20261111 | SCRUM-780 | till, box bridge |
| lane/e2e782-20261111 | SCRUM-782 | till end-to-end specs, CI |
| lane/box788-20261111 | SCRUM-788 | box installer (proved by its shell checks; no box touched) |
| lane/onboard811-20261111 | SCRUM-811 | OTO App |

Rules added today that bind every lane: no junction or symlink from a lane into another
checkout; the OTO App's packages are installed inside the lane; a deploy is read by id at
most once per 90 seconds; staging's simulated payment pages live in the api's memory.

## 3. For the owner

- SCRUM-809: refuse a reused prefix at the form (built) or continue the old counter.
- SCRUM-783: accept or revert the two staff cards' spaced phone format; should "Stored as"
  match.
- SCRUM-800: accept the phone till's stacked Back-over-Confirm layout.
- SCRUM-748: the storage bucket's browser rule, or the app server as the permanent path.
- SCRUM-778: keep or remove the new admin read route; a reverse recipe for 0049 before
  go-live.
- Not started, need a decision or hardware: SCRUM-733 (till Messages tab), SCRUM-513,
  SCRUM-274, SCRUM-705, SCRUM-482, SCRUM-485, SCRUM-709, SCRUM-714.
