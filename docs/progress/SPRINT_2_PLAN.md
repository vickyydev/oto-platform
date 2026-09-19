# Sprint 2 plan — the OTO suite: POS and booth first, then OTO App, Radar and the Inbox

Status: proposed 2026-09-19; widened 2026-09-20 after the owner's review
(`docs/briefs/OWNER_DIRECTION.md`, section 2026-09-20) — awaiting owner
approval. **There is no Sprint 3**: this sprint finishes all the software,
and what follows it is on-site testing with the real devices, not more
development (OWNER_DIRECTION 2026-09-20 later). Once approved, the
twenty-four tickets below become the Sprint 2 Jira tickets, one issue per
ticket. Where a ticket is split into lettered parts
(S2-01a/b/c, S2-07a/b, S2-09a/b, S2-10a/b, S2-14a/b, S2-15a/b, S2-17a/b/c) the
parts are sub-tasks or sections of that one issue, each with its own acceptance
criteria and QA steps, and evidence is posted per part as in Sprint 1
(`docs/qa/jira-comments/`). Every QA step is tagged **QA (UI)** (a
non-developer can do it from a browser) or **Dev evidence** (test output,
migration log, one per part at most). The technical plan that tells an agent
how to build each ticket — architecture, conventions, research conclusions,
resume protocol — is `docs/architecture/DEVELOPMENT_PLAN.md`; the live log is
`docs/progress/SPRINT_2_PROGRESS.md`.

