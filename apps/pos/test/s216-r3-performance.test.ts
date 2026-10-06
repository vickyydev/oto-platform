import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsSummary, AnalyticsSummaryRow } from '@oto/shared';
import { api } from '@/api/client';
import { floorReportOf, getAnalyticsSummary } from '@/api/analytics';
import { PerformanceView } from '@/components/floor/PerformanceTab';
import { PerformanceScopePicker } from '@/components/floor/PerformanceScopePicker';
import { MobilePerformanceView } from '@/components/mobile/today/MobilePerformanceTab';

/**
 * S2-15b round 3 — Today > Performance drawn from the platform's answer: the
 * prototype's cards, words and five bars with the figures of the rolled-up
 * day; the provisional note and the last-updated line (UI additions); the
 * loading and refusal states; and the Branch choice with "All branches".
 */

Object.assign(globalThis, { React });

const markup = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

/** The text a person reads, tags dropped. */
const text = (el: React.ReactElement) => markup(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function row(over: Partial<AnalyticsSummaryRow> = {}): AnalyticsSummaryRow {
  return {
    ticketsSatang: 248_000,
    fnbSatang: 45_000,
    merchSatang: 12_000,
    partiesSatang: 0,
    dropoffSatang: 119_000,
    revenueSatang: 424_000,
    txnCount: 5,
    creditPaidSatang: 20_000,
    guestsKids: 3,
    guestsAdults: 2,
    mix1h: 1,
    mix2h: 2,
    mixFullDay: 2,
    partiesCount: 0,
    refundsSatang: 0,
    discountsSatang: 0,
    compsSatang: 0,
    vatSatang: 0,
    serviceSatang: 0,
    byChannel: {},
    businessDate: null,
    provisional: true,
    rolledDays: 1,
    computedAt: '2026-10-06T07:00:00.000Z',
    formulaVersion: 1,
    ...over,
  };
}

const performance = (over: Partial<AnalyticsSummaryRow> = {}, updatedAt: string | null = '2026-10-06T07:05:00.000Z') => {
  const r = row(over);
  return {
    report: floorReportOf(r, '2026-10-06', 'hkt-central'),
    provisional: r.provisional,
    updatedAt,
    timezone: 'Asia/Bangkok',
    error: null,
  };
};

describe('Today > Performance, from the platform', () => {
  it('draws the rolled-up day in the prototype’s cards and words', () => {
    const page = text(React.createElement(PerformanceView, { performance: performance(), dropOffInPark: 4, isToday: true }));
    expect(page).toContain('Revenue ฿4,240 5 transactions · excl. ฿200 paid via credit');
    expect(page).toContain('Guests checked in 5 3 kids · 2 adults');
    expect(page).toContain('Parties today 0 None booked');
    expect(page).toContain('Drop-off kids in park 4 In the park right now');
    // The five bars, in the prototype's order, with their share of revenue.
    expect(page).toContain('Revenue split Tickets ฿2,480 58% F&B ฿450 11% Merch ฿120 3% Parties ฿0 0% Drop-off ฿1,190 28%');
    expect(page).toContain('Ticket mix · guests by play length 1 1 hour 2 2 hours 2 Full day');
    expect(page).not.toContain('No sales recorded');
  });

  it('says the day is still being added up, and when it was last updated, in the park’s time', () => {
    const page = text(React.createElement(PerformanceView, { performance: performance(), dropOffInPark: 0, isToday: true }));
    expect(page).toContain('Provisional — still being added up · Updated 14:05');
    const ended = text(
      React.createElement(PerformanceView, {
        performance: performance({ provisional: false }, '2026-10-05T14:10:00.000Z'),
        dropOffInPark: 0,
        isToday: false,
      }),
    );
    expect(ended).not.toContain('Provisional');
    expect(ended).toContain('Updated 5 Oct, 21:10');
    expect(ended).toContain('Parties 0 None booked');
    const never = text(React.createElement(PerformanceView, { performance: performance({}, null), dropOffInPark: 0, isToday: true }));
    expect(never).toContain('Provisional — still being added up · Not updated yet');
  });

  it('an empty day keeps the prototype’s line; drop-off unread is "—"; no ticket mix is no card', () => {
    const empty = performance({
      ticketsSatang: 0,
      fnbSatang: 0,
      merchSatang: 0,
      dropoffSatang: 0,
      revenueSatang: 0,
      txnCount: 0,
      creditPaidSatang: 0,
      guestsKids: 0,
      guestsAdults: 0,
      mix1h: 0,
      mix2h: 0,
      mixFullDay: 0,
    });
    const page = text(React.createElement(PerformanceView, { performance: empty, dropOffInPark: null, isToday: true }));
    expect(page).toContain('No sales recorded for today yet.');
    expect(page).toContain('Drop-off kids in park — In the park right now');
    expect(page).not.toContain('Ticket mix');
    expect(page).not.toContain('paid via credit');
  });

  it('while the day is on its way, and when the platform refuses it', () => {
    const waiting = { report: null, provisional: false, updatedAt: null, timezone: null, error: null };
    expect(text(React.createElement(PerformanceView, { performance: waiting, dropOffInPark: null, isToday: true }))).toContain('Loading Performance…');
    const refused = { ...waiting, error: 'Missing permission pos:cash:read' };
    expect(text(React.createElement(PerformanceView, { performance: refused, dropOffInPark: null, isToday: true }))).toContain(
      'The figures could not be read from the platform — Missing permission pos:cash:read',
    );
  });

  it('the phone draws the same figures in its own words', () => {
    const page = text(React.createElement(MobilePerformanceView, { performance: performance(), dropOffInPark: 4, isToday: true }));
    expect(page).toContain('Provisional — still being added up · Updated 14:05');
    expect(page).toContain('Revenue ฿4,240 5 transactions · excl. ฿200 via credit');
    expect(page).toContain('Revenue split Tickets ฿2,480 58%');
    expect(page).toContain('Drop-off kids in park 4 In the park right now');
    expect(page).toContain('Ticket mix · guests by play length 1 1 hour 2 2 hours 2 Full day');
  });
});

describe('the platform’s answer, end to end', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the merged day the route answers is the day the tab draws', async () => {
    const HKT = '0192f000-0000-7000-8000-00000000b001';
    const DEMO = '0192f000-0000-7000-8000-00000000b002';
    const merged = row({ revenueSatang: 848_000, ticketsSatang: 496_000, fnbSatang: 90_000, merchSatang: 24_000, dropoffSatang: 238_000, txnCount: 10 });
    const get = vi.spyOn(api, 'get').mockResolvedValue({
      from: '2026-10-06',
      to: '2026-10-06',
      group: 'total',
      source: 'oto_pos',
      branches: [],
      omitted: [],
      readable: [
        { branchId: DEMO, name: 'Demo Branch 2' },
        { branchId: HKT, name: 'Oto Play Park, Central Floresta' },
      ],
      mergeable: [
        { branchId: DEMO, name: 'Demo Branch 2' },
        { branchId: HKT, name: 'Oto Play Park, Central Floresta' },
      ],
      merged: [merged],
      hours: null,
      lastRolledUpAt: '2026-10-06T07:05:00.000Z',
    } satisfies AnalyticsSummary);
    const answer = await getAnalyticsSummary({ from: '2026-10-06', to: '2026-10-06' });
    expect(get).toHaveBeenCalledWith('/analytics/summary?from=2026-10-06&to=2026-10-06&group=total');
    const page = text(
      React.createElement(PerformanceView, {
        performance: {
          report: floorReportOf(answer.merged[0]!, '2026-10-06', 'hkt-central'),
          provisional: true,
          updatedAt: answer.lastRolledUpAt,
          timezone: 'Asia/Bangkok',
          error: null,
        },
        dropOffInPark: 6,
        isToday: true,
      }),
    );
    expect(page).toContain('Revenue ฿8,480 10 transactions');
    expect(page).toContain('Tickets ฿4,960 58% F&B ฿900 11% Merch ฿240 3% Parties ฿0 0% Drop-off ฿2,380 28%');
  });
});

describe('the Branch choice', () => {
  it('offers this branch and All branches, drawn like the Date field', () => {
    const html = markup(
      React.createElement(PerformanceScopePicker, { branchName: 'Oto Play Park, Central Floresta', scope: 'all', onScope: () => {} }),
    );
    expect(html).toContain('Branch');
    expect(html).toContain('<option value="branch">Oto Play Park, Central Floresta</option>');
    expect(html).toContain('<option value="all" selected="">All branches</option>');
    expect(html).toContain('h-11 px-4 text-base');
    const compact = markup(
      React.createElement(PerformanceScopePicker, { branchName: 'Demo Branch 2', scope: 'branch', onScope: () => {}, compact: true }),
    );
    expect(compact).toContain('h-9 px-3 text-sm');
  });
});
