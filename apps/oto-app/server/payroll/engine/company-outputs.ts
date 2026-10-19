import type { PayrollWorld } from "./model";
import type { CompanyCalculation, CompanyOutputs, CompanyPerson, CompanyResult, CompanySnapshot } from "./company-model";
import { money } from "./company-math";
import { companyUploadFiles } from "./company-upload-files";
import { OWNER_NON_OPERATIONAL_LABEL, payLineExplanation, retainedServiceText } from "./company-pay-explanation";
import type { ServiceDistribution } from "./company-model";

export const BANK_LAYOUT_NOTE = "DEVELOPMENT DEMO ONLY. SCB TXT and XLSX downloads use the supplied Excel Toolkit layout; CSV adapters for other formats are still drafts. These demo files are not certified by a bank. All identities and accounts are fictional. Test one small batch with SCB before the first real run. Confirm other formats against the paying bank’s own upload specification.";
export const htmlEscape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const csv = (rows: unknown[][]) => "\uFEFF" + rows.map(row => row.map(value => {
  const text = String(value ?? "");
  const safe = typeof value === "string" && /^[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}).join(",")).join("\r\n");
const page = (title: string, body: string) => `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><style>
body{font:12px Arial,"Noto Sans Thai",sans-serif;color:#17232c;max-width:760px;margin:24px auto;padding:20px}h1{font-size:20px;margin:0 0 8px}h2{font-size:14px;margin:15px 0 7px}p{line-height:1.5}table{width:100%;border-collapse:collapse}th,td{padding:5px 7px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}.number{text-align:right;white-space:nowrap}.muted,small{font-size:10px;color:#5d6770}.red{color:#a31828;border:1px solid #a31828;padding:8px}.net{font-size:18px;background:#edf5f3;padding:10px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}.signature{height:45px}.note{border-top:1px solid #ccc;padding-top:8px}@media print{body{margin:0;padding:6mm;font-size:10px;max-width:none}.pair{gap:4mm}@page{size:A4;margin:10mm}tr{break-inside:avoid}}
</style><body>${body}</body></html>`;
const amount = (n: number, currency = "THB") => `${n < 0 ? "−" : ""}${currency === "MYR" ? "RM" : "฿"}${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
// Cost-centre names come from the world's `costCentreNames` (our
// `branches.name`) instead of the prototype's hard-coded map (prototype :21);
// an unnamed id prints as itself, the prototype's own fallback.
const place = (id: string, names?: Record<string, string>) =>
  id === "owner-non-operational" ? OWNER_NON_OPERATIONAL_LABEL : names?.[id] ?? id;
export function companyPayslipHtml(person: CompanyPerson, result: CompanyResult, service?: ServiceDistribution[], names?: Record<string, string>): string {
  const labels: Record<string, string> = { salary: "เงินเดือน / Salary", food: "ค่าอาหาร / Food", sc: "ค่าบริการ / Service charge",
    sso: "ประกันสังคม / Employee SSO", pnd1: "ภ.ง.ด.1 / PIT", pnd3: "ภ.ง.ด.3 / Withholding", "student-loan": "กยศ. / Student loan",
    advance: "คืนเงินทดรอง / Advance repayment", ewf: "กองทุนสงเคราะห์ลูกจ้าง / EWF", "cash-fee": "ค่าดำเนินการเงินสด / Cash fee", other: "รายการหักอื่น / Other deductions" };
  const table = (category: "earning" | "deduction" | "employer") => `<table>${person.lines.filter(l => l.category === category && l.amount !== 0).map(l => `<tr><td>${htmlEscape(labels[l.component] ?? l.label)}${l.overridden ? " *" : ""}<br><small>${htmlEscape(payLineExplanation(l, person, service, names))}</small></td><td class="number"${category === "deduction" ? ' style="color:#a05c5c"' : ""}>${amount(category === "deduction" ? -l.amount : l.amount, person.currency)}</td></tr>`).join("")}</table>`;
  const third = person.payments.filter(p => p.method === "third-party");
  const title = `Payslip ${person.name} ${result.month}`;
  return page(title, `<h1>ใบแจ้งเงินเดือน / Payslip</h1><p>${htmlEscape(result.name)} · ${htmlEscape(result.month)}<br><strong>${htmlEscape(person.name)}</strong> · ${htmlEscape(person.jobTitle)}<br>Tax ID: ${htmlEscape(person.taxId || "Missing — review required")} · Registered branch ${htmlEscape(place(person.homeBranchId, names))} · Allocation ${htmlEscape(person.allocationBadge)}</p>
${third.map(p => `<p class="red">Third-party payee / ผู้รับเงินแทน: ${htmlEscape(p.bank.accountName)} — ${htmlEscape(p.reason)}</p>`).join("")}
<div class="pair"><section><h2>รายได้ / Earnings (+)</h2>${table("earning")}<p>Total / รวม ${amount(person.gross, person.currency)}</p></section><section><h2>รายการหัก / Deductions (−)</h2>${table("deduction")}<p style="color:#a05c5c">Total / รวม ${amount(-person.deductions, person.currency)}</p></section></div>
<p class="net">รับสุทธิ / Net pay: <strong>${amount(person.net, person.currency)}</strong></p>
<h2>นายจ้างจ่ายให้ / Employer contributions on your behalf</h2>${table("employer")}<p>Employer contributions ${amount(person.employer, person.currency)}; total employer cost ${amount(person.totalCost, person.currency)}</p>
<h2>ต้นทุนและการจ่าย / Branch cost and payments</h2><table>${person.costs.map(c => `<tr><td>${htmlEscape(place(c.costCentre, names))}</td><td>Gross ${amount(c.gross, person.currency)}</td><td>Net ${amount(c.net, person.currency)}</td></tr>`).join("")}</table>
<table>${person.payments.map(p => `<tr><td>${p.method === "cash" ? "Cash" : p.method === "third-party" ? "Payment to someone else (manual)" : "Bank transfer"}<br><small>${htmlEscape(p.bank.bank)} / ${htmlEscape(p.bank.accountName)} / ${htmlEscape(p.bank.accountNumber)}</small></td><td class="number">${amount(p.amount, person.currency)}</td></tr>`).join("")}</table>
<h2>สะสมปีนี้ / Recorded YTD</h2><p>Gross ${amount(person.ytd.gross, person.currency)} · <span style="color:#a05c5c">deductions ${amount(-person.ytd.deductions, person.currency)}</span> · net ${amount(person.ytd.net, person.currency)}<br><small>Coverage: ${htmlEscape(person.ytd.months.join(", "))}. Only available locked company months plus this payslip; not assumed full-year coverage.</small></p>
<p>${htmlEscape(person.notes)}</p><p class="note muted">Fictional development prototype; not an official tax certificate. Overrides are marked *. One payslip combines all branches for this person/entity. Figures and calculation detail are frozen on lock.</p>`);
}
export function generateCompanyOutputs(data: PayrollWorld, calculation: CompanyCalculation, entityId: string): CompanyOutputs {
  const result = calculation.entities.find(e => e.entityId === entityId);
  if (!result) throw new Error("Unknown paying entity.");
  if (result.payments.some(p => p.amount < 0 || !p.payingAccountId)) throw new Error("Resolve negative payments or missing paying accounts before generating outputs.");
  const month = new Date(`${result.month}-01T00:00:00Z`);
  const reference = `SALARY ${month.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase()}${result.month.slice(2, 4)}`;
  const bankPayments = result.payments.filter(p => p.method === "bank-transfer" && p.amount > 0);
  const banks = Array.from(new Set(bankPayments.map(p => p.payingAccountId))).map(id => {
    const account = data.payingAccounts?.find(a => a.id === id && a.entityId === entityId);
    if (!account) throw new Error(`Missing or wrong-entity paying account ${id}.`);
    const transfers = bankPayments.filter(p => p.payingAccountId === id).sort((a, b) => a.batch.localeCompare(b.batch) || a.person.localeCompare(b.person));
    const header = account.fileFormat === "KBANK" ? ["AccountNo", "Amount", "BeneficiaryName", "Bank", "Reference", "Batch", "ThirdPartyReason"]
      : account.fileFormat === "BBL" ? ["Bank", "AccountNo", "BeneficiaryName", "Amount", "Reference", "Batch", "ThirdPartyReason"]
      : ["BeneficiaryName", "Bank", "AccountNo", "Amount", "Reference", "Batch", "ThirdPartyReason"];
    const rows = transfers.map(p => {
      const fields: Record<string, string> = { BeneficiaryName: p.bank.accountName, Bank: p.bank.bank, AccountNo: p.bank.accountNumber,
        Amount: p.amount.toFixed(2), Reference: reference, Batch: p.batch, ThirdPartyReason: p.method === "third-party" ? p.reason : "" };
      if (!fields.Bank || !fields.AccountNo || !fields.BeneficiaryName || (p.method === "third-party" && !p.reason.trim())) throw new Error(`${p.person}: beneficiary bank/name/account and third-party reason required.`);
      return header.map(h => fields[h]);
    });
    return { account: structuredClone(account), filename: `${entityId}-${result.month}-${account.id}-${account.fileFormat}-DRAFT.csv`,
      csv: csv([header, ...rows]), amount: money(transfers.reduce((s, p) => s + p.amount, 0)), transfers };
  });
  const cash = result.payments.filter(p => p.method !== "bank-transfer" && p.amount > 0);
  const cashAmount = money(cash.reduce((s, p) => s + p.amount, 0)), bankAmount = money(banks.reduce((s, b) => s + b.amount, 0));
  const cashHtml = page(`Cash payroll ${result.month}`, `<h1>เงินสด / Cash and manual payment list</h1><p>${htmlEscape(result.name)} · ${result.month} · ${reference}</p>
<table><thead><tr><th>Employee / พนักงาน</th><th>Payment method / Recipient</th><th>Funding account</th><th>Amount / จำนวนเงิน</th><th>Signature / ลายเซ็น</th><th>Date</th></tr></thead><tbody>${cash.map(p => `<tr${p.method === "third-party" ? ' style="color:#a31828"' : ""}><td>${htmlEscape(p.person)}</td><td>${p.method === "third-party" ? `Payment to someone else (manual)<br>${htmlEscape(p.bank.accountName)} · ${htmlEscape(p.bank.bank)} ${htmlEscape(p.bank.accountNumber)}<br>${htmlEscape(p.reason)}` : "Cash"}</td><td>${htmlEscape(data.payingAccounts?.find(a => a.id === p.payingAccountId)?.label ?? "Not set")}</td><td class="number">${amount(p.amount, result.currency)}</td><td class="signature">________________</td><td>________</td></tr>`).join("")}</tbody></table><h2>Total ${amount(cashAmount, result.currency)}</h2><p class="muted">Fictional demo; no cash or transfer was issued by this application.</p>`);
  const reports: Record<string, string> = {};
  reports["branch-summary.csv"] = csv([["Person", "ID", "Entity", "Cost centre", "Gross", "Deductions", "Net", "Employer", "Total cost"],
    ...result.people.flatMap(p => p.costs.map(c => [p.name, p.id, c.entityId, c.costCentre, c.gross, c.deductions, c.net, c.employer, c.totalCost]))]);
  reports["service-charge.csv"] = csv([["Branch", "Earning month", "Full branch pool", "Total days", "Day rate", "Kept by the company", "Person", "Days / share units", "Paid across funding entities", "Funding entities", "Company-retained share explanation"],
    ...calculation.service.filter(b => data.branches[b.branchId].detailsHistory.at(-1)?.details.payingEntityId === entityId || b.people.some(a => result.people.some(p => p.id === a.staffId)))
      .flatMap(b => b.people.map(a => [data.branches[b.branchId].detailsHistory.at(-1)?.details.name ?? b.branchId, b.earningMonth, b.pool, b.denominator, b.dayRate, b.retained, a.name, a.units, a.amount,
        calculation.entities.filter(e => e.people.some(p => p.id === a.staffId && p.lines.some(l => l.id === `sc:${b.branchId}` && l.amount > 0))).map(e => e.entityId).join(" / "), retainedServiceText(b.retained, result.currency)]))]);
  reports["incentives.csv"] = csv([["Person ID", "Rule", "Paid by this entity", "Calculated across entities before overrides", "Base", "Units", "Target met", "Overridden", "Calculation"],
    ...calculation.incentives.filter(a => result.people.some(p => p.id === a.staffId)).map(a => {
      const lines = result.people.find(p => p.id === a.staffId)!.lines.filter(l => l.component === `incentive:${a.ruleId}`);
      return [a.staffId, a.name, money(lines.reduce((n, l) => n + l.amount, 0)), a.amount, a.base, a.units, a.targetMet,
        lines.some(l => l.overridden), lines.map(l => l.formula).join("; ")];
    })]);
  for (const [key, component] of [["PND1", "pnd1"], ["PND3", "pnd3"], ["SSO", "sso"], ["student-loan", "student-loan"]] as const) {
    // A sister-company funding run may withhold on behalf of the registered employer.
    const registered = key === "SSO" || key === "PND1" || key === "student-loan";
    const people = registered ? calculation.entities.flatMap(e => e.people) : result.people;
    reports[`${key}-remittance.csv`] = csv([["Person", "ID", "Tax ID", "SSO ID", "Registered branch", "Remitting entity", "Paying entity", "Amount", "Employer SSO", "Detail"],
      ...people.flatMap(p => p.lines.filter(l => l.component === component && l.amount > 0 && (!registered || l.remittingEntityId === entityId))
        .map(l => [p.name, p.id, p.taxId, p.ssoNumber, l.registeredBranchId, l.remittingEntityId, p.entityId, l.amount,
          key === "SSO" ? p.components["employer-sso"] ?? 0 : 0, l.formula]))]);
  }
  const payslips = Object.fromEntries(result.people.map(p => [p.id, companyPayslipHtml(p, result, calculation.service, data.costCentreNames)]));
  const outputs: CompanyOutputs = { banks, cashHtml, cashAmount, reports, payslips, net: result.totals.net, bankAmount,
    difference: money(result.totals.net - bankAmount - cashAmount), note: BANK_LAYOUT_NOTE };
  const uploads = companyUploadFiles(data, calculation, result, outputs);
  outputs.downloadFiles = uploads.files; outputs.uploadIssues = uploads.issues;
  outputs.uploadBankAmount = uploads.bankAmount; outputs.uploadDifference = uploads.difference;
  return outputs;
}
// The prototype's browser-only helpers (`downloadCompanyFile`,
// `downloadCompanyPayslipsZip`, `printCompanyHtml`: Blob, object URLs, a
// download link and a print pop-up) stay behind; R5 serves the same bytes
// from private storage and prints payslips with the server's Puppeteer.
