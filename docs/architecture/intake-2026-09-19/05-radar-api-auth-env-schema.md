<!-- Read-only analysis of the imported Replit export, 2026-09-19. File references are relative to the export under imports/ (local only, not in git). No secret values are recorded here - variable names and locations only. -->

> **OTO Radar — API surface, auth, environment, schema** - intake analysis, 2026-09-19. Markers: [V] verified by reading code, [I] inferred, [U] unknown.

# OTO Radar application shell: runtime requirements for re-hosting off Replit

Radar can boot off Replit with only `DATABASE_URL` set. Two things must be fixed before it faces the internet: there is no authentication at all, and one public endpoint sends the Pisell secret and customer data to any URL a caller supplies.

This was a read-only analysis; nothing was modified, installed or run. No secret values appear below, only variable names and locations.

Conventions:
- `ROOT` = `imports/oto-radar`. Every `file:line` is relative to it.
- **[V]** means verified by reading the code or by a grep. **[I]** means inferred.

## Headline findings

1. **The "No Auth" claim is accurate, and it covers destructive operations too.** [V]
   - 96 of 107 routes are public.
   - `requireStaff` (`server/staffAuth.ts:76`) is never applied to any route.
   - The `StaffGate` component (`client/src/components/staff-gate.tsx:12`) is never rendered.
2. **Critical: `POST /api/funtopia/push-to-production` leaks a secret and customer data.** [V] (`server/routes.ts:1873-1900`)
   - It is public and does not validate `productionUrl`.
   - It POSTs every row of 10 tables, including customer name, phone and email, to the caller-supplied URL.
   - It sends the value of `FUNTOPIA_CLIENT_SECRET` in the `x-push-secret` header.
   - Its sibling `wipe-production` does restrict the URL to `*.replit.app` / `*.repl.co` (`routes.ts:1794`).
3. **On a fresh database the boot-time migrator creates the entire HR schema.** [V]
   - That is 107 tables and 23 enums from migrations `0000`–`0002`.
   - It is skipped only when `public.branches` already exists or the tracker table has rows (`server/ensureSchema.ts:35-52`).
4. **Python, Google Drive, Xero, Twilio, Rekognition, S3, nodemailer, Sentry, passport and sessions are all dead fork code.** The import census in section 4 proves it. [V]
5. **`tests/` is 100% inherited HR Playwright tests.** Every API path they call is missing on the Radar server. The real Radar tests are the `node:test` files next to the code. [V]
6. **The two schema files are byte-identical (same SHA-256), and the file is not restorable SQL.** It is a drizzle-kit-style introspection, not a `pg_dump`. [V]

## 1. API route inventory (107 routes)

| File | Routes |
|---|---|
| `server/routes.ts` | 98 |
| `server/spinRewardsRoutes.ts` | 4 |
| `server/staffAuth.ts` | 3 |
| `server/replit_integrations/object_storage/routes.ts` | 2 |

Auth legend:
- **PUB**: no check at all.
- **KEY-X**: `X-API-Key` equals `SPIN_WIN_REDEEM_KEY`, timing-safe compare.
- **KEY-B**: Bearer token equals `OTO_RADAR_MARKETING_API_KEY`, timing-safe compare.
- **KEY-P**: `x-push-secret` equals `FUNTOPIA_CLIENT_SECRET`, plain `!==` compare.

Lines refer to `server/routes.ts` unless another file is named.

### Sync control (24 routes, all PUB)

| Method | Path | Line | Purpose |
|---|---|---|---|
| POST | /api/sync-today | 76 | Sync today for all branches or one branch |
| POST | /api/funtopia/sync | 1306 | Pisell sync. `quick` covers yesterday to today and runs inline. `full` covers a range in the background with default start 2026-01-01. Honours the 30-minute push protection. |
| GET | /api/funtopia/sync-progress | 1447 | In-memory progress state |
| GET | /api/funtopia/sync-status | 1465 | Last sync info from the database |
| GET | /api/funtopia/sync-health | 1079 | Per-date health rows |
| POST | /api/funtopia/resync-date | 1093 | Synchronous re-pull of one date |
| POST | /api/funtopia/regenerate | 1285 | Rebuild summaries from raw rows, synchronous |
| POST | /api/funtopia/process | 1483 | Same as above, in the background |
| GET | /api/funtopia/process-progress | 1516 | In-memory progress state |
| POST | /api/funtopia/wallet-passes/backfill | 1229 | Backfill voucher usage from Pisell |
| POST | /api/papaya/sync | 490 | Background range sync, one terminal or both |
| GET | /api/papaya/sync-progress | 542 | In-memory progress state |
| POST | /api/papaya/process | 549 | Background regenerate |
| GET | /api/papaya/process-progress | 579 | In-memory progress state |
| POST | /api/papaya/clear-cache | 583 | **Destructive**: deletes the Papaya cache |
| GET | /api/papaya/status | 675 | Whether tokens are configured; no database access |
| GET | /api/papaya/sync-status | 684 | Cache coverage |
| GET | /api/papaya/sync-health | 1129 | Per-date health rows |
| POST | /api/papaya/resync-date | 1143 | Re-pull one date |
| POST | /api/papaya/regenerate-summaries | 698 | Synchronous regenerate |
| GET | /api/sync-status/overview | 3242 | Both sources combined |
| GET | /api/sync-status/calendar | 3310 | Coverage per month |
| GET | /api/pos-staleness | 1108 | "POS stopped uploading" alert. The client polls this every 5 minutes. |
| GET | /api/funtopia/source-watchdog | 1120 | Alerts when a revenue source records zero orders |

