import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDashboardDateRange } from "./dashboardDateRange";

test("keeps an ascending dashboard date range unchanged", () => {
  const range = normalizeDashboardDateRange(
    new Date(2026, 7, 31, 12),
    new Date(2026, 8, 15, 12),
  );

  assert.equal(range.from.getFullYear(), 2026);
  assert.equal(range.from.getMonth(), 7);
  assert.equal(range.from.getDate(), 31);
  assert.equal(range.to.getMonth(), 8);
  assert.equal(range.to.getDate(), 15);
});

test("normalizes a reversed dashboard date range before it is applied", () => {
  const range = normalizeDashboardDateRange(
    new Date(2026, 8, 1, 12),
    new Date(2026, 7, 31, 12),
  );

  assert.equal(range.from.getMonth(), 7);
  assert.equal(range.from.getDate(), 31);
  assert.equal(range.to.getMonth(), 8);
  assert.equal(range.to.getDate(), 1);
});