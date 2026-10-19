import type { CompanyDownloadFile, CompanyPayment } from "./company-model";
import type { PayingAccount } from "./payroll-profile";
import { money } from "./company-math";
import { isoValueDate, workbookFile } from "./upload-common";

export const THAI_BANK_CODES: Record<string, string> = { BBL: "002", KBANK: "004", KTB: "006", TTB: "011", SCB: "014", KRUNGSRI: "025", GSB: "030", KKP: "069" };
export function bankCode(bank: { bank: string; bankCode?: string }): string {
  return bank.bankCode || THAI_BANK_CODES[bank.bank.toUpperCase().replace(/\s+/g, "")] || "";
}
export const SCB_TOOLKIT_HEADERS = ["Credit Seq. No.", "Bank Code", "Credit Account Number", "Recipient Name", "Amount", "Customer Transaction Ref.", "Fee Charge", "Branch Code", "Service Type", "SMS Notification", "Email Notification", "Payment Advice Remark"];
const digits = (v: string) => v.replace(/[-\s]/g, "");
const safe = (v: string) => { if (/[|\r\n]/.test(v)) throw Error("SCB text fields cannot contain a pipe or line break."); return v; };

export function scbUploadFiles(account: PayingAccount, transfers: CompanyPayment[], month: string, accountIndex: number): CompanyDownloadFile[] {
  const value = isoValueDate(month, account.valueDate), debit = digits(account.debitAccount || account.accountNumber), fee = digits(account.feeAccount || debit);
  if (!/^\d+$/.test(debit) || !/^\d+$/.test(fee)) throw Error(`${account.label}: debit and fee accounts must contain digits.`);
  const shortMonth = new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase() + month.slice(2, 4);
  const salaryRef = `SALARY ${shortMonth}`, dateDigits = value.replaceAll("-", "");
  const out: CompanyDownloadFile[] = [];
  for (const [index, product] of Array.from((["PAY", "SPN"] as const).entries())) {
    const people = transfers.filter(p => p.method === "bank-transfer" && p.amount > 0 &&
      (account.scbProduct === "SPN" ? product === "SPN" : (bankCode(p.bank) === "014" ? product === "PAY" : product === "SPN")));
    if (!people.length) continue;
    const fileRef = value.slice(8) + value.slice(5, 7) + value.slice(2, 4) + String(accountIndex * 2 + index + 1).padStart(6, "0");
    const batchRef = fileRef, total = money(people.reduce((n, p) => n + p.amount, 0));
    const previewRows: (string | number)[][] = [];
    const transactions = people.map((p, i) => {
      const code = bankCode(p.bank), acct = digits(p.bank.accountNumber), mobile = digits(p.bank.mobile ?? ""), email = p.bank.email?.trim() ?? "";
      if (!/^\d{3}$/.test(code) || !/^\d+$/.test(acct) || !p.bank.accountName.trim()) throw Error(`${p.person}: bank code, credit account and recipient name are required.`);
      if (mobile && !/^\d+$/.test(mobile)) throw Error(`${p.person}: mobile must contain digits.`);
      const ref = `SAL-${shortMonth}-${String(i + 1).padStart(4, "0")}`;
      const fields = ["TXNDET", ref, acct, "", code, product === "PAY" ? "0111" : "", p.amount.toFixed(2),
        product === "PAY" ? "" : "01", "", mobile ? "Y" : "N", mobile, email ? "Y" : "N", email, p.bank.accountName,
        "", "", "", "N", "", "", email ? "Y" : "N", "N", "", "", "", email ? "E" : "N", email, salaryRef];
      previewRows.push([i + 1, code, acct, p.bank.accountName, p.amount, ref, product === "PAY" ? "" : "01", product === "PAY" ? "0111" : "", "", mobile ? "Y" : "N", email ? "Y" : "N", salaryRef]);
      return fields.map(safe).join("|");
    });
    const lines = [`HEADER|${fileRef}|`, `BCHDET|${batchRef}|${product}|${dateDigits}|${debit}|${fee}|${total.toFixed(2)}|${people.length}||`, ...transactions, `TRAILR|1|${people.length}|${total.toFixed(2)}`];
    const filename = `SCB_file_reference_${fileRef}.txt`;
    const preview = { headers: SCB_TOOLKIT_HEADERS, rows: previewRows };
    const note = "Test one small batch with SCB before the first real run";
    out.push({ group: "Bank files", filename, mime: "text/plain", encoding: "utf8", content: lines.join("\r\n") + "\r\n", rows: people.length, total, preview, note });
    const label = product === "PAY" ? "SCB Payroll1" : "SCB Payroll1 - SMART Credit (Next Day)";
    const sheet: (string | number)[][] = [[], ["Customer File Ref", fileRef, "", "Customer Batch Ref", batchRef],
      ["Debit Account", debit, "", "Debit Fee Account", fee], ["Product", label], ["Value Date", `${value.slice(8)}/${value.slice(5, 7)}/${value.slice(0, 4)}`], [], [], SCB_TOOLKIT_HEADERS, ...previewRows];
    const fallback = workbookFile(filename.replace(".txt", ".xlsx"), "Payment", sheet, people.length, total, preview);
    fallback.note = "Excel Toolkit fallback for the same batch — do not upload both files. " + note;
    out.push(fallback);
  }
  return out;
}
