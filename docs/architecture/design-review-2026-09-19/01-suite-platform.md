# 1. Shape in one picture

```
app.otoplay.co  (ONE origin, staff suite; host-only __Host-oto_session cookie)
  /                launcher  (sign-in, app grid, profile, branch switch)      apps/launcher
  /pos/            POS PWA (service worker scope /pos/ only)                   apps/pos
  /admin/          central admin: org, accounts, access, modules, devices, audit   apps/admin
  /team/           OTO App: time, tasks, events, sop, hr, sched, staff vouchers     apps/team
  /analytics/      Omni Analytics (+ Radar as its Overview unless owner objects)    apps/analytics
  /satang/         finance / expenses                                           apps/satang
  /inbox/          customer inbox ("Asset Manager" import = messaging UI)       apps/inbox
  /api/*           Fastify modular monolith (cookie auth)                       apps/api

api.otoplay.co   (same Render service, second hostname, NO cookie auth)
  /public/*        booking + website + tokenised guest links (CORS allowlist)
  /hooks/*         2C2P, LINE, WhatsApp, Instagram webhooks (HMAC verified)
  /box/*           device-key auth: registration, heartbeat, sync, WebSocket

book.otoplay.co  apps/booking  (public, static SPA)       www.otoplay.co  apps/website (public, static/SSG)
Device surfaces (not in launcher): /kiosk/ /booth/ /display/ - served by cloud, cached/served by the box, device-session auth
Boxes: <station>.<branch>.<box-domain> on the LAN, Bearer shift token, CORS allowlist = https://app.otoplay.co
```

# 2. Monolith vs services: modular monolith, enforced

One Fastify process, one pg pool (brief section 9), one deploy. Reasons specific to OTO: 1 CPU / 2 GB Render tier, a two-branch business, one small team, and cross-module transactions that matter (HR termination -> account deactivation -> session kill -> box revocation push; staff benefit at checkout reads HR profile). Microservices would buy nothing and cost the single-transaction integrity the money path needs.

The monolith is only safe if module boundaries are enforced mechanically:
- `apps/api/src/modules/<key>/{routes.ts, service.ts, repo.ts, public.ts, jobs.ts}`. Sprint 1's flat `apps/api/src/routes/*.ts` (12 plugins, ~2,300 lines with Drizzle inline, zero `.transaction(` calls) is refactored into `modules/core` (auth, me, accounts, org, access, audit, files), `modules/pos` (members, visits), `modules/catalog`.
- A module may import `@oto/api-kit`, `@oto/db` core schema + its own schema, and another module ONLY through that module's `public.ts` service interface. Enforced with eslint `no-restricted-imports` / dependency-cruiser in CI.
- Each module registers as an encapsulated Fastify plugin under `/api/<module-key>/...` with an `onRequest` module-enabled guard. Rename the Sprint 1 paths now: only 13 POS files import `apps/pos/src/api/*`, so it is cheap today and expensive after six apps exist.
- Cross-module side effects go through an in-process, Postgres-backed job/event queue (pg-boss or graphile-worker on the shared pool), declared in the manifest.
- Every write goes through `withTx(db, fn)` with the audit row inside the transaction, and every repo function takes a mandatory `operatorId`. Two tenant leaks already exist (`GET /members/:id`, `GET /public/member-tier`); eight apps copying the handler-with-inline-Drizzle pattern would multiply them.

The only separate processes: `apps/box-agent` (by definition) and, if one import proves to contain real ML/forecasting in Python, a private sidecar with a read-only role on the `analytics` schema. Dashboards, SOP search/'Ask OTO' (pgvector + LLM API from TypeScript) and customer-enquiry AI do not justify Python.

# 3. Monorepo layout

First make `oto-platform` its own git repository root. Today it is a nested workspace inside the Replit export (`C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/pnpm-workspace.yaml` globs `artifacts/*`, `lib/*`; CI sits at the parent with `working-directory: oto-platform`; `apps/pos/vite.config.ts` aliases `@assets` three directories up). Split with history preserved; the Replit export stays behind as a read-only reference repo.

