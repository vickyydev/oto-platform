import { useCallback, useEffect, useRef, useState } from 'react';
import { newId, type PaymentAttemptView } from '@oto/shared';
import { ApiError, NetworkError } from '@/api/client';
import { answeredByBox } from '@/api/bridge';
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
import { ORDER_CHANGED_AFTER_PAY } from './voidReasons';
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
 *
 * 6. A CORRECTED ORDER LEAVES NO SALE BEHIND (SCRUM-865). The sale rung up at
 *    Pay for the order as it was is voided — reason "Order changed at the till
 *    after Pay" — before the corrected cart is rung up, when it took no money
 *    and this screen rang it up. The platform's void gives back the document
 *    check or hand approval it spent (`restoreTierClaimOf`), so the corrected
 *    sale prices at the rate staff confirmed; it is waited for when the cart
 *    names a claim or a voucher is held, and runs beside the commit otherwise.
 *    A void the platform refuses, or one the link cannot carry, changes
 *    nothing: the sale stays in the list the till's Cancel voids, as before.
 *    A sale a tender has taken money on is never voided this way — money
 *    taken is refunded, not voided — and a sale rung up on the box lane,
 *    which exists nowhere but on this till until it is paid, is let go here.
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
      /**
       * SCRUM-502 — the counter's box gave this answer, not the platform, so
       * the panel names the box. Absent: the platform answered, or nothing did.
       */
      answeredBy?: 'box';
      /**
       * SCRUM-502 — where the order stands after a money press that failed.
       * `till`: it was rung up on the box lane, which keeps it on this till
       * alone until it is paid, so the platform holds no row of it. Absent:
       * the platform holds it, unpaid. A fact about the lane, set whatever the
       * cause: only a refusal makes "unpaid" certain, since a press whose
       * answer was lost may already be paid on the box (the panel words each).
       */
      heldOn?: 'till';
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

/** Who a cart belongs to, as the commit body names them. */
interface CartWho {
  memberId: string | null;
  customerPhone: string | null;
  customerNickname: string | null;
}
const whoOf = (input: SaleWriteInput): CartWho => ({
  memberId: input.cart.memberId ?? null,
  customerPhone: input.cart.customerPhone ?? null,
  customerNickname: input.cart.customerNickname ?? null,
});
/**
 * SCRUM-779 — the cart with who it belongs to left out: what is being sold.
 * Two carts with the same body and a member added to the second are the same
 * order once that member has joined the sale (`attachMember`).
 */
function bodySignatureOf(input: SaleWriteInput): string {
  const { memberId: _member, customerPhone: _phone, customerNickname: _nickname, ...cart } = input.cart;
  return JSON.stringify([cart, input.finalise, input.note ?? null, input.visitId ?? null]);
}

interface SaleAttempt {
  saleId: string;
  actionId: string;
  /** Minted with the ids, so every attempt at this cart sends the same body. */
  occurredAt: string;
  signature: string;
  /** SCRUM-779 — `bodySignatureOf` the same cart, and who it was rung up for. */
  body: string;
  who: CartWho;
}

/**
 * SCRUM-779 — what became of a member who arrived after the sale was rung up.
 * `nothing-rung-up`: no sale yet, so the member simply rides with the cart.
 * Every other answer keeps the sale that is open as THE sale for this order:
 * `attached` when the platform added the member to it, otherwise the reason it
 * stays a walk-in's (a box-lane sale the platform does not hold yet, a sale
 * already closed, or the platform's refusal in its own words).
 */
export type MemberJoinOutcome =
  | { attached: true; saleId: string }
  | { attached: false; reason: 'nothing-rung-up' | 'box' | 'closed' | 'refused'; message?: string };

