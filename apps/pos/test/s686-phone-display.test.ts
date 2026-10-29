import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';
import { cartQuote, settle } from './support/fixtures';
import { renderHook, type RenderedHook } from './support/hooks';
import {
  readDisplayAnswer,
  readTicketDisplayView,
  takeTicketDisplayLeaseForSignOut,
  ticketDisplayPresentation,
  useTicketDisplay,
  type TicketDisplayState,
} from '@/lib/displaySession';
import {
  phoneTillDisplayStage,
  phoneTillInlineDisplay,
  type PhoneTillStagePoint,
} from '@/lib/phoneTillDisplay';
import type { Sale } from '@/types';

/**
 * SCRUM-686 — THE PHONE TILL DRIVES A PAIRED CUSTOMER DISPLAY.
 *
 * Below 768px the POS renders the phone till (`components/mobile/MobileTill.tsx`)
 * instead of the counter till. The counter publishes its sale to a display
 * paired to the station through `useTicketDisplay`; the phone did not, so the
 * display sat on "Please follow the staff screen" while a phone ran the sale.
 *
 * The phone now says its steps in the counter's numbering
 * (`lib/phoneTillDisplay.ts`) and publishes through the same hook, with the
 * same presentation. Pinned here: the mapping, what the shared presentation
 * makes of it, the lease/publish/answer/release wiring driven by phone-shaped
 * state, and the component's own wiring.
 */
vi.mock('react', () => import('./support/hooks'));

const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

const point = (overrides: Partial<PhoneTillStagePoint> = {}): PhoneTillStagePoint => ({
  step: 'tier', handoffMode: null, hasLines: false, hasMember: false, identifyAnswered: false, ...overrides,
});

const sale = (): Sale => ({
  id: 'sale-phone', operatorId: 'private-staff-id', operatorName: 'Private staff', tier: 'tourist', total: 200,
  lines: [{ id: 'line-1', tier: 'tourist', kids: 1, adults: 1, socks: 0, addOns: [], lineTotal: 200,
    ticketType: { id: 'ticket-1', name: 'Play ticket', durationLabel: '1 hour', hours: 1,
      prices: { tourist: { weekday: 200, weekend: 300 } }, adultRules: { tourist: { kind: 'free_adults', freeAdults: 1 } } } }],
  manualDiscounts: [], creditGrants: [{ id: 'private-wallet-id', type: 'fnb_credit', label: 'Food credit', valueTHB: 100 }],
  bracelets: { adults: 1, children: 1 }, createdAt: '', status: 'paid', refunds: [],
});

/** The phone till's display state for where it is, as `MobileTill` builds it. */
const phoneState = (at: PhoneTillStagePoint, overrides: Partial<TicketDisplayState> = {}): TicketDisplayState => {
  const { stage, step } = phoneTillDisplayStage(at);
  return {
    stage, step, sessionKey: 'sale-0', tier: 'tourist', phone: '', nickname: '', contactChannel: 'whatsapp', member: null,
    sale: at.hasLines ? sale() : { ...sale(), lines: [], total: 0 }, totals: cartQuote(at.hasLines ? 200 : 0).totals,
    rateMode: 'weekday', online: true, voucherPrize: null, nothingToPay: false, ...overrides,
  };
};

const document = (overrides: Partial<StationSessionDocument> = {}): StationSessionDocument => ({
  stationId: 'phone-station', boxId: 'box-1', schemaVersion: 1, sequence: 0, stage: 'identify', language: 'en', lease: null,
  takeoverCount: 0, updatedAt: '2026-10-29T12:00:00.000Z', ...overrides,
});
const presented = (state: TicketDisplayState) => document(ticketDisplayPresentation(state, 'prompt-1'));

