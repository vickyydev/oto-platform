import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeSmartPaceForecast,
  computeFutureMonthBaseline,
  simplePaceModel,
  comparePaceToTarget,
  type SmartPaceInputs,
  type SmartPaceForecast,
  type FutureMonthBaselineInputs,
} from "./paceForecast";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function shiftDateStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dowOf(dateStr: string): number {
  return new Date(dateStr + "T12:00:00").getDay();
}

interface ScenarioOptions {
  todayStr?: string;
  year?: number;
  month?: number;
  daysInMonth?: number;
  revenue?: Record<string, number>;
  eventDays?: Set<string>;
  defaultRevenue?: (dateStr: string) => number | undefined;
}

function makeInputs(opts: ScenarioOptions = {}): SmartPaceInputs {
  const todayStr = opts.todayStr ?? "2026-07-22";
  const revenue = opts.revenue ?? {};
  const eventDays = opts.eventDays ?? new Set<string>();
  const defaultRevenue = opts.defaultRevenue;
  const known = new Set(Object.keys(revenue));
  return {
    year: opts.year ?? 2026,
    month: opts.month ?? 6,
    daysInMonth: opts.daysInMonth ?? 31,
    todayStr,
    getRevenue: (ds) => {
      if (ds in revenue) return revenue[ds];
      const v = defaultRevenue?.(ds);
      return v ?? 0;
    },
    hasData: (ds) => known.has(ds) || defaultRevenue?.(ds) !== undefined,
    isEventDay: (ds) => eventDays.has(ds),
  };
}

function assertAllFinite(f: SmartPaceForecast) {
  const nums = [
    f.forecastRevenue,
    f.avgDailyRevenue,
    f.remainingDays,
    f.projectedRemaining,
    f.revenueToDate,
    f.elapsedDays,
    f.daysInMonth,
  ];
  for (const n of nums) {
    assert.ok(Number.isFinite(n), `expected finite number, got ${n}`);
  }
  for (const p of f.perDay) {
    assert.ok(Number.isFinite(p.projected), `perDay ${p.date} projected not finite: ${p.projected}`);
  }
}

const TODAY = "2026-07-22";

/** Build history with full data: this-year history + weekday-aligned last-year data. */
function fullSignalRevenue(opts?: {
  tyDaily?: number;
  lyDaily?: number;
  eventDaily?: number;
}): { revenue: Record<string, number>; eventDays: Set<string> } {
  const tyDaily = opts?.tyDaily ?? 100000;
  const lyDaily = opts?.lyDaily ?? 80000;
  const eventDaily = opts?.eventDaily ?? 150000;
  const revenue: Record<string, number> = {};
  const eventDays = new Set<string>();

  // 56 days of this-year history before today; mark some as event days
  for (let i = 1; i <= 56; i++) {
    const ds = shiftDateStr(TODAY, -i);
    if (i % 10 === 0) {
      eventDays.add(ds);
      revenue[ds] = eventDaily;
    } else {
      revenue[ds] = tyDaily;
    }
  }
  // Last-year aligned data covering the growth window and future-day blends
  for (let i = -40; i <= 56; i++) {
    const ds = shiftDateStr(shiftDateStr(TODAY, -i), -364);
    revenue[ds] = lyDaily;
  }
  // This month's actuals for days 1..22 (some overlap with history above, that's fine)
  for (let d = 1; d <= 22; d++) {
    const ds = `2026-07-${pad2(d)}`;
    if (!(ds in revenue)) revenue[ds] = tyDaily;
  }
  return { revenue, eventDays };
}

