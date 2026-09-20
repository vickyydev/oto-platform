import { describe, expect, it } from 'vitest';
import { encodeCode128, encodeQr } from '../src/index';
import { decodeQrMatrix } from './qr-reader';
import { decodeCode128Modules } from './code128-reader';

/**
 * Both encoders are tested by decoding what they produce with code that walks
 * the format in the other direction. A QR that does not scan is the failure
 * that looks like a broken printer rather than a broken renderer, so
 * "it produced some modules" is not evidence.
 */

describe('QR', () => {
  const samples = [
    'HKT1-4821',
    'LW-260917-0042',
    'wb-walkin-S10428-0',
    // The real thing: a station-prefixed ULID plus an HMAC (D4).
    'HKT1:01J8Z4M2QR7V9XK3T0B5N6YWEA:9f2c41ab77d0e5',
    // UTF-8 byte mode, because a payload could carry Thai.
    'สวัสดี OTO',
  ];

  for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
    for (const value of samples) {
      it(`round-trips ${JSON.stringify(value)} at error correction ${ecc}`, () => {
        const matrix = encodeQr(value, ecc);
        expect(decodeQrMatrix(matrix)).toBe(value);
      });
    }
  }

  it('grows the version with the payload', () => {
    expect(encodeQr('a', 'M').version).toBe(1);
    expect(encodeQr('a'.repeat(200), 'M').version).toBeGreaterThan(5);
    expect(encodeQr('a'.repeat(1000), 'L').version).toBeGreaterThan(20);
  });

  it('places the three finder patterns and the dark module', () => {
    const m = encodeQr('HKT1-4821', 'M');
    for (const [fx, fy] of [
      [0, 0],
      [m.size - 7, 0],
      [0, m.size - 7],
    ] as const) {
      // 7x7: a black ring, a white ring one in, a black 3x3 core.
      expect(m.get(fx + 3, fy + 3)).toBe(true); // core
      expect(m.get(fx + 2, fy + 3)).toBe(true); // still core
      expect(m.get(fx + 1, fy + 3)).toBe(false); // white ring
      expect(m.get(fx, fy)).toBe(true); // outer ring
    }
    expect(m.get(8, m.size - 8)).toBe(true); // the always-dark module
  });

  it('refuses a payload that does not fit version 40', () => {
    expect(() => encodeQr('x'.repeat(5000), 'H')).toThrow(/does not fit version 40/);
  });
});

describe('Code 128', () => {
  const samples = ['HKT1-4821', 'LW-260917-0042', 'ABC', '1234567890', 'F-2207'];

  for (const value of samples) {
    it(`round-trips ${JSON.stringify(value)}`, () => {
      const { modules } = encodeCode128(value);
      expect(decodeCode128Modules(modules)).toBe(value);
    });
  }

  it('is narrower for a long digit run, because set C packs two per symbol', () => {
    const digits = encodeCode128('12345678901234567890').modules.length;
    const letters = encodeCode128('ABCDEFGHIJABCDEFGHIJ').modules.length;
    expect(digits).toBeLessThan(letters);
  });

  it('emits whole symbols: 11 modules each plus the stop bar', () => {
    const { modules } = encodeCode128('HKT1-4821');
    expect((modules.length - 2) % 11).toBe(0);
  });

  it('refuses anything outside printable ASCII', () => {
    expect(() => encodeCode128('ส')).toThrow(/printable ASCII only/);
  });
});
