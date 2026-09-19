# Agency proposal - "Oto Project Plan" (Viable)

| | |
|---|---|
| Source | https://oto-proposal.viable.sg/ (sub-pages cited per section) |
| Captured | 2026-09-20 |
| Author of the source | Viable (agency), for OTO Park |
| What it is | The agency's proposal to the client: a 20-week plan of 121 user stories across 24 features, 33 workflows, 11 technical "aspects", an architecture page and a role model. |
| Relationship to the live system | The live **OTO App** (Express + React, exported to `imports/oto-app/`, analysed in `docs/architecture/intake-2026-09-19/01-oto-app-backend.md` and `02-oto-app-frontend.md`, summarised in `docs/features/oto-app.md`) is the built form of the proposal's "Existing functionality" and (partly) "Foundation" stories. Nothing under "New functionality" exists in that export. |
| Precedence | `docs/briefs/OWNER_DIRECTION.md` wins on any conflict with this document. This document is the source for **"what the contract still owes"** (Section 6). |
| Not recorded | The site has no pricing, bank, contact or personal details. Nothing of that kind was found, so nothing was omitted. |

**How it was captured.** The site is a prerendered SvelteKit page set hosted on
Fly.io. The eight navigation pages, 24 feature pages, 33 workflow pages and
11 aspect pages were fetched as HTML. The 121 story detail pages answer
`405 GET method not allowed` to a plain request (each story route only has a
server-side POST action for a "Save feedback" form, gated by
`PUBLIC_ENABLE_STORY_FEEDBACK`), so their content was taken from the client
data bundle `/_app/immutable/chunks/BKMita2X.js`, which holds the complete
dataset (`project`, `userTypes`, `features`, `journeys`, `stories`,
`aspects`, `architecture`, `sitemap`, `weeks`). Probes of `/modules`,
`/timeline`, `/pricing`, `/scope`, `/phases`, `/status`, `/team`, `/faq`,
`/overview` and `/sitemap.xml` return 404. An unlinked `/sitemap` page exists
and is recorded in Section 1.8. Each story carries a `provenance` record
naming its source document: "Oto complete functionality analysis" (Phase 1 =
existing app, Phase 2 = POS and hardware) or "Oto Development Plan PDF (takes
precedence for messaging behavior)".

**Observation.** The proposal's Foundation, member and catalog stories match,
title for title, the Sprint 1 tickets in `CLAUDE.md` (SCRUM-19 to SCRUM-37).
Sprint 1 of this platform therefore already implements those stories on the
new stack (see `docs/progress/SPRINT_1_REPORT.md`); Section 2 notes this per
story but grades against the OTO App export, as asked.

---

## 1. Proposal structure

The site's own order. Every page uses the same header navigation:
Overview, Roles, Features, Workflows, Stories, Aspects, Architecture,
Roadmap.

### 1.1 Overview - `/`

