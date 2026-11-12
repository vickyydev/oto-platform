import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';
vi.mock('react', () => import('./support/hooks'));
const mock = vi.hoisted(() => ({ lease: vi.fn(), renew: vi.fn(), session: vi.fn(), publish: vi.fn(), release: vi.fn(), watch: vi.fn(), get: vi.fn() }));
vi.mock('@/api/bridge', () => ({ bridgeApi: mock, watchBridgeSnapshots: mock.watch, hasBridgeOrigin: () => false }));
vi.mock('@/api/client', async () => ({ ...await vi.importActual('@/api/client'), api: { get: mock.get } }));
vi.mock('@/lib/lane', () => ({ currentLane: () => 'platform', isBoxLaneTrigger: () => false }));
import { readTicketDisplayView, ticketDisplayCovers, ticketDisplayPresentation, useTicketDisplay, type TicketDisplayState } from '@/lib/displaySession';
import type { DisplayPayment } from '@oto/shared';
import { phoneTillInlineDisplay } from '@/lib/phoneTillDisplay';
import type { Sale } from '@/types';
import { renderHook } from './support/hooks';
import { cartQuote, settle } from './support/fixtures';

/**
 * SCRUM-869 — THE PAIRED DISPLAY KEEPS THE ORDER WHILE A PRICE IS REFRESHED.
 *
 * Every tap that changes the ticket order asks the platform for a new quote.
 * For the 200 ms debounce and the round trip the till's quote is its own
 * estimate (`cart.pending`, source `till`), so `displayOnline` is false; at the
 * order stage a presentation with `online: false` is marked unsupported, which
 * the separate display answers with its idle screen and the till answers by
 * drawing the customer half itself. So each edit flashed the welcome screen on
 * the display and jumped the staff layout to the split view and back.
 *
 * Now the order stage is held the way the form steps (7 and 8) already are:
 * while the quote is refreshing nothing is published — the box keeps the last
 * priced order — and a connected display still counts as covering the step.
 * The SCRUM-847 rule stands: the payment stage is not held, and what goes out
 * for a wait there carries no amount.
 */

type Payload = { stage: string; step: number | null; cart: { supported: boolean } | null; totals: { total: number } | null };
let box: StationSessionDocument;
const publishedPayloads = () => mock.publish.mock.calls.map(call => (call[1] as { payload: Payload }).payload);

const sale = (kids: number, total: number): Sale => ({
  id: 'sale-869', operatorId: 'private-staff-id', operatorName: 'Private staff', tier: 'tourist', total,
  lines: [{ id: 'line-1', tier: 'tourist', kids, adults: 1, socks: 0, addOns: [], lineTotal: total,
    ticketType: { id: 'ticket-1', name: '1 Hour Play', durationLabel: '1h', hours: 1,
      prices: { tourist: { weekday: 690, weekend: 690 } }, adultRules: { tourist: { kind: 'free_adults', freeAdults: 1 } } } }],
  manualDiscounts: [], creditGrants: [], bracelets: { adults: 1, children: kids }, createdAt: '', status: 'paid', refunds: [],
});

/** The counter till's display state at the order stage, as `pages/Till.tsx` builds it for `useTicketDisplay`. */
const order = (kids: number, total: number, overrides: Partial<TicketDisplayState> = {}): TicketDisplayState => ({
  stage: 'order', step: 3, sessionKey: 'sale-0', tier: 'tourist', phone: '+66898690001', nickname: 'ZZ TEST guardian',
  contactChannel: 'whatsapp', member: null, sale: sale(kids, total), totals: cartQuote(total).totals, rateMode: 'weekday',
  online: true, quoteRefreshing: false, ...overrides,
});
/** The same order while the platform is asked again: the till's own estimate, which must not be shown. */
const refreshing = (kids: number, estimate: number): TicketDisplayState => order(kids, estimate, { online: false, quoteRefreshing: true });

const payment = (amountSatang: number): DisplayPayment => ({ saleId: null, amountSatang, qrPayload: null,
  qrImageUrl: null, expiresAt: null, status: 'idle', offline: false, online: true });

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  box = { stationId: 'station', boxId: 'box', schemaVersion: 1, sequence: 0, stage: 'identify', language: 'en', lease: null,
    takeoverCount: 0, updatedAt: '2026-11-12T00:00:00.000Z' };
  mock.get.mockResolvedValue({ displays: [{ id: 'display', name: 'ZZ TEST display', connected: true }] });
  mock.lease.mockImplementation(async () => ({ lease: { leaseId: 'lease' }, document: box }));
  mock.session.mockImplementation(async () => ({ document: box }));
  mock.renew.mockImplementation(async () => ({ document: box }));
  mock.publish.mockImplementation(async (_station: string, intent: { payload: Record<string, unknown> }) => {
    box = { ...box, ...intent.payload, sequence: box.sequence + 1 } as StationSessionDocument;
    return { document: box };
  });
  mock.release.mockResolvedValue({ released: true });
  mock.watch.mockImplementation(() => vi.fn());
});
afterEach(() => vi.useRealTimers());

