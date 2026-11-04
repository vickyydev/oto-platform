import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintBoothCode, parseBandShortCode } from '@oto/shared';
import { looksLikeTypedFnbVoucher, looksLikeVoucherCode } from '@/lib/tillVoucher';
import { readTabScan, readVoucherScan, type StationScanEvent } from '@/lib/scanChannel';

afterEach(() => vi.restoreAllMocks());

describe('SCRUM-746: typed F&B band codes precede voucher classification', () => {
  // P2 FINDING: removing the dash makes this real four-character prefix look
  // like an old voucher. Fix: parse the printed band before voucher matching.
  it.each(['ZI7C-QV8QZ8', ' zi7c-qv8qz8 ', 'ZI7C QV8QZ8'])(
    'leaves %j for the child band lookup', code => {
      expect(parseBandShortCode(code)).toEqual({ prefix: 'ZI7C', tail: 'QV8QZ8' });
      expect(looksLikeVoucherCode(code)).toBe(true);
      expect(looksLikeTypedFnbVoucher(code)).toBe(false);
    },
  );

  it.each(['T1-QV8QZ8', 'ZZ747A-QV8QZ8'])('keeps short and six-character bands in the band lookup: %s', code => {
    expect(parseBandShortCode(code)).not.toBeNull();
    expect(looksLikeTypedFnbVoucher(code)).toBe(false);
  });

  it('still claims a genuine current voucher and a legacy voucher', () => {
    let ordinal = 0;
    const current = mintBoothCode('B1', maximum => ordinal++ % maximum);
    for (const code of [current, 'B1ABCDEFGH']) {
      expect(parseBandShortCode(code)).toBeNull();
      expect(looksLikeTypedFnbVoucher(code)).toBe(true);
    }
  });

  it('keeps an explicit voucher scan separate from a band scan', () => {
    const base: StationScanEvent = {
      kind: 'scan', source: 'box_hid', codeKind: 'band', codeFingerprint: 'a'.repeat(16),
      outcome: 'handled', handler: 'band', errorCode: null, actionId: null,
      scannedAt: '2026-11-04T00:00:00.000Z',
      detail: { band: { bandId: 'zz-test-band', prefix: 'ZI7C', shortCode: 'ZI7C-QV8QZ8', mintedAt: null } },
    };
    expect(readTabScan(base)).toEqual({ ok: true, what: 'band', key: 'ZI7C-QV8QZ8' });
    expect(readVoucherScan(base)).toBeNull();
    const voucher = { ...base, codeKind: 'voucher', handler: 'voucher', detail: { code: 'B1ABCDEFGH' } };
    expect(readTabScan(voucher)).toBeNull();
    expect(readVoucherScan(voucher)).not.toBeNull();
  });

  it('uses this discriminator only in the typed form capture', () => {
    const source = readFileSync(new URL('../src/pages/OrderStation.tsx', import.meta.url), 'utf8');
    const capture = source.slice(source.indexOf('onSubmitCapture='), source.indexOf('<ScanWristband', source.indexOf('onSubmitCapture=')));
    expect(capture).toContain('if (!looksLikeTypedFnbVoucher(typed)) return;');
    expect(capture.indexOf('looksLikeTypedFnbVoucher')).toBeLessThan(capture.indexOf('event.preventDefault()'));
    expect(capture).toContain('redeemScannedVoucher(typed)');
  });
});
