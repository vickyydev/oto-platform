# SCRUM-708 — consent acknowledged at an offline booked arrival

The existing booked-arrival dialog is unchanged. Its positive acknowledgement
now carries the counter time through the offline request, box fact and durable
registration overlay. Reconnect fills only a missing registration consent and
writes an audit row naming the source fact. An existing timestamp stays intact;
an older fact without the optional field replays with its previous behavior.

## Local verification

- Client fallback: the acknowledgement time precedes the failed platform call
  and stays identical across the separate paid-sale requests.
- Real SQLite agent: missing acknowledgement refuses in the online sentence;
  malformed acknowledgements fail validation. A cut before commit leaves no
  consent, band or fact. The successful retry and restart retain all three,
  preserving an existing photo and a refreshed platform consent.
- Real API/box replay: missing consent is recorded at the counter time, with one
  audit naming the box fact; existing consent (including an online update after
  the box cached the record) is unchanged. A repeated press writes once. An
  older fact checks the child in without inventing consent.
- Four deliberate HIGH mutations reproduced their prescribed `it.fails`
  findings, with every other pin passing; the source and passing pins were
  restored. Receipt: [s708-review.json](s708-review.json).
- Focused tests: 6 POS, 11 native box, 6 API review tests passed. API, box-agent,
  shared and POS typechecks passed; API printed no diagnostics. Changed-file
  eslint and `pnpm api-types:check` passed; generated files did not change.

The full native box and shared suites passed. The full POS suite passed all
1,636 tests with two workers, followed by the production build. The first POS
run overlapped three API shards and timed out at the unchanged
`s221-r4-closing-audit.test.ts:125` source scan (1,635 passed); its unchanged full
rerun passed without raising the timeout or changing any assertion.

Full API regressions passed: 6,091 tests across all three shards, with the
existing 401 skips and four TODOs unchanged (427 passing files, eight skipped).
All 16 workspace typecheck tasks and five production builds passed. The rebase
onto `54271076` changed only other-lane documentation; product bytes match the
completed run. Main source `796a3724505ee9cd46f93584c975971ad50a3e4d` passed
CI [41452442131](https://github.com/vickyydev/oto-platform/actions/runs/41452442131).

## Source release

Source release: `14e1432492f603e3b774d512aa797e5a57061595`.
Exact-source CI: [41459443462](https://github.com/vickyydev/oto-platform/actions/runs/41459443462),
all six jobs passed; the exact-SHA watcher exited zero. The run completed at
2026-11-02T14:33:14Z. Full receipt: [s708-ci.json](s708-ci.json). The workspace
job includes its tests, production build, built till and Console browser
journeys. The unchanged OTO App job is path-gated; this is not a new full-app
acceptance claim. Jira remains Testing pending inspected staging proof.

## Staging proof

The native proof passed at **2026-11-02T15:00:53.219Z**, after API deployment
`dep-dbk9ubavcj2c73frrc8g` went live at 14:37:01.972371Z. API, POS and Console
all reported the exact source above. Receipts: [s708-staging-proof.json](s708-staging-proof.json)
and [s708-fixture.json](s708-fixture.json). The [proof card](s708-staging-proof.png)
and its native dialog/board screenshots were opened and inspected.

| Step | Observed result |
| --- | --- |
| Before | New registration `a657ed65-d7a9-4539-bc02-4da688df399e` had null consent and a registered child. An exact-identity fixture guard cleared only this synthetic registration before check-in. |
| Offline | Console Go offline succeeded on the dedicated test box. An unpaid native F&B quote entered the box lane; native Check-in navigation preserved it. The unchanged dialog sent `check_in_now` to the box with a positive acknowledgement. |
| Held locally | Box consent was `2026-11-02T14:59:25.617Z`, one fact was queued, and the independent platform registration still had null consent and registered status. The native board showed the child in the park. |
| Reconnect | The platform received exactly `2026-11-02T14:59:25.617Z`; the queue drained to zero. One consent audit, `01a19cc5-cbe7-74d5-9585-83c0daefacee`, names box fact `01a19cc5-bd26-7032-a3c7-e1ab38fff1d7`, with the correct box and station. |
| End of journey | The synthetic child was released through the ordinary pickup API, its lease was released, and POS/Console/launcher sign-outs returned 200 followed by `/me` 401. |

The native images show only the synthetic family and seeded administrator.
The stored consent and pickup images are generated test cards, not photographs
of a person. Synthetic cash receipts `Z717-000002` (the earlier online control)
and `Z717-000003` (the offline proof) are retained for audit; both children are
out. The unpaid F&B quote used to select the lane was never charged.

No physical Pi, real person, real payment or SMS is part of this proof. The
virtual mount uses the existing platform session; fresh offline staff unlock
and physical printing are outside this unit. Recovery, display and POS-server
lane files are untouched. The local tests establish power-loss/restart,
existing-consent, duplicate and older-fact cases; those cases were not newly
injected into staging.

## Staging attempts and separate follow-ups

The first attempt found that the small checkbox did not stay selected. Clicking
the consent sentence works. The second attempt completed online, so it does not
count as offline evidence: after a fresh page load, the booked-arrival route
answered on the platform despite the Console switch. Independent database
readback found one consent audit with no box source event. That synthetic child
was released normally; its consent was not reset. A third attempt safely stopped
at the initial missing-consent assertion. The retained receipts are
`s708-first-attempt.json`, `s708-second-attempt.json`, `s708-third-attempt.json`
and `s708-online-control.json`.

- Q708-1 / [SCRUM-722](https://oto-suite-dev.atlassian.net/browse/SCRUM-722):
  clicking the small consent control leaves check-in disabled, while clicking
  the sentence selects it. The enclosing button and nested checkbox both handle
  the same click. The prototype dialog is explicitly outside this change.
- Q708-2 / [SCRUM-723](https://oto-suite-dev.atlassian.net/browse/SCRUM-723):
  Console forced-offline mode does not fence booked arrival on a fresh till
  page. The station-offline plugin checks `stationTrading`; this route has only
  `dynamicPermission`. The browser initially selects the platform lane. This
  is a test-routing follow-up, not evidence that consent replay failed.

Both follow-ups are To Do and linked to SCRUM-708. The successful retry used a
new family, an existing guarded unpaid F&B quote to enter the box lane, and
native SPA navigation to Check-in. Its actual box request, queued fact and
platform before/after values establish the offline path; the Console switch
alone does not.

## Cleanup and publication

Independent cleanup readback at 2026-11-02T15:06:00.194Z confirms both synthetic
children out. Before retirement the dedicated box was online with zero queued
facts and no lease. Only its ZZ TEST station and box were archived; primary
`virtual-1` remains unarchived. Only `BOX_AGENT_TEST_SLOT` was removed: all other
56 environment values were compared and preserved. The same-source API restart
`dep-dbkabnp42hec73f3o42g` went live at 15:05:31.56138Z; health and readiness
returned 200, and the temporary option is absent. The final readback session
also signed out 200 and then returned `/me` 401. Receipt:
[s708-cleanup.json](s708-cleanup.json).

The final PNG is copied under
`docs/qa/jira-comments/attachments/SCRUM-708/s708-staging-proof.png` for attachment.
The two inspected control-target images are retained under the SCRUM-722
attachment directory. Jira remains Testing until this evidence is pushed and
the proof is attached. Done remains the owner's acceptance.
