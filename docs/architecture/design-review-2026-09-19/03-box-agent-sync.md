# Station-box agent and cloud-to-box sync: target architecture

## 1. Stance

The box is not a thin event recorder. Offline it must price, tax, allocate receipt numbers, sign bands, verify staff, decide gate access and cap wallet spend. All of that is domain logic, so it runs on the box from shared pure TypeScript. The cloud is the recorder for station activity. It accepts facts, stores them once, projects them into tables and flags problems for a human.

Three rules follow.

1. **Local-first, always.** Every station action is committed to the box journal first and forwarded afterwards, whether or not the internet is up. There is no separate online path for sales. Only five operations call the cloud synchronously when online, and each has a defined offline fallback:
   - wallet spend authorisation;
   - booking redemption;
   - voucher redemption;
   - booth spin eligibility;
   - 2C2P QR creation.
2. **Facts go up, not commands.** A sale that printed a receipt and took a card payment cannot be rejected later.
   - Well-formed, authentic events are always applied.
   - Business problems become `sync.anomaly` rows for review: overdraft, double redemption, a token expired at the time of action, a totals mismatch.
   - Only malformed or unverifiable events are quarantined.
3. **One write path in the cloud.** HTTP routes and the box ingest call the same transactional service functions. This requires the service and transaction extraction that Sprint 1 skipped: there are zero `.transaction(` calls in `apps/api`.

## 2. Code layout

| Package | Contents | Runs on |
|---|---|---|
| `packages/domain` (new, pure, satang) | The pricing, tax, totals, discount and voucher engine ported from `apps/pos/src/lib/{sale,tax,pricing,fnb,dropoff,supervision,manualDiscount,promoVoucher}.ts`. Also: the till-session reducer, band-code sign and verify, booking-QR verify, staff-token verify, the permission evaluator (moved from `apps/api/src/services/permissions.ts`), the wallet-cap rule, the anti-passback decision, the member-merge rule and the receipt-number formatter. | browser, box, cloud |
| `packages/contracts` (new, zod) | The event envelope and per-type payloads, with versions and upcasters. Cache-row schemas per scope. The station LAN API. The sync protocol (pull, push, heartbeat, remote command). The station config bundle. | all |
| `packages/devices` (new) | `PaymentTerminal`, `Printer`, `Scanner`, `Gate` and `CashDrawer` interfaces, simulators with scriptable faults, and the real adapters later. | box |
| `apps/box-agent` (new) | SQLite repositories, command handlers, the LAN API, station sessions, the sync link and the updater. | Pi, dev laptop, staging container |
| `apps/api/src/modules/sync` | Change feed, snapshot builder, ingest, projectors, quarantine, anomalies. | cloud |
| `apps/api/src/modules/boxes` | Enrolment, slots, WebSocket hub, remote commands, fleet releases. | cloud |

**Staging without hardware.** The same agent runs as a "virtual box" on a laptop or in a container with a persistent disk. Its simulators are driven from a `/sim` control page, which is enabled only when `SIMULATORS=1`. This satisfies brief section 2.

## 3. Agent process model

One signed bundle runs as three systemd services on the read-only root, beside Caddy and chrony.

- **`oto-station`** holds the LAN HTTP and WebSocket API (behind Caddy on 443), station sessions and leases, command handlers and device adapters. It never depends on the cloud.
- **`oto-link`** holds the outbound WebSocket to the cloud, the down-sync pull and apply, the up-sync sender, the heartbeat and remote-command intake.
  - The two processes share state only through SQLite in WAL mode, plus a Unix-socket poke. A sync bug or restart therefore never interrupts a sale.
  - Down-sync applies in small transactions of 200 rows or fewer, so the till's writes never wait.
- **`oto-updater`** downloads, verifies and swaps releases.
- All three use `Type=notify` with `WatchdogSec`, and the hardware watchdog runs through systemd.
- In tests, all three compose in-process through `buildAgent({devices, link})`, mirroring `buildApp`.

**There are two SQLite files, on purpose.**

