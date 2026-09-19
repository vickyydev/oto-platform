<!-- Read-only analysis of the imported Replit export, 2026-09-19. File references are relative to the export under imports/ (local only, not in git). No secret values are recorded here - variable names and locations only. -->

> **OTO App — frontend** - intake analysis, 2026-09-19. Markers: [V] verified by reading code, [I] inferred, [U] unknown.

# OTO App frontend: migration analysis

Nothing was modified, installed or run. I did not open `cookies.txt`, `core_export.json`, the zip files, any PDF, the photo folders, fixtures, or `demos/onboard-employee/session.json`. For `.replit` and `temp-env` I report key names only. `.replit` holds seed-admin credentials and a Sentry DSN in plain text, tracked in git; treat them as exposed and rotate them.

**Conventions.** `R:` means `imports/oto-app`. [V] means I verified it by reading the cited lines, [I] means inferred, [U] means unknown.

## Summary

- The app is two earlier Replit apps merged: "OTO HR" (contracts/HR) and "OTO Core" (daily ops). A third set of "Studio" pages was transplanted in. About 9,000 lines of unrouted pages and a 113-file raw copy in `R:/client/src_imports/oto-core` are still in the tree [V].
- There are 122 routes: 14 public or device routes, 107 behind `ProtectedRoute`, and one catch-all. `client/src` is about 129K lines of TS/TSX.
- Every URL assumes same-origin. There is no API base URL. 418 `apiRequest` calls and 246 raw `fetch` calls all use relative `/api/...` paths. About 77 raw fetches omit `credentials`, and about 40 of those hit authenticated endpoints [V].
- The granular permission engine has 11 module keys, but the client uses it in exactly one place, to decide which mode tabs show. Route guards and 89 inline checks use the coarse `user.role` string [V].
- There is no customer, member or child entity. Parent and child details are free text spread across seven tables. Payments are manual fields plus a copy-and-paste "POS Entry Checklist" [V].
- Staff voucher redemption does not work in the client. The server endpoints exist and nothing calls them [V].
- Secrets and personal data are tracked in git, so credentials need rotating (section 10).

## 1. Route and page inventory

All routes are in `R:/client/src/App.tsx:463-699`. Page files below are relative to `R:/client/src/pages/`.

**Role guard** (`App.tsx:313-402`): `requiredRole="admin"` admits admin, global_admin and operator_admin. `["manager","admin"]` also admits managers. Staff who fail a guard are redirected to `/core`. Guards look only at `user.role`.

| Module | Routes | Access | App.tsx lines |
|---|---|---|---|
| Public: auth | 2 | PUBLIC | 466-473 |
| Public: employee signing | 2 | PUBLIC (token) | 474-487 |
| Device kiosks | 2 | KIOSK (no staff session) | 488-501 |
| Public: customer, guest, supplier | 8 | PUBLIC (token or id) | 502-557 |
| Account | 3 | any signed-in user | 558-572 |
| Core / "Today" | 25 (1 redirect) | any signed-in user | 575-599 |
| Ops, Setup, Events | 1 + 1 + 2 | manager and above | 602-609 |
| Studio | 19 (2 redirects) | manager and above; form-builder admin only | 612-630 |
| HR block | 50 (1 redirect) | mixed, detailed below | 633-686 |
| Data admin | 6 | admin | 689-694 |
| Catch-all | 1 | | 696 |
| **Total** | **122** | | |

**Public and device routes (14)**

| Route | File | Purpose | Type |
|---|---|---|---|
| `/auth` | auth-page.tsx | Login by email or phone plus password | PUBLIC |
| `/forgot-password` | forgot-password-page.tsx | Password reset by SMS code | PUBLIC |
| `/sign/:token` | signing-page.tsx | Employee signs a contract; policy acknowledgement; signature pad | PUBLIC, employee link |
| `/letter-sign/:token` | letter-signing-page.tsx | Employee signs a warning, termination or other letter | PUBLIC, employee link |
| `/kiosk/reception` | kiosk/reception.tsx | Reception tablet, activated by QR code; runs the check-in board with a device token | KIOSK |
| `/kiosk/:branchId` | kiosk-page.tsx | Timekeeping kiosk: face clock in/out, phone fallback, face enrolment by QR | KIOSK |
| `/checkin/:branchId/:token` | public/checkin-form.tsx | Parent fills the drop-off or nanny form from a reception QR code; multi-language; signature and photo | PUBLIC, customer |
| `/camp-register/:eventId` | public/camp-register.tsx | Camp registration; looks up existing children by phone; signature and photo | PUBLIC, customer |
| `/camp-rules` | public/camp-rules.tsx | Static camp rules | PUBLIC |
| `/parent/:token` | public/parent-portal.tsx | Birthday parent portal: invitation, RSVP dashboard, guest list | PUBLIC, customer |
| `/parent/:token/invitation` | public/parent-invitation-wizard.tsx | Invitation designer with photo upload and generated image | PUBLIC, customer |
| `/rsvp/:token` | public/guest-rsvp.tsx | Guest RSVP in en/th/ru/zh | PUBLIC, guest |
| `/menu-select/:token` | public/menu-select.tsx | Parent picks the set menu | PUBLIC, customer |
| `/supplier/:token` | public/supplier-portal.tsx | Supplier sees, comments on and closes Fix reports | PUBLIC, supplier |

