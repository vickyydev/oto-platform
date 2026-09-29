import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bandLabel,
  bandsByCartLine,
  mergeLookup,
  parseHistorySearch,
  refundAmountFor,
  refundItemOptions,
  refundRemainingSatang,
  reprintOptions,
  spentOf,
  toTxn,
  type ApiRefund,
  type ApiSaleBand,
  type ApiSaleDiscount,
  type ApiSaleLine,
  type ApiSaleListItem,
  type ApiSalePrintJob,
  type ApiSaleTotals,
  type HistoryTxn,
  type RefundItemOption,
} from '@/api/history';
import { DiscountLabel, refundSliceWords, voucherLabelParts } from '@/components/history/SaleDetail';
import { platformPrintOutcome } from '@/lib/salePrinting';
import {
  REFUND_REQUESTS_KEY,
  clearRefundRequests,
  queueRefundRequest,
  readRefundRequests,
  refundRequestsFor,
  type NoteStorage,
  type RefundRequestNote,
} from '@/lib/refundRequests';

// The page's session hook reads `window` as its module loads (a hand-off in
// the address). Nothing here renders the page, only its discount line, so the
// hook is replaced by the one thing the module imports from it.
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ operator: null, can: () => false }),
}));

// This runner has no React plugin (vitest.config.ts), so the component's JSX
// is compiled to `React.createElement` and looks for `React` in scope. It is
// put there for each test, and the runner puts it back after each one.
beforeEach(() => {
  vi.stubGlobal('React', React);
});

/**
 * A VOUCHER LINE ON THE HISTORY PAGE KEEPS ITS LAST FOUR IN VIEW — SCRUM-433,
 * `components/history/SaleDetail.tsx`.
 *
 * The platform labels a voucher's discount line "<type name> (voucher …WXYZ)".
 * The row is cut with an ellipsis when it does not fit, and cut at the end a
 * long type name pushed the four characters that match the line to the slip
 * off it. The label is now split where the voucher part starts: the name is the
 * part that truncates, the voucher part never does. Any other label renders as
 * the one truncating run it always was.
 *
 * The markup is rendered to a string with React's own server renderer, which
 * needs no DOM; the width is the browser's, so what is pinned here is which
 * part carries the truncation and which part cannot shrink.
 */

type Discount = Pick<ApiSaleDiscount, 'kind' | 'label' | 'targetLabel'>;

const render = (discount: Discount): string =>
  renderToStaticMarkup(React.createElement(DiscountLabel, { discount }));

describe('voucherLabelParts — where a voucher line turns from its name to its code', () => {
  it('splits a voucher line into the type’s name and the voucher part', () => {
    expect(voucherLabelParts('Free Bracelet Workshop (voucher …WXYZ)')).toEqual({
      name: 'Free Bracelet Workshop',
      tail: ' (voucher …WXYZ)',
    });
  });

  it('splits at the last voucher part, so a name that says "(voucher" stays the name', () => {
    expect(voucherLabelParts('Gift (voucher club) (voucher …47WP)')).toEqual({
      name: 'Gift (voucher club)',
      tail: ' (voucher …47WP)',
    });
  });

  it('leaves every other label whole', () => {
    expect(voucherLabelParts('Staff Discount')).toBeNull();
    expect(voucherLabelParts('Songkran (voucher club) · Kids')).toBeNull();
    expect(voucherLabelParts(' (voucher …47WP)')).toBeNull();
    expect(voucherLabelParts(null)).toBeNull();
  });
});

