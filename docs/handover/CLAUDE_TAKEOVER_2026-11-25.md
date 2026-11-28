# Claude handover for OTO Park, 25 November 2026

The live HR app serves park staff. The POS, Inbox, BEO and hardware work described below was tested on staging at Central Floresta. One staging BEO test used a real bank payment. The [28 November work order](CODEX_WORK_ORDER_2026-11-28.md) sets the current priorities. Start by reading the records. A previous approval for a specific live payment, SMS or deployment should not be reused for another operation.

## Where to start

1. Start in a fresh worktree under `C:/oto-lanes/`, cut from current `origin/main`. Preserve the Desktop checkout and earlier lanes.
2. Read the [24-ticket checkpoint](../progress/PARK_CHECKPOINT_2026-11-25.md) for the verified status of each recent issue. Read the top of [STATUS](../progress/STATUS.md) and [OPEN_ITEMS](../progress/OPEN_ITEMS.md) for updates since this handover.
3. For earlier work, open the [17 November takeover](CLAUDE_TAKEOVER_2026-11-17.md), [the feedback plan and evidence](../progress/plans/tom-feedback-20261116/PLAN.md) and [19 November owner rulings](../progress/plans/dropoff-beo-20261119/ANSWERS.md). The rulings cover the counter, public form, family profiles, party workflow and historical imports. They distinguish approved changes from unanswered questions. The face clock-in proposal awaits approval.
4. Follow the repository's AGENTS.md, current handovers and contribution rules. The owner prefers focused staging checks and screenshots of the actual staff/guest experience. Keep tickets at Deployed for owner acceptance. Keep sign-in secrets, private handoff material, guest QR payloads and payment credentials out of reports.

## Release position at handover

