/**
 * Payroll setup (SCRUM-567, R2): paying entities and accounts, dated branch
 * payroll details, the company-v1 rule sets, deduction lists, welfare fund
 * settings and remittances, and the revenue stream catalogue — every read and
 * write fenced to one park group (tenant), every write with a reason and a row
 * in the setup audit (payroll_profile_changes).
 *
 * Plan: docs/progress/plans/payroll-real-build/PLAN.md §1, §4, §8. Nothing here
 * invents a park value: the one row made without an administrator is the Thai
 * rule set, by the same SQL function migration 0021 ran for every park group.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  branches,
  operators,
  payrollBranchDetailsVersions,
  payrollEwfRemittances,
  payrollEwfSettingsVersions,
  payrollPayingAccounts,
  payrollPayingEntities,
  payrollProfileChanges,
  payrollRevenueStreams,
  payrollRuleLists,
  statutoryRuleSets,
  users,
} from "@shared/schema";
import {
  BANK_FILE_FORMATS,
  type BranchDetails,
  type CountryCode,
  type DeductionListVersion,
  type DeductionRule,
  type DatedBranchDetails,
  type EwfRemittance,
  type EwfSettings,
  type EwfSettingsVersion,
  type PayingAccount,
  type PayingEntity,
  type PayrollSetupBranch,
  type PayrollSetupChange,
  type PayrollSetupView,
  type RevenueStream,
  type RuleSetVersion,
  type StatutoryRules,
} from "@shared/payroll-config";
import { db } from "../db";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A refusal the route answers as is: status, words, and the prototype's list of problems when there is one. */
export class PayrollRefusal extends Error {
  constructor(public status: number, message: string, public errors?: string[]) { super(message); }
}

export interface PayrollActor { userId: string; name: string }

/**
 * Malaysia stays dormant configuration (owner, 2026-10-20; plan §4): the forms
 * offer it only behind a platform flag that nothing sets, so the server refuses
 * it. No MY row is ever written.
 */
export const MALAYSIA_OFFERED = false;
const COUNTRY_REFUSAL = "Only Thailand payroll is live. Malaysia is kept as dormant configuration and cannot be chosen.";

const iso = (value: Date | string | null | undefined) => value == null ? "" : value instanceof Date ? value.toISOString() : String(value);
const num = (value: string | number | null | undefined) => value == null ? null : Number(value);
const isMonth = (value: unknown): value is string => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
export const isIsoDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const text = (value: unknown, max = 300) => typeof value === "string" ? value.trim().slice(0, max) : "";
const optionalText = (value: unknown, max = 300) => { const t = text(value, max); return t ? t : null; };
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);

export function requireReason(value: unknown): string {
  const reason = text(value, 500);
  if (!reason) throw new PayrollRefusal(400, "A reason is required.");
  return reason;
}

function allowCountry(country: unknown): CountryCode {
  if (country === "TH") return "TH";
  if (country === "MY" && MALAYSIA_OFFERED) return "MY";
  throw new PayrollRefusal(400, country === "MY" ? COUNTRY_REFUSAL : "Choose a country.");
}

/** One row of the setup audit, in the caller's transaction. */
export async function recordChange(tx: Tx | Db, tenantId: string, actor: PayrollActor, change: {
  kind: "profile" | "profile-draft" | "setup"; subject: string; subjectId?: string | null; profileId?: string | null;
  reason: string; oldValue: unknown; newValue: unknown;
}): Promise<void> {
  await tx.insert(payrollProfileChanges).values({
    tenantId, profileId: change.profileId ?? null, kind: change.kind, subject: change.subject,
    subjectId: change.subjectId ?? null, reason: change.reason,
    oldValue: change.oldValue ?? null, newValue: change.newValue ?? null,
    actorUserId: actor.userId, actorName: actor.name,
  });
}

/** The park group's Thai rule set, made by migration 0021's function when it has none - the ONLY runner of that function: the migration defines it but never calls it, so the restore rehearsal's row counts hold. */
export async function ensureTenantPayrollRuleSets(tenantId: string): Promise<number> {
  const result = await db.execute(sql`select seed_tenant_payroll_rule_sets(${tenantId}::uuid) as made`);
  return Number((result.rows[0] as { made?: number } | undefined)?.made ?? 0);
}

// ─── Read ────────────────────────────────────────────────────────────────────

const entityOut = (row: typeof payrollPayingEntities.$inferSelect): PayingEntity => ({
  id: row.id, name: row.name, country: row.country, taxId: row.taxId ?? undefined,
  ssoEmployerNumber: row.ssoEmployerNumber ?? undefined, operatorId: row.operatorId, defaultPayDay: row.defaultPayDay,
  archivedAt: row.archivedAt ? iso(row.archivedAt) : null,
});
const accountOut = (row: typeof payrollPayingAccounts.$inferSelect): PayingAccount => ({
  id: row.id, entityId: row.entityId, label: row.label, bank: row.bank, bankCode: row.bankCode ?? undefined,
  accountNumber: row.accountNumber, accountName: row.accountName, fileFormat: row.fileFormat,
  scbProduct: row.scbProduct ?? undefined, debitAccount: row.debitAccount ?? undefined, feeAccount: row.feeAccount ?? undefined,
  archivedAt: row.archivedAt ? iso(row.archivedAt) : null,
});

