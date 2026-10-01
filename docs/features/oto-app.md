# OTO App ("OTO Suite")

## What it is for
The park's day-to-day management system, used by all staff every day since about
May 2026: HR records, contracts and letters with e-signature, timekeeping kiosks,
scheduling and leave, payroll, tasks / checklists / ops board, announcements,
SOPs and the "Ask OTO" assistant, fault reports with a supplier portal, events
and birthdays (event orders, packages, parent portal, RSVP), camps, drop-off and
nanny check-in, staff vouchers. 72 login users, 69 employees, 3 branches.

## Intake
- **Source:** `imports/oto-app/` — Replit export of 2026-09-19 (last commit
  2026-09-15; 2,920 commits, 37 in the last 30 days — still actively edited).
  Detailed notes: [`01-oto-app-backend.md`](../architecture/intake-2026-09-19/01-oto-app-backend.md),
  [`02-oto-app-frontend.md`](../architecture/intake-2026-09-19/02-oto-app-frontend.md).
- **Real or mockup:** **live, with production data.** Two earlier Replit apps
  ("OTO HR", "OTO Core") merged, plus "Studio" pages. Deployed on AWS App
  Runner via Pulumi; the environment named `staging` is production.
- **Stack:** React 18 + Vite 7 + Tailwind 3 + shadcn (122 routes, ~129k lines);
  Express 4 monolith (796 routes; `routes.ts` 25.5k lines, `storage.ts` 12.2k);
  Drizzle on `pg`; Passport-local with scrypt hashes; sessions in Postgres;
  uploads on S3 (two buckets) with some writers still on local disk; Puppeteer
  for PDFs; Twilio Verify; OpenAI; AWS Rekognition for face clock-in; Sentry.
  No unit tests; 48 Playwright specs.
- **Its tables:** all 184 in the dump (`imports/_db/`), 65 enums, 519 foreign
  keys. 93 tables hold data (~46.8k rows). Busiest: `time_events` 8,116,
  `kiosk_auth_attempts` 7,814, `checklist_run_items` 4,049,
  `schedule_assignments` 3,354, `service_checkins` 2,038, `dropoff_checkins`
  1,332. Empty today: payroll, SOP / KB, Ask OTO, vouchers, assets, Xero.
- **Export vs production:** zero drift — all 184 tables, 2,319 columns and 370
  indexes match the code. Schema is managed with `drizzle-kit push --force`, not
  migrations. Known defect: four finance tables lack the primary keys their
  upserts rely on, so the Xero sync cannot work.
- **Shared entities it touches:** tenants, operators, branches; users, people,
  employees, roles, branch access, per-user module switches. **No customer,
  member or child table** — parents and children are free text across seven
  tables.
- **Replit-specific dependencies to replace:** cookie `secure` flag keyed on
  Replit env vars; `replit_integrations/` storage module; `AI_INTEGRATIONS_*`
  naming; Xero redirect hard-coded to the Replit host; Nix Chromium path; three
  Replit Vite plugins.
- **Secrets found in the export:** yes — `temp-env` (26 variables), `k8s/app.yaml`,
  `.replit` (seed admin), a Sentry DSN, `cookies.txt`, plus uploaded personal
  files. All excluded from git here (`imports/` is ignored); all to be rotated.

## Original integration plan (historical)
This records the intake design. The module status and live release gates below
supersede its proposed implementation details.

- **Deployable:** one Docker service serving UI and API together (its browser UI
  makes ~660 same-origin `/api` calls). Existing `Dockerfile`; ≥2 GB RAM for
  Chromium; exactly one always-on instance (in-process timers: 00:01 auto
  clock-out and recurring tasks, 03:00 reconciliation, 10-minute no-show alerts);
  `TZ=UTC`; health check `/api/status`; same region as the database.
- **Login:** an adapter before `passport.session()` validates the platform
  cookie, maps it to the local `users` row via a new `platform_user_id`, and
  calls `req.login()`. All handlers stay unchanged. scrypt hashes are imported
  and re-hashed on first sign-in. User, permission and password screens
  (~15 credential-writing routes) are re-pointed to the Console. Kiosk bearer
  tokens and public token links stay outside the sign-on.
