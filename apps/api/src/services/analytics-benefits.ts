import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { branch, employee, factBenefitDaily, opsRun, type Db } from '@oto/db';
import {
  ANALYTICS_REPORT_LIST_MAX_ROWS,
  addDaysToIsoDate,
  addBenefitReliefSums,
  businessDate,
  emptyBenefitReliefSums,
  newId,
  parseDayStart,
  type BenefitReliefSums,
  type BenefitReport,
  type BenefitRole,
  type BenefitTransactions,
} from '@oto/shared';
import { AppError } from '../lib/errors';
import type { ReportScope } from './analytics-reports';
// The daily rollup writes this fact; its job name is its own. (A cycle with
// analytics-rollup.ts, which calls `rollupBenefitDay`: both are read only
// inside functions, after both modules have loaded.)
import { ROLLUP_DAILY_JOB } from './analytics-rollup';
import type { Exec, Tx } from './tx';

/**
 * S2-21 (SCRUM-218) round 4 — THE STAFF BENEFITS' DAY, KEPT AND READ
 * (docs/progress/plans/benefits/PLAN.md §5, §7, §8 round 4).
 *
 * THE FACT. `analytics.fact_benefit_daily`, one row per branch, trading day,
 * beneficiary and benefit role: what the staff benefits took off the bills of
 * the day's recorded orders, split the prototype's four ways (comp, free
 * items, staff credit, standing discount), with how many applications used
 * each stage and the free-item units relieved. Read from the live
 * applications (`promo.benefit_application`) of the branch-day's finalised
 * and refunded sales — the same set the Staff Benefits Audit log lists — and
 * from nothing else.
 *
 * TWO WRITERS, ONE LOCK, the rollup/job patterns of S2-15b:
 *
 *   job:rollup.daily            writes the branch-day's rows in the same
 *                               transaction as its daily summary and its
 *                               report rows (`rollupBenefitDay`), so every day
 *                               a late fact marks dirty — a refund, a void, a
 *                               box sale synced days late — is recomputed
 *                               here too. Today is written `provisional`.
 *   job:benefit.period_rollover at each branch's day start: every ended day
 *                               of the last week, and every day still
 *                               provisional however old, rewritten final —
 *                               the previous period CLOSED (plan §5). It is
 *                               not what makes a new period count from zero:
 *                               a period is a key (`benefitPeriodKey`), and a
 *                               new day's key has simply never been counted
 *                               under.
 *
 * Each branch-day is computed and written under a transaction-scoped advisory
 * lock of its own; a row is written only where a figure moved, and a row the
 * day no longer has is removed, so a replayed run writes nothing.
 *
 * REFUNDS (plan Q4's default, the prototype's rule). A refund gives no quota
 * back and leaves the application, its "Staff benefit" row and its audit
 * entry as they were. The relief was given, so the fact keeps it on the day it
 * was given; the refund reduces the sale's revenue, never the relief. The
 * per-application list says what each order has since given back in money.
 */

export const BENEFIT_ROLLOVER_JOB = 'job:benefit.period_rollover';

/** Ours, distinct from the job runner's, the daily rollup's and the booth rollup's namespaces. */
const BENEFIT_LOCK_NAMESPACE = 0x0b21;

/** How far back the rollover closes ended days on every run, as the other day-end jobs do. */
export const BENEFIT_ROLLOVER_DAYS_BACK = 7;

/** The sales a benefit counts on: recorded, refunded included (the prototype keeps the entry). */
const COUNTED = sql`('finalised', 'refunded')`;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

// --- The facts ------------------------------------------------------------------------

export interface BenefitFactRow extends BenefitReliefSums {
  employeeId: string;
  benefitRole: BenefitRole;
}

const factKey = (r: { employeeId: string; benefitRole: string }) => `${r.employeeId}|${r.benefitRole}`;

/** Free-item units an application relieved: its claimed `free:*` counters. */
const FREE_UNITS = sql`(select coalesce(sum((d->>'qty')::int), 0) from jsonb_array_elements(a.usage_deltas) d where d->>'itemKey' like 'free:%')`;

