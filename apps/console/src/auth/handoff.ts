import { landingUrl, readHandoffTarget } from '@oto/shared/handoff-target';
import { ApiError } from '@/api/client';
import { authApi } from '@/api/platform';

/**
 * What each hand-off refusal means to the person who just pressed the Console
 * tile. The split that matters is between "start again yourself" and
 * "something is wired wrong, tell whoever runs this" — from a sign-in form
 * appearing where the console was expected, the two look identical.
 *
 * Wording follows apps/pos/src/auth/OperatorContext.tsx so the same refusal
 * does not read as two different problems in two apps.
 */
const HANDOFF_REFUSALS: Record<string, string> = {
  expired: 'The sign-in from the launcher took too long and expired. Sign in here to open the console.',
  replayed: 'That launcher link had already been used. Sign in here to open the console.',
  revoked: 'The session was signed out before the console opened. Sign in here to start a new one.',
  audience:
    'The launcher sent a sign-in meant for a different app. Sign in here, and say so if it keeps happening.',
  origin:
    'The launcher sent a sign-in meant for a different address. Sign in here, and say so if it keeps happening.',
};

export function refusal(err: unknown): string {
  const fallback = 'The launcher could not open the console for you. Sign in here to continue.';
  if (!(err instanceof ApiError)) return fallback; // offline, or the api is down
  const details = err.details as { reason?: string } | undefined;
  const reason = details?.reason ?? err.code.replace(/^HANDOFF_/, '').toLowerCase();
  return HANDOFF_REFUSALS[reason] ?? fallback;
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
  /** Vite's `BASE_URL`: where the console's routes start. */
  base: string;
  replaceUrl(url: string): void;
  exchange(token: string): Promise<unknown>;
}

/**
 * Take the launcher's hand-off token out of the URL and spend it, once, as this
 * module loads (S2-02).
 *
 * The fragment is destroyed BEFORE React renders anything: a token left in the
 * address bar is copied, bookmarked and pasted into a chat window long after
 * its sixty seconds are up. Spending it here rather than inside an effect also
 * means a provider that mounts twice cannot exchange it twice — the second
 * mount awaits this same promise and sees the same answer.
 *
 * The fragment may also carry a target (`&to=/health`, SCRUM-591 P1): after a
 * SUCCESSFUL exchange the address becomes that page, before the router reads
 * it, so the console opens there. The target is checked again here
 * (`readHandoffTarget`); a refused one, or a refused exchange, leaves the
 * console at its home.
 *
 * Resolves to null when the session cookie is now set, or to the sentence the
 * sign-in screen should show.
 */
export function acceptHandoff(port: HandoffArrivalPort): Promise<string | null> | null {
  const token = readHandoffToken(port.hash);
  if (token === null) return null;
  const target = readHandoffTarget(port.hash);
  // Strip before anything else can fail: a fragment that survives a bad token
  // is still a fragment somebody can copy.
  port.replaceUrl(port.pathname + port.search);
  return port
    .exchange(token)
    .then(
      () => {
        if (target) land(port, target);
        return null;
      },
      refusal,
    );
}

/** The session is set either way; a landing the browser refuses leaves the console at home. */
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
    exchange: (token) => authApi.handoffExchange(token),
  });
}

/** Awaited by the session provider before it asks `/me` anything. */
export const handoffArrival = acceptHandoffOnArrival();
