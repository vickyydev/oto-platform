import { and, asc, desc, eq, gte, inArray, lte, max, sql } from 'drizzle-orm';
import { branch, dailySummary, dirtyDate, hourlySummary, opsRun, type Db } from '@oto/db';
import {
  ANALYTICS_MERGE_PERMISSION,
  ANALYTICS_PLATFORM_SOURCE,
  ANALYTICS_SUMMARY_PERMISSIONS,
  addDaysToIsoDate,
  businessDate,
  emptyAnalyticsDayFigures,
  isLegacyAnalyticsSource,
  parseDayStart,
  sumAnalyticsDayFigures,
  type AnalyticsDayFigures,
  type AnalyticsSource,
  type AnalyticsSummary,
  type AnalyticsSummaryBranch,
  type AnalyticsSummaryGroup,
  type AnalyticsSummaryHour,
  type AnalyticsSummaryRow,
} from '@oto/shared';
import { ROLLUP_DAILY_JOB } from './analytics-rollup';
import { lastBoothRolledUpAt } from './analytics-booth';
import { branchSourcesOf } from './analytics-sources';
import { hasPermission, type EffectivePermission } from './permissions';
import type { Exec } from './tx';

/**
 * S2-15b (SCRUM-216) round 3 — THE STORED FIGURES, READ (plan
 * docs/progress/plans/analytics/PLAN.md §5, §8 round 3).
 *
 * `GET /analytics/summary` answers from `analytics.daily_summary` and
 * `analytics.hourly_summary` only — never from the sales tables — so Today >
 * Performance shows the same figures on every till and phone, and survives a
 * reload. (The rollup's own queue, `analytics.dirty_date`, says only whether a
 * day with no row is still owed a write; it adds no figure.) Each branch's
 * rows are its own; the merged rows add up ONLY the
 * branches the caller may read (`mayReadAnalytics`), and a requested branch
 * the caller may not read is listed as omitted, never folded into a total.
 *
 * Nothing here writes. The rollup (`analytics-rollup.ts`) is the only writer.
 */

const SOURCE = ANALYTICS_PLATFORM_SOURCE;

/** May this caller read this branch's figures on their own? The Today screen's permission, or `analytics:read`. */
export function mayReadAnalytics(effective: EffectivePermission[], operatorId: string, branchId: string): boolean {
  return ANALYTICS_SUMMARY_PERMISSIONS.some((permission) => hasPermission(effective, permission, { operatorId, branchId }));
}

/** May this caller add this branch into a total of several? `analytics:read` there, nothing else (plan §9 question 9). */
export function mayMergeAnalytics(effective: EffectivePermission[], operatorId: string, branchId: string): boolean {
  return hasPermission(effective, ANALYTICS_MERGE_PERMISSION, { operatorId, branchId });
}

/**
 * THE BRANCHES ONE SUMMARY COVERS (round 6 closing sweep; plan §9 question 9's
 * default, which round 3 had not applied to a total).
 *
 * The candidates are the requested branches, or — when none is named — every
 * live branch the caller may read. Those the caller may read on its own (the
 * Today screen's permission or `analytics:read`) are kept; when that leaves
 * MORE THAN ONE, the answer is a total, and a total adds up only the branches
 * the caller holds `analytics:read` at. So a counter account that opens Today
 * at two parks reads each on its own and never their sum.
 *
 * `omitted` lists the requested branches left out, for either reason.
 * `denied` names what was missing when nothing is left: the Today screen's
 * permission when no candidate could be read at all, `analytics:read` when
 * only the total's rule emptied it.
 */