**Account (3):** `/change-password`, `/verify-phone` and `/my-account` (profile, camera photo capture, security).

**Core (25)**, files under `core/`:
- `/core` redirects to `/core/today`.
- `today`: the staff home (section 2).
- `dashboard`: manager overview of checklist completion, issues and escalations.
- `checkins`: the reception board for drop-off and nanny services plus camp attendance, with a camera pickup photo.
- `checkins/dropoff` and `checkins/service`: legacy parent-facing forms that call `/api/public/*` but now sit behind login [I].
- `issues/report` and `issues/escalate`.
- `events` and `events/:id`: the staff event view on the day.
- `vouchers` and `my-vouchers`: two near-identical pages, both "My Vouchers" with a QR code [V] (`vouchers.tsx:36`, `my-vouchers.tsx:36`).
- `vouchers/redeem`: broken (section 10).
- `my-availability`.
- `rota`: my schedule plus time-off requests.
- `checklist/:id`: run a checklist with photo evidence; also embedded by iframe in Ops.
- `troubleshoot`: decision-tree flows.
- `learn` and `modules/:id`: training and quiz.
- `modules`: a legacy app chooser that is wired wrongly and crashes (section 10).
- `sop/:id` and `find`: SOP articles and search.
- `ask`: the Ask OTO AI assistant.
- `fix`: report a fault with a photo or video.
- `fix-board`: the fault kanban and queue.

**Ops, Setup, Events (4):**
- `/ops`: `ops/index.tsx`, 2,744 lines. One workspace with kanban for tasks, checklists, recurring items and announcements.
- `/setup`: a hub of link cards.
- `/events`: renders `studio/events.tsx` inside `EventsLayout` (`events/index.tsx:1-6`).
- `/events/settings`.

**Studio (19)**, files under `studio/`:
- `/studio`: hub.
- `tasks/one-off`, `tasks/recurring`, and `tasks` (redirect).
- `checklists`: template designer with media.
- `kb` and `kb/files`: knowledge base and files for the AI assistant.
- `troubleshooting` and `quizzes`.
- `events/list`, `events/kanban`, `events/calendar`, `events/calendar/:month`, and `events` (redirect). `events.tsx` is 3,967 lines and covers birthdays, event orders, one-off events and camps.
- `events/camp/:id`: camp detail, registrations, daily attendance, QR code.
- `vouchers`: voucher templates.
- `event-settings`.
- `children`: the children database.
- `form-builder`: the drop-off form builder, which reuses `core/form-builder.tsx`.

**HR block (50)**

| Sub-module | Routes | Access |
|---|---|---|
| HR and lifecycle (11) | `/` (redirects to `/core/today`), `/dashboard`, `/employees`, `/employees/bulk-upload`, `/employees/casual`, `/employees/:id` (4,927 lines; includes assets, documents, letters, offboarding, vouchers, enable-login), `/attention`, `/reviews`, `/staff-movements`, `/activity-logbook`, `/org-chart` | manager and above |
| Contracts and e-sign (9) | `/contracts`, `/contracts/new`, `/contracts/:id` (manager and above); `/templates` x3 (rich-text editor), `/policies` x3 (admin) | mixed |
| Scheduling and timekeeping (5) | `/scheduling` (6,431 lines; shifts, leave, duty blocks, borrowing staff), `/timekeeping-review`, `/timekeeping-review/employee/:employeeId`, `/timekeeping/live` (manager and above); `/time-attendance` (admin) | mixed |
| Payroll (11) | `/payroll`, `/payroll/periods`, `/payroll/periods/:periodId`, `/payroll/runs/:runId`, plus `/exceptions`, `/exceptions/:exceptionId`, `/employees`, `/employees/:employeeId` and `/exports` under a run, `/payroll/statutory-rules`, `/my-payslips` | admin tiers; the overview and exceptions pages also allow managers; payslips are open to everyone |
| Configuration (4) | `/branches` (admin; kiosk URLs and reception kiosk QR setup), `/departments`, `/locations`, `/roles` (manager and above; these are job roles, not permission roles) | mixed |
| Platform and admin (10) | `/users`, `/permissions`, `/settings`, `/settings/access` (credential vault config), `/settings/permissions-debug`, `/settings/supplier-tokens`, `/advisors`, `/analytics` (admin); `/operators` (global admin or admin); `/access` (the vault: any signed-in user, no layout) | mixed |

**Data admin (6):**
- Routes: `/data`, `/data/schema`, `/data/:model`, `/data/:model/new`, `/data/:model/:id`, `/data/:model/:id/edit`.
- Purpose: generic create, read, update, delete over about 92 tables via `/api/data-admin/*`.

**Dead code with no importers** [V]:
- `core/tasks.tsx` (1,874 lines).
- `core/task-detail*.tsx`, `core/checklists.tsx`, `core/login.tsx`, `core/not-found.tsx`, `core-tasks-page.tsx`.
- `core_admin/*` (4 files).
- `studio/{departments,settings,sops,users}.tsx`.
- `lib/protected-route.tsx`, `layout/admin-layout.tsx`, `theme-toggle.tsx`, `ui/chart.tsx`, `hooks/use-upload.ts`.
- Lazy-imported in `App.tsx` but never routed: `core/home.tsx` (`App.tsx:102`) and `payroll-page.tsx` (`App.tsx:78`).

