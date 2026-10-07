import * as React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { partyBillOf, type EventView, type PartyChargeView, type PartyPaymentView } from '@oto/shared';
import { toOtoEvent } from '@/api/events';
import { PartySettlementCustomerScreen } from '@/components/parties/PartySettlementCustomerScreen';
import { LanguageProvider } from '@/i18n/LanguageContext';
import { computePartyOutstanding, computePartyTotal, partyPaymentsTotal } from '@/lib/party';
import type { PartyBooking } from '@/types';

/**
 * S2-20 E4 — REVIEW, the party screens against the platform's bill and the
 * prototype's words (SCRUM-217; events-kiosk PLAN, the E4 row of §9, Q3).
 *
 *   - THE SETTLEMENT CUSTOMER SCREEN tells the platform's story to the satang:
 *     a tab with awkward satang (an F&B charge with a discount, a walk-up, two
 *     payments) is shown in its review stage with the bill's own total,
 *     deposit, payments and outstanding, and its thank-you after a payment
 *     with the payment the platform recorded and the balance it left — in the
 *     prototype's words (`party.review.*`, `party.thankyou.*`).
 *   - THE E1 GATES are gone exactly where E4 builds the action — PartyDetail's
 *     edit, tickets, F&B and balance; the phone's payment and F&B — and stay
 *     where E3 builds it: check-in, check-out and reprint on the phone's party
 *     screen and on both Check-in boards.
 *
 * The presses (refusal, lost answer, two tills) are
 * `test/s220-e4-review-press.test.ts`.
 */

Object.assign(globalThis, { React });

const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';
const PARTY = '0190a0a0-0000-7000-8000-0000000e0e42';
const T = '2026-11-04';

const text = (el: React.ReactElement) =>
  renderToStaticMarkup(React.createElement(LanguageProvider, { children: el }))
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const charges: PartyChargeView[] = [
  {
    id: 'c-fnb',
    kind: 'fnb',
    items: [
      { name: 'Pad Thai', qty: 3, lineTotalSatang: 46_500 },
      { name: 'Mango smoothie', qty: 2, lineTotalSatang: 23_000 },
    ],
    // 10% off ฿695 — the prototype's percentage discount leaves satang on the tab.
    totalSatang: 62_550,
    chargedBy: 'Som',
    chargedById: 'acc',
    chargedAt: `${T}T06:00:00.000Z`,
  },
];

function viewWith(payments: PartyPaymentView[]): EventView {
  const walkUps = 45_000;
  const bill = partyBillOf({
    baseSatang: 1_200_000,
    chargesSatang: walkUps + charges.reduce((s, c) => s + c.totalSatang, 0),
    depositSatang: 300_000,
    paidSatang: payments.reduce((s, p) => s + p.amountSatang, 0),
  });
  return {
    id: PARTY,
    branchId: HKT_CENTRAL,
    type: 'party',
    appEventType: 'birthday',
    status: 'upcoming',
    appStatus: 'upcoming',
    archived: false,
    title: "Mali's 6th",
    startDate: T,
    endDate: T,
    cancelledDays: [],
    startTime: '13:00',
    endTime: '16:00',
    location: 'Party room 1',
    expectedKids: 15,
    expectedAdults: 12,
    entryPrice: null,
    party: {
      childName: 'Mali',
      kidTurningAge: 6,
      bookingName: null,
      parentName: 'Nok',
      parentPhone: '+66812345678',
      activities: null,
      decoration: 'Ocean',
      totalValueSatang: 1_200_000,
      depositSatang: 300_000,
      depositDate: T,
      walkUpCharges: [
        { id: 'w1', name: 'Guest', amountSatang: walkUps, chargedBy: 'Som', chargedById: 'acc', chargedAt: `${T}T05:00:00.000Z` },
      ],
      charges,
      payments,
      lastEdited: null,
      editSync: null,
      bill,
    },
    attendeeCount: 0,
    attendees: [],
    roster: { arrived: 0, expected: 0, currentlyIn: 0, outstanding: 0, all: 0 },
  };
}

const paymentOf = (id: string, amountSatang: number): PartyPaymentView => ({
  id,
  amountSatang,
  method: 'card',
  kind: 'card',
  takenBy: 'Som',
  takenById: 'acc',
  takenAt: `${T}T07:00:00.000Z`,
  businessDate: T,
  partyDate: T,
  attemptId: `att-${id}`,
});

const baht = (satang: number) => satang / 100;