Sources, in order of precedence: `docs/briefs/OWNER_DIRECTION.md` (newest,
wins), `docs/briefs/PROJECT_CONTEXT.md` (the target system),
`docs/briefs/POS_BACKEND_LOGIC.md` (the previous developer's explanation of
the prototype's rules — ranks with the prototype code),
`docs/briefs/AGENCY_PROPOSAL.md` (what the OTO App contract still owes),
`docs/architecture/PLATFORM_PLAN.md`, `docs/architecture/DEVICE_INVENTORY.md`
(the park's real devices, protocols and values),
`docs/architecture/PAYMENT_GATEWAY.md` (the 2C2P integration),
`docs/features/booth.md`, `docs/features/oto-app.md`,
`docs/features/oto-radar.md`, `docs/features/inbox.md`. Rule ids
`R-nn` and conflict ids `C-nn` cited on the tickets refer to
`docs/architecture/POS_RULES_RECONCILIATION.md`, which reconciles those sources
once so nobody re-derives an answer. Where this plan departs from
`PROJECT_CONTEXT.md` (sections 2 and 14) or `DEPLOYMENT_TOPOLOGY.md` it follows
`OWNER_DIRECTION.md`; the deviations are listed in "Scope" and are recorded in
`docs/progress/SPRINT_2_PROGRESS.md` on the first build day.

**Sprint goal.** Put a client-playable OTO suite on Render, in this order of
priority: (1) a styled launcher with one sign-in and the **POS complete** —
till and customer display as separate devices linked through a cloud-hosted
"virtual box", the prototype's admin panels, booking-site screen and stock
controls, a complete money path (ticket, F&B and shop checkout; cash, EDC
terminals through their real ECR dialects on simulators, **real Thai QR
through the 2C2P sandbox** (the park's SCB-acquired gateway) with the PAX
terminal's own QR as the offline fallback; receipts and signed wristbands on simulators of the park's real
printers), the **Lucky Wheel booth** issuing printed vouchers that the till
redeems, then arrival with the real gate protocol, child check-in with offline
release, wallets, stock and day-close reporting; (2) the **OTO App** on the
central database with one sign-on — its schema first, so an admin-created user
opens it from the launcher, then the whole live app lifted and the features
still owed under the contract built; (3) **Radar** live on the platform,
showing seeded legacy Pisell/Papaya figures or the real OTO POS analytics per
branch preference; (4) the **Unified Inbox** data pillars and a mockup shell.
(5) the remaining feature areas the contract names — events, parties and
camps, the self-service kiosk, staff benefits; (6) the **Console**, the
owner's own super-admin control surface over all apps; (7) the real
production data restored under it all, so the client plays with his own
figures; (8) the branch-box image and the on-site bring-up runbook, ready for
the day the hardware is connected.

All of it on a hardened, transactional platform where every API call, service
operation, job and device call is logged, silent failures are detectable, and
health is visible on admin pages that plug into HyperDX or any OpenTelemetry
tool through environment variables alone; every function committed as it
lands and recorded so any agent can resume.

**After this sprint there is no further development sprint.** The next phase
is on-site: connect the real printers, terminals, scanner and gate, work
through the "confirm on site" list in `DEVICE_INVENTORY.md`, fix what the
real world breaks, and let the client use the suite against the real backend.
The Render environment keeps the name *staging* and the staging safeties
while the agency's system is still live, but the code in it is the production
code.

## What the client will be able to do

Each milestone is what is clickable on the Render URLs after the named ticket
merges. The ordering pulls the wheel forward (ticket 7) and puts the first real
sale at ticket 10; the POS play-test opens after S2-11, when a sale also prints
and appears in History, so the client is not asked to judge a till that prints
nothing. The OTO App, Radar and Inbox milestones follow the POS.

| Milestone | After | What the client can click |
|---|---|---|
| M0 — front door | S2-03 | Open the launcher URL — an OTO-Park-styled landing page listing POS, OTO App, Radar, Lucky Wheel, Console and Inbox — sign in once, land in the POS without a second password; the OTO App tile already proves the shared database (S2-17a, pulled forward before CP1: its schema is in the central database and an admin-created user opens the OTO App through the launcher with no second password); Radar and Inbox tiles open "coming soon" shells; the console tile opens Console v1 with Activity, Failures, Health and Integrations pages showing the sign-in and a member lookup as rows; Sprint 1 membership check works against the Render API. |
| M1 — stations and boxes | S2-05 | Admin creates a station on the virtual box in Console > Devices and assigns simulated devices; staff sign in and pick the station; Health shows the box heartbeat; toggling the virtual box offline lets the till create a member from the cache, and the member syncs once when the box returns. |
| M2 — Lucky Wheel | S2-07b | Open the virtual booth from the launcher's demo tile, press the button key, the wheel spins and a voucher with Thai/English prize and QR renders in the printer simulator; the booth admin panel changes prize weights and the booth picks the new version up within a minute; the booth keeps issuing while offline and syncs on return; Health shows the booth, its printer and alerts. |
| M3 — two-device POS | S2-08 | The customer display pairs to a station by 6-digit code on a second device; a phone typed on the display makes the till show the member and children; the display never receives allergy text. |
| M4 — first sale and redemption (internal) | S2-10b | Ticket, F&B and shop carts price server-side with tier, adult rules, add-ons, promo codes, manual discounts and VAT; cash, simulated card on the NEXGO/PAX dialects (approve / decline / no-response → inquiry), a **real 2C2P sandbox QR** on the display confirmed by 2C2P's backend notification, the PAX terminal's QR when the box is offline; a printed booth voucher and a legacy code redeem inside a sale. **Not yet the client play-test:** no receipts, no wristbands, no History and no refunds until M5, so feedback on those would be noise. |
| M5 — paper and corrections (client play-test opens) | S2-11 | Receipts, kitchen/bar tickets and kids/adult wristbands with scannable signed codes render in the printer simulator; History lists real sales; refunds, voids and reprints work with manager approval. The play-test guide is issued here. |
| M6 — arrival and children | S2-13 | Online booking paid on the 2C2P sandbox hosted page (cards, PromptPay, wallets) produces a signed QR; the till redeems it and issues bands; the gate simulator — the GE-X2/HX-X1 controller and its network QR reader speaking their real protocols — admits adults with anti-passback and live occupancy; an unaccompanied child triggers the supervision gate, consent on the display, the check-in board with timers, and release with a collector photo while the box is offline. |
| M7 — money and day close | S2-15b | Wallet credit spent at F&B with the offline cap; stock decrements, transfers and stock take; cash session with float, paid-outs and safe drops; End of Day per tender and TID with settlement export; Today and History on real data; daily analytics rows per branch/day/source with the marketing-channel breakdown. |
| M8 — POS complete | S2-21 | Everything the contract names on the POS side works: events, parties and camps with attendee records and passes, the self-service kiosk redeeming a booking on its own, and staff benefit profiles applied at checkout. |
| M9 — the client's own data | S2-22 | The suite runs on the real production data: the OTO App's live rows restored into the central database, members and employees the client recognises, Radar showing real figures. |
| M10 — OTO App on the platform | S2-17c | The live OTO App runs from the launcher on the central database with one sign-on: every module the export has works against the `otoapp` schema, the POS-facing seams (members, events, employees) read the same rows the POS writes, and the contract features listed in `docs/briefs/AGENCY_PROPOSAL.md` §6 are built. |
| M11 — Radar live | S2-18 | Radar opens from the launcher; each branch has a source preference — legacy (seeded Pisell/Papaya-shaped fixtures) or OTO POS — and a demo sale made on the staging POS changes the Radar dashboard for that branch within the rollup interval. |
| M12 — Inbox working | S2-19 | The Inbox tile opens the client's design backed by the `inbox` schema: conversations route by category to the right team, an owner and support assignees, reply and Handled, templates, the dashboard; messages flow through the channel adapters end to end on the simulator, and a real WhatsApp/Instagram/LINE account is connected by configuration when the business accounts exist. |
| M13 — the owner's console | S2-23 | One place that controls everything: every account and app grant across the suite, activity and data-access logs, failures and alerts, health, boxes and devices, integrations, analytics sources, money oversight, support tools (cross-app lookup, audited impersonation, "what happened to this sale"), release flags and kill switches. |
| M14 — ready for the park | S2-24 | The branch-box image builds and boots, the on-site bring-up runbook is written against the real device list, and every simulator has a documented switch to its real transport. |
| M15 — acceptance | S2-16 | Full acceptance checklist run from a clean database on refreshed staging, load and soak checks, tag `sprint-2`, evidence comment on every story, client play-test guide. |

## Readiness — what exists, what is new

The repository holds the Sprint 1 platform (tag `sprint-1`) and the Replit
prototype in `imports/oto-pos/`. The table is what the code shows today, not
what the reports say.

| Area | Built in Sprint 1 (where) | Sprint 2 adds |
|---|---|---|
| Database | 37 tables + 7 enums, all in `public`, plain `pgTable` across `packages/db/src/schema/{tenancy,members,catalog,platform,future}.ts`; migrations `0000` (baseline, 64 FKs, 10 `ON DELETE CASCADE`), `0001` (booking reference unique), `0002` (contact_channel `line`); seed `packages/db/src/seed/index.ts` (operator OTO, HKT Central, 4 departments, 3 tiers, system roles, 2 dev accounts, 6 members / 5 children, 4 packages, 1 holiday, 7 % VAT inclusive, 1 station) — a no-op once OTO exists, so role changes never re-sync; embedded-Postgres test helper `packages/db/src/testing.ts`. Eleven placeholder tables (`booking`, `attendee`, `transaction`, `transaction_line`, `payment`, `wallet`, `wallet_entry`, `wristband`, `item`, `stock_location`, `stock_level`) are text-status/jsonb stubs; `station` has no operator, box, code or devices; `session.station_id` is never set. | Migration 0003: named schemas `core/crm/pos/promo/booth/analytics/edge`, placeholder renames, CASCADE removal, text+CHECK enums; then ~55 new or reshaped tables across boxes/devices/sync, sale/payment/refund/bands, booking/redemption, wallets/cash, promo/booth/marketing channels, analytics, ops/alerts; re-runnable `platform:sync` seed; pool limits and timeouts; expand/contract migration policy from 0004. |
| API | Fastify 5 + zod + Drizzle, 63 routes in 12 groups (`apps/api/src/routes/*.ts`, registered in `apps/api/src/app.ts` lines 141-152), OpenAPI at `/docs/json`; services exist only for auth, audit, permissions, files, sms and tax (`apps/api/src/services/`); business logic for accounts, operators, branches, members, children, visits, catalog and bookings sits in route handlers; **zero `db.transaction(` calls** in `apps/api/src` — multi-row writes and their audit rows are separate autocommit statements; `POST /public/bookings` marks bookings `paid` with no payment (`routes/public.ts` line 230); Fastify is built without `trustProxy` (`app.ts` lines 71-75), so behind Render's proxy `req.ip` is the load balancer; 63 Vitest cases in 7 files. | `withTx` service layer with audit inside the transaction; client-generated UUIDv7 ids accepted (existing row returned with 200 + `x-oto-replay`); `TRUST_PROXY`; new route groups for stations/boxes/devices, box sync, sales, payments, refunds, bands, print jobs, vouchers/redemption, booth, bookings, check-in, wallets, stock, cash/EOD, analytics, admin health/failures/alerts/integrations, client telemetry. |
| Auth and permissions | Opaque hashed session cookie, `sameSite: 'lax'` (`apps/api/src/plugins/session.ts` line 44) — the POS reaches the API only through the same-origin Vite `/api` proxy (`apps/pos/vite.config.ts` lines 32-36); argon2 sign-in with in-memory throttle (`services/auth.ts`), setup/reset codes via SMS adapter, `req.requirePermission()` called by hand inside handlers, scoped resolver `services/permissions.ts`, 29 permission strings in `packages/shared/src/permissions.ts`. **Defect:** `routes/accounts.ts` lines 98-108, 149-181, 214-281 let any holder of `admin:role:assign` (branch_manager included) grant `platform_admin` platform-wide to any account, and let a branch manager issue a temp password for the operator_admin. `findAccountByPhone` and `/public/member-tier` are not operator-scoped. No CORS/origin check, no generic rate limit, no force sign-out. | Dominance, operator and scope checks; route-option guard plus a test that fails when a route lacks a permission; PG-backed throttle for sign-in and unlock; `@fastify/rate-limit` on a Postgres store; origin check; same-origin `/api` rewrite on every static site (SameSite=Lax kept); lock/unlock session model; force sign-out; hand-off tokens; device credentials; signed staff token; Sprint 2 permission vocabulary. |
| POS inactivity lock | `apps/pos/src/auth/OperatorContext.tsx` lines 82-89 and 132-146: the 2-minute inactivity timer calls `logout()`, which POSTs `/auth/sign-out` and **deletes the server session**; unlocking is a fresh online sign-in. Timing constants live in `apps/pos/src/mockApi.ts` lines 607-608. | `POST /auth/lock` keeps the session (`locked_at`), `POST /auth/unlock` re-verifies the password against the existing session under the sign-in throttle; offline unlock through the signed staff token. |
| Idempotency and audit | Global opt-in preHandler `apps/api/src/plugins/idempotency.ts` (SELECT then upsert with `onConflictDoUpdate` — two concurrent requests with one key both run the handler; account + key, request hash, 409 on mismatch; stores 4xx/5xx replies too; no purge); `audit.record` (`services/audit.ts`) called from 32 sites, none transactional; `GET /audit` (`routes/audit.ts`) filters entity/actor/branch/date, limit 200, no pagination, returns before/after verbatim including phone and allergy text. | Atomic key claim (`INSERT … ON CONFLICT DO NOTHING RETURNING`), in-flight reply with `Retry-After`, response stored in the business transaction, 5xx never stored, expired-key purge, principal account|device; audit classification columns, denial and failed-sign-in rows, masking at write for child health text and at read for the rest, `station_event` for intents/snapshots, BRIN + keyset pagination. |
| Logging and health | pino with request id only (`apps/api/src/lib/logger.ts`, `app.ts` lines 71-75); no account/branch bindings; 4xx never logged; Sentry is a log tag with no SDK (`lib/error-reporting.ts`); `/health` static, `/ready` = `select 1` (`routes/health.ts`). **PII leak:** Fastify's default request log writes `req.url` including `?phone=` (`app.ts` line 74, `routes/members.ts` lines 96-105) and the SMS adapter logs phone and message including the code (`services/sms.ts` lines 27, 48, 51); pg errors are rethrown with `detail` (which carries the conflicting value). | `@oto/telemetry` package, telemetry plugin, pg-error scrubber, `ops_run`/`ops_last`/`ops_expectation`/`alert`/`alert_delivery`, watchdog and housekeeping jobs, `/ready` with real checks and an external pinger, OTel bootstrap (traces + logs bridge) dormant until an OTLP endpoint is set, client telemetry endpoint, Activity / Failures / Health / Integrations pages. |
| POS frontend — wired to the API | `apps/pos` (325 files; React 19 + Vite 7 + wouter). Wired: lock screen sign-in/setup/reset/sign-out (`components/auth/LockScreen.tsx`), session resume, Tickets-tab membership check, create member, children re-confirm + draft visit (`pages/Till.tsx` lines 317-390, `components/till/VisitChildrenModal.tsx`), tier verification (upgrade with expiry only; no downgrade, no expiry job), pricing-mode chip, catalogue hydration (`api/catalogBridge.ts`), 7 admin panels (Tickets, holidays, Tax, Members, Tier Verifications, Login Users, Operators). 13 files import `src/api/*`. | Station pick, `/display` route, cart/session document over WebSocket, tenders, printing, History, check-in, wallets, stock, Today/EOD, catalogue admin panels, tier downgrade and review flag, PWA. |
| POS frontend — still on mock | `apps/pos/src/mockApi.ts` (5,837 lines, 141 exports, imported by 80 files) + `store/catalogStore.ts` (1,837 lines, 27 importers): selling (`recordSale`, wallets, wristbands, `lib/printRouting.tsx`), F&B, Shop, Events, Check-in, History, Today/EOD, Messages, Stock, and 20+ admin panels; the split-view customer display shares React state by props; the "pending lookup" round trip is staged and consumed by the same browser and cookie (`routes/me.ts` lines 121-154); `MobileTill`, `BookIdentify`, `PartyTicketModal` and the Till's event-pass path still read mock members. | Every tab except Events/parties and Messages is wired; those two stay on mock behind the existing flag and are labelled as such in the play-test guide. |
| Booking site | `/book` wizard (`pages/Book.tsx`) loads the public catalogue and calls `POST /public/bookings`, but the mock `createBooking` still produces the confirmation QR and the till's `RedeemBookingModal` reads mock bookings only; no payment. | 2C2P Redirect (sandbox or simulator), signed booking QR, redemption at the till and kiosk-ready redemption service. |
| OTO App (`imports/oto-app/`) | Export of the live system: Express 4 + Passport-local + Drizzle, 796 routes (517 in one 25,504-line `routes.ts`), 184 tables, React front end with 122 routes, Dockerfile present, scrypt password hashes, S3 storage without endpoint option, four local-disk writers, Replit-keyed cookie security; the intake's re-hosting work list and sign-on swap are in `docs/architecture/intake-2026-09-19/01-oto-app-backend.md` §10. Not on the platform. | S2-17: `otoapp` schema on the central database, hand-off sign-on middleware + `platform_user_id`, provisioning from the Console, Docker service on Render, storage on the platform bucket, jobs under `ops_run`, POS seam views, contract features from the proposal. |
| Radar (`imports/oto-radar/`) | Export of the live dashboard: Express + React, 107 routes (96 public, no auth), Pisell (v30) and Papaya (v21) sync pipelines with credentials in Replit Secrets, structure-only database listing, dev-to-prod push routes that leak data; work list in `05-radar-api-auth-env-schema.md` §9. Not on the platform. | S2-18: `radar` schema, sign-on in front of everything private, push/wipe routes deleted, per-branch source preference, fixture adapters for the legacy pulls, OTO POS figures from `GET /analytics/summary`, parity test. |
| Inbox (`imports/oto-asset-manager/`) | Client's Replit prototype: React front end on 17 hard-coded conversations, Express skeleton with one health route, empty Drizzle schema, no auth, no channel code; briefs and screenshots in `attached_assets/` (`docs/features/inbox.md`). | S2-19: `inbox` schema and permissions, seed, read-only routes, static shell in the client's design, `MessagingChannel` contract with a console adapter. |
| Payment gateway | Nothing: `POST /public/bookings` marks bookings paid with no payment; PROJECT_CONTEXT §7.2 chose 2C2P; no credentials. | `packages/payments-2c2p` (Payment Token, Do Payment PromptPay QR, Redirect API, backend notification, Payment Inquiry, Payment Maintenance) on the sandbox with real QR codes, a gateway simulator for CI, `PGW_*` variables (`docs/architecture/PAYMENT_GATEWAY.md`). |
| Deployment and CI | `.github/workflows/ci.yml` (typecheck, lint, migrate twice, test on a Postgres service container, build); `infra/docker-compose.yml` for Postgres 16 + MinIO; `.env.example` (missing `NODE_ENV`, `LOG_LEVEL`, `TEST_DATABASE_URL`); `env.ts` bakes dev MinIO credentials as defaults. No `render.yaml`, nothing deployed. | `render.yaml` (one api web service running `PROCESS_ROLES=api,edge,jobs` at `numInstances: 1`, static sites with `/api/*` rewrites for launcher/POS/console/booth/shells, managed Postgres Singapore with PITR, a commented-out worker service), CI-gated deploy, migrations + `platform:sync` on deploy, staging profile (`SMS_ADAPTER=console`, `ALERT_CHANNELS=console,webhook`) with an audited "Reset demo data" action. |
| Tests | 63 API integration cases (`apps/api/test/*.test.ts`), 19 shared unit tests (one file, `packages/shared/test/shared.test.ts`), 2 Playwright smokes (`apps/pos/e2e/smoke.spec.ts`); the two file-storage tests self-skip without MinIO. | Regression fixtures from the prototype pricing/tax functions, redaction (incl. pg error and terminal response fixtures) and OTel span tests, idempotency concurrency test, sync idempotency/poison/epoch tests, 200-spin distribution test, boot-refusal test, schema_version replay test, Playwright smokes against two origins for launcher → station → sale, display pairing, booth → redemption, booking → gate, check-in → offline release; k6 load and 24 h soak. |

## Scope

### In scope

- Fix the known defects before anything client-facing is deployed:
  role-assignment privilege hole, no database transactions, inactivity lock
  signing out server-side, PII in request/SMS/pg-error logs, idempotency race,
  proxy-blind rate limiting.
- Named database schemas and the placeholder renames while the database holds
  only seed data.
- Launcher: an OTO-Park-styled landing page listing every app (POS, OTO App,
  Radar, Lucky Wheel, Console, Inbox) with "coming soon" tiles until an app is
  ready, and centralised sign-in (a signed hand-off token per app origin —
  works on `*.onrender.com` today and on any future domain, so it is the
  permanent mechanism; a parent-domain cookie becomes an optional shortcut once
  a real domain exists); Console v1 as its own deployable (built in S2-03).
- OTO App on the central database: its schema (`otoapp`) migrated into the
  platform database and the app's sign-on replaced by the launcher hand-off
  first (S2-17a, before CP1, so an admin-created user proves the shared
  database and one login), then the whole live app lifted onto Render against
  that schema with every module the export has (S2-17b), then the features the
  contract still owes, taken from `docs/briefs/AGENCY_PROPOSAL.md` §6
  (S2-17c). The OTO App keeps its own admin controls; the POS keeps its own
  admin panels.
- Radar live on the platform (S2-18): schema `radar`, sign-on required, a
  per-branch source preference (legacy | OTO POS), seeded Pisell/Papaya-shaped
  legacy fixtures for the demo, and the OTO POS branch reading the analytics
  rows the POS writes, so a demo sale on staging shows up in Radar.
- Unified Inbox (S2-19): schema `inbox`, the client's design, routing by
  category to the four teams, primary and support assignees, reply, Handled,
  templates, tags, the management dashboard, and the channel adapters
  (WhatsApp Business, Instagram, LINE, email, web form) wired end to end
  against a channel simulator so connecting a real business account is
  configuration, not code.
- Events, parties and camps, and the self-service kiosk (S2-20): the unified
  attendee record, flat-price event passes, event check-in with band rules,
  party tabs and deposits, camp registration with the six-digit code, and the
  kiosk surface that redeems a booking and prints bands on its own.
- Staff benefits (S2-21): HR-linked benefit profiles (person or role; free
  items, credit, discount, categories, periods, effective dates, benefit QR)
  and their application at checkout in the canonical order with period resets
  and concurrency-safe usage records.
- The real production data (S2-22): the OTO App's live dump restored into the
  central database as the starting point, the platform's own tables seeded
  from it where they share identity (members, employees, branches), Radar
  given real figures, and the cutover rehearsal proven end to end.
- The Console as the owner's super-admin control surface (S2-23): tenancy and
  org, people and access across every app, the app registry, activity and
  data-access logs, failures and alerts, health, boxes and devices,
  integrations, analytics sources, content and configuration, data tools,
  money oversight, support tools and release controls.
- The branch-box image and on-site readiness (S2-24): the box image, the
  bring-up runbook against the real device list, and the documented switch
  from every simulator to its real transport.
- Observability: every request, service operation, job, webhook, sync batch,
  device call and client-side failure logged and, where it can fail silently,
  recorded in `ops_run`; watchdog, alerts (console, email, generic webhook),
  health endpoints with an external pinger, Activity / Failures / Health /
  Integrations pages; OpenTelemetry bootstrap (traces and logs) for
  HyperDX-or-similar later.
- Station model: boxes, stations, devices, pairing, station pick, wizard,
  cloud virtual box, offline toggle with an offline capability matrix.
- Box agent runtime: station session document with lease fencing, cache
  bundles, durable outbox and sync ledger with cloud-issued epochs, signed
  staff token, PWA shell, print pipeline, scanning service, and a simulator for
  every device the park owns (Welltech G4 and Xprinter ESC/POS receipt printers,
  4B-2082A wristband printers, NEXGO N5 and PAX A920Pro terminals in their ECR
  dialects, the 2C2P gateway, the PAX terminal's own QR payload, the Zebra
  scanner on the box, the GE-X2/HX-X1 gate with its network QR reader, USB
  button, badge/PIN, cash drawer) — models, protocols and values from
  `docs/architecture/DEVICE_INVENTORY.md`.
- Lucky Wheel booth: game app, booth box role, spins and vouchers, voucher
  printing, offline operation, heartbeat and alerts, booth admin control panel,
  voucher definitions with campaign and marketing channel, POS redemption
  inside a sale, legacy codes and reservations from a fixture, per-booth report
  with prize cost.
- Customer display as a separate device.
- Checkout for tickets, F&B and shop with the prototype's pricing, discount,
  promo and tax rules ported to satang; member tier change (upgrade and
  downgrade, manager gate, expiry review flag); sale facts carrying the
  analytics fields from the first sale.
- Tenders: cash, EDC terminal simulators with the inquiry rule and
  per-terminal reference counters, **real Thai QR through the 2C2P sandbox**
  (Payment Token → Do Payment on the PromptPay QR channel, shown on the
  display, confirmed by 2C2P's backend notification with Payment Inquiry as
  the safety net; the gateway simulator only when no credentials are
  configured) with the PAX terminal's QR as the offline fallback, manual
  recording, refunds (Payment Maintenance) and voids by tender kind,
  online-only with manager approval.
- Printing: receipts with cloud-issued series, kitchen/bar tickets, kids/adult
  wristbands with signed codes, credit/item vouchers, templates admin,
  reprints, printer health; all provable offline.
- Arrival: online booking payment through the 2C2P Redirect API sandbox
  (hosted page: cards, PromptPay QR, wallets), signed booking QR, redemption at
  the till,
  gate simulator speaking the GE-X2/HX-X1 protocol and the reader's HTTP
  contract, anti-passback and live occupancy.
- Child check-in and supervision with offline check-in and offline release
  (photo captured on the box, uploaded on reconnect).
- Wallets (credit grants, band-keyed spend with offline cap) and stock
  (locations, decrements, transfers, purchase orders, stock take).
- Cash sessions, End of Day, settlement export, History and Today on real
  data, daily/hourly analytics summaries with per-branch source switch,
  marketing-channel breakdown and a multi-branch summary API.
- Acceptance run from a clean database on Render, load and soak checks,
  `sprint-2` tag, `SPRINT_2_REPORT.md`, evidence per Jira story, client
  play-test guide.
- Working method for the whole sprint: every function is committed when it
  lands (conventional commits per `CONTRIBUTING.md`), the ticket log in
  `docs/progress/SPRINT_2_PROGRESS.md` is updated in the same commit series,
  and every decision or deviation is written to the decisions log in
  `docs/architecture/ARCHITECTURE.md`, so any agent resumes from the log
  without re-deriving anything (`docs/architecture/DEVELOPMENT_PLAN.md` §1).

### Not in this sprint's code, and why

There is no Sprint 3. Nothing below is deferred development: each row is
either an **on-site step** (the phase that follows this sprint), a **credential
or account** we do not hold yet, or an item genuinely waiting on the owner.
Every one of them has its software built in this sprint, so the remaining work
is connecting, not coding.

| Item | What we build now | What is left, and when |
|---|---|---|
| Real device transports: the serial links to the NEXGO N5 and PAX A920Pro, raw TCP 9100 to the physical Welltech/Xprinter/4B-2082A printers, the HX-X1 serial line and the gate reader on the LAN, the Zebra scanner on a real box | Every adapter written against the real protocol, every simulator speaking the real dialect, the "confirm on site" list in `DEVICE_INVENTORY.md`, and a bring-up runbook (S2-24) | Plugging the cables in at the park and working through the confirm-on-site list — the on-site testing phase, not a sprint |
| The Pi 5 boxes themselves | The box image, the agent, the `Store` interface with its SQLite implementation, `schema_version` and version reporting (S2-24) | Flashing and booting real hardware; the image is proven on the first Pi that reaches a desk or the park |
| 2C2P production go-live | The full 2C2P integration against the sandbox, real QR codes, webhook, inquiry, refunds, settlement import (S2-10a, S2-12, S2-15a) | Production merchant credentials, the QR channel enabled, return URLs registered — configuration only (`PAYMENT_GATEWAY.md` §5) |
| Live WhatsApp Business, Instagram, LINE and email accounts | The channel adapters, inbound webhook receivers, outbound send, media handling and the whole Inbox against a channel simulator (S2-19) | Business accounts and BSP approval (weeks of paperwork, outside our control); connecting one is an environment variable and a webhook URL |
| Radar's live Pisell and Papaya pulls | Both pipelines running against fixture adapters shaped like the real responses, the per-branch source switch, and the parity test (S2-18) | The Pisell and Papaya credentials, still in Replit Secrets; switching `*_MODE` from `fixture` to `live` |
| Real staging domain, parent-domain cookie shortcut, separate api/edge/worker services, per-service database logins | The hand-off sign-on that works on any domain, `PROCESS_ROLES` as the split switch, the worker service present in `render.yaml` | DNS for the real domain; the service split is flipped before the suite carries production traffic |
| Thai TV fonts, Benzin font, dragon art and audio licences; seasonal wheel layouts beyond the first | The layout engine, the publish/version pickup, one complete template (S2-07b) | The owner's licence decisions and artwork |
| Spin eligibility modes `band` and `phone` | Both modes implemented and tested; publishing them refused with a clear message until a park booth exists (S2-07b) | A booth inside the park |
| Audit log partitioning and long-term archive export | BRIN indexes, the `station_event` split, category retention and the purge job (S2-03) | Partitioning when the volume warrants it; the retention policy itself is Open decision 33 |
| Overstay billing, wallet expiry policy, tier evidence list | Overstay shown and billable by configuration; wallet expiry, reactivation and the liability report built (S2-14a); the tier evidence list editable data | The owner's numbers and policy choices (Open decisions 12, 13, 14) |

## Contract coverage — the agency proposal mapped to tickets

`docs/briefs/AGENCY_PROPOSAL.md` captures the agency's proposal (24
features, 121 stories) and, in its §6, what the proposal shows as not yet
built. Most of that is the POS — the proposal's "New functionality" is the
system this sprint builds — and the rest are gaps in the live OTO App. The
map below is what the owner reviews for Open decision 30; the last column
names what this plan defers and needs a yes or no.

| Proposal §6 group | Covered by | Note |
|---|---|---|
| 6.1 Accounts, access, platform administration | Sprint 1 (verify error-text parity, department/record scope UI, temp-password enforcement in S2-01a) | — |
| 6.2 Timekeeping and daily-operations gaps in the OTO App | S2-17c (the seven items become its sub-tasks) | — |
| 6.3 Members and visitor details | Sprint 1 + S2-09a (tier verification UI incl. revoke across branches, unknown-birth-year path, field change history, concurrent-edit warning) | — |
| 6.4 Branch catalog, pricing, checkout | S2-09a/b (quote, tax modes and discount placement, manual discounts, **branch catalog clone**), S2-10a (payment recording, split parts, external-handling confirmation), S2-11 (credits/refunds with tax, wallet and stock reversal) | Complete |
| 6.5 Sales and transaction records | S2-15a/b (Today with freshness and states), S2-11 (History with filters, detail links, frozen totals, logged lookups) | — |
| 6.6 Wallets and promotions | S2-14a (issuance, band/QR keys, atomic spend, liability report, **end-of-day expiry with permission-gated reactivation**, **targeted promotional vouchers with global and per-customer limits and foregone-revenue reporting**), S2-09a (promo codes) | Complete; the expiry *policy* values are the owner's (Open decision 14) |
| 6.7 Food and beverage | S2-09b (menu, modifiers, cart), S2-11 (paid-only routing, multi-station tickets, no duplicate on print failure), S2-14a (child order from a band scan with allergy alert) | — |
| 6.8 Gate access and occupancy | S2-11 (band issuance, gate rights, group linkage), S2-12 (live occupancy, asymmetric rules, exceptions), S2-15a (**end-of-day stranded list, operator-and-reason manual resolutions, closure keeping history**) | Complete |
| 6.9 Child supervision and release | S2-13 (all items) | — |
| 6.10 Booking and admission redemption | S2-12 (public booking, signed QR, exactly-once redemption, separate admission/drop-off redemption), S2-20 (**unified attendee record, flat-price event passes, event check-in, party tabs and deposits, camp registration, self-service kiosk**) | Complete; events stay mastered by the OTO App (C10) with the POS reading through views |
| 6.11 Inventory and purchasing | S2-14b (items, variants, **pack conversions**, locations, transfers, stock take, purchase orders, **deduplicated low-stock attention with the rule that produced it**) | Complete; the predictive threshold starts from the static reorder point until history accrues (Open decision 27) |
| 6.12 Printing, scanning, hardware | S2-04 (printer roles), S2-06 (scanning), S2-11 (receipts, bands, vouchers, reprints) | — |
| 6.13 Reporting and employee benefits | S2-15b (sales and ticket-mix report, wallet liability, promotions and comps report), S2-21 (**HR-linked benefit profiles and benefit application at checkout**) | Complete |
| 6.14 Customer messaging | S2-19 (the whole Inbox: routing, assignment, reply, Handled, templates, dashboard, **channel adapters**, **AI classification and Thai-English translation behind the AI provider setting**, **guardian pickup-photo promotion into the registration**) | Complete in code; a live channel needs its business account (see "Not in this sprint's code") |

Nothing in the proposal's §6 is now deferred development. The proposal also
carries decisions the owner has already changed
(payments recorded manually → 2C2P and EDC ECR integration; SvelteKit +
Python + AWS → TypeScript on Render; face identification → banned for the
POS, open for the OTO App) and questions of its own (§7), which are folded
into Open decisions 29–31.

## Design decisions this sprint locks in

- **Named schemas now (migration 0003).** `CREATE SCHEMA core, crm, pos,
  promo, booth, analytics, edge` and `SET SCHEMA` for the 37 tables and 7
  enums via Drizzle `pgSchema` builders (`schemaFilter` in
  `packages/db/drizzle.config.ts`; `pgboss` is a managed schema outside Drizzle,
  migrated in the deploy step and excluded from the filter and from the
  `\dt public.*` check). The generated SQL must contain `SET SCHEMA` only, never
  `DROP`/`CREATE`. Same migration: rename `transaction→sale`,
  `transaction_line→sale_line`, `payment→payment_attempt`, `wristband→band`,
  `item→stock_item`; remove `ON DELETE CASCADE` on ledger and child tables
  (child→member becomes RESTRICT); `station_kind` and `contact_channel` become
  text + CHECK (adds `booth`, `instagram`); `role` unique on `(operator_id,
  name)` + `is_system`; `archived_at` on `role_assignment` and
  `branch_holiday`; `operator_id` on `station`. 0003 is the only migration
  allowed to break the previous release because it is the first deploy; from
  0004 every migration is expand/contract (never remove what the previous
  release reads).
- **Schema placement.** `core` = box, station, device, station_device,
  device_credential, signing_key (public keys only); `crm` = members,
  children, registrations, guardians; `pos` = sales, payments, refunds, bands,
  print jobs, wallets, stock, cash; `promo` = voucher definitions, vouchers,
  redemptions, marketing channels, campaigns; `booth` = booth config, layouts,
  prizes, spins; `analytics` = summaries and facts; `edge` = sync_event,
  sync_change, sync_cursor, sync_quarantine, sync_anomaly, box_heartbeat,
  box_command, station_event and the virtual-box `Store` tables.
- **Transactions and a service layer.** `withTx(db, ctx, opName, fn)` opens
  the transaction, runs the business function, writes the success audit row
  inside it, stores the idempotency response inside it, emits one span and one
  debug line named from the audit action vocabulary. Failure and denial audit
  rows and `ops_run` failures are written after rollback on a separate
  connection. Route handlers validate, call a service, map the result.
  `requirePermission` becomes a route option checked by a preHandler; a test
  enumerates every route and fails if a non-public route lacks a permission.
- **Client-generated ids and idempotent sync.** Every fact carries a UUIDv7
  minted by the client or box. A creating POST that hits an existing id
  returns the existing row with 200 and `x-oto-replay: true`. The idempotency
  key is claimed atomically (`INSERT … ON CONFLICT DO NOTHING RETURNING`):
  the winner runs the handler; a loser replays the stored response or gets
  409 `IDEMPOTENCY_IN_FLIGHT` with `Retry-After` and the POS polls the same key.
  Box facts carry `(box_id, journal_epoch, box_seq)`; the epoch is issued by
  the cloud at register and after any store reset (`box.current_epoch`,
  strictly increasing) and persisted with the sequence before any fact is
  acknowledged locally. The cloud applies each event under a SAVEPOINT inside
  the batch transaction: same id + same payload hash is dropped as a
  duplicate, same id + different hash goes to `sync_quarantine` with a
  `sync_anomaly`, an older epoch is rejected with an alert; never a silent
  drop. Batches are capped at 200 events / 1 MB under `statement_timeout`.
- **Station session document.** The box owns the station's current sale,
  stamps a sequence number, and pushes full snapshots over WebSocket to the
  till and a redacted view to the display. The till holds a lease (15 s
  heartbeat, 60 s TTL) stored in the box `Store`; an expired lease is claimable
  without a manager, a live one needs manager approval (`station.takeover`
  audit). Every intent carries the lease id and the last-seen sequence; a stale
  till gets `409 STALE` and rehydrates. The display credential is fenced the
  same way. Session document, cache bundle and outbox envelope carry
  `schema_version` with migrate-on-read. The Sprint 1
  `session.pending_lookup_phone` channel is retired.
- **Virtual box on Render.** The box agent (`packages/box-agent`) runs as
  `PROCESS_ROLES=api,edge,jobs` inside the single api web service
  (`numInstances: 1`) for the demo, registered as a box of role `virtual`,
  behind a `Store` interface whose Pi implementation is SQLite and whose cloud
  implementation is the `edge` schema, so sequence, lease and outbox rehydrate
  from Postgres after a restart, never from memory. The job runner runs on the
  same process under advisory-locked singletons. Both are recorded deviations
  from `DEPLOYMENT_TOPOLOGY.md` (three services) for the staging demo only;
  `PROCESS_ROLES` is the switch that splits them into separate `edge` and
  `worker` services before production go-live, and the worker service is
  already present in `render.yaml` commented out.
- **Offline rule.** The till talks only to the box surface (`/ws/station`,
  `/box/v1/station/*`) for identify, cart, tender, print and redeem; cloud
  routes are admin or read-only for the till. The offline toggle blocks the
  box's cloud client and, in test mode, returns 503 from cloud routes for that
  station credential, so an "offline" demo cannot be faked. An offline
  capability matrix (allowed / capped / refused per operation, max cache age,
  staff-token expiry, deny-list propagation) lives in ARCHITECTURE.md and every
  row is tested with the toggle.
- **Device adapters with simulators.** `packages/contracts` defines
  `PaymentTerminal` (sale/void/inquire/settle), `QrPayment`
  (create/inquire/refund), `Printer`, `ScanInput`, `Gate`, `Button`,
  `Badge/PIN`, `CashDrawer`; each has a simulator drivable from a control panel
  in the console with scripted outcomes and fault injection. The terminal
  simulators are wire-accurate at the message level from the vendor
  documents: the NEXGO/GHL adapter speaks LinkPOS XML (`SALE`/`QUERY`/`VOID`,
  card and e-wallet trade types, no QUERY for card, no VOID for Thai QR, card
  voids before settlement, wallet voids before 23:00, 12-character
  `pos_ref_no`); the PAX/Digio adapter speaks Direct Terminal frames (`3E55`
  header + BER length + BER-TLV + XOR checksum; terminal-info, login, sale and
  void action codes per payment type). Only the serial transport is stubbed. Adapter payloads
  are stored in `ops_run` only after a per-adapter allow-list projection (TID,
  MID, approval code, last4, amount, status, invoice number); the raw frame is
  kept only by the simulator. No PAN or track data is ever stored (PCI posture
  documented in ARCHITECTURE.md).
- **QR payments are real, through the 2C2P sandbox.** Owner decision
  2026-09-20 (OWNER_DIRECTION): the gateway the park uses is 2C2P with SCB as
  the acquirer, so PROJECT_CONTEXT §7.2 stands and the QR is never a mock
  when credentials exist. `QrPayment` is implemented by a 2C2P client
  (`packages/payments-2c2p`): Payment Token (JWT HS256 with the merchant
  secret; `invoiceNo` unique per payment attempt) → Do Payment on the
  PromptPay QR channel → QR rendered on the customer display (and on the
  booking site via the Redirect API's hosted page) → 2C2P's backend
  notification received on the api (`POST /webhooks/2c2p/payment`, JWT
  verified, matched to the attempt by `invoiceNo`) with Payment Inquiry
  polled as the safety net and for unresolved attempts; refunds and voids
  through Payment Maintenance. Sandbox and production differ only by
  `PGW_ENV`, base URL, credentials and the registered return URLs
  (`PGW_*` variables replace the `2C2P_*` names used in earlier drafts —
  shell-safe). When no gateway credentials are configured the gateway
  simulator (same request/response shapes, "customer paid" and "late payment"
  buttons on the Console) answers instead, so CI and a fresh checkout never
  need the sandbox. Offline: the box cannot reach 2C2P, so the tender falls
  back to the PAX terminal's own QR (Digio A3) or cash automatically. Field
  names, sandbox simulation and the credential checklist:
  `docs/architecture/PAYMENT_GATEWAY.md`.
- **Foreign apps as their own schemas on the one database.** OTO App, Radar
  and the Inbox each get a schema (`otoapp`, `radar`, `inbox`) in the
  central Postgres; each app's own migration tool runs inside its schema
  (`search_path`), additively, so the app's code stays lift-compatible with
  its Replit original and the production dump can be restored into the same
  tables at cutover (PLATFORM_PLAN §12). Cross-app links are by identity, not
  foreign keys: `core.app_identity(app, account_id, external_user_id)` maps a
  platform account to the app's own user row; the POS-facing seams read
  through views owned by the platform (members and events from OTO App,
  analytics summaries into Radar). Each app's Passport/session login is
  replaced by the launcher hand-off; the legacy password login stays behind a
  flag for the cutover rehearsal only. No app reads another app's tables
  directly.
- **Radar reads one contract.** Each branch has `analytics_source`
  (`legacy` | `oto_pos` | `both`) with a switch date. Radar's dashboards call
  `GET /analytics/summary` for OTO POS branches and its own legacy rows for
  legacy branches; the legacy rows on staging come from seeded fixtures shaped
  like the Pisell and Papaya pipelines (intake notes 03/04) until the
  credentials exist. Revenue is defined exactly as Radar's code defines it
  (formula v30 Floresta / v21 Chalong), recorded as `formula_version` on every
  summary row, so the two sources are comparable; the revenue-definition
  question is closed by the owner (2026-09-20).
- **Launcher is the brand's front door.** `apps/launcher` is designed, not a
  list: OTO Park colours, type and imagery taken from the prototype's design
  tokens (`imports/oto-pos/artifacts/oto-till/src/index.css`, logo assets in
  `attached_assets/`), one tile per app with state (open / coming soon /
  no access), the signed-in user and branch, and admin badges from S2-03. The
  same design language is reused by the Console and the Inbox shell.
- **Adapters are written against the park's real devices.** The models,
  addresses, protocols and "confirm on site" items in
  `docs/architecture/DEVICE_INVENTORY.md` are the reference for every adapter
  and simulator: ESC/POS over TCP 9100 for the Welltech G4 and the Xprinters
  (status polling, Thai code page, drawer kick, cut), the 4B-2082A wristband
  printers in their documented label language, the Zebra scanner **attached to
  the box** (HID or USB-CDC) with scans published on the station channel, the
  GE-X2/HX-X1 gate (reader HTTP `checkCard`/`heartbeat` hosted on the gate
  box, dry-contact open, passage feedback over serial), the NEXGO and PAX
  terminals over USB serial in their ECR dialects.
- **Sign-in on Render.** Every static site has a rewrite rule `/api/* →`
  api service, so each app is same-origin with its API path, the session
  cookie stays `SameSite=Lax` and no CORS is needed; the hand-off token exists
  only because the apps themselves are different origins. The launcher issues
  a 60-second single-use signed hand-off token carried in the URL fragment
  (never the query string), bound to session id, audience origin and the
  exchange request's `Origin`, consumed atomically; signed with
  `HANDOFF_SIGNING_KEY` (kid-rotated) from env. Sign-out revokes the session
  and every app cookie. This is the permanent sign-on mechanism (it works on
  any domain, including the booking site's); it sits behind one adapter so a
  parent-domain cookie can be added later as a shortcut without touching apps.
- **Lock model.** `POST /auth/lock` sets `session.locked_at`;
  `POST /auth/unlock` verifies the password under the sign-in throttle; server-
  side sign-out only from the explicit button or force sign-out. A signed staff
  token (shift-length expiry, branch audience) minted at station pick verifies
  offline on the box; the cache bundle carries refreshed staff hashes and a
  `revoked_account_ids` list every pull.
- **Keys and credentials.** Private keys live in env (`BAND_HMAC_KEY`,
  `STAFF_TOKEN_PRIVATE_KEY`, `HANDOFF_SIGNING_KEY`) with kid rotation;
  `signing_key` stores public keys only. Each box gets a per-box secret at
  registration (hash stored) and HMACs every event envelope; device credentials
  carry `kind`, `station_id`, `scopes`, `rotated_from`, and every device call is
  authorised against its station.
- **Receipt numbering.** Per-station series `{branch}{station}-{series}-{seq}`;
  the cloud issues the series high-water mark on config apply
  (`receipt_series.next_seq` per station + series + kind), the box persists the
  allocation before printing, the cloud enforces `UNIQUE(station_id, series,
  seq)` and raises a `sync_anomaly` on conflict; voided sales keep their number
  with status `voided`; refunds and credit notes use their own series;
  abbreviated tax-invoice fields (branch tax id, "ใบกำกับภาษีอย่างย่อ") are
  templated now, buyer details wait for the accountant session.
- **Money and time.** All arithmetic in satang integers from one shared engine
  (`packages/shared`): percent discounts and inclusive-VAT back-calculation
  round half-up to the satang per line component, totals are sums of rounded
  components; regression fixtures capture the prototype's `lib/pricing.ts`,
  `lib/sale.ts`, `lib/tax.ts` figures. Every ledger row stores `business_date`
  computed from `branch.business_day_start` (default 05:00 Asia/Bangkok) plus
  `occurred_at`, `received_at` and `clock_trust`; when `clock_trust=low` the
  cloud recomputes the business date from `received_at`, keeps the original
  and records a `sync_anomaly`; rollups never redo timezone logic.
- **Analytics rows.** `sale_line` carries revenue category and sub-category,
  kid/adult counts, stay duration, customer tier and business date from the
  first sale. `analytics.daily_summary` is unique on `(branch, business_date,
  source)` with `formula_version` and a marketing-channel breakdown;
  `branch_source_switch` records the per-branch date; legacy days are frozen; a
  `dirty_date` queue re-rolls days touched by late syncs; the jobs process is
  the only writer; `GET /analytics/summary?branches=a,b&from&to&group=day|total`
  merges on the server and is the contract Radar will use.
- **Observability.** One package `@oto/telemetry`: pino logger with base
  bindings, ISO time, redact paths (cookie, authorization, password, token,
  code, phone, email, name, nickname, allergies, medicalNotes, dateOfBirth,
  body, query), a pg-error scrubber (drop `detail`, `hint`, `parameters`;
  keep `code`, `constraint`), AsyncLocalStorage context, `scrubUrl`,
  `errorFingerprint`, `ops.run`, `defineJob`, and `register.ts` that starts the
  OpenTelemetry NodeSDK only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set: traces
  with a PII-scrubbing span processor, the OTLP logs bridge so log lines carry
  `trace_id`/`span_id`, `ALWAYS_ON` sampling on staging and parent-based ratio
  in production with `ops_run` as the durable error record, batch processors
  flushed on SIGTERM, pg statement values never reported. One "request
  completed" line per request; `traceparent`, validated `x-request-id`, and
  `x-oto-action-id` per user action carried PWA → box → device → cloud.
  Client-side failures reach `POST /telemetry/client`. Tables `ops_run`,
  `ops_last`, `ops_expectation`, `alert`, `alert_delivery`, `box_heartbeat`
  (14-day retention), `station_event` (30-day). `audit_log` gains `occurred_at,
  origin, app, category, actor_type, auth_method, session_id, station_id,
  box_id, source_event_id, outcome`. `job:watchdog` every 60 s under an
  advisory lock; `/ready` reports db latency, pool, storage, watchdog age,
  event-loop lag and WS connections per station, and is pinged externally.
  Render's log retention is short, so `ops_run`/`audit_log` are the on-platform
  long-term record and the HyperDX target is `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL`,
  `TRACE_URL_TEMPLATE`.
- **Console v1 is its own deployable.** `apps/console` (static site, built in
  S2-03) hosts Devices, Activity, Failures, Health, Integrations and Booths
  using the prototype's admin layout extracted to `packages/admin-ui`; the
  Sprint 1 panels stay in the POS `/admin` this sprint and are linked from the
  console.
- **Test controls and demo safety.** Thresholds are environment variables
  (`BOX_OFFLINE_AFTER_S` 180, `PAIRING_CODE_TTL_S` 600, `HANDOFF_TOKEN_TTL_S`
  60, `SYNC_STALE_AFTER_S` 900). When `OPS_TEST_CONTROLS=true` the console
  offers the controls listed in each ticket. The api refuses to boot when
  `NODE_ENV=production` and any of `OPS_TEST_CONTROLS`, `SEED_PROFILE=staging`,
  `SMS_ADAPTER=console` or dev DB/MinIO defaults are set; "Reset demo data" is
  platform_admin only, typed confirmation, audited `ops.demo_reset`.
- **Non-functional targets** (dev evidence in S2-16): API p95 < 300 ms per
  route class; WS snapshot delivery p95 < 500 ms with 10 stations; sync push
  ≥ 200 events/s per batch; display QR render < 2 s; POS first load < 3 s on an
  iPad over 4G; pg pool max 10 per instance with `statement_timeout` 10 s;
  k6/autocannon run of 10 tills × 5 min and a 24 h soak on staging with the
  watchdog; a paid Render instance for the play-test to avoid cold starts.

## Tickets

Nineteen tickets (Jira issues). Where review asked for it a ticket is split into
lettered stories; each story has its own acceptance criteria, QA steps and
evidence comment. QA steps are tagged **QA (UI)** or **Dev evidence**.
Shared test controls, all behind `OPS_TEST_CONTROLS`, are listed in the story
that builds them.

### S2-01 — Platform foundation hardening and first Render deploy

Feature area: Platform foundation

Rules: R-08, R-11, R-18 (lock never ends the session), R-41; conflict C14.

Description. Everything in Sprint 2 sits on the Sprint 1 write path, which
today has no database transactions, business logic in route handlers, and the
confirmed defects listed in Readiness: the role-assignment privilege hole
(`apps/api/src/routes/accounts.ts` lines 98-108, 149-181, 214-281), no
transactions, the inactivity timer deleting the server session
(`apps/pos/src/auth/OperatorContext.tsx` lines 82-89, 132-146), phone numbers
in request and SMS logs (`app.ts` line 74, `routes/members.ts` lines 96-105,
`services/sms.ts` lines 27, 48, 51), an idempotency middleware that can run a
handler twice, and a rate limiter that cannot see client IPs behind a proxy.
Split into three stories so the security fixes are verifiable from the UI, the
schema move ships with developer evidence, and the Render deploy — which needs
the owner's Render account — can close on its own.

#### S2-01a — Security and lock-model fixes

Includes:
- Role-assignment fix: target account loaded and required to be in the
  caller's operator; dominance (caller holds every permission the role grants
  at a covering scope); scope ownership validated; platform-wide scope only
  from a platform-wide caller; same checks on account PATCH, temp-password,
  DELETE role-assignment, GET permissions; error codes `ROLE_NOT_DOMINATED`,
  `SCOPE_NOT_OWNED`, `ACCOUNT_NOT_FOUND` (404 for other operators).
- Force sign-out: `POST /accounts/:id/sessions/revoke` with audit
  `session.force_sign_out`; "Sign out everywhere" button on the Login Users
  panel; session list per account on the same panel.
- Lock model: `session.class`, `locked_at`, `revoked_at`; `POST /auth/lock`
  and `POST /auth/unlock` (unlock under the sign-in throttle, per session and
  per account); POS inactivity lock calls lock; Sign out is the only user
  sign-out; timing constants moved out of `mockApi.ts`.
- Public-deploy security: `TRUST_PROXY` from env, client IP from the first
  untrusted hop; `@fastify/rate-limit` on a Postgres store for
  `/auth/setup/start`, `/auth/password-reset/request`, code verification and
  `/public/*`; per-phone/per-account limits primary, per-IP secondary with a
  generous bucket; setup/reset codes invalidated after 5 wrong attempts;
  sign-in throttle in Postgres; origin check on state-changing requests;
  `findAccountByPhone` and `/public/member-tier` scoped by operator;
  `mustChangePassword` enforced on requireAuth-only routes; `x-request-id`
  validated (`^[A-Za-z0-9._-]{8,64}$`).
- PII leak fixes: Fastify default request logging off (one scrubbed completion
  line until S2-03), query strings never logged, scrubbed URL to the error
  reporter, SMS adapter logs a phone hash only, pg-error scrubber in the error
  handler (drop `detail`/`hint`/`parameters`, keep `code`/`constraint`), raw
  unique violations mapped to 409 without the value.

Excludes: transactions and schema move (S2-01b); deploy (S2-01c); telemetry
package (S2-03); offline unlock on a box (S2-06).

Acceptance criteria:
- [ ] A branch_manager granting `platform_admin` at operator scope gets 403
      `ROLE_NOT_DOMINATED`; a temp password for the operator_admin from a
      branch_manager gets 403; an account in another operator gets 404; each
      denial shows in the Login Users panel's "Recent denials" list (and
      Activity once S2-03 lands).
- [ ] "Sign out everywhere" on an account ends its sessions; that user's POS
      returns to the lock screen requiring a fresh sign-in; the row is audited
      `session.force_sign_out`.
- [ ] Locking the POS keeps the session (unlock works with the password);
      a locked session cannot call a business route (423 `SESSION_LOCKED`);
      five wrong unlock passwords trigger the same cooldown as sign-in; Sign
      out deletes the session and the old cookie is rejected.
- [ ] Ten rapid password-reset requests for one phone get 429 after the
      configured limit; a sixth wrong setup code invalidates the code; with
      `TRUST_PROXY` off a forged `X-Forwarded-For` does not change the bucket
      (test); the throttle state is in Postgres and survives a Render
      "Restart" of the api service (cooldown still active after restart).
- [ ] A member lookup by phone leaves no phone in stdout; a duplicate-phone
      member creation returns 409 `MEMBER_PHONE_EXISTS` and the log line
      carries the constraint name, not the phone (redaction test fixtures for
      a pg unique violation).

QA / demo steps:
1. QA (UI): As a branch manager in the POS admin, try to assign
   platform_admin to a reception account and to issue a temp password for the
   operator admin; screenshot both refusals and the "Recent denials" list.
2. QA (UI): As platform admin press "Sign out everywhere" on the reception
   account; screenshot the reception POS returning to the lock screen.
3. QA (UI): On the POS wait for the inactivity lock; unlock with a wrong
   password five times; screenshot the cooldown; unlock correctly; Sign out
   and show a fresh sign-in is required.
4. QA (UI): Request a password reset ten times for one phone from the lock
   screen; screenshot the "too many requests" message.
5. Dev evidence: test output for the dominance, forged-XFF, throttle-restart
   and pg-error redaction tests.

Depends on: none. Size: M.

#### S2-01b — Transactions, schema move and idempotency

Includes:
- Migration 0003 as in Design decisions; generated SQL inspected for SET
  SCHEMA only; `pgboss` managed schema documented and excluded from the
  filter; expand/contract policy written into CONTRIBUTING.md from 0004.
- `withTx(db, ctx, opName, fn)` with the success-inside / failure-after-
  rollback audit rule; services for accounts, operators, branches, members,
  children, visits, catalog, bookings; `requirePermission` as a route option
  checked by a preHandler; route-enumeration test.
- Idempotency: atomic key claim, in-flight 409 with `Retry-After` and POS
  polling of the same key, response stored inside the business transaction,
  5xx never stored, expired-key purge, principal account|device; client-
  generated UUIDv7 ids on every creating POST — an existing id returns the
  existing row with 200 and `x-oto-replay: true`.
- Permission vocabulary extended (`pos:sale:*`, `pos:payment:*`,
  `pos:refund:*`, `pos:voucher:redeem`, `pos:print:*`, `pos:cash:*`,
  `pos:checkin:*`, `pos:wallet:*`, `pos:stock:*`, `pos:member:tier_downgrade`,
  `admin:station:*`, `admin:box:*`, `admin:device:*`, `admin:booth:*`,
  `admin:health:read`, `admin:ops:manage`, `admin:audit:read_sensitive`,
  `analytics:read`, `app:{pos,console,oto_app,radar,booth}:access`); seed
  becomes a re-runnable `platform:sync` step.
- `pg.Pool` max 10, `statement_timeout` 10 s, idle/connection timeouts,
  `application_name`; process hooks (unhandledRejection, uncaughtException,
  SIGTERM drain, `PORT` fallback); `NODE_ENV`/`LOG_LEVEL`/`TEST_DATABASE_URL`
  documented; production refuses dev defaults for `DATABASE_URL` and MinIO.
- `SPRINT_2_PROGRESS.md` created per CLAUDE.md §9 with the recorded
  deviations; `ARCHITECTURE.md` updated (schema map and placement, withTx, id
  and idempotency rule, dominance rule, lock model, expand/contract policy).

Excludes: new feature tables beyond the renames; deploy (S2-01c).

Acceptance criteria (dev evidence unless stated):
- [ ] From an empty database `pnpm db:migrate` runs 0000-0003 cleanly twice;
      `\dn` shows the seven schemas plus `pgboss`; `\dt public.*` lists no
      application tables; all 63 existing API tests plus the new ones pass.
- [ ] A forced failure after the audit insert (test hook) leaves neither the
      row nor the audit entry for `POST /accounts`, `POST /visits` and
      `POST /public/bookings`; a denied request still leaves its denial audit
      row.
- [ ] The route-enumeration test passes and fails when a test route is
      registered without a permission.
- [ ] Two parallel identical `POST /members` with one key produce one row and
      identical bodies (concurrency test); a different body with the same key
      returns 409; a 500 replied to a keyed request is not replayed; a retry
      with the key omitted but the same client id returns 200 with
      `x-oto-replay: true`.
- [ ] QA (UI): `GET /me/permissions` for the seeded admin, viewed on the
      Login Users panel's permissions tab, lists the new permission strings.

QA / demo steps:
1. Dev evidence: migration log from the twice-run, `\dn`, and the test output
   for the tx-rollback, route-enumeration and idempotency concurrency tests
   (one attachment).
2. QA (UI): Open the platform admin's permissions tab in the POS admin and
   screenshot the Sprint 2 permission strings.

Depends on: S2-01a. Size: M.

#### S2-01c — Render deploy of API + POS

Includes:
- `render.yaml`: one api web service (`PROCESS_ROLES=api,edge,jobs`,
  `numInstances: 1`, health check on `/ready`, `TRUST_PROXY=1`), POS static
  site with rewrite `/api/* → api`, managed Postgres Singapore with
  point-in-time recovery on, a commented-out worker service as the future
  target; env variable names only; CI-gated deploy running migrations
  (including the pg-boss step) + `platform:sync`.
- Staging profile: `SEED_PROFILE=staging`, `SMS_ADAPTER=console`,
  `ALERT_CHANNELS=console`, `OPS_TEST_CONTROLS=true`; boot-refusal test for
  the production guard; "Reset demo data" action (platform_admin, typed
  confirmation, audit `ops.demo_reset`, wipes facts, keeps accounts and
  catalogue).
- Transport decision recorded in ARCHITECTURE.md (same-origin `/api` rewrite;
  alternative `SameSite=None` + allow-list documented as rejected); the
  Playwright smoke runs against the two Render origins, not the dev proxy.
- Deviations recorded in `SPRINT_2_PROGRESS.md`: edge + jobs inside api, Pi
  image deferred.

Excludes: launcher, console and shells (S2-02/S2-03); real domain.

Acceptance criteria:
- [ ] QA (UI): The POS on the Render URL signs in against the Render API and
      completes the Sprint 1 membership check for `+66811111111`.
- [ ] QA (UI): "Reset demo data" as platform admin asks for typed
      confirmation, then members created during the session are gone and the
      seeded ones remain; reception does not see the action.
- [ ] Dev evidence: `render.yaml` shows PITR, `numInstances: 1`, the staging
      variables and the commented worker; the boot-refusal test passes; the
      Playwright smoke passes against the two Render origins in CI.

QA / demo steps:
1. QA (UI): Open the Render POS URL, sign in, look up `+66811111111`;
   screenshot the member with two children.
2. QA (UI): Run "Reset demo data"; screenshot the confirmation and the result.
3. Dev evidence: CI run link for the deploy and the two-origin smoke.

Depends on: S2-01b; owner-blockable (Render account). Size: S.

### S2-02 — Suite launcher: OTO-styled landing page, centralised sign-in with signed hand-off, app tiles with "coming soon" shells

Feature area: Launcher and sign-on

Rules: R-14 (station pick follows sign-in, built in S2-04); conflict C1 (face-scan placeholder removed).

Description. The owner's first screen is a launcher where the user picks POS,
OTO App, Radar, the admin dashboard, the Lucky Wheel or the Inbox
(OWNER_DIRECTION "The suite" and 2026-09-20 "Launcher"; PLATFORM_PLAN §1 and
§4). It is a designed, OTO-Park-themed landing page — the brand's front door —
not a list of links: tiles carry an icon, a one-line purpose, the app's state
(open / coming soon / no access) and, for admins, the open-alert badge. It is
also where the central login is tested. The production design is one platform
session shared by every app. A parent-domain cookie is impossible on
`*.onrender.com` (DEPLOYMENT_TOPOLOGY item 4) and would not cover the booking
site's separate domain anyway, so the launcher issues a short-lived signed
hand-off token to each app origin and each app exchanges it for its own
httpOnly cookie bound to the same session row. This is the permanent
mechanism; a parent-domain cookie can shortcut it later. The console shell is
built with its pages in S2-03; this ticket links to it.

Includes:
- `apps/launcher` (static site with the `/api` rewrite): landing page in
  the OTO Park design language (colours, type and logo from the prototype's
  design tokens and assets; responsive from phone to iPad landscape), sign-in
  in the POS lock-screen style (phone + password, setup and reset flows
  reused), tiles for POS, OTO App, Radar, Lucky Wheel, Console and Inbox
  filtered by `app:<name>:access` and showing each app's state, open-alert
  badge for admins (from S2-03 once it lands), an account page listing the
  session's app cookies with "sign out everywhere".
- API: `POST /auth/handoff` (JWS signed with `HANDOFF_SIGNING_KEY`, kid, 60 s
  TTL, jti), token carried in the URL fragment `#handoff=…`;
  `POST /auth/handoff/exchange` consumes it atomically (`UPDATE … WHERE jti=$1
  AND consumed_at IS NULL RETURNING`), checks audience against the request
  `Origin`, sets the app cookie against the same session; revoke-all
  invalidates every app cookie; audit `auth.handoff_issue`,
  `auth.handoff_exchange`, `auth.handoff_rejected` with reason
  (`replayed|expired|audience|origin|revoked`).
- POS: `AuthGate` accepts the hand-off; the lock screen serves lock/unlock and
  a direct sign-in fallback; "Back to launcher" link; the "Scan my face"
  button is removed (PROJECT_CONTEXT §13 bans biometrics; recorded under "UI
  additions/removals" in `SPRINT_2_PROGRESS.md`).
- "Coming soon" shells for Radar and the Inbox (same design language; name,
  purpose, signed-in user, planned milestone, link to the legacy URL from env
  where one exists); the OTO App tile points at the lifted app's origin as
  soon as S2-17a lands (before CP1) and at a shell until then.
- Demo-only "Lucky Wheel (virtual booth)" tile visible to admins.
- `render.yaml` entries for the launcher and the shells (each with the
  `/api` rewrite); `TZ=UTC`, `COOKIE_SECURE=true`.

Excludes: parent-domain cookie and real domain; the OTO App, Radar and Inbox
lifts themselves (S2-17, S2-18, S2-19); station pick after sign-in (S2-04);
console shell and pages (S2-03); moving the Sprint 1 admin panels out of the
POS (Sprint 3).

Acceptance criteria:
- [ ] The launcher URL unauthenticated shows sign-in; after sign-in reception
      sees the POS tile only, platform admin sees all tiles plus the virtual
      booth tile.
- [ ] Clicking POS opens the POS origin signed in with no second prompt; the
      launcher's account page lists one session with two app cookies
      (launcher, POS).
- [ ] The hand-off token never appears in the query string or the Referer
      (test); a token replayed after use, after `HANDOFF_TOKEN_TTL_S`, or
      against a different origin is rejected and the reason is visible on the
      account page's "recent rejections" list (and in Activity after S2-03).
- [ ] Sign out on the launcher revokes the session; the POS returns to its
      lock screen requiring a fresh sign-in on its next request.
- [ ] The landing page renders the OTO brand (logo, colours, type) at phone
      and iPad widths without horizontal scroll; every tile shows its state;
      Radar and Inbox tiles open their "coming soon" shells; the wheel tile is
      hidden for non-admins; the POS lock screen shows no face-scan button.

QA / demo steps:
1. QA (UI): Open the Render launcher URL; sign in as reception
   (`+66900000002`); screenshot the tiles.
2. QA (UI): Click POS; screenshot the POS home with no second sign-in; open
   the launcher account page and screenshot the session with two app cookies.
3. QA (UI): Press "Expire hand-off now" on the account page (test control),
   then open the POS tile again; screenshot the rejection notice and the
   recent-rejections entry.
4. QA (UI): Sign in as platform admin (`+66900000001`); screenshot all tiles
   at desktop and phone width; open the Radar and Inbox shells.
5. QA (UI): Sign out on the launcher; reload the POS tab; screenshot the lock
   screen requiring a fresh sign-in (not just unlock).

Depends on: S2-01c. Size: M.

### S2-03 — Observability and Console v1: telemetry package, request and operation logging, ops_run failure record, audit extensions, health endpoints, job runner and watchdog, Activity / Failures / Health / Integrations pages

Feature area: Observability

Rules: R-08 (audit is the control), R-16 (health indicators), R-94 (child data staff-only, masked).

Description. The owner requires every API call and service function logged
for deep debugging, silent failures detectable, health visible on an admin
page now, and pluggability into HyperDX or any OpenTelemetry tool later
without rework. This ticket builds the observability design and Console v1 —
the "fifth app" — as its own static site, using the prototype's admin layout
(`apps/pos/src/components/admin/AdminLayout.tsx`, `adminSections.tsx`)
extracted to `packages/admin-ui`. HyperDX becomes four environment variables.

Includes:
- `packages/telemetry` as in Design decisions; redaction unit test with a Thai
  local phone, an E.164 phone, a child fixture, a pg unique-violation error
  and a simulated terminal response; ESLint rule forbidding
  phone/email/name/allergies keys in log object literals.
- `apps/api/src/plugins/telemetry.ts`: one "request completed" line per
  request (route pattern, path without query, status, duration, bindings,
  `idempotent_replay`, warn for 4xx with `error_code`, error for 5xx, `slow`
  above `SLOW_REQUEST_MS`); `traceparent`, `x-request-id`, `x-oto-action-id`
  propagation; 5xx and uncaught errors to `ops_run` kind `http`/`process`.
- `POST /telemetry/client` (rate-limited, scrubbed, batched) for POS/display/
  booth uncaught errors, failed requests, WS lifecycle and service-worker
  update failures → `ops_run kind=client`.
- OTel: traces + OTLP logs bridge (`trace_id`/`span_id` on every log line),
  `ALWAYS_ON` on staging, ratio in production, flush on SIGTERM,
  `enhancedDatabaseReporting` off.
- Tables `ops_run`, `ops_last`, `ops_expectation`, `alert`, `alert_delivery`,
  `box_heartbeat` (edge); `audit_log` classification columns, BRIN on
  `created_at`, keyset pagination, hard cap `limit ≤ 200`; new actions
  `auth.sign_in_failed`, `auth.locked_out`, `auth.permission_denied`,
  `session.lock`, `session.unlock`, `session.force_sign_out`, `audit.export`,
  `audit.read_sensitive`; null operator on `auth.sign_out` fixed; child health
  text masked at write (hash + flag), the rest at read.
- Job runner (pg-boss, `PROCESS_ROLES=jobs`) with `defineJob` seeding
  `ops_expectation`; `job:watchdog` every 60 s under an advisory lock;
  `job:housekeeping.retention` hourly; alert dedupe, auto-resolve, 5-minute
  flap suppression; channel adapters console, email and a generic HTTPS
  webhook (`ALERT_WEBHOOK_URL`, e.g. Slack/Discord/LINE Notify) with delivery
  failures in `ops_run`.
- `/health`; `/ready` with db latency, pool, storage, watchdog age,
  event-loop lag, otel flag, WS connections per station; Render health check
  plus a GitHub Actions cron pinging `/ready` every 5 min and opening an
  `ready.degraded` alert; admin routes for health, failures, ops-runs (retry),
  alerts (ack).
- `GET /audit` extended (keyset, filters action/category/app/outcome/origin/
  stationId/boxId/requestId, masking unless `admin:audit:read_sensitive`,
  unmasked reads audited, CSV export audited).
- `apps/console` + `packages/admin-ui`: nav group "Operations" (Devices in
  S2-04, Booths in S2-07b); pages Activity (presets Admin log / Staff log /
  Sign-in log, actor, action, entity, outcome, request-id search, drawer with
  masked diff, related rows and a "Raw record" tab showing the masked JSON of
  the entity), Failures (grouped by name + fingerprint, tabs API errors / Jobs /
  Quarantine / Client, retry, acknowledge), Health (service tiles, jobs, open
  alerts; box and booth sections filled by S2-04/S2-07a), Integrations (env
  presence flags — never values — for the 2C2P gateway (`PGW_*`), its
  maintenance keys, SMS, MinIO,
  OTel, Sentry, alert channels, HyperDX; webhook endpoints with last delivery
  from `ops_run`; "variables to provision" list generated from `env.ts`);
  links to the POS `/admin` panels; gate by `app:console:access`.
- Test controls: "Run watchdog now", `job:demo.fail`, "Send test alert" on
  Health; `render.yaml` entry for the console with the `/api` rewrite.
- Sentry SDK behind the reporter seam when `SENTRY_DSN` is set; env names
  documented; ARCHITECTURE.md observability section, log-retention statement
  and a "find everything about request X" runbook.

Excludes: box heartbeat ingestion, box drawer, collect-logs (S2-04/S2-05);
booth alerts and per-booth reporting (S2-07a/S2-15b); buying HyperDX; audit
partitioning.

Acceptance criteria:
- [ ] A member lookup produces exactly one request-completed line with route
      `/members/lookup`, `account_id`, `branch_id`, `trace_id` and no phone;
      the redaction test passes with the five fixtures; the ESLint rule fails
      a deliberate `log.info({phone})` (dev evidence).
- [ ] A wrong-password sign-in shows on Activity > Sign-in log as
      `auth.sign_in_failed` with no phone in the row or drawer; a 403 on a
      mutating route shows as `auth.permission_denied`.
- [ ] `job:demo.fail` run three times appears within 60 s on Failures grouped
      by fingerprint with count and last error; an `ops.failing` alert opens
      on Health and is delivered to the console and webhook channels;
      acknowledging records `acknowledged_by`.
- [ ] Stopping the watchdog (test control) makes `/ready` report
      `checks.jobs.watchdog_age_s` above threshold, Health shows the job stale
      and the external pinger opens `ready.degraded` within 10 minutes.
- [ ] Activity filters by the three presets, actor and request id; the drawer
      masks phone/allergy fields for an admin without
      `admin:audit:read_sensitive`, shows them for one with it, and the
      unmasked view creates an `audit.read_sensitive` row; the Raw record tab
      shows the masked entity JSON.
- [ ] A thrown error in the POS reaches Failures > Client with the action id
      and station (when set).
- [ ] Integrations shows every provider as configured/missing from env
      presence, never a value, and the variables-to-provision list.
- [ ] Dev evidence: the OTel test boots the SDK against an in-process
      collector and asserts one request span with `http.route` and no query
      string, and one log record carrying the span's `trace_id`; a named
      test asserts every mutating Sprint 1 route records an audit row with
      `category`, `app`, `outcome`, `session_id`; QA spot-checks
      `member.update`, `role_assignment.create`, `ticket_package.update` on
      Activity.

QA / demo steps:
1. QA (UI): Do a member lookup and a wrong-password sign-in on Render; open
   Activity > Sign-in log; screenshot the `auth.sign_in_failed` row and drawer.
2. QA (UI): Press `job:demo.fail` three times on Health; screenshot the
   Failures grouping and the open alert; acknowledge it; show the webhook
   delivery row.
3. QA (UI): Open Health; screenshot the service tiles (db latency, pool,
   storage, watchdog age); press "Stop watchdog"; screenshot the stale job.
4. QA (UI): Paste a request id from the POS "About" panel into the Activity
   search; screenshot the related rows; open `member.update` as a reception-
   level admin (masked) and as platform admin (unmasked) with the Raw record
   tab; screenshot the `audit.read_sensitive` row.
5. QA (UI): Open Integrations; screenshot the presence flags and the
   variables-to-provision list.
6. Dev evidence: redaction, ESLint, OTel span/log and audit-coverage test
   output.

Depends on: S2-01c, S2-02. Size: L.

### S2-04 — Stations, boxes and devices: Console Devices area, box registration and heartbeat, cloud virtual box, station pick after sign-in, station setup wizard

Feature area: Stations and devices

Rules: R-12, R-13, R-14, R-15, R-16, R-17, R-118; conflicts C15, C20.

Description. The owner's station model: an admin creates a station, assigns
the box, assigns the devices; staff sign in, pick the station and work
(PROJECT_CONTEXT §4-5). Today the prototype's `StationSetup` wizard
(`apps/pos/src/pages/StationSetup.tsx`, `station/StationContext.tsx`) is open
to everyone, mints a random client-side `stationId` and offers mock devices
from `catalogStore.seedDevices`; `session.station_id` is never set. This
ticket builds the cloud side of the fleet and the "virtual box" so everything
pairs on Render without hardware. Runtime behaviour is S2-05/S2-06.

Includes:
- Tables — `core`: `box` (operator, branch, slot/hostname, role
  counter|gate|booth|kiosk|standby|virtual, secret hash, claim code hash,
  `agent_version`, `current_epoch`, status, `last_heartbeat_at`, `last_status`),
  `station` reshape (operator, box, code prefix, kind incl. booth,
  capabilities, `config_version`, payment routing, offline wallet cap,
  `archived_at`), `device` (kind, transport, address, model, serial/TID/MID,
  reachability, paper), `station_device`, `device_credential` (kind
  display|kiosk|booth|box, station, scopes, `rotated_from`, paired_by/at,
  `revoked_at`, `last_seen_at`), `signing_key` (public keys only); `edge`:
  `box_command`, `box_heartbeat`; `branch.opening_hours` (jsonb per weekday)
  and `branch.business_day_start` (time, default 05:00).
- Box API: `POST /box/v1/register` (claim code → per-box secret, epoch 1),
  `POST /box/v1/heartbeat` every 60 s (online, `agent_version`, clock offset,
  `uptime_s`, `temp_c` (null on virtual), outbox depth, devices reachable/
  paper, leases, error fingerprints), `GET /box/v1/config` versioned per
  station with `min_supported_agent_version`, `POST /box/v1/commands/poll` and
  result (test_print, collect_logs, restart, go_offline/go_online, reset_store
  → new epoch).
- Virtual box: `packages/box-agent` skeleton runs under `PROCESS_ROLES=edge`
  inside the api service, registers as role `virtual` for HKT Central, state
  in the `edge` schema; simulated devices declared by env; a second virtual
  box can be added from the console.
- Console > Devices: boxes list (status, version, uptime, heartbeat age,
  actions test print / restart / collect logs / go offline), stations CRUD,
  devices per box, pairing codes for displays/booths/kiosks with revoke,
  config version shown; a "Box log" drawer per box (last 500 lines, filter by
  action id) — the surface later QA steps use to see routed results;
  simulator control panel placeholder per box.
- POS Branches panel gains opening hours and business-day start editors;
  seed sets HKT Central 10:00-21:00 daily; when opening hours are null the
  offline-during-opening-hours rule does not fire and Health shows "opening
  hours not set" on the branch tile.
- Wizard kept in the prototype's 9-step design: admins only; new "choose the
  box" step; devices offered are those the box reported; scanner step offers
  camera / paired scanner / scanner on the box; test print routed cloud → box.
- Staff flow: after sign-in the POS shows the branch's station list (stored on
  the device in localStorage — the one documented browser-storage exception);
  "Set up station" in the header switches; `session.station_id` set on pick
  and stamped into audit rows and logs.
- Health box section: per box online/offline, version, uptime, heartbeat age,
  outbox depth, devices with printer/paper indicators, 24 h heartbeat drawer,
  command history; watchdog rules: heartbeat silence > `BOX_OFFLINE_AFTER_S`
  during opening hours, clock offset > 60 s, paper out, printer unreachable,
  agent below min supported version; `box.online`/`box.offline` transition
  alerts; test controls "Stop heartbeats" and "Advance box clock".
- Seed: one virtual box, stations "Reception Till 1" (till) and "Booth 1"
  (booth), simulated devices assigned.

Excludes: session document, cache bundles, outbox sync, simulator behaviour
(S2-05/S2-06); the display's pairing flow and pairing-code acceptance (S2-08);
test-print rendering acceptance (S2-06); booth runtime (S2-07a); Pi image.

Acceptance criteria:
- [ ] From a clean seed, Health shows the virtual box online with a heartbeat
      younger than 90 s, its version, uptime and simulated devices; "Stop
      heartbeats" plus "Run watchdog now" shows it offline and opens a
      `box.offline` alert; resuming resolves it with a `box.online` alert.
- [ ] An admin creates a station on the virtual box, assigns a simulated
      receipt printer and terminal; `config_version` increments and the box
      applies the bundle on its next poll (`box.config.applied` in Activity
      and in the Box log drawer).
- [ ] Reception signing in sees the station list, picks "Reception Till 1",
      the header shows the station and `GET /me` (About panel) shows
      `stationId`; the choice survives a reload; a non-admin cannot open the
      wizard (403 `PERMISSION_DENIED` and hidden entry).
- [ ] Test print from the console creates a `box_command`; the virtual box
      runs it; the result appears in command history and `ops_run`.
- [ ] Editing HKT Central's opening hours saves and is audited; clearing them
      shows the "opening hours not set" tile note.
- [ ] A Render "Manual deploy" of the api does not change the box id or lose
      its last status (same box id and heartbeat history on Health after the
      deploy); all station/box/device mutations are audited with category
      `admin`.

QA / demo steps:
1. QA (UI): Open Console > Devices on Render; screenshot the virtual box
   online with devices; press "Stop heartbeats" then "Run watchdog now";
   screenshot the offline alert; resume; screenshot the `box.online` alert.
2. QA (UI): Create station "Reception Till 2", assign devices, set routing
   card → terminal sim, QR → 2C2P sim; screenshot the station, its config
   version, the Activity rows and the Box log line `box.config.applied`.
3. QA (UI): Sign in as reception on the POS; screenshot the station picker;
   pick, reload and show it persisted; open the wizard URL as reception and
   screenshot the denial.
4. QA (UI): Run Test print; screenshot the command history entry.
5. QA (UI): Edit opening hours on the Branches panel; screenshot; trigger a
   Manual deploy on Render, then screenshot Health showing the same box id.

Depends on: S2-02, S2-03. Size: L.

### S2-05 — Box agent sync core: station session document with lease fencing, cache bundles, durable outbox and sync ledger with epochs and dedupe, offline toggle

Feature area: Box agent and edge sync

Rules: R-11, R-46, R-54, R-55; conflict C20.

Description. The box is the system of action: it owns the station's current
sale, serves it to the till and the display, caches catalogue/members/staff,
queues every fact and syncs it to the cloud (PROJECT_CONTEXT §4, §8;
PLATFORM_PLAN §6-7). This ticket delivers the runtime core inside the virtual
box. The Sprint 1 member and visit creation are rewritten as box-originated
facts so the ledger is proven with Sprint 1 cargo before the first sale. The
offline toggle is the demo instrument for every "works with no internet" claim
and is enforced as in the offline rule.

Includes:
- Station session document (stage, cart, member, totals, payment state,
  prompts, language, `schema_version`), sequence-stamped, full snapshots over
  `/ws/station/:id`; reconnect rehydrates; till lease (15 s heartbeat, 60 s
  TTL) in the `Store`, expired lease claimable, live lease takeover by a
  manager with `station.takeover` audit; intents carry lease id and last-seen
  sequence → `409 STALE`; read-only observers; `packages/shared` types.
- Cache bundles (`GET /box/v1/config`, `/box/v1/cache` scopes: catalogue +
  prices, members + children, staff hashes + `revoked_account_ids`, staff-
  token deny-list, today's bookings, valid bands, station config, receipt
  series high-water marks), versioned with `schema_version`, applied whole or
  not at all; the cloud refuses a bundle above the agent's supported version
  with an alert; `Store` interface with the Postgres `edge` implementation
  and SQLite for the Pi; migrate-on-read for document, bundle and outbox.
- Outbox: `sync_event` ledger (event_id, box_id, journal_epoch, box_seq, type,
  occurred_at, received_at, clock_trust, actor, action_id, payload,
  payload_hash, sig = HMAC with the per-box secret), bounded batches (200
  events / 1 MB), backoff with jitter, resumable cursor;
  `POST /box/v1/sync/push` verifies the signature, applies each event under a
  SAVEPOINT, returns per-event results and the new cursor; unique
  `(box_id, journal_epoch, box_seq)`; duplicate (same id, same hash) dropped,
  conflict (same id, different hash) and poison events to `sync_quarantine`
  with `sync_anomaly` + alert; an epoch older than `box.current_epoch`
  rejected with alert `sync.epoch_regressed`; low `clock_trust` recomputes
  `business_date` from `received_at` with a `sync_anomaly`; one `ops_run` per
  batch with counts; `sync_change` feed + `/box/v1/sync/pull`.
- Offline toggle (console button and box command) persisted in the `edge`
  schema across restarts; cuts the box's cloud client and returns 503 from
  cloud routes for that station credential in test mode; offline banner on the
  till; clock-skew injection; test controls "Replay last batch", "Inject
  poison event", "Reset store (new epoch)".
- Sprint 1 member and visit creation as box-originated facts; same-phone-at-
  two-boxes merge at sync with a `sync_anomaly` referencing both event ids.
- Correlation: `x-oto-action-id` minted per user action, carried PWA → box →
  cloud; the box logs with the `@oto/telemetry` logger into the Box log
  drawer; `station_event` rows for intents and snapshots (30-day retention).
- Heartbeat enriched with outbox depth, oldest unacked age, error
  fingerprints, lease holders; watchdog rules "online but oldest unacked >
  `SYNC_STALE_AFTER_S`" and "quarantine non-empty"; Failures > Quarantine tab
  with replay and discard; `/ready` reports WS connections per station.
- Seed: second virtual box "Virtual box 2" with station "Counter 2" (till,
  F&B capability) for two-box scenarios.

Excludes: print pipeline, scanning, staff token, PWA, device simulators
(S2-06); display UI (S2-08); business flows beyond identify/member (S2-09
onwards); Pi image, LAN discovery.

Acceptance criteria:
- [ ] Two browser tabs on one station receive the same snapshot and sequence
      number after a change; a second till on a live lease is refused until a
      manager approves (`station.takeover` audited); closing the first tab
      lets the second claim the station within 60 s without a manager; a
      displaced till's next intent shows "session moved to another till" and
      rehydrates.
- [ ] With the virtual box offline, a member is created from the till (cached
      lookup says unknown), the event sits in the outbox with a sequence; on
      reconnect it syncs and the cloud member exists once; "Replay last batch"
      shows `applied=0 duplicates=N` on the `sync:push` `ops_run` and one
      member row (Raw record).
- [ ] The same phone created on Reception Till 1 and Counter 2 while both
      boxes are offline merges at sync with one member and a `sync_anomaly`
      referencing both events on Failures.
- [ ] "Inject poison event" lands in Quarantine, opens an alert, and can be
      replayed or discarded; dev evidence: a batch with event 3 of 5 poison
      applies 1, 2, 4, 5 exactly once and advances the cursor.
- [ ] "Reset store" on the virtual box issues epoch N+1; a replayed batch from
      epoch N is rejected with `sync.epoch_regressed` on Failures and no row
      is dropped silently (dev evidence: test on same-id-different-hash →
      quarantine).
- [ ] A Render "Restart" of the api while the box is offline with three
      queued events keeps the offline state, the session document and the
      outbox depth 3 on Health; they sync after the toggle is turned online.
- [ ] Every sync batch and box log line carries the action id; one action id
      links the till line, the Box log drawer and the cloud audit row
      (`source_event_id`); dev evidence: schema_version replay test from the
      previous tag's fixtures passes.

QA / demo steps:
1. QA (UI): Open the till in two tabs on one station; change the language
   from one; screenshot both showing the same sequence number; close the
   first tab and show the second claiming the station.
2. QA (UI): Toggle Virtual box 1 offline in Console > Devices; create a
   member; screenshot the offline banner and the outbox depth on Health;
   toggle online; screenshot the synced member and the `sync:push` `ops_run`;
   press "Replay last batch"; screenshot `applied=0 duplicates=N`.
3. QA (UI): With both boxes offline, create the same phone on Reception Till 1
   and Counter 2; reconnect; screenshot the merged member and the anomaly.
4. QA (UI): Press "Inject poison event"; screenshot Quarantine, replay it,
   and the resolved alert; press "Reset store" and screenshot the epoch on the
   box tile.
5. QA (UI): Toggle offline, create three members, press Render "Restart";
   screenshot the outbox depth 3 still on Health; toggle online.
6. Dev evidence: poison-in-batch, epoch and schema_version test output.

Depends on: S2-04. Size: L.

### S2-06 — Box edge essentials: print pipeline and printer simulator with templates, scanning service and scanner simulator, signed staff token with offline unlock, PWA shell, simulator control panel

Feature area: Box agent and device simulators

Rules: R-15, R-16, R-17, R-18, R-49, R-51; devices per `docs/architecture/DEVICE_INVENTORY.md` §2, §4 (D1, D2, D4, D6) and §9.

Description. Everything the till and the booth need from the box beyond the
session document. The prototype routes print jobs by station capability with
admin-editable templates (`lib/printRouting.tsx`, `types.ts PrintTemplate`,
`catalogStore.seedPrintTemplates`) but every job ends in a toast; the brief
wants one print pipeline on the box rendering ESC/POS and TSPL with Thai,
Chinese and Cyrillic rasterised from bundled fonts (PROJECT_CONTEXT §7.3).
The park's printers are known: the Welltech G4 (Xprinter XP-C260 family) and
three Xprinter XP-80-series units speak ESC/POS over TCP 9100; the two
4B-2082A wristband printers are TSPL2-native label printers (ZPL as an
emulation switch, D1). Scanning needs one service routing any code (band,
booking QR, voucher, legacy codes, staff badge, product barcode) from three
input sources (§7.4); the Zebra DS2278 attaches to the **box** (USB HID with
a programmed Enter suffix, or USB CDC serial), never to the iPad (D2). The
inactivity lock needs an offline unlock (§5), and the PWA shell must load
with no internet.

Includes:
- `packages/print`: template → layout model → ESC/POS or TSPL bytes → adapter;
  raster text with bundled Noto fonts; unit fixtures per template (receipt,
  kitchen, bar, kids band, adult band, credit voucher, item voucher, booth
  voucher, test page); `print_job` table (station, box, device, kind, refs,
  status queued|printed|failed|skipped, error, `reprint_of`); one `ops_run` per
  failure.
- Printer adapters and simulators on the real models: an ESC/POS adapter
  parameterised per model (Welltech G4 / XP-C260 and XP-80 family: 576
  dots/line, partial cut, drawer kick `ESC p`, real-time status `DLE EOT`,
  Thai text rasterised rather than code-paged, per §9.3–9.4) and a TSPL2
  label adapter for the 4B-2082A (band media size, QR + human-readable code,
  status byte, per §9.1), each over a TCP-9100-like channel; the simulator
  parses the same bytes into a preview, reports status the way the printer
  does, injects unreachable / paper-out / cover-open faults and emits the
  drawer-kick event; printer health in the heartbeat; red indicator in the
  station header; queued jobs retry when the printer returns; jobs to an
  unassigned device skipped with "not printed" on the till; printer identity
  (model, address) comes from the S2-04 device record, seeded with the park's
  six printers and addresses.
- Print Templates admin panel wired; test print per template cloud → box →
  simulator uses the same renderer as the preview (the S2-04 test-print
  acceptance lands here).
- Scanning service + `ScanInput` abstraction on the box (USB HID keyboard
  wedge with the Enter-suffix burst rule and USB CDC serial for the DS2278,
  camera on the till/kiosk as fallback) publishing scan events on the station
  channel with source and timestamp, handlers registered by later tickets;
  scanner simulator (typed code + Scan button, HID-burst or serial mode,
  result shown in the Box log drawer); USB button = configurable key, never
  Enter; badge/PIN input.
- Signed staff token minted at station pick (shift-length expiry, branch
  audience, jti; `STAFF_TOKEN_PRIVATE_KEY` in env), verified on the box with
  the public key; deny-list from the cache bundle; offline unlock verifies the
  token under the same failure throttle; fresh offline sign-in for staff seen
  on that box in the last 30 days (flagged default); on reconnect the box
  drops cached staff not in the latest bundle.
- PWA: service worker so the shell loads with no internet, Inter inlined,
  update applied only at the lock screen with no open sale; service-worker
  failures reported to `/telemetry/client`.
- Console > Devices > Simulators: per-box control panel framework (printer
  faults, scanner input, button key, badge/PIN); every simulator call writes a
  device-level log line with the action id and aggregates into the heartbeat.

Excludes: sale-specific print jobs and reprints (S2-11); booth voucher
content (S2-07a); terminal, 2C2P and gate simulators (S2-10a, S2-12); real
printers and band-stock tests.

Acceptance criteria:
- [ ] Test print of each seeded template renders in the simulator preview;
      the fixture strings "สวัสดี OTO Park" and "Привет" render with no
      missing-glyph boxes; toggling a template field changes the next preview
      without redeploy.
- [ ] Paper-out injected on the receipt printer: the job queues, the header
      indicator turns red within 60 s, a `printer.paper_out` alert opens;
      clearing paper prints the queued job and resolves the alert; a job to a
      station with no assigned printer is skipped with a non-blocking note.
- [ ] The scanner simulator delivers a typed code to the scanning service,
      which routes it to a registered handler shown in the Box log drawer with
      the action id; the button key press is distinguished from a scanner's
      Enter.
- [ ] Locking the till while the box is offline and unlocking with the
      password succeeds via the staff token (Activity: `session.unlock`,
      `auth_method=offline_token`); a token past expiry is refused with
      "shift token expired, connect to sign in"; five wrong offline passwords
      lock out like online; the 30-day offline sign-in path works with the
      banner; an account in `revoked_account_ids` cannot unlock offline.
- [ ] With the network disabled in devtools the POS loads the lock screen
      from the service worker; a new build is not applied while a sale is
      open.
- [ ] Every simulator call appears as a device log line with the action id
      and in the next heartbeat's device aggregates.

QA / demo steps:
1. QA (UI): Edit the receipt template (hide logo, change footer) and run a
   test print; screenshot before/after previews with the Thai and Cyrillic
   lines.
2. QA (UI): Inject paper-out from the Simulators panel; run a test print;
   screenshot the red indicator, the queued job and the alert; clear;
   screenshot the printed job.
3. QA (UI): Type a code into the scanner simulator and press Scan; screenshot
   the routed result in the Box log drawer with its action id.
4. QA (UI): Toggle the box offline; lock the till; unlock with the password;
   screenshot the `session.unlock` row with `offline_token`; force-sign-out
   the account from the console, pull the cache, and show offline unlock
   refused.
5. QA (UI): Devtools > Offline, reload the POS; screenshot the lock screen
   served by the service worker.

Depends on: S2-05. Size: L.

### S2-07 — Lucky Wheel booth

Feature area: Booth game

Rules: R-17, R-118; wheel specification v2 §3–§15 via docs/features/booth.md; spin eligibility per Open decision 4.

Description. The owner's second priority. The booth is a station type whose
box role loads and caches a versioned config bundle, draws every outcome on
the box, records every spin before the wheel animates, prints a voucher with a
random 10-character booth-prefixed code, and keeps working offline
(PROJECT_CONTEXT §11; wheel spec §3-15; `docs/features/booth.md`). `apps/booth`
reuses the existing game assets (`imports/oto-wheel-fortune/.../Wheel.tsx`,
press state machine, `ResultModal`, `sound.ts`, `kiosk.css`, `#debug`
overlay). The wheel must be controlled from the admin side (OWNER_DIRECTION),
so the admin panel is the second story. Voucher codes are random and
server-validated, not signed; spin eligibility defaults to `none` with no
phone capture on the TV (PLATFORM_PLAN §14 decision 7). Booth management lives
in Console v1.

#### S2-07a — Booth game, spins, vouchers, printing, offline operation, heartbeat and alerts

Includes:
- Tables (`booth`/`promo`): `booth_config_version`, `booth_layout`,
  `booth_prize` (voucher_definition link, name TH/EN, weight, expiry days,
  daily cap, `cost_satang`, stock soft link, active),
  `booth_staff_assignment`, `spin`, `voucher_definition` (kind, value type,
  product/package link, expiry days, offline policy, single use,
  `campaign_id`, `marketing_channel_id`, `cost_satang`), `voucher` (code
  unique per operator with booth prefix, status, `print_count`),
  `voucher_print`; `credential` (account, kind password|pin|badge, argon2
  hash); seeded from a fixture config so the game is playable before the
  admin panel exists.
- `apps/booth` (static site with the `/api` rewrite for the demo): attract
  animation when idle, a "Staff: sign in to start" prompt when nobody is
  signed in, ready → spinning → result, `ResultModal` with prize TH/EN, code
  and QR on screen when the printer is down, offline dot, "Booth not set up,
  connect to internet" when never synced; staff sign-in overlay by PIN or
  badge with lockout (exponential backoff after 5 wrong, never blocking the
  game); configurable key (never Enter); `#debug` overlay with config version,
  last spin, printer state, queue depth and a "spin 200 times" distribution
  table with expected vs observed and the deviation in percentage points.
- Booth box role in the agent: fetch/cache config bundle, poll for newer
  version and apply whole (~1 minute), draw honouring weight/active/daily
  cap/stock, write spin then animate, mint voucher code (unambiguous
  alphabet), queue the voucher print (template: logo, prize TH/EN, QR of
  code, code, issue time and booth, expiry, terms), queue spin + voucher facts
  to the outbox; restart restores queued vouchers; reprint is staff-only and
  reprints the same code.
- Heartbeat with booth fields (config version, printer reachable, paper,
  vouchers pending sync, last spin, staff signed in, uptime_s, temp_c);
  alerts: offline, `box.online` on return carrying `synced_count`, printer
  fault, paper out, vouchers printing with nobody signed in, prize daily cap
  reached; Health booth section.
- Cloud sync apply for spin and voucher facts (duplicate codes rejected at
  sync and flagged); `GET /booths/:id/status`.

Excludes: admin panel, voucher-definition admin, staff PIN management
(S2-07b); POS redemption, legacy codes, booth report (S2-10b, S2-15b);
inventory-linked prizes; real hardware, fonts and licences.

Acceptance criteria:
- [ ] Opening the virtual booth URL shows the wheel from the seeded config
      and, with nobody signed in, the "Staff: sign in to start" prompt; the
      `#debug` 200-spin table shows every prize within ±5 percentage points of
      its configured weight (dev evidence: the distribution test uses the same
      assertion); a prize with daily cap 1 is never drawn twice in a day.
- [ ] Every press creates a spin row on the box before the animation and a
      voucher with a 10-character booth-prefixed code; the printer simulator
      shows the voucher with the prize in Thai and English, the QR and the
      expiry.
- [ ] Staff signs in with the demo PIN; spins carry the staff id; after
      sign-out spins are flagged unattributed and `booth.unattributed` opens
      after the first such voucher; six wrong PINs show a 30-second backoff
      and the wheel still spins.
- [ ] With the booth offline: spins, vouchers and prints continue and the TV
      shows the offline dot; on reconnect the `box.online` alert reports
      `synced_count=3` and Health shows 0 pending; replay creates no
      duplicates; a Render "Restart" while offline keeps the queued vouchers
      (pending count unchanged after restart).
- [ ] Paper-out: the result screen shows the code and QR, the print job is
      queued and logged, an alert opens; a staff reprint reprints the same
      code and never draws a new prize.

QA / demo steps:
1. QA (UI): Open the booth from the launcher's demo tile; screenshot the idle
   wheel with the sign-in prompt; sign in with the demo PIN; press the button
   key; screenshot the result modal and the voucher in the printer simulator.
2. QA (UI): Sign out; spin; screenshot the unattributed alert; enter six wrong
   PINs; screenshot the backoff while the wheel still spins.
3. QA (UI): Toggle the booth offline; spin three times; screenshot the
   offline dot and pending count; press Render "Restart"; screenshot pending
   still 3; toggle online; screenshot the `box.online` alert with
   `synced_count=3`.
4. QA (UI): Inject paper-out; spin; screenshot the on-screen code/QR fallback
   and the queued print; clear; reprint as staff and show the same code.
5. QA (UI): Open the `#debug` overlay, run 200 spins; screenshot the
   distribution table with deviations.

Depends on: S2-06. Size: L.

#### S2-07b — Booth admin control panel: prizes, layouts, publish and version pickup, voucher definitions, marketing channels, staff PIN

Includes:
- Tables (`promo`): `marketing_channel` and `campaign`, seeded with the
  channel vocabulary from the Radar intake ("Sales Booth" and the rest);
  `voucher_definition.marketing_channel_id`/`campaign_id` required on publish.
- Console > Booths: booth list with status tiles (online, last seen, config
  version, printer, paper, pending sync, staff signed in, uptime); per-booth
  settings (name, branch, layout template, allowed staff, eligibility, button
  key, active); prize editor with weight validation (weights must sum to 100,
  at least one active prize, cost per prize); layout picker with one ready
  design; wheel preview (slice colours, label auto-fit, order); Publish creates
  a config version; version history and which version each booth runs;
  publishing eligibility `band` or `phone` is refused with "not available until
  the park booth exists"; voucher definitions admin (kind, value type,
  product/package link, expiry days, offline policy, single use, campaign,
  marketing channel, cost); staff PIN/badge management on the account.
- Seed via `platform:sync`: booth "Booth 1" with the owner's launch prize list
  (23/27/17/14/14/2 + 3 % mystery box), 14-day expiry, default layout, demo
  staff PIN, campaign "Launch", channel "Sales Booth".

Excludes: everything in S2-07a; booth report (S2-15b).

Acceptance criteria:
- [ ] Changing a weight to 100 % and publishing creates version N+1; Health
      shows the booth on N+1 within 60 s and the next spin lands on that
      prize; the preview matches the published order and colours.
- [ ] Weights summing to 99 or 101, an empty active list, or a prize without
      a voucher definition are rejected before publishing with the field
      named; eligibility `band` is refused with the exact message.
- [ ] A new voucher definition requires campaign and marketing channel;
      the seeded channel list matches the Radar vocabulary (test).
- [ ] Setting a staff PIN on an account lets that staff sign in on the booth;
      removing it refuses the next sign-in after the booth's next pull.

QA / demo steps:
1. QA (UI): In Console > Booths set one prize to 100 %, publish; screenshot
   the version, the booth picking it up on Health, and the forced prize on the
   next spin; screenshot the wheel preview beside the live booth.
2. QA (UI): Set weights to 99 total, try to publish; screenshot the refusal;
   choose eligibility `band`; screenshot the refusal.
3. QA (UI): Create a voucher definition without a channel; screenshot the
   validation; complete it; screenshot the definition with cost, campaign and
   channel.
4. QA (UI): Set a PIN on the reception account; sign in on the booth; remove
   it; screenshot the refused sign-in.

Depends on: S2-07a, S2-03. Size: M.

### S2-08 — Customer display as a separate device: /display route, pairing by code, redacted station-session view, display intents, harness kept

Feature area: Customer display

Rules: R-54, R-55, R-56, R-57, R-58, R-59; conflict C20.

Description. Till and customer display are separate devices linked through
the box's station session (OWNER_DIRECTION; PLATFORM_PLAN §6). The
prototype's split view is a test harness (`apps/pos/src/pages/Till.tsx` lines
317-353 and 1682-1735; `apps/api/src/routes/me.ts` lines 121-154). This ticket
adds a `/display` route mounted outside `AuthGate`, authenticated by a device
credential from a pairing code (issued by S2-04), fed by the box's redacted
snapshot (S2-05) and allowed to send only stage-valid intents.
`CustomerDisplay`, `FnbCustomerDisplay`, `MerchCustomerDisplay`,
`ConsentCapture` and `SavedChildrenReview` are preserved pixel for pixel; the
harness stays for demos when no display is paired.

