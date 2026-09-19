# DESIGN offline-trust-money

## Summary
This is a read-only design review: nothing was run, and nothing in the repo was changed. Thai tax-invoice rules, the GHL/Digio protocol details and the 2C2P field limits are taken from the brief and general knowledge. They are not verified against vendor documents or the accountant.

The brief's offline model has the right shape: the box acts, the cloud records, and tokens verify themselves. Five of its specific choices are unsafe or fragile, and Sprint 1 has none of the money path yet.

**Main disagreements with the brief**
1. **Shared HMAC key.** The brief puts one band-signing key on every box. Booth boxes sit in mall corridors and run the same image. One stolen Pi could then mint bands, bookings and vouchers for the whole operator, and rotating the key would not help while old bookings must still verify. Use Ed25519 instead:
   - The cloud alone signs bookings and staff tokens.
   - Each box signs what it issues with its own key, limited to certain token types. A booth key can sign vouchers and nothing else.
   - A band payload still fits a 41x41 QR (version 6-M) on a wristband.
2. **Receipt numbering.** A per-station prefix is necessary but not enough. Add a series segment that changes whenever a station moves to a new box. Then a spare box can never collide with sales not yet synced from the dead box.
3. **UPS and RTC battery.** No UPS and no RTC battery is not acceptable for a ledger on a Pi. The EDC terminals run on battery and their own 4G, so a power cut mid-sale produces an approved charge that the box has no record of.
4. **In-person QR.** The brief makes 2C2P the primary QR path. On the station that owns the PAX terminal, use Digio QR instead, with the A18 payload drawn on the customer display. It works offline, supports inquiry and settles directly with SCB. Use 2C2P, brokered by the cloud, only on stations without a PAX. The merchant secret never goes on a Pi.
5. **Unlock every two minutes.** Use a station PIN checked on the box, not the account password. The Sprint 1 lock must stop deleting the server session.

**Core design**
- **Accept and flag.** The cloud never rejects a fact that already happened. Policy breaches go to an exceptions queue.
- **Durable local ledger.** Each box keeps a write-ahead, hash-chained SQLite ledger with a gapless `box_seq`.
- **One event per sale.** Each finalised sale is one aggregate event, applied in one Postgres transaction and deduped on a permanent event id.
- **Payment attempts.** Every attempt is persisted before any bytes go to the terminal. An unresolved attempt blocks the station until it is inquired, confirmed by staff, or released by a manager.
- **Wallets.** The entries are the truth and the balance is a projection. An offline sale at one box can print a signed grant, so another box can honour the credit.
- **Child release.** The software can warn but can never refuse. A signed pickup slip lets a box release a child it has never seen. The evidence set is fixed.

`packages/db/src/schema/future.ts` should be rewritten before the production dump is mapped. The Sprint 1 `Idempotency-Key` plugin should not be extended to the box path.

## Key decisions
- **Use Ed25519 for every signed code instead of a shared HMAC key. The cloud holds the booking and staff-token private keys. Each box generates its own issuer key on the device, limited by token type, so a booth key can sign vouchers only. Verifiers hold only public keys.** — With HMAC, anything that can verify can also forge. The brief puts the key on every box, including booth Pis that sit unattended in mall corridors and run the same image. One stolen NVMe could then mint bands, bookings and vouchers for the whole operator. Rotation does not fix this, because old keys must keep verifying bookings made weeks ahead. With Ed25519, a stolen box exposes only that box's own tokens, limited to its type and day. Revocation is a single kid. Node has native Ed25519 support. (rejected: Shared HMAC, the brief's choice: the blast radius and rotation are unacceptable. Per-station HKDF-derived HMAC keys: every verifier still holds every key. TPM or secure-element HATs: they add image complexity and do not remove the fact that a verifier can forge. HMAC limited to park boxes stays as the documented fallback for bands only, in case the 41x41 QR scans badly on real band stock.)
- **Accept-and-flag ingest. The cloud records every authentic fact from a box. Policy breaches become exceptions, never rejections. Redemption and wallet tables have no unique constraint on the instrument.** — A sale made by a since-fired employee, a second offline voucher redemption and a wallet overdraft all really happened. Rejecting them loses money records and release records. A unique index on the instrument id would silently drop the second redemption, which is exactly the case that needs investigating. (rejected: Rejecting policy-violating events at sync, which leaves the ledger incomplete and wedges the outbox. Last-write-wins merge on mutable rows, which does not suit money.)
- **Send one aggregate event per business fact. For example, sale.finalised carries the sale, lines, attempts, bands, wallet entries, cash movement and audit. The cloud applies it in one Postgres transaction and dedupes on a permanent event_id plus the entity primary key. A gapless per-box box_seq and a hash chain run across events.** — It removes the hazards of foreign-key ordering and partial state that come with many small events. It reuses the transactional service layer that Sprint 1 still lacks. Gaps in box_seq reveal lost or withheld events. (rejected: Extending the Sprint 1 Idempotency-Key plugin to the box path. That plugin is tied to an account, has a 24-hour TTL, caches 5xx responses, wedges on in-flight rows and needs byte-identical bodies. Row-level CRDT or changefeed sync for ledger data was also rejected.)
- **Use a write-ahead payment attempt. Persist the attempt with fsync before sending bytes to the terminal. Use a new terminal reference on every retry. An unknown attempt blocks the station until it is resolved by inquiry, by an audited staff confirmation with the approval code typed in, or by a manager 'carry to reconciliation' override.** — The terminals run on battery and their own 4G, while the Pi has no UPS. A power cut mid-sale therefore produces an approved charge the box never recorded. Without a persisted intent, boot recovery cannot even know that an unresolved attempt exists. Reusing a reference would make an inquiry ambiguous. (rejected: Recording only completed payments. Reusing one reference per sale across retries. Hard-blocking the station forever on an unresolved GHL sale, because a broken terminal must not stop a queue of families.)
- **Add a ManualEntry terminal adapter as a fourth first-class adapter, using the same state machine as the real ones.** — LinkPOS enablement on the production TIDs is still open. Untethered terminals will continue to be used standalone. SCRUM-54 already assumes manual keying. Treating manual entry as just another adapter keeps the recording and reconciliation path the same. (rejected: A separate 'record external payment' code path outside the state machine.)
- **For in-person QR, use Digio QR on the station that owns the PAX terminal, with the A18 payload drawn on the customer display. Use 2C2P, brokered by the cloud, only on stations without a PAX. The 2C2P merchant secret and the webhook live only in the cloud.** — The PAX path works with no park internet, supports inquiry for every payment type and settles directly with SCB. The customer sees the same screen online and offline, so the 2C2P-to-PAX switch-over race does not exist on that station. Putting the 2C2P secret on a Pi would bring back the blast-radius problem. The webhook cannot reach the park anyway. (rejected: 2C2P as the primary everywhere with automatic fallback, which is the brief's choice. It suffers the late-success race and adds a second reconciliation source on every QR sale. Boxes calling 2C2P directly were also rejected.)
- **Number receipts as branch+station prefix, then a series segment, then a gapless sequence allocated inside the finalising SQLite transaction. The cloud assigns a new series whenever a station binds to a new or re-imaged box, and keeps a series register.** — A station prefix alone stops two tills from colliding. It does not stop a spare box from colliding with the dead box's unsynced tail. A void keeps its number, and reversals are new documents, so the series stays gapless. The series register is the audit artefact. Per-station series also line up with Thai per-machine practice, which the accountant must confirm. (rejected: Number ranges leased from the cloud, which leave gaps and fail when offline at lease exhaustion. A cloud-allocated number at sync, because the receipt is already printed by then. A daily sequence reset, unless the accountant asks for one.)
- **Make the wallet entries the truth and the balance a projection. Cap offline spend per wallet, per box, per day. Print signed wallet grants on the wallet voucher. Insert overdrafts unconditionally and raise them as exceptions shown at child release.** — A mutable balance_satang, as in future.ts today, cannot reconcile spends from two offline boxes. Without signed grants, credit sold at counter A during an outage cannot be spent at the restaurant on box B. That would disable the prepaid feature during exactly the busy-day outages. The loss is bounded at (number of spend boxes minus 1) times the cap. (rejected: A mutable balance column. Wallet spend that is online-only, which means children cannot eat when the internet is down. A LAN hub for wallet holds, which breaks the no-peer rule and adds a second topology.)
- **Keep the no-peer-to-peer rule. Recommend hosting all wallet-spend stations of a branch on one box where the floor layout allows.** — A single spending box serialises wallet spends, so double-spend loss is zero with no new protocol. The internet is the common failure, not the LAN, but adding a LAN hub later is possible because claims are already modelled as claim(instrument). (rejected: A park hub box for redemption and wallet claims. It was considered and rejected because of hub failure and split-brain, a second sync path, and conflict with brief sections 3 and 13.)
- **Use a 6-digit station PIN checked on the box for unlock and for offline sign-in. Bind the staff token to the box through aud=box_id. Allow offline fresh sign-in only when the staff member was seen on the box within 30 days, the last sync was under 72 hours ago and the PIN is correct. An offline session gets a restricted permission overlay, and a manager PIN must co-sign risky actions.** — Typing a full password every 2 minutes at a busy counter is poor usability. Replicating the suite-wide password hash to Pis exposes the credential that will also guard HR and finance. A PIN hash is crackable if a box is stolen, but its reach is limited to boxes on that LAN. It can be force-reset for exactly the accounts cached on the stolen box. (rejected: Replicating the argon2 password hash to boxes. Allowing no offline sign-in at all, which stops the park at shift change during an outage. Using the 30-day rule alone with no sync-freshness limit.)
- **Apply clock discipline. Fit an RTC battery. Use the router as LAN NTP and the cloud time in heartbeats. Persist a last_good_time floor. Treat cloud-signed iat values and iPad time as recovery witnesses. Put clock_trust and box_seq on every event. Never block a sale because of the clock.** — With no UPS and no RTC battery, the Pi boots with a stale clock. That breaks token expiry, band validity, the business date and tax-invoice timestamps. iPads keep time through outages, and one is always present at a sale. (rejected: Trusting the box wall clock. Blocking sales when the clock is untrusted. Using boxes as NTP peers for each other.)
- **For child release, the software may warn but never refuses. A signed pickup slip and the signed band let a box release a child it has never seen. The evidence set is fixed and includes the age of the list the staff member actually saw. The last resort is a manual release with a witness.** — Boxes cannot see each other. A check-in made at counter 1 while offline is unknown at counter 2 unless the proof travels with the parent. The dangerous case is a pickup person disabled elsewhere during an outage. That can only be reduced by showing the list's age and requiring a recorded phone confirmation. It cannot be removed. (rejected: Allowing release only at the box that did the check-in. Blocking release when the record is unknown, which violates the brief's mandatory rule.)
- **Mirror unsynced ledger events to a second medium on each box, and print a Z-report at close.** — During an outage the outbox on a single NVMe, with no UPS, is the only copy of money and release facts. If a box dies, that outage window would be lost, along with the tail of its receipt series. (rejected: IndexedDB on the iPad as the backup, because iOS evicts PWA storage. Relying on the NVMe alone.)

