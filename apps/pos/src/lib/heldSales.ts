import { useCallback, useEffect, useRef, useState } from 'react';
import { formatTHB, type HeldSale, type HeldSaleKind, type Permission } from '@oto/shared';
import { heldSalesApi } from '@/api/heldSales';
import { NetworkError, idemKey } from '@/api/client';
import { newActionId, refundSale } from '@/api/history';
import { salesApi } from '@/api/sales';
import { toast } from '@/hooks/use-toast';
import { isBoxLaneTrigger, onPlatformAnswered } from './lane';

/**
 * SCRUM-774 — THE BRANCH'S HELD SALES, as every till at the branch shows them.
 *
 * Read from the platform when the till opens, again every `POLL_MS` while it is
 * unlocked and online, and at once after anything this screen did to the list
 * (a hold, a resume, a void, a refund). Another till's hold therefore shows
 * here within the poll, without anybody pressing anything. A read that fails
 * keeps the last list and says why (`error`), rather than quietly emptying it:
 * an empty Held sales list is an answer reception acts on.
 *
 * SCRUM-897 — a read that met no connection is read again the moment the
 * platform answers this till (`onPlatformAnswered` in lib/lane.ts), not at the
 * next poll: after a long outage the till can finish a family online while
 * its lane still says box, and the list said it could not be read throughout.
 */
const POLL_MS = 20_000;

export interface HeldSalesState {
  sales: HeldSale[];
  counts: { held: number; partPaid: number };
  /** Why the list could not be read just now, in words; null when it was. */
  error: string | null;
  loaded: boolean;
  refresh: () => void;
}

export function useHeldSales(opts: { branchId: string | null; enabled: boolean }): HeldSalesState {
  const { branchId, enabled } = opts;
  const [sales, setSales] = useState<HeldSale[]>([]);
  const [counts, setCounts] = useState({ held: 0, partPaid: 0 });
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  /** SCRUM-897 — the last read met no connection: the platform's next answer reads again. */
  const unreached = useRef(false);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || !branchId) return;
    const mine = ++seq.current;
    heldSalesApi
      .list(branchId)
      .then((answer) => {
        if (mine !== seq.current) return;
        unreached.current = false;
        setSales(answer.sales);
        setCounts(answer.counts);
        setError(null);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (mine !== seq.current) return;
        unreached.current = isBoxLaneTrigger(err);
        setError(err instanceof Error ? err.message : 'The Held sales list could not be read');
        setLoaded(true);
      });
  }, [enabled, branchId, tick]);

  useEffect(() => {
    if (!enabled || !branchId) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, branchId]);

  // SCRUM-897 — the platform answered the till: a list it could not reach is read again now.
  useEffect(() => {
    if (!enabled || !branchId) return;
    return onPlatformAnswered(() => {
      if (!unreached.current) return;
      unreached.current = false;
      setTick((n) => n + 1);
    });
  }, [enabled, branchId]);

  return { sales, counts, error, loaded, refresh };
}

/** "฿1,234" or "฿1,234.50", from satang — the till's own money face (`formatTHB`, SCRUM-933). */
export const bahtLabel = (satang: number): string => formatTHB(satang);

/**
 * WHY EACH PAYMENT-SCREEN BUTTON IS SHUT, in the words the till shows under it
 * (the owner's rule: no disabled button without its reason). Null when the
 * button can be pressed. The platform checks the same again on the press.
 *
 * The connection is the lane arbiter's (`lib/lane.ts`), not the browser's: on
 * the box lane the counter's network is up while the platform cannot be
 * reached, and a sale rung up on the box is not on the platform at all until
 * the box hands it over — neither can be held, and the button says so.
 *
 * SCRUM-853 — while the payment step waits for a voucher price, or has said it
 * is not coming (`awaitingPrice`), no sale is written and none is on its way,
 * so "The sale is still being saved" would be untrue. The buttons stay shut
 * and that one line is left out (`HOLD_SHUT_UNSAID`): the step's own line
 * above them is the reason. Every other reason is given as before.
 */