describe('SCRUM-686 — the phone till’s steps in the counter’s stage numbering', () => {
  it('asks the visitor to identify on the tier step until somebody or something is on the sale, then welcomes', () => {
    expect(phoneTillDisplayStage(point())).toEqual({ stage: 'identify', step: 1 });
    expect(phoneTillDisplayStage(point({ identifyAnswered: true }))).toEqual({ stage: 'welcome', step: 2 });
    expect(phoneTillDisplayStage(point({ hasMember: true }))).toEqual({ stage: 'welcome', step: 2 });
    // A drop-off hand-off lands on the tier step with lines already on the cart.
    expect(phoneTillDisplayStage(point({ hasLines: true }))).toEqual({ stage: 'order', step: 2 });
  });

  it('shows the order while tickets are built and reviewed, and the counter’s contact, payment and thank-you steps', () => {
    for (const step of ['tickets', 'configure', 'dropoff-config', 'review'] as const) {
      expect(phoneTillDisplayStage(point({ step }))).toEqual({ stage: 'welcome', step: 3 });
      expect(phoneTillDisplayStage(point({ step, hasLines: true }))).toEqual({ stage: 'order', step: 3 });
    }
    expect(phoneTillDisplayStage(point({ step: 'tickets', handoffMode: 'input', hasLines: true }))).toEqual({ stage: 'input', step: 4 });
    expect(phoneTillDisplayStage(point({ step: 'payment', hasLines: true }))).toEqual({ stage: 'payment', step: 5 });
    expect(phoneTillDisplayStage(point({ step: 'payment', handoffMode: 'qr', hasLines: true }))).toEqual({ stage: 'payment', step: 5 });
    expect(phoneTillDisplayStage(point({ step: 'done', hasLines: true }))).toEqual({ stage: 'thankyou', step: 6 });
  });

  it('keeps the supervision gate and the consent capture on the phone: step 7 with no prompt', () => {
    expect(phoneTillDisplayStage(point({ step: 'supervision', hasLines: true }))).toEqual({ stage: 'input', step: 7 });
    expect(phoneTillDisplayStage(point({ step: 'supervision', handoffMode: 'consent', hasLines: true }))).toEqual({ stage: 'input', step: 7 });
  });

  it('lets the phone draw its own customer screen unless a separate display is connected, can show the stage and is well', () => {
    const display = { id: 'display-1', name: 'Counter screen' };
    expect(phoneTillInlineDisplay({ connected: [], supported: true, error: null })).toBe(true);
    expect(phoneTillInlineDisplay({ connected: [display], supported: false, error: null })).toBe(true);
    expect(phoneTillInlineDisplay({ connected: [display], supported: true, error: 'The display could not connect.' })).toBe(true);
    expect(phoneTillInlineDisplay({ connected: [display], supported: true, error: null })).toBe(false);
  });
});

