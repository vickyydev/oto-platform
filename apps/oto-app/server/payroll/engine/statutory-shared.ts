import type { BranchId, PayrollWorld, RunSnapshot, StaffMember } from "./model";

export type UnknownRow = Record<string, unknown>;
export const asRow = (value: unknown): UnknownRow =>
  value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRow : {};
export const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const asText = (value: unknown): string => typeof value === "string" ? value : "";
export const asNumber = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Frozen payroll data is missing a valid ${label}.`);
  return value;
};
export const escapeHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]!));
export const money = (amount: number, currency: string) =>
  `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const roundPerson = (amount: number) => Math.round((amount + Number.EPSILON) * 100) / 100;
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export const YEAR_PATTERN = /^\d{4}$/;
export const monthsOfYear = (year: string) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);

export interface FrozenPersonRow {
  snapshot: RunSnapshot;
  staff: StaffMember;
  row: UnknownRow;
}
export interface FrozenMonth {
  snapshot: RunSnapshot;
  rows: FrozenPersonRow[];
}

export function snapshotRows(snapshot: RunSnapshot): FrozenPersonRow[] {
  const calc = asRow(snapshot.calculations);
  if (!Array.isArray(calc.rows) || calc.month !== snapshot.month || calc.currency !== snapshot.details.currency) {
    throw new Error(`Frozen ${snapshot.branchId} ${snapshot.month} v${snapshot.version} calculation metadata is incomplete or inconsistent.`);
  }
  const seenStaff = new Set<string>();
  return asArray(calc.rows).map((raw) => {
    const row = asRow(raw);
    const staffId = asText(row.staffId);
    if (!staffId || seenStaff.has(staffId)) {
      throw new Error(`Frozen calculation ${snapshot.month} v${snapshot.version} has a missing or duplicate staff row identifier.`);
    }
    seenStaff.add(staffId);
    const staff = snapshot.staff.find((person) => person.id === staffId);
    if (!staff) throw new Error(`Frozen calculation references unknown staff ${staffId || "(missing ID)"}.`);
    return { snapshot, staff, row };
  });
}

export function latestLockedSnapshot(data: PayrollWorld, branchId: BranchId, month: string): RunSnapshot | undefined {
  return data.runSnapshots
    .filter((snapshot) => snapshot.branchId === branchId && snapshot.month === month && snapshot.approval === "locked")
    .sort((a, b) => b.version - a.version)[0];
}
export function frozenMonths(data: PayrollWorld, branchId: BranchId, months: string[]): FrozenMonth[] {
  return months.flatMap((month) => {
    const snapshot = latestLockedSnapshot(data, branchId, month);
    return snapshot ? [{ snapshot, rows: snapshotRows(snapshot) }] : [];
  });
}

/** Read the effective-dated Setup declaration at the requested period; it is captured into the document manifest. */
export function branchLifecycle(data: PayrollWorld, branchId: BranchId, year: string, _snapshot?: RunSnapshot) {
  const records = asRow(data.branches[branchId]);
  const rawLifecycle = records.lifecycleHistory ?? records.lifecycle ?? records.dates;
  const candidate = asRow(rawLifecycle);
  const history = asArray(Array.isArray(rawLifecycle) ? rawLifecycle : candidate.history ?? candidate.effectiveHistory).map(asRow);
  const point = /^\d{4}-\d{2}$/.test(year)
    ? `${year}-${new Date(Date.UTC(Number(year.slice(0, 4)), Number(year.slice(5, 7)), 0)).getUTCDate()}`
    : `${year}-12-31`;
  const effective = history.filter((entry) => {
    const from = asText(entry.effectiveFrom ?? entry.from);
    return !from || from <= point;
  }).sort((a, b) => asText(b.effectiveFrom ?? b.from).localeCompare(asText(a.effectiveFrom ?? a.from)))[0];
  return {
    openingDate: asText(effective?.openingDate ?? effective?.openedOn ?? candidate.openingDate ?? candidate.openedOn),
    closingDate: asText(effective?.closingDate ?? effective?.closedOn ?? candidate.closingDate),
    effectiveFrom: asText(effective?.effectiveFrom ?? effective?.from),
    provenance: asText(effective?.provenance) || `Effective Setup lifecycle declaration ${asText(effective?.effectiveFrom ?? effective?.from) || "with no effective date"}.`,
  };
}

