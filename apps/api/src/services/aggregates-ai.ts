import { and, eq, inArray, isNotNull, isNull, or, gte, lt, sql } from 'drizzle-orm';
import { account, aiTurn, ask, branch, conversation, type Db } from '@oto/db';
import { ASSISTANT_ASK_RETENTION_DAYS } from '@oto/shared';
import type { AggregatePark, DailyAggregateInput } from './aggregate-types';
import type { Exec } from './tx';

export interface AiUsageMetrics {
  count: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  spendEstimate: number | null;
  reason: 'no_rate_configured' | 'unpriced_tokens' | null;
  unpricedTokens: number;
}

export interface AiUsageAggregate<
  Attribution extends 'seat-at-ask' | 'current-conversation-branch' = 'seat-at-ask' | 'current-conversation-branch',
  RetentionDays extends 90 | null = 90 | null,
> {
  basis: 'created-at-bangkok';
  attribution: Attribution;
  coverage: 'retained-records';
  retentionDays: RetentionDays;
  currency: 'USD';
  excludesCacheWrites: true;
  totals: AiUsageMetrics;
  parks: AggregatePark<AiUsageMetrics>[];
  operatorWide: null | { totals: AiUsageMetrics; rows: Array<AiUsageMetrics & { date: string }> };
}

export type AssistantUsageAggregate = AiUsageAggregate<'seat-at-ask', 90>;
export type InboxAiUsageAggregate = AiUsageAggregate<'current-conversation-branch', null>;

const zero = (): AiUsageMetrics => ({
  count: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0,
  spendEstimate: null, reason: 'no_rate_configured', unpricedTokens: 0,
});

