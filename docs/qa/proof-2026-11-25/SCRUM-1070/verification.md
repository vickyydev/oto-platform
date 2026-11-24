# Shared reception closing checklist

On 24 November, Central Floresta's Reception Closing checklist had five checked items and eleven saved evidence files. All required evidence was present. No note was required. Requests during the incident showed reads of the run but no final close request.

## Staging

The final staging build was `6817b1a37ebefa01d3450e770b143525f8c9c6b6` in deployment `dep-dc31b517lnhs73bv6s5g`. Two independently signed-in users opened the same disposable operational checklist. Both item updates were sent concurrently. The staging checks covered the following outcomes.

| Action | Observed result |
| --- | --- |
| Both users check their item with a note and a photo still outstanding | The run stays In Progress at 2/2. The server refuses manual completion. |
| First user saves the note | The run stays In Progress until the required photo arrives. |
| Second user uploads the photo and saves it on the item | The server completes the run and records that user's identity. The first phone shows Completed and the saved evidence count on its next refresh. |
| First user retries completion and attempts an item edit | The completion time and closer stay the same. The item edit receives HTTP 409. |
| Inspect the 390 by 720 mobile layout | The completion button clears both the bottom navigation and the floating report control. |

The screenshots are [missing evidence](../../jira-comments/attachments/SCRUM-1070/01-mobile-missing-evidence.png) and [completed checklist](../../jira-comments/attachments/SCRUM-1070/02-mobile-completed.png). Both were inspected and attached to Jira. The synthetic checklists and linked staff profiles were removed. Both synthetic photo objects were removed after their hashes and absence of item references were checked.

## Production

The backport is based on the live HR release `92264da39da245e13bf2a94af5a166e57914ed5f`. It changes the checklist page and the HR routes. The server fix first went live in `dep-dc31anp7lnhs73bv65qg`. The final backport is `ff8157774ca03ba7b924b3109fe15e0a9a664814` in `dep-dc31cqajnfac73b09b8g`.

Job `job-dc31cvbm8hqs73al9bl0` checked the branch, run, template, original status, five completed items, eleven evidence files, all requirements and the final item timestamp in a transaction. It set the run to Completed and inserted one audit entry. Readback confirmed the effective completion time was 24 November at 20:15:59 Bangkok time. The correction preserved the individual staff, evidence and timestamps.

Render reported the final backport live. The real app domain returned HTTP 200 and served the corrected checklist bundle with the mobile footer and outstanding requirements.