describe('DiscountLabel — the line on the money card', () => {
  it('renders a voucher line as a name that truncates and a voucher part that does not', () => {
    const html = render({
      kind: 'promo',
      label: 'Free Bracelet Workshop (voucher …WXYZ)',
      targetLabel: null,
    });
    expect(html).toBe(
      '<span class="flex min-w-0">' +
        '<span class="min-w-0 truncate">Free Bracelet Workshop</span>' +
        '<span class="shrink-0 whitespace-pre"> (voucher …WXYZ)</span>' +
        '</span>',
    );
  });

  it('keeps a line aimed at something readable after the voucher part', () => {
    const html = render({
      kind: 'promo',
      label: 'Kids Pizza (voucher …8H2J)',
      targetLabel: 'Kids',
    });
    expect(html).toContain('<span class="shrink-0 whitespace-pre"> (voucher …8H2J)</span>');
    // Opened by a no-break space, which a flex item keeps at its start.
    const noBreakSpace = String.fromCharCode(0xa0);
    expect(html).toContain(`<span class="min-w-0 truncate">${noBreakSpace}· Kids</span>`);
  });

  it('renders every other line as the one truncating run it always was', () => {
    expect(render({ kind: 'promo', label: 'Staff Discount', targetLabel: null })).toBe(
      '<span class="block truncate">Staff Discount</span>',
    );
    expect(render({ kind: 'manual', label: null, targetLabel: '2 Hours Play' })).toBe(
      '<span class="block truncate">Discount · 2 Hours Play</span>',
    );
    // A park code's label that merely mentions a voucher is not a voucher's line.
    expect(render({ kind: 'manual', label: 'Staff (voucher …1234)', targetLabel: null })).toBe(
      '<span class="block truncate">Staff (voucher …1234)</span>',
    );
  });
});

// --- S2-11 (SCRUM-208): History's search, refunds, reprints and bands ---------

/** A sale line as `GET /sales/:id` answers it, with only what a test cares about set. */
const saleLine = (overrides: Partial<ApiSaleLine> & Pick<ApiSaleLine, 'id' | 'cartLineId' | 'kind'>): ApiSaleLine => ({
  lineNo: 1,
  componentKey: null,
  ticketPackageId: null,
  label: 'Line',
  revenueCategory: null,
  taxableCategory: 'tickets',
  quantity: 1,
  unitSatang: 0,
  baseSatang: 0,
  discountSatang: 0,
  netSatang: 0,
  serviceChargeSatang: 0,
  taxSatang: 0,
  taxMode: 'inclusive',
  taxRateBp: 700,
  taxName: 'VAT',
  grossSatang: 0,
  customerTier: 'tourist',
  kidCount: 0,
  adultCount: 0,
  freeAdultCount: 0,
  stayHours: null,
  stayDurationLabel: null,
  ...overrides,
});

const totals = (grossSatang: number, refundedSatang = 0): ApiSaleTotals => ({
  subtotalSatang: grossSatang,
  manualDiscountSatang: 0,
  promoDiscountSatang: 0,
  discountSatang: 0,
  netSatang: grossSatang,
  serviceChargeSatang: 0,
  taxInclusiveSatang: 0,
  taxExclusiveSatang: 0,
  grossSatang,
  unappliedDiscountSatang: 0,
  refundedSatang,
});

/** A sale as the list answers it, turned into the row History renders. */
const row = (
  id: string,
  occurredAt: string,
  opts: { status?: ApiSaleListItem['status']; gross?: number; refunded?: number } = {},
): HistoryTxn =>
  toTxn(
    {
      id,
      branchId: 'branch-1',
      stationId: 'station-1',
      memberId: null,
      visitId: null,
      businessDate: occurredAt.slice(0, 10),
      occurredAt,
      status: opts.status ?? 'finalised',
      pricingMode: 'weekday',
      pricingModeReason: 'Weekday',
      customerTier: 'tourist',
      receiptNumber: `T1-00000${id.slice(-1)}`,
      receiptSeries: 'T1',
      receiptSeq: 1,
      finalisedAt: occurredAt,
      note: null,
      totals: totals(opts.gross ?? 30000, opts.refunded ?? 0),
      soldBy: { accountId: 'account-1', name: 'Som' },
      stationName: 'Reception Till 1',
      member: null,
      lineKinds: ['kids'],
      revenueCategories: ['tickets'],
    },
    {},
  );

const band = (overrides: Partial<ApiSaleBand> & Pick<ApiSaleBand, 'id' | 'kind'>): ApiSaleBand => ({
  status: 'active',
  shortCode: `T1-${overrides.id.toUpperCase().padEnd(6, 'Z').slice(0, 6)}`,
  saleLineId: null,
  childId: null,
  childName: null,
  printedJobId: null,
  createdAt: '2026-09-30T07:00:00.000Z',
  ...overrides,
});

