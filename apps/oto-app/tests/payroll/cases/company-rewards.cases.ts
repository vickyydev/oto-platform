// Ported from the payroll prototype's company-rewards.test.ts (imports/oto-app/client/src/lib/payroll-prototype/);
// test bodies unchanged unless a comment says otherwise.
import { describeSuite, test } from "../harness";
import assert from "node:assert/strict";
import { createSeedData } from "../seed-world";
import { calculateCompanyIncentives, calculateCompanyService } from "../../../server/payroll/engine/company-awards";
import { assignmentFor, recipientsForMonth, saveIncentiveChange, saveServiceChange } from "../../../server/payroll/engine/company-rewards";
import { money, revenueBase } from "../../../server/payroll/engine/company-math";
import { newCompanyDraft } from "../../../server/payroll/engine/company-workflow";
import { validateCompanyDocument } from "../../../server/payroll/engine/company-validation";
describeSuite("company-rewards.test.ts");
const data = createSeedData(), original = data.companyPayroll!;
const staff = Object.values(data.branches).flatMap(b => b.staff);
const gm = staff.find(s => s.payrollProfile!.jobTitle === "General Manager")!;
const gmRule = original.incentives.find(r => r.id === "gm")!;
const awards = (doc = original, month = "2026-09") => calculateCompanyIncentives(data, doc, month, staff, new Map(), []);
const gmAmount = (doc = original, month = "2026-09") => money(awards(doc, month).filter(a => a.ruleId === "gm" && a.staffId === gm.id).reduce((n, a) => n + a.amount, 0));
const selection = [{ staffId: gm.id, startDate: "" }];
const titles = [{ jobTitle: "General Manager", branches: ["hkt-central", "hkt-chalong"] as const }];
const jobTitles = titles.map(t => ({ ...t, branches: [...t.branches] }));

