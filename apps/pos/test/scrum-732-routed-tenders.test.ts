import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentAttemptView } from '@oto/shared';
import { api, ApiError, NetworkError } from '@/api/client';
import { readPaidPass } from '@/api/events';
import { inFlightTenderOf, startPartyTenderOnPlatform } from '@/api/parties';
import type { ApiSaleDetail } from '@/api/history';
import { paymentsApi } from '@/api/payments';
import { AddAttendeeModal } from '@/components/parties/AddAttendeeModal';
import { AttendeeFormFields } from '@/components/shared/AttendeeFormFields';
import { PromptPayCustomerScreen } from '@/components/shared/PromptPayCustomerScreen';
import { PaymentTenderPanel } from '@/components/till/PaymentTenderPanel';
import { StepPayment } from '@/components/till/StepPayment';
import { rebuildResumedSale } from '@/lib/resumeSale';
import { partyTenderShown, usePartyTender, type PartyTenderOptions } from '@/lib/usePartyTender';
import type { PaymentStageController } from '@/lib/usePaymentStage';
import type { EventAttendee, OtoEvent, PartyBooking } from '@/types';
import { renderHook } from './support/hooks';

/**
 * SCRUM-732 — A PASS AND A PARTY'S BALANCE TAKE QR AND CARD AS THE TICKET TILL
 * DOES. Driven on the till's hook harness, press by press, against a platform
 * that answers as the api does. The API half of the same story is in
 * `apps/api/test/scrum-732-routed-tenders.test.ts`.
 */

Object.assign(globalThis, { React });

const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';
const TILL = '0190a0a0-0000-7000-8000-00000000c001';
const EVENT = '0190a0a0-0000-7000-8000-0000000e0e41';
const ATTEMPT = '0190a0a0-0000-7000-8000-0000000a0001';
const QR_PAYLOAD = '00020101021230370016A000000677010111011300660000000005802TH53037645406540.006304ABCD';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const harness = await import('./support/hooks');
  const hooks = {
    useState: harness.useState,
    useRef: harness.useRef,
    useMemo: harness.useMemo,
    useCallback: harness.useCallback,
    useEffect: harness.useEffect,
  };
  return { ...real, ...hooks, default: { ...real, ...hooks } };
});
vi.mock('@/api/catalogBridge', () => ({
  apiBranchIdForSlug: (slug: string) => (slug === 'hkt-central' ? HKT_CENTRAL : null),
}));
vi.mock('@/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/client')>();
  return { ...original, api: { ...original.api, get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() } };
});
vi.mock('@/lib/lane', () => ({ currentLane: () => 'platform', viaLane: (online: () => unknown) => online() }));
const operatorState = vi.hoisted(() => ({
  locked: false,
  offlineUnlock: null as { method: string; cacheAgeSeconds: number | null } | null,
}));
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ operator: { id: 'acc-som', name: 'Som (Reception)' }, ...operatorState }),
}));
vi.mock('@/lib/customerDisplayPref', () => ({ useCustomerDisplayPref: () => [true, () => undefined] }));
// The customer's QR screen reads the language its display is set to (SCRUM-729). These
// tests call that screen as a plain function, outside React, so it reads the display's
// default language, English, from the real dictionary; its words in every language are
// pinned in s729-customer-display-language.
vi.mock('@/i18n/LanguageContext', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/i18n/LanguageContext')>();
  return { ...real, useLanguage: () => ({ lang: 'en' as const, setLang: () => undefined, t: real.tFor('en') }) };
});

const postMock = vi.mocked(api.post);
const getMock = vi.mocked(api.get);

const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

function attempt(over: Partial<PaymentAttemptView> = {}): PaymentAttemptView {
  return {
    id: ATTEMPT, saleId: null, method: 'qr', provider: 'simulator', status: 'sent_to_terminal',
    amountSatang: 90_000, tenderedSatang: null, changeSatang: null, terminalRef: null, tid: null, approvalCode: null,
    last4: null, invoiceNo: 'OTOT01261103000001', tranRef: 'SIMABC', actionId: 'party-payment:x', offline: false,
    paidAt: null, createdAt: '2026-11-03T05:00:00.000Z', ...over,
  };
}
const started = (route: 'gateway' | 'card_terminal' | 'manual', over: Partial<PaymentAttemptView> = {}) => ({
  route,
  attempt: route === 'manual' ? null : attempt(over),
  replayed: false,
  outstandingSatang: 90_000,
  qrPayload: route === 'gateway' ? QR_PAYLOAD : null,
  qrImageUrl: null,
  expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
  expiryTimerMs: 20 * 60_000,
});
const readBack = (over: Partial<PaymentAttemptView>, outstandingSatang: number | null = null) => ({
  route: 'gateway' as const,
  attempt: attempt(over),
  qrPayload: QR_PAYLOAD,
  qrImageUrl: null,
  expiresAt: null,
  expiryTimerMs: null,
  deviceLabel: null,
  responseText: null,
  outstandingSatang,
});

const unmounts: (() => void)[] = [];

