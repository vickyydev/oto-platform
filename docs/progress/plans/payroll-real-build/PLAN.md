# Payroll, built for real — the rulebook as the OTO App's month-end

**Ticket:** SCRUM-564. **Spec:** `docs/features/oto-app-payroll-rulebook.md`.
**Source of the rules:** the browser prototype in `imports/oto-app`
(engines in `client/src/lib/payroll-prototype/`, ten phase specs in
`docs/superpowers/specs/`). It is reference input only: nothing is built
from `imports/`, and nothing under it is committed. Every ported file is
copied into our tree and committed there.
**Status:** plan only. No product code, migrations or Jira changes come
with this file.

## The rulings this plan follows (owner, 2026-10-20)

- **Build it as written.** The prototype's logic is the owner's own design.
  Payroll is built for real in `apps/oto-app` from the rulebook, after the
  R6 screen wave.
- **The four concerns are recorded, and they do not block the build.** They
  go to the next meeting with the park's side, or to the next round of park
  testing. Where a concern leaves the behaviour unclear, the build follows
  the prototype exactly, marks the spot in code, and notes it on the story
  ticket.
- **Thailand only goes live.** The engine keeps its multi-country shape.
  The fictional Malaysian branch's rules stay as dormant configuration.
- **The old dormant engine is retired at cutover.** That happens once the
  new month-end has run end to end.
- **The September golden example is the acceptance test.** The real engine
  must reproduce its numbers exactly.

### The four concerns (rulebook §9)

1. **Attendance deductions are likely counted twice** in the company
   engine. They are added once as attendance-rule lines and again through
   the older engine's deduction lines. The golden fixture sets
   `deductionRules: []`, so the golden cannot catch this.
2. **PIT is never checked against expected figures.** The golden GM uses a
   manual PND.1 override, and everyone else has PND.1 switched off. Prior
   withholding is estimated even when locked months exist.
3. **Advances have no protection.** There is no net-pay floor and no
   percent-of-net rule, and the instalment count is not used. This also
   differs from the advances rule our platform already has (SCRUM-276).
4. **The two internal engines disagree** on four things:
   - percent rates versus decimal rates;
   - a strict `>` target gate versus `≥`;
   - worked days versus scheduled days for day-rate pay;
   - allowance proration that ignores the configured divisor.

   The real build must pick one answer for each pair.

§5 below settles where each concern lands. Concern 1 is the only one the
port can avoid without changing a golden number, so the port avoids it.

## What reading the code changed

These findings correct or sharpen claims in the rulebook. Each one is noted
on SCRUM-564 and fixed in the rulebook text in the commit that lands R1.
Prototype paths are relative to `imports/oto-app/client/src/lib/payroll-prototype/`.

- **The company month-end never feeds statutory documents or the OT bank.**
  - The statutory-document engine reads the older engine's per-branch
    `RunSnapshot` records (`statutory-shared.ts:51-56`,
    `statutory-engine.ts:78, 209, 350`).
  - The OT bank's earned lots come from the same place (`ot-bank.ts:90-98, 157-188`).
  - The company lock writes only `doc.snapshots`, never those records
    (`company-workflow.ts:44-47`).
  - The company calculation also hides them from itself
    (`runSnapshots: []` at `company-calculations.ts:53`).

  So in the prototype, a company run that banks OT credits nothing, and
  PND.1ก, 50 ทวิ and the EWF documents never see a company run. Rulebook §4
  ("earned lots come only from the latest locked run version") and §8
  ("statutory documents render only from locked snapshots") describe the
  older flow. The real build connects them through a *snapshot bridge*
  (R4, R6). That is an addition, not a port, so it is flagged for the owner.
- **Concern 2, the mechanism.** The company engine calls `cumulativeTax(…,
  undefined)` (`company-calculations.ts:229-230`). With no year-to-date
  input, prior withholding is always the estimate
  `baselineAnnualTax × periods` (`calculations.ts:382`).