## 2. Navigation and shell

| Concern | Finding |
|---|---|
| Provider order | QueryClient, Theme, I18n, Auth, Branch, Mode, Tooltip, Router (`App.tsx:701-721`). Public and kiosk pages also mount Auth, Branch and Mode, so `/api/user` fires on every public page load [V]. |
| Shell | Six near-duplicate header and user-menu copies: `HRLayout` inline in `App.tsx:163-309` (with sidebar), and `layout/{core,studio,ops,events,setup}-layout.tsx`. Core and Studio use a mobile bottom nav (`core-layout.tsx:41-46`, `studio-layout.tsx:41-48`). The Setup layout has no branch selector. |
| Mode switcher | Tabs for Today, Ops, Events, HR and Setup. Studio is hidden from it. The switcher is hidden when only one mode is available (`mode-switcher.tsx:9-16, 92-94`). |
| Branch switcher | Offers All Branches, operator groups and individual branches. It is client-side only: it writes `oto_active_branch_id` to localStorage and each page passes `branchId` in queries. There is no server-side "active branch" (`use-branch-context.tsx:6-8, 137-215`). |
| Today home | `/` and `/core` redirect to `/core/today`. It aggregates announcements, today's checklists, tasks and events (including bookings and POS reference), and the fix queue (`core/today.tsx:123-213`). |
| Notifications | Polls `/api/notifications/unread-count` every 30 seconds. The badge sits on the avatar and the panel is a sheet. Only 10 task-related types exist. A click does a full page reload to `/ops?taskId=` (`notification-bell.tsx:43-66, 101-103`). There are no websockets anywhere; all live updates are polling [V]. |
| Current user | `GET /api/user` with `staleTime: Infinity`; a 401 returns null (`use-auth.tsx:27-38`). Any 401 from any query clears the cached user, which sends the app to `/auth` (`queryClient.ts:91-101`). Logout calls `queryClient.clear()`. |
| Permissions | `GET /api/permissions/me`, stale after 30 seconds (`use-permissions.ts:8-13`). |
| Global query defaults | `staleTime: Infinity`, no refetch on window focus, no retry (`queryClient.ts:71-84`). Writes made by other suite apps will not show here until a reload or an explicit invalidation [V]. |

**Gating layers:**
1. Mode tabs come from `permissions.appModes`. While permissions load, or if they are empty, tabs fall back to role defaults merged with the legacy `user.modules` (`use-mode.tsx:57-121`).
2. HR sidebar items carry static flags: `globalAdminOnly`, `adminOnly`, `managerOnly`, `requireAllBranches` (`app-sidebar.tsx:64-72, 256-264`). Managers see Configuration and Payroll only when "All Branches" is selected.
3. Route guards use the role hierarchy only.
4. There are 89 inline `user.role` checks across 48 files.
5. The Fix Board is gated by department membership through `/api/fix-reports/my-queue-info` (`core/fix.tsx:332-352`).

## 3. Role and permission UI

| Screen | Route / file | Controls |
|---|---|---|
| User Management | `/users`, `users-page.tsx:43-50, 162-167` | Create and edit users; role (admin, manager, staff); all branches or selected branches; activate or deactivate; reset password |
| Access matrix | `/permissions`, `permissions-page.tsx:118-125, 164-199` | Per person (employee or advisor): access level (Staff, Manager, Admin); 5 module switches (Today, Ops, Events, HR, Setup); branch scope (All or Selected). Saves with `PUT /api/people/:id/access` |
| Enable Login wizard | employee editor, `employee-editor-page.tsx:94-101, 262-293` | Email, temporary password, access level, 6 module switches (adds Studio), branch scope. Calls `POST /api/employees/:id/enable-login` |
| Granular overrides | employee editor, `employee-editor-page.tsx:116-178` | Admin only. 11 module keys, each with enabled, branch scope (home only, all, custom), branch list, notes. Calls `PUT /api/module-overrides/:userId` |
| Advisors | `/advisors`, `advisors-page.tsx:730-831` | External people with logins. Access level, 6 modules (one labelled "Studio (Legacy)"), branch scope, kiosk enrolment QR. There is a leftover "OTO Core Account" tab [V] |
| Operators | `/operators`, `operators-page.tsx:38-116` | Tenant, then operator, then branch. Assign branches and users to an operator |
| Permissions Debug | `/settings/permissions-debug` | Read-only view of effective permissions for every user. Adding `?debugPerms=1` to any URL shows a debug panel for managers and above (`mode-switcher.tsx:18-78`) |

**Granularity.** Toggles are per module, not per page or per feature. The engine is in `R:/shared/permissions.ts`: 11 modules (`:7-19`), role defaults (`:185-190`), and 7 hard-coded admin-only actions (`:47-55`) that are not toggleable.

On the client, `usePermissions()` is consumed only by `ModeProvider` (`use-mode.tsx:55`). `canModule()` is never called [V]. So an override changes which tabs appear, not what a route allows. A staff user granted "events" would see the tab and then be redirected to `/core` by the guard at `App.tsx:386-391` [V from code; not tested at runtime].

The three editing screens do not agree on the module list (5, 6 and 6 with "Legacy"). Advisors keep `users.role = "advisor"` in the database and the real role is resolved at request time (`R:/.agents/memory/advisor-admin-role-resolution.md`).

