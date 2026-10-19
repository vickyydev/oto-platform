// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file. Boots the app's real routes once; needs a database whose otoapp schema
// the app's migrator has built (0026 included).
//
// SCRUM-571, the company payroll's R6 (plan §9 R6 with owner decision 3;
// rulebook §7 and §10.1): the statutory documents, built exactly as the
// prototype has them — they read locked PER-BRANCH runs, and a company
// month-end lock writes none.
//   1. EWF late-payment surcharge (rulebook §7): 5% of the principal per full
//      month late, one more month when the remainder is at least 15 days,
//      never compounded; the engine's refusals for bad dates and amounts; the
//      same over HTTP.
//   2. The document engine on a per-branch locked run made in memory (the
//      shape the prototype's older flow froze): a real (non-"hkt-") branch id
//      renders PND.1 from its frozen rows; one locked month of a year is
//      "PROVISIONAL – 1 of 12 months; …"; a two-month case with one month
//      locked and one missing.
//   3. Over HTTP on our data: the no-source explanation word for word, the
//      engine's own provisional and blocked wording, a locked company
//      month-end named as giving the documents nothing, rendering refused
//      with the prototype's words, a filing recorded with its reason and
//      coverage state and audited, the prototype's filing refusals, the
//      tables refusing UPDATE/DELETE, and the EWF lines for October 2026.
//   4. Fences: manager and staff 403 on every route, writes refused below
//      hr.manage_payroll, another park group's branch, document or file 404.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/payroll-documents.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { caller, database, makeGroup, serve, signIn, stopServers, type Group, type Role } from "./payroll-harness";
import { calculateEwfSurcharge } from "../server/payroll/engine/ewf-documents";
import { createStatutoryDocument, listStatutoryOffers } from "../server/payroll/engine/statutory-engine";
import { fixedClock } from "../server/payroll/engine/clock";
import type { PayrollWorld, RunSnapshot, StaffMember } from "../server/payroll/engine/model";

const { pool, q, count } = database();
const reason = "ZZ TEST SCRUM-571";
let passed = 0;
const ok = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok  ${name}`); };
const okAsync = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ok  ${name}`); };

// The wording the screens and the API must keep, pinned literally.
const NO_SOURCE = "Company month-ends do not feed these documents. The documents read locked per-branch payroll runs, as the prototype's document engine does, and locking a company month-end writes none. Until the park decides how company month-ends should reach the tax and social-security documents, every form here shows no source and stays provisional. Nothing is filled in, and no missing month is counted as zero.";
const PROVISIONAL_0 = "PROVISIONAL – 0 of 12 months; missing applicable months are not treated as zero.";
const PROVISIONAL_1 = "PROVISIONAL – 1 of 12 months; missing applicable months are not treated as zero.";
const MONTH_BLOCKED = "No approved locked snapshot is available for this period; generation is blocked until frozen monetary rows exist.";
const YEAR_BLOCKED = "No frozen annual source rows are available; generation is blocked.";

