/**
 * Taking the launcher's hand-off out of the address bar (S2-18).
 *
 * The launcher sends the browser here as `https://<radar>/#handoff=<token>`.
 * The fragment is never sent to a server, so the token reaches no access log,
 * proxy or `Referer`. It is posted to Radar's own `/api/auth/handoff`, which
 * exchanges it with the platform server-to-server and answers with Radar's
 * own httpOnly cookie. Same contract as the OTO App's (apps/oto-app).
 */

export interface HandoffProblem {
  reason: string;
  title: string;
  detail: string;
}

const FRAGMENT = /(?:^|&)handoff=([^&]*)/;

const FALLBACK_DETAIL =
  "The launcher could not open Radar for you. Open the tile again, and tell an administrator if it keeps happening.";

/** Read the token and destroy the fragment before anything else can fail. */
function takeToken(): string | null {
  const match = FRAGMENT.exec(window.location.hash.slice(1));
  if (!match || !match[1]) return null;
  const raw = match[1];
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
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
      title: "That launcher sign-in did not work",
      detail: "Radar could not be reached. Check the connection and open the tile again.",
    };
  }
  if (res.ok) return null;
  const body = (await res.json().catch(() => null)) as { reason?: unknown; message?: unknown } | null;
  return {
    reason: typeof body?.reason === "string" ? body.reason : "unknown",
    title: "That launcher sign-in did not work",
    detail: typeof body?.message === "string" ? body.message : FALLBACK_DETAIL,
  };
}

/**
 * Spent once, as this module loads, and not inside a component: an effect that
 * runs twice would spend a single-use token twice and be refused as a replay.
 * Null when Radar was opened without a hand-off.
 */
export const handoffArrival: Promise<HandoffProblem | null> | null = (() => {
  const token = takeToken();
  return token === null ? null : redeem(token);
})();
