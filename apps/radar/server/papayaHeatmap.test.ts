import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPapayaSummary,
  isPapayaSummerCampOrder,
  parsePapayaTicketItem,
} from "./papaya";

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    status: "complete",
    orderDate: "2026-09-09T03:15:00.000Z",
    total: 900,
    billTotal: 900,
    discountTotal: 0,
    channelName: "Walk-in",
    payments: [],
    appliedDiscounts: [],
    items: [],
    ...overrides,
  };
}

test("ticket parser respects kid, adult, and multi-kid quantities", () => {
  assert.equal(parsePapayaTicketItem("Kid 1 hour", 2, 500).kids, 2);
  assert.equal(parsePapayaTicketItem("Adult ticket", 3, 300).adults, 3);
  assert.equal(parsePapayaTicketItem("3 Kids - all day", 2, 1200).kids, 6);
  assert.equal(parsePapayaTicketItem("Camp", 2, 2400).kids, 2);
});

test("Papaya hourly activity counts tickets in the Bangkok order hour", () => {
  const summary = buildPapayaSummary("2026-09-09", [
    order({
      items: [
        { name: "Kid 1 hour", quantity: 2, itemTotal: 600 },
        { name: "Adult ticket", quantity: 1, itemTotal: 300 },
      ],
    }),
  ], "reception");

  assert.deepEqual(
    summary.hourlyBreakdown.map(({ hour, orders, revenue, ticketsSold }) => ({
      hour, orders, revenue, ticketsSold,
    })),
    [{ hour: 10, orders: 1, revenue: 900, ticketsSold: 3 }],
  );
});

test("F&B-only Papaya orders produce zero hourly tickets", () => {
  const summary = buildPapayaSummary("2026-09-09", [
    order({
      total: 450,
      billTotal: 450,
      items: [{ name: "Pizza", quantity: 2, itemTotal: 450 }],
    }),
  ], "reception");

  assert.equal(summary.hourlyBreakdown[0].ticketsSold, 0);
});

test("Camp-channel orders retain a complete hourly Summer Camp subtotal", () => {
  const summary = buildPapayaSummary("2026-09-09", [
    order({
      channelName: "Camp",
      total: 1200,
      billTotal: 1200,
      items: [{ name: "Camp", quantity: 1, itemTotal: 1200 }],
    }),
    order({
      id: "order-2",
      total: 300,
      billTotal: 300,
      items: [{ name: "Adult ticket", quantity: 1, itemTotal: 300 }],
    }),
  ], "reception");

  assert.equal(isPapayaSummerCampOrder({ channelName: "Summer Camp" }), true);
  assert.equal(isPapayaSummerCampOrder({ channelName: "Campaign" }), false);
  assert.deepEqual(summary.hourlyBreakdown[0].summerCamp, {
    orders: 1,
    revenue: 1200,
    ticketsSold: 1,
  });
  assert.equal(summary.hourlyBreakdown[0].orders, 2);
  assert.equal(summary.hourlyBreakdown[0].revenue, 1500);
  assert.equal(summary.hourlyBreakdown[0].ticketsSold, 2);
});