import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SaleWriteFailure } from '@/components/till/SaleWriteStatus';
import type { SaleWriteState } from '@/lib/saleWriter';

/**
 * SCRUM-502 — the sale panel's explainer follows the lane.
 *
 * When the counter's box refuses the money press for the last prepaid meal, the
 * headline ("The payment has not been recorded.") and the refusal's own words
 * were right, but the lines around them said the order was saved on the
 * platform as unpaid and that the platform had refused it. On the box lane
 * neither is true: the box refused, and a sale rung up there is held on this
 * till alone until it is paid. The writer now marks who answered (`answeredBy`)
 * and where the order is (`heldOn`); the panel says each in its own words and
 * leaves everything else as it was.
 */
// The panel's JSX compiles to `React.createElement` here (see stock-r4-sale-panel.test.ts).
Object.assign(globalThis, { React });

const html = (state: SaleWriteState) =>
  renderToStaticMarkup(React.createElement(SaleWriteFailure, { state, onRetry: () => {}, onDismiss: () => {} }))
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');

const USED_UP = "Mint's prepaid Hot dog has already been served.";

const failed = (over: Partial<Extract<SaleWriteState, { kind: 'failed' }>> = {}): SaleWriteState => ({
  kind: 'failed',
  saleId: 'sale-1',
  stage: 'finalise',
  cause: 'refused',
  message: USED_UP,
  code: 'PREPAID_USED_UP',
  retryable: false,
  ...over,
});

describe('the sale panel after a refused money press', () => {
  it('box lane: the box refused, and the order is on this till only — never "saved on the platform" nor "the platform looked"', () => {
    const out = html(failed({ answeredBy: 'box', heldOn: 'till' }));
    expect(out).toContain('The payment has not been recorded.');
    expect(out).toContain(USED_UP);
    expect(out).toContain(
      'The order is held on this till only, unpaid and without a receipt number — none of it has reached the platform.',
    );
    expect(out).toContain('this counter’s box looked at this sale and refused it.');
    expect(out).toContain('call a manager if it still refuses');
    expect(out).not.toContain('saved on the platform');
    expect(out).not.toContain('the platform looked at this sale');
    expect(out).not.toContain('Try again');
  });

  it('rung up on the platform, its cash press refused by the box: the platform holds the order, the box said no', () => {
    const out = html(failed({ answeredBy: 'box' }));
    expect(out).toContain('The order itself is saved on the platform, as unpaid and without a receipt number.');
    expect(out).toContain('this counter’s box looked at this sale and refused it.');
    expect(out).not.toContain('the platform looked at this sale');
  });

  it('refused by the platform: the words it always had', () => {
    const out = html(failed());
    expect(out).toContain('The payment has not been recorded.');
    expect(out).toContain('The order itself is saved on the platform, as unpaid and without a receipt number.');
    expect(out).toContain('the platform looked at this sale and refused it.');
    expect(out).not.toContain('counter’s box');
  });

  it('a commit the box refused: not saved, and the box named', () => {
    const out = html(failed({ stage: 'commit', answeredBy: 'box' }));
    expect(out).toContain('This sale has not been saved.');
    expect(out).toContain('this counter’s box looked at this sale and refused it.');
    expect(out).not.toContain('saved on the platform');
  });
});
