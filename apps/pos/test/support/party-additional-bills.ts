import type { PartyAdditionalBill } from '@oto/shared';
import type { PartyBooking } from '@/types';

/**
 * A settled party with two bills added after it was settled, as staging had
 * it on 18 November (proof-2026-11-18/SCRUM-990): bill 1 (a dish, ฿25.03) paid
 * in cash, bill 2 (a drink, ฿7.05) open. Both bills' ids start with the
 * party's own reference, as the platform's do, so a name taken from the
 * start of an id reads the same for both. The tab still carries a package,
 * an add-on and a deposit of its own, so a screen that leaked the main bill
 * to a guest paying bill 2 would be caught.
 */

const REF = '48073b00-3abb-7104-ba0d-';

const charge = (id: string, bill: string, name: string, satang: number): PartyAdditionalBill['charges'][number] => ({
  additionalBillId: bill, id, kind: 'fnb', items: [{ name, qty: 1, lineTotalSatang: satang }], totalSatang: satang,
  chargedBy: 'ZZ TEST staff', chargedById: 'staff', chargedAt: '2026-11-18T12:00:00Z',
});

export const dishA = charge('charge-a', `${REF}bill-one`, 'ZZ TEST dish A', 2503);
export const drinkB = charge('charge-b', `${REF}bill-two`, 'ZZ TEST drink B', 705);

export const billOne: PartyAdditionalBill = {
  id: `${REF}bill-one`, eventId: 'party', mainSettlementId: 'main', state: 'paid', totalSatang: 2503, paidSatang: 2503, outstandingSatang: 0,
  createdAt: '2026-11-18T12:00:00Z', paidAt: '2026-11-18T12:05:00Z', charges: [dishA],
  payments: [{ additionalBillId: `${REF}bill-one`, id: 'pay-a', amountSatang: 2503, method: 'cash', kind: 'cash', takenBy: null, takenById: null, takenAt: '2026-11-18T12:05:00Z' } as PartyAdditionalBill['payments'][number]],
};

export const billTwo: PartyAdditionalBill = {
  id: `${REF}bill-two`, eventId: 'party', mainSettlementId: 'main', state: 'open', totalSatang: 705, paidSatang: 0, outstandingSatang: 705,
  createdAt: '2026-11-18T12:10:00Z', paidAt: null, charges: [drinkB], payments: [],
};

/** A charge as the tab carries it (`PartyExtraCharge`, in baht). */
export const asTab = (c: PartyAdditionalBill['charges'][number]) => ({
  id: c.id, kind: 'fnb' as const, items: c.items.map((i) => ({ name: i.name, qty: i.qty, lineTotal: i.lineTotalSatang / 100 })),
  total: c.totalSatang / 100, chargedBy: 'ZZ TEST staff', chargedById: 'staff', chargedAt: c.chargedAt,
});

export const settledParty = {
  id: 'zz-party', title: 'ZZ TEST party', childName: 'ZZ TEST child', branchId: 'hkt-central',
  basePrice: 4990, deposit: 1000, packageName: 'ZZ TEST Birthday Package', lineItems: [{ id: 'addon', name: 'ZZ TEST balloon arch', qty: 1, price: 350 }],
  partyExtraCharges: [asTab(dishA), asTab(drinkB)],
  partyPayments: [{ id: 'pay-a', amount: 25.03, method: 'cash', takenBy: 'ZZ TEST staff', takenById: 'staff', takenAt: '2026-11-18T12:05:00Z' }],
  additionalBills: [billOne, billTwo],
  settlement: { state: 'settled', receiptNumber: 'T1-000089', outstandingSatang: 0 },
} as unknown as PartyBooking;
