import { useEffect, useRef, useState } from 'react';
import { PAYMENT_ATTEMPT_TAKEN_STATUSES, PAYMENT_ATTEMPT_TERMINAL_STATUSES, newId, type PaymentAttemptView } from '@oto/shared';
import { ApiError, NetworkError } from '@/api/client';
import { paymentsApi, type PaymentConfirmationBody, type PaymentQrMetadata } from '@/api/payments';
import {
  inFlightTenderOf,
  startPartyTenderOnPlatform,
  type PartyPaymentConfirmation,
  type PartySlip,
  type PartyTenderPress,
  type PartyWriteIds,
} from '@/api/parties';
import type { PartyBooking, PartyPaymentMethod } from '@/types';
import { findPaymentMethod, getEnabledPaymentMethods } from './payments';
import { endedTenderLine } from './paymentEnded';
import { paymentStageText, type PaymentStageController, type PaymentStageState } from './usePaymentStage';

/**
 * SCRUM-732 — A PARTY'S BALANCE TAKEN BY QR OR CARD.
 *
 * The ticket till's payment stage is built around a sale: it rings one up, reads
 * its balance and closes it. A party's balance has no sale behind it (Q3: not a
 * sale of goods, no receipt, no VAT line), so this is the same collection on the
 * same routes without one: the station's routing, the real code, the same
 * attempt polled while it waits, the same inquiry, confirmation, manual slip and
 * cancel. It speaks the stage's controller shape, so the same panel draws it.
 *
 * Nothing here says money was taken. Only the attempt's own status does, read
 * from the platform; a timer or a failed request never does.
 */
export interface PartyTenderOptions {
  scope: string;
  active: boolean;
  paused?: boolean;
  party: PartyBooking;
  stationId: string | null | undefined;
  /** Frozen with the collect step: the amount, its method and the balance shown. */
  amount: number;
  method: PartyPaymentMethod | null;
  outstanding: number;
  /** The money is taken, or its slip keyed in: the platform's record of it. */
  record: (tender: PartyTenderPress) => Promise<PartyPaymentConfirmation>;
  onRecorded: (amount: number) => void;
  /** A definite no: the bill has moved, and staff go back to it as it now reads. */
  onRefused: () => void;
}

const emptyQr: PaymentQrMetadata = { qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null };
const CANCELLABLE_QR_STATUSES: readonly PaymentAttemptView['status'][] = ['created', 'sent_to_terminal'];
const taken = (attempt: PaymentAttemptView): boolean => PAYMENT_ATTEMPT_TAKEN_STATUSES.includes(attempt.status);
const unresolved = (attempt: PaymentAttemptView | null): boolean =>
  Boolean(attempt && (attempt.reversalPending || !PAYMENT_ATTEMPT_TERMINAL_STATUSES.includes(attempt.status)));
const supportsInquiry = (attempt: PaymentAttemptView): boolean =>
  attempt.inquirySupported ?? (attempt.provider !== 'ghl' && Boolean(attempt.terminalRef));
/**
 * Waiting for a person: a QR paid after its time or for another amount, a card
 * nobody can ask about. No machine moves it, so nothing is gained by holding the
 * counter on it: the amount stays reserved on the platform, and any counter that
 * presses over the rest of the balance is brought back here to answer it.
 */
const needsAPerson = (attempt: PaymentAttemptView | null): boolean =>
  attempt?.status === 'awaiting_staff_confirmation' && !attempt.reversalPending;
/** The refusals that say the bill has moved under the till: nothing to retry on this screen. */
const BILL_MOVED: readonly string[] = ['PARTY_BALANCE_CHANGED', 'PARTY_NOTHING_OWED'];

const satang = (baht: number): number => Math.round(baht * 100);

/** What the screens say is being collected: the tender on screen, once there is one. */
export function partyTenderShown(
  stage: Pick<PaymentStageController, 'state'>,
  amount: number,
  method: PartyPaymentMethod,
): { amount: number; method: PartyPaymentMethod } {
  const attempt = stage.state.attempt;
  return attempt ? { amount: attempt.amountSatang / 100, method: stage.state.method ?? method } : { amount, method };
}

/** The tender a press opened or found waiting, in the till's words for its method. */
function methodOfAttempt(attempt: PaymentAttemptView): Pick<PaymentStageState, 'method' | 'kind'> {
  const method = findPaymentMethod(attempt.method) ?? getEnabledPaymentMethods().find((m) => m.kind === attempt.method);
  return { method: method?.id ?? attempt.method, kind: method?.kind ?? null };
}

