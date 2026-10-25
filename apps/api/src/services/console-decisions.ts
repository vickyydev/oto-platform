import type { Db } from '@oto/db';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { alert, box, branch, endOfDay, paymentAttempt, station, syncQuarantine } from '@oto/db';
import { EodLineSchema, lineFlag } from '@oto/shared';
import { summaryBranchToday, type SummaryBranch } from './analytics-summary';
import { strandedOf } from './occupancy';

export type DecisionKey = 'pendingPayments' | 'syncQuarantine' | 'cashVariances' | 'latePayments'
  | 'strandedOccupants' | 'erasureRequests' | 'approvalRequests';
export interface DecisionItem {
  key: DecisionKey;
  label: string;
  status: 'available' | 'not-built' | 'unavailable';
  count: number | null;
  basis: string;
}
export interface ConsoleDecisionInput {
  operatorId: string;
  selected: readonly SummaryBranch[];
  now: Date;
  pendingMinutes: number;
}
export interface ConsoleDecisionsSnapshot {
  generatedAt: string;
  items: DecisionItem[];
  parks: Array<{ branchId: string; items: DecisionItem[] }>;
}

const COUNT_KEYS = ['pendingPayments', 'syncQuarantine', 'cashVariances', 'latePayments', 'strandedOccupants'] as const;
type CountKey = typeof COUNT_KEYS[number];
type DecisionCounts = Record<CountKey, number>;

const DEFINITIONS: Record<DecisionKey, { label: string; basis: string }> = {
  pendingPayments: { label: 'Payments awaiting an answer', basis: 'station-attempts-older-than-native-pending-threshold' },
  syncQuarantine: { label: 'Open sync quarantines', basis: 'open-quarantine-events-in-selected-parks' },
  cashVariances: { label: 'Recorded reconciliation lines off', basis: 'counted-lines-off-in-saved-current-business-date-close' },
  latePayments: { label: 'Unresolved late-payment alerts', basis: 'unresolved-native-late-payment-alert-rows' },
  strandedOccupants: { label: 'End-of-day review rows still inside', basis: 'current-business-date-native-end-of-day-rows' },
  erasureRequests: { label: 'Erasure requests awaiting action', basis: 'suite-erasure-request-queue-not-built' },
  approvalRequests: { label: 'Approval requests awaiting action', basis: 'dual-control-request-queue-not-built' },
};

function emptyCounts(): DecisionCounts {
  return { pendingPayments: 0, syncQuarantine: 0, cashVariances: 0, latePayments: 0, strandedOccupants: 0 };
}

function itemsOf(counts: DecisionCounts, cashAvailable: boolean): DecisionItem[] {
  const items = COUNT_KEYS.map((key): DecisionItem => {
    if (key === 'cashVariances' && !cashAvailable) return {
      key, label: DEFINITIONS[key].label, status: 'unavailable', count: null,
      basis: 'current-business-date-not-reconciled',
    };
    return { key, ...DEFINITIONS[key], status: 'available', count: counts[key] };
  });
  for (const key of ['erasureRequests', 'approvalRequests'] as const) {
    items.push({ key, ...DEFINITIONS[key], status: 'not-built', count: null });
  }
  return items;
}

