# Super Admin Console: inventory of the OTO App's admin, settings and analytics surfaces

Read-only study, 21 October 2026. No code was changed.

**Sources.** Four code sweeps, run on main at `2dddf31b`:

- the OTO App's identity, permissions and org pages;
- its HR, leave, scheduling, attendance, payroll and contracts settings;
- its ops configuration, notifications, attention and analytics;
- the platform side: api, POS `/admin`, Console, launcher, `packages/db`, `packages/shared`.

Also read:

- `AGENTS.md`;
- `docs/handover/CLOUD_HANDOVER.md` §2, §6 and §10;
- the staging-seam notes in `docs/progress/STATUS.md` (8 October);
- `docs/progress/plans/otoapp-lift/PLAN.md` §1, §2, §3 and §9.

**Path legend.** Paths are shortened as follows:

- `R` = `apps/oto-app/server/routes.ts`
- `A` = `apps/oto-app/client/src/App.tsx`
- `S` = `apps/oto-app/shared/schema.ts`
- `CS` = `apps/oto-app/server/db/coreSchema.ts`
- `P` = `apps/oto-app/shared/permissions.ts`
- `MW` = `apps/oto-app/server/auth-middleware.ts`
- `PR` = `apps/oto-app/server/payroll/routes.ts`
- `srv/` = `apps/oto-app/server/`
- `pages/` = `apps/oto-app/client/src/pages/`
- `api/` = `apps/api/src/`

Line numbers are the sweeps' readings on that commit.

---

## 0. How the OTO App decides who may do what

This background is needed to read the "who may use" column below.

**Roles.** Roles are hard-coded strings in `users.role`:

| Role | Default modules | Branch reach | Notes |
|---|---|---|---|
| `global_admin` | all modules; ignores overrides (`P:279-287`) | all branches | every action, including `payroll.lock` |
| `admin` (legacy) | as `global_admin` | all branches | the server treats it as `global_admin` (`MW:10-12`); every action except `payroll.lock` (`P:405-413`) |
| `operator_admin` | all 11 modules | the branches of its operator (`srv/storage.ts:2238-2244`) | overrides apply; all admin-only actions plus `payroll.lock` |
| `manager` | today, tasks, checklists, scheduling, events, hr, org_chart, reports (`P:200-203`) | all branches | |
| `staff` | today (`P:199`) | home branch only | |
| `advisor` | resolved from `access_policies.access_level`: ADMIN → admin, MANAGER → manager, otherwise staff (`srv/storage.ts:2423-2454`) | | |

- There is **no permission-role table**. The app's `roles` table (`S:2518`) holds **job titles** such as Receptionist.
- Advisors are blocked from contracts, schedule, rota, payroll, Xero and finance (`R:847-863`).

**Server guards.**

- `requireGlobalAdmin` passes `global_admin` and `admin` (`MW:114`).
- `requireAdmin` passes those two plus `operator_admin` (`MW:132`).
- `requireManager` adds `manager` (`MW:137`).
- `requireRole(...)` passes the roles it names (`MW:90`).
- Inside handlers, park-group fences apply:
  - `parkGroupOnly` (`srv/lib/routeFences.ts:127-142`)
  - `requireSchedulePark` (`srv/schedule-scope.ts:158-229`)
  - `personFence` (`srv/core/personScope.ts:24-31`)
  - the data-admin scopes (`srv/data-admin/park-group.ts:56-110`)

**Module keys** (`P:7-45`). Eleven keys:

- today, tasks, checklists, scheduling, events, hr, org_chart, reports, studio;
- `hr_admin` and `settings`, which are admin-only.

On the server they gate **exactly one route**: `POST /api/settings` through `requireModule("settings")` (`R:6554`). Everywhere else a module override changes only which modes the client shows.

**Action keys** (`P:47-71`):

- Admin-only: `hr.manage_payroll`, `hr.view_salary`, `hr.edit_salary`, `hr.edit_contract_templates`, `hr.terminate_employee`, `settings.manage_access`, `settings.manage_roles`, `settings.delete_data`, `payroll.confirm`.
- Owner-only: `payroll.lock`.
- Payroll-only: `payroll.draft_profiles` (global_admin) and `payroll.own_payslips` (everyone) (`apps/oto-app/shared/payroll-config.ts:58-60`).
- **Only four keys are ever checked:** `hr.view_salary`, `hr.manage_payroll`, `payroll.confirm` and `payroll.lock`. The other six are defined but checked nowhere.

**Where access data lives:**

- `users.role`;
- `user_branch_access`: all branches, or selected ones per tenant (`S:217-226`);
- `user_module_overrides`: module, enabled, branch scope HOME_ONLY/ALL/CUSTOM (`S:419-434`);
- `access_policies`: one per person, holding access level, a modules JSON and branch scope (`S:351-372`). The server's permission engine never reads the modules JSON; the access level sets an advisor's role.

**Client gates** (`A:312-405`):

- Gates are role-only and never module-based.
- `"admin"` lets in `admin`, `global_admin` and `operator_admin`.
- A lone `"global_admin"` lets in `global_admin` and `admin`.
- Staff who fail a gate are sent to `/core`.
- Sidebar flags: `globalAdminOnly`, `adminOnly`, `managerOnly` and `requireAllBranches` (`apps/oto-app/client/src/components/app-sidebar.tsx:54-243`).

**Tenant = park group.** The app takes a user's park group from their first branch-access row (lift plan §3). Inside the app, an "operator" is a legal entity within the park group.

---

## 1. Control table (OTO App)

The "Who" column gives the client gate, then the server gate. **Platform copy** says whether the same concept exists on the platform; §2 gives the detail.

### 1a. Sign-in, logins, access

