# End of Day round 2 — the build brief (S2-15a, SCRUM-215)

## Continuation checkpoint (6 October 2026)

The partial WIP has been transplanted into `feat/eod-round-2-review` in the
isolated `oto-pos-eod-round-2` worktree. Its old 0055 migration conflicted
with applied voucher migrations; the schema and append-only trigger now have
forward-only migration 0058, generated from the 0057 snapshot. The unrelated
arrival audit test was left out. Failed outbox records, disabled boxes with
pending work, action-ID reuse with changed details and receipt counter
ownership were repaired. Focused round-2 and round-1 checks pass, as recorded
in the latest STATUS and STOP POINT. The source passed CI 37356476121 and was rebased onto main with no
application/package changes. Receipt review confirms financial values and
channel keys are frozen; descriptive names use the existing current-record
lookup pattern. Land, deploy API before POS and capture actual staging screenshots. Settlement and
demo-day rounds remain separate work after round 2.

_Written 2 October 2026 for the round-2 build, and kept so the work can be
continued from any session. Plan: `PLAN.md` sections 2-4 and 7._

## Scope

The existing End of Day design has no provisional state, no stranded list
and no receipt. Add them in the same design language, next to where the
design would put them, keep every existing word and layout, and list each
as a UI addition. Round 1's rules stay exactly as they are: one combined
count, ฿1 tolerance per line, any `pos:cash:day_close` holder closes, a
closed day is frozen, refunds come off the original sale's day, and the
credit line stays in the totals.

1. **Provisional close.** `GET /branches/:id/end-of-day` reports every box
   of the branch that still holds undelivered sales or facts (outbox depth
   above 0, including a Pi's depth read from its heartbeat), or has
   unresolved low clock trust. While any exists, the day shows as
   provisional with the reasons (box name, how many are waiting, since
   when), and `POST .../close` is refused 409 with the reason in the
   counter's words.
2. **Stranded occupancy.** At close, list the bands still counted inside
   the park and the children still checked in for the branch and day.
   Each row shows the last gate event, the sale and the guardian.
   - A manual resolution per row clears it from the count and is audited
     as `gate.manual_resolution`. The reasons are: left without scanning,
     band lost, gate fault. The operator is recorded.
   - Occupancy history is kept and never silently zeroed.
   - Unresolved rows block the close until a manager (`pos:cash:approve`)
     overrides with a reason. The override is audited as
     `end_of_day.override` and shown on the closed day.
3. **End of Day receipt.** When the day closes, the receipt prints through
   the platform's printing on the closing counter's own printer and
   receipt series (R-47). It carries the day's lines, the count, the
   float, the float left, the cash to bank, the closer and the time. A
   reprint is available from the closed day.
4. **The till.** The End of Day tab shows the provisional banner, the
   stranded list with its resolve action, the manager override, and the
   receipt print and reprint (desktop and mobile).

## Tests (`eod-r2*`)

- A box with a waiting outbox makes the day provisional and refuses the
  close, naming the box.
- A Pi whose heartbeat reports depth is counted.
- Low clock trust refuses the close.
- A stranded band resolved by hand clears and is audited.
- Unresolved rows refuse the close; a manager override with a reason
  closes the day and is audited; reception cannot override.
- The receipt prints once on close, on the closing station's series, and
  a reprint works.
- Replays are idempotent.
- Round 1's `eod-r1*` suites stay green.

## State at hand-over (2 October, late)

The builder's partial work is on branch `wip/eod-round-2-inflight`. It is
not reviewed. What it has:

- **Migration `0055_eod_round_2`** (journal idx 55, chained from 0054):
  - `pos.occupancy_resolution`, append-only;
  - `pos.end_of_day` gains `override_by_account_id`, `override_reason`,
    `override_stranded`, `receipt_number` and `receipt_station_id`;
  - the receipt-series and print-job kinds are widened to `end_of_day`.
- **Server**:
  - `services/end-of-day.ts`: `provisionalBoxesOf` and `resolveStranded`;
  - `station-session.ts`: `boxBacklogOf`, with a Pi's depth taken from
    its heartbeat;
  - `occupancy.ts`: `strandedOf`, and the count honours resolutions;
  - a receipt document in `end-of-day-receipt.ts`;
  - `sale-printing.ts`: `queueEndOfDayReceipt`;
  - routes `POST .../end-of-day/stranded/resolve` and
    `POST .../end-of-day/reprint`.
- **Till screens and first tests** (snapshot 66bdcdf8, 29 files):
  ProvisionalBanner, StrandedList, EodReceiptCard, the End of Day tabs and
  hook, and `eod-r2*` tests in api, pos and db. None of it is reviewed yet.
- **Leave out** `apps/api/test/arrival-r5-audit.test.ts`. It is an older,
  unrelated file that the snapshot picked up.

To continue:

1. Compare the branch with main.
2. Finish what is missing against this brief.
3. Run a focused review that attacks the provisional state, the stranded
   list, the receipt, round 1 being unchanged, and the landing surface.
4. Fix what the review finds, then land.
