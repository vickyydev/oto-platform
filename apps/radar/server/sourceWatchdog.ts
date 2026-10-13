/**
 * task-178: Source Gap Watchdog
 *
 * Detects when a normally-active Floresta revenue source (Sales Booth, Mascot,
 * etc.) records zero orders for several consecutive days. Mirrors the pattern
 * of posStaleness.ts so the UI can display a similar warning banner.
 *
 * Algorithm:
 *   - Look at the last 30 completed Bangkok days from funtopia_daily_cache.
 *   - For each known source in SOURCE_REGISTRY, count how many of the
 *     *cached* look-back days (days 4–30 ago) it had at least 1 order.
 *   - A source is "normally active" when its active-day count is ≥ 30% of
 *     the total number of cached look-back days (not just the days where
 *     the source appeared — a day with no entry for the source means 0).
 *   - Alert fires when the 3 most-recent completed days ALL show 0 orders
 *     for a normally-active source.
 *
 * False-alarm guards:
 *   - Sporadic sources (School, Airport) rarely clear the 30% threshold.
 *   - Look-back window needs ≥ 7 cached days before we raise an alert.
 *   - Recent 3 days must all be in the cache — uncached recent days indicate
 *     a sync gap (separate issue), not a source gap.
 *   - Walk-in (UNATTRIBUTED_SOURCE) and Birthdays are excluded.
 */

import { pool } from "./db";
import { SOURCE_REGISTRY, UNATTRIBUTED_SOURCE, BIRTHDAYS_SOURCE } from "./sourceRegistry";

/** Minimum fraction of cached look-back days a source must appear on to be "active". */
const ACTIVE_THRESHOLD_FRACTION = 0.30;

/** Number of consecutive zero-days required to fire an alert. */
const CONSECUTIVE_ZERO_DAYS = 3;

/** Total history window (calendar days from today, going back). */
const HISTORY_WINDOW_DAYS = 30;

/** Minimum cached look-back days required before we alert. */
const MIN_LOOKBACK_DAYS_WITH_DATA = 7;

export interface SourceGapAlert {
  source: string;
  /** Most recent Bangkok date the source had at least 1 order; null if never seen in window. */
  lastSeenDate: string | null;
  /** How many consecutive completed days (ending yesterday) showed 0 orders. */
  consecutiveZeroDays: number;
  /** Days in the look-back window where source had ≥1 order. */
  activeDaysInWindow: number;
  /** Total cached look-back days (the denominator for the active fraction). */
  windowDays: number;
}

export interface SourceWatchdogResult {
  checkedAt: string;
  alerts: SourceGapAlert[];
}

