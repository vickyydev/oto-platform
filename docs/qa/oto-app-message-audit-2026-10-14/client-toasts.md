# OTO App client messages that tell the user something wrong (audit only, read-only)

Scope: apps/oto-app/client/src. Toasts, inline, empty-state and helper text. Confirm dialogs and server refusal texts are out of scope.
Context: legacy password login is OFF unless OTOAPP_LEGACY_LOGIN=true (server/middleware/platformSignOn.ts:106-108). It is off on staging (AGENTS.md:100), and POST /api/login answers 403 (server/auth.ts:127-129). The only way in is the launcher hand-off, and that needs users.platform_user_id (platformSignOn.ts:404-419, NOT_PROVISIONED at :140-143).

## Findings (all cross-checked unless marked UNVERIFIED)

F1 HIGH stale / real bug. The in-app "create a login with a password" flows promise credentials that cannot sign anyone in.
- Client:
  - employee-editor-page.tsx:326-327 ("Login created / Save the credentials..."), 350-351 ("Password reset / Save the new password"), 637, 769 and 805 ("User must change password on first login."), 1116, 1194, 1217-1218.
  - users-page.tsx:117 ("User will be required to change password on next login."), 371, 494.
  - advisors-page.tsx:562 ("Used for password reset via SMS"), 595-614 ("Create Login Account... so this advisor can log into the system", "Initial Password", "required to change this password on first login").
- Server: routes.ts:4048-4305 (enable-login/generate-login), 4308-4376 (reset-password), 1161-1201 (users reset).
- What really happens: the password works only on the legacy form, which is off. The new user also has no platform_user_id, so the launcher answers not_provisioned.
- Fix wording: "OTO App user created. They sign in from the OTO launcher once an administrator links their platform account to this user (Console: Login Users > Apps > link OTO App)." Drop the temp-password and first-login text, or show it only when legacyLogin is on (/api/auth/sign-in-options).

F2 HIGH real bug. There is a forced "/change-password" wall that launcher users cannot complete.
- App.tsx:370-375 sends every signed-in user with mustChangePassword to /change-password. That includes launcher sessions.
- change-password-page.tsx:84-86 says "You must change your temporary password before continuing." and asks for a "Temporary Password".
- The flag is set true by:
  - routes.ts:4168 and 4281 (logins created in the app)
  - routes.ts:992 (POST /api/users, default true)
  - routes.ts:4362-4365 and storage.ts:2617-2627 (every admin reset)
- linkOtoAppUser does not clear it (apps/api/src/services/oto-app-users.ts:106-112). createOtoAppUser sets it false precisely to avoid this trap (same file, 766-774).
- Result: a linked user whose app password was reset, or who was created in the app, is stuck at that page on every visit unless someone hands them the temporary password. Changing it changes a password nothing uses.
- Fix: skip the redirect for platform-backed sessions, or clear the flag on link. Wording: "Your password is managed on the OTO launcher."

F3 MEDIUM stale, dead control. Password and SMS-recovery text on My Account.
- my-account-page.tsx:392-404 shows Security, "Manage your password...", and a "Change Password" button.
- phone-verification.tsx:217 says "Verify your phone number to enable password recovery via SMS". Line 260 is similar.
- verify-phone-page.tsx:97 is similar (that page is reachable by URL only; lib/protected-route.tsx is unused).
- Launcher-provisioned users have unusablePassword() (oto-app-users.ts:761), so /api/change-password always answers "Current password is incorrect" (auth.ts:204-207). For everyone else it changes an unused password.
- Fix: hide the button when legacyLogin is off. Wording: "Your password is managed on the OTO launcher."

F4 MEDIUM success toast misstates. advisors-page.tsx:194-195 says "The advisor's session has been signed out. They will see the new role on their next login."
- PUT /api/people/:id/access (routes.ts:14141-14223) signs nothing out.
- The effective role is resolved on every request (getUserWithBranchAccess, storage.ts:2214+).
- Fix wording: "Access policy saved. It applies from the advisor's next page load."
- The admin is led to believe a session was revoked.
- Aside for the server lane: routes.ts:14183 maps ADMIN to global_admin.

F5 MEDIUM success toast misstates / real bug. contract-detail-page.tsx:179-180 says "Email sent - Contract sent to X. Message ID: ..."
- server/email.ts:26-37: with no SMTP_* the send is simulated, returns success with messageId "simulated-...", and logs the whole body to the console.
- routes.ts:6253-6258 then marks the contract status "sent".
- render.yaml documents no SMTP_* for oto-app-staging. UNVERIFIED on the dashboard.
- Fix: when messageId starts with "simulated-", say "Not sent: this deployment has no mail server. Copy the signing link instead." The server should not set status=sent.

F6 MEDIUM wrong remedy / real bug. knowledge-files.tsx:194-196 says 'Created "X" with N steps. Go to Articles to review and publish it.'
- The SOP goes to sop_articles via createSopArticle (routes.ts:22522-22533). That list is Studio > SOPs (/api/sops), not the KB Articles tab (/api/knowledge-base, getKbArticles).
- sop_articles.status defaults to "published" (server/db/coreSchema.ts:1403-1404), so the AI-generated SOP is live for staff and ASK OTO right away.
- Fix wording: 'Created "X" (N steps) in Studio > SOPs. It is already published; review it there.' Better: create it as draft.