## 4. Mobile, kiosk and public surfaces

| Surface | Details |
|---|---|
| Phones | Core and Studio layouts have a bottom nav with safe-area padding. Scheduling has a 3-day compact view (`lib/three-day-view-utils.ts`). Kanban has a touch sensor (`components/kanban/sensors.ts`). HR is desktop-first; its sidebar becomes a slide-over sheet on mobile. |
| Timekeeping kiosk `/kiosk/:branchId` | No staff session. Takes 5 frames at 640x480 for a liveness check, then calls `/api/kiosk/identify-face` and then `/clock` (`kiosk-page.tsx:165-167, 242-275`). After failed attempts it falls back to a phone keypad plus a photo, then handles missed and unscheduled clock-ins. Enrolment scans a QR code, asks for consent, captures a face and calls `/complete-enrollment` (`:601-705`). Face matching happens on the server with AWS Rekognition [I]. The device secret is read from localStorage and never written by the client (section 10). |
| Reception kiosk `/kiosk/reception` | The admin generates a time-limited code and QR (`branches-page.tsx:166-197`). The tablet calls `/api/kiosk/exchange` and stores `kiosk_session_token` and `kiosk_device_id`. It reconnects silently through `/api/kiosk/refresh-session` (`reception.tsx:29-148`). It then runs the check-in board with a bearer token and no cookies (`checkins.tsx:829-840`). |
| Camera | Live camera: kiosk, my-account, pickup photo (`checkins.tsx:1080`), drop-off (`dropoff-checkin.tsx:273`). Native phone camera via `capture="environment"`: `checklist-run.tsx:990, 1091`, `fix.tsx:549-720`, `fix-board.tsx:707`. All of these need HTTPS. |
| QR codes | Scanning happens only on the timekeeping kiosk (`kiosk-page.tsx:14, 631`). QR codes are shown on my-vouchers, the employee editor (`:2095`), advisors (`:498`) and camp detail (`:2310`). The reception QR is a server-generated image. |
| Signature | `components/signature-pad.tsx` (third-party library) is used for contract and letter signing and for the managing director's signature in settings. `components/ui/signature-canvas.tsx` (custom) is used in check-in forms, camp registration and the schema-driven form renderer. Signatures are sent as base64 data URLs. |
| Uploads | Four mechanisms [V]: (1) Uppy with presigned PUT to S3, for voucher images only (2 call sites; `ObjectUploader.tsx:71-86`, `/api/object-storage/presign` and `/finalize`). (2) An `uploadQueue` singleton that PUTs to presigned S3 and then confirms, for checklist media (`lib/uploadQueue.ts:157-210`), with a global progress overlay at `App.tsx:711`. (3) Multipart form uploads to Express and multer, about 25 call sites including public and kiosk pages. (4) Base64 inside JSON for face frames, signatures and pickup photos. The server accepts 50 MB JSON bodies (`R:/server/index.ts:22-31`). |
| PWA | `manifest.json` (name "OTO Suite", `start_url` "/", standalone) plus an apple-touch-icon. There is no service worker and no offline support [V]. |

## 5. I18n and formatting

| Item | Finding |
|---|---|
| Staff UI | English only in practice. `lib/i18n.tsx` has en, ru and th dictionaries of about 100 keys, used by 4 files (`core/today`, `core/events`, `core/event-detail`, and the dead `core_admin/events`). `LanguageSelector` is never rendered, so staff cannot change language [V]. |
| Parent experience | `R:/shared/localization.ts` has a key-based `t(key, lang)` for en, th, ru and zh, plus date and time formatters. Used by parent-portal, guest-rsvp, the invitation wizard and the invite card. |
| Drop-off form | Translations are stored on the server and fetched with `?lang=`. The builder offers en, th, ru and zh (`core/form-builder.tsx:100-105`). |
| Dates | The helper uses `dd-MM-yyyy` (`lib/format-utils.ts:35-55`), but inline date-fns patterns dominate: `yyyy-MM-dd` (103 uses), `d MMM yyyy` (44), `d MMM` (36). No date-fns locale is imported, so month names are always English. |
| Numbers and currency | 172 `toLocale*` or `Intl` calls in 55 files with mixed locales (none, en-GB, en-US, th-TH). `฿` or `THB` appears about 150 times. VAT is 7% inclusive in `R:/shared/vat-utils.ts`, with `formatThb` at `:129-135`. |
| Timezone | `"Asia/Bangkok"` is hard-coded with an `Intl` trick in `today.tsx:395, 676`, `studio/events.tsx:3069` and `camp-detail.tsx:217`. Branches carry a timezone field (`branches-page.tsx:46, 214`). The timekeeping review converts using the branch timezone (`timekeeping-review-page.tsx:132-160`). The kiosk assumes +07:00 (`kiosk-page.tsx:507`). |

## 6. Stack details for porting

