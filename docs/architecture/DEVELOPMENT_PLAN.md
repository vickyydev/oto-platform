# Development plan — how an agent builds Sprint 2

## 0. Status and how to use this document

Status: written 2026-09-20. This is the technical companion to
`docs/progress/SPRINT_2_PLAN.md` (the ticket plan). Together they **supersede
`CLAUDE.md` §5–§10 for the duration of Sprint 2**: the scope, the execution
order, the checkpoints, the acceptance checklist and the working agreement in
those sections were written for Sprint 1 and are replaced by §4, §5 and §11
below and by the Sprint 2 plan's "Execution order and checkpoints" and
"Definition of done". **`CLAUDE.md` §3 (stack), §7 (UI rules — do not change
the prototype's design) and §8 (engineering standards) stay in force**, as does
`CONTRIBUTING.md` for commits. Where this document and the Sprint 2 plan
disagree, the Sprint 2 plan wins on *what* is built and this document wins on
*how*; where either disagrees with `docs/briefs/OWNER_DIRECTION.md`, the owner
direction wins (§2).

This document is written for an AI coding agent with no memory of previous
sessions. It carries the context, the research conclusions and the conventions
that would otherwise have to be re-derived.

How to use this document:

| If you are… | Read |
|---|---|
| Starting a session, any session | §1 resume protocol, then the ticket |
| Unsure which document decides something | §2 sources of truth and precedence |
| Needing the shape of the system you are building into | §3 target architecture |
| Choosing what to build next | §4 work order, phases and checkpoints |
| Building any ticket | §5 per-ticket build recipe (a to j) |
| Working on OTO App, Radar or the Inbox | §6 how each foreign app is lifted |
| Writing code, a migration, a log line or a test | §7 engineering conventions |
| Adding or provisioning configuration | §8 environment variable registry |
| Asking "why is it done this way / what was researched" | §9 research index |
| Blocked on a decision the owner must make | §10 open questions register |
| Finishing a ticket or the sprint | §11 definition of done |

## 1. Resume protocol

Sprint 2 runs as one continuous build, largely by AI agents, across many
sessions. Nothing may depend on a previous session's memory. The owner's
instruction (`docs/briefs/OWNER_DIRECTION.md`, 2026-09-20, "Order of work
inside the sprint" item 1) is explicit: *every function is committed as it
lands and recorded in the progress log so any new agent resumes exactly where
the last one stopped*.

### 1.1 Reading order when a session starts

Read these in order, and stop reading when you have what the ticket needs.

1. `docs/progress/STATUS.md` — where the programme stands and what is blocked
   on the owner. One minute.
2. `docs/progress/SPRINT_2_PROGRESS.md` — the **Status block** at the top:
   current checkpoint, last completed ticket, next ticket, resume
   instructions, anything half-done. This is the authoritative "where were
   we".
3. This document — §2 (precedence), §4 (where the next ticket sits in the
   order), §7 (conventions). Re-read §5 before writing code.
4. `docs/progress/SPRINT_2_PLAN.md` — the ticket itself, whole: description,
   Includes, Excludes, Acceptance criteria, QA / demo steps, Depends on. Also
   read the plan's "Design decisions this sprint locks in" once per session;
   it is the architecture §3 summarises.
5. The ticket's **feature page** in `docs/features/` (`pos.md`, `booth.md`,
   `console.md`, `oto-app.md`, `oto-radar.md`, `inbox.md`) — the status table
   that says what of that feature exists and what this ticket adds.
6. The ticket's **sources**, named on the ticket itself: the rule ids
   (`R-nn`) and conflict ids (`C-nn`) in
   `docs/architecture/POS_RULES_RECONCILIATION.md`; the prototype files the
   ticket names under `imports/oto-pos/artifacts/oto-till/src/`; and whichever
   of `DEVICE_INVENTORY.md`, `PAYMENT_GATEWAY.md`, `PLATFORM_PLAN.md` or the
   intake notes in `docs/architecture/intake-2026-09-19/` it cites.

Only after that, open code.

### 1.2 SPRINT_2_PROGRESS.md is the single record of state

`docs/progress/SPRINT_2_PROGRESS.md` is updated **first and last in every
session** — first to claim what you are about to do, last to record what
landed. It follows the Sprint 1 structure
(`docs/progress/SPRINT_1_PROGRESS.md`): a Status block, then a ticket log with
one entry per ticket or story recording what was ported and from where, what
was added per the plan, UI additions and removals, tests, and anything
deferred; then consolidated UI additions, backlog candidates, questions for
the owner and assumptions made.

A fresh session that reads only the Status block must be able to continue
without re-deriving anything. If the Status block is stale, fixing it is the
first commit of the session.

### 1.3 Checkpoint rule — commit and record every function

- **Commit when a function lands, not when a ticket lands.** Conventional
  commits per `CONTRIBUTING.md` (`type(scope): summary`, bullet body,
  `Refs: <ticket>` footer, no attribution lines of any kind). One logical
  change per commit; schema changes ship with the code that uses them.
- The ticket-log entry in `SPRINT_2_PROGRESS.md` is updated **in the same
  commit series**, not at the end of the ticket.
- Agents save their output early. When a session's job is to produce a
  document, write the skeleton with all headings and a `DRAFT` status line
  first, then fill and re-save section by section. When the job is code, land
  the migration and the failing test before the implementation, so an
  interrupted session leaves a readable state rather than nothing.
- Never leave the working tree with a half-applied migration or an
  uncommitted schema change; `pnpm db:migrate` must run twice cleanly from
  empty at every commit that touches `packages/db`.
- Never change a Jira issue's status. Evidence is posted as a comment (§5.2);
  the owner moves tickets.

### 1.4 When something is unclear — ask or decide

The rule from `CLAUDE.md` §9 step 6 stands unchanged for Sprint 2.

**Stop and ask** when:
- the prototype's behaviour contradicts the ticket;
- a ticket needs a UI element and the prototype offers no obvious home for it;
- a data shape in the prototype does not fit the schema;
- a decision would change a stored fact (a ledger column, a code format, a
  money rule) and no source settles it.

**Decide and record** for everything else. A decision is recorded as a row in
the decisions log, `docs/architecture/ARCHITECTURE.md` §10 ("Deviations &
decisions log", D1–D10 today — continue the numbering), with the date, the
decision and why. Deviations from `PROJECT_CONTEXT.md` or
`DEPLOYMENT_TOPOLOGY.md` are additionally listed in
`docs/progress/SPRINT_2_PROGRESS.md` as recorded deviations; the plan already
names two (edge and jobs inside the api service; the Pi image deferred).

If you find yourself writing a rule that exists in neither the prototype nor
the documents in §2, that is an assumption: it goes to §10 as a question and
to the progress log's "Assumptions made", not into the code.

## 2. Sources of truth and precedence

Precedence, highest first — this is the order applied throughout
`POS_RULES_RECONCILIATION.md` §0 and restated here with the Sprint 2
documents folded in:

**OWNER_DIRECTION > PROJECT_CONTEXT > (POS_BACKEND_LOGIC ≡ prototype code) >
SPRINT_2_PLAN > this document > CLAUDE.md §4 schema sketch.**

| Document | What it decides | Wins over |
|---|---|---|
| `docs/briefs/OWNER_DIRECTION.md` | Everything the owner said outside the briefs: the suite shape, the order of work inside Sprint 2, 2C2P for QR, devices via simulators, revenue = Radar's formula, prices/receipts = prototype code, one central database, the launcher | Everything |
| `docs/briefs/PROJECT_CONTEXT.md` | The target system: topology (§3), boxes (§4), iPad POS (§5), network (§6), devices and adapters (§7.1–7.6), offline model (§8), hosting (§9), business rules gathered since the plan (§10), the booth (§11), what is not built (§13), execution shape (§14) | Everything but OWNER_DIRECTION |
| `docs/briefs/POS_BACKEND_LOGIC.md` | The previous developer's explanation of the prototype's rules (v3.0). Ranks **equal with the prototype code**; where they differ the code wins | SPRINT_2_PLAN and below |
| The prototype, `imports/oto-pos/artifacts/oto-till/src/` | Approved behaviour and approved design. `mockApi.ts`, `lib/*`, `store/catalogStore.ts`, `types.ts` are the business-logic source; the components are the design source (`CLAUDE.md` §7: do not change the design) | SPRINT_2_PLAN and below |
| `docs/architecture/POS_RULES_RECONCILIATION.md` | The reconciliation itself: rule ids **R-01..R-119** (the numbered rules, ✔ = already built in Sprint 1) and conflict ids **C1..C20** (where two sources disagreed and which won). Cite `R-nn`/`C-nn` instead of re-deriving; §3 lists the schema deltas it implies; §4 lists the questions it raises | Any re-derivation |
| `docs/progress/SPRINT_2_PLAN.md` | Sprint 2 scope: the nineteen tickets, their Includes/Excludes/acceptance/QA, "Design decisions this sprint locks in", the execution order, CP1–CP7, Open decisions, definition of done | This document on *what* |
| `docs/architecture/DEVELOPMENT_PLAN.md` (this file) | *How* an agent builds it: resume protocol, architecture summary, per-ticket recipe, conventions, env registry, research conclusions | Nothing above it |
| `docs/architecture/PLATFORM_PLAN.md` | The suite-level plan: app inventory, central-database strategy, foreign-app schemas, analytics continuity, box/sync design, §14 owner questions | Design questions the Sprint 2 plan does not answer |
| `docs/architecture/DEPLOYMENT_TOPOLOGY.md` | The deployable split and the hard requirement that one app's deploy never takes the others down. Sprint 2 deviates for staging (edge + jobs inside the api service) and records it | Deployment questions, subject to the recorded deviations |
| `docs/architecture/ARCHITECTURE.md` | Sprint 1 decisions restated, the verified prototype layout, the entity diagram, the idempotency pattern, and **the decisions log (§10, D1–D10)** where every new decision is appended | Memory |
| `docs/architecture/DEVICE_INVENTORY.md` | The park's real devices, addresses, protocols, values and "confirm on site" items; what each simulator must reproduce | Any guess about a device |
| `docs/architecture/PAYMENT_GATEWAY.md` | The 2C2P integration: endpoints, envelope, response codes, credential checklist, `PGW_*` names | Any guess about payments |
| `docs/architecture/EXISTING_SYSTEMS.md` | What the park actually runs today (verified 2026-09-19) | Assumptions about the legacy estate |
| `docs/architecture/intake-2026-09-19/*` | The eight intake notes on the exported apps, including the OTO App re-hosting work list (`01-oto-app-backend.md` §10) and the Radar work list (`05-radar-api-auth-env-schema.md` §9) | Any guess about a foreign app |
| `docs/briefs/AGENCY_PROPOSAL.md` | **Contract scope, not design.** §6 is our reading of what the delivery proposal shows as not yet built; §7 are the proposal's own open questions. It tells you *what is owed*, never *how to build it* — and the owner must confirm the §6 list before S2-17c starts (Open decision 30) | Nothing; it is an input to scope, mapped to tickets in the plan's "Contract coverage" table |
| `docs/features/*.md` | Per-feature status: what exists, what the ticket adds, where the code lives | Stale assumptions about progress |
| `CLAUDE.md` | §3 stack, §7 UI rules, §8 engineering standards — still binding. §4's schema sketch is superseded wherever the prototype's shapes differ (ARCHITECTURE D1, D3). §5–§10 are superseded for Sprint 2 by §0 above | Nothing in Sprint 2 scope |
| `CONTRIBUTING.md` | Commit format, branch rules, what is never committed | `CLAUDE.md` §8's commit rule |

Two standing reminders:

- `imports/` is read-only reference input. It is never built, deployed or
  committed (`CONTRIBUTING.md`, "What is never committed").
- The prototype is the primary source of business logic. Before implementing
  a rule, look for it in `imports/oto-pos/artifacts/oto-till/src/` and port it
  with its edge cases, citing the file in the progress log.

## 3. Target architecture at the end of Sprint 2

This section summarises what `docs/progress/SPRINT_2_PLAN.md` ("Design
decisions this sprint locks in") fixes. Read that section once per session;
this is the map, not a replacement.

### 3.1 Deployables on Render

All of it is one repository, one database, many small deployables — the
owner's hard requirement is that the whole system never goes down at once and
that deploying one app does not affect the others
(`docs/briefs/OWNER_DIRECTION.md` 2026-09-19, "How we build";
`docs/architecture/DEPLOYMENT_TOPOLOGY.md`).

```
                             Render, Singapore region
 ┌──────────── static sites — each with a rewrite  /api/*  →  api service ────────────┐
 │  apps/launcher      the brand's front door, sign-in, app tiles        (S2-02)      │
 │  apps/pos           till + /display route (PWA)                       (S2-01c/08)  │
 │  apps/console       Devices, Activity, Failures, Health, Integrations,             │
 │                     Booths — "the fifth app"                          (S2-03)      │
 │  apps/booth         Lucky Wheel on the booth TV                       (S2-07a)     │
 │  apps/inbox         read-only mockup shell                            (S2-19)      │
 └──────────────────────────────────┬─────────────────────────────────────────────────┘
             same-origin /api  ·  session cookie stays httpOnly SameSite=Lax
                                    │            signed hand-off token per app origin
                                    ▼
 ┌──────────────────────────── web service:  api ─────────────────────────────────────┐
 │  apps/api — Fastify 5 + zod + Drizzle,  numInstances: 1,  health check /ready      │
 │  PROCESS_ROLES=api,edge,jobs                                                       │
 │    api    routes (zod + permission option + OpenAPI) → services (withTx + audit    │
 │           + idempotency)                                                           │
 │    edge   packages/box-agent running as the cloud "virtual box" (Store = edge      │
 │           schema), /ws/station/:id, /box/v1/*                                      │
 │    jobs   pg-boss runner under advisory locks: watchdog, rollups, housekeeping     │
 └───────┬──────────────────────────────────────────────┬─────────────────────────────┘
         │ hand-off exchange, back-channel revoke        │
         ▼                                               ▼
 ┌──────────────────────────────┐   ┌──── managed PostgreSQL 16, PITR on ─────────────┐
 │ Docker web service: oto-app  │   │  core  crm  pos  promo  booth  analytics  edge  │
 │   imports/oto-app Dockerfile │──▶│  otoapp    radar    inbox    pgboss             │
 │   health /api/status (S2-17) │   └─────────────────────────────────────────────────┘
 │ Docker web service: radar    │
 │   health /healthz  (S2-18)   │   ┌── object storage (S3-compatible; MinIO locally) ┐
 └──────────────────────────────┘   │  platform bucket: file_object + OTO App media   │
                                    └─────────────────────────────────────────────────┘

 render.yaml also carries a commented-out  worker  service: the target split for
 PROCESS_ROLES=jobs (and a separate edge service) before production go-live.

 Later, on site: Raspberry Pi 5 boxes replace the virtual box. The agent code is
 the same; only the Store implementation (SQLite) and the physical device links
 change.
```

Recorded staging deviations from `DEPLOYMENT_TOPOLOGY.md`, both listed in
`SPRINT_2_PROGRESS.md` and both reversible by configuration: edge and jobs run
inside the single api web service (`PROCESS_ROLES` is the switch), and the Pi
image is deferred until a Pi 5 is on hand.

Deploy points: API + POS at S2-01c; launcher and the "coming soon" shells at
S2-02; console at S2-03; OTO App at S2-17a; booth at S2-07a; Radar at S2-18;
Inbox shell at S2-19. After the first deploy every merge to `main` deploys
behind CI, running migrations and the re-runnable `platform:sync` seed.

### 3.2 One database, named schemas

Migration `0003` creates the schemas and moves the Sprint 1 tables into them
with `SET SCHEMA` (Drizzle `pgSchema` builders, `schemaFilter` in
`packages/db/drizzle.config.ts`). The generated SQL must contain `SET SCHEMA`
only — never `DROP`/`CREATE`. `0003` is the only migration allowed to break
the previous release, because it lands before the first deploy; **from `0004`
every migration is expand/contract**.

| Schema | Holds |
|---|---|
| `core` | Tenancy and fleet: operator, branch, department, employee, account, role and assignments, session, `box`, `station`, `device`, `station_device`, `device_credential`, `signing_key` (public keys only), `app_identity` |
| `crm` | Members, children, registrations, guardians |
| `pos` | Sales and money: `sale`, `sale_line`, `payment_attempt`, `refund`, `band` + `band_event`, `print_job`, `receipt_series`, wallets, stock, cash sessions, check-in and release |
| `promo` | `voucher_definition`, `voucher`, `voucher_print`, `redemption`, `marketing_channel`, `campaign` |
| `booth` | `booth_config_version`, `booth_layout`, `booth_prize`, `booth_staff_assignment`, `spin` |
| `analytics` | `daily_summary`, `hourly_summary`, `branch_source_switch`, `dim_date`, `dirty_date`, `fact_booth_daily`, `fact_occupancy_15min`, `fact_wallet_liability_daily` |
| `edge` | Box-owned state and the sync ledger: `sync_event`, `sync_change`, `sync_cursor`, `sync_quarantine`, `sync_anomaly`, `box_heartbeat`, `box_command`, `station_event`, and the virtual box's `Store` tables |
| `otoapp` | The lifted OTO App's own 184 tables, migrated by the app's own migrator through `search_path` (§6.1) |
| `radar` | Radar's own tables, likewise (§6.2) |
| `inbox` | Conversations, messages, channels, participants, assignments, templates (§6.3) |
| `pgboss` | The job runner's managed schema — outside Drizzle, migrated in the deploy step, excluded from `schemaFilter` and from the `\dt public.*` check |

Renames in `0003`: `transaction→sale`, `transaction_line→sale_line`,
`payment→payment_attempt`, `wristband→band`, `item→stock_item`. Also:
`ON DELETE CASCADE` removed from ledger and child tables (child→member becomes
`RESTRICT`); `station_kind` and `contact_channel` become text + CHECK (adding
`booth` and `instagram`); `role` unique on `(operator_id, name)` plus
`is_system`; `archived_at` on `role_assignment` and `branch_holiday`;
`operator_id` on `station`.

Cross-app links are **by identity, never by foreign key**:
`core.app_identity(app, account_id, external_user_id)` maps a platform account
to a foreign app's own user row, and the POS-facing seams read
platform-owned views (`otoapp_v.events`, `otoapp_v.employees`,
`otoapp_v.children`). No app reads another app's tables directly
(`PLATFORM_PLAN.md` §12).

### 3.3 Packages and their responsibilities

| Package | Responsibility |
|---|---|
| `packages/shared` | The one money/time/phone/i18n/permissions library. Satang arithmetic and the rounding rule, the pricing and tax engine ported from the prototype with regression fixtures, `business_date` from `branch.business_day_start`, UUIDv7, phone normalisation, permission constants, the station-session types. Runs identically on the box and in the cloud |
| `packages/db` | Drizzle schema per schema-namespace, generated migrations, the re-runnable `platform:sync` seed, `seed:demo-day`, the embedded-Postgres test helper (`packages/db/src/testing.ts`) |
| `packages/config` | Shared eslint, prettier, tsconfig — plus the ESLint rule that forbids PII keys in log object literals |
| `packages/contracts` | Device and integration interfaces only, no implementations: `PaymentTerminal` (sale/void/inquire/settle), `QrPayment` (create/inquire/refund), `Printer`, `ScanInput`, `Gate`, `Button`, `Badge/PIN`, `CashDrawer`, `MessagingChannel` |
| `packages/box-agent` | The box runtime: station session document, lease fencing, cache bundles, durable outbox, sync client, command polling, heartbeat, device drivers, the `Store` interface and its two implementations |
| `packages/print` | Template → layout model → ESC/POS or TSPL bytes → adapter; Thai/Chinese/Cyrillic rasterised from bundled Noto fonts; one fixture per template |
| `packages/telemetry` (`@oto/telemetry`) | pino logger with base bindings and the redaction list, pg-error scrubber, AsyncLocalStorage context, `scrubUrl`, `errorFingerprint`, `ops.run`, `defineJob`, and `register.ts` starting the OpenTelemetry NodeSDK only when an OTLP endpoint is configured |
| `packages/payments-2c2p` | The 2C2P client behind `QrPayment`: Payment Token, Do Payment (PromptPay QR), Redirect API, backend notification verification, Payment Inquiry, Payment Maintenance |
| `packages/admin-ui` | The prototype's admin layout (`AdminLayout.tsx`, `adminSections.tsx`) extracted so the console, the POS `/admin` and the Inbox shell share one design language |

### 3.4 The box agent

The cloud is the system of record; the box is the system of action. Nothing at
a counter waits on the internet to sell, print, take a card payment or release
a child (`PROJECT_CONTEXT.md` §3, §8; rule R-11).

- **`Store` interface.** One interface, two implementations: the `edge` schema
  in Postgres for the cloud virtual box now, SQLite on the Pi later. Sequence,
  lease, session document and outbox rehydrate from the `Store` after a
  restart, never from memory — a Render restart must not lose an open sale or
  a queued event.
- **Station session document.** The box owns the station's current sale
  (stage, cart, member, totals, payment state, prompts, language,
  `schema_version`), stamps a sequence number on every change, and pushes full
  snapshots over `/ws/station/:id` — the till gets the whole document, the
  display a **redacted** view that never carries allergies, medical notes,
  holder names or member notes (R-58).
- **Lease.** The till holds a lease (15 s heartbeat, 60 s TTL) in the `Store`.
  An expired lease is claimable without a manager; a live one needs manager
  approval and is audited `station.takeover`. Every intent carries the lease
  id and the last-seen sequence; a stale till gets `409 STALE` and rehydrates.
  The display credential is fenced the same way.
- **Cache bundles.** `GET /box/v1/config` and `/box/v1/cache` deliver
  catalogue and prices, members and children, staff hashes plus
  `revoked_account_ids`, the staff-token deny-list, today's bookings, valid
  bands, station config and receipt-series high-water marks. A bundle is
  applied whole or not at all and carries `schema_version` with
  migrate-on-read; the cloud refuses a bundle above the agent's supported
  version and raises an alert.
- **Outbox and sync ledger.** Every fact is a `sync_event` carrying
  `(box_id, journal_epoch, box_seq)`, `occurred_at`, `received_at`,
  `clock_trust`, actor, action id, payload, payload hash and an HMAC signature
  under the per-box secret. Batches are capped at 200 events / 1 MB.
  `POST /box/v1/sync/push` verifies the signature and applies each event under
  a SAVEPOINT inside the batch transaction: same id + same hash is dropped as
  a duplicate; same id + different hash goes to `sync_quarantine` with a
  `sync_anomaly`; an epoch older than `box.current_epoch` is rejected with an
  alert. Never a silent drop.
- **Epochs.** The cloud issues `journal_epoch` at registration and after any
  store reset (`box.current_epoch`, strictly increasing). The box persists the
  epoch and sequence before any fact is acknowledged locally.
- **Offline rule.** The till talks only to the box surface (`/ws/station`,
  `/box/v1/station/*`) for identify, cart, tender, print and redeem; cloud
  routes are admin or read-only for the till. The offline toggle cuts the
  box's cloud client and, in test mode, returns 503 from cloud routes for that
  station credential, so an "offline" demo cannot be faked.
- **Offline capability matrix.** Allowed / capped / refused per operation,
  maximum cache age, staff-token expiry and deny-list propagation live in
  `docs/architecture/ARCHITECTURE.md`; every row is tested with the toggle
  (§11).

### 3.5 Transport and sign-on

- **Same-origin `/api`.** Every static site carries a rewrite `/api/* →` the
  api service, so each app is same-origin with its API path: the session
  cookie stays httpOnly `SameSite=Lax` and no CORS is needed. The rejected
  alternative (`SameSite=None` plus an allow-list) is recorded in
  `ARCHITECTURE.md`.
- **Hand-off token.** Because the apps are different origins, the launcher
  issues a 60-second, single-use JWS hand-off token per audience origin,
  carried in the **URL fragment** (never the query string), bound to session
  id, audience and the exchange request's `Origin`, consumed atomically, and
  signed with `HANDOFF_SIGNING_KEY` with kid rotation. This is the permanent
  mechanism — it works on `*.onrender.com` today, on a real domain later and
  on the booking site's separate domain. A parent-domain cookie is an optional
  later shortcut behind the same adapter.
- **Lock model.** `POST /auth/lock` sets `session.locked_at`;
  `POST /auth/unlock` re-verifies the password under the sign-in throttle. A
  lock never ends the session (R-18, conflict C14) — server-side sign-out
  happens only from the explicit Sign out button or a force sign-out
  (`POST /accounts/:id/sessions/revoke`).
- **Staff token.** A signed staff token (shift-length expiry, branch audience,
  jti) is minted at station pick with `STAFF_TOKEN_PRIVATE_KEY` and verified
  offline on the box against the public key; the cache bundle refreshes staff
  hashes and the `revoked_account_ids` deny-list on every pull.
- **Device credentials.** Displays, kiosks, booths and boxes authenticate with
  their own credential (`kind`, `station_id`, `scopes`, `rotated_from`), issued
  by a pairing code, revocable, and authorised against their station on every
  call.
- **Keys.** Private keys (`BAND_HMAC_KEY`, `STAFF_TOKEN_PRIVATE_KEY`,
  `HANDOFF_SIGNING_KEY`) live in environment variables with kid rotation;
  `core.signing_key` stores public keys only.

### 3.6 Device adapters and the park's real devices

Every adapter in `packages/contracts` is written against the real protocol and
every simulator answers with the real messages, so that on site only the
physical link changes (`docs/architecture/DEVICE_INVENTORY.md`). Values below
come from that document; items it marks **confirm on site** stay marked.

| Contract | The park's device | Protocol the adapter speaks | What the simulator must reproduce |
|---|---|---|---|
| `Printer` (receipt) | Welltech G4 (Xprinter XP-C260 family) at `192.168.88.202`; Xprinter XP-80 series at `.206` kitchen, `.207`, `.208` bar | ESC/POS over raw TCP 9100, Thai code page, partial cut, drawer kick on the RJ11 | ESC/POS parsed from the same bytes as the preview, unreachable and paper-out faults, drawer-kick event |
| `Printer` (label) | 4B-2082A wristband printers at `.204` (kids) and `.210` (adults) | TSPL2 over TCP 9100 (`SIZE`, `GAP`/`BLINE`, `DIRECTION`, `DENSITY`, `CLS`, `TEXT`, `BARCODE`, `QRCODE`, `BITMAP`, `PRINT`); status byte via `ESC ! ?`; identity via `~!T` | One TCP connection at a time, a rendered PNG per label, immediate commands mid-stream, settable paper-out / head-open / jam / pause states, `SET RESPONSE ON` acknowledgements |
| `ScanInput` | Zebra DS2278 cordless with the CR2278-PC cradle, **attached to the box**, not the iPad | USB HID keyboard (VID `05E0` PID `1200`, Suffix 1 = `7013` Enter, parameter #235) or USB CDC (PID `1701`) on `/dev/ttyACM*` | Typed code plus a Scan button; scans published on the station channel; a booth button key distinguishable from a scanner's Enter |
| `PaymentTerminal` (card) | NEXGO N5, TID `65703235` / `65703236`, MID `4648434010`, SCB acquirer | GHL LinkPOS XML over USB serial 9600: `SALE`/`QUERY`/`VOID`, 12-character `pos_ref_no`, decimal amounts, ISO response codes for cards and 00/01 for wallets; no QUERY for card; Thai QR not voidable; card void before settlement, wallet void before 23:00 | The same XML messages, plus approved / declined / partial approval / no-final-response / inquiry-unavailable / timeout and "Advance terminal clock" |
| `PaymentTerminal` (QR, wallets) | PAX A920Pro, SN `1854355548` / `1854355549`, deployed by Digio | Digio Direct Terminal frames: `3E55` header + BER length + BER-TLV + 1-byte XOR checksum, satang amounts, action codes per payment type (A1 credit, A3 PromptPay QR, A18 return QR payload, voids A11/A13…) | The same framing and action codes, including the terminal's own QR payload for the offline fallback |
| `QrPayment` | 2C2P (SCB is the acquiring bank), sandbox first | HTTPS, every request and response a JWS HS256 JWT in `{"payload": "<jwt>"}`: Payment Token → Do Payment (PromptPay QR) → backend notification + Payment Inquiry; Redirect API for the booking site; Payment Maintenance for refunds | Same request/response shapes, "customer paid" and "Suppress webhook" buttons; used only when no `PGW_*` credentials are configured |
| `Gate` | GE-X2 gate with the HX-X1 controller (firmware V1.55+) and a network QR reader | Reader HTTP hosted **on the gate box**: `POST /interaction/Api/checkCard` (`card` base64, `type`, `serial`, `reader`) answered `{"code":"1"\|"0","message":"…"}`, and `POST /interaction/Api/heartbeat`; dry-contact ~1 s pulse on `L-OP`/`R-OP`/`COM`; passage feedback over RS232/RS485 19200 N81 | Both halves: the reader's posts and displayed message, and the controller's `61`/`62` passed, `63`/`64` timeout, `73`/`74` loitering, `83`/`84` wrong direction, `93`/`94` tailgating, `95` beam blocked, status queries, fire alarm, power loss, faults E1–E30 |
| `Button` | USB red dome button at the booth | HID keyboard, one configurable key — **never Enter** | Key press from the control panel |
| `Badge/PIN` | Booth staff sign-in | PIN or badge against an argon2 `credential` row | Typed PIN / badge, lockout with exponential backoff |
| `CashDrawer` | Drawer on the receipt printer's RJ11 (24 V 1 A) | Kick through the receipt printer | Drawer-kick event in the printer simulator |

Two architectural consequences of the device research worth repeating: the
**scanner is on the box, not the iPad** (which is why the till, display, gate
and kiosk all receive scans the same way, online or offline), and the **gate
reader posts to us** over HTTP while the HX-X1 controller talks serial — the
box hosts the reader's endpoints and drives the relay.

### 3.7 Payments

Four tenders, one state machine (`payment_attempt`), split-capable
(R-37, conflict C18):

- **2C2P is the QR gateway and it is real, not mocked** — owner decision
  2026-09-20, which keeps `PROJECT_CONTEXT.md` §7.2 standing. Payment Token →
  Do Payment on the PromptPay QR channel → the QR renders on the customer
  display (or, for the booking site, the Redirect API's hosted page) →
  2C2P's backend notification arrives at `POST /webhooks/2c2p/payment` (JWT
  verified, matched by `invoiceNo`) with Payment Inquiry as the safety net.
  Refunds and voids go through Payment Maintenance. Sandbox and production
  differ only by `PGW_ENV`, base URL, credentials and registered return URLs.
  Endpoint detail, response codes and the credential checklist:
  `docs/architecture/PAYMENT_GATEWAY.md`.
- **Cards go through the EDC terminals by ECR**, never through the customer
  display. Any sale with no final response triggers an inquiry before the till
  may continue; where inquiry is unavailable (GHL card sales), staff confirm
  against the terminal's own screen and the confirmation is audited.
- **Offline fallback is the PAX terminal's own QR** (Digio A3), which runs on
  the terminal's 4G; the attempt is flagged `awaiting_settlement` and
  reconciled at settlement. The till switches automatically.
- **Cash** records tendered and change and kicks the drawer.
- **Manual recording stays first-class** for any terminal that is not
  tethered.
- Adapter payloads are stored in `ops_run` only after a per-adapter allow-list
  projection (TID, MID, approval code, last4, amount, status, invoice number).
  The raw frame stays in the simulator. **No PAN or track data is ever
  stored**; the PCI posture is documented in `ARCHITECTURE.md`.

### 3.8 Analytics contract

One contract, two sources, so Radar and the POS can be compared:

- `analytics.daily_summary` is unique on `(branch, business_date, source)`
  and carries `formula_version` and a marketing-channel breakdown.
  `sale_line` carries revenue category and sub-category, kid/adult counts,
  stay duration, customer tier and business date **from the first sale**, so
  no backfill is needed.
- `analytics.branch_source_switch` records each branch's source
  (`legacy` | `oto_pos` | `both`) and the switch date; legacy days are frozen;
  a `dirty_date` queue re-rolls days touched by late syncs; the jobs process
  is the only writer.
- `GET /analytics/summary?branches=a,b&from&to&group=day|total` merges on the
  server and is the contract Radar consumes through a small adapter module
  (`server/sources/otoPos.ts` inside the lifted Radar). For `legacy` branches
  Radar reads its own rows; for `both` it shows the two side by side with a
  parity delta.
- **Revenue is defined exactly as Radar's code defines it** — formula v30 for
  Floresta-style branches and v21 for Chalong-style — recorded as
  `formula_version` on every row, with a parity test proving the platform
  rollup reproduces it (owner decision 2026-09-20; Open decision 15).

### 3.9 Observability

One package, `@oto/telemetry`, and one rule: anything that can fail silently
is recorded in `ops_run`.

- **Logging contract.** One "request completed" line per request carrying the
  route pattern, the path without its query string, status, duration, the
  request id, account/branch/station bindings, `trace_id`/`span_id` and the
  action id. pino with a redaction list (cookie, authorization, password,
  token, code, phone, email, name, nickname, allergies, medicalNotes,
  dateOfBirth, body, query) and a pg-error scrubber that drops `detail`,
  `hint` and `parameters` and keeps `code` and `constraint`. **No PII in any
  log line, span or error report, ever.**
- **Correlation.** `traceparent`, a validated `x-request-id`
  (`^[A-Za-z0-9._-]{8,64}$`) and `x-oto-action-id` per user action, carried
  PWA → box → device → cloud, so one action id links the till line, the Box
  log drawer, the adapter `ops_run` and the cloud audit row
  (`audit_log.source_event_id`).
- **Tables.** `ops_run`, `ops_last`, `ops_expectation`, `alert`,
  `alert_delivery`, `box_heartbeat` (14-day retention), `station_event`
  (30-day). `audit_log` gains `occurred_at, origin, app, category, actor_type,
  auth_method, session_id, station_id, box_id, source_event_id, outcome`, a
  BRIN index on `created_at` and keyset pagination.
- **Jobs and health.** pg-boss under `PROCESS_ROLES=jobs`; `job:watchdog`
  every 60 s under an advisory lock; `job:housekeeping.retention` hourly;
  alerts with dedupe, auto-resolve and flap suppression delivered to console,
  email and a generic HTTPS webhook. `/ready` reports db latency, pool,
  storage, watchdog age, event-loop lag and WebSocket connections per station,
  and is pinged externally.
- **OpenTelemetry is dormant until configured.** `register.ts` starts the
  NodeSDK only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, with a PII-scrubbing
  span processor and the OTLP logs bridge; HyperDX or any other OTLP backend
  is four environment variables (§8). Render's log retention is short, so
  `ops_run` and `audit_log` are the on-platform long-term record.
- **Surfaces.** Console v1 (`apps/console`) hosts Activity, Failures, Health,
  Integrations, Devices and Booths. Integrations shows env **presence flags**,
  never values.

## 4. Work order

The owner's priority, stated 2026-09-20: **POS complete first (with the Lucky
Wheel), then the OTO App, then Radar, then the Inbox.** These are priorities
inside one sprint, not separate sprints.

The canonical sequence is in `SPRINT_2_PLAN.md` "Execution order and
checkpoints":

```
S2-01a → S2-01b → S2-01c → S2-02 → S2-03 → S2-17a → CP1 →
S2-04 → S2-05 → S2-06 → S2-07a → S2-07b → CP2 →
S2-08 → S2-09a → S2-09b → S2-10a → S2-10b → S2-11 → CP3 →
S2-12 → S2-13 → S2-14a → S2-14b → S2-15a → S2-15b → CP4 →
S2-17b → S2-17c → CP5 → S2-18 → S2-19 → CP6 → S2-16 → CP7
```

### 4.1 Phases

| Phase | Tickets | What it delivers |
|---|---|---|
| **P1 — POS and booth** | S2-01a/b/c, S2-02, S2-03, **S2-17a (pulled forward, before CP1)**, S2-04, S2-05, S2-06, S2-07a/b, S2-08, S2-09a/b, S2-10a/b, S2-11, S2-12, S2-13, S2-14a/b, S2-15a/b | The hardened platform, the launcher and Console on Render, the station/box model with the cloud virtual box, the Lucky Wheel, the two-device POS, the whole money path, arrival and the gate, check-in, wallets, stock, day close and the analytics rows |
| **P2 — OTO App** | S2-17b, S2-17c | The live app lifted onto Render against the `otoapp` schema with every module working, the POS seams, then the contract features |
| **P3 — Radar** | S2-18 | Radar live on the platform with the per-branch source preference, seeded legacy fixtures and the POS analytics contract |
| **P4 — Inbox** | S2-19 | The `inbox` schema pillars, seed and the mockup shell |
| **Close** | S2-16 | Acceptance run, load and soak, `sprint-2` tag, report, Jira evidence, play-test guide |

Why S2-17a jumps the queue: the owner wants the shared database and one
sign-on proven at the front door. S2-17a is a schema, a middleware and a
provisioning route — not the lift. The lift (S2-17b/c) and Radar (S2-18) wait
until the POS is complete, as directed.

Why the money path is ordered the way it is: S2-01 must precede any deployment
the park's team can reach (the privilege hole, non-atomic writes, PII in logs,
the idempotency race). S2-02/S2-03 put the suite and its evidence surface on
Render. S2-04..S2-06 build the station/box model everything else sits on. The
booth follows immediately because it needs only the box agent, the print core
and the scanner. S2-11 is what makes a sale print and appear in History, which
is the honest point to hand the park's team a play-test — hence CP3 sits there,
not at the first sale.

### 4.2 Checkpoints

At each checkpoint: bring `SPRINT_2_PROGRESS.md` fully up to date, write a
short summary of what was built and what is next, and **stop and wait for
review**. Do not proceed past a checkpoint without an explicit go-ahead.

| CP | After | What it proves |
|---|---|---|
| **CP1** | S2-17a | Security fixes visible from the UI (dominance, force sign-out, lock model); the schema move and transactional services (dev evidence); API + POS + launcher + console + shells on Render with the same-origin `/api` rule; the log-line contract, `ops_run` and the Activity / Failures / Health / Integrations pages; the PII fixes; and the OTO App opened from the launcher, on the shared database, by an admin-created user with no second password |
| **CP2** | S2-07b | The station model live: stations, virtual boxes, the offline toggle, the sync ledger with epochs and quarantine, the print core and simulators, the PWA; and the Lucky Wheel playable end to end with its admin panel |
| **CP3** | S2-11 | Two-device POS, the first real sale across all tenders, voucher and legacy-code redemption, receipts, bands, History, refunds. **The park's play-test opens here**; the pricing regression fixtures are reviewed |
| **CP4** | S2-15b | The full POS: arrival and gate, check-in with offline release, wallets and stock, cash / EOD / settlement, the analytics rows and the multi-branch summary |
| **CP5** | S2-17c | The OTO App lifted with every module walked through on staging, the POS seams, and the confirmed contract features built |
| **CP6** | S2-19 | Radar live with the per-branch source preference (a POS sale visible in it), plus the Inbox pillars and shell |
| **CP7** | S2-16 | The acceptance checklist from a clean database on staging, load and soak results, the tag, the report, Jira evidence and the play-test guide |

### 4.3 Parallelisable streams

Once their dependencies are merged, these can run as concurrent agents:

- After S2-03: the box agent skeleton (S2-04) is independent of remaining
  console polish; S2-17a is independent of both.
- After S2-06: the booth game (S2-07a) and the customer display (S2-08) are
  independent; S2-09a can start its engine port and regression fixtures at any
  time (it is pure `packages/shared` work against prototype fixtures).
- After S2-09a: tenders (S2-10a) proceed without the booth; S2-10b waits for
  S2-07a and S2-10a.
- After S2-11: S2-12, S2-13, S2-14a and S2-14b are independent of each other.
- After S2-15b: S2-17b, S2-18 and S2-19 are independent (S2-18 and S2-19
  borrow the sign-on middleware pattern from S2-17a).
- Documentation, seed scripts and Playwright smokes run alongside every
  ticket, never as a trailing clean-up.

Two agents must not touch the same migration or the same route file at the
same time. When parallelising, split by package and by schema, and land the
migration for a stream before the stream's second agent starts.

## 5. Per-ticket build recipe

Every ticket follows the same ten steps. Not every ticket needs every step —
skip (e), (g) or (i) when the ticket has no box surface, no device and no seed
change — but never skip (a), (h), (j).

### 5.1 The ten steps

**(a) Read the ticket's rule ids and prototype sources.**
Open `docs/architecture/POS_RULES_RECONCILIATION.md` and read every `R-nn` and
`C-nn` the ticket names; a `✔` means Sprint 1 already built it and you are
extending, not writing. Then open the prototype files the ticket names. The
pattern is always:

```
imports/oto-pos/artifacts/oto-till/src/mockApi.ts      5,835 lines — all mock data plus
                                                        the getters/mutators that are the
                                                        swap seam (recordSale, recordRefund,
                                                        redeemBooking, getLiveOccupancy, …)
imports/oto-pos/artifacts/oto-till/src/lib/*.ts        36 pure-logic modules — pricing.ts,
                                                        pricingMode.ts, tax.ts, sale.ts,
                                                        manualDiscount.ts, promoVoucher.ts,
                                                        discountTarget.ts, fnb.ts, menu.ts,
                                                        merch.ts, supervision.ts, dropoff.ts,
                                                        endOfDay.ts, reporting.ts,
                                                        printRouting.tsx, inventory.ts, …
imports/oto-pos/artifacts/oto-till/src/store/catalogStore.ts   1,805 lines — the editable
                                                        per-branch catalogue the admin writes
                                                        and the POS reads
imports/oto-pos/artifacts/oto-till/src/types.ts        2,047 lines — the shapes the UI expects
```

`apps/pos/src` is a near-verbatim copy of that tree plus `apps/pos/src/api/`
(`client.ts`, `platform.ts`, `mappers.ts`, `catalogBridge.ts`) — that
directory is the entire seam between the ported prototype and the API. Port
the rule with its edge cases; cite the file and function in the progress log.
If the prototype and the ticket disagree, stop and ask (§1.4).

**(b) Migration.**
Add or reshape tables in `packages/db/src/schema/*.ts` under the right schema
namespace (§3.2), then `pnpm db:generate` (drizzle-kit) and **read the
generated SQL before committing it**. From `0004` onward every migration is
**expand/contract**: add the new thing, backfill, make the code read both, and
only remove what the previous release read in a later migration. Then prove it
applies twice from empty — `pnpm db:migrate` run twice, exactly as
`.github/workflows/ci.yml` does. Every FK gets an index; every table gets
`created_at`/`updated_at`, and `archived_at` where archivable. Never edit an
applied migration.

**(c) Service.**
Business logic lives in `apps/api/src/services/*.ts`, never in a route
handler. Every write runs through `withTx(db, ctx, opName, fn)`, which opens
the transaction, runs the business function, writes the **success audit row
inside it**, stores the idempotency response inside it, and emits one span and
one debug line named from the audit action vocabulary. Failure and denial
audit rows and `ops_run` failures are written after rollback on a separate
connection. Accept a client-generated UUIDv7 id: a creating POST that hits an
existing id returns the existing row with `200` and `x-oto-replay: true`.

**(d) Route.**
`apps/api/src/routes/*.ts`: zod request and response schemas, the permission
as a **route option** checked by a preHandler (not a hand-rolled
`req.requirePermission()` inside the handler), an OpenAPI description, and a
mapping from the service result to the response. Register the group in
`apps/api/src/app.ts`. A route-enumeration test fails the build if a
non-public route carries no permission.

**(e) Box-agent surface, when the till needs it offline.**
If the operation must work with no internet (§3.4; rules R-46, R-93), it is an
**intent on the box**, not a cloud route: extend the station session document,
add the intent and its stage validation in `packages/box-agent`, queue the
resulting fact to the outbox with `(box_id, journal_epoch, box_seq)`, and add
the cloud-side apply in the sync handler under a SAVEPOINT. Cloud routes stay
admin or read-only for the till. Add the operation's row to the offline
capability matrix in `ARCHITECTURE.md` and test it with the offline toggle.

**(f) UI wiring, without design changes.**
`CLAUDE.md` §7 still governs: copy the prototype's components, styles and
layout; refactor state, data fetching and types freely; do not restyle,
rename a visible label, move an element or change a colour. Replace the
`mockApi.ts` call with the API or box call at the seam. Where a ticket needs a
UI element the prototype lacks, add it in the same design language, as close
as possible to where the prototype would have put it, and list it under "UI
additions" in `SPRINT_2_PROGRESS.md` — removals too (the "Scan my face" button
goes in S2-02 because biometrics are banned for the POS).

**(g) Simulator and control panel, when a device is involved.**
The adapter goes in `packages/contracts` (interface) plus its implementation;
the simulator must speak the **real message dialect** from
`DEVICE_INVENTORY.md` (§3.6) — TSPL2 for the wristband printers, ESC/POS for
the receipt printers, GHL LinkPOS XML for the NEXGO, Digio `3E55` BER-TLV
frames for the PAX, the reader's `checkCard`/`heartbeat` HTTP plus GE-X2
serial feedback for the gate. Only the physical link is stubbed. Every
simulator gets a control panel under Console > Devices > Simulators with
scripted outcomes and fault injection, and every simulator call writes a
device log line carrying the action id and aggregates into the heartbeat.

**(h) Tests.**
Nothing merges without them. The suites are:
- unit — `packages/shared/test/*` for pricing, tax, money, business date,
  phone, the permission resolver; regression fixtures captured from the
  prototype's `lib/pricing.ts`, `lib/sale.ts`, `lib/tax.ts` figures;
- integration — `apps/api/test/*.test.ts` on a real Postgres
  (`packages/db/src/testing.ts` gives an embedded Postgres 16 when
  `TEST_DATABASE_URL` is unset): every route's happy path and its main
  failure, the transaction-rollback test, the route-enumeration test, the
  idempotency concurrency test, the sync idempotency / poison / epoch tests,
  the `schema_version` replay test, the boot-refusal test;
- redaction — fixtures for a Thai local phone, an E.164 phone, a child
  record, a pg unique violation and a simulated terminal response; plus the
  ESLint rule that fails a deliberate `log.info({ phone })`;
- Playwright — `apps/pos/e2e/*.spec.ts`, run against the **Render origins**,
  not the dev proxy, for the flows listed in §11.

**(i) Seed and `seed:demo-day`.**
`packages/db/src/seed/index.ts` becomes the re-runnable `platform:sync` step —
it must be safe to run on every deploy, not a no-op-if-OTO-exists script.
`seed:demo-day` is built incrementally from S2-09a through S2-13 and is the
QA fixture: members, stations, boxes, sales across every tender on two TIDs,
vouchers and legacy codes, check-ins, on a fixed business date. S2-16 runs it,
never extends it.

**(j) Docs, progress log, commit.**
Update the feature page in `docs/features/` (its status table), add the
decision to `ARCHITECTURE.md` §10 if one was made, write the ticket-log entry
in `SPRINT_2_PROGRESS.md`, and commit per `CONTRIBUTING.md`. The progress
entry follows the Sprint 1 shape:

```
### S2-09a — Ticket cart, pricing/tax engine, sale facts — **done**
- Ported from: `lib/pricing.ts:priceForTier`/`resolveAdultLine`, `lib/sale.ts:computeTotals`,
  `lib/tax.ts:computeTaxBreakdown`, `lib/manualDiscount.ts`, `lib/promoVoucher.ts`.
- Added per the plan: satang arithmetic with one rounding rule, `sale`/`sale_line`
  facts with the analytics fields, receipt series allocated on the box.
- UI additions: none (Step 2 cards preserved; tier locked from the member).
- Tests: pricing regression fixtures, business-date boundary, receipt-series conflict.
- Deferred / notes: F&B and shop carts in S2-09b.
```

### 5.2 Acceptance evidence for Jira

Evidence is posted as a **comment** on the story, in the Sprint 1 format
(`docs/qa/jira-comments/SCRUM-*.md`): plain text, no markdown headings, about
six lines.

- Line 1: `S2-xx — <ticket title>`.
- Line 2: the verification preamble — date, the commit or tag, the branch, the
  stack it was run against (Render URLs for Sprint 2), and the full suite
  counts.
- Then an `Integration:` paragraph — what the automated tests prove, naming
  real values and HTTP codes, as claim plus proof in one line, never a bullet
  list.
- Then a `Live browser:` paragraph — the user-visible walkthrough end to end
  with the real values a reader can check, and the rule reference; ending
  "Screenshots retained."

Screenshots are **not** linked inline. They go in
`docs/qa/jira-comments/attachments/<TICKET>/<descriptive-name>.png` and are
attached to the Jira comment.

Detailed test cases go in `docs/qa/TEST_CASES.md` in the Sprint 1 shape: one
`## TC-S2-xx — <title>` per ticket, optional `**Preconditions:**`, numbered
imperative steps naming the exact on-screen label and the exact toast text,
back-end verification folded in as a numbered "SQL check" step, then
`**Expected:**` / `**Actual:**` (or a combined line) and a bolded
`**Status: PASS**`. Negative cases are numbered steps of the same case, not
separate cases. S2-16 assembles `docs/qa/SPRINT_2_ACCEPTANCE.md` from every
story's QA steps.

Every QA step in the plan is tagged **QA (UI)** — a non-developer can do it
from a browser — or **Dev evidence**, with at most one dev-evidence step per
story. Keep that tagging when you write the evidence.

**Never change a Jira issue's status.** Agents post evidence comments and
attachments; the owner moves tickets. Do not transition, assign, close or
reopen anything.

## 6. How each foreign app is lifted

Three apps the park already runs come onto the platform in this sprint. The
principle is the same for all three and is set by `PLATFORM_PLAN.md` §12:
**each app gets its own schema in the one central database, each app's own
migration tool runs inside that schema through `search_path`, additively, so
the app's code stays lift-compatible with its Replit original and the
production dump can be restored into the same tables at cutover.** Cross-app
links are by identity (`core.app_identity`), never by foreign key. No app
reads another app's tables directly.

### 6.1 OTO App — lift as-is (S2-17a/b/c)

Source: `imports/oto-app/` — Express 4 + Passport-local + Drizzle, **796
routes** (517 of them in one 25,504-line `routes.ts`), `storage.ts` 12,253
lines / 452 methods, **184 tables**, a React front end with 122 routes, no
unit tests. The intake's verdict stands: **lift as-is first**, because 1,400+
references to `requireAuth`/`req.user`/`req.userWithAccess` and a codebase
still under daily commits (2,920 in 8 months) make a rewrite a fork from a
moving upstream. Work list:
`docs/architecture/intake-2026-09-19/01-oto-app-backend.md` §10; front-end
seams: `02-oto-app-frontend.md` §8; status table:
`docs/features/oto-app.md`.

**Schema (`otoapp`).** Drizzle emits unqualified table names, so
`ALTER ROLE <app role> SET search_path = otoapp` works with no code change;
the `session` table, the raw SQL and `drizzle.__drizzle_migrations` all follow
the search path. This matters because the app's table names would collide in a
shared `public`: `users`, `session`, `roles`, `branches`, `tenants`,
`settings`, `files`, `tasks`, `notifications`, `locations`.

**Never run these against the central database:**
- `drizzle-kit push --force` — it treats unknown tables as drops
  (`scripts/post-merge.sh`, `Dockerfile.dev` in the export both call it);
- the reset scripts — they run `DROP SCHEMA public CASCADE`
  (`infra/scripts/db-reset.sh`).

The app moves to **generated SQL migrations** checked into its folder, and the
api refuses to start if the export's `post-merge.sh` is present in the image.

**Identity and sign-on.** Add `otoapp.users.platform_user_id` (unique,
nullable) by an additive migration and
`core.app_identity(app, account_id, external_user_id, created_by, created_at)`
on the platform side. Keep the local `users` rows — **127 foreign keys
reference `users(id)`**, so that id must stay stable. Then **one middleware
before `passport.session()`** validates the launcher hand-off token (the
S2-02 contract), maps it to a user through `platform_user_id`, and calls
`req.login()`; `getUserWithBranchAccess` still resolves role, branch scope and
tenant, so **all 796 handlers stay untouched**. About fifteen
credential-writing routes are re-pointed at the Console. The legacy
Passport-local login stays behind `OTOAPP_LEGACY_LOGIN` (off on staging) for
the cutover rehearsal only. Logout revokes the app's own session, and the
launcher's "sign out everywhere" reaches it through a back-channel revoke list
polled on session load. **Kiosk bearer tokens and public tokens** (parent
portal, guest invites, signing links) stay outside the sign-on.

**Provisioning.** `POST /admin/apps/oto_app/users` on the platform api creates
the platform account if needed, grants `app:oto_app:access`, creates or links
the `otoapp.users` row with the chosen OTO role, branch scope and tenant, and
writes both audit rows (`app_identity.link`). The Console and POS admin gain
an "Apps" tab on the account page with link/unlink.

**Deploy.** A Docker web service from the export's Dockerfile: **2 GB or more
(Chromium for PDFs), exactly one always-on instance** — it has in-process
timers (nightly auto clock-out, recurring tasks, reconciliation, no-show
alerts) — health check `/api/status`, `TZ=UTC` (the schema has 369
`timestamp`-without-timezone columns and hand-rolled +7h arithmetic),
`LOG_RESPONSE_BODY=false`, `trust proxy`, cookie `secure` keyed on `NODE_ENV`
instead of Replit variables, in the same region as Postgres.

**Storage.** The four `S3Client` constructions have no `endpoint` option and
must get one to reach the platform bucket; the second bucket merges into the
first; the four local-disk writers move to object storage; the stored paths in
the signed-contract and employee-letter tables are rewritten. Bucket CORS is
set.

**Secrets.** New `SESSION_SECRET`, `SESSION_PEPPER`, `KIOSK_CODE_PEPPER` and
`PIN_FINGERPRINT_SECRET` values mean the branch check-in QR codes must be
reprinted, every kiosk re-activated and advisor PINs reset — unless the
original values are handed over (`STATUS.md` waiting-on-owner list).

**Replit pieces to remove:** the `replit_integrations` directory, the
`AI_INTEGRATIONS_*` naming, the hard-coded Xero redirect URI and the Nix
Chromium fallback path; `sharp` and `ffmpeg` must be declared in the image.

**Jobs.** The app's scheduled work (nightly departed-account deactivation, the
attention engine, the finance sync) runs either under the platform job
runner's advisory locks with `ops_run` rows, or inside the app with the same
`ops_run` contract through the directory API — one of the two, recorded.

