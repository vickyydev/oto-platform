// Revenue Planner — action-based lever model & scenario math (task-160)
// ----------------------------------------------------------------------
// Purely presentation-layer: consumes the existing computeSmartPaceForecast
// output and cached range summaries as-is. No revenue formula changes.
//
// Each lever is a configuration object; the Planner UI renders levers
// dynamically from this model. Future actions (promotions, school visits,
// corporate events, memberships, …) are added by defining a new lever
// config here — not by redesigning the Planner.

import type { SmartPaceForecast } from "./paceForecast";

// ---------------------------------------------------------------------------
// Baselines derived from real historical data (per-month range aggregates)
// ---------------------------------------------------------------------------

/** One month's worth of aggregates extracted from a /api/funtopia/range or
 *  /api/papaya/range response fetched with month-scoped start/end dates. */
export interface MonthAggregate {
  monthKey: string; // "YYYY-MM"
  /** Days with revenue > 0 inside the fetched window. */
  activeDays: number;
  /** Total guests (kids + estimated adults). */
  guests: number;
  ticketRevenue: number;
  fnbRevenue: number;
  /** Birthday parties — REAL linked events only (one booking = one party). */
  parties: number;
  /** Cash revenue attributed to those linked parties. */
  partyRevenue: number;
  /** True when `parties` comes from real linked birthday events. */
  partiesLinked: boolean;
}

const TICKET_CATEGORY = "Tickets & Packages";
const FNB_CATEGORY = "F&B";
const EVENTS_CATEGORY = "Events / Birthdays";

/** Extract a MonthAggregate from a raw range response (either branch). */
export function extractMonthAggregate(resp: any, monthKey: string): MonthAggregate {
  const daily: Array<{ revenue?: number }> = Array.isArray(resp?.dailyRevenue) ? resp.dailyRevenue : [];
  const activeDays = daily.filter((d) => (d?.revenue || 0) > 0).length;

  const gb = resp?.guestBreakdown || {};
  const kids = Number(gb.kidTickets ?? gb.kids ?? 0) || 0;
  const adults = Number(gb.estimatedTotalAdults ?? gb.adultTickets ?? gb.adults ?? 0) || 0;

  const cb = resp?.categoryBreakdown || {};
  const ticketRevenue = Number(cb[TICKET_CATEGORY]?.revenue || 0) || 0;
  const fnbRevenue = Number(cb[FNB_CATEGORY]?.revenue || 0) || 0;

  const bl = resp?.birthdayLinks;
  const linkedParties = Number(bl?.partyOrderCount || 0) || 0;
  const linkedPartyRev = Number(bl?.combinedBirthdayTotal || 0) || 0;
  const eventsRev = Number(cb[EVENTS_CATEGORY]?.revenue || 0) || 0;

  // Party counts (task-163): ONE linked birthday event = ONE party. The
  // Events category `quantity` counts POS line items (cakes, corkage,
  // packages, decorations…), so a single party can register 5+ "quantity"
  // — using it as a party count inflated the planner (e.g. 49 "parties"
  // at ฿3,954 avg vs the real ~6 events at ~฿25k). Sources without linked
  // events (Chalong/Papaya) report parties = 0 rather than a fake count,
  // and their party revenue is excluded from per-party averages so the
  // count and revenue always describe the same set of events.
  const partiesLinked = linkedParties > 0;
  const parties = partiesLinked ? linkedParties : 0;
  const partyRevenue = partiesLinked ? (linkedPartyRev > 0 ? linkedPartyRev : eventsRev) : 0;

  return { monthKey, activeDays, guests: kids + adults, ticketRevenue, fnbRevenue, parties, partyRevenue, partiesLinked };
}

/** Merge two per-branch MonthAggregates for the same month into a combined
 *  (all-branches) aggregate. Revenue/guest/party figures sum; activeDays is
 *  the max of the two (the branches share the same calendar days, so summing
 *  would double-count days and halve the per-day averages). */
export function mergeMonthAggregates(a: MonthAggregate, b: MonthAggregate): MonthAggregate {
  return {
    monthKey: a.monthKey,
    activeDays: Math.max(a.activeDays, b.activeDays),
    guests: a.guests + b.guests,
    ticketRevenue: a.ticketRevenue + b.ticketRevenue,
    fnbRevenue: a.fnbRevenue + b.fnbRevenue,
    parties: a.parties + b.parties,
    partyRevenue: a.partyRevenue + b.partyRevenue,
    partiesLinked: a.partiesLinked || b.partiesLinked,
  };
}

