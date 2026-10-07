import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  benefitProfile,
  benefitRoleTemplate,
  branch,
  employee,
  product,
  productCategory,
  type Db,
  type EmployeeSource,
} from '@oto/db';
import {
  BENEFIT_ROLE_NAMES,
  BENEFIT_ROLES,
  businessDate,
  DEFAULT_BUSINESS_DAY_START_MINUTES,
  isEmptyBenefitProfile,
  newId,
  parseDayStart,
  resolveEffectiveBenefitProfile,
  type BenefitProfile,
  type BenefitRole,
  type DiscountTarget,
} from '@oto/shared';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import { accountNames } from './refund-slices';
import { withTx, type Exec, type OpContext } from './tx';

/**
 * Staff benefits — the role templates and each person's benefit (S2-21,
 * SCRUM-218, round 1 of docs/progress/plans/benefits/PLAN.md).
 *
 * The rules are the prototype's (§3): three role templates, Owner, Manager
 * and Staff, shared by the whole operator; a benefit role per person that is
 * separate from their login role; and an override that, while on, is the
 * person's whole profile (Q1). What the prototype kept in memory is kept
 * here, with the two things the ticket asks for that it never had (§4, §5):
 *
 *   - **Effective dates.** Every change names the trading day it counts from
 *     — today by default, never earlier — and the version in force on that
 *     day is closed rather than overwritten (`writeVersion`). A change dated
 *     tomorrow leaves today exactly as it was (H4).
 *   - **History.** Every version stays, with who saved it and when (H5). Both
 *     tables are append-only apart from the one column a later change closes.
 *
 * **Which day is "today".** The trading day of the branch the caller's
 * session is at (`businessDate`, the branch's own clock and day start) —
 * the day a sale at that till is priced on. A session at no branch takes the
 * operator's first branch, and an operator with none takes Asia/Bangkok at
 * the default 05:00 start. Whether a benefit's period turns over at that hour
 * or at midnight is the owner's (plan Q6); this is only the day a change
 * starts counting from.
 *
 * The employees are `core.employee` rows, read only: the OTO App is the
 * employee master (C13) and the copy job that fills this table is S2-17b.
 * Until it lands they are the seeded ones.
 */

type TemplateRow = typeof benefitRoleTemplate.$inferSelect;
type ProfileRow = typeof benefitProfile.$inferSelect;

export interface Actor {
  accountId: string;
  operatorId: string;
}

export interface VersionAuthor {
  accountId: string;
  name: string | null;
}

interface VersionBase {
  id: string;
  /** First trading day the version counts on. */
  effectiveFrom: string;
  /** First trading day it no longer counts on; null = runs on. Equal to `effectiveFrom`: replaced before it started. */
  effectiveTo: string | null;
  /** When it was saved. */
  createdAt: string;
  /** Who saved it; null for a version the seed wrote. */
  createdBy: VersionAuthor | null;
}

export interface TemplateVersionView extends VersionBase {
  profile: BenefitProfile;
}

export interface ProfileVersionView extends VersionBase {
  benefitRole: BenefitRole | null;
  override: BenefitProfile | null;
}

export interface TemplateView {
  role: BenefitRole;
  name: string;
  /** In force today; null when the role has never been given one. */
  current: TemplateVersionView | null;
  /** Saved for a later day, soonest first. */
  upcoming: TemplateVersionView[];
}

export interface StaffBenefitView {
  employeeId: string;
  name: string;
  nickname: string | null;
  branchId: string | null;
  branchName: string | null;
  source: EmployeeSource;
  /** Today's version; null when the person has never been given one. */
  current: ProfileVersionView | null;
  upcoming: ProfileVersionView[];
  /** What a scan would apply today: the override, or the role's template, or nothing. */
  effectiveProfile: BenefitProfile;
}

export interface EffectiveBenefitView {
  employeeId: string;
  on: string;
  benefitRole: BenefitRole | null;
  hasOverride: boolean;
  profileVersionId: string | null;
  /** The template version read; null when an override or no role decided it. */
  templateVersionId: string | null;
  profile: BenefitProfile;
  isEmpty: boolean;
}

// --- The trading day ------------------------------------------------------------------

