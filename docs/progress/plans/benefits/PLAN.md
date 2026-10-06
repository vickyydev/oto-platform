# Staff benefits: the build plan for S2-21 (SCRUM-218)

_DRAFT, 6 October 2026. Not committed. Written from a read-only study of
`main` at 483cc443, the prototype under `imports/oto-pos/artifacts/oto-till/src`
and Jira (read only). Proposed home when it lands:
`docs/progress/plans/benefits/PLAN.md`. Migration numbers are given at
landing: the next free number on main is 0064, and S2-15b and S2-20 will also
take numbers. SCRUM-218 stays To Do until work starts._

The owner's rule applies throughout. The prototype's rules are ported as
they are. Only data-reliability additions are made on our own authority.
Every rule choice is a question in section 10, and the prototype's behaviour
is the default until the owner answers.

## 0. Unmet dependency: read this first

The ticket says `Depends on: S2-09b, S2-10a, S2-17b`. S2-09b and S2-10a
are Deployed. **S2-17b (SCRUM-193) is In Progress, and the part this ticket
needs is NOT BUILT:**

- `otoapp_v.employees` does not exist (closure-plan.md:9).
- Nothing copies OTO App employees into `core.employee`, and
  `otoapp:employee.sync` has no code.
- `core.employee` has no column for the OTO App's employee id
  (tenancy.ts:85-108), so a copied row cannot be matched to its source.

