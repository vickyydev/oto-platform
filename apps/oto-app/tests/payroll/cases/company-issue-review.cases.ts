// Ported from the payroll prototype's company-issue-review.test.ts (imports/oto-app/client/src/lib/payroll-prototype/);
// test bodies unchanged unless a comment says otherwise.
import { describeSuite, test } from "../harness";
import assert from "node:assert/strict";
import { createSeedData } from "../seed-world";
import { calculateCompanyEngine } from "../../../server/payroll/engine/company-calculations";
import { newCompanyDraft } from "../../../server/payroll/engine/company-workflow";
import { attendanceIssueDay, attendancePayEffect, issueNeedsReview, recordAttendanceReview, targetIssueDetail, thirdPartyApprovalSignature } from "../../../server/payroll/engine/company-issue-review";
describeSuite("company-issue-review.test.ts");

test("one-day attendance confirmation/correction/excusal changes only that review and keeps original punches", () => {
  const data = createSeedData(), doc = data.companyPayroll!, id = "hkc-005";
  const sample = data.attendance.find(d => d.date.startsWith("2026-09") && d.exceptions.some(e => e.resolution === null))!;
  const day = { ...structuredClone(sample), id: "focused-late", staffId: id, branchId: "hkt-central" as const, date: "2026-09-07",
    plannedClockIn: "09:00", plannedClockOut: "18:00", actualClockIn: "09:25", actualClockOut: "18:00", effectiveClockIn: "09:25", effectiveClockOut: "18:00",
    exceptions: [{ ...sample.exceptions[0], kind: "late" as const, resolution: null, minutes: 25, rawClockIn: "09:25", rawClockOut: "18:00", effectiveClockIn: "09:25", effectiveClockOut: "18:00" }] };
  const second = { ...structuredClone(day), id: "focused-second", date: "2026-09-08" };
  data.attendance = [...data.attendance.filter(d => d.staffId !== id || !d.date.startsWith("2026-09")), day, second];
  const rules = data.companyDeductionRuleDefaults!["tt-concept"];
  rules.forEach(r => { r.enabled = r.issue === "late"; r.freeOccurrences = 0; r.freeMinutes = 0; r.roles = []; r.jobTitles = []; r.includeStaffIds = [id]; r.excludeStaffIds = []; });
  rules.find(r => r.issue === "late")!.amount = 100;
  data.branches["hkt-central"].deductionRules = structuredClone(rules);
  const original = JSON.stringify(data.attendance);
  const effect = attendancePayEffect(data, doc, "tt-concept", "2026-09", day);
  assert.equal(effect.amount, 100); assert.ok(effect.sources.includes("service charge"));
  const run = newCompanyDraft("tt-concept", "2026-09"); doc.runs["tt-concept:2026-09"] = run;
  const charge = () => calculateCompanyEngine(data, doc, "2026-09").entities.find(e => e.entityId === "tt-concept")!.people.find(p => p.id === id)!.lines.filter(l => l.component.startsWith("attendance-rule:")).reduce((s, l) => s + l.amount, 0);
  recordAttendanceReview(run, day, "confirm", "Verified punch", "Fictional GM"); assert.equal(charge(), 100);
  let calc = calculateCompanyEngine(data, doc, "2026-09");
  assert.ok(!calc.exceptions.some(e => e.id === `attendance-${day.id}`)); assert.ok(calc.exceptions.some(e => e.id === `attendance-${second.id}`));
  recordAttendanceReview(run, day, "override", "Still late after correction", "Fictional GM", "09:30", "18:00"); assert.equal(charge(), 100);
  recordAttendanceReview(run, day, "override", "Clock device correction", "Fictional GM", "09:00", "18:00"); assert.equal(charge(), 0);
  recordAttendanceReview(run, day, "excuse", "Approved travel delay", "Fictional GM"); assert.equal(charge(), 0);
  assert.deepEqual(Object.keys(run.attendance), [day.id]); assert.equal(JSON.stringify(data.attendance), original);
  assert.throws(() => recordAttendanceReview(run, day, "confirm", "", "GM"));
  assert.throws(() => recordAttendanceReview(run, day, "override", "Reason", "GM", "25:00", "18:00"));
  assert.strictEqual(attendanceIssueDay(data, { id: `attendance-${day.id}`, kind: "attendance", severity: "blocking", staffId: id, message: day.date }), day);
});
test("third-party approval is monthly, fingerprinted, keeps financial totals and reopens attention after bank or amount changes", () => {
  const data = createSeedData(), doc = data.companyPayroll!, calc = calculateCompanyEngine(data, doc, "2026-09");
  const result = calc.entities.find(e => e.entityId === "tt-concept")!, p = result.people.find(p => p.payments.some(x => x.method === "third-party"))!;
  const issue = result.exceptions.find(e => e.staffId === p.id && /third-party/i.test(e.message))!;
  const run = newCompanyDraft(result.entityId, "2026-09");
  assert.equal(issueNeedsReview(issue, p, run), true);
  run.thirdPartyApprovals = { [p.id]: { signature: thirdPartyApprovalSignature(p), reason: "Verified consent", who: "Fictional Owner", at: new Date().toISOString() } };
  assert.equal(issueNeedsReview(issue, p, run), false);
  const changed = structuredClone(p); changed.payments[0].amount += 1; assert.equal(issueNeedsReview(issue, changed, run), true);
  assert.equal(issueNeedsReview(issue, p, newCompanyDraft(result.entityId, "2026-10")), true);
  doc.runs["tt-concept:2026-09"] = run;
  const after = calculateCompanyEngine(data, doc, "2026-09");
  assert.deepEqual(after.entities.find(e => e.entityId === result.entityId)!.totals, result.totals);
  assert.notEqual(after.signature, calc.signature);
});
test("missed target detail shows actual, shortfall and the foregone incentive instead of zero", () => {
  const data = createSeedData(), calc = calculateCompanyEngine(data, data.companyPayroll!, "2026-09");
  const issue = calc.exceptions.find(e => e.kind === "target-missed")!;
  const detail = targetIssueDetail(issue, data.companyPayroll!, calc);
  assert.equal(detail.target, 1000000); assert.equal(detail.actual, 995000); assert.equal(detail.shortfall, 5000); assert.equal(detail.unpaid, 1990);
});
// Not ported: "pay sentences ..." and "shared-staff display ..." test payroll-display.ts,
// which is display logic and moves to the client in R7 (plan §2).
