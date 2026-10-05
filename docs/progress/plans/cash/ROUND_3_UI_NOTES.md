# Settlement UI checkpoint — SCRUM-215 round 3

6 October 2026. Working tree: `oto-pos-eod-settlement-ui`, branch
`feat/eod-settlement-ui`, based on `33681345`. This slice is local, not landed
or staged. The platform worktree owns the shared settlement contract and API.

## Behaviour and source

The prototype's End of Day layout and existing cash count stay unchanged.
Settlement is an explicit SCRUM-215 addition defined in cash `PLAN.md` section
4, because the prototype has no settlement workflow. A shared responsive card
appears beside reconciliation in both desktop and phone End of Day views.
It reads the same selected park and trading date and never changes the count.

- Reception can read batches, match details and payments without a matched
  settlement. Only `pos:payment:settle` offers Run settlement.
- The terminal chooser comes from the guarded settlement response, not the
  administrator device register. Simulated terminals are labelled.
- Requesting a run means pending, not success. The panel refreshes every ten
  seconds and also has Refresh. Failed and unsupported results stay visible;
  unsupported explicitly says no payments were marked settled.
- A retry after an uncertain network/server answer retains the same
  idempotency key. Confirmed request acceptance releases it. No local action
  marks payment approval or rewrites a closed End of Day.
- CSV download selects an actual TID reported by the branch's devices,
  batches or unmatched attempts and includes the chosen trading date.
- Console Integrations, beside the existing payment gateway card, contains a
  manager-only 2C2P manual import and match view. The park picker uses the
  signed-in grants; the server still owns the definitive scoped check.
- Import requires an explicit park, trading date and non-empty CSV of at
  most 2,000,000 bytes. Default date uses the park's timezone and configured
  day start from `/branches`; if absent it must be selected. Date is sent in
  the body, never inferred from a filename.
- Help labels the H/D format as fixture-compatible pending an actual bank
  file. The exact columns are `TYPE_TABLE,invoiceNo,tranRef,paymentID,amount,
  currencyCode,transactionType,method` (one header line without whitespace).
  Refund and chargeback rows remain review evidence, not payment confirmation.
  No SFTP connection or live-file compatibility is claimed.

## Checks

- Existing POS End of Day files `eod-r1`, `eod-r1-hook`, `eod-r2`,
  `eod-r2-hook`: 22/22 pass. Three focused cases added inside the existing
  round-2 file cover non-success evidence, run identity and scoped CSV URL.
- Both app package typechecks pass, including Console end-to-end types.
- Scoped ESLint passes for every touched source/test file.
- POS and Console production builds pass (existing POS chunk-size warning).
- Existing Console smoke file: focused phone import flow passes, using a
  disposable seeded database and mocked settlement answers. It proves an
  oversized file causes no write, valid input includes park/date/identity,
  attention is displayed, and the 390px page has no horizontal overflow.
  The harness dropped its disposable database after the run.
- This is local UI verification. Root must deploy the matching API first,
  then both frontends and capture real staging terminal-run/import/match/CSV
  evidence for SCRUM-215. No staging evidence is claimed by this slice.

## Integration notes

Import `SettlementSummary` from the API slice's `@oto/shared` export. The UI
worktree's ignored app dependency junctions temporarily point at that shared
source to check types; no shared package source was edited here. On landing,
the API slice supplies the same export in the combined checkout.

Explicit files are the two settlement API helpers, POS `api/client.ts`,
`SettlementPanel.tsx`, both End of Day tabs and existing `eod-r2.test.ts`;
Console `api/platform.ts`, `SettlementImportPanel.tsx`, `Integrations.tsx`,
and existing `e2e/console-smoke.spec.ts`; plus this checkpoint. Do not include
the prohibited merchandise display file, generated output or dependencies.

## Staging follow-up: receipt progress

6 October 2026, 03:42 Bangkok. The staging closing walkthrough found that a
queued End of Day receipt stayed on its initial status until the screen was
reopened. `useEndOfDay` now rereads the closed day every three seconds only
while its latest receipt job is queued. It updates the receipt alone and
stops after the print result arrives. Changing park or date, replacing the
latest receipt job, or leaving the screen cancels that poll and ignores an
in-flight answer. Open counts are never polled or overwritten.

The existing round-1/round-2 hook suites pass 11/11. Added cases cover
queued-to-printed followed by no further reads, stale replies after changing
date or park while preserving an open typed count, and unmount cancellation.
POS source and test typechecks and ESLint for the two affected files pass.
This follow-up is local and still needs the integrating session's staging
retest. Additional explicit files: `apps/pos/src/components/eod/useEndOfDay.ts`
and `apps/pos/test/eod-r2-hook.test.ts`, plus this checkpoint.

## Retry review: requests still running

6 October 2026, 03:49 Bangkok. Both settlement screens retain the original
request identity after `IDEMPOTENCY_IN_FLIGHT`. That response says the first
request is still running, so a retry must not create another terminal run or
import. Definitive refusals still release the identity; uncertain network and
server answers keep it as before.

The existing POS hook suite now drives the settlement panel's terminal
selection and Run handlers through the in-flight refusal and verifies the
second press uses the same identity. Combined round-1/round-2 hook tests pass
12/12. The existing Console phone smoke case exercises the same refusal and
retry, verifies the same import identity, and passes with a disposable seeded
database, which the harness dropped after the run. POS source/test and Console
source/test/end-to-end typechecks and scoped ESLint pass. The shared result's new
`terminalRef` field is included in the existing POS rendering fixture.