beforeEach(() => {
  operatorState.locked = false;
  operatorState.offlineUnlock = null;
  postMock.mockReset();
  getMock.mockReset();
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// =============================================================================
// No screen shows a code no bank can pay
// =============================================================================

describe('the customer screens', () => {
  it('draw the code the payment route answered with, or nothing: no seeded placeholder is left', () => {
    const screen = source('components/shared/PromptPayCustomerScreen.tsx');
    expect(screen).not.toContain('components/till/QrCode');
    expect(screen).not.toMatch(/\bseed\b/);
    expect(source('components/parties/AddAttendeeModal.tsx')).not.toMatch(/\bseed\b|walkup-/);
    expect(source('components/parties/PartySettlementCustomerScreen.tsx')).not.toMatch(/\bseed\b|party-promptpay-/);
  });

  it('says what is coming until there is a code, and tells nobody to scan an empty square', () => {
    const empty = PromptPayCustomerScreen({ amount: 900 });
    const text = JSON.stringify(empty);
    expect(text).toContain('Your payment code will appear here.');
    expect(text).not.toContain('Open your banking app');
    const shown = JSON.stringify(PromptPayCustomerScreen({ amount: 900, qrPayload: QR_PAYLOAD }));
    expect(shown).toContain('Open your banking app and scan to complete the payment.');
    expect(shown).toContain(QR_PAYLOAD);
  });
});

// =============================================================================
// An event pass, in the attendee modal
// =============================================================================

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}
const isEl = (n: unknown): n is El => !!n && typeof n === 'object' && 'type' in n && 'props' in n;
function* walk(node: unknown): Generator<El> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!isEl(node)) return;
  yield node;
  for (const value of Object.values(node.props)) {
    if (Array.isArray(value) || isEl(value)) yield* walk(value);
  }
}
const elementOf = (tree: unknown, type: unknown): El | null => {
  for (const el of walk(tree)) if (el.type === type) return el;
  return null;
};
const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isEl(node)) return ` ${textOf(node.props.children)} `;
  return '';
};
function press(tree: unknown, words: string) {
  for (const el of walk(tree)) {
    if (typeof el.props.onClick !== 'function') continue;
    if (textOf(el.props.children).replace(/\s+/g, ' ').trim().startsWith(words)) return (el.props.onClick as () => unknown)();
  }
  throw new Error(`nothing to press called ${words}`);
}
async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * What the customer's half of the modal asks the QR screen to draw. SCRUM-859:
 * a pass with a door fee draws its line and Total beside the code, so the QR
 * screen sits inside the payment-stage frame rather than being the pane itself.
 */
function customerScreen(tree: unknown): Record<string, unknown> {
  const pane = [...walk(tree)].find((el) => 'qr' in el.props)!;
  const drawn = (pane.type as (props: unknown) => El)(pane.props);
  const screen = elementOf(drawn, PromptPayCustomerScreen);
  expect(screen).not.toBeNull();
  return screen!.props;
}

const workshop = { id: EVENT, type: 'workshop', title: 'ZZ TEST slime workshop', date: '2026-11-03', entryPriceTHB: { weekday: 350, weekend: 350 } } as unknown as OtoEvent;
const HELD_SALE = { id: 'sale-held', status: 'tendering', totals: { grossSatang: 35_000 }, stationId: TILL };

function mountPass() {
  const onSell = vi.fn(async () => true);
  const onCheckIn = vi.fn();
  const onOpenChange = vi.fn();
  const onAttendee = vi.fn<(a: EventAttendee) => void>();
  const idsRef = { current: null as { attendeeId: string; saleId: string; actionId: string } | null };
  const props = {
    open: true,
    onOpenChange,
    event: workshop,
    doorFeeTHB: 350,
    isParty: false,
    onSell,
    onCheckIn,
    routedPass: { branchSlug: 'hkt-central', stationId: TILL, idsRef, onAttendee },
  };
  const hook = renderHook((p: typeof props) => AddAttendeeModal(p as never), props);
  unmounts.push(hook.unmount);
  const tree = () => hook.result.current;
  // The form, filled in as staff fill it, and on to the payment step.
  const set = elementOf(tree(), AttendeeFormFields)!.props.set as (k: string, v: string) => void;
  set('name', 'ZZ TEST Lin');
  set('parentName', 'May');
  press(tree(), 'Continue to payment');
  return { hook, props, tree, onSell, onCheckIn, onOpenChange, onAttendee, idsRef, step: () => elementOf(tree(), StepPayment)!.props };
}

