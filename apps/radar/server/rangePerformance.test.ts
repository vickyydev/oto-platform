import assert from "node:assert/strict";
import test from "node:test";
import { BoundedAsyncCache, compactHourlyBuckets } from "./rangePerformance";

test("compacts twenty-minute slots without changing totals", () => {
  const result = compactHourlyBuckets([
    { hour: 27, label: "09:00", orders: 1, revenue: 100, ticketsSold: 1, categories: { Tickets: 100 }, customerTypes: { Tourist: { kids: 1, adults: 0 } } },
    { hour: 28, label: "09:20", orders: 2, revenue: 250, ticketsSold: 3, categories: { Tickets: 200, Extras: 50 }, customerTypes: { Tourist: { kids: 2, adults: 1 } } },
    { hour: 29, label: "09:40", orders: 1, revenue: 75, ticketsSold: 0, categories: { "F&B": 75 }, customerTypes: {} },
  ]);
  assert.equal(result.length, 24);
  assert.deepEqual(result[9], {
    hour: 9,
    label: "09:00",
    orders: 4,
    revenue: 425,
    ticketsSold: 4,
    categories: { Tickets: 300, Extras: 50, "F&B": 75 },
    customerTypes: { Tourist: { kids: 3, adults: 1 } },
  });
});

test("leaves existing hourly buckets unchanged", () => {
  const hourly = [{ hour: 9, label: "09:00", orders: 1, revenue: 100, ticketsSold: 1 }];
  assert.equal(compactHourlyBuckets(hourly), hourly);
});

test("deduplicates simultaneous loads and caches successful results", async () => {
  let loads = 0;
  const cache = new BoundedAsyncCache<number>(1_000, 5);
  const loader = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 42;
  };
  const [a, b] = await Promise.all([cache.getOrLoad("same", loader), cache.getOrLoad("same", loader)]);
  assert.deepEqual([a, b], [42, 42]);
  assert.equal(await cache.getOrLoad("same", loader), 42);
  assert.equal(loads, 1);
});

test("expires values and does not cache failures", async () => {
  let now = 0;
  let loads = 0;
  const cache = new BoundedAsyncCache<number>(10, 2, () => now);
  await assert.rejects(cache.getOrLoad("bad", async () => { throw new Error("no"); }));
  assert.equal(await cache.getOrLoad("bad", async () => 7), 7);
  assert.equal(await cache.getOrLoad("value", async () => ++loads), 1);
  now = 11;
  assert.equal(await cache.getOrLoad("value", async () => ++loads), 2);
});

test("supports direct range-response reads and writes", () => {
  const cache = new BoundedAsyncCache<number>(100, 2);
  cache.set("range", 9);
  assert.equal(cache.get("range"), 9);
  cache.clear();
  assert.equal(cache.get("range"), undefined);
});