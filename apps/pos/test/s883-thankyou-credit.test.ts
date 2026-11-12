import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';
import type { ApiWalletGrant } from '@/api/wallet';
import { CustomerDisplay } from '@/components/till/CustomerDisplay';
import { QrCode } from '@/components/till/QrCode';
import { StepConfirmation, type SaleIssue } from '@/components/till/StepConfirmation';
import { LanguageProvider } from '@/i18n/LanguageContext';
import { readTicketDisplayView, ticketDisplayPresentation, type TicketDisplayState } from '@/lib/displaySession';
import { buildSale } from '@/lib/sale';
import { withPlatformCredit } from '@/lib/saleCredit';
import { getMockWristbands, issueWalkInBands } from '@/mockApi';
import type { CartLine, CustomerTier, Sale, TicketType } from '@/types';
import { cartQuote } from './support/fixtures';

/**
 * SCRUM-883 — THE THANK-YOU SHOWS THE CREDIT THE PLATFORM GRANTED, on the
 * till's split view, on a paired display and on the staff half alike.
 *
 * Staging, 12 November: a Thai sale of the 1 Hour Play package, one child and
 * one adult, the adult free by the Thai rate's free items. The platform read
 * back grants [] and the staff half showed no credit, while the customer half
 * showed "Credit Grants — Credit ฿350" with a QR. A Tourist sale of the same
 * package: the adult pays ฿350, one grant, both halves agree.
 */

vi.mock('@/components/till/AddOnsGrid', () => ({ AddOnsGrid: () => null }));

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

const under = (element: ReactElement): string => {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => 'en', setItem: () => undefined },
    location: { search: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return renderToStaticMarkup(createElement(LanguageProvider, null, element));
};

/** The staging package: ฿420 a child, the adult ฿350, free for Thai by the rate's free items. */
const onePlay: TicketType = {
  id: '0190a0a0-0000-7000-8000-000000000883',
  name: '1 Hour Play',
  durationLabel: '1 Hour',
  hours: 1,
  prices: {
    tourist: { weekday: 420, weekend: 420 },
    thai: { weekday: 420, weekend: 420 },
  },
  adultRules: {
    tourist: { kind: 'set_price', price: { weekday: 350, weekend: 350 } },
    thai: { kind: 'set_price', price: { weekday: 350, weekend: 350 } },
  },
  freebies: [{ id: 'fb-1', kind: 'adult', quantity: 1, tiers: ['thai'] }],
  creditRule: { appliesTo: 'adults', basis: 'full_price' },
  gateAccess: true,
};

const SALE_ID = '0190a0a0-0000-7000-8000-0000000c0883';
const QR = 'QR-7KMQ4XABCDEFGHJKMNPQ';

function saleOf(tier: CustomerTier, socks = 0): Sale {
  const line: CartLine = { id: `line-${tier}`, ticketType: onePlay, tier, kids: 1, adults: 1, socks, addOns: [], lineTotal: 0 };
  return buildSale({ id: SALE_ID, operatorId: 'op', operatorName: 'OTO', tier, lines: [line], paymentMethod: 'cash' });
}

/** What `GET /sales/:id` answered for the Tourist sale: one wallet, the adult's ฿350. */
const touristGrant: ApiWalletGrant = {
  walletId: '0190a0a0-0000-7000-8000-0000000d0883',
  role: 'adult',
  personIndex: 0,
  creditSatang: 35_000,
  qrCode: QR,
  holderName: 'Walk-in guest',
  gateAccess: true,
  bandShortCode: null,
  expiresAt: null,
};

const qrMarkup = (seed: string) => renderToStaticMarkup(createElement(QrCode, { seed, className: 'w-16 h-16' }));
const QR_BOX = 'bg-white rounded-lg p-1.5';

describe('withPlatformCredit — the credit rows are the platform’s grants', () => {
  it('the Thai sale: the platform granted nothing, so no credit row; the items stay', () => {
    const shown = withPlatformCredit(saleOf('thai', 1), [], false);
    expect(shown.creditGrants.filter((g) => g.type === 'fnb_credit')).toEqual([]);
    expect(shown.creditGrants.filter((g) => g.type === 'item').map((g) => g.label)).toEqual(['Regular Socks']);
  });

  it('the Tourist sale: one row, the platform’s amount and its wallet’s QR', () => {
    const shown = withPlatformCredit(saleOf('tourist'), [touristGrant], false);
    expect(shown.creditGrants).toEqual([
      { id: touristGrant.walletId, type: 'fnb_credit', label: 'Credit', valueTHB: 350, role: 'adult', gateAccess: true, qrCode: QR },
    ]);
  });

  it('until the platform answers there is no credit row, as the staff half shows none', () => {
    const shown = withPlatformCredit(saleOf('tourist'), null, false);
    expect(shown.creditGrants.filter((g) => g.type === 'fnb_credit')).toEqual([]);
  });

  it('a sale closed on the box keeps the till’s list — the platform’s grant law — and no QR', () => {
    const tourist = withPlatformCredit(saleOf('tourist'), null, true);
    expect(tourist.creditGrants.map((g) => [g.type, g.valueTHB, g.qrCode])).toEqual([['fnb_credit', 350, undefined]]);
    const thai = withPlatformCredit(saleOf('thai'), null, true);
    expect(thai.creditGrants.filter((g) => g.type === 'fnb_credit')).toEqual([]);
  });

  it('several grants come in the platform’s person order', () => {
    const second = { ...touristGrant, walletId: '0190a0a0-0000-7000-8000-0000000e0883', personIndex: 1, creditSatang: 10_000, qrCode: 'QR-SECOND' };
    const shown = withPlatformCredit(saleOf('tourist'), [second, touristGrant], false);
    expect(shown.creditGrants.map((g) => g.valueTHB)).toEqual([350, 100]);
  });
});