Includes:
- `/display` route: pairing screen with a 6-digit code (single use,
  `PAIRING_CODE_TTL_S`); a manager claims it from the till header or
  Console > Devices; credential stored on the device, survives reload,
  revocable, fenced with the lease id and sequence like the till; never
  subject to the staff inactivity lock or the 401-lock handler.
- Redacted snapshot: stage, cart lines, totals, language, prompts, QR to
  show; never allergies, medical notes, holder names or member notes
  (asserted by a test); a "Snapshot" tab on the Devices display row shows the
  last redacted JSON sent.
- Intents validated by stage on the box: set language, enter phone, nickname,
  contact channel, consent acknowledgement, child slot edits, "done"; staff
  can key any of them on the till when no display is paired; test control
  "Send test intent" (choose stage and intent) on the display's Devices row.
- Harness kept; "display connected" indicator with device name.
- Language toggle drives the display's own i18n copy (five customer
  languages, per-device persistence).
- `session.pending_lookup_*` columns and routes removed; Playwright smoke
  rewritten to drive till + display as two contexts.
- Audit: `display.paired`, `display.revoked` (admin); customer intents go to
  `station_event` with `actor_type=customer` and device id, not `audit_log`.
- Layout check at 1024 × 768 and 1280 × 800 without horizontal scroll.

Excludes: payment QR content (S2-10a); physical display hardware.

Acceptance criteria:
- [ ] A fresh browser at `/display` shows a pairing code; claiming it binds it
      to the station; reload keeps it paired; a code used twice or after
      "Expire code now" is refused; revoking from the console returns the
      display to the pairing screen within 10 s and its next call is refused
      (Devices row shows "revoked, last call rejected").
- [ ] Typing a phone on the display and tapping "Find my membership" makes
      the till show the member and children; the Snapshot tab contains no
      allergy field.
- [ ] "Send test intent" with consent ack while `stage=welcome` is rejected
      by the box and shown in the Box log drawer and `station_event`; the
      till is unaffected.
- [ ] With no display paired the inline pane appears and staff can enter the
      phone; with one paired the pane is replaced by the indicator.
- [ ] The display stays paired and responsive after the till locks and after
      the till signs out.
- [ ] Dev evidence: the Playwright smoke lock → sign-in → display phone →
      till children confirm passes across two contexts.

QA / demo steps:
1. QA (UI): Open `/display` in an incognito window; screenshot the code;
   claim it from the till header; screenshot both screens paired; generate a
   second code, press "Expire code now", try it; screenshot the refusal.
2. QA (UI): Type `+66811111111` on the display and tap Find my membership;
   screenshot the till with Mali's children and the Snapshot tab without
   allergies.
3. QA (UI): Press "Send test intent" (consent ack at welcome); screenshot the
   rejection in the Box log drawer.
4. QA (UI): Lock the till (inactivity); show the display still live; unlock.
5. QA (UI): Revoke the display in Console > Devices; screenshot the pairing
   screen and the "revoked" row.

Depends on: S2-05, S2-06. Size: M.

### S2-09 — Checkout and sales ledger

Feature area: Checkout and sales

Rules: R-04, R-05, R-10, R-19 to R-26, R-28, R-29, R-31 to R-36, R-47, R-65 to R-69, R-104; conflicts C4, C5, C6 (tax_category_override replaces the numeric tax_override), C18.

Description. Selling is 100 % mock today: `recordSale`, F&B and merch orders,
discounts and the tax engine live in `apps/pos/src/mockApi.ts` and
`apps/pos/src/lib/*` and vanish on reload. The prototype's rules are approved
behaviour and are ported, not reinvented: per-tier kid price and adult rules
(`lib/pricing.ts:priceForTier`, `resolveAdultLine` — already in
`packages/shared`), socks and add-on snapshotting (`setAddOnQty`,
`setAddOnVariants`), breakdown rows (`computeLineBreakdown`), manual discounts
(`lib/manualDiscount.ts`), promo codes (`lib/promoVoucher.ts`), discount
scopes (`lib/discountTarget.ts`), `computeTotals` (`lib/sale.ts`), the tax
engine (`lib/tax.ts:computeTaxBreakdown`), F&B modifiers, merging, prep
routing and pickup code (`lib/fnb.ts`, `lib/menu.ts`), merch pricing
(`lib/merch.ts`). All money moves to satang with one rounding rule regression-
tested against prototype figures. Every sale is a fact with the fields Radar
needs from day one. The tier conflict ships as the default in Open decisions.

#### S2-09a — Ticket cart, pricing/tax engine, sale and sale_line facts, ฿0 finalise, member tier change

Includes:
- Tables (`pos`): `sale` (box-minted id, operator, branch, station, box,
  staff, staff_token_jti, member, visit, booking, sales_channel,
  business_date, occurred_at/received_at, origin, clock_trust, box_seq,
  status tendering|paid|finalised|voided|refunded, subtotal/discount/net/vat/
  service/gross satang, pricing_mode, tier applied, catalogue and engine
  versions, tax snapshot, receipt_number + series, immutable after
  finalised), `sale_line` (kind, refs, label snapshot, revenue_category/
  sub_category, quantity, unit/discount/net/vat/gross, tax rate, kid_count,
  adult_count, stay_duration, customer_tier, child/band refs),
  `receipt_series` (station, series, kind, next_seq; cloud-issued high-water
  mark; `UNIQUE(station_id, series, seq)` on sale), `discount_definition`,
  promo usage; revenue category and sub-category on packages and add-ons.
- Shared engine in `packages/shared`: pricing + tax + business-date
  (`business_day_start`) with regression fixtures; unit tests for midnight and
  boundary cases; identical output on box and cloud. Tax follows the
  prototype's cascade exactly (conflict C6): a product's override points at a
  taxable *category* (`tax_category_override`), not at a rate, so the numeric
  `tax_override` from Sprint 1 is retired; service charge and tax-on-service
  per category; inclusive-of-VAT and inclusive-of-VAT-and-service unwinds with
  the decomposition order held in `branch_tax_config` (accountant to confirm,
  Open decision 22); stored-value loads untaxed at load (R-35).
- Ticket cart intents on the box (add line, kids/adults/socks/add-ons, tier
  lock/change, apply promo, manual discount with reason); display shows the
  itemised order (stage `order`).
- Member tier change per PROJECT_CONTEXT §10: one `member.tier_change` service
  for upgrade and downgrade with evidence type from the client list and
  optional expiry; downgrade requires `pos:member:tier_downgrade`
  (branch_manager and above); `job:tier.expiry` daily sets
  `member.tier_review_required` instead of downgrading, and the till shows
  "tier verification expired — re-verify" on identify; a test asserts no
  file_object is ever linked to a tier verification (no ID photos).
- Sale finalisation as a box fact or the cloud path; receipt number allocated
  on the box from the issued series and persisted before printing; ฿0 comp
  sale finalises without a tender; `GET /sales`, `GET /sales/:id` with a
  "Sale detail" view in the POS (lines, totals, attempts later).
- Test control "Business date override" (station-level, staging only) so
  weekend pricing is reproducible; the seeded holiday is the alternative.
- Analytics facts: a Vitest asserts the Radar field list on a seeded sale.
- `seed:demo-day` script started here (members, stations, boxes, ticket sales
  on a fixed business date) and extended by S2-10a/b, S2-13.

Excludes: F&B/shop carts, catalogue admin panels, member-API migrations,
product barcode (S2-09b); tenders (S2-10a); printing (S2-11); wallets, stock
and the stock guard (S2-14a/b); drop-off lines (S2-13).

Acceptance criteria:
- [ ] A 2 Hours Play line for 2 kids + 3 adults on a weekend (business date
      override or the seeded holiday) for `+66822222222` (James, expat,
      seeded) totals the fixture value — computed from the shared engine
      against the seed and attached to the Jira ticket as a table when the
      ticket is created — with the free-adults rule applied per line; a tier
      change through the verification modal re-prices every line; a walk-in
      defaults to tourist.
- [ ] A 10 % promo code then a manual fixed discount with reason produce
      totals in the prototype's order (manual first, promo sequential against
      the running balance, then tax); the breakdown shows VAT 7 % inclusive
      per category; a free-item promo adds the synthetic line and offsetting
      discount.
- [ ] Reception cannot downgrade James to tourist (403
      `TIER_DOWNGRADE_DENIED`); a manager can, with evidence type and reason,
      audited `member.tier_change`; running `job:tier.expiry` (Health
      button) on a member whose evidence expired yesterday sets the review
      flag and the till shows the re-verify notice; the no-ID-photos test
      passes (dev evidence).