describe('SCRUM-686 — what the shared presentation makes of the phone’s stages', () => {
  it('publishes the identify prompt on the tier step and the welcome once it is answered', () => {
    const identify = ticketDisplayPresentation(phoneState(point()), 'prompt-1');
    expect(identify.stage).toBe('identify');
    expect(identify.cart.supported).toBe(true);
    expect(identify.prompt).toMatchObject({ kind: 'identify', requestId: 'prompt-1', phone: '', nickname: '', contactChannel: 'whatsapp' });
    expect(readTicketDisplayView(presented(phoneState(point())))?.stage).toBe('identify');
    const welcome = ticketDisplayPresentation(phoneState(point({ identifyAnswered: true })), 'prompt-1');
    expect(welcome.stage).toBe('welcome');
    expect(welcome.cart.supported).toBe(true);
    expect(welcome.prompt).toBeNull();
  });

  it('reads the visitor’s identify and skip answers at the tier step, as the counter reads them at its step 1', () => {
    const doc = presented(phoneState(point()));
    const identified = { ...doc, prompt: { ...doc.prompt, answer: { type: 'identify', actionId: 'tap-1', phone: '0812345678', nickname: 'Nok', contactChannel: 'line' } } };
    expect(readDisplayAnswer(identified, 'prompt-1')).toMatchObject({ type: 'identify', phone: '0812345678', nickname: 'Nok' });
    const skipped = { ...doc, prompt: { ...doc.prompt, answer: { type: 'skip_identify', actionId: 'tap-2' } } };
    expect(readDisplayAnswer(skipped, 'prompt-1')?.type).toBe('skip_identify');
    expect(readDisplayAnswer(skipped, 'prompt-old')).toBeNull();
  });

  it('shares the live order with the platform’s totals, without staff or wallet detail', () => {
    const order = ticketDisplayPresentation(phoneState(point({ step: 'tickets', hasLines: true }), { nickname: 'Nok' }), 'prompt-1');
    expect(order.stage).toBe('order');
    expect(order.cart.supported).toBe(true);
    expect(order.totals?.total).toBe(200);
    const view = readTicketDisplayView(document(order));
    expect(view?.sale.total).toBe(200);
    expect(view?.nickname).toBe('Nok');
    expect(JSON.stringify(order)).not.toMatch(/Private staff|private-staff|private-wallet/);
    // A cart the platform has not priced stays on the phone's own screen.
    expect(ticketDisplayPresentation(phoneState(point({ step: 'tickets', hasLines: true }), { online: false }), 'prompt-1').cart.supported).toBe(false);
  });

  it('asks for the visitor’s contact at the contact point and reads the finished details back', () => {
    const state = phoneState(point({ step: 'tickets', handoffMode: 'input', hasLines: true }), { phone: '0812345678' });
    const contact = ticketDisplayPresentation(state, 'prompt-1');
    expect(contact.stage).toBe('input');
    expect(contact.step).toBe(4);
    expect(contact.prompt).toMatchObject({ kind: 'contact', phone: '0812345678', contactChannel: 'whatsapp' });
    const doc = presented(state);
    const done = { ...doc, prompt: { ...doc.prompt, answer: { type: 'contact_done', actionId: 'done-1', phone: '0812345678', nickname: 'Nok', contactChannel: 'telegram' } } };
    expect(readDisplayAnswer(done, 'prompt-1')).toMatchObject({ type: 'contact_done', nickname: 'Nok', contactChannel: 'telegram' });
  });

  it('leaves the supervision gate unsupported on the display, so it falls back to following the staff screen', () => {
    for (const handoffMode of [null, 'consent'] as const) {
      const gate = ticketDisplayPresentation(phoneState(point({ step: 'supervision', handoffMode, hasLines: true })), 'prompt-1');
      expect(gate.step).toBe(7);
      expect(gate.cart.supported).toBe(false);
      expect(gate.prompt).toBeNull();
      expect(readTicketDisplayView(document(gate))).toBeNull();
    }
  });

  it('shows the payment with its QR only once the platform holds it, then the thank-you with the sale’s grants', () => {
    const payment = { saleId: 'sale-phone', amountSatang: 20000, qrPayload: 'actual-qr', qrImageUrl: null,
      expiresAt: '2026-10-29T12:10:00.000Z', status: 'pending' as const, offline: false, online: true };
    const paying = phoneState(point({ step: 'payment', hasLines: true }), { payment });
    expect(readTicketDisplayView(presented(paying))?.payment).toEqual(payment);
    expect(ticketDisplayPresentation({ ...paying, payment: undefined }, 'prompt-1').cart.supported).toBe(false);
    expect(ticketDisplayPresentation({ ...paying, online: false }, 'prompt-1').cart.supported).toBe(false);
    const nothing = phoneState(point({ step: 'payment', hasLines: true }), { payment: { ...payment, amountSatang: 0, qrPayload: null }, nothingToPay: true });
    expect(readTicketDisplayView(presented(nothing))?.nothingToPay).toBe(true);
    const thanks = presented(phoneState(point({ step: 'done', hasLines: true })));
    expect(readTicketDisplayView(thanks)?.stage).toBe('thankyou');
    expect(thanks.cart?.sale).toMatchObject({ creditGrants: [{ type: 'fnb_credit', label: 'Food credit', valueTHB: 100 }] });
    expect(JSON.stringify(thanks)).not.toContain('private-wallet-id');
  });
});

