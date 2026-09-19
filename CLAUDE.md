> **Repository layout changed on 2026-09-19 — read this before the brief below.**
> The platform is now the **repository root** (what this brief calls `/oto-platform`
> is `/`). The Replit prototype this brief says sits at the repo root now lives,
> read-only, in **`imports/oto-pos/`** (the app itself: `imports/oto-pos/artifacts/oto-till/`).
> Documents moved: `ARCHITECTURE.md` → `docs/architecture/`, `SPRINT_1_PROGRESS.md` and
> `SPRINT_1_REPORT.md` → `docs/progress/`, `TEST_CASES.md` and Jira evidence → `docs/qa/`.
> **Read next, in this order:** `docs/briefs/OWNER_DIRECTION.md` (newest decisions, wins
> on any conflict) → `docs/briefs/PROJECT_CONTEXT.md` (the target system for Sprint 2) →
> `docs/README.md` (where everything is). New progress files go in `docs/progress/`.
> Raw exports of other apps, the production dump and vendor device documents go in
> `imports/` — local reference input only: never built, deployed or committed.
> **Commits follow `CONTRIBUTING.md`** (conventional `type(scope): summary` subject,
> bullet-point body, `Refs:` footer). That supersedes the commit rule in section 8
> below. Two rules there are absolute: **no attribution lines of any kind** — no
> co-author, generator or assistant trailer, whatever a tool adds by default — and
> **write about the system, not about the commercial arrangement**: history is read
> by people outside the team, so name the till, reception, a branch or staging, and
> never the relationship.
>
> **Sprint 2 (from 2026-09-20).** Sections 5, 6, 9, 10 and 11 below are the Sprint 1
> brief and are superseded for Sprint 2 by `docs/progress/SPRINT_2_PLAN.md` (what to
> build: 19 tickets, checkpoints, open decisions) and
> `docs/architecture/DEVELOPMENT_PLAN.md` (how to build it: resume protocol, target
> architecture, per-ticket recipe, conventions, environment registry, research
> conclusions). Sections 3, 7 and 8 stay in force. Resume every session from
> `docs/progress/STATUS.md` → `docs/progress/SPRINT_2_PROGRESS.md` (Status block).
> Checkpoint after every substantial step: update the progress file, commit, push.

# OTO Platform — Agent Context and Sprint 1 Brief

You are the coding agent for the rebuild of OTO Park's operations platform. This document is your complete context. Read it fully before writing any code. Everything you need to know about the business, the existing prototype, the target architecture, and the Sprint 1 scope is here. Where something is not covered, ask before assuming.

**How to use this document:** Save it as `CLAUDE.md` in the new project folder so it loads on every session. Keep a `SPRINT_1_PROGRESS.md` next to it and update it after every ticket.

---

## 1. Project background

### The business
OTO Park is an indoor children's play park in Phuket, Thailand, operating in a shopping mall. It sells admission (adult and child wristbands), runs a restaurant (F&B), sells merchandise, runs birthday parties, camps and events, and offers supervised child care (nanny and drop-off). It has one branch today, referred to in the prototype as **HKT Central**, and is designed to open more.

Customers are a mix of tourists, expats living in Thailand, and Thai nationals. Pricing differs by tier. Members register by phone number. Children are linked to a guardian member and carry allergy and medical notes.

Staff roles include reception, restaurant, floor staff, nannies, branch managers, and administrators. Staff sign in by phone number.

### What exists today
The client has a working but limited prototype built with Replit's AI agent. It runs in production on AWS (Kubernetes, PostgreSQL on RDS) and covers parts of the operation. The outgoing developer described the repository as tech debt and recommended a ground-up rewrite. That is what we are doing.

The prototype in this repository is the **Oto POS** application. It is frontend-only: React with fixed in-memory data, no database, no backend. Its UI design is approved by the client and **must be preserved**. Our job is to build a real backend and database behind that design, not to redesign it.