interface MemberJoin {
  memberId: string;
  /** The attempt the member joined — its action id, which no other cart shares. */
  attemptKey: string;
  /** The sale the platform has added the member to, once it has. */
  attachedSaleId: string | null;
  settled: Promise<MemberJoinOutcome>;
  /** On its way to the platform: a second caller waits for it rather than sending another. */
  running: boolean;
  /**
   * No sale of this attempt had landed when it last looked — the ids were
   * decided (the payment screen's `prepare`) but the commit had not gone out.
   * The commit that lands it then adds the member.
   */
  waiting: boolean;
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
  /**
   * SCRUM-779 — A MEMBER WHO ARRIVED AFTER PAY JOINS THE SALE ALREADY RUNG UP.
   *
   * The customer display's details become a member a moment after the payment
   * screen rang the sale up as a walk-in. The cart then names a member the sale
   * does not, and the next commit — the Confirm press — would have been a
   * different sale: the same order rung up twice, the first left unpaid.
   *
   * From this call on, a cart that differs from the sale rung up ONLY in who it
   * belongs to is that sale: `commit` sends it exactly as it was rung up, and
   * the platform adds the member to the open sale (`POST /sales/:id/member`),
   * waiting first for a commit still on the wire. When the platform cannot add
   * the member, the sale stays a walk-in's — still one sale — and the answer
   * says why. A cart whose ORDER changes is a different sale, as it always was.
   */
  attachMember: (memberId: string) => Promise<MemberJoinOutcome>;
  /**
   * TAKE OVER A SALE THE PLATFORM ALREADY HOLDS, rung up by this account at
   * this station before the page was reloaded (`lib/resumeSale.ts`). The
   * writer then stands exactly where it stood after that sale's Pay: the sale
   * is `committed`, `finalise` closes it under its own id, `cancel` voids it,
   * and `ownsSale` answers true for it — so no voucher refusal offers to void
   * it under the person paying for it. Nothing is written: the platform's row
   * is the one in hand. False, and nothing changes, for a sale that is not
   * open — a closed sale is its confirmation's, a voided one is nobody's.
   */
  adopt: (sale: ApiSale) => boolean;
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
  /**
   * SCRUM-865 — sales a tender of this screen has taken money on, in part or
   * in whole. Never voided without asking when the order changes after Pay:
   * money taken is refunded, not voided, and the platform would refuse it.
   */
  const moneyTakenRef = useRef<Set<string>>(new Set());
  /** SCRUM-779 — the member who joined the sale on screen after it was rung up. */
  const joinRef = useRef<MemberJoin | null>(null);

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
  const decideIds = useCallback((input: SaleWriteInput, preferSaleId?: string): SaleAttempt => {
    const signature = signatureOf(input);
    const previous = saleRef.current;
    if (previous && previous.signature === signature) {
      return renewKeyRef.current ? { ...previous, saleId: newId() } : previous;
    }
    // A different cart is a different sale. The previous one, if it was
    // committed, is on the platform in `tendering` with no receipt number — a
    // record of an order that was rung up and not paid for. It is kept here
    // so the commit of the corrected cart voids it first (`voidSuperseded`,
    // SCRUM-865), and so the till's Cancel voids whatever that left (`cancel`).
    const left = committedRef.current;
    if (left && left.status !== 'finalised') supersededRef.current.set(left.id, left);
    committedRef.current = null;
    return {
      saleId: preferSaleId && !sentRef.current.has(preferSaleId) ? preferSaleId : newId(),
      actionId: newId(),
      occurredAt: new Date().toISOString(),
      signature,
      body: bodySignatureOf(input),
      who: whoOf(input),
    };
  }, []);

  /**
   * SCRUM-779 — the cart as it was rung up, when the only difference is the
   * member who joined that sale since. Anything else comes back unchanged.
   */
  const asRungUp = useCallback((input: SaleWriteInput): SaleWriteInput => {
    const join = joinRef.current;
    const attempt = saleRef.current;
    if (!join || !attempt || join.attemptKey !== attempt.actionId) return input;
    if ((input.cart.memberId ?? null) !== join.memberId || bodySignatureOf(input) !== attempt.body) return input;
    return {
      ...input,
      cart: {
        ...input.cart,
        memberId: attempt.who.memberId,
        customerPhone: attempt.who.customerPhone,
        customerNickname: attempt.who.customerNickname,
      },
    };
  }, []);

  const reset = useCallback(() => {
    epochRef.current += 1;
    joinRef.current = null;
    saleRef.current = null;
    committedRef.current = null;
    attemptsRef.current = 0;
    renewKeyRef.current = false;
    inFlightRef.current = null;
    sentRef.current = new Set();
    supersededRef.current = new Map();
    moneyTakenRef.current = new Set();
    setState({ kind: 'idle' });
  }, []);

