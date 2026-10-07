import { and, desc, eq, gt, inArray, isNotNull, isNull, sql, type SQLWrapper } from 'drizzle-orm';
import {
  booking,
  box,
  boxState,
  branch,
  checkin,
  device,
  deviceCredential,
  kioskSession,
  station,
  stationDevice,
  type Db,
} from '@oto/db';
import {
  businessDate,
  parseDayStart,
  type KioskDeskAnswer,
  type KioskDeskEntry,
  type KioskDeskState,
  type KioskHealthAnswer,
  type KioskHealthRow,
  type KioskSimulatorAnswer,
  type KioskSimulatorControl,
} from '@oto/shared';
import { AppError } from '../lib/errors';
import { reachCovers, type BranchReach } from './access-control';
import { audit } from './audit';
import { boxSettings, inProcessBox } from './box';
import { withTx, type OpContext } from './tx';

/**
 * S2-20 K2 (SCRUM-217) — THE KIOSK, SEEN FROM THE STAFF SIDE: the desk a
 * guest is sent to, the Console's Kiosk tile on Health, and the virtual
 * kiosk's simulator controls.
 *
 * Every read here is of rows that exist: `pos.kiosk_session` (K1), the
 * booking it names, the check-ins the kiosk's sale left booked, and the
 * station's box and printer. Nothing is kept about a kiosk that is not
 * already kept about a till.
 */

/** "Which business day is this session on", in SQL, for the branch's own clock. */
function businessDayOf(column: SQLWrapper, tz: string, dayStartMinutes: number) {
  return sql<string>`((${column} at time zone ${tz}) - make_interval(mins => ${dayStartMinutes}))::date::text`;
}

/** A day and a half back: every session of the current business day, and an index range for the query. */
const DAY_WINDOW_MS = 36 * 60 * 60 * 1000;

// --- The staff desk -----------------------------------------------------------

const DESK_LIMIT = 30;
const DESK_ORDER: Record<KioskDeskState, number> = { to_redeem: 0, to_check_in: 1, done: 2 };

/**
 * THE FAMILIES A KIOSK SENT TO THE DESK TODAY, with their booking, so a guest
 * who walks over is met with it already on screen.
 *
 * A session sends a guest to the desk whenever it did not issue the whole
 * booking (K1: `desk.required` for every ending but `issued`). Only the ones
 * with a booking are listed — a scan that was not a booking at all left the
 * desk nothing to open. What the desk has left to do is read live:
 *
 *   - failed, or handed off with nothing issued: the booking is redeemed at
 *     the till, so it is `to_redeem` while the booking is still `paid`;
 *   - handed off after the regular bands printed (a mixed booking): the
 *     supervised children wait as booked stays on the kiosk's sale, so it is
 *     `to_check_in` while any of them is still `registered`.
 *
 * One entry per booking, the latest: a family who scanned twice is one
 * family at the desk.
 */
