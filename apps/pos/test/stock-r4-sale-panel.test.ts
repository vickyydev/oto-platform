import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BOX_STOCK_REFUSALS } from '@oto/shared';
import { SaleWriteFailure } from '@/components/till/SaleWriteStatus';
import type { SaleWriteState } from '@/lib/saleWriter';

/**
 * S2-14b ROUND 4 — handover Q1, the sale panel. A stock refusal from the
 * counter's box arrives at the money press, so the sale writer records it as a
 * failed FINALISE — and the panel used to say "The order itself is saved on the
 * platform, as unpaid", which on the box lane is false (the box saved nothing:
 * its own words say "Nothing was saved") and sent staff to a manager. It now
 * says the sale is not saved, the refusal verbatim, and what to change.
 */
// This runner compiles the panel's JSX to `React.createElement` (no React
// plugin here, `vitest.config.ts`), and the panel never imports React by name.
Object.assign(globalThis, { React });

const html = (state: SaleWriteState) =>
  renderToStaticMarkup(React.createElement(SaleWriteFailure, { state, onRetry: () => {}, onDismiss: () => {} }))
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');

const failed = (code: string, message: string): SaleWriteState => ({
  kind: 'failed',
  saleId: 'sale-1',
  stage: 'finalise',
  cause: 'refused',
  message,
  code,
  retryable: false,
});

describe('the sale panel on a stock refusal', () => {
  it('STOCK_SHORT at the box’s cash press: not saved, the words exactly, change the order — never "saved on the platform"', () => {
    const out = html(failed('STOCK_SHORT', 'Only 3 Grip Socks S left. Nothing was saved.'));
    expect(out).toContain('This sale has not been saved.');
    expect(out).toContain('Only 3 Grip Socks S left. Nothing was saved.');
    expect(out).toContain('Change the order — fewer, or another size — and press Pay again. Nothing was charged.');
    expect(out).not.toContain('saved on the platform');
    expect(out).not.toContain('call a manager');
    expect(out).not.toContain('Try again');
  });

  it('BOX_STOCK_STALE: the box’s sentence, and sell it when the connection is back', () => {
    const out = html(failed(BOX_STOCK_REFUSALS.stale.code, BOX_STOCK_REFUSALS.stale.message));
    expect(out).toContain(BOX_STOCK_REFUSALS.stale.message);
    expect(out).toContain('sell it when the connection is back');
    expect(out).not.toContain('saved on the platform');
  });

  it('any other refused payment keeps its old words', () => {
    const out = html(failed('PAYMENT_DECLINED', 'The card was declined.'));
    expect(out).toContain('The payment has not been recorded.');
    expect(out).toContain('The order itself is saved on the platform, as unpaid and without a receipt number.');
    expect(out).toContain('call a manager');
  });
});
