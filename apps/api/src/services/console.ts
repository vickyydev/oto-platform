import { and, count, eq, isNull } from 'drizzle-orm';
import { alert, schema, type Db } from '@oto/db';
import type { AnalyticsSource } from '@oto/shared';
import { errors } from '../lib/errors';
import { PermissionDeniedError } from '../plugins/session';
import { branchReach, reachCovers } from './access-control';
import { analyticsSummaryOf, operatorBranches, summaryBranchToday, type SummaryBranch } from './analytics-summary';
import { bookingLedger } from './booking-checkout';
import { unansweredSql } from './inbox/read';
import { liveOccupancy } from './occupancy';
import { fleetHealth } from './ops';
import type { EffectivePermission } from './permissions';

export const OVERVIEW_PERMISSION = 'console:overview:read' as const;

export interface OverviewFigures {
  revenueSatang: number;
  guests: number;
  inParkNow: number;
  bookingsToday: number;
  inboxUnanswered: number;
  openAlerts: number;
  boxesOffline: number;
}

export interface OverviewBranch {
  id: string;
  name: string;
  timezone: string;
  businessDayStart: string;
  businessDate: string;
}

export interface OverviewPark extends OverviewFigures {
  branchId: string;
  businessDate: string;
  analyticsSource: AnalyticsSource;
  provisional: boolean;
  lastRolledUpAt: string | null;
  occupancyAsOf: string | null;
  occupancyStale: boolean;
}

export interface OverviewSnapshot {
  generatedAt: string;
  branches: OverviewBranch[];
  selectedBranchIds: string[];
  totals: OverviewFigures;
  parks: OverviewPark[];
}

/** The overview grant authorizes these counts, never the linked detail screens. */
export function overviewScopeOf(input: {
  branches: readonly SummaryBranch[];
  operatorId: string;
  effective: EffectivePermission[];
  branchId?: string;
}): { available: SummaryBranch[]; selected: SummaryBranch[] } {
  const reach = branchReach(input.effective, OVERVIEW_PERMISSION, input.operatorId);
  if (reach.kind === 'branches' && reach.branchIds.length === 0) throw new PermissionDeniedError(OVERVIEW_PERMISSION);
  const available = input.branches.filter((b) => b.archivedAt === null && reachCovers(reach, b.id));
  if (!input.branchId) return { available, selected: available };
  const requestedId = input.branchId.toLowerCase();
  const requested = input.branches.find((b) => b.id === requestedId && b.archivedAt === null);
  if (!requested) throw errors.notFound('Branch not found');
  if (!reachCovers(reach, requested.id)) throw new PermissionDeniedError(OVERVIEW_PERMISSION);
  return { available, selected: [requested] };
}

const emptyFigures = (): OverviewFigures => ({
  revenueSatang: 0, guests: 0, inParkNow: 0, bookingsToday: 0,
  inboxUnanswered: 0, openAlerts: 0, boxesOffline: 0,
});

/**
 * Overview v1 over the existing summary rules. Every figure covers selected
 * live parks only: branchless Inbox conversations and operator/platform alerts
 * are deliberately outside this park total. Errors propagate, never turn into
 * a reassuring zero. Reads run sequentially against the platform's small pool.
 */
export async function overviewOf(db: Db, input: {
  operatorId: string;
  effective: EffectivePermission[];
  branchId?: string;
  now?: Date;
}): Promise<OverviewSnapshot> {
  const now = input.now ?? new Date();
  const { available, selected } = overviewScopeOf({
    ...input,
    branches: await operatorBranches(db, input.operatorId),
  });
  const fleet = selected.length === 0 ? { boxes: [] } : await fleetHealth({
    db, operatorId: input.operatorId, reach: { kind: 'branches', branchIds: selected.map((b) => b.id) },
  }, now.getTime());
  const parks: OverviewPark[] = [];
  for (const park of selected) {
    const day = summaryBranchToday(park, now);
    const summary = await analyticsSummaryOf(db, {
      branches: [park], readable: [park], mergeable: [park], omitted: [],
      from: day, to: day, group: 'total', now,
    });
    const revenue = summary.branches[0]!;
    const figures = revenue.rows[0]!;
    const occupancy = await liveOccupancy(db, { operatorId: input.operatorId, branchId: park.id, now });
    const bookings = await bookingLedger(db, {
      operatorId: input.operatorId, branchId: park.id, from: day, to: day, limit: 1, offset: 0,
    });
    const [inbox] = await db.select({ total: count() }).from(schema.conversation).where(and(
      eq(schema.conversation.operatorId, input.operatorId), eq(schema.conversation.branchId, park.id), unansweredSql,
    ));
    const [alerts] = await db.select({ total: count() }).from(alert).where(and(
      eq(alert.operatorId, input.operatorId), eq(alert.branchId, park.id), isNull(alert.resolvedAt),
    ));
    parks.push({
      branchId: park.id, businessDate: day,
      revenueSatang: figures.revenueSatang, guests: figures.guestsKids + figures.guestsAdults,
      inParkNow: occupancy.total, bookingsToday: bookings.total,
      inboxUnanswered: Number(inbox?.total ?? 0), openAlerts: Number(alerts?.total ?? 0),
      boxesOffline: fleet.boxes.filter((b) => b.branchId === park.id && b.status === 'offline').length,
      analyticsSource: revenue.source, provisional: figures.provisional,
      lastRolledUpAt: revenue.lastRolledUpAt, occupancyAsOf: occupancy.asOf, occupancyStale: occupancy.stale,
    });
  }
  const totals = emptyFigures();
  for (const park of parks) for (const key of Object.keys(totals) as Array<keyof OverviewFigures>) totals[key] += park[key];
  return {
    generatedAt: now.toISOString(),
    branches: available.map((b) => ({
      id: b.id, name: b.name, timezone: b.timezone, businessDayStart: b.businessDayStart.slice(0, 5),
      businessDate: summaryBranchToday(b, now),
    })),
    selectedBranchIds: selected.map((b) => b.id), totals, parks,
  };
}
