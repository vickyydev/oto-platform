import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import {
  auditLog,
  band,
  bandEvent,
  branch,
  box,
  checkin,
  factOccupancy15min,
  member,
  registration,
  sale,
  station,
  type Db,
} from '@oto/db';
import {
  OCCUPANCY_STALE_AFTER_S,
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  type EodStrandedRow,
  type LiveOccupancyView,
} from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import type { BranchReach } from './access-control';
import type { HealthCheck } from './ops';
import type { Exec } from './tx';

/**
 * LIVE OCCUPANCY (S2-12 round 4; plan §2.6, OD-A1, OD-A4).
 *
 * A projection, not a counter. Nothing here is incremented or decremented:
 * every answer is recomputed from the gate's journal (`pos.band_event`,
 * written by the `band.gate_event` sync handler) for one branch and one
 * trading day. That is the prototype's own design, ported: `getLiveOccupancy`
 * (`imports/oto-pos/artifacts/oto-till/src/mockApi.ts:2141-2181`) derives
 * everything "so there are no counters to drift negative" and windows the
 * gate events to today "so nothing strands as in across days".
 *
 * THE RULES, as the prototype and the settled decisions put them:
 *
 *   ADULTS — an adult band is inside when its LATEST passage at this branch
 *     since the trading day started is `entry`. Only `entry` and `exit` count:
 *     `denied`, `timeout` and `alarm` (reverse, tailgating) credit nobody
 *     (plan §2.5). Per-band latest rather than "entries minus exits" is what
 *     makes OD-A4 hold by construction: an exit with no entry before it leaves
 *     that band outside, it cannot take someone else's place off the count,
 *     and the total can never go below zero. A band read in twice (a gate box
 *     swapped mid-visit) is still one person.
 *
 *     Only a band with Gate access is counted this way (SCRUM-494): the
 *     prototype's adults are "gate-access bands whose latest gate event today
 *     is 'in'" (`mockApi.ts:getAdultsInsideNow`).
 *
 *   KIDS — kids' bands never operate the gate (C8, OD-A6), so a child on a
 *     regular ticket counts while at least one adult band OF THE SAME SALE is
 *     inside (OD-A1, R-84; the prototype's `groupId` is the sale here). The
 *     last adult of a sale going out takes that sale's children with them; an
 *     adult coming back brings them back. Only `active` bands count: a
 *     replaced band's successor is on the same sale and would double the
 *     child, and a revoked one was refunded. EVERY band without Gate access
 *     follows its group this way — an adult on a ticket with Gate access off
 *     as well as a kid — and is counted with the kids, as the prototype
 *     counts it (`getLiveOccupancy`: `!w.gateAccess && !w.checkInId &&
 *     groupsWithAdultInside.has(w.groupId)`).
 *
 *   DROP-OFF KIDS (S2-13 round 2, OD-A1) — a child left with the park counts
 *     inside from their check-in to their check-out (`pos.checkin`
 *     `checked_in_at` / `checked_out_at`), independent of any adult of any
 *     sale: no adult of theirs is in the park to be counted. Their band, which
 *     a check-in links, is kept OUT of the sale rule so a supervised child on
 *     a sale that also had an adult is one child, not two — the prototype's
 *     rule exactly (`getLiveOccupancy`: "bands with a checkInId are excluded
 *     from the group rule so they can't double-count"). Windowed to the
 *     trading day like every passage, so nobody strands as inside across days.
 *
 * THE BRANCH is the gate station's, not the band's: a band sold at one park
 * and walked through another's gate is inside the second.
 *
 * THE TRADING DAY starts at `branch.business_day_start` (05:00 Asia/Bangkok by
 * default) — the same boundary the ledger, pricing and the cash-up use
 * (`@oto/shared` business-date.ts). A group still "inside" at the boundary is
 * not carried into the next day: the window simply starts again, and
 * `clearTradingDay` writes the audit row that says who was stranded.
 *
 * MANUAL RESOLUTION (S2-15a round 2). A band or a check-in cleared at close
 * (`pos.occupancy_resolution`) is not counted from its `resolved_at` on; a
 * band that passes the gate again after that is counted as usual. Nothing in
 * the journal or the check-in changes, so a count at an earlier instant stands.
 *
 * WHICH CLOCK places a passage. `band_event.created_at` is the box's own
 * stamp, kept exactly as sent. A Pi has no clock battery, so after a power cut
 * and before its first measurement that stamp can be hours out — and the
 * ledger already says so: `edge.sync_event.clock_trust` is `untrusted` (never
 * measured) or `skewed` (measured, out of tolerance) on the envelope the
 * passage arrived in. Ordering by the raw stamp then lies twice: an exit
 * stamped an hour behind sorts BEFORE the trusted entry it followed, leaving
 * the adult and their sale's children counted inside; a stamp hours out drops
 * the passage out of the trading-day window altogether. So every passage is
 * placed at its EFFECTIVE time — the box's stamp when the ledger trusts that
 * clock, otherwise the moment the cloud took it (`received_at`), which is the
 * same fallback the ledger uses for `business_date`. A passage written with
 * no ledger row (nothing minted on a box) keeps its stamp.
 *
 * WHICH ORDER, when one box's clock was trusted for some of its passages and
 * not for others. Trust is stamped per event as the box queues it, and the
 * clock is measured on the heartbeat — a channel separate from the outbox push
 * — so one batch can carry an entry queued before the measurement (untrusted,
 * placed at `received_at`) and an exit queued after it (trusted, placed at its
 * own stamp, which is EARLIER than the moment the batch landed). By effective
 * time the exit then sorts before the entry it followed, and the family stays
 * counted inside, fresh, for the rest of the day. The ledger already knows
 * the truth: `box_seq` is the box's own gapless order at the lane, and the
 * entry's is lower. So within one box and one journal epoch the passages are
 * ordered by `box_seq` — the physical order at the lane, whatever the clock
 * said — and only across boxes (a band read at two lanes, or a store reset
 * that minted a new epoch) does the effective time decide. A passage with no
 * ledger row has no lane order and is placed by its stamp as before.
 */