const displayProps = {
  phone: '', nickname: '', member: null,
  onPhoneChange: () => undefined, onNicknameChange: () => undefined, onIdentify: () => undefined, onCustomerDone: () => undefined,
};

describe('the split view’s customer half at the thank-you', () => {
  it('the Thai sale shows no Credit Grants block and no QR', () => {
    const html = under(createElement(CustomerDisplay, { ...displayProps, stage: 'thankyou', sale: withPlatformCredit(saleOf('thai'), [], false) }));
    expect(html).not.toContain('Credit Grants');
    expect(html).not.toContain('฿350');
    expect(html).not.toContain(QR_BOX);
  });

  it('the Tourist sale shows the ฿350 grant with the wallet’s own QR', () => {
    const html = under(createElement(CustomerDisplay, { ...displayProps, stage: 'thankyou', sale: withPlatformCredit(saleOf('tourist'), [touristGrant], false) }));
    expect(html).toContain('Credit Grants');
    expect(html).toContain('฿350');
    expect(html).toContain(qrMarkup(QR));
  });

  it('a grant the platform has not made draws no QR', () => {
    const html = under(createElement(CustomerDisplay, { ...displayProps, stage: 'thankyou', sale: withPlatformCredit(saleOf('tourist'), null, true) }));
    expect(html).toContain('฿350');
    expect(html).not.toContain(QR_BOX);
  });
});

describe('a paired display’s thank-you payload', () => {
  const totals = cartQuote(770).totals;
  const state = (sale: Sale): TicketDisplayState => ({
    stage: 'thankyou', step: 6, sessionKey: 's', tier: sale.tier, phone: '', nickname: '', contactChannel: 'whatsapp', member: null,
    sale, totals, rateMode: 'weekday', online: true, voucherPrize: null, nothingToPay: false,
  } as TicketDisplayState);
  const paired = (sale: Sale) => {
    const presented = ticketDisplayPresentation(state(sale), 'prompt-1');
    const doc = { stationId: 'st', boxId: 'box', schemaVersion: 1, sequence: 0, lease: null, takeoverCount: 0,
      updatedAt: '2026-11-12T00:00:00.000Z', language: 'en', ...presented } as unknown as StationSessionDocument;
    return { presented, view: readTicketDisplayView(doc) };
  };

  it('carries no credit for the Thai sale, and the display shows none', () => {
    const { presented, view } = paired(withPlatformCredit(saleOf('thai'), [], false));
    expect((presented.cart.sale as { creditGrants: unknown[] }).creditGrants).toEqual([]);
    expect(view).not.toBeNull();
    const html = under(createElement(CustomerDisplay, { ...displayProps, stage: 'thankyou', sale: view!.sale, showGrantQr: false }));
    expect(html).not.toContain('Credit Grants');
  });

  it('carries the Tourist grant as the platform made it', () => {
    const { presented, view } = paired(withPlatformCredit(saleOf('tourist'), [touristGrant], false));
    expect((presented.cart.sale as { creditGrants: unknown[] }).creditGrants).toEqual([
      { type: 'fnb_credit', label: 'Credit', valueTHB: 350, quantity: undefined },
    ]);
    const html = under(createElement(CustomerDisplay, { ...displayProps, stage: 'thankyou', sale: view!.sale, showGrantQr: false }));
    expect(html).toContain('Credit Grants');
    expect(html).toContain('฿350');
  });
});

describe('the staff half follows the same answer', () => {
  const issue = (grants: ApiWalletGrant[]): SaleIssue => ({
    number: { kind: 'receipt', number: 'T1-000883' }, bands: [], lines: [],
    printJobs: [{ kind: 'receipt', reprintOf: null } as unknown as NonNullable<SaleIssue['printJobs']>[number]],
    grants, issuedVouchers: [],
  });

  it('the Thai sale with socks: items to collect only, no ฿350 credit row', () => {
    const html = under(createElement(StepConfirmation, { sale: saleOf('thai', 1), onNewSale: () => undefined, issue: issue([]) }));
    expect(html).toContain('Credit Grants to Print');
    expect(html).toContain('Regular Socks');
    expect(html).not.toContain('฿350');
  });

  it('the Tourist sale: the ฿350 row with the wallet’s QR', () => {
    const html = under(createElement(StepConfirmation, { sale: saleOf('tourist'), onNewSale: () => undefined, issue: issue([touristGrant]) }));
    expect(html).toContain('฿350');
    expect(html).toContain(qrMarkup(QR));
  });
});

describe('the till mints no local wallet the platform would not grant', () => {
  it('the Thai sale: both people get a band with no balance', () => {
    const sale = { ...saleOf('thai'), id: 'local-883-thai' };
    expect(sale.creditGrants.filter((g) => g.type === 'fnb_credit')).toEqual([]);
    issueWalkInBands(sale);
    const bands = getMockWristbands().filter((w) => w.groupId === sale.id);
    expect(bands).toHaveLength(2);
    expect(bands.every((w) => w.creditBalanceTHB === 0)).toBe(true);
  });

  it('the Tourist sale: the adult’s credit is the platform’s ฿350, the child a plain band', () => {
    const sale = { ...saleOf('tourist'), id: 'local-883-tourist' };
    expect(sale.creditGrants.filter((g) => g.type === 'fnb_credit').map((g) => g.valueTHB)).toEqual([350]);
    issueWalkInBands(sale);
    // The earning adult's band is the wallet `ensureSaleGrantWallet` mints; only the child is minted here.
    expect(getMockWristbands().filter((w) => w.groupId === sale.id)).toHaveLength(1);
  });
});
