import type { Request } from "express";
import { timingSafeEqual } from "crypto";
import { getDateRangeSummary } from "./funtopia";
import {
  getChalongBirthdayPackageRevenue,
  getCombinedPapayaDateRangeSummary,
} from "./papaya";

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

function roundMoney(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export async function buildMarketingSummary(
  startDate: string,
  endDate: string,
): Promise<MarketingSummaryResponse> {
  const [floresta, chalongDays, chalongBirthdayRevenue] = await Promise.all([
    getDateRangeSummary(startDate, endDate),
    getCombinedPapayaDateRangeSummary(startDate, endDate),
    getChalongBirthdayPackageRevenue(startDate, endDate),
  ]);

  const chalongRevenue = chalongDays.reduce(
    (sum, day) => sum + (Number(day.totalRevenue) || 0),
    0,
  );
  const chalongVisitors = chalongDays.reduce((sum, day) => {
    const guests = day.guestBreakdown;
    if (!guests) return sum;
    return sum + (Number(guests.totalGuests) || 0);
  }, 0);

  // Birthday revenue is package/ticket revenue only. Linked party F&B is
  // intentionally excluded so this metric remains comparable between parks.
  // Chalong is calculated from corrected overrides plus non-overridden real
  // birthday orders so override-only dates cannot be dropped by range filters.
  const florestaBirthdayRevenue =
    Number(floresta.birthdayLinks?.bdTickets) || 0;

  return {
    start_date: startDate,
    end_date: endDate,
    total_revenue: roundMoney(
      (Number(floresta.totalRevenue) || 0) + chalongRevenue,
    ),
    total_visitors: Math.round(
      (Number(floresta.guestBreakdown?.totalInPark) || 0) + chalongVisitors,
    ),
    total_birthday_revenue: roundMoney(
      florestaBirthdayRevenue + chalongBirthdayRevenue,
    ),
    currency: "THB",
    timezone: "Asia/Bangkok",
    parks: ["floresta", "chalong"],
  };
}

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