export interface AnnualCoverage {
  locked: string[];
  missing: string[];
  notApplicable: string[];
  applicable: string[];
  provisional: boolean;
}
function monthWithin(month: string, start?: string, end?: string | null) {
  const first = `${month}-01`;
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const last = `${month}-${String(lastDay).padStart(2, "0")}`;
  return (!start || start <= last) && (!end || end >= first);
}
function monthOrdinal(month: string) {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));
}
function frozenMemberForMonth(data: PayrollWorld, branchId: BranchId, staffId: string, month: string) {
  const currentMonthSnapshot = latestLockedSnapshot(data, branchId, month);
  if (currentMonthSnapshot) return currentMonthSnapshot.staff.find((member) => member.id === staffId);
  // A missing run has no month-specific identity. Use the nearest frozen identity only to determine
  // whether the missing month is applicable; the offer stays provisional and uses no money from it.
  const nearby = data.runSnapshots.filter((snapshot) => snapshot.branchId === branchId && snapshot.approval === "locked" &&
    snapshot.month.startsWith(`${month.slice(0, 4)}-`) &&
    snapshot.staff.some((member) => member.id === staffId))
    .sort((a, b) => Math.abs(monthOrdinal(a.month) - monthOrdinal(month)) - Math.abs(monthOrdinal(b.month) - monthOrdinal(month)) ||
      a.month.localeCompare(b.month))[0];
  return nearby?.staff.find((member) => member.id === staffId);
}
export function annualCoverage(
  data: PayrollWorld, branchId: BranchId, year: string, staffId?: string,
): AnnualCoverage {
  const applicable = monthsOfYear(year).filter((month) => {
    const lifecycle = branchLifecycle(data, branchId, month);
    const member = staffId ? frozenMemberForMonth(data, branchId, staffId, month) : undefined;
    return monthWithin(month, lifecycle.openingDate || undefined, lifecycle.closingDate || undefined) &&
      (!staffId || Boolean(member && monthWithin(month, member.joinedOn, member.leftOn)));
  });
  const locked = applicable.filter((month) => Boolean(latestLockedSnapshot(data, branchId, month)));
  const missing = applicable.filter((month) => !locked.includes(month));
  const notApplicable = monthsOfYear(year).filter((month) => !applicable.includes(month));
  return { locked, missing, notApplicable, applicable, provisional: missing.length > 0 };
}

export function sourceRuns(months: FrozenMonth[]) {
  return months.map(({ snapshot }) => ({ branchId: snapshot.branchId, month: snapshot.month, version: snapshot.version }));
}

export function assertFrozenIdentity(snapshot: RunSnapshot) {
  if (!snapshot || snapshot.approval !== "locked" || !MONTH_PATTERN.test(snapshot.month) ||
    !Number.isInteger(snapshot.version) || snapshot.version < 1 || !snapshot.lockedAt || !snapshot.lockedBy) {
    throw new Error("A statutory document requires an approved, locked snapshot with complete provenance.");
  }
  if (!snapshot.details || !snapshot.details.legalEntity || !snapshot.details.taxId || !snapshot.details.address) {
    throw new Error(`Frozen employer identity is incomplete for ${snapshot.branchId} ${snapshot.month} v${snapshot.version}; current Setup will not be substituted.`);
  }
  if (snapshot.details.country === "TH" && !snapshot.details.employerNumber) {
    throw new Error(`Frozen Thai SSO employer number is missing for ${snapshot.branchId} ${snapshot.month} v${snapshot.version}; current Setup will not be substituted.`);
  }
}
export function frozenValues(person: FrozenPersonRow) {
  const { row, staff, snapshot } = person;
  const currency = snapshot.details.currency;
  const values = {
    grossPay: asNumber(row.grossPay, `grossPay for ${staff.name}`),
    incomeTaxWithholding: asNumber(row.incomeTaxWithholding, `tax withholding for ${staff.name}`),
    socialSecurityWages: asNumber(row.socialSecurityWages, `social-security wages for ${staff.name}`),
  };
  const breakdown = asRow(row.statutoryBreakdown);
  const employee = asRow(breakdown.employee);
  const employer = asRow(breakdown.employer);
  for (const key of ["sso", "epf", "socso", "eis"] as const) {
    if (employee[key] !== undefined) asNumber(employee[key], `employee ${key} contribution for ${staff.name}`);
    if (employer[key] !== undefined) asNumber(employer[key], `employer ${key} contribution for ${staff.name}`);
  }
  return { ...values, currency, employee, employer, breakdown };
}

