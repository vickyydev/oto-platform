// Ported from the payroll prototype's payroll-profile.test.ts (imports/oto-app/client/src/lib/payroll-prototype/);
// test bodies unchanged unless a comment says otherwise.
import assert from "node:assert/strict";
import { describeSuite, test } from "../harness";
import { createSeedData } from "../seed-world";
import { calculateMonthEnd } from "../../../server/payroll/engine/run-calculations";
import { allocationAt, isPhase1DataValid, profileReviewWarnings, resolvePayingAccount,
  validatePayrollProfile, WORKER_DEFAULTS } from "../../../server/payroll/engine/payroll-profile";
import type { EmployeePayrollProfile } from "../../../server/payroll/engine/payroll-profile";
describeSuite("payroll-profile.test.ts");

const data = createSeedData(calculateMonthEnd);
const thai = [...data.branches["hkt-central"].staff, ...data.branches["hkt-chalong"].staff];
const profileFor = (title: string) => thai.find((staff) => staff.payrollProfile?.jobTitle === title)!.payrollProfile!;

// The Malaysian branch's eight people are not in the committed seed world
// (plan §4: no KL branch anywhere), so those two assertions go.
test("fresh roster has 64 unique Thai staff and one Thai company", () => {
  assert.equal(data.branches["hkt-central"].staff.length, 46);
  assert.equal(data.branches["hkt-chalong"].staff.length, 18);
  assert.equal(new Set(Object.values(data.branches).flatMap((branch) => branch.staff.map((staff) => staff.id))).size, 64);
  for (const id of ["hkt-central", "hkt-chalong"] as const) assert.equal(
    data.branches[id].detailsHistory[0].details.legalEntity, "T&T Concept Co., Ltd.");
  assert.ok(isPhase1DataValid(data));
});

test("shared staff have 70/30 allocation without duplicate records and BMG pays the handyman", () => {
  for (const title of ["General Manager", "Event Manager", "Head Chef", "Accountant", "Handyman", "Marketing Freelancer", "Ads Agency"]) {
    const profile = profileFor(title);
    assert.deepEqual(profile.allocations[0].lines.map((line) => [line.costCentre, line.percent]),
      [["hkt-central", 70], ["hkt-chalong", 30]]);
    assert.deepEqual(validatePayrollProfile(profile, data), []);
  }
  assert.equal(profileFor("General Manager").allocations[0].homeBranchId, "hkt-central");
  assert.equal(profileFor("Event Manager").allocations[0].homeBranchId, "hkt-chalong");
  for (const line of profileFor("Handyman").allocations[0].lines) {
    assert.equal(line.entityId, "bmg");
    assert.equal(resolvePayingAccount(data, line, "2026-09-01")?.id, "bmg-scb");
  }
  assert.equal(profileFor("Handyman").monthlySalary, 35000);
  assert.equal(data.payingAccounts?.filter((account) => account.entityId === "tt-concept").length, 2);
  assert.equal(data.payingAccounts?.filter((account) => account.entityId === "bmg").length, 1);
});

test("worker defaults and overrides cover contractors, day rates, managers, pooled roles and household", () => {
  assert.equal(profileFor("Head Chef").fixedFee, 100000);
  assert.equal(profileFor("Head Chef").pnd3WithholdingPercent, 3);
  assert.equal(profileFor("Head Chef").ssoEligible, false);
  assert.equal(profileFor("Ads Agency").paymentMethod, "cash");
  assert.equal(profileFor("Ads Agency").cashHandlingFeePercent, 7);
  assert.equal(profileFor("Part-time Assistant").dayRate, 400);
  assert.equal(profileFor("Part-time Assistant").foodAllowancePerDay, 60);
  assert.equal(WORKER_DEFAULTS["day-rate"].ssoEligible, false);
  assert.equal(profileFor("General Manager").foodAllowanceEligible, false);
  const household = thai.filter((staff) => staff.payrollProfile?.workerType === "owner-household");
  assert.equal(household.length, 4);
  for (const staff of household) {
    const profile = staff.payrollProfile!;
    assert.equal(profile.ssoEligible, true);
    assert.equal(profile.foodAllowanceEligible, false);
    assert.equal(profile.serviceChargeEligible, false);
    assert.equal(profile.allocations[0].lines[0].costCentre, "owner-non-operational");
  }
  for (const staff of thai.filter((item) => item.payrollProfile?.jobTitle.includes("Nanny") || item.payrollProfile?.jobTitle === "Sales Booth"))
    assert.equal(staff.payrollProfile?.serviceChargeEligible, false);
  assert.equal(thai.filter((staff) => staff.payrollProfile?.jobTitle === "Sales Booth").length, 3);
});

