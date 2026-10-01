# Check-in and supervision — the build plan for SCRUM-210 (S2-13)

_Written 2026-10-02 from the requirement (SPRINT_2_PLAN §S2-13, lines 2063-2149),
the rules R-06/07/27/62/85-95 and conflict C9
(POS_RULES_RECONCILIATION), two read-only studies — the prototype's complete
check-in domain and the platform's landed seams — and the arrival story's
handovers OD-A1 and OD-A8. The prototype's code is the binding behaviour
(CLAUDE.md); where it is silent or self-contradictory, this plan decides and
says so. S2-12 is Deployed; its bridge, band and offline patterns are the
foundation here._

## 1. Check-in, in the park's terms

A parent leaves a child with the park. Before any money moves, the till notices
a cart with kids and no adults and runs the supervision gate: the child's age
decides nanny (0–4), drop-off (5–8) or nothing (9+), a staff member may accept
an audited sibling waiver when an older sibling of at least nine is present,
and the guardian completes consent on the customer display — name, phone, one
photo of child and guardian together, allergies, dietary notes, the prepaid
food choice, and the park's configurable confirmations, each acknowledged with
its time. Paying creates one registration. "Check in now" puts the child in
the park atomically — band minted with its allergy line and supervision badge,
printed, timer started, sale linked. "Leave as booked" schedules it with no
band. The board shows every family with a countdown, amber inside fifteen
minutes, red when overdue; every edit is audited; a nanny can only be assigned
on shift. At pickup, staff pick the collector from the authorised list, verify
them against the stored photo side by side with a live pickup photo, or add an
unlisted collector on the spot with name and photo; unused prepaid food is
refunded by policy; the nanny is freed; the release records collector,
verifier and photo. All of it — check-in, the pickup list, release with its
photo — works with the internet down, and never, under any flow, is a photo of
an identity document taken.

## 2. The architecture

### 2.1 Data model (schema `crm`/`pos`, one migration in round 1)

New tables, shaped from the prototype's records and the reconciliation's §211:
- `crm.registration` — the family-level act: member (nullable for walk-ins),
  guardian name/phone/contact channel, consent_recorded_at, the acknowledged
  confirmations (item text + time, as rows or jsonb matching the seeded
  config), source (till / board / booking), photo file (the ONE combined
  child-and-guardian photo — OD-C2), retention_until.
- `pos.checkin` — one row per child per stay: registration, child
  (crm.child), service (none/drop_off/nanny), status
  registered/in_park/out, scheduled_for, checked_in_at/out_at and their
  accounts, booked_minutes, assigned nanny, food provision and
  may_order_food/restrictions snapshot, sale and band links, visit link where
  one exists, offline flag. NO jsonb change log: the audit rows ARE the log
  (OD-C6), read back filtered for the board's history view.
- `crm.guardian` (authorised pickups) — registration-scoped: name,
  relationship, phone, photo file, source in_person/from_chat/on_the_spot,
  added_by, audited; the dropper-off is implicit first entry. No delete —
  revoke flag only, audited (the prototype had no remove; we add revoke
  because R-91 demands auditable change, not deletion).
- `pos.supervision_waiver` — checkin, requirement waived, sibling child
  named, accepted_by, staff-only enforced (OD-C4).
- `pos.release` — checkin, collector (guardian id or on-the-spot name),
  verified_by, pickup photo file, offline flag, photo_pending_upload,
  prepaid settlement (policy, unused satang, refund link or
  refund_no_sale), created_at.
- `pos.nanny` + `pos.nanny_shift` — the seeded roster (OD-C5); on-shift is a
  shift row covering now, load is derived from in-park assignments; the soft
  ratio (3) is config.
- Config: `pos.supervision_policy` (bands, waiver settings),
  `pos.confirmation_item`, `pos.drop_off_pricing` (flat fee, nanny hourly,
  extra hour display-only, prepaid policy seeded refund) — per branch, seeded
  with the prototype's values (0–4/5–8/9+, the three confirmations, ฿225,
  ฿330/hr, ฿300 display-only).