- **`cache.db`** holds down-synced reference data. It is disposable and uses `synchronous=NORMAL`.
  - Rows are documents: `id`, `doc` JSON, and generated indexed columns (for example the phone number on `cache_member`).
  - A newer cloud can add fields without a box migration, because unknown fields are ignored.
  - A breaking change bumps the cache schema version, and the box drops the scope and takes a new snapshot.
- **`journal.db`** holds the irreplaceable data and uses `synchronous=FULL`:
  - the outbound event log;
  - the receipt counters;
  - the local redemption and spin logs;
  - the anti-passback state;
  - station session snapshots and leases;
  - known-staff verifiers;
  - executed command IDs.
  - Its schema is small, its migrations are expand-only, and it is never wiped.

**Disk-pressure policy.** Logs are dropped first, then the cache. The journal is never dropped.

## 4. LAN API: leases and the live sale

- The iPad loads the PWA from the cloud origin and calls the box cross-origin with `Authorization: Bearer`.
- The box answers CORS for the configured app origins only. It sends `Access-Control-Allow-Private-Network: true`, which Chrome requires for a public page calling a private address.
- There are no cookies, so there is no CSRF surface.
- Browsers cannot set headers on a WebSocket, so the till first obtains a single-use 30-second ticket and then opens `wss://<box>/station/:id/live?ticket=`.
- Everything except `/healthz` needs a staff token or a device token.

**One active till per station** is a box-local lease. It needs no cloud and no distributed lock, which is why a station belongs to exactly one box.

- `station_lease(station_id, role, device_id, account_id, token_jti, last_seen)` has three roles: `till` (one), `display` (one) and `observer` (many, read-only).
- The lease is kept alive by the WebSocket and a 10-second ping. It expires 30 seconds after the socket drops, so a Wi-Fi blip does not lose the till.
- A second claim gets `409 STATION_IN_USE` naming the holder. Taking over requires the same account or the `pos:station:takeover` permission, emits an audited event, and demotes the old till to observer.
- The inactivity lock keeps the lease but refuses commands until unlock.

**The live sale** is one `StationSession` document owned by the box. It holds the stage, lines, totals, a member summary, the consent draft, the payment state and a revision number.

- The till sends intents such as add line, set member and start payment.
- The display sends customer intents such as submit phone, acknowledge consent and patch child.
- The box reduces these with the pure reducer in `packages/domain`. It recomputes totals, bumps the revision and persists a snapshot, so a box restart or an iPad reload restores the draft.
- The box then broadcasts the full document. It is under 20 KB, so full state is simpler than patches and has no patch-ordering bugs.
- The display receives a redacted `toDisplayView()` and never computes totals. Today `CustomerDisplay.tsx` calls `computeTotals` itself; that call goes away.
- Keystrokes stay local to the display until submit.
- One document type with a `kind` field replaces all six split-screen host surfaces. It also removes the `Till.tsx` and `MobileTill.tsx` duplication.

**Display pairing.** The display shows a 6-digit code. A till holding the lease confirms it. The box then issues a revocable device token bound to the station and the device. This is the single device-session mechanism that SCRUM-116 asks for, reused by the kiosk and the booth.

**The iPad talks to two backends.** The box handles station operations. The cloud handles management, history and reports, which show "unavailable offline". The box serves its own last 30 days of sales for offline reprint and void.

## 5. Identity, keys and secrets

**Box identity.**
- On first boot the box generates an Ed25519 keypair. The private key never leaves the box.
- The box says hello to the cloud with its public key.
- An admin claims the box by scanning a 12-character claim code, derived from the key fingerprint and printed on the box label at bench imaging.
- After that, the box authenticates by signing a challenge. `station.device_key_hash` is replaced by `box.public_key`.

**Slot.** A slot is the logical box: hostname, static IP, stations and device assignments. It survives a hardware swap, because the hardware is only bound to it.

**Staff tokens.**
- The cloud mints an Ed25519 token from the cookie session, with a shift-length expiry.
- Boxes hold the public key set and a revocation list of token IDs and deactivated accounts.
- The revocation list arrives by WebSocket poke and again in every heartbeat acknowledgement.
- The argon2id unlock verifier is pushed from the cloud to that box only. It is never embedded in the browser token.
- The box therefore holds verifiers only for staff who actually used it. This also implements the brief's "seen on this box in 30 days" offline sign-in rule.
- Offline sign-in yields a box-signed token, accepted only by that box and flagged offline in every event.