// ── 1. EWF surcharge (rulebook §7) ──
{
  const s = (due: string, asOf: string, principal = 1000) => calculateEwfSurcharge(due, asOf, principal);
  ok("EWF surcharge: paid on or before the due date costs nothing", () => {
    assert.deepEqual([s("2026-11-15", "2026-11-15").chargeableMonths, s("2026-11-15", "2026-11-15").surcharge], [0, 0]);
    assert.equal(s("2026-11-15", "2026-11-01").surcharge, 0);
  });
  ok("EWF surcharge: under 15 days late is dropped; 15 days counts as a month (5%)", () => {
    assert.deepEqual([s("2026-11-15", "2026-11-29").chargeableMonths, s("2026-11-15", "2026-11-29").surcharge], [0, 0]);
    assert.deepEqual([s("2026-11-15", "2026-11-30").chargeableMonths, s("2026-11-15", "2026-11-30").surcharge], [1, 50]);
  });
  ok("EWF surcharge: 5% per full month late, plus one month at a 15-day remainder", () => {
    assert.deepEqual([s("2026-11-15", "2026-12-15").chargeableMonths, s("2026-11-15", "2026-12-15").surcharge], [1, 50]);
    assert.deepEqual([s("2026-11-15", "2027-01-29").chargeableMonths, s("2026-11-15", "2027-01-29").surcharge], [2, 100]);
    assert.deepEqual([s("2026-11-15", "2027-01-30").chargeableMonths, s("2026-11-15", "2027-01-30").surcharge], [3, 150]);
  });
  ok("EWF surcharge: simple, not compounded (12 months late on ฿1,000 is ฿600, not ฿795.86)", () => {
    assert.equal(s("2026-11-15", "2027-11-15").surcharge, 600);
    assert.equal(s("2026-11-15", "2027-11-15", 2345.67).surcharge, Math.round(2345.67 * 0.05 * 12 * 100) / 100);
  });
  ok("EWF surcharge: a due date at month end anniversaries on the last day of a shorter month", () => {
    assert.equal(s("2027-01-31", "2027-02-28").chargeableMonths, 1);
    assert.equal(s("2027-01-31", "2027-02-27").chargeableMonths, 1, "27 days: no full month, remainder ≥ 15");
  });
  ok("EWF surcharge: bad dates and amounts are refused in the engine's words", () => {
    assert.throws(() => s("2026-11-31", "2026-12-15"), /^Error: Enter valid due and as-of dates in YYYY-MM-DD format\.$/);
    assert.throws(() => s("2026-11-15", "2026-12-15", -1), /^Error: Unpaid principal must be a non-negative amount\.$/);
  });
}

// ── 2. The document engine on a per-branch locked run made in memory ──
{
  const BRANCH = "0b7c6a5e-branch-not-hkt";
  const details = { name: "ZZ Central", legalEntity: "ZZ Co., Ltd.", employerNumber: "1000000001", taxId: "0105500000001", address: "ZZ Road",
    country: "TH", currency: "THB", timezone: "Asia/Bangkok", payDate: 28, payrollBank: "SCB", approvalChain: ["GM", "Owner"] };
  const staff = { id: "p1", employeeNumber: "E1", name: "ZZ Person", role: "Floor", employmentType: "local", nationality: "Thai", monthlySalary: 20000, dayRate: null,
    joinedOn: "2025-01-01", leftOn: null, probationEndsOn: "2025-01-01", scheduledDaysPerWeek: 6, otEligible: true, serviceChargeEligible: true, serviceRoleWeight: 1,
    ewfMembership: null, statutoryIds: { taxNumber: "1101700203451", ssoNumber: "1101700203451" } } as unknown as StaffMember;
  const snap = (month: string): RunSnapshot => ({
    branchId: BRANCH, month, version: 1, lockedAt: `${month}-28T10:00:00.000Z`, lockedBy: "ZZ Owner", approval: "locked",
    calculations: { month, currency: "THB", rows: [{ staffId: "p1", grossPay: 20000, incomeTaxWithholding: 250, socialSecurityWages: 17500, statutoryBreakdown: { employee: { sso: 875 }, employer: { sso: 875 } } }] },
    details, staff: [staff], rules: {}, incentiveRules: [], deductionRules: [], inputs: { revenue: null, attendance: [], manualFigures: [], draft: {} }, audit: [],
  }) as unknown as RunSnapshot;
  const world = (...snapshots: RunSnapshot[]) => ({
    branches: { [BRANCH]: { id: BRANCH, staff: [staff], detailsHistory: [{ effectiveFrom: "2025-01", details }], lifecycleHistory: [{ effectiveFrom: "2025-01", openedOn: "2025-01-01", closedOn: null }],
      rulesHistory: [], incentiveRules: [], deductionRules: [], employeeIncentivePlans: [], roleIncentiveDefaults: [], voucherSettings: { method: "percent", value: 0 }, leavePolicyHistory: [] } },
    runSnapshots: snapshots,
  }) as unknown as PayrollWorld;

  ok("engine: a locked per-branch month renders PND.1 from its frozen rows, on a real (non-\"hkt-\") branch id", () => {
    const data = world(snap("2026-09"));
    const offer = listStatutoryOffers(data, BRANCH, "2026-09").find((o) => o.code === "PND1")!;
    assert.deepEqual([offer.provisional, offer.sourceRuns], [false, [{ branchId: BRANCH, month: "2026-09", version: 1 }]]);
    const doc = createStatutoryDocument(data, offer, "ZZ Admin", fixedClock("2026-10-05T03:00:00.000Z"));
    assert.ok(doc.html.includes("ภ.ง.ด.1") && doc.html.includes("20,000.00") && doc.html.includes("250.00"), "the frozen gross and withholding are on the form");
    assert.equal(doc.dueDate, "2026-10-07");
    assert.ok(doc.files[1].content.startsWith("NOT FOR FILING"), "the upload is a labelled placeholder");
  });
  ok("engine: one locked month of the year is PROVISIONAL – 1 of 12, never zeros for the rest", () => {
    const offers = listStatutoryOffers(world(snap("2026-09")), BRANCH, "2026");
    const pnd1a = offers.find((o) => o.code === "PND1A")!;
    assert.ok(pnd1a.warnings.includes(PROVISIONAL_1), JSON.stringify(pnd1a.warnings));
    assert.deepEqual([pnd1a.coverage.locked, pnd1a.coverage.missing.length, pnd1a.provisional], [["2026-09"], 11, true]);
    assert.ok(offers.some((o) => o.code === "50Tawi" && o.staffId === "p1") && offers.some((o) => o.code === "KT20A"));
  });
  ok("engine: two months, one locked and one missing — the missing month is provisional with no source", () => {
    const data = world(snap("2026-08"));
    const aug = listStatutoryOffers(data, BRANCH, "2026-08").find((o) => o.code === "PND1")!;
    const sep = listStatutoryOffers(data, BRANCH, "2026-09").find((o) => o.code === "PND1")!;
    assert.deepEqual([aug.provisional, aug.coverage.locked], [false, ["2026-08"]]);
    assert.deepEqual([sep.provisional, sep.coverage.missing, sep.sourceRuns], [true, ["2026-09"], []]);
    assert.ok(sep.warnings.includes(MONTH_BLOCKED));
    assert.throws(() => createStatutoryDocument(data, sep, "ZZ Admin"), /no frozen monetary source rows are available/);
  });
}

