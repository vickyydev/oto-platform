# Super Admin Console — the build plan (approved)

Approved by the owner on 2026-10-21 ("I approve the console plan"), with every decision in `PROPOSAL.md` §11 taken as recommended. This file is the plan the builder follows; `PROPOSAL.md` is the reasoning behind it; the three `inventory-*.md` files are the evidence. The owner's words on any conflict: `docs/briefs/OWNER_DIRECTION.md`, then `docs/progress/STATUS.md`.

Builder: the Codex agent (phases P1–P4). The coding agent that wrote this plan owns P0 and keeps the QA lane. Jira: the epic's stories and subtasks are listed in §9 with their keys once created (the key list is appended by the planner after creation).

## 1. Decisions in force

1. The existing `apps/console` becomes the Super Admin Console, named **Admin** on the launcher. No new app.
2. The POS `/admin` panels (catalogue, money, reports, access) move into it as components; the POS keeps Station Setup and till-side settings; the POS `/admin` address redirects to the console for one release.
3. Departments stay mastered in the OTO App and are mirrored to `core.department`; the console shows them read-only.
4. OTO App roles are derived from platform grants (operator_admin → admin, branch_manager → manager, everyone else → staff); `hr.view_salary` becomes the platform permission `hr:salary:view`; the OTO App's user, permission and operator pages become read-only with a "Manage in Admin" link; provisioning happens only from the console.
5. Branch managers get the Overview and their branch's people, catalogue, devices and reports.
6. Radar stays the deep-analysis tool; the console shows headline figures and a Radar tile.
7. The P0 access-hole fixes land first, by the planner, before P1 starts.
8. The assistant's caps and pacing become console settings in P4.

## 2. Who owns what (two builders, no overlap)

| Area | Owner | Notes |
|---|---|---|
| `apps/console/**` | Codex | the console is Codex's; the planner does not edit it during P1–P4 |
| `apps/launcher/src/suite/apps.ts` (the tile table) and, additively, `packages/shared/src/permissions.ts` (the `console:*` strings and bundle lines) | Codex | the Admin tile name and address, and the permission vocabulary the console pages need; the launcher's assistant popup files stay the planner's |
| `packages/admin-screens/**` (new, §4.2) | Codex | the lifted POS admin components and their api modules |
| `apps/api/src/routes/{console,roles,employees,departments,access-review,aggregates,assistant-settings,platform}.ts` and their services | Codex | new console-facing routes; names below |
| `apps/api/src/routes/accounts.ts`, `app-identities.ts`, `operators.ts`, `branches.ts`, `catalog.ts`, `menu.ts`, `fleet.ts`, `ops.ts`, `files.ts`, `staff-token.ts`, `vouchers*.ts`, `end-of-day.ts` | planner during P0 (guards only); Codex after P0 for console needs, additively | P0 changes are guard targets and scope checks; no behaviour change for honest users |
| `apps/oto-app/**` | planner during P0; Codex in P3 for the read-only pages, the role mapping consumer and the provisioning call | the OTO App keeps its own npm tree and ratchet |
| `apps/pos/**` | Codex for the redirect and the Login Users link; otherwise untouched | the POS admin components move out, they are not rewritten |
| `apps/inbox/**`, `packages/assistant/**`, `apps/api/src/services/inbox/**`, `apps/api/src/services/assistant/**` | planner | the Inbox story; Codex links to its settings pages, does not edit them |
| `packages/db/**` migrations | Codex for the console's additions (§4.4), numbered on top of main at landing; the planner for P0 if any | one migration per ticket, expand-only, `verify-schema` green |
| `docs/progress/plans/super-admin-console/**`, `docs/progress/STATUS.md` | both; the newest STATUS block always wins | Codex writes its resume note in `docs/handover/CODEX_HANDOVER.md` as today |

Worktrees: Codex works in `C:/w/<lane>` worktrees on `lane/<topic>` branches as the lanes do today; one coordinator lands on `main` with CI watched by SHA. Never push a red gate.

### Questions and standing authorizations (owner directive 2026-10-23)

Scope and boundary questions go to the **planner, not the owner**. Post the question in STATUS and the ticket exactly as today; the planner answers in this plan and STATUS, normally the same day. Ask the owner directly only when the answer would: send an SMS or any real customer message, touch payment data or record a payment, drop or rewrite existing data (a destructive migration), change a prototype or original-app rule's observable behavior, or change an Inbox channel mode.

While a question is pending, **the lane does not stop**: finish everything in the current subtask that does not depend on the answer; if fully blocked, take the next subtask in the phase that does not depend on it, or its read-only preparation, and say so in STATUS. "Parked" means that ticket waits — never the lane and never the day.

Pre-authorized — no question needed, just record what was done in STATUS and the ticket with its test:

1. **Additive response schemas** on existing routes your screens call, with generated client types and the matching legacy-allowance retirement; inputs and behavior unchanged (the Q3/Q6 pattern).
2. **Test-only edits in any package** when a suite's assertion is stale against an approved change, so long as no assertion is weakened and no production file is touched (the Q8/Q11 pattern).
3. **Scoped tenant/park isolation fixes** in an api service your review proves leaking (fence rows and referenced identities to their owning operator/park), with shapes, formulas and access semantics unchanged and a regression test that fails without the fix (the Q7/Q9 pattern).
4. **One-line CI infrastructure repairs** when main is red, locally reproduced before landing (the Q12 pattern).

Production behavior changes outside your files remain questions — to the planner.

## 3. Navigation and permissions (the contract the screens follow)