- [ ] A ฿0 comp sale finalised from an offline box produces a sale row after
      reconnect with `origin=box`, `business_date` per the branch day start
      (a sale at 00:30 belongs to the previous business date — test), a
      receipt number in the station's series and no duplicate on replay; two
      boxes cannot produce the same receipt number (conflict → `sync_anomaly`,
      test).
- [ ] The Sale detail view and `GET /sales/:id` show lines with
      revenue_category, kid_count, adult_count, stay_duration and
      customer_tier populated; Activity rows `sale.create`/`sale.finalise`
      carry station and box ids.

QA / demo steps:
1. QA (UI): Set the business date override to a Saturday; build the
   regression cart for James; screenshot the order summary, the display
   totals and compare with the fixture table.
2. QA (UI): Apply a promo code and a manual discount with reason; screenshot
   the breakdown and VAT lines and the Sale detail view.
3. QA (UI): As reception try to downgrade James; screenshot the refusal; as
   manager downgrade with evidence; screenshot the Activity row; run
   `job:tier.expiry`; screenshot the re-verify notice on identify.
4. QA (UI): Take the box offline, finalise a 100 % comp sale, bring it
   online; screenshot the sale in Activity with `origin=box` and the receipt
   number.
5. Dev evidence: pricing regression, business-date boundary, receipt-series
   conflict and no-ID-photos test output.

Depends on: S2-05, S2-08. Size: L.

#### S2-09b — F&B and shop carts, catalogue admin panels, member-API migrations, product barcode

Includes:
- Menu categories, modifier groups, add-ons and merch tables ported from the
  `catalogStore` shapes with revenue categories; F&B and merch cart intents
  (add/merge/modifiers/note/variant, merch add with size); prep routing and
  pickup code; `sale_line` kinds `fnb|modifier|product`.
- Product barcode handler registered in the scanning service: scanned barcode
  → merch/stock item lookup → adds the line (or "unknown barcode").
- Admin catalogue panels wired: Add-ons, F&B Menu, Categories (two-level),
  Modifiers, Merch (with barcode field), Discounts and promo codes, discount
  reasons, revenue categories; Tiers write-through fixed.
- `MobileTill`, `PartyTicketModal`, `BookIdentify` and the Till's event-pass
  path moved to `membersApi` so one member record exists.
- **Branch catalogue clone** (R-03, proposal §6.4): "Clone from another
  branch" copies tickets, menus, prices, tax configuration, supervision
  policy, inventory definitions, promotions, benefits, payment methods and
  print templates into the target branch with fresh ids, all-or-nothing in
  one transaction, with no later sync between the two; a preview lists what
  will be created and what already exists; audited `catalog.clone` with the
  source branch and the counts per entity.

Excludes: cloning into a branch that has sales (refused with the reason);
stock levels, out-of-stock and low-stock behaviour (S2-14b — the
shop sells without a stock check until then); wallets (S2-14a); printing
(S2-11).

Acceptance criteria:
- [ ] An F&B order with a required single-choice modifier cannot be added
      until satisfied; identical lines merge; different notes stay separate;
      prep station resolves override → category → parent → kitchen; the
      pickup code is required before tender.
- [ ] A multi-variant merch item asks for the size; scanning the seeded
      barcode `8850000000017` in the scanner simulator adds "Grip socks M" to
      the shop cart; an unknown barcode shows "unknown barcode" and no line.
- [ ] Editing an item on the F&B Menu panel appears on the till after the
      cache pull; a promo code created on the Discounts panel applies on the
      till.
- [ ] `MobileTill` and `BookIdentify` find `+66811111111` from the API and no
      file under `apps/pos/src` outside `mockApi.ts` reads mock members (dev
      evidence: grep in CI).

QA / demo steps:
1. QA (UI): On F&B add an item with modifiers, a second with a note, enter the
   pickup code; screenshot the order and line kinds.
2. QA (UI): On Shop add a size-variant item; scan `8850000000017` in the
   scanner simulator; scan `0000000000000`; screenshot both behaviours.
3. QA (UI): Edit an F&B item and create a promo code in the admin panels;
   screenshot the change on the till after the cache pull.
4. QA (UI): Open MobileTill and look up `+66811111111`; screenshot.

Depends on: S2-09a. Size: L.

### S2-10 — Payments and redemption

Feature area: Payments and redemption

Rules: R-37 to R-43, R-59, R-64; conflict C18 (split-capable payment, canonical card token); booth redemption per docs/features/booth.md.

Description. The prototype's two-step payment (pick the method mirrored on the
display, then "Confirm Payment Received" — `components/till/StepPayment.tsx`)
is preserved; behind it the brief's payment machinery replaces the mock
(PROJECT_CONTEXT §7.1-7.2). Redemption of booth vouchers and legacy codes is a
separate story so the tender path does not wait for the booth.

#### S2-10a — Tenders: cash, EDC terminal simulators in the NEXGO and PAX dialects with inquiry-on-no-response, real 2C2P sandbox QR with PAX QR offline fallback, manual recording, payment methods admin

Includes:
- `payment_attempt` (method cash|card|qr|wallet|voucher|transfer, amount,
  cash tendered/change, status created|sent_to_terminal|approved|declined|
  cancelled|unknown|inquiring|not_found|awaiting_staff_confirmation|
  awaiting_settlement, device, provider simulator|ghl|digio|2c2p|manual,
  terminal_ref, TID, MID, approval code, last4, gateway `invoice_no`
  (≤ 20 alphanumeric for QR, unique forever), `tran_ref`, `payment_id`,
  raw QR payload, expires_at, staff_confirmed_by, offline flag, paid_at,
  box_seq); split tenders; an "Attempts" list on the Sale detail view.
- `terminal_counter (device_id, next_ref)` on the box: 6-digit rolling refs
  for QR/Digio devices, 12-char `pos_ref_no` for card/GHL devices, mapped to
  the attempt id; test that refs are unique per terminal per day.
- Cash: tendered/change, drawer kick, finalisation; cash tenders stamped for
  S2-15a.
- Card via station routing → terminal adapter with the inquiry rule, staff
  confirmation (audited), decline handling, approved amount ≠ requested →
  reject and void; manual entry (approval code + TID); terminal simulator
  panel (approved, declined, partial approval, no-final-response, inquiry
  unavailable, timeout; "Advance terminal clock" for void windows). The two
  adapters encode and parse the vendors' real messages — GHL LinkPOS XML with
  decimal amounts and ISO response codes for cards, 00/01 for wallets; Digio
  Direct Terminal `3E55`-framed BER-TLV with satang amounts and per-type action
  codes — against fixtures taken from `imports/_vendor-docs/`; the simulator
  answers on those same messages, so only the serial link changes on site.
- QR: `packages/payments-2c2p` behind `QrPayment` per
  `docs/architecture/PAYMENT_GATEWAY.md` — the sandbox (real QR codes) when
  `PGW_*` is set, the gateway simulator otherwise. Payment Token (JWT HS256
  envelope, `invoiceNo` one per attempt in the `[prefix]STATION+YYMMDD+SEQ`
  form, `currencyCode "THB"`, `paymentExpiry` from `PGW_PAYMENT_EXPIRY_MIN`)
  → Do Payment on channel `PPQR` (configurable; the Payment Option call
  confirms it) with `qrType RAW` so the EMVCo payload is rendered on the
  customer display locally with the `expiryTimer` countdown; the backend
  notification (`POST /webhooks/2c2p/payment`: signature verified, merchant
  checked, `ops_run` recorded, idempotent on `invoiceNo` + `tranRef`,
  amount compared, sale marked paid inside the sale transaction; fields
  `respCode`, `tranRef`, `approvalCode`, `channelCode`, `agentCode`,
  masked `accountNo`) with Payment Inquiry polled every
  `PGW_INQUIRY_INTERVAL_S` up to `PGW_INQUIRY_MAX_MIN` as the safety net;
  `respCode` mapping (0000 paid, 0001/2001 pending, 0003 cancelled, 9020/5009
  expired, 5015/5016 amount mismatch → `awaiting_staff_confirmation`); void
  same day (`processType V`) and refund after settlement (`processType R`)
  through Payment Maintenance on its own host with the `PGW_MAINT_*` RSA keys,
  honoured by the simulator; PAX QR payload from the terminal simulator when
  the box or cloud is unreachable, attempt flagged `awaiting_settlement`;
  `job:payments.pending` flags any attempt in `sent_to_terminal|unknown|
  inquiring` older than `PAYMENT_PENDING_MIN` (10) on Failures; gateway
  simulator panel with "customer paid", "decline", "expire", "late payment"
  and "Suppress webhook". How the 2C2P sandbox marks a PromptPay QR as paid is
  UNCERTAIN in the public docs (PAYMENT_GATEWAY §2.9) — the first sandbox
  session settles it with 2C2P support; until then the acceptance runs on our
  simulator and on the sandbox's own inquiry.
- Adapter payloads stored after the allow-list projection; every adapter call
  an `ops_run` kind device/integration under the action id.
- Payment methods admin (prototype `PaymentMethodsSection`) wired.
- `seed:demo-day` extended with sales across all tenders on two TIDs.

Excludes: voucher redemption (S2-10b); refunds/voids/History (S2-11); cash
sessions, EOD, settlement (S2-15a); wallet tender (S2-14a); real adapters.

Acceptance criteria:
- [ ] Cash tender records tendered and change, kicks the drawer in the
      simulator and finalises the sale; the display mirrors the chosen method
      before confirmation.
- [ ] Terminal "approved" finalises with approval code, TID, last4 and a
      12-char reference; "declined" returns to method selection; "no final
      response" blocks the till, runs inquiry, and an approved inquiry completes
      the sale without a second charge; "inquiry unavailable" shows the staff
      confirmation dialog and the confirmation is audited with the staff id;
      "partial approval" is refused and voided; dev evidence: the ref
      uniqueness test and the PAN/PII redaction fixture pass, and the stored
      `ops_run` payload contains only allow-listed fields.
- [ ] QR tender shows the 2C2P QR on the display; "customer paid" flips the
      display to thank-you within 5 s via webhook, or within one poll interval
      with "Suppress webhook" on; a replayed webhook changes nothing; with the
      box offline the display shows the PAX QR and the attempt is
      `awaiting_settlement`.
- [ ] With the box offline a cash sale and a terminal-approved sale finalise
      and appear on the Sale list after reconnect exactly once.
- [ ] A manual card entry with approval code and TID is recorded and audited;
      an attempt left `inquiring` for 10 minutes appears on Failures.
- [ ] The Attempts list on the Sale detail shows every attempt with status,
      provider and reference; the action id on an attempt matches the Box log
      line and the adapter `ops_run`.

QA / demo steps:
1. QA (UI): Sell a ticket for cash; screenshot the tender screen, change, the
   drawer kick and the Attempts list.
2. QA (UI): Sell for card with "no final response"; screenshot the blocked
   till, the inquiry row on Failures/ops and the completed sale; repeat with
   "inquiry unavailable" and "partial approval"; screenshot the dialog, its
   Activity row and the void.
3. QA (UI): Sell with QR; screenshot the display QR; press "customer paid";
   screenshot the thank-you; repeat with "Suppress webhook"; take the box
   offline and repeat; screenshot the PAX QR and the `awaiting_settlement`
   attempt.
4. QA (UI): With the box offline sell for cash and for card (approved);
   reconnect; screenshot both sales on the Sale list once.
5. QA (UI): Record a manual terminal payment; screenshot the attempt row.

Depends on: S2-09a. Size: L.

#### S2-10b — Booth voucher and legacy code redemption inside a sale

Includes:
- "Redeem voucher" in the till order panel (same design language as promo
  entry) via the scanning service or manual entry; append-only `redemption`
  table (instrument kind, code, sale, station, box, staff,
  `marketing_channel_id`, result ok|already_used|expired|not_found|invalid);
  prize line or discount per the voucher definition; server validation only,
  refused offline; `pos:voucher:redeem`.
- Exact messages: a booth-prefixed code of valid shape that is unknown →
  "Code not found — the booth may not have synced yet"; a malformed code, an
  unknown legacy code or a tampered code → "Invalid code"; already redeemed →
  "Already redeemed on <date time> at <branch/station> by <staff>"; expired →
  "Voucher expired on <date>".
- Abuse limits: per-station and per-staff not-found budget 5 per minute →
  10-minute lock + alert `redemption.probing`; legacy 4-digit codes require
  the campaign/date window from the fixture or manager confirmation.
- Legacy import job from a fixture shaped like Radar's spin ledger,
  `campaign_qrs` and `spin_reward_legacy_code_reservations` (origin
  migration, null expiry; reserved-but-unissued numbers stored as
  `reserved` and never mintable).
- `seed:demo-day` extended with vouchers and legacy codes.

Excludes: booth report (S2-15b); refunds of redeemed vouchers (S2-11).

Acceptance criteria:
- [ ] Scanning a freshly printed booth voucher inside a sale adds the prize
      line, marks the voucher redeemed with staff, station, sale and channel,
      and shows "hand over: <prize TH/EN>"; a second scan shows the exact
      already-redeemed text; an expired voucher shows the expired text.
- [ ] A well-formed unknown booth code shows the not-synced text; `ZZZZ9`
      shows "Invalid code"; a booth code with one altered character shows
      "Invalid code"; with the till's box offline redemption is refused and no
      row is created.
- [ ] Legacy fixture codes `1234` and `A1B2` redeem once each with
      `origin=migration` and no expiry; reserved number `5678` returns "Invalid
      code" and a new booth can never mint it (test).
- [ ] Six not-found attempts within a minute lock redemption on that station
      for 10 minutes and open `redemption.probing`.
- [ ] Every redemption appears in Activity with the action id linking the till
      line, Box log and audit row (spot check three).

QA / demo steps:
1. QA (UI): In a sale scan the voucher printed in S2-07a; screenshot the prize
   line and hand-over message; scan again; screenshot the block text.
2. QA (UI): Type an unknown well-formed booth code, then `ZZZZ9`; screenshot
   both messages; redeem `1234` and `A1B2`; try `5678`; screenshot the rows in
   Activity.
3. QA (UI): Toggle the till's box offline; attempt a redemption; screenshot
   the refusal.
4. QA (UI): Enter six unknown codes quickly; screenshot the lock and the
   alert.

Depends on: S2-07a, S2-10a. Size: M.

### S2-11 — Sale printing and signed bands, History tab with refunds, voids and reprints

Feature area: Printing, bands and corrections

Rules: R-30, R-49 to R-53, R-104.

Description. With the print core in place (S2-06) this ticket wires the
prototype's per-sale routing (`lib/printRouting.tsx`): receipt plus kids and
adult bands per person, one prep ticket per station with the allergy line and
notes, merch receipt. Bands are minted on the box as station-prefixed ULID +
HMAC (`BAND_HMAC_KEY`, kid) and stored as `band` + `band_event` rows. The
History tab (`pages/History.tsx`, `components/history/TransactionDetail.tsx`)
moves to the sale API with the prototype's refund rules
(`mockApi.ts:recordRefund`), voids routed by the original tender's window, and
reprints per `recordReprint`. Manager approval for refunds
(`pos:refund:approve`) is a recorded addition. This is where the client
play-test opens.

Includes:
- Ticket sale output: receipt + kids bands × n + adult bands × n + item
  vouchers; F&B: receipt + one prep ticket per station with allergy line,
  notes and order note; merch: receipt; receipt content: receipt number,
  tender lines, VAT rows from `summarizeTax`, abbreviated tax-invoice header,
  member nickname, band codes; printing works offline (jobs queue on the box).
- `band` + `band_event`; the signed band code printed as a **QR** on the
  TSPL band (the signature does not fit a 1D strip) with a short Code 128 /
  human-readable line beneath (DEVICE_INVENTORY §4 D4), both readable by the
  scanner simulator; verifiable offline on the box; band handler registered.
  The band artwork (QR + short code) is shown to the owner at CP3 because the
  earlier design review recorded a 1D-only band as the approved look.
- History tab wired: branch-scoped list with universal search, detail with
  lines, tenders, attempts, refunds, reprints; band and phone lookups.
- `refund` table (own series, reason, approver); whole / by item / custom
  clamped to remaining; void windows by adapter (card before settlement,
  wallets before 23:00, Thai QR not voidable → `QrPayment.refund`); status
  `paid → partially_refunded → refunded`; refund allocation wallet →
  same-tender → cash; refunds and voids online-only with `pos:refund:approve`;
  offline the till can only queue a "refund requested" note; voided sales keep
  their receipt number; stock and wallet restore hooks (applied by S2-14a/b).
- Reprints: receipt, kids band group, adult band group, F&B pickup ticket;
  band reprint keeps the id and marks the old print replaced; audited with
  `reprint_of`.
- Client play-test guide v1 issued with this ticket.

Excludes: credit voucher printing and wallet grants (S2-14a); booth voucher
(S2-07a); paid time extensions (deferred); real printers; cash sessions and
EOD (S2-15a).

Acceptance criteria:
- [ ] A finalised ticket sale (2 kids, 1 adult) produces one receipt, two kids
      bands and one adult band in the simulator; the receipt shows Thai text,
      the VAT rows and the abbreviated tax-invoice header.
- [ ] The same sale with the box offline prints the receipt and bands from
      the box queue, and the `print_job` rows sync after reconnect.
- [ ] An F&B order with kitchen and bar items produces one prep ticket per
      station with the allergy line; a station without a kitchen printer
      completes with "kitchen ticket not printed" and a skipped `print_job`.
- [ ] Band codes decode with the scanner simulator to their band record; a
      tampered code fails on the box; a reprinted band keeps its id and the
      old print is marked replaced.
- [ ] History lists the day's sales branch-scoped, opens a detail with the
      Attempts list, and finds a sale by band code and by member phone.
- [ ] A whole-sale refund of a card payment with the terminal clock inside the
      void window voids on the simulator; after "Advance terminal clock" it
      refunds; a QR payment refunds through `QrPayment.refund`; amounts clamp
      to remaining; reception gets 403 `REFUND_APPROVAL_REQUIRED`; status goes
      `paid → partially_refunded → refunded`; offline, the refund button shows
      "online only" and queues a request.
- [ ] Reprinting the receipt from History creates a `print_job` with
      `reprint_of` and an audit row; paper-out during a sale never blocks
      finalisation and the queued job prints when cleared.

QA / demo steps:
1. QA (UI): Finalise the 2 kids + 1 adult sale for cash; screenshot the
   receipt and bands in the simulator and the `print_job` rows in Activity;
   repeat with the box offline; screenshot the printed output and the synced
   jobs.
2. QA (UI): Place an F&B order with one kitchen and one bar item and a note;
   screenshot both prep tickets.
3. QA (UI): Scan a printed band with the scanner simulator; screenshot the
   band record; alter one character; screenshot the rejection.
4. QA (UI): Open History; search by band code and by phone; screenshot the
   detail with attempts.
5. QA (UI): Refund the card sale inside the void window, press "Advance
   terminal clock", refund another outside it; refund the QR sale; screenshot
   the refund rows and the 403 for reception; toggle offline and screenshot
   the "online only" state.
6. QA (UI): Reprint the receipt; screenshot the `reprint_of` job and audit
   row.

Depends on: S2-06, S2-10a. Size: L.

### S2-12 — Arrival: online booking checkout via the 2C2P Redirect API sandbox, signed booking QR, redemption at the till issuing bands, GE-X2/HX-X1 gate simulator with its QR reader, anti-passback and live occupancy

Feature area: Arrival

Rules: R-43, R-78 to R-84; conflicts C8 (PC gate mechanism wins; group rule kept for kids' bands), C11.

Description. Today `POST /public/bookings` marks the booking `paid` without
payment (`apps/api/src/routes/public.ts` line 230) and the till's
`RedeemBookingModal` reads mock bookings. This ticket completes the booking
site's pay step through the 2C2P Redirect API (sandbox; simulator only without credentials), issues a signed
booking QR the box verifies locally, ports the prototype's redemption
(`mockApi.ts:redeemBooking`, `issueBookingBands`) and adds the gate simulator
with per-band anti-passback and occupancy from passage events (§7.5). The
prototype's group-based kid occupancy rule (`mockApi.ts:getLiveOccupancy`) is
replaced by the brief's model — a recorded deviation.

Includes:
- `booking` and `attendee` reshape (channel, package, counts, payment_attempt
  link, paid_at, expires_at, signed QR kid/signature, business_date, pricing
  snapshot, redeemed_at/station); unpaid bookings expire; existing rows
  migrated.
- Booking site pay step: server-side quote through the S2-09a engine, 2C2P
  Redirect API (Payment Token → hosted page on the sandbox; the simulator page
  with pay/fail only when no credentials are configured), JWT-verified
  frontend return and backend notification, Payment Inquiry before the booking
  is marked paid, confirmation with a real signed QR (replacing `lib/qr.ts`),
  business date from the chosen visit date (no override needed for weekend
  pricing); confirmation via the console adapter; public rate limiting.
- Redemption service shared with the kiosk later: verify signature + status +
  local redemption log on the box, create the sale with `bookingReference` and
  the booking's tender, mint and print bands per S2-11, mark redeemed;
  cross-station double use flagged at sync.
- Gate adapter and simulator built on the real protocols
  (`docs/architecture/DEVICE_INVENTORY.md` §6): the gate box hosts the
  reader's HTTP contract (`POST /interaction/Api/checkCard` with base64 card
  or QR, entry/exit reader, string values; `/heartbeat`), answers
  `code "1"`/`"0"` with a short bilingual message, pulses the dry contact
  (L-OP/R-OP) through the relay abstraction, and reads GE-X2 passage feedback
  over the serial abstraction (`61`/`62` passed, `63`/`64` timeout,
  `73`/`74` loitering, `83`/`84` wrong direction, `93`/`94` tailgating,
  `95` beam blocked); door and infrared status queries; machine id and baud
  from config (`L-30`, `L-31`). The simulator in the Simulators panel plays
  both the reader (scan a band, entry or exit) and the controller (person
  passes / does not pass / tailgates / reverses; fire alarm; power loss; fault
  codes E1–E30); gate box role; access decision on the box (signature check,
  anti-passback, adults-only at the reader per C8, deny list of voided bands
  synced down); `band_event` entry|exit|denied|timeout|alarm; occupancy
  counted from passage feedback only, never from the open command.
- Live occupancy per branch: `OccupancyChip` preserved; Health;
  `fact_occupancy_15min`.
- Gate admin and bookings admin list.

Excludes: supervision gate, consent, check-in board (S2-13); kiosk UI; event
passes; real gate controller.

Acceptance criteria:
- [ ] A booking for 2 kids + 2 adults for the seeded holiday date is quoted
      server-side including socks at weekend prices, paid on the 2C2P
      sandbox hosted page, stored `paid` only after the backend notification
      (or inquiry) confirms it, with a signed QR; a failed or expired payment
      stays unpaid and is refused at the till with "booking not paid".
- [ ] Scanning the QR creates a sale with `bookingReference` and the booking's
      tender, mints 2 kid + 2 adult bands, prints them, marks the booking
      redeemed; a second scan shows already-redeemed; a tampered signature is
      refused with the box offline.
- [ ] With the box offline, a booking paid earlier and present in the cached
      today's-bookings bundle still redeems; the redemption syncs once.
- [ ] Adult band A scanned at the entry reader posts `checkCard`, the box
      answers `code "1"`, the simulated controller reports `61` and occupancy
      shows 1; A again before an exit is denied `ANTI_PASSBACK` (`code "0"`
      with the message on the reader); an exit passage (`62`) shows 0; a
      `63` timeout after an open leaves occupancy unchanged; a kid band and a
      voided band are denied with their reasons in Activity.
- [ ] `OccupancyChip` updates within 5 s of a passage event; a scripted
      tailgating event (`93`) opens a `gate.tailgating` alert; fire-alarm
      state opens the gate, holds it open and opens a `gate.fire_alarm`
      alert; a scripted controller fault (E30) shows on Health.
- [ ] Bookings, redemptions and gate decisions are audited with station and
      box ids (spot check three).

QA / demo steps:
1. QA (UI): On `/book` make the 2 kids + 2 adults booking for the seeded
   holiday date; pay on the simulator; screenshot the confirmation QR and the
   booking on the admin list; make a second and press "fail"; show unpaid.
2. QA (UI): At the till scan the QR with the scanner simulator; screenshot the
   sale, the bands and the redeemed booking; scan again.
3. QA (UI): Make a booking online, wait for the cache pull (Devices shows the
   bundle version), toggle offline, redeem; screenshot; toggle online and show
   the synced redemption.
4. QA (UI): On the gate simulator scan adult band A at the entry reader
   (reader shows the welcome message, controller reports passed, occupancy
   1), A again (denied with the message), exit, then a kid band (denied);
   screenshot each including the reader message and the feedback frame.
5. QA (UI): Trigger a tailgating event, then the fire alarm; screenshot the
   gate state, the alerts and the Health fault row.

Depends on: S2-11. Size: L.

### S2-13 — Child check-in and supervision: supervision gate and consent at the till, drop-off and nanny lines, check-in board with timers, authorised pickups, offline check-in and offline release with collector photo

Feature area: Check-in and supervision

Rules: R-06, R-07, R-27, R-62, R-85 to R-95; conflict C9 (pickup-safety photos allowed; ID-document photos never).

Description. The prototype's check-in domain is complete and mock-only
(`lib/supervision.ts`, `lib/dropoff.ts`, `mockApi.ts:registerWalkInChildren`,
`checkInFamilyWithPayment`, `checkInFamilyBooked`, `pages/DropOff.tsx`,
`getAuthorizedPickups`, `addGuardianToRegistration`, `checkOut`). The brief
makes check-in and child release offline mandatory (PROJECT_CONTEXT §8). This
ticket ports the rules to the API and box, wires the prototype screens, and
stores photos through file storage; offline, photos are captured and stored on
the box and uploaded on reconnect. Check-in ownership at cutover is an owner
decision that does not block the flow.

Includes:
- Tables (`crm`/`pos`): `registration`, `checkin`, `guardian`,
  `supervision_waiver`, `release` (collector, photo file_object, verified_by,
  offline flag, `photo_pending_upload`), nanny roster (seeded shifts),
  supervision policy and confirmations config, drop-off pricing config;
  consent record and retention TTL fields.
- Till: unaccompanied-sale detection, supervision gate (step 7) and saved
  children review (step 8), consent capture on the display (S2-08 intents),
  drop-off/nanny line fees per prototype rules, prepaid food provision as a
  line charge, "Check in now" (atomic, mints WI bands via S2-11) vs "Leave as
  booked"; all of it on the box surface so it works offline.
- Check-in board: grouped by family, timers, due-soon/overdue, filters,
  audited edits with change log, assign nanny (on shift), add child, booked
  check-in without payment.
- Authorised pickup sheet and release modal with side-by-side photos, unlisted
  collector path, prepaid-food reconciliation (seeded policy
  `prepaid_food_unused = refund`), nanny freed.
- Offline: pickup list and in-park children in the box cache; check-in and
  release recorded locally and queued; photo stored on the box `Store`
  (bounded, 7-day purge), uploaded on reconnect, release row linked
  afterwards; connection-check messages via the console adapter.
- Overstay displayed only; `CHILD_PHOTOS_ENABLED` flag; access log on child
  health reads; admin panels for supervision policy, confirmations, drop-off
  pricing wired; `seed:demo-day` extended with check-ins.

Excludes: online booking drop-off lines (deferred); kiosk hand-off; real
messaging adapters; overstay billing; OTO App history import.

Acceptance criteria:
- [ ] A sale with 0 adults and one 6-year-old triggers the supervision gate;
      the policy resolves drop_off; a 9-year-old sibling makes the waiver
      available but never auto-applied; accepting it is audited with the
      sibling name.
- [ ] Completing consent and paying creates one registration; "Check in now"
      sets in_park, mints WI bands with the provision, prints them and links
      the sale; "Leave as booked" sets scheduled_for and no band.
- [ ] With the box offline, a walk-in supervision check-in (consent on the
      display, cash, "Check in now") completes, prints the WI band, and syncs
      once on reconnect.
- [ ] The board shows the family in_park with a countdown; editing the booked
      duration writes an audited change-log entry; a nanny off shift cannot be
      assigned ("not on shift").
- [ ] Release with a listed collector records collector, pickup photo and
      verifying staff; an unlisted collector requires name + photo and is
      persisted on_the_spot; unused prepaid credit is refunded per the seeded
      policy and shown on the modal.
- [ ] With the box offline, release completes with a photo captured on the
      box, the child moves to out, the release syncs exactly once, the photo
      uploads on reconnect and the release row links it; the pickup list came
      from the cache.
- [ ] Check-in actions appear in Activity under the staff category with
      station and box ids (spot check `checkin.create`, `release.create`,
      `checkin.update`).

QA / demo steps:
1. QA (UI): Build a ticket cart with 1 kid age 6 and 0 adults; screenshot the
   gate; add a 9-year-old; screenshot the waiver offer; decline.
2. QA (UI): Complete consent on the display; pay cash; "Check in now";
   screenshot the WI band and the family on the board with the timer; repeat
   the whole flow with the box offline; reconnect; screenshot the synced
   check-in.
3. QA (UI): Edit the booked duration; screenshot the change log; assign a
   nanny; try one off shift; screenshot the refusal.
4. QA (UI): Toggle the box offline; open the release modal; pick the listed
   parent, capture a pickup photo; confirm; screenshot the child in out and
   the queued event; toggle online; screenshot the synced release with the
   uploaded photo.
5. QA (UI): Release a second child with an unlisted collector; screenshot the
   on_the_spot guardian and the reconciliation line.

Depends on: S2-08, S2-11. Size: L.

### S2-14 — Wallets and stock

Feature area: Wallets and stock

Rules: R-35, R-48, R-60 to R-64 (wallets); R-71 to R-77 (stock); conflicts C7, C12.

Description. The prototype's wallet is one universal pool per band spendable
at F&B and merch, granted by ticket credit rules (`lib/sale.ts:buildCreditGrants`,
`unitCredit`; `mockApi.ts:ensureSaleGrantWallet`, `chargeFnbCredit`,
`getWristbandByCode`) with an append-only ledger; the brief adds prepaid child
wallets, an offline spend cap and server authority over balances. The stock
module is complete in the prototype (`store/catalogStore.ts`,
`components/mobile/stock/*`). Two stories, two features; the only link is the
refund restore hook.

#### S2-14a — Wallets: credit grants, band-keyed spend with the offline cap, ledger

Includes:
- Tables: `wallet`, `wallet_key` (band|voucher_qr|child|phone),
  `wallet_entry` append-only, `wallet_balance` projection, offline cap on
  station/branch config (seeded ฿300 per wallet per day), overdrafts to
  `sync_anomaly`; `fact_wallet_liability_daily`.
- Credit grants per prototype rules minting a wallet keyed by the band;
  credit voucher QR resolves to the same wallet; credit voucher print job;
  balance on display and receipt; a "Wallet" lookup view in the POS
  (key → ledger).
- Wallet tender in the S2-10a state machine; offline spend up to the cap,
  above it "online only"; refunds restore credit first (S2-11 hook); prepaid
  child provision loads the child wallet at check-in.
- **Expiry and reactivation** (proposal §6.6): a job expires unused credit
  and meal provisions at the branch's end of day, writing an `expiry` ledger
  entry that keeps the history; the policy is configuration per branch
  (`wallet_policy`: same-day | n days | never, seeded same-day per the
  proposal and changeable without a deploy — Open decision 14); reactivation
  needs `pos:wallet:reactivate` and a typed reason, is audited, and appears
  in the ledger as its own entry.
- **Promotional vouchers** (proposal §6.6): voucher definitions that target a
  category, an item or a free item, with global and per-customer limits, a
  validity window, tax placement per the S2-09a engine, and issuance either
  printed at the till or minted for a campaign; redemption inside a sale
  through the S2-10b path; reporting shows them as foregone revenue, separate
  from discounts, in the S2-15b promotions and comps report.

Excludes: staff benefits (S2-21); kiosk (S2-20).

Acceptance criteria:
- [ ] An Eat & Play sale for 1 kid + 1 adult grants full-price credit to both
      bands; the credit voucher QR and the band code resolve to one wallet; the
      display, receipt and printed voucher show the balances.
- [ ] At F&B, scanning the band preselects wallet tender, covers the order up
      to the balance, the remainder is taken in cash; the Wallet view shows
      grant and spend with station/box ids and the projection equals the sum.
- [ ] With the box offline a ฿250 spend succeeds flagged offline; a ฿350
      spend is refused with "online only above ฿300 per day"; two offline
      spends from Reception Till 1 and Counter 2 overdrawing one wallet create a
      `sync_anomaly` on Failures after reconnect.
- [ ] A refund of the F&B order restores credit first, then cash.

QA / demo steps:
1. QA (UI): Sell Eat & Play 1 kid + 1 adult; screenshot the credit voucher,
   receipt balances and the Wallet view ledger.
2. QA (UI): At F&B scan the kid band, order above the balance, pay the
   remainder cash; screenshot the tender split and ledger entries.
3. QA (UI): Toggle offline; spend ฿250 then ฿350; screenshot both; overdraw
   from Counter 2; reconnect; screenshot the anomaly.
4. QA (UI): Refund the F&B order; screenshot the refund ledger entry.

Depends on: S2-10a, S2-11. Size: M.

#### S2-14b — Stock: items, locations, sale decrements, transfers, purchase orders, stock take, stock guards

Includes:
- Tables: `stock_item` with variants/units/reorder settings,
  `stock_location` (bulk|back_of_house|rotation, one sell point),
  `stock_level`, `stock_movement` append-only, `purchase_order` + lines;
  stock valuation facts; seeded levels (grip socks S = 3, M = 20, out-of-stock
  item "Cap") and low-stock threshold 5 eaches.
- Pre-checkout stock guard (moved here from S2-09): out-of-stock merch cannot
  be added; low stock flags at 5; ticket stock guard blocks a cart exceeding
  socks stock with a per-item message; merch stock clamps.
- Admin Inventory panel and locations wired; sale decrements from the sell
  point cascading; refund restores; mobile Stock module tabs wired; restock
  alerts and the POS-wide low-stock strip; stock-take variance > 3 eaches
  requires `pos:stock:approve` (recorded decision).
- **Pack conversions and supplier fields** (proposal §6.11): purchase unit to
  stocking unit to selling unit with a conversion factor per item, par level,
  reorder point, lead time, supplier and cost, all branch-scoped; receiving a
  pack converts to eaches in one movement row.
- **Deduplicated low-stock attention**: one attention item per item and
  branch (never one per location) offering Transfer or Reorder, showing the
  rule that produced it (below par, below reorder point, or the consumption
  trend over the lead time), suppressed while a purchase order covering it is
  open; the trend rule starts from the static reorder point and switches to
  the consumption estimate once 30 days of movements exist (Open decision 27).
- **Inventory-linked booth prizes**: a booth prize may name a stock item; the
  booth's published config drops that prize from the wheel when the linked
  item's sellable stock reaches zero and restores it when stock returns, with
  the change visible in the booth admin and recorded as a config version.

Excludes: supplier integrations (ordering by email or portal); booth
prizes.

Acceptance criteria:
- [ ] "Cap" cannot be added to the shop cart ("out of stock"); a ticket cart
      with 4 pairs of socks S is blocked with "only 3 socks S left"; selling
      socks M to 5 shows the low-stock flag and the strip.
- [ ] Selling grip socks S decrements variant S at the sell point; when short
      the decrement cascades and never goes below zero; a transfer of 10 with
      6 available moves 6 and logs 6.
- [ ] A stock take with a 5-each variance as reception is blocked
      (`STOCK_APPROVAL_REQUIRED`); as manager it adjusts and logs every
      counted row; receiving a PO line posts a stamped adjustment and closes
      the order when fully received; a refund restores the sold quantity.

QA / demo steps:
1. QA (UI): Try to add "Cap" and 4 socks S; screenshot both messages; sell
   socks M down to 5; screenshot the low-stock strip.
2. QA (UI): Sell socks S until the sell point is empty; screenshot levels by
   location; transfer 10 with 6 available; screenshot the movement of 6.
3. QA (UI): Run a stock take with a 5-each variance as reception (blocked)
   then as manager (approved); receive a PO line; refund a socks sale;
   screenshot the adjustments.

Depends on: S2-09b, S2-11. Size: M.

### S2-15 — Day close and reporting

Feature area: Reporting and analytics

Rules: R-44, R-45, R-47, R-101 to R-106; conflict C17; revenue definition per Open decision 15.