### Dashboard summaries (11 routes, all PUB)

| Method | Path | Line | Purpose |
|---|---|---|---|
| GET | /api/funtopia/today | 1011 | Floresta today |
| GET | /api/funtopia/range | 2224 | Floresta range, with a 2-minute in-memory cache |
| GET | /api/funtopia/adjustments | 997 | Refund, void and adjustment detail |
| GET | /api/funtopia/order/:orderId | 937 | Order detail. **Returns unmasked customer name, phone and email.** |
| GET | /api/funtopia/formulas | 770 | Formula registry and version |
| GET | /api/funtopia/hourly-compare | 2092 | Debug |
| GET | /api/funtopia/debug-products | 2078 | Debug; calls Pisell live |
| GET | /api/papaya/today | 147 | Chalong today |
| GET | /api/papaya/daily/:date | 174 | One day. The client does not use it. |
| GET | /api/papaya/range | 187 | Range aggregate |
| GET | /api/papaya/orders-by-discount | 593 | Discount drill-down |

### Config, locked months and overrides (11 routes, all PUB, all mutating)

| Method | Path | Line |
|---|---|---|
| GET, POST | /api/funtopia/locked-months | 1814, 1822 |
| GET, PUT | /api/funtopia/preferences/birthday-allocation | 778, 793 |
| GET, PUT | /api/funtopia/voucher-mappings | 1157, 1202 |
| POST | /api/funtopia/voucher-mappings/seed | 1259 |
| DELETE | /api/funtopia/voucher-mappings/:faceValue | 1270 |
| GET | /api/funtopia/product-registry | 1833 |
| POST, DELETE | /api/funtopia/product-registry/:key/override | 1845, 1864 |

### Calendar, planner, targets and notes (10 routes, all PUB)

| Method | Path | Line |
|---|---|---|
| GET | /api/funtopia/calendar-range | 2274 |
| GET | /api/papaya/calendar-range | 2353 |
| GET, POST | /api/funtopia/calendar-notes | 2452, 2465 |
| GET, PUT | /api/planner/target | 828, 844 |
| GET, PUT | /api/planner/plan | 871, 894 |
| POST | /api/pace-snapshots | 2499 |
| GET | /api/pace-snapshots/:branch/:month | 2541 |

Planner targets and plans are stored in `funtopia_branch_settings` under the keys `planner_target_YYYY-MM` and `planner_plan_YYYY-MM`.

### Events and the birthday linker (4 routes, all PUB)

| Method | Path | Line |
|---|---|---|
| GET | /api/events/range | 2119 |
| GET | /api/events/candidates | 2158 |
| POST | /api/events/link | 2179 |
| DELETE | /api/events/link | 2203 |

### Trends and the AI assistant (3 routes, all PUB)

| Method | Path | Line | Notes |
|---|---|---|---|
| POST | /api/funtopia/trends-parse | 2840 | The LLM turns a natural-language question into a chart spec. This is the endpoint the client uses. |
| POST | /api/funtopia/chart-builder | 2905 | No LLM. The server computes the chart data. |
| POST | /api/funtopia/trends | 2572 | LLM. Legacy; the client never calls it. |

### Cash reports, tax invoices and exports (8 routes, all PUB)

| Method | Path | Line | Purpose |
|---|---|---|---|
| GET | /api/funtopia/cash-reports | 2430 | Read cash reports |
| POST | /api/funtopia/seed-cash-reports | 2442 | Re-run the hardcoded seed |
| GET | /api/funtopia/reports/cash-collections | 742 | XLSX export |
| GET | /api/funtopia/reports/detail-transactions | 714 | XLSX export |
| GET, PUT | /api/papaya/invoice-settings | 610, 620 | Stored in `funtopia_branch_settings` (`papaya_invoice`, `settings`) |
| GET | /api/papaya/invoices | 638 | Read from `papaya_orders.raw_json` |
| GET | /api/papaya/invoices/:terminal/:id | 660 | One invoice |

Invoice PDFs and ZIPs are generated in the browser with jspdf and jszip.

### Dev-to-prod data push (5 routes; a Replit workflow that is obsolete off Replit)