```
apps/
  api/  box-agent/  launcher/  pos/  admin/  team/  analytics/  satang/  inbox/
  kiosk/  booth/  display/          device surfaces
  booking/  website/                public
packages/
  registry/     app + module manifests (pure data + zod; imported by API AND frontends)
  authz/        grantCovers / hasPermission / evaluate (moved out of apps/api/src/services/permissions.ts; also used by box-agent)
  contracts/    zod wire schemas per module (the API contract; box and cloud both implement the station subset)
  domain/       pure satang pricing/tax/sale engine (ported from apps/pos/src/lib)
  api-kit/      App type, AppError, withTx, audit, auth decorators, defineModule() - fixes the circular import caused by `App` living in apps/api/src/app.ts
  api-client/   client generated from /docs/json + transport resolver (cloud vs box)
  app-shell/    AuthProvider, useSession, can(), <Guard>, <SignInGate>, <AppFrame> (top bar, app switcher, branch switcher, profile), i18n, theme
  ui/           design system (section 8)
  db/           Drizzle, pgSchema per module, one migrations stream
  shared/       money, phone, dates, ids (shrinks to primitives)
  config/
imports/<replit-app>/   raw Replit exports - OUTSIDE workspace globs, excluded from CI/lint, never deployed
```

# 4. Apps vs modules, and the registry

`packages/registry` holds two lists.

**Apps** (launcher tiles / deployable frontends): `{ key, name, tagline, category, icon, coverArt, accent, mountPath, kind: 'native' | 'external', externalUrl?, modules: [...], status }`.

**Modules** (domain units): the module key is simultaneously the permission namespace, the pg schema name, the API prefix and the folder name.

```ts
defineModule({
  key: 'hr', name: 'People', dependsOn: ['core'],
  permissions: [{ key: 'hr:contract:read', label, group: 'Contracts', sensitive: true, scopeTypes: ['operator','branch','department'] }, ...],
  pages:    [{ key: 'hr:page:contracts', label, path: '/team/hr/contracts', nav: { section, order, icon }, requires: ['hr:contract:read'] }],
  features: [{ key: 'pos:feature:manual_discount', label, requires: [...] }],
  systemRoleGrants: { branch_manager: [...], staff: [...] },
  settingsSchema: z.object({...}),     // per-operator / per-branch module settings
  badge?: (ctx) => Promise<number>,    // launcher tile badge, time-boxed, cached 60 s
  jobs, webhooks, events
})
```

Proposed map (to be confirmed when the imports are seen): POS app -> `pos`, `catalog`, `fnb`, `care` (supervision/release), `booking`, `stock`, `wallet`; Team app -> `time`, `tasks`, `events`, `sop`, `hr`, `sched`, `perks` (staff vouchers); Inbox -> `msg`; Analytics (+Radar) -> `analytics`; Satang -> `fin`; Admin -> `core`, `devices`, `ai`; Booth -> `booth`.

**One toggle mechanism.** Three kinds of permission string by convention: `module:resource:action` (API-enforced capability), `module:page:name` (page visibility), `module:feature:name` (feature switch). Evaluation, in `packages/authz`, identical on cloud, box and browser:

```
allowed(perm, target) =
     moduleEnabled(operator, branch, module(perm))            -- entitlement layer (tenant/branch kill switch)
 AND featureEnabled(operator, branch, perm)                   -- optional operator/branch-level feature off
 AND ( roleGrantCovers(perm, target) OR accountAllowCovers(perm, target) )
 AND NOT accountDenyCovers(perm, target)                      -- deny wins, deny is scoped
page visible = allowed(page perm) AND every `requires` allowed
```