describe('SCRUM-686 — the phone drives the display through the counter’s publisher', () => {
  let displayHook: RenderedHook<void, ReturnType<typeof useTicketDisplay>> | undefined;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { displayHook?.unmount(); displayHook = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

  const reply = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;

  /** A station bridge with one connected display, recording every publish. */
  const bridge = (leaseId: string) => {
    let doc = document();
    const intents: Record<string, unknown>[] = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/displays')) return reply({ displays: [{ id: 'display-1', name: 'Counter screen', connected: true }] });
      if (path.endsWith('/lease')) {
        doc = { ...doc, lease: { leaseId, holder: 'till', holderKind: 'till', accountId: 'account-1',
          startedAt: doc.updatedAt, heartbeatAt: doc.updatedAt, expiresAt: '2026-10-29T12:01:00.000Z' } };
        return reply({ document: doc, lease: doc.lease });
      }
      if (path.endsWith('/lease/renew')) return reply({ document: doc });
      if (path.endsWith('/session')) return reply({ document: doc });
      if (path.endsWith('/intents')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        intents.push(body);
        doc = { ...doc, ...body.payload as Partial<StationSessionDocument>, sequence: doc.sequence + 1 };
        return reply({ document: doc });
      }
      return reply({ released: true });
    });
    vi.stubGlobal('fetch', request);
    return { request, intents, answer: (answer: Record<string, unknown>) => {
      doc = { ...doc, sequence: doc.sequence + 1, prompt: { ...doc.prompt, answer } };
    } };
  };

  it('leases the display, publishes the identify prompt, takes the skip once, moves to welcome and releases on unmount', async () => {
    const { request, intents, answer } = bridge('phone-lease');
    let at = point();
    const onAnswer = vi.fn((received: { type: string }) => {
      if (received.type === 'skip_identify') at = { ...at, identifyAnswered: true };
    });
    displayHook = renderHook(() => useTicketDisplay('phone-station', phoneState(at), onAnswer));
    await settle();
    expect(displayHook.result.current.connected).toEqual([{ id: 'display-1', name: 'Counter screen', connected: true }]);
    expect(displayHook.result.current.supported).toBe(true);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ type: 'session.publish_display', leaseId: 'phone-lease',
      payload: { stage: 'identify', step: 1, prompt: { kind: 'identify' } } });

    answer({ type: 'skip_identify', actionId: 'skip-1' });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'skip_identify', actionId: 'skip-1' }));
    // The phone's state has moved on: the next publish carries the welcome, under the same lease.
    displayHook.rerender();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(intents.at(-1)).toMatchObject({ leaseId: 'phone-lease', payload: { stage: 'welcome', step: 2, prompt: null } });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([path]) => path.endsWith('/lease'))).toHaveLength(1);

    displayHook.unmount();
    displayHook = undefined;
    expect(request.mock.calls.filter(([path]) => path.endsWith('/lease/release'))).toHaveLength(1);
  });

  it('publishes the contact prompt at the contact point and delivers the visitor’s finished details once', async () => {
    const { intents, answer } = bridge('phone-contact-lease');
    const onAnswer = vi.fn();
    displayHook = renderHook(() => useTicketDisplay('phone-station',
      phoneState(point({ step: 'tickets', handoffMode: 'input', hasLines: true })), onAnswer));
    await settle();
    expect(intents[0]).toMatchObject({ payload: { stage: 'input', step: 4, prompt: { kind: 'contact' } } });
    answer({ type: 'contact_done', actionId: 'done-1', phone: '0812345678', nickname: 'Nok', contactChannel: 'line' });
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'contact_done', phone: '0812345678', nickname: 'Nok', contactChannel: 'line' }));
  });

  it('hands its held lease to sign-out, as the counter does, instead of racing a release', async () => {
    const { request } = bridge('phone-own-lease');
    let active = true;
    displayHook = renderHook(() => useTicketDisplay('phone-station', phoneState(point()), vi.fn(), active));
    await settle();
    active = false;
    displayHook.rerender();
    await expect(takeTicketDisplayLeaseForSignOut()).resolves.toBe('phone-own-lease');
    displayHook.unmount();
    displayHook = undefined;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(request.mock.calls.filter(([path]) => path.endsWith('/lease/release'))).toHaveLength(0);
  });
});

