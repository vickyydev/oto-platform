import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSaleBand } from '@/api/history';
import type { ApiWalletGrant } from '@/api/wallet';
import { CustomerDisplay } from '@/components/till/CustomerDisplay';
import { CREDIT_HEADING, StepConfirmation, type SaleIssue } from '@/components/till/StepConfirmation';
import { LanguageProvider } from '@/i18n/LanguageContext';
import { buildSale } from '@/lib/sale';
import { withPlatformCredit } from '@/lib/saleCredit';
import type { CartLine, DropOffLine, Sale, TicketType } from '@/types';

/**
 * SCRUM-931 — THE PAID SCREEN SAYS WHAT REALLY PRINTS.
 *
 * Two things the staging proofs of 12 November found (SCRUM-898, SCRUM-861,
 * SCRUM-857 parts 2-4):
 *
 *  1. "Credit Grants to Print · 1" on a sale with an adult, and no credit
 *     voucher job queued for it. Nothing is missing: since SCRUM-687 the
 *     credit prints ON the sale's one receipt, a CREDIT VOUCHER section per
 *     wallet, and no job of its own is queued (pinned by the api's
 *     wallet.test.ts). "To print" sent people looking for a slip; the column
 *     now says the grants were issued, in the prototype's own words.
 *  2. A drop-off sale: the till said "Bracelets to Print 0 total" while the
 *     customer display said "1 Child bracelet". The child does get a bracelet,
 *     printed at check-in on the drop-off bracelet printer (SCRUM-861), so the
 *     till lists and counts it and says it prints at check-in; the two screens
 *     now count the same bracelets.
 */

vi.mock('@/components/till/AddOnsGrid', () => ({ AddOnsGrid: () => null }));

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

