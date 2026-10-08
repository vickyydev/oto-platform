# The OTO App lifted whole: the build plan for S2-17b (SCRUM-193)

_DRAFT, 8 October 2026. Not committed. Written from a read-only study of
`main` at a75d5891: the ticket (`docs/progress/SPRINT_2_PLAN.md`, S2-17b),
the app's own code under `apps/oto-app` (routes, schema, migrations, jobs),
what has already landed on its surface, the intake
(`docs/architecture/intake-2026-09-19/01-oto-app-backend.md`) and the closure
plan it fed (`docs/qa/oto-app-lift/closure-plan.md`). Jira was not readable
this session; ticket states are as the repository records them. Migration
numbers are given at landing: the platform's next free number is 0076 and
the app's own chain (`apps/oto-app/migrations`) is next free at 0005._

The owner's rule applies throughout, in its OTO App form: the live app's
existing behaviour is the approved behaviour. The lift changes WHERE the app
runs, not WHAT it does. Only data-reliability fixes are made on our own
authority, each named in section 4. Every rule choice is a question in
section 11, and the app's behaviour is the default until the owner answers.

## 0. Where it stands: read this first

S2-17b is not a fresh start. The app already runs on Render
(`oto-app-staging`) against schema `otoapp` of the platform database, opened
from the launcher with no second password. What has landed:

- **S2-17a (SCRUM-192, Deployed).** The `otoapp` schema from the app's own
  migrator (baseline 0000, `users.platform_user_id` 0001), the hand-off
  sign-on (`server/middleware/platformSignOn.ts`), the 10-second liveness
  check that ends a session signed out everywhere, legacy password login off
  on staging (`OTOAPP_LEGACY_LOGIN`), and platform provisioning
  (`POST /admin/apps/oto_app/users`, `core.app_identity`).
- **The branch seam (SCRUM-268, Deployed).** The platform writes
  `otoapp.branches.core_branch_id` when a park is opened or renamed, and
  seats a provisioned person in their branch (0002 makes the id unique).
- **The module slices (SCRUM-261, 262, 453, 454, 456 to 458 and 460 to
  466, all Deployed by 1 October).**
  Tenant and branch guards across users, organisation, check-ins, tasks,
  announcements, org chart, activity log, offboarding, Fix and supplier
  portal; private object storage on the platform bucket for every writer;
  kiosk upload and face-attempt throttles; the Data Admin credential
  exclusion. The module register is `docs/features/oto-app.md`; the evidence
  index is `docs/qa/SPRINT_2_ACCEPTANCE.md`.
- **The events seam (S2-20 round 0 and E1 to E5).** App migrations 0003
  (per-child attendee rows, `checkin_ref`, flat pass prices,
  `directory_clients`) and 0004 (the views `otoapp_v.events`,
  `event_attendees`, `event_attendance`, `children`); the tenant-bound
  directory key with scope `events:write`; the attendee, check-in and party
  edit write-backs (`server/directory/`); the POS reading only through the
  views, held by a grep test (`apps/api/test/g17-round0-review.test.ts`
  section D).
- **The booth roster (SCRUM-473).** The platform reads the app's rota
  tables directly to build the day's booth duty
  (`packages/db/src/schema/otoapp.ts:777-895`).

What is open. SCRUM-193 is In Progress with its five acceptance checks
unticked. The platform side owes:

- `otoapp_v.employees` and the copy into `core.employee`. Benefits (S2-21,
  Deployed) shows its check 1 on seeded rows until this lands.
- Tenant ownership for the six shared legacy tables. Until then those
  modules answer 503 for any tenant but the default one, and Attention is
  paused.
- Tenant-bound Directory HR reads.
- The app's timers under the platform job runner, with `ops_run` and
  Health/Failures.
- The restore rehearsal in CI.
- A module walkthrough per module, with screenshots.

**One finding changes the closure plan.** It asks for "persisted leave
approval". The live app has no approval state at all. Every time-off record
is treated as approved, and "approve" on sick leave is an action:

- Approving when the leave is created removes that person's schedule
  assignments for those days and raises a coverage alert per removed shift.
- Approving later unassigns them from the older shift list.

Nothing records who approved. The sources are
`imports/oto-app/server/routes.ts:11775-11800`, `:11891-11915` and
`:12312`. The lift turned both paths into a 503
(`apps/oto-app/server/routes.ts:12504`, `:12626`). The same commit
(b20ed05b) also removed `approved: true` from the rota's time-off create
(`client/src/pages/scheduling-page.tsx:1467-1473`; the original sends it at
`imports/oto-app/client/src/pages/scheduling-page.tsx:1473`). So the park
sees no error today: a sick day added on the rota saves, and the person
silently stays on their shifts with no coverage alert. Under the owner's
rule the default is to restore the app's behaviour, server and client
both, not to build a new approval workflow (Q1).

## 1. What the park sees

- **One staff list.** A person added as an employee in the OTO App appears
  on Admin > Staff Benefits within 15 minutes (or at once from Health > Run
  now). The list is read-only on the platform. When the app marks someone
  as left, they leave the panel and their benefit card is refused.
- **Every module works for every park group.** Policies, contract templates,
  the asset catalogue and Settings stop answering "This module is
  unavailable for this tenant". The Activity Logbook shows company-wide rows
  again. Attention alerts are raised, snoozed and resolved again.
- **The app's night work is visible.** The 00:01 batch (guest auto
  check-out, missing clock-outs, recurring tasks), the 03:00 batch (presence
  repair, leavers moved to Left, leavers' logins switched off, old
  availability records cleared) and the
  six-hour presence check each show on the Console's Health page with their
  last run. A failed run shows on Failures with Retry.
