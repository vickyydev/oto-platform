/**
 * Payroll profiles (SCRUM-567, R2): one per employee, with dated allocation
 * versions, salary advances and separate payments, fenced to one park group.
 *
 * Proposals from HR data (plan §9 R2, "Draft profiles from existing data")
 * are read-only suggestions. The global_admin draft action creates
 * `needs-review` profiles carrying identity and the worker type's flags only:
 * no salary, day rate, fee, food amount, bank account or advance is copied
 * into a profile until a payroll role saves it (that save is the review).
 * Casual workers are outside this payroll (owner, 2026-10-20): only employees
 * get profiles.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  branches,
  departments,
  employeePayrollProfiles,
  employees,
  payrollProfileAdvances,
  payrollProfileAllocations,
  payrollProfileChanges,
  payrollProfileSeparatePayments,
  payrollProfiles,
  salaryAdvances,
  type Employee,
} from "@shared/schema";
import {
  OWNER_NON_OPERATIONAL,
  WORKER_DEFAULTS,
  WORKER_LABELS,
  allocationAt,
  getPayrollReadiness,
  profileReviewWarnings,
  validatePayrollProfile,
  type AllocationLine,
  type AllocationVersion,
  type EmployeePayrollProfile,
  type PayrollProfileView,
  type PayrollRosterRow,
  type PayrollRosterView,
  type ProfileCheckContext,
  type ProfileSuggestion,
  type WorkerType,
} from "@shared/payroll-config";
import { getEmployeeDisplayName } from "../lib/employeeDisplayName";
import { db } from "../db";
import { PayrollRefusal, changeOut, isIsoDate, loadBranchDetails, loadPayingConfiguration, recordChange, requireReason, type PayrollActor } from "./setup";

type ProfileRow = typeof payrollProfiles.$inferSelect;
type AllocationRow = typeof payrollProfileAllocations.$inferSelect;
type AdvanceRow = typeof payrollProfileAdvances.$inferSelect;
type PaymentRow = typeof payrollProfileSeparatePayments.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const n = (value: string | number | null | undefined) => value == null ? 0 : Number(value);
const dateText = (value: Date | string | null | undefined) => value == null ? "" : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const money = (value: number, currency = "THB") => `${currency === "THB" ? "฿" : `${currency} `}${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** The check context: branches WITH payroll details, this park group's live entities and accounts. */
export async function loadProfileContext(tenantId: string): Promise<ProfileCheckContext> {
  const [branchList, { entities, accounts }] = await Promise.all([loadBranchDetails(tenantId), loadPayingConfiguration(tenantId)]);
  const ctx: ProfileCheckContext = { branches: {}, entities: entities.filter((e) => !e.archivedAt), accounts: accounts.filter((a) => !a.archivedAt) };
  for (const branch of branchList) {
    if (!branch.detailsHistory.length) continue;
    // The prototype reads a branch's country from its first details version (detailsHistory[0]).
    ctx.branches[branch.id] = {
      country: branch.detailsHistory[0].details.country,
      detailsHistory: branch.detailsHistory.map((v) => ({ effectiveFrom: v.effectiveFrom, defaultPayingAccountId: v.details.defaultPayingAccountId })),
    };
  }
  return ctx;
}

