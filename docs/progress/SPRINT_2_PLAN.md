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
  Plus, from §6.13, the HR-linked **benefit profiles** (person or role; free
  items, credit, discount, categories, periods; effective dates; benefit QR)
  as the OTO App half of staff benefits, if the owner confirms it for this
  sprint (the POS checkout half is C13 / Sprint 3 in this plan).
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

Order (the owner's priority: POS and booth first, then OTO App, Radar, Inbox):

S2-01a → S2-01b → S2-01c → S2-02 → S2-03 → S2-17a → **CP1** → S2-04 → S2-05 →
S2-06 → S2-07a → S2-07b → **CP2** → S2-08 → S2-09a → S2-09b → S2-10a →
S2-10b → S2-11 → **CP3** → S2-12 → S2-13 → S2-14a → S2-14b → S2-15a →
S2-15b → **CP4** → S2-17b → S2-17c → **CP5** → S2-18 → S2-19 → **CP6** →
S2-16 → **CP7**.

S2-17a sits before CP1 because the owner wants the shared database and one
sign-on proven at the front door; it is a schema, a middleware and a
provisioning route, not the lift. The lift (S2-17b/c) and Radar (S2-18) wait
until the POS is complete, as directed.

Rationale: S2-01 must precede any client-facing deploy (privilege hole,
non-atomic writes, PII in logs, idempotency race). S2-02/S2-03 put the suite
and its evidence surface on Render at M0. S2-04..S2-06 build the station/box
model the money path and the booth sit on. The booth (S2-07) follows
immediately because it needs only the box agent, the print core and the
scanner. S2-08..S2-10 are the first sale and redemption; S2-11 makes the sale
print and appear in History, which is the honest point to hand the client a
play-test, so CP3 sits after S2-11. S2-12..S2-15 complete the POS. This
deviates from PROJECT_CONTEXT §14 (booth at step 5; Pi image in step 1) and is
recorded in `SPRINT_2_PROGRESS.md`.

Parallelisable streams (once their dependencies are merged):
- After S2-03: the box agent skeleton (S2-04) is independent of remaining
  console polish; S2-17a is independent of both.
- After S2-15b: S2-17b, S2-18 and S2-19 are independent of each other (S2-18
  and S2-19 borrow the sign-on middleware from S2-17a).
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
| CP5 | S2-17c | OTO App lifted with every module walked through on staging, POS seams, and the confirmed contract features built. |
| CP6 | S2-19 | Radar live with the per-branch source preference (a POS sale visible), the Inbox pillars and shell. |
| CP7 | S2-16 | Acceptance checklist from a clean database on staging, load and soak results, tag, report, Jira evidence, play-test guide. |

Render deployments: the first deploy (API + POS) happens at S2-01c; launcher
and shells at S2-02; the console at S2-03; the OTO App Docker service at
S2-17a; the booth static site at S2-07a; Radar at S2-18; the Inbox shell at
S2-19.
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

- Every story S2-01a..S2-19 merged with its acceptance criteria checked, its
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
  reproduces the M5 demo in under 10 minutes.
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