describe('SCRUM-686 — the phone till’s own wiring', () => {
  const till = src('components/mobile/MobileTill.tsx');

  it('publishes through useTicketDisplay from the phone’s mapped stage, paused while locked, before the locked return', () => {
    const hook = till.indexOf('const linkedDisplay = useTicketDisplay(station?.stationId ?? null, {');
    expect(hook).toBeGreaterThan(-1);
    expect(hook).toBeLessThan(till.indexOf('if (locked) return null;'));
    expect(till).toMatch(/const linkedDisplay = useTicketDisplay\(station\?\.stationId \?\? null, \{[\s\S]*?\n {2}\}, !locked\);/);
    expect(till).toContain('stage: displayStage.stage, step: displayStage.step, sessionKey: `${saleEpochRef.current}`,');
    expect(till).toContain('sale: { ...liveSale, id: saleWriter.committed?.id ?? liveSale.id }, totals: cart.totals,');
    expect(till).toContain('payment: paymentDisplay, voucherPrize: null, nothingToPay: saleOwesNothing,');
    expect(till).toMatch(/const displayStage = phoneTillDisplayStage\(\{\s*step: mStep,\s*handoffMode,\s*hasLines: lines\.length > 0,\s*hasMember: member !== null,\s*identifyAnswered,\s*\}\);/);
  });

  it('answers identify, skip and contact-done the way the counter does, and forgets the identify on the next sale', () => {
    expect(till).toMatch(/answer\.type === 'identify' && displayStage\.step === 1 && answer\.phone !== undefined\) \{[\s\S]*?identifyPhone\(answer\.phone\);/);
    expect(till).toMatch(/answer\.type === 'skip_identify' && displayStage\.step === 1\) \{[\s\S]*?setIdentifyAnswered\(true\);/);
    expect(till).toMatch(/answer\.type === 'contact_done' && displayStage\.step === 4[\s\S]*?finishCustomerContact\(answer\.phone, answer\.nickname, answer\.contactChannel\);/);
    expect(till).toContain('const found = phone ? await lookupMember(phone) : null;');
    expect(till).toContain('const handleCustomerDone = () => finishCustomerContact(customerPhone, customerNickname, customerContactChannel);');
    const reset = till.slice(till.indexOf('const resetSale = () => {'), till.indexOf('setShowCartSheet(false);\n  };'));
    expect(reset).toContain('setIdentifyAnswered(false);');
  });

  it('names the connected display in the phone’s own bar style and steps its overlay aside for it', () => {
    expect(till).toContain("{`Display connected: ${linkedDisplay.connected.map((display) => display.name).join(', ')}`}");
    expect(till).toContain('Display connection: {linkedDisplay.error} The team can continue using this screen.');
    expect(till).toContain('const inlineDisplay = phoneTillInlineDisplay(linkedDisplay);');
    expect(till).toContain("{handoffMode !== null && (inlineDisplay || handoffMode === 'consent') && (() => {");
    expect(till).toMatch(/\{handoffMode === 'input' && !inlineDisplay && \([\s\S]*?<StepAwaitCustomer/);
    expect(till).toContain('{inlineDisplay && (paymentStage.display.qrPayload || paymentStage.display.qrImageUrl) && (');
    expect(till).toMatch(/shownQrAttemptRef\.current !== attemptId\) \{[\s\S]*?if \(!inlineDisplay\) return;/);
    expect(till).toContain("setSaleOpen('mobile-till-display', displayInUse);");
  });
});
