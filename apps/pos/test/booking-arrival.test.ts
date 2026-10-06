import { describe, expect, it } from 'vitest';
import { toPosBooking, type PlatformBooking } from '@/api/bookings';
import { publicAddOnToStore } from '@/api/catalogBridge';
import { getTicketTypes } from '@/store/catalogStore';

/**
 * S2-12 (SCRUM-209, arrival round 1) — the till and the booking site read the
 * platform's booking, not the browser's.
 *
 *   - A booking found by its reference may still be waiting for payment, or be
 *     one whose payment failed or ran out. The redeem modal must not show it as
 *     paid (`toPosBooking` used to call every unredeemed booking "paid").
 *   - The socks and extras a family paid for online ride on the booking now,
 *     so the counter is told to hand them over.
 *   - The booking site's extras come from the public catalogue, in baht, with
 *     the taxable area the platform resolved.
 */

const ticket = getTicketTypes()[0]!;

function platformBooking(over: Partial<PlatformBooking> = {}): PlatformBooking {
  return {
    id: '0192f0a0-0000-7000-8000-000000000001',
    reference: 'OTO-AB12-3456',
    branchId: 'branch-1',
    branchName: 'HKT Central',
    memberId: null,
    bookingDate: '2026-09-30',
    createdAt: '2026-09-30T03:00:00.000Z',
    status: 'paid',
    totalSatang: 120_000,
    tier: 'tourist',
    rateMode: 'weekday',
    parentName: 'Gate Family',
    phone: null,
    paymentMethod: null,
    lines: [
      {
        packageId: ticket.id,
        name: ticket.name,
        kids: 2,
        adults: 1,
        kidUnitSatang: 40_000,
        adultsFree: 1,
        adultUnitSatang: 0,
        socks: 1,
        socksUnitSatang: 5_000,
        addOns: [{ productId: 'prod-locker', name: 'Locker', unitSatang: 3_000, quantity: 2 }],
        lineTotalSatang: 91_000,
      },
    ],
    redemption: null,
    ...over,
  };
}

describe('toPosBooking — what reception is told', () => {
  it('a paid booking is paid, and carries the extras at the prices paid', () => {
    const mapped = toPosBooking(platformBooking());
    expect(mapped.paid).toBe(true);
    expect(mapped.notPaidReason).toBeNull();
    const line = mapped.booking.lines[0]!;
    expect(line.addOns).toEqual([
      { id: 'prod-locker', name: 'Locker', price: 30, quantity: 2 },
      { id: 'a-socks', name: 'Regular Socks', price: 50, quantity: 1 },
    ]);
    expect(line.lineTotal).toBe(910);
  });

  it.each(['pending', 'expired', 'cancelled'])('a %s booking is never shown as paid', (status) => {
    const mapped = toPosBooking(platformBooking({ status }));
    expect(mapped.paid).toBe(false);
    expect(mapped.notPaidReason).toContain('OTO-AB12-3456');
    expect(mapped.notPaidReason).toContain('Nothing can be issued');
  });

  it('a redeemed booking is redeemed, with or without its claim row', () => {
    expect(toPosBooking(platformBooking({ status: 'redeemed' })).booking.status).toBe('redeemed');
    expect(toPosBooking(platformBooking({ status: 'redeemed' })).paid).toBe(true);
  });

  it('a booking from an API that predates extras still maps, with none', () => {
    const [line] = platformBooking().lines;
    const { socks: _s, socksUnitSatang: _u, addOns: _a, ...bare } = line!;
    const mapped = toPosBooking(platformBooking({ lines: [bare] }));
    expect(mapped.booking.lines[0]!.addOns).toEqual([]);
  });
});

describe('publicAddOnToStore — the booking site prices extras from the platform', () => {
  it('converts satang to baht, falls back to the weekday price, and carries the taxable area', () => {
    expect(
      publicAddOnToStore({
        id: 'a-socks',
        name: 'Regular Socks',
        priceSatang: 6_000,
        priceWeekendSatang: null,
        taxCategory: null,
        translations: null,
      }),
    ).toEqual({ id: 'a-socks', name: 'Regular Socks', price: { weekday: 60, weekend: 60 } });
    expect(
      publicAddOnToStore({
        id: '0192f0a0-0000-7000-8000-00000000abcd',
        name: 'Glow band',
        priceSatang: 4_550,
        priceWeekendSatang: 5_025,
        taxCategory: 'merch',
        translations: { th: { name: 'สายรัดเรืองแสง' } },
      }),
    ).toEqual({
      id: '0192f0a0-0000-7000-8000-00000000abcd',
      name: 'Glow band',
      price: { weekday: 45.5, weekend: 50.25 },
      taxCategoryOverride: 'merch',
      translations: { th: { name: 'สายรัดเรืองแสง' } },
    });
  });
});