| Item | Value |
|---|---|
| Core stack | React 18.3, Vite 7.3, TypeScript 5.6.3, wouter 3.3 (98 files), TanStack Query 5.60 (150 files), react-hook-form 7.55 with zod 3.25 (25 and 20 files), date-fns 3.6, lucide-react 0.453 (216 files) |
| Tailwind | Version 3.4.17 through PostCSS. `@tailwindcss/vite` 4.1 and `tw-animate-css` are installed but unused. Plugins: `tailwindcss-animate` and typography. Dark mode uses the `dark` class. |
| Custom styling | A custom "elevate" utility system (`index.css:293-392`) is used 164 times in 62 files. There are about 210 `flex-shrink-0` uses, plus `shadow-sm`, `rounded-sm` and `outline-none`. These are all targets for the Tailwind 4 upgrade codemod. |
| shadcn | Style new-york, base colour neutral, CSS variables, no prefix (`R:/components.json`). 54 UI files, of which 7 are custom: currency-input, date-picker, editable-text, empty-state, loading-spinner, signature-canvas, status-badge. `react-day-picker` is version 8. |
| Rich text | TipTap 3.15 with a custom `VariableToken` node (`components/rich-text-editor/*`). Template preview uses Handlebars and DOMPurify on the client (`template-preview-page.tsx:11-12`). |
| Charts | recharts is installed, but only the unused `ui/chart.tsx` imports it. The Analytics page is tables only [V]. |
| Drag and drop | `@dnd-kit` core, sortable and utilities in 12 files: kanban, scheduling, employees, studio events and checklists. |
| PDF and print | All server-side (Puppeteer). The client embeds PDFs in iframes (`contract-detail:705`, `contract-wizard:980`, `template-editor:602`), downloads blobs (`BEO.pdf`) and uses `window.open('/api/...')`. `html2canvas` is used for hiring posts. |
| Replit-only | `@replit/vite-plugin-runtime-error-modal` is always on. The cartographer and dev-banner plugins load only when `REPL_ID` is set (`vite.config.ts:4, 9-22`). `client/replit_integrations/audio/*` is unused by `src` [V]. |
| Sentry | `@sentry/react` 10.57 (`main.tsx:6-22`), traces at 100%, replay only when started manually (section 10). User id, email and name are sent (`use-auth.tsx:97-103`). `@sentry/vite-plugin` is installed but unused. |
| Client env vars | `VITE_SENTRY_DSN`, `VITE_APP_CHANGE_ID`, `VITE_APP_VERSION`, `MODE`, and `VITE_HR_APP_URL` (legacy; has a replit.app fallback in dead code). |
| API base | Same-origin relative paths. Default query URLs are built with `queryKey.join("/")` (`queryClient.ts:55`). In development Vite runs as Express middleware, so there is no proxy config. |
| Coupling to shared code | 80 client files import `@shared/*`. Runtime values come from `@shared/schema`: `insertEmployeeSchema`, `mergeDataSchema`, `templateTypes` and its labels, `activityTypes`, `employeeStatuses`, `timeOffTypeLabels`. `R:/shared/schema.ts:4378` re-exports `../server/db/coreSchema` [V]. |
| Phantom dependencies (break under pnpm) | `@sentry/core` (`use-session-replay.ts:3`), `@radix-ui/react-visually-hidden` (`media/MediaViewerModal.tsx:7`), `@tiptap/core` (`rich-text-editor/variable-token.ts:1`) [V]. |
| Tests | 48 Playwright specs: 26 drive the UI, 22 are API-only, and 12 touch the database directly. Base URL is `localhost:5000`. They rely on `data-testid` (2,976 in the client). |

## 7. `artifacts/`, `demos/` and other non-code

| Path | What it is | Verdict |
|---|---|---|
| `R:/artifacts/app-map` | A Replit "artifact". It is a standalone React 19, Vite 6, Tailwind 4 mini-app whose `src/App.tsx` (381 lines) draws a Mermaid system map. The other 55 files are stock shadcn components. | Documentation, not product. Its diagram shows "POS System" with a dashed "Weak / Future link" to the suite (`App.tsx:13, 87`), plus Xero, Google Sheets and CSV integrations, and outputs for revenue, sales, branch comparison and forecasting. |
| `R:/oto-overview.html` (identical copy in `client/public/`) | A "Platform IP Overview" marketing document. | It describes **OTO Intelligence**: a revenue and footfall dashboard that ingests data from **Pisell POS** and **Papaya POS**, with a headcount solver, forecasting, no login, a separate app. It also describes **OTO Marketing Hub**: Meta and Google analytics in a pnpm monorepo with an OpenAPI spec and Orval-generated hooks. A pasted prompt in `attached_assets` says Central Floresta uses Pisell and Robinson Chalong uses Papaya (Park plus Cafe terminals). I found no customer inbox, asset manager, loyalty or membership feature. |
| `R:/client/public/app-map.html` | Static copy of the map. | It is served without authentication at `/app-map` (`server/index.ts:83-85`). |
| `R:/demos`, `R:/vendor/webreel*` | Scripted demo-video recordings and a patched recorder. | Tooling. `session.json` may hold cookies; I did not open it. |
| `R:/data` | `models.json` (92 tables), generator scripts and a Mermaid entity diagram, all for the Data Admin. `data/pdfs` holds 6 contract PDFs. | Tooling plus personal data. |
| `fix-media`, `uploads` (76 files), `profile-photos`, `pdfs`, `screenshots` | Runtime uploads from the local-storage fallback. | Personal data, tracked in git. Not code. |
| `R:/attached_assets` | 1,486 files, 619 MB: pasted Replit prompts, screenshots and recordings. | Requirements history. The `@assets` alias is unused. |
| `R:/client/src_imports/oto-core` | 113 files: a raw copy of the old Core client. | Unreferenced junk [V]. |
| `R:/design_guidelines.md` | Material Design 3 scheduling guidelines. | Stale (mentions Material Icons and £). |
| `R:/docs` | Staff documentation, a Directory API spec and a discovery report. | The discovery report's route table is partly wrong: it lists `/` as the HR dashboard and a `/payroll/overview` route that does not exist. |

