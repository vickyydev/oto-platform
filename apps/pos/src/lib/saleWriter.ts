import { useCallback, useEffect, useRef, useState } from 'react';
import { newId, type PaymentAttemptView } from '@oto/shared';
import { ApiError, NetworkError } from '@/api/client';
import {
  apiSaleOfBox,
  finaliseOnBox,
  forgetLaneSale,
  holdLaneSale,
  laneSale,
  observeReceipt,
  rungUpOnBox,
} from '@/api/boxSales';
import {
  currentLane,
  isBoxLaneTrigger,
  laneStation,
  noteLaneFailure,
  paymentRefusalMessage,
} from './lane';
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
 * the number. A ฿0 sale has nothing to tender, so a caller may close it at Pay
 * (`finalise`); the ticket and F&B tills do not — they close it at their
 * confirm press like any other, so their Cancel can still void it (S2-10b).
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
 *    and only Cancel escaped, discarding the order. Two answers give the same
 *    cart a new number under the same press: a key spent on another body, and a
 *    voucher the platform says is not held for the sale (`voucherNotHeld`),
 *    because the stored refusal would outlive the scan that fixes it.
 *
 * 3. A FAILURE IS VISIBLE, AND SAYS WHICH KIND IT IS. Nothing here resolves as
 *    success unless the platform said so, and a refusal carries its cause —
 *    plumbing, still-in-flight, a burnt key, or the platform judging the cart —
 *    because "try again" and "trying again will not help" are opposite
 *    instructions and reception cannot tell them apart from a status code.
 *
 * 4. AN ANSWER NEVER LANDS ON A TILL THAT HAS MOVED ON. Every attempt captures
 *    the writer's epoch and sale identity; reset and unmount invalidate it.
 *    An answer from a previous sale is dropped rather than drawn onto the next
 *    visitor at the counter — the same guard as `saleEpochRef` in
 *    `pages/Till.tsx`.
 *
 * 5. THE BOX LANE (offline plan §2.4, Round 4). When the lane arbiter says box
 *    — the station forced offline, the link down — the same input commits
 *    through the station bridge instead: the box prices the cart, and the
 *    tender closes it there, numbered, banded and printed from the box's own
 *    queue (`api/boxSales.ts`). A sale stays on the lane it was rung up on. One
 *    rung up on the platform whose cash press meets a dropped link is closed on
 *    the box under the same ids, and meets itself on replay; an electronic
 *    tender is never moved (plan §2.1). After an online sale the till tells its
 *    box the number the platform gave it, so the box's offline series never
 *    re-issues it (OD-4, `receipt.observed`).
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
  /** The platform holds this open sale, with any partial payments recorded. */
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
  /**
   * Close a ฿0 sale in the commit itself: it has nothing to tender. False from
   * the ticket and F&B tills for every sale — see `SaleCommitBody.finalise`.
   */
  finalise: boolean;
  note?: string | null;
  /**
   * SCRUM-208 — THE VISIT THIS SALE FOLLOWS. Set when the cart followed a
   * membership check that opened a visit, so the commit carries it and band
   * minting names the children (`SaleCommitBody.visitId`). Part of what makes
   * two carts different sales: a changed visit takes a fresh sale id.
   */
  visitId?: string | null;
  /**
   * S2-10b — THE SALE ID A VOUCHER IS ALREADY HELD FOR. A voucher is held for
   * a cart by the id the till minted for it, before Pay, and the commit that
   * uses it up must carry the same one. So a NEW cart takes this id rather
   * than minting its own — unless an earlier attempt has already been sent
   * under it, in which case that id's key is spent and a fresh one is minted
   * like any other (the caller then moves the voucher; see `prepare`). Not
   * part of what makes two attempts the same sale.
   */
  preferSaleId?: string;
}

export type SaleWriteOutcome =
  | {
      ok: true;
      /** The platform recorded the sale; `finalised` says whether it closed. */
      written: true;
      sale: ApiSale;
      replay: boolean;
      saleId: string;
      finalised?: boolean;
      outstandingSatang?: number;
      attempt?: PaymentAttemptView | null;
    }
  | { ok: true; written: false; saleId: string; reason: string }
  | { ok: false; saleId: string; message: string; retryable: boolean; code?: string };

