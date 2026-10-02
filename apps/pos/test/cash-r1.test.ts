import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CashDrawerView, CashSessionView } from '@oto/shared';
import { CashCountCard } from '@/components/eod/CashCountCard';
import { DrawerCountSection } from '@/components/eod/DrawerCountSection';
import { closeDrawer, getDrawer, openDrawer, recordDrawerMovement } from '@/api/cash';

/**
 * S2-15a round 1 — the till's drawer on real data (plan
 * docs/progress/plans/cash/PLAN.md §2.2): the prototype's cards keep their
 * words with satang under the hood and baht on screen, and the api module
 * sends what the platform's cash routes take.
 */
// The runner compiles JSX to `React.createElement` and the cards never import React by name.
Object.assign(globalThis, { React });

const html = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

function sessionView(over: Partial<CashSessionView> = {}): CashSessionView {
  return {
    id: 's-1',
    branchId: 'b-1',
    stationId: 'st-1',
    stationName: 'Reception Till 1',
    businessDate: '2026-10-02',
    status: 'open',
    openedAt: '2026-10-02T03:00:00.000Z',
    openedBy: { accountId: 'a-1', name: 'Som' },
    openingFloatSatang: 600_000,
    floatSource: null,
    floatSourceLabel: 'standard opening float (no prior close)',
    expected: {
      floatSatang: 600_000,
      cashInSatang: 150_050,
      refundOutSatang: 0,
      paidOutSatang: 0,
      safeDropSatang: 0,
      topUpSatang: 0,
      expectedSatang: 750_050,
    },
    toleranceSatang: 100,
    closedAt: null,
    closedBy: null,
    countedSatang: null,
    varianceSatang: null,
    floatLeftSatang: null,
    notes: null,
    signedOffAt: null,
    signedOffBy: null,
    movements: [],
    ...over,
  };
}

function drawerView(session: CashSessionView | null): CashDrawerView {
  return {
    station: { id: 'st-1', name: 'Reception Till 1', branchId: 'b-1', hasDrawer: true },
    session,
    lastClosed: null,
    carryOver: { floatSatang: 600_000, fromSessionId: null, fromDate: null, label: 'standard opening float (no prior close)' },
    settings: { defaultFloatSatang: 600_000, toleranceSatang: 100 },
  };
}

describe('CashCountCard — satang under the hood, baht on screen', () => {
  const card = (counted: number | null) =>
    html(
      React.createElement(CashCountCard, {
        countedSatang: counted,
        floatSatang: 600_000,
        expectedCashSatang: 150_050,
        floatSourceLabel: 'carried from 2026-10-01 close',
        drawerLabel: 'Reception Till 1 drawer',
        readOnly: false,
        onCounted: () => {},
      }),
    );

  it('awaits a count, with the carried float and its provenance', () => {
    const out = card(null);
    expect(out).toContain('Cash count');
    expect(out).toContain('· Reception Till 1 drawer');
    expect(out).toContain('฿6,000');
    expect(out).toContain('carried from 2026-10-01 close');
    expect(out).toContain('฿1,500.50');
    expect(out).toContain('awaiting count');
  });

  it('balanced within ฿1, over / short outside it', () => {
    expect(card(750_050 + 100)).toContain('balanced');
    const off = card(750_050 - 500);
    expect(off).toContain('over / short');
    expect(off).toContain('-฿5');
  });
});

describe('DrawerCountSection — the End of Day drawer part', () => {
  it('an open session shows its float, its expected take and the close action', () => {
    const out = html(React.createElement(DrawerCountSection, { view: drawerView(sessionView()) }));
    expect(out).toContain('Reception Till 1 drawer');
    expect(out).toContain('฿1,500.50');
    expect(out).toContain('Float left in drawer (for tomorrow)');
    expect(out).toContain('Count & close drawer');
  });

  it('no session today offers to open with the carried float; a past day does not', () => {
    expect(html(React.createElement(DrawerCountSection, { view: drawerView(null) }))).toContain('Open drawer · float ฿6,000');
    expect(html(React.createElement(DrawerCountSection, { view: drawerView(null), canOpen: false }))).not.toContain('Open drawer');
  });

  it('a closed session is read-only and says who counted it', () => {
    const out = html(
      React.createElement(DrawerCountSection, {
        view: drawerView(
          sessionView({
            status: 'closed',
            closedAt: '2026-10-02T13:00:00.000Z',
            closedBy: { accountId: 'a-2', name: 'Khun Lek' },
            countedSatang: 750_000,
            varianceSatang: -50,
            floatLeftSatang: 600_000,
          }),
        ),
      }),
    );
    expect(out).toContain('Drawer closed.');
    expect(out).toContain('Counted by Khun Lek');
    expect(out).not.toContain('Count & close drawer');
  });

  it('a counter with no drawer says so', () => {
    const view = { ...drawerView(null), station: { ...drawerView(null).station, hasDrawer: false } };
    expect(html(React.createElement(DrawerCountSection, { view }))).toContain('has no cash drawer');
  });
});

describe('api/cash — what the till sends', () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const stub = (body: unknown) => {
    calls.length = 0;
    vi.stubGlobal('window', { dispatchEvent: () => true });
    vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  };
  afterEach(() => vi.unstubAllGlobals());
  const headers = (i: number) => (calls[i]!.init.headers ?? {}) as Record<string, string>;

  it('reads the drawer, for today or a past business date', async () => {
    stub(drawerView(null));
    await getDrawer('st-1');
    await getDrawer('st-1', '2026-10-01');
    expect(calls.map((c) => c.url)).toEqual(['/api/stations/st-1/cash', '/api/stations/st-1/cash?date=2026-10-01']);
  });

  it('opens and closes with an idempotency key and one action id per press', async () => {
    stub({ replayed: false, session: sessionView() });
    await openDrawer('st-1');
    await closeDrawer('s-1', { countedSatang: 750_000, floatLeftSatang: 600_000, note: ' ' });
    expect(calls[0]!.url).toBe('/api/stations/st-1/cash/sessions');
    expect(headers(0)['idempotency-key']).toBeTruthy();
    expect(headers(0)['x-oto-action-id']).toBe(JSON.parse(String(calls[0]!.init.body)).actionId);
    expect(calls[1]!.url).toBe('/api/cash/sessions/s-1/close');
    const closeBody = JSON.parse(String(calls[1]!.init.body));
    expect(closeBody).toMatchObject({ countedSatang: 750_000, floatLeftSatang: 600_000 });
    expect(closeBody.note).toBeUndefined();
  });

  it('a paid-out carries the approver and NO idempotency key; a top-up carries a key and no second person', async () => {
    stub({ replayed: false, movement: {}, session: sessionView() });
    await recordDrawerMovement('s-1', {
      kind: 'paid_out',
      amountSatang: 2_000,
      reason: 'Ice',
      secondPerson: { phone: '+66900000004', password: 'manager1234' },
    });
    await recordDrawerMovement('s-1', { kind: 'top_up', amountSatang: 1_000, reason: 'Coins' });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ kind: 'paid_out', approver: { phone: '+66900000004' } });
    expect(headers(0)['idempotency-key']).toBeUndefined();
    expect(headers(0)['x-oto-action-id']).toBeTruthy();
    const topUp = JSON.parse(String(calls[1]!.init.body));
    expect(topUp.approver).toBeUndefined();
    expect(topUp.witness).toBeUndefined();
    expect(headers(1)['idempotency-key']).toBeTruthy();
  });
});