describe('an event pass in the attendee modal', () => {
  it('cash stays the one press it was: no stage, no rung-up sale, the host sells it', async () => {
    const pass = mountPass();
    (pass.step().onSelectMethod as (m: string) => void)('cash');
    expect(pass.step().paymentStage).toBeUndefined();
    await (pass.step().onComplete as () => Promise<void>)();
    await settle();
    expect(pass.onSell).toHaveBeenCalledTimes(1);
    expect(pass.onSell).toHaveBeenCalledWith(expect.objectContaining({ paymentMethod: 'cash' }));
    expect(postMock).not.toHaveBeenCalled();
    expect(textOf(pass.tree())).toContain('Pass paid — check in now?');
  });

  it('QR: rung up, the real code on the customer screen, pending until the platform says paid; only then the roster and the check-in choice', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pass = mountPass();
    (pass.step().onSelectMethod as (m: string) => void)('promptpay');
    const stage = () => pass.step().paymentStage as PaymentStageController;
    expect(stage()).toBeDefined();
    // Chosen, not started: nothing to scan, nothing asked of anyone.
    expect(customerScreen(pass.tree()).qrPayload ?? null).toBeNull();
    expect(postMock).not.toHaveBeenCalled();

    postMock.mockImplementation((async (url: string) => {
      if (url.endsWith('/passes/open')) return { attendeeId: pass.idsRef.current?.attendeeId, replayed: false, sale: HELD_SALE };
      if (url === '/payments/attempts') return started('gateway', { saleId: 'sale-held', amountSatang: 35_000 });
      throw new Error(`unexpected ${url}`);
    }) as never);
    await stage().submit();
    await settle();
    expect(postMock.mock.calls.map((c) => c[0])).toEqual([`/events/${EVENT}/passes/open`, '/payments/attempts']);
    expect(postMock.mock.calls[0]![1]).toMatchObject({ stationId: TILL, attendee: { name: 'ZZ TEST Lin' }, expectedTotalSatang: 35_000 });
    expect(postMock.mock.calls[0]![1]).not.toHaveProperty('tender');
    expect(stage().state.phase).toBe('pending');
    expect(stage().locked).toBe(true);
    expect(stage().canCancel).toBe(true);
    expect(customerScreen(pass.tree()).qrPayload).toBe(QR_PAYLOAD);
    expect(pass.onSell).not.toHaveBeenCalled();
    expect(pass.onAttendee).not.toHaveBeenCalled();
    expect(textOf(pass.tree())).not.toContain('Pass paid');

    getMock.mockImplementation((async (url: string) => {
      if (url.startsWith('/payments/attempts/')) return readBack({ status: 'approved', saleId: 'sale-held', amountSatang: 35_000 }, 0);
      if (url.startsWith(`/events/${EVENT}/passes/`)) {
        return { attendee: { id: pass.idsRef.current!.attendeeId, attendanceDays: [], syncState: 'synced' }, replayed: true, sale: null, printingNotes: [] };
      }
      throw new Error(`unexpected ${url}`);
    }) as never);
    postMock.mockImplementation((async (url: string) => {
      if (url.endsWith('/finalise')) return { sale: { ...HELD_SALE, status: 'finalised', receiptNumber: 'T1-1' }, replay: true, finalised: true, outstandingSatang: 0 };
      throw new Error(`unexpected ${url}`);
    }) as never);
    await vi.advanceTimersByTimeAsync(1_600);
    vi.useRealTimers();
    await settle();
    expect(pass.onAttendee).toHaveBeenCalledTimes(1);
    expect(pass.onAttendee.mock.calls[0]![0]).toMatchObject({ id: pass.idsRef.current!.attendeeId, syncState: 'synced', name: 'ZZ TEST Lin' });
    expect(textOf(pass.tree())).toContain('Pass paid — check in now?');
    expect(pass.onSell).not.toHaveBeenCalled();
  });

  it('a QR waiting for its answer holds the form; cancelled and left, the sale goes with a reason', async () => {
    const pass = mountPass();
    (pass.step().onSelectMethod as (m: string) => void)('promptpay');
    const stage = () => pass.step().paymentStage as PaymentStageController;
    postMock.mockImplementation((async (url: string) => {
      if (url.endsWith('/passes/open')) return { attendeeId: pass.idsRef.current?.attendeeId, replayed: false, sale: HELD_SALE };
      if (url === '/payments/attempts') return started('gateway', { saleId: 'sale-held' });
      if (url.endsWith('/cancel')) return { attempt: attempt({ status: 'cancelled', saleId: 'sale-held' }), replayed: false, outstandingSatang: 35_000 };
      if (url.endsWith('/void')) return { replay: false, sale: { ...HELD_SALE, status: 'voided' }, void: {}, releasedVoucherIds: [] };
      throw new Error(`unexpected ${url}`);
    }) as never);
    await stage().submit();
    await settle();
    const xClose = [...walk(pass.tree())].find((el) => el.props['aria-label'] === 'Close')!;
    (xClose.props.onClick as () => void)();
    expect(pass.onOpenChange).not.toHaveBeenCalled();

    await stage().cancel();
    await settle();
    expect(pass.step().paymentStage).toBeUndefined(); // back at the methods
    (pass.step().onBack as () => void)();
    await settle();
    const voided = postMock.mock.calls.find((c) => String(c[0]).endsWith('/void'));
    expect(voided).toBeDefined();
    expect(voided![0]).toBe('/sales/sale-held/void');
    expect(voided![1]).toMatchObject({ reason: 'Event pass left unpaid at the till' });
    expect(pass.idsRef.current).toBeNull();
    expect(pass.onSell).not.toHaveBeenCalled();
  });

  it('an unlock taken through the box does not freeze the payment step: cash goes through, and a QR can start', async () => {
    operatorState.offlineUnlock = { method: 'pin', cacheAgeSeconds: 60 };
    const pass = mountPass();
    (pass.step().onSelectMethod as (m: string) => void)('cash');
    expect(pass.step().paymentStage).toBeUndefined();
    await (pass.step().onComplete as () => Promise<void>)();
    await settle();
    expect(pass.onSell).toHaveBeenCalledTimes(1);
    expect(textOf(pass.tree())).toContain('Pass paid — check in now?');

    const second = mountPass();
    (second.step().onSelectMethod as (m: string) => void)('promptpay');
    const stage = second.step().paymentStage as PaymentStageController;
    expect(stage.locked).toBe(false);
    expect(stage.canBack).toBe(true);
    expect(stage.canSubmit).toBe(true);
  });

  it('the staff lock still pauses the tender: nothing is sent behind it', async () => {
    const pass = mountPass();
    (pass.step().onSelectMethod as (m: string) => void)('promptpay');
    operatorState.locked = true;
    pass.hook.rerender(pass.props);
    const stage = pass.step().paymentStage as PaymentStageController;
    expect(stage.locked).toBe(true);
    await stage.submit();
    await settle();
    expect(postMock).not.toHaveBeenCalled();
  });

  /** A QR on the customer screen that the gateway then flags for a person. */
  async function flaggedPass() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pass = mountPass();
    (pass.step().onSelectMethod as (m: string) => void)('promptpay');
    const stage = () => pass.step().paymentStage as PaymentStageController;
    postMock.mockImplementation((async (url: string) => {
      if (url.endsWith('/passes/open')) return { attendeeId: pass.idsRef.current?.attendeeId, replayed: false, sale: HELD_SALE };
      if (url === '/payments/attempts') return started('gateway', { saleId: 'sale-held', amountSatang: 35_000 });
      if (url.endsWith('/void')) return { replay: false, sale: { ...HELD_SALE, status: 'voided' }, void: {}, releasedVoucherIds: [] };
      throw new Error(`unexpected ${url}`);
    }) as never);
    await stage().submit();
    await settle();
    expect(stage().canConfirm).toBe(false);
    getMock.mockResolvedValue(readBack({ status: 'awaiting_staff_confirmation', saleId: 'sale-held', amountSatang: 35_000 }, 35_000) as never);
    await vi.advanceTimersByTimeAsync(1_600);
    vi.useRealTimers();
    await settle();
    return { pass, stage };
  }

  it('a QR waiting for a person holds the form with a door: Money taken lands the child', async () => {
    const { pass, stage } = await flaggedPass();
    expect(stage().state.attempt?.status).toBe('awaiting_staff_confirmation');
    expect(stage().locked).toBe(true);
    expect(stage().canCancel).toBe(false);
    expect(stage().canConfirm).toBe(true);
    expect(pass.onAttendee).not.toHaveBeenCalled();

    const answer = vi.spyOn(paymentsApi, 'confirm').mockResolvedValue({ attempt: attempt({ status: 'approved', saleId: 'sale-held', amountSatang: 35_000 }) } as never);
    getMock.mockImplementation((async (url: string) => {
      if (url.startsWith('/payments/attempts/')) return readBack({ status: 'approved', saleId: 'sale-held', amountSatang: 35_000 }, 0);
      if (url.startsWith(`/events/${EVENT}/passes/`)) {
        return { attendee: { id: pass.idsRef.current!.attendeeId, attendanceDays: [], syncState: 'synced' }, replayed: true, sale: null, printingNotes: [] };
      }
      throw new Error(`unexpected ${url}`);
    }) as never);
    postMock.mockImplementation((async (url: string) => {
      if (url.endsWith('/finalise')) return { sale: { ...HELD_SALE, status: 'finalised', receiptNumber: 'T1-1' }, replay: true, finalised: true, outstandingSatang: 0 };
      throw new Error(`unexpected ${url}`);
    }) as never);
    await stage().confirm(true, { note: 'Saw the bank slip' });
    await settle();
    expect(answer.mock.calls[0]![0]).toBe(ATTEMPT);
    expect(answer.mock.calls[0]![1]).toMatchObject({ took: true, note: 'Saw the bank slip' });
    expect(pass.onAttendee).toHaveBeenCalledTimes(1);
    expect(textOf(pass.tree())).toContain('Pass paid — check in now?');
  });

  it('No money taken lets the form go: back at the methods, no child, and leaving voids the sale', async () => {
    const { pass, stage } = await flaggedPass();
    vi.spyOn(paymentsApi, 'confirm').mockResolvedValue({ attempt: attempt({ status: 'declined', saleId: 'sale-held', amountSatang: 35_000 }) } as never);
    getMock.mockResolvedValue(readBack({ status: 'declined', saleId: 'sale-held', amountSatang: 35_000 }, 35_000) as never);
    await stage().confirm(false, { note: 'Nothing on the bank slip' });
    await settle();
    expect(stage().locked).toBe(false);
    expect(stage().canBack).toBe(true);
    expect(stage().state.method).toBeNull();
    expect(pass.onAttendee).not.toHaveBeenCalled();
    (pass.step().onBack as () => void)();
    await settle();
    expect(postMock.mock.calls.some((c) => String(c[0]).endsWith('/void'))).toBe(true);
  });

  it('the paid child is answered as captured when the read of it fails: the money is in, the choice goes on', async () => {
    getMock.mockRejectedValue(new NetworkError('lost'));
    const answer = await readPaidPass({ event: workshop, branchSlug: 'hkt-central', attendeeId: 'att-1', input: { name: 'ZZ TEST Lin', parentName: 'May' } as never });
    expect(answer).toMatchObject({ id: 'att-1', name: 'ZZ TEST Lin', syncState: 'pending' });
  });
});