/** One branch-day's facts, read from the live applications of its recorded sales. */
export async function benefitFactsOf(db: Exec, branchId: string, date: string): Promise<BenefitFactRow[]> {
  const { rows } = await db.execute<{
    employee_id: string;
    benefit_role: BenefitRole;
    applications: number;
    comp_count: number;
    comped: string | number;
    free_count: number;
    units: number;
    free: string | number;
    credit_count: number;
    credit: string | number;
    discount_count: number;
    discount: string | number;
    total: string | number;
    applied: string | number;
  }>(sql`
    select a.employee_id, a.benefit_role,
           count(*)::int as applications,
           (count(*) filter (where a.comped_satang > 0))::int as comp_count,
           coalesce(sum(a.comped_satang), 0)::bigint as comped,
           (count(*) filter (where a.free_items_satang > 0))::int as free_count,
           coalesce(sum(${FREE_UNITS}), 0)::int as units,
           coalesce(sum(a.free_items_satang), 0)::bigint as free,
           (count(*) filter (where a.credit_satang > 0))::int as credit_count,
           coalesce(sum(a.credit_satang), 0)::bigint as credit,
           (count(*) filter (where a.discount_satang > 0))::int as discount_count,
           coalesce(sum(a.discount_satang), 0)::bigint as discount,
           coalesce(sum(a.total_relief_satang), 0)::bigint as total,
           coalesce(sum(a.applied_satang), 0)::bigint as applied
      from promo.benefit_application a
      join pos.sale s on s.id = a.sale_id
     where a.branch_id = ${branchId}::uuid
       and a.business_date = ${date}::date
       and a.removed_at is null
       and s.status in ${COUNTED}
     group by a.employee_id, a.benefit_role
     order by a.employee_id, a.benefit_role`);
  return rows.map((r) => ({
    employeeId: r.employee_id,
    benefitRole: r.benefit_role,
    applications: num(r.applications),
    compCount: num(r.comp_count),
    compedSatang: num(r.comped),
    freeItemsCount: num(r.free_count),
    freeItemUnits: num(r.units),
    freeItemsSatang: num(r.free),
    creditCount: num(r.credit_count),
    creditSatang: num(r.credit),
    discountCount: num(r.discount_count),
    discountSatang: num(r.discount),
    totalReliefSatang: num(r.total),
    appliedSatang: num(r.applied),
  }));
}

/** One writer of a branch-day's benefit rows at a time, for the length of the transaction. */
async function lockBenefitDay(tx: Tx, branchId: string, date: string): Promise<void> {
  const key = createHash('sha256').update(`rollup:benefit:${branchId}:${date}`).digest().readInt32BE(0);
  await tx.execute(sql`select pg_advisory_xact_lock(${BENEFIT_LOCK_NAMESPACE}::int4, ${key}::int4)`);
}

export interface BenefitDayOutcome {
  written: number;
  removed: number;
  /** Rows that were provisional and are now final: the day closed by this write. */
  closed: number;
}

/**
 * Write one branch-day's benefit rows, in the caller's transaction: every row
 * upserted where a figure (or the provisional flag) moved, every row the day
 * no longer has removed.
 */