async function actorNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Map();
  const rows = await db.select({ id: users.id, fullName: users.fullName, email: users.email }).from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((row) => [row.id, row.fullName || row.email]));
}

export async function loadPayingConfiguration(tenantId: string) {
  const [entities, accounts] = await Promise.all([
    db.select().from(payrollPayingEntities).where(eq(payrollPayingEntities.tenantId, tenantId)).orderBy(asc(payrollPayingEntities.name)),
    db.select().from(payrollPayingAccounts).where(eq(payrollPayingAccounts.tenantId, tenantId)).orderBy(asc(payrollPayingAccounts.label)),
  ]);
  return { entities: entities.map(entityOut), accounts: accounts.map(accountOut) };
}

/** Every branch of the park group with its dated payroll details, oldest first. */
export async function loadBranchDetails(tenantId: string): Promise<PayrollSetupBranch[]> {
  const [branchRows, versions] = await Promise.all([
    db.select({ id: branches.id, name: branches.name, timezone: branches.timezone }).from(branches)
      .where(eq(branches.tenantId, tenantId)).orderBy(asc(branches.name)),
    db.select().from(payrollBranchDetailsVersions).where(eq(payrollBranchDetailsVersions.tenantId, tenantId))
      .orderBy(asc(payrollBranchDetailsVersions.effectiveFrom)),
  ]);
  const names = await actorNames(versions.map((v) => v.createdBy));
  return branchRows.map((branch) => ({
    ...branch,
    detailsHistory: versions.filter((v) => v.branchId === branch.id).map((v): DatedBranchDetails => ({
      id: v.id, effectiveFrom: iso(v.effectiveFrom),
      details: {
        ...(v.details as Omit<BranchDetails, "payingEntityId" | "defaultPayingAccountId">),
        payingEntityId: v.payingEntityId ?? undefined,
        defaultPayingAccountId: v.defaultPayingAccountId ?? undefined,
      },
      foodAllowanceDefault: num(v.foodAllowanceDefault),
      reason: v.reason, who: (v.createdBy && names.get(v.createdBy)) || "", at: iso(v.createdAt),
    })),
  }));
}

export async function loadSetup(tenantId: string): Promise<Omit<PayrollSetupView, "canManage">> {
  await ensureTenantPayrollRuleSets(tenantId);
  const [{ entities, accounts }, branchList, ruleRows, listRows, ewfRows, remittanceRows, streamRows] = await Promise.all([
    loadPayingConfiguration(tenantId),
    loadBranchDetails(tenantId),
    db.select().from(statutoryRuleSets).where(and(eq(statutoryRuleSets.tenantId, tenantId), eq(statutoryRuleSets.ruleFormat, "company-v1")))
      .orderBy(asc(statutoryRuleSets.effectiveFrom)),
    db.select().from(payrollRuleLists).where(eq(payrollRuleLists.tenantId, tenantId)).orderBy(asc(payrollRuleLists.effectiveFrom)),
    db.select().from(payrollEwfSettingsVersions).where(eq(payrollEwfSettingsVersions.tenantId, tenantId)).orderBy(asc(payrollEwfSettingsVersions.effectiveFrom)),
    db.select().from(payrollEwfRemittances).where(eq(payrollEwfRemittances.tenantId, tenantId)).orderBy(desc(payrollEwfRemittances.month)),
    db.select().from(payrollRevenueStreams).where(eq(payrollRevenueStreams.tenantId, tenantId)).orderBy(asc(payrollRevenueStreams.label)),
  ]);
  const names = await actorNames([...ruleRows, ...listRows, ...ewfRows, ...remittanceRows].map((r) => r.createdBy));
  const who = (id: string | null) => (id && names.get(id)) || "";
  return {
    entities, accounts, branches: branchList,
    ruleSets: ruleRows.map((r): RuleSetVersion => ({
      id: r.id, country: r.countryCode as CountryCode, branchId: r.branchId, effectiveFrom: iso(r.effectiveFrom).slice(0, 7),
      rules: r.rules as StatutoryRules, name: r.name, reason: r.description ?? "", who: who(r.createdBy), at: iso(r.createdAt),
    })),
    deductionLists: listRows.map((r): DeductionListVersion => ({
      id: r.id, scope: r.scope, branchId: r.branchId, effectiveFrom: iso(r.effectiveFrom), rules: r.rules as DeductionRule[],
      reason: r.reason, who: who(r.createdBy), at: iso(r.createdAt),
    })),
    ewfSettings: ewfRows.map((r): EwfSettingsVersion => ({
      id: r.id, entityId: r.entityId, effectiveFrom: iso(r.effectiveFrom), settings: r.settings as EwfSettings,
      reason: r.reason, who: who(r.createdBy), at: iso(r.createdAt),
    })),
    ewfRemittances: remittanceRows.map((r): EwfRemittance => ({
      id: r.id, entityId: r.entityId, month: r.month, amountPaid: Number(r.amountPaid), paidOn: r.paidOn ? iso(r.paidOn) : null,
      reason: r.reason, who: who(r.createdBy), at: iso(r.updatedAt),
    })),
    revenueStreams: streamRows.map((r): RevenueStream => ({ id: r.id, key: r.key, label: r.label, archivedAt: r.archivedAt ? iso(r.archivedAt) : null })),
  };
}

