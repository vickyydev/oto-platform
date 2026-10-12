# Vault - staging walkthrough, 12 October 2026

**WORKS for the recorded metadata and allowed reveal.** On staging app
`633cae41`, the ZZ TEST credential saved with 200. Metadata did not contain
its value. The allowed reveal returned 200 and matched the synthetic value
held only in memory. Staff and another park's reveal each returned 404.

Evidence: [metadata-only Vault screen at 820 x 1180](../../jira-comments/attachments/SCRUM-191/r7-vault-metadata-tablet-20261012.png),
already inspected. The screenshot does not show a revealed value. Credential
identifier: `e9f54215-7fff-4b09-ad55-d38d1178445b`. This establishes the
observed roles; no additional manager rule is inferred. The serving source
is named in [the round record](README.md); new round-7 source remains local.

Cleanup owed: this exact synthetic credential and its recorded test
relations. Final removal read-back has not yet been recorded.