| Method | Path | Line | Auth |
|---|---|---|---|
| POST | /api/funtopia/import-data | 1522 | KEY-P |
| POST | /api/funtopia/wipe-data | 1729 | KEY-P. Runs `TRUNCATE … CASCADE` on 10 tables. |
| POST | /api/funtopia/wipe-production | 1779 | PUB. The target URL is restricted to Replit domains. |
| POST | /api/funtopia/push-to-production | 1873 | **PUB, target URL unvalidated** (headline finding 2) |
| GET | /api/funtopia/push-progress | 2069 | PUB |

### Campaigns and QR (11 routes)

| Method | Path | Line | Auth |
|---|---|---|---|
| GET, POST | /api/campaigns | 3627, 3636 | PUB |
| PATCH, DELETE | /api/campaigns/:id | 3652, 3671 | PUB |
| GET | /api/campaigns/stats | 3894 | PUB |
| GET | /api/campaigns/timeseries | 3903 | PUB |
| GET | /api/public/campaigns/:id | 3738 | PUB by design |
| POST | /api/public/campaigns/:id/qr | 3757 | PUB by design. Sets a 1-year `qr_device_id` cookie. |
| POST | /api/public/qr/:token/saved | 3797 | PUB by design |
| GET | /api/qr/lookup/:token | 3810 | PUB |
| POST | /api/qr/redeem | 3837 | PUB |

### Booth and spin rewards (7 routes)

| Method | Path | Location | Auth |
|---|---|---|---|
| POST | /api/booth/events | routes.ts:3492 | KEY-X |
| POST | /api/ingest/spin-events | routes.ts:3514 | KEY-X |
| GET | /api/booth/claims | routes.ts:3560 | PUB. Phone and code are masked (`storage/boothEvents.ts:88-99`). |
| GET | /api/spin-wheel/rewards | spinRewardsRoutes.ts:54 | PUB |
| POST | /api/spin-wheel/issue | spinRewardsRoutes.ts:74 | KEY-X |
| POST | /api/spin-wheel/redeem | spinRewardsRoutes.ts:108 | PUB, rate-limited via the database |
| GET | /api/spin-wheel/report | spinRewardsRoutes.ts:145 | PUB |

`docs/spin-wheel-integration.md:21-24,112` says redeem and report require the key or a staff cookie. The code requires neither. `.agents/memory/public-reception-redemption.md` confirms that this is intentional, because `/redeem` runs on a reception tablet.

### Survey, staff birthdays, external API and staff auth (11 routes)

| Method | Path | Location | Auth |
|---|---|---|---|
| GET | /api/visitor-survey/branches | routes.ts:3357 | PUB |
| POST | /api/visitor-survey | routes.ts:3361 | PUB |
| GET | /api/visitor-survey/summary | routes.ts:3377 | PUB |
| GET, POST | /api/staff-birthdays | routes.ts:3683, 3697 | PUB. Staff personal data. |
| PATCH, DELETE | /api/staff-birthdays/:id | routes.ts:3710, 3726 | PUB |
| GET | /api/external/marketing-summary | routes.ts:3409 | KEY-B, plus a 60/min limit held in memory |
| GET | /api/staff/me | staffAuth.ts:91 | PUB |
| POST | /api/staff/login | staffAuth.ts:99 | Shared password |
| POST | /api/staff/logout | staffAuth.ts:119 | PUB |

The staff-birthdays feature uses Radar's own table, not the HR `employees` table.

### Object storage (2 routes, HR and Replit template leftovers)

| Method | Path | Location | State |
|---|---|---|---|
| POST | /api/uploads/request-url | object_storage/routes.ts:46 | **Dead.** It checks `req.isAuthenticated()`, and passport is never installed, so it always returns 401. |
| GET | /objects/:objectPath(*) | object_storage/routes.ts:81 | PUB. Returns 500 without `PRIVATE_OBJECT_DIR`. No client code references it. |

### Other observations on the route surface

- **Health: there is no health endpoint.** Use `/api/papaya/status` or `/api/staff/me` for a Render health check. Neither touches the database.
- **HR leftovers on the HTTP surface:**
  - The two object-storage routes above.
  - The `rawBody` capture in `server/index.ts:9-22`, a webhook leftover.
  - Every HR route the old tests call returns nothing on this server: `/api/user`, `/api/employees`, `/api/branches`, `/api/schedule/*`, `/api/core/tasks`, `/api/contracts` and the rest. [V]
- **Cache keys that look like routes.** `/api/branch/today`, `/api/branch/range`, `/api/dashboard/summary` and `/api/calendar/range-slim` appear in the client, but they are React Query cache keys with custom `queryFn`s (`funtopia-dashboard.tsx:11949`, `9854`). They are not endpoints.

## 2. Authentication

- **No global auth middleware.** `server/index.ts` installs only a JSON parser (50 MB limit), a urlencoded parser (50 MB limit) and a logger.
- **Staff "session".**
  - It is a stateless HMAC-SHA256 cookie named `staff_session` with a 12-hour lifetime. It is `HttpOnly`, `SameSite=Lax` and `Secure`.
  - `STAFF_PASSWORD` is both the login password and the HMAC key (`staffAuth.ts:4-35`).
  - No database table is consulted. No user or staff table is read anywhere.
  - It gates nothing.