export function profileOut(row: ProfileRow, allocations: AllocationRow[], advances: AdvanceRow[], payments: PaymentRow[]): EmployeePayrollProfile {
  return {
    linkedEmployeeId: row.employeeId,
    department: row.department ?? undefined,
    workerType: row.workerType,
    jobTitle: row.jobTitle,
    monthlySalary: n(row.monthlySalary), dayRate: n(row.dayRate), fixedFee: n(row.fixedFee),
    joinedOn: dateText(row.joinedOn), lastWorkingDay: row.lastWorkingDay ? dateText(row.lastWorkingDay) : null,
    taxId: row.taxId, ssoNumber: row.ssoNumber,
    ssoTitle: row.ssoTitle ?? undefined, givenName: row.givenName ?? undefined, surname: row.surname ?? undefined,
    dateOfBirth: row.dateOfBirth ? dateText(row.dateOfBirth) : undefined, nationality: row.nationality ?? undefined,
    passportNumber: row.passportNumber ?? undefined, leavingReason: row.leavingReason ?? undefined,
    foodAllowanceEligible: row.foodAllowanceEligible, foodAllowancePerDay: n(row.foodAllowancePerDay),
    ssoEligible: row.ssoEligible, pnd1Eligible: row.pnd1Eligible, serviceChargeEligible: row.serviceChargeEligible, otEligible: row.otEligible,
    pnd3WithholdingPercent: n(row.pnd3WithholdingPercent), cashHandlingFeePercent: n(row.cashHandlingFeePercent),
    paymentMethod: row.paymentMethod,
    bankDetails: {
      bank: row.bankName, accountNumber: row.bankAccountNumber, accountName: row.bankAccountName,
      ...(row.bankCode ? { bankCode: row.bankCode } : {}), ...(row.bankMobile ? { mobile: row.bankMobile } : {}), ...(row.bankEmail ? { email: row.bankEmail } : {}),
    },
    thirdPartyReason: row.thirdPartyReason,
    allocations: allocations.filter((a) => a.profileId === row.id).sort((a, b) => dateText(a.effectiveFrom).localeCompare(dateText(b.effectiveFrom)))
      .map((a) => ({ effectiveFrom: dateText(a.effectiveFrom), homeBranchId: a.homeBranchId, lines: a.lines as AllocationLine[] })),
    studentLoanMonthly: n(row.studentLoanMonthly),
    advances: advances.filter((a) => a.profileId === row.id).map((a) => ({
      id: a.id, principal: n(a.principal), outstandingBalance: n(a.outstandingBalance), repaymentMode: a.repaymentMode,
      instalments: a.instalments, monthlyRepayment: n(a.monthlyRepayment), startsOn: dateText(a.startsOn),
    })),
    separatePayments: payments.filter((p) => p.profileId === row.id).map((p) => ({
      id: p.id, description: p.description, amount: n(p.amount), withholdingPercent: n(p.withholdingPercent),
    })),
    notes: row.notes,
  };
}

async function loadProfiles(tenantId: string, employeeIds?: string[]) {
  const rows = await db.select().from(payrollProfiles).where(and(eq(payrollProfiles.tenantId, tenantId),
    employeeIds ? inArray(payrollProfiles.employeeId, employeeIds.length ? employeeIds : [""]) : undefined));
  const ids = rows.map((r) => r.id);
  if (!ids.length) return { rows, allocations: [] as AllocationRow[], advances: [] as AdvanceRow[], payments: [] as PaymentRow[] };
  const [allocations, advances, payments] = await Promise.all([
    db.select().from(payrollProfileAllocations).where(and(eq(payrollProfileAllocations.tenantId, tenantId), inArray(payrollProfileAllocations.profileId, ids))),
    db.select().from(payrollProfileAdvances).where(and(eq(payrollProfileAdvances.tenantId, tenantId), inArray(payrollProfileAdvances.profileId, ids))).orderBy(asc(payrollProfileAdvances.createdAt)),
    db.select().from(payrollProfileSeparatePayments).where(and(eq(payrollProfileSeparatePayments.tenantId, tenantId), inArray(payrollProfileSeparatePayments.profileId, ids))).orderBy(asc(payrollProfileSeparatePayments.createdAt)),
  ]);
  return { rows, allocations, advances, payments };
}

const allocationBadge = (version: AllocationVersion | null, branchName: (id: string) => string) => {
  if (!version) return null;
  return version.lines.map((line) => `${line.costCentre === OWNER_NON_OPERATIONAL ? "Owner" : branchName(line.costCentre)} ${line.percent}%`).join(" · ");
};