Deny exists only at account level (keeps role reasoning a pure union, as the tested Sprint 1 resolver already is). Tables in `core`: `module`, `permission` (catalog mirror: key, module, kind, label, sensitive, deprecated_at), `operator_module(operator_id, branch_id null, module_key, enabled, settings jsonb)`, `role(operator_id null, key, name, is_system)` with unique `(operator_id, key)` plus a partial unique for system roles (replaces `role_name_unique` on name alone, packages/db/src/schema/tenancy.ts:122), `role_permission`, `role_assignment(+granted_by, revoked_at - no hard delete)`, `account_permission_override(account_id, permission, effect allow|deny, scope_type, scope_id, reason, expires_at, granted_by)`, `account_app_pref(pinned, last_opened_at, default_app)`, and `account.perm_version` bumped on any change (cache key and box snapshot version).

**Registry sync**: an idempotent `platform:sync` release step after migrations upserts modules, the permission catalog and SYSTEM role bundles (system roles are code-owned and re-synced every deploy; custom roles are data-owned - a new permission lands OFF on custom roles with a 'new since last review' badge). This replaces the seed-once behaviour in packages/db/src/seed/index.ts, where a permission added later never reaches an existing database.

**Delegation rule** (fixes the live escalation in apps/api/src/routes/accounts.ts): a granter may assign a role or override only if (a) the target account is in the granter's operator, (b) the granter's own coverage includes the granted scope, and (c) the granter's effective set at that scope is a superset of what is being granted. `platform_admin` is assignable only by a platform admin. No role ranks needed.

**No more ALL bundles.** `platform_admin: ALL, operator_admin: ALL` (packages/shared/src/permissions.ts) is tolerable with 28 POS strings; it is not once `hr:contract:read`, payroll and Satang finance exist. Permissions flagged `sensitive` are never granted by wildcard; reads of sensitive resources are audited.

**Admin UX** (extends the SCRUM-21/22 screens the client commented on): role editor = toggle matrix grouped Module -> Page -> Actions/Features with dependency hints; account screen = tri-state override (inherit / allow / deny) plus an 'effective access' explainer (granted via role X at scope Y; blocked by deny Z) and a 'view as this account' launcher/nav preview.

**Frontend**: the POS's single `isManager` boolean (apps/pos/src/auth/OperatorContext.tsx, apps/pos/src/components/admin/AdminAccessGate.tsx) is replaced by `can(perm, target?)` from `@oto/app-shell`; nav is generated from manifest pages filtered by `can`. `GET /api/me/permissions` returns grants + scopes + entitlements + `permVersion`.

# 5. Launcher

- `apps/launcher` at `/`: sign-in, account setup, reset, grid, profile (the SCRUM-25 frontend the client noticed is missing), 'no access' state.
- `GET /api/me/apps` -> account, operator, active branch, branches, and `apps[]` = registry apps where at least one module is entitled for the operator/branch AND the account holds at least one page permission in it. Apps the account cannot open are absent, not greyed. Operator admins additionally get a 'Not enabled' section linking to Admin -> Modules.
- Look and behaviour modelled on the Replit grid: cover-art tiles, name, one-line tagline, category rows (Front of house / Team / Customers / Money and insight / Platform), a Recents row from `account_app_pref`, pin, search, badges (open tasks, unread conversations, fix reports) from each module's time-boxed `badge()`.
- Accounts with exactly one app, or with `default_app` set, skip the grid and land in the app. A reception iPad must never open on a grid.
- Every app's `<AppFrame>` carries the same app switcher fed by the same endpoint, plus branch switcher and profile menu, so the suite feels like one product even while inner screens keep their approved look.
- Interim honesty: tiles have `kind: 'external'` for apps not yet ported - they open the existing Replit/AWS deployment in a new tab with its own login and a small 'opens separately' marker. The client gets the full launcher on day one; each tile flips to `native` when its module passes intake. I do NOT recommend building an SSO bridge into un-ported apps: it means modifying auth in backends that are about to be discarded.
- Sign-in is a shared COMPONENT plus shared endpoints, not a shared page. `<SignInGate>` from `@oto/app-shell` renders in place inside every app on 401. This matters for the POS: an installed iOS PWA scoped to `/pos/` opens out-of-scope URLs (`/`) in an overlay browser, and the launcher is not in the POS service-worker cache when the internet is down. The POS `LockScreen` becomes a local lock that keeps the session (today it calls `signOut` and deletes the server session every 2 minutes), with `POST /api/auth/unlock`.

