/**
 * Unit tests for indexRedeemedTitlesByOrder (server/funtopia.ts)
 *
 * Locks in the tolerant parsing rules that survive Pisell API format changes:
 *   – June 2026: redeem_amount silently changed from negative to 0.00, which
 *     wiped Sales Booth / Mascot attribution. The fix: only reject POSITIVE
 *     amounts (top-ups); accept negative, zero, missing, and NaN amounts.
 *   – action "redeem" and "customer redeem" are the reliable redemption signal.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { indexRedeemedTitlesByOrder } from "./funtopia";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type WalletPassRow = Parameters<typeof indexRedeemedTitlesByOrder>[0][number];

function makePass(overrides: Partial<WalletPassRow> = {}): WalletPassRow {
  return {
    order_id: "ORD-001",
    title: "Airport 250 (Discount QR)",
    action: "redeem",
    redeem_amount: -250,
    code: "ABC123",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Action filtering
// ---------------------------------------------------------------------------

describe("action filtering", () => {
  test("action 'redeem' is accepted", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ action: "redeem" })]);
    assert.equal(m.get("ORD-001")?.length, 1);
  });

  test("action 'customer redeem' is accepted", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ action: "customer redeem" })]);
    assert.equal(m.get("ORD-001")?.length, 1);
  });

  test("action matching is case-insensitive and trims whitespace", () => {
    const m1 = indexRedeemedTitlesByOrder([makePass({ action: "  Redeem  " })]);
    assert.equal(m1.get("ORD-001")?.length, 1);
    const m2 = indexRedeemedTitlesByOrder([makePass({ action: "Customer Redeem" })]);
    assert.equal(m2.get("ORD-001")?.length, 1);
  });

  test("action 'customer recharge' is rejected", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ action: "customer recharge" })]);
    assert.equal(m.size, 0);
  });

  test("action 'recharge' is rejected", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ action: "recharge" })]);
    assert.equal(m.size, 0);
  });

  test("action 'top-up' is rejected", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ action: "top-up" })]);
    assert.equal(m.size, 0);
  });

  test("null action is rejected", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ action: null })]);
    assert.equal(m.size, 0);
  });

  test("empty string action is rejected", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ action: "" })]);
    assert.equal(m.size, 0);
  });
});

// ---------------------------------------------------------------------------
// redeem_amount tolerance (the June 2026 format change)
// ---------------------------------------------------------------------------

describe("redeem_amount tolerance", () => {
  test("negative amount is accepted (original Pisell format)", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ redeem_amount: -250 })]);
    assert.equal(m.get("ORD-001")?.length, 1);
  });

  test("zero amount is accepted (June 2026 format change)", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ redeem_amount: 0 })]);
    assert.equal(m.get("ORD-001")?.length, 1);
  });

  test("zero amount as string '0.00' is accepted", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ redeem_amount: "0.00" as any })]);
    assert.equal(m.get("ORD-001")?.length, 1);
  });

  test("negative amount as string '-250.00' is accepted", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ redeem_amount: "-250.00" as any })]);
    assert.equal(m.get("ORD-001")?.length, 1);
  });

  test("positive amount is rejected (top-up / refund)", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ redeem_amount: 250 })]);
    assert.equal(m.size, 0);
  });

  test("positive amount as string is rejected", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ redeem_amount: "250.00" as any })]);
    assert.equal(m.size, 0);
  });

  test("missing / undefined amount is accepted (future-proof: field might disappear)", () => {
    const pass = makePass();
    // @ts-expect-error intentionally deleting required field to simulate missing field
    delete pass.redeem_amount;
    const m = indexRedeemedTitlesByOrder([pass]);
    assert.equal(m.get("ORD-001")?.length, 1);
  });

  test("null amount is accepted", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ redeem_amount: null as any })]);
    assert.equal(m.get("ORD-001")?.length, 1);
  });

  test("NaN amount is accepted", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ redeem_amount: NaN })]);
    assert.equal(m.get("ORD-001")?.length, 1);
  });

  test("non-numeric string amount is accepted (NaN path)", () => {
    const m = indexRedeemedTitlesByOrder([makePass({ redeem_amount: "n/a" as any })]);
    assert.equal(m.get("ORD-001")?.length, 1);
  });
});

// ---------------------------------------------------------------------------
// grouping by order_id
// ---------------------------------------------------------------------------

describe("grouping by order_id", () => {
  test("multiple redemptions on the same order are collected together", () => {
    const passes = [
      makePass({ order_id: "ORD-A", title: "Voucher X", code: "X1" }),
      makePass({ order_id: "ORD-A", title: "Voucher Y", code: "Y1" }),
    ];
    const m = indexRedeemedTitlesByOrder(passes);
    assert.equal(m.get("ORD-A")?.length, 2);
  });

  test("different order IDs get separate map entries", () => {
    const passes = [
      makePass({ order_id: "ORD-A", title: "Voucher X", code: "X1" }),
      makePass({ order_id: "ORD-B", title: "Voucher Y", code: "Y1" }),
    ];
    const m = indexRedeemedTitlesByOrder(passes);
    assert.equal(m.get("ORD-A")?.length, 1);
    assert.equal(m.get("ORD-B")?.length, 1);
  });

  test("entry carries the correct title and code", () => {
    const m = indexRedeemedTitlesByOrder([
      makePass({ title: "Airport 250 (Discount QR)", code: "QR-ABC" }),
    ]);
    const entries = m.get("ORD-001");
    assert.ok(entries && entries.length === 1);
    assert.equal(entries[0].title, "Airport 250 (Discount QR)");
    assert.equal(entries[0].code, "QR-ABC");
  });
});

// ---------------------------------------------------------------------------
// Rows skipped when title AND code are both empty
// ---------------------------------------------------------------------------

describe("title / code requirements", () => {
  test("row with no title and no code is skipped", () => {
    const m = indexRedeemedTitlesByOrder([
      makePass({ title: null, code: null }),
    ]);
    assert.equal(m.size, 0);
  });

  test("row with only a title (no code) is accepted", () => {
    const m = indexRedeemedTitlesByOrder([
      makePass({ title: "Airport 250 (Discount QR)", code: null }),
    ]);
    assert.equal(m.get("ORD-001")?.length, 1);
  });

  test("row with only a code (no title) is accepted", () => {
    const m = indexRedeemedTitlesByOrder([
      makePass({ title: null, code: "QR-XYZ" }),
    ]);
    assert.equal(m.get("ORD-001")?.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Mixed batch: real-world scenario with top-ups and redemptions together
// ---------------------------------------------------------------------------

describe("mixed batch (real-world scenario)", () => {
  test("redeems and top-ups in the same batch: only redeems land on orders", () => {
    const passes: WalletPassRow[] = [
      // real redemption (original format)
      makePass({ order_id: "ORD-1", title: "School 250", code: "S1", action: "redeem", redeem_amount: -250 }),
      // real redemption (June 2026 zero-amount format)
      makePass({ order_id: "ORD-2", title: "Mascot 350", code: "M1", action: "customer redeem", redeem_amount: 0 }),
      // top-up — must NOT be attributed to the order
      makePass({ order_id: "ORD-3", title: "Top-up 500", code: "T1", action: "customer recharge", redeem_amount: 500 }),
      // another top-up via positive redeem_amount with redeem action
      makePass({ order_id: "ORD-4", title: "Refund 250", code: "R1", action: "redeem", redeem_amount: 250 }),
    ];
    const m = indexRedeemedTitlesByOrder(passes);
    assert.equal(m.get("ORD-1")?.length, 1, "negative-amount redeem should appear");
    assert.equal(m.get("ORD-2")?.length, 1, "zero-amount redeem should appear");
    assert.equal(m.has("ORD-3"), false, "customer recharge should be excluded");
    assert.equal(m.has("ORD-4"), false, "positive-amount redeem (refund) should be excluded");
  });

  test("empty input returns an empty map", () => {
    const m = indexRedeemedTitlesByOrder([]);
    assert.equal(m.size, 0);
  });
});
