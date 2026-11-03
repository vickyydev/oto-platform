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
import { StepPayment } from '@/components/till/StepPayment';
import { rebuildResumedSale } from '@/lib/resumeSale';
import { usePartyTender, type PartyTenderOptions } from '@/lib/usePartyTender';
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
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ operator: { id: 'acc-som', name: 'Som (Reception)' }, locked: false, offlineUnlock: null }),
}));
vi.mock('@/lib/customerDisplayPref', () => ({ useCustomerDisplayPref: () => [true, () => undefined] }));

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

/** What the customer's half of the modal asks the QR screen to draw. */
function customerScreen(tree: unknown): Record<string, unknown> {
  const pane = [...walk(tree)].find((el) => 'qr' in el.props)!;
  const drawn = (pane.type as (props: unknown) => El)(pane.props);
  expect(drawn.type).toBe(PromptPayCustomerScreen);
  return drawn.props;
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
  return { hook, tree, onSell, onCheckIn, onOpenChange, onAttendee, idsRef, step: () => elementOf(tree(), StepPayment)!.props };
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

  it('a device that is no till is refused before anything is sent', async () => {
    const outcome = await startPartyTenderOnPlatform({ party, amount: 900, method: 'promptpay', outstanding: 900, stationId: null, ids: { id: 'a', actionId: 'b' } });
    expect(outcome.ok).toBe(false);
    expect(postMock).not.toHaveBeenCalled();
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
});
