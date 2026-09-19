# OTO Radar ("OTO Intelligence")

## What it is for
Management's revenue dashboard for both parks. It pulls sales from the two
third-party POS systems every five minutes, compiles a summary per branch per
day with versioned formulas, and shows revenue, guests, categories, marketing
sources, heatmaps, a calendar with pace forecast and targets, a revenue planner,
an AI chart assistant, a birthday / events view, QR voucher campaigns, the
spin-wheel code ledger with its reception redeem page, a visitor survey, Chalong
tax invoices and Floresta accounting exports.

## Intake
- **Source:** `imports/oto-radar/` — Replit export of 2026-09-19 (last commit the
  same day; 3,407 commits, 20 in the last 7 days — changing daily). A fork of
  the OTO App codebase: about 60% of its dependencies and all of its Playwright
  tests are HR leftovers. Detailed notes: intake files
  [03](../architecture/intake-2026-09-19/03-radar-pisell-pipeline.md),
  [04](../architecture/intake-2026-09-19/04-radar-papaya-pipeline.md),
  [05](../architecture/intake-2026-09-19/05-radar-api-auth-env-schema.md),
  [06](../architecture/intake-2026-09-19/06-radar-frontend.md),
  [07](../architecture/intake-2026-09-19/07-radar-booths-spin-vouchers.md).
- **Real or mockup:** **live**, on Replit autoscale with Replit Postgres
  (`oto-app-simple-fork.replit.app`). Not on AWS.
- **Stack:** React 18 + Vite 7 + Tailwind 3 + shadcn + Recharts (one
  15,354-line dashboard file, ~12% dead); Express; raw SQL for the analytics
  tables, Drizzle for campaigns; OpenAI via the Replit proxy (the model only
  produces chart specifications — it never sees revenue rows). 13 unit-test
  files next to the pipelines; builds do not typecheck (~70 errors).
- **Data sources:**
  - **Pisell** (Floresta; "Funtopia" in the code) — `POST /openapi/report/gateway`
    with report types for orders, line items, payments and wallet-pass usage;
    MD5-signed headers; pages of 100.
  - **Papaya** (Chalong; reception and restaurant outlets) — `GET /orders` with
    one bearer token per outlet; fetched in 2-hour slices because cursor
    pagination is broken.
  - **Spin wheel** — win events and code issue, pushed by the game with an API key.
  - No feed exists for a "sales booth" or "voucher booth": *Sales Booth* is a
    marketing channel derived from Pisell voucher codes and face values.
- **Its tables:** 36 application tables — 19 analytics (`funtopia_*`, `papaya_*`,
  `pace_forecast_snapshots`), 10 campaign / spin / survey, 6 unused HR leftovers,
  `session`. We hold **structure only**: the file in `imports/_db/` is a schema
  listing, not a restorable dump, and has no data, triggers or grants.
- **Export vs production:** unknown until a real dump exists. Dev and published
  databases are known to differ, and stored history has gaps (August 2026
  audit: 6,502 of 7,686 Pisell orders stored; several days empty).
- **Shared entities it touches:** none properly. Branches are the strings
  `floresta` and `chalong`, hard-wired for exactly two (one table family per
  branch; the browser merges two results). No users, no customers.
- **Replit-specific dependencies to replace:** AI env names, a dead object-storage
  module, dev plugins, and the dev-to-production "push / wipe" routes.
- **Secrets found in the export:** `.replit` (seed admin values, a default Pisell
  client id), `fixtures/users.json`, `.env.local`; a migration seeds ~58 staff
  names and birth dates. The Pisell and Papaya credentials are **not** in the
  export — they exist only in Replit Secrets.

