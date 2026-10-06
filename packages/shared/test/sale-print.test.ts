import { describe, expect, it } from 'vitest';
import {
  cartUnits,
  computeTicketCartTotals,
  mintBandCode,
  planLedgerBands,
  priceCartLine,
  salePrintDocumentOf,
  salePrintRequests,
  saleBandDocument,
  saleReceiptDocument,
  splitLedgerUnitMoney,
  ulidFromUuid,
  type PricingContext,
  type SalePrintSnapshot,
  type TaxConfigShape,
  type TicketCartLine,
} from '../src/index';

/**
 * THE ONE COMPOSER (offline plan §2.5, Round 4). A sale's receipt, bands, prep
 * tickets and item vouchers come out of one pure function over one snapshot,
 * which the platform feeds from the ledger and a box with no internet from
 * its own finalise. These cases pin what the documents say; the api suite
 * (`offline-selling.test.ts`) holds the two feeders to the same answer.
 */

const TZ = 'Asia/Bangkok';
const KEY = 'composer-test-band-key';

const snapshot = (over: Partial<SalePrintSnapshot> = {}): SalePrintSnapshot => ({
  saleId: '018f0000-0000-7000-8000-0000005a1e01',
  receiptNumber: 'T1-000043',
  at: '2026-09-30T07:05:00.000Z',
  timezone: TZ,
  operatorName: 'OTO',
  branchName: 'HKT Central',
  staffName: 'Nok',
  memberNickname: 'Mali',
  lines: [
    { id: 'l-kids', kind: 'kids', label: '2 Hours Play — Kids', quantity: 2, grossSatang: 70_000, ticket: true, payload: null, stayHours: 2, stayDurationLabel: '2 Hours' },
    { id: 'l-adult', kind: 'adults_paid', label: '2 Hours Play — Adults', quantity: 1, grossSatang: 0, ticket: true, payload: null, stayHours: 2, stayDurationLabel: '2 Hours' },
    { id: 'l-socks', kind: 'socks', label: 'Grip Socks', quantity: 2, grossSatang: 10_000, ticket: true, payload: null, stayHours: null, stayDurationLabel: null },
    {
      id: 'l-latte',
      kind: 'fnb_item',
      label: 'Latte',
      quantity: 1,
      grossSatang: 10_500,
      ticket: false,
      payload: { modifiers: [{ optionName: 'Oat' }], note: 'extra hot', prepStation: 'bar', pickupCode: '42' },
      stayHours: null,
      stayDurationLabel: null,
    },
  ],
  subtotalSatang: 90_500,
  grossSatang: 90_500,
  taxBreakdown: {
    netSubtotal: 84_579,
    discountTotal: 0,
    serviceChargeTotal: 0,
    exclusiveTaxTotal: 0,
    inclusiveTaxTotal: 5_921,
    taxTotal: 5_921,
    categories: [
      {
        category: 'tickets',
        base: 80_000,
        taxMode: 'inclusive',
        taxPercent: 7,
        tax: 5_234,
        taxName: 'VAT',
        taxRateId: 'vat',
        serviceCharge: 0,
        secondaryTaxMode: 'none',
        secondaryTax: 0,
      },
      {
        category: 'fnb',
        base: 10_500,
        taxMode: 'inclusive',
        taxPercent: 7,
        tax: 687,
        taxName: 'VAT',
        taxRateId: 'vat',
        serviceCharge: 0,
        secondaryTaxMode: 'none',
        secondaryTax: 0,
      },
    ],
    grandTotal: 90_500,
  } as never,
  tenders: [{ method: 'cash', last4: null, amountSatang: 90_500, tenderedSatang: 100_000, changeSatang: 9_500 }],
  bands: [
    {
      id: '018f0000-0000-7000-8000-0000000b0001',
      kind: 'kid',
      code: mintBandCode('T1', ulidFromUuid('018f0000-0000-7000-8000-0000000b0001'), KEY),
      saleLineId: 'l-kids',
      childName: 'Ploy',
      allergies: 'Peanuts',
      medicalNotes: 'Inhaler',
      dietary: 'No dairy',
    },
    {
      id: '018f0000-0000-7000-8000-0000000b0002',
      kind: 'adult',
      code: mintBandCode('T1', ulidFromUuid('018f0000-0000-7000-8000-0000000b0002'), KEY),
      saleLineId: 'l-adult',
      childName: null,
      allergies: null,
      medicalNotes: null,
      dietary: null,
    },
  ],
  orderChildren: [{ name: 'Ploy', allergies: 'Peanuts', medicalNotes: null }],
  note: 'Birthday table',
  ...over,
});

