import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  branch, branchSourceSwitch, dailySummary, dirtyDate, hourlySummary, type Db, type DirtyDateKind,
} from '@oto/db';
import {
  ANALYTICS_SOURCES, DEFAULT_BRANCH_SOURCE, type AnalyticsSource, type AnalyticsSourcePreference,
} from '@oto/shared';
import { errors } from '../lib/errors';
import { PermissionDeniedError } from '../plugins/session';
import { hasPermission, type EffectivePermission } from './permissions';

export interface ConsoleAnalyticsFormulaRows {
  source: AnalyticsSource;
  formulaVersion: number;
  dailyRows: number;
  hourlyRows: number;
  frozenDailyRows: number;
  provisionalDailyRows: number;
}

interface DirtyDates {
  total: number;
  byKind: Record<DirtyDateKind, number>;
  oldestBusinessDate: string | null;
  newestMarkedAt: string | null;
}

export interface ConsoleAnalyticsBranch {
  branchId: string;
  name: string;
  source: AnalyticsSource;
  preference: AnalyticsSourcePreference;
  switchedAt: string | null;
  formulaRows: ConsoleAnalyticsFormulaRows[];
  dirtyDates: DirtyDates;
}

export interface ConsoleAnalyticsMetadata {
  generatedAt: string;
  basis: 'stored-summary-metadata';
  branches: ConsoleAnalyticsBranch[];
  omitted: string[];
}

function countOf(value: string): number {
  const count = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(count)) throw new Error('Analytics metadata count is not representable.');
  return count;
}

function emptyDirtyDates(): DirtyDates {
  return { total: 0, byKind: { sales: 0, hourly: 0, booth: 0, wallet: 0 }, oldestBusinessDate: null, newestMarkedAt: null };
}