**POS seams.** Platform-owned views `otoapp_v.events`, `otoapp_v.employees`,
`otoapp_v.children` are what the POS reads (events stay mastered by the OTO
App, conflict C10; staff benefits hang off the mirrored HR record, C13). A
grep test asserts the POS api never touches `otoapp` tables directly.

**Cutover rehearsal (S2-17b).** A script restores a **structure-only** copy of
the production dump into a scratch database, runs
`ALTER SCHEMA public RENAME TO otoapp` and loads it (the Navicat dump
hard-codes `"public".`); the export's `prod-sync.ts` carries a ready
foreign-key-safe table load order. It runs in CI against the sample. **No
production rows are ever used this sprint.**

**Face clock-in** stays as it is behind `OTOAPP_FACE_CLOCKIN` (off on staging;
PIN and phone clock-in only) until the owner decides — Open decision 29. The
POS biometrics ban (`PROJECT_CONTEXT.md` §13) is not reopened.

**Contract features (S2-17c).** One sub-task per confirmed item from
`docs/briefs/AGENCY_PROPOSAL.md` §6 — principally §6.2's seven
timekeeping/daily-operations gaps, plus §6.13's HR-linked benefit profiles if
the owner confirms them. Each is built inside the lifted app in its module's
style (Express route + React page), on the `otoapp` schema, audited through
the app's activity log and through the platform audit where it touches shared
identities. The list is not started until the owner confirms it (Open
decision 30).