function payLine(profile: EmployeePayrollProfile): string {
  if (profile.workerType === "day-rate") return `${money(profile.dayRate)}/day`;
  if (profile.workerType === "contractor") return `${money(profile.fixedFee)} fee`;
  return `${money(profile.monthlySalary)}/month`;
}

// ─── Roster ──────────────────────────────────────────────────────────────────

export async function loadRoster(tenantId: string, asOf: string): Promise<Omit<PayrollRosterView, "canManage" | "canDraft">> {
  const [employeeRows, branchRows, departmentRows, ctx, loaded] = await Promise.all([
    db.select().from(employees).where(eq(employees.tenantId, tenantId)),
    db.select({ id: branches.id, name: branches.name }).from(branches).where(eq(branches.tenantId, tenantId)).orderBy(asc(branches.name)),
    db.select({ id: departments.id, name: departments.name }).from(departments).where(eq(departments.tenantId, tenantId)),
    loadProfileContext(tenantId),
    loadProfiles(tenantId),
  ]);
  const branchName = (id: string) => branchRows.find((b) => b.id === id)?.name ?? "Unknown branch";
  const profiles = new Map(loaded.rows.map((row) => [row.employeeId, { row, profile: profileOut(row, loaded.allocations, loaded.advances, loaded.payments) }]));
  const named = employeeRows.flatMap((e) => {
    const entry = profiles.get(e.id);
    return entry ? [{ employeeId: e.id, name: getEmployeeDisplayName(e), profile: entry.profile }] : [];
  });
  const rows = employeeRows.map((e): PayrollRosterRow => {
    const entry = profiles.get(e.id);
    const profile = entry?.profile ?? null;
    const version = profile ? allocationAt(profile, asOf) : null;
    const home = version?.homeBranchId ?? e.branchId ?? null;
    const country = home && ctx.branches[home] ? ctx.branches[home].country : "TH";
    return {
      employeeId: e.id, name: getEmployeeDisplayName(e), branchId: e.branchId, branchName: e.branchId ? branchName(e.branchId) : null,
      department: profile?.department ?? departmentRows.find((d) => d.id === e.primaryDepartmentId)?.name ?? null,
      employmentState: e.employmentState, hasProfile: !!profile, reviewState: entry?.row.reviewState ?? null,
      workerType: profile?.workerType ?? null, jobTitle: profile?.jobTitle || e.defaultMergeData?.positionTitle || "",
      payLine: profile ? payLine(profile) : null,
      homeBranchId: home, allocationBadge: allocationBadge(version, branchName), lines: version?.lines ?? [],
      readiness: profile ? getPayrollReadiness(profile, asOf, country) : null,
      warnings: profileReviewWarnings(profile, e.id, named),
      validationErrors: profile ? validatePayrollProfile(profile, ctx).length : 0,
    };
  }).sort((a, b) => Number(a.employmentState === "LEFT") - Number(b.employmentState === "LEFT") || a.name.localeCompare(b.name));
  return { asOf, rows, branches: branchRows };
}

// ─── One profile ─────────────────────────────────────────────────────────────

async function tenantEmployee(tenantId: string, employeeId: string): Promise<Employee> {
  const [employee] = await db.select().from(employees).where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId))).limit(1);
  if (!employee) throw new PayrollRefusal(404, "Employee not found");
  return employee;
}

