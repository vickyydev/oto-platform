import { and, eq, inArray, isNotNull, isNull, or, gte, lt, sql, type SQL } from 'drizzle-orm';
import { account, aiTurn, ask, branch, conversation, type Db } from '@oto/db';
import { ASSISTANT_ASK_RETENTION_DAYS } from '@oto/shared';
import type { AggregatePark, DailyAggregateInput } from './aggregate-types';
import type { Exec } from './tx';
import { assistantSettingRatesOf, type RateVersion } from './assistant-settings';

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

interface GroupRow {
  branchId: string | null;
  date: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  weightedCost: string | null;
  pricedRows: number;
  unpricedRows: number;
  unpricedTokens: number;
}

interface Decimal { integer: bigint; scale: number }
interface Accumulator extends Omit<GroupRow, 'branchId' | 'date' | 'weightedCost'> { weightedCost: Decimal }
const zero = (): Accumulator => ({ count: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  pricedRows: 0, unpricedRows: 0, unpricedTokens: 0, weightedCost: { integer: 0n, scale: 0 } });

function decimal(value: string | null): Decimal {
  if (value === null) return { integer: 0n, scale: 0 };
  // PostgreSQL numeric::text is a plain decimal, including very small tariffs.
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error('Invalid numeric usage estimate');
  return { integer: BigInt(match[1]! + match[2]! + (match[3] ?? '')), scale: (match[3] ?? '').length };
}
function add(left: Accumulator, right: Accumulator): Accumulator {
  const scale = Math.max(left.weightedCost.scale, right.weightedCost.scale);
  return { count: left.count + right.count, inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens, cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    pricedRows: left.pricedRows + right.pricedRows, unpricedRows: left.unpricedRows + right.unpricedRows,
    unpricedTokens: left.unpricedTokens + right.unpricedTokens,
    weightedCost: { integer: left.weightedCost.integer * 10n ** BigInt(scale - left.weightedCost.scale)
      + right.weightedCost.integer * 10n ** BigInt(scale - right.weightedCost.scale), scale } };
}

function metrics(row: Accumulator, hasRates: boolean): AiUsageMetrics {
  const spendEstimate = !hasRates || (row.pricedRows === 0 && row.unpricedRows > 0) ? null
    : Number(`${row.weightedCost.integer}e-${row.weightedCost.scale + 6}`);
  if (spendEstimate !== null && (!Number.isFinite(spendEstimate)
    || (row.weightedCost.integer > 0n && spendEstimate === 0))) throw new Error('Usage estimate is outside numeric transport');
  return { count: row.count, inputTokens: row.inputTokens, outputTokens: row.outputTokens, cacheReadTokens: row.cacheReadTokens,
    totalTokens: row.inputTokens + row.outputTokens + row.cacheReadTokens, spendEstimate,
    reason: !hasRates ? 'no_rate_configured' : row.unpricedRows > 0 ? 'unpriced_tokens' : null,
    unpricedTokens: row.unpricedTokens };
}

function projection<Attribution extends AiUsageAggregate['attribution'], RetentionDays extends AiUsageAggregate['retentionDays']>(input: DailyAggregateInput, groups: GroupRow[], attribution: Attribution, retentionDays: RetentionDays, hasRates: boolean): AiUsageAggregate<Attribution, RetentionDays> {
  const values = new Map<string, Accumulator>(groups.map(row => [`${row.branchId ?? 'unassigned'}:${row.date}`, {
    count: row.count, inputTokens: row.inputTokens, outputTokens: row.outputTokens, cacheReadTokens: row.cacheReadTokens,
    pricedRows: row.pricedRows, unpricedRows: row.unpricedRows, unpricedTokens: row.unpricedTokens, weightedCost: decimal(row.weightedCost),
  }]));
  const bucket = (branchId: string | null) => {
    const rows = input.period.dates.map(date => ({ date, value: values.get(`${branchId ?? 'unassigned'}:${date}`) ?? zero() }));
    const accumulated = rows.reduce((total, row) => add(total, row.value), zero());
    return { accumulated, result: { totals: metrics(accumulated, hasRates), rows: rows.map(row => ({ date: row.date, ...metrics(row.value, hasRates) })) } };
  };
  const buckets = input.selected.map(park => ({ branchId: park.id, ...bucket(park.id) }));
  const wide = input.includeOperatorWide ? bucket(null) : null;
  const parks = buckets.map(park => ({ branchId: park.branchId, ...park.result }));
  const operatorWide = wide?.result ?? null;
  // Overall totals include the selected parks plus one authorized branchless bucket.
  const totals = metrics(buckets.reduce((total, park) => add(total, park.accumulated), wide?.accumulated ?? zero()), hasRates);
  return { basis: 'created-at-bangkok', attribution, coverage: 'retained-records', retentionDays,
    currency: 'USD', excludesCacheWrites: true, totals, parks, operatorWide };
}

