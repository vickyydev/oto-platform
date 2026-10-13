import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { latestOrderRows, latestPaymentRows } from "./funtopiaDedup";

describe("latestOrderRows", () => {
  it("collapses the exact 309-to-618 duplicate export pattern", () => {
    const firstSync = Array.from({ length: 309 }, (_, index) => ({
      id: index + 1,
      order_id: String(5_302_350 + index),
      synced_at: "2026-08-23T05:00:00.000Z",
      total_amount: index,
    }));
    const overlappingSync = firstSync.map((row, index) => ({
      ...row,
      id: row.id + 1_000,
      synced_at: "2026-08-23T05:00:01.000Z",
      total_amount: index + 0.5,
    }));

    const result = latestOrderRows([...firstSync, ...overlappingSync]);

    assert.equal(result.rows.length, 309);
    assert.equal(result.dropped, 309);
    assert.equal(result.rows[0].total_amount, 0.5);
  });

  it("does not merge different order ids", () => {
    const result = latestOrderRows([
      { order_id: "A", id: 1 },
      { order_id: "B", id: 2 },
    ]);
    assert.equal(result.rows.length, 2);
    assert.equal(result.dropped, 0);
  });
});

describe("latestPaymentRows", () => {
  it("deduplicates stored versions by Pisell payment id", () => {
    const result = latestPaymentRows([
      {
        id: 10,
        order_id: "5302351",
        raw_json: { id: 9001 },
        pay_amount: 1052,
        synced_at: "2026-08-23T05:00:00.000Z",
      },
      {
        id: 11,
        order_id: "5302351",
        raw_json: { id: 9001 },
        pay_amount: 1052,
        synced_at: "2026-08-23T05:00:01.000Z",
      },
    ]);

    assert.equal(result.rows.length, 1);
    assert.equal(result.dropped, 1);
    assert.equal(result.rows[0].id, 11);
  });

  it("preserves legitimate ID-less payments with identical amount and time", () => {
    const result = latestPaymentRows([
      {
        id: 20,
        order_id: "same-order",
        payment_at: "23/Aug/2026 12:00:00",
        pay_method: "Cash",
        pay_amount: 500,
        raw_json: {},
      },
      {
        id: 21,
        order_id: "same-order",
        payment_at: "23/Aug/2026 12:00:00",
        pay_method: "Cash",
        pay_amount: 500,
        raw_json: {},
      },
    ]);

    assert.equal(result.rows.length, 2);
    assert.equal(result.dropped, 0);
  });
});