/** Native review counts only; source detail and payment values never leave this snapshot. */
export async function consoleDecisionsOf(db: Db, input: ConsoleDecisionInput): Promise<ConsoleDecisionsSnapshot> {
  const result: ConsoleDecisionsSnapshot = {
    generatedAt: input.now.toISOString(), items: itemsOf(emptyCounts(), true), parks: [],
  };
  const selectedIds = [...new Set(input.selected.map(park => park.id))];
  if (selectedIds.length === 0) return result;
  const cutoff = new Date(input.now.getTime() - input.pendingMinutes * 60_000);

  return db.transaction(async tx => {
    // Reload ownership and clocks from the same snapshot as the source counts.
    // A stale or forged descriptor cannot widen reach or substitute a park clock.
    const source = await tx.select({
      id: branch.id, timezone: branch.timezone, businessDayStart: branch.businessDayStart,
    }).from(branch).where(and(
      eq(branch.operatorId, input.operatorId), isNull(branch.archivedAt), inArray(branch.id, selectedIds),
    ));
    const byId = new Map(source.map(park => [park.id, park]));
    const parks = selectedIds.flatMap(id => {
      const park = byId.get(id);
      return park ? [park] : [];
    });
    if (parks.length === 0) return result;

    const parkIds = parks.map(park => park.id);
    const pending = await tx.select({
      branchId: paymentAttempt.branchId, total: sql<number>`count(*)::integer`.mapWith(Number),
    }).from(paymentAttempt).innerJoin(station, and(
      eq(station.id, paymentAttempt.stationId), eq(station.operatorId, input.operatorId),
      eq(station.branchId, paymentAttempt.branchId),
    )).where(and(
      eq(paymentAttempt.operatorId, input.operatorId), inArray(paymentAttempt.branchId, parkIds),
      inArray(paymentAttempt.status, ['sent_to_terminal', 'unknown', 'inquiring']),
      lt(paymentAttempt.createdAt, cutoff),
    )).groupBy(paymentAttempt.branchId);
    const quarantine = await tx.select({
      branchId: box.branchId, total: sql<number>`count(*)::integer`.mapWith(Number),
    }).from(syncQuarantine).innerJoin(box, eq(box.id, syncQuarantine.boxId)).where(and(
      eq(box.operatorId, input.operatorId), inArray(box.branchId, parkIds), eq(syncQuarantine.status, 'open'),
    )).groupBy(box.branchId);
    const late = await tx.select({
      branchId: alert.branchId, total: sql<number>`count(*)::integer`.mapWith(Number),
    }).from(alert).where(and(
      eq(alert.operatorId, input.operatorId), inArray(alert.branchId, parkIds),
      inArray(alert.category, ['payments.late_payment', 'bookings.late_payment']), isNull(alert.resolvedAt),
    )).groupBy(alert.branchId);
    const pendingByPark = new Map(pending.map(row => [row.branchId, row.total]));
    const quarantineByPark = new Map(quarantine.map(row => [row.branchId, row.total]));
    const lateByPark = new Map(late.map(row => [row.branchId, row.total]));
    const dates = new Map(parks.map(park => [park.id, summaryBranchToday(park, input.now)]));
    const closes = await tx.select({ branchId: endOfDay.branchId, date: endOfDay.businessDate, lines: endOfDay.lines })
      .from(endOfDay).where(and(
        eq(endOfDay.operatorId, input.operatorId), inArray(endOfDay.branchId, parkIds),
        inArray(endOfDay.businessDate, [...new Set(dates.values())]),
      ));
    const savedLines = new Map(closes.map(close => [`${close.branchId}:${close.date}`, close.lines]));
    const totals = emptyCounts();
    let allCashAvailable = true;
    for (const park of parks) {
      const date = dates.get(park.id)!;
      const lines = savedLines.get(`${park.id}:${date}`);
      const cashAvailable = lines !== undefined;
      // A saved malformed line is an error, never evidence of a matched close.
      const cashVariances = cashAvailable
        ? EodLineSchema.array().parse(lines).filter(line => lineFlag(line) === 'off').length
        : 0;
      const stranded = await strandedOf(tx, { operatorId: input.operatorId, branchId: park.id, date, now: input.now });
      const counts: DecisionCounts = {
        pendingPayments: pendingByPark.get(park.id) ?? 0, syncQuarantine: quarantineByPark.get(park.id) ?? 0,
        cashVariances, latePayments: lateByPark.get(park.id) ?? 0, strandedOccupants: stranded.rows.length,
      };
      result.parks.push({ branchId: park.id, items: itemsOf(counts, cashAvailable) });
      for (const key of COUNT_KEYS) totals[key] += counts[key];
      allCashAvailable &&= cashAvailable;
    }
    result.items = itemsOf(totals, allCashAvailable);
    return result;
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
