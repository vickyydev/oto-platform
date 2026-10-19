import type {
  BranchId, PayrollWorld, RunSnapshot, StatutoryDocument, StatutoryOffer,
} from "./model";
import { renderMalaysiaDocument } from "./statutory-my";
import { renderThaiDocument } from "./statutory-th";
import { ewfNextMonth15, ewfTerminationDue, renderEwfDocument } from "./ewf-documents";
import {
  asRow, asText, annualCoverage, branchLifecycle, escapeHtml, identifierProvenance, latestLockedSnapshot,
  MONTH_PATTERN, YEAR_PATTERN, assertFrozenIdentity, monthsOfYear, provenanceText, snapshotRows, sourceRuns,
  type FrozenMonth,
} from "./statutory-shared";
import { systemClock, type PayrollClock } from "./clock";

export type { StatutoryOffer, StatutoryDocument } from "./model";

const monthlyDefinitions = {
  TH: [
    { code: "PND1", title: "ภ.ง.ด.1 พร้อมใบแนบ / PND.1 With Attachment", due: "next-month-07", channel: "Paper by the 7th; electronic by the 15th of the following month." },
    { code: "SSO1-10-P1", title: "สปส.1-10 ส่วนที่ 1 / SSO 1-10 Part 1", due: "next-month-15" },
    { code: "SSO1-10-P2", title: "สปส.1-10 ส่วนที่ 2 / SSO 1-10 Part 2", due: "next-month-15" },
  ],
  MY: [
    { code: "CP39", title: "CP39 / e-PCB Monthly Tax Deduction", due: "next-month-15" },
    { code: "EPF-A", title: "EPF Form A / Jadual Caruman KWSP", due: "next-month-15" },
    { code: "Borang8A", title: "SOCSO + EIS Borang 8A / PERKESO", due: "next-month-15" },
  ],
} as const;

const dayOffset = (date: string, days: number) => {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf())) return date;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
};
const monthFollowing = (period: string, day: number) => {
  const [year, month] = period.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};