interface BranchClock {
  id: string;
  operatorId: string;
  timezone: string;
  businessDayStart: string;
}

export interface OccupancyCount {
  adults: number;
  kids: number;
  total: number;
}

async function branchClock(exec: Exec, branchId: string, operatorId?: string): Promise<BranchClock> {
  const [row] = await exec
    .select({
      id: branch.id,
      operatorId: branch.operatorId,
      timezone: branch.timezone,
      businessDayStart: branch.businessDayStart,
    })
    .from(branch)
    .where(
      operatorId
        ? and(eq(branch.id, branchId), eq(branch.operatorId, operatorId))
        : eq(branch.id, branchId),
    )
    .limit(1);
  if (!row) throw errors.notFound('Branch not found');
  return row;
}

/** The trading day an instant belongs to at a branch. */
function tradingDayOf(clock: BranchClock, at: Date): string {
  return businessDate(at, clock.timezone, parseDayStart(clock.businessDayStart));
}

/**
 * The instant a trading day starts at a branch: its date at the branch's
 * `business_day_start`, on the branch's wall clock. Postgres does the zone
 * arithmetic (`timestamp AT TIME ZONE zone` → timestamptz), so this needs no
 * second copy of the tz database's rules.
 */
async function tradingDayStart(exec: Exec, clock: BranchClock, date: string): Promise<Date> {
  const result = await exec.execute(
    sql`select ((${date}::date + ${clock.businessDayStart}::time) at time zone ${clock.timezone}) as "start"`,
  );
  const value = (result as unknown as { rows: Array<{ start: Date | string }> }).rows[0]!.start;
  return value instanceof Date ? value : new Date(value);
}

