## 0. Position

The compute problem is trivial and the operational problem is not, so the cloud is kept deliberately boring. The engineering effort goes into four things:
- an event pipeline that survives partition, duplication, reordering, clock skew and a cloud restore;
- a compatibility policy across the cloud API, the PWA and the box agent;
- a fleet that can be imaged, updated, observed and recovered by someone who is not on site;
- a test harness that proves the first two before any hardware exists.

## 1. Render topology

| Service | Render type | Purpose |
|---|---|---|
| `oto-api` | Web service, 1 CPU / 2 GB, Singapore, one instance to start | REST, public and webhook routes, box WebSocket gateway, in-process jobs, and the static bundles for the launcher and staff apps |
| `oto-db` | Managed Postgres 16, PITR on | System of record. One database, one Postgres schema per module |
| `oto-backup` | Cron job | Nightly encrypted `pg_dump` to a bucket outside Render. This is the one sanctioned extra database connection |
| `oto-sim-fleet` (staging only) | Web service | Two or three box agents running device simulators, always on, for demos and Playwright |
| `book.otoplay.co`, `www.otoplay.co` | Static sites | Public booking and marketing. Separate origins, never given the session cookie |
| Object storage | S3-compatible bucket outside Render (Cloudflare R2, or S3 in ap-southeast-1 because the client already has AWS) | Files, OTA artifacts, on-demand log bundles, audit archives, database dumps |

**One origin.** The launcher is mounted at `/`, the POS at `/pos/`, the admin console at `/admin/`, and later modules at `/hr/`, `/ops/` and so on. All are served by Fastify with `@fastify/static`, using immutable cache headers on hashed assets.
- The existing host-only `oto_session` cookie then is single sign-on with no change to `apps/api/src/plugins/session.ts`.
- `apps/pos/vite.config.ts` already honours `BASE_PATH`.
- API and frontends deploy atomically, which removes one axis of version skew.
- Static bytes are negligible: about 20 staff, and the PWA is precached by a service worker. Cloudflare can go in front later if needed.
- I reject a `Domain=.otoplay.co` cookie. It would be sent to the marketing site and to every `*.central.otoplay.co` box hostname.
- The launcher must not register a root-scope service worker. The POS worker is scoped to `/pos/`.

**Process roles.** A `PROCESS_ROLES=api,ws,jobs` environment variable decides which parts `buildApp` starts. Today all three run in one process. That is the only honest way to satisfy the brief's "one pool" rule on Render, where a separate worker is necessarily a separate pool. When jobs need isolation, a second service starts with `PROCESS_ROLES=jobs` and a pool of 3. That is a config change, not a rewrite.

**WebSocket gateway: no sticky sessions and no state that matters.**
- The socket does three things only: it authenticates the box with its device key, carries heartbeats, and delivers pokes and commands ("new config version", "pull changes", "test print", "revoke", "update available").
- All data moves over HTTPS. `POST /sync/push` takes idempotent event batches. `GET /sync/pull?cursor=` returns changes. HTTP request and response gives acknowledgement, retry and observability for free. Hand-rolled acknowledgement semantics over WebSocket are where sync bugs live.
- Commands are rows in a `box_command` table, and the instance holding the socket delivers them. With two or more instances, one dedicated `LISTEN` connection per instance fans out through `NOTIFY`. This is designed in now and costs nothing at one instance.
- A deploy drops every socket. Boxes reconnect with jittered exponential backoff. Forty boxes reconnecting is not a storm.
- The agent pings every 30 s, because cellular CGNAT idles out quiet TCP flows. The full heartbeat goes every 60 s.

**Fixes to make before first deploy**
- `apps/api/src/index.ts` has no SIGTERM handling. It should close sockets with code 1012, drain HTTP, then end the pool. It reads `API_PORT`, but Render supplies `PORT`.
- `apps/api/src/app.ts` needs `trustProxy`, `@fastify/rate-limit` on `/auth` and `/public`, an Origin check on cookie-authenticated mutations, and security headers.
- Render's health check should point at `/health`, not `/ready` (`apps/api/src/routes/health.ts`). Otherwise a database blip restarts the API and drops every box socket. `/ready` is for the external uptime monitor.
- `apps/api/src/env.ts` resolves `.env` relative to the source file, which breaks once the API is bundled. In production it should refuse to boot when `COOKIE_SECURE=false` or when the default MinIO credentials are present.

## 2. Postgres sizing and the single pool

