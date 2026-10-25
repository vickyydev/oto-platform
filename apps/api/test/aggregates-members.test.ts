import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branch, member, operator, visit } from '@oto/db';
import { newId } from '@oto/shared';
import { eq } from 'drizzle-orm';
import { membersAggregateOf } from '../src/services/aggregates-members';
import type { DailyAggregateInput } from '../src/services/aggregate-types';
import { createTestContext, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
const dates = ['2026-10-24', '2026-10-25', '2026-10-26'];
const now = new Date('2026-10-25T03:30:00.000Z');
const zero = { visits: 0, draftVisits: 0, activeVisits: 0, closedVisits: 0, visitingMembers: 0 };
beforeAll(async () => { ctx = await createTestContext(); });
afterAll(async () => { await ctx?.close(); await teardownAll(); });

async function estate() {
  const operatorId = newId(), foreignOperatorId = newId();
  await ctx.db.insert(operator).values([
    { id: operatorId, name: 'ZZ TEST visits own' }, { id: foreignOperatorId, name: 'ZZ TEST visits foreign' },
  ]);
  const parks = await ctx.db.insert(branch).values([operatorId, operatorId, foreignOperatorId].map((owner, index) => {
    const id = newId();
    return { id, operatorId: owner, name: `ZZ TEST visits ${index}`, code: `ZZ-TEST-${id}`, timezone: 'Pacific/Honolulu', businessDayStart: '05:00' };
  })).returning();
  const people = await ctx.db.insert(member).values([operatorId, operatorId, foreignOperatorId].map(owner => {
    const id = newId();
    return { id, operatorId: owner, phone: `ZZ TEST ${id}`, nickname: `ZZ TEST ${id}` };
  })).returning();
  const input: DailyAggregateInput = {
    operatorId, available: parks.slice(0, 2), selected: parks.slice(0, 2), includeOperatorWide: false, now,
    period: { from: dates[0]!, to: dates[2]!, dates },
  };
  return { operatorId, foreignOperatorId, parks, people, input };
}

async function record(e: Awaited<ReturnType<typeof estate>>, extra: Partial<typeof visit.$inferInsert> = {}) {
  await ctx.db.insert(visit).values({
    id: newId(), operatorId: e.operatorId, branchId: e.parks[0]!.id,
    memberId: e.people[0]!.id, visitDate: dates[1]!, ...extra,
  });
}

describe('SCRUM-636 visit records and distinct visiting members', () => {
  it('keeps every native status and walk-in, uses visit_date and fills genuine zero days', async () => {
    const e = await estate();
    await record(e, { status: 'draft', createdAt: new Date('2030-01-01T00:00:00Z') });
    await record(e, { status: 'active' });
    await record(e, { status: 'closed', memberId: null });
    await record(e, { visitDate: '2026-10-23' });
    await record(e, { visitDate: '2026-10-27' });
    const result = await membersAggregateOf(ctx.db, e.input);
    expect(result.basis).toBe('visit-date');
    expect(result.totals).toEqual({ visits: 3, draftVisits: 1, activeVisits: 1, closedVisits: 1, visitingMembers: 1 });
    expect(result.parks[0]!.rows).toEqual([
      { date: dates[0], ...zero }, { date: dates[1], ...result.totals }, { date: dates[2], ...zero },
    ]);
    expect(result.parks[1]!.totals).toEqual(zero);
  });

  it('deduplicates members over the whole selected period and parks rather than adding daily distinct counts', async () => {
    const e = await estate();
    await record(e, { visitDate: dates[0]! });
    await record(e, { visitDate: dates[1]! });
    await record(e, { branchId: e.parks[1]!.id, visitDate: dates[2]! });
    await record(e, { memberId: e.people[1]!.id, status: 'active' });
    await ctx.db.update(member).set({ archivedAt: now }).where(eq(member.id, e.people[0]!.id));
    const result = await membersAggregateOf(ctx.db, e.input);
    expect(result.totals).toEqual({ visits: 4, draftVisits: 3, activeVisits: 1, closedVisits: 0, visitingMembers: 2 });
    expect(result.parks.map(park => park.totals.visitingMembers)).toEqual([2, 1]);
    const narrowed = await membersAggregateOf(ctx.db, { ...e.input, selected: [e.parks[1]!] });
    expect(narrowed.totals).toEqual({ visits: 1, draftVisits: 1, activeVisits: 0, closedVisits: 0, visitingMembers: 1 });
  });

  it('fences visit, actual park and referenced member operators without leaking a foreign identity', async () => {
    const e = await estate();
    await record(e);
    await record(e, { operatorId: e.foreignOperatorId });
    await record(e, { branchId: e.parks[2]!.id });
    await record(e, { memberId: e.people[2]!.id });
    const result = await membersAggregateOf(ctx.db, { ...e.input, selected: e.parks });
    expect(result.parks.map(park => park.branchId)).toEqual(e.parks.slice(0, 2).map(park => park.id));
    expect(result.totals.visits).toBe(1);
    expect(result.totals.visitingMembers).toBe(1);
    expect(JSON.stringify(result)).not.toContain(e.people[2]!.id);
  });

  it('revalidates live selected parks and never turns an empty selection into operator totals', async () => {
    const e = await estate();
    await record(e);
    await ctx.db.update(branch).set({ archivedAt: now }).where(eq(branch.id, e.parks[0]!.id));
    const result = await membersAggregateOf(ctx.db, e.input);
    expect(result.parks.map(park => park.branchId)).toEqual([e.parks[1]!.id]);
    expect(result.totals).toEqual(zero);
    const empty = await membersAggregateOf(ctx.db, { ...e.input, selected: [] });
    expect(empty.parks).toEqual([]);
    expect(empty.totals).toEqual(zero);
  });
});
