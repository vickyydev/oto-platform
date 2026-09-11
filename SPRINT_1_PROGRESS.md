# Sprint 1 progress

## Status
- Current checkpoint: **CP5 — sprint complete, awaiting client review** (CP2–CP4 stops waived by the client on 2026-09-11 — "record and keep going"; their questions live in SPRINT_1_REPORT.md)
- Last completed ticket: all 22 (SCRUM-7…37) + acceptance run + SPRINT_1_REPORT.md; tagged `sprint-1`
- Next ticket: none — Sprint 2 pending client review of the report + Q1–Q5
- Resume instructions: `cd oto-platform && pnpm install && docker compose -f infra/docker-compose.yml up -d && pnpm db:migrate && pnpm db:seed && pnpm dev` (API :3001, POS :25741). Admin `+66900000001`/`admin1234`, reception `+66900000002`/`reception1234`. Tests: `TEST_DATABASE_URL=postgres://oto:oto@localhost:5433/postgres pnpm test`; smoke: `pnpm --filter @oto/pos exec playwright test` with the stack running. Nothing half-done.

## Verified prototype layout
Verified 2026-09-11 by running the app and walking every screen. Matches `CLAUDE.md` §2, with additions:

- `/artifacts/oto-till` — the POS prototype. React 19, Vite 7, Tailwind 4 (CSS-first config), wouter, shadcn/ui (55 components in `src/components/ui`), 316 source files / ~79k LOC.
  - `src/mockApi.ts` (5,835 ln) — all operational mock data + getters/mutators; the API swap seam.
  - `src/store/catalogStore.ts` (1,805 ln) — **per-branch** editable catalog (tiers, tickets, add-ons, menu, merch, inventory, discounts, payment methods, tax config, templates, devices, branches) with `useSyncExternalStore` reactivity.
  - `src/types.ts` (2,047 ln) — all shapes.
  - `src/lib/` — 36 pure-logic modules. `src/pages/` — 12 routes. `src/components/<surface>/` — per-surface components; `components/mobile/` is a parallel phone UI (36 files); `components/admin/` the admin console (55 files, registry-driven nav).
  - Contexts: `auth/OperatorContext` (staff login + inactivity), `branch/BranchContext`, `station/StationContext`, `store/CatalogStoreContext`, `i18n/LanguageContext`.
- `/artifacts/api-server` — Express stub (healthz only), not reused. `/lib/*` — template scaffolding (empty Drizzle schema), not reused. `/artifacts/mockup-sandbox` — component preview harness.
- `/.agents/memory/` — 27 decision notes from the prototype's development; consulted per ticket.
- `/replit.md` — prototype rules (front-end only, no browser storage, single-tier carts, two-step payment, voucher gotchas). Read in full.
- Windows dev note: the prototype's `pnpm-workspace.yaml` strips non-Linux native binaries; rollup/lightningcss/tailwind-oxide `win32-x64` binaries must be dropped into `node_modules` manually.

## Screen inventory
Routes from `src/App.tsx` (+ mobile shell). Markings: **S1** = Sprint 1 — wire to API · **LATER** = later sprint — keep on mock · **N/S** = not in scope.

