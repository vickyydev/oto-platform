import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildCartPayload, localQuote, type CartIdentity } from '@/api/sales';
import type { VoucherView } from '@/api/vouchers';
import type { QuotedVoucher } from '@/api/sales';
import { GoldenTicketCard } from '@/components/till/GoldenTicketCard';
import { VoucherCard } from '@/components/till/RedeemVoucher';
import { SoldVoucherCodes } from '@/components/till/SoldVoucherCodes';
import {
  buildGiftTicketLine,
  dropGiftTicketMarks,
  giftTicketChoicesFor,
  giftTicketPackage,
  giftTicketRequestEntitlement,
  isGiftTicket,
  placeGiftTicketLine,
} from '@/lib/giftTicket';
import { computeLineTotal, resolveAdultLine } from '@/lib/pricing';
import { buildCreditGrants, buildPersonGrants } from '@/lib/sale';
import type { HeldVoucher } from '@/lib/tillVoucher';
import type { CartLine, TicketType } from '@/types';

/**
 * SCRUM-798 — THE GOLDEN TICKET ON THE TICKET SCREEN, with a voucher the
 * platform has answered for (mocked here as its lookup answers it).
 *
 * The owner's definition (9 November 2026): full-day entry for one child,
 * free socks if needed; the parent free with an adult band when they stay, or
 * a free drop-off for a child aged 5 or over; under 5 the parent stays; no
 * food voucher. What the till rings up is pinned here; what it is worth is the
 * platform's, and `apps/api/test/golden-ticket.test.ts` pins that.
 */

// The panel is compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });

const FULL_DAY_ID = '0190a0a0-0000-7000-8000-0000000f0798';

/** The park's Full Day Pass as the till's catalogue holds it: every adult earns their ticket back as credit. */
const fullDay: TicketType = {
  id: FULL_DAY_ID,
  name: 'Full Day Pass',
  durationLabel: 'All Day',
  hours: 8,
  prices: { tourist: { weekday: 1090, weekend: 1090 } },
  adultRules: { tourist: { kind: 'set_price', price: { weekday: 350, weekend: 500 } } },
  creditRule: { appliesTo: 'adults', basis: 'full_price' },
  gateAccess: true,
};
const twoHours: TicketType = {
  id: '0190a0a0-0000-7000-8000-0000000f0799',
  name: '2 Hours Play',
  durationLabel: '2 Hours',
  hours: 2,
  prices: { tourist: { weekday: 890, weekend: 890 } },
};

const view: VoucherView = {
  id: '0190a0a0-0000-7000-8000-0000000f079a',
  code: 'T1ABCDEFGHJ',
  source: 'manual',
  state: 'held_here',
  prize: { nameEn: 'Golden Ticket', nameTh: null },
  definitionCode: 'golden-ticket',
  kind: 'free_ticket',
  effect: { type: 'gift_ticket', package: { id: FULL_DAY_ID, name: 'Full Day Pass' }, dropOffMinAge: 5 },
  summary: 'Full Day Pass for one child — parent free, or drop-off from age 5; free socks on request; no food credit',
  issuedAt: '2026-11-09T05:00:00.000Z',
  issuedBooth: null,
  issuedBranch: { id: 'b', name: 'Central Floresta' },
  expiresAt: null,
  legacyFormat: false,
  hold: null,
  redeemableOffline: false,
  staffLabel: null,
  issuedBy: { name: 'Nok', code: 'S-7KMQ' },
};
const held: HeldVoucher = { view, code: view.code, saleId: '0190a0a0-0000-7000-8000-0000000f079b' };

const identity: CartIdentity = {
  branchId: 'branch-1',
  stationId: 'station-1',
  tier: 'tourist',
  accountId: 'account-1',
  accountName: 'Reception',
};

const noop = () => undefined;
const markup = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

describe('the voucher on the cart is a Golden Ticket', () => {
  it('is told from any other voucher by its effect', () => {
    expect(isGiftTicket(held)).toBe(true);
    expect(isGiftTicket({ ...held, view: { ...view, effect: { type: 'free_kids_ticket', package: { id: FULL_DAY_ID, name: 'Full Day Pass' } } } })).toBe(false);
    expect(isGiftTicket(null)).toBe(false);
  });

  it('finds its package on this till by the platform’s id, else by name', () => {
    expect(giftTicketPackage(held, [twoHours, fullDay])).toBe(fullDay);
    const renamedId = { ...fullDay, id: 'local-full-day' };
    expect(giftTicketPackage(held, [twoHours, renamedId])).toBe(renamedId);
    expect(giftTicketPackage(held, [twoHours])).toBeNull();
  });
});

