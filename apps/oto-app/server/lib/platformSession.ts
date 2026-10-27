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

// ─── SCRUM-648: a view-as (impersonation) sign-on ─────────────────────────────

/**
 * The mark the platform puts on an exchange when the hand-off opened a
 * support administrator's audited "view as" window (S2-23 Support tools):
 * the window, who is really acting, whose session it is, and when it ends.
 * Kept on the session record, never sent to the browser as a credential.
 */
export interface PlatformImpersonation {
  id: string;
  actorAccountId: string;
  subjectAccountId: string;
  mode: "read_only" | "write_allowed";
  expiresAt: string;
  /** For the banner: the two people's names as the suite shows staff; null when the platform did not name them. */
  actorName: string | null;
  subjectName: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The exchange's `impersonation`, or null when there is none. Throws on a malformed one. */
export function readImpersonationMark(value: unknown): PlatformImpersonation | null {
  if (value === undefined || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v !== "object" ||
    typeof v.id !== "string" || !UUID.test(v.id) ||
    typeof v.actorAccountId !== "string" || !UUID.test(v.actorAccountId) ||
    typeof v.subjectAccountId !== "string" || !UUID.test(v.subjectAccountId) ||
    (v.mode !== "read_only" && v.mode !== "write_allowed") ||
    typeof v.expiresAt !== "string" || Number.isNaN(Date.parse(v.expiresAt)) ||
    (v.actorName !== undefined && v.actorName !== null && typeof v.actorName !== "string") ||
    (v.subjectName !== undefined && v.subjectName !== null && typeof v.subjectName !== "string")
  ) {
    throw new Error("malformed impersonation mark");
  }
  return { id: v.id, actorAccountId: v.actorAccountId, subjectAccountId: v.subjectAccountId,
    mode: v.mode, expiresAt: v.expiresAt,
    actorName: typeof v.actorName === "string" ? v.actorName : null,
    subjectName: typeof v.subjectName === "string" ? v.subjectName : null };
}

/**
 * What the app's client reads for the banner (`/api/user` `platformViewAs`):
 * the window and the two names, never anything that acts.
 */
export function viewAsForClient(mark: PlatformImpersonation | null | undefined) {
  if (!mark) return null;
  return { id: mark.id, actorName: mark.actorName, subjectName: mark.subjectName, mode: mark.mode, expiresAt: mark.expiresAt };
}

/**
 * The view-as mark on an activity-log row this app writes inside a window
 * (`storage.createActivityLog`): `actor_type`, the actor really there and
 * `on_behalf_of` the subject, merged into the row's metadata JSON. A row
 * written outside a window, or whose metadata is not a JSON object, is
 * returned exactly as it was: the mark is additive and never rewrites what
 * another reader already parses.
 */
export function viewAsMetadata(
  metadataJson: string | null | undefined,
  viewAs: { id: string; actorAccountId: string; subjectAccountId: string } | null | undefined,
): string | null | undefined {
  if (!viewAs) return metadataJson;
  let base: Record<string, unknown> = {};
  if (metadataJson) {
    try {
      const parsed: unknown = JSON.parse(metadataJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return metadataJson;
      base = parsed as Record<string, unknown>;
    } catch {
      return metadataJson;
    }
  }
  return JSON.stringify({ ...base, actor_type: "impersonated", actor_account_id: viewAs.actorAccountId,
    on_behalf_of: viewAs.subjectAccountId, impersonation_id: viewAs.id });
}

/**
 * The routes this app never opens to somebody else's hands, however the window
 * was approved: payroll, and employment contracts and letters with their
 * signing pages (S2-23: "the OTO App refuses it for payroll and contract
 * routes"). Matched on whole path segments, so `/api/payrolls-report` would
 * not be caught by accident and `/api/payroll/…` always is.
 */
export const IMPERSONATION_REFUSED_PREFIXES = [
  "/api/payroll",
  "/api/contracts",
  "/api/signing",
  "/api/letters",
  "/api/letter-sign",
] as const;

export const IMPERSONATION_REFUSED_MESSAGE =
  "Payroll and contracts are not available while viewing the OTO App as somebody else.";
export const IMPERSONATION_READ_ONLY_MESSAGE =
  "This is a read-only view-as window: nothing can be changed from it.";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Ending the window from inside it stays possible, read-only or not. */
const READ_ONLY_EXEMPT = new Set(["/api/logout", "/api/auth/logout"]);

/**
 * A refusal for this request inside a view-as window, or null to let it
 * through: payroll and contracts always, and every write while the window is
 * read-only — the platform refuses its own writes the same way; this app's
 * writes never pass through the platform, so it says so itself.
 */
export function impersonationRefusal(
  path: string,
  mark: PlatformImpersonation | null | undefined,
  method = "GET",
): { status: 403; reason: "impersonation_refused" | "impersonation_read_only"; message: string } | null {
  if (!mark) return null;
  const lower = path.toLowerCase();
  const hit = IMPERSONATION_REFUSED_PREFIXES.some((p) => lower === p || lower.startsWith(`${p}/`));
  if (hit) return { status: 403, reason: "impersonation_refused", message: IMPERSONATION_REFUSED_MESSAGE };
  if (mark.mode === "read_only" && !READ_METHODS.has(method.toUpperCase()) && !READ_ONLY_EXEMPT.has(lower)) {
    return { status: 403, reason: "impersonation_read_only", message: IMPERSONATION_READ_ONLY_MESSAGE };
  }
  return null;
}