/** Lower-case, hyphenated: what the ledger's `event_id` and a box's envelope carry. */
const UUID_SHAPE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * The count at one instant: for every band, its latest passage among those
 * whose effective time (see the header: the box's stamp when trusted, else
 * when the cloud took it) is no later than `at`; the band is inside when that
 * passage is an `entry` placed at or after `from`, the trading day's start.
 * Exported for the job and the tests; the route goes through `liveOccupancy`.
 *
 * "Latest" is settled in two steps (see the header, WHICH ORDER):
 *
 *   1. `lane_latest` — within one box and one journal epoch, the passage with
 *      the highest `box_seq`: the box's own physical order at the lane, which
 *      no clock can misplace. Passages with no ledger row have no lane order
 *      and fall to their stamp.
 *   2. `latest` — across lanes, the newest effective time.
 *
 * The day's start is checked on the SURVIVOR rather than before step 1, so a
 * lane's later exit whose trusted stamp is before the day began still vetoes
 * an untrusted entry the cloud only took after it: the box's order says that
 * band left before the day started, and it is not counted in.
 *
 * The ledger row is reached through `detail->>'sourceEventId'`, which the
 * `band.gate_event` handler writes from the envelope. The uuid cast sits
 * behind a shape check so one malformed detail cannot fail the whole count;
 * a passage with no ledger row (or an unreadable pointer) keeps its stamp.
 */
export async function countAt(
  exec: Exec,
  branchId: string,
  from: Date,
  at: Date,
): Promise<OccupancyCount & { saleIds: string[]; adultBandIds: string[] }> {
  const result = await exec.execute(sql`
    with passage as (
      select
        be.id,
        be.band_id,
        be.kind,
        se.box_id,
        se.journal_epoch,
        se.box_seq,
        case
          when se.event_id is null or se.clock_trust = 'trusted' then be.created_at
          else se.received_at
        end as at
      from pos.band_event be
      join core.station s on s.id = be.station_id
      left join edge.sync_event se
        on se.event_id = case
          when be.detail->>'sourceEventId' ~* ${UUID_SHAPE} then (be.detail->>'sourceEventId')::uuid
        end
      where s.branch_id = ${branchId}
        and be.kind in ('entry', 'exit')
    ),
    reached as (
      select p.* from passage p
      where p.at <= ${at.toISOString()}::timestamptz
    ),
    lane_latest as (
      select distinct on (r.band_id, r.box_id, r.journal_epoch) r.id, r.band_id, r.kind, r.at
      from reached r
      order by r.band_id, r.box_id, r.journal_epoch, r.box_seq desc nulls last, r.at desc, r.id desc
    ),
    latest as (
      select distinct on (l.band_id) l.band_id, l.kind, l.at
      from lane_latest l
      order by l.band_id, l.at desc, l.id desc
    ),
    inside as (
      select b.id, b.sale_id, b.event_checkin_id
      from latest l
      join pos.band b on b.id = l.band_id
      where l.kind = 'entry' and b.gate_access
        and l.at >= ${from.toISOString()}::timestamptz
        and not exists (
          select 1 from pos.occupancy_resolution r
          where r.band_id = b.id
            and r.resolved_at >= l.at
            and r.resolved_at <= ${at.toISOString()}::timestamptz
        )
    )
    select
      coalesce((select json_agg(i.id order by i.id) from inside i), '[]'::json) as "adultBandIds",
      coalesce((select json_agg(distinct i.sale_id) filter (where i.sale_id is not null) from inside i), '[]'::json) as "saleIds",
      -- A kid follows its group: the sale its ticket was on, or — S2-20 E3 —
      -- the event check-in that issued it and its parent's band.
      (select count(*)::int from pos.band k
        where not k.gate_access and k.status = 'active'
          and (k.sale_id in (select i.sale_id from inside i where i.sale_id is not null)
            or k.event_checkin_id in (select i.event_checkin_id from inside i where i.event_checkin_id is not null))
          and not exists (select 1 from pos.checkin c where c.band_id = k.id)) as "kids",
      (select count(*)::int from pos.checkin c
        where c.branch_id = ${branchId}
          and c.status <> 'registered'
          and c.checked_in_at is not null
          and c.checked_in_at >= ${from.toISOString()}::timestamptz
          and c.checked_in_at <= ${at.toISOString()}::timestamptz
          and (c.checked_out_at is null or c.checked_out_at > ${at.toISOString()}::timestamptz)
          and not exists (
            select 1 from pos.occupancy_resolution r
            where r.checkin_id = c.id and r.resolved_at <= ${at.toISOString()}::timestamptz
          )) as "dropOffKids"
  `);
  const row = (result as unknown as {
    rows: Array<{ adultBandIds: string[]; saleIds: string[]; kids: number; dropOffKids: number }>;
  }).rows[0]!;
  const adults = row.adultBandIds.length;
  const kids = Number(row.kids) + Number(row.dropOffKids);
  return { adults, kids, total: adults + kids, saleIds: row.saleIds, adultBandIds: row.adultBandIds };
}

