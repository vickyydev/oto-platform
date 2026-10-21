# Super Admin Console: inventory of direction, Radar, data and tenancy

_Read-only study, 21 October 2026, for planning the Super Admin Console
(Jira S2-23 = SCRUM-221, "To Do / not started" in
`docs/progress/TICKET_REGISTER_2026-09-23.md:60`). Nothing was changed or
committed._

**Coverage.** Section 1 quotes the direction documents directly. Sections 2-4 merge three read-only code sweeps (`apps/radar` and `imports/oto-radar`; `packages/db/src/schema` with `apps/api/src/routes|services`, `apps/console`, `apps/launcher`, `apps/pos` and `apps/oto-app`; `packages/shared/src/permissions.ts` with the resolver, guard, seed and isolation register). Those sweeps cite file paths and line numbers. Where a sweep did not confirm something, the text says so.

---

## 1. Prior decisions, promises and sketches

### 1.1 The original brief: `CLAUDE.md` §1-3 (Sprint 1 brief, first committed 2026-09-11)

- §1 "What is being built": "**Admin console** — configuration, users,
  reporting, logs and observability".
- §3 Observability: "pino JSON logs with request ID, account ID, branch ID
  … `/health` and `/ready` … Sentry via `SENTRY_DSN` … Logs and monitoring
  **screens** belong in the admin console later; in this sprint only the
  plumbing is built."
- §3 Multi-tenancy: "row-scoped, single schema. Every tenant-owned table
  carries `operator_id`, and branch-owned tables also carry `branch_id` …
  One operator exists today; the model must support several."
- §3 Permissions: "`service:resource:action` … A role assignment binds an
  account to a role **with a scope**: operator-wide, a specific branch, a
  specific department, or a specific record."
- §4 seed roles: "`platform_admin` (all), `operator_admin` (all within
  operator), `branch_manager` (branch-scoped management), `reception` …,
  `staff` (read-mostly)."
- §5 SCRUM-27: "Platform admin: create and archive operators; create and
  archive branches (with timezone); assign operator administrators. *Done:*
  a second operator with one branch can be created and an admin assigned;
  archived operators are hidden from pickers."
- §7.3: "The admin console in the prototype (`/admin`) is the home for all
  Track C admin screens and the catalog screens."

### 1.2 `docs/briefs/OWNER_DIRECTION.md` (newest wins)

- **2026-09-19:** "End state: one central database, one launcher page
  showing all OTO apps, apps sharing data, **one admin dashboard with
  analytics of everything**."
- **2026-09-19 (later):** "Four app frontends — POS, OTO App, lucky wheel,
  Radar — plus a **fifth, built by us: a super admin** that oversees and
  controls everything: all apps' analytics report to it; activity logs
  (which staff did what); user control and permissions; POS station setup.
  Exact contents to be decided later; it must be in the plan from the
  start."
- **2026-09-19 (later):** "Analytics must come from our own database too,
  **and** Radar's history must be imported so cumulative totals include the
  past."
- **2026-09-19 (later):** "The wheel game … must become controlled from the
  admin side."
- **2026-09-20:** "The POS keeps its own admin; the OTO App keeps its own
  admin controls." Radar: "legacy Pisell/Papaya figures as seeded mock data,
  and **live analytics from our POS** — a demo sale made on staging must
  appear in Radar". Launcher lists "POS, OTO App, Radar, Lucky Wheel,
  Console, Inbox".
- **2026-09-20 (later):** "**Data-source switch is an admin control.** An
  administrator — from the OTO App's admin and from the Console — chooses
  per branch whether the analytics shown are the current POS
  (Pisell/Papaya) or the new OTO POS."
- **2026-09-20 (later), the key ruling:** "**Super admin (Console) is the
  owner's own control surface.** The POS keeps its admin for POS operations
  and the OTO App keeps its admin for internal operations; the Console is
  deliberately an addition *for the owner*, so that future control is easy.
  We design it ourselves: think through every control worth having across
  all apps, plan it properly, describe it fully in the Jira ticket, and
  build it in this sprint."
- **2026-10-14:** "Radar reads our POS only … every branch's dashboard
  figures come from the platform's own summary endpoint. This drops the
  fixture pipelines, the per-branch legacy/both preference inside Radar and
  the parity view." History still to come "through the OTO App events
  loader (S2-22) and the real Radar database dump (Open decision 18)".

### 1.3 `docs/briefs/PROJECT_CONTEXT.md` (2026-09-19)

- §2 architecture box: "API (Fastify) · PostgreSQL · Object storage ·
  **Admin console** · Booking site".
- §3 station model: "Test print runs … admin console → cloud → box →
  printer when done remotely."
- §9 Hosting: "moving to 1 CPU / 4 GB when analytics dashboards are in
  daily use … workers and analytics do not open their own [pool]. Audit log
  partitioned by month or archived after twelve months. **Nightly rollups
  for reporting before any read replica.**"
- §10: "Payment settlement export per terminal and per day, reconciled
  against SCB's settlement report and 2C2P's".
- §11 booth: "Heartbeat every 60 s … Alerts on offline, printer fault,
  paper out … **Per-booth reporting**: spins, prize distribution, vouchers
  issued and redeemed, uptime."

### 1.4 `docs/architecture/PLATFORM_PLAN.md` (proposed 2026-09-19)

- §1 app table: "**Console** (super admin) | Users and permissions across
  all apps, branches, stations/boxes/booths, activity log, all-app
  analytics, system health | New | Build".
- §4: "`app:<name>:access` decides which launcher tiles a person sees.
  Module switches map to permission bundles. OTO App's existing 11 module
  keys and per-user overrides are adopted … the Console writes them through
  to OTO App's own tables". **Note:** S2-23 later replaces "writes through"
  with "through the app's own API".
