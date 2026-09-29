import { useEffect, useRef, useState } from 'react';
import { newId, PAYMENT_ATTEMPT_TAKEN_STATUSES, PAYMENT_ATTEMPT_TERMINAL_STATUSES, type PaymentAttemptView } from '@oto/shared';
import { ApiError, NetworkError } from '@/api/client';
import { paymentsApi, type ManualPaymentBody, type PaymentConfirmationBody, type PaymentQrMetadata, type PaymentStartBody } from '@/api/payments';
import type { ApiSale, SaleTenderPayload } from '@/api/sales';
import type { SaleWriteOutcome } from './saleWriter';
import { findPaymentMethod } from './payments';
import { lookup } from '@/i18n/dictionary';

/** Staff chrome stays English; customer displays select their own locale. */
export const paymentStageText = (key: string): string => lookup(`payment.stage.${key}`, 'en') ?? key;

export interface PaymentSettlement extends SaleTenderPayload { attemptId: string }
export interface PaymentDisplayState {
  saleId: string | null;
  amountSatang: number;
  qrPayload: string | null;
  qrImageUrl: string | null;
  expiresAt: string | null;
  status: 'idle' | 'pending' | 'paid' | 'blocked' | 'failed';
  offline: boolean;
  online: boolean;
}
export interface PaymentStageState {
  phase: 'ready' | 'busy' | 'pending' | 'manual' | 'blocked' | 'failed' | 'complete';
  saleId: string | null;
  method: string | null;
  kind: SaleTenderPayload['kind'] | null;
  outstandingSatang: number;
  amountSatang: number;
  tenderedSatang: number;
  attempt: PaymentAttemptView | null;
  route: 'card_terminal' | 'manual' | 'gateway' | null;
  qr: PaymentQrMetadata;
  error: string | null;
  retryable: boolean;
  settlements: readonly PaymentSettlement[];
}
export interface PaymentStageOptions {
  scope: string | number;
  isCurrentScope: (scope: string | number) => boolean;
  active?: boolean;
  totalSatang: number;
  prepareSale: () => Promise<SaleWriteOutcome>;
  finaliseSale: (tender?: SaleTenderPayload, actionId?: string) => Promise<SaleWriteOutcome>;
  onComplete: (sale: ApiSale, settlements: readonly PaymentSettlement[]) => void | Promise<void>;
  onLeftBehind?: (saleId: string) => void;
}
export interface PaymentStageController {
  state: PaymentStageState;
  display: PaymentDisplayState;
  busy: boolean;
  online: boolean;
  locked: boolean;
  canBack: boolean;
  canSubmit: boolean;
  canInquire: boolean;
  canConfirm: boolean;
  selectMethod: (token: string) => void;
  setAmountSatang: (amount: number) => void;
  setTenderedSatang: (amount: number) => void;
  submit: () => Promise<void>;
  retry: () => Promise<void>;
  inquire: () => Promise<void>;
  confirm: (took: boolean, details?: Omit<PaymentConfirmationBody, 'took'>) => Promise<void>;
  manual: (details: Pick<ManualPaymentBody, 'approvalCode' | 'tid' | 'last4' | 'reference'>) => Promise<void>;
}

const emptyQr: PaymentQrMetadata = { qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null };
const money = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const taken = (attempt: PaymentAttemptView): boolean => PAYMENT_ATTEMPT_TAKEN_STATUSES.includes(attempt.status);
const unresolved = (attempt: PaymentAttemptView | null): boolean => Boolean(attempt && !PAYMENT_ATTEMPT_TERMINAL_STATUSES.includes(attempt.status));
const initial = (total: number): PaymentStageState => ({
  phase: 'ready', saleId: null, method: null, kind: null, outstandingSatang: total, amountSatang: total,
  tenderedSatang: total, attempt: null, route: null, qr: emptyQr, error: null, retryable: false, settlements: [],
});
interface Context { scope: string | number; generation: number; saleId: string | null }