### What is being built
A new platform, TypeScript end to end, in a monorepo that will eventually hold:
- **POS** (this sprint's focus) — the till, customer display, check-in, F&B, stock
- **Admin console** — configuration, users, reporting, logs and observability
- **Booking site** — public online booking
- **Branch agent** — on-site service for gates, printers, scanners (later, runs on a Raspberry Pi)
- Later: messaging, wallets, events, HR modules

The build is planned as four sprints, each ending in a demo to the client, followed by a stabilisation period. **This document covers Sprint 1.** Sprint 1 is executed as one continuous run: you work through every ticket in order without pausing between them, stopping only at the checkpoints defined in Section 9.

### The four milestones, for orientation
| Sprint | Milestone | Theme |
|---|---|---|
| 1 | M1 | Foundation, accounts, members, catalog |
| 2 | M2 | Selling, payments recording, printing, stock, offline sales |
| 3 | M3 | Booking redemption, child supervision, gate and occupancy, data migration |
| 4 | M4 | Wallets, F&B, reporting, QR payment, customer messaging |

Design every Sprint 1 decision knowing what comes after. The data model in particular must accommodate all four milestones even though only part of it is used now.

---

## 2. What is in this repository

The repository root is the Replit prototype. Treat it as **read-only reference**. Do not modify it.

Known structure (verify on first run and record what you find in `SPRINT_1_PROGRESS.md`):
```
/artifacts/api-server        stub API server (minimal)
/artifacts/mockup-sandbox    design sandbox
/artifacts/oto-till          the POS frontend prototype (React, Vite, in-memory state)
/attached_assets             images and assets
/lib                         shared code
/scripts
/replit.md                   Replit agent's own notes — read this first
pnpm-workspace.yaml
```

The prototype runs on `http://localhost:25731`. Everything in it is in-memory; a page refresh resets to the lock screen. Header tabs: Tickets, F&B, Shop, Events, Check-in, History, Today, Messages. The lock screen offers "Scan my face" (mock), plus temporary links to the booking site (`/book`), admin console (`/admin`) and stock module.

**Before writing any code:** open the prototype, click through every screen, and write a short inventory in `SPRINT_1_PROGRESS.md` of components, routes, and the data shapes the mock uses. That inventory is the source of truth for what the UI expects from the API.

### The prototype is the primary source of business logic

The prototype is frontend-only, but it is not empty of logic. Its code contains the client's actual rules, worked out over months with the park's staff: how a ticket price is composed, how included adults and overflow are counted, how weekday and weekend pricing switch, how the membership check flows between customer display and till, what a child record holds, what the lock and inactivity behaviour is, what the admin screens expect. Those rules are approved behaviour. **Read them out of the code and port them. Do not reinvent them.**

The order of authority when deciding how something should work:

1. **The prototype's code.** If the logic exists there, that is the behaviour. Port it, keep its edge cases, and cite the source file in `SPRINT_1_PROGRESS.md`.
2. **This document.** Where the prototype has no logic for something a ticket needs (persistence, permissions, audit, real authentication), this document defines it.
3. **Ask.** Where neither covers it, ask. Do not fill the gap from your own assumptions and do not invent behaviour, fields, rules or features the client has not described.

Concretely: before implementing any Sprint 1 ticket, locate every function, reducer, constant, mock data shape and helper in the prototype that touches that ticket's behaviour, list them in `SPRINT_1_PROGRESS.md` under that ticket, and then build the backend so that the ported UI behaves identically against real data. If the prototype and this document appear to disagree, stop and raise it rather than picking one.

### Where the new code goes
Create a new top-level folder: `/oto-platform`. All new work lives there. The prototype folders stay untouched as reference.

---

## 3. Target architecture

### Stack (decided — do not revisit)
- **Language:** TypeScript, strict mode, everywhere
- **Monorepo:** pnpm workspaces + Turborepo
- **API:** Fastify 5, with zod schemas via `fastify-type-provider-zod`, OpenAPI generated from routes
- **Database:** PostgreSQL 16, Drizzle ORM, Drizzle Kit migrations
- **POS frontend:** React + Vite, carried over from the prototype. Do not migrate it to another framework. Preserve its components and styles.
- **Admin and booking frontends:** later sprints, likely Next.js. Not built now.
- **Local infra:** Docker Compose for PostgreSQL and MinIO (S3-compatible storage)
- **Validation:** zod, shared between API and frontends via a package
- **Auth:** phone + password, argon2id hashing, server-side sessions in an httpOnly cookie
- **Logging:** pino, request IDs on every log line
- **Testing:** Vitest for unit and API integration tests; Playwright for a small number of smoke flows
- **CI:** GitHub Actions — install, typecheck, lint, test, build, migration check

### Monorepo layout
```
/oto-platform
  /apps
    /api            Fastify server
    /pos            React POS (from prototype)
  /packages
    /db             Drizzle schema, migrations, seed, db client
    /shared         zod schemas, types, permission constants, money/phone/date utils
    /config         eslint, tsconfig, prettier shared configs
  /infra
    docker-compose.yml
  turbo.json
  pnpm-workspace.yaml
  package.json
  .env.example
  CLAUDE.md                  (this document)
  SPRINT_1_PROGRESS.md
  ARCHITECTURE.md            (you write this — see Section 9)
```

### Key decisions

**Multi-tenancy: row-scoped, single schema.** Every tenant-owned table carries `operator_id`, and branch-owned tables also carry `branch_id`. Do not use schema-per-tenant. One operator exists today; the model must support several.

**IDs:** UUIDv7, stored as Postgres `uuid`. Generate in the application. One consistent generator in `packages/shared`.

**Money:** integers in satang (minor units of THB). Never floats. A `Money` helper in `packages/shared` handles formatting.

**Time:** all timestamps `timestamptz`, stored UTC. Each branch has a timezone (`Asia/Bangkok`). Display conversions happen at the edge using the branch timezone.

**Phone numbers:** normalised to E.164 on write using `libphonenumber-js`, default region `TH`. Uniqueness constraints are on the normalised value.

**Soft deletion:** `archived_at timestamptz null` on entities that can be archived. No hard deletes of business records.

**API style:** REST, JSON, resource-oriented. Consistent error envelope `{ error: { code, message, details? } }`. Every mutating endpoint accepts an `Idempotency-Key` header (Section 3, Safeguards).

**Sessions:** opaque session token in an httpOnly, SameSite cookie, backed by a `session` table with expiry and last-seen. The POS locks on inactivity (client-side timer, prototype already shows "Locks automatically after inactivity"); unlocking requires re-entering the password. Sessions carry the account, the active branch, and the station where relevant.

**Permissions:** strings in the form `service:resource:action`, e.g. `pos:member:read`, `admin:account:create`. Roles are named bundles of permissions. A role assignment binds an account to a role **with a scope**: operator-wide, a specific branch, a specific department, or a specific record. Effective permissions are the union across all assignments, each carrying its scope. A Fastify `preHandler` guard checks a required permission against the request's target scope (e.g. the branch in the route). The resolver must be unit-tested across scope combinations.

**Audit log:** append-only `audit_log` table. One helper, `audit.record({ actorAccountId, action, entityType, entityId, before, after, branchId, operatorId, requestId })`. Every mutating service call in Sprint 1 records an entry. No exceptions.

**Idempotency and safeguards:** `idempotency_key` table storing key, account, request hash, response status and body, expiry. Middleware: if the key was seen with the same request hash, return the stored response; if seen with a different hash, return 409. Combine with database unique constraints on business keys (member phone per operator, account phone, etc.). This exists now so that later payment, wallet, redemption and child-release work inherits it.

**Files and media:** S3-compatible storage (MinIO locally). `file_object` table stores metadata, owner entity, and permission context. Access is only through short-lived signed URLs issued by the API after a permission check. Profile photos use this in Sprint 1.

**Locale:** `packages/shared` exposes phone normalisation and formatting, THB money formatting, and branch-timezone date helpers. The POS already has an EN/TH language toggle on the customer display; wire it to an i18n scaffold (`en`, `th` message files) without changing the UI.

**Observability:** pino JSON logs with request ID, account ID, branch ID where known. `/health` and `/ready` endpoints. An error-reporting hook that can be pointed at Sentry via `SENTRY_DSN` but is a no-op when unset. Logs and monitoring **screens** belong in the admin console later; in this sprint only the plumbing is built.

**Offline (not this sprint, but design for it):** later sprints add an offline POS queue, locally minted band codes, and a branch agent on a Raspberry Pi. Do not build these now, but do not make decisions that prevent them: keep write paths idempotent, keep IDs client-generatable, keep business logic in services rather than route handlers.

---

## 4. Domain model baseline

Build the full schema now (ticket SCRUM-10), with tables for future milestones present but unused. Fields below are the minimum; add what the prototype's data shapes require.

**Tenancy and people**
- `operator` — id, name, archived_at
- `branch` — id, operator_id, name, code, timezone, address, archived_at
- `department` — id, operator_id, branch_id (nullable for operator-wide), name
- `employee` — id, operator_id, name, nickname, phone (E.164), email, department_id, branch_id, employment fields minimal, archived_at
- `account` — id, operator_id, employee_id (nullable), phone (E.164, unique per operator), password_hash, phone_verified_at, status (invited / active / inactive), must_change_password bool, created_at
- `role` — id, operator_id (null for system roles), name, description
- `role_permission` — role_id, permission (string)
- `role_assignment` — id, account_id, role_id, scope_type (operator / branch / department / record), scope_id
- `session` — id, account_id, token_hash, branch_id (active), station_id (nullable), expires_at, last_seen_at, created_at
- `verification_code` — id, account_id, purpose (setup / password_reset), code_hash, expires_at, consumed_at

**Members**
- `member` — id, operator_id, phone (E.164, unique per operator), name, nickname, email, tier (tourist / expat / thai, default tourist), notes, created_via (pos / booking / import), archived_at
- `member_tier_verification` — id, member_id, from_tier, to_tier, evidence_type, evidence_expires_at, verified_by_account_id, branch_id, note, created_at *(schema only this sprint; the UI is a later ticket)*
- `child` — id, member_id, name, date_of_birth (or age_years), allergies, medical_notes, medical_alert bool, notes, last_confirmed_at, archived_at
- `visit` — id, operator_id, branch_id, member_id (nullable for walk-in), visit_date, status (draft / active / closed), created_by_account_id
- `visit_child` — visit_id, child_id, confirmed_at

**Catalog and pricing**
- `ticket_package` — id, operator_id, branch_id, name, description, kid_price_weekday, kid_price_weekend, adult_price_weekday, adult_price_weekend, included_adults, overflow_adult_price, wallet_credit_amount, duration_minutes, gate_rights (jsonb), active, archived_at
- `branch_holiday` — id, branch_id, name, starts_on, ends_on (dates; inclusive) — forces weekend pricing
- `branch_tax_rule` — id, branch_id, vat_rate_bp (basis points), service_charge_bp, prices_include_vat bool
- `product_category` — id, operator_id, name (present for later F&B and shop)
- `product` — id, operator_id, branch_id, category_id, name, price, active (present for later)
- `tax_override` — id, branch_id, category_id (nullable), product_id (nullable), vat_rate_bp, service_charge_bp

**Devices**
- `station` — id, branch_id, name, kind (till / kiosk / gate / display), device_key_hash, last_seen_at

**Platform**
- `audit_log` — id, operator_id, branch_id, actor_account_id, request_id, action, entity_type, entity_id, before (jsonb), after (jsonb), created_at
- `idempotency_key` — key, account_id, request_hash, status_code, response_body (jsonb), created_at, expires_at
- `file_object` — id, operator_id, bucket, object_key, content_type, size, owner_entity_type, owner_entity_id, uploaded_by_account_id, created_at

**Present but unused until later sprints (create as empty tables with sensible columns):** `booking`, `attendee`, `transaction`, `transaction_line`, `payment`, `wallet`, `wallet_entry`, `wristband`, `item`, `stock_location`, `stock_level`.

**Seed data** (script in `packages/db/seed`): one operator "OTO"; one branch "HKT Central" with timezone Asia/Bangkok; departments reception, restaurant, floor, nanny; system roles (below); a platform admin account and a reception account with known passwords for local dev; six members with children including at least one allergy; three ticket packages with weekday/weekend prices; one holiday range; a tax rule of 7% VAT inclusive.

**Seed roles:** `platform_admin` (all), `operator_admin` (all within operator), `branch_manager` (branch-scoped management), `reception` (members, visits, sales), `staff` (read-mostly). Define the permission lists in `packages/shared/permissions.ts` and generate the seed from them.

---

## 5. Sprint 1 scope

Twenty-four tickets. Keys are Jira issue keys; use them in commit messages.

### Sprint goal
A running system where a staff member signs in by phone, is granted scoped access, configures a branch and its ticket prices, and creates and finds members and their children — on a data model, permission engine, audit log and safeguards that everything after this will build on.

### Demo at the end of the sprint
1. Sign in by phone number on the POS lock screen, complete a new account's setup, recover a password, sign out.
2. In the admin console: create a staff account, assign a role scoped to a branch, and show the resulting effective permissions.
3. Create an operator and a branch; assign an administrator.
4. Configure a ticket package with weekday, weekend and holiday pricing, plus branch VAT and service charge rules.
5. On the POS: customer enters their phone on the customer display, the till finds the member, shows their children, staff confirm which children are visiting and update an allergy note. Create a new member from phone and name only.

### Track A — Decisions and discovery

**SCRUM-7 — Decide the target stack and the API reuse boundary**
The decision is made and recorded in Section 3 of this document: a new backend and database are built from scratch; the prototype's UI **and the business logic embedded in its frontend code** are carried over. Your task is to write `ARCHITECTURE.md` in `/oto-platform` restating these decisions with the folder layout, and to confirm the prototype's actual structure matches Section 2.
*Done:* `ARCHITECTURE.md` exists and `SPRINT_1_PROGRESS.md` records the verified prototype layout.

**SCRUM-8 — Inventory the existing system**
Two inventories, both in `SPRINT_1_PROGRESS.md`.

*Screen inventory:* every route, screen, component group, and the mock data shapes it consumes. Mark each screen as "Sprint 1 — wire to API", "later sprint — keep on mock", or "not in scope".

*Logic inventory:* every business rule you can find in the prototype code, with the file and function where it lives. At minimum look for: price composition for a ticket (kid, adult, included adults, overflow); weekday versus weekend switching and what triggers it; the membership check flow between customer display and till; the "skip, walk-in (Tourist)" path; child data shape and how allergies and medical notes are shown; lock and inactivity behaviour; branch and station selection; what the admin console screens for users, branches and catalog expect; any constants, enums or validation rules in the mock data. For each rule, note which Sprint 1 ticket it belongs to.
*Done:* both inventories exist, every Sprint 1 ticket in Section 5 has its prototype logic sources listed, and gaps where the prototype has no logic are explicitly marked "no prototype logic — defined by CLAUDE.md" or "no prototype logic — ask".

### Track B — Platform foundation (in this order)

**SCRUM-9 — Set up the monorepo, environments, CI/CD, and error tracking**
Turborepo + pnpm monorepo per Section 3. Docker Compose with PostgreSQL 16 and MinIO. `.env.example` with every variable documented. Shared eslint, prettier, tsconfig. GitHub Actions workflow running typecheck, lint, tests against a Postgres service container, build, and a check that migrations apply cleanly from empty. pino logging with request IDs. Health endpoints. Error hook with optional Sentry DSN. Scripts: `pnpm dev`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm test`, `pnpm typecheck`.
*Done:* `pnpm install && docker compose up -d && pnpm db:migrate && pnpm db:seed && pnpm dev` brings up API and POS from a clean checkout, and CI is green on the first push.

**SCRUM-10 — Define the centralized data model and schema baseline**
Implement Section 4 in Drizzle. Migrations generated and committed. Seed script. Export an entity diagram (Mermaid in `ARCHITECTURE.md` is sufficient). This is the highest-value ticket in the sprint; take care over naming, constraints, and indexes on every foreign key and every lookup column (phone, dates).
*Done:* migrations run clean from an empty database twice in a row; seed populates a usable branch; every FK has an index; the diagram is in the repo.

**SCRUM-17 — Implement locale, timezone and currency conventions**
Do this immediately after SCRUM-10 because sign-in and member lookup depend on phone normalisation. Implement in `packages/shared`: `normalizePhone`, `formatPhone`, `Money` helpers, branch-timezone date helpers, and the i18n scaffold with `en` and `th` message files. Wire the POS language toggle to it.
*Done:* unit tests for phone normalisation (Thai local formats, +66, international), money formatting, and a timezone round-trip.

**SCRUM-13 — Implement the scoped permission engine**
Permission constants in `packages/shared`. Effective-permission resolver. Fastify guard `requirePermission('pos:member:read', { branch: 'params.branchId' })`. Endpoint `GET /me/permissions` returning effective permissions with scopes.
*Done:* resolver has unit tests covering operator-wide, branch, department and record scopes and their combinations; guard has integration tests for allow and deny; every Sprint 1 route is protected.

**SCRUM-15 — Implement idempotency and duplicate safeguards**
Middleware per Section 3. Document the pattern in `ARCHITECTURE.md`. Apply to every POST/PUT/PATCH/DELETE route.
*Done:* an integration test sends the same request twice with the same key and gets one record and identical responses; a test with the same key and a different body gets 409.

**SCRUM-14 — Implement the audit and activity log service**
`audit.record` helper, called from every mutating service in Sprint 1. Endpoint `GET /audit` with filters (entity, actor, branch, date range), permission-guarded.
*Done:* every mutating Sprint 1 action produces an audit row with before/after; integration tests assert this for account creation, role assignment, member creation and ticket package update.

**SCRUM-16 — Implement file and media storage with permission-bound access**
MinIO client, `file_object` table, upload via presigned PUT, download via presigned GET issued only after a permission check on the owning entity.
*Done:* profile photo upload and retrieval work end to end; a request for a file the account cannot see returns 403; objects are never public.

### Track C — Accounts and access

**SCRUM-19 — Sign in by phone number**
`POST /auth/sign-in` with phone + password. Rate limiting on failures per phone and per IP. Inactive or unverified accounts refused with a clear message. Session cookie issued. On the POS, the lock screen keeps its design; behind "Scan my face" (which stays as a placeholder for later face auth) add a sign-in form in the same visual style. See Section 7.
*Done:* active account signs in; inactive account is refused with a message; five failures trigger a cooldown; session appears in the `session` table.

**SCRUM-20 — Complete staff account setup**
An invited account sets a password and verifies its phone with a code. SMS provider is a pluggable adapter; the dev adapter logs the code to the API console. The account cannot reach any other endpoint until both steps complete.
*Done:* new invited account is blocked from `/me` until setup; after setup, sign-in works; code is single-use and expires.

**SCRUM-23 — Recover a forgotten password securely**
Code to verified phone, single-use, time-limited. Reset invalidates all existing sessions for the account.
*Done:* reset flow works; old session cookie is rejected afterwards; used code cannot be reused.

**SCRUM-24 — Sign out**
`POST /auth/sign-out` deletes the server-side session. Client returns to the lock screen.
*Done:* the session row is gone; the old cookie is rejected.

**SCRUM-25 — Manage profile photo and account details**
`GET/PATCH /me`, showing linked employee and account details, permitted fields editable, photo via SCRUM-16.
*Done:* editable fields save; non-permitted fields are rejected; photo upload works.

**SCRUM-21 — Create a staff account and assign access**
Admin: create an account or link one to an existing employee, assign roles with scopes, issue a setup invitation (code delivered via the SMS adapter).
*Done:* admin creates an account, assigns `reception` scoped to HKT Central, invitation code is logged, the new account completes setup and signs in.

**SCRUM-22 — Review and change effective permissions**
Admin screen: assigned roles, the permissions each carries, resulting effective permissions with scopes; add and remove role assignments.
*Done:* changing an assignment is reflected immediately in `GET /me/permissions` for that account; audit rows recorded.

**SCRUM-27 — Manage operators, branches, and administrators**
Platform admin: create and archive operators; create and archive branches (with timezone); assign operator administrators.
*Done:* a second operator with one branch can be created and an admin assigned; archived operators are hidden from pickers.

**SCRUM-28 — Manage login users**
Admin: search, create, edit, activate, deactivate accounts; issue a temporary password that forces a change at next sign-in.
*Done:* deactivated account cannot sign in; temporary password works once and forces a change.

### Track D — Members

**SCRUM-31 — Create and enrich a member**
`POST /members` from phone + name only; `PATCH /members/:id` to enrich. Same normalised phone cannot create a duplicate within an operator. On the POS, the membership check screen gets a "create member" path when lookup finds nobody.
*Done:* create, enrich, duplicate rejected with a clear error; audit rows recorded.

**SCRUM-30 — Find a returning member by phone number**
`GET /members/lookup?phone=` returning the member with children. Wire the customer display "Find my membership" flow and the till's "Membership Check" panel to it.
*Done:* the prototype's membership check works against real data; a phone typed in Thai local format finds the E.164 record.

**SCRUM-32 — Select and reconfirm saved children for a visit**
After lookup, the till shows the member's children; staff choose who is visiting and confirm or edit each child's details including allergies. Persist as a `visit` in draft status with `visit_child` rows and update `child.last_confirmed_at`.
*Done:* selecting children creates the visit; editing an allergy updates the child and is audited; the visit is visible in the API.

### Branch catalog

**SCRUM-35 — Configure a ticket package**
Admin CRUD for `ticket_package` with all fields in Section 4.
*Done:* create, edit, archive; validation rejects negative prices and zero duration; audit rows recorded.

**SCRUM-36 — Configure weekday weekend and holiday pricing**
Weekday and weekend price pairs on the package; `branch_holiday` ranges. A pricing resolver in the API: given a branch, a date, and a package, return the applicable prices, treating weekends and holiday ranges as weekend pricing. The POS header already shows "Weekday pricing"; wire that indicator to the resolver for today's date.
*Done:* resolver unit tests for a weekday, a Saturday, a Sunday, a weekday inside a holiday range, and a range boundary; the POS indicator reads correctly.

**SCRUM-37 — Configure branch tax and service rules**
Admin CRUD for `branch_tax_rule` and `tax_override`. A tax resolver returning the effective VAT and service charge for a given branch, category and product.
*Done:* resolver unit tests for branch default, category override, and product override precedence.

### Execution order
Work through these in sequence. Do not start a ticket until the ones before it are done and recorded. Checkpoints (CP) are where you stop and wait; everything between them is continuous.

1. SCRUM-7, SCRUM-8 → **CP1**
2. SCRUM-9
3. SCRUM-10 → **CP2**
4. SCRUM-17, SCRUM-13, SCRUM-15, SCRUM-14, SCRUM-16 → **CP3**
5. SCRUM-19, SCRUM-20, SCRUM-23, SCRUM-24, SCRUM-25, SCRUM-21, SCRUM-22, SCRUM-27, SCRUM-28 → **CP4**
6. SCRUM-31, SCRUM-30, SCRUM-32, SCRUM-35, SCRUM-36, SCRUM-37
7. Full acceptance run (Section 10), fix list, tag `sprint-1`, `SPRINT_1_REPORT.md` → **CP5**

---

## 6. Explicitly out of scope — keep on mock data

Do not wire these to the API in Sprint 1. Leave the prototype's in-memory behaviour, behind a clearly named flag or a `mock/` data module, so the screens still render:

- Selling tickets, the order panel, payments, receipts, wristband printing (Sprint 2)
- F&B, Shop, Stock module (Sprint 2 and 4)
- Check-in board, drop-off, nanny, events, camps (Sprint 3)
- Booking site `/book` and booking redemption (Sprint 3)
- Messages tab and WhatsApp/Telegram status (Sprint 4)
- Today dashboard, History (Sprint 2 onward)
- Face authentication ("Scan my face" stays as a placeholder)
- Member tier change UI with evidence (schema exists; UI is a later ticket)
- Gate, printers, scanners, branch agent, offline queue
- Data migration from the production database (Milestone 3)

If a Sprint 1 screen depends on one of these, stub the dependency at the API boundary and note it in `SPRINT_1_PROGRESS.md`.

---

## 7. UI rules

1. **Do not change the design.** Copy the prototype's components, styles and layout into `apps/pos`. Refactor internals (state, data fetching, types) freely. Do not restyle, rename visible labels, move elements, or change colours.
2. **When the prototype lacks a UI element that a Sprint 1 ticket needs**, add it in the same design language, as close as possible to where the prototype would have put it, and list the addition in `SPRINT_1_PROGRESS.md` under "UI additions". Expected additions: a phone + password sign-in form behind the lock screen; a "create member" step in the membership check; child selection and edit in the membership check; admin forms for accounts, roles, operators, branches, packages, holidays and tax.
3. **The admin console** in the prototype (`/admin`) is the home for all Track C admin screens and the catalog screens. Follow its layout.
4. **Customer display.** The prototype's split view (till left, customer display right) is a test harness; in production the display is a separate device. Keep the harness. The membership lookup entered on the customer display must reach the till through the API (a short-lived "pending lookup" on the visit or session), not through shared browser state.
5. **Language toggle** on the customer display drives the i18n scaffold. English strings are the source; Thai strings can be placeholders marked for translation.

---

## 8. Engineering standards

- TypeScript strict, no `any` without a comment explaining why.
- Business logic lives in `apps/api/src/services/*`, not in route handlers. Routes validate, call a service, map the result.
- Every service method that writes: runs in a transaction, records audit, is idempotent.
- Every table: created_at, updated_at; archived_at where archivable; indexes on FKs and lookup columns.
- Every route: zod request and response schemas; permission guard; OpenAPI description.
- Tests: unit tests for resolvers and utilities; integration tests for every route's happy path and its main failure; Playwright smoke for lock → sign-in → membership lookup → child confirm.
- Commits: one ticket per commit or small set of commits, message prefixed with the key, e.g. `SCRUM-30: member lookup by normalised phone`.
- No secrets in the repo. `.env.example` documents every variable.
- Migrations are forward-only and committed. Never edit an applied migration.
- Keep `ARCHITECTURE.md` current when a decision is made or changed.

---

## 9. Working agreement — how to run this sprint

### Continuous execution
This sprint runs as one continuous piece of work. Do not stop between tickets, do not wait for confirmation after each one, and do not end your turn to ask "shall I continue". Complete a ticket, record it, commit, and start the next. The only places you stop are the five checkpoints below and the "ask when unsure" conditions in step 6.

### Checkpoints
At each checkpoint: bring `SPRINT_1_PROGRESS.md` fully up to date, write a short summary of what was built and what is next, and **stop and wait for review**. Do not proceed past a checkpoint without an explicit go-ahead.

| Checkpoint | After | What is reviewed |
|---|---|---|
| **CP1** | SCRUM-7, SCRUM-8 | `ARCHITECTURE.md`, the screen inventory, the logic inventory with file references. |
| **CP2** | SCRUM-10 | The Drizzle schema, migrations, seed, and the entity diagram. The most expensive point to get wrong. |
| **CP3** | Track B complete | Permission resolver tests, idempotency tests, audit coverage, file access tests, CI green. |
| **CP4** | Track C complete | Live walkthrough of every auth and admin flow against seeded data. |
| **CP5** | Everything | The full acceptance checklist in Section 10, run from a clean database. |

### Progress tracking
`SPRINT_1_PROGRESS.md` is the single record of state. Keep it current after **every** ticket, not just at checkpoints. A fresh session with no memory must be able to open this file and resume exactly where you left off. Required structure:

```
# Sprint 1 progress
## Status
- Current checkpoint: CPn (passed / awaiting review)
- Last completed ticket: SCRUM-xx
- Next ticket: SCRUM-xx
- Resume instructions: (what to run, what branch, anything half-done)
## Verified prototype layout
## Screen inventory
## Logic inventory (rule → prototype file:function → Sprint 1 ticket)
## Ticket log
### SCRUM-xx — title — status (not started / in progress / done)
- Ported from: (prototype files)
- Added per CLAUDE.md: (what the prototype lacked)
- UI additions: (if any)
- Tests: (what covers it)
- Deferred / notes:
## UI additions (consolidated)
## Backlog candidates
## Questions for the client
## Assumptions made (mirrors Section 11 of CLAUDE.md)
```

Update the **Status** block first and last in every session.

### Steps
1. **Read this document and `replit.md` in full.** Then run the prototype and click through everything.
2. **Write the inventories** (SCRUM-8) and `ARCHITECTURE.md` (SCRUM-7). Stop at CP1.
3. **Scaffold** (SCRUM-9) and get CI green on an empty project. Continue without stopping.
4. **Build the schema** (SCRUM-10). Stop at CP2.
5. **Then proceed ticket by ticket in the execution order in Section 5, continuously, stopping only at CP3, CP4 and CP5.** For each ticket, in this order: (a) re-read the ticket's logic sources from the SCRUM-8 inventory and open those prototype files; (b) port that logic into the service layer, preserving its edge cases; (c) add only what the ticket requires and the prototype lacks, taking the definition from this document; (d) test; (e) update `SPRINT_1_PROGRESS.md` with what was ported and from where, what was added to the UI, and anything deferred; (f) commit. If you find yourself writing a rule that exists in neither the prototype nor this document, stop: that is an assumption, and it goes in Section 11 as a question, not into the code.
6. **Ask when unsure.** Specifically: if the prototype's behaviour contradicts a ticket, if a ticket needs a UI element with no obvious home, or if a data shape in the prototype does not fit the schema. Do not guess on those. Everything else, decide and note the decision.
7. **Do not expand scope.** If you notice something worth doing that is not in Section 5, write it in `SPRINT_1_PROGRESS.md` under "Backlog candidates" and move on.
8. **Finishing:** run the acceptance checklist in Section 10 end to end from a clean database, fix what fails, tag the commit `sprint-1`, and write `SPRINT_1_REPORT.md`: what was delivered, UI additions, deferred items, known issues, and suggested Sprint 2 preparation. Stop at CP5.
9. **If a session ends mid-sprint** for any reason, the next session starts by reading `SPRINT_1_PROGRESS.md` → Status, then continues from "Next ticket" without re-doing completed work.

---

## 10. Acceptance checklist for Sprint 1

From a clean checkout on a machine with Docker:

- [ ] `pnpm install && docker compose up -d && pnpm db:migrate && pnpm db:seed && pnpm dev` works with no manual steps
- [ ] CI is green
- [ ] Lock screen → sign in by phone → POS home
- [ ] New invited account completes setup and signs in
- [ ] Password recovery works and kills old sessions
- [ ] Sign out returns to lock screen; old cookie rejected
- [ ] Admin: create operator, branch, administrator
- [ ] Admin: create account, assign branch-scoped role, view effective permissions
- [ ] Admin: deactivate account; that account cannot sign in
- [ ] Admin: create ticket package with weekday/weekend prices; add a holiday range; POS shows correct pricing mode for today
- [ ] Admin: set VAT and service charge; resolver returns correct values with an override
- [ ] POS: customer enters phone on display → till shows member and children
- [ ] POS: confirm visiting children; edit an allergy; visit created
- [ ] POS: create new member from phone and name
- [ ] Every action above has an audit row
- [ ] Replaying any mutating request with the same idempotency key does not duplicate
- [ ] Profile photo upload and permission-checked retrieval work
- [ ] All screens outside Sprint 1 still render on mock data

---

## 11. Assumptions made for this sprint

These are gaps where neither the prototype nor the requirements defined the behaviour, so a working default was chosen. **Before relying on any of them, check the prototype code first.** If the prototype already answers the question, the prototype wins and the assumption is removed from this list. If any of these turn out wrong, update this section and the code. Add new assumptions here as questions for the client rather than silently building on them.

- Weekend means Saturday and Sunday. Holidays are branch-configured date ranges.
- VAT is 7% and prices shown to customers include VAT.
- One session per device; the POS locks after inactivity and unlocks with the password.
- Evidence rules for expat and Thai tiers are not yet defined by the client; the tier field exists with `tourist` as default and no UI to change it yet.
- Included adults on a ticket package are counted per child ticket; overflow adults pay the overflow price. Confirm against the prototype's ticket screen.
- Phone numbers are unique per operator for both accounts and members. A staff member who is also a customer has both an account and a member record.