- **Data:** schema `oto_app` via `ALTER ROLE … SET search_path` (Drizzle emits
  unqualified names, so no code change). Load path: restore the dump into a
  scratch database → `ALTER SCHEMA public RENAME TO oto_app` → dump across.
  Post-import script: add `platform_user_id`, mirror accounts / branches / staff
  into `core`, rewrite stored bucket paths, apply the clock-in decision. Never
  run `drizzle-kit push --force` or the reset scripts against the central
  database.
- **Files:** one bucket; merge the second (checklist media) into it; add bucket
  CORS for browser uploads; move the four local-disk writers (employee
  documents, unsigned contract PDFs, payslips, payroll exports) to object
  storage.
- **Seams to the rest of the suite:** `beo_event_billing.pos_order_ref` and
  `studio_event_bookings.pos_reference` become real links to POS orders;
  check-ins, camps and events gain a member id; staff vouchers become redeemable
  at the POS (the server endpoints exist, but the exported UI did not call them);
  the Directory API (`/api/directory/*`) served staff identity to other systems.
- **Launcher tile:** "OTO App" (or "Team"), shown with `app:team:access`.

## Environment variables (names only)
| Purpose | Variables |
|---|---|
| Required to boot | `DATABASE_URL`, `APP_ENV`, `STORAGE_ENV_PREFIX`, `OBJECT_STORAGE` |
| Runtime | `PORT`, `NODE_ENV`, `TZ=UTC`, `LOG_RESPONSE_BODY=false` |
| Sessions and token schemes | `SESSION_SECRET`, `SESSION_PEPPER`, `KIOSK_CODE_PEPPER`, `PIN_FINGERPRINT_SECRET`, `KIOSK_IDENTIFICATION_TOKEN_SECRET` |
| Object storage | `S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (`AWS_S3_BUCKET`, `AWS_S3_REGION` only until the buckets are merged) |
| PDFs | `PUPPETEER_EXECUTABLE_PATH` |
| SMS codes | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` |
| AI features | `AI_INTEGRATIONS_OPENAI_API_KEY` (leave `_BASE_URL` unset off Replit) |
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` |
| Optional | `HR_DIRECTORY_API_KEY`, `SENTRY_DSN`, `VITE_SENTRY_DSN`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` |
| Legacy face-clock settings (module off on staging) | `USE_AWS_REKOGNITION`, `AWS_REKOGNITION_COLLECTION_ID` |

New values for the session and token secrets mean: reprint the branch check-in
QR posters, re-activate every kiosk tablet, reset advisor PINs. Everything else
(signing links, parent portals, supplier links) survives.

## Security scope during the lift
The export review identified public children's-data lookup by phone, signed
contract PDFs served without login, weak kiosk clock and upload authorization,
plaintext credential storage, response-body logging, and exposed development
artifacts. The deployed repairs and remaining checks are recorded per module
in the [S2-17b acceptance index](../qa/SPRINT_2_ACCEPTANCE.md). This intake
list alone is not proof that every path has passed the staging access checks.

## Status

SCRUM-193 (S2-17b) is **In Progress** on Render staging. The central
`otoapp` schema, launcher sign-on and administrator entry work; many individual
actions have real staging proof, but the five parent acceptance criteria remain
open. The [acceptance index](../qa/SPRINT_2_ACCEPTANCE.md) and
[closure plan](../qa/oto-app-lift/closure-plan.md) carry the detailed checks.
Here **WORKS** means a specific module action and relevant access case have
direct staging proof; it does not certify the whole story. **WORKING WITH
CAVEATS** means a real action works but a named workflow, role or tenant check
remains. **DISABLED ON STAGING** means intentionally switched off or failing
closed pending a safe contract. **NOT YET VERIFIED** means a page, local check
or source change lacks the required staging action proof.