export function holdButtonReasons(input: {
  saleId: string | null;
  online: boolean;
  /** The till is working through its counter box (`useLane() === 'box'`). */
  boxLane?: boolean;
  /** This sale was rung up on the counter box (`laneSale(id)?.lane === 'box'`). */
  boxSale?: boolean;
  /** A tender is being taken or waiting for an answer. */
  paymentInProgress: boolean;
  paidSatang: number;
  outstandingSatang: number;
  canHold: boolean;
  /** The voucher price is pending or unavailable (`voucherPricePending` in pages/Till.tsx). */
  awaitingPrice?: boolean;
}): { hold: string | null; partPaid: string | null } {
  const common = !input.canHold
    ? 'Your role cannot hold sales — ask a manager.'
    : input.boxSale
      ? BOX_SALE_NOT_HELD
      : input.boxLane
        ? BOX_LANE_NO_HOLD
        : !input.online
          ? 'Holding a sale needs the connection — reconnect, or take the payment now.'
          : !input.saleId
            ? input.awaitingPrice ? HOLD_SHUT_UNSAID : 'The sale is still being saved — wait a moment.'
            : input.paymentInProgress
              ? 'A payment is in progress — finish or cancel it first.'
              : input.outstandingSatang <= 0
                ? 'Nothing is owed on this sale — complete it instead.'
                : null;
  if (common !== null) return { hold: common, partPaid: common };
  return {
    hold:
      input.paidSatang > 0
        ? `${bahtLabel(input.paidSatang)} has been paid on this sale — use Save as partly paid.`
        : null,
    partPaid:
      input.paidSatang > 0 ? null : 'Take a part payment first — nothing has been paid on this sale yet.',
  };
}

/**
 * SCRUM-796 — Save as partly paid is offered only when it can mean something:
 * staff chose Partial payment on this tender, or part of the sale is already
 * paid (a part taken here, or a part-paid sale resumed). A whole-amount
 * payment never shows it.
 */
export const partPaidShown = (partial: boolean | undefined, paidSatang: number): boolean =>
  Boolean(partial) || paidSatang > 0;

/**
 * SCRUM-853 — shut, with nothing written under the button: a reason that is
 * not null shuts it, and an empty one draws no line (`HoldSaleButtons`).
 */
export const HOLD_SHUT_UNSAID = '';
export const BOX_SALE_NOT_HELD =
  'This sale was rung up on the counter box while the platform could not be reached — it cannot be held. Take the payment now.';
export const BOX_LANE_NO_HOLD =
  'This till is working through its counter box while the platform cannot be reached — holding a sale needs the platform. Take the payment now, or wait for the connection.';
export const BOX_LANE_NO_RESUME =
  'This till is working through its counter box while the platform cannot be reached — resuming a held sale needs the platform. Try again when the connection is back.';

/** What a till shows above the payment step once a held sale is open on it. */
export interface ResumedHold {
  label: string;
  note: string | null;
  paidSatang: number;
}

/** One held sale's choices, each shut with its reason when this screen cannot make it. */
export interface HeldSaleActions {
  /** Null when Resume can be pressed here; otherwise why not. */
  resumeReason: string | null;
  /** Null when Void can be pressed (a held sale); otherwise why not. */
  voidReason: string | null;
  /** Null when Cancel and refund can be pressed (a part-paid sale); otherwise why not. */
  refundReason: string | null;
}

export interface HeldSaleDesk {
  held: HeldSalesState;
  /** Which button opened the hold dialog; null while it is shut. */
  holdKind: HeldSaleKind | null;
  openHoldDialog: (kind: HeldSaleKind) => void;
  closeHoldDialog: () => void;
  holdBusy: boolean;
  /** The platform's refusal of the last hold press, in its words. */
  holdError: string | null;
  confirmHold: (label: string, note: string) => Promise<void>;
  /** The list press in progress, by sale. */
  busyId: string | null;
  /** The platform's refusal of the last list press, in its words. */
  refusal: string | null;
  dismissRefusal: () => void;
  actionsFor: (sale: HeldSale) => HeldSaleActions;
  resume: (sale: HeldSale) => Promise<void>;
  voidHeld: (sale: HeldSale, reason: string) => Promise<void>;
  refundHeld: (sale: HeldSale, reason: string) => Promise<void>;
}