Description. The prototype's Today tab runs over in-memory ledgers
(`mockApi.ts:getFloorReport`, `getEndOfDay`; `lib/endOfDay.ts`,
`lib/reporting.ts`). The brief adds cash management ("not in the original
plan; add it", PROJECT_CONTEXT §10), a settlement export per terminal per day,
and the analytics rows Radar will read (PLATFORM_PLAN §5). Two stories: the
cash/EOD close, and the analytics summaries that are an explicit owner
priority.

#### S2-15a — Cash sessions, End of Day reconciliation per tender and TID, settlement export

Includes:
- `cash_session` per drawer/station, `cash_movement` append-only derived for
  cash tenders from `payment_attempt` by business date; UI in Today > End of
  Day and a "Cash" action on the till header.
- End of Day per branch/business_date: expected per channel from
  `payment_attempt`, counted lines, ฿1 tolerance, verdict, close locks the
  day, provisional until every box has synced and no box has unresolved low
  clock trust, second close refused, EOD receipt print.
- Settlement: adapter `settle()` per terminal (simulator returns a batch),
  `settlement_batch`/`settlement_line`, CSV keyed by TID and 2C2P
  `invoiceNo`/`tranRef`, reconciliation match view, PAX `awaiting_settlement`
  attempts reconciled here; a 2C2P settlement fixture shaped like the daily
  reconciliation file 2C2P pushes over SFTP (`Reconcile2c2p_B_v2.4_…csv`,
  H/D records — PAYMENT_GATEWAY §2.11), imported by a job that matches lines
  to attempts by `invoiceNo`/`tranRef` and flags the rest.
- `seed:demo-day` run as the QA fixture (cash, card on two TIDs, QR, wallet,
  voucher sales, one refund).
- **End-of-day occupancy closure** (proposal §6.8): the stranded list — bands
  still counted inside the park at close, and children still checked in —
  with, per row, the last gate event, the sale and the guardian; an
  operator-and-reason manual resolution (left without scanning, band lost,
  gate fault) that clears the count and is audited `gate.manual_resolution`;
  closing the day keeps the history and never silently zeroes occupancy;
  unresolved rows block the close until a manager overrides with a reason.

Excludes: analytics summaries, Today > Performance, booth report (S2-15b);
real settlement files.

Acceptance criteria:
- [ ] Opening a cash session carries the previous close's float; a paid-out
      requires an approver and a safe drop a witness; the close computes
      variance against the closing staff member and the sign-off is audited.
- [ ] After `seed:demo-day`, End of Day expected lines equal the sums of
      attempts (dev evidence: test); a counted line off by ฿50 shows "off";
      close locks the day and prints the EOD receipt; a second close is
      refused; with one box unsynced or with low clock trust the day shows
      provisional and close is refused with the reason.
- [ ] The settlement CSV has one line per approved card/QR attempt with TID,
      approval code and 2C2P invoice number; the PAX `awaiting_settlement`
      attempt becomes `approved` after settlement; an unmatched fixture line
      is flagged.
- [ ] Spot check `cash_session.close`, `cash_movement.paid_out` and
      `settlement.run` in Activity (dev evidence: a test asserts every cash,
      EOD and settlement service call audits).

QA / demo steps:
1. QA (UI): Open a cash session; record a paid-out (approver) and a safe drop
   (witness); screenshot the movements.
2. QA (UI): Run `seed:demo-day` from Health (test control); open End of Day;
   screenshot expected vs counted with a deliberate ฿50 discrepancy; fix;
   close; screenshot the locked day, the EOD receipt and the refusal of a
   second close; toggle a box offline with a sale and show provisional.
3. QA (UI): Run settlement; download the CSV; screenshot the reconciliation
   view with the fixture mismatch flagged and the PAX attempt resolved.

Depends on: S2-10a, S2-11, S2-14a. Size: M.

#### S2-15b — Analytics summaries, Today > Performance, booth report, GET /analytics/summary

Includes:
- `analytics` schema: `branch_source_switch`, `daily_summary` unique(branch,
  business_date, source) with `formula_version` and a `by_channel` breakdown
  (marketing channel from redemptions and vouchers), `hourly_summary`,
  `dim_date` from `branch_holiday`, `dirty_date` queue, `fact_booth_daily`
  (spins, vouchers, redeemed, prize cost), `fact_occupancy_15min`,
  `fact_wallet_liability_daily`; `job:rollup.daily` and the hourly summariser
  run only under `PROCESS_ROLES=jobs`; two frozen legacy fixture days; a
  second branch "Demo Branch 2" in `seed:demo-day` with one day of sales.
- `GET /analytics/summary?branches=a,b&from&to&group=day|total` merging on the
  server; `analytics:read`.
- Today > Performance and the manager report panels on analytics endpoints
  only (never live sales tables).
- Booth report (Console > Booths > Report): funnel by day, booth, staff,
  prize; redemption rate, lag, uptime, prize cost; CSV.

Excludes: Radar's data-layer switch, settings tables, Console analytics
overview (Sprint 3); revenue-definition decision.

Acceptance criteria:
- [ ] After `job:rollup.daily` (Health button), `daily_summary` for HKT
      Central / today / `oto_pos` exists with `formula_version` 1 and a
      `by_channel` entry for "Sales Booth" equal to the redeemed booth
      vouchers' sales; Today > Performance totals equal the database sums
      (dev evidence: test) and read summariser rows only.
- [ ] The legacy fixture days are unchanged by re-runs; a late offline sale
      marks `dirty_date` and the next rollup corrects the row.
- [ ] `GET /analytics/summary?branches=<HKT>,<Demo 2>&group=total` returns one
      merged row equal to the sum of the two branch rows (dev evidence: test)
      and the Performance page's "All branches" view shows it.
- [ ] The booth report shows the demo day's funnel, rate and prize cost; CSV
      downloads.

QA / demo steps:
1. QA (UI): Trigger `job:rollup.daily` from Health; screenshot Today >
   Performance, the `daily_summary` row (Raw record) with `by_channel`;
   toggle a box offline, sell, reconnect, re-run and screenshot the corrected
   row.
2. QA (UI): Switch Performance to "All branches"; screenshot the merged
   totals.
3. QA (UI): Open the booth report for today; screenshot the funnel with prize
   cost and export CSV.

Depends on: S2-07b, S2-10b, S2-15a. Size: M.

### S2-17 — OTO App on the platform: schema and sign-on first, then the full lift, then the contract features

Feature area: OTO App

Rules: conflicts C10 (events mastered by OTO App), C13 (benefits hang off the HR record); OWNER_DIRECTION 2026-09-20 item 2; intake notes `docs/architecture/intake-2026-09-19/01-oto-app-backend.md` §10 (re-hosting work list, sign-on swap) and `02-oto-app-frontend.md`.

Description. The live OTO App (Express 4 + Passport-local + Drizzle, 796
routes, 184 tables, React front end with 122 routes; `imports/oto-app/`) is
the client's daily HR and operations system. The owner wants it on the central
database in this sprint, in three steps that each ship: (a) its schema in the
platform database and its login replaced by the launcher hand-off, so an
admin-created platform user opens the OTO App with no second password — the
proof that the apps share one database and one sign-on; (b) the whole app
lifted onto Render against that schema with every module the export has; (c)
the features the contract still owes, taken from the agency's proposal
(`docs/briefs/AGENCY_PROPOSAL.md` §6), built inside the lifted app. The
intake's verdict stands: **lift as-is first** — one Docker web service, the
handlers untouched, the platform session mapped in before Passport — because a
rewrite would fork from code the client still commits to. The OTO App keeps
its own admin controls; the POS keeps its own admin panels; the Console links
both.

#### S2-17a — `otoapp` schema on the central database, hand-off sign-on, user provisioning from the platform (pulled forward before CP1)

Includes:
- Schema: the export's Drizzle schema run into schema `otoapp` of the
  platform database through `search_path` (the app emits unqualified names;
  `ALTER ROLE oto_app SET search_path = otoapp`), from generated SQL
  migrations checked into the app's folder — never `drizzle-kit push`, never
  the reset scripts (both destroy a shared database; the api refuses to start
  if the app's `post-merge.sh` is present in the image). The `session` and
  `drizzle.__drizzle_migrations` tables follow the search path. Seed: the
  export's seed, structure-only; no production rows.
- Identity: `core.app_identity(app, account_id, external_user_id, created_by,
  created_at)`; `otoapp.users.platform_user_id` (unique, nullable) added by
  an additive migration; a provisioning service on the platform api
  (`POST /admin/apps/oto_app/users`) that creates the platform account if
  needed, grants `app:oto_app:access`, creates or links the `otoapp.users`
  row with the chosen OTO role, branch scope and tenant, and writes both
  audit rows (`app_identity.link`). Console/POS admin: an "Apps" tab on the
  account page listing linked app identities with link/unlink.
- Sign-on: one Express middleware before `passport.session()` that exchanges
  the launcher hand-off token (S2-02 contract) for an OTO App session by
  `platform_user_id` and calls `req.login()`; `getUserWithBranchAccess`
  keeps resolving role, branch scope and tenant, so no handler changes.
  Legacy Passport-local login stays behind `OTOAPP_LEGACY_LOGIN=true` (off on
  staging) for the cutover rehearsal only. Logout: the app's `/logout`
  revokes its own session and the launcher's "sign out everywhere" reaches it
  through a back-channel revoke list polled on session load. Kiosk bearer
  tokens and public tokens (parent portal, guest invites, signing links) stay
  outside the sign-on.
- Deploy: `render.yaml` Docker web service `oto-app` from the export's
  Dockerfile (2 GB, one instance, health `/api/status`, `TZ=UTC`,
  `LOG_RESPONSE_BODY=false`, cookie `secure` keyed on `NODE_ENV` instead of
  Replit variables, `trust proxy`), object storage pointed at the platform
  bucket (`S3_ENDPOINT` added to the four `S3Client` constructions),
  `replit_integrations` removed, `AI_INTEGRATIONS_*` renamed; new
  `SESSION_SECRET`, `SESSION_PEPPER`, `KIOSK_CODE_PEPPER`,
  `PIN_FINGERPRINT_SECRET` values (kiosks re-activate, check-in QR codes
  reprint); launcher tile switched from shell to the app's origin.
- Logging: the app's pino output carries `x-request-id` from the launcher
  hand-off onward and the same redaction list as `@oto/telemetry`; its
  `/api/status` is included in the platform watchdog and the Integrations
  page shows its variable presence flags.

Excludes: the modules' behaviour (unchanged), the contract features (S2-17c),
production data, face clock-in decision (Open decision 29), Xero live
credentials.

Acceptance criteria:
- [ ] `\dn` on the platform database lists `otoapp` with the export's tables
      and `otoapp.users.platform_user_id`; the platform migrations and the
      app's migrations both run twice cleanly from empty (dev evidence).
- [ ] A platform admin creates an account with OTO App access and role
      "branch manager, HKT Central" on the Console; the account appears in
      the OTO App's own user list with that role; Activity shows
      `app_identity.link`.
- [ ] That user opens the OTO App tile from the launcher and lands signed in
      with no second password; the OTO App's session row exists in
      `otoapp.session`; the same user cannot sign in with the legacy login
      form on staging.
- [ ] "Sign out everywhere" on the launcher ends the OTO App session on its
      next request.
- [ ] The OTO App's health is a row on Health; its environment variable
      presence flags are on Integrations; no secret value is ever logged
      (redaction test on the app's logger config).

QA / demo steps:
1. QA (UI): On the Console create the user; screenshot the Apps tab and the
   OTO App user list.
2. QA (UI): Sign in on the launcher as that user; open the OTO App tile;
   screenshot the landing without a second prompt; try the legacy login form;
   screenshot the refusal.
3. QA (UI): Sign out everywhere on the launcher; reload the OTO App;
   screenshot the sign-in prompt.
4. Dev evidence: migration logs (both migrators, twice) and the schema
   listing.

Depends on: S2-02, S2-03. Size: L.

#### S2-17b — The whole live OTO App lifted: every module working on Render against `otoapp`, POS seams

Includes:
- Every module in the intake's module map working against the central
  database: auth/users/permissions, org structure, HR employees, contracts
  and e-sign PDFs, templates, policies, letters, employee documents, assets,
  offboarding, kiosk devices and reception, kiosk clock (face/PIN/phone —
  see Open decision 29), timekeeping, scheduling, leave and holidays, tasks
  and ops board, checklists and media, announcements and notifications,
  SOP/KB/training, Ask OTO and AI helpers, fix reports and supplier portal,
  events core, BEO/packages/menus, parent portal and RSVP, camps and
  children, drop-off/nanny/public check-in, drop-off form builder, staff
  vouchers, casual workers, payroll, org chart, attention engine and activity
  log, Xero (sandbox), vault, directory API, data admin, files and settings.
- Object storage: the four `S3Client` constructions and the four local-disk
  writers on the platform bucket; PDF and media paths rewritten; Chromium
  for PDF rendering in the image (`sharp`, `ffmpeg` declared).
- Background work: the app's scheduled jobs (nightly departed-account
  deactivation, attention engine, finance sync) run under the platform job
  runner's advisory locks with `ops_run` rows, or inside the app with the
  same `ops_run` contract via the directory API — one of the two, recorded.
- POS seams: platform-owned views `otoapp_v.events`, `otoapp_v.employees`,
  `otoapp_v.children` read by the POS for the Events tab (later), staff
  benefits (C13) and the check-in ownership question; the OTO App's own
  check-in module and the POS check-in (S2-13) coexist on staging with the
  ownership decision recorded (Open decision 25).
- Cutover-compatibility: additive migrations only; a rehearsal script that
  restores a structure-only copy of the production dump into a scratch
  database, renames `public` to `otoapp` and loads it (intake §10 step 2),
  run in CI against the sample.
- Docs: `docs/features/oto-app.md` status per module (working / working with
  caveats / disabled on staging and why); `.env.example` block for the app.

Excludes: contract features (S2-17c); production data; real Twilio/LINE
sending (console adapters); Xero production; face recognition enrolment on
new infrastructure unless decision 29 says keep.

Acceptance criteria:
- [ ] A module walk-through script (one page per module in
      `docs/qa/SPRINT_2_ACCEPTANCE.md`) passes on staging for every module
      listed above, with screenshots; modules disabled on staging are named
      with the reason.
- [ ] Contract e-sign, letter e-sign and BEO PDFs render and are stored in
      the platform bucket with signed-URL access only (test).
- [ ] Two scheduled jobs are visible on Health with last-success times and a
      forced failure shows on Failures.
- [ ] The rehearsal restore script completes in CI and the row counts match
      the sample.
- [ ] The POS reads `otoapp_v.events` for the seeded events (dev evidence:
      test) without touching `otoapp` tables directly (grep test on the POS
      api).

QA / demo steps:
1. QA (UI): Run the module walk-through on staging; screenshot each module's
   main screen and one write action per module.
2. QA (UI): Sign a contract and a letter; screenshot the PDFs opening from
   signed URLs.
3. QA (UI): On Health, screenshot the OTO App jobs; force a failure with the
   test control; screenshot Failures.
4. Dev evidence: CI log of the rehearsal restore and the POS seam test.

Depends on: S2-17a. Size: XL.

#### S2-17c — Contract features from the agency proposal

Includes:
- One sub-task per OTO App item in `docs/briefs/AGENCY_PROPOSAL.md` §6
  (the POS items are covered by the POS tickets — see "Contract coverage"),
  each with the proposal's wording, our reading of "done", the module it
  lands in, and its own acceptance and QA steps; mirrored as Jira sub-tasks
  when the owner confirms the list (Open decision 30). The OTO App items as
  read today (§6.2):
  1. Missed/unscheduled attendance request with an attached photo or
     document, visible before submission.
  2. Live presence rows showing notification pending / delivered / failed.
  3. Employee spreadsheet import preview with New, Changed, Unchanged,
     Invalid and Matched statuses and per-row results.
  4. SOP articles with revision history, archive and restore.
  5. Fix routing with a preview of the staff who will receive matching
     reports.
  6. Camp registration: six-digit SMS code before a returning family's saved
     details are shown or changed (closes the children's-data exposure).
  7. Reviews and movements: explicit approval step and approved history
     (verify first; may already be met).
  The §6.13 benefit profiles are **not** here: S2-21 owns them end to end
  (role templates, person profiles, the benefit credential and the checkout
  application), reading the HR record this ticket mirrors. Item 6 above — the
  camp six-digit code — is an OTO App flow (`/camp-register/:eventId` and the
  unauthenticated camp-registration lookup at `routes.ts:15871-15915`), not a
  POS one; S2-20 only asserts that the POS never calls that lookup.
- Each feature built inside the lifted app in its module's style (Express
  route + React page), on the `otoapp` schema, audited through the app's
  activity log and the platform audit where it touches shared identities,
  with `ops_run` for anything that can fail silently.
- Advancements the owner asked for where cheap: central sign-on (done in
  S2-17a), platform file storage, platform logging and health (S2-17a/b), the
  Console's Activity page reading the app's activity log.

Excludes: anything the owner does not confirm as in the contract; features
that depend on paid third-party accounts not yet opened (recorded per item).

Acceptance criteria:
- [ ] Every confirmed §6 item has a merged sub-task with its acceptance
      criteria checked and a screenshot on staging.
- [ ] `docs/briefs/AGENCY_PROPOSAL.md` §2 assessment column reads "Built"
      for each confirmed item, with the route/page reference.

QA / demo steps:
1. QA (UI): For each sub-task, follow its QA steps on staging and attach the
   screenshot to the sub-task.

Depends on: S2-17b, Open decision 30. Size: L–XL (by the confirmed list).

### S2-18 — Radar live on the platform: `radar` schema, sign-on, per-branch source preference, seeded legacy figures, OTO POS analytics from the rollup

Feature area: Radar

Rules: PLATFORM_PLAN §5 (analytics continuity), OWNER_DIRECTION 2026-09-19 (analytics from our database plus Radar's history) and 2026-09-20 item 3; intake notes `03-radar-pisell-pipeline.md`, `04-radar-papaya-pipeline.md`, `05-radar-api-auth-env-schema.md`, `06-radar-frontend.md`.

Description. Radar (Express + React, 107 routes of which 96 are public, its
own Postgres on Replit; `imports/oto-radar/`) is the revenue dashboard the
client reads every day. It computes per-branch daily summaries from Pisell
(Floresta, formula v30) and Papaya (Chalong, formula v21). The owner wants it
active on the platform now with two sources per branch: the legacy figures
(seeded, because the Pisell/Papaya credentials are still in Replit Secrets)
and the real OTO POS analytics, so a demo sale on the staging POS shows up in
Radar when that branch prefers OTO POS. Revenue is defined exactly as Radar's
code defines it (Open decision 15, closed).

Includes:
- Lift: schema `radar` on the central database (restore of the structure
  listing; the real dump replaces it when it arrives, Open decision 18),
  Docker web service `radar` (`TZ=UTC`, `trust proxy`, `/healthz` added,
  Replit pieces removed, source maps off), the five push/import/wipe routes
  deleted, auth in front of every route except the public campaign/survey/
  redeem/report routes and the key-protected ones, sign-on through the
  launcher hand-off (same middleware pattern as S2-17a; `radar` has no user
  table, so the platform session is the identity and `app:radar:access`
  gates it), the staff-auth and seed-admin credentials rotated, Sentry DSN
  removed, the OpenAI key env names corrected (`routes.ts:2575`, `2843`).
- Source preference: `analytics.branch_source_switch` gains
  `preference` (`legacy` | `oto_pos` | `both`) editable on the Console
  (Integrations > Analytics sources) and on Radar's config tab; the dashboard,
  trends, calendar and cash-report queries take the branch's preference: for
  `oto_pos` they read `GET /analytics/summary` (S2-15b) through a small
  adapter module in Radar (`server/sources/otoPos.ts`), for `legacy` they
  read Radar's own tables, for `both` they show the two side by side with a
  parity delta.
- Legacy figures on staging: the Pisell and Papaya sync jobs run against
  **fixture adapters** (`FUNTOPIA_MODE=fixture`, `PAPAYA_MODE=fixture`) that
  replay two frozen months shaped like each pipeline's real responses (from
  the intake notes' shapes; no real data), producing daily summaries with
  the right `formula_version`; switching to live pulls is configuration when
  the credentials arrive.
- Rollup parity: a test computes one seeded day both ways (Radar's formula on
  a fixture, the platform rollup on the same sales expressed as POS facts)
  and asserts equality field by field; `formula_version` on every row.
- Freshness: the platform rollup (`job:rollup.daily`, hourly summariser)
  runs every 15 minutes on staging (`ROLLUP_INTERVAL_S`) and marks
  `dirty_date` on late syncs, so a demo sale reaches Radar within that
  interval; Health shows "Radar last refreshed".
- Booth feed: the wheel's spin/voucher rows come from the platform booth
  tables (S2-07) through the same summary contract instead of Radar's own
  `spinRewardsRoutes`; those routes and the `SPIN_WIN_REDEEM_KEY` that
  gates them are kept only until the legacy wheel URL is retired at cutover,
  then deleted.
- Docs: `docs/features/oto-radar.md` status; `.env.example` block.

Excludes: live Pisell/Papaya pulls on staging; the real Radar dump restore
(when it arrives); moving Radar's settings tables to the platform; the
Console analytics overview (Sprint 3); Radar UI changes beyond the source
switch and sign-on.

Acceptance criteria:
- [ ] The Radar tile opens Radar signed in through the launcher; an
      unauthenticated request to a dashboard route is refused; the public
      campaign, survey and redeem routes still work (test list).
- [ ] With HKT Central set to `oto_pos` and Demo Branch 2 to `legacy`, the
      dashboard shows the seeded legacy month for Demo Branch 2 and the
      platform rollup for HKT Central; a cash ticket sale on the staging POS
      appears in HKT Central's figures within `ROLLUP_INTERVAL_S` (QA times
      it); setting HKT Central to `both` shows the parity delta.
- [ ] The parity test passes (dev evidence) and every summary row carries
      `formula_version`.
- [ ] The fixture sync jobs appear on Health with last-success times; a
      forced failure shows on Failures; no Replit push/import/wipe route
      exists (route-enumeration test).
- [ ] The booth report in Radar reads the platform booth rows.

QA / demo steps:
1. QA (UI): Open Radar from the launcher; screenshot the dashboard for both
   branches; open a dashboard URL in a private window; screenshot the
   refusal.
2. QA (UI): Make a cash ticket sale on the POS; wait for the interval;
   screenshot the changed HKT Central figures; switch to `both`; screenshot
   the parity view.
3. QA (UI): On Health screenshot the fixture sync jobs and the "Radar last
   refreshed" row.
4. Dev evidence: the parity test and the route-enumeration test output.

Depends on: S2-15b, S2-17a (sign-on pattern). Size: L.

### S2-19 — Unified Inbox: the client's design working end to end on the `inbox` schema, with channel adapters ready for a real account

Feature area: Inbox

Rules: `docs/features/inbox.md` (briefs, design language, proposed placement); OWNER_DIRECTION 2026-09-20 item 4; PROJECT_CONTEXT §1 (messaging channels).

Description. The client's Replit prototype (`imports/oto-asset-manager/`,
front end on sample data) shows how the park wants one inbox for WhatsApp,
Instagram, Facebook and a web form, with an AI first responder, three
categories owned by four teams, a primary owner plus support assignees,
"handled" with confirmation and management dashboards. It is milestone 4; the
owner wants its data pillars in the central database now and a shell on the
launcher so the client sees it is part of the plan. No live channel is
connected this sprint.

Includes:
- Schema `inbox`: `channel_account`, `contact` (joined to `crm.member` by
  E.164 phone when known), `team`, `routing_rule`, `conversation`,
  `message` (direction, channel, body, media `file_object`, AI/human
  author), `participant`, `assignment` (primary/support, history),
  `template`, `tag`/`conversation_tag`, `sla_policy`, `event`
  (append-only), `webhook_receipt` (raw inbound, for replay) — columns and
  constraints as proposed in `docs/features/inbox.md`; permissions
  `inbox:conversation:{read,reply,assign,move,handle,reopen}`,
  `inbox:template:manage`, `inbox:channel:manage`, `inbox:dashboard:read`;
  retention/erasure fields for PDPA.
- Seed: the four teams, the three categories and routing rules from the IT
  Brief, ten example conversations (fictional) across the channels, templates
  and tags.
- `apps/inbox` static shell in the client's design language (Inter, white
  cards on slate, three-column workspace, six-metric dashboard, category
  colours) reading the seeded rows through `GET /inbox/*` read-only routes:
  list, thread view, assignment display, dashboard counts; every write action
  present but disabled with "coming with the channel connection"; launcher
  tile via `app:inbox:access`.
- Channel adapter interface `MessagingChannel` in `packages/contracts`
  (receive webhook, send, media fetch) with a console adapter only; the
  check-in flow's console adapter (S2-13) writes into `inbox.message` so
  outbound messages from the POS already appear in the shell.
- Docs: `docs/features/inbox.md` status; the brief conflicts listed there
  become Open decision 31.

Excludes: live WhatsApp/Instagram/Facebook/LINE connections, AI responder,
translation, audio, assignment logic execution, notifications (Sprint 3+).

Acceptance criteria:
- [ ] Migration adds the `inbox` schema (twice cleanly); permissions exist;
      seed loads the teams, rules and ten threads.
- [ ] The Inbox tile opens the shell signed in through the launcher; the
      three-column workspace lists the seeded threads by category, opens a
      thread, shows its assignment and the dashboard counts; write actions
      are visibly disabled with the message.
- [ ] A check-in confirmation sent from the POS (console adapter) appears as
      an outbound message in the matching contact's thread.
- [ ] Reads are audited (`inbox.conversation.read` category access, sampled)
      and the shell passes the phone-width check.

QA / demo steps:
1. QA (UI): Open the Inbox tile; screenshot the dashboard and a thread in
   each category; press a disabled action; screenshot the message.
2. QA (UI): Trigger a check-in confirmation on the POS; screenshot the
   thread showing it.
3. Dev evidence: migration log and the seed output.

Depends on: S2-02, S2-13 (for the console adapter link; the shell itself only on S2-03). Size: M.

### S2-20 — Events, parties and camps wired to the OTO App, and the self-service kiosk

Feature area: Events and kiosk

Rules: R-50, R-53, R-68, R-80, R-96 to R-100; conflicts C10 (events stay mastered by the OTO App), C11.

Description. The Events tab is the last wholly mock domain on the sell side:
`pages/Events.tsx` and `components/parties/*` read
`mockApi.ts:getEventsForDate`, `getEventById`, `getActiveEventPasses`,
`addEventAttendee`, `checkInEventAttendee`, `checkOutEventAttendee`,
`updateParty`, `addPartyExtraCharge` and `addPartyPayment`; the sell side runs
on `lib/eventPass.ts:sellEventPass`, `checkInSoldPass` and
`dispatchEventBracelets`, rosters on `lib/eventRoster.ts:bucketAttendee`,
`groupAttendees`, `computeRosterStats`, and tab arithmetic on
`lib/party.ts:computePartyTotal`, `computePartyOutstanding`. Conflict C10
settles ownership: the OTO App's events core, BEO, parent portal and camps
modules stay the master
(`docs/architecture/intake-2026-09-19/01-oto-app-backend.md` §2), so the POS
reads through the platform-owned views built in S2-17b (`otoapp_v.events`) and
writes attendance and passes back through the OTO App's service-to-service
directory API (`/api/directory/*`, intake §2), never by touching `otoapp`
tables. The same ticket builds the self-service kiosk
PROJECT_CONTEXT §7.6 requires — a device-credentialled surface on a box of its
own (station kind `kiosk`) reusing the S2-12 redemption service and the S2-06
print pipeline, so there is one redemption implementation and two surfaces.

Includes:
- Read seam: `otoapp_v.events` extended in S2-17b with the attendee and
  per-day attendance columns the prototype's `OtoEvent` / `EventAttendee`
  shapes need (`types.ts:1414-1500`), exposed as `GET /events?date=&branchId=
  &type=`, `GET /events/:id`, `GET /events/passes?date=&branchId=` and
  `GET /events/:id/roster?date=` — ports of `getEventsForDate`, `getEventById`,
  `getActiveEventPasses` and the `eventRoster.ts` bucketing, with the party
  exclusion on the passes list preserved (parties have no flat entry price).
  A read-only repository module is the only place the views are queried.
- Tables (`pos`): `event_attendee_link` (operator, branch, `otoapp_event_id`,
  `otoapp_attendee_id`, event_type party|camp|event, `crm.child_id`,
  `crm.member_id`, sale, sale_line, parent_attending, attendance_days date[],
  price_snapshot_satang, source till|booking|kiosk|otoapp, account, station,
  box, created_at, archived_at; `UNIQUE(otoapp_event_id, otoapp_attendee_id)`)
  — the C10 link from an OTO App attendee to a `crm` child or member;
  `event_checkin` (link, attendance_date, checked_in_at, checked_out_at,
  kid_band_id, parent_band_id, account, station, box, origin, box_seq;
  `UNIQUE(link_id, attendance_date)`) — the duplicate-prevention rule (R-97,
  proposal §2.3 "duplicate same-day check-in blocked"); `event_drop_in_pricing`
  (branch, camp_day, event_day, party_guest, each a weekday/weekend satang
  pair) ported from `types.ts:EventDropInPricing` and
  `mockApi.ts:getEventDropInPricing`/`updateEventDropInPricing`; `party_tab`
  (branch, `otoapp_event_id`, status, base_price, line_items snapshot, deposit,
  deposit_paid_at, locked_at), `party_charge` (tab, kind ticket|fnb, items
  jsonb, total, sale, account, at) and `party_payment` (tab, method token,
  amount, sale, payment_attempt, account, taken_at) — the POS-owned ledgers the
  prototype already keeps separate from the Events-owned party record;
  `kiosk_session` (station, device_credential, started_at, ended_at, booking,
  outcome issued|handed_off|failed|abandoned, reason).
- Write-back through the directory API, extended in S2-17b with
  `POST /api/directory/events/:id/attendees` and
  `POST /api/directory/events/:id/attendees/:attendeeId/checkins` behind
  `X-HR-API-KEY`: the POS routes `POST /events/:id/attendees` (R-99, port of
  `addEventAttendee` including the walk-up operator stamp and the camp
  "register for the full range" vs "today only" `attendanceDays` rule),
  `POST /events/:id/attendees/:attendeeId/checkin`,
  `POST /events/:id/attendees/:attendeeId/checkout`. Each write is one
  `withTx` service: mirror row first, directory call second, `ops_run`
  kind `integration` under action id `otoapp:attendee.create` /
  `otoapp:attendee.checkin`, retryable from Failures; a failed write-back
  leaves the POS row with `sync_state=pending` and the roster shows it, never a
  silent divergence. All calls carry the client-minted UUIDv7 so a retry is a
  replay, not a second attendee.
- Flat-price pass sale, `POST /events/:id/passes` — the port of
  `lib/eventPass.ts:sellEventPass` with its invariants intact: price is the
  event's flat `entryPriceTHB` resolved by the S2-09a rate-mode and
  business-date engine (never tiered, R-98); a paid pass on a camp or event
  requires a tender and creates nothing without one (no unpaid roster entry); a
  free event (price 0) creates the attendee with no sale; a birthday walk-up
  appends `party_charge` at `event_drop_in_pricing.party_guest` and takes no
  door payment. The sale is an ordinary S2-09a/S2-10a sale with a synthetic
  one-kid line (`svc-camp-pass` / `svc-event-pass`), `revenue_category=events`
  and no credit grant, so tax, receipt and reporting need no special case.
  `components/till/EventPassCard.tsx` and
  `components/till/DoorCheckInChoiceModal.tsx` keep their design: the pass is
  persisted before the "check in now / leave booked" choice, so dismissing the
  choice can never undo a completed payment.
- Event check-in with band rules: no supervision gate (R-97) — the S2-13 gate
  is suppressed for pass lines and event check-ins, and a test asserts it;
  bands minted and signed by the S2-11 band service and printed through the
  S2-06 pipeline from `lib/printRouting.tsx:eventBraceletPrintJobs`; a kid band
  always, a parent band only when `parentAttending`; the band carries event
  title, date, dietary and allergy flags per R-50 and fires the F&B allergy
  alert through the existing band lookup (R-68); camps check in per selected
  day. Check-in and check-out are box facts so they queue offline.
- Party tab: `GET /parties/:id`, `POST /parties/:id/charges`,
  `POST /parties/:id/payments`, `PATCH /parties/:id` (only the POS-editable
  fields `mockApi.ts:updateParty` already allows, written back through the
  directory API). Deposit and balance follow `lib/party.ts`; party payments run
  through the S2-10a tender machine and keep their own `party_prepay`
  end-of-day channel (S2-15a), so a prepayment is never folded into cash or
  card. `components/parties/PartyDetail.tsx`, `PartyBalanceModal.tsx`,
  `PartyTicketModal.tsx`, `PartyFnbModal.tsx`, `AddAttendeeModal.tsx`,
  `EventAttendeeList.tsx` and `PartySettlementCustomerScreen.tsx` are wired
  unchanged.
- Self-service kiosk: a new `/kiosk` route in `apps/pos` in the prototype's
  design language (the redemption steps reuse
  `components/till/RedeemBookingModal.tsx` and `components/shared/*`), running
  full-screen on a box with `box.role=kiosk` and a `core.device_credential`
  kind `kiosk` paired from Console > Devices (S2-04); `POST /kiosk/v1/session`,
  `POST /kiosk/v1/redeem`, `GET /kiosk/v1/state`. Redemption calls the same
  service as the till (S2-12) with `surface='kiosk'`: this branch, paid,
  unredeemed, signature valid, local redemption log checked, bands and wallet
  credit issued exactly once. Supervised-child cases are never issued at the
  kiosk — the booking's drop-off and nanny items route to staff (R-80) and the
  screen shows the staff desk. A mixed booking issues the self-service items
  and shows the desk for the rest. Hand-off is recorded only after the
  self-service half is actually issued and printed: a printer fault, paper-out
  or offline box aborts the whole redemption, leaves the booking unredeemed and
  writes `kiosk_session.outcome='failed'` with the reason — never a false
  hand-off. Idle timeout returns to the attract screen and abandons the
  session; nothing on the kiosk shows allergy, medical or contact data (R-58).
- Admin and Console: a new "Events" panel under Operations in the prototype's
  admin shell (`components/admin/adminSections.tsx`) holding drop-in pricing
  (`GET/PUT /branches/:branchId/event-drop-in-pricing`) and the read-only event
  list with its write-back health; Console > Devices gains the kiosk pairing
  code and a "Kiosk" tile on Health (online, printer, paper, last redemption,
  abandoned-session count).
- Permissions: `pos:event:read`, `pos:event:attendee_create`,
  `pos:event:pass_sell`, `pos:event:checkin`, `pos:party:charge`,
  `pos:party:payment`, `admin:event_pricing:manage`; `pos:kiosk:redeem` is
  carried by the kiosk device credential's scope, not by a staff account, and a
  test asserts no human role holds it.
- Audit and `ops_run`: audit actions `event.attendee_create`,
  `event.pass_sell`, `event.checkin`, `event.checkout`, `party.charge`,
  `party.payment`, `event_pricing.update`, `kiosk.redeem`, `kiosk.handoff`,
  `kiosk.abort`, each stamped with station and box ids; `ops_run` kind
  `integration` per directory call, kind `device` for the kiosk print, and
  `job:events.cache_refresh` refreshing the box's today's-events bundle with an
  `ops_expectation` so a stale bundle raises an alert.
- Seed and simulators: `seed:demo-day` gains, written into `otoapp` through the
  OTO App's own tables so the views return them, one five-day camp spanning the
  seeded business date with six registered attendees (two allergy-flagged, one
  `parentAttending`), one one-off event today with a weekday/weekend
  `entryPriceTHB` pair, and one birthday party with a package base price, a paid
  deposit and an open tab; branch drop-in pricing seeded from the prototype
  values. The Simulators panel gains the kiosk box with its scanner and band
  printer and controls "printer offline", "paper out" and "box offline".
- The camp registration six-digit SMS code from proposal §6.2 is **not** built
  here: it belongs to the OTO App's public camp-registration flow
  (`/camp-register/:eventId`, `client/src/pages/public/camp-register.tsx:449`,
  and the unauthenticated `GET /api/public/camp-registrations/lookup`,
  `server/routes.ts:15871-15915`, intake §11 finding 2), so it is S2-17c item 6.
  This ticket depends on it only in that the POS never calls that lookup — the
  camp roster reads `otoapp_v.events` behind a permission — and the acceptance
  run links to the S2-17c evidence.

Excludes: event creation, registration and BEO in the OTO App (S2-17b/c); the
camp six-digit SMS gate itself (S2-17c item 6); booking payment, booking QR and
the gate (S2-12); supervision, consent and the drop-off board (S2-13); wallets
and their expiry (S2-14a); staff benefits (S2-21); real kiosk hardware (S2-24).

Acceptance criteria:
- [ ] The Events tab for the seeded business date lists the camp, the one-off
      event and the birthday party read from `otoapp_v.events`; the camp roster
      shows per-day checked-in, outstanding and not-today counts, and the
      Console shows no `otoapp` table access from the POS API.
- [ ] Selling a pass for the seeded event takes a tender and creates the
      attendee on the OTO App's own event screen; cancelling at the payment
      step creates no attendee and no sale; the seeded free event creates the
      attendee with no sale; a birthday walk-up adds a party-guest charge to the
      tab and takes no door payment.
- [ ] The party tab shows base price, deposit, POS charges and payments with
      the outstanding balance; adding an F&B charge and taking a card payment
      updates the balance, and the payment appears in End of Day under
      `party_prepay`, not under card.
- [ ] Checking in a camp attendee prints a kid band, and a parent band when the
      parent is attending, both carrying the event title, date and dietary or
      allergy flag; checking the same attendee in again the same day is refused
      with "already checked in"; checking in the next camp day succeeds; no
      supervision gate appears at any point.
