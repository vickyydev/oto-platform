<!-- Read-only analysis of the imported Replit export, 2026-09-19. File references are relative to the export under imports/ (local only, not in git). No secret values are recorded here - variable names and locations only. -->

> **OTO Radar — spin wheel, campaigns, vouchers and other non-POS sources** - intake analysis, 2026-09-19. Markers: [V] verified by reading code, [I] inferred, [U] unknown.

# OTO Radar: spin wheel, campaigns, voucher attribution and other non-POS sources (migration analysis)

This analysis was read-only and changed nothing.

Roots used below:
- **R** = `imports/oto-radar`
- **W** = `imports/oto-wheel-fortune`

Markers: **(V)** verified by reading the code, **(I)** inferred. No secret values are printed; only variable names and locations.

## 0. Corrections to the starting assumptions

1. **Nothing in scope is authenticated except three machine endpoints. (V)**
   - `requireStaff` is defined but never imported anywhere (R/server/staffAuth.ts:76).
   - The `StaffGate` component is never rendered (R/client/src/components/staff-gate.tsx:12).
   - R/replit.md:51 states the intent: "No Auth/Sidebar: Direct public access to the dashboard".
2. **There is no "booth" entity and no "voucher booth" concept.**
   - "Sales Booth" is only a marketing-channel label derived from Pisell data.
   - `booth_events` is a misnomer: it receives only spin-wheel game events.
   - A grep for "voucher booth" has no hits.
3. **The cash collection report is not manual.**
   - It is computed on demand from Pisell payment rows.
   - The "manual cash reports" are a hardcoded array seeded at boot (R/server/funtopia.ts:8635-8780).
4. **`qr-landing.tsx` belongs to the legacy QR promo campaigns, not the wheel.**
   - Wheel customers land on the game's own `/v/<prizeId>` page (W/artifacts/spin-win/src/pages/VoucherPage.tsx).
5. **The wheel integration exists in two generations, three stores and two disjoint reports.**
   - Legacy money vouchers live in `campaign_qrs`.
   - The event log in `booth_events` dates from 2026-08-19.
   - The 4-digit `spin_reward_code_ledger` dates from 2026-09-17, only two days before this export (git log), so expect very few ledger rows.
6. **`docs/spin-wheel-integration.md` is stale.**
   - It says redeem and report need the API key or a staff cookie.
   - Commit 9094286b (2026-09-19) made both fully public.

## 1. How data arrives

| Source | How it arrives | Auth | Stored in |
|---|---|---|---|
| Sales booth | Derived from Pisell POS data; no push and no manual entry (section 4) | n/a | `funtopia_daily_cache.summary_json.sourceBreakdown` |
| Voucher booth | Does not exist in the code; the nearest thing is the face-value to channel config | n/a | n/a |
| Spin wheel, current | Game server pushes `POST /api/spin-wheel/issue` | `X-API-Key` = `SPIN_WIN_REDEEM_KEY` | `spin_reward_code_ledger` |
| Spin wheel events | Game server pushes `POST /api/ingest/spin-events`, fire-and-forget with retries. Generic `POST /api/booth/events` also exists; the wheel game never calls it | Same header, same env var | `booth_events` |
| Spin wheel, legacy money vouchers | Game server calls the public campaign endpoints (W/artifacts/api-server/src/lib/oto-analytics.ts:24,66) | None | `campaign_qrs` |
| Campaigns | Typed into the dashboard Campaigns tab | None | `campaigns` |
| QR landing | Customer browser at `/c/:id` auto-issues on load | None; cookie `qr_device_id` | `campaign_qrs`, `campaign_clicks` |
| QR redeem | Reception types a code at `/redeem` | None | `campaign_qrs.status`, or ledger `redeemed_at` |
| Visitor survey | Public `/survey` tablet page, two taps | None, no rate limit | `visitor_survey_responses` |
| Cash collection report | Derived from `funtopia_raw_payments` on demand | None | Nothing |
| "Manual cash reports" | Hardcoded seed at boot (R/server/index.ts:122-131). Also importable via `POST /api/funtopia/import-data`, header `x-push-secret` compared to `FUNTOPIA_CLIENT_SECRET` (R/server/routes.ts:1525-1527) | Seed endpoint has none | `funtopia_daily_revenue` |
| Tax invoices | Derived from Papaya raw orders, Chalong only; header settings typed in a dialog | None | `funtopia_branch_settings` ('papaya_invoice','settings') |
| Staff birthdays | Seeded by migration 0007; CRUD endpoints exist but no UI calls them | None | `staff_birthdays` |
| Marketing summary (outbound) | Pulled by an external consumer called "Omni" in comments | Bearer `OTO_RADAR_MARKETING_API_KEY` | Nothing |

