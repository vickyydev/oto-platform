import { useCallback, useRef, useState } from 'react';
import { newId } from '@oto/shared';
import { ApiError, NetworkError } from '@/api/client';
import {
  commitSale,
  finaliseSale,
  salesApi,
  SalesLedgerUnavailable,
  type ApiSale,
  type SaleCartPayload,
  type SaleTenderPayload,
} from '@/api/sales';

/**
 * WRITING THE SALE — S2-09a (SCRUM-203).
 *
 * Before this, pressing Pay pushed an object onto an array in memory and a
 * refresh lost it. This is the other side: the sale goes to the platform, and
 * the properties that have to hold at a counter with a queue and a visitor
 * waiting are held here rather than in the screen that calls it.
 *
 * TWO PRESSES, TWO CALLS. Pay COMMITS the sale — the row, its lines, its
 * discounts — in `tendering`, with no receipt number, because no money has
 * arrived yet. The tender completing FINALISES it, and that is what allocates
 * the number. A ฿0 sale has nothing to tender, so Pay does both at once.
 *
 * 1. PRESSING PAY TWICE PRODUCES ONE SALE. The till mints the sale's id — a
 *    UUIDv7 — an action id and the clock reading, once per CART, and every
 *    attempt at that cart carries all three unchanged. Three separate things
 *    then have to fail before a second sale exists: the idempotency key
 *    (`sale:<id>`, replayed verbatim), the primary key on `pos.sale`, and
 *    `sale_action_unique (station_id, action_id)`.
 *
 * 2. A CORRECTED CART IS A DIFFERENT SALE. The ids belong to the cart they were
 *    minted for. Change the order after a refusal and the next attempt carries
 *    new ones; retry the SAME order and it keeps them, which is the whole point
 *    of having them. Before this, a refusal left the till holding one number
 *    for ever: the corrected cart answered `IDEMPOTENCY_MISMATCH` every time
 *    and only Cancel escaped, discarding the order.
 *
 * 3. A FAILURE IS VISIBLE, AND SAYS WHICH KIND IT IS. Nothing here resolves as
 *    success unless the platform said so, and a refusal carries its cause —
 *    plumbing, still-in-flight, a burnt key, or the platform judging the cart —
 *    because "try again" and "trying again will not help" are opposite
 *    instructions and reception cannot tell them apart from a status code.
 *
 * 4. AN ANSWER NEVER LANDS ON A TILL THAT HAS MOVED ON. Every attempt captures
 *    the writer's epoch, and `reset()` bumps it. An answer from a previous sale
 *    is dropped rather than written onto the visitor now standing at the
 *    counter — the same guard, for the same reason, as `saleEpochRef` in
 *    `pages/Till.tsx`.
 */

/** Why an attempt failed, in the terms the panel has to speak to reception. */
export type SaleFailureCause =
  /** Nothing answered, or the platform faulted. The sale may or may not exist. */
  | 'connection'
  /** The platform is still working on the first attempt of this same request. */
  | 'in-flight'
  /** This sale's number was already spent on a different request body. */
  | 'stale-key'
  /** The platform looked at this sale and said no. */
  | 'refused';

export type SaleWriteState =
  | { kind: 'idle' }
  | { kind: 'writing'; saleId: string; attempt: number }
  /** The platform holds this sale, unfinalised: it is recorded, and unpaid. */
  | { kind: 'committed'; saleId: string; sale: ApiSale }
  | { kind: 'finalising'; saleId: string; attempt: number }
  /** Finalised: the money is recorded and the sale carries its receipt number. */
  | { kind: 'written'; saleId: string; sale: ApiSale; replay: boolean }
  /**
   * This deployment has no sales ledger, which is a certainty rather than a
   * doubt: the route is not there, so nothing was half-written and a retry
   * cannot help. The sale stands on this till alone and the screen says so.
   */
  | { kind: 'unwritten'; saleId: string; reason: string }
  | {
      kind: 'failed';
      saleId: string;
      /** Which of the two calls failed — the record, or the money. */
      stage: 'commit' | 'finalise';
      cause: SaleFailureCause;
      message: string;
      code?: string;
      retryable: boolean;
    };