describe('the settlement customer screen tells the platform’s story to the satang', () => {
  const before = viewWith([paymentOf('p1', 300_000)]);
  const party = toOtoEvent(before, 'hkt-central') as unknown as PartyBooking;

  it('the bill the till works out is the platform’s, to the satang', () => {
    expect(Math.round(computePartyTotal(party) * 100)).toBe(before.party!.bill!.totalSatang);
    expect(Math.round(computePartyOutstanding(party) * 100)).toBe(before.party!.bill!.outstandingSatang);
    expect(Math.round(partyPaymentsTotal(party) * 100)).toBe(before.party!.bill!.paidSatang);
  });

  it('review: the prototype’s words, with the platform’s total, deposit, payments and outstanding', () => {
    const bill = before.party!.bill!;
    const shown = text(React.createElement(PartySettlementCustomerScreen, { stage: 'review', party, amount: baht(bill.outstandingSatang), method: 'card' }));
    for (const words of ['Your bill', "Mali's 6th", 'Party package', 'Added on the day', 'Total', 'Less deposit paid', 'Less payments made', 'Outstanding due now']) {
      expect(shown).toContain(words);
    }
    expect(shown).toContain(`Total ฿${baht(bill.totalSatang)}`);
    expect(shown).toContain(`Less deposit paid −฿${baht(bill.depositSatang)}`);
    expect(shown).toContain(`Less payments made −฿${baht(bill.paidSatang)}`);
    expect(shown).toContain(`Outstanding due now ฿${baht(bill.outstandingSatang)}`);
    // The walk-up and the charge's lines are on the bill, as charged.
    expect(shown).toContain('Guest');
    expect(shown).toContain('Pad Thai');
  });

  it('thank-you: the payment the platform recorded and the balance it left', () => {
    const recorded = 400_000;
    const after = viewWith([paymentOf('p1', 300_000), paymentOf('p2', recorded)]);
    const settled = toOtoEvent(after, 'hkt-central') as unknown as PartyBooking;
    const shown = text(React.createElement(PartySettlementCustomerScreen, { stage: 'thankyou', party: settled, amount: baht(recorded), method: 'card' }));
    expect(shown).toContain('Payment received');
    expect(shown).toContain(`Paid now ฿${baht(recorded)}`);
    expect(shown).toContain(`Outstanding ฿${baht(after.party!.bill!.outstandingSatang)}`);
    const full = viewWith([paymentOf('p1', 300_000), paymentOf('p2', before.party!.bill!.outstandingSatang)]);
    const done = text(
      React.createElement(PartySettlementCustomerScreen, {
        stage: 'thankyou',
        party: toOtoEvent(full, 'hkt-central') as unknown as PartyBooking,
        amount: baht(before.party!.bill!.outstandingSatang),
        method: 'card',
      }),
    );
    expect(done).toContain('All settled!');
    expect(done).toContain('Outstanding ฿0');
    expect(done).toContain('This party is fully paid. Thank you!');
  });
});

const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

/** A handler's body in a component's source: from its declaration to the next one at the same depth. */
function handler(src: string, name: string): string {
  const at = src.indexOf(`const ${name} =`);
  expect(at, name).toBeGreaterThanOrEqual(0);
  const next = src.indexOf('\n  const ', at + 1);
  return src.slice(at, next < 0 ? undefined : next);
}

describe('the E1 gates: gone exactly where E4 builds the action, kept where E3 builds it', () => {
  it('PartyDetail: edit, tickets, F&B and the balance write to the platform; no "not on the platform yet"', () => {
    const detail = source('components/parties/PartyDetail.tsx');
    expect(detail).not.toMatch(/EVENT_WRITE_PENDING|openUnlessPending|getEventById/);
    for (const action of ['setEditing(true)', 'setShowTickets(true)', 'setShowFnb(true)', 'setShowBalance(true)']) {
      expect(detail).toContain(`openUnlessBlocked(() => ${action}`);
    }
  });

  it('the phone: payment and F&B on the platform; check-in, check-out and reprint still gated for E3', () => {
    const mobile = source('components/mobile/parties/MobileParties.tsx');
    for (const name of ['handleTakePayment', 'handleChargeExtra']) {
      expect(handler(mobile, name)).not.toMatch(/writePending|addParty/);
    }
    for (const name of ['handleEventCheckIn', 'handleEventReprint', 'handleEventCheckOut']) {
      expect(handler(mobile, name)).toMatch(/if \(writePending\(eventId\)\) return;/);
    }
    expect(mobile).toMatch(/onTakePayment=\{\(\) => \{\s*const blocked = blockerOf\(true\);/);
    expect(mobile).toMatch(/onAddFnb=\{\(\) => \{\s*const blocked = blockerOf\(\);/);
  });

  it('both Check-in boards keep their E1 gates (E3’s, untouched by E4)', () => {
    for (const rel of ['pages/DropOff.tsx', 'components/mobile/dropoff/MobileDropOffBoard.tsx']) {
      const board = source(rel);
      expect(board).toContain('EVENT_WRITE_PENDING');
      expect((board.match(/if \(writePending\(eventId\)\) return;/g) ?? []).length).toBe(3);
    }
  });
});
