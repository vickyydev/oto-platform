import type {
  BranchId, EwfSettings, EwfSettingsVersion, PayrollWorld,
} from "./model";

export interface EwfComponent {
  id: string;
  name: string;
  amount: number;
  countsAsWage: boolean;
  reason: string;
  /** Optional provenance makes cross-branch/currency component mistakes explicit. */
  branchId?: BranchId;
  staffId?: string;
  currency?: string;
  /** Single-day source-ledger date; preferred for discrete pay items. */
  earnedOn?: string;
  /** Inclusive span for monthly/period accrual; prorated evenly per calendar day. */
  coversFrom?: string;
  coversThrough?: string;
}

export interface EwfResult {
  status: "not-configured" | "before-effective-date" | "below-threshold" | "active" | "provident-fund-exempt";
  entityId: string;
  headcount: number;
  wageBase: number;
  employeeRate: number;
  employerRate: number;
  employeeAmount: number;
  employerAmount: number;
  componentManifest: Array<EwfComponent & {
    included: boolean;
    eligibleAmount: number;
    membershipExemptAmount: number;
    prorationNote?: string;
  }>;
  membershipProrationMethod: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const validDate = (date: string) => DATE_RE.test(date) &&
  new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date;
const roundMoney = (amount: number) => Math.round((amount + Number.EPSILON) * 100) / 100;
const calendarDaysBetween = (from: string, through: string) =>
  Math.floor((Date.parse(`${through}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000) + 1;

function legalEntityForMonth(data: PayrollWorld, branchId: BranchId, month: string) {
  const history = [...data.branches[branchId].detailsHistory].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return [...history].reverse().find((item) => item.effectiveFrom <= month)?.details;
}

export function effectiveEwfSettings(data: PayrollWorld, branchId: BranchId, month: string): EwfSettingsVersion | null {
  if (!MONTH_RE.test(month) || !data.branches[branchId]) throw new Error("EWF month or branch is invalid.");
  const details = legalEntityForMonth(data, branchId, month);
  if (!details || details.country !== "TH" || details.currency !== "THB") return null;
  const entityId = details.legalEntity;
  const versions = [...(data.ewfSettings ?? [])]
    .filter((version) => version.entityId === entityId && version.effectiveFrom <= `${month}-31`)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return versions.at(-1) ?? null;
}

export function ewfEntityStatus(data: PayrollWorld, branchId: BranchId, month: string): {
  entityId: string | null;
  country: "TH" | "MY";
  headcount: number;
  settings: EwfSettings | null;
  status: "not-configured" | "before-effective-date" | "below-threshold" | "active";
} {
  if (!MONTH_RE.test(month) || !data.branches[branchId]) throw new Error("EWF month or branch is invalid.");
  const details = legalEntityForMonth(data, branchId, month);
  if (!details) throw new Error(`No effective branch identity exists for ${branchId} ${month}.`);
  if (details.country !== "TH" || details.currency !== "THB") {
    return { entityId: null, country: details.country, headcount: 0, settings: null, status: "not-configured" };
  }
  const entityId = details.legalEntity;
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}`;
  const computedHeadcount = (Object.keys(data.branches) as BranchId[]).reduce((sum, id) => {
    const entityDetails = legalEntityForMonth(data, id, month);
    if (!entityDetails || entityDetails.country !== "TH" || entityDetails.legalEntity !== entityId) return sum;
    return sum + data.branches[id].staff.filter((staff) =>
      staff.joinedOn <= monthEnd && (!staff.leftOn || staff.leftOn >= monthStart)).length;
  }, 0);
  const headcount = data.ewfHeadcountOverrides?.[entityId] ?? computedHeadcount;
  const version = effectiveEwfSettings(data, branchId, month);
  if (!version) return { entityId, country: "TH", headcount, settings: null,
    status: data.ewfSettings.some(v => v.entityId === entityId && v.effectiveFrom.slice(0, 7) > month) ? "before-effective-date" : "not-configured" };
  const active = headcount >= version.settings.headcountThreshold || version.settings.voluntaryBelowThreshold;
  return {
    entityId, country: "TH", headcount, settings: version.settings,
    status: active ? "active" : "below-threshold",
  };
}

export function computeEwf(
  data: PayrollWorld,
  branchId: BranchId,
  month: string,
  staffId: string,
  components: EwfComponent[],
): EwfResult {
  if (!MONTH_RE.test(month) || !data.branches[branchId]) throw new Error("EWF month or branch is invalid.");
  const branch = data.branches[branchId];
  const staff = branch.staff.find((member) => member.id === staffId);
  if (!staff) throw new Error(`EWF employee ${staffId} does not belong to ${branchId}.`);
  if (!Array.isArray(components) || components.some((component) =>
    !component || typeof component.id !== "string" || !component.id.trim() ||
    typeof component.name !== "string" || !component.name.trim() ||
    typeof component.amount !== "number" || !Number.isFinite(component.amount) || component.amount < 0 ||
    typeof component.countsAsWage !== "boolean" || typeof component.reason !== "string" ||
    ((component.coversFrom === undefined) !== (component.coversThrough === undefined)) ||
    (component.earnedOn !== undefined && (!validDate(component.earnedOn) ||
      component.earnedOn < `${month}-01` || component.earnedOn > `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}`)) ||
    (component.coversFrom !== undefined && (!validDate(component.coversFrom) || !validDate(component.coversThrough!) ||
      component.coversFrom < `${month}-01` ||
      component.coversThrough! > `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}` ||
      component.coversFrom > component.coversThrough!)) ||
    (component.earnedOn !== undefined && component.coversFrom !== undefined) ||
    (component.branchId !== undefined && component.branchId !== branchId) ||
    (component.staffId !== undefined && component.staffId !== staffId) ||
    (component.currency !== undefined && component.currency !== "THB"))) {
    throw new Error("EWF components have invalid values or inconsistent branch, employee, or currency identity.");
  }
  const state = ewfEntityStatus(data, branchId, month);
  const membershipProrationMethod = "Dated items are allocated before the provident-fund join date; covered spans are prorated evenly by calendar day (approximation). Undated amounts conservatively remain eligible rather than receiving an unverified exemption.";
  if (state.country !== "TH" || state.entityId === null) {
    return { status: "not-configured", entityId: "", headcount: 0, wageBase: 0, employeeRate: 0, employerRate: 0, employeeAmount: 0, employerAmount: 0,
      componentManifest: components.map((component) => ({ ...component, included: false, eligibleAmount: 0, membershipExemptAmount: 0 })),
      membershipProrationMethod };
  }
  if (state.status === "before-effective-date") {
    return {
      status: "before-effective-date", entityId: state.entityId, headcount: state.headcount,
      wageBase: 0, employeeRate: 0, employerRate: 0, employeeAmount: 0, employerAmount: 0,
      componentManifest: components.map((component) => ({ ...component, included: false, eligibleAmount: 0, membershipExemptAmount: 0 })),
      membershipProrationMethod,
    };
  }
  const version = effectiveEwfSettings(data, branchId, month);
  const settings = version?.settings;
  const start = `${month}-01`;
  const end = `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}`;
  const membershipDate = staff.ewfMembership?.membershipJoinDate;
  const hasProvidentExemption = !!settings?.providentFundAvailable && !!membershipDate && membershipDate <= end;
  const exemptAllMonth = hasProvidentExemption && membershipDate! <= start;
  const active = state.status === "active";
  const manifest = components.map((component) => {
    let eligibleAmount = active && component.countsAsWage ? component.amount : 0;
    let prorationNote: string | undefined;
    if (eligibleAmount > 0 && hasProvidentExemption) {
      if (exemptAllMonth) {
        eligibleAmount = 0;
      } else if (component.earnedOn !== undefined) {
        if (component.earnedOn >= membershipDate!) eligibleAmount = 0;
      } else if (component.coversFrom !== undefined && component.coversThrough !== undefined) {
        const totalDays = calendarDaysBetween(component.coversFrom, component.coversThrough);
        const eligibleThrough = membershipDate! <= component.coversFrom
          ? ""
          : membershipDate! > component.coversThrough
            ? component.coversThrough
            : new Date(Date.parse(`${membershipDate!}T00:00:00.000Z`) - 86400000).toISOString().slice(0, 10);
        const eligibleDays = eligibleThrough
          ? Math.max(0, calendarDaysBetween(component.coversFrom, eligibleThrough))
          : 0;
        eligibleAmount = roundMoney(component.amount * eligibleDays / totalDays);
        prorationNote = "Span amount assumed evenly earned on each calendar day before membership starts.";
      } else {
        prorationNote = "No earning date/span supplied; full wage amount is conservatively included.";
      }
    }
    eligibleAmount = roundMoney(eligibleAmount);
    const membershipExemptAmount = component.countsAsWage && active
      ? roundMoney(component.amount - eligibleAmount)
      : 0;
    return {
      ...component, included: eligibleAmount > 0, eligibleAmount, membershipExemptAmount,
      ...(prorationNote ? { prorationNote } : {}),
    };
  });
  const wageBase = roundMoney(manifest.reduce((sum, item) => sum + item.eligibleAmount, 0));
  const employeeRate = active ? settings!.employeeRate : 0;
  const employerRate = active ? settings!.employerRate : 0;
  const status = !settings ? "not-configured" : !active ? "below-threshold" : exemptAllMonth ? "provident-fund-exempt" : "active";
  return {
    status, entityId: state.entityId, headcount: state.headcount, wageBase, employeeRate, employerRate,
    employeeAmount: Math.round(wageBase * employeeRate * 100) / 100,
    employerAmount: Math.round(wageBase * employerRate * 100) / 100,
    componentManifest: manifest,
    membershipProrationMethod,
  };
}