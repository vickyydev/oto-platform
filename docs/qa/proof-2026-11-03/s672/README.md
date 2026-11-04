# SCRUM-672 staging proof: stage (f) only, the release feed switched off

Run on 4 November 2026 at 15:57 to 15:58 Bangkok on live commit 4fa1762860ec468eefc658fbf6b7356c21f9fd45
(oto-api-staging dep-dbleqao473hc73b41330, oto-console-staging dep-dbleqao473hc73b414c0), in a real browser as the
staging administrator. Reads only; nothing was created, so nothing needed cleaning up.

| Plan step | Result | Evidence |
|---|---|---|
| (f) Releases shows the new fields as Not recorded or an empty history | Pass: "No releases are recorded", 0 records (`GET /console/releases` total 0) | `s672-f1-releases-history-card.png` |
| (f) job:release.feed absent from Health | Pass: 31 jobs on Health and Platform jobs, none of them the feed | `s672-f2-health-scheduled-jobs-card.png` |
| The three feed settings, names and presence only | RELEASE_FEED_RENDER_API_KEY, RELEASE_FEED_SERVICES, RELEASE_FEED_GITHUB_TOKEN: Not configured | `s672-f3-environment-feed-settings-not-set.png` |
| (g), (h), (i) | Not proved: the feed's settings were deliberately not set, because the Render key it needs is the owner's decision | none |

The readback is `s672-stage-f-readback.json`. Jira: comment 13450 with 3 images inline; the ticket stays at Testing.