## Risks
- [critical] A card payment on GHL LinkPOS can end with an unknown outcome, and LinkPOS has no inquiry. There is no UPS, so the Pi can die mid-sale while the battery-and-4G terminal approves. The result is either a double charge (staff take a second payment) or an unpaid sale (staff confirm 'approved' wrongly). — MITIGATION: Persist the attempt before sending, and let boot recovery block the station. Make staff type the approval code from the slip, then validate that code against settlement on T+1 with top priority. Provide a manager 'carry to reconciliation' override. Ask SCB to enable cards on the PAX/Digio terminal, which can inquire. Make a UPS for each counter box plus router and switch a go-live requirement. Test every crash point with the simulator.
- [critical] Child release uses data that is stale or missing. A child can be checked in at box A while offline and picked up at box B. A pickup person can be disabled elsewhere during an outage, for example in a custody dispute. — MITIGATION: Issue a signed pickup slip and a signed band. Show the list's age and the offline state on the release screen. When the list is stale and the collector is not the dropper-off, require a recorded phone confirmation to the dropper-off parent. Require a manager override for collectors not on the list. Never refuse a release. Store and flag double releases. State the residual risk to the client in writing. Build an explicit test matrix for SCRUM-78.
- [critical] A box can fail during an outage and lose unsynced money and release facts. The cause could be a single NVMe, an unclean power loss, or a consumer SSD that does not honour flush. The tail of its receipt series then becomes unknown. — MITIGATION: Run ledger.db in WAL mode with synchronous=FULL. Mirror unsynced events to a USB or SD journal that the spare box can import. Fit a UPS. Run integrity_check at boot and quarantine on failure. Print a Z-report at close. Keep a series register with an incident record for any unknown tail. Give releases and sales top sync priority.
- [high] If the brief's shared HMAC key is kept, one stolen box can forge bands, bookings and vouchers for the whole operator. Booth boxes are the easiest to steal. Rotating the key would break bookings already issued. — MITIGATION: Adopt per-issuer Ed25519 keys, limited by token type. The cloud alone signs bookings. Revoke by kid with an effective-from date. Treat a missing heartbeat as a theft alert. When online, the cloud claim always decides, and the signature is only the offline fallback.
- [high] Receipt and abbreviated tax-invoice numbering may not conform. Risks include collisions after a box swap, gaps from numbers allocated at draft, cloud-path sales writing into a station series, and a scheme that depends on the accountant and possibly on Revenue Department cash-register approval. — MITIGATION: Add the series segment and the series register. Allocate the number only inside the finalise transaction. Make boxes the only writers of station series, with WEB as a cloud-owned series. Build the number format as configuration. Get the accountant's answer before go-live, and ideally before the schema is frozen.
- [high] The box clock can be wrong after a power loss with no RTC battery and no NTP. That gives a wrong business date, tax-invoice timestamps that cannot be defended, staff-token expiry that can be bypassed or falsely triggered, and bands with a bad validity window that the gate rejects. — MITIGATION: Fit an RTC battery with trickle charging enabled. Run chrony with the router and cloud heartbeat time as sources. Persist a last_good_time floor. Use signed iat values and iPad time as witnesses. Put clock_trust and box_seq on every event. Raise a skew alert. Flag untrusted-clock sales into end-of-day review.
- [high] A 2C2P QR can succeed late or be orphaned. The customer pays a displayed QR after the link drops, or pays both the 2C2P QR and a fallback method. The webhook then lands in the cloud with no matching tender. — MITIGATION: Prefer the PAX A18 QR on the station that owns the PAX, so there is no switch-over there. Give the 2C2P QR a short expiry. A dropped link puts the attempt in the unknown state, under the same blocking rule. A cloud job finds paid intents with no finalised tender and queues a refund through Payment Maintenance. Derive invoiceNo from the attempt id. Webhook plus polling is already in the brief.
- [high] Offline wallet spends can overdraw a wallet, and cached balances can be stale. Credit sold at one box may be unknown to the spending box. The production-dump balances may map onto the wrong owner, because today's schema keys the wallet to the member while the prototype puts it on the band. — MITIGATION: Make the entries the truth and the balance a projection. Cap spend per wallet, per box, per day. Print signed grants. Host spend stations on one box where possible. Show overdraft exceptions at release, and write off what is not collected to a named account. Decide the wallet owner before mapping the dump. Keep cash-out online-only.
- [high] Totals can diverge. The POS computes in float baht in the browser (apps/pos/src/lib/sale.ts, tax.ts), while the box and cloud must use satang. The customer display, the receipt and the tax invoice could then disagree, and historical sales could be recomputed differently. — MITIGATION: Create packages/domain as the single engine, with golden tests against the prototype's outputs. Make the box authoritative, returning 409 when the expected total does not match. Store snapshots and the engine version on sale and sale_line. Get a written rounding policy for percentage discounts, VAT-inclusive prices and cash rounding.
- [high] A stolen box exposes PIN hashes, cached staff roles and personal data on members and children, including children's names, allergy notes and parent phone numbers. That is a PDPA issue. A fired employee remains valid on a box that has been offline the whole time. — MITIGATION: Limit each box's cache to what its role needs. Booth and gate boxes hold no pickup lists and no allergy data. Member caches hold only members recently seen at that branch, and the merge rule makes partial caches safe. Use a PIN, not the password hash. Force-reset PINs for accounts cached on a stolen box. Put boxes in locked cabinets. Consider LUKS with a TPM HAT as hardening during stabilisation. Limit offline sign-in by sync freshness and apply the restricted overlay.
- [medium] Single-use instruments such as booking QRs, booth vouchers and promo vouchers can be redeemed twice at two offline boxes. — MITIGATION: Set an offline policy per prize class, with high-value prizes online-only. Keep an append-only redemption log with no unique constraint on the instrument. Report conflicts with both staff ids. When online, the cloud claim decides.
- [medium] Terminal reference schemes are a risk. The Digio 6-digit counter per terminal has an unknown uniqueness scope and rolls over. The GHL reference is limited to 12 characters. A terminal moved between boxes loses counter continuity. — MITIGATION: Keep the counter per TID, persisted on the box and mirrored to the cloud. When a terminal moves, start from the cloud value plus 1000. Never reuse a reference. Map references to the attempt id. Scope uniqueness by settlement batch until Digio confirms otherwise.
- [medium] The SCB and 2C2P settlement report formats and delivery method are unknown. Fees complicate gross-versus-net matching. Payments confirmed manually by staff, and payments taken on a standalone terminal, have no machine key to match on. — MITIGATION: Build a SettlementSource adapter with column-mapping config and simulator files. Capture trace, invoice, batch and approval codes from the terminal responses. Match exactly first, then fuzzily. Chase staff-confirmed payments on T+1. Send bank lines that match nothing in OTO to a queue for manual recording.
- [medium] Accept-and-flag creates a backlog of exceptions: overdrafts, double redemptions, post-revocation events, unknown payments and clock flags. If nobody works the queue, the design fails without anyone noticing. — MITIGATION: Ship an exceptions console with ingest. Each exception type gets an owner, an ageing indicator and a required resolution note. Day-end close shows the open exceptions. Alert on dead-letter rejects and on box_seq gaps.
- [medium] Append-only enforcement is at risk from ORM habits and from the migration importer. Drizzle does not manage triggers. The importer and future modules may run UPDATE against ledger rows. — MITIGATION: Write a SQL migration with a trigger that blocks UPDATE and DELETE on ledger tables. Give projection tables a separate write path. Make the importer write with origin=migration and legacy provenance. Add a CI check that the triggers exist.
- [medium] Printers are not idempotent. A retry after an unknown print result can produce a second band or a second tax-invoice original. A power cut between commit and print can leave a finalised sale with no receipt. — MITIGATION: Give each print job an id and a state. Query printer status for paper-out. Keep a recovery list of unprinted receipts at boot. Mark reprints as COPY. A reprinted band keeps the same band_id, so anti-passback treats it as the same band.
- [low] Ed25519 makes the band QR denser: 41x41 modules against 29x29 with HMAC. That could hurt gate scan speed or phone-camera reads (SCRUM-95) on a curved band. — MITIGATION: Test on the real 4B-2082A band stock early in stabilisation. Use a compact binary body with base45 encoding. The documented fallback is a truncated HMAC for bands only, with keys held only by park boxes.