describe('SCRUM-869: the order stage while the platform quote is refreshing', () => {
  it('publishes nothing for the wait, so the box keeps the last priced order, and the till keeps its layout', async () => {
    const hook = renderHook((value: TicketDisplayState) => useTicketDisplay('station', value, vi.fn()), order(1, 690));
    await settle();
    expect(mock.publish).toHaveBeenCalledOnce();
    expect(box.stage).toBe('order');
    expect(readTicketDisplayView(box)?.totals?.total).toBe(690);
    expect(hook.result.current.supported).toBe(true);

    // +1 kid: the till's estimate is on screen while the platform is asked.
    hook.rerender(refreshing(2, 1380));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mock.publish).toHaveBeenCalledOnce();
    expect(box.cart?.supported).toBe(true);
    expect(readTicketDisplayView(box)?.stage).toBe('order');
    expect(readTicketDisplayView(box)?.totals?.total).toBe(690);
    // The display still covers the step: no split view for the length of a quote.
    expect(hook.result.current.supported).toBe(true);

    // The platform's price lands: the new order goes out, priced.
    hook.rerender(order(2, 1380));
    await vi.advanceTimersByTimeAsync(100);
    expect(mock.publish).toHaveBeenCalledTimes(2);
    expect(box.cart?.supported).toBe(true);
    expect(readTicketDisplayView(box)?.totals?.total).toBe(1380);
    expect(hook.result.current.supported).toBe(true);
    hook.unmount();
  });

  it('three quick edits: every frame that reaches the box is a priced order the display can draw', async () => {
    const hook = renderHook((value: TicketDisplayState) => useTicketDisplay('station', value, vi.fn()), order(1, 690));
    await settle();
    const seen: number[] = [];
    for (const [kids, total] of [[2, 1380], [3, 2070], [2, 1380]] as const) {
      hook.rerender(refreshing(kids, total));
      await vi.advanceTimersByTimeAsync(300);
      seen.push(readTicketDisplayView(box)?.totals?.total ?? -1);
      expect(hook.result.current.supported).toBe(true);
      hook.rerender(order(kids, total));
      await vi.advanceTimersByTimeAsync(100);
      seen.push(readTicketDisplayView(box)?.totals?.total ?? -1);
    }
    // What the display read at each moment: the previous price during each
    // wait, the new one after it, and never nothing.
    expect(seen).toEqual([690, 1380, 1380, 2070, 2070, 1380]);
    const frames = publishedPayloads();
    expect(frames).toHaveLength(4);
    for (const frame of frames) {
      expect(frame.stage).toBe('order');
      expect(frame.cart?.supported).toBe(true);
      expect(readTicketDisplayView({ ...box, ...frame } as StationSessionDocument)).not.toBeNull();
    }
    hook.unmount();
  });

  it('the stateless rule is the one on main: a refresh is held by the hook, not by ticketDisplayCovers', () => {
    expect(ticketDisplayCovers(order(1, 690))).toBe(true);
    // The hook holds the last settled answer through a refresh (see the
    // tests below); the stateless rule reads a refresh as the till's own
    // estimate, as it did before SCRUM-869.
    expect(ticketDisplayCovers(refreshing(2, 1380))).toBe(false);
    // The platform refused, failed or did not answer: the till draws the customer half, as before.
    expect(ticketDisplayCovers(order(1, 690, { online: false, quoteRefreshing: false }))).toBe(false);
    // Offline for real: `quoteRefreshing` is never set, and the till draws it, as before.
    expect(ticketDisplayCovers(order(1, 690, { online: false }))).toBe(false);
    // The payment stage is not held (SCRUM-847): a refresh there is not covered.
    expect(ticketDisplayCovers(order(1, 690, { stage: 'payment', step: 5, online: false, quoteRefreshing: true, payment: payment(69_000) }))).toBe(false);
    const page = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'lib', 'displaySession.ts'), 'utf8');
    expect(page).toContain('supported: ticketDisplayCovers(state),');
  });

  it('a refused order stays on the split view through every refresh: the hold keeps the last settled answer', async () => {
    const refused = order(1, 690, { online: false, quoteRefreshing: false });
    const hook = renderHook((value: TicketDisplayState) => useTicketDisplay('station', value, vi.fn()), refused);
    await settle();
    const seen: boolean[] = [hook.result.current.supported];
    for (const kids of [2, 3, 2]) {
      hook.rerender(refreshing(kids, kids * 690));
      await vi.advanceTimersByTimeAsync(300);
      seen.push(hook.result.current.supported);
      hook.rerender(order(kids, kids * 690, { online: false, quoteRefreshing: false }));
      await vi.advanceTimersByTimeAsync(100);
      seen.push(hook.result.current.supported);
    }
    expect(seen).toEqual([false, false, false, false, false, false, false]);
    // Nothing priced ever reached the box: the display drew no amount.
    for (const frame of publishedPayloads()) expect(frame.cart?.supported).not.toBe(true);
    hook.unmount();
  });

  it('the hold follows the latest settled answer: priced, then refused, then priced again', async () => {
    const hook = renderHook((value: TicketDisplayState) => useTicketDisplay('station', value, vi.fn()), order(1, 690));
    await settle();
    const seen: boolean[] = [hook.result.current.supported];
    hook.rerender(refreshing(2, 1380)); await vi.advanceTimersByTimeAsync(300); seen.push(hook.result.current.supported);
    hook.rerender(order(2, 1380, { online: false })); await vi.advanceTimersByTimeAsync(100); seen.push(hook.result.current.supported);
    hook.rerender(refreshing(3, 2070)); await vi.advanceTimersByTimeAsync(300); seen.push(hook.result.current.supported);
    hook.rerender(order(3, 2070)); await vi.advanceTimersByTimeAsync(100); seen.push(hook.result.current.supported);
    hook.rerender(refreshing(2, 1380)); await vi.advanceTimersByTimeAsync(300); seen.push(hook.result.current.supported);
    expect(seen).toEqual([true, true, false, false, true, true]);
    hook.unmount();
  });

  it('the phone till selling offline: a refresh never hides the hand-to-customer overlay and brings it back', async () => {
    // `MobileTill` passes `quoteRefreshing: cart.pending` with no offline
    // gate; offline the platform never prices, so the display never covers.
    const offline = order(1, 690, { step: 2, online: false, quoteRefreshing: false });
    const hook = renderHook((value: TicketDisplayState) => useTicketDisplay('station', value, vi.fn()), offline);
    await settle();
    const overlay: boolean[] = [phoneTillInlineDisplay(hook.result.current)];
    for (const kids of [2, 3]) {
      hook.rerender(order(kids, kids * 690, { step: 2, online: false, quoteRefreshing: true }));
      await vi.advanceTimersByTimeAsync(300);
      overlay.push(phoneTillInlineDisplay(hook.result.current));
      hook.rerender(order(kids, kids * 690, { step: 2, online: false, quoteRefreshing: false }));
      await vi.advanceTimersByTimeAsync(100);
      overlay.push(phoneTillInlineDisplay(hook.result.current));
    }
    expect(hook.result.current.connected.length).toBe(1);
    expect(overlay).toEqual([true, true, true, true, true]);
    hook.unmount();
  });
});

