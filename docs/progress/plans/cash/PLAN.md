# Cash and End of Day: the build plan for S2-15a (revised)

_Revised 2026-10-02 after the owner's ruling on SCRUM-488 (Tony's call,
2 October): count all drawers together as one combined total for the day,
and for everything else follow the End of Day process that already exists.
Do not invent a parallel set of rules unless something is clearly missing
or broken. This replaces the first plan (c9185429), which proposed a
drawer-by-drawer count, manager-only close, refunds on the day the money
left, late corrections and credit outside the totals. Those proposals are
withdrawn. The per-drawer round 1 that was built before the ruling is kept
for reference on branch `wip/cash-round-1-per-drawer` and is not landed._

## 1. The reference

The existing process is the prototype's Today > End of Day screen. The
SCRUM-214 story names it as its source:

- `imports/oto-pos/artifacts/oto-till/src/lib/endOfDay.ts`:
  RECON_TOLERANCE_THB, DEFAULT_FLOAT_THB, lineFlag, reconVerdict,
  recomputeEndOfDay, channelLabel.
- `mockApi.ts`: getFloatCarryover (2210), getEndOfDay (2239) and
  closeEndOfDay (2348).
- `components/eod/`: EndOfDayTab, CashCountCard ("whole branch drawer"),
  ReconTable, ReconSummary, AmountInput, and the mobile
  MobileEndOfDayTab.

Where the prototype has nothing, SCRUM-215's own acceptance criteria
apply: paid-out and safe drop, the provisional close, the End of Day
receipt, the audit, settlement, and the stranded-occupancy list.

## 2. The existing behaviour, ported as it is

| Rule | The prototype's behaviour (kept) |
|---|---|
| Cash count | One count for the whole branch per day. Every drawer is counted together into one total. This is also Tony's call. |
| Float | Carried over from the "float left in drawer" at the previous close, or ฿6,000 when there is no earlier close. Shown read-only with where it came from. |
| Cash income | Counted minus float. The cash line's actual is this figure, so staff never type it. |
| Lines | Cash; PromptPay / QR; card per terminal (TID); each configured "other" method; e-wallet; bank transfer; party prepayments; credit. Expected comes from recorded sales net of refunds. Staff enter the actual for each line; cash comes from the count. |
| Tolerance | ฿1 on every line. A line is pending (not entered), ok or off, and the day's verdict is off, pending or ok. |
| Who closes | Any signed-in staff member who can open End of Day. |
| Closing | Allowed with lines that are off or pending. Notes are optional ("Explain any discrepancy"). At close the totals are worked out again (the caller's maths is never trusted), and the closer and time are stamped. |
| Second close | Refused; the screen reloads the locked day. |
| Closed day | Read-only, exactly as saved. Nothing rewrites it. |
| Refunds | A refund reduces its original sale, on that sale's day. On a multi-tender order, credit restored comes off the credit line and the rest is split pro rata across the order's cash, card and QR. |
| Credit | Its own line: credit redeemed minus credit restored. It is included in the day's totals, as the prototype does. |
| Also on the screen | Vouchers handed out and redeemed (staff counts); float left for tomorrow; "cash to bank tonight" = counted − float left. |
| Open day | Worked out fresh from the records each time it is opened. Only a closed day is stored. |

## 3. Fixed, because the prototype is clearly broken there

These are faults in where the figures come from, not changes of rule:

- **Other branches leak in.** The prototype does not filter by branch, so
  the platform reads only the branch's own records.
- **Wrong calendar day.** The prototype uses the UTC date, which in
  Thailand puts 00:00 to 07:00 on the wrong day. The platform uses the
  branch's business date, which every payment attempt already carries.
- **Card money is spread by a hash.** The prototype guesses each card
  sale's terminal from the transaction id (its own comment says production
  records the real TID). The platform uses the attempt's real TID.
- **Money with no terminal disappears.** In the prototype, card money with
  no terminal goes to "NO-TERMINAL" and drops out of the lines. The
  platform shows it on its own card line.
- **Nothing is kept.** The prototype holds everything in memory, so a
  closed day vanishes on reload. The platform persists the closed day.
- **Money that is not the till's.** Booking-site payments (no station) and
  the platform-written wallet and paid-online tenders do not exist in the
  prototype's ledger. They stay out of the till lines (countsAsTillTakings),
  so the lines match what the prototype would have shown.

## 4. From SCRUM-215, where the prototype has nothing

- **Paid-out and safe drop.** Recorded against the branch's day, from a
  "Cash" action on the till header. A paid-out needs an approver and a
  safe drop needs a witness. Both reduce the cash expected in the one
  combined count.
- **Provisional close.** While any box of the branch still holds sales it
  has not delivered, or has unresolved low clock trust, the day shows as
  provisional and close is refused with the reason.
- **Stranded occupancy.** Bands still counted inside the park, and
  children still checked in, are listed at close. A manual resolution with
  the operator and a reason (gate.manual_resolution) clears each row.
  Unresolved rows block the close until a manager overrides with a reason.
- **End of Day receipt.** Printed at close, on the closing counter's own
  series.
- **Audit.** Every close, paid-out, safe drop and settlement run is
  recorded.
- **Settlement.** Unchanged from the first plan: terminal settle(), the
  batch and its lines, awaiting_settlement becoming approved, a CSV per
  terminal per day, the 2C2P settlement import on a fixture, and the
  match view.

## 5. Known effects of following the prototype

These are flagged here, not changed:

- A cash refund for a sale from an earlier day comes off that earlier
  day. If that day is closed, its saved figures stay as they are, so
  today's drawer counts short by the refund. Staff explain it in Notes.
- Credit is included in the day's totals. Credit was paid for when the
  ticket was sold, so the total row counts that money twice. The cash,
  card and QR lines themselves are unaffected.
- A fact that reaches the platform after its day closed (for example, a
  late gateway fallback) does not appear on the closed day. The
  provisional close keeps the common case, an offline box, from arising.

## 6. The data model (migration 0052)

- `pos.end_of_day`: one row per branch and business_date, written at
  close. It holds the lines snapshot, the count, the float, where the
  float came from, the float left, voucher counts, notes, totals, closer,
  time and receipt number. It is unique on (branch, business_date).
- `pos.cash_movement`: append-only. Kinds paid_out and safe_drop, each
  with branch, business_date, amount, reason, actor, and approver or
  witness.
- `pos.settlement_batch` + `pos.settlement_line` (round 3).
- No drawer sessions, no refund business_date column, no correction table.

## 7. The rounds

| Round | Scope |
|---|---|
| 1 | Migration 0052. The End of Day service: expected lines per section 2 from payment attempts and refunds by the branch's business date; float carry-over; close with the server re-deriving the figures; second close refused; who may close. The Today > End of Day screens on real data, with the prototype's look and words unchanged. Paid-out and safe drop with the Cash action. Audit. |
| 2 | Provisional close (box depth, including the Pi heartbeat depth fix, and clock trust); the stranded-occupancy list with manual resolution and override; the End of Day receipt. |
| 3 | Settlement (as in section 4). |
| 4 | seed:demo-day scenarios, the closing audit, the staging walkthrough. |

Permissions: `pos:cash:day_close` goes to every role that can open End of
Day, reception included, because the prototype lets any signed-in staff
member close. `pos:cash:movement` records a paid-out or safe drop.
`pos:cash:approve` approves or witnesses one.
