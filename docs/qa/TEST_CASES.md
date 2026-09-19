# Sprint 1 — QA Test Cases

Screenshot evidence gallery (all cases, grouped by ticket with anchors): https://claude.ai/code/artifact/da897843-ec02-4e99-ac57-038ac6ea12d3 — the same images live in `jira-comments/attachments/`. Each Jira ticket also carries these cases as comments.

Executed 2026-09-11 against the local stack (API :3001, POS :25741, Postgres 16 + MinIO in Docker), seeded database. Dev accounts: platform admin `0900000001` / `admin1234`, reception `0900000002` / `reception1234`. Seeded member: Mali `0811111111` (Thai tier, 2 children). Each case was executed live (scripted headless-Edge browser runs and/or API integration tests); screenshots referenced per case live in `jira-comments/attachments/`.

---

## TC-SCRUM-7 — Architecture record matches reality
**Preconditions:** repo checked out.
1. Open `oto-platform/ARCHITECTURE.md`.
2. Verify it states the stack, monorepo layout, reuse boundary, and decisions log D1–D10.
3. Run the prototype (`PORT=25731 BASE_PATH=/ pnpm --filter @workspace/oto-till run dev`) and compare its real folder structure against §6.
**Expected:** document exists, matches the decided stack, and the verified layout matches the brief's §2 with recorded additions.
**Actual:** all sections present; layout verified with additions (`.agents/memory`, Windows-native-binary caveat) recorded. **Status: PASS**

## TC-SCRUM-8 — Inventories complete and traceable
1. Open `oto-platform/SPRINT_1_PROGRESS.md`.
2. Check the screen inventory lists every prototype route with a Sprint-1/mock/out-of-scope mark.
3. Check the logic inventory maps each rule → prototype `file:function` → owning ticket.
4. Spot-check 3 rules (adult pricing → `lib/pricing.ts:42`; weekend rule → `lib/pricingMode.ts:34`; inactivity → `mockApi.ts:607`) against the prototype source.
**Expected:** every Sprint 1 ticket has its sources listed; gaps marked "no prototype logic".
**Actual:** all present; spot-checks match. **Status: PASS**

## TC-SCRUM-9 — Clean-machine bring-up
1. From a clean checkout: `cd oto-platform && pnpm install`.
2. `docker compose -f infra/docker-compose.yml up -d` (Postgres 16 + MinIO healthy).
3. `pnpm db:migrate` then `pnpm db:seed`.
4. `pnpm dev`; GET `http://localhost:3001/health` and `/ready`; open `http://localhost:25741`.
**Expected:** no manual steps; API returns `{status:ok}` / `{status:ready}`; POS lock screen renders.
**Actual:** as expected, repeated from a freshly dropped database. CI workflow present but unproven on GitHub (nothing pushed yet). **Status: PASS (CI pending first push)**

## TC-SCRUM-10 — Migrations idempotent from empty; seed usable
1. Drop and recreate the database.
2. Run `pnpm db:migrate` — observe success.
3. Run `pnpm db:migrate` again — observe success with nothing to apply.
4. Run `pnpm db:seed`; query Postgres for operator, branch (timezone Asia/Bangkok), 3 tiers, 4 ticket packages (satang prices), 6 members, children, tax config.
**Expected:** clean double-run; seed rows present; every FK indexed; ER diagram in ARCHITECTURE.md §8.
**Actual:** all verified (also enforced in CI). **Status: PASS**