export async function listSetupChanges(tenantId: string, limit = 100): Promise<PayrollSetupChange[]> {
  const rows = await db.select().from(payrollProfileChanges)
    .where(and(eq(payrollProfileChanges.tenantId, tenantId), eq(payrollProfileChanges.kind, "setup")))
    .orderBy(desc(payrollProfileChanges.createdAt)).limit(Math.min(Math.max(limit, 1), 500));
  return rows.map(changeOut);
}

export const changeOut = (row: typeof payrollProfileChanges.$inferSelect): PayrollSetupChange => ({
  id: row.id, kind: row.kind, subject: row.subject, subjectId: row.subjectId, reason: row.reason,
  who: row.actorName, at: iso(row.createdAt), oldValue: row.oldValue, newValue: row.newValue,
});

// ─── Paying entities and accounts ────────────────────────────────────────────

async function operatorOfTenant(tx: Tx, tenantId: string, operatorId: unknown): Promise<string | null> {
  if (operatorId == null || operatorId === "") return null;
  if (typeof operatorId !== "string") throw new PayrollRefusal(400, "Choose an operator from this park group.");
  const [row] = await tx.select({ id: operators.id }).from(operators)
    .where(and(eq(operators.tenantId, tenantId), sql`${operators.id}::text = ${operatorId}`)).limit(1);
  if (!row) throw new PayrollRefusal(400, "Choose an operator from this park group.");
  return row.id;
}

function entityFields(input: Record<string, unknown>) {
  const name = text(input.name, 200);
  if (!name) throw new PayrollRefusal(400, "Entity ID, name and country are required.");
  const defaultPayDay = input.defaultPayDay === undefined ? 28 : input.defaultPayDay;
  if (!Number.isInteger(defaultPayDay) || (defaultPayDay as number) < 1 || (defaultPayDay as number) > 31) {
    throw new PayrollRefusal(400, "The default pay day must be a day of the month (1 to 31).");
  }
  return {
    name, country: allowCountry(input.country), taxId: optionalText(input.taxId, 40),
    ssoEmployerNumber: optionalText(input.ssoEmployerNumber, 40), defaultPayDay: defaultPayDay as number,
  };
}

export async function createEntity(tenantId: string, actor: PayrollActor, input: Record<string, unknown>) {
  const reason = requireReason(input.reason);
  const fields = entityFields(input);
  return db.transaction(async (tx) => {
    const operatorId = await operatorOfTenant(tx, tenantId, input.operatorId);
    const [row] = await tx.insert(payrollPayingEntities).values({ tenantId, ...fields, operatorId, createdBy: actor.userId }).returning();
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "entity", subjectId: row.id, reason, oldValue: null, newValue: entityOut(row) });
    return entityOut(row);
  });
}

async function entityRow(tx: Tx, tenantId: string, id: string) {
  const [row] = await tx.select().from(payrollPayingEntities)
    .where(and(eq(payrollPayingEntities.tenantId, tenantId), sql`${payrollPayingEntities.id}::text = ${id}`)).limit(1).for("update");
  if (!row) throw new PayrollRefusal(404, "Paying entity not found");
  return row;
}

export async function updateEntity(tenantId: string, actor: PayrollActor, id: string, input: Record<string, unknown>) {
  const reason = requireReason(input.reason);
  return db.transaction(async (tx) => {
    const before = await entityRow(tx, tenantId, id);
    const fields = entityFields({ ...entityOut(before), ...input });
    if (fields.country !== before.country) {
      const [used] = await tx.select({ id: payrollPayingAccounts.id }).from(payrollPayingAccounts)
        .where(and(eq(payrollPayingAccounts.tenantId, tenantId), eq(payrollPayingAccounts.entityId, before.id))).limit(1);
      if (used) throw new PayrollRefusal(409, "This entity already has bank accounts; its country cannot change.");
    }
    const operatorId = input.operatorId === undefined ? before.operatorId : await operatorOfTenant(tx, tenantId, input.operatorId);
    const [row] = await tx.update(payrollPayingEntities).set({ ...fields, operatorId, updatedAt: new Date() })
      .where(and(eq(payrollPayingEntities.tenantId, tenantId), eq(payrollPayingEntities.id, before.id))).returning();
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "entity", subjectId: row.id, reason, oldValue: entityOut(before), newValue: entityOut(row) });
    return entityOut(row);
  });
}