- **Leave and rota behave as the live app does.** A sick day added on the
  rota frees the person's shifts and raises "Shift needs coverage" alerts
  again; today it saves and leaves them on the shift (Q1). A shift
  row added without a group is refused in words ("Choose a shift group
  first") instead of failing with an error (Q2).
- **Clock-in.** Face clock-in stays off. The kiosk offers PIN and phone, and
  a face scan is never matched to anybody while face is off.
- **Signing in.** Nothing changes for staff: the launcher tile opens the
  app. On the Console, an administrator sees which OTO App users have no
  suite sign-in yet and links them with the existing Link action (Q6).
- **Parks.** A park opened on the Console appears in the OTO App's branch
  list, whatever case the client used for its id.
- **PDFs.** Contracts, letters, BEOs, payslips and payroll exports open only
  through short-lived signed links, never from a public address.

## 2. The reference (the OTO App as it is)

All paths are under `apps/oto-app` unless shown otherwise. The app is
Express 4 with Passport, Drizzle on `pg` and React. The code registers
about 824 routes (the intake counted 796 on 19 September; the lift added
the sign-on, the directory event writes and the job guards). There are 187
tables (the 184 of the baseline plus three from 0003) and four views. The
module map below is read from the routes and the schema, not from memory.
"State" is the module's line in `docs/features/oto-app.md` (1 October).

| Module | Where in the code | Main tables | State on staging | Round |
|---|---|---|---|---|
| Sign-on, session, account | `server/auth.ts`, `server/auth-otp-routes.ts`, `server/middleware/platformSignOn.ts` | `users`, `session`, `auth_*` | Works | 1 |
| Users, permissions, module overrides | `server/routes.ts:860-1440`, `shared/permissions.ts` | `users`, `user_branch_access`, `user_module_overrides`, `access_policies`, `people` | With caveats | 1 |
| Organisation: tenants, operators, branches, departments, roles, locations | `server/routes.ts` (`/api/branches`, `/api/admin/operators`, `/api/departments`, `/api/roles`, `/api/locations`) | `tenants`, `operators`, `branches`, `departments`, `roles`, `role_*`, `locations` | With caveats | 1 |
| HR employees | `server/routes.ts` (`/api/employees*`, 54 routes), `server/storage.ts` | `employees`, `employee_roles`, `employee_changes`, `employee_payroll_profiles` | With caveats | 2, 6 |
| Contracts and e-sign PDFs | `server/routes.ts` (`/api/contracts`, `/api/signing/:token`), `server/pdf.ts`, `server/pdf-storage.ts` | `contract_instances` | With caveats | 6 |
| Contract templates and assignments | `/api/templates`, `/api/template-assignments` | `templates`, `template_assignments` | With caveats; other tenants 503 | 6 |
| Policies | `/api/policies` | `policy_documents` | With caveats; other tenants 503 | 6 |
| Letters and e-sign | `/api/letters`, `/api/letter-sign/:token` | `employee_letters` | With caveats | 6 |
| Employee documents | `/api/employees/:id/documents` | `employee_documents` | With caveats | 6 |
| Assets | `/api/assets/*` | `asset_catalog`, `employee_assets` | With caveats; other tenants 503 | 6 |
| Offboarding | `/api/offboarding/*` | `employee_offboarding`, `offboarding_checklist` | With caveats | 6 |
| Kiosk devices and reception | `server/kiosk-auth.ts`, `/api/kiosk-devices`, `/api/kiosk/exchange`, `/api/kiosk-reception/*` | `kiosk_codes`, `kiosk_devices`, `kiosk_sessions`, `kiosk_auth_attempts` | Not yet verified | 5 |
| Kiosk clock: face, PIN, phone | `/api/kiosk/*` (14 routes), `server/face-recognition.ts`, `server/pin-utils.ts`, `server/advisor-attendance.ts` | `time_events`, `employee_presence`, `enrollment_sessions`, `advisor_*` | PIN and phone with caveats; face off | 5 |
| Timekeeping | `/api/timekeeping/*`, `/api/time-events*`, `server/timekeeping-deriver.ts` | `time_entries`, `time_adjustments`, `timekeeping_issues` | With caveats | 3, 5 |
| Scheduling | `/api/schedule/*` (42), `/api/shifts`, `/api/duty-*`, `/api/rota`, `/api/branch-events`, `server/break-generator.ts` | `schedule_*` (13 tables), `shift_groups`, `shifts`, `duty_*` | With caveats; ungrouped row 500 | 5 |
| Leave and holidays | `/api/time-off`, `/api/leave-*`, `/api/sick-leave-*`, `/api/public-holidays` | `employee_time_off`, `leave_policies`, `sick_leave_policies`, `public_holidays` | With caveats; approve 503 | 5 |
| Tasks and ops board | `server/core/tasksRoutes.ts`, `server/core/compat/*`, `server/core/taskGeneration.ts` | `tasks`, `task_*` (9 tables) | With caveats | 3, 5 |
| Checklists and media | `/api/checklists`, `/api/checklist-runs`, `server/core/checklistMediaRoutes.ts` | `checklist_*` (5 tables) | With caveats | 5 |
| Announcements and notifications | `server/core/announcementsRoutes.ts`, `server/notification-service.ts` | `announcements`, `notifications` | With caveats | 5 |
| SOP, KB, knowledge files, training | `/api/sops`, `/api/knowledge-base`, `/api/knowledge-files`, `/api/training` | `sop_articles`, `kb_*`, `knowledge_*`, `training_modules`, `quiz_*` | SOP works; rest with caveats | 7 |
| Ask OTO and AI helpers | `/api/ask-oto*`, `server/ai-routes.ts` | `ask_oto_*` | With caveats | 7 |
| Fix reports and supplier portal | `/api/fix-reports`, `/api/supplier-portal/*` | `fix_reports`, `fix_comments`, `fix_supplier_tokens` | Supplier works; Fix with caveats | 7 |
| Events core, BEO, packages, menus | `/api/events`, `/api/admin/events`, `server/beo-routes.ts`, `server/birthday-package-routes.ts` | `core_events`, `beo_*` (17), `studio_event_*`, `event_*` | With caveats | 7 |
| Parent portal, invitations, RSVP | `server/parent-experience-routes.ts` | `parent_portal_tokens`, `guest_invite_tokens`, `rsvp_entries` | With caveats | 7 |
| Camps and children | `/api/public/camp-*`, `/api/admin/children*`, `/api/core/camp-checkins/*` | `camp_registrations`, `camp_attendance` | With caveats | 7 |
| Drop-off, nanny, public check-in | `server/checkin-routes.ts` | `service_checkins`, `dropoff_checkins`, `nanny_reservations` | With caveats | 7 |
| Drop-off form builder | `server/dropoff-form-routes.ts` | `dropoff_forms`, `dropoff_form_versions` | Not yet verified | 7 |
| Staff vouchers | `server/voucher-routes.ts` | `voucher_templates`, `user_vouchers`, `voucher_redemptions` | Moved to the Console (Q8) | 7 |
| Casual workers | `server/casual-worker-routes.ts` | `casual_workers` | With caveats | 5 |
| Payroll | `/api/payroll/*` (45), `server/payroll-*.ts` | `payroll_*` (10), `payslips`, `salary_advance*`, `statutory_*` | With caveats | 7 |
| Org chart | `server/orgChartRoutes.ts` | `org_nodes`, `staff_cost_allocations` | With caveats | 6 |
| Attention engine and activity log | `server/attention-engine.ts`, `/api/attention-*`, `/api/activity-logs` | `attention_items`, `activity_log` | Attention paused; activity with caveats | 4 |
| Xero and finance sync | `server/xero-routes.ts`, `server/finance-sync*.ts` | `xero_*` (5), `cash_daily`, `cash_txns`, `pl_facts` | Disabled until the sandbox is connected | 7 |
| Vault | `/api/access` | `access_items`, `access_view_logs` | With caveats | 7 |
| Directory API | `server/routes.ts:13741-13880` (HR reads), `server/directory/*` (event writes) | `directory_clients` | HR reads broken for many tenants | 4 |
| Data Admin | `server/data-admin/*` | about 90 models | With caveats | 7 |
| Files and settings | `server/file-storage.ts`, `server/storage/*`, `/api/settings` | `files`, `settings` | Files with caveats; settings 503 | 4, 7 |
| Background jobs | `server/scheduled-jobs.ts:429-455`, started at `server/index.ts:139-142`; manual triggers `POST /api/admin/run-departed-deactivation` (`server/routes.ts:1340`) and `POST /api/scheduler/transition-left` (`:8394`) | (writes across the above) | Not yet verified; the manual triggers run across every park group | 3, 4 |
| Dev and maintenance tooling | `POST /api/seed` (`server/routes.ts:6201`, no sign-in), `/api/admin/prod-sync` (`server/prod-sync.ts:576-610`), `/api/dev/import-core-legacy-uploads` (`:25896`), `/api/test-sentry` (`:749`), `/api/test-object-storage` (`:23798`), `/api/admin/backfill-employee-photos` (`:1350`), `/api/admin/fix-pending-with-signed-contracts` (`:1899`) | prod-sync deletes and reloads the 174 tables of its load order, `users` and `branches` included (`prod-sync.ts:7`, `:308`, `:475`); the others write `users`, `employees` and the bucket | prod-sync and the dev import refused on staging (`NODE_ENV`, `APP_ENV`); seed a no-op while users exist; the other four live: test-object-storage gives any signed-in user the bucket name and region and writes to the bucket, and the two maintenance routes run across every park group | 1 |

## 3. The app's behaviour, ported as it is

| Rule | The app's behaviour (kept) | Source |
|---|---|---|
| Who someone is inside the app | `users.role` is one of six values. An advisor resolves to admin, manager or staff from `access_policies`. Branch reach comes from `user_branch_access`. Module switches gate the screens. Advisors are kept out of contracts, scheduling and payroll. The platform grants only `app:oto_app:access`; the app decides everything inside. | `shared/schema.ts:101-150`, `server/routes.ts:766-782`, `storage.ts` `getUserWithBranchAccess` |
| A user's own employee record | `employees.user_id` first. Otherwise the single employee with the user's email, tie-broken by phone, then by full name. | `server/storage.ts:2180-2205` |
| Tenancy | A tenant is the park group; its tenant comes from a user's first branch-access row. An operator is a legal entity inside it. | intake §3, `shared/schema.ts:12-49` |
| Employee life | `status` is pending, active, resigned or terminated. `employment_state` goes ACTIVE, then LEAVING, then LEFT at the 03:00 run after the last working day. That run also switches off the app login of anyone whose last working day has passed. | `shared/schema.ts:665-669`, `server/scheduled-jobs.ts:77-126` |
| Leave | Every time-off record counts as approved; there is no status. SICK leave created as approved removes the person's schedule assignments for those days and raises a "Shift needs coverage" alert per removed shift, graded by how soon the shift is. Approving it later unassigns the person's shifts in the older shift list (`shifts`). Leave conflicts are checked on the Bangkok calendar day. | `imports/oto-app/server/routes.ts:11775-11800`, `:11891-11915`, `:12312`; the Bangkok fix is already on main |
| Scheduling | Shift groups, rows, week plans and templates. Breaks come from the break generator, and short shifts get no break. A row's group is required by the database. | `server/break-generator.ts`, `shared/schema.ts:2963-2968` |
| Timekeeping | PIN and phone clock-in at a configured kiosk. At 00:01 Bangkok, every IN with no later OUT gets an OUT at midnight, noted "[Auto-clocked out at midnight — missing clock-out]". | `server/scheduled-jobs.ts:128-178` |
| Recurring tasks | Generated at 00:01 Bangkok, check-then-insert. | `server/core/taskGeneration.ts`, `server/scheduled-jobs.ts:268` |
| Attention | About 22 rules. Items are upserted by fingerprint. The engine runs every six hours, and a no-show check runs every 10 minutes from 07:00 to 22:00. | `server/attention-engine.ts`, `server/scheduled-jobs.ts:298-455` |
| Contracts and letters | Signing links last seven days. The employer counter-signature comes from three `settings` rows (`md_signatory_*`). PDFs are rendered by Chromium in the container. | intake §2, `server/pdf.ts` |
| Events | The app is the master of every event, registration and check-in (C10); the POS mirrors it and writes back through the directory. | 0004 header, `server/directory/eventRoutes.ts` |
| Park-side drop-off | The app's check-in module keeps working; the platform's S2-13 board is never written into it. | checkin PLAN §2.6, OD-C1 |
| Ask OTO | Keyword scoring over KB, SOP and files. Thread titles are shown, not stored (the owner accepted this on 1 October). | closure plan |
| Time and money | Naive UTC timestamps with `TZ=UTC` and a hand-rolled +7 hours for Bangkok. Whole baht. The views give the zone and convert to satang. | intake §5, 0004 |
| Public links | Supplier links are stored as SHA-256. Existing and new check-in photo links are permanent (the owner's choice). | closure plan |

## 4. Fixed, because the app is broken there (data reliability)

- **A park opened with an upper-case id falls out of the seam.** The
  platform accepts a client-minted branch id with `z.string().uuid()`, which
  takes upper case (`apps/api/src/services/client-id.ts:49`). It writes that
  string unchanged into `otoapp.branches.core_branch_id`
  (`apps/api/src/routes/branches.ts:119-127`,
  `packages/db/src/schema/otoapp.ts:417`). But `core.branch.id` reads back in
  lower case, and the views match lower case only (0004, lines 52-58). The
  park's events would then never reach the POS, and later lookups by the
  platform's id would miss the row. No client sends one today; this was
  noted at the round 0 landing. Fix: lower-case the id at every platform
  write into the seam (create, rename, reconcile), and run a read-back
  census of existing rows on staging. A row the census finds is
  lower-cased in place only when no other row already holds the
  lower-case form (the unique index is over the raw text); a collision is
  listed for an administrator, never merged.
- **Face clock-in "off" still matches faces.** With
  `USE_AWS_REKOGNITION` unset, the app uses a stand-in matcher that returns
  the FIRST enrolled person for any face
  (`server/face-recognition.ts:131-145`, `:601-609`). The intake warned that
  unsetting the flag is not the same as switching face off. Staging has
  nobody enrolled. The production data, once restored (S2-22), does. Fix:
  while face is off, `/api/kiosk/identify-face` answers with the app's own
  "no match, use PIN" reply without calling a matcher, and enrolment is
  refused. The kiosk's existing PIN fallback takes over. The face clock
  itself, `POST /api/kiosk/clock` (`server/routes.ts:9615`), takes the
  employee id and a confidence score from the tablet and matches nothing on
  the server, so it is refused while face is off too (`render.yaml`'s note
  on `USE_AWS_REKOGNITION`: "the routes have to go, not just the flag").
- **The night jobs can run twice, lose a night, or fail silently.** They are
  in-process timers with no lock. Each catches its own error, logs it and
  carries on (`server/scheduled-jobs.ts`, every `catch`). If the process is
  down at 00:01, nothing catches up. This is why `render.yaml` pins one
  instance. Fix: the platform's job runner owns the schedule. The advisory
  lock and `ops_last` make each batch run once per Bangkok date. A caught
  error becomes a failed step, a failed step becomes a failed run on
  Failures, and Retry re-runs it.
- **Shared tables answer across park groups.** `settings` (whose key is
  globally unique), `templates`, `policy_documents`, `asset_catalog`,
  `activity_log` and `attention_items` have no tenant column. The lift made
  their routes fail closed (`server/routes.ts:7012-7092`). Fix: additive
  tenant columns with a backfill, then each caller reads and writes its own
  tenant's rows, and the 503 guards come off.
- **Directory HR reads trust one shared key.** The six `/api/directory/*`
  HR reads authenticate `HR_DIRECTORY_API_KEY`, which names no tenant, and
  can return any tenant's staff (`server/auth-middleware.ts:231-259`). Fix:
  they accept the tenant-bound key that the event writes already use (new
  scope `hr:read`) and answer only for that tenant.
- **The finance upserts have no keys to conflict on.** Invalid Drizzle
  syntax meant the composite primary keys on `xero_tracking_categories`,
  `xero_tracking_options`, `cash_txns` and `cash_daily` were never created,
  and `pl_facts` has none. The baseline shows the same
  (`migrations/0000_otoapp_baseline.sql:1467-1481`), so Finance Sync's
  `ON CONFLICT` fails at runtime (intake §7). Fix: an app migration adds
  them. S2-22's post-import step then finds them already there.
- **A shift row without a group fails with a 500.** The route passes
  `shiftGroupId: null` (`server/routes.ts:14219`), but the column is NOT NULL
  in the schema and in production. Fix (no rule change): the route refuses
  with a 400 in words before the insert. Whether ungrouped rows should be
  allowed is Q2.
- **Offboarding writes are not one transaction.** The offboarding row is
  written under an advisory lock in its own transaction. Then the
  employee's state, the login switch-off, the asset return dates, the
  change record and the checklist each follow as separate statements
  (`server/routes.ts:7431-7505`). A failure part way through leaves a
  half-offboarded employee (open in
  `docs/qa/oto-app-lift/org-hr-verification.md`). Fix: one transaction for
  the whole sequence. A unique open offboarding per employee is added as a
  backstop only if the census of existing rows is clean.
- **The lift left some users with no way in.** With legacy login off, a user
  made in the app's own Users screen (`POST /api/users`,
  `/api/employees/:id/enable-login`) has a password nothing accepts, and no
  platform account. Fix: the Console lists app users with no
  `platform_user_id`, beside the existing Link action (claim by id). The
  app's screens are unchanged (Q5, Q6).
- **A platform edit to a copied employee would be silently undone.**
  `PATCH /me` edits the caller's `core.employee` name, nickname, email and
  phone (`apps/api/src/routes/me.ts:80-108`). On a row copied from the app,
  the next copy would overwrite the edit. Fix: those fields are refused on
  an `otoapp` row ("kept in the OTO App"), as C13 says.
- **A change to the app alone is never tested.** CI marks a push that
  touches only `apps/oto-app/` as "not workspace" (`.github/workflows/ci.yml:70`).
  So a new app migration skips the platform tests that apply the app's
  migrations and query the views. Fix: changes under
  `apps/oto-app/migrations/` and `apps/oto-app/server/directory/` count as
  workspace changes, and an OTO App job builds the app and runs its migrator
  twice from empty.
- **Maintenance and dev routes reach across park groups.** `requireAdmin`
  lets any park group's admin through (`server/auth-middleware.ts:131`).
  Behind it, `run-departed-deactivation`, `scheduler/transition-left`,
  `backfill-employee-photos` and `fix-pending-with-signed-contracts` read
  and write every park group's users and employees, outside any lock.
  `test-object-storage` hands any signed-in user the bucket name and region,
  which `/api/status` was scrubbed of, and writes a file to the bucket.
  `prod-sync` would empty and reload 174 tables of the shared schema,
  `users.platform_user_id` and `branches.core_branch_id` included; today
  only `NODE_ENV` stops it. Fix: the four maintenance routes act on the
  caller's own park group only, and the two job triggers follow the
  `OTOAPP_JOBS` switch (section 5, round 3). `prod-sync`,
  the dev import, `test-sentry`, `test-object-storage` and `seed` are
  refused on every deployment by `DEPLOY_ENV`, the key the boot guard
  already uses.
- **A linked app user can be deleted under the platform.** The app's delete
  refuses a user with an employee or person record (`server/routes.ts:1428-1436`),
  but not one that only carries `platform_user_id`. Deleting one leaves
  `core.app_identity` pointing at nothing, and the person's launcher tile
  opens on a refusal. Fix: the same 409, in the app's own words ("Deactivate
  this account..."), for a user with `platform_user_id`.
- **The old voucher ledger still takes writes.** The app's voucher screen
  shows "Vouchers have moved to the Console", but the routes behind it are
  still mounted (`server/voucher-routes.ts`: template create, edit and
  delete, assign, bulk assign, delete, redeem). A direct call writes a
  second live ledger, which section 7 says is read-only history. Fix: the
  write routes answer with the Console notice; the reads stay.

## 5. From the ticket, where the app has nothing

- **`otoapp_v.employees` and the copy into `core.employee`** (C13, S2-21).
  - The view, made by the app's migrator like 0004, exposes only what the
    platform needs: id, tenant, the app branch and the platform branch
    (through `core_branch_id`), full name, nickname, phone (E.164), email,
    status, employment state, last working day, `updated_at`, and the
    `platform_user_id` of the user the app's own rule links to this
    employee (section 3). Nothing about pay, tax, SSO, visa, address, date
    of birth, face or PIN.
  - The platform job `job:otoapp.employee_sync` runs every 15 minutes, with
    an `ops_expectation` and a Run now button.
  - Per app tenant, it finds the operator through the tenant's mapped
    branches (the anchor rule of `mapCoreBranchIntoApp`). A tenant with no
    anchor, or anchored to two operators, is skipped and named in the run.
  - It upserts `core.employee` with `source = 'otoapp'` and
    `external_id = <app id>`.
  - **Adoption.** When the app links the employee to a user whose
    `platform_user_id` is an account that already has a `core.employee`
    with no `external_id`, that row is adopted: same id, so benefit
    profiles and cards stay. It is never duplicated.
  - **Conflicting adoption.** If the employee already has a copied row of
    its own, the two are not merged. The case is raised as
    `otoapp:employee.sync` with both ids for an administrator (H2).
  - **One person, one account.** The app's email fallback is not limited
    to a park group (`server/storage.ts:2184-2205` matches `lower(email)`
    across every tenant). So a linked account counts only when it belongs
    to the operator the employee's tenant is anchored to. Any other link is
    treated as no link and raised, as the booth roster already treats one
    (`apps/api/src/services/booth-duty.ts:185-210`). When the copy creates
    a row for an employee whose linked account has no employee record, it
    sets that account's `employee_id` in the same transaction. An account
    already pointing at a different employee row is left as it is and
    raised (H23).
  - **One rule in both readers.** The booth roster resolves an app employee
    to an account through `employees.user_id` only
    (`booth-duty.ts:345-352`). The view adds the app's email fallback. So
    in round 2 the roster takes the person's account from the employee
    repository (the view's column), while still reading the rota rows
    directly (Q11). The roster and the copy can then never name two
    accounts for one person (H24).
  - **Leaving.** It archives a row when the app says LEFT or the employee
    is gone. Archiving revokes the person's live benefit cards (a system
    `benefit.credential_revoke`), so a rehire gets a new card. A rehire (the
    same app id active again) un-archives the same row rather than making a
    second one, so the person keeps one id. The partial unique index
    `employee_external_id_unique` (`packages/db/src/schema/tenancy.ts:123`)
    would otherwise allow a second live row beside the archived one (H25).
  - **The swap.** No benefits query changes: the panel already lists the
    operator's `core.employee` rows with their `source`
    (`apps/api/src/services/benefits.ts:460-466`). What flips:
    - The two `it.todo`s in `apps/api/test/s221-r4-closing-audit.test.ts:317-318`
      (check 1 on the mirror; a scan for an employee the platform does not
      have raising `otoapp:employee.sync`) become tests. The file's registry
      names them under check 1 (`:131-136`) and H17, beside the seeded-row
      test, which stays for the dev seed.
    - `apps/api/test/benefits-r1.test.ts` check 1 keeps `source === 'platform'`:
      the dev seed is still the platform's. The mirrored reading is proved
      by the new tests and on staging.
    - Section D's "only the repository names otoapp_v"
      (`apps/api/test/g17-round0-review.test.ts:1325-1328`) names the new
      employee repository beside `otoapp-events.ts`.
    - The doc comment at `apps/api/src/services/benefits.ts:55-57` and
      SCRUM-218's comment stop saying "seeded".
    - The panel shows the source, a UI addition (the API already returns
      it).
- **The app's jobs on the platform runner** (ticket: Background work).
  - **The app's side.** The app exposes
    `POST /api/directory/jobs/:name/run` under a tenant-bound directory key
    with scope `jobs:run`. It runs that tenant's part of the batch
    synchronously and answers with a summary for each step. Each job
    function takes the key's tenant.
  - **The platform's side.** The platform registers:
    - `job:otoapp.midnight`: the 00:01 batch, due once per Bangkok date.
    - `job:otoapp.reconcile`: the 03:00 batch, also once per date.
    - `job:otoapp.presence`: every six hours.
    - From round 4, `job:otoapp.attention` (every six hours) and
      `job:otoapp.no_show` (every 10 minutes, 07:00 to 22:00).
  - The runner is interval-only (`apps/api/src/services/jobs.ts:113-124`).
    So the daily batches tick every five minutes and run when the Bangkok
    time is past their hour and no success is recorded for that date.
  - `OTOAPP_JOBS=inprocess|platform` decides who runs them. The app starts
    no timers under `platform`, and the endpoint refuses under `inprocess`.
  - The app's two manual triggers (`/api/admin/run-departed-deactivation`,
    `/api/scheduler/transition-left`) are called by no screen. Under
    `platform` they answer in words pointing at Run now on the Console's
    Health page, so a call never races the scheduled run. Under
    `inprocess` they run as today, for the caller's park group only.
  - Finance Sync is not here: the app has no timer for it, only manual
    routes (section 6, Q15).