| Control | Page / client route | What it configures | Who (client → server) | API | Table written | Platform copy |
|---|---|---|---|---|---|---|
| Launcher sign-in | `handoff-problem-page.tsx` (shown by `apps/oto-app/client/src/main.tsx:28-39`) | Nothing to configure: opens the app from the tile; explains refusals (`not_provisioned`, `disabled`, password change owed) | holder of platform `app:oto_app:access` with a linked app user | `POST /api/auth/handoff` (`srv/middleware/platformSignOn.ts:385`) → platform `POST /auth/handoff/exchange` | `otoapp.session` (the platform session token sealed inside it) | **Yes**: the platform session is the sign-in |
| Legacy password sign-in, register | `auth-page.tsx` | App passwords: phone or email + password | everyone → 403 `legacy_login_off` unless `OTOAPP_LEGACY_LOGIN=true` (`srv/auth.ts:122-157`); register is always 403 (`:116-120`) | `POST /api/login`, `/api/register` | `users` | **Duplicate** of platform sign-in; off on staging |
| Change password, forgot password | `/change-password`, `/forgot-password` (`A:587-596`, `496`) | Own password; OTP reset | signed in / public → `legacyPasswordsOnly`: 403 `passwords_on_launcher` when legacy is off | `POST /api/change-password` (`srv/auth.ts:203`); OTP routes (`srv/auth-otp-routes.ts:59,87,115`) | `users.password`, `auth_otp_events`, `auth_rate_limits`, `auth_reset_tokens` | **Duplicate**: platform `/auth/change-password`, `/auth/password-reset/*` |
| Phone verification | `/verify-phone` | Own phone | signed in. The forced redirect sits in an unused file (`apps/oto-app/client/src/lib/protected-route.tsx:41-55`) | `POST /api/auth/phone/request-verification`, `/verify`, `DELETE /api/auth/phone` (`srv/auth-otp-routes.ts:157,208,236`) | `users.phone_*` | **Duplicate**: platform setup verifies the phone |
| Login users | `/users` users-page (`A:707`); sidebar `globalAdminOnly` | Create; edit name, email, role (admin/manager/staff only), active, phone, branch access; reset password; give a suite sign-in | admin (operator_admin passes the client) → `requireGlobalAdmin` + park group. Refuses to touch global_admin, operator_admin or advisor accounts (`R:1118-1120`) | `GET/POST /api/users` (`R:986,1016`); `GET/PATCH/DELETE /api/users/:id` (`R:999,1102,1599`); `POST /api/users/:id/reset-password` (`R:1216`, legacy only); `POST /api/users/:id/suite-sign-in` (`srv/suite-sign-in-routes.ts:104`) | `users`, `user_branch_access`, `activity_log`; copies email and name to `employees` (`R:1166-1185`). DELETE refuses platform-linked users (`srv/lib/userDeletion.ts:92`) | **Duplicate**: POS `/admin?panel=login-users` |
| Permission reviews | no page | Clears the "review this user's access" flag set by a branch change | → `requireGlobalAdmin` | `POST /api/users/:id/clear-permission-review` (`R:1487`), `GET /api/admin/permission-reviews` (`R:1502`) | `users.permission_review_required` | No |
| Access (permissions) | `/permissions` permissions-page, sidebar "Access" (`A:687`) | Each person's access level (STAFF/MANAGER/ADMIN), module switches, branch scope; bulk module switch | admin → `requireAdmin` + park group | `GET /api/permissions/bulk` (`R:27385`), `PUT /api/permissions/bulk-update` (`R:27492`), `PUT /api/people/:id/access` (`R:14726`) | `access_policies`, `user_branch_access`, **`users.role`**: ADMIN becomes `global_admin` (`R:14767-14775`) | Different model: the platform grants only the tile |
| Per-user module overrides | employee editor, overrides panel | One module on or off for one user, with branch scope | manager or admin route → `requireAdmin` | `GET/PUT/DELETE /api/module-overrides/:userId` (`R:27309-27382`); `GET /api/permissions/effective/:userId` (`R:27556`) | `user_module_overrides`, `activity_log` | No |
| Permissions debug | `/settings/permissions-debug` (`A:689`) | Read-only effective modules for every user | admin → `requireAdmin` | `GET /api/permissions/debug/all` (`R:27659`); `GET /api/permissions/me` (`R:27611`) | none | Like platform `GET /accounts/:id/permissions` |
| Vault (read) | `/access` access-page (`A:682`) | Reveals shared passwords and codes | signed in; visibility by role and branch | `GET /api/access` (`R:27010`), `POST /api/access/:id/reveal` (`R:27082`) | `access_view_logs` | No |
| Vault (admin) | `/settings/access` access-config-page (`A:688`); the Setup hub mislabels it "Access & Permissions" (`pages/setup/index.tsx:175-181`) | Add, edit and archive vault items | admin → `requireAdmin` | `POST /api/access` (`R:27115`), `PATCH /api/access/:id` (`R:27149`), view logs (`R:27185`) | `access_items` | No |
| Advisors | `/advisors` (`A:718`) | Advisor people, their logins and suite sign-in | admin → list `requireManager`; writes `requireAdmin` | `/api/people*` (`R:14398-14692`); `/api/people/:id/suite-sign-in` (`srv/suite-sign-in-routes.ts:136,155`) | `people`, `users` (role advisor), `user_branch_access`, `access_policies` | Partly: the suite sign-in creates a platform account |
| My account | `/my-account` (`A:597`) | Own birthday and photo | signed in → `requireAuth` | `/api/my-account/employee-info` (`R:1258`), `/birthday` (`R:1364,1377`), `/profile-photo` (`R:1427`) | `users`, `employees` | **Duplicate**: platform `GET/PATCH /me`, which refuses employees copied from the app (`api/routes/me.ts:86-97`) |
| Kiosk session auth | `/kiosk/:branchId`, `/kiosk/reception` (`A:517-530`) | Device pairing by one-time code | public; device code or secret | `srv/kiosk-auth.ts:113-182` | `kiosk_codes`, `kiosk_devices`, `kiosk_sessions` | Similar: platform device credentials and pairing |

### 1b. Organisation

