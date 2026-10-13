import assert from "node:assert/strict";
import test from "node:test";

import { pool } from "./db";
import { setCachedSummaryIfUnchanged } from "./funtopia";

test("rejects a derived cache write when a POS sync replaced its snapshot", async (t) => {
  const originalQuery = pool.query.bind(pool);
  const staleSnapshot = { date: "2026-08-25", totalRevenue: 100 };
  const freshSync = { date: "2026-08-25", totalRevenue: 200 };
  const derivedFromStale = { date: "2026-08-25", totalRevenue: 100, birthdayAllocation: "package" };
  let stored = structuredClone(freshSync);

  pool.query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("UPDATE funtopia_daily_cache")) {
      const next = JSON.parse(String(params?.[1]));
      const expected = JSON.parse(String(params?.[2]));
      if (JSON.stringify(stored) !== JSON.stringify(expected)) {
        return { rows: [], rowCount: 0 };
      }
      stored = next;
      return { rows: [{ date: params?.[0] }], rowCount: 1 };
    }
    return { rows: [], rowCount: null };
  }) as typeof pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  const written = await setCachedSummaryIfUnchanged(
    staleSnapshot.date,
    derivedFromStale as any,
    staleSnapshot as any,
  );

  assert.equal(written, false);
  assert.deepEqual(stored, freshSync);
});