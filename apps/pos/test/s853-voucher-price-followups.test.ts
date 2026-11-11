import * as React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldSaleButtons } from '@/components/till/HeldSales';
import { StepCustomerType } from '@/components/till/StepCustomerType';
import { StepPayment } from '@/components/till/StepPayment';
import { useCartQuote, type QuoteError } from '@/lib/cartQuote';
import { BOX_LANE_NO_HOLD, HOLD_SHUT_UNSAID, holdButtonReasons } from '@/lib/heldSales';
import { currentLane, setLaneStation } from '@/lib/lane';
import { formatStoredPhone } from '@/lib/phoneUtils';
import { computeLineTotal } from '@/lib/pricing';
import { VOUCHER_ONLINE_ONLY, voucherUnpricedReason } from '@/lib/tillVoucher';
import { getTicketTypes } from '@/store/catalogStore';
import type { CartLine, Member } from '@/types';
import { cartQuote, settle } from './support/fixtures';
import { renderHook } from './support/hooks';

/**
 * SCRUM-853 — THREE THINGS THE SCRUM-847 STAGING PROOF READ OFF THE TILL.
 *
 *   1. With the platform's pricing request failing, the till moved to its
 *      counter box and the payment step read "The voucher price could not be
 *      fetched: Member not found." The box had been asked in the platform's
 *      place and refused the cart over a member it had not heard of yet; its
 *      refusal was printed as the voucher's reason. A box prices no voucher
 *      and is asked only when the platform cannot be reached, so the reason is
 *      the till's "Vouchers can only be redeemed online", whatever the box
 *      said. A refusal the PLATFORM gave keeps the platform's words.
 *   2. Under "Hold sale" the step read "The sale is still being saved — wait a
 *      moment." during the wait and after a refusal, while no sale is written.
 *   3. The member card on "Select Customer Type" printed the number unspaced.
 *
 * Point 1 is driven with nothing of the till replaced but `fetch`: the real
 * quote hook, the real lane arbiter and the real bridge client.
 */
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...await import('./support/hooks') }));

type El = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): El[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';
const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const unmounts: (() => void)[] = [];

const WAITING = 'Waiting for the voucher price...';
const NOT_FETCHED = 'The voucher price could not be fetched';
const WAYS_OUT = 'Go Back to change the order, or Cancel the sale.';
const STILL_SAVING = 'The sale is still being saved — wait a moment.';
const STATION = 'zz-test-till';
const QUOTE_URL = '/api/sales/quote';
const BOX_URL = `/api/box/v1/station/${STATION}/intents`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('React', React);
});
afterEach(() => {
  unmounts.splice(0).forEach(unmount => unmount());
  setLaneStation(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refusal = (status: number, code: string, message: string) => () => json(status, { error: { code, message } });
/** What the browser does when a request reaches nothing. */
const nothingAnswers = () => { throw new TypeError('Failed to fetch'); };

/** `fetch`, answered per address: the platform's pricing route and this till's box. */
function network(answers: { platform: () => Response; box?: () => Response }) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    asked.push(url);
    if (url === QUOTE_URL) return answers.platform();
    if (url === BOX_URL && answers.box) return answers.box();
    throw new Error(`ZZ TEST: no answer set for ${url}`);
  }));
  return asked;
}

const line = (): CartLine => {
  const ticketType = getTicketTypes().find(ticket => ticket.name === 'Full Day Pass')!;
  const value: CartLine = { id: 'zz-test-gift', ticketType, tier: 'tourist', kids: 1, adults: 0,
    socks: 0, addOns: [], lineTotal: 0, voucherGift: true,
    dropOff: { registrationId: 'zz-test-reg', checkInId: 'zz-test-child', childName: 'ZZ TEST child',
      childAge: 7, service: 'drop_off', hours: 8, lengthChosen: true, serviceFeeTHB: 225 } };
  return { ...value, lineTotal: computeLineTotal({ ...value, serviceFeeTHB: 225 }) };
};

