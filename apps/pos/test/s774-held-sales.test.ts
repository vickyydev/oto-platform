import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EodOpenSales, HeldSale } from '@oto/shared';
import { api } from '@/api/client';
import { heldSalesApi } from '@/api/heldSales';
import { HeldSalesPanel, HoldSaleButtons } from '@/components/till/HeldSales';
import { OpenSalesCard } from '@/components/eod/OpenSalesCard';
import { holdButtonReasons, type HeldSalesState } from '@/lib/heldSales';

/**
 * SCRUM-774 — the till's Hold sale and Save as partly paid, its Held sales
 * list, and the End of Day's count and refusal: every button that is shut says
 * why underneath it, and every refusal is shown in words.
 */
Object.assign(globalThis, { React });

afterEach(() => {
  vi.restoreAllMocks();
});

const markup = (el: React.ReactElement): string => renderToStaticMarkup(el);
const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

const base = {
  saleId: '0192f000-0000-7000-8000-00000000d001',
  online: true,
  paymentInProgress: false,
  paidSatang: 0,
  outstandingSatang: 55_000,
  canHold: true,
};

describe('holdButtonReasons — each payment-step button says why it is shut', () => {
  it('nothing paid: Hold sale can be pressed, Save as partly paid asks for a part payment first', () => {
    expect(holdButtonReasons(base)).toEqual({
      hold: null,
      partPaid: 'Take a part payment first — nothing has been paid on this sale yet.',
    });
  });

  it('part paid: Save as partly paid can be pressed, Hold sale names the money taken', () => {
    expect(holdButtonReasons({ ...base, paidSatang: 20_000, outstandingSatang: 35_000 })).toEqual({
      hold: '฿200 has been paid on this sale — use Save as partly paid.',
      partPaid: null,
    });
  });

  it('offline, mid-payment, unsaved, owing nothing or without the role: both shut, with the reason', () => {
    expect(holdButtonReasons({ ...base, online: false }).hold).toBe(
      'Holding a sale needs the connection — reconnect, or take the payment now.',
    );
    expect(holdButtonReasons({ ...base, paymentInProgress: true }).partPaid).toBe(
      'A payment is in progress — finish or cancel it first.',
    );
    expect(holdButtonReasons({ ...base, saleId: null }).hold).toBe('The sale is still being saved — wait a moment.');
    expect(holdButtonReasons({ ...base, outstandingSatang: 0 }).hold).toBe(
      'Nothing is owed on this sale — complete it instead.',
    );
    expect(holdButtonReasons({ ...base, canHold: false }).hold).toBe('Your role cannot hold sales — ask a manager.');
  });

  it('draws the reason under the shut button', () => {
    const html = markup(
      React.createElement(HoldSaleButtons, {
        holdReason: null,
        partPaidReason: 'Take a part payment first — nothing has been paid on this sale yet.',
        onHold: () => undefined,
        onSavePartPaid: () => undefined,
      }),
    );
    expect(html).toContain('Hold sale');
    expect(html).toContain('Save as partly paid');
    expect(html).toContain('Take a part payment first — nothing has been paid on this sale yet.');
  });
});

const sale = (over: Partial<HeldSale>): HeldSale => ({
  holdId: '0192f000-0000-7000-8000-00000000e001',
  saleId: '0192f000-0000-7000-8000-00000000d002',
  branchId: '0192f000-0000-7000-8000-00000000b001',
  kind: 'held',
  label: 'ZZ TEST Khun Anna',
  note: 'Back after lunch',
  grossSatang: 55_000,
  paidSatang: 0,
  balanceSatang: 55_000,
  businessDate: '2026-11-04',
  heldAt: '2026-11-04T07:05:00.000Z',
  heldBy: { accountId: '0192f000-0000-7000-8000-00000000a002', name: 'Som' },
  heldStation: { id: '0192f000-0000-7000-8000-00000000c001', name: 'Reception Till 1' },
  flaggedAt: null,
  ...over,
});

const state = (sales: HeldSale[]): HeldSalesState => ({
  sales,
  counts: {
    held: sales.filter((s) => s.kind === 'held').length,
    partPaid: sales.filter((s) => s.kind === 'part_paid').length,
  },
  error: null,
  loaded: true,
  refresh: () => undefined,
});

const noop = () => undefined;