- **Tenant-bound Directory HR reads**, as in section 4. The shared key keeps
  working only where it is set, and only for the default tenant (Q13).
- **The restore rehearsal in CI** (ticket: cutover compatibility).
  - CI applies the app's baseline into `public` of a scratch database and
    loads the sample seed (`script/sample`).
  - It runs `pg_dump`, restores into a second scratch database, and renames
    `public` to `otoapp` there.
  - It loads that into a fresh platform database after the platform
    migrations.
  - It records 0000 as applied without running it, applies 0001 onwards,
    then checks that the views exist and that the row counts equal the
    sample. It does this twice.
  - A local run against `imports/_db/data-structure-only-for-oto-app.sql`
    proves the real structure. That file is never committed; the run log's
    counts are.
  - S2-22 reuses the script for the real data.
- **The Console list of app users with no suite sign-in** (section 4).
- **SCRUM-469's branch picker**, only on the owner's go (Q7).
  Provisioning from the Apps dialog grants `app:oto_app:access`
  operator-wide (`apps/pos/src/components/admin/access/AccountAppsDialog.tsx:92-102`),
  which makes everyone provisioned "staff of both parks" on the platform
  side (`docs/progress/BRANCH_ISOLATION_REGISTER.md`, the SCRUM-268 re-test).
  The API already takes a branch; the dialog does not offer one.