- §5 analytics: "one summary contract, three sources, a switch date per
  branch"; the diagram feeds "Radar dashboard" and "**Console overview**"
  from one summary API; "Forecast constants, the holiday calendar …,
  targets and notes move into `analytics` tables with a branch column,
  **editable in the Console**."
- §9 "Console (super admin) — the fifth app. Scope now; detail decided
  later with the owner": People and access, Organisation, Devices,
  Activity, Analytics ("headline figures … deep analysis stays in Radar"),
  Health, Integrations. "Domain settings stay with their app … The
  accounts, roles and audit screens built in Sprint 1 move from the POS
  admin to the Console." **Note:** the move was reversed by the S2-23
  Excludes, see 1.7.

### 1.5 `docs/features/console.md` (2026-09-19, revised 2026-09-20)

- "**Console** — the control room for the owner and a few administrators.
  … the headline numbers from every source, and whether the system is
  healthy. Day-to-day work never happens here."
- Scope table: People and access, Organisation, Devices, Activity,
  Analytics ("Links into Radar for depth"), Health, Integrations.
- "The Console requires `app:console:access` and re-checks each action's
  own permission on the server."
- Open questions: "Exact list of module and feature switches … Who besides
  the owner gets Console access, and whether any action needs a second
  approver … Alert channels and who receives which alert."

### 1.6 `docs/architecture/DEVELOPMENT_PLAN.md` (written 2026-09-20, edited 2026-10-14)

- §3.1: "`apps/console` Devices, Activity, Failures, Health, Integrations,
  Booths — 'the fifth app' (S2-03)", a static site with `/api/*` rewrite
  to the single api service (`PROCESS_ROLES=api,edge,jobs`).
- §3.2 schemas: `core` (tenancy, fleet, `app_identity`), `crm`, `pos`,
  `promo`, `booth`, `analytics` (`daily_summary`, `hourly_summary`,
  `branch_source_switch`, `dim_date`, `dirty_date`, `fact_booth_daily`,
  `fact_occupancy_15min`, `fact_wallet_liability_daily`), `edge`,
  `otoapp`, `radar`, `inbox`, `pgboss`. "Cross-app links are **by
  identity, never by foreign key** … No app reads another app's tables
  directly."
- §3.3: "`packages/admin-ui` — the prototype's admin layout … extracted so
  the console, the POS `/admin` and the Inbox shell share one design
  language".
- §3.8 analytics contract: "`GET /analytics/summary?branches=a,b&from&to&group=day|total`
  merges on the server and is the contract Radar consumes … for **every**
  branch".
- §3.9 observability: "anything that can fail silently is recorded in
  `ops_run`"; tables `ops_run`, `ops_last`, `ops_expectation`, `alert`,
  `alert_delivery`, `box_heartbeat` (14-day), `station_event` (30-day);
  `audit_log` classification columns; "Render's log retention is short, so
  `ops_run` and `audit_log` are the on-platform long-term record";
  "Surfaces. Console v1 hosts Activity, Failures, Health, Integrations,
  Devices and Booths. Integrations shows env **presence flags**, never
  values."