| Section | Route prefix | Gate to see the section | Pages |
|---|---|---|---|
| Overview | `/overview` | `admin:console:overview` (new; in `branch_manager`, `operator_admin`, `platform_admin`) | Today across parks, park filter |
| People & access | `/people` | `admin:account:read` | Accounts, Roles & scopes, App access, Employees, Departments, Access review |
| Organisation | `/organisation` | `admin:branch:read` | Operators (platform-wide only), Branches, Holidays |
| Catalogue & money | `/catalogue` | `catalog:package:read` or `catalog:menu:read` | Tickets, Tiers, Add-ons, Menu, Categories, Modifiers, Merch, Discounts, Tenders, Tax, Voucher types, Voucher campaigns, Event pricing, Drop-off & supervision, Print templates, Staff benefits, Inventory, Members, Tier verifications |
| Devices & places | `/devices` | `admin:station:read` | Boxes, Stations, Devices, Paired screens, Kiosks, Booths (existing pages) |
| Channels & assistant | `/channels` | `inbox:channel:manage` or `inbox:kb:manage` or `inbox:ai:manage` | Numbers, Templates, Knowledge base, Examples (linked to the Inbox settings until lifted), Teams & routing (new), Assistant settings (P4) |
| Staff & HR | `/staff` | `app:oto_app:access` + `admin:account:read` | Today's staff summary (read-only), links into the OTO App |
| Reports | `/reports` | `analytics:read` | Sales, Profitability, Discounts & comps, Tax & VAT, Wallet & promo, Wallets (lookup and reactivation), Booth report, Radar tile |
| Watch | `/watch` | `admin:health:read` or `admin:audit:read` | Health, Failures, Integrations, Activity (existing) |
| Platform | `/platform` | a platform-wide assignment (`isPlatformAdmin`) | Operators, System roles, Platform alerts & jobs, Environment, Test controls, Operator switch (P4) |