**Codes.**
- Anything the cloud mints (booking QRs, staff tokens, remote commands, releases) is asymmetric. Boxes hold public keys only.
- Anything a box mints (bands, booth vouchers) uses a per-branch HMAC key with a key ID and day-derived subkeys: `K_day = HMAC(K_branch, date)`. Boxes hold 30 days ahead. A stolen box can therefore mint for one branch for a bounded period.
- Booking QRs carry the entitlement summary, so a booking made minutes before an outage can still be admitted.

**Certificates.**
- The box generates the TLS key and a certificate signing request (CSR).
- The cloud runs DNS-01 and returns the certificate.
- DNS-provider credentials never reach a box. Certificates are per box, with no shared wildcard.
- They are stored in `/data` so a re-flash does not re-issue.

**Encryption at rest.**
- `/data` is LUKS2, with the unlock key derived from the Pi 5 device key in one-time-programmable (OTP) memory.
- An escrow keyslot is sent once to the cloud and stored encrypted, so the journal of a dead board can be recovered.
- This protects a pulled NVMe, disposal and returns.
- It does not stop a skilled thief who steals the whole box unless secure boot is added.
- The real mitigation is data minimisation, plus locked enclosures and remote key revocation.

## 6. Down-sync

**Cloud side.** Triggers on every cacheable table write a row to `sync.change`:
- the row columns are `change_seq`, `xid8`, `operator_id`, `branch_id`, `scope`, `entity`, `row_id` and `op`;
- the trigger is hand-written SQL, because `updated_at` is set only by Drizzle and the importers and other modules will bypass it;
- the feed stores keys only, and the payload is read from the live table at serve time through a per-entity serializer, which is where PII minimisation lives;
- readers serve only rows with `xid < pg_snapshot_xmin(pg_current_snapshot())`. Without that guard, a cursor skips a transaction that commits late. This is the classic cursor-sync bug;
- hard deletes of `role_assignment` and `branch_holiday` become soft deletes, and a DELETE trigger writes tombstones regardless;
- the feed is retained for 60 days, and an older cursor gets `RESNAPSHOT_REQUIRED`.

**Transport.**
- The WebSocket carries pokes, heartbeats, acknowledgements and commands.
- Bulk data uses HTTPS: `GET /box/v1/sync/pull?scope=&cursor=&limit=`, gzipped. It returns rows, tombstones, the next cursor and a more-pages flag.
- Each page and its cursor commit in one SQLite transaction.
- Snapshots are prebuilt nightly as NDJSON.gz in object storage and fetched by presigned URL with range resume, which matters on capped SIMs.

**Scopes.** The box role decides which scopes it gets.

| Scope | Content | Who | Size |
|---|---|---|---|
| config | stations, device assignments, print templates, payment routing, receipt config, offline cap, all branch stations for re-homing, target version | every box | KB |
| keys | token public keys, booking public key, band day-keys, revoked key IDs | every box | KB |
| catalog | packages, tiers, holidays, tax, products, modifiers, discounts, promotions, payment methods, supervision and drop-off policy | counter, kiosk | under 5 MB |
| staff | all operator accounts (id, name, status), roles, role permissions, assignments, overrides, module switches, PIN and badge hashes; no passwords | every box | under 1 MB |
| members | active set: activity in 24 months, or a wallet balance, or an upcoming booking. Minimal fields plus children with allergy and medical data, and standing pickup persons | counter, kiosk only | about 150k members, roughly 150–200 MB on disk and 40–60 MB gzipped |
| bookings | branch, dates from today minus 1 to today plus 7, with attendees and registrations | counter, kiosk | hundreds of rows |
| bands | valid today, plus the deny list of voided and replaced bands | counter, gate | thousands |
| wallets | active today, with the projected balance as of the cursor | F&B and counter | thousands |
| supervision | today's registrations, check-ins and pickup lists | supervision box | hundreds |

- The gate and booth boxes get no member PII. The booth stores an HMAC of the phone number for the one-spin rule.