| Route / screen | Components (group) | Mock data consumed | Mark |
|---|---|---|---|
| Lock screen (any route while logged out) | `components/auth/LockScreen`, `InactivityWarning`, `OperatorBadge`; `auth/OperatorContext` | `mockFaceScanIdentify`, `getEnrolledOperators`, `INACTIVITY_*` | **S1** — SCRUM-19/24: phone+password form added behind the design; "Scan my face" stays a placeholder |
| `/` Till — step 1 Identify | `till/StepIdentify`, `shared/PhoneInput`, `CustomerDisplay` (stage `identify`) | `getMemberByPhone`, `Member`, `resolveAutoTier` | **S1** — SCRUM-30/31/32 (membership check, create member, children). Booking redeem, event passes on this step: **LATER** |
| `/` Till — step 2 Customer type | `till/StepCustomerType`, `shared/VerifyTierModal` | `TierDef` list, `getDefaultTier`, `verifyMemberTier` | **S1** display of tiers via API; tier **verification UI stays mock** (CLAUDE.md §6 — later ticket) |
| `/` Till — steps 3–6 (tickets, cart, pay, confirm) | `till/StepAddTicket`, `TicketCard`, `OrderSummary`, `StepAwaitCustomer`, `StepPayment`, `StepConfirmation`, `SupervisionGate`, `ConsentCapture` | `getTicketTypes`, pricing libs, `recordSale`, wristbands | **LATER** (Sprint 2 selling) — except the **header "Weekday pricing" indicator** wires to the pricing resolver (SCRUM-36) and ticket price display reads API packages (SCRUM-35) where it renders without selling |
| `/` header (`shared/StationHeader`) | occupancy chip, `BranchSwitcher`, pricing-mode chip, theme, operator badge | `getBranches`, `todayRateMode`, occupancy | **S1**: branch list + pricing-mode chip from API. Occupancy: **LATER** (Sprint 3) |
| `/order-station` F&B | `fnb/*` (11) | wristbands, menu, orders | **LATER** (Sprint 4; wristband scan Sprint 2/4) |
| `/merch-station` Shop | `merch/*` | merch catalog, stock | **LATER** (Sprint 2) |
| `/drop-off` Check-in board | `dropoff/*` (9) | `getCheckIns`, nannies, WA status | **LATER** (Sprint 3) |
| `/parties` Events | `parties/*` (8) | parties/camps/events stores | **LATER** (Sprint 3) |
| `/history` | `history/*` (9) | transactions, refunds, reprints | **LATER** (Sprint 2) |
| `/today` (+ `/end-of-day`) | `floor/*`, `eod/*` | sales aggregates, recon | **LATER** (Sprint 2) |
| `/messages` | `MessagingPanel`, mobile messaging | WA threads | **LATER** (Sprint 4) |
| `/stock` | `mobile/stock/*` (9) | inventory, POs, stock takes | **LATER** (Sprint 2/4) |
| `/station-setup` | `pages/StationSetup` (9-step wizard), `station/DevicePicker`, `StationContext` | `getAvailableDevices`, `StationProfile` | **LATER** (devices/printers are Sprint 2); session's branch/station recorded on sign-in only (schema `station` exists) |
| `/book` public booking | `book/*` (6) | bookings, PromptPay | **N/S** Sprint 1 (Sprint 3) — keeps rendering on mock |
| `/admin` shell | `admin/AdminLayout`, `adminSections` registry (managerOnly gating) | `useOperator().role` | **S1** — becomes home for Track C screens; gating moves to real permissions (SCRUM-13/22) |
| `/admin` → Tickets | `admin/tickets/TicketsPanel`, `TicketTypeForm`, `ticketPricing.ts` | `TicketType` per-tier prices, adult rules, freebies, credit rule | **S1** — SCRUM-35 |
| `/admin` → Pricing & Money → Pricing overrides (holidays) | `admin/pricing-overrides/PricingOverridesSection` | `PricingOverride` ranges | **S1** — SCRUM-36 |
| `/admin` → Pricing & Money → Tax | `admin/tax/TaxPanel` | `TaxConfig` (rates, category rules, placement) | **S1** — SCRUM-37 |
| `/admin` → Markets & Tiers | `admin/markets-tiers/MarketsTiersSection` | `TierDef` CRUD | **S1 (read path only)** — packages need tiers; tier CRUD wiring included in SCRUM-35 scope only as read; edit stays mock unless client asks (question Q4) |
| `/admin` → Members | `admin/members/MembersPanel`, `MemberFormDialog` | members + saved children | **S1** — SCRUM-31/30/32 admin side |
| `/admin` → Branches | `admin/branches/BranchesPanel` | `Branch` registry, catalog cloning | **S1** — SCRUM-27 (+ timezone field added) |
| `/admin` → Add-ons, Menu, Categories, Modifiers, Merch, Inventory, Discounts, Payments, Devices, Templates, Supervision, Drop-off pricing, Staff benefits, Reports (5 panels) | respective `admin/*` | catalog store | **LATER** — keep on mock |
| `/admin` → *(new)* Accounts / Roles / Operators | to be added in admin design language | — | **S1 UI additions** — SCRUM-21/22/27/28 |
| Mobile shell (`<768px`) — `mobile/*` tabs | `MobileShell`, `MobileTill`, etc. | same seams | **S1 only where the iPad flow is S1** (lock, identify/member); other tabs **LATER** |

## Logic inventory (rule → prototype file:function → Sprint 1 ticket)

