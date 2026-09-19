# DESIGN box-agent-sync

## Summary
This is a read-only design. Nothing was run. Member-base size and event volumes are estimates until the production dump arrives.

**What the box is.** The box is a full system of action. It must price, tax, number receipts, sign bands, authorise staff, decide gate access and cap wallet spend while offline, so it runs shared pure TypeScript domain code over a local SQLite cache.

**What the cloud does.** The cloud records what boxes report as immutable, box-signed facts. It stores each fact once, projects it into tables and raises an anomaly for anything odd. It never re-decides something that already happened at a counter.

**The design turns on three rules:**
- **Local-first always.** Every station action is written to the box journal first and forwarded afterwards, online or not. Offline is therefore the everyday code path and cannot rot.
- **Facts go up, state comes down.**
  - Up-sync is a per-box, gapless, hash-chained, signed event log. It is deduplicated permanently by event ID and never blocked by one bad item.
  - Down-sync is a snapshot plus a change feed, with one cursor per scope. The feed is written by database triggers and guarded against the commit-order race. Only the scopes and fields a box's role needs are sent.
- **One cloud write path.** HTTP routes and the box ingest call the same transactional services.

**Sprint 1 gaps.** Sprint 1 has almost none of this, and the gaps are foundational, not additive:
- no services or transactions;
- no client-supplied IDs;
- no box principal;
- no change sequence or tombstones;
- no signed staff token;
- the money engine exists only in the browser, in float baht.

**Disagreements with the brief.** I disagree with five decided items on safety grounds, and with four more on simplicity and scope:
- One symmetric signing key held by every box, also used for booking QRs.
- DNS-provider credentials stored on every box.
- A full member cache on every box, including the gate and the mall booth.
- An uninterruptible power supply (UPS) and real-time-clock (RTC) battery treated as optional.
- A cold spare, combined with box addresses fixed by MAC-based DHCP reservation.

**Scope.** The sync engine should be a core platform service. Modules declare their box scopes and event types through the module registry, so the staff timekeeping kiosk reuses it later.

