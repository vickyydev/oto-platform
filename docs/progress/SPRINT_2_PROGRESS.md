# Sprint 2 progress

## Status

- Current checkpoint: **S2-03 is complete and deployed.** Four services are
  live in the Render `staging` environment — api, POS, launcher and the
  Console — and the Console's four pages (Activity, Failures, Health,
  Integrations) read real rows from the deployment: the job register with
  each job's last run and expected interval, failed runs grouped by
  fingerprint, five integration states each derived from something real, and
  the audit log. 239 API tests green. S2-01a/b/c and S2-02 are done before
  it. See `DEPLOYMENT_STAGING.md`. Next: **S2-17a**, the OTO App on the
  central database — the last ticket before CP1.

- Jira: sprint **"Sprint 2 - Complete build"** (id 3) on board 1 of project
  SCRUM holds the 24 stories under four epics, with 16 sub-tasks; the
  pre-existing 177 issues were labelled rather than deleted. Keys and the
  full account of what was done: `SPRINT_2_JIRA_MAP.md`.
- Last completed step: S2-03 (SCRUM-190) — the telemetry package and its one
  redactor, request and operation logging, `ops_run` with fingerprint
  grouping, alerts with dedupe and flap suppression, the job runner and
  watchdog, the observability routes and the Console's four pages.
- Next step: **S2-17a** (SCRUM-192), the OTO App on the central database —
  `otoapp` schema, the hand-off sign-on in place of its own login, and user
  provisioning from the platform. Its source is now a working copy at
  `apps/oto-app/` (see `OPEN_QUESTIONS.md` §0). CP1 follows it.
- Resume instructions: read `docs/progress/STATUS.md`, then this file, then
  `docs/progress/SPRINT_2_PLAN.md` (the whole thing — it is the ticket
  source) and `docs/architecture/DEVELOPMENT_PLAN.md` §5 for the build
  recipe, plus `docs/briefs/OWNER_DIRECTION.md` (section 2026-09-20 wins).
  Branch off `main`, which carries everything through S2-02; commit per
  `CONTRIBUTING.md`, no attribution lines; never commit `imports/` beyond its
  READMEs. `pnpm test` needs no Docker — the API tests start an embedded
  Postgres per file.

## Done on 2026-09-20 (all committed)

- `docs/briefs/OWNER_DIRECTION.md`: new section "2026-09-20 — scope of Sprint
  2 widened; decisions changed" (order of work, launcher, payments = 2C2P
  sandbox for real QR with SCB as acquirer, devices from the real inventory,
  revenue/prices/receipts from the Replit code, agent process).
- `docs/progress/SPRINT_2_PLAN.md` revised: title/status/sources, sprint
  goal, milestones M0–M11, readiness rows for OTO App / Radar / Inbox /
  gateway, scope in/out, "Contract coverage" map (proposal §6 → tickets),
  design decisions (2C2P kept, foreign apps as own schemas, Radar contract,
  launcher design, adapters on real devices), S2-02 rewritten as the styled
  landing page, S2-10a/S2-12/S2-15a moved to the 2C2P sandbox and the real
  gate protocol, new tickets **S2-17 (OTO App a/b/c), S2-18 (Radar), S2-19
  (Inbox)**, execution order with S2-17a before CP1 and CP1–CP7, open
  decisions 10/15/16/22/23 resolved and 29–32 added, definition of done.
- `docs/architecture/DEVICE_INVENTORY.md` (new): LAN, the eleven devices with
  addresses/ids/roles, flows, the hardware note's open decisions D1–D6 and our
  resolutions, ECR facts, the full gate section (reader HTTP contract, HX-X1
  wiring/settings/faults, GE-X2 frames and passage feedback, simulator
  duties, unknowns), voucher/wristband/receipt design references; section 9
  (web research per device: TSPL2 for the 4B-2082A, DS2278 in CDC host mode
  on the box, XP-C260/XP-80 ESC/POS parameters, terminal cabling, host notes)
  folded in from `research/2026-09-20-device-research.md`, with sections 2
  and 4 corrected where the hardware note was wrong (beb9385).
- `docs/architecture/PAYMENT_GATEWAY.md` (new, 3f8827d): 2C2P API 4.3 facts
  with sources (JWT envelope, Payment Token, Do Payment on `PPQR` with the raw
  EMVCo payload, notification field names, inquiry codes, Payment Maintenance,
  Redirect API, sandbox, constraints, SFTP settlement file), our integration
  design, `PGW_*` variable names, the owner's checklist, the SCB direct API as
  the alternative provider; UNCERTAIN items listed (first: how the sandbox
  marks a PromptPay QR as paid).
