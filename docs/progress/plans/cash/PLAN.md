# Cash sessions and End of Day — the build plan for S2-15a

_Written 2026-10-02 from the requirement (SPRINT_2_PLAN §S2-15a, lines
2290-2347; dependants at 2860, 3582-3583, 3781-3782; coverage 6.8), the
rules R-38, R-44, R-45, R-47, R-101..R-106 and C17
(POS_RULES_RECONCILIATION), the brief (PROJECT_CONTEXT 149-150), the 2C2P
file format (PAYMENT_GATEWAY 535-560), and two read-only studies: the
prototype's cash and End of Day domain and the platform's landed seams.
The prototype's End of Day is one branch-wide screen with no sessions, no
movements, no settlement and no permission check, and several of its
expected-cash rules are bugs. This plan follows the requirement for
what the prototype lacks, keeps the prototype's screens and words, and
does not port the bugs it names (section 6). S2-14 is Deployed. Wallet
credit and paid-online bookings already have their own tender codes,
and every payment attempt carries its business date, station and terminal._

## 1. Closing the day, in the park's terms

A counter opens its drawer with a float: the float the drawer was left
with last night, or the default ฿6,000. Through the day, cash comes in at
that drawer, change goes out, and a manager can take a paid-out (signed
by an approver) or a safe drop (witnessed). At the end of a shift or day,
the person at the drawer counts it. The system already knows what should
be there, from the payments recorded at that station: the float, plus
cash taken, minus cash given back, minus paid-outs and drops. Any
difference is held against the person who closed the drawer and signed.
The manager then closes the branch's day. Every payment type is
reconciled: cash per drawer, card per terminal, QR. Wallet credit and
online bookings are shown beside the takings, never inside them. The day
cannot close while a counter's box still holds sales it has not
delivered, or while someone is still recorded as inside the park.
Closing locks the day, stamps who closed it, and prints the End of Day
slip on that counter's own series. A card terminal's batch is settled
and exported per terminal, and the gateway's settlement file is matched
line by line, with anything unmatched flagged.

## 2. The architecture

### 2.1 Data model (migration 0052, round 1)

- `pos.cash_session`: one per station drawer, open to close. Fields:
  branch, station, business_date it opened on, opened_by,
  opening_float_satang, closed_by, counted_satang, expected_satang
  (stored at close), variance_satang, status (open / closed), notes, and
  a sign-off with timestamp. A station with routing `cash: 'none'` has no
  session.
- `pos.cash_movement`: append-only, action-keyed. Kinds: float, paid_out
  (approver required), safe_drop (witness required), top_up, refund_out.
  Each row carries its session, amount, reason, actor, approver or
  witness, and business_date.
- `pos.refund` gains `business_date`: the day the money left the
  drawer, not the day of the original sale. The prototype's
  original-date rule is a bug and is not ported. Each cash refund slice
  writes a refund_out movement to the session of the drawer that paid
  it.
- `pos.end_of_day`: one per branch and business_date. Fields: status
  (open / provisional / closed), closed_by, closed_at, totals, notes, the
  printed slip's number, and a snapshot of the lines at close.
- `pos.recon_line`: per end_of_day. The channel is one of: cash per
  session, card per TID, qr, transfer, wallet_credit (beside the
  takings), paid_online (beside), booking_web (beside, the website's
  card/QR money, which is not till money). Each line has expected,
  actual where it is counted, difference and status.
- `pos.eod_correction`: append-only. A fact that arrives after its day
  has closed (a late offline sync, a gateway settle, a refund fallback)
  is recorded here against the closed day. It shows on that day and
  needs a manager's acknowledgement. A closed day's figures are never
  rewritten.
- `pos.settlement_batch` + `pos.settlement_line`: per TID per day, from
  the terminal's settle(), plus imported gateway settlement lines.
- `analytics.fact_cash_daily`: per branch, date and channel, following
  the landed daily-fact pattern.

### 2.2 Cash sessions (round 1)

A session opens when a cashier takes a drawer at a station, from the
till header's "Cash" action. The float carries over from the drawer's
last close, or the default. Only cash attempts at that station count
toward expected cash: platform-written wallet and paid-online tenders
never do (countsAsTillTakings, now actually called), and nor does a
booking-site attempt (station_id null). Paid-outs and safe drops need
their second person. Closing takes the count, stores expected and
variance, and is held against the closer. The prototype's
CashCountCard, AmountInput and EndOfDayTab keep their look and move from
mock data to the platform. The `pos:cash:*` permissions are enforced on
the server.

### 2.3 The branch End of Day (round 2)

The recon lines are built from payment_attempt, refunds and cash
movements by business_date, in satang:
- cash per closed session;
- card per TID;
- qr, and transfer;
- wallet_credit and paid_online beside the takings (the prototype
  counted credit inside them: fixed);
- booking_web beside.

Close is refused, with the reason, while:
- any box of the branch has an undelivered outbox, or an open quarantine
  or anomaly for this branch's day (the stationLink depth bug is fixed:
  a Pi's depth comes from its heartbeat);
