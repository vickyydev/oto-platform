import { and, asc, desc, eq, gte, inArray, lte, max } from 'drizzle-orm';
import { branch, dailySummary, hourlySummary, opsRun, type Db } from '@oto/db';
import {
  ANALYTICS_PLATFORM_SOURCE,
  ANALYTICS_SUMMARY_PERMISSIONS,
  addDaysToIsoDate,
  businessDate,
  emptyAnalyticsDayFigures,
  parseDayStart,
  sumAnalyticsDayFigures,
  type AnalyticsDayFigures,
  type AnalyticsSummary,
  type AnalyticsSummaryBranch,
  type AnalyticsSummaryGroup,
  type AnalyticsSummaryHour,
  type AnalyticsSummaryRow,
} from '@oto/shared';
import { ROLLUP_DAILY_JOB } from './analytics-rollup';
import { hasPermission, type EffectivePermission } from './permissions';
import type { Exec } from './tx';

/**
 * S2-15b (SCRUM-216) round 3 — THE STORED FIGURES, READ (plan
 * docs/progress/plans/analytics/PLAN.md §5, §8 round 3).
 *
 * `GET /analytics/summary` answers from `analytics.daily_summary` and
 * `analytics.hourly_summary` only — never from the sales tables — so Today >
 * Performance shows the same figures on every till and phone, and survives a
 * reload. Each branch's rows are its own; the merged rows add up ONLY the
 * branches the caller may read (`mayReadAnalytics`), and a requested branch
 * the caller may not read is listed as omitted, never folded into a total.
 *
 * Nothing here writes. The rollup (`analytics-rollup.ts`) is the only writer.
 */

const SOURCE = ANALYTICS_PLATFORM_SOURCE;

/** May this caller read this branch's figures? The Today screen's permission, or `analytics:read`. */
export function mayReadAnalytics(effective: EffectivePermission[], operatorId: string, branchId: string): boolean {
  return ANALYTICS_SUMMARY_PERMISSIONS.some((permission) => hasPermission(effective, permission, { operatorId, branchId }));
}

/** A branch of the caller's operator, as the summary describes it. */
export interface SummaryBranch {
  id: string;
  name: string;
  timezone: string;
  /** `HH:MM:SS` as Postgres keeps a `time`. */
  businessDayStart: string;
  archivedAt: Date | null;
  createdAt: Date;
}

/** Every branch of one operator, live or archived, in name order. */
export async function operatorBranches(db: Exec, operatorId: string): Promise<SummaryBranch[]> {
  return db
    .select({
      id: branch.id,
      name: branch.name,
      timezone: branch.timezone,
      businessDayStart: branch.businessDayStart,
      archivedAt: branch.archivedAt,
      createdAt: branch.createdAt,
    })
    .from(branch)
    .where(eq(branch.operatorId, operatorId))
    .orderBy(asc(branch.name), asc(branch.id));
}

/** The business date in progress at a branch. */
export function summaryBranchToday(b: Pick<SummaryBranch, 'timezone' | 'businessDayStart'>, now: Date): string {
  return businessDate(now, b.timezone, parseDayStart(b.businessDayStart));
}

// --- Freshness -------------------------------------------------------------------------

/**
 * WHEN EACH BRANCH WAS LAST ROLLED UP.
 *
 * A row's `computed_at` moves only when its figures moved — the rollup leaves
 * an unchanged day alone, so a quiet evening would read as a stale one. Every
 * successful run of `job:rollup.daily` rolls today at every live branch, so
 * the start of the newest successful run is when a live branch's figures were
 * last confirmed (it is the `now` the run computed with). The answer is the
 * later of the two; for an archived branch, its newest row. A branch created
 * after that run was not in it.
 */