type PressRef = { current: { saleId: string; actionId: string } | null };

/** The press's id: the one kept for this sale, or a new one. */
function pressFor(ref: PressRef, saleId: string, mint: () => string): string {
  if (ref.current?.saleId !== saleId) ref.current = { saleId, actionId: mint() };
  return ref.current.actionId;
}

/** The sentence a Resume press shows when it has no answer to act on yet. */
export function resumeRefusalOf(err: unknown): string {
  if (err instanceof NetworkError) {
    return 'No answer from the platform — press Resume again when the connection is back: it picks up the same sale.';
  }
  return err instanceof Error ? err.message : 'The held sale could not be resumed';
}

/**
 * SCRUM-774 — HELD SALES ON A TILL, the same on the counter's ticket till
 * (`pages/Till.tsx`) and the phone's (`components/mobile/MobileTill.tsx`):
 * the payment step's Hold sale and Save as partly paid, and the branch's list
 * with Resume, Void (a held sale) and Cancel and refund (a part-paid one).
 *
 * EACH PRESS KEEPS ITS ACTION ID UNTIL IT HAS AN ANSWER IT CAN ACT ON. A hold,
 * a resume or a refund whose answer was lost is pressed again under the same
 * id, and the platform answers what it already did. A resume in particular
 * keeps its id until the sale is open on this screen: the platform ends the
 * hold and moves the sale here before the screen has read it, so a read that
 * fails afterwards is retried as the same press rather than refused as
 * "already taken back" by the very till that took it.
 */