**Volume estimate for two branches** (my estimate, to be checked against the production dump):
- 500 to 1,500 sales per day.
- A few thousand passage events per day.
- 10,000 to 20,000 audit rows per day.
- Under 20 GB in year one.

The brief's 1 CPU / 2 GB tier is adequate for steady state. The risks are bursts: migration trial runs (do them on a local restore, as the brief already says), nightly rollups, and a box's first cache bootstrap.

**Pool configuration.** `packages/db/src/index.ts` creates `new pg.Pool({ connectionString })` with no settings at all. Set:
- `max: 10`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 5000`, and an `application_name`;
- at role level, `statement_timeout = 15s` and `idle_in_transaction_session_timeout = 30s`, with job-specific overrides.

**Connection budget:**

| Consumer | Connections |
|---|---|
| API pool | 10 |
| `LISTEN` connection | 1 |
| Backup cron | 1 |
| Migrations | 1 |
| Humans | 2 |

**Rule that matters once transactions exist:** never do network I/O (2C2P, SMS, LINE) inside a database transaction. Write an outbox row in the transaction and let a job send it. Ten connections held across a slow PSP call is how this API will fall over.

**Job runner.** Use graphile-worker, or pg-boss with its `db` adapter, on the shared pool. Each module declares its jobs in its manifest. Housekeeping jobs are needed immediately: expired `session`, `idempotency_key` and `verification_code` rows are never cleaned today.

## 3. Audit log and other append-only tables

**Partition `audit_log` by month now**, while it is nearly empty. It costs about a day. Details that bite:
- The partition key is server-recorded time (`created_at`, which becomes `recorded_at`), never the box's `occurred_at`. A Pi with a dead RTC would otherwise scatter rows into 1970.
- A unique index on a partitioned table must include the partition key, so `UNIQUE(source_event_id)` cannot dedupe replays globally. Dedupe in the non-partitioned `sync_event` ledger instead (primary key `event_id`, plus unique `(box_id, box_seq)`). Write audit rows in the same transaction as the ledger insert.
- Drizzle Kit models neither partitions nor triggers. These are hand-written SQL migrations. Exclude the affected tables from the generator's diff, or it will try to "repair" them.
- A monthly job creates partitions three months ahead. A DEFAULT partition catches mistakes, and an alert fires if it ever receives rows.

**Retention.** "Archive after twelve months" is wrong for financial and child-release audit. Thai accounting retention is commonly five years or more. Export cold partitions to object storage as compressed NDJSON, keep them there, and detach from Postgres after 18 to 24 months.

The same append-only pattern applies to `passage_event`, `box_heartbeat` (sampled, 14 to 30 days) and `box_metric_5m`. Raw EDC bytes stay on the box for 30 days. They are uploaded automatically only for unknown-outcome transactions, and otherwise on demand.

## 4. Nightly rollups

An `analytics` schema owns no source data. It holds rollup tables, not materialized views, because `REFRESH` recomputes everything and takes locks. The tables are:
- daily sales by branch, package and tier;
- daily payments by method and terminal;
- hourly occupancy;
- daily wallet liability;
- booth statistics;
- labour hours.

Rollups are computed at about 02:30 Bangkok time per branch business day, as an idempotent upsert keyed by `(branch, business_date)`.

**Late events.** An offline box can deliver yesterday's sales tomorrow. The ingest therefore writes `analytics.dirty_day(branch_id, business_date)` whenever an event lands in a closed day, and the job recomputes dirty days. Reports show "includes N late-synced events".

Oto Radar's "today" tiles read narrow indexed OLTP queries. History reads rollups. Omni Analytics and Radar become consumers of `analytics.*` and nothing else. A read replica comes only after this is shown to be insufficient, as the brief says.

## 5. Backups, PITR and DR

- **PITR on Render, plus a nightly encrypted logical dump to a bucket in a different account.** PITR does not protect against account compromise or an accidentally deleted database. Keep 35 daily and 12 monthly dumps.
- **The boxes are the HA.** If the cloud is down for two hours, the park keeps selling. This is why "no HA" is a sound decision.
- **A restore must not lose acknowledged events.** After PITR to time T, boxes have already discarded events acknowledged after T. The design closes this gap:
  - every box event carries a monotonic `box_seq` that persists across reboots;
  - the cloud stores `box.last_acked_seq` and states it in the sync handshake;
  - boxes mark events acknowledged but keep them for 14 days;
  - if the cloud's cursor is behind the box's, the box replays from the cloud's cursor.
  The restore then heals itself, and the re-ingest is a no-op wherever data survived.
- **Quarterly drill.** Restore to a new instance, run the reconciliation script (row counts, money sums, last sequence per box), point staging at it, and record the time taken. Targets: RPO under 5 minutes, RTO under 2 hours.
- **Box recovery.**
  - The outbox is its own SQLite file, in WAL mode with `synchronous=FULL`.
  - A corrupt cache is rebuilt automatically.
  - A corrupt outbox is quarantined and alerted. It is never discarded.
  - The primary recovery for a dead Pi board is moving its NVMe into the spare. The same image means the identity and the queue travel with the drive.

## 6. Environments

- **Local:** docker-compose (Postgres and MinIO, as today), plus `apps/box-agent` with `DEVICES=sim` on a SQLite file, plus a simulator console page for scripting device faults.
- **CI:** ephemeral Postgres and MinIO services.
- **Staging (Render):**
  - its own database, bucket and keys;
  - 2C2P sandbox, console or allow-listed SMS;
  - the always-on simulated fleet, so the client can exercise full flows with no hardware;
  - data is synthetic or an anonymised restore, never the raw production dump.
- **Bench:** one or two real Pi 5 units with real printers and scanner, pointed at staging. This is the hardware-in-the-loop target and the OTA canary.
- **Production:** separate Render project, secrets and signing keys.

## 7. CI/CD, the Pi image and agent OTA

**Pipeline.** Today `.github/workflows/oto-platform-ci.yml` is one job. It should become:
1. Verify: typecheck, lint including `apps/pos` (currently excluded), unit tests, gitleaks.
2. API integration, with a MinIO service so the files tests stop self-skipping.
3. Sync convergence: fixed seeds on every pull request, a long random-seed run nightly.
4. Contract diff on the OpenAPI output and event fixtures. A breaking change requires a contract version bump.
5. Playwright with WebKit at iPad viewport plus Chromium. The current config is pinned to `msedge`.
6. Bundles: API, frontends, and the agent for linux-arm64.
7. Render deploy, with migrations as the pre-deploy command.

Migrations follow expand-then-contract, because old PWAs and old boxes outlive any deploy.

**Agent artifact.** No Docker on the box. Ship a signed tarball in two layers:
- a runtime layer (pinned Node plus the native modules `better-sqlite3`, `serialport` and argon2) of roughly 40 to 60 MB, which changes rarely;
- an app layer (one esbuild bundle) of a few MB, which changes every release.

Routine OTA over cellular is then about 3 MB per box, not 50.

**Install and rollback**
- Releases land in `/data/agent/releases/<version>/` with a `current` symlink.
- A tiny, rarely-updated updater unit verifies the signature against a root public key baked into the image, switches the symlink, and restarts the agent.
- The agent must report healthy and complete a sync handshake within 120 s, or the updater rolls back.
- SQLite migrations are additive only, so rolling back one version is always safe.

**Image.** Built in CI with pi-gen or rpi-image-gen on an arm64 runner, to a versioned `.img.xz` with checksum and package manifest. Contents: 64-bit Raspberry Pi OS Lite, overlay read-only root, `/data` partition, chrony, nftables, watchdog (systemd plus agent `sd_notify`), the updater, and the agent runtime.

**Enrolment**
- The box generates its own Ed25519 device key on first boot.
- A technician enrols it on the bench through an admin session, recording the serial number, public key, assigned branch and role.
- The spare is enrolled with no role and promoted when swapped in.

**No A/B OS OTA in Sprint 2.** With fewer than ten boxes, OS updates are a quarterly re-image of the spare, rotated through the fleet. Emergency patches use a signed maintenance script. Adopt RAUC or Mender at around 40 boxes.

**Staged rollout.** Channels are `dev`, `canary`, `stable`. Each box has a channel and an optional pinned version.
1. The staging fleet updates automatically.
2. The bench Pi runs hardware-in-the-loop smoke tests.
3. One production canary (the booth, or the quieter branch's second counter) runs for 48 hours.
4. The rest follow, one branch at a time, never the two DNS-serving boxes together.
5. Rollout halts automatically on crash loops, sync lag or an error-rate rise.

The update window cannot be assumed to be "night", because boxes without a UPS may be switched off overnight. Update at first boot of the day before anyone signs in, or when no station session has been open for ten minutes.

**Compatibility policy**
- The box advertises the contract range it supports in every heartbeat.
- The PWA supports contract N and N-1.
- A PWA build that needs N+1 is not deployed until every box in that branch reports N+1.
- The outbox event envelope is compatible forever. Events are facts. The cloud keeps upcasters, and every historical event version has a fixture that must still ingest. A spare that sat in a drawer for six months must still sync its queue.

## 8. Fleet management and alerting

**Tables**
- `box`:
  - identity: serial, public key, role, hostname, LAN address, revocation;
  - versions: channel, desired and reported agent version, image version, desired and applied config version;
  - state: last status, `last_acked_seq`.
- `box_heartbeat`
- `box_command`
- `box_release`
- `alert_rule`, `alert`, `alert_delivery`

**Heartbeat contents**
- System: agent version, uptime, SoC temperature, `get_throttled` under-voltage flags, disk free, NVMe wear, clock offset against the cloud.
- Sync: queue depth, oldest queued item's age, last sync.
- Peripherals and network: printer reachability and paper status, USB devices present, certificate days remaining.
- Station: whether a staff session is active. The booth's "printing with nobody signed in" alert depends on this.

Send full status on change and a tiny alive frame otherwise.

**Rules**, evaluated each minute by a job and aware of branch opening hours:
- box offline for 3 minutes;
- queued item older than 15 minutes while online;
- paper out, printer unreachable, or EDC missing;
- certificate under 21 days;
- clock offset over 60 s;
- disk over 80 %, under-voltage, or a crash loop;
- a failed update, or version drift over 7 days.

Flapping is suppressed.

**Channels**
- LINE Messaging API push to an operations group. LINE Notify was shut down in March 2025, so it cannot be used.
- Email.
- A banner in the launcher and Radar.
- Sentry for developers.
- The till's own header status chips, which are the fastest channel on site.
- An external uptime monitor on `/ready`, because the alerting runs inside the thing it monitors.

## 9. Logs and metrics on metered cellular

**Target: under about 20 MB per box per month of telemetry.**
- Logs stay on the box: journald to a capped, compressed ring on `/data`. They are never streamed.
- Shipped routinely: delta heartbeats, five-minute metric aggregates carried on the heartbeat, and deduplicated error fingerprints with counts.
- Logs are pulled on demand. An admin requests "last 2 hours", and the box uploads a compressed bundle to a presigned URL.
- No Prometheus, Loki or Grafana. Postgres and a Fleet page are enough at this scale. Cloud logs drain from Render to a hosted log service for retention.

**The bigger cellular costs are not telemetry:**
- PWA redeploys reaching every iPad. Use deploy windows during stabilisation.
- The first member-cache bootstrap. Do it on the bench before shipping, and scope the cache.
- iOS updates over park Wi-Fi. Defer them by MDM, or block Apple's update hosts on the router.

## 10. Secrets and key rotation

**Staff tokens.** Ed25519. The private key is cloud-only, and boxes hold the JWKS. The rotation rule: a new key becomes active only after every non-revoked box has acknowledged a JWKS version containing it, or after 14 days.

**Private key storage.** Keep private keys envelope-encrypted in a `signing_key` table under a master key held in the Render environment. A database dump or restore alone does not leak them, and the staging scrub removes the table.

**Booking QRs** are issued only by the cloud, so they should be Ed25519-signed by the cloud. Boxes need only the public key. **Vouchers** are printed on 80 mm paper where code length is free, so sign them with the booth box's own device key, certified by the cloud.

**Wristbands** are the one case where a short code matters, because a QR on a narrow curved band is hard to scan. Keep HMAC here, with these limits:
- scope the key per branch and rotate it monthly with overlap;
- use a tag of at least 80 bits;
- distribute it only to counter, gate and kiosk roles, never to booths.

A forged band is worth one day's admission and is caught by occupancy reconciliation. A forged voucher or booking is not so bounded.

**Certificates.** Do not put a DNS API token on every Pi. The box generates a keypair and CSR. The cloud runs ACME DNS-01 with the token it alone holds and returns the certificate. This removes the custom Caddy build from the image. Renew at two-thirds of lifetime. Let's Encrypt has announced shorter lifetimes (45 days by 2028, as I recall; verify), so the brief's 90-day comfort margin will shrink.

**Third-party secrets** (2C2P, Twilio, LINE, Meta) live in per-environment Render secret groups. The release-signing key lives in CI, with an offline root that can rotate it.

**Ownership.** Every account must be client-owned, with a documented break-glass procedure: Render, GitHub, the DNS registrar, 2C2P, the LINE OA and Apple. The project currently has a bus factor of one.

## 11. Security posture of boxes on a mall LAN

**Network**
- Staff devices and any guest Wi-Fi never share layer 2.
- Printers on port 9100 have no authentication. Anyone on the staff LAN could print, or fire the cash drawer through the receipt printer. Put printers on a wired segment reachable only from boxes, enforced by router ACL. iPads never need to reach a printer.

**Box**
- nftables default-drop inbound, except 443 from the staff subnet, plus 53 where the box serves DNS.
- No SSH listener. Remote support is a time-boxed, audited, outbound tunnel (Tailscale with key expiry), opened by a signed command and off by default. Hardware bring-up from another country is impossible without it.
- LUKS on `/data`, with the key held in the Pi's OTP. This stops the realistic threat of someone pulling the NVMe. Secure boot comes later.
- Boxes sit in locked enclosures.
- PIN attempt counters are persisted on the box.

**Minimise what is on the box.** Cache members seen at this branch recently, plus those with active bookings or wallets, not the operator's whole member base. Booths cache no members. Children's names, allergy notes and pickup lists on a stolen Pi are a notifiable PDPA breach.

**Booth.** Treat the mall network as hostile.
- Use a USB printer, or an isolated travel router.
- Run a kiosk compositor with VT switching disabled.
- Add a udev allow-list for the dome button's VID and PID, so a passer-by's keyboard does nothing.

**iPad to box.** Bearer staff token, a CORS allow-list for `https://app.otoplay.co`, and a station lease. Desktop Chrome on the LAN will need the local-network permission path. Verify iPad Safari behaviour on a real device.