### 6.2 Radar — lift, gate, and give it one analytics contract (S2-18)

Source: `imports/oto-radar/` — Express + React, **107 routes of which 96 are
public**; `requireStaff` exists and is never applied. Work list:
`docs/architecture/intake-2026-09-19/05-radar-api-auth-env-schema.md` §9;
pipelines: `03-radar-pisell-pipeline.md`, `04-radar-papaya-pipeline.md`;
front end: `06-radar-frontend.md`; status table:
`docs/features/oto-radar.md`.

**Schema (`radar`).** Restore into a dedicated schema. **Include the
`drizzle.__drizzle_migrations` rows in the restore** — otherwise the boot-time
migrator sees an empty tracker and creates the entire inherited HR schema, 107
tables and 23 enums. Drop the seven HR leftover tables, the 64 enums and the
`_system` schema. Note that what we hold today
(`imports/_db/`, and the repo's own `database-schema.sql`, byte-identical) is
a **drizzle-kit introspection, not restorable SQL** — the real dump is Open
decision 18.

**Runtime.** One always-on instance (autoscale is what caused the sync gaps),
a **direct Postgres URL with no transaction pooler** (it uses session advisory
locks), a role that owns the tables and can run DDL, `TZ=UTC`, Node ≥ 20.19,
build `npm ci --include=dev && npm run build`, start `node dist/index.cjs`.
Add `/healthz` (it has no health endpoint), set `trust proxy`, delete
`server/replit_integrations/`, the Replit Vite plugins, the robots sitemap
line and the public source maps.

**Before it is exposed.** Put sign-on in front of everything except `/c/:id`,
`/survey`, `/redeem`, the `/api/public/*` routes, the spin redeem/rewards/
report routes and the key-protected routes. **Delete the five push, import and
wipe routes** — `POST /api/funtopia/push-to-production` is public, does not
validate the target URL, POSTs every row of ten tables including customer name,
phone and email to the caller's URL, and sends the Pisell client secret as a
header. Rotate the Pisell secret, the seed-admin credential, the fixture
passwords and the Sentry DSN. Correct the two OpenAI env-var names in
`routes.ts`. A route-enumeration test asserts no push/import/wipe route
exists.

**Sign-on.** Radar has **no user table**, so the platform session is the
identity and `app:radar:access` gates it; the middleware is the same pattern
as S2-17a.

**Hostname.** Campaign QR links are built from `window.location.origin` and
have already been printed, and the `qr_device_id` cookie and saved AI
conversations are bound to the origin — so preserve the hostname or keep a
redirect from the old one (Open decision on DNS ownership).

**Source preference.** `analytics.branch_source_switch` gains
`preference` (`legacy` | `oto_pos` | `both`), editable from the Console
(Integrations > Analytics sources) and from Radar's config tab. A small
adapter module inside Radar (`server/sources/otoPos.ts`) reads
`GET /analytics/summary` for `oto_pos` branches; `legacy` branches read
Radar's own tables; `both` shows the two side by side with a parity delta.

**Legacy figures on staging** come from **fixture adapters**
(`FUNTOPIA_MODE=fixture`, `PAPAYA_MODE=fixture`) replaying two frozen months
shaped like each pipeline's real responses — the Pisell and Papaya credentials
are still in Replit Secrets. Switching to live pulls is configuration.

**Parity.** A test computes one seeded day both ways — Radar's formula on a
fixture, and the platform rollup on the same sales expressed as POS facts —
and asserts equality field by field. Every summary row carries
`formula_version`. The definitions being reproduced are:

- **v30, Floresta/Pisell:** `totalRevenue = Σ(pay_amount − refund_amount)`
  over active payments, **minus** the same sum over voucher-method payments —
  a cash basis meant to match Pisell's "Net Sales (Cash Basis)"; a refund
  reduces the day of the original payment. Note the known trap the intake
  records: `totalRevenue` and the payment breakdown are VAT-inclusive while
  the category/product/ticket/hourly lines are VAT-exclusive (ratio 1.07), and
  the difference is hidden in an "Other (Unattributed)" bucket the UI filters
  out. Our rollup must be explicit about the VAT basis rather than inheriting
  the ambiguity.
- **v21, Chalong/Papaya:** `revenue = Σ(order.total ?? order.billTotal)` over
  orders whose status is `complete` — accrual at completion, not payment;
  gross of 7 % VAT and probably including the restaurant terminal's 8 %
  service charge.

**Freshness.** The platform rollup runs every 15 minutes on staging
(`ROLLUP_INTERVAL_S`) and marks `dirty_date` on late syncs, so a demo sale
reaches Radar within that interval; Health shows "Radar last refreshed".

**Booth feed.** The wheel's spin and voucher rows come from the platform booth
tables through the same summary contract, replacing Radar's own spin-reward
routes.

### 6.3 Unified Inbox — pillars and a shell (S2-19)

Source: `imports/oto-asset-manager/` — the park's Replit prototype: a React
front end on 17 hard-coded conversations, an Express skeleton with one health
route, an empty Drizzle schema, no auth and no channel code. The briefs,
screenshots and the in-app "IT Brief" are catalogued in
`docs/features/inbox.md`, which is the specification for this ticket. **The IT
Brief is the latest word and wins over the April–May briefs**; where they
disagree the differences are listed on that page and become Open decision 31.

**Schema (`inbox`).** `channel_account`, `contact` (joined to `crm.member` by
normalised E.164 when known), `team`, `routing_rule`, `conversation`,
`message` (direction, channel, body, media as `core.file_object`, AI or human
author), `participant`, `assignment` with the partial unique indexes the
feature page specifies (one active primary, at most two active support, one
active row per person), `template`, `tag`/`conversation_tag`, `sla_policy`,
`event` (append-only), `webhook_receipt` (raw inbound, for replay), and
`note` reserved-but-unused because the IT Brief forbids staff-only notes
inside a thread. Explicitly **not** tables: staff availability or schedules,
and the BEO itself. Retention and erasure fields for PDPA.

**Rules that shape the data model:** statuses are **Active and Handled only**
(the IT Brief forbids extra states); one required primary owner plus up to two
support; the category follows the primary; moving to another team clears the
support slots and re-routes.

**Permissions.** `inbox:conversation:{read,reply,assign,move,handle,reopen}`,
`inbox:template:manage`, `inbox:channel:manage`, `inbox:dashboard:read`.

**Seed.** The four teams, the three categories (Birthdays & Events; General
with two reception queues that are never merged; Marketing) and the routing
rules from the IT Brief, ten fictional example conversations across the
channels, templates and tags.

**Shell.** `apps/inbox` is a static site in the prototype's design language —
Inter, white cards on a faint slate gradient, the three-column workspace
(220 px rail / 360 px list / chat panel), the six-metric dashboard and the
category colours (violet Birthdays & Events, sky General, pink Marketing) —
reading the seeded rows through read-only `GET /inbox/*` routes. Every write
action is present but **disabled** with "coming with the channel connection".
The launcher tile is gated by `app:inbox:access`.

**Contract.** `MessagingChannel` (receive webhook, send, media fetch) goes in
`packages/contracts` with a console adapter only. The check-in flow's console
adapter (S2-13) writes into `inbox.message`, so outbound messages from the POS
already appear in the shell. Sends are audited **by message id, never the
body**; inbound idempotency keys off the provider's event id.

No live channel is connected this sprint — there are no business accounts or
BSP yet. WhatsApp, LINE, Instagram, email, the AI responder and translation
are Sprint 3.

## 7. Engineering conventions

`CLAUDE.md` §8 stays in force. What follows restates it and adds what Sprint 2
locks in.

**TypeScript.** Strict mode everywhere. No `any` without a comment explaining
why. Shared shapes live in `packages/shared` (zod) and are imported by both
sides; never redeclare a shape in two places.

**Services, not handlers.** Business logic lives in
`apps/api/src/services/*.ts`. A route validates, calls a service and maps the
result. Sprint 1 left accounts, operators, branches, members, children, visits,
catalog and bookings in route handlers; S2-01b moves them. Keeping logic in
services is also what makes the box able to run the same code offline.

**`withTx` and the audit rule.** Every service method that writes runs in
`withTx(db, ctx, opName, fn)`. The **success audit row is written inside the
transaction**; the idempotency response is stored inside it too. **Failure and
denial audit rows, and `ops_run` failures, are written after rollback on a
separate connection** — a rolled-back transaction cannot record its own
failure. There are zero `db.transaction(` calls in `apps/api/src` today; after
S2-01b there are no multi-row writes without one.

**Audit vocabulary.** Actions are `entity.verb` and come from one list:
`member.create`, `member.update`, `member.tier_change`, `sale.create`,
`sale.finalise`, `role_assignment.create`, `session.lock`, `session.unlock`,
`session.force_sign_out`, `auth.sign_in_failed`, `auth.locked_out`,
`auth.permission_denied`, `auth.handoff_issue`, `auth.handoff_exchange`,
`auth.handoff_rejected`, `station.takeover`, `box.config.applied`,
`display.paired`, `display.revoked`, `app_identity.link`, `audit.export`,
`audit.read_sensitive`, `ops.demo_reset`, and so on. `withTx`'s `opName` is
the audit action, and it names the span and the debug line, so one word ties
the log, the trace and the audit row together. `audit_log` carries
`category`, `app`, `outcome`, `actor_type`, `auth_method`, `session_id`,
`station_id`, `box_id` and `source_event_id`. Customer intents on the display
go to `station_event` with `actor_type=customer`, not to `audit_log`.

**Idempotency.** Three layers, all of them:
1. **Atomic key claim** — `INSERT … ON CONFLICT DO NOTHING RETURNING`. The
   winner runs the handler; a loser replays the stored response or gets `409
   IDEMPOTENCY_IN_FLIGHT` with `Retry-After`, and the POS polls the same key.
   5xx replies are never stored; expired keys are purged; the principal is an
   account **or** a device.
2. **Client-generated UUIDv7 ids** on every creating POST. An id that already
   exists returns the existing row with `200` and `x-oto-replay: true`.
3. **Database unique constraints on business keys** — member phone per
   operator, account phone, `UNIQUE(station_id, series, seq)` on receipt
   numbers, voucher code per operator, `(box_id, journal_epoch, box_seq)` on
   sync events. Replay protection never substitutes for real uniqueness.

**Money.** Integers in satang, from the one engine in `packages/shared`. Never
floats. Percent discounts and inclusive-VAT back-calculation round **half-up
to the satang per line component**; totals are sums of rounded components.
Regression fixtures capture the prototype's `lib/pricing.ts`, `lib/sale.ts`
and `lib/tax.ts` figures — if a refactor changes a fixture value, it is a bug
until proven otherwise. Adapter edges convert: GHL sends decimal strings,
Digio sends satang integers.

**Time, business date and clock trust.** All timestamps are `timestamptz` in
UTC; each branch has a timezone. Every ledger row stores `business_date`
computed from `branch.business_day_start` (default 05:00 Asia/Bangkok) plus
`occurred_at`, alongside `received_at` and `clock_trust`. When
`clock_trust=low` the cloud recomputes the business date from `received_at`,
keeps the original and records a `sync_anomaly`. Rollups never redo timezone
logic — they read `business_date`.

**Logging contract.** One "request completed" line per request. It carries the
route pattern, the path **without its query string**, status, duration,
account / branch / station / box bindings, `request_id`, `trace_id`,
`span_id`, the action id, `idempotent_replay`, and `slow` above
`SLOW_REQUEST_MS`; 4xx logs at warn with `error_code`, 5xx at error. Fastify's
default request logging is off. **No PII in any log line, span, error report
or stored adapter payload — ever.** The redaction list covers cookie,
authorization, password, token, code, phone, email, name, nickname, allergies,
medicalNotes, dateOfBirth, body and query; a pg-error scrubber drops `detail`,
`hint` and `parameters` and keeps `code` and `constraint`; raw unique
violations become a 409 without the value; the SMS adapter logs a phone hash
only. An ESLint rule fails a log object literal containing a PII key, and the
redaction test runs against five fixtures.

**`ops_run` for anything that can fail silently.** Jobs, webhooks, sync
batches, device and adapter calls, integrations and client-side failures each
write an `ops_run` row with a kind, an outcome, the action id and a
fingerprint. Render's log retention is short; `ops_run` and `audit_log` are
the durable record. `defineJob` seeds an `ops_expectation` so the watchdog can
notice a job that stopped running, not only one that failed.

**Feature flags and env-driven thresholds.** Thresholds are environment
variables, never constants in code: `BOX_OFFLINE_AFTER_S` (180),
`PAIRING_CODE_TTL_S` (600), `HANDOFF_TOKEN_TTL_S` (60), `SYNC_STALE_AFTER_S`
(900), `PAYMENT_PENDING_MIN` (10), `ROLLUP_INTERVAL_S`, `SLOW_REQUEST_MS`.
Test controls live behind `OPS_TEST_CONTROLS`. **The api refuses to boot on a
configuration that does not belong to the deployment it is running as**
(`assertProductionSafe`, `apps/api/src/env.ts`) — three separate refusals, not
one, because staging is a production *build* against throwaway data and a
single `NODE_ENV` test would either lock staging out of its own controls or
hand them to production. §8.12 lists them; there is a test for each.

**Migrations.** Forward-only, generated, committed, never edited once applied.
`0003` is the last migration allowed to break the previous release;
**from `0004` every migration is expand/contract** — add, backfill, read both,
remove later — so a running service is never broken mid-deploy. Prove every
migration applies twice from empty. `pgboss` is a managed schema outside
Drizzle. Indexes on every FK and every lookup column.

**Tests are part of the change.** A ticket without tests is not done (§5.1h,
§11). The named tests the sprint must carry are listed in the plan's
definition of done: route enumeration, redaction (with pg-error and terminal
fixtures), OTel span and log, idempotency concurrency, sync
idempotency/poison/epoch, `schema_version` replay, boot refusal, spin
distribution, business date and pricing regression.

**Simulators speak real dialects.** A simulator that invents its own protocol
proves nothing. Every simulator answers the messages in
`DEVICE_INVENTORY.md` (§3.6), against fixtures taken from the vendor documents
in `imports/_vendor-docs/`. Only the physical transport — the serial port, the
LAN socket, the HID device — is stubbed.

**Config over code for device routing.** Which terminal takes a card and which
takes a QR is station configuration, not a branch in the code (card → NEXGO,
QR/wallet → PAX today). The same holds for printer roles, scanner mode, the
booth's button key and the payment-method list. A later provisioning change
must be data, not a deploy.

**No biometrics in the POS.** `PROJECT_CONTEXT.md` §13 bans facial
recognition and any biometric feature in the product; the "Scan my face"
placeholder is removed in S2-02 (conflict C1). The OTO App's existing face
clock-in is a separate, owner-level decision (§6.1, Open decision 29) and is
off on staging. No ID-document photos are ever stored; a test asserts no
`file_object` is ever linked to a tier verification. Pickup-safety photos are
allowed and staff-only (conflict C9).

**Docs stay current.** A decision goes in `ARCHITECTURE.md` §10 as it is made.
A feature's status table in `docs/features/` is updated by the ticket that
changes it. `.env.example` gains every new variable **by name** in the same
commit. `SPRINT_2_PROGRESS.md` is updated in the same commit series as the
code.

**Never committed:** secrets or `.env`, database dumps, anything under
`imports/` except its README files, build output, `node_modules`. And no
tool, generator or assistant attribution line in any commit message or PR
description.

## 8. Environment variables registry

**Names only. No value of any kind appears in this repository.** Every new
variable is added to `.env.example` by name, with a comment, in the same
commit that reads it; the Console's Integrations page shows **presence flags**
generated from `apps/api/src/env.ts`, never values.

"Set in" means: **Render** = the service's environment group on Render;
**.env** = the local developer file (and `.env.example` by name); **CI** = the
GitHub Actions job environment.

### 8.1 Platform api process

| Name | Meaning | Set in |
|---|---|---|
| `NODE_ENV` | development / test / production; gates the boot refusal below | Render, .env, CI |
| `PORT` / `API_PORT` | Listen port; Render injects `PORT`, local dev uses `API_PORT` | Render, .env |
| `PROCESS_ROLES` | Which roles this process runs: `api`, `edge`, `jobs` (staging runs all three in one service) | Render, .env |
| `TRUST_PROXY` | Proxy hop count behind Render's load balancer, so `req.ip` is the caller | Render |
| `LOG_LEVEL` | pino level | Render, .env |
| `SLOW_REQUEST_MS` | Threshold above which a request line is flagged `slow` | Render, .env |
| `TZ` | Always `UTC` on every service | Render |
| `SESSION_TTL_HOURS` | Session lifetime | Render, .env |
| `COOKIE_SECURE` | Secure flag on the session cookie; `true` on Render | Render, .env |
| `AUTH_MAX_FAILURES`, `AUTH_COOLDOWN_SECONDS` | Sign-in and unlock throttle (Postgres-backed from S2-01a) | Render, .env |
| `IDEMPOTENCY_TTL_HOURS` | How long a stored idempotent response is replayable | Render, .env |
| `SEED_PROFILE` | `staging` enables the demo seed profile — **staging only** | Render |
| `OPS_TEST_CONTROLS` | Enables the Console's test controls — **staging only** | Render |
| `CHILD_PHOTOS_ENABLED` | Feature flag for pickup-safety photo capture (S2-13) | Render, .env |
| `POS_PORT` | Vite dev-server port for the POS (local only; not read by the api) | .env |

### 8.2 Database

| Name | Meaning | Set in |
|---|---|---|
| `DATABASE_URL` | The platform login. **Production refuses the dev default.** Direct connection, not a transaction pooler | Render, .env, CI |
| `TEST_DATABASE_URL` | Test database; when unset, `packages/db/src/testing.ts` starts an embedded Postgres 16 | CI, .env |
| `PGBOSS_SCHEMA` | The job runner's managed schema (excluded from Drizzle's `schemaFilter`) | Render |