/** "Today" for a benefit change, as the comment at the top of this file says. */
export async function benefitToday(
  db: Exec,
  input: { operatorId: string; branchId: string | null },
  now: Date = new Date(),
): Promise<string> {
  const where = input.branchId
    ? and(eq(branch.id, input.branchId), eq(branch.operatorId, input.operatorId))
    : eq(branch.operatorId, input.operatorId);
  const [br] = await db
    .select({ timezone: branch.timezone, dayStart: branch.businessDayStart })
    .from(branch)
    .where(where)
    .orderBy(asc(branch.createdAt))
    .limit(1);
  if (!br) return businessDate(now, 'Asia/Bangkok', DEFAULT_BUSINESS_DAY_START_MINUTES);
  return businessDate(now, br.timezone, parseDayStart(br.dayStart));
}

// --- Ranges ---------------------------------------------------------------------------

export interface Ranged {
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** In force on `day`: `[from, to)`. An empty range is in force on no day. */
export const inForceOn = (row: Ranged, day: string): boolean =>
  row.effectiveFrom <= day && (row.effectiveTo === null || row.effectiveTo > day);

/** Starts after `day` and is in force on some day. */
const upcomingAfter = (row: Ranged, day: string): boolean =>
  row.effectiveFrom > day && (row.effectiveTo === null || row.effectiveTo > row.effectiveFrom);

/**
 * Where a version dated `day` goes among the existing ones: the row it closes
 * (the one in force that day, if any) and the day the new one runs to — the
 * closed row's old end, or the next version already scheduled after `day`, or
 * on for good. So a change dated today in front of one already saved for next
 * week runs until next week, and next week's still happens.
 */
function placeVersion<T extends Ranged & { id: string }>(
  rows: readonly T[],
  day: string,
): { closes: T | null; runsTo: string | null } {
  const closes = rows.find((r) => inForceOn(r, day)) ?? null;
  if (closes) return { closes, runsTo: closes.effectiveTo };
  const next = rows
    .filter((r) => upcomingAfter(r, day))
    .map((r) => r.effectiveFrom)
    .sort()[0];
  return { closes: null, runsTo: next ?? null };
}

/** Key-order-independent JSON, so "nothing changed" is decided by content. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** The trading day a change counts from: today unless named, and never before today. */
function settleEffectiveFrom(requested: string | undefined, today: string): string {
  const day = requested ?? today;
  if (
    Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ||
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
  ) {
    throw new AppError(400, 'BAD_REQUEST', `"${day}" is not a date`);
  }
  if (day < today) {
    throw new AppError(
      400,
      'BENEFIT_EFFECTIVE_DATE_PAST',
      `A change cannot start before today (${today}): what was in force on a past day stays as it was.`,
    );
  }
  return day;
}

// --- Targets --------------------------------------------------------------------------

function targetsOf(profile: BenefitProfile): DiscountTarget[] {
  const out: DiscountTarget[] = [];
  for (const f of profile.freeItems ?? []) out.push(f.target);
  if (profile.credit?.target) out.push(profile.credit.target);
  if (profile.standingDiscount?.target) out.push(profile.standingDiscount.target);
  return out;
}

/**
 * Every category and menu item a profile names is the operator's own. A
 * benefit pointing at somebody else's row, or at nothing, would never apply
 * and nobody would know why.
 */
async function assertTargetsKnown(
  db: Exec,
  operatorId: string,
  profile: BenefitProfile,
): Promise<void> {
  const categoryIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const t of targetsOf(profile)) {
    if (t.kind === 'fnbCategory') categoryIds.add(t.category);
    if (t.kind === 'menuItems') for (const id of t.menuItemIds) itemIds.add(id);
  }
  if (categoryIds.size > 0) {
    const found = await db
      .select({ id: productCategory.id })
      .from(productCategory)
      .where(
        and(
          eq(productCategory.operatorId, operatorId),
          inArray(productCategory.id, [...categoryIds]),
        ),
      );
    if (found.length !== categoryIds.size) {
      throw new AppError(
        400,
        'BENEFIT_TARGET_UNKNOWN',
        'A benefit names a menu category this park does not have',
      );
    }
  }
  if (itemIds.size > 0) {
    const found = await db
      .select({ id: product.id })
      .from(product)
      .where(
        and(
          eq(product.operatorId, operatorId),
          eq(product.kind, 'menu'),
          inArray(product.id, [...itemIds]),
        ),
      );
    if (found.length !== itemIds.size) {
      throw new AppError(
        400,
        'BENEFIT_TARGET_UNKNOWN',
        'A benefit names a menu item this park does not have',
      );
    }
  }
}

