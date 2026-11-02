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

Full API regressions and release CI are pending. No staging acceptance is claimed.

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