describe('the card shows the gift and asks the age, the choice and the socks', () => {
  const card = (over: Partial<React.ComponentProps<typeof GoldenTicketCard>> = {}) =>
    markup(
      createElement(GoldenTicketCard, { held, ticket: fullDay, onCart: null, onRingUp: noop, ...over }),
    );

  it('names the gift in the owner’s terms', () => {
    const html = card();
    expect(html).toContain('Golden Ticket — what it gives');
    expect(html).toContain('Full Day Pass for one child');
    expect(html).toContain('Parent enters free with an adult band, or drop-off for a child aged 5 or over');
    expect(html).toContain('One free pair of Regular Socks on request');
    expect(html).toContain('No food credit');
    expect(html).toContain('aria-label="Child\'s age"');
    expect(html).toContain('Free pair of Regular Socks');
  });

  it('rings nothing up until the age and the choice are given', () => {
    const html = card();
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="golden-ticket-ring-up"/);
    expect(html).toContain('Ring up the Golden Ticket');
  });

  it('says when the till has no Full Day Pass to ring it up on', () => {
    expect(card({ ticket: null })).toContain('This till has no Full Day Pass to ring the Golden Ticket up on — ask a manager.');
  });

  it('says what is on the sale once rung up', () => {
    expect(card({ onCart: { adults: 1, socks: 1, dropOff: false } })).toContain(
      'On this sale: one child, the parent free, one pair of socks.',
    );
    expect(card({ onCart: { adults: 0, socks: 0, dropOff: true } })).toContain('On this sale: one child, dropped off.');
    expect(card({ onCart: { adults: 1, socks: 0, dropOff: false } })).toContain('Update the Golden Ticket');
  });

  it('offers drop-off from 5 only; under 5 the parent stays', () => {
    expect(giftTicketChoicesFor(null, 5)).toEqual([]);
    expect(giftTicketChoicesFor(4, 5)).toEqual(['parent_stays']);
    expect(giftTicketChoicesFor(5, 5)).toEqual(['parent_stays', 'drop_off']);
    expect(giftTicketRequestEntitlement({ childAgeYears: 3, choice: 'drop_off', socks: false }, 5)).toEqual({
      ok: false,
      reason: 'Drop-off on the Golden Ticket is for a child aged 5 or over — under 5 the parent stays',
    });
    expect(giftTicketRequestEntitlement({ childAgeYears: 3, choice: 'parent_stays', socks: true }, 5)).toMatchObject({
      ok: true,
      freeAdultBand: true,
      dropOff: false,
    });
  });

  it('the voucher’s card shows the platform’s figure for it', () => {
    const quoted: QuotedVoucher = {
      voucherId: view.id,
      code: view.code,
      definitionCode: 'golden-ticket',
      label: 'Golden Ticket (voucher …FGHJ)',
      effect: view.effect,
      amountSatang: 150_000,
      applicable: true,
      reason: null,
    };
    expect(markup(createElement(VoucherCard, { held, quoted }))).toContain('-฿1500');
  });
});