describe("simplePaceModel", () => {
  test("basic run-rate projection", () => {
    const f = simplePaceModel({ revenueToDate: 100000, elapsedDays: 10, daysInMonth: 30 });
    assert.equal(f.avgDailyRevenue, 10000);
    assert.equal(f.remainingDays, 20);
    assert.equal(f.projectedRemaining, 200000);
    assert.equal(f.forecastRevenue, 300000);
    assert.equal(f.model, "simple-pace-v1");
  });

  test("zero elapsed days does not divide by zero", () => {
    const f = simplePaceModel({ revenueToDate: 0, elapsedDays: 0, daysInMonth: 30 });
    assert.ok(Number.isFinite(f.forecastRevenue));
    assert.ok(Number.isFinite(f.avgDailyRevenue));
    assert.equal(f.forecastRevenue, 0);
  });

  test("elapsed days beyond month is clamped", () => {
    const f = simplePaceModel({ revenueToDate: 310000, elapsedDays: 40, daysInMonth: 31 });
    assert.equal(f.remainingDays, 0);
    assert.equal(f.forecastRevenue, 310000);
  });
});

describe("comparePaceToTarget", () => {
  test("returns null for non-positive target", () => {
    assert.equal(comparePaceToTarget(100, 0), null);
    assert.equal(comparePaceToTarget(100, -5), null);
  });

  test("status boundaries at ±2%", () => {
    assert.equal(comparePaceToTarget(103, 100)!.status, "ahead");
    assert.equal(comparePaceToTarget(101.5, 100)!.status, "on-pace");
    assert.equal(comparePaceToTarget(98.5, 100)!.status, "on-pace");
    assert.equal(comparePaceToTarget(97.9, 100)!.status, "behind");
  });
});

describe("computeSmartPaceForecast — full-signal path", () => {
  test("uses all three signals with rich history", () => {
    const { revenue, eventDays } = fullSignalRevenue();
    const f = computeSmartPaceForecast(makeInputs({ revenue, eventDays }));
    assertAllFinite(f);
    assert.equal(f.model, "smart-pace-v2");
    assert.ok(f.signals.includes("Weekday Pattern"));
    assert.ok(f.signals.includes("LY Growth"));
    assert.ok(f.signals.includes("Holiday Adjustment"));
    assert.ok(f.forecastRevenue >= f.revenueToDate);
    assert.ok(f.perDay.length > 0);
  });

  test("perDay covers the remaining future days", () => {
    const { revenue, eventDays } = fullSignalRevenue();
    const f = computeSmartPaceForecast(makeInputs({ revenue, eventDays }));
    const futureDays = f.perDay.filter((p) => p.date > TODAY);
    assert.equal(futureDays.length, 31 - 22);
  });
});

describe("computeSmartPaceForecast — fallback levels", () => {
  test("no last-year data → drops LY Growth signal but stays smart", () => {
    const { revenue, eventDays } = fullSignalRevenue();
    // remove all last-year rows
    for (const k of Object.keys(revenue)) {
      if (k.startsWith("2025-")) delete revenue[k];
    }
    const f = computeSmartPaceForecast(makeInputs({ revenue, eventDays }));
    assertAllFinite(f);
    assert.equal(f.model, "smart-pace-v2");
    assert.ok(f.signals.includes("Weekday Pattern"));
    assert.ok(!f.signals.includes("LY Growth"));
  });

  test("thin history (<10 samples) → simple run-rate fallback", () => {
    const revenue: Record<string, number> = {};
    for (let d = 18; d <= 22; d++) revenue[`2026-07-${pad2(d)}`] = 50000;
    const f = computeSmartPaceForecast(makeInputs({ revenue }));
    assertAllFinite(f);
    assert.equal(f.model, "simple-pace-v1");
    assert.equal(f.signals.length, 0);
    assert.match(f.modelLabel, /Simple Run Rate/);
    assert.ok(f.forecastRevenue >= f.revenueToDate);
  });

  test("no holiday samples → no Holiday Adjustment signal", () => {
    const { revenue } = fullSignalRevenue();
    const f = computeSmartPaceForecast(makeInputs({ revenue, eventDays: new Set() }));
    assertAllFinite(f);
    assert.ok(!f.signals.includes("Holiday Adjustment"));
    assert.ok(f.signals.includes("Weekday Pattern"));
  });

  test("only one event sample → holiday factor not applied", () => {
    const { revenue } = fullSignalRevenue();
    const oneEvent = new Set([shiftDateStr(TODAY, -10)]);
    const f = computeSmartPaceForecast(makeInputs({ revenue, eventDays: oneEvent }));
    assertAllFinite(f);
    assert.ok(!f.signals.includes("Holiday Adjustment"));
  });
});

