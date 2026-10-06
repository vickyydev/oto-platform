import { useEffect, useMemo, useState } from 'react';
import { ApiError, NetworkError, isMissingRoute } from '@/api/client';
import { lookupSales, parseHistorySearch, type HistorySearch, type HistoryTxn } from '@/api/history';

/**
 * HISTORY'S SEARCH BOX, ASKING THE PLATFORM — S2-11 (SCRUM-208).
 *
 * The box filters the day's rows as it always did. When what was typed (or
 * scanned — a scanner that types into the box reads the band's QR) is a band
 * code or a phone number (`parseHistorySearch`), the platform is asked too,
 * through `GET /sales/lookup`, and its finds join the rows on screen: a band
 * sold yesterday, a member's sales on any day. Asked once the typing pauses,
 * so a phone number is not looked up digit by digit.
 */

/** Why the lookup could not answer, in the words the rest of History uses. */
export function explainLookup(err: unknown, by: 'band' | 'phone'): string {
  const subject = by === 'band' ? 'a bracelet' : 'a phone number';
  if (err instanceof NetworkError) {
    return `No connection to the platform, so ${subject} cannot be looked up here.`;
  }
  if (isMissingRoute(err)) {
    return `This deployment cannot look a sale up by ${subject} yet (S2-11).`;
  }
  return err instanceof ApiError ? err.message : `${subject[0]!.toUpperCase()}${subject.slice(1)} could not be looked up.`;
}

export interface SearchLookup {
  search: HistorySearch;
  /** True while a band or phone is being asked about. */
  pending: boolean;
  /** The sales found; null when nothing was asked or the ask failed. */
  sales: HistoryTxn[] | null;
  error: string | null;
}

/** How long the typing has to pause before the platform is asked. */
export const LOOKUP_PAUSE_MS = 350;

/**
 * The lookup for what is in the search box. `version` asks again without the
 * box changing — after a refund here, say, when the rows found are stale.
 */
export function useSearchLookup(query: string, branchId: string | null, version = 0): SearchLookup {
  const search = useMemo(() => parseHistorySearch(query), [query]);
  const key =
    search.kind === 'band' ? `band:${search.code}` : search.kind === 'phone' ? `phone:${search.phone}` : '';
  const [answer, setAnswer] = useState<{ key: string; sales: HistoryTxn[] | null; error: string | null }>({
    key: '',
    sales: null,
    error: null,
  });

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const cut = key.indexOf(':');
    const by = key.slice(0, cut) as 'band' | 'phone';
    const value = key.slice(cut + 1);
    const tag = `${key}#${version}`;
    const timer = setTimeout(() => {
      lookupSales(branchId, by === 'band' ? { band: value } : { phone: value })
        .then((found) => {
          if (!cancelled) setAnswer({ key: tag, sales: found.sales, error: null });
        })
        .catch((err: unknown) => {
          if (!cancelled) setAnswer({ key: tag, sales: null, error: explainLookup(err, by) });
        });
    }, LOOKUP_PAUSE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, branchId, version]);

  const current = key !== '' && answer.key === `${key}#${version}`;
  return {
    search,
    pending: key !== '' && !current,
    sales: current ? answer.sales : null,
    error: current ? answer.error : null,
  };
}
