import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import { describe, expect, it } from 'vitest';
import type { ApiResponse } from '@oto/api-types';
import { OverviewContent } from '@/pages/Overview';
import type { OverviewSnapshot } from '@/api/overview';

const park = {
  id: 'park-one', name: 'ZZ TEST Park', timezone: 'Asia/Bangkok',
  businessDayStart: '04:00:00', businessDate: '2026-10-22',
};
const totals = {
  revenueSatang: 123450, guests: 14, inParkNow: 9, bookingsToday: 3,
  inboxUnanswered: 2, openAlerts: 4, boxesOffline: 1,
};
type Additions = {
  aggregates: {
    members: ApiResponse<'/aggregates/members', 'get'>;
    bookings: ApiResponse<'/aggregates/bookings', 'get'>;
    assistantUsage: ApiResponse<'/aggregates/assistant-usage', 'get'>;
    inboxAiUsage: ApiResponse<'/aggregates/inbox-ai-usage', 'get'>;
    fleet: ApiResponse<'/aggregates/fleet', 'get'>;
  };
  decisions: { generatedAt: string; items: Array<{ key: 'pendingPayments' | 'syncQuarantine' | 'cashVariances' | 'latePayments' | 'strandedOccupants' | 'erasureRequests' | 'approvalRequests';
    label: string; status: 'available' | 'not-built' | 'unavailable'; count: number | null; basis: string }>;
    parks: Array<{ branchId: string; items: Additions['decisions']['items'] }> };
  statusSummary: string;
};
const generatedAt = '2026-10-22T06:00:00.000Z';
const period = { from: '2026-10-23', to: '2026-10-23' };
const envelope = { generatedAt, branches: [park], selectedBranchIds: [park.id] };
const visitMetrics = { visits: 12, draftVisits: 2, activeVisits: 7, closedVisits: 3, visitingMembers: 7 };
const bookingMetrics = { bookings: 8, bookedValueSatang: 543210, redeemedBookings: 6 };
const usageMetrics = { count: 5, inputTokens: 10, outputTokens: 4, cacheReadTokens: 6, totalTokens: 20,
  spendEstimate: null, reason: 'no_rate_configured' as const, unpricedTokens: 20 };
const usage = { ...envelope, period, basis: 'created-at-bangkok' as const, coverage: 'retained-records' as const,
  currency: 'USD' as const, excludesCacheWrites: true as const, totals: usageMetrics,
  parks: [{ branchId: park.id, totals: usageMetrics, rows: [{ date: period.from, ...usageMetrics }] }], operatorWide: null };
const fleetMetrics = { boxes: 8, online: 3, offline: 2, unclaimed: 1, disabled: 2 };
const decisionItems: Additions['decisions']['items'] = [
  { key: 'pendingPayments', label: 'Old unresolved payment attempts', status: 'available', count: 2, basis: 'native-pending-attempt-threshold' },
  { key: 'syncQuarantine', label: 'Open sync quarantine', status: 'available', count: 0, basis: 'open-owned-selected-park-boxes' },
  { key: 'cashVariances', label: 'Cash variance lines', status: 'unavailable', count: null, basis: 'saved-current-business-date-off-lines' },
  { key: 'latePayments', label: 'Late payment alerts', status: 'available', count: 1, basis: 'unresolved-native-late-payment-alerts' },
  { key: 'strandedOccupants', label: 'End-of-day review rows still inside', status: 'available', count: 4, basis: 'current-business-date-native-end-of-day-rows' },
  { key: 'erasureRequests', label: 'Erasure requests', status: 'not-built', count: null, basis: 'not-built' },
  { key: 'approvalRequests', label: 'Approval requests', status: 'not-built', count: null, basis: 'not-built' },
];
const snapshot: OverviewSnapshot & Additions = {
  generatedAt: '2026-10-22T06:00:00.000Z', branches: [park], selectedBranchIds: [park.id], totals,
  parks: [{
    branchId: park.id, businessDate: park.businessDate, ...totals,
    analyticsSource: 'oto_pos', provisional: true, lastRolledUpAt: '2026-10-22T05:55:00.000Z',
    occupancyAsOf: '2026-10-22T05:59:30.000Z', occupancyStale: true,
  }],
  aggregates: {
    members: { ...envelope, period, basis: 'visit-date', totals: visitMetrics,
      parks: [{ branchId: park.id, totals: visitMetrics, rows: [{ date: period.from, ...visitMetrics }] }] },
    bookings: { ...envelope, period, basis: 'booking-date', valueBasis: 'priced-booking-value', redemptionBasis: 'booking-date-cohort', totals: bookingMetrics,
      parks: [{ branchId: park.id, totals: bookingMetrics, rows: [{ date: period.from, ...bookingMetrics }] }] },
    assistantUsage: { ...usage, attribution: 'seat-at-ask', retentionDays: 90 },
    inboxAiUsage: { ...usage, attribution: 'current-conversation-branch', retentionDays: null },
    fleet: { ...envelope, basis: 'current-snapshot', asOf: generatedAt, totals: fleetMetrics, parks: [{ branchId: park.id, ...fleetMetrics }] },
  },
  decisions: { generatedAt, items: decisionItems, parks: [{ branchId: park.id, items: decisionItems }] },
  statusSummary: 'ZZ TEST Park\nBangkok calendar 2026-10-23\nAI price unavailable in USD; no_rate_configured;20 unpriced tokens; excludes cache writes.',
};
const noop = () => undefined;
function markup(data: OverviewSnapshot | null, options: { error?: string; allowed?: boolean; loading?: boolean } = {}) {
  return renderToStaticMarkup(createElement(Router, { ssrPath: '/overview', children:
    createElement(OverviewContent, {
      data, branches: snapshot.branches, branchId: '', loading: options.loading ?? false,
      error: options.error ?? null, has: () => options.allowed ?? true,
      onBranchChange: noop, onRefresh: noop, onOpenSource: noop, openingSource: null,
    }),
  }));
}