# 6. SSO, cookies, domains

- Staff humans on cloud: keep the opaque DB-backed session (instant revocation is already tested in apps/api/test/auth.test.ts). Rename the cookie `__Host-oto_session`: Secure, Path=/, no Domain, httpOnly, SameSite=Lax. Set `COOKIE_SECURE=true` and `trustProxy` in production (both unset today).
- NEVER set `Domain=.otoplay.co`. The marketing website and every box hostname (`*.central.otoplay.co`) share that registrable domain, so a parent-domain cookie would be sent to Pis in a mall and exposed to any XSS on the website.
- SameSite does NOT protect between `www`, `app` and box hostnames - they are all the same site. Add an Origin / `Sec-Fetch-Site` check plugin that rejects any mutating request whose Origin is not the suite origin. The `__Host-` prefix defeats cookie tossing from a compromised sibling host.
- Same service, second hostname `api.otoplay.co` for `/public`, `/hooks`, `/box`; a host guard 404s staff routes there. The cookie is never sent to it (host-only), so public and device traffic cannot ride a staff session, and WAF/rate limits can differ per hostname.
- Staff humans on a box: Ed25519 shift token minted from the cookie session (`POST /api/auth/station-token`), sent as Bearer to the box; box CORS allowlist is exactly `https://app.otoplay.co`. (Detail belongs to the box design; the suite constraint is only that the cookie never travels to a box.)
- Devices (kiosk, booth, customer display, timekeeping kiosk from SCRUM-116/117): one activation mechanism - admin creates the station, gets a pairing code, the device exchanges it for a revocable device session bound to a station and a fixed role. Not SSO clients, not launcher tiles; managed in Admin -> Devices.
- Service workers on a shared origin: the launcher registers NONE; the POS registers at scope `/pos/` only; nothing may ever register at `/`. Namespaced storage keys `oto:<app>:*`.
- Accepted tradeoff of one origin: an XSS in any mounted app can act as the signed-in user in all of them. Mitigation: all apps are first-party code built from one repo, a strict CSP per app (no inline script, no third-party CDNs - the POS index.html still loads Google Fonts), and nothing from `imports/` is mounted before passing intake.
- Hosting: one Render web service runs Fastify, which serves `/api/*` and the static builds of every app under its mount (`@fastify/static`, per-mount SPA fallback, `index.html` no-cache, hashed assets immutable + precompressed), with a CDN in front so static traffic rarely reaches the 1 CPU instance. One deploy = API and all frontends at one version, so contract skew is impossible. Because everything is path-mounted, peeling a frontend off to a static host later is a routing change, not a redesign.

# 7. Central database (suite view)

One database, one pool, Postgres schema per module via Drizzle `pgSchema`: `core` (operator, branch, department, employee identity, account, access tables, modules, audit, files, idempotency, legacy_map), then `pos`, `catalog`, `care`, `booking`, `wallet`, `stock`, `devices`, `time`, `tasks`, `events`, `sop`, `hr`, `sched`, `perks`, `msg`, `fin`, `booth`, `analytics` (rollups and materialised views only). Rules: foreign keys may point INTO `core` (and into `pos.member` where genuinely needed); modules never FK each other's internals; one migration stream. Today's 37 tables sit in `public` with names every import will also want (`employee`, `department`, `role`, `account`, `session`, `item`, `transaction`, `booking`); moving them is `ALTER TABLE ... SET SCHEMA` now and a data migration later.

