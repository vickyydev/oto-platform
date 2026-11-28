# Park operations checkpoint, 25 November 2026

This review covers work reported from 21–25 November. It includes the 20 SCRUM issues returned by the updated-date search and four related issues checked individually. Jira statuses below reflect the readback on 25 November. The HR findings apply to production. POS and Inbox tests used staging, including the one payment that moved real money.

## Production HR and staff access

| Jira | Verified outcome | Remaining work |
| --- | --- | --- |
| SCRUM-1063, SCRUM-1064 · Deployed | Managers can register the HR clock tablet. Staff can clock using a photo and their registered phone. The clock supports an approved alternate number for the same account. | Face recognition has its own ticket. |
| SCRUM-1056 · To Do | Staff can use the existing tablet clock. | The face clock-in proposal awaits approval. |
| SCRUM-1065 · In Progress | A staff account was linked to its active employment. | Confirmation of first sign-in for the outstanding report remains open. |
| SCRUM-1067 · Deployed; SCRUM-1061 · To Do | Recovery for eligible unverified staff numbers was released. The isolated administrator recovery fix passed staging on `a35440b2a` and reached production on `5b9bf5b9a`. The administrator chose to request their own code. | SMS delivery to that administrator remains unconfirmed. The public reset screen gives a conditional response. The separate wording request stays open. The source and handover for the isolated release await [PR 14](https://github.com/vickyydev/oto-platform/pull/14). |
| SCRUM-1066 · Deployed; SCRUM-1022 · To Do | Launcher return to a protected HR page was fixed. New branch guest QR links opened the public form on production HR. | The destination encoded in the old printed QR is still unknown. Obtain a scan preview to explain the reported redirect. The POS online family queue is a separate open feature. |
| SCRUM-1068, SCRUM-1070 · Deployed | Retired-shift dates became available for replacement. Reception Closing completed with all five items and eleven evidence files. | The manager selects any replacement. Final checklist acceptance remains with the owner. [Checklist verification](../qa/proof-2026-11-25/SCRUM-1070/verification.md). |
| SCRUM-1062, SCRUM-1057 · To Do | The 21 November import repair restored 65 links and reported 67 of 67 linked at that readback. Historical contracts remain on owner hold. | Add the post-import safeguard. The recovery or reconstruction of 55 missing original contracts remains unverified. |

## Staging POS, Inbox and BEO

| Jira | Verified outcome | Remaining work |
| --- | --- | --- |
| SCRUM-709 · In Progress | On 23 November the SCB02 route took one real THB 1 PromptPay deposit after a 32-message staging conversation. The payment posted once at 18:45:57 Bangkok. Inbox acknowledged it and notified the staging birthday manager. Staff separately booked the date at 18:47:30. The calendar, BEO and POS reflected the booking and deposit. A different counter QR test was cancelled unpaid. | Verify real WhatsApp delivery and the corresponding Radar payment event. SCB01 reached hosted card checkout. A paid card receipt, settlement and refund remain unverified. |
| SCRUM-54 · Deployed | Manual EDC receipt recording is available. In the separate automated Digio test, the Pi saw two USB interfaces. Ordinary SCB sign-in returned the PAX to Normal mode. The operator reports SCB requires a dedicated LinkPOS credential. | Resume SCRUM-709 with the correct credential, confirm a Terminal Info reply, then match the physical card result to a POS receipt. The other park terminal also needs its own test. |
| SCRUM-1006, SCRUM-1007, SCRUM-1008, SCRUM-1009 · Deployed | Staging checks covered additional-bill refund blocking, discounted settlement, one billed kitchen dish with serving times, the manager alert opening its conversation, and a retryable refusal for offline price edits. | Run the manager walkthrough. A physical kitchen slip and a real guest messaging channel remain separate checks. |
| SCRUM-959, SCRUM-1045, SCRUM-1069 · Deployed; SCRUM-1051 · Testing | The staged till and Inbox layouts were updated. The full-width staff tablet follows the guest's drop-off step and edits. Staging tablet emulation covered touch scrolling in portrait and landscape. The guest controls consent. | Verify the layout on the park's paired tablets and inspect a physical print. |

## Gate commissioning

[SCRUM-68](https://oto-suite-dev.atlassian.net/browse/SCRUM-68) is **In Progress** in **Sprint 2 – Complete build**. The installed Bingdie Android app reached Till 1 from the Exit reader and displayed the diagnostic refusal. That exchange worked with the existing app. No physical passage or headcount change was verified. SCRUM-705 remains **To Do** for assigning the gate to one station.

At the next visit, confirm the Exit reader settings after the temporary listener was stopped, verify the Entrance connection and passage feedback, and print an isolated test band. Run the ten documented cases, including family headcount against a physical count, offline replay and power loss. The 26 November source includes an overtime refusal for a known end time. Park verification is pending, and emergency/manual egress must remain available. See the [gate field record and ten acceptance checks](../qa/proof-2026-11-23/SCRUM-68/gate-visit.md).

## Tracking changes

Jira was updated on [live payments](https://oto-suite-dev.atlassian.net/browse/SCRUM-709), [face attendance](https://oto-suite-dev.atlassian.net/browse/SCRUM-1056), [staff access](https://oto-suite-dev.atlassian.net/browse/SCRUM-1065) and [reset-screen wording](https://oto-suite-dev.atlassian.net/browse/SCRUM-1061). The other reviewed statuses already matched the available evidence. No issue was moved to Done.

Current work is also indexed in the [HR go-live plan](plans/go-live/PROGRESS.md), [payment integration plan](plans/real-payment-test/GATEWAY_CONNECTION_PLAN.md), [Inbox proposal](plans/inbox-redesign/PROPOSAL.md) and [owner's November decisions](plans/dropoff-beo-20261119/ANSWERS.md).
