/**
 * One sign-on from the launcher (SCRUM-528).
 *
 * The launcher opens this page as `https://booth/#handoff=<token>`. The page
 * posts the token to the platform api (`/api/auth/handoff/exchange`, through
 * the static site's rewrite) and gets back WHO signed on — a name, a staff code
 * and when their session ends. It gets no credential: the booth audience is
 * identity-only on the api (`IDENTITY_ONLY_AUDIENCES` in
 * apps/api/src/services/handoff.ts), so no cookie is set and the session token
 * never reaches this origin. That is deliberate: this origin also serves the
 * unattended television, and a session token in page script would be the one
 * key to every app for the session's whole life (D15).
 *
 * What a launcher sign-on opens is the demonstration wheel — the in-page fake,
 * which records nothing and calls no booth — with the person shown on duty.
 * The real booth is still worked by pairing a screen and signing in with an
 * account or a PIN; none of that is touched here.
 *
 * **Where the identity is kept.** In page memory, mirrored to
 * `sessionStorage` so a reload of the same tab stays signed on until the
 * session behind it would have ended. It holds no secret: a name and a staff
 * code, both already shown on the screen. The trade-off is honest: the page
 * cannot ask the api afterwards whether the session is still alive (it holds
 * nothing to ask with), so signing out on the launcher does not clear an open
 * booth tab until its own sign-out, the tab closing, or the session's end.
 * Nothing it shows is privileged, and the demo it opens is the same `#fake`
 * wheel anyone can load.
 *
 * Import-free on purpose, so the parsing below runs under the node test
 * runner without a DOM or a bundler.
 */

export interface LauncherIdentity {
  name: string | null;
  code: string;
  /** ISO time the session behind the sign-on ends; the page forgets it then. */
  expiresAt: string;
}

const HELD_KEY = 'oto.booth.signon';
/** Where the platform api answers, behind the booth site's `/api/*` rewrite. */
const EXCHANGE_PATH = '/api/auth/handoff/exchange';
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * The hand-off token in a location hash, case preserved, or null.
 *
 * Not read through `hashTokens` in src/flags.ts: that lower-cases every
 * token, and a signature is case-sensitive.
 */
export function readHandoffToken(hash: string): string | null {
  for (const part of hash.replace(/^#/, '').split(/[,;&\s]+/)) {
    if (!part.startsWith('handoff=')) continue;
    const token = part.slice('handoff='.length);
    return TOKEN.test(token) ? token : null;
  }
  return null;
}

/** The hash with the hand-off removed and every other token (`#cw`, ...) kept. */
export function withoutHandoff(hash: string): string {
  const kept = hash
    .replace(/^#/, '')
    .split(/[,;&\s]+/)
    .filter((part) => part !== '' && !part.startsWith('handoff='));
  return kept.length > 0 ? `#${kept.join(',')}` : '';
}

/** An identity read back from storage, or null if it is malformed or over. */
export function parseHeldIdentity(raw: string | null, now: number): LauncherIdentity | null {
  if (raw === null || raw === '') return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const v = value as Record<string, unknown>;
    if (typeof v.code !== 'string' || typeof v.expiresAt !== 'string') return null;
    if (v.name !== null && typeof v.name !== 'string') return null;
    const ends = Date.parse(v.expiresAt);
    if (!Number.isFinite(ends) || ends <= now) return null;
    return { name: v.name as string | null, code: v.code, expiresAt: v.expiresAt };
  } catch {
    return null;
  }
}

/**
 * The api's answer, reduced to an identity — or null when it is not one the
 * page should act on. A locked session, or one still owing a password change,
 * is refused here exactly as a cookie app's next request would refuse it.
 */
export function identityFromExchange(body: unknown, now: number): LauncherIdentity | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.audience !== 'booth' || b.mustChangePassword === true || b.sessionLocked === true)
    return null;
  return parseHeldIdentity(JSON.stringify(b.identity ?? null), now);
}

// --- The page's side (browser only) ----------------------------------------

function readHeld(): LauncherIdentity | null {
  try {
    const held = parseHeldIdentity(window.sessionStorage.getItem(HELD_KEY), Date.now());
    if (held === null) window.sessionStorage.removeItem(HELD_KEY);
    return held;
  } catch {
    return null;
  }
}

/**
 * Read once at module load, and the fragment scrubbed at once: the token is
 * single-use and spent within the minute, but it has no business sitting in
 * the address bar or the tab's history while the page starts.
 */
function boot(): { pendingToken: string | null; held: LauncherIdentity | null } {
  if (typeof window === 'undefined') return { pendingToken: null, held: null };
  const pendingToken = readHandoffToken(window.location.hash);
  if (pendingToken !== null) {
    try {
      const { pathname, search, hash } = window.location;
      window.history.replaceState(
        window.history.state,
        '',
        `${pathname}${search}${withoutHandoff(hash)}`,
      );
    } catch {
      // A page that cannot rewrite its own URL still exchanges the token; it
      // is spent the moment the api sees it either way.
    }
  }
  return { pendingToken, held: readHeld() };
}

const booted = boot();
let current: LauncherIdentity | null = booted.held;

export const launcherSignOn = {
  /**
   * Whether this load came from the launcher, or carries a sign-on from an
   * earlier one in this tab. Decides the transport at boot: such a page is the
   * demonstration wheel, never a paired booth.
   */
  active: booted.pendingToken !== null || booted.held !== null,

  /**
   * Spend the fragment's token, once. Resolves to the identity, or null when
   * there was no token or the api refused it (expired, replayed, wrong origin,
   * no `app:booth:access`). A refusal leaves the demo wheel running unsigned,
   * and drops any earlier sign-on held in this tab: the launcher was just
   * asked to open the booth as somebody, and it is not the earlier somebody.
   */
  exchange(): Promise<LauncherIdentity | null> {
    // One answer however many times it is asked (React's strict mode mounts
    // twice): the token can be spent once, so it is posted once.
    inflight ??= spend(booted.pendingToken);
    return inflight;
  },

  forget(): void {
    current = null;
    try {
      window.sessionStorage.removeItem(HELD_KEY);
    } catch {
      // Nothing was kept.
    }
  },
};

let inflight: Promise<LauncherIdentity | null> | null = null;

async function spend(token: string | null): Promise<LauncherIdentity | null> {
  if (token === null) return current;
  booted.pendingToken = null;
  const refused = (): null => {
    launcherSignOn.forget();
    return null;
  };
  let body: unknown = null;
  try {
    const response = await fetch(EXCHANGE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      // Nothing to send and nothing to keep: the booth's answer sets no
      // cookie, and this origin's site data is the television's.
      credentials: 'omit',
    });
    if (!response.ok) return refused();
    body = await response.json();
  } catch {
    return refused();
  }
  const identity = identityFromExchange(body, Date.now());
  if (identity === null) return refused();
  current = identity;
  try {
    window.sessionStorage.setItem(HELD_KEY, JSON.stringify(identity));
  } catch {
    // Memory only, then: the sign-on lasts until this tab reloads.
  }
  return identity;
}