export interface PlannerBaselines {
  /** Birthday parties held so far this month. */
  partiesSoFar: number;
  /** Projected full-month party count at the current pace (the lever baseline). */
  partiesBaselineMonth: number;
  /** Average cash revenue per party (this month, widened lookback fallback). */
  avgPartyRevenue: number;
  /** Average daily guests (kids + adults) across counted days. */
  visitorsPerDay: number;
  /** Average ticket revenue per guest. */
  ticketSpendPerGuest: number;
  /** Average F&B revenue per guest. */
  fnbSpendPerGuest: number;
  /** Historical monthly party maximum (slider upper bound anchor). */
  monthlyPartyMax: number;
  /** Days with usable guest data that fed the averages. */
  sampleDays: number;
  /** True when history was too thin and simple fallbacks were used. */
  usedFallbacks: boolean;
  /** Where the party figures come from (task-163 — shown in the UI). */
  partySource: "linked-events" | "none";
  /** Total linked events + months behind the avg-per-party figure. */
  partySampleEvents: number;
  partySampleMonths: number;
  /** Sanity-check warnings (task-163): unrealistic assumptions get flagged. */
  warnings: string[];
}

/** Sanity checks (task-163): flag assumptions that violate realistic business
 *  limits instead of silently displaying them.
 *  @param observedPartyMax Raw historical monthly party maximum BEFORE any
 *  fallback/clamping (0 when there is no usable history) — the clamped
 *  `monthlyPartyMax` is always ≥ the baseline, so it can never trip the check. */
function sanityCheckBaselines(b: PlannerBaselines, observedPartyMax: number): PlannerBaselines {
  const warnings: string[] = [];
  const MIN_REALISTIC_PARTY_REVENUE = 10000; // a real party incl. F&B is ฿25k+
  if (b.avgPartyRevenue > 0 && b.avgPartyRevenue < MIN_REALISTIC_PARTY_REVENUE) {
    warnings.push(
      `Average party revenue (฿${Math.round(b.avgPartyRevenue).toLocaleString()}) is unrealistically low — party data may be miscounted.`,
    );
  }
  if (b.partiesBaselineMonth > 0 && observedPartyMax > 0 && b.partiesBaselineMonth > observedPartyMax * 3) {
    warnings.push(
      `Projected party count (${b.partiesBaselineMonth}) is far above the historical monthly maximum (${observedPartyMax}).`,
    );
  }
  return warnings.length > 0 ? { ...b, warnings: [...b.warnings, ...warnings] } : b;
}

/**
 * Derive planner baselines from per-month aggregates (current month-to-date
 * plus lookback months). Prefers the current month; widens to the full
 * lookback when the current month's sample is thin.
 *
 * @param months       Per-month aggregates, must include `currentMonthKey`.
 * @param currentMonthKey "YYYY-MM" of the month being planned.
 * @param elapsedDays  Days elapsed in the month (from the pace forecast).
 * @param daysInMonth  Calendar days in the month.
 */