**Cloud.** Webhook signatures verified for 2C2P, LINE and Meta. Every Replit import is scanned for committed secrets before it enters the repo.

## 12. Testing strategy

**Simulators at two levels**
- Interface-level simulators with scriptable fault plans for application flows.
- Wire-level emulators that speak real LinkPOS XML, Digio BER-TLV and the GE-X2 gate protocol, so the real adapters' framing and checksum code is exercised.
- Put serial behind a `Transport` interface with a TCP implementation, so the emulators run on Windows and in CI. The developer machine is Windows, and pty tricks will not work there.
- Bytes captured during bring-up become regression fixtures. The brief already requires logging every raw byte.

**Scripted faults per device**

| Device | Faults |
|---|---|
| Printer simulator | Parses ESC/POS and TSPL into a render for snapshot tests and admin preview; simulates paper-out, offline and slow |
| 2C2P simulator | Token, payment, status and inquiry endpoints plus a webhook emitter; webhook lost, duplicated, arriving early, stuck pending, paid after expiry |
| Gate | Normal pass, timeout, tailgate, wrong direction, fire hold-open |

**One contract suite, two servers.** `packages/contracts` (zod) defines the station-facing API. The same black-box suite runs against `buildApp` (cloud) and `buildAgent` (box). That is how "the app must not care which" is enforced.

