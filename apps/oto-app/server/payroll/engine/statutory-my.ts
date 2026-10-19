import type { StatutoryOffer } from "./model";
import {
  asNumber, asRow, asText, demoIdentifier, escapeHtml, frozenValues, money, roundPerson,
  type FrozenMonth, type FrozenPersonRow,
} from "./statutory-shared";
import type { StatutoryRender } from "./statutory-th";

const HASIL = "https://www.hasil.gov.my/en/majikan/tanggungjawab-majikan/";
const KWSP = "https://www.kwsp.gov.my/en/others/forms/employer";
const PERKESO = "https://www.perkeso.gov.my/images/lindung/lindung-24-jam/FAQ_TextFileFormat_EN.pdf";
const ms = (malay: string, english: string) => `${malay} / ${english}`;
const people = (months: FrozenMonth[]) => months.flatMap((month) => month.rows);

function table(headers: string[], rows: unknown[][]) {
  return `<table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${
    rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")
  }</tbody></table>`;
}
function markup(title: string, subtitle: string, body: string, provisional: boolean, warnings: string[]) {
  return `<!doctype html><html lang="ms"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    *{box-sizing:border-box}body{font:14px/1.5 Arial,sans-serif;color:#20312b;padding:28px;margin:0}main{max-width:1000px;margin:auto;border:1px solid #77867c;padding:28px}
    h1{font-size:22px;margin:0 0 5px}h2{font-size:16px}table{border-collapse:collapse;width:100%;margin:15px 0}th,td{border:1px solid #849188;padding:7px;text-align:left}
    th{background:#edf2ed}.meta{color:#4d5c53}.watermark{border:2px solid #9b2929;color:#9b2929;font-weight:bold;padding:9px}.warnings{background:#fff6dd;padding:14px 32px}
    .fine{font-size:11px;color:#58665d}@media print{body{padding:0}.watermark{print-color-adjust:exact}}
  </style></head><body><main><h1>${escapeHtml(title)}</h1><p class="meta">${escapeHtml(subtitle)}</p>
    <p class="watermark">PROTOTYPE ONLY · NOT AN OFFICIAL FORM · NOT FOR FILING${provisional ? " · PROVISIONAL" : ""}</p>
    ${warnings.length ? `<ul class="warnings">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` : ""}${body}
    <p class="fine">Frozen-source browser prototype. No actual filing, authentication, or agency-format validation. References: <a href="${HASIL}">HASiL</a> · <a href="${KWSP}">KWSP</a> · <a href="${PERKESO}">PERKESO</a></p>
  </main></body></html>`;
}

function personTotals(rows: FrozenPersonRow[]) {
  const totals = new Map<string, { person: FrozenPersonRow; gross: number; tax: number; socsoWages: number; epfEmployee: number; epfEmployer: number; socsoEmployee: number; socsoEmployer: number; eisEmployee: number; eisEmployer: number; hrd: number }>();
  rows.forEach((person) => {
    const v = frozenValues(person);
    const current = totals.get(person.staff.id) ?? {
      person, gross: 0, tax: 0, socsoWages: 0, epfEmployee: 0, epfEmployer: 0,
      socsoEmployee: 0, socsoEmployer: 0, eisEmployee: 0, eisEmployer: 0, hrd: 0,
    };
    current.gross += roundPerson(v.grossPay);
    current.tax += roundPerson(v.incomeTaxWithholding);
    current.socsoWages += roundPerson(v.socialSecurityWages);
    current.epfEmployee += roundPerson(asNumber(v.employee.epf, `EPF employee contribution for ${person.staff.name}`));
    current.epfEmployer += roundPerson(asNumber(v.employer.epf, `EPF employer contribution for ${person.staff.name}`));
    current.socsoEmployee += roundPerson(asNumber(v.employee.socso, `SOCSO employee contribution for ${person.staff.name}`));
    current.socsoEmployer += roundPerson(asNumber(v.employer.socso, `SOCSO employer contribution for ${person.staff.name}`));
    current.eisEmployee += roundPerson(asNumber(v.employee.eis, `EIS employee contribution for ${person.staff.name}`));
    current.eisEmployer += roundPerson(asNumber(v.employer.eis, `EIS employer contribution for ${person.staff.name}`));
    current.hrd += roundPerson(asNumber(v.employer.hrd, `HRD employer levy for ${person.staff.name}`));
    current.person = person;
    totals.set(person.staff.id, current);
  });
  return Array.from(totals.values());
}

