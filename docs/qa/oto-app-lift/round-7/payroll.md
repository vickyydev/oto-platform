# Payroll files - staging walkthrough, 12 October 2026

**13 October release recheck: WORKS for the recorded private export boundary.** On the released R7a application, another park's generation and existing-file download returned403; own download returned200 with73 bytes and signed-out download401. The inspected [camp/payroll test-run card](../../jira-comments/attachments/SCRUM-191/r7-camp-payroll-release-rechecks-20261013.png) records the synthetic future2099 bank-file check. No calculation, new export or existing salary advance was changed. Other formats retain their earlier evidence; exact cleanup remains owed. The earlier observation below is retained as history.

**WORKS for the recorded synthetic exports; BROKEN for the other-park export
boundary.** On staging app `633cae41`, an isolated zero-value future-2099
operator/period/run/summary fixture was prepared through Data Admin (201 each).
Calculation was not run and normal period creation was not verified.

| Export | Generation | CSV download | Bytes |
| --- | --- | --- | --- |
| Bank transfer | 200 | 200 | 73 |
| Journal | 200 | 200 | 223 |
| SSO filing | 200 | 200 | 87 |
| PIT filing | 200 | 200 | 46 |

Staff export returned 403. Another park's export returned 200, assigned to
SCRUM-516 for its staging recheck after delivery. Payslip generation returned
200; the admin PDF returned 200, 56,696 bytes and `%PDF`, while signed-out
download returned 401. The first self-read returned 403. A separate directly
linked synthetic staff fixture returned a 59,922-byte `%PDF` with 200; the
practice account was subsequently observed restored as admin (200).

Evidence: [payroll exports screen](../../jira-comments/attachments/SCRUM-191/r7-payroll-exports-tablet-20261012.png),
already inspected. It shows the existing DRAFT warning, not a calculated run.
New round-7 source remains local. See [the round record](README.md).

Cleanup owed: both exact synthetic run families and their fingerprint-checked
CSV/PDF objects. Preserve the existing employee and salary advances; remove
only the separately recorded synthetic employee. Final read-back remains owed.
