import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOAT,
  CashMovementsQuerySchema,
  EndOfDayCloseBodySchema,
  EndOfDayQuerySchema,
  RECON_TOLERANCE,
  ROLE_BUNDLES,
  WALLET_TENDER_CODE,
  PAID_ONLINE_TENDER_CODE,
  applyEndOfDayEntries,
  countsAsTillTakings,
  isCalendarDate,
  lineFlag,
  reconVerdict,
  recomputeEndOfDay,
  type EodLine,
} from '../src';

/**
 * S2-15a round 1 — the prototype's End of Day helpers (`lib/endOfDay.ts`),
 * ported to satang, and the one gate the day's lines read.
 */

const line = (channel: string, expectedSatang: number, actualSatang: number | null = null): EodLine => ({
  channel,
  expectedSatang,
  actualSatang,
  differenceSatang: actualSatang === null ? 0 : actualSatang - expectedSatang,
});

const day = (lines: EodLine[], countedSatang: number | null = null, floatSatang: number | null = DEFAULT_FLOAT) => ({
  lines,
  cashCount: { countedSatang, floatSatang, cashIncomeSatang: null },
  floatLeftSatang: DEFAULT_FLOAT as number | null,
  vouchers: { handedOut: null as number | null, redeemed: null as number | null },
  totalExpectedSatang: 0,
  totalActualSatang: 0,
  totalDifferenceSatang: 0,
});

describe('the prototype’s constants, in satang', () => {
  it('฿6,000 standard float and ฿1 tolerance', () => {
    expect(DEFAULT_FLOAT).toBe(600_000);
    expect(RECON_TOLERANCE).toBe(100);
  });
});

describe('lineFlag and reconVerdict', () => {
  it('pending until entered; ok within ฿1 either way; off beyond', () => {
    expect(lineFlag(line('promptpay', 100_00))).toBe('pending');
    expect(lineFlag(line('promptpay', 100_00, 101_00))).toBe('ok');
    expect(lineFlag(line('promptpay', 100_00, 99_00))).toBe('ok');
    expect(lineFlag(line('promptpay', 100_00, 101_01))).toBe('off');
    expect(lineFlag(line('promptpay', 100_00, 98_99))).toBe('off');
  });

  it('off beats pending beats ok', () => {
    expect(reconVerdict({ lines: [line('a', 1, 1), line('b', 1)] })).toBe('pending');
    expect(reconVerdict({ lines: [line('a', 1, 1), line('b', 1), line('c', 0, 500)] })).toBe('off');
    expect(reconVerdict({ lines: [line('a', 1, 1), line('b', 0, 0)] })).toBe('ok');
  });
});

describe('recomputeEndOfDay', () => {
  it('cash income = counted − float drives the cash line; totals add up; input untouched', () => {
    const input = day([line('cash', 1_000_00, 5), line('promptpay', 300_00, 290_00), line('credit', 50_00)], 7_020_50);
    const out = recomputeEndOfDay(input);
    expect(out.cashCount.cashIncomeSatang).toBe(1_020_50);
    expect(out.lines[0]).toEqual({ channel: 'cash', expectedSatang: 1_000_00, actualSatang: 1_020_50, differenceSatang: 20_50 });
    expect(out.lines[1]!.differenceSatang).toBe(-10_00);
    expect(out.lines[2]!.differenceSatang).toBe(0);
    expect(out.totalExpectedSatang).toBe(1_350_00);
    expect(out.totalActualSatang).toBe(1_020_50 + 290_00);
    expect(out.totalDifferenceSatang).toBe(20_50 - 10_00);
    expect(input.lines[0]!.actualSatang).toBe(5);
  });

  it('the cash line waits for both the count and the float', () => {
    expect(recomputeEndOfDay(day([line('cash', 1_000_00)], null)).lines[0]!.actualSatang).toBeNull();
    expect(recomputeEndOfDay(day([line('cash', 1_000_00)], 5_000_00, null)).cashCount.cashIncomeSatang).toBeNull();
  });
});

