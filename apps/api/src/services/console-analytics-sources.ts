import { and, asc, count, eq, gte, lte, max, min, sql } from 'drizzle-orm';
import { branch, dailySummary, dirtyDate, type Db } from '@oto/db';
import {
  isLegacyAnalyticsSource, type AnalyticsSource, type AnalyticsSourcePreference, type BranchSourceBody,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { branchSourcesOf, switchBranchSource, type StoredBranchSource } from './analytics-sources';
import { summaryBranchToday, summaryDayCount } from './analytics-summary';
import { analyticsSelectionOf } from './console-analytics';
import { hasPermission, type EffectivePermission } from './permissions';
import { withTx, type OpContext, type Tx } from './tx';

/**
 * SCRUM-646, Q27 Stage 1 — the Console's sources panel, exactly to the ruling.
 *
 * The model as it really is: one serving source per branch for EVERY date
 * (`analytics.branch_source_switch`), Radar's independent preference, and
 * `switched_at`, which is only when the switch was last edited — named
 * `lastEditedAt` here so no screen can read it as an effective business date.
 *
 * Nothing here changes storage, the summary contract, a formula or a frozen-day
 * rule. The preview is read-only; the switch is the existing audited
 * `switchBranchSource`; a re-run only marks `dirty_date` (kind `sales`) through
 * the database's own `analytics.mark_dirty_date`, for the jobs process to
 * consume — it recomputes our POS figures from our own records and can never
 * regenerate a legacy system's day. Nothing unfreezes a day.
 */

export const RERUN_MAX_DAYS = 92;
export const PREVIEW_MAX_DAYS = 366;
const PREVIEW_DEFAULT_DAYS = 30;
const RERUN_REASON = 'console:rerun';

/** The ruling's words for every re-run refusal. */
const OWN_RECORDS_ONLY = 'A re-run recomputes our POS figures from our own records; it can never regenerate a legacy system\'s day.';

export interface ConsoleBranchSource {
  branchId: string;
  name: string;
  source: AnalyticsSource;
  preference: AnalyticsSourcePreference;
  /** When the switch was last edited — never an effective date. Null when never switched. */
  lastEditedAt: string | null;
  lastEditedBy: string | null;
  mayManageSource: boolean;
  mayRerun: boolean;
}

const view = (park: { id: string; name: string }, stored: StoredBranchSource, may: { manage: boolean; rerun: boolean }): ConsoleBranchSource => ({
  branchId: park.id, name: park.name, source: stored.source, preference: stored.preference,
  lastEditedAt: stored.switchedAt?.toISOString() ?? null, lastEditedBy: stored.actorAccountId,
  mayManageSource: may.manage, mayRerun: may.rerun,
});

function doors(effective: EffectivePermission[], operatorId: string, branchId: string) {
  return {
    manage: hasPermission(effective, 'console:analytics:manage_source', { operatorId, branchId }),
    rerun: hasPermission(effective, 'console:analytics:rerun', { operatorId, branchId }),
  };
}

/** Every in-scope park's stored switch, through the Analytics read door. */
export async function consoleSourcesOf(db: Db, input: {
  operatorId: string;
  effective: EffectivePermission[];
  branchIds?: readonly string[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return db.transaction(async tx => {
    const { selected, omitted } = await analyticsSelectionOf(tx, input);
    const stored = await branchSourcesOf(tx, selected.map(park => park.id));
    return {
      generatedAt: now.toISOString(),
      basis: 'whole-branch-switch' as const,
      branches: selected.map(park => view(park, stored.get(park.id)!, doors(input.effective, input.operatorId, park.id))),
      omitted,
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

async function ownBranch(tx: Tx | Db, operatorId: string, branchId: string) {
  const [park] = await tx.select({
    id: branch.id, name: branch.name, timezone: branch.timezone, businessDayStart: branch.businessDayStart,
  }).from(branch).where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId))).limit(1);
  if (!park) throw errors.notFound('Branch not found');
  return park;
}

/**
 * What switching one branch to `source` would serve over a range — read-only.
 * The switch is whole-branch: every date is served from the proposed source,
 * and a day with no stored row of it shows empty. A legacy source serves only
 * its frozen days (the rows it was imported as). Never a date splice.
 */
export async function consoleSourcePreviewOf(db: Db, input: {
  operatorId: string;
  effective: EffectivePermission[];
  branchId: string;
  source: AnalyticsSource;
  from?: string;
  to?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return db.transaction(async tx => {
    const park = await ownBranch(tx, input.operatorId, input.branchId);
    // The Analytics read door for this one park: 403 when it is not held there.
    await analyticsSelectionOf(tx, { ...input, branchIds: [park.id] });
    const to = input.to ?? summaryBranchToday(park, now);
    const from = input.from ?? addDays(to, -(PREVIEW_DEFAULT_DAYS - 1));
    if (from > to) throw errors.badRequest('The start date must not be after the end date.');
    const days = summaryDayCount(from, to);
    if (days > PREVIEW_MAX_DAYS) throw errors.badRequest(`A preview covers at most ${PREVIEW_MAX_DAYS} days.`);
    const legacy = isLegacyAnalyticsSource(input.source);
    const [served] = await tx.select({
      days: count(), first: min(dailySummary.businessDate), last: max(dailySummary.businessDate),
      newest: max(dailySummary.computedAt),
    }).from(dailySummary).where(and(
      eq(dailySummary.operatorId, input.operatorId), eq(dailySummary.branchId, park.id), eq(dailySummary.source, input.source),
      gte(dailySummary.businessDate, from), lte(dailySummary.businessDate, to),
      legacy ? eq(dailySummary.frozen, true) : undefined,
    ));
    const current = (await branchSourcesOf(tx, [park.id])).get(park.id)!;
    const servedDays = Number(served?.days ?? 0);
    return {
      branchId: park.id,
      currentSource: current.source,
      proposedSource: input.source,
      unchanged: current.source === input.source,
      effect: 'whole-branch' as const,
      from, to, days, servedDays, emptyDays: days - servedDays,
      servesFrozenOnly: legacy,
      firstServedDate: served?.first ?? null,
      lastServedDate: served?.last ?? null,
      newestWrittenAt: served?.newest?.toISOString() ?? null,
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** The existing audited switch, behind the Console's own door. */
export async function consoleSwitchSource(db: Db, ctx: OpContext, input: {
  operatorId: string;
  effective: EffectivePermission[];
  actorAccountId: string;
  branchId: string;
  body: BranchSourceBody;
  requestId?: string;
}) {
  const park = await ownBranch(db, input.operatorId, input.branchId);
  return withTx(db, ctx, 'analytics.branch_source.switch', async tx => {
    const { changed, stored } = await switchBranchSource(tx, {
      operatorId: input.operatorId, branchId: park.id, body: input.body,
      actorAccountId: input.actorAccountId, requestId: input.requestId, now: new Date(),
    });
    return { ...view(park, stored, doors(input.effective, input.operatorId, park.id)), changed };
  });
}

/**
 * Queue one branch's own days for the rollup: marks only, never a summary row
 * and never an inline run. Refused for a branch serving a legacy source, and
 * for any day frozen in the serving source, with the ruling's explanation.
 */
export async function consoleRerunOf(db: Db, ctx: OpContext, input: {
  operatorId: string;
  actorAccountId: string;
  branchId: string;
  from: string;
  to: string;
  requestId?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const park = await ownBranch(db, input.operatorId, input.branchId);
  if (input.from > input.to) throw errors.badRequest('The start date must not be after the end date.');
  const days = summaryDayCount(input.from, input.to);
  if (days > RERUN_MAX_DAYS) throw errors.badRequest(`A re-run covers at most ${RERUN_MAX_DAYS} days; choose a shorter range.`);
  if (input.to > summaryBranchToday(park, now)) throw errors.badRequest('A re-run cannot include a day that has not started at this park.');
  return withTx(db, ctx, 'analytics.rerun.request', async tx => {
    // The switch's own lock: a concurrent switch to a legacy source cannot slip between this check and the marks.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('analytics.branch_source_switch'), hashtext(${park.id}))`);
    const serving = (await branchSourcesOf(tx, [park.id])).get(park.id)!;
    if (isLegacyAnalyticsSource(serving.source)) {
      throw new AppError(409, 'ANALYTICS_RERUN_LEGACY_SOURCE',
        `This park reports from ${serving.source}. ${OWN_RECORDS_ONLY} Nothing was queued.`, { source: serving.source });
    }
    const frozen = await tx.select({ businessDate: dailySummary.businessDate }).from(dailySummary).where(and(
      eq(dailySummary.operatorId, input.operatorId), eq(dailySummary.branchId, park.id), eq(dailySummary.source, serving.source),
      eq(dailySummary.frozen, true), gte(dailySummary.businessDate, input.from), lte(dailySummary.businessDate, input.to),
    )).orderBy(asc(dailySummary.businessDate));
    if (frozen.length) {
      throw new AppError(409, 'ANALYTICS_RERUN_FROZEN_DAYS',
        `Some days in this range are frozen and are never recomputed. ${OWN_RECORDS_ONLY} Nothing was queued.`,
        { frozenDates: frozen.map(row => row.businessDate) });
    }
    const [queued] = await tx.select({ days: count() }).from(dirtyDate).where(and(
      eq(dirtyDate.branchId, park.id), eq(dirtyDate.kind, 'sales'),
      gte(dirtyDate.businessDate, input.from), lte(dirtyDate.businessDate, input.to),
    ));
    // The database's own mark, as every late sale makes it: a new day is inserted, a marked day is bumped and unclaimed.
    await tx.execute(sql`
      select analytics.mark_dirty_date(${input.operatorId}::uuid, ${park.id}::uuid, d::date, 'sales', ${RERUN_REASON})
        from generate_series(${input.from}::date, ${input.to}::date, interval '1 day') as d`);
    const range = { from: input.from, to: input.to, days, kind: 'sales' as const, source: serving.source };
    await audit.record(tx, {
      actorAccountId: input.actorAccountId, operatorId: input.operatorId, branchId: park.id,
      action: 'analytics.rerun.request', entityType: 'branch', entityId: park.id,
      before: { from: input.from, to: input.to, alreadyQueuedDays: Number(queued?.days ?? 0) },
      after: range, requestId: input.requestId ?? null,
    });
    return { branchId: park.id, ...range, reason: RERUN_REASON };
  });
}