const markup = (element: ReactElement): string => {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => 'en', setItem: () => undefined },
    location: { search: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return renderToStaticMarkup(createElement(LanguageProvider, null, element)).replace(/&#x27;/g, "'");
};

const play: TicketType = {
  id: '0190a0a0-0000-7000-8000-000000000931',
  name: '1 Hour Play',
  durationLabel: '1 Hour',
  hours: 1,
  prices: { tourist: { weekday: 420, weekend: 420 } },
  adultRules: { tourist: { kind: 'set_price', price: { weekday: 350, weekend: 350 } } },
  creditRule: { appliesTo: 'adults', basis: 'full_price' },
  gateAccess: true,
} as TicketType;

const SALE_ID = '0190a0a0-0000-7000-8000-0000000c0931';

const dropOff = (childName: string): DropOffLine =>
  ({
    registrationId: `reg-${childName}`,
    checkInId: `ci-${childName}`,
    childName,
    childAge: 6,
    service: 'drop_off',
    hours: 1,
    lengthChosen: true,
    serviceFeeTHB: 0,
  }) as unknown as DropOffLine;

function saleOf(lines: CartLine[]): Sale {
  return buildSale({ id: SALE_ID, operatorId: 'op', operatorName: 'OTO', tier: 'tourist', lines, paymentMethod: 'cash' });
}
const ordinary: CartLine = { id: 'line-family', ticketType: play, tier: 'tourist', kids: 1, adults: 1, socks: 0, addOns: [], lineTotal: 770 };
// A UUID, as the platform keys a supervised child's line by its stay.
const DROPOFF_LINE = '0190a0a0-0000-7000-8000-0000000a0931';
const droppedOff: CartLine = { id: DROPOFF_LINE, ticketType: play, tier: 'tourist', kids: 1, adults: 0, socks: 0, addOns: [], lineTotal: 420, dropOff: dropOff('ZZ TEST child') };

const issueOf = (over: Partial<SaleIssue> = {}): SaleIssue => ({
  number: { kind: 'receipt', number: 'T1-000931' },
  bands: [],
  lines: [],
  printJobs: [{ kind: 'receipt', status: 'queued', reprintOf: null } as unknown as NonNullable<SaleIssue['printJobs']>[number]],
  grants: [],
  issuedVouchers: [],
  ...over,
});

const staffHalf = (sale: Sale, issue: SaleIssue = issueOf()) =>
  markup(createElement(StepConfirmation, { sale, onNewSale: () => undefined, issue }));

const displayProps = {
  phone: '', nickname: '', member: null,
  onPhoneChange: () => undefined, onIdentify: () => undefined, onNicknameChange: () => undefined, onCustomerDone: () => undefined,
};
const customerHalf = (sale: Sale) => markup(createElement(CustomerDisplay, { ...displayProps, stage: 'thankyou', sale }));

/** "N total" at the head of the till's bracelets column. */
const tillTotal = (html: string): number => Number(/>(\d+) total</.exec(html)?.[1] ?? NaN);
/** The display's two counts: children, then adults. */
const displayCounts = (html: string): number[] =>
  [...html.matchAll(/<div class="text-4xl font-black">(\d+)<\/div>/g)].map((m) => Number(m[1]));

describe('SCRUM-931 — a drop-off child’s bracelet on the paid screen', () => {
  it('a drop-off sale: the till lists the child’s bracelet, counts it, and says it prints at check-in; the display counts the same', () => {
    const sale = saleOf([droppedOff]);
    const till = staffHalf(sale);
    expect(tillTotal(till)).toBe(1);
    expect(till).toContain('1× Child bracelet');
    expect(till).toContain('Prints at check-in');
    // No band comes back from the sale itself for a child checked in later: that is not a fault.
    expect(till).not.toContain('No band codes came back');

    const display = customerHalf(sale);
    expect(displayCounts(display)).toEqual([1, 0]);
    expect(display).toContain('Child bracelet');
    expect(tillTotal(till)).toBe(displayCounts(display).reduce((a, b) => a + b, 0));
  });

  it('a family with a drop-off child besides: three on both screens, and only the drop-off row prints at check-in', () => {
    const sale = saleOf([ordinary, droppedOff]);
    const till = staffHalf(sale);
    expect(tillTotal(till)).toBe(3);
    expect(till.match(/Prints at check-in/g)).toHaveLength(1);
    expect(displayCounts(customerHalf(sale))).toEqual([2, 1]);
  });

  it('an ordinary sale is as it was: no check-in line, and a sale whose bands did not come back still says so', () => {
    const till = staffHalf(saleOf([ordinary]));
    expect(tillTotal(till)).toBe(2);
    expect(till).not.toContain('Prints at check-in');
    expect(till).toContain('No band codes came back for this sale. Reprint its bands from History to issue them.');
  });

  it('a drop-off child checked in with "Check in now" shows the code of the band it printed on its own row', () => {
    const band = { id: 'band-1', kind: 'kid', shortCode: 'T1-DROP01', childName: 'ZZ TEST child', status: 'active', saleLineId: 'sl-1' } as unknown as ApiSaleBand;
    const till = staffHalf(saleOf([droppedOff]), issueOf({ bands: [band], lines: [{ id: 'sl-1', cartLineId: DROPOFF_LINE }] }));
    expect(till).toContain('T1-DROP01');
    // On the child's row, not in the "Band codes" block for codes no row claims.
    expect(till).not.toContain('>Band codes<');
  });
});

describe('SCRUM-931 — the credit column says the grants were issued', () => {
  const grant: ApiWalletGrant = {
    walletId: '0190a0a0-0000-7000-8000-0000000d0931', role: 'adult', personIndex: 0, creditSatang: 35_000,
    qrCode: 'QR-931ABCDEFGHJKMNPQRS', holderName: 'Walk-in guest', gateAccess: true, bandShortCode: null, expiresAt: null,
  };

  it('a sale whose adult earned ฿350: the credit is on the receipt the platform queued, and the column is "Credit Grants Issued"', () => {
    const sale = withPlatformCredit(saleOf([ordinary]), [grant], false);
    const till = staffHalf(sale, issueOf({ grants: [grant] }));
    expect(CREDIT_HEADING).toBe('Credit Grants Issued');
    expect(till).toContain('>Credit Grants Issued<');
    expect(till).not.toContain('Credit Grants to Print');
    expect(till).toContain('฿350');
  });

  it('nothing granted, nothing queued: no credit column at all, as before', () => {
    const till = staffHalf(saleOf([ordinary]), issueOf({ printJobs: [] }));
    expect(till).not.toContain(CREDIT_HEADING);
  });
});
