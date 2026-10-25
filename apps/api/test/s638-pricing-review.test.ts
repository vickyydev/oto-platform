import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, aiTurn, ask, branch, channelAccount, contact, conversation, message, operator, schema, type Db } from '@oto/db';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';
import { assistantUsageAggregateOf, inboxAiUsageAggregateOf } from '../src/services/aggregates-ai';
import type { DailyAggregateInput } from '../src/services/aggregate-types';

let ctx: { db: Db }, pool: pg.Pool, database: Awaited<ReturnType<typeof createTestDatabase>>;
const boundary = new Date('2026-10-24T04:00:00.000Z');
const privateText = 'ZZ TEST 638 private usage text';
const tariff = (effectiveFrom = '2026-10-01T00:00:00.000Z', model = 'ZZ_TEST_priced_model', multiplier = 1) => ({
  model, effectiveFrom, inputUsdPerMillion: 0.1 * multiplier, outputUsdPerMillion: 0.2 * multiplier,
  cacheReadUsdPerMillion: 0.03 * multiplier,
});
beforeAll(async () => {
  database = await createTestDatabase(); pool = new pg.Pool({ connectionString: database.url });
  ctx = { db: drizzle(pool, { schema }) };
}, 180_000);
afterAll(async () => { try { await pool?.end(); } finally { try { await database?.drop(); } finally { await stopTestServer(); } } });