export function derivePlannerBaselines(
  months: MonthAggregate[],
  currentMonthKey: string,
  elapsedDays: number,
  daysInMonth: number,
): PlannerBaselines {
  const current = months.find((m) => m.monthKey === currentMonthKey);
  const history = months.filter((m) => m.monthKey !== currentMonthKey);

  let usedFallbacks = false;

  // --- Guests + spends: prefer this month; widen to full lookback when thin.
  const MIN_SAMPLE_DAYS = 7;
  let sample: MonthAggregate[] = current && current.activeDays >= MIN_SAMPLE_DAYS ? [current] : [];
  if (sample.length === 0) {
    sample = months.filter((m) => m.activeDays > 0);
    if (sample.length > 0) usedFallbacks = true;
  }

  let sampleDays = 0;
  let totalGuests = 0;
  let totalTicketRev = 0;
  let totalFnbRev = 0;
  for (const m of sample) {
    sampleDays += m.activeDays;
    totalGuests += m.guests;
    totalTicketRev += m.ticketRevenue;
    totalFnbRev += m.fnbRevenue;
  }
  const visitorsPerDay = sampleDays > 0 ? totalGuests / sampleDays : 0;
  const ticketSpendPerGuest = totalGuests > 0 ? totalTicketRev / totalGuests : 0;
  const fnbSpendPerGuest = totalGuests > 0 ? totalFnbRev / totalGuests : 0;

  // --- Parties: this month for the baseline; widen for avg revenue / party.
  // Counts are real linked birthday events only (task-163) — one booking =
  // one party. Months without linked events contribute nothing here.
  const partiesSoFar = current?.parties || 0;
  let partySampleEvents = 0;
  let partySampleMonths = 0;
  let avgPartyRevenue =
    partiesSoFar > 0 && (current?.partyRevenue || 0) > 0
      ? (current!.partyRevenue) / partiesSoFar
      : 0;
  if (avgPartyRevenue > 0) {
    partySampleEvents = partiesSoFar;
    partySampleMonths = 1;
  } else {
    let p = 0;
    let r = 0;
    let mCount = 0;
    for (const m of months) {
      if (m.parties > 0) {
        p += m.parties;
        r += m.partyRevenue;
        mCount++;
      }
    }
    if (p > 0 && r > 0) {
      avgPartyRevenue = r / p;
      partySampleEvents = p;
      partySampleMonths = mCount;
      usedFallbacks = true;
    }
  }
  const partySource: PlannerBaselines["partySource"] =
    partySampleEvents > 0 || partiesSoFar > 0 ? "linked-events" : "none";

  // Projected full-month party count at the current pace.
  const safeElapsed = Math.max(1, elapsedDays);
  const partiesBaselineMonth = Math.round(
    partiesSoFar + (partiesSoFar / safeElapsed) * Math.max(0, daysInMonth - safeElapsed),
  );

  // --- Historical monthly party max (slider upper bound anchor). Strictly
  // the observed monthly maximum — never a projected uplift — so the
  // birthday lever can never plan more parties than the venue has actually
  // hosted in a month. Fallback only when there is no usable history.
  let monthlyPartyMax = 0;
  for (const m of history) {
    monthlyPartyMax = Math.max(monthlyPartyMax, m.parties);
  }
  const observedPartyMax = monthlyPartyMax; // pre-clamp, for the sanity check
  if (monthlyPartyMax <= 0) {
    monthlyPartyMax = Math.max(4, partiesBaselineMonth * 2);
    usedFallbacks = true;
  }
  // The baseline itself (already-booked pace this month) stays reachable.
  monthlyPartyMax = Math.max(monthlyPartyMax, partiesBaselineMonth);

  return sanityCheckBaselines({
    partiesSoFar,
    partiesBaselineMonth,
    avgPartyRevenue,
    visitorsPerDay,
    ticketSpendPerGuest,
    fnbSpendPerGuest,
    monthlyPartyMax,
    sampleDays,
    usedFallbacks,
    partySource,
    partySampleEvents,
    partySampleMonths,
    warnings: [],
  }, observedPartyMax);
}

/**
 * Derive planner baselines for a FUTURE month (task-162). Nothing has been
 * earned yet, so every baseline is an expectation:
 *  - Volumes (parties, visitors/day) come from LAST YEAR's same month when
 *    available — the best seasonal match — scaled by the recent YoY growth
 *    trend so the lever baselines line up with the baseline forecast
 *    (a scenario left at baseline must show ≈0 impact).
 *  - Unit spends (ticket/F&B per guest) come from RECENT months — they
 *    reflect current pricing, which last year does not.
 *
 * @param months        Aggregates: LY same month (when synced) + recent
 *                      completed months.
 * @param lyMonthKey    "YYYY-MM" of last year's same month.
 * @param growthFactor  YoY growth factor from the baseline forecast (null →
 *                      treated as 1).
 */