describe('applyEndOfDayEntries', () => {
  it('puts staff’s entries on the lines it has, never on cash, and recomputes', () => {
    const out = applyEndOfDayEntries(day([line('cash', 100_00), line('card:T1', 200_00)]), {
      actuals: [
        { channel: 'card:T1', actualSatang: 199_50 },
        { channel: 'cash', actualSatang: 1 },
        { channel: 'card:NOT-HERE', actualSatang: 9 },
      ],
      countedSatang: DEFAULT_FLOAT + 100_00,
      floatLeftSatang: 5_000_00,
      vouchers: { handedOut: 2, redeemed: 0 },
    });
    expect(out.lines.map((l) => [l.channel, l.actualSatang, l.differenceSatang])).toEqual([
      ['cash', 100_00, 0],
      ['card:T1', 199_50, -50],
    ]);
    expect(out.floatLeftSatang).toBe(5_000_00);
    expect(out.vouchers).toEqual({ handedOut: 2, redeemed: 0 });
  });

  it('the close body keeps only what staff enter', () => {
    const parsed = EndOfDayCloseBodySchema.parse({
      date: '2026-10-02',
      countedSatang: 1,
      floatLeftSatang: null,
      totalExpectedSatang: 1,
      lines: [],
    });
    expect(parsed).toEqual({
      date: '2026-10-02',
      countedSatang: 1,
      floatLeftSatang: null,
      actuals: [],
      vouchers: { handedOut: null, redeemed: null },
    });
    expect(() => EndOfDayCloseBodySchema.parse({ date: '2026-10-02', countedSatang: -1, floatLeftSatang: null })).toThrow();
  });
});

describe('countsAsTillTakings — the one gate', () => {
  it('money at a counter: cash, card and QR; never with no station; never credit or paid online', () => {
    expect(countsAsTillTakings({ method: 'cash', methodCode: 'cash', stationId: 's' })).toBe(true);
    expect(countsAsTillTakings({ method: 'card', methodCode: 'card', stationId: 's' })).toBe(true);
    expect(countsAsTillTakings({ method: 'qr', methodCode: 'alipay', stationId: 's' })).toBe(true);
    expect(countsAsTillTakings({ method: 'qr', methodCode: 'promptpay', stationId: null })).toBe(false);
    expect(countsAsTillTakings({ method: 'wallet', methodCode: WALLET_TENDER_CODE, stationId: 's' })).toBe(false);
    expect(countsAsTillTakings({ method: 'transfer', methodCode: PAID_ONLINE_TENDER_CODE, stationId: 's' })).toBe(false);
    // Callers that name no station are answered on the tender alone, as before.
    expect(countsAsTillTakings({ method: 'cash', methodCode: 'cash' })).toBe(true);
  });
});

describe('who opens and closes End of Day', () => {
  it('every role with the Today screen reads it and closes it, reception included', () => {
    for (const role of ['staff', 'reception', 'branch_manager', 'operator_admin', 'platform_admin'] as const) {
      expect(ROLE_BUNDLES[role], role).toContain('pos:cash:read');
      expect(ROLE_BUNDLES[role], role).toContain('pos:cash:day_close');
    }
    // Approving a paid-out stays a manager's.
    expect(ROLE_BUNDLES.reception).not.toContain('pos:cash:approve');
    expect(ROLE_BUNDLES.branch_manager).toContain('pos:cash:approve');
  });
});

describe('a business day is a day the calendar has', () => {
  it('round-trips real dates, leap days included, and refuses impossible ones', () => {
    for (const ok of ['2026-10-02', '2024-02-29', '2026-12-31', '2026-01-01']) expect(isCalendarDate(ok), ok).toBe(true);
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-10-2', 'yesterday']) {
      expect(isCalendarDate(bad), bad).toBe(false);
    }
  });

  it('every End of Day schema refuses 2026-02-30 in words, before the database sees it', () => {
    const q = EndOfDayQuerySchema.safeParse({ date: '2026-02-30' });
    expect(q.success).toBe(false);
    expect(q.error?.issues[0]?.message).toBe('That date is not on the calendar.');
    expect(EndOfDayCloseBodySchema.safeParse({ date: '2025-02-30', countedSatang: null, floatLeftSatang: null }).success).toBe(false);
    expect(CashMovementsQuerySchema.safeParse({ date: '2026-04-31' }).success).toBe(false);
    expect(CashMovementsQuerySchema.safeParse({}).success).toBe(true);
    expect(EndOfDayQuerySchema.safeParse({ date: '2026-10-02' }).success).toBe(true);
  });
});
