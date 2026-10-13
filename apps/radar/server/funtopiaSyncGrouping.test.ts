import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSyncDateRange,
  groupOrdersByReportDate,
  groupSyncDatesIntoChunks,
} from "./funtopia";

describe("Funtopia sync date range validation", () => {
  it("accepts real ascending dates and rejects malformed ranges", () => {
    assert.deepEqual(buildSyncDateRange("2026-02-27", "2026-03-01"), [
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
    ]);
    assert.throws(
      () => buildSyncDateRange("2026-02-30", "2026-03-01"),
      /startDate must be a valid date/,
    );
    assert.throws(
      () => buildSyncDateRange("2026-03-02", "2026-03-01"),
      /startDate must be on or before endDate/,
    );
    assert.throws(
      () => buildSyncDateRange("2026-01-01", "2027-01-03"),
      /must not exceed 366 days/,
    );
  });
});

describe("Funtopia sync report-date grouping", () => {
  it("uses one-date chunks for exact report-date sync", () => {
    const dates = ["2026-08-03", "2026-08-02", "2026-08-01"];

    assert.deepEqual(groupSyncDatesIntoChunks(dates, 1), [
      ["2026-08-03"],
      ["2026-08-02"],
      ["2026-08-01"],
    ]);
    assert.deepEqual(groupSyncDatesIntoChunks(dates), [
      ["2026-08-03", "2026-08-02", "2026-08-01"],
    ]);
  });

  it("assigns every row to the requested date without using created_at", () => {
    const orders = [
      { order_id: "outside-a", created_at: "01/Aug/2026 23:59:59" },
      { order_id: "outside-b", created_at: "04/Aug/2026 00:00:00" },
    ];

    const grouped = groupOrdersByReportDate(orders, ["2026-08-02"], true);

    assert.deepEqual(grouped["2026-08-02"], orders);
  });
});