F7 MEDIUM stale, dead button (config). vouchers-moved.tsx "Open the Console" uses CONSOLE_URL = VITE_CONSOLE_URL || "/console" (lib/other-apps.ts).
- apps/oto-app/Dockerfile:48-54 declares ARG only for VITE_SENTRY_DSN and VITE_HR_APP_URL.
- render.yaml:818 VITE_CONSOLE_URL belongs to the launcher service, not oto-app-staging (881+).
- Result: on /core/vouchers, /core/my-vouchers, /core/vouchers/redeem and /studio/vouchers the button opens /console on the app, which is NotFound.
- UNVERIFIED on the live dashboard. Fix: ARG and ENV VITE_CONSOLE_URL in the Dockerfile, plus the env var.

F8 MEDIUM wrong remedy / real bug. kiosk/reception.tsx:216 says "Please ask your manager to generate a new QR code".
- The code is generated on /branches (branches-page.tsx:173).
- App.tsx:654 restricts /branches to admin, and the sidebar item is adminOnly (app-sidebar.tsx:98-102). A manager gets Access Denied.
- The server allows managers (routes.ts:9034 requireManager).
- Fix wording: "Ask an administrator to generate a new code from Branches." Also align the route guard and the server guard.

F9 MEDIUM wrong rule / real bug. my-availability.tsx:70-71 says "No roles assigned to your profile. Contact your manager to assign roles."
- GET /api/core/my-role-availability (checkin-routes.ts:2107-2117) finds the employee by userId only, and returns roles [] when there is none.
- Rota and my-time-off match on userId OR email (routes.ts:12739-12743).
- So an email-linked employee sees their rota while My Availability says they have no roles, even when they do.
- Fix: use the same rule. When there is no employeeId, say "Your account isn't linked to an employee record."

F10 LOW-MED stale. beo-event-editor.tsx:644 and 1184 say "Session expired. Please refresh and log in again." and show a Refresh button.
- After a refresh, /auth shows the launcher card (auth-page.tsx:270-271). There is no login.
- The thrown plain Error does not clear the user cache (queryClient.ts:96 clears only on ApiError).
- Fix wording: "You've been signed out. Open the OTO App from the launcher again."

F11 LOW-MED dead-end remedy. app-sidebar.tsx:445 shows "Select 'All Branches' to access configuration" to managers without all-branch access.
- "All Branches" is offered only to global_admin, admin or hasAllBranchesAccess (branch-selector.tsx:34, use-branch-context.tsx:85).
- Fix wording: "Configuration needs access to all branches. Ask an administrator."

F12 LOW wrong remedy. BorrowStaffModal.tsx:176-177 says "Cross-branch borrowing is not configured. Branches must be linked via Operators. Contact your administrator."
- storage.ts:8772-8797 falls back to the tenant when there is no operator. False simply means there is no other branch.
- Fix wording: "There is no other branch to borrow staff from."

F13 LOW-MED mislabel / real bug. employee-editor-page.tsx:456-465 and 603-612: the button always reads "Disable Login".
- POST toggle-login flips isActive (routes.ts:4404-4406), so on a disabled user the click re-enables them.
- Fix: label the button by its current state.

F14 LOW stale or wrong remedy:
- App.tsx:415: "Go to Login" opens the launcher card.
- settings-page.tsx:251 (prod sync): "You'll be redirected to login when done". The card renders on staging, but the server is devOnly (prod-sync.ts:597).
- phone-verification.tsx:200: "SMS verification is not configured. Contact your administrator." It is set only by the TWILIO_* environment variables (twilio-service.ts:7-9 and 40). No admin screen exists.

F15 LOW. employee-editor-page.tsx:3529 says "an admin must assign roles to this branch first". Managers can do this (roles-page.tsx:45, routes.ts:2605 and 2634 requireManager). Fix wording: "Assign roles to this branch on the Roles page."

F16 LOW count and wording problems:
- employees-page.tsx:1020 reports "N errors" but drops the reasons that the server returns in results (routes.ts:4535-4542, for example a platform-linked user refusal).
- scheduling-page.tsx:1183 says "Shift group deleted", but the group is deactivated (storage.ts:8267-8272).

F17 LOW, UNVERIFIED. Routed /core/find (find.tsx:19) and /core/learn (learn.tsx:19) link to *.replit.app tools (oto-qr-forge, franchise-guidebook). Whether those are still live is unknown; open them to settle it.

F18 LOW. /forgot-password is routed (App.tsx:474) and reachable by URL. Its endpoints are live (auth-otp-routes.ts:58-114). It resets a password that is unusable while legacy login is off.

## Unrouted / dead (ranked low, not reported individually)
- core/login.tsx
- core_admin/* (oto-hr.replit.app fallback, "Redirecting to login...")
- studio/users.tsx (oto-hr.replit.app)
- studio/departments.tsx, studio/settings.tsx
- core/tasks.tsx, core/checklists.tsx, core/task-detail*.tsx
- core-tasks-page.tsx, core/not-found.tsx
- lib/protected-route.tsx (the verify-phone redirect)
- _PayrollPage, _CoreHomePage

## Checked and found accurate (sample)
- Kiosk unscheduled "sent for manager review" (routes.ts:10507+ creates PENDING_APPROVAL and a TimekeepingIssue).
- Advisor delete "user account removed" (routes.ts:14069-14107).
- Contract delete "permanently removed".
- Employee delete.
- Ops "click New above" (the button exists for manager+).
- Payroll "Run Payroll" and SOP "Add Step" buttons exist.
- Today "select a branch" (the selector is in CoreLayout).
- Client size-limit messages match their checks (MediaDropZone, MediaUploadButton, my-account, sops, checkin-form, parent-invitation).