- **Concern 3, the other side.** The advances rule we "ship" (SCRUM-276)
  is dormant, and it does not work:
  - The schema's repayment types are `FIXED_AMOUNT | FIXED_MONTHS |
    PERCENT_OF_NET` (`apps/oto-app/shared/schema.ts:3768`). The engine tests
    for `"FIXED"`, `"PERCENT_OF_NET"` and `"INSTALLMENT"`
    (`apps/oto-app/server/payroll-calculation.ts:285-293`). The two fixed
    types therefore deduct 0.
  - The percent rule is applied to *gross* pay, not net (`:290`).
  - `POST /api/payroll/advances` writes columns that do not exist
    (`apps/oto-app/server/routes.ts:25934-25943`). The API census asserts it
    returns 500 (`apps/api/test/s217b-r7-payroll-cross-review.test.ts:487-490`).

  No live behaviour is lost by building the prototype's rule.
- **Revenue incentive divisor.** The rulebook's "× eligible days ÷ employed
  days" holds only when `partMonth` is not `"prorate"`
  (`company-awards.ts:83`). The prototype migrates every seeded rule to
  `"prorate"` (`company-rewards.ts:50`), and those rules divide by
  *calendar* days. The golden rules leave `partMonth` unset. The server
  must store `partMonth` exactly as configured and never default it to
  `"prorate"`.
- **Fixed allowances also apply to owner-household workers**, not only to
  monthly ones (`company-calculations.ts:100`).
- **GM confirm can pass non-attendance blocking items.** The prototype's
  confirm screen calls `approveCompanyRun(…, { allowOpenProblems: true })`
  (`components/payroll-prototype/company-approvals.tsx:41`). That lets
  every blocking item through except Attendance ones
  (`company-workflow.ts:20`). Owner lock still refuses any blocking item
  (`:35`). Rulebook §8 reads as if all must clear before confirm. We port
  the behaviour as built.
- **The golden runs two code paths that our storage will never produce
  without care.**
  - It has no service-charge `groups`, so it runs the simple distribution
    (`company-awards.ts:14`).
  - It has no `incentiveAssignments` and no `incentiveVersions`, so it runs
    the fallback path (`company-rewards.ts:24-29, 40-43`).

  The server always stores dated versions and assignments, and must store
  policies without inventing groups. The prototype's own migration adds an
  "Everyone" group and job-title exclusions (`company-rewards.ts:62-69`); we
  do not run that migration. The golden over HTTP (§6) is what proves the
  stored form gives the same numbers.
- **Salary is not dated.** Only allocations carry an effective date
  (`payroll-profile.ts:26-40`). Reopening a past month recalculates it with
  today's salary. This is built as is: frozen snapshots protect locked
  months. It is recorded as a note, not as a fifth concern.

## 1. Schema

### Rules for every new table

- Every new table carries `tenant_id uuid NOT NULL REFERENCES tenants`.
  `tenant_id` is the park group.
- Child tables carry `tenant_id` too, with a composite foreign key
  `(tenant_id, parent_id) → parent(tenant_id, id)` on a unique
  `(tenant_id, id)`. A row can then never point across park groups. The old
  engine's `payroll_runs` and its children have no tenant column. That is
  why the old routes need `verifyRunAccess` to scan the children
  (`routes.ts:25513`), and we do not repeat it.
- Employee references use `employees.id` with `ON DELETE RESTRICT`, so
  locked payroll can never be deleted from under a payslip.
- Money is `numeric(14,2)`, and hours are `numeric(10,4)`. The engine works
  in JS numbers exactly as the prototype does. The database only stores
  them.
- Migrations follow `apps/oto-app/migrations/README.md`:
  - generate with drizzle-kit, then hand-edit;
  - strip `"public".`;
  - expand-only;
  - commit the `.sql`, snapshot and journal together.

  The journal ends at `0020_user_preferences`, so ours start at **0021**.
  These numbers assume the R6 screen wave adds none. If it does, every
  number below shifts up by the same amount (§9, "Migration numbering").

### New tables, by migration

**0021 `payroll_config`** (R2)

| Table | What it holds |
|---|---|
| `payroll_paying_entities` | The legal company that pays: id, name, country (`TH`/`MY`), tax id, SSO employer number, optional `operator_id` link, `default_pay_day` (seed 28), `archived_at`. This is the prototype's `PayingEntity`. We have no legal-entity table today. |
| `payroll_paying_accounts` | The company's own bank accounts: entity, label, bank, bank code, account number, account name, file format (`SCB/KBANK/BBL/GENERIC`), SCB product, debit and fee accounts. This is `PayingAccount`. |
| `payroll_branch_details_versions` | One dated row per branch: `branch_id`, `effective_from`, plus `details jsonb` in the prototype's `BranchDetails` shape (SSO branch number, paying entity, default paying account, legal name, employer number, tax id, address, country, currency, timezone, pay date, payroll bank). Adds a `food_allowance_default` column (§8). |
| `payroll_revenue_streams` | The stream catalogue per tenant: key and label. Replaces `COMPANY_STREAMS` (§8). |
| `payroll_rule_lists` | Dated lists: `kind` (`deduction`), `scope` (`company`/`branch`), `branch_id`, `effective_from`, `rules jsonb` (`DeductionRule[]`), who, reason. This is `companyDeductionRuleDefaults` plus branch exceptions. |
| `payroll_ewf_settings_versions` | `entity_id`, `effective_from`, `settings jsonb` (`EwfSettings`), who, reason. **None are seeded** (§8). |
| `payroll_ewf_remittances` | `entity_id`, month, amount paid, paid on, who, reason. Used for surcharge estimates. |

**Reuse with an extension: `statutory_rule_sets`** (`schema.ts:4244`). It
already has tenant, optional operator and branch, `country_code`,
`effective_from/to` and `rules jsonb`. 0021 adds one column:
`rule_format text NOT NULL DEFAULT 'legacy-v1'`.

- New rows are `'company-v1'`. Their `rules` is the prototype's
  `StatutoryRules` stored as is.
- A row with `branch_id` null is the company default (`companyPayRules`).
  A row with a branch id is a branch exception (`branchPayRuleExceptions`).
- The old engine reads only `legacy-v1` rows. Its `getStatutoryRules`
  (`payroll-statutory.ts:409`) gets a format filter in the same commit, so
  the two engines never see each other's rows.

**0022 `payroll_profiles`** (R2)

| Table | What it holds |
|---|---|
| `payroll_profiles` | One per employee, unique `(tenant_id, employee_id)`. Holds the scalar fields of `EmployeePayrollProfile`: worker type, job title, monthly salary, day rate, fixed fee, joined on, last working day, tax id, SSO number and title, given name, surname, date of birth, nationality, passport, leaving reason, food eligibility and per-day amount, the SSO/PND.1/SC/OT flags, PND.3 %, cash-fee %, payment method, bank details, third-party reason, student loan monthly, notes, department, plus `revision int` for optimistic saves. |
| `payroll_profile_allocations` | Dated allocation versions: profile, `effective_from` (unique per profile), `home_branch_id`, `lines jsonb` (`AllocationLine[]`: cost centre is a branch id or the literal `owner-non-operational`, plus percent, entity and optional paying account). |
| `payroll_profile_advances` | `SalaryAdvanceProfile`: principal, outstanding balance, mode (`one-off`/`instalments`), instalments, monthly repayment, starts on. **Supersedes** `salary_advances` (concern 3). |
| `payroll_profile_separate_payments` | Description, amount, withholding %. |
| `payroll_profile_changes` | Append-only audit: who, when, reason, old and new jsonb. This is `ProfileSetupAudit`. |

**0023 `payroll_month_inputs_and_rewards`** (R3)

| Table | What it holds |
|---|---|
| `payroll_month_inputs` | One row per `(tenant, month)`: `inputs jsonb` holding the prototype's `CompanyMonthInputs` (revenue per branch and stream with amount/VAT/SC, discounts, per-person `daysWorked`/units/KPIs/bonuses/`pnd3Basis`, counts, `sources`), plus `revision int`. Keeping the document whole is what lets the engine run verbatim and lets the freeze copy it. |
| `payroll_month_input_changes` | Append-only: key, prior value, new value, source kind, reason, who, at. Backs `overrideCompanyInput`. |
| `payroll_service_policies` | branch, `version`, `effective_from`, `policy jsonb` (`ServicePolicy`, with `groups`/`exceptions` **only when configured**), superseded, who, reason, at. |
| `payroll_incentive_rules` | rule id, current terms (`CompanyIncentive`), enabled. |
| `payroll_incentive_rule_versions` | rule, version, terms jsonb, effective from/to, superseded, who, reason, at. |
| `payroll_incentive_assignments` | rule, `employee_id` *or* `job_title`, `branches text[]`, effective from/to, personal rate, excluded, superseded, who, reason, at. Replaces assigning rules by staff id or array index (§8). |

**0024 `payroll_ot_bank_and_leave_valuation`** (R3)

| Table | What it holds |
|---|---|
| `payroll_ot_bank_bookings` | `OtBankBooking`: employee, date, hours, reason, created by and at. Time off taken against the bank. |
| `payroll_leave_valuations` | One row per paid-out or unpaid leave event: `employee_time_off_id` (or exit record), kind (`unpaid`/`payout`), dates, days, **frozen daily rate**, taxable, SSO, decided by, reversed by. This is the payroll half of the prototype's leave ledger (§3). |
| `payroll_offboarding` | resignation date, last working date, reason. Feeds the OT bank resignation payout and the exit leave payout. |

**0025 `payroll_runs`** (R4)

| Table | What it holds |
|---|---|
| `payroll_month_runs` | unique `(tenant_id, entity_id, month)`, `current_version`, `pay_date`. |
| `payroll_run_versions` | run, `version` (unique per run), status (`draft`, `gm-confirmed`, `locked`, `paid`, `superseded`), stage, `approved_signature`, GM user and time, owner user and time, paid by and at, `reopen_reason`. |
| `payroll_run_attendance_reviews` | version, `attendance_day_key`, action (`confirm`/`override`/`excuse`), clock-in and clock-out, reason, who, at. This is `CompanyDraft.attendance`. |
| `payroll_run_overtime_decisions` | version, `attendance_day_key`, exception index, outcome (`Pay`/`Bank`/`Reject`), reason, resolved by and at, `employee_choice_confirmed`. In the prototype these sat on the older per-branch draft (`company-calculations.ts:72`). Here they belong to the company run. |
| `payroll_run_overrides` | `CompanyOverride`: employee, entity, component, amount, reason. |
| `payroll_run_manual_lines` | `CompanyManual`: employee, amount, kind (`bonus`/`deduction`), reason. |
| `payroll_run_third_party_approvals` | employee, signature, reason, who, at. |
| `payroll_run_audit` | Append-only. |
| `payroll_run_snapshots` | One per **locked** version. Detailed below. |
| `payroll_run_lines` | Lines written out from the snapshot at lock: version, employee, entity, component, category, amount, `allocations jsonb`, taxable, SSO wage. Read-only. Used by history, YTD and advance-repayment queries, and by the census. |
| `payroll_output_files` | version, group, filename, mime, object key, sha256, rows, total. Bank files, SSO/EWF uploads, cash list, reports, payslip PDFs. |
| `payroll_ot_bank_ledger` | Lock-time copy of the OT bank ledger for screens and the reopen guard (see "OT bank" below). |

**0026 `payroll_statutory_documents`** (R6)

| Table | What it holds |
|---|---|
| `payroll_statutory_documents` | `StatutoryDocument`: code, period, entity, optional employee, source runs `[{entity, month, version}]`, provisional flag, coverage jsonb, warnings, due date, file key, created by. |
| `payroll_statutory_filings` | date, reference, who. |
| `payroll_statutory_audit` | Append-only. |

### Reused as is

- `employees`: identity, branch, `tax_id_number`, `sso_number`,
  `nationality`. These are read when a profile is first created, never
  written by payroll.
- `branches`, `operators`, `tenants`, `departments`.
- `public_holidays` (`schema.ts:2950`): the holiday flag on attendance days.
- The SCRUM-560 leave tables: `leave_types`, `employee_leave_overrides`,
  `employee_leave_balance_openings`, `employee_time_off`.
- `time_entries`, `timekeeping_issues`, schedules: the attendance feed (§3).
- Object storage through `server/file-storage.ts`.

### Left in place until retirement (R8), then removed by a later contract migration

`payroll_periods`, `payroll_runs`, `payroll_day_reconciliations`,
`payroll_exceptions`, `payroll_exception_approvals`, `payroll_line_items`,
`payroll_employee_summaries`, `payslips`, `salary_advances`,
`salary_advance_repayments`, `statutory_calculation_results`,
`payroll_policy_settings`, `employee_payroll_profiles`, and the
`legacy-v1` rows of `statutory_rule_sets`.

- Nothing new writes to these tables.
- R2 reads `employee_payroll_profiles`, `salary_advances` and the employees'
  `default_merge_data.salaryThb`, `daily_rate`, `food_allowance_per_day`
  and `employment_basis` **once**, to propose draft profiles that a human
  reviews (§9 R2). The prototype's own boundary note asks for exactly this
  reconciliation (`imports/oto-app/docs/payroll-hr-prototype-boundary.md`).
- The contract migration that drops these tables is its own later ticket.
  It waits until a production-restore check shows their row counts, and
  until any retention decision is made.

### Frozen snapshots

`payroll_run_snapshots` has one row per locked version and keeps the
prototype's `CompanySnapshot` almost field for field:

| Column | Contents |
|---|---|
| `result` | `CompanyResult` for the entity |
| `calculation` | the whole `CompanyCalculation` |
| `outputs_manifest` | `CompanyOutputs` without the file bodies, which go to `payroll_output_files` and object storage, each with its sha256 |
| `audit` | the run audit at lock |
| `reward_config` | assignments, versions, service policies |
| `input_snapshot` | `CompanyMonthInputs` for the month and the month before |
| `world` | **the whole input the engine saw**: profiles, rules, attendance days, OT decisions, leave valuations, OT bookings, accounts, entities, and prior snapshot summaries |
| `engine_revision`, `source_signature`, `locked_at`, `locked_by`, `gm_actor` | |

- `world` goes beyond the prototype's `inputSnapshot`. Re-rendering a
  payslip, the statutory bridge and the OT bank then never depend on live
  tables that have since changed.
- A trigger rejects `UPDATE` and `DELETE` on `payroll_run_snapshots`,
  `payroll_run_lines` and `payroll_output_files`.
- Object keys include the version, and objects are never overwritten.
- A reopened month gets a new version and a new snapshot. The old snapshot
  is kept, and its version becomes `superseded` only once the new version
  locks.

### The source signature on the server

The prototype hashes `JSON.stringify` of every input with 32-bit FNV
(`company-calculations.ts:19-38`). The server function `sourceSignature(world,
runInputs)` covers **the same list**:

- profiles; assignments and versions;
- branch details, rules and deduction lists; EWF settings;
- leave valuations; OT bookings; offboarding;
- paying accounts; policies; incentive rules;
- the month inputs for this month and last month; attendance for both months;
- run reviews, overrides, manual lines, pay date and third-party approvals;
- OT decisions; prior snapshot summaries;
- `ENGINE_REVISION`.

Two things change:

- **Canonical JSON.** Keys are sorted, and every row list is sorted by id.
  The hash no longer depends on the order Postgres returns rows in, which
  would otherwise void a GM confirmation for nothing.
- **sha256** from `node:crypto` replaces FNV. No number depends on the hash.

`ENGINE_REVISION` is a constant in `server/payroll/engine/revision.ts`,
bumped by any engine change. A deploy that changes the engine between GM
confirm and Owner lock therefore forces a reconfirm, which is the
prototype's intent. GM confirm stores the signature. Lock recomputes it
inside the lock transaction and refuses on any difference, with the
prototype's message.

## 2. Where the engine lives

The rule is simple. The engines become pure server modules under
`apps/oto-app/server/payroll/engine/`, ported **nearly verbatim**. The
browser store (`context.tsx`, 3,572 lines) is **not** ported. Its
orchestration becomes services in `server/payroll/services/` and routes in
`server/payroll/routes.ts`.

The engine's input stays the prototype's aggregate. `PayrollPrototypeData`
is renamed `PayrollWorld`, and `CompanyPayrollDocument` is assembled per
month. A **world loader** (`server/payroll/world.ts`) builds both from the
database for one `(tenant, month)`. That keeps every pure function's
signature and body intact.

Type changes the port makes everywhere:

- `BranchId` becomes `string` (our branch ids).
- `StaffRole` becomes `string`.
- `model.ts` loses its React, `import.meta.env` and storage-key tail
  (`model.ts:883-941`).

### Port as is (pure: rename imports and the type changes above, nothing else)

- `company-math.ts`, `company-model.ts`, `company-awards.ts`,
  `company-service-groups.ts`, `company-validation.ts`,
  `company-pay-explanation.ts`.
- `company-calculations.ts`, with the concern-1 change (§5).
- `payroll-profile.ts` (`validatePayrollProfile`,
  `profileReviewWarnings`, `allocationAt`, `resolvePayingAccount`,
  `WORKER_DEFAULTS`).
- `calculations.ts` (`calculatePayrollPreview`, `cumulativeTax`,
  `effectiveRulesForMonth`, `calculateStaffWithExtras`).
- `deductions.ts`, `ewf-engine.ts`, `ewf-documents.ts`,
  `statutory-shared.ts`, `statutory-th.ts`.
- `statutory-my.ts`: kept compiling, dormant (§4).
- `scb-upload-files.ts`, `statutory-upload-files.ts`,
  `ewf-upload-file.ts`, `upload-common.ts`. These use `xlsx`, already a
  dependency (`apps/oto-app/package.json:135`).
- `company-upload-files.ts` and `company-outputs.ts`, without the
  browser-only `download*`/`print*` helpers. These need `fflate` added as a
  dependency, since nothing else provides it.
- `run-calculations.ts` (`calculateMonthEnd`), **whole, with its
  dependencies** `incentives.ts`, `employee-incentives.ts`,
  `voucher-eligibility.ts`.

  The company engine uses this older calculation only for overtime, leave
  payouts, OT-bank payouts, unpaid leave and deduction lines
  (`company-calculations.ts:72, 101-108, 276-283`). Its own incentive,
  voucher and allowance lines are computed and then thrown away. Porting it
  whole is the safest choice for the numbers.

  The world loader passes the legacy-only collections empty: incentive
  rules, employee plans, booth vouchers and roster. Trimming the file down
  is a later, separate subtask, gated by the parity fixture (§6).
- `ot-bank.ts`, with an injected clock (below).

### Adapt (logic moves into services; guards and messages stay word for word)

- `company-workflow.ts`. `newCompanyDraft`, `approveCompanyRun`,
  `lockCompanyRun`, `markCompanyPaid` and `reopenCompanyRun` become
  `services/month-end.ts`, each running in one DB transaction with a row
  lock on the run. The checks and their order stay the same.
- `company-issue-review.ts`. `issueGroup`, `checkFixIssues`,
  `openCheckFixProblems`, `attendancePayEffect` and
  `thirdPartyApprovalSignature` port as is. `recordAttendanceReview`
  becomes a service.
- `company-sources.ts`. The getters port as is. `overrideCompanyInput`
  becomes a service.
- `company-rewards.ts`. `assignmentFor`, `versionsForMonth`,
  `rewardMonthLocked`, `rewardStart` and `nextOpenRewardMonth` port as is.
  `saveIncentiveChange` and the service-policy save become services.
  `migrateCompanyRewards` is **not** run (see "What reading the code changed").
- `leave-engine.ts`. Only `leavePayrollInputs` is kept, re-pointed at
  `payroll_leave_valuations`, with `LeavePayoutInput` and
  `LeaveUnpaidInput` unchanged. The exit-payout half of
  `createLeaveExitPlanData` becomes a service. Accrual and balances
  **die**: SCRUM-560's engine is the only balance engine (§3).
- `statutory-engine.ts`. It gets the injected clock. `countryFor`
  (`:47`) reads the branch's country from config instead of testing a
  branch id. It reads frozen months through the snapshot bridge (R6).
- `staff-profile.ts`. `getPayrollReadiness` becomes a shared helper.
- `audit-presentation.ts`, `display-labels.ts`, `payroll-display.ts`,
  `explanations.ts`, `run-step-progress.ts`, `worked-calculation.ts` and
  `payroll-navigation.ts` are display logic. They move to
  `client/src/lib/payroll/`.
- `september-golden-fixture.ts` and `september-golden.ts` become test
  fixtures (§6).
- `demo-policy-migration.ts` keeps only `retainedServiceText`, which the
  outputs use.

### Die

- `context.tsx` and `browser-storage.ts`.
- `use-demo-role.ts`. There is no browser role switcher. The role comes
  from the session (§7).
- `seeds.ts`, `phase1-seeds.ts`, `company-seeds.ts`, `examples-*`,
  `seed-worker.ts`, `run-demo-practice.ts`.
- `foundation.ts`, `upload-settings-migration.ts`, `item4` and the other
  storage migrations.
- `leave-balance-view.ts`, `leave-permissions.ts`.
- `history-outputs.ts` and `compact-payslip.ts`. They render the older
  per-branch `RunSnapshot` with `html2canvas`/`jsPDF`. The company payslip
  is `companyPayslipHtml` (`company-outputs.ts:22`), printed to PDF on the
  server with the Puppeteer we already run (`server/pdf.ts`).

### The clock

The pure calculation (`calculateCompanyEngine`) never reads the clock.
Every `new Date()`, `Date.now()` and `Math.random()` in the prototype sits
in a mutator, which becomes a service, or in a default parameter. Each one
becomes an injected `clock.now()` or a `crypto.randomUUID()` id:

| Prototype spot | Lines |
|---|---|
| `company-issue-review.ts` | 38 |
| `company-rewards.ts` | 79, 131, 132 |
| `company-sources.ts` | 41, 73, 92 |
| `company-workflow.ts` | 25, 40, 57, 65 |
| `leave-engine.ts` | 335, 374, 376, 406, 409 |
| `ot-bank.ts` (default `asOfDate`) | 342 |
| `statutory-engine.ts` (`generatedAt`) | 425 |
| `seeds.ts` (`getRecentCompletedMonths`) | 181 |

The engine check asserts the calculation is deterministic, as the
prototype's own golden test does (`september-golden.test.ts:12-16`).

## 3. The attendance feed

`server/payroll/attendance.ts` turns our real attendance into the
prototype's `AttendanceDay[]` (`model.ts:671-691`), one per person per day.
`company-math.workedDates` then applies its rule unchanged: **a worked day
is any day whose effective clock-in exists after corrections, and a run
override's clock-in wins** (`company-math.ts:23-32`).

| `AttendanceDay` field | Our source |
|---|---|
| `id` | `${employeeId}:${date}`. The stable `attendance_day_key` that run reviews and OT decisions refer to. |
| `date` | Branch-local date (branch timezone). |
| `actualClockIn` / `actualClockOut` | First IN and last OUT from `time_entries` for the shift-day (`schema.ts:2097`), as recorded. |
| `effectiveClockIn` / `effectiveClockOut` | The approved values. These are the time entry once `APPROVED`/`LOCKED`, after any resolved `timekeeping_issues` correction (`schema.ts:2212`; written by `timekeeping-review-routes.ts:66-118`). `REJECTED` entries give no clock. |
| `scheduled`, `plannedClockIn/Out` | Schedule assignments and shift rows. |
| `dayOff` | `employees.weekly_off_days` or a schedule day off. |
| `holiday` | `public_holidays` for the tenant. |
| `overtimeHours` | Effective out minus planned out, when positive. The prototype's `roundedOvertimeHours` then applies the policy's minimum block and rounding. Our deriver has no OT (`timekeeping-deriver.ts`). The old engine's variance-based OT (`payroll-reconciliation.ts:397-408`) is not reused. |
| `exceptions` | late, early departure, missed punch and no-show from the deriver's anomalies, plus `overtime` when hours are above 0. **`resolution`** is `Approved`/`Corrected` when the timekeeping issue was resolved upstream, and `null` when it is still open. |
| `branchId` | The person's **roster branch for the month** (the allocation home branch at month end, `company-math.homeBranch`). The actual place worked is kept as an extra `workedAtBranchId` for display. |

On that last row: the older engine counts only attendance on the roster
branch (`run-calculations.ts:775, 893`). Stamping the roster branch keeps
OT worked at the sister branch from silently dropping out. It changes no
number when people clock in at their own branch, which is every golden and
parity case.

**Where run corrections and excuses live.** They live in
`payroll_run_attendance_reviews` against the run version, never in
`time_entries`. The prototype applies decisions "without changing source
attendance" (`model.ts:693`, `company-calculations.ts:63-70`), and so do we.

- Confirm → `Approved`.
- Override → `Corrected`, with clock times.
- Excuse → `Excused`, which never counts toward a deduction.
- A month day with an open exception and no review is a **blocking**
  "unconfirmed attendance" item (`company-calculations.ts:369-371`).
- Reopening copies the reviews into version N+1, as the prototype's
  `{...prior}` does (`company-workflow.ts:64`).

**The manual worked-days figure** stays where the prototype keeps it:
`CompanyMonthInputs.staff[id].daysWorked` in `payroll_month_inputs`, with
source `Attendance` and an override reason. It replaces the count and is
validated to `0 ≤ n ≤ employed days` (`company-math.ts:37`).

**Managers keep their side.** They continue to approve timekeeping in the
existing review screens, which carry no pay figures. That approval is what
turns an exception's `resolution` from `null` to `Approved`/`Corrected`
before payroll ever sees it. The run's own attendance step shows pay
effects (`attendancePayEffect`), so it sits behind the payroll roles (§7).

**Leave.** SCRUM-560's engine stays the only balance engine. It computes
balances on the fly with no ledger (`server/leave-types.ts:230`, `:316-399`)
and has no payout or carry-forward logic. Payroll adds only the money side,
in `payroll_leave_valuations`:

- **Unpaid leave.** When time off of a type with `paid = false` is approved,
  a valuation row freezes the daily rate. The rate is the profile day rate,
  or else monthly salary ÷ 30. That is the prototype's rule
  (`context.tsx:3170`, `leave-engine.ts:377`), applied to the profile.
- **Exit payouts.** These are recorded in the offboarding dialog (§7):
  days × frozen rate, taxable, not an SSO wage.
- **What payroll does not use.** The prototype's Days Off accrual, the
  carry-forward cap and the certificate warning are leave-policy rules.
  Where SCRUM-560 lacks them, they go on the backlog under the leave
  ticket, not into payroll.
- **Negative balances.** They never deduct automatically, as in the
  prototype. There is no code path that turns a negative balance into a
  line.

## 4. Thailand only, with the multi-country shape kept dormant

Concretely:

- **Rule sets are keyed by country.** `statutory_rule_sets.country_code`
  and `payroll_paying_entities.country` keep `TH | MY`, and the
  `StatutoryRules` type keeps its `my` block.
- **Only TH is seeded.** One `company-v1` rule set for the tenant
  (`country_code = 'TH'`, branch null) carries the prototype's Thai
  template: SSO 5% + 5% capped at ฿17,500, the PIT brackets and
  allowances, OT multipliers 1.5/2/3, hourly base 30/8/8, actual-calendar-day
  proration, `componentFlags`, and the default overtime policy. Its `my`
  block holds the template's inert defaults, because the type requires them.
- **MY code paths keep compiling and stay covered.**
  `company-calculations.ts:232-243`, `statutory-my.ts` and the MY branches
  of `calculations.ts` stay. The engine check runs one in-memory MY world
  so they cannot rot. No MY row exists in any database: not in seeds, not
  in migrations, not on staging.
- **There is no KL branch anywhere.**
  - The golden fixture drops `plaza-ombak-klcc`. It only carried zero
    revenue and an unused policy (`september-golden-fixture.ts:78-86`), so
    no number moves.
  - No `plaza-ombak-klcc` string survives the port. `countryFor`
    (`statutory-engine.ts:47`), the Borang 8A date
    (`statutory-engine.ts:174`) and `makePayrollProfile`'s food default
    (`payroll-profile.ts:59`) all read config.
  - The entity and branch settings forms offer `MY` only behind a
    platform-admin flag that nothing sets.

## 5. The four concerns in code

Every spot carries a marker comment
`// PAYROLL-CONCERN-<n> (SCRUM-564): <one line>`, so a single
`rg PAYROLL-CONCERN` lists them. Each concern is also a line in the
SCRUM-564 description, under "Recorded for the park".

