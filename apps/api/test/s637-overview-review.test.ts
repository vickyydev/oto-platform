import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, ask, branch, member, operator, visit } from '@oto/db';
import { newId } from '@oto/shared';
import { eq } from 'drizzle-orm';
import { OverviewSchema } from '../src/routes/console';
import { overviewOf } from '../src/services/console';
import {
  assistantUsageSnapshotOf, bookingsSnapshotOf, fleetSnapshotOf,
  inboxAiUsageSnapshotOf, membersSnapshotOf,
} from '../src/services/aggregates';
import type { EffectivePermission } from '../src/services/permissions';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let cookie: string;
const operatorId = newId();
const parks = [newId(), newId()];
const person = newId();
const now = new Date('2026-10-25T03:30:00.000Z');
const period = { from: '2026-10-25', to: '2026-10-25' };
const effective: EffectivePermission[] = [{ permission: 'console:overview:read', scopeType: 'operator', scopeId: operatorId, roleName: 'ZZ TEST summary only' }];

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  await ctx.db.insert(operator).values({ id: operatorId, name: 'ZZ TEST Overview v2' });
  await ctx.db.insert(branch).values(parks.map((id, index) => ({
    id, operatorId, name: `ZZ TEST Overview v2 ${index}`, code: `ZZ-TEST-${id}`,
    timezone: index === 0 ? 'Pacific/Honolulu' : 'Pacific/Kiritimati', businessDayStart: '05:00',
  })));
  await ctx.db.insert(member).values({ id: person, operatorId, phone: `ZZ TEST ${person}`, nickname: 'ZZ TEST private member' });
  await ctx.db.insert(visit).values([
    { id: newId(), operatorId, branchId: parks[0]!, memberId: person, visitDate: period.from, status: 'draft' },
    { id: newId(), operatorId, branchId: parks[1]!, memberId: person, visitDate: period.from, status: 'closed' },
    { id: newId(), operatorId, branchId: parks[0]!, visitDate: '2026-10-24' },
  ]);
  const actor = newId();
  await ctx.db.insert(account).values({ id: actor, operatorId, phone: `ZZ TEST ${actor}`, status: 'active' });
  await ctx.db.insert(ask).values([
    { id: newId(), operatorId, accountId: actor, branchId: parks[0]!, question: 'ZZ TEST private question', state: 'answered', model: 'zz-test-unpriced-model', inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, createdAt: now },
    { id: newId(), operatorId, accountId: actor, branchId: null, question: 'ZZ TEST private unassigned', state: 'answered', model: 'zz-test-unpriced-model', inputTokens: 7, createdAt: now },
  ]);
}, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-637 Overview v2 composed native read model', () => {
  it('R1: exposes the exact five existing summaries with one captured time and calendar date', async () => {
    const input = { operatorId, effective, now };
    const result = await overviewOf(ctx.db, input);
    const body = result as unknown as { aggregates: Record<string, unknown> };
    const expected = {
      members: await membersSnapshotOf(ctx.db, { ...input, ...period }),
      bookings: await bookingsSnapshotOf(ctx.db, { ...input, ...period }),
      assistantUsage: await assistantUsageSnapshotOf(ctx.db, { ...input, ...period }),
      inboxAiUsage: await inboxAiUsageSnapshotOf(ctx.db, { ...input, ...period }),
      fleet: await fleetSnapshotOf(ctx.db, input),
    };
    expect(body.aggregates).toEqual(expected);
    expect(result.generatedAt).toBe(now.toISOString());
    expect(result.parks.map(park => park.businessDate)).toEqual(['2026-10-24', '2026-10-25']);
    expect(OverviewSchema.safeParse(result).success).toBe(true);
  });

  it('R2: retains distinct selected-period members instead of summing per-park counts', async () => {
    const result = await overviewOf(ctx.db, { operatorId, effective, now });
    expect(result).toHaveProperty('aggregates.members.totals.visits', 2);
    expect(result).toHaveProperty('aggregates.members.totals.visitingMembers', 1);
    expect(result).toHaveProperty('aggregates.members.parks.0.totals.visitingMembers', 1);
    expect(result).toHaveProperty('aggregates.members.parks.1.totals.visitingMembers', 1);
  });

  it('R3: includes unassigned AI once only for an unfiltered genuine operator grant', async () => {
    const all = await overviewOf(ctx.db, { operatorId, effective, now });
    expect(all).toHaveProperty('aggregates.assistantUsage.totals.totalTokens', 22);
    expect(all).toHaveProperty('aggregates.assistantUsage.operatorWide.totals.totalTokens', 7);
    const branchUnion: EffectivePermission[] = parks.map(scopeId => ({
      permission: 'console:overview:read', scopeType: 'branch', scopeId, roleName: 'ZZ TEST park union',
    }));
    const union = await overviewOf(ctx.db, { operatorId, effective: branchUnion, now });
    const selected = await overviewOf(ctx.db, { operatorId, effective, now, branchId: parks[0] });
    for (const result of [union, selected]) {
      expect(result).toHaveProperty('aggregates.assistantUsage.operatorWide', null);
      expect(result).toHaveProperty('aggregates.assistantUsage.totals.totalTokens', 15);
    }
  });

  it('R4: copies safe source/date/status text, preserving unavailable USD pricing and native review-row units', async () => {
    const result = await overviewOf(ctx.db, { operatorId, effective, now });
    expect(result).toHaveProperty('statusSummary');
    const text = (result as unknown as { statusSummary: string }).statusSummary;
    for (const expected of ['2026-10-25', '2026-10-24', 'ZZ TEST Overview v2', 'USD', 'no_rate_configured', '22', 'cache', 'End-of-day review rows still inside', 'Not built']) expect(text).toContain(expected);
    for (const privateValue of [person, 'ZZ TEST private member', 'ZZ TEST private question', 'ZZ TEST private unassigned']) expect(text).not.toContain(privateValue);
    expect(text).not.toMatch(/<[^>]+>/);
    expect(result).toHaveProperty('aggregates.assistantUsage.totals.spendEstimate', null);
    expect(result).toHaveProperty('aggregates.inboxAiUsage.totals.reason', 'no_rate_configured');
  });

  it('R5: keeps failed child queries as failures instead of returning an all-clear summary', async () => {
    const failure = new Error('ZZ TEST unavailable native source');
    const broken = new Proxy(ctx.db, { get(target, key, receiver) {
      if (key === 'transaction') return () => { throw failure; };
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(overviewOf(broken, { operatorId, effective, now })).rejects.toBe(failure);
  });

  it('R6: HTTP output validates all composed groups and forbids browser caching', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/overview', headers: { cookie } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    for (const key of ['members', 'bookings', 'assistantUsage', 'inboxAiUsage', 'fleet']) expect(response.json()).toHaveProperty(`aggregates.${key}`);
    expect(response.json()).toHaveProperty('decisions.items');
    expect(response.json()).toHaveProperty('statusSummary');
    expect(OverviewSchema.safeParse(response.json()).success).toBe(true);
  });

  it('R7: a live archive cannot remain in a freshly requested child scope or copied text', async () => {
    await ctx.db.update(branch).set({ archivedAt: now }).where(eq(branch.id, parks[1]!));
    try {
      const result = await overviewOf(ctx.db, { operatorId, effective, now });
      expect(result.selectedBranchIds).toEqual([parks[0]]);
      expect(result).toHaveProperty('aggregates.members.totals.visits', 1);
      expect(result).toHaveProperty('aggregates.members.selectedBranchIds', [parks[0]]);
      expect((result as unknown as { statusSummary: string }).statusSummary).not.toContain('ZZ TEST Overview v2 1');
    } finally { await ctx.db.update(branch).set({ archivedAt: null }).where(eq(branch.id, parks[1]!)); }
  });
});
