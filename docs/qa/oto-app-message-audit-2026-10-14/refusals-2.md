# Refusal-message audit, slice 2 (routes.ts 13500-end + other server modules)

Read-only. Server = apps/oto-app/server, client = apps/oto-app/client/src.

## Findings (cross-checked)

F1 ai-routes.ts:17 "Setting not found: <key>. Please add this setting in System Settings."
- Returned as 500 by /api/ai/extract-event (ai-routes.ts:82/90/100) and /api/ai/parse-beo (190-206); toasted by components/ai-event-assistant.tsx:155-161 and beo/beo-event-editor.tsx.
- No screen named "System Settings". /settings page title is "Settings" (settings-page.tsx:494); its AI Settings card (settings-page.tsx:39-130) only lists rows that already exist (`settings.filter(s => s.key.startsWith("ai_"))`) and edits them. No add-key control. Rows come from script/full/main.ts (full seed), which no longer runs on deploy.
- Misleads action. Real gap: a missing key cannot be added from the UI.
- Fix wording: "AI event extraction is not set up for this park group. Ask an administrator to restore the AI settings." The product fix is to seed the keys or let the AI Settings card add a missing key.
- UNVERIFIED whether staging/prod lack the rows: `select key from settings where key like 'ai_%'`.

F2 routes.ts:22469 "No text content found. Please wait for indexing to complete."
- The client shows the Generate-SOP button only when `file.indexStatus === "indexed"` (components/studio/knowledge-files.tsx:412). So whenever this message is hit, indexing has already finished, with zero chunks: a scanned or image-only PDF, or text under 50 characters per chunk (routes.ts:22418-22421).
- Waiting never helps. Wrong rule (b). Toasted at knowledge-files.tsx:199.
- Fix wording: "No readable text was found in this PDF (it may be a scanned image). Upload a text-based PDF."

F3 routes.ts:18955 `A status with value "${value}" already exists. Please choose a different name.`
- value = name.toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,"") (18947). A Thai-only name like "ยืนยัน" becomes "". The first one saves with value ""; every later Thai-only name is refused with `value ""` even though the name is different. The schema allows value "" (coreSchema.ts:1961).
- Toasted at pages/studio/events.tsx:697.
- Misleads action, and it is a real behaviour bug: Thai-only status names cannot coexist.
- Fix wording, after a code fix: "A status with this name already exists." The value should fall back to a generated id when no Latin characters remain.

F4 checkin-routes.ts:1009 / 1729 / 1903 "Employee does not have a nanny role"
- 1008-1009 fires when the park group has no role whose name matches %nanny% or %caretaker%. That condition is about the park group, not the employee (compare 2044 "No nanny roles configured").
- What counts as a nanny role differs between routes. Schedule and availability (1475, 2038) match nanny|พี่เลี้ยง. Assign and reserve (836, 1005, 1722, 1895) match nanny|caretaker. So a nanny whose role is named "พี่เลี้ยง" shows up on the nanny schedule, then reserving them is refused with "does not have a nanny role".
- Not surfaced: the client discards the body (checkins.tsx:1019 "Failed to assign nanny", nanny-calendar.tsx:129 "Failed to create reservation").
- Real bug: inconsistent role matching. Fix wording for 1009: "No nanny role is set up for this park group". Use one shared matcher.
- UNVERIFIED whether any live role is Thai-named: `select name from roles where name ilike '%พี่เลี้ยง%'`.

F5 auth-otp-routes.ts:149 "Password reset successfully. You can now log in with your new password."
- /api/auth/forgot-password/* is not gated on legacyLoginEnabled() (only /api/login is, auth.ts:127). /forgot-password is still routed (App.tsx:474).
- With OTOAPP_LEGACY_LOGIN off, a reset succeeds, but /auth shows only "Open the launcher" (auth-page.tsx:270), so the new app password is unusable.
- The server text is not displayed. The client repeats the claim at forgot-password-page.tsx:414 ("You can now sign in with your new password" plus a Sign In button to /auth).
- Real gap: a dead flow still live. When legacy is off, refuse with "Passwords are managed by the OTO launcher" (or route there).
- 359 (advisor reset) has no client caller, so it is dead code.

F6 routes.ts:14093 via lib/userDeletion.ts:41 "Deactivate this account to preserve its HR record"
- Person delete from advisors-page.tsx:207 (toasted at :217). Reason "linked_to_platform" (userDeletion.ts:73) means the login is linked to the platform, not that there is an HR record. Advisors are described as having no HR position.
- The remedy exists only on /users (users-page.tsx:307, admin), not on the Advisors screen.
- Minor wording. Fix wording: "This person's login is linked to the OTO platform and can't be deleted. Deactivate it on the Users page instead." (Use the still_referenced variant for the FK case.)

F7 routes.ts:13881 (also 14011) "User not found" (404) on POST /api/people
- Fires when the email belongs to a login in another park group. The caller is creating a person, not looking up a user.
- The 404 is a deliberate non-disclosure, but the text names the wrong thing. Minor.
- Fix wording: "This email can't be used for a new person."

F8 routes.ts:24684 / 24720 "Select branches in this tenant"
- Main trigger: Audience set to selected branches with none ticked (24652; quizzes.tsx:198). "tenant" is internal jargon that appears nowhere in the UI. Minor.
- Fix wording: "Choose at least one branch for this module."

F9 routes.ts:24043 "Only managers and admins can close fix reports"
- Check: `!hasAllBranchesAccess && role not in {manager, admin}`. An operator_admin without an all_branches row is refused even though they are an admin. The list route (23206) does accept operator_admin and global_admin.
- No client caller for PATCH /api/fix-reports/:id/close (only the supplier-portal close), so it is unreachable today.
- Fix: include operator_admin in the check, or word it "Your role can't close fix reports".

F10 ai-routes.ts:44/62/170/245 "AI service not configured. Please set (up) the Anthropic API key."
- The key is the ANTHROPIC_API_KEY env var (lib/anthropic.ts:13). No UI holds it, and the reader is a manager (event assistant / BEO toast). Minor.
- Fix wording: "AI is not available on this server. Ask the system administrator."

F11 routes.ts:26296 "Credential unavailable; ask an administrator"
- Fires on a vault decrypt failure (SESSION_SECRET rotated or the row is corrupt). An admin viewer is told to ask an administrator; the actual fix is to re-enter the password (PATCH 26365). Minor.
- Fix wording: "This saved password can no longer be read. An administrator must re-enter it."

## Side observations (not message findings, but real)
- payroll-statutory-rules-page.tsx:161/175/191/206 call apiRequest(url, {method,...}), but the signature is apiRequest(method, url, data) (lib/queryClient.ts:32). fetch would get method "/api/payroll/..." and throw. Seed/create/update/delete rule sets look broken. UNVERIFIED at runtime (click "Create Default TH Rules").
- /payroll and the exceptions pages admit "manager" (App.tsx:671,675-676), but every /api/payroll endpoint except approve requires isPayrollAdmin (24790). The client does not surface the message (overview shows "Failed to fetch periods").
- DELETE/PATCH /api/locations/:id (26119/26159) have no park-group filter. GET uses getDefaultTenantId().
- /api/test-object-storage answers "working correctly" even when retrieve/compare failed (23822). Dev-only.