  /**
   * SCRUM-865 — THE SALES A CORRECTED ORDER LEFT BEHIND that the next commit
   * voids: rung up on the platform, still `tendering`, no money taken by a
   * tender of this screen. The platform is the last word on the money — a
   * void of a sale that took some is refused (`SALE_HAS_PAYMENT`) and the
   * sale stays here for Cancel, as every refused void does.
   *
   * One rung up on the box lane is priced on the box and recorded nowhere
   * until it is paid, so there is nothing to void, only an order to let go —
   * exactly as the till's Cancel lets it go. One the box is still taking a
   * terminal payment for, or has closed, is left for Cancel to say so.
   */
  const supersededToVoid = useCallback((): ApiSale[] => {
    const onPlatform: ApiSale[] = [];
    for (const left of supersededRef.current.values()) {
      if (left.status !== 'tendering' || moneyTakenRef.current.has(left.id)) continue;
      const boxHeld = laneSale(left.id);
      if (boxHeld?.lane === 'box') {
        const waiting = boxHeld.answer?.attempt;
        const busy =
          boxHeld.answer?.finalised ||
          (waiting && ['sent_to_terminal', 'unknown', 'inquiring', 'awaiting_staff_confirmation'].includes(waiting.status));
        if (!busy) {
          forgetLaneSale(left.id);
          supersededRef.current.delete(left.id);
        }
        continue;
      }
      onPlatform.push(left);
    }
    return onPlatform;
  }, []);

  /**
   * Void them, reason "Order changed at the till after Pay", and forget each
   * one the platform voided. A refusal or a dropped link leaves the sale where
   * it was — in the list Cancel voids — and never fails the corrected sale.
   */
  const voidSuperseded = useCallback(async (left: readonly ApiSale[]): Promise<void> => {
    const map = supersededRef.current;
    await Promise.all(
      left.map(async (s) => {
        try {
          await salesApi.voidSale(s.id, ORDER_CHANGED_AFTER_PAY);
          map.delete(s.id);
        } catch {
          // Kept for Cancel, which voids it with the sale on screen.
        }
      }),
    );
  }, []);

  const commit = useCallback(async (offered: SaleWriteInput): Promise<SaleWriteOutcome> => {
    // SCRUM-779 — a member who joined the rung-up sale does not make it another sale.
    const input = asRungUp(offered);
    const rejoined = input !== offered;
    const signature = signatureOf(input);

    // This exact cart is already on the platform. Pressing Confirm after Pay
    // does not ask a second time — the answer is the one in hand, and a round
    // trip at the moment money changes hands is a round trip that can fail.
    const held = committedRef.current;
    if (held && saleRef.current?.signature === signature) {
      if (rejoined) await joinSettled();
      const current = committedRef.current ?? held;
      return { ok: true, written: true, sale: current, replay: true, saleId: current.id };
    }
    // The same cart is already going out. Join that attempt rather than opening
    // a second one — a double press, or a screen that mounts twice.
    const inFlight = inFlightRef.current;
    if (inFlight && inFlight.signature === signature && saleRef.current?.signature === signature) {
      if (!rejoined) return inFlight.promise;
      const outcome = await inFlight.promise;
      await joinSettled();
      return outcome.ok && outcome.written && committedRef.current?.id === outcome.saleId
        ? { ...outcome, sale: committedRef.current }
        : outcome;
    }

    // The same cart keeps its number — a retry has to be the same sale, and a
    // burnt key takes a new number while keeping the press, so
    // `sale_action_unique` still refuses a second sale if the first landed. A
    // different cart is a different sale (`decideIds`).
    const ids = decideIds(input, input.preferSaleId);
    renewKeyRef.current = false;
    saleRef.current = ids;
    sentRef.current.add(ids.saleId);
    /**
     * SCRUM-865 — what the corrected order left behind goes before it. The
     * void has to LAND first when the cart names a document check or hand
     * approval (the platform gives the claim back only as it voids, and the
     * corrected sale is refused `TIER_CLAIM_SPENT` without it) or a voucher is
     * held for the cart (the voucher cannot follow until the abandoned sale
     * lets it go). Otherwise it runs beside the commit, so Pay is not slowed
     * by a round trip the sale does not depend on.
     */
    const superseded = supersededToVoid();
    const voidFirst = Boolean(input.cart.tierClaimActionId) || Boolean(input.preferSaleId);

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
        // On the box lane the platform is out of reach: a sale left behind
        // there stays for Cancel, or for the left-unpaid list when it is back.
        if (station && currentLane() === 'box') return await onBox(station);
        if (superseded.length > 0) {
          const letGo = voidSuperseded(superseded);
          if (voidFirst) await letGo;
        }
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
            ...(answeredByBox(err) ? { answeredBy: 'box' as const } : {}),
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
    if (!rejoined) {
      // The walk-in's sale going out for the attempt a member already joined
      // (the member arrived between the payment screen deciding the sale's ids
      // and sending it): once it lands, the member goes onto it.
      const join = joinRef.current;
      if (join && join.attemptKey === ids.actionId) {
        void promise.then((outcome) => {
          if (outcome.ok && outcome.written && joinRef.current === join && join.waiting && !join.running) {
            void attachRef.current?.(join);
          }
        });
      }
      return promise;
    }
    // A retry of the walk-in's sale after the member joined: once it lands, the
    // member goes onto it too.
    const outcome = await promise;
    if (outcome.ok && outcome.written) {
      const join = joinRef.current;
      if (join && join.attachedSaleId !== outcome.saleId) await attachRef.current?.(join);
      if (committedRef.current?.id === outcome.saleId) return { ...outcome, sale: committedRef.current };
    }
    return outcome;
  }, [asRungUp, decideIds, isCurrent, supersededToVoid, voidSuperseded]);

