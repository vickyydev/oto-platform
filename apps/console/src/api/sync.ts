/**
 * What the sync ledger could not accept, and what it accepted with a caveat.
 *
 * WHY IT IS A FILE OF ITS OWN rather than more of observability.ts: these read
 * the `edge` schema, not `ops_run`, and the difference matters to the reader.
 * A failed run is something the platform tried to do. A quarantined event is a
 * FACT FROM A TILL — a member somebody typed in, a sale somebody rang up —
 * that the cloud refused to file. Nobody at the counter did anything wrong and
 * nothing there can be retried; the decision is here, and it is a decision
 * about a real thing that happened at the park.
 *
 * The shapes below are aliases of the API's registered output schemas. Missing
 * records remain distinct from endpoints absent on a deployment.
 *
 * WHY `/ops/…`. Quarantine is a tab of the Failures page, reached by the same
 * people holding the same permissions, so it sits beside `/ops/failures` and
 * `/ops/runs` rather than under `/edge` or `/sync` — one prefix for "how is
 * the platform running", one guard family, one place to look.
 */
import { api, idemKey, qs } from './client';
import type { ApiResponse } from '@oto/api-types';
import type { SyncAnomalyKind, SyncQuarantineReason, SyncQuarantineStatus } from '@oto/shared';

export type { SyncAnomalyKind, SyncQuarantineReason, SyncQuarantineStatus };

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Event metadata only; the native read does not expose the stored payload. */
export type QuarantinePage = ApiResponse<'/ops/quarantine', 'get'>;
export type QuarantineRow = QuarantinePage['events'][number];
export type ReplayResult = ApiResponse<'/ops/quarantine/{quarantineId}/replay', 'post'>;
export type AnomalyPage = ApiResponse<'/ops/anomalies', 'get'>;
export type AnomalyRow = AnomalyPage['anomalies'][number];

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const quarantineApi = {
  list: (params: {
    status?: string;
    reason?: string;
    boxId?: string;
    limit?: number;
    cursor?: string;
  }) => api.get<ApiResponse<'/ops/quarantine', 'get'>>(`/ops/quarantine${qs({ ...params })}`),

  /**
   * Puts the stored event back through the ledger, exactly as the box sent it.
   *
   * It carries an idempotency key for the same reason every other mutation
   * here does: a double press, or a retry over a connection that dropped after
   * the write, must land one replay and give the second press the first one's
   * answer — not apply the event twice.
   */
  replay: (id: string) =>
    api.post<ApiResponse<'/ops/quarantine/{quarantineId}/replay', 'post'>>(`/ops/quarantine/${encodeURIComponent(id)}/replay`, undefined, {
      idempotencyKey: idemKey(),
    }),

  /**
   * Marks it dealt with WITHOUT applying it. The row stays, with who discarded
   * it and why: a fact from a till that the park decided not to keep is itself
   * a thing somebody may have to explain later.
   */
  discard: (id: string, note: string) =>
    api.post<ApiResponse<'/ops/quarantine/{quarantineId}/discard', 'post'>>(
      `/ops/quarantine/${encodeURIComponent(id)}/discard`,
      { note },
      { idempotencyKey: idemKey() },
    ),

  anomalies: (params: { kind?: string; boxId?: string; limit?: number; cursor?: string }) =>
    api.get<ApiResponse<'/ops/anomalies', 'get'>>(`/ops/anomalies${qs({ ...params })}`),
};

// ---------------------------------------------------------------------------
// Grouping — the same idea the Failures list is built on
// ---------------------------------------------------------------------------

export interface QuarantineGroup {
  key: string;
  reason: SyncQuarantineReason | string;
  /** Null when the group's events were too broken to read a type out of. */
  type: string | null;
  boxId: string;
  boxName: string | null;
  count: number;
  openCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Newest first, so a drawer opens on the one that just happened. */
  events: QuarantineRow[];
}

/**
 * Grouped HERE rather than by the API, unlike the failure list.
 *
 * Two reasons. The quarantine table is small by construction — an event only
 * lands in it when the cloud refused to file it, and a park where that is
 * common has a bigger problem than a long list. And the grouping key is a
 * judgement about how a reader should see the rows (one poison shape from one
 * box is one problem), which is easier to get right beside the page that draws
 * it than in a route that would have to be re-deployed to change its mind.
 *
 * `alert_key` wins when the API sets one, because that is the key the watchdog
 * raised its alert under and the two must agree about what "one problem" is.
 */
export function groupQuarantine(rows: QuarantineRow[]): QuarantineGroup[] {
  const groups = new Map<string, QuarantineGroup>();
  for (const row of rows) {
    const key = row.alertKey ?? `${row.reason}:${row.type ?? 'unreadable'}:${row.boxId}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        reason: row.reason,
        type: row.type ?? null,
        boxId: row.boxId,
        boxName: row.boxName ?? null,
        count: 1,
        openCount: row.status === 'open' ? 1 : 0,
        firstSeenAt: row.receivedAt,
        lastSeenAt: row.receivedAt,
        events: [row],
      });
      continue;
    }
    existing.count += 1;
    if (row.status === 'open') existing.openCount += 1;
    if (row.receivedAt < existing.firstSeenAt) existing.firstSeenAt = row.receivedAt;
    if (row.receivedAt > existing.lastSeenAt) existing.lastSeenAt = row.receivedAt;
    existing.boxName = existing.boxName ?? row.boxName ?? null;
    existing.type = existing.type ?? row.type ?? null;
    existing.events.push(row);
  }
  for (const group of groups.values()) {
    group.events.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }
  // Open problems first, then whatever happened most recently: a group somebody
  // has already dealt with should not sit above one still waiting on them.
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.openCount > 0) - Number(a.openCount > 0) ||
      b.lastSeenAt.localeCompare(a.lastSeenAt),
  );
}