### 8.3 Object storage

| Name | Meaning | Set in |
|---|---|---|
| `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_USE_SSL` | S3-compatible endpoint (MinIO locally, the platform bucket on Render) | Render, .env |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | Storage credentials. **Production refuses the dev defaults baked into `env.ts`** | Render, .env |
| `MINIO_BUCKET` | Bucket for `file_object` and, after the lift, the OTO App's media | Render, .env |

### 8.4 Keys and sign-on

| Name | Meaning | Set in |
|---|---|---|
| `HANDOFF_SIGNING_KEY` | Signs the launcher's 60-second hand-off token (JWS, kid-rotated) | Render |
| `HANDOFF_TOKEN_TTL_S` | Hand-off token lifetime (default 60) | Render |
| `STAFF_TOKEN_PRIVATE_KEY` | Signs the shift-length staff token the box verifies offline; the public key lives in `core.signing_key` | Render |
| `BAND_HMAC_KEY` | HMAC key for wristband codes; the same key on every box (owner decision — box theft is not a threat model) | Render |
| `ALLOWED_ORIGINS` | Origin allow-list for the state-changing origin check | Render |

### 8.5 Telemetry and alerting

| Name | Meaning | Set in |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | When set, `@oto/telemetry/register.ts` starts the OpenTelemetry SDK — this is the HyperDX (or other OTLP backend) switch | Render |
| `OTEL_EXPORTER_OTLP_HEADERS` | OTLP auth headers | Render |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | OTLP transport | Render |
| `TRACE_URL_TEMPLATE` | Template the Console uses to deep-link a trace id into the observability tool | Render |
| `SENTRY_DSN` | Optional; the error reporter is a no-op without it | Render |
| `ALERT_CHANNELS` | Comma list of alert channels (`console`, `email`, `webhook`) | Render |
| `ALERT_WEBHOOK_URL` | Generic HTTPS webhook for alerts (Slack / Discord / LINE Notify style) | Render |

