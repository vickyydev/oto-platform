import { useEffect, useRef, useState } from 'react';
import { BOX_WALLET_REFUSALS, newId, PAYMENT_ATTEMPT_TAKEN_STATUSES, PAYMENT_ATTEMPT_TERMINAL_STATUSES, WALLET_TENDER_CODE, type PaymentAttemptView } from '@oto/shared';
import { api, ApiError, NetworkError } from '@/api/client';
import { apiSaleOfBox, laneSale, spendWalletOnBox, type BoxLaneSale } from '@/api/boxSales';
import { paymentsApi, type ManualPaymentBody, type PaymentConfirmationBody, type PaymentQrMetadata, type PaymentStartBody } from '@/api/payments';
import { salesApi, spendWalletOnSale, type ApiSale, type SaleFinaliseResult, type SaleTenderPayload } from '@/api/sales';
import type { SaleWriteOutcome } from './saleWriter';
import { currentLane } from './lane';
import { findPaymentMethod, getEnabledPaymentMethods } from './payments';
import { isStockRefusalCode, stockRefusalWords } from './stockRefusal';
import { lookup } from '@/i18n/dictionary';

/** Staff chrome stays English; customer displays select their own locale. */
export const paymentStageText = (key: string): string => lookup(`payment.stage.${key}`, 'en') ?? key;

export interface PaymentSettlement extends SaleTenderPayload {
  attemptId: string;
  /** S2-14a — on the credit settlement only: what the wallet held after it, the platform's figure. */
  walletBalanceAfterSatang?: number;
}

/**
 * S2-14a round 2 — THE SCANNED WALLET, as the station hands it to the stage.
 * `previewSatang` is what the till expects credit to cover (min(balance,
 * outstanding)); the platform decides the real figure under the wallet's lock.
 */
export interface PaymentStageWallet {
  key: string;
  useCredit: boolean;
  previewSatang: number;
}