export function deriveFutureMonthBaselines(
  months: MonthAggregate[],
  lyMonthKey: string,
  growthFactor: number | null,
): PlannerBaselines {
  const ly = months.find((m) => m.monthKey === lyMonthKey);
  const recent = months.filter((m) => m.monthKey !== lyMonthKey && m.activeDays > 0);
  const g = growthFactor ?? 1;

  let usedFallbacks = false;

  // --- Volumes from LY same month (seasonal), growth-scaled ----------------
  const lyUsable = !!ly && ly.activeDays > 0;
  let visitorsPerDay = 0;
  if (lyUsable && ly!.guests > 0) {
    visitorsPerDay = (ly!.guests / ly!.activeDays) * g;
  } else {
    let days = 0;
    let guests = 0;
    for (const m of recent) {
      days += m.activeDays;
      guests += m.guests;
    }
    visitorsPerDay = days > 0 ? guests / days : 0;
    if (visitorsPerDay > 0) usedFallbacks = true;
  }

  // Party counts are real linked birthday events only (task-163): one
  // booking = one party. Months without linked events count as no data,
  // not as zero-party months, so they don't drag the average down.
  let partiesBaselineMonth = 0;
  if (lyUsable && ly!.parties > 0) {
    partiesBaselineMonth = Math.round(ly!.parties * g);
  } else {
    const recentLinked = recent.filter((m) => m.partiesLinked);
    if (recentLinked.length > 0) {
      const avgParties = recentLinked.reduce((a, m) => a + m.parties, 0) / recentLinked.length;
      partiesBaselineMonth = Math.round(avgParties);
      if (partiesBaselineMonth > 0) usedFallbacks = true;
    }
  }

  // --- Unit spends from recent months (current pricing) --------------------
  let sampleDays = 0;
  let rGuests = 0;
  let rTicketRev = 0;
  let rFnbRev = 0;
  for (const m of recent) {
    sampleDays += m.activeDays;
    rGuests += m.guests;
    rTicketRev += m.ticketRevenue;
    rFnbRev += m.fnbRevenue;
  }
  let ticketSpendPerGuest = rGuests > 0 ? rTicketRev / rGuests : 0;
  let fnbSpendPerGuest = rGuests > 0 ? rFnbRev / rGuests : 0;
  if (!(ticketSpendPerGuest > 0) && lyUsable && ly!.guests > 0) {
    ticketSpendPerGuest = ly!.ticketRevenue / ly!.guests;
    fnbSpendPerGuest = ly!.fnbRevenue / ly!.guests;
    usedFallbacks = true;
  }

  // --- Avg revenue per party: recent months first, LY fallback -------------
  let avgPartyRevenue = 0;
  let partySampleEvents = 0;
  let partySampleMonths = 0;
  {
    let p = 0;
    let r = 0;
    let mCount = 0;
    for (const m of recent) {
      if (m.parties > 0) {
        p += m.parties;
        r += m.partyRevenue;
        mCount++;
      }
    }
    if (p > 0 && r > 0) {
      avgPartyRevenue = r / p;
      partySampleEvents = p;
      partySampleMonths = mCount;
    } else if (lyUsable && ly!.parties > 0 && ly!.partyRevenue > 0) {
      avgPartyRevenue = ly!.partyRevenue / ly!.parties;
      partySampleEvents = ly!.parties;
      partySampleMonths = 1;
      usedFallbacks = true;
    }
  }
  const partySource: PlannerBaselines["partySource"] =
    partySampleEvents > 0 ? "linked-events" : "none";

  // --- Historical monthly party max (slider upper bound anchor) ------------
  let monthlyPartyMax = 0;
  for (const m of months) {
    monthlyPartyMax = Math.max(monthlyPartyMax, m.parties);
  }
  const observedPartyMax = monthlyPartyMax; // pre-clamp, for the sanity check
  if (monthlyPartyMax <= 0) {
    monthlyPartyMax = Math.max(4, partiesBaselineMonth * 2);
    usedFallbacks = true;
  }
  monthlyPartyMax = Math.max(monthlyPartyMax, partiesBaselineMonth);

  return sanityCheckBaselines({
    partiesSoFar: 0, // nothing has happened yet — sliders can go down to 0
    partiesBaselineMonth,
    avgPartyRevenue,
    visitorsPerDay,
    ticketSpendPerGuest,
    fnbSpendPerGuest,
    monthlyPartyMax,
    sampleDays,
    usedFallbacks,
    partySource,
    partySampleEvents,
    partySampleMonths,
    warnings: [],
  }, observedPartyMax);
}

// ---------------------------------------------------------------------------
// Lever model
// ---------------------------------------------------------------------------

export interface LeverConfig {
  id: string;
  label: string;
  /** Unit shown after values, e.g. "/day" or " parties". */
  unitSuffix: string;
  /** Extra context line, e.g. "avg ฿12,400 / party". */
  detail?: string;
  baseline: number;
  min: number;
  max: number;
  step: number;
  /** Round displayed/applied values to this many decimals. */
  decimals: number;
  /** True when the lever's delta applies only to remaining days. */
  remainingDaysOnly: boolean;
  /** Revenue impact of moving this lever from baseline to `planned`. */
  impact: (planned: number, ctx: ScenarioContext) => number;
}