**Sync convergence harness** (the most valuable test asset).
- Setup:
  - one in-process cloud on embedded Postgres;
  - N agents on in-memory SQLite;
  - a fake network with a cut, latency, drop, duplicate, reorder and mid-batch truncation per link;
  - a fake clock per node (skew of days, backwards jumps, RTC reset).
- Random command sequences, generated with fast-check:
  - the same phone created at two boxes;
  - sales, bands and gate passes;
  - wallet spend at two offline boxes;
  - double redemption;
  - child release;
  - staff deactivated mid-partition;
  - a box crash between commit and ack;
  - a cloud crash between commit and ack;
  - a cloud PITR rollback;
  - an OTA with a queue in flight.
- Invariants checked after the network heals:
  - every committed event appears exactly once;
  - money sums match per box;
  - the wallet ledger equals its projection, and any overdraft is within the cap;
  - receipt numbers are unique per station;
  - same-phone members converge with all references resolved;
  - a double redemption is flagged exactly once;
  - occupancy equals entries minus exits;
  - audit rows appear exactly once with `occurred_at` preserved;
  - replaying the whole history is a no-op;
  - shuffled delivery order yields the same final state.
- Failing seeds are checked in as regression cases.

**Other tests**
- **Authorisation matrix**, generated from the module manifests (every route against every role) with a two-operator fixture always seeded. The two existing tenant leaks went unnoticed because tests only ever seed operator "OTO".
- **Playwright against the simulated box:**
  - cash sale with print assertions;
  - card sale with no final response, forcing the inquiry UI;
  - QR payment with the webhook lost, resolved by polling;
  - internet cut mid-sale, then heal;
  - customer display as a second browser context;
  - offline lock and unlock;
  - service-worker offline reload.