/** True for the credit settlement the platform wrote — never a tender from the grid. */
export const isCreditSettlement = (part: Pick<PaymentSettlement, 'method'>): boolean => part.method === WALLET_TENDER_CODE;
export interface PaymentDisplayState {
  saleId: string | null;
  amountSatang: number;
  qrPayload: string | null;
  qrImageUrl: string | null;
  expiresAt: string | null;
  status: 'idle' | 'pending' | 'paid' | 'blocked' | 'failed';
  offline: boolean;
  online: boolean;
  /** S2-14a — credit taken, or about to be, on this order; the display's "from your credit". */
  creditSatang?: number;
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
  /** S2-14a — credit the platform has taken on this sale so far. */
  creditSatang: number;
  /** S2-14a — the sale the scanned wallet was already spent on: once per sale, however many presses. */
  creditSaleId: string | null;
  /**
   * S2-14a round 2 — the sale credit was REFUSED on: no credit is pending on
   * it, the guest display shows the whole amount, and the station is told why.
   */
  creditRefusedSaleId: string | null;
  /**
   * S2-14a round 3 / staging F3 — the words of the refusal on
   * `creditRefusedSaleId`, as the platform or the counter's box said them
   * (`WALLET_EMPTY`, `WALLET_INSUFFICIENT`, `WALLET_EXPIRED`,
   * `WALLET_OFFLINE_CAP`, `WALLET_NOT_ON_BOX`, ...).
   */
  creditRefusalMessage?: string | null;
  /** S2-14a round 3 — counts refusals, so a second identical refusal still takes the toggle off. */
  creditRefusalSeq?: number;
}
export interface PaymentStageOptions {
  scope: string | number;
  isCurrentScope: (scope: string | number) => boolean;
  active?: boolean;
  /** A staff lock pauses work without discarding this visitor's money state. */
  paused?: boolean;
  totalSatang: number;
  /** Read a durable unfinished charge before allowing any new collection. */
  resumeSaleId?: string;
  prepareSale: () => Promise<SaleWriteOutcome>;
  finaliseSale: (tender?: SaleTenderPayload, actionId?: string) => Promise<SaleWriteOutcome>;
  onComplete: (sale: ApiSale, settlements: readonly PaymentSettlement[]) => void | Promise<void>;
  onLeftBehind?: (saleId: string) => void;
  /** S2-14a round 2 — spend this wallet first, on the confirm press. Null for no credit. */
  wallet?: PaymentStageWallet | null;
}
export interface PaymentStageController {
  state: PaymentStageState;
  display: PaymentDisplayState;
  busy: boolean;
  online: boolean;
  locked: boolean;
  canBack: boolean;
  canSubmit: boolean;
  /** S2-14a — the scanned credit is expected to cover what is owed: confirm needs no tender. */
  creditCoversAll: boolean;
  /** S2-14a — credit still to be taken by the next press (zero once taken). */
  creditPendingSatang: number;
  /**
   * S2-14a round 2 — why credit was refused on this sale, in the words of
   * whoever refused it (the platform, or the counter's box). Null while credit
   * can be, or has been, taken.
   */
  creditRefusal: string | null;
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
const unresolved = (attempt: PaymentAttemptView | null): boolean => Boolean(attempt && (attempt.reversalPending || !PAYMENT_ATTEMPT_TERMINAL_STATUSES.includes(attempt.status)));
const supportsInquiry = (attempt: PaymentAttemptView): boolean => attempt.inquirySupported
  ?? (attempt.provider !== 'ghl' && Boolean(attempt.terminalRef));
const initial = (total: number): PaymentStageState => ({
  phase: 'ready', saleId: null, method: null, kind: null, outstandingSatang: total, amountSatang: total,
  tenderedSatang: total, attempt: null, route: null, qr: emptyQr, error: null, retryable: false, settlements: [],
  creditSatang: 0, creditSaleId: null, creditRefusedSaleId: null, creditRefusalMessage: null, creditRefusalSeq: 0,
});
/**
 * S2-14a round 3 — the platform's refusals of a credit press that take
 * nothing: the wallet is empty, holds less than asked, or its credit has
 * expired. The stage treats them like the box lane's refusal — the toggle
 * comes off, the whole amount is owed, CASH is preselected (OD-W3) — so the
 * next press takes the money instead of asking the wallet again.
 */
const WALLET_REFUSAL_CODES: readonly string[] = ['WALLET_EMPTY', 'WALLET_INSUFFICIENT', 'WALLET_EXPIRED'];
/**
 * Staging F3 — THE BOX'S REFUSALS of a credit press on the box lane, said on
 * the card in its words exactly as the platform's are: the day's offline cap
 * (`WALLET_OFFLINE_CAP`), a wallet the box holds no copy of, a snapshot too old
 * to trust, a box that cannot count credit, credit not taken on this kind of
 * sale — and the platform's own three, which the box says the same way.
 */
const BOX_WALLET_REFUSAL_CODES: readonly string[] = [
  ...WALLET_REFUSAL_CODES,
  BOX_WALLET_REFUSALS.cap.code,
  BOX_WALLET_REFUSALS.unknown.code,
  BOX_WALLET_REFUSALS.stale.code,
  BOX_WALLET_REFUSALS.noCounter.code,
  'WALLET_NOT_HERE',
];
/**
 * Staging F3 — WHERE A SALE'S CREDIT IS TAKEN. A sale the box holds — rung up
 * on it, or rung up on the platform by a till that has since moved to its box
 * — spends the scanned wallet through the box's own `payment.wallet` (S2-14a
 * round 4: the balance snapshot, the ฿300-a-day offline cap, one spend per
 * press, synced once). Any other sale spends on the platform. Null for the
 * platform. (Round 2 refused credit on the box lane outright; the box has
 * counted it since round 4, and the till now asks it.)
 */
const creditOnTheBox = (saleId: string): BoxLaneSale | null => {
  const held = laneSale(saleId);
  return held && (held.lane !== 'platform' || currentLane() === 'box') ? held : null;
};
/**
 * Staging gate F3 — THE BOX PRICES CREDIT AGAINST THE WHOLE CART. Its
 * `payment.wallet` re-prices the order and owes `gross - credit`; it knows
 * nothing of money the platform already took on a sale rung up there. So a
 * platform-rung sale goes to the box for credit only while it has taken
 * nothing on the platform: no settlement, and the whole order still owed. A
 * sale rung up on the box knows its own tenders and always may. Anything else
 * (card ฿300 online, then the link drops) is refused here, before any call.
 */
const boxCanPriceCredit = (held: BoxLaneSale, settled: number, outstanding: number, gross: number): boolean =>
  held.lane !== 'platform' || (settled === 0 && outstanding === gross);
/** Said on the card when a part-paid platform sale asks the offline box for credit. */
export const SPLIT_CREDIT_OFFLINE_REFUSAL =
  'Part of this order was paid while the counter was online, so credit cannot be taken on the rest while it is offline. Take the rest with another payment, or use credit when the connection is back.';
/** The box's credit answer in the shape the platform's carries it. */
const boxCreditAnswer = (answer: Awaited<ReturnType<typeof spendWalletOnBox>>): SaleFinaliseResult => ({
  sale: apiSaleOfBox(answer.sale),
  replay: answer.replay,
  finalised: answer.finalised,
  outstandingSatang: answer.outstandingSatang,
  attempt: answer.attempt,
  walletAttempt: answer.walletAttempt ?? null,
  walletSpend: answer.walletSpend
    ? { walletId: answer.walletSpend.walletId, amountSatang: answer.walletSpend.amountSatang, balanceAfterSatang: answer.walletSpend.balanceAfterSatang }
    : null,
});
interface Context { scope: string | number; generation: number; pause: number; saleId: string | null }
type Operation = (ctx: Context) => Promise<void>;
interface ResumeEvidence { saleId: string; attempt?: PaymentAttemptView | null; route?: PaymentStageState['route']; qr?: PaymentQrMetadata }

/**
 * Online collection, and — on the box lane — cash and credit through the box.
 * A timer or a failed request never proves money was not taken.
 */
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
  const retryOperation = useRef<Operation | null>(null);
  const pauseSequence = useRef(0);
  const pauseState = useRef(Boolean(options.paused));
  const resumeNeeded = useRef(false);
  const resumeEvidence = useRef<ResumeEvidence | null>(null);
  if (pauseState.current !== Boolean(options.paused)) {
    pauseState.current = Boolean(options.paused);
    pauseSequence.current += 1;
  }
  const closeAction = useRef<string | null>(null);
  /**
   * Staging F3 — the lane each sale's credit was SENT on. A credit press whose
   * answer was lost may have been taken there, so the same sale's credit is
   * never then asked of the other lane (a second spend of one wallet); only a
   * refusal, which took nothing, lets it go.
   */
  const creditLane = useRef(new Map<string, 'platform' | 'box'>());
  const completed = useRef<string | null>(null);
  const readSequence = useRef(0);
  const resumedSale = useRef<string | null>(null);
  const isComplete = () => stateRef.current.phase === 'complete';
  const update = (patch: Partial<PaymentStageState>) => {
    stateRef.current = { ...stateRef.current, ...patch };
    setState(stateRef.current);
  };
  const context = (): Context => ({ scope: optionsRef.current.scope, generation: generation.current,
    pause: pauseSequence.current, saleId: stateRef.current.saleId });
  const sameSession = (ctx: Context): boolean => mounted.current && generation.current === ctx.generation
    && optionsRef.current.scope === ctx.scope
    && (!ctx.saleId || !stateRef.current.saleId || ctx.saleId === stateRef.current.saleId);
  const current = (ctx: Context): boolean => sameSession(ctx) && pauseSequence.current === ctx.pause
    && optionsRef.current.isCurrentScope(ctx.scope) && !optionsRef.current.paused
    && optionsRef.current.active !== false;
  const left = (ctx: Context, saleId: string) => { if (!sameSession(ctx)) optionsRef.current.onLeftBehind?.(saleId); };
  const retain = (ctx: Context, evidence: ResumeEvidence) => {
    if (sameSession(ctx)) resumeEvidence.current = evidence;
    else left(ctx, evidence.saleId);
  };