// --- Stranded at close (S2-15a round 2) ---------------------------------------

/**
 * Who the branch still counts inside on one trading day, as the End of Day
 * lists them: every adult band `countAt` holds inside, and every child checked
 * in and not checked out, at the end of that day or now, whichever is sooner.
 * A row cleared by a manual resolution (`pos.occupancy_resolution`) is not
 * counted, so it is not listed.
 */
export async function strandedOf(
  exec: Exec,
  input: { operatorId: string; branchId: string; date: string; now: Date },
): Promise<{ rows: EodStrandedRow[]; at: Date }> {
  const clock = await branchClock(exec, input.branchId, input.operatorId);
  const from = await tradingDayStart(exec, clock, input.date);
  const end = await tradingDayStart(exec, clock, addDaysToIsoDate(input.date, 1));
  const at = new Date(Math.min(input.now.getTime(), end.getTime() - 1));
  if (at.getTime() < from.getTime()) return { rows: [], at };
  const count = await countAt(exec, clock.id, from, at);

  const bands = count.adultBandIds.length
    ? await exec
        .select({
          id: band.id,
          code: band.code,
          saleId: band.saleId,
          eventCheckinId: band.eventCheckinId,
          memberId: band.memberId,
        })
        .from(band)
        .where(inArray(band.id, count.adultBandIds))
        .orderBy(asc(band.code))
    : [];
  const checkins = await exec
    .select({
      id: checkin.id,
      childName: checkin.childName,
      checkedInAt: checkin.checkedInAt,
      saleId: checkin.saleId,
      bandCode: band.code,
      guardianName: registration.guardianName,
      guardianPhone: registration.guardianPhone,
    })
    .from(checkin)
    .innerJoin(registration, eq(registration.id, checkin.registrationId))
    .leftJoin(band, eq(band.id, checkin.bandId))
    .where(
      and(
        eq(checkin.branchId, clock.id),
        ne(checkin.status, 'registered'),
        isNotNull(checkin.checkedInAt),
        gte(checkin.checkedInAt, from),
        lte(checkin.checkedInAt, at),
        or(isNull(checkin.checkedOutAt), gt(checkin.checkedOutAt, at)),
        sql`not exists (select 1 from pos.occupancy_resolution r where r.checkin_id = ${checkin.id} and r.resolved_at <= ${at.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(asc(checkin.checkedInAt), asc(checkin.id));

  const saleIds = [
    ...new Set([...bands.map((b) => b.saleId), ...checkins.map((c) => c.saleId)].filter((id): id is string => !!id)),
  ];
  const sales = saleIds.length
    ? await exec.select({ id: sale.id, receiptNumber: sale.receiptNumber, memberId: sale.memberId }).from(sale).where(inArray(sale.id, saleIds))
    : [];
  const saleById = new Map(sales.map((s) => [s.id, s]));
  const memberIds = [
    ...new Set([...bands.map((b) => b.memberId), ...sales.map((s) => s.memberId)].filter((id): id is string => !!id)),
  ];
  const members = memberIds.length
    ? await exec.select({ id: member.id, nickname: member.nickname, name: member.name, phone: member.phone }).from(member).where(inArray(member.id, memberIds))
    : [];
  const memberById = new Map(members.map((m) => [m.id, m]));

  const bandIds = bands.map((b) => b.id);
  const events = bandIds.length
    ? await exec
        .select({ bandId: bandEvent.bandId, kind: bandEvent.kind, createdAt: bandEvent.createdAt, stationName: station.name })
        .from(bandEvent)
        .innerJoin(station, eq(station.id, bandEvent.stationId))
        .where(
          and(
            inArray(bandEvent.bandId, bandIds),
            inArray(bandEvent.kind, ['entry', 'exit']),
            eq(station.branchId, clock.id),
            lte(bandEvent.createdAt, at),
          ),
        )
        .orderBy(desc(bandEvent.createdAt), desc(bandEvent.id))
    : [];
  const lastEvent = new Map<string, (typeof events)[number]>();
  for (const e of events) if (!lastEvent.has(e.bandId)) lastEvent.set(e.bandId, e);

  /**
   * The group a band's children follow: its sale, or — S2-20 E3 — the event
   * check-in that issued an event parent band and its child's kid band.
   */
  const groupOf = (b: { saleId: string | null; eventCheckinId: string | null }): string =>
    b.saleId ?? `event:${b.eventCheckinId ?? ''}`;
  const bandSaleIds = [...new Set(bands.map((b) => b.saleId).filter((id): id is string => !!id))];
  const bandCheckinIds = [...new Set(bands.map((b) => b.eventCheckinId).filter((id): id is string => !!id))];
  const kids =
    bandSaleIds.length || bandCheckinIds.length
      ? await exec
          .select({ saleId: band.saleId, eventCheckinId: band.eventCheckinId, n: sql<number>`count(*)::int` })
          .from(band)
          .where(
            and(
              or(
                bandSaleIds.length ? inArray(band.saleId, bandSaleIds) : sql`false`,
                bandCheckinIds.length ? inArray(band.eventCheckinId, bandCheckinIds) : sql`false`,
              ),
              eq(band.gateAccess, false),
              eq(band.status, 'active'),
              sql`not exists (select 1 from pos.checkin c where c.band_id = ${band.id})`,
            ),
          )
          .groupBy(band.saleId, band.eventCheckinId)
      : [];
  const kidsByGroup = new Map(kids.map((k) => [groupOf(k), Number(k.n)]));
  /** A group's children go with its first listed band, so none is counted twice. */
  const kidsShown = new Set<string>();

  const guardianOf = (memberId: string | null) => {
    const m = memberId ? memberById.get(memberId) : undefined;
    return m ? { name: m.nickname || m.name, phone: m.phone } : null;
  };
  const rows: EodStrandedRow[] = bands.map((b) => {
    const s = b.saleId ? saleById.get(b.saleId) : undefined;
    const ev = lastEvent.get(b.id);
    const group = groupOf(b);
    const first = !kidsShown.has(group);
    kidsShown.add(group);
    return {
      kind: 'band',
      subjectId: b.id,
      bandCode: b.code,
      childName: null,
      childrenWithBand: first ? (kidsByGroup.get(group) ?? 0) : 0,
      lastGateEvent: ev ? { kind: ev.kind, at: ev.createdAt.toISOString(), stationName: ev.stationName } : null,
      checkedInAt: null,
      // An event parent band (S2-20 E3) was issued by a check-in, not a sale.
      sale: b.saleId ? { saleId: b.saleId, receiptNumber: s?.receiptNumber ?? null } : null,
      guardian: guardianOf(b.memberId ?? s?.memberId ?? null),
    };
  });
  for (const c of checkins) {
    const s = c.saleId ? saleById.get(c.saleId) : undefined;
    rows.push({
      kind: 'checkin',
      subjectId: c.id,
      bandCode: c.bandCode,
      childName: c.childName,
      childrenWithBand: 0,
      lastGateEvent: null,
      checkedInAt: c.checkedInAt?.toISOString() ?? null,
      sale: c.saleId ? { saleId: c.saleId, receiptNumber: s?.receiptNumber ?? null } : null,
      guardian: { name: c.guardianName, phone: c.guardianPhone },
    });
  }
  return { rows, at };
}

// --- Freshness ---------------------------------------------------------------

export interface GateFreshness {
  gates: number;
  /** The newest moment every gate box can vouch for; null if any never has. */
  asOf: Date | null;
  stale: boolean;
}

/**
 * How recent the count can claim to be.
 *
 * The gate box is authoritative and the cloud only knows what it has been
 * handed. A box is vouched for up to its most recent contact — a heartbeat
 * (every 60 s) or a sync push, whichever is newer — LESS the age of anything
 * it said it still holds unsent (`oldestUnackedAgeS` on that heartbeat): a
 * box that is calling home with a gate fact stuck in its outbox is not
 * current however recently it called. A box that says it is offline vouches
 * for nothing after the heartbeat that said so.
 *
 * `stale` when there is no gate box at the branch (nothing counts anyone in),
 * when any gate box has never been heard from, or when the oldest vouched-for
 * moment is older than `OCCUPANCY_STALE_AFTER_S`.
 *
 * A live gate LANE with no box — or whose box is archived — is a lane whose
 * passages nothing can report, so it is a gate never heard from: `asOf` null
 * and stale, even while another lane's box at the same branch is current.
 * `gates` stays the number of boxes the answer is built from.
 */
export async function gateFreshness(exec: Exec, branchId: string, now: Date): Promise<GateFreshness> {
  const laneBoxIds = (
    await exec
      .selectDistinct({ boxId: station.boxId })
      .from(station)
      .where(and(eq(station.branchId, branchId), eq(station.kind, 'gate'), isNull(station.archivedAt)))
  ).map((r) => r.boxId);
  const gateBoxIds = laneBoxIds.filter((id): id is string => id !== null);
  if (gateBoxIds.length === 0) return { gates: 0, asOf: null, stale: true };

  const rows = await exec
    .select({
      id: box.id,
      lastHeartbeatAt: box.lastHeartbeatAt,
      lastStatus: box.lastStatus,
      lastPushAt: sql<Date | string | null>`(select max(c.last_push_at) from edge.sync_cursor c where c.box_id = ${box.id})`,
    })
    .from(box)
    .where(and(inArray(box.id, gateBoxIds), isNull(box.archivedAt)));
  if (rows.length === 0) return { gates: 0, asOf: null, stale: true };
  const found = new Set(rows.map((r) => r.id));
  if (laneBoxIds.some((id) => id === null || !found.has(id))) return { gates: rows.length, asOf: null, stale: true };

  let asOf: number | null = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    const heartbeat = r.lastHeartbeatAt ? r.lastHeartbeatAt.getTime() : null;
    const push = r.lastPushAt ? new Date(r.lastPushAt).getTime() : null;
    let vouched = heartbeat === null ? push : push === null ? heartbeat : Math.max(heartbeat, push);
    const status = (r.lastStatus ?? null) as Record<string, unknown> | null;
    if (vouched !== null && heartbeat !== null && status) {
      const unacked = typeof status.oldestUnackedAgeS === 'number' ? status.oldestUnackedAgeS : null;
      if (unacked !== null && unacked > 0) vouched = Math.min(vouched, heartbeat - unacked * 1000);
      if (status.offline === true && (push === null || push <= heartbeat)) vouched = Math.min(vouched, heartbeat);
    }
    if (vouched === null) {
      asOf = null;
      break;
    }
    asOf = Math.min(asOf, vouched);
  }
  const at = asOf === null ? null : new Date(asOf);
  const stale = at === null || now.getTime() - at.getTime() > OCCUPANCY_STALE_AFTER_S * 1000;
  return { gates: rows.length, asOf: at, stale };
}

// --- The route's answer ------------------------------------------------------

/** `GET /branches/:id/occupancy` — the count now, and how far it can be believed. */
export async function liveOccupancy(
  exec: Exec,
  input: { operatorId: string; branchId: string; now?: Date },
): Promise<LiveOccupancyView> {
  const now = input.now ?? new Date();
  const clock = await branchClock(exec, input.branchId, input.operatorId);
  const day = tradingDayOf(clock, now);
  const from = await tradingDayStart(exec, clock, day);
  const count = await countAt(exec, clock.id, from, now);
  const fresh = await gateFreshness(exec, clock.id, now);
  return {
    adults: count.adults,
    kids: count.kids,
    total: count.total,
    asOf: fresh.asOf ? fresh.asOf.toISOString() : null,
    stale: fresh.stale,
    staleAfterSeconds: OCCUPANCY_STALE_AFTER_S,
    gates: fresh.gates,
    businessDate: day,
  };
}

// --- The fact job ------------------------------------------------------------

export const OCCUPANCY_JOB = 'job:occupancy.facts';

const QUARTER_MS = 15 * 60 * 1000;

/** How many quarter-hours back each run recomputes, so late passages correct them. */
export const FACT_LOOKBACK_BUCKETS = 8;

export function quarterHourFloor(at: Date): Date {
  return new Date(Math.floor(at.getTime() / QUARTER_MS) * QUARTER_MS);
}

/** Branches with at least one live gate station — the only ones that can be counted. */
async function gateBranches(exec: Exec): Promise<BranchClock[]> {
  return exec
    .selectDistinct({
      id: branch.id,
      operatorId: branch.operatorId,
      timezone: branch.timezone,
      businessDayStart: branch.businessDayStart,
    })
    .from(branch)
    .innerJoin(station, eq(station.branchId, branch.id))
    .where(and(isNull(branch.archivedAt), eq(station.kind, 'gate'), isNull(station.archivedAt)));
}

/**
 * Upsert one quarter-hour: the count AT `bucketStart`, over the trading day
 * that instant falls in. Recomputed from the journal every time, so writing it
 * twice writes the same row, and a passage that arrived late (a gate box that
 * was offline) is reflected the next time the bucket is recomputed.
 */
export async function writeOccupancyBucket(
  exec: Exec,
  clock: BranchClock,
  bucketStart: Date,
): Promise<OccupancyCount & { businessDate: string }> {
  const day = tradingDayOf(clock, bucketStart);
  const from = await tradingDayStart(exec, clock, day);
  const count = await countAt(exec, clock.id, from, bucketStart);
  await exec
    .insert(factOccupancy15min)
    .values({
      id: newId(),
      operatorId: clock.operatorId,
      branchId: clock.id,
      bucketStart,
      businessDate: day,
      adults: count.adults,
      kids: count.kids,
    })
    .onConflictDoUpdate({
      target: [factOccupancy15min.branchId, factOccupancy15min.bucketStart],
      set: {
        adults: count.adults,
        kids: count.kids,
        businessDate: day,
        updatedAt: new Date(),
      },
    });
  return { adults: count.adults, kids: count.kids, total: count.total, businessDate: day };
}

export interface OccupancyJobDetail extends Record<string, unknown> {
  branches: number;
  buckets: number;
  cleared: number;
}

/**
 * How many ended trading days each run offers to close. One would do while
 * the job runs every five minutes; the rest is for a platform that was down
 * across a day boundary or longer, so the days it missed still get their
 * audit row once it is back. A day already closed costs one indexed lookup.
 */
export const DAY_END_CLEAR_LOOKBACK_DAYS = 7;

/**
 * `job:occupancy.facts` — for every branch with a gate: the current
 * quarter-hour and the `FACT_LOOKBACK_BUCKETS` before it, then the day-end
 * clear of the trading days that have ended, `DAY_END_CLEAR_LOOKBACK_DAYS`
 * back. Everything is reckoned from the job's `now`: the buckets, which day
 * is "today", and whether a day has ended.
 */
export async function runOccupancyJob(db: Db, now: Date): Promise<OccupancyJobDetail> {
  const branches = await gateBranches(db);
  let buckets = 0;
  let cleared = 0;
  const current = quarterHourFloor(now).getTime();
  for (const clock of branches) {
    for (let i = FACT_LOOKBACK_BUCKETS; i >= 0; i--) {
      await writeOccupancyBucket(db, clock, new Date(current - i * QUARTER_MS));
      buckets++;
    }
    const today = tradingDayOf(clock, now);
    for (let d = 1; d <= DAY_END_CLEAR_LOOKBACK_DAYS; d++) {
      if ((await clearTradingDay(db, clock, addDaysToIsoDate(today, -d), now)).cleared) cleared++;
    }
  }
  return { branches: branches.length, buckets, cleared };
}

// --- The day-end clear -------------------------------------------------------

export const DAY_END_CLEAR_ACTION = 'occupancy.day_end_clear';

/**
 * CLOSE A TRADING DAY'S STRANDED GROUPS, WITH A RECORD.
 *
 * Nobody is still inside at 05:00; a band whose last passage was an entry is
 * an exit the gate never saw (a lane held open for a fire alarm, a gate box
 * swapped, somebody leaving through a door with no reader). The projection
 * already forgets them — its window starts again — so this changes no count.
 * What it adds is the record: one audit row per branch per trading day that
 * ended with anyone still counted inside, naming the sales and adult bands so
 * a manager can see which groups the gate lost track of.
 *
 * Nothing is written to the gate's journal. An `exit` the gate did not report
 * would be an invented passage, and the journal is the gate's word alone.
 *
 * Idempotent on (branch, trading day): the audit row's entity id is
 * `<branchId>:<date>`, looked up before writing. Only a day that has ENDED is
 * closed; asking for today does nothing.
 */
export async function clearTradingDay(
  db: Db,
  clock: BranchClock,
  date: string,
  now: Date = new Date(),
): Promise<{ cleared: boolean; count: OccupancyCount }> {
  const from = await tradingDayStart(db, clock, date);
  const end = await tradingDayStart(db, clock, addDaysToIsoDate(date, 1));
  const none = { adults: 0, kids: 0, total: 0 };
  if (end.getTime() > now.getTime()) return { cleared: false, count: none };
  const entityId = `${clock.id}:${date}`;
  return db.transaction(async (tx) => {
    // One closer per branch-day, even with two job instances racing.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`occupancy.day_end:${entityId}`}))`);
    const [done] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, 'occupancy_day'),
          eq(auditLog.entityId, entityId),
          eq(auditLog.action, DAY_END_CLEAR_ACTION),
        ),
      )
      .limit(1);
    if (done) return { cleared: false, count: none };
    const stranded = await countAt(tx, clock.id, from, new Date(end.getTime() - 1));
    if (stranded.total === 0) return { cleared: false, count: none };
    await audit.record(tx, {
      actorAccountId: null,
      operatorId: clock.operatorId,
      branchId: clock.id,
      action: DAY_END_CLEAR_ACTION,
      entityType: 'occupancy_day',
      entityId,
      before: {
        businessDate: date,
        adults: stranded.adults,
        kids: stranded.kids,
        saleIds: stranded.saleIds,
        adultBandIds: stranded.adultBandIds,
      },
      after: { businessDate: date, adults: 0, kids: 0 },
      requestId: null,
    });
    return {
      cleared: true,
      count: { adults: stranded.adults, kids: stranded.kids, total: stranded.total },
    };
  });
}

