import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSale, cartQuote, settle } from './support/fixtures';
import { renderHook, type RenderedHook } from './support/hooks';
import type { StationSessionDocument } from '@oto/shared';
import { displayRequest, DisplayError, newDisplayCredential, newerDisplaySession, type DisplaySession } from '@/api/display';
import { childReviewPatch, readDisplayAnswer, readTicketDisplayView, takeTicketDisplayLeaseForSignOut, ticketDisplayPresentation, useChildReviewSave, useTicketDisplay, type TicketDisplayState } from '@/lib/displaySession';
import { authApi } from '@/api/platform';
import { fnbDisplayPresentation, useFnbDisplay, type FnbDisplayState } from '@/lib/fnbDisplaySession';
import type { FnbOrder, Sale } from '@/types';
import {
  readProductScan,
  readVoucherScan,
  useStationScans,
  type StationScanEvent,
} from '@/lib/scanChannel';

/**
 * THE STATION CHANNEL, FOR SCANS — `lib/scanChannel.ts`.
 *
 * `useStationScans` is a React hook; it runs on the harness in place of React
 * (support/hooks.ts). Everything else it touches is stubbed here and nothing
 * more: `fetch` (the poll), `EventSource` (the stream), `document` (whether the
 * screen is shown) and the clock.
 *
 * The figures are the library's own, which it does not export:
 * `STREAM_OPEN_TIMEOUT_MS` 4 s, `POLL_INTERVAL_MS` 1.5 s, `POLL_TIMEOUT_MS` 10 s.
 */
vi.mock('react', () => import('./support/hooks'));

