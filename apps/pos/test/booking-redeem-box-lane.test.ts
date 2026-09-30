import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeBookingRedeemAnswer, BridgeBookingView } from '@oto/shared';
import { apiSale } from './support/fixtures';
import { setBridgeStaffName } from '@/api/bridge';
import { bookingsApi, redemptionFromConflict } from '@/api/bookings';
import { currentLane, setLaneStation } from '@/lib/lane';

/**
 * S2-12 ROUND 5 — REDEEMING A BOOKING WITH THE LINK DOWN, THE TILL'S HALF.
 *
 * The redeem dialog's three stages call `bookingsApi` exactly as they do
 * online; when the platform refuses the station (or cannot be reached) the
 * same calls ride the station bridge to the counter's box: the lookup reads
 * the box's copy, and Confirm & Issue redeems it there under the press's key.
 * `fetch` is stubbed at the boundary, so every path asserted is one the till
 * would call.
 */

const STATION = '018f0000-0000-7000-8000-0000000057a1';
const BOOKING = '018f0000-0000-7000-8000-0000000b0001';
const intentsUrl = `/api/box/v1/station/${STATION}/intents`;

const reply = (data: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;
const forcedOffline = () =>
  reply({ error: { code: 'STATION_FORCED_OFFLINE', message: 'This station is forced offline for testing.' } }, 503);

function boxBooking(over: Partial<BridgeBookingView> = {}): BridgeBookingView {
  return {
    id: BOOKING,
    reference: 'OTO-PAID-0001',
    branchId: 'branch-1',
    branchName: 'HKT Central',
    memberId: null,
    bookingDate: '2026-10-01',
    createdAt: '2026-09-30T04:00:00.000Z',
    status: 'paid',
    totalSatang: 95_000,
    tier: 'tourist',
    rateMode: 'weekday',
    parentName: 'Mali',
    phone: '+66811111111',
    paymentMethod: null,
    lines: [],
    redemption: null,
    source: 'cache',
    ...over,
  };
}

function boxAnswer(): BridgeBookingRedeemAnswer {
  const sale = apiSale({ id: 'sale-box-1', stationId: STATION });
  return {
    booking: boxBooking({ status: 'redeemed', source: 'log' }),
    sale: {
      ...sale,
      status: 'finalised',
      receiptNumber: 'T1-000043',
      receiptSeries: 'T1',
      receiptSeq: 43,
      boxId: 'box-1',
      origin: 'box',
      pricingMode: 'weekday',
    },
    bands: [
      { id: 'b1', kind: 'kid', status: 'active', shortCode: 'T1-7KMQ4X', cartLineId: 'l1', saleLineId: 's1', childId: 'c1', childName: 'Ploy' },
      { id: 'b2', kind: 'adult', status: 'active', shortCode: 'T1-8PQR2Z', cartLineId: 'l1', saleLineId: 's2', childId: null, childName: null },
    ],
    printing: { jobs: [{ id: 'job-1', kind: 'receipt', status: 'printed' }], notes: ['adult wristband not printed — no printer for it at this station'] },
    replay: false,
    outboxDepth: 2,
  };
}

interface Seen {
  url: string;
  body: Record<string, unknown> | null;
}

function stubFetch(bridge: (type: string, payload: Record<string, unknown>) => Response) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      seen.push({ url, body });
      if (url === intentsUrl) {
        const intent = body as { type: string; payload: Record<string, unknown> };
        return bridge(intent.type, intent.payload);
      }
      return forcedOffline();
    }),
  );
  return seen;
}

beforeEach(() => {
  setLaneStation(null);
  setLaneStation(STATION);
  setBridgeStaffName('Nok');
});

afterEach(() => {
  setLaneStation(null);
  setBridgeStaffName(null);
  vi.unstubAllGlobals();
});

describe('the redeem dialog on the box lane', () => {
  it('reads a scanned booking from the box’s copy when the platform refuses the station', async () => {
    const seen = stubFetch((type) =>
      type === 'booking.lookup' ? reply({ document: {}, result: { booking: boxBooking() } }) : reply({}, 500),
    );
    const found = await bookingsApi.byId(BOOKING);
    expect(found.reference).toBe('OTO-PAID-0001');
    expect('source' in found).toBe(false);
    expect(currentLane()).toBe('box');
    const lookup = seen.find((s) => s.url === intentsUrl)!.body as { type: string; payload: Record<string, unknown> };
    expect(lookup).toMatchObject({ type: 'booking.lookup', payload: { bookingId: BOOKING } });
  });

  it('Confirm & Issue redeems on the box under the press’s key, with the band codes and no platform printing', async () => {
    const seen = stubFetch((type) =>
      type === 'booking.redeem' ? reply({ document: {}, result: boxAnswer() }) : reply({}, 500),
    );
    const result = await bookingsApi.redeem(BOOKING, { stationId: STATION, visitId: 'visit-1' }, 'redeem-key-1');
    expect(result.sale.receiptNumber).toBe('T1-000043');
    expect(result.printing).toBeNull();
    expect(result.box?.notes).toEqual(['adult wristband not printed — no printer for it at this station']);
    expect(result.bands.map((b) => [b.shortCode, b.childName])).toEqual([
      ['T1-7KMQ4X', 'Ploy'],
      ['T1-8PQR2Z', null],
    ]);
    const redeem = seen.find((s) => s.url === intentsUrl)!.body as { type: string; payload: Record<string, unknown> };
    expect(redeem.type).toBe('booking.redeem');
    expect(redeem.payload).toEqual({ bookingId: BOOKING, actionId: 'redeem-key-1', visitId: 'visit-1', staffName: 'Nok' });
  });

  it('a second till on the same box is told who redeemed it and when, in the platform’s conflict shape', async () => {
    stubFetch(() =>
      reply(
        {
          error: {
            code: 'BOOKING_ALREADY_REDEEMED',
            message: 'Booking OTO-PAID-0001 was already redeemed on 2026-10-01 10:05 at HKT Central, Reception Till 1, Nok.',
            details: {
              reference: 'OTO-PAID-0001',
              redemption: {
                at: '2026-10-01T03:05:00.000Z',
                branchName: 'HKT Central',
                stationName: 'Reception Till 1',
                staffName: 'Nok',
                bandCodes: ['T1-7KMQ4X'],
              },
            },
          },
        },
        409,
      ),
    );
    const refused = await bookingsApi.redeem(BOOKING, { stationId: STATION }, 'redeem-key-2').catch((e: unknown) => e);
    expect(redemptionFromConflict(refused)).toEqual({
      at: '2026-10-01T03:05:00.000Z',
      branchName: 'HKT Central',
      stationName: 'Reception Till 1',
      staffName: 'Nok',
      bandCodes: ['T1-7KMQ4X'],
    });
  });
});