### 8.6 Payments — 2C2P

**`docs/architecture/PAYMENT_GATEWAY.md` §4 is the authority** and carries the
meaning of each name; the `PGW_*` prefix replaces the `2C2P_*` names used in
earlier drafts because a leading digit is not shell-safe. All are set on the
api service only — **none ever reaches a box or a browser.**

- Provider and environment: `PGW_PROVIDER` (`2c2p` or `simulator`), `PGW_ENV`
  (`sandbox` or `production`), `PGW_BASE_URL`
- Credentials: `PGW_MERCHANT_ID`, `PGW_SECRET_KEY` (signs and verifies the
  HS256 JWT envelope)
- Transaction shape: `PGW_CURRENCY_CODE`, `PGW_QR_CHANNEL_CODE`, `PGW_QR_TYPE`
  (`RAW` so the display renders the QR locally), `PGW_PAYMENT_EXPIRY_MIN`,
  `PGW_INVOICE_PREFIX`
- Return and notification: `PGW_BACKEND_RETURN_URL` (the
  `POST /webhooks/2c2p/payment` endpoint), `PGW_FRONTEND_RETURN_URL`,
  `PGW_WEBHOOK_SECRET` (a path token — a cheap filter, **not**
  authentication; the JWT signature is)
- Inquiry poller: `PGW_INQUIRY_INTERVAL_S`, `PGW_INQUIRY_MAX_MIN`
- Payment Maintenance (refunds and voids, a **different host**):
  `PGW_MAINT_BASE_URL`, `PGW_MAINT_PRIVATE_KEY`, `PGW_MAINT_2C2P_PUBLIC_KEY`