export function useHeldSaleDesk(opts: {
  branchId: string | null;
  /** Read the list: unlocked, and allowed to read sales. */
  enabled: boolean;
  can: (permission: Permission) => boolean;
  stationId: string | null;
  /** The till is working through its counter box (`useLane()`). */
  boxLane: boolean;
  /** Something is on this screen's sale: Resume waits until it is finished or cancelled. */
  saleOnScreen: boolean;
  /** The sale on the payment step, for Hold sale and Save as partly paid. */
  holdSaleId: string | null;
  /** The hold was made: clear the screen for the next visitor. */
  onHeld: () => void;
  /** Open a resumed sale on this screen; true once it is there. */
  openResumed: (saleId: string, fromHold: ResumedHold) => Promise<boolean>;
}): HeldSaleDesk {
  const held = useHeldSales({ branchId: opts.branchId, enabled: opts.enabled });
  const [holdKind, setHoldKind] = useState<HeldSaleKind | null>(null);
  const [holdBusy, setHoldBusy] = useState(false);
  const [holdError, setHoldError] = useState<string | null>(null);
  const holdActionRef = useRef<{ saleId: string; actionId: string } | null>(null);
  const resumeActionRef = useRef<{ saleId: string; actionId: string } | null>(null);
  const refundActionRef = useRef<{ saleId: string; actionId: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const confirmHold = async (label: string, note: string): Promise<void> => {
    const kind = holdKind;
    const saleId = opts.holdSaleId;
    if (!kind || !saleId || holdBusy) return;
    setHoldBusy(true);
    setHoldError(null);
    const actionId = pressFor(holdActionRef, saleId, idemKey);
    try {
      const answer = await heldSalesApi.hold(saleId, { kind, label, note: note || null, actionId });
      holdActionRef.current = null;
      setHoldKind(null);
      toast({
        title: kind === 'held' ? 'Sale held' : 'Saved as partly paid',
        description:
          kind === 'held'
            ? `${answer.hold.label} — in Held sales on every till at this branch. Nothing was issued.`
            : `${answer.hold.label} — ${bahtLabel(answer.hold.paidSatang)} paid, balance ${bahtLabel(answer.hold.balanceSatang)}. In Held sales on every till at this branch.`,
      });
      opts.onHeld();
      held.refresh();
    } catch (err) {
      // A lost answer keeps its press, so the retry finds the hold it made;
      // a refusal is final for that press, and the next one is a new press.
      if (!(err instanceof NetworkError)) holdActionRef.current = null;
      setHoldError(err instanceof Error ? err.message : 'The sale could not be held');
    } finally {
      setHoldBusy(false);
    }
  };

  const actionsFor = (sale: HeldSale): HeldSaleActions => ({
    resumeReason: !opts.can('pos:sale:update')
      ? 'Your role cannot take payment — ask a manager.'
      : opts.boxLane
        ? BOX_LANE_NO_RESUME
        : !opts.stationId
          ? 'Pick this till’s station first — the receipt and bands print here.'
          : opts.saleOnScreen
            ? 'Finish or cancel the sale on screen first.'
            : null,
    voidReason:
      sale.kind === 'held' && !opts.can('pos:sale:void') ? 'Voiding needs the void permission — ask a manager.' : null,
    refundReason:
      sale.kind === 'part_paid' && !(opts.can('pos:refund:create') && opts.can('pos:refund:approve'))
        ? 'A refund needs a manager’s approval — ask a manager to make it.'
        : null,
  });

  const resume = async (sale: HeldSale): Promise<void> => {
    const reason = actionsFor(sale).resumeReason;
    if (reason) {
      setRefusal(reason);
      return;
    }
    setRefusal(null);
    setBusyId(sale.saleId);
    const actionId = pressFor(resumeActionRef, sale.saleId, idemKey);
    try {
      const answer = await heldSalesApi.resume(sale.saleId, actionId);
      const opened = await opts.openResumed(sale.saleId, {
        label: answer.label,
        note: answer.note,
        paidSatang: answer.paidSatang,
      });
      if (opened) {
        resumeActionRef.current = null;
      } else {
        // The platform has it at this till; the screen could not open it.
        // The kept id makes the next press the same one, which opens it.
        setRefusal(
          `${answer.label} was taken back to this till but could not be opened on the screen — press Resume again to open it.`,
        );
      }
    } catch (err) {
      if (!(err instanceof NetworkError)) resumeActionRef.current = null;
      setRefusal(resumeRefusalOf(err));
    } finally {
      setBusyId(null);
      held.refresh();
    }
  };

  const voidHeld = async (sale: HeldSale, reason: string): Promise<void> => {
    setRefusal(null);
    setBusyId(sale.saleId);
    try {
      await salesApi.voidSale(sale.saleId, reason);
      toast({ title: 'Held sale voided', description: `${sale.label} — ${reason}. It can never be paid.` });
    } catch (err) {
      setRefusal(err instanceof Error ? err.message : 'The held sale could not be voided');
    } finally {
      setBusyId(null);
      held.refresh();
    }
  };

  const refundHeld = async (sale: HeldSale, reason: string): Promise<void> => {
    setRefusal(null);
    setBusyId(sale.saleId);
    const actionId = pressFor(refundActionRef, sale.saleId, newActionId);
    try {
      const answer = await refundSale(sale.saleId, { mode: 'whole', reason, actionId });
      refundActionRef.current = null;
      toast({
        title: 'Refunded and cancelled',
        description: `${sale.label} — ${bahtLabel(answer.refund.amountSatang)} refunded (${answer.refund.number}). The sale is closed.`,
      });
    } catch (err) {
      if (!(err instanceof NetworkError)) refundActionRef.current = null;
      setRefusal(err instanceof Error ? err.message : 'The refund could not be made');
    } finally {
      setBusyId(null);
      held.refresh();
    }
  };

  return {
    held,
    holdKind,
    openHoldDialog: (kind) => {
      setHoldError(null);
      setHoldKind(kind);
    },
    closeHoldDialog: () => {
      setHoldKind(null);
      setHoldError(null);
    },
    holdBusy,
    holdError,
    confirmHold,
    busyId,
    refusal,
    dismissRefusal: () => setRefusal(null),
    actionsFor,
    resume,
    voidHeld,
    refundHeld,
  };
}
