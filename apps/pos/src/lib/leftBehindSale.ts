import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { salesApi } from '@/api/sales';
import type { RungUpSale } from '@/lib/tillVoucher';

/**
 * SCRUM-407 (audit C1 remainder, T7) — AN UNPAID SALE LEFT AT THIS TILL.
 *
 * The counter till keeps its sale through a staff lock: the till stays mounted
 * under the lock screen (`App.tsx`, `retainedStation`). A reload, a closed tab
 * or a header tab pressed mid-payment do unmount it, and a sale rung up at Pay
 * lives only in that screen's memory — while the platform keeps it, and any
 * voucher on it, until it is paid or voided. So when the till opens it asks the
 * platform for this station's sales still `tendering`, and offers each one: its
 * till, time and amount, and a Void for an account the platform lets void. The
 * platform refuses the void of a sale that has taken money, in its own words.
 *
 * Asked once per till and station. A sale this screen rings up afterwards is
 * its own and never listed; a sale another screen at the same station is
 * paying for right now is, and the card says how recently it was rung up.
 */

/** The void's reason, as the voids report reads it. */
export const VOIDED_LEFT_BEHIND = 'Left unpaid at the till (page reloaded or left mid-payment)';

export interface LeftBehindSales {
  sales: RungUpSale[];
  /** The sale being voided, while the platform answers. */
  busyId: string | null;
  /** The platform's refusal of the last void, in its words. */
  refusal: string | null;
  voidSale: (saleId: string) => Promise<void>;
  dismiss: (saleId: string) => void;
  dismissRefusal: () => void;
}

export function useLeftBehindSales(opts: {
  branchId: string | null;
  stationId: string | null;
  stationName: string | null;
  /** False while locked, offline or without the read permission. */
  enabled: boolean;
  /** A sale this screen rang up is its own business, never "left behind". */
  ownsSale: (saleId: string) => boolean;
}): LeftBehindSales {
  const { branchId, stationId, stationName, enabled, ownsSale } = opts;
  const [sales, setSales] = useState<RungUpSale[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const asked = useRef<string | null>(null);
  const ownsRef = useRef(ownsSale);
  ownsRef.current = ownsSale;

  useEffect(() => {
    if (!enabled || !branchId || !stationId) return;
    const key = `${branchId}:${stationId}`;
    if (asked.current === key) return;
    asked.current = key;
    let cancelled = false;
    salesApi
      .list({ branchId, stationId, status: 'tendering', limit: 10 })
      .then(({ sales: found }) => {
        if (cancelled) return;
        setSales(
          found
            .filter((s) => s.status === 'tendering' && s.stationId === stationId && !ownsRef.current(s.id))
            .map((s) => ({
              saleId: s.id,
              stationName,
              occurredAt: s.occurredAt,
              grossSatang: s.totals.grossSatang,
            })),
        );
      })
      // Nothing to offer is the quiet answer: an older platform, a dropped
      // link or a refused read leaves the till exactly as it was.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, branchId, stationId, stationName]);

  const dismiss = useCallback((saleId: string) => {
    setSales((prev) => prev.filter((s) => s.saleId !== saleId));
  }, []);

  const voidSale = useCallback(async (saleId: string) => {
    setBusyId(saleId);
    setRefusal(null);
    try {
      await salesApi.voidSale(saleId, VOIDED_LEFT_BEHIND);
      setSales((prev) => prev.filter((s) => s.saleId !== saleId));
    } catch (err) {
      setRefusal(err instanceof ApiError || err instanceof Error ? err.message : 'The sale could not be voided');
    } finally {
      setBusyId(null);
    }
  }, []);

  const dismissRefusal = useCallback(() => setRefusal(null), []);

  return { sales, busyId, refusal, voidSale, dismiss, dismissRefusal };
}
