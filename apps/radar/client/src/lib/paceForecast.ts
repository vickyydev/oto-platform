// Pace Forecast Engine
// ---------------------
// Answers the question: "If we continue performing at the current pace,
// what revenue will we finish the month with?"
//
// Modular by design: the calendar UI only consumes the forecast result
// shape, so smarter models (bookings, weather, promotions, ML) can be
// added later as new implementations without touching any UI component.
//
// The smart model layers signals with graceful level-by-level fallback:
//   L1 run-rate (permanent fallback) → L2 weekday pattern →
//   L3 last-year growth blend → L4 holiday/event adjustment.
// It never returns NaN or blank values.

export interface PaceInputs {
  /** Revenue collected so far this month (actuals only). */
  revenueToDate: number;
  /** Days elapsed in the month, including today (e.g. 22 on July 22). */
  elapsedDays: number;
  /** Total calendar days in the month. */
  daysInMonth: number;
}

export interface PaceForecast {
  /** Projected end-of-month revenue if the current pace continues. */
  forecastRevenue: number;
  /** Average revenue per elapsed day. */
  avgDailyRevenue: number;
  /** Days left in the month after today. */
  remainingDays: number;
  /** avgDailyRevenue × remainingDays. */
  projectedRemaining: number;
  /** Which model produced this forecast (for future multi-model support). */
  model: string;
}

export type PaceModel = (inputs: PaceInputs) => PaceForecast;

/**
 * v1 model — simple run-rate projection:
 *   avgDaily = revenueToDate / elapsedDays
 *   forecast = revenueToDate + avgDaily × remainingDays
 */
export const simplePaceModel: PaceModel = ({ revenueToDate, elapsedDays, daysInMonth }) => {
  const safeElapsed = Math.max(1, Math.min(elapsedDays, daysInMonth));
  const remainingDays = Math.max(0, daysInMonth - safeElapsed);
  const avgDailyRevenue = revenueToDate / safeElapsed;
  const projectedRemaining = avgDailyRevenue * remainingDays;
  return {
    forecastRevenue: revenueToDate + projectedRemaining,
    avgDailyRevenue,
    remainingDays,
    projectedRemaining,
    model: "simple-pace-v1",
  };
};

/** The legacy simple model entry point (kept for compatibility/fallback). */
export const computePaceForecast: PaceModel = simplePaceModel;

export type PaceStatus = "ahead" | "on-pace" | "behind";

export interface PaceVsTarget {
  /** Forecast minus target, as a % of target (e.g. +2.7). */
  pctDiff: number;
  status: PaceStatus;
  /** Hex color used across the calendar: green / orange / red. */
  color: string;
}

/**
 * Compare the pace forecast against the month target.
 * Above +2% → green (ahead) · within ±2% → orange (on pace) · below −2% → red (behind).
 */
export function comparePaceToTarget(forecastRevenue: number, target: number): PaceVsTarget | null {
  if (!(target > 0)) return null;
  const pctDiff = ((forecastRevenue / target) - 1) * 100;
  const status: PaceStatus = pctDiff > 2 ? "ahead" : pctDiff >= -2 ? "on-pace" : "behind";
  const color = status === "ahead" ? "#10b981" : status === "on-pace" ? "#f59e0b" : "#ef4444";
  return { pctDiff, status, color };
}

// ---------------------------------------------------------------------------
// Smart multi-signal model (v2)
// ---------------------------------------------------------------------------

export interface SmartPaceInputs {
  /** Calendar year of the month being forecast. */
  year: number;
  /** 0-based month index. */
  month: number;
  /** Total calendar days in the month. */
  daysInMonth: number;
  /** Today's date string (YYYY-MM-DD, Bangkok time). */
  todayStr: string;
  /** Revenue for a given date string; return 0 when unknown. */
  getRevenue: (dateStr: string) => number;
  /** Whether we have any recorded data for that date (rev may be 0). */
  hasData: (dateStr: string) => boolean;
  /**
   * Whether a date is a holiday / school break / camp / special event
   * according to the calendar overlay.
   */
  isEventDay: (dateStr: string) => boolean;
}

export interface DayProjection {
  date: string;
  projected: number;
  isEventDay: boolean;
}