const job = (overrides: Partial<ApiSalePrintJob> & Pick<ApiSalePrintJob, 'id' | 'kind' | 'status'>): ApiSalePrintJob => ({
  role: null,
  stationId: 'station-1',
  deviceId: 'device-1',
  deviceLabel: 'Receipt printer',
  subjectType: 'sale',
  subjectId: 'sale-1',
  reprintOf: null,
  reprintReason: null,
  errorCode: null,
  errorMessage: null,
  queuedAt: '2026-09-30T07:00:00.000Z',
  finishedAt: null,
  ...overrides,
});

describe('parseHistorySearch — what the search box was given (S2-11)', () => {
  // The worked example pinned by `packages/shared/test/band-code.test.ts`.
  const SIGNED = 'T1229E98P2DRXHTB6MKV5J2D4DQD2.AJRVQ9V6FDME';

  it('reads a scanned band QR as a band, labelled by its short code', () => {
    expect(parseHistorySearch(SIGNED)).toEqual({ kind: 'band', code: SIGNED, label: 'T1-D4DQD2' });
    // A scanner or a person may give it in lower case, with spaces around it.
    expect(parseHistorySearch(`  ${SIGNED.toLowerCase()} `)).toEqual({
      kind: 'band',
      code: SIGNED,
      label: 'T1-D4DQD2',
    });
  });

  it('reads the short code printed under the QR, with a dash or a space', () => {
    expect(parseHistorySearch('T1-D4DQD2')).toEqual({ kind: 'band', code: 'T1-D4DQD2', label: 'T1-D4DQD2' });
    expect(parseHistorySearch('t1 d4dqd2')).toEqual({ kind: 'band', code: 'T1-D4DQD2', label: 'T1-D4DQD2' });
  });

  it('reads a phone in any format as E.164', () => {
    expect(parseHistorySearch('081 895 3926')).toEqual({ kind: 'phone', phone: '+66818953926' });
    expect(parseHistorySearch('+66 81 895 3926')).toEqual({ kind: 'phone', phone: '+66818953926' });
    expect(parseHistorySearch('0066818953926')).toEqual({ kind: 'phone', phone: '+66818953926' });
  });

  it('leaves an amount, a receipt number and a name to the on-screen filter', () => {
    expect(parseHistorySearch('1250')).toEqual({ kind: 'text' });
    expect(parseHistorySearch('T1-000123')).toEqual({ kind: 'text' });
    expect(parseHistorySearch('Mali')).toEqual({ kind: 'text' });
    expect(parseHistorySearch('   ')).toEqual({ kind: 'text' });
    // A short code's tail never holds 0, 1, I, L, O or U.
    expect(parseHistorySearch('T1-D4DQD0')).toEqual({ kind: 'text' });
  });
});

describe('mergeLookup — the rows a band or phone search shows', () => {
  it('puts the platform finds beside the day’s rows, each sale once, newest first', () => {
    const today = row('sale-1', '2026-09-30T08:00:00.000Z');
    const alsoToday = row('sale-2', '2026-09-30T09:00:00.000Z');
    const yesterday = row('sale-3', '2026-09-29T10:00:00.000Z');
    const merged = mergeLookup([today, alsoToday], [yesterday, today]);
    expect(merged.map((t) => t.id)).toEqual(['sale-2', 'sale-1', 'sale-3']);
  });

  it('is the day’s rows alone when nothing was found or nothing was asked', () => {
    const today = row('sale-1', '2026-09-30T08:00:00.000Z');
    expect(mergeLookup([today], null)).toEqual([today]);
    expect(mergeLookup([today], [])).toEqual([today]);
  });
});

describe('spentOf — what a set of sales took, net of refunds', () => {
  it('leaves out unpaid and voided sales and takes refunds off the rest', () => {
    const rows = [
      row('sale-1', '2026-09-30T08:00:00.000Z', { gross: 30000, refunded: 10050 }),
      row('sale-2', '2026-09-30T09:00:00.000Z', { gross: 50000, status: 'voided' }),
      row('sale-3', '2026-09-30T10:00:00.000Z', { gross: 70000, status: 'tendering' }),
      row('sale-4', '2026-09-30T11:00:00.000Z', { gross: 12000 }),
    ];
    expect(spentOf(rows)).toBe(319.5);
  });
});

