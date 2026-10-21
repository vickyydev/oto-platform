import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import { describe, expect, it } from 'vitest';
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
const snapshot: OverviewSnapshot = {
  generatedAt: '2026-10-22T06:00:00.000Z', branches: [park], selectedBranchIds: [park.id], totals,
  parks: [{
    branchId: park.id, businessDate: park.businessDate, ...totals,
    analyticsSource: 'oto_pos', provisional: true, lastRolledUpAt: '2026-10-22T05:55:00.000Z',
    occupancyAsOf: '2026-10-22T05:59:30.000Z', occupancyStale: true,
  }],
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