export async function lastRolledUpAt(db: Exec, branches: readonly SummaryBranch[]): Promise<Map<string, Date | null>> {
  const out = new Map<string, Date | null>();
  if (branches.length === 0) return out;
  const [lastRun] = await db
    .select({ startedAt: opsRun.startedAt })
    .from(opsRun)
    .where(and(eq(opsRun.name, ROLLUP_DAILY_JOB), eq(opsRun.outcome, 'ok')))
    .orderBy(desc(opsRun.startedAt))
    .limit(1);
  const written = await db
    .select({ branchId: dailySummary.branchId, computedAt: max(dailySummary.computedAt) })
    .from(dailySummary)
    .where(and(inArray(dailySummary.branchId, branches.map((b) => b.id)), eq(dailySummary.source, SOURCE)))
    .groupBy(dailySummary.branchId);
  const newestRow = new Map(written.map((w) => [w.branchId, w.computedAt]));
  for (const b of branches) {
    const row = newestRow.get(b.id) ?? null;
    const run =
      lastRun && b.archivedAt === null && lastRun.startedAt.getTime() >= b.createdAt.getTime() ? lastRun.startedAt : null;
    const later = row && run ? (row.getTime() >= run.getTime() ? row : run) : (row ?? run);
    out.set(b.id, later);
  }
  return out;
}

// --- The answer ------------------------------------------------------------------------

type StoredDay = typeof dailySummary.$inferSelect;

function figuresOf(row: StoredDay): AnalyticsDayFigures {
  return {
    ticketsSatang: row.ticketsSatang,
    fnbSatang: row.fnbSatang,
    merchSatang: row.merchSatang,
    partiesSatang: row.partiesSatang,
    dropoffSatang: row.dropoffSatang,
    revenueSatang: row.revenueSatang,
    txnCount: row.txnCount,
    creditPaidSatang: row.creditPaidSatang,
    guestsKids: row.guestsKids,
    guestsAdults: row.guestsAdults,
    mix1h: row.mix1h,
    mix2h: row.mix2h,
    mixFullDay: row.mixFullDay,
    partiesCount: row.partiesCount,
    refundsSatang: row.refundsSatang,
    discountsSatang: row.discountsSatang,
    compsSatang: row.compsSatang,
    vatSatang: row.vatSatang,
    serviceSatang: row.serviceSatang,
    byChannel: row.byChannel ?? {},
  };
}

/** One branch-day as the answer sees it: the stored row, or a day with no row. */
interface BranchDay {
  branchId: string;
  date: string;
  stored: StoredDay | null;
  /** Not ended at its branch, or ended and still flagged provisional. */
  provisional: boolean;
}

/** Days `from`..`to` inclusive, oldest first. */
function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysToIsoDate(d, 1)) out.push(d);
  return out;
}

/** Several branch-days added up into one row of the answer. */
function rowOf(days: readonly BranchDay[], businessDateOfRow: string | null): AnalyticsSummaryRow {
  const stored = days.flatMap((d) => (d.stored ? [d.stored] : []));
  const figures = stored.length > 0 ? sumAnalyticsDayFigures(stored.map(figuresOf)) : emptyAnalyticsDayFigures();
  const newest = stored.reduce<Date | null>(
    (latest, s) => (latest === null || s.computedAt.getTime() > latest.getTime() ? s.computedAt : latest),
    null,
  );
  const versions = new Set(stored.map((s) => s.formulaVersion));
  return {
    ...figures,
    businessDate: businessDateOfRow,
    provisional: days.some((d) => d.provisional),
    rolledDays: stored.length,
    computedAt: newest?.toISOString() ?? null,
    formulaVersion: versions.size === 1 ? [...versions][0]! : null,
  };
}

/** Rows by the request's `group`: one per date, or one for the range. */
function groupRows(days: readonly BranchDay[], dates: readonly string[], group: AnalyticsSummaryGroup): AnalyticsSummaryRow[] {
  if (group === 'total') return [rowOf(days, null)];
  return dates.map((date) => rowOf(days.filter((d) => d.date === date), date));
}

const businessDayStartLabel = (time: string): string => time.slice(0, 5);

/**
 * The summary for `branches` (already filtered to those the caller may read),
 * `from`..`to`. `readable` is every live branch the caller may read, and
 * `omitted` the requested ones that were left out — both decided by the
 * caller of this function, which holds the permissions.
 */