export function summaryScopeOf<B extends { id: string }>(input: {
  candidates: readonly B[];
  requested: boolean;
  mayRead: (b: B) => boolean;
  mayMerge: (b: B) => boolean;
}): { branches: B[]; omitted: string[]; denied: 'pos:cash:read' | 'analytics:read' | null } {
  const readable = input.candidates.filter(input.mayRead);
  const branches = readable.length > 1 ? readable.filter(input.mayMerge) : readable;
  const kept = new Set(branches.map((b) => b.id));
  const omitted = input.requested ? input.candidates.filter((b) => !kept.has(b.id)).map((b) => b.id) : [];
  const denied = branches.length > 0 ? null : readable.length > 0 ? 'analytics:read' : 'pos:cash:read';
  return { branches, omitted, denied };
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
 * later of that and when TODAY's row at the branch was last written — not the
 * newest row of any date: a run that rewrites an old day (a late refund) and
 * then fails before today's write has not brought today up to date, and must
 * not make the park read as just updated. For an archived branch, which has no
 * today, its newest row. A branch created after that run was not in it.
 */
export async function lastRolledUpAt(
  db: Exec,
  branches: readonly SummaryBranch[],
  now: Date,
): Promise<Map<string, Date | null>> {
  return freshnessOf(db, branches, now, async (live, todayOf, archived) => {
    const todays =
      live.length === 0
        ? []
        : await db
            .select({ branchId: dailySummary.branchId, businessDate: dailySummary.businessDate, computedAt: dailySummary.computedAt })
            .from(dailySummary)
            .where(
              and(
                inArray(dailySummary.branchId, live),
                eq(dailySummary.source, SOURCE),
                inArray(dailySummary.businessDate, [...new Set(todayOf.values())]),
              ),
            );
    const written = new Map(todays.filter((r) => todayOf.get(r.branchId) === r.businessDate).map((r) => [r.branchId, r.computedAt]));
    if (archived.length > 0) {
      const newest = await db
        .select({ branchId: dailySummary.branchId, computedAt: max(dailySummary.computedAt) })
        .from(dailySummary)
        .where(and(inArray(dailySummary.branchId, archived), eq(dailySummary.source, SOURCE)))
        .groupBy(dailySummary.branchId);
      for (const n of newest) if (n.computedAt) written.set(n.branchId, n.computedAt);
    }
    return written;
  });
}

/**
 * The same, for the Reports panels' rows (round 6 closing sweep: Health names
 * their freshness on its own line). They are written by the daily rollup in
 * the transaction that writes the day, so a park's report rows are as fresh as
 * the later of the newest successful daily run and the last write of today's
 * report rows there — read from the report tables themselves, so a rollup that
 * ever wrote them apart would show it here.
 */
export async function lastReportsRolledUpAt(
  db: Exec,
  branches: readonly SummaryBranch[],
  now: Date,
): Promise<Map<string, Date | null>> {
  return freshnessOf(db, branches, now, async (live, todayOf, archived) => {
    const ids = [...live, ...archived];
    const written = new Map<string, Date>();
    if (ids.length === 0) return written;
    const idList = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const { rows } = await db.execute<{ branch_id: string; business_date: string; at: Date | string }>(sql`
      select r.branch_id, r.business_date::text as business_date, max(r.computed_at) as at
        from (
          select branch_id, business_date, computed_at from analytics.daily_category_summary where source = ${SOURCE} and branch_id in (${idList})
          union all
          select branch_id, business_date, computed_at from analytics.daily_tender_summary where source = ${SOURCE} and branch_id in (${idList})
          union all
          select branch_id, business_date, computed_at from analytics.daily_item_summary where source = ${SOURCE} and branch_id in (${idList})
          union all
          select branch_id, business_date, computed_at from analytics.daily_ticket_summary where source = ${SOURCE} and branch_id in (${idList})
          union all
          select branch_id, business_date, computed_at from analytics.daily_discount_summary where source = ${SOURCE} and branch_id in (${idList})
        ) r
       group by r.branch_id, r.business_date`);
    const archivedSet = new Set(archived);
    for (const row of rows) {
      const at = new Date(row.at);
      const date = String(row.business_date).slice(0, 10);
      // A live park: today's rows only. An archived one: its newest of any day.
      if (!archivedSet.has(row.branch_id) && todayOf.get(row.branch_id) !== date) continue;
      const seen = written.get(row.branch_id);
      if (!seen || at.getTime() > seen.getTime()) written.set(row.branch_id, at);
    }
    return written;
  });
}

/**
 * The later of when `written` says each branch's rows were last written and
 * the start of the newest successful daily rollup (for a live branch that
 * existed then). `written` is handed the live branches with their today, and
 * the archived ones.
 */
async function freshnessOf(
  db: Exec,
  branches: readonly SummaryBranch[],
  now: Date,
  written: (live: string[], todayOf: Map<string, string>, archived: string[]) => Promise<Map<string, Date>>,
): Promise<Map<string, Date | null>> {
  const out = new Map<string, Date | null>();
  if (branches.length === 0) return out;
  const [lastRun] = await db
    .select({ startedAt: opsRun.startedAt })
    .from(opsRun)
    .where(and(eq(opsRun.name, ROLLUP_DAILY_JOB), eq(opsRun.outcome, 'ok')))
    .orderBy(desc(opsRun.startedAt))
    .limit(1);
  const live = branches.filter((b) => b.archivedAt === null);
  const archived = branches.filter((b) => b.archivedAt !== null);
  const todayOf = new Map(live.map((b) => [b.id, summaryBranchToday(b, now)]));
  const rows = await written(
    live.map((b) => b.id),
    todayOf,
    archived.map((b) => b.id),
  );
  for (const b of branches) {
    const row = rows.get(b.id) ?? null;
    const run =
      lastRun && b.archivedAt === null && lastRun.startedAt.getTime() >= b.createdAt.getTime() ? lastRun.startedAt : null;
    const later = row && run ? (row.getTime() >= run.getTime() ? row : run) : (row ?? run);
    out.set(b.id, later);
  }
  return out;
}

/**
 * When the frozen days a branch on a legacy source serves were last written:
 * the newest `computed_at` of that source's frozen rows there. Null when it
 * has none.
 */
async function lastLegacyWrittenAt(
  db: Exec,
  bySource: ReadonlyMap<string, AnalyticsSource>,
): Promise<Map<string, Date | null>> {
  const ids = [...bySource.entries()].filter(([, source]) => isLegacyAnalyticsSource(source)).map(([id]) => id);
  const out = new Map<string, Date | null>(ids.map((id) => [id, null]));
  if (ids.length === 0) return out;
  const rows = await db
    .select({ branchId: dailySummary.branchId, source: dailySummary.source, computedAt: max(dailySummary.computedAt) })
    .from(dailySummary)
    .where(and(inArray(dailySummary.branchId, ids), eq(dailySummary.frozen, true)))
    .groupBy(dailySummary.branchId, dailySummary.source);
  for (const row of rows) {
    if (row.computedAt && bySource.get(row.branchId) === row.source) out.set(row.branchId, row.computedAt);
  }
  return out;
}

/**
 * The branch-days `from`..`to` the rollup still owes a write: a fact marked
 * them (`dirty_date` kind `sales` — every write to a sale, a refund, a payment
 * or a wallet entry marks its day, and migration 0064 queued every day that
 * already had sales) and no run has consumed the mark yet. Read from the
 * rollup's own queue, not from the sales.
 */
async function queuedBranchDays(db: Exec, ids: readonly string[], from: string, to: string): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ branchId: dirtyDate.branchId, businessDate: dirtyDate.businessDate })
    .from(dirtyDate)
    .where(
      and(
        inArray(dirtyDate.branchId, [...ids]),
        eq(dirtyDate.kind, 'sales'),
        gte(dirtyDate.businessDate, from),
        lte(dirtyDate.businessDate, to),
      ),
    );
  return new Set(rows.map((r) => `${r.branchId}|${r.businessDate}`));
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
 * The summary for `branches` (already decided by `summaryScopeOf`: those the
 * caller may read, and when several, those it may add up), `from`..`to`.
 * `readable` is every live branch the caller may read on its own, `mergeable`
 * every one it may add up, and `omitted` the requested ones left out — all
 * decided by the caller of this function, which holds the permissions.
 *
 * ROUND 6 — each branch is answered from the source its switch names
 * (`analytics-sources.ts`): `oto_pos`, the rollup's days, as before; a legacy
 * source, that source's frozen days only. Nothing of one source is ever read
 * for a branch on another.
 */
