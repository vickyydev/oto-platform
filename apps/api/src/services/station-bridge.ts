import { and, eq } from 'drizzle-orm';
import { verify as verifyArgon } from '@node-rs/argon2';
import {
  StationBridge,
  type BridgeBranch,
  type BridgeStation,
  type BridgeTillCaller,
  type StaffSigningKey,
} from '@oto/box-agent';
import { boxState, branch, session as sessionTable, station, type Db } from '@oto/db';
import type { BridgeUnlockRequest, BridgeUnlockResponse, Permission } from '@oto/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../env';
import { boxStoreFor } from '../lib/box-store';
import { usableSigningKeys } from '../lib/signing-keys';
import { audit } from './audit';
import { inProcessBox } from './box';
import { hasPermission, type EffectivePermission } from './permissions';
import { sharedThrottle } from './staff-token';
import { managerForStation, type StationRow } from './station-session';
import { withTx } from './tx';

/**
 * THE STATION BRIDGE, MOUNTED BY THE API FOR A VIRTUAL BOX (offline plan §2.2,
 * Round 3).
 *
 * The bridge itself is `@oto/box-agent`'s, the same file a Raspberry Pi
 * serves. What this file adds is the api's answer to the two things a Pi
 * answers from its own config bundle and memory:
 *
 *   - WHO IS ASKING. The platform session, standing at the station it saved
 *     (OD-2: the virtual box accepts the platform session). Its permissions are
 *     the platform's own, resolved at the station's branch.
 *   - WHICH SESSION MANAGER. The api's (`managerForStation`), so a document a
 *     till changes through the bridge reaches the screens watching
 *     `/stations/:id/channel` on this process, and the other way round.
 *
 * Facts are sealed by the virtual box's agent when it runs in this process —
 * the only holder of its signing key. On an api instance it does not run on,
 * the record intents are refused by name (`BOX_AGENT_ELSEWHERE`) rather than
 * queue a fact nobody signed, and a money intent politely
 * (`BOX_LANE_PAYMENT_UNAVAILABLE`): a sale is written by the agent's own queue
 * (Round 4), with its receipt number, bands and paper, or not at all.
 */

interface MountedBox {
  bridge: StationBridge;
  stations: Map<string, BridgeStation>;
  /** A box stands at one branch, which every station on it shares. */
  branch: BridgeBranch | null;
  link: { up: boolean; offline: boolean };
  keys: StaffSigningKey[];
  log: FastifyBaseLogger | undefined;
}

const perDb = new WeakMap<object, Map<string, MountedBox>>();

/**
 * The bridge for the box this station sits on, with the station, its branch,
 * the box's link and the signing keys read for this request.
 *
 * One bridge per box and per database, kept, because it holds the box
 * sessions it issued; everything it reads through the host closures below is
 * refreshed from the rows this request loaded, so nothing is served stale.
 */
export async function bridgeForStation(
  db: Db,
  row: StationRow,
  log?: FastifyBaseLogger,
): Promise<{ bridge: StationBridge; boxId: string }> {
  const { manager, boxId } = managerForStation(db, row, log);
  let boxes = perDb.get(db as unknown as object);
  if (!boxes) {
    boxes = new Map();
    perDb.set(db as unknown as object, boxes);
  }
  let mounted = boxes.get(boxId);
  if (!mounted) {
    const store = boxStoreFor(db);
    const entry: MountedBox = {
      stations: new Map(),
      branch: null,
      link: { up: true, offline: false },
      keys: [],
      log,
      bridge: null as unknown as StationBridge,
    };
    entry.bridge = new StationBridge({
      boxId,
      store,
      sessions: manager,
      station: (stationId) => entry.stations.get(stationId) ?? null,
      branch: () => entry.branch,
      signingKeys: () => entry.keys,
      link: () => entry.link,
      sealer: () => inProcessBox(boxId)?.sealer() ?? null,
      // Round 4: a sale taken on this mount is written by the virtual box's own
      // queue, and a card is driven through its own terminals — the same code a
      // Pi runs. On an instance the agent is not running on, money is refused.
      sales: () => inProcessBox(boxId)?.sales() ?? null,
      terminals: () => inProcessBox(boxId)?.terminal() ?? null,
      verifyPassword: (hash, password) => verifyArgon(hash, password),
      now: () => new Date(),
      log: {
        info: (obj, msg) => entry.log?.info(obj, msg),
        warn: (obj, msg) => entry.log?.warn(obj, msg),
        error: (obj, msg) => entry.log?.error(obj, msg),
      },
    });
    boxes.set(boxId, entry);
    mounted = entry;
  }
  mounted.log = log;

  const [br] = await db
    .select({
      id: branch.id,
      operatorId: branch.operatorId,
      timezone: branch.timezone,
      businessDayStart: branch.businessDayStart,
    })
    .from(branch)
    .where(eq(branch.id, row.branchId))
    .limit(1);
  // The station's kind is not on `StationRow`; one small read beside it.
  const [kind] = await db
    .select({ kind: station.kind })
    .from(station)
    .where(eq(station.id, row.id))
    .limit(1);
  mounted.stations.set(row.id, {
    id: row.id,
    name: row.name,
    kind: kind?.kind ?? 'till',
    branchId: row.branchId,
    operatorId: row.operatorId,
  });
  if (br) mounted.branch = br;

  /**
   * The link, as the box would report it: the Console's switch from
   * `edge.box_state`, and the wire from the agent when it runs here. An api
   * instance the agent does not run on is itself the platform, so the wire is
   * up whenever this code is answering.
   */
  const [state] = await db
    .select({ offline: boxState.offline })
    .from(boxState)
    .where(eq(boxState.boxId, boxId))
    .limit(1);
  const agent = inProcessBox(boxId);
  mounted.link = {
    up: agent ? agent.state.linkUp : true,
    offline: state?.offline ?? false,
  };
  mounted.keys = await usableSigningKeys(db, {
    operatorId: row.operatorId,
    purpose: 'staff_token',
  });
  return { bridge: mounted.bridge, boxId };
}