describe('SCRUM-201 — separate display transport and station presentation', () => {
  let displayHook: RenderedHook<void, ReturnType<typeof useTicketDisplay>> | undefined;
  let childSaveHook: RenderedHook<void, ReturnType<typeof useChildReviewSave>> | undefined;
  let fnbDisplayHook: RenderedHook<void, ReturnType<typeof useFnbDisplay>> | undefined;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { displayHook?.unmount(); displayHook = undefined; childSaveHook?.unmount(); childSaveHook = undefined; fnbDisplayHook?.unmount(); fnbDisplayHook = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

  const state = (overrides: Partial<TicketDisplayState> = {}): TicketDisplayState => ({
    stage:'identify', step:1, sessionKey:'visit-1', tier:'tourist', phone:'', nickname:'', contactChannel:'whatsapp', member:null, ...overrides,
  });
  const document = (overrides: Partial<StationSessionDocument> = {}): StationSessionDocument => ({
    stationId:'station-1', boxId:'box-1', schemaVersion:1, sequence:0, stage:'identify', language:'en', lease:null,
    takeoverCount:0, updatedAt:'2026-09-29T12:00:00.000Z', ...overrides,
  });
  const reply = (data: unknown, status = 200) => ({ ok:status >= 200 && status < 300, status, json:async () => data }) as Response;
  const sale = (): Sale => ({
    id:'sale-ticket', operatorId:'private-staff-id', operatorName:'Private staff', tier:'tourist', total:200,
    lines:[{id:'line-1',tier:'tourist',kids:1,adults:1,socks:0,addOns:[],lineTotal:200,
      ticketType:{id:'ticket-1',name:'Play ticket',durationLabel:'1 hour',hours:1,
        prices:{tourist:{weekday:200,weekend:300}},adultRules:{tourist:{kind:'free_adults',freeAdults:1}},
        translations:{th:{name:'Play in Thai',description:'Private catalog detail'}}}}],
    manualDiscounts:[],creditGrants:[{id:'private-wallet-id',type:'fnb_credit',label:'Food credit',valueTHB:100}],
    bracelets:{adults:1,children:1},createdAt:'',status:'paid',refunds:[],
  });
  const completeState = (overrides: Partial<TicketDisplayState> = {}) => state({
    stage:'order',step:3,sale:sale(),totals:cartQuote(200).totals,rateMode:'weekday',online:true,...overrides,
  });
  const presented = (input: TicketDisplayState): StationSessionDocument => document(ticketDisplayPresentation(input,'prompt-1'));
  const childReview = (): NonNullable<TicketDisplayState['childReview']> => ({
    visitorId: 'visit-review', referenceDate: '2026-09-29',
    slots: [{ id: 'slot-1', savedChildId: 'child-1', name: 'Child one', dateOfBirth: '2020-01-10', ageYears: 6, confirmed: false }],
    choices: [{ id: 'child-1', name: 'Child one', dateOfBirth: '2020-01-10', ageYears: 6 }],
    save: { status: 'idle', slotId: null, actionId: null }, canContinue: false,
  });
  const savedChild = { id: 'child-1', childName: 'Child one', childAge: 6, dateOfBirth: '2020-01-10',
    allergiesMedical: 'Private health', foodRestrictions: 'Private food', savedAt: '', updatedAt: '' };
  const apiChild = { id: 'child-1', name: 'Child corrected', dateOfBirth: '2020-01-10', ageYears: 6,
    allergies: 'Private health', medicalNotes: null, medicalAlert: true, dietary: null,
    foodRestrictions: 'Private food', notes: null, lastConfirmedAt: null };

  const fnbState = (overrides: Partial<FnbDisplayState> = {}): FnbDisplayState => ({
    sessionKey: 'guest-1', stage: 'order', online: true, excluded: false,
    lines: [{ id: 'food-1', menuItem: { id: 'menu-1', name: 'Old local fries', category: 'private-category',
      price: { weekday: 1, weekend: 999 }, modifierGroups: [], translations: { th: { name: 'Old local translation' } } },
      qty: 2, selectedModifiers: [], lineTotal: 2 }], orderNote: 'No salt', manualDiscounts: [],
    quote: cartQuote(220, { lineTotals: { 'food-1': 220 }, itemPresentation: {
      'food-1': { name: 'Canonical fries', basePrice: 100, modifiers: [{ groupName: 'Sauce', optionName: 'Mayo', price: 10 }] },
    } }), pending: false, quoteFailed: false,
    payment: { saleId: 'sale-food', amountSatang: 22000, status: 'pending', qrPayload: 'actual-payment-payload',
      qrImageUrl: null, expiresAt: '2026-09-29T12:03:00.000Z', offline: false, online: true },
    completedOrder: null, platformSale: null, ...overrides,
  });

  it('publishes canonical guest food components, discounts, tax and actual payment without private catalog data', () => {
    const input = fnbState({ stage: 'payment' });
    input.quote.totals.manualAmounts = { discount: 20 };
    input.quote.totals.discountAmount = 20;
    input.quote.totals.total = 214;
    input.quote.totals.taxBreakdown.categories = [{ category: 'fnb', base: 200, taxMode: 'exclusive', taxName: 'VAT',
      taxPercent: 7, serviceCharge: 0, tax: 14, secondaryTaxMode: 'none', secondaryTaxPercent: 0, secondaryTax: 0, gross: 214 }];
    input.manualDiscounts = [{ id: 'discount', scope: 'order', type: 'fixed', value: 20, reason: 'Private reason',
      amountTHB: 20, appliedBy: 'Private staff', appliedById: 'private-staff', appliedAt: '' }];
    const frame = fnbDisplayPresentation(input);
    expect(frame.cart.supported).toBe(true);
    expect(frame.cart.lines[0]).toMatchObject({ name: 'Canonical fries', basePrice: 100, qty: 2, lineTotal: 220,
      modifiers: [{ groupName: 'Sauce', optionName: 'Mayo', price: 10 }] });
    expect(frame.cart.lines[0].translations).toBeUndefined();
    expect(frame.totals?.manualAmounts).toEqual({ discount: 20 });
    expect(frame.totals?.taxBreakdown.categories[0].tax).toBe(14);
    expect(frame.payment?.qrPayload).toBe('actual-payment-payload');
    expect(frame.member).toBeNull(); expect(frame.prompt).toBeNull();
    expect(JSON.stringify(frame)).not.toMatch(/private-category|menu-1|weekday|Private staff|Private reason/);
  });

  it('clears unsupported guest frames when canonical components are absent, inconsistent, offline or excluded', () => {
    const input = fnbState();
    const missing = { ...input.quote, itemPresentation: undefined };
    const offset = { ...input.quote, itemPresentation: { 'food-1': { name: 'Fries', basePrice: 101,
      modifiers: [{ groupName: 'Sauce', optionName: 'Mayo', price: 10 }] } } };
    for (const changed of [{ quote: missing }, { quote: offset }, { online: false }, { excluded: true },
      { pending: true }, { quoteFailed: true }, { quote: { ...input.quote, source: 'till' as const } }]) {
      const frame = fnbDisplayPresentation({ ...input, ...changed });
      expect(frame.cart).toEqual({ kind: 'fnb', supported: false, lines: [], orderNote: '', manualDiscounts: [], completion: null });
      expect(frame.payment).toBeNull(); expect(frame.totals).toBeNull();
    }
    const equalTotal = fnbDisplayPresentation({ ...input, quote: { ...input.quote, itemPresentation: {
      'food-1': { name: 'Changed fries', basePrice: 105, modifiers: [{ groupName: 'Sauce', optionName: 'Mayo', price: 5 }] },
    } } });
    expect(equalTotal.cart.lines[0]).toMatchObject({ basePrice: 105, modifiers: [{ price: 5 }] });
  });

  it('shows guest thank-you only for an actual finalised sale and matching completed settlement', () => {
    const input = fnbState({ stage: 'thankyou' });
    const completed = { id: 'local-order', status: 'paid', pickupCode: 'G-12', total: 220,
      payment: { cash: 200, card: 20, promptpay: 0 } } as FnbOrder;
    const written = apiSale({ id: 'sale-food', status: 'finalised', totals: { ...apiSale().totals, grossSatang: 22000 } });
    expect(fnbDisplayPresentation(input).cart.supported).toBe(false);
    expect(fnbDisplayPresentation({ ...input, platformSale: { ...written, status: 'tendering' }, completedOrder: completed }).cart.supported).toBe(false);
    const frame = fnbDisplayPresentation({ ...input, platformSale: written, completedOrder: completed });
    expect(frame.cart.completion).toEqual({ saleId: 'sale-food', pickupCode: 'G-12', total: 220, payment: { cash: 200, card: 20, promptpay: 0 } });
    expect(frame.payment).toBeNull();
    expect(fnbDisplayPresentation({ ...input, platformSale: written, completedOrder: { ...completed, total: 221 } }).cart.supported).toBe(false);
    expect(fnbDisplayPresentation({ ...input, platformSale: written, completedOrder: { ...completed, payment: { ...completed.payment, cash: 0 } } }).cart.supported).toBe(false);
  });

  it('retains the guest publisher during lock, never handles ticket answers and gives native sign-out its own lease', async () => {
    let active = true;
    let input = fnbState();
    let doc = document({ stage: 'order' });
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/displays')) return reply({ displays: [{ id: 'display-1', name: 'Guest screen', connected: true }] });
      if (path.endsWith('/lease')) return reply({ document: doc, lease: { leaseId: 'guest-own-lease' } });
      if (path.endsWith('/session')) return reply({ document: doc });
      if (path.endsWith('/intents')) {
        const body = JSON.parse(String(init?.body));
        expect(body.type).toBe('session.publish_display');
        doc = { ...doc, ...body.payload, sequence: doc.sequence + 1 };
        return reply({ document: doc });
      }
      return reply({ released: true });
    });
    vi.stubGlobal('fetch', request);
    fnbDisplayHook = renderHook(() => useFnbDisplay('guest-station', input, active));
    await settle();
    expect(doc.cart?.kind).toBe('fnb');
    const calls = request.mock.calls.length;
    active = false; fnbDisplayHook.rerender();
    input = { ...input, stage: 'payment' }; fnbDisplayHook.rerender();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(request.mock.calls).toHaveLength(calls);
    expect(fnbDisplayHook.result.current.connected).toHaveLength(1);
    active = true; fnbDisplayHook.rerender(); await settle();
    expect(doc.stage).toBe('payment');
    expect(request.mock.calls.filter(([path]) => path.endsWith('/lease'))).toHaveLength(1);
    await expect(takeTicketDisplayLeaseForSignOut()).resolves.toBe('guest-own-lease');
    fnbDisplayHook.unmount();
    expect(request.mock.calls.some(([path]) => path.endsWith('/lease/release'))).toBe(false);
  });

  const consent = (): NonNullable<TicketDisplayState['consent']> => ({ visitorId: 'visit-consent',
    slots: [{ id: 'slot-1', name: 'Child one', ageYears: 6, requirement: 'drop_off' }],
    guardianName: 'Guardian', consentRequired: true, consentAcknowledged: true,
    confirmations: [{ id: 'safety', text: 'Confirm pickup arrangements', required: true, acknowledged: true }],
    staffReady: true, canContinue: true, completed: false });

  it('publishes only finite guardian acknowledgements and rejects unsupported or falsely ready drafts', () => {
    const input = state({ stage: 'input', step: 7, online: true, consent: consent() });
    const view = readTicketDisplayView(presented(input));
    expect(view?.consent?.guardianName).toBe('Guardian');
    expect(readTicketDisplayView({ ...presented(input), step: null })?.consent).toEqual(view?.consent);
    const privateDraft = { ...consent(), medicalNotes: 'Private health', slots: consent().slots.map(slot =>
      ({ ...slot, allergiesMedical: 'Private health', childPhotoUrl: 'Private photo', waived: true })) };
    expect(JSON.stringify(presented({ ...input, consent: privateDraft }))).not.toMatch(/Private health|Private photo|waived|allergiesMedical/);
    for (const invalid of [{ ...input, online: false }, { ...input, consent: undefined },
      { ...input, consent: { ...consent(), staffReady: false } }]) {
      expect(ticketDisplayPresentation(invalid, 'prompt-1').cart.supported).toBe(false);
      expect(readTicketDisplayView(presented(invalid))).toBeNull();
    }
  });

  it('accepts guardian answers only for the current visitor, request and supervision input screen', () => {
    const doc = presented(state({ stage: 'input', step: 7, online: true, consent: consent() }));
    const payload = { action: 'done', requestId: 'prompt-1', visitorId: 'visit-consent' };
    const answered = { ...doc, prompt: { ...doc.prompt, answer: { type: 'consent', actionId: 'done-1', payload } } };
    expect(readDisplayAnswer(answered, 'prompt-1')?.type).toBe('consent');
    expect(readDisplayAnswer(answered, 'new-request')).toBeNull();
    expect(readDisplayAnswer({ ...answered, stage: 'payment' }, 'prompt-1')).toBeNull();
    expect(readDisplayAnswer({ ...answered, step: 8 }, 'prompt-1')).toBeNull();
    expect(readDisplayAnswer({ ...answered, prompt: { ...answered.prompt, answer: {
      type: 'consent', actionId: 'done-1', payload: { ...payload, visitorId: 'old-visitor' },
    } } }, 'prompt-1')).toBeNull();
  });

  it('replaces the guardian request before adopting an answer after staff readiness changes', async () => {
    let input = state({ stage: 'input', step: 7, online: true, consent: consent(), consentRevision: 'ready' });
    let doc = document({ stage: 'input', step: 7 });
    const onAnswer = vi.fn();
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/displays')) return reply({ displays: [{ id: 'display-1', name: 'Guardian screen', connected: true }] });
      if (path.endsWith('/lease')) return reply({ document: doc, lease: { leaseId: 'consent-lease' } });
      if (path.endsWith('/session')) return reply({ document: doc });
      if (path.endsWith('/intents')) {
        const body = JSON.parse(String(init?.body));
        doc = { ...doc, ...body.payload, sequence: doc.sequence + 1 };
        return reply({ document: doc });
      }
      return reply({ released: true });
    });
    vi.stubGlobal('fetch', request);
    displayHook = renderHook(() => useTicketDisplay('consent-station', input, onAnswer)); await settle();
    const oldRequest = doc.prompt?.requestId;
    doc = { ...doc, sequence: doc.sequence + 1, prompt: { ...doc.prompt, answer: { type: 'consent', actionId: 'old-done',
      payload: { action: 'done', requestId: oldRequest, visitorId: 'visit-consent' } } } };
    input = { ...input, consentRevision: 'photo-needed', consent: { ...consent(), staffReady: false, canContinue: false } };
    displayHook.rerender(); await vi.advanceTimersByTimeAsync(1_500);
    expect(onAnswer).not.toHaveBeenCalled();
    expect(doc.prompt?.requestId).not.toBe(oldRequest);
    expect(doc.prompt?.answer).toBeUndefined();
    expect(doc.prompt?.canContinue).toBe(false);
  });

  it('retains one guardian acknowledgement through staff lock without registering or repeating the gesture', async () => {
    let active = true;
    const input = state({ stage: 'input', step: 7, online: true, consent: consent(), consentRevision: 'ready' });
    let doc = document({ stage: 'input', step: 7 });
    const onAnswer = vi.fn();
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/displays')) return reply({ displays: [{ id: 'display-1', name: 'Guardian screen', connected: true }] });
      if (path.endsWith('/lease')) return reply({ document: doc, lease: { leaseId: 'consent-lock-lease' } });
      if (path.endsWith('/session')) return reply({ document: doc });
      if (path.endsWith('/intents')) {
        const body = JSON.parse(String(init?.body));
        expect(body.type).toBe('session.publish_display');
        doc = { ...doc, ...body.payload, sequence: doc.sequence + 1 };
        return reply({ document: doc });
      }
      return reply({ released: true });
    });
    vi.stubGlobal('fetch', request);
    displayHook = renderHook(() => useTicketDisplay('consent-lock-station', input, onAnswer, active)); await settle();
    const requestId = doc.prompt?.requestId;
    active = false; displayHook.rerender();
    doc = { ...doc, sequence: doc.sequence + 1, prompt: { ...doc.prompt, answer: { type: 'consent', actionId: 'retained-done',
      payload: { action: 'done', requestId, visitorId: 'visit-consent' } } } };
    const before = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request.mock.calls).toHaveLength(before); expect(onAnswer).not.toHaveBeenCalled();
    active = true; displayHook.rerender(); await settle();
    expect(doc.prompt?.requestId).toBe(requestId);
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actionId: 'retained-done' }));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.every(([path]) => !path.includes('/sales') && !path.includes('/children'))).toBe(true);
  });

  it('adopts the locked guardian acknowledgement once after an online quote refresh without replacing its request', async () => {
    let active = true;
    const pendingConsent = { ...consent(), guardianName: '', consentAcknowledged: false, staffReady: false, canContinue: false,
      confirmations: consent().confirmations.map(item => ({ ...item, acknowledged: false })) };
    let input = state({ stage: 'input', step: 7, online: true, consent: pendingConsent, consentRevision: 'same-private-state' });
    let doc = document({ stage: 'input', step: 7 });
    const onAnswer = vi.fn();
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/displays')) return reply({ displays: [{ id: 'display-1', name: 'Guardian screen', connected: true }] });
      if (path.endsWith('/lease')) return reply({ document: doc, lease: { leaseId: 'consent-refresh-lease' } });
      if (path.endsWith('/session')) return reply({ document: doc });
      if (path.endsWith('/intents')) {
        const body = JSON.parse(String(init?.body));
        expect(body.type).toBe('session.publish_display');
        doc = { ...doc, ...body.payload, sequence: doc.sequence + 1 };
        return reply({ document: doc });
      }
      return reply({ released: true });
    });
    vi.stubGlobal('fetch', request);
    displayHook = renderHook(() => useTicketDisplay('consent-refresh-station', input, onAnswer, active)); await settle();
    const requestId = doc.prompt?.requestId;
    active = false; displayHook.rerender();
    const payload = { action: 'acknowledge', requestId, visitorId: pendingConsent.visitorId,
      guardianName: 'Locked guardian', consentAcknowledged: true, acknowledgedConfirmationIds: ['safety'] };
    doc = { ...doc, sequence: doc.sequence + 1, prompt: { ...doc.prompt,
      answer: { type: 'consent', actionId: 'locked-acknowledgement', payload } } };
    input = { ...input, online: false, consent: undefined, quoteRefreshing: true };
    active = true; displayHook.rerender();
    const before = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(request.mock.calls).toHaveLength(before);
    expect(onAnswer).not.toHaveBeenCalled();
    expect(doc.prompt?.requestId).toBe(requestId);
    expect(doc.prompt?.answer).toBeDefined();
    input = { ...input, online: true, consent: pendingConsent, quoteRefreshing: false };
    displayHook.rerender(); await settle();
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ type: 'consent', actionId: 'locked-acknowledgement', payload });
    expect(doc.prompt?.requestId).toBe(requestId);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([path]) => path.endsWith('/lease'))).toHaveLength(1);
    expect(request.mock.calls.every(([path]) => !path.includes('/sales') && !path.includes('/children'))).toBe(true);
  });

  it('still invalidates a guardian answer on real offline fallback instead of treating it as a price refresh', async () => {
    let active = true;
    let input = state({ stage: 'input', step: 7, online: true, consent: consent(), consentRevision: 'same-private-state' });
    let doc = document({ stage: 'input', step: 7 });
    const onAnswer = vi.fn();
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/displays')) return reply({ displays: [{ id: 'display-1', name: 'Guardian screen', connected: true }] });
      if (path.endsWith('/lease')) return reply({ document: doc, lease: { leaseId: 'consent-offline-lease' } });
      if (path.endsWith('/session')) return reply({ document: doc });
      if (path.endsWith('/intents')) {
        const body = JSON.parse(String(init?.body));
        doc = { ...doc, ...body.payload, sequence: doc.sequence + 1 };
        return reply({ document: doc });
      }
      return reply({ released: true });
    });
    vi.stubGlobal('fetch', request);
    displayHook = renderHook(() => useTicketDisplay('consent-offline-station', input, onAnswer, active)); await settle();
    const oldRequest = doc.prompt?.requestId;
    active = false; displayHook.rerender();
    doc = { ...doc, sequence: doc.sequence + 1, prompt: { ...doc.prompt, answer: { type: 'consent', actionId: 'offline-old-done',
      payload: { action: 'done', requestId: oldRequest, visitorId: consent().visitorId } } } };
    input = { ...input, online: false, consent: undefined, quoteRefreshing: false };
    active = true; displayHook.rerender(); await settle();
    expect(onAnswer).not.toHaveBeenCalled();
    expect(doc.prompt).toBeNull();
    expect(doc.cart?.supported).toBe(false);
    input = { ...input, online: true, consent: consent() };
    displayHook.rerender(); await vi.advanceTimersByTimeAsync(1_500);
    expect(onAnswer).not.toHaveBeenCalled();
    expect(doc.prompt?.requestId).not.toBe(oldRequest);
  });

  it('publishes a finite online child review without private profile fields and refuses malformed fallback', () => {
    const input = state({ stage: 'input', step: 8, online: true, childReview: childReview() });
    const view = readTicketDisplayView(presented(input));
    expect(view?.childReview?.slots[0].name).toBe('Child one');
    expect(view?.childReview?.referenceDate).toBe('2026-09-29');
    expect(readTicketDisplayView({ ...presented(input), step: null })?.childReview).toEqual(view?.childReview);
    expect(JSON.stringify(presented(input))).not.toMatch(/allergies|medical|foodRestrictions|savedAt/);
    const changed = childReview(); changed.slots[0].dateOfBirth = '2020-02-31';
    expect(ticketDisplayPresentation({ ...input, childReview: changed }, 'prompt-1').cart.supported).toBe(false);
    expect(readTicketDisplayView(presented({ ...input, online: false }))).toBeNull();
    expect(readTicketDisplayView(presented({ ...input, childReview: undefined }))).toBeNull();
    expect(childReviewPatch({ name: ' Child corrected ', dateOfBirth: '2020-01-10', ageYears: 6 }, savedChild))
      .toEqual({ name: 'Child corrected' });
    expect(childReviewPatch({ name: 'Child one', dateOfBirth: null, ageYears: 7 }, savedChild))
      .toEqual({ dateOfBirth: null, ageYears: 7 });
  });

  it('reads only the current child-review answer and visitor at the input stage', () => {
    const doc = presented(state({ stage: 'input', step: 8, online: true, childReview: childReview() }));
    const payload = { action: 'confirm', requestId: 'prompt-1', visitorId: 'visit-review', slotId: 'slot-1',
      savedChildId: 'child-1', name: 'Child corrected', dateOfBirth: '2020-01-10', ageYears: 6 };
    const answered = { ...doc, prompt: { ...doc.prompt, answer: { type: 'child_review', actionId: 'confirm-1', payload } } };
    expect(readDisplayAnswer(answered, 'prompt-1')?.type).toBe('child_review');
    expect(readDisplayAnswer(answered, 'new-request')).toBeNull();
    expect(readDisplayAnswer({ ...answered, stage: 'payment' }, 'prompt-1')).toBeNull();
    expect(readDisplayAnswer({ ...answered, prompt: { ...answered.prompt, answer: {
      type: 'child_review', actionId: 'confirm-1', payload: { ...payload, visitorId: 'old-visit' },
    } } }, 'prompt-1')).toBeNull();
  });

  it('keeps an unreadable child save frozen until explicit retry with the same body and key', async () => {
    const writes: RequestInit[] = [];
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      writes.push(init!);
      if (writes.length === 1) return { ...reply(null), json: async () => { throw new SyntaxError('Unreadable reply'); } } as Response;
      return reply({ child: apiChild });
    });
    vi.stubGlobal('fetch', request);
    const onSaved = vi.fn();
    childSaveHook = renderHook(() => useChildReviewSave({ scope: 'visit-1', paused: false, isCurrent: () => true, onSaved }));
    const patch = { name: 'Child corrected' };
    await expect(childSaveHook.result.current.confirm('slot-1', 'child-1', patch, 'confirm-1')).resolves.toBe(false);
    expect(childSaveHook.result.current.save.status).toBe('failed');
    patch.name = 'Later unsent edit';
    childSaveHook.rerender();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(1);
    await expect(childSaveHook.result.current.confirm('slot-1', 'child-1', patch, 'confirm-2')).resolves.toBe(false);
    await expect(childSaveHook.result.current.retry('slot-1', 'wrong-action')).resolves.toBe(false);
    await expect(childSaveHook.result.current.retry('slot-1', 'confirm-1')).resolves.toBe(true);
    expect(writes.map(write => JSON.parse(String(write.body)))).toEqual([{ name: 'Child corrected' }, { name: 'Child corrected' }]);
    expect(writes.map(write => (write.headers as Record<string, string>)['idempotency-key']))
      .toEqual(['child-review:confirm-1', 'child-review:confirm-1']);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith('slot-1', apiChild);
    expect(childSaveHook.result.current.save.status).toBe('idle');
  });

  it('retains a save reply during lock and adopts it once after unlock without repeating PATCH', async () => {
    let paused = false;
    let finish: ((response: Response) => void) | undefined;
    const request = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', request);
    const onSaved = vi.fn();
    childSaveHook = renderHook(() => useChildReviewSave({ scope: 'visit-lock', paused, isCurrent: () => true, onSaved }));
    const result = childSaveHook.result.current.confirm('slot-1', 'child-1', { name: 'Child corrected' }, 'confirm-lock');
    expect(childSaveHook.result.current.save.status).toBe('saving');
    paused = true; childSaveHook.rerender();
    finish?.(reply({ child: apiChild }));
    await expect(result).resolves.toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
    expect(childSaveHook.result.current.save.status).toBe('saving');
    paused = false; childSaveHook.rerender();
    expect(onSaved).toHaveBeenCalledExactlyOnceWith('slot-1', apiChild);
    expect(childSaveHook.result.current.save.status).toBe('idle');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed save during lock or disconnection until an explicit same-action retry', async () => {
    let paused = false;
    let fail: ((failure: Error) => void) | undefined;
    const writes: RequestInit[] = [];
    const request = vi.fn((_path: string, init?: RequestInit) => {
      writes.push(init!);
      return writes.length === 1 ? new Promise<Response>((_resolve, reject) => { fail = reject; })
        : Promise.resolve(reply({ child: apiChild }));
    });
    vi.stubGlobal('fetch', request);
    const onSaved = vi.fn();
    childSaveHook = renderHook(() => useChildReviewSave({ scope: 'visit-retained', paused, isCurrent: () => true, onSaved }));
    const result = childSaveHook.result.current.confirm('slot-1', 'child-1', { name: 'Child corrected' }, 'confirm-retained');
    paused = true; childSaveHook.rerender();
    fail?.(new TypeError('Reply lost'));
    await expect(result).resolves.toBe(false);
    paused = false; childSaveHook.rerender();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(childSaveHook.result.current.save.status).toBe('failed');
    expect(onSaved).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    await expect(childSaveHook.result.current.confirm('slot-1', 'child-1', { name: 'Child corrected' }, 'fresh-action')).resolves.toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    await expect(childSaveHook.result.current.retry('slot-1', 'confirm-retained')).resolves.toBe(true);
    expect(writes[1].body).toBe(writes[0].body);
    expect((writes[1].headers as Record<string, string>)['idempotency-key'])
      .toBe((writes[0].headers as Record<string, string>)['idempotency-key']);
  });

  it('aborts an unanswered save at eight seconds and retries its unknown outcome without overlapping transports', async () => {
    const writes: RequestInit[] = [];
    let activeRequests = 0;
    let maximumActive = 0;
    const request = vi.fn((_path: string, init?: RequestInit) => {
      writes.push(init!); activeRequests += 1; maximumActive = Math.max(maximumActive, activeRequests);
      if (writes.length > 1) { activeRequests -= 1; return Promise.resolve(reply({ child: apiChild })); }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { activeRequests -= 1; reject(new DOMException('Aborted', 'AbortError')); });
      });
    });
    vi.stubGlobal('fetch', request);
    childSaveHook = renderHook(() => useChildReviewSave({ scope: 'visit-timeout', paused: false, isCurrent: () => true, onSaved: vi.fn() }));
    const result = childSaveHook.result.current.confirm('slot-1', 'child-1', { name: 'Child corrected' }, 'confirm-timeout');
    await vi.advanceTimersByTimeAsync(7_999);
    expect(childSaveHook.result.current.save.status).toBe('saving');
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
    expect(writes[0].signal?.aborted).toBe(true);
    expect(childSaveHook.result.current.save.status).toBe('failed');
    await expect(childSaveHook.result.current.retry('slot-1', 'confirm-timeout')).resolves.toBe(true);
    expect(maximumActive).toBe(1);
    expect(writes[1].body).toBe(writes[0].body);
    expect((writes[1].headers as Record<string, string>)['idempotency-key'])
      .toBe((writes[0].headers as Record<string, string>)['idempotency-key']);
  });

  it('drops an old visitor or reassigned slot reply without confirming or leaving the new review busy', async () => {
    for (const change of ['visitor', 'slot'] as const) {
      let scope = 'visit-original';
      let selected = 'child-1';
      let finish: ((response: Response) => void) | undefined;
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
      const onSaved = vi.fn();
      childSaveHook = renderHook(() => useChildReviewSave({ scope, paused: false,
        isCurrent: (expected, _slot, child) => expected === scope && child === selected, onSaved }));
      const result = childSaveHook.result.current.confirm('slot-1', 'child-1', { name: 'Child corrected' }, 'confirm-old');
      if (change === 'visitor') scope = 'visit-new'; else selected = 'child-2';
      childSaveHook.rerender();
      expect(childSaveHook.result.current.save.status).toBe('idle');
      finish?.(reply({ child: apiChild }));
      await expect(result).resolves.toBe(false);
      expect(onSaved).not.toHaveBeenCalled();
      expect(childSaveHook.result.current.save.status).toBe('idle');
      childSaveHook.unmount(); childSaveHook = undefined;
    }
  });

  it('uses a display bearer without staff cookies or staff lock events', async () => {
    const dispatch = vi.fn();
    vi.stubGlobal('window', { dispatchEvent:dispatch });
    const bearer = newDisplayCredential();
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      expect(init?.credentials).toBe('omit');
      expect(init?.cache).toBe('no-store');
      expect((init?.headers as Record<string,string>).authorization === `Bearer ${bearer}`).toBe(true);
      return reply({error:{code:'DISPLAY_UNPAIRED',message:'Pair this display again.'}},401);
    });
    vi.stubGlobal('fetch', request);
    await expect(displayRequest(bearer,'GET','/session')).rejects.toMatchObject({status:401,code:'DISPLAY_UNPAIRED'});
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('bounds an unanswered device request and keeps the refusal free of credentials', async () => {
    const bearer = newDisplayCredential();
    vi.stubGlobal('fetch', vi.fn((_path: string, init?: RequestInit) => new Promise<Response>((_resolve,reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted','AbortError')));
    })));
    const result = displayRequest(bearer,'GET','/session').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(8_000);
    const failure = await result;
    expect(failure).toBeInstanceOf(DisplayError);
    expect((failure as DisplayError).status).toBe(0);
    expect(String(failure).includes(bearer)).toBe(false);
  });

  it('publishes only identification fields and keeps unsupported steps on the inline screen', () => {
    const input = state({member:{id:'member-1',phone:'private-phone',nickname:'Visitor',savedChildren:[{
      id:'child-1', childName:'Private child', childAge:5, allergiesMedical:'Private medical note', savedAt:'', updatedAt:'',
    }]}});
    const view = ticketDisplayPresentation(input,'prompt-1');
    expect(view.member).toEqual({id:'member-1',nickname:'Visitor',tier:'tourist'});
    expect(JSON.stringify(view)).not.toMatch(/Private child|Private medical|private-phone|savedChildren/);
    expect(ticketDisplayPresentation(state({stage:'payment',step:5}),'prompt-1').cart.supported).toBe(false);
    expect(ticketDisplayPresentation(state({stage:'welcome',step:7}),'prompt-1').prompt).toBeNull();
  });

  it('carries the captured weekday rows and quote, without staff, child or catalog detail', () => {
    const view = readTicketDisplayView(presented(completeState({nickname:'Visitor'})));
    expect(view?.sale.total).toBe(200);
    expect(view?.totals?.total).toBe(200);
    expect(view?.lineBreakdowns?.['line-1'].rows).toMatchObject([
      {kind:'kids',unitPrice:200,quantity:1,subtotal:200}, {kind:'adults',unitPrice:0,quantity:1,subtotal:0},
    ]);
    expect(view?.sale.lines[0].ticketType.prices).toEqual({});
    expect(JSON.stringify(presented(completeState()))).not.toMatch(/Private staff|private-staff|Private catalog|private-wallet|savedChildren/);
    expect(view?.nickname).toBe('Visitor');
  });

  it('shows real payment metadata and zero-price presentation, then summary-only entitlements', () => {
    const payment = {saleId:'sale-ticket',amountSatang:20000,qrPayload:'actual-test-qr',qrImageUrl:null,
      expiresAt:'2026-09-29T12:10:00.000Z',status:'pending' as const,offline:false,online:true};
    const view = readTicketDisplayView(presented(completeState({stage:'payment',step:5,payment})));
    expect(view?.payment).toEqual(payment);
    const zero = sale(); zero.total = 0; zero.lines = [];
    expect(readTicketDisplayView(presented(completeState({stage:'payment',step:5,sale:zero,
      totals:cartQuote(0).totals,payment:{...payment,amountSatang:0,qrPayload:null},nothingToPay:true})))?.nothingToPay).toBe(true);
    const thanks = presented(completeState({stage:'thankyou',step:6}));
    expect(thanks.cart?.sale).toMatchObject({creditGrants:[{type:'fnb_credit',label:'Food credit',valueTHB:100}],bracelets:{adults:1,children:1}});
    expect(JSON.stringify(thanks)).not.toContain('private-wallet-id');
    expect(readTicketDisplayView(thanks)?.stage).toBe('thankyou');
  });

  it('uses inline fallback while the canonical quote is unavailable and for supervision', () => {
    for (const input of [completeState({online:false}),completeState({stage:'order',step:7}),completeState({stage:'input',step:8})]) {
      expect(ticketDisplayPresentation(input,'prompt-1').cart.supported).toBe(false);
      expect(readTicketDisplayView(presented(input))).toBeNull();
    }
  });

  it('waits safely on malformed optional public fields and never falls back from a broken full sale', () => {
    const valid = presented(completeState());
    const invalid: StationSessionDocument[] = [
      {...valid,cart:{supported:true,sale:'not-an-object'}},
      {...valid,cart:{...valid.cart,sale:{id:'sale-ticket',tier:'tourist',total:'200'}}},
      {...valid,totals:{total:NaN}},
      {...valid,member:{id:'member-1',nickname:{medical:'Private'},tier:'tourist'}},
      {...valid,payment:{saleId:'sale-ticket',amountSatang:-1}},
      {...valid,payment:{saleId:'sale-ticket',amountSatang:20000,qrPayload:null,qrImageUrl:'javascript:bad',
        expiresAt:null,status:'pending',offline:false,online:true}},
    ];
    for (const input of invalid) expect(readTicketDisplayView(input)).toBeNull();
    const unknown = {...valid,cart:{...valid.cart,medical:'Private note'}};
    expect(JSON.stringify(readTicketDisplayView(unknown))).not.toContain('Private note');
  });

  it('refuses a response from an older visitor or a different stage', () => {
    const doc = document({prompt:{requestId:'prompt-old',answer:{type:'identify',phone:'number',actionId:'tap-1'}}});
    expect(readDisplayAnswer(doc,'prompt-new')).toBeNull();
    expect(readDisplayAnswer({...doc,stage:'payment'},'prompt-old')).toBeNull();
    expect(readDisplayAnswer(doc,'prompt-old')?.actionId).toBe('tap-1');
  });

  it('ignores a delayed poll or intent response after the next visitor snapshot', () => {
    const current: DisplaySession = {station:{id:'station-1',name:'T1',kind:'till'},device:{id:'display-1',name:'Screen'},
      document:document({sequence:8,prompt:{requestId:'new-visitor'}})};
    const late = {...current,document:document({sequence:7,prompt:{requestId:'old-visitor',answer:{actionId:'old-answer'}}})};
    expect(newerDisplaySession(current,late)).toBe(current);
    expect(newerDisplaySession(late,current)).toBe(current);
  });

  it('delivers one display answer once and keeps the publish under the held lease', async () => {
    const onAnswer = vi.fn();
    let doc = document();
    const intents: Record<string,unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/displays')) return reply({displays:[{id:'display-1',name:'Ticket display',connected:true}]});
      if (path.endsWith('/session')) return reply({document:doc});
      if (path.endsWith('/lease')) {
        doc = {...doc,lease:{leaseId:'lease-1',holder:'till',holderKind:'till',accountId:'account-1',startedAt:doc.updatedAt,heartbeatAt:doc.updatedAt,expiresAt:'2026-09-29T12:01:00.000Z'}};
        return reply({document:doc,lease:doc.lease});
      }
      if (path.endsWith('/intents')) {
        const body = JSON.parse(String(init?.body)) as Record<string,unknown>;
        intents.push(body);
        expect(body.leaseId).toBe('lease-1');
        doc = {...doc,...body.payload as Partial<StationSessionDocument>,sequence:doc.sequence+1};
        return reply({document:doc});
      }
      return reply({released:true});
    }));
    displayHook = renderHook(() => useTicketDisplay('station-1',state(),onAnswer));
    await settle();
    expect(intents).toHaveLength(1);
    doc = {...doc,sequence:doc.sequence+1,prompt:{...doc.prompt,answer:{type:'identify',phone:'number',actionId:'tap-1'}}};
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0]?.[0].type).toBe('identify');
    expect(intents).toHaveLength(1);
  });

  it('pauses staff requests and answer adoption during lock, then resumes the same prompt once', async () => {
    let active = true;
    let doc = document();
    let finishRead: ((response: Response) => void) | undefined;
    const onAnswer = vi.fn();
    const intents: Record<string, unknown>[] = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/displays')) return reply({ displays: [{ id: 'display-1', name: 'Ticket display', connected: true }] });
      if (path.endsWith('/session')) return new Promise<Response>((resolve) => { finishRead = resolve; });
      if (path.endsWith('/lease')) {
        doc = { ...doc, lease: { leaseId: 'lease-locked', holder: 'till', holderKind: 'till', accountId: 'account-1',
          startedAt: doc.updatedAt, heartbeatAt: doc.updatedAt, expiresAt: '2026-09-29T12:01:00.000Z' } };
        return reply({ document: doc, lease: doc.lease });
      }
      if (path.endsWith('/lease/renew')) return reply({ document: doc });
      if (path.endsWith('/intents')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        intents.push(body);
        doc = { ...doc, ...body.payload as Partial<StationSessionDocument>, sequence: doc.sequence + 1 };
        return reply({ document: doc });
      }
      return reply({ released: true });
    });
    vi.stubGlobal('fetch', request);
    displayHook = renderHook(() => useTicketDisplay('station-locked', state(), onAnswer, active));
    await settle();
    const promptId = doc.prompt?.requestId;
    expect(typeof promptId).toBe('string');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(finishRead).toBeTypeOf('function');

    active = false;
    displayHook.rerender();
    doc = { ...doc, sequence: doc.sequence + 1,
      prompt: { ...doc.prompt, answer: { type: 'identify', phone: 'number', actionId: 'answer-while-locked' } } };
    finishRead?.(reply({ document: doc }));
    await settle();
    expect(onAnswer).not.toHaveBeenCalled();
    const pausedRequests = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request.mock.calls).toHaveLength(pausedRequests);
    expect(displayHook.result.current.connected).toHaveLength(1);
    expect(request.mock.calls.some(([path]) => path.endsWith('/lease/release'))).toBe(false);

    active = true;
    displayHook.rerender();
    await settle();
    expect(doc.prompt?.requestId).toBe(promptId);
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actionId: 'answer-while-locked' }));
    expect(intents).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    finishRead?.(reply({ document: doc }));
    await settle();
    expect(onAnswer).toHaveBeenCalledTimes(1);

    displayHook.unmount();
    expect(request.mock.calls.filter(([path]) => path.endsWith('/lease/release'))).toHaveLength(1);
    displayHook = renderHook(() => useTicketDisplay('station-locked', state(), onAnswer));
    await settle();
    expect(doc.prompt?.requestId === promptId).toBe(false);
    expect(doc.prompt?.answer).toBeUndefined();
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('captures its held lease before locked sign-out and suppresses the teardown release race', async () => {
    let active = true;
    let doc = document();
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/displays')) return reply({ displays: [{ id: 'display-1', name: 'Screen', connected: true }] });
      if (path.endsWith('/lease')) {
        doc = { ...doc, lease: { leaseId: 'own-lease', holder: 'till', holderKind: 'till', accountId: 'account-1',
          startedAt: doc.updatedAt, heartbeatAt: doc.updatedAt, expiresAt: '2026-09-29T12:01:00.000Z' } };
        return reply({ document: doc, lease: doc.lease });
      }
      if (path.endsWith('/session')) return reply({ document: doc });
      if (path.endsWith('/intents')) return reply({ document: doc });
      if (path.endsWith('/auth/sign-out')) {
        expect(JSON.parse(String(init?.body))).toEqual({ stationLeaseId: 'own-lease' });
        return reply({ ok: true });
      }
      return reply({ released: true });
    });
    vi.stubGlobal('fetch', request);
    displayHook = renderHook(() => useTicketDisplay('station-signout', state(), vi.fn(), active));
    await settle();
    active = false;
    displayHook.rerender();
    const hint = takeTicketDisplayLeaseForSignOut();
    await expect(hint).resolves.toBe('own-lease');
    await authApi.signOut(await hint);
    displayHook.unmount();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(request.mock.calls.filter(([path]) => path.endsWith('/lease/release'))).toHaveLength(0);
    expect(request.mock.calls.filter(([path]) => path.endsWith('/auth/sign-out'))).toHaveLength(1);
    await expect(takeTicketDisplayLeaseForSignOut()).resolves.toBeUndefined();
  });

  it('includes an own claim reply received during sign-out without adopting or publishing the departed visitor', async () => {
    let finishClaim: ((response: Response) => void) | undefined;
    const onAnswer = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/displays')) return reply({ displays: [{ id: 'display-1', name: 'Screen', connected: true }] });
      if (path.endsWith('/lease')) return new Promise<Response>((resolve) => { finishClaim = resolve; });
      return reply({ document: document() });
    });
    vi.stubGlobal('fetch', request);
    displayHook = renderHook(() => useTicketDisplay('station-late-signout', state(), onAnswer));
    await settle();
    expect(finishClaim).toBeTypeOf('function');
    const hint = takeTicketDisplayLeaseForSignOut();
    displayHook.unmount();
    finishClaim?.(reply({ document: document({ prompt: { requestId: 'old', answer: { type: 'identify', actionId: 'old-answer', phone: 'number' } } }),
      lease: { leaseId: 'late-own-lease' } }));
    await expect(hint).resolves.toBe('late-own-lease');
    await settle();
    expect(onAnswer).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([path]) => path.endsWith('/intents') || path.endsWith('/lease/release'))).toBe(false);
  });

  it('bounds a stalled claim wait and ignores its eventual reply after local sign-out', async () => {
    let finishClaim: ((response: Response) => void) | undefined;
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/displays')) return reply({ displays: [{ id: 'display-1', name: 'Screen', connected: true }] });
      if (path.endsWith('/lease')) return new Promise<Response>((resolve) => { finishClaim = resolve; });
      return reply({ document: document() });
    });
    vi.stubGlobal('fetch', request);
    displayHook = renderHook(() => useTicketDisplay('station-stalled-signout', state(), vi.fn()));
    await settle();
    const hint = takeTicketDisplayLeaseForSignOut();
    displayHook.unmount();
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(hint).resolves.toBeUndefined();
    finishClaim?.(reply({ document: document(), lease: { leaseId: 'too-late' } }));
    await settle();
    expect(request.mock.calls.some(([path]) => path.endsWith('/intents') || path.endsWith('/lease/release'))).toBe(false);
  });
});