- [ ] At the kiosk, a paid unredeemed booking for this branch issues its bands
      and wallet credit once and prints them; scanning it again shows
      already-redeemed; a booking containing a drop-off child issues nothing and
      shows the staff desk; a mixed booking issues the regular bands and shows
      the desk for the rest.
- [ ] With the kiosk printer forced offline the same redemption aborts: the
      booking stays paid and unredeemed, the screen tells the guest to see the
      staff desk, no hand-off is recorded, and the till can still redeem it.
- [ ] Every action above has an Activity row with station and box ids (spot
      check `event.pass_sell`, `event.checkin`, `party.payment`,
      `kiosk.redeem`), and each write-back has an `ops_run` row under
      `otoapp:attendee.*` that can be retried from Failures after a forced
      failure.

QA / demo steps:
1. QA (UI): Open the Events tab on the seeded business date; screenshot the
   three events, then the camp roster with its per-day counts; open the same
   camp in the OTO App and screenshot the matching roster.
2. QA (UI): Sell an event pass with cash and screenshot the sale, the new
   attendee on both systems and the receipt; repeat and cancel at payment;
   screenshot the unchanged roster; sell a free-event pass; add a walk-up guest
   to the birthday party and screenshot the tab.
3. QA (UI): On the party, add an F&B charge and take a card payment; screenshot
   the balance and the End of Day `party_prepay` line.
4. QA (UI): Check a camp attendee in; screenshot the printed kid and parent
   bands in the printer simulator; check in again and screenshot the refusal;
   advance to the next camp day and screenshot the successful check-in.
5. QA (UI): At the kiosk, scan the seeded paid booking; screenshot the bands,
   the wallet credit and the redeemed booking; scan again; scan the supervised
   booking and screenshot the staff-desk screen; scan the mixed booking.
6. QA (UI): Set the kiosk printer offline in the Simulators panel; scan a paid
   booking; screenshot the abort message, the still-unpaid-out booking and the
   `kiosk_session` outcome on Activity; force a directory write-back failure and
   screenshot the retry on Failures.
7. Dev evidence: test output for the no-supervision-gate rule on event lines,
   the duplicate same-day check-in constraint, and the grep test asserting the
   POS API reads events only through `otoapp_v.*` and the directory API.

Depends on: S2-11, S2-12, S2-17b. Size: XL.

### S2-21 — Staff benefits: HR-linked profiles and benefit application at checkout

Feature area: Staff benefits

Rules: R-70, R-107 to R-110, R-64; conflict C13 (the employee master stays in the OTO App; the profile hangs off the mirrored HR record and the badge credential is issued by the platform).

Description. The prototype already carries the whole benefit engine, and it is
pure: `lib/benefits.ts:applyStaffBenefits` applies comp, then periodic free
items, then periodic credit, then the standing percentage, with
`resolveEffectiveBenefitProfile`, `benefitPeriodKey`, `isEmptyBenefitProfile`
and `emptyBenefitUsage` beside it, wired through
`mockApi.ts:findOperatorByBenefitQrCode`, `getEffectiveBenefitProfile`,
`getBenefitUsage`, `previewStaffBenefit`, `commitStaffBenefit`,
`attachBenefitAuditOrderId`, `updateOperatorBenefits` and
`getRoleBenefitTemplate`/`setRoleBenefitTemplate`, with the UI in
`components/fnb/BenefitScanModal.tsx`,
`components/fnb/StaffBenefitBreakdown.tsx` and
`components/admin/staff-benefits/*` (`StaffBenefitsPanel`,
`BenefitProfileFields`, `OperatorOverrideDialog`, `BenefitQrDialog`). Everything
it holds — quotas, credit pools, the audit log — dies on reload, and the profile
hangs off a mock `Operator`. Conflict C13 fixes the shape: employees are
mastered in the OTO App, so the profile is keyed to the employee mirrored into
`core.employee` from `otoapp_v.employees` (S2-17b), the benefit QR is a
platform-issued badge credential and never a password or PIN, and usage and
audit live on the platform. This ticket persists the profiles with effective
dates and person-override-wins, mints and verifies the credential, applies
benefits inside the S2-09a/S2-09b checkout with server-authoritative period
resets and a concurrency-safe last use, and feeds the reporting that separates
benefit cost from revenue (proposal §6.13).

Includes:
- Tables (`promo`): `benefit_role_template` (operator, role owner|manager|staff,
  name, profile jsonb — `comp` / `free_items[]` / `credit` /
  `standing_discount`, each targeted by the existing `DiscountTarget` shape so
  there is no parallel scoping system, `types.ts:254`, `types.ts:469-510`,
  effective_from, effective_to, updated_by, updated_at); `benefit_profile`
  (operator, `core.employee_id`, role, profile jsonb holding only the
  primitives overridden, effective_from, effective_to, archived_at, created_by)
  — a person override replaces a primitive wholesale, never field by field
  (R-109); `benefit_credential` (employee, `code_hash`, key id, signature
  version, issued_by, issued_at, expires_at, revoked_at, last_seen_at);
  `benefit_usage` (profile, employee, period_kind daily|monthly, period_key text
  from `benefitPeriodKey`, benefit_item_id, qty_used, credit_used_satang,
  version; `UNIQUE(employee_id, benefit_item_id, period_key)`);
  `benefit_application` (sale, sale_line refs, beneficiary employee, profile
  snapshot jsonb, processed_by_account, station, box, is_comp, comped,
  free_items, credit and discount satang, total_relief_satang, occurred_at,
  reversed_by_refund) — the persisted form of `types.ts:BenefitAuditEntry` and
  `attachBenefitAuditOrderId`. `analytics.fact_benefit_daily` for the report.
- Profiles and effective dates: `GET /benefits/templates`,
  `PUT /benefits/templates/:role` (port of `getRoleBenefitTemplates` /
  `setRoleBenefitTemplate`), `GET /benefits/profiles?employeeId=`,
  `PUT /benefits/profiles/:employeeId` (port of `updateOperatorBenefits`),
  `GET /benefits/profiles/:employeeId/effective?on=` returning the resolved
  profile exactly as `resolveEffectiveBenefitProfile` does. The effective
  profile at any instant is the role template in force on that date with the
  person override in force on that date applied over it; a future-dated edit
  never changes today's checkout, and history is kept by closing the previous
  row's `effective_to` rather than updating it in place. Employees come from
  `otoapp_v.employees`; the panel never creates or edits an employee, and a
  scan for an employee not yet mirrored raises `ops_run` kind `integration`
  under `otoapp:employee.sync` and refuses the benefit.
- Benefit QR: minted in the cloud by `POST /benefits/credentials` as
  `OTO-BEN:v1:<employeeId>:<credentialId>:<exp>` plus an Ed25519 signature over
  that payload; the private half stays in the API, the public half reaches every
  box in the config bundle through `core.signing_key` (S2-04), the same shape as
  the signed booking QR and band HMAC (PROJECT_CONTEXT §8).
  `POST /benefits/credentials/:id/revoke` revokes; the revocation list ships in
  the box cache bundle and is checked on every scan. `GET
  /benefits/credentials/:id/qr` returns the printable payload behind the
  existing `BenefitQrDialog`. Verification happens on the box's scanning service
  (S2-06) against the cached public key, so a scan resolves the beneficiary
  offline; `POST /benefits/resolve` is the online equivalent and returns the
  effective profile with the remaining quota. The credential grants no access
  and opens no session — a test asserts a benefit payload is rejected by
  sign-in and by the gate reader.
- Application at checkout: `POST /sales/:saleId/benefit/preview` (port of
  `previewStaffBenefit`) and `POST /sales/:saleId/benefit/apply` (port of
  `commitStaffBenefit`), with `DELETE /sales/:saleId/benefit` before
  finalisation. The engine moves to `packages/shared` unchanged so box and
  cloud compute the same relief, and the canonical order is preserved: comp
  short-circuits the whole bill, then free items consume quota line by line
  capped by what each line's remaining value can fund, then the credit pool,
  then the standing percentage against whatever is left. Relief is written as
  discount-class allocations on `sale_line`, never as a tender, so the S2-09a
  order holds: benefit relief first, then the sale's own manual discount, then
  promo vouchers sequentially against the running balance, then tax with the
  branch's inclusive unwind and discount placement, so receipt and VAT export
  reconcile to the satang (R-36). A free-item benefit uses the same synthetic
  ฿0 line plus offsetting discount that a free-item promo uses. Scope: R-70 and
  the prototype restrict benefits to the F&B station while proposal §6.13 says
  "at checkout"; both hold without a new mechanism because every primitive is
  already scoped by `DiscountTarget` — the seeded profiles target `fnb`, so
  behaviour is unchanged, and a profile targeting `everything` also reaches the
  ticket till. Whether any seeded role should target `everything` is an owner
  question and is listed as such, not decided here.
- Wallets stay untouched: the staff credit pool is `benefit_usage`, not a
  `pos.wallet`, so no wallet entry is written and wallet liability does not
  move; a guest wallet (S2-14a) remains a tender applied after tax to whatever
  the benefit left. Benefit relief is foregone revenue, reported beside promos
  and comps and never as wallet spend (R-64).
- Concurrency and period resets: the last free item or the last satang of
  credit is claimed with a single conditional update
  (`UPDATE … SET qty_used = qty_used + :n WHERE qty_used + :n <= :quota AND
  version = :version`) inside the sale's `withTx`, so two simultaneous
  attempts yield exactly one success and one `BENEFIT_QUOTA_EXHAUSTED`; the
  application is idempotent on the client-minted id. Periods roll over by
  `period_key`, so no reset job is needed to make a new day valid;
  `job:benefit.period_rollover` runs at the branch day start only to write the
  `fact_benefit_daily` row and close the previous period, with an
  `ops_expectation` on Health.
- Offline: comp and the standing percentage apply offline — they carry no quota
  — and queue as box facts. Free items and periodic credit are quota-bearing
  single-use value and follow R-48 exactly as wallet spend does: online only,
  with the S2-14a "online only" message on the breakdown, nothing consumed. The
  offline capability matrix (S2-05) records this.
- Reporting: `GET /reports/benefits` (branch, date range, beneficiary, role)
  feeding the prototype's Admin > Reporting > Discounts & Comps panel with the
  relief split by comp, free items, credit and standing discount, and the
  beneficiary, processing operator and sale on every row; the S2-15b sales
  report keeps benefit cost out of revenue and out of wallet liability. A
  refund of a benefited sale writes a `benefit.reverse` row, returns the
  consumed quota to the period and reverses the allocation.
- Permissions: `pos:benefit:apply`, `pos:benefit:comp` (a whole-bill comp needs
  its own permission and its own audit class), `admin:benefit:read`,
  `admin:benefit:manage` (templates, profiles, effective dates),
  `admin:benefit:credential_issue` (mint and revoke the badge). Seeded onto
  `reception`/`staff` (apply only), `branch_manager` (apply, comp, read) and
  `operator_admin` (all).
- Audit and `ops_run`: `benefit.template_update`, `benefit.profile_update`,
  `benefit.credential_issue`, `benefit.credential_revoke`, `benefit.apply`,
  `benefit.comp`, `benefit.reverse`, each with the beneficiary, the processing
  operator, station and box; `benefit.comp` is classified sensitive so it
  appears on the Activity "Admin log" preset and in the daily comp alert.
- Seed: role templates per BL §15 — Owner unlimited comp; Manager ฿5,000
  monthly F&B credit, then 30 % off F&B, plus 2 daily coffees; Staff 2 daily
  coffees plus 30 % off F&B — attached to four employees mirrored from
  `otoapp_v.employees` matching the prototype's `mockOperators` (Som and Nok
  reception, Khun Lek manager, Khun Anan owner), each with an issued benefit
  credential whose QR is scannable in the scanner simulator; Nok carries a
  person override of 4 daily coffees to prove override-wins, and one
  future-dated Manager template edit is seeded to prove effective dates.

Excludes: the OTO App's own HR screens and staff vouchers (S2-17b); tier and
member discounts (S2-09a); promotional vouchers and guest wallets (S2-14a);
the booth voucher path (S2-07a/S2-10b); face or biometric staff identification
(PROJECT_CONTEXT §13).

Acceptance criteria:
- [ ] Admin > Staff Benefits lists the three seeded role templates and the four
      employees read from the mirrored HR record; the panel cannot create or
      edit an employee; Nok's profile card shows 4 daily coffees from her person
      override while the Staff template still reads 2.
- [ ] Editing the Manager credit to ฿6,000 with an effective date of tomorrow
      leaves a Manager checkout today at ฿5,000, shows both rows in the profile
      history, and is audited as `benefit.profile_update`.
- [ ] Scanning Khun Anan's QR on an F&B order comps it to ฿0; the receipt, the
      till breakdown and the Activity row show beneficiary, processing operator,
      sale and comped amount; reception without `pos:benefit:comp` gets a clear
      refusal; a revoked credential is refused with "benefit revoked" and
      changes nothing.
- [ ] Scanning Khun Lek's QR on a mixed F&B order applies, in that order, the
      2 daily coffees, the monthly credit and 30 % off the remainder; the
      breakdown on the till and the customer display agree with the receipt to
      the satang; scanning again for a third coffee the same day shows the
      quota exhausted and still gives the 30 %.
- [ ] Applying a benefit does not move any wallet balance: the Wallet & Promo
      report is unchanged for the day, while Discounts & Comps shows the relief
      split by comp, free items, credit and standing discount; refunding the
      benefited sale returns the quota and shows the reversal.
- [ ] With the box offline, comp and the standing percentage still apply and
      sync once on reconnect; the free-item and credit stages show "online only"
      and consume nothing; a benefit QR is refused at sign-in and at the gate
      reader.
- [ ] Two tills claiming the last free coffee at the same instant produce one
      success, one `BENEFIT_QUOTA_EXHAUSTED` and exactly one usage row (dev
      evidence: concurrency test).

QA / demo steps:
1. QA (UI): Open Admin > Staff Benefits; screenshot the three templates and the
   four mirrored employees; screenshot Nok's override card beside the Staff
   template; try to rename an employee and screenshot the read-only field.
2. QA (UI): Edit the Manager credit with tomorrow's effective date; screenshot
   the history; run a Manager checkout and screenshot the unchanged ฿5,000
   credit and the Activity row.
3. QA (UI): Build a ฿1,200 F&B order; scan Khun Lek's QR from the scanner
   simulator; screenshot the four-stage breakdown, the customer display and the
   receipt; scan again for a third coffee and screenshot the exhausted quota.
4. QA (UI): Scan Khun Anan's QR on a new order; screenshot the ฿0 total, the
   receipt and the sensitive Activity row; sign in as reception and repeat;
   screenshot the refusal; revoke the credential and screenshot the rejection.
5. QA (UI): Open Reporting > Wallet & Promo and Discounts & Comps; screenshot
   both for the day; refund the benefited order and screenshot the reversal and
   the restored quota.
6. QA (UI): Toggle the box offline; scan the Owner QR and screenshot the comp;
   scan the Manager QR and screenshot the "online only" message on the
   free-item and credit stages; reconnect and screenshot the synced application.
7. Dev evidence: concurrency test output for the last free item and the last
   satang of credit, and the test asserting a benefit payload is rejected by
   sign-in and by the gate reader.

Depends on: S2-09b, S2-10a, S2-17b. Size: L.

### S2-22 — The client's own data: production restore into the central database, platform seeding from it, Radar on real figures, cutover rehearsal

Feature area: Data and cutover

Rules: R-94 (access log on child health reads); OWNER_DIRECTION 2026-09-20 (later), "Start from the real production data"; PLATFORM_PLAN §13 (cutover stages A and B) and §14 (owner inputs; decision 8, seeding members from check-in history); PROJECT_CONTEXT §12 (a repeatable migration run from a restore, never against production, reconciled until two runs match); intake notes `docs/architecture/intake-2026-09-19/01-oto-app-backend.md` §7 (schema shape and drift), §8 (POS and revenue touchpoints), §9 (biometrics), §10 (restore recipe, load order, hash import) and `05-radar-api-auth-env-schema.md` §9; `imports/_db/README.md`.

Description. The dump we hold is
`imports/_db/db-structure-with-data-dump-for-oto-app.sql`: 33 MB of live
production rows, exported by Navicat as plain `INSERT`s that hard-code
`"public".` in every statement. The owner's direction is to start from it, so
the client opens the suite and sees the branches, staff and figures he
recognises. This ticket turns that one-off into a scripted, repeatable
procedure — scratch database, schema rename, load order, sequence check,
post-import fixes, verification counts — run against the private staging
database; seeds the platform's own tables from the rows where identity is
genuinely shared; gives Radar real figures in place of S2-18's fixtures; and
rehearses the cutover against a fresh dump until two timed runs agree. The
data is real staff, children's and customer data, so the handling section is
part of the ticket, not a footnote. Where the OTO App has no source table —
members and children — the derivation is built but left in preview until the
owner answers PLATFORM_PLAN §14 decision 8.

Includes:
- Restore procedure, one command (`pnpm data:restore` →
  `tools/data/restore-otoapp.ts`), every step timed and recorded in
  `ops_import_run` / `ops_import_step` beside the existing `ops_run`: (1)
  refuse to run unless `DATA_CLASSIFICATION=production`,
  `NODE_ENV != production` and the outbound checks below pass; (2) create the
  scratch database `otoapp_scratch_<utc>` on the same server; (3)
  `psql -v ON_ERROR_STOP=1 -f $OTOAPP_DUMP_PATH` into it; (4)
  `ALTER SCHEMA public RENAME TO otoapp` — this is why the scratch step exists,
  the Navicat file hard-codes `"public".` (intake §10 item 2); (5)
  `pg_dump -Fc -n otoapp` into `$RESTORE_WORK_DIR`, outside the repository; (6)
  on the platform database, behind a typed confirmation,
  `DROP SCHEMA IF EXISTS otoapp CASCADE` then
  `pg_restore --no-owner --no-privileges -j4`; (7) the post-import script; (8)
  verification; (9) drop the scratch database; (10) write the run report.
- Load order: the whole-schema path restores structure and data together and
  needs no ordering, but the top-up path — a fresh dump's rows into an
  existing structure, and the rehearsal's second pass — uses the
  foreign-key-safe table order already written in
  `imports/oto-app/server/prod-sync.ts:7+`, captured as
  `tools/data/otoapp-load-order.json` with a test that re-derives the order
  from the restored schema's 519 foreign keys and fails when the file has
  drifted from it.
- Post-import (`tools/data/postimport-otoapp.sql`, re-runnable): add the four
  composite primary keys the app's invalid Drizzle syntax never created —
  `xero_tracking_categories`, `xero_tracking_options`, `cash_txns`,
  `cash_daily` — and a unique index on `pl_facts`, without which Finance
  Sync's `ON CONFLICT` upserts fail at runtime (intake §7, Drift); keep the
  restored `drizzle.__drizzle_migrations` rows so the app's own migrator does
  not try to re-create what the dump already holds; re-apply the platform's
  additive migrations on top (`otoapp.users.platform_user_id`, unique and
  nullable, plus anything else S2-17a/b added); `ALTER ROLE oto_app SET
  search_path = otoapp`; grants — `oto_app` owns `otoapp`, and the platform
  api role gets `USAGE` plus `SELECT` on the `otoapp_v.*` seam views only,
  never on the tables; and a file-reference prefix census (`/api/files/`,
  `/objects/`, `/uploads/`, `uploads/employee-documents/`, `/<bucket>/`)
  written into the run report, so broken media links are known before anyone
  clicks one.
- Sequences: the export declares none — no extensions, sequences, functions,
  triggers or views, and ids are `gen_random_uuid()` or varchar UUIDs (intake
  §7) — so the step asserts
  `SELECT count(*) FROM information_schema.sequences WHERE
  sequence_schema = 'otoapp'` is zero and **fails loudly** if a later dump
  introduces one, rather than silently skipping a reset that would by then be
  needed.
- Verification (`pnpm data:verify` → `tools/data/verify-restore.ts`), its
  output shown on Console > Data > Imports: per-table row counts compared
  across the dump's own `INSERT` counts, the scratch database and the target
  for all 184 tables; the structural counts from intake §7 asserted (184
  tables, 65 enums, 179 primary keys, 519 foreign keys, 370 indexes, 27 unique
  constraints, plus the five constraints the post-import script adds); a
  per-table content checksum over a stable key ordering; and ten spot-check
  records compared field by field, reported as hashes and "same / differs" so
  that no person's data is printed.
- Platform seeding (`pnpm data:seed-platform` →
  `tools/data/seed-platform-from-otoapp.ts`), idempotent, every row recorded in
  `core.import_map(run_id, source_app, source_table, source_id, target_schema,
  target_table, target_id)` so a second run updates instead of duplicating, and
  every write audited with `category = 'data_import'`. The mapping, source to
  target:
  - `otoapp.tenants` + `otoapp.operators` → `core.operator`, one per
    `operators` row, `tenants.slug` kept as `external_ref`. Certain.
  - `otoapp.branches` → `core.branch`: name, address, `timezone` (the source
    defaults to Asia/Bangkok). Certain except `branch.code`, for which the OTO
    App has no column — generated from the name and listed in the report for
    the owner to rename.
  - `otoapp.departments` → `core.department`: tenant-wide in the source, so
    `branch_id` stays null. Certain.
  - `otoapp.employees` joined to `otoapp.people` on `employees.person_id`
    (unique) → `core.employee`: `thai_name`, `nickname`, phones normalised to
    E.164, `primary_department_id`, `branch_id`, and `employment_state`
    (ACTIVE / LEAVING / LEFT) → `employee.status`. `employees.email` is **not**
    unique in the source, so duplicate addresses are listed in the report and
    never merged. Certain.
  - `otoapp.users` → `core.account`: `phone_e164` (unique in the source) is the
    platform's sign-in identity; `is_active` → status and
    `must_change_password` carried; the scrypt `password` imported verbatim
    behind a scheme prefix (`scrypt$…`) so an existing password keeps working
    beside argon2id (intake §10 item 6), the verifier picking the scheme from
    the prefix and re-hashing to argon2id on the next successful sign-in. A
    user with no `phone_e164` cannot have a platform account: listed as "needs
    a phone before sign-on", never invented. Certain.
  - one `core.app_identity(app = 'oto_app', account_id, external_user_id =
    users.id)` per imported user, with `otoapp.users.platform_user_id` written
    back — exactly what S2-17a's hand-off middleware resolves on.
    `otoapp.users.id` is never rewritten: 127 foreign keys reference it.
  - `otoapp.access_policies` (`access_level` STAFF / MANAGER / ADMIN,
    `modules`, `branch_scope`, `branch_ids`), `user_branch_access` and
    `user_module_overrides` → `core.role_assignment`, through a declared
    `tools/data/role-map.json` naming every source value and the platform role
    and scope it becomes. Nothing is inferred: a source value missing from the
    map fails the run. **Needs the owner's yes** before the seeded assignments
    are treated as live.
  - **Members and children have no source table.** Intake §8 is explicit: the
    OTO App has no customers, members or children table, and a "child" is
    `(lower(child_full_name), emergency_contact_number)` deduplicated over
    `camp_registrations` (`imports/oto-app/server/routes.ts:16605-16668`). So
    `crm.member` and `crm.child` are **derived**, not copied, from
    `camp_registrations` (child name, date of birth, allergies, behavioural
    notes, guardian and pickup persons), `dropoff_checkins.children` (jsonb),
    `service_checkins`, `nanny_reservations`, `core_events` (`child_name`,
    `parent_name`, WhatsApp phone) and `studio_event_bookings`. Governed by
    `MEMBER_SEED_FROM_CHECKIN_HISTORY = off | preview | apply`, default
    `preview`: the preview writes a report — candidate members, phone-collision
    groups, records with no usable phone, children recovered with and without
    allergies — and writes no rows. This is PLATFORM_PLAN §14 decision 8 and it
    is still open; the preview is this ticket's deliverable and `apply` is one
    command afterwards.
  - Guardians and authorised pickups, from `camp_registrations` pickup persons
    and `service_checkins` consent records, map to the guardian tables S2-13
    creates — but **the consent basis for re-using them in the POS is not
    determined by any source we hold**, so it is raised as a question, seeded
    only under `apply`, and never with the source's stored photos.
  - Not seeded, and listed as such in the report: payroll, leave, contracts,
    tasks, Xero and vault rows stay only in `otoapp`, which owns them;
    `otoapp.session` is not imported, so everybody signs in again; and the
    vault's plaintext passwords (intake §11 item 5) are excluded from every
    query, export and report, with the seeding run failing if `vault_` appears
    in a generated statement.
- Radar on real figures, without redoing S2-18: a loader
  (`tools/data/seed-analytics-from-otoapp.ts`) turns the restored event, BEO,
  camp and studio revenue — `beo_event_billing.package_price` and its deposit
  fields, `event_line_items.unit_price_inc_vat`,
  `studio_event_bookings.amount_total` and `amount_paid`, `camp_attendance`'s
  per-day payments, `core_events.total_value` and `prepayment_*` (intake §8) —
  into `analytics.daily_summary` rows with `source = 'legacy'` and
  `formula_version = 'otoapp-events-v1'`, per branch and business date,
  replacing S2-18's fixture rows for the days they cover. Stated plainly on
  the Console page and in the report: these are the park's **event, party and
  camp** takings, which is the revenue the OTO App actually holds; admissions
  and F&B revenue lived in Pisell and Papaya and are not in this dump, so
  those lines stay on the fixtures until the Radar dump (Open decision 18) or
  the credentials arrive. HKT Central's
  `analytics.branch_source_switch.preference` is set to `oto_pos`, so a sale
  made on the staging POS moves its figures within `ROLLUP_INTERVAL_S`; the
  second demo branch is set to `legacy`, so the client sees restored history
  beside live POS numbers.
- Data handling, enforced rather than only written down:
  - The dump and everything derived from it stay on the owner's machine and in
    the private staging database. `imports/_db/` is already git-ignored; this
    ticket adds the CI job `guard:no-production-data` and a matching
    pre-commit hook that fail on any `.sql`, `.dump` or `.csv` over 1 MB, on
    any path matching the known dump names, and on any diff adding a
    phone-shaped or Thai-name literal outside `packages/db/src/seed`.
  - Intermediate files are written only to `RESTORE_WORK_DIR`, whose
    documented default is outside the repository and outside OneDrive (per
    `imports/_db/README.md`) — never into the repository, never into a shared
    scratch directory. Run reports carry counts, hashes and status, never
    values.
  - Outbound messaging stays off. The restore refuses to run unless
    `SMS_ADAPTER=console`, `ALERT_CHANNELS` names no channel that reaches a
    real person, and the new `OUTBOUND_MESSAGING=off` is set, which makes every
    SMS, email and chat adapter a no-op that records only what it would have
    sent; and unless the OTO App service has `LOG_RESPONSE_BODY=false` (it is
    `"true"` in the agency's AWS, which writes PII, reset tokens and kiosk
    codes into the logs — intake §11 item 6) with its Twilio, SMTP and LINE
    variables unset. After the restore, any table holding queued outbound
    messages is listed and emptied.
  - Face recognition is not migrated. The templates are not in the dump at all
    — they live in the agency's Rekognition collections (intake §9) — so "not
    migrated" is made concrete: no collection is created in our account, no
    re-enrolment is run, `OTOAPP_FACE_CLOCKIN` stays false on staging and the
    face routes stay **removed or disabled, not merely unset** (unsetting
    `USE_AWS_REKOGNITION` makes the mock return the first enrolled employee for
    any face — intake §9), the restored `face_id`, `confidence_score` and
    `liveness_score` columns are inert and are **never copied into any platform
    table**, the enrolment photos the source kept in a public `profile-photos`
    folder land in the private platform bucket with signed-URL access only, and
    the run fails if any `AWS_REKOGNITION_*` variable or collection name is
    configured.
  - PDPA and retention: every derived `crm.member` and `crm.child` row carries
    `source = 'otoapp_import'`, `source_record_ref`, `consent_basis` and
    `retention_until`, and the imported categories are added to
    `core.retention_policy` so `job:housekeeping.retention` (S2-03) covers
    them, under S2-23's floor rule that financial and child-release categories
    cannot be set below five years. Child health text is masked at write in
    logs and at read in `audit_log`, as S2-01a already requires; `imports/`
    stays local reference input only, per `CLAUDE.md`.
  - Who looked at what: every read of an imported person's record through the
    POS, the Console or an export writes an `audit_log` row with
    `category = 'data_access'` — the category S2-23 adds — carrying the actor,
    the entity type and id, the app, the station and the box. This ticket adds
    the imported-record reads to the Console's data-access preset on
    `/activity` (`console:activity:read`; unmasked values need
    `admin:audit:read_sensitive`) and an "imported records" filter there. Bulk
    extracts go through `POST /admin/data/exports` (permission
    `console:data:export`), which records what was exported, by whom and why
    and returns a signed URL that expires; there is no unaudited download path.
- Demo data and how the two profiles coexist: `SEED_PROFILE` gains `restored`
  beside the existing `staging` value that seeds demo data. `staging` =
  `platform:sync` plus `seed:demo-day`; `restored` = `platform:sync` plus the
  restore and seeding above, and it refuses to run `seed:demo-day`. The two
  never share a database: the applied profile is recorded in `ops_seed_state
  (profile, applied_at, run_id)` and the api refuses to start when the
  requested profile differs from the recorded one, unless `SEED_PROFILE_SWITCH
  =true` is set deliberately. "Reset demo data" on Console > Data
  (`console:data:reset_demo`, platform_admin, typed confirmation, audited
  `ops.demo_reset`) is extended: under `staging` it behaves as today; under
  `restored` it is refused with "this database holds restored production data —
  rebuild it with `pnpm data:restore`", so nobody wipes the client's figures
  with a button. Going back the other way is `pnpm data:reset-to-demo`, which
  drops the `crm`, `pos`, `promo`, `booth`, `analytics`, `edge` and `otoapp`
  content, re-runs `platform:sync` and `seed:demo-day`, records the new profile
  and is audited.
- Cutover rehearsal (`pnpm data:rehearse`, also the button behind S2-23's
  `console:data:migration_rehearse`): take a fresh dump — a `pg_dump -Fc` once
  the owner supplies one (PLATFORM_PLAN §14 item 1), otherwise a fresh Navicat
  export — and run the whole procedure end to end against a clean staging
  database with a stopwatch: per-step durations into `ops_import_run`, the
  verification above, the ten spot checks, and a schema diff of the new dump
  against the last one (`tools/data/schema-drift.ts`), so drift is caught
  before the day rather than on it. Two consecutive runs must agree on counts
  and on durations within a stated tolerance (PROJECT_CONTEXT §12, "until two
  runs match"). The output is `docs/qa/CUTOVER_RUNBOOK.md`: the ordered steps
  with their exact commands, who runs each, the expected duration, the
  verification queries with their expected answers, the go / no-go checks, and
  the rollback — which is simply that the agency's system stays untouched and
  DNS is the only switch (PLATFORM_PLAN §13, Stage A).
- Docs: `docs/qa/CUTOVER_RUNBOOK.md`; the `.env.example` block for
  `OTOAPP_DUMP_PATH`, `RESTORE_WORK_DIR`, `DATA_CLASSIFICATION`,
  `OUTBOUND_MESSAGING`, `MEMBER_SEED_FROM_CHECKIN_HISTORY`, `SEED_PROFILE`,
  `SEED_PROFILE_SWITCH`; and the decision entry in `ARCHITECTURE.md` recording
  that the platform's password verifier accepts two hash schemes.

Excludes: the real DNS switch and Stage B, the branch-by-branch POS
replacement (on-site and owner steps, not code); live Pisell and Papaya pulls;
the Radar and wheel database restores until those dumps arrive (Open decision
18); re-enrolling face templates anywhere; importing the OTO App's drop-off and
nanny history into the platform's check-in module (Open decision 25, who owns
supervised care); Xero production credentials; any change to the OTO App's own
modules (S2-17b).

Acceptance criteria:
- [ ] `pnpm data:restore` against a clean staging database completes with no
      hand-editing of the dump, and Console > Data > Imports shows the run with
      its per-step durations, 184 tables restored and no failed step.
- [ ] The verification report on that page shows every table's row count equal
      between the dump and `otoapp`, and the structural counts matching (184
      tables, 65 enums, 179 primary keys, 519 foreign keys, 370 indexes, 27
      unique constraints), with the four missing composite primary keys and the
      `pl_facts` unique index now present.
- [ ] An administrator opens the OTO App from the launcher and sees the
      client's real branches, departments and employee list; opening the same
      employee in the Console shows the linked platform account and its Apps
      tab row.
- [ ] A restored employee whose `phone_e164` is set signs in on the launcher
      with their existing OTO App password and is asked for nothing else; the
      report lists every user without a phone as "needs a phone before
      sign-on", and none of them has an account.
- [ ] The member and child preview report is produced and no `crm.member` or
      `crm.child` row exists while `MEMBER_SEED_FROM_CHECKIN_HISTORY=preview`;
      switching it to `apply` creates them, and each created member's page
      shows `source = otoapp_import` with its source record reference.
- [ ] Radar shows real event, party and camp figures for the restored branch,
      labelled as event revenue only, and HKT Central's figures move within
      `ROLLUP_INTERVAL_S` after a cash ticket sale on the staging POS.
- [ ] Opening a restored child's record writes a row on the Console's
      data-access view naming the staff member, the record and the time, and
      the child's allergy text appears in neither Activity nor any log line.
- [ ] "Reset demo data" is refused on a `restored` database with the message
      naming `pnpm data:restore`, and still works on a `staging` database;
      `pnpm data:reset-to-demo` returns a `restored` database to seeded demo
      data and the Console shows the new profile.
- [ ] Dev evidence: two consecutive `pnpm data:rehearse` runs against a fresh
      dump with matching counts and recorded durations, plus the CI
      `guard:no-production-data` job failing on a deliberately staged commit
      that adds a dump file.

QA / demo steps:
1. QA (UI): On the Console open Data > Imports, start the restore with the
   typed confirmation, and screenshot the finished run with its step durations
   and the verification report.
2. QA (UI): Open the OTO App from the launcher; screenshot the real branch and
   employee lists; open one of those employees in the Console and screenshot
   the Apps tab and the linked account.
3. QA (UI): Sign in on the launcher as a restored employee using their existing
   password; screenshot the landing page; screenshot the report line for a user
   who has no phone.
4. QA (UI): Screenshot the member and child preview report; switch the flag to
   `apply`, re-run, and screenshot one created member showing
   `source = otoapp_import` and one child with an allergy note.
5. QA (UI): Screenshot Radar for the restored branch with its event-revenue
   label; make a cash ticket sale on the POS; wait the interval and screenshot
   the changed HKT Central figure.
6. QA (UI): Open a restored child's record, then screenshot the data-access row
   on Activity; attempt "Reset demo data" and screenshot the refusal.
7. Dev evidence: the two rehearsal run logs with their durations and counts,
   and the CI `guard:no-production-data` job output.

Depends on: S2-17b, S2-18, S2-23. Size: L.

### S2-23 — Console: the owner's super-admin control surface across the whole suite

Feature area: Console (super admin)

Rules: R-08 (every mutation carries the acting account; audit is the
control), R-16 (health indicators), R-58 and R-94 (child health data
staff-only, masked, access-logged); conflicts C10 (events stay mastered by
the OTO App), C13 (benefits hang off the HR record). Proposal aspects
§4.3–4.5 (phone identity, scoped `service:resource:action` RBAC, activity
and exception views, transaction safeguards, service-availability
messages) and §6.1. Open decisions 2, 17, 33, and the three open questions
in `docs/features/console.md`.

Description. The owner's decision of 2026-09-20 (`OWNER_DIRECTION.md`,
"Super admin (Console) is the owner's own control surface"): the POS keeps
its admin for POS operations and the OTO App keeps its admin for internal
operations, so the Console is deliberately **not** a third copy of either.
It is the layer above them — the one place the owner and a platform
administrator see and steer the whole suite, added for the owner's own
benefit so future control is easy. S2-03 built Console v1 (`apps/console`
+ `packages/admin-ui`, static site with the `/api` rewrite, gated by
`app:console:access`) with Activity, Failures, Health and Integrations;
S2-04 added Devices and S2-07b added Booths. This ticket completes the
surface: eleven further pages, the `console:*` permission vocabulary, a
platform-owned app registry and feature-flag store, support tools
(cross-app lookup, one-action-id trace, audited impersonation), data and
release controls, and the danger rules for everything that can hurt. Each
page answers the same two questions — what is true right now, and what can
I change from here — and every control in the Includes names the ticket its
data comes from, so no page is a mock. The fifteen areas become sub-tasks
of this one issue, each with its own acceptance criteria and evidence
comment in the Sprint 1 format.

The rule that keeps it honest: **the Console never writes another app's
tables directly.** Every action either writes a platform table the Console
owns (`core`, plus `analytics` and `promo` configuration) or calls that
app's own API as the acting user, so the OTO App's own permission model
still applies — `requireAuth`, `requireManager`/`requireAdmin`, the 11
module keys with their per-user overrides, `user_branch_access` and the
advisor resolution documented in `intake-2026-09-19/01-oto-app-backend.md`
§3 — and likewise Radar's sign-on gate (S2-18) and the Inbox's
`inbox:*` permissions (S2-19). The one cross-app write the platform owns
is the identity seam `core.app_identity` and `otoapp.users.platform_user_id`
through the provisioning service built in S2-17a. Where a page cannot do
something through an app's API it says so and links out rather than
reaching into the schema; and where a setting belongs to another app, the
Console shows it read-only, labelled "owned by <app>", with a deep link.

