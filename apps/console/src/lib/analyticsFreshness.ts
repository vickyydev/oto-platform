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