const STREAM_OPEN_TIMEOUT_MS = 4_000;
const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 10_000;

function scan(overrides: Partial<StationScanEvent> = {}): StationScanEvent {
  return {
    kind: 'scan',
    source: 'box-scanner',
    codeKind: 'voucher',
    codeFingerprint: 'fp-1',
    outcome: 'handled',
    handler: 'voucher',
    errorCode: null,
    detail: { code: 'B1RT7KMQ4XW' },
    actionId: null,
    scannedAt: '2026-09-25T03:00:00.000Z',
    ...overrides,
  };
}

/** One `GET /stations/:id/scans`, held open until the test answers it. */
interface Poll {
  path: string;
  /** The cursor it carried; null when it asked for the tape's number afresh. */
  after: string | null;
  signal: AbortSignal;
  answer: (body: unknown, status?: number) => Promise<void>;
  /** A 200 whose body is not JSON — a proxy's page: `res.json()` rejects, as a real body's does. */
  answerUnreadable: () => Promise<void>;
  fail: (error?: unknown) => Promise<void>;
}

function stubFetch() {
  const polls: Poll[] = [];
  const fetchMock = vi.fn(
    (input: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const url = new URL(input, 'http://till.test');
        const signal = init?.signal ?? new AbortController().signal;
        // As a real fetch does: an abort rejects the request.
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('This operation was aborted', 'AbortError')),
          { once: true },
        );
        polls.push({
          path: `${url.pathname}${url.search}`,
          after: url.searchParams.get('after'),
          signal,
          answer: async (body, status = 200) => {
            resolve({
              status,
              ok: status >= 200 && status < 300,
              json: async () => body,
            } as Response);
            await settle();
          },
          answerUnreadable: async () => {
            const unreadable: Pick<Response, 'status' | 'ok' | 'json'> = {
              status: 200,
              ok: true,
              json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
            };
            resolve(unreadable as Response);
            await settle();
          },
          fail: async (error = new TypeError('Failed to fetch')) => {
            reject(error);
            await settle();
          },
        });
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, polls };
}