describe("computeSmartPaceForecast — edge cases", () => {
  test("zero-revenue month with no history is all zeros, never NaN", () => {
    const f = computeSmartPaceForecast(makeInputs({ revenue: {} }));
    assertAllFinite(f);
    assert.equal(f.revenueToDate, 0);
    assert.equal(f.forecastRevenue, 0);
    assert.equal(f.avgDailyRevenue, 0);
  });

  test("month fully in the past → nothing projected", () => {
    const revenue: Record<string, number> = {};
    for (let d = 1; d <= 30; d++) revenue[`2026-06-${pad2(d)}`] = 100000;
    const f = computeSmartPaceForecast(
      makeInputs({ todayStr: "2026-07-22", year: 2026, month: 5, daysInMonth: 30, revenue }),
    );
    assertAllFinite(f);
    assert.equal(f.remainingDays, 0);
    assert.equal(f.perDay.length, 0);
    assert.equal(f.projectedRemaining, 0);
    assert.equal(f.forecastRevenue, f.revenueToDate);
    assert.equal(f.forecastRevenue, 3000000);
  });

  test("last day of month → forecast equals revenue to date (full today)", () => {
    const revenue: Record<string, number> = {};
    for (let d = 1; d <= 31; d++) revenue[`2026-07-${pad2(d)}`] = 100000;
    for (let i = 1; i <= 56; i++) {
      const ds = shiftDateStr("2026-07-31", -i);
      if (!(ds in revenue)) revenue[ds] = 100000;
    }
    const f = computeSmartPaceForecast(makeInputs({ todayStr: "2026-07-31", revenue }));
    assertAllFinite(f);
    assert.equal(f.remainingDays, 0);
    assert.equal(f.todayIsPartial, false);
    assert.equal(f.forecastRevenue, f.revenueToDate);
  });

  test("negative or NaN revenue values are sanitized", () => {
    const { revenue, eventDays } = fullSignalRevenue();
    revenue["2026-07-05"] = -50000;
    revenue["2026-07-06"] = NaN as unknown as number;
    const f = computeSmartPaceForecast(makeInputs({ revenue, eventDays }));
    assertAllFinite(f);
    assert.ok(f.revenueToDate >= 0);
  });
});

describe("computeSmartPaceForecast — partial-today mitigation", () => {
  test("today far below expected → excluded from average and projected instead", () => {
    const { revenue, eventDays } = fullSignalRevenue();
    revenue[TODAY] = 5000; // ~5% of the ~100k expected → partial
    const f = computeSmartPaceForecast(makeInputs({ revenue, eventDays }));
    assertAllFinite(f);
    assert.equal(f.todayIsPartial, true);
    assert.equal(f.elapsedDays, 21); // day 22 excluded
    const todayProj = f.perDay.find((p) => p.date === TODAY);
    assert.ok(todayProj, "today should appear in perDay when partial");
    assert.ok(todayProj!.projected >= 5000, "projection never below what is already in");
    assert.match(f.explanation, /in progress/);
  });

  test("today at normal level → counted as a full day", () => {
    const { revenue, eventDays } = fullSignalRevenue();
    revenue[TODAY] = 100000;
    const f = computeSmartPaceForecast(makeInputs({ revenue, eventDays }));
    assertAllFinite(f);
    assert.equal(f.todayIsPartial, false);
    assert.equal(f.elapsedDays, 22);
    assert.equal(f.perDay.find((p) => p.date === TODAY), undefined);
  });

  test("partial today on day 1 with no history does not divide by zero", () => {
    const revenue: Record<string, number> = { "2026-07-01": 500 };
    const f = computeSmartPaceForecast(makeInputs({ todayStr: "2026-07-01", revenue }));
    assertAllFinite(f);
  });
});

