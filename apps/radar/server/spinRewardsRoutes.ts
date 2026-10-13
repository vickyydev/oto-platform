import { createHash, timingSafeEqual } from "crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { spinRewards } from "./spinRewards";
import { SPIN_REWARDS_BY_PRIZE_ID } from "@shared/spinRewards";

const issueBodySchema = z.object({
  winId: z.string().trim().min(1).max(200).regex(/^[\x20-\x7E]+$/, "winId contains invalid characters"),
  prizeId: z.string().trim().refine((value) => SPIN_REWARDS_BY_PRIZE_ID.has(value), "Unknown prizeId"),
  wonAt: z.string().datetime({ offset: true }).optional(),
});

const redeemBodySchema = z.object({
  code: z.string().trim().regex(/^\d{4}$/, "code must be exactly four digits"),
});

function spinApiKeyAuthorised(req: Request): {
  ok: boolean;
  kind?: "api";
  status?: 401 | 503;
  message?: string;
} {
  const expected = process.env.SPIN_WIN_REDEEM_KEY;
  if (!expected) {
    return { ok: false, status: 503, message: "Spin Wheel API authentication is not configured" };
  }
  const provided = req.get("X-API-Key") ?? "";
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  const valid = expectedBuffer.length === providedBuffer.length
    && timingSafeEqual(expectedBuffer, providedBuffer);
  return valid
    ? { ok: true, kind: "api" }
    : { ok: false, status: 401, message: "Spin Wheel API authentication required" };
}

function redemptionRateLimitBucket(req: Request): string {
  // The reception redemption screen is intentionally public. Hash the
  // request origin so rate limiting remains effective without storing IPs.
  const origin = `${req.ip || req.socket.remoteAddress || "unknown"}:${req.get("User-Agent") || ""}`;
  return createHash("sha256").update(`public:${origin}`).digest("hex");
}

function unavailable(res: Response, redeem = false) {
  if (redeem) return res.status(503).json({ status: "Service unavailable" });
  return res.status(503).json({ message: "Spin Wheel reward service unavailable" });
}

/**
 * Spin Wheel's deliberately isolated API, kept for the legacy wheel URL until
 * it is retired at cutover (S2-18): the platform booth (S2-07) issues and
 * redeems its own vouchers, and Radar's report reads those
 * (GET /api/spin-wheel/report in routes.ts, through sources/otoPos.ts). No response includes a legacy
 * campaign QR token, URL, barcode, or other Funtovia data.
 */
export function registerSpinRewardRoutes(app: Express): void {
  app.get("/api/spin-wheel/rewards", async (_req, res) => {
    try {
      const { rewards } = await spinRewards.listRewards();
      res.json({
        rewards: rewards.map((reward) => ({
          prizeId: reward.prizeId,
          campaignId: reward.campaignId,
          displayName: reward.displayName,
          active: reward.active,
          customerValue: reward.customerValue,
          title: reward.title,
          instructions: reward.instructions,
          terms: reward.terms,
        })),
      });
    } catch {
      unavailable(res);
    }
  });

  app.post("/api/spin-wheel/issue", async (req, res) => {
    const auth = spinApiKeyAuthorised(req);
    if (!auth.ok) return res.status(auth.status!).json({ message: auth.message });
    const parsed = issueBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid issue request",
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const result = await spinRewards.issue({
        winId: parsed.data.winId,
        prizeId: parsed.data.prizeId,
        wonAt: parsed.data.wonAt ? new Date(parsed.data.wonAt) : new Date(),
      });
      if (result.kind === "issued") return res.json(result.reward);
      if (result.kind === "win_prize_mismatch") {
        return res.status(409).json({ message: "winId was already issued for a different prize" });
      }
      if (result.kind === "invalid_won_at") {
        return res.status(400).json({ message: "wonAt cannot be in the future" });
      }
      if (result.kind === "disabled") {
        return res.status(409).json({ message: "This reward is not active for issuance" });
      }
      return res.status(409).json({ message: "Four-digit reward-code capacity is exhausted" });
    } catch (error) {
      // DB errors intentionally have the same response as other outages.
      return unavailable(res);
    }
  });

  app.post("/api/spin-wheel/redeem", async (req, res) => {
    let rateLimit;
    try {
      rateLimit = await spinRewards.consumeRedemptionRateLimit(redemptionRateLimitBucket(req));
    } catch {
      return unavailable(res, true);
    }
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      return res.status(429).json({ message: "Too many redemption attempts; try again shortly" });
    }
    const parsed = redeemBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid redemption request",
        errors: parsed.error.flatten().fieldErrors,
      });
    }
    try {
      const result = await spinRewards.redeem(parsed.data.code);
      if (result.kind === "not_found") return res.status(404).json({ status: "Not found" });
      const status = result.kind === "redeemed" ? "Redeemed" : "Already used";
      return res.status(result.kind === "redeemed" ? 200 : 409).json({
        status,
        code: result.code,
        prizeId: result.prizeId,
        campaignId: result.campaignId,
        displayName: result.displayName,
        customerValue: result.customerValue,
        wonAt: result.wonAt,
        redeemedAt: result.redeemedAt,
      });
    } catch {
      return unavailable(res, true);
    }
  });
}