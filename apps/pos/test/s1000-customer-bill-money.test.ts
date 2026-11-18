import * as React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PartySettlementCustomerScreen } from '@/components/parties/PartySettlementCustomerScreen';
import { LanguageProvider } from '@/i18n/LanguageContext';
import type { PartyBooking } from '@/types';
import { settledParty } from './support/party-additional-bills';

/**
 * SCRUM-1000 — THE CUSTOMER'S PARTY BILL WRITES EVERY AMOUNT AS MONEY.
 *
 * The phone till's "show the bill to the customer" (and the counter's
 * customer half) printed each figure as the raw number it held: on staging it
 * read "Outstanding due now 7.049999999999997". The sum is now exact
 * (`lib/party.ts`, `s1000-phone-till-additional-bills.test.ts`), and the screen
 * hands every amount to the till's one money formatter (`bahtText`): a
 * whole-baht amount reads as it always has ("฿4990"), one with satang shows its
 * two places ("฿12.50").
 */

Object.assign(globalThis, { React });

const text = (el: React.ReactElement) =>
  renderToStaticMarkup(React.createElement(LanguageProvider, { children: el }))
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tab = { ...settledParty, basePrice: 0, deposit: 0, lineItems: [], packageName: undefined } as unknown as PartyBooking;

describe('SCRUM-1000 — the customer screen writes every amount as money', () => {
  it('the older tab’s balance reads ฿7.05, never 7.0499…', () => {
    const shown = text(React.createElement(PartySettlementCustomerScreen, { stage: 'review', party: tab, amount: 7.05, method: 'cash' }));
    expect(shown).toContain('Outstanding due now ฿7.05');
    expect(shown).toContain('Total ฿32.08');
    expect(shown).not.toContain('7.0499');
  });

  it('a part payment and what it leaves keep their two places', () => {
    const half = text(React.createElement(PartySettlementCustomerScreen, { stage: 'payment', party: { ...tab, partyPayments: [] } as PartyBooking, amount: 12.5, method: 'cash' }));
    expect(half).toContain('฿12.50');
    expect(half).toContain('฿19.58'); // ฿32.08 less ฿12.50
  });

  it('a whole-baht bill reads as it always has', () => {
    const main = { ...settledParty, partyExtraCharges: [], partyPayments: [] } as unknown as PartyBooking;
    const shown = text(React.createElement(PartySettlementCustomerScreen, { stage: 'review', party: main, amount: 4340, method: 'cash' }));
    for (const words of ['ZZ TEST Birthday Package ฿4990', 'ZZ TEST balloon arch ฿350', 'Total ฿5340', 'Less deposit paid −฿1000', 'Outstanding due now ฿4340']) {
      expect(shown).toContain(words);
    }
  });

  it('no raw number is printed after a baht sign on that screen', () => {
    const source = readFileSync(new URL('../src/components/parties/PartySettlementCustomerScreen.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/฿\$\{(?!bahtText\()/);
    expect(source).not.toMatch(/฿\{(?!bahtText\()/);
  });
});