/** Read-only proposals from HR data and the old payroll tables. Never written to a profile by the server. */
/** An HR amount as a number, whether the record holds it as a number or as numeric text. */
function hrAmount(value: unknown): number | null {
  const amount = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value.replace(/,/g, "")) : Number.NaN;
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export async function suggestionsFor(tenantId: string, employee: Employee): Promise<ProfileSuggestion[]> {
  const out: ProfileSuggestion[] = [];
  const add = (field: string, label: string, value: string | number | null | undefined, source: string) => {
    if (value === null || value === undefined || value === "") return;
    out.push({ field, label, value, source });
  };
  const merge = employee.defaultMergeData ?? {};
  add("workerType", "Worker type", employee.employmentBasis === "PART_TIME" ? "day-rate" : "monthly", "HR employment basis");
  add("jobTitle", "Job title", merge.positionTitle?.trim(), "HR position title");
  // The HR record's department (employees.primary_department_id), the one the draft action copies.
  if (employee.primaryDepartmentId) {
    const [department] = await db.select({ name: departments.name }).from(departments)
      .where(and(eq(departments.tenantId, tenantId), eq(departments.id, employee.primaryDepartmentId))).limit(1);
    add("department", "Department", department?.name, "HR department");
  }
  add("joinedOn", "Joining date", employee.startDate ? dateText(employee.startDate) : null, "HR start date");
  add("monthlySalary", "Monthly salary", hrAmount(merge.salaryThb), "HR contract salary");
  add("dayRate", "Day rate", employee.dailyRate, "HR daily rate");
  add("foodAllowancePerDay", "Food per day", employee.foodAllowancePerDay, "HR food allowance");
  add("taxId", "Tax ID", employee.taxIdNumber, "HR tax ID");
  add("ssoNumber", "SSO number", employee.ssoNumber, "HR SSO number");
  add("nationality", "Nationality", employee.nationality, "HR nationality");
  const [legacy] = await db.select().from(employeePayrollProfiles)
    .where(and(eq(employeePayrollProfiles.tenantId, tenantId), eq(employeePayrollProfiles.employeeId, employee.id))).limit(1);
  if (legacy) {
    add("monthlySalary", "Monthly salary", legacy.baseSalaryMonthly == null ? null : Number(legacy.baseSalaryMonthly), "Old payroll profile");
    add("bankDetails.bank", "Bank", legacy.bankName, "Old payroll profile");
    add("bankDetails.accountNumber", "Account number", legacy.bankAccountNumber, "Old payroll profile");
    add("bankDetails.accountName", "Account name", legacy.bankAccountName, "Old payroll profile");
    add("taxId", "Tax ID", legacy.taxId, "Old payroll profile");
    add("ssoNumber", "SSO number", legacy.socialSecurityNumber, "Old payroll profile");
  }
  const advances = await db.select().from(salaryAdvances)
    .where(and(eq(salaryAdvances.tenantId, tenantId), eq(salaryAdvances.employeeId, employee.id), eq(salaryAdvances.status, "ACTIVE")));
  for (const advance of advances) {
    add("advance", "Salary advance outstanding", Number(advance.remainingBalance), `Old advance of ${money(Number(advance.principalAmount))} issued ${dateText(advance.issuedDate)}`);
  }
  return out;
}

export async function loadProfileView(tenantId: string, employeeId: string, asOf: string): Promise<Omit<PayrollProfileView, "canManage">> {
  const employee = await tenantEmployee(tenantId, employeeId);
  const [ctx, loaded, all, branchRow] = await Promise.all([
    loadProfileContext(tenantId),
    loadProfiles(tenantId, [employeeId]),
    loadProfiles(tenantId),
    employee.branchId ? db.select({ name: branches.name }).from(branches).where(and(eq(branches.tenantId, tenantId), eq(branches.id, employee.branchId))).limit(1) : Promise.resolve([]),
  ]);
  const row = loaded.rows[0];
  const profile = row ? profileOut(row, loaded.allocations, loaded.advances, loaded.payments) : null;
  const employeeNames = all.rows.length
    ? await db.select().from(employees).where(and(eq(employees.tenantId, tenantId), inArray(employees.id, all.rows.map((r) => r.employeeId))))
    : [];
  const others = all.rows.map((r) => ({
    employeeId: r.employeeId,
    name: (() => { const e = employeeNames.find((x) => x.id === r.employeeId); return e ? getEmployeeDisplayName(e) : ""; })(),
    profile: profileOut(r, all.allocations, all.advances, all.payments),
  }));
  const changes = row
    ? await db.select().from(payrollProfileChanges).where(and(eq(payrollProfileChanges.tenantId, tenantId), eq(payrollProfileChanges.profileId, row.id)))
      .orderBy(asc(payrollProfileChanges.createdAt))
    : [];
  const home = profile ? allocationAt(profile, asOf)?.homeBranchId : employee.branchId;
  const showSuggestions = !row || row.reviewState === "needs-review";
  return {
    employee: {
      id: employee.id, name: getEmployeeDisplayName(employee), branchId: employee.branchId, branchName: branchRow[0]?.name ?? null,
      employmentState: employee.employmentState, startDate: employee.startDate ? dateText(employee.startDate) : null,
    },
    profile, reviewState: row?.reviewState ?? null, revision: row?.revision ?? 0,
    suggestions: showSuggestions ? await suggestionsFor(tenantId, employee) : [],
    validationErrors: profile ? validatePayrollProfile(profile, ctx) : [],
    warnings: profileReviewWarnings(profile, employee.id, others),
    readiness: profile ? getPayrollReadiness(profile, asOf, home && ctx.branches[home] ? ctx.branches[home].country : "TH") : null,
    changes: changes.reverse().map(changeOut),
  };
}