## 8. Seams to the rest of the suite

| Seam | UI location | Current state [V] | Where to plug in |
|---|---|---|---|
| Children | `/studio/children` (`studio/children.tsx:113-147`; merge and duplicates `:279-320`) | No child table. Records are derived from `camp_registrations` (`R:/server/db/coreSchema.ts:3549-3590`), with manual merge tooling. | Replace with child and guardian entities in the central member database. |
| Camp registration | `public/camp-register.tsx:449` | An unauthenticated lookup by phone number returns children's names, dates of birth, allergies and photos. | Use a member lookup with a one-time code. |
| Drop-off and nanny check-ins | `core/checkins.tsx:710-721, 1419-1420`; public forms | Parent and child are free text (`service_checkins`, coreSchema `:1056-1111`). Prices are hard-coded labels (200 and 300 THB). Payment method is a manual select. | The POS sells the service; the check-in references a POS order and a member id. |
| Camp attendance payment | `studio/camp-detail.tsx:321, 1743-1753` | Payment method stored as free text. | POS order link. |
| Event (birthday order) billing | `components/beo/beo-billing-module.tsx:217-246` | Line items include VAT; deposit and outstanding amounts are derived. There is a copy-and-paste "POS Entry Checklist". `pos_order_ref` is stored (coreSchema `:2761-2779`). "Mark POS Done" task at `beo-view-only.tsx:794`. "Line Items (POS Guide)" at `event-settings.tsx:460`. | Map the POS catalogue to line-item templates. Create the POS order from the event order. Sync payment status back. |
| Event bookings | `studio/events.tsx:3577, 3777-3783`; `core/today.tsx:1167` | `studio_event_bookings` holds amounts, paid status, payment method and a POS reference (coreSchema `:2035-2057`). | POS reference becomes a foreign key. The guest becomes a member. |
| Event customer | `core_events` fields for child name, parent name and WhatsApp number (coreSchema `:1805-1829`); RSVP entries | Free text. | Link to a member, or capture as a lead. |
| Staff vouchers | Templates at `/studio/vouchers`; assignment in `employee-vouchers-section.tsx`; QR code is the token (`my-vouchers.tsx:130-135`) | The server has `POST /api/core/vouchers/redeem` and `GET /api/core/vouchers/lookup/:token` (`R:/server/voucher-routes.ts:433, 509`). No client code calls them. | The POS scans the QR and calls lookup and redeem. |
| Analytics | `/analytics` (`analytics-page.tsx:194-522, 667`) | Xero profit and loss, invoices and balance sheet as tables. The Xero sign-in is a full-page redirect to `/api/auth/xero/connect`. | Move to Radar. POS revenue lives in the separate OTO Intelligence app. |
| Staff identity and presence | Directory API `/api/directory/*` with an `X-HR-API-KEY` header (`R:/docs/src/api/directory.md:13-42`); `/api/avatar-status` polling (`use-avatar-work-status.ts:67`) | Already exists for service-to-service use. | POS cashier identity and Radar. |
| Branch context | localStorage `oto_active_branch_id` | Per-origin, so it will not follow the user between suite apps. | A suite-wide branch preference. |

## 9. Porting assessment

**Recommended approach.** Make this a static app on its own subdomain, and keep `/api`, `/uploads`, `/fix-media` and `/objects` same-origin through host rewrites to the API (`server/routes.ts:1487, 1497, 22445`; `replit_integrations/object_storage/routes.ts:81`). That avoids touching about 660 call sites, keeps the cookie first-party and needs no CORS.

[U] Whether Render's static rewrites can proxy multipart uploads and roughly 50 MB JSON bodies. Test this first.

**If the API moves to a separate origin, these break:**