## 2. Spin wheel lifecycle

1. **Win.** The kiosk registers a win on the game server. The game pushes `prize_won` with eventId `won:<winId>` (W/artifacts/api-server/src/routes/wins.ts:106-118).
2. **Customer landing.** The kiosk QR opens the game's `/v/<prizeId>` page. It reads `w=<winId>` and `c=<wonAt base36>` from the URL (VoucherPage.tsx:17-27).
3. **Issue request.** The page calls the game server. It checks the win exists and the prize matches, then forwards `{winId, prizeId, wonAt}` to Radar (W/artifacts/api-server/src/routes/spin-wheel.ts:29-49).
4. **Issue in Radar** (R/server/spinRewards.ts:139-220).
   - It runs a SERIALIZABLE transaction and locks the prize row.
   - An existing `win_id` returns the same record, even after redemption (idempotent).
   - It rejects a future `wonAt` and an inactive prize.
   - It picks a random free code that is absent from both the ledger and the legacy reservations (lines 182-195).
   - It retries up to 12 times on error 40001 or 23505.
5. **Code format.** Exactly four digits, `char(4)` with a CHECK constraint.
   - There is no signing and no token: `qrPayload` is literally the code (line 107).
   - There is no expiry: `expiresAt: null` (line 106).
   - Codes are never recycled.
   - The lifetime ceiling is 10,000 codes, including reserved legacy numeric codes (line 9; R/migrations/0010_spin_reward_codes.sql:36-44).
   - The owner approved this knowingly (R/.agents/memory/spin-wheel-code-lifetime.md).
6. **Redeem.** Anyone who has the `/redeem` URL can redeem.
   - Staff type the four digits or scan with the camera.
   - The scanner only fills the field; staff still press Redeem (R/client/src/components/qr-scanner-dialog.tsx:134-147).
7. **What redemption checks and stores** (R/server/spinRewardsRoutes.ts:108-143; spinRewards.ts:222-275).
   - Order: rate limit, then the `^\d{4}$` check, then an atomic `UPDATE ... WHERE code=$1 AND redeemed_at IS NULL`.
   - Responses are 200 Redeemed, 409 Already used, 404, 429 or 503.
   - It stores `redeemed_at` only: no staff identity, no branch, no POS order.
   - It does not check the `active` flag, so deactivated prizes stay redeemable.
   - Database triggers block UPDATE of identity columns, DELETE and TRUNCATE (migration 0010:106-143).
8. **Reporting: two disjoint reports.**
   - The `/redeem` "Reporting" panel reads `GET /api/spin-wheel/report`: won, redeemed and outstanding per prize, plus capacity.
   - The dashboard card "Spin & Win prizes" reads `GET /api/booth/claims` (R/server/storage/boothEvents.ts:108-201). It is a rollup of game events with an implicit 48-hour expiry (line 80).

### What the game sends and what Radar returns

| Call | Request | Response |
|---|---|---|
| `POST /api/spin-wheel/issue` | `winId`: 1-200 printable ASCII. `prizeId`: must be in the catalogue. Optional `wonAt`: ISO with offset, not in the future | 200 with `status:"Issued"`, `code`, `winId`, `prizeId`, `campaignId`, `displayName`, `customerValue`, `title`, `instructions`, `terms`, `wonAt`, `redeemedAt`, `expiresAt:null`, `qrPayload`. 400 for invalid input. 401 for a bad key. 409 for prize mismatch, disabled prize or exhausted capacity. 503 on outage |
| `POST /api/ingest/spin-events` | One event (R/shared/schema.ts:428-455): `eventId`, `type` (one of `prize_won`, `prize_claimed`, `prize_redeemed`, `prize_rearmed`), `at` in epoch ms, plus optional fields. Nulls are rejected. Extra keys such as `branch` survive only inside the `payload` JSON | `{ok, stored, duplicate}`; any 2xx means stored or duplicate |