/** Retained metadata only. Source selection and KPI formulas remain in their native services. */
export async function consoleAnalyticsOf(db: Db, input: {
  operatorId: string;
  effective: EffectivePermission[];
  branchIds?: readonly string[];
  now?: Date;
}): Promise<ConsoleAnalyticsMetadata> {
  const now = input.now ?? new Date();
  return db.transaction(async tx => {
    const own = await tx.select({ id: branch.id, name: branch.name, archivedAt: branch.archivedAt })
      .from(branch).where(eq(branch.operatorId, input.operatorId)).orderBy(asc(branch.name), asc(branch.id));
    const requested = [...new Set(input.branchIds ?? [])];
    const candidates = requested.length ? requested.map(id => {
      const found = own.find(park => park.id === id);
      if (!found) throw errors.notFound('Branch not found');
      return found;
    }) : own.filter(park => park.archivedAt === null);
    const consoleRead = (id: string) => hasPermission(input.effective, 'console:analytics:read', { operatorId: input.operatorId, branchId: id });
    const nativeRead = (id: string) => hasPermission(input.effective, 'analytics:read', { operatorId: input.operatorId, branchId: id });
    const selected = candidates.filter(park => consoleRead(park.id) && nativeRead(park.id));
    if (!selected.length) throw new PermissionDeniedError(candidates.some(park => consoleRead(park.id)) ? 'analytics:read' : 'console:analytics:read');
    const ids = selected.map(park => park.id);
    const omitted = requested.length ? candidates.filter(park => !ids.includes(park.id)).map(park => park.id) : [];

    // Both sides of each reference must belong to this operator. Independent FKs do not establish lineage.
    const switches = await tx.select({
      branchId: branchSourceSwitch.branchId, source: branchSourceSwitch.source,
      preference: branchSourceSwitch.preference, switchedAt: branchSourceSwitch.switchedAt,
    }).from(branchSourceSwitch).innerJoin(branch, and(
      eq(branch.id, branchSourceSwitch.branchId), eq(branch.operatorId, branchSourceSwitch.operatorId),
    )).where(and(eq(branchSourceSwitch.operatorId, input.operatorId), inArray(branch.id, ids)));

    const daily = await tx.select({
      branchId: dailySummary.branchId, source: dailySummary.source, formulaVersion: dailySummary.formulaVersion,
      rows: sql<string>`count(*)::text`,
      frozen: sql<string>`count(*) filter (where ${dailySummary.frozen})::text`,
      provisional: sql<string>`count(*) filter (where ${dailySummary.provisional})::text`,
    }).from(dailySummary).innerJoin(branch, and(
      eq(branch.id, dailySummary.branchId), eq(branch.operatorId, dailySummary.operatorId),
    )).where(and(eq(dailySummary.operatorId, input.operatorId), inArray(branch.id, ids)))
      .groupBy(dailySummary.branchId, dailySummary.source, dailySummary.formulaVersion);

    const hourly = await tx.select({
      branchId: hourlySummary.branchId, source: hourlySummary.source,
      formulaVersion: hourlySummary.formulaVersion, rows: sql<string>`count(*)::text`,
    }).from(hourlySummary).innerJoin(branch, and(
      eq(branch.id, hourlySummary.branchId), eq(branch.operatorId, hourlySummary.operatorId),
    )).where(and(eq(hourlySummary.operatorId, input.operatorId), inArray(branch.id, ids)))
      .groupBy(hourlySummary.branchId, hourlySummary.source, hourlySummary.formulaVersion);

    const queued = await tx.select({
      branchId: dirtyDate.branchId, kind: dirtyDate.kind, rows: sql<string>`count(*)::text`,
      oldestBusinessDate: sql<string>`min(${dirtyDate.businessDate})::text`,
      // A raw aggregate bypasses the column decoder; node-postgres returns timestamptz as text.
      newestMarkedAt: sql<Date>`max(${dirtyDate.markedAt})`.mapWith(dirtyDate.markedAt),
    }).from(dirtyDate).innerJoin(branch, and(
      eq(branch.id, dirtyDate.branchId), eq(branch.operatorId, dirtyDate.operatorId),
    )).where(and(eq(dirtyDate.operatorId, input.operatorId), inArray(branch.id, ids)))
      .groupBy(dirtyDate.branchId, dirtyDate.kind);

    const branches = selected.map((park): ConsoleAnalyticsBranch => {
      const configured = switches.find(row => row.branchId === park.id);
      const formulaRows = new Map<string, ConsoleAnalyticsFormulaRows>();
      const group = (source: AnalyticsSource, formulaVersion: number) => {
        const key = `${source}:${formulaVersion}`;
        let row = formulaRows.get(key);
        if (!row) {
          row = { source, formulaVersion, dailyRows: 0, hourlyRows: 0, frozenDailyRows: 0, provisionalDailyRows: 0 };
          formulaRows.set(key, row);
        }
        return row;
      };
      for (const row of daily.filter(row => row.branchId === park.id)) {
        Object.assign(group(row.source, row.formulaVersion), {
          dailyRows: countOf(row.rows), frozenDailyRows: countOf(row.frozen), provisionalDailyRows: countOf(row.provisional),
        });
      }
      for (const row of hourly.filter(row => row.branchId === park.id)) group(row.source, row.formulaVersion).hourlyRows = countOf(row.rows);
      const dirtyDates = emptyDirtyDates();
      for (const row of queued.filter(row => row.branchId === park.id)) {
        const count = countOf(row.rows);
        dirtyDates.byKind[row.kind] = count;
        dirtyDates.total += count;
        if (!Number.isSafeInteger(dirtyDates.total)) throw new Error('Analytics metadata count is not representable.');
        if (dirtyDates.oldestBusinessDate === null || row.oldestBusinessDate < dirtyDates.oldestBusinessDate) dirtyDates.oldestBusinessDate = row.oldestBusinessDate;
        const marked = row.newestMarkedAt.toISOString();
        if (dirtyDates.newestMarkedAt === null || marked > dirtyDates.newestMarkedAt) dirtyDates.newestMarkedAt = marked;
      }
      return {
        branchId: park.id, name: park.name,
        source: configured?.source ?? DEFAULT_BRANCH_SOURCE.source,
        preference: configured ? configured.preference as AnalyticsSourcePreference : DEFAULT_BRANCH_SOURCE.preference,
        switchedAt: configured?.switchedAt.toISOString() ?? null,
        formulaRows: [...formulaRows.values()].sort((a, b) => ANALYTICS_SOURCES.indexOf(a.source) - ANALYTICS_SOURCES.indexOf(b.source) || a.formulaVersion - b.formulaVersion),
        dirtyDates,
      };
    });
    return { generatedAt: now.toISOString(), basis: 'stored-summary-metadata', branches, omitted };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
