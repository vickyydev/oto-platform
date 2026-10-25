import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { box, branch, type Db } from '@oto/db';
import type { AggregateScope } from './aggregate-types';

export interface FleetAggregateTotals {
  boxes: number;
  online: number;
  offline: number;
  unclaimed: number;
  disabled: number;
}

export interface FleetAggregate {
  basis: 'current-snapshot';
  asOf: string;
  totals: FleetAggregateTotals;
  parks: Array<FleetAggregateTotals & { branchId: string }>;
}

const emptyTotals = (): FleetAggregateTotals => ({
  boxes: 0, online: 0, offline: 0, unclaimed: 0, disabled: 0,
});

/** Current persisted fleet status, without re-running health or watchdog rules. */
export async function fleetAggregateOf(db: Db, input: AggregateScope): Promise<FleetAggregate> {
  const result: FleetAggregate = {
    basis: 'current-snapshot',
    asOf: input.now.toISOString(),
    totals: emptyTotals(),
    parks: [],
  };
  const selectedIds = [...new Set(input.selected.map((park) => park.id))];
  if (selectedIds.length === 0) return result;

  const grouped = await db.select({
    branchId: branch.id,
    boxes: sql<number>`count(${box.id})::integer`.mapWith(Number),
    online: sql<number>`count(${box.id}) filter (where ${box.status} = 'online')::integer`.mapWith(Number),
    offline: sql<number>`count(${box.id}) filter (where ${box.status} = 'offline')::integer`.mapWith(Number),
    unclaimed: sql<number>`count(${box.id}) filter (where ${box.status} = 'unclaimed')::integer`.mapWith(Number),
    disabled: sql<number>`count(${box.id}) filter (where ${box.status} = 'disabled')::integer`.mapWith(Number),
  })
    .from(branch)
    .leftJoin(box, and(
      eq(box.branchId, branch.id),
      eq(box.operatorId, input.operatorId),
      isNull(box.archivedAt),
    ))
    .where(and(
      eq(branch.operatorId, input.operatorId),
      isNull(branch.archivedAt),
      inArray(branch.id, selectedIds),
    ))
    .groupBy(branch.id);

  const byPark = new Map(grouped.map((row) => [row.branchId, row]));
  for (const branchId of selectedIds) {
    const row = byPark.get(branchId);
    if (!row) continue;
    result.parks.push(row);
    result.totals.boxes += row.boxes;
    result.totals.online += row.online;
    result.totals.offline += row.offline;
    result.totals.unclaimed += row.unclaimed;
    result.totals.disabled += row.disabled;
  }
  return result;
}