Every page keeps the permission its lifted panel or existing page carries; the section gate only hides navigation. The client never decides; the api does (the console's `has()` ignores scope today — keep it as the offer, never the authority).

New permission strings (add to `packages/shared/src/permissions.ts`, bundles updated, `platformSync` converges them): S2-23's `console:*` vocabulary for the console-own pages (§13), `hr:salary:view`, `platform:operator:switch`. `inbox:routing:manage` exists and gets its screen. The Overview gate in the table above is `console:overview:read`.

## 4. Architecture additions

### 4.1 Api routes (all zod-typed, audited, idempotent where mutating, covered by `routes-guarded`, `route-write-conformance`, `id-conformance`, `route-scope-target` tests)

| Route | Permission (target) | Purpose | Phase |
|---|---|---|---|
| `GET /roles` | `admin:role:read` | the system and operator roles with their permission lists and plain-words labels (`packages/shared` gains `PERMISSION_WORDS`: one plain sentence per permission) | P1 |
| `GET /employees` | `admin:account:read` (reach-filtered) | `core.employee` list with source, branch, department, linked account, last sign-in | P1 |
| `GET /departments` | `admin:account:read` | `core.department` list with branch and member count (from the mirror) | P1 |
| `GET /access-review` | `admin:role:read` | operator-wide holders, platform-wide holders, accounts with no employee, employees with no account, accounts never signed in, temp passwords outstanding | P1 |
| `GET /overview` | `admin:console:overview` (reach-filtered) | one call that fans out to the existing summaries for the park filter: revenue/guests (analytics summary), occupancy, bookings today, inbox dashboard, open alerts, boxes offline | P1 (v1), P4 (v2 adds §4.1 aggregates) |
| `PATCH /branches/:id` | `admin:branch:update` (params.id) | already exists; the console adds the edit screen (name, timezone, opening hours, business day start, archive) | P2 |
| `GET/POST/PATCH/DELETE /inbox/teams`, `/inbox/routing-rules` | `inbox:routing:manage` (branch target where the rule has one) | the teams and routing editor; the router keeps its evaluation order | P2 |
| `GET /aggregates/members`, `/aggregates/bookings`, `/aggregates/assistant-usage`, `/aggregates/inbox-ai-usage`, `/aggregates/fleet` | `admin:console:overview` (reach-filtered) | per day and park counts and sums | P4 |
| `GET/PUT /assistant-settings` | `inbox:ai:manage` (operator) | caps and pacing in a `core.setting` row per operator; the engines read the row with the env value as fallback | P4 |
| `GET /platform/alerts`, `/platform/jobs`, `/platform/environment` | platform-wide | the rows with `operator_id IS NULL` that operator admins must not reach (P0 closes that reach) | P4 |
| `PUT /me/session/operator` | `platform:operator:switch` | sets `session.operator_override` for a platform-wide account; every read and write uses it as `auth.operatorId`; audited `session.operator_switch` | P4 |

### 4.2 The lifted screens

Create `packages/admin-screens` (React, no app code): move the POS admin components under `apps/pos/src/components/admin/**` and the api modules they use (`apps/pos/src/api/catalogBridge.ts`, the admin parts of `apps/pos/src/api/platform.ts`, `api/menu.ts`, `api/analyticsReports.ts`, `api/benefits*.ts`) into it, parameterised by an `AdminApi` interface the host app implements (the console's `api/client.ts` and the POS's `client.ts` both satisfy it). The POS imports the package until its `/admin` redirects; then the POS dependency is removed in the same release as the redirect. The catalogue store (`CatalogStoreContext`) stays in the POS: the lifted panels read through the `AdminApi` and re-read after a save, as the console's pages do. No visual change.

### 4.3 The OTO App alignment (P3)

- Role mapping: `apps/api/src/services/oto-app-users.ts` gains `roleFor(grants)`; `POST /admin/apps/oto_app/users` and the employee copy job write `otoapp.users.role` from it; the hand-off exchange returns the mapped role and the OTO App's `platformSignOn.ts` applies it on every sign-on. Flag: `otoapp.operators.platform_roles_enabled` per operator; off = today's behaviour.
- `hr:salary:view`: the OTO App's `canViewHrSalary` reads the platform permission from the hand-off claim when the flag is on.
- Departments mirror: `job:otoapp.employee_sync` also upserts `core.department` from `otoapp.departments` (name, branch via `core_branch_id`, external id, archived), keeping ids stable; the Inbox's seeded departments are matched by name once and then by external id.
- Read-only pages: `/users`, `/permissions`, `/operators` in the OTO App render their lists with a banner "Managed in Admin" and no write controls when the flag is on; their write routes answer 409 `managed_in_admin`.
- Provisioning: the employee editor's "Create Login" calls the platform's suite-sign-in route (it already can); the legacy `generate-login` and `reset-password` paths stay behind `OTOAPP_LEGACY_LOGIN`.

### 4.4 Schema additions (expand-only migrations)

- `core.setting` (operator_id, key, value jsonb, updated_by, updated_at) for assistant settings and any later console setting.
- `core.session.operator_override uuid null`.
- `core.department.external_id text null`, `archived_at` (if missing), unique (operator_id, external_id).
- `otoapp.operators.platform_roles_enabled boolean default false` (OTO App migration, its own numbering).

## 5. Conventions (unchanged, restated for the builder)

- Per-ticket recipe: read the plan row → schema (if any) → service → route (zod, permission with target, audit, idempotency) → screen → tests (unit for resolvers, integration for the route's happy path and main failure, markup test for the screen) → staging proof (a screenshot named `<ticket>-NN-<what>.png` under `docs/qa/jira-comments/attachments/<ticket>/`, timestamped after the deploy) → Jira walk with the proof attached and ONE plain-words comment → STATUS block → commit → push.
- Gates, unpiped, `set -eo pipefail`: the package's own `typecheck` script; its tests; `pnpm api-types:check` from the root whenever a route changes; `routes-guarded`, `route-write-conformance`, `id-conformance`, `route-scope-target`; `packages/shared` tests whenever shared changes; eslint over changed files; `verify-schema` whenever a migration lands. For the OTO App: `npm ci --ignore-scripts`, `npm run check:ratchet`, the relevant `tests/*.check.ts`.
- Commits per `CONTRIBUTING.md`; no attribution lines; `Refs:` footers; never commit `imports/` or `.env`.
- Staging: records named `ZZ TEST …`; never payments, `otoapp.*_checkins`, SMS, the FWBooth1 box; the Inbox channel modes untouched; demo people and the admin logins as the handover lists them.
- Deploys: Render auto-deploys on green; read `node scripts/agent/render.mjs deploys <service>` before triggering by hand; the OTO App service deploys only on `apps/oto-app` changes; the Inbox and Radar sites are not in `deploy all`.
- Jira: same-turn status and comment on every push; Deployed requires the screenshot; the owner reads every comment, so write for a person, not a log.

## 6. P0 — fix first (planner, Opus lanes; each pinned; one ticket each)

**P0-1 OTO App access: no escalation, overrides honour admin-only, client matches server.** `PUT /api/people/:id/access` and `enable-login` may grant at most the caller's own rank and never write `global_admin`; `requireModule` applies the admin-only rule before overrides; `App.tsx` gates for `/users` and `/operators` match `requireGlobalAdmin`; `operators-page` stops calling the missing `/api/admin/users`.

**P0-2 OTO App checks that do nothing.** `requireKioskPermission` checks the session's real permissions; `hr.terminate_employee`, `hr.edit_contract_templates`, `hr.edit_salary` and the three `settings.*` keys are checked where their names say; the admin-only client checks accept every admin role value; the employee PIN is hashed with a salt (and the route checks branch access).

**P0-3 Api guard targets.** `menu.ts` item PATCH/DELETE compare the item's branch to the path; the operator-wide catalogue routes (tiers, tenders, categories, modifier groups, discount codes, voucher definitions, booth layouts, `POST /branches`) require the permission at operator scope, not the session branch; `PUT /voucher-definitions/:id/park-products/:branchId` targets `params.branchId`; `pos:cash:day_close` leaves the `staff` bundle (reception keeps it); `route-scope-target` pins each.

**P0-4 Api reach.** `/admin/apps/*` and the account-owner path of `/files` use `assertAccountInScope`; `findRun`/`findAlert` exclude `operator_id IS NULL` rows for operator-scoped callers (platform-wide keeps them); the hosted 2C2P simulator pages require `PAYMENTS_SIMULATOR=on` and are refused elsewhere; `POST /me/staff-token` re-checks the grant at the seated station's branch.

Acceptance for P0: every pin red before and green after; the branch-isolation register re-run for the touched routes; no change for honest users on staging (the test night's flows still pass).

## 7. P1 — console foundation (Codex)

| Ticket | Deliverable | Accepted when |
|---|---|---|
| P1-1 | "Admin" on the launcher; the ten-section navigation shell with section gates; `/overview` default; the Console's existing pages placed under Devices & places and Watch | the launcher tile says Admin; every section hides without its gate; old Console addresses still open their pages |
| P1-2 | Overview v1: `GET /overview` over existing summaries; the page with the park filter; each figure links to its screen | an admin sees today's revenue, guests, in park now, bookings, Inbox unanswered, open alerts, boxes offline for the parks they reach |
| P1-3 | People → Accounts: the Login Users panel lifted (search, invite, temp password, sessions, sign out everywhere, activate/deactivate, phone) | a reception account is invited, given a temp password and deactivated from the console; audit rows present |
| P1-4 | People → Roles & scopes: grant/remove lifted; `GET /roles` and the plain-words view | the role list reads in sentences; a branch-scoped grant is added and removed |
| P1-5 | People → App access: the Apps dialog, OTO App branches and unlinked users lifted | an account is linked to an OTO App user from the console |
| P1-6 | People → Employees: `GET /employees` and the read-only page with the account link state and "open in OTO App" | the list shows source, branch, department, linked login |
| P1-7 | People → Departments: `GET /departments` and the read-only page | the list shows the mirror with branch and member count |
| P1-8 | People → Access review: `GET /access-review` and the page | the six lists render for the operator |
| P1-9 | POS Login Users panel becomes a link to Admin → People | the POS panel shows the link and no form |

Proofs: one screenshot per ticket on staging; the P1 demo is an admin managing one person end to end.

P1 release checkpoint (2026-10-22): SCRUM-608 is Deployed. SCRUM-609 through SCRUM-617 and the separate Console-theme prerequisite SCRUM-654 are Deployed with 73 accepted staging controls and 37 child screenshots. The [phase evidence index](../../../qa/jira-comments/attachments/SCRUM-608/SCRUM-608-phase-results.json) binds each accepted receipt to its source, CI, deployment and image hashes. The same restored demo person is used across the accepted Accounts, Roles and App access runs; these are separate restored sessions under the invitation ruling below. The parent screenshot is an unchanged copy of the final prerequisite capture, counted once among the child images. Earlier incomplete attempts and recorded proof limits remain preserved; Q1 is unchanged.

SCRUM-611 evidence ruling (owner, 2026-10-22): prove the reception invitation locally with a captured SMS adapter, then prove account-management controls on an existing demo person in staging. Never send a real staging SMS. Restore the demo's original phone, active status and working password, and verify the read-back; avoid a person linked or stamped into the OTO App so deactivation has no app-side effect. The existing invitation behaviour is unchanged.

Owner question Q1 (2026-10-22, SCRUM-611; default unchanged): the inherited Sessions view includes historical revoked entries although its caption says "signed in". Should a later screen distinguish current sessions from history? The lift preserves the approved list and caption; actual eviction is verified separately by a session returning 401. This question does not block the lift.

SCRUM-620 owner rulings (2026-10-22): Q2 is resolved: implement S2-23's typed archive confirmation and dependency safeguards alongside the approved branch edit fields. Q4 defines those dependencies as **active boxes and stations only**; retain the existing branch cash model, with no drawer-session table or unclosed-trading-day blocker. Archived historical fleet records remain history. Q3 authorizes exactly the success response schema on the existing `PUT /me/session/branch` in `apps/api/src/routes/me.ts`, plus a type-only literal annotation if its compiler requires one; no other change to that file is authorized by this exception. Equipment creation and archive must share parent locks so a concurrent creation cannot pass the dependency check and then appear under an archived branch/operator.

Owner question Q5 (2026-10-22, SCRUM-621; default unchanged): the inherited Ticket hours input offers half-hour steps, while the existing API and database accept integer hours only. Should a later change permit fractional ticket hours? This lift retains both controls and validation and uses a two-hour acceptance fixture; no fractional-hours rule is changed.

Owner question Q6 (2026-10-22, SCRUM-624; production edits parked): may the build add only the four outgoing success schemas for existing GET /checkin/config and PUT /checkin/config/{pricing,policy,confirmations} in apps/api/src/routes/checkin.ts, then generate their client types and retire the four matching legacy allowances? The existing routes have correct branch targets and inputs but no response contracts; PLAN 2 does not assign this file. No check-in behavior, request shape, pricing rule or service change is proposed. The alternative is for the planning lane to land those schemas.

Owner question Q7 (2026-10-22, SCRUM-624; defaults unchanged and production edits parked): inventory-platform 1E111 calls benefit template/profile management operator-wide, but PUT /benefits/templates/:role and PUT /benefits/profiles/:employeeId currently authorize against the seated park. Credential issue, QR read and revoke likewise use the seated park rather than the selected employee. May the build extend ownership to apps/api/src/routes/benefits.ts and its service to require operator-wide management, resolve credential targets to the selected employee's owned park (operator reach for an unassigned employee), and constrain the employee-to-branch join to the same operator if the local corrupt-reference regression confirms the leak? The intentionally operator-wide template/staff/credential metadata lists and all benefit amounts, effective dates, versioning and redemption rules remain as built. The alternative is for the planning lane to land those bounded scope/data fixes.

SCRUM-624 owner rulings (2026-10-23): Q6 authorizes exactly the four existing Care response schemas in apps/api/src/routes/checkin.ts, generated client types and retirement of the four matching legacy allowances; inputs and behavior stay unchanged. Q7 authorizes scoped fixes in apps/api/src/routes/benefits.ts and its service: operator-wide template/profile management, employee-park credential targets (operator reach for an unassigned employee), and the foreign-park join fence if its regression confirms the leak. Existing operator-wide metadata lists and all benefit rules stay unchanged. These are explicit ownership extensions for SCRUM-624 only.

Owner question Q8 (2026-10-23, SCRUM-624; no POS edit): may only apps/pos/test/s221-r2-benefit-qr.test.ts update its source-inspection permission/wiring assertions from the former seated-park call and dialog to the authorized employee-park capability hook and lifted dialog? The full POS suite currently has1,432 passes and this one stale source assertion. All API transport, native wording and real-QR assertions stay unchanged. PLAN2 limits POS edits to619/627; either an explicit scoped authorization or the planning lane's equivalent landing is required. No runtime behavior or guard weakening is proposed.

SCRUM-624 owner ruling Q8 (2026-10-23): the owner authorizes only the existing POS source-inspection test in apps/pos/test/s221-r2-benefit-qr.test.ts to check the approved employee-park permission hook and lifted dialog wiring. API, native wording and real-QR assertions stay unchanged; no POS production edit is authorized by this ruling.

Owner question Q9 (2026-10-23, SCRUM-625; production service edits parked): the local house review reproduces foreign-operator facts and sales contributing money/receipt rows to an allowed park, and foreign booth/prize/staff labels appearing in Booth JSON and CSV. May the build extend ownership only to apps/api/src/services/analytics-reports.ts and apps/api/src/services/analytics-booth.ts to fence facts, sales and referenced identities by their owning operator and park? Existing DTOs, formulas, date/source/status filters, per-park omitted/404/403 behavior and read-only exports stay unchanged. No route, schema or migration change is proposed. The alternative is the planning lane landing these bounded isolation fixes.

SCRUM-625 owner ruling Q9 (2026-10-23): the owner authorizes scoped isolation fixes only in apps/api/src/services/analytics-reports.ts and apps/api/src/services/analytics-booth.ts. Facts, sales and referenced identities must match their owning operator and park; calculations, response shapes and existing access semantics remain unchanged. No route, schema or migration change is needed. The three original failed house findings are preserved before these fixes.

Owner question Q10 (2026-10-23, SCRUM-626; parked before implementation): PLAN4.1 names DELETE /inbox/teams, but inbox.team has no archive/active field and every supported team identity is canonical. platformSync finds or creates each operator birthday/marketing team and each active park's reception team; deleting an unreferenced team is therefore undone with a new id/defaults on the next sync. Existing rules, conversations, assignments and SLA policies also restrict referenced-team deletion. May626 keep canonical teams editable but refuse their deletion with a plain reason, while routing-rule DELETE uses the existing archived_at field? The alternative requires a planner-owned retirement seam in the protected Inbox router/sync lifecycle. Existing model and routing behavior remain unchanged until the ruling; no outside-file edit or migration is proposed.

SCRUM-626 owner ruling Q10 (2026-10-23): keep canonical teams editable and refuse their deletion with a clear reason. Routing-rule deletion uses the existing archived_at field. No persistent team-retirement seam, migration or protected Inbox lifecycle change is authorized or required.

Owner question Q11 (2026-10-23, SCRUM-627; parked before implementation): Q11 / SCRUM-627: may I update only packages/api-types/test/migration-list.ts to relocate and prune the existing legacy response-call counts when live Till and Station Setup calls move back into POS for the approved admin-screens dependency removal? Existing routes without response schemas keep their current contracts; described routes use generated types. No new legacy call or weaker guard is proposed. Existing behavior remains the default until the ruling.

SCRUM-627 owner ruling Q11 (2026-10-23): authorize only packages/api-types/test/migration-list.ts to relocate/prune the existing legacy-call counts needed to preserve live POS operations while removing the admin-screens dependency. No new legacy contract or weakened guard assertion.

Owner question Q12 (2026-10-23, SCRUM-627; release parked): exact-source CI39927174350 on31801788b9015bbfd97d30cf748e93f497f470b5 fails in the OTO App setup step: ubuntu-latest selected Ubuntu26.04 (resolute), whose package list cannot install postgresql-client-16. The existing restore check requires /usr/lib/postgresql/16/bin. May627 change only the oto-app job runs-on line in .github/workflows/ci.yml from ubuntu-latest to ubuntu-24.04, preserving every package, test, guard and restore assertion? That workflow file is outside PLAN2. No application source or staging deployment is changed while main is red.

SCRUM-627 owner ruling Q12 (2026-10-23): authorize only the oto-app job runs-on line in .github/workflows/ci.yml from ubuntu-latest to ubuntu-24.04. Every other job, package, test, guard and restore assertion stays unchanged. The runner-package failure is locally reproduced and the proposed image passes the same install command.

## 8. P2 — organisation, catalogue, reports (Codex)

| Ticket | Deliverable |
|---|---|
| P2-1 | `packages/admin-screens` created; the POS imports it; no visual change (gate: the POS admin still works) |
| P2-2 | Organisation: Operators (platform-wide), Branches with the edit screen and the OTO App mapping merged in, Holidays |
| P2-3 | Catalogue: Tickets, Tiers, Add-ons |
| P2-4 | Catalogue: Menu, Categories, Modifiers, Merch, import/export |
| P2-5 | Money: Discounts, Tenders, Tax, Voucher types and campaigns, Event pricing |
| P2-6 | Care and print: Drop-off & supervision pricing, Print templates, Staff benefits |
| P2-7 | Reports: the five panels, Wallet & promo, Booth report, the Radar tile |
| P2-8 | Channels → Teams & routing editor (routes + screen); Numbers/Templates/KB/Examples linked to the Inbox settings |
| P2-9 | POS `/admin` redirects to Admin; the POS mock Devices panel and dead admin code removed; the POS dependency on `admin-screens` dropped |

P2-9 checkpoint (2026-10-23): SCRUM-627 is Deployed on source `cd2ed663d725e0fbcb05a3668249a2de5ba0b254`, six green CI jobs and six inspected staging images. The [POS redirect and native operations evidence](../../../qa/jira-comments/attachments/SCRUM-627/README.md) binds the one-release same-person redirect and fixed destinations, native Inventory/Members/Tier verifications/Wallets hosts, removed POS admin screens and dependency edge, retained Station Setup and 158 preserved operational bodies. The 13 read-only staging checks preserve demo park/preferences and stock/member/audit fingerprints and finish with both origins sign-out 200/me 401. The original feature local battery remains separate from Q12: the approved one-line OTO App runner repair preserves application/dependency bytes and has its own final six-job CI result. The failed original CI attempt and watcher exit 0 remain recorded as a failure. Saves, refusals, retries, stale replies, readback failures and phone layouts are automated coverage; no staging business write or wallet query is claimed. Parent SCRUM-618 remains In Progress; its actual Till price/tender/tax acceptance below is separate. CI 39931622118.

P2-8 checkpoint (2026-10-23): SCRUM-626 is Deployed on source `ade47aa128f99621c453dfd6188edc1ed04086a4`, six green CI jobs and four inspected staging images. The [Teams and routing evidence](../../../qa/jira-comments/attachments/SCRUM-626/README.md) binds Q10 refusal, scoped team/rule controls, unchanged engine/assignments, safe retries and fresh read-only staging controls/offers. Team/rule fingerprints and demo park/preferences are unchanged, with sign-out 200/me 401. Writes, access refusals, stale lifetimes and handoff navigation have automated coverage; staging saves and Inbox arrival are not claimed. Parent SCRUM-618 remains In Progress; its acceptance below is separate.

P2-7 checkpoint (2026-10-23): SCRUM-625 is Deployed on source `448dd0d6e6247a7656dd245eee7cc5aef0e14014`, six green CI jobs and seven inspected staging images. The [Reports evidence](../../../qa/jira-comments/attachments/SCRUM-625/README.md) binds the native panels, old Booth address, Radar offer, read-only demo readbacks, original interrupted results and full recovery gates. CSV downloads, foreign-park refusals, stale lifetimes and Radar handoff request/navigation behavior are automated coverage; no staging CSV contents or Radar arrival is claimed. Parent SCRUM-618 remains In Progress; its acceptance below is separate.

P2-6 checkpoint (2026-10-23): SCRUM-624 is Deployed on source `4dd7eb94b4af383c40cb512229b2ea1ad9283451`, six green CI jobs and four inspected staging images (attachments11974-11977). The [Care and print evidence](../../../qa/jira-comments/attachments/SCRUM-624/README.md) binds the original partial attempts, focused phone recovery, unchanged readbacks and all local/CI results. Staging controls and previews are read-only; save/refusal/retry and foreign-park cases are tested locally. The explicit station selector restores the existing print-target rule without changing session seating or native forms. Parent SCRUM-618 remains In Progress; its acceptance below is still separate.

**2026-10-23, SCRUM-618 DEPLOYED; CATALOGUE AND MONEY ROUND TRIP:** Source cd2ed663d725e0fbcb05a3668249a2de5ba0b254, six green CI jobs 39931622118 and the three exact live deployments support seven inspected staging images. One outcome comment 12550 names all attachments. All nine P2 children remain Deployed. Admin ticket100 to123, same tender rename and exclusive Tickets VAT7 appear on the actual cold-loaded till: subtotal123, tax8.61, total131.61 and native tender grid. One unpaid synthetic sale was read back and natively voided, with no payment attempt/refund/printing/band/grant; the void row remains. Exact synthetic configuration was archived, original demo park/preferences restored and both origins signed out200/me401. No SMS, payment, hardware, check-in or channel action. The parent is Deployed; final acceptance belongs to the owner. No next ticket is started by this publication.

Acceptance: a price, a tender and a tax rule changed only in the console show on the till; the demo is the catalogue and money round trip.

Note from P0 (2026-10-21): operator-wide settings (tiers, tenders, menu categories, modifier groups, discount codes, voucher types, wheel designs, branch creation) now require operator-wide rights. In P2-3/P2-5 the lifted screens hide those panels, or show them read-only, for a branch-scoped manager, and the POS admin does the same until P2-9 removes it. Two P0 leftovers for Codex to close in the same tickets: the menu import still creates operator-wide categories under a branch-scoped `catalog:menu:import`; `POST /branches/oto-app/reconcile` still has no target.

## 9. P3 — OTO App alignment (Codex)

Owner question Q13 (2026-10-23, SCRUM-629; parked before implementation): the approved hand-off/copy-job integration needs additive changes in apps/api/src/routes/auth.ts, apps/api/src/services/handoff.ts and apps/api/src/services/otoapp-employee-sync.ts. These files are outside PLAN2/4.1's named lane. May629 add the OTO App-only mapped-role/salary claim and its response schema, derive it freshly through the existing identity seam, and call that seam from the employee copy service? The hand-off JWT shape, single-use/live-session checks and every other audience remain unchanged. jobs.ts needs no edit. No dependent source change proceeds before the ruling.

Owner ruling Q13 (2026-10-23): "Authorize these scoped changes." Only the three files and OTO App-only integration described above are authorized; JWT shape, single-use/live-session checks and other audiences stay unchanged. Q13 is resolved.

Owner question Q14 (2026-10-23, SCRUM-629; parked before implementation): PLAN4.3 says to persist the mapped role in otoapp.users.role. Existing advisor accounts require that column to stay literal advisor: routes.ts14589 documents that identity rule,14913-14920 heals it, and873 uses the raw marker to preserve advisor exclusions. May flagged advisors retain their raw advisor marker while the platform-mapped effective role is applied only to their sign-on/session? Ordinary user roles would still persist as approved; flag-off behavior and advisor identity exclusions remain unchanged. The alternative is to leave advisors on their existing policy role until a separate identity-marker change is approved. Do not silently erase their marker or substitute another mapping.

Q14 clarification (2026-10-23): the owner asks for a clearer explanation; no ruling is given yet. An advisor can already have manager-level access while the raw advisor identity independently excludes payroll, contracts, scheduling, Xero and finance. The recommendation preserves those identity restrictions and applies platform-mapped effective access only when the flag is on; the alternative keeps advisors on their current app access policy for now. The question remains pending.

Planner ruling Q13 (2026-10-23, under the owner's delegation of scope rulings to the planner — §2): authorized. SCRUM-629 (and 630 for the salary claim) may make additive changes in `apps/api/src/routes/auth.ts`, `apps/api/src/services/handoff.ts` and `apps/api/src/services/otoapp-employee-sync.ts`: the OTO App-only mapped-role/salary claim and its response schema, derived freshly through the existing identity seam, and the employee copy service calling that same seam. The hand-off JWT shape, single-use and live-session checks and every other audience stay unchanged; `jobs.ts` stays unchanged. These three files ARE the identity seam §13 routes everything through, so for role mapping they are the intended lane; §2's table is read with this ruling.

Planner ruling Q14 (2026-10-23): the proposed narrow treatment is correct, and §4.3 is amended by this ruling. Flagged advisors keep the literal `advisor` marker in `otoapp.users.role` — the identity rule the app documents (routes.ts:14590), self-heals (routes.ts:14913) and enforces for the payroll/contracts exclusions (routes.ts:873). The platform-mapped effective role applies at sign-on/session resolution only, the same way the app already resolves an advisor's effective role from `access_policies` at runtime. Ordinary users persist the mapped role as approved; flag-off behavior and every advisor exclusion stay unchanged. Never erase or substitute the marker.

| Ticket | Deliverable |
|---|---|
| P3-1 | Role mapping behind the per-operator flag; the hand-off carries the mapped role and `hr:salary:view`; the OTO App applies it |
| P3-2 | `hr:salary:view` as a platform permission; bundles; the OTO App reads it when the flag is on |
| P3-3 | Departments mirror in the copy job; `core.department.external_id`; the console page wired |
| P3-4 | OTO App Users, Permissions, Operators pages read-only with "Managed in Admin" when the flag is on; their write routes answer 409 |
| P3-5 | Provisioning only from the console; the employee editor's Create Login calls the platform |
| P3-6 | Staff & HR summary page (on shift, attendance issues, leave today, payroll month status) with links |

CI checkpoint (2026-10-24, SCRUM-630): source 532e9aab705d873da240ad4b40e77e33fa562d31 passed all six jobs in CI 40028592897, confirmed by the full-SHA watcher and independent job audit. Automatic API/Admin/OTO App builds target that source; no manual trigger. Actual CI compiler review and latest-live/staging proof remain. Jira Testing, outcome 12555; no 631 starts. Container cleanup is complete at 126 removals with all other containers, images, networks and volumes preserved.

Release checkpoint (2026-10-24, SCRUM-630): source532e9aab705d873da240ad4b40e77e33fa562d31 is on main, Jira Testing/outcome12555. All107post-rebase cases/API0/generated contracts pass; exact CI40028592897 is running with six jobs. Require green and live API/Admin/OTO App before staging proof. Local container cleanup is complete:126removed, everyothercontainer/image/network/volume preserved. No staging acceptance or631 start is claimed.

Build checkpoint (2026-10-24, SCRUM-630): salary permission/bundles and claim-aware HR/payroll consumers are implemented, preserving pay-edit/action rules and legacy/advisor restrictions. Local API4842, POS1437, other2638, Box749, corrected browser194 and workspace contracts/builds/schema pass; OTO8stages/29commands and whole418/54/109compiler baseline pass. Finalmanifest1e3f7acf is bridged froma416fc1f by only the stale browser count137to138; allproduction/app/dependency bytes match. The failed browser/setup attempts remain recorded. Rebase/landing checks, CI, rollout and real staging proof remain; no631 starts before630 is Deployed. Inactive prior-story containers95 are removed with allothercontainers/images/volumes/networks preserved.

Deployed checkpoint (2026-10-24, SCRUM-629): source 699a7555679aee59ee3e210d00b7b977e017af02, six-green CI 40014668250, latest live API/Admin/OTO App and four twice-inspected native staging role frames are complete. Staff off, then Admin/Manager/Staff on retain the same branch. All33 HTTP operations, two flag jobs and ten signout200/current-user401 sessions settle; original placement/grants/data are restored and the empty fixture is archived flag-off. Advisor preservation is locally verified only. Salary bundles630 and read-only administration632 remain separate. Jira Deployed, outcome12553; evidence `docs/qa/jira-comments/attachments/SCRUM-629/README.md`. Final acceptance belongs to the owner.

CI repair checkpoint (2026-10-24, SCRUM-629): original CI 40001219847 failed the restore-seed rehearsal and remains recorded as failed. Repaired source 699a7555679aee59ee3e210d00b7b977e017af02 passed all six jobs in CI 40014668250; latest live API/Admin/OTO App and fresh native staging proof are complete. The full-battery/final-source bridges remain distinct; Jira Deployed. Final acceptance belongs to the owner.

Acceptance: a person granted in the console opens the OTO App with the right role on staging with the flag on; nothing can be granted inside the OTO App.

Also in P3 (from the OTO App inventory): the two lifecycle gaps close in P3-5 - reactivating a platform account switches its OTO App user back on, and an OTO App-side switch-off (including the 03:00 leaver run) deactivates the platform account through the identity seam; and the OTO App pages that call routes which do not exist (the core dashboard and the troubleshooting flows) either get their routes or lose their links.

## 10. P4 — analytics and platform (Codex)

| Ticket | Deliverable |
|---|---|
| P4-1 | The five aggregates |
| P4-2 | Overview v2 with them |
| P4-3 | Assistant settings: `core.setting`, routes, screen; the engines read the row |
| P4-4 | Platform section: operators, system roles, platform alerts and jobs, environment, test controls |
| P4-5 | Operator switch: `session.operator_override`, the route, the picker, the audit, every read and write honouring it |

Acceptance: the owner opens one page and sees the park's day; a second operator can be entered and left, audited.

## 11. Risks held

- Lifting volume: P2 is per panel group; the POS keeps working until P2-9.
- Role mapping touches HR gates: the flag defaults off; every role is proven on staging before it is turned on for the park.
- Two builders: the ownership table in §2; the planner never edits `apps/console`; Codex never edits the Inbox or assistant code.
- Tenancy: the operator switch is last (P4-5) and audited; until then the platform owner works as today.

## 12. Jira keys

Appended by the planner after creation (epic, stories P0–P4, subtasks).

Created 2026-10-21 in the active sprint (epic SCRUM-181):

| Phase | Story | Subtasks |
|---|---|---|
| P0 (planner) | SCRUM-603 | SCRUM-604 OTO App access; SCRUM-605 OTO App checks that did nothing; SCRUM-606 api guard targets; SCRUM-607 api reach |
| P1 | SCRUM-608 | SCRUM-609 navigation shell; SCRUM-610 Overview v1; SCRUM-611 Accounts; SCRUM-612 Roles & scopes; SCRUM-613 App access; SCRUM-614 Employees; SCRUM-615 Departments; SCRUM-616 Access review; SCRUM-617 POS Login Users link |
| P2 | SCRUM-618 | SCRUM-619 admin-screens package; SCRUM-620 Organisation; SCRUM-621 Tickets/Tiers/Add-ons; SCRUM-622 Menu group; SCRUM-623 Money group; SCRUM-624 Care and print; SCRUM-625 Reports; SCRUM-626 Teams & routing; SCRUM-627 POS redirect |
| P3 | SCRUM-628 | SCRUM-629 role mapping; SCRUM-630 hr:salary:view; SCRUM-631 departments mirror; SCRUM-632 OTO App pages read-only; SCRUM-633 provisioning; SCRUM-634 Staff & HR summary |
| P4 | SCRUM-635 | SCRUM-636 aggregates; SCRUM-637 Overview v2; SCRUM-638 assistant settings; SCRUM-639 Platform section; SCRUM-640 operator switch |
| P5 (after P4) | SCRUM-642 | SCRUM-643 app registry, flags and kill switches, releases; SCRUM-644 activity and failures extensions; SCRUM-645 health and integrations extensions; SCRUM-646 analytics and sources, configuration index; SCRUM-647 money oversight; SCRUM-648 support tools; SCRUM-649 data tools |

## 13. Relation to S2-23 (SCRUM-221), the Sprint 2 Console design

`docs/progress/SPRINT_2_PLAN.md` ("S2-23 — Console: the owner's super-admin control surface") already specifies the console's own pages in detail: Suite overview, Tenancy and organisation, People and access across every app (with provisioning into an app in one action, a reverse permission lookup and an effective-permission diff), App registry with maintenance mode, Activity with a data-access log and audited export, Failures with alert recipients and muting, Health, Devices, Integrations with test buttons and an expiry watch, Analytics and sources, Configuration and content with a cross-app drift check, Money oversight with an integrity panel, Support tools (cross-app lookup, the one-action trace, audited time-boxed impersonation under dual control), Data tools (demo reset, retention, PDPA erasure requests, backup status, migration rehearsal), Release controls (feature flags and kill switches with expiry and blast-radius preview), eight tables (`app_registry`, `feature_flag`, `impersonation_session`, `setting_registry`, `retention_policy`, `erasure_request`, `alert_recipient`, `deploy_event`), the `console:*` permission vocabulary and the danger rules (typed confirmation, mandatory reason, expiry, audit with `target_app`).

What this plan takes from it, and what the 2026-10-21 approval changes:

- **Adopted as the specification** for every console-own page: S2-23's pages, tables, permission vocabulary and danger rules. The permission strings in §3 are therefore S2-23's `console:*` names (`console:overview:read` for the Overview, `console:org:*`, `console:people:*`, and so on); `platform:operator:switch` is the one addition; lifted panels keep the permissions they carry today.
- **Changed by the owner's approval:** S2-23 kept the POS catalogue, tiers and tax in the POS admin and the OTO App's identity pages in the OTO App (the 2026-09-20 ruling). The 2026-10-21 decisions move the catalogue, money, report and access panels into the console (P2) and make the OTO App's user, permission and operator pages read-only mirrors (P3). S2-23's rule that **the console never writes another app's tables directly** stands: the OTO App role and branch access are written only through the identity seam the platform already owns (`app_identity`, `otoapp.users.platform_user_id`, the provisioning service) and its departments are mirrored by the copy job, not edited.
- **Phase map:** S2-23 Suite overview → P1-2 (v1) and P4-2 (v2, with the "needs a decision" tiles and the morning digest); Tenancy and organisation → P2-2 (per-branch feature flags → P5-1); People → P1-3 to P1-8, plus the one-action provisioning, the reverse permission lookup and the effective-permission diff as acceptance lines of P1-4 and P1-5; Devices, Health, Failures, Integrations, Activity → the existing pages, extended in P5; everything else S2-23 names → P5 below.
- **SCRUM-221** stays open as the design reference and is linked to this epic's stories; it closes when P5 lands.

## 14. P5 — the suite controls from S2-23 (Codex, after P4)

| Ticket | Deliverable |
|---|---|
| P5-1 | App registry and maintenance mode (`core.app_registry`; the launcher reads it); feature flags and kill switches with expiry, blast-radius preview and auto-revert (`core.feature_flag`); Release controls page with `core.deploy_event` |
| P5-2 | Activity extensions: app column and target-app filter (`audit_log.target_app`), the data-access log preset, the denials preset, audited export; Failures: alert recipients (`core.alert_recipient`), mute with a bounded window |
| P5-3 | Health and Integrations extensions: the full `/ready` picture, job runner view, per-box devices and sync lag; integration test buttons recorded as `ops_run`, the credential and certificate expiry watch |
| P5-4 | Analytics and sources page (source switch with preview, formula versions, dirty dates, re-run rollup); Configuration index from `core.setting_registry` with the cross-app drift check |
| P5-5 | Money oversight (read-only, audited reads) with the money integrity panel |
| P5-6 | Support tools: cross-app lookup (every lookup a `data_access` audit row), the one-action trace, audited time-boxed impersonation under dual control (`core.impersonation_session`, refused for platform admins and console holders, the banner in every app) |
| P5-7 | Data tools: demo reset with preview, seed profiles, retention policies with the five-year floor (`core.retention_policy`), PDPA erasure requests (`core.erasure_request`), backup status, migration rehearsal |

Acceptance for P5: each page answers "what is true now" and "what can I change from here"; every dangerous control carries typed confirmation, a reason, an expiry where S2-23 says so, and an audit row with `target_app`; nothing on Money oversight writes.
