## 0. Five rules everything else follows from

- **R1 Facts are never rejected.** If it physically happened (cash taken, card approved, food served, child released), the cloud records it, however late it arrives and whatever policy it broke. Breaches become rows in an exceptions queue. Ingest rejects only items that are malformed, unauthenticated or tampered. Those go to a dead-letter table with an alert and are never dropped.
- **R2 Verifiers hold no secrets.** Any box can check a token. Only the issuer can mint one.
- **R3 One writer per sequence.** Each receipt series, `box_seq`, terminal reference counter and cash session has exactly one writer, which is a box. The cloud never allocates inside a box-owned sequence.
- **R4 Write ahead, then act.**
  - Commit the intent to SQLite with fsync before sending bytes to a terminal.
  - Commit the finalised sale before printing.
  - On boot, recovery resolves every open intent before the station may sell.
- **R5 Every bearer instrument declares an offline policy.** The UI says so in plain words when the policy applies. The three policies are:
  - `offline_ok`: bands, and bookings admitted on signature.
  - `offline_capped`: wallet spend.
  - `online_only`: high-value vouchers, wallet cash-out, tier change, refunds above a limit.

## 1. Keys and trust domains

**Registry.** New table `core.signing_key` with these columns: kid, owner (cloud|box), box_id, purpose, alg=ed25519, public_key, allowed_types[], not_before, retire_after, revoked_at, revoke_effective_from.

**Cloud keys.** The private half is held as a Render secret, one key per purpose:
- `staff-token`
- `booking`

**Box keys.** These are generated on the device at first boot, and the private half never leaves it.
- `box-auth` signs the WebSocket/sync challenge. The cloud stores only a public key, so there is nothing to leak. It replaces the unused `station.device_key_hash` in `packages/db/src/schema/platform.ts`, moved from the station to a new `box` table.
- `box-issuer` is limited by box role:

  | Box role | allowed_types |
  |---|---|
  | Counter or kiosk | band, wallet_grant, pickup_slip |
  | Booth | voucher only |
  | Gate | none |

**Verify rule.** A token passes only when all of these hold:
- the signature is valid;
- the kid is known;
- the token type is in the kid's `allowed_types`;
- the token's dates fall inside the kid's validity;
- the kid is not revoked for that date.

Because keys are limited by type, a stolen booth box cannot mint bands or bookings.

**Distribution.** The operator's public keyset is tens of rows. It ships in config sync and by WebSocket push, and each heartbeat reports a `keyset_version`.

**Rotation.**
- Cloud keys:
  - Publish a new cloud kid at least 7 days before first use.
  - Start signing with it only after every active box has acknowledged the keyset.
  - The old kid stays verify-only for the longest token lifetime, which is the booking horizon.
- Box keys:
  - Rotate box issuer keys on re-image or yearly.
  - The old kid stays verify-only until the end of the business day (bands are day-scoped) or until voucher expiry.

**Stolen box.**
- Revoke both kids, with `revoke_effective_from` set to the last trusted heartbeat.
- Force-reset the PINs cached on that box.
- The cloud knows which members and accounts that box had cached. Use that for the PDPA breach assessment.

## 2. One signed-code envelope (`packages/tokens`, pure TypeScript, used by agent, cloud and tests)

The format is `OTO1:` followed by base45 of `ver | type | kid | body | sig64`.

- **Band.**
  - Body: band_id (UUIDv7, which is the `pos.band` primary key), flags (adult/kid, gate rights, supervised), valid_from and valid_until, and an optional 6-byte group tag. Size:
    - about 94 bytes, which encodes to about 146 characters;
    - QR version 6-M, 41x41 modules;
    - at 203 dpi and 3 dots per module the code is about 18 mm wide, which fits a 25 mm band.
  - Proving and fallback:
    - Test it on the real 4B-2082A band stock during stabilisation.
    - The fallback is a truncated per-station HMAC for bands only.
    - Those fallback keys would be held only by park boxes and never by booth boxes.
  - What the gate checks:
    - The gate box checks the signature, the validity window, today's deny list and anti-passback.
    - Anti-passback works offline because one gate box serialises it.
  - Voided or lost bands:
    - A void reaches other boxes only through the cloud.
    - Offline, the limits are the one-day validity and the runbook step of cutting the band off when refunding.
    - Do not claim a stronger guarantee than this.
  - A reprint keeps the same band_id. It is not a new band.