const februaryEnd = (year: string) => `${year}-02-${new Date(Date.UTC(Number(year), 2, 0)).getUTCDate()}`;
const filingYear = (year: string) => String(Number(year) + 1);
const matchesMonth = (date: string, month: string) => date.slice(0, 7) === month;
const isEmployedInMonth = (joined: string, left: string | null, month: string) => {
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()}`;
  return (!joined || joined <= monthEnd) && (!left || left >= monthStart);
};
/**
 * The branch's statutory country. The prototype tested the fictional KL
 * branch id (prototype :47); it is now the branch payroll details' `country`
 * (the latest dated version), Thailand when none is recorded.
 */
const countryFor = (data: PayrollWorld, branchId: BranchId): "TH" | "MY" =>
  data.branches[branchId]?.detailsHistory.at(-1)?.details.country === "MY" ? "MY" : "TH";
function hrdEnabledForMonth(data: PayrollWorld, branchId: BranchId, month: string) {
  const snapshot = latestLockedSnapshot(data, branchId, month);
  if (snapshot) return asRow(asRow(snapshot.rules).my).hrdEnabled === true;
  const rules = data.branches[branchId].rulesHistory.filter((entry) => entry.effectiveFrom <= `${month}-31`)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  return rules?.my.hrdEnabled === true;
}
function frozenEwfValue(row: unknown, side: "employee" | "employer") {
  const breakdown = asRow(asRow(row).statutoryBreakdown);
  const value = asRow(breakdown[side]).ewf;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function frozenEwfStatus(row: unknown) {
  return asText(asRow(asRow(row).ewf).status);
}
function frozenEntityHeadcount(data: PayrollWorld, reference: RunSnapshot) {
  const month = reference.month;
  const monthEnd = `${month}-${new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()}`;
  const matches = (Object.keys(data.branches) as BranchId[]).flatMap((branchId) => {
    const snapshot = latestLockedSnapshot(data, branchId, month);
    return snapshot && snapshot.details.country === "TH" && snapshot.details.legalEntity === reference.details.legalEntity
      ? [snapshot] : [];
  });
  const sources = matches.length ? matches : [reference];
  const staff = new Map<string, (typeof reference.staff)[number]>();
  sources.forEach((snapshot) => snapshot.staff.forEach((person) => staff.set(person.id, person)));
  return Array.from(staff.values()).filter((person) =>
    person.joinedOn <= monthEnd && (!person.leftOn || person.leftOn >= `${month}-01`)).length;
}
function priorLockedEntitySnapshot(data: PayrollWorld, reference: RunSnapshot) {
  const candidates = data.runSnapshots.filter((snapshot) =>
    snapshot.approval === "locked" && snapshot.details.country === "TH" &&
    snapshot.month < reference.month && (snapshot.branchId === reference.branchId ||
      snapshot.details.legalEntity === reference.details.legalEntity));
  return candidates.sort((a, b) => b.month.localeCompare(a.month) || b.version - a.version)[0];
}
function datedEntityDetailsChanged(data: PayrollWorld, branchId: BranchId, period: string, priorMonth?: string) {
  const history = [...(data.branches[branchId].detailsHistory ?? [])]
    .filter((entry) => entry.effectiveFrom.slice(0, 7) <= period)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return history.some((changed, index) => {
    if (index === 0 || (priorMonth && changed.effectiveFrom.slice(0, 7) <= priorMonth)) return false;
    const previous = history[index - 1];
    return changed.details.legalEntity !== previous.details.legalEntity ||
      changed.details.name !== previous.details.name ||
      changed.details.address !== previous.details.address;
  });
}
function ewfMonthlyOffer(
  data: PayrollWorld, branchId: BranchId, period: string, code: string, title: string,
  staffId?: string, terminationLastWorkingDate?: string,
): StatutoryOffer | null {
  const snapshot = latestLockedSnapshot(data, branchId, period);
  if (!snapshot || period < "2026-10" || snapshot.details.country !== "TH" || snapshot.details.currency !== "THB") return null;
  const rows = snapshotRows(snapshot);
  const staffRows = staffId ? rows.filter((row) => row.staff.id === staffId) : rows;
  if (!staffRows.length) return null;
  if (code === "EWF3" && staffRows.some((row) =>
    frozenEwfValue(row.row, "employee") === null || frozenEwfValue(row.row, "employer") === null ||
    !["active", "provident-fund-exempt"].includes(frozenEwfStatus(row.row)))) return null;
  return {
    code, title, period, branchId, ...(staffId ? { staffId } : {}),
     dueDate: code === "EWF-TERM" && staffId
       ? ewfTerminationDue(terminationLastWorkingDate ?? snapshot.staff.find((person) => person.id === staffId)?.leftOn ?? period)
      : ewfNextMonth15(period),
    sourceRuns: [{ branchId, month: period, version: snapshot.version }],
    provisional: false,
    coverage: { locked: [period], missing: [], notApplicable: [] },
    warnings: [
      "Prototype only — not an official EWF form, not for filing, and no submission occurs.",
      ...(code === "EWF-TERM" && terminationLastWorkingDate
        ? [`Recorded offboarding last working date: ${terminationLastWorkingDate}.`]
        : []),
    ],
  };
}
function ewfChangeOffer(data: PayrollWorld, branchId: BranchId, period: string): StatutoryOffer | null {
  const current = latestLockedSnapshot(data, branchId, period);
  if (!current || period < "2026-10" || current.details.country !== "TH") return null;
  const currentCount = frozenEntityHeadcount(data, current);
  const prior = priorLockedEntitySnapshot(data, current);
  const changed = datedEntityDetailsChanged(data, branchId, period, prior?.month) ||
    Boolean(prior && (
      current.details.legalEntity !== prior.details.legalEntity ||
      current.details.name !== prior.details.name ||
      current.details.address !== prior.details.address ||
      currentCount !== frozenEntityHeadcount(data, prior)
    ));
  if (!changed) return null;
  return {
    code: "EWF3-2", title: "สกล.3/2 · Entity change notification (suggested)", period, branchId,
    dueDate: ewfNextMonth15(period),
    sourceRuns: [{ branchId, month: period, version: current.version }],
    provisional: false,
    coverage: { locked: [period], missing: [], notApplicable: [] },
    warnings: [`Frozen legal-entity headcount: ${currentCount}.`, "Suggested notification only. SSO filings may count; verify requirements. Never filed automatically."],
  };
}

function dueDate(code: string, period: string, staff?: { joinedOn: string; leftOn: string | null }) {
  if (MONTH_PATTERN.test(period)) {
    if (code === "PND1") return monthFollowing(period, 7);
    if (code === "CP22" && staff) return dayOffset(staff.joinedOn, 30);
    if (code === "CP22A" && staff?.leftOn) return dayOffset(staff.leftOn, -30);
    return monthFollowing(period, 15);
  }
  if (code === "PND1A" || code === "50Tawi" || code === "KT20A" || code === "EA") return februaryEnd(filingYear(period));
  if (code === "CP8D" || code === "E-CP8D" || code === "HRD") return `${filingYear(period)}-03-31`;
  return `${filingYear(period)}-03-31`;
}
function qualifyingDeparture(staff: unknown) {
  const member = asRow(staff);
  const explicit = [
    member.departureCondition, member.cessationReason, member.terminationReason,
    member.reasonForLeaving, member.departureReason,
  ].map(asText).join(" ");
  return /retire|permanent|pcb.?not.?deduct/i.test(explicit) ||
    member.retired === true || member.permanentDeparture === true || member.pcbNotDeducted === true;
}
function formWarnings(code: string, country: "TH" | "MY", period: string, hasSnapshot: boolean) {
  const warnings: string[] = [];
  if (!hasSnapshot) warnings.push("No approved locked snapshot is available for this period; generation is blocked until frozen monetary rows exist.");
  if (code === "PND1") warnings.push("Filing channel: paper deadline is the 7th; electronic deadline is the 15th of the following month. No weekend/holiday extension is assumed.");
  if (code === "Borang8A") warnings.push("PERKESO placeholder is explicitly incomplete when frozen SKBBK employee-share data is absent; no zero is assumed.");
  if (code === "CP22A-REMINDER") warnings.push("NON-GENERATABLE · NON-FILEABLE reminder only. No qualifying departure condition was explicitly recorded; no document or upload can be generated.");
  const submissionDate = MONTH_PATTERN.test(period) ? monthFollowing(period, 15) : `${filingYear(period)}-03-31`;
  if (country === "MY" && code === "Borang8A" && submissionDate >= "2026-10-01") {
    warnings.push("PERKESO Version 2.1 transition applies to submission dates on/after 1 October 2026. Placeholder format is not validated.");
  }
  return warnings;
}

function monthlyOffer(
  data: PayrollWorld, branchId: BranchId, period: string, code: string, title: string, due: string, staffId?: string,
): StatutoryOffer {
  const snapshot = latestLockedSnapshot(data, branchId, period);
  const branch = data.branches[branchId];
  const lifecycle = branchLifecycle(data, branchId, period, snapshot);
  const monthStart = `${period}-01`;
  const monthEnd = `${period}-${new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate()}`;
  const branchApplicable = (!lifecycle.openingDate || lifecycle.openingDate <= monthEnd) &&
    (!lifecycle.closingDate || lifecycle.closingDate >= monthStart);
  const staff = snapshot ? snapshot.staff.find((person) => person.id === staffId) : branch.staff.find((person) => person.id === staffId);
  const staffApplicable = !staff || isEmployedInMonth(staff.joinedOn, staff.leftOn, period);
  const applies = branchApplicable && staffApplicable;
  const locked = snapshot && applies ? [period] : [];
  const missing = applies && !snapshot ? [period] : [];
  const notApplicable = applies ? [] : [period];
  const warnings = formWarnings(code, countryFor(data, branchId), period, Boolean(snapshot && applies));
  if (!applies) warnings.push("This period is outside the effective branch or staff eligibility window.");
  return {
    code, title, period, branchId, ...(staffId ? { staffId } : {}),
    dueDate: due, sourceRuns: snapshot && applies ? [{ branchId, month: period, version: snapshot.version }] : [],
    provisional: missing.length > 0,
    coverage: { locked, missing, notApplicable },
    warnings,
  };
}

function annualOffers(data: PayrollWorld, branchId: BranchId, year: string): StatutoryOffer[] {
  const country = countryFor(data, branchId);
  const snapshots = data.runSnapshots.filter((snapshot) =>
    snapshot.branchId === branchId && snapshot.approval === "locked" && snapshot.month.startsWith(`${year}-`));
  const reference = snapshots.sort((a, b) => b.month.localeCompare(a.month) || b.version - a.version)[0];
  const availableMonths = monthsOfYear(year).flatMap((month) => {
    const snapshot = latestLockedSnapshot(data, branchId, month);
    return snapshot ? [{ snapshot, rows: snapshotRows(snapshot) }] : [];
  });
  const branchCoverage = annualCoverage(data, branchId, year);
  const base = (code: string, title: string, staffId?: string, coverage = branchCoverage) => ({
    code, title, period: year, branchId, ...(staffId ? { staffId } : {}),
    dueDate: dueDate(code, year),
    sourceRuns: sourceRuns(availableMonths.filter((month) => coverage.locked.includes(month.snapshot.month))),
    provisional: coverage.provisional,
    coverage: { locked: coverage.locked, missing: coverage.missing, notApplicable: coverage.notApplicable },
    warnings: [
      ...(coverage.provisional ? [`PROVISIONAL – ${coverage.locked.length} of 12 months; missing applicable months are not treated as zero.`] : []),
        ...(staffId && coverage.missing.length ? ["Staff eligibility for missing locked-source months is inferred from the nearest frozen identity within the same calendar year solely to report provisional coverage; no money is read from inferred months."] : []),
        (() => {
          const lifecycle = branchLifecycle(data, branchId, year, reference);
          return `Lifecycle: Setup effective from ${lifecycle.effectiveFrom || "unspecified"}; opened ${lifecycle.openingDate || "not declared"}, closed ${lifecycle.closingDate || "not declared"}; ${lifecycle.provenance}`;
        })(),
      ...(!availableMonths.length ? ["No frozen annual source rows are available; generation is blocked."] : []),
    ],
  } satisfies StatutoryOffer);
  if (country === "TH") {
    const staffById = new Map<string, (typeof data.branches)[BranchId]["staff"][number]>();
    availableMonths.forEach((month) => month.snapshot.staff.forEach((staff) => staffById.set(staff.id, staff)));
    const staffOffers = Array.from(staffById.values()).flatMap((staff) => {
      const coverage = annualCoverage(data, branchId, year, staff.id);
      if (!coverage.applicable.length) return [];
      return [base("50Tawi", `หนังสือรับรอง 50 ทวิ / Withholding Tax Certificate — ${staff.name}`, staff.id, coverage)];
    });
    return [
      base("PND1A", "ภ.ง.ด.1ก พร้อมใบแนบ / Annual PND.1 Kor"),
      ...staffOffers,
      base("KT20A", "กท.20ก / Annual Social Security Wage Return"),
    ];
  }
  const staffById = new Map<string, (typeof data.branches)[BranchId]["staff"][number]>();
  availableMonths.forEach((month) => month.snapshot.staff.forEach((staff) => staffById.set(staff.id, staff)));
  const ea = Array.from(staffById.values()).flatMap((staff) => {
    const coverage = annualCoverage(data, branchId, year, staff.id);
    return coverage.applicable.length ? [base("EA", `EA / CP8A Annual Statement — ${staff.name}`, staff.id, coverage)] : [];
  });
  const hrdMonths = monthsOfYear(year).filter((month) =>
    (branchCoverage.locked.includes(month) || branchCoverage.missing.includes(month)) && hrdEnabledForMonth(data, branchId, month));
  const hrdCoverage = {
    locked: hrdMonths.filter((month) => Boolean(latestLockedSnapshot(data, branchId, month))),
    missing: hrdMonths.filter((month) => !latestLockedSnapshot(data, branchId, month)),
    notApplicable: monthsOfYear(year).filter((month) => !hrdMonths.includes(month)),
    applicable: hrdMonths,
    provisional: hrdMonths.some((month) => !latestLockedSnapshot(data, branchId, month)),
  };
  return [
    ...ea,
    base("CP8D", "Form E + CP8D / Employer Annual Return"),
    ...(hrdMonths.length ? [base("HRD", "HRD Corp Annual Levy Summary", undefined, hrdCoverage)] : []),
  ];
}

/**
 * Return country-specific forms for a YYYY-MM monthly period or YYYY annual period.
 * All source manifests select the newest approved+locked version per contributing month.
 */
export function listStatutoryOffers(data: PayrollWorld, branchId: BranchId, period: string): StatutoryOffer[] {
  if (!data.branches[branchId]) throw new Error(`Unknown payroll branch ${branchId}.`);
  if (MONTH_PATTERN.test(period)) {
    const country = countryFor(data, branchId);
    const monthly = monthlyDefinitions[country];
    const offers = monthly.map((item) => monthlyOffer(data, branchId, period, item.code, item.title, dueDate(item.code, period)));
    if (country === "TH") {
      const snapshot = latestLockedSnapshot(data, branchId, period);
      const members = snapshot?.staff ?? data.branches[branchId].staff;
      for (const staff of members) {
        if (matchesMonth(staff.joinedOn, period)) offers.push(monthlyOffer(data, branchId, period, "SSO1-03", "สปส.1-03 / Social Security Joiner Registration", dayOffset(staff.joinedOn, 30), staff.id));
        if (staff.leftOn && matchesMonth(staff.leftOn, period)) offers.push(monthlyOffer(data, branchId, period, "SSO6-09", "สปส.6-09 / Social Security Leaver Notification", dayOffset(staff.leftOn, 15), staff.id));
      }
      if (snapshot && period >= "2026-10") {
        const rows = snapshotRows(snapshot);
        const hasFrozenEwf = rows.length > 0 && rows.every((row) =>
          frozenEwfValue(row.row, "employee") !== null && frozenEwfValue(row.row, "employer") !== null);
        const headcount = frozenEntityHeadcount(data, snapshot);
        if (hasFrozenEwf) {
          const remittance = ewfMonthlyOffer(data, branchId, period, "EWF3", "สกล.3 · Monthly EWF contribution list");
          if (remittance) offers.push(remittance);
        }
        const entityStatus = rows.map((row) => frozenEwfStatus(row.row));
        if (headcount < 10 && entityStatus.every((status) => status === "below-threshold")) {
          const informational = ewfMonthlyOffer(data, branchId, period, "EWF3-1", "สกล.3/1 · Voluntary-only informational form");
          if (informational) offers.push(informational);
        }
        const changeOffer = ewfChangeOffer(data, branchId, period);
        if (changeOffer) offers.push(changeOffer);
        for (const staff of snapshot.staff) {
          const beneficiary = ewfMonthlyOffer(data, branchId, period, "EWF5", `สกล.5 · Beneficiary status — ${staff.name}`, staff.id);
          if (beneficiary) offers.push(beneficiary);
          const checklistDate = (data.ewfOffboardingChecklists ?? []).find((item) =>
            item.branchId === branchId && item.staffId === staff.id)?.lastWorkingDate;
          const leaveDate = (data.leaveOffboarding ?? []).find((item) =>
            item.branchId === branchId && item.staffId === staff.id)?.lastWorkingDate;
          const lastWorkingDate = checklistDate ?? leaveDate ?? staff.leftOn ?? undefined;
          if (lastWorkingDate && matchesMonth(lastWorkingDate, period)) {
            const termination = ewfMonthlyOffer(
              data, branchId, period, "EWF-TERM", `Termination confirmation · ${staff.name}`, staff.id, lastWorkingDate,
            );
            if (termination) offers.push(termination);
          }
        }
      }
    } else {
      const snapshot = latestLockedSnapshot(data, branchId, period);
      const members = snapshot?.staff ?? data.branches[branchId].staff;
      for (const staff of members) {
        if (matchesMonth(staff.joinedOn, period)) offers.push(monthlyOffer(data, branchId, period, "CP22", `CP22 / New Employee Notification — ${staff.name}`, dayOffset(staff.joinedOn, 30), staff.id));
        if (staff.leftOn && matchesMonth(staff.leftOn, period)) {
          const qualified = qualifyingDeparture(staff);
      const code = qualified ? "CP22A" : "CP22A-REMINDER";
          offers.push(monthlyOffer(data, branchId, period, code, qualified ? `CP22A / Cessation Notification — ${staff.name}` : `CP22A Reminder — ${staff.name}`, qualified ? dayOffset(staff.leftOn, -30) : staff.leftOn, staff.id));
        }
      }
      if (hrdEnabledForMonth(data, branchId, period)) {
        offers.push(monthlyOffer(data, branchId, period, "HRD", "HRD Corp Levy Summary", monthFollowing(period, 15)));
      }
    }
    return offers;
  }
  if (YEAR_PATTERN.test(period)) return annualOffers(data, branchId, period);
  throw new Error("Statutory period must be YYYY-MM for monthly forms or YYYY for annual forms.");
}

function coverageText(offer: StatutoryOffer) {
  if (!MONTH_PATTERN.test(offer.period)) {
    const applicableMonths = offer.coverage.locked.length + offer.coverage.missing.length;
    return `${offer.coverage.locked.length} of 12 calendar months locked; ${applicableMonths} applicable; missing: ${offer.coverage.missing.join(", ") || "none"}; not applicable: ${offer.coverage.notApplicable.join(", ") || "none"}`;
  }
  return `locked: ${offer.coverage.locked.join(", ") || "none"}; missing: ${offer.coverage.missing.join(", ") || "none"}; not applicable: ${offer.coverage.notApplicable.join(", ") || "none"}`;
}

function assertSourceConsistency(data: PayrollWorld, offer: StatutoryOffer): FrozenMonth[] {
  const months: FrozenMonth[] = [];
  for (const source of offer.sourceRuns) {
    const snapshot = data.runSnapshots.find((item) => item.branchId === source.branchId && item.month === source.month && item.version === source.version && item.approval === "locked");
    if (!snapshot) throw new Error(`Frozen source ${source.branchId} ${source.month} v${source.version} is missing or no longer locked.`);
    assertFrozenIdentity(snapshot);
    const latest = latestLockedSnapshot(data, source.branchId, source.month);
    if (latest?.version !== source.version) throw new Error(`Offer source ${source.month} v${source.version} is superseded by locked v${latest?.version}; refresh the offer before generation.`);
    const rows = snapshotRows(snapshot);
    const monthEnd = `${source.month}-${new Date(Date.UTC(Number(source.month.slice(0, 4)), Number(source.month.slice(5, 7)), 0)).getUTCDate()}`;
    const missingEligible = snapshot.staff.find((staff) => {
      if (!isEmployedInMonth(staff.joinedOn, staff.leftOn, source.month)) return false;
      return !rows.some((row) => row.staff.id === staff.id);
    });
    if (missingEligible) {
      throw new Error(`Frozen source ${source.month} v${source.version} is missing a calculation row for eligible staff ${missingEligible.id} (period through ${monthEnd}).`);
    }
    months.push({ snapshot, rows });
  }
  if (!months.length) throw new Error(`Cannot generate ${offer.code} for ${offer.period}: no frozen monetary source rows are available.`);
  if (months.some((month) => month.rows.length === 0)) {
    throw new Error(`Cannot generate ${offer.code}: at least one locked source contains no frozen staff calculation rows.`);
  }
  if (offer.staffId && months.some((month) => !month.rows.some((row) => row.staff.id === offer.staffId))) {
    throw new Error(`Cannot generate ${offer.code}: frozen rows for staff ${offer.staffId} are missing from an applicable source month.`);
  }
  return months;
}

function formatProvenance(months: FrozenMonth[], data: PayrollWorld, offer: StatutoryOffer) {
  const runs = months.map(({ snapshot }) => {
    const lifecycle = branchLifecycle(data, offer.branchId, snapshot.month, snapshot);
    return `${snapshot.branchId} ${snapshot.month} v${snapshot.version} locked ${snapshot.lockedAt} by ${snapshot.lockedBy}; effective entity ${snapshot.details.legalEntity} (${snapshot.details.name}); tax ID ${snapshot.details.taxId}; employer number ${snapshot.details.employerNumber}; address ${snapshot.details.address}; ${snapshot.details.currency}; Setup lifecycle effective from ${lifecycle.effectiveFrom || "unspecified"}: opened ${lifecycle.openingDate || "not declared"}, closed ${lifecycle.closingDate || "not declared"} (${lifecycle.provenance})`;
  });
  return `Immutable source manifest: ${runs.join("; ")}. Identifier provenance by frozen source: ${identifierProvenance(months) || "none"}; identifiers absent from frozen staff.statutoryIds use only the named legacy deterministic demo fallback.`;
}
function appendManifest(html: string, manifest: string, coverage: string) {
  const section = `<section class="manifest"><h2>Frozen provenance / Immutable manifest</h2><p>${escapeHtml(manifest)}</p><p>${escapeHtml(coverage)}</p></section>`;
  return html.replace("</main>", `${section}</main>`);
}
function safeFileSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}
function stablePayloadHash(value: string) {
  let fnv = 0x811c9dc5;
  let djb = 0x1505;
  for (const character of value) {
    const codepoint = character.codePointAt(0)!;
    fnv = Math.imul(fnv ^ codepoint, 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) ^ codepoint) >>> 0;
  }
  return `${fnv.toString(16).padStart(8, "0")}${djb.toString(16).padStart(8, "0")}`;
}

/** Create printable HTML plus explicitly non-submission-ready text files using only locked frozen rows. */
export function createStatutoryDocument(data: PayrollWorld, offer: StatutoryOffer, who: string, clock: PayrollClock = systemClock): StatutoryDocument {
  if (!who.trim()) throw new Error("A document creator is required.");
  if (offer.code.endsWith("-REMINDER")) {
    throw new Error(`${offer.code} is a non-generatable, non-fileable reminder offer; no document or upload is available.`);
  }
  if (!data.branches[offer.branchId]) throw new Error(`Unknown payroll branch ${offer.branchId}.`);
  const currentOffer = listStatutoryOffers(data, offer.branchId, offer.period).find((item) =>
    item.code === offer.code && item.staffId === offer.staffId);
  if (!currentOffer) throw new Error(`Statutory offer ${offer.code} is no longer applicable; refresh the offer list.`);
  if (currentOffer.sourceRuns.map((r) => `${r.month}:v${r.version}`).join("|") !== offer.sourceRuns.map((r) => `${r.month}:v${r.version}`).join("|")) {
    throw new Error("Statutory offer source manifest changed; refresh before generation.");
  }
  const months = assertSourceConsistency(data, currentOffer);
  const coverage = coverageText(currentOffer);
  const rendered = currentOffer.code.startsWith("EWF")
    ? renderEwfDocument(currentOffer, months)
    : countryFor(data, currentOffer.branchId) === "MY"
    ? renderMalaysiaDocument(currentOffer, months, currentOffer.provisional, coverage)
    : renderThaiDocument(currentOffer, months, currentOffer.provisional, coverage);
  const manifest = formatProvenance(months, data, currentOffer);
  const html = appendManifest(rendered.html, manifest, coverage);
  const monthVersions = currentOffer.sourceRuns.map((item) => `${item.month}-v${item.version}`).join("_") || "no-source";
  const baseName = `${safeFileSegment(currentOffer.branchId)}-${safeFileSegment(currentOffer.period)}-${safeFileSegment(currentOffer.code)}${currentOffer.staffId ? `-${safeFileSegment(currentOffer.staffId)}` : ""}-${monthVersions}`;
  const generatedAt = clock.now().toISOString(); // injected clock (prototype :425)
  const uploadText = currentOffer.code === "SSO1-10-P1" || currentOffer.code === "SSO1-10-P2"
    ? rendered.upload
    : [
      "NOT FOR FILING — NOT SUBMISSION-READY — browser-generated prototype placeholder only.",
      `Document: ${currentOffer.title}`,
      `Branch: ${currentOffer.branchId}`,
      `Period: ${currentOffer.period}`,
      `Source: ${provenanceText(months)}`,
      rendered.upload,
    ].join("\r\n");
  const warnings = [...currentOffer.warnings, ...rendered.warnings, manifest];
  const canonicalPayload = JSON.stringify({
    branchId: currentOffer.branchId,
    period: currentOffer.period,
    code: currentOffer.code,
    staffId: currentOffer.staffId ?? null,
    sourceRuns: currentOffer.sourceRuns.map((source) => [source.branchId, source.month, source.version]),
    dueDate: currentOffer.dueDate,
    provisional: currentOffer.provisional,
    coverage: currentOffer.coverage,
    warnings,
    html,
    files: [
      { name: `${baseName}.html`, mime: "text/html;charset=utf-8", content: html },
      { name: `${baseName}-${safeFileSegment(rendered.uploadName)}`, mime: rendered.uploadMime, content: uploadText },
    ],
  });
  const id = `stat-${safeFileSegment(currentOffer.branchId)}-${safeFileSegment(currentOffer.period)}-${safeFileSegment(currentOffer.code)}-${safeFileSegment(currentOffer.staffId ?? "employer")}-${monthVersions}-${stablePayloadHash(canonicalPayload)}`;
  const document: StatutoryDocument = {
    id,
    branchId: currentOffer.branchId,
    period: currentOffer.period,
    code: currentOffer.code,
    title: currentOffer.title,
    ...(currentOffer.staffId ? { staffId: currentOffer.staffId } : {}),
    sourceRuns: currentOffer.sourceRuns,
    createdAt: generatedAt,
    createdBy: who.trim(),
    html,
    files: [
      { name: `${baseName}.html`, content: html, mime: "text/html;charset=utf-8" },
      { name: `${baseName}-${safeFileSegment(rendered.uploadName)}`, content: uploadText, mime: rendered.uploadMime },
    ],
    dueDate: currentOffer.dueDate,
    provisional: currentOffer.provisional,
    coverage: currentOffer.coverage,
    warnings,
  };
  return document;
}