export async function kioskDesk(
  db: Db,
  operatorId: string,
  branchId: string,
  now: Date = new Date(),
): Promise<KioskDeskAnswer> {
  const [br] = await db
    .select({ timezone: branch.timezone, dayStart: branch.businessDayStart })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!br) throw new AppError(404, 'NOT_FOUND', 'Branch not found');
  const dayStartMinutes = parseDayStart(br.dayStart);
  const today = businessDate(now, br.timezone, dayStartMinutes);

  const rows = await db
    .select({
      session: kioskSession,
      stationName: station.name,
      booking: {
        id: booking.id,
        reference: booking.reference,
        kids: booking.kidsCount,
        adults: booking.adultsCount,
        status: booking.status,
      },
    })
    .from(kioskSession)
    .innerJoin(station, eq(station.id, kioskSession.stationId))
    .innerJoin(booking, eq(booking.id, kioskSession.bookingId))
    .where(
      and(
        eq(kioskSession.operatorId, operatorId),
        eq(kioskSession.branchId, branchId),
        inArray(kioskSession.outcome, ['failed', 'handed_off']),
        isNotNull(kioskSession.endedAt),
        gt(kioskSession.startedAt, new Date(now.getTime() - DAY_WINDOW_MS)),
        sql`${businessDayOf(kioskSession.endedAt, br.timezone, dayStartMinutes)} = ${today}`,
      ),
    )
    .orderBy(desc(kioskSession.endedAt))
    .limit(200);

  // Latest session per booking.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.booking.id)) latest.set(row.booking.id, row);

  const saleIds = [...latest.values()]
    .map((r) => r.session.saleId)
    .filter((id): id is string => typeof id === 'string');
  const waiting = saleIds.length
    ? await db
        .select({ saleId: checkin.saleId, n: sql<number>`count(*)::int` })
        .from(checkin)
        .where(and(inArray(checkin.saleId, saleIds), eq(checkin.status, 'registered')))
        .groupBy(checkin.saleId)
    : [];
  const booked = new Map(waiting.map((w) => [w.saleId, w.n]));

  const entries: KioskDeskEntry[] = [...latest.values()].map(({ session, stationName, booking: b }) => {
    const detail = (session.detail ?? {}) as { supervisedChildren?: unknown };
    const supervisedChildren = typeof detail.supervisedChildren === 'number' ? detail.supervisedChildren : 0;
    const bandIds = Array.isArray(session.bandIds) ? session.bandIds : [];
    const state: KioskDeskState = session.saleId
      ? (booked.get(session.saleId) ?? 0) > 0
        ? 'to_check_in'
        : 'done'
      : b.status === 'paid'
        ? 'to_redeem'
        : 'done';
    return {
      sessionId: session.id,
      stationId: session.stationId,
      stationName,
      endedAt: session.endedAt!.toISOString(),
      outcome: session.outcome as 'failed' | 'handed_off',
      reason: session.reason,
      booking: b,
      supervisedChildren,
      bandsIssued: bandIds.length,
      state,
    };
  });
  entries.sort((a, b) => DESK_ORDER[a.state] - DESK_ORDER[b.state] || b.endedAt.localeCompare(a.endedAt));
  return { businessDate: today, entries: entries.slice(0, DESK_LIMIT) };
}

// --- The Console's Kiosk tile -------------------------------------------------

/** The screen polls its state every 15 seconds; three missed polls and it reads as down. */
const SCREEN_ONLINE_MS = 60_000;

/**
 * Whether a kiosk's box can print right now, as the redemption itself would
 * ask (K1 `kioskPrinterOf`): the agent's own answer where it runs in this
 * process, the Console's offline switch and the last heartbeat elsewhere.
 */
function boxOnline(
  row: { id: string; lastHeartbeatAt: Date | null; archivedAt: Date | null },
  offline: boolean | null,
  now: Date,
): boolean {
  if (row.archivedAt || offline) return false;
  const agent = inProcessBox(row.id);
  if (agent) return agent.state.linkUp && !agent.state.offline;
  return !!row.lastHeartbeatAt && now.getTime() - row.lastHeartbeatAt.getTime() <= boxSettings().offlineAfterS * 1000;
}

/**
 * THE KIOSK TILE ON HEALTH: per kiosk station in the reader's reach, whether
 * its box and its screen are up, its band printer and paper, today's sessions
 * by outcome — abandoned among them — and when it last redeemed a booking.
 * Names, states and counts only, as every Health read.
 */