| Identity and people | State | Current staging evidence and limit |
| --- | --- | --- |
| Launcher sign-on | WORKS | One suite sign-on opens the OTO App as an administrator; [screen register](../qa/oto-app-lift/staging-screenshots-2026-09-30.md). Additional roles are checked with their modules. |
| Users and permissions | NOT YET VERIFIED | Local access checks exist; staging create/change and lower-role refusal remain in [HR notes](../qa/oto-app-lift/org-hr-verification.md). |
| Branches, departments and operators | WORKING WITH CAVEATS | Second-tenant branch isolation passed; a synthetic operator was created and fully removed on staging, with tenant-move and anonymous refusals. Department action and lower-role/foreign-tenant operator denial remain; user assignment needs explicit tenant identity. [HR notes](../qa/oto-app-lift/org-hr-verification.md). |
| HR employees | WORKING WITH CAVEATS | A labelled employee creation produced a branch-scoped Activity Log entry on staging; employee edit and restricted-branch read remain in [HR notes](../qa/oto-app-lift/org-hr-verification.md). |
| Contracts and e-sign | WORKING WITH CAVEATS | Fresh signature and signed PDF matched the park date; unauthorized signed access was refused. Template and role scope remain in [PDF notes](../qa/oto-app-lift/contracts-pdfs.md). |
| Contract templates | WORKING WITH CAVEATS | Non-default-tenant finalisation fails closed with 503 pending the tenant-column cutover; default-tenant template save/generate still lacks a full staging walkthrough in [PDF notes](../qa/oto-app-lift/contracts-pdfs.md). |
| Policies | WORKING WITH CAVEATS | Draft, publish and latest read worked for a default-tenant policy; other-tenant reads fail closed with 503 pending the platform cutover, and restricted-role proof remains in [policy notes](../qa/oto-app-lift/policies-assets.md). |
| Letters and e-sign | WORKING WITH CAVEATS | Fresh signature, signed PDF and private object read worked; wider role and branch cases remain in [PDF notes](../qa/oto-app-lift/contracts-pdfs.md). |
| Employee documents | WORKING WITH CAVEATS | Private image upload/read/delete round-tripped exact bytes and anonymous access was refused; restricted and self-service reads need a safe test identity in [document notes](../qa/oto-app-lift/employee-documents.md). |
| Assets | WORKING WITH CAVEATS | Asset assignment and return persisted, repeat return failed; non-default catalogue reads fail closed with 503 pending tenant cutover in [asset notes](../qa/oto-app-lift/policies-assets.md). |
| Offboarding | NOT YET VERIFIED | Local departed-account check only; a staged access change is still required in [HR notes](../qa/oto-app-lift/org-hr-verification.md). |
| Org chart | WORKING WITH CAVEATS | Salary budget returned finite totals for company and own branch; node GET can insert missing rows, so chart viewing and relationship edits remain unstaged in [Org notes](../qa/oto-app-lift/attention-org-staging-dfe7153.md). |
| Activity log | WORKING WITH CAVEATS | A new employee generated one branch-scoped entry; branchless legacy history stays hidden and foreign-tenant staging refusal remains in [HR notes](../qa/oto-app-lift/org-hr-verification.md). |