export interface ScenarioContext {
  /** Remaining days incl. a partial today when applicable. */
  remainingEffDays: number;
  baselines: PlannerBaselines;
}

export const LEVER_IDS = {
  birthdays: "birthdays",
  visitors: "visitors",
  ticketSpend: "ticketSpend",
  fnbSpend: "fnbSpend",
} as const;

const round = (v: number, dec: number) => {
  const f = Math.pow(10, dec);
  return Math.round(v * f) / f;
};

const fmtB = (v: number) => `฿${Math.round(v).toLocaleString()}`;

/** Build the four launch levers from baselines. Smart ranges from history:
 *  birthdays bounded by historical monthly capacity, visitors ±30%,
 *  ticket spend ±20%, F&B spend ±30%. */
export function buildLevers(b: PlannerBaselines): LeverConfig[] {
  const levers: LeverConfig[] = [];

  levers.push({
    id: LEVER_IDS.birthdays,
    label: "Birthday Parties",
    unitSuffix: " parties",
    detail:
      b.avgPartyRevenue > 0
        ? `avg ${fmtB(b.avgPartyRevenue)} / party`
        : b.partySource === "none"
          ? "no linked party events for this branch"
          : "no party history yet",
    baseline: b.partiesBaselineMonth,
    min: b.partiesSoFar, // can't undo parties already held
    max: Math.max(b.monthlyPartyMax, b.partiesBaselineMonth),
    step: 1,
    decimals: 0,
    remainingDaysOnly: true,
    impact: (planned, ctx) =>
      (planned - ctx.baselines.partiesBaselineMonth) * ctx.baselines.avgPartyRevenue,
  });

  levers.push({
    id: LEVER_IDS.visitors,
    label: "Visitors / Day",
    unitSuffix: "/day",
    detail: `spend ${fmtB(b.ticketSpendPerGuest + b.fnbSpendPerGuest)} / guest`,
    baseline: round(b.visitorsPerDay, 0),
    min: Math.max(0, Math.round(b.visitorsPerDay * 0.7)),
    max: Math.round(b.visitorsPerDay * 1.3),
    step: 1,
    decimals: 0,
    remainingDaysOnly: true,
    impact: (planned, ctx) =>
      (planned - Math.round(ctx.baselines.visitorsPerDay)) *
      ctx.remainingEffDays *
      (ctx.baselines.ticketSpendPerGuest + ctx.baselines.fnbSpendPerGuest),
  });

  levers.push({
    id: LEVER_IDS.ticketSpend,
    label: "Average Ticket Spend",
    unitSuffix: "/guest",
    detail: `at ~${Math.round(b.visitorsPerDay)} guests/day`,
    baseline: round(b.ticketSpendPerGuest, 0),
    min: Math.max(0, Math.round(b.ticketSpendPerGuest * 0.8)),
    max: Math.round(b.ticketSpendPerGuest * 1.2),
    step: 5,
    decimals: 0,
    remainingDaysOnly: true,
    impact: (planned, ctx) =>
      (planned - Math.round(ctx.baselines.ticketSpendPerGuest)) *
      Math.round(ctx.baselines.visitorsPerDay) *
      ctx.remainingEffDays,
  });

  levers.push({
    id: LEVER_IDS.fnbSpend,
    label: "Average F&B Spend",
    unitSuffix: "/guest",
    detail: `at ~${Math.round(b.visitorsPerDay)} guests/day`,
    baseline: round(b.fnbSpendPerGuest, 0),
    min: Math.max(0, Math.round(b.fnbSpendPerGuest * 0.7)),
    max: Math.round(b.fnbSpendPerGuest * 1.3),
    step: 5,
    decimals: 0,
    remainingDaysOnly: true,
    impact: (planned, ctx) =>
      (planned - Math.round(ctx.baselines.fnbSpendPerGuest)) *
      Math.round(ctx.baselines.visitorsPerDay) *
      ctx.remainingEffDays,
  });

  return levers;
}

// ---------------------------------------------------------------------------
// Scenario math (pure)
// ---------------------------------------------------------------------------

export interface LeverImpact {
  leverId: string;
  label: string;
  planned: number;
  baseline: number;
  impact: number;
}