| Record | Position and consequence |
| --- | --- |
| Main | The 28 November work order is at `4dc3301ce`. The latest code run failed on `0a1bf8fc6`. [CI run](https://github.com/vickyydev/oto-platform/actions/runs/45859037628). |
| Administrator recovery | The staging API at `c20754e98` and production API at `5b9bf5b9a` include the change. [PR 14](https://github.com/vickyydev/oto-platform/pull/14) tracks its inclusion on main. |
| Checklist | As of 28 November, production HR serves `8870cabab` and staging HR serves `6cd1569d7`. Both include the shared checklist fixes. [Acceptance evidence](../qa/proof-2026-11-25/SCRUM-1070/verification.md). |
| Documentation and Jira | [PR 15](https://github.com/vickyydev/oto-platform/pull/15) records the 24-ticket review. The [28 November work order](CODEX_WORK_ORDER_2026-11-28.md) governs the current work. |

## Production issues for the park

**Staff account access.** A linked launcher account was ready for a first sign-in at the November checkpoint. Private handoff and a successful sign-in still need confirmation for the outstanding report. Tablet attendance and launcher sign-in have separate audit trails. [Staff access issue](https://oto-suite-dev.atlassian.net/browse/SCRUM-1065)

**Password reset and Twilio.** Active staff can request a code on their eligible, unique registered login number even when its old verification date is missing. Staff can defer the after-login verification prompt and see it again on a fresh sign-in. An earlier approved Thai SMS test reached its recipient through the paid sender. The isolated administrator recovery fix followed later. The owner explicitly chose to request their own code. Their receipt is unconfirmed. The public conditional message is not a delivery receipt. For a reported failure, trace the single attempt from account eligibility and throttling to the provider message status, error or delivery receipt. Keep the actual code private. Track wording separately on SCRUM-1061. [Staff recovery evidence](../qa/proof-2026-11-22/SCRUM-1067/README.md) · [Recovery issue](https://oto-suite-dev.atlassian.net/browse/SCRUM-1067)

**Time clock and face enrolment.** The registered tablet supports attendance by photo and phone. Face clock-in remains a proposal awaiting approval. [Face clock-in proposal ticket](https://oto-suite-dev.atlassian.net/browse/SCRUM-1056)

**Scheduling and closing checklists.** Production freed retired-shift dates for reassignment and preserved active assignments and attendance. Reception Closing completed with the eleven evidence files intact. [Scheduling issue](https://oto-suite-dev.atlassian.net/browse/SCRUM-1068) · [Checklist evidence](../qa/proof-2026-11-25/SCRUM-1070/verification.md)

**Guest QR and staff tablet.** Three current branch QR links opened the public production HR form backed by the new system. Returning a signed-in staff member to a protected HR link was fixed separately. The original printed QR's destination is still unknown. Obtain the scanned host and path before claiming the cause of the redirect. The branch staff list and the guest submission form are separate screens. On the staging POS, Till 1 was paired. A full-width staff tablet follows the guest's current step and edits and can scroll independently. Consent belongs to the guest. Verify both physical tablets in one paired session. SCRUM-1022 covers a separate online family queue. [Tablet portrait](../qa/jira-comments/attachments/SCRUM-1069/staff-tablet-portrait.png) · [Tablet landscape](../qa/jira-comments/attachments/SCRUM-1069/staff-tablet-landscape.png)

## Inbox, BEO and payment walkthrough

The existing test conversation contains **16 guest and 16 staff messages** with corrections. Check the final date, time, family details, attendance numbers, cake and allergy against the approved BEO. The deposit was **THB 1**, posted once at **18:45:57 Bangkok on 23 November**. Inbox sent one acknowledgement and the staging birthday manager received the alert linked to the conversation. Staff booked the date at **18:47:30**. That separate action produced the calendar entry and date confirmation. HR, BEO and POS reflected the deposit. The test had no chosen package, so POS had no balance quote. The guest side used the staging test channel. [Dated proof and conversation reference](../progress/STATUS.md) · [Inbox plan](../progress/plans/inbox-redesign/PROPOSAL.md)

For the next walkthrough, start from the existing paid booking. Compare the one payment with the thread alert, named staff recipient, calendar event and deposit in POS. Verify the Radar event and real WhatsApp delivery separately. Check the rules the park requested: additional-bill refunds are blocked, settlement preserves discounts, and one kitchen dish with serving times stays one billed item. Inspect the physical kitchen slip. Repeat attempts should not double-post or double-notify. The unverified checks do not require charging the existing booking again. [SCRUM-1006](https://oto-suite-dev.atlassian.net/browse/SCRUM-1006) · [Park test register](../progress/PARK_CHECKPOINT_2026-11-25.md)

## Next hardware visit at Central Floresta

**Card terminals.** SCB00 is the reporting master, SCB01 is the card merchant and SCB02 covers other methods including the tested PromptPay route. Each has a distinct merchant ID. The separate counter QR was cancelled unpaid. Hosted card checkout was reached. A paid card transaction, matching POS receipt, settlement and refund still need proof. The Digio PAX A920Pro uses the local LinkPOS serial interface. The Pi saw two USB interfaces, but a valid Terminal Info reply is outstanding. Ordinary SCB login returned it to Normal mode. The operator reported SCB requires a dedicated LinkPOS credential. Resume with the supplied credential on Till 1, confirm LinkPOS persists and verify the read-only Terminal Info exchange before testing an amount. A manual EDC receipt (SCRUM-54) proves a different workflow. Test the SCB/GHL NEXGO separately. [Payment plan and bench procedure](../progress/plans/real-payment-test/GATEWAY_CONNECTION_PLAN.md) · [SCRUM-709](https://oto-suite-dev.atlassian.net/browse/SCRUM-709)

**Gates.** SCRUM-68 is in **Sprint 2 – Complete build**. The existing Bingdie Android app on Exit reader **6661** reached the Pi, sent heartbeats and received the custom refusal “Connection test - no admission”. The app wrapped that message in a Java exception. A new Android app was unnecessary for this exchange. The handheld remote moved the barrier. That does not prove POS-controlled movement or passage. The test listener was stopped and the regular Pi box service restored. The legacy server timed out and its cause remains unknown. Confirm the Exit rollback in person, identify Entrance **6658** by a correlated reader request, verify the printer and confirm the passage sensor before testing occupancy. Check outstanding station assignment SCRUM-705. [Field log, settings, screenshots and resume procedure](../qa/proof-2026-11-23/SCRUM-68/gate-visit.md)

The owner requested ten acceptance checks. Record the actual reader result, physical movement, passage journal and POS count where relevant.

| Wristbands and time | Resilience and counts |
| --- | --- |
| 1. Child band refuses entry and exit. 2. Each wearer has a unique QR. | 8. Internet outage permits local POS and gate operation and replay creates no duplicates. |
| 3. Repeated entry is refused after the first adult has passed. 4. Entry, exit and re-entry work with the same band. | 9. Observe power-loss and recovery behaviour under the park's supervised procedure. |
| 5. Time keeps running while outside. 6. An overtime exit gives a clear cashier referral and red indication. 7. Adding time before or after expiry updates the same band. | 10. Children enter the count on the first adult's entry and leave on the last adult's exit. Compare POS with a real count. |

The 26 November source checks the deadline when known. Installation and park proof remain pending. The physical reader has yet to show a clean guest-facing refusal. Emergency/manual egress must remain available. No physical test band, POS-triggered opening, passage or headcount result was recorded. Trampoline hardware was reported in hand. No game integration or test result was established in this handover.

## Other holds and first decisions

- The historical import repair restored 65 links and reported 67/67 at the time. The post-import safeguard remains open on SCRUM-1062. Recovery of 55 historical signed contracts remains on owner hold, SCRUM-1057. The owner ruled that missing old media links should remain empty. [HR go-live plan](../progress/plans/go-live/PROGRESS.md)
- **Remote follow-up:** first verify any newer evidence on the employee's first sign-in, the owner's own OTP receipt, the face clock-in decision, and PR 14. These four facts could change the next action.
- **Park follow-up:** get the Digio credential privately, check the connected printers and paired displays, then use the saved gate test sheet with park staff present. Keep test records and real park events distinguishable.
- **Acceptance:** bring the park reviewers screenshots for the exact screen being tested. Record what happened, environment, time, matching event or receipt, and anything still blocked. The current ticket-by-ticket register names the remaining work. [Reconciled register](../progress/PARK_CHECKPOINT_2026-11-25.md)