- **API keys** are as shown in the tables above. With an env var unset:
  - The `X-API-Key` and Bearer routes fail closed with 503.
  - The `x-push-secret` routes fail closed with 403.
- **CORS:** none. No `cors` import exists. The SPA is same-origin.
- **Security headers and CSRF:** no helmet, no CSRF protection.
- **Rate limiting** exists in only two places:
  - The marketing summary has a per-process in-memory limit of 60/min (`marketingSummary.ts:143-179`).
  - Spin redeem uses the Postgres table `spin_reward_rate_limits`, keyed by sha256(ip + User-Agent), at 60/min.
  - **`trust proxy` is never set.** Behind any proxy, `req.ip` is the proxy's address, so the spin bucket is effectively shared per User-Agent. [V]
- **Admin seeding: none in Radar.**
  - `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` are hardcoded as literals in `.replit:63-64`, and no code reads them.
  - Treat that password as compromised. If the HR app seeds its admin from the same values, this is a live exposure. [I]
- **Other credentials tracked in git:**
  - `fixtures/users.json`: 5 personas, each with the keys `email`, `password`, `fullName`, `role`.
  - `.env.local`: `VITE_SENTRY_DSN`.
  - `migrations/0007_add_staff_birthdays.sql`: 58 staff names and birth dates seeded in a migration.
- **Exposure:**
  - `client/public/robots.txt` allows all crawlers on an unauthenticated revenue dashboard.
  - Its sitemap line points at an `oto-hr` Replit host.
  - `vite.config.ts:33` publishes source maps.

## 3. Background work at boot

| When | What | Where |
|---|---|---|
| Before listening | `runMigrations()`: creates the `drizzle` schema and tracker table, then runs the drizzle `migrate()` from `process.cwd()/migrations`. An unreachable database crashes the boot. | `server/index.ts:80-81`, `server/ensureSchema.ts` |
| +5 s, then every 5 min | `syncTodayBackground()`: Pisell today and Papaya today for the reception and restaurant terminals. The database warm-up has 3 tries with 5 s and 10 s backoff. | `routes.ts:102-141` |
| Inside each Pisell cycle | Re-pull yesterday until 12:00 Bangkok time. Check D-1 and D-2 for stale data, with one cheap count call per day. | `funtopia.ts:2361-2507` |
| +3 s | `seedCashReports()`: inserts a **hardcoded array** covering Jan 12 to Mar 24 2026 into `funtopia_daily_revenue` when there are fewer than 140 manual rows. No UI or API adds rows to this table. | `index.ts:122-131`, `funtopia.ts:8613-8799` |
| +3 s, only if Pisell is configured | `backfillWalletPassesOnStartup()` | `funtopia.ts:1241-1274` |
| +33 s, then every 24 h | Revenue-divergence monitor. It reads the database only and writes `console.warn`; there is no alerting. | `funtopia.ts:5671-5688` |
| Ad hoc | 250 ms debounce flush of product-registry upserts | `funtopia.ts:7209-7218` |
| SIGTERM | Close the server, then force exit after 3 s. In-flight syncs are killed. | `index.ts:153-163` |

`backfillWalletPassesOnStartup()` runs four steps in order:
1. A one-off cache clear behind a meta flag.
2. A duplicate-order cleanup under an advisory lock.
3. A product-registry load and backfill into an in-memory Map.
4. A wallet-pass backfill of up to 200 dates with 500 ms pacing, which takes minutes.

**The app creates its own schema lazily with raw DDL:**

| Tables | Where created |
|---|---|
| 7 `funtopia_*` tables | `funtopia.ts:429-556` |
| `funtopia_branch_settings` | `funtopia.ts:904` |
| Cash reports, calendar notes, locked months, sync health | `funtopia.ts:1567-1623` |
| Product registry | `funtopia.ts:7054` |
| Papaya cache, orders, items, birthday overrides | `papaya.ts:791-868` |
| Papaya sync health | `papaya.ts:1035` |
| `pace_forecast_snapshots` | `routes.ts:2479` |
| Duplicate DDL for 4 tables | `routes.ts:1541-1599` (inside import-data) |

Several `ensure*` functions have no ready-flag and run DDL on every call:
- `getBranchSetting`
- `getLockedMonths`
- `getVoucherChannelMap`, which runs about 15 statements each time.

Consequence: the runtime database role must own the tables and hold CREATE rights on the schema.

**Behaviour under Replit autoscale:**
- Timers run only while an instance is alive. The "5-minute sync" is really "while someone has the dashboard open, plus once per cold start". The code carries scars from this:
  - Cold-start comments at `db.ts:15`, `routes.ts:103` and `script/build.ts:5`.
  - The stale-day and yesterday catch-up logic.
- With more than one instance, each runs its own timers.
  - Pisell syncs are serialized by a session-level `pg_advisory_lock('funtopia:api-sync')` (`funtopia.ts:1718-1749`). They run one after another rather than being skipped.
  - Papaya syncs have no cross-process lock; they rely on upserts.