## How the numbers are defined today
| | Floresta (Pisell), formula v30 | Chalong (Papaya), formula v21 |
|---|---|---|
| Revenue | Cash basis: Σ(payment − refund) minus voucher-method payments; VAT-inclusive | `order.total` on completed orders; VAT-inclusive, probably including the restaurant's service charge |
| Category, customer type, guests | Derived from product names, category titles, list prices and socks sold | Derived from item names and four hard-coded category ids; no customer types |
| Marketing source | Sales channel → wallet-pass code (15 mapped) → title pattern → voucher face value | Name of the first discount on the order |
| Birthdays | Package detection + note cross-references + heuristic F&B linking + manual overrides | Channel name + per-day manual totals |
| History | From 2025-12-01 | From early 2025 |

Forecast model, targets, pace, holidays and the two-branch merge are computed
**in the browser** from hard-coded 2026 constants.

## Integration plan
- **Deployable:** one service serving UI and API; exactly one always-on
  instance (fixes the sync gaps autoscale causes); direct Postgres connection
  (session advisory locks); `TZ=UTC`; Node ≥ 20.19.
- **Login:** none exists — 96 of 107 routes are public, including destructive
  ones. Put the platform sign-on in front of everything except the customer
  pages (`/c/:id`, `/survey`), the reception `/redeem` page until redemption
  moves into the POS, and the key-protected machine routes. Role-gate sync and
  config actions.
- **Data:** own schema `radar`. Before first boot insert the migration baseline
  row, or the app creates 107 HR tables. Drop the HR leftovers. Delete the five
  push / import / wipe routes; rotate the Pisell credentials.
- **History:** restore a real dump of the published database, re-fetch every
  day from both POS APIs while the credentials work, reconcile, then freeze
  legacy days. See [`PLATFORM_PLAN.md` §5](../architecture/PLATFORM_PLAN.md).
- **Future:** OTO POS becomes a third source writing the same daily shape into
  `analytics`; one branch-parameterised summary API replaces the browser merge;
  forecast constants, holidays, targets and notes move into tables.
- **Hostnames:** campaign poster QR codes and the wheel point at the Replit
  host; keep a redirect there after the move.
- **Launcher tile:** "Radar", shown with `app:radar:access`.

## Environment variables (names only)
| Purpose | Variables |
|---|---|
| Required to boot | `DATABASE_URL` (direct connection, table owner) |
| Runtime | `PORT`, `NODE_ENV`, `TZ=UTC`, `LOG_RESPONSE_BODY=false` |
| Pisell (Floresta) | `FUNTOPIA_API_URL` (defaults to the Pisell host), `FUNTOPIA_CLIENT_ID`, `FUNTOPIA_CLIENT_SECRET`, `FUNTOPIA_ACCESS_TOKEN` |
| Papaya (Chalong) | `PAPAYA_RECEPTION_TOKEN`, `PAPAYA_RESTAURANT_TOKEN` |
| Spin wheel | `SPIN_WIN_REDEEM_KEY` |
| External marketing API | `OTO_RADAR_MARKETING_API_KEY` |
| AI chart assistant | `AI_INTEGRATIONS_OPENAI_API_KEY` (`_BASE_URL` unset off Replit) |
| Unused | `STAFF_PASSWORD` (gates nothing), the object-storage and `SEED_ADMIN_*` names |

## Status
| Area | State | Notes |
|---|---|---|
| Code review of the export | done | 2026-09-19 |
| Real database dump | **missing** | structure listing only |
| POS API credentials | **missing** | Replit Secrets |
| Vendor import into `apps/radar` | not started | |
| Hosting, schema, sign-on gate | not started | |
| History restore and reconciliation | not started | needs the two items above |
| Summary API on `analytics` | not started | after POS core |

## Open questions
- Which database is authoritative, dev or published?
- Do Pisell or Papaya restrict API access by source IP? How far back does each
  API serve history?
- Who or what is "Omni", the consumer of `/api/external/marketing-summary`?
- Does Papaya's `total` include the restaurant service charge?
- Revenue definition to use once OTO POS is the source.
- Several hard-coded 2026 lunar holiday dates look wrong and feed the pace
  model — confirm against an official calendar before moving them into tables.
