# Employee review and movement history - SCRUM-194 / SCRUM-516

## Staging evidence - 13 October 2026

WORKS for the recorded explicit manager actions. Live source:5b2f049fba750403fe60284bf2b8b4855eb934b4. A disposable ZZ TEST employee without a user/person link was used; both selected branches belonged to its practice park.

| Action | Observed result |
| --- | --- |
| Complete the due probation review through the screen |200; exact request replay200 retains the same completion time; another park404. |
| Save a title-only change through the screen |201; replay201 returns the same change; changed payload409; another park404. |
| Transfer through the existing terms screen |200; replay200 retains one transfer; changed payload409; another park404. |
| Read changes and reload the employee screen |Two change rows, one title and one transfer; actor/time present in the API; current title/branch and both changes visible after reload. |

The transfer removed zero schedules and zero time-off rows. It moved only this unlinked synthetic employee and retained the existing immediate-transfer behavior. No seeded login access was changed. No contract was generated; the existing Not Now/Done action was used.

The inspected [saved history screen](../../jira-comments/attachments/SCRUM-194/employee-history-saved-staging-20261013.png) shows saved title/transfer values. The earlier [review and title card](../../jira-comments/attachments/SCRUM-194/employee-review-title-staging-20261013.png) separately records the completion/replay and actor/time read-back. The employee history screen does not itself display the actor.

The28 hosted action/history controls passed within the full green release. This record covers the named staged actions; final exact cleanup and parent-story completion remain.