  const prepare = useCallback(
    (offered: SaleWriteInput): string => {
      const input = asRungUp(offered);
      const signature = signatureOf(input);
      // Already on the platform, or already going out: that sale's id.
      const held = committedRef.current;
      if (held && saleRef.current?.signature === signature) return held.id;
      const inFlight = inFlightRef.current;
      if (inFlight && inFlight.signature === signature && saleRef.current?.signature === signature) {
        return saleRef.current.saleId;
      }
      // Decided now and kept: `commit` finds this cart's ids and uses them.
      const ids = decideIds(input, input.preferSaleId);
      renewKeyRef.current = false;
      saleRef.current = ids;
      return ids.saleId;
    },
    [asRungUp, decideIds],
  );

  /**
   * SCRUM-779 — add the joined member to the sale rung up for this order, once
   * any commit of it still on the wire has landed. Kept in a ref so `commit`
   * can run it again for a retry that lands after the member joined.
   */
  const attachRef = useRef<((join: MemberJoin) => Promise<MemberJoinOutcome>) | null>(null);
  attachRef.current = (join: MemberJoin): Promise<MemberJoinOutcome> => {
    if (join.running) return join.settled;
    join.running = true;
    const epoch = epochRef.current;
    const live = () => epochRef.current === epoch && joinRef.current === join;
    const settled = (async (): Promise<MemberJoinOutcome> => {
      const inFlight = inFlightRef.current;
      if (inFlight) await inFlight.promise.catch(() => undefined);
      const held = committedRef.current;
      const attempt = saleRef.current;
      // Only the sale rung up for the attempt the member joined is theirs: a
      // sale from an order since changed is not, and ids decided but not yet
      // sent have no sale behind them until the commit lands.
      if (!live() || !held || attempt?.actionId !== join.attemptKey || held.id !== attempt.saleId) {
        join.waiting = true;
        return { attached: false, reason: 'nothing-rung-up' };
      }
      join.waiting = false;
      if (held.memberId === join.memberId) {
        join.attachedSaleId = held.id;
        return { attached: true, saleId: held.id };
      }
      if (held.status === 'finalised' || held.status === 'voided' || held.status === 'refunded') {
        return { attached: false, reason: 'closed' };
      }
      // Rung up on the counter box while the link was down: the platform holds
      // no row of it until it is paid, so it stays a walk-in's sale.
      if (laneSale(held.id)?.lane === 'box') return { attached: false, reason: 'box' };
      try {
        await salesApi.attachMember(held.id, join.memberId);
        join.attachedSaleId = held.id;
        if (live() && committedRef.current?.id === held.id) {
          const sale = { ...committedRef.current, memberId: join.memberId };
          committedRef.current = sale;
          setState((state) => (state.kind === 'committed' && state.saleId === held.id ? { ...state, sale } : state));
        }
        return { attached: true, saleId: held.id };
      } catch (err) {
        return { attached: false, reason: 'refused', message: messageOf(err) };
      }
    })().finally(() => {
      join.running = false;
    });
    join.settled = settled;
    return settled;
  };

