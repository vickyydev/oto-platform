import type { Request } from "express";
import { timingSafeEqual } from "crypto";

export const MARKETING_API_KEY_ENV = "OTO_RADAR_MARKETING_API_KEY";
export const MARKETING_RATE_LIMIT = 60;
export const MARKETING_RATE_WINDOW_MS = 60_000;
export const MARKETING_MAX_RANGE_DAYS = 366;

export interface MarketingSummaryResponse {
  start_date: string;
  end_date: string;
  total_revenue: number;
  total_visitors: number;
  total_birthday_revenue: number;
  currency: "THB";
  timezone: "Asia/Bangkok";
  parks: ["floresta", "chalong"];
}

export type MarketingDateValidation =
  | { ok: true; days: number }
  | { ok: false; message: string };

export function validateMarketingDateRange(
  startDate: string,
  endDate: string,
): MarketingDateValidation {
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDate.test(startDate) || !isoDate.test(endDate)) {
    return {
      ok: false,
      message: "start_date and end_date are required in YYYY-MM-DD format",
    };
  }

  const toUtcDay = (value: string): number | null => {
    const [year, month, day] = value.split("-").map(Number);
    const timestamp = Date.UTC(year, month - 1, day);
    const parsed = new Date(timestamp);
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      return null;
    }
    return timestamp;
  };

  const start = toUtcDay(startDate);
  const end = toUtcDay(endDate);
  if (start === null || end === null) {
    return { ok: false, message: "start_date or end_date is not a valid calendar date" };
  }
  if (end < start) {
    return { ok: false, message: "end_date must be on or after start_date" };
  }

  const days = Math.floor((end - start) / 86_400_000) + 1;
  if (days > MARKETING_MAX_RANGE_DAYS) {
    return {
      ok: false,
      message: `date range cannot exceed ${MARKETING_MAX_RANGE_DAYS} inclusive days`,
    };
  }
  return { ok: true, days };
}

export function bearerTokenFromRequest(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function marketingApiKeyIsValid(
  supplied: string | null,
  expected = process.env[MARKETING_API_KEY_ENV],
): boolean {
  if (!supplied || !expected) return false;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

/**
 * The summary's figures are not served (S2-18). They were computed from the
 * Pisell and Papaya tables, which the one-source ruling retired; Radar now
 * reads figures only through the platform with a signed-in person's session,
 * and this caller is a machine with a shared key. Until the platform offers a
 * machine read of the rollup, the route authenticates, rate-limits and
 * validates exactly as before, then answers 503 rather than a made-up zero.
 */
export const MARKETING_FIGURES_UNAVAILABLE = {
  error: "temporarily_unavailable",
  message:
    "OTO Radar's figures now come from the OTO POS rollup on the platform, which this key cannot read yet; retry later",
} as const;

type RateBucket = { startedAt: number; count: number };
const rateBuckets = new Map<string, RateBucket>();

export function consumeMarketingRateLimit(
  key: string,
  now = Date.now(),
): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
  const existing = rateBuckets.get(key);
  if (!existing || now - existing.startedAt >= MARKETING_RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return {
      allowed: true,
      remaining: MARKETING_RATE_LIMIT - 1,
      retryAfterSeconds: 0,
    };
  }

  if (existing.count >= MARKETING_RATE_LIMIT) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(
          (MARKETING_RATE_WINDOW_MS - (now - existing.startedAt)) / 1000,
        ),
      ),
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: MARKETING_RATE_LIMIT - existing.count,
    retryAfterSeconds: 0,
  };
}

export function resetMarketingRateLimitsForTests(): void {
  rateBuckets.clear();
}