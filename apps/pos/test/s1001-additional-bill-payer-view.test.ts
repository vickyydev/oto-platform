import * as React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdditionalBillSummary } from '@/components/parties/AdditionalBillSummary';
import { PartySettlementCustomerScreen } from '@/components/parties/PartySettlementCustomerScreen';
import { LanguageProvider } from '@/i18n/LanguageContext';
import { additionalBillName, additionalBillParty } from '@/lib/partyAdditionalBills';
import { partySettlementLine } from '@/lib/partySettlementBill';
import type { PartyBooking } from '@/types';
import { billOne, billTwo, settledParty as party } from './support/party-additional-bills';

/**
 * SCRUM-1001 (the till's half) — THE GUEST PAYING AN ADDITIONAL BILL SEES THAT
 * BILL ONLY. The owner, 18 November: the party attendees do not need to see
 * the total party bill, which the parents already paid — the invited families
 * order extras of their own. So what the customer is shown for an additional
 * bill (the counter's customer display, the phone's "show the bill to the
 * customer", the payment step's summary) is the bill's own lines and its own
 * amount: never the package, the add-ons, the deposit, the first receipt,
 * another bill's lines or a whole-party total. The staff party pages keep a
 * short "Party settled · Receipt" line, now the same on both tills.
 */

Object.assign(globalThis, { React });

const text = (el: React.ReactElement) =>
  renderToStaticMarkup(React.createElement(LanguageProvider, { children: el }))
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** What must never reach the guest paying bill 2: the main bill, the package, the first receipt, bill 1, a whole-party total. */
const MAIN_BILL = ['ZZ TEST Birthday Package', 'Party package', 'ZZ TEST balloon arch', 'Less deposit paid', 'T1-000089', 'ZZ TEST dish A', '4990', '1000', '25.03', '32.08', '350', 'This party is fully paid'];

const customer = (stage: 'review' | 'payment' | 'thankyou', shown = additionalBillParty(party, billTwo.id), amount = 7.05) =>
  text(React.createElement(PartySettlementCustomerScreen, { stage, party: shown, amount, method: 'cash', billName: additionalBillName(party.additionalBills, billTwo.id) ?? undefined }));

describe('SCRUM-1001 — the customer’s view of an additional bill is that bill only', () => {
  it('review (the counter’s customer display and the phone’s "show the bill"): the bill’s name, its own line and amount', () => {
    const shown = customer('review');
    expect(shown).toContain('Additional bill 2');
    expect(shown).toContain('ZZ TEST drink B ฿7.05');
    expect(shown).toContain('Total ฿7.05');
    expect(shown).toContain('Outstanding due now ฿7.05');
    for (const leak of MAIN_BILL) expect(shown).not.toContain(leak);
    // The bill's name stands alone: no "฿0" beside it, where the package's price stood.
    expect(shown).not.toContain('Additional bill 2 ฿');
  });

  it('payment and thank-you: the bill’s amount, and no word that the whole party is paid', () => {
    const paying = customer('payment');
    expect(paying).toContain('฿7.05');
    for (const leak of MAIN_BILL) expect(paying).not.toContain(leak);
    const paid = { ...party, additionalBills: [billOne, { ...billTwo, state: 'paid', paidSatang: 705, outstandingSatang: 0, payments: [{ ...billOne.payments[0]!, id: 'pay-b', amountSatang: 705 }] }],
      partyPayments: [...party.partyPayments, { id: 'pay-b', amount: 7.05, method: 'cash', takenBy: 'ZZ TEST staff', takenById: 'staff', takenAt: '2026-11-18T12:20:00Z' }] } as unknown as PartyBooking;
    const thanks = customer('thankyou', additionalBillParty(paid, billTwo.id));
    expect(thanks).toContain('All settled!');
    expect(thanks).toContain('Paid now ฿7.05');
    expect(thanks).toContain('Outstanding ฿0');
    for (const leak of MAIN_BILL) expect(thanks).not.toContain(leak);
  });

  it('the payment step’s summary, the same on both tills: the bill’s lines, total and what is left', () => {
    const summary = text(React.createElement(AdditionalBillSummary, { bill: billTwo, name: 'Additional bill 2' }));
    expect(summary).toBe('Additional bill 2 1 x ZZ TEST drink B ฿7.05 Total ฿7.05 Outstanding ฿7.05');
    const part = text(React.createElement(AdditionalBillSummary, { bill: { ...billTwo, paidSatang: 205, outstandingSatang: 500 }, name: 'Additional bill 2' }));
    expect(part).toContain('Payments taken −฿2.05');
    expect(part).toContain('Outstanding ฿5');
    // A charge taken for less than its lines reconciles on the summary.
    const discounted = text(React.createElement(AdditionalBillSummary, { bill: { ...billTwo, totalSatang: 600, outstandingSatang: 600 }, name: 'Additional bill 2' }));
    expect(discounted).toContain('Discount −฿1.05');
    expect(discounted).toContain('Total ฿6');
    for (const leak of MAIN_BILL) expect(summary + part + discounted).not.toContain(leak);
  });

  it('a main-bill settlement (no bill named) still shows the package, add-ons and deposit as before', () => {
    const main = { ...party, additionalBills: [], partyExtraCharges: [], partyPayments: [] } as unknown as PartyBooking;
    const shown = text(React.createElement(PartySettlementCustomerScreen, { stage: 'review', party: main, amount: 4340, method: 'cash' }));
    for (const words of ['ZZ TEST Birthday Package ฿4990', 'Less deposit paid −฿1000', 'Outstanding due now ฿4340']) {
      expect(shown).toContain(words);
    }
    const paid = text(React.createElement(PartySettlementCustomerScreen, { stage: 'thankyou', party: { ...main, deposit: 5340 } as PartyBooking, amount: 4340, method: 'cash' }));
    expect(paid).toContain('This party is fully paid');
  });
});

describe('SCRUM-1001 — the staff party pages say the main bill is settled the same way on both tills', () => {
  it('a settled party names its receipt; an open settlement what is left; none before a settlement', () => {
    expect(partySettlementLine(party.settlement)).toEqual({ label: 'Party settled', value: 'Receipt T1-000089' });
    expect(partySettlementLine({ ...party.settlement!, state: 'open', outstandingSatang: 13900 })).toEqual({ label: 'Settlement open', value: '฿139 to take' });
    expect(partySettlementLine(undefined)).toBeNull();
    expect(partySettlementLine({ ...party.settlement!, state: 'voided' } as unknown as PartyBooking['settlement'])).toBeNull();
  });

  it('the counter and phone party pages both draw that line, so the phone no longer names the package at ฿0 once settled', () => {
    for (const file of ['components/parties/PartyDetail.tsx', 'components/mobile/parties/MobilePartyDetail.tsx']) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(source).toContain('partySettlementLine(');
      expect(source).toMatch(/settlementLine \? \(\s*<InfoRow icon=\{CheckCircle2\} label=\{settlementLine\.label\} value=\{settlementLine\.value\} \/>/);
    }
  });
});