describe('the Held sales list on the till', () => {
  it('shows each sale with its name, money, who held it where, and the counts', () => {
    const html = markup(
      React.createElement(HeldSalesPanel, {
        held: state([
          sale({}),
          sale({
            holdId: '0192f000-0000-7000-8000-00000000e002',
            saleId: '0192f000-0000-7000-8000-00000000d003',
            kind: 'part_paid',
            label: 'ZZ TEST Khun Ben',
            note: null,
            paidSatang: 20_000,
            balanceSatang: 35_000,
            flaggedAt: '2026-11-04T17:00:00.000Z',
          }),
        ]),
        timeZone: 'Asia/Bangkok',
        busyId: null,
        refusal: null,
        actionsFor: () => ({ resumeReason: null, voidReason: null, refundReason: null }),
        onResume: noop,
        onVoid: noop,
        onRefund: noop,
        onDismissRefusal: noop,
      }),
    );
    expect(html).toContain('1 held · 1 partly paid');
    expect(html).toContain('ZZ TEST Khun Anna');
    expect(html).toContain('฿550 to pay');
    expect(html).toContain('Held by Som at Reception Till 1 · 14:05');
    expect(html).toContain('Back after lunch');
    expect(html).toContain('฿200 paid · balance ฿350');
    expect(html).toContain('Resume — take the balance');
    expect(html).toContain('Cancel and refund');
    expect(html).toContain('Flagged for the manager');
  });

  it('writes the reason under a shut action, and the platform’s refusal in words', () => {
    const html = markup(
      React.createElement(HeldSalesPanel, {
        held: state([sale({})]),
        busyId: null,
        refusal: 'This sale was already taken back to Counter 2 by Som — it is no longer in Held sales.',
        actionsFor: () => ({
          resumeReason: 'Finish or cancel the sale on screen first.',
          voidReason: 'Voiding needs the void permission — ask a manager.',
          refundReason: null,
        }),
        onResume: noop,
        onVoid: noop,
        onRefund: noop,
        onDismissRefusal: noop,
      }),
    );
    expect(html).toContain('Finish or cancel the sale on screen first.');
    expect(html).toContain('Voiding needs the void permission — ask a manager.');
    expect(html).toContain('This sale was already taken back to Counter 2 by Som — it is no longer in Held sales.');
  });
});

describe('what the till sends', () => {
  it('holds with the press as its action id and key, resumes the same way, and reads the branch’s list', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({} as never);
    const get = vi.spyOn(api, 'get').mockResolvedValue({} as never);
    await heldSalesApi.hold('sale-1', { kind: 'part_paid', label: 'Khun Ben', note: null, actionId: 'press-1' });
    expect(post).toHaveBeenCalledWith(
      '/sales/sale-1/hold',
      { kind: 'part_paid', label: 'Khun Ben', note: null, actionId: 'press-1' },
      { idempotencyKey: 'hold:sale-1:press-1', headers: { 'x-oto-action-id': 'press-1' } },
    );
    await heldSalesApi.resume('sale-1', 'press-2');
    expect(post).toHaveBeenLastCalledWith(
      '/sales/sale-1/resume',
      { actionId: 'press-2' },
      { idempotencyKey: 'resume:sale-1:press-2', headers: { 'x-oto-action-id': 'press-2' } },
    );
    await heldSalesApi.list('branch-1');
    expect(get).toHaveBeenCalledWith('/sales/held?branchId=branch-1');
  });

  it('never offers a held sale back to the screen that rang it up', () => {
    expect(src('lib/leftBehindSale.ts')).toMatch(/!ownsRef\.current\(s\.id\) && !s\.hold\)/);
  });
});

const openSales = (over: Partial<EodOpenSales> = {}): EodOpenSales => ({
  held: 1,
  partPaid: 1,
  rows: [
    {
      saleId: '0192f000-0000-7000-8000-00000000d002',
      kind: 'held',
      label: 'ZZ TEST Khun Anna',
      held: true,
      stationName: 'Reception Till 1',
      grossSatang: 55_000,
      paidSatang: 0,
      balanceSatang: 55_000,
      flaggedAt: null,
    },
    {
      saleId: '0192f000-0000-7000-8000-00000000d003',
      kind: 'part_paid',
      label: 'ZZ TEST Khun Ben',
      held: true,
      stationName: 'Reception Till 1',
      grossSatang: 55_000,
      paidSatang: 20_000,
      balanceSatang: 35_000,
      flaggedAt: null,
    },
  ],
  ...over,
});

describe('the End of Day shows the counts and why it cannot close', () => {
  it('shows held and part-paid counts and the refusal in the platform’s words', () => {
    const html = markup(React.createElement(OpenSalesCard, { openSales: openSales() }));
    expect(html).toContain('Held: <span class="font-semibold tabular-nums">1</span>');
    expect(html).toContain('Partly paid: <span class="font-semibold tabular-nums">1</span>');
    expect(html).toContain(
      'End of Day cannot close: 1 sale is partly paid — ZZ TEST Khun Ben (in Held sales), ฿200 paid, balance ฿350. ' +
        'Take the balance or refund what was paid, from Held sales on a till, then close the day.',
    );
  });

  it('says nothing stands in the way when only a held sale with no money is open', () => {
    const html = markup(
      React.createElement(OpenSalesCard, { openSales: openSales({ partPaid: 0, rows: openSales().rows.slice(0, 1) }) }),
    );
    expect(html).toContain('Held: <span class="font-semibold tabular-nums">1</span>');
    expect(html).not.toContain('cannot close');
  });

  it('the Close Day button carries its reason on both End of Day layouts', () => {
    for (const file of ['components/eod/EndOfDayTab.tsx', 'components/mobile/today/MobileEndOfDayTab.tsx']) {
      const text = src(file);
      expect(text).toContain('partPaidCloseRefusal(apiRecord.openSales?.rows ?? [])');
      expect(text).toContain('data-testid="close-day-blocked-reason"');
      expect(text).toContain('<OpenSalesCard openSales={apiRecord.openSales} />');
    }
  });
});
