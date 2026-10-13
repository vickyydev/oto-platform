import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKETING_RATE_LIMIT,
  consumeMarketingRateLimit,
  marketingApiKeyIsValid,
  resetMarketingRateLimitsForTests,
  validateMarketingDateRange,
} from "./marketingSummary";

test("validates an inclusive date range", () => {
  assert.deepEqual(validateMarketingDateRange("2026-08-01", "2026-08-31"), {
    ok: true,
    days: 31,
  });
});

test("rejects malformed, impossible, reversed, and oversized date ranges", () => {
  assert.equal(validateMarketingDateRange("08-01-2026", "2026-08-31").ok, false);
  assert.equal(validateMarketingDateRange("2026-02-30", "2026-03-01").ok, false);
  assert.equal(validateMarketingDateRange("2026-09-02", "2026-09-01").ok, false);
  assert.equal(validateMarketingDateRange("2025-01-01", "2026-01-02").ok, false);
});

test("compares bearer API keys without accepting missing or partial values", () => {
  assert.equal(marketingApiKeyIsValid("correct-key", "correct-key"), true);
  assert.equal(marketingApiKeyIsValid("correct", "correct-key"), false);
  assert.equal(marketingApiKeyIsValid(null, "correct-key"), false);
  assert.equal(marketingApiKeyIsValid("correct-key", undefined), false);
});

test("limits a caller to sixty requests per minute", () => {
  resetMarketingRateLimitsForTests();
  const now = 1_000_000;
  for (let i = 0; i < MARKETING_RATE_LIMIT; i += 1) {
    assert.equal(consumeMarketingRateLimit("caller", now).allowed, true);
  }
  const blocked = consumeMarketingRateLimit("caller", now);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSeconds, 60);
  assert.equal(consumeMarketingRateLimit("caller", now + 60_000).allowed, true);
});