describe('refundItemOptions — the Refund dialog’s "By item" rows', () => {
  const lines = [
    saleLine({ id: 'l-kids', cartLineId: 'cart-1', kind: 'kids', label: 'Kids', quantity: 2, grossSatang: 60000, ticketPackageId: 'pkg-2h' }),
    saleLine({ id: 'l-adult', cartLineId: 'cart-1', kind: 'adults_paid', label: 'Adults', quantity: 1, grossSatang: 15000 }),
    saleLine({ id: 'l-socks', cartLineId: 'cart-2', kind: 'socks', label: 'Grip socks', quantity: 3, grossSatang: 9000 }),
    saleLine({ id: 'l-free', cartLineId: 'cart-3', kind: 'promo_item', label: 'Free cone', quantity: 1, grossSatang: 0 }),
  ];

  it('offers one row per cart line, named the way the prototype named it', () => {
    const options = refundItemOptions({ lines, refunds: [] }, (l) => (l.ticketPackageId ? '2 Hours Play' : null));
    expect(options).toEqual([
      { id: 'cart-1', label: '2 Hours Play · 3 ppl', lineIds: ['l-kids', 'l-adult'], amountSatang: 75000 },
      { id: 'cart-2', label: '3× Grip socks', lineIds: ['l-socks'], amountSatang: 9000 },
    ]);
  });

  it('leaves out what an earlier refund covered', () => {
    const earlier = {
      lines: [{ saleLineId: 'l-kids', label: 'Kids', quantity: 2, grossSatang: 60000, restock: false }],
    } as ApiRefund;
    const options = refundItemOptions({ lines, refunds: [earlier] });
    expect(options.find((o) => o.id === 'cart-1')).toEqual({
      id: 'cart-1',
      label: 'Kids · 3 ppl',
      lineIds: ['l-adult'],
      amountSatang: 15000,
    });
  });
});

describe('refundAmountFor — the clamp to what is left (RefundModal, recordRefund)', () => {
  const options: RefundItemOption[] = [
    { id: 'cart-1', label: 'Play · 2 ppl', lineIds: ['a', 'b'], amountSatang: 40000 },
    { id: 'cart-2', label: '1× Socks', lineIds: ['c'], amountSatang: 5000 },
  ];

  it('refunds everything still refundable for the whole sale', () => {
    expect(
      refundAmountFor({ mode: 'whole', remainingSatang: 32500, options, selected: [], customSatang: 0 }),
    ).toEqual({ amountSatang: 32500, requestedSatang: 32500, clamped: false, lineIds: [] });
  });

  it('adds the picked rows up and names their sale lines', () => {
    expect(
      refundAmountFor({ mode: 'items', remainingSatang: 45000, options, selected: ['cart-2'], customSatang: 0 }),
    ).toEqual({ amountSatang: 5000, requestedSatang: 5000, clamped: false, lineIds: ['c'] });
  });

  it('caps picked rows worth more than what is left, and says so', () => {
    expect(
      refundAmountFor({ mode: 'items', remainingSatang: 30000, options, selected: ['cart-1', 'cart-2'], customSatang: 0 }),
    ).toEqual({ amountSatang: 30000, requestedSatang: 45000, clamped: true, lineIds: ['a', 'b', 'c'] });
  });

  it('caps a custom amount at what is left, and takes a smaller one as keyed', () => {
    expect(
      refundAmountFor({ mode: 'custom', remainingSatang: 30000, options, selected: [], customSatang: 50000 }),
    ).toMatchObject({ amountSatang: 30000, requestedSatang: 50000, clamped: true, lineIds: [] });
    expect(
      refundAmountFor({ mode: 'custom', remainingSatang: 30000, options, selected: [], customSatang: 12000.4 }),
    ).toMatchObject({ amountSatang: 12000, clamped: false });
  });

  it('refunds nothing from a sale with nothing left', () => {
    expect(
      refundAmountFor({ mode: 'whole', remainingSatang: 0, options, selected: [], customSatang: 0 }).amountSatang,
    ).toBe(0);
  });
});