/** Enough of `document` for the hook: its visibility, and the event that says it changed. */
class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  show(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

/** The stream, driven by the test: whether it opens, what it carries, whether the browser gives up. */
class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static made: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  constructor(readonly url: string) {
    super();
    FakeEventSource.made.push(this);
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  send(type: string, data: string): void {
    this.dispatchEvent(new MessageEvent(type, { data }));
  }
  /** A dropped connection: the browser reconnects by itself. */
  drop(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.dispatchEvent(new Event('error'));
  }
  /** An answer that was not a stream: the browser never tries this one again. */
  giveUp(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.dispatchEvent(new Event('error'));
  }
}

let doc: FakeDocument;
let fetchMock: ReturnType<typeof stubFetch>['fetchMock'];
let polls: Poll[];
const mounted: RenderedHook<string | null, void>[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  doc = new FakeDocument();
  vi.stubGlobal('document', doc);
  // No stream in this "browser" unless a test puts one there.
  vi.stubGlobal('EventSource', undefined);
  FakeEventSource.made = [];
  ({ fetchMock, polls } = stubFetch());
});

afterEach(() => {
  for (const hook of mounted.splice(0)) hook.unmount();
  vi.useRealTimers();
});

/** A screen at `stationId`, recording every scan handed to it. */
function listen(stationId: string | null = 'station-1') {
  const heard: StationScanEvent[] = [];
  const hook = renderHook(
    (id: string | null) => useStationScans(id, (event) => heard.push(event)),
    stationId,
  );
  mounted.push(hook);
  return { heard, hook };
}