**Scope membership.**
- *Time windows.* The box requests by window and rolls the window at 04:00.
- *Members.* The triggers "touch" the member on each new visit or booking, so the member enters the feed. The box purges stale members locally.
- *Cache misses.* A miss while online is a read-through to the cloud. A miss offline means "create the member, merge later". The merge rule makes the cache a convenience, not a correctness requirement.

**Revocations.**
- A poke triggers an immediate pull, giving under 2 seconds when online.
- The revocation list also rides in every heartbeat acknowledgement.
- Offline, the bound is the token expiry. That accepted risk should be stated to the owner.

## 7. Up-sync

**Envelope.** Each event carries:
- `eventId`, a UUIDv7 minted on the box;
- `boxId`;
- `boxSeq`, gapless per box;
- `prevHash`;
- `stationId`;
- `type` and `schemaVersion`;
- `occurredAt`;
- `clock {ntpSynced, offsetMs, bootId, monotonicMs}`;
- `actor {accountId, tokenJti, authMethod}`;
- `catalogCursor`;
- `payload`;
- `sig`, an Ed25519 signature.

Events are self-authenticating. A replacement box, a recovered disk or an iPad courier copy can deliver them.

**Ordering.**
- Order is strict per box by `boxSeq`. Gaps are detected and raise an alert.
- There is no cross-box order, so projectors must commute across boxes.
- References to entities another box may have minted are soft: there is no foreign key on `band_id` in passages, for example. A nightly report lists dangling references.

**Ingest.**
- Batches go to `POST /box/v1/sync/push`: 100 or fewer events, one batch in flight per box.
- There is one Postgres transaction per event.
  - `INSERT INTO sync.event ... ON CONFLICT DO NOTHING`. The ledger is permanent, partitioned monthly, and unique on `event_id` and on `(box_id, box_seq)`.
  - If the row was inserted, the projector runs in the same transaction, along with the audit row carrying `occurred_at`, `origin`, the station and `source_event_id`.
  - Entity rows use their box-minted primary keys with ON CONFLICT as a second guard.
- The acknowledgement returns `appliedThrough`, the quarantined items and a `branchConverged` flag.

**Poison events.**
- An event that fails parsing, signature or upcasting goes to `sync.quarantine` with its raw bytes, and an alert is raised.
- It is acknowledged as quarantined, so the queue moves on with no head-of-line blocking.
- The box keeps it until the cloud marks it resolved. "Replay quarantine" runs after a fix.

**Backpressure.**
- Volumes are small: about 1,500 to 3,000 events per box per day.
- The server can return `retryAfterMs`, and reconnects are jittered.
- Telemetry, logs and raw EDC bytes are not in the event log. They travel on a separate lossy lane.
- A box treats wallets as online only when its own outbox is empty and the cloud reports the branch converged. Otherwise the cached balances are stale.

**Retention.** Acknowledged events are kept 30 days. Unacknowledged events are never pruned.

**Versioning.**
- Events are forever. The cloud keeps an upcaster for every version ever emitted.
- The cloud always deploys first, and a box never runs ahead of the advertised maximum.
- A box below the minimum supported version is marked "update required" but still sells and still pushes. A counter is never bricked.

## 8. Conflict rules

- **Sales, payments, bands, passages, releases, spins, vouchers and cash movements** are immutable facts. Corrections are new events that reference the original.
- **Member with the same phone** created at two counters:
  - The first ingested survives. The loser goes into `member_alias`.
  - Projectors resolve member IDs through the alias table.
  - The loser's fields fill blanks only.
  - Children are deduplicated by name plus date of birth; otherwise both are kept and an anomaly is raised.
  - An alias tombstone is sent down to every box.
  - The same mechanism serves the production-dump deduplication (SCRUM-12).
- **Child edited in two places.** The rule is field-level last-writer-wins by `occurredAt`, except the safety fields.
  - `medicalAlert` is OR-merged. It can only be cleared online and explicitly.
  - Conflicting allergy or medical text keeps the latest value, shows both versions and raises a high-severity anomaly. Nothing is dropped silently.
