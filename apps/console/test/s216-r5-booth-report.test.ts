import { describe, expect, it } from 'vitest';
import type { BoothReport } from '@oto/shared';
import {
  boothReportTotals,
  prizeCostWords,
  redemptionLagWords,
  redemptionRateWords,
} from '@/lib/boothReportWords';
import { findSection } from '@/components/consoleSections';

/**
 * S2-15b round 5 — Console > Booths > Report's words: the funnel's rate and
 * lag as a person says them, a prize cost that admits a prize nobody has
 * costed, and the range's totals across the booths.
 */

const funnel = {
  spins: 9,
  prizesWon: 8,
  vouchersIssued: 8,
  vouchersRedeemed: 2,
  redemptionRate: 0.25,
  meanRedemptionLagS: 5_400,
  prizeCostSatang: 75_000,
  prizeCostIncomplete: false,
};

describe('the booth report’s words', () => {
  it('says the rate and the lag plainly, and a dash where there is nothing to say', () => {
    expect(redemptionRateWords(0.25)).toBe('25.0%');
    expect(redemptionRateWords(null)).toBe('—');
    expect(redemptionLagWords(null)).toBe('—');
    expect(redemptionLagWords(20)).toBe('1 min');
    expect(redemptionLagWords(1_500)).toBe('25 min');
    expect(redemptionLagWords(5_400)).toBe('1.5 h');
    expect(redemptionLagWords(3 * 86_400)).toBe('3.0 days');
  });

  it('names a prize cost that is short by a prize not costed yet', () => {
    expect(prizeCostWords(funnel)).toBe('฿750');
    expect(prizeCostWords({ ...funnel, prizeCostIncomplete: true })).toBe('฿750 + not costed');
    expect(prizeCostWords({ ...funnel, prizeCostSatang: 0, prizeCostIncomplete: true })).toBe('Not costed');
    expect(prizeCostWords({ ...funnel, prizesWon: 0, prizeCostSatang: 0 })).toBe('—');
  });

  it('adds the booths up, the lag weighted by what each redeemed', () => {
    const booth = (over: Partial<BoothReport['booths'][number]>): BoothReport['booths'][number] => ({
      boothId: '018f0000-0000-7000-8000-0000000000b1',
      name: 'Booth 1',
      branchId: '018f0000-0000-7000-8000-000000000001',
      branchName: 'Central',
      ...funnel,
      ...over,
    });
    const totals = boothReportTotals({
      booths: [
        booth({}),
        booth({ spins: 1, prizesWon: 1, vouchersIssued: 2, vouchersRedeemed: 1, meanRedemptionLagS: 600, prizeCostSatang: 0, prizeCostIncomplete: true }),
      ],
    });
    expect(totals).toEqual({
      spins: 10,
      prizesWon: 9,
      vouchersIssued: 10,
      vouchersRedeemed: 3,
      redemptionRate: 0.3,
      meanRedemptionLagS: Math.round((5_400 * 2 + 600) / 3),
      prizeCostSatang: 75_000,
      prizeCostIncomplete: true,
    });
    expect(boothReportTotals({ booths: [] })).toMatchObject({ spins: 0, redemptionRate: null, meanRedemptionLagS: null });
  });

  it('is a section of the park, opened on analytics:read', () => {
    expect(findSection('booth-report')).toMatchObject({ label: 'Booth report', permission: 'analytics:read' });
  });
});
