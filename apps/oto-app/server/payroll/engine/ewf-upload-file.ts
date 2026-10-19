import * as XLSX from "xlsx";
import type { PayrollWorld } from "./model";
import type { CompanyCalculation, CompanyDownloadFile, CompanyPerson, CompanyResult, CompanySnapshot } from "./company-model";
import { isoValueDate, thaiIdValid } from "./upload-common";
import { money } from "./company-math";

export const EWF_UPLOAD_HEADERS = ["คำนำหน้า", "ชื่อ", "ชื่อสกุล", "อายุ", "สัญชาติ", "เลขบัตรประชาชน/เลขหนังสือเดินทาง", "ประเภทค่าจ้าง", "ค่าจ้าง (บาท)", "วันที่เริ่มงาน", "วันที่สิ้นสุดงาน", "สาเหตุการออกจากงาน/หมายเหตุอื่นๆ"];
const THAI_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
type FilingDetails = NonNullable<CompanyPerson["ewfFiling"]>;
const validDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const monthEnd = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0));
export function ageAtMonthEnd(birth: string, month: string): number {
  const dob = new Date(`${birth}T00:00:00Z`), end = monthEnd(month);
  return end.getUTCFullYear() - dob.getUTCFullYear() - (end.getUTCMonth() < dob.getUTCMonth() || (end.getUTCMonth() === dob.getUTCMonth() && end.getUTCDate() < dob.getUTCDate()) ? 1 : 0);
}
export function ewfFilingIssues(details: FilingDetails, taxId: string, joinedOn: string, lastDay: string | null, month: string): string[] {
  const issues: string[] = [];
  if (!validDate(details.dateOfBirth) || details.dateOfBirth! > monthEnd(month).toISOString().slice(0, 10)) issues.push("missing or invalid date of birth");
  if (!details.nationality?.trim()) issues.push("missing nationality");
  if (taxId.trim() ? !thaiIdValid(taxId.trim()) : !details.passportNumber?.trim()) issues.push("missing or invalid Thai ID / passport number");
  if (!details.title?.trim()) issues.push("missing title");
  if (!details.givenName?.trim()) issues.push("missing given name");
  if (!validDate(joinedOn)) issues.push("missing or invalid employment start date");
  if (lastDay && (!validDate(lastDay) || lastDay < joinedOn)) issues.push("invalid employment end date");
  if (lastDay?.startsWith(month) && !details.leavingReason?.trim()) issues.push("missing leaving reason");
  return issues;
}
const excelDate = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
const displayDate = (iso: string) => `${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Official establishment workbook. Contributions are preview-only, not worksheet columns. */
export function ewfUploadFile(data: PayrollWorld, calculation: CompanyCalculation, result: CompanyResult): { files: CompanyDownloadFile[]; issues: string[] } {
  const entity = data.payingEntities?.find(e => e.id === result.entityId);
  if (entity?.country !== "TH") return { files: [], issues: [] };
  const date = isoValueDate(result.month, data.companyPayroll?.runs[`${result.entityId}:${result.month}`]?.payDate);
  const year = Number(result.month.slice(0, 4)) + 543, m = Number(result.month.slice(5)), issues: string[] = [];
  const rows: (string | number)[][] = [], previewRows: (string | number)[][] = [];
  const profiles = Object.values(data.branches).flatMap(b => b.staff);
  let employee = 0, employer = 0, expected = 0, wageTotal = 0;
  const seen = new Set<string>();
  for (const person of result.people) {
    const own = person.lines.filter(l => (l.remittingEntityId ?? person.entityId) === result.entityId);
    const contribution = money(own.filter(l => l.component === "ewf").reduce((n, l) => n + l.amount, 0));
    const companyShare = money(own.filter(l => l.component === "employer-ewf").reduce((n, l) => n + l.amount, 0));
    if ((!contribution && !companyShare) || seen.has(person.id)) continue;
    seen.add(person.id); expected = money(expected + contribution);
    const p = profiles.find(s => s.id === person.id)?.payrollProfile;
    const details = person.ewfFiling ?? { dateOfBirth: p?.dateOfBirth, nationality: p?.nationality, passportNumber: p?.passportNumber, leavingReason: p?.leavingReason, title: p?.ssoTitle, givenName: p?.givenName, surname: p?.surname };
    const errors = ewfFilingIssues(details, person.taxId, person.joinedOn, person.lastWorkingDay, result.month);
    const earningLines = calculation.entities.flatMap(e => e.people).filter(p => p.id === person.id).flatMap(p => p.lines).filter(l => l.category === "earning" && (l.component === "salary" || l.component.startsWith("fixed:")));
    // The filing always uses actual month days, even where an explicit payroll ÷30 setting remains.
    const prorated = person.joinedOn.startsWith(result.month) || !!person.lastWorkingDay?.startsWith(result.month);
    const wage = money(earningLines.reduce((n, l) => n + l.amount * (l.component === "salary" && person.workerType !== "day-rate" && prorated && !l.overridden ? (person.prorationDivisor ?? monthEnd(result.month).getUTCDate()) / monthEnd(result.month).getUTCDate() : 1), 0));
    if (wage <= 0) errors.push("wage is 0");
    if (errors.length) { issues.push(`${person.name}: EWF filing: ${errors.join("; ")} — excluded until fixed.`); continue; }
    const left = person.lastWorkingDay?.startsWith(result.month) ? person.lastWorkingDay : "";
    const row = [details.title!.trim(), details.givenName!.trim(), details.surname?.trim() ?? "", ageAtMonthEnd(details.dateOfBirth!, result.month), details.nationality!.trim(), person.taxId.trim() || details.passportNumber!.trim(), person.workerType === "day-rate" ? "รายวัน" : "รายเดือน", wage, excelDate(person.joinedOn), left ? excelDate(left) : "", left ? details.leavingReason!.trim() : ""];
    rows.push(row);
    previewRows.push([...row.slice(0, 8), displayDate(person.joinedOn), left ? displayDate(left) : "", row[10]]);
    employee = money(employee + contribution); employer = money(employer + companyShare); wageTotal = money(wageTotal + wage);
  }
  const ws = XLSX.utils.aoa_to_sheet([
    ["ชื่อสถานประกอบกิจการ", entity.name],
    ["รอบการส่งเงิน ปี พ.ศ.", year, "เดือน", THAI_MONTHS[m - 1]],
    ["วันที่ดำเนินการนำส่ง", `${date.slice(8)}/${date.slice(5, 7)}/${Number(date.slice(0, 4)) + 543}`],
    EWF_UPLOAD_HEADERS, ...rows,
  ]);
  ws["!merges"] = [XLSX.utils.decode_range("B1:H1")];
  rows.forEach((row, r) => row.forEach((v, c) => {
    const key = XLSX.utils.encode_cell({ r: r + 4, c });
    ws[key] = { t: [3, 7, 8, 9].includes(c) && v !== "" ? "n" : "s", v, z: c === 3 ? "#,##0" : c === 7 ? "#,##0.00" : c === 8 || c === 9 ? "dd/mm/yyyy" : "@" };
  }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const filename = `EWF_${entity.id.toUpperCase()}_${year}${String(m).padStart(2, "0")}.xlsx`;
  if (employee !== expected) issues.push(`${filename}: contributions do not match payroll — fix excluded employees before filing.`);
  const file: CompanyDownloadFile = { group: "Welfare fund (EWF)", filename, encoding: "base64", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    content: XLSX.write(wb, { type: "base64", bookType: "xlsx" }), rows: rows.length, total: employee, preview: { headers: EWF_UPLOAD_HEADERS, rows: previewRows },
    note: `Official EWF upload layout · ${entity.name} · Employee contribution ฿${employee.toLocaleString("en-US", { minimumFractionDigits: 2 })} · Employer contribution (company cost) ฿${employer.toLocaleString("en-US", { minimumFractionDigits: 2 })} · Wage total ฿${wageTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}. Wages use actual calendar days; contribution totals are from payroll. The fund calculates contributions; the workbook has no contribution column.${issues.length ? " Fix excluded employees before filing." : ""}` };
  return { files: [file], issues };
}

/** Replace only the old downloadable layout, never the stored run or financial results. */
export function withOfficialEwfDownloads(data: PayrollWorld, snapshot: CompanySnapshot): CompanySnapshot {
  const old = snapshot.outputs.downloadFiles;
  if (!old?.some(f => f.group === "Welfare fund (EWF)" && f.filename.endsWith(".xls"))) return snapshot;
  const official = ewfUploadFile(data, snapshot.calculation, snapshot.result);
  return { ...snapshot, outputs: { ...snapshot.outputs,
    downloadFiles: [...old.filter(f => f.group !== "Welfare fund (EWF)"), ...official.files],
    uploadIssues: [...(snapshot.outputs.uploadIssues ?? []).filter(s => !/_EWF\.xls|provisional/i.test(s)), ...official.issues] } };
}