/** Online collection only. A timer or a failed request never proves money was not taken. */
export function usePaymentStage(options: PaymentStageOptions): PaymentStageController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [state, setState] = useState(() => initial(options.totalSatang));
  const [online, setOnline] = useState(() => globalThis.navigator?.onLine !== false);
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const stateRef = useRef(state);
  const generation = useRef(0);
  const mounted = useRef(true);
  const inFlight = useRef<Promise<void> | null>(null);
  const retryOperation = useRef<(() => Promise<void>) | null>(null);
  const closeAction = useRef<string | null>(null);
  const completed = useRef<string | null>(null);
  const readSequence = useRef(0);
  const isComplete = () => stateRef.current.phase === 'complete';
  const update = (patch: Partial<PaymentStageState>) => {
    stateRef.current = { ...stateRef.current, ...patch };
    setState(stateRef.current);
  };
  const context = (): Context => ({ scope: optionsRef.current.scope, generation: generation.current, saleId: stateRef.current.saleId });
  const current = (ctx: Context): boolean => mounted.current && generation.current === ctx.generation
    && optionsRef.current.scope === ctx.scope && optionsRef.current.isCurrentScope(ctx.scope)
    && optionsRef.current.active !== false
    && (!ctx.saleId || !stateRef.current.saleId || ctx.saleId === stateRef.current.saleId);
  const left = (ctx: Context, saleId: string) => { if (!current(ctx)) optionsRef.current.onLeftBehind?.(saleId); };

  useEffect(() => {
    generation.current += 1;
    readSequence.current += 1;
    inFlight.current = null;
    retryOperation.current = null;
    closeAction.current = null;
    completed.current = null;
    stateRef.current = initial(optionsRef.current.totalSatang);
    setState(stateRef.current);
  }, [options.scope, options.active]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);
  useEffect(() => {
    const changed = () => { onlineRef.current = globalThis.navigator?.onLine !== false; setOnline(onlineRef.current); };
    globalThis.addEventListener?.('online', changed);
    globalThis.addEventListener?.('offline', changed);
    return () => { globalThis.removeEventListener?.('online', changed); globalThis.removeEventListener?.('offline', changed); };
  }, []);

  const finish = async (ctx: Context, sale: ApiSale) => {
    if (!current(ctx)) { left(ctx, sale.id); return; }
    if (sale.status !== 'finalised' || completed.current === sale.id) return;
    completed.current = sale.id;
    readSequence.current += 1;
    retryOperation.current = null;
    update({ phase: 'complete', saleId: sale.id, outstandingSatang: 0, error: null, retryable: false });
    await optionsRef.current.onComplete(sale, stateRef.current.settlements);
  };
  const close = async (ctx: Context) => {
    if (!current(ctx)) return;
    closeAction.current ??= newId();
    update({ phase: 'busy' });
    const result = await optionsRef.current.finaliseSale(undefined, closeAction.current);
    if (!current(ctx)) { left(ctx, result.saleId); return; }
    if (!result.ok || !result.written) {
      retryOperation.current = () => close(ctx);
      update({ phase: 'blocked', error: result.ok ? 'This sale has not been recorded.' : result.message, retryable: !result.ok && result.retryable });
      return;
    }
    if (result.finalised || result.sale.status === 'finalised') { await finish(ctx, result.sale); return; }
    if (!money(result.outstandingSatang ?? -1)) {
      update({ phase: 'blocked', error: 'The payment balance has not been confirmed.', retryable: false });
      return;
    }
    update({ phase: 'ready', outstandingSatang: result.outstandingSatang!, amountSatang: result.outstandingSatang!,
      tenderedSatang: result.outstandingSatang!, method: null, attempt: null, route: null, qr: emptyQr });
  };
  const settlement = (attempt: PaymentAttemptView, method: string, kind: SaleTenderPayload['kind']) => {
    if (!taken(attempt) || stateRef.current.settlements.some((part) => part.attemptId === attempt.id)) return;
    update({ settlements: [...stateRef.current.settlements, {
      attemptId: attempt.id, method, kind, amountSatang: attempt.amountSatang,
      tenderedSatang: attempt.tenderedSatang ?? attempt.amountSatang, changeSatang: attempt.changeSatang ?? 0,
    }] });
  };
  const adopt = async (ctx: Context, attempt: PaymentAttemptView, outstanding: number | null, qr?: PaymentQrMetadata) => {
    if (!current(ctx)) { left(ctx, attempt.saleId ?? ctx.saleId ?? ''); return; }
    if (stateRef.current.phase === 'complete') return;
    if (attempt.saleId !== ctx.saleId) throw new Error('The payment answer belongs to another sale.');
    if (stateRef.current.attempt?.id === attempt.id && taken(stateRef.current.attempt) && !taken(attempt)) return;
    const metadata = qr ? { ...qr } : stateRef.current.qr;
    if (!metadata.expiresAt && metadata.expiryTimerMs !== null) {
      metadata.expiresAt = stateRef.current.attempt?.id === attempt.id && stateRef.current.qr.expiresAt
        ? stateRef.current.qr.expiresAt : new Date(Date.now() + metadata.expiryTimerMs).toISOString();
    }
    update({ attempt, qr: metadata, error: null, retryable: false,
      ...(outstanding !== null && money(outstanding) ? { outstandingSatang: outstanding } : {}) });
    if (taken(attempt)) {
      const method = stateRef.current.method ?? attempt.method;
      settlement(attempt, method, stateRef.current.kind ?? 'other');
      if (outstanding === null || !money(outstanding)) {
        update({ phase: 'blocked', error: 'The payment balance has not been confirmed.', retryable: true });
      } else if (outstanding === 0) {
        await close(ctx);
      } else {
        retryOperation.current = null;
        update({ phase: 'ready', method: null, amountSatang: outstanding, tenderedSatang: outstanding,
          attempt: null, route: null, qr: emptyQr });
      }
    } else if (!unresolved(attempt)) {
      update({ phase: 'ready', method: null, error: `Payment ${attempt.status.replaceAll('_', ' ')}. Choose a payment method.`, qr: emptyQr });
    } else {
      update({ phase: ['unknown', 'awaiting_staff_confirmation'].includes(attempt.status) ? 'blocked' : 'pending' });
    }
  };
  const refresh = async (ctx: Context, attemptId: string) => {
    if (!onlineRef.current || isComplete()) return;
    const sequence = ++readSequence.current;
    let result;
    try { result = await paymentsApi.read(attemptId); }
    catch (err) {
      if (sequence !== readSequence.current || !current(ctx) || isComplete()) return;
      throw err;
    }
    if (sequence !== readSequence.current || !current(ctx) || isComplete() || stateRef.current.attempt?.id !== attemptId) return;
    await adopt(ctx, result.attempt, result.outstandingSatang, result);
  };
  const perform = (operation: () => Promise<void>, ctx: Context): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    if (!current(ctx) || isComplete()) return Promise.resolve();
    readSequence.current += 1;
    retryOperation.current = operation;
    update({ phase: 'busy', error: null, retryable: false });
    const running = Promise.resolve().then(operation).catch((err: unknown) => {
      if (!current(ctx) || stateRef.current.phase === 'complete') return;
      const reserved = err instanceof ApiError && err.code === 'PAYMENT_IN_FLIGHT';
      const retryable = err instanceof NetworkError || !(err instanceof ApiError) || err.status >= 500 || err.code === 'IDEMPOTENCY_IN_FLIGHT';
      update({ phase: retryable || reserved ? 'blocked' : 'failed', retryable,
        error: err instanceof Error ? err.message : 'The payment answer could not be confirmed.' });
      if (!retryable) retryOperation.current = null;
    }).finally(() => {
      if (inFlight.current === running) inFlight.current = null;
      if (current(ctx) && retryOperation.current === operation && !stateRef.current.retryable) retryOperation.current = null;
    });
    inFlight.current = running;
    return running;
  };
  const prepare = async (ctx: Context): Promise<ApiSale | null> => {
    const result = await optionsRef.current.prepareSale();
    if (!current(ctx)) { left(ctx, result.saleId); return null; }
    if (!result.ok || !result.written) {
      update({ phase: 'failed', error: result.ok ? 'Record this sale before taking payment.' : result.message,
        retryable: !result.ok && result.retryable });
      return null;
    }
    const balance = result.sale.status === 'paid' || result.sale.status === 'finalised' ? 0
      : stateRef.current.saleId === result.sale.id ? stateRef.current.outstandingSatang : result.sale.totals.grossSatang;
    ctx.saleId = result.sale.id;
    update({ saleId: result.sale.id, outstandingSatang: balance });
    if (result.sale.status === 'finalised') { await finish(ctx, result.sale); return null; }
    return result.sale;
  };

  const submit = (): Promise<void> => {
    const snapshot = stateRef.current;
    if (!onlineRef.current || ['complete', 'blocked', 'pending', 'manual', 'busy'].includes(snapshot.phase) || unresolved(snapshot.attempt)) return Promise.resolve();
    const configured = snapshot.method ? findPaymentMethod(snapshot.method) : undefined;
    // A deliberate gesture freezes the current configuration, not the earlier
    // selection. Its body, kind and action stay unchanged if it needs a retry.
    const method = configured ? { ...configured } : undefined;
    if (method) update({ kind: method.kind });
    const ctx = context();
    const actionId = newId();
    const amount = snapshot.amountSatang;
    const tendered = snapshot.tenderedSatang;
    return perform(async () => {
      const sale = await prepare(ctx);
      if (!sale || !current(ctx)) return;
      if (stateRef.current.outstandingSatang === 0) { await close(ctx); return; }
      if (!method?.enabled || !money(amount) || amount <= 0 || amount > stateRef.current.outstandingSatang) {
        update({ phase: 'failed', error: 'Choose an enabled payment method and an amount within the balance.', retryable: false });
        return;
      }
      if (method.kind === 'cash') {
        if (!money(tendered) || tendered < amount) {
          update({ phase: 'failed', error: 'Cash received must cover this payment.', retryable: false });
          return;
        }
        const tender: SaleTenderPayload = { method: method.id, kind: 'cash', amountSatang: amount, tenderedSatang: tendered, changeSatang: tendered - amount };
        const result = await optionsRef.current.finaliseSale(tender, actionId);
        if (!current(ctx)) { left(ctx, result.saleId); return; }
        if (!result.ok || !result.written) {
          update({ phase: !result.ok && (result.retryable || result.code === 'PAYMENT_IN_FLIGHT') ? 'blocked' : 'failed', retryable: !result.ok && result.retryable,
            error: result.ok ? 'This payment has not been recorded.' : result.message });
          return;
        }
        if (result.attempt) settlement(result.attempt, method.id, 'cash');
        if (result.finalised || result.sale.status === 'finalised') { await finish(ctx, result.sale); return; }
        if (!money(result.outstandingSatang ?? -1)) {
          update({ phase: 'blocked', error: 'The payment balance has not been confirmed.', retryable: true });
          return;
        }
        update({ phase: 'ready', method: null, outstandingSatang: result.outstandingSatang!,
          amountSatang: result.outstandingSatang!, tenderedSatang: result.outstandingSatang!, error: null });
      } else if (method.kind === 'card' || method.kind === 'qr') {
        const body: PaymentStartBody = { saleId: sale.id, actionId, method: method.id, kind: method.kind,
          tender: method.kind, amountSatang: amount, ...(method.kind === 'qr' ? { requestQrPayload: true, qrDirection: 'show' } : {}) };
        const result = await paymentsApi.start(body);
        if (!current(ctx)) { left(ctx, sale.id); return; }
        update({ route: result.route, outstandingSatang: result.outstandingSatang, qr: result });
        if (result.route === 'manual' && !result.attempt) update({ phase: 'manual' });
        else if (result.attempt) {
          const attemptId = result.attempt.id;
          retryOperation.current = () => refresh(ctx, attemptId);
          await adopt(ctx, result.attempt, result.outstandingSatang, result);
        }
        else throw new Error('The payment route did not return an attempt.');
      } else {
        update({ phase: 'failed', error: 'This payment method has no collection route at this till.', retryable: false });
      }
    }, ctx);
  };
  const retry = (): Promise<void> => {
    if (!onlineRef.current || isComplete()) return Promise.resolve();
    if (retryOperation.current) return perform(retryOperation.current, context());
    const attempt = stateRef.current.attempt;
    const ctx = context();
    return attempt ? perform(() => refresh(ctx, attempt.id), ctx) : Promise.resolve();
  };
  const canInquire = state.route === 'card_terminal' && Boolean(state.attempt && state.attempt.provider !== 'ghl'
    && ['unknown', 'awaiting_staff_confirmation'].includes(state.attempt.status));
  const canConfirm = state.route === 'card_terminal' && state.attempt?.status === 'awaiting_staff_confirmation';
  const inquire = (): Promise<void> => {
    if (!onlineRef.current || stateRef.current.route !== 'card_terminal' || !stateRef.current.attempt
      || stateRef.current.attempt.provider === 'ghl'
      || !['unknown', 'awaiting_staff_confirmation'].includes(stateRef.current.attempt.status)) return Promise.resolve();
    const ctx = context();
    const attemptId = stateRef.current.attempt.id;
    const actionId = newId();
    return perform(async () => {
      const result = await paymentsApi.inquire(attemptId, actionId);
      if (!current(ctx) || stateRef.current.attempt?.id !== attemptId) return;
      update({ attempt: result.attempt });
      retryOperation.current = () => refresh(ctx, attemptId);
      await refresh(ctx, attemptId);
    }, ctx);
  };
  const confirm = (took: boolean, details: Omit<PaymentConfirmationBody, 'took'> = {}): Promise<void> => {
    if (!onlineRef.current || stateRef.current.route !== 'card_terminal' || stateRef.current.attempt?.status !== 'awaiting_staff_confirmation') return Promise.resolve();
    const ctx = context();
    const attemptId = stateRef.current.attempt.id;
    const actionId = newId();
    const body = { ...details, took };
    return perform(async () => {
      const result = await paymentsApi.confirm(attemptId, body, actionId);
      if (!current(ctx) || stateRef.current.attempt?.id !== attemptId) return;
      update({ attempt: result.attempt });
      retryOperation.current = () => refresh(ctx, attemptId);
      await refresh(ctx, attemptId);
    }, ctx);
  };
  const manual: PaymentStageController['manual'] = (details) => {
    const snapshot = stateRef.current;
    if (!onlineRef.current || snapshot.phase !== 'manual' || !snapshot.saleId || !snapshot.method || !details.approvalCode.trim()
      || details.approvalCode.trim().length > 12 || !details.tid?.trim() || details.tid.trim().length > 32) return Promise.resolve();
    const method = findPaymentMethod(snapshot.method);
    if (!method?.enabled) return Promise.resolve();
    const ctx = context();
    const body: ManualPaymentBody = { ...details, approvalCode: details.approvalCode.trim(), tid: details.tid.trim(),
      saleId: snapshot.saleId, actionId: newId(), method: method.id, kind: method.kind, amountSatang: snapshot.amountSatang };
    update({ kind: method.kind });
    return perform(async () => {
      const result = await paymentsApi.manual(body);
      if (!current(ctx)) { left(ctx, body.saleId); return; }
      update({ attempt: result.attempt });
      retryOperation.current = () => refresh(ctx, result.attempt.id);
      await adopt(ctx, result.attempt, result.outstandingSatang);
    }, ctx);
  };

  useEffect(() => {
    if (!online || options.active === false || !state.attempt || state.phase === 'busy' || state.phase === 'complete'
      || (!unresolved(state.attempt) && !state.retryable)) return;
    const ctx = context();
    const attemptId = state.attempt.id;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { if (!stopped && current(ctx)) await refresh(ctx, attemptId); }
      catch (err) { if (!stopped && current(ctx)) update({ phase: 'blocked', error: err instanceof Error ? err.message : 'Waiting for the payment answer.', retryable: true }); }
      if (!stopped && current(ctx) && stateRef.current.phase !== 'complete') timer = setTimeout(() => { void poll(); }, 1500);
    };
    timer = setTimeout(() => { void poll(); }, 1500);
    return () => { stopped = true; clearTimeout(timer); };
    // The retained attempt owns this loop; render callbacks use current refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, options.active, options.scope, state.attempt?.id, state.attempt?.status, state.phase, state.retryable]);

  const busy = state.phase === 'busy';
  const locked = busy || unresolved(state.attempt) || state.phase === 'blocked';
  const method = state.method ? findPaymentMethod(state.method) : undefined;
  const canSubmit = !locked && state.phase !== 'complete' && state.phase !== 'manual'
    && (state.outstandingSatang === 0 || Boolean(method?.enabled && money(state.amountSatang) && state.amountSatang > 0
      && state.amountSatang <= state.outstandingSatang && (method.kind !== 'cash' || state.tenderedSatang >= state.amountSatang)));
  return {
    state, busy, online, locked, canSubmit: canSubmit && online, canInquire: canInquire && !busy && online, canConfirm: canConfirm && !busy && online,
    canBack: !locked && state.settlements.length === 0 && state.phase !== 'complete',
    display: { saleId: state.saleId, amountSatang: state.attempt?.amountSatang ?? state.amountSatang,
      qrPayload: state.qr.qrPayload, qrImageUrl: state.qr.qrImageUrl, expiresAt: state.qr.expiresAt,
      status: state.phase === 'complete' ? 'paid' : locked ? state.phase === 'blocked' ? 'blocked' : 'pending' : state.phase === 'failed' ? 'failed' : 'idle',
      offline: state.attempt?.offline ?? false, online },
    selectMethod: (token) => {
      if (stateRef.current.phase === 'busy' || stateRef.current.phase === 'blocked' || unresolved(stateRef.current.attempt) || stateRef.current.phase === 'complete') return;
      const selected = findPaymentMethod(token);
      if (!selected?.enabled) return;
      retryOperation.current = null;
      update({ method: token, kind: selected.kind, phase: 'ready', attempt: null, route: null, qr: emptyQr, error: null, retryable: false });
    },
    setAmountSatang: (amount) => {
      if (!locked && state.phase !== 'manual' && money(amount)) update({ amountSatang: amount,
        tenderedSatang: stateRef.current.tenderedSatang === stateRef.current.amountSatang ? amount : stateRef.current.tenderedSatang });
    },
    setTenderedSatang: (amount) => { if (!locked && state.phase !== 'manual' && money(amount)) update({ tenderedSatang: amount }); },
    submit, retry, inquire, confirm, manual,
  };
}