/** The payment step over the real quote hook and the real lanes, the voucher held, as the till wires it. */
function payment() {
  const gift = line();
  const mounted = renderHook(() => {
    const cart = useCartQuote({ lines: [gift], discounts: [], manualDiscounts: [],
      identity: { branchId: 'zz-park', stationId: STATION, tier: 'tourist', accountId: 'zz-staff', accountName: 'ZZ TEST' },
      promoCodes: ['ZZTEST853'] });
    const pricePending = cart.quote.source !== 'platform';
    const priceUnavailable = voucherUnpricedReason({ quote: cart.quote, pending: cart.pending, error: cart.error, offline: false });
    const screen = StepPayment({ total: cart.totals.total, selectedMethod: null, onSelectMethod: vi.fn(),
      onComplete: vi.fn(), onBack: vi.fn(), pricePending, priceUnavailable });
    return { cart, screen };
  });
  unmounts.push(mounted.unmount);
  return { ...mounted, text: () => words(mounted.result.current.screen) };
}

/** Past the quote's debounce, and through every request it sets off. */
async function asked() {
  await vi.advanceTimersByTimeAsync(200);
  await settle();
  await vi.advanceTimersByTimeAsync(0);
  await settle();
}

describe('SCRUM-853 (1): a counter box’s refusal is never the voucher’s price reason', () => {
  it('the platform unreachable and the box refusing the member: "Vouchers can only be redeemed online"', async () => {
    setLaneStation(STATION);
    const urls = network({ platform: nothingAnswers, box: refusal(404, 'NOT_FOUND', 'Member not found') });
    const view = payment();
    expect(view.text()).toContain(WAITING);
    await asked();
    // The platform was asked first, nothing answered, and the box was asked in its place.
    expect(urls).toEqual([QUOTE_URL, BOX_URL]);
    expect(currentLane()).toBe('box');
    // The quote hook keeps the box's answer as the box's: other notes name who refused.
    expect(view.result.current.cart.error).toEqual({ kind: 'refusal', status: 404, code: 'NOT_FOUND', message: 'Member not found', answeredBy: 'box' });
    expect(view.text()).toContain(`${NOT_FETCHED}: ${VOUCHER_ONLINE_ONLY}. ${WAYS_OUT}`);
    expect(view.text()).not.toContain('Member not found');
    expect(view.text()).not.toContain(WAITING);
    expect(view.text()).toContain('Amount Due—');
  });

  it('whatever the box answered — its own voucher refusal, a missing catalogue, a failure of its own', async () => {
    for (const box of [
      refusal(409, 'VOUCHER_NEEDS_INTERNET', 'Vouchers need the internet — take this one when the connection is back'),
      refusal(409, 'BOX_CATALOGUE_MISSING', 'This counter has no copy of the prices yet — connect it to the internet once.'),
      () => new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' }),
    ]) {
      setLaneStation(STATION);
      network({ platform: nothingAnswers, box });
      const view = payment();
      await asked();
      expect(view.result.current.cart.error?.answeredBy).toBe('box');
      expect(view.text()).toContain(`${NOT_FETCHED}: ${VOUCHER_ONLINE_ONLY}. ${WAYS_OUT}`);
      view.unmount();
      setLaneStation(null);
    }
  });

  it('a till already working through its box asks only the box, and says the same', async () => {
    setLaneStation(STATION);
    network({ platform: nothingAnswers, box: refusal(404, 'NOT_FOUND', 'Member not found') });
    const first = payment();
    await asked();
    first.unmount();
    expect(currentLane()).toBe('box');
    const urls = network({ platform: nothingAnswers, box: refusal(404, 'NOT_FOUND', 'Member not found') });
    const view = payment();
    await asked();
    expect(urls).toEqual([BOX_URL]);
    expect(view.text()).toContain(`${NOT_FETCHED}: ${VOUCHER_ONLINE_ONLY}. ${WAYS_OUT}`);
  });

  it('neither the platform nor the box answering is the no-box offline case, as before', async () => {
    setLaneStation(STATION);
    const urls = network({ platform: nothingAnswers, box: nothingAnswers });
    const view = payment();
    await asked();
    expect(urls).toEqual([QUOTE_URL, BOX_URL]);
    expect(view.result.current.cart.error).toBeNull();
    expect(view.result.current.cart.quote.unanswered).toBe(true);
    expect(view.text()).toContain(`${NOT_FETCHED}: ${VOUCHER_ONLINE_ONLY}. ${WAYS_OUT}`);
  });

  it('a refusal the PLATFORM gave keeps the platform’s words, and the box is not asked', async () => {
    setLaneStation(STATION);
    const urls = network({ platform: refusal(409, 'VOUCHER_NOT_HELD', 'Scan the voucher at this till first — it is not held for this sale') });
    const view = payment();
    await asked();
    expect(urls).toEqual([QUOTE_URL]);
    expect(currentLane()).toBe('platform');
    expect(view.result.current.cart.error).toEqual({ kind: 'refusal', status: 409, code: 'VOUCHER_NOT_HELD',
      message: 'Scan the voucher at this till first — it is not held for this sale' });
    expect(view.text()).toContain(`${NOT_FETCHED}: Scan the voucher at this till first — it is not held for this sale. ${WAYS_OUT}`);
    expect(view.text()).not.toContain(VOUCHER_ONLINE_ONLY);
  });

  it('the platform saying "Member not found" itself is still the platform’s answer', async () => {
    setLaneStation(STATION);
    network({ platform: refusal(404, 'NOT_FOUND', 'Member not found') });
    const view = payment();
    await asked();
    expect(view.result.current.cart.error?.answeredBy).toBeUndefined();
    expect(view.text()).toContain(`${NOT_FETCHED}: Member not found. ${WAYS_OUT}`);
  });

  it('the sentence, by who answered', () => {
    const fromPlatform: QuoteError = { kind: 'refusal', status: 404, code: 'NOT_FOUND', message: 'Member not found' };
    const fromBox: QuoteError = { ...fromPlatform, answeredBy: 'box' };
    const unpriced = cartQuote(1315, { source: 'till' });
    expect(voucherUnpricedReason({ quote: unpriced, pending: false, error: fromBox, offline: false })).toBe(VOUCHER_ONLINE_ONLY);
    expect(voucherUnpricedReason({ quote: unpriced, pending: false, error: fromPlatform, offline: false })).toBe('Member not found');
    // Still nothing to say while the platform is being asked, or once it has priced the cart.
    expect(voucherUnpricedReason({ quote: unpriced, pending: true, error: fromBox, offline: false })).toBeNull();
    expect(voucherUnpricedReason({ quote: cartQuote(0), pending: false, error: fromBox, offline: false })).toBeNull();
  });
});