**Pricing & catalog**
- Per-tier kid price, `{weekday, weekend}` pair on every catalog price → `types.ts:29` `WeekdayWeekendPrice`, `TicketType.prices` (`types.ts:180`); resolved by `lib/pricingMode.ts:62` `resolveRate` → **SCRUM-35/36**
- Adult charging: per-tier rule `same_as_kid` | `set_price` | `free_adults` (+`freeAdults` count, overflow `same_as_kid`/`set_price`); default when absent = `same_as_kid`; free count applies **per line** → `lib/pricing.ts:42` `resolveAdultLine`, `types.ts:159` `TierAdultRule` → **SCRUM-35** (schema+API), selling math itself Sprint 2
- Ticket extras that the schema must hold now: `tierPricing` derivation rules (manual/percent/amount off base tier, `types.ts:133`), `freebies` (`types.ts:145`), `creditRule` (F&B credit give-back, `types.ts:174`), `gateAccess`, `hours`, `durationLabel`, per-language `translations` → `types.ts:180-210` → **SCRUM-35**
- Line total composition (kids + adults + socks + add-ons + service fee) → `lib/pricing.ts:148` `computeLineTotal`, `:188` `computeLineBreakdown` → Sprint 2 (recorded for CP2 schema awareness)
- Weekday/weekend switching: Sat/Sun = weekend (`getDay() === 0 || 6`); named inclusive holiday ranges force weekend; precedence holiday > weekday/weekend → `lib/pricingMode.ts:34` `getRateModeForDate`; `types.ts:37` `PricingOverride` → **SCRUM-36**
- POS pricing-mode indicator text ("Weekday pricing" / "Weekend pricing — {holiday}") → `lib/pricingMode.ts:11` `RateModeResult.reason`, `shared/PricingModeIndicator` → **SCRUM-36**
- Tax engine: named rates; per-category rules over categories `tickets|fnb|bar|drop_off|parties|addons|merch|stored_value`; modes inclusive/exclusive/none; per-category service charge %; optional tax-on-service; optional secondary tax; discount placement before/after tax; inclusive tax back-calculated `gross − gross/(1+r)` for reporting → `lib/tax.ts:79` `computeTaxBreakdown`, `types.ts:312-368`; seed: VAT 7% **inclusive** on all categories (stored_value none), service 0, discounts before tax → `catalogStore.ts:719` `seedTaxConfig` → **SCRUM-37**
- Per-item tax category override (add-on level `taxCategoryOverride`) → `types.ts:221` → **SCRUM-37** (`tax_override` analogue)

**Members & tiers**
- Tiers are editable config, one `isDefault` baseline enforced, `requiresVerification` flag; seed tourist(default)/expat/thai(+verify) → `types.ts:53` `TierDef`, `catalogStore.ts:792` `seedTiers`, `upsertTier` invariant `catalogStore.ts:1184` → **SCRUM-10/35**
- Tier helpers: label fallback, needs-proof, verified check, auto-tier = verified tier else default → `lib/membership.ts` (`tierLabel`, `tierNeedsProof`, `isTierVerified`, `resolveAutoTier`) → **SCRUM-30**
- Tier verification record: tier, proofType (free text e.g. Passport), verifiedBy(+id), verifiedAt → `types.ts:62` `TierVerification`; write path `mockApi.ts:703` `verifyMemberTier`; UI `shared/VerifyTierModal` → schema **SCRUM-10** (`member_tier_verification`); UI stays mock (§6)
- Member shape: phone, nickname, optional tierVerification, preferredChannel (whatsapp|telegram, default whatsapp via `lib/contactChannel.ts` `normalizeChannel`), savedChildren → `types.ts:75` → **SCRUM-31/30**
- Phone normalisation: international `+`/`00` → digits; local Thai `0XXXXXXXXX` (9–10 digits) → `66…`; comparisons on normalised digits; display grouping; country picker data `data/countries.ts` (default TH) → `lib/phoneUtils.ts:25` `normalizePhone`, `parseInternationalPhone`, `composePhone`, `formatDisplayPhone` → **SCRUM-17**
- Member lookup by phone (normalised compare; nickname optional hint only) → `mockApi.ts:680` `getMemberByPhone` → **SCRUM-30**
- Member create from phone+nickname(+channel) only; trim; enrich later via patch (phone/nickname/tierVerification/preferredChannel) → `mockApi.ts:690` `createMember`, `:717` `updateMember` → **SCRUM-31** (uniqueness per operator: no prototype logic — defined by CLAUDE.md)
- Membership check flow till↔customer display: customer types phone on display (stage `identify`); shared lifted state; `handleIdentify` → lookup → set member, auto-tier, prefer channel → step 2; walk-in skip → step 2 on default tier → `pages/Till.tsx:314` `handleIdentify`, `:323` `handleSkipIdentify`, stage derivation `Till.tsx:1442-1447`, `till/CustomerDisplay` (props-only seam), `till/StepIdentify` → **SCRUM-30** (state link becomes a short-lived server-side "pending lookup" per CLAUDE.md §7.4)
- Members-save banner + "I'm not a member — skip" wording on display → `CustomerDisplay` identify stage → **SCRUM-30** (labels unchanged)