describe('useStationScans — the poll (SCRUM-392)', () => {
  it('takes the tape number first and replays nothing scanned before the screen listened', async () => {
    const { heard } = listen();
    expect(polls).toHaveLength(1);
    expect(polls[0]!.path).toBe('/api/stations/station-1/scans?view=staff');

    await polls[0]!.answer({ next: 7, scans: [scan({ detail: { code: 'BEFORE-THE-SCREEN' } })] });
    expect(heard).toEqual([]);

    // The next poll goes out one interval after the answer, from that number on.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(polls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toHaveLength(2);
    expect(polls[1]!.path).toBe('/api/stations/station-1/scans?view=staff&after=7');

    const fresh = scan();
    await polls[1]!.answer({ next: 8, scans: [fresh] });
    expect(heard).toEqual([fresh]);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls[2]!.after).toBe('8');
  });

  it('never overlaps two polls: the next one waits for an answer', async () => {
    listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS - 1);
    expect(polls).toHaveLength(2);
  });

  it('gives a hung poll up at ten seconds and sends the next with the same cursor, so the gap is still heard (SCRUM-424, L39)', async () => {
    const { heard } = listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const hung = polls[1]!;

    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS - 1);
    expect(hung.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(hung.signal.aborted).toBe(true);
    await settle();

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls).toHaveLength(3);
    expect(polls[2]!.after).toBe('7');
    const meanwhile = scan({ detail: { code: 'SCANNED-DURING-THE-HANG' } });
    await polls[2]!.answer({ next: 8, scans: [meanwhile] });
    expect(heard).toEqual([meanwhile]);
  });

  it.each([
    ['a locked session (423)', 423],
    ["a proxy's 502 while the api redeploys", 502],
    ['a 503', 503],
    ['a 500', 500],
  ])('keeps the interval and the cursor after %s', async (_label, status) => {
    const { heard } = listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await polls[1]!.answer({ error: { code: 'X', message: 'no' } }, status);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls).toHaveLength(3);
    expect(polls[2]!.after).toBe('7');
    const later = scan();
    await polls[2]!.answer({ next: 8, scans: [later] });
    expect(heard).toEqual([later]);
  });

  it('keeps the interval and the cursor after a dropped connection or an answer that does not read', async () => {
    listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await polls[1]!.fail();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls[2]!.after).toBe('7');

    await polls[2]!.answerUnreadable();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls).toHaveLength(4);
    expect(polls[3]!.after).toBe('7');
  });

  it.each([
    ['a malformed request (400)', 400],
    ['no session (401)', 401],
    ['a session not allowed to watch this station (403)', 403],
    ['no such station (404)', 404],
    ['no box behind it (409)', 409],
  ])('stops polling after a refusal: %s', async (_label, status) => {
    listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await polls[1]!.answer({ error: { code: 'REFUSED', message: 'no' } }, status);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls).toHaveLength(2);
  });

  it('asks nothing without a station', async () => {
    listen(null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useStationScans — a hidden screen does not act on scans (SCRUM-424)', () => {
  it('stops polling while hidden, and shown again takes the number afresh: a scan made while it was away never lands', async () => {
    const { heard } = listen();
    await polls[0]!.answer({ next: 7, scans: [] });

    doc.show('hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls).toHaveLength(1); // the poll that was due is not sent

    doc.show('visible');
    expect(polls).toHaveLength(2); // at once, not an interval later
    expect(polls[1]!.after).toBeNull();
    await polls[1]!.answer({ next: 12, scans: [scan({ detail: { code: 'SCANNED-WHILE-AWAY' } })] });
    expect(heard).toEqual([]);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls[2]!.after).toBe('12');
    const now = scan();
    await polls[2]!.answer({ next: 13, scans: [now] });
    expect(heard).toEqual([now]);
  });

  it('shown again while a poll is out: that poll takes the number afresh and delivers nothing', async () => {
    const { heard } = listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls).toHaveLength(2);

    doc.show('hidden');
    doc.show('visible');
    expect(polls).toHaveLength(2); // the one in flight answers for it

    await polls[1]!.answer({ next: 12, scans: [scan({ detail: { code: 'SCANNED-WHILE-AWAY' } })] });
    expect(heard).toEqual([]);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls[2]!.after).toBe('12');
  });

  it('leaves a poll in flight to answer when hidden, schedules none after it, and polls the moment it is shown', async () => {
    listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    doc.show('hidden');
    expect(polls[1]!.signal.aborted).toBe(false);
    await polls[1]!.answer({ next: 8, scans: [] });

    // Shown again before an interval has passed: no poll was left waiting, so
    // one goes out at once, and it takes the number afresh.
    doc.show('visible');
    expect(polls).toHaveLength(3);
    expect(polls[2]!.after).toBeNull();
  });

  it('reads being away from visibility alone: a failed poll resets no cursor', async () => {
    const { heard } = listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await polls[1]!.fail();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const gap = scan({ detail: { code: 'SCANNED-DURING-THE-FAILURE' } });
    await polls[2]!.answer({ next: 8, scans: [gap] });
    expect(heard).toEqual([gap]);
  });
});