- Ours, not 2C2P's: `PAYMENT_PENDING_MIN` — minutes after which an unresolved
  attempt is flagged on Failures (default 10)

A missing `PGW_MERCHANT_ID` or `PGW_SECRET_KEY` **silently selects the
simulator** and says so in the startup log and on the Console's Integrations
page — so CI and a fresh checkout never need the sandbox.

### 8.7 SMS

| Name | Meaning | Set in |
|---|---|---|
| `SMS_ADAPTER` | `twilio` on every deployment, staging included. `console` (logs a phone **hash** and the message) only where `DEPLOY_ENV=local`; the api refuses to boot with it anywhere else | Render, .env |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Twilio credentials. All three required when the adapter is `twilio` — a missing one throws at boot, so a deployment does not start without a way to reach a phone | Render |

### 8.8 Box agent and edge thresholds

| Name | Meaning | Set in |
|---|---|---|
| `BOX_OFFLINE_AFTER_S` | Heartbeat silence during opening hours before a box is called offline (default 180) | Render, .env |
| `PAIRING_CODE_TTL_S` | Display / kiosk / booth pairing-code lifetime (default 600) | Render, .env |
| `SYNC_STALE_AFTER_S` | Oldest unacked outbox age that opens an alert while a box is online (default 900) | Render, .env |
| `SYNC_BATCH_MAX_EVENTS`, `SYNC_BATCH_MAX_BYTES` | Batch caps (200 events / 1 MB) | Render, .env |
| `BOX_STORE_DRIVER` | `postgres` (cloud virtual box, `edge` schema) or `sqlite` (Pi) | Render, .env |
| `MIN_SUPPORTED_AGENT_VERSION` | Below this an agent is alerted and refused new bundles | Render |
| `ROLLUP_INTERVAL_S` | How often the analytics rollup runs (15 minutes on staging, so a demo sale reaches Radar) | Render |

### 8.9 OTO App (Docker service)

Names taken from
`docs/architecture/intake-2026-09-19/01-oto-app-backend.md` §4, grouped as
that note groups them. All set on the `oto-app` Render service.

- Boot (the app **throws** without these): `DATABASE_URL`, `APP_ENV`,
  `STORAGE_ENV_PREFIX`, `OBJECT_STORAGE`
- Runtime: `PORT`, `NODE_ENV`, `TZ`, `LOG_RESPONSE_BODY` (**must be
  `false`** — it otherwise logs every JSON response body)
- Session and token secrets: `SESSION_SECRET`, `SESSION_PEPPER`,
  `KIOSK_CODE_PEPPER`, `PIN_FINGERPRINT_SECRET`,
  `KIOSK_IDENTIFICATION_TOKEN_SECRET` (the last has a per-process random
  fallback, which is why the service must run one instance)
- Storage: `S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET`, `AWS_S3_REGION`, plus a new
  `S3_ENDPOINT` added to the four `S3Client` constructions so they reach the
  platform bucket
- PDF rendering: `PUPPETEER_EXECUTABLE_PATH`
- Face clock-in (off on staging, Open decision 29): `USE_AWS_REKOGNITION`,
  `AWS_REKOGNITION_COLLECTION_ID`, and our flag `OTOAPP_FACE_CLOCKIN`
- AI: `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_OPENAI_BASE_URL`
  (renamed off the Replit convention during the lift)
- Notifications: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_VERIFY_SERVICE_SID`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASS`, `EMAIL_FROM`
- Accounting: `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` (sandbox only this
  sprint)
- Directory API: `HR_DIRECTORY_API_KEY`, `DIRECTORY_API_RATE_LIMIT_*`
- Observability: `SENTRY_DSN`, `APP_VERSION`, `APP_CHANGE_ID`, and the
  build-time `VITE_*` names
- Seeding: `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`
- Ours, added by the lift: `OTOAPP_LEGACY_LOGIN` (staging: off — the legacy
  Passport-local form is for the cutover rehearsal only)
- **Removed during the lift:** the Replit-specific names
  (`DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PUBLIC_OBJECT_SEARCH_PATHS`,
  `PRIVATE_OBJECT_DIR`, the three `GCS_*`, `REPL_ID`, `REPLIT_DEV_DOMAIN`,
  `REPLIT_DEPLOYMENT`), the dev-import pair (`DEV_IMPORT_KEY`,
  `PRODUCTION_DATABASE_URL`) and the dead `OTO_CORE_API_*`.

### 8.10 Radar (Docker service)

Names from
`docs/architecture/intake-2026-09-19/05-radar-api-auth-env-schema.md` §6, plus
what S2-18 adds. All set on the `radar` Render service.

- Boot: `DATABASE_URL` (a **direct** connection — Radar uses session-level
  advisory locks and creates tables at runtime), `PORT`, `NODE_ENV`, `TZ`,
  `LOG_RESPONSE_BODY` (**`false`**)
- Pisell / Floresta: `FUNTOPIA_CLIENT_ID`, `FUNTOPIA_CLIENT_SECRET`,
  `FUNTOPIA_ACCESS_TOKEN`, `FUNTOPIA_API_URL` — **only the owner has these
  (Replit Secrets)**; the client secret is also what the deleted
  push-to-production route leaked
- Papaya / Chalong: `PAPAYA_RECEPTION_TOKEN`, `PAPAYA_RESTAURANT_TOKEN` —
  likewise
- Keys: `SPIN_WIN_REDEEM_KEY`, `OTO_RADAR_MARKETING_API_KEY`
- AI: `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_OPENAI_BASE_URL`
  (two name references in `routes.ts` need correcting during the lift)
- Added by S2-18: `FUNTOPIA_MODE` and `PAPAYA_MODE` (`fixture` on staging,
  `live` when the credentials arrive), and the platform summary endpoint the
  `oto_pos` source adapter calls
- **Removed:** `STAFF_PASSWORD` (it gates nothing), the Replit and dead-GCS
  names, and the Sentry DSN that must be rotated

### 8.11 Inbox

The Inbox prototype has no secrets and no channel code. This sprint adds
only what the read-only shell and the console adapter need; live channel
credentials (WhatsApp Business / LINE OA / Instagram / email) are Sprint 3 and
are listed there by **kind**, never by value.

### 8.12 The boot-refusal rule

`apps/api` **refuses to start** on a configuration that does not belong to the
deployment it is running as (`assertProductionSafe`, `apps/api/src/env.ts`).
Three refusals, keyed on two different variables, because there are three
different mistakes — `apps/api/test/boot-guard.test.ts` covers each:

- **`NODE_ENV=production`** — a development default: `DATABASE_URL` pointing at
  localhost or still carrying the `oto:oto` credentials, the object-storage
  access key or secret still the demo value, `COOKIE_SECURE` false. The failure
  it prevents is quiet: a service that starts happily against the wrong
  database and only reveals it once real data is in it.
- **`DEPLOY_ENV=production`** — a setting that makes a deployment a playground:
  `OPS_TEST_CONTROLS` set, or `SEED_PROFILE=staging`. Keyed on `DEPLOY_ENV` and
  not on `NODE_ENV` precisely because staging runs the production build and
  carries both of them deliberately.
- **`DEPLOY_ENV` anything but `local`** — `SMS_ADAPTER=console`, on staging as
  much as on production. A verification code written to a hosted log stream is
  two failures at once: a live credential where every log reader can see it,
  and a person who cannot finish setting up their account because the code
  never reached their phone. `buildSmsSender` refuses the matching mistake at
  the same moment — `SMS_ADAPTER=twilio` with any of `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` missing throws rather than falling back.

The same rule is why "Reset demo data" is platform_admin only, typed
confirmation, and audited `ops.demo_reset`.

## 9. Research index and conclusions

One paragraph per document: what it is, what it concluded, what an agent must
take from it. Read the document itself before relying on a detail — this index
exists so you know **which** document to open, not to replace it.

### 9.0 The 2026-09-20 conclusions, in one place

These are the newest answers. They close questions that earlier documents
still show as open, and they win.

| Question | Answer | Source |
|---|---|---|
| Which payment gateway? | **2C2P, not SCB direct.** The owner said "the SCB payment gateway" and then pointed at `developer.2c2p.com`: 2C2P is the gateway, SCB is the acquiring bank behind the park's merchant account. `PROJECT_CONTEXT.md` §7.2 therefore stands. An SCB Developer Portal application, if the park holds one, is added as a second `QrPayment` provider, never a replacement | `OWNER_DIRECTION.md` 2026-09-20; `research/2026-09-20-scb-direct-api-research.md` header; `PAYMENT_GATEWAY.md` |
| Rebuild the OTO App? | **No — it exists and is lifted, not rebuilt.** 796 routes, 184 tables, and weekly commits still landing on it; a rewrite forks from a moving upstream. One Docker service, handlers untouched, the platform session mapped in before Passport | `intake-2026-09-19/01-oto-app-backend.md` §10; `SPRINT_2_PLAN.md` S2-17 |
| Where does the scanner live? | **On the box, not the iPad.** The box reads the Zebra over HID (with an exclusive evdev grab) or USB-CDC and publishes scans on the station channel, so till, display, gate and kiosk all receive scans identically, online or offline | `DEVICE_INVENTORY.md` §4 D2, §9.2; `research/2026-09-20-device-research.md` |
| How does the gate work? | **The QR reader posts to us over HTTP; the HX-X1 controller talks serial.** The gate box hosts `checkCard`/`heartbeat`, answers `code "1"`/`"0"` with a short message, pulses a dry contact, and reads passage feedback over RS232/RS485 19200 N81. Occupancy counts passage events, never open commands | `DEVICE_INVENTORY.md` §6; `PROJECT_CONTEXT.md` §7.5 |
| What is revenue? | **Exactly what Radar's code computes** — formula v30 for Floresta-style branches, v21 for Chalong-style — recorded as `formula_version` on every summary row, with a parity test proving the platform rollup reproduces it | `OWNER_DIRECTION.md` 2026-09-20; `intake-2026-09-19/03-…` and `04-…`; Open decision 15 |
| What are the prices, the tax rules and the receipt layout? | **The prototype's code.** No accountant session now: the prototype's price list and tiers are the definition, its `lib/tax.ts` order is the tax definition captured in regression fixtures, and its receipt component is the layout source. Corrections arrive later as data | `OWNER_DIRECTION.md` 2026-09-20; Open decisions 16, 22, 23 |

