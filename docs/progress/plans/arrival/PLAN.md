# Arrival — the build plan for SCRUM-209 (S2-12)

_Written 2026-09-30 from a read-only study: the requirement (sprint plan S2-12,
`docs/progress/SPRINT_2_PLAN.md:1965-2062`), a reuse map of the working tree, and the gate
documents beside the prototype. Nothing here is built. S2-11 (SCRUM-208) is mid-flight in the
working tree; every S2-11 file reference describes that code as seen on this date and is
re-read before a round starts. Vendor protocol details are cited by section of the documents
in `imports/_vendor-docs/` (summarised in `docs/architecture/DEVICE_INVENTORY.md` §6), never
copied._

## 1. Arrival, in the park's terms

A family books online, picks a visit date and pays on 2C2P's hosted page. Only when 2C2P
tells the platform the money arrived does the booking become paid, and the confirmation
carries a QR the park signed. On the day, reception scans that QR: the till records the sale
as already paid online, prints a band for every child and adult on the booking, and the
booking can never be used again — even with the mall's internet down, because the box checks
the signature itself. Adults then scan their band at the entrance gate; the box decides, the
lane opens, and only when the lane reports that a person actually walked through does the
head count move. A band cannot enter twice without leaving. The number of people inside shows
on every till and on Health.

## 2. The architecture

### 2.1 Checkout — 2C2P Redirect API, sandbox first

Exists:
- The gateway seam `QrPayment` (`packages/payments-2c2p/src/contract.ts:246-260`); the real 2C2P adapter (`twoc2p.ts:108-189`; its Payment Token already sends both return URLs, `:118-119`); the simulator state machine (`simulator.ts:211-248` `apply`); verify-before-read JWT (`envelope.ts:55-115`); one claims reader for notification and inquiry (`twoc2p.ts:263-319`).
- `gatewayFor` from `PGW_*` (`apps/api/src/services/payments/gateway.ts:100-150`, env `apps/api/src/env.ts:423-486`); the nine-step notification handler that confirms by inquiry (`gateway.ts:911-952`, inquiry `:1256`); the poller and the pending sweeper (`:1434`, `:1577`); the webhook (`apps/api/src/routes/webhooks.ts:74-120`). `payment_attempt.station_id` is nullable and its comment reserves the null for this ticket (`packages/db/src/schema/sales.ts:957-961`).
- Public booking create with the server-side quote through the S2-09a engine, holidays, rate limiting and audit (`apps/api/src/routes/public.ts:279-487`) — still writing `status: 'paid'` with no payment (`public.ts:433`; the sprint plan cites a stale line 230). Booking site pages `apps/pos/src/pages/Book.tsx`, `components/book/BookPayment.tsx`; `BookConfirmation.tsx:35` draws the fake pattern of `apps/pos/src/lib/qr.ts`. A real encoder (`qrcode`) is already a dependency of `apps/pos`.

New:
- `createHostedPayment` on the seam: Payment Token restricted to the booking page's channels, returning the hosted page URL (`docs/architecture/PAYMENT_GATEWAY.md` §2.8, `:443-461`). The simulator gets the same method plus a pay / fail page served by the api's simulator routes, calling `apply`.
- A station-less opener for the `WEB` invoice segment (§3.10, `:738-748`): `openQrAttempt` insists on a station with a code prefix (`gateway.ts:352-360`); `buildInvoiceNo` already takes any short code (`packages/shared/src/payments.ts:234-267`).
- Settlement learns a booking: `settlePaidAttempt` (`gateway.ts:592-640`) finalises a sale; a booking's paid attempt instead marks the booking paid, signs its QR and sends the confirmation through the messaging console adapter (`apps/api/src/services/sms.ts`). Paid only on the notification or the inquiry, never on the browser's return — its `paymentResponse` is verified with `verifyJwt` and used as a display hint only.
- Migration reshaping `pos.booking` (`packages/db/src/schema/future.ts:34-56`): channel, package and counts, payment attempt link, paid_at, expires_at, business_date (= the visit date), pricing snapshot, QR key id and signature. Unpaid bookings expire through the sweeper. Existing rows are staging demo data written by the simulated flow: migrated as paid with no attempt and marked so in the snapshot (check production holds no platform booking rows before it runs).
- `public.ts` creates `pending` and returns the hosted URL; a status route the return page polls; a bookings list in the Console.
- UNKNOWN: how a QR payment is made to succeed on the sandbox, and whether the sandbox delivers backend notifications to the staging URL (`PAYMENT_GATEWAY.md:492-515`). The inquiry poller covers a missing notification; the first sandbox session answers the rest.