// --- Views ----------------------------------------------------------------------------

type NameOf = (id: string) => string | null;

function authorOf(accountId: string | null, nameOf: NameOf): VersionAuthor | null {
  return accountId ? { accountId, name: nameOf(accountId) } : null;
}

function templateVersionView(row: TemplateRow, nameOf: NameOf): TemplateVersionView {
  return {
    id: row.id,
    profile: row.profile,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    createdAt: row.createdAt.toISOString(),
    createdBy: authorOf(row.createdByAccountId, nameOf),
  };
}

function profileVersionView(row: ProfileRow, nameOf: NameOf): ProfileVersionView {
  return {
    id: row.id,
    benefitRole: row.benefitRole,
    override: row.override,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    createdAt: row.createdAt.toISOString(),
    createdBy: authorOf(row.createdByAccountId, nameOf),
  };
}

const byFrom = (a: Ranged, b: Ranged): number =>
  a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0;

/** Newest save first: the order a history reads in. */
const bySavedDesc = (
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): number => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1);

export async function templateRows(
  db: Exec,
  operatorId: string,
  role?: BenefitRole,
): Promise<TemplateRow[]> {
  return db
    .select()
    .from(benefitRoleTemplate)
    .where(
      role
        ? and(eq(benefitRoleTemplate.operatorId, operatorId), eq(benefitRoleTemplate.role, role))
        : eq(benefitRoleTemplate.operatorId, operatorId),
    );
}

export async function profileRows(
  db: Exec,
  operatorId: string,
  employeeIds?: string[],
): Promise<ProfileRow[]> {
  if (employeeIds && employeeIds.length === 0) return [];
  return db
    .select()
    .from(benefitProfile)
    .where(
      and(
        eq(benefitProfile.operatorId, operatorId),
        isNull(benefitProfile.archivedAt),
        employeeIds ? inArray(benefitProfile.employeeId, employeeIds) : undefined,
      ),
    );
}

function templateViewOf(
  role: BenefitRole,
  rows: readonly TemplateRow[],
  today: string,
  nameOf: NameOf,
): TemplateView {
  const mine = rows.filter((r) => r.role === role);
  const current = mine.find((r) => inForceOn(r, today)) ?? null;
  return {
    role,
    // The name a version carries is the prototype's; the newest decides.
    name: [...mine].sort(bySavedDesc)[0]?.name ?? BENEFIT_ROLE_NAMES[role],
    current: current ? templateVersionView(current, nameOf) : null,
    upcoming: mine
      .filter((r) => upcomingAfter(r, today))
      .sort(byFrom)
      .map((r) => templateVersionView(r, nameOf)),
  };
}

/** What applies to a person on `day`, from their versions and the template versions. */
export function effectiveOn(
  personRows: readonly ProfileRow[],
  templates: readonly TemplateRow[],
  day: string,
): { version: ProfileRow | null; template: TemplateRow | null; profile: BenefitProfile } {
  const version = personRows.find((r) => inForceOn(r, day)) ?? null;
  // No role, no benefit (prototype types.ts:7-12) — an override included.
  if (!version?.benefitRole) return { version, template: null, profile: {} };
  if (version.override) {
    return {
      version,
      template: null,
      profile: resolveEffectiveBenefitProfile(null, version.override),
    };
  }
  const template =
    templates.find((t) => t.role === version.benefitRole && inForceOn(t, day)) ?? null;
  return {
    version,
    template,
    profile: resolveEffectiveBenefitProfile(template?.profile ?? null, null),
  };
}

