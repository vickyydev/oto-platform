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
 * WHY IT IS A CONTRACT. The API half of S2-05 is being built beside this page,
 * so what follows is what the console asks for rather than a description of
 * something already deployed. Same two rules as observability.ts and fleet.ts:
 * a 404 means "this deployment does not have that route yet" and the page says
 * so, and every field the API has not grown yet is optional so the tab renders
 * correctly today and fills in as the routes land.
 *
 * WHY `/ops/…`. Quarantine is a tab of the Failures page, reached by the same
 * people holding the same permissions, so it sits beside `/ops/failures` and
 * `/ops/runs` rather than under `/edge` or `/sync` — one prefix for "how is
 * the platform running", one guard family, one place to look.
 */
import { api, idemKey, qs } from './client';
import type { SyncAnomalyKind, SyncQuarantineReason, SyncQuarantineStatus } from '@oto/shared';

export type { SyncAnomalyKind, SyncQuarantineReason, SyncQuarantineStatus };

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * One event the cloud refused, as `edge.sync_quarantine` holds it.
 *
 * `payload` is the event whole, because that is the only way to answer the
 * question the page exists for: what was this, and does the park still need
 * it? A discarded event is gone, so the payload has to be readable before the
 * button is pressed rather than after.
 */
export interface QuarantineRow {
  id: string;
  /** The box-minted id of the event itself — what ties it to the box's own log. */
  eventId: string;
  boxId: string;
  /** Denormalised by the API; a box id alone names nothing to a person on call. */
  boxName?: string | null;
  journalEpoch: number;
  boxSeq: number;
  /** `entity.verb` — `member.created`, `visit.opened`. Null on an event too broken to read. */
  type?: string | null;
  schemaVersion?: number | null;
  reason: SyncQuarantineReason | string;
  status: SyncQuarantineStatus | string;
  errorCode?: string | null;
  errorMessage?: string | null;
  payload?: Record<string, unknown> | null;
  payloadHash?: string | null;
  /** Set on a `conflict`: the hash of the event already stored under this id. */
  existingPayloadHash?: string | null;
  occurredAt?: string | null;
  receivedAt: string;
  /** `x-oto-action-id` — the one string that links the till line, the box log and the audit row. */
  actionId?: string | null;
  /** The push's `ops_run`, so the whole batch can be found from one of its events. */
  batchId?: string | null;
  /** What the watchdog raised its alert under; also what groups these rows. */
  alertKey?: string | null;
  resolvedAt?: string | null;
  resolvedByAccountId?: string | null;
  resolvedByName?: string | null;
  resolutionNote?: string | null;
  /** Set when a replay succeeded: the `sync_event` it finally became. */
  replayedEventId?: string | null;
}

export interface QuarantinePage {
  events: QuarantineRow[];
  nextCursor?: string | null;
  /**
   * How many are open across the WHOLE table, not just this page. The tab shows
   * it as a badge, and "quarantine non-empty" is a watchdog rule, so the number
   * has to be the true one rather than the length of the first fifty rows.
   */
  openCount?: number | null;
}

/** What the API says came of a replay. */
export interface ReplayResult {
  ok: true;
  /** `replayed` when it applied; `open` when it was refused again. */
  status: SyncQuarantineStatus | string;
  /** The `sync_event` it became, on success. */
  eventId?: string | null;
  /** Why it was refused a second time. Shown as it arrives — it is the ledger's own words. */
  errorCode?: string | null;
  errorMessage?: string | null;
}

/**
 * An event that WAS applied, with something worth recording about how.
 *
 * Kept on this tab rather than on its own because the two answer one question
 * in sequence — what did not go in, and what went in with a caveat — but they
 * are never mixed into one list: an anomaly needs nobody's decision, and
 * folding them together would inflate the count the watchdog alerts on.
 */
export interface AnomalyRow {
  id: string;
  boxId: string;
  boxName?: string | null;
  kind: SyncAnomalyKind | string;
  /** The event it is about, and the other one where the kind involves two (`merge`). */
  eventId?: string | null;
  relatedEventId?: string | null;
  /** Whatever that kind of anomaly needs to be understandable months later. */
  detail?: Record<string, unknown> | null;
  actionId?: string | null;
  detectedAt: string;
}

export interface AnomalyPage {
  anomalies: AnomalyRow[];
  nextCursor?: string | null;
}

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
  }) => api.get<QuarantinePage>(`/ops/quarantine${qs({ ...params })}`),

  /**
   * Puts the stored event back through the ledger, exactly as the box sent it.
   *
   * It carries an idempotency key for the same reason every other mutation
   * here does: a double press, or a retry over a connection that dropped after
   * the write, must land one replay and give the second press the first one's
   * answer — not apply the event twice.
   */
  replay: (id: string) =>
    api.post<ReplayResult>(`/ops/quarantine/${encodeURIComponent(id)}/replay`, undefined, {
      idempotencyKey: idemKey(),
    }),

  /**
   * Marks it dealt with WITHOUT applying it. The row stays, with who discarded
   * it and why: a fact from a till that the park decided not to keep is itself
   * a thing somebody may have to explain later.
   */
  discard: (id: string, note: string) =>
    api.post<{ ok: true; status: SyncQuarantineStatus | string }>(
      `/ops/quarantine/${encodeURIComponent(id)}/discard`,
      { note },
      { idempotencyKey: idemKey() },
    ),

  anomalies: (params: { kind?: string; boxId?: string; limit?: number; cursor?: string }) =>
    api.get<AnomalyPage>(`/ops/anomalies${qs({ ...params })}`),
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