- **The PDF and storage gate.** Contract, letter, BEO, payslip and export
  PDFs are opened only through signed short-lived links, and an
  unauthorised session is refused. Ticket acceptance check 2.
- **A walkthrough page per module** in `docs/qa/SPRINT_2_ACCEPTANCE.md`
  (with its linked notes under `docs/qa/oto-app-lift/`). Each page records
  one real action and its result, one refused role, branch or tenant case,
  and the tablet width, with a named screenshot. The statuses in
  `docs/features/oto-app.md` become working, working with caveats, or
  disabled on staging with the reason.
  - Restricted test identities come from the Console's temporary password
    (`apps/api/src/routes/accounts.ts:494`), never from an SMS setup.
  - Fixtures are ZZ TEST, removed by exact id, with a read-back.

## 6. Where the ticket or the closure plan differs from the app (the app wins until answered)

| Ticket or closure-plan text | The app | Default here |
|---|---|---|
| Closure plan: "persisted leave approval" | No approval state. Approving SICK leave frees the shifts and raises coverage alerts, and nothing is stored. The lift made approve a 503. | Restore the app's behaviour (Q1) |
| Closure plan: "a nullable shift-group column or an approved group contract" | The code sends no group; the database, here and in production, requires one, so it fails with a 500 | Keep the database rule and refuse in words (Q2) |
| Decision 29 names a flag `OTOAPP_FACE_CLOCKIN` | The app's flag is `USE_AWS_REKOGNITION`, and "off" runs a stand-in matcher | The app's flag; "off" refuses instead of matching (section 4, Q9) |
| Ticket: staff vouchers working | An earlier slice replaced the app's voucher screens with "Vouchers have moved to the Console" (one platform ledger, till redemption, old rows read-only; `docs/qa/oto-app-lift/module-entry-smoke.md`) | Keep, because two live voucher ledgers would be a data fault (Q8) |
| Ticket: the nightly departed-account deactivation under the runner. Intake §10: also deactivate the platform account | The app switches off only its own login | The app's behaviour. The run names any still-active linked platform account on Failures (Q4) |
| Ticket: Background work names finance sync among the scheduled jobs | Finance Sync has manual routes only (`/api/finance/sync/*`, `server/finance-sync-routes.ts`); no timer runs it, and which park group a scheduled sync would serve is undecided (closure plan) | Stays manual, and disabled on staging until the sandbox is connected (Q15) |
| Ticket: the POS reads through platform-owned views | The booth roster reads the rota tables directly (SCRUM-473). Provisioning writes `users` and one `user_branch_access` row; the branch seam writes `branches` | Keep these declared seams, held by a column test (Q11, H18) |
| Ticket: the rehearsal restores "a structure-only copy of the production dump", in CI | The dump lives in `imports/`, which is never committed | CI uses the baseline in `public` (the intake found zero drift between code and dump), plus a local run on the real structure file (section 5) |
| Intake §10: point the app's 15 credential-writing routes at the Console | The app keeps its password screens | The app's screens, unchanged (Q5) |
| Ticket: Xero (sandbox) working | The park's sandbox is not connected | Disabled on staging until it is; the refusal proof stands (recorded) |
| Ticket: face enrolment only if decision 29 says keep | The owner keeps face off on staging | Off |

