// Today > Performance — S2-15b round 3 (plan docs/progress/plans/analytics/PLAN.md).
//
// WHAT CHANGED FROM THE PROTOTYPE, AND WHAT DID NOT. The tab is the
// prototype's (`components/floor/PerformanceTab.tsx`, `MobilePerformanceTab`)
// with its look and words; only where the figures come from moved:
// `mockApi.getFloorReport` over this browser's own copy of the sales is now
// the platform's `GET /analytics/summary`, the rolled-up day every till and
// phone reads alike. The figures arrive in SATANG; the tab's components read
// baht (`FloorReport` in `@/types`), and `floorReportOf` is the one place the
// two meet.
import type { AnalyticsSummary, AnalyticsSummaryGroup, AnalyticsSummaryRow } from '@oto/shared';
import type { FloorReport } from '@/types';
import { api } from './client';

/**
 * The stored days of the named branches, or of every branch this account may
 * read when none is named. The platform answers only for branches the caller
 * may read; the others it lists as omitted.
 */
export function getAnalyticsSummary(query: {
  branches?: readonly string[];
  from: string;
  to: string;
  group?: AnalyticsSummaryGroup;
}): Promise<AnalyticsSummary> {
  const params = new URLSearchParams();
  if (query.branches && query.branches.length > 0) params.set('branches', query.branches.join(','));
  params.set('from', query.from);
  params.set('to', query.to);
  params.set('group', query.group ?? 'total');
  return api.get<AnalyticsSummary>(`/analytics/summary?${params.toString()}`);
}

const thb = (satang: number): number => satang / 100;

/**
 * The platform's day in the prototype's `FloorReport` shape (baht), for the
 * tab's components: the five bars in `getFloorReport`'s order and labels, the
 * headline as their sum. "Drop-off kids in park" is not a rolled-up figure —
 * it is live, not date-bound — so it is read beside this, never from it.
 */
export function floorReportOf(row: AnalyticsSummaryRow, date: string, branchId: string): FloorReport {
  return {
    date,
    branchId,
    netRevenueTHB: thb(row.revenueSatang),
    creditPaidTHB: thb(row.creditPaidSatang),
    txnCount: row.txnCount,
    guests: { kids: row.guestsKids, adults: row.guestsAdults },
    revenueSplit: [
      { key: 'tickets', label: 'Tickets', amountTHB: thb(row.ticketsSatang) },
      { key: 'fnb', label: 'F&B', amountTHB: thb(row.fnbSatang) },
      { key: 'merch', label: 'Merch', amountTHB: thb(row.merchSatang) },
      { key: 'parties', label: 'Parties', amountTHB: thb(row.partiesSatang) },
      { key: 'dropoff', label: 'Drop-off', amountTHB: thb(row.dropoffSatang) },
    ],
    partiesToday: row.partiesCount,
    dropOffInParkNow: 0,
    ticketMix: { oneHour: row.mix1h, twoHour: row.mix2h, fullDay: row.mixFullDay },
  };
}
