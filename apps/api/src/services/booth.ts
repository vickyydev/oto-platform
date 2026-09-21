import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  boothConfigVersion,
  boothPrize,
  box,
  branch,
  device,
  spin,
  station,
  stationDevice,
  type Db,
} from '@oto/db';
import { businessDate, parseDayStart } from '@oto/shared';
import {
  BOOTH_ACTION_HEADER,
  BOOTH_IDEMPOTENCY_HEADER,
  createBoothHttp,
  type Booth,
  type BoothHttpRequest,
  type BoothHttpResponse,
  type BoxAgent,
} from '@oto/box-agent';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../lib/errors';
import { boxSettings, inProcessBox } from './box';

/**
 * The cloud's booth surface (S2-07a).
 *
 * Two audiences that must not be confused, which is why they are in one file:
 *
 *   - **The television.** `/booth/*` is what the page in `apps/booth` calls.
 *     Every one of those calls is a PASS-THROUGH to the booth role on the box
 *     in this process. Nothing here draws a prize, mints a code, counts a cap
 *     or decides who is signed in — a second implementation of any of those
 *     would be a second answer to "what did this booth give away today", and
 *     the box's is the one with the paper behind it.
 *   - **The Console.** `GET /booths/:id/status` is an administrator's view,
 *     built from what the CLOUD knows: the published wheel, the box's last
 *     heartbeat, the booth printer's row, and the spins that have synced. It
 *     never consults the box, so it answers the same way for a Raspberry Pi in
 *     a mall as for the virtual box in this process.
 *
 * **D15, and exactly how much of it this file can promise.** The documents on
 * `/booth/*` are the BOX's — this file does not compose them and cannot
 * vouch for what is in them; the rule is kept where they are written
 * (`booth-http.ts` states it at the top of its own file). What is this file's
 * to keep is the one answer it authors: the 503 below names no station, no
 * box and no slot, because the reason names both and a message written for a
 * log has no business on a screen in a shopping centre. The ids go to the
 * server log instead, where whoever is debugging can read them.
 */

// --- The television's half: mounting the box's own surface ------------------

/**
 * **The `/booth/*` contract belongs to the box, and this mounts it.**
 *
 * `createBoothHttp` in `@oto/box-agent` is that contract written as a plain
 * function — method, path, headers, parsed body in; status and body out, with
 * no socket and no framework anywhere in it. The Raspberry Pi under a real
 * television wires it to its own server; this wires it to Fastify. So the
 * demo booth and a booth in a mall answer the same requests with the same
 * documents, because it is the same function answering.
 *
 * Writing the mapping again up here is the failure this avoids, and it would
 * not have looked like one: two `/booth/spin` implementations agreeing today
 * and drifting the first time one of them learns something — a new refusal
 * code, a header, a field on the answer. The page would then behave one way
 * against the demo and another in the park, which is the hardest kind of
 * difference to find because both halves look right on their own.
 *
 * What is left here is what a box genuinely cannot answer: whether it has the
 * cloud (`online`), which is the agent's business rather than the booth's.
 */
type BoothCall = (request: BoothHttpRequest) => Promise<BoothHttpResponse>;

/**
 * One handler per booth module, not one per request.
 *
 * It holds a little state — it warns once, not once per press, that a press
 * arrived with no idempotency key — and building it per request would turn
 * that into a line per press. The page does not send a key yet, so that is
 * every press of the day. Keyed on the booth module, so the entry is
 * collected with the module it belongs to.
 */
const handlers = new WeakMap<Booth, BoothCall>();

/**
 * Built with the INSTANCE logger, not a request's.
 *
 * The handler outlives the request that first asked for it, so a
 * request-scoped logger would stamp its once-per-process warning with the
 * request id of whichever press happened to be first — a line pointing at an
 * unrelated request is worse than a line with no request at all.
 */
