# Inbox delivery status and retry - SCRUM-521

## Staging evidence - 13 October 2026

**WORKS for the recorded inbox delivery, exact replay and unavailable-inbox retry cases.** The feature release was `5b2f049fba750403fe60284bf2b8b4855eb934b4`.

The positive case used a synthetic employee linked to the acting administrator's account in the same practice park. One Ping was submitted through Live Timekeeping. Pending was captured on screen, and Delivered was observed after reload through the normal live read. The linked account's Notifications screen showed the actual message.

| Observed case | Result |
| --- | --- |
| Normal live read after reload | HTTP 200; the exact delivery was Delivered. |
| Replay the original delivery request | HTTP 200; the same delivery ID was returned and exactly one matching inbox notification existed. |
| Reuse the request with a changed date | HTTP 409. |
| Read the recipient's notifications | HTTP 200; one matching notification, also shown on the actual Notifications screen. |
| Recover the owned delivery through the read-only recovery route | HTTP 200; the existing Delivered result was returned. |
| Send a Ping for another park's employee | HTTP 404. |
| Recover the delivery from another park | HTTP 200 with an empty result. |

Delivered means the message is stored and available in the linked inbox. Read/unread remains a separate state. The observed delivery after reload and the exact API replay do not establish a successful controlled-interruption Retry journey.

## Unavailable inbox and screen Retry

A separate synthetic employee without a linked login returned HTTP 200 with delivery state Failed and no notification. The actual Retry control in the off-tab recovery area returned HTTP 200 for the same request and delivery ID. The result remained Failed because the employee still had no inbox, and its notification count remained zero. The positive delivery still had exactly one notification after this separate trial.

This proves that an unavailable inbox is reported plainly and remains retryable. It does not claim that this failed attempt later became Delivered.

## Staging images

The following images were inspected:

- [Pending delivery](../../jira-comments/attachments/SCRUM-521/inbox-unconfirmed-staging-20261013.png) - the captured pending state.
- [Delivered after reload](../../jira-comments/attachments/SCRUM-521/inbox-delivered-staging-20261013.png) - the recovered Delivered state.
- [Recipient inbox](../../jira-comments/attachments/SCRUM-521/inbox-recipient-staging-20261013.png) - the actual notification in the linked account's inbox.
- [Failed-inbox Retry](../../jira-comments/attachments/SCRUM-521/inbox-failed-retry-staging-20261013.png) - the actual Retry retained the Failed state for the same delivery.

## Coverage and remaining work

The source includes 15 presence runtime controls covering additional delivery and recovery cases. That coverage is separate from the staged actions recorded here. A successful controlled-interruption Retry and delivery to a different recipient account were not established by this staging journey.

Remaining feature acceptance and exact fixture cleanup stay with the parent story. No credentials or private request identifiers are included in this record.