- any session of the day is still open;
- anyone is recorded as inside the park.

The stranded-occupancy list offers an audited manual resolution
(gate.manual_resolution, with operator and reason), and a manager may
override with a reason. Closing locks the day and stamps the closer
(pos:cash:day_close). The End of Day slip prints on the closing
counter's own series (R-47). Later facts become eod_correction rows.

### 2.4 Settlement (round 3)

- Terminals: the terminal contract gains settle(). The simulator returns
  a batch, and the real Digio/GHL protocols are coded to their specs.
  The batch number and rrn are kept, no longer dropped by the allow-list.
- Attempts: awaiting_settlement attempts in a settled batch become
  approved.
- Export: a CSV per terminal per day with one line per approved card/QR
  attempt (TID, approval code, invoice, amount).
- Gateway file: the 2C2P H/D settlement import runs as a job. It reads a
  fixture now; the real file waits on the sandbox (the invoiceNo column
  is uncertain, so the column map is a setting). It matches on
  invoiceNo or tranRef and flags unmatched lines both ways.
- Screen: a Console /money match view.

### 2.5 Closing (round 4)

- seed:demo-day gains the wallet, voucher and refund scenarios.
- The closing audit walks the whole flow: open session → cash and card
  sales → paid-out → refund in cash after a sale from the previous day →
  offline sale arriving after the close → count and variance → day
  close → correction → settlement → export.
- Then the staging walkthrough.

### 2.6 Not this story

- Analytics summaries and Today > Performance (S2-15b).
- Party prepay: parties are not on the platform yet, so the channel
  arrives with the party story.
- Xero posting (waits on the owner's connection).

## 3. The rounds

| Round | Scope | Lands |
|---|---|---|
| 1 | Migration 0052; cash sessions and movements; expected cash from the ledger; refund business_date and refund_out; count and variance; the till's Cash action; the drawer screens on real data; permissions | first |
| 2 | Branch End of Day: recon lines; the provisional gate (box depth incl. the stationLink fix, quarantine, open sessions, stranded occupancy); lock and closer; corrections; the End of Day slip | after 1, in parallel with 3 |
| 3 | Settlement: terminal settle() (simulator + real protocols); batches and lines; awaiting_settlement → approved; CSV export; the 2C2P import job on a fixture; the Console match view | after 1, in parallel with 2 |
| 4 | Demo-day scenarios, the closing audit, the staging walkthrough | last |

File fences for rounds 2 and 3: round 2 owns the End of Day services,
routes and screens, ops/station link, occupancy closure and print.
Round 3 owns the terminal/payments adapters, settlement services and
routes, jobs entries for imports, and apps/console. Neither touches
sale.ts beyond round 1.

## 4. Open decisions (the recommended answer holds unless the owner objects)

**OD-CS1: Several drawers, one day.** The requirement's sessions are per
drawer or station, but its acceptance is per branch and day.
Recommended: each drawer has its own session, count and variance, held
against whoever closes that drawer. The branch End of Day rolls up the
closed sessions plus the non-cash lines, and is closed by a manager.

**OD-CS2: Who closes the day.** The prototype lets any signed-in person
close. The permission seed gives pos:cash:day_close to managers.
Recommended: managers only (the permission). Reception can still close
their own drawer session.

**OD-CS3: Tolerance.** The prototype uses ฿1 for every line.
Recommended: ฿1 per session, as a branch setting.

**OD-CS4: Refunds land on the day the money leaves.** The prototype
lands them on the original sale's day. Recommended: the refund's own
business day, from the drawer that paid it.

**OD-CS5: A closed day is never rewritten.** Late facts become visible
corrections on the day they belong to, acknowledged by a manager.
Recommended as written.

**OD-CS6: Wallet credit and online bookings sit beside the takings.**
The prototype added credit into the expected total. Recommended:
separate lines that are never counted against the drawer.

## 5. Known hazards (from the seams study; each gets a test)

- Booking-site attempts (station null) leaking into till card/QR totals.
- countsAsTillTakings having no callers: it must now be the one gate.
- Refunds having no business_date, and cash slices living in jsonb.
- Gateway/void fallbacks paying cash later with no session.
- Offline tenders dated to a closed day.
- The stationLink depth reading 0 on a Pi.
- Card attempts with null TID (manual entry) needing their own line.
- Partial-approval reversals still pending.
- The box's tookCash rule differs from the cloud's kind lookup.
- Tendered and change not captured by the till (cash received = amount
  due today): the count works from amounts, and capturing real tendered
  cash is listed as a follow-up.

## 6. Prototype bugs not ported

- Branch leak in the expected figures.
- UTC date instead of business date.
- Card revenue spread across TIDs by a hash.
- NO-TERMINAL silently dropping revenue.
- Credit counted inside takings.
- Refunds landing on the original sale's date.
- Close with pending or off lines, by anyone, with no note: an
  out-of-balance close needs a note.