### 9.1 `docs/briefs`

**`OWNER_DIRECTION.md`** — a running record of what the owner decided in
conversation, newest first. It is the top of the precedence chain. Three
dated entries: 2026-09-19 (what the programme is; cutover as one switch with
import-compatible legacy tables; box theft is *not* a threat model, so the
brief's shared band key, Caddy DNS-01 on the box and full member cache stand;
one continuous AI-built run), 2026-09-19 later (the suite is five app
frontends plus a super-admin console; one central database; analytics from our
own database *and* Radar's history; till and display are separate devices; the
wheel must be admin-controlled; find env **names**, not values), and
2026-09-20 (the Sprint 2 widening summarised in §9.0). Take from it: the order
of work, and the fact that any design review recommendation premised on box
theft is overruled.

**`PROJECT_CONTEXT.md`** — the target system, and the document Sprint 2 is
designed *for*. Fourteen sections: the product (§1), the delivery plan (§2 —
Sprint 2 finishes all remaining software on staging behind simulators, so
**nothing may block on hardware or a third-party account**), topology (§3),
station boxes (§4), the iPad POS (§5), the network (§6), devices and adapters
(§7.1 terminals, §7.2 2C2P QR, §7.3 printers, §7.4 scanners, §7.5 gate, §7.6
kiosk), the offline model (§8), hosting (§9), business rules gathered since
the plan (§10 — tier is a member property with no tier selector at checkout,
cash management added, settlement export, no facial recognition anywhere,
LINE in scope), the booth (§11), data migration (§12), what is explicitly not
built (§13) and the Sprint 2 execution shape (§14). Everything marked
**Decided** is settled; everything marked **Open** needs the owner and ships
with a safe default.

**`POS_BACKEND_LOGIC.md`** — the previous developer's v3.0 extraction of the
prototype's rules into backend requirements, twenty sections each ending in
"Backend requirements": tenancy and what is global vs per-branch (§1.2),
identity and tiers (§2), the pricing model with worked examples that must hold
(§3.2), the tax and service-charge engine and its computation rules (§4.2),
F&B (§5), the wallet-versus-promo distinction (§6), gate and asymmetric
occupancy (§7.2), supervision, consent and pickup authorisation (§8), events
(§9), booking and redemption (§10), inventory (§11), shared input components
(§12), messaging (§13), reporting and tax export (§14), benefits (§15), auth
and lock (§16), devices and printing (§17), **known prototype fakes not to fix
in the front end** (§18), a suggested build order (§19) and the design
principles worth preserving (§20). It **ranks equal with the prototype code**;
where they differ the code wins.

**`AGENCY_PROPOSAL.md`** — a 2026-09-20 capture of the delivery proposal site:
24 features, 121 stories, 33 workflows, a 20-week roadmap, and its own
technical claims (SvelteKit + Python + AWS, which the owner has since
replaced). Its **§6 is the contract-scope list** — fourteen groups, 6.1
accounts through 6.14 customer messaging — of what the proposal shows as not
yet built, mapped ticket by ticket in the Sprint 2 plan's "Contract coverage"
table. Its **§7 is sixteen open questions** of its own (is the story list the
contract; the stack; payments; face identification; which five languages;
messaging channels and providers; the accounting provider; which workflows
must work offline; hardware coverage; modules outside the proposal;
supervision values; benefit policy; wallet expiry; online booking rules; three
sitemap-only items; the timeline). Treat it as **scope, never design**, and do
not start S2-17c until the owner confirms the list (Open decision 30).

### 9.2 `docs/architecture`

**`ARCHITECTURE.md`** — the Sprint 1 decisions restated, the verified
prototype layout, the glossary trap (**"operator" means the tenant in the new
schema and the logged-in staff member in the prototype**), the entity diagram,
the idempotency pattern, and **§10, the decisions log D1–D10**. D1 (the ticket
package keeps the prototype's per-tier shape, not `CLAUDE.md` §4's flat
columns), D3 (the tax engine follows the prototype's rate/category/mode
model), D5 (free adults count per cart line, not per child) and D8 (the
`session.pending_lookup_phone` channel, explicitly flagged for replacement)
are the ones Sprint 2 builds on. Every new decision is appended here.

**`PLATFORM_PLAN.md`** — the suite-level target architecture (proposed
2026-09-19, awaiting approval). §1 app inventory with the build-vs-lift
verdict (POS build; OTO App and Radar lift; booth rebuild; launcher and
console new); §2 target shape; §3 the central database, schema per app, one
login per service, **no foreign keys from platform tables into lifted
schemas**, legacy schemas stay import-compatible; §4 sign-in, tokens and
permissions (and the note that on temporary domains the parent-domain cookie
becomes a **signed hand-off**, which is the permanent mechanism); §5 analytics
continuity — one summary per branch per day with a **per-branch source switch
date**, legacy days frozen, and the list of facts the POS must record from the
first sale; §6 the station-session model for till and display; §7 nine backend
rules (local-first, facts up / state down, scarce things are the exception,
bounded idempotent sync, one cloud write path, separate failure domains,
dashboards never read live sales tables, explicit time, every box reports);
§8 the booth; §9 the console; §10 the security work the lift performs; §11 the
environment variables to provision; §12 workstreams in dependency order; §13
the two-stage cutover; §14 what is needed from the owner.

**`DEPLOYMENT_TOPOLOGY.md`** — why the suite is many small deployables. It
encodes the owner's hard requirement: **one repository; the whole system must
never go down at once; deploying one app must not affect the others.** Seven
numbered items: every frontend is its own static site with build filters;
backends split by what must not fail together (`edge` / `api` / one per lifted
app / `worker`); subdomains not paths (no shared reverse proxy, and isolated
browser storage and service workers, which matters for the POS PWA); **item 4
— one sign-in, the cookie set on the parent domain, "needs a real domain:
`*.onrender.com` cannot share cookies"**, which is exactly why Sprint 2 uses
the hand-off token; fence the one shared dependency (a login per service with
its own connection limit and statement timeout); migrations never break a
running neighbour (additive first); and the park does not depend on any of it
minute to minute. Plus a "what goes down with what" table and the refinement
that a lifted app is **one** deployable running **one always-on instance**.

**`EXISTING_SYSTEMS.md`** — what the park actually runs, verified
2026-09-19 against the exports, the production schema and the git histories.
One tenant, three branches (Central Floresta, Robinson Chalong, Head Office),
72 login users, 69 employees. Pisell at Floresta and Papaya at Chalong are two
different third-party POS systems, both to be replaced. The OTO App runs on
**AWS App Runner, not Kubernetes**, and the RDS catalog called `oto_staging`
**is the live data**. Radar and the wheel run on Replit with their own
databases and **no login at all**. There is **no sales-booth or voucher-booth
feed** — "Sales Booth" is a marketing-channel label derived from Pisell
voucher data. The Radar database file we hold is a structure listing, not a
restorable dump. And **the live system does use biometrics** (60 of 69
employees clock in by face), which must be decided before cutover. Its
"Corrections to earlier assumptions" table overrides `CLAUDE.md` §1.

**`POS_RULES_RECONCILIATION.md`** — the reconciliation of the four POS
sources into one citable vocabulary. §1 is twenty conflicts C1–C20 with the
resolution for each (C1 face login banned; C4 every catalogue table becomes
branch-scoped; C6 a product's tax override points at a taxable *category*, not
a rate, retiring the numeric `tax_override`; C8 the gate mechanism follows
`PROJECT_CONTEXT` while the group rule survives for kids' bands; C10 events
stay mastered by the OTO App; C14 a lock is not a sign-out; C18 payment is
split-capable with one canonical card token; C20 a station channel on the box
replaces the pending-lookup session field). §2 is rules R-01 to R-119 with
`✔` marking what Sprint 1 already built. §3 lists the schema deltas the rules
imply. §4 lists the ten questions the document itself raises. **Cite `R-nn`
and `C-nn`; do not re-derive.**

**`DEVICE_INVENTORY.md`** — the park's real devices, written from the
hardware reference, the four gate documents, the two terminal specifications
and the web research. §1 network; §2 the eleven devices with models, protocols
and addresses (and the corrections research forced on rows 1, 4 and 8–11);
§3 the flows; §4 the reference's open decisions D1–D6 and how the platform
resolves them; §5 the ECR facts for the NEXGO and PAX; §6 the gate — the
reader's HTTP contract, HX-X1 wiring and settings, the GE-X2 serial frames,
what the simulator must reproduce, and what the supplier never answered;
§7 the voucher, wristband and receipt design references; §8 the adapter
interfaces it maps onto; and **§9 the per-model web research**, which is the
section to read before writing any adapter. §9 covers §9.1 the 4B-2082A
wristband printers, §9.2 the Zebra DS22 scanner, §9.3 the Welltech G4, §9.4
the Xprinter XP-80 family, §9.5 the NEXGO and PAX physical ECR link, §9.6 the
box host (Pi 5 versus Intel mini PC) and §9.7 what each ticket takes from it —
each device with an **adapter-parameters block**, a **"simulator must
reproduce"** list and a **"confirm on site"** list. Its `[inferred]` and
`[unconfirmed]` markers are hypotheses, not facts, until the bench check.

**`PAYMENT_GATEWAY.md`** — the 2C2P integration, written from the public
documentation with a source URL on every fact and **UNCERTAIN** on anything
the documentation does not settle. §1 what the gateway is and is not used for
(**not** card-present, **not** offline, **not** in-person wallets); §2 the API
facts — products and endpoints, the HS256 JWT envelope, Payment Token, Do
Payment for a Thai QR, the backend notification, Payment Inquiry, Payment
Maintenance, the Redirect API, sandbox behaviour, the validation constraints
and settlement/reconciliation; §3 our integration design — the shape, the
payment-attempt lifecycle, `invoiceNo` one per attempt, the webhook endpoint,
the inquiry poller, the display, cancel/late/duplicate handling, **what is
logged and what never is**, the gateway simulator, the booking site and the
settlement export; §4 the `PGW_*` variables; §5 the checklist of what the
owner must supply for sandbox and for production; §6 the SCB alternative; §7
sources. No credential of the park's appears in it. **Read it; do not
re-research 2C2P** — it even records that 2C2P serves a markdown copy of every
documentation page and an index at `llms.txt` for a later agent.

**`research/2026-09-20-device-research.md`** — the web-research pass behind
`DEVICE_INVENTORY.md` §9, with a source on every claim and explicit
`[inferred]`/`[unconfirmed]` markers. Per device it gives identity and specs,
command language, network configuration, an **adapter-parameters YAML**, a
**"simulator must reproduce"** list and an **"unknowns to confirm on site"**
list. Its load-bearing conclusions: the wristband printers are TSC clones and
**TSPL2 is native** (answering open decision D1), with **no Thai code page**,
so Thai must be rasterised host-side; the scanner belongs on the box, read by
evdev with an exclusive grab or switched to USB-CDC; the Welltech G4 is
Xprinter XP-C260 hardware with `DLE EOT` real-time status and partial cut
only; the NEXGO's only wired port is micro-USB OTG (its "LAN dock" is a Wi-Fi
router, so the terminal is **not** on the park LAN) and the PAX gets Ethernet
only from a -BE/-BM base while its ECR link is Type-C CDC-ACM; and the box
host needs the ModemManager udev fix, `/dev/serial/by-id` paths and one TCP
session per printer.

**`research/2026-09-20-scb-direct-api-research.md`** — **reference only.** It
researched the SCB Developer Portal's direct PromptPay and card QR APIs and
concluded they would work (dynamic Tag-30 QR, `/v2` for a single-use expiring
QR) but with real gaps: **no usable public refund or void API**, **no
settlement or report API**, and an **unsigned webhook** that must be verified
by inquiry before goods are released. The owner's 2026-09-20 decision makes
2C2P the gateway, so this note is kept only in case the park also holds an SCB
application, in which case SCB becomes a second `QrPayment` provider.

**`design-review-2026-09-19/`** — a multi-agent read-only review run before
Sprint 2: `00-codebase-map.md` (four engineer maps of what Sprint 1 actually
contains, with the gap and defect lists that became S2-01), then six paired
designs and critiques — 01 suite and permissions, 02 central data merge, 03
box agent and sync, 04 offline trust and money, 05 iPad/box networking, 06
ops, scale and delivery — and `07-integration-contradictions-gaps-questions.md`
reconciling them (26 contradictions with resolutions, 17 missing topics, a
14-step foundation order, 16 risks and 24 owner questions). **Read its README
first:** it lists what the owner has since overruled — every recommendation
that exists only because a box might be stolen (per-box band keys, moving
certificate issuance off the box, minimising the member cache, PIN-only
verifiers, disk encryption), plus the week-1 hardware spike and the
gated-milestones advice. What remains valid regardless: the Sprint 1
foundation gaps, moving sale and tax logic into shared integer-satang code,
the sync design that cannot lose or duplicate an event, child-safety data
rules during the merge, **the wristband is a thin strip carrying a 1D barcode
that cannot hold a 64-byte signature** (07), and power and clock on the Pi.
Note that paths inside these documents use the pre-restructure layout.

### 9.3 `docs/architecture/intake-2026-09-19`

**`README.md`** — the index and the handling rules for the three Replit
exports and two database files. **Confidential**: it describes unfixed
weaknesses in live systems. It records that both database files were exported
from catalog `oto_staging` and hold live data — **the environment labelled
"staging" upstream is production** — and lists what is still missing (a real
`pg_dump` of Radar's published database and of the wheel's, the Pisell/Papaya
credentials, DNS ownership, the S3 bucket contents, the four OTO App secrets).

**`01-oto-app-backend.md`** — the OTO App server. Express 4 + Passport-local +
Drizzle, **796 routes** (517 in one 25,504-line closure), `storage.ts` 12,253
lines, **184 tables** with zero export-vs-production drift, managed by
`drizzle-kit push --force` rather than migrations, no unit tests. **§10 is the
re-hosting work list** this plan's §6.1 follows: hosting, own schema and
role, object storage, secrets, Replit-specific pieces — then the eight-step
sign-on swap. §4 is the environment-variable name list reproduced in §8.9. Its
warnings matter more than its shape: credentials in git history, a public
endpoint returning children's PII by phone, unauthenticated signed-contract
PDFs, plaintext credential vault, full JSON bodies logged.