- All of the following is per-process state, so cross-instance progress polling lies:
  - Sync progress and running flags.
  - The push state.
  - The 2-minute range cache.
  - The product-registry Map.
  - The marketing rate bucket.

**What this implies for an always-on host:**
- Run exactly one instance. That is a better fit than autoscale and fixes the sync gaps.
- `DATABASE_URL` must be a direct connection. A transaction-mode pooler such as PgBouncer breaks session-level advisory locks: the code would log "lock was not owned" and later syncs can block.
- Keep `TZ=UTC`. Some date maths relies on the server running in UTC. [I]

## 4. AI assistant and third-party packages

- **Provider:** the OpenAI SDK (`openai@^6.16`) through the Replit AI Integrations proxy (`routes.ts:2574-2577`, `2842-2845`).
  - It is configured by `AI_INTEGRATIONS_OPENAI_API_KEY` and `AI_INTEGRATIONS_OPENAI_BASE_URL`.
  - The model is `gpt-5.4-mini`, at temperature 0.1 (`routes.ts:2751`, `2877`).
- **What the model sees:**
  - `trends-parse` receives a system prompt (today's date plus a hardcoded metric list), the user message and the previous chart spec.
  - The legacy `trends` endpoint also receives the day count, the date range and client-supplied history. The `role` field in that history is not validated.
  - **No revenue rows ever reach the model.** It returns a JSON chart spec, and the server computes the data from `funtopia_daily_cache` and `papaya_daily_cache`. [V]
- **Conversations** are stored in browser `localStorage` under `oto-trends-history` (`funtopia-dashboard.tsx:7998-8009`). Nothing is stored in the database.
  - The `conversations` and `messages` tables in `shared/models/chat.ts` are imported by nothing, appear in no migration and are absent from the dump. They are dead. [V]
- **Off Replit:** set a real OpenAI key and drop the base URL, or point it at another compatible provider. Unknown: whether that model id exists on a direct OpenAI account.

**Import census.** A grep of every `from` and `import(` in `server/` and `shared/` shows the server imports only these packages:
- express
- drizzle-orm
- drizzle-zod
- pg
- zod
- xlsx
- openai
- @google-cloud/storage
- vite and nanoid, on the dev path only

The following are **never imported** anywhere in `server/`, `shared/`, `client/src/` or the scripts:
- `googleapis`, `google-auth-library`
- `xero-node`
- `twilio`
- `@aws-sdk/*`, which covers Rekognition and S3
- `nodemailer`
- `@sentry/*`
- `@replit/object-storage`
- `passport`, `passport-local`
- `express-session`, `connect-pg-simple`, `memorystore`
- `multer`
- `handlebars`
- `pdf-parse`
- `ws`
- `@uppy/*`, `@tiptap/*`, `react-signature-canvas`

Related leftovers:
- **Google Drive** survives only as the `.replit:58` agent integration entry, two unused `branches` columns (`shared/schema.ts:135-136`) and a client filter for a source id the server never emits.
- The `allowlist` in `script/build.ts:7-31` is itself dead, because its only use is commented out at `:45`.
- `client/replit_integrations/audio/` is unreferenced.

## 5. Object storage

- **Radar stores nothing in object storage.** No client code calls the upload or object routes, and `buildStorageKey` (`server/storage/objectStorage.ts`) is never imported.
- The implementation uses `@google-cloud/storage` against the Replit sidecar at `http://127.0.0.1:1106` for credentials and signed URLs (`objectStorage.ts:12,36-39,316`).
  - The optional real-GCS path via `GCS_SERVICE_ACCOUNT_JSON` still signs URLs through the sidecar, so it cannot work off Replit.
  - Constructing the client at import time makes no network call, so the app still boots elsewhere. [I]
- **Action:** delete `server/replit_integrations/`. There is nothing to migrate.
- Unknown: whether the Replit bucket holds leftover HR objects.

## 6. Environment variables

The client reads none. There are zero `import.meta.env` hits in `client/src/`.

| Name | Read at | Purpose | Required? | Replit-specific? |
|---|---|---|---|---|
| `DATABASE_URL` | server/db.ts:7,14; drizzle.config.ts:3,12 | Postgres connection. Must be a direct, non-transaction-pooled connection. | **Yes**: the module throws at import without it | No |
| `PORT` | server/index.ts:99 | Listen port on 0.0.0.0, default 5000 | No | No |
| `NODE_ENV` | index.ts:92; staffAuth.ts:50; routes.ts:3594; vite.config.ts:10 | Static vs Vite serving; `Secure` cookie flag. **Hard-defined to "production" inside the bundle** (script/build.ts:53-55). | No | No |
| `LOG_RESPONSE_BODY` | index.ts:56 | Set `"false"` to stop logging JSON bodies of up to 2 KB, which can include personal data | Recommended | No |
| `FUNTOPIA_CLIENT_SECRET` | funtopia.ts:426; routes.ts:1526,1732,1798,1899 | Pisell signing secret. **Also reused as the push secret.** | For the Floresta sync | No |
| `FUNTOPIA_ACCESS_TOKEN` | funtopia.ts:427 | Pisell `Access-Token` header. `replit.md` mislabels it as the client ID. | For the Floresta sync | No |
| `FUNTOPIA_CLIENT_ID` | funtopia.ts:425 | Pisell client id. A default value is hardcoded there and in .replit:72. | No | No |
| `FUNTOPIA_API_URL` | funtopia.ts:424 | Default `https://ap.pisellapi.com` | No | No |
| `PAPAYA_RECEPTION_TOKEN` | papaya.ts:9 | Bearer token for `https://api.papaya.co.th/api/v1` (URL hardcoded at papaya.ts:8) | For Chalong tickets | No |
| `PAPAYA_RESTAURANT_TOKEN` | papaya.ts:10 | As above, for the cafe terminal | For the Chalong cafe | No |
| `SPIN_WIN_REDEEM_KEY` | routes.ts:3470; spinRewardsRoutes.ts:23 | X-API-Key for the Spin & Win game | For that integration; routes return 503 without it | No |
| `OTO_RADAR_MARKETING_API_KEY` | marketingSummary.ts:9,83; routes.ts:3410 | Bearer token for the external marketing API | For that API; returns 503 without it | No |
| `STAFF_PASSWORD` | staffAuth.ts:8 | Shared password and HMAC key, minimum 4 characters | No; gates nothing today | No |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | routes.ts:2575,2843 | AI assistant key | For the Trends AI | **Yes** |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | routes.ts:2576,2844 | AI proxy URL | No | **Yes** |
| `GCS_SERVICE_ACCOUNT_JSON`, `GCS_PROJECT_ID`, `PUBLIC_OBJECT_SEARCH_PATHS`, `PRIVATE_OBJECT_DIR` | object_storage/objectStorage.ts:15,16,67,87 | Dead object-storage feature | No | **Yes** |
| `APP_ENV`, `STORAGE_ENV_PREFIX` | server/config/env.ts:1-2 | The module throws if they are unset, but **nothing live imports it** | No | No |
| `REPL_ID` | vite.config.ts:11 | Enables Replit dev plugins | No | **Yes** |

Declared but never read:
- `VITE_SENTRY_DSN` (.env.example:4, .env.local:1)
- `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` (.replit:63-64)
- `USE_AWS_REKOGNITION`, `AWS_REKOGNITION_COLLECTION_ID`, `AWS_S3_BUCKET`, `AWS_S3_REGION` (.replit:67-70)
- The HR-era list in README.md:81-91: `SESSION_SECRET`, `SMTP_*`, `EMAIL_FROM` and others

Minimum to boot: `DATABASE_URL`. [V]

## 7. Database schema

The supplied dump and `ROOT/database-schema.sql` are byte-identical (same SHA-256). The copy under `ROOT` is not tracked in git. The dump contains 38 tables, 64 enum types and 3 schemas (`public`, `_system`, `drizzle`).

**(a) Radar analytics: 19 tables, all created by raw SQL in code, none in Drizzle**

| Table | Key | Notable columns |
|---|---|---|
| funtopia_raw_orders | id serial; indexes on order_date and order_id | `order_date` is TEXT; customer_name, customer_phone, customer_email, note, raw_json |
| funtopia_orders | id serial | Line items; product_id, variant_id, raw_json |
| funtopia_raw_payments | id serial | pay_amount, refund_amount, raw_json |
| funtopia_raw_wallet_passes | id serial | Voucher usage |
| funtopia_daily_cache | date TEXT primary key | summary_json; a magic `__meta__` row holds sync and push timestamps |
| funtopia_daily_revenue | id serial; UNIQUE(date, branch) | The cash reports; rows come only from the hardcoded seed |
| funtopia_calendar_notes | date TEXT primary key | |
| funtopia_locked_months | month TEXT primary key | |
| funtopia_branch_settings | (branch, key) | jsonb value: birthday allocation, planner targets and plans, tax-invoice settings |
| funtopia_voucher_channel_map | face_value numeric primary key | channels text[] |
| funtopia_birthday_overrides | (order_code, order_date) | Seeded from a hardcoded list at `funtopia.ts:563+` |
| funtopia_product_registry | product_key primary key | manual_override |
| funtopia_sync_health | id serial | Self-prunes at 90 days |
| papaya_orders | (id, terminal) | raw_json, payments, applied_discounts |
| papaya_order_items | id serial | |
| papaya_daily_cache | date TEXT primary key, in the form `terminal:YYYY-MM-DD` plus a `__meta__` row | |
| papaya_birthday_overrides | (order_date, terminal) | Seeded in code. The comment at `papaya.ts:858` claims it is in schema.ts; it is not. |
| papaya_sync_health | id serial | |
| pace_forecast_snapshots | (date, branch) | |

**(b) Spin, booth, campaign, QR, survey and staff birthdays: 10 tables**

| Table | Defined by | Key |
|---|---|---|
| campaigns, campaign_qrs, campaign_clicks | Drizzle plus migrations 0004-0006 | uuid. campaign_qrs has unique token, unique short_code, unique (campaign_id, device_id) and a length check. |
| booth_events | Drizzle plus migrations 0008-0009 | uuid; unique event_id |
| visitor_survey_responses | Drizzle plus migration 0003 | uuid |
| staff_birthdays | Drizzle plus migration 0007 | uuid |
| spin_reward_campaigns, _code_ledger, _legacy_code_reservations, _rate_limits | **Migration 0010 only**: not in Drizzle, no DDL in code | The ledger has unique win_id and unique code char(4). Migration 0010 also creates 4 plpgsql functions and 8 triggers, including one on `campaign_qrs`. |

**(c) Inherited HR tables: 7 tables, all in Drizzle, none read or written by Radar** [V]
- The tables are `tenants`, `operators`, `users`, `session`, `people`, `branches` and `employees`.
- The only touch is the `to_regclass('public.branches')` probe at `ensureSchema.ts:37`.
- None of the 38 tables uses any of the 64 enum types. They are pure fork residue. [V]

**(d) Infrastructure: 2 tables**
- `drizzle.__drizzle_migrations`.
- `_system.replit_database_migrations_v1`, which is Replit's publish-time schema-sync log. Drop it.

**Code versus dump**
- Every table that code references exists in the dump.
- Only the dead `conversations` and `messages` tables are in code but not in the dump.
- The 107 HR tables from migrations 0000-0002 are absent, so production went through the baseline path.

**Drift and defects in the dump**
- `users.preferred_name` exists in the database but not in the Drizzle schema.
- **The foreign keys from `campaign_qrs.campaign_id` and `campaign_clicks.campaign_id` to `campaigns` (ON DELETE CASCADE) are missing from the dump.** They are present in migration 0004 and `schema.ts:335,357`.
  - The dump does show the spin ledger's inline foreign keys, so this is probably real. [I]
  - If so, `deleteCampaign` (`storage/campaigns.ts:147`) leaves orphan rows.
- The dump has zero functions and zero triggers. It cannot tell us whether production has the migration-0010 immutability triggers.
- `CHECK (CHECK (…))` is invalid SQL.
- The per-column `UNIQUE` on `funtopia_daily_revenue.date` and `.branch` is an artifact of the export; the index list shows only the composite unique.
- The dump has no ownership or grant statements.
- **Conclusion: obtain a real `pg_dump`.**

**Migration hazards**
- `0002_add_thai_name.sql` is an orphan, not listed in the journal.
- The agent notes are stale in two places: they cite a `server/db/coreSchema.ts` that does not exist, and they credit `ensureSchema.ts` with creating the raw-SQL tables.
- **The hazard for a central Postgres:** Radar's generic table names (`users`, `session`, `branches`, `employees`, `people`, `tenants`, `operators`, `campaigns`) and the shared `drizzle.__drizzle_migrations` tracker will collide with the OTO App in one schema.
  - Give Radar its own database or schema.
  - Carry its tracker rows over, or insert a baseline row whose `created_at` is at least 1789610610552, **before the first boot**.
  - Otherwise the migrator creates 107 HR tables.
  - The `public.branches` probe is hardcoded to `public`.

## 8. Build and deploy

- **Build:** `npm run build` runs `tsx script/build.ts`.
  - Vite builds the client into `dist/public`.
  - esbuild bundles `server/index.ts` into `dist/index.cjs` (CJS, minified).
  - **All dependencies are externalized** (`script/build.ts:57`), so `node_modules` is required at runtime.
  - The build needs devDependencies. `@replit/vite-plugin-runtime-error-modal` loads unconditionally (`vite.config.ts:4,9`). The other two Replit plugins load only when `REPL_ID` is set.
  - Nothing typechecks. `replit.md` admits to about 70 existing `tsc` errors.
- **Start:** `node dist/index.cjs`, as in `.replit:18`.
  - The working directory must be the repo root, and `migrations/` must ship with the build, because `ensureSchema.ts:19` resolves it from `process.cwd()`.
  - Static files are served from `dist/public` with an SPA fallback. The `/redeem` path swaps in a different manifest and title (`server/static.ts`).
- **Node:** `.replit:1` specifies `nodejs-20`. There is no `engines` field and no `.nvmrc`.
  - Pin Node 20.19 or later, or Node 22. Vite 7 and the use of `import.meta.dirname` require it. [I]
- **Python** (`pyproject.toml`, `uv.lock`, the nix image libraries) was a one-off Pillow icon job by the Replit agent.
  - There are zero `.py` files and zero references to Python.
  - It was added by the commit "OTO custom icon kit".
  - It is not a runtime requirement. [V] for its absence, [I] for its purpose.
- **Replit-only behaviour in the code:**
  - The EADDRINUSE handler that runs `kill -9 $(lsof …)` (`index.ts:101-111`).
  - `scripts/post-merge.sh`.
  - The `[deployment]` and `[agent]` blocks in `.replit`.
  - The entire push, import and wipe group of routes.
- **Leftover artifacts in the repo that may contain personal data:**
  - `core_export.json`: 25 HR "core" tables.
  - `core_uploads_backup.zip`.
  - `oto_core_transplant.zip`.
  - `policy_documents_export.sql`.

## 9. To run this off Replit, we must

1. Take a real `pg_dump` of production, and restore it into a **dedicated database or schema**.
   - Include the `drizzle.__drizzle_migrations` rows in the restore.
   - Drop the 7 HR tables, the 64 enums and the `_system` schema.
2. Use a direct Postgres URL with no transaction pooler. The database role must own the tables and be able to run DDL.
3. Run **one always-on instance** with `TZ=UTC`, Node 20.19 or later, the build command `npm ci --include=dev && npm run build`, and the start command `node dist/index.cjs` from the repo root.
4. Set these environment variables:
   - `DATABASE_URL`
   - the 2 required `FUNTOPIA_*` secrets
   - the 2 `PAPAYA_*` tokens
   - `SPIN_WIN_REDEEM_KEY`
   - `OTO_RADAR_MARKETING_API_KEY`
   - `LOG_RESPONSE_BODY=false`
   - a real OpenAI key, which needs a two-line edit to the env var names at `routes.ts:2575-2576` and `2843-2844`
5. **Before exposing the app:**
   - Put auth in front of everything except `/c/:id`, `/survey`, `/redeem`, the `/api/public/*` routes, the spin redeem, rewards and report routes, and the key-protected routes.
   - Delete the five push, import and wipe routes.
   - Rotate the Pisell secret, the seed-admin credential, the fixture passwords and the Sentry DSN.
6. Delete `server/replit_integrations/`, the Replit Vite plugins, the robots sitemap line and the public source maps.
   - Set `trust proxy`.
   - Add `/healthz`.
7. Preserve the hostname, or redirect from the old one.
   - Campaign QR links are built from `window.location.origin` (`campaigns-tab.tsx:195`) and have already been printed or distributed.
   - The `qr_device_id` cookie and the saved AI conversations in `localStorage` are bound to the origin, so they are lost on a domain change.
   - Re-point the Spin & Win game, the external marketing-summary consumer (called "Omni" in the code) and the reception tablet PWAs.
8. Move cash-report data out of source code. No input path for it exists today.

**Unknowns**
- Whether production has the migration-0010 triggers and the campaign foreign keys.
- Row counts, and whether the HR tables hold data.
- The production Postgres version.
- Which secrets are actually set in Replit.
- Whether a custom domain is in use.
- Whether Pisell or Papaya allowlist source IPs.
- Whether the AI model id is available on a direct OpenAI account.
- The autoscale maximum-instances setting.
- Who consumes the marketing API.
- Whether the Replit bucket holds any objects.

**Lift as-is, or re-implement?** Lift it as its own service now, and fold it in later, selectively.

- **The value is in the domain logic.** About 12,000 lines in `funtopia.ts` (9,206) and `papaya.ts` (2,627) hold versioned, revenue-critical formulas and many hard-won fixes for POS quirks. They come with 13 co-located unit-test files and no typecheck safety net. Re-implementing risks silent number drift for no business gain.
- **Replit coupling is shallow.** It amounts to two AI env names, a dead storage module, dev plugins and the push workflow.
- **The Express layer is thin.** Handlers mostly import and call a domain function. A later port to Fastify is mechanical and can leave the domain modules untouched.
- **What argues against embedding it today:**
  - Timers started inside `registerRoutes`.
  - Per-process singletons.
  - DDL at runtime.
  - Session-level advisory locks.
  - Dates stored as TEXT with magic `__meta__` rows.
  - Generic table names.
  - No auth.
  All of these are safely contained in an isolated single-instance service with its own schema. All of them are hazardous inside a shared platform process.
- **Do not rewrite the ingestion.** The Pisell and Papaya ingestion is the part most likely to be retired once your own POS becomes the data source. Do not spend the rewrite there.
- **Later, in this order:**
  1. Move the sync loops into a platform worker.
  2. Replace runtime DDL with real migrations.
  3. Port routes behind platform auth.
  4. Keep the analytics formulas and the dashboard as the durable assets.

**Key files (absolute paths)**
- `imports/oto-radar/server/routes.ts`
- `…/server/index.ts`
- `…/server/ensureSchema.ts`
- `…/server/staffAuth.ts`
- `…/server/spinRewardsRoutes.ts`
- `…/server/funtopia.ts`
- `…/server/papaya.ts`
- `…/server/marketingSummary.ts`
- `…/server/replit_integrations/object_storage/objectStorage.ts`
- `…/shared/schema.ts`
- `…/migrations/meta/_journal.json`
- `…/migrations/0010_spin_reward_codes.sql`
- `…/script/build.ts`
- `…/vite.config.ts`
- `…/.replit`
- `imports/_db/database-schema-for-oto-radar.sql`
