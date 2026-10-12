# Training and quizzes - staging walkthrough, 12 October 2026

**WORKS for the recorded staff quiz path.** On staging app `633cae41`, the
ZZ TEST training module saved with 201 and staff detail returned 200 without
the correct answer. The unsuccessful attempt saved with 200 and
`passed: false`; the successful attempt saved with 200 and `passed: true`.
Staff editing returned 403; another park's module read returned 404.

Evidence: [training completion screen at 820 x 1180](../../jira-comments/attachments/SCRUM-191/r7-training-completed-tablet-20261012.png),
already inspected. Module `f6be0f32-de2e-443f-820d-b47fb2daa91f` was the test
fixture. This establishes the two observed attempts, not every training
assignment variant. [The round record](README.md) names the serving source;
new round-7 source has not been established as deployed by this proof.

Cleanup owed: the exact module, recorded quiz attempts and progress rows.
Their final absence read-back remains outstanding.