export async function archiveEntity(tenantId: string, actor: PayrollActor, id: string, input: Record<string, unknown>) {
  const reason = requireReason(input.reason);
  return db.transaction(async (tx) => {
    const before = await entityRow(tx, tenantId, id);
    const [row] = await tx.update(payrollPayingEntities).set({ archivedAt: before.archivedAt ?? new Date(), updatedAt: new Date() })
      .where(and(eq(payrollPayingEntities.tenantId, tenantId), eq(payrollPayingEntities.id, before.id))).returning();
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "entity", subjectId: row.id, reason, oldValue: entityOut(before), newValue: entityOut(row) });
    return entityOut(row);
  });
}

function accountFields(input: Record<string, unknown>) {
  const fields = {
    label: text(input.label, 120), bank: text(input.bank, 120), accountName: text(input.accountName, 200),
    accountNumber: text(input.accountNumber, 40), bankCode: optionalText(input.bankCode, 10),
    debitAccount: optionalText(input.debitAccount, 40), feeAccount: optionalText(input.feeAccount, 40),
  };
  if (!fields.label || !fields.bank || !fields.accountName || !fields.accountNumber) {
    throw new PayrollRefusal(400, "Complete every paying account and assign its entity.");
  }
  if (!BANK_FILE_FORMATS.includes(input.fileFormat as never)) throw new PayrollRefusal(400, "Complete every paying account and assign its entity.");
  const scbProduct = input.scbProduct == null || input.scbProduct === "" ? null : input.scbProduct;
  if (scbProduct !== null && scbProduct !== "PAY" && scbProduct !== "SPN") throw new PayrollRefusal(400, "The SCB product is PAY or SPN.");
  return { ...fields, fileFormat: input.fileFormat as PayingAccount["fileFormat"], scbProduct: scbProduct as "PAY" | "SPN" | null };
}

export async function createAccount(tenantId: string, actor: PayrollActor, input: Record<string, unknown>) {
  const reason = requireReason(input.reason);
  const fields = accountFields(input);
  return db.transaction(async (tx) => {
    const entity = await entityRow(tx, tenantId, String(input.entityId ?? ""));
    if (entity.archivedAt) throw new PayrollRefusal(409, "This entity is archived.");
    const [row] = await tx.insert(payrollPayingAccounts).values({ tenantId, entityId: entity.id, ...fields, createdBy: actor.userId }).returning();
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "account", subjectId: row.id, reason, oldValue: null, newValue: accountOut(row) });
    return accountOut(row);
  });
}

async function accountRow(tx: Tx, tenantId: string, id: string) {
  const [row] = await tx.select().from(payrollPayingAccounts)
    .where(and(eq(payrollPayingAccounts.tenantId, tenantId), sql`${payrollPayingAccounts.id}::text = ${id}`)).limit(1).for("update");
  if (!row) throw new PayrollRefusal(404, "Paying account not found");
  return row;
}

export async function updateAccount(tenantId: string, actor: PayrollActor, id: string, input: Record<string, unknown>) {
  const reason = requireReason(input.reason);
  return db.transaction(async (tx) => {
    const before = await accountRow(tx, tenantId, id);
    const fields = accountFields({ ...accountOut(before), ...input });
    if (input.entityId !== undefined && input.entityId !== before.entityId) {
      throw new PayrollRefusal(409, "An account stays with its entity; add a new account for another entity.");
    }
    const [row] = await tx.update(payrollPayingAccounts).set({ ...fields, updatedAt: new Date() })
      .where(and(eq(payrollPayingAccounts.tenantId, tenantId), eq(payrollPayingAccounts.id, before.id))).returning();
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "account", subjectId: row.id, reason, oldValue: accountOut(before), newValue: accountOut(row) });
    return accountOut(row);
  });
}

export async function archiveAccount(tenantId: string, actor: PayrollActor, id: string, input: Record<string, unknown>) {
  const reason = requireReason(input.reason);
  return db.transaction(async (tx) => {
    const before = await accountRow(tx, tenantId, id);
    const [row] = await tx.update(payrollPayingAccounts).set({ archivedAt: before.archivedAt ?? new Date(), updatedAt: new Date() })
      .where(and(eq(payrollPayingAccounts.tenantId, tenantId), eq(payrollPayingAccounts.id, before.id))).returning();
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "account", subjectId: row.id, reason, oldValue: accountOut(before), newValue: accountOut(row) });
    return accountOut(row);
  });
}

// ─── Branch payroll details ──────────────────────────────────────────────────

const SSO_BRANCH_NUMBER = /^\d{6}$/;