function callerFor(agent: BoxAgent, booth: Booth, log: FastifyBaseLogger): BoothCall {
  const existing = handlers.get(booth);
  if (existing) return existing;
  const call = createBoothHttp({
    booth,
    /**
     * The offline toggle the agent persists (S2-05): the demo's "take this
     * box offline" control, and the honest answer for a virtual box whose
     * cloud is this very process. A Pi with a dropped mall connection reports
     * the same way through its own agent.
     */
    online: () => !agent.state.offline,
    log,
  });
  handlers.set(booth, call);
  return call;
}

/**
 * The headers the box's surface reads, and only those.
 *
 * Forwarding the whole bag instead would hand a cookie and an authorization
 * header to a module that has no business seeing either.
 *
 * The names come from the box's own exported constants, so those two cannot
 * drift apart in spelling. **That is all it buys**: a THIRD header the box's
 * surface learns to read would simply not be forwarded from here, and nothing
 * would fail to compile or to pass. Whoever adds one adds it to this list.
 */
export function boothHeaders(headers: Record<string, unknown>): Record<string, string | undefined> {
  const pick = (name: string): string | undefined => {
    const value = headers[name];
    return typeof value === 'string' ? value : undefined;
  };
  return {
    [BOOTH_IDEMPOTENCY_HEADER]: pick(BOOTH_IDEMPOTENCY_HEADER),
    [BOOTH_ACTION_HEADER]: pick(BOOTH_ACTION_HEADER),
  };
}



// --- Finding the booth this process is serving ------------------------------

/** A booth station and the box that drives it. */
export interface BoothStationRow {
  stationId: string;
  name: string;
  operatorId: string;
  branchId: string;
  boxId: string | null;
}

/**
 * The booths of this deployment, newest configuration last.
 *
 * A booth IS a station of kind `booth` — `booth_settings`, `booth_prize` and
 * `spin` all key on the station id, and there is no second identity for one.
 */
async function boothStations(db: Db, stationId?: string): Promise<BoothStationRow[]> {
  const rows = await db
    .select({
      stationId: station.id,
      name: station.name,
      operatorId: station.operatorId,
      branchId: station.branchId,
      boxId: station.boxId,
    })
    .from(station)
    .where(
      and(
        eq(station.kind, 'booth'),
        isNull(station.archivedAt),
        stationId ? eq(station.id, stationId) : undefined,
      ),
    )
    .orderBy(station.createdAt);
  return rows;
}

/**
 * Two loggers, because two things here have different lifetimes.
 *
 * `request` carries the request id and is what a refusal is written with —
 * that refusal IS this request. `instance` outlives it and belongs to the
 * booth handler, which is built once and kept (see `callerFor`).
 */
export interface BoothLogs {
  request: FastifyBaseLogger;
  instance: FastifyBaseLogger;
}

/** The booth whose box is running here, and the way in to its surface. */
export interface ResolvedBooth {
  station: BoothStationRow;
  agent: BoxAgent;
  booth: Booth;
  /** The box's own `/booth/*` contract, bound to this booth. */
  call: BoothCall;
}

/**
 * Which booth is `/booth/*` about, and is its box in this process?
 *
 * The page sends nothing that names a booth — it is a browser on a television
 * wired to the box under it, and D15 leaves it nothing to identify itself
 * with. So the api answers for the booth whose box is running HERE: on a Pi
 * that is the one booth it drives, and on the demo deployment it is the
 * virtual box's Booth 1.
 *
 * Every other case is refused, and refused distinguishably in the log:
 *
 *   - no booth station at all — a deployment with no wheel configured;
 *   - a booth whose box is somewhere else — an api instance that is not the
 *     booth's box, which is exactly what the cloud api in front of the park
 *     is. **It answers 503 and never a prize.** Drawing here would put a
 *     second draw beside the box's, and the two would disagree about caps,
 *     stock and what is on the paper;
 *   - a box in this process with no booth module at all — an agent running
 *     without a store, which has nowhere to record a spin.
 *
 * Note what does NOT decide it: the booth module is built on every box with a
 * store, till or not, and it answers `config() === null` until its bundle
 * names a booth station. So the STATION rows are the discriminator here, and a
 * booth whose box is up but has not synced its wheel yet is resolved and then
 * told `not_configured` by the box — which is the screen that case deserves,
 * rather than the one that means "wrong machine".
 *
 * Two in-process booths are refused rather than guessed between: the prefix on
 * the printed code says which booth issued it, and picking the wrong one puts
 * the other booth's prefix in a visitor's hand.
 */
