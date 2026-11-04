import { useCallback, useEffect, useRef, useState } from 'react';
import type { HeldSale } from '@oto/shared';
import { heldSalesApi } from '@/api/heldSales';

/**
 * SCRUM-774 — THE BRANCH'S HELD SALES, as every till at the branch shows them.
 *
 * Read from the platform when the till opens, again every `POLL_MS` while it is
 * unlocked and online, and at once after anything this screen did to the list
 * (a hold, a resume, a void, a refund). Another till's hold therefore shows
 * here within the poll, without anybody pressing anything. A read that fails
 * keeps the last list and says why (`error`), rather than quietly emptying it:
 * an empty Held sales list is an answer reception acts on.
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

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || !branchId) return;
    const mine = ++seq.current;
    heldSalesApi
      .list(branchId)
      .then((answer) => {
        if (mine !== seq.current) return;
        setSales(answer.sales);
        setCounts(answer.counts);
        setError(null);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (mine !== seq.current) return;
        setError(err instanceof Error ? err.message : 'The Held sales list could not be read');
        setLoaded(true);
      });
  }, [enabled, branchId, tick]);

  useEffect(() => {
    if (!enabled || !branchId) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, branchId]);

  return { sales, counts, error, loaded, refresh };
}

/** "฿1,234" or "฿1,234.50", from satang — the till's own money face. */
export const bahtLabel = (satang: number): string =>
  `฿${(satang / 100).toLocaleString('en-US', { minimumFractionDigits: satang % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

/**
 * WHY EACH PAYMENT-SCREEN BUTTON IS SHUT, in the words the till shows under it
 * (the owner's rule: no disabled button without its reason). Null when the
 * button can be pressed. The platform checks the same again on the press.
 */
export function holdButtonReasons(input: {
  saleId: string | null;
  online: boolean;
  /** A tender is being taken or waiting for an answer. */
  paymentInProgress: boolean;
  paidSatang: number;
  outstandingSatang: number;
  canHold: boolean;
}): { hold: string | null; partPaid: string | null } {
  const common = !input.canHold
    ? 'Your role cannot hold sales — ask a manager.'
    : !input.online
      ? 'Holding a sale needs the connection — reconnect, or take the payment now.'
      : !input.saleId
        ? 'The sale is still being saved — wait a moment.'
        : input.paymentInProgress
          ? 'A payment is in progress — finish or cancel it first.'
          : input.outstandingSatang <= 0
            ? 'Nothing is owed on this sale — complete it instead.'
            : null;
  if (common) return { hold: common, partPaid: common };
  return {
    hold:
      input.paidSatang > 0
        ? `${bahtLabel(input.paidSatang)} has been paid on this sale — use Save as partly paid.`
        : null,
    partPaid:
      input.paidSatang > 0 ? null : 'Take a part payment first — nothing has been paid on this sale yet.',
  };
}
