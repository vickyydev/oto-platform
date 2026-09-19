# Sprint 2 progress

## Status

- Current checkpoint: **building. S2-01a (SCRUM-186) is done and merged to
  `main`; S2-01b (SCRUM-187) is in progress on
  `feat/s2-01b-transactions-schema`** — the schema move and the declarative
  permission guard are committed, 85 API tests green, typecheck/lint clean.
- Jira: sprint **"Sprint 2 - Complete build"** (id 3) on board 1 of project
  SCRUM holds the 24 stories under four epics, with 16 sub-tasks; the
  pre-existing 177 issues were labelled rather than deleted. Keys and the
  full account of what was done: `SPRINT_2_JIRA_MAP.md`.
- Last completed step: S2-01a — the role-assignment privilege hole, the lock
  model, the public-deploy fencing and the PII leaks (see the ticket log).
- Next step, inside **S2-01b**: wrap the mutating routes in `withTx` (the
  helper is written and committed) and lift their bodies into services;
  then the atomic idempotency claim, the extended permission vocabulary with
  a re-runnable `platform:sync`, and the pool/process hardening. Then S2-01c
  (Render deploy, owner-blockable on the Render account).
- Resume instructions: read `docs/progress/STATUS.md`, then this file, then
  `docs/progress/SPRINT_2_PLAN.md` (the whole thing — it is the ticket
  source) and `docs/architecture/DEVELOPMENT_PLAN.md` §5 for the build
  recipe, plus `docs/briefs/OWNER_DIRECTION.md` (section 2026-09-20 wins).
  Branch `feat/s2-01a-security-lock-model` off `main`; commit per
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
- `docs/briefs/AGENCY_PROPOSAL.md` (new, 991 lines): the agency proposal site
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

## Pending — in this order

_Plan v2 is complete as of commit set 5dabf05 → this one: SPRINT_2_PLAN.md,
DEVELOPMENT_PLAN.md (1,849 lines), PAYMENT_GATEWAY.md, DEVICE_INVENTORY.md,
AGENCY_PROPOSAL.md, features/inbox.md; CLAUDE.md points at the two plans._

1. **Done 2026-09-20:** the Jira board is set up — sprint 3 "Sprint 2 -
   Complete build", four epics, 24 stories in execution order, 16 sub-tasks,
   old issues labelled and explained (`SPRINT_2_JIRA_MAP.md`).
2. **Done 2026-09-20:** S2-01a (SCRUM-186) — see the ticket log.
3. **Next: S2-01b** (SCRUM-187) then S2-01c (SCRUM-188, owner-blockable on
   the Render account). The ticket log below is the record, updated in the
   same commit series as the code, and an evidence comment goes on each story
   or sub-task as its work merges. We never change a ticket's status.

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
(the console adapter still prints the message — that is how dev codes are
delivered); pg errors are reduced to `code`/`constraint`/`table`/`routine`
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

### S2-01b — Transactions, schema move and idempotency (SCRUM-187) — **in progress**

Branch `feat/s2-01b-transactions-schema`. Done so far, committed:

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

Still to do in this ticket: wrap the mutating routes in `withTx` and lift
their bodies into services; the atomic idempotency claim with the in-flight
409 and `x-oto-replay`; the extended permission vocabulary and a re-runnable
`platform:sync`; the pool and process hardening; ARCHITECTURE.md.

**Deviation recorded:** the plan calls this migration `0003`. S2-01a had
already taken `0003` (the session lock model) and `0004` (the auth throttle),
so the schema move is **`0005`**. Nothing else about it changed.

## Deviations recorded

(None yet — the plan lists the ones it expects: booth order, Pi image, edge +
jobs inside api, face-scan removal, occupancy model, OTO App lifted as-is,
2C2P kept over a bank API.)