describe('refundRemainingSatang — what may still be refunded', () => {
  it('takes the platform’s figure when the detail carries one', () => {
    expect(refundRemainingSatang({ refundableSatang: 1200 }, { grossSatang: 5000, refundedSatang: 0 })).toBe(1200);
  });

  it('works it out from the totals on a deployment that does not send it', () => {
    expect(refundRemainingSatang({}, { grossSatang: 5000, refundedSatang: 1500 })).toBe(3500);
    expect(refundRemainingSatang(null, { grossSatang: 5000, refundedSatang: 6000 })).toBe(0);
  });
});

describe('reprintOptions — what the Reprint dialog offers (TransactionDetail.tsx:171-197)', () => {
  const ticketLines = [
    saleLine({ id: 'l-kids', cartLineId: 'cart-1', kind: 'kids', quantity: 2 }),
    saleLine({ id: 'l-adult', cartLineId: 'cart-1', kind: 'adults_free', quantity: 1 }),
  ];

  it('offers the receipt and each band group, counted from the bands issued', () => {
    const bands = [band({ id: 'b1', kind: 'kid' }), band({ id: 'b2', kind: 'kid' }), band({ id: 'b3', kind: 'adult' })];
    expect(reprintOptions({ lines: ticketLines, bands }, 'ticket')).toEqual([
      { kind: 'receipt', label: 'Full receipt' },
      { kind: 'kids_bands', label: 'Child bracelet', sublabel: '×2' },
      { kind: 'adult_bands', label: 'Adult bracelet', sublabel: '×1' },
    ]);
  });

  it('counts from the lines where no band was issued yet — reprinting issues them', () => {
    expect(reprintOptions({ lines: ticketLines, bands: [] }, 'ticket').map((o) => o.sublabel)).toEqual([
      undefined,
      '×2',
      '×1',
    ]);
  });

  it('offers a shop sale’s receipt under its own kind, and an F&B order’s pick-up ticket', () => {
    expect(reprintOptions({ lines: [saleLine({ id: 'm', cartLineId: 'c', kind: 'merch_item' })] }, 'merch')).toEqual([
      { kind: 'merch_receipt', label: 'Full receipt' },
    ]);
    expect(
      reprintOptions({ lines: [saleLine({ id: 'f', cartLineId: 'c', kind: 'fnb_item' })], pickupCode: 'A-12' }, 'fnb'),
    ).toEqual([
      { kind: 'receipt', label: 'Full receipt' },
      { kind: 'prep', label: 'Pickup ticket #A-12' },
    ]);
  });
});

describe('bandsByCartLine — each code beside the bracelet row it belongs to', () => {
  it('files a band under its cart line and kind, and keeps the ones it cannot place', () => {
    const lines = [
      { id: 'l-kids', cartLineId: 'cart-1' },
      { id: 'l-adult', cartLineId: 'cart-1' },
    ];
    const kid = band({ id: 'b1', kind: 'kid', saleLineId: 'l-kids', childName: 'Mali' });
    const adult = band({ id: 'b2', kind: 'adult', saleLineId: 'l-adult' });
    const stray = band({ id: 'b3', kind: 'kid', saleLineId: 'l-unknown' });
    const revoked = band({ id: 'b4', kind: 'kid', saleLineId: 'l-kids', status: 'revoked' });
    const { byRow, unplaced } = bandsByCartLine([kid, adult, stray, revoked], lines);
    expect(byRow.get('cart-1:kid')).toEqual([kid]);
    expect(byRow.get('cart-1:adult')).toEqual([adult]);
    expect(unplaced).toEqual([stray]);
    expect(bandLabel(kid)).toBe(`${kid.shortCode} · Mali`);
    expect(bandLabel({ shortCode: null, childName: null })).toBe('No code');
  });
});