export async function saveBranchDetails(tenantId: string, actor: PayrollActor, branchId: string, input: Record<string, unknown>) {
  const reason = requireReason(input.reason);
  if (!isIsoDate(input.effectiveFrom)) throw new PayrollRefusal(400, "Choose the date these details start from.");
  const raw = (input.details ?? {}) as Record<string, unknown>;
  const country = allowCountry(raw.country);
  const ssoBranchNumber = optionalText(raw.ssoBranchNumber, 6);
  if (ssoBranchNumber && !SSO_BRANCH_NUMBER.test(ssoBranchNumber)) throw new PayrollRefusal(400, "The SSO branch number is six digits.");
  const payDate = raw.payDate === "last" ? "last" : raw.payDate;
  if (payDate !== "last" && (!Number.isInteger(payDate) || (payDate as number) < 1 || (payDate as number) > 31)) {
    throw new PayrollRefusal(400, "The pay date is a day of the month (1 to 31) or the last day.");
  }
  const food = input.foodAllowanceDefault;
  if (food != null && food !== "" && !(finite(food) && (food as number) >= 0)) throw new PayrollRefusal(400, "The food allowance default must be a non-negative amount.");

  return db.transaction(async (tx) => {
    const [branch] = await tx.select({ id: branches.id, name: branches.name, timezone: branches.timezone }).from(branches)
      .where(and(eq(branches.tenantId, tenantId), eq(branches.id, branchId))).limit(1);
    if (!branch) throw new PayrollRefusal(404, "Branch not found");
    let payingEntityId: string | null = null;
    let defaultPayingAccountId: string | null = null;
    if (raw.payingEntityId) {
      const entity = await entityRow(tx, tenantId, String(raw.payingEntityId));
      if (entity.country !== country) throw new PayrollRefusal(400, `The paying entity must be a ${country} entity.`);
      payingEntityId = entity.id;
    }
    if (raw.defaultPayingAccountId) {
      const account = await accountRow(tx, tenantId, String(raw.defaultPayingAccountId));
      if (account.entityId !== payingEntityId) throw new PayrollRefusal(400, "Each branch default account must belong to the branch's entity.");
      defaultPayingAccountId = account.id;
    }
    const details = {
      ssoBranchNumber: ssoBranchNumber ?? undefined,
      name: text(raw.name, 200) || branch.name,
      legalEntity: text(raw.legalEntity, 200),
      employerNumber: text(raw.employerNumber, 40),
      taxId: text(raw.taxId, 40),
      address: text(raw.address, 500),
      country,
      currency: country === "TH" ? "THB" : "MYR",
      timezone: text(raw.timezone, 64) || branch.timezone,
      payDate,
      payrollBank: text(raw.payrollBank, 120),
      approvalChain: ["GM", "Owner"],
    };
    const effectiveFrom = input.effectiveFrom as string;
    const [before] = await tx.select().from(payrollBranchDetailsVersions).where(and(
      eq(payrollBranchDetailsVersions.tenantId, tenantId), eq(payrollBranchDetailsVersions.branchId, branch.id),
      eq(payrollBranchDetailsVersions.effectiveFrom, effectiveFrom))).limit(1).for("update");
    const values = {
      payingEntityId, defaultPayingAccountId, details,
      foodAllowanceDefault: food == null || food === "" ? null : String(food), reason, createdBy: actor.userId,
    };
    const [row] = before
      ? await tx.update(payrollBranchDetailsVersions).set({ ...values, createdAt: new Date() })
        .where(and(eq(payrollBranchDetailsVersions.tenantId, tenantId), eq(payrollBranchDetailsVersions.id, before.id))).returning()
      : await tx.insert(payrollBranchDetailsVersions).values({ tenantId, branchId: branch.id, effectiveFrom, ...values }).returning();
    const shape = (v: typeof row | undefined) => v ? { effectiveFrom: iso(v.effectiveFrom), payingEntityId: v.payingEntityId, defaultPayingAccountId: v.defaultPayingAccountId, details: v.details, foodAllowanceDefault: num(v.foodAllowanceDefault) } : null;
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "branch-details", subjectId: branch.id, reason, oldValue: shape(before), newValue: shape(row) });
    return shape(row);
  });
}

// ─── Rule sets (company-v1) ──────────────────────────────────────────────────

const RULE_KEYS: (keyof StatutoryRules)[] = ["effectiveFrom", "country", "thSso", "thPit", "my", "serviceCharge", "lunchByRole",
  "overtimeMultipliers", "overtimeEligibilityByRole", "hourlyBase", "calendarProration", "allowances", "componentFlags"];