- §8 environment registry, the Console-relevant names: `OPS_TEST_CONTROLS`
  ("Enables the Console's test controls — **staging only**"),
  `TRACE_URL_TEMPLATE`, `SENTRY_DSN`, `ALERT_CHANNELS`,
  `ALERT_WEBHOOK_URL`, `OTEL_EXPORTER_OTLP_*`, `ROLLUP_INTERVAL_S` ("15
  minutes on staging, so a demo sale reaches Radar"). §8 rule: "the
  Console's Integrations page shows presence flags generated from
  `apps/api/src/env.ts`, never values."
- §9.4: "`console.md` — the launcher and the Console as two products … the
  Console is the control room (people and access, organisation, devices,
  activity, analytics, health …)."

### 1.7 `docs/progress/SPRINT_2_PLAN.md`: S2-03 and S2-23 (S2-23 added 2026-09-20, commit a2c164da)

- Milestone **M13 "the owner's console" (S2-23)**: "One place that
  controls everything: every account and app grant across the suite,
  activity and data-access logs, failures and alerts, health, boxes and
  devices, integrations, analytics sources, money oversight, support tools
  (cross-app lookup, audited impersonation, 'what happened to this sale'),
  release flags and kill switches."
- **S2-03 (SCRUM-190)** built Console v1: telemetry, `ops_run`, audit
  extensions, job runner and watchdog, and the Activity / Failures / Health
  / Integrations pages, "gate by `app:console:access`".
- **S2-23 design, in full in the ticket (plan lines ~3503-4010).** It is
  the most detailed existing sketch and is the starting point for the new
  plan:
  - Rule: "**the Console never writes another app's tables directly.**
    Every action either writes a platform table the Console owns (`core`,
    plus `analytics` and `promo` configuration) or calls that app's own API
    as the acting user"; settings owned elsewhere are shown "read-only,
    labelled 'owned by <app>', with a deep link".
  - New `core` tables: `app_registry`, `feature_flag`,
    `impersonation_session`, `setting_registry`, `retention_policy`,
    `erasure_request`, `alert_recipient`, `deploy_event`; `audit_log`
    gains `target_app`, `reason` and category `data_access`.
  - Fifteen areas: Suite overview `/` ("today's money per branch and the
    suite total … open alerts … boxes and booths online … 'needs a
    decision'"; a morning digest to `ALERT_WEBHOOK_URL`), Tenancy `/org`,
    People `/people` (provision into OTO App / Radar / Inbox in one action;
    reverse permission lookup; effective-permission diff), Apps `/apps`
    (tile state, maintenance mode), Activity `/activity` (app column,
    data-access log, denials), Failures `/failures` (alert recipients as
    data), Health `/health`, Devices `/devices`, Integrations
    `/integrations` (test buttons, credential-expiry watch), Analytics
    `/analytics` (source switch, re-run rollup, cross-branch KPIs, "deep
    link into Radar"), Config `/config` (setting registry, drift check),
    Money `/money` (read-only, money-integrity panel), Support `/support`
    (cross-app lookup, action-id trace, audited time-boxed impersonation),
    Data `/data` (demo reset, retention, PDPA erasure, migration
    rehearsal), Releases `/releases` (flags, kill switches with expiry and
    blast-radius preview).
  - About 37 `console:*` permissions. Bundles: "`platform_admin` gets all
    of them; `operator_admin` gets every read plus `console:org:manage`,
    `console:people:*`, `console:config:manage`,
    `console:analytics:manage_source`, `console:alert:manage`; a new seed
    role `support` …; `branch_manager` gets `console:overview:read`,
    `console:health:read`, `console:device:read`, `console:money:read` and
    `console:activity:read`, branch-scoped."
  - Danger rules: typed confirmation, `platform_admin`-only actions, dual
    control (`CONSOLE_DUAL_CONTROL`), and no destructive group at all under
    `NODE_ENV=production`.
  - Excludes: "moving the Sprint 1 POS admin panels into the Console — the
    POS keeps its own admin by the owner's decision … deep analytics,
    charts and forecasting (Radar's job)".
  - Order: "The Console (S2-23) comes after every app exists, because it is
    the layer above them, and the production restore (S2-22) comes after
    the Console so that the data-access log and the money pages are there
    to watch the park's own rows from the first minute."
- **S2-15b (SCRUM-216)** "Analytics summaries, Today > Performance, booth
  report, `GET /analytics/summary`"; its Excludes list "Console analytics".
  **S2-18** excludes "the Console analytics overview (Sprint 3)", and
  Sprint 3 was abolished on 2026-09-20, so this item has no home outside
  S2-23.

### 1.8 Plans under `docs/progress/plans/`

- `analytics/PLAN.md` (draft 2026-10-06, build complete 2026-10-07): "Today
  > Performance" from platform rows; "All branches" "shown only to someone
  who can read analytics on more than one branch"; "Admin > Reports (Sales,
  Profitability, Discounts and Comps, Tax and VAT) … read the platform's
  daily rows"; "**Console > Booths > Report** (new): the booth funnel by
  day, booth, staff and prize"; "Health: a 'Run now' control for the daily
  rollup … and the time of the last rollup per branch". The
  `/analytics/summary` rule: "Unpermitted branches are left out and listed
  in the answer as `omitted`, never folded into a total." Questions §9
  Q1-17. Q9 is relevant here: "All branches only across the branches a
  person holds analytics:read on".
- `booth/AUDIT-2026-09-24.md`: R42 "Booths are managed in the main POS app
  (spec §12)" against the build "Managed in Console → Booths … DIFFERENT
  FROM THE REQUIREMENT | Open decision 5"; R51 the booth report was not
  built then (SCRUM-216).
- `inbox-build/PLAN.md` (SCRUM-220): `GET /inbox/dashboard`
  (`inbox:dashboard:read`): "New today, unanswered, handled today, average
  first response …, messages by category"; failures "reach the Console's
  Failures page"; "The sign-on is the Console's pattern, copied".
- `inbox-ai-build/PLAN.md` (SCRUM-590): an `inbox.ai_turn` row per turn
  with "token counts"; "token usage is on every turn row, so the bill is
  [bounded]"; G3 "Model tier versus cost. Opus 5.5 (about $200-250 a month
  at 300 turns a day) …"; "**The Console gets nothing in Phase 2.**"
- `internal-assistant-build/PLAN.md` (SCRUM-591): G8 "about $0.03-0.06 [per
  ask] on Opus 5.5 at low effort"; "Later: an 'Ask' button in each app
  (POS header, Console, Inbox, OTO App)"; a platform tool `inbox.dashboard`
  over `GET /inbox/dashboard`.
- `otoapp-lift/PLAN.md` (S2-17b, 2026-10-13): OTO App jobs "show on the
  Console's Health page", "Retry on its Failures page"; "On the Console, an
  administrator sees which OTO App users have no [suite sign-in]"; "A park
  opened on the Console appears in the OTO App's branch [list]"; "Staff
  vouchers … Moved to the Console (Q8)".
- `arrival/PLAN.md`: "a bookings list in the Console"; Console gate admin.
  `events-kiosk/PLAN.md`: Console > Devices pairs the kiosk.

### 1.9 Owner question records

- `decisions/OWNER_QUESTIONS_2026-10-14.md` B7: "**Who opens the Radar
  revenue dashboard.** Today: administrators only. Should branch managers
  have it too? Note: Radar shows every park's figures".
- `OPEN_ITEMS.md` (14 Oct): the same Radar question, plus "The external
  'marketing summary' machine feed … now answers 503 … should the platform
  grant it a machine read of the rollup, or is the feed retired?" and "Park
  matching is by name … until `GET /analytics/summary` carries branch
  codes".
- `decisions/OWNER_CONFIRMATIONS_2026-10-13.md` §14 (Open decision 17):
  "Who should receive urgent system alerts outside opening hours … Current
  default: Console Failures, without a confirmed external recipient". §18
  the Omni / Marketing Hub consumer. §19 retention (Open decisions 12 and
  33). §24 "AI replies and operating budget".
- `OPEN_QUESTIONS.md` §4/§6: "`ALERT_CHANNELS=console` — alerts are recorded
  and visible on the Console's Failures page, but nothing leaves the
  building."

---

## 2. Radar: what it shows today and what the owner wanted

### 2.1 The original Replit Radar (`imports/oto-radar/`)

Sources: `imports/oto-radar/replit.md` ("OTO Radar V1"), the intake notes
`docs/architecture/intake-2026-09-19/03`-`08`, and `docs/features/oto-radar.md`.

- **Pages:** the dashboard, `/survey`, `/c/:id` (campaign QR landing),
  `/redeem` (reception's spin-code redeem page) and `/tax-invoices`
  (Chalong). There was no sign-in at all: "No Auth/Sidebar: Direct public
  access to the dashboard." 107 routes, 96 of them public. Dev-to-prod
  push/wipe routes leaked data.
- **Seven tabs:**
  - Dashboard: the revenue, AOV, guest, category, source, heatmap,
    performance, insights, discount and survey cards, a sync-health
    Re-sync badge, and "Daily Adjustments & Audit".
  - Calendar: yearly heatmap, notes, a BCIS school-calendar overlay, the
    pace forecast and the Revenue Planner.
  - Trends: an AI conversational chart builder. The model produced chart
    specifications and never saw revenue rows.
  - Events: parties and F&B linking.
  - Campaigns.
  - Accounting: cash collection and transaction xlsx files, tax invoices.
  - Config: sync status, locked months, product registry, formula
    definitions.
- **Data:**
  - Pisell (Floresta, revenue formula v30) and Papaya (Chalong, v21),
    pulled every 5 minutes.
  - The wheel pushed win events and fetched 4-digit codes with an API key.
    The 10,000 codes never expire.
  - An outbound "marketing summary" feed, consumed by "Omni" (unverified).
  - 36 tables, 19 of them analytics (`funtopia_*`, `papaya_*`). Forecast,
    targets and the two-branch merge were computed in the browser from
    hard-coded 2026 constants. Branches were the strings `floresta` and
    `chalong`.
  - We hold only a structure listing of its database
    (`imports/_db/database-schema-for-oto-radar.sql`), no data.

### 2.2 `apps/radar` today (S2-18 = SCRUM-219, Deployed 14 Oct 2026)

- **Service:** `oto-radar-staging.onrender.com`, created by hand.
  - Docker, Singapore, plan `starter`, one instance, `rootDir: apps/radar`.
  - Pre-deploy runs `npm run db:migrate`; health check `/healthz`.
  - Its own database login `oto_radar`, connection limit 10, direct
    connection.
  - The `render.yaml:1311-1399` block is documentation only.
  - On 21 Oct the service was moved into the staging group
    (`STATUS.md:9`).
- **Sign-on** (`server/platformSession.ts`, `signOn.ts`):
  - Radar has no users of its own. The launcher hands off with
    `#handoff=<token>`; Radar exchanges it at the platform's
    `POST /auth/handoff/exchange` and sets an httpOnly `radar_session`
    cookie.
  - Every guarded request checks the platform's `GET /me` and
    `/me/permissions` (cached 10 s) and requires `app:radar:access`. If the
    platform is unreachable, Radar answers 503.
- **Route census** (`server/routeCensus.ts`): 46 routes. 11 are public, 4
  are key-protected (`SPIN_WIN_REDEEM_KEY` for the legacy wheel;
  `OTO_RADAR_MARKETING_API_KEY` for `GET /api/external/marketing-summary`,
  which authenticates and then answers 503 by design), and 31 are guarded.
  Any route nobody classified is guarded by default.
- **Pages:**
  - `/survey`, `/c/:id` and `/redeem` are public; everything else is the
    dashboard (`client/src/pages/funtopia-dashboard.tsx`, 10,299 lines).
  - Tabs: Dashboard (the same card set as the original), Calendar (heatmap,
    notes, pace forecast, Revenue Planner, staff birthdays), Trends (the
    OpenAI chart assistant) and Campaigns (admin and stats, booth claims).
  - Gone: the original's Events, Accounting and Config tabs and its
    tax-invoices page. The Weekly tab is commented out.
  - Global bar: Floresta/Chalong toggle, period selector, compare,
    voucher/birthday toggles and a freshness chip.
- **Figures:**
  - Every figure comes live from the platform's `GET /analytics/summary`
    (booths: `GET /analytics/booths`), through `server/sources/otoPos.ts`.
  - Radar sends **the signed-in person's own platform session**; it has no
    service credential of its own.
  - Radar's own routes: `/api/figures/{branches,today,range,calendar,freshness}`
    and `/api/spin-wheel/report`.
  - Parks are matched to platform branches by a regex on the branch name.
  - Fields the rollup lacks come back empty, not estimated: payment mix,
    top products, customer types, cash reports, per-day hourly data. So
    "Sales Insights" is effectively empty.
- **Radar's own tables** (schema `radar`, 3 migrations):
  - Surveys and campaigns: `visitor_survey_responses`, `campaigns`,
    `campaign_qrs`, `campaign_clicks`, `booth_events`.
  - Spin rewards: `spin_reward_*` (campaigns, code ledger, legacy code
    reservations, rate limits).
  - Planning: `staff_birthdays`, `branch_settings` (planner targets),
    `calendar_notes`, `pace_forecast_snapshots`.
- **Platform routes Radar reads** (`apps/api/src/routes/analytics.ts`):
  - `GET /analytics/summary`. Permission is checked per branch: one branch
    needs `pos:cash:read` or `analytics:read`; a multi-branch total adds up
    only the `analytics:read` branches. Every branch id is resolved inside
    the caller's own operator: a foreign id gets 404, an unreadable one is
    listed in `omitted`. At most 366 days per request.
  - `GET /analytics/sources` and `PUT /analytics/sources/:branchId`
    (`admin:branch:update`): the per-branch source switch. Radar no longer
    uses it.
  - `GET /analytics/booths`.
- **Who can open it:** `app:radar:access` (`permissions.ts:351`) is held
  only by `platform_admin` and `operator_admin` (via `ALL`).
  `branch_manager` has `analytics:read` but not `app:radar:access`.
- **Possible defect, found by the sub-reader:** the public `/redeem` page
  (`qr-redeem.tsx:109`) calls the guarded `GET /api/spin-wheel/report`. A
  signed-out reception tablet would get a 401 for that panel.

### 2.3 What the owner wanted

- **2026-09-19 (later):** Radar is one of "the real apps"; "Analytics must
  come from our own database too, and Radar's history must be imported so
  cumulative totals include the past"; "a real dump is needed".
- **2026-09-20:** "Radar active at the same time … live analytics from our
  POS — a demo sale made on staging must appear in Radar". Also: "use the
  Replit code as the definition — Radar's formula for revenue" (Open
  decision 15).
- **2026-09-20 (later):** "Radar is fed real figures so it has something to
  show". The data-source switch is an admin control per branch, "from the
  OTO App's admin and from the Console".
- **2026-10-14, the deciding ruling:** "do not build the logic to integrate
  Papaya, Pisell or any other third-party POS API. Radar is built against
  the analytics of the OTO POS we are building." History remains a data
  path (S2-22 loader, Radar dump, Open decision 18), not an integration.
- **S2-18 ticket** (`SPRINT_2_PLAN.md:2610-2697`) calls Radar "the revenue
  dashboard the owner reads every day". PLATFORM_PLAN §9 (2026-09-19) adds
  "deep analysis stays in Radar"; the Console shows headline figures and
  links in.
- **Still open:**
  - B7, who opens Radar (`OWNER_QUESTIONS_2026-10-14.md:97`).
  - The Omni feed (`OWNER_CONFIRMATIONS_2026-10-13.md:176`;
    `OPEN_ITEMS.md:11`).
  - Matching parks by name.
  - The Radar database copy, and a Radar hostname redirect for printed QR
    posters (`INTERNAL_PENDING_2026-10-14.md:35-42, 71-73`).

---

## 3. Data an owner wants at a glance

Schema files are in `packages/db/src/schema/`. The Postgres schemas are
`core`, `crm`, `pos`, `promo`, `booth`, `analytics`, `edge`, `inbox`,
`assistant` and `otoapp`. **O** = `operator_id`, **B** = `branch_id`.
"Dynamic" means the route checks the permission per branch inside the
handler. Branch ids are always checked against the caller's operator.

| Domain | Tables | Aggregate / summary routes that exist | Scoping |
|---|---|---|---|
| **Sales, payments, refunds** | `sales.ts`: sale, sale_line, sale_discount, sale_tier_claim, payment_attempt, payment_notification, refund, receipt_series, band, band_event | `GET /sales` (dynamic `pos:sale:read`; one branch or every branch in reach; date or range), `/sales/lookup`, `/sales/:id`. These are lists, not aggregates | O+B; payment_notification O only; band_event via parent |
| **Rollups and reports** | `analytics.ts`: daily_summary, hourly_summary, daily_{tender,item,category,ticket,discount}_summary, dirty_date, branch_source_switch | `GET /analytics/summary` (dynamic; see §2.2); `/analytics/reports/{sales,profitability,discounts,discounts/transactions,tax/vat,tax/receipts}` (`analytics:read` per branch; `omitted` list) | B (+O) |
| **Cash and End of Day** | `cash.ts`: end_of_day, cash_movement, settlement_batch, settlement_line, occupancy_resolution | `GET /branches/:branchId/end-of-day` (`pos:cash:read`; expected per tender, float, provisional boxes; the nearest thing to a Z-report, with no separate shift close); `POST …/end-of-day/close` (`pos:cash:day_close`); `/cash-movements`; `/settlements` and `/settlements/export` (`pos:cash:read`) | O+B; settlement_line via parent |
| **Wallets** | `wallet.ts`: wallet, wallet_key (O), wallet_entry, wallet_policy, fact_wallet_liability_daily | `GET /wallets/report` (`analytics:read`; with no branch, every park in reach); `GET /wallets/credit-day` (`pos:wallet:read`, one branch) | O+B |
| **Check-in, occupancy, gate** | `checkin.ts`: registration, checkin, guardian (O), nanny, nanny_shift, release, supervision_*; `members.ts` visit, visit_child; band and band_event; `analytics.fact_occupancy_15min`; `kiosk.ts` kiosk_session | `GET /branches/:id/occupancy` (`pos:checkin:read`; live count from band_event with a stale flag); `GET /checkin/today`, `/checkin/board` (`pos:checkin:read`, one branch). No visits aggregate | O+B |
| **Bookings** | `future.ts`: booking, booking_redemption (O+B), attendee (via booking) | `GET /bookings`, `/bookings/ledger` (`pos:booking:read`, one branch). The ledger is the Console's Bookings page. Lists, not aggregates | O+B |
| **Members and children** | `members.ts`: tier, member, member_alias (O, no branch: member lookup is operator-wide by design); child (via member); member_tier_verification (B) | `GET /members` (`pos:member:list`, whole operator). No count or summary route | O |
| **Inbox** | `inbox.ts`: conversation, channel_account, team, routing_rule, template, kb_entry (O+B); message, contact, participant, assignment, tag, sla_policy, event, note, webhook_receipt, ai_turn, ai_example (O) | `GET /inbox/dashboard` (`inbox:dashboard:read`): new today, handled today, unanswered, active, average first response, by category. It covers only conversations the caller can see (`services/inbox/read-visibility.ts`) | O (+B) |
| **Customer AI usage** | `inbox.ai_turn`: input, output and cache-read tokens, latency | Daily turn and token caps enforced in `services/inbox/ai-engine.ts` (~426), `INBOX_AI_DAILY_TOKEN_CAP`. **No usage or cost route** | O |
| **Internal assistant usage** | `assistant.ts`: ask (O+B+account; tokens, latency, state `capped` with CAP_PERSON / CAP_DAILY / CAP_TOKENS), tool_call (O) | `todaysUsage()` (`services/assistant/engine.ts` ~235) with `INTERNAL_AI_PERSON_DAILY_CAP`, `INTERNAL_AI_DAILY_ASK_CAP`, `INTERNAL_AI_DAILY_TOKEN_CAP`. `GET /assistant/review/asks` (`assistant:log:review`, operator; paged list, reads audited). **No usage or cost aggregate** | O+B |
| **Audit** | `platform.ts` audit_log (O+B; B null for operator-level events) | `GET /audit` (`admin:audit:read`): operator, then the branches in reach; branchless rows hidden from branch-scoped readers; masked without `admin:audit:read_sensitive`; paged; `count=true` | O+B |
| **Ops, jobs, alerts** | `ops.ts`: ops_run (O+B+station), alert (O+B), ops_last, ops_expectation, alert_delivery (global); `sync.ts`: sync_quarantine, sync_anomaly (global), sync_event, sync_change, station_session (O+B) | `GET /ops/health` (dependencies, job register, boxes and devices, open alerts; branches in reach), `/ops/failures`, `/ops/runs`, `/ops/quarantine`, `/ops/anomalies`, `/ops/integrations` (`admin:health:read`); `POST /ops/runs/:id/retry`, `/ops/alerts/:id/acknowledge`; `GET /ops/kiosks`. Jobs: housekeeping.{idempotency,handoff,retention}, payments.{inquiry,pending}; the `oto-jobs-staging` worker is commented out | mixed; `ops_expectation`/`ops_last` platform-global |
| **Device and box health** | `fleet.ts`: box (O+B; last_heartbeat_at, last_status, agent_version), station (O+B; last_seen_at), device, device_credential; `edge.ts`: box_heartbeat (temp, uptime, outbox depth, clock offset), box_command, box_print_job, box_runtime; station_event | `POST /box/v1/heartbeat`; `GET /boxes/:id/heartbeats` (24 h; `admin:box:read`), `/boxes/:id/{log,station-events,commands}`; `GET /branches/:branchId/{boxes,stations}`. The fleet rollup is `/ops/health`; there is no cross-branch fleet summary | O+B; edge rows via box |
| **Staff attendance and payroll** | The OTO App's own `otoapp` schema (184 tables, own migrator): time_events, time_entries, timekeeping_issues, shifts, schedule_*, leave and holiday tables, about 40 payroll_* tables (payroll_runs, payslips, salary_advances…) | Only in the OTO App's Express API: `/api/timekeeping/live`, `/review`, `/api/time-off`, `/api/leave-balances`, `/api/payroll/runs/:id/reconciliation-summary`, `/api/activity-logs/summary`, `/api/checklists/today`. The platform reads only `otoapp_v.*` views (employees, events, attendees, attendance, children) plus otoapp users and branches; `/ops/health` carries OTO App job checks | the OTO App's own tenant_id / operator_id; `otoapp.branches.core_branch_id` links to the platform branch |
| **Camps, events, parties** | Events themselves are mastered by the OTO App (`otoapp_v.events`). POS side: `events.ts` event_attendee_link, event_checkin, event_drop_in_pricing; `parties.ts` party_charge, party_payment, party_edit (O+B) | `GET /events`, `/events/passes`, `/events/:id`, `/events/:id/roster` (`pos:event:read`; per-attendee, not totals). The OTO App has `/api/core/camp-checkins/today`, `/api/events/:id/camp-attendance` | O+B |
| **Stock** | `stock.ts`: stock_item, location, take, purchase_order, movement, attention, fact_stock_daily (O+B); units and lines (O); stock_level (via item and location) | `GET /branches/:branchId/stock/reports` (`pos:stock:read`, cost hidden unless allowed), `…/reports/cost-of-goods` (`analytics:read`), `…/stock/attention` | O+B |
| **Benefits, vouchers, booths** | `benefits.ts` (usage O; application O+B), `analytics.fact_benefit_daily`; promo vouchers; `analytics.fact_booth_daily` | `/analytics/reports/benefits` (+ `/transactions`); `GET /benefits/applications` (`admin:benefit:read`); `GET /vouchers/promotions/report` (`analytics:read`); `GET /analytics/booths` (+ `/export`) | O+B |

**Where the POS's own owner views live:**
- `apps/pos` Today > Performance calls `/analytics/summary` and
  `/checkin/board`.
- Today > End of Day calls end-of-day, cash-movements, settlements and
  wallet credit-day.
- The occupancy chip calls `/branches/:id/occupancy`.
- History calls `/sales*`, refunds, reprints and the wallet routes.

**Gaps for an owner-level console:**
- **No cross-operator aggregate anywhere.** Every summary resolves branches
  inside the caller's own operator (§4).
- No aggregate for members, visits or bookings: they are lists or counts
  only.
- No usage or cost view for either AI. The tokens are recorded and capped,
  but nothing reports them.
- No cross-branch fleet summary beyond `/ops/health`.
- Staff attendance and payroll figures exist only behind the OTO App's own
  API.
- No single suite-overview read model. S2-23's overview card set is
  unbuilt.
- `services/deploy-bot` (a WhatsApp deploy digest, own `DB_SCHEMA`, never
  run live) has no platform tables or routes; S2-23's `core.deploy_event`
  does not exist yet.

---

## 4. The multi-tenancy model as built

### 4.1 Permissions and roles (`packages/shared/src/permissions.ts`)

- **Format and prefixes.** Permissions are `service:resource:action`
  strings. Prefixes are `admin:*`, `pos:*`, `catalog:*`, `booth:*`,
  `inbox:*`, `assistant:*`, `analytics:read` and `app:<key>:access` (pos,
  console, oto_app, radar, booth, inbox). Scope types are
  `'operator' | 'branch' | 'department' | 'record'`.
- **No `platform:*` vocabulary.**
  - `admin:operator:create|read|update` exist, but no route checks them.
  - `admin:operator:all` guards no route either. It is a marker for
    "administers the whole operator", read by `lib/staff-scope.ts`.
- **Bundles**, which nest staff ⊆ reception ⊆ branch_manager ⊆
  operator_admin:
  - `platform_admin` = `ALL`.
  - `operator_admin` = `ALL`, the same list.
  - `branch_manager`: selling, account create/read/update, role assign,
    audit read, stations and devices, booth, health read, refund and cash
    approve, stock, catalog manage, `analytics:read`, and
    `app:pos|console|booth:access`. It has no `admin:operator:*`, no
    branch create/update and no `app:radar:access`.
  - `reception` and `staff`: as in the brief.
  - `inbox_agent`, `inbox_manager`, `inbox_admin` are created per operator
    by `platformSync`.
- **What separates platform from operator admin.** The two roles hold the
  same permissions; the difference is the scope of the assignment:
  `scope_type='operator', scope_id=NULL` means platform-wide.
  `grantCovers` (`apps/api/src/services/permissions.ts`):
  `case 'operator': return grant.scopeId === null || grant.scopeId === target.operatorId;`.
  `isPlatformWide` is true for *any* role granted with a null operator
  scope, and only a platform-wide caller can grant that
  (`assertScopeOwned`, `assertRoleDominated` in
  `services/access-control.ts`).
- **Stale comment.** `permissions.ts` says "platform_admin additionally
  bypasses operator scoping … that flag lives on the role row". No such
  flag exists: `core.role` has `operatorId`, `name`, `description`,
  `isSystem`.

### 4.2 How a request's operator is fixed

- `plugins/session.ts` `loadAuth` sets `operatorId = account.operator_id`.
  `requirePermission` defaults the target to the caller's own operator and
  branch.
- No route takes an operator target from the request, and there is no
  operator switcher.
- Sign-in is `{ phone, password }`; `findAccountByPhone` takes the first
  matching row. That is why seeded phones are kept distinct across
  operators, even though phone uniqueness is per operator.
- **Consequence:** handlers filter by `auth.operatorId`, cross-operator
  accounts give 404, and URL branches are loaded inside the caller's
  operator (SCRUM-248). A `platform_admin` **cannot see or act on another
  operator's data.** Its only cross-operator powers are:
  - the `/operators` routes (`config: { platformWide: true }` +
    `requirePlatform`);
  - `/ops/test-controls` (also gated by `OPS_TEST_CONTROLS`);
  - granting platform-wide scope;
  - the `isPlatformAdmin` flag on `/me`.

  Everywhere else it behaves exactly like the `operator_admin` of its own
  account's operator.

### 4.3 Creating a second operator today

- **API** (`apps/api/src/routes/operators.ts`, platform-wide only):
  - `GET /operators`.
  - `POST /operators {id?, name}` inserts only the operator row plus an
    audit record: no branch, departments or roles.
  - `PATCH /operators/:id` renames or archives.
  - `POST /operators/:id/administrators {id?, phone, name}` creates, in one
    transaction, an employee, an `invited` account, an `operator_admin`
    assignment scoped to that operator and a setup code sent by SMS.
- **First branch:** `POST /branches` (`admin:branch:create`) always writes
  `operatorId: auth.operatorId`, so the platform admin cannot create it.
  The new operator's admin signs in with no branch (`seatBranch` allows an
  operator-wide account to do so) and creates it. The new operator is not
  provisioned into the OTO App, Radar or the Inbox by this flow.
- **UI:**
  - POS Admin > Operators (`apps/pos/src/components/admin/access/OperatorsPanel.tsx`)
    creates and archives operators and assigns an admin. It also hosts the
    staging demo reset.
  - It is gated client-side on `admin:operator:read` ignoring scope, so
    every `operator_admin` sees the panel and then gets "Platform
    administrators only". The code comment "No operator role holds this"
    is wrong.
  - `apps/console` has no operator UI. Its Branches page only maps
    branches to the OTO App and reconciles; it creates nothing.
- **Seed** (`packages/db/src/seed/index.ts`):
  - Operator "OTO" with branches `hkt-central` ("Oto Play Park, Central
    Floresta") and `robinson-chalong` ("Oto Play Park, Robinson Chalong").
  - Anan +66900000001 holds `platform_admin` platform-wide plus
    `operator_admin`.
  - Branch managers Lek (Floresta) and Dao (Chalong).
  - "Second Operator" (`seedSecondOperator`, SCRUM-289, always run): one
    branch, an `operator_admin` scoped to itself ("never
    `platform_admin`"), one virtual box, a till, a member and a child.
  - `SEED_PROFILE=production` runs only `platformSync`.

### 4.4 Isolation

- **Tables without `operator_id`** are almost all children reached through
  a scoped parent: box_* and station_* links, sync quarantine and anomaly,
  child, visit_child, branch_holiday and tax tables (they carry
  `branch_id`), role_permission, role_assignment, session, app_identity,
  idempotency_key, auth_throttle.
- **Genuinely platform-global:** `ops_expectation` and `ops_last` (keyed by
  job name), the `alert` open-key unique index on `key` alone, and system
  roles (null `operator_id`).
- **OTO App:** its own tenancy (`tenant_id`, `otoapp.operators`), linked by
  `otoapp.branches.core_branch_id` (app migrations 0006-0010).
- **`docs/progress/BRANCH_ISOLATION_REGISTER.md`:** about 210-240 live
  probes with a "Rival Park" second operator. Defects L1-L5 were found;
  the two left after the 2026-09-22 re-test (`/ops/quarantine` unscoped,
  and `atBranch` treating any operator grant as staff of every branch) are
  fixed in code (`services/sync.ts:5833`, `lib/staff-scope.ts:46`).

### 4.5 `apps/console` and `apps/launcher` today

- **`apps/console`** (Vite/React/wouter; sections in
  `components/consoleSections.tsx`; default page Health):
  - Sign-in by phone and password or by launcher hand-off; entry needs
    `app:console:access`.
  - Pages, grouped:
    - Watch: Health, Failures, Activity.
    - The park: Booths, Booth report, Devices, Branches.
    - Selling: Bookings, Vouchers, Voucher types.
    - Connections: Integrations.
  - Gates: `admin:health:read`, `admin:audit:read`, `admin:booth:read`,
    `analytics:read`, `admin:station:read`, `admin:branch:read`,
    `pos:booking:read`.
  - Holders: `branch_manager`, `operator_admin` and `platform_admin` all
    hold `app:console:access`.
  - Missing: no sales, money, inbox, assistant, people, operator or
    app-registry page, and nothing operator-level. None of S2-23's
    `console:*` vocabulary exists.
- **`apps/launcher`:** Landing (sign-in, then tiles from `suite/apps.ts` by
  `app:<key>:access`), `/account`, `/soon/:app`, and the internal-assistant
  chat popup (`/assistant/asks`).

---

## 5. Owner questions the plan must settle

1. **Who is the super admin?** Is it the platform owner (above every
   operator) or the park's operator owner? If both, do we want two tiers:
   a platform console across operators and an operator console inside
   one? The 2026-09-20 ruling says "for the owner"; it does not say which
   owner.
2. **A real platform tier.**
   - Today `platform_admin` = `operator_admin` + a null scope, the session
     is bound to the account's operator, and no route can target another
     operator.
   - A cross-operator console therefore needs one of: an operator switcher
     (an audited "act in operator X" session), a platform account outside
     every operator, or per-operator assignments.
   - It also needs its own `platform:*` permissions, distinct from
     `ALL`. Which does the owner want?
3. **Cross-operator visibility.** May the platform owner read every
   operator's revenue, members, children, inbox and audit? Or only
   operational data (health, failures, devices, versions, AI cost) with
   business data behind an explicit, audited operator grant?
4. **Consolidated figures.** Should the console add up revenue and guests
   across operators, or only side by side per operator? (Currency and
   timezone are all THB and Asia/Bangkok today.)
5. **What stays inside each app.** Confirm the S2-23 line:
   - POS keeps catalogue, prices, tiers, tax, End of Day and its admin
     panels, including today's Operators panel.
   - The OTO App keeps HR, attendance, payroll, schedules and modules.
   - Radar keeps deep analysis, planner, targets and campaigns.
   - The Inbox keeps routing, templates and AI settings.
   - Does the console only link and show these read-only? Does POS Admin
     > Operators move to the console?
6. **Console audience.** `branch_manager` holds `app:console:access`
   today. Is the console the owner's alone (plus a few platform admins)?
   If so, does branch-manager tooling (devices, booths, bookings,
   vouchers) stay there or move to the POS admin?
7. **Booth management home.** The console (as built) or the POS admin
   (spec §12, Open decision 5)?
8. **Analytics on the console.**
   - Headline cards with a deep link to Radar, or charts too?
   - Which KPIs at a glance? Candidates: revenue per branch and total,
     guests, live occupancy, wallet liability, cash variances, open End of
     Day, booth funnel, inbox backlog, AI usage and cost, staff on shift.
   - Must staff attendance and payroll headlines come from the OTO App's
     API (the only source)?
9. **Who opens Radar** (B7). Should `branch_manager` get
   `app:radar:access`, given that Radar shows every park?
10. **AI usage and cost.** Should the console show tokens and cost per
    app, branch, person and day for the customer AI and the internal
    assistant? Should the daily caps (`INBOX_AI_DAILY_TOKEN_CAP`,
    `INTERNAL_AI_*`) become console-editable settings rather than
    environment variables? What monthly budget, and who is alerted when it
    nears?
11. **Alerts and on-call** (Open decision 17). Which channel and recipients
    out of hours? Does the morning digest go to WhatsApp, LINE or email?
    Note: `services/deploy-bot` exists but has never run live.
12. **Dangerous powers.** Are impersonation, kill switches, maintenance
    mode, demo reset, erasure and retention wanted? Who is the second
    approver for dual control while there is one platform admin?
13. **Operator onboarding.** Must "new operator" in the console be one
    action that also creates the first branch, departments, tax rule,
    starter catalogue and roles, and provisions the OTO App (its own
    `otoapp.operators` / tenant), Radar and the Inbox? Today it creates
    only the operator row and an invited admin.
14. **Per-operator controls.** Should there be feature flags, app
    enablement and usage limits per operator? (A system question only;
    keep commercial framing out of the repository.)
15. **Retention and PDPA** (Open decisions 12/33). Are the five-year floors
    for financial and child-release records right, and who executes an
    erasure request across apps?
16. **History and feeds.**
    - Do the Radar dump and the S2-22 loader land before console analytics
      is judged?
    - Is the Omni marketing feed kept, which would need a machine read of
      the rollup that does not exist today, or retired?
    - Should `/analytics/summary` carry branch codes so Radar stops
      matching by name?
17. **Fleet across operators.** Should there be one fleet view of every
    operator's boxes? Who may send remote commands (restart, reset store)
    across operators?
18. **Order of work.** Is S2-23 still after S2-22 and before S2-24/S2-16,
    or brought forward now that the Inbox and both assistants are live?