function bangkokDateDaysAgo(n: number): string {
  // Bangkok = UTC+7. Compute the Bangkok "today" then subtract n days.
  const now = Date.now() + 7 * 3600 * 1000;
  const d = new Date(now - n * 86400 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Pure evaluation function (unit-testable).
 *
 * @param sourceName       - Name of the source being evaluated.
 * @param ordersByDate     - Map of date → order count FOR THIS SOURCE. Dates
 *                           absent from the map mean 0 orders that day.
 * @param recentDates      - The CONSECUTIVE_ZERO_DAYS most-recent completed
 *                           Bangkok dates (newest first). These are the dates
 *                           we check for a zero streak.
 * @param cachedLookbackDates - ALL cached dates in the look-back window
 *                           (days 4..HISTORY_WINDOW_DAYS ago). This is the
 *                           denominator for the active-fraction check. Days
 *                           absent from the cache are excluded from both
 *                           numerator and denominator.
 */
export function evaluateSourceGap(
  sourceName: string,
  ordersByDate: Map<string, number>,
  recentDates: string[],
  cachedLookbackDates: string[],
): SourceGapAlert | null {
  if (recentDates.length < CONSECUTIVE_ZERO_DAYS) return null;

  // Need enough cached look-back days to establish a meaningful baseline.
  if (cachedLookbackDates.length < MIN_LOOKBACK_DAYS_WITH_DATA) return null;

  // Count active days: how many cached look-back days had ≥1 order.
  // Days absent from ordersByDate count as 0 (not excluded from denominator).
  const activeDaysInWindow = cachedLookbackDates.filter(
    (d) => (ordersByDate.get(d) ?? 0) > 0,
  ).length;

  // The denominator is the total number of cached look-back days.
  const fraction = activeDaysInWindow / cachedLookbackDates.length;
  if (fraction < ACTIVE_THRESHOLD_FRACTION) return null;

  // Check the most-recent completed days for a zero streak.
  const recentDaysToCheck = recentDates.slice(0, CONSECUTIVE_ZERO_DAYS);
  const allZero = recentDaysToCheck.every(
    (d) => (ordersByDate.get(d) ?? 0) === 0,
  );
  if (!allZero) return null;

  // Find the most recent date the source was seen (across both windows).
  const allDates = [...recentDates, ...cachedLookbackDates].sort((a, b) =>
    b.localeCompare(a),
  );
  const lastSeenDate =
    allDates.find((d) => (ordersByDate.get(d) ?? 0) > 0) ?? null;

  return {
    source: sourceName,
    lastSeenDate,
    consecutiveZeroDays: CONSECUTIVE_ZERO_DAYS,
    activeDaysInWindow,
    windowDays: cachedLookbackDates.length,
  };
}

/**
 * Load source breakdown data from the daily cache and detect gaps.
 * Only Floresta (funtopia_daily_cache) is monitored — Chalong uses a
 * different breakdown that doesn't map to SOURCE_REGISTRY sources.
 */
export async function getSourceGapAlerts(): Promise<SourceWatchdogResult> {
  // Dates we care about: 1..HISTORY_WINDOW_DAYS days ago in Bangkok.
  // Day 0 = today (possibly incomplete — excluded from checks).
  const allDates: string[] = [];
  for (let i = 1; i <= HISTORY_WINDOW_DAYS; i++) {
    allDates.push(bangkokDateDaysAgo(i));
  }

  // Fetch cached summaries for all relevant dates in one query.
  const result = await pool.query(
    `SELECT date, summary_json->'sourceBreakdown' AS source_breakdown
     FROM funtopia_daily_cache
     WHERE date = ANY($1::text[])`,
    [allDates],
  );

  // Track which dates have been cached.
  const cachedDatesSet = new Set<string>();
  // source → (date → orderCount). Only populated when orders > 0.
  const sourceOrdersByDate = new Map<string, Map<string, number>>();

  for (const row of result.rows) {
    const date: string = row.date;
    const breakdown: Array<{ source: string; orders: number }> =
      row.source_breakdown;
    if (!Array.isArray(breakdown)) continue;
    // Invalidated/missing attribution is unknown, not evidence of zero sales.
    cachedDatesSet.add(date);

    for (const entry of breakdown) {
      if (
        !entry.source ||
        entry.source === UNATTRIBUTED_SOURCE ||
        entry.source === BIRTHDAYS_SOURCE
      ) {
        continue;
      }
      const count = entry.orders ?? 0;
      if (count <= 0) continue; // zero entries stay absent from the map
      let byDate = sourceOrdersByDate.get(entry.source);
      if (!byDate) {
        byDate = new Map();
        sourceOrdersByDate.set(entry.source, byDate);
      }
      byDate.set(date, (byDate.get(date) ?? 0) + count);
    }
  }

  // Split dates into: recent (days 1–3, newest first) and look-back (days 4–30).
  const recentDates = allDates.slice(0, CONSECUTIVE_ZERO_DAYS);
  const lookbackDates = allDates.slice(CONSECUTIVE_ZERO_DAYS);

  // For "zero" detection on recent dates: only alert when all 3 recent dates
  // ARE cached (uncached = sync gap issue, not source gap issue).
  const recentCached = recentDates.filter((d) => cachedDatesSet.has(d));
  if (recentCached.length < CONSECUTIVE_ZERO_DAYS) {
    return { checkedAt: new Date().toISOString(), alerts: [] };
  }

  // Cached look-back dates form the denominator for the active-fraction.
  const cachedLookbackDates = lookbackDates.filter((d) =>
    cachedDatesSet.has(d),
  );

  const alerts: SourceGapAlert[] = [];

  for (const registryEntry of SOURCE_REGISTRY) {
    const source = registryEntry.source;
    const byDate = sourceOrdersByDate.get(source) ?? new Map<string, number>();

    const alert = evaluateSourceGap(
      source,
      byDate,
      recentDates,
      cachedLookbackDates,
    );
    if (alert) alerts.push(alert);
  }

  return { checkedAt: new Date().toISOString(), alerts };
}