### Concern 1: attendance deductions counted twice

**Is the double count real in the ported arrangement? Yes.**

1. The company engine adds one `attendance-rule:<id>` line per rule in the
   *registered* branch's `deductionRules`. It uses
   `calculateDeductionForStaff` on the roster branch's attendance, with a
   per-source budget (`company-calculations.ts:209-219`).
2. It then adds an `other:<id>` line for every `kind: "deduction"` line of
   the older calculation (`:276-283`).
3. Those lines come from the *roster* branch's `deductionRules`, through
   the **same** `calculateDeductionForStaff` on the same corrected
   attendance (`run-calculations.ts:1171-1193`).

When the registered branch is the roster branch, every rule is charged
twice. With Thai-only company-level deduction defaults, that is every
person.

**Can the port avoid it without moving a golden number? Yes.** The golden
sets `deductionRules: []` on every branch
(`september-golden-fixture.ts:23`), so both loops add nothing there.

**So the port avoids it.** It keeps the first loop, which has the proper
salary/service-charge budgeting and the rule's name. It removes the second
loop and leaves a marker explaining why.

- The engine check adds a case: two rules, one late arrival, and exactly
  one line per rule.
- The parity fixture (§6) shows the expected difference against the
  prototype: one fewer line per rule per person. That difference is
  declared in the fixture, not hidden.