export interface ScenarioResult {
  perLever: LeverImpact[];
  totalImpact: number;
  projectedRevenue: number;
  /** Gap remaining after the scenario (negative = target exceeded). */
  gapAfter: number;
  targetAchieved: boolean;
}

export function scenarioContextFromForecast(
  pace: Pick<SmartPaceForecast, "remainingDays" | "todayIsPartial">,
  baselines: PlannerBaselines,
): ScenarioContext {
  return {
    remainingEffDays: pace.remainingDays + (pace.todayIsPartial ? 1 : 0),
    baselines,
  };
}

/** Pure scenario evaluation: forecast + Σ per-lever impacts. Deltas apply
 *  only to remaining days, so month-to-date actuals stay fixed. */
export function evaluateScenario(
  forecastRevenue: number,
  target: number,
  levers: LeverConfig[],
  planned: Record<string, number>,
  ctx: ScenarioContext,
): ScenarioResult {
  const perLever: LeverImpact[] = levers.map((lv) => {
    const p = planned[lv.id] ?? lv.baseline;
    const raw = lv.impact(p, ctx);
    const impact = Number.isFinite(raw) ? raw : 0;
    return { leverId: lv.id, label: lv.label, planned: p, baseline: lv.baseline, impact };
  });
  const totalImpact = perLever.reduce((a, x) => a + x.impact, 0);
  const projectedRevenue = forecastRevenue + totalImpact;
  const gapAfter = target > 0 ? target - projectedRevenue : 0;
  return {
    perLever,
    totalImpact,
    projectedRevenue,
    gapAfter,
    targetAchieved: target > 0 && projectedRevenue >= target,
  };
}

// ---------------------------------------------------------------------------
// Opportunity Score + recommended plans (deterministic)
// ---------------------------------------------------------------------------

export interface OpportunityEntry {
  leverId: string;
  label: string;
  /** Max realistic extra revenue from this lever (impact at upper bound). */
  headroom: number;
  /** Share of total headroom, 0–100. */
  sharePct: number;
}

export function computeOpportunityScore(
  levers: LeverConfig[],
  ctx: ScenarioContext,
): OpportunityEntry[] {
  const entries = levers.map((lv) => {
    const headroom = Math.max(0, lv.impact(lv.max, ctx));
    return { leverId: lv.id, label: lv.label, headroom, sharePct: 0 };
  });
  const total = entries.reduce((a, x) => a + x.headroom, 0);
  if (total > 0) {
    for (const e of entries) e.sharePct = (e.headroom / total) * 100;
  }
  return entries;
}

export interface RecommendedPlan {
  id: "conservative" | "balanced" | "growth";
  label: string;
  description: string;
  /** Planned value per lever id. */
  values: Record<string, number>;
  projectedRevenue: number;
  pctOfTarget: number;
  reachesTarget: boolean;
}

const PLAN_FRACTIONS: Array<{ id: RecommendedPlan["id"]; label: string; description: string; f: number }> = [
  { id: "conservative", label: "Conservative", description: "Minimal effort — small pushes on every lever", f: 0.25 },
  { id: "balanced", label: "Balanced", description: "Reasonable effort — halfway to realistic capacity", f: 0.5 },
  { id: "growth", label: "Growth", description: "Maximum opportunity — every lever at realistic capacity", f: 1.0 },
];

/** Three deterministic plans: each moves every lever a fixed fraction of its
 *  headroom (baseline → max), bounded by the smart ranges. */
export function buildRecommendedPlans(
  forecastRevenue: number,
  target: number,
  levers: LeverConfig[],
  ctx: ScenarioContext,
): RecommendedPlan[] {
  return PLAN_FRACTIONS.map(({ id, label, description, f }) => {
    const values: Record<string, number> = {};
    for (const lv of levers) {
      const raw = lv.baseline + (lv.max - lv.baseline) * f;
      const stepped = Math.round(raw / lv.step) * lv.step;
      values[lv.id] = Math.min(lv.max, Math.max(lv.min, round(stepped, lv.decimals)));
    }
    const r = evaluateScenario(forecastRevenue, target, levers, values, ctx);
    return {
      id,
      label,
      description,
      values,
      projectedRevenue: r.projectedRevenue,
      pctOfTarget: target > 0 ? (r.projectedRevenue / target) * 100 : 0,
      reachesTarget: r.targetAchieved,
    };
  });
}
