// Ported from the payroll prototype's company-workflow.test.ts (imports/oto-app/client/src/lib/payroll-prototype/);
// test bodies unchanged unless a comment says otherwise.
import { describeSuite, test } from "../harness";
import assert from "node:assert/strict";
import { createSeedData } from "../seed-world";
import { calculateCompanyMonthEnd } from "../../../server/payroll/engine/run-calculations";
import { approveCompanyRun, lockCompanyRun, markCompanyPaid, newCompanyDraft, reopenCompanyRun } from "../../../server/payroll/engine/company-workflow";
import { generateCompanyOutputs } from "../../../server/payroll/engine/company-outputs";
import { money } from "../../../server/payroll/engine/company-math";
import { fictionalThaiId } from "../../../server/payroll/engine/upload-common";
describeSuite("company-workflow.test.ts");
const data = createSeedData();
// Filing tests use complete fictional identities; readiness tests cover missing/invalid IDs separately.
Object.values(data.branches).flatMap(b => b.staff).forEach((s, i) => {
  if (s.payrollProfile && !s.payrollProfile.taxId) s.taxId = s.payrollProfile.taxId = fictionalThaiId(500 + i);
});
const reviewed = () => {
  const doc = structuredClone(data.companyPayroll!);
  const run = newCompanyDraft("tt-concept", "2026-09");
  data.attendance.filter(d => d.date.startsWith("2026-09")).forEach(d => {
    run.attendance[d.id] = { action: "confirm", who: "Manager fixture", at: "2026-10-01T00:00:00Z", reason: "Reviewed actual clock records" };
  });
  doc.runs["tt-concept:2026-09"] = run; return doc;
};
test("draft exports have one file/account, cash signatures, bilingual combined slips, all remittance reports", () => {
  const calc = calculateCompanyMonthEnd(data, reviewed(), "2026-09"), out = generateCompanyOutputs(data, calc, "tt-concept");
  assert.equal(out.banks.length, 2); assert.equal(out.difference, 0);
  assert.equal(money(out.bankAmount + out.cashAmount), out.net);
  assert.match(out.banks[0].csv, /SALARY SEP26/); assert.match(out.cashHtml, /Signature/);
  assert.equal(Object.keys(out.payslips).length, calc.entities.find(e => e.entityId === "tt-concept")!.people.length);
  assert.match(out.payslips["hkc-001"], /ใบแจ้งเงินเดือน/);
  assert.equal(Object.keys(out.reports).length, 7);
  assert.match(out.note, /not certified/);
});
test("company approval lock paid: frozen version immutable, exact reconciliation and explicit self-review", () => {
  const confirmed = approveCompanyRun(data, reviewed(), "tt-concept", "2026-09", "Owner fixture");
  const locked = lockCompanyRun(data, confirmed, "tt-concept", "2026-09", "Owner fixture");
  assert.equal(locked.snapshots.length, 1); assert.equal(locked.runs["tt-concept:2026-09"].status, "locked");
  assert.match(locked.snapshots[0].audit.at(-1)!.reason, /non-independent/);
  const paid = markCompanyPaid(locked, "tt-concept", "2026-09", "Owner fixture");
  assert.equal(paid.runs["tt-concept:2026-09"].status, "paid");
  assert.deepEqual(paid.snapshots, locked.snapshots);
  const reopened = reopenCompanyRun(paid, "tt-concept", "2026-09", "Owner fixture", "Corrected incentive count");
  assert.equal(reopened.runs["tt-concept:2026-09"].version, 2); assert.deepEqual(reopened.snapshots, locked.snapshots);
});
test("unconfirmed attendance and financial edits after GM confirmation block locking", () => {
  assert.throws(() => approveCompanyRun(data, data.companyPayroll!, "tt-concept", "2026-09", "GM"), /blocking/);
  const confirmed = approveCompanyRun(data, reviewed(), "tt-concept", "2026-09", "GM");
  confirmed.months["2026-09"].revenue["hkt-central"]!.streams.tickets.amount++;
  assert.throws(() => lockCompanyRun(data, confirmed, "tt-concept", "2026-09", "Owner"), /changed/);
});
test("component and derived overrides rebalance accounts and cannot silently disappear", () => {
  const doc = reviewed(), run = doc.runs["tt-concept:2026-09"];
  run.overrides = [{ staffId: "hkc-001", entityId: "tt-concept", component: "gross", amount: 85000, reason: "Corrected monthly bonus" },
    { staffId: "hkc-001", entityId: "tt-concept", component: "net", amount: 80000, reason: "Post-statutory correction approved" }];
  const calc = calculateCompanyMonthEnd(data, doc, "2026-09"), gm = calc.entities.find(e => e.entityId === "tt-concept")!.people.find(p => p.id === "hkc-001")!;
  assert.equal(gm.gross, 85000); assert.equal(gm.net, 80000);
  assert.equal(money(gm.payments.reduce((n, p) => n + p.amount, 0)), gm.net); assert.ok(gm.lines.some(l => l.overridden));
});
test("settled advances do not repay twice; interrupted months do not forgive opening debt", () => {
  const confirmed = approveCompanyRun(data, reviewed(), "tt-concept", "2026-09", "GM");
  const locked = lockCompanyRun(data, confirmed, "tt-concept", "2026-09", "Owner");
  const oct = calculateCompanyMonthEnd(data, locked, "2026-10").entities.find(e => e.entityId === "tt-concept")!;
  assert.equal(oct.people.find(p => p.id === "hkc-011")!.components.advance ?? 0, 0);
  assert.equal(oct.people.find(p => p.id === "hkc-026")!.components.advance, 1000);
  const noPrior = calculateCompanyMonthEnd(data, data.companyPayroll!, "2026-10").entities.find(e => e.entityId === "tt-concept")!;
  assert.equal(noPrior.people.find(p => p.id === "hkc-011")!.components.advance, 5000);
});
test("locked incentive report uses actual overridden entity payments, not old calculated awards", () => {
  const doc = reviewed();
  doc.runs["tt-concept:2026-09"].overrides.push({ staffId: "hkc-001", entityId: "tt-concept", component: "incentive:gm", amount: 20000, reason: "Approved commission correction" });
  const calc = calculateCompanyMonthEnd(data, doc, "2026-09");
  const output = generateCompanyOutputs(data, calc, "tt-concept");
  assert.match(output.reports["incentives.csv"], /"hkc-001","GM combined revenue","20000","18780"/);
  assert.match(output.reports["incentives.csv"], /Approved commission correction/);
});
