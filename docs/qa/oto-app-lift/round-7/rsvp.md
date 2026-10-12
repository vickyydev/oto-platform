# RSVP - staging walkthrough, 12 October 2026

**WORKS for the recorded response.** The public RSVP screen on staging app
`633cae41` submitted the ZZ TEST response with 200. The owning event's RSVP
read returned 200 and exactly one response. Another park's RSVP read returned
403. This records the app's existing response flow without adding a new
editing or expiry rule.

Evidence: [submitted RSVP at 820 x 1180](../../jira-comments/attachments/SCRUM-191/r7-rsvp-submitted-tablet-20261012.png),
already inspected. Response identifier:
`42d4eb56-7a48-4e98-9c6c-6e5ff17d3185`. The public capability is omitted.
See [the round record](README.md) for serving source and release limits;
this does not establish new round-7 source as deployed.

Cleanup owed: this response and its exact guest/event relation, followed by
the event cleanup. The final absence read-back has not yet been recorded.