export async function resolveInProcessBooth(
  db: Db,
  logs: BoothLogs,
): Promise<ResolvedBooth> {
  const log = logs.request;
  const booths = await boothStations(db);
  if (booths.length === 0) throw boothUnavailable(log, 'no booth station is configured', {});

  const here: ResolvedBooth[] = [];
  /** Why each booth was passed over, for the log line when none is left. */
  const passedOver: Record<string, string> = {};
  for (const row of booths) {
    if (!row.boxId) {
      passedOver[row.stationId] = 'no box';
      continue;
    }
    const agent = inProcessBox(row.boxId);
    if (!agent) {
      passedOver[row.stationId] = 'its box runs elsewhere';
      continue;
    }
    const booth = agent.booth();
    if (!booth) {
      passedOver[row.stationId] = 'its box has no booth module';
      continue;
    }
    here.push({ station: row, agent, booth, call: callerFor(agent, booth, logs.instance) });
  }

  if (here.length === 0) {
    throw boothUnavailable(
      log,
      'no booth on a box in this process — a booth is served by its own box',
      passedOver,
    );
  }
  if (here.length > 1) {
    throw boothUnavailable(log, 'more than one booth is running in this process', passedOver);
  }
  return here[0]!;
}

/**
 * 503, with the detail in the LOG and nothing in the body.
 *
 * The reason names stations and boxes, and this answer goes to a television in
 * a shopping centre (D15) — so an operator reads it in the log and the screen
 * gets a status code. The page does not recognise the code and falls back to
 * its own fixed line, which is the correct screen: "Booth not ready — please
 * call staff".
 *
 * 503 rather than 404: the booth exists, this process is not where it runs,
 * and the same request against the right box is answered.
 */
function boothUnavailable(
  log: FastifyBaseLogger,
  reason: string,
  passedOver: Record<string, string>,
): AppError {
  log.warn({ reason, booths: passedOver }, 'booth call refused: not on this box');
  return new AppError(503, 'BOOTH_NOT_ON_THIS_BOX', 'This booth is not running on this service');
}

/**
 * Carry one booth request to the box and its answer back.
 *
 * Everything between those two points — the refusal codes, their statuses, the
 * documents, the 405s, the 404 for a path the booth's surface does not have —
 * is decided inside `createBoothHttp`. This function's whole job is that it
 * decides none of them.
 *
 * The one answer that IS the api's own is 503 `BOOTH_NOT_ON_THIS_BOX`, thrown
 * by the resolver above before the box is ever reached, and it is spelled in
 * the platform's style rather than the booth's precisely because it comes from
 * the cloud and not from a wheel. The page does not recognise it, falls back
 * to its own fixed line, and a `#debug` reader can tell the two apart.
 */
export async function callBooth(
  db: Db,
  logs: BoothLogs,
  request: BoothHttpRequest,
): Promise<BoothHttpResponse> {
  const booth = await resolveInProcessBooth(db, logs);
  return booth.call(request);
}

// --- The Console's view -----------------------------------------------------