  useEffect(() => {
    generation.current += 1;
    readSequence.current += 1;
    inFlight.current = null;
    retryOperation.current = null;
    resumeNeeded.current = false;
    resumeEvidence.current = null;
    closeAction.current = null;
    completed.current = null;
    resumedSale.current = null;
    stateRef.current = initial(optionsRef.current.totalSatang);
    if (optionsRef.current.resumeSaleId) stateRef.current.phase = 'blocked';
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
    if (!current(ctx)) { retain(ctx, { saleId: result.saleId }); return; }
    if (!result.ok || !result.written) {
      retryOperation.current = close;
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
    if (stateRef.current.attempt?.id === attempt.id && stateRef.current.attempt.reversalPending
      && attempt.reversalPending !== false) attempt = { ...attempt, reversalPending: true };
    if (stateRef.current.attempt?.id === attempt.id && taken(stateRef.current.attempt) && !taken(attempt)) return;
    const metadata = qr ? { ...qr } : stateRef.current.qr;
    if (!metadata.expiresAt && metadata.expiryTimerMs !== null) {
      metadata.expiresAt = stateRef.current.attempt?.id === attempt.id && stateRef.current.qr.expiresAt
        ? stateRef.current.qr.expiresAt : new Date(Date.now() + metadata.expiryTimerMs).toISOString();
    }
    update({ attempt, qr: metadata, error: null, retryable: false,
      ...(outstanding !== null && money(outstanding) ? { outstandingSatang: outstanding } : {}) });
    if (attempt.reversalPending) {
      update({ phase: 'blocked', error: paymentStageText('reversalPending') });
    } else if (taken(attempt)) {
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
  const perform = (operation: Operation, ctx: Context): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    if (!current(ctx) || isComplete()) return Promise.resolve();
    readSequence.current += 1;
    retryOperation.current = operation;
    update({ phase: 'busy', error: null, retryable: false });
    const running = Promise.resolve().then(() => current(ctx) ? operation(ctx) : undefined).catch((err: unknown) => {
      if (!current(ctx) || stateRef.current.phase === 'complete') return;
      // S2-14b round 4 (Q1): the cart's stock refused — by the counter's box at
      // a card or credit press — took nothing. Its words, as they came; never
      // retried, because the same cart meets the same shelf.
      const stockWords = stockRefusalWords(err);
      if (stockWords !== null) {
        retryOperation.current = null;
        update({ phase: 'failed', retryable: false, error: stockWords });
        return;
      }
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
    if (!current(ctx)) { retain(ctx, { saleId: result.saleId }); return null; }
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
    if ((optionsRef.current.resumeSaleId && resumedSale.current !== optionsRef.current.resumeSaleId) || optionsRef.current.paused || !onlineRef.current || ['complete', 'blocked', 'pending', 'manual', 'busy'].includes(snapshot.phase) || unresolved(snapshot.attempt)) return Promise.resolve();
    const configured = snapshot.method ? findPaymentMethod(snapshot.method) : undefined;
    // A deliberate gesture freezes the current configuration, not the earlier
    // selection. Its body, kind and action stay unchanged if it needs a retry.
    const method = configured ? { ...configured } : undefined;
    if (method) update({ kind: method.kind });
    const ctx = context();
    const actionId = newId();
    let amount = snapshot.amountSatang;
    const tendered = snapshot.tenderedSatang;
    const wallet = optionsRef.current.wallet ?? null;
    const walletAction = newId();
    let preparedSale: ApiSale | null = null;
    return perform(async (ctx) => {
      const sale = preparedSale ?? await prepare(ctx);
      if (!sale || !current(ctx)) return;
      preparedSale = sale;
      ctx.saleId = sale.id;
      /**
       * S2-14a round 2 — THE CREDIT FIRST (plan §2.3). The platform writes the
       * wallet tender itself from the scanned key; this press only says "use
       * credit". Its answer is the real figure and the real remainder: a
       * remainder the chosen method and the cash handed over cover is taken in
       * the same press; otherwise the stage stops on it with CASH preselected
       * (OD-W3). A refusal (`WALLET_EMPTY`, `WALLET_INSUFFICIENT`) stops here,
       * having taken nothing, in the platform's words.
       */
      if (wallet?.useCredit && wallet.key && stateRef.current.creditSaleId !== sale.id && stateRef.current.outstandingSatang > 0) {
        // Staging F3 — the box lane spends through the box; once sent, a sale's
        // credit stays on the lane it was sent on (a retry, a second press).
        const sent = creditLane.current.get(sale.id);
        const boxSale = sent === 'platform' ? null : creditOnTheBox(sale.id);
        if (sent === undefined && boxSale && !boxCanPriceCredit(boxSale, stateRef.current.settlements.length,
          stateRef.current.outstandingSatang, sale.totals.grossSatang)) {
          // Refused before any call, nothing locked: the whole remainder is
          // owed, CASH is preselected (OD-W3), the station takes the toggle off.
          const cash = getEnabledPaymentMethods().find((m) => m.kind === 'cash');
          const outstanding = stateRef.current.outstandingSatang;
          retryOperation.current = null;
          update({ phase: 'failed', error: SPLIT_CREDIT_OFFLINE_REFUSAL, retryable: false,
            creditRefusedSaleId: sale.id, creditRefusalMessage: SPLIT_CREDIT_OFFLINE_REFUSAL,
            creditRefusalSeq: (stateRef.current.creditRefusalSeq ?? 0) + 1,
            method: cash?.id ?? null, kind: cash ? 'cash' : null,
            amountSatang: outstanding, tenderedSatang: outstanding, attempt: null, route: null, qr: emptyQr });
          return;
        }
        const onBox = sent === 'box' || boxSale !== null;
        const refusals = onBox ? BOX_WALLET_REFUSAL_CODES : WALLET_REFUSAL_CODES;
        let answer: SaleFinaliseResult;
        try {
          creditLane.current.set(sale.id, onBox ? 'box' : 'platform');
          if (onBox) {
            const held = boxSale ?? laneSale(sale.id);
            if (!held) throw new Error('This sale’s credit was sent to the counter’s box, which no longer holds it.');
            answer = boxCreditAnswer(await spendWalletOnBox(held, { key: wallet.key, actionId: walletAction }));
          } else {
            answer = await spendWalletOnSale(sale.id, walletAction, { key: wallet.key, useCredit: true });
          }
        } catch (err) {
          // A refusal took nothing, so the sale's credit is not held to the lane
          // it was sent on — the wallet's refusals, and (round 4, Q1) the box's
          // refusal of the cart's stock, which the stage then says verbatim.
          if (err instanceof ApiError && (refusals.includes(err.code) || isStockRefusalCode(err.code))) {
            creditLane.current.delete(sale.id);
          }
          if (!(err instanceof ApiError) || !refusals.includes(err.code) || !current(ctx)) throw err;
          // Refused, nothing taken: the platform's words on the card, the toggle off.
          const cash = getEnabledPaymentMethods().find((m) => m.kind === 'cash');
          const outstanding = stateRef.current.outstandingSatang;
          retryOperation.current = null;
          update({ phase: 'failed', error: err.message, retryable: false,
            creditRefusedSaleId: sale.id, creditRefusalMessage: err.message, creditRefusalSeq: (stateRef.current.creditRefusalSeq ?? 0) + 1,
            method: cash?.id ?? null, kind: cash ? 'cash' : null,
            amountSatang: outstanding, tenderedSatang: outstanding, attempt: null, route: null, qr: emptyQr });
          return;
        }
        if (!current(ctx)) { retain(ctx, { saleId: sale.id }); return; }
        update({ creditSaleId: sale.id });
        const credit = answer.walletAttempt ?? null;
        /**
         * S2-14a round 3 — THE CREDIT FIGURE IS THE SETTLED ATTEMPT'S. A press
         * retried after a lost answer comes back as a replay: `walletSpend` is
         * null (nothing new was taken) while `walletAttempt` is the spend the
         * platform holds. The stage counts the attempt the moment it settles it,
         * once, so the till's "taken from credit" line and the display's "From
         * your credit" row read the same figure as the settlement.
         */
        let credited = 0;
        if (credit && taken(credit) && !stateRef.current.settlements.some((part) => part.attemptId === credit.id)) {
          update({ settlements: [...stateRef.current.settlements, {
            attemptId: credit.id, method: WALLET_TENDER_CODE, kind: 'other',
            amountSatang: credit.amountSatang, tenderedSatang: credit.amountSatang, changeSatang: 0,
            ...(answer.walletSpend ? { walletBalanceAfterSatang: answer.walletSpend.balanceAfterSatang } : {}),
          }] });
          credited = credit.amountSatang;
        } else if (!credit) {
          credited = answer.walletSpend?.amountSatang ?? 0;
        }
        update({ creditSatang: stateRef.current.creditSatang + credited });
        if (answer.finalised || answer.sale.status === 'finalised') { await finish(ctx, answer.sale); return; }
        const remaining = answer.outstandingSatang;
        if (remaining === undefined || !money(remaining)) {
          update({ phase: 'blocked', error: 'The payment balance has not been confirmed.', retryable: true });
          return;
        }
        update({ outstandingSatang: remaining });
        const cash = getEnabledPaymentMethods().find((m) => m.kind === 'cash');
        const chosen = method?.enabled ? method : undefined;
        const coversRemainder = Boolean(chosen && amount > 0 && (chosen.kind !== 'cash' || tendered >= Math.min(amount, remaining)));
        if (!coversRemainder) {
          retryOperation.current = null;
          update({ phase: 'ready', method: chosen?.id ?? cash?.id ?? null, kind: chosen?.kind ?? (cash ? 'cash' : null),
            amountSatang: remaining, tenderedSatang: remaining, error: null, retryable: false });
          return;
        }
        amount = Math.min(amount, remaining);
      }
      if (stateRef.current.outstandingSatang === 0) { await close(ctx); return; }
      if (!method?.enabled || !money(amount) || amount <= 0 || amount > stateRef.current.outstandingSatang) {
        update({ phase: 'failed', error: 'Choose an enabled payment method and an amount within the balance.', retryable: false });
        return;
      }
      if (method.kind === 'cash' || method.kind === 'other') {
        if (method.kind === 'cash' && (!money(tendered) || tendered < amount)) {
          update({ phase: 'failed', error: 'Cash received must cover this payment.', retryable: false });
          return;
        }
        const tender: SaleTenderPayload = { method: method.id, kind: method.kind, amountSatang: amount,
          ...(method.kind === 'cash' ? { tenderedSatang: tendered, changeSatang: tendered - amount } : {}) };
        const result = await optionsRef.current.finaliseSale(tender, actionId);
        if (!current(ctx)) { retain(ctx, { saleId: result.saleId, ...(result.ok && result.written ? { attempt: result.attempt } : {}) }); return; }
        if (!result.ok && isStockRefusalCode(result.code)) {
          // Round 4 (Q1): the counter's box refused the cart's stock at the cash
          // press — nothing taken, nothing saved; its words exactly, no retry.
          retryOperation.current = null;
          update({ phase: 'failed', retryable: false, error: result.message });
          return;
        }
        if (!result.ok || !result.written) {
          update({ phase: !result.ok && (result.retryable || result.code === 'PAYMENT_IN_FLIGHT') ? 'blocked' : 'failed', retryable: !result.ok && result.retryable,
            error: result.ok ? 'This payment has not been recorded.' : result.message });
          return;
        }
        if (result.attempt) settlement(result.attempt, method.id, method.kind);
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
        if (!current(ctx)) { retain(ctx, { saleId: sale.id, attempt: result.attempt, route: result.route, qr: result }); return; }
        update({ route: result.route, outstandingSatang: result.outstandingSatang, qr: result });
        if (result.route === 'manual' && !result.attempt) update({ phase: 'manual' });
        else if (result.attempt) {
          const attemptId = result.attempt.id;
          retryOperation.current = (ctx) => refresh(ctx, attemptId);
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
    return attempt ? perform((ctx) => refresh(ctx, attempt.id), ctx) : Promise.resolve();
  };
  const canInquire = state.route === 'card_terminal' && Boolean(state.attempt && supportsInquiry(state.attempt)
    && ['unknown', 'awaiting_staff_confirmation'].includes(state.attempt.status));
  const canConfirm = state.route === 'card_terminal' && state.attempt?.status === 'awaiting_staff_confirmation';
  const inquire = (): Promise<void> => {
    if (!onlineRef.current || stateRef.current.route !== 'card_terminal' || !stateRef.current.attempt
      || !supportsInquiry(stateRef.current.attempt)
      || !['unknown', 'awaiting_staff_confirmation'].includes(stateRef.current.attempt.status)) return Promise.resolve();
    const ctx = context();
    const attemptId = stateRef.current.attempt.id;
    const actionId = newId();
    return perform(async (ctx) => {
      const result = await paymentsApi.inquire(attemptId, actionId);
      if (!current(ctx) || stateRef.current.attempt?.id !== attemptId) return;
      update({ attempt: result.attempt });
      retryOperation.current = (ctx) => refresh(ctx, attemptId);
      await refresh(ctx, attemptId);
    }, ctx);
  };
  const confirm = (took: boolean, details: Omit<PaymentConfirmationBody, 'took'> = {}): Promise<void> => {
    if (!onlineRef.current || stateRef.current.route !== 'card_terminal' || stateRef.current.attempt?.status !== 'awaiting_staff_confirmation') return Promise.resolve();
    const ctx = context();
    const attemptId = stateRef.current.attempt.id;
    const actionId = newId();
    const body = { ...details, took };
    return perform(async (ctx) => {
      const result = await paymentsApi.confirm(attemptId, body, actionId);
      if (!current(ctx) || stateRef.current.attempt?.id !== attemptId) return;
      update({ attempt: result.attempt });
      retryOperation.current = (ctx) => refresh(ctx, attemptId);
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
    return perform(async (ctx) => {
      const result = await paymentsApi.manual(body);
      if (!current(ctx)) { retain(ctx, { saleId: body.saleId, attempt: result.attempt }); return; }
      update({ attempt: result.attempt });
      retryOperation.current = (ctx) => refresh(ctx, result.attempt.id);
      await adopt(ctx, result.attempt, result.outstandingSatang);
    }, ctx);
  };

  useEffect(() => {
    if (options.paused) {
      resumeNeeded.current = true;
      readSequence.current += 1;
      return;
    }
    if (!resumeNeeded.current || options.active === false || !online) return;
    resumeNeeded.current = false;
    if (isComplete()) return;
    const ctx = context();
    const pending = inFlight.current;
    const beforeResume = stateRef.current;
    update({ phase: 'blocked', retryable: false, error: 'Checking the payment after unlock.' });
    const recover = async () => {
      await pending;
      if (!current(ctx) || isComplete()) return;
      const evidence = resumeEvidence.current;
      const retainedOperation = retryOperation.current;
      await perform(async (ctx) => {
        const saleId = evidence?.saleId ?? stateRef.current.saleId;
        let sale: ApiSale | undefined;
        if (saleId) {
          sale = (await salesApi.get(saleId)).sale;
          if (!current(ctx)) return;
          if (sale.id !== saleId) throw new Error('The payment answer belongs to another sale.');
          ctx.saleId = sale.id;
          update({ saleId: sale.id });
        }
        const attempt = evidence?.attempt ?? stateRef.current.attempt;
        if (attempt) {
          update({ attempt, ...(evidence?.route ? { route: evidence.route } : {}), ...(evidence?.qr ? { qr: evidence.qr } : {}) });
          retryOperation.current = (ctx) => refresh(ctx, attempt.id);
          await refresh(ctx, attempt.id);
        } else if (evidence?.route === 'manual' || beforeResume.phase === 'manual') {
          update({ route: 'manual', phase: 'manual' });
        } else if (retainedOperation) {
          retryOperation.current = retainedOperation;
          update({ phase: 'blocked', error: 'The payment answer could not be confirmed. Retry the original payment.', retryable: true });
        } else if (sale?.status === 'finalised') {
          await finish(ctx, sale);
        } else {
          update({ phase: beforeResume.phase === 'blocked' ? 'blocked' : 'ready',
            error: beforeResume.error, retryable: beforeResume.retryable });
        }
        if (current(ctx)) resumeEvidence.current = null;
      }, ctx);
    };
    void recover();
    // Resume uses retained refs, not a new collection gesture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.paused, options.active, options.scope, online]);

  useEffect(() => {
    const saleId = options.resumeSaleId;
    if (!saleId || resumedSale.current === saleId || !online || options.paused || options.active === false) return;
    const ctx = context();
    ctx.saleId = saleId;
    update({ phase: 'blocked', saleId, error: 'Checking the unfinished payment.', retryable: false });
    const recover: Operation = async (ctx) => {
      const detail = await api.get<{ sale: ApiSale; attempts?: PaymentAttemptView[] }>(`/sales/${encodeURIComponent(saleId)}`);
      if (!current(ctx)) return;
      if (detail.sale.id !== saleId) throw new Error('The payment answer belongs to another sale.');
      if (detail.sale.status === 'voided' || detail.sale.status === 'refunded') {
        update({ phase: 'blocked', error: 'This charge is no longer open for payment.', retryable: false });
        return;
      }
      if (detail.sale.status === 'finalised') { resumedSale.current = saleId; await finish(ctx, detail.sale); return; }
      if (!detail.attempts) throw new Error('The recorded payments could not be confirmed.');
      if (detail.attempts.some((attempt) => attempt.saleId !== saleId)) throw new Error('The payment answer belongs to another sale.');
      for (const attempt of detail.attempts) {
        const method = findPaymentMethod(attempt.method) ?? getEnabledPaymentMethods().find((item) => item.kind === attempt.method);
        settlement(attempt, method?.id ?? attempt.method, method?.kind ?? 'other');
      }
      const unresolvedAttempts = detail.attempts.filter(unresolved);
      if (unresolvedAttempts.length > 1) throw new Error('More than one payment needs review. Resolve the recorded payments before collecting again.');
      const pending = unresolvedAttempts[0];
      const latest = pending ?? detail.attempts.at(-1);
      if (latest) {
        const answer = await paymentsApi.read(latest.id);
        if (!current(ctx)) return;
        if (answer.attempt.saleId !== saleId || answer.attempt.id !== latest.id) throw new Error('The payment answer belongs to another sale.');
        if (!money(answer.outstandingSatang ?? -1)) throw new Error('The payment balance has not been confirmed.');
        if (pending) {
          if (!answer.route) throw new Error('The payment route has not been confirmed.');
          const method = findPaymentMethod(answer.attempt.method) ?? getEnabledPaymentMethods().find((item) => item.kind === answer.attempt.method);
          update({ method: method?.id ?? answer.attempt.method, kind: method?.kind ?? null, route: answer.route });
          retryOperation.current = (ctx) => refresh(ctx, latest.id);
          resumedSale.current = saleId;
          await adopt(ctx, answer.attempt, answer.outstandingSatang, answer);
          return;
        }
        const outstanding = answer.outstandingSatang!;
        resumedSale.current = saleId;
        update({ phase: 'ready', outstandingSatang: outstanding, amountSatang: outstanding, tenderedSatang: outstanding, method: null, error: null, retryable: false });
      } else {
        const outstanding = detail.sale.status === 'paid' ? 0 : detail.sale.totals.grossSatang;
        resumedSale.current = saleId;
        update({ phase: 'ready', outstandingSatang: outstanding, amountSatang: outstanding, tenderedSatang: outstanding, method: null, error: null, retryable: false });
      }
      resumedSale.current = saleId;
    };
    void perform(recover, ctx);
    // Recovery owns this charge and uses the same cancellation guards as collection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.resumeSaleId, options.scope, options.active, options.paused, online]);

  useEffect(() => {
    if (!online || options.paused || options.active === false || !state.attempt || state.phase === 'busy' || state.phase === 'complete'
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
  }, [online, options.paused, options.active, options.scope, state.attempt?.id, state.attempt?.status, state.attempt?.reversalPending, state.phase, state.retryable]);

  const busy = state.phase === 'busy';
  const recovering = Boolean(options.resumeSaleId && resumedSale.current !== options.resumeSaleId);
  const locked = recovering || Boolean(options.paused) || busy || unresolved(state.attempt) || state.phase === 'blocked';
  const method = state.method ? findPaymentMethod(state.method) : undefined;
  const walletOption = options.wallet ?? null;
  const creditRefusal = state.saleId && state.creditRefusedSaleId === state.saleId ? (state.creditRefusalMessage ?? null) : null;
  const creditPendingSatang = walletOption?.useCredit && walletOption.key && !creditRefusal && (!state.saleId || state.creditSaleId !== state.saleId)
    ? Math.max(0, Math.min(walletOption.previewSatang, state.outstandingSatang)) : 0;
  const creditCoversAll = creditPendingSatang > 0 && creditPendingSatang >= state.outstandingSatang;
  const canSubmit = !locked && state.phase !== 'complete' && state.phase !== 'manual'
    && (state.outstandingSatang === 0 || creditCoversAll || Boolean(method?.enabled && money(state.amountSatang) && state.amountSatang > 0
      && state.amountSatang <= state.outstandingSatang && (method.kind !== 'cash' || state.tenderedSatang >= state.amountSatang)));
  return {
    state, busy, online, locked, canSubmit: canSubmit && online, creditCoversAll, creditPendingSatang, creditRefusal, canInquire: canInquire && !busy && online && !options.paused, canConfirm: canConfirm && !busy && online && !options.paused,
    canBack: !locked && state.settlements.length === 0 && state.phase !== 'complete',
    // Staging F2 — the guest's "left to pay" is the order less the credit from
    // the moment credit is chosen, not once a tender is picked: the tender
    // panel's amount is the whole order until the station sets the remainder.
    display: { saleId: state.saleId, amountSatang: state.attempt?.amountSatang
      ?? (creditPendingSatang > 0 ? Math.min(state.amountSatang, Math.max(0, state.outstandingSatang - creditPendingSatang)) : state.amountSatang),
      qrPayload: state.qr.qrPayload, qrImageUrl: state.qr.qrImageUrl, expiresAt: state.qr.expiresAt,
      status: state.phase === 'complete' ? 'paid' : locked ? state.phase === 'blocked' ? 'blocked' : 'pending' : state.phase === 'failed' ? 'failed' : 'idle',
      offline: state.attempt?.offline ?? false, online, creditSatang: state.creditSatang + creditPendingSatang },
    selectMethod: (token) => {
      if ((optionsRef.current.resumeSaleId && resumedSale.current !== optionsRef.current.resumeSaleId) || optionsRef.current.paused || stateRef.current.phase === 'busy' || stateRef.current.phase === 'blocked' || unresolved(stateRef.current.attempt) || stateRef.current.phase === 'complete') return;
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