/** The platform session, as a till caller the bridge understands (OD-2). */
export function platformCaller(
  accountId: string,
  operatorId: string,
  branchId: string,
  effective: EffectivePermission[],
): BridgeTillCaller {
  return {
    kind: 'till',
    accountId,
    can: (permission) =>
      hasPermission(effective, permission as Permission, { operatorId, branchId }),
    method: 'platform',
    offlineFresh: false,
    jti: null,
  };
}

export interface BridgeUnlockContext {
  sessionId: string;
  accountId: string;
  operatorId: string;
  branchId: string | null;
  requestId: string;
}

/**
 * Unlock a locked till through its box (OD-2, OD-6).
 *
 * The decision is the bridge's, from the box's own copy of the staff list and
 * the deny-list — the same decision a Pi makes with the link down — and it
 * counts wrong passwords in the platform's own buckets, so five wrong guesses
 * lock whichever door they were made at. What the api adds is what only it
 * can do: take the lock off the PLATFORM session, and write both halves of the
 * record in one transaction (SCRUM-284), exactly as `offlineUnlock` did.
 */
export async function unlockThroughBridge(
  db: Db,
  env: Env,
  row: StationRow,
  ctx: BridgeUnlockContext,
  body: BridgeUnlockRequest,
  log?: FastifyBaseLogger,
): Promise<BridgeUnlockResponse> {
  const { bridge, boxId } = await bridgeForStation(db, row, log);
  const keys = [`unlock:${ctx.sessionId}`, `unlock-account:${ctx.accountId}`];
  const throttle = sharedThrottle(db, keys, env, async () => {
    await audit.record(db, {
      actorAccountId: ctx.accountId,
      operatorId: ctx.operatorId,
      branchId: ctx.branchId,
      action: 'auth.locked_out',
      entityType: 'session',
      entityId: ctx.sessionId,
      after: {
        bucket: 'unlock',
        offline: true,
        bridge: true,
        cooldownSeconds: env.AUTH_COOLDOWN_SECONDS,
      },
      requestId: ctx.requestId,
    });
  });
  let answer: Awaited<ReturnType<StationBridge['unlock']>>;
  try {
    answer = await bridge.unlock(row.id, body, { expectAccountId: ctx.accountId, throttle });
  } catch (err) {
    await audit.record(db, {
      actorAccountId: ctx.accountId,
      operatorId: ctx.operatorId,
      branchId: ctx.branchId,
      action: 'session.unlock_failed',
      entityType: 'session',
      entityId: ctx.sessionId,
      after: {
        authMethod: 'bridge',
        refusal: (err as { code?: string }).code ?? 'UNKNOWN',
        stationId: row.id,
        boxId,
      },
      requestId: ctx.requestId,
    });
    throw err;
  }
  await withTx(
    db,
    {
      requestId: ctx.requestId,
      actorAccountId: ctx.accountId,
      operatorId: ctx.operatorId,
      branchId: ctx.branchId,
    },
    'session.unlock',
    async (tx) => {
      await tx
        .update(sessionTable)
        .set({ lockedAt: null, lastSeenAt: new Date() })
        .where(and(eq(sessionTable.id, ctx.sessionId), eq(sessionTable.accountId, ctx.accountId)));
      await audit.record(tx, {
        actorAccountId: ctx.accountId,
        operatorId: ctx.operatorId,
        branchId: ctx.branchId,
        action: 'session.unlock',
        entityType: 'session',
        entityId: ctx.sessionId,
        after: {
          authMethod: answer.response.method,
          offlineFresh: answer.response.offlineFresh,
          through: 'bridge',
          stationId: row.id,
          boxId,
          jti: answer.caller.jti,
          cachedAt: answer.response.cachedAt,
        },
        requestId: ctx.requestId,
      });
    },
  );
  return answer.response;
}
