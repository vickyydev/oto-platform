import type { PayrollWorld } from "./model";
import type { CompanyCalculation, CompanyDownloadFile, CompanyResult } from "./company-model";
import { binaryFile, buddhistDate, isoValueDate, thaiIdValid } from "./upload-common";
import { money } from "./company-math";
import { ewfUploadFile } from "./ewf-upload-file";

export const STATUTORY_UPLOAD_HEADERS = ["เลขบัตรประชาชน", "คำนำหน้า", "ชื่อ", "สกุล", "ค่าจ้าง", "เงินสมทบ"];
export const SSO_TITLES = ["นาย", "นาง", "นางสาว", "Mr.", "Ms."];

export function statutoryUploadFiles(data: PayrollWorld, calculation: CompanyCalculation, result: CompanyResult): { files: CompanyDownloadFile[]; issues: string[] } {
  const entity = data.payingEntities?.find(e => e.id === result.entityId);
  if (entity?.country !== "TH") return { files: [], issues: [] };
  const welfareFile = ewfUploadFile(data, calculation, result);
  const issues: string[] = [...welfareFile.issues], files: CompanyDownloadFile[] = [...welfareFile.files];
  const employer = entity.ssoEmployerNumber ?? "";
  if (!/^\d{10}$/.test(employer)) return { files, issues: ["Company: SSO employer account no. must have 10 digits."] };
  const staff = Object.values(data.branches).flatMap(b => b.staff);
  const groups = new Map<string, { sso: (string | number)[][]; expectedSso: number }>();
  for (const person of result.people) {
    const insured = person.lines.filter(l => l.component === "sso" && (l.remittingEntityId ?? person.entityId) === result.entityId);
    if (!insured.length) continue;
    const branch = data.branches[person.homeBranchId], number = branch.detailsHistory.at(-1)?.details.ssoBranchNumber ?? "";
    if (!/^\d{6}$/.test(number)) { issues.push(`${branch.detailsHistory.at(-1)?.details.name}: SSO branch no. must have 6 digits.`); continue; }
    const group = groups.get(number) ?? { sso: [], expectedSso: 0 };
    groups.set(number, group);
    const contribution = money(insured.reduce((n, l) => n + l.amount, 0));
    group.expectedSso = money(group.expectedSso + contribution);
    const profile = staff.find(s => s.id === person.id)?.payrollProfile;
    const title = profile?.ssoTitle ?? "", first = profile?.givenName?.trim() ?? "", surname = profile?.surname?.trim() ?? "";
    // The combined person appears once at the registered branch, with their full uncapped wage.
    const wage = money(calculation.entities.flatMap(e => e.people).filter(p => p.id === person.id)
      .flatMap(p => p.lines).filter(l => l.category === "earning" && l.ssoWage).reduce((n, l) => n + l.amount, 0));
    const problems = [!thaiIdValid(person.taxId) ? "invalid 13-digit ID checksum" : "", !SSO_TITLES.includes(title) ? "missing or invalid title" : "", !first ? "missing given name" : "", wage <= 0 ? "wage is 0" : ""].filter(Boolean);
    if (problems.length) { issues.push(`${person.name}: ${problems.join("; ")} — excluded until fixed.`); continue; }
    const row = [Number(person.taxId), title, first, surname, wage];
    if (insured.length && contribution > 0) group.sso.push([...row, contribution]);
  }
  const date = isoValueDate(result.month, data.companyPayroll?.runs[`${result.entityId}:${result.month}`]?.payDate);
  for (const [number, group] of Array.from(groups.entries())) {
      const rows = group.sso, expected = group.expectedSso;
      const total = money(rows.reduce((n, r) => n + Number(r[5]), 0));
      const filename = `${employer}_${number}_${buddhistDate(date)}.xls`;
      const f = binaryFile("Social security (SSO)", filename, number, STATUTORY_UPLOAD_HEADERS, rows, total, true, { 0: "0000000000000", 4: "0.00", 5: "0.00" });
      f.note = `File contributions ${total.toFixed(2)}; payroll contributions ${expected.toFixed(2)}${total !== expected ? " — fix excluded employees before filing" : " — matched"}`;
      if (total !== expected) issues.push(`${filename}: contributions do not match payroll (${total.toFixed(2)} vs ${expected.toFixed(2)}).`);
      files.push(f);
  }
  return { files, issues };
}
