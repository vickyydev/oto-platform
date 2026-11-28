import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';
import { renderHook } from './support/hooks';
import { apiSale } from './support/fixtures';
import { setBridgeOrigin, setBridgeStaffName } from '@/api/bridge';
import type { SaleCartPayload, SaleTenderPayload } from '@/api/sales';
import { readDisplayAnswer } from '@/lib/displaySession';
import { guestLanguageChoice, guestLanguageFor, withGuestLanguage } from '@/lib/guestLanguage';
import { setLaneStation } from '@/lib/lane';
import { useSaleWriter } from '@/lib/saleWriter';

/**
 * SCRUM-1077 — the language the guest chose in this sale goes with the sale,
 * so the gate can show that guest's messages in it.
 *
 * Only a choice made in this sale: the language pressed on the till's own
 * customer half, or the station's language read with a paired display's answer
 * to the first screen (a display shows that screen only after the guest
 * chose). Never the till's own customer language, which starts in English and
 * takes the staff account's at every unlock. Never on a quote. The same cart,
 * language and all, goes to the platform and to the box lane.
 */
vi.mock('react', () => import('./support/hooks'));

const STATION = '018f0000-0000-7000-8000-0000000057a1';
const intentsUrl = `/api/box/v1/station/${STATION}/intents`;
const reply = (data: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;

function cart(): SaleCartPayload {
  return {
    branchId: 'branch-1',
    stationId: STATION,
    channel: 'till',
    tier: 'tourist',
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday pricing',
    socks: { addOnId: 'a-socks', unitSatang: 5_000, label: 'Regular Socks' },
    lines: [
      {
        id: '018f0000-0000-7000-8000-0000000011e1',
        packageId: '018f0000-0000-7000-8000-00000000aa01',
        packageName: '2 Hours Play',
        tier: 'tourist',
        kids: 1,
        adults: 0,
        socks: 0,
        addOns: [],
        lineTotalSatang: 54_000,
      },
    ],
    promos: [],
    manualDiscounts: [],
    expectedTotalSatang: 54_000,
  };
}

const document = (overrides: Partial<StationSessionDocument> = {}): StationSessionDocument => ({
  stationId: STATION, boxId: 'box-1', schemaVersion: 1, sequence: 3, stage: 'identify', language: 'ru', lease: null,
  takeoverCount: 0, updatedAt: '2026-11-26T12:00:00.000Z',
  prompt: { kind: 'identify', requestId: 'prompt-1' },
  ...overrides,
});

const source = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

describe('the choice, kept for its sale only', () => {
  it('keeps one of the five for the sale it was made in, and nothing else', () => {
    const choice = guestLanguageChoice('sale-a', 'ru');
    expect(choice).toEqual({ sale: 'sale-a', language: 'ru' });
    expect(guestLanguageFor(choice, 'sale-a')).toBe('ru');
    // The next guest's sale has a new name: the last guest's choice is not theirs.
    expect(guestLanguageFor(choice, 'sale-b')).toBeNull();
    expect(guestLanguageFor(null, 'sale-a')).toBeNull();
    for (const other of ['de', '', undefined, null, 3]) expect(guestLanguageChoice('sale-a', other)).toBeNull();
  });

  it('puts the language on the cart only when chosen, and leaves the cart as it was otherwise', () => {
    const plain = cart();
    expect(withGuestLanguage(plain, null)).toBe(plain);
    expect('guestLanguage' in withGuestLanguage(plain, null)).toBe(false);
    expect(withGuestLanguage(plain, 'zh')).toEqual({ ...plain, guestLanguage: 'zh' });
    expect('guestLanguage' in plain).toBe(false);
  });
});

describe('a paired display’s first-screen answer carries the station’s language', () => {
  it('on the number and on a skip, never on a later answer', () => {
    const identified = document({ prompt: { kind: 'identify', requestId: 'prompt-1', answer: { type: 'identify', actionId: 'tap-1', phone: '0812345678' } } });
    expect(readDisplayAnswer(identified, 'prompt-1')).toMatchObject({ type: 'identify', phone: '0812345678', language: 'ru' });
    const skipped = document({ language: 'fr', prompt: { kind: 'identify', requestId: 'prompt-1', answer: { type: 'skip_identify', actionId: 'tap-2' } } });
    expect(readDisplayAnswer(skipped, 'prompt-1')).toMatchObject({ type: 'skip_identify', language: 'fr' });
    const details = document({ stage: 'input', prompt: { kind: 'contact', requestId: 'prompt-1', answer: {
      type: 'contact_done', actionId: 'tap-3', phone: '0812345678', nickname: 'Nok', contactChannel: 'line' } } });
    const answer = readDisplayAnswer(details, 'prompt-1');
    expect(answer).toMatchObject({ type: 'contact_done' });
    expect(answer && 'language' in answer).toBe(false);
  });
});

describe('both tills save it with the sale, and only there', () => {
  it('the counter till: from its own customer half’s press and from a paired display’s first answer', () => {
    const till = source('pages/Till.tsx');
    expect(till).toContain('const [guestLanguage, setGuestLanguage] = useState<GuestLanguageChoice | null>(null);');
    expect(till).toContain('setGuestLanguage(guestLanguageChoice(saleKeyRef.current, lang));');
    expect(till).toMatch(/answer\.type === 'identify' && step === 1 && answer\.phone\?\.trim\(\)\) \{\s+\/\/ SCRUM-1077[^\n]*\n\s+const chosen = guestLanguageChoice\(saleKeyRef\.current, answer\.language\);\s+if \(chosen\) setGuestLanguage\(chosen\);/);
    expect(till).toContain('return withGuestLanguage(payload, guestLanguageFor(guestLanguage, saleKeyRef.current));');
    const reset = till.slice(till.indexOf('const resetSale = () => {'));
    expect(reset.slice(0, reset.indexOf('\n  };'))).toContain('setGuestLanguage(null);');
    // The till's own customer language is never what is saved.
    expect(till).not.toMatch(/guestLanguageChoice\([^)]*customerLang/);
  });

  it('the phone till: from a paired display’s first answer', () => {
    const phone = source('components/mobile/MobileTill.tsx');
    expect(phone).toMatch(/if \(\(answer\.type === 'identify' \|\| answer\.type === 'skip_identify'\) && displayStage\.step === 1\) \{\s+const chosen = guestLanguageChoice\(saleKeyRef\.current, answer\.language\);/);
    expect(phone).toContain('return withGuestLanguage(payload, guestLanguageFor(guestLanguage, saleKeyRef.current));');
    const reset = phone.slice(phone.indexOf('const resetSale = () => {'));
    expect(reset.slice(0, reset.indexOf('\n  };'))).toContain('setGuestLanguage(null);');
  });

  it('never on a quote: the cart the quote is asked with does not carry it', () => {
    for (const rel of ['pages/Till.tsx', 'components/mobile/MobileTill.tsx']) {
      const till = source(rel);
      const identity = till.slice(till.indexOf('const cartIdentity'), till.indexOf('const cartIdentity') + 1500);
      expect(identity, rel).not.toContain('guestLanguage');
    }
    expect(source('api/sales.ts').slice(source('api/sales.ts').indexOf('export function buildCartPayload'))).not.toMatch(/^\s+guestLanguage/m);
  });
});

describe('the same cart, language and all, goes to the platform and to the box', () => {
  const cash: SaleTenderPayload = { method: 'cash', kind: 'cash', amountSatang: 54_000, tenderedSatang: 60_000, changeSatang: 6_000 };
  const seen: Array<{ url: string; body: Record<string, unknown> | null }> = [];

  beforeEach(() => {
    seen.length = 0;
    vi.stubEnv('VITE_BOX_BRIDGE_ZONE', 'example.test');
    setBridgeOrigin(null);
    setLaneStation(null);
    setLaneStation(STATION);
    setBridgeStaffName('Nok');
  });
  afterEach(() => {
    setBridgeOrigin(null);
    setLaneStation(null);
    setBridgeStaffName(null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const stub = (platform: 'answers' | 'refuses') =>
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      seen.push({ url, body });
      if (url === intentsUrl) {
        const intent = body as { type: string; payload: Record<string, unknown> };
        if (intent.type === 'cart.quote') {
          return reply({ document: {}, result: { quote: { ...apiSale(), pricingMode: 'weekday', tier: 'tourist', lineTotals: {}, manualAmounts: {}, appliedPromos: [], taxBreakdown: {} } } });
        }
        const sale = apiSale({ id: String(intent.payload.saleId), stationId: STATION });
        return reply({ document: {}, result: { sale: { ...sale, status: 'finalised', receiptNumber: 'T1-000043', receiptSeries: 'T1', receiptSeq: 43, boxId: 'box-1', origin: 'box', pricingMode: 'weekday' },
          finalised: true, outstandingSatang: 0, attempt: null, replay: false, printing: { jobs: [], notes: [] }, drawer: 'opened', outboxDepth: 1 } });
      }
      if (platform === 'refuses') {
        return reply({ error: { code: 'STATION_FORCED_OFFLINE', message: 'This station is forced offline for testing.' } }, 503);
      }
      return reply({ sale: apiSale({ id: String(body!.id), stationId: STATION }), replay: false });
    }));

  it('on the platform: POST /sales carries the guest’s language in its cart', async () => {
    stub('answers');
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      const rung = await result.current.commit({ cart: withGuestLanguage(cart(), 'ru'), finalise: false });
      expect(rung).toMatchObject({ ok: true, written: true });
      const commit = seen.find((s) => s.url === '/api/sales')!;
      expect((commit.body!.cart as SaleCartPayload).guestLanguage).toBe('ru');
    } finally { unmount(); }
  });

  it('on the box lane: the sale closed on the box carries it too, for the platform to keep on replay', async () => {
    stub('refuses');
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      await result.current.commit({ cart: withGuestLanguage(cart(), 'th'), finalise: false });
      const paid = await result.current.finalise(cash, 'cash-press');
      expect(paid).toMatchObject({ ok: true, written: true, finalised: true });
      const finalise = seen.filter((s) => s.url === intentsUrl).map((s) => s.body as { type: string; payload: Record<string, unknown> })
        .find((c) => c.type === 'sale.finalise')!.payload;
      expect(finalise.cart).toEqual({ ...cart(), guestLanguage: 'th' });
    } finally { unmount(); }
  });
});