describe("computeSmartPaceForecast — clamping boundaries", () => {
  function growthScenario(tyDaily: number, lyDaily: number): SmartPaceForecast {
    const { revenue, eventDays } = fullSignalRevenue({ tyDaily, lyDaily });
    return computeSmartPaceForecast(makeInputs({ revenue, eventDays }));
  }

  test("explosive YoY growth is clamped at ×1.8", () => {
    const f = growthScenario(1000000, 10000); // raw growth ≈ 100×
    assertAllFinite(f);
    assert.ok(f.signals.includes("LY Growth"));
    assert.match(f.explanation, /×1\.80/);
  });

  test("collapsing YoY is clamped at ×0.60", () => {
    const f = growthScenario(10000, 1000000); // raw growth ≈ 0.01
    assertAllFinite(f);
    assert.ok(f.signals.includes("LY Growth"));
    assert.match(f.explanation, /×0\.60/);
  });

  test("extreme holiday uplift is clamped at ×2.50", () => {
    const { revenue, eventDays } = fullSignalRevenue({ tyDaily: 10000, eventDaily: 10000000 });
    const f = computeSmartPaceForecast(makeInputs({ revenue, eventDays }));
    assertAllFinite(f);
    assert.ok(f.signals.includes("Holiday Adjustment"));
    assert.match(f.explanation, /×2\.50/);
  });

  test("holiday-quieter-than-normal is clamped at ×0.70", () => {
    const { revenue, eventDays } = fullSignalRevenue({ tyDaily: 100000, eventDaily: 1000 });
    const f = computeSmartPaceForecast(makeInputs({ revenue, eventDays }));
    assertAllFinite(f);
    assert.ok(f.signals.includes("Holiday Adjustment"));
    assert.match(f.explanation, /×0\.70/);
  });

  test("event-day projections apply the holiday factor", () => {
    const { revenue, eventDays } = fullSignalRevenue({ tyDaily: 100000, eventDaily: 200000 });
    // mark a future day as an event day
    eventDays.add("2026-07-28");
    const inputs = makeInputs({ revenue, eventDays });
    const f = computeSmartPaceForecast(inputs);
    assertAllFinite(f);
    const eventDay = f.perDay.find((p) => p.date === "2026-07-28");
    const normalSameDow = f.perDay.find(
      (p) => p.date !== "2026-07-28" && !p.isEventDay && dowOf(p.date) === dowOf("2026-07-28"),
    );
    assert.ok(eventDay?.isEventDay);
    if (normalSameDow) {
      assert.ok(eventDay!.projected > normalSameDow.projected);
    }
  });
});

// ---------------------------------------------------------------------------
// computeFutureMonthBaseline (task-162)
// ---------------------------------------------------------------------------

