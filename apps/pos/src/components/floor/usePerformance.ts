import { useCallback, useEffect, useRef, useState } from 'react';
import { floorReportOf, getAnalyticsSummary } from '@/api/analytics';
import { boardApi } from '@/api/checkin';
import { getBranches } from '@/store/catalogStore';
import type { FloorReport } from '@/types';

/**
 * S2-15b round 3 — the Performance tab's figures, from the platform's
 * rolled-up day (`GET /analytics/summary`) rather than this browser's copy of
 * the sales (`mockApi.getFloorReport`). Re-read whenever the day, the branch
 * or the scope changes, and every minute while the day is today, so the tab
 * follows the rollup as the day trades.
 *
 * `scope` is the one control the round adds (UI addition): `branch` reads the
 * Today section's branch, `all` every branch this account may read, added up
 * on the platform. `readable` is what the platform says this account may
 * read, so the choice is offered only to somebody with more than one.
 */
export type PerformanceScope = 'branch' | 'all';

export interface PerformanceState {
  /** Null until the first answer for this day, branch and scope lands. */
  report: FloorReport | null;
  /** The day is still moving: today, or not yet rolled up. */
  provisional: boolean;
  /** When the figures were last brought up to date (ISO), or null when never. */
  updatedAt: string | null;
  /** The branch timezone the times are shown in. */
  timezone: string | null;
  /** The business date in progress at the branch, as the platform answered it. */
  today: string | null;
  /** The branch's business day start, `HH:MM`. */
  businessDayStart: string | null;
  /** Every branch this account may read, as the platform answered. */
  readable: ReadonlyArray<{ branchId: string; name: string }>;
  /** The platform ids of the branches the figures cover. */
  branchIds: readonly string[];
  /** Why the figures could not be read, in the platform's words. */
  error: string | null;
}

const EMPTY: PerformanceState = {
  report: null,
  provisional: false,
  updatedAt: null,
  timezone: null,
  today: null,
  businessDayStart: null,
  readable: [],
  branchIds: [],
  error: null,
};

const messageOf = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

/** How often an open day is read again: the rollup itself runs every few minutes. */
export const PERFORMANCE_REFRESH_MS = 60_000;

export function usePerformance(date: string, branch: string, scope: PerformanceScope, live: boolean): PerformanceState {
  const apiId = getBranches().find((b) => b.id === branch)?.apiId ?? null;
  const key = `${scope}:${scope === 'all' ? '' : branch}:${date}`;
  const [state, setState] = useState<{ key: string; value: PerformanceState } | null>(null);
  const [readable, setReadable] = useState<PerformanceState['readable']>([]);
  const current = useRef(key);
  current.current = key;

  const load = useCallback(async () => {
    const asked = key;
    if (!apiId && scope === 'branch') {
      setState({ key: asked, value: { ...EMPTY, error: 'This branch is not linked to the platform yet.' } });
      return;
    }
    try {
      const answer = await getAnalyticsSummary({
        branches: scope === 'branch' && apiId ? [apiId] : undefined,
        from: date,
        to: date,
        group: 'total',
      });
      if (current.current !== asked) return;
      const row = answer.merged[0];
      if (!row) throw new Error('The platform answered without the day.');
      setReadable(answer.readable);
      setState({
        key: asked,
        value: {
          report: floorReportOf(row, date, branch),
          provisional: row.provisional,
          // An open day is as fresh as the last rollup; a closed one as its last rewrite.
          updatedAt: row.provisional ? answer.lastRolledUpAt : row.computedAt,
          timezone: answer.branches[0]?.timezone ?? null,
          // So the freshness line can tell an update earlier today from one
          // left over from an earlier day (a stalled rollup).
          today: answer.branches[0]?.today ?? null,
          businessDayStart: answer.branches[0]?.businessDayStart ?? null,
          readable: answer.readable,
          branchIds: answer.branches.map((b) => b.branchId),
          error: null,
        },
      });
    } catch (err) {
      if (current.current !== asked) return;
      // A failed re-read keeps the figures already on screen for this key.
      setState((prev) =>
        prev && prev.key === asked && prev.value.report
          ? prev
          : { key: asked, value: { ...EMPTY, error: messageOf(err, 'The platform did not answer.') } },
      );
    }
  }, [apiId, branch, date, key, scope]);

  useEffect(() => {
    void load();
    if (!live) return;
    const timer = setInterval(() => void load(), PERFORMANCE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, live]);

  const value = state && state.key === key ? state.value : EMPTY;
  return { ...value, readable: value.readable.length > 0 ? value.readable : readable };
}

/**
 * "Drop-off kids in park" — live, not date-bound, as the card says: the
 * platform's check-ins in the park right now, at each branch the figures
 * cover, added up. Null (shown as "—") until every branch has answered, or
 * when one could not be read.
 */
export function useDropOffInPark(branchIds: readonly string[]): number | null {
  const ids = branchIds.join(',');
  const [inPark, setInPark] = useState<{ ids: string; count: number | null } | null>(null);
  useEffect(() => {
    if (!ids) return;
    let live = true;
    Promise.all(ids.split(',').map((id) => boardApi.today(id)))
      .then((boards) => live && setInPark({ ids, count: boards.reduce((sum, b) => sum + b.inPark, 0) }))
      .catch(() => live && setInPark({ ids, count: null }));
    return () => {
      live = false;
    };
  }, [ids]);
  return inPark && inPark.ids === ids ? inPark.count : null;
}