- `file_object` gains owner types `registration`, `guardian`, `release`
  mapped to `pos:checkin:*` permissions; child-health and photo READS write
  access-log audit rows (R-94).

### 2.2 The till flow (online in round 1; the box surface in round 4)

The gate's wiring half-exists: step 7 and step 8 already run against the
display with real intents, and children/visits already save through the real
API (SCRUM-233). Round 1 removes every mock fallback: registerWalkInChildren
becomes the registration service; waivers persist; consent persists on the
registration with its confirmations; the photo uploads through file storage
(online). Check-in-now is ONE api transaction: registration → checkins
in_park → sale linkage → bands via the landed mintSaleBands path (the WI code
family dies; a band is a band) → print jobs; leave-as-booked writes
scheduled_for and stops. Fees follow the prototype's law exactly: tier ticket
+ flat drop-off or once-per-nanny hourly on her longest child + prepaid food;
the fee is decoupled from safety (R-86). The pricing decision the cart
handed over is settled as: a drop-off line ENTERS the cart only once its
length is chosen — no unpriced lines, no trust_stored (cart-totals.ts note).
The supervision badge and nanny name, which the prototype configured but
never printed, now really print on the kid band (R-50): two fields on the
band document, badge DROP-OFF/NANNY and the nanny's name, for supervised
children only.

### 2.3 The board (round 2)

The DropOff page and its cards move from mockApi to platform routes:
families grouped by registration, the three status tabs with counts, service
and unconfirmed filters, search, due-soon/overdue sorting and the ?due=1
hand-off from the till banner. Timers stay client-ticked from checked_in_at +
booked_minutes with the prototype's thresholds (15-minute amber). Edits go
through one audited PATCH (name/age via the child record, service, booked
minutes, food flags, nanny); the change-log view reads the audit rows.
Assigning a nanny checks the shift server-side — "not on shift" is the
refusal — and the ratio warning stays a warning. Booked check-in without
payment ports checkInFamilyBooked: never a sale (R-90). The Today count and
the occupancy drop-off term (OD-A1) switch from mock to checkin status.
The contact-channel test (R-95) keeps the prototype's chip and re-test loop,
messages through the console adapter.

### 2.4 Pickups and release (round 3)

The pickup sheet and release modal move to the platform: the authorised list
(dropper-off first, from-chat promotion kept, on-the-spot addition), R-92
enforced SERVER-side — a release names a listed guardian or carries the
on-the-spot name and photo, else it is refused; the side-by-side photos; the
live pickup photo mandatory; unused prepaid food refunded against the linked
sale through the landed refund path or recorded refund_no_sale; the nanny
freed by status. Releases and every pickup-list change audit. The release's
photos ride file_object online.

### 2.5 Offline (round 4, the box surface)

