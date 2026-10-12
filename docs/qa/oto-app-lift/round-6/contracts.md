# Contracts - staging walkthrough, 12 October 2026

**WORKS for the recorded signing and download path.** On the source and launcher
sessions named in [the round record](README.md), a ZZ TEST employee and saved
employment template produced a contract (201). The public signing screen accepted
a drawn test signature and agreement (200), displaying 12/10/2026 at 820 x 1180.

The signed-in download returned 302 to a 300-second private link. Its object
returned 200 and 35,964 bytes beginning `%PDF`. Signed-out download returned 401;
the other park group's contract detail returned 404 and PDF request 403. Changing
the object signature returned 403; the unsigned object request returned 400 with
no PDF. No signing token or private URL is recorded here.

Evidence: [signed screen](../../jira-comments/attachments/SCRUM-191/r6-contract-signed-20261012-tablet.png)
and [private-download test-run card](../../jira-comments/attachments/SCRUM-191/r6-private-downloads-20261012-card.png).
Both were inspected. The card distinguishes HTTP checks from the actual screen.

Exact record and content-verified object cleanup is in [the round record](README.md#cleanup-read-back).
This does not add an in-park branch rule where the app has none (lift Q50), or
claim every contract action was walked. BEO generation has its separate round-7
walkthrough; these frames do not establish it.
