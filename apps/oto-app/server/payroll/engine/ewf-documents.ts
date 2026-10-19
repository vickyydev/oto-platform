import type { StatutoryOffer } from "./model";
import { asNumber, asRow, escapeHtml, frozenValues, money, type FrozenMonth } from "./statutory-shared";

const EWF_ESERVICE = "https://eservice.labour.go.th/";
const thEn = (thai: string, english: string) => `${thai} / ${english}`;
const dateOffset = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(value.valueOf())) return date;
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const nextMonth15 = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 15)).toISOString().slice(0, 10);
};

export interface EwfLateEstimate {
  dueDate: string;
  asOfDate: string;
  unpaidPrincipal: number;
  chargeableMonths: number;
  surcharge: number;
}

/** Simple 5% of principal for every full month late, plus a month at a 15-day remainder. */
export function calculateEwfSurcharge(dueDate: string, asOfDate: string, unpaidPrincipal: number): EwfLateEstimate {
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!validDate(dueDate) || !validDate(asOfDate)) {
    throw new Error("Enter valid due and as-of dates in YYYY-MM-DD format.");
  }
  if (!Number.isFinite(unpaidPrincipal) || unpaidPrincipal < 0) throw new Error("Unpaid principal must be a non-negative amount.");
  const due = new Date(`${dueDate}T00:00:00.000Z`);
  const asOf = new Date(`${asOfDate}T00:00:00.000Z`);
  if (asOf <= due) return { dueDate, asOfDate, unpaidPrincipal, chargeableMonths: 0, surcharge: 0 };
  const dueDay = due.getUTCDate();
  const monthAnniversary = (offset: number) => {
    const monthStart = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + offset, 1));
    const finalDay = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)).getUTCDate();
    monthStart.setUTCDate(Math.min(dueDay, finalDay));
    return monthStart;
  };
  let fullMonths = 0;
  while (monthAnniversary(fullMonths + 1) <= asOf) fullMonths += 1;
  const remainingDays = Math.floor((asOf.valueOf() - monthAnniversary(fullMonths).valueOf()) / 86_400_000);
  const chargeableMonths = fullMonths + (remainingDays >= 15 ? 1 : 0);
  const surcharge = Math.round(unpaidPrincipal * 0.05 * chargeableMonths * 100) / 100;
  return { dueDate, asOfDate, unpaidPrincipal, chargeableMonths, surcharge };
}

export function calculateEwfSurchargeEstimate(dueDate: string | null | undefined, asOfDate: string, unpaidPrincipal: number | null): EwfLateEstimate | null {
  if (!dueDate || unpaidPrincipal === null) return null;
  return calculateEwfSurcharge(dueDate, asOfDate, unpaidPrincipal);
}

function rowValues(month: FrozenMonth, staffId?: string) {
  const rows = month.rows.filter((person) => !staffId || person.staff.id === staffId);
  return rows.map((person) => {
    const values = frozenValues(person);
    const employee = asRow(values.employee);
    const employer = asRow(values.employer);
    return {
      person,
      employee: asNumber(employee.ewf, `frozen EWF employee contribution for ${person.staff.name}`),
      employer: asNumber(employer.ewf, `frozen EWF employer contribution for ${person.staff.name}`),
    };
  });
}

