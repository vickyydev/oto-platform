# Super Admin Console — proposal v1 (for the owner's approval)

Date: 2026-10-21. Status: PROPOSED, awaiting approval. Author: the coding agent (accountable for the design); builder: the Codex agent, from the final plan that follows approval.

Evidence this proposal rests on: the three inventories in this folder (`inventory-platform.md`, `inventory-oto-app.md`, `inventory-direction-and-analytics.md`), read 2026-10-21 against the code and staging, plus the owner's directions in `docs/briefs/OWNER_DIRECTION.md` (2026-09-19 to 2026-10-14).

## 1. The problem, as an admin meets it today

Admin controls are spread over five places, with the same concepts in more than one of them:

| Concept | Where it can be changed today | What is confusing |
|---|---|---|
| Sign-in accounts | POS `/admin` Login Users; OTO App `/users`; OTO App employee editor "Create Login" | three doors to one person; the Console has none |
| Roles and what they allow | POS Login Users (platform roles + scopes); OTO App `/permissions` (its own access levels, modules, overrides); OTO App `users.role` | three unmapped role vocabularies; no role editor anywhere |
| Which apps a person may open | POS Login Users → Apps dialog | invisible from the Console and the OTO App |
| Operators (tenants) | POS `/admin` Operators; OTO App `/operators` | two lists, no link between them |
| Branches | POS `/admin` Branches (create, clone); Console Branches (OTO App mapping only); OTO App `/branches` | create in one, map in another, edit in a third |
| Departments | OTO App `/departments` (full); platform `core.department` (seeded only, no screen) | the Inbox's teams and role scopes use the platform list nobody can edit |
| Employees | OTO App (master); platform copies them every 15 min; no platform screen | a platform admin cannot see who works here |
| Catalogue, tax, tenders, benefits, reports | POS `/admin` (28 panels) | the Console links out to the POS for them |
| Devices, boxes, booths, vouchers, health, audit | Console | the POS has a mock Devices panel too |
| Inbox numbers, templates, assistant | Inbox settings pages | no teams/routing editor exists |
| Revenue targets, campaigns, notes | Radar | separate login rules (admins only) |
| HR, rota, leave, payroll, kiosk, settings | OTO App | its own permission engine; many named rights never checked |

The owner's words (2026-10-21): "confusing duplicated admin/user controls across different apps making it confusing and hard to remember what it was for specifically."

## 2. Principles

