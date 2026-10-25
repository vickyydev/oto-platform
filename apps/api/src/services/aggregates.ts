import type { Db } from '@oto/db';
import { isCalendarDate } from '@oto/shared';
import { errors } from '../lib/errors';
import { branchReach } from './access-control';
import { operatorBranches, summaryBranchToday } from './analytics-summary';
import { OVERVIEW_PERMISSION, overviewScopeOf } from './console';
import type { AggregatePeriod, AggregateScope, DailyAggregateInput } from './aggregate-types';
import { assistantUsageAggregateOf, inboxAiUsageAggregateOf } from './aggregates-ai';
import { bookingAggregateOf } from './aggregates-bookings';
import { fleetAggregateOf } from './aggregates-fleet';
import { membersAggregateOf } from './aggregates-members';
import type { EffectivePermission } from './permissions';

export const AGGREGATE_MAX_DAYS = 31;

/** Bounded calendar dates, not timestamps or an inferred trading-day filter. */
export function aggregatePeriodOf(from: string, to: string): AggregatePeriod {
  if (!isCalendarDate(from) || !isCalendarDate(to)) throw errors.badRequest('Use real calendar dates');
  const days = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (days < 1 || days > AGGREGATE_MAX_DAYS) throw errors.badRequest('Choose an ordered range of at most 31 days');
  const start = Date.parse(`${from}T00:00:00.000Z`);
  return { from, to, dates: Array.from({ length: days }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10)) };
}

export interface AggregateReader {
  operatorId: string;
  effective: EffectivePermission[];
  branchId?: string;
  now?: Date;
}
export interface DailyAggregateReader extends AggregateReader { from: string; to: string }

async function scopeOf(db: Db, input: AggregateReader): Promise<AggregateScope> {
  const { available, selected } = overviewScopeOf({ ...input, branches: await operatorBranches(db, input.operatorId) });
  return {
    operatorId: input.operatorId, available, selected, now: input.now ?? new Date(),
    // A union of park grants is never an operator grant. An explicit park excludes unassigned rows.
    includeOperatorWide: input.branchId === undefined && branchReach(input.effective, OVERVIEW_PERMISSION, input.operatorId).kind === 'operator',
  };
}

function envelope(scope: AggregateScope) {
  return {
    generatedAt: scope.now.toISOString(),
    branches: scope.available.map(park => ({
      id: park.id, name: park.name, timezone: park.timezone, businessDayStart: park.businessDayStart.slice(0, 5),
      businessDate: summaryBranchToday(park, scope.now),
    })),
    selectedBranchIds: scope.selected.map(park => park.id),
  };
}

async function dailySnapshot<T>(db: Db, input: DailyAggregateReader, project: (db: Db, input: DailyAggregateInput) => Promise<T>) {
  const period = aggregatePeriodOf(input.from, input.to);
  const scope = await scopeOf(db, input);
  return { ...envelope(scope), period: { from: period.from, to: period.to }, ...await project(db, { ...scope, period }) };
}

export const membersSnapshotOf = (db: Db, input: DailyAggregateReader) => dailySnapshot(db, input, membersAggregateOf);
export const bookingsSnapshotOf = (db: Db, input: DailyAggregateReader) => dailySnapshot(db, input, bookingAggregateOf);
export const assistantUsageSnapshotOf = (db: Db, input: DailyAggregateReader) => dailySnapshot(db, input, assistantUsageAggregateOf);
export const inboxAiUsageSnapshotOf = (db: Db, input: DailyAggregateReader) => dailySnapshot(db, input, inboxAiUsageAggregateOf);
export async function fleetSnapshotOf(db: Db, input: AggregateReader) {
  const scope = await scopeOf(db, input);
  return { ...envelope(scope), ...await fleetAggregateOf(db, scope) };
}