export interface BoothConsoleStatus {
  booth: { id: string; name: string; operatorId: string; branchId: string };
  box: {
    id: string | null;
    slot: string | null;
    status: string | null;
    lastHeartbeatAt: string | null;
    /**
     * A heartbeat inside the watchdog's silence window (`BOX_OFFLINE_AFTER_S`),
     * measured when this is read.
     *
     * Not the same thing as `status` beside it, and deliberately so: the
     * watchdog moves `status` on a timer and only ever from `online`, so a box
     * that fell silent a minute ago still says `online` on its row while this
     * already says false. Both are reported; neither is derived from the other.
     */
    online: boolean;
    /** Whether the booth's box is running inside THIS api process. */
    inProcess: boolean;
  };
  config: {
    /** The newest version an administrator has published for this booth. */
    publishedVersion: number | null;
    publishedAt: string | null;
    /**
     * The version the box last said it was running, from the `booth` block of
     * its heartbeat. **Null also means "not reported"** — the block is
     * optional and the slice that ingests it is not this one — so a null here
     * is not evidence that the box is running nothing.
     */
    runningVersion: number | null;
  };
  printer: {
    deviceId: string;
    label: string | null;
    reachability: string;
    paperStatus: string;
    lastError: string | null;
    lastSeenAt: string | null;
  } | null;
  /** Counted over the branch's trading day, not the calendar one. */
  today: {
    businessDate: string;
    spins: number;
    /** Spins with no staff member signed in — the D13 condition's raw number. */
    unattributed: number;
    /** `booth.booth_prize.id` of the prizes that have hit their cap today. */
    dailyCapsReached: string[];
  };
  lastSpinAt: string | null;
}

/**
 * One booth of this operator, or 404.
 *
 * Its own function because the permission on `GET /booths/:id/status` is
 * scoped to the booth's BRANCH, which is not in the URL: the route loads the
 * row, checks against `row.branchId`, and only then builds the view.
 */
export async function loadBoothStation(
  db: Db,
  operatorId: string,
  stationId: string,
): Promise<BoothStationRow> {
  const [row] = await boothStations(db, stationId);
  if (!row || row.operatorId !== operatorId) {
    throw new AppError(404, 'BOOTH_NOT_FOUND', 'No booth with that id');
  }
  return row;
}

/**
 * What the Console shows for one booth.
 *
 * Built entirely from cloud rows. **What that means for an offline booth:**
 * spins live on the box until they sync, so `today.spins` is what has
 * ARRIVED, not what has happened — a booth that has been offline since
 * lunchtime shows this morning's figures beside a stale heartbeat, and the
 * heartbeat's age is how a reader tells. Asking the box instead would answer
 * for the virtual box in this process and for no Raspberry Pi in any mall.
 */
