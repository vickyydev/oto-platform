import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractMonthAggregate,
  mergeMonthAggregates,
  derivePlannerBaselines,
  deriveFutureMonthBaselines,
  buildLevers,
  evaluateScenario,
  computeOpportunityScore,
  buildRecommendedPlans,
  scenarioContextFromForecast,
  LEVER_IDS,
  type MonthAggregate,
  type PlannerBaselines,
  type ScenarioContext,
} from "./plannerModel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMonth(overrides: Partial<MonthAggregate> & { monthKey: string }): MonthAggregate {
  return {
    activeDays: 0,
    guests: 0,
    ticketRevenue: 0,
    fnbRevenue: 0,
    parties: 0,
    partyRevenue: 0,
    partiesLinked: (overrides.parties ?? 0) > 0,
    ...overrides,
  };
}

function makeBaselines(overrides: Partial<PlannerBaselines> = {}): PlannerBaselines {
  return {
    partiesSoFar: 5,
    partiesBaselineMonth: 10,
    avgPartyRevenue: 12000,
    visitorsPerDay: 100,
    ticketSpendPerGuest: 300,
    fnbSpendPerGuest: 150,
    monthlyPartyMax: 20,
    sampleDays: 20,
    usedFallbacks: false,
    partySource: "linked-events",
    partySampleEvents: 5,
    partySampleMonths: 1,
    warnings: [],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ScenarioContext> = {}): ScenarioContext {
  return {
    remainingEffDays: 10,
    baselines: makeBaselines(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractMonthAggregate
// ---------------------------------------------------------------------------

describe("extractMonthAggregate", () => {
  test("Floresta path: uses birthdayLinks party count and combined total", () => {
    const resp = {
      dailyRevenue: [{ revenue: 100 }, { revenue: 0 }, { revenue: 50 }, {}],
      guestBreakdown: { kidTickets: 200, estimatedTotalAdults: 150 },
      categoryBreakdown: {
        "Tickets & Packages": { revenue: 90000, quantity: 300 },
        "F&B": { revenue: 45000, quantity: 500 },
        "Events / Birthdays": { revenue: 30000, quantity: 3 },
      },
      birthdayLinks: { partyOrderCount: 4, combinedBirthdayTotal: 52000 },
    };
    const agg = extractMonthAggregate(resp, "2026-06");
    assert.equal(agg.monthKey, "2026-06");
    assert.equal(agg.activeDays, 2); // only days with revenue > 0
    assert.equal(agg.guests, 350);
    assert.equal(agg.ticketRevenue, 90000);
    assert.equal(agg.fnbRevenue, 45000);
    assert.equal(agg.parties, 4); // linked count wins over Events qty
    assert.equal(agg.partyRevenue, 52000); // linked total wins over Events revenue
    assert.equal(agg.partiesLinked, true);
  });

  test("task-163: NEVER counts Events line-item quantity as parties (Chalong / no links)", () => {
    // Papaya responses have no birthdayLinks; the Events category quantity
    // counts POS line items (cakes, corkage, decorations…), not events.
    const resp = {
      dailyRevenue: [{ revenue: 500 }],
      guestBreakdown: { kids: 80, adults: 40 },
      categoryBreakdown: {
        "Events / Birthdays": { revenue: 18000, quantity: 31 }, // 31 line items ≠ 31 parties
      },
    };
    const agg = extractMonthAggregate(resp, "2026-06");
    assert.equal(agg.guests, 120);
    assert.equal(agg.parties, 0); // unknown, NOT 31
    assert.equal(agg.partyRevenue, 0); // excluded so avg = revenue ÷ real events only
    assert.equal(agg.partiesLinked, false);
  });

  test("task-163: zero linked parties means no party data — count and revenue stay paired", () => {
    const resp = {
      categoryBreakdown: { "Events / Birthdays": { revenue: 9000, quantity: 1 } },
      birthdayLinks: { partyOrderCount: 0, combinedBirthdayTotal: 7000 },
    };
    const agg = extractMonthAggregate(resp, "2026-05");
    assert.equal(agg.parties, 0);
    assert.equal(agg.partyRevenue, 0); // never revenue without a matching event count
    assert.equal(agg.partiesLinked, false);
  });

  test("linked count > 0 with zero linked revenue falls back to Events revenue for the SAME events", () => {
    const resp = {
      categoryBreakdown: { "Events / Birthdays": { revenue: 26000, quantity: 9 } },
      birthdayLinks: { partyOrderCount: 2, combinedBirthdayTotal: 0 },
    };
    const agg = extractMonthAggregate(resp, "2026-04");
    assert.equal(agg.parties, 2);
    assert.equal(agg.partyRevenue, 26000);
    assert.equal(agg.partiesLinked, true);
  });

  test("empty / malformed response yields all zeros without throwing", () => {
    const agg = extractMonthAggregate(undefined, "2026-01");
    assert.deepEqual(agg, {
      monthKey: "2026-01",
      activeDays: 0,
      guests: 0,
      ticketRevenue: 0,
      fnbRevenue: 0,
      parties: 0,
      partyRevenue: 0,
      partiesLinked: false,
    });
    const agg2 = extractMonthAggregate({ dailyRevenue: "nope", guestBreakdown: null }, "2026-02");
    assert.equal(agg2.activeDays, 0);
    assert.equal(agg2.guests, 0);
  });

  test("prefers estimatedTotalAdults over adultTickets", () => {
    const agg = extractMonthAggregate(
      { guestBreakdown: { kidTickets: 10, estimatedTotalAdults: 7, adultTickets: 99 } },
      "2026-03",
    );
    assert.equal(agg.guests, 17);
  });
});

// ---------------------------------------------------------------------------
// derivePlannerBaselines
// ---------------------------------------------------------------------------

describe("derivePlannerBaselines", () => {
  test("healthy current month: uses only current month for guest/spend averages", () => {
    const months = [
      makeMonth({
        monthKey: "2026-07",
        activeDays: 20,
        guests: 2000,
        ticketRevenue: 600000,
        fnbRevenue: 300000,
        parties: 6,
        partyRevenue: 72000,
      }),
      makeMonth({
        monthKey: "2026-06",
        activeDays: 30,
        guests: 9000, // wildly different — should NOT be blended in
        ticketRevenue: 900000,
        fnbRevenue: 90000,
        parties: 12,
        partyRevenue: 120000,
      }),
    ];
    const b = derivePlannerBaselines(months, "2026-07", 20, 31);
    assert.equal(b.usedFallbacks, false);
    assert.equal(b.sampleDays, 20);
    assert.equal(b.visitorsPerDay, 100); // 2000 / 20
    assert.equal(b.ticketSpendPerGuest, 300); // 600000 / 2000
    assert.equal(b.fnbSpendPerGuest, 150); // 300000 / 2000
    assert.equal(b.partiesSoFar, 6);
    assert.equal(b.avgPartyRevenue, 12000); // 72000 / 6, current month only
    // pace: 6 + (6/20)*(31-20) = 6 + 3.3 = 9.3 → 9
    assert.equal(b.partiesBaselineMonth, 9);
    // history max = 12 (June), >= baseline
    assert.equal(b.monthlyPartyMax, 12);
  });

  test("thin current month (< 7 active days): widens to all months and flags fallback", () => {
    const months = [
      makeMonth({ monthKey: "2026-07", activeDays: 3, guests: 300, ticketRevenue: 60000, fnbRevenue: 30000 }),
      makeMonth({ monthKey: "2026-06", activeDays: 27, guests: 2700, ticketRevenue: 540000, fnbRevenue: 270000 }),
    ];
    const b = derivePlannerBaselines(months, "2026-07", 3, 31);
    assert.equal(b.usedFallbacks, true);
    assert.equal(b.sampleDays, 30); // 3 + 27
    assert.equal(b.visitorsPerDay, 100); // 3000 / 30
    assert.equal(b.ticketSpendPerGuest, 200); // 600000 / 3000
    assert.equal(b.fnbSpendPerGuest, 100); // 300000 / 3000
  });

  test("no usable history at all: zero averages, fallback party max floor of 4", () => {
    const b = derivePlannerBaselines([], "2026-07", 10, 31);
    assert.equal(b.visitorsPerDay, 0);
    assert.equal(b.ticketSpendPerGuest, 0);
    assert.equal(b.fnbSpendPerGuest, 0);
    assert.equal(b.partiesSoFar, 0);
    assert.equal(b.avgPartyRevenue, 0);
    assert.equal(b.partiesBaselineMonth, 0);
    assert.equal(b.monthlyPartyMax, 4); // max(4, 0*2)
    assert.equal(b.usedFallbacks, true);
  });

  test("no current-month parties: avg party revenue widens across all months", () => {
    const months = [
      makeMonth({ monthKey: "2026-07", activeDays: 10, guests: 1000, parties: 0, partyRevenue: 0 }),
      makeMonth({ monthKey: "2026-06", activeDays: 30, parties: 5, partyRevenue: 60000 }),
      makeMonth({ monthKey: "2026-05", activeDays: 31, parties: 5, partyRevenue: 40000 }),
    ];
    const b = derivePlannerBaselines(months, "2026-07", 10, 31);
    assert.equal(b.avgPartyRevenue, 10000); // 100000 / 10
    assert.equal(b.usedFallbacks, true);
  });

  test("party max is strictly observed history, never projected uplift", () => {
    const months = [
      makeMonth({ monthKey: "2026-07", activeDays: 10, guests: 1000, parties: 8, partyRevenue: 96000 }),
      makeMonth({ monthKey: "2026-06", activeDays: 30, parties: 3, partyRevenue: 36000 }),
    ];
    // pace: 8 + (8/10)*21 = 24.8 → 25 baseline, history max 3
    const b = derivePlannerBaselines(months, "2026-07", 10, 31);
    assert.equal(b.partiesBaselineMonth, 25);
    // baseline stays reachable: max is raised to the baseline, not beyond
    assert.equal(b.monthlyPartyMax, 25);
    assert.equal(b.usedFallbacks, false);
  });

  test("elapsedDays of 0 is clamped to 1 (no division by zero)", () => {
    const months = [makeMonth({ monthKey: "2026-07", activeDays: 10, guests: 500, parties: 2, partyRevenue: 20000 })];
    const b = derivePlannerBaselines(months, "2026-07", 0, 31);
    assert.ok(Number.isFinite(b.partiesBaselineMonth));
    // 2 + (2/1)*30 = 62
    assert.equal(b.partiesBaselineMonth, 62);
  });

  test("task-163 REGRESSION: combined-branch July no longer inflates to 49 parties @ ฿3,954", () => {
    // Reproduces the real production bug (2026-07-22, branch = All):
    // Floresta had 4 linked parties (฿101,182); Chalong had NO event links
    // but 31 Events line items (฿37,197). The old fallback counted those 31
    // items as parties → 35 so far → projected 49 for the month, and
    // ฿138,379 ÷ 35 = ฿3,954 “avg per party”. Real avg: ฿101,182 ÷ 4 ≈ ฿25k.
    const florestaJul = extractMonthAggregate(
      {
        dailyRevenue: Array.from({ length: 22 }, () => ({ revenue: 100000 })),
        birthdayLinks: { partyOrderCount: 4, combinedBirthdayTotal: 101182 },
        categoryBreakdown: { "Events / Birthdays": { revenue: 85983, quantity: 23.3 } },
      },
      "2026-07",
    );
    const chalongJul = extractMonthAggregate(
      {
        dailyRevenue: Array.from({ length: 21 }, () => ({ revenue: 20000 })),
        categoryBreakdown: { "Events / Birthdays": { revenue: 37197, quantity: 31 } },
      },
      "2026-07",
    );
    const merged = mergeMonthAggregates(florestaJul, chalongJul);
    assert.equal(merged.parties, 4); // NOT 35
    assert.equal(merged.partyRevenue, 101182); // Chalong's unlinked revenue excluded from per-party math

    const b = derivePlannerBaselines([merged], "2026-07", 22, 31);
    assert.equal(b.partiesSoFar, 4);
    assert.equal(b.partiesBaselineMonth, 6); // 4 + (4/22)*9 ≈ 5.6 → 6, matches the ops calendar
    assert.ok(Math.abs(b.avgPartyRevenue - 101182 / 4) < 1e-9); // ≈ ฿25,296, NOT ฿3,954
    assert.equal(b.partySource, "linked-events");
    assert.equal(b.warnings.length, 0);
  });

  test("task-163: party source metadata — current month sample", () => {
    const months = [
      makeMonth({ monthKey: "2026-07", activeDays: 20, guests: 2000, parties: 6, partyRevenue: 150000 }),
    ];
    const b = derivePlannerBaselines(months, "2026-07", 20, 31);
    assert.equal(b.partySource, "linked-events");
    assert.equal(b.partySampleEvents, 6);
    assert.equal(b.partySampleMonths, 1);
  });

  test("task-163: party source metadata — widened lookback counts events and months", () => {
    const months = [
      makeMonth({ monthKey: "2026-07", activeDays: 10, guests: 1000 }),
      makeMonth({ monthKey: "2026-06", activeDays: 30, parties: 5, partyRevenue: 130000 }),
      makeMonth({ monthKey: "2026-05", activeDays: 31, parties: 7, partyRevenue: 170000 }),
    ];
    const b = derivePlannerBaselines(months, "2026-07", 10, 31);
    assert.equal(b.partySource, "linked-events");
    assert.equal(b.partySampleEvents, 12);
    assert.equal(b.partySampleMonths, 2);
    assert.equal(b.avgPartyRevenue, 25000);
  });

  test("task-163: no linked events anywhere → partySource none, no fake counts", () => {
    const months = [
      makeMonth({ monthKey: "2026-07", activeDays: 15, guests: 1500, ticketRevenue: 450000 }),
      makeMonth({ monthKey: "2026-06", activeDays: 30, guests: 3000, ticketRevenue: 900000 }),
    ];
    const b = derivePlannerBaselines(months, "2026-07", 15, 31);
    assert.equal(b.partySource, "none");
    assert.equal(b.partiesSoFar, 0);
    assert.equal(b.partiesBaselineMonth, 0);
    assert.equal(b.avgPartyRevenue, 0);
  });

  test("task-163 sanity check: projected count far above observed history gets flagged", () => {
    const months = [
      // 10 parties in just 5 elapsed days → projected 62 for the month,
      // but history never saw more than 5 in a whole month.
      makeMonth({ monthKey: "2026-07", activeDays: 5, guests: 500, parties: 10, partyRevenue: 250000 }),
      makeMonth({ monthKey: "2026-06", activeDays: 30, parties: 5, partyRevenue: 125000 }),
    ];
    const b = derivePlannerBaselines(months, "2026-07", 5, 31);
    assert.equal(b.partiesBaselineMonth, 62);
    assert.equal(b.warnings.length, 1);
    assert.match(b.warnings[0], /far above the historical monthly maximum \(5\)/);
    // the slider bound itself still keeps the baseline reachable
    assert.ok(b.monthlyPartyMax >= b.partiesBaselineMonth);
  });

  test("task-163 sanity check: unrealistically low avg party revenue gets flagged", () => {
    const months = [
      makeMonth({ monthKey: "2026-07", activeDays: 20, guests: 2000, parties: 35, partyRevenue: 138379 }),
    ];
    const b = derivePlannerBaselines(months, "2026-07", 22, 31);
    assert.ok(b.avgPartyRevenue < 10000);
    assert.equal(b.warnings.length, 1);
    assert.match(b.warnings[0], /unrealistically low/);
  });
});

// ---------------------------------------------------------------------------
// buildLevers + evaluateScenario (per-lever impacts)
// ---------------------------------------------------------------------------

describe("evaluateScenario", () => {
  const baselines = makeBaselines(); // 100 v/day, ฿300 ticket, ฿150 F&B, 10 parties, ฿12k/party
  const ctx = makeCtx({ baselines, remainingEffDays: 10 });
  const levers = buildLevers(baselines);

  test("all levers at baseline: zero impact, projection = forecast", () => {
    const r = evaluateScenario(1000000, 1200000, levers, {}, ctx);
    assert.equal(r.totalImpact, 0);
    assert.equal(r.projectedRevenue, 1000000);
    assert.equal(r.gapAfter, 200000);
    assert.equal(r.targetAchieved, false);
    for (const l of r.perLever) assert.equal(l.impact, 0);
  });

  test("birthday lever: +2 parties = 2 × avgPartyRevenue (not day-scaled)", () => {
    const r = evaluateScenario(0, 0, levers, { [LEVER_IDS.birthdays]: 12 }, ctx);
    const bd = r.perLever.find((l) => l.leverId === LEVER_IDS.birthdays)!;
    assert.equal(bd.impact, 2 * 12000);
    assert.equal(r.totalImpact, 24000);
  });

  test("visitors lever: +10/day × remaining days × (ticket + F&B spend) — no double count", () => {
    const r = evaluateScenario(0, 0, levers, { [LEVER_IDS.visitors]: 110 }, ctx);
    const v = r.perLever.find((l) => l.leverId === LEVER_IDS.visitors)!;
    assert.equal(v.impact, 10 * 10 * (300 + 150)); // 45,000
  });

  test("ticket spend lever: +฿20/guest × visitors × remaining days", () => {
    const r = evaluateScenario(0, 0, levers, { [LEVER_IDS.ticketSpend]: 320 }, ctx);
    const t = r.perLever.find((l) => l.leverId === LEVER_IDS.ticketSpend)!;
    assert.equal(t.impact, 20 * 100 * 10); // 20,000
  });

  test("F&B spend lever: +฿30/guest × visitors × remaining days", () => {
    const r = evaluateScenario(0, 0, levers, { [LEVER_IDS.fnbSpend]: 180 }, ctx);
    const f = r.perLever.find((l) => l.leverId === LEVER_IDS.fnbSpend)!;
    assert.equal(f.impact, 30 * 100 * 10); // 30,000
  });

  test("combined levers sum additively and can achieve the target", () => {
    const planned = {
      [LEVER_IDS.birthdays]: 12, // +24,000
      [LEVER_IDS.visitors]: 110, // +45,000
      [LEVER_IDS.ticketSpend]: 320, // +20,000
      [LEVER_IDS.fnbSpend]: 180, // +30,000
    };
    const r = evaluateScenario(1000000, 1100000, levers, planned, ctx);
    assert.equal(r.totalImpact, 119000);
    assert.equal(r.projectedRevenue, 1119000);
    assert.equal(r.gapAfter, -19000); // negative = target exceeded
    assert.equal(r.targetAchieved, true);
  });

  test("negative lever moves reduce projection (below-baseline planning)", () => {
    const r = evaluateScenario(500000, 0, levers, { [LEVER_IDS.visitors]: 90 }, ctx);
    assert.equal(r.totalImpact, -45000);
    assert.equal(r.projectedRevenue, 455000);
  });

  test("no target (0): gapAfter is 0 and targetAchieved is false", () => {
    const r = evaluateScenario(500000, 0, levers, {}, ctx);
    assert.equal(r.gapAfter, 0);
    assert.equal(r.targetAchieved, false);
  });

  test("non-finite impact is coerced to 0", () => {
    const badLever = {
      ...levers[0],
      id: "bad",
      impact: () => NaN,
    };
    const r = evaluateScenario(100, 0, [badLever], { bad: 999 }, ctx);
    assert.equal(r.perLever[0].impact, 0);
    assert.equal(r.projectedRevenue, 100);
  });
});

describe("buildLevers ranges", () => {
  test("birthday lever min = parties already held, max = historical monthly max", () => {
    const b = makeBaselines({ partiesSoFar: 5, partiesBaselineMonth: 10, monthlyPartyMax: 20 });
    const bd = buildLevers(b).find((l) => l.id === LEVER_IDS.birthdays)!;
    assert.equal(bd.min, 5);
    assert.equal(bd.max, 20);
    assert.equal(bd.baseline, 10);
  });

  test("visitors ±30%, ticket ±20%, F&B ±30% around baselines", () => {
    const b = makeBaselines({ visitorsPerDay: 100, ticketSpendPerGuest: 300, fnbSpendPerGuest: 150 });
    const levers = buildLevers(b);
    const v = levers.find((l) => l.id === LEVER_IDS.visitors)!;
    assert.equal(v.min, 70);
    assert.equal(v.max, 130);
    const t = levers.find((l) => l.id === LEVER_IDS.ticketSpend)!;
    assert.equal(t.min, 240);
    assert.equal(t.max, 360);
    const f = levers.find((l) => l.id === LEVER_IDS.fnbSpend)!;
    assert.equal(f.min, 105);
    assert.equal(f.max, 195);
  });

  test("zero baselines produce non-negative ranges", () => {
    const b = makeBaselines({
      visitorsPerDay: 0,
      ticketSpendPerGuest: 0,
      fnbSpendPerGuest: 0,
      partiesSoFar: 0,
      partiesBaselineMonth: 0,
      monthlyPartyMax: 4,
    });
    for (const lv of buildLevers(b)) {
      assert.ok(lv.min >= 0, `${lv.id} min >= 0`);
      assert.ok(lv.max >= lv.min, `${lv.id} max >= min`);
    }
  });
});

// ---------------------------------------------------------------------------
// scenarioContextFromForecast
// ---------------------------------------------------------------------------

describe("scenarioContextFromForecast", () => {
  test("adds one effective day when today is partial", () => {
    const b = makeBaselines();
    assert.equal(
      scenarioContextFromForecast({ remainingDays: 9, todayIsPartial: true }, b).remainingEffDays,
      10,
    );
    assert.equal(
      scenarioContextFromForecast({ remainingDays: 9, todayIsPartial: false }, b).remainingEffDays,
      9,
    );
  });
});

// ---------------------------------------------------------------------------
// computeOpportunityScore
// ---------------------------------------------------------------------------

describe("computeOpportunityScore", () => {
  test("headroom = impact at max, shares sum to 100", () => {
    const baselines = makeBaselines();
    const ctx = makeCtx({ baselines, remainingEffDays: 10 });
    const entries = computeOpportunityScore(buildLevers(baselines), ctx);
    const byId = Object.fromEntries(entries.map((e) => [e.leverId, e]));
    assert.equal(byId[LEVER_IDS.birthdays].headroom, (20 - 10) * 12000); // 120,000
    assert.equal(byId[LEVER_IDS.visitors].headroom, 30 * 10 * 450); // 135,000
    assert.equal(byId[LEVER_IDS.ticketSpend].headroom, 60 * 100 * 10); // 60,000
    assert.equal(byId[LEVER_IDS.fnbSpend].headroom, 45 * 100 * 10); // 45,000
    const totalPct = entries.reduce((a, e) => a + e.sharePct, 0);
    assert.ok(Math.abs(totalPct - 100) < 1e-9);
  });

  test("all-zero headroom leaves shares at 0 (no NaN)", () => {
    const baselines = makeBaselines({
      avgPartyRevenue: 0,
      visitorsPerDay: 0,
      ticketSpendPerGuest: 0,
      fnbSpendPerGuest: 0,
      partiesSoFar: 0,
      partiesBaselineMonth: 0,
      monthlyPartyMax: 0,
    });
    const ctx = makeCtx({ baselines });
    const entries = computeOpportunityScore(buildLevers(baselines), ctx);
    for (const e of entries) {
      assert.equal(e.headroom, 0);
      assert.equal(e.sharePct, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// buildRecommendedPlans
// ---------------------------------------------------------------------------

describe("buildRecommendedPlans", () => {
  const baselines = makeBaselines(); // headrooms as in opportunity test
  const ctx = makeCtx({ baselines, remainingEffDays: 10 });
  const levers = buildLevers(baselines);

  test("three deterministic plans with expected fraction-of-headroom values", () => {
    const plans = buildRecommendedPlans(1000000, 1300000, levers, ctx);
    assert.deepEqual(plans.map((p) => p.id), ["conservative", "balanced", "growth"]);

    const growth = plans.find((p) => p.id === "growth")!;
    // f = 1.0 → every lever at max
    assert.equal(growth.values[LEVER_IDS.birthdays], 20);
    assert.equal(growth.values[LEVER_IDS.visitors], 130);
    assert.equal(growth.values[LEVER_IDS.ticketSpend], 360);
    assert.equal(growth.values[LEVER_IDS.fnbSpend], 195);
    // total headroom = 120k + 135k + 60k + 45k = 360k
    assert.equal(growth.projectedRevenue, 1360000);
    assert.equal(growth.reachesTarget, true);

    const balanced = plans.find((p) => p.id === "balanced")!;
    // f = 0.5: birthdays 15, visitors 115, ticket 330, fnb 172.5 → stepped to 175
    assert.equal(balanced.values[LEVER_IDS.birthdays], 15);
    assert.equal(balanced.values[LEVER_IDS.visitors], 115);
    assert.equal(balanced.values[LEVER_IDS.ticketSpend], 330);
    assert.equal(balanced.values[LEVER_IDS.fnbSpend], 175); // step-5 rounding of 172.5 (round half up)

    const conservative = plans.find((p) => p.id === "conservative")!;
    // f = 0.25: birthdays 12.5 → 13 (step 1), visitors 107.5 → 108,
    // ticket 315 (step 5), fnb 161.25 → 160
    assert.equal(conservative.values[LEVER_IDS.birthdays], 13);
    assert.equal(conservative.values[LEVER_IDS.visitors], 108);
    assert.equal(conservative.values[LEVER_IDS.ticketSpend], 315);
    assert.equal(conservative.values[LEVER_IDS.fnbSpend], 160);
    assert.equal(conservative.reachesTarget, false); // impact < 300k gap
  });

  test("pctOfTarget matches projection / target; zero target yields 0 pct", () => {
    const plans = buildRecommendedPlans(1000000, 1360000, levers, ctx);
    const growth = plans.find((p) => p.id === "growth")!;
    assert.ok(Math.abs(growth.pctOfTarget - 100) < 1e-9);
    const noTarget = buildRecommendedPlans(1000000, 0, levers, ctx);
    for (const p of noTarget) {
      assert.equal(p.pctOfTarget, 0);
      assert.equal(p.reachesTarget, false);
    }
  });

  test("plan values are always clamped inside each lever's [min, max]", () => {
    // Baseline pinned at max (baseline == max) → no headroom, values stay at baseline
    const b = makeBaselines({ partiesBaselineMonth: 20, monthlyPartyMax: 20 });
    const lv = buildLevers(b);
    const plans = buildRecommendedPlans(0, 0, lv, makeCtx({ baselines: b }));
    for (const p of plans) {
      for (const l of lv) {
        assert.ok(p.values[l.id] >= l.min, `${p.id}/${l.id} >= min`);
        assert.ok(p.values[l.id] <= l.max, `${p.id}/${l.id} <= max`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// deriveFutureMonthBaselines (task-162)
// ---------------------------------------------------------------------------

describe("deriveFutureMonthBaselines", () => {
  const LY_KEY = "2025-08";
  const lyMonth = makeMonth({
    monthKey: LY_KEY,
    activeDays: 31,
    guests: 3100, // 100 guests/day
    ticketRevenue: 620000, // ฿200/guest LY pricing
    fnbRevenue: 310000, // ฿100/guest LY pricing
    parties: 10,
    partyRevenue: 100000, // ฿10k/party LY pricing
  });
  const recent1 = makeMonth({
    monthKey: "2026-05",
    activeDays: 31,
    guests: 3720, // 120/day
    ticketRevenue: 1116000, // ฿300/guest current pricing
    fnbRevenue: 558000, // ฿150/guest
    parties: 12,
    partyRevenue: 144000, // ฿12k/party
  });
  const recent2 = makeMonth({
    monthKey: "2026-06",
    activeDays: 30,
    guests: 3600,
    ticketRevenue: 1080000,
    fnbRevenue: 540000,
    parties: 14,
    partyRevenue: 168000,
  });

  test("volumes from LY month growth-scaled; spends and party value from recent months", () => {
    const b = deriveFutureMonthBaselines([lyMonth, recent1, recent2], LY_KEY, 1.2);
    assert.equal(b.partiesSoFar, 0); // nothing has happened yet
    assert.ok(Math.abs(b.visitorsPerDay - 100 * 1.2) < 1e-9);
    assert.equal(b.partiesBaselineMonth, 12); // 10 × 1.2
    // Spends reflect current pricing, not LY's ฿200/฿100.
    assert.ok(Math.abs(b.ticketSpendPerGuest - 300) < 1e-9);
    assert.ok(Math.abs(b.fnbSpendPerGuest - 150) < 1e-9);
    assert.ok(Math.abs(b.avgPartyRevenue - 12000) < 1e-9);
    assert.equal(b.monthlyPartyMax, 14); // max across all months
    assert.equal(b.usedFallbacks, false);
  });

  test("null growth factor means LY volumes are used as-is", () => {
    const b = deriveFutureMonthBaselines([lyMonth, recent1], LY_KEY, null);
    assert.ok(Math.abs(b.visitorsPerDay - 100) < 1e-9);
    assert.equal(b.partiesBaselineMonth, 10);
  });

  test("missing LY month falls back to recent months and flags it", () => {
    const b = deriveFutureMonthBaselines([recent1, recent2], LY_KEY, 1.2);
    assert.ok(b.usedFallbacks);
    // visitors/day from combined recent months: (3720+3600)/(31+30)
    assert.ok(Math.abs(b.visitorsPerDay - 7320 / 61) < 1e-9);
    assert.equal(b.partiesBaselineMonth, 13); // avg(12, 14)
  });

  test("no recent spend data falls back to LY pricing and flags it", () => {
    const b = deriveFutureMonthBaselines([lyMonth], LY_KEY, 1.0);
    assert.ok(b.usedFallbacks);
    assert.ok(Math.abs(b.ticketSpendPerGuest - 200) < 1e-9);
    assert.ok(Math.abs(b.fnbSpendPerGuest - 100) < 1e-9);
    assert.ok(Math.abs(b.avgPartyRevenue - 10000) < 1e-9);
  });

  test("monthlyPartyMax never falls below the party baseline", () => {
    const bigLy = makeMonth({ ...lyMonth, parties: 30, partyRevenue: 300000 });
    const b = deriveFutureMonthBaselines([bigLy, recent1], LY_KEY, 1.8);
    assert.equal(b.partiesBaselineMonth, 54); // 30 × 1.8
    assert.ok(b.monthlyPartyMax >= b.partiesBaselineMonth);
  });

  test("TRAP 1 guard: a scenario left at baseline produces zero total impact", () => {
    const b = deriveFutureMonthBaselines([lyMonth, recent1, recent2], LY_KEY, 1.2);
    const levers = buildLevers(b);
    const planned = Object.fromEntries(levers.map((lv) => [lv.id, lv.baseline]));
    const ctx: ScenarioContext = { remainingEffDays: 31, baselines: b };
    const scenario = evaluateScenario(3720000, 4000000, levers, planned, ctx);
    assert.equal(scenario.totalImpact, 0);
    assert.equal(scenario.projectedRevenue, 3720000);
    for (const p of scenario.perLever) {
      assert.equal(p.impact, 0, `${p.leverId} impact should be 0 at baseline`);
    }
  });

  test("all-empty months yield finite zeros (no NaN) with fallback party max", () => {
    const b = deriveFutureMonthBaselines([makeMonth({ monthKey: "2026-05" })], LY_KEY, null);
    for (const [k, v] of Object.entries(b)) {
      if (typeof v === "number") {
        assert.ok(Number.isFinite(v), `${k} should be finite, got ${v}`);
      }
    }
    assert.equal(b.visitorsPerDay, 0);
    assert.ok(b.monthlyPartyMax >= 4);
  });
});
