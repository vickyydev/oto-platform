/**
 * Taking the launcher's hand-off out of the address bar (S2-17a).
 *
 * The launcher sends the browser here as `https://<this app>/#handoff=<token>`.
 * The fragment is the point: it is never sent to a server, so the token
 * reaches no access log, no proxy and no `Referer` on the next click — the
 * same token in `?handoff=` would be written down by every hop between the two
 * apps and then sit in whichever of those logs is kept longest.
 *
 * It is posted to this app's own `/api/auth/handoff`, which exchanges it with
 * the platform server-to-server and answers with a session cookie of this
 * app's own. The exchange cannot be done from the browser: the platform
 * answers it with ITS session cookie, for its own origin, which is no use to
 * an app that signs people in with Passport.
 *
 * The fragment may also carry a target (`&to=<encoded path>`, SCRUM-591 P1):
 * after a SUCCESSFUL exchange the address becomes that page, before the router
 * reads it, so the app opens there — "Take me there" from the launcher's
 * assistant. The target is checked again here (`readHandoffTarget`, the
 * platform's rule copied into `handoff-target.ts`); a refused one, or a
 * refused exchange, leaves the app at its home.
 */
import { landingUrl, readHandoffTarget } from "./handoff-target";

export interface HandoffProblem {
  /** The vocabulary the server answers with; shown to nobody, logged by us. */
  reason: string;
  title: string;
  detail: string;
}

interface Refusal {
  reason?: unknown;
  message?: unknown;
}

const FRAGMENT = /(?:^|&)handoff=([^&]*)/;

const FALLBACK_DETAIL =
  "The launcher could not open the OTO App for you. Open the tile again, and tell an administrator if it keeps happening.";

/**
 * Two titles, because the two cases ask different things of the reader. A
 * missing identity is an administrator's job and no amount of trying again
 * will change it; everything else is worth one more click.
 */
function titleFor(reason: string): string {
  return reason === "not_provisioned"
    ? "You are not set up in the OTO App yet"
    : "That launcher sign-in did not work";
}

/** The token in a `#handoff=` fragment, or null. Pure, for the check. */
export function readHandoffToken(hash: string): string | null {
  const match = FRAGMENT.exec(hash.replace(/^#/, ""));
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // A signed token needs no escaping; a malformed one is the server's to refuse.
    return match[1];
  }
}

async function redeem(token: string): Promise<HandoffProblem | null> {
  let res: Response;
  try {
    res = await fetch("/api/auth/handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token }),
    });
  } catch {
    return {
      reason: "offline",
      title: titleFor("offline"),
      detail: "The OTO App could not be reached. Check the connection and open the tile again.",
    };
  }
  if (res.ok) return null;
  const body = (await res.json().catch(() => null)) as Refusal | null;
  const reason = typeof body?.reason === "string" ? body.reason : "unknown";
  return {
    reason,
    title: titleFor(reason),
    detail: typeof body?.message === "string" ? body.message : FALLBACK_DETAIL,
  };
}

/** What arriving touches, so the check can hand in its own. */
export interface HandoffArrivalPort {
  hash: string;
  pathname: string;
  search: string;
  /** Vite's `BASE_URL`: where this app's routes start. */
  base: string;
  replaceUrl(url: string): void;
  /** Null when the session is now set, else what to show instead of the app. */
  exchange(token: string): Promise<HandoffProblem | null>;
}

/**
 * Read the token and the target, and destroy the fragment before anything
 * else can fail: one left in the address bar is copied, bookmarked and pasted
 * into a chat window long after its sixty seconds are up. Then spend the
 * token. After a successful exchange only, the address becomes the target;
 * a refused exchange or a refused target lands at home. Null when the app was
 * opened without a hand-off, which is every other visit.
 */
export function acceptHandoff(port: HandoffArrivalPort): Promise<HandoffProblem | null> | null {
  const token = readHandoffToken(port.hash);
  if (token === null) return null;
  const target = readHandoffTarget(port.hash);
  port.replaceUrl(port.pathname + port.search);
  return port.exchange(token).then((problem) => {
    if (problem === null && target !== null) land(port, target);
    return problem;
  });
}

/** The session is set either way; a landing the browser refuses leaves the app at home. */
function land(port: HandoffArrivalPort, target: string): void {
  try {
    port.replaceUrl(landingUrl(port.base, target));
  } catch {
    // Home is where it would have opened before P1.
  }
}

/**
 * Spent once, as this module loads, and not inside a component: an effect that
 * runs twice would spend a single-use token twice, and the second attempt is
 * refused as a replay.
 */
export const handoffArrival: Promise<HandoffProblem | null> | null =
  typeof window === "undefined"
    ? null
    : acceptHandoff({
        hash: window.location.hash,
        pathname: window.location.pathname,
        search: window.location.search,
        base: import.meta.env.BASE_URL,
        replaceUrl: (url) => window.history.replaceState(null, "", url),
        exchange: redeem,
      });
