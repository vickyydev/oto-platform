import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BOOKING_QR_HEADER,
  BOOKING_QR_SIGNATURE_LENGTH,
  bookingQrKeyId,
  isBandCodeShape,
  isBookingQrShape,
  mintBandCode,
  mintBookingQr,
  newId,
  parseBandCode,
  parseBookingQr,
  ulidFromUuid,
  verifyBandCode,
  verifyBookingQr,
} from '../src/index';

/**
 * The signed booking QR (S2-12, SCRUM-209, plan §2.2). What reception and the
 * box will trust offline, so what is tested is what they rely on: the key that
 * signed it verifies it, a changed character anywhere fails, another park's
 * key fails — and a band code is never read as a booking, nor a booking as a
 * band, although one key signs both.
 */

const KEY = 'test-park-key-0123456789';
const OTHER_KEY = 'another-park-key-987654321';

/** Flip one character of a code to a different one of the same alphabet. */
function flip(code: string, index: number): string {
  const ch = code[index]!;
  const replacement = ch === 'A' ? 'B' : ch === '0' ? '1' : ch === 'Z' ? 'Y' : 'A';
  return `${code.slice(0, index)}${replacement}${code.slice(index + 1)}`;
}

describe('a booking QR round-trips', () => {
  it('names the booking it was minted for, with no lookup', () => {
    const bookingId = newId();
    const code = mintBookingQr(bookingId, KEY);
    expect(code.startsWith(BOOKING_QR_HEADER)).toBe(true);
    expect(code).toHaveLength(BOOKING_QR_HEADER.length + 26 + 1 + BOOKING_QR_SIGNATURE_LENGTH);
    // QR alphanumeric throughout: upper-case, digits, the colon and the dot.
    expect(code).toMatch(/^[0-9A-Z:.]+$/);

    const verified = verifyBookingQr(code, KEY);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.bookingId).toBe(bookingId);
    expect(verified.ulid).toBe(ulidFromUuid(bookingId));
  });

  it('is the same code every time for the same booking and key', () => {
    const bookingId = newId();
    expect(mintBookingQr(bookingId, KEY)).toBe(mintBookingQr(bookingId, KEY));
  });

  it('reads back through a scanner that lower-cases or pads it', () => {
    const bookingId = newId();
    const code = mintBookingQr(bookingId, KEY);
    const verified = verifyBookingQr(`  ${code.toLowerCase()}\n`, KEY);
    expect(verified.ok && verified.bookingId).toBe(bookingId);
  });

  it('is an HMAC-SHA256 in its own domain, pinned against node:crypto', () => {
    const bookingId = newId();
    const ulid = ulidFromUuid(bookingId);
    const mac = createHmac('sha256', KEY).update(`oto.booking-qr.v1|${ulid}`).digest();
    // The first ten bytes, five bits at a time, in Crockford base32.
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let bits = '';
    for (const byte of mac.subarray(0, 10)) bits += byte.toString(2).padStart(8, '0');
    let expected = '';
    for (let i = 0; i < 80; i += 5) expected += alphabet[parseInt(bits.slice(i, i + 5), 2)];
    expect(mintBookingQr(bookingId, KEY).split('.')[1]).toBe(expected);
  });
});

