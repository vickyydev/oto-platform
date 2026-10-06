import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintBookingQr, verifyBookingQr } from '@oto/shared';
import {
  fetchScannedBooking,
  looksLikeBookingQr,
  readBookingScan,
  typedBookingQr,
} from '@/api/bookings';
import { api } from '@/api/client';
import type { StationScanEvent } from '@/lib/scanChannel';

/**
 * S2-12 (SCRUM-209, arrival round 3) — a family's booking QR opens the redeem
 * flow at the till: from the box's checked scan on the station channel, or
 * from a scanner typing into this device.
 */

const BOOKING_ID = '0192f3a4-5b6c-7d8e-9fa0-b1c2d3e4f777';
const QR = mintBookingQr(BOOKING_ID, 'band-key-for-pos-tests-only');

const scan = (over: Partial<StationScanEvent>): StationScanEvent => ({
  kind: 'scan',
  source: 'box_hid',
  codeKind: 'booking',
  codeFingerprint: 'f'.repeat(16),
  outcome: 'handled',
  handler: 'booking',
  errorCode: null,
  detail: { action: 'redeem_booking', bookingId: BOOKING_ID },
  actionId: null,
  scannedAt: new Date().toISOString(),
  ...over,
});

describe('the till reads a booking scan', () => {
  it('opens the booking the box checked', () => {
    expect(readBookingScan(scan({}))).toEqual({ bookingId: BOOKING_ID });
  });

  it('says why when the box refused it', () => {
    const refused = readBookingScan(
      scan({ outcome: 'refused', errorCode: 'BOOKING_QR_SIGNATURE_INVALID', detail: { message: 'Not a booking this park issued' } }),
    );
    expect(refused).toEqual({ refused: 'Not a booking this park issued' });
  });

  it('leaves every other kind of scan to its own screen', () => {
    expect(readBookingScan(scan({ codeKind: 'voucher', handler: 'voucher' }))).toBeNull();
    expect(readBookingScan(scan({ codeKind: 'band', handler: 'band' }))).toBeNull();
    expect(readBookingScan(scan({ codeKind: 'product', handler: 'product-barcode' }))).toBeNull();
  });

  it('routes a QR a scanner typed into this device, and nothing else', () => {
    expect(typedBookingQr(QR.toLowerCase())).toBe(QR);
    expect(looksLikeBookingQr(QR.toLowerCase())).toBe(true);
    expect(looksLikeBookingQr('OTO-AB12-3456')).toBe(false);
    expect(looksLikeBookingQr('8850000000017')).toBe(false);
  });
});

/**
 * The fix round's reproduction (S2-12 round 3): a tampered QR typed by a local
 * scanner opened the redeem dialog, because the till took the booking id out of
 * the code's shape. The till has no key, so the code now goes to the platform
 * WHOLE and is looked up by `/bookings/by-qr`, which checks the signature; the
 * till never asks for a booking by an id it read itself.
 */
describe('a booking QR this device read is checked by the platform, not trusted', () => {
  afterEach(() => vi.restoreAllMocks());

  const forge = (qr: string): string => {
    const sig = qr.split('.')[1]!;
    return `${qr.split('.')[0]}.${sig[0] === '0' ? '1' : '0'}${sig.slice(1)}`;
  };

  it('sends the whole tampered code to the signature check, never the id inside it', async () => {
    const forged = forge(QR);
    expect(verifyBookingQr(forged, 'band-key-for-pos-tests-only').ok).toBe(false);
    const get = vi.spyOn(api, 'get').mockRejectedValue(new Error('refused'));
    const code = typedBookingQr(forged);
    expect(code).not.toBeNull();
    await expect(fetchScannedBooking({ qr: code! })).rejects.toThrow('refused');
    expect(get).toHaveBeenCalledTimes(1);
    const path = get.mock.calls[0]![0] as string;
    expect(path).toBe(`/bookings/by-qr?code=${encodeURIComponent(forged)}`);
    expect(path).not.toContain(`/bookings/${BOOKING_ID}`);
  });

  it('reads by id only what the box vouched for', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ id: BOOKING_ID } as never);
    await fetchScannedBooking({ bookingId: BOOKING_ID });
    expect(get).toHaveBeenCalledWith(`/bookings/${BOOKING_ID}`);
  });
});