describe('the receipt', () => {
  it('is the abbreviated tax invoice, with the ledger’s lines, the change, the short band codes and what is owed', () => {
    const receipt = saleReceiptDocument(snapshot());
    expect(receipt.title).toBe('Receipt');
    expect(receipt.taxInvoiceLines).toEqual([
      'ใบกำกับภาษีอย่างย่อ',
      'ABBREVIATED TAX INVOICE',
      'OTO · HKT Central',
      'VAT included',
    ]);
    expect(receipt.receiptNumber).toBe('T1-000043');
    expect(receipt.dateTime).toBe('2026-09-30 14:05');
    expect(receipt.staffName).toBe('Nok');
    expect(receipt.lines.map((l) => [l.qty, l.name, l.price])).toEqual([
      [2, '2 Hours Play — Kids', '฿700'],
      [1, '2 Hours Play — Adults', '฿0'],
      [2, 'Grip Socks', '฿100'],
      [1, 'Latte (Oat)', '฿105'],
    ]);
    expect(receipt.tenders).toEqual([
      { label: 'Cash', amount: '฿905' },
      { label: 'Cash tendered', amount: '฿1,000' },
      { label: 'Change', amount: '฿95' },
    ]);
    expect(receipt.bandCodes).toHaveLength(2);
    for (const code of receipt.bandCodes ?? []) expect(code).toMatch(/^T1-[0-9A-Z]{6}$/);
    expect(receipt.creditGrants).toEqual(['2× Grip Socks to collect']);
    expect(receipt.orderNote).toBe('Birthday table');
    expect(receipt.vat).toBe('฿59.21');
  });

  it('says it is a copy when one is asked for, and never prints a signed band code', () => {
    const copy = saleReceiptDocument(snapshot(), true);
    expect(copy.title).toBe('Receipt (copy)');
    expect(JSON.stringify(copy)).not.toContain(snapshot().bands[0]!.code);
  });
});

describe('the bands, the prep ticket and the voucher', () => {
  it('a kids band names the child, the allergy line and how long the band admits', () => {
    const s = snapshot();
    const kid = saleBandDocument(s, s.bands[0]!);
    expect(kid).toEqual({
      holderName: 'Ploy',
      duration: '2 Hours · valid until 16:05',
      dietaryRequirement: 'No dairy',
      allergy: 'Peanuts; Inhaler',
      bandCode: s.bands[0]!.code,
      shortCode: expect.stringMatching(/^T1-/),
    });
    const adult = saleBandDocument(s, s.bands[1]!);
    expect(adult.holderName).toBe('Mali');
    expect(adult.allergy).toBeUndefined();
  });

  it('asks for the receipt, the kids bands, the adult bands, the vouchers, then each prep station — in that order', () => {
    const s = snapshot();
    expect(salePrintRequests(s).map((r) => [r.kind, r.subjectType])).toEqual([
      ['receipt', 'sale'],
      ['kids_wristband', 'band'],
      ['adult_wristband', 'band'],
      ['item_voucher', 'sale_line'],
      ['bar_ticket', 'sale'],
    ]);
    const bar = salePrintDocumentOf(s, { kind: 'bar_ticket', subjectType: 'sale', subjectId: s.saleId });
    expect(bar).toMatchObject({
      kind: 'bar_ticket',
      data: {
        title: 'Bar',
        orderRef: '42',
        time: '14:05',
        holderName: 'Mali',
        allergiesMedical: 'Ploy: Peanuts',
        lines: [{ qty: 1, name: 'Latte (Oat)', note: 'extra hot' }],
        orderNote: 'Birthday table',
      },
    });
    const voucher = salePrintDocumentOf(s, { kind: 'item_voucher', subjectType: 'sale_line', subjectId: 'l-socks' });
    expect(voucher).toEqual({ kind: 'item_voucher', data: { label: 'Grip Socks', quantity: 2 } });
  });
});

describe('the ledger’s lines, shared with the box', () => {
  const TAX: TaxConfigShape = {
    rates: [{ id: 'vat', name: 'VAT', percent: 7 }],
    categoryRules: [{ category: 'tickets', taxRateId: 'vat', taxMode: 'inclusive' }],
    discountPlacement: 'before_tax',
  } as TaxConfigShape;
  const ctx: PricingContext = { mode: 'weekday', socks: { addOnId: 'a-socks', price: 5_000, label: 'Socks' } };

  it('splits each category’s money across its units so the parts sum back exactly', () => {
    const line: TicketCartLine = {
      id: 'line-1',
      packageId: 'pkg',
      package: { prices: { tourist: { weekday: 33_333, weekend: 40_000 } }, adultRules: null as never },
      tier: 'tourist',
      kids: 3,
      adults: 1,
      socks: 2,
      addOns: [],
      lineTotal: 0,
    };
    line.lineTotal = priceCartLine(line, ctx);
    const totals = computeTicketCartTotals([line], [], [], TAX, ctx);
    const units = cartUnits([line], ctx);
    const money = splitLedgerUnitMoney(units, totals);
    expect(money.reduce((sum, m) => sum + m.gross, 0)).toBe(totals.taxBreakdown.grandTotal);
    expect(money.reduce((sum, m) => sum + m.taxInclusive, 0)).toBe(totals.taxBreakdown.inclusiveTaxTotal);
  });

  it('plans one kids band per child and one adult band per adult, free adults included, in cart order', () => {
    const plan = planLedgerBands([
      { id: 'k1', cartLineId: 'a', kind: 'kids', ticket: true, kidCount: 2, adultCount: 2, freeAdultCount: 0 },
      { id: 'p1', cartLineId: 'a', kind: 'adults_paid', ticket: true, kidCount: 2, adultCount: 2, freeAdultCount: 0 },
      { id: 'f1', cartLineId: 'a', kind: 'adults_free', ticket: true, kidCount: 2, adultCount: 2, freeAdultCount: 1 },
      { id: 'x1', cartLineId: 'b', kind: 'fnb_item', ticket: false, kidCount: 0, adultCount: 0, freeAdultCount: 0 },
    ]);
    expect(plan.map((p) => [p.kind, p.saleLineId])).toEqual([
      ['kid', 'k1'],
      ['kid', 'k1'],
      ['adult', 'p1'],
      ['adult', 'p1'],
    ]);
  });
});