describe('what it rings up', () => {
  it('the parent stays: one child, one adult, socks on request, marked as the gift’s line', () => {
    const line = buildGiftTicketLine(fullDay, 'tourist', { childAgeYears: 4, choice: 'parent_stays', socks: true }, 'gift-1');
    expect(line).toMatchObject({ id: 'gift-1', kids: 1, adults: 1, socks: 1, addOns: [], voucherGift: true });
    expect(line.lineTotal).toBe(computeLineTotal(line));
  });

  it('drop-off: one child and no adult on the line — what sends it through the Drop-Off form', () => {
    const line = buildGiftTicketLine(fullDay, 'tourist', { childAgeYears: 6, choice: 'drop_off', socks: false }, 'gift-2');
    expect(line).toMatchObject({ kids: 1, adults: 0, socks: 0, voucherGift: true });
  });

  it('asking again replaces the gift’s line and leaves the rest of the cart alone', () => {
    const sibling: CartLine = { id: 'sib', ticketType: twoHours, tier: 'tourist', kids: 1, adults: 1, socks: 0, addOns: [], lineTotal: 1240 };
    const first = buildGiftTicketLine(fullDay, 'tourist', { childAgeYears: 6, choice: 'parent_stays', socks: false }, 'gift-3');
    const cart = placeGiftTicketLine([sibling], first);
    expect(cart.map((l) => l.id)).toEqual(['sib', 'gift-3']);
    const second = buildGiftTicketLine(fullDay, 'tourist', { childAgeYears: 6, choice: 'parent_stays', socks: true }, 'gift-3');
    const again = placeGiftTicketLine(cart, second);
    expect(again.map((l) => [l.id, l.socks])).toEqual([['sib', 0], ['gift-3', 1]]);
    expect(dropGiftTicketMarks(again).some((l) => l.voucherGift)).toBe(false);
  });

  it('no food credit: the parent gets a band and earns nothing; the same line without the gift earns', () => {
    const gift = buildGiftTicketLine(fullDay, 'tourist', { childAgeYears: 6, choice: 'parent_stays', socks: false }, 'gift-4');
    expect(buildPersonGrants([gift])).toEqual([
      { role: 'adult', gateAccess: true, creditTHB: 0 },
      { role: 'kid', gateAccess: false, creditTHB: 0 },
    ]);
    expect(buildCreditGrants([gift]).filter((g) => g.type === 'fnb_credit')).toEqual([]);
    const plain = { ...gift, voucherGift: undefined };
    expect(buildCreditGrants([plain]).filter((g) => g.type === 'fnb_credit')).toHaveLength(1);
  });

  it('a second adult who pays on the gift’s line earns their ticket back; the gift’s child and parent still earn nothing', () => {
    const gift = buildGiftTicketLine(fullDay, 'tourist', { childAgeYears: 6, choice: 'parent_stays', socks: false }, 'gift-6');
    const two = { ...gift, adults: 2 };
    // ฿350 on a weekday, ฿500 at the weekend: what the till charges that adult today.
    const adultPrice = resolveAdultLine(fullDay, 'tourist', 1).paidUnit;
    expect([350, 500]).toContain(adultPrice);
    expect(buildPersonGrants([two])).toEqual([
      { role: 'adult', gateAccess: true, creditTHB: 0 },
      { role: 'adult', gateAccess: true, creditTHB: adultPrice },
      { role: 'kid', gateAccess: false, creditTHB: 0 },
    ]);
    expect(buildCreditGrants([two]).filter((g) => g.type === 'fnb_credit').map((g) => g.valueTHB)).toEqual([adultPrice]);
  });

  it('the wire names the gift’s line, with the voucher’s code beside it', () => {
    const gift = buildGiftTicketLine(fullDay, 'tourist', { childAgeYears: 6, choice: 'parent_stays', socks: false }, 'gift-5');
    const payload = buildCartPayload([gift], [], [], identity, localQuote([gift], [], []).satang!, {
      mode: 'weekday',
      promoCodes: [held.code],
    });
    expect(payload.lines[0]).toMatchObject({ packageId: FULL_DAY_ID, kids: 1, adults: 1, voucherGift: true });
    expect(payload.promoCodes).toEqual([held.code]);
    const plain = buildCartPayload([{ ...gift, voucherGift: undefined }], [], [], identity, localQuote([gift], [], []).satang!, {
      mode: 'weekday',
    });
    expect(plain.lines[0]).not.toHaveProperty('voucherGift');
  });
});

describe('the confirmation of the sale that sold it', () => {
  it('shows each code in full, and nothing for a sale that sold none', () => {
    const html = markup(
      createElement(SoldVoucherCodes, {
        vouchers: [
          {
            id: 'v-1',
            code: 'T1ABCDEFGHJ',
            definitionCode: 'golden-ticket',
            nameEn: 'Golden Ticket',
            productId: 'p-1',
            status: 'issued',
            issuedAt: '2026-11-09T05:00:00.000Z',
            expiresAt: null,
          },
        ],
      }),
    );
    expect(html).toContain('Golden Ticket');
    expect(html).toContain('T1ABCDEFGHJ');
    expect(html).toContain('Give this code to the family');
    expect(markup(createElement(SoldVoucherCodes, { vouchers: [] }))).toBe('');
  });
});