export interface SmartPaceForecast extends PaceForecast {
  /** Revenue actually collected so far this month. */
  revenueToDate: number;
  /** Elapsed days actually counted in the average (partial today excluded). */
  elapsedDays: number;
  daysInMonth: number;
  /** Projection for each remaining future day (and a partial today, if any). */
  perDay: DayProjection[];
  /** Human-readable signals used, e.g. ["Weekday Pattern", "LY Growth"]. */
  signals: string[];
  /** Short label, e.g. "Weekday Pattern + LY Growth + Holiday Adjustment". */
  modelLabel: string;
  /** Plain-language sentence explaining the forecast. */
  explanation: string;
  /** True when today was treated as a partial (in-progress) day. */
  todayIsPartial: boolean;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function makeDateStr(year: number, month: number, day: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

function shiftDateStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dowOf(dateStr: string): number {
  return new Date(dateStr + "T12:00:00").getDay();
}

function safeNum(v: number, fallback = 0): number {
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const HISTORY_DAYS = 56; // 8 weeks lookback for weekday/holiday patterns
const LY_ALIGN_DAYS = 364; // 52 weeks: same weekday last year
const GROWTH_WINDOW = 28; // trailing window for LY growth factor
const MIN_WEEKDAY_SAMPLES = 2;
const MIN_HISTORY_SAMPLES = 10;
const PARTIAL_TODAY_THRESHOLD = 0.3; // today < 30% of expected → in-progress

/**
 * Smart multi-signal pace forecast. Layers weekday patterns, last-year
 * growth, and holiday adjustments on top of the run-rate, degrading
 * gracefully whenever a signal lacks data. Never returns NaN.
 */
export function computeSmartPaceForecast(inputs: SmartPaceInputs): SmartPaceForecast {
  const { year, month, daysInMonth, todayStr, getRevenue, hasData, isEventDay } = inputs;

  const todayDate = new Date(todayStr + "T12:00:00");
  const todayDay =
    todayDate.getFullYear() === year && todayDate.getMonth() === month
      ? todayDate.getDate()
      : daysInMonth; // month fully in the past → nothing to project

  // --- Actuals this month -------------------------------------------------
  let revenueToDate = 0;
  for (let d = 1; d <= Math.min(todayDay, daysInMonth); d++) {
    revenueToDate += safeNum(getRevenue(makeDateStr(year, month, d)));
  }

  // --- L2: weekday pattern from recent history (excluding today) ----------
  const nonEventByDow: number[][] = [[], [], [], [], [], [], []];
  const eventSamples: number[] = [];
  const nonEventSamples: number[] = [];
  let historySamples = 0;
  for (let i = 1; i <= HISTORY_DAYS; i++) {
    const ds = shiftDateStr(todayStr, -i);
    if (!hasData(ds)) continue;
    const rev = safeNum(getRevenue(ds));
    if (rev <= 0) continue;
    historySamples++;
    if (isEventDay(ds)) {
      eventSamples.push(rev);
    } else {
      nonEventSamples.push(rev);
      nonEventByDow[dowOf(ds)].push(rev);
    }
  }

  const avg = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const overallNonEventAvg = avg(nonEventSamples);
  const overallHistAvg = avg([...nonEventSamples, ...eventSamples]);

  const weekdayUsable = historySamples >= MIN_HISTORY_SAMPLES && overallHistAvg > 0;
  const weekdayAvgFor = (dow: number): number => {
    const samples = nonEventByDow[dow];
    if (samples.length >= MIN_WEEKDAY_SAMPLES) return avg(samples);
    if (overallNonEventAvg > 0) return overallNonEventAvg;
    return overallHistAvg;
  };

  // --- L4: holiday uplift factor ------------------------------------------
  let holidayFactor: number | null = null;
  if (eventSamples.length >= MIN_WEEKDAY_SAMPLES && overallNonEventAvg > 0) {
    const raw = avg(eventSamples) / overallNonEventAvg;
    if (Number.isFinite(raw) && raw > 0) {
      holidayFactor = Math.min(2.5, Math.max(0.7, raw));
    }
  }

  // --- L3: last-year growth factor (weekday-aligned trailing window) ------
  let growthFactor: number | null = null;
  {
    let tySum = 0;
    let lySum = 0;
    let lyDays = 0;
    for (let i = 1; i <= GROWTH_WINDOW; i++) {
      const ds = shiftDateStr(todayStr, -i);
      const lyDs = shiftDateStr(ds, -LY_ALIGN_DAYS);
      if (!hasData(ds) || !hasData(lyDs)) continue;
      const ty = safeNum(getRevenue(ds));
      const ly = safeNum(getRevenue(lyDs));
      if (ty <= 0 || ly <= 0) continue;
      tySum += ty;
      lySum += ly;
      lyDays++;
    }
    if (lyDays >= 14 && lySum > 0) {
      const raw = tySum / lySum;
      if (Number.isFinite(raw) && raw > 0) {
        growthFactor = Math.min(1.8, Math.max(0.6, raw));
      }
    }
  }

  // --- Early-morning mitigation: is today still "in progress"? ------------
  const todayInMonth = todayDate.getFullYear() === year && todayDate.getMonth() === month;
  const todayDs = todayInMonth ? makeDateStr(year, month, todayDay) : null;
  const todayRev = todayDs ? safeNum(getRevenue(todayDs)) : 0;
  let todayIsPartial = false;
  if (todayDs) {
    const expectedToday = weekdayUsable
      ? weekdayAvgFor(dowOf(todayDs)) * (isEventDay(todayDs) && holidayFactor ? holidayFactor : 1)
      : todayDay > 1
        ? (revenueToDate - todayRev) / (todayDay - 1)
        : 0;
    if (expectedToday > 0 && todayRev < expectedToday * PARTIAL_TODAY_THRESHOLD) {
      todayIsPartial = true;
    }
  }

  // Days counted toward the run-rate average.
  const countedDays = Math.max(1, Math.min(todayDay - (todayIsPartial ? 1 : 0), daysInMonth));
  const countedRevenue = revenueToDate - (todayIsPartial ? todayRev : 0);
  const runRateAvg = safeNum(countedRevenue / countedDays);

  // --- Per-day projections for remaining days ------------------------------
  const projectDay = (ds: string): number => {
    if (!weekdayUsable) return runRateAvg;
    const event = isEventDay(ds);
    let base = weekdayAvgFor(dowOf(ds));
    if (event && holidayFactor !== null) base *= holidayFactor;

    // Blend with weekday-aligned last-year actual, scaled by growth.
    const lyDs = shiftDateStr(ds, -LY_ALIGN_DAYS);
    if (growthFactor !== null && hasData(lyDs)) {
      const lyRev = safeNum(getRevenue(lyDs));
      if (lyRev > 0) {
        base = 0.5 * base + 0.5 * lyRev * growthFactor;
      }
    }
    return safeNum(base, runRateAvg);
  };

  const perDay: DayProjection[] = [];
  let projectedRemaining = 0;
  if (todayInMonth) {
    if (todayIsPartial && todayDs) {
      // Project the rest of today: at least what's already in.
      const proj = Math.max(todayRev, projectDay(todayDs));
      perDay.push({ date: todayDs, projected: proj, isEventDay: isEventDay(todayDs) });
      projectedRemaining += proj - todayRev;
    }
    for (let d = todayDay + 1; d <= daysInMonth; d++) {
      const ds = makeDateStr(year, month, d);
      const proj = projectDay(ds);
      perDay.push({ date: ds, projected: proj, isEventDay: isEventDay(ds) });
      projectedRemaining += proj;
    }
  }
  projectedRemaining = safeNum(projectedRemaining);

  const remainingDays = todayInMonth ? Math.max(0, daysInMonth - todayDay) : 0;
  const forecastRevenue = safeNum(revenueToDate + projectedRemaining, revenueToDate);

  // --- Signals, label, explanation -----------------------------------------
  const signals: string[] = [];
  if (weekdayUsable) signals.push("Weekday Pattern");
  if (weekdayUsable && growthFactor !== null) signals.push("LY Growth");
  if (weekdayUsable && holidayFactor !== null) signals.push("Holiday Adjustment");

  const modelLabel = signals.length > 0 ? signals.join(" + ") : "Simple Run Rate — insufficient history";
  const model = weekdayUsable ? "smart-pace-v2" : "simple-pace-v1";

  const monthName = new Date(year, month, 1).toLocaleDateString("en-US", { month: "long" });
  const fmtM = (v: number) =>
    v >= 1000000 ? `฿${(v / 1000000).toFixed(2)}M` : `฿${Math.round(v / 1000)}k`;
  let explanation: string;
  if (!weekdayUsable) {
    explanation = `Forecast is based on average daily revenue (${fmtM(runRateAvg)}/day) because insufficient historical data is available. ${monthName} is projected to finish at ${fmtM(forecastRevenue)}.`;
  } else {
    const parts: string[] = ["weekday patterns"];
    if (growthFactor !== null)
      parts.push(`last year's trend (×${growthFactor.toFixed(2)})`);
    if (holidayFactor !== null)
      parts.push(`holiday/event days (×${holidayFactor.toFixed(2)})`);
    const joined =
      parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0];
    explanation = `If current performance continues while accounting for ${joined}, ${monthName} is projected to finish at ${fmtM(forecastRevenue)}.${todayIsPartial ? " Today is still in progress and is projected rather than counted as a full day." : ""}`;
  }

  return {
    forecastRevenue,
    avgDailyRevenue: runRateAvg,
    remainingDays,
    projectedRemaining,
    model,
    revenueToDate,
    elapsedDays: countedDays,
    daysInMonth,
    perDay,
    signals,
    modelLabel,
    explanation,
    todayIsPartial,
  };
}

// ---------------------------------------------------------------------------
// Future-month baseline (task-162): "what do we expect BEFORE the month starts?"
// ---------------------------------------------------------------------------
// Used by the Revenue Planner when a future month is opened. Produces a
// SmartPaceForecast-shaped object so the Planner dialog can consume it
// unchanged (revenueToDate = 0, all days remaining). Layered like the pace
// model, never NaN:
//   B1 last-year same month × growth trend → B2 recent daily average ×
//   days in month → B3 caller-provided fallback (the calendar's target).

export interface FutureMonthBaselineInputs {
  /** Calendar year of the future month. */
  year: number;
  /** 0-based month index of the future month. */
  month: number;
  daysInMonth: number;
  /** Today's date string (YYYY-MM-DD, Bangkok time). */
  todayStr: string;
  getRevenue: (dateStr: string) => number;
  hasData: (dateStr: string) => boolean;
  /** Last-resort baseline when no usable history exists (e.g. the
   *  calendar's derived target for the month). */
  fallbackRevenue?: number;
}

export type FutureBaselineSource = "ly-growth" | "recent-average" | "fallback";

export interface FutureMonthBaseline extends SmartPaceForecast {
  /** Which layer produced the baseline. */
  baselineSource: FutureBaselineSource;
  /** YoY growth factor applied to last year (null when not measurable). */
  growthFactor: number | null;
  /** Last year's same-month revenue, coverage-normalised (0 if unusable). */
  lySameMonthRevenue: number;
}

const LY_MONTH_MIN_DAYS = 20; // need most of LY month recorded to trust it
const GROWTH_PAIR_MIN_DAYS = 21; // paired TY/LY days needed for a growth trend
const GROWTH_LOOKBACK_DAYS = 84; // ~3 recent months of paired history
const RECENT_AVG_DAYS = 56; // 8-week window for the recent-average fallback

/**
 * Baseline projection for a month that hasn't started yet. Best signal is
 * last year's same month (it embeds that month's seasonality, holidays and
 * weekday mix) scaled by the recent year-over-year growth trend.
 */
export function computeFutureMonthBaseline(inputs: FutureMonthBaselineInputs): FutureMonthBaseline {
  const { year, month, daysInMonth, todayStr, getRevenue, hasData, fallbackRevenue = 0 } = inputs;

  // --- Last year's same month, normalised for partial coverage -------------
  const lyYear = year - 1;
  const lyDaysInMonth = new Date(lyYear, month + 1, 0).getDate();
  let lyTotal = 0;
  let lyDaysWithData = 0;
  for (let d = 1; d <= lyDaysInMonth; d++) {
    const ds = makeDateStr(lyYear, month, d);
    if (!hasData(ds)) continue;
    lyDaysWithData++;
    lyTotal += safeNum(getRevenue(ds));
  }
  const lyUsable = lyDaysWithData >= LY_MONTH_MIN_DAYS && lyTotal > 0;
  const lySameMonthRevenue = lyUsable ? (lyTotal / lyDaysWithData) * lyDaysInMonth : 0;

  // --- Recent YoY growth trend (paired same-date days, ~3 months back) -----
  let growthFactor: number | null = null;
  {
    let tySum = 0;
    let lySum = 0;
    let paired = 0;
    for (let i = 1; i <= GROWTH_LOOKBACK_DAYS; i++) {
      const ds = shiftDateStr(todayStr, -i);
      const lyDs = shiftDateStr(ds, -LY_ALIGN_DAYS);
      if (!hasData(ds) || !hasData(lyDs)) continue;
      const ty = safeNum(getRevenue(ds));
      const ly = safeNum(getRevenue(lyDs));
      if (ty <= 0 || ly <= 0) continue;
      tySum += ty;
      lySum += ly;
      paired++;
    }
    if (paired >= GROWTH_PAIR_MIN_DAYS && lySum > 0) {
      const raw = tySum / lySum;
      if (Number.isFinite(raw) && raw > 0) {
        growthFactor = Math.min(1.8, Math.max(0.6, raw));
      }
    }
  }

  // --- Recent daily average (fallback layer) --------------------------------
  let recentSum = 0;
  let recentDays = 0;
  for (let i = 1; i <= RECENT_AVG_DAYS; i++) {
    const ds = shiftDateStr(todayStr, -i);
    if (!hasData(ds)) continue;
    const rev = safeNum(getRevenue(ds));
    if (rev <= 0) continue;
    recentSum += rev;
    recentDays++;
  }
  const recentDailyAvg = recentDays >= MIN_HISTORY_SAMPLES ? recentSum / recentDays : 0;

  // --- Pick the strongest available layer ----------------------------------
  let baselineSource: FutureBaselineSource;
  let forecastRevenue: number;
  if (lyUsable) {
    baselineSource = "ly-growth";
    forecastRevenue = lySameMonthRevenue * (growthFactor ?? 1);
  } else if (recentDailyAvg > 0) {
    baselineSource = "recent-average";
    forecastRevenue = recentDailyAvg * daysInMonth;
  } else {
    baselineSource = "fallback";
    forecastRevenue = safeNum(fallbackRevenue);
  }
  forecastRevenue = safeNum(forecastRevenue);
  const avgDailyRevenue = daysInMonth > 0 ? forecastRevenue / daysInMonth : 0;

  // --- Signals, label, explanation ------------------------------------------
  const monthName = new Date(year, month, 1).toLocaleDateString("en-US", { month: "long" });
  const fmtM = (v: number) =>
    v >= 1000000 ? `฿${(v / 1000000).toFixed(2)}M` : `฿${Math.round(v / 1000)}k`;

  const signals: string[] = [];
  let modelLabel: string;
  let explanation: string;
  if (baselineSource === "ly-growth") {
    signals.push("Last Year Same Month");
    if (growthFactor !== null) signals.push("YoY Growth Trend");
    modelLabel = signals.join(" + ");
    explanation =
      growthFactor !== null
        ? `Baseline for ${monthName} ${year} starts from ${monthName} ${lyYear} (${fmtM(lySameMonthRevenue)}) scaled by the recent year-over-year trend (×${growthFactor.toFixed(2)}), projecting ${fmtM(forecastRevenue)}. Nothing has been earned yet — this is the expected outcome if the month performs like last year adjusted for current momentum.`
        : `Baseline for ${monthName} ${year} uses ${monthName} ${lyYear}'s revenue (${fmtM(lySameMonthRevenue)}) as-is — not enough paired history to measure a growth trend yet. Projected: ${fmtM(forecastRevenue)}.`;
  } else if (baselineSource === "recent-average") {
    signals.push("Recent Daily Average");
    modelLabel = "Recent Daily Average — no last-year data for this month";
    explanation = `No usable data for ${monthName} ${lyYear}, so the baseline projects the recent daily average (${fmtM(recentDailyAvg)}/day) across all ${daysInMonth} days of ${monthName}: ${fmtM(forecastRevenue)}.`;
  } else {
    modelLabel = "Calendar Target — insufficient history";
    explanation = `Not enough history to build a data-driven baseline for ${monthName} ${year}; using the calendar's target (${fmtM(forecastRevenue)}) as the starting point.`;
  }

  return {
    forecastRevenue,
    avgDailyRevenue,
    remainingDays: daysInMonth,
    projectedRemaining: forecastRevenue,
    model: "future-baseline-v1",
    revenueToDate: 0,
    elapsedDays: 0,
    daysInMonth,
    perDay: [],
    signals,
    modelLabel,
    explanation,
    todayIsPartial: false,
    baselineSource,
    growthFactor,
    lySameMonthRevenue,
  };
}