export async function analyticsSummaryOf(
  db: Db,
  input: {
    branches: readonly SummaryBranch[];
    readable: readonly SummaryBranch[];
    omitted: readonly string[];
    from: string;
    to: string;
    group: AnalyticsSummaryGroup;
    now: Date;
  },
): Promise<AnalyticsSummary> {
  const { from, to, group, now } = input;
  const ids = input.branches.map((b) => b.id);
  const stored =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(dailySummary)
          .where(
            and(
              inArray(dailySummary.branchId, ids),
              eq(dailySummary.source, SOURCE),
              gte(dailySummary.businessDate, from),
              lte(dailySummary.businessDate, to),
            ),
          )
          .orderBy(asc(dailySummary.businessDate), asc(dailySummary.branchId));
  const byKey = new Map(stored.map((row) => [`${row.branchId}|${row.businessDate}`, row]));
  const dates = datesBetween(from, to);
  const fresh = await lastRolledUpAt(db, input.branches);

  const branches: AnalyticsSummaryBranch[] = [];
  const allDays: BranchDay[] = [];
  for (const b of input.branches) {
    const today = summaryBranchToday(b, now);
    const days = dates.map((date): BranchDay => {
      const row = byKey.get(`${b.id}|${date}`) ?? null;
      return {
        branchId: b.id,
        date,
        stored: row,
        // A stored row says for itself; a day with no row is still moving
        // until it has ended at its branch (and after that it had no sale).
        provisional: row ? row.provisional : date >= today,
      };
    });
    allDays.push(...days);
    branches.push({
      branchId: b.id,
      name: b.name,
      timezone: b.timezone,
      businessDayStart: businessDayStartLabel(b.businessDayStart),
      today,
      lastRolledUpAt: fresh.get(b.id)?.toISOString() ?? null,
      rows: groupRows(days, dates, group),
    });
  }

  let hours: AnalyticsSummaryHour[] | null = null;
  if (from === to) {
    const hourRows = ids.length === 0
      ? []
      : await db
          .select()
          .from(hourlySummary)
          .where(
            and(
              inArray(hourlySummary.branchId, ids),
              eq(hourlySummary.source, SOURCE),
              eq(hourlySummary.businessDate, from),
            ),
          );
    const byHour = new Map<number, AnalyticsSummaryHour>();
    for (const h of hourRows) {
      const acc = byHour.get(h.hour) ?? {
        hour: h.hour,
        ticketsSatang: 0,
        fnbSatang: 0,
        merchSatang: 0,
        partiesSatang: 0,
        dropoffSatang: 0,
        revenueSatang: 0,
        txnCount: 0,
        guests: 0,
      };
      acc.ticketsSatang += h.ticketsSatang;
      acc.fnbSatang += h.fnbSatang;
      acc.merchSatang += h.merchSatang;
      acc.partiesSatang += h.partiesSatang;
      acc.dropoffSatang += h.dropoffSatang;
      acc.revenueSatang += h.revenueSatang;
      acc.txnCount += h.txnCount;
      acc.guests += h.guests;
      byHour.set(h.hour, acc);
    }
    hours = [...byHour.values()].sort((a, b) => a.hour - b.hour);
  }

  // ISO strings of one format compare as the instants they name.
  const freshness = branches.map((b) => b.lastRolledUpAt);
  const oldest =
    freshness.length === 0 || freshness.some((f) => f === null)
      ? null
      : freshness.reduce((a, b) => (a! <= b! ? a : b));

  return {
    from,
    to,
    group,
    source: SOURCE,
    branches,
    omitted: [...input.omitted],
    readable: input.readable.map((b) => ({ branchId: b.id, name: b.name })),
    merged: groupRows(allDays, dates, group),
    hours,
    lastRolledUpAt: oldest,
  };
}

/**
 * The Health page's line per branch (plan §1): when the rollup last brought
 * each branch in the caller's reach up to date, with the business date in
 * progress there. Live branches only, in name order.
 */
export async function rollupFreshnessOf(
  db: Exec,
  branches: readonly SummaryBranch[],
  now: Date,
): Promise<Array<{ branchId: string; name: string; today: string; lastRolledUpAt: string | null }>> {
  const live = branches.filter((b) => b.archivedAt === null);
  const fresh = await lastRolledUpAt(db, live);
  return live.map((b) => ({
    branchId: b.id,
    name: b.name,
    today: summaryBranchToday(b, now),
    lastRolledUpAt: fresh.get(b.id)?.toISOString() ?? null,
  }));
}

/** Days `from`..`to` inclusive. */
export function summaryDayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}
