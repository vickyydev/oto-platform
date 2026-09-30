import { and, eq, isNull } from 'drizzle-orm';
import {
  StationSessionManager,
  type QueuedFact,
  type SqlBoxStore,
  type StationIdentity,
} from '@oto/box-agent';
import { box, boxState, station, type Db } from '@oto/db';
import type { FastifyBaseLogger } from 'fastify';
import { boxStoreFor } from '../lib/box-store';
import { AppError } from '../lib/errors';
import { virtualBoxAgent } from './box';
import { boxOutboxState, recordStationTakeover, syncSettings } from './sync';

/**
 * The station session document, as a request can reach it (S2-05).
 *
 * The box is the system of action: it owns the station's current sale and
 * serves it to the till and to the customer display. This file is the door a
 * screen knocks on. It is thin on purpose — every rule about leases, staleness
 * and redaction lives in `@oto/box-agent`, in the same file that runs on a
 * Raspberry Pi — and what it adds is the two things a Pi does not have to
 * think about: which account is asking, and what that account may do.
 *
 * **Why the api holds the manager rather than reaching into the agent.** The
 * virtual box's store IS the `edge` schema of this database, so a manager
 * built here and the agent's own are two handles on one set of rows; there is
 * no second copy of anything. Building it here means the document is reachable
 * on any api instance, including one that does not carry the `edge` role and
 * so runs no agent at all — and means the station routes are testable without
 * starting a box. What the agent has that this does not is the signing key,
 * which matters for exactly one thing, and is handled at `queueFact` below.
 *
 * **One manager per box.** `StationSessionManager` is constructed with a box
 * id and stamps it on every line it writes to the station's tape. The park has
 * two virtual boxes and will have more, so there is one manager each rather
 * than a box id threaded through every call.
 *
 * **What is per-INSTANCE, and what that costs.** The document, the lease and
 * the sequence are rows, so every instance agrees about them and the
 * compare-and-set settles any race between two of them. The SUBSCRIBERS are
 * not: a screen is attached to the process holding its connection, so an
 * intent applied on instance A pushes its snapshot to the screens attached to
 * A and to no others. Today that costs nothing — the api is one Render service
 * and the `edge` role is single-instance by the same contract that keeps the
 * job runner single-instance — but a second instance would need the box to
 * publish its snapshots rather than fan them out in memory, and this is the
 * line where that is decided. A screen on the wrong instance is not WRONG in
 * the meantime, only late: its next intent quotes a stale sequence, is refused
 * with the current document, and it rehydrates.
 */

/** A station as this file needs it: who owns it and which box runs it. */
export interface StationRow {
  id: string;
  operatorId: string;
  branchId: string;
  boxId: string | null;
  name: string;
  archivedAt: Date | null;
}

interface BoxSessions {
  store: SqlBoxStore;
  managers: Map<string, StationSessionManager>;
  /**
   * What `resolveStation` answers from.
   *
   * The manager's resolver is synchronous — on a Pi it reads the config bundle
   * the box already holds — so the api fills this in from the station row it
   * has just loaded for the permission check. It is not a cache in front of
   * the database: nothing reaches a manager without its row having been read
   * on that same request.
   */
  identities: Map<string, StationIdentity>;
}

const perDb = new WeakMap<object, BoxSessions>();

function sessionsOf(db: Db): BoxSessions {
  const key = db as unknown as object;
  let held = perDb.get(key);
  if (!held) {
    held = { store: boxStoreFor(db), managers: new Map(), identities: new Map() };
    perDb.set(key, held);
  }
  return held;
}

/**
 * The manager for the box this station sits on, with the station's identity
 * registered so the manager can resolve it.
 *
 * A station with no box is refused rather than given a document: the session
 * document is the box's, and a till at a station nobody has put a box behind
 * has nothing to hold its sale.
 */