export async function kioskHealth(
  db: Db,
  operatorId: string,
  reach: BranchReach,
  now: Date = new Date(),
): Promise<KioskHealthAnswer> {
  const stations = (
    await db
      .select({
        station,
        branchName: branch.name,
        timezone: branch.timezone,
        dayStart: branch.businessDayStart,
        box: { id: box.id, name: box.name, lastHeartbeatAt: box.lastHeartbeatAt, archivedAt: box.archivedAt },
        offline: boxState.offline,
      })
      .from(station)
      .innerJoin(branch, and(eq(branch.id, station.branchId), eq(branch.operatorId, station.operatorId)))
      .leftJoin(box, eq(box.id, station.boxId))
      .leftJoin(boxState, eq(boxState.boxId, station.boxId))
      .where(
        and(
          eq(station.operatorId, operatorId),
          eq(station.kind, 'kiosk'),
          isNull(station.archivedAt),
          isNull(branch.archivedAt),
        ),
      )
      .orderBy(branch.name, station.name)
  ).filter((r) => reachCovers(reach, r.station.branchId));
  if (stations.length === 0) return { kiosks: [] };
  const stationIds = stations.map((s) => s.station.id);

  const screens = await db
    .select({
      stationId: deviceCredential.stationId,
      label: deviceCredential.label,
      lastSeenAt: deviceCredential.lastSeenAt,
      pairedAt: deviceCredential.pairedAt,
    })
    .from(deviceCredential)
    .where(
      and(
        inArray(deviceCredential.stationId, stationIds),
        eq(deviceCredential.kind, 'kiosk'),
        isNull(deviceCredential.revokedAt),
        isNotNull(deviceCredential.pairedAt),
        isNotNull(deviceCredential.secretHash),
      ),
    )
    .orderBy(desc(deviceCredential.pairedAt));

  const printers = await db
    .select({
      stationId: stationDevice.stationId,
      role: stationDevice.role,
      device: {
        id: device.id,
        label: device.label,
        boxId: device.boxId,
        reachability: device.reachability,
        paperStatus: device.paperStatus,
      },
    })
    .from(stationDevice)
    .innerJoin(device, eq(device.id, stationDevice.deviceId))
    .where(and(inArray(stationDevice.stationId, stationIds), inArray(stationDevice.role, ['kids_band', 'adult_band'])));

  const since = new Date(now.getTime() - DAY_WINDOW_MS);
  const recent = await db
    .select({
      stationId: kioskSession.stationId,
      outcome: kioskSession.outcome,
      saleId: kioskSession.saleId,
      startedAt: kioskSession.startedAt,
      endedAt: kioskSession.endedAt,
    })
    .from(kioskSession)
    .where(and(inArray(kioskSession.stationId, stationIds), gt(kioskSession.startedAt, since)));

  const lastRedemptions = await db
    .select({ stationId: kioskSession.stationId, at: sql<string | null>`max(${kioskSession.endedAt})` })
    .from(kioskSession)
    .where(
      and(
        inArray(kioskSession.stationId, stationIds),
        inArray(kioskSession.outcome, ['issued', 'handed_off']),
        isNotNull(kioskSession.saleId),
      ),
    )
    .groupBy(kioskSession.stationId);
  const lastByStation = new Map(lastRedemptions.map((r) => [r.stationId, r.at ? new Date(r.at) : null]));

  const kiosks: KioskHealthRow[] = stations.map((s) => {
    const st = s.station;
    const dayStartMinutes = parseDayStart(s.dayStart);
    const today = businessDate(now, s.timezone, dayStartMinutes);
    const sessions = recent.filter(
      (r) => r.stationId === st.id && businessDate(r.startedAt, s.timezone, dayStartMinutes) === today,
    );
    const count = (outcome: string | null) => sessions.filter((r) => r.outcome === outcome).length;

    const screen = screens.find((c) => c.stationId === st.id) ?? null;
    const band =
      printers.find((p) => p.stationId === st.id && p.role === 'kids_band') ??
      printers.find((p) => p.stationId === st.id && p.role === 'adult_band') ??
      null;
    const live = band ? inProcessBox(band.device.boxId)?.printing()?.simulator(band.device.id) : undefined;
    const faults = live ? [...live.faults] : [];
    const last = lastByStation.get(st.id) ?? null;

    return {
      stationId: st.id,
      name: st.name,
      branchId: st.branchId,
      branchName: s.branchName,
      box: s.box?.id
        ? {
            id: s.box.id,
            name: s.box.name,
            online: boxOnline({ id: s.box.id, lastHeartbeatAt: s.box.lastHeartbeatAt, archivedAt: s.box.archivedAt }, s.offline, now),
            lastHeartbeatAt: s.box.lastHeartbeatAt?.toISOString() ?? null,
          }
        : null,
      screen: {
        paired: !!screen,
        label: screen?.label ?? null,
        lastSeenAt: screen?.lastSeenAt?.toISOString() ?? null,
        online: !!screen?.lastSeenAt && now.getTime() - screen.lastSeenAt.getTime() <= SCREEN_ONLINE_MS,
      },
      printer: band
        ? {
            deviceId: band.device.id,
            label: band.device.label,
            // The simulator's own fault, where this process runs it, is newer than the last heartbeat.
            reachability: faults.includes('unreachable') ? 'unreachable' : band.device.reachability,
            paperStatus: faults.includes('paper_out') ? 'out' : band.device.paperStatus,
            faults,
          }
        : null,
      today: {
        businessDate: today,
        sessions: sessions.length,
        issued: count('issued'),
        handedOff: count('handed_off'),
        failed: count('failed'),
        abandoned: count('abandoned'),
        open: count(null),
      },
      lastRedemptionAt: last?.toISOString() ?? null,
    };
  });
  return { kiosks };
}