export function renderEwfDocument(offer: StatutoryOffer, months: FrozenMonth[]) {
  const source = months[0]?.snapshot;
  if (!source) throw new Error("EWF prototype requires a latest approved locked Thai payroll snapshot.");
  if (source.details.country !== "TH" || source.details.currency !== "THB" || source.month < "2026-10") {
    throw new Error("EWF documents are available only for locked Thai snapshots from October 2026 onward.");
  }
  const personnel = rowValues(months[0], offer.staffId);
  if (!personnel.length) throw new Error(`No frozen EWF calculation row exists for ${offer.staffId ?? "this source"}.`);
  const columns = `<style>
  *{box-sizing:border-box}body{font:14px/1.55 Tahoma,"Noto Sans Thai",sans-serif;color:#20302a;margin:0;padding:24px}
  main{max-width:980px;margin:auto;border:1px solid #83938a;padding:26px}h1{font-size:22px;margin:0}
  h2{font-size:16px;border-bottom:1px solid #aab6ae;padding-bottom:7px;margin-top:26px}
  table{border-collapse:collapse;width:100%;margin:15px 0}th,td{border:1px solid #8c9d92;padding:8px;text-align:left}
  th{background:#eff4ef}.watermark{border:2px solid #a32e2e;color:#a32e2e;padding:10px;font-weight:bold;text-align:center}
  .fine{font-size:12px;color:#526158}.identity{background:#f4f7f3;padding:12px}.warning{background:#fff5dd;padding:10px}
  @media print{body{padding:0}.watermark{print-color-adjust:exact}}
  </style>`;
  const header = `<p class="watermark">ต้นแบบเท่านั้น · ไม่ใช่แบบทางการ · NOT FOR FILING</p>
    <p><b>${thEn("เอกสารต้นแบบ", "Prototype document")}:</b> ${escapeHtml(offer.title)} · ${escapeHtml(offer.period)}</p>
    <div class="identity"><b>${thEn("นิติบุคคล", "Legal entity")}:</b> ${escapeHtml(source.details.legalEntity)}<br>
    <b>${thEn("สถานประกอบการ", "Establishment")}:</b> ${escapeHtml(source.details.name)}<br>
    <b>${thEn("ที่อยู่", "Address")}:</b> ${escapeHtml(source.details.address)}<br>
    <b>${thEn("แหล่งข้อมูล", "Frozen source")}:</b> ${escapeHtml(source.branchId)} · ${escapeHtml(source.month)} v${source.version} · locked ${escapeHtml(source.lockedAt)} by ${escapeHtml(source.lockedBy)}</div>`;
  const table = (heads: string[], rows: string[][]) =>
    `<table><thead><tr>${heads.map((head) => `<th>${escapeHtml(head)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) =>
      `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const sumEmployee = personnel.reduce((sum, row) => sum + row.employee, 0);
  const sumEmployer = personnel.reduce((sum, row) => sum + row.employer, 0);
  let body = "";
  if (offer.code === "EWF3") {
    body = `<h2>สกล.3 · รายการนำส่งเงินสมทบรายเดือน / Monthly contribution list</h2>
      <p>กำหนดนำส่ง ${escapeHtml(offer.dueDate)} · Due on the 15th of the following month. Filing may be at head office or the relevant branch-area office.</p>
      ${table(["รหัสพนักงาน / Employee no.", "ชื่อ / Employee", "เงินสมทบลูกจ้าง / Employee", "เงินสมทบนายจ้าง / Employer"],
        personnel.map(({ person, employee, employer }) => [person.staff.employeeNumber, person.staff.name, money(employee, "THB"), money(employer, "THB")]))}
      <p><b>รวม / Total:</b> ${money(sumEmployee, "THB")} employee + ${money(sumEmployer, "THB")} employer</p>`;
  } else if (offer.code === "EWF3-1") {
    body = `<h2>สกล.3/1 · ข้อมูลเพื่อประกอบการพิจารณาโดยสมัครใจ / Voluntary-only information</h2>
      <p class="warning">Not a compulsory deduction. No contribution is automatically calculated, withheld, or remitted for a below-threshold entity.</p>
      ${table(["รหัสพนักงาน / Employee no.", "ชื่อ / Employee", "สถานะ / Status"], personnel.map(({ person }) =>
        [person.staff.employeeNumber, person.staff.name, "Informational only · no automatic deduction"]))}`;
  } else if (offer.code === "EWF3-2") {
    const entityHeadcount = offer.warnings.find((warning) => warning.startsWith("Frozen legal-entity headcount:"))
      ?.replace("Frozen legal-entity headcount:", "").trim() ??
      String(source.staff.filter((person) => person.joinedOn <= `${source.month}-31` && (!person.leftOn || person.leftOn >= `${source.month}-01`)).length);
    body = `<h2>สกล.3/2 · แจ้งเปลี่ยนแปลงข้อมูล / Entity change notification</h2>
      <p>Suggested filing due ${escapeHtml(offer.dueDate)} following an effective entity name, address, or headcount change.</p>
      <p class="warning">SSO filings may count as notification; check requirements. This prototype never submits or marks this notice filed automatically.</p>
      ${table(["รายการ / Field", "ข้อมูล ณ แหล่งที่ล็อก / Frozen value"], [
        ["Entity name / นิติบุคคล", source.details.legalEntity], ["Address / ที่อยู่", source.details.address],
        ["Headcount / จำนวนลูกจ้าง", entityHeadcount],
      ])}`;
  } else if (offer.code === "EWF5") {
    const person = personnel[0].person;
    const beneficiary = person.staff.ewfMembership?.beneficiaryMeta;
    body = `<h2>สกล.5 · สถานะผู้รับประโยชน์ / Beneficiary status</h2>
      ${table(["Employee / พนักงาน", "Beneficiary form status / สถานะเอกสาร", "Recorded date / วันที่"], [
        [person.staff.name, beneficiary ? `Recorded prototype metadata: ${beneficiary.fileName}` : "Missing · follow up required", beneficiary?.date ?? "—"],
      ])}<p class="warning">Metadata only. No actual uploaded form, beneficiary details, or official PDF is stored or reproduced.</p>`;
  } else if (offer.code === "EWF-TERM") {
    const person = personnel[0].person;
    const recordedOffboardingDate = offer.warnings.find((warning) => warning.startsWith("Recorded offboarding last working date:"))
      ?.replace("Recorded offboarding last working date:", "").replace(/\.$/, "").trim();
    const lastDay = recordedOffboardingDate || person.staff.leftOn;
    if (!lastDay) throw new Error("Termination confirmation requires a frozen last working day.");
    body = `<h2>หนังสือยืนยันการสิ้นสุดการจ้าง · Termination confirmation prototype</h2>
      <p>Employee: ${escapeHtml(person.staff.name)} · Last working day: ${escapeHtml(lastDay)} · Confirmation due: ${escapeHtml(offer.dueDate)} (30 days after last working day).</p>
      <p class="warning">The final EWF contribution remains due regardless of departure reason. Confirm final remittance and termination confirmation; this letter is not filing-ready.</p>`;
  } else {
    throw new Error(`Unsupported EWF prototype document ${offer.code}.`);
  }
  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${escapeHtml(offer.title)}</title>${columns}</head><body><main><h1>กองทุนสงเคราะห์ลูกจ้าง / Employee Welfare Fund</h1>${header}${body}
    <h2>การยื่นแบบ / Filing information</h2><p>ต้นแบบนี้ไม่ใช่เอกสารทางการและไม่สามารถยื่นได้ / Prototype only; not for filing. Head-office or branch-area filing may be available. <a href="${EWF_ESERVICE}">${EWF_ESERVICE}</a></p>
    <p class="fine">Illustrative only, not legal advice. Source rule overview: Labour Protection Act B.E. 2541 chapter 13, 2025 Royal Decree and Ministerial Regulation. No official form asset, upload, or submission is provided.</p></main></body></html>`;
  return { html, upload: `NOT FOR FILING — prototype placeholder only.\r\n${offer.code} · ${offer.period} · due ${offer.dueDate}\r\nSource: ${source.branchId} ${source.month} v${source.version}\r\nNo official PDF or filing payload is included.`,
    uploadName: `${offer.code}-NOT-FOR-FILING.txt`, uploadMime: "text/plain;charset=utf-8", warnings: ["Prototype-only EWF document. Never file this output; no official PDF or submission is included."] };
}

export function ewfNextMonth15(period: string) {
  return nextMonth15(period);
}
export function ewfTerminationDue(lastWorkingDay: string) {
  return dateOffset(lastWorkingDay, 30);
}