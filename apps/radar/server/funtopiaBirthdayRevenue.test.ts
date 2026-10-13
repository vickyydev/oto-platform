import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateDailySummaries,
  buildDedupedNonVoucherRevenueByOrder,
  buildNonVoucherRevenueByOrder,
  computeBirthdayLinks,
  ensureBirthdayAllocationStampedSync,
} from "./funtopia";

describe("buildNonVoucherRevenueByOrder", () => {
  it("excludes voucher payments, including voucher refunds, and nets refunds per order", () => {
    const result = buildNonVoucherRevenueByOrder([
      { order_id: "party", pay_method: "Custom-PromptPay QR", pay_amount: 3_000, refund_amount: 0 },
      { order_id: "party", pay_method: "Voucher", pay_amount: 8_750, refund_amount: 0 },
      { order_id: "party", pay_method: "Cash(Manual)", pay_amount: 500, refund_amount: 100 },
      { order_id: "party", pay_method: "Voucher", pay_amount: 200, refund_amount: 500 },
      { order_id: "fnb", pay_method: "Voucher", pay_amount: 1_300, refund_amount: 0 },
    ]);

    assert.equal(result.get("party"), 3_400);
    assert.equal(result.has("fnb"), false);
  });

  it("keeps a non-voucher refund net while never turning a voucher refund into cash", () => {
    const result = buildNonVoucherRevenueByOrder([
      { order_id: "card-refund", pay_method: "Credit Card", pay_amount: 100, refund_amount: 225 },
      { order_id: "voucher-refund", pay_method: "Voucher", pay_amount: 100, refund_amount: 225 },
    ]);

    assert.equal(result.get("card-refund"), -125);
    assert.equal(result.has("voucher-refund"), false);
  });
});

describe("buildDedupedNonVoucherRevenueByOrder", () => {
  it("deduplicates stable payment IDs across report dates and uses the latest refund state", () => {
    const result = buildDedupedNonVoucherRevenueByOrder([
      {
        order_id: "party",
        order_date: "2026-09-01",
        pay_method: "Cash",
        pay_amount: 1_000,
        refund_amount: 0,
        raw_json: { id: "payment-1" },
        synced_at: "2026-09-01T10:00:00.000Z",
      },
      {
        order_id: "party",
        order_date: "2026-09-02",
        pay_method: "Cash",
        pay_amount: 1_000,
        refund_amount: 250,
        raw_json: { id: "payment-1" },
        synced_at: "2026-09-02T10:00:00.000Z",
      },
      {
        order_id: "party",
        order_date: "2026-09-02",
        pay_method: "PromptPay/QR",
        pay_amount: 300,
        refund_amount: 0,
        raw_json: { id: "payment-2" },
        synced_at: "2026-09-02T10:00:00.000Z",
      },
      {
        order_id: "party",
        order_date: "2026-09-02",
        pay_method: "Voucher",
        pay_amount: 5_000,
        refund_amount: 5_500,
        raw_json: { id: "voucher-1" },
        synced_at: "2026-09-02T10:00:00.000Z",
      },
    ]);

    // 1,000 is not counted twice; the newer copy contributes 750, plus 300.
    assert.equal(result.get("party"), 1_050);
  });
});

describe("birthday cash fields", () => {
  it("does not use booking value as cash for an unmatched party backfill", () => {
    const party = {
      order_id: "party",
      order_code: "A100",
      payment_status: "partially_paid",
      total_amount: 25_000,
      created_at: "01/Sep/2026 10:00:00",
    };
    const packageProduct = {
      order_id: "party",
      product_title: "Gold Birthday Package",
      category_title: "Packages",
      product_quantity: 1,
      payment_price: 25_000,
    };
    const links = computeBirthdayLinks(
      [party],
      new Map(),
      { "Events / Birthdays": { revenue: 0 } },
      [packageProduct],
      undefined,
      [packageProduct],
      new Map([["party", 25_000]]),
    );

    assert.equal(links.partyPackageRevenue, 25_000);
    assert.equal(links.partyOrderCount, 1);
    assert.equal(links.unmatchedPartyOrders?.[0]?.partyPackageRevenueCash, 0);
  });
});

describe("birthday allocation totals", () => {
  it("does not double count F&B already moved into Events in a daily summary", () => {
    const summary: any = {
      categoryBreakdown: {
        "Events / Birthdays": { revenue: 100, quantity: 1, items: [] },
        "F&B": { revenue: 50, quantity: 1, items: [] },
      },
      birthdayLinks: {
        partyPackageRevenue: 100,
        partyFnbRevenue: 25,
        bdTickets: 0,
        combinedBirthdayTotal: 125,
        linkedOrderCount: 1,
        partyOrderCount: 1,
        unresolvedNoteCodes: [],
      },
      birthdayAllocation: "fnb",
      birthdayMovedAmount: 0,
    };

    assert.equal(ensureBirthdayAllocationStampedSync(summary, "events"), true);
    assert.equal(summary.categoryBreakdown["Events / Birthdays"].revenue, 125);
    assert.equal(summary.categoryBreakdown["F&B"].revenue, 25);
    assert.equal(summary.birthdayLinks.combinedBirthdayTotal, 125);

    // Switching back must restore the base category values and the same
    // package + linked-F&B combined total.
    assert.equal(ensureBirthdayAllocationStampedSync(summary, "fnb"), true);
    assert.equal(summary.categoryBreakdown["Events / Birthdays"].revenue, 100);
    assert.equal(summary.categoryBreakdown["F&B"].revenue, 50);
    assert.equal(summary.birthdayLinks.combinedBirthdayTotal, 125);
  });

  it("subtracts moved F&B once when aggregating a requested range", () => {
    const summary: any = {
      date: "2026-09-02",
      totalRevenue: 150,
      totalOrders: 1,
      discountTotal: 0,
      voucherSwingAmount: 0,
      pureTicketRevenue: 100,
      paymentBreakdown: {},
      topProducts: [],
      categoryBreakdown: {
        "Events / Birthdays": { revenue: 125, quantity: 1, items: [] },
        "F&B": { revenue: 25, quantity: 1, items: [] },
      },
      guestBreakdown: {
        adultTickets: 0,
        kidTickets: 0,
        adultRevenue: 0,
        kidRevenue: 0,
        estimatedTotalAdults: 0,
        totalInPark: 0,
        avgStayHours: null,
        stayDistribution: [],
        details: [],
      },
      hourlyBreakdown: [],
      customerTypeSplit: [],
      sourceBreakdown: [],
      birthdayLinks: {
        partyPackageRevenue: 100,
        partyFnbRevenue: 25,
        bdTickets: 0,
        combinedBirthdayTotal: 150,
        linkedOrderCount: 1,
        partyOrderCount: 1,
        unresolvedNoteCodes: [],
      },
      birthdayAllocation: "events",
      birthdayMovedAmount: 25,
    };

    const range = aggregateDailySummaries([summary]);
    assert.equal(range.birthdayLinks.combinedBirthdayTotal, 125);
  });
});