/** The shape checks the prototype's editor applies before a rules version is saved. */
export function checkStatutoryRules(rules: StatutoryRules): string[] {
  const errors: string[] = [];
  for (const key of RULE_KEYS) if (!(key in rules)) errors.push(`The rules are missing ${key}.`);
  if (errors.length) return errors;
  const rate = (v: unknown) => finite(v) && (v as number) >= 0 && (v as number) <= 1;
  if (!rate(rules.thSso.employeeRate) || !rate(rules.thSso.employerRate)) errors.push("SSO rates must be between 0 and 100%.");
  if (!finite(rules.thSso.wageCap) || rules.thSso.wageCap < 0) errors.push("The SSO wage cap must be a non-negative amount.");
  const brackets = rules.thPit.brackets;
  if (!Array.isArray(brackets) || !brackets.length) errors.push("PIT needs at least one bracket.");
  else {
    brackets.forEach((b, i) => {
      if (!finite(b.from) || !rate(b.rate) || (b.to !== null && (!finite(b.to) || b.to <= b.from))) errors.push(`PIT bracket ${i + 1} is invalid.`);
      if (i > 0 && brackets[i - 1].to !== b.from) errors.push(`PIT bracket ${i + 1} must start where the one before ends.`);
    });
    if (brackets[brackets.length - 1].to !== null) errors.push("The final PIT bracket has no upper limit.");
  }
  if (!rate(rules.thPit.employmentExpenseRate)) errors.push("The employment expense rate must be between 0 and 100%.");
  for (const value of [rules.thPit.employmentExpenseCap, rules.thPit.personalAllowance]) {
    if (!finite(value) || value < 0) errors.push("PIT amounts must be non-negative.");
  }
  for (const value of Object.values(rules.overtimeMultipliers)) if (!finite(value) || value < 0) errors.push("Overtime multipliers must be non-negative.");
  for (const value of Object.values(rules.hourlyBase)) if (!finite(value) || value <= 0) errors.push("The hourly base must be positive.");
  if (!["actual-calendar-days", "fixed-divisor"].includes(rules.calendarProration.method) || !finite(rules.calendarProration.divisor) || rules.calendarProration.divisor <= 0) {
    errors.push("Choose actual calendar days or a positive fixed divisor.");
  }
  if (!Array.isArray(rules.allowances) || rules.allowances.some((a) => !a || !text(a.id) || !text(a.name) || !finite(a.amount) || a.amount < 0)) {
    errors.push("Every fixed allowance needs an id, a name and a non-negative amount.");
  }
  return Array.from(new Set(errors));
}

export async function saveRuleSet(tenantId: string, actor: PayrollActor, input: Record<string, unknown>) {
  const reason = requireReason(input.reason);
  const country = allowCountry(input.country);
  if (!isMonth(input.effectiveFrom)) throw new PayrollRefusal(400, "Choose the month these rates start from.");
  const effectiveMonth = input.effectiveFrom as string;
  const rules = input.rules as StatutoryRules;
  if (!rules || typeof rules !== "object") throw new PayrollRefusal(400, "The rules are missing.");
  const normalized = { ...rules, effectiveFrom: effectiveMonth, country } as StatutoryRules;
  const errors = checkStatutoryRules(normalized);
  if (errors.length) throw new PayrollRefusal(400, "These rules cannot be saved.", errors);
  const branchId = input.branchId ? String(input.branchId) : null;
  return db.transaction(async (tx) => {
    if (branchId) {
      const [branch] = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.tenantId, tenantId), eq(branches.id, branchId))).limit(1);
      if (!branch) throw new PayrollRefusal(404, "Branch not found");
    }
    const effectiveFrom = `${effectiveMonth}-01`;
    const [before] = await tx.select().from(statutoryRuleSets).where(and(
      eq(statutoryRuleSets.tenantId, tenantId), eq(statutoryRuleSets.ruleFormat, "company-v1"),
      eq(statutoryRuleSets.countryCode, country), branchId ? eq(statutoryRuleSets.branchId, branchId) : isNull(statutoryRuleSets.branchId),
      eq(statutoryRuleSets.effectiveFrom, effectiveFrom))).limit(1).for("update");
    const name = branchId ? "Thailand payroll rules (branch exception)" : "Thailand payroll rules";
    const [row] = before
      ? await tx.update(statutoryRuleSets).set({ rules: normalized, description: reason, createdBy: actor.userId, updatedAt: new Date() })
        .where(and(eq(statutoryRuleSets.tenantId, tenantId), eq(statutoryRuleSets.id, before.id))).returning()
      : await tx.insert(statutoryRuleSets).values({
        tenantId, countryCode: country, branchId, name, description: reason, effectiveFrom, rules: normalized,
        status: "active", ruleFormat: "company-v1", createdBy: actor.userId,
      }).returning();
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "rule-set", subjectId: row.id, reason, oldValue: before?.rules ?? null, newValue: row.rules });
    return { id: row.id, country, branchId, effectiveFrom: effectiveMonth, rules: normalized };
  });
}

// ─── Deduction lists ─────────────────────────────────────────────────────────

const ISSUES = ["late", "early-departure", "missed-punch", "no-show", "break-overrun"];
export function checkDeductionRules(rules: unknown): string[] {
  if (!Array.isArray(rules)) return ["The deduction rules must be a list."];
  const errors: string[] = [];
  const nullableCount = (v: unknown) => v === null || (Number.isInteger(v) && (v as number) >= 0);
  const strings = (v: unknown) => Array.isArray(v) && v.every((item) => typeof item === "string");
  rules.forEach((rule: DeductionRule, i) => {
    const label = `Rule ${i + 1}`;
    if (!rule || !text(rule.id) || !text(rule.name)) errors.push(`${label} needs an id and a name.`);
    if (!ISSUES.includes(rule?.issue)) errors.push(`${label}: choose the attendance issue it charges.`);
    if (typeof rule?.enabled !== "boolean") errors.push(`${label}: switch it on or off.`);
    if (!["fixed", "per-minute", "percent"].includes(rule?.method)) errors.push(`${label}: choose how it is charged.`);
    if (!["service-charge", "salary"].includes(rule?.source)) errors.push(`${label}: choose service charge or salary.`);
    if (!finite(rule?.amount) || rule.amount < 0) errors.push(`${label}: the amount must be non-negative.`);
    if (!(rule?.cap === null || (finite(rule?.cap) && rule.cap >= 0))) errors.push(`${label}: the cap must be empty or non-negative.`);
    if (!nullableCount(rule?.freeOccurrences) || !nullableCount(rule?.freeMinutes)) errors.push(`${label}: free allowances must be empty or whole numbers.`);
    if (!strings(rule?.roles) || !strings(rule?.includeStaffIds) || !strings(rule?.excludeStaffIds) || (rule?.jobTitles !== undefined && !strings(rule.jobTitles))) {
      errors.push(`${label}: job titles and people must be lists.`);
    }
  });
  if (new Set(rules.map((r: DeductionRule) => r?.id)).size !== rules.length) errors.push("Rule ids must be unique.");
  return Array.from(new Set(errors));
}