- **Booking.**
  - Signed only by the cloud, at payment time.
  - Body: booking_id, branch, date, party summary hash.
  - A phone screen has no size limit for the QR.
  - Online, the cloud claim decides. Offline, the box admits on the signature plus its local redemption log.
- **Voucher.**
  - Signed by the booth box.
  - Body: voucher_id, booth station, staff id, prize class, expiry.
  - The prize class carries the offline policy.
- **Wallet grant.**
  - A counter box signs `{wallet_id, entry_id, amount, issued_at}`.
  - It is printed on the wallet voucher that SCRUM-59 already requires.
  - A different box can then honour credit sold during an outage.
- **Pickup slip.**
  - Signed at supervised check-in.
  - Body: check_in_id, child_id, dropper-off guardian id, pickup-list hash.
  - See section 12.

Any bearer code can be photographed. The signature stops forged codes, not copied ones. Copying is limited by anti-passback, the wallet cap and staff presence.

## 3. Staff auth on the box channel

**Cloud side.**
- Keep the Sprint 1 opaque cookie (`apps/api/src/plugins/session.ts`) for the cloud. Instant revocation is worth keeping.
- When a staff member picks a station, mint an Ed25519 shift token from the session.
  - Claims: sub, operator, branch, aud=box_id, jti=session.id, iat, exp of at most 12 hours, role-assignment ids, perm_version.
  - Binding `aud` to the box means a stolen token is useless on any other box.

**Box side.**
- The box evaluates permissions from its SQLite copy of the role tables. This requires moving `grantCovers` and `hasPermission` from `apps/api/src/services/permissions.ts` into `packages/shared`.
- Locking is local and keeps the token. `logout()` in `apps/pos/src/auth/OperatorContext.tsx` must stop calling `signOut` on inactivity.
- Unlock uses a 6-digit station PIN.
  - The PIN is a separate credential in `core.account_credential`, argon2id-hashed.
  - It is cached only on boxes of the staff member's branch, and on booth boxes only for staff assigned to that booth.
  - It is checked on the box and rate-limited there.
  - The account password hash never leaves Postgres.

**Offline fresh sign-in.** The brief's default is kept and tightened:
- The staff member has been seen on this box in the last 30 days.
- The box's last successful sync is under 72 hours old (configurable).
- The PIN is correct.
- The result is a box-signed local session with `auth_method=offline_pin` and a restricted permission overlay:
  - allowed: sell, print, check in, release a child;
  - blocked unless a manager PIN co-signs: refund, void, paid-out, wallet cash-out, discount above a limit, tier change.

**Fired employee.**
- When the box is online, the revocation of the jti or account goes over the WebSocket, and the box drops the session at once.
- When the box is offline, the revocation cannot reach it. The exposure is the shorter of the token's expiry and the outage length.
- The cloud flags events from that account whose `occurred_at` is after the revocation for review. It still records them (rule R1).

**Proof of session.**
- Every event carries the staff jti.
- Ingest checks that the jti was minted for that box and that `occurred_at` falls between iat and exp.
- Events from offline-PIN sessions are flagged.

## 4. Time

**Hardware and sources.**
- Fit an RTC battery (ML-2020) on every box and enable trickle charging. It is a bill-of-materials item.
- Run chrony with three sources:
  - the park router as LAN NTP (the router is not a box, so the no-peer rule holds);
  - public NTP;
  - the cloud time returned in every heartbeat acknowledgement.