- **Manual real-iPad checklist** for what cannot be automated: PWA install, local-network prompt, storage eviction.
- **Hardware-in-the-loop bench, nightly and per release candidate:**
  - real printers;
  - Zebra scanner triggered against a fixed test card;
  - relay HAT looped to a GPIO to measure the pulse;
  - a second machine running the wire emulator over real USB serial, which settles the 9600 parity question.
- **Commissioning self-test.** The same routine is built into the agent as a command, and it becomes the install runbook.
- **Migration.** Deterministic id mapping through `legacy_map`; two runs must produce identical checksums. CI uses a synthetic legacy fixture.

## 13. Scalability

**Two branches.** Everything above on one API instance.

**Ten branches** (40 to 60 boxes, about 80 iPads)
- Two API instances, mainly for deploy safety. This forces the in-memory sign-in throttle in `apps/api/src/services/auth.ts` into a shared store. The `NOTIFY` fan-out is already designed in.
- A separate jobs service.
- Postgres at about 2 CPU / 8 GB.
- Scoped member caches become mandatory.
- The bottleneck becomes fleet logistics, not compute. That means:
  - a branch-in-a-box runbook and a router config template;
  - the "clone branch configuration" story (SCRUM-38);
  - MDM for iPads;
  - OS-level OTA;
  - alert routing per branch;
  - receipt and tax-invoice series per VAT-registered branch.