**Children**
- Saved child shape: name, age snapshot, optional DOB (age always derived from DOB when present), allergiesMedical, dietary, foodRestrictions, notes, savedAt/updatedAt/savedBy stamps; photo NEVER stored → `types.ts:98` `SavedChild`; DOB/age derivation `lib/childDob.ts`; CRUD `mockApi.ts` `getSavedChildren`/`addSavedChild`/`updateSavedChild`/`removeSavedChild` (§736) → **SCRUM-32** (child table)
- Pre-fill/re-confirm flow: saved children OFFERED on return, parent confirms/edits each, never silently applied → `shared/SavedChildrenReview`, `lib/savedChildren.ts` (`prefillSlots`, `slotPatchFromSavedChild`, `savedChildInputFromSlot`), `Till.tsx` usage → **SCRUM-32**
- Privacy requirements for persisting children (consent record, retention, hard delete, access audit, E.164 keying) → `artifacts/oto-till/BACKEND_REQUIREMENTS.md` §Saved child profiles → **SCRUM-32/10** (consent/retention not in Sprint 1 tickets → Question Q3)
- `visit` / `visit_child` persistence: **no prototype logic — defined by CLAUDE.md** (§4); UI is the existing SavedChildrenReview confirm step feeding a draft visit → **SCRUM-32**

**Auth, session, staff**
- Staff login roster + roles: 4 seeded operators, role `staff|manager` only; face-scan identify returns first operator (mock) → `mockApi.ts:425-446` → **SCRUM-19/21** (real accounts/roles per CLAUDE.md; "Scan my face" stays placeholder)
- Inactivity lock: 2 min timeout, 15 s countdown warning; activity = pointerdown/mousedown/keydown/touchstart; logout clears operator → lock screen; full reload → locked → `mockApi.ts:607` constants, `auth/OperatorContext.tsx`, `auth/InactivityWarning` → **SCRUM-19/24** (client keeps timings; unlock becomes password)
- Manager-only gating pattern (admin nav filtered + render-blocked defense in depth) → `admin/AdminLayout.tsx:13` `visibleNavFor`, `pages/Admin.tsx:28-45` → **SCRUM-13/22** (replaced by permission checks, same UX)
- Operator stamping of mutations (verifiedBy, savedBy, changedBy + ids) → throughout `mockApi.ts` → **SCRUM-14** (audit actor)
- Password/setup/reset/rate-limit/sessions: **no prototype logic — defined by CLAUDE.md** → SCRUM-19/20/23/24/28

**Branch & station**
- Branch registry: id slug, name, country, active flag; default active branch = first seed (HKT Central); per-branch catalog with clone-from-branch; retired branches hidden from switcher → `types.ts:120` `Branch`, `catalogStore.ts:76` `seedBranches`, `branch/BranchContext`, `cloneBranchCatalog`/`branchHasCatalogData`, `admin/branches/BranchesPanel` → **SCRUM-27** (+timezone: no prototype logic — defined by CLAUDE.md)
- Branch stamping on operational records (`branchId` on sales, check-ins, stations) → mockApi throughout → **SCRUM-10**
- Station profile shape (name, branch, printer/scanner ids, capabilities) → `types.ts:1532` `StationProfile`, `station/StationContext` (per-branch in-memory map) → schema **SCRUM-10** (`station`); wiring Sprint 2
- Multi-tenant operator concept: **no prototype logic — defined by CLAUDE.md** (naming trap: prototype "Operator" = staff — see ARCHITECTURE.md §7) → **SCRUM-27**

**Locale**
- Customer-facing i18n: 5 languages en/zh/th/ru/fr; staff/admin English-only (never call `t()`); flat key dictionary `{{var}}` interpolation; missing key renders the key; per-item catalog `translations` maps with fallback to base name → `i18n/types.ts`, `i18n/LanguageContext.tsx`, `i18n/dictionary.ts`, `i18n/resolveTranslation.ts` → **SCRUM-17** (scaffold en+th per CLAUDE.md; 5-language rendering preserved — D4/Q2)
- Money display: `฿` prefix, `toLocaleString`, weekday/weekend combined display "฿100 / ฿150 wknd" → `lib/pricingMode.ts:79` `formatWWPrice` + inline throughout → **SCRUM-17** (`Money` helper reproduces formats; storage moves to satang)
- Timezone: no prototype logic (uses device local time) — **defined by CLAUDE.md** (branch tz Asia/Bangkok) → **SCRUM-17**