export interface SaleWriteInput {
  cart: SaleCartPayload;
  /** True only for a ฿0 sale: it has nothing to tender, so Pay closes it. */
  finalise: boolean;
  note?: string | null;
}

export type SaleWriteOutcome =
  | { ok: true; written: true; sale: ApiSale; replay: boolean; saleId: string }
  | { ok: true; written: false; saleId: string; reason: string }
  | { ok: false; saleId: string; message: string; retryable: boolean };

/**
 * Whether trying the same request again could end differently, and why.
 *
 * A retry is safe whatever the answer — the ids make it the same sale — so the
 * only question is whether it could END differently, and the answer is not
 * "is this a 409". Two of the refusals below ARE 409s and both are worth
 * retrying: one says the first attempt is still running, the other that this
 * sale's number was spent on a body the till no longer holds, which the next
 * attempt fixes by taking a fresh number under the same press.
 */
function classify(err: unknown): { cause: SaleFailureCause; retryable: boolean } {
  if (err instanceof NetworkError) return { cause: 'connection', retryable: true };
  if (err instanceof ApiError) {
    if (err.status === 409 && err.code === 'IDEMPOTENCY_IN_FLIGHT') {
      return { cause: 'in-flight', retryable: true };
    }
    if (err.status === 409 && err.code === 'IDEMPOTENCY_MISMATCH') {
      return { cause: 'stale-key', retryable: true };
    }
    // A server fault is plumbing, not judgement: the platform never got as far
    // as deciding anything about this cart.
    if (err.status >= 500) return { cause: 'connection', retryable: true };
    return { cause: 'refused', retryable: false };
  }
  return { cause: 'connection', retryable: true }; // an unknown fault is more likely plumbing
}

/** The sale id a `SALE_ACTION_REPLAY` refusal names, when it names one. */
function replayedSaleId(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== 'SALE_ACTION_REPLAY') return null;
  const details = err.details;
  if (typeof details !== 'object' || details === null) return null;
  const id = (details as { saleId?: unknown }).saleId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError || err instanceof NetworkError) return err.message;
  if (err instanceof Error) return err.message;
  return 'The sale could not be saved.';
}

/**
 * The cart as one string: everything the commit body says about what is being
 * sold. Two attempts with the same signature are the same sale and share its
 * ids; a different signature is a different sale and takes new ones.
 *
 * The ids and the clock are deliberately NOT in it — they are what the
 * signature decides, not what decides it.
 */
function signatureOf(input: SaleWriteInput): string {
  return JSON.stringify([input.cart, input.finalise, input.note ?? null]);
}

interface SaleAttempt {
  saleId: string;
  actionId: string;
  /** Minted with the ids, so every attempt at this cart sends the same body. */
  occurredAt: string;
  signature: string;
}

export interface SaleWriter {
  state: SaleWriteState;
  /**
   * Record the sale. Safe to call again for the same cart: the sale the
   * platform already holds is returned without asking it twice.
   */
  commit: (input: SaleWriteInput) => Promise<SaleWriteOutcome>;
  /** The tender completed — close the sale and take its receipt number. */
  finalise: (tender: SaleTenderPayload) => Promise<SaleWriteOutcome>;
  /**
   * Record that this sale was never offered to the platform, and why — no
   * station on the platform, no branch, nothing to send it to. It mints the id
   * the local record will carry and puts the writer in `unwritten`, so the
   * confirmation screen says the same thing it says when the route is missing
   * rather than looking like a saved sale.
   */
  declareUnwritten: (reason: string) => string;
  /** Finish with this sale: new ids next time, and any answer still in flight is ignored. */
  reset: () => void;
  /** The sale id this attempt is writing under, for the screen and the audit trail. */
  saleId: string | null;
  /** The sale the platform holds for the cart on screen, when it holds one. */
  committed: ApiSale | null;
}