/** Drop the `undefined` keys `resolveEffectiveBenefitProfile` leaves, so JSON and equality agree. */
export function compact(profile: BenefitProfile): BenefitProfile {
  const out: BenefitProfile = {};
  if (profile.comp !== undefined) out.comp = profile.comp;
  if (profile.freeItems !== undefined) out.freeItems = profile.freeItems;
  if (profile.credit !== undefined) out.credit = profile.credit;
  if (profile.standingDiscount !== undefined) out.standingDiscount = profile.standingDiscount;
  return out;
}

// --- Reads ----------------------------------------------------------------------------

export async function listBenefitTemplates(
  db: Exec,
  operatorId: string,
  today: string,
): Promise<{ today: string; templates: TemplateView[] }> {
  const rows = await templateRows(db, operatorId);
  const nameOf = await accountNames(
    db,
    rows.flatMap((r) => (r.createdByAccountId ? [r.createdByAccountId] : [])),
  );
  return {
    today,
    templates: BENEFIT_ROLES.map((role) => templateViewOf(role, rows, today, nameOf)),
  };
}

export async function benefitTemplateHistory(
  db: Exec,
  operatorId: string,
  role: BenefitRole,
  today: string,
): Promise<{ today: string; template: TemplateView; versions: TemplateVersionView[] }> {
  const rows = await templateRows(db, operatorId, role);
  const nameOf = await accountNames(
    db,
    rows.flatMap((r) => (r.createdByAccountId ? [r.createdByAccountId] : [])),
  );
  return {
    today,
    template: templateViewOf(role, rows, today, nameOf),
    versions: [...rows].sort(bySavedDesc).map((r) => templateVersionView(r, nameOf)),
  };
}

export interface EmployeeRow {
  id: string;
  name: string;
  nickname: string | null;
  branchId: string | null;
  branchName: string | null;
  source: EmployeeSource;
  archivedAt: Date | null;
}

async function employeesOf(
  db: Exec,
  operatorId: string,
  employeeId?: string,
): Promise<EmployeeRow[]> {
  return db
    .select({
      id: employee.id,
      name: employee.name,
      nickname: employee.nickname,
      branchId: employee.branchId,
      branchName: branch.name,
      source: employee.source,
      archivedAt: employee.archivedAt,
    })
    .from(employee)
    .leftJoin(branch, eq(branch.id, employee.branchId))
    .where(
      and(
        eq(employee.operatorId, operatorId),
        employeeId ? eq(employee.id, employeeId) : isNull(employee.archivedAt),
      ),
    )
    .orderBy(asc(employee.name), asc(employee.id));
}

function staffViewOf(
  person: EmployeeRow,
  personRows: readonly ProfileRow[],
  templates: readonly TemplateRow[],
  today: string,
  nameOf: NameOf,
): StaffBenefitView {
  const { version, profile } = effectiveOn(personRows, templates, today);
  return {
    employeeId: person.id,
    name: person.name,
    nickname: person.nickname,
    branchId: person.branchId,
    branchName: person.branchName,
    source: person.source,
    current: version ? profileVersionView(version, nameOf) : null,
    upcoming: personRows
      .filter((r) => upcomingAfter(r, today))
      .sort(byFrom)
      .map((r) => profileVersionView(r, nameOf)),
    effectiveProfile: compact(profile),
  };
}

/** Every live employee of the operator with their benefit today — the panel's "Staff" list. */
export async function listStaffBenefits(
  db: Exec,
  operatorId: string,
  today: string,
): Promise<{ today: string; staff: StaffBenefitView[] }> {
  const people = await employeesOf(db, operatorId);
  const [rows, templates] = await Promise.all([
    profileRows(
      db,
      operatorId,
      people.map((p) => p.id),
    ),
    templateRows(db, operatorId),
  ]);
  const nameOf = await accountNames(
    db,
    rows.flatMap((r) => (r.createdByAccountId ? [r.createdByAccountId] : [])),
  );
  return {
    today,
    staff: people.map((p) =>
      staffViewOf(
        p,
        rows.filter((r) => r.employeeId === p.id),
        templates,
        today,
        nameOf,
      ),
    ),
  };
}

/** The employee, inside the caller's operator, or 404 — another operator's id included. */
export async function loadEmployee(
  db: Exec,
  operatorId: string,
  employeeId: string,
): Promise<EmployeeRow> {
  const [person] = await employeesOf(db, operatorId, employeeId);
  if (!person) throw new AppError(404, 'NOT_FOUND', 'No such staff member');
  return person;
}