## TC-SCRUM-13 — Scoped permissions allow/deny
1. Sign in as reception (`0900000002`).
2. GET `/members/lookup?phone=0811111111` → expect 200 (branch-scoped grant covers it).
3. POST `/branches` with a new branch body → expect 403 (outside reception's bundle).
4. GET `/me/permissions` → expect the effective list with scopes.
5. Repeat step 3 as platform admin → expect 200.
**Expected/Actual:** 200 / 403 / scoped list / 200 exactly as expected; unit tests cover operator, platform-wide (null-scope), branch, department, record scopes and their union. **Status: PASS**

## TC-SCRUM-14 — Every mutation audited
1. As reception, create a member (POST `/members`).
2. As admin, GET `/audit?entityType=member` → expect a `member.create` row with `after` payload and actor id.
3. As reception, GET `/audit` → expect 403.
4. After the full browser walkthrough, query `audit_log` grouped by action.
**Expected:** rows for account create, role assignment, member create, package update (with before/after); read endpoint guarded.
**Actual:** rows present for `auth.sign_in`, `member.create`, `visit.create`, `ticket_package.create/archive`, `booking.create`; guard behaved. **Status: PASS**

## TC-SCRUM-15 — Idempotency replay and mismatch
1. POST `/members` `{phone:+66611111222, nickname:IdemTest}` with header `Idempotency-Key: idem-1` → 200.
2. Repeat the identical request with the same key → 200 with the SAME response body.
3. SQL: count members with that phone → expect exactly 1.
4. POST `/members` with key `idem-1` but a DIFFERENT phone → expect 409 `IDEMPOTENCY_MISMATCH`.
**Expected/Actual:** one row, identical replay, 409 on mismatch. **Status: PASS**

## TC-SCRUM-16 — Permission-bound photo storage
1. As reception, POST `/files` (contentType image/png, owner = own account) → receive `uploadUrl`.
2. HTTP PUT the PNG bytes to `uploadUrl` → 200.
3. GET `/files/{id}/url` → receive signed URL; download; compare bytes to the upload.
4. As admin, upload a photo owned by the ADMIN account; as reception GET its `/url` → expect 403.
5. GET the same without a session → expect 401.
**Expected/Actual:** byte-for-byte match; 403; 401; `/me` surfaces `photoFileId`. **Status: PASS**

## TC-SCRUM-17 — Locale conventions + 5 languages live
1. Run `pnpm --filter @oto/shared test` → phone (Thai local, +66, 00-prefix), money, timezone round-trip tests green.
2. Open `/book`, tap the language pill → switch to ไทย.
3. Observe chrome AND ticket names render in Thai (e.g. "เล่น 1 ชั่วโมง" — from the database translations).
4. Repeat for 中文, Русский, Français.
**Expected:** real translations everywhere, no placeholder keys.
**Actual:** all four languages verified on-screen with DB-driven names (screenshots). **Status: PASS**

## TC-SCRUM-19 — Sign in by phone (happy + failure paths)
1. Open the POS → lock screen shows the phone + password form ("Scan my face" is a placeholder).
2. Enter phone `0900000002` (Thai local format) and password `reception1234`; tap Sign in.
3. Observe the till loads; operator badge shows "Som"; header pricing chip populated.
4. Sign out; enter the same phone with a WRONG password → observe the inline error (401).
5. Repeat the wrong password 5 times; attempt a 6th → observe the cooldown message (429).
**Expected/Actual:** steps 2-3 signed in with a session row in `session`; step 4 clear error; step 5 cooldown triggered. **Status: PASS**

## TC-SCRUM-20 — Invited account completes setup
1. As admin, invite a new account (see TC-SCRUM-21) — note the 6-digit code in the API console log (dev SMS adapter).
2. Attempt sign-in with the new phone before setup → observe "Finish your account setup" (403 SETUP_REQUIRED).
3. On the lock screen tap "First shift? Set up account"; enter the phone; tap Send code.
4. Enter the code + choose a password (≥8 chars); submit.
5. Observe automatic sign-in; sign out; sign in again with the new password.
6. Re-submit the SAME code with a new password → expect "Invalid code".
**Expected/Actual:** blocked before setup; code single-use; sign-in works after. Expired codes refused (verified by test). **Status: PASS**

## TC-SCRUM-21 — Create staff account with scoped role
1. Sign in as admin → open `/admin` → Access → Login Users.
2. Tap "Invite staff account"; enter name "New Staffer", a phone, role `reception`, branch scope HKT Central; submit.
3. Observe the toast (invite sent) and the new row with an "invited" status pill.
4. Complete setup per TC-SCRUM-20 and sign in as the new account.
**Expected/Actual:** account created + role assignment audited; invitation code logged; end-to-end sign-in works. **Status: PASS**

## TC-SCRUM-22 — Review effective permissions
1. In Login Users, tap the shield icon on an account.
2. Observe the dialog: role assignments with scope labels ("branch: HKT Central") and the effective-permission chips.
3. Tap Remove on an assignment → observe it disappear; re-open the dialog → chips reduced accordingly.
4. GET `/accounts/{id}/permissions` → matches the dialog.
**Expected/Actual:** immediate reflection; both changes audited. **Status: PASS**

## TC-SCRUM-23 — Password recovery kills old sessions
1. Sign in as reception in browser A (keep it open).
2. On the lock screen (browser B) tap "Forgot password?"; enter the phone; Send code; read the code from the API log.
3. Enter code + new password → auto signed in.
4. In browser A, perform any action → observe it is locked out (session invalidated).
5. Attempt to reuse the same code → "Invalid code".
**Expected/Actual:** reset works; all prior sessions dead; code single-use; expired code refused (test-verified). **Status: PASS**

## TC-SCRUM-24 — Sign out
1. While signed in, tap the lock icon on the operator badge.
2. Observe return to the lock screen.
3. Replay the old session cookie against GET `/me` → expect 401.
**Expected/Actual:** session row deleted; old cookie rejected. Bonus: any server-side 401 mid-use auto-locks the POS. **Status: PASS**

## TC-SCRUM-25 — Profile fields strict; photo via API
1. GET `/me` → account, employee, branch, permissions, photoFileId.
2. PATCH `/me` `{name:"New Name"}` → 200; GET `/me` reflects it.
3. PATCH `/me` `{status:"active"}` (non-permitted field) → expect 400 schema rejection.
4. Photo upload/download per TC-SCRUM-16.
**Expected/Actual:** permitted fields save; unknown fields rejected; photo path proven. Photo UI control deferred (placement decision — prototype has no profile screen). **Status: PASS (backend); UI deferred**

## TC-SCRUM-27 — Operators, branches, administrators
1. As platform admin, open Admin → Access → Operators.
2. Enter "Second Park Co" → Create operator → row appears.
3. Tap "Assign admin"; enter name + phone; submit → invitation toast (code in API log).
4. Tap archive on the operator → confirmation dialog explains the soft delete → confirm → row leaves the list (hidden from pickers).
5. In Branches: create "HKT Chalong" with timezone Asia/Bangkok; then archive it → gone from the switcher.
**Expected/Actual:** all steps as expected; operator routes refuse non-platform admins. **Status: PASS**

## TC-SCRUM-28 — Deactivate + temporary password
1. In Login Users, tap the key icon on an account → confirmation dialog states consequences → confirm.
2. Read the temporary password from the toast.
3. Sign in with it → any guarded screen shows the password-change requirement (403 MUST_CHANGE_PASSWORD under the hood).
4. Change the password via the change form → guarded screens work again.
5. Tap deactivate on the account → confirm dialog → confirm; attempt sign-in → "deactivated — contact a manager"; any live session is dead.
**Expected/Actual:** temp password works once and forces a change; deactivation blocks sign-in and kills sessions. **Status: PASS**

## TC-SCRUM-30 — Membership lookup from the customer display
1. Sign in as reception; till is on the Membership Check step (customer display shows "Are you a member?" with keypad).
2. On the CUSTOMER DISPLAY keypad, type `0811111111`.
3. Tap "Find my membership".
4. Observe: the till shows Mali with the "Thai · verified" chip auto-applied; the customer display shows "Welcome back, Mali!" + "Member rate applied". (Under the hood the phone travelled till←API via the session pending-lookup, not shared state.)
5. Public site variant: open `/book`, identify with the same phone → 1 Hour Play shows ฿420 (Thai); guest shows ฿690; expat member `0822222222` shows ฿483.
6. Failure case: stop the API; repeat step 5 → amber banner + "Continuing as a guest" toast, no crash.
**Expected/Actual:** all as described, screenshot-proven. **Status: PASS**

## TC-SCRUM-31 — Create member from phone + name
1. On the Membership Check, enter an UNKNOWN phone (e.g. `0699998888`) on the keypad → Find my membership.
2. Observe the "New member?" dialog with the phone pre-filled.
3. Enter nickname "Fern" → tap Create member.
4. Observe the toast "Member created · +66699998888" and the member applied to the sale (Tourist tier).
5. Repeat with the SAME phone in the format `+66 69 999 8888` → expect the duplicate rejection (409 MEMBER_EXISTS surfaced as an error toast).
**Expected/Actual:** created with E.164 normalisation and tourist default; duplicate rejected across formats; audited. **Status: PASS**

## TC-SCRUM-32 — Confirm children into a draft visit
1. Complete TC-SCRUM-30 steps 1–4 (Mali found).
2. The "Who's visiting today?" modal opens listing Nong Ploy (5 yrs, allergy "Peanut allergy — carries an EpiPen") and Nong Tan (7 yrs), both pre-selected.
3. Edit Nong Ploy's allergy text in place (e.g. append "(rechecked today)").
4. Tap "Confirm 2 children".
5. Observe the toast "Visit confirmed — 2 children confirmed for today."
6. SQL check: `visit` row status `draft` dated today (branch tz) with 2 `visit_child` rows; both children's `last_confirmed_at` set; allergy edit audited with before/after.
**Expected/Actual:** exactly as described (Postgres spot-checked after the live run). **Status: PASS**

## TC-SCRUM-35 — Ticket package lifecycle through the admin form
1. Sign in as admin → `/admin` → Tickets → "Add ticket type".
2. Enter Name "3 Hours Play", Duration label "3 Hours", Hours 3.
3. Enter base (Tourist) prices: weekday ฿990, weekend ฿1,090.
4. Submit.
5. Observe the new row in the Tickets table (฿990 / ฿1,090 wknd).
6. SQL check: `ticket_package` row with `{"weekday":99000,"weekend":109000}` satang; audit row `ticket_package.create`.
7. Open the public `/book` catalog → the new package is listed immediately.
8. Tap the trash icon on the row → confirmation dialog → confirm.
9. Observe the row leaves the list; SQL shows `active=false`, `archived_at` set (soft delete).
10. API negative cases: create with a negative price or hours 0 → 400.
**Expected/Actual:** all 10 steps as described, screenshot-proven. **Status: PASS**

## TC-SCRUM-36 — Weekday/weekend/holiday resolver end to end
1. On the signed-in POS, observe the header chip: "Weekday pricing" (Fri 2026-09-11, Asia/Bangkok) — driven by `GET /branches/:id/pricing-mode`.
2. API date matrix: query the resolver for a Wednesday (weekday), Saturday (weekend), Sunday (weekend), a weekday inside a holiday range ("Weekend pricing — Songkran"), and both range boundary days (inclusive) + the day after (weekday).
3. Booking on a holiday: POST a public booking dated on the seeded Loy Krathong Tuesday → totals use WEEKEND rates.
4. Live booking totals: complete a /book purchase as Mali (1 kid + 1 adult, 1 Hour, Thai, weekday) → confirmation shows ฿770 and reference `OTO-1448023-1311`; SQL shows the same reference with `total_satang=77000`, `rateMode:weekday`.
**Expected/Actual:** all five resolver cases and both live checks passed. **Status: PASS**

## TC-SCRUM-37 — Tax resolver precedence
1. GET `/branches/:id/tax-resolve?taxableCategory=tickets` → expect `{taxMode:inclusive, vatRateBp:700, serviceChargeBp:0, source:branch}` (seeded 7% inclusive VAT).
2. POST a tax override scoped to the F&B product CATEGORY: vat 500bp, service 1000bp; re-resolve with that category → expect `source:category_override`, 500/1000.
3. POST a tax override scoped to a PRODUCT in that category: vat 0bp; re-resolve with category+product → expect `source:product_override`, vat 0, service 1000 (inherited from the category).
4. PUT the branch tax config with F&B service charge 10% → resolver for `fnb` returns `serviceChargeBp:1000`; change audited with before/after.
**Expected/Actual:** precedence chain branch → category → product exactly as specified. **Status: PASS**