describe('platformPrintOutcome — the platform’s print jobs in the till’s toast', () => {
  it('counts what went to each printer and marks a copy', () => {
    const outcome = platformPrintOutcome([
      job({ id: 'j1', kind: 'receipt', status: 'queued' }),
      job({ id: 'j2', kind: 'kids_wristband', status: 'queued', deviceLabel: 'Kids band printer' }),
      job({ id: 'j3', kind: 'kids_wristband', status: 'printed', deviceLabel: 'Kids band printer' }),
      job({ id: 'j4', kind: 'receipt', status: 'queued', reprintOf: 'j0' }),
    ]);
    expect(outcome.sent).toEqual([
      { label: 'Receipt', device: 'Receipt printer' },
      { label: 'Kids bracelet ×2', device: 'Kids band printer' },
      { label: 'Receipt (copy)', device: 'Receipt printer' },
    ]);
    expect(outcome.notPrinted).toEqual([]);
  });

  it('names the printer by its role when the answer carries no device label', () => {
    const copy = job({ id: 'j1', kind: 'kids_wristband', status: 'queued', role: 'kids_band', deviceLabel: null, reprintOf: 'j0' });
    expect(platformPrintOutcome([copy]).sent).toEqual([{ label: 'Kids bracelet (copy)', device: 'Kids band printer' }]);
  });

  it('says what was not printed: the platform’s notes, else its sentence per skipped job', () => {
    const skipped = job({ id: 'j1', kind: 'bar_ticket', status: 'skipped', role: 'bar', deviceId: null, deviceLabel: null });
    expect(platformPrintOutcome([skipped]).notPrinted).toEqual([
      'Bar ticket not printed — no bar printer at this station',
    ]);
    expect(platformPrintOutcome([skipped], ['Bar ticket not printed — no bar printer at this station']).notPrinted).toEqual([
      'Bar ticket not printed — no bar printer at this station',
    ]);
    const failed = job({ id: 'j2', kind: 'receipt', status: 'failed', errorMessage: 'Paper out' });
    expect(platformPrintOutcome([failed]).notPrinted).toEqual(['Receipt not printed — Paper out']);
  });
});

describe('refundSliceWords — how each slice of a refund went back', () => {
  it('prefers the platform’s own sentence, and has words for a slice without one', () => {
    expect(
      refundSliceWords({ method: 'card', route: 'terminal_void', status: 'failed', detail: 'The terminal refused the void — hand it back in cash' }),
    ).toEqual({ text: 'Card — The terminal refused the void — hand it back in cash', tone: 'text-rose-400' });
    expect(refundSliceWords({ method: 'qr', route: 'gateway_refund', status: 'pending', detail: null })).toEqual({
      text: 'QR — refund sent to the payment gateway',
      tone: 'text-amber-400',
    });
    expect(refundSliceWords({ method: 'cash', route: 'cash', status: 'done' }).text).toBe('Cash — hand it back in cash');
  });
});

describe('refund requests noted offline — lib/refundRequests.ts', () => {
  const memory = (): NoteStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    };
  };
  const note = (id: string, saleId: string): RefundRequestNote => ({
    id,
    saleId,
    receiptNumber: 'T1-000001',
    mode: 'whole',
    amountSatang: 30000,
    reason: 'Wrong tier',
    note: null,
    requestedBy: 'Som',
    requestedAt: '2026-09-30T08:00:00.000Z',
  });

  it('keeps a note per sale until that sale is refunded or cleared', () => {
    const storage = memory();
    expect(queueRefundRequest(note('n1', 'sale-1'), storage)).toBe(true);
    expect(queueRefundRequest(note('n2', 'sale-2'), storage)).toBe(true);
    expect(refundRequestsFor('sale-1', storage).map((n) => n.id)).toEqual(['n1']);
    clearRefundRequests('sale-1', storage);
    expect(readRefundRequests(storage).map((n) => n.id)).toEqual(['n2']);
  });

  it('says when it could not keep a note, and reads nothing out of a broken store', () => {
    const refusing: NoteStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(queueRefundRequest(note('n1', 'sale-1'), refusing)).toBe(false);
    expect(queueRefundRequest(note('n1', 'sale-1'), null)).toBe(false);
    const garbled = memory();
    garbled.setItem(REFUND_REQUESTS_KEY, '{not json');
    expect(readRefundRequests(garbled)).toEqual([]);
    garbled.setItem(REFUND_REQUESTS_KEY, JSON.stringify([{ id: 'x' }, note('n3', 'sale-3')]));
    expect(readRefundRequests(garbled).map((n) => n.id)).toEqual(['n3']);
  });
});