Includes:

- Tables — `core`: `app_registry` (key, name, purpose, origin url, tile
  state open|coming_soon|hidden|maintenance, schema, owning service, health
  url, version source, required permission, sort order,
  `maintenance_message`, `archived_at`); `feature_flag` (key, kind
  feature|kill_switch, scope_type platform|operator|branch|station,
  scope_id, value jsonb, default value, `expires_at`, reason, updated_by,
  updated_at — unique on key + scope); `impersonation_session` (actor,
  subject, app, reason, reference, `write_allowed`, approver, started_at,
  `expires_at`, ended_at, ended_by, action_count); `setting_registry`
  (seeded index of every configurable setting: key, label, owning app,
  owning page url, editable_here, permission, last_changed_at);
  `retention_policy` (audit category, min age days, action
  keep|anonymise|purge, enabled, updated_by); `erasure_request` (subject
  kind member|child|contact, subject id, requester, reason, status
  received|assessed|executed|refused, affected apps jsonb, evidence,
  executed_at); `alert_recipient` (channel, address reference — an env
  name, never a value, categories, branch scope, active); `deploy_event`
  (app, version, commit, actor, status, deployed_at). Extensions:
  `audit_log` gains `target_app` and `reason`, and the category
  `data_access`; `ops_run` gains kinds `integration` and `console`.
  Every table carries `operator_id` where it is operator-owned, plus
  `created_at`/`updated_at`; ids are UUIDv7.

- Suite overview (`/`, `console:overview:read`) — the screen the owner
  opens first, one card per thing that can be wrong. Shows: each app from
  `core.app_registry` with its tile state, version and health (its own
  health url, polled by `job:apps.health`); today's money per branch and
  the suite total (`analytics.daily_summary` for the business date, S2-15b,
  with the "provisional / rolled up at HH:MM" freshness stamp); open alerts
  by severity (`alert`, S2-03); boxes and booths online out of total
  (`box_heartbeat`, S2-04/S2-07a); "needs a decision" — unresolved payment
  attempts past `PAYMENT_PENDING_MIN` (S2-10a), `sync_quarantine` rows
  (S2-05), cash variances above tolerance (S2-15a), late 2C2P payments
  (PAYMENT_GATEWAY §3.7), stranded gate occupants (S2-15a), erasure
  requests awaiting action, dual-control requests awaiting an approver.
  Changes: nothing — every tile is a link to the page that can act. A
  "Copy status summary" button produces a plain-text digest, and
  `job:console.digest` posts the same digest to `ALERT_WEBHOOK_URL` each
  morning at the branch business-day start when
  `CONSOLE_DIGEST_ENABLED=true`.

- Tenancy and organisation (`/org`, read `console:org:read`, write
  `console:org:manage`; operator and branch creation still additionally
  require the Sprint 1 `admin:operator:*` / `admin:branch:*`) — operators,
  branches, departments in one tree. Shows and changes: operator name and
  archive state; branch name, code, timezone, address, opening hours and
  `business_day_start` (S2-04), archive; departments (Sprint 1 `department`,
  plus the Inbox teams' department links from S2-19); `branch_holiday`
  ranges (Sprint 1, S2-09a) with a preview of which dates flip to weekend
  pricing; `branch_tax_rule` and `tax_override` shown read-only with a link
  to the POS admin panel that owns them; per-branch feature flags from
  `core.feature_flag` (for example `booth.enabled`, `gate.enabled`,
  `wallet.offline_cap`, `checkin.offline_release`,
  `analytics.source_switch_allowed`). Archiving an operator or branch
  requires typed confirmation and refuses while a box, station or open cash
  session belongs to it, naming what blocks it.

- People and access across every app (`/people`, read `console:people:read`,
  write `console:people:manage`, app grants `console:people:grant_app`,
  session control `console:people:force_sign_out`) — the one account page
  for the whole suite. Shows: account, linked employee, status, phone
  verification, `must_change_password`, role assignments with their scope
  (operator / branch / department / record), effective permissions with the
  scope each comes from (`GET /me/permissions` resolver, Sprint 1), app
  access grants (`app:pos:access`, `app:oto_app:access`, `app:radar:access`,
  `app:inbox:access`, `app:console:access`, `app:booth:access`), linked app
  identities (`core.app_identity`, S2-17a) with the role each app knows the
  person by, active sessions with class, station, box, last seen and lock
  state (S2-01a), and the account's own recent activity and denials
  (`audit_log`). Changes: create an account or link one to an employee;
  assign and remove roles within the dominance and scope-ownership rules
  from S2-01a; issue an invitation or a temporary password (SMS adapter);
  activate and deactivate; lock and unlock a session; force sign-out of one
  session or everywhere (`POST /accounts/:id/sessions/revoke`); and
  **provision a person into the OTO App, Radar or the Inbox in one action**
  — one form that creates the platform account if needed, grants the app
  permission and calls each app's provisioning path (S2-17a's
  `POST /admin/apps/oto_app/users` for the OTO App with its role, branch
  scope and tenant; a role assignment for Radar and the Inbox), writing one
  audit row per app with `target_app`. Two additions: a **reverse
  permission lookup** ("who holds `pos:refund:approve`, and at what
  scope?") over `role_assignment` and `role_permission`, and an **effective
  permission diff** that previews exactly which permissions a pending role
  change adds or removes, at which scopes, before it is saved. Module-level
  switches inside the OTO App are shown from its API and edited through it,
  never by writing `otoapp` tables.

- App registry (`/apps`, read `console:app_registry:read`, write
  `console:app_registry:manage`) — the suite's own directory, and the table
  the launcher reads. Shows and changes: each app's key, display name,
  purpose line, origin url per environment, schema, owning service, version
  (from `APP_VERSION`/`APP_CHANGE_ID` for the lifted services, `agent_version`
  for boxes, the build id for the static sites), required permission, tile
  state (open / coming soon / hidden) which drives the launcher tiles from
  S2-02, sort order, and **maintenance mode** with a message: the app's tile
  shows the message, its hand-off exchange is refused with
  `APP_IN_MAINTENANCE`, and the api keeps serving everything else, honouring
  the owner's rule that the suite never goes down at once. Maintenance mode
  is `platform_admin` only, typed confirmation, and auto-expires after
  `KILL_SWITCH_MAX_TTL_MIN`.

- Activity, audit and data access (`/activity`, `console:activity:read`;
  unmasked `admin:audit:read_sensitive`; export `console:activity:export`)
  — extends the S2-03 page rather than repeating it. Adds: an **app
  column and filter** over every source (`audit_log` from the platform, the
  OTO App's request audit written by the sign-on adapter from S2-17a/b,
  Radar from S2-18, `inbox.event` from S2-19, `station_event` and box
  events from S2-05); a **data-access log** preset over category
  `data_access` — every read of a child health note, a member's phone, a
  pickup photo or an unmasked audit row, with who, when, which record and
  from which app (R-94, S2-13); a **denials and failed sign-ins** preset
  (`auth.sign_in_failed`, `auth.locked_out`, `auth.permission_denied`,
  `auth.handoff_rejected`); a **target app** filter fed by the new
  `audit_log.target_app`; and a CSV/NDJSON export that is itself audited
  (`audit.export`) and masked unless the exporter holds
  `admin:audit:read_sensitive`. Read-only apart from export. Retention is
  set on the Data tools page, never here.

- Failures and alerts (`/failures`, `console:alert:read`; acknowledge and
  resolve `console:alert:manage`) — extends S2-03. Shows: `ops_run`
  failures grouped by name and fingerprint across every kind (http, job,
  client, device, sync, webhook, integration, console), the silent-failure
  watchdog's view of `ops_expectation` versus `ops_last` (what should have
  run and did not), `sync_quarantine` and `sync_anomaly` (S2-05), unmatched
  payment webhooks and unresolved attempts (S2-10a, PAYMENT_GATEWAY §3.4),
  print-job failures (S2-06/S2-11), and alert delivery history
  (`alert_delivery`). Changes: acknowledge with a note, resolve, retry a
  retryable run, mute a fingerprint for a bounded window with a reason, and
  edit **alert channels and recipients** — `core.alert_recipient` maps an
  alert category to a channel (console, email, webhook) and an address
  reference, per branch or operator-wide, closing Open decision 17 as data
  rather than code. "Send test alert" is kept from S2-03 and is gated by
  `OPS_TEST_CONTROLS`.

- Health (`/health`, `console:health:read`) — extends S2-03/S2-04. Shows,
  in one place: api and each Docker service (`/ready` checks: db latency,
  pool, storage, watchdog age, event-loop lag, WebSocket connections per
  station), job runner and each defined job with its last run and next due,
  boxes and booths (online, version, uptime, heartbeat age, outbox depth,
  clock offset), devices per box with printer reachability and paper state
  (R-16, S2-04/S2-06), gates and their readers (S2-12), sync lag per box and
  per legacy source (Pisell/Papaya freshness from S2-18), queue depths,
  database size and connection headroom, object-storage reachability and
  bucket size, and the external pinger's last result. Read-only; every tile
  links to the page that can act. Test controls ("Run watchdog now", "Stop
  heartbeats", "Advance box clock", `job:demo.fail`) stay behind
  `OPS_TEST_CONTROLS`.

- Boxes, stations and devices (`/devices`, read `console:device:read`,
  write `console:device:manage`, remote commands `console:device:command`)
  — extends the S2-04 area. Shows and changes: box registration and claim
  codes, the station setup wizard (what it does → choose the box → assign
  devices → test print), device assignment and payment routing, pairing
  codes for displays, kiosks and booths with revoke, config version per
  station, receipt-series high-water marks (S2-11), and the simulator
  control panel per box (S2-06/S2-10a: scripted outcomes, fault injection,
  "customer paid" and "late payment" for the gateway simulator) behind
  `OPS_TEST_CONTROLS`. Remote commands through `edge.box_command` (S2-04):
  test print, re-pull config (`config.apply`), restart agent, clear cache
  (re-pull the bundle whole), collect logs, go offline / go online, and
  `reset_store` which mints a new `journal_epoch`. Each command shows its
  queued / running / result state and its `ops_run` row; `reset_store` and
  revoking a box credential need typed confirmation and refuse while the
  box has an unsynced outbox, naming the depth.

- Integrations (`/integrations`, read `console:integration:read`, test
  `console:integration:test`) — extends S2-03. One row per integration:
  the 2C2P gateway (`PGW_*`, including the separate Payment Maintenance
  host), SMS (`SMS_ADAPTER`, Twilio), email (SMTP), messaging channels
  (`inbox.channel_account` per channel and branch, S2-19), the AI provider
  (S2-19), Xero (S2-17b), object storage, OTel/HyperDX
  (`OTEL_EXPORTER_OTLP_*`, `TRACE_URL_TEMPLATE`), Sentry, the alert
  webhook, and Radar's legacy sources (`FUNTOPIA_MODE`, `PAPAYA_MODE`,
  S2-18). Each shows: **variable presence only, never a value** (generated
  from `apps/api/src/env.ts` as in S2-03), which service reads it, whether
  the provider or its simulator is active and why, last success and last
  failure from `ops_last`/`ops_run` kind `integration`, a failure history
  sparkline, and a **test button** that performs a harmless round trip
  (Payment Token mint and immediate cancel; SMS to a staff phone; a
  webhook ping; a MinIO put/get/delete of a scratch object; an OTLP export
  probe) recorded as its own `ops_run` and audited. Added: a **credential
  and certificate expiry watch** — any integration whose token or key has a
  known lifetime (Meta channel tokens, 2C2P maintenance keys, the OTO App
  Directory API key) carries an `expires_on` the owner sets, and the
  watchdog opens an alert 30 and 7 days before. The "variables to
  provision" list from S2-03 stays, now grouped by which app needs them.

