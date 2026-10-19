// Ported from the payroll prototype's upload-formats.test.ts (imports/oto-app/client/src/lib/payroll-prototype/);
// test bodies unchanged unless a comment says otherwise.
import { describeSuite, test } from "../harness";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { unzipSync } from "fflate";
import { createSeedData } from "../seed-world";
import { calculateCompanyEngine } from "../../../server/payroll/engine/company-calculations";
import { generateCompanyOutputs } from "../../../server/payroll/engine/company-outputs";
import { scbUploadFiles } from "../../../server/payroll/engine/scb-upload-files";
import { fictionalThaiId, thaiIdValid } from "../../../server/payroll/engine/upload-common";
import { payrollUploadsZip, uploadFileBytes } from "../../../server/payroll/engine/company-upload-files";
import { statutoryUploadFiles, STATUTORY_UPLOAD_HEADERS } from "../../../server/payroll/engine/statutory-upload-files";
import { approveCompanyRun, lockCompanyRun, newCompanyDraft } from "../../../server/payroll/engine/company-workflow";
import type { CompanyPayment, CompanySnapshot } from "../../../server/payroll/engine/company-model";
import type { PayingAccount } from "../../../server/payroll/engine/payroll-profile";
describeSuite("upload-formats.test.ts");

const payer: PayingAccount = { id: "demo-scb", entityId: "tt-concept", label: "Fictional SCB payer", bank: "SCB", accountNumber: "9901000001", accountName: "Fictional company", fileFormat: "SCB", valueDate: "2026-10-28", feeAccount: "9901000002" };
const payment = (bankCode = "014", amount = 1234.56): CompanyPayment => ({ staffId: "fictional-one", person: "Fictional Person", entityId: "tt-concept", payingAccountId: payer.id, method: "bank-transfer", bank: { bank: bankCode === "014" ? "SCB" : "KBank", bankCode, accountName: "Fictional Person", accountNumber: "0012345678" }, reason: "", amount, batch: bankCode === "014" ? "same-bank" : "other-bank" });
function salaryFixture(month: string, salary: number, joinedOn = "2025-01-01") {
  const d = createSeedData(), s = d.branches["hkt-central"].staff[0];
  for (const b of Object.values(d.branches)) { b.staff = b.id === "hkt-central" ? [s] : []; b.employeeIncentivePlans = []; b.roleIncentiveDefaults = []; b.rulesHistory.forEach(r => r.allowances = []); }
  const p = s.payrollProfile!;
  Object.assign(p, { workerType: "monthly", monthlySalary: salary, joinedOn, lastWorkingDay: null, foodAllowanceEligible: false, otEligible: false, serviceChargeEligible: false, pnd1Eligible: false, studentLoanMonthly: 0, advances: [], separatePayments: [], taxId: fictionalThaiId(900), ssoTitle: "นาย", givenName: "สมมติ", surname: "" });
  p.allocations = [{ effectiveFrom: "2025-01-01", homeBranchId: "hkt-central", lines: [{ costCentre: "hkt-central", percent: 100, entityId: "tt-concept", payingAccountId: "tt-central-scb" }] }];
  d.attendance = [];
  d.companyPayRules!["tt-concept"].forEach(r => r.allowances = []);
  d.companyPayroll!.incentives = [];
  for (const [m, inputs] of Object.entries(d.companyPayroll!.months)) {
    const length = new Date(`${m}-01T00:00:00Z`); length.setUTCMonth(length.getUTCMonth() + 1); length.setUTCDate(0);
    inputs.staff[s.id] = { daysWorked: m < joinedOn.slice(0, 7) ? 0 : m === joinedOn.slice(0, 7) ? length.getUTCDate() - Number(joinedOn.slice(-2)) + 1 : length.getUTCDate() } as (typeof inputs.staff)[string]; // cast only: the prototype test stores days alone
  }
  const calc = calculateCompanyEngine(d, d.companyPayroll!, month);
  return { d, calc, result: calc.entities.find(e => e.entityId === "tt-concept")!, s };
}
test("fictional national IDs have a checksum; malformed IDs fail", () => {
  assert.equal(thaiIdValid(fictionalThaiId(123)), true);
  assert.equal(thaiIdValid("1234567890123"), false);
  assert.equal(thaiIdValid("0000000000000"), false);
});
test("SSO is BIFF8, one registered-branch sheet, numeric 13-digit ID, uncapped wage and no total row", () => {
  const { d, calc, result, s } = salaryFixture("2026-09", 70000);
  const output = statutoryUploadFiles(d, calc, result);
  assert.deepEqual(output.issues, []);
  const f = output.files.find(f => f.group === "Social security (SSO)")!;
  assert.equal(f.filename, "8320990001_830002_25690928.xls");
  assert.equal(Buffer.from(uploadFileBytes(f)).subarray(0, 8).toString("hex"), "d0cf11e0a1b11ae1");
  const wb = XLSX.read(f.content, { type: "base64", cellNF: true });
  assert.deepEqual(wb.SheetNames, ["830002"]);
  const ws = wb.Sheets["830002"], rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  assert.deepEqual(rows[0], STATUTORY_UPLOAD_HEADERS); assert.equal(rows.length, 2);
  assert.equal(ws.A2.t, "n"); assert.equal(ws.A2.v, Number(s.payrollProfile!.taxId)); assert.equal(ws.A2.z, "0000000000000");
  assert.equal(ws.E2.v, 70000); assert.equal(ws.E2.z, "0.00"); assert.equal(ws.F2.v, 875); assert.equal(f.total, 875);
});
test("actual-calendar default pays a 19 August joiner 13/31 and rounds SSO to whole baht", () => {
  const { d, calc, result } = salaryFixture("2026-08", 18000, "2026-08-19");
  assert.equal(result.people[0].components.salary, 7548.39);
  assert.equal(result.people[0].components.sso, 377);
  const f = statutoryUploadFiles(d, calc, result).files.find(f => f.group === "Social security (SSO)")!;
  assert.equal(f.preview.rows[0][4], 7548.39); assert.equal(f.preview.rows[0][5], 377);
});
test("fixed 30-day proration remains available; invalid IDs, titles and zero wage are excluded", () => {
  const { d } = salaryFixture("2026-08", 18000, "2026-08-19");
  d.branches["hkt-central"].rulesHistory.forEach(r => r.calendarProration = { method: "fixed-divisor", divisor: 30 });
  d.companyPayRules!["tt-concept"].forEach(r => r.calendarProration = { method: "fixed-divisor", divisor: 30 });
  let calc = calculateCompanyEngine(d, d.companyPayroll!, "2026-08"), result = calc.entities.find(e => e.entityId === "tt-concept")!;
  assert.equal(result.people[0].components.salary, 7800);
  d.branches["hkt-central"].staff[0].payrollProfile!.taxId = "1234567890123";
  d.branches["hkt-central"].staff[0].payrollProfile!.ssoTitle = "";
  calc = calculateCompanyEngine(d, d.companyPayroll!, "2026-08"); result = calc.entities.find(e => e.entityId === "tt-concept")!;
  const out = statutoryUploadFiles(d, calc, result);
  assert.match(out.issues.join(" "), /checksum/); assert.match(out.issues.join(" "), /title/);
  assert.equal(out.files.find(f => f.group === "Social security (SSO)")!.rows, 0);
  assert.match(out.issues.join(" "), /do not match payroll/);
  Object.assign(d.branches["hkt-central"].staff[0].payrollProfile!, { taxId: fictionalThaiId(900), ssoTitle: "นาย", monthlySalary: 0 });
  calc = calculateCompanyEngine(d, d.companyPayroll!, "2026-08"); result = calc.entities.find(e => e.entityId === "tt-concept")!;
  assert.match(statutoryUploadFiles(d, calc, result).issues.join(" "), /wage is 0/);
});
test("SCB PAY/SPN have exact 28-field transactions, CRLF, no BOM, bank codes, references and matching trailers", () => {
  const same = payment(), other = payment("004", 2000);
  same.bank.mobile = "089-000-0001"; same.bank.email = "fictional@example.invalid";
  const files = scbUploadFiles(payer, [same, other, { ...payment(), method: "cash" }, { ...payment(), method: "third-party", reason: "Fictional manual payment" }], "2026-09", 0);
  const txt = files.filter(f => f.filename.endsWith(".txt"));
  assert.equal(txt.length, 2); assert.equal(txt.reduce((n, f) => n + f.total, 0), 3234.56);
  txt.forEach(f => {
    assert.match(f.filename, /^SCB_file_reference_\d{12}\.txt$/); assert.equal(f.content.charCodeAt(0), 72);
    assert.equal(f.content.replaceAll("\r\n", "").includes("\n"), false);
    const lines = f.content.trim().split("\r\n"), batch = lines[1].split("|"), txn = lines[2].split("|");
    assert.equal(txn.length, 28); assert.equal(batch[3], "20261028"); assert.equal(batch[4], payer.accountNumber); assert.equal(batch[5], payer.feeAccount);
    assert.equal(txn[1], "SAL-SEP26-0001"); assert.equal(txn[2], "0012345678"); assert.equal(txn[27], "SALARY SEP26");
    assert.equal(lines[3], `TRAILR|1|1|${f.total.toFixed(2)}`);
    if (batch[2] === "PAY") { assert.equal(txn[4], "014"); assert.equal(txn[5], "0111"); assert.equal(txn[7], ""); assert.equal(txn[9], "Y"); assert.equal(txn[10], "0890000001"); assert.equal(txn[11], "Y"); assert.equal(txn[20], "Y"); assert.equal(txn[25], "E"); }
    else { assert.equal(batch[2], "SPN"); assert.equal(txn[4], "004"); assert.equal(txn[5], ""); assert.equal(txn[7], "01"); }
  });
});
test("SCB Excel fallback has the Payment sheet, row 8 headers and row 9 data", () => {
  const file = scbUploadFiles(payer, [payment()], "2026-09", 0).find(f => f.filename.endsWith(".xlsx"))!;
  const wb = XLSX.read(file.content, { type: "base64" }), ws = wb.Sheets.Payment;
  assert.equal(ws.A2.v, "Customer File Ref"); assert.equal(ws.A5.v, "Value Date"); assert.equal(ws.B5.v, "28/10/2026");
  assert.equal(ws.A8.v, "Credit Seq. No."); assert.equal(ws.L8.v, "Payment Advice Remark");
  assert.equal(ws.C9.v, "0012345678"); assert.equal(ws.E9.v, 1234.56);
});
test("generated upload batches plus cash/manual list reconcile, shared staff file once, company EWF and ZIP has actual bytes", () => {
  const d = createSeedData();
  Object.values(d.branches).flatMap(b => b.staff).forEach((s, i) => { if (!s.payrollProfile!.taxId) s.payrollProfile!.taxId = fictionalThaiId(3000 + i); });
  const calc = calculateCompanyEngine(d, d.companyPayroll!, "2026-09"), result = calc.entities.find(e => e.entityId === "tt-concept")!;
  const out = generateCompanyOutputs(d, calc, result.entityId);
  assert.deepEqual(out.uploadIssues, []); assert.equal(out.uploadDifference, 0);
  assert.deepEqual(out.downloadFiles!.filter(f => f.group === "Tax (PND.1/PND.3)").map(f => f.filename.match(/PND\.?[13]/)![0]).sort(), ["PND1", "PND3"]);
  const netFromBytes = out.downloadFiles!.filter(f => f.group === "Bank files" && f.filename.endsWith(".txt")).reduce((n, f) => n + Number(f.content.trim().split("\r\n").at(-1)!.split("|")[3]), 0);
  assert.equal(Math.round((netFromBytes + out.cashAmount) * 100), Math.round(out.net * 100));
  assert.equal(out.banks.flatMap(b => b.transfers).some(p => p.method === "third-party"), false);
  const gm = result.people.find(p => /General Manager/.test(p.jobTitle))!;
  assert.equal(out.downloadFiles!.filter(f => f.group === "Social security (SSO)").flatMap(f => f.preview.rows).filter(r => Number(r[0]) === Number(gm.taxId)).length, 1);
  assert.equal(out.downloadFiles!.filter(f => f.group === "Welfare fund (EWF)").length, 1);
  assert.equal(out.downloadFiles!.find(f => f.group === "Welfare fund (EWF)")!.filename, "EWF_TT-CONCEPT_256909.xlsx");
  assert.equal(out.downloadFiles!.some(f => f.filename.endsWith("_EWF.xls")), false);
  const snapshot = { outputs: out, entityId: result.entityId, month: result.month, version: 1 } as CompanySnapshot;
  const zip = unzipSync(payrollUploadsZip(snapshot));
  assert.equal(Object.keys(zip).length, out.downloadFiles!.length + 1);
  assert.deepEqual(zip[out.downloadFiles![0].filename], uploadFileBytes(out.downloadFiles![0]));
});
// Not ported: "upload migrations are idempotent ..." tests the browser-storage
// migration upload-settings-migration.ts, which dies (plan §2).