interface GroupRow {
  branchId: string | null;
  date: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

function add(left: AiUsageMetrics, right: AiUsageMetrics): AiUsageMetrics {
  return { count: left.count + right.count, inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens, cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    spendEstimate: null, reason: 'no_rate_configured', unpricedTokens: left.unpricedTokens + right.unpricedTokens };
}

function projection<Attribution extends AiUsageAggregate['attribution'], RetentionDays extends AiUsageAggregate['retentionDays']>(input: DailyAggregateInput, groups: GroupRow[], attribution: Attribution, retentionDays: RetentionDays): AiUsageAggregate<Attribution, RetentionDays> {
  const values = new Map<string, AiUsageMetrics>(groups.map(row => [`${row.branchId ?? 'unassigned'}:${row.date}`, {
    count: row.count, inputTokens: row.inputTokens, outputTokens: row.outputTokens, cacheReadTokens: row.cacheReadTokens,
    totalTokens: row.inputTokens + row.outputTokens + row.cacheReadTokens,
    spendEstimate: null, reason: 'no_rate_configured', unpricedTokens: row.inputTokens + row.outputTokens + row.cacheReadTokens,
  }]));
  const bucket = (branchId: string | null) => {
    const rows = input.period.dates.map(date => ({ date, ...(values.get(`${branchId ?? 'unassigned'}:${date}`) ?? zero()) }));
    return { totals: rows.reduce<AiUsageMetrics>((total, row) => add(total, row), zero()), rows };
  };
  const parks = input.selected.map(park => ({ branchId: park.id, ...bucket(park.id) }));
  const operatorWide = input.includeOperatorWide ? bucket(null) : null;
  // Overall totals include the selected parks plus one authorized branchless bucket.
  const totals = parks.reduce<AiUsageMetrics>((total, park) => add(total, park.totals), operatorWide?.totals ?? zero());
  return { basis: 'created-at-bangkok', attribution, coverage: 'retained-records', retentionDays,
    currency: 'USD', excludesCacheWrites: true, totals, parks, operatorWide };
}

function bounds(input: DailyAggregateInput): { from: Date; until: Date } {
  const from = new Date(`${input.period.from}T00:00:00+07:00`);
  const until = new Date(new Date(`${input.period.to}T00:00:00+07:00`).getTime() + 86_400_000);
  return { from, until };
}

/** Revalidate captured descriptors in the same read snapshot as their usage. */
async function liveInput(db: Exec, input: DailyAggregateInput): Promise<DailyAggregateInput> {
  const selected = new Map(input.selected.map(park => [park.id, park]));
  if (selected.size === 0) return input;
  const rows = await db.select({ id: branch.id }).from(branch).where(and(
    eq(branch.operatorId, input.operatorId), isNull(branch.archivedAt), inArray(branch.id, [...selected.keys()]),
  ));
  const live = new Set(rows.map(row => row.id));
  return { ...input, selected: [...selected.values()].filter(park => live.has(park.id)) };
}

async function assistantUsageIn(db: Exec, input: DailyAggregateInput): Promise<AssistantUsageAggregate> {
  if (input.selected.length === 0 && !input.includeOperatorWide) return projection(input, [], 'seat-at-ask', ASSISTANT_ASK_RETENTION_DAYS);
  const { from, until } = bounds(input);
  const date = sql<string>`to_char(${ask.createdAt} at time zone 'Asia/Bangkok', 'YYYY-MM-DD')`;
  const selected = input.selected.map(park => park.id);
  const scope = or(
    ...(selected.length ? [and(inArray(ask.branchId, selected), isNotNull(branch.id))] : []),
    ...(input.includeOperatorWide ? [isNull(ask.branchId)] : []),
  );
  const groups = await db.select({
    branchId: ask.branchId, date,
    count: sql<number>`count(*) filter (where ${ask.state} not in ('off', 'capped'))`.mapWith(Number),
    inputTokens: sql<number>`coalesce(sum(coalesce(${ask.inputTokens}, 0)), 0)`.mapWith(Number),
    outputTokens: sql<number>`coalesce(sum(coalesce(${ask.outputTokens}, 0)), 0)`.mapWith(Number),
    cacheReadTokens: sql<number>`coalesce(sum(coalesce(${ask.cacheReadTokens}, 0)), 0)`.mapWith(Number),
  }).from(ask)
    .innerJoin(account, and(eq(account.id, ask.accountId), eq(account.operatorId, input.operatorId)))
    .leftJoin(branch, and(eq(branch.id, ask.branchId), eq(branch.operatorId, input.operatorId), isNull(branch.archivedAt)))
    .where(and(eq(ask.operatorId, input.operatorId), gte(ask.createdAt, from), lt(ask.createdAt, until), scope))
    .groupBy(ask.branchId, date);
  return projection(input, groups, 'seat-at-ask', ASSISTANT_ASK_RETENTION_DAYS);
}

async function inboxAiUsageIn(db: Exec, input: DailyAggregateInput): Promise<InboxAiUsageAggregate> {
  if (input.selected.length === 0 && !input.includeOperatorWide) return projection(input, [], 'current-conversation-branch', null);
  const { from, until } = bounds(input);
  const date = sql<string>`to_char(${aiTurn.createdAt} at time zone 'Asia/Bangkok', 'YYYY-MM-DD')`;
  const selected = input.selected.map(park => park.id);
  const scope = or(
    ...(selected.length ? [and(inArray(conversation.branchId, selected), isNotNull(branch.id))] : []),
    ...(input.includeOperatorWide ? [isNull(conversation.branchId)] : []),
  );
  const groups = await db.select({
    branchId: conversation.branchId, date,
    count: sql<number>`count(*) filter (where ${aiTurn.latencyMs} is not null)`.mapWith(Number),
    inputTokens: sql<number>`coalesce(sum(coalesce(${aiTurn.inputTokens}, 0)), 0)`.mapWith(Number),
    outputTokens: sql<number>`coalesce(sum(coalesce(${aiTurn.outputTokens}, 0)), 0)`.mapWith(Number),
    cacheReadTokens: sql<number>`coalesce(sum(coalesce(${aiTurn.cacheReadTokens}, 0)), 0)`.mapWith(Number),
  }).from(aiTurn)
    .innerJoin(conversation, and(eq(conversation.id, aiTurn.conversationId), eq(conversation.operatorId, aiTurn.operatorId), eq(conversation.operatorId, input.operatorId)))
    .leftJoin(branch, and(eq(branch.id, conversation.branchId), eq(branch.operatorId, input.operatorId), isNull(branch.archivedAt)))
    .where(and(eq(aiTurn.operatorId, input.operatorId), gte(aiTurn.createdAt, from), lt(aiTurn.createdAt, until), scope))
    .groupBy(conversation.branchId, date);
  return projection(input, groups, 'current-conversation-branch', null);
}

/** Native caps count non-gated asks; their token sums still cover every scoped row. */
export async function assistantUsageAggregateOf(db: Db, input: DailyAggregateInput): Promise<AssistantUsageAggregate> {
  if (input.selected.length === 0 && !input.includeOperatorWide) return projection(input, [], 'seat-at-ask', ASSISTANT_ASK_RETENTION_DAYS);
  return db.transaction(async tx => assistantUsageIn(tx, await liveInput(tx, input)),
    { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** The native counted turn has model latency; attribution follows the current thread. */
export async function inboxAiUsageAggregateOf(db: Db, input: DailyAggregateInput): Promise<InboxAiUsageAggregate> {
  if (input.selected.length === 0 && !input.includeOperatorWide) return projection(input, [], 'current-conversation-branch', null);
  return db.transaction(async tx => inboxAiUsageIn(tx, await liveInput(tx, input)),
    { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
