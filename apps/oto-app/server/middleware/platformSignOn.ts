import { createHash, randomBytes } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import "express-session";
import { storage } from "../storage";
import { log } from "../lib/logger";
import {
  PLATFORM_SESSION_COOKIE,
  REFUSAL_FALLBACK,
  openPlatformToken,
  refusalMessage,
  sealPlatformToken,
  sessionTokenFromSetCookie,
} from "../lib/platformSession";

/**
 * Signing on from the suite launcher (S2-17a).
 *
 * The suite is several apps on several origins behind one platform session,
 * and a cookie cannot cross them — `*.onrender.com` is on the public suffix
 * list. So the launcher mints a short-lived token aimed at ONE app, the
 * browser carries it in the URL fragment, and the app exchanges it for a
 * session of its own. The contract is `apps/api/src/services/handoff.ts`; the
 * three properties it rests on are the fragment (never the query string, so
 * the token reaches no access log or `Referer`), the single-use `jti` (a
 * signature proves minting, not freshness) and the one session row behind
 * every app.
 *
 * This app exchanges server-to-server rather than from the browser, because
 * unlike the POS it is not a static site in front of the platform api: it has
 * its own Express session, its own `users` table and handlers that read
 * `req.user`. So the browser posts the fragment to this app's own origin, the
 * exchange happens here, and what comes back is turned into a Passport login.
 * Everything downstream is untouched — `passport.session()` still deserialises
 * through `getUserWithBranchAccess`, so role, branch scope and tenant resolve
 * exactly as they did before, and no handler knows a hand-off happened.
 *
 * The middleware therefore sits BETWEEN `passport.initialize()` (which is what
 * puts `req.login` on the request) and `passport.session()`.
 */

/**
 * How long one answer about the platform session is reused.
 *
 * Every screen in this app fires a handful of `/api` calls, so without a
 * window a single page load would ask the platform ten times whether the
 * session is still alive. Ten seconds collapses a burst into one question
 * while bounding how long a session that has been signed out everywhere keeps
 * working here to about the time it takes to read one screen.
 */
const LIVENESS_TTL_MS = 10_000;

/** Neither call may hold a request open: both are on the critical path. */
const EXCHANGE_TIMEOUT_MS = 8_000;
const LIVENESS_TIMEOUT_MS = 3_000;

export interface PlatformSignOnConfig {
  /** The platform api's base URL, no trailing slash. */
  apiUrl: string;
  /** This app's own public origin, as the platform signed it into the token. */
  origin: string;
}

/**
 * What this app remembers about the platform session behind the person using
 * it. It lives in the session record — the server side of
 * `connect-pg-simple`, in `otoapp.session` — and never goes to the browser.
 */
interface PlatformLink {
  /** The platform account, for the log line and for the back-channel. */
  accountId: string;
  /** The platform session's own token, sealed — see `lib/platformSession.ts`. */
  sealedToken: string;
}

declare module "express-session" {
  interface SessionData {
    platform?: PlatformLink;
  }
}

function normaliseOrigin(value: string): string {
  return value.trim().replace(/\/$/, "").toLowerCase();
}

/**
 * Null when this deployment has no hand-off configured, which is the state a
 * developer's laptop is in. The origin is read from configuration and never
 * from the request: the platform ties a token to one app BY the origin it is
 * exchanged from, so taking it from a `Host` header a caller chose would hand
 * that decision to the caller.
 */
export function platformSignOnConfig(): PlatformSignOnConfig | null {
  const apiUrl = (process.env.PLATFORM_API_URL ?? "").trim().replace(/\/$/, "");
  const origin = normaliseOrigin(process.env.OTOAPP_PUBLIC_ORIGIN ?? "");
  if (!apiUrl || !origin) return null;
  return { apiUrl, origin };
}

/**
 * The Passport-local form, kept for the cutover rehearsal and off by default.
 *
 * Off rather than on, because two ways in is two ways in: a password that
 * still works here is a password that survives being deactivated on the
 * platform, and nothing about signing out everywhere would reach it.
 */
export function legacyLoginEnabled(): boolean {
  return (process.env.OTOAPP_LEGACY_LOGIN ?? "").toLowerCase() === "true";
}

export const LEGACY_LOGIN_REFUSAL =
  "This app is opened from the OTO suite launcher: sign in there and choose OTO App, " +
  "and you will land here without a second password. This form is kept only for the cutover rehearsal.";

const NOT_PROVISIONED =
  "Your account may open the OTO App, but nobody has said which OTO App user you are. " +
  "An administrator has to link your platform account to your user here — Login Users, " +
  "Apps, then link OTO App with the id of your OTO App user — after which this will work.";

/**
 * The key the platform's token is sealed with while this app holds it. On a
 * deployment `SESSION_SECRET` is set and is not the value written in the
 * source — the boot guard in `config/env.ts` refuses to start otherwise. On a
 * laptop there is nothing to derive from, so it is minted per process: a
 * restart then ends these sessions rather than reading a key out of the source.
 */
const SEALING_SECRET = process.env.SESSION_SECRET ?? randomBytes(32).toString("hex");

