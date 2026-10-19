// Ported from the payroll prototype's check-fix-step.test.ts (imports/oto-app/client/src/lib/payroll-prototype/);
// test bodies unchanged unless a comment says otherwise.
import { describeSuite, test } from "../harness";
import assert from "node:assert/strict";
import { createSeedData } from "../seed-world";
import { calculateCompanyEngine } from "../../../server/payroll/engine/company-calculations";
import { approveCompanyRun, lockCompanyRun, newCompanyDraft } from "../../../server/payroll/engine/company-workflow";
import { checkFixIssues, openCheckFixProblems } from "../../../server/payroll/engine/company-issue-review";
import type { CompanyResult, PayrollException } from "../../../server/payroll/engine/company-model";
describeSuite("check-fix-step.test.ts");

test("Check & fix counts exclude attendance and informational proration, and match its issue list", () => {
  const exceptions: PayrollException[] = [
    { id: "day", kind: "attendance", message: "Unconfirmed attendance", severity: "blocking" },
    { id: "tax", kind: "profile", message: "Missing tax ID", severity: "warning" },
    { id: "target", kind: "target-missed", message: "Target not met", severity: "warning" },
    { id: "joiner", kind: "proration", message: "Joined this month", severity: "info" },
  ];
  const result = { people: [], exceptions } as unknown as CompanyResult;
  assert.deepEqual(checkFixIssues(result).map(e => e.id), ["tax", "target", "joiner"]);
  assert.equal(openCheckFixProblems(result), 2);
  assert.equal(openCheckFixProblems({ ...result, exceptions: [exceptions[0], exceptions[3]] }), 0);
  // Not ported: the run-step progress count (run-step-progress.ts is display logic, R7).
});
test("reasoned GM confirmation may acknowledge Check & fix problems, but not unconfirmed attendance or Owner-lock blockers", () => {
  const data = createSeedData(), doc = data.companyPayroll!;
  data.branches["hkt-central"].staff[0].payrollProfile!.bankDetails.accountNumber = "";
  const run = newCompanyDraft("tt-concept", "2026-09");
  doc.runs["tt-concept:2026-09"] = run;
  assert.throws(() => approveCompanyRun(data, doc, "tt-concept", "2026-09", "Fictional GM", { reason: "Will repair IDs before locking", allowOpenProblems: true }), /blocking items/);
  data.attendance.filter(day => day.date.startsWith("2026-09")).forEach(day => {
    run.attendance[day.id] = { action: "confirm", reason: "Reviewed attendance", who: "Fictional GM", at: new Date().toISOString() };
  });
  const calc = calculateCompanyEngine(data, doc, "2026-09");
  const result = calc.entities.find(e => e.entityId === "tt-concept")!;
  assert.ok(result.exceptions.some(e => e.severity === "blocking"));
  assert.throws(() => approveCompanyRun(data, doc, "tt-concept", "2026-09", "Fictional GM"), /blocking items/);
  assert.throws(() => approveCompanyRun(data, doc, "tt-concept", "2026-09", "Fictional GM", { reason: " ", allowOpenProblems: true }), /reason/);
  const history = JSON.stringify(doc.snapshots);
  const approved = approveCompanyRun(data, doc, "tt-concept", "2026-09", "Fictional GM", { reason: "Will repair IDs before locking", allowOpenProblems: true });
  assert.equal(approved.runs["tt-concept:2026-09"].status, "gm-confirmed");
  assert.match(approved.runs["tt-concept:2026-09"].audit.at(-1)!.reason, /problems still open.*Will repair IDs/);
  assert.equal(doc.runs["tt-concept:2026-09"].status, "draft", "cancelled/failed actions cannot mutate original document");
  assert.equal(JSON.stringify(approved.snapshots), history);
  assert.deepEqual(calculateCompanyEngine(data, approved, "2026-09").entities.find(e => e.entityId === "tt-concept")!.totals, result.totals);
  assert.throws(() => lockCompanyRun(data, approved, "tt-concept", "2026-09", "Fictional Owner"), /blocking/i);
});