**`02-oto-app-frontend.md`** — the OTO App client: 122 routes, ~129k lines,
two merged Replit apps with ~9,000 lines of unrouted pages. Every URL assumes
same-origin (418 `apiRequest` plus 246 raw `fetch`, some omitting
credentials), which is why the lift keeps UI and API in **one** deployable.
**§8 is the suite-seams table** — children, camp registration, drop-off/nanny,
BEO billing and event-booking POS references, staff vouchers (server routes
exist but nothing calls them, so redemption is broken today), analytics into
Radar, and the Directory API for cashier identity. It also lists exactly what
the sign-on identity payload must carry.

**`03-radar-pisell-pipeline.md`** — the Floresta/Pisell pipeline, all 9,206
lines of it: one signed endpoint, five report types, thirteen raw-SQL tables.
Five findings to read before touching analytics: stored history is
**incomplete**; a formula-version bump can **zero out history** because the
read path self-heals without checking raw rows exist; **two VAT bases are
mixed and the code never applies VAT** (totals VAT-inclusive, lines
VAT-exclusive, ratio 1.07) with the difference hidden in an "Other
(Unattributed)" bucket the UI filters out; no auth on any endpoint; and the
push-to-production route leaks the client secret. It also documents the
marketing-channel vocabulary (the wallet-pass code registry, the face-value
seeds, and the "Sales Booth" versus "Sales-booth" drift that produces two
buckets).

**`04-radar-papaya-pipeline.md`** — the Chalong/Papaya pipeline: one endpoint,
a static bearer token per outlet, cursor pagination removed after it silently
lost about a quarter of daily orders, days now cut into 2-hour slices. Chalong
is structurally weaker than Floresta — no customer types, vouchers, SKUs, unit
prices, refund audit or cash reports — and its revenue definition changed five
times in two days before settling on the order total. Cancelled item lines are
counted everywhere except the Events row builder. `resync-date` is
destructive.

**`05-radar-api-auth-env-schema.md`** — Radar's application shell: **107
routes, 96 of them public**, `requireStaff` never applied. §9 is the work list
this plan's §6.2 follows, including the two traps that will otherwise cost a
day each: **include the `drizzle.__drizzle_migrations` rows in the restore** or
the boot migrator creates 107 inherited HR tables, and the dump we hold is a
**drizzle-kit introspection, not restorable SQL**. §6 is the environment-name
list reproduced in §8.10.

**`06-radar-frontend.md`** — the dashboard: five routes, no authentication,
one 15,354-line page of which ~12 % is dead. **The forecast model, all
targets, the pace forecast, the planner, the holiday table and the two-branch
merge are computed in the browser from hard-coded 2026 constants**, several of
which look wrong. §3 says which metric is server-computed and which is not;
§7 is the reuse list and the recommendation that became our analytics
contract: **one branch-parameterised `GET /analytics/summary`** with a single
hourly contract, retiring the browser-side merge.

**`07-radar-booths-spin-vouchers.md`** — how non-POS data reaches Radar, and
the correction that **there is no booth entity and no voucher-booth concept**.
The wheel integration exists in two generations and three stores with two
disjoint reports; codes are 4 digits, never expire, are never recycled, and
have a 10,000-code lifetime ceiling. §9 lists what must be preserved at
migration (the whole spin ledger, the reserved legacy numerics, all campaign
QRs and the campaign UUIDs already printed on posters — and the warning that
`booth_events` payloads contain phone numbers) and sketches the target design
this sprint builds: one voucher-definition table, one voucher-instance table,
redemption inside the POS sale, the booth as a station with its own
credential, and marketing channel as a first-class table.

**`08-wheel-fortune-game.md`** — the Lucky Wheel itself. The outcome is
chosen **client-side** with `Math.random()` at button press; slices are equal
so weights do not affect geometry; there is no identity and no limit of any
kind; **nothing is printed** despite the owner's prize list saying every prize
is a printed voucher; and any pointer event or keypress starts a spin — which
a USB scanner typing digits and Enter would trigger. §10 is the carry-list
(`Wheel.tsx`, the press state machine, `ResultModal`, `sound.ts`,
`kiosk.css`, the boot watchdog, the `#debug` overlay, the Puppeteer TV tests)
and the explicit do-not-copy: its `pnpm-workspace.yaml` overrides strip every
non-linux-x64 native binary, so the repo will not install on Windows, macOS or
an arm64 Pi.

### 9.4 `docs/features`

Each page is one app: purpose, intake (source path, export date, stack,
tables, what is Replit-specific, what secrets were found), an integration plan
(deployables, login, data, launcher tile), a **status table**
(`Area | State | Notes` with states not started / in progress / done / mock)
and open questions. `README.md` indexes them; `_TEMPLATE.md` is the skeleton
for the next import. **The status table is the quickest honest answer to
"what exists".**

- **`pos.md`** — the till, customer display, back office and `/book`. Sprint 1
  areas are `done`, the rest `mock`, each mapped to its S2 ticket. Points at
  the prototype's own design notes (`imports/oto-pos/replit.md`,
  `.agents/memory/`, `BACKEND_REQUIREMENTS.md`) and the known gaps in
  `design-review-2026-09-19/00-codebase-map.md`.
- **`booth.md`** — the Lucky Wheel, and the **specification for S2-07**. It
  carries the spec v2 addendum, which is newer than `PROJECT_CONTEXT.md` §11
  and wins over it: **random 10-character booth-prefixed codes** minted on the
  box (not 4-digit), no idle video, booths managed like stations, printed
  80 mm vouchers, server-side-only redemption with a hard single-use block,
  staff PIN/badge sign-in that **must never take the booth down**, and
  inventory-linked prizes (deferred to Sprint 3).
- **`console.md`** — the launcher and the Console as two products: the
  launcher is the front door with a tile per app; the Console is the control
  room (people and access, organisation, devices, activity, analytics, health,
  integrations) where day-to-day work never happens. Domain settings stay with
  their app. Records that the Sprint 1 accounts, roles and audit panels
  **move** out of the POS admin into the Console (Sprint 3 in this plan).
- **`oto-app.md`** — the lift plan and the module list, the environment-name
  table, and a "security fixes applied during the lift" section. Note its
  data finding: **there is no customer, member or child table** — parents and
  children are free text across seven tables — which is why the POS seam is a
  view and why seeding members from check-in history is an owner question.
- **`oto-radar.md`** — Radar's lift plan, its comparison table of the two
  revenue definitions (the one an agent must preserve when the POS becomes a
  third source), and the two blockers: **no real database dump** and **no POS
  source credentials**.
- **`inbox.md`** — the longest feature page and the **specification for
  S2-19**: the categories and teams, the assignment model, the
  Active/Handled-only rule, the AI handover list, the table-by-table schema,
  the nine permissions, the design language the shell must match, and the
  register of where the April–May briefs disagree with the later IT Brief
  (which wins). Confidential — the export is never committed.

### 9.5 `docs/progress` and `docs/qa`

**`STATUS.md`** — the landing page when resuming: where we are, what is
waiting on the owner, the next steps, the known defects to fix first, and the
working rules that are easy to forget. **`SPRINT_2_PROGRESS.md`** — the live
record of state (§1.2); at the time of writing its ticket log is empty because
nothing of Sprint 2 is built. **`SPRINT_2_PLAN.md`** — the ticket plan (§2).
**`SPRINT_1_PROGRESS.md`** and **`SPRINT_1_REPORT.md`** — the format to copy
and the record of what Sprint 1 delivered. **`docs/qa/TEST_CASES.md`** — the
test-case format (§5.2). **`docs/qa/jira-comments/`** — 24 worked examples of
the evidence-comment format, with their screenshots under `attachments/`.

## 10. Open questions register

There is **one** register, and it is not this file:
`docs/progress/SPRINT_2_PLAN.md`, section **"Open decisions"**. Every item
there ships with a default, so **no ticket is ever blocked waiting for an
answer**; items marked *unsourced default* are numbers no brief specified, and
the owner may change any of them at any time.

What is in it, in short:

- **Items 1–21** — the sprint's design defaults: the sign-on shape, the
  Console as its own deployable, tier handling at checkout, spin eligibility,
  booth management's home, the schema map, one api instance running edge and
  jobs, the new manager gates, the launch prize list, the app tiles, offline
  sign-in, child photos and retention, overstay billing, wallet expiry and the
  offline cap, the revenue definition (**resolved**), receipt numbering
  (**resolved**), monitoring and alert channels, legacy codes and the Radar
  dump, the remaining vendor documents, the business day start, and the
  collected unsourced defaults.
- **Items 22–28** — the questions `POS_RULES_RECONCILIATION.md` §4 raises,
  each with the default that ships: inclusive-tax decomposition and rounding
  (**resolved**: the prototype's `lib/tax.ts` order is the definition),
  reference prices and expat derivation (**resolved**: the prototype's price
  list), Telegram, event check-in ownership, kids' bands at the exit gate,
  predictive reorder, and the benefit QR source.
- **Items 29–32 are the newest**, added with the 2026-09-20 widening, and are
  the ones most likely to change a ticket:
  **29** the OTO App's face clock-in (kept behind a flag, off on staging,
  until the owner decides; re-enrolment on new infrastructure is part of the
  decision);
  **30** the contract feature list — the owner confirms or trims
  `AGENCY_PROPOSAL.md` §6 **before S2-17c starts**, and each confirmed item
  becomes a Jira sub-task;
  **31** the Inbox brief conflicts — the schema follows the IT Brief as the
  latest word, and the owner confirms before live channels are built;
  **32** the 2C2P merchant credentials — the sandbox merchant id and secret
  (or the public demo pair for the first test), the enabled QR channel and the
  return URLs, into `.env` as `PGW_*`.

A second list, **`docs/briefs/AGENCY_PROPOSAL.md` §7**, holds sixteen
questions the delivery proposal itself raises — the story list as contract, the
stack, payments, face identification, which five languages, messaging channels
and providers, the accounting provider, which workflows must work offline,
hardware coverage, modules outside the proposal, supervision values, benefit
policy, wallet expiry, online booking rules, three sitemap-only items, and the
timeline. Several are already folded into Open decisions 29–31; the rest are
contract-scope questions for the owner, not build blockers.

`docs/architecture/PLATFORM_PLAN.md` §14 and `docs/progress/STATUS.md`
("Waiting on the owner") carry the access and data requests: the OTO App
`pg_dump`, real dumps of Radar's and the wheel's databases, the Pisell /
Papaya / spin / marketing / OpenAI values from Replit Secrets **plus agreement
not to cancel Pisell or Papaya before the history export**, the S3 bucket
contents, DNS ownership, the four OTO App continuity secrets, a Render paid
account and a staging domain, the remaining vendor device manuals, and a Pi 5
on the desk.

**Rule for adding a question.** If you are about to write a rule that exists
in neither the prototype nor the documents in §2, do not write it. Instead:

1. add it to `SPRINT_2_PLAN.md` "Open decisions" with the next number, stating
   the question, **the default you are shipping**, and whether the default is
   sourced or *unsourced*;
2. mirror it in `SPRINT_2_PROGRESS.md` under "Questions for the owner" and
   "Assumptions made";
3. ship the default so the ticket is not blocked;
4. if the default would freeze a stored fact — a ledger column, a code format,
   a money rule — **stop and ask instead** (§1.4).

## 11. Definition of done

The authority is `docs/progress/SPRINT_2_PLAN.md` "Definition of done for the
sprint", plus each ticket's own Acceptance criteria. This is the short form.

### 11.1 Per ticket

- [ ] Every acceptance criterion on the ticket is checked, and every QA step
      has been performed and tagged **QA (UI)** or **Dev evidence** (at most
      one dev-evidence step per story).
- [ ] The prototype logic it ports is cited by file and function in the
      progress log; anything the prototype lacked is attributed to the plan or
      to a recorded decision.
- [ ] Migration generated, SQL inspected, expand/contract from `0004`, applies
      **twice cleanly from empty**; every FK indexed.
- [ ] Every write goes through a service with `withTx`, an audit row inside
      the transaction, and idempotency (atomic claim + client id + a unique
      business key).
- [ ] Every route has zod schemas, a permission route option and an OpenAPI
      description; the route-enumeration test passes.
- [ ] Tests exist and pass: unit, integration, redaction where PII is
      touched, Playwright where a flow changed.
- [ ] Nothing in a log line, span, error report or stored adapter payload is
      PII.
- [ ] Its audit and `ops_run` evidence is visible on Activity / Failures /
      Health.
- [ ] UI changes respect `CLAUDE.md` §7; additions and removals listed under
      "UI additions".
- [ ] New environment variables are in `.env.example` **by name**, and on the
      Integrations page as presence flags.
- [ ] Feature page, `ARCHITECTURE.md` decisions log and
      `SPRINT_2_PROGRESS.md` updated; commits follow `CONTRIBUTING.md` with no
      attribution lines.
- [ ] An evidence comment is posted on the Jira story in the Sprint 1 format,
      with screenshots attached. **The issue's status is not changed.**

### 11.2 For the sprint (S2-16)

- [ ] Every story S2-01a..S2-19 merged with its criteria checked and its
      evidence comment posted.
- [ ] `pnpm install && docker compose up -d && pnpm db:migrate && pnpm db:seed
      && pnpm dev` brings up API, POS, launcher, console, booth, the Inbox
      shell and — with Docker — the OTO App and Radar, from a clean checkout;
      `pnpm db:migrate` runs twice cleanly from empty.
- [ ] CI green on the tagged commit, including the route-enumeration,
      redaction (with pg-error and terminal fixtures), OTel span/log,
      idempotency-concurrency, sync idempotency / poison / epoch,
      `schema_version` replay, boot-refusal, spin-distribution, business-date
      and pricing-regression tests.
- [ ] Full acceptance run (`docs/qa/SPRINT_2_ACCEPTANCE.md`) from a clean
      database on refreshed Render staging with zero open blockers;
      `seed:demo-day` reproduces the M5 demo in under ten minutes.
- [ ] Playwright smokes pass on the Render origins: launcher → station pick;
      till + display membership; cash ticket sale; 2C2P sandbox QR sale; booth
      spin → voucher → redemption; booking QR → gate; check-in → offline
      release; launcher → OTO App; launcher → Radar with a POS sale visible;
      launcher → Inbox shell.
- [ ] Non-functional checks recorded: the targets measured with k6 and a 24 h
      soak; the POS usable at iPad landscape and in the mobile shell; the
      console at 1280 px; the PWA loads offline; an api redeploy loses no open
      session or queued outbox; **the offline capability matrix passes row by
      row**; and no phone, name or child data appears in any log line or span
      (redaction test plus a manual grep of staging logs).
- [ ] Tag `sprint-2`; `SPRINT_2_REPORT.md` written;
      `SPRINT_2_PROGRESS.md` closed; `ARCHITECTURE.md` and this document
      current; every feature page and `STATUS.md` updated; the park's
      play-test guide issued with demo accounts delivered out of band.
