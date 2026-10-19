import type { StatutoryOffer } from "./model";
import {
  asRow, asText, asNumber, asArray, demoIdentifier, escapeHtml, frozenValues, money, statutoryIdentifier,
  roundPerson, type FrozenMonth, type FrozenPersonRow,
} from "./statutory-shared";

export interface StatutoryRender {
  html: string;
  upload: string;
  uploadName: string;
  uploadMime: string;
  warnings: string[];
}

const RD_V2 = "https://www.rd.go.th/63724.html";
const SSO_REFERENCE = "https://www.sso.go.th/wpr/assets/upload/files_storage/sso_th/918a5ffc639945c7890f199112922f09.pdf";
const PND1_REFERENCE = "https://www.rd.go.th/fileadmin/tax_pdf/withhold/200360_WHT1.pdf";
const th = (label: string, english: string) => `${label} / ${english}`;
const records = (months: FrozenMonth[]) => months.flatMap((month) => month.rows);
const staffById = (people: FrozenPersonRow[]) => {
  const map = new Map<string, FrozenPersonRow>();
  people.forEach((person) => map.set(person.staff.id, person));
  return Array.from(map.values());
};

function rowMarkup(headers: string[], rows: unknown[][]) {
  return `<table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${
    rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")
  }</tbody></table>`;
}
type Pnd1Employee = { person: FrozenPersonRow; gross: number; tax: number };
function sourceAnchorId(snapshot: FrozenMonth["snapshot"]) {
  return `frozen-${snapshot.branchId}-${snapshot.month}-v${snapshot.version}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}
function pnd1FormPages(
  offer: StatutoryOffer, months: FrozenMonth[], selected: Pnd1Employee[], warnings: string[],
  provisional: boolean, coverageText: string,
) {
  const employer = months[0]?.snapshot.details;
  if (!employer) throw new Error("PND.1 requires frozen employer identity.");
  const taxId = employer.taxId;
  const digits = Array.from(taxId).filter((character) => /\d/.test(character));
  const digitCells = Array.from({ length: Math.max(13, digits.length) }, (_, index) =>
    `<span class="tax-digit">${escapeHtml(digits[index] ?? "")}</span>`).join("");
  const monthNumber = Number(offer.period.slice(5, 7));
  const monthLabels = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const monthGrid = monthLabels.map((label, index) =>
    `<div class="month-cell${index + 1 === monthNumber ? " active" : ""}">${label}</div>`).join("");
  const totalGross = selected.reduce((sum, entry) => sum + entry.gross, 0);
  const totalTax = selected.reduce((sum, entry) => sum + entry.tax, 0);
  const warningMarkup = warnings.length
    ? `<ul class="warnings">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
    : "";
  const pageWatermark = `<p class="prototype-watermark">PROTOTYPE ONLY · NOT AN OFFICIAL FORM · NOT FOR FILING${provisional ? " · PROVISIONAL" : ""}</p>`;
  const detailRows = selected.map(({ person, gross, tax }) => {
    const snapshot = person.snapshot;
    const anchor = sourceAnchorId(snapshot);
    return `<tr><td>${escapeHtml(person.staff.employeeNumber)}</td><td>${escapeHtml(person.staff.name)}</td>
      <td>${escapeHtml(demoIdentifier(person.staff, "TH", "tax"))}</td>
      <td class="num">${escapeHtml(money(gross, "THB"))}</td><td class="num">${escapeHtml(money(tax, "THB"))}</td>
      <td><a class="frozen-link" href="#${escapeHtml(anchor)}">${escapeHtml(snapshot.month)} v${snapshot.version}</a></td></tr>`;
  }).join("");
  const sources = new Map<string, FrozenMonth["snapshot"]>();
  selected.forEach(({ person }) => sources.set(sourceAnchorId(person.snapshot), person.snapshot));
  const sourceRows = Array.from(sources.entries()).map(([anchor, snapshot]) =>
    `<li id="${escapeHtml(anchor)}"><b>Frozen source:</b> ${escapeHtml(snapshot.branchId)} ${escapeHtml(snapshot.month)} v${snapshot.version};
       locked ${escapeHtml(snapshot.lockedAt)} by ${escapeHtml(snapshot.lockedBy)}; calculation currency ${escapeHtml(snapshot.details.currency)}.</li>`).join("");

  return `<section class="pnd1-page">
    ${pageWatermark}${warningMarkup}
    <header class="pnd1-header"><div><div class="agency-title">กรมสรรพากร</div>
      <div class="agency-subtitle">แบบแสดงรายการภาษีเงินได้หัก ณ ที่จ่าย · รายเดือน</div>
      <div class="agency-subtitle">Thai Revenue Department style · Monthly withholding-tax return · Reference layout only</div></div>
      <div class="form-code">ภ.ง.ด.1<small>PND.1 · Prototype</small></div></header>
    <div class="section-title">ข้อมูลผู้มีหน้าที่หักภาษี ณ ที่จ่าย / Withholding employer details</div>
    <div class="identity-grid">
      <div class="identity-field"><span class="field-label">เลขประจำตัวผู้เสียภาษีอากร / Employer tax ID — frozen source characters</span>
        <div class="tax-digits">${digitCells}</div><div class="source-tax">Frozen source text: ${escapeHtml(taxId)} · Only digits present in the frozen value are shown; no missing digits are supplied.</div></div>
      <div class="identity-field"><span class="field-label">ชื่อนิติบุคคล / Entity</span><span class="field-value">${escapeHtml(employer.legalEntity)}</span></div>
      <div class="identity-field"><span class="field-label">ชื่อสถานประกอบการ / Establishment</span><span class="field-value">${escapeHtml(employer.name)}</span></div>
      <div class="identity-field"><span class="field-label">ที่อยู่ / Address</span><span class="field-value">${escapeHtml(employer.address)}</span></div>
    </div>
    <div class="section-title">เดือนภาษี / Filing month</div>
    <div class="month-key">ปีภาษี / Tax year: <b>${escapeHtml(offer.period.slice(0, 4))}</b> · เลือกเดือนที่มีเครื่องหมายกรอบ / Selected month is outlined</div>
    <div class="month-grid">${monthGrid}</div>
    <div class="section-title">สรุปเงินได้และภาษีหัก ณ ที่จ่าย / Frozen payroll summary</div>
    <table class="pnd1-grid"><thead><tr><th>รายการเงินได้ / Income category</th><th>จำนวนผู้มีเงินได้ / Employees</th>
      <th>จำนวนเงิน / Income</th><th>ภาษีที่หัก / Withholding</th></tr></thead><tbody>
      <tr><td>ยอดรวมจาก payroll แช่แข็ง — ไม่ระบุประเภทเงินได้ในข้อมูลต้นทาง<br><span class="not-supplied">Frozen payroll total — income category not supplied</span></td>
        <td class="num">${selected.length}</td><td class="num">${escapeHtml(money(totalGross, "THB"))}</td><td class="num">${escapeHtml(money(totalTax, "THB"))}</td></tr>
      <tr class="not-supplied"><td>ประเภทเงินได้เฉพาะตามแบบ / Specific income category</td><td colspan="3">ไม่ระบุในข้อมูลแช่แข็ง / Not supplied — left unfilled</td></tr>
    </tbody></table>
    <p class="attachment-note">Coverage: ${escapeHtml(coverageText)}. Category-specific amounts are not inferred from gross pay.</p>
    <div class="declaration"><b>คำรับรอง / Declaration</b><br>
      ข้าพเจ้าขอรับรองว่ารายการนี้จัดทำจากข้อมูลเงินเดือนที่แช่แข็งไว้เพื่อการตรวจสอบต้นแบบเท่านั้น
      / Prototype declaration placeholder: frozen payroll data only; verify and complete official requirements before any filing.</div>
    <div class="signature-grid"><div>ลงชื่อผู้มีอำนาจ / Authorized signature<div class="signature-line"></div>ชื่อและตำแหน่ง / Name and title<div class="signature-line"></div></div>
      <div>วันที่ / Date<div class="signature-line"></div>ผู้จัดทำ / Prepared by<div class="signature-line"></div></div></div>
  </section>
  <section class="pnd1-attachment">
    ${pageWatermark}
    <header class="attachment-heading"><h2>ใบแนบ ภ.ง.ด.1</h2><div class="attachment-meta">PND.1 attachment · รายละเอียดผู้มีเงินได้จากข้อมูลแช่แข็ง / Frozen employee detail</div>
      <div class="attachment-meta">เดือนภาษี / Filing month: ${escapeHtml(offer.period)} · Entity: ${escapeHtml(employer.legalEntity)}</div></header>
    <table class="pnd1-grid"><thead><tr><th>ลำดับ</th><th>รหัสพนักงาน</th><th>ชื่อผู้มีเงินได้</th><th>เลขประจำตัวผู้เสียภาษี<br><span class="not-supplied">(fictional demo ID)</span></th>
      <th>เงินได้รวม</th><th>ภาษีหัก ณ ที่จ่าย</th><th>Frozen source</th></tr></thead><tbody>${detailRows}</tbody></table>
    <p class="attachment-note">Per-person values come from frozen calculation rows. Frozen source links open the source snapshot identity below; tax-category allocation is not supplied.</p>
    <div class="section-title">แหล่งข้อมูลที่แช่แข็ง / Frozen source links</div><ul class="source-list">${sourceRows}</ul>
    <p class="fine">Browser-only prototype from frozen payroll snapshots. Not an official Revenue Department form and not suitable for filing. Reference layout only:
      <a href="${PND1_REFERENCE}">Revenue Department PND.1 reference</a>. No official PDF or logo is embedded.</p>
  </section>`;
}
function html(title: string, subtitle: string, body: string, provisional: boolean, warnings: string[]) {
  const warningMarkup = warnings.length ? `<ul class="warnings">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : "";
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
  *{box-sizing:border-box}body{font:14px/1.5 Tahoma,"Noto Sans Thai",sans-serif;color:#202820;margin:0;padding:28px;background:#fff}
  main{max-width:1000px;margin:auto;border:1px solid #88958a;padding:28px;position:relative;overflow:hidden}h1{font-size:22px;margin:0 0 5px}
  h2{font-size:16px;border-bottom:1px solid #89988c;padding-bottom:6px}table{border-collapse:collapse;width:100%;margin:15px 0}
  th,td{border:1px solid #829084;padding:7px;text-align:left;vertical-align:top}th{background:#eef2ed}.meta{color:#49594c}.watermark{color:#a22525;font-weight:bold;border:2px solid #a22525;padding:9px;margin:12px 0}
  .warnings{background:#fff6df;padding:15px 32px}.fine{font-size:11px;color:#536155} @media print{body{padding:0}.watermark{print-color-adjust:exact}}
  </style></head><body><main><h1>${escapeHtml(title)}</h1><p class="meta">${escapeHtml(subtitle)}</p>
  <p class="watermark">PROTOTYPE ONLY · NOT AN OFFICIAL FORM · NOT FOR FILING${provisional ? " · PROVISIONAL" : ""}</p>
  ${warningMarkup}${body}<p class="fine">Browser-only prototype based on frozen payroll snapshots. No filing, authentication, or agency-format validation. Official form reference: <a href="${RD_V2}">Revenue Department central formats</a> · <a href="${SSO_REFERENCE}">Social Security Office reference</a></p>
  </main></body></html>`;
}
function pnd1DocumentHtml(title: string, body: string) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
  *{box-sizing:border-box}body{font:10.5pt/1.4 Tahoma,"Noto Sans Thai",sans-serif;color:#1c2526;margin:0;background:#fff}
  main{width:100%;margin:0}.pnd1-page,.pnd1-attachment{position:relative;width:100%;min-height:270mm;padding:8mm;border:1px solid #748087;background:#fff}
  .pnd1-page{page-break-after:always;break-after:page}.pnd1-attachment{page-break-before:always;break-before:page}
  .prototype-watermark{border:2px solid #a22525;color:#a22525;font-weight:bold;text-align:center;padding:5px;margin:0 0 5mm;letter-spacing:.04em}
  .warnings{background:#fff7df;border:1px solid #dec77b;padding:3mm 8mm;font-size:8.5pt}
  .pnd1-header{display:grid;grid-template-columns:1fr auto;gap:4mm;align-items:start;border-bottom:2px solid #26383c;padding:1mm 0 4mm;margin-bottom:4mm}
  .agency-title{font-size:13pt;font-weight:bold;letter-spacing:.02em}.agency-subtitle{font-size:9pt;color:#48565a;margin-top:1mm}
  .form-code{border:2px solid #27383b;padding:2mm 4mm;text-align:center;font-size:18pt;font-weight:bold;min-width:30mm}
  .form-code small{display:block;font-size:8pt;font-weight:normal}
  .section-title{font-weight:bold;background:#e9eef0;border:1px solid #86949a;padding:1.5mm 2mm;margin:3mm 0 1.5mm}
  .identity-grid{display:grid;grid-template-columns:1fr 1fr;gap:2mm 5mm}.identity-field{min-height:11mm;border-bottom:1px dotted #718087;padding:1mm 0}
  .field-label{display:block;font-size:8pt;color:#46555a}.field-value{font-weight:bold;overflow-wrap:anywhere}
  .tax-digits{display:flex;flex-wrap:wrap;gap:1mm;margin-top:1mm}.tax-digit{width:7mm;height:8mm;border:1px solid #56666b;text-align:center;font-size:12pt;line-height:8mm}
  .source-tax{font-size:8pt;color:#48565a;margin-top:1mm;overflow-wrap:anywhere}
  .month-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:1mm;margin:2mm 0}.month-cell{border:1px solid #8b999d;text-align:center;padding:2mm .5mm;font-size:8pt}
  .month-cell.active{background:#dce9eb;border:2px solid #314e55;font-weight:bold}.month-key{font-size:8pt;margin:1mm 0}
  .pnd1-grid{border-collapse:collapse;width:100%;font-size:8.5pt;margin:2mm 0}.pnd1-grid th,.pnd1-grid td{border:1px solid #75848a;padding:2mm;vertical-align:middle}
  .pnd1-grid th{background:#edf1f2;text-align:center}.pnd1-grid .num{text-align:right;white-space:nowrap}.not-supplied{color:#667276;font-style:italic}
  .declaration{border:1px solid #8b989c;padding:3mm;margin-top:4mm;font-size:9pt;min-height:27mm}
  .signature-grid{display:grid;grid-template-columns:1fr 1fr;gap:12mm;margin-top:5mm}.signature-line{border-bottom:1px dotted #48565a;height:10mm}
  .attachment-heading{text-align:center;border-bottom:2px solid #26383c;padding-bottom:3mm;margin:0 0 4mm}
  .attachment-heading h2{font-size:15pt;margin:0}.attachment-meta{font-size:9pt;margin-top:1mm}
  .attachment-note,.fine{font-size:8pt;color:#48565a}.frozen-link{white-space:nowrap;color:#234f62;text-decoration:underline}
  .source-list{font-size:8pt;list-style:none;padding:0}.source-list li{border-top:1px dotted #829095;padding:1.5mm 0;overflow-wrap:anywhere}
  .manifest{font-size:8pt;overflow-wrap:anywhere;border-top:1px solid #738187;padding-top:3mm;margin-top:5mm}
  @page{size:A4 portrait;margin:10mm}
  @media print{body{background:#fff}.pnd1-page,.pnd1-attachment{min-height:277mm;border:0;padding:0}.prototype-watermark{print-color-adjust:exact}.frozen-link{color:#1c2526}}
  </style></head><body><main>${body}</main></body></html>`;
}

const isTh = (offer: StatutoryOffer) => offer.branchId.startsWith("hkt-");

function ssoRecord(fields: unknown[], label: string) {
  const record = fields.map((value) => String(value ?? "").replace(/[\r\n\t|]/g, " ")).join("|");
  const codepoints = Array.from(record).length;
  if (codepoints > 135) {
    throw new Error(`Cannot create Thai SSO placeholder: ${label} requires ${codepoints} Unicode codepoints, exceeding the fixed 135-codepoint record; no name or identifier was truncated.`);
  }
  return record + " ".repeat(135 - codepoints);
}
function sso135(rows: FrozenPersonRow[], month: string) {
  // Delimited prototype records use Unicode codepoints; identity/name values are preserved or rejected, never truncated.
  const source = rows[0]?.snapshot;
  const header = ssoRecord([
    "NOT FOR FILING", "SSO DEMO", month.replace("-", ""), source?.branchId ?? "BRANCH",
    source?.details.legalEntity ?? "EMPLOYER", source?.details.taxId ?? "TAX",
    source?.details.employerNumber ?? "DETAILS",
  ], "header");
  const details = rows.map((person) => {
    const values = frozenValues(person);
    return ssoRecord([
      person.staff.employeeNumber, statutoryIdentifier(person.staff, "TH", "sso").value,
      person.staff.name, values.socialSecurityWages.toFixed(2),
      asNumber(values.employee.sso, `employee SSO for ${person.staff.name}`).toFixed(2),
      asNumber(values.employer.sso, `employer SSO for ${person.staff.name}`).toFixed(2),
      person.staff.employmentType === "foreign" ? "F" : "T",
      person.staff.joinedOn, person.staff.leftOn ?? "", person.staff.role,
    ], `staff ${person.staff.id}`);
  });
  if (Array.from(header).length !== 135 || details.some((line) => Array.from(line).length !== 135)) {
    throw new Error("Internal SSO text layout error: every header/detail line must be exactly 135 Unicode codepoints.");
  }
  return [header, ...details].join("\r\n");
}

function PND1Upload(people: Array<{ person: FrozenPersonRow; gross: number; tax: number }>, period: string) {
  const title = "NOT FOR FILING — RD central-format Version 2 placeholder (reference dated 16 June 2025)";
  const lines = [title, `Reference layout only: ${RD_V2}`, "RD central format Version 2 · 16 June 2025", `Period=${period}`];
  for (const { person, gross, tax } of people) {
    lines.push([
      statutoryIdentifier(person.staff, "TH", "tax").value,
      person.staff.employeeNumber,
      person.staff.name,
      roundPerson(gross).toFixed(2),
      roundPerson(tax).toFixed(2),
    ].join("|"));
  }
  return lines.join("\r\n");
}

function annualAggregate(months: FrozenMonth[]) {
  const grouped = new Map<string, { person: FrozenPersonRow; gross: number; tax: number; sso: number; wages: number; employerSso: number }>();
  for (const person of records(months)) {
    const values = frozenValues(person);
    const prev = grouped.get(person.staff.id) ?? { person, gross: 0, tax: 0, sso: 0, wages: 0, employerSso: 0 };
    prev.gross += roundPerson(values.grossPay);
    prev.tax += roundPerson(values.incomeTaxWithholding);
    prev.sso += roundPerson(asNumber(values.employee.sso, `frozen SSO employee contribution for ${person.staff.name}`));
    prev.wages += roundPerson(values.socialSecurityWages);
    prev.employerSso += roundPerson(asNumber(values.employer.sso, `frozen SSO employer contribution for ${person.staff.name}`));
    prev.person = person;
    grouped.set(person.staff.id, prev);
  }
  return Array.from(grouped.values());
}

export function renderThaiDocument(
  offer: StatutoryOffer, months: FrozenMonth[], provisional: boolean, coverageText: string,
): StatutoryRender {
  if (!isTh(offer)) throw new Error(`Thai adapter cannot render branch ${offer.branchId}.`);
  const people = records(months);
  const warnings = [...offer.warnings];
  const currency = months[0]?.snapshot.details.currency ?? "THB";
  if (currency !== "THB") throw new Error(`Thai statutory documents require frozen THB values; received ${currency}.`);
  const bodyBase = `<p><b>${th("เลขประจำตัวผู้เสียภาษี", "Employer tax ID")}:</b> ${escapeHtml(months[0]?.snapshot.details.taxId ?? "Unavailable from frozen source")} (fictional demo source value)</p>
  <p><b>${th("งวด / Period", "Period")}:</b> ${escapeHtml(offer.period)} · <b>${th("ความครอบคลุม", "Coverage")}:</b> ${escapeHtml(coverageText)}</p>`;
  let body = "";
  let usePnd1Layout = false;
  let upload = "";
  let uploadName = `${offer.code}.txt`;
  let uploadMime = "text/plain;charset=utf-8";

  if (offer.code === "PND1" || offer.code === "PND1A") {
    const selected = offer.code === "PND1A"
      ? annualAggregate(months).map((value) => ({ person: value.person, gross: value.gross, tax: value.tax }))
      : people.filter((person) => !offer.staffId || person.staff.id === offer.staffId).map((person) => {
        const values = frozenValues(person);
        return { person, gross: roundPerson(values.grossPay), tax: roundPerson(values.incomeTaxWithholding) };
      });
    const rows = selected.map(({ person, gross: amount, tax: withholding }) =>
      [person.staff.employeeNumber, person.staff.name, `${demoIdentifier(person.staff, "TH", "tax")} (fictional demo ID)`, money(amount, "THB"), money(withholding, "THB")]);
    const gross = selected.reduce((sum, person) => sum + person.gross, 0);
    const tax = selected.reduce((sum, person) => sum + person.tax, 0);
    if (offer.code === "PND1") {
      body = pnd1FormPages(offer, months, selected, warnings, provisional, coverageText);
      usePnd1Layout = true;
    } else {
      body = `${bodyBase}${rowMarkup([th("ลำดับ / No.", "No."), th("ชื่อผู้มีเงินได้", "Employee"), th("เลขประจำตัวผู้เสียภาษี", "Tax ID"), th("เงินได้", "Income"), th("ภาษีหัก ณ ที่จ่าย", "Tax withheld")], rows)}
        <p><b>${th("รวมเงินได้ / Total income", "Total income")}:</b> ${money(gross, "THB")} · <b>${th("รวมภาษี / Total tax", "Total tax")}:</b> ${money(tax, "THB")}</p>
        <p>Channel: ภ.ง.ด.1 paper due on the 7th or electronic filing due on the 15th of the following month. No weekend/holiday extension is assumed.</p>`;
    }
    upload = PND1Upload(selected, offer.period);
    uploadName = `${offer.code}-RD-central-format-V2-placeholder.txt`;
  } else if (offer.code === "50Tawi") {
    if (!offer.staffId) throw new Error("50 ทวิ must target one frozen employee.");
    const byMonth = people.filter((p) => p.staff.id === offer.staffId);
    if (!byMonth.length) throw new Error(`Frozen annual 50 ทวิ source has no rows for staff ${offer.staffId}.`);
    const aggregate = annualAggregate(months).find((p) => p.person.staff.id === offer.staffId);
    if (!aggregate) throw new Error("Frozen 50 ทวิ annual totals are unavailable.");
    body = `${bodyBase}<p><b>${th("ชื่อผู้มีเงินได้", "Employee")}:</b> ${escapeHtml(aggregate.person.staff.name)} · ${escapeHtml(demoIdentifier(aggregate.person.staff, "TH", "tax"))} <span class="fine">(fictional demo ID)</span></p>
      ${rowMarkup([th("รายการ", "Item"), th("จำนวนเงิน", "Amount")], [
        [th("เงินได้พึงประเมิน", "Gross taxable employment income"), money(aggregate.gross, "THB")],
        [th("ภาษีที่หักและนำส่ง", "Tax withheld"), money(aggregate.tax, "THB")],
        [th("เงินสมทบประกันสังคมพนักงาน (จากข้อมูลแช่แข็ง)", "Frozen employee SSO contribution"), money(aggregate.sso, "THB")],
      ])}<p>${escapeHtml(coverageText)}</p>`;
    upload = "NOT FOR FILING — 50 ทวิ annual certificate is a browser-only printable prototype.";
    uploadName = "50-tawi-not-for-filing.txt";
  } else if (offer.code === "SSO1-10-P1" || offer.code === "SSO1-10-P2") {
    const period = offer.period;
    const rows = people.map((p) => {
      const v = frozenValues(p);
      return [p.staff.employeeNumber, p.staff.name, demoIdentifier(p.staff, "TH", "sso"), money(v.socialSecurityWages, "THB"),
        money(asNumber(v.employee.sso, `employee SSO for ${p.staff.name}`), "THB"),
        money(asNumber(v.employer.sso, `employer SSO for ${p.staff.name}`), "THB")];
    });
    body = `${bodyBase}<p>${th("แบบรายการแสดงการส่งเงินสมทบ", "Social Security contribution report")} · Part ${offer.code.endsWith("P1") ? "1" : "2"}</p>
      ${rowMarkup([th("รหัสพนักงาน", "Employee no."), th("ชื่อ", "Name"), th("เลขประกันสังคม", "SSO number"), th("ค่าจ้าง", "Wages"), th("ส่วนลูกจ้าง", "Employee share"), th("ส่วนนายจ้าง", "Employer share")], rows)}
      <p>Upload is a labeled 135-character-line prototype pending official field alignment.</p>`;
    upload = sso135(people, period);
    uploadName = `${offer.code}-135-column-not-for-filing.txt`;
  } else if (offer.code === "SSO1-03" || offer.code === "SSO6-09") {
    const peopleForForm = offer.staffId ? people.filter((p) => p.staff.id === offer.staffId) : people;
    body = `${bodyBase}<p>${offer.code === "SSO1-03" ? th("แบบแจ้งขึ้นทะเบียนผู้ประกันตน", "Joiner registration") : th("แบบแจ้งสิ้นสุดความเป็นผู้ประกันตน", "Leaver notification")}</p>
    ${rowMarkup([th("รหัสพนักงาน", "Employee no."), th("ชื่อ", "Name"), th("เลขประกันสังคม", "SSO number"), th("วันที่มีผล", "Effective date")],
      peopleForForm.map((p) => [p.staff.employeeNumber, p.staff.name, demoIdentifier(p.staff, "TH", "sso"), offer.code === "SSO1-03" ? p.staff.joinedOn : p.staff.leftOn ?? ""]))}`;
    upload = `NOT FOR FILING — ${offer.code} joiner/leaver prototype; verify official requirements.`;
  } else if (offer.code === "KT20A") {
    const totals = annualAggregate(months);
    body = `${bodyBase}<p>${th("แบบแสดงค่าจ้างประจำปี", "Annual wage return")}</p>
      ${rowMarkup([th("ชื่อ", "Employee"), th("เลขประกันสังคม", "SSO number"), th("ค่าจ้างประกันสังคมรวม", "Annual social-security wages")],
        totals.map((p) => [p.person.staff.name, demoIdentifier(p.person.staff, "TH", "sso"), money(p.wages, "THB")]))}`;
    upload = "NOT FOR FILING — กท.20ก annual wage return text placeholder.";
  } else throw new Error(`Unsupported Thai statutory form ${offer.code}.`);

  const title = `${offer.title} · ${offer.period}`;
  return {
    html: usePnd1Layout ? pnd1DocumentHtml(title, body) : html(title, "ราชอาณาจักรไทย / Thailand · Frozen payroll record", body, provisional, warnings),
    upload, uploadName, uploadMime, warnings,
  };
}