| Attendance and operations | State | Current staging evidence and limit |
| --- | --- | --- |
| Kiosk devices and reception | NOT YET VERIFIED | Kiosk upload and failed-attempt guards have narrow staged/local proof; a complete configured-device reception action remains in [kiosk notes](../qa/oto-app-lift/README.md). |
| Face clock-in | DISABLED ON STAGING | The owner chose to keep the module behind an off flag; enrolment is deferred until enabled in the [closure plan](../qa/oto-app-lift/closure-plan.md). |
| PIN and phone clock, timekeeping | NOT YET VERIFIED | Existing route/evidence checks do not yet prove each enabled clock method, shift review and branch denial on staging; [file notes](../qa/oto-app-lift/files.md). |
| Scheduling | WORKING WITH CAVEATS | Week and My Shifts actions work, and short shifts now omit invalid generated breaks; restricted-branch proof and the no-group shift-row 500 remain in [schedule notes](../qa/oto-app-lift/scheduling.md). |
| Leave and holidays | WORKING WITH CAVEATS | Annual leave and a holiday saved; Bangkok date/conflict checks pass. Explicit approval fails closed with 503 until approval state is persisted; [leave notes](../qa/oto-app-lift/leave-holidays.md). |
| Tasks and ops board | WORKING WITH CAVEATS | A task was created and completed, with second-tenant/branch refusals; recurrence and wider board states remain in [task notes](../qa/oto-app-lift/tasks-checklists.md). |
| Checklists and media | WORKING WITH CAVEATS | A run completed and its private image matched uploaded bytes; same-tenant restricted-branch proof needs a safe identity in [checklist notes](../qa/oto-app-lift/tasks-checklists.md). |
| Announcements | WORKING WITH CAVEATS | Targeted publication/read and tenant/branch refusals passed; scheduled delivery and broader notification states remain in [announcement notes](../qa/oto-app-lift/announcements.md). |
| In-app notifications | WORKING WITH CAVEATS | A task notification changed from unread to read for its recipient; cross-tenant isolation remains in [notification notes](../qa/oto-app-lift/notifications.md). |
| Attention engine | DISABLED ON STAGING | Existing alerts can be read with a visible pause; Refresh, Snooze, Resolve and automatic writes are off until tenant backfill and durable job ownership exist. [Pause proof](../qa/oto-app-lift/attention-org-staging-dfe7153.md). |
| Fix reports | WORKING WITH CAVEATS | A positive report/media slice exists; named action capture and denied branch/tenant proof remain in [file notes](../qa/oto-app-lift/files.md). |
| Supplier portal | NOT YET VERIFIED | Invalid-link and anonymous refusals are staged; positive comment/close needs a safely removable report fixture in [supplier notes](../qa/oto-app-lift/supplier-portal.md). |

| Park, events and check-in | State | Current staging evidence and limit |
| --- | --- | --- |
| Events core | WORKING WITH CAVEATS | Restricted manager routes read own event and refused another branch; broader event action and POS seam remain in [event notes](../qa/oto-app-lift/events-camps.md). |
| BEO | WORKING WITH CAVEATS | A private BEO PDF and a saved/read timeline step were staged; package/menu workflow and named restricted-refusal proof remain in [event notes](../qa/oto-app-lift/events-camps.md). |
| Packages and menus | NOT YET VERIFIED | Both empty pages loaded, but no template save/use was staged; tenant-wide soft-delete requires safe cleanup; line-item scope repair is live with signed-in missing-parent 404 and anonymous 401 checks. [Event notes](../qa/oto-app-lift/events-camps.md). |
| Camps and children | WORKING WITH CAVEATS | A second-tenant camp registration, attendance edit and removal worked with foreign-tenant refusal; wider flows remain in [event notes](../qa/oto-app-lift/events-camps.md). |
| Parent portal and RSVP | WORKING WITH CAVEATS | An anonymous RSVP saved and matched the event summary; public delivery and edit/language variants remain in [RSVP notes](../qa/oto-app-lift/parent-rsvp.md). |
| Drop-off and staff check-ins | WORKING WITH CAVEATS | Staff board showed a check-in and another branch was refused; full checkout/form action remains in [check-in notes](../qa/oto-app-lift/checkins.md). |
| Nanny booking | WORKING WITH CAVEATS | Reservation, overlap refusal, completion and invalid reopen passed; assignment and branch refusal remain in [booking notes](../qa/oto-app-lift/nanny-booking.md). |
| Public drop-off form builder | NOT YET VERIFIED | Local publish check exists; shared staging publish was paused because it changes a tenant-wide form and leaves translation/jobs without rollback. [Check-in notes](../qa/oto-app-lift/checkins.md). |
| Staff vouchers | NOT YET VERIFIED | OTO App directs staff to the central Console; Console ledger and till redemption are the active contract to verify end to end. [Module scan](../qa/oto-app-lift/module-entry-smoke.md). |