| Area | Detail |
|---|---|
| Cookie | express-session, host-only, `SameSite=lax`. `secure` is true only on Replit, so it is false elsewhere (`R:/server/auth.ts:36-48`). Lasts 24 hours. Session store is a Postgres `session` table. A shared cookie needs a `Domain`, `Secure`, and a common name, secret and store across apps. |
| CORS and CSRF | The server has no CORS, no CSRF protection and no helmet [V]. A cookie scoped to the parent domain lets any sibling subdomain make credentialed requests, so CSRF defence and a strict origin list become mandatory. |
| Raw fetches without credentials | About 40 authenticated calls would return 401: payroll pages (about 24), Xero (3; `analytics-page.tsx:196, 369, 522`), `org-chart-page.tsx:1395`, `/api/people` (3 live), `create-task-dialog.tsx:192`, `activity-preview-tooltip.tsx:40`, `beo-parent-experience-module.tsx:74-92`, `BorrowStaffModal.tsx:57`. The global 401 handler then logs the user out, producing a login loop. |
| Media URLs | 71 `src={...Url|Path}` bindings use server-relative paths, as do the avatar helpers (`employee-avatar.tsx:62`, `clickable-employee-avatar.tsx:34`). |
| Navigations | 8 uses of `window.open` or `location.href` with `/api/...`, the PDF iframes, and the Xero OAuth redirect and its registered callback URL. |
| Uploads | Multipart endpoints need CORS. The S3 bucket's CORS rules must list the new app origin for the Uppy and `uploadQueue` direct PUTs. A fallback that proxies through the backend exists at `server/core/checklistMediaRoutes.ts:621`. |
| Link generation | 18 uses of `window.location.origin` build public links for kiosk, sign, letter-sign, camp-register, menu-select, parent and RSVP. Examples: `branches-page.tsx:155, 196`, `contract-detail-page.tsx:217, 350`, `camp-detail.tsx:519`. They need a configured public base URL if public pages move host. [U] How the server builds QR URLs. |
| Body size | Fastify's default body limit is 1 MB; the kiosk face calls and signature posts need far more. |
| localStorage | Kiosk activations (`kiosk_session_token`, `kiosk_device_id`, `kiosk_device_secret`) are tied to the origin, so every tablet needs re-activating after a domain change. Branch, theme and mode also reset. |
| Embedded iframe | `/core/checklist/:id?embedded=1` with a same-origin `postMessage` (`ChecklistRunSheet.tsx:26-32`, `checklist-run.tsx:87`). The static host must allow framing itself. |
| Websockets | None [V]. |
| Sentry tracing | A cross-origin API needs `tracePropagationTargets` set and the trace headers allowed in CORS. |
| PWA and robots | `start_url` "/" and the name "OTO Suite" clash with a launcher. `robots.txt` allows everything and points to a replit.app sitemap. |

**Single sign-on work (frontend).**
- Replace `AuthProvider` with the suite's "who am I" call.
- Have `ProtectedRoute` and the 401 handler redirect to the launcher with a return URL, instead of `/auth` (`App.tsx:364-371`).
- Drop `/auth`, `/forgot-password`, `/change-password` and `/verify-phone`.
- The identity payload must carry: `role` (read 166 times), `id`, `fullName`, `email`, `modules`, `profilePhotoPath`, `linkedEmployeeId`, `linkedEmployeeProfilePhoto`, `operatorId`, `hasAllBranchesAccess`, `allowedBranchIds`, `mustChangePassword`.

**Effort** [I]:

| Work item | Size |
|---|---|
| Move into the monorepo as-is: remove Replit plugins, fix 3 phantom deps, extract `@shared` into a contracts package (breaking the re-export from `server/`), delete dead code | 3 to 5 days |
| Tailwind 3 to 4: run the codemod, move tokens to `@theme`, keep the elevate utilities, swap the animate plugin, check visually with the Playwright suite | 3 to 5 days |
| SSO plus the same-origin proxy | 2 to 4 days |
| Cross-origin API instead of the proxy | add 1 to 2 weeks |
| Re-activate kiosks and redirect old public URLs and QR codes | operational |

The backend is the real cost. The client depends on 86 top-level `/api` families (about 232 second-level prefixes), all served by one Express `routes.ts` of 25.5K lines.

**Suggested order:**
1. Shell, identity, branches and operators. Do not port `/users`, `/operators`, `/permissions`, permissions-debug, the enable-login wizard or `/data`; move them to the super-admin console. Move `/analytics` to Radar.
2. Core and Ops daily use: Today, tasks, checklists, announcements, notifications, Fix, SOPs, Ask.
3. Both kiosks. They use their own device authentication.
4. HR: employees, contracts, templates, policies, letters, assets, plus the two signing links.
5. Scheduling and leave, then timekeeping review, then payroll.
6. Events, camps, check-ins, children and vouchers, in lockstep with the member database and the POS, together with the 8 customer-facing public pages. Consider giving the public pages their own bundle, off the SSO cookie domain.

## 10. Fragile, surprising or undocumented

