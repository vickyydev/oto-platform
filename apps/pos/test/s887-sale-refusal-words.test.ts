import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SaleWriteFailure } from '@/components/till/SaleWriteStatus';
import { NetworkError } from '@/api/client';
import { GATE_SALE_BOX_NOT_SYNCED, gateSaleFailure } from '@/lib/gateOnline';
import type { SaleWriteState } from '@/lib/saleWriter';

/**
 * SCRUM-887 — THE SALE PANEL SAYS ONE THING WHEN THE BOX REFUSES A FAMILY THE
 * GATE WROTE ONLINE.
 *
 * Picture 05 of the first staging proof: the box refused the drop-off sale
 * ("Member not found", it had not pulled the guardian yet) and the panel read
 * "The box saved nothing and took no payment", then the no-answer paragraph
 * "Nothing answered, so this sale may already be saved". The box answered, so
 * the second half was false. A box refusal before any tender now reads as
 * nothing saved and no payment, with its own instruction; the no-answer
 * paragraph stays for the cases where nothing answered.
 */
// The panel's JSX compiles to `React.createElement` here (see stock-r4-sale-panel.test.ts).
Object.assign(globalThis, { React });

const html = (state: SaleWriteState) =>
  renderToStaticMarkup(React.createElement(SaleWriteFailure, { state, onRetry: () => {}, onDismiss: () => {} }))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const NO_ANSWER = 'Nothing answered, so this sale may already be saved';

/** The box's refusal of a family it has not pulled yet, as the sale writer records it. */
const boxRefused = (over: Partial<Extract<SaleWriteState, { kind: 'failed' }>> = {}): SaleWriteState => ({
  kind: 'failed',
  saleId: 'sale-887',
  stage: 'commit',
  cause: 'refused',
  message: 'Member not found',
  code: 'NOT_FOUND',
  retryable: false,
  answeredBy: 'box',
  ...over,
});

describe('SCRUM-887: the panel after the box refused a family the gate wrote online', () => {
  it('at Pay: nothing saved, no payment, wait and Try again — never "nothing answered, may already be saved"', () => {
    const shown = gateSaleFailure(boxRefused(), true);
    const out = html(shown);
    expect(out).toContain('This sale has not been saved.');
    expect(out).toContain(GATE_SALE_BOX_NOT_SYNCED);
    expect(out).toContain('The box saved nothing and took no payment.');
    expect(out).not.toContain(NO_ANSWER);
    expect(out).not.toContain('Nothing answered');
    expect(out).not.toContain('Trying again will not help');
    expect(out).not.toContain('Member not found');
    // The press the words name is on the panel.
    expect(out).toContain('Try again');
    expect(out).toContain('Back to the order');
    expect(out).toContain('Sale sale-887');
  });

  it('at the cash press: the order stays saved online unpaid, the box took nothing, and nothing says it may be paid', () => {
    const out = html(gateSaleFailure(boxRefused({ stage: 'finalise' }), true));
    expect(out).toContain('The payment has not been recorded.');
    expect(out).toContain('The order itself is saved on the platform, as unpaid and without a receipt number.');
    expect(out).toContain('The box saved nothing and took no payment.');
    expect(out).not.toContain(NO_ANSWER);
    expect(out).not.toContain('may already');
    expect(out).not.toContain('not yet confirmed');
  });

  it('a sale held on this till (rung up on the box) refused by the box reads as refused, not as a payment the box may hold', () => {
    const out = html(gateSaleFailure(boxRefused({ stage: 'finalise', heldOn: 'till' }), true));
    expect(out).toContain('The payment has not been recorded.');
    expect(out).toContain('The order is held on this till only, unpaid and without a receipt number');
    expect(out).not.toContain('The payment is not yet confirmed.');
    expect(out).not.toContain('may already');
  });

  it('a genuine no-answer keeps its paragraph', () => {
    const lost: SaleWriteState = {
      kind: 'failed',
      saleId: 'sale-887',
      stage: 'commit',
      cause: 'connection',
      message: new NetworkError().message,
      retryable: true,
    };
    const out = html(gateSaleFailure(lost, true));
    expect(out).toContain(NO_ANSWER);
    expect(out).toContain('Try again');
  });

  it('a family the gate did not write online keeps the box\'s own words and the refusal advice', () => {
    const out = html(gateSaleFailure(boxRefused(), false));
    expect(out).toContain('Member not found');
    expect(out).toContain('Trying again will not help');
    expect(out).not.toContain(NO_ANSWER);
  });
});