describe('SCRUM-853 (2): Hold sale does not say a sale is being saved while the voucher price is not in', () => {
  const base = {
    saleId: null,
    online: true,
    paymentInProgress: false,
    paidSatang: 0,
    outstandingSatang: 131_500,
    canHold: true,
  };
  const buttons = (reasons: { hold: string | null; partPaid: string | null }) => {
    const drawn = HoldSaleButtons({ holdReason: reasons.hold, partPaidReason: reasons.partPaid, onHold: vi.fn(), onSavePartPaid: vi.fn() });
    const all = elements(drawn);
    const button = (label: string) => all.find(el => typeof el.props.onClick === 'function' && words(el.props.children) === label)!;
    return { text: words(drawn), hold: button('Hold sale'), partPaid: button('Save as partly paid'),
      lines: all.filter(el => el.props['data-testid'] === 'hold-sale-reason' || el.props['data-testid'] === 'part-paid-reason') };
  };

  it('the price pending or unavailable: both buttons stay shut and nothing is written under them', () => {
    const reasons = holdButtonReasons({ ...base, awaitingPrice: true });
    expect(reasons).toEqual({ hold: HOLD_SHUT_UNSAID, partPaid: HOLD_SHUT_UNSAID });
    const drawn = buttons(reasons);
    expect(drawn.hold.props.disabled).toBe(true);
    expect(drawn.partPaid.props.disabled).toBe(true);
    expect(drawn.lines).toEqual([]);
    expect(drawn.text).toBe('Hold saleSave as partly paid');
  });

  it('its normal case is as it was: a sale on its way to being written says so', () => {
    for (const awaitingPrice of [false, undefined]) {
      const reasons = holdButtonReasons({ ...base, ...(awaitingPrice === undefined ? {} : { awaitingPrice }) });
      expect(reasons).toEqual({ hold: STILL_SAVING, partPaid: STILL_SAVING });
      const drawn = buttons(reasons);
      expect(drawn.hold.props.disabled).toBe(true);
      expect(drawn.lines.map(words)).toEqual([STILL_SAVING, STILL_SAVING]);
    }
  });

  it('every other reason is given as before, the wait or not', () => {
    const waiting = { ...base, awaitingPrice: true };
    expect(holdButtonReasons({ ...waiting, canHold: false }).hold).toBe('Your role cannot hold sales — ask a manager.');
    expect(holdButtonReasons({ ...waiting, boxLane: true }).hold).toBe(BOX_LANE_NO_HOLD);
    expect(holdButtonReasons({ ...waiting, online: false }).hold).toBe('Holding a sale needs the connection — reconnect, or take the payment now.');
    // A sale that is written is held, paid or refused exactly as it is without the flag.
    const saleId = '0192f000-0000-7000-8000-00000000d853';
    for (const more of [{}, { paymentInProgress: true }, { outstandingSatang: 0 }, { paidSatang: 20_000 }]) {
      expect(holdButtonReasons({ ...waiting, saleId, ...more })).toEqual(holdButtonReasons({ ...base, saleId, ...more }));
    }
    expect(holdButtonReasons({ ...waiting, saleId })).toEqual({
      hold: null,
      partPaid: 'Take a part payment first — nothing has been paid on this sale yet.',
    });
  });

  it('the till passes the one flag the payment step waits on, and the phone till has no voucher to wait for', () => {
    expect(src('pages/Till.tsx')).toMatch(/const holdReasons = holdButtonReasons\(\{[\s\S]{0,1200}\n {4}awaitingPrice: voucherPricePending,\n {2}\}\);/);
    expect(src('components/mobile/MobileTill.tsx')).not.toContain('awaitingPrice');
    expect(src('components/mobile/MobileTill.tsx')).not.toContain('useTillVoucher');
  });
});

describe('SCRUM-853 (3): the member card on Select Customer Type prints the number in the till’s one format', () => {
  const member = (phone: string): Member => ({ id: 'zz-test-member', phone, nickname: 'ZZ TEST guardian' });
  const card = (m: Member | null) => words(StepCustomerType({ member: m, selectedTier: 'tourist', onPickTier: vi.fn(), onRequestVerify: vi.fn() }));

  it('a saved member’s number is grouped, however it was stored', () => {
    for (const stored of ['+66898020047', '0898020047', '+660898020047']) {
      const text = card(member(stored));
      expect(text).toContain('ZZ TEST guardian+66 89 802 0047');
      expect(text).not.toContain(stored);
    }
    expect(formatStoredPhone('+66898020047')).toBe('+66 89 802 0047');
  });

  it('display only: the member is not rewritten, and a walk-in has no card', () => {
    const saved = member('+66898020047');
    card(saved);
    expect(saved.phone).toBe('+66898020047');
    expect(card(null)).toContain('Walk-in (no member)');
    const step = src('components/till/StepCustomerType.tsx');
    expect(step).toContain('{formatStoredPhone(member.phone)}');
    expect(step).not.toContain('{member.phone}');
  });
});