export async function boothConsoleStatus(
  db: Db,
  row: BoothStationRow,
): Promise<BoothConsoleStatus> {
  const [branchRow] = await db
    .select({ timezone: branch.timezone, businessDayStart: branch.businessDayStart })
    .from(branch)
    .where(eq(branch.id, row.branchId))
    .limit(1);
  if (!branchRow) throw new AppError(404, 'BOOTH_NOT_FOUND', 'No booth with that id');
  const today = businessDate(
    new Date(),
    branchRow.timezone,
    parseDayStart(branchRow.businessDayStart),
  );

  const boxRow = row.boxId
    ? (
        await db
          .select({
            id: box.id,
            slot: box.slot,
            status: box.status,
            lastHeartbeatAt: box.lastHeartbeatAt,
            lastStatus: box.lastStatus,
          })
          .from(box)
          .where(eq(box.id, row.boxId))
          .limit(1)
      )[0]
    : undefined;

  const [published] = await db
    .select({ version: boothConfigVersion.version, createdAt: boothConfigVersion.createdAt })
    .from(boothConfigVersion)
    .where(eq(boothConfigVersion.stationId, row.stationId))
    .orderBy(desc(boothConfigVersion.version))
    .limit(1);

  /**
   * The booth printer is the device carrying this station's `receipt` role —
   * the same assignment the seed makes and the same one the print pipeline
   * reads. Its reachability and paper are kept up to date by the box's
   * heartbeat, so this is cloud-known without asking the box anything.
   */
  const [printerRow] = await db
    .select({
      deviceId: device.id,
      label: device.label,
      reachability: device.reachability,
      paperStatus: device.paperStatus,
      lastError: device.lastError,
      lastSeenAt: device.lastSeenAt,
    })
    .from(stationDevice)
    .innerJoin(device, eq(stationDevice.deviceId, device.id))
    .where(and(eq(stationDevice.stationId, row.stationId), eq(stationDevice.role, 'receipt')))
    .limit(1);

  /**
   * Today's spins, the unattributed ones among them, and the newest stamp.
   * `simulated` rows are left out: a `#debug` distribution run is a test of
   * the draw, not a morning's play, and counting it would make every figure
   * on this panel unusable the moment somebody opened that table.
   */
  const [counts] = await db
    .select({
      spins: count(),
      unattributed: sql<number>`count(*) filter (where ${spin.staffAccountId} is null)`.mapWith(
        Number,
      ),
    })
    .from(spin)
    .where(
      and(
        eq(spin.stationId, row.stationId),
        eq(spin.businessDate, today),
        eq(spin.simulated, false),
      ),
    );

  const [lastSpin] = await db
    .select({ occurredAt: spin.occurredAt })
    .from(spin)
    .where(and(eq(spin.stationId, row.stationId), eq(spin.simulated, false)))
    .orderBy(desc(spin.occurredAt))
    .limit(1);

  const perPrize = await db
    .select({ prizeId: spin.prizeId, given: count() })
    .from(spin)
    .where(
      and(
        eq(spin.stationId, row.stationId),
        eq(spin.businessDate, today),
        eq(spin.simulated, false),
      ),
    )
    .groupBy(spin.prizeId);
  const caps = await db
    .select({ id: boothPrize.id, dailyCap: boothPrize.dailyCap })
    .from(boothPrize)
    .where(and(eq(boothPrize.stationId, row.stationId), isNull(boothPrize.archivedAt)));
  const givenById = new Map(perPrize.map((p) => [p.prizeId, p.given]));
  const dailyCapsReached = caps
    .filter((p) => p.dailyCap !== null && (givenById.get(p.id) ?? 0) >= p.dailyCap)
    .map((p) => p.id);

  const settings = boxSettings();
  const lastHeartbeatAt = boxRow?.lastHeartbeatAt ?? null;
  const online =
    lastHeartbeatAt !== null &&
    Date.now() - lastHeartbeatAt.getTime() < settings.offlineAfterS * 1000;

  const boothBlock = (boxRow?.lastStatus as { booth?: { configVersion?: unknown } } | null)?.booth;
  const runningVersion =
    typeof boothBlock?.configVersion === 'number' ? boothBlock.configVersion : null;

  return {
    booth: {
      id: row.stationId,
      name: row.name,
      operatorId: row.operatorId,
      branchId: row.branchId,
    },
    box: {
      id: boxRow?.id ?? null,
      slot: boxRow?.slot ?? null,
      status: boxRow?.status ?? null,
      lastHeartbeatAt: lastHeartbeatAt?.toISOString() ?? null,
      online,
      inProcess: row.boxId !== null && inProcessBox(row.boxId) !== null,
    },
    config: {
      publishedVersion: published?.version ?? null,
      publishedAt: published?.createdAt?.toISOString() ?? null,
      runningVersion,
    },
    printer: printerRow
      ? {
          deviceId: printerRow.deviceId,
          label: printerRow.label,
          reachability: printerRow.reachability,
          paperStatus: printerRow.paperStatus,
          lastError: printerRow.lastError,
          lastSeenAt: printerRow.lastSeenAt?.toISOString() ?? null,
        }
      : null,
    today: {
      businessDate: today,
      spins: counts?.spins ?? 0,
      unattributed: counts?.unattributed ?? 0,
      dailyCapsReached,
    },
    lastSpinAt: lastSpin?.occurredAt?.toISOString() ?? null,
  };
}
