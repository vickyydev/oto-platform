# Events, parties, camps and the self-service kiosk: the build plan for S2-20 (SCRUM-217)

_DRAFT, 6 October 2026. Not committed. Written from a read-only study of
`main` at 483cc443, the prototype under `imports/oto-pos/artifacts/oto-till/src`
and Jira (read only). Proposed home when it lands:
`docs/progress/plans/events-kiosk/PLAN.md`. Migration numbers are given at
landing: the next free number on main is 0064, and S2-15b and S2-21 will also
take numbers. (The analytics PLAN's "migration 0063" is out of date, because
0063 is `stock_single_each_pack`.) SCRUM-217 stays To Do until work starts._

The owner's rule applies throughout. The prototype's rules are ported as
they are. Only data-reliability additions are made on our own authority.
Every rule choice is a question in section 11, and the prototype's behaviour
is the default until the owner answers.

## 0. Unmet dependency: read this first

The ticket says `Depends on: S2-11, S2-12, S2-17b`. S2-11 and S2-12 are
Deployed. **S2-17b (SCRUM-193) is In Progress, and the parts this ticket
needs are NOT BUILT.** It is also ordered after CP5, which is after this
ticket.

| What S2-20 needs from S2-17b | State on main | Source |
|---|---|---|
| `otoapp_v.events` (with attendees and per-day attendance) | NOT BUILT: there is no `otoapp_v` anywhere in `apps/` or `packages/` | closure-plan.md:9, SPRINT_2_ACCEPTANCE.md:68 |
| `otoapp_v.children` (to link an attendee to a `crm` child) | NOT BUILT | same |
| Directory write-back: `POST /api/directory/events/:id/attendees` and `.../checkins` | NOT BUILT: the directory API has 6 GET routes only | apps/oto-app/server/routes.ts:13740-13865 |
| A Directory identity that names the tenant | BROKEN: one shared key, no tenant | closure-plan.md:9 |
| A place in the OTO App for a flat entry price, `parentAttending`, and per-child rows on one-off events | MISSING: `core_events` has `total_value` and `prepayment_amount` only; one-off bookings (`studio_event_bookings`) hold counts, not children | apps/oto-app/migrations/0000_otoapp_baseline.sql:1968, 2633 |

**What this means for the order of work.**

- The **kiosk half** (rounds K1 and K2) needs none of this. It reuses
  S2-04 (box and kiosk pairing), S2-06 (print and scan), S2-11 (bands) and
  S2-12 (redemption), and all of those are Deployed. It can start first.
- The **events, camps and parties half** (rounds E1 to E5) cannot start
  until a round 0 slice of S2-17b lands. Round 0 is owned by the platform
  lane (closure-plan s4), and it covers the views, the tenant-bearing
  Directory identity, the two write endpoints and the additive OTO App
  columns.
- A recommendation for Jira: split SCRUM-217 into a kiosk subtask and an
  events subtask, and pull the "POS seams" bullet of SCRUM-193 forward as
  its own subtask, ordered before the events subtask.

S2-15b (SCRUM-216, In Progress) is not a blocker. The analytics PLAN keeps
the Parties bucket at 0 until this ticket lands (analytics PLAN s6).

## 1. What the park sees

- **At the till (Tickets).** Step 1 shows an "Event passes" card for each
  camp running today and for each event today or later. Parties never
  appear there. Selling a pass takes the guest's details, takes the flat
  entry price, and then asks "check in now or leave booked". For a guest
  phone the till does not know, the till asks for a name first.
- **On the Check-in board, Events tab (phone and tablet).** Today's camps,
  events and parties each have a roster with "checked in", "outstanding"
  and "not today" groups and headline counts. Staff can check a child in,
  which prints a kid band and, when the parent is staying, a parent band.
  Staff can also check a child out, reprint a lost band, or add a walk-up at
  the door.
- **On the header's Events tab.** A day's events with a read-only roster.
  Opening a party shows the party bill: the package, the line items, the
  deposit, the POS charges, the payments and what is still owed. Staff can
  add extra tickets or F&B to the tab, take a payment, edit the party's
  details, and show the guest a settlement screen.
- **End of Day.** The "Party prepayments" line is filled from real party
  payments instead of the 0 it shows today.