## Key decisions
- **The box runs the full domain logic from shared pure TypeScript packages. The cloud records station activity as facts and projects them. Neither side duplicates the other's rules.** — Offline selling, tax, receipt numbering, band signing, gate decisions and the wallet cap are all domain logic that must run with no cloud. Today the full engine lives only in `apps/pos/src/lib` in float baht. `packages/shared/src/pricing.ts` covers only ticket lines. One pure satang `packages/domain` gives the iPad preview, the box and the cloud's verification the same results. (rejected: Thin box that forwards commands to the cloud: breaks the brief's offline rule. Ports-and-adapters station core running on both Postgres and SQLite: the Drizzle dialects differ and the cost is high. The only dual-homed writes (member, child, tier, pickup) are simple enough to share by event type.)
- **Local-first always. Every station action commits to the box journal and is forwarded afterwards, even when online. Only five operations call the cloud synchronously, each with an offline fallback.** — A separate online path means offline code is rarely exercised and fails when finally needed. With one path, every sale tests the offline route. Latency at the counter becomes LAN-only and independent of Render's 1 CPU tier. (rejected: Online write-through to the cloud with the queue only on failure: two code paths, mode-switching bugs in the middle of a sale, and cellular latency on every checkout.)
- **Up-sync carries immutable, box-signed fact events in a per-box gapless hash-chained sequence. They are deduplicated permanently on event ID in a `sync.event` ledger. The cloud never rejects an authentic event for business reasons.** — A sale with a printed receipt and a captured card payment has happened. Rejecting it loses money-path and child-safety records. Signing makes events courier-independent, so a replacement box, a recovered disk or an iPad copy can deliver them. The gapless sequence detects loss. The existing header idempotency cannot serve this: it requires an account, has a 24-hour TTL, caches 5xx responses and wedges on an in-flight crash. (rejected: Replaying HTTP requests with Idempotency-Key through the Sprint 1 plugin. CRDT or row-level replication: far too much machinery for mostly append-only facts.)
- **Poison events are quarantined and acknowledged so the queue keeps moving. Business problems become anomaly records in an admin exceptions queue.** — Head-of-line blocking after an outage would hold child-release and payment records behind one bad item. Projectors tolerate missing parents through soft references, so skipping one event does not cascade. (rejected: Strict stop-on-error: simple, but operationally dangerous. Silent drop: unacceptable for money and safety data.)
- **Down-sync is a trigger-written change feed with an xid8 visibility guard. Feed rows hold keys only. Payloads are read through per-entity serializers. There is one cursor per scope, plus nightly prebuilt snapshots in object storage.** — `updated_at` is set only by Drizzle `$onUpdate`. It will be bypassed by the migration importer and by every imported module writing to the central database. Sequence values are assigned before commit, so a naive cursor silently skips late-committing rows. Serializers are the single place where PII minimisation is enforced. (rejected: Pulling rows where `updated_at` is newer than the cursor: misses deletes, out-of-order commits and raw SQL writes. Postgres logical replication to boxes: inbound-style coupling, no field filtering and no SQLite target.)
- **Two SQLite files. `cache.db` is a disposable document store with generated index columns and `synchronous=NORMAL`. `journal.db` is a small, stable, expand-only schema with `synchronous=FULL`.** — It separates rebuildable from irreplaceable data. Schema skew in cached data is solved by ignoring unknown fields, or by dropping and re-snapshotting. Only the journal needs careful migrations. Wiping the cache becomes a safe support action. (rejected: One database mirroring Postgres tables through a second Drizzle sqlite schema: every cloud column change becomes a box migration and a version-skew hazard.)
- **Three systemd services from one bundle: `oto-station`, `oto-link` and `oto-updater`. They share only SQLite in WAL mode plus a Unix-socket poke, and compose in-process for tests.** — A sync bug, memory leak or restart must never interrupt a sale or an EDC transaction. The outbox table is the natural interface between the two processes. Snapshot applies cannot block the device I/O event loop. (rejected: Single process: simplest, but better-sqlite3 is synchronous and a large apply stalls serial I/O. Containers or microservices per device: needless on a 4 GB Pi.)
- **One active till per station is a box-local lease kept alive by the station WebSocket. It has a 30-second grace and a permissioned, audited takeover.** — A station belongs to exactly one box, so no distributed lock or cloud involvement is needed, and the lease works offline. The grace period absorbs Wi-Fi blips and Safari backgrounding. The draft sale lives on the box, so nothing is lost on reconnect. (rejected: A cloud-side lock on `session.station_id`: fails offline. iPad-side enforcement: not enforceable.)
- **The live sale is a box-owned `StationSession` document. It is reduced by a pure shared reducer from till and display intents and broadcast as full state. The display gets a redacted view. Displays are paired with a 6-digit code that yields a revocable device token.** — It replaces the props-and-callbacks harness in `Till.tsx` and its five copies with one mechanism. It stops the display computing totals locally. It gives the kiosk and the booth the same device-session mechanism, which is the 'one mechanism, not two' note on SCRUM-116. Full-state broadcast avoids patch-ordering bugs at negligible cost. (rejected: Extending the `pending_lookup_phone` channel on the staff session (decision D8): a separate display has no staff session. Peer-to-peer between iPads: the brief forbids tying devices to iPads.)
- **Cloud-minted credentials are asymmetric. Box-minted codes use a per-branch HMAC key with a key ID and day-derived subkeys held 30 days ahead. Box identity is an on-device Ed25519 keypair claimed by a label code. TLS certificates are issued through a cloud-brokered CSR.** — It limits the blast radius of a stolen box to one branch and a bounded period. No credential on a box can forge bookings or edit DNS. A database leak exposes no device secrets, because the cloud stores public keys only. (rejected: One global HMAC key on every box, also used for booking QRs. A DNS-provider API token on every box for Caddy DNS-01. A shared wildcard certificate.)
- **Application updates are signed tarballs with a symlink swap when idle, a health check and automatic rollback. OS updates are done by rotating the warm standby, with A/B partitions laid out now for later.** — There are about 10 boxes and one small team. Application fixes must ship remotely and safely. OS changes are rare, and a bench re-image plus swap carries no risk of bricking a counter remotely. Laying out partitions later in the field is painful, so do it in the first image. (rejected: Docker: adds a daemon, large images over capped SIMs and serial passthrough friction. Full Mender or RAUC fleet management in Sprint 2: disproportionate at this scale. Manual SSH updates: neither auditable nor safe.)
- **Member cache is role-scoped and limited to an active set with minimal fields. Gate and booth boxes hold no member PII. Cache misses fall through to the cloud when online, or to create-then-merge when offline.** — The merge rule already makes a miss harmless, so the cache is an optimisation. Minimising it is the only real defence for PII on an unattended Pi in a mall. It also cuts snapshot size on cellular. (rejected: The whole member base on every box, as the brief's cache list implies.)
- **The sync engine is a core platform service. Modules declare their box scopes and event types in the module manifest.** — The addendum folds HR and timekeeping into one system. The staff reception kiosk (SCRUM-116/117) needs offline clock-ins through the same box, the same event log and the same device sessions. Building the engine inside the POS would force a second mechanism later. (rejected: A POS-private sync implementation.)

## Risks
- [critical] Power loss with no UPS. The box is the only holder of unsynced money and child-release facts. Consumer NVMe drives without power-loss protection can lose or corrupt recent writes, and the clock is wrong after an offline power cut if there is no RTC battery. — MITIGATION: Make a small UPS (or a per-box UPS HAT) and the Pi 5 RTC battery go-live prerequisites. Use `journal.db` with WAL and `synchronous=FULL`, run an integrity check at boot, and up-sync within a second when online. Every event carries clock quality (`ntpSynced`, `bootId`, monotonic counter). The till flags a box-versus-iPad clock difference above 5 minutes. During stabilisation, run a pull-the-plug test of 200 cycles.
- [critical] Child release across boxes during an internet outage. A check-in or pickup-list change made at counter 1 is invisible to counter 2, because boxes do not talk to each other. — MITIGATION: Pin all supervision stations of a branch to one box. Release is never blocked: if the record is missing, staff follow a defined manual-evidence procedure and the box records an 'unverified release' event, which raises a critical anomaly. Pickup persons are an add-wins set. Keep events signed and courier-independent so a LAN relay can be added later without changing the model.
- [high] The domain port from float-baht browser code to pure satang is the critical path. It covers about 900 lines of pricing, tax and sale logic plus F&B, drop-off and supervision, and that code reads `catalogStore` globals. Any divergence produces wrong tax invoices. — MITIGATION: Start in week 1 as a parallel track. Build golden tests that feed identical fixtures through the prototype functions and the port. Define an explicit rounding policy for percentage discounts. The cloud re-runs `computeTotals` at ingest and raises anomalies on mismatch.
- [high] Change-feed correctness. Cursors can skip rows that commit out of order. Hard deletes and raw SQL or importer writes never reach boxes. A missed role revocation is a security defect. — MITIGATION: Use trigger-written feed rows with an xid8 snapshot-xmin guard. Add DELETE tombstone triggers. Convert `role_assignment` and `branch_holiday` to soft deletes. Send the revocation list in every heartbeat acknowledgement. Add a convergence test asserting a revoked grant disappears from a box. Run a weekly row-count and hash audit per scope.
- [high] Theft of a whole box: member PII, band keys, staff verifiers and the box signing key. The booth box sits elsewhere in the mall. — MITIGATION: Role-scoped minimal cache, with none for gate or booth. LUKS bound to the OTP key. Day-derived per-branch band keys. Asymmetric verification for everything cloud-minted. One-click remote key revocation. Locked enclosures. Secure boot as later hardening. State the residual risk to the owner for PDPA sign-off.
- [high] Event schema and version skew. A box may wake up with old queued events or old software. A cloud deploy may drop support too early. Expand-only journal migrations may be forgotten. — MITIGATION: Events are versioned per type, and upcasters are kept forever. Deploy the cloud first. The heartbeat reports versions, and the cloud advertises the minimum and maximum. CI checks that every historical fixture event still ingests. The updater preflight runs the journal migration on a copy. Boxes below the minimum still sell and push.
- [high] Wallet double-spend and cross-box single-use redemption while offline. This is financial liability data. — MITIGATION: Ledger-as-truth, with atomic cloud authorisation when online. Offline spend is limited to `min(cached balance − local pending, daily cap)`. Wallets count as online only when the branch has converged. Overdrafts are recorded, surfaced at the next scan and shown in the liability report. Exposure is bounded by the cap times the number of spending stations. The owner signs off the cap.
- [medium] Replacing a box: a gap in receipt numbers, loss of unacknowledged events, an IP tied to a MAC reservation, and certificate issuance delay or rate limits. — MITIGATION: Warm standby with synced scopes. The agent applies the static IP for the slot. Cloud-brokered CSR. A new receipt series per box incarnation, to be agreed with the accountant. An escrowed LUKS recovery key for disk recovery. Use the Let's Encrypt staging environment for development, and persist certificates in `/data`.
- [medium] iPad-to-box connectivity: cross-origin calls from a cloud-served PWA to private-IP HTTPS, Chrome's private-network preflight, iOS local-network permission, DNS rebinding filters on the router, iOS eviction of the service-worker cache, and WebSocket authentication without headers. — MITIGATION: CORS allow-list plus `Access-Control-Allow-Private-Network`. Single-use WebSocket tickets. Test on the real router early. Serve a version-pinned copy of the app shell from the box as a disaster fallback origin. Keep durable state on the box, not in IndexedDB. Self-host fonts.
- [medium] A bad OTA release disables counters, or an update fires in the middle of a sale or an EDC transaction. — MITIGATION: Signed releases, swap only when idle, a 03:00–06:00 window, a 120-second health check with automatic rollback, release channels with the standby as canary, never two counter boxes of a branch in one window, and auto-pause on any rollback.
- [medium] Member merge and alias rewriting touches every projector. It is also reused by the production-dump deduplication. Wrong merges attach children and allergy data to the wrong family. — MITIGATION: A single `resolveMemberId()` used by all projectors. Deterministic first-ingested-wins. Fill blanks only, never overwrite. Child dedup is strict: name plus date of birth; otherwise keep both and raise an anomaly. Merges can be reversed from the alias table. Property tests in the convergence harness.
- [medium] The Render 1 CPU API and its single pool now carry the WebSocket hub, ingest, the change feed, the snapshot builder and jobs beside the whole app suite. — MITIGATION: One batch in flight per box with `retryAfterMs`. Snapshots are built nightly to object storage and not served live. Telemetry and logs bypass Postgres. Set the pool maximum explicitly. pg-boss runs on the shared pool. A load test of four boxes draining a 3-day backlog.
- [medium] Local DNS depends on two boxes. If both are down, iPads lose all name resolution. Some routers or resolvers strip public answers that contain private addresses. — MITIGATION: Prefer static host entries on the park router if it supports them. Otherwise run dnsmasq on counter 1, the gate and the standby, and list the router as a further resolver. Verify with the actual router model, which is still an open item.
- [medium] Remote command channel abuse or late execution, such as a drawer pop or gate release hours after it was issued. — MITIGATION: A small allow-list with no gate, drawer or shell commands. Commands are cloud-signed, expire within 60 seconds, are deduplicated on command ID, run at most once, are gated by a permission and audited.
- [low] Raw EDC byte logs and shipped logs may contain card or personal data. Capped SIMs limit log and snapshot traffic. — MITIGATION: Confirm with GHL and Digio that card numbers are always masked. Pino redaction paths. Logs go to object storage under a daily byte budget. Raw EDC logs are kept locally on the encrypted partition for 90 days and uploaded on the low-priority lane.

## Changes to Sprint 1 foundations
- Extract the business logic from the route handlers (`apps/api/src/routes/members.ts`, `visits.ts`, `accounts.ts`, `catalog.ts`, `public.ts`) into transactional services with a `withTx` helper. The box ingest and the HTTP routes must share one write path, and audit rows must commit atomically, which `apps/api/src/services/audit.ts` claims but does not do.
- Accept client-supplied UUIDv7 IDs on every create route, with ON CONFLICT DO NOTHING semantics. Today `newId()` is called server-side at `members.ts:206/325/414`, `visits.ts:48` and `public.ts:221`.
- Replace `station.device_key_hash` with a `box` table holding `public_key`, slot, role, static IP, release channel and `last_status` jsonb. Add `station.box_id`, `device`, `station_device_assignment` with a payment-method routing map, and `box_command`. Change the `station_kind` enum to text plus CHECK, adding booth, F&B, kitchen and standby. Give `session.station_id` a foreign key, or drop it in favour of the box-local lease.
- Add a `sync` schema. `sync.change` is the trigger-written feed with an xid8 column. `sync.event` is the permanent monthly-partitioned ledger, unique on `event_id` and on `(box_id, box_seq)`. Also add `sync.box_cursor`, `sync.quarantine` and `sync.anomaly`. The triggers need hand-written SQL migrations, because Drizzle Kit does not manage triggers.
- Convert the hard deletes to soft deletes: `role_assignment` (`accounts.ts:199`) and `branch_holiday` (`catalog.ts:247`). Add timestamps to `role_permission`. Add DELETE tombstone triggers. Denormalise `operator_id` onto `station`, `branch_holiday`, `tax_override`, `branch_tax_config` and `stock_location`, so scope filters are uniform.
- Extend `audit_log` in `packages/db/src/schema/platform.ts` with `occurred_at`, `origin`, `station_id`, `box_id`, `actor_type`, `auth_method`, `session_jti` and a unique `source_event_id`. Make the primary key composite with `created_at` and partition by month now, while the table is empty.
- Rewrite `packages/db/src/schema/future.ts` as an append-only ledger built on a shared origin-columns helper in `helpers.ts`. The helper supplies a box-minted id, `station_id`, `box_id`, `occurred_at`, `received_at` and `source_event_id`. The ledger tables are: sale, sale_line, payment (with TID, approval code and provider references), band, wallet with lookup keys, wallet_entry, passage_event, booking_redemption, the supervision and release tables, cash_session, cash_movement, voucher and spin. Balances are projections. References across boxes are soft.
- Add `member_alias` and `member.merged_into_id`. Change `child.member_id` from ON DELETE CASCADE to RESTRICT. Keep `409 MEMBER_EXISTS` for online HTTP, and make the ingest projector merge.
- Add Ed25519 staff tokens minted from the cookie session, with a key table and rotation. Push the argon2 unlock verifier to the chosen box over the box channel. Move `grantCovers`, `hasPermission` and their types from `apps/api/src/services/permissions.ts` into a pure shared package the box can import.
- Change `apps/pos/src/auth/OperatorContext.tsx` so the inactivity lock stops calling `authApi.signOut()`. Lock becomes a local lock that keeps the token. Unlock verifies against the box, or against the cloud in remote mode.
- Generalise the session plugin's `AuthContext` to a principal union of account, box and device. Add a box authentication plugin using a signed challenge, and register `@fastify/websocket` for the hub.
- Fix the idempotency plugin for online iPad-to-cloud calls only: skip storing 5xx responses, claim atomically with INSERT ON CONFLICT, and key on a generic principal. Do not use it for box replay.
- Create `packages/domain` with the satang port of `apps/pos/src/lib` sale, tax, pricing, F&B, drop-off and supervision logic, plus golden tests. Split `apps/api/src/services/tax.ts` into a loader and a pure resolver. Create `packages/contracts` and `packages/devices`.
- POS data layer:
- Add a transport resolver with a station client (the box) and a cloud client, using bearer tokens.
- Formally retire the 'no browser storage' rule for the station choice, device ID and token.
- Mint UUIDv7 IDs at the moment of user action, not inside the wrappers in `api/platform.ts`.
- POS till and display:
- Refactor `Till.tsx` and `MobileTill.tsx` onto one headless session reducer.
- Make the customer-display components take `{state, dispatch}`.
- Add build artefacts: esbuild bundles for the API and the agent, a linux-arm64 CI job for `better-sqlite3`, `serialport` and `@node-rs/argon2`, release signing, and a fix for the source-relative `.env` path in `apps/api/src/env.ts`. Add the cloud-plus-box convergence harness to `oto-platform-ci.yml`.
- Fix the tenant-scoping leaks before any member data is replicated: `GET /members/:id` has no operator filter (`members.ts:167-176`) and neither does `/public/member-tier` (`public.ts:106-110`). Snapshot and feed serializers must be operator-scoped by construction.
- Set an explicit `pg.Pool` max in `packages/db/src/index.ts`. Add pg-boss on the shared pool for the snapshot builds, the alert checks, quarantine replay and the feed and heartbeat retention.

## Disagreements with brief
- Section 8, band HMAC 'under a key every box holds' and booking QRs 'signed the same way'. This is unsafe: any box, including the exposed booth and gate boxes, could forge bands for every branch and forge paid bookings. Better: booking QRs and everything else the cloud mints use Ed25519, with boxes holding only the public key. Band keys are per branch, with a key ID and day-derived subkeys held 30 days ahead. Per-box Ed25519 signing is the stronger option if the QR size is acceptable.
- Section 6, Caddy DNS-01 with the DNS provider module on each box. This puts a zone-editing credential on every Pi. Better: the box generates the key and CSR, the cloud performs DNS-01 and returns a per-box certificate. No wildcard is shared across boxes. If Caddy must self-issue, use per-box delegated acme-dns credentials.
- Section 4, caching 'members and children' on every box. Better: role-scoped caching of an active set with minimal fields. Gate and booth boxes hold no member PII. The merge rule makes a cache miss harmless, so minimising the cache costs nothing in correctness.
- Section 6, 'no power backup yet' combined with the box being the sole holder of unsynced money and child-release facts. A UPS and an RTC battery should be go-live prerequisites, not wish-list items.
- Section 4, 'a pre-imaged spare per park' in a drawer, plus section 6, 'fixed addresses via DHCP reservation'.
- A cold spare needs a large first download over cellular.
- A MAC-based reservation forces a router change during an emergency.
- Better: a warm, enrolled standby with synced scopes, and an agent-applied static IP taken from the slot config.
- The standby also serves as the update canary and as the OS-update rotation unit.
- Section 5, 'the app must not care which' of box or cloud. This holds for transport and for the data screens. It does not hold for device-bound actions, because a sale with no box has no printer, EDC or band printer. Make remote mode explicit, limited to management and reporting with selling disabled. If off-site selling is really needed, host a cloud virtual box running the same agent, so the POS still sees a box.
- Section 3, 'boxes do not talk to each other'. I accept this for Sprint 2 because a LAN relay adds election and split-brain complexity. Be explicit about its cost: the most common failure is internet down with the LAN up, and that partitions counters 10 metres apart. Mitigate by pinning supervision stations to one box. Keep events signed and courier-independent so a relay can be added later. Revisit with real outage statistics after the parallel run.
- Section 6, dnsmasq on two boxes. It makes our boxes park-wide DNS infrastructure. Prefer static host entries on the park router if it supports them. Otherwise include the standby and the router as additional resolvers.
- Section 4, a 60-second heartbeat as the only stated control channel. Revocations and config changes need a push path: a WebSocket poke, plus the revocation list repeated in every heartbeat acknowledgement. The brief is silent on OTA updates. I propose signed application releases with idle-time swap and automatic rollback, and OS updates by standby rotation.

## Open questions
- Once the production dump is profiled: how large is the member base, and do you approve caching only an active set (activity within 24 months, a wallet balance or an upcoming booking) with minimal fields on counter boxes, and nothing on gate and booth boxes? Does your data-protection adviser accept member and child medical data on encrypted boxes inside a mall?
- What is the offline wallet spend cap per wallet per day? Who absorbs an overdraft that results from offline spending, and may staff collect a negative balance at the next visit?
- Will the UPS and the Pi RTC batteries be in place before go-live? Without them a power cut can lose unsynced sales and corrupt timestamps. May the spare box be kept permanently powered on the park network as a warm standby? That gives about 2-minute recovery and a safe place to trial updates.
- Accountant: is a per-station receipt and abbreviated tax-invoice series acceptable, with a new series started whenever a box is replaced? How must gaps be explained? Does the POS need Revenue Department registration per machine?
- Child release when the record is not on this counter's box, because the check-in happened at another counter during an outage: what manual evidence is acceptable to release the child? May the prototype's child-with-guardian photo be cached on a box, and for how long?
- Do you approve pinning all supervision, drop-off and pickup stations of a branch to a single box, so they share one local record during outages?
- Router make and model, and admin access: can it hold static DNS entries and a static address range for boxes? Are the SIM plans capped? Caps set the budget for the first data download, logs and updates.
- Offline sign-in: do you approve fresh sign-in on a box for staff who used that box in the last 30 days? For tills, should offline unlock use the normal password, or a separate PIN or QR badge, which the booth needs anyway?
- Are wristband codes printed as QR (2D) on the 4B-2082A printers, and is a larger QR acceptable? A larger code allows stronger per-box signatures in place of a shared branch key.
- What time does the business day end, for occupancy reset, band validity and wallet expiry?
- Where does each booth box connect: mall network or a park-owned link? How does it reach its voucher printer? Booth boxes are physically exposed. Are lockable enclosures planned for all boxes?
- Is selling ever needed with no box present, for example at an off-site pop-up with only a phone? If yes, we host a cloud virtual box for it. If no, off-site use is management and reporting only.
- Who on site will physically swap a failed box? Is any remote support access acceptable, or is support limited to log collection plus on-site hands?
- Are snapshot and log files in object storage in Singapore acceptable for PDPA cross-border transfer?
- Can GHL and Digio confirm in writing that terminal responses never contain full card numbers? We log every raw byte.

## Sequencing
- Weeks 0-1, before any feature work: extract the services with `withTx`; create `packages/contracts` with the event envelope; rewrite `future.ts` as the ledger; add the `sync` schema and change-feed triggers; fix the two tenant-scoping leaks; and get the owner's decisions on wallet ownership and the accountant's numbering scheme under way.
- Weeks 1-2, walking skeleton with a virtual box on a laptop or container: enrol by claim code, open the WebSocket and send a heartbeat. Pull the config and catalog scopes and push one fake event through the ledger with dedup. Put the cloud-plus-box convergence harness in CI from the first day, so every later feature lands with a cut-link test.
- Weeks 1-4, parallel critical-path track: port the pricing, tax and sale engine to `packages/domain` with golden tests against the prototype. The money path cannot start on the box until this exists.
- Weeks 2-4: signed staff token and box verification; station claim and lease; the `StationSession` WebSocket with till and display; the headless till reducer. This retires the split-screen harness and the `Till` and `MobileTill` duplication before the data layer changes touch them twice.
- Weeks 4-7, money path on the box: the checkout command, sale and payment events with receipt numbering in one SQLite transaction, printer and EDC simulators including the forced-inquiry state machine, cash sessions, and the cloud projectors with totals verification.
- Weeks 5-6: member scope, read-through lookup, merge and alias, and the safety-biased child conflict rules. Reuse the alias mechanism for the migration deduplication when the dump arrives.
- Weeks 6-9: bands and keys, gate logic with anti-passback and the occupancy projection, signed booking QRs and redemption, supervision and release with the unverified-release path, then the kiosk and booth device sessions on the same pairing mechanism.
- Weeks 8-10: wallet online authorisation and the offline cap with the branch-converged flag, the anomalies and quarantine admin queue, and the fleet page with remote commands.
- Build the signed-release updater and rollback before any physical box is shipped. Remote fixing is the first thing needed once real hardware is on site.
- Run the Pi image as a parallel infrastructure track on one development Pi from week 2: read-only root, the `boot / rootA / rootB / data` layout, LUKS bound to OTP, Caddy with cloud-brokered certificates, dnsmasq and the watchdog. Do the plug-pull and real-router tests in stabilisation.
- Keep the suite merge off the box path. Boxes consume only the core `staff` scope plus the POS scopes. Register box scopes and event types through the module manifest, so the timekeeping kiosk can join later without a second sync mechanism.

# CRITIQUE — verdict: sound-with-changes.

The skeleton is right and should be kept:
- local-first journal;
- facts go up, state comes down;
- trigger-written change feed;
- one cloud write path;
- split between a disposable cache and a durable journal;
- a lease that lives on the box;
- asymmetric keys for anything the cloud mints.

I checked the proposal's claims about Sprint 1 against the repository and they are accurate:
- There are zero `.transaction(` calls in `apps/api`.
- `newId()` is called server-side at `members.ts:206/325/414`, `visits.ts:48` and `public.ts:221`.
- There are hard deletes at `accounts.ts:199` and `catalog.ts:247`.
- `memberWithChildren` and `/public/member-tier` have no operator filter.
- `audit.ts` claims the audit row commits atomically with the change, but it does not.
- The idempotency plugin stores 5xx responses and can wedge on an in-flight crash.
- `pg.Pool` has no max set.

The design is not yet correct as a distributed system. I found thirteen high-or-critical problems (findings 1 to 13 below). Two of them can hurt a child-safety or money record in the field:
- The box has no defined way to read back its own writes that the cloud has not yet acknowledged.
- The ingest silently drops events after a journal rollback, because `ON CONFLICT DO NOTHING` is applied to two unique keys at once.

The others:
- The xid8 guard does not fix the cursor race if the cursor is `change_seq`.
- The projector runs in the ledger transaction, so a projector bug un-stores the fact.
- Rows that leave a scope never reach the box.
- Last-writer-wins uses box clocks the design itself calls unreliable.
- Totals verification cannot work, because there is no catalog history and no domain version on the event.
- The stated unique constraints are impossible on partitioned Postgres tables.
- Version skew between the PWA, the box and the catalog is not handled.
- PIN and badge hashes go to every box, which contradicts the design's own rule.
- Auto-merge on a phone collision is unsafe for established members.
- The online calls and the later fact events can apply the same wallet spend or redemption twice.

Scope is under-estimated. The proposal spends weeks 0-10 on the box alone, while the brief requires Sprint 2 to finish all remaining software plus the suite merge. Cut the hash chain, per-event courier signatures, prebuilt object-storage snapshots and monthly partitioning to pay for the correctness work below.
- [critical] The box has no defined way to read its own writes before the cloud acknowledges them.
- Section 3 of the proposal lists what `journal.db` holds: the outbound event log, receipt counters, redemption and spin logs, anti-passback state, session snapshots, staff verifiers and command IDs. Members, children, pickup persons and supervision check-ins are not on that list.
- Those records exist only as down-synced scopes in `cache.db`. The proposal calls `cache.db` disposable, runs it with `synchronous=NORMAL`, drops it second under disk pressure, and wipes a whole scope when the cache schema version changes.
- Down-sync replaces a cached row with the cloud's version. A local edit that has not been acknowledged is overwritten.
- The design has a pending overlay for wallets only ('cached balance minus local pending'). — WHY: - Brief section 8 says a child is never refused release and that release runs from the box while offline.
- The proposal names cross-box invisibility as a risk. It misses the same problem on a single box.
- Example: a child is checked in at counter 1 during an outage. A cache drop, a resnapshot or a disk-pressure purge follows. The check-in and the newly added pickup person are no longer queryable on the box that created them, until the internet returns and the round trip completes.
- The same applies to a member created offline ten minutes earlier, and to reprint and void of today's sales. — FIX: - Define the box read model as cloud state at the cursor plus a durable overlay reduced from the box's own unacknowledged events.
- Keep the overlay in `journal.db` and rebuild it from the event log after any cache wipe.
- Remove an overlay entry only when a down-synced row carries its `source_event_id`, or when the ack returns the feed position at which the projection became visible.
- Apply the overlay generally: members, children, pickup persons, check-ins, releases, bands and sales. Do not special-case wallets.
- Add a convergence-harness test: wipe `cache.db` while offline and with a non-empty outbox, then assert the release lookup still works.
- [critical] The ingest silently drops a different event that reuses a box sequence number, and nothing reconciles a journal that has rolled back.
- The proposal specifies `INSERT INTO sync.event ... ON CONFLICT DO NOTHING`, with unique keys on both `event_id` and `(box_id, box_seq)`.
- `ON CONFLICT DO NOTHING` with no target ignores a conflict on any unique index.
- If a box reuses a `boxSeq` for a different event, the new fact is discarded and acknowledged as applied. — WHY: - Sequence reuse is realistic here. Brief section 6 says there is no UPS yet. Consumer NVMe drives can lose recently flushed writes even with `synchronous=FULL`. A journal restored from the escrowed key or from a cloned image also rewinds.
- Example: the cloud has events 100 to 105. Power is lost and the journal comes back at 102. The box then mints new sales as 103' and 104'. Those sales are dropped without any alert.
- The receipt counter rewinds at the same time, so two different sales print the same abbreviated tax-invoice number.
- The hash chain detects none of this, because the new event never reaches chain verification. — FIX: - Use `ON CONFLICT (event_id) DO NOTHING` only.
- Add a `journalEpoch` (a random ID created with `journal.db`) to the envelope and to the sequence key. Treat the same `(box, epoch, seq)` with a different `event_id` as a fork: store the event in a fork lane and raise a critical anomaly.
- Add a connect handshake. The cloud returns `appliedThrough`, the head hash and the highest receipt number per station series. A box that is behind jumps its sequence and receipt counters past the cloud's values plus a margin, and emits a `journal.rollback_detected` event.
- Add rewind scenarios to the 200-cycle plug-pull test.
- [high] The xid8 visibility guard does not fix the skipped-row race if the cursor is `change_seq`.
- Section 6 says 'one cursor per scope', with a `change_seq` column and the filter `xid < pg_snapshot_xmin(...)`.
- Sequence order and transaction-ID order are independent of each other.
- Example: transaction A has xid 100 and takes seq 7. Transaction B has xid 101 and takes seq 6. A commits first. A reader sees xmin 101, serves seq 7 and moves the cursor to 7. B then commits with seq 6, which is below the cursor, and is skipped forever.
- The xmin watermark is also global to the database. Any long write transaction anywhere in the merged central database freezes every box's feed. Examples: the 150k-row importer, a nightly rollup, an idle-in-transaction connection from an imported Replit app. — WHY: - The proposal itself calls a missed role revocation a security defect.
- A skipped catalog or band-deny row is silent, and nothing but a resnapshot repairs it.
- The addendum puts HR, analytics, finance and the importer in the same database, so long transactions will happen. — FIX: - Make the cursor the tuple `(xid8, change_seq)`, ordered and compared as a tuple.
- Alternatively use an xmin watermark cursor: serve rows where `last_xmin <= xid < current_xmin`.
- Take the transaction ID with `pg_current_xact_id()` inside the trigger.
- Set `idle_in_transaction_session_timeout` and a statement timeout on every application role.
- Make importers and rollups commit in small batches.
- Export feed lag (the age of xmin) as an alert.
- Build the revocation list in heartbeat acks from live tables, not from the feed, so that revocations bypass a stalled feed.
- Test the race with two interleaved transactions in the convergence harness.
- [high] The ledger insert and the projector share one transaction, so a projector bug un-stores the fact.
- Section 7: 'If the row was inserted, the projector runs in the same transaction.'
- The design has three outcomes: applied, anomaly, and quarantine for malformed or unverifiable events.
- It has no outcome for a well-formed event whose projection throws. Causes include a NOT NULL or foreign-key violation, the `member_phone_unique` index, a deadlock, or a bug.
- The exception rolls back the ledger row. The only copy of the sale stays on a Pi in a mall, held 'until the cloud marks it resolved'.
- Moving past a failed event N also breaks the 'strict per box' order. A void before its sale, a release before its check-in, or a spend before its top-up can then be projected. — WHY: - This contradicts the proposal's own rule 2: 'well-formed, authentic events are always applied'.
- The Sprint 1 tables have hard foreign keys on `child.member_id`, `visit.member_id`, `wallet_entry.wallet_id` and `member_tier_verification.member_id` (in `packages/db/src/schema/members.ts` and `future.ts`). Projections will throw against these. — FIX: - Split ingest into two phases. Phase 1 stores the raw bytes durably in `sync.event` and acknowledges. An ack means the cloud has the fact, not that it has been projected. Phase 2 projects the event.
- Track `projected_at`, `projection_error` and an attempt count per event, with a retry worker.
- Make projections rebuildable from the ledger.
- State that projectors must commute within a box as well as across boxes, and property-test this by shuffling ingest order in the convergence harness.
- [high] Rows that leave a scope never reach the box.
- The feed stores keys only. `branch_id` and `scope` are computed by the trigger from the NEW row.
- When a scope-determining column changes, only the new scope gets a change row. The box that holds the old scope hears nothing.
- Examples: a booking moved to another date or branch, a booking cancelled through a status change, a staff assignment moved between branches, a band re-issued. None of these is a DELETE, so the DELETE tombstone trigger does not fire. — WHY: - Brief section 8 says a box admits a booking QR offline by checking the signature and its local redemption log. A booking rescheduled to next month stays in branch A's 'today minus 1 to today plus 7' window and can be admitted today.
- A staff member reassigned away from a branch keeps their grants on that branch's boxes until the next resnapshot. — FIX: - On UPDATE, when any scope-key column differs between OLD and NEW, emit change rows for both the old scope and the new scope.
- Have the serializer return a tombstone for the requesting box when the live row no longer matches that box's scope predicate.
- Treat a status change to cancelled as a scope exit.
- Make the weekly row-count and hash audit bidirectional. It should find rows that are on the box but no longer in scope on the cloud, not only rows missing from the box.
- [high] Field-level last-writer-wins uses `occurredAt` from box clocks, and the schema has no per-field version data to apply it.
- The same proposal calls box clocks unreliable and asks for an RTC battery.
- A box with its clock ahead wins every future conflict on that child. A later correct edit by an admin loses.
- `packages/db/src/schema/members.ts` has only a row-level `updated_at` on `child` and `member`. The cloud therefore cannot apply field-level last-writer-wins between an HTTP edit to the allergies field and a late box edit to the notes field. — WHY: - These are the allergies, medical-notes and medical-alert fields of children at a supervised play park.
- The suite merge adds more writers to the same rows: the booking site, admin at home and the imported apps. — FIX: - Order writes by an effective timestamp equal to the earlier of `occurredAt` and `receivedAt`. A box can then never win with a future clock.
- Exclude events with `ntpSynced=false` from last-writer-wins. They fill blanks only and raise an anomaly.
- Add a `field_versions` jsonb column to `child` and `member`, holding `{timestamp, origin, eventId}` per field. Have the HTTP services write it too.
- Keep the OR-merge for `medicalAlert` and the show-both rule for conflicting allergy text. Both are good.
- [high] Many box decisions depend on the wall clock, and the design does not say what the box does when its clock cannot be trusted.
- `K_day = HMAC(K_branch, date)`: if the counter box and the gate box disagree on the date, every band fails at the gate.
- `todayRateMode()` in `apps/pos/src/lib/pricingMode.ts` calls `new Date()` to choose weekday or weekend pricing and holiday overrides. A wrong date gives wrong prices on tax invoices.
- Staff-token expiry: with the clock ahead, staff are locked out offline. With the clock behind, tokens never expire.
- The 04:00 window roll, booking validity and UUIDv7 ordering all use the wall clock.
- A 60-second remote-command expiry blocks remote repair of exactly the box whose clock is wrong. — WHY: - Brief section 6 confirms there is no UPS, so the box will cold-boot offline.
- The proposal makes the RTC battery a prerequisite but gives no behaviour for a clock that is still wrong.
- The brief forbids refusing to sell. — FIX: - Persist a last-known-good time floor in `journal.db`: the latest of the last event time and the last cloud time.
- On boot, if the clock is below the floor or unsynced, enter a degraded-clock mode. Use the till iPad's time, confirmed by staff. The proposal already compares the two clocks.
- In degraded-clock mode the gate accepts `K_day` for today plus or minus one day, the rate mode is shown on the till for staff to confirm, and events are flagged.
- Base remote-command freshness on a nonce that the box issues for each WebSocket connection, not on wall-clock expiry.
- Make the clock an explicit input everywhere in `packages/domain`. Remove `new Date()` and `Math.random()` from `sale.ts:221-316`, `pricingMode.ts:57` and `supervision.ts:159`.
- [high] The cloud cannot verify totals as designed.
- The cloud is meant to re-run `computeTotals` against the event's `catalogCursor`.
- The feed holds keys only, and payloads are read from the live table at serve time. No history of catalog rows exists, so the catalog as of a cursor cannot be reconstructed.
- The event envelope carries no domain-code version. A box on agent 1.4 and a cloud on 1.6 will disagree after any deliberate change to rounding or discount logic. — WHY: - The proposal relies on this check to catch divergence in the port from float baht to satang, which it calls the critical path.
- As designed, every price edit during trading and every staged box rollout floods `sync.anomaly`. Staff will learn to ignore that queue, and it is the same queue that carries child-release anomalies. — FIX: - Make the sale event self-describing. Per line it should carry the unit price applied, the rate mode, the tax rule and rate, the discount definition and the `domainVersion`.
- Cloud verification then becomes pure arithmetic on the event's own inputs.
- Report price-against-catalog drift separately, at low severity, from an immutable catalog version table, or from the before and after values in `audit_log`.
- Show 'prices as of <cursor time>' on the till while offline.
- [high] Version skew between the PWA, the box and the catalog is not handled.
- The PWA is served from the cloud and updates on every deploy. Boxes update in a 03:00-06:00 window, by channel, and never two counter boxes of a branch in one window.
- A new till will therefore talk to a box LAN API that is one to several versions old, for days at a time. The proposal versions events and cache rows but not the station API or the `StationSession` reducer.
- 'Unknown fields are ignored' does not cover unknown enum values in known fields. In `packages/shared/src/pricing.ts:42-53`, `resolveAdultLine` treats any rule kind it does not recognise as `free_adults`, so an old box silently misprices a new rule kind. If the box validates rows with zod, it rejects the row and the package disappears from the till. — WHY: - The addendum's requirement to switch features on and off per role means the catalog and config gain new semantics often.
- This skew will occur at every release. — FIX: - Have the box report its `stationApi`, `cacheContract` and `domain` versions in `/healthz` and in the heartbeat.
- Have the PWA support a range of API versions and gate features on the box's capabilities. Alternatively, serve the till bundle from the box as the primary origin, so the UI and the agent always match.
- Have serializers hold back or down-convert rows that a box's contract version cannot interpret.
- Have the admin UI refuse to activate a catalog feature until every box in the branch supports it.
- Make switch statements in `packages/domain` exhaustive. An unknown kind should refuse the line with a clear message and never fall through.
- [high] Staff credential hashes go to exposed boxes, and the design contradicts itself about which boxes hold them.
- The scope table sends 'all operator accounts ... PIN and badge hashes' to every box. That includes the booth box elsewhere in the mall and the gate box.
- Section 5 says a box holds argon2 verifiers only for staff who actually used it.
- A 4-to-6-digit PIN under any hash is brute-forced offline within hours.
- The used-this-box rule means a counter 1 cashier, or the admin who must authorise an offline station takeover, cannot unlock counter 2 on the day counter 1's box dies. — WHY: - A stolen booth box yields every staff PIN for the operator.
- The offline recovery path the proposal describes cannot run for staff who have not used the surviving box. — FIX: - Make the badge a cloud-signed Ed25519 credential, so the box holds only a public key and no secret.
- Treat the PIN as a second factor to the badge, never as a standalone login.
- Scope verifiers by branch assignment and box role. Counter boxes get the staff of their branch. The booth box gets booth staff only. The gate box gets none.
- Push password verifiers for all staff assigned to a branch to that branch's counter boxes, so that failover works.
- Rate-limit attempts and wipe a box's verifiers when its key is revoked.
- [high] Automatic member merge is unsafe outside the case of a fresh offline-created record.
- `apps/api/src/routes/members.ts:263-267` lets a PATCH change a member's phone number.
- A phone edit made at a box while offline can collide with an established member. 'First ingested survives, loser fills blanks' would then auto-merge two real families over a typo, along with their children, wallets and tier verifications.
- `member_phone_unique` includes archived rows. The box cache excludes archived members. An offline create can therefore merge into an archived member and disappear.
- No rule covers a conflict on `tier_code`. That field is never blank and it affects price. — WHY: - A wrong merge attaches allergy and medical data to the wrong family.
- The proposal lists this risk, but its own merge rule produces it.
- Brief section 10 requires tier changes to be evidence-backed and audited. A merge must not silently promote or demote a tier. — FIX: - Auto-merge only when the losing record is a fresh offline-created one with no prior cloud existence. Every other phone collision raises an anomaly for a human, and the phone change is not applied.
- Make phone changes online-only, or hold them as pending requests.
- A merge into an archived member un-archives it.
- For tier, the verified tier with the newest unexpired evidence wins. Never downgrade through a merge.
- Keep the reversible alias table and the strict child match on name plus date of birth. Both are good.
- [high] The five synchronous online operations and the later fact events can apply the same effect twice.
- The box calls the cloud for wallet spend authorisation and for booking, voucher and spin redemption.
- Under the local-first rule the box then also emits the fact event for the same action.
- The proposal does not tie the two together by ID. The projector can debit the wallet ledger a second time.
- An online call that timed out, followed by the offline fallback, is reported as a false cross-box double redemption. — WHY: - Wallet balances are a financial liability on the books.
- False double-redemption anomalies weaken trust in the exceptions queue. — FIX: - Have the box mint the `wallet_entry` ID or the redemption ID before it makes the online call.
- Make the cloud call idempotent on that ID.
- Have the later event carry the same ID, so that the projector upserts one row and recognises the effect as already applied online.
- Add timeout-then-fallback cases to the convergence harness.
- [high] The proposal's unique constraints cannot exist on partitioned Postgres tables.
- Postgres requires every unique or primary key on a partitioned table to include the partition-key columns.
- `sync.event` 'partitioned monthly, unique on `event_id` and on `(box_id, box_seq)`' therefore cannot enforce global deduplication.
- The same applies to `audit_log` with a composite key on `(id, created_at)` plus 'a unique `source_event_id`'. — WHY: - Permanent deduplication by event ID is the basis of the whole up-sync design.
- The volume does not need partitioning. About 3,000 events per box per day across roughly eight boxes is a few million rows a year. — FIX: - Do not partition `sync.event` in version 1. If it must be partitioned, partition by range on the UUIDv7 `event_id` itself with a DEFAULT partition, and enforce `(box, epoch, seq)` in a small unpartitioned key table.
- For `audit_log`, take the brief's other option, archive after twelve months. Get audit idempotency from the ledger-guarded projection instead of a unique index.
- [medium] Replacing a box has three fencing holes.
- 'Revokes the dead key from a timestamp' is judged against `occurredAt`. A thief controls that value on a stolen box and can back-date events.
- A box that is only flapping can come back while the standby has applied the slot's static IP. The old box still holds a certificate valid for up to 90 days. Two boxes then answer for the same stations, on the same IP, with the same receipt series.
- An offline station takeover while the original box is only partitioned produces duplicate receipt numbers, unless the series is keyed by box incarnation. The proposal leaves that to the accountant. — WHY: - Duplicate abbreviated tax-invoice numbers are a compliance problem.
- Events from a revoked box are either forged by a thief or legitimate unsynced sales recovered from a dead disk. The design cannot tell the two apart. — FIX: - Revoke by sequence head. Everything above the cloud's known `(epoch, seq)` for that box goes to a review lane for an admin to approve.
- Key the receipt series by station plus box incarnation, always. The accountant decides the format only.
- On boot, the box runs duplicate-address detection and refuses to claim stations if its IP is already answered or its key is revoked.
- The runbook says to unplug the dead box before pressing Replace.
- [medium] Payment state does not survive power loss or a box swap.
- The `journal.db` list has no payment intent that is committed before the sale is sent to the terminal. If the box loses power between the terminal's approval and the journal commit, the box does not know it must run an inquiry.
- The Digio reference is a 6-digit rolling counter per terminal (brief section 7.1). If that counter lives on the box, it restarts when the terminal is re-homed or the box is replaced. An inquiry can then return the wrong transaction. — WHY: - Brief section 7.1 requires an inquiry before the till may continue after any unanswered sale.
- GHL card sales cannot be inquired at all, so a lost intent there is a silent paid-but-unrecorded sale. — FIX: - Write a payment-intent row to `journal.db` with `synchronous=FULL` before any bytes go to the terminal. Include the reference, amount, terminal ID and station.
- Run the inquiry state machine against open intents on boot.
- Keep the per-terminal reference counter in the station config or the cloud. On re-home, seed it to the highest value the cloud has seen plus a margin.
- Give 2C2P QR payments the same pending, inquire and staff-confirm state machine, for a WebSocket drop after the customer has paid.
- [medium] PII minimisation is weaker than it looks.
- The active set is 'activity in 24 months, or a wallet balance, or an upcoming booking'. For a tourist-heavy park that is close to the whole member base. It would sit on every counter box, the kiosk box and the warm standby, together with children's allergy and medical text.
- LUKS unlocked from a key in OTP memory is defeated by booting the Pi from USB. The proposal itself notes it does not stop a thief who takes the whole box.
- Nightly snapshots in NDJSON put the same PII in object storage, fetched by presigned URL, with no lifecycle or encryption stated.
- Event payloads in the never-wiped journal, and `StationSession` snapshots, also hold PII for 30 days or more. — WHY: - Medical data about children is sensitive under the Thai PDPA. The brief already treats biometrics with the same caution.
- The boxes sit unattended in a mall.
- An erasure request must reach the boxes and the snapshot files. — FIX: - Shrink the scope to members seen at this branch in the last 90 days, plus upcoming bookings, plus wallet holders. Drop tourist-tier members after 30 days. Medical text stays only for children with a booking or check-in today. Everything else is a read-through to the cloud.
- Make Pi 5 secure boot and a locked boot order go-live requirements for any box that holds the members scope.
- Replace prebuilt snapshots with a paged live pull. 150k rows is manageable at opening-time scale. If snapshots stay, encrypt each one to the box's public key and expire it after 24 hours.
- Purge `StationSession` snapshots when the sale completes.
- Redact member payloads from acknowledged journal events after N days.
- [medium] Two problems affect the members scope and bulk writes.
- The order 'drop the scope and take a new snapshot' is wrong for members. If the link fails mid-download on capped dual-SIM 4G, the box opens with no member cache. A release that bumps the cache schema also triggers every box at once.
- The handoff from snapshot to feed is unspecified. The snapshot must be built in one REPEATABLE READ transaction, and the feed must restart from a cursor at or before that snapshot's xmin.
- Bulk writers fire one trigger row per row written. This covers the 150k-row SCRUM-12 importer and the merged suite apps. Every box would then pull 150k changes. — WHY: - The owner has announced a production dump and a multi-app merge into the same database.
- Whether the SIM plans are capped is still an open item in brief section 6. — FIX: - Build the new scope version beside the old one and swap atomically once it is complete. Never drop first.
- Record the snapshot's cursor from its own transaction snapshot.
- Add a bulk mode. The importer sets `SET LOCAL oto.sync_bulk=on`, which makes the triggers no-ops, and then bumps a per-scope epoch that forces a staggered resnapshot.
- Use statement-level triggers with transition tables for bulk UPDATEs.
- [medium] Wallets and the gate have three unresolved cases.
- 'Branch converged' is undefined and may never be true. If it means every box has an empty outbox, one dead, unplugged or standby box pins the whole branch to the offline wallet cap.
- A wallet sold at counter 1 during an outage is unknown at the restaurant box. The formula `min(cached balance − local pending, cap)` gives zero, so a child cannot spend credit the family just bought. The alternative gives every valid band the cap amount in free credit.
- Anti-passback state lives only in the gate box's journal. After a gate box swap, every band already inside looks like it is outside. Brief section 7.5 says both directions are host-controlled. — WHY: - The first case is restaurant revenue and the first thing an owner notices after an outage.
- The third case is a child who cannot exit the park. — FIX: - Drop the convergence gate. The cloud authorises online spends atomically against the ledger. Exposure to pending offline spends is already bounded by the cap times the number of stations.
- If the convergence gate stays, define it over boxes that can spend and have a heartbeat younger than N seconds, and let an admin exclude a box.
- Ask the owner about an unknown wallet on a valid band. The suggested default is to allow spend up to the cap and record it against a provisional wallet ID carried in the band.
- Exit is always granted when the band's state is unknown.
- A new gate box rebuilds anti-passback state from the cloud's passage projection, by including the last direction per band in the bands scope.
- [medium] Several parts of the design add risk without earning their cost for about ten boxes and one small team.
- A per-event Ed25519 signature plus a hash chain. A key mix-up after a swap, or a JSON canonicalisation bug, would quarantine real money facts.
- Nightly snapshots in object storage.
- Monthly partitions.
- The A/B root partition layout.
- LUKS key escrow.
- The 10-week sequence covers only the box, while brief section 2 requires Sprint 2 to finish all remaining software, and the addendum adds a suite merge and a launcher.
- The domain port is described as about 900 lines. It is about 2,000 lines once transitive imports are counted. `sale.ts` imports `discountTarget.ts`, and `fnb.ts`, `benefits.ts` and `promoVoucher.ts` all read the `catalogStore` globals. The engine lives in `apps/pos/src/lib`, which holds 4,825 lines in total. — WHY: - Schedule pressure lands on the convergence harness and the recovery paths. Those are what make an offline box safe. — FIX: - Sign and store the exact raw bytes and never re-serialise them.
- Authenticate the session with the signed challenge, and defer the courier and hash-chain work. Keep the gapless sequence, the epoch and the cloud head handshake.
- Defer prebuilt snapshots and partitioning.
- Re-estimate the domain port from the real import graph.
- Put the freed time into the overlay, the ingest split and the clock-degraded mode.
- [low] Several smaller gaps remain.
- A bearer staff token is kept in browser storage on shared iPads, and boxes accept it offline with no revocation.
- `journal.db` has two writer processes. `oto-station` writes sales with `synchronous=FULL` while `oto-link` writes acks, verifiers and command IDs. A long-lived reader in the other process can block WAL checkpoints.
- The per-scope cursor must live in `cache.db` with its rows. If it sits in the never-wiped journal, a cache wipe leaves a cursor that points past an empty cache.
- An idle standby is a weak update canary. It has no EDC or printer and carries no sales.
- A cloud rollback after boxes have upgraded sends newer-version events into an alerting quarantine.
- SCRUM-118, face identity evidence for the timekeeping kiosk, conflicts with the brief's ban on biometrics. It would reach boxes if the kiosk reuses this sync engine. — WHY: - Each one is a field failure that is cheap to prevent now and costly to debug on a Pi in Phuket. — FIX: - Bind the token to a non-extractable WebCrypto key on the iPad and sign each request to the box.
- Make `journal.db` single-writer by moving `oto-link`'s bookkeeping into its own `link.db`. Set `busy_timeout` and run periodic `wal_checkpoint(TRUNCATE)`.
- Keep cursors inside `cache.db`.
- Use the staging virtual box with simulators as the functional canary, and the standby only for boot and sync.
- Add a 'deferred, newer version' lane that replays automatically on deploy and does not alert.
- Exclude biometric evidence from every box scope by rule.

## Got right
- Its description of Sprint 1 is accurate. I confirmed each of these in the repository: zero `.transaction(` calls in `apps/api`; server-side `newId()` at `members.ts:206/325/414`, `visits.ts:48` and `public.ts:221`; hard deletes at `accounts.ts:199` and `catalog.ts:247`; tenant leaks in `memberWithChildren` (`members.ts:54-56` and `167-176`) and in `/public/member-tier` (`public.ts:106-110`); `audit.ts` claiming atomicity it does not provide; no pool max in `packages/db/src/index.ts`; and the idempotency plugin caching 5xx responses, racing between its select and insert, and wedging on `IDEMPOTENCY_IN_FLIGHT` after a crash.
- It is local-first always, with one code path, and the journal commit is the point at which a sale exists. Offline is exercised by every sale, and counter latency does not depend on Render's 1-CPU tier.
- Facts go up and state comes down. The cloud never rejects an authentic fact that has already happened at a counter, and business problems become anomalies. Keep the rule, but fix the ingest split described in the findings.
- It refuses to replay box traffic through the Sprint 1 Idempotency-Key plugin. Permanent deduplication by event ID is the right replacement.
- The change feed is written by triggers, not by `updated_at`. `$onUpdate` in `packages/db/src/schema/helpers.ts` is Drizzle-only, and the importer and the merged suite apps would bypass it. Storing keys only, with per-entity serializers as the single place where PII is minimised, is a good structure.
- `cache.db` is disposable and `journal.db` is durable, expand-only and never wiped. The disk-pressure order is explicit. Keep this split and add the overlay.
- `oto-station` and `oto-link` are separate processes that share only SQLite, so a sync bug cannot interrupt a sale or an EDC transaction. In tests they compose in-process, mirroring `buildApp`.
- One-till-per-station is enforced by a lease held on the box, with a grace period and an audited takeover. There is no distributed lock, and the lease works offline.
- The live sale is a `StationSession` document owned by the box and broadcast as full state. The display gets a redacted view and never computes totals. This removes the split-screen harness and the decision-D8 channel based on `session.pending_lookup_phone`. It also gives the kiosk, the booth and the display one pairing mechanism, which matches the 'one mechanism, not two' note on SCRUM-116.
- It challenges the brief on keys correctly. There is no global HMAC key shared with booking QRs. Everything the cloud mints is asymmetric. Boxes hold no DNS-provider credential, because the cloud brokers the CSR. Box identity is a keypair generated on the device, and the cloud stores only public keys.
- The child-safety merge rules are sound. `medicalAlert` is OR-merged, conflicting allergy text shows both versions and raises a high-severity anomaly, pickup persons are an add-wins set, and a release is never blocked and gets an 'unverified release' critical anomaly. Pinning supervision stations to one box is sensible.
- Poison events do not block the queue. Raw bytes are retained and quarantine can be replayed after a fix.
- Application releases are signed, swapped only when the box is idle, health-checked and rolled back automatically. There is no Docker and no remote shell. Gate release and drawer open are never remote commands. A box below the minimum version still sells and pushes, so a counter is never bricked.
- A warm, enrolled standby with a slot abstraction replaces the cold spare in a drawer and the MAC-based DHCP reservation. Add the fencing described in the findings.
- The sync engine is a core platform service, with box scopes and event types declared in module manifests. That is the correct fit for the addendum's single system, and for the timekeeping kiosk in SCRUM-116/117.
- UPS and RTC are treated as go-live prerequisites. The plan includes a plug-pull test and a convergence harness in CI from the first week. Remote mode is made explicit, for management and reporting only, in place of 'the app must not care'.