**Claim grouping.** `claimId`, else `winId`, else `code:<code>`, else `eventId`. When an event carries both ids, earlier rows keyed by win are re-pointed to the claim by UPDATE (R/server/routes.ts:3526-3552).

**Join key for migration.** `spin_reward_code_ledger.win_id` equals `booth_events.payload->>'winId'`, which equals the game's `spin_wins.win_id`.

### Prize catalogue

Radar holds only the redemption text and an `active` flag (R/shared/spinRewards.ts:19-90, duplicated as a seed in migration 0010:92-102).

Probabilities live only in the game (W/artifacts/spin-win/src/config.ts:57-112):

| Prize | Probability |
|---|---|
| voucher-100 | 23.5 |
| bracelet-making | 27.5 |
| voucher-150 | 17.5 |
| voucher-200 | 14.5 |
| kids-pizza | 14.5 |
| kids-ticket-1-plus-1 | 2.5 |

`mystery-gift` exists only in Radar and is inactive.

Prize ids are hardcoded in at least five places:
- two in Radar;
- game `config.ts`;
- game `spin-wheel.ts:8-15`;
- game `radar-push.ts:57-70`.

There is no endpoint or UI to toggle `active`; it is changed by SQL only. If the database lacks a row for a prize defined in code, the whole rewards list and report return 503 (spinRewards.ts:129-135).

## 3. Booth events and campaigns

**Booth events.** This is an event log only.
- It has no booth id, location or staff.
- Rows are created only by the game.
- The dashboard's "Recent claims by prize" is computed in the browser from the latest 300 claims, so it is not a true total (boothEvents.ts:108; R/client/src/pages/campaigns-tab.tsx:396-406).

**Campaigns: data model.**
- `campaigns` has name, `promo_code`, description, status, `expires_at` and `usage_cap`.
- `promo_code` is labelled "Voucher code from POS" in the form (campaigns-tab.tsx:797); it is a Pisell voucher code.
- Anyone can create, edit or delete a campaign.

**Campaigns: issue and redeem flow.**
- The poster QR encodes `<origin>/c/<campaign uuid>`.
- The landing page issues one QR per campaign and device (R/server/storage/campaigns.ts:168-208).
- Token: 16-character base64url.
- Short code: 4 characters, the first always a letter (lines 39-52).
- The QR shown to the customer encodes the campaign's shared `promoCode`, not the token (R/client/src/pages/qr-landing.tsx:177,601).
- Radar's redeem step only marks the QR used and tells staff which promo code to apply.
- Redemption is single-use. It runs in a transaction with `FOR UPDATE` on the campaign row. It fails when the campaign is disabled, expired, or at its cap of redeemed QRs (campaigns.ts:248-300).

**Attribution loop.** When the promo code is used in Pisell, the order returns via sync with that wallet-pass code, which `VOUCHER_CODE_REGISTRY` maps to a channel. For example, the pinned code at campaigns.ts:54 is the "Review Rewards THB 100" entry in the registry.

**Reports.**
- Totals and the last 20 redemptions.
- Per-campaign funnel (clicks, saved, redeemed).
- Day, week or month series in Bangkok time (campaigns.ts:478-555).

## 4. Source registry and watchdog

**Floresta attribution** credits ticket revenue only and excludes birthday orders (R/server/funtopia.ts:5288-5479). Precedence per order:
1. `order_sales_channel`, if it matches a registry regex, takes the whole order (lines 5374-5406).
2. Wallet-pass `code` via `VOUCHER_CODE_REGISTRY` (R/server/sourceRegistry.ts:44-66).
3. Wallet-pass `title` via `SOURCE_REGISTRY` regexes (lines 6-28, order-sensitive).
4. Voucher payment amount via `funtopia_voucher_channel_map`. It supports several channels per face value and an ignored flag (lines 5421-5438).

