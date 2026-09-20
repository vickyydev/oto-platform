import { handoffApi } from '@/api/platform';
import type { SuiteApp, SuiteAppKey } from './apps';

export interface OpenedApp {
  key: SuiteAppKey;
  at: string;
}

const OPENED_KEY = 'oto.launcher.opened';

/**
 * Which apps this browser opened from here, newest first. Kept in
 * sessionStorage: it is a convenience for the account page, tab-scoped like
 * the sitting it describes, and holds nothing but an app name and a time — no
 * token ever touches storage, which is the whole point of the URL fragment.
 */
export function openedApps(): OpenedApp[] {
  try {
    const raw = window.sessionStorage.getItem(OPENED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is OpenedApp =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as OpenedApp).key === 'string' &&
        typeof (entry as OpenedApp).at === 'string',
    );
  } catch {
    // Private mode, or storage the browser refuses. The list is decoration.
    return [];
  }
}

function recordOpen(key: SuiteAppKey): void {
  try {
    const next = [{ key, at: new Date().toISOString() }, ...openedApps().filter((e) => e.key !== key)];
    window.sessionStorage.setItem(OPENED_KEY, JSON.stringify(next.slice(0, 10)));
  } catch {
    // Not worth failing a hand-off over.
  }
}

export function clearOpened(): void {
  try {
    window.sessionStorage.removeItem(OPENED_KEY);
  } catch {
    // As above.
  }
}

/**
 * Open an app signed in. The token goes in the fragment and nowhere else: a
 * fragment is never sent to a server and never appears in a Referer header, so
 * it cannot be read out of an access log, a proxy or an analytics beacon on
 * the way to the app that is meant to consume it.
 *
 * The destination comes from the API's own `launchUrl`, which is built from
 * the origin it signed the token's audience against. The launcher's copy of
 * that address only decides whether to offer the tile; it never decides where
 * a credential is sent, so the two cannot disagree about that.
 *
 * Navigation is in the same tab on purpose. Issuing the token is a round trip,
 * and a window opened after an await has lost the click that authorised it —
 * Safari and Firefox block it. A blank tab that may or may not fill is a worse
 * front door than one that simply goes there.
 */
export async function openApp(app: SuiteApp): Promise<void> {
  if (!app.origin) throw new Error(`${app.name} has no address on this deployment`);
  const issued = await handoffApi.issue(app.key);
  recordOpen(app.key);
  window.location.assign(issued.launchUrl || `${app.origin}/#handoff=${issued.token}`);
}

/** Open an app without a hand-off, leaving it to ask for its own sign-in. */
export function openAppUnauthenticated(app: SuiteApp): void {
  if (!app.origin) return;
  window.location.assign(app.origin);
}
