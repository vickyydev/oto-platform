import { sql } from 'drizzle-orm';
import { GATE_EVENT_KINDS, bandShortCode, type GateEventKind } from '@oto/shared';
import { findBandsByCode } from './bands';
import { GATE_DETAIL_UUID_SHAPE } from './occupancy';
import type { Exec } from './tx';

/**
 * SCRUM-674 — ONE BAND'S GATE JOURNAL, read at one park.
 *
 * The POS's own reader of `pos.band_event`, for the support lookup and for
 * anybody who holds `pos:checkin:read` at the park: which lanes the band went
 * through, in which direction, and what the reader refused. It reads and it
 * writes nothing.
 *
 * THE PARK IS THE GATE STATION'S, not the band's, as it is for the occupancy
 * count (`occupancy.ts`): a band sold at one park and walked through another's
 * gate is in the second park's journal, so somebody who holds the permission
 * at the first sees only what happened there.
 *
 * THE TIME IS THE EFFECTIVE ONE. A passage carries the box's own stamp, and a
 * Pi with no clock battery can be hours out after a power cut, so a passage
 * whose ledger row does not trust that clock is shown at the moment the cloud
 * took it, as the occupancy count places it, and says so (`clockTrusted`).
 *
 * THE BAND'S CODE IS NEVER ANSWERED. It is a gate credential (`scanning.ts` in
 * `@oto/shared`): a row names the band by its id and the short code printed
 * under the QR. Nothing personal is read: the detail is the gate's facts only.
 */

/** A band's journal is short; this bounds a band read at a lane all day. */
export const GATE_EVENTS_LIMIT = 50;

export interface GateEventView {
  id: string;
  bandId: string;
  /** Printed under the QR; never the signed code. */
  bandShortCode: string | null;
  bandKind: string;
  kind: GateEventKind;
  /** The effective time: the box's stamp when the ledger trusts that clock, otherwise when the cloud took it. */
  at: string;
  /** False when the box's clock was not trusted, so `at` is when the cloud took the passage. */
  clockTrusted: boolean;
  stationId: string;
  stationName: string;
  direction: string | null;
  side: string | null;
  /** Why the reader was told not to open. */
  reason: string | null;
  /** Reverse or tailgating. */
  alarm: string | null;
  exitWithoutEntry: boolean;
  /** Let out on a band the deny list names. */
  revoked: boolean;
  /** Decided by the box with the link down. */
  offline: boolean;
}

export interface GateEventsAnswer {
  events: GateEventView[];
  limit: number;
  /** True when the band has more passages at this park than `limit`. */
  truncated: boolean;
}

interface RawGateEvent extends Record<string, unknown> {
  id: string;
  band_id: string;
  kind: GateEventKind;
  detail: Record<string, unknown> | null;
  station_id: string;
  station_name: string;
  at: Date | string;
  clock_trusted: boolean;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/**
 * Every gate fact of the band a key names, newest first, at the gate stations
 * of one park of this operator. A key that names no band of this operator
 * answers nothing, exactly as a band with no journal does.
 */
export async function gateEventsForBand(
  exec: Exec,
  input: { operatorId: string; branchId: string; key: string; limit?: number },
): Promise<GateEventsAnswer> {
  const limit = input.limit ?? GATE_EVENTS_LIMIT;
  const bands = await findBandsByCode(exec, input.operatorId, input.key);
  if (bands.length === 0) return { events: [], limit, truncated: false };
  const byId = new Map(bands.map((b) => [b.id, b]));
  const ids = sql.join(bands.map((b) => sql`${b.id}::uuid`), sql`, `);
  const kinds = sql.join(GATE_EVENT_KINDS.map((k) => sql`${k}`), sql`, `);
  const result = await exec.execute(sql`
    select be.id, be.band_id, be.kind, be.detail, s.id as station_id, s.name as station_name,
      case when se.event_id is null or se.clock_trust = 'trusted' then be.created_at else se.received_at end as at,
      (se.event_id is null or se.clock_trust = 'trusted') as clock_trusted
    from pos.band_event be
    join core.station s on s.id = be.station_id
    left join edge.sync_event se
      on se.event_id = case
        when be.detail->>'sourceEventId' ~* ${GATE_DETAIL_UUID_SHAPE} then (be.detail->>'sourceEventId')::uuid
      end
    where s.branch_id = ${input.branchId}::uuid
      and be.band_id in (${ids})
      and be.kind in (${kinds})
    order by at desc, be.id desc
    limit ${limit + 1}`);
  const rows = result.rows as RawGateEvent[];
  const events = rows.slice(0, limit).map((row): GateEventView => {
    const worn = byId.get(row.band_id)!;
    const detail = row.detail ?? {};
    return {
      id: row.id,
      bandId: row.band_id,
      bandShortCode: bandShortCode(worn.code),
      bandKind: worn.kind,
      kind: row.kind,
      at: new Date(row.at).toISOString(),
      clockTrusted: row.clock_trusted === true,
      stationId: row.station_id,
      stationName: row.station_name,
      direction: text(detail.direction),
      side: text(detail.side),
      reason: text(detail.reason),
      alarm: text(detail.alarm),
      exitWithoutEntry: detail.exitWithoutEntry === true,
      revoked: detail.revoked === true,
      offline: detail.offline === true,
    };
  });
  return { events, limit, truncated: rows.length > limit };
}