| Control | Page / client route | What it configures | Who (client → server) | API | Table written | Platform copy |
|---|---|---|---|---|---|---|
| Operators | `/operators` (`A:692`); sidebar `globalAdminOnly` | Legal entities: create and edit; which branches and users belong to each | `["global_admin","admin"]` (operator_admin passes the client) → `requireGlobalAdmin` | `/api/admin/operators*` (`R:2041-2231`). The page also calls `GET /api/admin/users`, which does not exist | `operators`, `branches.operator_id`, `users.operator_id` | **Same word, different meaning**: the platform's `core.operator` is the park group |
| Tenants (park groups) | no page; raw in Data Admin only | The park group | global_admin via `/data/*` | `/api/data-admin/*` | `tenants` | Platform `core.operator`. No mapping column was found in either sweep |
| Branches | `/branches` (`A:676`) | Branch create, edit, delete; logo, address, timezone, Drive folder, operator | admin → `requireAdmin` (`R:1827-1936`) | `/api/branches*` (`R:1774-1955`) | `branches`. The platform link columns are stripped on save (`R:1859-1871`) | **Duplicate**: `core.branch` |
| Branch kiosk code | branches-page (`:173`) | Kiosk pairing code; expiry from setting `auth_kiosk_code_expiry_seconds` (no UI) | admin (via the page) → **`requireManager`** (`R:9331`) | `POST /api/branches/:branchId/kiosk-code` | `kiosk_codes` | Similar: platform device credentials |
| Branch check-in QR | branches-page (`:129-143`) | Public check-in QR. The token comes from the branch id and a server secret, so it **cannot be rotated** | admin → `requireManager` (`srv/checkin-routes.ts:344`) | `GET /api/admin/branches/:id/qr` | none | No |
| Locations | `/locations` (`A:678`) | Physical or task locations, and which branches see them | manager or admin → `requireRole(admin, global_admin, operator_admin, manager)` | `/api/locations*` (`R:26778-26936`) | `locations`, `location_branch_access` (`CS:274,295`) | No (the platform's station is a device) |
| Departments | `/departments` (`A:677`) | Create, edit, deactivate, reorder; branches; members | manager or admin → `requireManager` (`R:2496-2696`) | `/api/departments*` (`R:2442-2715`); `/api/branches/:branchId/departments` (`R:2532`) | `departments` (`S:2453`), `department_branch_assignments` (`S:2482`), `employees.primary_department_id` | **Duplicate in name**: `core.department` (seeded only, no UI, no join) |
| Job roles | `/roles` (`A:679`) | **Job titles**: name, branches, holders | manager or admin → reads `requireAuth`; writes `requireManager` | `/api/roles*` (`R:2716-2871`); `PATCH /api/employees/:id/roles` (`R:3009`) | `roles`, `role_branch_assignments`, `employee_roles` | Name clash with the platform's access roles |
| Settings | `/settings` (`A:690`); sidebar `globalAdminOnly`; Setup hub `adminOnly` | MD signatory name, title and signature (`settings-page.tsx:500-727`); AI model and prompts (`:39-206`, shown only if an `ai_*` row already exists); Fix department (`:647`); dev prod-sync (`:208-392`) | admin → GET `requireAuth` (any user, signature image included); POST `requireModule("settings")` + `settingsWriter` (`R:6539-6554`); Fix department: inline all-branches-or-admin (`R:24885-24912`) | `GET/POST /api/settings` (`R:6505,6554`); `/api/settings/fix-department` (`R:24885,24907`); `/api/admin/prod-sync` (`srv/prod-sync.ts:597`, dev only) | `settings` (keys below) | No |
| Supplier tokens | `/settings/supplier-tokens` (`A:691`); no nav link | Supplier magic links: name, branches, expiry; revoke | admin → `requireAdmin` | `/api/settings/supplier-tokens*` (`R:24943-25031`) | `fix_supplier_tokens` (`CS:1030`) | No |
| Setup hub | `/setup` (`A:635`) | Links only | manager or admin | none | none | — |
| Data Admin | `/data/**` (`A:722-727`) | Raw CRUD over 88 models, including `users` (any role), `user_branch_access`, `user_module_overrides`, `access_policies`, `tenants`, `operators`, `settings` | global_admin → `requireGlobalAdmin` (`R:887`) + park group (`srv/data-admin/router.ts:196-210`) | `/api/data-admin/*` (`router.ts:236-381`) | any registered table. `platform_user_id` and `core_branch_id` are read-only (`srv/data-admin/admin.ts:265-273`); platform-linked users cannot be deleted (`:543-547`) | No |
| Unrouted admin pages | `pages/core_admin/*`, `pages/studio/{settings,users,departments}.tsx` | Not reachable. They call endpoints that don't exist (`/api/admin/users`, `/api/db-status`, `/api/force-seed`, `/api/admin/branches`) | — | — | — | — |

**Generic `settings` table** (`S:1276`, key and value per tenant):

| Key | Written by | Read at |
|---|---|---|
| `md_signatory_name`, `md_signatory_title`, `md_signature_image` | Settings page | `R:6922-6924` |
| `ai_event_extraction_model`, `ai_event_extraction_advice`, `ai_event_extraction_output_format`, `ai_beo_parsing_advice`, `ai_beo_parsing_output_format` | Settings page | `srv/ai-routes.ts:79-206` |
| `fix_department_id` | `POST /api/settings/fix-department` | `R:23804-23815` |
| `probation_days_default` (120) | `pages/policies-page.tsx:190` | `R:397` |
| `attention_rules_config` | `PUT /api/attention-rules/config` (`R:7662`, `requireAdmin`; **no UI**) | `srv/attention-engine.ts:1243-1300` |
| `auth_kiosk_code_expiry_seconds` (600) | no UI; `POST /api/settings` accepts any key | `srv/kiosk-auth.ts:157` |
| `email_subject`, `email_body` | no UI writes them | `pages/contract-detail-page.tsx:242-243` |
| `annual_leave_total_days`, `annual_leave_waiting_months`, `business_days_total` | virtual: redirected into `leave_types` (`R:6496-6500`, `6590-6600`) | — |

### 1c. Employees and HR

| Control | Page / client route | What it configures | Who (client → server) | API | Table written | Platform copy |
|---|---|---|---|---|---|---|
| Employee list, reorder, delete | `/employees` (`A:669`) | Sort order; hard delete. Delete removes the employee, person and login together; refused if the employee has contracts, time or payroll records (`R:4659-4668`) | manager or admin → reorder `requireManager` (`R:4746`); delete `requireAdmin` (`R:4637,4676`) | `POST /api/employees/reorder`, `DELETE /api/employees/:id`, `POST /api/employees/bulk-delete` | `employees`, `people`, `users` | Mirror: `core.employee` (read-only) |
| Create / edit employee | `/employees/:id` (`A:672`) | Name, Thai name, nickname, email, phone, address, birthday, branch, primary department, employment basis, job description, nationality, foreign-staff flag, SSO and tax numbers, visa and work-permit fields, status. Pay fields (daily rate, food allowance, incentive text, salary) need `hr.view_salary` (`apps/oto-app/shared/hr-salary-permission.ts:38-44`) | manager or admin → `requireManager` (`R:3892,4037`) | `POST/PATCH /api/employees[/:id]` | `employees`, `activity_log`. A branch change sets `users.permission_review_required` (`R:4103`); phone, email and name are copied to the linked user (`R:4135-4175`) | Mirror (15-minute copy) |
| **Create Login** | editor "Access & Login" (`employee-editor-page.tsx:425-817`) | Creates a user linked to the employee. The ADMIN level is offered only to admins (`:698`) | manager → `requireManager`; ADMIN or all branches needs an admin (`R:4271-4281`) | `POST /api/employees/:id/enable-login` (`R:4239-4420`) | `users` (role = access level in lower case, `R:4355`), `people`, `user_branch_access`, `access_policies`; **link = `employees.user_id`** (`R:4402`, `S:815`) + `access_policies.core_user_id` | Platform: `core.account.employee_id`, set by the copy job |
| Generate login, reset password | editor dialogs | Generated username and temporary password (staff or manager only) | manager → `requireManager` + `legacyPasswordsOnly` (`R:4423,4517`) | `/generate-login`, `/reset-password` | `users`, `user_branch_access`, `employees.user_id` | Duplicate: platform temporary password |
| Toggle login | editor | Login on or off | manager → `requireManager` (`R:4597`) | `/toggle-login` | `users.is_active` | **Duplicate**: platform Deactivate |
| Job roles per employee; department | editor | Which job roles the person fills; primary department | manager → `requireManager` (`R:3009,3044`) | `PATCH /api/employees/:id/roles`, `/department` | `employee_roles`, `employees.primary_department_id` | No |
| Change terms / transfer | update-terms modal | Salary, title, incentive or branch change; permanent transfer with an effective date | manager → `requireManager` (`srv/employee-action-routes.ts:90,164`); pay changes need `hr.view_salary` (`:97`) | `POST /api/employees/:employeeId/changes`, `/transfer` | `employee_changes`, `employees`, `employee_action_receipts`, `user_branch_access`; a transfer deletes future `schedule_assignments` and `employee_time_off` (`:188-189`) | No |
| Probation review done | editor and Attention > probation | Marks the review complete | manager → `requireManager` (`srv/employee-action-routes.ts:77`) | `POST /api/employees/:id/complete-probation-review` | `employees.probation_review_completed_at` | No |
| Cost allocation | editor | An employee's cost split across branches by percentage | manager → `requireManager` (`R:4808`) | `PUT /api/employees/:id/cost-allocations` | `staff_cost_allocations` | No |
| Documents, assets | editor | Upload or delete documents; assign or return assets | manager → `requireManager` (`R:5460,5525,8870,8986`) | `/api/employees/:id/documents`, `/assets`, `/api/assets/:id/return` | `employee_documents`, `employee_assets` | No |
| Offboarding | offboarding modal | Resignation or termination, reason, last working day, leave days owed | manager → **`requireManager`** (`R:8003,8217`); `hr.terminate_employee` is never checked | `POST/PATCH /api/employees/:id/offboarding` | `employee_offboarding`, `offboarding_checklist`, `employees.status`, `employment_state` (`R:8081`); login switched off when in the same park group | Platform copy archives the row; benefit refused |
| Warnings, letters | warning modal | Warning or offboarding letters | manager → `requireManager` (`R:8406,8453`) | `/api/employees/:id/warnings`, `/letters` | `employee_letters` | No |
| Face enrolment, PIN | editor (PIN has no UI) | Kiosk biometrics and PIN | manager → `requireManager` (`R:9231,9278,12407`); the PIN route checks park group but not branch | `/enrollment-session`, `/reset-face-enrollment`, `POST/DELETE /api/employees/:id/pin` | `enrollment_sessions`, `employees.face_*`, `employees.timeclock_pin_hash` (unsalted sha256, `R:12428`) | No |
| Bulk upload | `/employees/bulk-upload` (`A:670`) | Excel template, preview, bulk update | manager or admin → `requireManager` (`R:3489,5017,5212`) | `/api/employees/bulk-template`, `bulk-upload-preview`, `bulk-update` | `employees` | No |
| Leavers (jobs) | no page | Moves leavers to LEFT; switches off their logins | admin | `POST /api/scheduler/transition-left` (`R:9041`), `POST /api/admin/run-departed-deactivation` (`R:1520`); nightly at 03:00 | `employees`, `users.is_active` | Run by the platform when `OTOAPP_JOBS=platform` |
| Org chart | `/org-chart` (`A:681`) | Nodes, draft to live, budget, start from employees | manager or admin → `requireAuth` with in-handler checks: view needs manager (`srv/orgChartRoutes.ts:185`); every write needs admin (`:477-986`); salaries shown only to admins (`:14`) | `/api/org-chart/*` (mounted `R:877`) | `org_nodes` (`CS:3184`, includes a `benefits` text array and expected salary) | No |
| Casual workers | `/employees/casual` (`A:671`) | Casual staff and their daily rate | manager or admin → `requireManager` (`srv/casual-worker-routes.ts:73-240`) | `/api/casual-workers*` | `casual_workers` (`S:921`); **`daily_rate` is not hidden from managers** | No |
| Staff movements | `/staff-movements` (`A:706`) | Read-only; the backfill button shows only for `role==="admin"` (`staff-movements-page.tsx:215`) | manager or admin → reads `requireAuth`; backfill `requireAdmin` (`R:7313`) | `/api/activity-logs`, `/backfill-departures` | `activity_log` | No |
| Advisor attendance correction | timekeeping review | Corrects an advisor session | manager → `requireManager` (`R:11411`) | `PATCH /api/timekeeping/advisor-sessions/:id` | `advisor_attendance_sessions`, `advisor_attendance_corrections` | No |

### 1d. Leave, rota, attendance

| Control | Page / client route | What it configures | Who (client → server) | API | Table written | Platform copy |
|---|---|---|---|---|---|---|
| Leave types | `/policies` "Rules & Regulations" → Leave Types manager (`policies-page.tsx:552`) | Code, name, active, accrual method (YEARLY / WORKDAYS / NONE), annual days, waiting months, prorate by start date, days worked required, days off earned. No delete: types are switched off. Built-in codes ANNUAL, BUSINESS, SICK, CHANGE_DAY_OFF, UNPAID, TRAINING, OTHER are seeded (`srv/leave-types.ts:40,70`) | admin (`A:708`) → reads `requireAuth` + branch (`R:13814`); writes `requireAdmin` (`R:13831,13847`) | `/api/leave-types*` | `leave_types` (`S:3012`) | No |
| Per-employee leave override | editor "Leave Balance" (`employee-editor-page.tsx:1501-1565`) | Annual days, accrual start, waiting months per person | admin → `requireAdmin` (`R:13895,13911`) | `/api/employees/:id/leave-overrides` | `employee_leave_overrides` (`S:3044`) | No |
| Days-off policy | **no UI** | Days worked required and days off earned, per branch or company-wide | → `requireAdmin` (`R:13627,13678,13751`) | `/api/leave-policies*` | `leave_policies` (`S:2875`); the company-wide rule lives in the CHANGE_DAY_OFF `leave_types` row | No |
| Sick-leave policy | **no UI** | Annual sick days (1-365), prorate, year start month | → `requireAdmin` (`R:14001`) | `/api/sick-leave-policies*` | `sick_leave_policies` (`S:2921`); the company-wide rule is the SICK row. The company-wide `yearStartMonth` is **echoed but never stored** (`R:14050`) | No |
| Medical-certificate thresholds | — | **Not found** | — | — | — | — |
| Leave balances | read-only | Balance engine (`srv/leave-types.ts:230`); opening balances | staff can read only their own | `GET /api/employees/:id/leave-balances-dynamic` (`R:13925`) | reads `employee_leave_balance_openings` (`S:3067`) | No |
| Leave entries | `/scheduling`, `/core/rota` | Records time off directly. **There is no request or approval workflow**: nobody approves, and `approved: true` on SICK only unassigns shifts and raises coverage alerts (`R:13208-13217`, `13351-13356`) | manager → `requireManager` (`R:13099,13272,13386`) | `/api/time-off*` | `employee_time_off` (`S:2750`) | No |
| Public holidays | `/policies` | Staff holiday list | admin → `requireAdmin` (`R:14320-14378`) | `/api/public-holidays*` | `public_holidays` | Same word only: platform `branch_holiday` is a ticket-pricing calendar |
| Rota | `/scheduling` (`A:680`) | Week plans; shift rows (times, staff needed per day, break on, duration, offset, stagger, active dates); shift groups; assignments; clear or merge; conflicts; audit restore | manager or admin (`scheduling-page.tsx:599-600`) → `requireManager` + `requireSchedulePark` (`R:15317-17091`) | `/api/schedule/*` | `schedule_week_plans`, `shift_groups`, `schedule_shift_rows` (break fields `S:3250-3253`), `schedule_shift_row_roles`, `schedule_assignments`, `schedule_audit_log` | The booth roster is built **from** this (job `job:booth.duty_sync`); the platform's `pos.nanny_shift` duplicates the idea with no feed |
| Breaks | rota | Regenerate breaks (from the row's fields; no global setting) | manager (`R:16015,16031,16467`) | as above | `schedule_shift_breaks` (`srv/break-generator.ts`) | No |
| Shift templates | rota | Save week as template; preview; apply; delete | manager (`R:16674-16790`) | as above | `schedule_templates`, `schedule_template_*` | No |
| Duty types and blocks | rota | Duty types and blocks | manager; deleting a duty type needs admin (`R:16521`) | `/api/duty-*` | `duty_types`, `duty_blocks` | No |
| Old shift list | — | Older shift model | manager (`R:12801-12902`) | `/api/shifts` | `shifts` | No |
| Timekeeping review | `/timekeeping-review` (`A:713`) | Resolve pending time-entry issues; attach evidence (JPEG/PNG/GIF/PDF ≤ 10 MB) | manager or admin → `requireManager` (`srv/timekeeping-review-routes.ts:66`; `R:11830`) | `/api/timekeeping/*` | `time_entries.status`, `timekeeping_issues`, object storage `attendance-evidence` | No |
| Manual clock override / delete event | time-events and employee-detail pages | Adds or removes a clock event. The client shows it to `role==="admin"` only (`time-events-page.tsx:97`) | admin → `requireAdmin` (`R:12202,12392`) | `/api/time-events*` | `time_events` | No |
| Kiosk devices | **no UI** | List, create, rename, revoke, delete kiosk devices | → `requireAdmin` (`R:9117-9191`); per branch `requireManager` (`R:9687-9739`) | `/api/kiosk-devices*`, `/api/branches/:id/kiosk-devices` | `kiosk_devices`, `kiosk_sessions` | Similar: Console Devices (credentials) |
| Attendance thresholds | **not configurable** | Clock-in grace 5 min (`R:11647`), shift-end grace 30 min (`R:11628`), no-show 30 min (`srv/scheduled-jobs.ts:442`), long shift 9 h (`srv/timekeeping-deriver.ts:71`), face match 80 % (`srv/face-recognition.ts:508`). `attention_rules_config.clockInGraceMinutes` is stored but **never read**. Geofence: **not found** | — | — | — | — |

### 1e. Payroll, contracts, finance

Every payroll route needs `hr.view_salary` (global_admin, operator_admin, admin). Writes need `hr.manage_payroll`, held by the same three roles. Client routes are gated to those roles (`A:695-702`).

| Control | Page / client route | What it configures | Key | API | Table written | Platform copy |
|---|---|---|---|---|---|---|
| Payroll setup | `/payroll/setup` | Legal (paying) entities, bank accounts, branch payroll details, statutory rates, deduction rules, Employee Welfare Fund settings and remittances, revenue streams | `hr.manage_payroll` | `PR:158-183` | `payroll_paying_entities`, `payroll_paying_accounts`, `payroll_branch_details_versions`, `statutory_rule_sets`, `payroll_rule_lists`, `payroll_ewf_settings_versions`, `payroll_ewf_remittances`, `payroll_revenue_streams` | No |
| Staff payroll profile | `/payroll/people/:id` | Each person's pay profile, allocations, advances, separate payments | `hr.manage_payroll` | `PR:192` | `payroll_profiles`, `payroll_profile_*` | No |
| Draft profiles from HR | `/payroll/people` | Creates draft profiles from employee data | `payroll.draft_profiles` (global_admin only) | `PR:188` | `payroll_profiles` | No |
| Rewards | `/payroll/setup/rewards` | Service charge per branch; incentive rules and assignments. This is the nearest thing to "benefits"; **no benefits configuration exists in the app** | `hr.manage_payroll` | `PR:208,210` | `payroll_service_policies`, `payroll_incentive_rules`, `payroll_incentive_rule_versions`, `payroll_incentive_assignments` | Staff benefits are a separate platform feature (§2) |
| Month end | `/payroll/month-end` | Month inputs; feeds (OT bank, leave valuation, offboarding); run; attendance review; manual lines; overrides; OT decisions; third-party approvals | `hr.manage_payroll` | `PR:198-249` | `payroll_month_inputs`, `payroll_ot_bank_bookings`, `payroll_leave_valuations`, `payroll_offboarding`, `payroll_month_runs`, `payroll_run_versions`, `payroll_run_*` | No |
| GM confirm | month end | Confirms the run | `payroll.confirm` | `PR:251` | `payroll_run_versions` | No |
| Lock, mark paid, reopen | month end | Freezes the month | `payroll.lock` (operator_admin, global_admin; **not admin**) | `PR:253-257` | `payroll_run_snapshots`, `payroll_run_lines`, `payroll_output_files` | No |
| Statutory documents | `/payroll/statutory` | Statutory documents and filings | `hr.manage_payroll` | `PR:279,283` | `payroll_statutory_documents`, `payroll_statutory_filings`, `payroll_statutory_audit` | No |
| Legacy payroll engine | no page | Periods, runs, policy, exports | `isPayrollAdmin` (`R:25549`) | `R:25526-26700`; `POST /api/payroll/policy` (`R:26023`) | `payroll_policy_settings` | No |
| Contract templates | `/templates` (`A:666`) | Templates, branch assignments, fork | admin → `requireAdmin` (`R:3160-3360`); `hr.edit_contract_templates` is never checked | `/api/templates*`, `/api/template-assignments*` | `templates`, `template_assignments` | No |
| Contracts | `/contracts`, `/contracts/new`, `/contracts/:id` (`A:673-675`) | Preview, create, generate, finalise, send, signing link (seven days); archive and delete show only for `role==="admin"` (`contracts-page.tsx:134`) | manager or admin → `requireManager` (`R:5710-6746`); archive and delete `requireAdmin` (`R:5625,5662`) | `/api/contracts*` | `contract_instances` | No |
| Policy documents | `/policies` | Create, edit, publish, archive | admin → `requireAdmin` (`R:7758-7863`) | `/api/policies*` | `policy_documents` | No |
| Public signing | `/sign/:token`, `/letter-sign/:token` | — | token (`R:6841,8648`) | — | `contract_instances`, `employee_letters` | No |
| Xero connection | Analytics page | Connects Xero with read-only scopes (`srv/xero-routes.ts:24-33`); env `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI` | admin → `requireAdmin` (`R:906`) | `/api/auth/xero*` | `xero_tokens` | No |
| Finance sync | no page | **Pulls** tracking, P&L and cash from Xero. Nothing is pushed; payroll is not connected | admin → `requireAdmin` (`R:910`) | `/api/finance/*` (`srv/finance-sync-routes.ts:23-129`) | `xero_*`, `pl_facts`, `cash_txns`, `cash_daily` | No |

### 1f. Operations configuration

| Control | Page / client route | What it configures | Who (client → server) | API | Table written | Platform copy |
|---|---|---|---|---|---|---|
| Event rooms | `/studio/event-settings` or `/events/settings` (`A:659,639`), Locations tab | Rooms: name, capacity, branches, active | manager or admin → writes `requireManager` | `/api/beo/locations` (`srv/beo-routes.ts:351-402`) | `beo_locations` | No |
| Birthday packages | event settings > Packages | Base price, pricing mode, included/excluded, tags, line items | manager → `requireManager` | `/api/beo/birthday-packages*` (`srv/birthday-package-routes.ts:38-225`) | `birthday_package_templates`, `package_line_item_templates` | The POS sells parties from the app's events |
| Entertainment, setup items, set menus, line items | event settings tabs | Entertainment items; setup options; set menus; POS-guide line items (price incl. VAT) | manager → `requireManager` (set menus: GET too) | `srv/birthday-package-routes.ts:254-294`; `srv/beo-routes.ts:489-539,2595-2641,1765-1838` | `entertainment_package_templates`, `beo_setup_item_options`, `beo_set_menu_templates`, `event_line_item_templates` | No |
| Event statuses | studio events (`pages/studio/events.tsx:446,672-734`) | Kanban column names, colours, order. **GET writes default rows when none exist** (`R:19519`) | manager → writes `requireManager` | `/api/admin/event-statuses` (`R:19502-19659`) | `event_statuses` | No |
| Events and camps | `/studio/events/*` (`A:652-657`), `/events` | Event record, camp dates, day hosts, cancelled days, status | manager → `requireManager` (`R:17683-17792`) | `/api/admin/events*` | `core_events` | **App is master** (C10); POS mirrors through `otoapp_v.*` views and writes back with the directory key |
| Looser event writes | BEO editor | Setup and entertainment items, assignment targets, package snapshots | **signed in + event access only** (`srv/beo-routes.ts:567-748`; `srv/birthday-package-routes.ts:311-547`) | as noted | `beo_setup_items`, `beo_entertainment_items`, `beo_assignment_targets`, `beo_package_snapshot*` | No |
| Camp registrations, children | camp detail (`pages/studio/camp-detail.tsx:320-406`); `/studio/children` (`A:660`) | Attendance days, child profile, manager-added registration, merge duplicates | manager → `requireManager` (`R:18105-19068`) | as noted | `camp_registrations`, `camp_attendance`, `activity_log` | Separate from platform `child` |
| Public camp registration | `/camp-register/:eventId` (`A:566`) | Nothing configurable. Limits fixed in code (3 per phone, 10 per IP per hour; 10-minute challenge, `srv/camp-family-verification.ts:13,79`); Twilio Verify env | public | `srv/camp-registration-routes.ts:475-517` | `camp_registrations`, `camp_family_challenges` | No |
| Drop-off form builder | `/studio/form-builder` (`A:661`) | Form sections and fields; manual translations; publish (auto-translates to th, ru, zh) | admin page → draft save allows **managers** (`srv/dropoff-form-routes.ts:439,490`); publish admin-only (`:514`) | `/api/dropoff-form/*` | `dropoff_forms`, `dropoff_form_versions`, `i18n_translations`, `translation_jobs` | Platform S2-13 board is separate |
| Nanny availability | nanny calendar; `/core/my-availability` (`A:616`) | Staff role availability; needs a job role named "Nanny" or "พี่เลี้ยง" (`srv/checkin-routes.ts:72`) | signed in or kiosk (`srv/checkin-routes.ts:2003,2117,2168`) | as noted | `employee_role_availability` | The platform `pos.nanny_shift` is not fed from this |
| Parent experience | BEO parent module | Parent-portal and guest-invite tokens, invitation designs, message log | signed in + park group + branch, any role (`srv/parent-experience-routes.ts:67-74`); `GET /api/invitation-templates` has no auth (`:538`) | `srv/parent-experience-routes.ts:101-357` | `parent_portal_tokens`, `guest_invite_tokens`, `invitation_designs`, `parent_message_logs` | No |
| Staff vouchers | `vouchers-moved.tsx` (`A:614-617,658`) | Moved: every write returns 409 `vouchers_moved` (`srv/voucher-routes.ts:19-22`) | — | — | none in practice | **Moved to the Console** (lift Q8) |
| Tasks (studio) | `/studio/tasks/*` (`A:643-644`) | Recurrence, assignments, questions, photo requirement | manager → `requireManager` (`R:19903-20350`) | `/api/studio/scheduled-tasks` | `tasks`, `task_questions`, `task_assignments` | No |
| Tasks (ops) | `/ops` (`A:632`) | Create tasks, including recurring; delete recurring definitions | **signed in + branch access only** (`srv/core/tasksRoutes.ts:65-76,661-742`) | `POST /api/core/tasks`, `DELETE /api/core/tasks/scheduled/:id` | `tasks`, `task_assignments`, `task_questions` | No |
| Checklist templates | `/studio/checklists` (`A:646`) | Type, branches, department, location, recurrence, time, checker rounds 1-5, reference media, photo evidence, assignees, checker roles; per item: note, photo, critical, linked to Fix, zone (`CS:326-400`) | manager → `requireManager` (`R:20981-21375`; media `srv/core/checklistMediaRoutes.ts:112-671`) | `/api/checklists/templates*` | `checklist_templates`, `checklist_template_items`, `checklist_attachments` | No |
| Checklist run override | `/ops` | Override a run's status | manager (`R:22522`) | `POST /api/checklist-runs/:id/override-status` | `checklist_runs` | No |
| SOPs | `/studio/sops` (`A:647`) | Articles, history, restore | admin → `requireAdmin` (`srv/sop-routes.ts:29-235`) | `/api/sops*` | `sop_articles`, `sop_article_revisions` | No |
| Knowledge base, training | `/studio/kb`, `/studio/quizzes` (`A:648-651`) | Articles, files, quizzes | KB writes manager, archive admin (`R:22821-23302`); quizzes admin (`R:25431-25503`) | as noted | `kb_*`, `knowledge_*`, `training_modules`, `quiz_questions` | No |
| Troubleshooting | `/studio/troubleshooting` (`A:650`) | Calls `/api/troubleshooting/flows`, **which does not exist** | — | — | — | — |
| Announcements | `/ops` Announce tab | Title, body, priority, dates, branches and departments, or everyone (everyone needs all-branch access) | manager → `requireManager` (`srv/core/announcementsRoutes.ts:46-231`) | `/api/core/announcements*` | `announcements` (`CS:3499`) | No |
| Notifications | — | **Not configurable.** Task notification types and recipients are fixed in code (`srv/notification-service.ts:36-357`). The manager "check your clock-in" ping has fixed text (`srv/presence-notification-delivery.ts:47,94`). No user preferences. SMS (Twilio Verify) and email (SMTP, used only for sending contracts) are configured by env only | — | own inbox `R:27742-27812` | `notifications`, `presence_notification_deliveries` | Different: platform Inbox is a customer-messaging module |
| Attention rules | `/attention` (`A:704`) | Refresh; resolve; snooze 24 h. Rule config (open shift 72 h, contract not sent 7 d, document expiry 30 d, grace, overtime, late, enabled rules) has **no UI**; the engine reads only `enabledRules` and `openShiftHoursThreshold` | manager (`R:7518,7548`); rule config `requireAdmin` (`R:7649,7662`) | `/api/attention-items*`, `/api/attention-rules/config` | `attention_items`, `settings.attention_rules_config` | Platform Console Health and Failures show the job runs |
| Night jobs | — | 00:01 batch, 03:00 batch, presence every 6 h, attention every 6 h, no-show every 10 min (07:00-22:00). Only switch: env `OTOAPP_JOBS` (`srv/scheduled-jobs.ts:774-810`) | — | `POST /api/directory/jobs/:name/run` (`srv/directory/jobRoutes.ts:65`, `jobs:run` key) | across the above | **Run by the platform** when `OTOAPP_JOBS=platform` |
| QA reports | `/qa-reports` (`A:494`) | Own bug reports; on when env `QA_REPORTS_ENABLED` is set | signed in (`srv/qa/routes.ts:25,61-127`) | `/api/qa/*` | `qa_reports`, `qa_report_messages`, `qa_report_attachments` | No |
| AI helpers | — | Event extraction and BEO parsing. Models from env `ANTHROPIC_*` and the `ai_*` settings | signed in (`srv/ai-routes.ts:40,69,180`) | `/api/ai/*` | none | Platform assistant is separate |
| Directory keys | **no UI** | Tenant-bound `odk_` keys with scopes `events:write`, `hr:read`, `jobs:run`, stored as SHA-256. Issued with `npm run directory:client`. Plus the legacy `X-HR-API-KEY` = env `HR_DIRECTORY_API_KEY` (default park group only) | CLI / database row | `srv/directory/clientAuth.ts:29-165`; `srv/directory/hrReadAuth.ts:85-124`; HR reads `R:14858-14989` | `directory_clients` (`CS:246-267`) | The platform holds the plaintext in `OTOAPP_DIRECTORY_KEY` and `OTOAPP_JOBS_KEYS` |

---

## 2. Duplicates

**Where platform admin lives today.** Login and access management is on the **POS `/admin` "Access" group** (`apps/pos/src/components/admin/adminSections.tsx:330-355`): Login Users, the Apps dialog, Unlinked OTO App users and Operators. The Console has no account screens. Its sections are Health, Failures, Activity, Booths, Booth report, Devices, Branches, Bookings, Vouchers, Voucher types and Integrations (`apps/console/src/components/consoleSections.tsx:47-169`).

| Concept | OTO App copy | Platform copy | Authoritative today | How kept in step |
|---|---|---|---|---|
| Sign-in and password | `users.password`, OTP routes; off unless `OTOAPP_LEGACY_LOGIN=true` | `core.account` + setup, reset, temporary password (`api/routes/auth.ts:345-559`; `api/routes/accounts.ts:508`) | **Platform** | The hand-off (below). The app's password routes answer 403 `passwords_on_launcher` |
| Hand-off | `POST /api/auth/handoff` → exchange; liveness `GET {PLATFORM_API_URL}/me` cached 10 s (`platformSignOn.ts:290-494`) | `POST /auth/handoff` mints an HS256 JWS (`aud oto_app`, single-use `jti`, ~60 s, `HANDOFF_SIGNING_KEY` keyring, `HANDOFF_APP_ORIGINS`); `core.handoff_token` (`api/services/handoff.ts:164-543`; `packages/db/src/schema/tenancy.ts:333-380`) | **Platform** | The app holds no signing key; it trusts the platform's answer |
| Which app user an account is | `users.platform_user_id` (uuid, unique, `S:173`). Matched strictly; there is no email or phone fallback (`srv/storage.ts:2139-2147`) | `core.app_identity` (`app`, `account_id`, `external_user_id` = `otoapp.users.id`; `tenancy.ts:402-446`) | **Platform writes both**; the app only reads the column | POS LoginUsers → Apps dialog → `POST /admin/apps/oto_app/users` (`api/routes/app-identities.ts:104-442`, `admin:role:assign` + caller holds `app:oto_app:access`). It creates or links the app user in one transaction (`api/services/oto-app-users.ts:106-132,740-843`). App-side "Provision suite sign-in" calls `POST /admin/apps/oto_app/suite-sign-ins` with `OTOAPP_PROVISION_KEY` (platform holds the hash in `OTOAPP_PROVISION_KEYS`). No link → 403 `not_provisioned`; no auto-create |
| Tile access | (none) | `app:oto_app:access` through the per-operator role `app_access_oto_app`, at operator or branch scope | **Platform** | Granted with the link; revoked on unlink |
| Account active / inactive | `users.is_active` | `core.account.status` | Both | Platform deactivate → sessions ended and `otoapp.users.is_active=false` (`api/routes/accounts.ts:482-485`; `oto-app-users.ts:193-225`). **Reactivating does not switch the app user back on** (`:186-188`). App-side disable (users page, employee toggle, 03:00 leaver run) does **not** reach the platform account |
| Unlink | clears `platform_user_id` | deletes `app_identity`, revokes the access role | Platform | `DELETE /admin/apps/oto_app/users/:accountId` deletes `otoapp.session` rows (`oto-app-users.ts:146-164`). (Staging once saw an app session survive an unlink: SCRUM-288) |
| What a person may do inside the app | `users.role` (6), `user_module_overrides`, `access_policies`, action keys | `core.role` / `role_permission` / `role_assignment` (5 system roles + inbox roles + app-access roles; scopes operator / branch / department; record scope cannot be granted) | **The app** for everything inside it | **Not synced, not mapped.** The platform does not send a role; the app role is chosen at provisioning (`OTO_APP_USER_ROLES`) and then drifts |
| Branch reach in the app | `user_branch_access` | branch-scoped `app_access_oto_app` assignment | Platform at link time; then either side | `PUT /admin/apps/oto_app/users/:accountId/branches` writes both (`app-identities.ts:621`; `setOtoAppUserBranches`). The app's own Users and Access pages write only the app side |
| Park group | `tenants` | `core.operator` | Not established | No mapping column found by either sweep. Directory keys are bound to one tenant each |
| Legal entity | `operators`; also payroll `payroll_paying_entities` | none | App | Not synced |
| Branch | `branches` | `core.branch` | **Platform** | A create or rename on the platform writes `otoapp.branches` in the same transaction (`api/routes/branches.ts:128,248-256`). The link column is `otoapp.branches.core_branch_id`. Reconcile from Console `/branches` (`api/routes/branches.ts:153,172`). The app's own branch edits ignore the link columns but can still rename or delete locally. **Platform-sync does not touch branches** |
| Department | `departments` + `department_branch_assignments` (full CRUD) | `core.department` (seeded only: reception, restaurant, floor, nanny per branch; birthdays & events, marketing; **no UI, no routes**) | **App** in practice; the platform list is a role-scope device | **No join** between the two lists |
| Role (job title) | `roles` (job titles) | `core.role` (access bundles); benefit role templates owner/manager/staff | — | Three unmapped role vocabularies |
| Employee | `employees` | `core.employee` (`source='otoapp'`, `external_id` = app employee id) | **App** (conflict C13) | `job:otoapp.employee_sync` every 900 s reads the view `otoapp_v.employees` (`api/services/jobs.ts:789-808`); staging-only "Copy now" (`api/routes/ops.ts:765,1008`). Copied rows are read-only on the platform (`api/routes/me.ts:79-97`) |
| Employee ↔ login | `employees.user_id` (fallback: email, then phone or name: `srv/storage.ts:2317-2348`) | `core.account.employee_id` | App | The copy job sets `account.employee_id` from the view's `platform_user_id` (audit `account.employee_link`) |
| Leavers | 03:00 run: status to LEFT, login switched off | copy job archives the employee; benefit card refused | App | The platform account itself stays active (the "03:00 departed-login door" debt, handover §10) |
| Profile | `/my-account` | `PATCH /me` | Each its own | Platform refuses edits for app-sourced employees |
| Staff benefits / vouchers | voucher routes return 409 (moved); payroll "rewards" are pay, not benefits | `promo.benefit_*` keyed on `core.employee`; POS `/admin?panel=staff-benefits`; `BENEFIT_QR_PRIVATE_KEY` (Ed25519) with `core.signing_key` purpose `benefit_qr` | **Platform** | Reads the employee copy |
| Rota | `schedule_*` | `booth.booth_duty_assignment` (built **from** the app's schedule, `job:booth.duty_sync`); `pos.nanny_shift` (seeded; no feed) | App | One-way job for the booth; none for nanny shifts |
| Clock-in / pairing devices | `kiosk_devices`, `kiosk_codes` | `core.station`, `core.box`, `core.device_credential` (Console Devices) | Each its own | Not synced |
| Events and camps | `core_events`, `camp_*`, `event_*` | POS reads `otoapp_v.*` views | **App** (C10) | POS writes back through `/api/directory/events/:id/*` with an `events:write` key (`OTOAPP_DIRECTORY_URL`, `OTOAPP_DIRECTORY_KEY`) |
| Night jobs | `srv/scheduled-jobs.ts` | `job:otoapp.*` in `core.ops_run` | **Platform** when `OTOAPP_JOBS=platform` | `jobs:run` key (`OTOAPP_JOBS_KEYS`; row `platform-night-runner`) |
| Audit | `activity_log` | `core.audit_log` (Console `/activity`) | Each its own half | Not merged |
| Permission vocabulary sync | — | `pnpm db:platform-sync` (api pre-deploy, `render.yaml:179`): makes the 5 system roles' permissions exactly match `ROLE_BUNDLES`, lays tenders, stock setup and inbox setup (`packages/db/src/seed/index.ts:169-227`) | Code | Touches **only `core.*`**: not the app, accounts, employees, `app_identity` or branches |

**Staging seams that touch admin.** None of these has a screen.

- **Benefit key:** `BENEFIT_QR_PRIVATE_KEY` (`api/env.ts:321`). Platform only; the app never calls it.
- **Directory key:** `OTOAPP_DIRECTORY_URL` and `OTOAPP_DIRECTORY_KEY`, matching a `directory_clients` row bound to the default tenant. Scopes are granted by updating that row.
- **Jobs key:** `OTOAPP_JOBS_KEYS`.
- **Provisioning key:** `OTOAPP_PROVISION_KEY` on the app, with its hash in `OTOAPP_PROVISION_KEYS` on the platform.
- **Legacy HR key:** `HR_DIRECTORY_API_KEY`.
- **Demo counter box:** `BOX_AGENT_BRANCH_CODE`, switched to the demo park for captures and then restored.

---

## 3. Analytics and overview surfaces (OTO App)

| Surface | Route / gate | What it shows | Data source | Server check | Export |
|---|---|---|---|---|---|
| HR Dashboard | `/dashboard` (`A:665`, manager+); reached from the HR mode switcher. The sidebar "Dashboard" goes to `/` and then `/core/today` | Attention required (total, high); timekeeping issues (48 h); currently working; active employees; staff movements (30 d); 8 recent updates (`pages/dashboard-page.tsx:282-524`) | `/api/attention-items/counts` (`R:7498`); `/api/timekeeping/review` (`R:11507`); `/api/timekeeping/live` (`R:12510`); `/api/employees` (counted in the browser); `/api/activity-logs/summary` (`R:7281`) | attention and timekeeping: manager; activity logs: **sign-in only** | none. Contracts, unreturned assets and probation/unsigned/leaving lists are fetched but **never shown** |
| Core Dashboard | `/core/dashboard` (`A:605`, any user, no nav link) | Checklists done, in progress, overdue; issues; escalations | `/api/dashboard/*`: **no server routes exist** | — | none |
| Analytics (Xero) | `/analytics` (`A:719`, admin; sidebar admin + all branches) | P&L (revenue, expenses, net profit; month, 3 or 6 months, YTD); invoices (receivable, payable, overdue); balance sheet (`pages/analytics-page.tsx:180-721`) | live Xero API (`srv/xero-routes.ts:239,273,306`) | `requireAdmin` (`R:907`) | none. `/api/finance/*` tables (`pl_facts`, `cash_*`) have no client |
| Attention | `/attention` (`A:704`, manager+) | Open items by type and severity; priority view; probation panel | `/api/attention-items` (`R:7460`) → `attention_items` | manager | none |
| Live timekeeping | `/timekeeping/live?tab=missing`; other tabs redirect to the review page (`A:717`) | Working now; missing clock-ins; pending pings | `R:12510-12736` → `time_events`, `employee_presence`, `schedule_*`, `presence_notification_deliveries` | manager | none |
| Today's attendance | `/timekeeping-review` (`A:713`) | Issues, clock and live zones | `/api/timekeeping/review`, `/pending-issues` | manager | evidence files only |
| Sidebar badges | `apps/oto-app/client/src/components/app-sidebar.tsx:324-368` | "Needs action" (open attention items); "Today's attendance" (late > 5 m, early leave, missed punch, no-show, pending adjustments, open OT approvals) | `/api/sidebar/badges` (`R:7448`; `srv/sidebar-badges.ts:28-223`) | sign-in, branch-scoped | — |
| Unread notifications | header (`A:172`) | Unread count | `/api/notifications/unread-count` (`R:27765`) | sign-in | — |
| Payroll hub | `/payroll` (`A:693`; payroll roles; others go to My Payslips) | For each paying company this month: run version, status, items to check, blocking issues, warnings | `PR:154,226,241` | `hr.view_salary` | via downloads |
| Payroll downloads / history | `/payroll/downloads/...`, `/payroll/history` (`A:702`) | Files for a locked month | `PR:261-288` → `payroll_output_files` (file opens are audited) | `hr.view_salary` | **SCB TXT, XLSX fallback, other-bank CSV, payslips (HTML), reports (CSV), welfare fund XLSX, all-files ZIP** (`srv/payroll/outputs.ts:82-107`); statutory files (`PR:281`) |
| My payslips | `/payroll/me/payslips` (`A:703`, all roles) | Own payslips | `PR:269-271` | `payroll.own_payslips` | payslip |
| Legacy payroll exports | no client | — | `R:26602-26712` (`srv/payroll-exports.ts`) | `isPayrollAdmin` | CSV bank transfer (scb/kbank/bbl/generic), journal (csv/sage/quickbooks), SSO and PIT filings; payslip PDF (`R:26541`) |
| Org chart | `/org-chart` (`A:681`, manager+) | Headcount, vacancies; budget (total salary, people, vacant by branch, draft vs live) | `/api/org-chart/nodes`; `/api/org-chart/budget` (**admin only**, `srv/orgChartRoutes.ts:846-855`) | as noted | none |
| Activity logbook | `/activity-logbook` (`A:711`, manager+) | Filtered log with count | `/api/activity-logs` (`R:7197`) | **sign-in only** (branch-scoped) | none |
| Staff movements | `/staff-movements` (`A:706`) | Last 30 days of movements | `/api/activity-logs?types=` | sign-in | none |
| Ops overview | `/ops` | Tab counts; checklist run progress; history; activity feeds | `R:21417-22652`; `srv/core/tasksRoutes.ts:1033` | mixed | none |
| Event RSVP summary | BEO parent module | Totals: attending, declined, maybe; kids, adults | `srv/parent-experience-routes.ts:305-327` | sign-in + event | none |
| Camp attendance | camp detail | Attendance per day | `R:19458` | sign-in | none |
| Other downloads | — | BEO PDF (`srv/beo-routes.ts:2345`); employee import template XLSX (`R:3489`); contract, letter, document and evidence files; browser-made QR and invitation images | — | varies | — |
| **No export exists** for | — | activity logs, attention items, timekeeping lists, events, camp registrations, children, checklist history, analytics, Data Admin | — | — | — |

**For comparison: platform analytics.**

- POS Today (`GET /analytics/summary`) and the POS `/admin` Reporting group: Sales, Profitability, Discounts & Comps, Tax/VAT, Benefits, Wallet (`analytics:read`, `api/routes/analytics.ts:80-406`).
- Console Booth report, with CSV.
- Console Activity (audit log; `admin:audit:read`, masked unless `admin:audit:read_sensitive`).
- Console Health, Failures and Integrations (`admin:health:read`, `admin:ops:manage`).
- Bookings ledger; vouchers CSV; settlement CSV; End of Day.
- **None of these reads the app's HR, attendance or payroll data.**

---

## 4. What a non-technical admin would trip over

### Same concept, two places, different words

1. **"Operator" means two things.** On the platform it is the park group (the OTO Park company). In the app it is a legal entity inside the park group, and the app calls the park group a "tenant". Payroll adds a third word: "paying entity".
2. **"Role" means three things.** Platform roles are access bundles (reception, branch manager…). The app's role is one of six access levels on the user. The app's Roles page is job titles (Receptionist, Nanny). The nanny calendar depends on a job role literally named "Nanny".
3. **"Access" means two things in the app.** The sidebar "Access" opens the permissions page. "/access" is the password Vault. The Setup hub labels the Vault admin "Access & Permissions".
4. **Users in two places.** A login is created and switched off in POS `/admin` > Login Users. What the person may do inside the app is set in the app's Users, Access and module-override screens. Neither screen shows the other's settings.
5. **Linking.** The app's refusal tells the person to ask for a link in "Login Users, Apps" with "the id of your OTO App user". That id appears on no normal screen; the Unlinked OTO App users list on POS `/admin` is the only helper.
6. **Switching someone off.**
   - Deactivating on the platform also disables the app user.
   - Reactivating on the platform does **not** re-enable the app user.
   - Disabling in the app (Users page, employee "toggle login", or the 03:00 leaver run) leaves the platform account and its other tiles working.
7. **Departments.** The app has a full department list; the platform has a seeded list with no screen. They are unrelated.
8. **Holidays.** Platform branch holidays change ticket prices. App public holidays are for staff leave.
9. **"Benefits".** Staff benefits (discount QR) are on the platform. The app's payroll "Rewards" are service charge and incentives. Org-chart nodes carry a free-text "benefits" list.
10. **"Where".** Branch (both), location (app), station, box and device (platform), kiosk device (app).
11. **Employees.** They are edited only in the app. The platform's Staff Benefits list shows them read-only, up to 15 minutes late.
12. **Settings with no screen.** Sick-leave and days-off policies, kiosk devices, attention rules, kiosk code expiry, directory, jobs, provisioning and benefit keys, and the demo box branch are all set by API call, database row or hosting variable.
13. **Two audit trails.** Platform Console Activity and the app's Activity Logbook each record a different half of the same change.
14. **Settings that look configurable but are fixed:** attendance grace minutes, no-show window, notifications and recipients, SMS rate limits, check-in QR (cannot be rotated).

### Faults the sweeps found on the way

These need a ticket or a fix lane; this study fixes nothing.

1. **An operator_admin can create global admins in the app.** `PUT /api/people/:id/access` with level ADMIN writes `users.role="global_admin"` (`R:14767-14775`). `enable-login` with ADMIN writes `role="admin"`, which the server treats as global (`R:4355`; `MW:10-12`). Both are behind `requireAdmin`, which operator_admin passes.
2. **A module override can open admin-only modules** (`settings`, `hr_admin`) to a manager, because the override is checked before `adminOnly` (`P:290-337`). Combined with `requireModule("settings")`, such a manager can write any settings key.
3. **Six permission keys are never checked:** `hr.terminate_employee`, `hr.edit_contract_templates`, `hr.edit_salary` and the three `settings.*` keys. Offboarding is therefore open to managers.
4. **Client gates out of step with the server.**
   - Looser: `/users` and `/operators` admit operator_admin, but the server refuses.
   - Tighter: some controls show only to `role==="admin"`, hiding them from global_admin and operator_admin. Affected: `time-events-page.tsx:97`, `timekeeping-employee-detail-page.tsx:333`, `contracts-page.tsx:134`, `staff-movements-page.tsx:215`.
5. **Writes looser than their pages.**
   - Ops task create and recurring delete need only sign-in plus branch access.
   - BEO items, assignment targets and package snapshots need only sign-in plus event access.
   - Drop-off draft save admits managers.
   - `GET /api/settings` (which includes the MD signature image) and `/api/activity-logs` need only sign-in.
6. **The kiosk permission check is a no-op** (`srv/kiosk-auth.ts:137-153`).
7. **The employee PIN is stored as an unsalted sha256**, and its route has no branch check (`R:12407-12428`).
8. **The casual-worker daily rate is visible to managers.**
9. **Settings stored but never used:** `clockInGraceMinutes` is never read; the sick-leave `yearStartMonth` is never stored.
10. **Endpoints called but missing:**
    - `GET /api/admin/users` (operators page);
    - `/api/dashboard/*` (Core Dashboard);
    - `/api/troubleshooting/flows`;
    - the `core_admin/*` pages.
11. **A read that writes:** `GET /api/admin/event-statuses` inserts default rows (`R:19519`).
12. **Platform side:**
    - `role_assignment.archived_at` is documented as soft-withdraw, but DELETE hard-deletes and the resolver ignores `archived_at` (`api/routes/accounts.ts:426`; `api/services/permissions.ts:42`).
    - `admin:operator:*` is declared, but the operator routes are gated by platform-wide reach instead.

---

## 5. What a single platform-side super admin console would need from the app

1. **One person view.** Join `core.account` + `core.app_identity` + `otoapp.users` (role, `is_active`, `operator_id`, `must_change_password`, `permission_review_required`) + `user_branch_access` + `user_module_overrides` + `access_policies` + `employees.user_id`. The platform already reads and writes the app schema in the same database through `api/services/oto-app-users.ts`; that boundary is the natural home.
2. **A named mapping of the app's permission model.**
   - Expose the six roles, eleven module keys (with `adminOnly`) and ten action keys as read-only catalogue entries next to the platform's `service:resource:action` strings, e.g. `otoapp:role:manager`, `otoapp:module:hr`, `otoapp:action:hr.view_salary`. The source is `P:7-71`.
   - Decide per key whether it stays app-decided or becomes a platform grant. Today the platform sends no role.
3. **Writes through the boundary, audited on both sides:**
   - app role (with the dominance rule the platform already applies to its own grants, so an operator admin cannot mint a global admin);
   - app active flag;
   - module overrides;
   - access level;
   - branch reach (already exists: `PUT /admin/apps/oto_app/users/:accountId/branches`).

   Each write records a platform `audit_log` row and an app `activity_log` row.
4. **A joined-up lifecycle.**
   - Platform reactivate should offer to re-enable the app user.
   - App disable and the 03:00 leaver run should raise a platform-side signal, or end the platform account's other tiles, per an owner ruling.
   - Unlink must always end app sessions (SCRUM-288).
5. **A stated owner and a one-way sync for each duplicated concept:**
   - park group ↔ `tenants`: no mapping column today;
   - departments: two unrelated lists;
   - legal entity, `operators` vs `payroll_paying_entities`: two lists inside the app itself;
   - job roles vs access roles: naming only.

   Branches (platform → app) and employees (app → platform) already have one.
6. **Screens for settings that today have none:**
   - sick-leave and days-off policies;
   - attention rule thresholds (and wiring the stored grace value);
   - kiosk devices and kiosk code expiry;
   - directory clients (scope, tenant, issue, rotate, revoke, showing fingerprints only);
   - the jobs, provisioning, legacy HR and benefit keys (fingerprint and rotation date only; values never shown).
7. **One audit view** reading `core.audit_log` and the app's `activity_log` by person and by park group.
8. **Overview tiles** the platform cannot draw today:
   - headcount and leavers (from the employee copy);
   - attention counts;
   - today's attendance (missing clock-ins, late, no-shows);
   - payroll month status for each paying entity.

   These would be read through `otoapp_v` views or a directory `hr:read` key, never by direct table reads from the console.
9. **Park-group fencing on every call.** The app derives the tenant from a user's first branch-access row. A console that edits branch access must not silently move a user between park groups. The existing app fences (`parkGroupOnly`, `requireSchedulePark`, data-admin scopes) are the rules to reuse.
10. **Fix first** (see §4, "Faults"): the global-admin escalation, the override-before-adminOnly order and the unchecked action keys. A console that exposes the app's roles would otherwise put those holes on a screen.