## 7. Data model and migration needs (numbers assigned at landing)

**What stays in the app's schema and what crosses to core.** All 187
`otoapp` tables stay where they are, owned by the app's migrator. Nothing is
moved out. These things cross, each in one direction:

| Thing | Master | Platform side | How it crosses |
|---|---|---|---|
| Who can sign in | `core.account` | `otoapp.users.platform_user_id`, `core.app_identity` | Provisioning and the hand-off (S2-17a) |
| Employees (the HR record) | `otoapp.employees` | `core.employee`, source `otoapp`, read-only; `core.account.employee_id` where it was empty | `otoapp_v.employees`, then `job:otoapp.employee_sync` (round 2) |
| Parks | `core.branch` | `otoapp.branches.core_branch_id` | The platform writes it at open and rename (SCRUM-268) |
| Events, camps, parties, registrations, event check-in | `otoapp` | The POS mirror tables | `otoapp_v` views; directory writes (S2-20) |
| Park-side drop-off and supervision | The platform (S2-13, OD-C1) | `crm`, `pos` | The app's own module coexists and is never written by us |
| Staff vouchers | The platform's promo ledger | `promo` | The app shows the Console notice; its old rows are read-only |
| Staff benefits | The platform | `promo.benefit_*`, keyed to `core.employee` | The round 2 swap |
| The booth's day roster | The app's rota | `booth.booth_duty_assignment` | Direct read (SCRUM-473) |
| Job run records | `core.ops_run`, `ops_last`, `ops_expectation` | — | Round 3 |
| Everything else: HR documents, payroll, timekeeping, scheduling, tasks, knowledge, Fix | `otoapp` | — | Nothing crosses |

**App migrations** (`apps/oto-app/migrations`, next free 0005). Each is
generated, has `"public".` stripped, is expand-only, and is read before it
is committed.

- Round 2: `otoapp_v.employees` (a view; created after 0004 by the same
  migrator, so Postgres then refuses any later drop or retype of a column it
  reads).
- Round 4 (expand): `tenant_id` on `settings`, `activity_log` and
  `attention_items`, each with an index.
  - The backfill takes the tenant from the branch, then from the employee,
    then the default tenant.
  - It adds a unique (`tenant_id`, `key`) index on `settings`.