**Detecting a bad clock.**
- The agent persists `last_good_time` every minute and on every ledger write.
- If the wall clock at boot is earlier than `last_good_time`, the agent sets `clock_untrusted`.
- In that state, recover as follows:
  - Any valid cloud-signed token whose iat is later than the box clock proves a lower bound on real time, so the box advances its floor to that iat.
  - Every iPad request carries `X-Client-Time`. iPads keep time through outages, so the box adopts their time when its own is untrusted and records `clock_source=ipad`.
- Selling is never blocked because of the clock.

**What each event carries.**
- Every event carries `occurred_at`, a gapless per-box `box_seq`, `boot_id`, and `clock_trust` (ntp|rtc|ipad|untrusted).
- The cloud adds `received_at` and `clock_offset_ms`.
- Order within one box uses `box_seq` and never the timestamps.
- The business date is derived on the box in Asia/Bangkok time. Sales made on an untrusted clock are flagged into end of day.

**Alert.** Raise an alert when a heartbeat shows more than 2 seconds of skew.

## 5. Box ledger and durability

- Each box keeps two SQLite files (better-sqlite3, arm64):
  - `ledger.db` runs in WAL mode with `synchronous=FULL`. It holds the command log, sales, payment attempts, cash, wallet entries, releases and the outbox.
  - `cache.db` runs with `synchronous=NORMAL` and can be rebuilt from the cloud.
- Every ledger event stores `prev_hash`, giving a per-box hash chain. Batches are signed with the `box-auth` key. The cloud checks chain and `box_seq` continuity, so a missing sequence number is evidence of loss or tampering.
- Backing up unsynced facts:
  - The outbox is the only copy of unsynced money facts, and the box has one NVMe and no UPS.
  - Mirror unsynced events to a second medium (a USB flash drive or SD journal) that the spare box can import.
  - Print a Z-report at close as a paper trail.
- After acknowledgement, keep events for 35 days for reprints and forensics.
- Run `PRAGMA integrity_check` at boot. On failure, quarantine the file, start with an empty cache and raise an alert.

## 6. Sale and payment state machine

**Sale (owned by the box).**
- The states are `draft`, then `tendering`, then `paid`, then `finalised`.
  - `draft` lives only in the station session and never syncs.
  - In `tendering` the totals are frozen by the shared engine (section 13) and the sale_id is minted.
  - `finalised` allocates the receipt number, writes the ledger rows, enqueues the outbox event and queues the print jobs, all in one SQLite transaction.
- After `finalised` the sale is immutable.
  - Void, refund and credit are new documents that reference the original, with their own number series (SCRUM-51, SCRUM-61).
- A sale cannot be abandoned while it holds captured tenders. They must be voided first.
- The iPad sends `finalise {commandId, saleId, expectedTotal}`. The box compares `expectedTotal` with its own computed total and returns 409 on mismatch. The iPad's arithmetic is never authoritative.

**Payment attempt (one per tender try).**
- States:
  - `created`, then `sent_to_terminal`, then one of `approved`, `declined`, `cancelled` or `unknown`.
  - `unknown` moves to `inquiring`, then to `approved`, `declined` or `not_found`.
