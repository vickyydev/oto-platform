import type { RollupFreshness } from '@/api/observability';

/**
 * S2-15b — Health's "Analytics rollup" card, one line per park per figure set
 * (plan §1; round 6 closing sweep):
 *
 *   the park's name      the daily rollup: what Today > Performance and Radar read
 *   · report figures     the Reports panels' rows, written by the same rollup
 *   · booth figures      the booth report's fact (`job:rollup.booth`)
 *
 * Every park's daily line first, then the report lines, then the booth lines.
 * A line the API does not report (an older API) is left out rather than shown
 * as never rolled up.
 */
export interface AnalyticsFreshnessLine {
  key: string;
  label: string;
  /** ISO, or null when it has never been brought up to date. */
  at: string | null;
  /** The business date in progress at the park. */
  today: string;
}

export function analyticsFreshnessLines(rows: readonly RollupFreshness[]): AnalyticsFreshnessLine[] {
  const daily = rows.map((row) => ({ key: row.branchId, label: row.name, at: row.lastRolledUpAt, today: row.today }));
  const reports = rows.flatMap((row) =>
    row.reportsLastRolledUpAt === undefined
      ? []
      : [{ key: `reports-${row.branchId}`, label: `${row.name} · report figures`, at: row.reportsLastRolledUpAt, today: row.today }],
  );
  const booth = rows.flatMap((row) =>
    row.boothLastRolledUpAt === undefined
      ? []
      : [{ key: `booth-${row.branchId}`, label: `${row.name} · booth figures`, at: row.boothLastRolledUpAt, today: row.today }],
  );
  return [...daily, ...reports, ...booth];
}

/**
 * S2-18 — one line that answers "how fresh is Radar?" for someone who does not
 * know Radar reads the daily rollup.
 *
 * Radar reads every park's daily figures, so it is only as fresh as the park
 * that was brought up to date LEAST recently, and it is "not refreshed yet" while
 * any park has never been rolled up — the same rule as the summary's own
 * `lastRolledUpAt` (analytics-summary.ts). The trading day shown is that park's.
 * No line at all when the API reported no park.
 */
export function radarFreshnessLine(rows: readonly RollupFreshness[]): AnalyticsFreshnessLine | null {
  if (rows.length === 0) return null;
  // ISO strings of one format compare as the instants they name.
  const behind = rows.reduce((oldest, row) => {
    if (oldest.lastRolledUpAt === null) return oldest;
    if (row.lastRolledUpAt === null) return row;
    return row.lastRolledUpAt < oldest.lastRolledUpAt ? row : oldest;
  });
  return { key: 'radar', label: 'Radar last refreshed', at: behind.lastRolledUpAt, today: behind.today };
}
