# Refusal-message audit, slice 1 (routes.ts 1-13500, server/lib/*, auth*.ts, kiosk-auth.ts)

Read-only. Raw extraction: r1-all.txt (586 status(4xx) sites in routes.ts 1-13500). tsc output: tsc.txt.

## Findings (cross-checked)

F1 PIN remedy that the kiosk does not offer
- server/lib/faceOff.ts:49, :56, :63 ("Please use PIN entry", "use your PIN or phone number", "Staff clock in with their PIN or phone number")
- kiosk client (client/src/pages/kiosk-page.tsx) has phone entry only (:956); nothing in client/src calls /api/kiosk/clock-pin (routes.ts:10877); only tests do.
- PIN can still be set in employee editor (employee-editor-page.tsx:1797-1969) -> PINs nobody can use.
- Surfaced: enrolment refusal (routes.ts:8909, 8937) shown verbatim in employee-editor-page.tsx:1836 toast. FACE_OFF_NO_MATCH text is not displayed (kiosk ignores message on no-match); FACE_CLOCK_OFF_REFUSAL only reachable after a face match -> effectively unreachable.
- Fix wording: "...Staff clock in with their phone number on the kiosk." Real bug: yes (PIN entry missing from kiosk, or PIN setter vestigial).

F2 Reset Password / Disable Login say "Employee does not have a login account" for a login the app just created
- routes.ts:4328 (reset-password), 4387 (toggle-login)
- enable-login (routes.ts:4046-4200) creates a user + access policy but sets neither employees.userId nor access_policies.coreUserId; reset-password looks only at those two; toggle-login only at employee.userId.
- employee-editor-page.tsx:392,589-613 shows Reset Password + Disable Login whenever personId && accessPolicy, i.e. right after "Create Login".
- Real bug: yes. UNVERIFIED at runtime: Create Login on an employee, then click Reset Password / Disable Login.

F3 "Only administrators can grant ADMIN access level" / "...access to all branches" refuses administrators
- routes.ts:4076-4083: effectiveCallerRole !== "admin" -> global_admin and operator_admin refused.
- client isAdmin includes global_admin/operator_admin (employee-editor-page.tsx:71) and offers Admin (:671) and All Branches (:722-731; Admin auto-sets ALL at :662).
- Real bug: yes (server/client disagree on who is an admin).

F4 "Reassign them first or pass force=true" (department / role deactivate)
- routes.ts:2445, 2678; shown verbatim (departments-page.tsx:117/123, roles-page.tsx:110/116), client always sends force:false, no control.
- Minor/misleads. Fix: "Can't deactivate: N employees are still in this department. Move them to another department first."

F5 "Access denied - select a branch" (leave policies)
- routes.ts:13226. /policies (App.tsx:686, admin; operator_admin admitted per App.tsx:318-320) queries /api/leave-policies with no branchId and has no branch picker (policies-page.tsx:145-147).
- operator_admin: not in the route's isGlobalAdmin, hasAllBranchesAccess false (storage.ts:2236-2251) -> refused.
- Even with a branchId the check reads user.branchIds (routes.ts:13215), which does not exist (tsc TS2339; real field allowedBranchIds) -> always "Access denied".
- Comment at 13198 says the branch rule is kept as the app's (Q40) -> owner note per prototype-rule ruling.
- UNVERIFIED: whether the page shows the error text at all (open /policies as an operator_admin).

F6 "Login created successfully. Save the password" / password-at-least-6 family while password sign-in is off
- routes.ts:4086-4094, 3764, 4297, 4364; auth-otp-routes.ts:149 "You can now log in with your new password".
- /api/login refuses unless OTOAPP_LEGACY_LOGIN=true (auth.ts:127-129, platformSignOn.ts:107); auth page shows launcher card when off (auth-page.tsx:270).
- /forgot-password still routed publicly (App.tsx:474); its link only appears on the legacy form.
- UNVERIFIED: staging value of OTOAPP_LEGACY_LOGIN (GET /api/auth/sign-in-options).

F7 DEACTIVATE_INSTEAD names the wrong reason
- server/lib/userDeletion.ts:41/73/81: same "preserve its HR record" text for a platform-linked user and for any FK reference. Documented as deliberate in the file header. Minor.

F8 "Department must belong to the employee's branch" always fires
- routes.ts:2910-2911: departments have no branchId column (tsc TS2339) -> any departmentId refused. No client caller -> unreachable today. Low.

F9 "Please use 'Enable Login'" - button is labelled "Create Login"
- routes.ts:4343 vs employee-editor-page.tsx:432-435. Remedy exists after the cleanup (policy deleted -> button shows). Minor wording.

F10 "daysWorkedRequired/daysOffEarned must be a positive number" - check is < 1 (0.5 refused); raw field names shown. Minor wording. routes.ts:13247-13297.

Side notes (not in the findings table)
- routes.ts:13176 GET /api/leave-balances/employee/:id same user.branchIds bug -> "Access denied" for permitted users; no client caller.
- routes.ts:15796 same pattern (the other half of the file).
- enable-login createPerson passes 'phone' and reads employee.preferredName, neither of which exists (tsc 4116/4118); and access policy .userId (4149-4150).
