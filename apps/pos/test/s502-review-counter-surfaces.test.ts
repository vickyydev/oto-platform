import * as React from 'react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_CHECKIN_INTENTS, type BandStayView, type BridgeWalletBalance } from '@oto/shared';
import { api, ApiError, NetworkError } from '@/api/client';
import { answeredByBox, bridgeApi } from '@/api/bridge';
import { salesApi } from '@/api/sales';
import { currentLane, refreshLane, setLaneStation } from '@/lib/lane';
import { quoteErrorOf } from '@/lib/cartQuote';
import { loadScannedTab } from '@/components/fnb/ScanWristband';
import { QuoteRefusalNote } from '@/components/fnb/QuoteRefusalNote';
import { FnbCart } from '@/components/fnb/FnbCart';
import { FnbConfirmation } from '@/components/fnb/FnbConfirmation';
import type { FnbOrder, FnbOrderLine, MenuItem } from '@/types';

/**
 * SCRUM-503 REVIEW — the counter's own screens, attacked from the till's side.
 *
 *   4  the switch must move the scan exactly as a real outage does — the same
 *      box answer for a dropped link and for the switch — and nothing that is
 *      not the switch may move it; switched back, the next scan is the
 *      platform's again;
 *   5  the lead-in must name the box only when the box really answered, through
 *      the same lane wrapper the station prices with;
 *   6  the prepaid name must be legible on the light surface it is drawn on,
 *      measured from the real tokens (`src/index.css`) and the real palette
 *      (Tailwind's own `theme.css`), with the prototype's ink kept for dark.
 */

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.restoreAllMocks();
});
afterEach(() => {
  setLaneStation(null);
  vi.unstubAllGlobals();
});

const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/&#x27;/g, "'");
const USED_UP = "Mint's prepaid Hot dog has already been served.";
const KEY = 'S502-REVIEW-BAND';

const stay: BandStayView = {
  checkinId: '01a0f899-49d8-70f6-81d8-52e8e5c21400',
  branchId: 'b',
  childName: 'Mint',
  allergiesMedical: 'Peanuts',
  foodRestrictions: 'No pork',
  mayOrderFood: true,
  foodProvision: {
    mode: 'prepaid_items',
    paidSatang: 8_000,
    creditSatang: null,
    items: [{ menuItemId: 'hotdog', menuItemName: 'Hot dog', unitSatang: 8_000, qty: 1, redeemedQty: 0 }],
  },
};
const wallet: BridgeWalletBalance = {
  walletId: '01a0f899-49d8-70f6-81d8-52e8e5c213ff', balanceSatang: 10_000, capLeftSatang: 30_000, capSatang: 30_000,
  spendableSatang: 10_000, snapshotAt: '2026-10-07T03:00:00.000Z', source: 'snapshot',
};

/** The box's two answers to a scan: the stay, then the credit. */
function boxAnswers() {
  return vi.spyOn(bridgeApi, 'intent').mockImplementation(async (_station, type) =>
    type === BRIDGE_CHECKIN_INTENTS.bandFood
      ? { document: {} as never, result: { stay, cacheAppliedAt: '2026-10-07T03:00:00.000Z' } }
      : { document: {} as never, result: { wallet } },
  );
}

// --- 4 ---------------------------------------------------------------------------------

