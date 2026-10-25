import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { booking, bookingRedemption, box, branch, operator } from '@oto/db';
import { newId } from '@oto/shared';
import { bookingAggregateOf } from '../src/services/aggregates-bookings';
import { fleetAggregateOf } from '../src/services/aggregates-fleet';
import type { AggregateScope, DailyAggregateInput } from '../src/services/aggregate-types';
import type { SummaryBranch } from '../src/services/analytics-summary';
import { createTestContext, teardownAll, type TestContext } from './helpers';

/** Real database pins for the existing ledger and persisted fleet definitions. */
let ctx: TestContext;
const NOW = new Date('2026-10-25T03:30:00.000Z');
const DATES = ['2026-10-24', '2026-10-25', '2026-10-26'] as const;
const ZERO_BOOKINGS = { bookings: 0, bookedValueSatang: 0, redeemedBookings: 0 };
const ZERO_FLEET = { boxes: 0, online: 0, offline: 0, unclaimed: 0, disabled: 0 };

beforeAll(async () => { ctx = await createTestContext(); }, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

interface Estate {
  operatorId: string;
  foreignOperatorId: string;
  a: SummaryBranch;
  b: SummaryBranch;
  archived: SummaryBranch;
  foreign: SummaryBranch;
}

async function estate(): Promise<Estate> {
  const operatorId = newId();
  const foreignOperatorId = newId();
  await ctx.db.insert(operator).values([
    { id: operatorId, name: 'ZZ TEST aggregates own' },
    { id: foreignOperatorId, name: 'ZZ TEST aggregates foreign' },
  ]);
  const ids = [newId(), newId(), newId(), newId()];
  const rows = await ctx.db.insert(branch).values(ids.map((id, index) => ({
    id,
    operatorId: index === 3 ? foreignOperatorId : operatorId,
    code: `ZZ-TEST-${id}`,
    name: `ZZ TEST aggregates park ${index}`,
    timezone: index === 1 ? 'Pacific/Honolulu' : 'Asia/Bangkok',
    businessDayStart: '05:00',
    archivedAt: index === 2 ? new Date('2026-10-23T00:00:00.000Z') : null,
  }))).returning();
  return {
    operatorId, foreignOperatorId,
    a: rows.find((row) => row.id === ids[0])!,
    b: rows.find((row) => row.id === ids[1])!,
    archived: rows.find((row) => row.id === ids[2])!,
    foreign: rows.find((row) => row.id === ids[3])!,
  };
}

function scope(e: Estate, selected: readonly SummaryBranch[] = [e.a]): AggregateScope {
  return { operatorId: e.operatorId, available: [e.a, e.b], selected, includeOperatorWide: false, now: NOW };
}
function daily(e: Estate, selected?: readonly SummaryBranch[]): DailyAggregateInput {
  return { ...scope(e, selected), period: { from: DATES[0], to: DATES[2], dates: DATES } };
}
async function booked(e: Estate, extra: Partial<typeof booking.$inferInsert> = {}): Promise<string> {
  const id = newId();
  await ctx.db.insert(booking).values({
    id, operatorId: e.operatorId, branchId: e.a.id,
    reference: `ZZ TEST ${id}`, bookingDate: DATES[1], status: 'pending', totalSatang: 100,
    ...extra,
  });
  return id;
}
async function redeemed(e: Estate, bookingId: string, extra: Partial<typeof bookingRedemption.$inferInsert> = {}): Promise<void> {
  await ctx.db.insert(bookingRedemption).values({
    id: newId(), operatorId: e.operatorId, branchId: e.a.id, bookingId,
    redeemedAt: new Date('2026-10-27T01:00:00.000Z'), ...extra,
  });
}
async function boxed(e: Estate, extra: Partial<typeof box.$inferInsert> = {}): Promise<void> {
  const id = newId();
  await ctx.db.insert(box).values({
    id, operatorId: e.operatorId, branchId: e.a.id, name: `ZZ TEST box ${id}`,
    slot: `zz-test-${id}`, status: 'unclaimed', ...extra,
  });
}

describe('SCRUM-636 booking-date cohort aggregates', () => {
  it('counts every ledger status and its priced value, including archived bookings', async () => {
    const e = await estate();
    for (const [index, status] of ['pending', 'paid', 'redeemed', 'expired', 'cancelled'].entries()) {
      await booked(e, { status, totalSatang: (index + 1) * 100, archivedAt: status === 'cancelled' ? NOW : null });
    }
    const result = await bookingAggregateOf(ctx.db, daily(e));
    expect(result).toMatchObject({ basis: 'booking-date', valueBasis: 'priced-booking-value', redemptionBasis: 'booking-date-cohort' });
    expect(result.totals).toEqual({ bookings: 5, bookedValueSatang: 1500, redeemedBookings: 0 });
    expect(result.parks).toHaveLength(1);
    expect(result.parks[0]!.totals).toEqual(result.totals);
  });

  it('fills each requested date in order and never derives visit dates from creation timestamps or park clocks', async () => {
    const e = await estate();
    await booked(e, { bookingDate: DATES[0], createdAt: new Date('2027-01-01T00:00:00.000Z'), totalSatang: 123 });
    await booked(e, { bookingDate: DATES[2], createdAt: new Date('2020-01-01T00:00:00.000Z'), totalSatang: 456 });
    await booked(e, { bookingDate: '2026-10-23', totalSatang: 9000 });
    await booked(e, { bookingDate: '2026-10-27', totalSatang: 9000 });
    const result = await bookingAggregateOf(ctx.db, daily(e));
    expect(result.parks[0]!.rows).toEqual([
      { date: DATES[0], bookings: 1, bookedValueSatang: 123, redeemedBookings: 0 },
      { date: DATES[1], ...ZERO_BOOKINGS },
      { date: DATES[2], bookings: 1, bookedValueSatang: 456, redeemedBookings: 0 },
    ]);
    expect(result.totals).toEqual({ bookings: 2, bookedValueSatang: 579, redeemedBookings: 0 });
  });

  it('adds only the selected parks without the ledger page-size cap', async () => {
    const e = await estate();
    await ctx.db.insert(booking).values(Array.from({ length: 105 }, () => {
      const id = newId();
      return { id, operatorId: e.operatorId, branchId: e.a.id, reference: `ZZ TEST ${id}`, bookingDate: DATES[1], totalSatang: 7 };
    }));
    await booked(e, { branchId: e.b.id, totalSatang: 11 });
    const selected = await bookingAggregateOf(ctx.db, daily(e));
    expect(selected.totals).toEqual({ bookings: 105, bookedValueSatang: 735, redeemedBookings: 0 });
    const both = await bookingAggregateOf(ctx.db, daily(e, [e.a, e.b]));
    expect(both.parks.map((p) => p.branchId)).toEqual([e.a.id, e.b.id]);
    expect(both.totals).toEqual({ bookings: 106, bookedValueSatang: 746, redeemedBookings: 0 });
  });

  it('uses the authoritative redemption row, not status or legacy payload markers', async () => {
    const e = await estate();
    const canonical = await booked(e, { status: 'paid', totalSatang: 300 });
    await redeemed(e, canonical);
    await booked(e, { status: 'redeemed', totalSatang: 200 });
    await booked(e, { payload: { redemption: { redeemedAt: NOW.toISOString(), branchId: e.a.id } }, totalSatang: 100 });
    const result = await bookingAggregateOf(ctx.db, daily(e));
    expect(result.totals).toEqual({ bookings: 3, bookedValueSatang: 600, redeemedBookings: 1 });
    expect(result.parks[0]!.rows[1]!.redeemedBookings).toBe(1);
  });

  it('keeps redemption in its booking-date cohort even when claimed outside the requested date range', async () => {
    const e = await estate();
    const id = await booked(e, { bookingDate: DATES[0], totalSatang: 321 });
    await redeemed(e, id, { redeemedAt: new Date('2026-11-10T23:59:00.000Z') });
    const result = await bookingAggregateOf(ctx.db, daily(e));
    expect(result.parks[0]!.rows[0]).toEqual({ date: DATES[0], bookings: 1, bookedValueSatang: 321, redeemedBookings: 1 });
    expect(result.totals.redeemedBookings).toBe(1);
  });

  it('does not trust a foreign operator redemption attached to an otherwise own booking', async () => {
    const e = await estate();
    const id = await booked(e);
    await redeemed(e, id, { operatorId: e.foreignOperatorId, branchId: e.foreign.id });
    expect((await bookingAggregateOf(ctx.db, daily(e))).totals).toEqual({ bookings: 1, bookedValueSatang: 100, redeemedBookings: 0 });
  });

  it('fences the redemption branch owner even when its operator column claims the caller', async () => {
    const e = await estate();
    const id = await booked(e);
    await redeemed(e, id, { branchId: e.foreign.id });
    expect((await bookingAggregateOf(ctx.db, daily(e))).totals.redeemedBookings).toBe(0);
  });

  it('rejects a mismatched redemption park that the current counter and offline writers cannot create', async () => {
    const e = await estate();
    const id = await booked(e);
    await redeemed(e, id, { branchId: e.b.id });
    expect((await bookingAggregateOf(ctx.db, daily(e, [e.a, e.b]))).totals).toEqual({
      bookings: 1, bookedValueSatang: 100, redeemedBookings: 0,
    });
  });

  it('fences both booking operator and actual branch owner against corrupted parent references', async () => {
    const e = await estate();
    await booked(e, { totalSatang: 15 });
    await booked(e, { operatorId: e.foreignOperatorId, totalSatang: 9000 });
    await booked(e, { branchId: e.foreign.id, totalSatang: 9000 });
    const result = await bookingAggregateOf(ctx.db, daily(e, [e.a, e.foreign]));
    expect(result.parks.map((p) => p.branchId)).toEqual([e.a.id]);
    expect(result.totals).toEqual({ bookings: 1, bookedValueSatang: 15, redeemedBookings: 0 });
  });

  it('revalidates archived parks in the database rather than trusting a stale descriptor', async () => {
    const e = await estate();
    await booked(e, { branchId: e.archived.id, totalSatang: 8000 });
    const result = await bookingAggregateOf(ctx.db, daily(e, [e.a, { ...e.archived, archivedAt: null }]));
    expect(result.parks.map((p) => p.branchId)).toEqual([e.a.id]);
    expect(result.totals).toEqual(ZERO_BOOKINGS);
  });

  it('returns genuine zeros and no park rows when no park is selected', async () => {
    const e = await estate();
    await booked(e, { totalSatang: 9000 });
    expect(await bookingAggregateOf(ctx.db, daily(e, []))).toEqual({
      basis: 'booking-date', valueBasis: 'priced-booking-value', redemptionBasis: 'booking-date-cohort',
      totals: ZERO_BOOKINGS, parks: [],
    });
  });
});

describe('SCRUM-636 current persisted fleet aggregates', () => {
  it('counts all four persisted statuses separately, including empty parks', async () => {
    const e = await estate();
    for (const status of ['online', 'offline', 'unclaimed', 'disabled'] as const) await boxed(e, { status });
    const result = await fleetAggregateOf(ctx.db, scope(e, [e.a, e.b]));
    expect(result.basis).toBe('current-snapshot');
    expect(result.asOf).toBe(NOW.toISOString());
    expect(result.totals).toEqual({ boxes: 4, online: 1, offline: 1, unclaimed: 1, disabled: 1 });
    expect(result.parks).toEqual([
      { branchId: e.a.id, ...result.totals },
      { branchId: e.b.id, ...ZERO_FLEET },
    ]);
  });

  it('does not reclassify persisted status using heartbeat age, registration, opening hours or a new threshold', async () => {
    const e = await estate();
    await boxed(e, { status: 'online', lastHeartbeatAt: new Date('2020-01-01T00:00:00.000Z'), registeredAt: null });
    await boxed(e, { status: 'offline', lastHeartbeatAt: NOW, registeredAt: NOW });
    await boxed(e, { status: 'disabled', lastHeartbeatAt: NOW, registeredAt: NOW });
    const result = await fleetAggregateOf(ctx.db, scope(e));
    expect(result.totals).toEqual({ boxes: 3, online: 1, offline: 1, unclaimed: 0, disabled: 1 });
  });

  it('excludes archived boxes without erasing their persisted status', async () => {
    const e = await estate();
    await boxed(e, { status: 'offline', archivedAt: NOW });
    await boxed(e, { status: 'online' });
    expect((await fleetAggregateOf(ctx.db, scope(e))).totals).toEqual({ boxes: 1, online: 1, offline: 0, unclaimed: 0, disabled: 0 });
  });

  it('excludes unselected parks and returns only current database-owned live parks', async () => {
    const e = await estate();
    await boxed(e, { status: 'online' });
    await boxed(e, { branchId: e.b.id, status: 'offline' });
    await boxed(e, { branchId: e.archived.id, status: 'offline' });
    const result = await fleetAggregateOf(ctx.db, scope(e, [e.a, { ...e.archived, archivedAt: null }]));
    expect(result.parks).toEqual([{ branchId: e.a.id, boxes: 1, online: 1, offline: 0, unclaimed: 0, disabled: 0 }]);
  });

  it('fences both box operator and branch owner, even for a corrupted selected parent', async () => {
    const e = await estate();
    await boxed(e, { status: 'online' });
    await boxed(e, { operatorId: e.foreignOperatorId, status: 'offline' });
    await boxed(e, { branchId: e.foreign.id, status: 'offline' });
    await boxed(e, { operatorId: e.foreignOperatorId, branchId: e.foreign.id, status: 'offline' });
    const result = await fleetAggregateOf(ctx.db, scope(e, [e.a, e.foreign]));
    expect(result.parks).toEqual([{ branchId: e.a.id, boxes: 1, online: 1, offline: 0, unclaimed: 0, disabled: 0 }]);
    expect(result.totals).toEqual({ boxes: 1, online: 1, offline: 0, unclaimed: 0, disabled: 0 });
  });

  it('never presents an empty selection as the whole operator fleet', async () => {
    const e = await estate();
    await boxed(e, { status: 'online' });
    expect(await fleetAggregateOf(ctx.db, scope(e, []))).toEqual({
      basis: 'current-snapshot', asOf: NOW.toISOString(), totals: ZERO_FLEET, parks: [],
    });
  });
});