export async function writeBenefitDay(
  tx: Tx,
  scope: { operatorId: string; branchId: string; date: string; now: Date; provisional: boolean },
): Promise<BenefitDayOutcome> {
  const { operatorId, branchId, date, now, provisional } = scope;
  await lockBenefitDay(tx, branchId, date);
  const facts = await benefitFactsOf(tx, branchId, date);
  const stored = await tx
    .select()
    .from(factBenefitDaily)
    .where(and(eq(factBenefitDaily.branchId, branchId), eq(factBenefitDaily.businessDate, date)));
  const held = new Map(stored.map((r) => [factKey(r), r]));
  const outcome: BenefitDayOutcome = { written: 0, removed: 0, closed: 0 };
  for (const f of facts) {
    const current = held.get(factKey(f));
    held.delete(factKey(f));
    const figures = {
      applications: f.applications,
      compCount: f.compCount,
      compedSatang: f.compedSatang,
      freeItemsCount: f.freeItemsCount,
      freeItemUnits: f.freeItemUnits,
      freeItemsSatang: f.freeItemsSatang,
      creditCount: f.creditCount,
      creditSatang: f.creditSatang,
      discountCount: f.discountCount,
      discountSatang: f.discountSatang,
      totalReliefSatang: f.totalReliefSatang,
      appliedSatang: f.appliedSatang,
      provisional,
    };
    if (current) {
      const same = (Object.keys(figures) as Array<keyof typeof figures>).every((k) => current[k] === figures[k]);
      if (same) continue;
      await tx
        .update(factBenefitDaily)
        .set({ ...figures, computedAt: now, updatedAt: now })
        .where(eq(factBenefitDaily.id, current.id));
      if (current.provisional && !provisional) outcome.closed += 1;
    } else {
      await tx.insert(factBenefitDaily).values({
        id: newId(),
        operatorId,
        branchId,
        businessDate: date,
        employeeId: f.employeeId,
        benefitRole: f.benefitRole,
        ...figures,
        computedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    outcome.written += 1;
  }
  // A row the day no longer has: its sale voided before it closed, its
  // application moved to the order rung up again, a demo reset.
  for (const gone of held.values()) {
    await tx.delete(factBenefitDaily).where(eq(factBenefitDaily.id, gone.id));
    outcome.removed += 1;
  }
  return outcome;
}

/**
 * The daily rollup's half (`rollupDailyBranchDay`): the branch-day's benefit
 * rows of the same read of the ledger, in the same transaction as its daily
 * summary and report rows. `provisional` is the rollup's own: the day has not
 * ended at the branch.
 */
export async function rollupBenefitDay(
  tx: Tx,
  scope: { operatorId: string; branchId: string; date: string; now: Date; provisional: boolean },
): Promise<BenefitDayOutcome> {
  return writeBenefitDay(tx, scope);
}

// --- The rollover -----------------------------------------------------------------------

interface BenefitBranchClock {
  id: string;
  operatorId: string;
  timezone: string;
  dayStartMinutes: number;
  live: boolean;
}

/** The trading day in progress at a branch, by its own clock and day start. */
const todayAt = (clock: Pick<BenefitBranchClock, 'timezone' | 'dayStartMinutes'>, now: Date): string =>
  businessDate(now, clock.timezone, clock.dayStartMinutes);

/** Is this the last trading day of its month — the day a monthly period ends on. */
export function endsAMonth(isoDate: string): boolean {
  return addDaysToIsoDate(isoDate, 1).slice(0, 7) !== isoDate.slice(0, 7);
}

/** Close one ended branch-day: its rows rewritten final, in a transaction of its own. */
export async function closeBenefitBranchDay(
  db: Db,
  clock: Pick<BenefitBranchClock, 'id' | 'operatorId'>,
  date: string,
  now: Date,
): Promise<BenefitDayOutcome> {
  return db.transaction((tx) =>
    writeBenefitDay(tx, { operatorId: clock.operatorId, branchId: clock.id, date, now, provisional: false }),
  );
}

export interface BenefitRolloverDetail extends Record<string, number> {
  branches: number;
  days: number;
  rowsWritten: number;
  rowsRemoved: number;
  /** Ended days whose rows this run turned from provisional to final. */
  daysClosed: number;
  /** Of those, the days that ended a month: a monthly period (the staff credit) closed. */
  monthsClosed: number;
}

/**
 * `job:benefit.period_rollover` — at each branch's day start, the previous
 * period closed (plan §5): every live branch's ended days of the last week,
 * and every day still provisional however long ago it ended, rewritten final.
 * One branch-day that cannot be written does not stop the others; the run
 * then fails loudly with the count, so the Failures page carries it and the
 * watchdog's expectation raises if it keeps failing.
 */
export async function runBenefitRolloverJob(db: Db, now: Date): Promise<BenefitRolloverDetail> {
  const rows = await db
    .select({
      id: branch.id,
      operatorId: branch.operatorId,
      timezone: branch.timezone,
      dayStart: branch.businessDayStart,
      archivedAt: branch.archivedAt,
    })
    .from(branch);
  const clocks = new Map<string, BenefitBranchClock>(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        operatorId: r.operatorId,
        timezone: r.timezone,
        dayStartMinutes: parseDayStart(r.dayStart),
        live: r.archivedAt === null,
      },
    ]),
  );
  const plan = new Map<string, { clock: BenefitBranchClock; date: string }>();
  const live = [...clocks.values()].filter((c) => c.live);
  for (const clock of live) {
    const today = todayAt(clock, now);
    for (let back = 1; back <= BENEFIT_ROLLOVER_DAYS_BACK; back += 1) {
      const date = addDaysToIsoDate(today, -back);
      plan.set(`${clock.id}|${date}`, { clock, date });
    }
  }
  // Every day still provisional once it has ended at its branch, however old:
  // a rollover that was down for longer than the week still closes it.
  const provisional = await db
    .selectDistinct({ branchId: factBenefitDaily.branchId, businessDate: factBenefitDaily.businessDate })
    .from(factBenefitDaily)
    .where(eq(factBenefitDaily.provisional, true));
  for (const row of provisional) {
    const clock = clocks.get(row.branchId);
    if (!clock || row.businessDate >= todayAt(clock, now)) continue;
    plan.set(`${clock.id}|${row.businessDate}`, { clock, date: row.businessDate });
  }

  const detail: BenefitRolloverDetail = {
    branches: live.length,
    days: 0,
    rowsWritten: 0,
    rowsRemoved: 0,
    daysClosed: 0,
    monthsClosed: 0,
  };
  let failed = 0;
  let firstError: unknown = null;
  const ordered = [...plan.values()].sort((a, b) => a.date.localeCompare(b.date) || a.clock.id.localeCompare(b.clock.id));
  for (const day of ordered) {
    detail.days += 1;
    try {
      const done = await closeBenefitBranchDay(db, day.clock, day.date, now);
      detail.rowsWritten += done.written;
      detail.rowsRemoved += done.removed;
      if (done.closed > 0) {
        detail.daysClosed += 1;
        if (endsAMonth(day.date)) detail.monthsClosed += 1;
      }
    } catch (err) {
      failed += 1;
      firstError ??= err;
    }
  }
  if (failed > 0) {
    throw new Error(`benefit rollover: ${failed} of ${detail.days} branch-days could not be closed`, {
      cause: firstError,
    });
  }
  return detail;
}

