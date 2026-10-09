import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOtoAppMigrations, createTestDatabase } from '@oto/db/testing';

/**
 * S2-17b round 6 (SCRUM-193 under SCRUM-191) — THE REVIEW, from the attacking
 * side (docs/progress/plans/otoapp-lift/PLAN.md section 8 round 6; section 7's
 * round-6 migration; hazards H10 and H16; ticket check 2; Q28, Q31, Q40 and
 * the builder's Q47-Q53), on top of the builder's s217b-r6.test.ts and
 * apps/oto-app/tests/documents.check.ts, which this does not repeat.
 *
 *  A. FENCES AND SEAMS, read off the code: 0006 and 0007 (and their
 *     snapshots) byte for byte what staging applied, 0008 the one new app
 *     migration and no platform migration; 0008 EXPAND ONLY (no NOT NULL, no
 *     drop, rename or retype, no unique dropped, the census's index made only
 *     under its lock and only in the clean branch, nothing of round 7's
 *     finance keys); the PDF and storage modules byte for byte as main has
 *     them (the gate did not move WHERE documents are kept); the booth, POS,
 *     console, launcher, packages and services naming nothing of round 6.
 *  B. THE MIGRATION ATTACKED: from empty twice; onto a 0007 database holding
 *     real-shaped document rows in two park groups and the default, shaped to
 *     the edges the builder's set does not reach (an operator admin whose
 *     operator is another park group's, a maker whose branch row is another
 *     park group's, a contract outranking a maker, an assignment recorded on
 *     another park group's branch, a split at every step falling to the
 *     next) — every row placed by the declared rules, none mis-tenanted,
 *     counts unchanged, no park group made; and the census's lock raced both
 *     ways (a duplicate offboarding held open in a transaction while 0008
 *     waits on the lock: committed, the index is not made; rolled back, it is).
 *  C. H16 ADVERSARIALLY over HTTP: a failure injected at EVERY write of the
 *     create (the offboarding row, the employee, the login flip itself, the
 *     alert right after it, the asset dates, the change record, each activity
 *     row, the first and the last checklist item) and of the update (the
 *     offboarding row, the employee, the asset dates, the shifts removed, the
 *     activity row) leaves nothing behind; the writes land in the app's own
 *     pre-lift order (imports/oto-app server/routes.ts:6997-7150, read for this
 *     review), the login flipped right after the employee and before the alert,
 *     only at the create, only when the last day has passed.
 *  D. THE PDF AND STORAGE GATE, the refusals: signed out, another park group,
 *     another branch, an expired signer's token with a GOOD signature, a token
 *     for another contract, a forged one, guessed object keys and the raw
 *     storage path through every file door the app has — none hands out a
 *     byte or a URL; the owner's doors and the signer's own link do.
 *  E. PARK-GROUP ISOLATION PER MODULE over HTTP: B's admin against A's
 *     contracts, letters, templates, policies, employee documents, assets,
 *     offboarding and leave; and the leave-policy fallback weighed against the
 *     app's own rule.
 *  F. THE ORG CHART: its GET still writes the missing nodes, but only its own
 *     park group's — never for another park group's branch or employees.
 *
 * Findings are pinned with `it.fails` (the repo's review convention): each
 * states the behaviour that should hold and fails until it is fixed; the `it`
 * beside it proves the failure is the defect, not the arrangement.
 *
 * VERDICT: MERGE. Round 6's own work holds under attack — 0006/0007 untouched,
 * 0008 expand-only with every row placed by its rules, H16 clean at every
 * injected step and in the app's order, the gate refusing every unauthorised
 * read, the org chart minting only its own park group's nodes, the app's
 * typecheck count held at 467 (per file and per code), the api's at zero.
 * Five findings; one high and two medium are park-group crossings the round's
 * fences sit on but did not close; none is a regression of the round, none
 * blocks the merge, and the high one should be fenced before round 6's
 * walkthrough is claimed:
 *
 *  1. (high) The HR employee doors cross park groups, and they can move an
 *     employee between them. `GET /api/employees/:id` answers another park
 *     group's employee in full to any all-branch admin, and
 *     `PATCH /api/employees/:id` writes whatever body it is given into it —
 *     `tenant_id` included (`storage.getEmployee`, no park group; the branch
 *     check passes for an all-branch reader). So B's admin can read A's
 *     employee, rename them, and move them into B, after which every round 6
 *     door that trusts `employee.tenant_id` (contracts, letters, offboarding,
 *     assets, documents) hands B that person's whole file. The same doors
 *     reach the person's login: `POST /api/employees/:id/toggle-login`
 *     switches A's person's login off for B (and `/reset-password` rewrites
 *     its password and hands B the temporary one — inert on staging only
 *     because the legacy form is off there). About two dozen
 *     `/api/employees/:id*` doors read with `storage.getEmployee`; the four
 *     driven here check only the branch, and the rest are uncounted (the
 *     transfer and the delete do check the park group). The HR employees
 *     module is placed in rounds 2 and 6 (section 4's
 *     module map) and no question or census names this; the round fenced the
 *     wizard's employee edit against exactly this move and left the
 *     employee's own edit open. Prescribed fix, on our own authority (a data
 *     fault): every `/api/employees/:id*` door resolves the employee with
 *     `getEmployeeInTenant(id, caller's park group)` and answers the app's
 *     404 (a census of the doors first, as round 4a's); PATCH drops
 *     `tenantId` from the body and refuses a `branchId`, `userId`, `personId`
 *     or department/role id of another park group.
 *  2. (medium) Round 6's linked-login switch-off reaches another park group's
 *     login. The contract wizard's `employeeUpdates` is spread into the
 *     employee row whole; the round strips `tenantId` and checks `branchId`
 *     but lets `userId` through, so B's manager can link B's own employee to
 *     A's login, then offboard that employee with a past last day — and the
 *     app's step (`updateUser(employee.userId, { isActive: false })`) switches
 *     A's person's login off. The app's own wizard sends six personal fields
 *     only (client/src/pages/contract-wizard-page.tsx:388-395). Prescribed fix:
 *     allow-list the wizard's `employeeUpdates` to those six fields (no change
 *     for the app's own client), and, as the backstop, take the offboarding
 *     flip only for a login the strict placement puts in the employee's park
 *     group (else leave it on, as a LEAVING date does, for the 03:00 batch's
 *     own check).
 *  3. (medium) One leave read still crosses park groups, while the plan says
 *     the remaining crossings are fenced (Q40, section 4, the builder's
 *     report). `GET /api/all-leave-balances?branchId=` takes any park group's
 *     branch for an all-branch admin (`getAllowedOperatorAndBranchIds` is
 *     park-group blind) and answers that branch's employees, by id, with their
 *     annual and business leave earned, used and left. Prescribed fix: the
 *     branch in the caller's park group first (`branchInParkGroup`, the app's
 *     404 "Branch not found"), as round 6 did for `/api/leave-balances`.
 *  4. (low) The leave-policy fallback is narrower than the app's rule it
 *     claims to keep. Before 0008 a branch's balance took the latest
 *     effective of the branch's own policy AND the (single, shared)
 *     company-wide one; as built, a park group with a branch policy of its own
 *     no longer sees the default park group's company-wide policy at all, so
 *     where that policy is the newer one the balance changes on deploy.
 *     Q28's rule (a park group with no value of its own reads the default's)
 *     applied to the company-wide slot keeps it. Prescribed fix: in
 *     `getActiveLeavePolicy`, the candidates are the branch's own policies plus
 *     the park group's own company-wide one, or the default park group's where
 *     it has none — then the app's latest-effective pick; or say so in Q49
 *     and section 10.
 *  5. (low) The `people` routes moved without the plan's question moving.
 *     Q31 still places `people` in round 6 ("Confirm, or move any of them
 *     earlier"); the round carried them to round 7 in section 4 only.
 *     Prescribed fix: Q31 names the new placement (or the owner's go for it),
 *     and section 8's round 7 row carries the slice.
 *
 * Disposition (round 6's review fixes): all five are fixed, and their pins are
 * plain `it`s, word for word as the review wrote them; each arrangement `it`
 * beside them now proves what the fix kept. 1: every one of the 45
 * `/api/employees/:id*` doors resolves the employee in the caller's park group
 * (the census is `server/lib/employeeParkGroups.ts`, driven door by door in
 * `tests/documents.check.ts` section 9), PATCH drops `tenantId` and refuses
 * another park group's branch, login, person or department, and a role only
 * the default park group's or the employee's own may be assigned (Q54);
 * within the park group the doors are the app's. 2: the wizard takes the six
 * personal fields only, and the offboarding switches off only a login the
 * strict placement puts in the employee's park group. 3: the branch is the
 * caller's park group's first, "Branch not found". 4: the app's candidate set
 * per park group — the branch's own policies and the park group's
 * company-wide ones, or the default park group's where it has none (Q49).
 * 5: Q31 carries `people` in round 7 with the owner free to pull it earlier,
 * and section 8's round 7 row names the slice.
 *
 * RE-REVIEW of the fix round (57e1d6ad..37a59117, section G). VERDICT: REJECT.
 * What the fix round did holds under attack, re-driven independently: the
 * census is exactly the 45 registered `/api/employees/:id*` doors, and as B's
 * all-branch manager none of them answers A's employee or writes a byte of
 * theirs (their row, their login, every row naming them); the wizard's six
 * fields are the app client's six, and every other column sent in its edits
 * drops; the offboarding backstop leaves another park group's login on; the
 * branch-wide balances answer 404 across and list only the park group's own;
 * the leave policy pick and arithmetic equal the app's pre-lift query on three
 * fixtures, with and without a branch; Q31, section 8's round 7 row and Q54
 * (the next free number) are in the plan. 0006/0007/0008, the journal and
 * the snapshot are byte for byte the review commit's; no migration was added;
 * the API typecheck is clean and the app's 467 are identical per file and per
 * error code; seven subjects of 53 to 68 characters, `Refs: SCRUM-191`, no
 * attribution lines. But the census stops at `:id*`, and the module it is the
 * census of has 54 routes:
 *
 *  6. (high) Four of the other nine `/api/employees*` doors still cross park
 *     groups, through the app's own screens. `GET /api/employees` lists every
 *     park group's employees in full — pay (`defaultMergeData`), tax and social
 *     security numbers, phone, face id — to any all-branch user, and
 *     `?branchId=` of another park group's branch lists that branch's people
 *     (`storage.getEmployeesWithAccess`, no park group). The Excel import's
 *     preview (`POST /api/employees/bulk-upload-preview`) matches each row
 *     against every park group's employees by email, then by full name,
 *     answers the match's current pay, tax and SSO numbers, and resolves branch
 *     names across every park group; its apply (`POST /api/employees/bulk-update`)
 *     writes into `matchedEmployeeId` looked up by id alone — name, pay, tax
 *     ids and `branchId`, so A's employee moves onto B's branch — and its new
 *     rows land B's employees on A's branch. `POST /api/employees/reorder`
 *     rewrites any park group's display order. (`/upcoming-reviews` is shadowed
 *     by `/:id` and answers 404: dead, no crossing. `/bulk-template` samples the
 *     first branch name of any park group: a name only.) Prescription, on our
 *     own authority: the census covers all 54 routes (a second list in
 *     `employeeParkGroups.ts` for the nine without an id, each with its rule);
 *     the list keeps to `req.userWithAccess.tenantId` before the app's branch
 *     filters (another park group's branch then lists nobody, the app's answer
 *     for an empty branch); the preview matches and names branches only within
 *     the park group (another's branch name is the app's own row error
 *     `Branch "<name>" not found`); the apply resolves `matchedEmployeeId` with
 *     `getEmployeeInTenant` (the app's row error "Employee not found") and
 *     takes a row's `branchId` only of the park group (the app's row error "No
 *     access to branch"), for new rows too; the reorder writes only the park
 *     group's ids (another's is skipped as a missing id is); the template
 *     samples the park group's branches.
 *  7. (medium) The same defect outside `/api/employees*`, in modules whose
 *     rounds closed: `POST /api/time-events/override` writes a clock event onto
 *     another park group's employee, on any branch, its own included (201);
 *     `GET /api/timekeeping/employee/:employeeId` answers their timekeeping;
 *     `PATCH /api/roles/:id/employees` replaces a role's holders in every park
 *     group — it strips A's employees of a shared role and can assign it to
 *     them — and its GET lists every park group's holders: Q54's rule, which
 *     the fix round set on the employee's side, is open on the role's side.
 *     Read, not driven: `POST /api/timekeeping/issues/:issueId/resolve` checks
 *     only the issue's branch, which an all-branch manager passes.
 *     Prescription: a census of every route that resolves an employee by id
 *     with `storage.getEmployee` (32 call sites in `server/routes.ts`) or
 *     writes `employee_roles`, each held to the caller's park group with the
 *     app's 404 "Employee not found"; the role-holder write deletes and inserts
 *     only the caller's park group's mappings (another's employee id is the
 *     app's 404), and its list answers only the caller's park group's holders.
 *  8. (low) `POST /api/employees` writes another park group's
 *     `primaryDepartmentId`, `updatedBy` and `profilePhotoUpdatedBy` into the
 *     new employee — the ids the edit now refuses. Prescription: the edit's
 *     check (`employeeEditOutsideParkGroup`) on the create's body, in the same
 *     words.
 *
 * Disposition (the re-review's fixes): all three are fixed, and their pins
 * are plain `it`s, word for word as the re-review wrote them; each
 * arrangement `it` beside them now proves what the fix kept. 6: the census in
 * `server/lib/employeeParkGroups.ts` covers all 54 routes — the 45 doors with
 * an id and `EMPLOYEE_LIST_DOORS`, the nine without, each with its rule; the
 * list keeps to the session's park group before the app's branch filters,
 * the import's preview matches and names branches only within it (another's
 * branch name is the app's `Branch "<name>" not found`), its apply resolves
 * `matchedEmployeeId` in the park group ("Employee not found") and takes a
 * branch only of it ("No access to branch", new rows too), the reorder skips
 * another's id as a missing one, the template samples the park group's
 * branches, and `upcoming-reviews` is recorded as dead. 7: every
 * `storage.getEmployee(` call site the re-review counted (32) is in
 * `EMPLOYEE_LOOKUPS` with its disposition, eight of them fenced here (the
 * override, the timekeeping read, the issue resolve — driven: it crossed at
 * the issue and wrote nothing, so the issue is now the park group's first —
 * the import's apply, the ping, the two older shift doors and the
 * reassignment, whose assignment is now the park group's too); every
 * `employee_roles` writer is in `EMPLOYEE_ROLE_WRITERS`; the role-holder
 * write deletes and inserts only the park group's holders and its read lists
 * only theirs (Q54 from the role side). 8: the create weighs its body with
 * the edit's check, in its words. Driven in `tests/documents.check.ts`
 * section 9 over HTTP.
 *
 * Noted, not findings of this round: the voucher doors
 * (`/api/hr/employees/:employeeId/vouchers`) reach any park group's employee,
 * placed in round 7 under H27; the builder's own "found, not fixed" (the five
 * `/api/permissions/*` reads, `GET /api/roles`, an existing cross-park-group
 * login link reached by `toggle-login` and `reset-password`) stand as
 * reported; the doors resolve the park group from the session, as round 6's
 * do, not by the strict placement (round 1's finding on an admin the app
 * cannot place applies to them as to every session-scoped door).
 *
 * Re-review commands (each was run):
 *   cd apps/api && npx vitest run --pool=forks test/s217b-r6-review.test.ts
 *   cd apps/api && npx vitest run --pool=forks $(ls test | grep -E '^(s217b|g17|otoapp|booth-duty)' | sed 's#^#test/#')
 *   cd apps/api && npx tsc -p tsconfig.json --noEmit            (no output)
 *   cd apps/oto-app && npx tsc -p tsconfig.json --noEmit         (467, per file and code as 57e1d6ad)
 *   npx eslint apps/api/test/s217b-r6-review.test.ts
 *   git diff --stat 57e1d6ad..HEAD -- apps/oto-app/migrations packages/db   (empty)
 *
 * FINAL RE-REVIEW of the second fix round (2eaea724..c82d91ad, section H).
 * VERDICT: MERGE. The round's claims hold, recounted and re-driven
 * independently:
 *  - The censuses, recounted from the code. Every `/api/employees*`
 *    registration in `server/` (routes.ts is the only file that registers
 *    any; no router is mounted on the path) is one of the 54 — the 45 with an
 *    id and `EMPLOYEE_LIST_DOORS`, method and path, no more and no fewer.
 *    `storage.getEmployee(` was called at 32 sites at 2eaea724, which are
 *    `EMPLOYEE_LOOKUPS` route by route in order; 24 remain and each
 *    disposition was read off its handler (held right after the lookup, a
 *    record already held, a token's own record, the caller's own link, the
 *    app's own 403). Every writer of `employee_roles` in `server/` (the
 *    three storage functions, Data Admin's model, prod-sync) is
 *    `EMPLOYEE_ROLE_WRITERS`.
 *  - Every door the round touched, as B's admin AND as B's all-branch
 *    manager, with every app table hashed before and after: the list under
 *    every filter its screens send, the template, the import preview (by
 *    email, by name alone, a new row naming A's branch) and its apply aimed
 *    at A six ways (A's employee onto B's branch, with no branch, onto A's
 *    branch; a new row on A's branch, in an array too; B's employee onto A's
 *    branch), the reorder, the clock override, the timekeeping read, the role
 *    holders' read and five saves, the issue resolve, the create naming A's
 *    branch, department, logins and person, the ping, the older shift
 *    list's create and edit, both reassignments, the bulk delete and the
 *    dead review list: none answers an id, email, tax id or branch of A's,
 *    and the database is byte for byte as it was.
 *  - Within the park group, as both: the import matches by email with the
 *    current pay and tax id, places by branch name and applies (an update and
 *    a create, both B's), the reorder writes B's order, a shared role takes
 *    B's holders beside A's and clears only B's, the override (admins) and
 *    the create write B's rows.
 *  - The fences: 0006, 0007, 0008, the journal and the three snapshots are
 *    byte for byte 2eaea724's (sha256); no migration added; packages/db
 *    untouched; the app's 467 errors identical per file, code and message on
 *    a fresh (non-incremental) build at 2eaea724 and at c82d91ad; the API
 *    typecheck empty; six subjects of 62 to 71 characters, `Refs:
 *    SCRUM-191`, no attribution lines; the 21-file battery 603/603 at
 *    c82d91ad. The builder's two pre-lift bugs (the issue resolve's
 *    `issue.timeEntryId`, the ping's missing `createActivityLogEntry`) are
 *    read in imports/oto-app as described.
 * Three findings, none in the round's doors, none blocking; the first is a
 * crossing in a closed module, for the fix block beside the scheduling
 * census the builder recorded:
 *
 *  9. (high) The face kiosks' admin doors and the clock-event delete cross
 *     park groups (rounds 3 and 5's modules; the reception tablets' rename
 *     and revoke were fenced in round 5's review, these were not).
 *     `GET /api/kiosk-devices` lists every park group's kiosks to any admin;
 *     `GET`, `PATCH` and `DELETE /api/kiosk-devices/:id` read, rename, switch
 *     off and delete any of them; `POST /api/kiosk-devices` places a kiosk
 *     (and hands out its secret) on another park group's branch, with no
 *     `tenant_id`; `DELETE /api/time-events/:id` deletes any park group's
 *     clock event. Driven: B's admin listed, switched off and deleted A's
 *     kiosk, placed one on A's branch and deleted A's clock event (all 2xx).
 *     Prescription, on our own authority: the list and the four doors by id
 *     held to the caller's park group (the kiosk's `tenant_id`, or its
 *     branch's), another's the app's 404 "Kiosk device not found" / "Time
 *     event not found"; the create takes only the park group's branch (the
 *     app's 404 "Branch not found") and writes its `tenant_id`; and a census
 *     of every door that takes a record id in the closed modules
 *     (timekeeping, kiosks, scheduling — the builder's), as round 4a's.
 * 10. (low) A shared role's branch list crosses park groups.
 *     `PATCH /api/roles/:id` with `branchIds` replaces the role's
 *     `role_branch_assignments` in every park group and takes another park
 *     group's branch; `GET /api/roles` answers every park group's branch rows
 *     under each role. The app's employee editor offers a role at a branch
 *     only when its list names that branch or is empty
 *     (client/src/pages/employee-editor-page.tsx:2719-2727), so B's manager
 *     saving a shared, branch-less role to B's branch takes it off A's role
 *     pickers (read off the client; the strip of A's own row is driven). Q54 keeps "the role itself" as the one set's, but these rows
 *     each name a park group's branch. Prescription, on our own authority (a
 *     crossing): the save replaces and the list answers only the caller's
 *     park group's branch rows, another park group's branch the app's 404
 *     "Branch not found"; Q54's text names the branch list.
 * 11. (low) Three records say more or less than the code. The census's
 *     `EMPLOYEE_ROLE_WRITERS` row for Data Admin says a role's delete
 *     "cascades to its holders"; `employee_roles.role_id` is ON DELETE no
 *     action (0000, never changed) and Data Admin deletes by id alone, so it
 *     is refused (400) while the role has holders. The census header places
 *     the `/api/permissions/*` reads "elsewhere ... as the builder's round 6
 *     report left them", but no document in the repository places them (the
 *     plan never names them). The plan's standing cross-park-group login link
 *     names the offboarding and the 03:00 batch but not `toggle-login` and
 *     `reset-password`, which still reach such a link (this header's earlier
 *     note). Prescription: correct the row ("refused while the role has
 *     holders"), name the permission reads in the plan's section 4 with their
 *     round, and add the two doors to the plan's link bullet; then flip the
 *     pin.
 *
 * Final re-review commands (each was run):
 *   cd apps/api && npx vitest run --pool=forks test/s217b-r6-review.test.ts
 *   cd apps/api && npx vitest run --pool=forks $(ls test | grep -E '^(s217b|g17|otoapp|booth-duty)' | sed 's#^#test/#')
 *   cd apps/api && npx tsc -p tsconfig.json --noEmit            (no output)
 *   cd apps/oto-app && npx tsc -p tsconfig.json --noEmit --incremental false
 *                       (467; at 2eaea724 the same per file, code and message)
 *   npx eslint apps/api/test/s217b-r6-review.test.ts apps/api/test/s217b-r6.test.ts
 *   git diff --stat 2eaea724..HEAD -- apps/oto-app/migrations packages/db   (empty)
 *
 * Section A runs everywhere; B needs only the platform's own migrator; C to F
 * need the app's node_modules (present locally and in CI's OTO App job). No
 * Chromium is needed: the PDFs here are ones the test lays down itself (under
 * the app's git-ignored uploads/, removed at the end); the contract wizard's
 * own render uses one when it is found.
 *
 * Commands, from the repository root (the review ran each):
 *   cd apps/api && npx vitest run --pool=forks test/s217b-r6-review.test.ts
 *   cd apps/api && npx vitest run --pool=forks $(ls test | grep -E '^(s217b|g17|otoapp|booth-duty)' | sed 's#^#test/#')
 *   cd apps/api && npx tsc -p tsconfig.json --noEmit            (no output)
 *   cd apps/oto-app && npx tsc -p tsconfig.json --noEmit         (467 errors, as origin/main)
 *   npx eslint apps/api/test/s217b-r6-review.test.ts
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const APP_SERVER = join(APP_DIR, 'server');
const APP_MIGRATIONS = join(APP_DIR, 'migrations');
const APP_NODE_MODULES = join(APP_DIR, 'node_modules');
const HAS_APP_MODULES = ['pg', 'drizzle-orm'].every((m) => existsSync(join(APP_NODE_MODULES, m, 'package.json')));
const HAS_APP_RUNTIME = ['express', 'pg', 'tsx', 'drizzle-orm'].every((m) => existsSync(join(APP_NODE_MODULES, m, 'package.json')));
const CHROMIUM = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p): p is string => !!p && existsSync(p));
const MIGRATION = '0008_document_tenant_ownership_expand';
const DOCUMENT_TABLES = ['asset_catalog', 'leave_policies', 'policy_documents', 'templates'] as const;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** A file as committed (LF), whatever the checkout did to its line ends. */
const committed = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
/** Comments out, so a sentence in a comment never stands in for code. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const plan = () => committed(join(REPO, 'docs', 'progress', 'plans', 'otoapp-lift', 'PLAN.md'));
const question = (n: number) => {
  const text = plan();
  const start = text.indexOf(`- **Q${n}.`);
  expect(start, `Q${n} is in the plan`).toBeGreaterThan(-1);
  const end = text.indexOf('\n- **Q', start + 5);
  return text.slice(start, end === -1 ? text.indexOf('\n## ', start) : end);
};

function sourcesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(dir, { recursive: true }).map(String)) {
    if (/node_modules|[\\/]dist[\\/]|^dist[\\/]|\.turbo/.test(f)) continue;
    const path = join(dir, f);
    if (/\.(ts|tsx|mjs|js|cjs|json|sql|ya?ml)$/.test(f) && statSync(path).isFile()) out.push(path);
  }
  return out;
}

/** One migration file's statements, comments and blank lines out, whitespace collapsed. */
function statementsOf(tag: string): string[] {
  return committed(join(APP_MIGRATIONS, `${tag}.sql`))
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// =============================================================================
// A. Fences and seams, read off the code
// =============================================================================

describe('A. fences and seams', () => {
  it('0006 and 0007 and their snapshots are byte for byte what staging applied; 0008 is the one new app migration and the platform adds none', () => {
    const applied = {
      '0006_tenant_ownership_expand.sql': 'e2f9c20269d7a508c636e8bc2b84e11ac5f82418df98890fc70b894e5d1e1225',
      '0007_tenant_ownership_contract.sql': '7c0408d7329f4d19ff26914f0eeaa0d8e855dc20f98f7eba6412279ba40b1a18',
      'meta/0006_snapshot.json': 'd79e8db0c4396c818de10afeeef20ea8824ab06848d339cfed9c1ec14ea3f369',
      'meta/0007_snapshot.json': '919c1fe4851d4d3dbcf814cdd4b6b12e100e5d4ae83634b16021c36cc59ce19b',
    };
    for (const [file, hash] of Object.entries(applied)) expect(sha256(committed(join(APP_MIGRATIONS, file))), file).toBe(hash);
    const entries = (JSON.parse(committed(join(APP_MIGRATIONS, 'meta', '_journal.json'))) as { entries: { idx: number; when: number; tag: string }[] }).entries;
    expect(entries.find((e) => e.idx === 6)).toMatchObject({ tag: '0006_tenant_ownership_expand' });
    expect(entries.find((e) => e.idx === 7)).toMatchObject({ when: 1791482998619, tag: '0007_tenant_ownership_contract' });
    expect(entries.filter((e) => e.idx > 7).map((e) => e.tag)).toEqual([MIGRATION]);
    expect(entries.find((e) => e.idx === 8)!.when).toBeGreaterThan(1791482998619);
    expect(readdirSync(APP_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort().slice(-1)).toEqual([`${MIGRATION}.sql`]);
    const platform = JSON.parse(committed(join(REPO, 'packages', 'db', 'migrations', 'meta', '_journal.json'))) as { entries: { tag: string }[] };
    expect(platform.entries.at(-1)?.tag).toBe('0075_event_booking_pass');
  });

  it('0008 is EXPAND ONLY: added columns, keys and indexes; no NOT NULL, no drop, rename or retype; no unique dropped; nothing of round 7', () => {
    const sql = statementsOf(MIGRATION);
    const all = sql.join('\n');
    expect(all).not.toMatch(/SET NOT NULL|ADD COLUMN [^;]*NOT NULL/i);
    expect(all).not.toMatch(/\bDROP\b/i);
    expect(all).not.toMatch(/\bRENAME\b/i);
    expect(all).not.toMatch(/ALTER COLUMN|SET DATA TYPE/i);
    expect(all).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
    expect(all).not.toMatch(/pl_facts|PRIMARY KEY|finance/i);
    const alters = sql.filter((s) => /^ALTER TABLE/i.test(s));
    expect(alters).toHaveLength(8);
    for (const t of DOCUMENT_TABLES) {
      expect(alters).toContain(`ALTER TABLE "${t}" ADD COLUMN "tenant_id" uuid;`);
      expect(alters.some((s) => s.startsWith(`ALTER TABLE "${t}" ADD CONSTRAINT "${t}_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")`))).toBe(true);
    }
    // The only writes are UPDATEs that fill a NULL tenant_id, and the one INSERT is 0006's default park group.
    for (const s of sql.filter((x) => /^UPDATE/i.test(x))) expect(s, s).toMatch(/WHERE (\w+\."tenant_id"|"tenant_id") IS NULL/);
    expect(sql.filter((s) => /^INSERT/i.test(s))).toHaveLength(1);
    expect(sql.find((s) => /^INSERT/i.test(s))).toMatch(/^INSERT INTO "tenants" \("name", "slug"\) SELECT 'OTO Default', 'default' WHERE NOT EXISTS/);
    // The census: the lock first, then the count; the unique index only in the clean branch.
    const lock = sql.findIndex((s) => s === 'LOCK TABLE "employee_offboarding" IN SHARE ROW EXCLUSIVE MODE;');
    const census = sql.findIndex((s) => s.startsWith('DO $$'));
    expect(lock).toBeGreaterThan(-1);
    expect(census).toBe(lock + 1);
    expect(census).toBe(sql.length - 1);
    expect(sql[census]).toMatch(/IF employees_with_two = 0 THEN CREATE UNIQUE INDEX "employee_offboarding_employee_unique" ON "employee_offboarding" USING btree \("employee_id"\); ELSE RAISE NOTICE/);
    expect(all.match(/CREATE UNIQUE INDEX/g)).toHaveLength(1);
  });

  it('the census index lives in the SQL only, so a later generate never takes it for granted; the four tenant_id stay nullable in the schema (round 7 contracts)', () => {
    const snapshot = committed(join(APP_MIGRATIONS, 'meta', '0008_snapshot.json'));
    expect(snapshot).not.toContain('employee_offboarding_employee_unique');
    const schema = code(readFileSync(join(APP_DIR, 'shared', 'schema.ts'), 'utf8'));
    expect(schema).not.toContain('employee_offboarding_employee_unique');
    for (const table of ['templates', 'policy_documents', 'asset_catalog', 'leave_policies']) {
      const start = schema.indexOf(`pgTable("${table}"`);
      expect(start, table).toBeGreaterThan(-1);
      const body = schema.slice(start, schema.indexOf('\n});', start) === -1 ? undefined : schema.indexOf(']);', start));
      expect(body, table).toMatch(/tenantId: uuid\("tenant_id"\)\.references\(\(\) => tenants\.id\),/);
      expect(body, table).not.toMatch(/tenantId: uuid\("tenant_id"\)[^,\n]*\.notNull\(\)/);
    }
  });

  it('the gate did not move WHERE documents are kept: the PDF, file and bucket modules and the BEO and org chart routes are byte for byte main’s', () => {
    const main = {
      'pdf-storage.ts': 'c23daf4541026ebff0bb49cce05161b76d59ad1ba2040ba913eaebe568dd43e3',
      'file-storage.ts': '109e0c07f2ea063732b9cae0d935d8803902a12aefde1d730257e4fb1fdf8ab9',
      'storage/s3Client.ts': '9d51fea745ad10e3944543ec6b9e17a36d5af128c923703b010e4be7c1c8ddcb',
      'pdf.ts': 'e56ab0b8d875508edf5829c8ab8519f356360deff91182dafcbf161679105997',
      'beo-routes.ts': '4174a50d53dd91077acb8cbcae291982c1ab60136c0cbac66151ab2034175c14',
      'orgChartRoutes.ts': 'eff8d4478165e8b0157ef07d37891222104f751b49932e70f525f06366fe9d90',
    };
    for (const [file, hash] of Object.entries(main)) expect(sha256(committed(join(APP_SERVER, file))), file).toBe(hash);
    const routes = code(readFileSync(join(APP_SERVER, 'routes.ts'), 'utf8'));
    expect(routes).toMatch(/const publicFileFolders = \["branch-logos", "dropoff-photos", "invitations"\];/);
    expect(routes).toMatch(/const publicFolders = new Set\(\["branch-logos", "dropoff-photos", "invitations"\]\);/);
    expect(readFileSync(join(APP_SERVER, 'pdf-storage.ts'), 'utf8')).toMatch(/\{ expiresIn: 300 \}\);/);
  });

  it('the booth, POS, console, launcher, packages and services name nothing of round 6', () => {
    const roots = ['apps/booth', 'apps/pos', 'apps/console', 'apps/launcher', 'packages', 'services'].map((r) => join(REPO, r));
    const patterns = [
      /documentParkGroups|DOCUMENT_READ_RULES|getTemplateInParkGroup|getPolicyDocumentInParkGroup|getAssetCatalogItemInParkGroup|getLeavePolicyInParkGroup/,
      /employee_offboarding_employee_unique|offboarding-census|offboarding:census/,
      /document_tenant_ownership/,
    ];
    const hits: string[] = [];
    for (const root of roots) {
      for (const path of sourcesUnder(root)) {
        const text = readFileSync(path, 'utf8');
        for (const p of patterns) if (p.test(text)) hits.push(`${path.slice(REPO.length)} ~ ${p}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('nothing of round 7 in the app: Data Admin’s Attention 503 stands and its four document models are untouched by the round', () => {
    expect(readFileSync(join(APP_SERVER, 'data-admin', 'router.ts'), 'utf8')).toMatch(/router\.use\("\/attention-items", \(_req: Request, res: Response\) => \{\s*res\.status\(503\)/);
    for (const model of ['template.ts', 'policyDocument.ts', 'assetCatalog.ts', 'leavePolicy.ts']) {
      expect(readFileSync(join(APP_SERVER, 'data-admin', 'models', model), 'utf8'), model).not.toMatch(/tenantId|tenant_id/);
    }
  });

  it('FINDING 5 (low, fixed): Q31 names where the `people` routes went, matching section 4 (they left round 6)', () => {
    expect(plan()).toMatch(/Not in this round: the `people` routes, which Q31 placed here\./);
    expect(question(31)).not.toMatch(/`people` in round 6/);
  });

  it('the arrangement of finding 5, as fixed: Q31 carries `people` in round 7, the owner free to pull it earlier; section 4 and section 8’s round 7 row say the same', () => {
    const q31 = question(31);
    expect(q31).toMatch(/`people` in round 7 \(HR\s+records\)/);
    expect(q31).toMatch(/your word pulls it into an\s+earlier/);
    expect(plan()).toMatch(/carried to\s+their own slice beside round 7's Data Admin walkthrough/);
    const round7 = plan().split('\n').find((line) => line.startsWith('| 7 | '));
    expect(round7).toMatch(/The `people` routes/);
    expect(round7).toMatch(/Q31/);
  });
});

// =============================================================================
// B. The migration attacked
// =============================================================================

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}
const journal = (): Journal => JSON.parse(readFileSync(join(APP_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;

/** A copy of the app's migrations up to and including `idx`. */
function migrationsUpTo(idx: number): string {
  const j = journal();
  const live = j.entries.filter((e) => e.idx <= idx);
  const dir = mkdtempSync(join(tmpdir(), 'otoapp-r6rv-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...j, entries: live }));
  for (const e of live) copyFileSync(join(APP_MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

async function withClient<T>(url: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url, application_name: 'zz-r6rv' });
  await c.connect();
  try {
    await c.query('set search_path to otoapp');
    return await work(c);
  } finally {
    await c.end();
  }
}

/** A fresh platform database whose otoapp schema stands at `idx`. */
async function databaseAt(idx: number): Promise<{ url: string; drop: () => Promise<void> }> {
  const { url, drop } = await createTestDatabase();
  const dir = migrationsUpTo(idx);
  try {
    await withClient(url, (c) => migrate(drizzle(c), { migrationsFolder: dir, migrationsSchema: 'otoapp' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { url, drop };
}

/** The deploy's migrator, without blocking this process: the app's own where it can run here, else the same SQL in-process. */
function deploy(url: string): Promise<{ status: number; output: string }> {
  if (!HAS_APP_MODULES) return applyOtoAppMigrations(url).then(() => ({ status: 0, output: 'applyOtoAppMigrations' }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(APP_DIR, 'script', 'migrate.mjs')], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (output += c.toString('utf8')));
    child.on('exit', (status) => resolve({ status: status ?? 1, output }));
  });
}

const insertRow = (c: pg.Client, table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  return c.query(`insert into ${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
};

const indexExists = (c: pg.Client, name: string) =>
  c
    .query(`select count(*)::int as n from pg_indexes where schemaname = 'otoapp' and indexname = $1`, [name])
    .then((r) => Number(r.rows[0].n) === 1);

describe('B. the migration attacked', () => {
  it('from empty, twice: the second run applies nothing, the four columns nullable with their keys and indexes, the census index made, no park group made', async () => {
    const { url, drop } = await createTestDatabase({ otoapp: true });
    try {
      const again = await deploy(url);
      expect(again.status, again.output).toBe(0);
      if (HAS_APP_MODULES) expect(again.output).toMatch(/otoapp is up to date/);
      await withClient(url, async (c) => {
        for (const t of DOCUMENT_TABLES) {
          const col = (
            await c.query(
              `select is_nullable, data_type from information_schema.columns where table_schema = 'otoapp' and table_name = $1 and column_name = 'tenant_id'`,
              [t],
            )
          ).rows;
          expect(col, t).toEqual([{ is_nullable: 'YES', data_type: 'uuid' }]);
          expect(await indexExists(c, `idx_${t}_tenant`), t).toBe(true);
          const fk = (await c.query(`select count(*)::int as n from pg_constraint where conname = $1 and contype = 'f'`, [`${t}_tenant_id_tenants_id_fk`])).rows[0].n;
          expect(Number(fk), t).toBe(1);
        }
        expect(await indexExists(c, 'employee_offboarding_employee_unique')).toBe(true);
        expect(Number((await c.query('select count(*)::int as n from tenants')).rows[0].n)).toBe(0);
      });
    } finally {
      await drop();
    }
  }, 180_000);

  describe('onto a 0007 database with real-shaped rows in two park groups and the default', () => {
    let url = '';
    let drop: () => Promise<void> = async () => undefined;
    const ids: Record<string, string> = {};
    const id = (name: string) => (ids[name] ??= randomUUID());
    /** Each row's expected park group by the declared rules, and why. */
    const expected: Record<string, { table: string; group: 'A' | 'B' | 'D'; why: string }> = {};
    let before: Record<string, number> = {};
    let tenantsBefore = 0;
    let upgraded = { status: -1, output: '' };

    beforeAll(async () => {
      ({ url, drop } = await databaseAt(7));
      await withClient(url, async (c) => {
        for (const [name, slug] of [
          ['D', 'default'],
          ['A', 'zz-rv-a'],
          ['B', 'zz-rv-b'],
        ] as const) {
          await insertRow(c, 'tenants', { id: id(name), name: `ZZ RV ${name}`, slug });
        }
        for (const [b, t] of [
          ['aX', 'A'],
          ['aY', 'A'],
          ['bX', 'B'],
        ] as const) {
          await insertRow(c, 'branches', { id: id(b), tenant_id: id(t), name: `ZZ RV ${b}`, address: 'ZZ' });
        }
        await insertRow(c, 'operators', { id: id('opA'), tenant_id: id('A'), name: 'ZZ RV operator A' });
        const user = (name: string, role: string, extra: Record<string, unknown> = {}) =>
          insertRow(c, 'users', { id: id(name), email: `${name}-${id(name)}@example.com`, password: 'x', full_name: 'ZZ RV', role, ...extra });
        await user('uA', 'admin');
        await insertRow(c, 'user_branch_access', { tenant_id: id('A'), user_id: id('uA'), branch_id: null, access_scope: 'all_branches' });
        await user('uB', 'admin');
        await insertRow(c, 'user_branch_access', { tenant_id: id('B'), user_id: id('uB'), branch_id: null, access_scope: 'all_branches' });
        // An operator admin whose access rows say B but whose operator is A's: the strict rule places nobody.
        await user('uOpCross', 'operator_admin', { operator_id: id('opA') });
        await insertRow(c, 'user_branch_access', { tenant_id: id('B'), user_id: id('uOpCross'), branch_id: id('bX'), access_scope: 'selected_branches' });
        // An access row that names B but points at A's branch: the strict rule places nobody.
        await user('uRowCross', 'manager');
        await insertRow(c, 'user_branch_access', { tenant_id: id('B'), user_id: id('uRowCross'), branch_id: id('aX'), access_scope: 'selected_branches' });
        await user('uNone', 'staff');
        for (const [e, t, b] of [
          ['eA', 'A', 'aX'],
          ['eA2', 'A', null],
          ['eB', 'B', 'bX'],
          ['eB2', 'B', null],
        ] as const) {
          await insertRow(c, 'employees', {
            id: id(e),
            tenant_id: id(t),
            branch_id: b ? id(b) : null,
            full_name: 'ZZ RV',
            nickname: 'ZZ',
            email: `${e}-${id(e)}@example.com`,
          });
        }
        const contract = (template: string, employee: string, policy: string | null = null) =>
          insertRow(c, 'contract_instances', {
            employee_id: id(employee),
            template_id: id(template),
            template_snapshot_html: '<p>zz</p>',
            template_snapshot_version: 1,
            merge_data_json: '{}',
            created_by: id('uNone'),
            policy_document_id: policy ? id(policy) : null,
          });
        const letter = (template: string | null, employee: string) =>
          insertRow(c, 'employee_letters', { employee_id: id(employee), template_id: template ? id(template) : null, letter_type: 'warning', created_by: id('uNone') });
        const template = async (name: string, group: 'A' | 'B' | 'D', why: string, createdBy: string | null) => {
          await insertRow(c, 'templates', { id: id(name), name: `ZZ RV ${name}`, html_body: '<p>zz</p>', created_by: createdBy ? id(createdBy) : null });
          expected[name] = { table: 'templates', group, why };
        };
        const assign = (t: string, b: string) => insertRow(c, 'template_assignments', { template_id: id(t), branch_id: id(b) });

        await template('t1', 'A', 'its branches (both A) outrank a B contract and a B maker', 'uB');
        await assign('t1', 'aX');
        await assign('t1', 'aY');
        await contract('t1', 'eB');
        await template('t2', 'A', 'no branch; its contract (A, no branch) and its letter (A) agree', 'uB');
        await contract('t2', 'eA2');
        await letter('t2', 'eA');
        await template('t3', 'D', 'no branch, no contract; its maker is an operator admin whose operator is another park group’s', 'uOpCross');
        await template('t4', 'D', 'no branch, no contract; its maker’s access row names B on A’s branch', 'uRowCross');
        await template('t5', 'B', 'its one branch (B) outranks an A maker', 'uA');
        await assign('t5', 'bX');
        await template('t6', 'B', 'nothing but its maker (B)', 'uB');
        await template('t7', 'B', 'branches split (A, B), employees split (A, B): its maker (B)', 'uB');
        await assign('t7', 'aX');
        await assign('t7', 'bX');
        await contract('t7', 'eA');
        await letter('t7', 'eB2');
        await template('t8', 'D', 'split at every step, its maker placed nowhere', 'uOpCross');
        await assign('t8', 'aY');
        await assign('t8', 'bX');
        await contract('t8', 'eB');
        await contract('t8', 'eA2');
        await letter(null, 'eA'); // a letter made from no template reaches no template

        const policy = async (name: string, group: 'A' | 'B' | 'D', why: string, branch: string | null, createdBy: string | null) => {
          await insertRow(c, 'policy_documents', {
            id: id(name),
            title: `ZZ RV ${name}`,
            branch_id: branch ? id(branch) : null,
            is_company_wide: !branch,
            created_by: createdBy ? id(createdBy) : null,
          });
          expected[name] = { table: 'policy_documents', group, why };
        };
        await policy('p1', 'A', 'its branch (A) outranks a B maker', 'aY', 'uB');
        await policy('p2', 'B', 'company-wide; acknowledged by B’s contracts only, which outrank an A maker', null, 'uA');
        await contract('t6', 'eB', 'p2');
        await contract('t6', 'eB2', 'p2');
        await policy('p3', 'D', 'company-wide; acknowledged in A and B; its maker placed nowhere', null, 'uOpCross');
        await contract('t2', 'eA', 'p3');
        await contract('t6', 'eB', 'p3');
        await policy('p4', 'A', 'company-wide; no contract; its maker (A)', null, 'uA');
        await policy('p5', 'D', 'company-wide; no contract; no maker', null, null);

        const item = async (name: string, group: 'A' | 'B' | 'D', why: string) => {
          await insertRow(c, 'asset_catalog', { id: id(name), name: `ZZ RV ${name}` });
          expected[name] = { table: 'asset_catalog', group, why };
        };
        const asset = (catalog: string, employee: string, branch: string | null) =>
          insertRow(c, 'employee_assets', {
            employee_id: id(employee),
            branch_id: branch ? id(branch) : null,
            asset_name_snapshot: 'ZZ',
            catalog_asset_id: id(catalog),
            assigned_by: id('uNone'),
          });
        await item('c1', 'A', 'its one recorded branch (A) outranks the employee it went to (B)');
        await asset('c1', 'eB', 'aX');
        await item('c2', 'A', 'no branch recorded; its employees (A, A)');
        await asset('c2', 'eA', null);
        await asset('c2', 'eA2', null);
        await item('c3', 'D', 'branches split, employees split');
        await asset('c3', 'eA', 'aX');
        await asset('c3', 'eB', 'bX');
        await item('c4', 'D', 'never assigned');

        const leave = async (name: string, group: 'A' | 'B' | 'D', why: string, branch: string | null, active = true) => {
          await insertRow(c, 'leave_policies', { id: id(name), branch_id: branch ? id(branch) : null, name: `ZZ RV ${name}`, is_active: active });
          expected[name] = { table: 'leave_policies', group, why };
        };
        await leave('l1', 'B', 'its branch (B)', 'bX');
        await leave('l2', 'A', 'its branch (A), inactive', 'aY', false);
        await leave('l3', 'D', 'company-wide', null);

        for (const e of ['eA', 'eB', 'eB2']) {
          await insertRow(c, 'employee_offboarding', {
            employee_id: id(e),
            offboarding_type: 'resignation',
            reason_code: 'other',
            last_working_day: '2026-01-01',
            created_by: id('uNone'),
          });
        }
        before = {};
        for (const t of [...DOCUMENT_TABLES, 'template_assignments', 'contract_instances', 'employee_letters', 'employee_assets', 'employee_offboarding']) {
          before[t] = Number((await c.query(`select count(*)::int as n from ${t}`)).rows[0].n);
        }
        tenantsBefore = Number((await c.query('select count(*)::int as n from tenants')).rows[0].n);
      });
      upgraded = await deploy(url);
    }, 240_000);

    afterAll(async () => {
      await drop();
    });

    it('the deploy applies 0008 alone, and the census is clean (no notice)', () => {
      expect(upgraded.status, upgraded.output).toBe(0);
      if (HAS_APP_MODULES) {
        expect(upgraded.output).toMatch(new RegExp(`applied ${MIGRATION}`));
        expect(upgraded.output).not.toMatch(/applied 000[0-7]/);
        expect(upgraded.output).not.toMatch(/offboarding census/);
      }
    });

    it('every row lands where the declared rules put it — none mis-tenanted, none null', async () => {
      const wrong: string[] = [];
      await withClient(url, async (c) => {
        for (const [name, want] of Object.entries(expected)) {
          const [row] = (await c.query<{ tenant_id: string | null }>(`select tenant_id from ${want.table} where id = $1`, [id(name)])).rows;
          if (row?.tenant_id !== id(want.group)) wrong.push(`${want.table}:${name} (${want.why}) -> ${row?.tenant_id} wanted ${want.group}`);
        }
        for (const t of DOCUMENT_TABLES) expect(Number((await c.query(`select count(*)::int as n from ${t} where tenant_id is null`)).rows[0].n), t).toBe(0);
      });
      expect(wrong).toEqual([]);
      expect(Object.keys(expected)).toHaveLength(8 + 5 + 4 + 3);
    });

    it('counts unchanged in every table it reads or writes, no park group made, every key valid, the census index made', async () => {
      await withClient(url, async (c) => {
        for (const [t, n] of Object.entries(before)) expect(Number((await c.query(`select count(*)::int as n from ${t}`)).rows[0].n), t).toBe(n);
        expect(Number((await c.query('select count(*)::int as n from tenants')).rows[0].n)).toBe(tenantsBefore);
        for (const t of DOCUMENT_TABLES) {
          const orphans = Number((await c.query(`select count(*)::int as n from ${t} x left join tenants t on t.id = x.tenant_id where t.id is null`)).rows[0].n);
          expect(orphans, t).toBe(0);
        }
        expect(await indexExists(c, 'employee_offboarding_employee_unique')).toBe(true);
      });
    });
  });

  describe('the census raced: a duplicate held open in a transaction while 0008 waits on its lock', () => {
    const raced = async (finish: 'COMMIT' | 'ROLLBACK') => {
      const { url, drop } = await databaseAt(7);
      const holder = new pg.Client({ connectionString: url, application_name: 'zz-r6rv-holder' });
      try {
        const tenant = randomUUID();
        const employee = randomUUID();
        const user = randomUUID();
        await withClient(url, async (c) => {
          await insertRow(c, 'tenants', { id: tenant, name: 'ZZ RV race', slug: 'default' });
          await insertRow(c, 'employees', { id: employee, tenant_id: tenant, full_name: 'ZZ', nickname: 'ZZ', email: `zz-${employee}@example.com` });
          await insertRow(c, 'users', { id: user, email: `zz-${user}@example.com`, password: 'x', full_name: 'ZZ', role: 'admin' });
          await insertRow(c, 'employee_offboarding', {
            employee_id: employee,
            offboarding_type: 'resignation',
            reason_code: 'other',
            last_working_day: '2026-01-01',
            created_by: user,
          });
        });
        await holder.connect();
        await holder.query('set search_path to otoapp');
        await holder.query('begin');
        await insertRow(holder, 'employee_offboarding', {
          employee_id: employee,
          offboarding_type: 'termination',
          reason_code: 'other',
          last_working_day: '2026-02-01',
          created_by: user,
        });
        const deploying = deploy(url);
        // 0008 reaches its LOCK and waits behind the open insert.
        let waited = false;
        for (let i = 0; i < 600 && !waited; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          waited = await withClient(
            url,
            async (c) =>
              Number(
                (
                  await c.query(`select count(*)::int as n from pg_locks l join pg_class k on k.oid = l.relation
                                  where not l.granted and k.relname = 'employee_offboarding' and l.mode = 'ShareRowExclusiveLock'`)
                ).rows[0].n,
              ) > 0,
          );
        }
        expect(waited, '0008 waits on the offboarding lock').toBe(true);
        await holder.query(finish);
        const out = await deploying;
        expect(out.status, out.output).toBe(0);
        return await withClient(url, async (c) => ({
          index: await indexExists(c, 'employee_offboarding_employee_unique'),
          rows: Number((await c.query('select count(*)::int as n from employee_offboarding where employee_id = $1', [employee])).rows[0].n),
          columns: Number(
            (
              await c.query(`select count(*)::int as n from information_schema.columns where table_schema = 'otoapp' and column_name = 'tenant_id' and table_name = any($1)`, [
                [...DOCUMENT_TABLES],
              ])
            ).rows[0].n,
          ),
          output: out.output,
        }));
      } finally {
        await holder.end().catch(() => undefined);
        await drop();
      }
    };

    it('committed while 0008 waits: the census sees the duplicate, the index is not made, the deploy goes on and says so', async () => {
      const r = await raced('COMMIT');
      expect(r.rows).toBe(2);
      expect(r.index).toBe(false);
      expect(r.columns).toBe(4);
      if (HAS_APP_MODULES) expect(r.output).toMatch(/offboarding census \(0008\): 1 employees have more than one offboarding/);
    }, 180_000);

    it('rolled back while 0008 waits: nothing stood in the way, the index is made', async () => {
      const r = await raced('ROLLBACK');
      expect(r.rows).toBe(1);
      expect(r.index).toBe(true);
      expect(r.columns).toBe(4);
      if (HAS_APP_MODULES) expect(r.output).not.toMatch(/offboarding census/);
    }, 180_000);
  });
});

// =============================================================================
// The app over HTTP — the harness for C to F
// =============================================================================

const children: ChildProcess[] = [];
afterAll(() => {
  for (const child of children) child.kill();
});

const PASSWORD = 'zz-r6-review-password';
const SESSION_SECRET = `zz-r6rv-session-${randomBytes(4).toString('hex')}`;
/** The app's own password format (`hashPassword` in server/auth.ts): scrypt, 64 bytes, then the salt. */
const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${scryptSync(password, salt, 64).toString('hex')}.${salt}`;
};

async function serve(databaseUrl: string): Promise<string> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'test',
    APP_ENV: 'dev',
    STORAGE_ENV_PREFIX: 'zz-r6-review',
    OBJECT_STORAGE: 'local',
    OTOAPP_LEGACY_LOGIN: 'true',
    LOG_LEVEL: 'warn',
    TZ: 'UTC',
    DEPLOY_ENV: 'local',
    OTOAPP_JOBS: 'platform',
    USE_AWS_REKOGNITION: 'false',
    SESSION_SECRET,
    // The contract wizard renders its PDF after its transaction commits; with no Chromium it answers 500 there, the rows already written.
    ...(CHROMIUM ? { PUPPETEER_EXECUTABLE_PATH: CHROMIUM } : {}),
    DATABASE_URL: databaseUrl,
  };
  delete env.HARNESS_FAKE_NOW;
  const child = spawn(process.execPath, [join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs'), 'tests/harness/serve-routes.ts'], {
    cwd: APP_DIR,
    env: env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness did not start:\n${output}`)), 180_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const m = /HARNESS_PORT=(\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    };
    child.stdout!.on('data', read);
    child.stderr!.on('data', read);
    child.on('exit', (status) => {
      clearTimeout(timer);
      reject(new Error(`harness exited ${status}:\n${output}`));
    });
  });
}

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON answer read field by field
  body: any;
  location: string | null;
  cookie: string;
}

let ORIGIN = '';
async function call(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Answer> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON — kept as text.
  }
  return {
    status: res.status,
    text,
    body,
    location: res.headers.get('location'),
    cookie: res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  };
}
const show = (a: Answer) => `${a.status} ${a.text.slice(0, 300)}`;

async function signIn(email: string): Promise<string> {
  const res = await call('POST', '/api/login', { body: { identifier: email, password: PASSWORD } });
  expect(res.status, `sign-in as ${email}: ${res.text}`).toBe(200);
  return res.cookie;
}

/** A Bangkok calendar date `n` days from now. */
const day = (n: number) => new Date(Date.now() + 7 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);

interface ParkGroup {
  tenant: string;
  x: string;
  y: string;
  admin: { id: string; email: string; cookie: string };
  /** A manager limited to branch X. */
  limited: { id: string; email: string; cookie: string };
}

describe.skipIf(!HAS_APP_RUNTIME)('C to F. over HTTP against the app’s routes', () => {
  let drop: () => Promise<void> = async () => undefined;
  let pool: pg.Pool;
  const run = randomBytes(3).toString('hex');
  const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pool.query<T>(text, params)).rows;
  const count = async (text: string, params: unknown[] = []) => Number((await q<{ n: string }>(text, params))[0]!.n);
  let DEFAULT = '';
  let A: ParkGroup;
  let B: ParkGroup;
  const LOG = `zz_r6rv_order_${run}`;
  const INJECT = `zz_r6rv_inject_${run}`;
  /** Files this review lays down under the app's uploads/, removed at the end. */
  const laid: string[] = [];

  async function user(tenant: string, role: string, email: string, branch: string | null): Promise<string> {
    const id = randomUUID();
    await q(`insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, $3, 'ZZ R6RV', $4, true, false)`, [
      id,
      email,
      hashPassword(PASSWORD),
      role,
    ]);
    await q('insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4)', [
      tenant,
      id,
      branch,
      branch ? 'selected_branches' : 'all_branches',
    ]);
    return id;
  }

  async function parkGroup(label: string): Promise<ParkGroup> {
    const tenant = randomUUID();
    await q('insert into tenants (id, name, slug) values ($1, $2, $3)', [tenant, `ZZ R6RV ${label} ${run}`, `zz-r6rv-${label}-${run}`]);
    const [x, y] = [randomUUID(), randomUUID()];
    for (const [id, suffix] of [
      [x, 'x'],
      [y, 'y'],
    ] as const) {
      await q(`insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ', 'Asia/Bangkok')`, [id, tenant, `ZZ R6RV ${label} ${suffix} ${run}`]);
    }
    const adminEmail = `zz-r6rv-${label}-admin-${run}@example.com`;
    const limitedEmail = `zz-r6rv-${label}-limited-${run}@example.com`;
    return {
      tenant,
      x,
      y,
      admin: { id: await user(tenant, 'admin', adminEmail, null), email: adminEmail, cookie: '' },
      limited: { id: await user(tenant, 'manager', limitedEmail, x), email: limitedEmail, cookie: '' },
    };
  }

  async function employee(g: ParkGroup, branch: string | null, label: string, fields: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    const cols = ['id', 'tenant_id', 'branch_id', 'full_name', 'nickname', 'email', 'status', ...Object.keys(fields)];
    const vals = [id, g.tenant, branch, `ZZ R6RV ${run} ${label}`, 'ZZ', `zz-r6rv-${label}-${id.slice(0, 8)}@example.com`, 'active', ...Object.values(fields)];
    await q(`insert into employees (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
    return id;
  }

  /** A contract row of `employee`, signed, its PDFs on the app's local disk where the app would keep them. */
  async function signedContract(employeeId: string, templateId: string, createdBy: string): Promise<string> {
    const id = randomUUID();
    const signedPath = `/uploads/contracts/signed_contract_${id}.pdf`;
    const pdfPath = `/uploads/contracts/finalized_contract_${id}_v1.pdf`;
    await q(
      `insert into contract_instances (id, employee_id, template_id, template_snapshot_html, template_snapshot_version, merge_data_json, created_by,
                                       status, signing_status, signed_pdf_path, pdf_path, signed_at)
       values ($1, $2, $3, '<p>zz</p>', 1, '{}', $4, 'active', 'signed', $5, $6, now())`,
      [id, employeeId, templateId, createdBy, signedPath, pdfPath],
    );
    for (const p of [signedPath, pdfPath]) layDown(p, `%PDF-1.4 zz r6 review ${id}`);
    return id;
  }

  function layDown(storagePath: string, content: string) {
    const file = join(APP_DIR, storagePath.slice(1));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
    laid.push(file);
  }

  beforeAll(async () => {
    let url = '';
    ({ url, drop } = await createTestDatabase({ otoapp: true }));
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 6 });
    await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
    DEFAULT = (await q<{ id: string }>("select id from tenants where slug = 'default'"))[0]!.id;
    A = await parkGroup('a');
    B = await parkGroup('b');
    // The order the offboarding's writes land in, per watched person (rolled back with a failed request).
    await q(`create table ${LOG} (seq bigserial primary key, tbl text not null, op text not null, k text not null)`);
    await q(`create table ${LOG}_watch (id text primary key)`);
    await q(`create function ${LOG}() returns trigger language plpgsql as $$
             declare k text := to_jsonb(coalesce(new, old)) ->> TG_ARGV[0];
             begin
               if exists (select 1 from ${LOG}_watch w where w.id = k) then
                 insert into ${LOG} (tbl, op, k) values (TG_TABLE_NAME, TG_OP, k);
               end if;
               return null;
             end $$`);
    for (const [table, events, column] of [
      ['employee_offboarding', 'insert or update', 'employee_id'],
      ['employees', 'update', 'id'],
      ['users', 'update', 'id'],
      ['attention_items', 'insert', 'employee_id'],
      ['employee_assets', 'update', 'employee_id'],
      ['employee_changes', 'insert', 'employee_id'],
      ['activity_log', 'insert', 'employee_id'],
      ['offboarding_checklist', 'insert', 'employee_id'],
      ['schedule_assignments', 'delete', 'employee_id'],
    ] as const) {
      await q(`create trigger ${LOG} after ${events} on ${table} for each row execute function ${LOG}('${column}')`);
    }
    ORIGIN = await serve(url);
    for (const g of [A, B]) {
      g.admin.cookie = await signIn(g.admin.email);
      g.limited.cookie = await signIn(g.limited.email);
    }
  }, 300_000);

  afterAll(async () => {
    for (const file of laid) rmSync(file, { force: true });
    await pool?.end();
    await drop();
  });

  // ── C. H16, adversarially ───────────────────────────────────────────────────

  let rota: { plan: string; row: string } = { plan: '', row: '' };
  const ensureRota = async () => {
    if (rota.plan) return rota;
    const plan = randomUUID();
    await q('insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)', [plan, A.tenant, A.x, day(0)]);
    const group = randomUUID();
    await q('insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)', [group, A.tenant, A.x, `ZZ R6RV ${run}`]);
    const row = randomUUID();
    await q(
      `insert into schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time, label)
       values ($1, $2, $3, $4, $5, '09:00', '17:00', 'ZZ R6RV')`,
      [row, A.tenant, A.x, group, plan],
    );
    rota = { plan, row };
    return rota;
  };

  interface Leaver {
    id: string;
    login: string;
    asset: string;
    shift: string;
  }
  /** A's employee with a linked login, a shift three days out and an asset to give back — watched by the order log. */
  const leaver = async (label: string): Promise<Leaver> => {
    const r = await ensureRota();
    const login = await user(A.tenant, 'staff', `zz-r6rv-${label}-${run}@example.com`, A.x);
    const id = await employee(A, A.x, label, { user_id: login, employment_state: 'ACTIVE' });
    const shift = randomUUID();
    await q('insert into schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, employee_id) values ($1, $2, $3, $4, $5, $6)', [
      shift,
      A.tenant,
      r.plan,
      r.row,
      day(3),
      id,
    ]);
    const asset = randomUUID();
    await q(`insert into employee_assets (id, employee_id, branch_id, asset_name_snapshot, quantity, assigned_by, return_required) values ($1, $2, $3, 'ZZ keys', 1, $4, true)`, [
      asset,
      id,
      A.x,
      A.admin.id,
    ]);
    await q(`insert into ${LOG}_watch (id) values ($1), ($2)`, [id, login]);
    return { id, login, asset, shift };
  };

  /** Everything an offboarding (create or update) writes, for one person. */
  const footprint = async (p: Leaver) => ({
    offboardings: await q('select offboarding_type, reason_code, last_working_day from employee_offboarding where employee_id = $1 order by created_at', [p.id]),
    checklist: await count('select count(*) as n from offboarding_checklist where employee_id = $1', [p.id]),
    changes: await count('select count(*) as n from employee_changes where employee_id = $1', [p.id]),
    activity: await count('select count(*) as n from activity_log where employee_id = $1', [p.id]),
    attention: await count('select count(*) as n from attention_items where employee_id = $1', [p.id]),
    employee: (await q('select status, employment_state, end_reason, last_working_day, notice_date from employees where id = $1', [p.id]))[0],
    loginActive: (await q<{ is_active: boolean }>('select is_active from users where id = $1', [p.login]))[0]!.is_active,
    assetDue: (await q<{ expected_return_by: Date | null }>('select expected_return_by from employee_assets where id = $1', [p.asset]))[0]!.expected_return_by,
    shift: await count('select count(*) as n from schedule_assignments where id = $1', [p.shift]),
    order: await q<{ tbl: string; op: string }>(`select tbl, op from ${LOG} where k = any($1) order by seq`, [[p.id, p.login]]),
  });

  const offboard = (p: Leaver, lastWorkingDay: string, cookie = A.admin.cookie) =>
    call('POST', `/api/employees/${p.id}/offboarding`, { cookie, body: { offboardingType: 'termination', reasonCode: 'misconduct', lastWorkingDay, noticeDate: day(-10) } });

  const inject = async (table: string, event: 'insert' | 'update' | 'delete', when: string) => {
    await q(`create or replace function ${INJECT}() returns trigger language plpgsql as $$ begin raise exception 'zz injected failure (round 6 review, H16)'; end $$`);
    await q(`create trigger ${INJECT} before ${event} on ${table} for each row when (${when}) execute function ${INJECT}()`);
  };
  const uninject = (table: string) => q(`drop trigger if exists ${INJECT} on ${table}`);

  /**
   * The app's own create, in its order (imports/oto-app server/routes.ts:6997-7150, read for this review):
   * the offboarding row; the employee; the linked login, only when the last day has passed; the coverage
   * alert for shifts after it; the assets' return dates; the change record; two activity rows; six checklist items.
   */
  const APP_CREATE_ORDER = [
    'employee_offboarding INSERT',
    'employees UPDATE',
    'users UPDATE',
    'attention_items INSERT',
    'employee_assets UPDATE',
    'employee_changes INSERT',
    'activity_log INSERT',
    'activity_log INSERT',
    ...Array<string>(6).fill('offboarding_checklist INSERT'),
  ];

  const createPoints: Array<[string, string, 'insert' | 'update', (p: Leaver) => string]> = [
    ['the offboarding row itself (the first write)', 'employee_offboarding', 'insert', (p) => `new.employee_id = '${p.id}'`],
    ['the employee (before the login flip)', 'employees', 'update', (p) => `new.id = '${p.id}'`],
    ['the login flip itself', 'users', 'update', (p) => `new.id = '${p.login}'`],
    ['the coverage alert, right after the flip', 'attention_items', 'insert', (p) => `new.employee_id = '${p.id}'`],
    ['the assets’ return dates', 'employee_assets', 'update', (p) => `new.employee_id = '${p.id}'`],
    ['the change record', 'employee_changes', 'insert', (p) => `new.employee_id = '${p.id}'`],
    ['the first activity row', 'activity_log', 'insert', (p) => `new.employee_id = '${p.id}' and new.activity_type = 'offboarding_started'`],
    ['the second activity row', 'activity_log', 'insert', (p) => `new.employee_id = '${p.id}' and new.activity_type = 'employment_state_changed'`],
    ['the first checklist item', 'offboarding_checklist', 'insert', (p) => `new.employee_id = '${p.id}' and new.sort_order = 1`],
    ['the last checklist item', 'offboarding_checklist', 'insert', (p) => `new.employee_id = '${p.id}' and new.sort_order = 6`],
  ];

  for (const [where, table, event, when] of createPoints) {
    it(`C. H16 create: a failure injected at ${where} leaves nothing behind — and the same request then does all of it, in the app's order`, async () => {
      const p = await leaver(`h16-${table}-${event}-${createPoints.findIndex((x) => x[0] === where)}`);
      const before = await footprint(p);
      expect(before.loginActive).toBe(true);
      await inject(table, event, when(p));
      try {
        const failed = await offboard(p, day(-2));
        expect(failed.status, show(failed)).toBe(500);
      } finally {
        await uninject(table);
      }
      expect(await footprint(p), where).toEqual(before);
      const done = await offboard(p, day(-2));
      expect(done.status, show(done)).toBe(201);
      const after = await footprint(p);
      expect(after.offboardings).toHaveLength(1);
      expect([after.checklist, after.changes, after.activity, after.attention]).toEqual([6, 1, 2, 1]);
      expect(after.employee).toMatchObject({ status: 'terminated', employment_state: 'LEFT', end_reason: 'misconduct' });
      expect(after.loginActive).toBe(false);
      expect(after.assetDue).not.toBeNull();
      expect(after.order.map((o) => `${o.tbl} ${o.op}`)).toEqual(APP_CREATE_ORDER);
    }, 60_000);
  }

  it('C. H16 create, the login as the app does it: a last day still to come leaves it on and writes no flip; another park group’s admin writes nothing at all', async () => {
    const p = await leaver('h16-leaving');
    const done = await offboard(p, day(10));
    expect(done.status, show(done)).toBe(201);
    const after = await footprint(p);
    expect(after.employee).toMatchObject({ employment_state: 'LEAVING' });
    expect(after.loginActive).toBe(true);
    expect(after.order.map((o) => `${o.tbl} ${o.op}`)).toEqual(APP_CREATE_ORDER.filter((s) => s !== 'users UPDATE' && s !== 'attention_items INSERT'));
    const q2 = await leaver('h16-foreign');
    const before = await footprint(q2);
    for (const [method, body] of [
      ['POST', { offboardingType: 'termination', reasonCode: 'misconduct', lastWorkingDay: day(-2) }],
      ['PATCH', { lastWorkingDay: day(-5) }],
      ['GET', undefined],
    ] as const) {
      const answer = await call(method, `/api/employees/${q2.id}/offboarding`, { cookie: B.admin.cookie, ...(body ? { body } : {}) });
      expect(answer.status, `${method}: ${show(answer)}`).toBe(404);
    }
    expect(await footprint(q2)).toEqual(before);
  }, 60_000);

  const updatePoints: Array<[string, string, 'insert' | 'update' | 'delete', (p: Leaver) => string]> = [
    ['the offboarding row', 'employee_offboarding', 'update', (p) => `new.employee_id = '${p.id}'`],
    ['the employee', 'employees', 'update', (p) => `new.id = '${p.id}'`],
    ['the assets’ return dates', 'employee_assets', 'update', (p) => `new.employee_id = '${p.id}'`],
    ['the shifts removed after the new last day', 'schedule_assignments', 'delete', (p) => `old.employee_id = '${p.id}'`],
    ['the shifts-removed activity row', 'activity_log', 'insert', (p) => `new.employee_id = '${p.id}' and new.activity_type = 'schedule_assignment_removed'`],
  ];
  for (const [where, table, event, when] of updatePoints) {
    it(`C. H16 update: a failure injected at ${where} leaves the offboarding as it was`, async () => {
      const p = await leaver(`h16-upd-${table}-${event}`);
      expect((await offboard(p, day(20))).status).toBe(201);
      await q(`delete from ${LOG} where k = any($1)`, [[p.id, p.login]]);
      const before = await footprint(p);
      expect(before.shift).toBe(1);
      await inject(table, event, when(p));
      try {
        const failed = await call('PATCH', `/api/employees/${p.id}/offboarding`, { cookie: A.admin.cookie, body: { lastWorkingDay: day(2) } });
        expect(failed.status, show(failed)).toBe(500);
      } finally {
        await uninject(table);
      }
      expect(await footprint(p), where).toEqual(before);
      const ok = await call('PATCH', `/api/employees/${p.id}/offboarding`, { cookie: A.admin.cookie, body: { lastWorkingDay: day(2) } });
      expect(ok.status, show(ok)).toBe(200);
      const after = await footprint(p);
      expect(after.shift).toBe(0);
      expect(after.order.map((o) => `${o.tbl} ${o.op}`)).toEqual([
        'employee_offboarding UPDATE',
        'employees UPDATE',
        'employee_assets UPDATE',
        'schedule_assignments DELETE',
        'activity_log INSERT',
        'activity_log INSERT',
      ]);
    }, 60_000);
  }

  it('C. H16 update into the past: the state turns LEFT and the login stays on — the app switches it off only at the create', async () => {
    const p = await leaver('h16-upd-past');
    expect((await offboard(p, day(20))).status).toBe(201);
    const ok = await call('PATCH', `/api/employees/${p.id}/offboarding`, { cookie: A.admin.cookie, body: { lastWorkingDay: day(-3) } });
    expect(ok.status, show(ok)).toBe(200);
    const after = await footprint(p);
    expect(after.employee).toMatchObject({ employment_state: 'LEFT' });
    expect(after.loginActive).toBe(true);
  }, 60_000);

  // ── D. The PDF and storage gate, the refusals ───────────────────────────────

  let tA = '';
  let eAc = '';
  let eAy = '';
  let cA = '';
  let cAy = '';
  let letterA = '';
  let eventA = '';

  it('D. arrangement: A’s template, a signed contract on branch X and one on branch Y, a signed letter and an event — their PDFs where the app keeps them', async () => {
    const made = await call('POST', '/api/templates', { cookie: A.admin.cookie, body: { name: `ZZ R6RV A ${run}`, htmlBody: '<p>{{employee.full_name}}</p>' } });
    expect(made.status, show(made)).toBe(201);
    tA = made.body.id as string;
    eAc = await employee(A, A.x, 'gate-x');
    eAy = await employee(A, A.y, 'gate-y');
    cA = await signedContract(eAc, tA, A.admin.id);
    cAy = await signedContract(eAy, tA, A.admin.id);
    letterA = randomUUID();
    const letterPath = `/uploads/letters/signed_letter_${letterA}.pdf`;
    await q(
      `insert into employee_letters (id, employee_id, branch_id, letter_type, status, created_by, signed_pdf_path, signed_at)
       values ($1, $2, $3, 'warning', 'signed', $4, $5, now())`,
      [letterA, eAc, A.x, A.admin.id, letterPath],
    );
    layDown(letterPath, `%PDF-1.4 zz r6 review letter ${letterA}`);
    eventA = randomUUID();
    await q(`insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time) values ($1, $2, $3, 'birthday', $4, $5, '10:00')`, [
      eventA,
      A.tenant,
      A.x,
      `ZZ R6RV party ${run}`,
      day(14),
    ]);
  });

  const isPdf = (a: Answer) => a.text.startsWith('%PDF');
  const token = (contractId: string, expiry: number) =>
    `${contractId}:${expiry}:${createHmac('sha256', SESSION_SECRET).update(`${contractId}:${expiry}`).digest('hex')}`;

  it('D. the owner’s doors open: A’s admin reads the contract’s two PDFs and the letter; the signer’s own link opens with a good, unexpired token', async () => {
    for (const path of [`/api/contracts/${cA}/pdf`, `/api/contracts/${cA}/signed-pdf`, `/api/contracts/${cA}/download-signed-pdf-auth`, `/api/employees/${eAc}/letters/${letterA}/download`]) {
      const a = await call('GET', path, { cookie: A.admin.cookie });
      expect(a.status, `${path}: ${show(a)}`).toBe(200);
      expect(isPdf(a), path).toBe(true);
    }
    const link = await call('GET', `/api/contracts/${cA}/download-signed-pdf?token=${encodeURIComponent(token(cA, Date.now() + 60_000))}`);
    expect(link.status, show(link)).toBe(200);
    expect(isPdf(link)).toBe(true);
  });

  it('D. every unauthorised read is refused with no byte and no URL: signed out, another park group, another branch', async () => {
    const doors = [
      `/api/contracts/${cA}/pdf`,
      `/api/contracts/${cA}/signed-pdf`,
      `/api/contracts/${cA}/download-signed-pdf-auth`,
      `/api/employees/${eAc}/letters/${letterA}/download`,
      `/api/events/${eventA}/beo/pdf`,
    ];
    for (const path of doors) {
      const out = await call('GET', path);
      expect(out.status, `${path} signed out: ${show(out)}`).toBe(401);
      const other = await call('GET', path, { cookie: B.admin.cookie });
      expect([403, 404], `${path} for another park group: ${show(other)}`).toContain(other.status);
      for (const a of [out, other]) {
        expect(a.location, path).toBeNull();
        expect(isPdf(a), path).toBe(false);
      }
    }
    for (const path of [`/api/contracts/${cAy}/pdf`, `/api/contracts/${cAy}/signed-pdf`, `/api/contracts/${cAy}/download-signed-pdf-auth`]) {
      const branch = await call('GET', path, { cookie: A.limited.cookie });
      expect(branch.status, `${path}, a manager of branch X: ${show(branch)}`).toBe(403);
      expect(isPdf(branch)).toBe(false);
    }
  });

  it('D. the signer’s link: an expired token with a GOOD signature, a good token for another contract, and a forged one are each 401 with no byte', async () => {
    const expired = await call('GET', `/api/contracts/${cA}/download-signed-pdf?token=${encodeURIComponent(token(cA, Date.now() - 1_000))}`);
    expect(expired.status, show(expired)).toBe(401);
    expect(expired.body.message).toBe('Download token expired');
    const swapped = await call('GET', `/api/contracts/${cAy}/download-signed-pdf?token=${encodeURIComponent(token(cA, Date.now() + 60_000))}`);
    expect(swapped.status, show(swapped)).toBe(401);
    const forged = await call('GET', `/api/contracts/${cA}/download-signed-pdf?token=${encodeURIComponent(`${cA}:${Date.now() + 60_000}:${'a'.repeat(64)}`)}`);
    expect(forged.status, show(forged)).toBe(401);
    const none = await call('GET', `/api/contracts/${cA}/download-signed-pdf`);
    expect(none.status).toBe(401);
    for (const a of [expired, swapped, forged, none]) expect(isPdf(a) || a.location !== null).toBe(false);
  });

  it('D. guessed object keys and the raw storage path, through every file door the app has, signed out and signed in as another park group: nothing', async () => {
    const guesses = [
      `/uploads/contracts/signed_contract_${cA}.pdf`,
      `/uploads/contracts/finalized_contract_${cA}_v1.pdf`,
      `/uploads/letters/signed_letter_${letterA}.pdf`,
      `/api/files/contracts/signed_contract_${cA}.pdf`,
      `/api/files/letters/signed_letter_${letterA}.pdf`,
      `/api/files/uploads/signed_contract_${cA}.pdf`,
      `/api/files/beo-pdfs/${eventA}.pdf`,
      `/api/files/employee-documents/zz.pdf`,
      `/api/files/zz-r6-review/signed_contract_${cA}.pdf`,
      `/uploads/..%2Fuploads%2Fcontracts%2Fsigned_contract_${cA}.pdf`,
    ];
    for (const path of guesses) {
      for (const cookie of [undefined, B.admin.cookie, A.admin.cookie]) {
        const a = await call('GET', path, cookie ? { cookie } : {});
        expect(isPdf(a), `${path} (${cookie ? 'signed in' : 'signed out'}): ${show(a)}`).toBe(false);
        expect(a.location, path).toBeNull();
        expect([401, 403, 404], `${path}: ${show(a)}`).toContain(a.status);
      }
    }
  });

  // ── E. Park-group isolation per module ──────────────────────────────────────

  it('E. templates, policies, the catalogue and leave policies: B’s admin reaches none of A’s, at any door', async () => {
    const pA = await call('POST', '/api/policies', { cookie: A.admin.cookie, body: { title: `ZZ R6RV rules ${run}`, contentHtml: '<p>a</p>' } });
    expect(pA.status, show(pA)).toBe(201);
    expect((await call('POST', `/api/policies/${pA.body.id}/publish`, { cookie: A.admin.cookie })).status).toBe(200);
    const iA = await call('POST', '/api/assets/catalog', { cookie: A.admin.cookie, body: { name: `ZZ R6RV laptop ${run}` } });
    expect(iA.status, show(iA)).toBe(201);
    const lA = await call('POST', '/api/leave-policies', { cookie: A.admin.cookie, body: { name: `ZZ R6RV A ${run}`, daysWorkedRequired: 5, daysOffEarned: 2, branchId: A.x } });
    expect(lA.status, show(lA)).toBe(201);
    expect((await call('POST', `/api/templates/${tA}/assignments`, { cookie: A.admin.cookie, body: { branchId: A.x } })).status).toBe(200);
    const snapshot = async () => ({
      template: await q('select name, status, tenant_id from templates where id = $1', [tA]),
      assignments: await q('select branch_id from template_assignments where template_id = $1 order by branch_id', [tA]),
      policy: await q('select title, status, branch_id, is_company_wide, tenant_id from policy_documents where id = $1', [pA.body.id]),
      item: await q('select name, is_active, tenant_id from asset_catalog where id = $1', [iA.body.id]),
      leave: await q('select name, branch_id, tenant_id from leave_policies where id = $1', [lA.body.id]),
    });
    const before = await snapshot();
    const bTemplate = await call('POST', '/api/templates', { cookie: B.admin.cookie, body: { name: `ZZ R6RV B ${run}`, htmlBody: '<p>b</p>' } });
    expect(bTemplate.status).toBe(201);
    const doors: Array<[string, string, unknown]> = [
      ['GET', `/api/templates/${tA}`, undefined],
      ['PATCH', `/api/templates/${tA}`, { name: 'ZZ hijack', tenantId: B.tenant }],
      ['DELETE', `/api/templates/${tA}`, undefined],
      ['POST', `/api/templates/${tA}/fork`, { branchId: B.x }],
      ['POST', `/api/templates/${tA}/assignments`, { branchId: B.x }],
      ['POST', '/api/template-assignments', { templateId: tA, branchId: B.x }],
      ['POST', `/api/templates/${bTemplate.body.id}/assignments`, { branchId: A.x }],
      ['GET', `/api/policies/${pA.body.id}`, undefined],
      ['PATCH', `/api/policies/${pA.body.id}`, { title: 'ZZ hijack' }],
      ['POST', `/api/policies/${pA.body.id}/archive`, undefined],
      ['PATCH', `/api/leave-policies/${lA.body.id}`, { name: 'ZZ hijack' }],
      ['DELETE', `/api/leave-policies/${lA.body.id}`, undefined],
      ['GET', `/api/leave-policies?branchId=${A.x}`, undefined],
    ];
    for (const [method, path, body] of doors) {
      const a = await call(method, path, { cookie: B.admin.cookie, ...(body !== undefined ? { body } : {}) });
      expect(a.status, `${method} ${path}: ${show(a)}`).toBe(404);
    }
    // Removals through B answer as a missing one does, and change nothing.
    expect((await call('DELETE', `/api/templates/${tA}/assignments/${A.x}`, { cookie: B.admin.cookie })).status).toBe(204);
    expect((await call('DELETE', `/api/template-assignments/${tA}/${A.x}`, { cookie: B.admin.cookie })).status).toBe(204);
    expect(await snapshot()).toEqual(before);
    // B's lists hold none of A's.
    const listed = JSON.stringify([
      (await call('GET', '/api/templates', { cookie: B.admin.cookie })).body,
      (await call('GET', '/api/templates/with-assignments', { cookie: B.admin.cookie })).body,
      (await call('GET', `/api/template-assignments?templateId=${tA}`, { cookie: B.admin.cookie })).body,
      (await call('GET', '/api/policies', { cookie: B.admin.cookie })).body,
      (await call('GET', '/api/policies/latest-published', { cookie: B.admin.cookie })).body,
      (await call('GET', '/api/assets/catalog', { cookie: B.admin.cookie })).body,
      (await call('GET', '/api/leave-policies', { cookie: B.admin.cookie })).body,
    ]);
    for (const own of [tA, pA.body.id as string, iA.body.id as string, lA.body.id as string]) expect(listed).not.toContain(own);
    expect((await call('GET', `/api/templates/${tA}/contract-count`, { cookie: B.admin.cookie })).body).toEqual({ count: 0 });
  });

  it('E. contracts, letters, employee documents, assets and offboarding checklists: B’s admin reaches none of A’s, and nothing changes', async () => {
    const letter = await call('POST', `/api/employees/${eAc}/letters`, { cookie: A.admin.cookie, body: { letterType: 'warning' } });
    expect(letter.status, show(letter)).toBe(201);
    const doc = randomUUID();
    await q(
      `insert into employee_documents (id, employee_id, branch_id, document_type, file_name, file_path, mime_type, uploaded_by)
       values ($1, $2, $3, 'other', 'zz.pdf', '/api/files/employee-documents/zz.pdf', 'application/pdf', $4)`,
      [doc, eAc, A.x, A.admin.id],
    );
    const asset = await call('POST', `/api/employees/${eAc}/assets`, { cookie: A.admin.cookie, body: { assetNameSnapshot: 'ZZ keys' } });
    expect(asset.status, show(asset)).toBe(201);
    const leaving = await leaver('e-offboard');
    expect((await offboard(leaving, day(30))).status).toBe(201);
    const offboarding = (await q<{ id: string }>('select id from employee_offboarding where employee_id = $1', [leaving.id]))[0]!.id;
    const item = (await q<{ id: string }>('select id from offboarding_checklist where offboarding_id = $1 order by sort_order limit 1', [offboarding]))[0]!.id;
    const snapshot = async () => ({
      contracts: await q('select id, status, signing_status, archived_at, signing_token from contract_instances where employee_id = $1 order by id', [eAc]),
      letters: await q('select id, status from employee_letters where employee_id = $1 order by id', [eAc]),
      docs: await q('select id from employee_documents where employee_id = $1', [eAc]),
      assets: await q('select id, quantity, returned_at, expected_return_by from employee_assets where employee_id = $1 order by id', [eAc]),
      checklist: await q('select id, title, is_completed from offboarding_checklist where offboarding_id = $1 order by sort_order', [offboarding]),
    });
    const before = await snapshot();
    const notFound: Array<[string, string, unknown]> = [
      ['GET', `/api/contracts/${cA}`, undefined],
      ['DELETE', `/api/contracts/${cA}`, undefined],
      ['PATCH', `/api/contracts/${cA}/archive`, undefined],
      ['POST', `/api/contracts/${cA}/finalize`, undefined],
      ['POST', `/api/contracts/${cA}/send`, { to: 'zz@example.com', subject: 'x', body: 'x' }],
      ['POST', `/api/contracts/${cA}/generate-signing-link`, undefined],
      ['GET', `/api/letters/${letter.body.id}`, undefined],
      ['POST', `/api/employees/${eAc}/letters`, { letterType: 'warning' }],
      ['POST', `/api/employees/${eAc}/warnings`, { reasonCode: 'x', severity: 'x', incidentDate: day(0), description: 'x' }],
      ['GET', `/api/employees/${eAc}/documents`, undefined],
      ['GET', `/api/employees/${eAc}/documents/${doc}/file`, undefined],
      ['DELETE', `/api/employees/${eAc}/documents/${doc}`, undefined],
      ['GET', `/api/employees/${eAc}/assets`, undefined],
      ['POST', `/api/employees/${eAc}/assets`, { assetNameSnapshot: 'ZZ hijack' }],
      ['PATCH', `/api/assets/${asset.body.id}`, { quantity: 9 }],
      ['POST', `/api/assets/${asset.body.id}/return`, {}],
      ['GET', `/api/offboarding/${offboarding}/checklist`, undefined],
      ['POST', `/api/offboarding/${offboarding}/checklist`, { title: 'ZZ hijack' }],
      ['PATCH', `/api/offboarding/checklist/${item}`, { isCompleted: true, title: 'ZZ hijack' }],
      ['DELETE', `/api/offboarding/checklist/${item}`, undefined],
      ['GET', `/api/assets/unreturned/count?branchId=${A.x}`, undefined],
      ['GET', `/api/letters/unsigned/count?branchId=${A.x}`, undefined],
    ];
    const answers: string[] = [];
    for (const [method, path, body] of notFound) {
      const a = await call(method, path, { cookie: B.admin.cookie, ...(body !== undefined ? { body } : {}) });
      if (path.includes('/unsigned/count')) {
        // The count keeps to the park group: none of A's letters.
        expect(a.body, path).toEqual({ count: 0 });
      } else if (a.status !== 404) {
        answers.push(`${method} ${path}: ${show(a)}`);
      }
    }
    expect(answers).toEqual([]);
    expect(await snapshot()).toEqual(before);
    const lists = JSON.stringify([
      (await call('GET', '/api/contracts', { cookie: B.admin.cookie })).body,
      (await call('GET', `/api/employees/${eAc}/contracts`, { cookie: B.admin.cookie })).body,
      (await call('GET', `/api/employees/${eAc}/active-contract`, { cookie: B.admin.cookie })).body,
      (await call('GET', `/api/employees/${eAc}/letters`, { cookie: B.admin.cookie })).body,
    ]);
    for (const own of [cA, letter.body.id as string]) expect(lists).not.toContain(own);
  });

  it('E. the leave reads round 6 fenced keep to the park group, and the branch-wide balances still answer the branch’s own park group (the arrangement of finding 3, as fixed)', async () => {
    for (const path of [`/api/leave-balances?branchId=${A.x}`, `/api/leave-balances/employee/${eAc}`, `/api/sick-leave-balances?branchId=${A.x}`, `/api/employees/${eAc}/sick-leave-balance`, `/api/employees/${eAc}/all-leave-balances`]) {
      const a = await call('GET', path, { cookie: B.admin.cookie });
      expect([403, 404], `${path}: ${show(a)}`).toContain(a.status);
    }
    // The one it did not fence, as the app answers its own park group: A's branch, with A's people in it.
    const own = await call('GET', `/api/all-leave-balances?branchId=${A.x}`, { cookie: A.admin.cookie });
    expect(own.status, show(own)).toBe(200);
    expect((own.body as { employeeId: string }[]).map((r) => r.employeeId)).toContain(eAc);
    // And B's own branch answers B, with none of A's people.
    const bOwn = await call('GET', `/api/all-leave-balances?branchId=${B.x}`, { cookie: B.admin.cookie });
    expect(bOwn.status, show(bOwn)).toBe(200);
    expect((bOwn.body as { employeeId: string }[]).map((r) => r.employeeId)).not.toContain(eAc);
  });

  it('E. FINDING 3 (medium, fixed): `/api/all-leave-balances` keeps to the caller’s park group — another park group’s branch is the app’s 404, and none of its people are listed', async () => {
    const crossed = await call('GET', `/api/all-leave-balances?branchId=${A.x}`, { cookie: B.admin.cookie });
    expect(crossed.status, show(crossed)).toBe(404);
  });

  it('E. the HR employee doors as the app has them within the park group: A’s admin reads A’s employee, edits them, and switches their login off and on; a park group named in the edit is dropped (the arrangement of finding 1, as fixed)', async () => {
    const own = await employee(A, A.x, 'hr-own');
    expect((await call('GET', `/api/employees/${own}/documents`, { cookie: B.admin.cookie })).status).toBe(404);
    const read = await call('GET', `/api/employees/${own}`, { cookie: A.admin.cookie });
    expect(read.status, show(read)).toBe(200);
    expect(read.body.id).toBe(own);
    const edited = await call('PATCH', `/api/employees/${own}`, { cookie: A.admin.cookie, body: { nickname: 'ZZ renamed by A', tenantId: B.tenant } });
    expect(edited.status, show(edited)).toBe(200);
    const row = (await q<{ tenant_id: string; nickname: string }>('select tenant_id, nickname from employees where id = $1', [own]))[0]!;
    expect(row).toEqual({ tenant_id: A.tenant, nickname: 'ZZ renamed by A' });
    // The round 6 door that refuses B still refuses B: the person never left A.
    expect((await call('GET', `/api/employees/${own}/documents`, { cookie: B.admin.cookie })).status).toBe(404);
    // The login doors reach A's own person's login, as the app does.
    const login = await user(A.tenant, 'staff', `zz-r6rv-hr-login-${run}@example.com`, A.x);
    const withLogin = await employee(A, A.x, 'hr-own-login', { user_id: login });
    const off = await call('POST', `/api/employees/${withLogin}/toggle-login`, { cookie: A.admin.cookie });
    expect(off.status, show(off)).toBe(200);
    expect((await q<{ is_active: boolean }>('select is_active from users where id = $1', [login]))[0]!.is_active).toBe(false);
    const on = await call('POST', `/api/employees/${withLogin}/toggle-login`, { cookie: A.admin.cookie });
    expect(on.body).toMatchObject({ success: true, isActive: true });
  });

  it('E. FINDING 1 (high, fixed): the HR employee doors keep to the caller’s park group — another park group’s employee is the app’s 404 to read, edit, move or switch off', async () => {
    const victim = await employee(A, A.x, 'hr-cross-2');
    const read = await call('GET', `/api/employees/${victim}`, { cookie: B.admin.cookie });
    const edited = await call('PATCH', `/api/employees/${victim}`, { cookie: B.admin.cookie, body: { nickname: 'ZZ renamed by B', tenantId: B.tenant } });
    const row = (await q<{ tenant_id: string; nickname: string }>('select tenant_id, nickname from employees where id = $1', [victim]))[0]!;
    await q('update employees set tenant_id = $1, nickname = $2 where id = $3', [A.tenant, 'ZZ', victim]);
    const login = await user(A.tenant, 'staff', `zz-r6rv-hr-login-2-${run}@example.com`, A.x);
    const withLogin = await employee(A, A.x, 'hr-cross-login-2', { user_id: login });
    const toggled = await call('POST', `/api/employees/${withLogin}/toggle-login`, { cookie: B.admin.cookie });
    const active = (await q<{ is_active: boolean }>('select is_active from users where id = $1', [login]))[0]!.is_active;
    expect([read.status, edited.status, toggled.status]).toEqual([404, 404, 404]);
    expect(row).toEqual({ tenant_id: A.tenant, nickname: 'ZZ' });
    expect(active).toBe(true);
  });

  /** The wizard's own PDF, which the app writes under its uploads/ with local storage: removed at the end like the rest. */
  const forgetWizardPdfs = async (employeeId: string) => {
    for (const r of await q<{ pdf_path: string | null }>('select pdf_path from contract_instances where employee_id = $1', [employeeId])) {
      if (r.pdf_path?.startsWith('/uploads/')) laid.push(join(APP_DIR, r.pdf_path.slice(1)));
    }
  };

  it('E. the wizard’s six personal fields still land for B’s own employee, a login, branch or park group in its edits is dropped; and a link made before the fix is never switched off by B’s offboarding (the arrangement of finding 2, as fixed)', async () => {
    const bTemplate = await call('POST', '/api/templates', { cookie: B.admin.cookie, body: { name: `ZZ R6RV B wizard ${run}`, htmlBody: '<p>b</p>' } });
    const aLogin = await user(A.tenant, 'staff', `zz-r6rv-a-login-${run}@example.com`, A.x);
    const eB = await employee(B, B.x, 'wizard-link');
    const personal = { fullName: `ZZ R6RV wizard ${run}`, nickname: 'ZZ W', email: `zz-r6rv-wizard-${run}@example.com`, phone: '0812345678', address: 'ZZ road', nationalId: '1234' };
    const generated = await call('POST', '/api/contracts/generate', {
      cookie: B.admin.cookie,
      body: { employeeId: eB, templateId: bTemplate.body.id, mergeDataJson: { positionTitle: 'ZZ' }, employeeUpdates: { ...personal, userId: aLogin, branchId: A.x, tenantId: A.tenant } },
    });
    await forgetWizardPdfs(eB);
    // 201 with a Chromium to render the contract; without one the PDF step (after the commit) answers 500 — the edits are written either way.
    if (CHROMIUM) expect(generated.status, show(generated)).toBe(201);
    else expect(generated.text).toMatch(/Browser was not found|Chrom/i);
    const row = (await q('select full_name, nickname, email, phone, address, user_id, branch_id, tenant_id from employees where id = $1', [eB]))[0];
    expect(row).toEqual({ full_name: personal.fullName, nickname: 'ZZ W', email: personal.email, phone: '0812345678', address: 'ZZ road', user_id: null, branch_id: B.x, tenant_id: B.tenant });
    // A link made before the fix (written here in the database): B's offboarding with a past last day leaves A's login on.
    const linked = await employee(B, B.x, 'wizard-linked-before', { user_id: aLogin });
    const off = await call('POST', `/api/employees/${linked}/offboarding`, { cookie: B.admin.cookie, body: { offboardingType: 'termination', reasonCode: 'other', lastWorkingDay: day(-2) } });
    expect(off.status, show(off)).toBe(201);
    expect((await q('select employment_state from employees where id = $1', [linked]))[0]).toEqual({ employment_state: 'LEFT' });
    expect((await q<{ is_active: boolean }>('select is_active from users where id = $1', [aLogin]))[0]!.is_active).toBe(true);
  });

  it('E. FINDING 2 (medium, fixed): the wizard’s employee edits cannot link another park group’s login, and B’s offboarding never switches off A’s person’s login', async () => {
    const bTemplate = await call('POST', '/api/templates', { cookie: B.admin.cookie, body: { name: `ZZ R6RV B wizard2 ${run}`, htmlBody: '<p>b</p>' } });
    const aLogin = await user(A.tenant, 'staff', `zz-r6rv-a-login2-${run}@example.com`, A.x);
    const eB = await employee(B, B.x, 'wizard-link-2');
    await call('POST', '/api/contracts/generate', {
      cookie: B.admin.cookie,
      body: { employeeId: eB, templateId: bTemplate.body.id, mergeDataJson: { positionTitle: 'ZZ' }, employeeUpdates: { userId: aLogin } },
    });
    await forgetWizardPdfs(eB);
    await call('POST', `/api/employees/${eB}/offboarding`, { cookie: B.admin.cookie, body: { offboardingType: 'termination', reasonCode: 'other', lastWorkingDay: day(-2) } });
    expect((await q<{ user_id: string | null }>('select user_id from employees where id = $1', [eB]))[0]!.user_id).not.toBe(aLogin);
    expect((await q<{ is_active: boolean }>('select is_active from users where id = $1', [aLogin]))[0]!.is_active).toBe(true);
  });

  // The leave-policy fallback, weighed against the app's own rule.
  const policyFor = async (cookie: string, employeeId: string) => (await call('GET', `/api/employees/${employeeId}/leave-balance`, { cookie })).body.policyName as string;

  it('E. the default park group’s company-wide policy is read where a park group has none — the app’s rule while there was one set (the builder’s Q49 default)', async () => {
    const C = await parkGroup('c');
    C.admin.cookie = await signIn(C.admin.email);
    const eC = await employee(C, C.x, 'leave-c');
    const inherited = `ZZ R6RV default company-wide ${run}`;
    await q(`insert into leave_policies (tenant_id, branch_id, name, days_worked_required, days_off_earned, effective_from, is_active) values ($1, null, $2, 4, 1, now(), true)`, [
      DEFAULT,
      inherited,
    ]);
    expect(await policyFor(C.admin.cookie, eC)).toBe(inherited);
  });

  it('E. a park group with a company-wide policy of its own weighs its own and never the default park group’s newer one; its branch’s own, the newest of its own, wins (the arrangement of finding 4, as fixed: Q28’s rule on the company-wide slot)', async () => {
    const D = await parkGroup('d');
    D.admin.cookie = await signIn(D.admin.email);
    const eD = await employee(D, D.x, 'leave-d');
    const own = `ZZ R6RV D branch ${run}`;
    await q(
      `insert into leave_policies (tenant_id, branch_id, name, days_worked_required, days_off_earned, effective_from, is_active) values ($1, $2, $3, 6, 1, now() - interval '30 days', true)`,
      [D.tenant, D.x, own],
    );
    await q(
      `insert into leave_policies (tenant_id, branch_id, name, days_worked_required, days_off_earned, effective_from, is_active) values ($1, null, $2, 4, 1, now() - interval '60 days', true)`,
      [D.tenant, `ZZ R6RV D company-wide ${run}`],
    );
    const newer = `ZZ R6RV default newer ${run}`;
    await q(`insert into leave_policies (tenant_id, branch_id, name, days_worked_required, days_off_earned, effective_from, is_active) values ($1, null, $2, 3, 1, now() + interval '1 hour', true)`, [
      DEFAULT,
      newer,
    ]);
    expect(await policyFor(D.admin.cookie, eD)).toBe(own);
  });

  it('E. FINDING 4 (low, fixed): with a branch policy of its own and no company-wide one, a park group still weighs the default park group’s company-wide policy by the app’s latest-effective rule', async () => {
    const E = await parkGroup('e');
    E.admin.cookie = await signIn(E.admin.email);
    const eE = await employee(E, E.x, 'leave-e');
    await q(
      `insert into leave_policies (tenant_id, branch_id, name, days_worked_required, days_off_earned, effective_from, is_active) values ($1, $2, $3, 6, 1, now() - interval '30 days', true)`,
      [E.tenant, E.x, `ZZ R6RV E branch ${run}`],
    );
    const newer = `ZZ R6RV default newest ${run}`;
    await q(`insert into leave_policies (tenant_id, branch_id, name, days_worked_required, days_off_earned, effective_from, is_active) values ($1, null, $2, 3, 1, now() + interval '2 hours', true)`, [
      DEFAULT,
      newer,
    ]);
    expect(await policyFor(E.admin.cookie, eE)).toBe(newer);
  });

  // ── F. The org chart ────────────────────────────────────────────────────────

  it('F. the org chart’s GET writes only its own park group’s missing nodes: B’s read mints nothing for A, and A’s branch scope is refused with nothing written', async () => {
    const nodes = (tenant: string) => count('select count(*) as n from org_nodes where tenant_id = $1', [tenant]);
    const crossNodes = () =>
      count(`select count(*) as n from org_nodes n join employees e on e.id = n.person_employee_id where n.tenant_id <> e.tenant_id`);
    const aBefore = await nodes(A.tenant);
    const bEmployee = await employee(B, B.x, 'org-b');
    for (const query of ['mode=live&scopeType=company', 'mode=draft&scopeType=company', `mode=live&scopeType=branch&scopeBranchId=${B.x}`]) {
      const a = await call('GET', `/api/org-chart/nodes?${query}`, { cookie: B.admin.cookie });
      expect(a.status, `${query}: ${show(a)}`).toBe(200);
    }
    expect(await nodes(A.tenant)).toBe(aBefore);
    expect(await count('select count(*) as n from org_nodes where person_employee_id = $1 and tenant_id = $2', [bEmployee, B.tenant])).toBeGreaterThan(0);
    for (const query of [`mode=live&scopeType=branch&scopeBranchId=${A.x}`, `mode=draft&scopeType=branch&scopeBranchId=${A.y}`]) {
      const a = await call('GET', `/api/org-chart/nodes?${query}`, { cookie: B.admin.cookie });
      expect(a.status, `${query}: ${show(a)}`).toBe(403);
    }
    expect(await nodes(A.tenant)).toBe(aBefore);
    // A's own read mints A's, and only for A's people.
    expect((await call('GET', '/api/org-chart/nodes?mode=live&scopeType=company', { cookie: A.admin.cookie })).status).toBe(200);
    expect(await nodes(A.tenant)).toBeGreaterThan(aBefore);
    expect(await crossNodes()).toBe(0);
    // B's chart lists none of A's nodes.
    const bChart = JSON.stringify((await call('GET', '/api/org-chart/nodes?mode=live&scopeType=company', { cookie: B.admin.cookie })).body);
    expect(bChart).not.toContain(eAc);
  });

  // ── G. The re-review: the fix round attacked ────────────────────────────────
  // (the header's RE-REVIEW block). What held is proven first, independently of
  // the builder's own drive; then the doors the census did not count.

  /** Everything of one employee a door could write: their row, their login's, and every row naming them by `employee_id`. */
  const footprint45 = async (employeeId: string, login: string) => {
    const tables = (
      await q<{ table_name: string }>(
        `select c.table_name from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
          where c.table_schema = 'otoapp' and c.column_name = 'employee_id' and t.table_type = 'BASE TABLE' order by 1`,
      )
    ).map((r) => r.table_name);
    const rows: Record<string, string> = {};
    for (const t of tables) {
      rows[t] = (
        await q<{ h: string }>(`select md5(coalesce(string_agg(row_to_json(x)::text, '|' order by row_to_json(x)::text), '')) as h from ${t} x where employee_id::text = $1`, [employeeId])
      )[0]!.h;
    }
    return {
      employee: (await q<{ r: string }>('select row_to_json(e)::text as r from employees e where id = $1', [employeeId]))[0]!.r,
      login: (await q<{ r: string }>('select row_to_json(u)::text as r from users u where id = $1', [login]))[0]!.r,
      users: await count('select count(*) as n from users'),
      people: await count('select count(*) as n from people'),
      rows,
    };
  };

  it('G. F1 held, re-driven: the census is exactly the registered `/api/employees/:id*` doors, and as B’s all-branch MANAGER (the builder drove the admin) none of the 45 answers A’s employee or writes anything of theirs', async () => {
    const lib = readFileSync(join(APP_SERVER, 'lib', 'employeeParkGroups.ts'), 'utf8');
    const census = [...lib.matchAll(/\{ method: "(\w+)", path: "([^"]+)", fence: "\w+", foreign: "[\w-]+" \}/g)].map((m) => `${m[1]} ${m[2]}`);
    const registered = [...readFileSync(join(APP_SERVER, 'routes.ts'), 'utf8').matchAll(/app\.(get|post|put|patch|delete)\(\s*"(\/api\/employees\/:[^"]+)"/g)].map(
      (m) => `${m[1]!.toUpperCase()} ${m[2]}`,
    );
    expect(census).toHaveLength(45);
    expect([...census].sort()).toEqual([...registered].sort());
    const mgrEmail = `zz-r6rr-b-allmgr-${run}@example.com`;
    await user(B.tenant, 'manager', mgrEmail, null);
    const bManager = await signIn(mgrEmail);
    const login = await user(A.tenant, 'staff', `zz-r6rr-door-login-${run}@example.com`, A.x);
    const victim = await employee(A, A.x, 'rr-doors', { user_id: login, start_date: new Date(Date.now() - 30 * 86_400_000), timeclock_pin_hash: 'zz' });
    const role = (await q<{ id: string }>('insert into roles (tenant_id, name) values ($1, $2) returning id', [DEFAULT, `ZZ R6RR role ${run}`]))[0]!.id;
    await q('insert into employee_roles (employee_id, role_id) values ($1, $2)', [victim, role]);
    const change = (await q<{ id: string }>("insert into employee_changes (employee_id, change_type, effective_date, note, created_by) values ($1, 'title_change', now(), 'ZZ', $2) returning id", [victim, A.admin.id]))[0]!.id;
    const doc = randomUUID();
    await q(
      `insert into employee_documents (id, employee_id, branch_id, document_type, file_name, file_path, mime_type, uploaded_by)
       values ($1, $2, $3, 'other', 'zz.pdf', '/api/files/employee-documents/zz-r6rr.pdf', 'application/pdf', $4)`,
      [doc, victim, A.x, A.admin.id],
    );
    const letter = randomUUID();
    await q("insert into employee_letters (id, employee_id, branch_id, letter_type, status, created_by) values ($1, $2, $3, 'warning', 'draft', $4)", [letter, victim, A.x, A.admin.id]);
    await q('insert into staff_cost_allocations (tenant_id, employee_id, branch_id, allocation_percent) values ($1, $2, $3, 100)', [A.tenant, victim, A.x]);
    const bodies: Record<string, unknown> = {
      'PATCH /api/employees/:id/roles': { roleIds: [] },
      'PATCH /api/employees/:id/department': { departmentId: null },
      'PATCH /api/employees/:id': { nickname: 'ZZ hijack', tenantId: B.tenant, branchId: B.x, userId: B.admin.id },
      'POST /api/employees/:id/enable-login': { password: 'zz-hijack-password', email: `zz-r6rr-hijack-${run}@example.com` },
      'PUT /api/employees/:id/cost-allocations': { allocations: [{ branchId: B.x, allocationPercent: 100 }] },
      'POST /api/employees/:employeeId/changes': { changeType: 'title_change', effectiveDate: day(0), newTitle: 'ZZ hijack' },
      'PATCH /api/employees/:employeeId/changes/:changeId': { note: 'ZZ hijack', employeeId: victim },
      'POST /api/employees/:employeeId/transfer': { effectiveDate: day(1), newBranchId: B.x },
      'POST /api/employees/:employeeId/offboarding': { offboardingType: 'termination', reasonCode: 'misconduct', lastWorkingDay: day(-2) },
      'PATCH /api/employees/:employeeId/offboarding': { lastWorkingDay: day(5) },
      'POST /api/employees/:employeeId/warnings': { reasonCode: 'x', severity: 'x', incidentDate: day(0), description: 'x' },
      'POST /api/employees/:employeeId/letters': { letterType: 'warning' },
      'POST /api/employees/:employeeId/assets': { assetNameSnapshot: 'ZZ hijack' },
      'POST /api/employees/:employeeId/pin': { pin: '1234' },
    };
    const at = (path: string) => path.replace(/:id\b|:employeeId\b/, victim).replace(':changeId', change).replace(':docId', doc).replace(':letterId', letter);
    const before = await footprint45(victim, login);
    const wrong: string[] = [];
    for (const door of census) {
      const [method, path] = door.split(' ') as [string, string];
      let answer: { status: number; text: string };
      if (door === 'POST /api/employees/:employeeId/documents') {
        const form = new FormData();
        form.append('documentType', 'other');
        form.append('file', new Blob(['%PDF-1.4 zz'], { type: 'application/pdf' }), 'zz.pdf');
        const res = await fetch(`${ORIGIN}${at(path)}`, { method, headers: { cookie: bManager }, body: form });
        answer = { status: res.status, text: await res.text() };
      } else {
        answer = await call(method, at(path), { cookie: bManager, ...(bodies[door] !== undefined ? { body: bodies[door] } : {}) });
      }
      const refused =
        (answer.status === 404 && answer.text === '{"message":"Employee not found"}') ||
        (answer.status === 200 && (answer.text === '[]' || answer.text === 'null')) ||
        answer.status === 403;
      if (!refused || answer.text.includes(victim) || answer.text.includes('rr-doors')) wrong.push(`${door}: ${answer.status} ${answer.text.slice(0, 160)}`);
    }
    expect(wrong).toEqual([]);
    expect(await footprint45(victim, login)).toEqual(before);
  }, 120_000);

  it('G. F2 held, re-driven: the wizard takes the six personal fields of the app’s own client and no other column — status, state, person, department, login, authors, face and PIN sent in its edits all drop', async () => {
    const client = readFileSync(join(APP_DIR, 'client', 'src', 'pages', 'contract-wizard-page.tsx'), 'utf8');
    const sent = /const employeeUpdates = checkEmployeeEdits\(\) \? \{([\s\S]*?)\} : undefined;/.exec(client)?.[1];
    expect(sent, 'the wizard client builds employeeUpdates').toBeTruthy();
    const clientFields = [...sent!.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    const lib = readFileSync(join(APP_SERVER, 'lib', 'employeeParkGroups.ts'), 'utf8');
    const serverFields = /WIZARD_EMPLOYEE_FIELDS = \[([^\]]*)\]/.exec(lib)![1]!.match(/"(\w+)"/g)!.map((f) => f.slice(1, -1));
    expect(serverFields).toEqual(clientFields);
    expect(serverFields).toEqual(['fullName', 'nickname', 'email', 'phone', 'address', 'nationalId']);
    const bTemplate = await call('POST', '/api/templates', { cookie: B.admin.cookie, body: { name: `ZZ R6RR wizard ${run}`, htmlBody: '<p>b</p>' } });
    const eB = await employee(B, B.x, 'rr-wizard', { employment_state: 'ACTIVE' });
    const before = (await q('select status, employment_state, person_id, primary_department_id, user_id, updated_by, profile_photo_updated_by, face_id, timeclock_pin_hash, branch_id, tenant_id from employees where id = $1', [eB]))[0];
    const deptA = (await q<{ id: string }>('insert into departments (tenant_id, name) values ($1, $2) returning id', [A.tenant, `ZZ R6RR dept ${run}`]))[0]!.id;
    await call('POST', '/api/contracts/generate', {
      cookie: B.admin.cookie,
      body: {
        employeeId: eB,
        templateId: bTemplate.body.id,
        mergeDataJson: { positionTitle: 'ZZ' },
        employeeUpdates: {
          nickname: 'ZZ RR',
          status: 'terminated',
          employmentState: 'LEFT',
          personId: randomUUID(),
          primaryDepartmentId: deptA,
          userId: A.admin.id,
          updatedBy: A.admin.id,
          profilePhotoUpdatedBy: A.admin.id,
          faceId: 'zz-face',
          timeclockPinHash: 'zz-pin',
          branchId: A.x,
          tenantId: A.tenant,
        },
      },
    });
    await forgetWizardPdfs(eB);
    const after = (await q('select status, employment_state, person_id, primary_department_id, user_id, updated_by, profile_photo_updated_by, face_id, timeclock_pin_hash, branch_id, tenant_id from employees where id = $1', [eB]))[0] as Record<string, unknown>;
    // The wizard stamps its own author, as the app does; everything else sent is dropped.
    expect({ ...after, updated_by: null }).toEqual({ ...(before as Record<string, unknown>), updated_by: null });
    expect(after.updated_by).toBe(B.admin.id);
    expect((await q('select nickname from employees where id = $1', [eB]))[0]).toEqual({ nickname: 'ZZ RR' });
  });

  it('G. F4 held, against the app’s pre-lift code: on three fixtures (the branch policy newer; the company-wide newer; no policy of its own, falling to the default’s) the lifted balance is the pre-lift query’s pick and arithmetic, with and without a branch', async () => {
    const P = await parkGroup('p');
    P.admin.cookie = await signIn(P.admin.email);
    const withBranch = await employee(P, P.x, 'rr-leave-x');
    const noBranch = await employee(P, null, 'rr-leave-none');
    const plan = randomUUID();
    await q('insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)', [plan, P.tenant, P.x, day(-20)]);
    const group = randomUUID();
    await q('insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)', [group, P.tenant, P.x, `ZZ R6RR ${run}`]);
    const row = randomUUID();
    await q(`insert into schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time, label) values ($1, $2, $3, $4, $5, '09:00', '17:00', 'ZZ')`, [
      row,
      P.tenant,
      P.x,
      group,
      plan,
    ]);
    for (const e of [withBranch, noBranch]) {
      for (let i = 1; i <= 13; i++) {
        await q('insert into schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, employee_id) values ($1, $2, $3, $4, $5, $6)', [randomUUID(), P.tenant, plan, row, day(-i), e]);
      }
    }
    // Only the fixture's policies are live while it runs: the pre-lift query read ONE set, so nothing else may stand in it.
    const live = (await q<{ id: string }>('select id from leave_policies where is_active')).map((r) => r.id);
    await q('update leave_policies set is_active = false where id = any($1)', [live]);
    const made: string[] = [];
    const policy = async (tenant: string, branch: string | null, name: string, worked: number, earned: number, hours: number) => {
      const id = (
        await q<{ id: string }>(
          `insert into leave_policies (tenant_id, branch_id, name, days_worked_required, days_off_earned, effective_from, is_active)
           values ($1, $2, $3, $4, $5, now() + ($6 || ' hours')::interval, true) returning id`,
          [tenant, branch, `${name} ${run}`, worked, earned, String(hours)],
        )
      )[0]!.id;
      made.push(id);
    };
    /** imports/oto-app server/storage.ts:5805-5824 and :5849-5890, verbatim as SQL and arithmetic, over the one set. */
    const preLift = async (branchId: string | null) => {
      const [p] = await q<{ name: string; w: number; e: number }>(
        `select name, days_worked_required as w, days_off_earned as e from leave_policies where is_active ${branchId ? 'and (branch_id = $1 or branch_id is null)' : ''}
          order by effective_from desc limit 1`,
        branchId ? [branchId] : [],
      );
      return { policyName: p?.name ?? null, daysEarned: Math.floor(13 / (p?.w || 5)) * (p?.e || 2) };
    };
    const lifted = async (employeeId: string) => {
      const b = (await call('GET', `/api/employees/${employeeId}/leave-balance`, { cookie: P.admin.cookie })).body as { policyName: string | null; daysEarned: number };
      return { policyName: b.policyName, daysEarned: b.daysEarned };
    };
    const results: Record<string, unknown> = {};
    try {
      const fixtures: Array<[string, () => Promise<void>]> = [
        ['branch policy newer', async () => {
          await policy(DEFAULT, null, 'ZZ R6RR F1 default company-wide', 4, 1, -48);
          await policy(P.tenant, P.x, 'ZZ R6RR F1 P branch', 3, 1, -24);
        }],
        ['company-wide newer', async () => {
          await policy(P.tenant, P.x, 'ZZ R6RR F2 P branch', 3, 1, -48);
          await policy(DEFAULT, null, 'ZZ R6RR F2 default company-wide', 6, 2, -24);
        }],
        ['none of its own: the default’s', async () => {
          await policy(DEFAULT, null, 'ZZ R6RR F3 default older', 2, 1, -72);
          await policy(DEFAULT, null, 'ZZ R6RR F3 default newest', 5, 3, -24);
        }],
      ];
      for (const [label, arrange] of fixtures) {
        await arrange();
        for (const [where, e, branch] of [['branch', withBranch, P.x], ['no branch', noBranch, null]] as const) {
          const expected = await preLift(branch);
          expect(expected.policyName, `${label}, ${where}: the fixture is live`).not.toBeNull();
          results[`${label}, ${where}`] = { expected, got: await lifted(e) };
        }
        await q('update leave_policies set is_active = false where id = any($1)', [made]);
      }
    } finally {
      await q('update leave_policies set is_active = false where id = any($1)', [made]);
      await q('update leave_policies set is_active = true where id = any($1)', [live]);
    }
    for (const [k, v] of Object.entries(results)) {
      const { expected, got } = v as { expected: unknown; got: unknown };
      expect(got, k).toEqual(expected);
    }
    expect(Object.keys(results)).toHaveLength(6);
  });

  // ── The doors the census did not count ──────────────────────────────────────

  interface Xlsx {
    utils: { aoa_to_sheet(rows: unknown[][]): unknown; book_new(): unknown; book_append_sheet(book: unknown, sheet: unknown, name: string): void };
    write(book: unknown, opts: { type: 'buffer'; bookType: 'xlsx' }): Uint8Array;
  }
  interface PreviewRow {
    rowNumber: number;
    matchedEmployeeId: string | null;
    branchId: string | null;
    error: string | null;
    currentData: Record<string, unknown>;
  }
  /** The app's Excel import screen's upload: a sheet with the template's headers, as its client posts it. */
  const importPreview = async (cookie: string, rows: unknown[][]) => {
    const XLSX = createRequire(join(APP_DIR, 'package.json'))('xlsx') as Xlsx;
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Employees');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))]), 'zz-r6rr.xlsx');
    const res = await fetch(`${ORIGIN}/api/employees/bulk-upload-preview`, { method: 'POST', headers: { cookie }, body: form });
    const text = await res.text();
    return { status: res.status, text, rows: (JSON.parse(text) as { previewRows: PreviewRow[] }).previewRows };
  };
  const branchName = async (id: string) => (await q<{ name: string }>('select name from branches where id = $1', [id]))[0]!.name;
  const HEADERS = ['Full Name', 'Email Address', 'Branch', 'Monthly Salary (THB)'];

  it('G. the employee list, the Excel import and the reorder as the app has them within the park group: A lists A’s employee; A’s import matches them by email with their current pay, places by A’s branch name and applies; A’s reorder writes A’s order (the arrangement of finding 6, as fixed)', async () => {
    const eA = await employee(A, A.x, 'rr-own', { default_merge_data: JSON.stringify({ positionTitle: 'ZZ', salaryThb: 40000 }), tax_id_number: 'ZZ-RR-A-TAX' });
    const own = (await q<{ email: string; full_name: string }>('select email, full_name from employees where id = $1', [eA]))[0]!;
    const list = await call('GET', '/api/employees', { cookie: A.admin.cookie });
    expect(list.status, show(list)).toBe(200);
    expect((list.body as { id: string }[]).map((e) => e.id)).toContain(eA);
    const preview = await importPreview(A.admin.cookie, [HEADERS, [own.full_name, own.email, await branchName(A.y), 41000]]);
    expect(preview.status, preview.text).toBe(200);
    expect(preview.rows[0]).toMatchObject({ matchedEmployeeId: eA, branchId: A.y, error: null });
    expect(preview.rows[0]!.currentData).toMatchObject({ salary: 40000, taxIdNumber: 'ZZ-RR-A-TAX' });
    const applied = await call('POST', '/api/employees/bulk-update', { cookie: A.admin.cookie, body: { rows: preview.rows } });
    expect(applied.status, show(applied)).toBe(200);
    expect((await q('select branch_id, default_merge_data from employees where id = $1', [eA]))[0]).toEqual({ branch_id: A.y, default_merge_data: { positionTitle: 'ZZ', salaryThb: 41000 } });
    await q('update employees set display_order = 7 where id = $1', [eA]);
    expect((await call('POST', '/api/employees/reorder', { cookie: A.admin.cookie, body: { orderedIds: [eA] } })).status).toBe(200);
    expect((await q<{ display_order: number }>('select display_order from employees where id = $1', [eA]))[0]!.display_order).toBe(0);
    // B's own list answers B its own people.
    const eB = await employee(B, B.x, 'rr-b-own');
    expect(((await call('GET', '/api/employees', { cookie: B.admin.cookie })).body as { id: string }[]).map((e) => e.id)).toContain(eB);
  });

  it('G. FINDING 6 (high, fixed): the list, the Excel import and the reorder keep to the caller’s park group — B lists none of A’s people, its import neither matches, shows nor writes A’s employee nor places anyone on A’s branch, and its reorder writes none of A’s', async () => {
    const eA = await employee(A, A.x, 'rr-victim', { default_merge_data: JSON.stringify({ positionTitle: 'ZZ', salaryThb: 50000 }), tax_id_number: 'ZZ-RR-A-TAX-2', display_order: 9 });
    const victim = (await q<{ email: string; full_name: string }>('select email, full_name from employees where id = $1', [eA]))[0]!;
    const before = (await q<{ r: string }>('select row_to_json(e)::text as r from employees e where id = $1', [eA]))[0]!.r;
    const listed = [
      (await call('GET', '/api/employees', { cookie: B.admin.cookie })).text,
      (await call('GET', `/api/employees?branchId=${A.x}`, { cookie: B.admin.cookie })).text,
      (await call('GET', '/api/employees', { cookie: B.limited.cookie })).text,
    ];
    // B's import screen, as B's manager uses it: a row with A's employee's email, and a new row naming A's branch.
    const preview = await importPreview(B.admin.cookie, [HEADERS, [victim.full_name, victim.email, await branchName(B.x), 1], [`ZZ R6RR new ${run}`, `zz-r6rr-new-${run}@example.com`, await branchName(A.y), 2]]);
    await call('POST', '/api/employees/bulk-update', {
      cookie: B.admin.cookie,
      body: {
        rows: [
          ...preview.rows,
          { rowNumber: 9, matchedEmployeeId: eA, branchId: B.x, data: { fullName: 'ZZ renamed by B', salary: 1 } },
          { rowNumber: 10, isNew: true, branchId: A.y, data: { fullName: 'ZZ R6RR B on A', email: `zz-r6rr-b-on-a-${run}@example.com` } },
        ],
      },
    });
    await call('POST', '/api/employees/reorder', { cookie: B.admin.cookie, body: { orderedIds: [eA] } });
    const after = (await q<{ r: string }>('select row_to_json(e)::text as r from employees e where id = $1', [eA]))[0]!.r;
    const strangersOnA = await count('select count(*) as n from employees where branch_id = any($1) and tenant_id <> $2', [[A.x, A.y], A.tenant]);
    expect(listed.filter((text) => text.includes(eA))).toEqual([]);
    expect(preview.text).not.toContain(eA);
    expect(preview.text).not.toContain('ZZ-RR-A-TAX-2');
    expect(preview.text).not.toContain(A.y);
    expect(after).toBe(before);
    expect(strangersOnA).toBe(0);
  });

  it('G. timekeeping and the role holders as the app has them within the park group: A’s admin overrides A’s employee’s clock, reads their timekeeping, and sets a shared role’s holders (the arrangement of finding 7, as fixed)', async () => {
    const eA = await employee(A, A.x, 'rr-tk-own');
    const override = await call('POST', '/api/time-events/override', { cookie: A.admin.cookie, body: { employeeId: eA, branchId: A.x, eventType: 'IN', eventTime: new Date().toISOString(), notes: 'ZZ R6RR' } });
    expect(override.status, show(override)).toBe(201);
    expect(await count('select count(*) as n from time_events where employee_id = $1', [eA])).toBe(1);
    const read = await call('GET', `/api/timekeeping/employee/${eA}`, { cookie: A.admin.cookie });
    expect(read.status, show(read)).toBe(200);
    const role = (await q<{ id: string }>('insert into roles (tenant_id, name) values ($1, $2) returning id', [DEFAULT, `ZZ R6RR shared own ${run}`]))[0]!.id;
    const set = await call('PATCH', `/api/roles/${role}/employees`, { cookie: A.admin.cookie, body: { employeeIds: [eA] } });
    expect(set.status, show(set)).toBe(200);
    expect(((await call('GET', `/api/roles/${role}/employees`, { cookie: A.admin.cookie })).body as { employeeId: string }[]).map((r) => r.employeeId)).toEqual([eA]);
  });

  it('G. FINDING 7 (medium, fixed): the employee-id doors outside `/api/employees*` keep to the caller’s park group — B’s admin writes no clock event on A’s employee and reads none of their timekeeping, and B’s role-holder write neither strips nor lists A’s holders', async () => {
    const eA = await employee(A, A.x, 'rr-tk-victim');
    const eB = await employee(B, B.x, 'rr-tk-b');
    const role = (await q<{ id: string }>('insert into roles (tenant_id, name) values ($1, $2) returning id', [DEFAULT, `ZZ R6RR shared ${run}`]))[0]!.id;
    await q('insert into employee_roles (employee_id, role_id) values ($1, $2)', [eA, role]);
    const override = await call('POST', '/api/time-events/override', { cookie: B.admin.cookie, body: { employeeId: eA, branchId: B.x, eventType: 'IN', eventTime: new Date().toISOString(), notes: 'ZZ by B' } });
    const read = await call('GET', `/api/timekeeping/employee/${eA}`, { cookie: B.admin.cookie });
    const holders = await call('GET', `/api/roles/${role}/employees`, { cookie: B.admin.cookie });
    await call('PATCH', `/api/roles/${role}/employees`, { cookie: B.admin.cookie, body: { employeeIds: [eB] } });
    const clockEvents = await count('select count(*) as n from time_events where employee_id = $1', [eA]);
    const stillHolds = await count('select count(*) as n from employee_roles where employee_id = $1 and role_id = $2', [eA, role]);
    expect([override.status, clockEvents]).toEqual([404, 0]);
    expect([read.status, read.text]).toEqual([404, '{"message":"Employee not found"}']);
    expect(holders.text).not.toContain(eA);
    expect(stillHolds).toBe(1);
  });

  it('G. the employee create as the app has it: B creates its employee with B’s own department (the arrangement of finding 8, as fixed)', async () => {
    const deptB = (await q<{ id: string }>('insert into departments (tenant_id, name) values ($1, $2) returning id', [B.tenant, `ZZ R6RR B dept ${run}`]))[0]!.id;
    const email = `zz-r6rr-create-own-${run}@example.com`;
    const created = await call('POST', '/api/employees', { cookie: B.admin.cookie, body: { fullName: 'ZZ R6RR create', nickname: 'ZZ', email, branchId: B.x, primaryDepartmentId: deptB } });
    expect(created.status, show(created)).toBe(201);
    expect((await q('select tenant_id, primary_department_id from employees where email = $1', [email]))[0]).toEqual({ tenant_id: B.tenant, primary_department_id: deptB });
  });

  it('G. FINDING 8 (low, fixed): the employee create, like the edit, takes no other park group’s department or user ids', async () => {
    const deptA = (await q<{ id: string }>('insert into departments (tenant_id, name) values ($1, $2) returning id', [A.tenant, `ZZ R6RR A dept ${run}`]))[0]!.id;
    const email = `zz-r6rr-create-${run}@example.com`;
    await call('POST', '/api/employees', {
      cookie: B.admin.cookie,
      body: { fullName: 'ZZ R6RR create cross', nickname: 'ZZ', email, branchId: B.x, primaryDepartmentId: deptA, updatedBy: A.admin.id, profilePhotoUpdatedBy: A.admin.id },
    });
    expect(
      await count('select count(*) as n from employees where email = $1 and (primary_department_id = $2 or updated_by = $3 or profile_photo_updated_by = $3)', [email, deptA, A.admin.id]),
    ).toBe(0);
  });

  // ── H. The final re-review: the second fix round attacked ───────────────────
  // (the header's FINAL RE-REVIEW block). Every door the round touched, driven
  // as B's admin AND B's all-branch manager, with the whole database weighed
  // before and after; then the same doors within the park group; then what
  // the drive found beside them.

  /** Every row of every app table, one hash per table: what a refusal must leave as it was (the session store aside — every request touches it — and this suite's own logs). */
  const everything = async () => {
    const tables = (
      await q<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'otoapp' and table_type = 'BASE TABLE' and table_name <> 'session' and table_name not like 'zz\\_%' order by 1`,
      )
    ).map((r) => r.table_name);
    const out: Record<string, string> = {};
    for (const t of tables) out[t] = (await q<{ h: string }>(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from "${t}" x`))[0]!.h;
    return out;
  };
  interface XlsxRead {
    read(data: Uint8Array, opts: { type: 'buffer' }): { SheetNames: string[]; Sheets: Record<string, unknown> };
    utils: { sheet_to_json(sheet: unknown, opts: { header: 1 }): unknown[][] };
  }
  /** The sample row's branch name in the import template, as the app's screen downloads it. */
  const templateBranch = async (cookie: string) => {
    const res = await fetch(`${ORIGIN}/api/employees/bulk-template`, { headers: { cookie } });
    const XLSX = createRequire(join(APP_DIR, 'package.json'))('xlsx') as XlsxRead;
    const book = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]!], { header: 1 });
    return { status: res.status, branch: String(rows[1]![(rows[0] as string[]).indexOf('Branch')]) };
  };
  /** A rota slot of `g`'s, three days out, for `employeeId`. */
  const rotaSlot = async (g: ParkGroup, employeeId: string) => {
    const plan = randomUUID();
    await q('insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)', [plan, g.tenant, g.x, day(1)]);
    const group = randomUUID();
    await q('insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)', [group, g.tenant, g.x, `ZZ R6FR ${run}`]);
    const row = randomUUID();
    await q(
      `insert into schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time, label)
       values ($1, $2, $3, $4, $5, '09:00', '17:00', 'ZZ R6FR')`,
      [row, g.tenant, g.x, group, plan],
    );
    const slot = randomUUID();
    await q('insert into schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, employee_id) values ($1, $2, $3, $4, $5, $6)', [slot, g.tenant, plan, row, day(3), employeeId]);
    return slot;
  };
  let bAllManager = '';
  const bManagerCookie = async () => {
    if (bAllManager) return bAllManager;
    const email = `zz-r6fr-b-allmgr-${run}@example.com`;
    await user(B.tenant, 'manager', email, null);
    bAllManager = await signIn(email);
    return bAllManager;
  };

  it('H. every door the second fix round touched, as B’s admin AND as B’s all-branch manager, against A’s rows: none answers anything of A’s, and on every refusal nothing is written anywhere in the database', async () => {
    const bManager = await bManagerCookie();
    // A's rows: an employee with a login, pay and tax ids and a place in A's order, on a shared role and on A's own; a second on A's other branch carrying a person; A's department, issue, rota slot and clock event.
    const loginA = await user(A.tenant, 'staff', `zz-r6fr-a-login-${run}@example.com`, A.x);
    const eA = await employee(A, A.x, 'fr-victim', {
      user_id: loginA,
      default_merge_data: JSON.stringify({ positionTitle: 'ZZ', salaryThb: 70000 }),
      tax_id_number: 'ZZ-FR-A-TAX',
      display_order: 5,
    });
    const personA = randomUUID();
    await q(`insert into people (id, full_name, email, person_type) values ($1, 'ZZ R6FR', $2, 'EMPLOYEE')`, [personA, `zz-r6fr-person-${run}@example.com`]);
    const eA2 = await employee(A, A.y, 'fr-victim-2', { person_id: personA, display_order: 6 });
    const victim = (await q<{ email: string; full_name: string }>('select email, full_name from employees where id = $1', [eA]))[0]!;
    const shared = (await q<{ id: string }>('insert into roles (tenant_id, name) values ($1, $2) returning id', [DEFAULT, `ZZ R6FR shared ${run}`]))[0]!.id;
    const roleA = (await q<{ id: string }>('insert into roles (tenant_id, name) values ($1, $2) returning id', [A.tenant, `ZZ R6FR A own ${run}`]))[0]!.id;
    await q('insert into employee_roles (employee_id, role_id) values ($1, $2), ($1, $3)', [eA, shared, roleA]);
    const deptA = (await q<{ id: string }>('insert into departments (tenant_id, name) values ($1, $2) returning id', [A.tenant, `ZZ R6FR A dept ${run}`]))[0]!.id;
    const entry = randomUUID();
    await q("insert into time_entries (id, tenant_id, employee_id, branch_id, shift_date, status) values ($1, $2, $3, $4, $5, 'PENDING_APPROVAL')", [entry, A.tenant, eA, A.x, day(0)]);
    const issue = randomUUID();
    await q(
      `insert into timekeeping_issues (id, tenant_id, employee_id, branch_id, issue_date, issue_type, status, linked_time_entry_id)
       values ($1, $2, $3, $4, $5, 'MISSING_CLOCK_OUT', 'PENDING_APPROVAL', $6)`,
      [issue, A.tenant, eA, A.x, day(0), entry],
    );
    const aSlot = await rotaSlot(A, eA);
    // B's own: two employees, B's department, a rota slot and an older-list shift.
    const eB = await employee(B, B.x, 'fr-b');
    const eB2 = await employee(B, B.x, 'fr-b2');
    const deptB = (await q<{ id: string }>('insert into departments (tenant_id, name) values ($1, $2) returning id', [B.tenant, `ZZ R6FR B dept ${run}`]))[0]!.id;
    const bSlot = await rotaSlot(B, eB);
    const bShift = randomUUID();
    const window = { startAt: new Date(Date.now() + 86_400_000).toISOString(), endAt: new Date(Date.now() + 90_000_000).toISOString() };
    await q('insert into shifts (id, tenant_id, branch_id, department_id, start_at, end_at, created_by) values ($1, $2, $3, $4, $5, $6, $7)', [bShift, B.tenant, B.x, deptB, window.startAt, window.endAt, B.admin.id]);
    const [aX, aY, bX, bY] = [await branchName(A.x), await branchName(A.y), await branchName(B.x), await branchName(B.y)];

    const before = await everything();
    expect(Object.keys(before).length, 'every app table is weighed').toBeGreaterThan(150);
    expect(before).toHaveProperty('employees');
    expect(before).toHaveProperty('employee_roles');
    const wrong: string[] = [];
    const A_MARKS = [eA, eA2, loginA, victim.email, victim.full_name, 'ZZ-FR-A-TAX', A.x, A.y, aX, aY, personA];
    const answered = (label: string, a: { status: number; text: string }, status: number, body?: unknown, watch = A_MARKS) => {
      if (a.status !== status || (body !== undefined && a.text !== JSON.stringify(body))) wrong.push(`${label}: ${a.status} ${a.text.slice(0, 200)}`);
      const marks = watch.filter((m) => a.text.includes(m));
      if (marks.length) wrong.push(`${label}: answers A's ${marks.join(', ')}`);
    };
    const notFound = { message: 'Employee not found' };
    for (const [who, cookie, admin] of [
      ['B admin', B.admin.cookie, true],
      ['B all-branch manager', bManager, false],
    ] as const) {
      // The list, by every filter the app's screens send.
      for (const query of ['', `?branchId=${A.x}`, `?branchId=${A.y}`, `?branchId=${A.x}&schedulingWeekStart=${day(0)}`]) {
        const list = await call('GET', `/api/employees${query}`, { cookie });
        answered(`${who} GET /api/employees${query}`, list, 200);
        if (query && list.text !== '[]') wrong.push(`${who} GET /api/employees${query}: lists ${list.text.slice(0, 120)}`);
      }
      // The template samples B's branch.
      const sample = await templateBranch(cookie);
      if (sample.status !== 200 || ![bX, bY].includes(sample.branch)) wrong.push(`${who} template: ${sample.status} samples "${sample.branch}"`);
      // The import preview: A's employee by email, by full name alone, and a new row naming A's branch.
      const preview = await importPreview(cookie, [HEADERS, [victim.full_name, victim.email, bX, 1], [victim.full_name, '', '', 2], [`ZZ R6FR new ${run}`, `zz-r6fr-new-${run}@example.com`, aY, 3]]);
      // The sheet's own cells come back as sent (A's name and email were typed into it); nothing of A's record may.
      answered(`${who} import preview`, preview, 200, undefined, A_MARKS.filter((m) => m !== victim.email && m !== victim.full_name && m !== aY));
      const got = preview.rows.map((r) => [r.matchedEmployeeId, r.branchId, r.error]);
      const want = [
        [null, B.x, null],
        [null, null, null],
        [null, null, `Branch "${aY}" not found`],
      ];
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${who} import preview rows: ${JSON.stringify(got)}`);
      // The import apply, aimed at A every way: A's employee onto B's branch, with no branch, onto A's branch; a new row on A's branch (and one smuggling it in an array); B's own employee onto A's branch.
      const applied = await call('POST', '/api/employees/bulk-update', {
        cookie,
        body: {
          rows: [
            { rowNumber: 2, matchedEmployeeId: eA, branchId: B.x, data: { fullName: 'ZZ hijack', salary: 1, taxIdNumber: 'ZZ-HIJACK' } },
            { rowNumber: 3, matchedEmployeeId: eA, branchId: null, data: { fullName: 'ZZ hijack', email: 'zz-hijack@example.com' } },
            { rowNumber: 4, matchedEmployeeId: eA, branchId: A.x, data: { fullName: 'ZZ hijack' } },
            { rowNumber: 5, isNew: true, branchId: A.y, data: { fullName: `ZZ R6FR B on A ${run}`, email: `zz-r6fr-b-on-a-${run}@example.com` } },
            { rowNumber: 6, isNew: true, branchId: [A.y], data: { fullName: `ZZ R6FR B on A array ${run}`, email: `zz-r6fr-b-on-a2-${run}@example.com` } },
            { rowNumber: 7, matchedEmployeeId: eB, branchId: A.x, data: { fullName: 'ZZ R6FR B moved onto A' } },
          ],
        },
      });
      answered(`${who} import apply`, applied, 200);
      const results = (applied.body?.results as { status: string; message: string }[] | undefined)?.map((r) => `${r.status}: ${r.message}`);
      const refused = ['Employee not found', 'Employee not found', 'No access to branch', 'No access to branch', 'No access to branch', 'No access to branch'].map((m) => `error: ${m}`);
      if (JSON.stringify(results) !== JSON.stringify(refused)) wrong.push(`${who} import apply results: ${JSON.stringify(results)}`);
      // The reorder: A's ids are skipped.
      answered(`${who} reorder`, await call('POST', '/api/employees/reorder', { cookie, body: { orderedIds: [eA2, eA] } }), 200, { success: true });
      // The clock override (the app's admins only): A's employee, A's branch.
      for (const [label, body, words] of [
        ['A’s employee on B’s branch', { employeeId: eA, branchId: B.x }, notFound],
        ['A’s employee on A’s branch', { employeeId: eA, branchId: A.x }, notFound],
        ['B’s employee on A’s branch', { employeeId: eB, branchId: A.x }, { message: 'Branch not found' }],
      ] as const) {
        const override = await call('POST', '/api/time-events/override', { cookie, body: { ...body, eventType: 'IN', eventTime: new Date().toISOString(), notes: 'ZZ R6FR' } });
        if (admin) answered(`${who} override, ${label}`, override, 404, words);
        else answered(`${who} override, ${label}`, override, 403);
      }
      // The timekeeping read.
      answered(`${who} timekeeping read`, await call('GET', `/api/timekeeping/employee/${eA}`, { cookie }), 404, notFound);
      // The role holders: neither role lists A's holder; no save names A's employee or replaces A's own role's holders.
      for (const role of [shared, roleA]) answered(`${who} GET role holders`, await call('GET', `/api/roles/${role}/employees`, { cookie }), 200);
      for (const [label, role, employeeIds, words] of [
        ['A’s employee', shared, [eA], notFound],
        ['B’s and A’s', shared, [eB, eA], notFound],
        ['not an id', shared, [42], notFound],
        ['A’s own role, B’s employee', roleA, [eB], { message: 'Role not found' }],
        ['A’s own role, cleared', roleA, [], { message: 'Role not found' }],
      ] as const) {
        answered(`${who} PATCH role holders, ${label}`, await call('PATCH', `/api/roles/${role}/employees`, { cookie, body: { employeeIds } }), 404, words);
      }
      // The issue resolve.
      for (const action of ['approve', 'reject']) {
        answered(`${who} resolve A’s issue (${action})`, await call('POST', `/api/timekeeping/issues/${issue}/resolve`, { cookie, body: { action, managerNote: 'ZZ hijack' } }), 404, { message: 'Issue not found' });
      }
      // The create's body, naming A's branch, department, logins and person.
      for (const [label, ids, status, words] of [
        ['A’s branch', { branchId: A.x }, 403, { message: 'Selected branch is not available' }],
        ['A’s department', { primaryDepartmentId: deptA }, 404, { message: 'Department not found' }],
        ['A’s admin as author', { updatedBy: A.admin.id }, 404, { message: 'User not found' }],
        ['A’s login as photo author', { profilePhotoUpdatedBy: loginA }, 404, { message: 'User not found' }],
        ['A’s login', { userId: loginA }, 404, { message: 'User not found' }],
        ['A’s person', { personId: personA }, 404, { message: 'Person not found' }],
      ] as const) {
        const made = await call('POST', '/api/employees', {
          cookie,
          body: Object.assign({ fullName: `ZZ R6FR create ${run}`, nickname: 'ZZ', email: `zz-r6fr-create-${randomUUID().slice(0, 8)}@example.com`, branchId: B.x }, ids),
        });
        answered(`${who} create naming ${label}`, made, status, words);
      }
      // The ping, the older shift list's create and edit, the reassignment.
      answered(`${who} ping`, await call('POST', '/api/timekeeping/live/ping', { cookie, body: { employeeId: eA, reason: 'ZZ' } }), 404, notFound);
      const shiftWords = { message: 'Employee not found or not in this branch' };
      answered(`${who} older shift create`, await call('POST', '/api/shifts', { cookie, body: { branchId: B.x, departmentId: deptB, employeeId: eA, ...window } }), 400, shiftWords);
      answered(`${who} older shift edit`, await call('PATCH', `/api/shifts/${bShift}`, { cookie, body: { employeeId: eA } }), 400, shiftWords);
      answered(`${who} reassign A’s slot`, await call('PATCH', `/api/schedule/assignments/${aSlot}/reassign`, { cookie, body: { employeeId: eB2 } }), 404, { message: 'Assignment not found' });
      answered(`${who} reassign B’s slot to A’s`, await call('PATCH', `/api/schedule/assignments/${bSlot}/reassign`, { cookie, body: { employeeId: eA } }), 400, { message: 'New employee not found' });
      // The two doors without an id fenced before the round: the bulk delete (the app's admins only) and the dead review list.
      const gone = await call('POST', '/api/employees/bulk-delete', { cookie, body: { employeeIds: [eA, eA2] } });
      if (admin) {
        answered(`${who} bulk delete`, { status: gone.status, text: gone.status === 200 ? '' : gone.text }, 200);
        if (gone.body?.deletedCount !== 0) wrong.push(`${who} bulk delete: ${gone.text.slice(0, 200)}`);
      } else answered(`${who} bulk delete`, gone, 403);
      answered(`${who} upcoming reviews`, await call('GET', '/api/employees/upcoming-reviews', { cookie }), 404, notFound);
    }
    expect(wrong).toEqual([]);
    expect(await everything()).toEqual(before);
  }, 240_000);

  it('H. the same doors within the park group, as B’s admin and B’s all-branch manager: the import matches, places and applies B’s own people, the reorder writes B’s order, a shared role takes B’s holders beside A’s, the override and the create write B’s rows', async () => {
    const bManager = await bManagerCookie();
    const holderA = await employee(A, A.x, 'fr-holder-a');
    const shared = (await q<{ id: string }>('insert into roles (tenant_id, name) values ($1, $2) returning id', [DEFAULT, `ZZ R6FR shared own ${run}`]))[0]!.id;
    await q('insert into employee_roles (employee_id, role_id) values ($1, $2)', [holderA, shared]);
    const deptB = (await q<{ id: string }>('insert into departments (tenant_id, name) values ($1, $2) returning id', [B.tenant, `ZZ R6FR B own dept ${run}`]))[0]!.id;
    for (const [who, cookie, admin] of [
      ['admin', B.admin.cookie, true],
      ['manager', bManager, false],
    ] as const) {
      const eB = await employee(B, B.x, `fr-own-${who}`, { default_merge_data: JSON.stringify({ positionTitle: 'ZZ', salaryThb: 30000 }), tax_id_number: `ZZ-FR-B-${who}` });
      const eB2 = await employee(B, B.x, `fr-own2-${who}`);
      const own = (await q<{ email: string; full_name: string }>('select email, full_name from employees where id = $1', [eB]))[0]!;
      expect(((await call('GET', `/api/employees?branchId=${B.x}`, { cookie })).body as { id: string }[]).map((e) => e.id)).toEqual(expect.arrayContaining([eB, eB2]));
      const newEmail = `zz-r6fr-own-new-${who}-${run}@example.com`;
      const preview = await importPreview(cookie, [HEADERS, [own.full_name, own.email, await branchName(B.y), 31000], [`ZZ R6FR own new ${who} ${run}`, newEmail, await branchName(B.x), 25000]]);
      expect(preview.status, preview.text).toBe(200);
      expect(preview.rows.map((r) => [r.matchedEmployeeId, r.branchId, r.error])).toEqual([
        [eB, B.y, null],
        [null, B.x, null],
      ]);
      expect(preview.rows[0]!.currentData).toMatchObject({ salary: 30000, taxIdNumber: `ZZ-FR-B-${who}` });
      const applied = await call('POST', '/api/employees/bulk-update', { cookie, body: { rows: preview.rows } });
      expect((applied.body.results as { status: string }[]).map((r) => r.status), show(applied)).toEqual(['updated', 'created']);
      expect((await q('select tenant_id, branch_id, default_merge_data from employees where id = $1', [eB]))[0]).toEqual({
        tenant_id: B.tenant,
        branch_id: B.y,
        default_merge_data: { positionTitle: 'ZZ', salaryThb: 31000 },
      });
      expect((await q('select tenant_id, branch_id from employees where email = $1', [newEmail]))[0]).toEqual({ tenant_id: B.tenant, branch_id: B.x });
      expect((await call('POST', '/api/employees/reorder', { cookie, body: { orderedIds: [eB2, eB] } })).status).toBe(200);
      expect((await q<{ id: string }>('select id from employees where id = any($1) order by display_order', [[eB, eB2]])).map((r) => r.id)).toEqual([eB2, eB]);
      const set = await call('PATCH', `/api/roles/${shared}/employees`, { cookie, body: { employeeIds: [eB] } });
      expect(set.status, show(set)).toBe(200);
      expect(((await call('GET', `/api/roles/${shared}/employees`, { cookie })).body as { employeeId: string }[]).map((r) => r.employeeId)).toEqual([eB]);
      expect((await q<{ employee_id: string }>('select employee_id from employee_roles where role_id = $1 order by employee_id', [shared])).map((r) => r.employee_id)).toEqual([holderA, eB].sort());
      const override = await call('POST', '/api/time-events/override', { cookie, body: { employeeId: eB, branchId: B.x, eventType: 'IN', eventTime: new Date().toISOString(), notes: 'ZZ R6FR' } });
      if (admin) {
        expect(override.status, show(override)).toBe(201);
        expect(await count('select count(*) as n from time_events where employee_id = $1', [eB])).toBe(1);
      } else expect(override.status).toBe(403);
      const email = `zz-r6fr-create-own-${who}-${run}@example.com`;
      const made = await call('POST', '/api/employees', { cookie, body: { fullName: 'ZZ R6FR create own', nickname: 'ZZ', email, branchId: B.x, primaryDepartmentId: deptB } });
      expect(made.status, show(made)).toBe(201);
      expect((await q('select tenant_id, primary_department_id from employees where email = $1', [email]))[0]).toEqual({ tenant_id: B.tenant, primary_department_id: deptB });
      // Clear B's holders for the next pass; A's stands.
      expect((await call('PATCH', `/api/roles/${shared}/employees`, { cookie, body: { employeeIds: [] } })).status).toBe(200);
      expect((await q<{ employee_id: string }>('select employee_id from employee_roles where role_id = $1', [shared])).map((r) => r.employee_id)).toEqual([holderA]);
    }
  });

  // ── Found beside the round's doors ──────────────────────────────────────────

  it('H. arrangement of finding 9: A’s admin lists and reads A’s own face kiosk and deletes A’s own clock event, as the app does; the reception tablets’ doors (round 5’s review) already keep to the park group', async () => {
    const eA = await employee(A, A.x, 'fr-clock-own');
    const event = (await q<{ id: string }>("insert into time_events (tenant_id, employee_id, branch_id, event_type, event_time, auth_method) values ($1, $2, $3, 'IN', now(), 'ADMIN_OVERRIDE') returning id", [A.tenant, eA, A.x]))[0]!.id;
    const device = (await q<{ id: string }>("insert into kiosk_devices (tenant_id, branch_id, name) values ($1, $2, 'ZZ R6FR own') returning id", [A.tenant, A.x]))[0]!.id;
    expect((await call('GET', '/api/kiosk-devices', { cookie: A.admin.cookie })).text).toContain(device);
    expect((await call('GET', `/api/kiosk-devices/${device}`, { cookie: A.admin.cookie })).status).toBe(200);
    expect((await call('DELETE', `/api/time-events/${event}`, { cookie: A.admin.cookie })).status).toBe(204);
    expect(await count('select count(*) as n from time_events where id = $1', [event])).toBe(0);
    const tablet = (await q<{ id: string }>("insert into kiosk_devices (tenant_id, branch_id, name, kiosk_type) values ($1, $2, 'ZZ R6FR A reception', 'reception') returning id", [A.tenant, A.x]))[0]!.id;
    expect((await call('PATCH', `/api/kiosk-devices/${tablet}/name`, { cookie: B.admin.cookie, body: { name: 'ZZ hijack' } })).status).toBe(404);
    expect((await call('DELETE', `/api/kiosk-devices/${tablet}/revoke`, { cookie: B.admin.cookie })).status).toBe(404);
    expect((await q('select name from kiosk_devices where id = $1', [tablet]))[0]).toEqual({ name: 'ZZ R6FR A reception' });
  });

  it.fails('H. FINDING 9 (high): the face kiosks’ admin doors and the clock event delete keep to the caller’s park group — B’s admin neither lists, reads, places on A’s branch, renames, switches off or deletes A’s kiosks, nor deletes A’s clock event', async () => {
    const eA = await employee(A, A.x, 'fr-clock-victim');
    const event = (await q<{ id: string }>("insert into time_events (tenant_id, employee_id, branch_id, event_type, event_time, auth_method) values ($1, $2, $3, 'IN', now(), 'ADMIN_OVERRIDE') returning id", [A.tenant, eA, A.x]))[0]!.id;
    const device = (await q<{ id: string }>("insert into kiosk_devices (tenant_id, branch_id, name, is_active) values ($1, $2, 'ZZ R6FR A tablet', true) returning id", [A.tenant, A.x]))[0]!.id;
    const listed = await call('GET', '/api/kiosk-devices', { cookie: B.admin.cookie });
    const devicesOnA = () => count('select count(*) as n from kiosk_devices where branch_id = $1', [A.y]);
    const onABefore = await devicesOnA();
    const placed = await call('POST', '/api/kiosk-devices', { cookie: B.admin.cookie, body: { branchId: A.y, name: 'ZZ R6FR B on A' } });
    const onAAfter = await devicesOnA();
    const read = await call('GET', `/api/kiosk-devices/${device}`, { cookie: B.admin.cookie });
    const renamed = await call('PATCH', `/api/kiosk-devices/${device}`, { cookie: B.admin.cookie, body: { name: 'ZZ hijack', isActive: false } });
    const deviceAfter = (await q('select name, is_active from kiosk_devices where id = $1', [device]))[0];
    const deletedEvent = await call('DELETE', `/api/time-events/${event}`, { cookie: B.admin.cookie });
    const deletedDevice = await call('DELETE', `/api/kiosk-devices/${device}`, { cookie: B.admin.cookie });
    expect({
      listsA: listed.text.includes(device),
      placedOnA: [placed.status === 201, onAAfter - onABefore],
      read: [read.status, read.text.includes(A.x)],
      renamed: renamed.status,
      deviceAfter,
      deletedEvent: deletedEvent.status,
      eventStands: await count('select count(*) as n from time_events where id = $1', [event]),
      deletedDevice: deletedDevice.status,
      deviceStands: await count('select count(*) as n from kiosk_devices where id = $1', [device]),
    }).toEqual({
      listsA: false,
      placedOnA: [false, 0],
      read: [404, false],
      renamed: 404,
      deviceAfter: { name: 'ZZ R6FR A tablet', is_active: true },
      deletedEvent: 404,
      eventStands: 1,
      deletedDevice: 404,
      deviceStands: 1,
    });
  });

  it('H. arrangement of finding 10: a shared role’s branches as the app keeps them — A’s roles screen saves it to A’s branch and lists it there, and the app’s employee editor offers a role at a branch only when its list names that branch or is empty', async () => {
    const shared = (await q<{ id: string }>('insert into roles (tenant_id, name) values ($1, $2) returning id', [DEFAULT, `ZZ R6FR branches own ${run}`]))[0]!.id;
    const saved = await call('PATCH', `/api/roles/${shared}`, { cookie: A.admin.cookie, body: { branchIds: [A.x] } });
    expect(saved.status, show(saved)).toBe(200);
    expect((await q<{ branch_id: string }>('select branch_id from role_branch_assignments where role_id = $1', [shared])).map((r) => r.branch_id)).toEqual([A.x]);
    const editor = readFileSync(join(APP_DIR, 'client', 'src', 'pages', 'employee-editor-page.tsx'), 'utf8');
    expect(editor).toContain('if (!role.branches || role.branches.length === 0) return true;');
    expect(editor).toContain('return role.branches.some((b: any) => b.id === selectedBranchId || b.branchId === selectedBranchId);');
  });

  it.fails('H. FINDING 10 (low): a shared role’s branch list is each park group’s own — B’s save neither strips A’s branch from it nor names A’s branch, and B’s role list shows none of A’s branches', async () => {
    const shared = (await q<{ id: string }>('insert into roles (tenant_id, name) values ($1, $2) returning id', [DEFAULT, `ZZ R6FR branches ${run}`]))[0]!.id;
    await q('insert into role_branch_assignments (role_id, branch_id, assigned_by) values ($1, $2, $3)', [shared, A.x, A.admin.id]);
    const bManager = await bManagerCookie();
    const listed = await call('GET', '/api/roles', { cookie: bManager });
    await call('PATCH', `/api/roles/${shared}`, { cookie: bManager, body: { branchIds: [B.x] } });
    const naming = await call('PATCH', `/api/roles/${shared}`, { cookie: bManager, body: { branchIds: [B.x, A.y] } });
    const stored = (await q<{ branch_id: string }>('select branch_id from role_branch_assignments where role_id = $1 order by branch_id', [shared])).map((r) => r.branch_id);
    expect({ listsA: listed.text.includes(A.x), naming: naming.status, stored }).toEqual({ listsA: false, naming: 404, stored: [A.x, B.x].sort() });
  });

  /** The census's Data Admin row, the plan, and the plan's standing cross-park-group login link (finding 11). */
  const records = () => {
    const lib = committed(join(APP_SERVER, 'lib', 'employeeParkGroups.ts'));
    const row = /\{ writer: "Data Admin's Employee Role and Role models"[^\n]*\}/.exec(lib)?.[0] ?? '';
    const text = plan();
    const link = text.slice(text.indexOf("- **A login linked to another park group's employee before round 6's review"), text.indexOf('- **Every park group assigns roles from the one set'));
    return { lib, row, text, link };
  };

  it('H. arrangement of finding 11: the baseline keeps `employee_roles.role_id` as a plain key — ON DELETE no action — and Data Admin deletes a row by its id alone; the census places the permission reads “as the builder’s round 6 report left them”; the plan names the standing link', () => {
    const { lib, row, link } = records();
    expect(row).toContain('disposition: "later"');
    expect(lib).toContain('placed with round 7');
    expect(link).toContain('the 03:00 batch');
    expect(link.length).toBeGreaterThan(200);
    const baseline = committed(join(APP_MIGRATIONS, '0000_otoapp_baseline.sql'));
    expect(baseline).toContain('ALTER TABLE "employee_roles" ADD CONSTRAINT "employee_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE no action');
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const tag = readdirSync(APP_MIGRATIONS).find((f) => f.startsWith(`000${n}_`));
      if (tag) expect(committed(join(APP_MIGRATIONS, tag)), tag).not.toMatch(/employee_roles_role_id/);
    }
    expect(readFileSync(join(APP_SERVER, 'data-admin', 'admin.ts'), 'utf8')).toMatch(/async delete\(id: string\): Promise<void> \{\s*await db\.delete\(this\.table\)\.where\(eq\(this\.table\.id, id\)\);\s*\}/);
  });

  it('H. FINDING 11 (low, fixed at landing): the records say what the code does — Data Admin’s role delete is refused while the role has holders (it does not cascade to them); the `/api/permissions/*` reads the census places “elsewhere” are placed in the plan; and the plan’s standing cross-park-group login link names the two doors that still reach it', () => {
    const { row, text, link } = records();
    expect({
      cascadeClaimed: /cascades to its holders/.test(row),
      permissionReadsPlaced: text.includes('/api/permissions/'),
      linkNamesItsDoors: link.includes('toggle-login') && link.includes('reset-password'),
    }).toEqual({ cascadeClaimed: false, permissionReadsPlaced: true, linkNamesItsDoors: true });
  });
});