// ─── Save ────────────────────────────────────────────────────────────────────

const str = (value: unknown, max = 300) => typeof value === "string" ? value.slice(0, max) : "";
const optStr = (value: unknown, max = 300) => { const t = str(value, max).trim(); return t ? t : undefined; };
const numIn = (value: unknown) => typeof value === "number" ? value : Number.NaN;

/** The submitted profile, read field by field into the prototype's shape. Anything malformed fails the prototype's checks. */
export function readProfileInput(raw: unknown, employeeId: string): EmployeePayrollProfile {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bank = (p.bankDetails && typeof p.bankDetails === "object" ? p.bankDetails : {}) as Record<string, unknown>;
  const list = (value: unknown) => Array.isArray(value) ? value.filter((item) => item && typeof item === "object") as Record<string, unknown>[] : [];
  return {
    linkedEmployeeId: employeeId,
    department: optStr(p.department, 120),
    workerType: str(p.workerType, 40) as WorkerType,
    jobTitle: str(p.jobTitle, 120),
    monthlySalary: numIn(p.monthlySalary), dayRate: numIn(p.dayRate), fixedFee: numIn(p.fixedFee),
    joinedOn: str(p.joinedOn, 10), lastWorkingDay: p.lastWorkingDay ? str(p.lastWorkingDay, 10) : null,
    taxId: str(p.taxId, 40).trim(), ssoNumber: str(p.ssoNumber, 40).trim(),
    ssoTitle: optStr(p.ssoTitle, 40), givenName: optStr(p.givenName, 120), surname: optStr(p.surname, 120),
    dateOfBirth: optStr(p.dateOfBirth, 10), nationality: optStr(p.nationality, 80), passportNumber: optStr(p.passportNumber, 40),
    leavingReason: optStr(p.leavingReason, 300),
    foodAllowanceEligible: p.foodAllowanceEligible as boolean, foodAllowancePerDay: numIn(p.foodAllowancePerDay),
    ssoEligible: p.ssoEligible as boolean, pnd1Eligible: p.pnd1Eligible as boolean,
    serviceChargeEligible: p.serviceChargeEligible as boolean, otEligible: p.otEligible as boolean,
    pnd3WithholdingPercent: numIn(p.pnd3WithholdingPercent), cashHandlingFeePercent: numIn(p.cashHandlingFeePercent),
    paymentMethod: str(p.paymentMethod, 20) as EmployeePayrollProfile["paymentMethod"],
    bankDetails: {
      bank: str(bank.bank, 120).trim(), accountNumber: str(bank.accountNumber, 40).trim(), accountName: str(bank.accountName, 200).trim(),
      bankCode: optStr(bank.bankCode, 10), mobile: optStr(bank.mobile, 30), email: optStr(bank.email, 200),
    },
    thirdPartyReason: str(p.thirdPartyReason, 300),
    allocations: list(p.allocations).map((v) => ({
      effectiveFrom: str(v.effectiveFrom, 10), homeBranchId: str(v.homeBranchId, 64),
      lines: list(v.lines).map((l) => ({
        costCentre: str(l.costCentre, 64), percent: numIn(l.percent), entityId: str(l.entityId, 64),
        payingAccountId: l.payingAccountId ? str(l.payingAccountId, 64) : null,
      })),
    })),
    studentLoanMonthly: numIn(p.studentLoanMonthly),
    advances: list(p.advances).map((a) => ({
      id: str(a.id, 64), principal: numIn(a.principal), outstandingBalance: numIn(a.outstandingBalance),
      repaymentMode: str(a.repaymentMode, 20) as "one-off" | "instalments", instalments: numIn(a.instalments),
      monthlyRepayment: numIn(a.monthlyRepayment), startsOn: str(a.startsOn, 10),
    })),
    separatePayments: list(p.separatePayments).map((s) => ({
      id: str(s.id, 64), description: str(s.description, 200), amount: numIn(s.amount), withholdingPercent: numIn(s.withholdingPercent),
    })),
    notes: str(p.notes, 4000),
  };
}

