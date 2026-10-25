import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, aiTurn, ask, branch, channelAccount, contact, conversation, message, operator } from '@oto/db';
import { assistantUsageAggregateOf, inboxAiUsageAggregateOf, type AiUsageMetrics } from '../src/services/aggregates-ai';
import type { DailyAggregateInput } from '../src/services/aggregate-types';
import { createTestContext, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
const dates = ['2026-10-24', '2026-10-25'];
const dayOne = new Date('2026-10-24T03:00:00.000Z');
const privateText = 'ZZ TEST private question, customer text and correction';
const metrics = (count = 0, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0): AiUsageMetrics => ({ count, inputTokens, outputTokens, cacheReadTokens, totalTokens: inputTokens + outputTokens + cacheReadTokens });

beforeAll(async () => { ctx = await createTestContext(); }, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

async function fixture() {
  const own = randomUUID(), foreign = randomUUID(), person = randomUUID(), outsider = randomUUID();
  await ctx.db.insert(operator).values([{ id: own, name: 'ZZ TEST 636 AI own' }, { id: foreign, name: 'ZZ TEST 636 AI foreign' }]);
  const parks = await ctx.db.insert(branch).values([
    { id: randomUUID(), operatorId: own, name: 'ZZ TEST AI Alpha', code: randomUUID(), timezone: 'America/New_York', businessDayStart: '06:00' },
    { id: randomUUID(), operatorId: own, name: 'ZZ TEST AI Beta', code: randomUUID() },
    { id: randomUUID(), operatorId: foreign, name: 'ZZ TEST AI Foreign', code: randomUUID() },
  ]).returning();
  await ctx.db.insert(account).values([
    { id: person, operatorId: own, phone: `ZZ TEST 636 ${person}`, status: 'inactive' },
    { id: outsider, operatorId: foreign, phone: `ZZ TEST 636 ${outsider}`, status: 'active' },
  ]);
  return { own, foreign, person, outsider, a: parks[0]!, b: parks[1]!, other: parks[2]! };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function input(f: Fixture, selected = [f.a, f.b], includeOperatorWide = false): DailyAggregateInput {
  return { operatorId: f.own, available: [f.a, f.b], selected, includeOperatorWide, now: new Date('2026-10-25T18:00:00Z'),
    period: { from: dates[0]!, to: dates[1]!, dates } };
}

async function question(f: Fixture, values: Partial<typeof ask.$inferInsert> = {}) {
  const id = randomUUID();
  await ctx.db.insert(ask).values({ id, operatorId: f.own, accountId: f.person, branchId: f.a.id,
    question: privateText, answer: privateText, state: 'answered', createdAt: dayOne, updatedAt: dayOne, ...values });
  return id;
}
async function thread(f: Fixture, branchId: string | null = f.a.id, foreign = false) {
  const owner = foreign ? f.foreign : f.own, channelId = randomUUID(), contactId = randomUUID(), id = randomUUID(), messageId = randomUUID();
  await ctx.db.insert(channelAccount).values({ id: channelId, operatorId: owner, branchId: foreign ? f.other.id : f.a.id,
    channel: 'webform', provider: 'simulator', externalId: `ZZ TEST ${channelId}`, displayName: privateText });
  await ctx.db.insert(contact).values({ id: contactId, operatorId: owner, channel: 'webform', externalHandle: `ZZ TEST ${contactId}`, displayName: privateText });
  await ctx.db.insert(conversation).values({ id, operatorId: owner, branchId, channelAccountId: channelId, contactId, lastMessagePreview: privateText });
  await ctx.db.insert(message).values({ id: messageId, operatorId: owner, conversationId: id, channelAccountId: channelId, direction: 'inbound', authorKind: 'customer', body: privateText });
  return { owner, id, messageId };
}
async function turn(t: Awaited<ReturnType<typeof thread>>, values: Partial<typeof aiTurn.$inferInsert> = {}) {
  const id = randomUUID();
  await ctx.db.insert(aiTurn).values({ id, operatorId: t.owner, conversationId: t.id, triggerMessageId: t.messageId,
    state: 'answered', latencyMs: 1, dueAt: dayOne, firstSeenAt: dayOne, createdAt: dayOne, updatedAt: dayOne, ...values });
  return id;
}
const implementations = [
  { name: 'assistant', read: assistantUsageAggregateOf, async add(f: Fixture, branchId: string | null, n = 1, at = dayOne) {
    await question(f, { branchId, inputTokens: n, outputTokens: n, cacheReadTokens: n, createdAt: at });
  } },
  { name: 'Inbox', read: inboxAiUsageAggregateOf, async add(f: Fixture, branchId: string | null, n = 1, at = dayOne) {
    await turn(await thread(f, branchId), { inputTokens: n, outputTokens: n, cacheReadTokens: n, createdAt: at });
  } },
];

describe('SCRUM-636 AI usage: real native-table projections', () => {
  it('assistant preserves count-state predicate separately from sums across all scoped rows', async () => {
    const f = await fixture();
    await question(f, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 });
    await question(f, { state: 'off', inputTokens: 2, outputTokens: 3, cacheReadTokens: 5, latencyMs: 0 });
    await question(f, { state: 'capped', reason: 'CAP_DAILY', inputTokens: 7, outputTokens: 11, cacheReadTokens: 13, latencyMs: 0 });
    await question(f, { state: 'asking', answer: null });
    await question(f, { state: 'failed', reason: 'PROVIDER_ERROR' });
    const result = await assistantUsageAggregateOf(ctx.db, input(f));
    expect(result.totals).toEqual(metrics(3, 19, 34, 48));
    expect(result.parks[0]!.rows).toEqual([{ date: dates[0], ...metrics(3, 19, 34, 48) }, { date: dates[1], ...metrics() }]);
    expect(result).toMatchObject({ basis: 'created-at-bangkok', attribution: 'seat-at-ask', coverage: 'retained-records', retentionDays: 90, operatorWide: null });
    expect(Object.keys(result).sort()).toEqual(['attribution', 'basis', 'coverage', 'operatorWide', 'parks', 'retentionDays', 'totals']);
    expect(JSON.stringify(result)).not.toContain(privateText);
  });

  it('Inbox counts latency including zero/failure/shadow, while token sums include no-latency rows', async () => {
    const f = await fixture(), t = await thread(f);
    await turn(t, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 });
    await turn(t, { state: 'silent', reason: 'PROVIDER_ERROR', latencyMs: 0, attempts: 4 });
    await turn(t, { state: 'shadowed', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 });
    await turn(t, { state: 'pending', latencyMs: null, inputTokens: 2, outputTokens: 4, cacheReadTokens: 6 });
    await turn(t, { state: 'cancelled', latencyMs: null, inputTokens: 3, outputTokens: 6, cacheReadTokens: 9 });
    const result = await inboxAiUsageAggregateOf(ctx.db, input(f));
    expect(result.totals).toEqual(metrics(3, 16, 32, 48));
    expect(result).toMatchObject({ basis: 'created-at-bangkok', attribution: 'current-conversation-branch', coverage: 'retained-records', retentionDays: null });
    expect(Object.keys(result.totals).sort()).toEqual(['cacheReadTokens', 'count', 'inputTokens', 'outputTokens', 'totalTokens']);
    expect(JSON.stringify(result)).not.toContain(privateText);
  });

  for (const implementation of implementations) {
    it(`${implementation.name} totals include selected parks plus exactly one authorized branchless bucket`, async () => {
      const f = await fixture();await implementation.add(f, f.a.id, 1);await implementation.add(f, f.b.id, 10);await implementation.add(f, null, 100);
      const selected = await implementation.read(ctx.db, input(f, [f.a], false));
      expect(selected.totals).toEqual(metrics(1, 1, 1, 1));expect(selected.parks.map(row => row.branchId)).toEqual([f.a.id]);expect(selected.operatorWide).toBeNull();
      const broad = await implementation.read(ctx.db, input(f, [f.a, f.b], true));
      expect(broad.totals).toEqual(metrics(3, 111, 111, 111));expect(broad.parks.map(row => row.totals)).toEqual([metrics(1, 1, 1, 1), metrics(1, 10, 10, 10)]);
      expect(broad.operatorWide).toEqual({ totals: metrics(1, 100, 100, 100), rows: [{ date: dates[0], ...metrics(1, 100, 100, 100) }, { date: dates[1], ...metrics() }] });
    });

    it(`${implementation.name} groups half-open Bangkok dates despite the park timezone and trading cutoff`, async () => {
      const f = await fixture();
      for (const at of ['2026-10-23T16:59:59.999Z', '2026-10-23T17:00:00.000Z', '2026-10-24T16:59:59.999Z', '2026-10-24T17:00:00.000Z', '2026-10-25T16:59:59.999Z', '2026-10-25T17:00:00.000Z']) await implementation.add(f, f.a.id, 1, new Date(at));
      const result = await implementation.read(ctx.db, input(f, [f.a]));
      expect(result.totals).toEqual(metrics(4, 4, 4, 4));expect(result.parks[0]!.rows).toEqual(dates.map(date => ({ date, ...metrics(2, 2, 2, 2) })));
    });

    it(`${implementation.name} returns dense genuine zero days and supports only the authorized unassigned scope`, async () => {
      const f = await fixture();const empty = await implementation.read(ctx.db, input(f));
      expect(empty.totals).toEqual(metrics());expect(empty.parks).toHaveLength(2);for (const park of empty.parks) expect(park.rows).toEqual(dates.map(date => ({ date, ...metrics() })));
      await implementation.add(f, null, 7);const unassigned = await implementation.read(ctx.db, input(f, [], true));
      expect(unassigned.parks).toEqual([]);expect(unassigned.totals).toEqual(metrics(1, 7, 7, 7));expect(unassigned.operatorWide!.totals).toEqual(metrics(1, 7, 7, 7));
      const none = await implementation.read(ctx.db, input(f, [], false));expect(none.parks).toEqual([]);expect(none.totals).toEqual(metrics());expect(none.operatorWide).toBeNull();
    });

    it(`${implementation.name} refuses an archived park even when its selected descriptor was captured live`, async () => {
      const f = await fixture(), captured = input(f, [f.a, f.b], true);
      await implementation.add(f, f.a.id, 1);await implementation.add(f, f.b.id, 10);await implementation.add(f, null, 100);
      await ctx.db.update(branch).set({ archivedAt: new Date('2026-10-25T17:30:00Z') }).where(eq(branch.id, f.a.id));
      const result = await implementation.read(ctx.db, captured);
      expect(result.parks.map(park => park.branchId)).toEqual([f.b.id]);
      expect(result.parks[0]!.totals).toEqual(metrics(1, 10, 10, 10));
      expect(result.totals).toEqual(metrics(2, 110, 110, 110));
      expect(result.operatorWide!.totals).toEqual(metrics(1, 100, 100, 100));
    });
  }

  it('assistant fences referenced account and branch ownership without dropping an inactive own account', async () => {
    const f = await fixture();await question(f, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 });
    await question(f, { accountId: f.outsider, inputTokens: 1000 });
    await question(f, { branchId: f.other.id, inputTokens: 2000 });
    await question(f, { operatorId: f.foreign, accountId: f.outsider, branchId: f.a.id, inputTokens: 4000 });
    await question(f, { accountId: f.outsider, branchId: null, inputTokens: 8000 });
    const result = await assistantUsageAggregateOf(ctx.db, input(f, [f.a, f.b], true));
    expect(result.totals).toEqual(metrics(1, 1, 2, 3));expect(result.operatorWide!.totals).toEqual(metrics());
  });

  it('Inbox fences both conversation operator and owned branch references', async () => {
    const f = await fixture();await turn(await thread(f), { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 });
    await turn(await thread(f, f.other.id), { inputTokens: 1000 });
    await turn(await thread(f, f.a.id, true), { inputTokens: 2000 });
    await turn(await thread(f, null, true), { inputTokens: 4000 });
    const result = await inboxAiUsageAggregateOf(ctx.db, input(f, [f.a, f.b], true));
    expect(result.totals).toEqual(metrics(1, 1, 2, 3));expect(result.operatorWide!.totals).toEqual(metrics());
  });

  it('Inbox honestly follows the current conversation branch and never infers the channel park', async () => {
    const f = await fixture(), t = await thread(f);await turn(t, { inputTokens: 2 });
    await ctx.db.update(conversation).set({ branchId: f.b.id }).where(eq(conversation.id, t.id));
    const moved = await inboxAiUsageAggregateOf(ctx.db, input(f));expect(moved.parks[0]!.totals).toEqual(metrics());expect(moved.parks[1]!.totals).toEqual(metrics(1, 2));
    await ctx.db.update(conversation).set({ branchId: null }).where(eq(conversation.id, t.id));
    expect((await inboxAiUsageAggregateOf(ctx.db, input(f))).totals).toEqual(metrics());
    expect((await inboxAiUsageAggregateOf(ctx.db, input(f, [f.a, f.b], true))).operatorWide!.totals).toEqual(metrics(1, 2));
  });
});