**Multiple operators**
- An operator-scoped repository layer, plus Postgres RLS as defence in depth. RLS needs every query inside a transaction, which the `withTx` refactor provides.
- `operator_id` denormalised onto every tenant table.
- An identity decision. `findAccountByPhone` currently ignores the operator.
- Secrets and adapter config moved from boot-time env into an encrypted per-operator table: the 2C2P merchant, LINE OA, SMS sender, box DNS zone and band keys.
- Module entitlement per operator, per-operator rate limits, data export and deletion, and sync-scope isolation proven by the authorisation matrix.

My advice is to keep the discipline (the `operator_id` column, the two-operator test fixture, an RLS-ready schema) and not build multi-operator features until someone is actually buying.

## 14. Cost outline

These figures are from memory of published pricing. Verify before budgeting.

**Monthly run-rate**

| Item | USD per month |
|---|---|
| Production API | about 25 |
| Production Postgres with PITR | about 20 to 75, depending on how Render's current plans map to "1 CPU / 2 GB" |
| Staging (API, small database, simulated fleet) | about 25 to 35 |
| Backup cron | a few dollars |
| Object storage | under 5 |
| Render workspace seat | about 19 |
| Sentry and uptime monitor | 0 to 40 |
| MDM | free to small at this device count |
| **Cloud total** | **roughly 150 to 250 at two branches; 300 to 450 at ten** |

Variable costs: SMS per message, LLM usage for Ask OTO and the AI inbox, LINE OA message quota, 2C2P fees, and two SIM plans per park.

**One-off hardware**
- About 140 to 160 per box (Pi 5, NVMe and HAT, cooler, PSU, case, RTC battery).
- A relay and serial adapter for the gate.
- A UPS at about 80 to 150 per park.
- A duplicate bench kit for the developer at about 500 to 800.

Cloud cost is not the constraint. Engineering time and on-site hands are.

## 15. Delivery assessment

- Foundation rework is roughly 12 to 17 engineer-weeks at conventional pace. That is the four maps' effort figures with their overlaps removed.
- The remaining POS scope (brief section 14, items 1 to 8) adds roughly 40 to 58 engineer-weeks.
- The suite's 58 stories add roughly 25 to 40 more if rebuilt. Several Replit apps may be UI-on-mocks, as `oto-till` was. If so, "import" means "build the backend".
- AI assistance compresses greenfield CRUD substantially. It does not compress hardware bring-up, bank and PSP onboarding, migration reconciliation or parallel run, all of which are wall-clock bound.
- Run it as one continuous effort if the owner wishes, but with gated, demoable milestones every two to four weeks. Order them as in the sequencing list.
- Start a parallel hardware-spike track in week 1.
- Deliver the launcher first, linking out to the legacy apps.
- Merge modules one at a time, and only after the POS is live.