- **Pickup persons** are an add-wins set. A release to a person who was disabled elsewhere stands as a fact and raises a critical anomaly.
- **Wallet.**
  - The ledger is the truth, and the balance is a projection.
  - Online spend is an atomic cloud authorisation.
  - Offline spend is allowed up to `min(cached balance − local pending, daily offline cap)`.
  - Overdrafts are recorded, never rejected.
  - The wallet is its own entity, with band and voucher-QR lookup keys as in the prototype, so it survives a band replacement.
- **Occupancy** is a projection of passage events. The gate box is authoritative for anti-passback. Tills show the cloud value, or "stale since" a given time. A manual adjustment is an audited event.
- **Single-use redemption and spins.**
  - Online, the cloud redeems atomically and the first redemption wins.
  - Offline, only the local log is checked.
  - Cross-box doubles are flagged at ingest, and both facts stand.
- **Catalog, staff and config** are cloud-authoritative and flow one way down.
  - A sale records its `catalogCursor`.
  - The cloud re-runs `computeTotals` and flags a mismatch. It never rejects or recomputes.
- **Receipt numbers** are allocated in the same SQLite transaction as the sale event, gapless per station series. A new series starts for each box incarnation, pending the accountant's answer.

## 9. Updates and version skew

Updates run on two tiers.

- **Application, frequent.**
  - A release is a signed tarball: the bundle, arm64 native modules and a pinned Node.
  - It is unpacked into `/data/agent/releases/<v>`.
  - The updater verifies the Ed25519 signature against a key baked into the image, then runs a preflight: a journal migration on a copy, plus a simulator self-test.
  - The symlink swaps only when the box is idle. Idle means no open sale or EDC transaction, inside the default 03:00–06:00 window.
  - A 120-second health check follows. On failure the box rolls back automatically and reports it.
  - Journal migrations are expand-only, so the previous version still runs.
- **OS image, rare.**
  - Lay out `boot / rootA / rootB / data` now, for `tryboot` A/B updates later.
  - In practice, update the OS by rotating the standby: re-image the standby at the bench, promote it, and re-image the box it replaced.
- **Release channels** are canary (the staging virtual box plus the standby), early (one counter box) and stable.
  - Never update two counter boxes of a branch in one window.
  - Auto-pause the rollout on any rollback.
- **No Docker.** On a single-process device it adds a daemon, friction with USB and serial devices, and large images over cellular, for no benefit.

## 10. Spare swap, remote commands and observability

**Spare swap.**
- Keep the spare warm: powered and enrolled as `standby`, with its scopes synced and no stations.
- "Replace box" in the admin console revokes the dead key from a timestamp and binds the standby to the slot.
- The agent applies the slot's static IP, so there is no router change and no MAC reservation to edit.
- The cloud-brokered certificate takes about 60 seconds to issue, and the config is pushed. Total recovery is about 2 minutes.
- If a surviving box must take over a station, LAN printers keep working. Only USB devices need re-plugging.
- A swap needs internet. The offline fallback is station takeover on the surviving box, using the cached branch config and an admin token.

**Remote commands.**
- Commands carry a command ID, type, arguments, issuer and an expiry of 60 seconds or less.
- The cloud signs them and persists them with a status. The box deduplicates them and runs them at most once.
- An expired command never runs late.
- The allow-list is test print, identify, pull now, resnapshot, collect logs, update now, restart agent and reboot.
- Gate release and drawer open are never remote. There is no remote shell in v1.

**Heartbeat.** Every 60 seconds the box reports:
- versions;
- clock quality;
- outbox depth and the age of the oldest unacknowledged event;
- cursors per scope;
- disk and NVMe wear;
- `vcgencmd get_throttled`, which detects under-voltage;
- per-device reachability and paper status;
- station leases;
- certificate expiry.

The cloud stores the latest status plus state transitions, not every sample.

**Alerts.** The cloud raises alerts on:
- box offline during opening hours;
- a stuck outbox;
- an unsynced clock;
- paper out;
- a non-empty quarantine;
- critical anomalies;
- vouchers printing with nobody signed in.

**Logs.**
- Logs are pino JSON with PII redaction.
- They are batched to object storage, not Postgres, within a daily byte budget.
- Correlation IDs flow from the iPad to the box to the cloud.