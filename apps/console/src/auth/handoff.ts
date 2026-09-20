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

function refusal(err: unknown): string {
  const fallback = 'The launcher could not open the console for you. Sign in here to continue.';
  if (!(err instanceof ApiError)) return fallback; // offline, or the api is down
  const details = err.details as { reason?: string } | undefined;
  const reason = details?.reason ?? err.code.replace(/^HANDOFF_/, '').toLowerCase();
  return HANDOFF_REFUSALS[reason] ?? fallback;
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
 * Resolves to null when the session cookie is now set, or to the sentence the
 * sign-in screen should show.
 */
function acceptHandoffOnArrival(): Promise<string | null> | null {
  const match = /(?:^|&)handoff=([^&]*)/.exec(window.location.hash.slice(1));
  if (!match || !match[1]) return null;
  const raw = match[1];
  // Strip before anything else can fail: a fragment that survives a bad token
  // is still a fragment somebody can copy.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  let token: string;
  try {
    token = decodeURIComponent(raw);
  } catch {
    token = raw; // a JWS needs no escaping; a malformed one is the api's to refuse
  }
  return authApi
    .handoffExchange(token)
    .then(() => null)
    .catch(refusal);
}

/** Awaited by the session provider before it asks `/me` anything. */
export const handoffArrival = acceptHandoffOnArrival();