export function managerForStation(
  db: Db,
  row: StationRow,
  log?: FastifyBaseLogger,
): { manager: StationSessionManager; boxId: string } {
  if (!row.boxId) {
    throw new AppError(
      409,
      'STATION_HAS_NO_BOX',
      `${row.name} is not on a box yet, so there is nothing to hold its session`,
    );
  }
  const boxId = row.boxId;
  const sessions = sessionsOf(db);
  sessions.identities.set(row.id, {
    stationId: row.id,
    boxId,
    operatorId: row.operatorId,
    branchId: row.branchId,
  });

  let manager = sessions.managers.get(boxId);
  if (!manager) {
    manager = new StationSessionManager({
      store: sessions.store,
      boxId,
      resolveStation: (stationId) => sessions.identities.get(stationId) ?? null,
      queueFact: (fact) => queueFact(db, boxId, fact),
      log,
    });
    sessions.managers.set(boxId, manager);
  }
  return { manager, boxId };
}

/**
 * Where a fact minted by the session manager goes.
 *
 * Today that is `station.takeover` and nothing else; the cart and payment
 * facts belong to the tickets that own those flows and will arrive the same
 * way.
 *
 * Two routes, and which one is taken is a property of where the request
 * landed rather than of the fact:
 *
 *   - **This process runs that box's agent.** The fact goes into its outbox,
 *     signed by the box's own key, and syncs like every other fact. That is
 *     the path a Pi has, and it is the one that survives the box being offline
 *     when the takeover happens.
 *   - **It does not** — an api instance without the `edge` role, or a test.
 *     The fact has then already arrived where the ledger was going to carry
 *     it, because this process IS the cloud, so it is recorded directly. A
 *     fact cannot be signed by a box whose key this process does not hold, and
 *     putting an unsigned event in the ledger to have it quarantined a second
 *     later would be losing the audit row rather than keeping it.
 *
 * Both write the same audit row, through `recordStationTakeover`.
 */
async function queueFact(db: Db, boxId: string, fact: QueuedFact): Promise<void> {
  const agent = virtualBoxAgent();
  const outbox = agent && agent.state.boxId === boxId ? agent.outbox() : null;
  if (outbox) {
    await outbox.queue(fact);
    return;
  }
  if (fact.type !== 'station.takeover' || !fact.stationId || !fact.actorAccountId) return;

  const [row] = await db
    .select({ operatorId: station.operatorId, branchId: station.branchId })
    .from(station)
    .where(eq(station.id, fact.stationId))
    .limit(1);
  if (!row) return;
  await recordStationTakeover(db, {
    operatorId: row.operatorId,
    branchId: row.branchId,
    stationId: fact.stationId,
    actorAccountId: fact.actorAccountId,
    payload: fact.payload as Parameters<typeof recordStationTakeover>[1]['payload'],
    requestId: null,
    actionId: fact.actionId ?? null,
  });
}

// --- What the till's banner reads -------------------------------------------

export interface StationLinkView {
  stationId: string;
  boxId: string | null;
  boxName: string | null;
  boxStatus: string | null;
  offline: boolean;
  offlineSince: string | null;
  offlineReason: string | null;
  outboxDepth: number | null;
  oldestUnackedSeconds: number | null;
  lastSyncAt: string | null;
  syncStale: boolean;
  cacheAppliedAt: string | null;
  cacheAgeSeconds: number | null;
  journalEpoch: number | null;
}

/**
 * Whether this till is working with the internet or without it.
 *
 * Answered for the session's OWN station and no other, which is why it takes
 * no permission: the person who needs it most is on reception and holds none
 * of the fleet's, and a route scoped to the station you are already standing
 * at can say nothing about a station you are not.
 *
 * `offline` and `boxStatus` are two different facts and both are sent.
 * `offline` is `edge.box_state.offline` — somebody pressed "Go offline", or
 * the box cut its own cloud client — a deliberate state with a reason behind
 * it. `boxStatus` is the watchdog's verdict from the heartbeat age, which is
 * never the box's own claim: a box that has crashed cannot tell anybody it is
 * down, and that silence is the signal.
 */