**Wallet-pass code registry (15 codes).**
- Airport, 1 code.
- School, 1 code.
- Tops Daily, 2 codes.
- Sales Booth, 6 codes.
- Department Store, 2 codes.
- Mascot, 2 codes.
- Review Rewards, 1 code.

**Further rules.**
- Multi-channel orders split revenue evenly, but each channel counts a whole order.
- Orders carrying only non-channel vouchers are dropped from the card.
- Everything else is "Walk-in".
- A redemption is an `action` of `redeem` or `customer redeem` whose amount is not positive. This rule was patched after Pisell field drift in June 2026 (funtopia.ts:1404-1412).

**Face-value seeds** (funtopia.ts:1542-1556):

| Face value | Mapping |
|---|---|
| 250 | Airport and School |
| 150 | Mascot |
| 100 | Review Rewards |
| 1000 | Staff Rewards |
| 350 | Ignored |
| 690, 890, 1090 | Unassigned |

Any `PUT` or `DELETE` on the mapping blanks `sourceBreakdown` to `[]` on all dates. Each date is recomputed lazily on its next read (funtopia.ts:1125-1132).

**Chalong** uses a non-strict classifier on Papaya `appliedDiscounts` names. The first matching discount wins, and unknown names become their own bucket (R/server/papaya.ts:647-656).

**Watchdog** (R/server/sourceWatchdog.ts): Floresta only.
- It alerts when a source had orders on at least 30% of the cached days 4-30 back, and had zero orders on all of the last three completed days.
- It needs at least 7 cached look-back days, and all 3 recent days must be cached.
- It is exposed at `GET /api/funtopia/source-watchdog` and polled hourly by the dashboard.

## 5. Marketing summary, cash collection, tax invoices

**Marketing summary** (R/server/marketingSummary.ts:98-141).
- It returns total revenue, total visitors and birthday package revenue across both parks.
- Birthday revenue excludes linked party F&B (food & beverage) and applies Chalong manual overrides.
- The range is limited to 366 days.
- The rate limit is 60 requests per minute. The limiter is in memory (lines 143-179), so it is per process; the deployment target is autoscale (.replit).

**Cash collection report** (R/server/cashCollectionReport.ts).
- It produces one Excel row per deduplicated Pisell payment (latest version per payment id, SQL at lines 335-364), plus a period total.
- Pisell local time strings are treated as Bangkok wall-clock time (lines 89-137).
- Net is zero when the status is `voided`.
- The receipt number is the payment date as `yyyymmdd` plus the numeric suffix of the order code.
- Probably used by Floresta accounting (I).

**Tax invoices** (R/server/papaya.ts:2485-2627).
- They re-render completed Papaya orders as 80 mm "Receipt / Tax Invoice (ABB)" PDFs, the Thai abbreviated tax invoice.
- Available per invoice, in bulk, as a ZIP, and as a print view.
- Download is blocked until the terminal's POS Tax ID is set (R/client/src/pages/tax-invoices.tsx:413-422).
- Header defaults are hardcoded at papaya.ts:2499-2511.

## 6. Auth

**Staff auth as written** (R/server/staffAuth.ts).
- It compares a single shared password, `STAFF_PASSWORD`, in constant time.
- It issues cookie `staff_session` containing `nonce.exp.HMAC-SHA256` keyed by the password.
- The cookie lasts 12 hours and is HttpOnly, SameSite Lax.
- The three `/api/staff/*` routes work, but nothing enforces them.

**Endpoints.**