export function useSaleWriter(): SaleWriter {
  const [state, setState] = useState<SaleWriteState>({ kind: 'idle' });
  const epochRef = useRef(0);
  const saleRef = useRef<SaleAttempt | null>(null);
  const committedRef = useRef<ApiSale | null>(null);
  const attemptsRef = useRef(0);
  /** Set when the platform says this sale's key was spent on another body. */
  const renewKeyRef = useRef(false);
  const inFlightRef = useRef<{ signature: string; promise: Promise<SaleWriteOutcome> } | null>(null);

  const reset = useCallback(() => {
    epochRef.current += 1;
    saleRef.current = null;
    committedRef.current = null;
    attemptsRef.current = 0;
    renewKeyRef.current = false;
    inFlightRef.current = null;
    setState({ kind: 'idle' });
  }, []);

  const commit = useCallback(async (input: SaleWriteInput): Promise<SaleWriteOutcome> => {
    const signature = signatureOf(input);

    // This exact cart is already on the platform. Pressing Confirm after Pay
    // does not ask a second time — the answer is the one in hand, and a round
    // trip at the moment money changes hands is a round trip that can fail.
    const held = committedRef.current;
    if (held && saleRef.current?.signature === signature) {
      return { ok: true, written: true, sale: held, replay: true, saleId: held.id };
    }
    // The same cart is already going out. Join that attempt rather than opening
    // a second one — a double press, or a screen that mounts twice.
    const inFlight = inFlightRef.current;
    if (inFlight && inFlight.signature === signature) return inFlight.promise;

    const previous = saleRef.current;
    let ids: SaleAttempt;
    if (previous && previous.signature === signature) {
      // The same cart: keep the number. A retry has to be the same sale, and a
      // burnt key takes a new number while keeping the press, so
      // `sale_action_unique` still refuses a second sale if the first landed.
      ids = renewKeyRef.current ? { ...previous, saleId: newId() } : previous;
    } else {
      // A different cart is a different sale. The previous one, if it was
      // committed, stays on the platform in `tendering` with no receipt number
      // — a record of an order that was rung up and not paid for. Voiding it is
      // S2-11.
      ids = {
        saleId: newId(),
        actionId: newId(),
        occurredAt: new Date().toISOString(),
        signature,
      };
      committedRef.current = null;
    }
    renewKeyRef.current = false;
    saleRef.current = ids;

    const epoch = epochRef.current;
    const attempt = ++attemptsRef.current;
    setState({ kind: 'writing', saleId: ids.saleId, attempt });

    const run = async (): Promise<SaleWriteOutcome> => {
      try {
        const result = await commitSale({
          saleId: ids.saleId,
          actionId: ids.actionId,
          cart: input.cart,
          occurredAt: ids.occurredAt,
          note: input.note ?? null,
          finalise: input.finalise,
        });
        if (epochRef.current === epoch) committedRef.current = result.sale;
        // The till has started another sale. The write still happened and the
        // platform holds it; what must not happen is this answer being drawn
        // onto the visitor now at the counter.
        if (epochRef.current === epoch) {
          setState(
            result.sale.status === 'finalised'
              ? { kind: 'written', saleId: ids.saleId, sale: result.sale, replay: result.replay }
              : { kind: 'committed', saleId: ids.saleId, sale: result.sale },
          );
        }
        return {
          ok: true,
          written: true,
          sale: result.sale,
          replay: result.replay,
          saleId: ids.saleId,
        };
      } catch (err) {
        if (err instanceof SalesLedgerUnavailable) {
          if (epochRef.current === epoch) {
            setState({ kind: 'unwritten', saleId: ids.saleId, reason: err.message });
          }
          return { ok: true, written: false, saleId: ids.saleId, reason: err.message };
        }
        // This press already produced a sale under a number the till gave up
        // on. The sale exists; adopt it rather than tell reception something
        // they cannot act on, and let the tender finish it.
        const existing = replayedSaleId(err);
        if (existing) {
          try {
            const { sale } = await salesApi.get(existing);
            if (epochRef.current === epoch) {
              committedRef.current = sale;
              saleRef.current = { ...ids, saleId: sale.id };
              setState(
                sale.status === 'finalised'
                  ? { kind: 'written', saleId: sale.id, sale, replay: true }
                  : { kind: 'committed', saleId: sale.id, sale },
              );
            }
            return { ok: true, written: true, sale, replay: true, saleId: sale.id };
          } catch {
            // Fall through to the ordinary refusal below: the sale exists but
            // this account cannot read it, which is a thing to say plainly.
          }
        }
        const { cause, retryable } = classify(err);
        if (cause === 'stale-key') renewKeyRef.current = true;
        const message = messageOf(err);
        if (epochRef.current === epoch) {
          setState({
            kind: 'failed',
            saleId: ids.saleId,
            stage: 'commit',
            cause,
            message,
            ...(err instanceof ApiError ? { code: err.code } : {}),
            retryable,
          });
        }
        return { ok: false, saleId: ids.saleId, message, retryable };
      }
    };

    const promise = run();
    inFlightRef.current = { signature, promise };
    void promise.finally(() => {
      if (inFlightRef.current?.promise === promise) inFlightRef.current = null;
    });
    return promise;
  }, []);

  const finalise = useCallback(async (tender: SaleTenderPayload): Promise<SaleWriteOutcome> => {
    const ids = saleRef.current;
    const held = committedRef.current;
    if (!ids || !held) {
      return {
        ok: false,
        saleId: ids?.saleId ?? '',
        message: 'There is no recorded sale to close — record it before taking the money.',
        retryable: false,
      };
    }
    // Already closed: a retry must not take a second receipt number, and the
    // platform would not give one, so there is nothing to ask for.
    if (held.status === 'finalised') {
      return { ok: true, written: true, sale: held, replay: true, saleId: held.id };
    }

    const epoch = epochRef.current;
    const attempt = ++attemptsRef.current;
    setState({ kind: 'finalising', saleId: held.id, attempt });
    try {
      const result = await finaliseSale(held.id, ids.actionId, tender);
      if (epochRef.current === epoch) {
        committedRef.current = result.sale;
        setState({ kind: 'written', saleId: held.id, sale: result.sale, replay: result.replay });
      }
      return { ok: true, written: true, sale: result.sale, replay: result.replay, saleId: held.id };
    } catch (err) {
      if (err instanceof SalesLedgerUnavailable) {
        // The sale is recorded; only its closing is not. Saying "saved on this
        // till only" here would be false — the platform holds the row.
        const message =
          'This deployment cannot close a sale yet (SCRUM-203): the sale is recorded and has no receipt number.';
        if (epochRef.current === epoch) {
          setState({
            kind: 'failed',
            saleId: held.id,
            stage: 'finalise',
            cause: 'refused',
            message,
            retryable: false,
          });
        }
        return { ok: false, saleId: held.id, message, retryable: false };
      }
      const { cause, retryable } = classify(err);
      const message = messageOf(err);
      if (epochRef.current === epoch) {
        setState({
          kind: 'failed',
          saleId: held.id,
          stage: 'finalise',
          cause,
          message,
          ...(err instanceof ApiError ? { code: err.code } : {}),
          retryable,
        });
      }
      return { ok: false, saleId: held.id, message, retryable };
    }
  }, []);

  const declareUnwritten = useCallback((reason: string): string => {
    const ids =
      saleRef.current ??
      ({
        saleId: newId(),
        actionId: newId(),
        occurredAt: new Date().toISOString(),
        signature: '',
      } satisfies SaleAttempt);
    saleRef.current = ids;
    setState({ kind: 'unwritten', saleId: ids.saleId, reason });
    return ids.saleId;
  }, []);

  return {
    state,
    commit,
    finalise,
    declareUnwritten,
    reset,
    saleId: saleRef.current?.saleId ?? null,
    committed: committedRef.current,
  };
}