| Knowledge, administration and finance | State | Current staging evidence and limit |
| --- | --- | --- |
| SOP and Find | WORKS | A published SOP was revised and opened from Find; branch refusal and staff published-only behavior have separate proof. [SOP notes](../qa/oto-app-lift/sops.md). |
| Knowledge Base and files | WORKING WITH CAVEATS | FAQ publish/read, private image byte round-trip, PDF indexing to one chunk and a file-sourced Ask answer passed; lower-role file access and other file types remain in [knowledge notes](../qa/oto-app-lift/knowledge-ask-oto.md). |
| Training and quizzes | WORKING WITH CAVEATS | Module save, wrong/right attempts and 100% completion passed; restricted role/branch proof remains in [training notes](../qa/oto-app-lift/training-quiz.md). |
| Ask OTO and AI helpers | WORKING WITH CAVEATS | Synthetic questions returned KB/SOP and uploaded-PDF citations plus a refusal to show another branch's source; other helpers, thread behavior and title decision remain in [Ask notes](../qa/oto-app-lift/knowledge-ask-oto.md). |
| Casual workers | WORKING WITH CAVEATS | Create, assign/rate, deactivate and picker removal passed; an ungrouped shift row still returns 500 in [worker notes](../qa/oto-app-lift/casual-workers.md). |
| Payroll | WORKING WITH CAVEATS | Private CSV and payslip PDF matched stored bytes and anonymous reads were refused; staff/self-service and other exports remain in [payroll notes](../qa/oto-app-lift/payroll-files.md). |
| Xero sandbox | NOT YET VERIFIED | Staff access to finance/Xero routes was refused; a positive sandbox exchange needs a connected park account. Production Xero is outside this staging check. [Finance notes](../qa/oto-app-lift/finance-access.md). |
| Vault | WORKING WITH CAVEATS | A credential was saved, admin reveal audited, and staff reveal refused without exposing its value; branch-manager behavior remains in [vault notes](../qa/oto-app-lift/vault.md). |
| Directory API | DISABLED ON STAGING | Current service identity carries no tenant, so a safe multi-tenant contract is needed before use; [dependency review](../qa/oto-app-lift/directory-settings.md). |
| Data Admin | WORKING WITH CAVEATS | Credential-model exclusion has staged API/UI proof; operator denial and wider registry review remain in [admin notes](../qa/oto-app-lift/data-admin.md). |
| General files and private media | WORKING WITH CAVEATS | Scoped object, Fix and check-in photo slices have staged proof; other owner/media variants remain in [file notes](../qa/oto-app-lift/files.md). Existing and new shared photo links remain permanent. |
| Settings | DISABLED ON STAGING | Globally keyed legacy settings are not tenant-safe; an additive cutover and separate-tenant read/write proof are required. [Dependency review](../qa/oto-app-lift/directory-settings.md). |

| Cross-module gate | State | Required proof |
| --- | --- | --- |
| Object storage and PDFs | WORKING WITH CAVEATS | Signed contract, letter and BEO PDFs plus private employee/payroll files have staged round-trips; remaining reader and module paths are in [PDF notes](../qa/oto-app-lift/contracts-pdfs.md). |
| POS read seams | NOT YET VERIFIED | Platform `otoapp_v` views and a POS read test are still required by the [closure plan](../qa/oto-app-lift/closure-plan.md). |
| Scheduled jobs and Health/Failures | NOT YET VERIFIED | Durable job ownership, two successful runs and one forced failure need staging evidence; [closure plan](../qa/oto-app-lift/closure-plan.md). |
| Structure-only restore and full CI | NOT YET VERIFIED | Scratch restore rehearsal and actual workspace CI jobs are required. Recent wrapper success skipped Typecheck, Lint, Test and Build; [acceptance index](../qa/SPRINT_2_ACCEPTANCE.md). |
| Desktop and park-tablet pass | NOT YET VERIFIED | Complete module actions, access refusals and blocking UI states must be checked at both widths; [acceptance index](../qa/SPRINT_2_ACCEPTANCE.md). |

S2-17c contract features remain a separate follow-on scope; they do not turn an
unfinished S2-17b module into a completed one.

## Decisions still needed
- Whether Ask OTO conversation titles must persist; that would need an
  additive platform column. See [knowledge notes](../qa/oto-app-lift/knowledge-ask-oto.md).
- A connected Xero sandbox account for the positive exchange. The face-clock
  staging decision is already settled: it stays off behind its flag.
- Safe restricted-role staging identity without sending setup messages, plus
  the platform contracts and restore proof listed in the [closure plan](../qa/oto-app-lift/closure-plan.md).