The bridge gains intents checkin.create/update, release.create,
guardian.create — box overlay kinds extended to match — and a new cache scope
`checkin` shipping in-park children, pickup lists and registrations awaiting
check-in for the branch. The till flow's gate, consent, check-in-now,
board-basics and release all answer from the box when the link is down,
write-ahead in one store transaction exactly as sales do, and sync once with
idempotent handlers; a conflicting release (released online meanwhile)
quarantines with an alert like the booking double. Photos: the box gets a
bounded blob store (the Pi's disk, 7-day purge, size-capped) — a captured
photo is stored locally, the release row carries photo_pending_upload, and an
upload worker presigns through the platform on reconnect with the box
credential and links the release exactly once. CHILD_PHOTOS_ENABLED gates
every capture. The closing audit of the round covers the whole lifecycle
offline, restarts included.

### 2.6 What this story does NOT touch

The OTO App's checkins tables are never written (the app's module coexists;
ownership at cutover is the owner's recorded, non-blocking decision — OD-C1).
Online-booking drop-off lines stay deferred (OD-A8's handover covers booked
drop-off children arriving through the board, not bookings carrying drop-off
fees). Kiosk hand-off, real messaging adapters, overstay BILLING (display
only) and history import are excluded by the requirement.

## 3. The rounds

| Round | Scope | Surfaces | Lands |
|---|---|---|---|
| 1 | Model + till online: migration, registration/supervision/consent persisted, check-in-now and leave-as-booked, band badge+allergy, pricing law, mock fallbacks removed from the gate path | packages/db, apps/api (new services/routes), apps/pos till components, packages/shared schemas/print fields | first |
| 2 | The board: routes, families, timers, filters, audited edits, nanny roster + on-shift rule, booked check-in, Today/occupancy term, contact chip | apps/api board routes, apps/pos DropOff page + board components, occupancy term | after 1, parallel with 3 |
| 3 | Pickups + release online: sheet, modal, server-enforced R-92, photos via file_object, prepaid reconciliation, access-log on reads | apps/api release/guardian routes + files owner types, apps/pos CheckOut/AuthorizedPickup components | after 1, parallel with 2 |
| 4 | Offline: bridge intents, cache scope, box blob store + upload worker, offline check-in and release, sync handlers + quarantine, closing audit, the staging walkthrough with the QA script | packages/box-agent, packages/shared bridge, apps/api sync.ts, migration only if an anomaly kind widens | last |

Rounds 2 and 3 share the components/dropoff folder: round 2 owns DropOff.tsx,
FamilyCheckInCard, AssignNannyModal, EditCheckInModal, OverstayBanner,
CheckInBookedModal; round 3 owns CheckOutModal, AuthorizedPickupSheet,
CameraCapture, FoodReconciliationSummary. Admin panels (supervision policy,
confirmations, drop-off pricing) ride round 1's config tables with their
existing screens wired in round 2.

## 4. Open decisions (recommended answers hold unless the owner objects)

**OD-C1. Who owns park-side check-in from now on?** Recommended: the
platform, from this story's landing; the OTO App's check-in module stays
readable for its history until cutover and is never written by us. (The
requirement itself marks cutover ownership as the owner's non-blocking call.)

**OD-C2. The photo policy.** Recommended: ONE combined child-and-guardian
photo per visit (exactly what the prototype captures and shows at pickup),
retention seeded at 30 days after release and configurable, photos staff-only
behind the permission with every read access-logged, CHILD_PHOTOS_ENABLED
default on, and the schema's old "child photo never stored" comment corrected
to "stored per visit with retention, never on the child record". Identity
documents are never photographed, under any flow.

**OD-C3. The waiver is staff-only, enforced.** The prototype stored the flag
and never checked it; we enforce it with the permission so a waiver can only
be accepted by signed-in staff. Recommended as written.

**OD-C4. Nanny roster source.** Recommended: a seeded platform roster with
shifts now (the requirement's words); feeding it from the staff app's rota
later reuses the duty-sync pattern SCRUM-473 built, as its own small ticket
when wanted.

**OD-C5. History events.** The prototype logs no check-in events anywhere;
the requirement demands them in Activity. Recommended: checkin.create,
checkin.update, release.create audit actions with station and box ids — and
History's drop-off filter keys on the real registration link, fixing the
prototype's svc- prefix bug rather than porting it.

## 5. Landed seams this builds on

The write-ahead store transaction and outbox; till-minted ids and the
overlay; mintSaleBands and the allergy line to paper; the display consent and
child-review intents with their redaction; file_object with presigned access;
the reserved pos:checkin:* permissions; the refund path; the audit helper
with actionId/sourceEventId; seed:demo-day.

## 6. Unknowns carried in

Whether the Pi's disk comfortably bounds a week of photos at the park's
volume (measured in round 4; the cap refuses capture with a plain message
before the disk suffers). The consent-record retention interplay with a
future OTO App history import (recorded, excluded). The real camera on the
till hardware (CameraCapture exists and works with a webcam; the park's
hardware question joins the bench checklist).