export async function saveDeductionList(tenantId: string, actor: PayrollActor, input: Record<string, unknown>) {
  const reason = requireReason(input.reason);
  if (!isIsoDate(input.effectiveFrom)) throw new PayrollRefusal(400, "Choose the date this list starts from.");
  const scope = input.scope === "branch" ? "branch" : input.scope === "company" ? "company" : null;
  if (!scope) throw new PayrollRefusal(400, "Choose the company list or a branch exception.");
  const errors = checkDeductionRules(input.rules);
  if (errors.length) throw new PayrollRefusal(400, "These deduction rules cannot be saved.", errors);
  const rules = input.rules as DeductionRule[];
  const branchId = scope === "branch" ? String(input.branchId ?? "") : null;
  return db.transaction(async (tx) => {
    if (scope === "branch") {
      const [branch] = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.tenantId, tenantId), eq(branches.id, branchId!))).limit(1);
      if (!branch) throw new PayrollRefusal(404, "Branch not found");
    }
    const effectiveFrom = input.effectiveFrom as string;
    const [before] = await tx.select().from(payrollRuleLists).where(and(
      eq(payrollRuleLists.tenantId, tenantId), eq(payrollRuleLists.kind, "deduction"),
      branchId ? eq(payrollRuleLists.branchId, branchId) : isNull(payrollRuleLists.branchId),
      eq(payrollRuleLists.effectiveFrom, effectiveFrom))).limit(1).for("update");
    const [row] = before
      ? await tx.update(payrollRuleLists).set({ rules, reason, createdBy: actor.userId, createdAt: new Date() })
        .where(and(eq(payrollRuleLists.tenantId, tenantId), eq(payrollRuleLists.id, before.id))).returning()
      : await tx.insert(payrollRuleLists).values({ tenantId, kind: "deduction", scope, branchId, effectiveFrom, rules, reason, createdBy: actor.userId }).returning();
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "deduction-list", subjectId: row.id, reason, oldValue: before?.rules ?? null, newValue: rules });
    return { id: row.id, scope, branchId, effectiveFrom, rules };
  });
}

// ─── Welfare fund ────────────────────────────────────────────────────────────

export async function saveEwfSettings(tenantId: string, actor: PayrollActor, input: Record<string, unknown>) {
  const reason = requireReason(input.reason);
  // The start date is configuration, never a constant (plan §8): no default.
  if (!isIsoDate(input.effectiveFrom)) throw new PayrollRefusal(400, "Enter the date these welfare fund settings start from, as confirmed by the accountant.");
  const raw = (input.settings ?? {}) as Record<string, unknown>;
  const rate = (v: unknown) => finite(v) && (v as number) >= 0 && (v as number) <= 1;
  if (!rate(raw.employeeRate) || !rate(raw.employerRate)) throw new PayrollRefusal(400, "Welfare fund rates must be between 0 and 100%.");
  if (!Number.isInteger(raw.headcountThreshold) || (raw.headcountThreshold as number) < 0) throw new PayrollRefusal(400, "The headcount threshold is a whole number.");
  if (typeof raw.providentFundAvailable !== "boolean" || typeof raw.voluntaryBelowThreshold !== "boolean") throw new PayrollRefusal(400, "Answer the provident fund and voluntary questions.");
  const settings: EwfSettings = {
    employeeRate: raw.employeeRate as number, employerRate: raw.employerRate as number, headcountThreshold: raw.headcountThreshold as number,
    providentFundAvailable: raw.providentFundAvailable, voluntaryBelowThreshold: raw.voluntaryBelowThreshold,
  };
  return db.transaction(async (tx) => {
    const entity = await entityRow(tx, tenantId, String(input.entityId ?? ""));
    if (entity.country !== "TH") throw new PayrollRefusal(400, "The welfare fund applies to Thai entities.");
    const effectiveFrom = input.effectiveFrom as string;
    const [before] = await tx.select().from(payrollEwfSettingsVersions).where(and(
      eq(payrollEwfSettingsVersions.tenantId, tenantId), eq(payrollEwfSettingsVersions.entityId, entity.id),
      eq(payrollEwfSettingsVersions.effectiveFrom, effectiveFrom))).limit(1).for("update");
    const [row] = before
      ? await tx.update(payrollEwfSettingsVersions).set({ settings, reason, createdBy: actor.userId, createdAt: new Date() })
        .where(and(eq(payrollEwfSettingsVersions.tenantId, tenantId), eq(payrollEwfSettingsVersions.id, before.id))).returning()
      : await tx.insert(payrollEwfSettingsVersions).values({ tenantId, entityId: entity.id, effectiveFrom, settings, reason, createdBy: actor.userId }).returning();
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "ewf-settings", subjectId: row.id, reason, oldValue: before?.settings ?? null, newValue: settings });
    return { id: row.id, entityId: entity.id, effectiveFrom, settings };
  });
}

