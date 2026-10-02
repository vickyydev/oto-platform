import { describe, expect, it } from 'vitest';
import {
  allocateRefund,
  refundStatusOf,
  refundableSatang,
  resolveRefundAmount,
  restockLineIds,
  type RefundableTender,
} from '../src/index';

/**
 * Refunds (S2-11): the prototype's clamp and status walk, and the allocation
 * the plan adds — wallet, then the same tender, then cash.
 */

const tender = (over: Partial<RefundableTender>): RefundableTender => ({
  attemptId: 'a',
  method: 'cash',
  methodCode: 'cash',
  provider: 'manual',
  channel: 'cash',
  amountSatang: 100_00,
  refundedSatang: 0,
  paidAt: '2026-09-30T05:00:00.000Z',
  ...over,
});

describe('the amount — never more than is left (mockApi.ts:recordRefund)', () => {
  it('whole refunds everything left', () => {
    expect(resolveRefundAmount({ mode: 'whole', remainingSatang: 700_00 })).toEqual({
      amountSatang: 700_00,
      requestedSatang: 700_00,
      clamped: false,
    });
  });

  it('clamps a custom amount and an item total to what is left, and says so', () => {
    expect(resolveRefundAmount({ mode: 'custom', remainingSatang: 300_00, customSatang: 500_00 })).toEqual({
      amountSatang: 300_00,
      requestedSatang: 500_00,
      clamped: true,
    });
    expect(resolveRefundAmount({ mode: 'items', remainingSatang: 300_00, itemsSatang: 200_00 }).amountSatang).toBe(
      200_00,
    );
  });

  it('walks paid → partially_refunded → refunded', () => {
    expect(refundStatusOf(1000, 0)).toBe('none');
    expect(refundStatusOf(1000, 400)).toBe('partially_refunded');
    expect(refundStatusOf(1000, 1000)).toBe('refunded');
    expect(refundableSatang(1000, 1200)).toBe(0);
  });
});

describe('the allocation — wallet, then the same tender newest first, then cash', () => {
  it('sends a whole card tender back through the terminal as a void', () => {
    const [slice] = allocateRefund(500_00, [
      tender({ attemptId: 'card', method: 'card', channel: 'terminal', terminalTender: 'card', amountSatang: 500_00 }),
    ]);
    expect(slice).toMatchObject({ attemptId: 'card', route: 'terminal_void', status: 'pending', amountSatang: 500_00 });
  });

  it('hands back part of a card tender, and a terminal QR, in cash', () => {
    const part = allocateRefund(100_00, [
      tender({ attemptId: 'card', method: 'card', channel: 'terminal', terminalTender: 'card', amountSatang: 500_00 }),
    ]);
    expect(part).toMatchObject([{ attemptId: 'card', route: 'cash', status: 'done', amountSatang: 100_00 }]);
    const qr = allocateRefund(500_00, [
      tender({ attemptId: 'tqr', method: 'qr', channel: 'terminal', terminalTender: 'qr', amountSatang: 500_00 }),
    ]);
    expect(qr[0]!.route).toBe('cash');
  });

  it('sends a gateway QR back through the gateway, a part of it included', () => {
    const [slice] = allocateRefund(120_00, [
      tender({ attemptId: 'gw', method: 'qr', channel: 'gateway', provider: '2c2p', amountSatang: 500_00 }),
    ]);
    expect(slice).toMatchObject({ route: 'gateway_refund', status: 'pending', amountSatang: 120_00 });
  });

  it('takes wallets first, then the newest tender, and never more than a tender took', () => {
    const plan = allocateRefund(900_00, [
      tender({ attemptId: 'cash-early', amountSatang: 300_00, paidAt: '2026-09-30T05:00:00.000Z' }),
      tender({
        attemptId: 'card-late',
        method: 'card',
        channel: 'terminal',
        terminalTender: 'card',
        amountSatang: 400_00,
        paidAt: '2026-09-30T05:05:00.000Z',
      }),
      tender({ attemptId: 'wallet', method: 'wallet', channel: 'wallet', amountSatang: 100_00, paidAt: null }),
    ]);
    expect(plan.map((e) => [e.attemptId, e.route, e.amountSatang])).toEqual([
      ['wallet', 'wallet', 100_00],
      ['card-late', 'terminal_void', 400_00],
      ['cash-early', 'cash', 300_00],
      [null, 'cash', 100_00],
    ]);
  });

  it('does not send a second refund through what the first one already used', () => {
    const plan = allocateRefund(200_00, [
      tender({ attemptId: 'cash', amountSatang: 300_00, refundedSatang: 250_00 }),
    ]);
    expect(plan).toMatchObject([
      { attemptId: 'cash', amountSatang: 50_00 },
      { attemptId: null, amountSatang: 150_00 },
    ]);
  });
});

describe('restocking — which lines a refund returns (mockApi.ts:recordRefund)', () => {
  const all = ['l1', 'l2', 'l3'];
  it('a shop refund returns the picked lines, never twice, and a partial custom amount none', () => {
    expect(
      restockLineIds({ saleKind: 'merch', mode: 'items', scope: 'partial', coveredLineIds: ['l2'], allLineIds: all, alreadyRestocked: new Set(), earlierFullScope: false }),
    ).toEqual(['l2']);
    expect(
      restockLineIds({ saleKind: 'merch', mode: 'whole', scope: 'full', coveredLineIds: [], allLineIds: all, alreadyRestocked: new Set(['l2']), earlierFullScope: false }),
    ).toEqual(['l1', 'l3']);
    expect(
      restockLineIds({ saleKind: 'merch', mode: 'custom', scope: 'partial', coveredLineIds: [], allLineIds: all, alreadyRestocked: new Set(), earlierFullScope: false }),
    ).toEqual([]);
  });

  it('a ticket or food refund restocks on the first full-scope refund only', () => {
    expect(
      restockLineIds({ saleKind: 'ticket', mode: 'items', scope: 'partial', coveredLineIds: ['l1'], allLineIds: all, alreadyRestocked: new Set(), earlierFullScope: false }),
    ).toEqual([]);
    expect(
      restockLineIds({ saleKind: 'fnb', mode: 'whole', scope: 'full', coveredLineIds: [], allLineIds: all, alreadyRestocked: new Set(), earlierFullScope: false }),
    ).toEqual(all);
    expect(
      restockLineIds({ saleKind: 'fnb', mode: 'whole', scope: 'full', coveredLineIds: [], allLineIds: all, alreadyRestocked: new Set(), earlierFullScope: true }),
    ).toEqual([]);
  });
});

describe('prep tickets — one per printing station (lib/fnb.ts:buildPrepTickets)', () => {
  it('groups kitchen before bar, drops none, and sends an unset station to the kitchen', async () => {
    const { groupPrepTickets } = await import('../src/index');
    const tickets = groupPrepTickets([
      { id: 'beer', prepStation: 'bar' },
      { id: 'pizza', prepStation: 'kitchen' },
      { id: 'water', prepStation: 'none' },
      { id: 'fries', prepStation: null },
    ]);
    expect(tickets.map((t) => [t.station, t.title, t.lines.map((l) => l.id)])).toEqual([
      ['kitchen', 'Kitchen', ['pizza', 'fries']],
      ['bar', 'Bar', ['beer']],
    ]);
    expect(groupPrepTickets([{ id: 'water', prepStation: 'none' }])).toEqual([]);
  });
});
