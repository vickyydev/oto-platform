// Ported from the payroll prototype's ewf-upload-file.test.ts (imports/oto-app/client/src/lib/payroll-prototype/);
// test bodies unchanged unless a comment says otherwise.
import { describeSuite, test } from "../harness";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { createSeedData } from "../seed-world";
import { calculateCompanyEngine } from "../../../server/payroll/engine/company-calculations";
import { generateCompanyOutputs } from "../../../server/payroll/engine/company-outputs";
import { fictionalThaiId } from "../../../server/payroll/engine/upload-common";
import { ageAtMonthEnd, EWF_UPLOAD_HEADERS, ewfUploadFile, withOfficialEwfDownloads } from "../../../server/payroll/engine/ewf-upload-file";
import { payrollUploadsZip } from "../../../server/payroll/engine/company-upload-files";
import { unzipSync, strFromU8 } from "fflate";
import type { CompanySnapshot } from "../../../server/payroll/engine/company-model";
describeSuite("ewf-upload-file.test.ts");

function fixture() {
  const data = createSeedData();
  Object.values(data.branches).flatMap(b => b.staff).forEach((s, i) => { if (!s.payrollProfile!.taxId) s.payrollProfile!.taxId = fictionalThaiId(800 + i); });
  const calculate = (month = "2026-10") => {
    const calculation = calculateCompanyEngine(data, data.companyPayroll!, month);
    return { calculation, result: calculation.entities.find(e => e.entityId === "tt-concept")! };
  };
  return { data, calculate };
}
test("official EWF: one establishment XLSX, Sheet1, exact header block, 11 headers, shared staff once, no total/contribution column", () => {
  const { data, calculate } = fixture(), { calculation, result } = calculate();
  const output = ewfUploadFile(data, calculation, result);
  assert.deepEqual(output.issues, []); assert.equal(output.files.length, 1);
  const f = output.files[0], wb = XLSX.read(f.content, { type: "base64", cellNF: true }), ws = wb.Sheets.Sheet1;
  assert.equal(f.filename, "EWF_TT-CONCEPT_256910.xlsx"); assert.equal(f.mime, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.deepEqual(wb.SheetNames, ["Sheet1"]); assert.equal(ws.A1.v, "ชื่อสถานประกอบกิจการ");
  assert.equal(ws.B1.v, data.payingEntities!.find(e => e.id === result.entityId)!.name);
  assert.deepEqual(ws["!merges"], [XLSX.utils.decode_range("B1:H1")]);
  assert.equal(ws.A2.v, "รอบการส่งเงิน ปี พ.ศ."); assert.equal(ws.B2.v, 2569); assert.equal(ws.C2.v, "เดือน"); assert.equal(ws.D2.v, "ตุลาคม");
  assert.equal(ws.A3.v, "วันที่ดำเนินการนำส่ง"); assert.equal(ws.B3.v, "28/10/2569");
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1 });
  assert.deepEqual(rows[3], EWF_UPLOAD_HEADERS); assert.equal(rows.length, f.rows + 4);
  assert.equal(XLSX.utils.decode_range(ws["!ref"]!).e.c, 10);
  const gm = result.people.find(p => p.allocationBadge === "70/30" && p.jobTitle === "General Manager")!;
  assert.equal(f.preview.rows.filter(row => row[5] === gm.taxId).length, 1);
  assert.equal(f.total, Math.round(result.people.reduce((n, p) => n + (p.components.ewf ?? 0), 0) * 100) / 100);
  assert.match(f.note!, /Employer contribution \(company cost\)/); assert.doesNotMatch(f.note!, /provisional/);
});
test("EWF text IDs/passports preserve leading digits and letters; ages use month end and all requested cell formats", () => {
  const { data, calculate } = fixture(), s = data.branches["hkt-central"].staff[0], p = s.payrollProfile!;
  Object.assign(p, { dateOfBirth: "2000-10-31", nationality: "เมียนมา", taxId: "", passportNumber: "AB00001234", ssoEligible: false });
  const { calculation, result } = calculate(), f = ewfUploadFile(data, calculation, result).files[0];
  const ws = XLSX.read(f.content, { type: "base64", cellNF: true }).Sheets.Sheet1;
  const index = f.preview.rows.findIndex(row => row[1] === p.givenName) + 5;
  assert.ok(index >= 5); assert.equal(ws[`D${index}`].v, 26); assert.equal(ws[`E${index}`].v, "เมียนมา"); assert.equal(ws[`F${index}`].v, "AB00001234");
  for (const col of ["A", "B", "C", "E", "F", "G", "K"]) { assert.equal(ws[`${col}${index}`].t, "s"); assert.equal(ws[`${col}${index}`].z, "@"); }
  assert.equal(ws[`D${index}`].z, "#,##0"); assert.equal(ws[`H${index}`].z, "#,##0.00");
  assert.equal(ws[`I${index}`].t, "n"); assert.equal(ws[`I${index}`].z, "dd/mm/yyyy"); assert.equal(ws[`J${index}`].z, "dd/mm/yyyy");
  assert.equal(ageAtMonthEnd("2000-11-01", "2026-10"), 25);
  p.taxId = "001234567890" + ((11 - "001234567890".split("").reduce((n, v, i) => n + Number(v) * (13 - i), 0) % 11) % 10);
  const next = calculate(), row = ewfUploadFile(data, next.calculation, next.result).files[0].preview.rows.find(r => r[1] === p.givenName)!;
  assert.equal(row[5], p.taxId); assert.ok(String(row[5]).startsWith("00"));
});
test("missing DOB, nationality or identity is Needs attention / Missing details and excluded until repaired", () => {
  const { data, calculate } = fixture();
  const eligible = calculate().result.people.filter(p => (p.components.ewf ?? 0) > 0).slice(0, 3).map(p => p.id);
  const staff = eligible.map(id => Object.values(data.branches).flatMap(b => b.staff).find(s => s.id === id)!);
  staff[0].payrollProfile!.dateOfBirth = ""; staff[1].payrollProfile!.nationality = "";
  Object.assign(staff[2].payrollProfile!, { taxId: "", passportNumber: "" });
  let { calculation, result } = calculate(), out = ewfUploadFile(data, calculation, result);
  ["date of birth", "nationality", "Thai ID / passport"].forEach((text, i) => {
    assert.ok(result.exceptions.some(e => e.staffId === staff[i].id && e.kind === "missing-details" && e.message.includes(text)));
    assert.ok(out.issues.some(issue => issue.startsWith(`${staff[i].name}:`) && issue.includes(text)));
  });
  assert.match(out.issues.join(" "), /excluded until fixed/);
  staff[0].payrollProfile!.dateOfBirth = "1990-01-01"; staff[1].payrollProfile!.nationality = "ไทย"; staff[2].payrollProfile!.taxId = fictionalThaiId(4000);
  ({ calculation, result } = calculate()); out = ewfUploadFile(data, calculation, result);
  assert.deepEqual(out.issues, []);
});
test("monthly joiner uses actual days; day-rate label; start dates for everyone and end/reason only in leaving month", () => {
  const { data, calculate } = fixture(), p = data.branches["hkt-central"].staff[0].payrollProfile!;
  Object.assign(p, { monthlySalary: 18000, joinedOn: "2026-10-19", lastWorkingDay: null });
  const id = data.branches["hkt-central"].staff[0].id;
  for (const [month, inputs] of Object.entries(data.companyPayroll!.months)) {
    inputs.staff[id].daysWorked = month < "2026-10" ? 0 : 13;
  }
  data.companyPayRules!["tt-concept"].forEach(r => r.allowances = []);
  data.branches["hkt-central"].rulesHistory.forEach(r => r.allowances = []);
  let { calculation, result } = calculate(), f = ewfUploadFile(data, calculation, result).files[0];
  let row = f.preview.rows.find(r => r[1] === p.givenName)!;
  assert.equal(row[6], "รายเดือน"); assert.equal(row[7], 7548.39); assert.equal(row[8], "19/10/2026"); assert.equal(row[9], ""); assert.equal(row[10], "");
  Object.assign(p, { joinedOn: "2025-01-01", lastWorkingDay: "2026-10-15", leavingReason: "ลาออก" });
  data.companyPayroll!.months["2026-10"].staff[id].daysWorked = 15;
  ({ calculation, result } = calculate()); row = ewfUploadFile(data, calculation, result).files[0].preview.rows.find(r => r[1] === p.givenName)!;
  assert.equal(row[7], 8709.68); assert.equal(row[8], "01/01/2025"); assert.equal(row[9], "15/10/2026"); assert.equal(row[10], "ลาออก");
  p.leavingReason = ""; ({ calculation, result } = calculate());
  assert.match(ewfUploadFile(data, calculation, result).issues.join(" "), /missing leaving reason/);
  Object.assign(p, { lastWorkingDay: "2026-11-15", leavingReason: "ลาออก", workerType: "day-rate", dayRate: 400 });
  ({ calculation, result } = calculate()); row = ewfUploadFile(data, calculation, result).files[0].preview.rows.find(r => r[1] === p.givenName)!;
  assert.equal(row[6], "รายวัน"); assert.equal(row[9], ""); assert.equal(row[10], "");
});
test("legacy per-branch EWF downloads are replaced only in the downloadable view, ZIP stays correct and frozen money is unchanged", () => {
  const { data, calculate } = fixture(), { calculation, result } = calculate();
  const outputs = generateCompanyOutputs(data, calculation, result.entityId);
  const ewf = outputs.downloadFiles!.find(f => f.group === "Welfare fund (EWF)")!;
  outputs.downloadFiles = [...outputs.downloadFiles!.filter(f => f.group !== "Welfare fund (EWF)"), { ...ewf, filename: "old_830002_EWF.xls", note: "provisional" }, { ...ewf, filename: "old_830001_EWF.xls", note: "provisional" }];
  const snapshot = { entityId: result.entityId, month: result.month, version: 1, lockedAt: "2026-10-28", lockedBy: "Fictional owner", gmActor: "Fictional GM", result, calculation, outputs, audit: [] } satisfies CompanySnapshot;
  const before = JSON.stringify(snapshot), view = withOfficialEwfDownloads(data, snapshot);
  assert.equal(JSON.stringify(snapshot), before); assert.strictEqual(view.result, result);
  assert.equal(view.outputs.downloadFiles!.filter(f => f.group === "Welfare fund (EWF)").length, 1);
  const archive = unzipSync(payrollUploadsZip(view));
  assert.ok(archive["EWF_TT-CONCEPT_256910.xlsx"]); assert.ok(!Object.keys(archive).some(k => k.endsWith("_EWF.xls")));
  assert.doesNotMatch(strFromU8(archive["README.txt"]), /provisional/);
  assert.strictEqual(withOfficialEwfDownloads(data, view), view);
});
// The migration half of this prototype test (migrateEwfProfileDetails, a
// browser-storage migration that dies, plan §2) is not ported; the September
// file half is.
test("September emits a populated company file", () => {
  const { data, calculate } = fixture();
  const { calculation, result } = calculate("2026-09"), f = ewfUploadFile(data, calculation, result).files[0];
  assert.equal(f.filename, "EWF_TT-CONCEPT_256909.xlsx"); assert.ok(f.rows > 0);
  assert.equal(XLSX.utils.sheet_to_json(XLSX.read(f.content, { type: "base64" }).Sheets.Sheet1, { header: 1 }).length, f.rows + 4);
});