**Most of the ticket does not wait for it.** Rounds 1 to 3 run against
seeded `core.employee` rows: the engine, the tables, the badge, checkout and
the admin panel. The mirror replaces the seed in round 4, once the S2-17b
"POS seams" slice lands. Until then, acceptance check 1 ("employees read
from the mirrored HR record") can only be shown on seeded rows, and the
Jira comment must say so.

S2-15b (SCRUM-216, In Progress) is not a blocker. This ticket builds
`analytics.fact_benefit_daily` itself, in the `analytics` schema that S2-15b
opens. The two must agree migration numbers.

**A live gap found while studying this.** The till already sends a staff
benefit to the platform today:

- `apps/pos/src/pages/OrderStation.tsx` still scans the prototype's mock
  codes (`OTO-BENEFIT-OP-1` to `-4`) and works out the relief in browser
  memory.
- It folds that relief into the order as a manual discount ("Staff
  benefit", lines 260-279) and sends it in the sale (line 1014).

So on staging a benefit is applied as an ordinary manual discount. Its
quota resets when the page reloads, and the only record of whose benefit
it was is the note "Scanned: <name> (<role>)". It is audited as the
signed-in staff member's manual discount, and reception can already do that
(`pos:sale:discount`; R-08 says the audit replaces approval). So this is
not a rights escalation, but the quota is not real. Round 3 closes it.

## 1. What the park sees

- **At the F&B station.** Staff scan a colleague's benefit QR, or type its
  code, from the "Staff benefit" button. The order shows the relief
  broken into four parts: "Comped (100% off)", "Free item(s)", "Staff
  credit" and "Standing discount".
  - The customer display shows the same relief as the till.
  - The receipt and the confirmation carry the same breakdown.
  - An unknown code says `No staff benefit found for "<code>".`
  - A person with nothing set up says `<name> has no benefit configured.`
- **Admin > Staff Benefits.**
  - The Owner, Manager and Staff templates can be edited.
  - Every staff member is listed with their benefit role, an override
    switch and editor, and a "Show QR" button.
  - An "Audit log" lists every application: whose benefit, comp or the
    relief amount, who processed it, when, and which order.
  - New on the platform (UI additions): an "effective from" date and a
    change history on each template and each override, and a revoke
    button for a QR.
- **Reporting.** Each benefited order appears on Discounts & Comps as a
  "Staff benefit" row, as it does in the prototype today. Q10 covers
  adding a split by comp, free items, credit and standing discount.
- **When the box is offline.** Comp and the standing discount still apply.
  Free items and credit say "online only" and are not used.

## 2. The reference (the prototype)

All paths are under `imports/oto-pos/artifacts/oto-till/src`.

- `lib/benefits.ts` (pure):
  - `benefitPeriodKey` (15)
  - `resolveEffectiveBenefitProfile` (33)
  - `isEmptyBenefitProfile` (47)
  - `emptyBenefitUsage` (66)
  - `applyStaffBenefits` (98-190)
- `mockApi.ts`:
  - `mockOperators` (430-435)
  - `findOperatorByBenefitQrCode` (455)
  - `updateOperatorBenefits` (471)
  - `getEffectiveBenefitProfile` (482)
  - usage keys (491-499)
  - `getBenefitUsage` (497)
  - `commitBenefitUsageDeltas` (510)
  - `getBenefitAuditLog` (525)
  - `previewStaffBenefit` (533)
  - `commitStaffBenefit` (552)
  - `attachBenefitAuditOrderId` (587)
- `store/catalogStore.ts`:
  - `seedRoleBenefitTemplates` (802-841)
  - `getRoleBenefitTemplates` and `getRoleBenefitTemplate` (1150-1151; the templates are global, not per branch)
  - `setRoleBenefitTemplate` (1526)
- `types.ts`:
  - `Operator` (3-22: the benefit role is separate from the login role)
  - `BenefitRole`, `FreeItemsBenefit`, `CreditBenefit`, `PercentDiscountBenefit`, `BenefitProfile` and `RoleBenefitTemplate` (464-512)
  - `BenefitAuditEntry` (514-535)
  - `FnbOrder.staffBenefit`
- `pages/OrderStation.tsx`:
  - `STAFF_BENEFIT_DISCOUNT_ID` (40)
  - the live preview, folded into one manual discount (109-141)
  - the commit made last before the order is recorded (493-515)
- `lib/reporting.ts`: `discountAndCompImpact` (about 600-650; every manual
  discount, including "Staff benefit", is a row).
- UI:
  - `components/fnb/{BenefitScanModal, StaffBenefitBreakdown, FnbConfirmation:143}`
  - `components/admin/staff-benefits/{StaffBenefitsPanel (with its Audit log), BenefitProfileFields, OperatorOverrideDialog, BenefitQrDialog}`
- Authority beyond the prototype:
  - POS_BACKEND_LOGIC s15 and s15.1
  - R-70 and R-107 to R-110, and C13 (the employee master stays in the OTO App, and the badge is issued by the platform)
  - R-08, R-48 and R-64
  - proposal story 17 ("concurrent attempts yield exactly one")

The copy in `apps/pos/src/lib/benefits.ts` is byte-identical to the
prototype's.

## 3. The prototype's behaviour, ported as it is

| Rule | The prototype's behaviour (kept) | Source |
|---|---|---|
| Where it applies | Only at the F&B order station. | benefits.ts header, R-70 |
| Benefit role | Owner, Manager or Staff. This is separate from the login role. No role means no benefit and no QR. | types.ts:7-12 |
| Templates | One per benefit role, editable, for the whole operator. | catalogStore 802-841, 1150 |
| Seeds | Owner: comp. Manager: 2 free coffees a day (category `drinks-coffee`), ฿500 a month credit, 30% off F&B. Staff: 2 free coffees a day and 30% off F&B. | `seedRoleBenefitTemplates` |
| Override | A person's override, while switched on, is their whole profile. The editor fills it in from the current effective profile, so switching it on never blanks a benefit, and leaving a primitive off switches it off for that person. | `resolveEffectiveBenefitProfile`, OperatorOverrideDialog:58 (see Q1) |
| Primitives | Comp. Free items (id, label, target, quota, daily or monthly). Credit (amount, daily or monthly, optional target, F&B by default). Standing percent (optional target, F&B by default). Targets use the existing `DiscountTarget`. | types.ts:464-505 |
| Order of stages | Comp ends the calculation and the whole order is free. Otherwise free items, line by line; then credit, greedily, line by line; then the standing percent on whatever is left. Each stage works on what the stage before left. | `applyStaffBenefits` |
| Free-item cap | The quantity relieved is capped by the quota left and by what the line's remaining value can pay for. Quota is never claimed for units that were not relieved. | benefits.ts:126-145 |
| Rounding | Whole baht: `Math.round` of unit price × quantity, and of remaining × percent. | benefits.ts:138, 174 |
| Periods | Daily and monthly keys (`YYYY-MM-DD`, `YYYY-MM`). A new period simply starts at zero. No reset job. | `benefitPeriodKey`, mockApi usage keys |
| Preview | Recomputed live as the cart changes. It never uses up quota. An empty profile previews nothing. | `previewStaffBenefit`, OrderStation 109-114 |
| Commit | At confirmation, recomputed against current usage. Written only if the total relief is above 0. Usage is used up and an audit entry is written. The order id is attached once recorded. | `commitStaffBenefit`, `attachBenefitAuditOrderId` |
| How the relief lands on the bill | As ONE order-scope manual discount, reason "Staff benefit", note "Scanned: <name> (<role>)". Its type is `comp` for an owner comp, otherwise `fixed` for the total relief. It goes after the order's other manual discounts. Removing it un-scans the benefit. | OrderStation 116-141, 702-707 |
| Who processed it | The till's signed-in staff member. They may scan their own QR. | OrderStation `appliedBy` |
| Audit entry | Whose QR, their benefit role, who processed it, whether it was a comp, the four amounts and the total, and the order and branch. Kept even if the order is later refunded. | `BenefitAuditEntry`, types.ts:518 |
| Wallets | The staff credit is a benefit pool, not a guest wallet. No wallet moves. | R-64, benefits.ts |
| Reporting | Discounts & Comps lists the "Staff benefit" manual discount row per order. Staff Benefits > Audit log lists each application. | reporting.ts `discountAndCompImpact`, StaffBenefitsPanel 150-180 |
| Words | `No staff benefit found for "<code>".` · `<name> has no benefit configured.` · the breakdown labels "Comped (100% off)", "Free item(s)", "Staff credit", "Standing discount". | BenefitScanModal 34-38, StaffBenefitBreakdown 20-23 |

## 4. Fixed, because the prototype is broken there (data reliability)

- **A typed code is enough to be someone.** The prototype's QR is a
  readable string (`OTO-BENEFIT-OP-4` comps any order). The platform issues
  a signed badge credential (C13): `OTO-BEN:v1:<employee>:<credential>:<exp>`
  plus an Ed25519 signature. The key purpose `benefit_qr` already exists
  (fleet.ts:772). A QR can be revoked, the revocation list goes to the
  boxes, and a person who leaves (archived employee) is refused.
- **Usage is used up before the order exists.** `commitStaffBenefit` runs
  before `recordFnbOrder`. If the order then fails, the quota is gone and
  there is no order. The platform claims the quota inside the sale's own
  transaction, so both happen or neither does.
- **Two tills, last coffee.** The prototype has no locking. The platform
  claims with one conditional update, so two simultaneous attempts give
  exactly one success and one `BENEFIT_QUOTA_EXHAUSTED` (story 17, R-110).
- **The device's clock decides the period.** `benefitPeriodKey` reads the
  device's local date. The platform works out the period on the server,
  and on the box from its trusted clock, in the branch's time zone. Which
  hour the day turns over is Q6.
- **The client's figures are trusted.** The platform recomputes the relief
  on the server at apply and at commit, from the stored profile and the
  stored usage, as the prototype's commit does. A relief figure sent by
  the till is never used.
- **Tax by the wrong category.** One order-scope fixed discount would be
  spread across the order's lines in proportion to value. A coffee-only
  benefit would then reduce the VAT basis of non-coffee lines. The single
  "Staff benefit" row stays on the receipt as in the prototype, but its
  `allocations` record the engine's per-line relief, so the VAT export
  reconciles to the satang.
- **Nothing is kept.** In the prototype, profiles, overrides, usage and the
  audit log vanish on reload. The platform stores them all.
- **Changes overwrite history.** The ticket asks for effective dates. A
  template or override change closes the previous row (`effective_to`)
  and opens a new one. A change dated tomorrow never changes today's
  checkout.
- **Offline.** Quota-bearing value (free items and credit) is single-use
  value and follows R-48: online only, with nothing used up while offline.
  Comp and the standing percent carry no quota and apply offline as box
  facts.

## 5. From the ticket, where the prototype has nothing

- **Employees come from the OTO App** (C13). The panel never creates or
  edits an employee. A scan for an employee who has not been copied yet is
  refused, and an `ops_run` of kind `integration` is raised under
  `otoapp:employee.sync`.
- **Credential management.** Issue (`POST /benefits/credentials`), revoke,
  and fetch the printable payload behind the existing BenefitQrDialog. The
  badge grants no access and opens no session: sign-in and the gate reader
  both refuse it.
- **Routes.**
  - Templates and profiles: `GET/PUT /benefits/templates[/:role]`,
    `GET/PUT /benefits/profiles[/:employeeId]` and
    `GET /benefits/profiles/:employeeId/effective?on=`.
  - Resolving a scan: `POST /benefits/resolve`.
  - At the sale: `POST /sales/:id/benefit/preview`,
    `POST /sales/:id/benefit/apply` and `DELETE /sales/:id/benefit` (before
    the sale is finalised).
  - Reporting: `GET /reports/benefits`.
- **The period job.** `job:benefit.period_rollover` at the branch's day
  start writes `fact_benefit_daily` and closes the previous period, with
  an `ops_expectation` on Health. A new period does not need it to start
  counting from zero.

## 6. Where the ticket text differs from the prototype (the prototype wins until answered)

| Ticket text | Prototype | Default here |
|---|---|---|
| An override replaces each primitive it sets, and the rest come from the template (R-109, the types.ts:15-19 docstring) | The code and the dialog say the override is the whole profile | Whole profile (Q1). Seeding Nok's override filled in from the Staff template with 4 coffees gives the same screen either way. The answers differ only when a template is later changed. |
| Manager ฿5,000 a month credit ("per BL s15", which says "฿X"); acceptance at ฿5,000 and ฿6,000 | Manager ฿500 a month, 30%, 2 coffees | ฿500 (Q2). The acceptance becomes "edit to ฿600 from tomorrow; today stays ฿500". |
| `pos:benefit:comp` gate; reception is refused | No gate. Reception can already give a manual comp (`pos:sale:discount`), and R-08 says the audit replaces approval | No gate. A comp is a sensitive audit row (Q3) |
| A refund gives the quota back (`benefit.reverse`) | Usage stays used; the audit is kept | Usage stays used (Q4) |
| A profile targeting `everything` reaches the ticket till | Scanned at the F&B station only | F&B only (Q5) |
| Benefit relief first, then manual discounts, then promos | The relief is worked out on the raw lines and added as the LAST manual discount, before promos | The prototype's place (Q11) |
| A free-item benefit uses a synthetic ฿0 line plus a discount | The free item is the staff member's own cart line, relieved by the discount | No synthetic line |
| The period rolls at the branch's day start | The device's calendar midnight | Same answer as SCRUM-497 #46 (Q6) |
| A four-way split on Discounts & Comps | One "Staff benefit" row per order; the split is on the receipt and in the breakdown | The prototype's row; the split only if Q10 says yes |

## 7. Data model and migration needs (numbers assigned at landing)

- **`core.employee`** gains `source` (platform or otoapp) and
  `external_id`, unique per operator where set. The mirror job fills them
  in later; round 1 seeds the four employees.
- **`promo.benefit_role_template`**: operator, role (owner, manager or
  staff), name, profile jsonb (the prototype's `BenefitProfile`, amounts in
  satang), effective_from, effective_to, updated_by and timestamps.
  - Template ranges for one (operator, role) never overlap. The service
    enforces this under a row lock.
  - This plan proposes not using an exclusion constraint, which would need
    `btree_gist`. That is an engineering choice for review.
- **`promo.benefit_profile`**: operator, `core.employee_id`, benefit_role
  (null means no benefit), override jsonb (null means no override),
  effective_from, effective_to, archived_at and created_by. It follows the
  same no-overlap rule.
- **`promo.benefit_credential`**: employee, code_hash, key id (`kid`),
  version, issued_by, issued_at, expires_at, revoked_at, revoked_by and
  last_seen_at.
- **`promo.benefit_usage`**: employee, item key (the free-item id such as
  `coffee`, or `credit`), period_kind, period_key, qty_used,
  credit_used_satang and version.
  `UNIQUE(employee_id, item_key, period_key)`, and a CHECK that the values
  are not negative.
- **`promo.benefit_application`**. It holds:
  - the sale, the beneficiary employee and the credential
  - the profile snapshot and the engine version
  - who processed it, the station and the box
  - is_comp and the four amounts plus the total, all in satang
  - the usage deltas and period keys, as jsonb
  - occurred_at and the client-minted id (unique, for idempotency)
  - reversed_at and reversed_by_refund_id, used only if Q4 is yes
- **`pos.sale_discount`** gains a nullable `benefit_application_id`. The
  benefit row stays kind `manual` (type `comp` or `fixed`, reason "Staff
  benefit"), as the prototype folds it. So `sale_discount_parts_check`
  (sales.ts:477) and the manual bucket stay as they are.
  - This is additive and needs no change to any check.
  - The server refuses a "Staff benefit" manual discount that has no
    benefit application behind it.
- **`analytics.fact_benefit_daily`**: branch, business_date, role,
  beneficiary, and the four relief amounts with their counts.
- **Box bundle scope `benefits`.** It carries:
  - the public keys
  - the revocation list
  - each employee's comp and standing percent for the offline path only
  - quotas stay in the cloud
- The engine moves to `packages/shared` as `benefits.ts` with satang
  inputs, whole-baht rounding (Q8) and the `PRICING_ENGINE_VERSION`
  stamp, so the box and the cloud compute the same relief and an offline
  replay is checked against the version it was priced with.

## 8. The rounds

| Round | Scope | Acceptance |
|---|---|---|
| 1 | The engine in `packages/shared` held by tests to the prototype's own cases. The `core.employee` columns and seeded employees. Templates and profiles with effective dates and history. Admin > Staff Benefits on real data: templates, the staff list from `core.employee` (read-only), role assignment, the override dialog, and the UI additions (effective date and history). Audit `benefit.template_update` and `benefit.profile_update`. | Check 1 on seeded employees. Check 2 at the Q2 amounts. Parity: the same cart, profile and usage give the same four amounts as `applyStaffBenefits`. |
| 2 | The credential: issue (Ed25519 via `core.signing_key` purpose `benefit_qr`), revoke, the payload behind BenefitQrDialog, the `benefits` box scope with keys and the revocation list, the box scan handler for kind `benefit`, `POST /benefits/resolve`, and refusal at sign-in, at the gate reader and at the booth badge path. Audit `benefit.credential_issue` and `benefit.credential_revoke`. | Check 3's revoked case. Check 6's "refused at sign-in and at the gate". |
| 3 | Checkout: preview, apply and remove on the F&B sale; server recompute; the "Staff benefit" manual discount linked to its application, with per-line allocations; the quota claim in the sale's transaction; idempotency on the client id; the offline rule on the box ("online only" on free items and credit; comp and percent as box facts); `apps/pos` OrderStation and BenefitScanModal moved off `mockApi`, with the scan modal's words kept; refusal of an unlinked "Staff benefit" discount; `benefit.apply` and `benefit.comp` (sensitive) audit with station and box in the detail. | Checks 3, 4, 6 and 7. A grep test: no benefit function is imported from `mockApi` in `apps/pos`. |
| 4 | The Audit log on real data. `GET /reports/benefits`. The Discounts & Comps rows, and the split if Q10 says yes. The refund behaviour per Q4. `fact_benefit_daily` and `job:benefit.period_rollover` with its expectation. The employee mirror swapped in when S2-17b lands. The seed: templates at the Q2 amounts, the four employees with credentials, Nok's override, one Manager edit dated in the future. The closing audit and the staging walkthrough (QA steps 1-7). | All 7 checks, with screenshots attached to SCRUM-218. Check 1 says "seeded" until the mirror exists. |

Size: L.

**Permissions.**

- `pos:benefit:apply` goes to reception and staff.
- `admin:benefit:read`, `admin:benefit:manage` and
  `admin:benefit:credential_issue` go to branch_manager (read) and
  operator_admin (all).
- `pos:benefit:comp` is created only if Q3 says yes.

**Audit actions.**

- `benefit.template_update`, `benefit.profile_update`,
  `benefit.credential_issue`, `benefit.credential_revoke`, `benefit.apply`
  and `benefit.comp` (sensitive, on the "Admin log" preset).
- `benefit.reverse`, only if Q4 says yes.

## 9. Known effects of following the prototype

- An override does not follow later template changes (Q1). A person with
  an override keeps the old template values until their override is
  edited.
- Usage is not returned on a refund (Q4). A refunded coffee still counts
  against today's two.
- The benefit is worked out on the cart's undiscounted lines. With a
  manual discount on the same order, the two together can be more than
  the bill. The discount cascade caps the total, so the recorded relief is
  what was actually taken, but the quota claimed is what the engine
  worked out (H15).

## 10. Questions for the owner (the prototype's behaviour is the default)

- **Q1. Override.** When a person's override is on, is it their whole
  profile (the prototype's code and dialog: "Overrides replace this staff
  member's role template entirely"), or does it replace only the parts it
  sets (R-109, the plan)? Default: the whole profile.
- **Q2. The real amounts.** What is the Manager's monthly credit, and what
  are the percentages? Default: the prototype's figures. Owner: comp.
  Manager: ฿500 a month, 30% off F&B and 2 coffees a day. Staff: 2
  coffees a day and 30%. The plan's ฿5,000 has no source (BL says "฿X",
  and the proposal says to read its examples as illustrations, open
  question 12).
- **Q3. Comp permission.** Does a whole-bill comp need its own permission,
  or is a sensitive audit row enough (R-08, the prototype)? Default: the
  audit is enough. Reception can already comp by hand.
- **Q4. Refunds.** When a benefited order is refunded, does the free coffee
  or credit come back to the period, or stay used (the prototype)?
  Default: stays used, with the audit kept.
- **Q5. Where.** Is a benefit scanned at the F&B station only (R-70, the
  prototype), or at the ticket till as well? Default: F&B only, and no
  seeded role targets `everything`.
- **Q6. When a day or month turns over.** Calendar midnight (the
  prototype) or the 05:00 business day? Default: the same answer as
  SCRUM-497 #46.
- **Q7. The booth badge.** May a benefit QR also sign staff in at the booth
  (booth audit R30, Q7, which points badge sign-in at SCRUM-218), or never
  (C13: "never a password or PIN", and the plan says the badge "opens no
  session")? Default: never; booth badges stay account credentials
  (`core.credential` kind `badge`). Also confirm that Open decision 28
  ("Sprint 3") is superseded by S2-21 being in Sprint 2.
- **Q8. Rounding.** Whole baht, as the prototype rounds and as manual
  percent discounts now do (SCRUM-495 #10), or to the satang? Default:
  whole baht.
- **Q9. Your own benefit.** May the staff member ringing up the order apply
  their own QR? Default: yes, as in the prototype, with both names on the
  audit row.
- **Q10. Reporting.** Is the prototype's "Staff benefit" row on Discounts &
  Comps plus the Staff Benefits audit log enough, or should Discounts &
  Comps also split comp, free items, credit and standing discount (a UI
  addition)? Default: the prototype's rows. The split is available from
  `GET /reports/benefits` either way.
- **Q11. Order with other discounts.** The prototype adds the benefit after
  the order's own manual discounts (both before promo codes). The plan
  puts the benefit first. Default: the prototype.

## 11. Hazards, each with its test

| # | Hazard | Test |
|---|---|---|
| H1 | Two tills claim the last coffee or the last satang of credit | A concurrency test: one success, one `BENEFIT_QUOTA_EXHAUSTED`, one usage row at the quota |
| H2 | Quota used but the sale fails or is voided before finalising | A forced failure after the claim rolls the usage back, and `DELETE /sales/:id/benefit` returns it |
| H3 | The till's relief figure is trusted | A tampered apply body is ignored, and the stored relief equals the server's recompute |
| H4 | A future-dated change alters today | A Manager edit dated tomorrow: today's checkout uses the old amount, and both rows are in history |
| H5 | History overwritten | An edit closes the previous row's `effective_to`, and no row is updated in place |
| H6 | A forged, expired or wrongly-keyed QR is accepted | Unsigned, wrong `kid`, bad signature and expired payloads are all refused, online and on the box |
| H7 | A revoked QR still works offline | After the bundle refresh, the box refuses a revoked credential. The time between revoking and the refresh is written down and alerted on by `ops_expectation` |
| H8 | A benefit QR opens a session or a gate | Sign-in, the booth badge path and the gate reader each refuse an `OTO-BEN` payload |
| H9 | A wallet moves | Wallet balances and wallet liability are unchanged after any benefit |
| H10 | Benefit relief counted as revenue or as a tender | No benefit tender exists. Sales report gross excludes the relief, as it does any discount |
| H11 | Free items or credit used offline | The box refuses both offline ("online only") and uses nothing up. Comp and percent queue and replay once |
| H12 | An offline replay prices differently | A box fact carries the engine version, and the replay with that version matches |
| H13 | The period follows a wrong device clock | Server and box keys at 23:59 and 00:01 Bangkok time, and with a skewed box clock (refused under low clock trust) |
| H14 | VAT by the wrong category | A coffee-only benefit on a mixed order: the allocations sit on the coffee line, and the VAT export matches the receipt to the satang |
| H15 | Manual discount plus benefit exceed the bill | The cascade caps the total, and the stored application amount equals the discount row's `amount_satang` |
| H16 | The mock benefit path stays live | A grep test for no benefit `mockApi` imports in `apps/pos`, and the server refuses a "Staff benefit" discount with no application |
| H17 | An employee who has not been copied, or has left, gets a benefit | Refused. An unknown employee raises `otoapp:employee.sync`, and an archived one's credentials are refused |
| H18 | Overlapping template or profile ranges give two answers for one day | Saving an overlapping range is refused, and `effective?on=` returns exactly one profile for any date |