export async function stationLink(db: Db, stationId: string): Promise<StationLinkView> {
  const [row] = await db
    .select({
      stationId: station.id,
      boxId: station.boxId,
      boxName: box.name,
      boxStatus: box.status,
      lastHeartbeatAt: box.lastHeartbeatAt,
      currentEpoch: box.currentEpoch,
    })
    .from(station)
    .leftJoin(box, eq(station.boxId, box.id))
    .where(eq(station.id, stationId))
    .limit(1);
  if (!row) throw new AppError(404, 'STATION_NOT_FOUND', 'No such station');

  const base: StationLinkView = {
    stationId: row.stationId,
    boxId: row.boxId,
    boxName: row.boxName ?? null,
    boxStatus: row.boxStatus ?? null,
    offline: false,
    offlineSince: null,
    offlineReason: null,
    outboxDepth: null,
    oldestUnackedSeconds: null,
    lastSyncAt: row.lastHeartbeatAt?.toISOString() ?? null,
    syncStale: false,
    cacheAppliedAt: null,
    cacheAgeSeconds: null,
    journalEpoch: row.currentEpoch ?? null,
  };
  if (!row.boxId) return base;

  /**
   * Reading the box's live state and its outbox can fail on a box that has been
   * silent for a few minutes — the outbox query on a stale box state throws —
   * and this route has no permission behind it because reception, who has none
   * of the fleet's, needs it most. A 500 here is the worst answer of all: the
   * POS banner and the lane arbiter both read this route, so an error during a
   * real outage would MASK the outage and leave the till looking connected.
   * So the read is guarded, and when it cannot be done the honest answer is the
   * degraded one — the link is down or stale — in the shape the POS already
   * reads (`linkState` turns a down `boxStatus` into "box_silent").
   */
  try {
    const [state] = await db
      .select()
      .from(boxState)
      .where(eq(boxState.boxId, row.boxId))
      .limit(1);
    /**
     * The depth as the CLOUD can see it. On a Pi the outbox is a SQLite table
     * this query cannot reach and the honest answer is the depth the box
     * reported on its last heartbeat; on the virtual box the store is this
     * database, which is what makes the number on the banner the same number the
     * box would give if it were asked.
     */
    const outbox = await boxOutboxState(db, row.boxId);
    const now = Date.now();
    const oldest = outbox.oldestCreatedAt
      ? Math.max(0, Math.round((now - outbox.oldestCreatedAt.getTime()) / 1000))
      : null;
    const cacheAt = state?.lastCacheAppliedAt ?? null;

    return {
      ...base,
      offline: state?.offline ?? false,
      offlineSince: state?.offlineSince?.toISOString() ?? null,
      offlineReason: state?.offlineReason ?? null,
      outboxDepth: outbox.depth,
      oldestUnackedSeconds: oldest,
      // The cloud's own threshold, sent rather than left to the till to guess:
      // the watchdog raises its alert on this number, and a banner disagreeing
      // with the page somebody is looking at is worse than no banner.
      syncStale: oldest !== null && oldest > syncSettings().staleAfterS,
      cacheAppliedAt: cacheAt?.toISOString() ?? null,
      cacheAgeSeconds: cacheAt ? Math.max(0, Math.round((now - cacheAt.getTime()) / 1000)) : null,
      journalEpoch: state?.journalEpoch ?? base.journalEpoch,
    };
  } catch {
    return degradedStationLink(base);
  }
}

/**
 * The truthful answer when a box's state and outbox cannot be read: the link is
 * degraded. `syncStale` is set, and a box that is not already reported down is
 * reported down (`offline` status) so the POS shows the outage rather than a
 * connected-looking till. Everything else stays as the station row gave it, so
 * a transient failure that clears on the next poll costs nothing.
 */
export function degradedStationLink(base: StationLinkView): StationLinkView {
  const down = base.boxStatus === 'offline' || base.boxStatus === 'disabled';
  return {
    ...base,
    boxStatus: down ? base.boxStatus : 'offline',
    outboxDepth: null,
    oldestUnackedSeconds: null,
    syncStale: true,
  };
}

// --- Loading a station, and deciding who is asking ---------------------------

export async function loadStationRow(
  db: Db,
  operatorId: string,
  stationId: string,
): Promise<StationRow> {
  const [row] = await db
    .select({
      id: station.id,
      operatorId: station.operatorId,
      branchId: station.branchId,
      boxId: station.boxId,
      name: station.name,
      archivedAt: station.archivedAt,
    })
    .from(station)
    .where(
      and(
        eq(station.id, stationId),
        eq(station.operatorId, operatorId),
        isNull(station.archivedAt),
      ),
    )
    .limit(1);
  // Archived folded into "not found" exactly as the picker does it: to a
  // caller who cannot see the estate, "taken off the floor" and "no such
  // station" are the same fact.
  if (!row) throw new AppError(404, 'STATION_NOT_FOUND', 'No such station');
  return row;
}