/** Rates are validated once in the same snapshot; match each exact model/time before aggregating tokens. */
function effectiveRate(rates: readonly RateVersion[], model: SQL, createdAt: SQL): SQL {
  return sql`lateral (select r.* from jsonb_to_recordset(${JSON.stringify(rates)}::jsonb) as r(
    model text, "effectiveFrom" timestamptz, "inputUsdPerMillion" numeric, "outputUsdPerMillion" numeric, "cacheReadUsdPerMillion" numeric)
    where r.model=${model} and r."effectiveFrom"<=${createdAt}
    order by r."effectiveFrom" desc limit 1) as effective_rate`;
}
function pricing(input: SQL, output: SQL, cache: SQL) {
  return {
    weightedCost: sql<string | null>`sum(coalesce(${input},0)::numeric*effective_rate."inputUsdPerMillion"
      +coalesce(${output},0)::numeric*effective_rate."outputUsdPerMillion"
      +coalesce(${cache},0)::numeric*effective_rate."cacheReadUsdPerMillion")::text`,
    pricedRows: sql<number>`count(*) filter(where effective_rate.model is not null)`.mapWith(Number),
    unpricedRows: sql<number>`count(*) filter(where effective_rate.model is null)`.mapWith(Number),
    unpricedTokens: sql<number>`coalesce(sum(case when effective_rate.model is null
      then coalesce(${input},0)::bigint+coalesce(${output},0)::bigint+coalesce(${cache},0)::bigint else 0 end),0)`.mapWith(Number),
  };
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
  const rates = await assistantSettingRatesOf(db, input.operatorId);
  if (input.selected.length === 0 && !input.includeOperatorWide) return projection(input, [], 'seat-at-ask', ASSISTANT_ASK_RETENTION_DAYS, rates.length > 0);
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
    ...pricing(sql`${ask.inputTokens}`, sql`${ask.outputTokens}`, sql`${ask.cacheReadTokens}`),
  }).from(ask)
    .innerJoin(account, and(eq(account.id, ask.accountId), eq(account.operatorId, input.operatorId)))
    .leftJoin(branch, and(eq(branch.id, ask.branchId), eq(branch.operatorId, input.operatorId), isNull(branch.archivedAt)))
    .leftJoin(effectiveRate(rates, sql`${ask.model}`, sql`${ask.createdAt}`), sql`true`)
    .where(and(eq(ask.operatorId, input.operatorId), gte(ask.createdAt, from), lt(ask.createdAt, until), scope))
    .groupBy(ask.branchId, date);
  return projection(input, groups, 'seat-at-ask', ASSISTANT_ASK_RETENTION_DAYS, rates.length > 0);
}

async function inboxAiUsageIn(db: Exec, input: DailyAggregateInput): Promise<InboxAiUsageAggregate> {
  const rates = await assistantSettingRatesOf(db, input.operatorId);
  if (input.selected.length === 0 && !input.includeOperatorWide) return projection(input, [], 'current-conversation-branch', null, rates.length > 0);
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
    ...pricing(sql`${aiTurn.inputTokens}`, sql`${aiTurn.outputTokens}`, sql`${aiTurn.cacheReadTokens}`),
  }).from(aiTurn)
    .innerJoin(conversation, and(eq(conversation.id, aiTurn.conversationId), eq(conversation.operatorId, aiTurn.operatorId), eq(conversation.operatorId, input.operatorId)))
    .leftJoin(branch, and(eq(branch.id, conversation.branchId), eq(branch.operatorId, input.operatorId), isNull(branch.archivedAt)))
    .leftJoin(effectiveRate(rates, sql`${aiTurn.model}`, sql`${aiTurn.createdAt}`), sql`true`)
    .where(and(eq(aiTurn.operatorId, input.operatorId), gte(aiTurn.createdAt, from), lt(aiTurn.createdAt, until), scope))
    .groupBy(conversation.branchId, date);
  return projection(input, groups, 'current-conversation-branch', null, rates.length > 0);
}

/** Native caps count non-gated asks; their token sums still cover every scoped row. */
export async function assistantUsageAggregateOf(db: Db, input: DailyAggregateInput): Promise<AssistantUsageAggregate> {
  return db.transaction(async tx => assistantUsageIn(tx, await liveInput(tx, input)),
    { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** The native counted turn has model latency; attribution follows the current thread. */
export async function inboxAiUsageAggregateOf(db: Db, input: DailyAggregateInput): Promise<InboxAiUsageAggregate> {
  return db.transaction(async tx => inboxAiUsageIn(tx, await liveInput(tx, input)),
    { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
