import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * How the platform's session is carried inside this app (S2-17a).
 *
 * Three small things the sign-on middleware needs and nothing else does: the
 * name of the cookie the platform answers an exchange with, the sealing of the
 * token inside it, and the sentence to show when the platform refuses a
 * hand-off. They live apart from the middleware because none of them touches
 * Express, a database or an environment variable — which is also what makes
 * them the part that can be checked without a deployment
 * (`tests/platform-sign-on.test.ts`).
 */

/** The platform api's session cookie — `apps/api/src/plugins/session.ts`. */
export const PLATFORM_SESSION_COOKIE = "oto_session";

/**
 * The platform's session token out of the `Set-Cookie` headers of an exchange.
 *
 * It comes back as a cookie because for the POS that response IS the sign-in:
 * the POS is a static site in front of the platform api and the platform's
 * cookie is its cookie. Here the header is read server-side and the cookie
 * itself is dropped — this app's browser cookie is its own session id.
 */
export function sessionTokenFromSetCookie(cookies: readonly string[]): string | null {
  for (const cookie of cookies) {
    const match = new RegExp(`(?:^|;\\s*)${PLATFORM_SESSION_COOKIE}=([^;]*)`).exec(cookie);
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
  }
  return null;
}

/**
 * The platform's token is the one credential this app holds that works on its
 * own: everything else in `otoapp.session` is useless to anyone who does not
 * also hold `SESSION_SECRET`, because that secret is what signs the cookie
 * naming the row. Stored in the clear the token would break that symmetry — a
 * database dump alone would be a working session on every app in the suite. So
 * it is sealed under a key derived from the same secret, with the session id as
 * salt and as associated data, which is the construction the platform already
 * uses for the sealed token in `handoff_token`.
 */
function sealingKey(secret: string, sessionId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, sessionId, "otoapp-platform-session", 32));
}

export function sealPlatformToken(secret: string, sessionId: string, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(secret, sessionId), iv);
  // The session id as associated data: a value copied onto another row fails
  // to open rather than opening as somebody else's session.
  cipher.setAAD(Buffer.from(sessionId, "utf8"));
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** The token, or null for anything that does not open — a changed key, a
 * regenerated session id, a tampered value. Never throws: the caller's answer
 * to all three is the same. */
export function openPlatformToken(
  secret: string,
  sessionId: string,
  sealed: string,
): string | null {
  try {
    const raw = Buffer.from(sealed, "base64");
    const decipher = createDecipheriv("aes-256-gcm", sealingKey(secret, sessionId), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(sessionId, "utf8"));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * What a refusal from the platform means to the person who has just clicked a
 * tile. The split that matters is between "click it again" and "something is
 * wired wrong, tell an administrator": from where they are standing both look
 * the same, which is a sign-in page where they expected their day's work.
 *
 * The keys are the platform's own `HandoffRejection` vocabulary
 * (`apps/api/src/services/handoff.ts`). A reason with no sentence here falls
 * back rather than showing the reader a word from an internal enumeration.
 */
const REFUSALS: Record<string, string> = {
  expired: "That sign-in from the launcher took too long and expired. Open the OTO App tile again.",
  replayed: "That launcher link had already been used. Open the OTO App tile again.",
  revoked: "The session was signed out before this app opened. Sign in on the launcher again.",
  audience:
    "The launcher sent a sign-in meant for a different app. Open the tile again, and tell an administrator if it keeps happening.",
  origin:
    "The launcher sent a sign-in meant for a different address. Tell an administrator: this app's address and the one the platform was given do not match.",
  signature:
    "That sign-in was not issued by the platform. Open the OTO App tile again, and tell an administrator if it keeps happening.",
};

export const REFUSAL_FALLBACK =
  "The launcher could not open the OTO App for you. Open the tile again, and tell an administrator if it keeps happening.";

export function refusalMessage(reason: string): string {
  return REFUSALS[reason] ?? REFUSAL_FALLBACK;
}
