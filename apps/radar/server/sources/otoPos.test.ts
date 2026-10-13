import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarDaysOf,
  dashboardRangeOf,
  mapBranches,
  readSummary,
  spinReportOf,
  type Summary,
  type SummaryRow,
} from "./otoPos";

function row(over: Partial<SummaryRow>): SummaryRow {
  return {
    businessDate: "2026-10-01",
    ticketsSatang: 0, fnbSatang: 0, merchSatang: 0, partiesSatang: 0, dropoffSatang: 0, revenueSatang: 0,
    txnCount: 0, creditPaidSatang: 0, guestsKids: 0, guestsAdults: 0, mix1h: 0, mix2h: 0, mixFullDay: 0,
    partiesCount: 0, refundsSatang: 0, discountsSatang: 0, compsSatang: 0, vatSatang: 0, serviceSatang: 0,
    byChannel: {}, provisional: false, rolledDays: 1, computedAt: "2026-10-01T10:00:00Z", formulaVersion: 1,
    ...over,
  };
}

function summary(rows: SummaryRow[], over: Partial<Summary> = {}): Summary {
  return {
    from: "2026-10-01", to: "2026-10-02", group: "day", source: "oto_pos",
    branches: [], omitted: [], readable: [], mergeable: [], merged: rows, hours: null,
    lastRolledUpAt: "2026-10-02T09:15:00Z",
    ...over,
  };
}

test("Radar's park keys map onto the platform branches by the mall's name", () => {
  const map = mapBranches([
    { branchId: "b1", name: "Oto Play Park, Central Floresta" },
    { branchId: "b2", name: "Oto Play Park, Robinson Chalong" },
  ]);
  assert.equal(map.get("floresta")?.branchId, "b1");
  assert.equal(map.get("chalong")?.branchId, "b2");
  assert.equal(mapBranches([{ branchId: "b1", name: "Somewhere else" }]).size, 0);
});

test("a range becomes the dashboard's shape in baht, with its provenance", () => {
  const out = dashboardRangeOf(
    summary([
      row({ businessDate: "2026-10-01", ticketsSatang: 100_000, fnbSatang: 50_050, revenueSatang: 150_050, txnCount: 3, guestsKids: 2, guestsAdults: 1, mix2h: 2 }),
      row({ businessDate: "2026-10-02", partiesSatang: 200_000, revenueSatang: 200_000, txnCount: 1, partiesCount: 1, provisional: true, byChannel: { "Sales Booth": { revenue: 10_000, txn_count: 1 } } }),
    ]),
  );
  assert.equal(out.totalRevenue, 3500.5);
  assert.equal(out.totalOrders, 4);
  assert.equal(out.avgOrderValue, 875);
  assert.deepEqual(Object.keys(out.categoryBreakdown).sort(), ["Events / Birthdays", "F&B", "Tickets & Packages"]);
  assert.equal(out.categoryBreakdown["Tickets & Packages"]!.quantity, 3);
  assert.equal(out.guestBreakdown?.totalInPark, 3);
  assert.equal(out.dailyRevenue.length, 2);
  assert.equal(out.dailyRevenue[1]!.revenue, 2000);
  assert.deepEqual(out.sourceBreakdown.map((s) => [s.source, s.revenue]), [["Sales Booth", 100]]);
  assert.deepEqual(out.figures, { source: "oto_pos", formulaVersion: 1, provisional: true, lastRolledUpAt: "2026-10-02T09:15:00Z" });
  assert.deepEqual(out.paymentBreakdown, {});
});

test("one day carries its hours; the calendar is revenue and orders per day", () => {
  const one = dashboardRangeOf(
    summary([row({ revenueSatang: 1000, txnCount: 1 })], {
      from: "2026-10-01", to: "2026-10-01",
      hours: [{ hour: 9, ticketsSatang: 1000, fnbSatang: 0, merchSatang: 0, partiesSatang: 0, dropoffSatang: 0, revenueSatang: 1000, txnCount: 1, guests: 2 }],
    }),
  );
  assert.deepEqual(one.hourlyBreakdown, [{ hour: 9, label: "09:00", orders: 1, revenue: 10, ticketsSold: 2 }]);
  assert.deepEqual(calendarDaysOf(summary([row({ revenueSatang: 1234, txnCount: 2 })])), [
    { date: "2026-10-01", revenue: 12.34, orders: 2 },
  ]);
});

test("the booth report folds into the Spin Wheel report per prize", () => {
  const funnel = { spins: 0, redemptionRate: null, meanRedemptionLagS: null, prizeCostSatang: 0, prizeCostIncomplete: false };
  const out = spinReportOf({
    booths: [],
    days: [],
    lastRolledUpAt: null,
    prizes: [
      { ...funnel, boothId: "a", prizeId: "p1", name: "Pizza", prizesWon: 3, vouchersIssued: 3, vouchersRedeemed: 1 },
      { ...funnel, boothId: "b", prizeId: "p1", name: "Pizza", prizesWon: 2, vouchersIssued: 2, vouchersRedeemed: 2 },
    ],
  });
  assert.deepEqual(out.rewards.map((r) => [r.prizeId, r.won, r.redeemed, r.outstanding]), [["p1", 5, 3, 2]]);
  assert.equal(out.capacity, null);
});

test("reads forward the person's own session and split a long range into the platform's windows", async () => {
  process.env.PLATFORM_API_URL = "http://platform.test";
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    assert.equal(init?.headers?.cookie, "oto_session=tok-1");
    const u = new URL(url);
    calls.push(`${u.searchParams.get("from")}..${u.searchParams.get("to")}:${u.searchParams.get("branches") ?? "-"}`);
    if (!u.searchParams.get("branches")) {
      return Response.json(summary([], { readable: [{ branchId: "b1", name: "Central Floresta" }] }));
    }
    const from = u.searchParams.get("from")!;
    return Response.json(
      summary([row({ businessDate: from, revenueSatang: 100 })], {
        branches: [{ branchId: "b1", name: "Central Floresta", source: "oto_pos", timezone: "Asia/Bangkok", businessDayStart: "06:00", today: from, lastRolledUpAt: null, rows: [] }],
      }),
    );
  }) as typeof fetch;
  try {
    const s = await readSummary("tok-1", ["floresta"], "2025-01-01", "2026-06-30", "day");
    assert.deepEqual(calls.slice(1), ["2025-01-01..2026-01-01:b1", "2026-01-02..2026-06-30:b1"]);
    assert.equal(s.merged.length, 2);
    await assert.rejects(readSummary("tok-1", ["chalong"], "2026-01-01", "2026-01-02", "day"), /cannot read Chalong/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