- Round 4 (contract, one release later, its own landing "4b"): drop the
  global unique on `settings.key`, and set the new tenant columns NOT NULL
  once a read-back shows no nulls. Until 4b lands, `settings_key_unique`
  (`migrations/0000_otoapp_baseline.sql:1177`) stops a second park group
  writing any key the default group already holds (the `md_signatory_*`
  rows, the Attention rule settings). So in 4a the settings writes of other
  park groups stay refused in words, and round 4's acceptance is claimed
  after 4b.
- Round 6: the same pattern for `templates`, `policy_documents` and
  `asset_catalog` (expand in round 6, NOT NULL in round 7's release). Also
  a unique open offboarding per employee, only if the census is clean.
- Round 7: the four finance composite primary keys and a unique index on
  `pl_facts`.
- A census in round 4 gives a disposition for the other root tables with no
  tenant column: `leave_policies`, `coverage_rules`, `invitation_designs`,
  `i18n_translations`, `package_line_item_templates` and `people`. Each is
  either reached through a tenant-bearing parent or listed with its
  exposure. Children of tenant-bearing parents need nothing.
- None for leave (Q1 default) or shift groups (Q2 default). If Q2 says
  "allow", the round adds a nullable `shift_group_id`, and the booth reader
  skips ungrouped rows.

**Platform migrations.** None expected. `core.employee.source` and
`external_id` exist since 0066 (`packages/db/src/schema/tenancy.ts:85-127`),
and `ops_run`, `ops_last` and `ops_expectation` exist. Expectations for the
new jobs are registered by the jobs themselves.

**Not migrations, but needed.**

- New directory scopes `hr:read` and `jobs:run`
  (`server/db/coreSchema.ts:236`; `scopes` is `text[]`).
- The app's `OTOAPP_JOBS` setting.
- A directory key for the platform's job calls.
- Each new variable in `render.yaml`, `apps/oto-app/.env.example` and the
  root `.env.example` (the ticket's `.env.example` block for the app).
- On staging and in tests, `SELECT` on `otoapp_v.employees` for the
  platform's api role. Grants are not made in migrations (0004 header).

## 8. The rounds

| Round | Scope | Acceptance |
|---|---|---|
| 1 | **Sign-on and identity.** The upper-case seam fix and its census. The Console list of OTO App users with no suite sign-in, with the existing Link. SCRUM-469's branch picker in the Apps dialog, only on the owner's go (Q7). CI: app migration and directory changes run the platform suite; an OTO App job builds the app and runs its migrator twice from empty. Check that deleting a referenced user answers in words (the bare 500 in the SCRUM-193 comment, against the 409 at `server/routes.ts:1434`), and refuse deleting a user that carries `platform_user_id` the same way - at EVERY door that deletes a user (the users route, the people route, the employee flows), so no door can orphan a `core.app_identity` row. The dev and maintenance routes: refused on every deployment, or held to the caller's park group (section 4). | H1, H19, H26 and H28 green. The staging census shows no non-lower-case `core_branch_id`. A user made in the app's Users screen appears on the list and opens the app from the launcher after Link. A CI run on an app-only commit shows the view tests ran. Walkthrough pages: launcher sign-on, users and permissions (a restricted role on a temporary-password identity), organisation (a department action and a lower-role refusal). |
| 2 | **The employee mirror.** `otoapp_v.employees` with the column allow-list. The platform's read-only repository (the only file besides `otoapp-events.ts` that names `otoapp_v`). `job:otoapp.employee_sync` with its expectation: tenant-to-operator anchor, adoption, create, update, archive on LEFT or gone, un-archive on rehire, card revocation on archive. The account link: an account outside the anchored operator is no link, a created copy sets the account's `employee_id`, a clash is raised. The booth roster takes the person's account from the employee repository. Mirrored fields refused on `PATCH /me`. The benefits panel shows the source, and an unknown employee raises `otoapp:employee.sync`. The section D grep extended to the HR tables, apart from the declared seams. The benefits flips listed in section 5 ("The swap"). Can build in parallel with round 1; lands after it. Carries round 1's three standing pins: Link refuses a user the unlinked list would not show this operator; a case-collision row still fences the first-time name match while mapping as nobody's; and the employee and people delete doors answer 404 across park groups the way the users door does. | Benefits check 1 on mirrored rows: the two `it.todo`s of `s221-r4-closing-audit.test.ts` are tests, registered under check 1 and H17. H23 to H25 green. On staging: the four demo people created as employees in the OTO App, their accounts provisioned with the same emails, the four `core.employee` rows adopted, and Nok's override still in place. H2 to H7 green. A second run changes nothing. The job is on Health. A staging read-back shows the api role reads the view. SCRUM-218's comment updated. Walkthrough page: HR employees (create and edit, refused branch read). |
| 3 | **The night work on the platform runner.** The app's job endpoint, scope `jobs:run` and tenant-scoped job functions. Every swallowed error reported as a failed step. `OTOAPP_JOBS`. The platform registers `job:otoapp.midnight`, `.reconcile` and `.presence`, with expectations and the forced-failure test control. The departed-login step names still-active linked platform accounts (Q4). The two manual triggers follow `OTOAPP_JOBS` (section 5). Flip to `platform` on staging only after one platform-run success; Attention stays paused. | Ticket check 3: two jobs on Health with last-success times, and a forced failure on Failures whose Retry succeeds. H8 and H9 green. Under `platform`, the app registers no timers (test). On staging, a midnight batch run by the platform produced the auto clock-out and the day's recurring tasks. Walkthrough pages: timekeeping, tasks (recurrence). |
| 4 | **Tenant ownership, Attention and the Directory, in two landings.** 4a: the expand migrations. The settings helper and every caller take the tenant. Settings reads open to every park group; other park groups' settings writes stay refused in words while `settings_key_unique` stands (section 7). Branchless Activity rows show in their own tenant. Directory HR reads under `hr:read`. The root-table census. 4b, the next release (a short build-review cycle of its own): the contraction, then other park groups' settings writes open, and Attention resumes (`ATTENTION_WRITES_READY`) with rules per tenant (its rules are the settings key `attention_rules_config`), run as `job:otoapp.attention` and `job:otoapp.no_show`. | Claimed after 4b. H10 to H12 and H20 green. A second tenant's settings, activity and Attention are invisible to the first, on staging and in tests. Refresh, snooze and resolve work on staging. A directory read across tenants answers 404. Walkthrough pages: settings, activity log, Attention engine, Directory API. |
| 5 | **Attendance and operations as the app does them.** Leave approval restored (Q1): the server's two 503s removed and the rota's `approved: true` put back, with each coverage alert written to its park group (round 4's column). The shift-row refusal (Q2). Face "off" refuses instead of matching, `/api/kiosk/clock` included. A configured-device reception action. Restricted-branch proof for scheduling, leave, checklists, announcements and notifications. Casual workers' ungrouped-row case. | H13 to H15 green. Walkthrough pages: kiosk devices and reception, face/PIN/phone, timekeeping (restricted branch), scheduling, leave and holidays, tasks and ops board, checklists and media, announcements, in-app notifications, casual workers. |
| 6 | **The document modules.** Tenant columns for templates, policies and the asset catalogue (expand; NOT NULL in round 7's release); their 503 guards off. Contracts, letters, templates, policies, employee documents, assets, offboarding (one transaction, the readable reason label, linked-user deactivation as the app does it) and the org chart (count first, because its GET writes missing nodes). The PDF and storage gate. The offboarding duplicate census. | Ticket check 2: a contract and a letter signed, and a BEO generated, opening from signed URLs, with an unauthorised read refused (test and screenshots). H16 green for offboarding. Walkthrough pages: contracts, templates, policies, letters, employee documents, assets, offboarding, org chart. |
| 7 | **Park, knowledge, administration, finance.** The finance keys migration. Round 6's NOT NULL contraction. The app's voucher write routes answer with the Console notice (section 4). Walkthroughs for events, BEO, packages and menus, camps and children, the parent portal and RSVP, drop-off and nanny, the form builder (on an isolated tenant), staff vouchers (the Console contract), SOP, KB, training, Ask OTO, Fix and supplier portal, payroll, Xero (refusal only until the sandbox), vault, Data Admin, files. Decision 25 recorded in the ARCHITECTURE decisions log. The POS seam evidence card. | Ticket check 5: the POS reads `otoapp_v.events` for the seeded events, plus the grep test, as a test-run card. A finance upsert test. H27 green. Walkthrough pages for every module named. |
| 8 | **Rehearsal and closure.** The restore rehearsal script in CI, plus the local run on the real structure. A typecheck ratchet for the app (its inherited error count may not rise). The final desktop and park-tablet pass. `docs/features/oto-app.md` statuses for every module. The acceptance index ticked. SCRUM-193 walked to Deployed. | Ticket check 4: the rehearsal completes in CI and the counts match, twice (H17). Ticket check 1: every module has its page, or is named as disabled on staging with the reason. All five checks ticked with named evidence. |

Size: XL, in nine lane build-review cycles (round 4 lands as 4a and 4b).
Ordering:

- Rounds 1 and 2 come first: benefits waits on the mirror.
- Round 3 must precede round 4, because Attention needs a locked job.
- Round 4 must precede round 5: the restored sick-leave approval writes
  coverage alerts, which need Attention's park-group column and 4b's
  resumed writes.
- The heavy document modules come late (round 6), once tenant ownership
  has a proven pattern.
- Nothing breaks the running app mid-lift:
  - Every migration is expand-only, and each contraction (settings in 4b,
    the document tables in round 7) waits a release.
  - The job switch flips only after a platform-run success.
  - The mirror only reads the app.
  - Face stays off throughout.
- The rehearsal (round 8) touches only CI and tooling. It can build in
  parallel with any round from 3 on, and lands last so it covers every app
  migration.

## 9. Permissions, audit and ops_run

**Permissions** (platform):

- No new permissions.
- `admin:account:read` reads the list of app users with no suite sign-in.
- `admin:role:assign` links them (the existing provisioning).
- `admin:health:read` and `admin:ops:manage` see, run and retry the
  `job:otoapp.*` jobs.
- `admin:benefit:read` still governs the benefits panel.
- Inside the app, roles, branch access and module switches are unchanged.

**Directory scopes** (app): `events:write` (existing), `hr:read` and
`jobs:run` (new). Each key is bound to one tenant. A key with the wrong
scope gets a 403 and a key for another tenant gets a 404, as today.

**Audit actions** (platform):

- `employee.mirror_create`, `employee.mirror_update`,
  `employee.mirror_adopt`, `employee.mirror_archive` and
  `employee.mirror_restore` (a rehire), with a system actor and the app id
  in the detail.
- `account.employee_link` when a copy sets an account's `employee_id`,
  with the account's before and after.
- `benefit.credential_revoke` with a system actor, when the mirror archives
  a person.
- The existing `app_identity.link` and `branch.oto_app_map`.
- The app's own Activity Log keeps recording the app's own actions,
  unchanged.

**ops_run:**

- `job:otoapp.employee_sync`, `job:otoapp.midnight`,
  `job:otoapp.reconcile` and `job:otoapp.presence`.
- From round 4, `job:otoapp.attention` and `job:otoapp.no_show`.
- Kind `integration`, `otoapp:employee.sync`, for a tenant with no anchor,
  a conflicting adoption, a link to another operator's account, an account
  already tied to a different employee row, or an employee a benefit scan
  cannot find.
- Each job has an `ops_expectation`, so a silence raises an alert.

## 10. Known effects of following the app

- **Copied employees have no platform department.** The app's departments
  do not correspond to the platform's.
- **Approved leave leaves no record of who approved it** (Q1).
- **A password set in the app is not used** while launcher sign-on is the
  way in (Q5).
- **Auto clock-outs are labelled FACE.** The midnight clock-out records its
  method as FACE (`server/scheduled-jobs.ts:158`), so it counts as a face
  use in the timekeeping figures (Q10).
- **The night batches run at the platform's first tick after their hour.**
  That can be up to five minutes later. The auto clock-out time stays
  midnight.
- **Attention's first run on staging raises a backlog.** Turning it back on
  applies about 22 rules to existing rows at once. Expect a burst of alerts
  on the first run.
- **The org chart's node read writes.** It inserts missing nodes. The
  walkthrough counts first.
- **Kiosk throttles may count the network edge.** They are counted per
  address, and behind Cloudflare that is probably an edge, not a device
  (`render.yaml` TRUST_PROXY note, SCRUM-367).
- **Two different kinds of kiosk.** The suite has the app's reception and
  timeclock tablets and the platform's self-service kiosk (S2-20). They are
  separate devices with separate pairing. The app's tablets do not appear
  in Console Devices (Q14).
- **A departed person keeps the launcher and till** until someone
  deactivates their platform account (Q4).
- **Other park groups wait one release for their own settings.** Between 4a
  and 4b they can read Settings but not save a key the default group
  already holds, and Attention stays paused for everyone until 4b.
- **The app's two manual job routes point at the Console** once the
  platform runs the jobs. No screen calls them.

## 11. Questions for the owner (the app's behaviour is the default)

- **Q1. Leave approval.** The live app has no approval status. Every leave
  record counts as approved, and "approve" on sick leave frees that
  person's shifts and raises coverage alerts. The rota sends every day off
  it adds as approved, so in practice adding a sick day frees the shifts;
  the lift stopped that without saying so. Nothing records who approved.
  Should we restore exactly that, or do you want a stored approval (pending,
  approved, rejected, with who and when)? Default: restore the app's
  behaviour. A stored approval would be a new feature (S2-17c).
- **Q2. Shift rows without a group.** The app's screen can try to add a
  row with no shift group, and the database refuses it, so today it errors.
  Should a row always need a group (we show "Choose a shift group first"),
  or should ungrouped rows be allowed? Default: always needs a group, as the
  database already requires.
- **Q3. Which employees reach the platform, and how fast.** Default: every
  employee the app holds who has not left, including "pending", copied every
  15 minutes and on Run now. Casual workers and advisors are not copied (the
  app keeps them apart).
- **Q4. Leavers and the suite.** The app switches off a leaver's OTO App
  login at 03:00 after their last working day. Their suite account (the
  launcher, the till) stays on. Should leaving also switch off the suite
  account? Default: the app's behaviour. The night run lists still-active
  linked accounts on Failures for an administrator to switch off.
- **Q5. The app's password screens.** Create user with a password, enable
  login with a password, change password and forgot password by SMS all
  still work, but set a password nobody uses while sign-in is through the
  launcher. Keep, hide, or point them to the launcher? Default: keep as
  they are.
- **Q6. App users with no suite sign-in.** Default: the Console lists them
  and an administrator links them. The alternative is that the app's Create
  User also creates the suite account, which needs a phone number; the app
  requires only an email.
- **Q7. SCRUM-469: a branch choice when giving someone OTO App access.**
  Today it is always "all branches" on the platform side, which shows every
  provisioned person as staff of both parks. Go or not? Default: not until
  you say go; with a go, it is built in round 1.
- **Q8. Staff vouchers.** An earlier step moved voucher management to the
  Console and redemption to the till, with the app's old vouchers kept as
  read-only history. Confirm? Default: keep. Two live voucher systems would
  disagree about what is left.
- **Q9. Face clock-in in production.** It is off on staging by your
  decision. Default: off everywhere until you decide, and while off a face
  is never matched to anyone. Re-enrolling faces on new infrastructure is
  part of that later decision.
- **Q10. The auto clock-out's label.** The midnight auto clock-out is
  recorded as a FACE clock-out, so it counts as a face use. Keep, or label
  it as a system entry? Default: keep.
- **Q11. The booth roster reads the rota directly.** It does not go through
  a published view. Default: keep, held by a test that fails if the app
  changes a column the platform reads.
- **Q12. Who owns check-in (Open decision 25).** Recorded defaults: event
  and camp check-in stays mastered in the OTO App with the till mirroring it
  (events plan Q1), and park-side drop-off belongs to the platform from
  S2-13 (OD-C1), with the app's own check-in module kept as it is. Confirm?
- **Q13. The old shared directory key.** Does anything outside this suite
  still call the app's directory with `HR_DIRECTORY_API_KEY`? Default: it
  keeps working where it is set, for the default tenant only. Staging leaves
  it unset.
- **Q14. The app's kiosk tablets in Console Devices.** Default: no. The app
  keeps pairing and listing its own tablets.
- **Q15. Finance Sync on a schedule.** The ticket lists finance sync with
  the night jobs, but the app runs it only when an administrator asks, and
  a scheduled run would have to know which park group's Xero it serves.
  Default: manual, as the app does it, and disabled on staging until the
  sandbox is connected.

## 12. Hazards, each with its test

| # | Hazard | Test |
|---|---|---|
| H1 | An upper-case client-minted park id falls out of the seam | Create a branch with an upper-case id: `core_branch_id` is stored lower case, and an app event there appears in `otoapp_v.events` |
| H2 | One person gets two `core.employee` rows | An app employee linked to an account that has a platform employee adopts it (same id, benefit profile kept). A second run writes nothing. An adoption that would collide with an existing copied row is refused and raised, not merged |
| H3 | The view leaks HR data | A test pins the exact column list of `otoapp_v.employees`, with no pay, tax, SSO, visa, address, birth date, face or PIN column |
| H4 | One park group's staff land in another operator | A two-tenant fixture: tenant B's employees never reach operator A. An unanchored tenant is skipped and named in the run |
| H5 | A platform edit to a copied employee is silently undone | `PATCH /me` on an `otoapp` row refuses name, nickname, email and phone. No other platform route writes those fields on such a row |
| H6 | A leaver keeps a benefit | Mark the employee LEFT in the app: the row is archived, live cards are revoked, a scan is refused, and a rehire gets a new card |
| H7 | The copy stops and nobody notices | `ops_expectation` on Health. A forced failure appears on Failures, and a missed run raises the watchdog alert |
| H8 | A night batch runs twice | Two concurrent invocations: one runs and one is `locked`. Two batches for one date: one success. The auto clock-out inserts one OUT per stale IN. Under `platform` the app starts no timers; under `inprocess` the endpoint refuses |
| H9 | A night is lost when the app is down | The first invocation fails, the next tick runs it, and the date is marked done once |
| H10 | The backfill gives rows to the wrong tenant | A two-tenant fixture with branch-linked, employee-linked and branchless rows: each lands in its tenant, none is left null, and the counts per tenant are unchanged |
| H11 | The settings change breaks the running release, or a park group's settings write fails on the old unique | Release N's code passes on both the old and the new constraint shape. The old unique is dropped only in release N+1 (4b). In 4a, another park group writing a key the default group holds is refused in words, never a 500 |
| H12 | Directory reads cross tenants | A's key reading B's employee answers 404. A key without `hr:read` answers 403. With `HR_DIRECTORY_API_KEY` unset, the shared-key path answers 403 |
| H13 | Face "off" clocks in the wrong person | With face off and an ENROLLED employee present, `identify-face` answers "no match, use PIN" without calling a matcher, enrolment is refused, and `/api/kiosk/clock` from a paired tablet naming that employee writes no time event |
| H14 | Sick-leave approval does too much or too little | The rota's own request (the restored client body) creates the sick day as approved. Created as approved: exactly that person's assignments on those Bangkok days are freed, with one coverage alert per shift, each in that person's park group. Approved later: their legacy `shifts` in the range are unassigned. A repeat approve changes nothing more. Nothing is stored |
| H15 | An ungrouped shift row errors | The route answers 400 in words and no row is written |
| H16 | Partial writes: offboarding, finance | A failure injected mid-offboarding leaves nothing. The finance keys make `ON CONFLICT` upsert, and the migration stops loudly on duplicate rows |
| H17 | The rehearsal re-runs the baseline or misses the views | Restore, rename, mark 0000, apply 0001 onwards: the views exist, the counts equal the sample, and a second run is identical |
| H18 | An app migration breaks a seam the platform reads directly | A test compares every column declared in `packages/db/src/schema/otoapp.ts` with the app's migrations and fails when one is dropped or retyped. Views are protected by Postgres itself |
| H19 | The POS reads app tables outside the declared seams, or an app-only change goes untested | The section D grep extended to the HR and rota tables, with an allow-list naming the provisioning, branch and booth seams. A CI run on an app-only commit runs the view tests |
| H20 | Attention floods or duplicates on resume | Two engine runs over the same rows give no duplicate items in a tenant. Fingerprint uniqueness is per tenant |
| H21 | The app's database role can write platform schemas | A grant check that the role behind the app's `DATABASE_URL` has no write on `core`, `crm`, `pos`, `promo`, `booth`, `analytics` or `edge`. It runs on staging as a read-back, because whether staging connects as its own `oto_app` role is set by hand in Render and is not in the repository |
| H22 | Walkthrough fixtures left behind on staging | Every fixture is ZZ TEST, removed by exact id with a read-back recorded on its page. Restricted identities use a temporary password, never SMS |
| H23 | One person is tied to the wrong account, or to another operator's | A two-operator fixture: an app employee whose email matches a user linked to operator B's account, in a tenant anchored to operator A, is copied with no account link and raised. A created copy sets its linked account's `employee_id` in the same transaction. An account already pointing at another employee row keeps it, and the case is raised |
| H24 | The booth roster and the copy name two accounts for one person, or the view's link drifts from the app's rule | An app employee linked only by the email fallback (no `user_id`): the booth roster and `otoapp_v.employees` resolve the same platform account, and an employee linked to nobody is unmatched in both. Over a fixture with a `user_id` link, a single email match, two employees sharing an email (the phone and name tie-breaks) and an unresolved tie: for every user, the employee the app's `getUserWithBranchAccess` picks is exactly the one whose view row names that user's platform account |
| H25 | A rehire gets a second row and loses their history | Mark the employee LEFT, run the copy, make them active again, run it again: one `core.employee` row, the same id, un-archived; their old cards stay revoked |
| H26 | A dev or maintenance route runs on a deployment or across park groups | With `DEPLOY_ENV=staging`: `seed`, `prod-sync`, the dev import, `test-sentry` and `test-object-storage` are refused and write nothing. A park group's admin calling the four maintenance routes changes only its own park group's rows |
| H27 | The old voucher ledger takes a write | Every write route in `server/voucher-routes.ts` answers with the Console notice and writes no row; the reads still answer |
| H28 | A linked app user is deleted under the platform | `DELETE /api/users/:id` on a user with `platform_user_id` answers 409 in words, and the user and its `core.app_identity` row are unchanged |
