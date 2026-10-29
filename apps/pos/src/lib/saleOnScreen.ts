/**
 * WHICH SALE THIS TILL HAD ON ITS PAYMENT SCREEN, by station — the one thing
 * about a rung-up sale the browser is allowed to remember.
 *
 * The platform is the source of truth for the sale itself: its lines, its
 * totals, the money already taken on it. After a reload the till asks the
 * platform for this station's unpaid sales (`lib/leftBehindSale.ts`) and goes
 * back to the one it was on. When several are open at once, this is what says
 * which one that was; it decides nothing else, and a sale the platform no
 * longer holds as unpaid is never resumed from it.
 *
 * Kept in `sessionStorage` (this tab, through a reload) with a `localStorage`
 * copy keyed by station, so a closed and reopened tab on the same counter
 * finds it too. Forgotten when the sale is paid, voided or thrown away.
 */

const KEY_PREFIX = 'oto.till.saleOnScreen.';

const keyFor = (stationId: string): string => `${KEY_PREFIX}${stationId}`;

type WebStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The two stores, where this runtime has them; each read and write is best effort. */
function stores(): WebStorage[] {
  const found: WebStorage[] = [];
  for (const name of ['sessionStorage', 'localStorage'] as const) {
    try {
      const store = (globalThis as unknown as Record<string, WebStorage | undefined>)[name];
      if (store) found.push(store);
    } catch {
      // A private window or blocked site data: nothing to remember into.
    }
  }
  return found;
}

export function rememberSaleOnScreen(stationId: string, saleId: string): void {
  for (const store of stores()) {
    try {
      store.setItem(keyFor(stationId), saleId);
    } catch {
      // Storage refused the write: the platform still holds the sale.
    }
  }
}

export function forgetSaleOnScreen(stationId: string): void {
  for (const store of stores()) {
    try {
      store.removeItem(keyFor(stationId));
    } catch {
      // Nothing to forget here.
    }
  }
}

/** The sale id remembered for this station, or null. The tab's own memory first. */
export function saleOnScreen(stationId: string): string | null {
  for (const store of stores()) {
    try {
      const found = store.getItem(keyFor(stationId));
      if (typeof found === 'string' && found.length > 0) return found;
    } catch {
      // Try the next store.
    }
  }
  return null;
}
