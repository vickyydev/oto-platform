/**
 * The shift token this till is holding (S2-06).
 *
 * It is minted when somebody picks a station and it is spent in one place: the
 * lock screen, when the platform cannot be reached and the box has to decide
 * on its own whether this person may come back in.
 *
 * **Why it is in `localStorage` and what that costs.** The token has to
 * survive the thing it exists for. A till locks on inactivity, the iPad sleeps
 * in a drawer over lunch, the PWA is closed and reopened, and the mall's
 * internet is out the whole time — `sessionStorage` would be gone by then and
 * the person would be stuck at a lock screen with no way through. So it is at
 * rest in the browser, and that is a real cost, bounded deliberately:
 *
 *   - it is useless on its own. Unlocking needs the password as well, checked
 *     against the box's own copy of the hash, under the same five-try cooldown
 *     as the online unlock;
 *   - it is good at ONE station on ONE box at ONE branch, so a token copied
 *     off this iPad unlocks nothing else;
 *   - it dies on its own, in sixteen hours;
 *   - signing out ends it — both here and, through the deny-list, on the box.
 *
 * Every read and write is wrapped: a private window, cleared site data or a
 * browser with storage blocked must degrade to "you need the internet to
 * unlock", not to a screen that will not render.
 */

const KEY = 'oto.pos.staff-token.v1';

export interface HeldStaffToken {
  token: string;
  jti: string;
  /** ISO. Read before spending, so an expired token is not sent to be refused. */
  expiresAt: string;
  stationId: string;
  stationName?: string;
}

export function rememberStaffToken(held: HeldStaffToken): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(held));
  } catch {
    // Storage is unavailable or full. The till still works; it simply cannot
    // unlock without the internet, which the lock screen says when it comes to
    // it rather than guessing now.
  }
}

export function readStaffToken(): HeldStaffToken | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const held = JSON.parse(raw) as HeldStaffToken;
    if (!held?.token || !held.expiresAt || !held.stationId) return null;
    return held;
  } catch {
    return null;
  }
}

/** True when the token is still inside its own lifetime. */
export function staffTokenLive(held: HeldStaffToken | null, now = Date.now()): boolean {
  if (!held) return false;
  const exp = Date.parse(held.expiresAt);
  return Number.isFinite(exp) && exp > now;
}

export function forgetStaffToken(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* see rememberStaffToken */
  }
}