const groups: Group[] = [];
try {
  const A = await makeGroup(q, "docs-a", ["ZZ TEST A Central"]);
  const B = await makeGroup(q, "docs-b", ["ZZ TEST B Park"]);
  groups.push(A, B);
  const origin = await serve();
  await signIn(origin, A); await signIn(origin, B);
  const call = caller(origin);
  const must = async (g: Group, role: Role, method: string, path: string, payload?: unknown, status = [200, 201]) => {
    const res = await call(g, role, method, path, payload ?? { reason });
    assert.ok(status.includes(res.status), `${role} ${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const setupFor = async (g: Group) => {
    const entity = await must(g, "admin", "POST", "/api/payroll/setup/entities", { name: `ZZ ${g.label} Co.`, country: "TH", taxId: "0105500000001", ssoEmployerNumber: "1000000001", defaultPayDay: 28, reason });
    await must(g, "admin", "POST", `/api/payroll/setup/branches/${g.branches[0]}/details`, { effectiveFrom: "2025-01-01", foodAllowanceDefault: 60, reason,
      details: { country: "TH", payingEntityId: entity.id, ssoBranchNumber: "830001", payDate: 28, legalEntity: "ZZ", employerNumber: "1000000001", taxId: "0105500000001", address: "ZZ", payrollBank: "SCB" } });
    return entity.id as string;
  };
  const aEntity = await setupFor(A);
  await setupFor(B);
  const branch = A.branches[0];
  const view = (g: Group, period: string, branchId = g.branches[0], role: Role = "admin") => call(g, role, "GET", `/api/payroll/statutory?branchId=${branchId}&period=${period}`);

  await okAsync("fences: manager and staff get 403 on every statutory route (writes are hr.manage_payroll, pinned by the census)", async () => {
    const routes = [["GET", `/api/payroll/statutory?branchId=${branch}&period=2026-09`], ["GET", "/api/payroll/statutory/ewf-surcharge?dueDate=2026-11-15&asOfDate=2026-12-15&principal=1000"],
      ["POST", "/api/payroll/statutory/documents"], ["GET", `/api/payroll/statutory/documents/${randomUUID()}/files/0`], ["POST", "/api/payroll/statutory/filings"]] as const;
    for (const role of ["manager", "staff"] as const) {
      for (const [method, path] of routes) {
        const r = await call(A, role, method, path, { reason });
        assert.equal(r.status, 403, `${role} ${method} ${path}: ${r.status}`);
      }
    }
    assert.equal((await view(A, "2026-09")).status, 200);
  });

  await okAsync("our data: every form says it has no source, in the plain words and the engine's own (monthly)", async () => {
    const v = (await view(A, "2026-09")).body;
    assert.deepEqual(v.source.notes, [NO_SOURCE]);
    assert.deepEqual([v.source.legacyRuns, v.branchId, v.kind], [0, branch, "month"]);
    const pnd1 = v.offers.find((o: { code: string }) => o.code === "PND1");
    assert.deepEqual([pnd1.coverageState, pnd1.sourceRuns, pnd1.coverage.missing, pnd1.provisional, pnd1.dueDate], ["no-source", [], ["2026-09"], true, "2026-10-07"]);
    assert.ok(pnd1.warnings.includes(MONTH_BLOCKED), JSON.stringify(pnd1.warnings));
    assert.deepEqual(v.offers.map((o: { code: string }) => o.code).sort(), ["PND1", "SSO1-10-P1", "SSO1-10-P2"]);
  });
  await okAsync("our data: the annual forms are PROVISIONAL – 0 of 12, generation blocked, and nothing is filled in", async () => {
    const v = (await view(A, "2026")).body;
    for (const code of ["PND1A", "KT20A"]) {
      const offer = v.offers.find((o: { code: string }) => o.code === code);
      assert.ok(offer.warnings.includes(PROVISIONAL_0) && offer.warnings.includes(YEAR_BLOCKED), `${code}: ${JSON.stringify(offer.warnings)}`);
      assert.deepEqual([offer.coverage.locked, offer.coverage.missing.length, offer.coverageState, offer.dueDate], [[], 12, "no-source", "2027-02-28"]);
    }
    assert.ok(!v.offers.some((o: { code: string }) => o.code === "50Tawi"), "no 50 ทวิ without a frozen person");
  });
  await okAsync("a locked company month-end is named as giving these documents nothing", async () => {
    const [run] = await q<{ id: string }>("insert into payroll_month_runs (tenant_id, entity_id, month, pay_date) values ($1, $2, '2026-08', '2026-08-28') returning id", [A.tenant, aEntity]);
    const [ver] = await q<{ id: string }>("insert into payroll_run_versions (tenant_id, run_id, version, status, stage) values ($1, $2, 1, 'locked', 'outputs') returning id", [A.tenant, run.id]);
    await q(`insert into payroll_run_snapshots (tenant_id, run_id, run_version_id, entity_id, month, version, result, calculation, outputs_manifest, audit, reward_config, input_snapshot, world,
      engine_revision, source_signature, locked_by_name, gm_actor) values ($1, $2, $3, $4, '2026-08', 1, '{}', '{}', '{}', '[]', '{}', '{}', '{}', 'zz', 'zz', 'ZZ Owner', 'ZZ GM')`, [A.tenant, run.id, ver.id, aEntity]);
    const v = (await view(A, "2026-08")).body;
    assert.deepEqual(v.source.notes, [NO_SOURCE, "1 locked company month-end for this period (ZZ docs-a Co. 2026-08 v1) gives these documents nothing."]);
    assert.equal(v.offers.find((o: { code: string }) => o.code === "PND1").coverageState, "no-source", "the company month gives PND.1 nothing");
    const year = (await view(A, "2026")).body;
    assert.match(year.source.notes[1], /^1 locked company month-end for this period \(ZZ docs-a Co\. 2026-08 v1\) gives these documents nothing\.$/);
    assert.deepEqual((await view(B, "2026-08")).body.source.notes, [NO_SOURCE], "B's page never names A's month");
  });
  await okAsync("rendering refuses in the prototype's words, with the explanation; nothing is stored", async () => {
    const r = await call(A, "admin", "POST", "/api/payroll/statutory/documents", { branchId: branch, period: "2026-09", code: "PND1", reason });
    assert.deepEqual([r.status, r.body.message, r.body.errors], [409, "No locked source run is available for this offer.", [NO_SOURCE]]);
    const gone = await call(A, "admin", "POST", "/api/payroll/statutory/documents", { branchId: branch, period: "2026-09", code: "PND9", reason });
    assert.deepEqual([gone.status, gone.body.message], [409, "Statutory offer PND9 is no longer applicable; refresh the offer list."]);
    assert.equal((await call(A, "admin", "POST", "/api/payroll/statutory/documents", { branchId: branch, period: "2026-09", code: "PND1" })).body.message, "A reason is required.");
    assert.equal(await count("select count(*) n from payroll_statutory_documents where tenant_id = $1", [A.tenant]), 0);
  });
  let filingId = "";
  await okAsync("a filing made outside the app is saved with its reason and its coverage state, and audited", async () => {
    const saved = await must(A, "admin", "POST", "/api/payroll/statutory/filings", { branchId: branch, period: "2026-09", code: "PND1", filedOn: "2026-10-06", reference: "ZZ-RD-0001", reason });
    filingId = saved.id;
    assert.deepEqual([saved.coverageState, saved.documentId, saved.renderedAt, saved.filedOn, saved.reference, saved.reason, saved.coverage.missing],
      ["no-source", null, null, "2026-10-06", "ZZ-RD-0001", reason, ["2026-09"]]);
    const [audit] = await q<{ action: string; reason: string; actor_name: string; filing_id: string; detail: { coverageState: string } }>(
      "select action, reason, actor_name, filing_id, detail from payroll_statutory_audit where tenant_id = $1", [A.tenant]);
    assert.deepEqual([audit.action, audit.reason, audit.filing_id, audit.detail.coverageState], ["filing recorded (filed outside the app)", reason, filingId, "no-source"]);
    assert.match(audit.actor_name, /ZZ TEST docs-a admin/);
    const v = (await view(A, "2026-09")).body;
    assert.deepEqual([v.filings.map((f: { id: string }) => f.id), v.offers.find((o: { code: string }) => o.code === "PND1").filed, v.audit.length], [[filingId], true, 1]);
  });
  await okAsync("filing refusals: date and reference required, a reason required, an unknown form refused", async () => {
    const bad = await call(A, "admin", "POST", "/api/payroll/statutory/filings", { branchId: branch, period: "2026-09", code: "PND1", filedOn: "2026-10-06", reference: " ", reason });
    assert.deepEqual([bad.status, bad.body.message], [400, "A valid filing date, reference, recognized role, and actor are required."]);
    assert.equal((await call(A, "admin", "POST", "/api/payroll/statutory/filings", { branchId: branch, period: "2026-09", code: "PND1", filedOn: "2026-10-06", reference: "X" })).body.message, "A reason is required.");
    const gone = await call(A, "admin", "POST", "/api/payroll/statutory/filings", { branchId: branch, period: "2026-09", code: "KT20A", filedOn: "2026-10-06", reference: "X", reason });
    assert.deepEqual([gone.status, gone.body.message], [409, "Statutory offer KT20A is no longer applicable; refresh the offer list."]);
  });
  await okAsync("a stored document: opened as frozen and audited; filed only when final (the prototype's order of refusals)", async () => {
    // A document row as rendering stores one (no rendering can happen on this data): provisional first, then final.
    const insertDoc = async (provisional: boolean, key: string) => (await q<{ id: string }>(`insert into payroll_statutory_documents (tenant_id, branch_id, period, document_code, document_key, title,
      source_runs, provisional, coverage, warnings, due_date, html, files, sha256, rendered_by_name) values ($1, $2, '2026-09', 'PND1', $3, 'ZZ PND.1', '[]', $4,
      '{"locked":[],"missing":["2026-09"],"notApplicable":[]}', '[]', '2026-10-07', '<p>ZZ</p>', $5, 'zz', 'ZZ') returning id`,
    [A.tenant, branch, key, provisional, JSON.stringify([{ name: "zz.html", mime: "text/html;charset=utf-8", content: "<!doctype html><p>ZZ frozen</p>" }])]))[0].id;
    const provisional = await insertDoc(true, `zz-${randomUUID()}`);
    const final = await insertDoc(false, `zz-${randomUUID()}`);
    const file = await call(A, "admin", "GET", `/api/payroll/statutory/documents/${provisional}/files/0`);
    assert.deepEqual([file.status, file.body], [200, "<!doctype html><p>ZZ frozen</p>"]);
    assert.equal(await count("select count(*) n from payroll_statutory_audit where tenant_id = $1 and document_id = $2 and action = 'opened zz.html'", [A.tenant, provisional]), 1);
    assert.equal((await call(A, "admin", "GET", `/api/payroll/statutory/documents/${provisional}/files/7`)).status, 404);
    const file1 = (documentId: string) => call(A, "admin", "POST", "/api/payroll/statutory/filings", { documentId, filedOn: "2026-10-06", reference: "ZZ-RD-2", reason });
    const p = await file1(provisional);
    assert.deepEqual([p.status, p.body.message], [409, "Provisional statutory documents cannot be marked filed."]);
    const r = await file1(final);
    assert.deepEqual([r.status, r.body.message], [409, "Statutory documents must be final against current authoritative coverage before filing."], "the period has no source, so nothing can be filed as final");
    assert.equal((await file1(randomUUID())).status, 404);
    assert.equal(await count("select count(*) n from payroll_statutory_filings where tenant_id = $1 and document_id is not null", [A.tenant]), 0);
  });
  await okAsync("documents, filings and their audit refuse UPDATE and DELETE at the database", async () => {
    for (const [table, where] of [["payroll_statutory_filings", `id = '${filingId}'`], ["payroll_statutory_audit", `tenant_id = '${A.tenant}'`], ["payroll_statutory_documents", `tenant_id = '${A.tenant}'`]]) {
      await assert.rejects(q(`update ${table} set tenant_id = tenant_id where ${where}`), /is frozen payroll: rows are never changed or removed \(UPDATE refused\)/, table);
      await assert.rejects(q(`delete from ${table} where ${where}`), /is frozen payroll: rows are never changed or removed \(DELETE refused\)/, table);
    }
  });
  await okAsync("EWF on the page: October 2026 says plainly there is no frozen amount; the estimate works on entered figures", async () => {
    const v = (await view(A, "2026-10")).body;
    assert.deepEqual([v.ewf.relevant, v.ewf.frozenPrincipal, v.ewf.remittanceDue], [true, null, null]);
    assert.deepEqual(v.ewf.lines, ["No locked per-branch payroll month for 2026-10: the EWF documents, contribution totals and alerts are unavailable.",
      "Estimate unavailable: no locked EWF3 source with frozen contribution amounts is available."]);
    assert.equal((await view(A, "2026-09")).body.ewf.relevant, false, "before October 2026 EWF does not apply");
    const est = await must(A, "admin", "GET", "/api/payroll/statutory/ewf-surcharge?dueDate=2026-11-15&asOfDate=2027-01-30&principal=1000");
    assert.deepEqual(est, { dueDate: "2026-11-15", asOfDate: "2027-01-30", unpaidPrincipal: 1000, chargeableMonths: 3, surcharge: 150 });
    const bad = await call(A, "admin", "GET", "/api/payroll/statutory/ewf-surcharge?dueDate=2026-13-01&asOfDate=2027-01-30&principal=1000");
    assert.deepEqual([bad.status, bad.body.message], [400, "Enter valid due and as-of dates in YYYY-MM-DD format."]);
  });
  await okAsync("cross-tenant: park group B reaches none of A's branch, documents, files or filings (404)", async () => {
    assert.equal((await view(B, "2026-09", branch)).status, 404);
    const [doc] = await q<{ id: string }>("select id from payroll_statutory_documents where tenant_id = $1 limit 1", [A.tenant]);
    for (const [method, path, payload] of [
      ["GET", `/api/payroll/statutory/documents/${doc.id}/files/0`, undefined],
      ["POST", "/api/payroll/statutory/documents", { branchId: branch, period: "2026-09", code: "PND1", reason }],
      ["POST", "/api/payroll/statutory/filings", { branchId: branch, period: "2026-09", code: "PND1", filedOn: "2026-10-06", reference: "X", reason }],
      ["POST", "/api/payroll/statutory/filings", { documentId: doc.id, filedOn: "2026-10-06", reference: "X", reason }],
    ] as const) {
      const r = await call(B, "operator_admin", method, path, payload);
      assert.equal(r.status, 404, `${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal(await count("select count(*) n from payroll_statutory_filings where tenant_id = $1", [B.tenant]), 0);
  });
  console.log(`payroll-documents.check: ${passed} checks passed`);
} catch (error) {
  console.error("payroll-documents.check FAILED:", error);
  process.exitCode = 1;
} finally {
  stopServers();
  await pool.end();
}