const profileColumns = (profile: EmployeePayrollProfile) => ({
  workerType: profile.workerType, jobTitle: profile.jobTitle.trim(), department: profile.department ?? null,
  monthlySalary: String(profile.monthlySalary), dayRate: String(profile.dayRate), fixedFee: String(profile.fixedFee),
  joinedOn: profile.joinedOn || null, lastWorkingDay: profile.lastWorkingDay,
  taxId: profile.taxId, ssoNumber: profile.ssoNumber, ssoTitle: profile.ssoTitle ?? null, givenName: profile.givenName ?? null,
  surname: profile.surname ?? null, dateOfBirth: profile.dateOfBirth ?? null, nationality: profile.nationality ?? null,
  passportNumber: profile.passportNumber ?? null, leavingReason: profile.leavingReason ?? null,
  foodAllowanceEligible: profile.foodAllowanceEligible, foodAllowancePerDay: String(profile.foodAllowancePerDay),
  ssoEligible: profile.ssoEligible, pnd1Eligible: profile.pnd1Eligible, serviceChargeEligible: profile.serviceChargeEligible, otEligible: profile.otEligible,
  pnd3WithholdingPercent: String(profile.pnd3WithholdingPercent), cashHandlingFeePercent: String(profile.cashHandlingFeePercent),
  paymentMethod: profile.paymentMethod,
  bankName: profile.bankDetails.bank,
  bankAccountNumber: profile.bankDetails.accountNumber, bankAccountName: profile.bankDetails.accountName,
  bankCode: profile.bankDetails.bankCode ?? null, bankMobile: profile.bankDetails.mobile ?? null, bankEmail: profile.bankDetails.email ?? null,
  thirdPartyReason: profile.thirdPartyReason, studentLoanMonthly: String(profile.studentLoanMonthly), notes: profile.notes,
});

/**
 * Saves one profile whole, by a payroll role, with a reason and the revision
 * it was read at. The prototype's checks must pass (its save refuses on any).
 * The save marks the profile reviewed.
 */
