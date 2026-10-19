# Payroll rulebook — the park's intended payroll, from the 2026-10 Replit prototype

**Status:** specification only. Extracted 2026-10-19 from the browser-only
payroll prototype in `imports/oto-app` (range `9990891f..f2c569dc`, 67
commits; engines under `client/src/lib/payroll-prototype/`, ten phase specs
under `docs/superpowers/specs/`). The prototype runs on fictional in-browser
data and, by its own boundary document
(`docs/payroll-hr-prototype-boundary.md` upstream), deliberately does NOT
write to the live database or call the pre-existing database payroll engine.
These are the rules the park's side is reviewing for the REAL payroll build.
Nothing here is shipped behaviour of our platform yet.

> Owner ruling 2026-10-20 (supersedes 2026-10-19): the payroll system IS
> built for real in our app from this rulebook, after the R6 screen wave.
> The prototype's logic is the owner's own design and is built as written.
> The four concerns in §9 are RECORDED for the next meeting with the
> park's side (or the next park testing), and the build proceeds around
> them: where a concern creates ambiguity, the prototype's behaviour is
> built as-is and the spot is marked on the story ticket. Further rulings:
> Thailand-only rules go live (the engine keeps its multi-country shape;
> the fictional Malaysian branch's rules stay dormant configuration), and
> the app's old dormant payroll engine is retired at cutover once the new
> month-end runs end to end. The September golden example becomes the
> acceptance test: the real engine must reproduce its numbers exactly.

## 1. Company model

- One legal company per month-end (T&T Concept). Branches are **cost
  centres**, not employers. A sister company (BMG) and an owner-household
  cost centre exist beside them.
- Shared staff are one person split by **dated percentage allocations**
  (the GM is 70/30 Central/Chalong). SSO and PIT are deducted once, at the
  registered home branch.
- Worker types: monthly, day-rate, contractor, owner-household — each with
  defaults for SSO, PND.1, food, service charge, OT and PND.3 eligibility.
- A profile also carries: paying entity and account, payment method (bank /
  cash / third-party with a mandatory reason), student loan, advances, and
  separate payments (e.g. house rental) with their own withholding.

## 2. Pay bases and proration

- **Monthly:** salary × employed days ÷ divisor (capped at 1; exactly 1 for
  a full month). Divisor = actual days in the month, or a fixed 30 by
  setting. Worked example: ฿18,000 joining 19 Aug pays 13/31 = ฿7,548.39.
- **Day-rate:** day rate × worked days (a worked day = any attendance row
  with a clock-in, after corrections; a manual figure overrides the count).
- **Contractor:** fixed fee, prorated like salary.
- **Food:** per-day amount × worked days (default ฿60). Not taxable, not an
  SSO wage.
- **Fixed allowances:** monthly workers only, prorated by actual month days.
- **Separate payments:** prorated, not taxable, not SSO wage, own PND.3 rate.
- **Rounding:** money half-up to cents; splits by largest-remainder cents so
  they always sum exactly; Thai SSO to whole baht; OT hours to 4 decimals.

## 3. Service charge

- Earning month is always the **previous** month. Base = Σ(stream gross −
  VAT − service charge) + selected discount add-backs; pool = base × rate.
- Seeded rates: Central **3%**, Chalong **6%** (tickets, cafe and special
  events only).
- Units = employed days in the earning month × the person's allocation %.
- Default "retain" mode: ineligible staff stay in the denominator and their
  share stays with the company; "remove" mode takes them out.
- Stream groups are reserved FROM the branch pool, never added on top;
  fixed-person amounts pay first; every satang is conserved.

## 4. Overtime and the OT bank

- Hourly rate = salary ÷ 30 ÷ 8, or day rate ÷ 8.
- Multipliers: regular **1.5×**, rest day **2×**, public holiday **3×**
  (scheduled-holiday base hours get an extra 1× premium).
- Minimum block 30 min, rounding 15 min. Monthly cap 36 h (alert only);
  Thai weekly 36 h OT+holiday warning.
- **OT bank:** opt-in; conversion 1; max 40 h; expiry 3 months with payout
  at expiry; FIFO consumption; whole balance paid out on resignation;
  earned lots come only from the latest **locked** run version (a reopened
  run cannot credit twice).

## 5. Incentives

Seven kinds (company engine rates are **percent** numbers; legacy plans and
vouchers use **decimals** — see concern §9.4):

| Kind | Rule |
|---|---|
| revenue | base × rate% × eligible days ÷ employed days; target gate is strict `>` |
| team-days | (base × rate%) split by worked days |
| unit-pool | count × rate, split by eligible-day fraction |
| unit | units × rate × day fraction |
| kpi | fixed bonus when the condition holds (seed: reply < 60 min pays ฿2,000) |
| guarantee | runs last; tops net up to a minimum (seed ฿23,000) over salary + other incentives |
| manual | one-off; reason required |

Incentives are taxable, never SSO wages. Mid-month term changes take effect
next month. Legacy plans kept for reference: Events & Parties 1% / 0.5% /
0.5% on gross profit (floored at 0); booth vouchers 5% of redeemed spend in
the **redemption** month, to staff rostered AND clocked in at issue; perfect
attendance ฿500.

## 6. Deductions, advances, leave

- **Attendance tariffs** (only Approved/Corrected items count; Excused never):
  late/early ฿100 each after 3 occurrences or 30 min free, capped
  ฿1,000/month from service charge; no-show ฿300; missed punch ฿50 after 2
  free. Budgeted against remaining service charge or salary.
- **Advances:** two modes only — one-off (whole balance) or instalments
  (`monthlyRepayment`). Each month deducts min(regular, remaining), where
  remaining = opening balance − advance lines in prior **locked** months. No
  net-pay floor, no percent-of-net rule; the instalment count is not used in
  the calculation (see concern §9.3; our platform's shipped advances rule
  differs — SCRUM-276).
- **Student loan (กยศ.):** flat monthly amount, remitted separately.
- **PND.3:** 3% for contractors, all non-separate earnings by default or
  fee-only by setting. **Cash fee:** % of gross for cash contractors.
- **Leave (Thailand):** annual 8 days (monthly accrual, 6-month wait,
  carry-forward cap 5 expiring after 3 months); sick 30 upfront
  (certificate warning at 3 consecutive days); business 3; Days Off 2 per 5
  confirmed worked days. Unpaid leave = negative earning at the frozen
  daily rate, reducing tax and SSO bases; negative balances never
  auto-deduct. Exit payouts = days × frozen rate, taxable, not SSO wage.

## 7. Statutory (Thailand)

- **SSO:** 5% + 5% on wages capped ฿17,500 (max ฿875); service charge
  counts as SSO wage by default.
- **PIT (PND.1):** brackets 0/5/10/15/20/25/30/35% at 150k/300k/500k/750k/
  1M/2M/5M; employment expense 50% capped 100k; personal allowance 60k;
  annual SSO deducted; cumulative method.
- **EWF:** 0.25%+0.25% (0.5%+0.5% from 2031-10-01), headcount ≥ 10,
  uncapped base of salary + fixed allowances only; contractors excluded;
  surcharge 5%/full month late (+1 month if remainder ≥ 15 days), due the
  15th. (The prototype's start date 2026-09-01 is a demo value.)
- **Deadlines:** PND.1 the 7th (paper) / 15th (electronic); PND.1ก, 50 ทวิ,
  กท.20ก, EA end of February.
- **Bank files:** SCB PAY (bank 014) / SPN, 28-field TXNDET, CRLF, no BOM,
  reference DDMMYY+sequence; third-party and cash go on a manual list. SSO
  upload: BIFF8 `.xls` per 6-digit SSO branch, full wage + capped
  contribution. (Malaysian statutory exists in the prototype only to prove
  multi-country rules; no real OTO operation is Malaysian.)

## 8. Month-end lifecycle

draft (pay date defaults to the 28th) → attendance → check & fix (blocking
exceptions must clear) → **GM confirm** (records a source signature — an
FNV hash over every input plus the engine revision, so any later change
invalidates the confirmation) → **Owner lock** (signature unchanged, no
blocking items, bank files + cash exactly equal to net) → mark paid →
reopen creates version N+1 with a reason. Locked snapshots freeze result,
calculation, outputs, audit and inputs; payslips and statutory documents
render only from locked snapshots; missing months are labelled
"PROVISIONAL – X of 12", never treated as zeros. A worked "September
golden" fixture pins the whole run (GM net ฿82,387.91 across both branches,
reconciliation exact) at ±0.01 tolerance.

## 9. Concerns to settle with the park before building for real

1. **Attendance deductions are likely double-counted** in the company
   engine (added once as attendance-rule lines and again via the legacy
   engine's deduction lines); the golden fixture sets `deductionRules: []`
   so its test cannot catch this.
2. **PIT is never verified against expected figures** — the golden GM uses
   a manual PND.1 override and everyone else has PND.1 off; prior
   withholding is estimated even when locked months exist.
3. **Advances carry no protection** (no net floor, no percent-of-net,
   instalment count unused) — and this differs from the advances rule our
   platform already ships (SCRUM-276).
4. **The two internal engines disagree**: percent vs decimal rates,
   strict `>` vs `≥` gates, worked vs scheduled days for day-rates, and
   allowance proration ignores the configured divisor. The real build must
   pick one answer per pair.

Plus the hardcoded demo values that must become configuration: rule
assignments by staff id/array index, the ฿60/branch food default keyed on a
branch id, branch names in output layout, the "Casual" role by string, the
EWF start date and the 28th pay date.

## 10. Corrections from the build planning (2026-10-20)

The deep read for the real build (docs/progress/plans/payroll-real-build/
PLAN.md) found the prototype's code saying otherwise in five places; the
code wins over the prose above:

1. **The company month-end never reaches the tax documents or the OT
   bank.** Both read the OLDER per-branch snapshots; a company lock writes
   only its own. As the prototype stands, banked overtime is never
   credited and PND.1ก / 50 ทวิ / the EWF documents never see a company
   run. The real build connects them (owner decision 3 in the plan).
2. **PIT prior withholding is always estimated** — the company engine
   passes no year-to-date figure even when locked months exist (part of
   concern §9.2).
3. **§5's "eligible days ÷ employed days" only holds for rules not set to
   prorate** — and the prototype migrates every seeded rule to prorate,
   which divides by calendar days instead.
4. **Fixed allowances go to owner-household workers too**, not only
   monthly ones.
5. **GM confirm blocks only attendance items** (the confirm screen allows
   other open problems through); Owner lock still blocks on everything.

Also for the record: the old dormant engine's advances handling is broken
in ways that dissolve with its retirement (two repayment types deduct 0 by
a type-name mismatch, the percent rule reads gross not net, and the create
route answers 500) — so concern §9.3 conflicts with no live behaviour.

6. **(Added 2026-10-20, R3) Valued unpaid leave is PAID, not deducted.**
   The older calculation books the unpaid-leave line as negative and the
   company engine negates it again (prototype company-calculations.ts:
   104-107), so a frozen ฿1,000 unpaid day arrives as +฿1,000 and raises
   the salary base. Built as the prototype computes it per the standing
   ruling, marked PAYROLL-FINDING-R3 in the ported code; the seventh
   matter for the park meeting. The checks deliberately do not pin the
   sign, so the eventual correction will not break them.
