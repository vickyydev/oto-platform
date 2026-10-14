import { createHash } from "crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Who is using Radar (S2-18 R2).
 *
 * Radar has no user table and no session store of its own: the platform
 * session IS the identity. The launcher mints a hand-off aimed at Radar, the
 * browser carries it in the URL fragment, Radar posts it back to the platform
 * (`POST /auth/handoff/exchange`, the design in
 * apps/api/src/services/handoff.ts) and keeps the platform session's own
 * opaque token in an httpOnly cookie on Radar's origin. Signing out anywhere
 * revokes that one session row, so it ends Radar too; there is no second
 * credential to forget.
 *
 * Every guarded request is answered by asking the platform who the token
 * belongs to (`GET /me`) and whether they hold `app:radar:access`
 * (`GET /me/permissions`), cached for a few seconds per token. Unlike the OTO
 * App, which keeps its own session and stays open through a platform blip,
 * Radar has nothing to fall back on: a platform that cannot answer means a
 * request that cannot be authorised, so it fails closed with 503.
 */

/** Radar's own cookie. Holds the platform session's token, nothing else. */
export const RADAR_SESSION_COOKIE = "radar_session";
/** The platform api's session cookie name (`apps/api/src/plugins/session.ts`). */
export const PLATFORM_SESSION_COOKIE = "oto_session";
/** The permission that opens Radar (packages/shared/src/permissions.ts). */
export const RADAR_ACCESS_PERMISSION = "app:radar:access";

const IDENTITY_TTL_MS = 10_000;
const EXCHANGE_TIMEOUT_MS = 8_000;
const IDENTITY_TIMEOUT_MS = 4_000;

export interface PlatformConfig {
  /** The platform api's base URL, no trailing slash. */
  apiUrl: string;
  /** Radar's own public origin, as the platform signed it into the token. */
  origin: string;
}

function normaliseOrigin(value: string): string {
  return value.trim().replace(/\/$/, "").toLowerCase();
}

/**
 * Null when the deployment has no platform configured (a laptop without the
 * api). The origin comes from configuration, never from a `Host` header: the
 * platform ties a token to one app BY the origin it is exchanged from.
 */
export function platformConfig(): PlatformConfig | null {
  const apiUrl = (process.env.PLATFORM_API_URL ?? "").trim().replace(/\/$/, "");
  const origin = normaliseOrigin(process.env.RADAR_PUBLIC_ORIGIN ?? "");
  if (!apiUrl || !origin) return null;
  return { apiUrl, origin };
}

/** Only the platform api's base URL — what the figures adapter needs. */
export function platformApiUrl(): string | null {
  const apiUrl = (process.env.PLATFORM_API_URL ?? "").trim().replace(/\/$/, "");
  return apiUrl || null;
}

/**
 * The OTO launcher's address (SCRUM-529), where a signed-out person is sent
 * back to. Only an absolute http(s) URL counts: anything else is treated as
 * unset rather than handed to the browser as a place to go. Null on a laptop
 * without the launcher, and the client then stays on Radar's own page.
 */
