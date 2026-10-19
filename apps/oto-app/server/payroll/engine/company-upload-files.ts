import * as XLSX from "xlsx";
import { strToU8, zipSync } from "fflate";
import type { CompanyCalculation, CompanyDownloadFile, CompanyOutputs, CompanyResult, CompanySnapshot } from "./company-model";
import type { PayrollWorld } from "./model";
import { scbUploadFiles } from "./scb-upload-files";
import { statutoryUploadFiles } from "./statutory-upload-files";
import { money } from "./company-math";

export function uploadFileBytes(f: CompanyDownloadFile): Uint8Array {
  return f.encoding === "base64" ? Uint8Array.from(atob(f.content), c => c.charCodeAt(0)) : strToU8(f.content);
}
function base64(bytes: Uint8Array): string {
  let text = ""; for (const byte of Array.from(bytes)) text += String.fromCharCode(byte);
  return btoa(text);
}
function csvPreview(csv: string) {
  const wb = XLSX.read(csv, { type: "string", raw: true });
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
  return { headers: (rows.shift() ?? []).map(String), rows };
}
export function companyUploadFiles(data: PayrollWorld, calculation: CompanyCalculation, result: CompanyResult, outputs: CompanyOutputs) {
  const files: CompanyDownloadFile[] = [];
  const bankIssues: string[] = [];
  outputs.banks.forEach((b, i) => {
    if (b.account.fileFormat === "SCB") {
      try { files.push(...scbUploadFiles({ ...b.account, valueDate: b.account.valueDate || data.companyPayroll?.runs[`${result.entityId}:${result.month}`]?.payDate }, b.transfers, result.month, i + ((data.companyPayroll?.runs[`${result.entityId}:${result.month}`]?.version ?? 1) - 1) * 50)); }
      catch (e) { bankIssues.push(`${b.account.label}: ${e instanceof Error ? e.message : "Invalid upload details"} — bank files excluded until fixed.`); }
    }
    else files.push({ group: "Bank files", filename: b.filename, mime: "text/csv", encoding: "utf8", content: b.csv, rows: b.transfers.length, total: b.amount, preview: csvPreview(b.csv), note: "Confirm the upload layout with the bank before real use." });
  });
  const statutory = statutoryUploadFiles(data, calculation, result);
  files.push(...statutory.files);
  const base = `${result.entityId}-${result.month}`;
  for (const [name, content] of Object.entries(outputs.reports)) {
    if (/SSO|ewf/i.test(name)) continue; // The real proposed spreadsheets replace duplicate CSV remittance files.
    const preview = csvPreview(content);
    files.push({ group: /^PND\.?[13]/i.test(name) ? "Tax (PND.1/PND.3)" : "Reports",
      filename: `${base}-${name}`, mime: "text/csv", encoding: "utf8", content, rows: preview.rows.length,
      total: /^PND\.?1/i.test(name) ? result.people.reduce((n, p) => n + (p.components.pnd1 ?? 0), 0) : /^PND\.?3/i.test(name) ? result.people.reduce((n, p) => n + p.lines.filter(l => l.component.startsWith("pnd3")).reduce((s, l) => s + l.amount, 0), 0) : 0, preview });
  }
  files.push({ group: "Reports", filename: `${base}-cash-signature-list.html`, mime: "text/html", encoding: "utf8", content: outputs.cashHtml,
    rows: result.payments.filter(p => p.method !== "bank-transfer" && p.amount > 0).length, total: outputs.cashAmount,
    preview: { headers: ["Person", "Method", "Recipient", "Amount", "Reason", "Signature"], rows: result.payments.filter(p => p.method !== "bank-transfer" && p.amount > 0).map(p => [p.person, p.method === "cash" ? "Cash" : "Payment to someone else", p.bank.accountName, p.amount, p.reason, "________________"]) } });
  const slips = Object.fromEntries(Object.entries(outputs.payslips).map(([id, html]) => [`${base}-${id}-payslip.html`, strToU8(html)]));
  files.push({ group: "Payslips", filename: `${base}-payslips.zip`, mime: "application/zip", encoding: "base64", content: base64(zipSync(slips)),
    rows: result.people.length, total: result.totals.net, preview: { headers: ["Person", "Net (take-home)"], rows: result.people.map(p => [p.name, p.net]) } });
  for (const p of result.people) files.push({ group: "Payslips", filename: `${base}-${p.id}-payslip.html`, mime: "text/html", encoding: "utf8",
    content: outputs.payslips[p.id], rows: 1, total: p.net,
    preview: { headers: ["Pay component", "Type", "Amount"], rows: p.lines.map(l => [l.label, l.category === "employer" ? "Company cost" : l.category === "deduction" ? "Deducted from pay" : "Earnings", l.category === "deduction" ? -l.amount : l.amount]) } });
  const bankAmount = money(files.filter(f => f.group === "Bank files" && !f.filename.endsWith(".xlsx")).reduce((n, f) => n + f.total, 0));
  return { files, issues: [...bankIssues, ...statutory.issues], bankAmount, difference: money(outputs.net - bankAmount - outputs.cashAmount) };
}
// The prototype's browser-only `saveBytes` / `downloadPayrollUpload` /
// `downloadAllPayrollUploads` (Blob, object URL, a download link) stay behind;
// the bytes come from `uploadFileBytes` and `payrollUploadsZip`.
export function payrollUploadsZip(snapshot: CompanySnapshot): Uint8Array {
  const files = Object.fromEntries((snapshot.outputs.downloadFiles ?? []).map(f => [f.filename, uploadFileBytes(f)]));
  files["README.txt"] = strToU8("Fictional development payroll. Test one small batch with SCB before the first real run. Each SCB TXT and its XLSX fallback are the SAME batch: upload only one. EWF uses the official establishment workbook layout, one file per legal entity. Cash list includes manual payments to someone else. No payments or filings are sent by this app.");
  return zipSync(files);
}
