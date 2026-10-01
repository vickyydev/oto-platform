# OTO App signed-in staging screenshots — 30 September 2026

The documented administrator entered through the suite launcher and reached OTO App Today without a second password. These are reviewed captures of the live `oto-app-staging` UI, not mockups or test-run cards. They are attached to the named Jira tickets and to SCRUM-193 where relevant. Personal email addresses visible in the Data Admin captures were masked before attachment; no credential value was captured.

| Ticket | Screenshot | What is visible | Remaining acceptance |
| --- | --- | --- | --- |
| SCRUM-193 | `scrum-193-staging-signed-in-today.png` | Signed-in Today page and task/notice sections | Full S2-17b module acceptance |
| SCRUM-453 | `scrum-453-staging-analytics.png` | Admin Analytics, Xero unconnected | Staging staff refusal and positive Xero exchange |
| SCRUM-454 | `scrum-454-staging-checkins.png` | Check-ins staff board, empty Registered list | Drop-off and cross-branch refusal |
| SCRUM-457 | `scrum-457-staging-supplier-tokens.png` | Supplier Access Tokens page, empty | Live token and supplier action |
| SCRUM-458 | `scrum-458-staging-learn.png`, `scrum-458-staging-quizzes.png` | Learner and Studio pages, empty | Staging quiz, completion and authoring save |
| SCRUM-460 | `scrum-460-staging-find.png` | Find & Learn page, no SOP articles | Publication and branch visibility |
| SCRUM-461 | `scrum-461-staging-kb.png`, `scrum-461-staging-ask.png` | KB and Ask OTO entry pages, no articles | Source answer and branch isolation |
| SCRUM-462 | `scrum-462-staging-casual-workers-page.png` | Central Floresta Casual Workers, zero rows | Rate, write, branch and role cases |
| SCRUM-463 | `scrum-463-staging-vault-page.png` | Vault controls, zero items | Sealed write, audited reveal, role and branch cases |
| SCRUM-464 | `scrum-464-staging-notifications.png` | Notifications panel, no items | Notification read and second tenant context |
| SCRUM-466 | `scrum-466-staging-model-index.png`, `scrum-466-staging-users-list.png`, `scrum-466-staging-user-detail.png` | Credential models absent from index, Users without password-hash column, blank password detail | Specific defect Deployed; wider registry and operator-admin checks remain on SCRUM-193 |

For SCRUM-466, a separate signed-in staging API check returned 200 for model index, Users list and user detail; each removed model endpoint returned 404; neither Users response contained a password field. No response body or secret value was recorded. The direct check and three screenshots are named in the ticket's Deployed comment.

The in-app browser screenshot service timed out on fresh tabs, including an unrelated blank page. The repository's existing browser-test tooling captured the images without changing application code. This evidence-only checkpoint did not redeploy the app or claim a new CI result.

## Added 1 October 2026

| Ticket | Screenshot | What is visible | Remaining acceptance |
| --- | --- | --- | --- |
| SCRUM-193 | `scrum-193-package-saved-tablet-2026-10-01.png` (Jira attachment 11203) | Saved synthetic birthday package in Event Settings | Event package snapshot and tenant refusal |
| SCRUM-193 | `scrum-193-set-menu-saved-tablet-2026-10-01.png` (Jira attachment 11204) | Saved synthetic one-item set menu | Event selection and tenant refusal |

The exact synthetic package, line item and menu were removed after capture. Both images are real staging browser captures at an 820x1180 viewport; neither image is a mockup.