| # | Finding | Evidence |
|---|---|---|
| 1 | Voucher redemption is broken. The route has no `:token`, the page reads `params.token`, and it calls `/api/redeem/:token`, which does not exist on the server. There is no scanner. The "Login" link goes to `/login`, which is not a route. | `App.tsx:587`; `core/redeem.tsx:29-51, 161`. The old route was `/redeem/:token` (`src_imports/oto-core/App.tsx:225`). |
| 2 | `/core/modules` renders the legacy app chooser. It destructures `modules` from `useAuth()`, which has no such field, so it throws at render. Its "hr" option goes to the unrouted `/hr`. | `App.tsx:119, 591`; `module-chooser.tsx:18, 26, 38`; `use-auth.tsx:12-19` |
| 3 | There is no error boundary. `Sentry` is imported and `ErrorFallback` is defined, but neither is used, so any render error gives a blank page. | `App.tsx:3, 723-736` |
| 4 | The HR sidebar "Dashboard" item links to `/`, which redirects to `/core/today` and throws the user out of HR. The real dashboard is `/dashboard`. | `app-sidebar.tsx:160-164`; `App.tsx:633-634` |
| 5 | `kiosk_device_secret` is read four times and never written by the client. The server shows the secret once when the device is created. How it reaches the tablet is [U]. | `kiosk-page.tsx:258, 269, 274, 442`; `R:/server/routes.ts:8048-8061` |
| 6 | The Setup card "Access & Permissions" opens the credential vault config, not permissions. | `setup/index.tsx:184-187`; `App.tsx:657` |
| 7 | While permissions load, staff fall back to Core, Ops and Events tabs. The engine's staff default is only "today". Tabs flicker, and override-granted tabs lead to routes the guard blocks. | `use-mode.tsx:73-75`; `permissions.ts:185` |
| 8 | Auth diagnostics log user JSON to the console on every render and route. | `use-auth.tsx:35, 45, 51, 95`; `queryClient.ts:56-63`; `App.tsx:354-372` |
| 9 | Session replay runs with `maskAllText: false`, `maskAllInputs: false` and `blockAllMedia: false`, and any user can start it from the menu. | `main.tsx:11-15`; `core-layout.tsx:164` |
| 10 | Source maps are built (`sourcemap: true`) and served publicly. The Sentry release is always undefined because the `VITE_APP_*` variables are never set in the Dockerfile. | `vite.config.ts:35`; `R:/server/static.ts:13`; `R:/Dockerfile:47-53`; `main.tsx:8` |
| 11 | These are public with no authentication: `/data-admin-schema.svg` (the full database schema, 757 KB), `/oto-overview.html` (the IP document) and `/app-map`. | `R:/client/public/`; `server/index.ts:83-85` |
| 12 | Secrets and personal data are tracked in git (2,920 commits). `temp-env` has keys including `SESSION_SECRET`, `AWS_SECRET_ACCESS_KEY`, `TWILIO_AUTH_TOKEN`, `GCS_SERVICE_ACCOUNT_JSON`, an OpenAI key and `OTO_CORE_API_KEY`. `.replit:75-85` has seed admin credentials and the Sentry DSN. Also tracked: `cookies.txt`, `README.md:101-103` (default login), `uploads/`, `profile-photos/`, contract PDFs, `core_export.json`, the zip files and `demos/onboard-employee/session.json`. | `git ls-files` |
| 13 | HTML is injected without sanitising on the client in signing, policy preview, SOP, Ask and training module pages. [U] Whether the server sanitises it first. | `signing-page.tsx:452, 655`; `core/ask.tsx:532`; `core/module.tsx:118`; `sop-components.tsx:206` |
| 14 | Temporary passwords are generated with `Math.random`. | `employee-editor-page.tsx:247-259` |
| 15 | A hooks-order violation in the rich-text toolbar. `HRLayout` uses `<a href>` links, which force a full page reload. | `rich-text-editor/index.tsx:45-64`; `App.tsx:241-259` |
| 16 | Default query URLs come from `queryKey.join("/")`. A query key containing an object, without its own `queryFn`, produces `[object Object]` in the URL. | `queryClient.ts:55` |
| 17 | The server logs every JSON response body unless `LOG_RESPONSE_BODY=false`. | `R:/server/index.ts:57-63` |
| 18 | Agent notes to carry forward: advisor role resolution, `drizzle-kit push` silently failing on legacy enum data, Fix Board UI statuses not matching the DB enum, Radix Dialog blocking clicks in sibling portals, and three separate event editors. | `R:/.agents/memory/*.md` |

## Unknowns
- The production domain and AWS topology. A comment in `auth.ts` mentions App Runner.
- How many printed QR codes and distributed links already exist.
- Render rewrite limits for large or multipart bodies.
- How kiosk device secrets are provisioned in practice.
- Whether `tsc` passes. Findings 1 and 2 suggest it does not.
- Whether staff need a Thai interface.
- No runtime behaviour was verified, because I did not run the app.

## Key files (absolute paths)
- `imports/oto-app/client/src/App.tsx`
- `imports/oto-app/client/src/lib/queryClient.ts`
- `imports/oto-app/client/src/hooks/use-auth.tsx`
- `imports/oto-app/client/src/hooks/use-mode.tsx`
- `imports/oto-app/client/src/hooks/use-branch-context.tsx`
- `imports/oto-app/client/src/hooks/use-permissions.ts`
- `imports/oto-app/client/src/components/app-sidebar.tsx`
- `imports/oto-app/client/src/pages/kiosk-page.tsx`
- `imports/oto-app/client/src/pages/kiosk/reception.tsx`
- `imports/oto-app/client/src/pages/core/checkins.tsx`
- `imports/oto-app/client/src/pages/core/redeem.tsx`
- `imports/oto-app/client/src/pages/studio/children.tsx`
- `imports/oto-app/client/src/components/beo/beo-billing-module.tsx`
- `imports/oto-app/client/src/lib/uploadQueue.ts`
- `imports/oto-app/shared/permissions.ts`
- `imports/oto-app/shared/schema.ts`
- `imports/oto-app/shared/localization.ts`
- `imports/oto-app/shared/vat-utils.ts`
- `imports/oto-app/server/db/coreSchema.ts`
- `imports/oto-app/server/auth.ts`
- `imports/oto-app/server/voucher-routes.ts`
- `imports/oto-app/vite.config.ts`
- `imports/oto-app/tailwind.config.ts`
- `imports/oto-app/oto-overview.html`
- `imports/oto-app/artifacts/app-map/src/App.tsx`
- `imports/oto-app/docs/src/api/directory.md`