export async function saveProfile(tenantId: string, actor: PayrollActor, employeeId: string, body: Record<string, unknown>) {
  const reason = requireReason(body.reason);
  await tenantEmployee(tenantId, employeeId);
  const profile = readProfileInput(body.profile, employeeId);
  if (profile.lastWorkingDay === "") profile.lastWorkingDay = null;
  const ctx = await loadProfileContext(tenantId);
  const errors = validatePayrollProfile(profile, ctx);
  if (errors.length) throw new PayrollRefusal(400, "This profile cannot be saved yet.", errors);
  const expected = body.revision;
  if (!Number.isInteger(expected)) throw new PayrollRefusal(400, "The revision this profile was read at is required.");

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(payrollProfiles)
      .where(and(eq(payrollProfiles.tenantId, tenantId), eq(payrollProfiles.employeeId, employeeId))).limit(1).for("update");
    if ((before?.revision ?? 0) !== expected) {
      throw new PayrollRefusal(409, "This profile was changed by someone else since you opened it. Reload it and make your change again.");
    }
    let oldValue: EmployeePayrollProfile | null = null;
    let keptAdvanceIds = new Set<string>();
    let keptPaymentIds = new Set<string>();
    if (before) {
      const [allocs, advs, pays] = await Promise.all([
        tx.select().from(payrollProfileAllocations).where(and(eq(payrollProfileAllocations.tenantId, tenantId), eq(payrollProfileAllocations.profileId, before.id))),
        tx.select().from(payrollProfileAdvances).where(and(eq(payrollProfileAdvances.tenantId, tenantId), eq(payrollProfileAdvances.profileId, before.id))),
        tx.select().from(payrollProfileSeparatePayments).where(and(eq(payrollProfileSeparatePayments.tenantId, tenantId), eq(payrollProfileSeparatePayments.profileId, before.id))),
      ]);
      oldValue = profileOut(before, allocs, advs, pays);
      keptAdvanceIds = new Set(advs.map((a) => a.id));
      keptPaymentIds = new Set(pays.map((p) => p.id));
    }
    const columns = { ...profileColumns(profile), reviewState: "reviewed" as const, updatedBy: actor.userId, updatedAt: new Date() };
    const [row] = before
      ? await tx.update(payrollProfiles).set({ ...columns, revision: before.revision + 1 })
        .where(and(eq(payrollProfiles.tenantId, tenantId), eq(payrollProfiles.id, before.id))).returning()
      : await tx.insert(payrollProfiles).values({ tenantId, employeeId, ...columns, revision: 1, createdBy: actor.userId }).returning();

    await tx.delete(payrollProfileAllocations).where(and(eq(payrollProfileAllocations.tenantId, tenantId), eq(payrollProfileAllocations.profileId, row.id)));
    await tx.delete(payrollProfileAdvances).where(and(eq(payrollProfileAdvances.tenantId, tenantId), eq(payrollProfileAdvances.profileId, row.id)));
    await tx.delete(payrollProfileSeparatePayments).where(and(eq(payrollProfileSeparatePayments.tenantId, tenantId), eq(payrollProfileSeparatePayments.profileId, row.id)));
    if (profile.allocations.length) {
      await tx.insert(payrollProfileAllocations).values(profile.allocations.map((v) => ({
        tenantId, profileId: row.id, effectiveFrom: v.effectiveFrom, homeBranchId: v.homeBranchId, lines: v.lines,
      })));
    }
    // An advance or payment keeps its id across saves (later repayments are matched by it);
    // an id that is not already this profile's is replaced.
    const keep = (id: string, kept: Set<string>) => UUID.test(id) && kept.has(id) ? id : randomUUID();
    const advances = profile.advances.map((a) => ({ ...a, id: keep(a.id, keptAdvanceIds) }));
    const payments = profile.separatePayments.map((p) => ({ ...p, id: keep(p.id, keptPaymentIds) }));
    if (advances.length) {
      await tx.insert(payrollProfileAdvances).values(advances.map((a) => ({
        id: a.id, tenantId, profileId: row.id, principal: String(a.principal), outstandingBalance: String(a.outstandingBalance),
        repaymentMode: a.repaymentMode, instalments: a.instalments, monthlyRepayment: String(a.monthlyRepayment), startsOn: a.startsOn,
      })));
    }
    if (payments.length) {
      await tx.insert(payrollProfileSeparatePayments).values(payments.map((p) => ({
        id: p.id, tenantId, profileId: row.id, description: p.description.trim(), amount: String(p.amount), withholdingPercent: String(p.withholdingPercent),
      })));
    }
    const saved: EmployeePayrollProfile = { ...profile, advances, separatePayments: payments };
    await recordChange(tx, tenantId, actor, { kind: "profile", subject: "profile", subjectId: employeeId, profileId: row.id, reason, oldValue, newValue: saved });
    return { profile: saved, revision: row.revision, reviewState: row.reviewState };
  });
}