Legacy data: each dump is restored into `legacy_<app>` staging schemas in a LOCAL database, transformed idempotently with `core.legacy_map(source_system, source_table, source_pk, target_table, target_id)`, reconciled by counts and totals until two runs match (brief section 12). Identity is the hard part: platform accounts are phone-keyed and unique per operator; legacy apps may key users by email, username or a Replit identity. Add nullable `account.email` and `core.account_identity(provider, subject)` for mapping; legacy password hashes will not verify under argon2, so migrated staff enter as `invited` and go through the existing SMS setup flow (or a multi-algorithm verify-then-rehash if the hash format allows).

# 8. Design system

The root Replit catalog pins the same stack for every app in that template (React 19, Vite 7, Tailwind 4, CVA, lucide, framer-motion, wouter, shadcn-style components), so unification is mostly de-duplication:
- `packages/ui`: lift the 55 components in `apps/pos/src/components/ui/` plus tokens as CSS variables in a Tailwind 4 `@theme` file; dark theme (POS, touch) and light theme (back office); density modes `touch` (44 px+ targets for POS/kiosk/booth) and `desk`.
- Self-hosted fonts: Inter plus a Thai face. No CDN fonts - this also fixes the POS offline shell.
- 'Keep the UI' (client-approved screens) means: do not redesign inner screens; unify the CHROME - AppFrame, app switcher, branch switcher, profile menu, sign-in, toasts, empty/error/offline states. Step 1 per imported app: tokens + AppFrame. Step 2: replace its private shadcn copy with `@oto/ui`. Step 3 (optional, later): visual polish.
- i18n from the shared scaffold: five customer languages for customer-facing surfaces, en/th for staff apps.

# 9. Intake procedure for each imported Replit app (a gate, not a suggestion)

