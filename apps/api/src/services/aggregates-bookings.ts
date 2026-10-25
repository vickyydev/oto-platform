import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { booking, bookingRedemption, branch, type Db } from '@oto/db';
import type { AggregatePark, DailyAggregateInput } from './aggregate-types';

export interface BookingAggregateTotals {
  bookings: number;
  bookedValueSatang: number;
  redeemedBookings: number;
}

export interface BookingAggregate {
  basis: 'booking-date';
  valueBasis: 'priced-booking-value';
  redemptionBasis: 'booking-date-cohort';
  totals: BookingAggregateTotals;
  parks: AggregatePark<BookingAggregateTotals>[];
}

const emptyTotals = (): BookingAggregateTotals => ({
  bookings: 0, bookedValueSatang: 0, redeemedBookings: 0,
});

function sumTotals(rows: readonly BookingAggregateTotals[]): BookingAggregateTotals {
  const totals = emptyTotals();
  for (const row of rows) {
    totals.bookings += row.bookings;
    totals.bookedValueSatang += row.bookedValueSatang;
    totals.redeemedBookings += row.redeemedBookings;
  }
  return totals;
}

/** The ledger's visit-date cohort and priced value, independent of payment revenue. */
export async function bookingAggregateOf(db: Db, input: DailyAggregateInput): Promise<BookingAggregate> {
  const result: BookingAggregate = {
    basis: 'booking-date',
    valueBasis: 'priced-booking-value',
    redemptionBasis: 'booking-date-cohort',
    totals: emptyTotals(),
    parks: [],
  };
  const selectedIds = [...new Set(input.selected.map((park) => park.id))];
  if (selectedIds.length === 0) return result;

  // Start from live owned parks so empty parks remain visible and stale scope
  // descriptors cannot turn a foreign or archived parent into an owned park.
  const grouped = await db.select({
    branchId: branch.id,
    date: booking.bookingDate,
    bookings: sql<number>`count(${booking.id})::integer`.mapWith(Number),
    bookedValueSatang: sql<number>`coalesce(sum(${booking.totalSatang}), 0)`.mapWith(Number),
    // Current online/offline writers always persist the booking's own park.
    // EXISTS prevents the redemption relation from multiplying booking value.
    redeemedBookings: sql<number>`count(${booking.id}) filter (where exists (
      select 1 from ${bookingRedemption}
      where ${bookingRedemption.bookingId} = ${booking.id}
        and ${bookingRedemption.operatorId} = ${input.operatorId}
        and ${bookingRedemption.branchId} = ${booking.branchId}
    ))::integer`.mapWith(Number),
  })
    .from(branch)
    .leftJoin(booking, and(
      eq(booking.branchId, branch.id),
      eq(booking.operatorId, input.operatorId),
      gte(booking.bookingDate, input.period.from),
      lte(booking.bookingDate, input.period.to),
    ))
    .where(and(
      eq(branch.operatorId, input.operatorId),
      isNull(branch.archivedAt),
      inArray(branch.id, selectedIds),
    ))
    .groupBy(branch.id, booking.bookingDate);

  const byPark = new Map<string, Map<string, BookingAggregateTotals>>();
  for (const row of grouped) {
    let days = byPark.get(row.branchId);
    if (!days) {
      days = new Map();
      byPark.set(row.branchId, days);
    }
    if (row.date !== null) days.set(row.date, {
      bookings: row.bookings,
      bookedValueSatang: row.bookedValueSatang,
      redeemedBookings: row.redeemedBookings,
    });
  }
  for (const branchId of selectedIds) {
    const days = byPark.get(branchId);
    if (!days) continue;
    const rows = input.period.dates.map((date) => ({ date, ...(days.get(date) ?? emptyTotals()) }));
    result.parks.push({ branchId, totals: sumTotals(rows), rows });
  }
  result.totals = sumTotals(result.parks.map((park) => park.totals));
  return result;
}