// --- The virtual kiosk's simulator controls ---------------------------------------

/**
 * Drive one of the kiosk's failure screens without hardware (S2-20 K2):
 * the band printer offline or out of paper, the box offline, or all of it
 * cleared — applied at once to the box this api runs, as the terminal
 * simulator's are, and audited (`kiosk.simulate`) with the station and the box
 * so a rehearsal's Activity reads as one.
 *
 * Only a box running in this process, and only its simulated printers: a real
 * printer cannot be asked to run out of paper, and a Raspberry Pi's
 * simulators are reached through the command queue (the per-printer controls).
 */
export async function simulateKiosk(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  target: typeof station.$inferSelect,
  control: KioskSimulatorControl,
  actionId: string,
): Promise<KioskSimulatorAnswer> {
  if (target.kind !== 'kiosk') {
    throw new AppError(409, 'KIOSK_STATION_INVALID', 'These controls are for a self-service kiosk station');
  }
  if (!target.boxId) throw new AppError(409, 'STATION_HAS_NO_BOX', 'This kiosk has no box to simulate');
  const boxId = target.boxId;
  const agent = inProcessBox(boxId);
  if (!agent) {
    throw new AppError(
      409,
      'BOX_NOT_IN_THIS_PROCESS',
      "This kiosk's box is not running here, so its simulators cannot be reached from this api",
      { boxId },
    );
  }
  const printing = agent.printing();
  const assigned = await db
    .select({ role: stationDevice.role, id: device.id, label: device.label, transport: device.transport })
    .from(stationDevice)
    .innerJoin(device, eq(device.id, stationDevice.deviceId))
    .where(eq(stationDevice.stationId, target.id));
  const printers = [...new Map(assigned.filter((d) => printing?.simulator(d.id)).map((d) => [d.id, d])).values()];
  const bandPrinters = printers.filter((p) => assigned.some((a) => a.id === p.id && (a.role === 'kids_band' || a.role === 'adult_band')));

  if ((control === 'printer_offline' || control === 'paper_out') && (bandPrinters.length === 0 || !printing)) {
    throw new AppError(
      409,
      'KIOSK_NO_SIMULATED_BAND_PRINTER',
      'This kiosk has no simulated band printer standing on its box',
      { stationId: target.id },
    );
  }

  return withTx(db, ctx, 'kiosk.simulate', async (tx) => {
    if (control === 'printer_offline') for (const p of bandPrinters) printing!.setFault(p.id, 'unreachable');
    if (control === 'paper_out') for (const p of bandPrinters) printing!.setFault(p.id, 'paper_out');
    if (control === 'box_offline') await agent.setOffline(true, { reason: 'kiosk simulator', accountId: actor.accountId });
    if (control === 'clear') {
      for (const p of printers) printing?.clearFaults(p.id);
      if (agent.state.offline) await agent.setOffline(false, { accountId: actor.accountId });
    }
    const answer: KioskSimulatorAnswer = {
      stationId: target.id,
      boxId,
      control,
      boxOffline: agent.state.offline,
      printers: printers.map((p) => ({
        deviceId: p.id,
        label: p.label,
        faults: [...(printing?.simulator(p.id)?.faults ?? [])],
      })),
      actionId,
    };
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: target.branchId,
      action: 'kiosk.simulate',
      entityType: 'station',
      entityId: target.id,
      after: { stationId: target.id, boxId, control, boxOffline: answer.boxOffline, printers: answer.printers },
      requestId: ctx.requestId,
      actionId,
    });
    return answer;
  });
}