- `docs/briefs/AGENCY_PROPOSAL.md` (new, 991 lines): the delivery proposal site
  captured in full (24 features, 121 stories, 33 workflows, roadmap), each
  story assessed against the OTO App export, §6 "what remains", §7 questions.
- `docs/features/inbox.md` (new): the unified-inbox import reviewed (briefs,
  design language, what exists, proposed `inbox` schema, env names, open
  questions); `docs/features/README.md` row added.
- `imports/_vendor-docs/`: the park's hardware reference copied (local only);
  README lists the gate documents and the voucher sample as received in chat.
- `docs/architecture/research/`: two research notes preserved from the
  interrupted research pass — device models (4B-2082A = 4BARCODE, Zebra
  DS2278 + CR2278 cradle, Welltech G4 = rebadged Xprinter XP-C260, Xprinter
  XP-80 family, NEXGO/PAX physical ECR links, Pi vs mini PC) and the SCB
  Developer Portal direct API (kept as the alternative provider).

### S2-01c — Render deploy of API + POS (SCRUM-188) — **code complete, deploy waiting on the owner**

Built by two parallel agents on Opus 5 and reviewed here. Commit `9f3488d`.

**`render.yaml`.** One staging environment, three resources, all in the
`singapore` region and all named `-staging`, so a production environment of
the same shape sits beside them later instead of colliding with them:

- `oto-api-staging` — a `standard` web service, not `starter`: argon2id on
  every sign-in and unlock makes this process CPU-bound, one container also
  carries `edge` and `jobs` (`PROCESS_ROLES=api,edge,jobs`), and Render's
  autoscaling starts at `standard`. One instance, health check on `/ready`,
  `TRUST_PROXY=1`, and `pnpm db:migrate && pnpm db:platform-sync` as its
  pre-deploy step. The scaling block that replaces `numInstances: 1` is
  written out beside it, commented, with the three things that must happen
  first — so it is not invented under pressure on a busy afternoon.
- `oto-pos-staging` — a static site that rewrites `/api/*` to the api, so the
  session cookie stays same-origin and dev and production are one code path.
  Nothing to size: a static site is built once and served from the CDN.
- `oto-db-staging` — Postgres 16 on `basic_4gb`, not the cheapest paid type.
  It is sized for work already scheduled: the S2-22 restore holds the 33 MB
  production dump twice while `pg_restore -j4` runs, the Radar and analytics
  rollups scan the sales tables beside the till's own queries, and the
  connection ceiling is what the api's commented `maxInstances: 3` is budgeted
  against (a pool of 10 per instance; 68 of 97 accounted for, written out in
  the file).

Plus a commented-out worker for when `jobs` splits out of the api — enabling
it means removing `jobs` from the api's roles, or the runner competes with
itself for its own locks.