async function fixture() {
  const own = randomUUID(), foreign = randomUUID(), person = randomUUID(), outsider = randomUUID();
  await ctx.db.insert(operator).values([{ id: own, name: 'ZZ TEST 638 pricing own' }, { id: foreign, name: 'ZZ TEST 638 pricing foreign' }]);
  const parks = await ctx.db.insert(branch).values([
    { id: randomUUID(), operatorId: own, name: 'ZZ TEST 638 priced park', code: randomUUID(), timezone: 'America/New_York', businessDayStart: '06:00' },
    { id: randomUUID(), operatorId: own, name: 'ZZ TEST 638 empty park', code: randomUUID() },
    { id: randomUUID(), operatorId: foreign, name: 'ZZ TEST 638 foreign park', code: randomUUID() },
  ]).returning();
  await ctx.db.insert(account).values([
    { id: person, operatorId: own, phone: `ZZ TEST ${person}` },
    { id: outsider, operatorId: foreign, phone: `ZZ TEST ${outsider}` },
  ]);
  return { own, foreign, person, outsider, park: parks[0]!, empty: parks[1]!, other: parks[2]! };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const input = (f: Fixture, includeOperatorWide = false): DailyAggregateInput => ({
  operatorId: f.own, available: [f.park, f.empty], selected: [f.park, f.empty], includeOperatorWide,
  now: new Date('2026-10-25T12:00:00.000Z'), period: { from: '2026-10-24', to: '2026-10-25', dates: ['2026-10-24', '2026-10-25'] },
});
async function rates(f: Fixture, versions: unknown[], owner = f.own, extra = {}) {
  const value = { schemaVersion: 1, overrides: { internal: {}, inbox: {} }, rates: versions, ...extra };
  await ctx.db.execute(sql`insert into core.setting(operator_id,key,value) values (${owner},'assistant_settings',${JSON.stringify(value)}::jsonb)
    on conflict(operator_id,key) do update set value=excluded.value`);
}
type Usage = { model?: string | null; at?: Date; branchId?: string | null; input?: number; output?: number; cache?: number; foreignReference?: boolean; gated?: boolean };
async function internal(f: Fixture, u: Usage = {}) {
  await ctx.db.insert(ask).values({ id: randomUUID(), operatorId: f.own, accountId: u.foreignReference ? f.outsider : f.person,
    branchId: u.branchId === undefined ? f.park.id : u.branchId, question: privateText, answer: privateText,
    state: u.gated ? 'capped' : 'answered', reason: u.gated ? 'CAP_DAILY' : null,
    model: u.model === undefined ? 'ZZ_TEST_priced_model' : u.model, inputTokens: u.input ?? 100, outputTokens: u.output ?? 50,
    cacheReadTokens: u.cache ?? 20, createdAt: u.at ?? boundary, updatedAt: u.at ?? boundary });
}
async function inbox(f: Fixture, u: Usage = {}) {
  const owner = u.foreignReference ? f.foreign : f.own, channelId = randomUUID(), contactId = randomUUID(), threadId = randomUUID(), messageId = randomUUID();
  await ctx.db.insert(channelAccount).values({ id: channelId, operatorId: owner, branchId: u.foreignReference ? f.other.id : f.park.id,
    channel: 'webform', provider: 'simulator', externalId: `ZZ TEST ${channelId}`, displayName: privateText });
  await ctx.db.insert(contact).values({ id: contactId, operatorId: owner, channel: 'webform', externalHandle: `ZZ TEST ${contactId}` });
  await ctx.db.insert(conversation).values({ id: threadId, operatorId: owner, branchId: u.branchId === undefined ? f.park.id : u.branchId,
    channelAccountId: channelId, contactId, lastMessagePreview: privateText });
  await ctx.db.insert(message).values({ id: messageId, operatorId: owner, conversationId: threadId, channelAccountId: channelId,
    direction: 'inbound', authorKind: 'customer', body: privateText });
  await ctx.db.insert(aiTurn).values({ id: randomUUID(), operatorId: owner, conversationId: threadId, triggerMessageId: messageId,
    state: u.gated ? 'cancelled' : 'answered', latencyMs: u.gated ? null : 0,
    model: u.model === undefined ? 'ZZ_TEST_priced_model' : u.model, inputTokens: u.input ?? 100, outputTokens: u.output ?? 50,
    cacheReadTokens: u.cache ?? 20, dueAt: boundary, firstSeenAt: boundary, createdAt: u.at ?? boundary, updatedAt: u.at ?? boundary });
}

for (const native of [
  { name: 'internal assistant', add: internal, read: assistantUsageAggregateOf },
  { name: 'Inbox assistant', add: inbox, read: inboxAiUsageAggregateOf },
]) describe(`SCRUM-638 ${native.name} effective-dated USD review`, () => {
  it('R1 high: prices exact per-record effective boundaries before grouping; preserve days, tokens and zero empty buckets', async () => {
    const f = await fixture();
    await rates(f, [tariff(), tariff(boundary.toISOString(), undefined, 2)]);
    await native.add(f, { at: new Date(boundary.getTime() - 1) }); await native.add(f);
    const result = await native.read(ctx.db, input(f));
    expect(result.totals).toEqual({ count: 2, inputTokens: 200, outputTokens: 100, cacheReadTokens: 40, totalTokens: 340,
      spendEstimate: 0.0000618, reason: null, unpricedTokens: 0 });
    expect(result.parks[0]!.rows[0]).toMatchObject({ date: '2026-10-24', spendEstimate: 0.0000618 });
    expect(result.parks[0]!.rows[1]).toMatchObject({ count: 0, spendEstimate: 0, reason: null, unpricedTokens: 0 });
    expect(result.parks[1]!.totals).toMatchObject({ count: 0, spendEstimate: 0, reason: null });
    expect(result).toMatchObject({ currency: 'USD', excludesCacheWrites: true, basis: 'created-at-bangkok' });
    expect(JSON.stringify(result)).not.toContain(privateText); expect(JSON.stringify(result)).not.toContain('ZZ_TEST_priced_model');
  });
  it('R2 high: mixed models and no-effective history retain priced sum plus every unknown token, never zero-cost unknowns', async () => {
    const f = await fixture(); await rates(f, [tariff()]);
    await native.add(f); await native.add(f, { model: 'ZZ_TEST_unknown' });
    await native.add(f, { at: new Date('2026-09-30T20:00:00.000Z') }); // outside requested days, no contribution
    await rates(f, [tariff('2026-10-24T04:00:00.000Z')]);
    await native.add(f, { at: new Date(boundary.getTime() - 1) });
    expect((await native.read(ctx.db, input(f))).totals).toMatchObject({ count: 3, totalTokens: 510,
      spendEstimate: 0.0000206, reason: 'unpriced_tokens', unpricedTokens: 340 });
  });
  it('R3 high: only unknown-model usage is null/unpriced, but an explicitly zero tariff is known zero', async () => {
    const f = await fixture(); await rates(f, [tariff()]); await native.add(f, { model: null });
    expect((await native.read(ctx.db, input(f))).totals).toMatchObject({ spendEstimate: null, reason: 'unpriced_tokens', unpricedTokens: 170 });
    await rates(f, [tariff(undefined, 'ZZ_TEST_zero', 0)]); await native.add(f, { model: 'ZZ_TEST_zero' });
    expect((await native.read(ctx.db, input(f))).totals).toMatchObject({ spendEstimate: 0, reason: 'unpriced_tokens', unpricedTokens: 170 });
  });
  it('R4 high: absent/invalid/other-operator rates preserve no-rate nulls including every empty bucket', async () => {
    const f = await fixture(); await rates(f, [tariff()], f.foreign); await native.add(f);
    for (const invalid of [false, true]) {
      if (invalid) await rates(f, [tariff()], f.own, { unknown: 'ZZ TEST invalid' });
      const result = await native.read(ctx.db, input(f));
      expect(result.totals).toMatchObject({ spendEstimate: null, reason: 'no_rate_configured', unpricedTokens: 170 });
      expect(result.parks[1]!.totals).toMatchObject({ spendEstimate: null, reason: 'no_rate_configured' });
    }
  });
  it('R5 high: native gated-state tokens still price; foreign identity and park joins cannot enter totals or remainder', async () => {
    const f = await fixture(); await rates(f, [tariff()]);
    await native.add(f, { gated: true }); await native.add(f, { foreignReference: true, input: 10000 });
    await native.add(f, { branchId: f.other.id, input: 10000 });
    expect((await native.read(ctx.db, input(f))).totals).toMatchObject({ count: 0, totalTokens: 170,
      spendEstimate: 0.0000206, reason: null, unpricedTokens: 0 });
  });
  it('R6 high: authorized branchless USD is included exactly once, while branch-only reach excludes its cost and tokens', async () => {
    const f = await fixture(); await rates(f, [tariff()]); await native.add(f); await native.add(f, { branchId: null });
    const narrow = await native.read(ctx.db, input(f));
    expect(narrow.operatorWide).toBeNull(); expect(narrow.totals.spendEstimate).toBe(0.0000206);
    const wide = await native.read(ctx.db, input(f, true));
    expect(wide.operatorWide!.totals.spendEstimate).toBe(0.0000206);
    expect(wide.totals).toMatchObject({ count: 2, totalTokens: 340, spendEstimate: 0.0000412, reason: null, unpricedTokens: 0 });
  });
  it('R7 high: adds USD exactly across days/parks/branchless scope, preserving mixed coverage rather than floating-point drift', async () => {
    const f = await fixture(); await rates(f, [tariff()]);
    await native.add(f, { input: 1_000_000, output: 0, cache: 0 });
    const tomorrow = new Date('2026-10-25T04:00:00.000Z');
    await native.add(f, { at: tomorrow, branchId: null, input: 2_000_000, output: 0, cache: 0 });
    await native.add(f, { at: tomorrow, branchId: f.empty.id, model: 'ZZ_TEST_unknown', input: 1, output: 0, cache: 0 });
    const result = await native.read(ctx.db, input(f, true));
    expect(result.totals).toMatchObject({ count: 3, totalTokens: 3_000_001, spendEstimate: 0.3, reason: 'unpriced_tokens', unpricedTokens: 1 });
    expect(result.parks[0]!.totals.spendEstimate).toBe(0.1);
    expect(result.parks[1]!.rows[1]).toMatchObject({ count: 1, spendEstimate: null, reason: 'unpriced_tokens', unpricedTokens: 1 });
    expect(result.operatorWide!.rows[1]).toMatchObject({ count: 1, spendEstimate: 0.2, reason: null, unpricedTokens: 0 });
  });
  it('R8 high: exact model identity and unknown zero-token rows retain unpriced coverage even when no tokens remain', async () => {
    const f = await fixture(); await rates(f, [tariff()]);
    await native.add(f, { model: 'zz_test_priced_model', input: 0, output: 0, cache: 0 });
    expect((await native.read(ctx.db, input(f))).totals).toMatchObject({ spendEstimate: null, reason: 'unpriced_tokens', unpricedTokens: 0 });
    await native.add(f, { input: 0, output: 0, cache: 0 });
    expect((await native.read(ctx.db, input(f))).totals).toMatchObject({ spendEstimate: 0, reason: 'unpriced_tokens', unpricedTokens: 0 });
  });
  it('R9 high: distinct known models use their own versions before sharing one daily group', async () => {
    const f = await fixture();
    await rates(f, [tariff(), { ...tariff(undefined, 'ZZ_TEST_second'), inputUsdPerMillion: 2, outputUsdPerMillion: 3, cacheReadUsdPerMillion: 4 }]);
    await native.add(f); await native.add(f, { model: 'ZZ_TEST_second' });
    expect((await native.read(ctx.db, input(f))).totals).toMatchObject({ count: 2, spendEstimate: 0.0004506, reason: null, unpricedTokens: 0 });
  });
  it('R10 medium: a positive estimate below numeric transport refuses instead of reporting a false priced zero', async () => {
    const f = await fixture();
    await rates(f, [{ ...tariff(), inputUsdPerMillion: Number.MIN_VALUE, outputUsdPerMillion: 0, cacheReadUsdPerMillion: 0 }]);
    await native.add(f, { input: 1, output: 0, cache: 0 });
    await expect(native.read(ctx.db, input(f))).rejects.toThrow('Usage estimate is outside numeric transport');
  });
});
