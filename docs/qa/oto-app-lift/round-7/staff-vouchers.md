# Staff vouchers - 13 October 2026

**Released server contract: WORKS.** On stagingd18d3fd8, all seven mutation doors (template create/edit/delete, staff issue/bulk issue/revoke and redemption) return409 with vouchers_moved before processing. The inspected [administration/voucher card](../../jira-comments/attachments/SCRUM-191/r7-administration-voucher-rechecks-20261013.png) records these results. No voucher was issued, revoked or redeemed.

WORKS for the central Console entry contract on staging app633cae41. Each existing address, `/core/vouchers`, `/core/my-vouchers`, `/core/vouchers/redeem` and `/studio/vouchers`, displayed the notice that vouchers have moved to the Console and the link to open it. The notice explains that voucher types and the ledger are managed there and slips are redeemed at POS tills.

Evidence: inspected [Console notice](../../jira-comments/attachments/SCRUM-191/r7-vouchers-console-tablet-20261013.png). No voucher was issued or redeemed by this check. The round-7 server write refusals remain subject to the post-release check; this page proves the serving screen contract only.