| Endpoint | Actual auth |
|---|---|
| `POST /api/spin-wheel/issue` (routes file:74) | API key |
| `POST /api/ingest/spin-events`, `POST /api/booth/events` (R/server/routes.ts:3492,3514) | API key, same env var |
| `GET /api/external/marketing-summary` (routes.ts:3409) | Bearer key |
| `POST /api/spin-wheel/redeem`, `GET /api/spin-wheel/report`, `GET /api/spin-wheel/rewards` | Public; redeem is rate-limited |
| `GET /api/booth/claims` (3560) | Public; phone and code are masked |
| `/api/campaigns` CRUD, stats, timeseries (3627-3680, 3894-3924) | Public |
| `/api/public/campaigns/:id`, `.../qr`, `/api/public/qr/:token/saved` (3738-3807) | Public |
| `GET /api/qr/lookup/:token`, `POST /api/qr/redeem` (3810-3891) | Public; `redeemedBy` is optional free text |
| `/api/visitor-survey*` (3357-3403) | Public |
| `/api/staff-birthdays` CRUD (3683-3735) | Public |
| `/api/funtopia/voucher-mappings*`, `source-watchdog` (1120-1283) | Public |
| Cash collections, cash-reports, seed-cash-reports (742, 2430, 2442) | Public |
| `/api/papaya/invoices*`, `invoice-settings` GET and PUT (610-673) | Public |

**PINs.** Radar has none. The game hardcodes `REARM_PIN` at W/artifacts/spin-win/src/config.ts:240, in the client bundle.

**CORS.** Radar sends no CORS headers, so the game proxies every Radar call through its own server (oto-analytics.ts:1-3).

## 7. Tables

| Table | Purpose and key columns | Created by |
|---|---|---|
| `spin_reward_campaigns` | Prize registry; only `active` is read at runtime. Columns: `campaign_id` PK, `prize_id` UNIQUE | Raw SQL, migration 0010; not in Drizzle |
| `spin_reward_code_ledger` | One row per win. Columns: `win_id` UNIQUE, `code` UNIQUE, `won_at`, `redeemed_at`. Immutability triggers | Migration 0010 |
| `spin_reward_legacy_code_reservations` | All-numeric campaign codes that must never be reissued; immutable | Migration 0010 |
| `spin_reward_rate_limits` | Limiter buckets keyed by sha256; never pruned | Migration 0010 |
| Trigger on `campaign_qrs` | Blocks new all-numeric short codes | Migration 0010:48-61 |
| `booth_events` | Game event log. Columns: `event_id` UNIQUE, `event_type` CHECK (5 values), `claim_id`, `prize_name`, `phone`, `code`, `occurred_at`, `payload` jsonb | Migrations 0008 and 0009; also in R/shared/schema.ts:371-392 |
| `campaigns` | QR promo campaigns | Drizzle plus migration 0004; `description` is in no migration |
| `campaign_qrs` | `token`, `short_code`, `device_id`, `status`, `issued_at`/`saved_at`/`redeemed_at`, `redeemed_by`. UNIQUE on (campaign, device) | Migrations 0004-0006; CHECK `length IN (4,6)` is in no migration |
| `campaign_clicks` | One row per landing call | Migration 0004 |
| `visitor_survey_responses` | `branch`, `visitor_type`, `discovery_channel`, `submitted_at` | Drizzle plus migration 0003 |
| `staff_birthdays` | Nickname, full name, branch, department, birth month, day and year | Migration 0007 with a seed of about 60 staff |
| `funtopia_voucher_channel_map` | `face_value` PK, `channels` text[], `ignored`, `note` | Raw SQL inline, funtopia.ts:523-543 |
| `funtopia_daily_revenue` | Manual cash rows; `branch` is `floresta` or `robinson` | Raw SQL inline, funtopia.ts:1567-1583 |
| `funtopia_branch_settings` | Key/value store; holds the invoice settings | Raw SQL inline |

**Migrations.** Migrations run at boot (R/server/ensureSchema.ts) and only if they are listed in `migrations/meta/_journal.json`. Never run `db:push`: drizzle-kit would drop the raw-SQL revenue tables (R/.agents/memory/drizzle-push-hazard.md).

## 8. Env vars (names only) and hardcoded config

**Radar env vars.**
- `SPIN_WIN_REDEEM_KEY` (R/server/spinRewardsRoutes.ts:23; routes.ts:3470)
- `STAFF_PASSWORD` (staffAuth.ts:8)
- `OTO_RADAR_MARKETING_API_KEY` (marketingSummary.ts:9)
- `FUNTOPIA_CLIENT_SECRET`, reused as the push secret (routes.ts:1526)
- `DATABASE_URL`
- `NODE_ENV`
- `PORT`
- `LOG_RESPONSE_BODY`

