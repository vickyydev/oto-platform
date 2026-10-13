import assert from "node:assert/strict";
import test from "node:test";

import {
  excludeSummerCamp,
  excludeWeekends,
  fillActivityDateRange,
  getActivityBranchStatus,
  getActivityHourlyTotals,
  mergeActivityDays,
  mergeActivityHours,
} from "./activityHeatmap";

test("merges both branches by matching date and hour", () => {
  const merged = mergeActivityDays(
    [{
      date: "2026-09-08",
      hourlyBreakdown: [
        { hour: 10, label: "10:00", orders: 2, revenue: 500, ticketsSold: 3 },
      ],
    }],
    [{
      date: "2026-09-08",
      hourlyBreakdown: [
        {
          hour: 10,
          label: "10:00",
          orders: 4,
          revenue: 1200,
          ticketsSold: 5,
          summerCamp: { orders: 1, revenue: 300, ticketsSold: 2 },
        },
        { hour: 11, label: "11:00", orders: 1, revenue: 200, ticketsSold: 1 },
      ],
    }],
  );

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].hourlyBreakdown, [
    {
      hour: 10,
      label: "10:00",
      orders: 6,
      revenue: 1700,
      ticketsSold: 8,
      summerCamp: { orders: 1, revenue: 300, ticketsSold: 2 },
    },
    { hour: 11, label: "11:00", orders: 1, revenue: 200, ticketsSold: 1 },
  ]);
});

test("preserves separate dates in week, month, and custom-range data", () => {
  const merged = mergeActivityDays(
    [{ date: "2026-09-07", hourlyBreakdown: [] }],
    [{ date: "2026-09-09", hourlyBreakdown: [] }],
  );
  assert.deepEqual(merged.map((day) => day.date), ["2026-09-07", "2026-09-09"]);
});

test("Summer Camp exclusion updates Orders, Revenue, and Tickets together", () => {
  const filtered = excludeSummerCamp([{
    date: "2026-09-09",
    hourlyBreakdown: [{
      hour: 10,
      label: "10:00",
      orders: 8,
      revenue: 13260,
      ticketsSold: 11,
      summerCamp: { orders: 6, revenue: 13200, ticketsSold: 10 },
    }],
  }]);

  assert.deepEqual(filtered[0].hourlyBreakdown?.[0], {
    hour: 10,
    label: "10:00",
    orders: 2,
    revenue: 60,
    ticketsSold: 1,
    summerCamp: { orders: 6, revenue: 13200, ticketsSold: 10 },
  });
});

test("single-day hourly merge also preserves tickets and Camp subtotals", () => {
  const merged = mergeActivityHours(
    [{ hour: 9, label: "09:00", orders: 2, revenue: 100, ticketsSold: 2 }],
    [{
      hour: 9,
      label: "09:00",
      orders: 3,
      revenue: 400,
      ticketsSold: 4,
      summerCamp: { orders: 1, revenue: 200, ticketsSold: 2 },
    }],
  );
  assert.deepEqual(merged[0], {
    hour: 9,
    label: "09:00",
    orders: 5,
    revenue: 500,
    ticketsSold: 6,
    summerCamp: { orders: 1, revenue: 200, ticketsSold: 2 },
  });
});

test("branch status copy covers Floresta, Chalong, and combined views", () => {
  assert.equal(getActivityBranchStatus(true, false), "You are checking Floresta now");
  assert.equal(getActivityBranchStatus(false, true), "You are checking Chalong now");
  assert.equal(
    getActivityBranchStatus(true, true),
    "You are checking Chalong and Floresta combined",
  );
});