function frozenHrdEnabled(month: FrozenMonth | undefined) {
  return month ? asRow(asRow(month.snapshot.rules).my).hrdEnabled === true : false;
}
function epfCategory(person: FrozenPersonRow) {
  if (person.staff.employmentType !== "foreign") return "Local worker";
  const my = asRow(asRow(person.snapshot.rules).my);
  const employeeRate = my.epfForeignEmployeeRate;
  const employerRate = my.epfForeignEmployerRate;
  if (employeeRate === 0.02 && employerRate === 0.02) return "Foreign worker · frozen 2% + 2% rates";
  return "Foreign worker · amounts from frozen calculation";
}
function submissionPlaceholder(code: string, period: string, rows: string[], reference: string, extraWarning = "") {
  return [
    `NOT FOR FILING — ${code} browser-generated placeholder; not submission-ready.`,
    `Reference: ${reference}`,
    `Period: ${period}`,
    ...(extraWarning ? [`INCOMPLETE: ${extraWarning}`] : []),
    ...rows,
  ].join("\r\n");
}
function frozenSkbbk(person: FrozenPersonRow): number | undefined {
  const breakdown = frozenValues(person).breakdown;
  const employee = asRow(breakdown.employee);
  const rawSkbbk = employee.skbbk;
  const nestedSkbbk = asRow(rawSkbbk);
  const socialSecurity = asRow(employee.socialSecurity);
  const candidates = [
    employee.SKBBK, rawSkbbk && typeof rawSkbbk === "object" ? undefined : rawSkbbk,
    employee.skbbkEmployee, employee.skbbkAmount, employee.skbBk,
    nestedSkbbk.employee, nestedSkbbk.employeeShare, nestedSkbbk.amount,
    socialSecurity.skbbk, socialSecurity.SKBBK,
    breakdown.SKBBK, breakdown.skbbkEmployee, breakdown.employeeSkbbk,
    asRow(person.row).skbbkEmployee, asRow(person.row).SKBBK,
  ];
  const frozen = candidates.find((value) => value !== undefined && value !== null);
  return frozen === undefined ? undefined : asNumber(frozen, `frozen SKBBK employee share for ${person.staff.name}`);
}