**Game env vars.**
- `SPIN_WIN_REDEEM_KEY` (W/artifacts/api-server/src/lib/radar-spin.ts:13)
- `RADAR_INGEST_KEY` (W/artifacts/api-server/src/lib/radar-push.ts:106). It must hold the same value, because Radar checks both endpoints against `SPIN_WIN_REDEEM_KEY`.
- `RADAR_INGEST_URL` (radar-push.ts:77)

**Radar's production URL in the game.**
- It is hardcoded at radar-spin.ts:1 and oto-analytics.ts:9.
- Only the event push has an env override.

**Hardcoded config.**
- Prize catalogue.
- Channel regexes and the 15 Pisell code mappings in `sourceRegistry.ts`.
- `STANDARD_CHANNELS` (R/client/src/pages/funtopia-dashboard.tsx:3180-3190).
- Survey enums (schema.ts:280-287).
- Branch ids `floresta` and `chalong`, but `robinson` in cash reports and `"Floresta"` in game events.
- `PINNED_PROMO_CODES` (campaigns.ts:54).
- "Central Floresta, Floor B" on the landing page (qr-landing.tsx:282,716).
- 48-hour expiry, the limit of 60 per minute, and capacity of 10,000.
- Watchdog thresholds (sourceWatchdog.ts:30-39).
- Invoice header defaults.
- The calendar milestone "Sales Booth Launch" on 2026-02-01 (dashboard:219).

## 9. What to preserve, and target design

**Preserve.**
- The whole spin ledger. Outstanding codes never expire and must stay redeemable. Redeemed rows are still needed to answer "Already used" and to block code reuse.
- The reserved legacy numeric codes.
- All `campaign_qrs`. Unredeemed ones remain redeemable while their campaign is active, unexpired and under cap. Customers hold saved images that show only the short code.
- `campaigns` including their UUIDs, which are printed on posters and embedded in the game's retired-prize config.
- `campaign_clicks`, for the funnel history.
- All of `booth_events`. The payload JSON contains phone numbers.
- Survey rows (no personal data).
- `funtopia_voucher_channel_map`.
- `funtopia_daily_revenue`. Export it from the database, not the code, because imports may have added rows.
- The invoice settings row.
- `staff_birthdays`, which should move into an HR module.
- Both source registries, moved into database config.

Not needed: `spin_reward_rate_limits`.

**Cutover risks.**
- Poster QRs and the game both point at the Replit domain.
- The device cookie is lost on a new domain, so "one per device" resets.

**Target design.**
- One voucher definition table: admin-controlled type, value, terms, channel, validity and active flag.
- One voucher instance table with these fields: code, issue route, issuing station, win reference, `expires_at`, `redeemed_at`, redeeming staff, station and POS order.
- Redeem inside the POS sale, so attribution becomes exact instead of inferred from regexes and face values.
- Keep the prize catalogue and weights in the database with an admin UI.
- Make the booth a station with its own credential instead of one shared key.
- Make the marketing channel a first-class table.
- Put real staff auth on redemption, with rate limits keyed to the device credential.
- Accept the legacy formats: 4-digit codes, and 4-character alphanumeric codes whose first character is a letter.
- A longer new code format is a customer-visible decision for the owner.

## 10. Fragile, surprising or undocumented

1. **Public redeem with a bypassable limiter.**
   - The bucket is sha256 of `req.ip` plus User-Agent (spinRewardsRoutes.ts:37-42).
   - `trust proxy` is never set, so `req.ip` is probably the proxy address and the bucket is effectively User-Agent only (I).
   - Rotating User-Agent strings lets anyone burn every outstanding code in a 10,000-code keyspace.
   - The 404 versus 409 responses confirm which codes are valid, and the 409 reveals the prize and timestamps.
2. **`order_sales_channel` precedence exists only in the recompute path.** It is present in `computeFuntopiaSourceBreakdownForDate` and absent from `buildSummaryFromRawData` (funtopia.ts:4437-4498). Attribution therefore depends on which path built the day's summary. (V)
3. **The Config UI offers "Sales-booth" while the registry name is "Sales Booth".**
   - Face-value channels are used verbatim, so this produces two buckets.
   - The hyphenated one is not watched. (V)
