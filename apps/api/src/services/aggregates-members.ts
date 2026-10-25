import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { branch, member, visit, type Db } from '@oto/db';
import type { AggregatePark, DailyAggregateInput } from './aggregate-types';

export interface VisitMetrics {
  visits: number;
  draftVisits: number;
  activeVisits: number;
  closedVisits: number;
  visitingMembers: number;
}

const zero = (): VisitMetrics => ({ visits: 0, draftVisits: 0, activeVisits: 0, closedVisits: 0, visitingMembers: 0 });

/** Visit records and distinct visiting members; registered profiles remain operator-wide. */
export async function membersAggregateOf(db: Db, input: DailyAggregateInput) {
  const result: { basis: 'visit-date'; totals: VisitMetrics; parks: AggregatePark<VisitMetrics>[] } = {
    basis: 'visit-date', totals: zero(), parks: [],
  };
  const ids = [...new Set(input.selected.map(park => park.id))];
  if (!ids.length) return result;
  // Separate grouping sets retain true period-wide distinct members, including a
  // member visiting on several days or at several selected parks. No child join.
  const groups = await db.select({
    branchId: sql<string | null>`${branch.id}`,
    date: visit.visitDate,
    level: sql<number>`grouping(${branch.id}, ${visit.visitDate})`.mapWith(Number),
    visits: sql<number>`count(${visit.id})`.mapWith(Number),
    draftVisits: sql<number>`count(${visit.id}) filter (where ${visit.status} = 'draft')`.mapWith(Number),
    activeVisits: sql<number>`count(${visit.id}) filter (where ${visit.status} = 'active')`.mapWith(Number),
    closedVisits: sql<number>`count(${visit.id}) filter (where ${visit.status} = 'closed')`.mapWith(Number),
    visitingMembers: sql<number>`count(distinct ${visit.memberId})`.mapWith(Number),
  }).from(branch)
    .leftJoin(visit, and(
      eq(visit.branchId, branch.id), eq(visit.operatorId, input.operatorId),
      gte(visit.visitDate, input.period.from), lte(visit.visitDate, input.period.to),
      sql`(${visit.memberId} is null or exists (
        select 1 from ${member} where ${member.id} = ${visit.memberId} and ${member.operatorId} = ${input.operatorId}
      ))`,
    ))
    .where(and(eq(branch.operatorId, input.operatorId), isNull(branch.archivedAt), inArray(branch.id, ids)))
    .groupBy(sql`grouping sets ((${branch.id}, ${visit.visitDate}), (${branch.id}), ())`);
  const byPark = new Map<string, { totals: VisitMetrics; days: Map<string, VisitMetrics> }>();
  for (const row of groups) {
    const metrics: VisitMetrics = { visits: row.visits, draftVisits: row.draftVisits, activeVisits: row.activeVisits,
      closedVisits: row.closedVisits, visitingMembers: row.visitingMembers };
    if (row.level === 3) result.totals = metrics;
    else if (row.branchId !== null) {
      let park = byPark.get(row.branchId);
      if (!park) { park = { totals: zero(), days: new Map() }; byPark.set(row.branchId, park); }
      if (row.level === 1) park.totals = metrics;
      else if (row.date !== null) park.days.set(row.date, metrics);
    }
  }
  result.parks = ids.flatMap(branchId => {
    const park = byPark.get(branchId);
    return park ? [{ branchId, totals: park.totals, rows: input.period.dates.map(date => ({ date, ...(park.days.get(date) ?? zero()) })) }] : [];
  });
  return result;
}
