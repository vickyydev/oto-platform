import type { SummaryBranch } from './analytics-summary';

/** Resolved by the overview grant, independently of the caller's current seat. */
export interface AggregateScope {
  operatorId: string;
  available: readonly SummaryBranch[];
  selected: readonly SummaryBranch[];
  includeOperatorWide: boolean;
  now: Date;
}

export interface AggregatePeriod {
  from: string;
  to: string;
  dates: readonly string[];
}

export interface DailyAggregateInput extends AggregateScope {
  period: AggregatePeriod;
}

export interface AggregatePark<T> {
  branchId: string;
  totals: T;
  rows: Array<T & { date: string }>;
}