function initial(options: Pick<PartyTenderOptions, 'amount' | 'method'>): PaymentStageState {
  const amount = satang(options.amount);
  return {
    phase: 'ready',
    saleId: null,
    method: options.method,
    kind: options.method ? (findPaymentMethod(options.method)?.kind ?? null) : null,
    outstandingSatang: amount,
    amountSatang: amount,
    tenderedSatang: amount,
    attempt: null,
    route: null,
    qr: emptyQr,
    error: null,
    retryable: false,
    settlements: [],
    creditSatang: 0,
    creditSaleId: null,
    creditRefusedSaleId: null,
    creditRefusalMessage: null,
    creditRefusalSeq: 0,
    cancelRefusal: null,
  };
}

export function usePartyTender(options: PartyTenderOptions): PaymentStageController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [state, setState] = useState<PaymentStageState>(() => initial(options));
  const stateRef = useRef(state);
  const [online, setOnline] = useState(() => globalThis.navigator?.onLine !== false);
  const pressRef = useRef<PartyWriteIds | null>(null);
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const retryOperation = useRef<(() => Promise<void>) | null>(null);
  const readSequence = useRef(0);

  const update = (patch: Partial<PaymentStageState>) => {
    stateRef.current = { ...stateRef.current, ...patch };
    setState(stateRef.current);
  };
  /** No tender on screen: back to what this collect step froze. */
  const noTender = (): Partial<PaymentStageState> => {
    const { method, kind, amountSatang } = initial(optionsRef.current);
    return { method, kind, amountSatang, attempt: null, route: null, qr: emptyQr };
  };

  useEffect(() => {
    generation.current += 1;
    readSequence.current += 1;
    inFlight.current = null;
    retryOperation.current = null;
    pressRef.current = null;
    stateRef.current = initial(optionsRef.current);
    setState(stateRef.current);
    // A new collect step is a new scope; the amount and method are frozen with it.
  }, [options.scope, options.active]);
  useEffect(() => {
    return () => {
      generation.current += 1;
    };
  }, []);
  useEffect(() => {
    const changed = () => setOnline(globalThis.navigator?.onLine !== false);
    globalThis.addEventListener?.('online', changed);
    globalThis.addEventListener?.('offline', changed);
    return () => {
      globalThis.removeEventListener?.('online', changed);
      globalThis.removeEventListener?.('offline', changed);
    };
  }, []);

  const perform = (operation: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    if (stateRef.current.phase === 'complete') return Promise.resolve();
    const at = generation.current;
    readSequence.current += 1;
    retryOperation.current = operation;
    update({ phase: 'busy', error: null, retryable: false, cancelRefusal: null });
    const running = Promise.resolve()
      .then(() => (generation.current === at ? operation() : undefined))
      .catch((err: unknown) => {
        if (generation.current !== at || stateRef.current.phase === 'complete') return;
        const retryable =
          err instanceof NetworkError || !(err instanceof ApiError) || err.status >= 500 || err.code === 'IDEMPOTENCY_IN_FLIGHT';
        update({
          phase: retryable ? 'blocked' : 'failed',
          retryable,
          error: err instanceof Error ? err.message : 'The payment answer could not be confirmed.',
        });
        if (!retryable) retryOperation.current = null;
      })
      .finally(() => {
        if (inFlight.current === running) inFlight.current = null;
      });
    inFlight.current = running;
    return running;
  };

  const record = async (ids: PartyWriteIds, slip?: PartySlip) => {
    const at = generation.current;
    retryOperation.current = () => record(ids, slip);
    const outcome = await optionsRef.current.record({ ids, ...(slip ? { slip } : {}) });
    if (generation.current !== at) return;
    if (outcome.recorded) {
      retryOperation.current = null;
      update({ phase: 'complete', error: null, retryable: false, outstandingSatang: 0 });
      optionsRef.current.onRecorded(outcome.amount);
      return;
    }
    if (outcome.retry) {
      update({ phase: 'blocked', retryable: true, error: 'The platform has not confirmed this payment yet. Check again: it is never taken twice.' });
      return;
    }
    retryOperation.current = null;
    pressRef.current = null;
    update({ phase: 'ready', error: null, retryable: false, ...noTender() });
    optionsRef.current.onRefused();
  };

  const adopt = async (ids: PartyWriteIds, attempt: PaymentAttemptView, qr?: PaymentQrMetadata & { responseText?: string | null }) => {
    if (stateRef.current.phase === 'complete') return;
    const metadata = qr ? { ...qr } : stateRef.current.qr;
    if (!metadata.expiresAt && metadata.expiryTimerMs !== null) {
      metadata.expiresAt = stateRef.current.attempt?.id === attempt.id && stateRef.current.qr.expiresAt
        ? stateRef.current.qr.expiresAt
        : new Date(Date.now() + metadata.expiryTimerMs).toISOString();
    }
    update({ attempt, qr: metadata, error: null, retryable: false, notStarted: false });
    if (attempt.reversalPending) {
      update({ phase: 'blocked', error: paymentStageText('reversalPending') });
    } else if (taken(attempt)) {
      update({ phase: 'busy' });
      await record(ids);
    } else if (!unresolved(attempt)) {
      // It did not happen. The next press is another tender, under its own id.
      pressRef.current = null;
      retryOperation.current = null;
      // SCRUM-979 — the platform's reason for a card never sent; a real decline keeps these words.
      const ended = endedTenderLine(attempt, qr?.responseText,
        (status) => `Payment ${status}. Press again or go back to choose another payment method.`);
      update({
        phase: 'ready',
        ...noTender(),
        error: ended.line,
        notStarted: ended.notStarted,
      });
    } else {
      update({ phase: ['unknown', 'awaiting_staff_confirmation'].includes(attempt.status) ? 'blocked' : 'pending' });
    }
  };

  const refresh = async (attemptId: string) => {
    const ids = pressRef.current;
    if (!ids || stateRef.current.phase === 'complete') return;
    const sequence = ++readSequence.current;
    const result = await paymentsApi.read(attemptId);
    if (sequence !== readSequence.current || stateRef.current.attempt?.id !== attemptId) return;
    await adopt(ids, result.attempt, result);
  };

  const submit = (): Promise<void> => {
    const snapshot = stateRef.current;
    const o = optionsRef.current;
    if (o.paused || !online || !o.method || !['ready', 'failed'].includes(snapshot.phase) || unresolved(snapshot.attempt)) {
      return Promise.resolve();
    }
    const method = o.method;
    const ids = (pressRef.current ??= { id: newId(), actionId: newId() });
    const at = generation.current;
    return perform(async () => {
      const outcome = await startPartyTenderOnPlatform({
        party: o.party,
        amount: o.amount,
        method,
        outstanding: o.outstanding,
        stationId: o.stationId,
        ids,
      });
      if (generation.current !== at) return;
      if (!outcome.ok) {
        if (outcome.retryable) {
          update({ phase: 'blocked', retryable: true, error: outcome.message });
          return;
        }
        pressRef.current = null;
        retryOperation.current = null;
        /**
         * A tender this till may finish (`inFlightTenderOf`): one a reload lost,
         * or that the press crossed with. It comes back on screen, as itself: its
         * own amount and method, not those of the press that found it.
         */
        const waiting = inFlightTenderOf(outcome.details, o.stationId);
        if (outcome.code === 'PAYMENT_IN_FLIGHT' && waiting) {
          pressRef.current = { id: waiting.paymentId, actionId: newId() };
          const read = await paymentsApi.read(waiting.attemptId);
          if (generation.current !== at) return;
          update({ route: read.route ?? null, amountSatang: read.attempt.amountSatang, ...methodOfAttempt(read.attempt) });
          retryOperation.current = () => refresh(waiting.attemptId);
          await adopt(pressRef.current, read.attempt, read);
          return;
        }
        // Refused with nothing on screen to wait for: staff are told, and keep Back.
        update({ phase: 'failed', retryable: false, error: outcome.message });
        if (outcome.code && BILL_MOVED.includes(outcome.code)) o.onRefused();
        return;
      }
      const answer = outcome.answer;
      update({ route: answer.route, qr: answer });
      if (answer.route === 'manual' && !answer.attempt) {
        retryOperation.current = null;
        update({ phase: 'manual' });
        return;
      }
      if (!answer.attempt) throw new Error('The payment route did not return an attempt.');
      const attemptId = answer.attempt.id;
      retryOperation.current = () => refresh(attemptId);
      await adopt(ids, answer.attempt, answer);
    });
  };

  const retry = (): Promise<void> => {
    if (!online || stateRef.current.phase === 'complete') return Promise.resolve();
    if (retryOperation.current) return perform(retryOperation.current);
    const attempt = stateRef.current.attempt;
    return attempt ? perform(() => refresh(attempt.id)) : Promise.resolve();
  };

  const canInquire = state.route === 'card_terminal' && Boolean(state.attempt && supportsInquiry(state.attempt)
    && ['unknown', 'awaiting_staff_confirmation'].includes(state.attempt.status));
  // Whatever its route: a party has one bill, so this is the only door a tender
  // waiting for a person has, a gateway QR's included (the panel says which it is).
  const canConfirm = state.attempt?.status === 'awaiting_staff_confirmation';

  const inquire = (): Promise<void> => {
    const attempt = stateRef.current.attempt;
    if (!online || stateRef.current.route !== 'card_terminal' || !attempt || !supportsInquiry(attempt)
      || !['unknown', 'awaiting_staff_confirmation'].includes(attempt.status)) return Promise.resolve();
    const actionId = newId();
    return perform(async () => {
      const result = await paymentsApi.inquire(attempt.id, actionId);
      update({ attempt: result.attempt });
      retryOperation.current = () => refresh(attempt.id);
      await refresh(attempt.id);
    });
  };

  const confirm = (took: boolean, details: Omit<PaymentConfirmationBody, 'took'> = {}): Promise<void> => {
    const attempt = stateRef.current.attempt;
    if (!online || attempt?.status !== 'awaiting_staff_confirmation') return Promise.resolve();
    const actionId = newId();
    return perform(async () => {
      let result;
      try {
        result = await paymentsApi.confirm(attempt.id, { ...details, took }, actionId);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status >= 500) throw err;
        // Refused: its words stay beside the attempt, which every poll clears from `error`.
        update({ cancelRefusal: err.message });
        retryOperation.current = () => refresh(attempt.id);
        await refresh(attempt.id);
        return;
      }
      update({ attempt: result.attempt });
      retryOperation.current = () => refresh(attempt.id);
      await refresh(attempt.id);
    });
  };

  const manual: PaymentStageController['manual'] = (details) => {
    const ids = pressRef.current;
    const approvalCode = details.approvalCode.trim();
    const tid = details.tid?.trim() ?? '';
    if (!online || stateRef.current.phase !== 'manual' || !ids || !approvalCode || approvalCode.length > 12
      || !tid || tid.length > 32) return Promise.resolve();
    return perform(() => record(ids, { approvalCode, tid }));
  };

  const cancel = (): Promise<boolean> => {
    const snapshot = stateRef.current;
    if (!online || optionsRef.current.paused || snapshot.route !== 'gateway' || !snapshot.attempt
      || !CANCELLABLE_QR_STATUSES.includes(snapshot.attempt.status) || snapshot.phase === 'busy' || snapshot.phase === 'complete') {
      return Promise.resolve(false);
    }
    const attemptId = snapshot.attempt.id;
    const actionId = newId();
    let cancelled = false;
    return perform(async () => {
      let result;
      try {
        result = await paymentsApi.cancel(attemptId, actionId);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 409) throw err;
        update({ cancelRefusal: err.message });
        retryOperation.current = () => refresh(attemptId);
        await refresh(attemptId);
        return;
      }
      if (result.attempt.status !== 'cancelled') {
        if (pressRef.current) await adopt(pressRef.current, result.attempt);
        return;
      }
      retryOperation.current = null;
      pressRef.current = null;
      cancelled = true;
      update({ phase: 'ready', ...noTender(), error: null, retryable: false, cancelRefusal: null });
    }).then(() => cancelled);
  };

  useEffect(() => {
    if (!online || options.paused || !options.active || !state.attempt || state.phase === 'busy' || state.phase === 'complete'
      || (!unresolved(state.attempt) && !state.retryable)) return;
    const attemptId = state.attempt.id;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!stopped) await refresh(attemptId);
      } catch (err) {
        if (!stopped) update({ phase: 'blocked', error: err instanceof Error ? err.message : 'Waiting for the payment answer.', retryable: true });
      }
      if (!stopped && stateRef.current.phase !== 'complete') timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // The attempt owns this loop; render callbacks use current refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, options.paused, options.active, options.scope, state.attempt?.id, state.attempt?.status, state.attempt?.reversalPending, state.phase, state.retryable]);

  const busy = state.phase === 'busy';
  const locked =
    Boolean(options.paused) || busy || (!needsAPerson(state.attempt) && (unresolved(state.attempt) || state.phase === 'blocked'));
  const canCancel = state.route === 'gateway' && Boolean(state.attempt && CANCELLABLE_QR_STATUSES.includes(state.attempt.status))
    && !busy && online && !options.paused && state.phase !== 'complete';
  return {
    state,
    busy,
    online,
    locked,
    canBack: !locked && state.phase !== 'complete',
    canSubmit: !locked && !unresolved(state.attempt) && online && Boolean(state.method) && (state.phase === 'ready' || state.phase === 'failed'),
    creditCoversAll: false,
    creditPendingSatang: 0,
    creditRefusal: null,
    canInquire: canInquire && !busy && online && !options.paused,
    canConfirm: canConfirm && !busy && online && !options.paused,
    canCancel,
    display: {
      saleId: null,
      amountSatang: state.attempt?.amountSatang ?? state.amountSatang,
      qrPayload: state.qr.qrPayload,
      qrImageUrl: state.qr.qrImageUrl,
      expiresAt: state.qr.expiresAt,
      status: state.phase === 'complete' ? 'paid' : state.phase === 'blocked' ? 'blocked' : locked ? 'pending' : state.phase === 'failed' ? 'failed' : 'idle',
      offline: false,
      online,
    },
    selectMethod: () => undefined,
    setAmountSatang: () => undefined,
    setTenderedSatang: () => undefined,
    submit,
    retry,
    inquire,
    confirm,
    manual,
    cancel,
  };
}