export async function staffBenefitHistory(
  db: Exec,
  operatorId: string,
  employeeId: string,
  today: string,
): Promise<{ today: string; staff: StaffBenefitView; versions: ProfileVersionView[] }> {
  const person = await loadEmployee(db, operatorId, employeeId);
  const [rows, templates] = await Promise.all([
    profileRows(db, operatorId, [person.id]),
    templateRows(db, operatorId),
  ]);
  const nameOf = await accountNames(
    db,
    rows.flatMap((r) => (r.createdByAccountId ? [r.createdByAccountId] : [])),
  );
  return {
    today,
    staff: staffViewOf(person, rows, templates, today, nameOf),
    versions: [...rows].sort(bySavedDesc).map((r) => profileVersionView(r, nameOf)),
  };
}

/** What a scan of this person would apply on `on` — exactly one answer for any day (H18). */
export async function effectiveBenefitOn(
  db: Exec,
  operatorId: string,
  employeeId: string,
  on: string,
): Promise<EffectiveBenefitView> {
  const person = await loadEmployee(db, operatorId, employeeId);
  const [rows, templates] = await Promise.all([
    profileRows(db, operatorId, [person.id]),
    templateRows(db, operatorId),
  ]);
  const { version, template, profile } = effectiveOn(rows, templates, on);
  const effective = compact(profile);
  return {
    employeeId: person.id,
    on,
    benefitRole: version?.benefitRole ?? null,
    hasOverride: Boolean(version?.benefitRole && version.override),
    profileVersionId: version?.id ?? null,
    templateVersionId: template?.id ?? null,
    profile: effective,
    isEmpty: isEmptyBenefitProfile(effective),
  };
}

// --- Writes ---------------------------------------------------------------------------