1. **One front door for owners and admins.** The Super Admin Console is where owners operate: overview first, then every important control. Staff-facing apps keep only their daily operational screens.
2. **One identity, one place to grant.** A person has one platform account. Every app's access, scope and role is granted in the console. The OTO App's own user and permission pages become read-only mirrors with a "Manage in Admin" link.
3. **Each concept has one authoritative home.** Where two copies must exist (the OTO App's employees and departments), one is the master and the other is a mirror kept by a sync job, shown read-only.
4. **Tenancy-aware from day one.** The platform owner sits above operators; an operator owner sees their operator; a branch manager sees their branch. The console shows exactly what the signed-in person's grants reach, the same rules the api already enforces.
5. **Audit everything; show the audit.** Every console write records an audit row; the Activity screen stays one click away from every section.
6. **Lift, do not redesign.** The POS admin panels and Console pages are approved UI. They move as components; only navigation, wording and placement change.
7. **Fix the foundation first.** The inventories found access holes that no console can paper over. They land before Codex starts on the console.

## 3. Recommendation: evolve the Console into the Super Admin Console

Not a new app. `apps/console` already has sign-on, hand-off, the permission plumbing, Health, Failures, Activity, Devices, Booths, Vouchers and Integrations. It becomes "Admin" on the launcher, with a new navigation and the missing sections. The POS `/admin` panels move into it over two releases; the POS keeps only Station Setup and till-side settings, and `/admin` on the POS redirects to the console for one release so bookmarks keep working.

Alternative considered and not recommended: a fourth app. It would add a fifth place before it removes any.

## 4. Information architecture (navigation)

| Section | Pages (lifted from / new) | Who sees it |
|---|---|---|
| **Overview** | Today across parks: revenue and guests (platform summary), in park now, bookings today, Inbox unanswered, assistant asks and cost, staff on shift (OTO App), open alerts, boxes offline. Park filter. Links into each figure's screen. *New page over existing routes plus four new aggregates (§6).* | everyone with console access; figures limited to the person's reach |
| **People & access** | Accounts (lifted from POS Login Users: search, invite, temp password, sessions, sign out everywhere, activate/deactivate); Roles & scopes (grant and remove; **new** read-only view of each system role's permissions in plain words); App access (lifted Apps dialog, OTO App branches, unlinked OTO App users); Employees (**new**, read-only list from the mirror, with the account link and "open in OTO App"); Departments (**new**, read-only mirror, §5); Access review (**new**: who holds operator-wide rights, last sign-in, accounts with no employee, employees with no login). | admins; branch managers see their branch's people |
| **Organisation** | Operators (lifted from POS; platform owner only); Branches (lifted create and clone; **new** edit: name, timezone, opening hours, business day start, archive; the OTO App mapping and reconcile from the Console page merge here); Holidays (lifted). | admins |
| **Catalogue & money** | Tickets, tiers, add-ons, F&B menu, categories, modifiers, merch, discounts, tenders, tax, voucher types and campaigns, event pricing, drop-off and supervision pricing, print templates, staff benefits (all lifted from POS `/admin`). | admins; branch managers for their branch |
| **Devices & places** | Boxes, stations, devices, paired screens, kiosks, booths (existing Console pages). | admins, branch managers |
| **Channels & assistant** | Numbers and AI mode, templates, knowledge base, examples (lifted from Inbox settings, or linked until lifted); **new** Teams & routing editor (the api's `inbox:routing:manage` has no screen today); **new** assistant settings (daily caps and the pacing knobs that are env vars today, shown and, in phase 4, editable). | inbox admins |
| **Staff & HR** | Read-only summary from the OTO App: on shift today, attendance issues, leave today, payroll month status, with "open in OTO App" buttons. The OTO App keeps HR execution. | admins, managers |
| **Reports** | The five POS report panels (lifted), wallet and promo, booth report, exports; a Radar tile for deep revenue analysis (per the 2026-10-14 ruling Radar stays the analysis tool). | `analytics:read` holders |
| **Watch** | Health, Failures, Integrations, Activity (existing). | `admin:health:read`, `admin:audit:read` |
| **Platform** | Operators across the platform, system roles, platform-wide alerts and jobs, environment and integration status, test controls, **operator switch** (phase 4). | platform-wide accounts only |

## 5. Duplicates: which copy becomes authoritative

| Concept | Authoritative home | The other copy becomes | How they stay in step |
|---|---|---|---|
| Accounts and logins | Platform `core.account` | OTO App `/users`: read-only, "Manage in Admin"; the employee editor's "Create Login" calls the platform's provisioning (it already can) | existing link `otoapp.users.platform_user_id` |
| Roles and rights | Platform roles and scopes | OTO App role derived from the platform grant by a fixed mapping (operator_admin → admin, branch_manager → manager, everyone else → staff; `hr.view_salary` becomes a platform permission granted in the console); OTO App `/permissions` read-only | the mapping is applied at hand-off and by the employee copy job |
| App access | Platform `app_identity` + `app_access_*` roles | — | existing |
| Operators | Platform `core.operator` | OTO App `/operators` read-only, mapped by core id | reconcile job (like branches) |
| Branches | Platform `core.branch` (already mirrored) | OTO App `/branches` read-only for name, timezone; the app keeps its own fields (logo, kiosk code, QR) | existing mirror |
| Departments | **OTO App** (it holds the people and the department pages) | Platform `core.department` becomes a mirror written by the employee copy job; the console shows it read-only with "edit in OTO App"; Inbox teams and role scopes keep using the platform ids | extend `job:otoapp.employee_sync` to departments |
| Employees | OTO App (already the master) | Console Employees page read-only | existing job |
| Opening hours, holidays, tax, catalogue | Platform | — | — |
| Revenue targets, calendar notes, campaigns | Radar | shown on the Overview as figures, edited in Radar | Radar reads the platform; no change |

Why departments stay mastered in the OTO App: the OTO App's departments carry members, branches and ordering that HR, scheduling and the booth roster use daily; the platform's list is seed data nobody edits. Moving the master to the platform would rewrite the OTO App's HR screens for no owner-visible gain.

## 6. Overview and analytics: what the owner sees

Existing routes already give: `/analytics/summary` (revenue, guests, mix), `/branches/:id/occupancy`, `/inbox/dashboard`, `/ops/health` (alerts, boxes, jobs), `/bookings/ledger`, `/vouchers`, booth report, wallet report, audit.

New aggregates the console needs (api work, small): members and visits counts per day and park; bookings summary (count, value, redeemed) per day; assistant usage and cost (asks, tokens, spend estimate) per day; Inbox AI usage (turns, tokens) per day; fleet summary (boxes online/offline per park). Each one scoped by the caller's reach like `/audit` is.

Not in scope: rebuilding Radar's charts. The Overview shows headline figures and links to Radar.

## 7. Tenancy and who sees what

- **Platform owner** (a platform-wide assignment): the Platform section; from phase 4, an operator switch that sets the operator the console reads and writes for that session. Today a platform admin can create operators and assign their admin but cannot see inside another operator; the switch closes that gap safely (audited, session-scoped).
- **Operator owner/admin**: everything for their operator.
- **Branch manager**: Overview for their branch, People for their branch, Catalogue for their branch, Devices, Reports; no Organisation or Platform.
- No new permission vocabulary beyond: `admin:console:overview` (read the home), `hr:salary:view` (moved from the OTO App), `inbox:routing:manage` (exists, gets a screen), `platform:operator:switch` (phase 4).

## 8. Fix first: access holes the inventories found (ticket 0, before Codex starts)

OTO App: an operator admin can create global admins through the access page and the employee login dialog; per-module overrides only gate one server route; an override can open an admin-only module to staff; client gates looser than the server (operator admins reach pages the server refuses); the kiosk permission check is a no-op; six named HR rights are never checked (termination open to managers); several admin-only UI checks look for one role value so the GM and operator admin cannot see controls the server allows; the employee PIN is an unsalted hash.

Platform api: a menu item can be edited through another branch's address; branch-scoped grants pass operator-wide settings (tiers, tenders, modifier groups, discount codes, voucher types) because those guards have no target; the voucher park-product route checks the wrong branch; plain staff hold the day-close right; `POST /branches` and the booth layouts have no target; `/admin/apps/*` and the account-owner file path skip the scope check SCRUM-266 added to accounts; operator-wide ops managers can act on platform-wide alerts and jobs; the hosted payment simulator page is public wherever the simulator runs (guard by env); `/me/staff-token` does not re-check the grant.

These are pinned and landed by me (Opus lanes) in the week before Codex starts, so the console is built on guards that hold.

## 9. Phases and tickets (for Codex, after approval)

| Phase | Weeks | Deliverable | Acceptance |
|---|---|---|---|
| **P0** Foundation (me) | 1 | The §8 fixes, each pinned | guards hold on staging; no behaviour change for honest users |
| **P1** Console foundation | 2 | Rename to Admin; the navigation; Overview v1 over existing routes; People & access lifted from the POS (accounts, roles & scopes, app access); Employees and Departments read-only; Access review | an admin manages a person end to end in the console; the POS Login Users panel shows a link, not a form |
| **P2** Organisation and catalogue | 2–3 | Operators, branches (with edit), holidays; every catalogue and money panel lifted; Reports lifted; POS `/admin` redirects; Inbox teams & routing editor | prices, tax, tenders, benefits are changed only in the console and the till shows the change |
| **P3** OTO App alignment | 2 | Role mapping; departments mirror; OTO App user/permission/operator pages read-only with links; provisioning only from the console; Staff & HR summary | a person granted in the console opens the OTO App with the right role; nothing can be granted inside the OTO App any more |
| **P4** Analytics and platform | 2 | New aggregates and Overview v2; assistant settings editable; Platform section with the operator switch; Radar tile | the owner opens one page and sees the park's day; a second operator can be entered and left, audited |

Each phase: one Jira story with one ticket per page or service; the per-ticket recipe from `docs/architecture/DEVELOPMENT_PLAN.md` (schema → service → route → screen → tests → staging proof with a screenshot); Deployed only with proof; the owner demo at the end of each phase.

## 10. Risks and how they are held

- **Volume of UI moves.** Lifting 28 POS panels is mechanical but wide; P2 is split per panel group and the POS keeps working until the redirect flips.
- **OTO App role mapping touches HR gates.** P3 is behind a feature flag per operator; the OTO App's own engine stays as the fallback until the mapping is proven on staging for every role.
- **Two builders.** Codex owns `apps/console`, the console-facing api routes and the OTO App read-only pages; I own fixes elsewhere and the QA lane. File ownership is written in the final plan.
- **Staging data.** The console reads what the seed lays; the P1 proofs use the demo people and ZZ TEST records only.

## 11. Decisions for the owner

1. Evolve the Console into the Super Admin Console (recommended) rather than a new app.
2. Move the POS `/admin` catalogue, money and report panels into it, leaving the POS with Station Setup (recommended), with a one-release redirect.
3. Departments mastered in the OTO App and mirrored to the platform (recommended), not the reverse.
4. OTO App roles derived from platform grants; the OTO App's own user and permission pages become read-only (recommended).
5. Branch managers get the Overview and their branch's people and catalogue (recommended) or admins only.
6. Radar stays the deep-analysis tool; the console shows headline figures (keeps the 2026-10-14 ruling).
7. The §8 fixes land first, by me, before Codex starts.
8. The assistant's caps and pacing become console settings in P4 (today env vars on Render).
