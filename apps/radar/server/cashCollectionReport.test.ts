import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCashCollectionRows,
  summarizeCashCollectionRows,
  type CashCollectionOrderSource,
  type CashCollectionPaymentSource,
} from "./cashCollectionReport";

const orders: CashCollectionOrderSource[] = [
  {
    order_id: "5300612",
    order_code: "T025",
    created_at: "20/Aug/2026 12:37:13",
    payment_status: "Partially Refunded",
  },
  {
    order_id: "partial-order",
    order_code: "T065",
    created_at: "15/Aug/2026 13:17:34",
    payment_status: "Partially Paid",
  },
];

describe("Floresta cash collection rows", () => {
  test("voucher payment less refund is the real net collection", () => {
    const payments: CashCollectionPaymentSource[] = [
      {
        id: 1,
        order_id: "5300612",
        order_date: "2026-08-20",
        pay_method: "Voucher",
        pay_amount: 349,
        refund_amount: 299,
        payment_at: "20/Aug/2026 12:37:34",
        synced_at: "2026-08-20T06:00:00.000Z",
        raw_json: { id: 4925361, payment_status: "Partially Refunded" },
      },
    ];

    const rows = buildCashCollectionRows(payments, orders, [], "2026-08-20", "2026-08-20");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payment_received, 349);
    assert.equal(rows[0].refund_amount, 299);
    assert.equal(rows[0].net_collected, 50);
  });

  test("partial payment is counted on payment date, not order creation date or order value", () => {
    const payments: CashCollectionPaymentSource[] = [
      {
        id: 2,
        order_id: "partial-order",
        order_date: "2026-08-20",
        pay_method: "Cash(Manual)",
        pay_amount: 100.26,
        refund_amount: 0,
        payment_at: "20/Aug/2026 12:22:00",
        synced_at: "2026-08-20T06:00:00.000Z",
        raw_json: { id: 6000001, payment_status: "Partially Paid" },
      },
    ];

    assert.equal(
      buildCashCollectionRows(payments, orders, [], "2026-08-15", "2026-08-15").length,
      0,
    );

    const rows = buildCashCollectionRows(payments, orders, [], "2026-08-20", "2026-08-20");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].order_created_time, "15/Aug/2026 01:17:34 PM");
    assert.equal(rows[0].payment_time, "20/Aug/2026 12:22:00 PM");
    assert.equal(rows[0].payment_received, 100.26);
    assert.equal(rows[0].refund_amount, 0);
    assert.equal(rows[0].net_collected, 100.26);
    assert.equal("order_total" in rows[0], false);
  });

  test("duplicate Pisell payment IDs use the latest synced version once", () => {
    const payments: CashCollectionPaymentSource[] = [
      {
        id: 3,
        order_id: "5300612",
        order_date: "2026-08-20",
        pay_method: "Voucher",
        pay_amount: 349,
        refund_amount: 0,
        payment_at: "20/Aug/2026 12:37:34",
        synced_at: "2026-08-20T05:00:00.000Z",
        raw_json: { id: 4925361, payment_status: "Paid" },
      },
      {
        id: 4,
        order_id: "5300612",
        order_date: "2026-08-20",
        pay_method: "Voucher",
        pay_amount: 349,
        refund_amount: 299,
        payment_at: "20/Aug/2026 12:37:34",
        synced_at: "2026-08-20T06:00:00.000Z",
        raw_json: { id: 4925361, payment_status: "Partially Refunded" },
      },
    ];

    const rows = buildCashCollectionRows(payments, orders, [], "2026-08-20", "2026-08-20");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].refund_amount, 299);
    assert.equal(rows[0].net_collected, 50);
  });

  test("a previously observed payment remains when a later day snapshot omits it", () => {
    const retainedPayment: CashCollectionPaymentSource = {
      id: 9,
      order_id: "late-payment",
      order_date: "2026-08-20",
      pay_method: "Cash(Manual)",
      pay_amount: 250,
      refund_amount: 0,
      payment_at: "20/Aug/2026 18:30:00",
      synced_at: "2026-08-20T12:00:00.000Z",
      raw_json: { payment_id: 9000001, payment_status: "Paid" },
    };

    // A later snapshot contributes no replacement row, so the retained
    // historical payment is still the source used by the report.
    const laterSnapshot: CashCollectionPaymentSource[] = [];
    const rows = buildCashCollectionRows(
      [retainedPayment, ...laterSnapshot],
      [],
      [],
      "2026-08-20",
      "2026-08-20",
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].unique_payment_id, "9000001");
    assert.equal(rows[0].payment_received, 250);
    assert.equal(rows[0].net_collected, 250);
  });

  test("a later refund version updates the retained payment without duplicating it", () => {
    const payments: CashCollectionPaymentSource[] = [
      {
        id: 10,
        order_id: "late-refund",
        order_date: "2026-08-20",
        pay_method: "Cash(Manual)",
        pay_amount: 500,
        refund_amount: 0,
        payment_at: "20/Aug/2026 19:00:00",
        synced_at: "2026-08-20T12:00:00.000Z",
        raw_json: { payment_id: 9000002, payment_status: "Paid" },
      },
      {
        id: 11,
        order_id: "late-refund",
        order_date: "2026-08-20",
        pay_method: "Cash(Manual)",
        pay_amount: 500,
        refund_amount: 200,
        payment_at: "20/Aug/2026 19:00:00",
        synced_at: "2026-08-21T04:00:00.000Z",
        raw_json: { payment_id: 9000002, payment_status: "Partially Refunded" },
      },
    ];

    const rows = buildCashCollectionRows(payments, [], [], "2026-08-20", "2026-08-20");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].unique_payment_id, "9000002");
    assert.equal(rows[0].payment_status, "Partially Refunded");
    assert.equal(rows[0].refund_amount, 200);
    assert.equal(rows[0].net_collected, 300);
  });

  test("fully refunded and voided payments remain visible with zero net", () => {
    const payments: CashCollectionPaymentSource[] = [
      {
        id: 5,
        order_id: "refunded",
        order_date: "2026-08-21",
        pay_method: "Cash(Manual)",
        pay_amount: 100,
        refund_amount: 100,
        payment_at: "21/Aug/2026 11:00:00",
        synced_at: "2026-08-21T05:00:00.000Z",
        raw_json: { id: 7000001, payment_status: "Refunded" },
      },
      {
        id: 6,
        order_id: "voided",
        order_date: "2026-08-21",
        pay_method: "Cash(Manual)",
        pay_amount: 400,
        refund_amount: 400,
        payment_at: "21/Aug/2026 12:00:00",
        synced_at: "2026-08-21T06:00:00.000Z",
        raw_json: { id: 7000002, payment_status: "Voided" },
      },
    ];

    const rows = buildCashCollectionRows(payments, [], [], "2026-08-21", "2026-08-21");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.net_collected), [0, 0]);
  });

  test("period totals reconcile received less refunds to net", () => {
    const payments: CashCollectionPaymentSource[] = [
      {
        id: 7,
        order_id: "one",
        order_date: "2026-08-20",
        pay_method: "Voucher",
        pay_amount: 349,
        refund_amount: 299,
        payment_at: "20/Aug/2026 12:00:00",
        raw_json: { id: 8000001 },
      },
      {
        id: 8,
        order_id: "two",
        order_date: "2026-08-20",
        pay_method: "Cash(Manual)",
        pay_amount: 100.26,
        refund_amount: 0,
        payment_at: "20/Aug/2026 13:00:00",
        raw_json: { id: 8000002 },
      },
    ];

    const summary = summarizeCashCollectionRows(
      buildCashCollectionRows(payments, [], [], "2026-08-20", "2026-08-20"),
    );
    assert.deepEqual(summary, {
      paymentReceived: 449.26,
      refundAmount: 299,
      netCollected: 150.26,
    });
  });
});