/** One writer at a time per template or per person, so two saves cannot both find the same gap. */
export async function lockScope(tx: Exec, scope: string, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope}), hashtext(${key}))`);
}

/**
 * Save a role template from `effectiveFrom` (today by default). The version in
 * force that day is closed and a new one opened; a save identical to it writes
 * nothing and records nothing. Audited `benefit.template_update`.
 */
export async function saveBenefitTemplate(
  db: Db,
  ctx: OpContext,
  actor: Actor,
  role: BenefitRole,
  input: { profile: BenefitProfile; effectiveFrom?: string },
  today: string,
): Promise<{ changed: boolean; template: TemplateView }> {
  const day = settleEffectiveFrom(input.effectiveFrom, today);
  const profile = compact(input.profile);
  await assertTargetsKnown(db, actor.operatorId, profile);
  return withTx(db, ctx, 'benefit.template_update', async (tx) => {
    await lockScope(tx, 'benefit_role_template', `${actor.operatorId}:${role}`);
    const rows = await templateRows(tx, actor.operatorId, role);
    const { closes, runsTo } = placeVersion(rows, day);
    if (closes && canonical(closes.profile) === canonical(profile)) {
      const nameOf = await accountNames(
        tx,
        rows.flatMap((r) => (r.createdByAccountId ? [r.createdByAccountId] : [])),
      );
      return { changed: false, template: templateViewOf(role, rows, today, nameOf) };
    }
    if (closes) {
      await tx
        .update(benefitRoleTemplate)
        .set({ effectiveTo: day })
        .where(eq(benefitRoleTemplate.id, closes.id));
    }
    const [created] = await tx
      .insert(benefitRoleTemplate)
      .values({
        id: newId(),
        operatorId: actor.operatorId,
        role,
        name: closes?.name ?? BENEFIT_ROLE_NAMES[role],
        profile,
        effectiveFrom: day,
        effectiveTo: runsTo,
        createdByAccountId: actor.accountId,
      })
      .returning();
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      action: 'benefit.template_update',
      entityType: 'benefit_role_template',
      entityId: created!.id,
      before: closes
        ? {
            id: closes.id,
            role,
            profile: closes.profile,
            effectiveFrom: closes.effectiveFrom,
            effectiveTo: closes.effectiveTo,
          }
        : null,
      after: {
        id: created!.id,
        role,
        profile,
        effectiveFrom: day,
        effectiveTo: runsTo,
        closedVersionId: closes?.id ?? null,
        closedFrom: closes ? day : null,
      },
      requestId: ctx.requestId,
    });
    const after = await templateRows(tx, actor.operatorId, role);
    const nameOf = await accountNames(
      tx,
      after.flatMap((r) => (r.createdByAccountId ? [r.createdByAccountId] : [])),
    );
    return { changed: true, template: templateViewOf(role, after, today, nameOf) };
  });
}

/**
 * Set a person's benefit role and override from `effectiveFrom`. A null role
 * is "no benefit" (and takes no override: there is no QR to scan for it); a
 * null override is "the role's template as it stands". Audited
 * `benefit.profile_update`.
 */
export async function saveStaffBenefit(
  db: Db,
  ctx: OpContext,
  actor: Actor,
  employeeId: string,
  input: {
    benefitRole: BenefitRole | null;
    override: BenefitProfile | null;
    effectiveFrom?: string;
  },
  today: string,
): Promise<{ changed: boolean; staff: StaffBenefitView }> {
  const person = await loadEmployee(db, actor.operatorId, employeeId);
  if (person.archivedAt) {
    throw new AppError(
      409,
      'EMPLOYEE_ARCHIVED',
      `${person.name} has left; their benefit cannot be changed`,
    );
  }
  if (input.benefitRole === null && input.override !== null) {
    throw new AppError(
      400,
      'BENEFIT_OVERRIDE_WITHOUT_ROLE',
      'Give this person a benefit role before setting an override: without one there is no benefit to override.',
    );
  }
  const day = settleEffectiveFrom(input.effectiveFrom, today);
  const override = input.override ? compact(input.override) : null;
  if (override) await assertTargetsKnown(db, actor.operatorId, override);
  return withTx(db, ctx, 'benefit.profile_update', async (tx) => {
    await lockScope(tx, 'benefit_profile', person.id);
    const rows = await profileRows(tx, actor.operatorId, [person.id]);
    const templates = await templateRows(tx, actor.operatorId);
    const { closes, runsTo } = placeVersion(rows, day);
    const same =
      closes !== null &&
      closes.benefitRole === input.benefitRole &&
      canonical(closes.override) === canonical(override);
    // A person with no version at all and "no benefit" asked for: nothing to record either.
    const nothingToStart = !closes && rows.length === 0 && input.benefitRole === null;
    if (same || nothingToStart) {
      const nameOf = await accountNames(
        tx,
        rows.flatMap((r) => (r.createdByAccountId ? [r.createdByAccountId] : [])),
      );
      return { changed: false, staff: staffViewOf(person, rows, templates, today, nameOf) };
    }
    if (closes) {
      await tx
        .update(benefitProfile)
        .set({ effectiveTo: day })
        .where(eq(benefitProfile.id, closes.id));
    }
    const [created] = await tx
      .insert(benefitProfile)
      .values({
        id: newId(),
        operatorId: actor.operatorId,
        employeeId: person.id,
        benefitRole: input.benefitRole,
        override,
        effectiveFrom: day,
        effectiveTo: runsTo,
        createdByAccountId: actor.accountId,
      })
      .returning();
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      action: 'benefit.profile_update',
      entityType: 'benefit_profile',
      entityId: created!.id,
      before: closes
        ? {
            id: closes.id,
            employeeId: person.id,
            benefitRole: closes.benefitRole,
            override: closes.override,
            effectiveFrom: closes.effectiveFrom,
            effectiveTo: closes.effectiveTo,
          }
        : null,
      after: {
        id: created!.id,
        employeeId: person.id,
        employeeName: person.name,
        benefitRole: input.benefitRole,
        override,
        effectiveFrom: day,
        effectiveTo: runsTo,
        closedVersionId: closes?.id ?? null,
      },
      requestId: ctx.requestId,
    });
    const after = await profileRows(tx, actor.operatorId, [person.id]);
    const nameOf = await accountNames(
      tx,
      after.flatMap((r) => (r.createdByAccountId ? [r.createdByAccountId] : [])),
    );
    return { changed: true, staff: staffViewOf(person, after, templates, today, nameOf) };
  });
}