- The attempt is persisted with fsync before any bytes are sent.
- Every retry is a new attempt with a new terminal reference. References are never reused, so an inquiry is never ambiguous.
- An `unknown` attempt blocks the whole station (the brief's rule).
- Boot recovery finds attempts left in `sent_to_terminal` and forces resolution.
  - This is the power-cut case: the terminal, on battery and 4G, approved the charge while the Pi was dead.

**GHL card sales (no inquiry).**
- The state is `awaiting_staff_confirmation`.
- Staff must type the approval code from the slip or the terminal log. The code is checked against settlement on T+1. Declines are recorded too.
- A manager escape hatch, 'carry to reconciliation', exists so that a broken terminal cannot wedge a queue of families. It opens an exception that settlement must close.

**Adapters.**
- The adapters are `GhlLinkPos`, `DigioDirect`, `Simulator` and a fourth, `ManualEntry`.
  - `ManualEntry` uses the same state machine, with staff confirmation as the normal path.
  - LinkPOS enablement is still open, and untethered terminals will stay in use.
- Each adapter exposes `reversalOptions(original, now)` returning void, refund or manual.
  - The UI reads this capability matrix, so void windows (card before settlement, wallets before 23:00, no GHL QR void) are data and not code.

**Terminal references.**
- Digio's 6-digit reference is a counter per TID, persisted on the box and mirrored to the cloud. If a terminal moves to another box, the new box starts from the cloud value plus 1000.
- GHL's 12-character `pos_ref_no` is the station code plus a base32 counter.
- Both map to the attempt_id.

**In-person QR routing.**
- On the station that owns the PAX terminal:
  - Use Digio QR, with the A18 payload drawn on the customer display.
  - It works offline and supports inquiry.
  - The screen is the same whether the park is online or offline, so there is no switch-over race.
- On other stations:
  - Use 2C2P, brokered by the cloud. The box calls `POST /payments/qr-intents {attemptId,...}`, idempotent on the attempt id.
  - The cloud runs Payment Token and Do Payment, receives the webhook and polls, then pushes `payment.updated` over the WebSocket. The box also polls as a backstop.
  - The 2C2P invoiceNo is derived from the attempt_id.
  - The QR expires after 3 to 5 minutes.
  - When offline, the station tells staff that QR is unavailable here and to use counter X, cash or card.
- If the link drops while a 2C2P QR is displayed:
  - The attempt becomes `unknown`.
  - It is resolved by inquiry when the link returns, or by an audited staff confirmation from the customer's bank slip.
- A cloud job refunds any 2C2P intent that was paid but has no finalised tender. This catches orphans and late successes.

**Settlement.** `settle()` runs per TID at close. The batch totals are compared with the box's approved attempts and stored as a `settlement_batch`.

## 7. Receipt and abbreviated tax-invoice numbering

- The number format is `{branch}{station}-{series}-{seq}`.
  - The `seq` is allocated inside the finalising SQLite transaction and never at draft, so the series has no gaps by construction.
  - A voided sale keeps its number. The void is a separate document.
- The cloud assigns a new `series` whenever a station binds to a different or re-imaged box.
  - A spare box therefore cannot collide with the dead box's unsynced tail.
  - A recovered NVMe drains into its own closed series.
- The cloud keeps a `pos.receipt_series` register per series:
  - station, box, first and last number, open and close dates;
  - an incident record if the tail of a series is unknown.
  - This register is what an auditor needs.
- Only boxes finalise in-park sales. Online bookings use a cloud-owned `WEB` series.
- Separate series exist for the receipt/abbreviated invoice, refund documents, and full tax invoices on request.
- Build the format as configuration. The accountant confirms the scheme, and also whether each till counts as a registered cash-register machine.
- Reprints are marked as copies.

## 8. Cash

- A `cash_session` exists per drawer and is owned by its box.
- `cash_movement` rows are append-only: opening float (carried over from the previous close, as the prototype's `EndOfDay.floatLeftTHB` does), cash in, change, refund out, paid-out (reason, approver), safe drop (witness), float top-up, no-sale drawer open.
- Closing the session:
  - The close is a blind denomination count.
  - Variance is computed after the count is submitted.
  - A manager must sign off variance above a threshold.
  - Variance is attributed to the closing staff member, and the record lists everyone who used the session.
- All of this works offline.
- Branch end of day:
  - It keeps the prototype's per-channel structure: cash, `card:<tid>`, QR, wallet.
  - It stays provisional until every box has synced.

## 9. Wallet

**Model.**
- `pos.wallet` has lookup keys in `wallet_key`: band, voucher QR, child.
- `wallet_entry` is the truth. It is append-only and carries a box-minted id, station, actor, sale link, origin and `box_seq`.
- `wallet_balance` is a projection updated in the same cloud transaction.
- Meal entitlements use the same ledger with an item unit.

**Spend.**
- Online, the cloud authorises synchronously under a row lock.
- Offline, a spend is allowed if the amount is at most the smaller of:
  - the cached balance plus imported signed grants, minus local unsynced spends;
  - the remaining cap for that wallet, box and day.
- The entry is flagged `offline`.

**Reconciliation.**
- On sync the cloud inserts the entry unconditionally, because the food was served.
- A negative balance creates a `wallet_overdraft` exception. It is shown on the release screen so staff can collect from the parent, or else written off to a named account.

**Loss bound and other rules.**
- The worst loss per wallet per outage is (number of spend boxes minus 1) times the cap.
- Hosting all F&B and merch stations of a branch on one box makes the double-spend loss zero. What remains is stale-cache risk, which the cap limits.
- Wallet cash-out and refund to cash are `online_only`.
- Expiry and reactivation (SCRUM-91) are cloud jobs that write entries.

## 10. Single-use redemption

- `pos.redemption` is append-only and unique on event id only.
  - It must never be unique on the instrument, because a unique constraint would reject the second offline redemption and lose a fact.
  - Double use is a query over the table, feeding the exceptions queue with both staff ids.
- Online, the cloud's claim decides.
- Offline, the rule depends on the prize class:
  - a free drink is `offline_ok`;
  - free admission or a high-value prize is `online_only`.
- The booth's 'one spin per band/phone' rule has the same shape: checked against the local log offline and the cloud when online.

## 11. Cloud ingest and ledger schema

**Schema.** `packages/db/src/schema/future.ts` is rewritten as a `pos` Postgres schema with these tables:
- sale, sale_line (snapshots plus an engine version, so history is never recomputed), payment_attempt;
- cash_session, cash_movement;
- settlement_batch, settlement_line, recon_match;
- wallet, wallet_key, wallet_entry, wallet_balance;
- band, band_event;
- redemption, release, receipt_series.

**Ledger tables.**
- They carry `station_id`, `box_id`, `occurred_at`, `received_at`, `origin`, `clock_trust` and `box_seq`.
- A hand-written trigger blocks UPDATE and DELETE on them.

**Ingest.** `POST /sync/batch`, or the WebSocket, authenticated as a device. A batch is a set of aggregate events.
- One event `sale.finalised` carries the sale, lines, attempts, bands, wallet entries, cash movement and audit rows.
- Each event is applied in one Postgres transaction through the same service functions the HTTP routes use.
  - These services must first be extracted from `apps/api/src/routes/*` and wrapped in transactions.
- `core.sync_event` records each event.
  - Columns: `event_id` (primary key, kept permanently), `box_id`, `box_seq`, `status`.
  - `(box_id, box_seq)` is unique.
- The per-item result is one of applied, duplicate, flagged or rejected.
- Member handling:
  - A member created offline arrives as its own event earlier in `box_seq`.
  - A `member_alias` table remaps merged ids, and the box is told the canonical id.

**Exceptions.** An exceptions console with owners and ageing must ship with ingest. Without it the flags pile up and nobody works them.

## 12. Idempotency per hop

| Hop | Mechanism |
|---|---|
| iPad to box | A command id is minted when the user acts and kept in the till-session reducer. The box `command_log` replays the stored result. |
| Box to terminal | The attempt is written ahead, the terminal reference is unique, and inquiry resolves unknowns. |
| Box to cloud | Permanent `event_id`, entity primary key with ON CONFLICT DO NOTHING, and `box_seq` gap detection. |
| Cloud to 2C2P | invoiceNo derived from the attempt id. |
| Box to printer | A job id with at-least-once delivery and a visible COPY mark. The printer itself is not idempotent. |

The Sprint 1 `Idempotency-Key` plugin (`apps/api/src/plugins/idempotency.ts`) stays for browser-to-cloud calls only. It needs three fixes: never cache 5xx responses, claim the key atomically, and make the principal generic.

## 13. Shared domain engine

- Create `packages/domain`: pure functions in satang, with catalog and tax config passed in as arguments.
- Port `apps/pos/src/lib/{sale,tax,pricing,manualDiscount,promoVoucher,fnb,dropoff}.ts` into it.
- Add golden tests that run the same fixtures through the prototype functions and the port.
- It runs on the iPad for preview, on the box as the authority, and in the cloud for checks and bookings.
- Each sale records the engine version.

## 14. Settlement reconciliation (cloud only)

- A `SettlementSource` adapter with column-mapping config and simulator files, so the SCB report format does not block Sprint 2.
- Match keys:
  - cards: TID, batch and trace/invoice number, approval code, amount;
  - PAX QR: TID, terminal transaction id, amount;
  - 2C2P: invoiceNo, exact.
- Exceptions:
  - in OTO but not in the bank's report (a staff-confirmed GHL sale that actually declined; chased first on T+1);
  - in the bank's report but not in OTO (a double charge, an orphan intent, or use of a standalone terminal);
  - amount mismatch.
- Capture fees for the accounting export.

## 15. Child release offline (guarantees and evidence)

**Guarantees.**
- **G1 The software may warn but never refuses a release.**
  - Any box can release a child it knows.
  - A box that has never seen the check-in (check-in at box A while offline, pickup at box B) verifies the signed pickup slip or the child's signed band.
  - The last resort is a documented manual release with a second staff witness.
- **G2 Off-list collectors.** Releasing to someone not on the list needs a manager override, a reason, and a recorded attempt to phone the dropper-off parent. The override permission is evaluated offline from cached roles.
- **G3 Freshness is shown.**
  - The release screen shows 'pickup list last synced HH:MM - offline'.
  - When the list is stale and the collector is not the dropper-off, a recorded phone confirmation is required.
  - A pickup person disabled elsewhere during an outage cannot reach the box. This is the residual risk and must be stated to the client.
- **G4 Durable before confirm.** The release is written to `ledger.db` with `synchronous=FULL` and then to the mirror journal. It has top sync priority.
- **G5 Double release is kept and flagged.** A double release from two offline boxes is stored twice and flagged. Neither record is rejected.
- **G6 Corrections are new events.**

**Evidence recorded for every release.**
- The ids: release id, check-in, child, and the scanned band id.
- The collector, either by list id or as ad-hoc name, phone and relationship.
- The verification method: matched to the list by staff, slip scanned, phone call to the parent, or ID type seen. No photo of any identity document is stored.
- The pickup photo: its content hash is stored inside the event, and the file is uploaded later.
  - The prototype makes this photo mandatory (`apps/pos/src/mockApi.ts` line 5277).
  - Consent and retention are an owner decision under PDPA.
- Who and where:
  - staff id, jti and `auth_method`;
  - the witness for overrides;
  - station and box.
- Event metadata:
  - `occurred_at`, `clock_trust`, `box_seq` and the offline flag;
  - the list version and synced-at time the staff member actually saw.
- The wallet settlement at pickup: unused prepaid value and any overdraft.

**Cache placement.** Pickup lists and allergy notes are cached only on counter and kiosk boxes, never on gate or booth boxes.

## 16. Tests

- A convergence harness runs in one Vitest process.
  - It uses `buildApp` on embedded Postgres plus `buildAgent` on SQLite, joined by a link that can be cut.
- A simulator terminal supports scripted faults.
- A crash-point property test kills the agent at every step of finalise and of a payment attempt. After recovery it asserts:
  - no finalised sale is lost;
  - no receipt number is duplicated or skipped;
  - every open attempt blocks the station until it is resolved.
- The release flow gets its own explicit test matrix (SCRUM-78).