export function launcherUrl(): string | null {
  const raw = (process.env.LAUNCHER_URL ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A signed-out or refused answer, carrying the way back to the launcher when it is known. */
export function withLauncher<T extends object>(body: T): T & { launcherUrl: string | null } {
  return { ...body, launcherUrl: launcherUrl() };
}

// --- Cookies -----------------------------------------------------------------

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function cookieSecure(): boolean {
  const origin = process.env.RADAR_PUBLIC_ORIGIN ?? "";
  return origin.startsWith("https://") || process.env.NODE_ENV === "production";
}

/** `maxAgeS` null: a browser-session cookie. */
export function setRadarCookie(res: Response, token: string, maxAgeS: number | null): void {
  const parts = [
    `${RADAR_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (maxAgeS !== null) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeS))}`);
  if (cookieSecure()) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

export function clearRadarCookie(res: Response): void {
  const parts = [`${RADAR_SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (cookieSecure()) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

/** The platform's session token and its lifetime, out of an exchange's `Set-Cookie`. */
export function platformSessionFromSetCookie(
  cookies: readonly string[],
): { token: string; maxAgeS: number | null } | null {
  for (const cookie of cookies) {
    const match = new RegExp(`(?:^|;\\s*)${PLATFORM_SESSION_COOKIE}=([^;]*)`).exec(cookie);
    if (!match?.[1]) continue;
    let token = match[1];
    try {
      token = decodeURIComponent(token);
    } catch {
      /* a signed token needs no escaping */
    }
    const age = /;\s*max-age=(\d+)/i.exec(cookie);
    return { token, maxAgeS: age ? Number(age[1]) : null };
  }
  return null;
}

// --- The exchange --------------------------------------------------------------

/** What a refusal from the platform means to the person who clicked the tile. */
const REFUSALS: Record<string, string> = {
  expired: "That sign-in from the launcher took too long and expired. Open the Radar tile again.",
  replayed: "That launcher link had already been used. Open the Radar tile again.",
  revoked: "The session was signed out before Radar opened. Sign in on the launcher again.",
  audience:
    "The launcher sent a sign-in meant for a different app. Open the tile again, and tell an administrator if it keeps happening.",
  origin:
    "The launcher sent a sign-in meant for a different address. Tell an administrator: Radar's address and the one the platform was given do not match.",
  signature:
    "That sign-in was not issued by the platform. Open the Radar tile again, and tell an administrator if it keeps happening.",
};

export const REFUSAL_FALLBACK =
  "The launcher could not open Radar for you. Open the tile again, and tell an administrator if it keeps happening.";

export function refusalMessage(reason: string): string {
  return REFUSALS[reason] ?? REFUSAL_FALLBACK;
}

export type Exchange =
  | { ok: true; accountId: string; sessionToken: string; maxAgeS: number | null }
  | { ok: false; status: number; reason: string; message: string };

function setCookiesOf(res: globalThis.Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  return typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie") ?? ""];
}

export async function exchangeHandoff(config: PlatformConfig, token: string): Promise<Exchange> {
  let res: globalThis.Response;
  try {
    res = await fetch(`${config.apiUrl}/auth/handoff/exchange`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Required: the origin is what ties the token to Radar. It must be the
        // radar= entry of the api's HANDOFF_APP_ORIGINS and in its ALLOWED_ORIGINS.
        origin: config.origin,
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("[auth] could not reach the platform api to exchange a hand-off:", (err as Error)?.message);
    return {
      ok: false,
      status: 502,
      reason: "platform_unreachable",
      message: "The platform did not answer. Try the tile again in a moment.",
    };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { details?: { reason?: unknown } } }
      | null;
    const reason = typeof body?.error?.details?.reason === "string" ? body.error.details.reason : "unknown";
    console.warn(`[auth] the platform refused a hand-off (${res.status}, ${reason})`);
    return { ok: false, status: 401, reason, message: refusalMessage(reason) };
  }

  const body = (await res.json().catch(() => null)) as
    | { accountId?: unknown; mustChangePassword?: unknown }
    | null;
  const accountId = typeof body?.accountId === "string" ? body.accountId : null;
  if (!accountId) {
    return { ok: false, status: 502, reason: "platform_unreadable", message: REFUSAL_FALLBACK };
  }
  if (body?.mustChangePassword === true) {
    return {
      ok: false,
      status: 403,
      reason: "password_change_required",
      message: "Change your password on the launcher first, then open the Radar tile again.",
    };
  }
  const session = platformSessionFromSetCookie(setCookiesOf(res));
  if (!session) {
    console.error("[auth] the platform's exchange returned no session cookie");
    return { ok: false, status: 502, reason: "platform_unreadable", message: REFUSAL_FALLBACK };
  }
  return { ok: true, accountId, sessionToken: session.token, maxAgeS: session.maxAgeS };
}

// --- Who the token belongs to ------------------------------------------------------

export interface RadarIdentity {
  accountId: string;
  name: string | null;
  branch: { id: string; name: string; code: string } | null;
}

export type IdentityAnswer =
  | { kind: "ok"; identity: RadarIdentity }
  | { kind: "signed_out" }
  | { kind: "no_access"; identity: RadarIdentity }
  | { kind: "unavailable" };

interface Cached {
  at: number;
  answer: Promise<IdentityAnswer>;
}
const identities = new Map<string, Cached>();

/** Keyed by a digest, so the cache is not a second place the credential is written. */
function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function forgetIdentity(token: string): void {
  identities.delete(digest(token));
}

/** Pure: does a `/me/permissions` answer carry Radar's permission at any scope? */
export function holdsRadarAccess(body: unknown): boolean {
  const list = (body as { permissions?: unknown } | null)?.permissions;
  return (
    Array.isArray(list) &&
    list.some((g) => (g as { permission?: unknown } | null)?.permission === RADAR_ACCESS_PERMISSION)
  );
}

async function ask(apiUrl: string, token: string): Promise<IdentityAnswer> {
  const headers = { cookie: `${PLATFORM_SESSION_COOKIE}=${token}` };
  try {
    const [meRes, permRes] = await Promise.all([
      fetch(`${apiUrl}/me`, { headers, signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS) }),
      fetch(`${apiUrl}/me/permissions`, { headers, signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS) }),
    ]);
    if (meRes.status === 401 || permRes.status === 401) {
      await Promise.all([meRes.body?.cancel(), permRes.body?.cancel()]).catch(() => undefined);
      return { kind: "signed_out" };
    }
    if (!meRes.ok || !permRes.ok) {
      console.warn(`[auth] the platform answered the identity check with ${meRes.status}/${permRes.status}`);
      await Promise.all([meRes.body?.cancel(), permRes.body?.cancel()]).catch(() => undefined);
      return { kind: "unavailable" };
    }
    const me = (await meRes.json()) as {
      account?: { id?: string };
      employee?: { name?: string; nickname?: string | null } | null;
      branch?: { id: string; name: string; code: string } | null;
    };
    const perms = await permRes.json();
    const identity: RadarIdentity = {
      accountId: me.account?.id ?? "",
      name: me.employee?.nickname || me.employee?.name || null,
      branch: me.branch ?? null,
    };
    return holdsRadarAccess(perms) ? { kind: "ok", identity } : { kind: "no_access", identity };
  } catch (err) {
    console.warn("[auth] could not reach the platform api to check a session:", (err as Error)?.message);
    return { kind: "unavailable" };
  }
}

export function resolveIdentity(apiUrl: string, token: string): Promise<IdentityAnswer> {
  const key = digest(token);
  const now = Date.now();
  const cached = identities.get(key);
  if (cached && now - cached.at < IDENTITY_TTL_MS) return cached.answer;
  const answer = ask(apiUrl, token);
  identities.set(key, { at: now, answer });
  identities.forEach((c, k) => {
    if (now - c.at >= IDENTITY_TTL_MS) identities.delete(k);
  });
  return answer;
}

// --- The guard -----------------------------------------------------------------

declare global {
  namespace Express {
    interface Request {
      /** Set by the guard on every signed-in request. */
      radar?: { token: string; identity: RadarIdentity };
    }
  }
}

/**
 * Refuses a request without a live platform session holding
 * `app:radar:access`. On success `req.radar` carries the token, which the
 * figures adapter forwards so the platform authorises the person themselves.
 */
export function requireRadarSession(req: Request, res: Response, next: NextFunction): void {
  const apiUrl = platformApiUrl();
  if (!apiUrl) {
    res.status(503).json(
      withLauncher({
        reason: "unconfigured",
        message: "Radar cannot check who you are: PLATFORM_API_URL is not set on this deployment.",
      }),
    );
    return;
  }
  const token = readCookie(req, RADAR_SESSION_COOKIE);
  if (!token) {
    res.status(401).json(withLauncher({ reason: "signed_out", message: "Open Radar from the OTO launcher." }));
    return;
  }
  resolveIdentity(apiUrl, token)
    .then((answer) => {
      switch (answer.kind) {
        case "ok":
          req.radar = { token, identity: answer.identity };
          return next();
        case "signed_out":
          clearRadarCookie(res);
          return void res
            .status(401)
            .json(withLauncher({ reason: "signed_out", message: "Your session has ended. Open Radar from the OTO launcher." }));
        case "no_access":
          return void res.status(403).json(
            withLauncher({
              reason: "no_access",
              message: "Your account may not open Radar. Ask an administrator for Radar access.",
            }),
          );
        case "unavailable":
          return void res
            .status(503)
            .json(withLauncher({ reason: "platform_unavailable", message: "The platform did not answer. Try again in a moment." }));
      }
    })
    .catch(next);
}