describe('4 — the switch moves the scan exactly as a real outage does', () => {
  it('a dropped link and the Console’s switch open the same tab from the box', async () => {
    const outcomes = [];
    for (const failure of [new NetworkError(new Error('ECONNRESET')), new ApiError(503, 'STATION_FORCED_OFFLINE', 'forced')]) {
      setLaneStation(null);
      setLaneStation('station-1');
      vi.restoreAllMocks();
      vi.spyOn(api, 'get').mockRejectedValue(failure);
      const intent = boxAnswers();
      const found = await loadScannedTab(KEY);
      expect(intent).toHaveBeenCalledWith('station-1', BRIDGE_CHECKIN_INTENTS.bandFood, { key: KEY });
      expect(currentLane()).toBe('box');
      outcomes.push(found);
    }
    expect(outcomes[0]!.error).toBeNull();
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[1]!.wristband).toMatchObject({ holderName: 'Mint', allergiesMedical: 'Peanuts', creditBalanceTHB: 100 });
  });

  it('a 503 that is not the switch stays on the platform, in the platform’s words', async () => {
    setLaneStation('station-1');
    vi.spyOn(api, 'get').mockRejectedValue(new ApiError(503, 'SERVICE_UNAVAILABLE', 'The platform is restarting'));
    const intent = boxAnswers();
    const found = await loadScannedTab(KEY);
    expect(intent).not.toHaveBeenCalled();
    expect(currentLane()).toBe('platform');
    expect(found).toEqual({ wristband: null, error: 'The platform could not look this band up: The platform is restarting' });
  });

  it('switched back: once the box says the platform is the lane again, the next scan is the platform’s', async () => {
    setLaneStation('station-1');
    vi.spyOn(api, 'get').mockRejectedValueOnce(new ApiError(503, 'STATION_FORCED_OFFLINE', 'forced'));
    boxAnswers();
    await loadScannedTab(KEY);
    expect(currentLane()).toBe('box');

    vi.spyOn(bridgeApi, 'status').mockResolvedValue({ link: { up: true, offline: false, lane: 'platform' } } as never);
    expect(await refreshLane()).toBe('platform');
    vi.restoreAllMocks();
    const get = vi.spyOn(api, 'get').mockResolvedValue({ wallet: null, ledger: [], stay });
    const intent = vi.spyOn(bridgeApi, 'intent');
    const found = await loadScannedTab(KEY);
    expect(get).toHaveBeenCalledTimes(1);
    expect(String(get.mock.calls[0]![0])).toMatch(/^\/wallets\/scan\?/);
    expect(intent).not.toHaveBeenCalled();
    expect(found.wristband).toMatchObject({ holderName: 'Mint', allergiesMedical: 'Peanuts' });
  });
});

// --- 5 ---------------------------------------------------------------------------------

describe('5 — the lead-in names the box only when the box answered', () => {
  const boxSays = (status: number, code: string, message: string) =>
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'content-type': 'application/json' } })));

  it('the switch moves the quote to the box, the box refuses, and the note names the counter’s box with the box’s own words', async () => {
    setLaneStation('station-1');
    const post = vi.spyOn(api, 'post').mockRejectedValue(new ApiError(503, 'STATION_FORCED_OFFLINE', 'forced'));
    boxSays(409, 'PREPAID_USED_UP', USED_UP);
    const err = await salesApi.quote({} as never).catch((e: unknown) => e);
    expect(post).toHaveBeenCalledTimes(1);
    expect(currentLane()).toBe('box');
    expect(err).toBeInstanceOf(ApiError);
    expect(answeredByBox(err)).toBe(true);
    const quoteError = quoteErrorOf(err, 'The platform did not price this order.');
    expect(quoteError).toEqual({ kind: 'refusal', status: 409, code: 'PREPAID_USED_UP', message: USED_UP, answeredBy: 'box' });
    const note = html(React.createElement(QuoteRefusalNote, { error: quoteError, blocking: true }));
    expect(note).toContain(`This counter’s box refused this order:</span> ${USED_UP}`);
    // The note keeps its shape and ink: the rose panel, the warning, the blocking line.
    expect(note).toContain('border-rose-500/40 bg-rose-500/10');
    expect(note).toContain('text-rose-700 dark:text-rose-200');
    expect(note).toContain('Fix this to charge — the sale would be refused for the same reason.');
  });

  it('the platform’s own refusal on the platform lane still says the platform', async () => {
    setLaneStation('station-1');
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(409, 'PREPAID_USED_UP', USED_UP));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const err = await salesApi.quote({} as never).catch((e: unknown) => e);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(currentLane()).toBe('platform');
    expect(answeredByBox(err)).toBe(false);
    const note = html(React.createElement(QuoteRefusalNote, { error: quoteErrorOf(err, 'x') }));
    expect(note).toContain(`The platform refused this order:</span> ${USED_UP}`);
    expect(note).not.toContain('box');
  });

  it('a box that faults is a fault, not a refusal — the refusal note’s lead-in never speaks for it', async () => {
    setLaneStation('station-1');
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(503, 'STATION_FORCED_OFFLINE', 'forced'));
    boxSays(500, 'INTERNAL', 'The box could not answer that');
    const err = await salesApi.quote({} as never).catch((e: unknown) => e);
    expect(quoteErrorOf(err, 'x').kind).toBe('fault');
  });
});

// --- 6 ---------------------------------------------------------------------------------