export async function saveEwfRemittance(tenantId: string, actor: PayrollActor, input: Record<string, unknown>) {
  const reason = requireReason(input.reason);
  if (!isMonth(input.month)) throw new PayrollRefusal(400, "Choose the month this payment covers.");
  if (!finite(input.amountPaid) || (input.amountPaid as number) < 0) throw new PayrollRefusal(400, "The amount paid must be a non-negative amount.");
  if (input.paidOn != null && input.paidOn !== "" && !isIsoDate(input.paidOn)) throw new PayrollRefusal(400, "Enter the date it was paid.");
  const paidOn = input.paidOn ? String(input.paidOn) : null;
  return db.transaction(async (tx) => {
    const entity = await entityRow(tx, tenantId, String(input.entityId ?? ""));
    const month = input.month as string;
    const [before] = await tx.select().from(payrollEwfRemittances).where(and(
      eq(payrollEwfRemittances.tenantId, tenantId), eq(payrollEwfRemittances.entityId, entity.id), eq(payrollEwfRemittances.month, month)))
      .limit(1).for("update");
    const values = { amountPaid: String(input.amountPaid), paidOn, reason, createdBy: actor.userId };
    const [row] = before
      ? await tx.update(payrollEwfRemittances).set({ ...values, updatedAt: new Date() })
        .where(and(eq(payrollEwfRemittances.tenantId, tenantId), eq(payrollEwfRemittances.id, before.id))).returning()
      : await tx.insert(payrollEwfRemittances).values({ tenantId, entityId: entity.id, month, ...values }).returning();
    const shape = (v: typeof row | undefined) => v ? { month: v.month, amountPaid: Number(v.amountPaid), paidOn: v.paidOn ? iso(v.paidOn) : null } : null;
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "ewf-remittance", subjectId: row.id, reason, oldValue: shape(before), newValue: shape(row) });
    return { id: row.id, entityId: entity.id, ...shape(row)! };
  });
}

// ─── Revenue streams ─────────────────────────────────────────────────────────

export async function createRevenueStream(tenantId: string, actor: PayrollActor, input: Record<string, unknown>) {
  const reason = requireReason(input.reason);
  const key = text(input.key, 40).toLowerCase();
  const label = text(input.label, 120);
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(key) || !label) throw new PayrollRefusal(400, "A stream needs a short key (letters, digits and dashes) and a label.");
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: payrollRevenueStreams.id }).from(payrollRevenueStreams)
      .where(and(eq(payrollRevenueStreams.tenantId, tenantId), eq(payrollRevenueStreams.key, key))).limit(1);
    if (existing) throw new PayrollRefusal(409, "A stream with this key already exists.");
    const [row] = await tx.insert(payrollRevenueStreams).values({ tenantId, key, label }).returning();
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "revenue-stream", subjectId: row.id, reason, oldValue: null, newValue: { key, label } });
    return { id: row.id, key, label, archivedAt: null };
  });
}

export async function updateRevenueStream(tenantId: string, actor: PayrollActor, id: string, input: Record<string, unknown>) {
  const reason = requireReason(input.reason);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(payrollRevenueStreams)
      .where(and(eq(payrollRevenueStreams.tenantId, tenantId), sql`${payrollRevenueStreams.id}::text = ${id}`)).limit(1).for("update");
    if (!before) throw new PayrollRefusal(404, "Revenue stream not found");
    const label = input.label === undefined ? before.label : text(input.label, 120);
    if (!label) throw new PayrollRefusal(400, "A stream needs a label.");
    const archivedAt = input.archived === true ? before.archivedAt ?? new Date() : input.archived === false ? null : before.archivedAt;
    const [row] = await tx.update(payrollRevenueStreams).set({ label, archivedAt, updatedAt: new Date() })
      .where(and(eq(payrollRevenueStreams.tenantId, tenantId), eq(payrollRevenueStreams.id, before.id))).returning();
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "revenue-stream", subjectId: row.id, reason,
      oldValue: { label: before.label, archived: !!before.archivedAt }, newValue: { label: row.label, archived: !!row.archivedAt } });
    return { id: row.id, key: row.key, label: row.label, archivedAt: row.archivedAt ? iso(row.archivedAt) : null };
  });
}