// ─── Drafts from HR data ─────────────────────────────────────────────────────

/**
 * One `needs-review` draft per current employee without a profile: identity
 * from HR (job title, joining and leaving dates, tax and SSO numbers,
 * nationality, department), the worker type HR's employment basis implies
 * with that type's flags, and a 100% allocation to the employee's branch when
 * the branch's payroll details name a paying entity. Every pay amount is zero
 * and no bank account or advance is copied: those are offered as suggestions
 * on the profile and reach it only through a payroll role's save.
 */
export async function draftProfiles(tenantId: string, actor: PayrollActor, input: Record<string, unknown>) {
  const reason = requireReason(input.reason);
  const [staff, existing, departmentRows, branchList] = await Promise.all([
    db.select().from(employees).where(and(eq(employees.tenantId, tenantId), inArray(employees.employmentState, ["ACTIVE", "LEAVING"]))),
    db.select({ employeeId: payrollProfiles.employeeId }).from(payrollProfiles).where(eq(payrollProfiles.tenantId, tenantId)),
    db.select({ id: departments.id, name: departments.name }).from(departments).where(eq(departments.tenantId, tenantId)),
    loadBranchDetails(tenantId),
  ]);
  const has = new Set(existing.map((e) => e.employeeId));
  let created = 0;
  for (const employee of staff) {
    if (has.has(employee.id)) continue;
    const workerType: WorkerType = employee.employmentBasis === "PART_TIME" ? "day-rate" : "monthly";
    const joinedOn = employee.startDate ? dateText(employee.startDate) : "";
    const branch = branchList.find((b) => b.id === employee.branchId);
    const details = branch?.detailsHistory.at(-1)?.details;
    const allocation = details?.payingEntityId && joinedOn && isIsoDate(joinedOn)
      ? { effectiveFrom: joinedOn, homeBranchId: branch!.id, lines: [{ costCentre: branch!.id, percent: 100, entityId: details.payingEntityId, payingAccountId: null }] }
      : null;
    const draft = {
      workerType, ...WORKER_DEFAULTS[workerType],
      jobTitle: (employee.defaultMergeData?.positionTitle ?? "").trim(),
      department: departmentRows.find((d) => d.id === employee.primaryDepartmentId)?.name ?? null,
      joinedOn: joinedOn || null, lastWorkingDay: employee.lastWorkingDay ? dateText(employee.lastWorkingDay) : null,
      taxId: employee.taxIdNumber ?? "", ssoNumber: employee.ssoNumber ?? "", nationality: employee.nationality ?? null,
      bankAccountName: "",
    };
    const made = await db.transaction(async (tx) => {
      const [row] = await tx.insert(payrollProfiles).values({
        tenantId, employeeId: employee.id, ...draft,
        pnd3WithholdingPercent: String(draft.pnd3WithholdingPercent), cashHandlingFeePercent: String(draft.cashHandlingFeePercent),
        reviewState: "needs-review", revision: 0, createdBy: actor.userId, updatedBy: actor.userId,
      }).onConflictDoNothing().returning();
      if (!row) return false;
      if (allocation) await tx.insert(payrollProfileAllocations).values({ tenantId, profileId: row.id, ...allocation });
      await recordChange(tx, tenantId, actor, {
        kind: "profile-draft", subject: "profile", subjectId: employee.id, profileId: row.id, reason,
        oldValue: null, newValue: { ...draft, allocations: allocation ? [allocation] : [], note: "Proposed from HR data; no pay amount copied." },
      });
      return true;
    });
    if (made) created++;
  }
  return { created, skipped: staff.length - created };
}

export { WORKER_LABELS };