- Ticket note: "Seeded tariffs now charge once. The prototype charged twice.
  Park to confirm."

### Concern 2: PIT unverified, prior withholding estimated

**Built as is.** `cumulativeTax(…, undefined)` stays at the PND.1 call
(prototype `:229-230`), with the marker on that call.

- The golden is unaffected either way. The GM has a manual 3,200 override,
  and everyone else has PND.1 off.
- Wiring real year-to-date from locked snapshots is a one-argument change
  at that call. It changes real-month numbers, so it waits for the park's
  accountant.
- Ticket note: "PIT needs a verified worked example from the accountant
  before the first live month with PND.1 on."

### Concern 3: advances without protection

**Built as is.** The prototype's block runs verbatim (prototype `:258-270`):

- one-off or instalments;
- `min(regular, remaining)`, where remaining = opening balance − advance
  lines in prior **locked** snapshots;
- no floor, no percent of net, and the instalment count ignored.

The marker sits on that block. "Repaid" is read from
`payroll_run_snapshots` through the same `doc.snapshots` adapter. The old
`salary_advances` and `payroll_policy_settings.max_advance_deduction_percent_of_net`
are not consulted. Ticket note: the old 30%-of-net cap (dormant, and broken,
see "What reading the code changed") is not carried over unless the park
asks.

### Concern 4: two engines disagree

The company engine is the one that pays. Its answer is the build's answer
on every pair, and the older calculation's line for that pair is never
paid:

| Pair | Built answer | Marker at (prototype line) | Where the older engine disagrees, unpaid |
|---|---|---|---|
| Rate units | Percent (`base × rate / 100`) | `company-awards.ts:92` | Legacy plans and vouchers use decimals (`incentives.ts`, `employee-incentives.ts`). Their lines are discarded (`company-calculations.ts:101-108` takes only OT, leave, OT-bank and unpaid lines). |
| Target gate | Strict `>` | `company-awards.ts:68` | Legacy `targetGate` `≥` |
| Day-rate days | Worked days | `company-calculations.ts:85` | Scheduled days (`run-calculations.ts:853`) |
| Allowance proration | Actual days in the month | `company-calculations.ts:100` | Divisor (`run-calculations.ts:868`) |

On the last pair: the seeded rule uses `actual-calendar-days`
(`seeds.ts:321`), so the two agree today. They diverge only if someone
switches to the fixed 30-day divisor, and the pay-rules form shows a
warning there.

## 6. The golden test and the smaller checks

### `apps/oto-app/tests/payroll-golden.check.ts`

This follows our `*.check.ts` pattern: run with `npx tsx` against a
migrated `DATABASE_URL`, and wired as a step in the `oto-app` CI job after
the leave-types check (`.github/workflows/ci.yml:593`). It has three legs,
all asserting the prototype's 11 checks with the prototype's tolerance:
integer cents ±1 for THB, 1e-7 for days and rates, and exact text
(`september-golden.ts:30-37`).

1. **Engine leg (pure, no DB).**
   - `tests/fixtures/payroll/september-golden.ts` is the ported fixture
     without the KL branch. Its Thai rules template is copied from
     `seeds.ts:290-330`, with the fixture's own overrides: allowances
     `[]`, SSO 5%/5%/17,500, `deductionRules: []`.
   - It builds a `PayrollWorld` in memory and runs `calculateCompanyEngine`
     and `generateCompanyOutputs`.
   - It asserts all 11 checks, including the bank CSV bytes and the
     remove-mode comparison.
   - It also runs the prototype's determinism test and its two mutation
     tests: salary +1 must fail check 1, and the chef with no PND.3 basis
     must give 3,077.78 (`september-golden.test.ts:12-30`).
   - It lands in R1.
2. **Service and HTTP leg (the real thing).**
   - It creates an isolated fixture tenant with the existing test helpers.
   - It loads the same fixture **through the real config services**:
     entity, the two SCB accounts, branch details for both branches, the
     rule set, service policies, incentive rules (stored as versions plus
     assignments), 53 profiles (15 people plus 38 prior-month leavers), and
     month inputs for 2026-08 and 2026-09.
   - Setup goes through services for speed, with the same validation the
     routes use. Then it **calls the routes**: create the run, add the
     manual bonuses and the GM PND.1 override, then
     `GET /api/payroll/month-end/:entity/:month/preview`.
   - It asserts the same 11 checks against the response.
   - This is the leg that proves the stored form (versions, assignments,
     policies without groups) gives the prototype's numbers.
   - It lands in R3 for checks 1-9 and R5 for checks 10-11.
3. **Lifecycle leg.**
   - The same tenant goes through GM confirm, Owner lock, mark paid and
     reopen.
   - Lock needs clean upload files (`company-workflow.ts:37`), so this leg
     gives each fixture person a valid fictional Thai ID
     (`upload-common.ts:22`), an SSO title and a given name. Those fields
     feed only warnings and upload files, never a number.
   - It asserts:
     - the snapshot's `result` equals the preview;
     - bank files plus cash equal net to the satang;
     - exactly one payslip for the GM;
     - mark paid passes the reconciliation;
     - reopen creates version 2 as a draft with v1 frozen and unchanged;
     - a second tenant gets 404 on every one of the fixture's run URLs.
   - It lands in R4 and is completed in R5.

**The golden ratchet.** The file declares each check with the round that
switches it on. CI fails if a switched-on check fails, and fails if a
round's PR leaves its checks off. By R5 every check of every leg is on.

### `apps/oto-app/tests/payroll-engine.check.ts` (pure, fast)

- The prototype's own engine tests, ported. They use `node:test` now and
  become our `check()` blocks:
  - `company-calculations.test.ts`, `company-rewards.test.ts`,
    `company-sources.test.ts`, `company-issue-review.test.ts`,
    `company-workflow.test.ts`;
  - `ot-bank.test.ts`, `payroll-profile.test.ts`,
    `ewf-upload-file.test.ts`, `upload-formats.test.ts`,
    `worked-calculation.test.ts`, `owner-run-preparation.test.ts`,
    `check-fix-step.test.ts`.

  `employee-incentives.test.ts` and `deduction-job-titles.test.ts` are
  ported too, because their engines are part of the port.
- One case per concern marker:
  - concern 1: one line per rule;
  - concern 2: PND.1 estimate path;
  - concern 3: one-off and instalments against locked history;
  - concern 4: each pair's built answer.
- A dormant MY world, so the MY paths compile and run.
- **The parity fixture.**
  - Generated locally, once, by running the prototype engine on its own
    seed world for 2026-09 and 2026-10. That world has OT, OT banking,
    leave, deductions, every incentive kind and EWF.
  - The world and the expected per-person lines are committed as JSON
    under `tests/fixtures/payroll/parity/`. It is fictional seed data, not
    an import.
  - The port must match line for line, except the declared concern-1
    difference.
  - This covers everything the golden switches off: OT, leave,
    deductions, EWF and grouped service charge.

### Other checks

- `payroll-attendance.check.ts` (R3): `time_entries` and issues in,
  `AttendanceDay` out. Covers worked day, rejected entry, corrected clock,
  open exception, holiday, day off and the roster branch.
- `payroll-access.check.ts` (R2, then extended each round):
  - each role against each route;
  - staff see only their own locked payslips;
  - managers are refused every payroll route;
  - cross-tenant reads return 404.

**CI time.** The engine and pure-golden legs take under 2 s. The HTTP and
lifecycle legs set up one tenant with 53 profiles and calculate about four
times: an estimated 10-20 s of the `oto-app` job, on top of the migrate
that already runs (`ci.yml:478-484`). Neither leg goes into the API vitest
shards.

## 7. The UI

### Prototype pages that become real pages

They are wired to the new routes through react-query hooks that replace
`usePayrollPrototype()`. Pages that are added now replace the old ones in
R7 (see "Old pages" below).

| New route | From the prototype | Round |
|---|---|---|
| `/payroll` (hub) | `payroll-hub.tsx`, `hub-frame.tsx`, `needs-attention.tsx` | R7 (R2 adds it beside the old one) |
| `/payroll/setup` | `payroll-setup-hub-demo-page`, `paying-configuration-editor`, `payroll-settings-demo-page` (pay rules), `payroll-components-demo-page`, `payroll-deductions-demo-page`, EWF settings | R2 |
| `/payroll/setup/rewards` | `company-service-policies`, `company-service-builder`, `company-incentive-builder`/`-editor`/`-history`, `company-employee-incentives` | R3 |
| `/payroll/people`, `/payroll/people/:employeeId` | `profile-roster`, `payroll-profile-editor`, `payroll-profile-summary`, `payroll-employee-profile-demo-page`. The HR employee editor's Payroll tab uses the same `employee-payroll-panel`. | R2 |
| `/payroll/month-end?month=` | `payroll-company-month-end-demo-page` with `company-attendance`, `company-inputs`, `company-input-boxes`, `company-input-sources`, `company-issue-drawer`, `company-item-drawer`, `company-person-drawer`, `company-overview`, `company-matrix`, `company-approvals`, `run-side-panel`, `step-help` | R3 (inputs, read-only preview), R4 (full flow) |
| `/payroll/month-end?month=…&tab=outputs` | `company-outputs-panel`, `downloads-list` | R5 |
| `/payroll/history` | `payroll-history-hub-demo-page`, `company-history`, `company-payslip-browser` | R4 |
| `/payroll/statutory` | `payroll-statutory-documents-demo-page` | R6 |
| `/payroll/me/payslips` | `payroll-my-payslips-demo-page`, reading company snapshots only | R4 (replaces `/my-payslips`) |
| `/payroll/diagnostics/golden` (global_admin) | `company-golden-test.tsx` | R1. It is the screenshot-able proof for engine-only rounds. |

**Die:**

- The prototype leave pages (`my-leave`, `leave-schedule`). SCRUM-560 owns
  leave.
- `offboarding-demo`. A small "Exit payouts" dialog on the profile replaces
  it, covering leave days and the whole OT bank.
- `examples-demo`, `history-reports-demo`.
- The test banner and reset tools.

### Old pages, removed from the router and sidebar in R7

They are `payroll-overview`, `-periods`, `-period-detail`, `-run-detail`,
`-exceptions`, `-exception-detail`, `-employees`, `-employee-detail`,
`-exports` and `-statutory-rules`, plus `/my-payslips`. They are listed at
`App.tsx:674-684` and `app-sidebar.tsx:229`. Also removed is
`payroll-page.tsx`, which is lazy-loaded but never routed.

### Dialogs follow our DialogBody recipe