test("the current catalogue's cached recipients and rates cannot replace dated assignments and versions", () => {
  const doc = structuredClone(original);
  doc.incentives.find(r => r.id === "gm")!.staffIds = [];
  doc.incentives.find(r => r.id === "gm")!.rate = 99;
  assert.equal(gmAmount(doc), 18780);
  assert.equal(recipientsForMonth(data, doc, "gm", "2026-09").length, 1);
});
test("future terms preserve September, and person dates cannot silently backdate a personal rate", () => {
  const doc = saveIncentiveChange(data, original, { ...gmRule, rate: 0.8 }, [{ ...selection[0], startDate: "2025-01-01", personalRate: 0.7 }], jobTitles, "2026-10-01", false, "New October terms", "Owner");
  assert.equal(gmAmount(doc), 18780);
  assert.equal(gmAmount(doc, "2026-10"), money(revenueBase(doc, "2026-10", gmRule.base, [], "test") * 0.007));
  assert.equal(assignmentFor(data, doc, "gm", gm, "2026-09-30")!.personalRate, undefined);
  assert.equal(assignmentFor(data, doc, "gm", gm, "2026-10-01")!.personalRate, 0.7);
  validateCompanyDocument(doc);
});
test("mid-month terms default to next month; opting into days produces two exact traces", () => {
  const next = saveIncentiveChange(data, original, { ...gmRule, rate: 0.8 }, selection, jobTitles, "2026-09-16", false, "Raise next month", "Owner");
  assert.equal(gmAmount(next), 18780);
  const split = saveIncentiveChange(data, original, { ...gmRule, rate: 0.8 }, selection, jobTitles, "2026-09-16", true, "Split September", "Owner");
  assert.equal(gmAmount(split), 28170);
  const used = awards(split).filter(a => a.ruleId === "gm" && a.staffId === gm.id);
  assert.deepEqual(used.map(a => a.rewardTrace!.version), [1, 2]);
  assert.deepEqual(used.map(a => a.rewardTrace!.dates!.length), [15, 15]);
});
test("job-title defaults include new hires, with dated per-person removals overriding the title", () => {
  const changed = structuredClone(data);
  const newcomer = { ...structuredClone(gm), id: "fictional-new-gm", name: "Mali Arun" };
  changed.branches["hkt-central"].staff.push(newcomer);
  assert.ok(assignmentFor(changed, original, "gm", newcomer, "2026-09-20"));
  const doc = saveIncentiveChange(changed, original, gmRule,
    [...selection, { staffId: newcomer.id, startDate: "2026-10-01", excluded: true }], jobTitles,
    "2026-10-01", false, "No bonus for temporary cover", "Owner");
  assert.ok(assignmentFor(changed, doc, "gm", newcomer, "2026-09-20"));
  assert.equal(assignmentFor(changed, doc, "gm", newcomer, "2026-10-01"), undefined);
  validateCompanyDocument(doc);
});
test("personal team weights change shares without increasing the team pot", () => {
  const rule = original.incentives.find(r => r.id === "nanny")!;
  const people = recipientsForMonth(data, original, rule.id, "2026-09");
  const doc = saveIncentiveChange(data, original, rule, people.map((s, i) => ({ staffId: s.id, startDate: "", personalRate: i ? 1 : 2 })), [], "2026-09-01", false, "Double team share for lead", "Owner");
  const before = awards().filter(a => a.ruleId === "nanny"), after = awards(doc).filter(a => a.ruleId === "nanny");
  assert.equal(money(after.reduce((n, a) => n + a.amount, 0)), money(before.reduce((n, a) => n + a.amount, 0)));
  assert.ok(after.find(a => a.staffId === people[0].id)!.amount > before.find(a => a.staffId === people[0].id)!.amount);
});
test("the default Everyone group exactly preserves service charge, including cents", () => {
  const legacy = structuredClone(original);
  Object.values(legacy.servicePolicies).forEach(policies => policies?.forEach(p => { delete p.groups; delete p.exceptions; }));
  const grouped = calculateCompanyService(data, original, "2026-09", staff, []), old = calculateCompanyService(data, legacy, "2026-09", staff, []);
  grouped.forEach((g, i) => {
    assert.equal(g.pool, old[i].pool); assert.equal(g.denominator, old[i].denominator); assert.equal(g.paid, old[i].paid);
    g.people.forEach(p => assert.equal(p.amount, old[i].people.find(o => o.staffId === p.staffId)!.amount));
  });
});
test("own-stream groups reserve within the pool; fixed exceptions and retained leftovers conserve cents", () => {
  const doc = structuredClone(original), p = doc.servicePolicies["hkt-central"]![0];
  p.groups = [{ id: "cafe", name: "Café", selection: "department", values: ["Café & Restaurant"], percent: 100, basis: "worked", streams: ["cafe"] },
    { id: "everyone", name: "Other staff", selection: "everyone", values: [], percent: 100, basis: "calendar" }];
  p.exceptions = [...(p.exceptions ?? []).filter(e => e.staffId !== gm.id), { staffId: gm.id, kind: "fixed", value: 2000 }];
  validateCompanyDocument(doc);
  const result = calculateCompanyService(data, doc, "2026-09", staff, []).find(r => r.branchId === "hkt-central")!;
  assert.equal(result.people.find(s => s.staffId === gm.id)!.amount, 2000);
  assert.equal(money(result.paid + result.retained), result.pool);
  assert.equal(money(result.groups!.reduce((n, g) => n + g.pool, 0) + 2000), result.pool);
  p.groups = [p.groups[0]]; p.exceptions = [];
  const reservedOnly = calculateCompanyService(data, doc, "2026-09", staff, []).find(r => r.branchId === "hkt-central")!;
  assert.ok(reservedOnly.retained > 0);
  assert.equal(money(reservedOnly.paid + reservedOnly.retained), reservedOnly.pool);
});
test("locked payout months reject changes; service policy checks the following month's run", () => {
  const doc = structuredClone(original);
  doc.runs["tt-concept:2026-09"] = { ...newCompanyDraft("tt-concept", "2026-09"), status: "locked" };
  assert.throws(() => saveIncentiveChange(data, doc, gmRule, selection, [], "2026-09-01", false, "Try old month", "Owner"), /locked/);
  assert.throws(() => saveServiceChange(data, doc, "hkt-central", doc.servicePolicies["hkt-central"]![0], "2026-08", "Try locked payout", "Owner"), /locked/);
  assert.doesNotThrow(() => saveServiceChange(data, doc, "hkt-central", doc.servicePolicies["hkt-central"]![0], "2026-09", "October policy", "Owner"));
});
