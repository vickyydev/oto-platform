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

## Staging proof plan and limits

After green exact-source CI and API/POS deployment, use the retained dedicated
ZZ TEST box and till from SCRUM-717. Create a new synthetic booked registration,
guard its exact identity before clearing its fixture consent, then use the real
Console offline switch and unchanged booked-arrival dialog. Compare the missing
platform consent before reconnect with the counter timestamp and source-event
audit afterward. Inspect and attach the evidence before Deployed.

No physical Pi, real person, real payment or SMS is part of this proof. The
virtual mount uses the existing platform session; fresh offline staff unlock is
outside this unit. Recovery, display and POS-server lane files are untouched.

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

Both follow-ups are To Do and linked to SCRUM-708. The retry uses a new family,
an existing guarded unpaid F&B quote to enter the box lane, and native SPA
navigation to Check-in. It must inspect the box request and platform state on
each side of reconnect; the switch alone does not establish offline proof.