describe('useStationScans — leaving', () => {
  it('on unmount aborts the poll in flight, delivers nothing more and sends no other', async () => {
    const { heard, hook } = listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const inFlight = polls[1]!;

    hook.unmount();
    expect(inFlight.signal.aborted).toBe(true);
    doc.show('hidden');
    doc.show('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls).toHaveLength(2);
    expect(heard).toEqual([]);
  });

  it('on a change of station leaves the old one and takes the new one from its current number', async () => {
    const { heard, hook } = listen('station-1');
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const old = polls[1]!;

    hook.rerender('station-2');
    expect(old.signal.aborted).toBe(true);
    expect(polls[2]!.path).toBe('/api/stations/station-2/scans?view=staff');
    await polls[2]!.answer({ next: 40, scans: [scan()] });
    expect(heard).toEqual([]);
  });
});

describe('useStationScans — the stream first', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  it('listens on the channel; a stream that opens is heard and nothing polls', async () => {
    const { heard } = listen();
    const source = FakeEventSource.made[0]!;
    expect(source.url).toBe('/api/stations/station-1/channel?view=staff');
    source.open();

    const heardOnStream = scan();
    source.send('scan', JSON.stringify(heardOnStream));
    source.send('scan', 'not json'); // a message that is not JSON is not a scan
    source.send('scan', JSON.stringify({ kind: 'lease' })); // nor is one of another kind
    expect(heard).toEqual([heardOnStream]);

    // A dropped connection is the browser's to retry; the stream is kept.
    source.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('closes a stream that has not opened in four seconds and polls instead, from the current number (SCRUM-392)', async () => {
    const { heard } = listen();
    const source = FakeEventSource.made[0]!;

    await vi.advanceTimersByTimeAsync(STREAM_OPEN_TIMEOUT_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    expect(polls).toHaveLength(1);
    expect(polls[0]!.after).toBeNull();

    // The closed stream is no longer listened to, so nothing is heard twice.
    source.send('scan', JSON.stringify(scan()));
    expect(heard).toEqual([]);
  });

  it('polls at once when the browser has given the stream up', () => {
    listen();
    FakeEventSource.made[0]!.giveUp();
    expect(polls).toHaveLength(1);
  });
});

describe('readVoucherScan', () => {
  it('reads the code a voucher handler claimed', () => {
    expect(readVoucherScan(scan({ detail: { code: 'B1RT7KMQ4XW' } }))).toBe('B1RT7KMQ4XW');
  });

  it.each([
    ['another kind of code', scan({ codeKind: 'band' })],
    ['a code no handler claimed', scan({ outcome: 'unhandled', handler: null })],
    ['a code another handler claimed', scan({ handler: 'product-barcode' })],
    ['an empty code', scan({ detail: { code: '' } })],
    ['no code at all', scan({ detail: null })],
  ])('answers null for %s', (_label, event) => {
    expect(readVoucherScan(event)).toBeNull();
  });
});

describe('readProductScan', () => {
  const product = (add: Record<string, unknown>, overrides: Partial<StationScanEvent> = {}) =>
    scan({ codeKind: 'product', handler: 'product-barcode', detail: { add }, ...overrides });

  it('reads the line the box asks the shop to add, size and all', () => {
    expect(
      readProductScan(
        product({
          kind: 'product',
          productId: 'p-socks',
          name: 'Grip Socks',
          label: 'Grip Socks M',
          variant: { id: 'v-m', label: 'M' },
          quantity: 2,
        }),
      ),
    ).toEqual({
      kind: 'add',
      line: {
        productId: 'p-socks',
        name: 'Grip Socks',
        label: 'Grip Socks M',
        variant: { id: 'v-m', label: 'M' },
        quantity: 2,
      },
    });
  });

  it('adds one of the item, under its own name, when the box says no more', () => {
    const read = readProductScan(
      product({ kind: 'product', productId: 'p-cup', name: 'Cup', variant: 'L', quantity: 0 }),
    );
    expect(read).toEqual({
      kind: 'add',
      line: { productId: 'p-cup', name: 'Cup', label: 'Cup', variant: null, quantity: 1 },
    });
  });

  it("says Unknown barcode in the box's words, adding nothing", () => {
    const refused = { outcome: 'refused', handler: null, errorCode: 'UNKNOWN_BARCODE' };
    expect(readProductScan(scan({ codeKind: 'product', ...refused, detail: { message: 'Not sold here' } }))).toEqual({
      kind: 'unknown',
      message: 'Not sold here',
    });
    expect(readProductScan(scan({ codeKind: 'product', ...refused, detail: null }))).toEqual({
      kind: 'unknown',
      message: 'Unknown barcode',
    });
  });

  it("answers null for another screen's scan or an add it cannot read", () => {
    expect(readProductScan(scan())).toBeNull();
    expect(readProductScan(product({ kind: 'product', productId: 'p-1' }, { handler: 'voucher' }))).toBeNull();
    expect(readProductScan(product({ kind: 'ticket', productId: 'p-1' }))).toBeNull();
    expect(readProductScan(product({ kind: 'product' }))).toBeNull();
  });
});