export function renderMalaysiaDocument(
  offer: StatutoryOffer, months: FrozenMonth[], provisional: boolean, coverageText: string,
): StatutoryRender {
  // The prototype refused any branch id not starting "plaza-" (its fictional KL
  // branch, prototype :97); the caller now chooses this adapter by the branch
  // payroll details' country (statutory-engine `countryFor`).
  const rows = people(months);
  const totals = personTotals(rows);
  const warnings = [...offer.warnings];
  const currency = months[0]?.snapshot.details.currency ?? "MYR";
  if (currency !== "MYR") throw new Error(`Malaysian statutory documents require frozen MYR values; received ${currency}.`);
  const employer = months[0]?.snapshot.details;
  const base = `<p><b>${ms("Majikan", "Employer")}:</b> ${escapeHtml(employer?.legalEntity ?? "Unavailable from frozen source")} ·
    <b>${ms("No. cukai majikan", "Employer tax ID")}:</b> ${escapeHtml(employer?.taxId ?? "Unavailable from frozen source")} (fictional demo source value)</p>
    <p><b>${ms("Tempoh", "Period")}:</b> ${escapeHtml(offer.period)} · <b>${ms("Liputan", "Coverage")}:</b> ${escapeHtml(coverageText)}</p>`;
  let body = "";
  let upload = "";
  let uploadName = `${offer.code}.txt`;
  let uploadMime = "text/plain;charset=utf-8";
  const monthlyAmounts = rows.map((p) => ({ p, v: frozenValues(p) }));

  if (offer.code === "CP39") {
    const selected = offer.staffId ? monthlyAmounts.filter(({ p }) => p.staff.id === offer.staffId) : monthlyAmounts;
    body = `${base}<p>${ms("Penyata potongan cukai bulanan", "Monthly tax deduction (PCB / e-PCB)")}</p>
      ${table([ms("No. pekerja", "Employee no."), ms("Nama pekerja", "Employee name"), ms("No. cukai", "Tax number"), ms("Pendapatan kasar", "Gross pay"), ms("PCB dipotong", "PCB withheld")],
        selected.map(({ p, v }) => [p.staff.employeeNumber, p.staff.name, `${demoIdentifier(p.staff, "MY", "tax")} (fictional)`, money(roundPerson(v.grossPay), "MYR"), money(roundPerson(v.incomeTaxWithholding), "MYR")]))}`;
    upload = submissionPlaceholder("CP39/e-PCB", offer.period, selected.map(({ p, v }) =>
      `${demoIdentifier(p.staff, "MY", "tax")}|${roundPerson(v.grossPay).toFixed(2)}|${roundPerson(v.incomeTaxWithholding).toFixed(2)}`), HASIL);
  } else if (offer.code === "EPF-A") {
    body = `${base}<p>${ms("Jadual caruman KWSP Borang A", "EPF Contribution Schedule Form A")} · Values are displayed as frozen payroll amounts, including foreign-worker rates captured by that historical run.</p>
      ${table([ms("Nama pekerja", "Employee"), ms("No. ahli KWSP", "EPF number"), ms("Kategori", "Category"), ms("Upah kasar beku", "Frozen gross pay"), ms("Caruman pekerja", "Employee contribution"), ms("Caruman majikan", "Employer contribution")],
        monthlyAmounts.map(({ p, v }) => [p.staff.name, `${demoIdentifier(p.staff, "MY", "epf")} (fictional)`, epfCategory(p), money(v.grossPay, "MYR"),
          money(asNumber(v.employee.epf, `frozen EPF employee amount for ${p.staff.name}`), "MYR"), money(asNumber(v.employer.epf, `frozen EPF employer amount for ${p.staff.name}`), "MYR")]))}`;
    upload = submissionPlaceholder("EPF Form A", offer.period, monthlyAmounts.map(({ p, v }) =>
      `${demoIdentifier(p.staff, "MY", "epf")}|${p.staff.employmentType}|${roundPerson(v.grossPay).toFixed(2)}|${asNumber(v.employee.epf, `EPF employee amount for ${p.staff.name}`).toFixed(2)}|${asNumber(v.employer.epf, `EPF employer amount for ${p.staff.name}`).toFixed(2)}`), KWSP);
  } else if (offer.code === "Borang8A") {
    const skbbkAmounts = new Map(monthlyAmounts.map(({ p }) => [p.staff.id, frozenSkbbk(p)]));
    const incomplete = "SKBBK employee-share amount is absent from the frozen payroll breakdown.";
    const hasMissingSkbbk = Array.from(skbbkAmounts.values()).some((value) => value === undefined);
    const transitionV21 = offer.dueDate >= "2026-10-01";
    const formatVersion = transitionV21 ? "Version 2.1" : "pre-2.1 transition placeholder";
    if (hasMissingSkbbk) warnings.push(`Incomplete placeholder: ${incomplete} Missing amounts are not guessed as zero.`);
    if (transitionV21) warnings.push("PERKESO Version 2.1 transition applies by submission date on/after 1 October 2026. This placeholder is not validated.");
    body = `${base}<p>${ms("Borang 8A: caruman PERKESO dan SIP", "Borang 8A: combined SOCSO + EIS")}</p>
      ${table([ms("Nama pekerja", "Employee"), ms("No. PERKESO", "SOCSO number"), ms("Upah caruman", "Contribution wages"), ms("PERKESO pekerja / majikan", "SOCSO employee / employer"), ms("SIP pekerja / majikan", "EIS employee / employer"), "SKBBK employee share"],
        monthlyAmounts.map(({ p, v }) => [p.staff.name, `${demoIdentifier(p.staff, "MY", "socso")} (fictional)`, money(v.socialSecurityWages, "MYR"),
          `${money(asNumber(v.employee.socso, `SOCSO employee amount for ${p.staff.name}`), "MYR")} / ${money(asNumber(v.employer.socso, `SOCSO employer amount for ${p.staff.name}`), "MYR")}`,
          `${money(asNumber(v.employee.eis, `EIS employee amount for ${p.staff.name}`), "MYR")} / ${money(asNumber(v.employer.eis, `EIS employer amount for ${p.staff.name}`), "MYR")}`,
          skbbkAmounts.get(p.staff.id) === undefined ? "MISSING — NOT ASSUMED ZERO" : money(roundPerson(skbbkAmounts.get(p.staff.id)!), "MYR")]))}`;
    const uploadRows = monthlyAmounts.map(({ p, v }) => {
      const skbbk = skbbkAmounts.get(p.staff.id);
      return `${demoIdentifier(p.staff, "MY", "socso")}|${roundPerson(v.socialSecurityWages).toFixed(2)}|${asNumber(v.employee.socso, `SOCSO employee amount for ${p.staff.name}`).toFixed(2)}|${asNumber(v.employer.socso, `SOCSO employer amount for ${p.staff.name}`).toFixed(2)}|${asNumber(v.employee.eis, `EIS employee amount for ${p.staff.name}`).toFixed(2)}|${asNumber(v.employer.eis, `EIS employer amount for ${p.staff.name}`).toFixed(2)}|${skbbk === undefined ? "MISSING" : roundPerson(skbbk).toFixed(2)}`;
    });
    upload = submissionPlaceholder(`PERKESO Borang 8A ${formatVersion}`, offer.period, uploadRows, PERKESO, hasMissingSkbbk ? incomplete : "");
    uploadName = `Borang-8A-PERKESO-${transitionV21 ? "v2.1" : "pre-v2.1"}-placeholder.txt`;
  } else if (offer.code === "EA" || offer.code === "CP8D") {
    const annual = personTotals(rows);
    const selected = offer.staffId ? annual.filter((v) => v.person.staff.id === offer.staffId) : annual;
    if (offer.code === "EA") {
      if (!offer.staffId) throw new Error("EA statement must target an employee.");
      if (!selected[0]) throw new Error(`Frozen annual EA figures are unavailable for staff ${offer.staffId}; no totals will be invented.`);
      const employee = selected[0].person.staff;
      body = `${base}<p>${ms("Penyata saraan tahunan pekerja", "Annual employee remuneration statement")} · EA / CP8A</p>
        ${table([ms("Perkara", "Item"), ms("Jumlah (RM)", "Amount (RM)")], [
          [ms("Nama pekerja", "Employee"), employee.name],
          [ms("MyKad / pasport (fiksyen)", "Fictional IC / passport"), demoIdentifier(employee, "MY", employee.employmentType === "foreign" ? "passport" : "ic")],
          [ms("No. cukai pendapatan (fiksyen)", "Fictional income tax number"), demoIdentifier(employee, "MY", "tax")],
          [ms("Saraan kasar", "Gross remuneration"), money(selected[0].gross, "MYR")],
          [ms("PCB dipotong", "PCB deducted"), money(selected[0].tax, "MYR")],
          [ms("Caruman KWSP pekerja", "Employee EPF contribution"), money(selected[0].epfEmployee, "MYR")],
        ])}`;
    } else {
      body = `${base}<p>${ms("Borang E dan CP8D", "Employer return and employee remuneration listing")}</p>
        ${table([ms("Nama pekerja", "Employee"), ms("MyKad / pasport (fiksyen)", "Fictional IC / passport"), ms("No. cukai (fiksyen)", "Fictional tax number"), ms("Saraan kasar", "Gross remuneration"), ms("PCB", "Tax deducted"), ms("KWSP pekerja / majikan", "EPF employee / employer")],
          selected.map((v) => [v.person.staff.name, demoIdentifier(v.person.staff, "MY", v.person.staff.employmentType === "foreign" ? "passport" : "ic"), demoIdentifier(v.person.staff, "MY", "tax"), money(v.gross, "MYR"), money(v.tax, "MYR"), `${money(v.epfEmployee, "MYR")} / ${money(v.epfEmployer, "MYR")}`]))}
        <p>Form E + CP8D due 31 March following the assessment year.</p>`;
    }
    upload = submissionPlaceholder(offer.code === "EA" ? "EA / CP8A" : "Form E + CP8D", offer.period,
      selected.map((v) => `${demoIdentifier(v.person.staff, "MY", "tax")}|${v.gross.toFixed(2)}|${v.tax.toFixed(2)}`), HASIL);
  } else if (offer.code === "CP22" || offer.code === "CP22A") {
    const selected = offer.staffId ? rows.filter((p) => p.staff.id === offer.staffId) : rows;
    body = `${base}<p>${offer.code === "CP22" ? ms("Pemberitahuan pekerja baharu", "New employee notification") : ms("Pemberitahuan pemberhentian pekerja", "Cessation notification")} · prototype reminder dates are shown; verify current HASiL deadlines.</p>
      ${table([ms("Nama pekerja", "Employee"), ms("No. pekerja", "Employee no."), ms("MyKad / pasport (fiksyen)", "Fictional IC / passport"), ms("Tarikh mula", "Join date"), ms("Tarikh tamat", "Leave date"), ms("No. cukai", "Tax number")],
        selected.map((p) => [p.staff.name, p.staff.employeeNumber, demoIdentifier(p.staff, "MY", p.staff.employmentType === "foreign" ? "passport" : "ic"), p.staff.joinedOn, p.staff.leftOn ?? "—", `${demoIdentifier(p.staff, "MY", "tax")} (fictional)`]))}`;
    upload = submissionPlaceholder(offer.code, offer.period, selected.map((p) =>
      `${demoIdentifier(p.staff, "MY", "tax")}|${p.staff.joinedOn}|${p.staff.leftOn ?? ""}`), HASIL);
  } else if (offer.code === "HRD") {
    if (!months.length || !months.some(frozenHrdEnabled)) throw new Error("HRD Corp summary is available only when the frozen Setup rules enable the levy.");
    body = `${base}<p>${ms("Ringkasan levi PSMB / HRD Corp", "HRD Corp levy summary")}</p>
      ${table([ms("Pekerja", "Employee"), ms("Asas gaji beku", "Frozen payroll basis"), ms("Levi majikan beku", "Frozen employer levy")],
        totals.map((v) => [v.person.staff.name, money(v.gross, "MYR"), money(v.hrd, "MYR")]))}`;
    upload = submissionPlaceholder("HRD Corp levy summary", offer.period, totals.map((v) => `${v.person.staff.employeeNumber}|${v.hrd.toFixed(2)}`), HASIL);
  } else throw new Error(`Unsupported Malaysian statutory form ${offer.code}.`);

  const title = `${offer.title} · ${offer.period}`;
  return { html: markup(title, "Malaysia · Rekod gaji beku / Frozen payroll record", body, provisional, warnings), upload, uploadName, uploadMime, warnings };
}