// --- Freshness ------------------------------------------------------------------------

/**
 * When the benefit figures were last brought up to date: the start of the
 * newest successful `job:rollup.daily` (each one rolls today at every live
 * branch, and writes the benefit rows with it). Null when it never has. The
 * whole answer is as fresh as that run.
 */
export async function lastBenefitRolledUpAt(db: Exec): Promise<Date | null> {
  const [lastRun] = await db
    .select({ startedAt: opsRun.startedAt })
    .from(opsRun)
    .where(and(eq(opsRun.name, ROLLUP_DAILY_JOB), eq(opsRun.outcome, 'ok')))
    .orderBy(desc(opsRun.startedAt))
    .limit(1);
  return lastRun?.startedAt ?? null;
}

// --- The report -----------------------------------------------------------------------

export interface BenefitReportFilter {
  employeeId?: string | null;
  role?: BenefitRole | null;
}

/** A beneficiary named in a report filter is this operator's, or the request is a 404. */
export async function assertReportEmployee(db: Exec, operatorId: string, employeeId: string | undefined): Promise<void> {
  if (!employeeId) return;
  const [person] = await db
    .select({ id: employee.id })
    .from(employee)
    .where(and(eq(employee.id, employeeId), eq(employee.operatorId, operatorId)))
    .limit(1);
  if (!person) throw new AppError(404, 'NOT_FOUND', 'Staff member not found');
}

const idsOf = (scope: ReportScope) =>
  sql.join(
    scope.branches.map((b) => sql`${b.branchId}::uuid`),
    sql`, `,
  );

const narrowed = (alias: string, filter: BenefitReportFilter) => {
  const a = sql.raw(alias);
  return sql`${filter.employeeId ? sql`and ${a}.employee_id = ${filter.employeeId}::uuid` : sql``}
    ${filter.role ? sql`and ${a}.benefit_role = ${filter.role}` : sql``}`;
};

/**
 * The staff benefits report: the range added up, per benefit role, per
 * beneficiary and per branch-day, from the rolled-up fact alone.
 */