Every ported dialog and drawer uses `DialogBody`
(`components/ui/dialog.tsx:93`), with the scroll rule at `:32-45`: only the
body scrolls, inside the capped card. That covers `reason-confirm-dialog`,
the issue, item and person drawers, the incentive editor, the paying
configuration editor and the profile editor. The prototype's dialogs ignore
the recipe, so each one is reworked as it lands. The R7 sweep greps for any
payroll `DialogContent` without a `DialogBody`.

### Permissions

`hr.view_salary` (`shared/permissions.ts:50`, checked through
`canViewHrSalary`, `shared/hr-salary-permission.ts:25`) is the floor for
every payroll page and every `/api/payroll/*` route **except** the staff
self-payslip route. The payroll menu is hidden below it. The server refuses
below it whatever the client shows.

The prototype's workflow roles map to our roles as follows, with **no
browser role switcher**:

| Action | Permission key | Roles |
|---|---|---|
| See payroll, setup, profiles, inputs, preview, attendance step, check & fix | `hr.view_salary` + `hr.manage_payroll` (both exist today; `hr.manage_payroll` is unused) | `admin`, `operator_admin`, `global_admin` |
| Start a run, record reviews, overrides, manual lines, OT decisions | `hr.manage_payroll` | `admin`, `operator_admin`, `global_admin` |
| **GM confirm** | new `payroll.confirm` | `admin`, `operator_admin`, `global_admin` |
| **Owner lock**, **reopen**, **mark paid** | new `payroll.lock` | `operator_admin`, `global_admin` |
| Own locked payslips | self only | every signed-in employee |
| Anything | — | `manager`: none. Managers keep timekeeping approval (no pay figures). `staff`: own payslips only. |

- These permission keys are new or newly used. They are registered in
  `ADMIN_ONLY_ACTIONS` and checked through the permission engine, not
  through raw role strings. The old routes use raw role strings
  (`routes.ts:25497`).
- If the same person both confirms and locks, the audit wording follows the
  prototype: "Owner completed both reviews; this is explicitly a
  non-independent review" (`company-workflow.ts:42`).
- The "(development role simulation)" and "(demo record only)" wording
  (`:25, :57`) is replaced with plain wording.
- **Owner to confirm.** Is the park's GM an `admin`, and are the owners
  `operator_admin`? If not, only the role column changes.

**Fences on every new route.** The new module registers its own
`parkGroupOnly` (`server/lib/routeFences.ts:127`) and filters every query by
`parkGroupOf(res)`. It does **not** rely on the old
`app.use('/api/payroll', …)` tenant middleware (`routes.ts:25474`), whose
place in registration order is accidental and which R8 removes. The
`/api/payroll` entry in the blocked-prefix list (`routes.ts:849`) already
covers the new paths.

## 8. Hard-coded demo values become configuration

| Prototype hard-coding | Where | Becomes |
|---|---|---|
| Rule recipients by staff id (`["hkc-002"]`, `["hch-002"]`) and by title lookup | `company-seeds.ts:22-24, 26-35` | `payroll_incentive_assignments` rows (an employee **or** a job title plus branches), created in the rewards setup |
| Title templates with branch ids (`ops-central → hkt-central`) | `company-rewards.ts:52-60` | Assignment rows with `job_title` + `branches`. **The migration is not run.** |
| Service-charge exclusion of nanny and sales booth by job-title regex | `company-rewards.ts:68-69` | Explicit `exceptions` on the policy, entered by an admin |
| Food default ฿60 / ฿10 by branch id | `payroll-profile.ts:59` | `food_allowance_default` on the branch payroll details. New profiles read it; ฿60 is entered for both Thai branches. |
| Branch display names in outputs | `company-outputs.ts:21`, `company-pay-explanation.ts:4-6` | `branches.name`, passed in the world as `costCentreNames`. "Owner – non-operational" stays a constant label. |
| "Casual" role by string | `calculations.ts:267, 419, 486`; `run-calculations.ts:447, 455, 870, 878` | `profile.workerType === "day-rate"`. Every one of these lines is in the older calculation's allowance, SC and preview-SSO paths, which the Thai company engine never pays, so no golden or parity number moves. Our `casual_workers` entity is a separate question (§9 R2). |
| EWF start 2026-09-01 | `foundation.ts:85-88` | `payroll_ewf_settings_versions` rows entered by an admin with the accountant's date. **None seeded.** Until one exists, EWF is `not-configured` and contributes 0, as the prototype does with no settings. |
| Pay date the 28th | `company-workflow.ts:9`, `upload-common.ts:28` | `payroll_paying_entities.default_pay_day` (entered as 28), copied to `payroll_month_runs.pay_date` and editable per run |
| `getRecentCompletedMonths(new Date())` | `seeds.ts:181` | The server clock in the branch timezone (Asia/Bangkok), from the request. Month pickers ask the API. |
| Malaysia detected by branch id | `statutory-engine.ts:47, 174, 418`; `upload-settings-migration.ts:24-58` | Country from branch payroll details and entity config |
| SSO branch numbers `DEMO-00001` / `830001` | `foundation.ts:64`, `upload-settings-migration.ts:26` | Branch payroll details `ssoBranchNumber` (6 digits, validated), entered by an admin |
| Service charge 3% Central / 6% Chalong; stream lists | `company-seeds.ts:47-49`, `:4` | Policy rows and the stream catalogue, entered in setup. The staging seed script may enter them for staging only. Production gets **no** demo values. |
| Department list | `foundation.ts:10` | Our `departments` table |
| Demo role and actor names | `use-demo-role.ts`, `audit-presentation.ts:84` | The session user |

Bank codes (`scb-upload-files.ts:6`) and SSO titles
(`statutory-upload-files.ts:8`) are real constants and stay constants.

## 9. Rounds

Every round lands on `main` with its checks green in CI. Each round's
staging proof is a screenshot attached to its subtask (Jira protocol). The
routes live in `server/payroll/routes.ts`, under `/api/payroll/setup/*`,
`/api/payroll/profiles/*`, `/api/payroll/month-end/*`,
`/api/payroll/history/*`, `/api/payroll/statutory/*`,
`/api/payroll/me/payslips*` and `/api/payroll/diagnostics/*`. None of these
paths collide with the old 45 routes.

| Round | Size | Migrations | Depends on |
|---|---|---|---|
| R1 Engine port | L | — | — |
| R2 Config, profiles, setup | L | 0021, 0022 | — |
| R3 Feeds and preview | L | 0023, 0024 | R1, R2 |
| R4 Month-end lifecycle, freeze, payslips | L | 0025 | R3 |
| R5 Outputs and downloads | M | — | R4 |
| R6 Statutory documents | M–L | 0026 | R4 |
| R7 UI cutover | M | — | R4 (R5/R6 pages join when they land) |
| R8 Old-engine retirement | M | — (later contract ticket) | R5, R6, R7 and the staging end-to-end proof |

**Lanes.** Each lane runs in its own worktree (`C:/w/<lane>`).

- **R1 ∥ R2.** The engine has no DB and the config has no engine, so they
  touch no shared file except `package.json` (`fflate`).
- **R3 → R4** run in sequence.
- **R5 ∥ R6 ∥ R7** after R4. R7 owns `App.tsx` and the sidebar. R5 and R6
  add their page through R7's route table, or R7 adds them as it lands.
- **R8** runs last.

Opus builds and reviews every round that touches money: R1, R3, R4, R5 and
R6. Sonnet does Jira, notes and the rulebook corrections.

### R1: engine port (pure)

- **What lands.**
  - `server/payroll/engine/**`: the "port as is" list, the concern markers,
    and the concern-1 change.
  - `server/payroll/world.ts`, types only: `PayrollWorld`.
  - The injected clock.
  - The golden's engine leg, `payroll-engine.check.ts`, and the parity
    fixture.
  - The diagnostics route and page: `GET /api/payroll/diagnostics/golden`
    for global_admin, running the in-memory golden on the server.
- **Checks.** `check` and `check:ratchet`, the golden engine leg, and the
  engine check including parity.
- **Staging proof.** The diagnostics page on staging shows 11/11 green with
  GM net ฿82,387.91.
- **Also in this commit.** The rulebook corrections from "What reading the
  code changed".

### R2: config, profiles and setup

- **What lands.**
  - Migrations 0021 and 0022.
  - Services and routes for entities, accounts, branch details, the rule
    set (`company-v1`), deduction lists, EWF settings and remittances,
    profiles and allocations, advances, separate payments, and the profile
    audit.
  - The format filter in `payroll-statutory.ts:409`.
  - The setup hub, the roster and the profile editor, plus the HR employee
    Payroll tab, all behind `hr.view_salary`.
  - **Draft profiles from existing data.** A global_admin action reads
    `employees.default_merge_data.salaryThb`, `daily_rate`,
    `food_allowance_per_day`, `employment_basis`, `tax_id_number`,
    `sso_number`, plus any `employee_payroll_profiles` and `salary_advances`
    rows. It creates profiles marked "needs review", with nothing assumed.
    The prototype's validation (`validatePayrollProfile`) shows what is
    missing.
  - The census update (see "API census" below).
