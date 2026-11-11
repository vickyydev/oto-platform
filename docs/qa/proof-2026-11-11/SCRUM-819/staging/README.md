# SCRUM-819 display pairing proof

Behavior checks and exact-fixture cleanup passed on 11 November 2026. Jira is
Deployed under the owner's 17:32 STATUS direction; exact-source CI and the
original full local API suite remain tracked, not claimed green.

Source `bfd04cd2fc9387a61c13eb822978ba40bd0a7cb0` was deployed by name to
oto-api-staging as `dep-dbq4d03rjlhs73b7cdp0`. The proof ran in
`C:/oto-lanes/codex-display-release-20261111`. Pairing at 17:47:21 Bangkok
recorded exactly the same first-seen timestamp before the first protected poll.
Twenty Console samples over 601.896 seconds showed Online and zero own alerts.
After only the test browser closed, one alert opened at 18:00:53 Bangkok;
a later Console read retained its ID. This does not prove a second watchdog
sweep. Integration tests cover repeated execution and notification delivery.

The original receipt remains `passed: false`: its final check saw a newer
deployment in progress after the behavior checks passed. `runtime-comparison.json`
records the independent readback and identical display, presence, watchdog and
alert blobs. The API advanced through the planner's releases to
`3cf7846e1bafd14ef9833bd338ebcfb6652e9081`; Console/till source trees were unchanged.
Other API behavior is not claimed identical. `proof-result.json` joins the
bounded results without changing the original receipt. The initial bootstrap
failure created no fixtures and is preserved in `bootstrap-attempt.json`.

Four inspected pictures are attached as 13077-13080: paired Online, masked Health,
the real Offline alert, and `s819-final-observation-card.png`. The masked Health
picture alone does not prove absence; the twenty bounded reads and labelled card
provide that evidence. The original observation card and failed final capture
are retained. No external notification receipt is claimed.

Cleanup passed: display `01a1ca38-2e49-7785-b6ae-943666b9ca7c` revoked;
station `01a1ca38-1824-74bf-9130-a7890f2693ea` archived with zero devices;
alert `01a1ca44-9209-7375-9e0b-01ac9a0b75ab` closed; sign-out 200, then /me 401.
No park screen, opening hour or service setting was changed.

Main CI 43005809520 was replaced while queued. Immutable validation 43007759803
runs at the exact source on `lane/codex-s819-landed-ci-20261111`. The full-SHA
main watcher recorded the cancellation; the validation watcher verifies its
head SHA before watching run 43007759803. Local full API session 38357 continues
untouched in the original display-presence worktree. These results still need
collection and whole typecheck reads; see the latest STATUS checkpoint.