describe("computeFutureMonthBaseline", () => {
  // Planning August 2026 (31 days) on July 22, 2026.
  function makeFutureInputs(opts: {
    revenue?: Record<string, number>;
    defaultRevenue?: (ds: string) => number | undefined;
    fallbackRevenue?: number;
    year?: number;
    month?: number;
    daysInMonth?: number;
  } = {}): FutureMonthBaselineInputs {
    const revenue = opts.revenue ?? {};
    const known = new Set(Object.keys(revenue));
    return {
      year: opts.year ?? 2026,
      month: opts.month ?? 7, // August
      daysInMonth: opts.daysInMonth ?? 31,
      todayStr: TODAY,
      getRevenue: (ds) => (ds in revenue ? revenue[ds] : opts.defaultRevenue?.(ds) ?? 0),
      hasData: (ds) => known.has(ds) || opts.defaultRevenue?.(ds) !== undefined,
      fallbackRevenue: opts.fallbackRevenue,
    };
  }

  /** 2026 days earn tyDaily, 2025 days earn lyDaily (full coverage). */
  const yearSplit = (tyDaily: number, lyDaily: number) => (ds: string) =>
    ds.startsWith("2026-") ? tyDaily : ds.startsWith("2025-") ? lyDaily : undefined;

  test("LY month + growth trend: forecast = LY August total × growth", () => {
    const f = computeFutureMonthBaseline(
      makeFutureInputs({ defaultRevenue: yearSplit(120000, 100000) }),
    );
    assert.equal(f.baselineSource, "ly-growth");
    assert.equal(f.lySameMonthRevenue, 31 * 100000);
    assert.ok(f.growthFactor !== null);
    assert.ok(Math.abs(f.growthFactor! - 1.2) < 1e-9);
    assert.ok(Math.abs(f.forecastRevenue - 31 * 100000 * 1.2) < 1e-6);
    // Synthetic pace shape: nothing earned yet, whole month remaining.
    assert.equal(f.revenueToDate, 0);
    assert.equal(f.elapsedDays, 0);
    assert.equal(f.remainingDays, 31);
    assert.equal(f.todayIsPartial, false);
    assert.deepEqual(f.perDay, []);
    assert.ok(Math.abs(f.avgDailyRevenue - f.forecastRevenue / 31) < 1e-9);
    assert.match(f.explanation, /×1\.20/);
    assert.ok(Number.isFinite(f.forecastRevenue));
  });

  test("explosive growth clamps at ×1.80 and collapse clamps at ×0.60", () => {
    const up = computeFutureMonthBaseline(
      makeFutureInputs({ defaultRevenue: yearSplit(1000000, 10000) }),
    );
    assert.equal(up.growthFactor, 1.8);
    const down = computeFutureMonthBaseline(
      makeFutureInputs({ defaultRevenue: yearSplit(10000, 1000000) }),
    );
    assert.equal(down.growthFactor, 0.6);
  });

  test("partial LY coverage ≥20 days is normalised to the full month", () => {
    // Only 20 days of August 2025 recorded at 100k/day; no growth pairs.
    const revenue: Record<string, number> = {};
    for (let d = 1; d <= 20; d++) {
      revenue[`2025-08-${String(d).padStart(2, "0")}`] = 100000;
    }
    const f = computeFutureMonthBaseline(makeFutureInputs({ revenue }));
    assert.equal(f.baselineSource, "ly-growth");
    assert.equal(f.growthFactor, null); // no paired TY/LY history
    assert.ok(Math.abs(f.lySameMonthRevenue - 31 * 100000) < 1e-6);
    assert.ok(Math.abs(f.forecastRevenue - 31 * 100000) < 1e-6);
    assert.match(f.explanation, /as-is/);
  });

  test("LY coverage below 20 days falls back to the recent daily average", () => {
    const revenue: Record<string, number> = {};
    // Thin LY August: 10 days only.
    for (let d = 1; d <= 10; d++) {
      revenue[`2025-08-${String(d).padStart(2, "0")}`] = 100000;
    }
    // Recent history: 30 days before today at 150k.
    for (let i = 1; i <= 30; i++) {
      revenue[shiftDateStr(TODAY, -i)] = 150000;
    }
    const f = computeFutureMonthBaseline(makeFutureInputs({ revenue }));
    assert.equal(f.baselineSource, "recent-average");
    assert.ok(Math.abs(f.forecastRevenue - 150000 * 31) < 1e-6);
    assert.equal(f.lySameMonthRevenue, 0);
  });

  test("no usable history at all → caller fallback, never NaN", () => {
    const f = computeFutureMonthBaseline(makeFutureInputs({ fallbackRevenue: 2500000 }));
    assert.equal(f.baselineSource, "fallback");
    assert.equal(f.forecastRevenue, 2500000);
    assert.ok(Number.isFinite(f.avgDailyRevenue));
    const empty = computeFutureMonthBaseline(makeFutureInputs({}));
    assert.equal(empty.forecastRevenue, 0);
    assert.ok(Number.isFinite(empty.forecastRevenue));
    assert.ok(Number.isFinite(empty.avgDailyRevenue));
  });
});