0. **Land**: raw export into `imports/<app>/`, tagged, untouched lockfile. Secret scan BEFORE the first commit (Replit exports routinely carry keys in `.replit`, `.env`, or source) and rotate anything found. Dependency/licence audit.
1. **Assess** (1-2 days, written): stack; page/route inventory; data model with row counts if live; auth method; Replit-specific dependencies (Replit Auth, `@replit/object-storage`, Replit DB, `lib/integrations/*` AI helpers, `stripe-replit-sync`, `@replit/vite-plugin-*`); third parties; what is real vs mock; who uses it daily; overlap with existing modules. Classify: **A** prototype on mock data (adopt UI, build module - like oto-till); **B** live with data (module + migration + parallel run + cutover); **C** absorb/retire (function folds into another module); **D** public/static.
2. **Map**: entities -> core vs module schema; draft the module manifest (permissions, pages, features) from its screens and roles; map legacy roles to platform roles.
3. **Adopt the frontend**: copy `src` into `apps/<app>`; set Vite `base` to the mount path (the POS already honours `BASE_PATH` with wouter); replace its auth context with `@oto/app-shell`; replace its data layer (mock API, or the template's generated `lib/api-client-react` hooks) with `@oto/api-client`; strip `@replit/*` plugins and Replit boilerplate in `index.html`.
4. **Build the backend module**: schema under `packages/db/src/schema/<key>`, services with `withTx` + audit, routes validated by `packages/contracts`, integration tests with the existing `buildApp` + embedded-Postgres harness. Where legacy logic is non-trivial (payroll, schedule conflict rules, pricing), golden tests run identical fixtures through the legacy function and the port.
5. **Migrate** (class B only), per section 7.
6. **Cut over**: tile flips `external` -> `native`; legacy goes read-only; rollback plan written before the flip.
7. **Definition of done**: no own auth, no own users table, no own DB connection, no own file store; permissions in the manifest; audit on every write; repo-layer tenancy; i18n; typecheck/lint/tests in CI; mounted by path.

By stack:
- **React + Vite + Express + Drizzle** (the Replit pnpm template - same shape as `artifacts/api-server`, `lib/db`, `lib/api-zod`, `lib/api-client-react` here): the easy case. Drizzle tables move nearly verbatim under a pgSchema; Express handlers are rewritten as Fastify module routes + services; their zod specs seed `packages/contracts`.
- **Next.js**: staff apps gain nothing from SSR. Keep components; move pages into a Vite SPA, or as a cheaper middle path build with `output: 'export'` and `basePath` so it mounts statically on the one origin. Server actions and API routes become Fastify module endpoints. Never run a Next server with its own database connection.
- **Python** (the root `.replit` lists `python-3.11`): port dashboards to SQL rollups + TypeScript endpoints + React charts. Keep Python only for genuine ML, as the read-only sidecar in section 2.
- **Expo / React Native** (the root catalog pins `react 19.1.0` 'because expo requires it' and carries `@expo/ngrok-bin` overrides, so 'Wheel Fortune Mobile' is probably Expo): the brief's booth is Chromium kiosk on a Pi driving a TV, so the game must be web. Rebuild it as `apps/booth` reusing art and animation design; do not ship react-native-web to a Pi. The 'two variants' become two game layouts selected in booth config, which is what brief section 11 already asks for.

**Strangler scope.** Strangle code, not production traffic. For class A apps there is no legacy traffic to strangle. For the live OTO App, do NOT run HR/branch/employee data in two systems of record with sync between AWS RDS and the platform: build the modules complete on staging, rehearse the migration repeatedly, cut over in one window (consistent with brief section 12: 'The old system stays live on the client's AWS until cutover').

# 10. Public Website and Booking, separately

- **Website** (`www`): content, not platform. Static/SSG (Astro or a prerendered Vite build) on a static host with SEO metadata; no database, no staff cookie; reads `GET /public/*` (hours, prices, events) with CDN caching; contact forms post into the `msg` module's public intake endpoint. If the Replit site is a client-rendered SPA it needs prerendering to be indexable - the POS `index.html` shows the Replit default of `robots: index, follow` on an unrendered shell.
- **Booking** (`book`): split `/book` out of the POS SPA (apps/pos/src/App.tsx line 98) into `apps/booking`, still React + Vite, reusing `@oto/ui` and `@oto/domain` so totals are computed by the same engine the server re-runs (decision D9 in ARCHITECTURE.md). Payment is the 2C2P Redirect hosted page. Bookings need a client-minted id - today `POST /public/bookings` ignores the Idempotency-Key and a double submit creates two bookings.
- **Guest links** from the OTO App (invitation RSVP SCRUM-144, menu selection SCRUM-145, camp registration SCRUM-146, drop-off forms SCRUM-148, public guest check-in SCRUM-122): consolidate into the booking app as tokenised capability links (`book.otoplay.co/g/<signed-token>`), backed by `/public/*`. SCRUM-122's own note says there are three overlapping public intake forms; this is where they become one. None of these ever render on the staff origin.
- `/public/*` rules: operator resolved from hostname/branch slug (fixes the unscoped phone lookup in apps/api/src/routes/public.ts:106-110), strict rate limits, no PII beyond what D9 already allows.

# 11. Concept ownership (decide once, before porting)

Overlaps visible already: drop-off/nanny/camp check-ins (OTO App SCRUM-123 vs POS supervision SCRUM-75..79 - its note: 'Decide which one survives'); events/parties (X3 vs POS Parties vs P4 event passes); activity logbook (SCRUM-168) vs `audit_log` - one log; staff vouchers (SCRUM-176) vs promo vouchers (SCRUM-92) vs booth vouchers - one signed-voucher service with types; Radar vs Analytics; org structure (SCRUM-158) vs Sprint 1 operator/branch/department. Rule: every concept has exactly one owning module; other apps read it through that module's `public.ts` or embed its UI component.