export async function analyticsSummaryOf(
  db: Db,
  input: {
    branches: readonly SummaryBranch[];
    readable: readonly SummaryBranch[];
    mergeable: readonly SummaryBranch[];
    omitted: readonly string[];
    from: string;
    to: string;
    group: AnalyticsSummaryGroup;
    now: Date;
  },
): Promise<AnalyticsSummary> {
  const { from, to, group, now } = input;
  const ids = input.branches.map((b) => b.id);
  const switches = await branchSourcesOf(db, ids);
  const sourceOf = new Map<string, AnalyticsSource>(ids.map((id) => [id, switches.get(id)?.source ?? SOURCE]));
  const platformIds = ids.filter((id) => sourceOf.get(id) === SOURCE);
  const sources = [...new Set(sourceOf.values())];
  const stored =
    ids.length === 0
      ? []
      : (
          await db
            .select()
            .from(dailySummary)
            .where(
              and(
                inArray(dailySummary.branchId, ids),
                inArray(dailySummary.source, sources),
                gte(dailySummary.businessDate, from),
                lte(dailySummary.businessDate, to),
              ),
            )
            .orderBy(asc(dailySummary.businessDate), asc(dailySummary.branchId))
        ).filter(
          // The branch's own source only; of a legacy source, its frozen days
          // only (the rows it was imported as — nothing else writes one).
          (row) => row.source === sourceOf.get(row.branchId) && (row.source === SOURCE || row.frozen),
        );
  const byKey = new Map(stored.map((row) => [`${row.branchId}|${row.businessDate}`, row]));
  const dates = datesBetween(from, to);
  const fresh = await lastRolledUpAt(
    db,
    input.branches.filter((b) => sourceOf.get(b.id) === SOURCE),
    now,
  );
  const legacyFresh = await lastLegacyWrittenAt(db, sourceOf);
  const queued = await queuedBranchDays(db, platformIds, from, to);

  const branches: AnalyticsSummaryBranch[] = [];
  const allDays: BranchDay[] = [];
  for (const b of input.branches) {
    const today = summaryBranchToday(b, now);
    const source = sourceOf.get(b.id) ?? SOURCE;
    const legacy = isLegacyAnalyticsSource(source);
    const days = dates.map((date): BranchDay => {
      const row = byKey.get(`${b.id}|${date}`) ?? null;
      return {
        branchId: b.id,
        date,
        stored: row,
        // A stored row says for itself. A day with no row is still moving
        // until it has ended at its branch, or while the rollup's queue still
        // holds it (a day that traded but has not been written yet — the 0064
        // backlog, or a rollup that has stopped). Otherwise it had no sale.
        // A legacy source's days are frozen history: nothing will write a day
        // it does not have, so such a day is final.
        provisional: row ? row.provisional : !legacy && (date >= today || queued.has(`${b.id}|${date}`)),
      };
    });
    allDays.push(...days);
    branches.push({
      branchId: b.id,
      name: b.name,
      source,
      timezone: b.timezone,
      businessDayStart: businessDayStartLabel(b.businessDayStart),
      today,
      lastRolledUpAt: (legacy ? legacyFresh.get(b.id) : fresh.get(b.id))?.toISOString() ?? null,
      rows: groupRows(days, dates, group),
    });
  }

  let hours: AnalyticsSummaryHour[] | null = null;
  if (from === to) {
    // A legacy source keeps no hours: only the branches on the platform's own.
    const hourRows = platformIds.length === 0
      ? []
      : await db
          .select()
          .from(hourlySummary)
          .where(
            and(
              inArray(hourlySummary.branchId, platformIds),
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
    source: sources.length === 1 ? sources[0]! : null,
    branches,
    omitted: [...input.omitted],
    readable: input.readable.map((b) => ({ branchId: b.id, name: b.name })),
    mergeable: input.mergeable.map((b) => ({ branchId: b.id, name: b.name })),
    merged: groupRows(allDays, dates, group),
    hours,
    lastRolledUpAt: oldest,
  };
}

/**
 * The Health page's lines per branch (plan §1): when the rollup last brought
 * each branch in the caller's reach up to date, with the business date in
 * progress there; (round 5) when the booth figures were; and (round 6) when
 * the Reports panels' rows were. Live branches only, in name order.
 */
export async function rollupFreshnessOf(
  db: Exec,
  branches: readonly SummaryBranch[],
  now: Date,
): Promise<
  Array<{
    branchId: string;
    name: string;
    today: string;
    lastRolledUpAt: string | null;
    boothLastRolledUpAt: string | null;
    reportsLastRolledUpAt: string | null;
  }>
> {
  const live = branches.filter((b) => b.archivedAt === null);
  const fresh = await lastRolledUpAt(db, live, now);
  const booth = await lastBoothRolledUpAt(db, live);
  const reports = await lastReportsRolledUpAt(db, live, now);
  return live.map((b) => ({
    branchId: b.id,
    name: b.name,
    today: summaryBranchToday(b, now),
    lastRolledUpAt: fresh.get(b.id)?.toISOString() ?? null,
    boothLastRolledUpAt: booth.get(b.id)?.toISOString() ?? null,
    reportsLastRolledUpAt: reports.get(b.id)?.toISOString() ?? null,
  }));
}

/** Days `from`..`to` inclusive. */
export function summaryDayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}
