# Letters - staging walkthrough, 12 October 2026

**WORKS for the recorded resignation-letter path.** On [the recorded staging
source and sessions](README.md), the Offboard screen generated a letter from the
saved ZZ TEST resignation template (201). Its public signing screen accepted the
drawn test signature and agreement (200), displaying 12/10/2026 at 820 x 1180.

The administrator's download returned 302 to a 300-second private link, whose
object returned 200 and 40,777 bytes beginning `%PDF`. Signed-out download returned
401 and the other park group's download 404. Changing the object signature
returned 403; the unsigned object request returned 400 with no PDF.

Evidence: [signed letter screen](../../jira-comments/attachments/SCRUM-191/r6-letter-signed-20261012-tablet.png)
and [private-download test-run card](../../jira-comments/attachments/SCRUM-191/r6-private-downloads-20261012-card.png),
both inspected. Signing tokens and private URLs remain outside the evidence.

The letter, its template and content-verified private object were removed with
[the round's exact cleanup](README.md#cleanup-read-back). Other letter types and
in-park branch choices (Q50) are not established by this resignation case.
