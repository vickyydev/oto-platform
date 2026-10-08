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

**As built in round 5, and one correction to the paragraph above.** Both
503s are gone and the rota sends `approved: true` again, exactly as the app
did; nothing new is stored. But reading the restored route end to end shows
the "frees the shifts" step almost never runs, in the live app or here: the
route refuses a day the person already has a rota shift on ("Cannot add
time-off: employee has a shift on ... Please remove the shift first", 409)
BEFORE it saves the day off, and the freeing step looks for exactly those
shifts. So the park removes the shift first and no coverage alert is raised;
the step finds something only when a shift is assigned in the instant
between the check and the save (proved with a trigger standing in for that
instant). Today, too, a sick day over a shift is refused, not saved. The
legacy step (the older `shifts` list) does run, over the app's own range,
but no screen writes that list. Q38 and Q44 put both to the owner; the
app's order is kept.

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
  rota is sent as approved again, and the app's own steps run: the person's
  older-list shifts are unassigned, and any rota shift assigned in the same
  instant is freed with a "Shift needs coverage" alert in their park group.
  A sick day over a shift the rota already shows is refused until the shift
  is removed, as the app does (Q1, Q44). A shift row added without a group
  is refused in words ("Choose a shift group first") instead of failing with
  an error, and so is editing, dragging or deleting one into no group (Q2).
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
  - **As built in round 5** (`server/lib/faceOff.ts`; H13 in
    `tests/attendance.check.ts`). "Off" is the app's own switch read as the
    face service reads it: anything but `USE_AWS_REKOGNITION=true`.
    - `identify-face` keeps its kiosk credential and throttles, then answers
      the app's own "No matching face found. Please use PIN entry." without
      calling liveness, the enrolled list or the matcher. The tablet's third
      miss takes it to the phone screen, as the app's fallback does.
    - `/api/kiosk/clock` is refused in words before it reads anything, and so
      are the three doors only its answer leads to
      (`/api/kiosk/missed-clock/auto-fix`, `/missed-clock/manual`,
      `/unscheduled-clock-in`, each of which writes FACE time events for a
      named person) and the advisor's `/api/kiosk/advisor-clock` (Q43).
    - Enrolment is refused in words at its four doors: the two QR sessions a
      manager makes, the tablet's token check and the capture. Resetting a
      face (which removes one) is unchanged.
    - The face service itself (`server/face-recognition.ts`) is unchanged, so
      turning face on (Q9) gives the app's face road back as it was. PIN and
      phone are unchanged; the midnight auto clock-out keeps FACE (Q10).
- **The night jobs can run twice, lose a night, or fail silently.** They are
  in-process timers with no lock. Each catches its own error, logs it and
  carries on (`server/scheduled-jobs.ts`, every `catch`). If the process is
  down at 00:01, nothing catches up. This is why `render.yaml` pins one
  instance. Fix: the platform's job runner owns the schedule. The advisory
  lock and `ops_last` make each batch run once per Bangkok date. A caught
  error becomes a failed step, a failed step becomes a failed run on
  Failures, and Retry re-runs it. The app's own timers, where they still
  run (`inprocess`), take the same per-park-group lock as the platform's
  calls, so two instances that disagree about the switch cannot run one
  night side by side (round 3 review, F4).
- **A second batch of one date makes a recurring task twice (round 3
  review, F2).** The midnight task generation looked for the day's instance
  by its due time, between `startOfDay` and `endOfDay` of a date shifted +7
  hours in a UTC process: 07:00 to 06:59 Bangkok. An instance due before
  07:00 Bangkok (stored as the previous UTC day) was never found, so a second
  batch of the same date made it again. In-process the batch ran once a
  night and it never showed; the platform's runner runs a date's batch again
  after a failure, after a call that timed out, and on the day of the switch.
  Fix: the instance is looked up by the date it was made for
  (`generated_for_date`, which both of the app's inserts fill), as the app's
  template generator already looks its own up
  (`server/core/compat/studioTasksCompat.ts`).
- **Shared tables answer across park groups.** `settings` (whose key is
  globally unique), `templates`, `policy_documents`, `asset_catalog`,
  `activity_log` and `attention_items` have no tenant column. The lift made
  their routes fail closed (`server/routes.ts:7012-7092`). Fix: additive
  tenant columns with a backfill, then each caller reads and writes its own
  tenant's rows, and the 503 guards come off.
  - **As built in round 4a, the expand half** (migration 0006, section 7).
    - Settings had no 503: every park group read and wrote the one global
      set. Now one helper (`storage.getSettings`, `getSetting`,
      `upsertSetting`; the rules in `server/lib/parkGroupSettings.ts`) takes
      the park group, and so does every caller: the settings screen, the
      employer counter-signature on a signed contract (the employee's park
      group), the default probation (the employee's), the annual-leave and
      business-day entitlements, the Fix department, the kiosk code lifetime,
      the AI prompts, the Attention rule settings (read for the default park
      group until 4b runs the rules per park group), the dev seed and the
      production copy (both development only).
    - Reading: a park group's own row for a key, else the default park
      group's (Q28), else a row with no park group (the previous release's,
      written during the hand-over). Another park group's row is never read.
    - Saving: the default park group only, its callers placed by the app's
      strict rule (`userManagementTenant`). Another park group is answered
      409 in words (`settings_shared`) whatever the key (Q29); a caller the
      app cannot place, 403 (`settings_no_park_group`); a key another park
      group's row already holds, 409 (`settings_key_held`) — never a 500 off
      the old unique. The insert names no conflict target, so the same code
      runs on both constraint shapes (H11, proven by dropping and restoring
      the old unique in `tests/tenant-ownership.check.ts`).
    - Data Admin's Setting model (`server/data-admin/models/setting.ts`) is
      held to the same rule: a create or update naming another park group,
      or an update of another park group's row, is answered the same 409
      (`settings_shared`), and a create naming none is the default park
      group's. Every other Data Admin model is as it was (round 7).
    - The Fix department is a department id, so the fallback never crosses:
      another park group reading the default park group's Fix department
      gets none, its reports are never assigned to the default park group's
      department nor its staff counted members of it, and a save checks the
      department is the caller's own (fixed: a report of one park group
      assigned to another's department is a data fault).
    - The Activity Logbook: both reads filter by the caller's park group, so
      a row about no branch shows in its own park group's logbook. Of those,
      the app's own branch rule (its read before the lift): a reader with
      every branch (`hasAllBranchesAccess`) sees the branchless rows; a
      branch-limited reader sees the rows of their branches only. A
      hand-over row with no park group is shown by its branch, as before.
    - Templates, policies and the asset catalogue keep their 503 until round
      6; Attention stays paused until 4b.
  - **As built in round 4b, the contract half** (migration 0007, section 7).
    - Every park group saves its own settings rows. The old one-row-per-key
      unique is gone, so another park group's save of a key the default park
      group holds is its OWN row beside the default's, which stays as it was;
      the other park groups with no row of their own go on reading the
      default's (Q28 stands). 4a's `settings_shared` refusal is gone with the
      constraint that made it necessary (Q29 lifted). The strict placement
      (`userManagementTenant`) still decides which park group a caller saves
      as; a caller it cannot place is refused (403, `settings_no_park_group`).
    - A save of several keys is one transaction (`storage.upsertSettings`, the
      round 4a review's note): a key that is refused or fails saves none of the
      others. The app saved each key as it went, so a failure part way left
      the form half saved (a data fault, fixed). Keys are written in key order,
      so two saves of overlapping keys at once never deadlock.
    - `settings_key_held` stays for one case only: the code meeting a database
      0007 has not reached (the old unique back), where it is still words and
      never a 500 (H11, proven with the unique put back for the length of the
      check).
    - Data Admin's Setting model loses its 4a hold to the default park group
      with the unique that made it necessary, and is as every other Data Admin
      model is until round 7 (Q36): a create naming no park group is the
      default park group's, and a row cannot be moved to no park group.
    - The Activity Logbook is as 4a built it. `tenant_id` is NOT NULL, so no
      hand-over row is left to show by its branch.
    - Attention resumes (`ATTENTION_WRITES_READY` true), per park group.
      - Every writer passes the park group whose data raised the item: the
        nine `createAttentionItem` callers the 4a review counted (seven routes,
        two night-batch steps), and every engine upsert (the employee's park
        group, the branch's for the scheduling rules, the assignment's for the
        no-show check). The rules themselves are the app's, unchanged; the
        engine stamps the park group on what they find.
      - An item is found, updated, re-opened and auto-resolved within its own
        park group only, and written under a transaction-level advisory lock
        on (park group, rule, entity) (namespace `0x0713`), so the engine and a
        route's trigger writing the same item at once make one row (H20).
      - The engine's full reconciliation runs per park group: that park
        group's employees, and only its open items looked at for auto-resolve.
        The scheduling rules read that park group's `attention_rules_config`
        (the default park group's where it has none, Q28).
      - Reads: a reader's own park group's items; a reader with every branch
        sees every item, the ones about no branch included, any other reader
        the items of their branches only — the Activity Logbook's rule (Q34).
        The lift's manager gate on the reads stays.
      - Refresh, Snooze (24 hours) and Resolve are back, each on the caller's
        park group only; another park group's item is the same 404 as one that
        does not exist. Refresh runs the caller's park group's engine under the
        lock its six-hourly run takes (`otoapp_night:attention:<park group>`),
        and is refused in words while that run is going (Q35).
      - The rules screen (`/api/attention-rules/config`) reads the caller's
        park group's rules (the default park group's where it has none) and
        saves its own row, through the same strict placement as every settings
        save.
      - Data Admin's Attention model stays closed (503) until round 7's
        walkthrough of Data Admin.
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
  - **As built in round 5** (`server/lib/shiftGroupRequired.ts`; H15). The
    same database error waited at three more doors, so the words are at
    every door that would leave a row with no group, each before it writes:
    create, edit (the form's "Ungrouped" choice), drag (`move-group`), and
    deleting a group that still has rows without saying where they go
    (the screen's confirm promises "will be ungrouped" and offers no target,
    Q45). "Choose a shift group first" for the first three; the delete adds
    "this group still has shifts, so pick the group to move them to".
    Nothing else about grouping changed. A casual worker's first shift on a
    branch with no group meets the same words, and once a group exists is
    scheduled at their daily rate as before (the casual-worker walkthrough's
    500 of 1 October).
- **A reception kiosk code could be minted for another park group's
  branch** (found in round 5). `POST /api/branches/:branchId/kiosk-code`
  took any branch id and minted the code for the caller's park group, so the
  device it made sat in a branch of another park group — the row
  `resolveKioskDevice` already refuses as corrupted — and that tablet read
  the other branch's name and today's guest check-ins
  (`/api/kiosk-reception/branch`, `/checkins`). The check-in board's own
  routes were already fenced. Fix: another park group's branch is the app's
  404 "Branch not found", and the two reception reads are held to the
  tablet's park group, so a device minted before the fix sees nothing there.
  Which branches a branch-limited manager may activate a tablet on is Q41.
- **Three more park-group crossings** (found in round 5's review). Each is
  fixed on our own authority, with no migration:
  - `GET /api/shifts-needing-coverage` with no branch named answered every
    park group's flagged older-list shifts, the ones round 5's restored
    sick-day step flags. It now answers the caller's park group only. Which
    of its branches a branch-limited manager reads is Q39.
  - The sick-leave policy (`sick_leave_policies`, which has its own
    `tenant_id`) fell back to the first company-wide row of any park group,
    so an admin's company-wide save rewrote another park group's row and
    every park group read it. The read, the save and each balance now keep
    to the park group (the caller's, or the employee's for a balance), and a
    save naming another park group's branch is the app's 404 "Branch not
    found". `GET /api/employees/:id/leave-balance` read another park
    group's employee; it is now the app's 404 "Employee not found" (Q40).
  - Revoking a reception tablet (`DELETE /api/kiosk-devices/:id/revoke`)
    deleted the device's sessions before it checked the park group, so
    another park group's manager signed the tablet out and was answered
    200. The device is now updated first, held to the park group; its
    sessions are deleted only when that matched, and otherwise the answer is
    the app's 404 "Device not found". Which branches' tablets a
    branch-limited manager may revoke is Q46.
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
    `platform` they answer in words pointing at the platform's 03:00 run on
    the Console's Health page and Retry on its Failures page, so a call
    never races the scheduled run. (Not at Run now: that is a staging test
    control, which production refuses — round 3 review, F5, and Q22.) Under
    `inprocess` they run as today, for the caller's park group only.
  - Finance Sync is not here: the app has no timer for it, only manual
    routes (section 6, Q15).
  - **As built in round 3.**
    - The platform holds one `jobs:run` key per park group in
      `OTOAPP_JOBS_KEYS` (`<app tenant uuid>:<key>`, comma-separated, a
      secret) beside `OTOAPP_DIRECTORY_URL`; empty, the three jobs run as
      no-ops that say so. Each call names its park group in the body, and
      the app answers 404 when that is not the key's.
    - "Done for the date" is read from the job's own runs: each run's
      detail names the Bangkok date and, per park group, whether its batch
      finished. The three jobs are `exclusive` in the runner (a session
      advisory lock held from before the run until after its record), so a
      Run now beside the schedule, or a second instance, answers `locked`
      instead of running a night twice. The app holds its own lock per park
      group and batch too, and answers 409 `job_running`.
    - Each step answers its counts and, for an error the app caught, the
      error in scrubbed words, with the app's own continue-or-stop shape:
      every step carries on after its own error except the availability
      clean-up, whose error the app lets escape the 03:00 batch.
    - The 03:00 run then files, per park group, each leaver whose platform
      account is still active (`otoapp:account.departed`,
      `OTOAPP_DEPARTED_ACCOUNT_ACTIVE`) on Failures (Q4, Q23).
    - The Console's Health test controls gain Run now for each of the three
      and "Fail the OTO App's presence check once", the forced failure whose
      Retry runs the check for real (ticket QA step 3). Test controls exist
      only where `OPS_TEST_CONTROLS` is on (staging); production has no Run
      now (Q22).
    - No migration: `scopes` is free text, and the run records exist.
  - **The round 3 review's fix round.**
    - A park group the app holds staff in, with no key here, fails every
      run (review F1). The switch is the app's, not a park group's: under
      `platform` the app runs no timer for any park group. So every due run,
      after its keyed park groups, reads the park groups the app holds staff
      in through the employee repository (`otoapp_v.employees`, distinct
      `tenant_id`) and fails naming each one this deployment holds no key
      for (`OTOAPP_NIGHT_JOB_UNKEYED`), at every tick until the key is
      added. The keyed park groups still run and are recorded done. A
      deployment holding no key at all is still the no-op: it has taken
      nothing over, and the app's own timers run the night. One whose
      database has no employee view runs its keyed park groups and says
      that nothing could be checked.
    - "Already running" twice fails the run (review F3). The first 409
      `job_running` of a date stays `locked` and green (a call that timed
      out, still finishing). Answered so again at a later tick of the same
      date — for the six-hourly check, at the run after — the batch the app
      holds has not finished since, and the run fails with
      `OTOAPP_JOB_RUNNING`, so Failures and the `ops.failing` alert see it.
    - The app's own timers take the endpoint's lock (review F4): under
      `inprocess` each batch runs one park group at a time holding
      `otoapp_night:<batch>:<park group>` (namespace `0x0712`,
      `server/lib/nightBatchLock.ts`, the endpoint's own), and skips, in the
      log, a park group held elsewhere. Every table the batches touch has a
      NOT NULL `tenant_id` referencing `tenants`, so the park groups one by
      one reach every row the batch reached at once. Where the park groups
      or a lock cannot be read, the batch runs as it always did.
    - Task generation finds a date's instance by the date it was made for
      (review F2, section 4).
  - **As built in round 4b: Attention's two timers on the same terms.**
    - The app's endpoint takes two more batch names: `attention` (one step,
      `attentionReconciliation`: the engine's full reconciliation, which the
      app ran from `server/index.ts` five seconds after start-up and every
      six hours) and `no_show` (one step, `noShowCheck`, the app's check every
      ten minutes, which skips itself outside 07:00-22:00 Bangkok and says
      so: `outsideHours: 1`). Each for the key's park group only, under the
      same per-park-group lock (`0x0712`). Every error the engine catches —
      a rule that throws for one employee — is a failed step, as round 3 made
      every swallowed error one; the step carries on, as the app's run does.
    - The engine's step counts its new items rule by rule
      (`created.<RULE>`), and the platform's run adds them up park group by
      park group into `alerts` (`created`, `updated`, `resolved`, `byRule`).
      The first run after Attention resumes applies every rule to the rows
      that built up while it was paused (section 10): that burst is in the
      run's detail and in what Run now says, never capped or smoothed.
    - The platform registers `job:otoapp.attention` (every six hours) and
      `job:otoapp.no_show` (every ten minutes, outside 07:00-22:00 Bangkok a
      tick runs nothing and records why, so the expectation stays fed all
      night), both `exclusive`, each with its expectation, on Health, with
      Run now and a deliberate failure each among the test controls
      (`otoapp.attention`, `.attention.fail`, `.no_show`, `.no_show.fail`).
      The unkeyed census (review F1) and "already running" twice (F3) apply
      as to the presence check. The same `jobs:run` key per park group runs
      all five; no new variable.
    - Under `OTOAPP_JOBS=inprocess` the app's own timers run both again, as
      the app did — the engine five seconds after start-up and every six
      hours, the no-show check at once and every ten minutes — one park
      group at a time under the endpoint's lock (seven timers in all). Under
      `platform`, none.
    - **Deploy order for 4b:** the app first (its pre-deploy runs 0007; its
      endpoint learns the two names), then the api. An api that runs first
      asks an app that does not know `attention` or `no_show` yet: those runs
      fail in the app's own words (`OTOAPP_JOB_NOT_FOUND`), and the
      six-hourly Attention run then waits six hours unless Retry is pressed on
      Failures once the app is up.
- **Tenant-bound Directory HR reads**, as in section 4. The shared key keeps
  working only where it is set, and only for the default tenant (Q13).
  - **As built in round 4a.** The six reads take one caller check
    (`server/directory/hrReadAuth.ts`): `Authorization: Bearer <key>` with a
    `directory_clients` key carrying the new scope `hr:read`, checked by the
    same `requireDirectoryClient` that `events:write` and `jobs:run` use (no
    key 401, a key it did not issue or one without the scope 403, the key's
    own rate limit). Each read answers for the key's park group only: another
    park group's employee or branch is the same 404 as one that does not
    exist; search, the branch roster, roles, departments and branches list
    that park group's rows; an employee's branch, department, roles and
    presence branch are read inside it.
  - The old `X-HR-API-KEY` path: where `HR_DIRECTORY_API_KEY` is unset (as on
    staging) it is refused with a 403 in words, where the old check answered
    500; where it is set, it reads the default park group only, under its old
    per-key rate limit. Compared in constant time.
  - `hr:read` joins `DIRECTORY_CLIENT_SCOPES` and the key script
    (`npm run directory:client -- create ... --scope hr:read`). No migration:
    `scopes` is free text. The platform calls none of these reads today.
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
  - **As built in round 4a: `0006_tenant_ownership_expand`** (the next free
    number after round 2's view).
    - `tenant_id uuid`, nullable, a foreign key to `tenants`, on the three
      tables; `idx_activity_log_tenant` and `idx_attention_items_tenant`;
      `settings_tenant_id_key_unique` on (`tenant_id`, `key`), which is also
      the tenant index on `settings` (it leads with it). The baseline's
      `settings_key_unique` stays.
    - The backfill, in order. `activity_log`: its branch; its employee; its
      contract's employee; the user who did it, where the app's strict
      placement (`managedUserTenant`, `server/routes.ts`) places that user:
      every access row names one park group, every branch those rows name
      is that park group's, and an operator admin's operator is that park
      group's too (a user it cannot place places nobody); then the default
      park group. `attention_items`:
      its branch; its employee; its contract's employee; then the default
      (an item is raised by the engine, so who resolved it says nothing).
      `settings`: the default park group, whose one set it was. The two
      added steps keep a branchless row a second park group's user wrote out
      of the default park group's logbook (H10; Q30).
    - The default park group follows the app's own rule for its default
      tenant (`getDefaultTenantId`, `server/routes.ts:159`): the tenant with
      slug `default`; else, where the database holds exactly one park group,
      that one, so a one-park-group database stays one park group and its
      rows are its own. Only where neither answers (no tenant, or several
      and none slugged `default`) and a row is left for it does the
      migration make one ('OTO Default'), as the app's own
      `script/backfillTenant.ts` does; an empty database gets none. The
      runtime helper (`getDefaultParkGroupId`), `createActivityLog`'s last
      step and the read-back's label take the same rule, and never make a
      tenant.
    - The write path follows the same order: `createActivityLog` writes
      every row's park group, the caller's session park group standing
      before the user step (the routes pass it on every row about no branch,
      employee or contract). Attention writes stay paused and its reads keep
      their branch-consistency scope until 4b. The no-show check already
      passes `tenantId` to `upsertAttentionItem`
      (`server/scheduled-jobs.ts:481`), for a column that did not exist until
      0006, so when 4b resumes it the item carries its park group.
    - The read-back, `npm run tenant:readback` in the app
      (`script/tenant-ownership-readback.mjs`, read only): rows per park
      group and rows with none for the three tables, which settings uniques
      stand, keys held twice, activity rows that disagree with their
      branch, and the census counts below. CI's OTO App job runs it last,
      over every row the migrations, the routes and the night jobs wrote.
    - Tests: `apps/api/test/s217b-r4a.test.ts` (H10 on a seeded 0005 state,
      the default park group made only where needed, the migration as
      committed and from empty twice, the 4a fences) and
      `apps/oto-app/tests/tenant-ownership.check.ts` (H11 on both constraint
      shapes, the reads, the Activity Logbook, H12), wired into CI's OTO App
      job.
    - **Owed by 4b.** Rows the previous release writes during the hand-over
      have no park group (they read as the default's, or by their branch).
      4b's migration runs 0006's backfill again over the nulls, sets NOT
      NULL once the read-back shows none, and drops `settings_key_unique`.
      Paid by round 4b's 0007 (below).
- Round 4 (contract, one release later, its own landing "4b"): drop the
  global unique on `settings.key`, and set the new tenant columns NOT NULL
  once a read-back shows no nulls. Until 4b lands, `settings_key_unique`
  (`migrations/0000_otoapp_baseline.sql:1177`) stops a second park group
  writing any key the default group already holds (the `md_signatory_*`
  rows, the Attention rule settings). So in 4a the settings writes of other
  park groups stay refused in words, and round 4's acceptance is claimed
  after 4b.
  - **As built in round 4b: `0007_tenant_ownership_contract`** (the next free
    number; generated from the schema, then the lock, the backfill and the
    gate written in front of the generated statements).
    - It locks `settings`, `activity_log` and `attention_items` against
      writes (SHARE ROW EXCLUSIVE: reads go on) for its length, so no row can
      arrive between the backfill and NOT NULL. A write in flight when it
      starts is waited for, then placed.
    - It runs 0006's backfill again, statement for statement (a test holds
      them equal), over whatever the previous release wrote with no park
      group. A row already placed is never moved; the default park group is
      made only where 0006 would have made it.
    - The gate: if any row of the three still has no park group, it stops
      with the counts in words (`tenant ownership (0007): …`) and changes
      nothing — the transaction rolls back, so the columns stay nullable, the
      old unique stands and 0007 is not recorded. Nothing in the backfill can
      leave one; the gate stands for what nobody foresaw.
    - Then `tenant_id` NOT NULL on the three, and `settings_key_unique`
      dropped last (while the backfill ran, it still guaranteed a hand-over
      row placed in the default park group could not meet a second row for
      its key there).
    - A write queued behind the lock lands after it: taken when it names its
      park group (every write of 4a's release does), refused by NOT NULL when
      it names none (no release since 4a writes one).
    - The read-back now also says whether `tenant_id` is NOT NULL, and the
      app's image carries it (`script/tenant-ownership-readback.mjs`), so a
      deployment can be read back from its own shell (4a's staging note).
    - Tests: `apps/api/test/s217b-r4b.test.ts` section A (the gap's rows
      placed by their own links on a 0006 database, NOT NULL and the unique
      after, the gate, the window with real concurrency, from empty twice).
- Round 6: the same pattern for `templates`, `policy_documents` and
  `asset_catalog` (expand in round 6, NOT NULL in round 7's release), and,
  by Q31's default, `leave_policies` (the census's branch-then-default
  backfill). Also
  a unique open offboarding per employee, only if the census is clean.
- Round 7: the four finance composite primary keys and a unique index on
  `pl_facts`.
- A census in round 4 gives a disposition for the other root tables with no
  tenant column: `leave_policies`, `coverage_rules`, `invitation_designs`,
  `i18n_translations`, `package_line_item_templates` and `people`. Each is
  either reached through a tenant-bearing parent or listed with its
  exposure. Children of tenant-bearing parents need nothing.
  - **The census as written in round 4a** (read from the schema and every
    route that reads or writes each table; live counts per park group come
    from `npm run tenant:readback`, run on staging when 4a deploys):

| Table | Its park group, through | Who reads and writes it | Disposition |
|---|---|---|---|
| `coverage_rules` | `branch_id` (NOT NULL) → `branches.tenant_id` | No route calls its three storage functions (`getCoverageRules`, `createCoverageRule`, `deleteCoverageRule`); Data Admin only | Reached through a tenant-bearing parent. Nothing to do. |
| `invitation_designs` | `event_id` (NOT NULL, cascade) → `core_events.tenant_id` | The signed-in routes check the event's park group and branch first (`verifyEventAccess`, `server/parent-experience-routes.ts:67-74`); the public ones reach it through a parent-portal token's own event | Reached through a tenant-bearing parent. Nothing to do. |
| `package_line_item_templates` | `package_template_id` (NOT NULL, cascade) → `birthday_package_templates.tenant_id` | Every route checks the package's park group first (`hasPackageAccess`, `server/birthday-package-routes.ts:17-24`) and confines item writes to that package | Reached through a tenant-bearing parent. Nothing to do. |
| `i18n_translations` | `version_id` (NOT NULL) → `dropoff_form_versions.form_id` → `dropoff_forms.tenant_id` | Four manager routes take a form or version id and never check its park group: `GET /api/dropoff-form/:formId/versions`, `GET /api/dropoff-form/version/:versionId`, `PUT /api/dropoff-form/:formId/draft`, `PUT /api/dropoff-form/translation` (`server/dropoff-form-routes.ts:368-466`); and a fifth, for admins, does the same and more: `POST /api/dropoff-form/:formId/publish` reads the draft's English translations of any park group's form, writes the machine translations into it, and publishes that form (`server/dropoff-form-routes.ts:469-580`) | Reached through a tenant-bearing parent, but EXPOSED: a manager of any park group holding another park group's form or version id reads and writes its drafts and translations, and an admin publishes it. No column needed; the fix is the parent check (the form's `tenant_id` against the caller's park group) on those five routes (Q31). |
| `leave_policies` | `branch_id` → `branches.tenant_id`; a row with no branch is company-wide and has no park group at all | `GET /api/leave-policies` with no branch lists every park group's policies to an admin or all-branch user, and with `branchId` takes another park group's branch; `POST` takes any `branchId`; `PATCH` and `DELETE /api/leave-policies/:id` take any park group's policy (`server/routes.ts`, "LEAVE POLICIES"). `getActiveLeavePolicy` falls back to the branchless rows, so a company-wide policy one park group writes sets every park group's days-off accrual | EXPOSED, reads and writes across park groups, and its branchless rows have no parent to place them. Needs its own `tenant_id` on the round 6 pattern (expand with a branch-then-default backfill, NOT NULL a release later) and the routes held to the caller's park group, in round 6 (Q31; round 5 added no migration). Beside it, `sick_leave_policies` carries its own `tenant_id`, but its company-wide fallback ignored it, so one park group's admin saving the company-wide sick-leave entitlement rewrote another's row and every park group read it; and `GET /api/employees/:id/leave-balance` read any park group's employee. Both fenced in round 5's review (section 4, Q40). |
| `people` | No tenant column and no tenant-bearing parent; placed through its children: `access_policies.person_id` (unique per person, carries `tenant_id`) and `employees.person_id` | `GET /api/people` lists every park group's people to any manager; `GET` and `PATCH /api/people/:id` and `GET /api/people/:id/access` take any park group's person for any park group's admin (`server/routes.ts`, "PEOPLE & ACCESS POLICIES"). Round 2 fenced the delete door. `email` is unique across every park group, so one person has one row | EXPOSED: identity rows read and edited across park groups. No column needed while each person has one place: scope the people routes by the park group of the person's access policy or employee rows; the read-back counts the people placed in one park group, in none and in several, which is the census that change needs first (Q31). |

  - Across all six, and the three 4a tables too: Data Admin
    (`/api/data-admin`, `requireGlobalAdmin`, which is the `admin` or
    `global_admin` role of any park group, `server/routes.ts:811`) reaches
    every registered model across park groups. Its walkthrough is round 7's.
    One exception in 4a: its settings writes are held to the default park
    group while the old unique stands (section 4).
  - Found beside the census: `POST /api/employees/recalculate-probation`
    recomputes every park group's employees for any park group's admin. In
    4a each employee takes its own park group's default probation, but the
    route still reaches across (Q31).
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
| 2 | **The employee mirror.** `otoapp_v.employees` with the column allow-list. The platform's read-only repository (the only file besides `otoapp-events.ts` that names `otoapp_v`). `job:otoapp.employee_sync` with its expectation: tenant-to-operator anchor, adoption, create, update, archive on LEFT or gone, un-archive on rehire, card revocation on archive. The account link: an account outside the anchored operator is no link, a created copy sets the account's `employee_id`, a clash is raised. The booth roster takes the person's account from the employee repository. Mirrored fields refused on `PATCH /me`. The benefits panel shows the source, and an unknown employee raises `otoapp:employee.sync`. The section D grep extended to the HR tables, apart from the declared seams. The benefits flips listed in section 5 ("The swap"). Can build in parallel with round 1; lands after it. Carries round 1's three standing pins: Link refuses a user the unlinked list would not show this operator; a case-collision row still fences the first-time name match while mapping as nobody's; and the employee and people delete doors answer 404 across park groups the way the users door does. | Benefits check 1 on mirrored rows: the two `it.todo`s of `s221-r4-closing-audit.test.ts` are tests, registered under check 1 and H17. H23 to H25 green. On staging: the four demo people created as employees in the OTO App, their accounts provisioned with the same emails, the four `core.employee` rows adopted, and Nok's override still in place. H2 to H7 green. A second run changes nothing. The job is on Health. A staging read-back shows the api role reads the view. SCRUM-218's comment updated. Walkthrough page: HR employees (create and edit, refused branch read). **Deploy order:** the booth roster reads `otoapp_v.employees`, so on staging the app deploys first (its migrator publishes the view), then USAGE on `otoapp_v` and SELECT on `otoapp_v.employees` are granted to the api role and `packages/db/scripts/otoapp-employee-seam-readback.ts` answers 0 — before or with the api deploy, or every booth sync answers 503 EMPLOYEES_SEAM_NOT_GRANTED. **Acceptance order:** provision the four demo people's app users to their accounts before creating them as app employees (or within one copy window), or their platform rows are never adopted and Nok's override stays behind (Q20). |
| 3 | **The night work on the platform runner.** The app's job endpoint, scope `jobs:run` and tenant-scoped job functions. Every swallowed error reported as a failed step. `OTOAPP_JOBS`. The platform registers `job:otoapp.midnight`, `.reconcile` and `.presence`, with expectations and the forced-failure test control. The departed-login step names still-active linked platform accounts (Q4). The two manual triggers follow `OTOAPP_JOBS` (section 5). Flip to `platform` on staging only after one platform-run success (the endpoint refuses before the flip, so see Q22 for the order as built); Attention stays paused. | Ticket check 3: two jobs on Health with last-success times, and a forced failure on Failures whose Retry succeeds. H8 and H9 green. Under `platform`, the app registers no timers (test). On staging, a midnight batch run by the platform produced the auto clock-out and the day's recurring tasks. Walkthrough pages: timekeeping, tasks (recurrence). |
| 4 | **Tenant ownership, Attention and the Directory, in two landings.** 4a: the expand migrations. The settings helper and every caller take the tenant. Settings reads open to every park group; other park groups' settings writes stay refused in words while `settings_key_unique` stands (section 7). Branchless Activity rows show in their own tenant. Directory HR reads under `hr:read`. The root-table census. 4b, the next release (a short build-review cycle of its own): the contraction, then other park groups' settings writes open, and Attention resumes (`ATTENTION_WRITES_READY`) with rules per tenant (its rules are the settings key `attention_rules_config`), run as `job:otoapp.attention` and `job:otoapp.no_show`. | Claimed after 4b. H10 to H12 and H20 green. A second tenant's settings, activity and Attention are invisible to the first, on staging and in tests. Refresh, snooze and resolve work on staging. A directory read across tenants answers 404. Walkthrough pages: settings, activity log, Attention engine, Directory API. |
| 5 | **Attendance and operations as the app does them.** Leave approval restored (Q1): the server's two 503s removed and the rota's `approved: true` put back, with each coverage alert written to its park group (round 4's column). The shift-row refusal (Q2). Face "off" refuses instead of matching, `/api/kiosk/clock` included. A configured-device reception action. Restricted-branch proof for scheduling, leave, checklists, announcements and notifications. Casual workers' ungrouped-row case. | H13 to H15 green. Walkthrough pages: kiosk devices and reception, face/PIN/phone, timekeeping (restricted branch), scheduling, leave and holidays, tasks and ops board, checklists and media, announcements, in-app notifications, casual workers. |
| 6 | **The document modules.** Tenant columns for templates, policies and the asset catalogue (expand; NOT NULL in round 7's release); their 503 guards off. By Q31's default, `leave_policies`' tenant column too, its routes and the leave reads' remaining park-group crossings held to the caller's park group (Q40). Contracts, letters, templates, policies, employee documents, assets, offboarding (one transaction, the readable reason label, linked-user deactivation as the app does it) and the org chart (count first, because its GET writes missing nodes). The PDF and storage gate. The offboarding duplicate census. | Ticket check 2: a contract and a letter signed, and a BEO generated, opening from signed URLs, with an unauthorised read refused (test and screenshots). H16 green for offboarding. Walkthrough pages: contracts, templates, policies, letters, employee documents, assets, offboarding, org chart. |
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
  - As built (round 4a): they save no setting at all, whatever the key
    (Q29), and read the default park group's values for every key, its
    employer signatory and signature image included (Q28). Their Fix
    department reads as none until they can save their own.
  - Round 4b ends the wait: each park group saves its own rows, its Fix
    department and its Attention rules included.
- **Attention's first run raises a burst, and shows it.** The first
  `job:otoapp.attention` run (or Refresh) after 4b applies every rule to
  every employee at once: on staging, alerts for the rows that built up
  while Attention was paused, and the 43 saved alerts it no longer raises
  resolved. The run's detail and the Run now answer give the counts park
  group by park group and rule by rule (`alerts.byRule`); nothing is capped.
- **The six-hourly run resolves alerts it does not raise** (the app's rule,
  Q32). The full reconciliation resolves every open item with a rule key its
  employee rules did not raise this time. That includes the no-show alerts
  (raised by the ten-minute check) and the open-shift and coverage alerts
  (raised only by Refresh, Q33): a no-show alert closes at the six-hourly
  run and re-opens at the next ten-minute check while the person is still
  absent (pinned in `tests/attention.check.ts`).
- **The stuck clock-in alert is raised again at every presence check** (the
  app's `createAttentionItem`, not an upsert), now that Attention writes run.
- **The api's boot pass waits for a due Attention run.** The runner's first
  pass at boot runs every due job before the api listens, as it already does
  for the presence check; the Attention engine is the heavier call (every
  rule over every employee, synchronously in the app, up to
  `OTOAPP_JOBS_TIMEOUT_MS`). On staging's few employees it is seconds; the
  production restore (S2-22) should time one run before relying on it.
- **A Refresh beside the engine's run is refused in words** (Q35): "Attention
  is already being checked for this park group. Try Refresh again in a
  minute."
- **"Last updated" on the Attention page is per park group and per app
  instance**, as the app kept it (in memory): after a restart it reads empty
  until the next run.
- **A database with several park groups and none slugged `default` has no
  default park group** (Q37; staging and production carry the slug). Its park
  groups each save their own settings, but one with no row for a key falls
  back to the app's built-in value rather than another park group's; an
  Activity row about nothing whose actor the strict placement cannot place
  has no park group to take and is refused (NOT NULL); a Data Admin settings
  create naming no park group is refused in words.
- **The dev production copy cannot load tenantless rows.** `prod-sync`
  (refused on every deployment) copies a production database's rows as they
  are; until production carries 0006 and 0007 (S2-22) its settings, activity
  and Attention rows have no park group, and a dev database at 0007 refuses
  them.
- **A branch-limited reader does not see branchless Activity rows** (round
  4a, the app's own rule): a user created or a policy published shows to the
  park group's readers with every branch only.
- **The app's two manual job routes point at the Console** once the
  platform runs the jobs. No screen calls them.
- **A standing employee-copy case re-files every run** — about 96 Failures
  rows a day, grouped by code (Q17). There is no `ops_expectation` on
  `otoapp:employee.sync`, so none of this raises alerts.
- **A FOREIGN account link is raised even for leavers.** The copy raises
  OTOAPP_FOREIGN_ACCOUNT_LINK before it checks LEFT, so a departed or
  never-copied employee with a foreign link raises it on every run.
- **Run now forced on two instances can both claim** — the run lock is
  transaction-scoped and force skips the due check, so standing cases file
  twice. Nobody is copied twice (the per-operator advisory lock holds),
  and staging runs one instance; on the normal schedule two instances make
  exactly one claim.
- **The employee view reads the app's timestamps as UTC wall time**
  (`AT TIME ZONE 'UTC'`). Nothing in the copy reads them today.
- **A copied employee usually has no phone on the platform.** The view
  deliberately carries the app's VERIFIED number (`employees.phone_e164`),
  and the app's HR form writes only the free-text `phone` box - the
  normalized column fills when the person verifies a phone (kiosk
  clock-in), or syncs to their USER only once a login is linked. Seen on
  staging 8 October: all four adopted demo rows carry phone null while the
  HR form showed their numbers. Sign-in is untouched (the account keeps
  its own phone). Q21.
- **The daily night jobs record a run every five minutes** (round 3): most
  say "not due before 00:01" or "already done for the date", as the other
  five-minute day-end jobs record theirs.
- **A night the app is down for the whole Bangkok day is not caught up**
  after the date turns (Q24). The app's batch works on "today" whenever it
  runs, so the next night still moves every leaver and closes every stale
  clock-in — but a day late: its midnight step writes the lost night's
  automatic clock-outs at the NEXT midnight, so a forgotten clock-in from
  the day before the lost night is recorded as a shift a day too long. A
  guest left checked in that day is checked out at that later midnight too,
  a stay a day too long. The lost day's recurring task instances are never
  made.
- **A failed park group's batch runs again at the next tick**, steps that
  already finished included. Each step of the app's batches is safe to run
  again after itself: a second run finds nothing left to change. That was
  not true of task generation until the round 3 review: a task due before
  07:00 Bangkok was made a second time (F2, fixed — section 4). Two runs at
  once are kept apart by the per-park-group lock, which the app's own timers
  now take too (F4). While Attention writes are paused nothing else repeats;
  when they resume, the presence step raises its stuck clock-in items again
  on each run, as the six-hourly check already does.
- **On the day of the switch the batches may run a second time.** The app's
  own timers ran that night's 00:01 and 03:00 batches in-process; the
  platform's first tick after the flip finds no record of them and runs
  them again, which changes nothing now that task generation finds a date's
  instance by its date (F2).
- **Under `inprocess` the 03:00 timer still stops when the clean-up fails —
  and without Sentry, the whole app does.** The availability clean-up is the
  one step whose error the app lets escape, and its timer is re-armed only
  after the batch returns, so one failure ends the in-process 03:00 schedule
  until the next restart. The escaped error is also an unhandled rejection:
  with `SENTRY_DSN` set, Sentry's handler logs it and only the 03:00 timer
  stops; with no `SENTRY_DSN`, nothing handles it and Node ends the WHOLE app
  process, every screen down until it is restarted (Q26). Under `platform`
  the escaped error is a failed step and the next tick runs again.
- **A park group the app holds with no jobs key fails every night-job run**
  (review F1): every five minutes for the daily batches, at each six-hourly
  check, until it has a key. The keyed park groups are run all the same.
- **A batch still running at a second tick fails the run** (review F3),
  where before it stayed green all night with nothing done.
- **A leaver whose platform account stays on is filed every night** (Q4,
  Q23), grouped on Failures, as the employee copy's standing cases are (Q17).
- **Ordered rollouts can be raced by the auto-deploy.** Render deploys
  every service on a green commit (checksPass), so "app first, then the
  api" can be overtaken: on 4b's staging rollout the auto-deployed api
  ticked Attention eighteen seconds before the app finished, and the one
  failed run said OTOAPP_JOB_NOT_FOUND. That noise is expected at a
  switch-over; the remedy is the run's own words - Retry on Failures -
  and it ran green. A production cut that cannot tolerate the one noisy
  run pauses auto-deploy for the ordered pair.
- **An app-only branch strands its staff branchless on the platform.** The
  app lets HR seat an employee on a branch no platform branch maps to
  (staging has such a branch, itself named "HKT Central"), and the copy
  then carries branch null, so the person drops out of branch-scoped
  platform lists until the app reseats them. Seen and corrected on staging
  8 October; the mapped branch there is "Oto Play Park, Central Floresta".
- **A sick day over a rota shift is refused, as the app refuses it** (round
  5, Q44). The restored approval frees a rota shift only when one is
  assigned in the instant between the route's conflict check and its save;
  otherwise the manager removes the shift first and no "Shift needs
  coverage" alert is raised. A freed shift's alert is filed at the leave's
  branch, also for a shift at another branch (the app's shape), and its rule
  (`SICK_LEAVE_COVERAGE`) is one the six-hourly run does not raise, so that
  run resolves it (Q32).
- **A rota shift assigned while a sick day saves can outlive it** (round 5's
  review, beside Q44). The race the other way round: a rota assignment
  whose eligibility read ran before the sick day was saved, and whose insert
  lands after the sick-day route's freeing step, leaves the person on that
  shift on an approved sick day with no coverage alert. Neither route holds
  anything across its check and its write; that is the app's own race, kept.
  The remedy, if you ask for it, is a per-person lock taken by the time-off
  create and the assignment creates around their check and write. Pinned
  standing in `apps/api/test/s217b-r5-review.test.ts` B.
- **Approving a sick day unassigns older-list shifts over the app's range**
  (round 5, Q38): from the first day's 00:00 UTC to the last day's 00:00 UTC,
  so a one-day leave reaches only a shift starting at 07:00 Bangkok, and a
  last day's morning shift is not reached. No screen writes that list.
- **Every face scan reads "not recognised"** (round 5, H13). After three the
  tablet asks for the phone number, the app's own fallback; PIN works as
  before. Attention still raises "face enrollment required" for every
  unenrolled employee (staging's first 4b run raised four), while enrolment
  is refused (Q42).
- **A shift group with shifts cannot be deleted from the screen** (round 5,
  Q45). The screen offers no target group, and the refusal asks for one; it
  was a bare 500 before.
- **The scheduling module answers across branches and park groups** (round
  5's proof, Q39): `/api/schedule/*` has no branch rule and no park-group
  rule, so a branch-limited manager reads and writes other branches' rota,
  and any manager reads another park group's by its ids. The rota view
  (`/api/rota`) keeps to the branch. The older shift list's coverage read
  keeps to one only when it is named; with none it answers every branch of
  the caller's park group (held to the park group since round 5's review,
  section 4). Pinned in `tests/attendance.check.ts` as FINDING Q39,
  unchanged in this round.
- **Some leave reads have no branch rule, and two refuse every
  branch-limited reader** (round 5's proof, Q40): sick-leave balances answer
  any branch and employee; the leave-policy and per-employee balance reads
  test a field the session never carries (`user.branchIds`) and refuse even
  the reader's own branch.
- **A tablet minted into another park group's branch before round 5 keeps a
  session and sees nothing** there: its branch read answers 404 and its board
  is empty. Revoke it from Kiosk devices.
- **The reception tablet's day starts at 07:00 Bangkok** (the app's rule,
  kept). Its board (`/api/kiosk-reception/checkins`) lists the check-ins
  registered since the server's midnight (`setHours(0)`), and the server
  runs in UTC. So from midnight to 07:00 Bangkok the board still holds the
  previous day's guests, and a guest registered in those hours leaves it at
  07:00.

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
- **Q16. The employee copy names nobody on a tie (round 2).** Where the
  app's own answer depends on row order — two employees carrying one
  login, two sharing an email where both also match the user's phone or
  name, or two users reaching one employee by email alone — the copy links
  no account, and the booth lists the person as unmatched. The app itself
  picks one of the two by row order. Is "name nobody" the right rule, or
  should the copy guess the way the app does? Default: name nobody; a
  wrong link gives one person another's till sign-in.
- **Q17. Standing cases repeat every quarter-hour (round 2).** A case that
  stands — say an unanchored test park group — is filed on every run,
  about 96 rows a day, grouped by code on Failures. Should a case be filed
  only when it changes? Default: keep filing each run; the Failures page
  groups them, and a run that filed nothing reads as a run that found
  nothing.
- **Q18. The delete doors are stricter than the app (round 2).** An
  administrator the app cannot place is refused at the employee, bulk and
  people delete doors, not only at the users door; and an employee whose
  email-matched user or person belongs to another park group is refused
  rather than deleted. The app has no rule for either case. One effect: a
  person row orphaned across park groups can never be deleted from the
  app's screens. Confirm the refusals? Default: keep them.
- **Q19. A leaver who was never copied (round 2).** Someone the app
  already marks LEFT whose login points at a live platform employee row:
  the copy adopts that row and archives it at once, revoking their benefit
  cards. Confirm? Default: keep — the app says they left, so their cards
  should not scan.
- **Q20. A settle tool for the double row (round 2).** The ordinary order
  of work — HR adds the person in the app, the copy makes their row, and
  later the Console's Login users panel creates their account with an
  employee name, making a second, platform row — ends in a standing
  ADOPTION_CONFLICT raised every quarter-hour, with the person listed
  twice in Staff Benefits and no screen able to settle it, because nothing
  re-points an account's employee link. Should the Console get a settle
  tool (pick which row is the person's, move the account link, archive the
  other)? Until then the avoidance is ordering: provision the app user to
  the account before (or in the same copy window as) creating them as an
  app employee.
- **Q21. The phone the copy carries (round 2, staging).** The employee
  view reads the app's verified number (`phone_e164`), which the HR form
  never fills - so a copied employee's platform phone is empty until they
  verify one at the kiosk. Should the view fall back to a normalisation of
  the HR form's free-text phone box? Default: as built - only a number the
  app verified crosses, and an unverified free-text box is not a number to
  trust for anything that reaches a person.
- **Q22. The order of the switch (round 3).** This plan said to flip the app
  to `OTOAPP_JOBS=platform` only after one platform-run success. But the
  app's job endpoint refuses while the app runs its own timers (that refusal
  is what stops a batch running twice), so no platform run can succeed
  before the flip. And Run now, which round 3 put on Health, is a staging
  test control (`OPS_TEST_CONTROLS`): production refuses it. Default as
  built, for production, done between 03:00 and 23:00 Bangkok (the day's two
  batches already run in-process, the next not yet due):
  1. issue a `jobs:run` key in the app for EVERY park group it holds staff
     in — one left out fails every run, naming it (F1);
  2. flip the app to `OTOAPP_JOBS=platform` and redeploy it: its timers
     stop, and the platform's jobs are still no-ops;
  3. set `OTOAPP_JOBS_KEYS` on the api and redeploy it, the same day:
     between steps 2 and 3 no night work runs anywhere, and a platform
     holding no key at all is a no-op that raises nothing.
  Within five minutes the platform's first ticks run the day's 00:01 and
  03:00 batches a second time, which changes nothing (section 10), and Health
  shows each job's run — or Failures shows why, where Retry runs it again
  once the cause is fixed. The presence check runs at its next six-hourly
  interval. If a batch keeps failing, flip the app back to `inprocess` and
  remove the keys. On staging Run now shows the same at once. Is that order
  acceptable? The alternative is a production Run now: a guarded, audited
  Console action outside the test controls (not built).
- **Q23. Which leavers' platform accounts are listed (round 3, extends Q4).**
  The app switches off a leaver's OTO App login by last working day alone,
  and only the login an employee record carries in `user_id`. The platform's
  list reads the same last-working-day rule, but takes the person's account
  from the employee view (the `user_id` link, then the app's email
  fallback, inside the park group's operator only - the one rule the copy
  and the booth roster use, H24), and lists only accounts that are `active`
  (an `invited` account is not listed). So a leaver linked to their account
  only by email is listed although the app leaves their OTO App login on.
  Default: as built. The alternative is the `user_id` link alone, exactly
  the logins the app's step reaches.
- **Q24. A night the app is down all day (round 3).** If the app answers
  nobody from 00:01 until the Bangkok date turns, that night is not run
  later. The app's batch works on "today" whenever it runs, so the next
  night's batch still moves every leaver and closes every stale clock-in,
  but a day late: the lost night's automatic clock-outs are written at the
  next midnight, so a forgotten clock-in is recorded as a shift a day too
  long (and a guest left checked in is checked out at that midnight, a stay
  a day too long). The lost day's recurring task instances are never made.
  The app's own timers lose the same night, the same way, whenever the
  process is down at 00:01. Default: as the app. The alternative is a
  catch-up that runs a missed date's batch for that date (a new rule).
- **Q25. Run now for a daily batch (round 3).** Run now does not run a
  park group's night again once it is done for the date, and runs nothing
  before the batch's hour; the app's manual triggers, which it replaces
  under `platform`, ran at any time. Default: as built, which is H8's "once
  per date". An administrator who needs a leaver's login off at once
  deactivates the user in the app. The alternative is a forced Run now that
  re-runs a done night (each step is safe to run again after itself, now
  that task generation finds a date's instance by its date — section 4, F2;
  and Run now itself is staging-only — Q22).
- **Q26. The in-process 03:00 timer after a failed clean-up (round 3).** Under
  `inprocess` the app keeps its own behaviour: a failed availability
  clean-up ends the 03:00 schedule until the next restart (section 10). It
  does more where `SENTRY_DSN` is not set: the escaped error is an unhandled
  rejection, nothing handles it, and Node ends the WHOLE app process — every
  screen down until the app is restarted — not just the 03:00 timer. With
  `SENTRY_DSN` set, Sentry's handler logs it and only the timer stops.
  Should the in-process timer be made to carry on as well? Default: keep the
  app's behaviour; the platform owns the schedule from the switch, and there
  the failure is a failed step and the next tick runs again.

- **Q27. Nobody notices if the keys are forgotten after the flip (round
  3).** If the app is switched to OTOAPP_JOBS=platform but the api holds no
  OTOAPP_JOBS_KEYS at all, every night is lost and nothing is raised: the
  api treats "no keys" as "this deployment has not opted in" (failing it
  would alarm every deployment that still runs in-process), and it cannot
  see the app's own switch. Q22's hand-over order documents it, and only a
  person reading Health catches it. Should the app's mode cross the seam
  (say, a view column or a health answer) so the api can refuse the silent
  state? Default: the documented hand-over order, no new seam.

- **Q28. Settings a park group has not saved (round 4a).** The app has one
  set of settings that every park group reads. So today a second park
  group's contracts are counter-signed with the default park group's
  signatory name, title and signature image, and its staff get the default
  park group's probation and leave entitlements, kiosk code lifetime and AI
  prompts. As built, a park group with no row of its own for a key reads the
  default park group's, which is exactly that. The alternative is no
  fallback: such a park group gets the app's built-in defaults (Tom Sauer,
  Managing Director, no signature image, 120 days' probation, 8 days'
  annual leave) until it saves its own (4b). The one exception is built
  either way: the Fix department names one park group's department, so
  another park group reads none. Default: read the default park group's, as
  the app does.
- **Q29. Which saves another park group is refused in 4a (round 4a).** The
  plan said another park group may not save a key the default park group
  holds. As built it may not save any setting: while the old unique on the
  key stands, a key a second park group saves first can then never be saved
  by the default park group — the park that runs on the app today — until
  4b. Default: refuse every save by another park group until 4b, in words.
  The alternative lets them save keys nobody holds yet, and the default park
  group is then refused those keys until 4b.
- **Q30. The backfill's order (round 4a).** The plan said branch, then
  employee, then the default park group. As built, an activity row with
  neither takes its contract's employee's park group, and then the park group
  of the user who did it where the app's strict placement
  (`managedUserTenant`) places them — every access row naming one park group,
  every branch those rows name that park group's, and an operator admin's
  operator that park group's too — before falling to the default. Otherwise
  a user created or a policy published by a second park group's admin lands
  in the default park group's logbook, which H10 forbids. A user that rule
  cannot place places nobody, so their row falls to the default, as the
  app's own User Management would leave them unplaced. Attention items take
  the contract step but not the user one: an item is raised by the engine,
  and who resolved it says nothing about whose it is. New rows are written
  on the same order, the caller's own park group standing before the user
  step. Default: as built. The alternative is the plan's three steps.
- **Q31. Where the census's exposures are fixed (round 4a).** The root-table
  census (section 7) found four places that read or write across park
  groups, none of them in 4a's scope. Default placement: `leave_policies`
  in round 6, a tenant column on the round 6 pattern with its routes held
  to the caller's park group (placed in round 5, leave and holidays, at
  first; round 5 added no migration, so it carries no column, and its
  review fenced only the sibling `sick_leave_policies`, which has its own,
  Q40); `people` in round 6 (HR
  records), its routes scoped by the park group of each person's access
  policy or employee rows; the five form-builder routes over
  `i18n_translations` (the four that read and write drafts and
  translations, and `POST /api/dropoff-form/:formId/publish`) in round 7,
  with the form builder's walkthrough, each held to the form's park group;
  and
  `POST /api/employees/recalculate-probation` in round 6, held to the
  caller's park group. Data Admin's reach stays with its round 7
  walkthrough. Confirm, or move any of them earlier.
- **Q32. The six-hourly run resolves alerts it does not raise (round 4b).**
  The app's full reconciliation resolves every open alert that has a rule
  key and that its employee rules did not raise this time. The no-show
  alerts (raised by the ten-minute check) and the open-shift and coverage
  alerts (raised only by Refresh) are among them, so a no-show alert closes
  at the next six-hourly run and opens again ten minutes later while the
  person is still absent, and an open-shift alert stays closed until someone
  presses Refresh. Default: the app's behaviour, ported as it is. The
  alternative is to resolve only alerts of the rules the run evaluates.
- **Q33. Shift alerts only on Refresh (round 4b).** The app's six-hourly
  timer runs the employee rules only; the open-shift and coverage rules run
  when a manager presses Refresh. `job:otoapp.attention` runs what the timer
  ran. Default: as the app. The alternative is a scheduled run that includes
  the shift rules (which, with Q32 as it stands, would also stop them being
  resolved by the next run).
- **Q34. Whose Attention alerts a reader sees (round 4b).** The app showed
  every alert to every signed-in user, whatever the park group or branch. The
  lift limited the reads to managers and to alerts whose branch, employee and
  contract agreed, and withheld the alerts about no branch from everyone.
  As built, a manager sees their own park group's alerts: one with every
  branch sees them all, the ones about no branch included; one limited to
  some branches sees those branches' alerts only — the rule the Activity
  Logbook follows (round 4a). Default: as built.
- **Q35. Refresh while the engine runs (round 4b).** The app had no lock, so a
  Refresh beside the six-hourly run could raise one alert twice. As built, a
  Refresh pressed while its park group's engine is running is refused in
  words ("try again in a minute") and nothing runs twice; each park group's
  Refresh is its own. Default: as built.
- **Q36. Data Admin's settings after 4b (round 4b).** 4a held Data Admin's
  Setting model to the default park group while the old unique stood. With
  the unique gone that hold is lifted, and the model reaches every park
  group's settings rows as Data Admin reaches every other model (its round 7
  walkthrough, Q31). A create naming no park group is the default park
  group's; a row cannot be moved to no park group. Default: as built. The
  alternative is to hold Data Admin's settings writes to the caller's park
  group now, ahead of round 7.
- **Q37. A database whose park groups include none slugged `default` (round
  4b).** The app's rule makes the slug-`default` park group the default (or
  the only park group, where there is one). Where several exist and none
  carries the slug — not staging, not production — there is no default: a
  park group with no row of its own for a setting reads the app's built-in
  value, an Activity row about nothing whose actor cannot be placed is
  refused (the column is NOT NULL), and a Data Admin settings create naming
  no park group is refused in words. Default: as built, which never guesses
  one park group's settings for another. The alternative is to slug one park
  group `default` whenever a second is added.
- **Q38. The later sick-day approve, and the older shift list's range
  (round 5).** The app's update route means to unassign the person's
  older-list shifts when a sick day is approved later, but compares
  `record.timeOffType`, a name the row does not carry (its column is `type`,
  the slip the lift already corrected for this route's update fields), so in
  the live app it never ran. As built it runs (H14), and a second approve
  finds nobody left and changes nothing. Both approval steps use the app's
  range, from the first day's 00:00 UTC to the last day's 00:00 UTC, so a
  last day's morning shift is not reached. No screen writes the older list
  today, and its create route names no park group (which the column
  requires), so neither choice changes anything the park can see now.
  Default: as built — the code's evident rule, over the app's own range.
  This departs from the live app, where a later approve was an accidental
  no-op: H14 asked for the restored behaviour ("approved later: their legacy
  `shifts` in the range are unassigned"), so here the default follows H14,
  not the live app. The alternatives are the live app's no-op on a later
  approve, or a range widened to the leave's Bangkok days.
- **Q39. The rota answers across branches and park groups (round 5's
  proof).** The week plan, shift groups, rows, assignments and templates
  (`/api/schedule/*`) carry no branch rule and no park-group rule: a manager
  limited to one branch reads and changes every branch's rota, and any
  manager reads another park group's rota and adds rows to it by its ids
  (pinned as FINDING Q39 in `tests/attendance.check.ts`). The rota view
  (`/api/rota`) keeps to the branch. The older shift list's coverage read
  (`GET /api/shifts-needing-coverage`, the shifts the sick-day step flags)
  keeps to a branch only when one is named: with none, the app answered
  every branch of every park group. Since round 5's review it answers the
  caller's park group only (section 4); within it, a manager limited to one
  branch still reads every branch's flagged shifts, the app's rule (pinned
  in `apps/api/test/s217b-r5-review.test.ts` E1). Default: the branch rule
  as the app (none), for the rota and for that read, until you say
  otherwise; the rota's park-group crossing is a data fault and is fenced on
  our own authority in a slice of its own (about 40 routes, not built in
  round 5). The alternative is the rota view's branch rule on every
  scheduling route, and on the coverage read with no branch named.
- **Q40. Leave reads with no branch rule, and two that refuse everyone
  limited (round 5's proof).** Sick-leave balances
  (`/api/sick-leave-balances`, `/api/employees/:id/sick-leave-balance`)
  answer any branch, and any park group's employee. The leave-policy read
  and the per-employee balance read (`/api/leave-policies?branchId=`,
  `/api/leave-balances/employee/:id`) test `user.branchIds`, a field the
  session never carries, so they refuse a branch-limited reader even their
  own branch. Public holidays are park-group wide (the app's rule), but
  their edit and delete take any park group's holiday by id. Two more
  crossings, found in round 5's review, are fixed (section 4): the
  sick-leave policy's company-wide fallback ignored the park group, so one
  park group's admin saving the company-wide entitlement rewrote another's
  row and every park group read the first such row (`sick_leave_policies`
  has its own `tenant_id`; the policy read, its save and every balance now
  take the park group, the caller's or the employee's); and
  `GET /api/employees/:id/leave-balance` read another park group's employee
  for any admin (now the app's 404). Default: the branch rules as the app;
  the remaining park-group crossings (sick-leave balances by branch or
  employee, and public holidays' edit and delete) fenced with Q31's
  `leave_policies` fix, in round 6 with that table's tenant column (round 5
  added no migration, so it could not carry the column). The alternative is
  the time-off rule (the reader's branches) on every leave read.
- **Q41. Which branches a manager may activate a reception tablet on
  (round 5).** A manager limited to one branch can make a reception kiosk
  code for any branch of their park group; the app has no branch rule there
  (pinned as FINDING Q41). Another park group's branch is refused since
  round 5 (section 4). Default: as the app. The alternative is the
  manager's own branches only.
- **Q42. "Face enrollment required" while face is off (round 5).** The
  Attention engine raises FACE_ENROLLMENT_REQUIRED for every employee with
  no face enrolled, while enrolment is refused (staging's first 4b run raised
  four). Default: as the app, the rule stands. The alternative is that the
  rule stands down while face is off.
- **Q43. The face road's follow-on doors (round 5).** H13 named
  `/api/kiosk/clock`; three more doors are reached only from its answer —
  the missed clock-in auto-fix and manual entry, and the unscheduled
  clock-in — and the advisor's face clock. Each writes FACE time events or
  sessions for a person the server matched by nothing but the tablet's
  word. As built they are refused too while face is off. Default: as built.
  The alternative is to leave them open (they cannot be reached from the
  app's screens while identify-face matches nobody).
- **Q44. A sick day over a rota shift (round 5).** The app refuses to save a
  day off on any day the person has a rota shift ("Please remove the shift
  first") before it saves, and its approved-sick step then looks for exactly
  those shifts, so "approving frees the shifts and raises coverage alerts"
  happens only when a shift is assigned in the same instant. In practice the
  manager removes the shift, and no coverage alert is raised. Should an
  approved sick day be allowed over a shift, freeing it with its coverage
  alert (the step's evident purpose)? Default: the app's order, as is. The
  race the other way round (a rota assignment checked before the sick day
  saves and written after its freeing step, leaving the person on the shift
  with no alert) is recorded in section 10 as the app's own, open until you
  ask for the lock.
- **Q45. Deleting a shift group that still has shifts (round 5).** The
  screen's confirm says "Shifts in this group will be ungrouped", but the
  database requires a group (Q2), so it failed with a 500. As built it is
  refused in words asking for the group to move them to; the screen offers
  none, so such a group cannot be deleted from the screen until its shifts
  are moved. Default: as built. The alternative is a target-group choice in
  the delete dialog (a UI addition) or Q2's "allow ungrouped".
- **Q46. Two more doors with no branch rule (round 5's review).** Within
  their own park group, a manager limited to one branch reads another
  branch's checklist history (`GET /api/checklists/checker-history/:templateId`,
  though that branch's template itself is refused them), and lists and
  revokes another branch's reception tablets
  (`GET /api/branches/:branchId/kiosk-devices`,
  `DELETE /api/kiosk-devices/:id/revoke`). Another park group's tablets are
  not listed, and since round 5's review not revoked either (section 4).
  Pinned as FINDING Q46 in `tests/attendance.check.ts`. Default: as the app.
  The alternative is the manager's own branches only, as the checklist
  templates already have it and as Q41's alternative would for activation.

## 12. Hazards, each with its test

| # | Hazard | Test |
|---|---|---|
| H1 | An upper-case client-minted park id falls out of the seam | Create a branch with an upper-case id: `core_branch_id` is stored lower case, and an app event there appears in `otoapp_v.events` |
| H2 | One person gets two `core.employee` rows | An app employee linked to an account that has a platform employee adopts it (same id, benefit profile kept). A second run writes nothing. An adoption that would collide with an existing copied row is refused and raised, not merged |
| H3 | The view leaks HR data | A test pins the exact column list of `otoapp_v.employees`, with no pay, tax, SSO, visa, address, birth date, face or PIN column |
| H4 | One park group's staff land in another operator | A two-tenant fixture: tenant B's employees never reach operator A. An unanchored tenant is skipped and named in the run |
| H5 | A platform edit to a copied employee is silently undone | `PATCH /me` on an `otoapp` row refuses name, nickname, email and phone. No other platform route writes those fields on such a row |
| H6 | A leaver keeps a benefit | Mark the employee LEFT in the app: the row is archived, live cards are revoked, a scan is refused, and a rehire gets a new card |
| H7 | The copy stops and nobody notices | `ops_expectation` on Health. A forced failure appears on Failures, and a missed run raises the watchdog alert. For the night jobs (round 3 review): a park group the app holds with no key fails every run naming it (F1), and a batch still running at a second tick fails the run (F3) |
| H8 | A night batch runs twice | Two concurrent invocations: one runs and one is `locked`. Two batches for one date: one success. The auto clock-out inserts one OUT per stale IN. Under `platform` the app starts no timers; under `inprocess` the endpoint refuses. Round 3 review: a second midnight batch of one date makes no second task instance, due at 06:30 or 18:00 (F2); an in-process timer stands down for a park group whose batch the endpoint holds, and runs the others (F4) |
| H9 | A night is lost when the app is down | The first invocation fails, the next tick runs it, and the date is marked done once |
| H10 | The backfill gives rows to the wrong tenant | A two-tenant fixture with branch-linked, employee-linked and branchless rows: each lands in its tenant, none is left null, and the counts per tenant are unchanged. Round 4a: `s217b-r4a.test.ts` A and B, rows linked by branch, employee, contract, the user who did them and nothing, on a seeded 0005 state upgraded by the app's migrator |
| H11 | The settings change breaks the running release, or a park group's settings write fails on the old unique | Release N's code passes on both the old and the new constraint shape. The old unique is dropped only in release N+1 (4b). In 4a, another park group writing a key the default group holds is refused in words, never a 500. Round 4a: `tests/tenant-ownership.check.ts` runs every settings answer with the old unique standing, then dropped (4b's shape), then restored. Round 4b: each park group saves its own row; with the old unique put back (a database 0007 has not reached) another park group's save of a key the default holds is words, never a 500, and a save of several keys saves none when one is refused (`tests/tenant-ownership.check.ts`, `s217b-r4b.test.ts` E) |
| H12 | Directory reads cross tenants | A's key reading B's employee answers 404. A key without `hr:read` answers 403. With `HR_DIRECTORY_API_KEY` unset, the shared-key path answers 403. Round 4a: `tests/tenant-ownership.check.ts` over the six reads, and with the shared key set, the default park group only (Q13) |
| H13 | Face "off" clocks in the wrong person | With face off and an ENROLLED employee present, `identify-face` answers "no match, use PIN" without calling a matcher, enrolment is refused, and `/api/kiosk/clock` from a paired tablet naming that employee writes no time event. Round 5: `tests/attendance.check.ts` section 4 (with the matcher's silence read from the app's own output, the three follow-on doors and the advisor's clock, and PIN and phone still clocking) and `s217b-r5.test.ts` C |
| H14 | Sick-leave approval does too much or too little | The rota's own request (the restored client body) creates the sick day as approved. Created as approved: exactly that person's assignments on those Bangkok days are freed, with one coverage alert per shift, each in that person's park group. Approved later: their legacy `shifts` in the range are unassigned. A repeat approve changes nothing more. Nothing is stored. Round 5: `tests/attendance.check.ts` section 1 (the freeing step reached through a trigger standing in for a shift assigned at the same instant, since the app's conflict check refuses an existing one first — Q44) and `s217b-r5.test.ts` A |
| H15 | An ungrouped shift row errors | The route answers 400 in words and no row is written. Round 5: at all four doors (create, edit, drag, a group deleted with no target), `tests/attendance.check.ts` sections 2 and 3 and `s217b-r5.test.ts` B |
| H16 | Partial writes: offboarding, finance | A failure injected mid-offboarding leaves nothing. The finance keys make `ON CONFLICT` upsert, and the migration stops loudly on duplicate rows |
| H17 | The rehearsal re-runs the baseline or misses the views | Restore, rename, mark 0000, apply 0001 onwards: the views exist, the counts equal the sample, and a second run is identical |
| H18 | An app migration breaks a seam the platform reads directly | A test compares every column declared in `packages/db/src/schema/otoapp.ts` with the app's migrations and fails when one is dropped or retyped. Views are protected by Postgres itself |
| H19 | The POS reads app tables outside the declared seams, or an app-only change goes untested | The section D grep extended to the HR and rota tables, with an allow-list naming the provisioning, branch and booth seams. A CI run on an app-only commit runs the view tests |
| H20 | Attention floods or duplicates on resume | Two engine runs over the same rows give no duplicate items in a tenant. Fingerprint uniqueness is per tenant. Round 4b: `tests/attention.check.ts` (a second run raises nothing new; two runs at once, one refused; each park group's items its own) and `s217b-r4b.test.ts` E (the platform's job against the real app); the first run's burst is counted, not capped, in D |
| H21 | The app's database role can write platform schemas | A grant check that the role behind the app's `DATABASE_URL` has no write on `core`, `crm`, `pos`, `promo`, `booth`, `analytics` or `edge`. It runs on staging as a read-back, because whether staging connects as its own `oto_app` role is set by hand in Render and is not in the repository |
| H22 | Walkthrough fixtures left behind on staging | Every fixture is ZZ TEST, removed by exact id with a read-back recorded on its page. Restricted identities use a temporary password, never SMS |
| H23 | One person is tied to the wrong account, or to another operator's | A two-operator fixture: an app employee whose email matches a user linked to operator B's account, in a tenant anchored to operator A, is copied with no account link and raised. A created copy sets its linked account's `employee_id` in the same transaction. An account already pointing at another employee row keeps it, and the case is raised |
| H24 | The booth roster and the copy name two accounts for one person, or the view's link drifts from the app's rule | An app employee linked only by the email fallback (no `user_id`): the booth roster and `otoapp_v.employees` resolve the same platform account, and an employee linked to nobody is unmatched in both. Over a fixture with a `user_id` link, a single email match, two employees sharing an email (the phone and name tie-breaks) and an unresolved tie: for every user, the employee the app's `getUserWithBranchAccess` picks is exactly the one whose view row names that user's platform account |
| H25 | A rehire gets a second row and loses their history | Mark the employee LEFT, run the copy, make them active again, run it again: one `core.employee` row, the same id, un-archived; their old cards stay revoked |
| H26 | A dev or maintenance route runs on a deployment or across park groups | With `DEPLOY_ENV=staging`: `seed`, `prod-sync`, the dev import, `test-sentry` and `test-object-storage` are refused and write nothing. A park group's admin calling the four maintenance routes changes only its own park group's rows |
| H27 | The old voucher ledger takes a write | Every write route in `server/voucher-routes.ts` answers with the Console notice and writes no row; the reads still answer |
| H28 | A linked app user is deleted under the platform | `DELETE /api/users/:id` on a user with `platform_user_id` answers 409 in words, and the user and its `core.app_identity` row are unchanged |