export async function benefitReportOf(
  db: Exec,
  scope: ReportScope,
  filter: BenefitReportFilter = {},
): Promise<BenefitReport> {
  const head = {
    from: scope.from,
    to: scope.to,
    branches: scope.branches,
    omitted: scope.omitted,
    employeeId: filter.employeeId ?? null,
    role: filter.role ?? null,
  };
  const lastRolledUpAt = (await lastBenefitRolledUpAt(db))?.toISOString() ?? null;
  if (scope.branches.length === 0) {
    return { ...head, totals: emptyBenefitReliefSums(), byRole: [], byBeneficiary: [], days: [], lastRolledUpAt };
  }
  const { rows } = await db.execute<{
    business_date: string;
    branch_id: string;
    employee_id: string;
    name: string;
    benefit_role: BenefitRole;
    provisional: boolean;
    applications: number;
    comp_count: number;
    comped_satang: string | number;
    free_items_count: number;
    free_item_units: number;
    free_items_satang: string | number;
    credit_count: number;
    credit_satang: string | number;
    discount_count: number;
    discount_satang: string | number;
    total_relief_satang: string | number;
    applied_satang: string | number;
  }>(sql`
    select f.business_date::text as business_date, f.branch_id, f.employee_id, e.name, f.benefit_role, f.provisional,
           f.applications, f.comp_count, f.comped_satang, f.free_items_count, f.free_item_units, f.free_items_satang,
           f.credit_count, f.credit_satang, f.discount_count, f.discount_satang, f.total_relief_satang, f.applied_satang
      from analytics.fact_benefit_daily f
      join core.employee e on e.id = f.employee_id
     where f.branch_id in (${idsOf(scope)})
       and f.business_date between ${scope.from}::date and ${scope.to}::date
       ${narrowed('f', filter)}
     order by f.business_date, f.branch_id, e.name, f.employee_id, f.benefit_role`);

  const totals = emptyBenefitReliefSums();
  const byRole = new Map<BenefitRole, BenefitReliefSums & { role: BenefitRole }>();
  const byBeneficiary = new Map<string, BenefitReliefSums & { employeeId: string; name: string; role: BenefitRole }>();
  const days = new Map<string, BenefitReliefSums & { businessDate: string; branchId: string; provisional: boolean }>();
  for (const r of rows) {
    const sums: BenefitReliefSums = {
      applications: num(r.applications),
      compCount: num(r.comp_count),
      compedSatang: num(r.comped_satang),
      freeItemsCount: num(r.free_items_count),
      freeItemUnits: num(r.free_item_units),
      freeItemsSatang: num(r.free_items_satang),
      creditCount: num(r.credit_count),
      creditSatang: num(r.credit_satang),
      discountCount: num(r.discount_count),
      discountSatang: num(r.discount_satang),
      totalReliefSatang: num(r.total_relief_satang),
      appliedSatang: num(r.applied_satang),
    };
    addBenefitReliefSums(totals, sums);
    const role = byRole.get(r.benefit_role) ?? { role: r.benefit_role, ...emptyBenefitReliefSums() };
    addBenefitReliefSums(role, sums);
    byRole.set(r.benefit_role, role);
    const personKey = `${r.employee_id}|${r.benefit_role}`;
    const person = byBeneficiary.get(personKey) ?? {
      employeeId: r.employee_id,
      name: r.name,
      role: r.benefit_role,
      ...emptyBenefitReliefSums(),
    };
    addBenefitReliefSums(person, sums);
    byBeneficiary.set(personKey, person);
    const date = String(r.business_date).slice(0, 10);
    const dayKey = `${r.branch_id}|${date}`;
    const day = days.get(dayKey) ?? { businessDate: date, branchId: r.branch_id, provisional: false, ...emptyBenefitReliefSums() };
    addBenefitReliefSums(day, sums);
    day.provisional ||= r.provisional;
    days.set(dayKey, day);
  }
  const ROLE_ORDER: Record<BenefitRole, number> = { owner: 0, manager: 1, staff: 2 };
  return {
    ...head,
    totals,
    byRole: [...byRole.values()].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]),
    byBeneficiary: [...byBeneficiary.values()].sort(
      (a, b) =>
        b.appliedSatang - a.appliedSatang ||
        a.name.localeCompare(b.name) ||
        a.employeeId.localeCompare(b.employeeId) ||
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role],
    ),
    days: [...days.values()].sort(
      (a, b) => a.businessDate.localeCompare(b.businessDate) || a.branchId.localeCompare(b.branchId),
    ),
    lastRolledUpAt,
  };
}