/** What the till's Cancel did to the sale this cart was rung up as (`cancel`). */
export type SaleCancelOutcome =
  /** `voided` is false when nothing had been rung up: there was no sale to void. */
  | { ok: true; voided: boolean }
  /**
   * The platform would not void it, and said why in its own words: money has
   * been taken (a refund, which comes later), a tender is still in progress,
   * or the sale is already closed — `closed`, and then the confirmation is what
   * belongs on screen, not a cancel.
   */
  | { ok: false; code: string; message: string; closed: boolean };

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

/**
 * THE PLATFORM SAID THE VOUCHER IS NOT HELD FOR THIS SALE (`VOUCHER_NOT_HELD`):
 * its hold lapsed and another till took it, or it was let go. The idempotency
 * store keeps that refusal under this sale's key (`sale:<id>`) and replays it to
 * every later attempt with the same body, so once the voucher has been scanned
 * again — held 200 — the same cart would still meet the stored 409 until it
 * changed. The next attempt takes a fresh number instead, keeping the press as a
 * spent key does (`renewKeyRef`), and the till moves the voucher to that number
 * before it commits (`prepare`, then `moveTo` in lib/tillVoucher.ts).
 */
function voucherNotHeld(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'VOUCHER_NOT_HELD';
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
  // Offline plan Round 3: money on the box lane is round 4's. A payment that
  // met a dropped link or a station forced offline says so in the counter's
  // words, and the lane arbiter moves the till to its box for everything else.
  const offline = paymentRefusalMessage(err);
  if (offline) return offline;
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
  return JSON.stringify([input.cart, input.finalise, input.note ?? null, input.visitId ?? null]);
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
  /**
   * S2-10b — the sale id `commit(input)` will write this cart under, decided
   * now and kept, so the commit uses exactly it. A till holding a voucher asks
   * this before Pay and moves the voucher to the answer when it is not the id
   * the voucher is held for (`lib/tillVoucher.ts`).
   */
  prepare: (input: SaleWriteInput) => string;
  /** Record a tender, or close after recorded payments when no tender is supplied. */
  finalise: (tender?: SaleTenderPayload, actionId?: string) => Promise<SaleWriteOutcome>;
  /**
   * S2-10b — THE TILL'S CANCEL of the sale this cart was rung up as: voided with
   * `reason`, so it can never be paid and any voucher it held is free again
   * (`POST /sales/:id/void`). Any rung-up sale that took no money, voucher or
   * not. A Pay still being written is waited for first — the sale it writes is
   * the one to void, and cancelling past it would leave it `tendering` with
   * nothing on screen to say so.
   */
  cancel: (reason: string) => Promise<SaleCancelOutcome>;
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
  /**
   * S2-10b — WHETHER THIS SCREEN RANG THAT SALE UP: an id one of its own attempts
   * was sent under, the sale on screen, or one it left behind when the order
   * changed after Pay. Only such a sale may be voided without asking when a
   * voucher has to follow the corrected cart (`moveTo` in lib/tillVoucher.ts).
   * The platform names a rung-up sale to every screen standing at the same till,
   * and another screen may be taking cash for it (audit M12), so a sale this
   * returns false for is voided only by a person's deliberate choice.
   */
  ownsSale: (saleId: string) => boolean;
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
  /**
   * S2-10b — every sale id an attempt has been sent under, and the id of a sale
   * adopted from a `SALE_ACTION_REPLAY`. Its idempotency key is spent on that
   * attempt's body, so a new cart never takes one of these as its id, whatever
   * voucher is held for it (`preferSaleId`). It is also what makes a sale this
   * screen's own (`ownsSale`).
   */
  const sentRef = useRef<Set<string>>(new Set());
  /**
   * S2-10b — sales this visitor's cart was rung up as and then left behind
   * when the order changed after Pay: each is still `tendering` on the
   * platform, unpaid, and the till's Cancel voids them with the one on screen
   * (`cancel`), so throwing the order away leaves none of them behind.
   */
  const supersededRef = useRef<Map<string, ApiSale>>(new Map());

  useEffect(() => {
    return () => { epochRef.current += 1; };
  }, []);

  const isCurrent = useCallback(
    (epoch: number, saleId: string): boolean =>
      epochRef.current === epoch && saleRef.current?.saleId === saleId,
    [],
  );

  /**
   * The ids the next attempt at a cart carries — the rule `commit` has always
   * followed, in one place so `prepare` can answer it before the commit runs.
   * The same cart keeps its ids (a new number under the same press when its
   * key was spent); a different cart is a different sale and takes new ones,
   * starting from the voucher's id when there is one it may take.
   */
  const decideIds = useCallback((signature: string, preferSaleId?: string): SaleAttempt => {
    const previous = saleRef.current;
    if (previous && previous.signature === signature) {
      return renewKeyRef.current ? { ...previous, saleId: newId() } : previous;
    }
    // A different cart is a different sale. The previous one, if it was
    // committed, stays on the platform in `tendering` with no receipt number —
    // a record of an order that was rung up and not paid for. It is kept here
    // so the till's Cancel voids it with the sale on screen (`cancel`); paying
    // the corrected sale leaves it as it is.
    const left = committedRef.current;
    if (left && left.status !== 'finalised') supersededRef.current.set(left.id, left);
    committedRef.current = null;
    return {
      saleId: preferSaleId && !sentRef.current.has(preferSaleId) ? preferSaleId : newId(),
      actionId: newId(),
      occurredAt: new Date().toISOString(),
      signature,
    };
  }, []);

  const reset = useCallback(() => {
    epochRef.current += 1;
    saleRef.current = null;
    committedRef.current = null;
    attemptsRef.current = 0;
    renewKeyRef.current = false;
    inFlightRef.current = null;
    sentRef.current = new Set();
    supersededRef.current = new Map();
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
    if (inFlight && inFlight.signature === signature && saleRef.current?.signature === signature) {
      return inFlight.promise;
    }

    // The same cart keeps its number — a retry has to be the same sale, and a
    // burnt key takes a new number while keeping the press, so
    // `sale_action_unique` still refuses a second sale if the first landed. A
    // different cart is a different sale (`decideIds`).
    const ids = decideIds(signature, input.preferSaleId);
    renewKeyRef.current = false;
    saleRef.current = ids;
    sentRef.current.add(ids.saleId);

    const epoch = epochRef.current;
    const attempt = ++attemptsRef.current;
    setState({ kind: 'writing', saleId: ids.saleId, attempt });

    const station = laneStation();
    const rungUp = {
      saleId: ids.saleId,
      actionId: ids.actionId,
      occurredAt: ids.occurredAt,
      cart: input.cart,
      visitId: input.visitId ?? null,
      note: input.note ?? null,
    };
    let triedBox = false;
    /**
     * The box lane: priced and held on the box, closed there by its tender. A
     * ฿0 sale the caller wants closed at Pay is closed on the box at once.
     */
    const onBox = async (stationId: string): Promise<SaleWriteOutcome> => {
      triedBox = true;
      let sale = await rungUpOnBox({ ...rungUp, stationId });
      if (input.finalise && sale.totals.grossSatang === 0) {
        const closed = await finaliseOnBox(laneSale(ids.saleId)!, undefined, ids.actionId);
        sale = apiSaleOfBox(closed.sale);
      }
      if (isCurrent(epoch, ids.saleId)) {
        committedRef.current = sale;
        setState(
          sale.status === 'finalised'
            ? { kind: 'written', saleId: ids.saleId, sale, replay: false }
            : { kind: 'committed', saleId: ids.saleId, sale },
        );
      }
      return { ok: true, written: true, sale, replay: false, saleId: ids.saleId };
    };

    const run = async (): Promise<SaleWriteOutcome> => {
      try {
        if (station && currentLane() === 'box') return await onBox(station);
        const result = await commitSale({
          saleId: ids.saleId,
          actionId: ids.actionId,
          cart: input.cart,
          occurredAt: ids.occurredAt,
          visitId: input.visitId ?? null,
          note: input.note ?? null,
          finalise: input.finalise,
        });
        // Kept for the box lane: a cash press that meets a dropped link closes
        // this same sale on the box, under the same ids.
        if (station) holdLaneSale({ ...rungUp, stationId: station, lane: 'platform' });
        if (result.sale.status === 'finalised') observeReceipt(station, result.sale.receiptNumber);
        if (isCurrent(epoch, ids.saleId)) committedRef.current = result.sale;
        // The till has started another sale. The write still happened and the
        // platform holds it; what must not happen is this answer being drawn
        // onto the visitor now at the counter.
        if (isCurrent(epoch, ids.saleId)) {
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
      } catch (caught) {
        let err: unknown = caught;
        // The platform is unreachable or the station is forced offline: the
        // same sale is rung up on the box instead (OD-1).
        if (station && !triedBox && isBoxLaneTrigger(err)) {
          noteLaneFailure(err);
          try {
            return await onBox(station);
          } catch (boxErr) {
            err = boxErr;
          }
        }
        if (err instanceof SalesLedgerUnavailable) {
          if (isCurrent(epoch, ids.saleId)) {
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
            if (isCurrent(epoch, ids.saleId)) {
              committedRef.current = sale;
              saleRef.current = { ...ids, saleId: sale.id };
              sentRef.current.add(sale.id);
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
        // A spent key, or a refusal the store would replay after its cause has
        // cleared (`voucherNotHeld`): the next attempt at this cart goes under a
        // new number. Only when this attempt's answer still belongs to this
        // cart — a cart that moved on has new ids already.
        if ((cause === 'stale-key' || voucherNotHeld(err)) && isCurrent(epoch, ids.saleId)) {
          renewKeyRef.current = true;
        }
        const message = messageOf(err);
        if (isCurrent(epoch, ids.saleId)) {
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
  }, [decideIds, isCurrent]);

  const prepare = useCallback(
    (input: SaleWriteInput): string => {
      const signature = signatureOf(input);
      // Already on the platform, or already going out: that sale's id.
      const held = committedRef.current;
      if (held && saleRef.current?.signature === signature) return held.id;
      const inFlight = inFlightRef.current;
      if (inFlight && inFlight.signature === signature && saleRef.current?.signature === signature) {
        return saleRef.current.saleId;
      }
      // Decided now and kept: `commit` finds this cart's ids and uses them.
      const ids = decideIds(signature, input.preferSaleId);
      renewKeyRef.current = false;
      saleRef.current = ids;
      return ids.saleId;
    },
    [decideIds],
  );

  const finalise = useCallback(async (tender?: SaleTenderPayload, actionId?: string): Promise<SaleWriteOutcome> => {
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
      return {
        ok: true, written: true, sale: held, replay: true, saleId: held.id,
        finalised: true, outstandingSatang: 0, attempt: null,
      };
    }

    const epoch = epochRef.current;
    const attempt = ++attemptsRef.current;
    setState({ kind: 'finalising', saleId: held.id, attempt });
    const station = laneStation();
    const onTheBox = laneSale(held.id);
    /**
     * Close it on the box: a sale rung up there, or — for cash, which has no
     * unknown outcome — one rung up on the platform whose link has gone. A card
     * or the PAX QR that already closed it on the box answers from what the box
     * said (`payment.start`, `api/boxSales.ts`).
     */
    const closeOnBox = async (): Promise<SaleWriteOutcome> => {
      const boxSale = onTheBox!;
      const answer =
        boxSale.answer?.finalised
          ? boxSale.answer
          : await finaliseOnBox(boxSale, tender, actionId ?? ids.actionId);
      const sale = apiSaleOfBox(answer.sale);
      if (isCurrent(epoch, ids.saleId)) {
        committedRef.current = sale;
        setState(answer.finalised
          ? { kind: 'written', saleId: held.id, sale, replay: answer.replay }
          : { kind: 'committed', saleId: held.id, sale });
      }
      return {
        ok: true, written: true, sale, replay: answer.replay, saleId: held.id,
        finalised: answer.finalised, outstandingSatang: answer.outstandingSatang, attempt: answer.attempt,
      };
    };
    const cashOrNothing = !tender || tender.kind === 'cash' || tender.amountSatang === 0;
    try {
      if (onTheBox && (onTheBox.lane === 'box' || (cashOrNothing && station && currentLane() === 'box'))) {
        return await closeOnBox();
      }
      // A split uses one explicit identity per deliberate tender; retries keep it.
      let result;
      try {
        result = await finaliseSale(held.id, actionId ?? ids.actionId, tender);
      } catch (err) {
        // The link went at the cash press: the same sale, the same press, on the box.
        if (onTheBox && station && cashOrNothing && isBoxLaneTrigger(err)) {
          noteLaneFailure(err);
          return await closeOnBox();
        }
        throw err;
      }
      const finalised = result.finalised ?? result.sale.status === 'finalised';
      if (finalised) observeReceipt(station, result.sale.receiptNumber);
      if (isCurrent(epoch, ids.saleId)) {
        committedRef.current = result.sale;
        setState(finalised
          ? { kind: 'written', saleId: held.id, sale: result.sale, replay: result.replay }
          : { kind: 'committed', saleId: held.id, sale: result.sale });
      }
      return {
        ok: true, written: true, sale: result.sale, replay: result.replay, saleId: held.id,
        finalised,
        ...(result.outstandingSatang === undefined ? {} : { outstandingSatang: result.outstandingSatang }),
        attempt: result.attempt ?? null,
      };
    } catch (err) {
      if (err instanceof SalesLedgerUnavailable) {
        // The sale is recorded; only its closing is not. Saying "saved on this
        // till only" here would be false — the platform holds the row.
        const message =
          'This deployment cannot close a sale yet (SCRUM-203): the sale is recorded and has no receipt number.';
        if (isCurrent(epoch, ids.saleId)) {
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
      if (isCurrent(epoch, ids.saleId)) {
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
      return { ok: false, saleId: held.id, message, retryable, ...(err instanceof ApiError ? { code: err.code } : {}) };
    }
  }, [isCurrent]);

  const cancel = useCallback(async (reason: string): Promise<SaleCancelOutcome> => {
    const epoch = epochRef.current;
    const actionId = saleRef.current?.actionId;
    const inFlight = inFlightRef.current;
    if (inFlight) await inFlight.promise;
    if (epochRef.current !== epoch || saleRef.current?.actionId !== actionId) {
      return { ok: true, voided: false };
    }
    const onScreen = committedRef.current;
    if (onScreen?.status === 'finalised') {
      // Known closed: said in the platform's words for it, without asking.
      return {
        ok: false,
        code: 'SALE_FINALISED',
        message: 'This sale is finalised — a closed sale is refunded, not voided',
        closed: true,
      };
    }
    // The sale on screen last, so a refusal about it is the one left showing.
    const rungUp = [...supersededRef.current.values(), ...(onScreen ? [onScreen] : [])].filter(
      (s) => s.status !== 'voided',
    );
    if (rungUp.length === 0) return { ok: true, voided: false };
    for (const s of rungUp) {
      /**
       * A sale rung up on the box lane exists nowhere but on this till until
       * it is paid (Round 4): there is nothing to void, only an order to let
       * go. One the box has closed is refunded, online; one with a terminal
       * tender still waiting is resolved first.
       */
      const boxHeld = laneSale(s.id);
      if (boxHeld?.lane === 'box') {
        if (boxHeld.answer?.finalised) {
          return {
            ok: false,
            code: 'SALE_FINALISED',
            message: 'This sale is finalised — a closed sale is refunded, not voided',
            closed: s.id === onScreen?.id,
          };
        }
        const waiting = boxHeld.answer?.attempt;
        if (waiting && ['sent_to_terminal', 'unknown', 'inquiring', 'awaiting_staff_confirmation'].includes(waiting.status)) {
          return {
            ok: false,
            code: 'PAYMENT_IN_FLIGHT',
            message: 'A payment is still waiting for its answer on the terminal. Resolve it before cancelling.',
            closed: false,
          };
        }
        forgetLaneSale(s.id);
        supersededRef.current.delete(s.id);
        continue;
      }
      try {
        const answer = await salesApi.voidSale(s.id, reason);
        if (epochRef.current === epoch && saleRef.current?.actionId === actionId) {
          if (committedRef.current?.id === s.id) committedRef.current = answer.sale;
          supersededRef.current.delete(s.id);
        }
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'CONNECTION';
        return {
          ok: false,
          code,
          message: messageOf(err),
          closed: code === 'SALE_FINALISED' && s.id === onScreen?.id,
        };
      }
    }
    return { ok: true, voided: true };
  }, []);

  const ownsSale = useCallback(
    (saleId: string): boolean =>
      sentRef.current.has(saleId) ||
      supersededRef.current.has(saleId) ||
      committedRef.current?.id === saleId,
    [],
  );

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
    prepare,
    finalise,
    cancel,
    declareUnwritten,
    reset,
    saleId: saleRef.current?.saleId ?? null,
    committed: committedRef.current,
    ownsSale,
  };
}