- **Checks.** `payroll-access.check.ts` (setup and profiles), profile
  validation cases, and the cross-tenant 404s.
- **Staging proof.** The roster on staging, with allocation badges and the
  "needs review" flags. The GM's 70/30 profile is entered by hand.
- **Owner questions raised here.** Are `casual_workers` (`schema.ts:915`)
  paid through this payroll as day-rate profiles? And confirm the GM/Owner
  role mapping (§7).

### R3: feeds and preview

- **What lands.**
  - Migrations 0023 and 0024.
  - `attendance.ts`, and the world loader in full: every table to
    `PayrollWorld` plus the assembled `CompanyPayrollDocument`. It includes
    prior snapshot summaries (empty until R4) and the
    `doc.snapshots` / `runSnapshots` adapters as stubs.
  - Month-input services: revenue, VAT, SC and discount entry with source
    tags, staff units, KPIs and bonuses, counts, and `overrideCompanyInput`
    with audit.
  - Rewards setup: service policies, incentive rules, versions and
    assignments.
  - OT bank bookings, leave valuations and offboarding.
  - `GET …/month-end/:entity/:month/preview`, which returns
    `CompanyCalculation` plus the signature.
  - The input and rewards pages, and a read-only overview and matrix.
- **Revenue.** It is entered by hand, or uploaded as CSV per branch and
  stream. The park's tills today are Pisell and Papaya. A POS or Xero
  reader (`server/finance-sync.ts` already pulls P&L by tracking location)
  is a follow-up subtask. It is not needed to run a month.
- **Checks.** The golden HTTP leg, checks 1-9, plus
  `payroll-attendance.check.ts`.
- **Staging proof.** The preview of the current month on staging's own data
  (the hand-entered profiles), plus the diagnostics page showing the HTTP
  leg green.

**R3 as landed (SCRUM-568, 2026-10-19).**

- **The run moved forward.** `payroll_month_runs`, `payroll_run_versions`
  (with every lifecycle column, status `draft` only so far) and the draft's
  inputs `payroll_run_attendance_reviews`, `payroll_run_overrides` and
  `payroll_run_manual_lines` are in **0024**, because the preview and the
  golden HTTP leg enter run inputs. R4's 0025 keeps the rest: OT decisions,
  third-party approvals, the run audit, snapshots, lines, output files, the
  OT-bank ledger and the immutability triggers. Until the run audit exists,
  run-input changes are written to `payroll_profile_changes` (kind
  `setup`, subject `run-…`).
- **The attendance feed reads `time_events`.** Normal punches live there,
  not in `time_entries`, which only the exception flows write. The rules as
  built are in `server/payroll/attendance.ts`'s header.
- **The golden fixture has 55 profiles** (17 people and 38 leavers), not 53.
- **A finding for the park:** the company engine pays valued unpaid leave as
  a positive amount (`PAYROLL-FINDING-R3` in company-calculations.ts): it
  negates the older calculation's already-negative line. Ported verbatim.

### R4: month-end lifecycle, freeze and payslips

- **What lands.**
  - Migration 0025, with the immutability trigger.
  - `services/month-end.ts`:
    - draft with the pay date;
    - attendance reviews;
    - OT decisions;
    - overrides and manual lines;
    - third-party approvals;
    - check & fix;
    - GM confirm (signature);
    - Owner lock: recompute the signature, no blocking items, outputs
      reconcile, write the snapshot, the lines and the files;
    - mark paid;
    - reopen to N+1, with the reason, copying the run inputs.
  - **The OT bank is wired.** At lock, the version's `Bank` decisions write
    `payroll_ot_bank_ledger` rows from the locked world. A reopen-and-relock
    marks the older version's lots superseded, so only the latest locked
    version credits. `ot-bank.ts` keeps computing the ledger itself from
    snapshots and bookings, through a *snapshot bridge* that presents a
    locked company snapshot as the per-branch `RunSnapshot` view it reads
    (attendance, OT decisions, staff, rules).
  - Advances repaid from snapshots.
  - Payslip PDFs (`companyPayslipHtml` → Puppeteer), stored privately.
  - The history pages, the payslip browser and `/payroll/me/payslips`.
- **Checks.** The golden lifecycle leg, the access check extended (lock
  and reopen roles, staff self-only), and the snapshot-immutability check.
- **Staging proof.** A staging month, locked, with one payslip open.
- **Owner note.** The OT bank connection is the prototype's rule from its
  older flow, now connected (§ "What reading the code changed").

**R4 as landed (SCRUM-569, 2026-10-19).**

- **0025** holds what 0024 did not: overtime decisions, third-party
  approvals, `payroll_run_audit`, `payroll_run_snapshots`,
  `payroll_run_lines`, `payroll_output_files`, and one trigger function
  refusing UPDATE/DELETE on the last three and on the run audit. No
  `payroll_ot_bank_ledger`: owner decision 3 supersedes the "OT bank is
  wired" bullet above. Company runs credit nothing; a Bank decision is
  stored and takes the hours out of pay, exactly as the prototype computes
  it, and the screens say so.
- **The lifecycle** is `server/payroll/lifecycle.ts`: the prototype's
  `approveCompanyRun` / `lockCompanyRun` / `markCompanyPaid` /
  `reopenCompanyRun` run unchanged in their guards and words, with the
  server's sha256 signature injected (`CompanyWorkflowOptions`). Inputs
  stay editable while GM-confirmed (the confirmation goes stale, as in the
  prototype); a locked or paid version refuses with "This run is locked.
  The Owner must reopen it before changes."
- **Run-input audit** moved to `payroll_run_audit`. The R3-era rows stay in
  `payroll_profile_changes` (nothing is copied).
- **Payslips** are the frozen `companyPayslipHtml` bytes stored inline in
  `payroll_output_files` with their sha256 and served as private sandboxed
  HTML (print to PDF in the browser). Puppeteer PDFs and object storage
  move with R5's files.
- **Advances and YTD** read earlier months' locked snapshots (result only)
  through the loader's `doc.snapshots`.

### R5: outputs and downloads

- **What lands.**
  - The output files go to object storage at lock: SCB TXT/XLSX, the KBANK,
    BBL and generic CSV drafts, the SSO BIFF8 upload per SSO branch, the EWF
    upload, the cash and manual list, the reports (branch summary, service
    charge, incentives, PND.1, PND.3, SSO and student-loan remittance), and
    "all downloads" as a zip.
  - The downloads panel.
  - Every download is written to `payroll_run_audit` (PDPA).
- **Checks.** Golden checks 10-11 on every leg (CSV bytes plus cash equal
  net, references `SALARY SEP26`, two bank files, remove mode),
  `upload-formats` cases, and file sha256s matching the manifest.
- **Staging proof.** The downloads panel of the locked staging month, with
  the reconciliation at 0.00.

### R6: statutory documents

- **What lands.**
  - Migration 0026.
  - The snapshot bridge extended to `statutory-shared.FrozenMonth`. It
    maps `CompanyPerson` lines to the per-person `frozenValues`,
    `statutoryBreakdown` and EWF status the documents read.
  - PND.1 monthly, PND.1ก, 50 ทวิ, กท.20ก, and the EWF documents, with
    deadlines (the 7th or 15th; end of February).
  - "PROVISIONAL – X of 12" coverage, so missing months are never treated
    as zeros.
  - The surcharge estimate, filing records, and the statutory page.
- **Checks.**
  - Document totals equal the locked snapshot's PND.1, SSO and EWF
    remittance totals for the golden month.
  - A two-month coverage case, with one month locked and one missing,
    shows as provisional.
- **Staging proof.** A PND.1 for the locked staging month, plus a
  provisional PND.1ก.
- **Size note.** The bridge is the largest adaptation in the build, which
  is why R6 is marked M–L.

### R7: UI cutover

- **What lands.**
  - The new hub becomes `/payroll`, and the old pages and links are removed.
  - The sidebar is regrouped (keeping our payroll links, per the R6 wave).
  - The DialogBody sweep.
  - The `needs-attention` badge fed from the preview's blocking count.
  - The HR employee Payroll tab switched to the real panel.
- **Checks.** The access check over the client route table, and a
  Playwright smoke test: hub → month-end → payslip.
- **Staging proof.** The new hub, with no old page reachable.

### R8: old-engine retirement

**Gate.** One complete real month on staging, run end to end on the new
engine:

- profiles, attendance and inputs;
- GM confirm and Owner lock;
- payslips, bank file and statutory documents;
- mark paid.

The owner signs off on it.

- **What is removed.**
  - The five engine files: `payroll-calculation.ts`,
    `payroll-statutory.ts`, `payroll-payslip.ts`, `payroll-exports.ts`,
    `payroll-reconciliation.ts`.
  - The 45 route registrations (`routes.ts:25474-26657`), including the two
    `/my-payslips` duplicates and the shadowed bulk-payslip route.
  - The payroll table imports in `routes.ts:162` that only those routes use.
  - The old storage methods.
- **The census declares the truth again** (see "API census" below).
- **The tables stay**, nothing writes to them, and the contract migration is
  a separate ticket.