Title "Oto Project Plan". One sentence of scope: "Oto is used to manage
staff, daily operations, events, people administration, and branch sales."
Then a contents grid linking the seven sections with one-line descriptions
(Roles: "Account roles and external participants"; Features: "grouped into
foundations, existing features, and new venue features"; Workflows: "Steps
for tasks that use more than one feature or involve more than one person";
User stories: "Individual requirements, acceptance criteria, and delivery
week"; Aspects: "Authentication, authorization, privacy, audit, files,
integrations, accessibility, recovery, data, operations, and hardware";
Architecture: "The web application, API, database, file storage, external
services, and branch equipment"; Roadmap: "The stories planned for each of
the 20 weeks").

### 1.2 Roles - `/users`

Two groups. **Account roles** (six): Platform Administrator, Operator
Administrator, Branch Manager, Line Manager, Staff Member, Advisor. **Customers
and external participants** (four): Member / Customer, Parent / Guardian,
Guest / Invitee, Pending Staff Member. Each entry has a one-sentence
description, a "What they do" list and an "Access limits" list. Detail in
Section 5.

### 1.3 Features - `/features` and `/features/<id>`

24 features in three groups: **Foundations** (2), **Existing functionality**
(7) and **New functionality** (15). Each feature page shows the description, a
scope badge, "What it provides" (its stories with one-line summaries), "Used
by" (roles) and "Related requirements" (aspects). Inventory in Section 2.

### 1.4 Workflows - `/workflows` and `/workflows/<id>`

33 workflows ("journeys") in five groups: Accounts and administration (3),
People and employment (4), Daily operations (7), Events and public services
(3), Sales and admissions (13), Installed hardware (3). Each page shows a
"Starting point" (trigger), numbered "Steps", "Participants" and "Features
involved". The Sales-and-admissions and Installed-hardware groups are the
POS scope; their steps are reproduced in Section 2 where they add detail.

### 1.5 Stories - `/stories` and `/stories/<id>`

121 stories, filterable by user type and feature. Each story has a title,
summary, description, acceptance criteria, user types, feature, workflows,
related aspects, a scope badge (Foundation / Existing functionality / New
functionality) and a delivery week linking to the roadmap. The site shows no
"built / in progress / planned" status; the only markers are the scope badge
and the week. Story pages carry a feedback form ("Notes or requested
changes", "Save feedback", "Save and next") when enabled, so the site was
also the review tool for the client's comments (see Section 7, Q1).

### 1.6 Aspects - `/aspects` and `/aspects/<id>`

11 cross-cutting requirement pages: Audit and monitoring, Authentication,
Authorization, Service availability, Files and media, Hardware, Integrations
and messages, Accessibility and locale, Transaction safeguards, Data and
reporting, Privacy and tenancy. Each has Scope, Design, Failure handling,
Requirements and Verification. Summarised in Section 4.

### 1.7 Architecture - `/architecture`

A diagram of seven nodes with responsibilities and boundaries: People and
stations; SvelteKit BFF; Python domain API; AWS PostgreSQL; Private object
storage; External services; On-premises branch service. Summarised in
Section 4.

### 1.8 Roadmap - `/roadmap`

"20-week roadmap - The planned order of work." Twenty week blocks, each with
a one-sentence intent and its stories grouped by scope badge with their user
types. No dates, no milestones, no deliverables other than the stories.
Reproduced in Section 3.

### 1.9 Unlinked page: `/sitemap`

"Application site map - Pages and navigation in the Oto application." Nine
top-level areas: Public & Identity; Core; Ops; Events; Studio; HR; Setup &
Access; **Phase 2 - Oto POS**; **Phase 2 - Hardware Operations**. The first
seven mirror the live app's shells. The two Phase 2 areas list the intended
POS navigation: Member Lookup & Saved Children; Ticket Sales & Checkout
Records (Pricing & Holiday Mode; Tax & Service Charge; Split Payment /
Discounts / Refunds); F&B Ordering & Preparation; Wallets & Promo Vouchers;
Bands / Gate / Live Occupancy; Drop-off / Nanny / Safe Release; Public
Booking & QR Redemption; Event Passes & Attendance; Stock Operations
(On-hand / Transfer / Replenish; Stock Take; Purchase / Receive); Customer
Messaging (Shared Inboxes; Active / Handled Conversations; Inbox Access &
Assignments; AI Classification & Routing; Message Translation); POS Reports
& Tax Export; Employee Benefits; POS Admin (Branch Catalog Clone; Tickets /
Menu / Tax / Supervision; Inventory / Promotions / Benefits; Devices / Print
Templates); Customer Display & Consent Capture; End of Day. Hardware
Operations: Scanner & Identifier Resolution; Receipts / Preparation /
Wristbands; Branch-local Print Routing; Self-service Redemption.

Note: "Customer Display & Consent Capture", "End of Day" and "POS Reports &
Tax Export" appear only on this sitemap; no story or feature covers them
explicitly.

---

## 2. Module and feature inventory

One table per feature, in the site's order within each group. Columns:

- **Story** - the story title as shown on the site.
- **Proposal wording** - the story summary (close paraphrase or short quote).
- **Marker** - the site's scope badge and delivery week. The site has no
  built/in-progress status marker.
- **Assessment** - against the OTO App export in `imports/oto-app/`:
  **Built** (the acceptance criteria are substantially met), **Partial**
  (the screen or route exists but named criteria are missing), **Unbuilt**
  (nothing in the export), **Unknown** (could not tell from code reading).
  Paths are relative to `imports/oto-app/`. "S1" means the story is also
  delivered on the new platform in Sprint 1.

### 2.1 Foundations

#### Accounts and access - `/features/feature-identity-and-access`

"Sign in, sign out, reset a password, create user accounts, and assign access
by operator, branch, department, and role."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Sign in by phone number | Phone is the required primary identifier; `0812345678` with Thailand selected looks up `+66812345678`; email optional; unknown phone, wrong password and disabled account show identical error text | Foundation, wk 1 | **Partial** - login accepts a `+E.164` phone or an email plus password (`server/auth.ts:56-75`, `client/src/pages/auth-page.tsx`); no country selector or local-format normalisation; error-text parity unverified. S1 (SCRUM-19). |
| Recover a forgotten password securely | SMS code to the verified phone, choose a new password, return to sign-in | Foundation, wk 3 | **Built** - `/forgot-password` with Twilio Verify (`client/src/pages/forgot-password-page.tsx`, `server/auth-otp-routes.ts`). S1 (SCRUM-23). |
| Complete staff account setup | Required password change and phone verification block protected pages until done | Foundation, wk 1 | **Partial** - `/change-password` and `/verify-phone` exist, but `mustChangePassword` is not enforced on the server (`01-oto-app-backend.md` s3). S1 (SCRUM-20). |
| Manage profile photo and account details | Account page shows name, normalised phone, optional email, photo, linked employee; permitted fields editable | Foundation, wk 3 | **Built** - `/my-account` with camera capture (`client/src/pages/my-account-page.tsx`). S1 (SCRUM-25). |
| Sign out | "Signing out ends the current session" | Foundation, wk 2 | **Built** - `/logout` (`server/auth.ts`). S1 (SCRUM-24). |
| Create a staff account and assign access | Create or link an account to an employee or advisor; one or more roles, each showing its operator, branch or department scope | Foundation, wk 1 | **Partial** - `/users`, the employee "Enable Login" wizard and `/advisors` exist (`02-oto-app-frontend.md` s3); roles are the coarse `admin/manager/staff` with branch scope only; no department scope, no multi-role assignment. S1 (SCRUM-21). |
| Review and change effective permissions | Assign and remove roles and scopes; each effective permission shows `service:resource:action` and its scope | Foundation, wk 1 | **Partial** - `/permissions` (per-person module switches) and `/settings/permissions-debug` exist, but permissions are 11 module toggles, not `service:resource:action`, and overrides change tabs rather than authorisation (`shared/permissions.ts`; `02` s3). S1 (SCRUM-22). |

#### Platform administration - `/features/feature-platform-administration`

"Manage operators, branches, login users, settings, and integration access."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Manage operators, branches, and administrators | Create and archive operators; assign branches and administrators; archived operators leave active selection | Foundation, wk 1 | **Partial** - `/operators` (tenant > operator > branch; assign branches and users) and `/branches` exist (`client/src/pages/operators-page.tsx:38-116`); operator archive not found. S1 (SCRUM-27). |
| Manage login users | Search by name, phone, email or role; edit identity, role, branch access, active status; temporary password forces change at next sign-in | Foundation, wk 2 | **Partial** - `/users` covers search, create, edit, activate, deactivate and reset (`client/src/pages/users-page.tsx`); temporary passwords use `Math.random` and the forced change is not enforced server-side. S1 (SCRUM-28). |
| Configure AI settings | Model identifier and prompt text persist across reload | Existing, wk 13 | **Built** - `settings` rows `ai_*_advice`, `ai_*_output_format`, `ai_event_extraction_model` edited on `client/src/pages/settings-page.tsx`. |

### 2.2 Existing functionality

#### Timekeeping - `/features/feature-check-in-and-timekeeping`

"Clock employees in and out, review attendance, correct exceptions, and
preserve an accurate attendance record." (The feature also carries the three
guest check-in stories.)

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Operate the reception kiosk | Activate a managed device for a branch; header shows that branch and only its enabled check-in actions; deactivation ends access | Existing, wk 11 | **Built** - `/kiosk/reception` with code exchange and 30-day bearer session (`client/src/pages/kiosk/reception.tsx`, `server/kiosk-auth.ts:133-257`). |
| Submit a public guest or service check-in | Public branch form: contact, one to six children with age, allergy/medical, food consent, parent-child photo, signature, confirmations; creates a parent check-in and one service check-in per child | Existing, wk 11 | **Built** - `/checkin/:branchId/:token` (`client/src/pages/public/checkin-form.tsx`, `server/checkin-routes.ts`); multi-language. |
| Manage drop-off nanny and camp check-ins | Search arrivals or create walk-ups; record service, restrictions, assigned care; check-out stores recipient and time, corrections keep both values | Existing, wk 7 | **Built** - `client/src/pages/core/checkins.tsx` (drop-off, nanny, camp tabs; pickup photo at `:1080`). Parent and child are free text (`02` s8). |
| Clock in and out at a kiosk | Identify at an activated kiosk; record clock-in or clock-out in branch time | Existing, wk 15 | **Built** - `client/src/pages/kiosk-page.tsx` (face, then phone keypad + photo fallback); kiosk assumes +07:00 (`:507`). |
| Submit missed or unscheduled attendance | Reason plus photo or document; no change until a manager approves | Existing, wk 17 | **Partial** - missed and unscheduled flows exist in `kiosk-page.tsx`; evidence attachment on the request not verified. |
| Enroll and manage face identity evidence | Consent before capture; permitted managers open and remove evidence; non-biometric method still works after removal | Existing, wk 14 | **Built** - QR enrolment with consent (`kiosk-page.tsx:601-705`), AWS Rekognition, `deleteFace` (`server/face-recognition.ts`), PIN/phone fallback. Owner decision pending on biometrics (`OWNER_DIRECTION.md`). |
| See who is currently at work | Present employees per branch, stale/uncertain flag, schedule context, notification pending/delivered/failed | Existing, wk 15 | **Partial** - `/timekeeping/live` (`client/src/pages/timekeeping-live-page.tsx`) and `/api/avatar-status`; a "notified" state exists, the three delivery states were not found. |
| Review and correct timekeeping | Inspect issues and evidence by day or employee; corrections never erase original events | Existing, wk 15 | **Built** - `/timekeeping-review`, `server/timekeeping-deriver.ts`, `/api/timekeeping/*` (12 routes). |

#### Daily operations - `/features/feature-daily-operations`

"Show announcements, events, tasks, checklists, and items that need
attention."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Change branch and open permitted work areas | Choose an assigned branch; unassigned work areas do not appear | Existing, wk 2 | **Built** - branch switcher (`client/src/hooks/use-branch-context.tsx`) and mode switcher; client-side only, no server "active branch". |
| Review today's announcements and events | Scoped announcements; event times in branch timezone; unassigned-branch event denied | Existing, wk 4 | **Built** - `client/src/pages/core/today.tsx:123-213`; `Asia/Bangkok` hard-coded (`:395, 676`). |
| Create and complete a quick task | Task for a branch or department, appears in the queue, assignee completes | Existing, wk 5 | **Built** - `server/core/tasksRoutes.ts`, Today page. |
| Open and update task detail | Assignees, due time, questions, comments, attachments, evidence, recurrence, completion history; read-only users see no add controls | Existing, wk 5 | **Built** - `client/src/pages/ops/index.tsx` task detail. |
| Execute an ordinary or checker checklist | Ordinary items with required note or photo; checker pass/fail with failure note and photo gating Complete | Existing, wk 17 | **Built** - `client/src/pages/core/checklist-run.tsx` (`requiresPhoto`, `requiresNote`), checker mode in six files. |
| Manage the Ops board | Filter by task, checklist, recurring, announcement; calendar, Kanban, list and activity open the same record | Existing, wk 18 | **Built** - `client/src/pages/ops/index.tsx` (2,744 lines). |
| Author one-off and recurring task templates | Once or repeating; assign to branch, employee, role or department; due dates, questions, evidence | Existing, wk 5 | **Built** - `client/src/pages/studio/tasks/*`, `server/core/taskGeneration.ts`. |
| Author reusable checklist templates | Ordered items, checker rules, questions, photo requirements; publish and archive | Existing, wk 17 | **Built** - `client/src/pages/studio/checklists.tsx`. |
| Publish scoped announcements | All users or selected branch/department audiences; information, warning, urgent; start and end dates | Existing, wk 2 | **Built** - `server/core/announcementsRoutes.ts`; `priority`, targets, `start_at`, `expires_at` in `server/db/coreSchema.ts`. |
| Open related work from notifications | Notification shows the referenced title and identifier; opens the record; mark one or all read | Existing, wk 13 | **Built** - `client/src/components/notification-bell.tsx`, `/api/notifications/mark-all-read`; opening does a full reload to `/ops?taskId=`; 10 task-related types only. |

#### Events, camps and public experiences - `/features/feature-events-and-public-experiences`

"Create events, parties, and camps; manage bookings and payments; collect
guest responses and menu choices; and run the event."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Configure event products and locations | Statuses, locations, birthday packages with entertainment, setup items, set menus; deactivated items leave selectors | Existing, wk 4 | **Built** - `client/src/pages/studio/event-settings.tsx`, `server/birthday-package-routes.ts`. |
| Browse events in list Kanban and calendar | Search, branch and type filters; active vs archived | Existing, wk 12 | **Built** - `/studio/events/list`, `/kanban`, `/calendar`. |
| Create and edit a birthday event | Party, child/parent, guests, branch, date/time, value, deposit, remaining amount, tasks, AI-assisted details, generated event document | Existing, wk 6 | **Built** - `client/src/pages/studio/events.tsx` (3,967 lines); AI extraction model from settings; BEO PDF. |
| Create and edit a one-off event | Schedule, location, description, information blocks, bookings, payment and check-in settings | Existing, wk 6 | **Built** - same editor; info blocks present. |
| Create and edit a multi-day camp | Date range, per-day time and host, cancelled days, capacity, registration settings | Existing, wk 19 | **Built** - `events.tsx` plus `client/src/pages/studio/camp-detail.tsx`. |
| Plan BEO and day-of execution | Timeline, assignments, notes; separate Setup, Kitchen, Bar, POS sections; assigned staff mark a section complete | Existing, wk 19 | **Built** - `client/src/components/beo/*`, `server/beo-routes.ts` (93 routes). "POS" section is a copy-and-paste "POS Entry Checklist" (`02` s8). |
| Manage event bookings arrivals and payments | Add, edit, cancel; attendee counts, arrival, total, paid, method, date, source channel, POS reference | Existing, wk 11 | **Built** - `studio_event_bookings` (`server/db/coreSchema.ts:2035-2057`); payment fields are manual. |
| Manage party invitations | Organiser creates, previews, monitors responses, revokes links | Existing, wk 6 | **Built** - `server/parent-experience-routes.ts`, `/parent/:token`, invitation wizard. |
| Respond to a guest invitation | Guest submits attendance, party size, contact, dietary details | Existing, wk 12 | **Built** - `/rsvp/:token` (en/th/ru/zh). |
| Select menus through a public link | Only offered options; choices land in the kitchen plan | Existing, wk 10 | **Built** - `/menu-select/:token`. |
| Register a child for camp | Parent registers children, pickup people, rules, health, consent, signature; **a matching phone triggers a six-digit code before saved family details are shown or changed** | Existing, wk 7 | **Partial** - `/camp-register/:eventId` exists with phone lookup, signature and photo, but the lookup is unauthenticated and returns children's names, dates of birth, allergies and photos without any code (`client/src/pages/public/camp-register.tsx:449`; security fix listed in `docs/features/oto-app.md`). The six-digit gate is not built. |
| Manage camp children and attendance | Registrations with medical alerts; daily arrival and departure; checkout stores pickup person, staff and time | Existing, wk 19 | **Built** - `camp-detail.tsx` (`attendanceDays`, `PickupPersons`), `/api/core/camp-checkins/*`. |
| Generate and publish drop-off forms | Labels per language, preview per language, published version reaches the public link, old submissions keep their questions | Existing, wk 7 | **Built** - `client/src/pages/core/form-builder.tsx` (en/th/ru/zh), `server/dropoff-form-routes.ts`. |

#### Help, knowledge and issue resolution - `/features/feature-fix-and-guidance`

"Search procedures, ask questions against the knowledge base, report
problems, and track repairs."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Submit a Fix report with media | Branch, category, location, urgency, description, optional photo or video | Existing, wk 20 | **Built** - `client/src/pages/core/fix.tsx`, `/api/fix-reports`. |
| Review my submitted Fix reports | Search own reports; media, status, ownership, activity | Existing, wk 20 | **Built** - `fix.tsx`. |
| Triage and resolve the Fix Board | Filter queues, assign, comment, change status, complete; visible history | Existing, wk 20 | **Built** - `client/src/pages/core/fix-board.tsx`; department-gated queues; supplier portal `/supplier/:token`. UI statuses differ from the DB enum (`.agents/memory`). |
| Search and browse SOP knowledge | Search title or body within audience; department filter; cover, summary, reading time | Existing, wk 9 | **Built** - `/core/find`, `/core/sop/:id`, `/api/sops`. |
| Ask OTO with cited answers | Answer lists a cited article and its ordered steps; media only when the user can open the article | Existing, wk 9 | **Built** - `client/src/pages/core/ask.tsx` ("Sources"); keyword scoring in memory, no embeddings (`01` s4). |
| Create and publish SOP knowledge | Create, review, publish to an audience, archive, restore, review revisions | Existing, wk 9 | **Partial** - `/studio/kb` authors SOPs (including generation from a PDF); only `/api/sops` and `/api/sops/:id` exist, no revision, archive or restore routes found. |
| Manage knowledge files | Upload, processing status, process again, delete | Existing, wk 13 | **Built** - `/studio/kb/files`; `/api/knowledge-files/upload`, `/:id/reindex`, `/:id/chunks`. |

#### People and employment - `/features/feature-people-and-employment`

"Manage employees and advisors, organization assignments, reviews,
movements, contracts, letters, assets, and offboarding."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Configure organization structure | Branches, departments, roles, locations, assignments, hierarchy | Existing, wk 3 | **Built** - `/branches`, `/departments`, `/locations`, `/roles` (44 org routes). |
| Create import and edit employees | Create/edit; spreadsheet import previews New, Changed, Unchanged, Invalid, Matched; results Created, Updated, Matched, Failed | Existing, wk 3 | **Partial** - `/employees`, `/employees/:id` (4,927 lines), `/employees/bulk-upload`; the preview only distinguishes new/created/updated (`client/src/pages/bulk-employee-upload-page.tsx`). |
| Manage casual workers and advisors | Identity, rate, assignment, status, login, lifecycle; inactive workers leave selectors | Existing, wk 4 | **Built** - `/employees/casual` (`server/casual-worker-routes.ts`), `/advisors`. |
| View HR dashboard and attention | Scoped metrics, recent activity, rule-generated attention items with drill-down | Existing, wk 14 | **Built** - `/dashboard`, `/attention`, `server/attention-engine.ts` (about 22 rules). |
| Run reviews and staff movements | Review cycles with completion date; effective-dated branch/department/role/status movements with approvals and history | Existing, wk 14 | **Built** - `/reviews`, `/staff-movements`; an explicit approval step was not found (Unknown). |
| Explore and maintain the org chart | Current structure, simulate changes, reject cycles | Existing, wk 16 | **Built** - `/org-chart`, `server/orgChartRoutes.ts` ("Structure Lab") with cycle validation. |
| Author employment templates and policies | English and optional Thai templates; branch assignment; policy publish and archive | Existing, wk 10 | **Built** - `/templates` (TipTap, Thai), `/policies`, `/api/template-assignments`. |
| Generate and issue a contract or letter | Generate from employee and template, review, issue; signer link opens the same version | Existing, wk 11 | **Built** - `/contracts/new` wizard, `/api/contracts`, `/api/letters`, Puppeteer PDFs. |
| Review and sign an employment document | Signer verifies access, reviews, consents, signs, receives confirmation | Existing, wk 16 | **Built** - `/sign/:token`, `/letter-sign/:token`, signature pad. Signed PDFs are served without login (security fix). |
| Manage assets offboarding and departure | Departure date, asset and access recovery, required documents, account closure | Existing, wk 14 | **Built** - `/api/assets/*`, `/api/offboarding/*`, employee editor tabs. |
| Review the activity logbook | Search activity; each entry shows activity, record, user, time, before/after values | Existing, wk 17 | **Built** - `/activity-logbook`, `/api/activity-logs`; before/after values Unknown. |

#### Scheduling and availability - `/features/feature-scheduling`

"Record staff availability and leave, build branch rotas, resolve schedule
conflicts, and show personal and team shifts."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Capture employee availability and leave | Day-specific availability or time off; managers see it and conflicts while scheduling | Existing, wk 16 | **Built** - `/core/my-availability`, `/core/rota`, 23 leave routes. |
| Build a branch schedule | Week plans, rows, duties, breaks, role coverage, employee and casual assignments in branch timezone; review before publish | Existing, wk 8 | **Built** - `/scheduling` (6,431 lines), `server/break-generator.ts`, 62 schedule routes. |
| Use schedule templates and bulk tools | Save a week as a template per department or shift group; preview apply, clear, merge | Existing, wk 8 | **Built** - `ScheduleTemplate`, `clearWeek`, `Snapshot`/`restore` in `client/src/pages/scheduling-page.tsx`. |
| Review and resolve schedule conflicts | Overlaps and leave/day-off conflicts; apply resolutions; rescan; history and restore | Existing, wk 8 | **Built** - conflict scan, `shared/scheduling-validation.ts`, snapshot restore. |
| View personal and team schedules | Day, week, month; changes visible; managers see team coverage | Existing, wk 16 | **Built** - `/core/rota`, three-day compact view. |

#### Operational content - `/features/feature-studio-administration`

"Create and publish tasks, checklists, forms, procedures, and staff
vouchers." (Only three stories are filed here; task, checklist and form
authoring sit under other features.)

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Issue and view staff vouchers | Manager issues a voucher; staff see name, validity, remaining uses, QR; other accounts cannot open it | Existing, wk 12 | **Built** - `/studio/vouchers`, `employee-vouchers-section.tsx`, `/core/my-vouchers` with QR. Redemption (out of this story's scope) is broken in the client (`02` s10 #1). |
| Configure company signatory authority | Select the signatory and maintain the signature used on documents | Existing, wk 10 | **Built** - `settings` rows `md_signatory_name/title`, `md_signature_image`, applied at `server/routes.ts:6236-6247`. |
| Choose the department responsible for Fix reports | Choose the department per category or scope; preview recipients | Existing, wk 20 | **Partial** - `fix_department_id` routing exists (`server/routes.ts`, `settings-page.tsx`); a recipient preview was not found. |

### 2.3 New functionality

None of these exist in the OTO App export. Where a precursor exists it is
named; otherwise the row is Unbuilt. The workflow steps from `/workflows`
are quoted where they add rules not in the stories.

#### Child supervision and release - `/features/feature-child-supervision-and-release`

"Set the supervision type from the child age, record consent and visit
photos, check the child in, maintain the pickup list, and verify the
collector before release." Workflow: "Resolve age policy, capture visit
consent and photos, assign care, check in, message the guardian, verify an
authorized collector, and record release."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Set child supervision rules | Non-overlapping branch age bands for nanny, drop-off or none; adult presence inferred from paid adult tickets; resolution before payment; care fee added or waived while steps stay required; result stored on the registration | New, wk 6 | **Unbuilt** - no policy; drop-off and nanny prices are hard-coded labels (200 and 300 THB) in `client/src/pages/core/checkins.tsx`. |
| Register a child for supervised care | Service shown per child for the date; child and guardian photos; acknowledgements; siblings sharing nanny care pay one fee for the longest duration; accepted wording and time kept, photos hidden from customer surfaces | New, wk 6 | **Partial** - public check-in form captures child details, allergies, consent, parent-child photo and signature (`client/src/pages/public/checkin-form.tsx`); no supervision resolution, sibling fee rule or member link. |
| Check in a booked or walk-up supervised child | States booked, awaiting check-in, in-park, checked-out; prepaid booking does not resell; sibling waiver by permitted staff with rule recorded; nanny, food credit, band and timer set atomically | New, wk 7 | **Partial** - `checkins.tsx` checks in and out with nanny assignment; no state machine, booking link, band, timer or food credit. |
| Maintain authorized pickup people | Drop-off person auto-added; name, normalised phone, relationship, photo, status, source; editable at check-in, mid-stay, checkout; chat-photo promotion; full change history | New, wk 7 | **Partial** - camp registrations hold pickup persons (`studio/camp-detail.tsx`); drop-off checkout stores a recipient name; no per-person phone/photo/status/source history for drop-off. |
| Pick up a child | Known dropper-off follows the ordinary path; other collectors must be matched to the saved photo; unknown collectors blocked; add-collector-at-checkout or Decline release; record collector, verifier, time, source | New, wk 7 | **Partial** - checkout with recipient name and a camera pickup photo (`checkins.tsx:1080`); no photo-match verification, no decline path, no authorisation source. |
| Manage drop-off and event arrivals in one check-in board | Drop-off tab with the four states; Events tab with per-day rosters and counts; never merges branches; cannot create a free attendee or resell prepaid drop-off | New, wk 9 | **Partial** - the board covers drop-off, nanny and camp attendance; no event-roster tab or booked/awaiting states. |

#### Booking and admission redemption - `/features/feature-events-booking-and-redemption`

"Sell bookings and event passes, create attendee records, redeem each
booking once, print bands, and check guests in." Workflow (booking): "Select
member/children, tickets, supervision, event passes, confirmations,
language, and payment; then redeem one QR into bands, wallets, and
check-in."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Manage event attendees and daily attendance | One attendee shape (name, contact, date, attendance, check-in) across birthday, one-off, camp and flat-price events; camp per day; roster counts; party tab balance | New, wk 6 | **Partial** - camp per-day attendance and event booking guest counts exist; no unified attendee entity. |
| Sell a flat-price event pass | No member tier; attendee captured in the sale; admission, camp, event, F&B, retail, wallet credit and prepaid meals paid in full; birthdays take a deposit and keep a balance; camp/event walk-up requires payment; birthday walk-up charged to the party tab; no paid sale without an attendee | New, wk 12 | **Unbuilt** - no sales; bookings record amounts by hand. Deposit/outstanding derivation exists in `client/src/components/beo/beo-billing-module.tsx:217-246` as a precursor. |
| Check in an event attendee and print bands | Bypasses ordinary supervision fees; camp check-in per selected day; child band carries event/date and dietary alert; parent band only when attending; duplicate same-day check-in blocked | New, wk 12 | **Unbuilt** - no band printing. |
| Book admission online and receive a QR code | Unverified online customer gets Tourist pricing; no sibling-waiver control; saved children reconfirmed; paid "will-issue" bands and wallet grants recorded without issuing; QR unique, scoped, revocable, enumeration-safe | New, wk 12 | **Unbuilt** - no public booking. (The POS prototype has a `/book` mock; `CLAUDE.md` s6.) |
| Redeem a paid booking QR code | Redeemed, revoked, expired, wrong-branch or unpaid states disable Redeem; regular guests get bands and adult wallet grants; supervised children route into check-in; admission and drop-off items redeem separately; retries never duplicate | New, wk 17 | **Unbuilt**. |

#### Food and beverage ordering - `/features/feature-f-b-ordering`

"Scan a child wristband with a phone camera or search the menu, preload
stored child and food details, select modifiers, show allergy information,
take payment, and send items to the correct preparation printer."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Search and configure an F&B order | Parent and child categories; required single/multi modifier groups with min/max; option deltas multiply by quantity; tap a cart line to reopen its editor; line total = base + deltas x quantity | New, wk 10 | **Unbuilt** (POS prototype has a mock F&B tab). |
| Complete an F&B order | Per-line tax and service from the item's rule; only paid items sent; kitchen items only on the kitchen ticket, bar on the bar ticket, each with quantity, modifiers, notes, time, guest and allergy warnings; multi-station; corrections instead of erasure; print failure never duplicates order or payment | New, wk 14 | **Unbuilt**. |
| Start a child F&B order from a wristband | Phone camera scan opens the child record with name, credit balance, remaining prepaid meals, allergies and restrictions; band or wallet QR resolve the same visit and wallet; prominent allergy alert; F&B accounts see food restrictions but not other medical notes | New, wk 14 | **Unbuilt**. |

#### Gate access and occupancy - `/features/feature-gate-and-occupancy`

"Open the gate for valid adult bands and calculate occupancy from adult
entry, linked children, and supervised-child check-out records."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Issue adult and child entrance wristbands | Adult bands get gate rights only when the ticket allows; child bands never open a gate; both support F&B, wallet, guest and allergy scans; regular children link to their admission group; duplicate issuance blocked | New, wk 15 | **Unbuilt**. |
| View live occupancy by guest type | Adults from gate events; regular children stay while any linked adult is inside and leave with the last one; supervised children leave only on completed pickup, not on an exit scan; nobody counted twice | New, wk 15 | **Unbuilt**. |
| Resolve gate exceptions and end-of-day groups | Duplicate, expired, wrong-branch and impossible-direction scans show their reason and do not change occupancy; manual resolutions need operator and reason; end-of-day list of stranded adults, groups and supervised children; closure clears live counts but keeps history | New, wk 16 | **Unbuilt**. |

#### Inventory and purchasing - `/features/feature-inventory-and-purchasing`

"Track stock by location, count and transfer stock, create purchase orders,
receive deliveries, and report cost and shrinkage."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Configure inventory items variants and stock locations | Default or multiple variants; sellable merchandise/add-ons link to one item/variant; branch-scoped; pack conversion (1 case = 12 units, receipt of 2 cases = 24); par, reorder point, lead time, supplier, unit cost | New, wk 2 | **Unbuilt** (POS prototype has a mock stock module). |
| Transfer and replenish stock | Filter by location, item, category; transfer validates source; pack/unit to base units; below-par suggests transfer; every movement records source, destination, quantity, operator, time | New, wk 5 | **Unbuilt**. |
| Count stock and record the variance | Stock Take from the on-hand view; per location and variant; mismatch flagged; submission adjusts without approval; history keeps expected, counted, variance, reason, operator, time | New, wk 5 | **Unbuilt**. |
| Decide whether to transfer or reorder low stock | Reorder point creates a purchasing need; predictive threshold = consumption rate x lead time; stock elsewhere proposes transfer; one card, not duplicates; shows on-hand, reorder point, suggested quantity and rule | New, wk 5 | **Unbuilt**. |
| Order and partially receive supplier purchases | Expected arrival = order date + lead time; status change without receipt leaves quantities unchanged; receipt requires a destination; partial receipts stay open; received quantities update stock and history | New, wk 10 | **Unbuilt**. |

#### Members and visitor details - `/features/feature-members-and-shared-inputs`

"Find a member by phone number, record pricing-tier evidence, maintain saved
children and their allergies, and confirm the children attending each
visit." Workflow: "Use a phone number as the globally unique member identity
across branches"; "record branch-specific activity".

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Find a returning member by phone number | Country code searchable, defaults to Thailand; keypad and typed input normalise identically; bare Thai numbers become +66; duplicates prevented; lookup returns verified tier, children, channel, wallet identity, branch-labelled activity | New, wk 1 | **Unbuilt** in the export (no member, customer or child table; `02` s8). S1 (SCRUM-30). |
| Create and enrich a member | Phone and name only; enrichment keeps wallet, children, verification, bookings, history; concurrent-edit warning; field history with old value, new value, staff, time | New, wk 1 | **Unbuilt** in the export. S1 (SCRUM-31). |
| Apply verified customer pricing | Proof type, verifying operator, timestamp; unverified = Tourist; online cannot self-grant Expat or Thai; verification and expiry follow the member across branches; history shows changes and revocation | New, wk 3 | **Unbuilt**. (S1 created the `member_tier_verification` table only; UI deferred.) |
| Select and reconfirm saved children for a visit | Parent maintains allergies and food restrictions; "I do not know the birth year" accepts age, month and day; one date of birth stored, age computed per visit; no persistent visit photo; only children coming today proceed; each needs Confirm or Edit; new child saved unless the guardian opts out | New, wk 2 | **Partial** precursor only - `/studio/children` derives children from camp registrations with manual merge (`client/src/pages/studio/children.tsx:113-147`); no member link or per-visit confirmation. S1 (SCRUM-32). |

#### Customer messaging - `/features/feature-messaging`

"Bring WhatsApp and Instagram conversations into shared inboxes, route them
to permitted staff, connect them to customer context, and use AI for
classification, clarification, knowledge-based replies, and translation.
Additional messaging sources can be added later." Source: "Oto Development
Plan PDF (takes precedence for messaging behavior)".

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Connect customer conversations to Oto records | Source filter WhatsApp/Instagram; header shows source and customer name, handle or phone; link to customer, registration, booking or event; messages and media keep incoming/outgoing/delivery state; new sources join later | New, wk 9 | **Unbuilt** - no WhatsApp or Instagram API in the server; only `wa.me` links client-side (`01` s4). The owner's separate "Unified Inbox" work in progress (`imports/oto-asset-manager/`) is related but not this. |
| Work customer conversations in shared inboxes | Routing rules place a conversation in one inbox; access by role, department or manual assignment; shared view with latest assignee and status; assign, reply, mark Handled to archive | New, wk 8 | **Unbuilt**. |
| Use AI to understand and answer customer enquiries | AI classifies for routing, asks follow-ups when unclear, replies with direct quotations from Oto knowledge; AI replies distinguished from staff; Thai-English two-way translation with originals available; customer keeps their language | New, wk 8 | **Unbuilt** (OpenAI translation exists for parent surfaces only). |
| Configure messaging inboxes and routing | Create, edit, deactivate, reactivate inboxes; access by role, department, manual assignment; enquiry type to inbox mapping; editable AI guidance; routing changes do not rewrite history | New, wk 8 | **Unbuilt**. |
| Authorize pickup from a guardian-sent photo | Inbound media stays in the thread; approved photo copied to the registration with identity and relationship; source "from chat"; promotion does not release the child | New, wk 9 | **Unbuilt**. |

#### Sales and transaction records - `/features/feature-pos-operations`

"Review sales, refunds, corrections, unresolved transactions, and branch
activity recorded in Oto."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Review today's branch POS activity | Branch-local business date; each widget links to its work area; freshness on occupancy, unpaid/failed orders, arrivals, supervised children, rosters, stock attention; reception vs manager views; loading, empty, stale, partial-failure and permission states | New, wk 18 | **Unbuilt** - the existing Today page is operational (tasks, events, fix), not POS. |
| Search POS transaction and order history | Filters by date, member/phone, receipt, booking, band/QR, operator, status, payment method; detail links lines, split payments, tax decomposition, wallet/promo/benefit effects, stock moves, bands, refunds; historical totals frozen; refund and reprint entry points; branch-scoped; each lookup by phone, band or transaction id is logged | New, wk 18 | **Unbuilt**. |

#### Branch catalog - `/features/feature-pos-tenancy-and-catalog`

"Manage tickets, products, categories, prices, tax rules, service charges,
payment methods, promotions, and branch settings. A new branch can copy
another branch catalog." Workflow steps also require "Persist payments,
wallets, photos, messaging, face outcomes, counters, benefit usage, stock,
costs, occupancy, and issuance as records" and "Protect branch operations
and member/minor/photo/health/payment data on every direct operation".

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Clone a complete branch configuration | Clone includes tickets, menus, prices, tax, supervision, inventory setup, promotions, benefits, payment methods, print templates; fresh identifiers; a failed clone leaves nothing; no later synchronisation | New, wk 20 | **Unbuilt**. |

#### Pricing and checkout - `/features/feature-pricing-tax-and-checkout`

"Calculate ticket prices, tax, service charges, discounts, recorded payment
splits, and credits. Store the calculation used for each transaction."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Configure weekday weekend and holiday pricing | Every priced concept stores a weekday/weekend pair; holiday ranges named, inclusive, branch-specific and override the weekday; Saturday and Sunday are Weekend; POS shows mode and reason | New, wk 4 | **Unbuilt** in the export. S1 (SCRUM-36). |
| Configure a ticket package | Kid and adult prices vary by tier and rate mode; adult rule same-as-kid, set price, or free adults with overflow; credit for adult, child or both as full, fixed or percent; adult gate settings shown, child gate fixed off; no separate park-wide adult price | New, wk 3 | **Unbuilt** in the export. S1 (SCRUM-35) covers prices, included adults, overflow, wallet credit, duration, gate rights; the adult-rule variants and credit-grant modes should be checked against S1's model. |
| Quote a ticket package | Verified tier plus Weekday/Weekend/Holiday from the branch date; free adults consumed before overflow; wallet grant amount and beneficiary from the package's per-guest or per-booking rule; bands, supervision, tax, service, discounts, total; the sale keeps the quoted configuration | New, wk 4 | **Unbuilt**. |
| Configure branch tax and service rules | Per-branch tax and service; resolution product > category > branch; tax mode inclusive, exclusive, none; service percent and tax-on-service per category; discount placement before or after tax; checkout, receipt and export agree in whole satang | New, wk 4 | **Unbuilt** in the export (7% inclusive VAT is a constant in `shared/vat-utils.ts`). S1 (SCRUM-37) covers branch default plus category and product overrides; tax mode, tax-on-service and discount placement should be checked. |
| Record one or more payment methods | Branch-activated methods appear in every selector with one saved label and icon; parts sum exactly to the amount due; staff confirm the payment was handled externally before wallets, stock or issuance move; history shows who recorded what | New, wk 11 | **Unbuilt**. **Conflicts with owner direction** (SCB QR gateway and EDC ECR integration; see Section 7, Q3). |
| Apply a manual discount | Line or order scope; discount limit with manager override; recalculates from the current saved price; tax placement per branch; reason and operator required | New, wk 11 | **Unbuilt**. |
| Credit all or part of a paid transaction | References the original sale and method; tax and service reversal matches the original; wallet reversal and stock restoration only where applicable; partial and full limits; reason, staff and resulting balances | New, wk 19 | **Unbuilt**. |

#### Receipts, tickets and wristbands - `/features/feature-printing-and-output`

"Produce customer receipts, preparation tickets, wristbands, and wallet
vouchers and route each output to the applicable installed printer."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Assign branch printers | Child bands to the child-wristband printer; adult and kiosk bands to the adult-wristband printer; main-counter receipts to the main receipt printer; kitchen, secondary-counter and bar to their preparation printers; staff see when a printer rejects output | New, wk 16 | **Unbuilt**. (Device roles are documented in `docs/architecture/DEVICE_INVENTORY.md`.) |
| Print a receipt that matches the completed transaction | Branch, transaction id, time, items, discounts, service, VAT, gross, operator; each split, wallet, promotion, benefit, refund and outstanding amount equals the record; labelled reprints in output history with a reason for sensitive cases; print failure never changes payment state | New, wk 18 | **Unbuilt**. |
| Print adult and child wristbands and wallet vouchers | Adult and child bands distinguishable; gate rights only on adult bands; child bands print food allergy warnings; only enabled fields print (name, validity, event, warning, supervision badge, nanny); opaque machine-readable identifier; voucher links to the same wallet; no staff-only photos or health/contact/payment data; print and handoff status recorded separately | New, wk 18 | **Unbuilt**. |

#### Reporting and employee benefits - `/features/feature-reporting-and-benefits`

"Report sales, tax, wallet balances, promotions, stock cost, and payment
settlement. Apply employee and owner benefits and record their use."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Review branch sales and ticket mix | Categories tickets, F&B, merchandise, events, drop-off, add-ons; tickets split by type, verified tier, weekday/weekend and holiday reason; F&B and merchandise by item/variant; refunds negative, voids zero; cross-branch totals keep branch identity | New, wk 19 | **Unbuilt** - `/analytics` shows Xero tables only; POS revenue lives in Pisell/Papaya and Radar today. |
| Review wallet liability, promotions, and comps | Issued, spent, refunded, expired, outstanding; outstanding labelled a liability; promo redemptions and foregone amount by code; manual discounts and staff/manager/owner benefits kept separate; totals reconcile to allocation rows | New, wk 19 | **Unbuilt**. |
| Configure an HR-linked benefit profile | Person or role template; free-item quantities, credit values, discount percentages, eligible categories, daily or monthly periods (examples: two free coffees per day plus 10% off; THB 5,000 monthly manager credit plus 10%); benefit QR resolves the beneficiary without granting access; person override beats role; effective dates and history | New, wk 10 | **Partial** precursor only - staff voucher templates and assignment (`client/src/pages/studio/vouchers.tsx`, `employee-vouchers-section.tsx`) issue vouchers with remaining uses; no free-item, credit or standing-discount profiles. |
| Use staff benefits at checkout | Whole-bill comp first, then periodic free items, then periodic credit, then standing discount; daily allowance resets; concurrent attempts on the last use yield exactly one; owner comp and all usage record beneficiary, operator, transaction, items, amount | New, wk 17 | **Unbuilt** - the server has `/api/core/vouchers/redeem` and `/lookup/:token` (`server/voucher-routes.ts:433, 509`) but no client and no POS. |

#### Scanning and identifiers - `/features/feature-scanning-and-identifiers`

"Read wristband and QR codes, identify the referenced booking, guest,
wallet, or benefit, and reject expired or duplicate codes."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Scan a wristband, voucher, or booking code | Zebra DS22 (USB HID) delivers one complete code without keystrokes into fields; the same identifier from Gate, F&B, Booking, Event and Benefit entry points opens the matching context; unknown, expired, revoked, wrong-branch, wrong-purpose or used codes show the reason with a masked identifier; rapid duplicates never repeat a consequential action; a corrected scan is processed fresh | New, wk 15 | **Unbuilt** - scanning exists only on the timekeeping kiosk (QR enrolment, `kiosk-page.tsx:14, 631`). |

#### Self-service admission - `/features/feature-self-service-hardware`

"Allow a customer to scan a paid booking at a kiosk, print eligible bands,
and send supervised-child cases to reception."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Redeem a booking at the self-service kiosk | Booking must be this branch, paid and unredeemed; regular bands and wallet credit issued once; supervised children cannot bypass staff steps; mixed bookings issue the self-service item and show the staff desk for the rest; device failure never marks handoff | New, wk 18 | **Unbuilt**. |

#### Wallets and promotions - `/features/feature-wallets-and-promotions`

"Let an adult prepay and load credit or specific meals onto a child
wristband for restaurant use. Expire unused value at the end of the day,
retain its history, and allow staff reactivation. Apply promotions
separately from wallet value."

| Story | Proposal wording | Marker | Assessment |
|---|---|---|---|
| Load credit or meals onto a child wristband | Credit amount, specific meals, or both; granted once on accepted payment, unchanged on rejection; ticket credit rules set grant and beneficiary; band and QR are alternate keys to one wallet; grant history with adult, child, sale, entitlement, expiry, time, operator; balance is a liability | New, wk 13 | **Unbuilt**. |
| Pay with a wristband or wallet QR code | Band and QR resolve the same balance; two concurrent spends of the last balance yield one success and zero, never negative; one debit visible in wallet history and payment details; retry never double-deducts; child prepaid food uses the same wallet | New, wk 13 | **Unbuilt**. |
| Expire and reactivate unused wristband value | Automatic end-of-day expiry of credit and meals; history retained; reactivation by permitted staff with amount or meals, reason, time and new expiry; reports separate grant, spend, refund, expiry, reactivation, outstanding | New, wk 13 | **Unbuilt**. |
| Configure and redeem a promotional voucher | Target a category, an item or one free item; global and per-customer usage limits hold under concurrency; free-item voucher adds the item at THB 0.00; tax placement per voucher; reported as foregone revenue, never wallet spend | New, wk 20 | **Unbuilt**. |

### 2.4 Present in the export but absent from the proposal

For completeness, modules that exist in the live app and have no story on
the site: payroll (45 routes, 11 pages), Xero OAuth and finance sync
(`/analytics`), troubleshooting decision trees, training modules and
quizzes, the supplier portal (appears only on the hidden sitemap), the
credential vault (`/access`), the generic data admin (`/data/*`), the
Directory API, hiring posts. Whether the contract covers their continued
existence on a rebuilt stack is Question 10 in Section 7.

---

## 3. Phases, timeline, milestones and deliverables

### 3.1 Phases

The site itself never names phases in its navigation; phases appear in the
data behind it:

- Every story's `provenance.sourcePhase` is **"Phase 1"** for the 58
  "Existing functionality" and 9 "Foundation" stories (source document:
  "Oto complete functionality analysis"), **"Phase 2"** for 50 of the 54
  "New functionality" stories (source groups "Phase 2 - Child supervision
  and release", "Phase 2 - Events, booking, and redemption", "Phase 2 - F&B
  ordering", "Phase 2 - Gate and occupancy", "Phase 2 - Inventory and
  purchasing", "Phase 2 - Members and shared inputs", "Phase 2 - POS
  operations", "Phase 2 - POS tenancy and catalog", "Phase 2 - Pricing,
  tax, and checkout", "Phase 2 - Printing and output", "Phase 2 - Reporting
  and benefits", "Phase 2 - Scanning and identifiers", "Phase 2 -
  Self-service hardware", "Phase 2 - Wallets and promotions", "Phase 2 -
  Messaging"), and **"New functionality"** for the four messaging stories
  sourced from the "Oto Development Plan PDF".
- The hidden sitemap labels the POS and hardware areas "Phase 2 - Oto POS"
  and "Phase 2 - Hardware Operations".
- Every "Existing functionality" feature carries `scope: existing-rebuild`,
  i.e. the plan treats the live app's features as work to be rebuilt, not as
  already delivered.

### 3.2 Timeline - the 20-week roadmap (`/roadmap`)

No calendar dates, no start date, no named milestones or demos. Each week
interleaves Foundation, New and Existing stories:

| Wk | Intent (site wording) | Stories |
|---|---|---|
| 1 | Establish staff access and begin member records within the operator and branch hierarchy | Complete staff account setup; Create a staff account and assign access; Manage operators, branches, and administrators; Review and change effective permissions; Sign in by phone number; Create and enrich a member; Find a returning member by phone number |
| 2 | Create and find members while completing routine account and branch navigation controls | Manage login users; Sign out; Configure inventory items variants and stock locations; Select and reconfirm saved children for a visit; Change branch and open permitted work areas; Publish scoped announcements |
| 3 | Prepare customer pricing, inventory records, organization structure, and employee records | Manage profile photo and account details; Recover a forgotten password securely; Configure a ticket package; Apply verified customer pricing; Configure organization structure; Create import and edit employees |
| 4 | Configure ticket packages, date-based pricing, tax, service rules, and event products | Configure branch tax and service rules; Configure weekday weekend and holiday pricing; Quote a ticket package; Configure event products and locations; Manage casual workers and advisors; Review today's announcements and events |
| 5 | Count, transfer, and respond to low stock while establishing daily task handling | Decide whether to transfer or reorder low stock; Count stock and record the variance; Transfer and replenish stock; Author one-off and recurring task templates; Create and complete a quick task; Open and update task detail |
| 6 | Register children for supervised care and establish event creation and attendance records | Set child supervision rules; Register a child for supervised care; Manage event attendees and daily attendance; Create and edit a birthday event; Create and edit a one-off event; Manage party invitations |
| 7 | Check supervised children in, manage pickup people, and support camp and drop-off registration | Check in a booked or walk-up supervised child; Maintain authorized pickup people; Pick up a child; Generate and publish drop-off forms; Manage drop-off nanny and camp check-ins; Register a child for camp |
| 8 | Configure shared inboxes and establish branch scheduling with conflict controls | Configure messaging inboxes and routing; Use AI to understand and answer customer enquiries; Work customer conversations in shared inboxes; Build a branch schedule; Review and resolve schedule conflicts; Use schedule templates and bulk tools |
| 9 | Connect conversations to registrations and make operational knowledge searchable | Authorize pickup from a guardian-sent photo; Connect customer conversations to Oto records; Manage drop-off and event arrivals in one check-in board; Ask OTO with cited answers; Create and publish SOP knowledge; Search and browse SOP knowledge |
| 10 | Prepare purchasing, food and beverage configuration, staff benefits, and employment documents | Order and partially receive supplier purchases; Search and configure an F&B order; Configure an HR-linked benefit profile; Author employment templates and policies; Configure company signatory authority; Select menus through a public link |
| 11 | Record externally handled payments while supporting reception, public check-in, event bookings, and employment documents | Record one or more payment methods; Apply a manual discount; Operate the reception kiosk; Submit a public guest or service check-in; Manage event bookings arrivals and payments; Generate and issue a contract or letter |
| 12 | Book admission, sell event passes, check attendees in, and support event participation | Check in an event attendee and print bands; Book admission online and receive a QR code; Sell a flat-price event pass; Browse events in list Kanban and calendar; Issue and view staff vouchers; Respond to a guest invitation |
| 13 | Establish wristband value and supporting AI, knowledge-file, and notification controls | Load credit or meals onto a child wristband; Expire and reactivate unused wristband value; Pay with a wristband or wallet QR code; Configure AI settings; Manage knowledge files; Open related work from notifications |
| 14 | Complete guest-linked food orders and staff lifecycle administration | Complete an F&B order; Start a child F&B order from a wristband; Enroll and manage face identity evidence; Manage assets offboarding and departure; Run reviews and staff movements; View HR dashboard and attention |
| 15 | Issue and scan entrance wristbands while establishing live occupancy and timekeeping oversight | View live occupancy by guest type; Issue adult and child entrance wristbands; Scan a wristband, voucher, or booking code; Clock in and out at a kiosk; See who is currently at work; Review and correct timekeeping |
| 16 | Assign branch printers, resolve gate exceptions, and complete employment scheduling actions | Assign branch printers; Resolve gate exceptions and end-of-day groups; Capture employee availability and leave; Review and sign an employment document; View personal and team schedules; Explore and maintain the org chart |
| 17 | Redeem bookings, apply benefits, review attendance records, and establish reusable checklists | Use staff benefits at checkout; Redeem a paid booking QR code; Author reusable checklist templates; Execute an ordinary or checker checklist; Review the activity logbook; Submit missed or unscheduled attendance |
| 18 | Print transactional output, support self-service redemption, and review branch transaction activity | Print a receipt that matches the completed transaction; Print adult and child wristbands and wallet vouchers; Redeem a booking at the self-service kiosk; Review today's branch POS activity; Search POS transaction and order history; Manage the Ops board |
| 19 | Credit transactions, review sales and wallet reporting, and prepare multi-day camp and event execution | Credit all or part of a paid transaction; Review branch sales and ticket mix; Review wallet liability, promotions, and comps; Create and edit a multi-day camp; Manage camp children and attendance; Plan BEO and day-of execution |
| 20 | Use promotions, clone a branch configuration, and complete Fix submission and oversight | Configure and redeem a promotional voucher; Clone a complete branch configuration; Choose the department responsible for Fix reports; Review my submitted Fix reports; Submit a Fix report with media; Triage and resolve the Fix Board |

### 3.3 Milestones and deliverables

- The only deliverables named are the 121 stories with their acceptance
  criteria, allocated to weeks. There are no demo points, sign-off gates,
  hand-over items, documentation, training, data-migration or go-live
  deliverables on the site.
- Each aspect page lists "Verification" tests (Section 4), which are the
  closest thing to an acceptance method.
- Pricing section: none present on the site (nothing to record).

---

## 4. Technical and hosting claims

### 4.1 Architecture (`/architecture`)

| Component | Claim (site wording, condensed) |
|---|---|
| People and stations | "Staff browsers", "Public pages", "Reception, kiosk and POS" send "HTTPS requests" and receive "HTML responses". |
| SvelteKit BFF | "Sessions, page rendering, form handling, and calls to the Python API"; "SvelteKit is used as the browser-facing backend-for-frontend"; provides "staff, public, kiosk, and POS interfaces". |
| Python domain API | "Authorization, business rules, database transactions, audit, and integration jobs"; "The backend API is implemented in Python." |
| AWS PostgreSQL | "Business records, configuration, sessions, jobs, and audit records"; "The application database is PostgreSQL hosted in AWS." |
| Private object storage | "Documents, photos, exports and generated files"; "The storage technology will be selected during implementation." |
| External services | "Messages, accounting and payment providers"; "Provider-specific capabilities remain subject to the configured provider and approved integration." No provider is named on this page. |
| On-premises branch service | "Device status, print and gate jobs, and the approved offline queue" for "Scanners, printers, gates, and displays"; "runs on premises at the branch"; reports "whether a requested hardware action succeeded or failed". |
| System connections | "The installed payment terminals operate independently of Oto and do not send payment status to it." |

Observations: the built OTO App is Express + React on AWS App Runner, not
SvelteKit + Python, so the proposal describes a stack that was never used;
our platform is TypeScript/Fastify on Render (`docs/architecture/`). The
"approved offline queue" and "gate jobs" on a branch service correspond to
the Raspberry Pi branch agent in our plan. No cloud region, backup, uptime,
SLA, support, monitoring or disaster-recovery claim exists anywhere on the
site.

### 4.2 Hardware (`/aspects/aspect-hardware-interoperability`)

- Installed devices at Floresta: "Zebra DS22 scanner, two 4B-2082A wristband
  printers, Welltech G4 receipt printer, three Xprinter units, two NEXGO N5
  terminals, and two PAX A920Pro terminals"; Oto "retains their documented
  identifiers, addresses, protocols, and station roles".
- Scanner works "through its documented USB HID behavior".
- "The installed NEXGO and PAX payment terminals operate independently of
  Oto; Oto neither controls them nor receives their payment status."
- Gates and a self-service kiosk are supported tasks, but no gate controller
  or kiosk model is listed. No second-branch (Chalong) hardware is listed.

### 4.3 Authentication (`/aspects/aspect-authentication`)

- Phone number is the required primary identifier for every staff account,
  normalised "to include the applicable + country code"; email optional.
- Access links expire; public forms use a per-workflow token or code.
- Returning camp families get "a six-digit code on the entered phone number"
  before saved details are shown or changed.
- "Reception and employee kiosks use their documented activation, session,
  PIN, or face-identification flows" (face identification is therefore kept
  in the proposal).
- Failure rule: rejections must not reveal whether an identifier exists.

### 4.4 Authorization (`/aspects/aspect-authorization`)

"Scoped role-based access control with IAM-style permissions": principal,
role (named collection), permission written `service:resource:action`
(examples `inventory:stock:adjust`, `messaging:inbox:assign`), scope
(operator, branch, department, record), effective permissions = union across
roles and scopes. "Navigation visibility is not authorization." Verification
requires allow/deny tests per scope, one/multiple/removed roles, and
cross-branch, cross-operator, cross-department access.

### 4.5 Audit, safeguards, availability

- **Audit and monitoring**: activity and exception views with responsible
  person, record, branch, action, time and reason for "payments, discounts,
  refunds, wallets, stock, occupancy, child release, configuration, and
  integration workflows"; the existing activity logbook is retained.
- **Transaction safeguards**: no duplicate "payments, wallet entries,
  redemptions, attendance, stock changes, issuance, occupancy changes, or
  child-release outcomes" on retry or interruption; uncertain results stay
  unresolved; "Offline operation is limited to the workflows explicitly
  allowed by the source requirements."
- **Service availability**: workflows show when cloud, provider, branch or
  device services are unavailable and whether an interrupted action
  completed; no numeric availability target.

### 4.6 Integrations and messages (`/aspects/aspect-integrations-notifications`)

- Named: **WhatsApp** and **Instagram** as the initial customer messaging
  sources; "further messaging sources can be added later".
- Unnamed: "configured accounting, payment, and support providers".
- "A requested notification is not assumed delivered"; delivery status shown
  from the provider.
- Not mentioned anywhere on the site: Xero, Twilio, LINE, Sentry, AWS
  Rekognition, OpenAI, SCB, 2C2P, Pisell, Papaya, Radar. "AI" and "LLM
  translation" are named without a provider.

### 4.7 Locale, accessibility, files, data, privacy

- **Accessibility and locale**: branch timezone, configured currency,
  normalised phones, rounding rules; "Customer-facing interfaces provide five
  built-in languages, including English and Thai; the other three languages
  remain to be specified"; LLM translation for messaging with the original
  retained; keyboard, focus, text alternatives, non-colour status cues,
  responsive layouts for phone, tablet, kiosk and desktop.
- **Files and media**: profile photos, child and pickup photos, knowledge
  documents, employment documents, signatures, receipts, wristbands,
  vouchers, exports; access follows workflow permissions.
- **Data and reporting**: searches, reports, reconciliation views and exports
  scoped to the viewer; historical reports keep recorded values; missing
  records are surfaced, not silently omitted.
- **Privacy and tenancy**: operator and branch separation with a documented
  global member lookup; operational records stay with their branch; child,
  health, identity, image and contact data shown only where needed; consent,
  correction, export and deletion actions where a workflow requires them.

---

## 5. Roles and personas

### 5.1 Account roles (`/users`)

| Role | Description (site wording) | Does | Access limit |
|---|---|---|---|
| Platform Administrator | "responsible for operators, branches, platform users, and platform settings" | manage operators and branches; manage platform users and settings | every operator on the platform |
| Operator Administrator | "responsible for one operator and its branches, configuration, administrators, integrations, and people administration" | manage branches and administrators; configure operator policies; govern people administration; manage integrations | the assigned operator and its branches |
| Branch Manager | "responsible for one or more assigned branches"; duties "may include staffing, check-ins, events, issues, scheduling, timekeeping, and reporting" | manage branch operations; review team work and timekeeping; manage check-ins and events; resolve issues | assigned branches |
| Line Manager | "responsible for assigned departments or teams within a branch" | coordinate a department or team; assign and review work; manage permitted operational content; handle team enquiries and exceptions | assigned branches, departments and teams |
| Staff Member | "complete assigned work and employee self-service within the person's branch and department scope" | complete work; execute check-ins and events; access knowledge and learning; view own schedule and vouchers | assigned branches and work areas |
| Advisor | "Non-employee professional with a separately governed login, department, and branch access lifecycle" | access assigned modules; work within department and branch; maintain account security | branches and departments assigned to the advisor account |

### 5.2 Customers and external participants

| Participant | Description | Access limit |
|---|---|---|
| Member / Customer | "A globally recognized customer whose normalized phone recalls tier verification, saved children, preferred contact channel, wallet, bookings, and cross-branch activity"; identifies by phone, buys admission and products, uses wallet or promotions, manages bookings and saved children | own records and public customer workflows |
| Parent / Guardian | registers and checks in children, manages party invitations and menus, gives consents "through scoped links" | own registrations, linked children, invitations, public forms |
| Guest / Invitee | responds to one invitation with attendance and dietary information | the invitation opened through the guest link |
| Pending Staff Member | reviews and signs an assigned employment document before or during onboarding | that document only; no staff access until an account and roles exist |

### 5.3 Internal personas behind the roles (data only)

The bundle defines 21 user types that the site collapses into the ten names
above. The extra ones describe duty-specific personas the POS and hardware
stories are written for:

- Staff Member specialisations: **reception** (kiosk, guest and child
  arrivals, handoff evidence), **F&B staff** (orders, wallet scans, allergy
  alerts, preparation routing), **gate operator** (band scans, live
  occupancy, exceptions, end-of-day closure), **stock staff** (view,
  transfer, receive, stock take), **device support** (scanner and printer
  assignments, print and scan failures), **support** (activate and revoke
  kiosks, investigate authentication and device failures).
- Manager specialisations: **event manager** (Branch Manager for events,
  BEO, bookings, camps), **HR manager** and **ops manager** (Line Manager
  for people documents, and for daily operations content respectively),
  **business admin** (Operator Administrator for employees, policies,
  contracts, setup, accounts, reporting).
- Two device contexts that are "not a separate account role": **Employee
  Kiosk Context** (clock in/out, missed event, identity enrolment) and
  **Reception Visitor Context** (one check-in form for one visit).

---

## 6. What remains to be built

Consolidated Unbuilt and Partial items from Section 2, grouped by module.
"Done" is a one-line reading of the story's acceptance criteria. Items
marked (S1) are already delivered on the new platform in Sprint 1 and are
listed only because the export lacks them; their remaining gaps are noted.

### 6.1 Accounts, access and platform administration

- Sign in by phone with country selector and local-format normalisation;
  identical error text for unknown phone, wrong password and disabled
  account. (S1 - confirm error-text parity.)
- Forced password change and phone verification enforced server-side before
  any protected page. (S1.)
- Multi-role assignment with operator, branch and department scopes shown per
  assignment, linkable to an employee or advisor. (S1 - department and record
  scopes exist in the engine; confirm admin UI covers them.)
- Effective-permission review in `service:resource:action` form with scope
  per entry, changing immediately on assignment. (S1.)
- Operator archive that removes the operator from active pickers. (S1.)
- Temporary password that works once and forces a change. (S1.)

### 6.2 Timekeeping and daily operations (gaps in the existing app)

- Missed/unscheduled attendance request with an attached photo or document
  visible before submission.
- Live presence rows showing notification pending/delivered/failed.
- Employee spreadsheet import preview with New, Changed, Unchanged, Invalid
  and Matched statuses and per-row results.
- SOP articles with revision history, archive and restore.
- Fix routing with a preview of the staff who will receive matching reports.
- Camp registration: six-digit SMS code before a returning family's saved
  details are shown or changed (closes the open children's-data exposure).
- Reviews and movements: explicit approval step and approved history (verify;
  may already be met).

### 6.3 Members and visitor details

- Member lookup by normalised phone returning tier, children, preferred
  channel, wallet identity and branch-labelled activity; keypad and typed
  input normalise identically; duplicates rejected. (S1 - wallet identity and
  activity come later.)
- Minimal member creation and enrichment with field-level change history and
  a concurrent-edit warning. (S1 - verify history and conflict warning.)
- Tier verification UI: proof type, verifying operator, timestamp, expiry;
  visible and revocable across branches; online cannot self-grant.
- Saved children with allergies and food restrictions, unknown-birth-year
  entry (age plus month and day), one stored date of birth, per-visit
  Confirm/Edit, save-by-default with opt-out. (S1 - verify unknown-year path
  and opt-out.)

### 6.4 Branch catalog, pricing and checkout

- Ticket package model covering adult rule variants (same-as-kid, set price,
  free adults with overflow), credit grants (adult/child/both; full, fixed,
  percent) and gate rights (adult only). (S1 - reconcile with the delivered
  schema.)
- Weekday/weekend pairs on every priced concept, named inclusive holiday
  ranges, POS shows mode and reason. (S1.)
- Tax rules with product > category > branch resolution, inclusive/exclusive/
  none modes, tax-on-service, discount placement before or after tax, and
  satang-exact agreement between checkout, receipt and export. (S1 covers the
  cascade; add modes and placement.)
- Deterministic ticket quote returning tier, rate mode, free-then-overflow
  adults, wallet grant and beneficiary, bands, supervision, tax, service,
  discounts and total; the sale freezes the quoted configuration.
- Payment recording per branch-activated method, split parts summing exactly,
  external-handling confirmation before wallets, stock or issuance move,
  audit of who recorded it. Owner direction adds SCB QR and EDC ECR
  integration on top of this (Q3).
- Manual discounts with line/order scope, limits with manager override, live
  recalculation, reason and operator.
- Credits/refunds referencing the original sale with matching tax reversal,
  wallet reversal and stock restoration, over-credit limits and history.
- Branch catalog clone (tickets, menus, prices, tax, supervision, inventory,
  promotions, benefits, payment methods, print templates) with fresh ids,
  all-or-nothing, no later sync.

### 6.5 Sales and transaction records

- Branch POS Today dashboard on the branch business date with linked widgets,
  freshness indicators, role-dependent widgets and distinct loading, empty,
  stale, partial-failure and permission states.
- Transaction and order history with the listed filters, a detail view that
  links every effect, frozen historical totals, refund and reprint entry
  points, branch scoping and logged lookups.

### 6.6 Wallets and promotions

- Wallet issuance on accepted payment (credit, meals or both), band and QR
  as alternate keys, grant history, liability treatment.
- Atomic wallet spend from band or QR with no negative balance under
  concurrency and no double deduction on retry.
- Automatic end-of-day expiry of credit and meals, retained history,
  permission-gated reactivation with reason, and reports separating grant,
  spend, refund, expiry, reactivation and outstanding.
- Promotional vouchers targeting a category, item or free item with global
  and per-customer limits, tax placement, and reporting as foregone revenue.

### 6.7 Food and beverage

- Menu with parent/child categories, modifier groups with min/max, quantity-
  multiplied deltas, cart-line re-editing and correct line totals.
- Order completion with per-line tax and service display, paid-only routing
  to kitchen, bar and other stations, multi-station tickets with guest and
  allergy data, visible corrections, and no duplication on print failure.
- Child order started from a phone-camera wristband scan preloading name,
  balance, prepaid meals, allergies and restrictions, with a prominent alert
  and field-level visibility rules for F&B versus care staff.

### 6.8 Gate access and occupancy

- Adult and child band issuance with gate rights only on adult bands, group
  linkage for regular children, and duplicate prevention.
- Live occupancy by adults, regular children and supervised children under
  the asymmetric departure rules.
- Gate exception explanations, operator-and-reason manual resolutions,
  end-of-day stranded list and closure that keeps history.

### 6.9 Child supervision and release

- Branch age bands (nanny, drop-off, none), adult presence from paid adult
  tickets, pre-payment resolution, care fee or waiver, result stored on the
  registration.
- Supervised-care registration with per-child service, required photos and
  acknowledgements, sibling fee rule, private photos on customer surfaces.
- Booked > awaiting > in-park > checked-out lifecycle without reselling
  prepaid service, sibling waiver by permitted staff, atomic check-in of
  nanny, food credit, band and timer, visible corrections.
- Authorised pickup people with phone, relationship, photo, status, source
  and full change history, editable at any stage, including chat-photo
  promotion.
- Verified release: photo match for non-dropper-off collectors, block unknown
  collectors, add-collector-at-checkout, Decline release, full release
  record.
- One check-in board with a Drop-off tab (four states) and an Events tab
  (per-day rosters and counts), never merging branches or creating free
  attendees.

### 6.10 Booking and admission redemption

- Unified attendee record across birthday, one-off, camp and flat-price
  events with per-day attendance, roster counts and party-tab balance.
- Flat-price event pass sale creating the attendee, with the stated payment
  rules (paid in full, birthday deposit and tab, walk-up rules).
- Event attendee check-in with band printing rules and duplicate prevention.
- Public online booking (tickets, supervision, children, event passes,
  confirmations, language, payment) issuing one unique, scoped, revocable QR
  with Tourist-only pricing for unverified customers and no sibling waiver.
- Exactly-once QR redemption at reception with per-state rejection, separate
  redemption of admission and drop-off items, and idempotent retries.
- Self-service kiosk redemption issuing regular bands and wallet credit once
  and routing supervised-child cases to staff without false handoff.

### 6.11 Inventory and purchasing

- Items, variants, sellable links, locations, pack conversions, par, reorder
  point, lead time, supplier and cost, all branch-scoped.
- On-hand view with filters, validated transfers with full movement records
  and below-par transfer suggestions.
- Stock take per location and variant with flagged variance, immediate
  adjustment and complete history.
- Deduplicated low-stock attention (Transfer or Reorder) with predictive
  threshold and the rule that produced it.
- Purchase orders through To Order, Ordered, partial and full receipt with
  expected arrival, destination on receipt and stock updates.

### 6.12 Printing, scanning and hardware

- Printer role assignment (child band, adult/kiosk band, main receipt,
  kitchen, secondary counter, bar) with visible rejection.
- Reconciling receipts with every amount from the record, labelled reprints
  with reasons, and payment state untouched by print failure.
- Adult and child wristbands and wallet vouchers with the field, privacy and
  identifier rules, and separate print and handoff status.
- Zebra DS22 HID scanning that resolves one code per scan by business
  context, rejects bad codes with a masked identifier and specific reason,
  and never repeats a consequential action.

### 6.13 Reporting and employee benefits

- Sales and ticket-mix report by branch and date with the six categories,
  tier and rate-mode splits, item/variant detail, negative refunds and zero
  voids, and branch identity in cross-branch totals.
- Wallet liability, promotions and comps report reconciling to allocation
  rows.
- HR-linked benefit profiles (person or role; free items, credit, discount,
  categories, periods; effective dates; person override wins; benefit QR).
- Benefit application at checkout in canonical order with period resets,
  concurrency-safe last use, and full usage records.

### 6.14 Customer messaging

- WhatsApp and Instagram conversations with source labels, customer identity
  from the source, links to customer, registration, booking or event, and
  message/media delivery states; extensible to other sources.
- Shared inboxes with rule-based routing, access by role, department or
  assignment, concurrent staff views, assign/reassign, reply, Handled to
  archive.
- AI classification, clarifying questions, knowledge-quoted replies
  distinguished from staff replies, and Thai-English translation with
  originals.
- Inbox and routing administration with editable AI guidance and
  non-retroactive changes.
- Guardian-sent pickup photo promotion into the registration with identity,
  relationship and "from chat" source, without releasing the child.

---

## 7. Open questions for the owner

1. **Is the story list the contract?** The site describes all 121 stories as
   one plan and its story pages carried a "Save feedback" form. Did the owner
   submit feedback that changed any story, and is the 121-story set (with
   the acceptance criteria captured here) the agreed definition of what is
   owed? Are the 58 "Existing functionality" stories owed as a rebuild
   (`scope: existing-rebuild`) or only as continued availability?
2. **Stack.** The proposal promises SvelteKit + Python + AWS PostgreSQL; the
   agency built Express + React on App Runner; we build TypeScript on Render.
   Confirm the owner does not expect the proposal's stack.
3. **Payments.** The proposal states payment terminals stay independent and
   staff record payments after handling them outside Oto (story "Record one
   or more payment methods"; architecture boundary). Owner direction requires
   SCB QR gateway and EDC ECR integration. Owner direction wins; confirm that
   the manual-recording path is still wanted as a fallback.
4. **Face identification.** The proposal keeps kiosk face identification with
   a "documented non-biometric alternative"; the platform brief bans
   biometrics. Already open in `OWNER_DIRECTION.md`.
5. **Languages.** "Five built-in languages, including English and Thai; the
   other three languages remain to be specified." The export uses Russian and
   Chinese on parent surfaces. Which five?
6. **Messaging channels.** Only WhatsApp and Instagram are named. Is LINE
   required for the Thai market? Which provider (WhatsApp Business API via
   whom)? Which AI provider?
7. **Accounting provider.** "Configured accounting ... providers" are unnamed;
   Xero exists in the export but is unused and broken. Is Xero still wanted,
   and what should be exported ("POS Reports & Tax Export" on the sitemap)?
8. **Offline scope.** The branch service has an "approved offline queue" and
   safeguards limit offline operation to "workflows explicitly allowed by the
   source requirements", but no story lists them. Which workflows must work
   offline?
9. **Hardware coverage.** Only Floresta devices are listed; no gate
   controller, kiosk or customer-display model is named, and Chalong is
   absent. Confirm the device list in `DEVICE_INVENTORY.md` supersedes.
10. **Modules outside the proposal.** Payroll, Xero analytics,
    troubleshooting, training and quizzes, supplier portal, credential vault
    and data admin exist in the live app but have no story. Are they in the
    rebuild, frozen as-is, or dropped?
11. **Supervision values.** Age bands, care fees, the sibling waiver age and
    the "longest covered duration" sibling fee rule need numbers.
12. **Benefit policy.** The examples (two free coffees a day plus 10% off;
    THB 5,000 monthly manager credit plus 10%) read as illustrations; confirm
    the actual policy and who may hold "owner comp".
13. **Wallet expiry.** Unused wristband credit and meals expire "at the end of
    the day" with staff reactivation. Confirm same-day expiry is the business
    rule.
14. **Online booking rules.** Unverified online customers always pay Tourist;
    online bookings are paid in full; birthdays take a deposit and keep a
    party tab. Confirm.
15. **Sitemap-only items.** "Customer Display & Consent Capture", "End of Day"
    and "POS Reports & Tax Export" appear only on the hidden sitemap. What was
    intended for each?
16. **Timeline.** The roadmap has no start date and no milestones. Was any
    week of it delivered under the contract, and does the owner expect the
    20-week order to be respected?