test("calculates Orders, Revenue, and Tickets totals for each visible hour", () => {
  const days = [
    {
      date: "2026-09-08",
      hourlyBreakdown: [
        { hour: 9, label: "09:00", orders: 2, revenue: 500, ticketsSold: 3 },
        { hour: 10, label: "10:00", orders: 1, revenue: 250, ticketsSold: 2 },
      ],
    },
    {
      date: "2026-09-09",
      hourlyBreakdown: [
        { hour: 9, label: "09:00", orders: 4, revenue: 1200, ticketsSold: 5 },
      ],
    },
  ];

  assert.deepEqual(getActivityHourlyTotals(days, "orders", [9, 10, 11]), { 9: 6, 10: 1, 11: 0 });
  assert.deepEqual(getActivityHourlyTotals(days, "revenue", [9, 10, 11]), { 9: 1700, 10: 250, 11: 0 });
  assert.deepEqual(getActivityHourlyTotals(days, "ticketsSold", [9, 10, 11]), { 9: 8, 10: 2, 11: 0 });
});

test("combined totals sum current and comparison rows, including missing hours", () => {
  const current = [{
    date: "2026-09-09",
    hourlyBreakdown: [{ hour: 9, label: "09:00", orders: 2, revenue: 100, ticketsSold: 1 }],
  }];
  const comparison = [{
    date: "2026-09-02",
    hourlyBreakdown: [{ hour: 10, label: "10:00", orders: 3, revenue: 200, ticketsSold: 4 }],
  }];

  assert.deepEqual(
    getActivityHourlyTotals([...current, ...comparison], "orders", [9, 10, 11]),
    { 9: 2, 10: 3, 11: 0 },
  );
});

test("totals use already-filtered Summer Camp values", () => {
  const filtered = excludeSummerCamp([{
    date: "2026-09-09",
    hourlyBreakdown: [{
      hour: 10,
      label: "10:00",
      orders: 8,
      revenue: 13260,
      ticketsSold: 11,
      summerCamp: { orders: 6, revenue: 13200, ticketsSold: 10 },
    }],
  }]);

  assert.deepEqual(getActivityHourlyTotals(filtered, "orders", [10]), { 10: 2 });
  assert.deepEqual(getActivityHourlyTotals(filtered, "revenue", [10]), { 10: 60 });
  assert.deepEqual(getActivityHourlyTotals(filtered, "ticketsSold", [10]), { 10: 1 });
});

test("weekend exclusion removes Saturday and Sunday while preserving weekdays", () => {
  const filtered = excludeWeekends([
    { date: "2026-09-04", dayOfWeek: "Friday", hourlyBreakdown: [] },
    { date: "2026-09-05", dayOfWeek: "Saturday", hourlyBreakdown: [] },
    { date: "2026-09-06", dayOfWeek: "Sunday", hourlyBreakdown: [] },
    { date: "2026-09-07", dayOfWeek: "Monday", hourlyBreakdown: [] },
  ]);

  assert.deepEqual(filtered.map((day) => day.date), ["2026-09-04", "2026-09-07"]);
});

test("weekend exclusion preserves rows whose date cannot be classified safely", () => {
  const unknown = { date: "", dayOfWeek: "Saturday", hourlyBreakdown: [] };
  assert.deepEqual(excludeWeekends([unknown]), [unknown]);
});

test("fills omitted activity dates with the correct calendar weekday", () => {
  const filled = fillActivityDateRange(
    [{
      date: "2026-08-11",
      hourlyBreakdown: [
        { hour: 10, label: "10:00", orders: 1, revenue: 500, ticketsSold: 2 },
      ],
    }],
    "2026-08-08",
    "2026-08-11",
  );

  assert.deepEqual(
    filled.map((day) => [day.date, day.dayOfWeek, day.hourlyBreakdown?.length]),
    [
      ["2026-08-08", "Saturday", 0],
      ["2026-08-09", "Sunday", 0],
      ["2026-08-10", "Monday", 0],
      ["2026-08-11", undefined, 1],
    ],
  );
});

test("excluding weekends after filling a range removes only Saturday and Sunday", () => {
  const weekdays = excludeWeekends(fillActivityDateRange([], "2026-08-08", "2026-08-14"));
  assert.deepEqual(
    weekdays.map((day) => `${day.dayOfWeek} ${day.date}`),
    [
      "Monday 2026-08-10",
      "Tuesday 2026-08-11",
      "Wednesday 2026-08-12",
      "Thursday 2026-08-13",
      "Friday 2026-08-14",
    ],
  );
});