Two findings worth keeping. `--prod=false` on the install is load-bearing:
`NODE_ENV=production` is set on the service and both `tsx` (the start
command's runtime) and `drizzle-kit` (the migrator) are devDependencies, so
without it the build succeeds and the start fails. And Render's blueprint
schema has **no PITR field** — point-in-time recovery is a property of any
paid instance type, so it is encoded as the paid plan plus a comment.

**CI.** A `deploy` job that runs only on a push to `main`, only after `ci`
passes, calls the Render deploy hooks, and **skips green** while the secrets
are unset — which they are until the account is connected.

**"Reset demo data".** Platform-wide caller, a typed confirmation in the
request body as well as the UI, one transaction, an `ops.demo_reset` audit
row. It deletes what a day of play produces — visits, bookings, sales,
payments, wallets, bands, stock levels and the members created during the
session — and keeps what the operator set up. Seeded demo families survive
by `created_via` (`import` from the seed, `pos` from the till), so the QA
lookups for `+66811111111` still find Mali and her two children. Known
residue, recorded rather than hidden: a child added to a *seeded* member
during play survives, because `pnpm db:seed` skips a member that exists; a
clean demo set is a re-seed against a fresh database.

**`DEPLOY_ENV`, the conflict the blueprint exposed.** DEVELOPMENT_PLAN said
the api should refuse to boot when `NODE_ENV=production` and any of
`OPS_TEST_CONTROLS`, `SEED_PROFILE=staging` or `SMS_ADAPTER=console` is set —
but the staging service is `NODE_ENV=production` with exactly those three,
because staging runs the production *build* against throwaway data. Taken
literally, staging could not start. Resolved with a separate discriminator:
`DEPLOY_ENV=local|staging|production`. A development default is still
refused on any deployment; the two playground settings — `OPS_TEST_CONTROLS`
and `SEED_PROFILE=staging` — are refused on `DEPLOY_ENV=production` only,
because staging is entitled to both. `SMS_ADAPTER=console` turned out not to
belong in that group at all: it is refused on every deployment, staging
included (see below). `apps/api/test/boot-guard.test.ts` covers each refusal —
seven cases for the development defaults under `NODE_ENV=production`, eight
for the staging-versus-production split and the SMS adapter.

**Still needed from the owner:** a Render API key in the gitignored `.env`; an
S3-compatible bucket, because there is no MinIO on Render and
`assertProductionSafe` refuses to boot while the object-storage keys are still
the demo ones; and a Twilio sender. The SMS credentials are no longer
optional. Staging sends real codes to real phones: `buildSmsSender` throws at
boot when `SMS_ADAPTER=twilio` and any of `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN` or `TWILIO_FROM` is missing, and `assertProductionSafe`
refuses `SMS_ADAPTER=console` whenever `DEPLOY_ENV` is not `local` — so the
service does not start until all three are set. The reason it stopped being a
staging convenience: a verification code in a hosted log stream is a live
credential where every log reader can see it, and a delivery path exercised
only in production is a delivery path nobody has tested. Sentry is still
optional — the error hook is a no-op while `SENTRY_DSN` is empty.

## Pending — in this order

_Plan v2 is complete as of commit set 5dabf05 → this one: SPRINT_2_PLAN.md,
DEVELOPMENT_PLAN.md (1,849 lines), PAYMENT_GATEWAY.md, DEVICE_INVENTORY.md,
AGENCY_PROPOSAL.md, features/inbox.md; CLAUDE.md points at the two plans._

1. **Done 2026-09-20:** the Jira board is set up — sprint 3 "Sprint 2 -
   Complete build", four epics, 24 stories in execution order, 16 sub-tasks,
   old issues labelled and explained (`SPRINT_2_JIRA_MAP.md`).
2. **Done 2026-09-20:** S2-01a (SCRUM-186) — see the ticket log.
3. **Done 2026-09-20:** S2-01b (SCRUM-187), S2-01c (SCRUM-188), S2-02
   (SCRUM-189) and S2-03 (SCRUM-190) — see the ticket log. **Next: S2-17a**
   (SCRUM-192), then **CP1**. The ticket log below is the record, updated in
   the same commit series as the code, and an evidence comment goes on each
   story or sub-task as its work merges. We never change a ticket's status.

## Owner inputs needed (asked 2026-09-20)

- Which portal the park actually has: a **2C2P sandbox merchant**
  (developer.2c2p.com — the link the owner sent) or an **SCB Developer
  Portal application** (developer.scb). The plan assumes 2C2P; SCB direct is
  a second provider if it exists. Sandbox merchant id + secret into `.env`
  (`PGW_*`), never into the repo.
- Drop the four gate PDFs and the voucher sample image into
  `imports/_vendor-docs/` — **archival only**; their content is already
  captured in `DEVICE_INVENTORY.md` §6 and §7 and nothing waits on them.
- Answered 2026-09-20 (later), no longer open: the deferred column (nothing
  is deferred — there is no Sprint 3), decision 29 (face clock-in off behind
  a flag), decision 30 (the whole proposal list is in), the production data
  (use the real dump).
- Still open: decision 31 (Inbox brief conflicts — the IT Brief is taken as
  the latest word until the owner confirms), decision 32 (gateway
  credentials), decision 14 (wallet expiry policy values), decision 17
  (alert channel and recipients), the role map in S2-22 (which OTO App
  access level becomes which platform role) and the consent basis for
  re-using OTO App guardians and pickups in the POS.
- A printed sale receipt (for the tax-invoice header) when convenient.

## Answers given to the owner on 2026-09-20 (for the record)

- **"How did the POS prototype work with no API?"** — It did not have one.
  `imports/oto-pos/artifacts/oto-till/src/mockApi.ts` (5,835 lines) is a fake
  API that mutates JavaScript objects held in the browser's memory; a refresh
  resets everything (CLAUDE.md §2 says the same). `artifacts/api-server` is a
  stub with one health route. Its functions (e.g. `registerWalkInChildren`,
  `checkInFamilyWithPayment`, `recordSale`) are the business rules we port —
  cited by name in the plan. The "intake notes" are
  `docs/architecture/intake-2026-09-19/` (README + 8 reports), written from
  reading the exported code: OTO App's 796 Express routes (note 01) and
  Radar's 107 (note 05) are enumerated there, so those two backends have been
  read; the POS backend is ours to build (Sprint 1 built its first 63 routes).
- **Payments** — the owner's link is 2C2P's portal; 2C2P is the gateway, SCB
  the acquirer; PROJECT_CONTEXT §7.2 stands.

## Ticket log

### S2-01a — Security and lock-model fixes (SCRUM-186) — **done**

Branch `feat/s2-01a-security-lock-model`; commits `84010cb`, `12753a3`,
`52a7a11`, `d130cb1`. 81 API tests + 19 shared tests green; typecheck, lint
and build clean.

**Role assignment and account actions.** New
`apps/api/src/services/access-control.ts` holds the three rules the plan
names — tenancy (another operator's account is **404**, never 403, so an id
cannot be confirmed), scope ownership (a branch/department must belong to the
caller's operator; the platform-wide scope only from a platform-wide caller),
and dominance (you cannot grant, or strip, a role carrying a permission you
do not hold at a covering scope). Applied to POST and DELETE
`/accounts/:id/role-assignments`, PATCH `/accounts/:id`,
`/accounts/:id/temp-password` and GET `/accounts/:id/permissions`. Codes:
`ROLE_NOT_DOMINATED`, `SCOPE_NOT_OWNED`, `ACCOUNT_NOT_FOUND`. Roles are now
validated **before** the account row is inserted, so a bad role no longer
leaves an account behind.

Order note: the platform-wide scope (`scopeType: operator`, `scopeId: null`)
is refused by scope ownership **before** dominance is weighed, so that case
answers `SCOPE_NOT_OWNED`; an operator-scoped grant of a role the caller does
not hold answers `ROLE_NOT_DOMINATED` as the ticket describes. Both are
covered by tests.

**Lock model.** `session` gained `class`, `locked_at`, `revoked_at`,
`revoked_reason` (migration `0003_session_lock_model`, plus a CHECK on the
class). `POST /auth/lock` and `POST /auth/unlock` (unlock re-verifies the
password against the SAME session, under the sign-in throttle keyed
`unlock:<sessionId>` and `unlock-account:<accountId>`). Sign-out and force
sign-out **revoke** rather than delete, so "who ended this session, when and
why" survives; `loadAuth` refuses a revoked session like an expired one. On
the POS, inactivity now locks: the lock screen names who is signed in and
asks only for the password, a 423 from any call puts the POS into that
state, and a reload inside a locked session comes back locked
(`/me.sessionLocked`). Sign out is the only user sign-out. Inactivity
timings moved from `mockApi.ts` to `apps/pos/src/auth/timings.ts`.

**Public-deploy security.** `TRUST_PROXY` (hop count) decides `req.ip`; with
it at 0 a forged `X-Forwarded-For` cannot move a caller into a fresh bucket.
The sign-in throttle and the new rate limits both count in Postgres
(`auth_throttle`, migrations `0003`/`0004`), so a Render restart no longer
clears a cooldown — the Sprint 1 counters were a `Map`. Two buckets by
design: a tight per-phone bucket first (`limitPrincipal`, 5 in 15 min) and a
generous per-IP bucket behind it (`@fastify/rate-limit` on a Postgres store,
120/min), because the mall shares very few public addresses. Five wrong
setup/reset codes invalidate every outstanding code for that account and
purpose; a newly issued code starts a fresh budget. Origin check on
state-changing requests (`ALLOWED_ORIGINS`, same-origin allowed, no Origin
allowed). `x-request-id` only honoured as `^[A-Za-z0-9._-]{8,64}$`.
`findAccountByPhone` takes an optional operator, and `/public/member-tier`
now **requires** its branch — phone is unique per operator, so the unscoped
lookup could have answered from another tenant. `mustChangePassword` and the
session lock are enforced in `requireAuth`, not only `requirePermission`,
with a small exempt list (sign-out, lock, unlock, change-password, GET `/me`
and `/me/permissions`) — otherwise a temp-password account reached every
requireAuth-only route.

**PII.** Fastify's own request logging is off in favour of one completion
line per request with the query string stripped (`scrubUrl`); the error
reporter gets the same scrubbed URL; the SMS adapter logs `phoneHash` only
(the console adapter still prints the message — that is how a code is
delivered on a developer's machine, and S2-01c went on to refuse that adapter
on any deployment); pg errors are reduced to `code`/`constraint`/`table`/`routine`
before reaching a log or the reporter (`detail` is where Postgres puts
`Key (phone)=(+66…)`); a unique violation becomes a typed 409 naming the
constraint, never the value. `MEMBER_EXISTS`/`ACCOUNT_EXISTS` renamed to
`MEMBER_PHONE_EXISTS`/`ACCOUNT_PHONE_EXISTS` so the pre-check and the racing
path answer with one code.

**Denials.** Every refusal by a known caller writes an `access.denied` audit
row (code, message, method, scrubbed URL); `GET /audit` gained an `action`
filter; the Login Users panel shows the last ten as "Recent denials", plus a
per-account session list and "Sign out everywhere".

**UI additions** (CLAUDE.md §7.2): locked state on the lock screen; Sessions
dialog, "Sign out everywhere" and "Recent denials" on the Login Users panel.

**Tests** (`apps/api/test/security.test.ts`, 17 cases): dominance (three
refusals), denial rows, forged XFF (nine forged addresses, one bucket keyed
`ip:127.0.0.1`), throttle surviving an api rebuild on the same database,
pg-error redaction from a 23505 fixture, duplicate member → 409 without the
phone, per-phone reset limit, code invalidation, origin refusal, request-id
validation, locked and temp-password sessions, force sign-out. `helpers.ts`
gained `restart()` and per-test env overrides.

**Deferred to S2-01b, as the ticket says:** transactions (`withTx`), the
schema move, and the atomic idempotency claim.

### S2-01b — Transactions, schema move and idempotency (SCRUM-187) — **done**

Branch `feat/s2-01b-transactions-schema`. Three of its tracks — the
permission vocabulary with `platform:sync`, the architecture documents, and
the catalogue/branch transactions — were built by parallel agents on Opus 5
and reviewed here before committing.

**Named schemas (migration `0005_schema_move`).** `core` (tenancy, fleet and
the platform's own records), `crm` (tiers, members, children, visits), `pos`
(catalogue, bookings, sales, payments, bands, wallets, stock), plus empty
`promo`, `booth`, `analytics`, `edge` for the tickets that fill them. Every
table moved with `ALTER TABLE … SET SCHEMA`, so nothing is recreated and no
data is lost. Two placement calls the plan left open, recorded here: the
**catalogue sits in `pos`**, because a package, its holiday calendar and its
tax rules are only ever read together and only by the POS; **`tier` sits in
`crm`**, because a tier is what a person *is* and the catalogue merely prices
by it.

Renames while the tables are still empty: `transaction→sale`,
`transaction_line→sale_line`, `payment→payment_attempt`, `wristband→band`,
`item→stock_item`, with their columns, indexes and FK constraint names moved
too (Postgres does not rename a constraint when its table is renamed).

Constraint corrections: `child→member` is RESTRICT, so deleting a guardian
cannot silently take a child's allergies with it; the wallet and sale ledgers
lose CASCADE for the same reason; `station` carries its operator; `role`
gains `is_system` and is unique per operator, with a **partial** unique index
so two system roles cannot share a name (null operator ids are distinct in
Postgres, which the plain index would have allowed); `role_assignment` and
`branch_holiday` gain `archived_at`.

**Enumerations became text + CHECK** — all seven, not only the two the plan
named. Adding a value to a pg enum takes a DDL lock and cannot happen in a
transaction that also reads the type; a CHECK is replaced in one statement.
`station_kind` gains `booth`, `contact_channel` gains `instagram`.

**How the migration is kept honest.** `drizzle-kit generate` answers a schema
move with DROP + CREATE and, for a rename, asks table by table — and refuses
to guess without a TTY. So the SQL is hand-written and two scripts stand
behind it: `packages/db/scripts/snapshot.ts` writes the matching Drizzle
snapshot without the prompts, and `packages/db/scripts/verify-schema.ts`
(`pnpm --filter @oto/db verify-schema`) migrates a throwaway database
**twice**, then compares the live catalogue with the snapshot — tables,
columns, nullability, foreign-key names *and* their ON DELETE, indexes and
their uniqueness, check constraints — and fails if anything of ours is left
in `public`. `schemaFilter` keeps Drizzle away from the schemas other tools
own (`otoapp`, `radar`, `inbox`, `pgboss`).

**Permissions declared on the route.** `config: { permission, target }` with
a preHandler that enforces it before the handler runs; scope targets are
paths into the request (`params.branchId`). Routes that are deliberately
open, need only a session, are gated platform-wide, or resolve their
permission from the request each say which. `routes-guarded.test.ts` walks
the registry and fails if a route declares none of those — a new route with
no `config` fails on the day it is written — and a second case pins the open
surface so widening it shows up in a diff.

**`withTx(db, ctx, opName, fn)`** written: the success audit row is written
inside the transaction by the service, the failure row after the rollback on
a separate connection, and one log line carries the operation name.

**Transactions.** `withTx(db, ctx, opName, fn)`: the success audit row is
written inside the transaction with the `tx` handle, the failure row after
the rollback on the pool — the record of an attempt has to outlive the
transaction that failed. Every mutating route is wrapped: accounts (create,
role grant and removal, update, temporary password, force sign-out),
operators (create, rename, administrator), members (create, update, archive,
tier verification), children, visits, the catalogue (packages, holidays, tax
config, overrides), branches and public bookings. The cases that matter are
the multi-row ones: a visit with half its children on it is a child nobody
knows is in the park; a tier verification writes the evidence and moves the
member's tier together; deactivating an account also ends its sessions.
`transactions.test.ts` forces a failure with a Postgres trigger that raises
on the audit insert — inside the transaction, after everything the handler
wrote — and asserts the rows are gone, the success audit row is gone, and
exactly one `.failed` row remains.

**Idempotency.** The key is claimed in one statement (`insert … on conflict
do nothing returning`), so two retries racing a dropped connection cannot
both decide they are first — Sprint 1 read then wrote, which is that race. A
duplicate arriving while the original runs gets 409 `IDEMPOTENCY_IN_FLIGHT`
with `Retry-After`; a replay carries `x-oto-replay`; a 5xx **releases** the
key so a real retry does the work rather than replaying a failure for a day;
an expired key is taken over atomically; `purgeExpiredIdempotencyKeys` gives
the housekeeping job its sweep. Where a handler builds its response inside
`withTx` the response is stored in that same transaction; where it reads the
response back after committing, the client-minted id covers the gap —
`POST /members` and `POST /visits` accept a UUIDv7 from the till and answer a
repeat with the row that already exists.

**Permission vocabulary and `platform:sync`.** 28 strings became 99, grouped
by the ticket that will enforce them (selling, payments, refunds, printing,
cash and day close, check-in, wallets, stock, fleet, booths, analytics, and
the `app:*:access` tiles). The seed is now re-runnable and is the
`platform:sync` step: system roles and their permissions converge on every
run — a permission removed from a bundle is withdrawn, not merely left
behind — while the demo rows are created once and then left alone, so a
password changed on staging survives a sync. Sprint 1's "operator exists →
return" early exit is gone. `pnpm db:platform-sync` runs the platform half
alone, which is what the deploy step will call.

**Pool and process.** Pool capped at 10 with a 10-second statement timeout,
idle and connection timeouts, idle-in-transaction cut off, and an
`application_name`; a pool error is logged rather than fatal. SIGTERM drains
instead of dropping. Production refuses to boot on a development default —
a localhost database, the `oto:oto` credentials, the demo MinIO keys, or a
cookie that would travel in the clear — reporting every problem at once.

**Documents.** ARCHITECTURE.md now carries the schema map, the transaction
rule, ids and idempotency, the dominance rule and why the platform-wide
scope is refused before dominance is weighed, the lock model, the route
guard, and what never reaches a log line; its entity diagram is
schema-qualified and renamed. CONTRIBUTING.md carries the expand/contract
policy from 0006 and how to write and verify a hand-written migration.

Still to do in this ticket: nothing. **Known follow-ups, not blockers:**
ARCHITECTURE.md §3 and §6 still describe the pre-2026-09-19 repository
layout; the new permission strings are defined and seeded but nothing
enforces them yet — their own tickets wire them; `purgeExpiredIdempotencyKeys`
is exported but not yet scheduled (S2-03's job runner).

**Deviation recorded:** the plan calls this migration `0003`. S2-01a had
already taken `0003` (the session lock model) and `0004` (the auth throttle),
so the schema move is **`0005`**. Nothing else about it changed.

### S2-02 — Suite launcher and the signed hand-off (SCRUM-189) — **done and deployed**

Commit `c3d94ff` on `main`. 185 API tests + 22 shared tests green; typecheck,
lint and build clean. Live at <https://oto-launcher-staging.onrender.com>,
with the whole hand-off exercised against the real origins —
`DEPLOYMENT_STAGING.md` lists what was checked.

**Why not simply share a cookie.** The suite is several apps on several
origins and the design is one platform session behind all of them, so the
obvious answer is a cookie on the parent domain. It is not available:
`onrender.com` is on the **public suffix list**, which is exactly the list
browsers consult to refuse a cookie set for a domain that many unrelated
people share — a cookie for `.onrender.com` is not "rejected by Render", it is
rejected by the browser, and no configuration changes that. Nor would the
trick survive its own success: the booking site lands on a domain of its own,
and a parent-domain cookie would not reach it either. So the mechanism here is
the permanent one rather than a stand-in for a real domain — the launcher
mints a short-lived token aimed at ONE app, the browser carries it there, and
that app exchanges it for a cookie of its own bound to the same session row.
A real domain later makes it faster, not different.

**The fragment, not the query string.** The token travels as
`https://app/#handoff=…`. A fragment is never sent to a server: it reaches no
access log, no proxy, no load balancer and no `Referer` on the next click. The
same token in `?handoff=` would be written down by every hop between the two
apps and then sit in whichever of those logs is kept longest — which is how a
60-second credential becomes a 90-day one. The POS strips the fragment with
`replaceState` as it reads it, before anything can copy the address bar.

**Replay is stopped by the jti, not by the signature.** A signature proves a
token was minted by us; it says nothing about whether it has already been
spent. So every token carries a `jti` with a row of its own, and the exchange
claims it in a single statement — `update … where jti = $1 and consumed_at is
null returning` — the same lesson as the idempotency claim in S2-01b: two tabs
racing the same fragment cannot both read "unused" and both win. Every outcome
is audited (`auth.handoff_issue`, `auth.handoff_exchange`,
`auth.handoff_rejected` with the reason), and the launcher's account page
shows a person their own recent rejections.

**A keyring, not a key.** `HANDOFF_SIGNING_KEY` is `<kid>:<secret>` pairs,
newest first: the first entry signs, the rest still verify. Rotation is
therefore expand and contract, exactly like a migration — prepend the new key,
deploy, and drop the old entry once every token it signed has expired, which
at a 60-second TTL is the next minute. The `kid` in the header is what lets
the old key keep verifying in the meantime, instead of every launch failing at
the moment of the swap. Unset, the hand-off is **unavailable** (both routes
answer 503) rather than improvised: a key minted at boot would differ between
restarts and between instances, and a key nobody chose is a key nobody can
rotate.

**The sealed session token, and the trade-off it carries.** The app's cookie
holds the platform session's own opaque token, so revoking the session ends
every app at once — there is no second credential anyone can forget to revoke.
Getting that token across means carrying it, so it travels sealed:
AES-256-GCM under a key derived per `jti` (HKDF, the jti as salt and as
associated data), wiped from the row the moment the jti is claimed. A database
dump therefore cannot produce a usable cookie, and a ciphertext copied onto
another row fails to open.

The trade-off, recorded rather than hidden: **one bearer value is shared
across the app origins.** Whoever holds the POS cookie holds the same string
the launcher holds. The alternative is a credential per origin — a
`session_credential` table with one row per app, each with its own token, all
pointing at one session — which is strictly better isolation and is not free:
it needs the new table, a change to `loadAuth` so a lookup resolves a
credential to its session rather than reading the session directly, and a
revoke path that sweeps the children. **Follow-up to weigh before the console
and the lifted apps multiply the origins (S2-03, S2-17, S2-18).** The cost of
deferring is bounded: the session TTL and the existing revoke-everywhere path
already bound the damage, and nothing about the token format changes when the
table lands.

**Idempotency, deliberately released.** `POST /auth/handoff` releases its
idempotency claim instead of storing its response. The response *is* a
credential, and the replay store keeps a body for a day: a retried request
would otherwise be answered with a token that was already spent, and the token
would sit in a table for twenty-four hours after it stopped being useful.

**The launcher itself.** `apps/launcher` is a designed front door, not a list
of links: the POS design tokens verbatim, sign-in in the lock-screen language,
tiles filtered by `app:<name>:access` showing each app's state (open / coming
soon / no access), coming-soon shells for what is not built, and an account
page listing the session and its recent hand-off rejections. It also carries a
temporary-password panel, which closed a real hole found while building it: an
account owing a password change could sign in and then met a 403 on every
guarded route, with nowhere to change it.

**UI additions and removals** (CLAUDE.md §7.2): the launcher is new in full;
on the POS, the **"Scan my face" placeholder is removed** — PROJECT_CONTEXT
§13 rules biometrics out of scope, so the button led nowhere and invited a
question with no answer — and a "Back to the suite" link takes its place when
`VITE_LAUNCHER_URL` is set. The POS lock screen otherwise keeps the Sprint 1
design.

**A flaky test, fixed rather than retried.** The tampered-signature case
flipped the **last** base64url character of the signature — but 32 bytes
encode as 43 characters, and the final character carries only four meaningful
bits: its low two are padding a decoder discards. So the flip sometimes
changed nothing at all (it swapped `A` for `B`, which differ only in those
padding bits), the "tampered" token decoded to **identical bytes**, verified
perfectly, and the case failed whenever a signature happened to end that way —
a rare, unreproducible red build rather than an honest one. It now mutates the
middle of the signature and asserts the decoded bytes actually differ before
asserting the token is refused. Worth writing down because the shape recurs:
any test that corrupts the tail of a base64 value is as likely to be
corrupting padding as data.

**Deployment.** Three services now, all on Render's `checksPass` trigger.
`ALLOWED_ORIGINS` carries **both** static origins — the `/api` rewrite makes
`Origin` differ from `Host`, so each app's writes arrive under its own origin
and neither is covered by the other. `HANDOFF_APP_ORIGINS` carries **only real
targets** (`pos=…` today): the launcher is the issuer and is not one of the
audiences, and naming it there made the api **refuse to boot** — which is how
we learned the validator does its job. `render.yaml` now describes all three
services and both variable groups.

**Deferred, and named so it is not mistaken for done:** the plan's
"Expire hand-off now" test control (S2-02 QA step 3) is not built — expiry is
covered by tests, but not by a button on the account page. It belongs with the
other operational test controls under `OPS_TEST_CONTROLS` in S2-03. The
console, OTO App, Radar, booth and Inbox tiles stay "coming soon" until their
own tickets give them an origin.

### S2-03 — Observability and Console v1 (SCRUM-190) — **done and deployed**

**One redactor, not four.** `@oto/telemetry` is the single place a phone
number, a password, a token or a card number is turned into `[redacted]`, and
it redacts by key AND by value shape — a Luhn-valid 13-to-19 digit run is a
PAN wherever it appears, whatever the key is called. Three weaker copies were
deleted: `lib/scrub.ts` is now a thin binding to it, `services/ops.ts` binds
`scrubDetail` to the same function, and the pino logger is wrapped ONCE at
creation so every child inherits redaction rather than every caller
remembering it. Budgets on depth, node count and string length, plus cycle
detection, so a redactor can never be the thing that hangs a request.

**The operational record.** `ops_run` holds what ran and whether it worked;
`ops_last` and `ops_expectation` hold the register the watchdog compares. A
failure's fingerprint is a hash of kind, name and error code, which is what
makes sixty failures read as one problem. Alerts dedupe against an open alert
of the same key, auto-resolve when the thing recovers, and suppress a flap.

**The job runner, and how it was found not to be running.** `createJobRunner`
and twenty tests existed; nothing constructed it. `/ready` on the deployment
said `jobs.configured: false` — no test caught it, reading the deployment did.
It now starts from `index.ts`, which is the one place that knows this is a
real process and not a test building an app per file. `PROCESS_ROLES` gates
it, so the day the worker splits out the api stops competing with it.

**The routes the Console reads.** `GET /ops/health` reads the job register
from `ops_expectation` joined to `ops_last`, never from the process answering
the request, so an instance without the jobs role still answers correctly.
Lateness is measured from the last **success** against interval + grace — the
same arithmetic the watchdog uses, so the page and the alert cannot disagree
— while age is measured from the last **finish**, so "runs and fails" and
"stopped running" read as the two different problems they are.
`GET /ops/failures` groups by fingerprint with a keyset cursor;
`POST /ops/runs/:id/retry` re-runs a job and refuses every other kind,
because each of those has already half-happened by the time it failed.
`GET /ops/integrations` reports names and states only: where a provider is
unconfigured it names the **variable** that is unset, never a value and never
a masked one, because the page is read over shoulders in a back office.

**Evidence, and a correction.** The first screenshot set was attached while
three of those routes did not exist, so Health, Failures and Integrations
photographed their empty states. They were removed from the ticket and
re-captured against the live deployment with the staging test controls
pressed first, so every page shows real rows. The lesson is recorded rather
than smoothed over: evidence is checked by looking at it, not by counting it.

**Deferred, named:** OpenTelemetry traces and the OTLP bridge,
`POST /telemetry/client` for browser errors, the `audit_log` classification
columns with a BRIN index, and a scheduled ping of `/ready` from outside the
platform. All additive; none blocks the next ticket. See `OPEN_QUESTIONS.md`
for the two decisions this ticket surfaced (`job.fail` raises no
`ops.failing`; an acknowledged alert does not say who took it).

## Deviations recorded

(None yet — the plan lists the ones it expects: booth order, Pi image, edge +
jobs inside api, face-scan removal, occupancy model, OTO App lifted as-is,
2C2P kept over a bank API.)