4. **Watchdog.** It treats the invalidated sentinel `[]` as a cached day with zero sales, because only non-arrays are skipped (sourceWatchdog.ts:154). After any mapping change this can suppress or distort alerts. (V)
5. **Conflicting expiry rules.**
   - The ledger never expires.
   - The `booth_events` rollup expires claims after 48 hours.
   - The game's comments mention 24 hours.
   - With the new flow, redemption happens only in Radar's ledger, so the dashboard card will probably show prizes redeemed there as "expired" (I).
6. **Legacy 6-character short codes cannot be redeemed by code.**
   - The server requires exactly 4 characters (routes.ts:3610-3614).
   - The database CHECK allows 4 or 6.
   - The client regex allows 4-12.
7. **Schema drift.**
   - `campaigns.description` and the short-code CHECK exist in no migration.
   - The schema dump shows no foreign key from `campaign_qrs` or `campaign_clicks` to `campaigns` (R/database-schema.sql:524-535). If the dump reflects production, deleting a campaign leaves orphan QR and click rows (I).
8. **Legacy campaigns.**
   - The per-device QR is only tracking around a shared promo code.
   - Server calls without cookies, such as the wheel's, get a fresh code each time, which inflates clicks and issued counts.
   - Clicks are recorded before the campaign is checked (routes.ts:3762).
9. **`relinkBoothClaim` rewrites `claim_id` on historical rows.** `resolveWinToClaim` scans `payload->>'winId'` with no index (boothEvents.ts:42-61).
10. **Staff personal data.** The staff birthday seed, with names and birth dates, is committed to git and served by a public endpoint.
11. **Spin ledger gaps.** Spin vouchers are not linked to any POS order or channel, and they are absent from `SOURCE_REGISTRY`.
12. **Stale HR-app leftovers.**
    - R/README.md describes the old HR app.
    - R/tests/ holds its Playwright tests.
    - `.env.local` and `cookies.txt` are git-tracked. They hold only a Sentry DSN variable and an empty curl cookie jar.

## Unknowns

- Production row counts and status mix for the ledger, `campaign_qrs` (including the split of short-code lengths) and `booth_events`.
- Whether the campaign foreign keys exist in production.
- Whether `funtopia_daily_revenue` contains rows beyond the seed.
- How staff apply a spin voucher's discount in Pisell, and how they apply the promo code from the QR image.
- Whether Pisell limits reuse of a shared promo code.
- Who or what "Omni" is, and whether it is live.
- Where the wheel draw is computed (answered in `08-wheel-fortune-game.md`: in the browser).
- Whether the dump at R/database-schema.sql came from the dev or the production database.

## Key files

**Radar, server.**
- R/server/spinRewards.ts
- R/server/spinRewardsRoutes.ts
- R/server/routes.ts (lines 3353-3959)
- R/server/storage/boothEvents.ts
- R/server/storage/campaigns.ts
- R/server/sourceRegistry.ts
- R/server/sourceWatchdog.ts
- R/server/funtopia.ts (523-543, 853-897, 1125-1132, 1284-1565, 4388-4516, 5288-5479, 8613-8849)
- R/server/marketingSummary.ts
- R/server/cashCollectionReport.ts
- R/server/papaya.ts (636-668, 2485-2627)
- R/server/staffAuth.ts

**Radar, shared and client.**
- R/shared/spinRewards.ts
- R/shared/schema.ts (276-517)
- R/client/src/pages/qr-redeem.tsx
- R/client/src/pages/qr-landing.tsx
- R/client/src/pages/campaigns-tab.tsx

**Radar, migrations, docs and notes.**
- R/migrations/0010_spin_reward_codes.sql
- R/database-schema.sql
- R/docs/spin-wheel-integration.md
- R/.agents/memory/public-reception-redemption.md

**Game.**
- W/artifacts/api-server/src/lib/radar-spin.ts
- W/artifacts/api-server/src/lib/radar-push.ts
- W/artifacts/api-server/src/lib/oto-analytics.ts
- W/artifacts/api-server/src/routes/spin-wheel.ts
- W/artifacts/spin-win/src/config.ts
- W/docs/oto-radar-ingest.md
