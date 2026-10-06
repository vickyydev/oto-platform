import { formatTHB, type BoothFunnel, type BoothReport } from '@oto/shared';

/**
 * The booth report's words (S2-15b round 5). No prototype screen: the plan
 * defines the figures (§5, question 14) and these say them plainly.
 */

/** "62.5%", or a dash when nothing was issued to be redeemed. */
export function redemptionRateWords(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

/** Issue to redemption, as a person would say it: minutes, hours, then days. */
export function redemptionLagWords(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 48 * 3_600) return `${(seconds / 3_600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} days`;
}

/**
 * The prize cost of a funnel. A prize won with no cost set (zero is "not
 * costed yet") makes the figure short by it, and the words say so rather than
 * presenting a partial sum as the whole.
 */
export function prizeCostWords(funnel: Pick<BoothFunnel, 'prizeCostSatang' | 'prizeCostIncomplete' | 'prizesWon'>): string {
  if (funnel.prizesWon === 0) return '—';
  if (funnel.prizeCostIncomplete) {
    return funnel.prizeCostSatang > 0 ? `${formatTHB(funnel.prizeCostSatang)} + not costed` : 'Not costed';
  }
  return formatTHB(funnel.prizeCostSatang);
}

/** The range's totals across every booth in the answer. */
export function boothReportTotals(report: Pick<BoothReport, 'booths'>): BoothFunnel {
  const sum = (pick: (b: BoothReport['booths'][number]) => number) => report.booths.reduce((s, b) => s + pick(b), 0);
  const issued = sum((b) => b.vouchersIssued);
  const redeemed = sum((b) => b.vouchersRedeemed);
  const lag = sum((b) => (b.meanRedemptionLagS ?? 0) * b.vouchersRedeemed);
  return {
    spins: sum((b) => b.spins),
    prizesWon: sum((b) => b.prizesWon),
    vouchersIssued: issued,
    vouchersRedeemed: redeemed,
    redemptionRate: issued > 0 ? redeemed / issued : null,
    meanRedemptionLagS: redeemed > 0 ? Math.round(lag / redeemed) : null,
    prizeCostSatang: sum((b) => b.prizeCostSatang),
    prizeCostIncomplete: report.booths.some((b) => b.prizeCostIncomplete),
  };
}