- **Checks.** The full CI run, and the census rewritten.
- **Staging proof.** `/api/payroll/periods` returns 404, and the new hub
  works.

### Migration numbering

- 0021-0026 are reserved here: R2 takes 0021-0022, R3 0023-0024, R4 0025,
  and R6 0026.
- Only one lane writes migrations at a time: R2, then R3, then R4, then R6.
  R6 runs in parallel with R5 and R7, which add none.
- If any other oto-app lane lands a migration first, the payroll lane
  rebases and **regenerates**. drizzle-kit's `when` must keep increasing.
  This is the same lesson as the Replit port, where upstream timestamps
  older than ours would have been skipped. The numbers here then shift.
- The reservation goes into `apps/oto-app/migrations/README.md` in R2's
  commit, so the next lane sees it.

### API census

`apps/api/test/s217b-r7-payroll-cross-review.test.ts` (skipped without
`HAS_APP`) pins four things:

- the exact ordered list of the 45 `/api/payroll` registrations in
  `routes.ts` (`:171-203`);
- the SHA-256 of all five old engine files (`:46-52`, `:507-530`);
- two `recordAdvanceRepayment(` calls (`:497`);
- the broken `POST /advances` returning 500 (`:487-490`).

`s217b-r7-access-review.test.ts:28` and `g17-round0-review.test.ts:1395,
1491` also match payroll routes and tables.

- **R1-R7 do not edit the old files or the old routes**, so those pins stay
  green throughout.
- **R2 adds a second pinned list.** It covers the new module's routes, read
  from `server/payroll/routes.ts`, each with its permission key, so the
  census describes what exists from the first new route on. R3-R6 extend
  that list in the same commit as each route.
- **R8 replaces the 45-list.** It becomes an assertion that `routes.ts`
  registers **no** `/api/payroll` route and that the five files are gone.
  The fingerprints are removed, and the advances assertions move to the new
  advances rule. The g17 table regex and the access review are updated in
  the same commit.

## 10. Risks

- **Old behaviour pinned by tests.** The API census above, plus
  `tests/administration.check.ts:839-975` (the `check('payroll')` block)
  and `salary-visibility.check.ts`, exercise the old routes.
  - R1-R7 leave them untouched.
  - R8 rewrites them to declare the new truth in the same commit as the
    deletion. It never comments them out.
  - A missed pin shows up as a red CI step. We watch CI by commit SHA, not
    by title.
- **The salary boundary.**
  - Payroll is for payroll roles only. Every new route checks
    `hr.view_salary` on the server, and every response with pay passes
    through the same gate. Managers get nothing.
  - Snapshots hold national IDs and bank account numbers. No route returns
    a snapshot or world body below `hr.view_salary`. The staff self route
    returns only that person's payslip PDF and summary.
  - Payroll tables are excluded from the data-admin exports, or gated
    behind `hr.view_salary`. This is checked in R2.
- **PDPA.**
  - **Storage.** Payslips, bank files and statutory uploads are personal
    data. They go to private object-storage folders (`payroll-payslips/`,
    `payroll-outputs/`, `payroll-statutory/`), **never** to
    `publicFileFolders` (`routes.ts:24596`). They are streamed only through
    authorised routes, the way the old payslip route does (`:26489-26508`).
    There are no long-lived links. A presigned URL, if used, follows
    `pdf-storage.ts`'s 300-second pattern.
  - **Audit.** Every download and view of another person's payslip is
    audited.
  - **Logs.** Calculation payloads are never logged; the response-body log
    scrub already exists.
  - **Retention and erasure.** Locked payroll is kept under the tax
    obligation. An erasure request does not delete it. `RESTRICT` foreign
    keys stop cascades from employee deletion. The retention period is to
    be set with the park's accountant (open question).
- **Size and the browser.** The prototype computed in the browser, and the
  server now computes on every preview. One tenant-month is small (about
  60 people × 31 days), but the world loader must use a fixed number of
  queries, not one per person. This is checked by query count in
  `payroll-attendance.check.ts`.
- **CI time.** The golden's DB legs add about 10-20 s. The parity JSON adds
  a few hundred KB to the repo. Both are accepted. If the oto-app job grows
  past budget, the parity fixture moves to a nightly job. The golden never
  does.
- **The snapshot bridge (R4, R6).** It is the main place where the build is
  new code rather than a port. Its checks compare document totals with the
  snapshot's own remittance CSVs, so a mapping slip shows up as a number
  mismatch.
- **The park's real values.** Production needs the real values before the
  first live month:
  - entity tax id, SSO employer and branch numbers, bank accounts, the EWF
    start date;
  - service-charge rates and streams, incentive rules and assignments;
  - every profile.

  None of these are invented or seeded. The first live month is blocked
  until setup validation passes, using the prototype's own
  `validatePayrollProfile` and the paying-configuration checks.
- **Dormant MY rotting.** Covered by the in-memory MY world in the engine
  check.

## Open decisions — ANSWERED by the owner, 2026-10-20

1. **Role mapping: CONFIRMED** as §7 has it (GM confirm = admin /
   operator_admin / global_admin; lock, reopen, paid = operator_admin /
   global_admin; managers none; staff their own locked payslips). Which
   real people hold which account is park configuration.
2. **Casual workers: OUTSIDE this payroll for now** — they join later as
   their own piece once the park defines their rules; recorded on the
   story.
3. **OT bank and statutory documents: BUILD EXACTLY AS THE PROTOTYPE** —
   the connection to company runs is NOT built. The gap joins the Anthony
   list as the FIFTH recorded matter: until the park rules, banked
   overtime earns no credits from company runs and the PND.1ก / 50 ทวิ /
   EWF documents show their honest provisional/no-source state. R4 and
   R6 scope accordingly: the document and OT-bank screens must say
   plainly why they are empty, never pretend. (This supersedes the
   "connects them" line in §4/§9 above.)
4. **Concern 1: the port charges each rule once** (no golden number
   moves); the park confirms at the next meeting with the rest.
5. **Retention of locked payroll and payslips: joins the Anthony/park
   list** with the concerns.

## Proposed subtasks for SCRUM-564

Each is ready to create:

1. **Payroll R0: plan, rulebook corrections and concern notes.** Commit
   this plan. Correct the rulebook where the code says otherwise. Record
   the four concerns and the open decisions on the story.
2. **Payroll R1: engine port with golden diagnostics.** Port the
   prototype's pure engines to `server/payroll/engine`. Apply the
   concern-1 fix and the concern markers. Land the golden engine leg, the
   engine check, the parity fixture, and the admin golden page.
3. **Payroll R2: paying config, Thai rule set and profiles.** Migrations
   0021-0022. Entities, accounts, dated branch details, the `company-v1`
   rule set, deductions and EWF settings. Profiles with dated allocations,
   advances and separate payments. Setup hub, roster and editor behind
   `hr.view_salary`. Draft profiles from existing employee data. New
   routes added to the census.
4. **Payroll R3: attendance feed, month inputs, rewards and preview.**
   Migrations 0023-0024. Attendance adapter from `time_entries`; world
   loader; revenue and input entry with sources; service policies and
   dated incentives; OT bookings; leave valuations; preview endpoint.
   Golden HTTP leg, checks 1-9.
5. **Payroll R4: month-end lifecycle, freeze and payslips.** Migration
   0025. Draft → GM confirm (signature) → Owner lock (immutable snapshot)
   → paid → reopen. OT bank and advances from locked versions. Private
   payslip PDFs, history and My payslips. Golden lifecycle leg.
6. **Payroll R5: bank, SSO and EWF files and downloads.** Lock-time output
   files in private storage. SCB file and the other banks' drafts, the SSO
   and EWF uploads, cash list, reports and zip. Audited downloads. Golden
   checks 10-11.
7. **Payroll R6: statutory documents from locked runs.** Migration 0026.
   Snapshot bridge to the statutory engine. PND.1, PND.1ก, 50 ทวิ, กท.20ก
   and EWF documents with provisional coverage and filing records.
8. **Payroll R7: UI cutover to the new payroll hub.** Swap `/payroll` to
   the new hub, remove the old pages and links, the DialogBody sweep, the
   HR Payroll tab, and a Playwright smoke test.
9. **Payroll R8: retire the old payroll engine.** After a full staging
   month on the new engine: delete the five old engine files and 45 routes,
   and rewrite the API census and the administration payroll check to
   declare the new truth.
10. **Payroll: drop the old payroll tables (contract).** After R8 and a
    restore check of row counts, drop the twelve legacy payroll tables and
    the `legacy-v1` rule rows.
11. **Payroll: revenue reader for month inputs.** Fill monthly revenue,
    VAT and service charge per branch and stream from the POS, or from
    Xero tracking, instead of entering it by hand.
12. **Payroll: trim the legacy month-end feed.** Reduce the ported
    `run-calculations.ts` to the outputs the company engine uses (OT, leave,
    OT bank, unpaid). It is gated by the parity fixture and must leave no
    number changed.