## Changes to Sprint 1 foundations
- Rewrite packages/db/src/schema/future.ts rather than extend it. Build a pos ledger schema with these tables: sale, sale_line (snapshots plus an engine_version), payment_attempt, cash_session, cash_movement, settlement_batch, settlement_line, recon_match, wallet, wallet_key, wallet_entry, wallet_balance (a projection), band, band_event, redemption, release and receipt_series. Every ledger table carries station_id, box_id, occurred_at, received_at, origin, clock_trust and box_seq. The existing tables are empty and no API code uses them, so there is nothing to migrate.
- Add core.signing_key, holding the kid, owner, purpose, public_key, allowed_types and the validity and revocation columns. Add a box table that stores public keys. Remove station.device_key_hash from packages/db/src/schema/platform.ts. Add station.box_id and a foreign key on session.station_id.
- Add core.sync_event with event_id as primary key, box_id, box_seq and status, and make (box_id, box_seq) unique. Add a sync dead-letter table. Add a hand-written SQL migration with triggers that block UPDATE and DELETE on ledger tables, since Drizzle does not manage triggers.
- Extend audit_log in packages/db/src/schema/platform.ts and AuditEntry in apps/api/src/services/audit.ts. Add occurred_at, origin, station_id, box_id, actor_type, auth_method, session_jti, a unique source_event_id and clock_trust. Fix signOut so its audit row includes operatorId.
- Extract the write logic from apps/api/src/routes/{members,visits,accounts,public,catalog}.ts into services that take a transaction handle. Add a withTx helper. There are currently no .transaction( calls at all. The sync ingest and the HTTP routes must share one write path.
- Accept client-minted UUIDv7 ids on every create that can sync: members.ts lines 206, 325 and 414, visits.ts line 48, and public.ts line 221. Use ON CONFLICT DO NOTHING. Add member_alias and merged_into_id. Replace the 409 MEMBER_EXISTS rejection with a merge on the sync path. Change the child foreign key from cascade to restrict.
- Fix apps/api/src/plugins/idempotency.ts for browser-to-cloud use only. Never store 5xx responses. Claim the key atomically with INSERT ... ON CONFLICT DO NOTHING. Key on (principal_type, principal_id). Cover POST /public/bookings. Do not route box traffic through this plugin.
- Add POST /auth/station-token, which mints an Ed25519 shift token from the cookie session with aud=box_id. Add core.account_credential for PIN and badge. Push revocations from invalidateAllSessions() and from sign-out. Move grantCovers, hasPermission and the scope types from apps/api/src/services/permissions.ts into packages/shared.
- In apps/pos/src/auth/OperatorContext.tsx, make the inactivity lock local so it no longer calls authApi.signOut. Add unlock by PIN. Remove the face-scan placeholders from LockScreen.tsx and mockApi.
- Create packages/domain as a pure satang engine. Port apps/pos/src/lib/sale.ts, tax.ts, pricing.ts, manualDiscount, promoVoucher, fnb and dropoff into it. Split apps/api/src/services/tax.ts into a data loader plus a pure resolver. Add golden tests against the prototype's outputs.
- Create packages/tokens, holding the OTO1 envelope, base45 encoding and Ed25519 sign and verify, shared by the API and the agent. Create packages/contracts, holding zod schemas for box commands and sync events.
- In apps/pos, mint command ids at the moment the user acts, and keep them in the till-session reducer. Today apps/pos/src/api/platform.ts mints a fresh key inside each wrapper. Replace the Math.random ids in apps/pos/src/lib/sale.ts with newId() from @oto/shared.
- Fix the two tenant leaks before any ledger data shares the database. GET /members/:id has no operator filter (members.ts lines 167-176). GET /public/member-tier has no operator or branch filter (public.ts lines 106-110). Also set trustProxy and COOKIE_SECURE for production.
- Extend the API test harness (apps/api/test/helpers.ts, packages/db/src/testing.ts) into a cloud-plus-box convergence harness. It should run buildApp on embedded Postgres and buildAgent on SQLite, joined by a link that can be cut, with simulator terminals that inject faults and crash-point property tests.

## Disagreements with brief
- Section 8, the band HMAC 'under a key every box holds', is unsafe. Booth boxes are unattended in mall corridors and run the same image, so one stolen Pi can forge bands, bookings and vouchers for the whole operator. Rotation does not help, because old keys must keep verifying bookings made weeks ahead. Replace it with Ed25519 issuer keys, one per box, limited by token type. Verifiers hold only public keys.
- Section 8, 'Booking QRs are signed the same way': boxes never mint bookings, so there is no reason for any box to hold a booking-signing secret. Only the cloud should sign bookings.
- Section 8, a per-station receipt prefix alone is not enough. When a spare box takes over a station, its numbers can collide with the dead box's unsynced tail. Add a series segment that the cloud assigns each time a station is bound to a box, and keep a series register.
- Section 6, 'No power backup yet' and the missing RTC battery should become go-live requirements for counter boxes, the router and the switch. The terminals run on battery and 4G, so a power cut mid-sale produces an approved charge the box never recorded. A stale clock corrupts financial timestamps and token expiry.
- Section 7.2, 2C2P as the primary in-person QR with the PAX as fallback, should be inverted on the station that owns the PAX. The Digio A18 payload drawn on the customer display works offline, supports inquiry and settles directly with SCB. Inverting removes the switch-over race and one reconciliation source. Keep 2C2P, brokered by the cloud, for stations without a PAX and for online booking. The 2C2P merchant secret must never be on a box.
- Section 13 rules out 'cloud-in-the-loop for any device action'. 2C2P QR needs internet and a cloud webhook by its nature, so treat cloud-brokered QR intents as an explicit exception to that rule. Do not leave it ambiguous.
- Section 5, 'unlock with password' every 2 minutes, should become a station PIN checked on the box. Section 5 together with Sprint 1: the inactivity lock must not delete the server session, as OperatorContext.tsx logout() currently does.
- Section 5 Open, the 30-day default for offline sign-in, is fine as a 'known staff' test but not enough on its own. Add a limit on sync freshness (72 hours by default) and a restricted permission overlay for offline sessions. A manager PIN must co-sign refunds, voids, paid-outs and cash-outs.
- Section 7.1, the adapter list, should gain a ManualEntry adapter as a first-class option, not a separate code path. LinkPOS enablement is still open, and untethered terminals will be used standalone.
- Section 7.1, 'prompt staff to confirm against the terminal's own screen', is too weak alone. Require the approval code to be typed from the slip and check it against settlement on T+1. Add a manager 'carry to reconciliation' escape so a broken terminal cannot wedge a station.
- Section 8, 'duplicate events are dropped by ID', is right for event ids. It must not be implemented as unique constraints on instruments (voucher id, booking id, wallet). Duplicates of the business action must be stored and flagged, never dropped.
- Section 4, the box cache of 'members and children' for the whole operator, should be reduced. Cache only what each box role needs, and only members recently seen at that branch. The merge rule already makes cache misses safe. This limits PDPA exposure if a Pi is stolen.
- Section 8, 'Every item idempotent by ID', should not be met by extending the Sprint 1 Idempotency-Key plugin to boxes. Use a separate device-authenticated ingest with a permanent event ledger.

## Open questions
- Accountant: which numbering scheme applies to the receipt and abbreviated tax invoice? Is a per-station series with a series segment (for example FD1-B-000123) acceptable? May the sequence ever reset? Do refund documents and full tax invoices issued on request need their own series? Does each till have to be registered with the Revenue Department as a cash-register machine? I have not verified the legal position.
- SCB: can card acceptance be enabled on the PAX/Digio terminals, which support inquiry, so that GHL is no longer the only card path? Is LinkPOS being enabled on the production TIDs? Is the refund function enabled on the terminals, or only void? Is there an automatic settlement time? In what format is the daily settlement report delivered (portal CSV, email, SFTP), and what are its columns?
- 2C2P against direct SCB QR on the PAX: what are the fees for each? Does 2C2P offer its settlement report by API or SFTP? Do you accept PAX QR as the primary method on the PAX station, with 2C2P used on stations without a terminal?
- Wallet: is the owner of the wallet the child (persisting across visits), the band (per visit, as in the prototype) or the member? We need the written expiry and refund policy for unused value (SCRUM-91). What is the offline spend cap in THB? When an offline overdraft happens, should staff collect it from the parent at pickup or write it off?
- Can all F&B and merch stations that spend wallet credit be hosted on one box per branch? That would remove offline double-spend entirely.
- Child release: the prototype requires a pickup photo. Do you consent to storing photos of collectors and children? For how long? Does the drop-off consent form cover it? What is the policy when the collector is not on the list and the dropper-off parent cannot be reached by phone? Do you accept the residual risk that a pickup person disabled elsewhere during an outage will not be known at an offline counter?
- Staff: do you accept a 6-digit station PIN for unlock and for offline sign-in, with the full password kept for cloud sign-in only? Is a 72-hour sync-freshness limit on offline sign-in acceptable? Which actions should need a manager to co-sign when offline (refund, void, paid-out, discount above a percentage)?
- Cash: is there one drawer per staff member, or one shared drawer per station? Should the close be a blind count? Above what variance is a manager sign-off required? Who may approve paid-outs and safe drops? Is a witness required for safe drops?
- Hardware: will you approve a UPS per counter box plus router and switch, an RTC battery per Pi, a USB or SD journal device per box, and locked cabinets, as go-live requirements? How are booth boxes physically secured overnight?
- Booth vouchers: which prize classes may be redeemed offline, and which are online-only? What is the highest voucher value you would accept being redeemed twice during an outage?
- Refunds: who may refund, up to what amount, and how? The options are a terminal void on the same day, a terminal or PSP refund later, cash, or a manual bank process. Is refunding admission conditional on the band being physically cut off?
- Which accounting system receives the settlement export (SCRUM-102)? What are the business-day cut-off times, given the 23:00 wallet void window and the terminal settlement time?
- Digio: what is the uniqueness scope of the 6-digit reference (per terminal, per batch or per day)? Is a sandbox unit available for both terminal families?

## Sequencing
- Send the long-lead external questions now, because the answers shape schema and adapter decisions and take weeks. They are: the accountant's numbering scheme and cash-register approval; SCB on cards for the PAX, LinkPOS enablement, the refund function and the settlement report format; 2C2P report access; and the Digio reference scope.
- Before any Sprint 2 feature work, fix the Sprint 1 defects. These are the role-assignment privilege escalation, the two tenant leaks, trustProxy, and the idempotency plugin's 5xx caching and non-atomic claim. Then extract transactional services from the route handlers. The 50 existing integration tests cover that refactor.
- Build packages/domain, the satang engine with golden tests, and packages/tokens, the Ed25519 envelope with the key registry, first. Every later step depends on one or both.
- Rewrite future.ts as the pos ledger schema. Decide the wallet owner before anyone maps the production dump. Wallet balances and transactions from the dump must land in the final model and not in the placeholders.
- Build the box ledger core and the cloud /sync ingest together with the convergence harness, and do it before any money feature. That covers box_seq, the hash chain, the outbox, core.sync_event, accept-and-flag, and crash-point tests.
- Next, build the sale and payment-attempt state machines against the Simulator terminal with scripted faults. The faults are timeout, no final response, power cut at each step, decline and cancel. Add the ManualEntry adapter, the receipt series and the cash sessions. The real GHL and Digio serial adapters wait for stabilisation.
- Build the 2C2P cloud broker against the sandbox, together with QR routing (PAX A18 preferred, 2C2P elsewhere) and the orphan-intent job. After that, build bands and the gate, booking redemption, and child release with its own explicit test matrix.
- Build wallets after the ledger and ingest are proven. That covers cap, signed grants and the overdraft exception. Then build F&B, then settlement import, reconciliation and end of day, and the booth vouchers last. The exceptions console must ship in the same increment as ingest, not at the end.
- During stabilisation, test on real hardware early: the band QR print and scan on real stock, the GHL parity question, RTC and UPS behaviour under real power cuts, and importing the journal onto the spare box.

# CRITIQUE — verdict: sound-with-changes. The shape is right: the box acts, the cloud records, tokens are asymmetric, payment attempts are written ahead, the ledger is entries-first, and ingest accepts and flags. The Sprint 1 claims I checked are all accurate.

The proposal still has several concrete defects that would fail in the field or open fraud paths:
- Box enrolment and keyset authenticity, which is the real root of trust, are not designed.
- Revocation by effective date is defeated by backdated tokens.
- The pickup slip and booking QR carry only hashes. An offline box cannot show who may collect a child or what to issue, so the slip becomes a bearer instrument for a child.
- Allergy warnings vanish at F&B for a child checked in at another box while offline.
- R1 treats an authenticated box as a trustworthy creator of money, with no quarantine state.
- The 2C2P orphan auto-refund races with offline finalisations. "Confirm from the customer's bank slip" is a known Thai fraud vector.
- The signed wallet grant double-counts against a cached balance.
- Wallets have no fund-source split. This matters because the prototype gives away ticket-price credit and defers VAT on stored value.
- `jti=session.id` cannot work because Sprint 1 hard-deletes sessions.

The proposal also has no cut line between go-live blockers and hardening, inside a Sprint 2 that must already finish all remaining software. Fix the listed items before the schema is frozen or the production dump is mapped. None of them needs a different architecture.

This was a read-only review. Thai tax treatment and vendor protocol behaviour (A18, LinkPOS, 2C2P QR refunds) are unverified here too.
- [critical] Box enrolment and keyset authenticity are not designed, and they are the real root of trust. The proposal says box keys are generated on the device at first boot and that the keyset ships in config sync. It never says how the cloud decides that a new public key belongs to a legitimate box, who approves its role and therefore its `allowed_types`, or what authenticates the keyset a box receives. The brief requires one identical image, so no per-device secret can exist before enrolment. — WHY: With per-box issuer keys, enrolling a box is the same as being allowed to mint bands, wallet grants and pickup slips. Enrolment also triggers a sync of members, children, allergy notes and PIN hashes.

Anyone who can enrol a rogue box, or insert a row into `core.signing_key`, defeats the whole Ed25519 model without stealing anything. Three routes exist today: a stolen admin cookie, the Sprint 1 role-assignment hole, or an enrolment token baked into the shared image. The role-assignment hole is at C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/oto-platform/apps/api/src/routes/accounts.ts lines 158-169, where any holder of `admin:role:assign` can grant any role at any scope.

The keyset is authenticated only by TLS to Render. A compromise of the API process therefore lets an attacker push a forged keyset to every box. — FIX: - **Enrolment ceremony.** A one-time, short-lived code is created in the admin console under a dedicated permission. It is bound to branch and role and is typed or scanned at the box.
- **Role approval.** Assigning a box role, and so its `allowed_types`, needs a second approver. It is audited and raises an alert such as "new box registered".
- **Offline root key.** Sign every keyset manifest with an offline root key held on a hardware token by the owner or lead. Pin its public key in the Pi image. Boxes reject any keyset that lacks a valid root signature and a version number that only increases.
- **Narrow write path.** Treat `signing_key` inserts as a privileged operation with its own narrow code path, not general admin CRUD.
- **Dependency.** Fix the accounts.ts escalation before any of this ships.
- [high] Revocation by `revoke_effective_from` is defeated by backdating. The verify rule accepts a token when "the kid is not revoked for that date", but the date inside a box-signed token (`issued_at`, `valid_from`) is chosen by whoever holds the key. — WHY: A thief with a stolen counter box can mint wallet grants and pickup slips dated before the last trusted heartbeat. Every verifier will accept them after revocation.

Bands are partly protected by their day scope. A box stolen at 14:00 can still mint bands with `valid_from` 09:00 the same day.

The proposal presents revocation as the containment for a stolen box. For the two most sensitive box-signed instruments, money and a child, it does not contain anything. — FIX: Make revocation switch that kid from "trust the signature" to "trust only known ids":
- The cloud publishes, with the revocation, the allowlist of token ids it had already received from that box in synced events before the cut-off. Boxes accept a token under the revoked kid only if its id is on that list.
- Tokens minted during the box's last unsynced window are unknowable. They go to the manual or flagged path.
- Put a hard ceiling on `wallet_grant` amounts in the verifier rules, so a stolen key cannot mint large value even before it is revoked.
- [high] Management of the cloud private keys is weak.
- **Storage.** The `staff-token` and `booking` private keys are "held as a Render secret", meaning environment variables readable by the API process, every dependency in it, and anyone with Render dashboard access.
- **Rotation.** Rotation waits until "every active box has acknowledged", which stalls on the shelf spare and on any box that is off.
- **Compromise.** There is no emergency path if a key leaks. — WHY: The staff-token key is the master credential of the offline model. A forged shift token carrying manager role assignments passes on every box, including offline ones that cannot hear a revocation.

The same API process will soon host HR, finance (Satang), messaging and AI modules once the suite is merged. That greatly widens the dependency and attack surface sitting next to that environment variable.

An orderly 7-day rotation is described. A leak needs an immediate rotation, and that is not designed. — FIX: - **Sign outside the API process.** Cloud-signed tokens (booking, staff) are not size-constrained. They need not be Ed25519. Only the band needs a compact signature. Use a managed KMS or HSM key (for example ES256), so the private key never sits in an environment variable.
- **If KMS is out of budget.** Isolate signing in a tiny separate Render service with its own secret and an allowlisted internal caller. Keep token lifetimes short.
- **Define "active box" for rotation.** Use "heartbeat within N days". Spares must fetch the keyset before they are bound to a station.
- **Emergency runbook.** A root-signed keyset (see the enrolment finding) marks the kid compromised from time T. Boxes then require online verification or re-login for that token type.
- [critical] The offline child-release proof carries hashes, not data, and the guarantees contradict each other.
- **Pickup slip.** Its body is `check_in_id, child_id, dropper-off guardian id, pickup-list hash`. A box that has never seen the check-in cannot show the authorised collectors from a hash. The release becomes "whoever holds the paper".
- **G1 against G2.** G1 ("never refuses a release") contradicts G2 (an off-list collector needs a manager override).
- **Two writers.** Releasing at box B a check-in owned by box A also breaks the proposal's own R3, one writer per aggregate. — WHY: This is the highest-risk workflow in the project, and SCRUM-78 says so.

A green "valid slip" screen makes staff less vigilant about the person in front of them. The slip can be lost or photographed.

The brief's actual rule is narrower than G1: a child is never refused "because the internet is down".

The common outage case is that box A is alive but has no internet. Box A holds the full record, including the dropper-off, the collector list and the allergy notes. The design ignores it because of the no-peer rule. — FIX: 1. **iPad-mediated lookup.**
   - The iPad is on the LAN and can call every counter box. The release screen fans out "find check-in" to all counter boxes. It records the release on the box that owns the check-in, through a branch-audience token or a second token.
   - No box-to-box traffic is involved, so the no-peer rule holds. There is a single writer and the full record. The double-release case disappears whenever the owning box is reachable.
2. **Slip fallback when the owning box is dead.**
   - The slip carries the real collector list (names and relationship), not a hash.
   - The UI wording is "check-in verified - now verify the PERSON", and never "authorised".
3. **Decision table.**
   - Replace G1 and G2 with an explicit decision table agreed with the owner. Connectivity and missing data never block a release. Identity rules always apply.
   - An off-list collector with no manager present is handled by a recorded phone confirmation with the dropper-off and a second staff witness.
4. **Camera failure.** This must not block a release. Today the prototype returns null without a photo (C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/oto-platform/apps/pos/src/mockApi.ts, around line 5277). Record `photo_unavailable` with a reason instead.
- [high] The allergy warning is lost at F&B when the child was checked in at another box during an outage. The proposal solves cross-box release with the slip, but it has nothing for cross-box F&B. The band payload has no allergy or may-order flag, and boxes cannot query each other. — WHY: SCRUM-95 says "Allergy display is a safety requirement, not a convenience. Treat it as blocking."

The park has counter 1, counter 2 and the gate. F&B stations must be hosted on one of the two counter boxes, and the proposal itself recommends putting all spend stations on one box. A child registered at the other counter while offline is unknown to the F&B box. The order proceeds with no warning.

The prototype's wristband record carries `allergiesMedical`, `foodRestrictions` and `mayOrderFood` for exactly this purpose (C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/oto-platform/apps/pos/src/mockApi.ts, around lines 300-315). — FIX: - **Band flag bits.** Add two bits to the band flags byte, `allergy_on_file` and `may_not_order_food`. They cost nothing in QR size.
- **Unknown band at F&B.** An F&B station that scans a band it does not know must show a hard interstitial: "ALLERGY ON FILE - details unavailable offline, confirm with parent or counter before serving". It must block self-directed child ordering.
- **Lookup.** Use the iPad-mediated lookup from the release finding to fetch the detail from the owning box when that box is reachable on the LAN.
- **Test.** Add this case to the offline test matrix beside the release cases.
- [high] R1 ("facts are never rejected") treats a fact that came from an authenticated box as a true fact. Ingest has only four outcomes (applied, duplicate, flagged, rejected) and no quarantine. Wallet credit entries are "inserted unconditionally". The hash chain and `box_seq` detect edits to history, not freshly fabricated events. — WHY: A rooted box can sync events such as `wallet_entry: cash top-up 50,000` or refund-out cash movements. "Rooted" means a booth kiosk escape, an insider with the NVMe overnight, or a box stolen but not yet revoked. The cloud turns those into spendable balance and fiscal records. It attributes them to any staff jti the box has seen.

The proposal calls the jti on events "proof of session". The box stamps the jti itself, so it proves nothing about the iPad or the person.

Events from a revoked box dated after the cut-off would also enter the tax ledger as flagged but applied. — FIX: - **Add a fifth ingest state, `held`.** The event is stored durably, excluded from spendable projections (wallet_balance) and from fiscal exports, and cleared by a human in the exceptions console.
- **Hold rules kept as data.** Hold events from a revoked kid or box. Hold wallet credit not backed by a tender in the same sale event. Hold credit above a threshold. Hold large cash paid-outs from `offline_pin` or `clock_untrusted` sessions.
- **Tie cash top-ups to cash-session variance.** That way fabricated cash shows up at close.
- **Optional non-repudiation.** Bind the shift token to a non-extractable WebCrypto key on the iPad, through a `cnf` claim, and sign commands. This also removes the token's value to someone sniffing the park Wi-Fi.
- [high] Ingest applies events synchronously and acknowledges each item. It should store first and apply later. The proposal applies each aggregate event in one Postgres transaction and returns applied, flagged or rejected to the box. Malformed items go to a dead letter. Nothing covers events that depend on a failed event, a mismatch between box-agent and cloud schema versions, or what an acknowledgement actually promises. — WHY: Boxes will sit offline and then upload events written by an older agent version to a newer cloud.

One poison event either wedges that box's outbox or is dead-lettered while its successors fail. Examples are a foreign-key miss after a member merge, an upcast bug, or a deploy that lands mid-drain. The second case silently breaks R1. It is the same failure the proposal attributes to the Sprint 1 idempotency plugin (the IN_FLIGHT wedge), one layer up.

A day's backlog from three boxes will hit a 1 CPU / 2 GB Render Postgres with one modest pool, shared with the HR, analytics and messaging modules. — FIX: - **Acknowledgement means stored.** The cloud has durably stored the raw signed event in an append-only `core.sync_inbox` holding the raw bytes, box_id, box_seq, schema_version, signature and received_at. Nothing more is promised.
- **Apply in a separate worker.** It runs per box in `box_seq` order. It uses upcasters for every event schema version ever shipped. It has retry and a parked state that alerts. A parked event pauses only that box's apply cursor and never the box's outbox.
- **Replayability.** Exceptions and projections can then be rebuilt from the inbox.
- **Backpressure.** Add a batch size cap and a drain rate limit, so a reconnect storm cannot starve the online booking and till traffic that shares the pool.
- [high] Three gaps sit in the 2C2P path.
- **Orphan-refund job.** The cloud job that "refunds any 2C2P intent that was paid but has no finalised tender" cannot tell an orphan from a sale the box finalised offline and has not yet synced.
- **Bank-slip confirmation.** The design lets staff resolve an unknown 2C2P attempt by "audited staff confirmation from the customer's bank slip".
- **Webhook.** Webhook authenticity and amount checks are not specified. — WHY: - **Auto-refund.** It will refund legitimate sales on exactly the days with a flaky link. Thai QR refunds through a PSP are often slow or manual, so a wrong refund is hard to undo. This is unverified for 2C2P THQR and should be checked.
- **Fake slips.** Fake transfer-slip screenshots are a well-known retail fraud in Thailand. Accepting a customer's phone screen as payment evidence turns that scam into product behaviour.
- **Forged webhook.** A forged or replayed webhook that marks a sale paid is free admission. — FIX: - **Refund job.**
  - It never refunds on its own.
  - It opens an exception only after the owning box has synced past the attempt, with an explicit `attempt.abandoned` or `attempt.expired` event, or after a long timeout with the box confirmed fully drained.
  - A human approves the refund.
- **Customer slips.**
  - Never accept a customer's slip as evidence.
  - The allowed resolutions are Payment Inquiry when the link returns, or a manager "carry to reconciliation" with the customer's details captured.
  - The customer pays another way now. A duplicate is refunded after inquiry proves it.
- **Webhook.**
  - Verify the JWS.
  - Match invoiceNo, amount and currency to the intent.
  - Confirm through a server-to-server Transaction Status call before marking paid.
  - Process idempotently on invoiceNo.
- [high] The signed wallet-grant mechanism has three holes.
- **Double count.** The offline limit is "cached balance plus imported signed grants minus local unsynced spends". A grant printed while online is already inside the cached balance, so it is added a second time.
- **No ceiling or sale link.** The grant has no amount ceiling and no link to a sale.
- **Unknown outcome online.** The online wallet authorisation ("cloud authorises synchronously under a row lock") has no handling for an unknown outcome. — WHY: - **Double count.** A balance-only cache (`wallet_balance` projection) cannot deduplicate a grant by `entry_id`. A parent's 500 THB top-up becomes 1,000 THB spendable at any box that goes offline later. The cap limits the loss, but it recurs on every outage.
- **Timeout.** If the box times out on an online authorise that the cloud actually committed, it falls back to an offline spend under a new id. The child's wallet is debited twice. That is a complaint from a parent at the counter, and no exception rule will surface it.
- **Stolen key.** A grant with no ceiling is unbounded money for a stolen counter key. — FIX: - **Make the wallet a tender adapter.** It lives inside the payment_attempt state machine with an `unknown` state like the others. The box mints the `entry_id` before the call and reuses the same id for the offline fallback. The cloud then deduplicates on it.
- **Cache entry ids.** For today's wallets the box cache holds the set of applied entry ids, or a per-wallet high-water mark, not only a balance. A grant is imported only if its `entry_id` is not already reflected.
- **Bound the grant.** Its body includes sale_id and receipt number and is subject to a configured maximum amount. Verifiers refuse grants above it offline.
- [high] The wallet ledger has no fund-source dimension, and the release-time money rules conflict.
- **Two kinds of credit.**
  - The prototype grants promotional credit from ticket rules: `creditRule` basis `full_price` gives F&B credit equal to the ticket price (C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/oto-platform/apps/pos/src/lib/sale.ts lines 146-157).
  - It treats purchased prepaid credit as `stored_value`, which is "NOT taxed at load; tax is realised on spend" (sale.ts lines 53-59).
  - The proposal's `wallet_entry` has a single `amount`.
- **Release-time rules.**
  - The proposal makes refund-to-cash `online_only`.
  - The prototype's release flow refunds unused prepaid value in cash at pickup (the `checkOut` prepaidReconciliation in mockApi.ts).
  - The proposal also plans to show overdrafts on the release screen "so staff can collect from the parent". — WHY: - **Accounting treatment.**
  - Purchased credit is a liability with VAT at spend.
  - Promotional credit is a discount.
  - Breakage at expiry (SCRUM-91) is revenue only for purchased credit.
  - Only purchased credit can ever be refunded or cashed out. Otherwise "buy a ticket, cash out the free credit" is a theft loop.
- **Reporting.** SCRUM-99 explicitly requires stored-value flow to be shown separately from promotions.
- **Migration.** Mapping the production dump into a single-bucket wallet makes the split unrecoverable.
- **Child release.** Tying debt collection to the moment a child is handed over invites staff to delay a release over money. Most offline overdrafts are caused by OTO's own double-spend window, not by the parent. — FIX: - **Add `fund_source` to entries.** The values are purchased, ticket_credit or promo, staff_benefit and prepaid_item.
  - Set a deterministic draw order.
  - Each spend entry records the amount drawn from each bucket, so that the F&B tax invoice and VAT are computed correctly.
- **Accountant questions.** Put the VAT treatment of bundled ticket credit and of breakage on the accountant's list now, before the schema freeze and the dump mapping.
- **Offline refund at release.**
  - Allow a refund of purchased prepaid on that check-in up to a cap, because the owning box knows what was paid.
  - Otherwise print a signed refund-due slip.
- **Overdrafts.**
  - Never show an overdraft before the release is committed.
  - Auto write off overdrafts under a threshold.
- [high] The sale state machine has two holes.
- **Tendering is not durable.** The proposal does not say that the frozen sale (its lines and totals) is persisted at `tendering`. Only the payment attempt is fsynced, and ledger rows are written at `finalised`.
- **No exit with a captured tender.** "A sale cannot be abandoned while it holds captured tenders. They must be voided first" has no exit when a void is impossible. — WHY: - **Power cut.** The power-cut case the proposal uses as its motivation ends with an approved card charge attached to a sale whose contents exist only in an iPad's memory. iOS Safari may already have discarded that memory.
- **Split tender.** Per the brief, GHL cannot void Thai QR, card voids end at settlement, and wallet voids end at 23:00. Take a split tender where the first tender is captured, the second is declined, and the customer leaves. The station is then either wedged or staff falsify a cash tender to close the sale. Those are the two outcomes a money-path design must prevent. — FIX: - **Persist at tendering.** Write the full frozen sale snapshot to `ledger.db` in the same fsynced transaction that creates the first payment_attempt. Boot recovery then shows staff the sale, not only the attempt.
- **Add a terminal state, `cancelled_with_captured_tender`.**
  - It issues no receipt or tax-invoice number.
  - It emits a `refund_due` exception and a refund document for the captured amount.
  - It records the customer's contact details.
  - It unblocks the station.
- **Crash tests.** Include "crash between capture and the second tender" and "void unavailable" in the crash-point property tests.
- [medium] Several staff-token details do not fit the Sprint 1 code.
1. **Deleted sessions.** `jti=session.id`, but sessions are hard-deleted on sign-out and on password reset, and they cascade from account (C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/oto-platform/apps/api/src/services/auth.ts lines 197-210; packages/db/src/schema/tenancy.ts line 173). The ingest check "the jti was minted for that box" will therefore fail for any event synced after the staff member has signed out.
2. **Stale role tables.** The token carries role-assignment ids that are evaluated against a box-side copy of the role tables, and that copy can be stale or missing.
3. **Lock state.** The lock and unlock are described as PIN-checked on the box, but the token lives in iPad JavaScript (the box is a different origin from the cookie). A locked iPad's token still works for anyone on the park Wi-Fi unless the lock state is held on the box. — WHY: - Item 1 would flag or mis-handle a large share of normal events, because staff sign out at the end of a shift and boxes sync later.
- Item 2 creates "token valid but permissions unknown" states during an outage.
- Item 3 makes the 2-minute lock cosmetic against the realistic threat, a colleague or a visitor on the Wi-Fi. — FIX: - **Issued-token table.** Add `core.station_token` with jti, account_id, box_id, iat, exp, revoked_at and revoke_reason. It is never deleted and is decoupled from `session`.
- **Self-contained token.** Embed the effective permission set for that branch in the shift token at mint time. Size does not matter here, since the token travels over HTTPS and not in a QR. Drop the role-table replica from the boxes. Keep only what offline-PIN sign-in needs.
- **Box-side session.** At station attach the box exchanges the shift token for its own httpOnly, box-origin session cookie. It keeps locked and unlocked as server-side state and rejects commands while locked. The raw shift token is not kept in localStorage.
- [high] The 6-digit PIN is both the unlock typed every 2 minutes at a public counter and the manager override credential, with a "manager PIN co-signs" rule for refunds, voids, paid-outs and cash-outs. The Sprint 1 role-assignment hole makes the manager role forgeable. — WHY: A PIN typed dozens of times an hour on an iPad, in front of a queue and colleagues, will be seen by others. A manager PIN typed on a staff member's iPad, in front of that staff member, is the usual route to refund-to-cash and void-after-cash fraud.

The proposal treats a stolen box as the PIN threat, by offline cracking. The likely threat is an insider who never touches the Pi.

Separately, any holder of `admin:role:assign` can grant any role at any scope to any account, including platform-wide. That is at C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/oto-platform/apps/api/src/routes/accounts.ts lines 158-169. Permission checks evaluated on the box inherit the hole. — FIX: - **Separate the credentials.** The staff unlock PIN is low value. Manager approval is something else: a signed approval QR generated on the manager's own phone in the suite app, scanned by the counter scanner.
  - It is Ed25519 over `{action, sale_id, amount, nonce, exp}`.
  - The manager's public key is in the keyset.
  - It works offline.
  - It is consistent with the proposal's R2 (verifiers hold no secrets), since no secret sits on the box.
- **Minimum if that is not built.** A distinct manager PIN that is never the unlock PIN, a lockout after N failures, and a daily per-manager approvals report sent to the owner.
- **Dependency.** Fix the accounts.ts escalation before any offline permission work. Constrain grantable roles and scopes to the assigner's own coverage, and check the target account's operator.
- [medium] Deliberate-offline and insider abuse are not modelled. Every loss bound assumes an honest outage: the wallet cap, double redemption, and revocation exposure equal to the outage length. The design adds no operational controls for reprints, no-sale drawer opens, voids after a cash tender, or manual discounts. — WHY: The router has dual-SIM failover, so real outages should be rare. That makes "offline" a state staff can create by pulling one patch cable. It unlocks the weaker rules: double voucher redemption, wallet overdraft, a fired colleague's token, and no cloud claim.

A reprint that keeps the same `band_id` gives staff a free second band for a friend.

Ethernet printers can be driven by any box, so any station can fire any cash drawer. — FIX: - **Correlate offline flags.** The cloud compares each offline-flagged event with whether sibling boxes and the gate at the same branch were online at that `occurred_at`. "Box offline while the branch was online" becomes its own high-priority exception type.
- **Report offline minutes.** Show them per box and per staff member.
- **Control the risky actions.** Reprint, no-sale, void after cash and manual discount become permissioned, reason-coded and counted actions, with a per-staff daily report.
- **Drawer kick.** Restrict it to the station that owns the printer.
- [medium] The band QR density risk is rated "low" and deferred to stabilisation, yet it decides the token envelope, and the fallback reintroduces shared secrets.

The arithmetic checks out. About 94 bytes gives 141 base45 characters plus the 5-character prefix, 146 in all. The QR alphanumeric capacity at version 6-M is 154. At 3 dots per module the code is about 18.4 mm wide including the quiet zone. — WHY: - **Hard to scan.** Child bands are scanned at F&B with a phone camera (SCRUM-95), not only by the fixed DS22 scanner. They sit on a small child's wrist, where an 18 mm code spans roughly 50 degrees of arc at a radius of about 2 cm, and are printed on direct-thermal band stock at 0.375 mm per module. That is a hard scan condition.
- **The fallback defeats the key design.** If the code fails, the fallback of a truncated per-station HMAC for bands puts a verifier-can-forge secret back on every park box for the most common instrument. `packages/tokens` would then need two verification models.
- **Wrong time to find out.** Finding this out during stabilisation, after Sprint 2 has built everything on the envelope, is the expensive time. — FIX: - **Run a one-day print-and-scan spike now.**
  - Use any 203 dpi thermal printer and the real band stock from the park.
  - Compare version 6-M at 3 dots per module with version 3 at 4 dots.
  - Test on an adult's wrist and a small child's wrist, with the DS22 and with two phone models under the park's lighting.
- **Decide the envelope from the result.**
- **If the asymmetric code fails,** use a branch-scoped, daily-derived HMAC key, `HKDF(master, branch, date)`.
  - Distribute it only to that branch's park boxes, N days ahead.
  - Booth boxes never receive it.
  - A stolen park box can then forge only that branch's day bands for N days or fewer.
  - Wallet grants and pickup slips stay Ed25519 either way.
- [medium] The second-medium mirror journal is under-specified.
- **Unsigned entries.** "Batches are signed with the box-auth key" happens at sync time. Unsynced events in the USB/SD journal are therefore unsigned when a spare box imports them.
- **Plaintext data.** The journal holds money facts and child-release PII in plaintext on removable media at a mall counter. — WHY: - **Injection path.** The import path would be an unauthenticated way into the fiscal ledger and the wallet projection. Anyone can edit the stick before import, and the dead box is not there to contradict them.
- **PDPA.** A lost stick is a PDPA incident involving children's data.
- **Performance.** Cheap flash with an fsync on every sale adds latency in the hundreds of milliseconds and wears out quickly. A failed or removed stick must not stop sales. — FIX: - **Sign each event as it is committed.** Sign each event, or a running chain head, with the box key, so the journal can be verified on its own against the cloud's copy of that box's public key.
- **The spare is a courier only.** It uploads the dead box's events under their original box_id and box_seq, and the cloud verifies them.
- **Encrypt the journal payload.** Use a cloud-held public key (a sealed box), so that only the cloud can read it.
- **Asynchronous writes.** Journal writes have a bounded lag and an alert. They are never in the sale's critical path. A missing journal degrades to a warning in the heartbeat.
- [medium] Two tax-engine problems.
- **Golden tests cannot pass as described.** The prototype emits unrounded floats:
  - `base * (discount.value / 100)` in C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/oto-platform/apps/pos/src/lib/sale.ts line 109;
  - the inclusive VAT back-calculation `taxableAmount - taxableAmount / (1 + pct)` in C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/oto-platform/apps/pos/src/lib/tax.ts line 118;
  - the proportional discount apportionment at tax.ts lines 107-109;
  - `roundTHB` is used only for display.
- **Two catalog sources.** The iPad loads its catalog from the cloud (`loadCatalogFromApi` in apps/pos/src/auth/OperatorContext.tsx lines 118 and 164). The authoritative box uses its own cached copy. — WHY: - **Tests.** A satang engine cannot reproduce 33.333... exactly. The tests will either be loosened until they mean nothing or will quietly freeze whatever rounding the port happens to use.
- **VAT rounding.** Rounding VAT per category makes the category lines disagree with 7/107 of the invoice total by a satang. An auditor can see that on a tax invoice.
- **Catalog skew.** With two catalog sources, the `expectedTotal` 409 will fire in the field on every price change or stale iPad, in the middle of a queue. — FIX: - **Rounding policy first.** Get the written rounding policy from the accountant before porting:
  - half-up to the satang;
  - VAT computed per rate at invoice level, then allocated to lines by largest remainder, so that lines always sum to the header;
  - discount apportionment by largest remainder;
  - an explicit cash-rounding adjustment line for cash tenders only.
- **Golden tests.** They assert the new policy on the prototype's fixtures and list the documented deltas.
- **One catalog at the counter.**
  - At a counter the iPad takes its catalog and quotes from its box, a single source.
  - Quotes carry `catalog_version`.
  - On a mismatch the box returns the authoritative re-quote for the UI to display, not a bare 409.
- [medium] The booth voucher policy has a logic gap, and the box-key containment depends on kiosk hardening the design does not mention.
- **Policy gap.** High-value prizes are `online_only` at redemption. A voucher issued by a booth that was offline is unknown to the cloud, so an online claim cannot validate it.
- **Input port.** The booth's input device is a USB HID keyboard port in an unattended mall corridor. — WHY: - **Redemption.** A legitimately won prize fails at the counter, or staff learn to override and the control is dead.
- **Kiosk escape.** A keyboard plugged into the button's port is the standard kiosk escape. If the agent and Chromium share a user, the voucher-signing key is one shell away.
- **Booth staff.** They can also generate prizes at will. The signature proves which booth issued the voucher, not that a fair spin took place. — FIX: - **Issue high-value prizes online only.** The wheel can land on such a prize only when the booth is online, and the cloud records the spin before the voucher prints. Offline, the wheel's prize table drops to `offline_ok` classes.
- **Cloud-side checks.** Set caps per prize class, per booth and per day. Add a drift alert comparing the configured probabilities with the observed distribution for each staff id.
- **Harden the box image.**
  - The agent runs as its own system user, with the key file mode 0600.
  - Chromium runs as an unprivileged kiosk user.
  - VT switching and devtools are disabled.
  - `usbguard` allowlists only the button's VID/PID.
- [medium] Offline refunds have no way to verify the original sale when it was made at another box. The token envelope defines band, booking, voucher, wallet_grant and pickup_slip, but no receipt type. The proposal allows refunds below a limit while offline with a manager PIN. — WHY: - **Refund fraud.** Refund fraud with copied, reprinted or fabricated receipts is the most common till fraud. Offline, a box that has never seen the sale can either refuse, which is a customer-service failure, or refund blind.
- **Related gap.** The registry omits three more instrument types: the cloud-issued promo voucher (SCRUM-92), the staff benefit code (SCRUM-101) and the staff voucher (SCRUM-176). The backlog notes that the three voucher concepts should become one. — FIX: - **Add a `receipt` token type**, signed by the issuing box and printed as the receipt QR. Its body is sale_id, receipt number, total, tender summary and business date.
  - Any box can then verify an original offline.
  - It records the refund against that sale_id in its local redemption log.
  - Cross-box double refunds surface through the same redemption-conflict query.
- **Register the missing types.** Add `promo_voucher` and `staff_benefit` as cloud-signed types, each with a declared offline policy. The scanning service (SCRUM-46) then has a single verification path.
- [medium] Two problems with the immutable ledger.
- **Erasure.** Append-only ledgers and hash-chained events conflict with PDPA erasure and correction.
- **Trigger enforcement.** Triggers alone do not enforce append-only under a single database role. Release evidence (collector name, phone, relationship), child ids on wallet entries, and the staff identity sit inside rows that "block UPDATE and DELETE" and inside hashed box events. — WHY: - **Children's data.** The brief flags Thai PDPA more than once, and this system holds children's data. An erasure or correction request against an immutable, hash-chained row leaves only bad choices: break the chain, or refuse the request.
- **Table owner.** The API runs on one connection pool with one role (brief section 9). If that role owns the tables, it can disable its own triggers. The suite's other modules will share the role after the merge. — FIX: - **Keep PII out of immutable rows and hashed payloads.** Ledger events carry ids. Names and phone numbers live in separate, erasable records. Ad-hoc collector details go into an erasable side table keyed by release_id. The event stores a salted hash of them.
- **Enforce append-only by privilege first.**
  - Migrations run as the owner role.
  - The application role gets INSERT and SELECT only on ledger tables, with UPDATE and DELETE revoked.
  - Triggers are defence in depth.
  - A CI check covers both.
- **Give each merged suite module its own database role and schema grants.**
- [medium] The benefit of making PAX/Digio QR primary is overstated, and it overrides a Decided item in the brief. The brief provisions one PAX per branch ("One card station and one QR station per branch"). Every other counter, F&B, the kiosk and the booking site still use 2C2P. — WHY: - **Work not saved.** The claims "removes one reconciliation source" and "no switch-over race" hold for exactly one station per branch.
  - The 2C2P broker, webhook, orphan handling and second settlement feed still have to be built and run.
  - The PAX path adds a third QR surface: the terminal's own `A3` screen plus the `A18` payload on the display.
- **Unverified.** That `A18` is available on these TIDs is an assumption.
- **Commercial.** The fee comparison between SCB's EDC QR rate and 2C2P is a commercial decision the owner has already made once (section 7.2 Decided, section 13). — FIX: - **Keep it as routing configuration.** Station config maps each payment method to an ordered list of adapters, and the brief's default order stays (2C2P, then PAX fallback).
- **Ask the owner for a per-station flip.** Present it as an option with the fee and availability facts attached, not as an architecture change.
- **Build the pending-QR resolution once.** Build one attempt state machine that both adapters plug into, so the order is a one-line config change after Digio confirms A18 and SCB confirms fees.
- [medium] When a pickup person is disabled during an outage, the proposal treats the residual risk as something to "state to the client". It adds no out-of-band control. — WHY: This is the custody-dispute case. The cloud knows at that moment that the branch's boxes are offline, because no heartbeat has arrived. It also knows that the change has not reached the floor. Doing nothing with that knowledge is a choice.

The person making the change, a parent through staff or a manager, will reasonably assume it took effect. — FIX: - **Trigger.** A pickup person is disabled or removed, or a child safety note is edited, while any counter box of that branch has not acknowledged the new list version.
- **Tell the editor.** Show a blocking notice: "Counter boxes at <branch> are OFFLINE - this change has NOT reached reception. Call the branch now."
- **Alert the manager.** Send the duty manager an SMS or LINE alert through the existing adapter (C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/oto-platform/apps/api/src/services/sms.ts).
- **Track it.** Open a tracked exception that closes only when every counter box has acknowledged that list version.
- **Release screen.** Show the list version and the time of the last acknowledgement on the release screen, as G3 already intends.
- [medium] The design has no cut line between go-live blockers and hardening. The proposal adds a large set of mechanisms inside a Sprint 2 that the brief defines as "all remaining software" in one run:
- a key registry and rotation protocol, and a token envelope;
- a hash-chained ledger and a USB mirror;
- clock witnesses;
- an exceptions console;
- four terminal adapters, a 2C2P broker and settlement reconciliation;
- signed grants and slips;
- a crash-point property harness. — WHY: When everything is a requirement, schedule pressure decides what gets cut. The exceptions console and the crash tests are usually first to go. Without those two, accept-and-flag is unsafe.

The owner has also just added a suite merge, a launcher, central module-aware permissions and a production-dump migration to the same programme. — FIX: Publish three tiers and agree them with the owner.

| Tier | When | Contents |
|---|---|---|
| A | Blocks go-live | Write-ahead attempts and boot recovery. The durable tendering snapshot. Receipt series and register. Store-then-apply ingest with `held`. Box enrolment and the root-signed keyset. Release flow with its evidence and test matrix. The allergy flag. The exceptions console. UPS and RTC battery. |
| B | Before the second branch or the booths | Wallet grants. The booth voucher policy. Settlement import. Manager approval QR. |
| C | Hardening | The hash chain. The mirror journal. Automated key rotation. DPoP-style command signing. LUKS or TPM. |

Tier C items get documented interim procedures: a printed Z-report, manual key roll and cabinet locks.

## Got right
- **Signing keys.** Replacing the brief's shared HMAC with asymmetric issuer keys limited by token type is the right call. Only the cloud signs bookings, and the 2C2P merchant secret and webhook never sit on a Pi. A stolen booth box must not be able to mint bands or bookings. The QR size arithmetic for the band (146 characters against the 154-character capacity of version 6-M) is correct.
- **Payment attempts.** The write-ahead payment attempt is sound. The attempt is fsynced before any bytes reach the terminal, every retry gets a new terminal reference, and boot recovery forces resolution of `sent_to_terminal`. The motivating case is a terminal on battery and 4G approving a charge while a Pi with no UPS is dead. That is the real field failure.
- **Terminal adapters.** `ManualEntry` as a fourth first-class adapter on the same state machine matches SCRUM-54 and the open LinkPOS enablement. `reversalOptions()` as a data-driven capability matrix is sound. A manager 'carry to reconciliation' escape means a broken terminal cannot wedge a queue.
- **Receipt numbering.** The number is allocated inside the finalising SQLite transaction, never at draft. A series segment is assigned by the cloud each time a station is bound to a box, which fixes the real spare-box collision with a dead box's unsynced tail. A series register serves as the audit artefact. Voids and refunds are new documents, there is a cloud-owned WEB series, and the format is built as configuration pending the accountant.
- **Wallet and redemption model.** Wallet entries are the truth and the balance is a projection. There is no unique constraint on the instrument for redemptions, because a unique index would silently drop the second offline redemption, which is the one that needs investigating. `/oto-platform/packages/db/src/schema/future.ts` should be rewritten, not extended. I verified it is an unused placeholder with a mutable `wallet.balance_satang` keyed to the member, a cascade delete on wallet_entry, and no station or box columns.
- **Sync events.** One aggregate event per business fact, with a permanent event_id and per-box box_seq gap detection, is sound. So is not extending the Sprint 1 Idempotency-Key plugin to the box path. I verified its defects in `/oto-platform/apps/api/src/plugins/idempotency.ts`. It stores any status including 5xx (lines 81-84). It claims the key with a non-atomic select followed by an upsert (lines 33-65). It wedges on IN_FLIGHT if the process dies before onSend. It is keyed to the account, with a 24-hour TTL.
- **Accept-and-flag.** This is the right principle for authentic facts, and the proposal is right that an exceptions console with owners and ageing must ship in the same increment as ingest. Keep both, and add the `held` state from the findings.
- **Clocks.** The design uses a persisted `last_good_time` floor. Cloud-signed `iat` values prove a lower bound on real time. Ordering within a box uses `box_seq` and never timestamps. Every event carries `clock_trust`, and a sale is never blocked because of the clock. The floor also limits iPad-clock manipulation to forward-only movement. The RTC battery (ML-2020 with trickle charging enabled) and the UPS are rightly go-live requirements.
- **Staff credentials.**
- The suite-wide password hash never leaves Postgres, and the PIN is a separate credential.
- The shift token is bound to the box through `aud=box_id`.
- Offline sign-in is limited by sync freshness as well as the 30-day rule, with a restricted permission overlay.
- The inactivity lock must stop deleting the server session. I verified that `logout()` calls `authApi.signOut()` at `/oto-platform/apps/pos/src/auth/OperatorContext.tsx` lines 82-89.
- **Sprint 1 facts the proposal relies on.** All were checked and are accurate:
- no `.transaction(` call exists anywhere in `apps/api/src`, although the comment in audit.ts claims one;
- `GET /members/:id` has no operator filter (members.ts lines 167-176);
- `GET /public/member-tier` has no operator or branch filter (public.ts lines 106-110);
- the role-assignment escalation exists (accounts.ts lines 158-169);
- no `trustProxy` is set, and `COOKIE_SECURE` defaults to false;
- `idemKey()` is minted inside each API wrapper (`apps/pos/src/api/platform.ts`);
- ids come from `Math.random` in `apps/pos/src/lib/sale.ts` (lines 221, 242, 297);
- `newId()` is already UUIDv7, so client-minted ids are feasible;
- the child foreign key uses cascade delete (members.ts schema).
- **Domain engine.** A shared pure `packages/domain` engine runs on the iPad for preview, on the box as the authority, and in the cloud for checks. The engine version and line snapshots are stored on each sale, so history is never recomputed. The box treats the iPad's arithmetic as non-authoritative.
- **No-peer rule.** The design keeps the brief's no-peer rule and says plainly what it cannot guarantee: band voids offline, copied bearer codes, and a pickup person disabled during an outage. It does not overclaim. Hosting the spend stations on one box is a no-protocol way to remove wallet double-spend.
- **Test strategy.** A cloud-plus-box convergence harness runs in one process with a link that can be cut. A simulator terminal supports scripted faults. Crash-point property tests assert that no sale is lost, no receipt number is duplicated or skipped, and open attempts block the station. Child release gets its own test matrix.
- **Sequencing.**
- Send the long-lead external questions now: the accountant's numbering scheme and cash-register approval, SCB's LinkPOS, refund and settlement format, and the Digio reference scope.
- Fix the Sprint 1 defects and extract transactional services before feature work.
- Decide the wallet owner before mapping the production dump.
- Build the ledger and ingest before any money feature.
- **PDPA caches.** Cache placement by box role is the right direction for a system holding children's data on Pis in a mall. No pickup lists or allergy data sit on gate or booth boxes, and members are cached by recent branch activity and not for the whole operator.