### 2.2 The signed booking QR

- Exists: browser-safe SHA-256 / HMAC and the band code format (`packages/shared/src/band-code.ts:169-246`, `:14-49`); the park key `BAND_HMAC_KEY` (`apps/api/src/env.ts:504-538`); the scan kind `booking` (`packages/box-agent/src/scan.ts:57-67`; `packages/shared/src/scanning.ts:44-60`) with the classifier's deliberate refusal to guess its format (`scan.ts:437-447`).
- New: `packages/shared/src/booking-qr.ts` — a header no band code or product barcode can carry (band codes are upper-case alphanumerics then a dot), the booking id as a ULID, and a truncated HMAC over a domain-separated message ("booking" never equals "band") under the same park key. One key on every box (`docs/briefs/OWNER_DIRECTION.md:30-33`) verifies both, and neither signature replays as the other. The api signs at payment; the box verifies; the scan router registers a booking handler. The typed reference stays as reception's fallback (`apps/api/src/routes/bookings.ts:150-171`).

### 2.3 Redemption — one service, the till now and the kiosk later

- Exists: `redeemBooking` with the row lock, paid-only predicate, unique `booking_redemption` row, the already-redeemed answer and audit (`apps/api/src/services/bookings.ts:463-620`; table `future.ts:95-122`, `redeemed_at` apart from `created_at` for offline claims); the route (`routes/bookings.ts:189-236`); `sale.booking_id` and the `booking` channel (`sales.ts:314`, `:65`); S2-11's minting at print (`apps/api/src/services/sale-printing.ts:356-372`); the box's `bookings` bundle, today ±1 with redemptions (`apps/api/src/services/sync.ts:3813-3842`).
- Prototype to port: `redeemBooking` and `issueBookingBands` (`imports/oto-pos/artifacts/oto-till/src/mockApi.ts:1020-1033`, `:2577-2626`); `handleRedeemConfirm` (`pages/Till.tsx:376-468`: regular lines only, the booking's tender, bands, print, then the atomic claim); the three stages of `components/till/RedeemBookingModal.tsx`.
- New: `services/booking-redemption.ts` — one transaction: claim the booking, commit and finalise a sale from its paid lines with `bookingId` and a "paid online" tender that never counts as till money, mint bands through `mintSaleBands`, return the print jobs. `CommitSaleInput` has no `bookingId` today (`apps/api/src/services/sale.ts:351-374`) and no station kind may record the `booking` channel (`sale.ts:2306-2363`). The till's mock calls go (`apps/pos/src/pages/Till.tsx:781-858`).
- Offline: the box redeems from its cached bundle with a local redemption log, mints the bands itself and syncs one `booking.redeemed` event; a second box's redemption of the same booking is quarantined at sync with an alert (PC §8 line 138; C11). No handler exists (`sync.ts` `HANDLERS` at `:853`). This needs box-side sale commit and minting, which move to the box with SCRUM-269 (`AGENTS.md:73-82`).

### 2.4 The gate box — reader host, controller link, simulator

- Exists: station kind and box role `gate`, device kinds `gate` / `gate_reader`, the `serial` and `simulated` transports and the station-device role (`packages/db/src/schema/fleet.ts:48`, `:285`, `:474-495`, `:610-622`; `apps/api/src/services/fleet.ts:269-280`); box-hosted HTTP patterns (`packages/box-agent/src/booth-http.ts`, `runner/kiosk-server.ts`); the serial opener (`terminal/serial-channel.ts`) and the terminals' protocol/simulator pairs (`terminal/`); the `simulate` box command (`packages/db/src/schema/edge.ts:68-81`) and the Console simulator panel (`apps/console/src/components/devices/TerminalSimulatorPanel.tsx`); alerts with free keys (`raiseAlert`, `apps/api/src/services/ops.ts:268`) and Health checks (`ops.ts:871`). No gate, relay or GE-X2 code exists anywhere.
- New, in `packages/box-agent/src/gate/`:
  - `reader-host.ts` — hosts the reader's scan call and heartbeat call (Gate Interface Spec §1-2; DEVICE_INVENTORY §6.1): string fields, base64 payload; answers open / do-not-open with a short Thai-English message, the only thing the guest sees. Missed heartbeats raise a reader-offline alert.
  - `ge-x2.ts` — frame builder and parser for GE-X2 §1 commands and their acknowledgements, §2 passage feedback (tolerating the doubled leading byte the protocol notes), §3 door and infrared state, §4 settings reads; machine id and baud from the station's config.
  - `opener.ts` — the relay abstraction: a relay pulse from the gate box (PC §7.5), the serial open command (GE-X2 §1), or the reader's own relay (an inference only, DEVICE_INVENTORY §6). Config picks one.
  - `controller.ts` — at startup, find the machine on the line and READ (never write) the settings that matter (HX-X1 §6.1.1: open duration, working mode, close delay, entry/exit memory, tailgating, upload mode), alerting on a mismatch with config. At runtime, exactly one pending open per side; the next feedback on that side within open duration + close delay is credited to it. That is sound only with entry/exit memory off, which startup checks.
  - `simulator/` — a virtual reader (scan a band at entry or exit, a double read, non-band codes, a slow reply, reader offline) and a virtual controller on a virtual serial path (acks, every §2 feedback family on the right side, the door-state walk, fire alarm held open, power loss then restore, the block-then-sleep of HX-X1 §3.1, the upload modes). Driven from a new gate panel in the Console through `simulate`.
- Faults: the HX-X1 §7 fault list is shown on the controller's own display only; GE-X2 carries no fault message. The box infers faults (missing acks, a door stuck initialising or searching zero, an infrared fault state, silence) and Health shows the inference (OD-A13).

### 2.5 The access decision and anti-passback — on the box, no network

Decode → only a band code is admissible at a gate (`isBandCodeShape`, `verifyBandCode`,
`band-code.ts:336-370`; the code's body is the band row id, so no lookup names it) → deny list
→ kind → anti-passback → answer → open → wait for passage feedback → commit.
- Kind: kids' bands never operate the gate (C8, R-83; `docs/architecture/POS_RULES_RECONCILIATION.md:29`, `:148`), read from `band.kind` in the box's `bands` scope (`sync.ts:3844-3856`).
- Deny list: that scope carries active bands only, so absence cannot mean revoked (a band printed after the last pull is absent too). New: revoked bands as explicit entries in the `deny_list` scope (`sync.ts:3769-3811`).
- Anti-passback: per band, the last committed direction, moved only by a "passed" feedback. Entry while inside → denied, reason `ANTI_PASSBACK`. A timeout changes nothing; reverse and tailgating raise `gate.reverse` / `gate.tailgating` and credit no one. Door held open with no pending open (fire alarm, power loss) → `gate.fire_alarm` / `gate.power`, and the box stops crediting passages until the door closes.
- Journal: `band_event` gains `entry|exit|denied|timeout|alarm` (today `minted…scanned`, `packages/db/src/schema/sales.ts:1285`, CHECK in migration 0034), with station, box and reason in `detail` (`sales.ts:1367-1389`), box-minted ids, idempotent on sync. A swapped gate box rebuilds passage state from the cloud (`docs/architecture/design-review-2026-09-19/03-box-agent-sync--decisions-risks-critique.md:337-342`).

### 2.6 Live occupancy

- Exists: `OccupancyChip` polls every 5 s through one seam (`apps/pos/src/components/shared/OccupancyChip.tsx:10-21`), shape `{adults, kids, total}` (`apps/pos/src/types.ts:1922-1926`); the prototype rule (`mockApi.ts:2141-2181`). Nothing on the platform counts occupancy.
- New: a cloud projection from `band_event` passages (the gate box is authoritative; the till shows the cloud value or "stale since"); `GET /branches/:id/occupancy` with the chip's seam pointed at it; a Health row; a job writing `fact_occupancy_15min` (the platform's first fact table); the end-of-day clear of stranded groups. Adults from passage feedback; kids by the rule chosen in OD-A1.
- UNKNOWN: whether the box's outbox pushes passage events fast enough for the chip's 5-second criterion. Round 4 measures it; if not, the box pushes passage events on their own immediate path.

### 2.7 Admin and audit

Gate admin in the Console (side mapping, opener mode, machine id and baud, expected settings,
reader serials of the gate station); the bookings list (round 1); audit rows for booking
create / pay / expire, redemption, and every gate decision with station and box ids
(`audit.record`).

## 3. The rounds

Each round is a gated workflow (build → a gate that tries to refute → fix round → commit by
explicit file list → CI evidence → staging evidence → Jira comment with screenshots) and lands
deployable on its own. Migrations are written by one round at a time, after S2-11's 0034 is
committed; the next number is taken at the moment of writing, never reserved in advance.

| Round | Slice | Files | Deployable result |
|---|---|---|---|
| 1 | Checkout | `packages/payments-2c2p`, `apps/api` payments + `public.ts` + `bookings.ts`, `packages/shared/src/booking-qr.ts`, migration (booking reshape), `apps/pos` booking site, Console bookings list | a booking is paid for real (simulator page, or the sandbox once `PGW_*` are set), carries a signed QR; the till's existing redeem refuses an unpaid one |
| 2 | Gate box | `packages/box-agent/src/gate/**`, migration (`band_event` kinds), `sync.ts` deny list + passage handler, Console gate panel | the virtual box plays the gate: reader, controller, decision, anti-passback, alerts, Activity rows |
| 3 | Redemption at the till | `apps/api/src/services/booking-redemption.ts`, `sale.ts` (`bookingId`, channel), `routes/bookings.ts`, the booking handler in `packages/box-agent/src/scan.ts`, `apps/pos` Till + modal | scan the QR → paid-online sale, bands, print, redeemed; a second scan answers already-redeemed; a tampered QR is refused |
| 4 | Occupancy, Health, admin | projection + route + job, `ops.ts` checks, `OccupancyChip` seam, Console gate admin | the chip counts real passages; Health shows gate state and inferred faults |
| 5 | Offline redemption, end to end, closing audit | box redemption log, `booking.redeemed` sync handler with quarantine | AC3 with the box offline; the plan's full QA script (`SPRINT_2_PLAN.md:2045-2059`) on staging; an adversarial audit and its fix round |

Rounds 1 and 2 run in parallel (disjoint files; the second migration waits for the first).
Round 3 needs 1; round 4 needs 2; round 5 needs 3 and SCRUM-269.

**Round 1 — checkout.** Scope 2.1, 2.2 and the bookings list. Tests: package unit tests in the
style of `packages/payments-2c2p/test/*.test.ts` (the hosted-payment token request;
`paymentResponse` verified and never used for state; simulator page transitions);
`packages/shared/test/booking-qr.test.ts` (round trip, tampered body, tampered signature, a
band code refused as a booking and the reverse, wrong key); api integration tests beside
`apps/api/test/payments-2c2p.test.ts` (the quote for 2 kids + 2 adults on the seeded holiday
at weekend prices with socks; paid only after notification or inquiry; a forged return does
nothing; a replayed notification pays once; failure and expiry stay unpaid;
`BOOKING_NOT_REDEEMABLE` reads "booking not paid"; audit rows). Evidence: AC1 screenshots.

**Round 2 — gate box.** Scope 2.4, 2.5. Tests: `ge-x2` frame tests derived from the documents'
sections (no copied captures); controller crediting tests (one pending per side, feedback
outside the window credited to no one, a second open while one is pending refused); decision
table tests (adult in; adult again → anti-passback; exit; kid; revoked; unknown band; non-band
code; tampered code); simulator scripts for each feedback family, fire alarm and power loss;
box tests in the `packages/box-agent/test` style; the api sync handler's idempotency.
Evidence: AC4 and the alert half of AC5.

**Round 3 — redemption.** Scope: the online half of 2.3. Tests: extend
`apps/api/test/bookings-redeem.test.ts` (the sale carries `bookingId` and the paid-online
tender; 2 kid + 2 adult bands and their print jobs; a second redeem conflicts with who and
when; two tills racing yield one sale); scan handler unit tests. Evidence: AC2.

**Round 4 — occupancy.** Scope 2.6, 2.7. Tests: projection unit tests over scripted passages
(in, out, timeout, reverse, tailgating, the kids' rule, the end-of-day clear), the fact job,
the route's permission, the chip against the route. Evidence: the chip within 5 s, the Health
row, the rest of AC5.

**Round 5 — offline and proof.** The offline half of 2.3 on top of SCRUM-269; then AC6's spot
checks, the plan's five QA steps on staging, and an audit of the whole path (public endpoints,
replay, forged returns, QR tamper, offline double use, restarts mid-redemption, the gate with
its box restarting, clock skew).

## 4. Open decisions for the owner

Each is one question; the build follows the recommended answer unless the owner says
otherwise. Items marked [on-site], [supplier] or [credential] are settled at the park, by the
supplier or when credentials arrive — none of them is deferred development.

**OD-A1. Do children count in the live head count, and how?**
Recommended: yes, by the park's group rule (R-84, C8): adults from real passages; a child on a
regular ticket counts while at least one adult of the same sale is inside; drop-off children
count from check-in to check-out once S2-13 lands. The sprint plan's line calling the group
rule "replaced" (`SPRINT_2_PLAN.md:1977-1979`) is corrected to: only the source of adult
movement changes (passages, not scans).

**OD-A2. What opens the lane: a relay on the gate box, the reader's own relay, or a serial
command to the controller?** [on-site]
Recommended: the relay on the gate box, as the brief decided (PC §7.5), with the serial
command built behind the same switch; confirmed on site.

**OD-A3. Which side of the lane is the way in?** [on-site]
Recommended: a setting per gate, default left = in, set at installation; the acceptance
wording follows the setting rather than a fixed side.

**OD-A4. A band scanned at the exit that the box does not think is inside (it entered while a
gate box was being swapped, or walked in behind someone): let the guest out?**
Recommended: yes, always let a guest out; record "exit without entry" and never let the count
go below zero.

**OD-A5. A band printed moments ago, not yet in the gate box's copy, with the box offline:
open?**
Recommended: no — the reader says "please see reception". Online, the box asks the platform
first, so this only happens with the internet down.

**OD-A6. Children's bands at the readers: deny them, and let children walk through with their
adult?** [on-site]
Recommended: deny with "adult band please", the plan's default (OD-26). Whether a child
following an adult sets off the lane's tailgating detection depends on the sensor height —
confirmed on site.

**OD-A7. When a booking includes wallet credit, does redemption load it?**
Recommended: redemption records the credit on the sale exactly as a walk-in sale does; the
wallet itself arrives with S2-14a in this sprint and reads it from there.

**OD-A8. An online booking with drop-off children: who checks them in?**
Recommended: redemption issues the regular bands and shows the drop-off notice (as the
prototype does); checking in a booked drop-off child moves into S2-13's scope, so it is built
this sprint instead of falling between the two tickets that each exclude it today.

**OD-A9. With the internet down, two boxes could each redeem the same booking. Accept that the
second is caught at sync, with an alert, rather than prevented?**
Recommended: yes — the brief already says single use across two stations is not made safe
offline (PC §8). Tills on the same box share one log, so it needs two boxes.

**OD-A10. On which day's report does online booking money appear?**
Recommended: the payment on the day it was paid (the `WEB` invoice, matching 2C2P's
settlement); the redemption sale on the visit day with a "paid online" tender the till's
cash-up excludes.

**OD-A11. How long is an unpaid booking held, and what if 2C2P reports payment after it
expired?**
Recommended: the default payment window (OD-21, `PAYMENT_PENDING_MIN`); a late payment still
confirms the booking (there is no capacity limit to protect today) and raises an alert for a
look.

**OD-A12. May staging use 2C2P's public sandbox demo merchant until the park's own sandbox
credentials arrive?** [credential]
Recommended: yes (OD-19, OD-32). The simulator page runs only while no credentials are set;
the acceptance's "paid on the sandbox hosted page" is evidenced in the first sandbox session,
which also finds how a sandbox QR payment is made to succeed.

**OD-A13. The controller's fault codes show only on its own display, not over the cable.
Accept that Health shows the faults the box can infer (not answering, stuck initialising,
sensor fault) instead of the code?**
Recommended: yes; the acceptance's "fault code shows on Health" is reworded to the inferred
fault.

**OD-A14. On the booking site, after a phone number, should saved children appear?**
Recommended: no, not without proof the phone belongs to the person typing: the public lookup
stays nickname and tier (SCRUM-357); children are named on the booking and matched at
reception. If the owner wants saved children, a one-time SMS code unlocks them and joins
round 1.

**OD-A15. Which QR reader comes with the gate, and does it speak the Gate Interface Spec's
HTTP calls (over HTTP or HTTPS)?** [supplier / on-site]
Recommended: build to the spec with the box serving both; the supplier's answer or the
on-site test settles it (DEVICE_INVENTORY §6.5).

## 5. What S2-11 must have landed first

The seams S2-12 builds on, as seen in the working tree on 2026-09-30:

1. Migration 0034 (band, band_event, refund) committed and applied on staging. S2-12's
   migrations follow it; round 2 widens the `band_event.kind` CHECK in a new migration and
   never edits 0034 (`packages/db/migrations/0034_bands_refunds.sql:53-69`).
2. `@oto/shared` exports, through `packages/shared/src/index.ts:31`: `mintBandCode`,
   `parseBandCode`, `isBandCodeShape`, `verifyBandCode`, `bandShortCode`, and the
   browser-safe `hmacSha256` / `sha256` (the booking QR reuses the HMAC).
3. `apps/api/src/services/bands.ts`: `mintSaleBands(tx, sale, stationPrefix, scope)`
   idempotent; `planBands` (one kid band per child ticket, one adult band per adult including
   free); `bandsOfSale`, `findBandsByCode`, `currentBandKey`. Minting wired into print
   (`sale-printing.ts:356-372`, `:572-577`), so a sale created by redemption gets its bands
   with no new minting code.
4. `BAND_HMAC_KEY` resolved on the api (`env.ts:504-538`) and set on staging.
5. `pos.band` with `kind`, `status` (incl. `revoked`) and `band_branch_status_idx`; the box's
   `bands` cache scope (`sync.ts:3844-3856`).
6. The sale view with its bands (`sale.ts:3785`) and the till's print path for band jobs.

Not provided by S2-11 and needed here (the platform lane is asked to agree who builds each):
- The band key on the box. No box receives it today (a search of `packages/box-agent/src`,
  `sync.ts` and `routes/box.ts` finds none). The gate box (round 2) and offline redemption
  (round 5) need it; SCRUM-269 moves minting to the box and needs it too — built once, by
  whichever lands first.
- Box-side offline sale commit and band minting: SCRUM-269 (`AGENTS.md:73-82`). Round 5 waits
  for it.
- A "paid online" tender method in S2-10a's tender catalogue (SCRUM-206); round 3 adds it if
  absent.

## 6. Unknowns carried into the build

- 2C2P sandbox: how a QR payment is made to succeed; whether backend notifications reach
  staging (`PAYMENT_GATEWAY.md:492-515`).
- The gate reader: model, whether it speaks the HTTP contract, TLS, reply timeout, heartbeat
  interval (DEVICE_INVENTORY §6.5).
- Wiring: which opener (OD-A2); the entry side (OD-A3); RS232 or RS485 (PC §7.5); a network
  adapter for the serial line (supplier answer 3).
- The open-duration default differs between GE-X2 §4 and HX-X1 §6.1.1 — the box reads it,
  never assumes it.
- How the serial link behaves while the controller sleeps after forced blocking (HX-X1 §3.1).
- Firmware: matches the 2021 protocol, version number not given (supplier answer 4).
- Outbox latency against the chip's 5 seconds (measured in round 4).
- The prototype drew two gate devices (`imports/oto-pos/artifacts/oto-till/src/store/catalogStore.ts:672-673`);
  the real unit is one lane with two readers, so the Console models one gate station with two
  reader serials.
