// Ported from the payroll prototype's deduction-job-titles.test.ts (imports/oto-app/client/src/lib/payroll-prototype/);
// test bodies unchanged unless a comment says otherwise.
import { describeSuite, test } from "../harness";
import assert from "node:assert/strict";
import { createSeedData } from "../seed-world";
import { isDeductionAssigned } from "../../../server/payroll/engine/deductions";
describeSuite("deduction-job-titles.test.ts");

test("deduction job titles use the profile rather than old role labels", () => {
  const data = createSeedData();
  const staff = data.branches["hkt-central"].staff[0];
  const rule = structuredClone(data.branches["hkt-central"].deductionRules[0]);
  rule.roles = [];
  rule.includeStaffIds = [];
  rule.excludeStaffIds = [];
  rule.jobTitles = ["General Manager"];
  assert.equal(isDeductionAssigned(rule, staff), true);
  rule.jobTitles = ["Receptionist"];
  assert.equal(isDeductionAssigned(rule, staff), false);
  rule.includeStaffIds = [staff.id];
  assert.equal(isDeductionAssigned(rule, staff), true);
  rule.excludeStaffIds = [staff.id];
  assert.equal(isDeductionAssigned(rule, staff), false);
});

test("old deduction role assignments remain compatible", () => {
  const data = createSeedData();
  const staff = data.branches["hkt-central"].staff[0];
  const rule = structuredClone(data.branches["hkt-central"].deductionRules[0]);
  rule.roles = [staff.role];
  rule.includeStaffIds = [];
  rule.excludeStaffIds = [];
  delete rule.jobTitles;
  assert.equal(isDeductionAssigned(rule, staff), true);
});
