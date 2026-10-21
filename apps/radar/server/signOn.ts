import type { Express, Request, Response } from "express";
import {
  REFUSAL_FALLBACK,
  RADAR_SESSION_COOKIE,
  clearRadarCookie,
  exchangeHandoff,
  forgetIdentity,
  platformApiUrl,
  platformConfig,
  putPlatformPreferences,
  readCookie,
  setRadarCookie,
  withLauncher,
} from "./platformSession";
import { readPreferencesUpdate } from "@shared/uiPreferences";

/**
 * Signing on from the suite launcher, and out again (S2-18 R2). The design is
 * in `platformSession.ts`; these are its three routes.
 */
export function registerSignOnRoutes(app: Express): void {
  /**
   * Spend a hand-off token for Radar's cookie. Open by necessity — this is
   * where a session comes from — and fenced by the token itself, which the
   * platform exchanges once, within its minute, for Radar's origin only.
   */
  app.post("/api/auth/handoff", async (req: Request, res: Response, next) => {
    try {
      const config = platformConfig();
      if (!config) {
        return res.status(503).json(
          withLauncher({
            reason: "unconfigured",
            message:
              "This deployment cannot accept a launcher sign-in: PLATFORM_API_URL and RADAR_PUBLIC_ORIGIN are not set.",
          }),
        );
      }
      // A cross-site page could otherwise post a token of its own and leave
      // somebody signed in as an account they did not choose. No Origin is a
      // server, not a browser, and is allowed.
      const origin = req.get("origin");
      if (origin && origin.trim().replace(/\/$/, "").toLowerCase() !== config.origin) {
        return res.status(403).json(
          withLauncher({
            reason: "cross_origin",
            message: "A launcher sign-in has to be completed by Radar itself.",
          }),
        );
      }
      const token = typeof req.body?.token === "string" ? req.body.token : "";
      if (!token || token.length > 8192) {
        return res.status(400).json(withLauncher({ reason: "no_token", message: REFUSAL_FALLBACK }));
      }
      const exchanged = await exchangeHandoff(config, token);
      if (!exchanged.ok) {
        return res
          .status(exchanged.status)
          .json(withLauncher({ reason: exchanged.reason, message: exchanged.message }));
      }
      setRadarCookie(res, exchanged.sessionToken, exchanged.maxAgeS);
      console.log(`[auth] signed in from the launcher hand-off (account ${exchanged.accountId})`);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Radar's cookie only. The platform session stays alive for the other apps;
   * "sign out everywhere" is the launcher's, and it ends Radar too. The answer
   * names the launcher (LAUNCHER_URL) so the person lands back there rather
   * than on Radar's signed-out page (SCRUM-529).
   */
  app.post("/api/auth/sign-out", (req: Request, res: Response) => {
    const token = readCookie(req, RADAR_SESSION_COOKIE);
    if (token) forgetIdentity(token);
    clearRadarCookie(res);
    res.json(withLauncher({ ok: true }));
  });

  /** Who is signed in. Guarded: reaching the handler means the census guard said yes. */
  app.get("/api/me", (req: Request, res: Response) => {
    res.json(withLauncher({ signedIn: true, ...req.radar!.identity }));
  });

  /**
   * SCRUM-653 — Radar's theme toggle writes the person's choice back to their
   * platform account, so the launcher, the till and the console show it too.
   * Guarded like /api/me; forwarded with the person's own platform token and
   * the caller's replay key. The cached identity is dropped afterwards so the
   * next /api/me reads the new value rather than the one from ten seconds ago.
   */
  app.put("/api/me/preferences", async (req: Request, res: Response, next) => {
    try {
      const body = readPreferencesUpdate(req.body);
      if (!body) {
        return res.status(400).json({
          reason: "bad_preferences",
          message: "Send a theme (system, light or dark), a language (en or th), or both.",
        });
      }
      const apiUrl = platformApiUrl();
      const token = req.radar!.token;
      if (!apiUrl) return res.status(503).json(withLauncher({ reason: "unconfigured", message: REFUSAL_FALLBACK }));
      const key = req.get("idempotency-key");
      const answer = await putPlatformPreferences(apiUrl, token, body, key && key.length <= 200 ? key : null);
      if (answer.status === 200) forgetIdentity(token);
      res.status(answer.status).json(answer.body);
    } catch (err) {
      next(err);
    }
  });
}