- **Online (/book).** Event passes can be bought online and are checked in
  when the booking is redeemed (section 11, Q6). Today /book stops at Pay
  for passes (consistency register #21, fallback).
- **The self-service kiosk.** This is a new screen. A family scans their
  booking QR. Their bands print and their wallet credit is loaded. If the
  booking includes a child who must be supervised (drop-off or nanny), the
  screen sends them to the staff desk for that part. If the printer fails,
  nothing is issued and they are sent to the desk.
- **Admin and Console.** An "Events" panel under Operations for the walk-up
  prices (camp day, event day, party guest). Console > Devices pairs the
  kiosk, and a Kiosk tile on Health shows whether it is online, its
  printer and paper, its last redemption and how many sessions were
  abandoned.

## 2. The reference (the prototype)

All paths are under `imports/oto-pos/artifacts/oto-till/src`.

- `lib/eventPass.ts`: `sellEventPass` (52-105), `checkInSoldPass` (114-125),
  `dispatchEventBracelets` (133-156).
- `lib/eventRoster.ts`: `bucketAttendee` (20), `groupAttendees` (50),
  `computeRosterStats` (81), `ROSTER_FILTERS`.
- `lib/party.ts`: `partyLineItemsTotal`, `partyExtraChargesTotal`,
  `partyExtraChargeGroups` (38), `partyPaymentsTotal`, `computePartyTotal`
  (62), `computePartyOutstanding` (65), `PARTY_EXTRA_KIND_LABELS`,
  `PARTY_STATUS_LABELS`.
- `lib/printRouting.tsx`: `eventBraceletPrintJobs` (321).
- `mockApi.ts`: `getEventsForDate` (3604), `getActiveEventPasses` (3632),
  `getEventById` (3650), the event band counter (3657), `campRangeDays`
  (3698), `addEventAttendee` (3726), `checkInEventAttendee` (3785),
  `checkOutEventAttendee` (3846), `updateParty` (3874),
  `addPartyExtraCharge` (3906), `addPartyPayment` (3938), the End of Day
  `party_prepay` channel (`getEndOfDay` 2239, the loop at about 2298-2304),
  and online passes in `createBooking` (1085-1115).
- `store/catalogStore.ts`: `getEventDropInPricing` (1147),
  `updateEventDropInPricing` (1540). Seeds: camp ฿600, event ฿350, party
  guest ฿450 at HKT (677-679), and 0 at the second branch (883).
- `types.ts`: `PartyExtraCharge` (1311), `PartyPayment` (1322),
  `PartyBooking` (1344), `EventType` (1414), `EventAttendeeCheckin` (1418),
  `EventAttendee` (1428), `OtoEvent` (1454), `EventDropInPricing` (1876).
- UI:
  - `pages/Events.tsx` (a read-only roster: it passes no `checkInDate`, line 103)
  - `pages/DropOff.tsx` (Events tab at 664-670: check-in, check-out, reprint; walk-up add at about 230-300)
  - `pages/Till.tsx` (pass flow 103-200; redemption-time pass check-in 437-462)
  - `components/parties/*` (PartyDetail, PartyBalanceModal, PartyTicketModal, PartyFnbModal, PartyEditForm, AddAttendeeModal, EventAttendeeList, PartySettlementCustomerScreen)
  - `components/mobile/parties/*`, `components/mobile/dropoff/MobileDropOffBoard.tsx`
  - `components/till/{EventPassCard, DoorCheckInChoiceModal, StepCustomerType:150-163, StepIdentify}`, `components/shared/AttendeeFormFields.tsx`, `components/book/BookEventPasses.tsx`
- **There is no kiosk in the prototype.** For the kiosk the authority is
  PROJECT_CONTEXT s7.6 ("one implementation, two surfaces; kiosk mode and
  device sessions are shared with the booth"), R-80, proposal story 18
  ("device failure never marks handoff"), and the ticket text.

The copies in `apps/pos/src/lib/{eventPass,eventRoster,party}.ts` are
byte-identical to the prototype's and still call `mockApi`.

## 3. The prototype's behaviour, ported as it is

| Rule | The prototype's behaviour (kept) | Source |
|---|---|---|
| One event model | There are three types: party, camp and event. The Events module (the OTO App) owns creation and registration. The POS reads events, checks people in, prints bands and sells passes. | types.ts:1414-1500, R-96, C10 |
| Passes list | Shows a camp whose date range covers the date, and events dated today or later. Parties are never listed, because they have no flat price. Sorted by date, then start time. | `getActiveEventPasses` |
| Pass price | One flat price per event, as a weekday/weekend pair resolved by today's rate mode. It is never tiered and never a membership rate. | `sellEventPass` 55-56, R-98 |
| Paid pass | A paid camp or event pass needs a tender. Without one, nothing is created: no attendee and no sale. | `sellEventPass` 57-58 |
| Free event | Price 0 creates the attendee with no sale. | `sellEventPass` 72 |
| Party walk-up | The walk-up is added to the party, and a "Walk-up guest — name" ticket charge at the party-guest price is added to the tab. There is no door payment, and the guest is checked in straight away. | `sellEventPass` 63-71, AddAttendeeModal 206-212 |
| The pass sale | A one-kid sale at the default tier, with the line `svc-camp-pass` "Camp day pass" or `svc-event-pass` "Event entry pass", duration "One-time", under the **tickets** category, with no credit grant. | `sellEventPass` 73-101 and its comment at 39-42 |
| Pay first, then the check-in choice | The attendee and the sale are saved before "check in now / leave booked" is asked. Closing that choice never undoes a payment. | `sellEventPass` doc, AddAttendeeModal 224-244 |
| Walk-up modes for a camp | "Also register for the full camp". Off (the default) means today only. On means the camp's date range. The note is stamped "Walk-up added by <staff> (today only / registered for full range)". Events and parties have no attendance days. | `addEventAttendee`, AttendeeFormFields 246-258 |
| Check-in | One check-in per attendee per date. A second one is refused ("Already checked in", "This child is already checked in for today."). | `checkInEventAttendee` 3793, DropOff.tsx 155-158 |
| Not registered today | For a camp, the Check in button is disabled and the row reads "Not registered for today". | EventAttendeeList 273-290 |
| Bands at check-in | A kid band always, plus a parent band when `parentAttending`. The kid band has no gate access and the parent band has gate access. Both share an attendee group, so the kid follows the group in the occupancy count. Event bands carry no F&B credit and `mayOrderFood=false`. The kid band carries the allergy and diet lines. | `checkInEventAttendee` 3808-3837 |
| What the band prints | Event title, date, start and end time, kid name, diet and allergy (only when flagged), and the parent's name on the parent band. | `dispatchEventBracelets`, `eventBraceletPrintJobs` |
| No printer | The check-in stands and the toast says "Checked in — no printer … bracelet not printed". | DropOff.tsx 161-167 |
| Reprint | Reprints use the stored band codes and never touch the check-in record. Only allowed while the attendee is checked in and not out. | DropOff.tsx `handleEventReprint` |
| Check-out | Refused unless checked in and not yet out. | `checkOutEventAttendee` 3855 |
| No supervision gate | Event check-in never asks the S2-13 supervision questions. | R-97 |
| Roster | Buckets are in, out, outstanding and not today. A camp attendee whose attendance days miss the date is "not today" and is left out of the totals. arrived = in + out; expected = arrived + outstanding; all includes not today. Filters are All, Checked in and Outstanding. | `eventRoster.ts` |
| Party bill | total = base price + line items + POS charges. outstanding = max(0, total − deposit − payments). Charges are grouped "Extra tickets" first, then "Extra F&B", and the adjustment line shows any discount. | `party.ts` |
| Party charge | A ledger entry: kind ticket or fnb, the items, a total that is never negative, and who charged it. It is not a sale: it issues no bands, sends no kitchen ticket and moves no stock. | `addPartyExtraCharge`, PartyTicketModal 184-197, PartyFnbModal 238-249 |
| Party payment | Whole baht, capped at the outstanding balance, refused at 0, and any enabled payment method may be used. | `addPartyPayment`, PartyBalanceModal 95-101 |
| Party edit | The till may edit a party's fields. Identity, branch and the two POS ledgers are protected. The edit is stamped with who and when. | `updateParty` |
| End of Day | Party payments get their own `party_prepay` line, whatever the method, and are never folded into cash or card. Counted: payments taken on the date, for parties held on that date. | `getEndOfDay` 2298-2304 |
| Walk-up prices | Three weekday/weekend pairs per branch: camp day, event day and party guest. | `EventDropInPricing`, catalogStore |
| Online passes | A paid online booking registers each pass's attendee (today only, stamped "Online booking"). Redeeming the booking at the till checks each pass in and prints its bands, with no second payment. Already checked in is skipped. | mockApi 1085-1115, Till.tsx 437-462 |

## 4. Fixed, because the prototype is broken there (data reliability)

These change where facts come from or how they are kept. They do not
change any rule:

- **A camp disappears after its first day.** `getEventsForDate` matches
  `e.date === date`, and a camp's `date` is its start day. So from day 2
  the Check-in board stops listing the camp. The prototype's own camp
  rules assume the camp shows every day: the passes list uses the date
  range, the roster has a "not today" bucket, check-in is per date, and
  walk-ups can register for the full range. The platform lists a camp on
  every day of its range. This is confirmed as Q4, because it is the one
  fix that is visible on screen.
- **Wrong calendar day.** The prototype uses the UTC date
  (`toISOString().slice(0,10)`), which puts 00:00 to 07:00 Bangkok time on
  the previous day. The platform uses the branch's business date, as End
  of Day already does.
- **An online pass on the wrong day.** The prototype registers an online
  pass for "today", meaning the day the booking was made, because a
  prototype booking has no visit date. Platform bookings carry a visit date
  (consistency #55), so an online pass is registered for the booking's
  visit date. Without this, the child would sit in "not today" on the day
  they come.
- **"Not registered for today" is only a disabled button.** The service
  (`checkInEventAttendee`) never checks it. The platform refuses that
  check-in on the server too.
- **Two tills, one child.** The prototype's same-day check is in memory.
  The platform enforces it with a unique key per (attendee, date). Box
  facts that arrive from offline are resolved against that key, so a
  second band is never minted.
- **Two tills taking the last of a balance.** The cap at the outstanding
  balance is enforced inside the transaction, with the party tab row
  locked.
- **Event band codes.** The prototype counts upwards from 3000. The
  platform mints signed band codes through the S2-11 band service. That is
  an id format, not a rule.
- **Nothing is kept.** In the prototype the attendees, check-ins, tabs and
  payments vanish on reload. The platform stores them, and every write to
  the OTO App is tracked as an `ops_run` that can be retried. A failed
  write shows "pending" on the roster instead of disappearing.
- **The OTO App's tables are never touched directly** (C10). The POS reads
  only through `otoapp_v.*` and writes only through the directory API. A
  grep test holds the POS API to that.

## 5. From the ticket, where the prototype has nothing

- **The self-service kiosk** (PROJECT_CONTEXT s7.6, R-80):
  - **One redemption, two surfaces.** The kiosk calls the same redemption
    as the till (`redeemBookingAtCounter` online, and the box-side
    `bookingRedeem` on the box) with `surface='kiosk'`. The usual checks
    run: this branch, paid, not yet redeemed, signature valid, and the
    local redemption log checked.
  - **Supervised children are never issued at the kiosk.** Drop-off and
    nanny lines go to the staff desk. A mixed booking issues the
    self-service part and sends the guest to the desk for the rest.
  - **Hand-off is recorded only after the bands have printed.** A printer
    fault, paper out or an offline box aborts the whole redemption. The
    booking stays unredeemed, `kiosk_session.outcome` is `failed` with the
    reason, and the till can still redeem it.
  - **An idle timeout** returns to the attract screen and records the
    session as abandoned. This is the ticket's addition. The timeout length
    is Q9.
  - **The kiosk never shows allergy, medical or contact data** (R-58).
- **The Admin "Events" panel** for walk-up prices. The prototype has
  `updateEventDropInPricing` but no screen calls it. This is a UI addition
  in the prototype's admin shell.
- **Write-back health.** Each directory call is an `ops_run` of kind
  `integration` under `otoapp:attendee.create` or `otoapp:attendee.checkin`,
  and can be retried from Failures. `job:events.cache_refresh` keeps the
  box's copy of today's events fresh, with an `ops_expectation` so that a
  stale copy raises an alert.
- **Offline.** Check-in and check-out are box facts, so they queue while
  the box is offline. Selling a pass and taking a party payment follow the
  sale and tender rules that already exist.

## 6. Known effects of following the prototype

These are flagged here, not changed:

- **Payment timing.** A party payment taken today for a party on another
  day appears on no day's End of Day line and in no day's Performance
  bucket. The analytics PLAN has the same note and asks the same question
  (analytics Q3). One answer should cover both (this plan's Q3).
- **Card money paid towards a party is on the `party_prepay` line, not the
  card line.** It still settles in the card terminal's batch, so the
  terminal's own total and the End of Day card line differ by the party
  payments. Staff reconcile it from the party line.
- **Party charges are not sales.** So they print no kitchen ticket, issue
  no bands for extra tickets, and move no stock. The money reaches the
  books only as the party payment. The VAT export reads sales, so party
  money is outside it unless Q3 says otherwise.
- **A full-camp walk-up pays one day's price** at registration and nothing
  at later check-ins (Q5).
- **Party payments are recorded without a sale.** A `payment_attempt` with
  no sale is already allowed (`payment_attempt.sale_id` is nullable), so
  card, QR and cash take the real path. End of Day must then keep those
  attempts off the cash, card and QR lines and put them on `party_prepay`
  only (H10).

## 7. Where the ticket text differs from the prototype (the prototype wins until answered)

| Ticket text | Prototype | Default here |
|---|---|---|
| Pass sale `revenue_category=events` | "tickets" category (eventPass.ts:39-42). `events` is not in `TAXABLE_CATEGORIES` (catalog-shapes.ts:84) | tickets, keeping the `svc-*-pass` ids for reports (Q2) |
| `party_charge.sale`: party payments go through the tender machine as sales | Charges and payments are ledger entries only | Ledger as in the prototype. A payment is recorded through the tender machine so the money is real, but it is not a sale of goods (Q3) |
| Check-in and check-out on the Events tab | They are on the Check-in board's Events tab. The header Events tab is read-only | The prototype's placement |
| Includes leave out reprint, online passes, the mobile party and event screens, the till's name capture and member pre-fill | All of these are in the approved design | Included (Q6) |
| `event_drop_in_pricing` read for camp and event | Only `partyGuestTHB` is read. Camp and event use the event's own `entryPriceTHB` | Store all three, read party guest only (Q8) |
| "Advance to the next camp day" | Not possible from day 2 (the section 4 defect) | Works once the camp lists on every day |

## 8. Data model and migration needs (numbers assigned at landing)

**Round 0, owned by S2-17b, not this ticket.**

- An additive OTO App migration (in `apps/oto-app/migrations`, the app's own
  migrator):
  - a weekday/weekend entry-price pair on camps and one-off events
  - `parent_attending` on camp registrations
  - per-child attendee rows for one-off events, or an agreed mapping (Q7)
- The views `otoapp_v.events`, `otoapp_v.event_attendees`,
  `otoapp_v.event_attendance` and `otoapp_v.children`, mapping
  `core_event_type` onto party, camp and event (Q10). The OTO App branch id
  (varchar) maps to the platform branch through the SCRUM-268 branch seam.
  Camp attendees come from `camp_registrations.attendance_days`, and the
  per-day state from `camp_attendance`.
- A tenant-bearing Directory identity, plus
  `POST /api/directory/events/:id/attendees` and
  `.../attendees/:attendeeId/checkins`, both accepting the client-minted id
  so that a retry is a replay.

**This ticket (platform migrations):**

- `pos.event_attendee_link`. It holds: operator, branch, `otoapp_event_id`,
  `otoapp_attendee_id`, type, the `crm` child and member, sale and sale
  line, parent_attending, attendance_days, price snapshot, source
  (till, booking, kiosk or otoapp), `sync_state` (synced, pending or
  failed), account, station, box and timestamps.
  `UNIQUE(otoapp_event_id, otoapp_attendee_id)`. It replaces the unused
  `pos.attendee` placeholder in `future.ts`. Either drop that placeholder
  or leave it untouched; this plan proposes leaving it untouched until the
  sprint's clean-up.
- `pos.event_checkin`. It holds: link, attendance_date, checked in and out
  times and who did each, the kid and parent band ids, station, box,
  origin and box_seq. `UNIQUE(link_id, attendance_date)`.
  - Which side owns check-in state (Q1) decides whether this table is the
    master or a mirror of `camp_attendance`.
- **`pos.band` gains event bands.** Today `sale_id` is NOT NULL
  (sales.ts:1345), and the F&B allergy lookup goes from band to a
  `pos.checkin` stay (band-food.ts `stayForKey`).
  - The expand-only change is: `sale_id` becomes nullable, an
    `event_checkin_id` column is added, and a CHECK requires exactly one of
    the two.
  - The existing kind and gate checks already fit: the kid band has no
    gate access, and the parent band is `adult` with gate access.
  - The band group for occupancy is the event check-in.
  - The F&B lookup learns the event band. It returns the allergy and diet
    lines and `mayOrderFood=false`.
- `pos.event_drop_in_pricing`: branch, then camp_day, event_day and
  party_guest, each a weekday/weekend satang pair. Seeded from the
  prototype's values.
- `pos.party_tab`. It holds: branch, `otoapp_event_id`, status, a snapshot
  of the base price and line items, deposit and deposit date, the last
  edit stamp, and `version` for the row lock.
- `pos.party_charge`: tab, kind (ticket or fnb), items jsonb, total_satang,
  account, station, charged_at. **No sale** under the default (Q3).
- `pos.party_payment`: tab, method token, amount_satang (whole baht),
  `payment_attempt` (so the card, QR and cash flow is the real one),
  business_date, account, station and taken_at.
- `pos.kiosk_session`. It holds: station, device credential, box, started
  and ended times, booking, `outcome` (issued, handed_off, failed or
  abandoned), reason, and the issued band and sale ids.
- **Sales with no person behind them.** `pos.sale.created_by_account_id` is
  NOT NULL, and `core.idempotency_key` is keyed by account. A kiosk
  redemption has no account.
  - Proposal: add a nullable `device_credential_id` on `sale`, with a CHECK
    that one of the account and the device is set.
  - Kiosk writes are made idempotent by the box fact or action id, not by
    the account-keyed table.
  - The alternative is a per-kiosk service account. That is an engineering
    choice for review, not an owner question.
- End of Day: the `party_prepay` line reads `pos.party_payment` instead of
  the constant 0 (end-of-day.ts:205-206).

## 9. The rounds

| Round | Scope | Acceptance |
|---|---|---|
| 0 (S2-17b slice, platform lane, prerequisite for E1-E5) | The section 8 round 0 items: the views, a POS read and grep test, the tenant-bearing Directory identity, the two POST endpoints, the additive OTO App migration, the event-type mapping (Q10) and check-in ownership (Q1). | The views return a seeded camp, event and party. A directory POST replayed with the same id makes one attendee. A cross-tenant call is refused. The grep test is green. |
| K1 (unblocked) | Kiosk redemption core: a kiosk caller on the box bridge holding the device credential's scope (`pos:kiosk:redeem`); the supervised split; issue, then print, then commit, with abort on any print fault; `kiosk_session`; the sale's device actor; idempotency by action id; audit `kiosk.redeem`, `kiosk.handoff` and `kiosk.abort`, with the station and box in the row. | Checks 5 and 6 pass against the virtual kiosk box in tests. A replayed redeem issues once. |
| K2 | Kiosk surface: the `/kiosk` route in `apps/pos` in the prototype's design language (reusing RedeemBookingModal and the shared parts), the attract screen, the idle timeout (Q9), the staff-desk screen, Console pairing code, the Kiosk Health tile, simulator controls (printer offline, paper out, box offline), and an `ops_run` of kind `device` for the print. | QA steps 5 and 6 screenshotted on staging. The kiosk payload has no allergy, medical or contact fields. |
| E1 | Read seam: `GET /events`, `/events/:id`, `/events/passes` and `/events/:id/roster` from a read-only repository; a camp listed on every day of its range; the header Events tab, the Check-in board Events tab, the mobile lists and the till's pass cards on the API; today's-events box bundle with `job:events.cache_refresh` and its expectation. | Check 1. |
| E2 | Attendee create and pass sale (`POST /events/:id/attendees`, `/events/:id/passes`), the walk-up modes and note stamp, the party walk-up charge, the write-back with `ops_run` and `sync_state`, the member pre-fill and name capture at the till, `event_drop_in_pricing` with the Admin Events panel. | Check 2. The forced write-back failure and its retry from Failures (part of check 7). |
| E3 | Check-in, check-out and reprint: the band change, kid and parent bands through S2-11 and S2-06, the allergy and diet lines and the F&B lookup, no supervision gate, the server-side "not registered today", box facts offline, a camp per day. | Check 4. |
| E4 | The party tab: `GET` and `PATCH /parties/:id` (protected fields, written back), charges, payments through the tender machine as `party_payment`, End of Day `party_prepay`, the settlement customer screen, and the mobile party screens. | Check 3. |
| E5 | Online passes (the rest of consistency #21): price passes in the public quote, register at payment, carry `eventPasses` on the booking, check in at the till's redemption and at the kiosk (Q11). Then the seed (`seed:demo-day`: a five-day camp, one-off event, party with deposit, walk-up prices), the closing audit and the staging walkthrough (QA steps 1-7). | All 7 checks, with screenshots attached to SCRUM-217. |

Size: XL. K1 and K2 can run while round 0 is built.

## 10. Permissions, audit and ops_run

- **Permissions:**
  - `pos:event:read`, `pos:event:attendee_create`, `pos:event:pass_sell`
    and `pos:event:checkin`.
  - `pos:party:charge` and `pos:party:payment`.
  - `admin:event_pricing:manage`.
  - `pos:kiosk:redeem` is carried by the kiosk device credential only.
  - Reception gets the `pos:event:*` and `pos:party:*` permissions, because
    the prototype lets any signed-in staff member do all of these.
  - A test asserts that no human role holds `pos:kiosk:redeem`.
- **Audit actions:**
  - `event.attendee_create`, `event.pass_sell`, `event.checkin`,
    `event.checkout` and `event.band_reprint`.
  - `party.charge`, `party.payment` and `party.update`.
  - `event_pricing.update`.
  - `kiosk.redeem`, `kiosk.handoff`, `kiosk.abort` and `kiosk.abandon`.
  - The station and box go in the row's detail and its action id, as other
    station actions do. The audit table has no station or box column.
- **ops_run:**
  - Kind `integration`, once per directory call.
  - Kind `device`, for the kiosk print.
  - `job:events.cache_refresh`.

## 11. Questions for the owner (the prototype's behaviour is the default)

- **Q1. Who owns event check-in?** The OTO App already keeps per-day camp
   check-in (`camp_attendance`, one row per registration per date). The
   ticket builds a POS `event_checkin` and writes back. Default: the OTO App
   stays the master and the POS mirrors it with write-back, as the ticket
   says (Open decision 25).
- **Q2. Revenue and tax category for camp and event passes.** Default:
   `tickets`, as the prototype has it, with the `svc-camp-pass` and
   `svc-event-pass` ids kept for reports. The ticket's `events` is not a
   tax category.
- **Q3. Party money.**
   - Are charges a ledger only (the prototype: no sale, no kitchen ticket,
     no stock, no bands for extra tickets), or real sales?
   - Which day does a party payment count on: payments taken that day for
     that day's parties (the prototype), or every payment taken that day?
   - Default: the prototype for both. One answer also covers analytics
     PLAN Q3.
- **Q4. Confirm the camp shows on every day of its range** (section 4).
   The prototype code shows it on its start day only.
- **Q5. Paying for a full-camp walk-up.**
   - Charge one day's price once (the prototype code), or charge the day
     price at each day's check-in? The latter is what the
     `EventDropInPricing` comment ("two-step pay at check-in") and the OTO
     App's per-day `camp_attendance.payment_method` suggest.
   - The switch says "added to every **remaining** camp day", but the code
     adds every day from the start.
   - Default: pay once, and register from today to the end, as the label
     says.
- **Q6. Prototype features the ticket leaves out.** These are event band
   reprint, online event passes with check-in at redemption (consistency
   #21 and R-99), the mobile party and event screens, and the till's
   name capture. Default: build them, because they are in the approved
   design.
- **Q7. One-off events.** The OTO App keeps counts and names as text, not
   one row per child. Default: an additive OTO App table for per-child
   attendees, in round 0.
- **Q8. Walk-up prices.** Only the party-guest price is read anywhere.
   Default: store all three, use party guest only, and show all three on
   the Events panel.
- **Q9. Kiosk idle timeout.** The prototype has no kiosk. Default: 60
   seconds of no touch or scan returns to the attract screen and records
   the session as abandoned.
- **Q10. Which OTO App event types are a party?** The OTO App types are
    birthday, private_event, school_group, other, studio_event, workshop
    and camp. Default: the types that carry a BEO bill (birthday,
    private_event, school_group) are a party; camp is a camp; the rest are
    events.
- **Q11. At the kiosk, does redeeming a booking also check its booked
    event passes in,** as the till does (Till.tsx 437-462)? Default: yes,
    the same as the till.
- **Q12. Cancelled events** (from the E1 review): the prototype's
    getActiveEventPasses never looked at status, so a cancelled camp or
    event still gets a pass card at the till - 10 of 156 production
    events are cancelled. Default: the prototype (cards shown) until
    answered; one answer with Q3's cancelled camp days.
- **Q13. Allergy text quality** (evidence for the badge rule): in the
    production dump 45 of 203 camp registrations hold "No", "None", "-"
    or "No allergy" as allergy text, and others hold diet words
    ("Vegetarian", "No pork") in the allergy field. Under the OTO App's
    any-text rule about 22% of real camp children would carry the red
    Allergy / Medical badge. Default: the app's rule as it stands.
- **Q14. The desk and other parks' bookings** (from the K2 review): a
    booking from another park scanned at a kiosk is listed on this
    park's desk as to-redeem with a raw reason code in the staff line,
    and a cancelled or expired booking stays to-redeem all day.
    Default: listed (the desk is where a confused guest is helped);
    wording and an end-of-day sweep to confirm.
- **Robustness note, not a question:** the event view checks dates with
    a yyyy-mm-dd pattern while the OTO App stores them as free text; all
    155 production dates conform today, but one stray value would turn a
    day's whole answer into an error instead of dropping one row. Worth
    a dropped-row path in a later round.

## 12. Hazards, each with its test

| # | Hazard | Test |
|---|---|---|
| H1 | The POS API reads `otoapp` tables directly | A grep test: the only event queries in `apps/api/src` are in the read-only repository, and they name `otoapp_v.*` only |
| H2 | A paid pass without a tender creates an attendee | A paid event with no tender is refused, with 0 link rows, 0 sales and 0 directory calls |
| H3 | Paid, but the OTO App write fails, and the attendee is lost or made twice | Directory stub fails, then succeeds twice. Result: one sale, the link is `pending` then `synced`, one OTO App attendee, and the `ops_run` can be retried |
| H4 | Two tills, or the box offline and the cloud, check in the same child on the same day | Two concurrent check-ins give one success and one "already checked in". An offline duplicate fact resolves to the first check-in and mints no second band |
| H5 | A camp child is checked in on a day they are not registered | An API call is refused with "Not registered for today" |
| H6 | The S2-13 supervision gate appears on an event check-in or a pass line | Event check-in and pass sale never call the supervision gate |
| H7 | An event band (no sale) breaks the readers that assume a sale | Refund, reprint, History, gate, occupancy and F&B lookup each accept an event band |
| H8 | An event kid band opens the gate | The kid event band is denied and the parent band is admitted at the gate simulator |
| H9 | No allergy alert at F&B for an event child | Scanning an allergy-flagged kid event band returns the allergy and `mayOrderFood=false` |
| H10 | A card party payment is counted on both the card line and `party_prepay` | End of Day with one card party payment: the card line is unchanged and `party_prepay` equals the amount |
| H11 | Two tills overpay a party | Concurrent payments for the full balance: one succeeds and the other is capped to 0 and refused |
| H12 | A party edit overwrites protected fields or the POS ledgers | `PATCH` with id, branch, charges or payments in the body changes none of them |
| H13 | The kiosk records a hand-off when the printer failed | Simulator printer offline: the booking is still unredeemed, there are no band or sale rows, and `kiosk_session.outcome='failed'` |
| H14 | The kiosk issues a supervised child | A booking with a drop-off line issues nothing for that line and shows the desk |
| H15 | The kiosk shows private data | A schema test on the kiosk state and response: no allergy, medical, phone or contact fields |
| H16 | A kiosk credential works as staff, or staff hold `pos:kiosk:redeem` | Every human role bundle lacks it, and the kiosk credential is refused on staff routes |
| H17 | A replayed kiosk redeem issues twice | The same action id sent twice gives one redemption and one set of bands |
| H18 | The booth's loopback `/kiosk/*` routes (runner/kiosk-server.ts) and the self-service kiosk collide on a box | A kiosk-role box does not serve booth claim or picker routes, and a booth-role box does not serve self-service |
| H19 | The box holds a stale copy of today's events | A missed `events.cache_refresh` raises the expectation alert |
| H20 | Wrong day between 00:00 and 07:00 | A check-in at 00:30 Bangkok time is on the branch's business date |
| H21 | A directory write reaches the wrong tenant | A directory call without, or with another, tenant is refused |