// =============================================================================
// A party's balance
// =============================================================================

const party = { id: EVENT, branchId: 'hkt-central', title: 'ZZ TEST Mali 6th' } as unknown as PartyBooking;

function mountTender(over: Partial<PartyTenderOptions> = {}) {
  const record = vi.fn<PartyTenderOptions['record']>(async () => ({ recorded: true, amount: 900 }));
  const onRecorded = vi.fn<PartyTenderOptions['onRecorded']>();
  const onRefused = vi.fn<PartyTenderOptions['onRefused']>();
  const options: PartyTenderOptions = {
    scope: 'collect-1',
    active: true,
    party,
    stationId: TILL,
    amount: 900,
    method: 'promptpay',
    outstanding: 900,
    record,
    onRecorded,
    onRefused,
    ...over,
  };
  const hook = renderHook((p: PartyTenderOptions) => usePartyTender(p), options);
  unmounts.push(hook.unmount);
  return { ...hook, record, onRecorded, onRefused, stage: () => hook.result.current };
}

describe("a party's balance by QR or card", () => {
  it('QR: the gateway answer is shown, pending; nothing is recorded until the attempt reads paid', async () => {
    postMock.mockResolvedValue(started('gateway') as never);
    const test = mountTender();
    expect(test.stage().canSubmit).toBe(true);
    await test.stage().submit();
    await settle();
    expect(postMock.mock.calls[0]![0]).toBe(`/parties/${EVENT}/payments/tender`);
    expect(postMock.mock.calls[0]![1]).toMatchObject({
      branchId: HKT_CENTRAL,
      stationId: TILL,
      amountSatang: 90_000,
      expectedOutstandingSatang: 90_000,
      tender: { method: 'promptpay', kind: 'qr' },
      requestQrPayload: true,
    });
    expect(test.stage().state.phase).toBe('pending');
    expect(test.stage().display.qrPayload).toBe(QR_PAYLOAD);
    expect(test.stage().locked).toBe(true);
    expect(test.stage().canBack).toBe(false);
    expect(test.stage().canCancel).toBe(true);
    expect(test.record).not.toHaveBeenCalled();

    const read = vi.spyOn(paymentsApi, 'read').mockResolvedValue(readBack({ status: 'approved' }) as never);
    await test.stage().retry();
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(test.record).toHaveBeenCalledTimes(1);
    const body = postMock.mock.calls[0]![1] as { paymentId: string };
    expect(test.record.mock.calls[0]![0].ids.id).toBe(body.paymentId);
    expect(test.record.mock.calls[0]![0].slip).toBeUndefined();
    expect(test.onRecorded).toHaveBeenCalledWith(900);
    expect(test.stage().state.phase).toBe('complete');
  });

  it('a timer never says it was paid: an expired or failed read records nothing', async () => {
    postMock.mockResolvedValue(started('gateway') as never);
    const test = mountTender();
    await test.stage().submit();
    await settle();
    vi.spyOn(paymentsApi, 'read').mockRejectedValue(new NetworkError('lost'));
    await test.stage().retry();
    await settle();
    expect(test.record).not.toHaveBeenCalled();
    expect(test.stage().state.phase).toBe('blocked');
    expect(test.stage().state.retryable).toBe(true);
  });

  it('declined: back to ready with the reason, and the next press is another tender under its own id', async () => {
    postMock.mockResolvedValue(started('card_terminal', { method: 'card' }) as never);
    const test = mountTender({ method: 'card' });
    await test.stage().submit();
    await settle();
    expect(test.stage().state.phase).toBe('pending');
    vi.spyOn(paymentsApi, 'read').mockResolvedValue({ ...readBack({ status: 'declined', method: 'card' }), route: 'card_terminal' } as never);
    await test.stage().retry();
    await settle();
    expect(test.stage().state.phase).toBe('ready');
    expect(test.stage().state.error).toContain('declined');
    expect(test.stage().state.attempt).toBeNull();
    expect(test.record).not.toHaveBeenCalled();
    await test.stage().submit();
    await settle();
    const [first, second] = postMock.mock.calls.map((c) => (c[1] as { paymentId: string }).paymentId);
    expect(second).not.toBe(first);
  });

  it('nothing answered: held on the same press, whose retry is the same request', async () => {
    postMock.mockRejectedValueOnce(new NetworkError('lost'));
    const test = mountTender();
    await test.stage().submit();
    await settle();
    expect(test.stage().state.phase).toBe('blocked');
    expect(test.stage().state.retryable).toBe(true);
    postMock.mockResolvedValue(started('gateway') as never);
    await test.stage().retry();
    await settle();
    expect(test.stage().state.phase).toBe('pending');
    const [first, second] = postMock.mock.calls.map((c) => c[1]);
    expect(second).toEqual(first);
  });

  it('a station that keys cards in asks for the slip, and the slip is what is recorded', async () => {
    postMock.mockResolvedValue(started('manual') as never);
    const test = mountTender({ method: 'card' });
    await test.stage().submit();
    await settle();
    expect(test.stage().state.phase).toBe('manual');
    expect(test.record).not.toHaveBeenCalled();
    await test.stage().manual({ approvalCode: ' 123456 ', tid: 'TID1' });
    await settle();
    expect(test.record).toHaveBeenCalledTimes(1);
    expect(test.record.mock.calls[0]![0].slip).toEqual({ approvalCode: '123456', tid: 'TID1' });
    expect(test.stage().state.phase).toBe('complete');
  });

  it('cancelled: the way out, with the balance free again and a new id for the next press', async () => {
    postMock.mockResolvedValue(started('gateway') as never);
    const test = mountTender();
    await test.stage().submit();
    await settle();
    vi.spyOn(paymentsApi, 'cancel').mockResolvedValue({ attempt: attempt({ status: 'cancelled' }), replayed: false, outstandingSatang: null } as never);
    expect(await test.stage().cancel()).toBe(true);
    expect(test.stage().state.phase).toBe('ready');
    expect(test.stage().state.attempt).toBeNull();
    expect(test.stage().display.qrPayload).toBeNull();
    expect(test.record).not.toHaveBeenCalled();
    expect(test.stage().canBack).toBe(true);
  });

  it('a balance that moved goes back to the bill', async () => {
    postMock.mockRejectedValue(new ApiError(409, 'PARTY_BALANCE_CHANGED', 'The balance changed'));
    const test = mountTender();
    await test.stage().submit();
    await settle();
    expect(test.onRefused).toHaveBeenCalledTimes(1);
    expect(test.record).not.toHaveBeenCalled();
  });

  it('a tender already waiting at this counter comes back on screen, and finishes under its own id', async () => {
    postMock.mockRejectedValue(
      new ApiError(409, 'PAYMENT_IN_FLIGHT', 'A payment on this party is still waiting', {
        waiting: [{ attemptId: ATTEMPT, paymentId: 'pay-earlier', stationId: TILL }],
      }),
    );
    const read = vi.spyOn(paymentsApi, 'read').mockResolvedValue(readBack({}) as never);
    const test = mountTender();
    await test.stage().submit();
    await settle();
    expect(read).toHaveBeenCalledWith(ATTEMPT);
    expect(test.stage().state.phase).toBe('pending');
    expect(test.stage().display.qrPayload).toBe(QR_PAYLOAD);
    read.mockResolvedValue(readBack({ status: 'approved' }) as never);
    await test.stage().retry();
    await settle();
    expect(test.record.mock.calls[0]![0].ids.id).toBe('pay-earlier');
  });

  it("another counter's tender is that counter's: this till is told, and touches nothing", () => {
    expect(inFlightTenderOf({ waiting: [{ attemptId: ATTEMPT, paymentId: 'p', stationId: 'other' }] }, TILL)).toBeNull();
    expect(inFlightTenderOf({ waiting: [] }, TILL)).toBeNull();
    expect(inFlightTenderOf(undefined, TILL)).toBeNull();
    expect(inFlightTenderOf({ waiting: [{ attemptId: ATTEMPT, paymentId: 'p', stationId: TILL }] }, TILL)).toEqual({ attemptId: ATTEMPT, paymentId: 'p' });
  });

  it('a tender waiting for a person is any counter\'s to answer, ahead of the rest', () => {
    const waitingOnAPerson = { attemptId: ATTEMPT, paymentId: 'p', stationId: 'other', status: 'awaiting_staff_confirmation' };
    const other = { attemptId: 'a2', paymentId: 'p2', stationId: TILL, status: 'sent_to_terminal' };
    expect(inFlightTenderOf({ waiting: [waitingOnAPerson] }, TILL)).toEqual({ attemptId: ATTEMPT, paymentId: 'p' });
    expect(inFlightTenderOf({ waiting: [other, waitingOnAPerson] }, TILL)).toEqual({ attemptId: ATTEMPT, paymentId: 'p' });
    expect(inFlightTenderOf({ waiting: [other, { ...other, attemptId: 'a3', paymentId: 'p3' }] }, TILL)).toBeNull();
  });

  describe.each([
    ["another counter's tender", [{ attemptId: ATTEMPT, paymentId: 'pay-a', stationId: 'other', status: 'sent_to_terminal' }]],
    ['two tenders at this counter', [
      { attemptId: ATTEMPT, paymentId: 'pay-a', stationId: TILL, status: 'sent_to_terminal' },
      { attemptId: 'a2', paymentId: 'pay-b', stationId: TILL, status: 'sent_to_terminal' },
    ]],
  ])('a press refused because of %s', (_label, waiting) => {
    it('is told, and keeps Back and the press, with nothing on screen to wait for', async () => {
      const words = 'A payment on this party is still waiting for an answer. Resolve it before charging this balance again.';
      postMock.mockRejectedValue(new ApiError(409, 'PAYMENT_IN_FLIGHT', words, { waiting }));
      const read = vi.spyOn(paymentsApi, 'read');
      const test = mountTender();
      await test.stage().submit();
      await settle();
      expect(read).not.toHaveBeenCalled();
      expect(test.stage().state.phase).toBe('failed');
      expect(test.stage().state.error).toBe(words);
      expect(test.stage().state.attempt).toBeNull();
      expect(test.stage().locked).toBe(false);
      expect(test.stage().canBack).toBe(true);
      expect(test.stage().canSubmit).toBe(true);
      expect(test.onRefused).not.toHaveBeenCalled();

      // The other tender answered: the same screen presses again, under a new id.
      postMock.mockReset();
      postMock.mockResolvedValue(started('gateway') as never);
      await test.stage().submit();
      await settle();
      expect(test.stage().state.phase).toBe('pending');
    });
  });

  /** A party QR on screen that the gateway then flags for a person. */
  async function flaggedTender(over: Partial<PartyTenderOptions> = {}) {
    postMock.mockResolvedValue(started('gateway') as never);
    const test = mountTender(over);
    await test.stage().submit();
    await settle();
    vi.spyOn(paymentsApi, 'read').mockResolvedValue(readBack({ status: 'awaiting_staff_confirmation' }) as never);
    await test.stage().retry();
    await settle();
    return test;
  }

  it('a gateway QR waiting for a person has a door, and does not hold the counter', async () => {
    const test = await flaggedTender();
    expect(test.stage().state.route).toBe('gateway');
    expect(test.stage().state.attempt?.status).toBe('awaiting_staff_confirmation');
    expect(test.stage().canConfirm).toBe(true);
    expect(test.stage().canCancel).toBe(false);
    expect(test.stage().canInquire).toBe(false);
    expect(test.stage().canSubmit).toBe(false);
    expect(test.stage().locked).toBe(false);
    expect(test.stage().canBack).toBe(true);
    expect(test.record).not.toHaveBeenCalled();
  });

  it('Money taken: the door answers on the attempt, and only the read of it records the money', async () => {
    const test = await flaggedTender();
    const answer = vi.spyOn(paymentsApi, 'confirm').mockResolvedValue({ attempt: attempt({ status: 'approved' }) } as never);
    vi.spyOn(paymentsApi, 'read').mockResolvedValue(readBack({ status: 'approved' }) as never);
    await test.stage().confirm(true, { note: 'Saw the bank slip' });
    await settle();
    expect(answer.mock.calls[0]![0]).toBe(ATTEMPT);
    expect(answer.mock.calls[0]![1]).toMatchObject({ took: true, note: 'Saw the bank slip' });
    expect(test.record).toHaveBeenCalledTimes(1);
    expect(test.onRecorded).toHaveBeenCalledWith(900);
    expect(test.stage().state.phase).toBe('complete');
  });

  it('No money taken: the balance is free, and the next press is another tender', async () => {
    const test = await flaggedTender();
    vi.spyOn(paymentsApi, 'confirm').mockResolvedValue({ attempt: attempt({ status: 'declined' }) } as never);
    vi.spyOn(paymentsApi, 'read').mockResolvedValue(readBack({ status: 'declined' }) as never);
    await test.stage().confirm(false, { note: 'Nothing on the bank slip' });
    await settle();
    expect(test.record).not.toHaveBeenCalled();
    expect(test.stage().state.phase).toBe('ready');
    expect(test.stage().state.attempt).toBeNull();
    expect(test.stage().canSubmit).toBe(true);
  });

  it('a person refused the door keeps Back, and the press stays shut while it waits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const test = await flaggedTender();
    vi.spyOn(paymentsApi, 'confirm').mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'You cannot confirm a payment'));
    await test.stage().confirm(true, { note: 'Saw the bank slip' });
    await settle();
    // Read back and still waiting; its words outlast the next poll of the attempt.
    expect(test.stage().state.attempt?.status).toBe('awaiting_staff_confirmation');
    expect(test.stage().state.cancelRefusal).toBe('You cannot confirm a payment');
    const polls = vi.mocked(paymentsApi.read).mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_600);
    await settle();
    expect(vi.mocked(paymentsApi.read).mock.calls.length).toBeGreaterThan(polls);
    expect(test.stage().state.cancelRefusal).toBe('You cannot confirm a payment');
    expect(test.stage().canBack).toBe(true);
    expect(test.stage().canSubmit).toBe(false);
    expect(test.record).not.toHaveBeenCalled();
  });

  it("a person's answer is reachable from another counter: the refused press brings the tender back", async () => {
    postMock.mockRejectedValue(
      new ApiError(409, 'PAYMENT_IN_FLIGHT', 'A payment on this party is still waiting', {
        waiting: [{ attemptId: ATTEMPT, paymentId: 'pay-earlier', stationId: 'other', status: 'awaiting_staff_confirmation' }],
      }),
    );
    vi.spyOn(paymentsApi, 'read').mockResolvedValue(readBack({ status: 'awaiting_staff_confirmation' }) as never);
    const test = mountTender();
    await test.stage().submit();
    await settle();
    expect(test.stage().state.attempt?.id).toBe(ATTEMPT);
    expect(test.stage().canConfirm).toBe(true);
    expect(test.stage().canBack).toBe(true);
  });

  it('a card waiting for a person keeps its own door and its own ask', async () => {
    postMock.mockResolvedValue(started('card_terminal', { method: 'card', terminalRef: 'REF1' }) as never);
    const test = mountTender({ method: 'card' });
    await test.stage().submit();
    await settle();
    vi.spyOn(paymentsApi, 'read').mockResolvedValue({ ...readBack({ status: 'awaiting_staff_confirmation', method: 'card', terminalRef: 'REF1' }), route: 'card_terminal' } as never);
    await test.stage().retry();
    await settle();
    expect(test.stage().canConfirm).toBe(true);
    expect(test.stage().canInquire).toBe(true);
  });

  it('a tender brought back shows itself: its amount and method, not those of the press that found it', async () => {
    postMock.mockRejectedValue(
      new ApiError(409, 'PAYMENT_IN_FLIGHT', 'A payment on this party is still waiting', {
        waiting: [{ attemptId: ATTEMPT, paymentId: 'pay-earlier', stationId: TILL, status: 'sent_to_terminal' }],
      }),
    );
    vi.spyOn(paymentsApi, 'read').mockResolvedValue(readBack({ amountSatang: 500_000 }) as never);
    const test = mountTender({ amount: 9_000, method: 'card', outstanding: 9_000 });
    expect(partyTenderShown(test.stage(), 9_000, 'card')).toEqual({ amount: 9_000, method: 'card' });
    await test.stage().submit();
    await settle();
    expect(partyTenderShown(test.stage(), 9_000, 'card')).toEqual({ amount: 5_000, method: 'promptpay' });
    expect(test.stage().display.amountSatang).toBe(500_000);
    expect(test.stage().display.qrPayload).toBe(QR_PAYLOAD);

    vi.spyOn(paymentsApi, 'cancel').mockResolvedValue({ attempt: attempt({ status: 'cancelled' }), replayed: false, outstandingSatang: null } as never);
    expect(await test.stage().cancel()).toBe(true);
    expect(partyTenderShown(test.stage(), 9_000, 'card')).toEqual({ amount: 9_000, method: 'card' });
    expect(test.stage().state.method).toBe('card');
    expect(test.stage().state.amountSatang).toBe(900_000);
  });

  it('a device that is no till is refused before anything is sent', async () => {
    const outcome = await startPartyTenderOnPlatform({ party, amount: 900, method: 'promptpay', outstanding: 900, stationId: null, ids: { id: 'a', actionId: 'b' } });
    expect(outcome.ok).toBe(false);
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe('the door on the tender panel', () => {
  const panelText = (stage: PaymentStageController) => {
    const hook = renderHook((s: PaymentStageController) => PaymentTenderPanel({ stage: s, showSubmit: false, fixedAmount: true }), stage);
    unmounts.push(hook.unmount);
    return textOf(hook.result.current).replace(/\s+/g, ' ');
  };

  it('a gateway QR is reviewed in its own words: no terminal, which it does not have', async () => {
    postMock.mockResolvedValue(started('gateway') as never);
    const test = mountTender();
    await test.stage().submit();
    await settle();
    vi.spyOn(paymentsApi, 'read').mockResolvedValue(readBack({ status: 'awaiting_staff_confirmation' }) as never);
    await test.stage().retry();
    await settle();
    const text = panelText(test.stage());
    expect(text).toContain('Review the QR payment');
    expect(text).toContain('Confirm the QR payment');
    expect(text).toContain('I checked the QR payment');
    expect(text).not.toMatch(/terminal/i);
  });

  it('a card keeps the words it had', async () => {
    postMock.mockResolvedValue(started('card_terminal', { method: 'card', status: 'awaiting_staff_confirmation' }) as never);
    const test = mountTender({ method: 'card' });
    await test.stage().submit();
    await settle();
    const text = panelText(test.stage());
    expect(text).toContain('Review the terminal result');
    expect(text).toContain('Confirm the terminal result');
    expect(text).toContain('I checked the terminal result');
  });
});

describe('a pass sale a reload left unpaid at the till', () => {
  /**
   * The sale waits in `tendering` with its child held, so the till's left-behind
   * card lists it like any unpaid sale. The ledger has one `kids` row at the
   * event's flat fee, labelled One-time, and no ticket package.
   */
  const passSale = {
    sale: {
      id: 'sale-pass', branchId: HKT_CENTRAL, stationId: TILL, memberId: null, visitId: null,
      businessDate: '2026-11-03', occurredAt: '2026-11-03T03:10:00.000Z', status: 'tendering',
      pricingMode: 'weekday', pricingModeReason: 'Weekday pricing', customerTier: 'tourist', engineVersion: 'engine-1',
      receiptNumber: null, receiptSeries: null, receiptSeq: null, finalisedAt: null, note: null,
      totals: {
        subtotalSatang: 35_000, manualDiscountSatang: 0, promoDiscountSatang: 0, discountSatang: 0,
        netSatang: 32_710, serviceChargeSatang: 0, taxInclusiveSatang: 2_290, taxExclusiveSatang: 0,
        grossSatang: 35_000, unappliedDiscountSatang: 0, refundedSatang: 0,
      },
    },
    taxBreakdown: null,
    lines: [{
      id: 'row-pass', lineNo: 1, kind: 'kids', cartLineId: 'attendee-1', componentKey: 'event-pass', ticketPackageId: null,
      label: 'Event pass', revenueCategory: 'tickets', taxableCategory: 'tickets', quantity: 1, unitSatang: 35_000,
      baseSatang: 35_000, discountSatang: 0, netSatang: 32_710, serviceChargeSatang: 0, taxSatang: 2_290, grossSatang: 35_000,
      taxMode: 'inclusive', taxRateBp: 700, taxName: 'VAT', customerTier: 'tourist', kidCount: 1, adultCount: 0,
      freeAdultCount: 0, stayHours: 0, stayDurationLabel: 'One-time',
    }],
    discounts: [],
    attempts: [],
  } as unknown as ApiSaleDetail;

  it("comes back as one line at its fee, on the sale's own figures, so the tender closes that sale and lands its child", () => {
    const rebuilt = rebuildResumedSale(passSale, { ticketTypes: [], addOns: [], discountByCode: () => null });
    expect(rebuilt?.lines).toHaveLength(1);
    expect(rebuilt?.lines[0]).toMatchObject({ id: 'attendee-1', kids: 1, adults: 0, socks: 0, lineTotal: 350 });
    expect(rebuilt?.cart.totals.total).toBe(350);
    expect(rebuilt?.cart.quote.source).toBe('platform');
  });

  it.each([
    ['svc-event-pass', true],
    ['svc-camp-pass', true],
    ['ticket-kids', false],
    [null, false],
  ])('is told apart by its line: %s', (componentKey, eventPass) => {
    const detail = { ...passSale, lines: passSale.lines!.map((row) => ({ ...row, componentKey })) } as ApiSaleDetail;
    const rebuilt = rebuildResumedSale(detail, { ticketTypes: [], addOns: [], discountByCode: () => null });
    expect(rebuilt?.eventPass).toBe(eventPass);
  });
});