describe('SCRUM-869: the SCRUM-847 rule stands at the payment stage', () => {
  it('a refresh at the payment stage is not held: what goes out carries no figure the display will show', async () => {
    const priced = order(1, 690, { stage: 'payment', step: 5, payment: payment(69_000) });
    const hook = renderHook((value: TicketDisplayState) => useTicketDisplay('station', value, vi.fn()), priced);
    await settle();
    expect(readTicketDisplayView(box)?.payment?.amountSatang).toBe(69_000);
    hook.rerender({ ...priced, online: false, quoteRefreshing: true, sale: sale(1, 590), totals: cartQuote(590).totals, payment: payment(59_000) });
    await vi.advanceTimersByTimeAsync(100);
    expect(mock.publish).toHaveBeenCalledTimes(2);
    // Unsupported: the display shows its own "Please follow the staff screen", never a stale amount to pay.
    expect(box.cart?.supported).toBe(false);
    expect(readTicketDisplayView(box)).toBeNull();
    expect(hook.result.current.supported).toBe(false);
    hook.unmount();
  });

  it('the voucher price wait still sends no sale, totals or payment', () => {
    const held = ticketDisplayPresentation(order(1, 690, { stage: 'payment', step: 5, payment: payment(69_000), pricePending: true }), 'prompt-1');
    expect(held).toEqual({ stage: 'payment', step: 5, cart: { supported: false, sale: { tier: 'tourist' } },
      member: null, totals: null, payment: null, prompt: null });
    expect(JSON.stringify(held)).not.toMatch(/\d{3,}/);
  });
});
