import { describe, expect, it } from 'vitest';
import {
  allergiesMedicalOf,
  prepaidHeldRefusal,
  prepaidItemNotOnMenuRefusal,
  prepaidItemPriceRefusal,
  prepaidPaidMismatchRefusal,
  prepaidRemainingOf,
  prepaidStayClosedRefusal,
  prepaidUsedUpRefusal,
  redeemPrepaid,
  salePrepDocument,
  type SalePrintSnapshot,
} from '../src/index';

/**
 * SCRUM-494 (food) — the shared half: serving prepaid items the design's way
 * (`redeemPrepaidItem`: up at confirmation, never past what was paid) and the
 * prep ticket's allergy line taken from the band holder.
 */

const items = [
  { menuItemId: 'juice', qty: 2, redeemedQty: 1 },
  { menuItemId: 'nuggets', qty: 1, redeemedQty: 0 },
  { menuItemId: 'juice', qty: 1, redeemedQty: 0 },
];

describe('s494 — serving prepaid items', () => {
  it('counts what is left across every entry for an item', () => {
    expect(prepaidRemainingOf(items, 'juice')).toBe(2);
    expect(prepaidRemainingOf(items, 'nuggets')).toBe(1);
    expect(prepaidRemainingOf(items, 'pizza')).toBe(0);
  });

  it('serves entry by entry and never past what was paid, reporting what it took', () => {
    const first = redeemPrepaid(items, 'juice', 1);
    expect(first.applied).toBe(1);
    expect(first.items.map((i) => i.redeemedQty)).toEqual([2, 0, 0]);
    const over = redeemPrepaid(first.items, 'juice', 5);
    expect(over.applied).toBe(1);
    expect(over.items.map((i) => i.redeemedQty)).toEqual([2, 0, 1]);
    expect(redeemPrepaid(over.items, 'juice', 1).applied).toBe(0);
    // The input is left as it was.
    expect(items.map((i) => i.redeemedQty)).toEqual([1, 0, 0]);
  });

  it('says what is left in the counter’s words', () => {
    expect(prepaidUsedUpRefusal('Hot Dog', 'Kai', 0)).toBe("Kai's prepaid Hot Dog has already been served.");
    expect(prepaidUsedUpRefusal('Water', 'Kai', 1)).toBe('Kai has only 1 prepaid Water left to serve.');
    expect(prepaidHeldRefusal('Hot Dog', 'Kai')).toBe(
      "Kai's prepaid Hot Dog is on another order that is still open — finish or cancel that order first.",
    );
    expect(prepaidStayClosedRefusal('Kai')).toBe(
      'Kai has already been collected, so their prepaid food cannot be served on this order — cancel it and ring the order up again.',
    );
  });

  it('joins the allergy and the medical note the way the band paper does', () => {
    expect(allergiesMedicalOf(' Peanuts ', 'Inhaler')).toBe('Peanuts; Inhaler');
    expect(allergiesMedicalOf(null, '  ')).toBeNull();
  });
});

describe('s494 — the prep ticket prints the band holder’s own line', () => {
  const snapshot = (over: Partial<SalePrintSnapshot> = {}): SalePrintSnapshot => ({
    saleId: '018f0000-0000-7000-8000-0000005a1e01',
    receiptNumber: 'T1-000043',
    at: '2026-09-30T07:05:00.000Z',
    timezone: 'Asia/Bangkok',
    operatorName: 'OTO',
    branchName: 'HKT Central',
    staffName: 'Nok',
    memberNickname: 'Mali',
    lines: [
      {
        id: 'l-hotdog',
        kind: 'fnb_item',
        label: 'Hot Dog',
        quantity: 1,
        grossSatang: 0,
        ticket: false,
        payload: { prepStation: 'kitchen', pickupCode: '42' },
        stayHours: null,
        stayDurationLabel: null,
      },
    ],
    subtotalSatang: 0,
    grossSatang: 0,
    taxBreakdown: { categories: [], grandTotal: 0 } as never,
    tenders: [],
    bands: [],
    orderChildren: [
      { name: 'Mint', allergies: 'Peanuts', medicalNotes: null },
      { name: 'June', allergies: 'Shellfish', medicalNotes: null },
    ],
    note: null,
    ...over,
  });

  it('with a band holder: that child’s name and allergy, and no sibling’s', () => {
    const ticket = salePrepDocument(snapshot({ bandHolder: { name: 'June', allergiesMedical: 'Shellfish' } }), 'kitchen');
    expect(ticket.holderName).toBe('June');
    expect(ticket.allergiesMedical).toBe('Shellfish');
    expect(ticket.lines).toEqual([{ qty: 1, name: 'Hot Dog', note: undefined }]);
    const clear = salePrepDocument(snapshot({ bandHolder: { name: 'June', allergiesMedical: null } }), 'kitchen');
    expect(clear.allergiesMedical).toBeUndefined();
  });

  it('with no band holder: the member’s children, as before', () => {
    const ticket = salePrepDocument(snapshot(), 'kitchen');
    expect(ticket.holderName).toBe('Mali');
    expect(ticket.allergiesMedical).toBe('Mint: Peanuts · June: Shellfish');
  });
});

describe('s494 — registration refusals for prepaid items, in the counter’s words', () => {
  it('names the item, the child and the figures', () => {
    expect(prepaidItemNotOnMenuRefusal('Mystery Meal', 'Mint')).toBe(
      "Mystery Meal is not on this park's menu, so it cannot be prepaid for Mint — choose the prepaid food again.",
    );
    expect(prepaidItemPriceRefusal('Hot Dog', 'Mint', 11_000)).toBe(
      "Hot Dog is ฿110 on today's menu — choose Mint's prepaid food again.",
    );
    expect(prepaidPaidMismatchRefusal('Mint', 18_000, 18_050)).toBe(
      "Mint's prepaid food comes to ฿180, not ฿180.50 — choose the prepaid food again.",
    );
  });
});
