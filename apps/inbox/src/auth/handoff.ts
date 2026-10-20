import { landingUrl, readHandoffTarget } from '@oto/shared/handoff-target';
import { api, ApiError } from '@/api/client';

/**
 * The launcher sign-on, the Console's pattern copied (plan §4.2,
 * apps/console/src/auth/handoff.ts): the Inbox has no front door of its own.
 *
 * What each hand-off refusal means to the person who just pressed the Inbox
 * tile, worded as the Console words them (`HANDOFF_REFUSALS` there, itself
 * aligned with the till's) so one refusal does not read as two problems in
 * two apps. The split that matters is between "start again yourself" and
 * "something is wired wrong, tell whoever runs this".
 */
export const HANDOFF_REFUSALS: Record<string, string> = {
  expired: 'The sign-in from the launcher took too long and expired. Sign in here to open the inbox.',
  replayed: 'That launcher link had already been used. Sign in here to open the inbox.',
  revoked: 'The session was signed out before the inbox opened. Sign in here to start a new one.',
  audience:
    'The launcher sent a sign-in meant for a different app. Sign in here, and say so if it keeps happening.',
  origin:
    'The launcher sent a sign-in meant for a different address. Sign in here, and say so if it keeps happening.',
};

export const HANDOFF_FALLBACK = 'The launcher could not open the inbox for you. Sign in here to continue.';

/** The sentence for a refused exchange: by the api's `details.reason`, else its code. */
export function handoffRefusal(err: unknown): string {
  if (!(err instanceof ApiError)) return HANDOFF_FALLBACK; // offline, or the api is down
  const details = err.details as { reason?: string } | undefined;
  const reason = details?.reason ?? err.code.replace(/^HANDOFF_/, '').toLowerCase();
  return HANDOFF_REFUSALS[reason] ?? HANDOFF_FALLBACK;
}

/** The token in a `#handoff=` fragment, or null. Pure, for the test. */
export function readHandoffToken(hash: string): string | null {
  const match = /(?:^|&)handoff=([^&]*)/.exec(hash.replace(/^#/, ''));
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1]; // a JWS needs no escaping; a malformed one is the api's to refuse
  }
}

/** What arriving touches, so the test can hand in its own. */
export interface HandoffArrivalPort {
  hash: string;
  pathname: string;
  search: string;
  /** Vite's `BASE_URL`: where the Inbox is served from. */
  base: string;
  replaceUrl(url: string): void;
  exchange(token: string): Promise<unknown>;
}

/**
 * Take the launcher's hand-off token out of the URL and spend it, once, as this
 * module loads (S2-02).
 *
 * The fragment is destroyed BEFORE React renders anything: a token left in the
 * address bar is copied, bookmarked and pasted into a chat long after its
 * sixty seconds are up. Spending it here rather than inside an effect also
 * means a provider that mounts twice cannot exchange it twice.
 *
 * The exchange goes through this site's own `/api` rewrite and answers with a
 * host-only cookie bound to the same session row as the launcher's.
 *
 * The fragment may also carry a target (`&to=/?c=<id>`, SCRUM-591 P1): after
 * a SUCCESSFUL exchange the address becomes that one, before the workspace
 * reads its URL state (`lib/url.ts`), so the Inbox opens on that conversation
 * or tab. The target is checked again here (`readHandoffTarget`); a refused
 * one, or a refused exchange, leaves the Inbox at its home.
 *
 * Resolves to null when the cookie is now set, or to the sentence the sign-in
 * screen should show.
 */
export function acceptHandoff(port: HandoffArrivalPort): Promise<string | null> | null {
  const token = readHandoffToken(port.hash);
  if (token === null) return null;
  const target = readHandoffTarget(port.hash);
  // Strip before anything else can fail: a fragment that survives a bad token
  // is still a fragment somebody can copy.
  port.replaceUrl(port.pathname + port.search);
  return port.exchange(token).then(
    () => {
      if (target) land(port, target);
      return null;
    },
    handoffRefusal,
  );
}

/** The cookie is set either way; a landing the browser refuses leaves the Inbox at home. */
function land(port: HandoffArrivalPort, target: string): void {
  try {
    port.replaceUrl(landingUrl(port.base, target));
  } catch {
    // Home is where it would have opened before P1.
  }
}

function acceptHandoffOnArrival(): Promise<string | null> | null {
  if (typeof window === 'undefined') return null;
  return acceptHandoff({
    hash: window.location.hash,
    pathname: window.location.pathname,
    search: window.location.search,
    base: import.meta.env.BASE_URL,
    replaceUrl: (url) => window.history.replaceState(null, '', url),
    exchange: (token) => api.post('/auth/handoff/exchange', { token }),
  });
}

/** Awaited by the session provider before it asks the api anything. */
export const handoffArrival = acceptHandoffOnArrival();