// --- The exchange -----------------------------------------------------------

type Exchange =
  | { ok: true; accountId: string; sessionToken: string }
  | { ok: false; status: number; reason: string; message: string };

interface ExchangeBody {
  accountId?: unknown;
  mustChangePassword?: unknown;
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown; details?: { reason?: unknown } };
}

/** The global `Response`, named so the Express one can keep its own name. */
type Response_ = globalThis.Response;

function setCookiesOf(res: Response_): string[] {
  const headers = res.headers;
  return typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie") ?? ""];
}

async function exchange(
  config: PlatformSignOnConfig,
  token: string,
  requestId: string | undefined,
): Promise<Exchange> {
  let res: Response_;
  try {
    res = await fetch(`${config.apiUrl}/auth/handoff/exchange`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Required, and refused without it: the origin is the only thing tying
        // a token to one app, so the platform will not exchange a hand-off
        // that arrives without one. It has to appear in the platform's
        // HANDOFF_APP_ORIGINS as `oto_app=` and in its ALLOWED_ORIGINS, or
        // this call is answered with a refusal rather than a session.
        origin: config.origin,
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (err) {
    log().error({ err }, "could not reach the platform api to exchange a hand-off");
    return {
      ok: false,
      status: 502,
      reason: "platform_unreachable",
      message: "The platform did not answer. Try the tile again in a moment.",
    };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ErrorBody | null;
    const reason =
      typeof body?.error?.details?.reason === "string" ? body.error.details.reason : "unknown";
    log().warn({ status: res.status, reason }, "the platform refused a hand-off");
    return {
      ok: false,
      status: 401,
      reason,
      message: refusalMessage(reason),
    };
  }

  const body = (await res.json().catch(() => null)) as ExchangeBody | null;
  const accountId = typeof body?.accountId === "string" ? body.accountId : null;
  if (!accountId) {
    log().error({ status: res.status }, "the platform accepted a hand-off but named no account");
    return {
      ok: false,
      status: 502,
      reason: "platform_unreadable",
      message: REFUSAL_FALLBACK,
    };
  }
  if (body?.mustChangePassword === true) {
    // The platform refuses to mint a hand-off for an account that still owes a
    // password change, so this is belt and braces — but if it ever arrives,
    // opening a session here would strand the person in an app that cannot
    // change a platform password.
    return {
      ok: false,
      status: 403,
      reason: "password_change_required",
      message: "Change your password on the launcher first, then open the OTO App tile again.",
    };
  }

  const sessionToken = sessionTokenFromSetCookie(setCookiesOf(res));
  if (!sessionToken) {
    // Without it there is no back-channel, and a session here that cannot be
    // ended from the platform is worse than no session at all.
    log().error("the platform's exchange returned no session cookie");
    return {
      ok: false,
      status: 502,
      reason: "platform_unreadable",
      message: REFUSAL_FALLBACK,
    };
  }
  return { ok: true, accountId, sessionToken };
}

// --- The back-channel -------------------------------------------------------

interface CachedAnswer {
  at: number;
  /** Shared by everything that asks inside the window; never rejects. */
  answer: Promise<boolean>;
}

const liveness = new Map<string, CachedAnswer>();

function sweep(now: number): void {
  // `forEach` rather than `for…of`: this app compiles without
  // `downlevelIteration`, so iterating a Map directly does not type-check.
  liveness.forEach((cached, key) => {
    if (now - cached.at >= LIVENESS_TTL_MS) liveness.delete(key);
  });
}

/**
 * Ask the platform whether the session behind this identity is still there.
 *
 * "Sign out everywhere" on the launcher revokes the platform session row. This
 * app holds no platform cookie for a browser to fail with, so the only way it
 * can find out is to ask — and `GET /me` is the question, because it is the
 * one route that answers 401 for a session that has been revoked, has expired
 * or belongs to an account that has been deactivated.
 *
 * A locked session is NOT dead: locking is the till's inactivity behaviour on
 * one device, and the platform still serves `/me` for it.
 *
 * Anything other than a clear 401 keeps the session. A platform restart, a
 * timeout or a 503 would otherwise sign every person out of this app at once,
 * which turns a blip on one service into a park-wide interruption; the app's
 * own session expiry still bounds how long that can last.
 */
function platformSessionAlive(
  config: PlatformSignOnConfig,
  token: string,
  requestId: string | undefined,
): Promise<boolean> {
  // Keyed by a digest rather than by the token, so the cache is not a second
  // place the credential is written down.
  const key = createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  const cached = liveness.get(key);
  if (cached && now - cached.at < LIVENESS_TTL_MS) return cached.answer;

  const answer = probe(config, token, requestId);
  liveness.set(key, { at: now, answer });
  sweep(now);
  return answer;
}

async function probe(
  config: PlatformSignOnConfig,
  token: string,
  requestId: string | undefined,
): Promise<boolean> {
  try {
    const res = await fetch(`${config.apiUrl}/me`, {
      headers: {
        cookie: `${PLATFORM_SESSION_COOKIE}=${token}`,
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      signal: AbortSignal.timeout(LIVENESS_TIMEOUT_MS),
    });
    // An unread body keeps the socket checked out of the connection pool until
    // it is collected, and this runs on every burst of requests.
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401) return false;
    if (!res.ok) {
      log().warn({ status: res.status }, "the platform answered the session check unexpectedly");
    }
    return true;
  } catch (err) {
    log().warn({ err }, "could not reach the platform api to check a session; keeping it");
    return true;
  }
}

// --- Wiring -----------------------------------------------------------------

/**
 * Registered between `passport.initialize()` and `passport.session()`:
 * `req.login` comes from the first, and running before the second means a
 * hand-off that has just been spent is deserialised on this very request like
 * any other session.
 */
export function registerPlatformSignOn(app: Express): void {
  const config = platformSignOnConfig();
  if (!config) {
    log().warn(
      "PLATFORM_API_URL and OTOAPP_PUBLIC_ORIGIN are not both set: the launcher hand-off is unavailable on this deployment",
    );
  }

  /**
   * Spend a hand-off token for a session here.
   *
   * Open by necessity — this is where a session comes from — and fenced by the
   * token itself, which the platform will only exchange once, within its
   * minute, for this origin.
   */
  app.post("/api/auth/handoff", (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      if (!config) {
        return res.status(503).json({
          reason: "unconfigured",
          message:
            "This deployment cannot accept a launcher sign-in: PLATFORM_API_URL and OTOAPP_PUBLIC_ORIGIN are not set.",
        });
      }

      /**
       * A cross-site page cannot read this response, but it could post a token
       * of its own and leave somebody signed in as an account they did not
       * choose. Same rule as the platform api: a request with no `Origin` is
       * allowed (that is a server, not a browser), one from elsewhere is not.
       */
      const origin = req.get("origin");
      const own = normaliseOrigin(`${req.protocol}://${req.get("host") ?? ""}`);
      if (origin && normaliseOrigin(origin) !== own) {
        return res.status(403).json({
          reason: "cross_origin",
          message: "A launcher sign-in has to be completed by the OTO App itself.",
        });
      }

      const body = req.body as { token?: unknown } | undefined;
      const token = typeof body?.token === "string" ? body.token : "";
      if (!token || token.length > 8192) {
        return res.status(400).json({ reason: "no_token", message: REFUSAL_FALLBACK });
      }

      const exchanged = await exchange(config, token, req.requestId);
      if (!exchanged.ok) {
        return res
          .status(exchanged.status)
          .json({ reason: exchanged.reason, message: exchanged.message });
      }

      const user = await storage.getUserByPlatformUserId(exchanged.accountId);
      if (!user) {
        /**
         * Not something to swallow, and not the person's mistake. Their
         * account holds `app:oto_app:access` — the platform would not have
         * minted this token otherwise — but no user here has been claimed as
         * them, so there is no role, no branch scope and no tenant to sign
         * them in with. Guessing by name or email is how one person ends up
         * inside another's record.
         */
        log().warn(
          { platformAccountId: exchanged.accountId },
          "a hand-off arrived for a platform account with no user in this app",
        );
        return res.status(403).json({ reason: "not_provisioned", message: NOT_PROVISIONED });
      }
      if (!user.isActive) {
        return res.status(403).json({
          reason: "disabled",
          message: "Your OTO App user has been disabled. Contact your administrator.",
        });
      }

      req.login(user, (err) => {
        if (err) return next(err);
        /**
         * After the login, never before: `req.login` regenerates the session
         * to guard against fixation, and anything written to the old one goes
         * with it.
         */
        req.session.platform = {
          accountId: exchanged.accountId,
          sealedToken: sealPlatformToken(SEALING_SECRET, req.sessionID, exchanged.sessionToken),
        };
        req.session.save((saveErr) => {
          if (saveErr) return next(saveErr);
          log().info({ userId: user.id }, "signed in from the launcher hand-off");
          res.json({ ok: true });
        });
      });
    })().catch(next);
  });

  app.use((req: Request, _res: Response, next: NextFunction) => {
    const platform = req.session?.platform;
    if (!platform || !config) return next();
    // Only `/api`. A request for the client bundle carries no data and spends
    // no session; the first call a screen makes is where that happens.
    if (!req.path.startsWith("/api")) return next();

    const token = openPlatformToken(SEALING_SECRET, req.sessionID, platform.sealedToken);
    if (!token) {
      // The session was regenerated under us, or the key changed. Either way
      // this is a session whose platform side can no longer be checked, and
      // one that cannot be ended from the launcher must not keep serving.
      log().warn("a platform-backed session could not be opened; ending it");
      req.logout(() => next());
      return;
    }

    void platformSessionAlive(config, token, req.requestId).then((alive) => {
      if (alive) return next();
      log().info(
        { platformAccountId: platform.accountId },
        "the platform session behind this session has ended; signing out",
      );
      // `req.logout` regenerates the session, so the sealed token goes with the
      // row it was stored in rather than being left behind for the next person
      // to use this browser.
      req.logout(() => next());
    });
  });
}