/**
 * Every staff benefit applied to a recorded order of the range, newest first,
 * read through a date-bounded query (a list is not a summary, plan question 13
 * of the analytics plan): the beneficiary, who processed it, the sale, the
 * four amounts, what came off the bill, and the order as it stands now.
 * Refused past `ANALYTICS_REPORT_LIST_MAX_ROWS`, as the other lists are.
 */
export async function benefitTransactionsOf(
  db: Exec,
  scope: ReportScope,
  filter: BenefitReportFilter = {},
): Promise<BenefitTransactions> {
  const head = { from: scope.from, to: scope.to, branches: scope.branches, omitted: scope.omitted };
  if (scope.branches.length === 0) return { ...head, rows: [] };
  const { rows } = await db.execute<{
    id: string;
    occurred_at: Date | string;
    business_date: string;
    branch_id: string;
    branch_name: string;
    station_id: string;
    box_id: string | null;
    origin: 'cloud' | 'box';
    employee_id: string;
    beneficiary_name: string;
    benefit_role: BenefitRole;
    processed_by_account_id: string;
    processed_by_name: string;
    sale_id: string;
    receipt_number: string | null;
    sale_status: string;
    refunded_satang: string | number;
    is_comp: boolean;
    comped_satang: string | number;
    free_items_satang: string | number;
    units: number;
    credit_satang: string | number;
    discount_satang: string | number;
    total_relief_satang: string | number;
    applied_satang: string | number;
  }>(sql`
    select a.id, a.occurred_at, a.business_date::text as business_date, a.branch_id, b.name as branch_name,
           a.station_id, a.box_id, a.origin, a.employee_id, e.name as beneficiary_name, a.benefit_role,
           a.processed_by_account_id, coalesce(pe.nickname, pe.name, 'Unnamed account') as processed_by_name,
           a.sale_id, s.receipt_number, s.status as sale_status, s.refunded_satang,
           a.is_comp, a.comped_satang, a.free_items_satang, ${FREE_UNITS} as units, a.credit_satang,
           a.discount_satang, a.total_relief_satang, a.applied_satang
      from promo.benefit_application a
      join pos.sale s on s.id = a.sale_id
      join core.branch b on b.id = a.branch_id
      join core.employee e on e.id = a.employee_id
      left join core.account pa on pa.id = a.processed_by_account_id
      left join core.employee pe on pe.id = pa.employee_id
     where a.branch_id in (${idsOf(scope)})
       and a.business_date between ${scope.from}::date and ${scope.to}::date
       and a.removed_at is null
       and s.status in ${COUNTED}
       ${narrowed('a', filter)}
     order by a.occurred_at desc, a.id desc
     limit ${ANALYTICS_REPORT_LIST_MAX_ROWS + 1}`);
  if (rows.length > ANALYTICS_REPORT_LIST_MAX_ROWS) {
    throw new AppError(
      400,
      'ANALYTICS_REPORT_TOO_LARGE',
      `Narrow the dates: this list is limited to ${ANALYTICS_REPORT_LIST_MAX_ROWS.toLocaleString('en-US')} transactions at a time.`,
    );
  }
  return {
    ...head,
    rows: rows.map((r) => ({
      id: r.id,
      at: new Date(r.occurred_at).toISOString(),
      businessDate: String(r.business_date).slice(0, 10),
      branchId: r.branch_id,
      branchName: r.branch_name,
      stationId: r.station_id,
      boxId: r.box_id,
      origin: r.origin,
      employeeId: r.employee_id,
      beneficiaryName: r.beneficiary_name,
      benefitRole: r.benefit_role,
      processedByAccountId: r.processed_by_account_id,
      processedByName: r.processed_by_name,
      saleId: r.sale_id,
      transactionId: r.receipt_number ?? r.sale_id,
      saleStatus: r.sale_status === 'refunded' ? 'refunded' : 'finalised',
      refundedSatang: num(r.refunded_satang),
      isComp: r.is_comp,
      compedSatang: num(r.comped_satang),
      freeItemsSatang: num(r.free_items_satang),
      freeItemUnits: num(r.units),
      creditSatang: num(r.credit_satang),
      discountSatang: num(r.discount_satang),
      totalReliefSatang: num(r.total_relief_satang),
      appliedSatang: num(r.applied_satang),
    })),
  };
}
