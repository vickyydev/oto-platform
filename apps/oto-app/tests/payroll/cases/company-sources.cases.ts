// Ported from the payroll prototype's company-sources.test.ts (imports/oto-app/client/src/lib/payroll-prototype/);
// test bodies unchanged unless a comment says otherwise.
import { describeSuite, test } from "../harness";
import assert from "node:assert/strict";
import { createSeedData } from "../seed-world";
import { overrideCompanyInput, sourceKey, salesValue, getInputSource, dependenciesForInput } from "../../../server/payroll/engine/company-sources";
import { calculateCompanyEngine, companySourceSignature } from "../../../server/payroll/engine/company-calculations";
import { validateCompanyDocument } from "../../../server/payroll/engine/company-validation";
import { money } from "../../../server/payroll/engine/company-math";
describeSuite("company-sources.test.ts");
const data = createSeedData(), doc = data.companyPayroll!;
test("POS total overrides conserve cents, preserve streams and retain the original after further changes", () => {
  const key = sourceKey.sales("hkt-central"), original = salesValue(doc, "2026-09", "hkt-central");
  const once = overrideCompanyInput(data, doc, "2026-09", key, 3900000.01, "Correct POS close", "GM");
  const twice = overrideCompanyInput(data, once, "2026-09", key, 3800000.02, "Second source review", "GM");
  assert.equal(salesValue(twice, "2026-09", "hkt-central"), 3800000.02);
  const source = getInputSource(twice, "2026-09", key, 3800000.02, "POS");
  assert.equal(source.original, original); assert.equal(source.current, 3800000.02);
  assert.equal(source.reason, "Second source review");
  assert.equal(Object.keys(twice.months["2026-09"].revenue["hkt-central"]!.streams).length, 9);
  assert.notEqual(companySourceSignature(data, doc, "2026-09"), companySourceSignature(data, twice, "2026-09"));
  validateCompanyDocument(twice);
});
test("stream-then-total edits preserve the real original aggregate and the VAT/SC stored internally", () => {
  const fixture = structuredClone(doc), cell = fixture.months["2026-09"].revenue["hkt-central"]!.streams.cafe;
  cell.vat = 700; cell.serviceCharge = 300;
  const original = salesValue(fixture, "2026-09", "hkt-central");
  const once = overrideCompanyInput(data, fixture, "2026-09", sourceKey.sales("hkt-central", "cafe"), 500000, "Net cafe correction", "GM");
  const changed = overrideCompanyInput(data, once, "2026-09", sourceKey.sales("hkt-central"), 3900000, "Combined correction", "GM");
  assert.equal(getInputSource(changed, "2026-09", sourceKey.sales("hkt-central"), 3900000, "POS").original, original);
  const updated = changed.months["2026-09"].revenue["hkt-central"]!.streams.cafe;
  assert.equal(updated.vat, 700); assert.equal(updated.serviceCharge, 300);
  assert.equal(salesValue(changed, "2026-09", "hkt-central"), 3900000);
});
test("source edits require reasons and cannot overstate employment days", () => {
  assert.throws(() => overrideCompanyInput(data, doc, "2026-09", sourceKey.count("flyers"), 500, "", "GM"), /reason/);
  assert.throws(() => overrideCompanyInput(data, doc, "2026-09", sourceKey.days("hkc-001"), 31, "Wrong days", "GM"), /30 days/);
  assert.throws(() => overrideCompanyInput(data, doc, "2026-09", sourceKey.count("flyers"), -1, "Wrong count", "GM"), /zero/);
  assert.ok(dependenciesForInput(doc, "2026-09", sourceKey.count("flyers")).includes("Redeemed flyer pool"));
});
test("first unsourced manual entry is Manual; a later edit is a reasoned override", () => {
  const key = sourceKey.kpi("hkc-001", "quality-score");
  const entered = overrideCompanyInput(data, doc, "2026-09", key, 8, "Entered supervisor score", "GM");
  assert.equal(entered.months["2026-09"].sources![key].kind, "Manual");
  assert.equal(entered.months["2026-09"].sources![key].overridden, false);
  const changed = overrideCompanyInput(data, entered, "2026-09", key, 9, "Corrected score", "GM");
  assert.equal(changed.months["2026-09"].sources![key].overridden, true);
  assert.equal(changed.months["2026-09"].sources![key].original, 8);
});
test("company results capture source tags and departments, with net and cost totals still reconciled", () => {
  const overridden = overrideCompanyInput(data, doc, "2026-09", sourceKey.count("flyers"), 420, "Recounted vouchers", "GM");
  const result = calculateCompanyEngine(data, overridden, "2026-09"), tt = result.entities.find(e => e.entityId === "tt-concept")!;
  const booth = tt.people.find(p => p.jobTitle === "Sales Booth")!;
  assert.equal(booth.department, "Sales Booth");
  assert.equal(booth.lines.find(l => l.component === "incentive:flyers")!.sources![0].tag, "Overridden");
  assert.equal(booth.lines.find(l => l.component === "food")!.sources![0].tag, "Attendance");
  assert.equal(tt.people.find(p => p.id === "hkc-001")!.lines.find(l => l.component === "incentive:gm")!.sources![0].tag, "POS");
  assert.equal(money(tt.people.reduce((n, p) => n + p.payments.reduce((s, row) => s + row.amount, 0), 0)), tt.totals.net);
});