describe('a tampered booking QR is refused', () => {
  it('refuses a changed character anywhere in the body', () => {
    const code = mintBookingQr(newId(), KEY);
    const bodyStart = BOOKING_QR_HEADER.length;
    for (let i = bodyStart + 1; i < bodyStart + 26; i += 1) {
      const tampered = flip(code, i);
      if (tampered === code) continue;
      const result = verifyBookingQr(tampered, KEY);
      expect(result.ok, `body character ${i}`).toBe(false);
    }
  });

  it('refuses a changed character anywhere in the signature', () => {
    const code = mintBookingQr(newId(), KEY);
    const sigStart = code.indexOf('.') + 1;
    for (let i = sigStart; i < code.length; i += 1) {
      const result = verifyBookingQr(flip(code, i), KEY);
      expect(result, `signature character ${i}`).toEqual({ ok: false, reason: 'signature' });
    }
  });

  it('refuses another booking\'s signature on this booking', () => {
    const a = mintBookingQr(newId(), KEY);
    const b = mintBookingQr(newId(), KEY);
    const spliced = `${a.split('.')[0]}.${b.split('.')[1]}`;
    expect(verifyBookingQr(spliced, KEY)).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses a QR signed with another park\'s key', () => {
    const code = mintBookingQr(newId(), OTHER_KEY);
    expect(verifyBookingQr(code, KEY)).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses a short key rather than signing with it', () => {
    expect(() => mintBookingQr(newId(), 'short')).toThrow(/at least/);
    expect(() => verifyBookingQr(mintBookingQr(newId(), KEY), 'short')).toThrow(/at least/);
  });
});

describe('a band code and a booking QR can never be taken for each other', () => {
  it('refuses a band code as a booking, whatever key checks it', () => {
    const band = mintBandCode('T1', ulidFromUuid(newId()), KEY);
    expect(isBookingQrShape(band)).toBe(false);
    expect(parseBookingQr(band)).toBeNull();
    expect(verifyBookingQr(band, KEY)).toEqual({ ok: false, reason: 'format' });
  });

  it('refuses a booking QR as a band code', () => {
    const booking = mintBookingQr(newId(), KEY);
    expect(isBandCodeShape(booking)).toBe(false);
    expect(parseBandCode(booking)).toBeNull();
    expect(verifyBandCode(booking, KEY)).toEqual({ ok: false, reason: 'format' });
  });

  it('never reuses a band signature as a booking signature for the same id under one key', () => {
    // The same 128 bits named both ways, signed with the same key: the MAC
    // inputs differ by domain, so neither signature verifies as the other.
    const id = newId();
    const band = mintBandCode('BK1', ulidFromUuid(id), KEY);
    const bandSignature = band.split('.')[1]!;
    const booking = mintBookingQr(id, KEY);
    // A shape-valid QR carrying the WRONG signature must fall to the MAC, not
    // to length: splice another booking's signature onto this body and expect
    // 'signature', proving verification is real (the old not-toContain check
    // compared strings of different lengths and proved nothing). The band
    // signature itself stays unused here: it cannot even dress as a booking
    // signature, which the grafted probe below pins on shape.
    const other = mintBookingQr(newId(), KEY);
    const [body] = booking.split('.');
    const [, otherSignature] = other.split('.');
    const spliced = body + '.' + otherSignature;
    expect(verifyBookingQr(spliced, KEY)).toEqual({ ok: false, reason: 'signature' });
    // A booking header grafted onto a band's signature is refused on shape.
    const grafted = `${BOOKING_QR_HEADER}${ulidFromUuid(id)}.${bandSignature}`;
    expect(verifyBookingQr(grafted, KEY).ok).toBe(false);
  });

  it('refuses a product barcode and a typed reference', () => {
    expect(isBookingQrShape('8850000000017')).toBe(false);
    expect(isBookingQrShape('OTO-AB12-3456')).toBe(false);
    expect(isBookingQrShape(`${BOOKING_QR_HEADER}`)).toBe(false);
    expect(isBookingQrShape(`${BOOKING_QR_HEADER}${'0'.repeat(26)}.${'0'.repeat(15)}`)).toBe(false);
  });
});

describe('the key id is a fingerprint, never the key', () => {
  it('is stable for a key, differs between keys and carries no part of either', () => {
    expect(bookingQrKeyId(KEY)).toBe(bookingQrKeyId(KEY));
    expect(bookingQrKeyId(KEY)).not.toBe(bookingQrKeyId(OTHER_KEY));
    expect(bookingQrKeyId(KEY)).toMatch(/^k[0-9A-Z]{8}$/);
    expect(bookingQrKeyId(KEY)).not.toContain(KEY.slice(0, 4).toUpperCase());
  });
});
