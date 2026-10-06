import { describe, expect, it } from 'vitest';
import {
  AnalyticsSummaryQuerySchema,
  analyticsSummaryBranchIds,
  emptyAnalyticsDayFigures,
  sumAnalyticsDayFigures,
  summariseAnalyticsDayV1,
  type AnalyticsSaleFacts,
} from '../src/analytics';

/**
 * S2-15b (SCRUM-216) round 3: adding stored days up, and the summary's query.
 */

function sale(over: Partial<AnalyticsSaleFacts>): AnalyticsSaleFacts {
  return {
    saleId: 's',
    kind: 'ticket',
    dropOff: false,
    hour: 10,
    grossSatang: 0,
    refundedSatang: 0,
    nonCreditSatang: 0,
    creditUsedSatang: 0,
    creditRestoredSatang: 0,
    kids: 0,
    adults: 0,
    mixOneHour: 0,
    mixTwoHour: 0,
    mixFullDay: 0,
    discountSatang: 0,
    compSatang: 0,
    vatSatang: 0,
    serviceSatang: 0,
    channels: [],
    ...over,
  };
}

describe('sumAnalyticsDayFigures', () => {
  it('two days added up are the day their sales would have made together', () => {
    const a = [
      sale({ saleId: 'a1', grossSatang: 124_000, kids: 1, adults: 1, mixTwoHour: 2, channels: ['Sales Booth'] }),
      sale({ saleId: 'a2', kind: 'fnb', grossSatang: 45_000, nonCreditSatang: 25_000, creditUsedSatang: 20_000 }),
    ];
    const b = [
      sale({ saleId: 'b1', grossSatang: 119_000, dropOff: true, kids: 1, refundedSatang: 10_000 }),
      sale({ saleId: 'b2', grossSatang: 50_000, channels: ['Sales Booth', 'instagram'] }),
    ];
    const summed = sumAnalyticsDayFigures([summariseAnalyticsDayV1(a), summariseAnalyticsDayV1(b)]);
    expect(summed).toEqual(summariseAnalyticsDayV1([...a, ...b]));
    expect(summed.byChannel).toEqual({
      'Sales Booth': { revenue: 174_000, txn_count: 2 },
      instagram: { revenue: 50_000, txn_count: 1 },
    });
  });

  it('nothing added up is a day with no sale, and the inputs are not changed', () => {
    expect(sumAnalyticsDayFigures([])).toEqual(emptyAnalyticsDayFigures());
    const day = summariseAnalyticsDayV1([sale({ grossSatang: 10_000, channels: ['Sales Booth'] })]);
    const copy = structuredClone(day);
    sumAnalyticsDayFigures([day, day]);
    expect(day).toEqual(copy);
  });
});

describe('the summary query', () => {
  const id1 = '0192f000-0000-7000-8000-00000000b001';
  const id2 = '0192f000-0000-7000-8000-00000000b002';

  it('takes a comma-separated list of branch ids, each once', () => {
    const parsed = AnalyticsSummaryQuerySchema.parse({ branches: `${id1},${id2},${id1}`, from: '2026-10-01', to: '2026-10-02' });
    expect(parsed.group).toBe('day');
    expect(analyticsSummaryBranchIds(parsed.branches)).toEqual([id1, id2]);
    expect(analyticsSummaryBranchIds(undefined)).toEqual([]);
  });

  it('refuses what is not a list of ids, a day off the calendar and an unknown grouping', () => {
    expect(AnalyticsSummaryQuerySchema.safeParse({ branches: 'hkt-central', from: '2026-10-01', to: '2026-10-01' }).success).toBe(false);
    expect(AnalyticsSummaryQuerySchema.safeParse({ branches: `${id1},`, from: '2026-10-01', to: '2026-10-01' }).success).toBe(false);
    expect(AnalyticsSummaryQuerySchema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(false);
    expect(AnalyticsSummaryQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-01', group: 'week' }).success).toBe(false);
  });
});
