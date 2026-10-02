import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '@/api/client';
import { bookingsApi, type BookingRedeemResult } from '@/api/bookings';
import type { ApiSalePrintJob } from '@/api/history';
import { dispatchPlatformPrinting } from '@/lib/printRouting';
import { toast } from '@/hooks/use-toast';
import {
  announceBookingRedemption,
  redeemBookingOnPlatform,
  redeemedOutcome,
  type RedeemKeyHolder,
} from '@/lib/bookingRedemption';

/**
 * SCRUM-494 — CONFIRM & ISSUE ON THE PHONE TILL.
 *
 * The phone till and the counter till redeem a booking through one helper
 * (`lib/bookingRedemption`): the platform's redemption is called once, and its
 * answer — the bands it minted, the paper it queued through the station or the
 * box, and what was not printed — is all the till says. Nothing is recorded,
 * minted or printed in the browser.
 */

vi.mock('@/lib/printRouting', () => ({ dispatchPlatformPrinting: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const dispatched = vi.mocked(dispatchPlatformPrinting);
const toasted = vi.mocked(toast);

const BOOKING = '018f0000-0000-7000-8000-0000000b0494';
const STATION = '018f0000-0000-7000-8000-0000000057a1';

function job(over: Partial<ApiSalePrintJob>): ApiSalePrintJob {
  return {
    id: 'job',
    kind: 'receipt',
    role: 'receipt',
    status: 'queued',
    stationId: STATION,
    deviceId: 'dev-1',
    deviceLabel: 'Receipt printer',
    subjectType: 'sale',
    subjectId: 'sale-1',
    reprintOf: null,
    reprintReason: null,
    requestedByName: null,
    ...over,
  } as ApiSalePrintJob;
}

function onlineAnswer(): BookingRedeemResult {
  return {
    booking: { id: BOOKING, reference: 'OTO-PAID-0494' } as BookingRedeemResult['booking'],
    sale: { id: 'sale-1', receiptNumber: 'T1-000101', totals: { grossSatang: 95_000 } },
    bands: [
      { id: 'b1', kind: 'kid', shortCode: 'T1-7KMQ4X', childName: 'Ploy', printedJobId: 'job-band' },
      { id: 'b2', kind: 'adult', shortCode: 'T1-8PQR2Z', childName: null, printedJobId: null },
    ],
    printing: {
      jobs: [job({ id: 'job-receipt' }), job({ id: 'job-band', kind: 'band' as ApiSalePrintJob['kind'] }), job({ id: 'job-copy', reprintOf: 'job-receipt' })],
      notes: ['adult wristband not printed — no printer for it at this station'],
      failed: { code: 'PRINT_QUEUE_FAILED', message: 'The receipt could not be queued for the box.' },
    },
    box: null,
  };
}

function boxAnswer(): BookingRedeemResult {
  return {
    ...onlineAnswer(),
    printing: null,
    box: { notes: ['adult wristband not printed — no printer for it at this station'] },
  };
}

beforeEach(() => {
  dispatched.mockReset();
  toasted.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('s494-phone-till: Confirm & Issue calls the platform once and uses its answer', () => {
  it('redeems once under the dialog key and announces the platform’s own printing', async () => {
    const redeem = vi.spyOn(bookingsApi, 'redeem').mockResolvedValue(onlineAnswer());
    const keys: RedeemKeyHolder = { current: null };

    const claimed = await redeemBookingOnPlatform(BOOKING, { stationId: STATION }, keys);

    expect(redeem).toHaveBeenCalledTimes(1);
    expect(redeem).toHaveBeenCalledWith(BOOKING, { stationId: STATION }, keys.current!.key);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    announceBookingRedemption('OTO-PAID-0494', claimed.redeemed);
    // First prints only; the platform's failure is said with the notes.
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(dispatched.mock.calls[0]![0].map((j) => j.id)).toEqual(['job-receipt', 'job-band']);
    expect(dispatched.mock.calls[0]![1]).toEqual([
      'adult wristband not printed — no printer for it at this station',
      'The receipt could not be queued for the box.',
    ]);
    expect(toasted).toHaveBeenCalledWith({
      title: 'Booking redeemed',
      description: 'OTO-PAID-0494 — 2 wristband(s) issued.',
    });
    expect(redeemedOutcome(claimed.redeemed)).toEqual({ ok: true });
  });

  it('on the box lane says only what did not print and keeps the dialog on the real band codes', async () => {
    vi.spyOn(bookingsApi, 'redeem').mockResolvedValue(boxAnswer());
    const claimed = await redeemBookingOnPlatform(BOOKING, { stationId: STATION }, { current: null });
    if (!claimed.ok) throw new Error('expected a redemption');

    announceBookingRedemption('OTO-PAID-0494', claimed.redeemed);
    expect(dispatched).not.toHaveBeenCalled();
    expect(toasted).toHaveBeenCalledWith({
      title: 'Not printed',
      description: 'adult wristband not printed — no printer for it at this station',
      variant: 'destructive',
    });
    expect(toasted).toHaveBeenCalledWith({
      title: 'Booking redeemed offline',
      description: 'OTO-PAID-0494 — 2 wristband(s) issued.',
    });
    expect(redeemedOutcome(claimed.redeemed)).toEqual({
      ok: true,
      issued: {
        receiptNumber: 'T1-000101',
        bands: claimed.redeemed.bands,
        notes: ['adult wristband not printed — no printer for it at this station'],
      },
    });
  });

  it('a lost answer retries under the same key; a refusal frees the next press', async () => {
    const redeem = vi
      .spyOn(bookingsApi, 'redeem')
      .mockRejectedValueOnce(new NetworkError())
      .mockRejectedValueOnce(new ApiError(422, 'BOOKING_NOT_PAID', 'Booking OTO-PAID-0494 is not paid.'))
      .mockResolvedValueOnce(onlineAnswer());
    const keys: RedeemKeyHolder = { current: null };

    expect(await redeemBookingOnPlatform(BOOKING, {}, keys)).toEqual({
      ok: false,
      message: 'No connection to the platform, so this booking cannot be redeemed here. Nothing has been issued.',
    });
    const firstKey = redeem.mock.calls[0]![2];
    expect(keys.current?.key).toBe(firstKey);

    expect(await redeemBookingOnPlatform(BOOKING, {}, keys)).toEqual({
      ok: false,
      message: 'Booking OTO-PAID-0494 is not paid.',
    });
    expect(redeem.mock.calls[1]![2]).toBe(firstKey);
    expect(keys.current).toBeNull();

    await redeemBookingOnPlatform(BOOKING, {}, keys);
    expect(redeem.mock.calls[2]![2]).not.toBe(firstKey);
  });

  it('a second till is told who redeemed it first, and a deployment without the route says so', async () => {
    vi.spyOn(bookingsApi, 'redeem')
      .mockRejectedValueOnce(
        new ApiError(409, 'BOOKING_ALREADY_REDEEMED', 'already redeemed', {
          redemption: { at: '2026-10-01T03:05:00.000Z', branchName: 'HKT Central', stationName: 'Till 1', staffName: 'Nok', bandCodes: ['T1-7KMQ4X'] },
        }),
      )
      .mockRejectedValueOnce(new ApiError(404, 'UNKNOWN', 'Not Found'));

    expect(await redeemBookingOnPlatform(BOOKING, {}, { current: null })).toEqual({
      ok: false,
      redemption: { at: '2026-10-01T03:05:00.000Z', branchName: 'HKT Central', stationName: 'Till 1', staffName: 'Nok', bandCodes: ['T1-7KMQ4X'] },
    });
    expect(await redeemBookingOnPlatform(BOOKING, {}, { current: null })).toEqual({
      ok: false,
      message: 'This deployment cannot record a booking redemption yet (SCRUM-234). Nothing has been issued.',
    });
  });
});

describe('s494-phone-till: the phone till issues nothing in the browser', () => {
  const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

  /** The body of `handleRedeemConfirm`, up to the next top-level handler. */
  const redeemHandler = (file: string): string => {
    const start = file.indexOf('const handleRedeemConfirm = async');
    expect(start).toBeGreaterThan(-1);
    const end = file.indexOf('\n  const ', start + 1);
    return file.slice(start, end);
  };

  it('MobileTill redeems through the shared helper with no local sale, bands, wallet or print jobs', () => {
    const handler = redeemHandler(src('components/mobile/MobileTill.tsx'));
    for (const local of ['recordSale', 'issueBookingBands', 'dispatchPrintJobs', 'ticketPrintJobs', 'ensureSaleGrantWallet', 'buildSale', 'incrementPromoUsage', 'bookingsApi']) {
      expect(handler).not.toContain(local);
    }
    expect(handler.match(/redeemBookingOnPlatform\(/g)).toHaveLength(1);
    expect(handler).toContain('announceBookingRedemption(booking.reference, redeemed)');
    expect(handler).toContain('return redeemedOutcome(redeemed)');
  });

  it('the counter till redeems through the same helper', () => {
    const handler = redeemHandler(src('pages/Till.tsx'));
    expect(handler.match(/redeemBookingOnPlatform\(/g)).toHaveLength(1);
    expect(handler).toContain('announceBookingRedemption(booking.reference, redeemed)');
    expect(handler).toContain('return redeemedOutcome(redeemed)');
  });
});
