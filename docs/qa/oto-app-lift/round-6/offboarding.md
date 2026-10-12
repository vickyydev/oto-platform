# Offboarding - staging walkthrough, 12 October 2026

**WORKS for the recorded no-login resignation path.** On [the recorded staging
source and sessions](README.md), the administrator submitted the actual Offboard
form for the ZZ TEST employee with Personal reasons and a last working day of
18 October (201). The form generated the resignation letter (201). Read-back
found one offboarding and six checklist items; repeat submission returned 409.
The other park group's offboarding read returned 404.

The 820 x 1180 employee panel displayed Resigned, Personal reasons and 18-10-2026.
Evidence: [actual Offboarding panel](../../jira-comments/attachments/SCRUM-191/r6-offboarding-20261012-tablet.png),
inspected. The generated letter's signing and private download are on
[its page](letters.md).

The offboarding, six checklist items, change record and linked activity were
removed in [the exact cleanup](README.md#cleanup-read-back). The fixture had no
login: this does not claim staged linked-login deactivation. Transaction failure
injection belongs to the passing round-6 review suite, rather than this live
success case. The one-offboarding-per-person rule (Q47) is unchanged.
