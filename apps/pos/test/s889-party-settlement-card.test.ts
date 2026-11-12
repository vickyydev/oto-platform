import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LeftBehindSaleNotice } from '@/components/till/RedeemVoucher';

/**
 * SCRUM-889 — THE TICKETS TAB'S CARD FOR AN OPEN PARTY SETTLEMENT.
 *
 * A settlement left at its balance is listed with this till's unpaid sales
 * (`lib/leftBehindSale.ts`), and the card says where it is finished: "Party
 * settlement open — Resume on the party page", with the way there. It offers
 * no resume and no void — even when the till passes them — and names no
 * amount, because the sale's gross is not what is owed once the deposit is on
 * it. Every other unpaid sale keeps its card as before.
 */
// The card is compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });

const markup = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

const sale = {
  saleId: 'settlement-sale',
  stationName: 'Reception Till 1',
  occurredAt: '2026-11-12T04:14:00.000Z',
  grossSatang: 1_690_000,
};
const noop = () => undefined;

describe('the left-behind card for a party settlement', () => {
  it('sends staff to the party page and offers nothing to resume or void here', () => {
    const html = markup(
      createElement(LeftBehindSaleNotice, {
        sale: { ...sale, partySettlement: { eventId: 'party-event-1' } },
        onDismiss: noop,
        onVoid: noop,
        onResume: noop,
        onOpenParty: noop,
      }),
    );
    expect(html).toContain('Party settlement open — Resume on the party page');
    expect(html).toContain('data-testid="left-behind-party-settlement"');
    expect(html).toContain('Party settlement at Reception Till 1');
    expect(html).toContain('data-testid="open-party-page"');
    expect(html).toContain('Open the party page');
    expect(html).not.toContain('Resume this sale');
    expect(html).not.toContain('Void that unpaid sale');
    // The gross is not the balance once the deposit is on it: no amount on the card.
    expect(html).not.toContain('฿16900');
  });

  it('an ordinary unpaid sale keeps its own card: the resume and the void', () => {
    const html = markup(
      createElement(LeftBehindSaleNotice, { sale, onDismiss: noop, onVoid: noop, onResume: noop, onOpenParty: noop }),
    );
    expect(html).toContain('Your sale rung up at this till was left unpaid');
    expect(html).toContain('data-testid="left-behind-sale"');
    expect(html).toContain('Resume this sale');
    expect(html).toContain('Void that unpaid sale');
    expect(html).not.toContain('Open the party page');
  });
});