export function monthLabel(month: string) {
  const date = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(date.valueOf()) ? month : new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}
export function deadline(year: string, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
export function demoIdentifier(staff: StaffMember, country: "TH" | "MY", kind: string) {
  return statutoryIdentifier(staff, country, kind).value;
}
function identifierFields(country: "TH" | "MY", kind: string): Array<keyof NonNullable<StaffMember["statutoryIds"]>> {
  if (country === "TH") {
    if (kind === "sso") return ["ssoNumber"];
    return ["nationalId", "taxNumber"];
  }
  if (kind === "epf") return ["epfNumber"];
  if (kind === "socso") return ["socsoNumber"];
  if (kind === "tax") return ["taxNumber"];
  if (kind === "passport") return ["passport"];
  return ["nationalId"];
}
function legacyDemoIdentifier(staff: StaffMember, country: "TH" | "MY", kind: string) {
  const id = staff.id.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (country === "TH") {
    if (kind === "sso") return `DEMO-SSO-${id}`;
    let hash = 2166136261;
    Array.from(id).forEach((character) => { hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0; });
    const firstTwelve = String(hash).padStart(10, "0").slice(-10) + String(id.length).padStart(2, "0");
    const checksum = (11 - firstTwelve.split("").reduce((sum, digit, index) => sum + Number(digit) * (13 - index), 0) % 11) % 10;
    return `${firstTwelve}${checksum}`;
  }
  return `DEMO-${kind.toUpperCase()}-${id}`;
}
export function statutoryIdentifier(staff: StaffMember, country: "TH" | "MY", kind: string) {
  const fields = identifierFields(country, kind);
  const frozenField = fields.find((field) => asText(staff.statutoryIds?.[field]).trim());
  if (frozenField) {
    return { value: asText(staff.statutoryIds?.[frozenField]).trim(), source: `frozen staff.statutoryIds.${frozenField}` };
  }
  return {
    value: legacyDemoIdentifier(staff, country, kind),
    source: `legacy deterministic demo fallback for staff ID ${staff.id}; statutoryIds.${fields.join("/")} absent`,
  };
}
export function identifierProvenance(months: FrozenMonth[]) {
  const sources = new Map<string, string>();
  for (const { snapshot, rows } of months) {
    const country = snapshot.details.country;
    const kinds = country === "TH" ? ["tax", "sso"] : ["tax", "epf", "socso"];
    for (const { staff } of rows) {
      const applicableKinds = country === "MY"
        ? [...kinds, staff.employmentType === "foreign" ? "passport" : "ic"]
        : kinds;
      for (const kind of applicableKinds) {
        const id = statutoryIdentifier(staff, country, kind);
        sources.set(`${snapshot.month} v${snapshot.version} ${staff.id} ${kind}`, id.source);
      }
    }
  }
  return Array.from(sources.entries()).map(([key, source]) => `${key}: ${source}`).join("; ");
}

export function provenanceText(months: FrozenMonth[]) {
  return months.map(({ snapshot }) =>
    `${snapshot.branchId} ${snapshot.month} v${snapshot.version} locked ${snapshot.lockedAt} by ${snapshot.lockedBy}`,
  ).join("; ");
}