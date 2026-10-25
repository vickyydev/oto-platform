import type { OverviewSnapshot } from './console';
import type { AiUsageAggregate } from './aggregates-ai';

const name = (value: string) => Array.from(value, char =>
  char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '<' || char === '>' ? ' ' : char,
).join('').trim();
const money = (satang: number) => `THB ${(satang / 100).toFixed(2)}`;

function usage(label: string, source: AiUsageAggregate): string[] {
  const totals = source.totals;
  const estimate = totals.spendEstimate === null
    ? `Price unavailable: ${totals.reason ?? 'unpriced_tokens'} (USD estimate)`
    : `USD ${totals.spendEstimate.toFixed(6)} estimate${totals.reason ? `; ${totals.reason}` : ''}`;
  return [
    `${label}: ${totals.count}; ${totals.totalTokens} tokens (input ${totals.inputTokens}, output ${totals.outputTokens}, cache-read ${totals.cacheReadTokens}).`,
    `${estimate}; ${totals.unpricedTokens} unpriced tokens; excludes unpersisted cache writes.`,
    `Coverage: retained records${source.retentionDays === null ? '' : `; ${source.retentionDays}-day retention`}; attribution: ${source.attribution}.`,
    ...(source.operatorWide === null ? [] : [`Includes one unassigned operator bucket: ${source.operatorWide.totals.count}; ${source.operatorWide.totals.totalTokens} tokens.`]),
  ];
}

/** Safe count/status text, shared byte-for-byte by Copy and the branch digest. */
export function formatOverviewSummary(snapshot: Omit<OverviewSnapshot, 'statusSummary'>): string {
  const chosen = new Set(snapshot.selectedBranchIds);
  const branches = snapshot.branches.filter(park => chosen.has(park.id));
  const { members, bookings, assistantUsage, inboxAiUsage, fleet } = snapshot.aggregates;
  const totals = snapshot.totals;
  return [
    'Admin status summary',
    `Checked: ${snapshot.generatedAt}`,
    `Parks: ${branches.map(park => name(park.name)).join(', ') || 'No reachable parks'}`,
    'Park business dates and legacy figures:',
    ...branches.flatMap(park => {
      const figures = snapshot.parks.find(row => row.branchId === park.id);
      if (!figures) return [];
      return [`${name(park.name)}: business date ${park.businessDate}; ${park.timezone}; start ${park.businessDayStart}.`,
        `Revenue ${money(figures.revenueSatang)}; guests ${figures.guests}; inside ${figures.inParkNow}; bookings ${figures.bookingsToday}; unanswered ${figures.inboxUnanswered}; alerts ${figures.openAlerts}; offline boxes ${figures.boxesOffline}.`,
        `Revenue source ${figures.analyticsSource}; ${figures.provisional ? 'Provisional' : 'Not provisional'}; last rollup ${figures.lastRolledUpAt ?? 'unavailable'}; occupancy ${figures.occupancyStale ? 'stale' : 'current'} as of ${figures.occupancyAsOf ?? 'unavailable'}.`];
    }),
    `Selected park totals: revenue ${money(totals.revenueSatang)}; guests ${totals.guests}; inside ${totals.inParkNow}; bookings ${totals.bookingsToday}; unanswered ${totals.inboxUnanswered}; alerts ${totals.openAlerts}; offline boxes ${totals.boxesOffline}.`,
    `Calendar period: ${members.period.from} to ${members.period.to} (Bangkok calendar today, separate from park business dates).`,
    `Members & visits: ${members.totals.visits} visit records; ${members.totals.visitingMembers} distinct visiting members; draft ${members.totals.draftVisits}, active ${members.totals.activeVisits}, closed ${members.totals.closedVisits}. Basis: visit-date.`,
    `Booking activity: ${bookings.totals.bookings} bookings; ${money(bookings.totals.bookedValueSatang)} priced booking value; ${bookings.totals.redeemedBookings} redeemed booking-date cohort. This value is not payment revenue.`,
    ...usage('Internal assistant asks', assistantUsage),
    ...usage('Inbox AI turns', inboxAiUsage),
    `AI dates: created-at-bangkok ${assistantUsage.period.from} to ${assistantUsage.period.to}.`,
    `Fleet: ${fleet.totals.boxes} boxes; online ${fleet.totals.online}, offline ${fleet.totals.offline}, unclaimed ${fleet.totals.unclaimed}, disabled ${fleet.totals.disabled}. Current snapshot: ${fleet.asOf}; persisted status.`,
    `Needs a decision (checked ${snapshot.decisions.generatedAt}):`,
    ...snapshot.decisions.items.map(item => `${name(item.label)}: ${item.status === 'available' ? item.count : item.status === 'not-built' ? 'Not built' : 'Unavailable'}. Basis: ${item.basis}.`),
  ].join('\n');
}
