# Optional attendance evidence - SCRUM-520

## Staging evidence - 13 October 2026

**WORKS for the current face-off guard and recorded reviewer reads.** Optional attendance evidence is built and its hosted controls passed. A successful face-enabled attachment submission on staging remains unavailable under the owner's standing Q9 setting.

The staging application ran `5b2f049fba750403fe60284bf2b8b4855eb934b4`. Face mode remained off throughout these observations; no identity or configuration changes were made to open the upload path.

| Observed action | Result |
| --- | --- |
| Submit the manual missed-clock confirmation | HTTP 403 with reason `face_off`. |
| Submit the unscheduled-work confirmation | HTTP 403 with reason `face_off`. |
| Read the manager's own pending issues | HTTP 200; zero pending issues. |
| Request pending issues for another park group's branch | HTTP 200; count0 and an empty issues list. |
| Open the manager review screen | One historical issue was visible; no Pending Approvals section was present. No Approve action was performed. |

The other-park pending read returned an empty issues list and count0, as recorded in the saved proof.

## Hosted controls

The exact green main release, GitHub Actions run `38309414401`, passed all six jobs. Attendance-specific evidence includes:

- Nine attendance-evidence review checks and six attendance-reviewer checks in API shard 2.
- The multipart check: valid upload; extra-file, size, type, empty and malformed refusals; refusal before parsing while face mode is off; existing JSON confirmation support.
- Six real-handler/database reviewer scenarios: pending scope and parent placement, access refusals, approval/replay, rejection/replay, rollback and competing decisions.

The separate 89 feature runtime checks cover staff inbox delivery (15), employee actions/history (28), family verification (23), SOP history (16) and Fix recipient preview (7). They are separate from the attendance-specific results above.

## Saved evidence

- [Kiosk mode on staging](../../jira-comments/attachments/SCRUM-520/attendance-kiosk-mode-staging-20261013.png).
- [Manager review on staging](../../jira-comments/attachments/SCRUM-520/attendance-review-staging-20261013.png).
- [Labelled hosted test-run card](../../jira-comments/attachments/SCRUM-520/attendance-controls-test-run-20261013.png).

All three images, including the latest test-run card, were visually inspected before attachment. The card records hosted controls; it is not evidence of a successful staging upload.

## Remaining acceptance

Keep face mode off under the existing Q9 decision. Retain the unavailable positive face-enabled staging path explicitly in acceptance. A successful staged upload, private attachment read and manager approval of that submitted attachment have not been observed in this journey. This record covers the named guard and reviewer observations and does not close the parent story.