- Analytics and sources (`/analytics`, read `console:analytics:read`, source
  switch `console:analytics:manage_source`, re-run
  `console:analytics:rerun`) — the owner's data-source control
  (OWNER_DIRECTION 2026-09-20 later: "an administrator — from the OTO App's
  admin and from the Console — chooses per branch whether the analytics
  shown are the current POS (Pisell/Papaya) or the new OTO POS"). Shows and
  changes: `analytics.branch_source_switch` per branch — `legacy` |
  `oto_pos` | `both` with its switch date, the effect previewed before
  saving ("days before 2026-10-01 stay legacy; from that date OTO POS");
  `formula_version` per source (v30 Floresta, v21 Chalong) and which rows
  carry it; `dirty_date` queue depth and a **re-run rollup for a date or
  range** (`job:rollup.daily`), refused for frozen legacy days unless a
  platform admin unfreezes with a reason; cross-branch KPIs read from
  `GET /analytics/summary?branches=…&group=day|total` (S2-15b) — revenue,
  guests, kid/adult mix, tier mix, marketing-channel breakdown, booth
  funnel and prize cost, wallet liability — with a parity delta column for
  branches set to `both`; and a deep link into Radar for analysis, which
  stays Radar's job.

- Configuration and content (`/config`, read `console:config:read`, write
  `console:config:manage`) — the index of every configurable thing in the
  suite, from `core.setting_registry`, each row labelled **owned by app X**.
  Editable here (platform-owned): print templates and their fixtures
  (S2-06/S2-11), receipt and refund series per station (S2-11), voucher
  definitions with campaign and marketing channel (S2-07b/S2-10b), prize
  lists, weights, caps and booth layouts with publish and version pickup
  (S2-07b), supervision policy, confirmations and drop-off pricing (S2-13),
  offline capability values (wallet cap, cache max age, staff-token
  expiry), languages and the `en`/`th` message files with a
  missing-translation report (Sprint 1 i18n scaffold, S2-19 for the Inbox
  strings). Read-only with a link out: POS catalogue, prices, tiers and tax
  rules (POS `/admin`); HR settings, schedules and modules (OTO App);
  formulas, targets and notes (Radar); Inbox routing rules and templates
  (Inbox). Added: a **cross-app drift check** that compares the `core`
  mirrors against their masters (branches, employees and accounts against
  `otoapp`, S2-17b's views) and lists divergences with a "who wins" note,
  so the mirror never silently rots.

- Money oversight (`/money`, read `console:money:read`, investigate
  `console:money:investigate`) — the owner's read-only view of the money,
  across branches and tenders, with no ability to move any. Shows: sales
  per branch, business date and revenue category (`pos.sale`, `sale_line`,
  S2-09a/b); refunds and voids with the approving manager, reason and the
  original sale (S2-11); discounts, comps and promotions with foregone
  revenue (S2-09a, S2-14a); cash sessions with float, paid-outs, safe drops
  and variance against the ฿1 tolerance (S2-15a); settlement status per
  tender and TID — card batches and the 2C2P reconciliation file
  (PAYMENT_GATEWAY §3.11) with unmatched lines in either direction; wallet
  liability outstanding and its daily movement (S2-14a
  `fact_wallet_liability_daily`); voucher and benefit cost (S2-07b, S2-21).
  Added, because they are the failures that hide: a **money integrity
  panel** — receipt-number gaps per station and series, sales with no
  settled payment, payments with no sale, attempts stuck past
  `PAYMENT_PENDING_MIN`, refunds exceeding their sale, and wallet entries
  whose projection disagrees with the ledger — each row linking straight to
  the support trace. Every read of this page is audited; nothing on it
  writes.

- Support tools (`/support`, lookup `console:support:lookup`, trace
  `console:support:trace`, impersonation `console:support:impersonate`) —
  three tools for "a customer is standing at the desk and something is
  wrong".
  - **Cross-app lookup**: one box that accepts a phone, a band code, a
    receipt number, a booking reference, a voucher code, an account id or
    an action id and returns everything the suite knows, each result
    labelled with its app and permission-filtered — member and children
    (`crm`, masked unless the viewer holds the sensitive permission),
    visits and check-ins (S2-13), sales and payments (S2-09a/S2-10a),
    bands and gate events (S2-11/S2-12), bookings (S2-12), wallet and
    vouchers (S2-14a/S2-10b), OTO App records through its API
    (`app_identity`, events, check-ins), Inbox conversations (S2-19). Every
    lookup writes a `data_access` audit row.
  - **"What happened to this sale"**: paste one `x-oto-action-id`, sale id
    or receipt number and get a single vertical trace, ordered by time,
    following that action through till intent → box session document and
    lease → device adapter call (terminal frame or print job, projected,
    never raw) → outbox event with epoch and sequence → cloud apply or
    quarantine → audit row → payment webhook and inquiry → rollup effect,
    with each step's `ops_run` and its latency, the gaps highlighted, and a
    deep link to the external trace through `TRACE_URL_TEMPLATE` when OTel
    is configured. Sources: S2-03 correlation ids, S2-04 box log, S2-05
    sync ledger, S2-10a adapter runs, S2-15b rollups.
  - **Audited, time-boxed impersonation**: "view as" a chosen account in
    the POS, the OTO App, Radar or the Inbox. Read-only by default;
    `write_allowed` requires a reason, a reference and a second approver
    (`CONSOLE_DUAL_CONTROL`). Expires after `IMPERSONATION_MAX_MIN`
    (default 15) or on sign-out, whichever first. **Refused** for any
    subject holding `platform_admin` or any `console:*` permission, and
    refused for an actor impersonating themselves or an already-impersonated
    session. A fixed, non-dismissible banner names the actor and the
    subject in every app for the whole window; every request in the window
    carries `actor_type=impersonated` with `on_behalf_of`, so the row is
    unmistakable in both the platform `audit_log` and the target app's own
    audit; the subject sees the session on their own account page
    afterwards and a `console.impersonation.start` alert is raised. The
    hand-off token issued for an impersonation is audience-bound and
    marked, so an app can refuse it (the OTO App refuses it for payroll and
    contract routes).

- Data tools (`/data`, read `console:data:read`; reset
  `console:data:reset_demo`; retention `console:data:retention_manage`;
  erasure `console:data:erasure`; rehearsal
  `console:data:migration_rehearse`) — everything that touches data in
  bulk, all of it `platform_admin` only and all of it typed-confirmation.
  Shows and changes: **Reset demo data** (the audited `ops.demo_reset`
  action from the Design decisions, `OPS_TEST_CONTROLS` only) with a
  preview of exactly which schemas and row counts go; **seed profiles**
  (`SEED_PROFILE`, `platform:sync`, `seed:demo-day`) with the last run and
  a re-run button; **retention and purge policies** per audit category from
  `core.retention_policy`, feeding `job:housekeeping.retention` (S2-03),
  with the floor rule that financial and child-release categories cannot be
  set below five years (Open decision 33) and a dry-run that reports what
  would be removed; **PDPA erasure requests** — record a request, see every
  app and table holding that subject (platform tables directly, other apps
  through their APIs), run the anonymise-in-place path, and keep the
  evidence, with audit rows that never copy the erased values; **backup and
  restore status** — the managed Postgres PITR window, last backup, last
  restore rehearsal, and the object-storage bucket versioning state, shown
  with a link to Render rather than executed here; **migration rehearsal**
  (S2-22) — trigger a dump-restore-post-import rehearsal into a scratch
  database, with the schema-drift report and the two-run comparison as its
  output.

- Release controls (`/releases`, read `console:release:read`; flags
  `console:release:flag_manage`; kill switches
  `console:release:kill_switch`) — version and blast radius. Shows:
  version, commit and deploy time per app and per box agent from
  `core.deploy_event` and the heartbeat, with `MIN_SUPPORTED_AGENT_VERSION`
  and which boxes are below it; deploy history with who triggered it and
  whether CI was green; the feature flags and kill switches from
  `core.feature_flag` with their scope, current value, who set it, why, and
  when it expires. Changes: flip a feature flag at platform, operator,
  branch or station scope; and the named **kill switches** — disable QR
  tender, force manual payment recording, disable card tender, close the
  gate (deny all, or exit-only), stop the booth, pause outbound messaging,
  freeze analytics rollups, block new sign-ins for an app, put an app into
  maintenance. Three rules make them safe: every kill switch **must** carry
  an expiry (default 60 minutes, maximum `KILL_SWITCH_MAX_TTL_MIN`) and
  auto-reverts with an alert when it lapses; a **blast-radius preview**
  names what stops working, which branches and stations are affected and
  how many sessions are open there, before the confirm button enables; and
  each flip is `platform_admin` only, typed confirmation, a mandatory
  reason, an audit row with `target_app`, an alert to every channel, and a
  banner on the affected app.

- Permission vocabulary — added to `packages/shared/src/permissions.ts`
  alongside the Sprint 1 strings and the app-access grants
  (`app:console:access` remains the gate on the whole console):
  `console:overview:read`; `console:org:read`, `console:org:manage`;
  `console:people:read`, `console:people:manage`,
  `console:people:grant_app`, `console:people:force_sign_out`;
  `console:app_registry:read`, `console:app_registry:manage`;
  `console:activity:read`, `console:activity:export`;
  `console:alert:read`, `console:alert:manage`; `console:health:read`;
  `console:device:read`, `console:device:manage`, `console:device:command`;
  `console:integration:read`, `console:integration:test`;
  `console:analytics:read`, `console:analytics:manage_source`,
  `console:analytics:rerun`; `console:config:read`,
  `console:config:manage`; `console:money:read`,
  `console:money:investigate`; `console:support:lookup`,
  `console:support:trace`, `console:support:impersonate`;
  `console:data:read`, `console:data:reset_demo`,
  `console:data:retention_manage`, `console:data:erasure`,
  `console:data:migration_rehearse`; `console:release:read`,
  `console:release:flag_manage`, `console:release:kill_switch`. Unmasked
  audit reads keep the existing `admin:audit:read_sensitive`. Role bundles:
  `platform_admin` gets all of them; `operator_admin` gets every read plus
  `console:org:manage`, `console:people:*`, `console:config:manage`,
  `console:analytics:manage_source`, `console:alert:manage`; a new seed
  role `support` gets `app:console:access`, the reads,
  `console:support:lookup` and `console:support:trace` but never
  `console:support:impersonate`; `branch_manager` gets
  `console:overview:read`, `console:health:read`, `console:device:read`,
  `console:money:read` and `console:activity:read`, branch-scoped. Every
  route carries the permission as a route option, so the S2-01b
  route-enumeration test covers the console routes too; scope is taken from
  the branch, operator or station in the route, resolved by the Sprint 1
  scoped resolver.

- Cross-cutting rules, implemented once and tested once:
  - **Read-only versus actionable.** Read-only pages: Suite overview,
    Activity, Health, Money oversight, and the support lookup and trace.
    Actionable pages: Tenancy, People, App registry, Devices, Integrations
    (tests only), Analytics (source switch and re-run), Configuration
    (platform-owned settings only), Data tools, Release controls, and
    acknowledge/resolve on Failures. A page that is read-only carries no
    write route at all, so the enumeration test proves it.
  - **Audit.** Every Console mutation runs through `withTx` (S2-01b) and
    records an audit row with `origin='console'`, the actor, `app` (the
    console), the new `target_app` (which app the action reached into),
    `reason` where the action demands one, before/after, request id, action
    id, scope, and the outcome. Denials are recorded the same way
    (`auth.permission_denied` with the attempted permission and scope).
    Console reads that touch personal data are recorded under the
    `data_access` category, sampled for list views and always for a
    detail view.
  - **Danger rules.** Typed confirmation (the exact name or code typed
    back) for: archive operator or branch, revoke a box or device
    credential, `reset_store`, maintenance mode, reset demo data, purge or
    retention change, erasure execution, migration rehearsal, force
    sign-out everywhere, and every kill switch. `platform_admin` only for:
    reset demo data, retention, erasure, migration rehearsal, kill
    switches, maintenance mode, impersonation with writes, and unfreezing a
    legacy analytics day. `OPS_TEST_CONTROLS=true` gates every test and
    destructive convenience: reset demo data, seed profile re-runs,
    simulator fault injection, `job:demo.fail`, "Stop heartbeats", "Advance
    box clock", "Expire hand-off now", synthetic gateway notifications.
    When `NODE_ENV=production` nothing destructive exists: the api already
    refuses to boot with `OPS_TEST_CONTROLS` set (DEVELOPMENT_PLAN §8.12),
    each destructive route refuses at runtime with
    `403 DESTRUCTIVE_DISABLED_IN_PRODUCTION`, and the Console hides the
    whole group rather than showing buttons that fail.
  - **Dual control (break-glass).** `CONSOLE_DUAL_CONTROL` names the
    actions that need a second platform admin to approve within 10 minutes:
    by default granting `app:console:access` or `platform_admin`,
    impersonation with writes, kill switches, erasure execution and reset
    demo data. The request, the approver and the reason are one audit row
    pair; an unapproved request expires and is recorded as such. This
    answers the open question in `docs/features/console.md`.
  - **Unavailability, not silence.** Every page that reads another app
    shows "OTO App unreachable — last successful read 14:02" rather than an
    empty table (proposal §4.5 service availability), and the failure is an
    `ops_run`.

- Environment variables (names only, added to `.env.example` and to the
  Integrations page's presence list): `IMPERSONATION_MAX_MIN` (default 15),
  `CONSOLE_DUAL_CONTROL` (comma list of actions), `KILL_SWITCH_MAX_TTL_MIN`
  (default 1440), `CONSOLE_DIGEST_ENABLED`, `RENDER_API_KEY` (read-only,
  deploy history only; absent means the deploy list falls back to
  `core.deploy_event` written by the deploy step). No new secret is ever
  displayed.

- Seed and navigation: `platform:sync` seeds `core.app_registry` with the
  six apps and their tile states, `core.setting_registry` with every
  setting the suite has, the default `retention_policy` rows (no purge,
  five-year floors recorded), the `support` role, and the default
  `alert_recipient` set (console channel, all categories). Console
  navigation becomes four groups — Overview; Organisation (Tenancy,
  People, Apps, Configuration); Operations (Devices, Booths, Health,
  Failures, Integrations, Releases); Insight and support (Activity,
  Analytics, Money, Support, Data) — in the `packages/admin-ui` layout, at
  1280 px and usable at phone width. `docs/features/console.md` is rewritten
  to match, and the decisions log in `ARCHITECTURE.md` records the
  never-write-another-app's-tables rule.

Excludes: moving the Sprint 1 POS admin panels into the Console — the POS
keeps its own admin by the owner's decision, so Open decision 2's "move in
Sprint 3" half lapses with Sprint 3 and the Console links to those panels
instead; editing OTO App HR data, Radar formulas or POS catalogue and
prices from the Console (read-only with links out); deep analytics, charts
and forecasting (Radar's job); a general approval-workflow engine (only the
named break-glass dual control); executing backups or restores (Render
PITR does that; the Console shows status and links); automatic remediation
of anything the Console detects; any display of a secret value; live
channel credentials (S2-19 / on-site); the Pi image and the on-site
bring-up runbook (S2-24); the production data restore itself (S2-22, whose
results this page then shows).

Acceptance criteria:
- [ ] Migration adds the eight `core` tables and the `audit_log`
      `target_app`/`reason` columns and applies twice cleanly from empty;
      `platform:sync` seeds the app registry, the setting registry, the
      retention defaults, the `support` role and the alert recipients, and
      is a no-op on a second run.
- [ ] Every new `console:*` permission exists in
      `packages/shared/src/permissions.ts`, appears on
      `GET /me/permissions` for the seeded roles, and the route-enumeration
      test fails if any console route lacks a permission option; a
      `support`-role account sees Overview, Activity, Health and Support
      but gets 403 `PERMISSION_DENIED` on every write route and cannot see
      the impersonation tool.
- [ ] Suite overview from a clean seeded staging shows all six apps with
      state and version, today's money per branch matching
      `GET /analytics/summary`, the open-alert count matching the Failures
      page, boxes online matching Health, and at least one item in "needs a
      decision" after a deliberately unresolved payment attempt; every tile
      links to the page that can act and the page issues no write request.
- [ ] Creating a second operator with one branch, setting its timezone,
      opening hours and business-day start, adding a holiday range and a
      branch feature flag all save and are audited; archiving a branch that
      still owns a box is refused, naming the box.
- [ ] From the People page, one action provisions a new person into the
      OTO App: the platform account is created, `app:oto_app:access` is
      granted, `core.app_identity` and `otoapp.users.platform_user_id` are
      linked through the S2-17a service, and the person opens the OTO App
      from the launcher with no second password. Two audit rows exist, one
      with `target_app=oto_app`. Attempting the same by writing `otoapp`
      tables does not exist in the code (dev evidence: a test asserts no
      query outside `core`/`crm`/`pos`/`promo`/`booth`/`analytics`/`edge`
      is issued from console services).
- [ ] The reverse permission lookup for `pos:refund:approve` lists exactly
      the accounts holding it with their scopes; the effective-permission
      diff previews the added and removed permissions of a pending role
      change, and the saved change matches the preview.
- [ ] Setting an app to maintenance mode with a message makes the launcher
      tile show it and the hand-off exchange for that origin return
      `APP_IN_MAINTENANCE`, while every other app keeps working; the mode
      auto-expires and is audited on both transitions.
- [ ] Activity's data-access preset shows a child health note read and an
      unmasked audit read as `data_access` rows with actor, record and app;
      the masked view hides phone and allergy text for an account without
      `admin:audit:read_sensitive`; the CSV export is audited and masked
      for that same account.
- [ ] Adding an email alert recipient for the category `payments` and
      forcing an unmatched webhook opens an alert delivered to that
      recipient with an `alert_delivery` row; acknowledging and resolving
      records the actor and note.
- [ ] Integrations shows presence only for every `PGW_*`, SMS, storage,
      OTel and channel variable; the gateway test performs a token mint and
      cancel and records an `ops_run` kind `integration`; setting an
      integration's `expires_on` 20 days ahead opens the 30-day expiry
      alert on the next watchdog run.
- [ ] Switching a branch from `legacy` to `oto_pos` with a switch date
      previews the effect, saves, is audited, and makes Radar show that
      branch's POS figures; re-running the rollup for a chosen date
      recomputes only that date; a frozen legacy day refuses the re-run
      until a platform admin unfreezes it with a reason.
- [ ] Configuration lists every setting with its owning app; a
      platform-owned setting (a print template, the supervision policy)
      edits and is audited here; an app-owned setting (a POS price, an HR
      policy) is read-only and links out; the drift check reports a
      deliberately diverged branch name between `core` and `otoapp`.
- [ ] Money oversight reconciles against the source screens: the day's
      sales, refunds, cash variance and settlement status equal the POS
      End-of-Day figures for the same business date; the money-integrity
      panel lists a deliberately created receipt-number gap and a sale with
      no settled payment, each linking to its trace.
- [ ] Cross-app lookup by one member's phone returns the member, children
      (masked by permission), the last sale, the band, the booking, the
      wallet balance, the OTO App record and the Inbox conversation, each
      labelled with its app, and writes one `data_access` row.
- [ ] Pasting the action id of a completed card sale into the trace view
      shows the ordered chain from till intent to rollup with each step's
      latency, including the box outbox event and the adapter run; doing
      the same for a sale made while the box was offline shows the gap and
      the later sync step.
- [ ] Impersonating a reception account read-only shows the banner in the
      POS for the whole window, ends automatically after
      `IMPERSONATION_MAX_MIN`, and produces rows in both the platform audit
      and the target app's audit marked `actor_type=impersonated` with
      `on_behalf_of`; impersonating a `platform_admin` or a console-holder
      is refused with `IMPERSONATION_REFUSED`; enabling writes without an
      approver is refused.
- [ ] "Reset demo data" requires `platform_admin`, `OPS_TEST_CONTROLS`, a
      typed confirmation and a second approver, previews the schemas and
      row counts, is audited `ops.demo_reset`, and is absent from the UI
      and refused by the route when `NODE_ENV=production` (dev evidence in
      the boot-refusal and route tests).
- [ ] A retention policy set below the five-year floor for the financial or
      child-release category is refused; a dry run reports the rows that
      would be affected without removing any; an erasure request records
      the subject's presence in every app and the executed anonymisation
      leaves no value in the audit rows.
- [ ] Flipping the "disable QR tender" kill switch previews the affected
      branches, stations and open sessions, requires a reason and a second
      approver, makes the POS refuse the QR tender with the configured
      message while cash and card still work, raises an alert on every
      channel, and auto-reverts at its expiry with a second alert and audit
      row.
- [ ] Every Console mutation in the QA run carries an audit row with
      `origin='console'`, actor, `target_app` and, where required, a
      reason; the console pages pass the phone-width and 1280 px checks and
      no page shows a secret value.

QA / demo steps:
1. QA (UI): Open the Console on Render as platform admin; screenshot the
   Suite overview with the six apps, today's money, alerts, boxes online
   and the "needs a decision" list; click one item through to the page that
   acts on it.
2. QA (UI): On Tenancy, create operator "Demo Operator" with branch "Demo
   2" (Asia/Bangkok, opening hours, business-day start), add a holiday
   range and toggle a branch feature flag; screenshot the saves and their
   Activity rows; try to archive HKT Central and screenshot the refusal
   naming the box.
3. QA (UI): On People, create an account, assign `reception` scoped to HKT
   Central, screenshot the effective-permission diff before saving, then
   provision the same person into the OTO App in one action; open the OTO
   App from the launcher as that person with no second password and
   screenshot it; screenshot the two audit rows and the reverse lookup for
   `pos:refund:approve`.
4. QA (UI): On Apps, set the Inbox to maintenance with a message;
   screenshot the launcher tile and the refused hand-off, and the POS still
   working; clear it and screenshot both audit rows.
5. QA (UI): On Activity, open the data-access preset after reading a child
   note in the POS; screenshot the masked and unmasked views as two
   different accounts and the export row; on Failures, add an email
   recipient for payments, force an unmatched webhook from the gateway
   simulator, and screenshot the alert, its delivery and the
   acknowledgement.
6. QA (UI): On Health, screenshot the service, job, box, device and sync
   tiles; on Devices, run a test print and a "re-pull config" on the
   virtual box and screenshot the command results; attempt `reset_store`
   with a non-empty outbox and screenshot the refusal.
7. QA (UI): On Integrations, screenshot the presence list with no values,
   run the gateway and storage tests, and screenshot the `ops_run` rows and
   the expiry-watch alert after setting an `expires_on` 20 days ahead.
8. QA (UI): On Analytics, switch "Demo 2" to `oto_pos` with today's date,
   screenshot the preview and the save, make a demo sale on the POS,
   re-run the rollup for today, and screenshot Radar showing the figure.
9. QA (UI): On Configuration, edit a print template and screenshot the
   audited change; screenshot a POS-owned price row shown read-only with
   its link out; screenshot the drift report for a deliberately renamed
   branch.
10. QA (UI): On Money, screenshot the day's sales, refunds with approver,
    cash variance and settlement status beside the POS End-of-Day screen
    for the same date; screenshot the money-integrity panel listing the
    seeded receipt-number gap.
11. QA (UI): On Support, look up a member by phone and screenshot the
    cross-app result; paste the action id of a card sale and screenshot the
    trace; repeat for a sale made with the box offline; start a read-only
    impersonation of the reception account, screenshot the banner in the
    POS and the audit rows in both apps, then screenshot the refusal when
    impersonating a platform admin.
12. QA (UI): On Data tools and Releases, screenshot the reset-demo preview
    with its typed confirmation and approver step, the retention floor
    refusal, and the "disable QR tender" kill switch — its blast-radius
    preview, the POS refusing the QR tender, the alert, and the auto-revert
    with its audit row.
13. Dev evidence: test output for the route-enumeration guard over the
    console routes, the "no query outside platform schemas from console
    services" test, the impersonation refusal and expiry tests, the
    production destructive-route refusal test, the kill-switch auto-revert
    test, and the migration-twice log.

Depends on: S2-03 (Console v1, telemetry, audit extensions, alerts), S2-04
(boxes, stations, devices and their commands), S2-15b (analytics summary
contract), S2-17c, S2-18 and S2-19 (every app must exist before the layer
above them is real), S2-22 (so the money and analytics pages show the
client's own figures). Size: XL.

### S2-24 — Branch box image and on-site readiness: the bring-up runbook and the switch from simulator to real device

Feature area: Box image and on-site

Rules: OWNER_DIRECTION 2026-09-20 (later) — there is no Sprint 3, what follows this sprint is on-site testing with the real devices, so this ticket is what makes that phase short; PROJECT_CONTEXT §2 (nothing may block on hardware), §4 (box image, agent and station model), §5 (PWA and station pick), §6 (network, DNS-01, dnsmasq) and §14 (build order, step 1); `docs/architecture/DEVICE_INVENTORY.md` in full — §1 and §2 (network and devices), §6 (the gate), §9.1-§9.6 (per-device facts and the "confirm on site" lists) and §9.7 (what each ticket takes from it).

Description. Every device in this sprint runs against a simulator. The phase
after the sprint is a park visit with real printers, terminals, a scanner and a
gate, and its length is decided almost entirely by what is written down before
it starts. This ticket produces three things. A branch-box image that builds in
CI and boots on a Raspberry Pi 5 with the agent, watchdog, certificates, local
DNS, log shipping, time discipline and first-boot registration already in it. A
documented per-device switch from each simulator to its real transport — for
every device in `DEVICE_INVENTORY.md`, the exact setting that flips it and the
smoke test that proves it. And `docs/qa/ON_SITE_BRINGUP.md`, a runbook that
walks the visit device by device with every "confirm on site" question from
`DEVICE_INVENTORY.md` as a checkbox, what to measure, what to photograph and
what to do when a device disagrees with the document. A fault-injection
rehearsal on the simulators means the on-site team meets no failure mode for
the first time at the park. S2-04 built the cloud side of boxes, stations and
devices and explicitly excluded the Pi image; this is that image and the paper
around it.

Includes:
- Image (`infra/box-image/`, built by the CI job `box-image` on a tag and
  publishing `oto-box-<version>.img.xz` with its SHA-256 and a package
  manifest): Raspberry Pi OS Lite 64-bit (Debian Bookworm) for the Pi 5 with
  NVMe boot; **read-only root** through overlayfs with a writable `/data` ext4
  partition holding the box `Store` (SQLite), cache bundles, the outbox,
  pending release photos and the certificate store; `journald` with
  `Storage=persistent` and `SystemMaxUse=200M` on `/data`; unattended upgrades
  off, because the image is the update unit.
- Watchdog and service: the Pi hardware watchdog (`bcm2835_wdt`) with
  `RuntimeWatchdogSec=15` and `RebootWatchdogSec=2min`;
  `oto-box-agent.service` as `Type=notify`, `WatchdogSec=30`,
  `Restart=always`, `RestartSec=5`, `User=otobox` in group `dialout`,
  `After=network-online.target`; devices discovered by udev event and opened by
  `/dev/serial/by-id/…`, never by a fixed `/dev/ttyACM*` number; ModemManager
  disabled, brltty absent, and the `ENV{ID_MM_DEVICE_IGNORE}="1"` rules for
  `05e0:1701` (scanner CDC), `2fb8` (PAX) and the NEXGO VID once it is known
  (DEVICE_INVENTORY §9.6).
- Time: `chrony` with `makestep`, the mall's upstream plus pool servers, and
  the clock offset already reported on `POST /box/v1/heartbeat` (S2-04)
  stamping `clock_trust` (`good` | `low`) on box facts. The Pi 5 has no RTC
  battery by default (§9.6), so `/data/last-known-time` is restored at boot and
  a box that boots with an implausible clock refuses to mint band codes until
  the first successful sync or an audited operator override.
- Certificates and names: Caddy with the DNS-01 provider module issuing for the
  box's name under `central.otoplay.co`, account and certificates on `/data`;
  90-day certificates, so an internet outage never invalidates them
  (PROJECT_CONTEXT §6). dnsmasq on the counter-1 and gate boxes answers the
  park's names and forwards everything else upstream, with its zone generated
  from `GET /box/v1/config` so adding a box needs no hand-editing.
- Log shipping and version reporting: the agent ships `ops_run`,
  `station_event` and its own health over the existing sync channel — no second
  pipe — and `@oto/telemetry`'s `register.ts` sends traces and logs when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The heartbeat gains `image_version`,
  `schema_version` and `/data` free space beside the `agent_version`, uptime,
  temperature, outbox depth and device status S2-04 already sends. The cloud
  refuses `POST /box/v1/register` and `POST /box/v1/sync/push` from an agent
  below the station config's `min_supported_agent_version` (set from
  `MIN_BOX_AGENT_VERSION`) with `BOX_AGENT_TOO_OLD`, and S2-04's existing
  "agent below min supported version" watchdog rule raises the alert naming
  the box and both versions; conversely the agent refuses to start against a
  cloud `schema_version` it cannot migrate on read, and says which it needs.
- First-boot registration: `oto-box-register.service` (one-shot, ordered before
  the agent) reads `/data/provision.json` (branch, box role
  `counter` | `gate` | `booth` | `kiosk` | `standby`, claim code) or prompts on
  the HDMI console; calls `POST /box/v1/register` with the claim code; receives
  the box id, the per-box secret (only its hash kept in the cloud), epoch 1 and
  the station config; writes `/data/box.json` mode 0600 and never logs the
  secret. An unregistered image shows one screen on HDMI: "not yet registered —
  enter claim code". After the `reset_store` command the box re-registers and
  takes the new epoch, as S2-04 and the sprint's sync rules require, audited
  `box.register`.
- Per-device switch from simulator to real transport. `core.device` already
  carries `kind`, `transport`, `address`, `model` and serial / TID / MID
  (S2-04); this ticket adds `device.config` (jsonb, validated by a per-kind zod
  schema) for the remaining settings and makes `device.transport` the switch.
  All of it is edited in Console > Devices and in the station setup wizard;
  `transport: simulator` is the default and the only value CI ever uses. Per
  device kind, the setting that flips it and the smoke test that proves it:
  - **Receipt printers** — Welltech G4 at `192.168.88.202` and the three
    Xprinter XP-80 units at `.206`, `.207`, `.208`: `transport: tcp`, `host`,
    `port: 9100`, `language: escpos`, `dots_per_line: 576 | 512`,
    `thai_mode: raster`, `cut: partial`, `drawer: {pin, on_ms, off_ms}`. Smoke:
    the `test_print` box command from Console > Devices renders the fixture
    receipt including its Thai line; the health card shows `DLE EOT 1..4`
    returning the idle `0x12`; the drawer kicks on the counter unit only.
  - **Wristband printers** — 4B-2082A at `192.168.88.204` (kids) and `.210`
    (adults): `transport: tcp`, `host`, `port: 9100`, `language: tspl2` (ZPL
    kept as the switch), `dpi: 203`,
    `media: {width_mm, length_mm, gap_mm, sensing: gap | bline}`, `density`,
    `speed`. Smoke: `~!T` returns the model string on the health card; one gap
    calibration; one band printed and then read back by the scanner into the
    till.
  - **Scanner** — Zebra DS2278 with the CR2278-PC cradle, attached to the box:
    `transport: usb-cdc` (recommended) or `usb-hid`, `path` as
    `/dev/serial/by-id/…` or `/dev/input/by-id/…-event-kbd` with an exclusive
    evdev grab, `delimiters: ["\r\n", "\r", "\n"]`, `quiet_gap_ms: 500`,
    `min_len: 6`, `symbologies: [code128, qr]`. Smoke: scanning a printed band
    raises exactly one scan event on the station channel; a person typing the
    same characters slowly raises none.
  - **Card terminal** — NEXGO N5, TID `65703235` and `65703236`:
    `transport: serial`, `path`, `baud: 9600`, `data_bits: 8`,
    `parity: none | odd` (the question still open in §5), `stop_bits: 1`,
    `dialect: ghl-linkpos`, `pos_ref_len: 12`, `tid`. Smoke: a ฿1 card sale
    approves and then voids before settlement; a sale with no response puts the
    till into the staff-confirm path, because LinkPOS cannot QUERY a card sale.
  - **QR and wallet terminal** — PAX A920Pro, SN `1854355548` and `1854355549`:
    `transport: serial`, `path`, `baud: 9600`, `8N1`, `dialect: digio-direct`,
    `serial_no`, `ref_counter`. Smoke: the T0/T1 terminal-info reply carries the
    serial printed on the unit; a ฿1 PromptPay sale (A3) returns the QR payload
    (A18), is inquired successfully, and voids (A11).
  - **Gate** — GE-X2 with the HX-X1 driver and the network QR reader.
    Controller: `transport: serial`, `path`, `baud: 19200`, `parity: N81`,
    `machine_id` (`L-30`), `upload_mode: 1` (`L-34`, push on state change),
    `open: dry-contact ~1 s on L-OP / R-OP / COM`. Reader: `base_url` set to
    the gate box's own `https://gate1.central.otoplay.co/interaction/Api`,
    `serial`, `reader: 0 | 1`, and the bilingual
    `messages: {allow, deny_band, deny_adult_only}`. Smoke: the reader's
    `heartbeat` posts arrive and are answered `{"code":"1"}`; a valid band gets
    `code "1"` and a `61` / `62` passage event that moves occupancy by exactly
    one; an invalid band shows the refusal text on the reader; occupancy never
    moves on an open command alone.
  - **Booth** — USB dome button and the booth's ESC/POS printer:
    `button.transport: evdev | simulator`, `button.path`
    (`/dev/input/by-id/…`), `button.keycode`, plus the printer settings above.
    Smoke: one press spins once, a held key does not repeat-spin, and a voucher
    prints.
  - **Cash drawer** — kicked through the receipt printer: `drawer.pin: 2 | 5`,
    `on_ms`, `off_ms` (the park's drawer may need 100 ms or more). Smoke: the
    drawer opens on a cash sale and `DLE EOT 1` bit 2 reports it open, then
    closed.
- Station-level switch: `station.device_mode` (`simulator` | `real`) with a
  per-device override, changed from Console > Devices and audited
  `station.device_mode.change`. A station in `real` mode with an unreachable
  device starts **degraded, with an alert** rather than refusing to sell, and
  the till header names the device that is down — the park must keep taking
  money while somebody fixes a cable.
- `docs/qa/ON_SITE_BRINGUP.md`, ordered as the visit runs: record the network
  before touching anything; then the counter boxes, the gate box, the booth
  box; then device by device in the order above. Each device section carries
  the addresses and identifiers from `DEVICE_INVENTORY.md` §2 and that device's
  "confirm on site" questions as checkboxes — the six numbered lists in
  §9.1-§9.6 (thirty items) plus the markers in §2 (which scanner model, which
  Xprinter model), §4 (D1 label language, D6 exact model), §5 (the NEXGO
  parity), §6.1 (the reader's heartbeat interval), §6.2 (the TTL-to-Ethernet
  module), §6.5 (the six the supplier did not answer) and §7 (band stock
  colours). Each section also names:
  - **What to measure:** the self-test page values (model, firmware, dpi, dots
    per line, code page list, current IP) for every printer; the band media
    width, length and gap in millimetres, and the darkness and speed that give
    a scannable Code 128 at 8 ips on the park's stock; the scan-to-Enter
    latency and whether characters are lost at "No Delay"; the `lsusb` VID and
    PID of each terminal in ECR mode; the drawer pulse that actually opens the
    park's drawer; the reader's heartbeat interval; and what a second TCP
    connection does during a print job.
  - **What to photograph:** every self-test page, the rear panel of every
    printer, each terminal's dock and cable, the gate's terminal block and the
    reader's mounting, the band stock label, the router's reservation list, and
    each box's port and power. Standing rule, printed in the runbook: no
    photograph may contain a customer, a child, a member's data or a screen
    showing them.
  - **What to do on a disagreement:** write the observed value into that
    device's row in `DEVICE_INVENTORY.md` during the same visit, strike the old
    value through with the date, raise a ticket only when an adapter must
    change, and never change code on site before the note goes in.
  - A closing "before you leave" page: the cables and spares to take (USB-A to
    micro-B for the NEXGO, USB-C for the PAX, a USB-RS485 adapter, a spare
    imaged NVMe, a labelled Ethernet cable, a band roll), the credentials
    needed on the day (Console platform_admin, router admin, printer web
    pages), and the support lines already on file — Digio 02-026-3485 and SCB
    merchant 02-777-7444.
- Network prerequisites, as a one-page checklist the mall's IT can action
  before the visit: a DHCP reservation by MAC for every printer at the
  addresses in §2 and for each box (counter 1 at the reference's
  `192.168.88.100`, the rest assigned and recorded), with iPads left on DHCP;
  the gate reader pointed at the gate box's **name**, not an address;
  `central.otoplay.co` A records pointing at the boxes' LAN addresses, with the
  DNS-01 API token present in the box environment; the router handing out
  counter 1 and the gate box as both DNS servers; and the firewall — boxes
  outbound 443 only, nothing inbound from the internet, printers reachable only
  from the box's subnet, port 9100 never routed. Each line notes that this is
  the mall's managed network today (§1), so it needs the mall's agreement and a
  stated fallback if refused.
- Fault-injection rehearsal (`pnpm drill:onsite`, driven from S2-06's simulator
  control panel under `OPS_TEST_CONTROLS`), run on staging before anybody
  travels, covering every failure the team can meet: paper out, head open and a
  jam mid-job; a printer unreachable, and a second TCP connection during a job
  because port 9100 is single-session; a terminal not ready, busy, a customer
  taking 90 seconds, and a hot-plug that renumbers `ttyACM`; a scanner out of
  range that batch-flushes on return, and a double trigger within one second;
  the gate's fire-alarm input, power loss, tailgating `93`, wrong direction
  `83` and fault codes E5, E9 and E30; the box offline through a sale, a
  check-in and a release, then reconnect; a clock skew (S2-04's "Advance box
  clock" control); an agent below the minimum version; and `/data` nearly full.
  Each row names the expected behaviour and the alert that should appear on
  Failures, and the drill writes a pass mark per row into a checklist page the
  runbook carries.
- Docs: `docs/qa/ON_SITE_BRINGUP.md`; the `.env.example` block for
  `MIN_BOX_AGENT_VERSION`, `BOX_IMAGE_CHANNEL`, `DNS01_PROVIDER` and
  `DNS01_API_TOKEN`; and the decisions entry in `ARCHITECTURE.md` recording
  the read-only-root layout and the degraded-station rule.

Excludes: flashing and booting hardware at the park and answering the "confirm
on site" questions — that is the on-site phase itself; buying the Pi 5s, NVMe
drives, UPS and cables; the park-router decision (PROJECT_CONTEXT §6 open
item); the DNS zone for a real domain; the physical gate wiring, which the
supplier has not documented (§6.5); device adapter and simulator behaviour,
which belongs to S2-04, S2-06, S2-10a and S2-12; and the branch cutover itself
(S2-22).

Acceptance criteria:
- [ ] A fresh `oto-box-<version>.img.xz` boots with a read-only root and a
      writable `/data`, and shows the "not yet registered — enter claim code"
      screen on the attached display.
- [ ] Entering a claim code on that screen registers the box: it appears in
      Console > Devices with its branch, role, `agent_version`,
      `image_version` and free space, and Health shows its heartbeat within 60
      seconds.
- [ ] Pulling the box's power mid-sale and restoring it brings the agent back
      with the same box id and epoch and the unsynced sale still in its outbox,
      which then syncs exactly once; killing the agent three times shows the
      watchdog restarting it, with the restarts visible on Failures.
- [ ] Console > Devices flips one device from simulator to real, showing
      exactly the fields named above for that device kind, and its smoke-test
      button reports pass or fail with a reason; setting a station to `real`
      with one device unreachable leaves the till selling and names the device
      that is down.
- [ ] `docs/qa/ON_SITE_BRINGUP.md` can be followed by a reviewer who has never
      seen the park: every device in `DEVICE_INVENTORY.md` §2 and §6 has a
      section, every "confirm on site" item in §9.1-§9.6 and in §2, §4, §5,
      §6.1, §6.2, §6.5 and §7 appears as a checkbox, and every section names
      what to measure, what to photograph and what to do on a disagreement.
- [ ] The network prerequisite checklist is one page that can be handed to the
      mall's IT without further explanation, and names the box addresses, the
      reservations, the DNS records and the firewall rules.
- [ ] `pnpm drill:onsite` completes on the simulators with a pass mark on every
      listed fault, each raising its expected alert on Failures, and the
      resulting checklist page is attached to the runbook.
- [ ] An agent below `MIN_BOX_AGENT_VERSION` is refused at register and at sync
      with `BOX_AGENT_TOO_OLD`, and the refusal appears on Failures naming the
      box and both versions.
- [ ] Dev evidence: the CI `box-image` job log showing the published artefact,
      its SHA-256 and the package manifest.

QA / demo steps:
1. QA (UI): Boot the image; screenshot the "not yet registered" screen; enter
   the claim code; screenshot the box on Console > Devices and its heartbeat on
   Health.
2. QA (UI): Start a sale, pull the box's power, restore it; screenshot the
   recovered outbox and the synced sale; kill the agent three times and
   screenshot the watchdog restarts on Failures.
3. QA (UI): Flip the counter receipt printer from simulator to real, pointing
   it at the printer simulator's TCP endpoint as a stand-in; screenshot the
   settings form and the smoke-test result; make it unreachable and screenshot
   the degraded station and its alert.
4. QA (UI): Open `docs/qa/ON_SITE_BRINGUP.md`, work one device section end to
   end against the simulators, and screenshot the completed section with its
   ticked "confirm on site" boxes.
5. QA (UI): Run `pnpm drill:onsite` from the simulator control panel;
   screenshot the pass table and two of the alerts it raised on Failures.
6. QA (UI): Use the test control to report an old agent version; screenshot the
   `BOX_AGENT_TOO_OLD` refusal on Failures.
7. Dev evidence: the CI `box-image` job log with the artefact, its SHA-256 and
   the package manifest.

Depends on: S2-05, S2-06, S2-07b, S2-12. Size: L.

### S2-16 — Sprint 2 acceptance run, load and soak checks, Render staging refresh, sprint-2 tag, SPRINT_2_REPORT.md and Jira evidence per story

Feature area: Acceptance and delivery

Description. Closes the sprint the way Sprint 1 closed: the full acceptance
checklist run from a clean database on refreshed Render staging, defects
fixed, non-functional checks recorded, the commit tagged `sprint-2`,
`SPRINT_2_REPORT.md` written, and an evidence comment posted on every Jira
story. It also finalises the client play-test guide.

Includes:
- `docs/qa/SPRINT_2_ACCEPTANCE.md` listing every story's QA steps with
  pass/fail and screenshots; `seed:demo-day` (built S2-09a..S2-13) run, not
  extended, here.
- Playwright smokes against the Render origins: launcher sign-in → POS station
  pick; till + display membership; ticket sale cash; ticket sale 2C2P sandbox
  QR; booth spin → voucher → redemption; booking QR → gate; check-in →
  offline release; launcher → OTO App signed in; launcher → Radar with a POS
  sale visible; launcher → Inbox shell.
- Non-functional checks (dev evidence): the targets in Design decisions
  measured with k6/autocannon (10 tills × 5 min) and a 24 h soak on staging;
  POS at 1024 px iPad landscape and the < 768 px mobile shell without
  horizontal scroll, console at 1280 px, PWA offline load, an api redeploy
  during an open sale; the offline capability matrix tested row by row; a
  manual grep of staging logs for phone, name or child data.
- CI green including redaction, OTel, migrate-twice, boot-refusal,
  schema_version and concurrency checks; `render.yaml` final; env names
  verified against `.env.example` and the Integrations page.
- Tag `sprint-2`; `SPRINT_2_REPORT.md`; `SPRINT_2_PROGRESS.md` closed;
  ARCHITECTURE.md and DEVELOPMENT_PLAN.md current; `docs/features/pos.md`,
  `booth.md`, `console.md`, `oto-app.md`, `oto-radar.md`, `inbox.md`,
  `STATUS.md` updated; play-test guide with demo accounts (values out of band)
  and feedback template; Jira evidence per story; owner questions
  consolidated.

Excludes: new scope from feedback; real domain cutover, hardware, vendor
accounts.

Acceptance criteria:
- [ ] `docs/qa/SPRINT_2_ACCEPTANCE.md` shows every story passed on the staging
      run date with screenshots linked and zero open blockers.
- [ ] A clean staging database seeded by `seed:demo-day` reproduces the M5
      demo (sale → print → booth spin → voucher → redemption → History) in
      under 10 minutes following the play-test guide.
- [ ] CI is green on the `sprint-2` commit; all Playwright smokes pass on
      Render; the k6 and soak reports meet the targets or list the misses.
- [ ] Every Jira story carries an evidence comment in the Sprint 1 format.

QA / demo steps:
1. QA (UI): Open the acceptance document and spot-check five scenarios
   against the linked screenshots on staging.
2. QA (UI): Follow the play-test guide from the launcher URL to a redeemed
   voucher in History; time it.
3. QA (UI): Open three Jira stories and verify the evidence comment format.
4. Dev evidence: the GitHub Actions run for the tag, the k6 report and the
   soak summary.

Depends on: S2-15b, S2-17c, S2-18, S2-19. Size: M.

## Execution order and checkpoints

Order (the owner's priority: POS and booth first, then the other apps, then
the owner's console and his own data, then on-site readiness):

S2-01a → S2-01b → S2-01c → S2-02 → S2-03 → S2-17a → **CP1** → S2-04 → S2-05 →
S2-06 → S2-07a → S2-07b → **CP2** → S2-08 → S2-09a → S2-09b → S2-10a →
S2-10b → S2-11 → **CP3** → S2-12 → S2-13 → S2-14a → S2-14b → S2-15a →
S2-15b → **CP4** → S2-20 → S2-21 → **CP5** → S2-17b → S2-17c → S2-18 →
S2-19 → **CP6** → S2-23 → S2-22 → **CP7** → S2-24 → S2-16 → **CP8**.

S2-17a sits before CP1 because the owner wants the shared database and one
sign-on proven at the front door; it is a schema, a middleware and a
provisioning route, not the lift. The lift (S2-17b/c), Radar (S2-18) and the
Inbox (S2-19) wait until the POS is complete, as directed. The Console
(S2-23) comes after every app exists, because it is the layer above them, and
the production restore (S2-22) comes after the Console so that the data-access
log and the money pages are there to watch the client's own rows from the
first minute. S2-24 is last before acceptance: by then every simulator has a
documented real counterpart to switch to.

Rationale: S2-01 must precede any client-facing deploy (privilege hole,
non-atomic writes, PII in logs, idempotency race). S2-02/S2-03 put the suite
and its evidence surface on Render at M0. S2-04..S2-06 build the station/box
model the money path and the booth sit on. The booth (S2-07) follows
immediately because it needs only the box agent, the print core and the
scanner. S2-08..S2-10 are the first sale and redemption; S2-11 makes the sale
print and appear in History, which is the honest point to hand the client a
play-test, so CP3 sits after S2-11. S2-12..S2-15 finish the money and arrival
path and S2-20/S2-21 finish the sell side, so the POS is complete at CP5.
S2-17b..S2-19 put the other three apps on the platform. S2-23 and S2-22 give
the owner the control surface and his own data under it. S2-24 turns the
simulator work into an on-site plan. This deviates from PROJECT_CONTEXT §14
(booth at step 5; Pi image in step 1) and is recorded in
`SPRINT_2_PROGRESS.md`.

Parallelisable streams (once their dependencies are merged):
- After S2-03: the box agent skeleton (S2-04) is independent of remaining
  console polish; S2-17a is independent of both.
- After S2-15b: S2-20 and S2-21 are independent of each other; S2-20's kiosk
  surface only needs S2-12's redemption service and S2-06's print pipeline.
- After CP5: S2-17b, S2-18 and S2-19 are independent of each other (S2-18 and
  S2-19 borrow the sign-on middleware from S2-17a); S2-24's image work can
  start any time after S2-06 and only its device switch-over sections need
  the later tickets.
- After S2-06: the booth game (S2-07a) and the customer display (S2-08) are
  independent; S2-09a can start its engine port and regression fixtures at
  any time.
- After S2-09a: tenders (S2-10a) proceed without the booth; S2-10b waits for
  S2-07a and S2-10a.
- After S2-11: S2-12, S2-13, S2-14a and S2-14b are independent of each other.
- Documentation, seed scripts and Playwright smokes run alongside every
  ticket.

| Checkpoint | After | Owner reviews |
|---|---|---|
| CP1 | S2-17a | Security fixes from the UI, schema move and transactional services (dev evidence), lock model, Render deploy of API + POS + launcher + console + shells with the same-origin `/api` rule; the log-line contract, `ops_run`, Activity/Failures/Health/Integrations pages; PII fixes; the OTO App opened from the launcher on the shared database by an admin-created user. |
| CP2 | S2-07b | Station model live on Render: stations, virtual boxes, offline toggle, sync ledger with epochs and quarantine, print core and simulators, PWA; the Lucky Wheel playable end to end with its admin panel. |
| CP3 | S2-11 | Two-device POS, first real sale across tenders, voucher and legacy code redemption, receipts, bands, History, refunds; **client play-test opens**; regression fixtures reviewed. |
| CP4 | S2-15b | Full POS: arrival and gate, check-in with offline release, wallets and stock, cash/EOD/settlement, analytics rows and the multi-branch summary. |
| CP5 | S2-21 | **The POS is complete**: events, parties and camps against the OTO App master, the self-service kiosk redeeming a booking on its own, staff benefit profiles applied at checkout. |
| CP6 | S2-19 | Every app on the platform: the OTO App lifted with each module walked through and its contract features built, Radar live with the per-branch source preference (a POS sale visible in it), the Inbox working end to end on the channel simulator. |
| CP7 | S2-22 | The owner's Console across the whole suite — and the client's own production data under it: real members, employees and figures, the data-access log watching them, the cutover rehearsal timed and written up. |
| CP8 | S2-16 | Acceptance checklist from a clean database on staging, load and soak results, the on-site bring-up runbook, tag, report, Jira evidence, play-test guide. |

Render deployments: the first deploy (API + POS) happens at S2-01c; launcher
and shells at S2-02; the console at S2-03; the OTO App Docker service at
S2-17a; the booth static site at S2-07a; the kiosk surface at S2-20; Radar at
S2-18; the Inbox at S2-19.
From then on every merge to `main` deploys after CI (migrations + `platform:sync`
run on deploy). Staging gets a fresh migrate + seed at each checkpoint and the
audited "Reset demo data" action between client sessions. The final refresh
is part of S2-16.

## Open decisions

Only decisions the owner must make. Each ships with the default so no ticket
blocks. Items marked *unsourced default* are numbers no brief specified; we
chose them and the owner may change them at any time.

1. **Sign-on shape.** Default: same-origin `/api` rewrite per static site plus
   a signed hand-off token per app origin (S2-01c/S2-02) as the permanent
   mechanism; a parent-domain cookie is an optional shortcut once the real
   domain arrives. Alternative: `SameSite=None` cookies with a strict
   allow-list (rejected: more surface for the same result).
2. **Console v1 as a separate deployable now.** Default: yes — `apps/console`
   hosts Devices, Activity, Failures, Health, Integrations, Booths; Sprint 1
   panels stay in the POS `/admin` and move in Sprint 3.
3. **Tier at checkout and tier change.** Default: keep the prototype's Step 2
   cards but pre-select and lock them from the member's tier; the
   verification modal is the only way to change; downgrade needs a manager
   (`pos:member:tier_downgrade`); an expired verification flags review
   instead of downgrading; walk-in = tourist. The evidence-type list is the
   owner's (PROJECT_CONTEXT §10).
4. **Spin eligibility.** Default: per-booth setting, `none` for mall booths,
   no phone capture on the TV; `band` and `phone` refused until the park booth
   exists.
5. **Booth management home.** Default: Console > Booths (S2-07b). Alternative:
   inside the POS admin per the spec addendum §12.
6. **Schema map.** Default: `core/crm/pos/promo/booth/analytics/edge` with the
   placement in Design decisions. A different split later is a cheap second
   SET SCHEMA migration.
7. **Single api instance running edge and jobs.** Default: `numInstances: 1`
   with `PROCESS_ROLES=api,edge,jobs` for this sprint (recorded deviation);
   the worker service is in `render.yaml` commented out. Alternative: a paid
   background worker now.
8. **New manager gates the prototype lacked.** Default: `pos:refund:approve`
   for refunds and voids (online only), `pos:stock:approve` for stock-take
   variances above 3 eaches (*unsourced default*), manager approval for a
   live-lease till takeover.
9. **Launch prize list for the seed.** Default: 23/27/17/14/14/2 plus a 3 %
   mystery box, 14-day expiry, no daily caps; button key configurable per
   booth, seed F8 (*unsourced default*, never Enter). Owner confirms the real
   key the USB button emits and the cost per prize.
10. **OTO App, Radar and Inbox tiles.** Resolved 2026-09-20: OTO App and
    Radar are lifted in this sprint (S2-17, S2-18); the Inbox gets its schema
    and a shell (S2-19). Until each lands its tile is a "coming soon" shell
    with a configurable link to the live legacy URL.
11. **Fresh offline sign-in.** Default: allowed for staff seen on that box in
    the last 30 days, flagged with an offline banner.
12. **Child photos, consent and retention.** Default: `CHILD_PHOTOS_ENABLED`
    on staging with simulator images, consent record and retention TTL fields
    present, no purge rule running; offline photos purged from the box after
    7 days (*unsourced default*); confirm before real member data.
13. **Overstay billing.** Default: displayed only; `extraHourTHB` not charged.
14. **Wallet expiry, refund of unused credit and the offline cap.** Default:
    no expiry rule runs; unused prepaid credit follows the check-in policy
    (refund); offline cap ฿300 per wallet per day (*unsourced default* — to
    be confirmed with the client before S2-09a freezes the ledger fields).
15. **Revenue definition for analytics.** Resolved 2026-09-20 by the owner:
    revenue is computed exactly as Radar's code computes it — formula v30 for
    Floresta-style branches and v21 for Chalong-style (intake notes 03/04
    document both) — and `formula_version` records which; the OTO POS
    rollup reproduces the same definition from POS facts and a parity test
    proves it (S2-18).
16. **Receipt and tax-invoice numbering.** Resolved 2026-09-20: no
    accountant session now. The prototype's receipt component is the layout
    source, the per-station series `{branch}{station}-{series}-{seq}` ships,
    the abbreviated tax-invoice header is templated with the seeded branch
    tax id, and the owner's printed bill (to be shared) corrects any field
    later as data.
17. **Monitoring and alert channel.** Default: no HyperDX purchase this
    sprint (variables only); alerts to console, email simulator and a generic
    webhook URL the owner supplies (Slack/Discord/LINE Notify); LINE adapter
    interface stubbed. Owner names the real channel and recipients.
18. **Legacy codes and Radar dump.** Default: fixture import (S2-10b)
    including reservations until the dump arrives; the importer is the real
    one; legacy 4-digit codes need the campaign window or manager
    confirmation.
19. **Remaining vendor documents and the 2C2P sandbox.** The terminal
    specifications, the park's hardware reference and the four gate documents
    are on file and drive the simulators. Still wanted: the 4B-2082A command
    manual, the Welltech/Xprinter ESC/POS manuals, the Zebra programming
    guide, the gate reader's own manual, and the park's 2C2P sandbox merchant
    credentials (into `.env` as `PGW_*`; the public demo credentials from
    the 2C2P docs serve for the first test).
20. **Business day start.** Default: 05:00 Asia/Bangkok (*unsourced default*)
    so late parties fall on the previous trading day.
21. **Other unsourced defaults, chosen by us.** Hand-off TTL 60 s, pairing TTL
    600 s, lease 15 s/60 s, `BOX_OFFLINE_AFTER_S` 180, `SYNC_STALE_AFTER_S`
    900, `PAYMENT_PENDING_MIN` 10, not-found budget 5/min → 10-min lock,
    display sizes 1024×768 and 1280×800, the p95/load targets, "Reset demo
    data" and the `OPS_TEST_CONTROLS` set. All are environment or config
    values; none affects a stored fact.

Questions the previous developer's document itself raises
(`POS_RULES_RECONCILIATION.md` §4), with the default that ships:

22. **Inclusive-tax decomposition and rounding** (BL §4.2–4.3). Resolved
    2026-09-20: the prototype's `lib/tax.ts` order is the definition,
    captured in regression fixtures; no accountant session; corrections
    later as data.
23. **Reference prices and expat derivation** (BL §3.4). Resolved
    2026-09-20: the prototype's price list, tiers and derivations are the
    definition (seeded as they are); tier rules stay editable data.
24. **Telegram** (C16): keep the contact-channel value with no adapter, or drop
    it. Default: keep the value, no adapter.
25. **Event check-in state** (C10): OTO App stays the source of truth for
    events; does check-in state move to the box (offline) at Stage B or stay
    in OTO App? Default: undecided, nothing in Sprint 2 depends on it.
26. **Kids' bands at the exit gate** (C8): with host-controlled exits, do kids'
    bands ever scan at the exit, or do kids leave only with an adult (group
    rule)? Default: group rule; kids' bands are denied at the gate reader.
27. **Predictive reorder and cost of goods** (BL §11.6, §14.3): accept the
    static reorder point and a shell profitability view until history accrues.
    Default: yes.
28. **Benefit QR source** (C13): the employee master stays in OTO App and the
    platform issues the badge credential. Default: yes (Sprint 3).

Added 2026-09-20:

29. **OTO App face clock-in.** The live app clocks staff in by face
    recognition (`face-recognition.ts`, kiosk); PROJECT_CONTEXT §13 bans
    biometrics for the POS. The lift keeps the module as it is behind
    `OTOAPP_FACE_CLOCKIN=true` (off on staging: PIN and phone clock-in only)
    until the owner decides for production; re-enrolment on new
    infrastructure is part of that decision.
30. **The contract feature list.** `docs/briefs/AGENCY_PROPOSAL.md` §6 is
    our reading of what the proposal shows as not yet built. The owner
    confirms or trims that list before S2-17c starts; each confirmed item
    becomes a Jira sub-task.
31. **Inbox brief conflicts.** The May briefs and the in-app IT Brief
    disagree (statuses, tabs, role views, staffing model, EN/RU primary,
    language handling, complaint routing — `docs/features/inbox.md`). The
    schema in S2-19 follows the IT Brief as the latest word; the owner
    confirms before the live channels are built.
32. **2C2P merchant credentials.** The sandbox merchant id and secret for the
    park's SCB-acquired 2C2P account (or the public demo pair for the first
    test), the enabled QR channel, and the return URLs — into `.env` as
    `PGW_*` (`docs/architecture/PAYMENT_GATEWAY.md`). Production credentials
    later.
33. **Audit retention.** PROJECT_CONTEXT §9 archives audit rows after 12
    months; the ops review argued for at least five years on financial and
    child-release rows. Default: no purge of any audit row this sprint; the
    retention job (S2-03) is configured per category later, with financial
    and release categories never below five years.
34. **Foreign-app schema names.** `otoapp`, `radar`, `inbox` (the earlier
    PLATFORM_PLAN and intake notes wrote `oto_app`; the database role that
    owns the OTO App schema keeps the name `oto_app`, the schema is
    `otoapp`). Cosmetic; recorded so nobody creates both.

## Definition of done for the sprint

- Every story S2-01a..S2-24 merged with its acceptance criteria checked, its
  audit/`ops_run` evidence visible on Activity/Failures/Health, and an
  evidence comment on the Jira story in the Sprint 1 format; every QA step
  tagged QA (UI) or Dev evidence with at most one dev-evidence step per story.
- `pnpm install && docker compose up -d && pnpm db:migrate && pnpm db:seed &&
  pnpm dev` brings up API, POS, launcher, console, booth, the Inbox shell and
  (with Docker) the OTO App and Radar from a clean checkout; `pnpm db:migrate` runs twice cleanly from empty; CI green on the
  tagged commit including the route-enumeration, redaction (with pg-error and
  terminal fixtures), OTel span/log, idempotency-concurrency,
  sync-idempotency/poison/epoch, schema_version replay, boot-refusal,
  spin-distribution, business-date and pricing-regression tests.
- Full acceptance run (`docs/qa/SPRINT_2_ACCEPTANCE.md`) from a clean database
  on refreshed Render staging with zero open blockers; `seed:demo-day`
  reproduces the M5 demo in under 10 minutes; the restore procedure
  (`pnpm data:restore`) runs green on the production dump and the result is
  what the client play-tests.
- `docs/qa/ON_SITE_BRINGUP.md` written and reviewed: every device in
  `DEVICE_INVENTORY.md` has its switch from simulator to real transport, its
  smoke test and its confirm-on-site questions, so the park visit is a
  checklist rather than an investigation.
- Playwright smokes pass on the Render origins: launcher → station pick;
  till + display membership; cash ticket sale; 2C2P sandbox QR sale; booth
  spin → voucher → redemption; booking QR → gate; check-in → offline release;
  launcher → OTO App; launcher → Radar with a POS sale visible; launcher →
  Inbox shell.
- Non-functional checks recorded: the targets in Design decisions measured by
  k6 and the 24 h soak; POS usable at iPad landscape and the mobile shell;
  console at 1280 px; PWA loads offline; an api redeploy loses no open session
  or queued outbox; the offline capability matrix passes row by row; no
  phone, name or child data in any log line or span (redaction test plus a
  manual grep of staging logs).
- Deployed on Render: launcher, POS, console, booth and the Inbox shell as
  static sites with `/api` rewrites, one platform api web service, the OTO
  App and Radar as Docker web services on their own schemas of the one
  managed Postgres (PITR), the 2C2P sandbox wired with real QR codes; `render.yaml`, `.env.example` and the Integrations page agree on
  variable names; the client play-test guide and feedback template delivered.
- Docs current: `docs/features/pos.md`, `booth.md`, `console.md`,
  `docs/progress/STATUS.md`, `SPRINT_2_PROGRESS.md` (status block closed,
  deviations recorded: booth order, Pi image, edge + jobs inside api, face-scan
  removal, occupancy model, OTO App lifted as-is, 2C2P kept over a bank API),
  `SPRINT_2_REPORT.md`, `DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md` (schema
  map and placement, withTx, ids and idempotency, sync epochs, station session
  and leases, adapters and PCI posture, transport and hand-off, observability,
  lock model, offline capability matrix, receipt numbering); tag `sprint-2`.

