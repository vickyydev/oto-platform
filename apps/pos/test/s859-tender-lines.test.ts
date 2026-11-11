import { describe, expect, it, vi } from 'vitest';
import type { DisplayPayment } from '@oto/shared';
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...await import('./support/hooks') }));
vi.mock('@/lib/payments', () => ({ paymentMethodKind: (method: string) => method === 'promptpay' ? 'qr' : method }));
import { useTenderPresentation } from '@/lib/tenderDisplay';
import type { StationDisplayState } from '@/lib/displaySession';
import { renderHook } from './support/hooks';

/**
 * SCRUM-859 — THE TENDER NAMES ITS LINE ON THE PAIRED DISPLAY.
 *
 * The extra-hour charge and the event pass hand the display the line the
 * family is paying for; it rides on the tender cart as an optional field, so a
 * caller with none (the party balance) publishes exactly what it published
 * before, and a line the schema cannot read is left off rather than sent.
 */
const payment: DisplayPayment = { saleId: 'sale-t', amountSatang: 60_000, qrPayload: 'ZZ TEST gateway payload', qrImageUrl: null,
  expiresAt: '2026-11-12T00:00:00.000Z', status: 'pending', offline: false, online: true };
const line = { label: '+1 hour', qty: 2, unitPrice: 300, lineTotal: 600 };

describe('SCRUM-859 the tender presentation carries its lines', () => {
  it('the extra hour and the event pass publish their line on the cart', () => {
    const handover = vi.fn((_state: StationDisplayState) => vi.fn());
    const hook = renderHook((lines?: typeof line[]) => useTenderPresentation(handover, 'extra_hour', 'promptpay', payment, true, lines), [line]);
    expect(handover).toHaveBeenCalledOnce();
    expect(handover.mock.calls[0]![0].presentation('')).toEqual({ stage: 'payment', step: null, payment, member: null, totals: null, prompt: null,
      cart: { kind: 'tender', supported: true, subject: 'extra_hour', method: 'qr', lines: [line] } });
    // The same line again is the same frame: nothing is reclaimed.
    hook.rerender([{ ...line }]);
    expect(handover).toHaveBeenCalledOnce();
    // A changed line (one more child) is a new frame.
    hook.rerender([{ ...line, qty: 3, lineTotal: 900 }]);
    expect(handover).toHaveBeenCalledTimes(2);
    expect(handover.mock.calls[1]![0].presentation('').cart).toMatchObject({ lines: [{ qty: 3, lineTotal: 900 }] });
    hook.unmount();
  });

  it('no lines, an empty list and a line the schema refuses all publish the cart exactly as before', () => {
    for (const lines of [undefined, [], [{ ...line, qty: 0 }], [{ ...line, lineTotal: -1 }]]) {
      const handover = vi.fn((_state: StationDisplayState) => vi.fn());
      const hook = renderHook(() => useTenderPresentation(handover, 'party_balance', 'promptpay', payment, true, lines), undefined);
      expect(handover).toHaveBeenCalledOnce();
      expect(handover.mock.calls[0]![0].presentation('').cart).toEqual({ kind: 'tender', supported: true, subject: 'party_balance', method: 'qr' });
      hook.unmount();
    }
  });
});