/** WCAG 2 contrast from the real tokens, not a guess. */
const require = createRequire(import.meta.url);
const tokensCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const paletteCss = readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8');

type Rgb = [number, number, number];
function token(block: ':root' | '.dark', name: string): Rgb {
  const start = block === ':root' ? tokensCss.indexOf(':root,') : tokensCss.indexOf('\n.dark {');
  const body = tokensCss.slice(start, tokensCss.indexOf('}', start));
  const m = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(body);
  if (!m) throw new Error(`no --${name} in ${block}`);
  const [h, s, l] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
function violet(shade: number): Rgb {
  const m = new RegExp(`--color-violet-${shade}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(paletteCss);
  if (!m) throw new Error(`no violet-${shade}`);
  const [L, C, H] = [Number(m[1]) / 100, Number(m[2]), Number(m[3])];
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const enc = (x: number) => {
    const v = Math.min(1, Math.max(0, x));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return [
    enc(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
    enc(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
    enc(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
  ];
}
const over = (fg: Rgb, bg: Rgb, alpha: number): Rgb => fg.map((v, i) => v * alpha + bg[i]! * (1 - alpha)) as Rgb;
function contrast(a: Rgb, b: Rgb): number {
  const lin = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  const lum = (c: Rgb) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('6 — the prepaid name is legible where it is drawn, and the prototype’s ink stays for dark', () => {
  const item = (id: string, name: string): MenuItem => ({ id, name, price: 80, category: 'food' }) as unknown as MenuItem;
  const prepaidLine: FnbOrderLine = { id: 'l-2', menuItem: item('hotdog', 'Hot dog'), qty: 1, selectedModifiers: [], lineTotal: 0, isPrepaid: true, prepaidStayId: 's' };
  const juiceLine: FnbOrderLine = { id: 'l-1', menuItem: item('juice', 'Juice'), qty: 1, selectedModifiers: [], lineTotal: 50 };
  const noop = () => undefined;

  const nameClasses = (markup: string) => (/<span class="([^"]*)">Hot dog<\/span>/.exec(markup)?.[1] ?? '').split(' ');

  it('the order panel and the confirmation draw it in the surface’s own ink, with violet-100 only behind dark:', () => {
    const cart = html(React.createElement(FnbCart, {
      wristband: null, lines: [juiceLine, prepaidLine], total: 50, manualDiscounts: [], manualAmounts: {},
      taxBreakdown: { netSubtotal: 50, discountTotal: 0, serviceChargeTotal: 0, exclusiveTaxTotal: 0, inclusiveTaxTotal: 0, taxTotal: 0, categories: [], grandTotal: 50 },
      onChangeQty: noop, onEditLine: noop, onClear: noop, onCheckout: noop, onSwitchTab: noop,
      onAddManualDiscount: noop, onRemoveManualDiscount: noop,
    }));
    const order = {
      id: 'o-1', operatorId: 'op', operatorName: 'Som', lines: [juiceLine, prepaidLine], manualDiscounts: [], total: 50,
      pickupCode: '42', payment: { creditUsed: 0, cash: 50, card: 0, promptpay: 0 }, createdAt: '2026-10-07T03:00:00.000Z',
      status: 'completed', refunds: [],
    } as unknown as FnbOrder;
    const confirmation = html(React.createElement(FnbConfirmation, { order, newBalance: null as never, onNewOrder: noop }));
    for (const markup of [cart, confirmation]) {
      const classes = nameClasses(markup);
      expect(classes).toContain('text-foreground');
      expect(classes).toContain('dark:text-violet-100');
      expect(classes).not.toContain('text-violet-100');
      // The rest of the prepaid look is the prototype's, untouched.
      expect(markup).toContain('bg-violet-500/10');
      expect(markup).toContain('bg-violet-500/30 text-violet-300');
    }
  });

  it('measured: the light ink clears WCAG AA on the tinted row over either light surface; the old ink did not; dark keeps the prototype’s', () => {
    const row = violet(500);
    for (const surface of ['card', 'background'] as const) {
      const tinted = over(row, token(':root', surface), 0.1);
      expect(contrast(token(':root', 'foreground'), tinted)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(violet(100), tinted)).toBeLessThan(1.5);
      const darkTinted = over(row, token('.dark', surface), 0.1);
      expect(contrast(violet(100), darkTinted)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