// --- The Health row ----------------------------------------------------------

/**
 * The `occupancy` tile on Health: every gate branch in the caller's reach,
 * its count now, and whether the gate is current. `unknown` with no gate
 * anywhere in reach; `warn` when any branch's count is stale.
 */
export async function occupancyHealthCheck(
  db: Db,
  operatorId: string,
  reach: BranchReach | undefined,
  now: Date = new Date(),
): Promise<HealthCheck> {
  let branches = (await gateBranches(db)).filter((b) => b.operatorId === operatorId);
  if (reach && reach.kind === 'branches') {
    const allowed = new Set(reach.branchIds);
    branches = branches.filter((b) => allowed.has(b.id));
  }
  if (branches.length === 0) {
    return {
      key: 'occupancy',
      label: 'Live occupancy',
      status: 'unknown',
      value: null,
      detail: 'no gate station at any branch you can see',
    };
  }
  const names = new Map(
    (
      await db
        .select({ id: branch.id, name: branch.name })
        .from(branch)
        .where(inArray(branch.id, branches.map((b) => b.id)))
    ).map((r) => [r.id, r.name]),
  );
  let total = 0;
  let anyStale = false;
  const lines: string[] = [];
  for (const b of branches) {
    const view = await liveOccupancy(db, { operatorId, branchId: b.id, now });
    total += view.total;
    anyStale ||= view.stale;
    const name = names.get(b.id) ?? b.id;
    lines.push(
      view.stale
        ? `${name}: ${view.total} counted, stale since ${view.asOf ?? 'never'}`
        : `${name}: ${view.total} in park (${view.adults} adults, ${view.kids} kids)`,
    );
  }
  return {
    key: 'occupancy',
    label: 'Live occupancy',
    status: anyStale ? 'warn' : 'ok',
    value: total,
    unit: 'people',
    detail: lines.join(' · '),
  };
}