**Platform (no prototype logic — defined by CLAUDE.md):** permissions engine (SCRUM-13), idempotency (SCRUM-15), audit log table/endpoint (SCRUM-14 — prototype's ChangeLogEntry pattern at `types.ts:1569` is the UX precedent), file storage (SCRUM-16 — prototype `CameraCapture` takes photos but stores none).

## Ticket log

### SCRUM-7 — Decide the target stack and the API reuse boundary — **done**
- Ported from: n/a (decision ticket). Prototype structure verified by running it (all screens walked, screenshots taken).
- Added per CLAUDE.md: `ARCHITECTURE.md` written (stack, layout, reuse boundary, glossary, deviations D1–D5).
- Tests: n/a.
- Notes: `/artifacts/api-server` and `/lib/*` confirmed not-reusable (healthz stub, empty schema).

### SCRUM-8 — Inventory the existing system — **done**
- Ported from: full read of `replit.md`, `.agents/memory/*` (index + architecture notes), `types.ts`, `mockApi.ts` (targeted sections), `catalogStore.ts` (seeds/reactivity), `lib/pricing.ts`, `lib/pricingMode.ts`, `lib/tax.ts`, `lib/membership.ts`, `lib/phoneUtils.ts`, `Till.tsx` (identify flow, stage derivation), `OperatorContext`, `BranchContext`, `StationContext`, `AdminLayout`/`Admin.tsx`, `LanguageContext`.
- Added per CLAUDE.md: screen + logic inventories above; every Sprint 1 ticket has its prototype sources listed; gaps marked "no prototype logic".
- Tests: n/a.
- Deferred / notes: deeper reads of `lib/sale.ts` vouchers and admin form internals deferred to their owning tickets (Sprint 2 / SCRUM-35 respectively).

### SCRUM-9 — monorepo, environments, CI/CD, error tracking — **done**
- Added per CLAUDE.md: pnpm+Turborepo workspace (`apps/*`, `packages/*`), Docker Compose (Postgres 16 on 5433 + MinIO 9000/9001), `.env.example` (every var documented), shared tsconfig/eslint/prettier (`packages/config`), CI at repo-root `.github/workflows/oto-platform-ci.yml` (Actions only reads root `.github`; runs typecheck→lint→migrate-twice→seed→test→build against a PG16 service container), pino with request IDs + `x-request-id` echo, `/health` + `/ready`, Sentry-ready error hook (no-op without DSN).
- Tests: `/health` covered implicitly by every integration suite.
- Notes: CI green "on first push" unverifiable locally (no push made — user's call); workflow is complete.

### SCRUM-10 — data model & schema baseline — **done**
- Ported from: prototype `types.ts` shapes (TicketType/TierAdultRule/TierDef/Member/SavedChild/TaxConfig…), `catalogStore.ts` seeds (ticket packages, tiers, tax), `mockApi.ts` member seeds (Mali family w/ peanut allergy).
- Added per CLAUDE.md: full §4 table set incl. future-sprint tables; jsonb payloads validated by `@oto/shared` zod schemas; ER diagram in ARCHITECTURE.md §8; seed with dev accounts. Deviations D1–D3, D6 logged.
- Tests: migrations applied twice from empty (clean both times); every FK indexed; seed verified by all integration suites.

### SCRUM-17 — locale, timezone, currency — **done**
- Ported from: `lib/phoneUtils.ts` (incl. the `00` international-prefix edge case), `lib/pricingMode.ts` (weekend + holiday rules, `formatWWPrice`), prototype ฿ display.
- Added per CLAUDE.md: libphonenumber-js E.164 normalisation (TH default), satang `Money` helpers, branch-tz date helpers, i18n scaffold (`en` source + approved Thai strings from the prototype dictionary).
- Tests: 16 unit tests — Thai local / +66 / 00-prefix / international phones, money formats, Bangkok timezone round-trip, rate-mode dates incl. boundaries.

### SCRUM-13 — scoped permission engine — **done**
- Added per CLAUDE.md: permission constants + role bundles in `@oto/shared/permissions`; resolver (union of assignments w/ scopes; platform-wide = operator scope with null id); `req.requirePermission(perm, target)` guard on every route; `GET /me/permissions`.
- Ported from: prototype managerOnly gating UX (AdminLayout) is the UI analogue — wired later in POS.
- Tests: unit — operator/branch/department/record/platform combos + union; integration — allow (branch-scoped reception lookup), deny (reception creating a branch), 401 unauthenticated.

### SCRUM-15 — idempotency & duplicate safeguards — **done**
- Added per CLAUDE.md: middleware on all mutating routes (replay stored response; hash-mismatch 409; in-flight 409); pattern documented in ARCHITECTURE.md §9; unique constraints on member/account phone + branch code.
- Tests: same key twice → one member row + identical response; same key different body → 409 IDEMPOTENCY_MISMATCH.

### SCRUM-14 — audit log service — **done**
- Ported from: prototype's operator-stamping convention (`verifiedBy`/`savedBy`/ChangeLogEntry) generalised.
- Added per CLAUDE.md: `audit.record` called from every mutating service; `GET /audit` with entity/actor/branch/date filters, admin-guarded.
- Tests: audit rows asserted for account create, role assignment, member create, ticket-package update (with before/after); filter + guard test.

### SCRUM-16 — permission-bound file storage — **done**
- Added per CLAUDE.md: MinIO client, `file_object` rows, presigned PUT/GET issued only after owner-entity permission checks; objects never public.
- Tests: end-to-end photo upload→download byte-compare against real MinIO; foreign account file → 403; unauthenticated → 401. Suite self-skips if storage is unreachable.

### SCRUM-19/20/23/24 — sign-in, setup, recovery, sign-out — **done (backend)**
- Ported from: inactivity constants stay client-side (2 min / 15 s, mockApi.ts:607) — POS wiring next; phone formats per phoneUtils.
- Added per CLAUDE.md: argon2id; per-phone throttle (5 fails → cooldown; IP at 4×, D7); invited/inactive refusals with clear codes (SETUP_REQUIRED / ACCOUNT_INACTIVE); 6-digit single-use 10-min codes via pluggable SMS adapter (console dev adapter); reset invalidates all sessions; sign-out deletes the row.
- Tests: 11 covering every DoD incl. cooldown, code reuse, code expiry, session kill.

### SCRUM-25 — profile & photo — **done (backend)**
- `GET /me` (account+employee+branch+permissions+photoFileId), strict `PATCH /me` (non-permitted fields rejected by schema), photo via SCRUM-16 flow. Test: photo id surfaces on /me.

### SCRUM-21/22/28 — accounts, roles, login users — **done (backend)**
- `POST /accounts` (link/create employee, scoped roles, invitation code via SMS adapter), search/list, `GET /accounts/:id/permissions` (assignments + effective), add/remove role assignments, activate/deactivate (sessions killed), temp password (forces change; MUST_CHANGE_PASSWORD blocks guarded routes until changed).
- Tests: invite→setup→sign-in E2E; deactivated refused; temp-password force-change E2E; assignment audit.

### SCRUM-27 — operators & branches — **done (backend)**
- Platform-wide-gated operator CRUD + administrator assignment (invited operator_admin w/ code); branch CRUD with timezone; archived hidden from pickers.
- Tests: second operator + admin + archive-hidden; branch create/archive.

### SCRUM-31/30/32 — members, lookup, visits — **done (backend)**
- Ported from: `mockApi.ts` getMemberByPhone/createMember/updateMember semantics (normalised compare, nickname trim, preferredChannel), SavedChild field set, default-tier rule (`resolveAutoTier` → member.tierCode default tourist), last verification = active (memberWithChildren).
- Added per CLAUDE.md: operator-scoped uniqueness (409 MEMBER_EXISTS + memberId detail), visit/visit_child drafts stamping child.last_confirmed_at, children CRUD with audited allergy edits, pending-lookup session channel (D8).
- Tests: 9 covering lookup from local-format phone, duplicate across formats, enrich, child-ownership rejection, allergy audit, visit visibility.

### SCRUM-35/36/37 — packages, pricing, tax — **done (backend)**
- Ported from: seed values 1:1 (1H/2H/FD/Eat&Play incl. expat −30/−20 derivation, Thai FD free_adults:1, ฿350/500 adult admission, Eat&Play fixed ฿350), `pricingMode.ts` resolver rules, `TaxConfig` engine shape + 7% inclusive seed.
- Added per CLAUDE.md: CRUD + archive with validation (negative prices/zero hours → 400), `GET /branches/:id/pricing-mode` (tz-aware, drives the POS chip), holidays CRUD, tax config PUT + `tax_override` rows + resolver (branch → category → product precedence).
- Tests: 12 covering seeds, CRUD, validation, all five resolver date cases + boundaries, tax precedence chain, config replace.

## Post-CP5 extension (client request, 2026-09-11) — done
Client asked for: real 5-language translations end to end, the public customer side doing real login/tier pricing/bookings, live-browser testing of everything, confirmation dialogs, and failure-case handling. Delivered:
- **Public API** (`routes/public.ts`, no session): `GET /public/branches/:code/catalog` (active packages incl. translations + tiers + rate mode), `GET /public/member-tier` (nickname + tier ONLY — children/PII never leave the authed surface), `POST /public/bookings` — total computed SERVER-SIDE from the DB packages via the shared pricing port (`@oto/shared/pricing`, faithful `resolveAdultLine` semantics); booking + attendee + audit rows written; unique reference per operator (migration 0001). 7 new integration tests incl. the Thai free-adult total (฿1,590) and holiday weekend pricing.
- **/book wired**: hydrates the public catalog on load (offline → amber banner, page still works on seeds), member self-identification against the API driving tier prices (tourist ฿690 / expat ฿483 / thai ฿420 verified live), booking posts to the API first and shows the server reference on the confirmation QR (live run: OTO-1448023-1311 = the Postgres row, ฿770 both sides). Double-submit guard; API failure keeps the customer on payment with a clear toast.
- **Languages**: seed now carries real zh/th/ru/fr names + descriptions for ALL packages; shared scaffold holds all five languages (real prototype strings); `TicketCard` resolves translated names + localized "per person" (staff till unaffected — its language never changes). Live-verified: picker rendered in ไทย/中文/Русский/Français with DB-driven names; full Thai basket screenshot shows translated name + correct tier math.
- **Live browser E2E** (headless Edge, scripted): admin creates "3 Hours Play" through the real form → table, DB satang row, audit, public catalog; archive via trash → confirmation dialog → soft-deleted; full customer booking Mali end-to-end; POS mobile (390px) and /book desktop responsive checks; API-down failure banners/toasts verified with the server actually stopped.
- **Confirmations & failure handling**: AlertDialog confirms added to holiday delete, account deactivate, temp-password, operator archive (member + ticket deletes already had them); global API-401 handler locks the POS when a session dies server-side; every POS/admin write path surfaces API errors as destructive toasts and restores server truth.
- **Jira evidence pack**: `jira-comments/SCRUM-<n>.md` (24 tickets) + per-ticket screenshots in `jira-comments/attachments/` + `scripts/post-jira-comments.mjs` (uploads screenshots as issue attachments, embeds them, posts the comment; needs JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN). Awaiting credentials or the Atlassian MCP connector.
- Suites after all changes: 19 shared + 57 API + 2 Playwright — all green; typecheck clean.

## POS wiring (apps/pos) — done
The prototype was copied verbatim into `apps/pos` (316 files) and wired:
- **Auth**: `OperatorContext` now holds a real API session (sign-in → /me → permissions → manager flag); session resume on reload within TTL; inactivity timings unchanged (2 min/15 s); sign-out deletes the server session. `LockScreen` keeps its design with the phone+password form, setup and reset flows beneath the face-scan placeholder.
- **Catalog bridge** (`src/api/catalogBridge.ts`): after sign-in the store is hydrated from the API (branches+tiers+packages+holidays+tax for the active branch, satang→baht via `src/api/mappers.ts`); the wired store mutators (ticket types, holidays, tax config, branches) write through to the API optimistically with error toasts — every prototype screen keeps its exact rendering path; mock-only collections (menu/merch/inventory/…) keep their seeds per §6.
- **Membership check**: `handleIdentify` stages the display-typed phone as the session pending-lookup, consumes it, then resolves `/members/lookup` (D8, §7.4); found members map into the prototype `Member` shape (children → savedChildren); auto-tier via the ported `resolveAutoTier`; `VisitChildrenModal` (new, SCRUM-32) confirms children + edits allergies + POSTs the draft visit; unknown phone opens the create-member dialog (SCRUM-31).
- **Pricing chip**: `PricingModeIndicator` reads `GET /branches/:id/pricing-mode` (60 s refresh), local ported resolver as in-flight fallback.
- **Admin**: MembersPanel on the API (list/create/patch/archive); new `access/LoginUsersPanel` (SCRUM-21/22/28) and `access/OperatorsPanel` (SCRUM-27) in the admin design language under a manager-only "Access" group; Branches/Tickets/Holidays/Tax panels persist via the write-through bridge. Fixed the ported Tickets table stringifying the adult weekday/weekend price pair ("[object Object]") and its now-false "in-memory only" footnote.
- **i18n**: `LanguageContext` consults the `@oto/shared` en/th scaffold first, prototype 5-language dictionary as fallback (Q2/D4).
- **E2E**: Playwright smoke (`e2e/smoke.spec.ts`, msedge channel) covers lock → sign-in → lookup → child-confirm → sign-out and the create-member path — 2/2 green against the dev stack; full walkthrough also verified with screenshots.
- **tsconfig**: ported app keeps plain `strict` (base's `noUncheckedIndexedAccess`/`verbatimModuleSyntax` off — 300 untouched prototype files predate them).

## UI additions (consolidated — all built)
1. Phone + password sign-in form + setup + reset flows behind the lock screen ("Scan my face" kept as placeholder) — SCRUM-19/20/23
2. "Create member" dialog on the membership check when lookup finds nobody — SCRUM-31
3. "Who's visiting today?" children confirm/edit modal (`VisitChildrenModal`) — SCRUM-32
4. Admin → Access → Login Users panel (invite, scoped role, activate/deactivate, temp password, effective-permissions viewer) — SCRUM-21/22/28
5. Admin → Access → Operators panel (create/archive operators, assign administrators) — SCRUM-27
6. Label correction: Tickets panel footnote now says edits persist (the in-memory note became false); same fix later applied to the Members and Tax panel footnotes once those were DB-wired.
7. Profile photo upload UI deferred (endpoints + tests complete; no natural prototype home — see Deferred).
8. Admin console auth wall (`AdminAccessGate`, client-reported gap after sprint close): `/admin` no longer renders without a session. Signed out → the standard lock-screen sign-in form; signed in as staff → full-page "Manager access required" screen with Back to POS / switch-account actions; manager → console. `OperatorContext` gained `sessionResolved` so a reload inside a valid session shows a spinner, not a lock-screen flash. Header's amber "Temporary dev access" badge replaced with the signed-in "name · Manager" chip; lock-screen link relabelled "Open admin console (manager sign-in)". (Server-side authorization was already enforced per route — this closes the client-side console shell that rendered before sign-in and toasted "Couldn't load members / Not signed in".)

## Backlog candidates
- Fix prototype Admin → Tickets table rendering "Adults ฿[object Object]" (`admin/tickets/TicketsPanel` stringifies the adult-rule price object) — cosmetic, in the ported UI worth fixing when SCRUM-35 touches that table.
- Prototype `pnpm-workspace.yaml` Windows-dev DX (native binaries) — document or script for contributors.
- `.agents/memory/oto-till-architecture.md` mentions per-market member tiers (`Member.marketTiers`) — current code has single `tierVerification`; memory is stale. Multi-market tiers may return when more branches/markets open; keep schema extensible.

## Questions for the client
- **Q1 (pricing schema, D1):** Confirm the per-tier price + adult-rule model from the prototype replaces the flat `included_adults`/`overflow_adult_price` columns in CLAUDE.md §4. Also: prototype has no `wallet_credit_amount` ฿ field — it has a richer `creditRule` (who earns, basis full_price/fixed/percent). Port `creditRule` as-is?
- **Q2 (languages, D4):** CLAUDE.md specifies an en/th scaffold; the approved UI ships 5 customer languages (en/zh/th/ru/fr). Keep all five (recommended — §7 forbids UI changes), with th+en as the maintained files and zh/ru/fu carried from the prototype dictionary?
- **Q3 (child data privacy):** `BACKEND_REQUIREMENTS.md` mandates consent records + retention limits before persisting children against a phone. SCRUM-32 persists children but Sprint 1 has no consent ticket. Minimum viable: store `last_confirmed_at` (exists) + a `consent_recorded_at` column now, consent UI later — acceptable?
- **Q4 (tier admin):** Tiers are admin-editable in the prototype (Markets & Tiers panel). Sprint 1 tickets don't include tier CRUD. Wire read-only (packages reference seeded tiers) and leave tier editing on mock?
- **Q5 (tax model, D3):** Confirm the per-category tax engine (incl. secondary tax + discount placement) is the SCRUM-37 target rather than the flat `branch_tax_rule` columns; `tax_override` then means per-category/product rule precedence as in §4.

## Assumptions made (mirrors CLAUDE.md §11)
- Weekend = Sat + Sun — **confirmed in prototype** (`pricingMode.ts:49`). Holidays = named inclusive date ranges forcing weekend — **confirmed** (`PricingOverride`).
- VAT 7% inclusive — **confirmed as seed** (`catalogStore.ts:719`); service charge seeded 0; discounts before tax.
- POS locks after inactivity — **confirmed**: 2 min + 15 s warning; unlock is password (CLAUDE.md; prototype used mock face scan).
- Tier evidence rules undefined — **confirmed**; prototype captures free-text `proofType` only; verification UI stays mock this sprint.
- Included adults — **corrected by prototype** (D5): `free_adults` is per line via per-tier adult rules; not per child ticket.
- Phone unique per operator for accounts and members — no prototype conflict (mock enforces nothing); adopted from CLAUDE.md.