describe('Overview v1 markup', () => {
  it('renders the seven returned figures and source actions, rather than recalculating paged lists', () => {
    const html = markup(snapshot);
    for (const label of ['Revenue today', 'Guests today', 'In park now', 'Bookings today',
      'Inbox unanswered', 'Open alerts', 'Boxes offline']) expect(html).toContain(label);
    expect(html).toContain('1,234.50');
    expect(html).toContain('href="/reports/bookings"');
    expect(html).toContain('href="/watch/health"');
    expect(html).toContain('href="/devices"');
    expect(html).toContain('Open Performance');
    expect(html).toContain('Open unanswered Inbox');
    expect(html).toContain('All reachable parks');
  });

  it('keeps returned numbers visible when source-screen permissions are absent, without offering those screens', () => {
    const html = markup(snapshot, { allowed: false });
    expect(html).toContain('1,234.50');
    expect(html).not.toContain('href="/watch/health"');
    expect(html).not.toContain('href="/devices"');
    expect(html).not.toContain('Open Performance');
    expect(html).toContain('Source screen is not on your access.');
  });

  it('names each park business date, provisional revenue and stale occupancy with the actual timestamps', () => {
    const html = markup(snapshot);
    expect(html).toContain('ZZ TEST Park');
    expect(html).toContain('2026-10-22');
    expect(html).toContain('Asia/Bangkok');
    expect(html).toContain('Provisional');
    expect(html).toContain('OTO POS summary');
    expect(html).toContain('2026-10-22T05:55:00.000Z');
    expect(html).toContain('Occupancy is stale');
    expect(html).toContain('2026-10-22T05:59:30.000Z');
  });

  it('never presents a failed or pending read as seven zeroes or an all-clear', () => {
    const failed = markup(null, { error: 'The source did not answer.' });
    expect(failed).toContain('The source did not answer.');
    expect(failed).toContain('Overview figures could not be read');
    expect(failed).not.toContain('Revenue today');
    expect(failed).not.toContain('No open alerts');
    expect(markup(null, { loading: true })).toContain('Loading today');
  });

  it('distinguishes an account with no reachable parks from a park with genuine zero totals', () => {
    const html = markup({ ...snapshot, branches: [], selectedBranchIds: [], parks: [] });
    expect(html).toContain('No reachable parks');
    expect(html).not.toContain('Revenue today');
    const zero = Object.fromEntries(Object.keys(totals).map((key) => [key, 0])) as typeof totals;
    expect(markup({ ...snapshot, totals: zero })).toContain('Revenue today');
  });
});

describe('Overview v2 returned source contracts', () => {
  it('renders the five new source groups with explicit calendar and current-snapshot dates while retaining business dates', () => {
    const html = markup(snapshot);
    for (const label of ['Members &amp; visits', 'Booking activity', 'Internal assistant', 'Inbox AI', 'Fleet', 'Needs a decision']) expect(html).toContain(label);
    expect(html).toContain('2026-10-23'); expect(html).toContain('Bangkok calendar');
    expect(html).toContain('Business date 2026-10-22'); expect(html).toContain('Visiting members');
    expect(html).toContain('Priced booking value'); expect(html).toContain('Redeemed bookings');
    expect(html).toContain('Current snapshot'); expect(html).toContain('Copy status summary');
    expect(html).not.toContain('Registered members');
  });

  it('labels unavailable USD estimates and their unpriced remainder rather than rendering null as free usage', () => {
    const html = markup(snapshot);
    expect(html).toContain('Price unavailable'); expect(html).toContain('USD');
    expect(html).toContain('no_rate_configured'); expect(html).toContain('20 unpriced tokens'); expect(html).toContain('excludes cache writes');
    expect(html).not.toContain('USD 0.00');
    const priced = structuredClone(snapshot);
    priced.aggregates.assistantUsage.totals.spendEstimate = 0.0123;
    priced.aggregates.assistantUsage.totals.reason = 'unpriced_tokens';
    priced.aggregates.assistantUsage.totals.unpricedTokens = 3;
    const future = markup(priced);
    expect(future).toContain('USD'); expect(future).toContain('0.0123'); expect(future).toContain('3 unpriced tokens');
  });

  it('keeps available zero, unavailable cash and unbuilt requests distinct without inventing an overdue-person meaning', () => {
    const html = markup(snapshot);
    expect(html).toContain('Open sync quarantine'); expect(html).toContain('Cash variance lines');
    expect(html).toContain('Unavailable'); expect(html).toContain('Erasure requests'); expect(html).toContain('Not built');
    expect(html).toContain('End-of-day review rows still inside'); expect(html).not.toContain('Overdue people');
    expect(html).not.toContain('No decisions needed');
  });
});