test("effective allocation follows the earning date and has no implicit pre-history allocation", () => {
  const moved = data.branches["hkt-central"].staff.find((staff) => staff.id === "hkc-006")!.payrollProfile!;
  assert.equal(allocationAt(moved, "2026-06-30")?.homeBranchId, "hkt-chalong");
  assert.equal(allocationAt(moved, "2026-07-01")?.homeBranchId, "hkt-central");
  assert.equal(allocationAt(moved, "2024-12-31"), null);
  const invalid = structuredClone(moved);
  invalid.allocations[0].lines[0].percent = 70;
  assert.match(validatePayrollProfile(invalid, data).join(" "), /total 100/);
  invalid.allocations[0].lines[0].percent = Number.NaN;
  assert.match(validatePayrollProfile(invalid, data).join(" "), /invalid/);
  invalid.allocations.push(structuredClone(invalid.allocations[0]));
  assert.match(validatePayrollProfile(invalid, data).join(" "), /dates must be unique/);
});

test("third-party reason and account entity are enforced, overrides and incomplete tax IDs are permitted", () => {
  const marketing = structuredClone(profileFor("Marketing Freelancer"));
  assert.equal(marketing.paymentMethod, "third-party");
  marketing.thirdPartyReason = " ";
  assert.match(validatePayrollProfile(marketing, data).join(" "), /reason is mandatory/);
  const gm = structuredClone(profileFor("General Manager"));
  gm.allocations[0].lines[0].payingAccountId = "bmg-scb";
  assert.match(validatePayrollProfile(gm, data).join(" "), /must belong to its entity/);
  gm.allocations[0].lines[0].payingAccountId = null;
  gm.taxId = "";
  assert.deepEqual(validatePayrollProfile(gm, data), []);
});

test("seed exposes loans, advances, separate rent and proration edge cases without new arithmetic", () => {
  const loans = thai.map((staff) => staff.payrollProfile!.studentLoanMonthly).filter(Boolean).sort((a, b) => a - b);
  assert.deepEqual(loans, [180, 750, 1400]);
  const advances = thai.flatMap((staff) => staff.payrollProfile!.advances);
  assert.equal(advances.length, 2);
  assert.ok(advances.every((advance) => advance.principal === 5000));
  assert.deepEqual(new Set(advances.map((advance) => advance.repaymentMode)), new Set(["one-off", "instalments"]));
  const rent = thai.flatMap((staff) => staff.payrollProfile!.separatePayments);
  assert.equal(rent.length, 2);
  assert.ok(rent.every((payment) => payment.withholdingPercent === 5));
  assert.ok(thai.some((staff) => staff.payrollProfile!.joinedOn === "2026-08-19"));
  assert.ok(thai.some((staff) => staff.payrollProfile!.lastWorkingDay === "2026-09-15"));
  const dismissed = thai.find((staff) => staff.payrollProfile!.notes.startsWith("Dismissed"))!.payrollProfile!;
  assert.equal((Date.parse(dismissed.lastWorkingDay!) - Date.parse(dismissed.joinedOn)) / 86400000 + 1, 9);
});

test("review detects two missing tax IDs, one duplicated bank pair and two third-party transfers", () => {
  assert.equal(thai.filter((staff) => !staff.payrollProfile!.taxId).length, 2);
  assert.equal(thai.filter((staff) => profileReviewWarnings(data, staff).some((warning) => warning.startsWith("Duplicate"))).length, 2);
  assert.equal(thai.filter((staff) => profileReviewWarnings(data, staff).some((warning) => warning.startsWith("Third-party"))).length, 2);
});

// Not ported: "compressed document retains every frozen snapshot ..." and
// "version 13 migration adds configuration ..." test the browser store
// (browser-storage.ts, context.tsx), which dies (plan §2).
test("malformed configuration is rejected instead of silently reseeded", () => {
  const broken = structuredClone(data);
  broken.payingAccounts = [];
  assert.equal(isPhase1DataValid(broken), false);
  // Not ported: the browser store's refusal to load it (context.tsx `parseSaved`).
  const invalidProfile = structuredClone(profileFor("General Manager"));
  invalidProfile.advances = [{ id: "bad", principal: 100, outstandingBalance: 101,
    repaymentMode: "instalments", instalments: 0, monthlyRepayment: 50, startsOn: "bad" }];
  assert.match(validatePayrollProfile(invalidProfile as EmployeePayrollProfile, data).join(" "), /advance amounts/);
});