  /**
   * The joined member's outcome for the Confirm press: run now when a sale has
   * landed for the attempt since the join last looked, else the one in hand.
   */
  const joinSettled = (): Promise<MemberJoinOutcome> | undefined => {
    const join = joinRef.current;
    if (!join) return undefined;
    return join.waiting && !join.running ? attachRef.current!(join) : join.settled;
  };

  const attachMember = useCallback((memberId: string): Promise<MemberJoinOutcome> => {
    const attempt = saleRef.current;
    // Nothing decided for this order yet: the member rides with the cart. Ids
    // decided and not yet sent (the payment screen's `prepare`, a voucher
    // still moving to the sale) are joined all the same, so the walk-in's
    // commit that follows takes the member instead of Confirm ringing a second.
    if (!attempt) {
      return Promise.resolve({ attached: false, reason: 'nothing-rung-up' });
    }
    // The sale already belongs to somebody: a member is not swapped here.
    if (attempt.who.memberId && attempt.who.memberId !== memberId) {
      return Promise.resolve({ attached: false, reason: 'refused', message: 'This sale already belongs to another member.' });
    }
    const known = joinRef.current;
    if (known && known.attemptKey === attempt.actionId && known.memberId === memberId) return known.settled;
    const join: MemberJoin = {
      memberId,
      attemptKey: attempt.actionId,
      attachedSaleId: null,
      settled: Promise.resolve({ attached: false, reason: 'nothing-rung-up' }),
      running: false,
      waiting: true,
    };
    joinRef.current = join;
    return attachRef.current!(join);
  }, []);

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
      if (!answer.finalised && answer.outstandingSatang < sale.totals.grossSatang) moneyTakenRef.current.add(held.id);
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
      // A part accepted: money is on this sale now (SCRUM-865 never voids it unasked).
      if (!finalised && result.outstandingSatang !== undefined && result.outstandingSatang < result.sale.totals.grossSatang) {
        moneyTakenRef.current.add(held.id);
      }
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
          // SCRUM-502: who said no, and where the order is now. A sale rung up
          // on the box lane exists on this till alone until it is paid; one
          // rung up on the platform whose cash press fell to the box is still
          // the platform's unpaid row.
          ...(answeredByBox(err) ? { answeredBy: 'box' as const } : {}),
          ...(onTheBox?.lane === 'box' ? { heldOn: 'till' as const } : {}),
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

  const adopt = useCallback((sale: ApiSale): boolean => {
    if (sale.status !== 'tendering' && sale.status !== 'paid') return false;
    // A new sale on screen: whatever was in flight for the last one is dropped.
    epochRef.current += 1;
    joinRef.current = null;
    attemptsRef.current = 0;
    renewKeyRef.current = false;
    inFlightRef.current = null;
    supersededRef.current = new Map();
    // A sale the platform holds as `paid` has taken its money (SCRUM-865).
    moneyTakenRef.current = new Set(sale.status === 'paid' ? [sale.id] : []);
    // The ids a retry of this sale's close goes under. The action id is this
    // screen's own — the press that rang the sale up is not replayed — and the
    // signature is one no cart on this screen can produce, so `commit` is never
    // answered with this sale for a different order.
    saleRef.current = {
      saleId: sale.id,
      actionId: newId(),
      occurredAt: sale.occurredAt,
      signature: `resumed:${sale.id}`,
      body: `resumed:${sale.id}`,
      who: { memberId: sale.memberId ?? null, customerPhone: null, customerNickname: null },
    };
    sentRef.current = new Set([sale.id]);
    committedRef.current = sale;
    setState({ kind: 'committed', saleId: sale.id, sale });
    return true;
  }, []);

  const declareUnwritten = useCallback((reason: string): string => {
    const ids =
      saleRef.current ??
      ({
        saleId: newId(),
        actionId: newId(),
        occurredAt: new Date().toISOString(),
        signature: '',
        body: '',
        who: { memberId: null, customerPhone: null, customerNickname: null },
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
    adopt,
    attachMember,
    saleId: saleRef.current?.saleId ?? null,
    committed: committedRef.current,
    ownsSale,
  };
}
