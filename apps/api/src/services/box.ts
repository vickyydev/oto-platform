import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  box,
  boxCommand,
  boxHeartbeat,
  branch,
  device,
  signingKey,
  station,
  stationDevice,
  type Db,
} from '@oto/db';
import { newId } from '@oto/shared';
import {
  createBoxAgent,
  memoryCredentialStore,
  type BoxAgent,
  type BoxCommandHandout,
  type BoxCommandKind,
  type BoxCommandResultRequest,
  type BoxCommandResultResponse,
  type BoxConfigBundle,
  type BoxConfigDevice,
  type BoxConfigStation,
  type BoxHeartbeatAck,
  type BoxHeartbeatRequest,
  type BoxRegisterRequest,
  type BoxRegisterResponse,
} from '@oto/box-agent';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import { processRoles } from './jobs';
import { recordRun, scrubDetail } from './ops';
import { limitPrincipal } from './throttle';
import { withTx, type Exec, type OpContext } from './tx';

/**
 * The cloud side of a box (S2-04).
 *
 * A box is a Raspberry Pi standing in a shopping mall that anybody can walk up
 * to, unplug and carry home. Everything in this file is written from that
 * assumption:
 *
 *   - **A box credential authenticates exactly one box.** Every query below
 *     takes its box id from the credential and never from the request body, so
 *     a stolen box can talk about itself and about nothing else: its own
 *     config, its own devices, its own commands. It cannot read a member, a
 *     sale, an account or another counter's printer, and it holds no key that
 *     signs anything.
 *   - **Refusal is a local decision.** Marking the box `disabled`, or issuing
 *     a fresh claim code (which replaces the secret on the next registration),
 *     cuts a stolen box off at the next request it makes. Both are one field.
 *   - **Replay is assumed.** A heartbeat, a claim code and a command result
 *     can all arrive twice — captured on the wire, or retried because the
 *     answer was lost — and each has its own defence below, at the point it
 *     would do damage.
 *
 * What a box legitimately learns from its config bundle is the wiring of its
 * own counter: device addresses on the park's LAN, printer protocols, and the
 * TID and MID of the terminals plugged into it. It needs all of those to drive
 * them. None is a credential, and a box taken off site is disabled from the
 * Console before it is worth anything.
 */

// --- Settings ---------------------------------------------------------------

/**
 * Read from the process rather than from `env.ts`, in the same way and for the
 * same reason as `SLOW_REQUEST_MS` in `plugins/telemetry.ts`: the env schema is
 * shared with the deploy blueprint and the boot guard, and it is where these
 * belong once the fleet settles. The defaults below are the working values for
 * one branch with a handful of boxes, and every one of them is a deployment
 * decision rather than a constant — hence the names.
 */
export interface BoxSettings {
  heartbeatIntervalS: number;
  /** Silence longer than this makes a box offline. Three missed beats. */
  offlineAfterS: number;
  minAgentVersion: string;
  /** Beyond this the box's clock is not trusted and its heartbeat is refused. */
  maxClockSkewS: number;
  claimCodeTtlS: number;
  heartbeatRetentionDays: number;
  /** Per-IP, per-route: the park's boxes all share one public address. */
  ipRateMax: number;
  /** Per box, per minute, across every box route. */
  boxRateMax: number;
  /** Which seeded box the in-process agent takes over, and where the api is. */
  agentBranchCode: string;
  agentSlot: string;
  agentApiUrl: string | null;
}

function num(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function boxSettings(): BoxSettings {
  return {
    heartbeatIntervalS: num('BOX_HEARTBEAT_INTERVAL_S', 60),
    offlineAfterS: num('BOX_OFFLINE_AFTER_S', 180),
    minAgentVersion: process.env.BOX_MIN_AGENT_VERSION || '0.1.0',
    maxClockSkewS: num('BOX_MAX_CLOCK_SKEW_S', 900),
    claimCodeTtlS: num('BOX_CLAIM_CODE_TTL_S', 3600),
    heartbeatRetentionDays: num('BOX_HEARTBEAT_RETENTION_DAYS', 14),
    ipRateMax: num('BOX_RATE_LIMIT_IP_MAX', 600),
    boxRateMax: num('BOX_RATE_LIMIT_MAX', 240),
    agentBranchCode: process.env.BOX_AGENT_BRANCH_CODE || 'hkt-central',
    agentSlot: process.env.BOX_AGENT_SLOT || 'virtual-1',
    agentApiUrl: process.env.BOX_AGENT_API_URL || null,
  };
}

// --- Secrets and codes ------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Both halves are hex of the same length, so the only thing a comparison can
 * leak is timing — which this removes. The length guard is separate because
 * `timingSafeEqual` throws on a mismatch rather than answering false.
 */
function hashesMatch(a: string | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** 256 bits. Machine-to-machine, never typed by anybody, so it is long. */
function mintSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * A claim code is read out loud — over the phone, off a screen, onto a sticker
 * taped to a Pi — so it drops the characters people confuse (I, L, O, U, 0, 1)
 * and is grouped for reading. Fifty bits of entropy is not a lot on its own,
 * which is why it is single-use, expires within the hour, and sits behind the
 * same throttle as a sign-in attempt.
 */
const CLAIM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export function mintClaimCode(): string {
  let code = '';
  for (let i = 0; i < 10; i += 1) code += CLAIM_ALPHABET[randomInt(CLAIM_ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Spaces, dashes and case are how it was read out, not part of the secret. */
export function normaliseClaimCode(raw: string): string {
  return raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

// --- Authentication ---------------------------------------------------------

export interface BoxAuth {
  boxId: string;
  operatorId: string;
  branchId: string;
  name: string;
  slot: string;
  role: string;
  status: string;
  currentEpoch: number;
  /** The newest heartbeat we accepted, which is the replay watermark. */
  lastStatus: Record<string, unknown> | null;
}

const UNAUTHORIZED = () =>
  new AppError(401, 'BOX_UNAUTHORIZED', 'This box credential is not valid');

/**
 * `Authorization: Bearer <boxId>.<secret>`.
 *
 * The box id travels in the clear so the lookup is one indexed read on the
 * primary key rather than a scan for a matching hash; the secret is what is
 * checked. An unknown box and a wrong secret give the same answer, because
 * telling a caller which of the two it got is telling it which box ids exist.
 */
export async function authenticateBox(
  db: Db,
  header: string | undefined,
  ctx: { ip: string },
): Promise<BoxAuth> {
  const settings = boxSettings();
  const refuse = async (): Promise<never> => {
    // Counted only on failure, so an honest box heartbeating every minute
    // never approaches it and somebody working through box ids does.
    await limitPrincipal(db, `box-auth:${ctx.ip}`, 30, 300);
    throw UNAUTHORIZED();
  };

  const raw = typeof header === 'string' ? header.trim() : '';
  const bearer = /^Bearer\s+(.+)$/i.exec(raw)?.[1];
  const separator = bearer ? bearer.indexOf('.') : -1;
  if (!bearer || separator <= 0) return refuse();
  const boxId = bearer.slice(0, separator);
  const secret = bearer.slice(separator + 1);
  // Shaped like a uuid and long enough to be a secret, before a query runs:
  // anything else is somebody probing, and probing should not cost a read.
  if (!/^[0-9a-f-]{36}$/i.test(boxId) || secret.length < 32) return refuse();

  const [row] = await db.select().from(box).where(eq(box.id, boxId)).limit(1);
  if (!row || row.archivedAt) return refuse();
  if (!hashesMatch(row.secretHash, sha256Hex(secret))) return refuse();
  if (row.status === 'disabled') {
    // Distinct from a bad credential on purpose: the credential IS this box's,
    // and an administrator took it out of service. A box told "you are
    // disabled" stops retrying and says so on its own screen.
    throw new AppError(403, 'BOX_DISABLED', 'This box has been taken out of service');
  }

  // One bucket for everything this box does. Generous — a box polls for
  // commands every few seconds — and still a ceiling, so a box stuck in a
  // retry loop cannot turn itself into the api's largest caller.
  await limitPrincipal(db, `box:${boxId}`, settings.boxRateMax, 60);

  return {
    boxId: row.id,
    operatorId: row.operatorId,
    branchId: row.branchId,
    name: row.name,
    slot: row.slot,
    role: row.role,
    status: row.status,
    currentEpoch: row.currentEpoch,
    lastStatus: (row.lastStatus ?? null) as Record<string, unknown> | null,
  };
}

// --- Registration -----------------------------------------------------------

export interface RegisterContext extends OpContext {
  ip: string;
}

/**
 * Redeem a claim code for the box's own secret.
 *
 * **Single use, and what that costs.** The hash is nulled the moment it is
 * redeemed, and the secret is returned once and never stored in readable form.
 * So a registration whose ANSWER is lost on the way back — a dropped response
 * from Render to Phuket — leaves a box with no credential and a code that no
 * longer works. That is a deliberate trade rather than an oversight: the
 * alternative is either storing the secret so it can be handed out again, or
 * leaving a redeemed code alive for a window, and both turn a one-time
 * credential into a reusable one. The recovery is an administrator issuing a
 * new claim code, which takes seconds and is exactly what the Console shows a
 * box as needing: `registered_at` null and `status` unclaimed.
 */
export async function registerBox(
  db: Db,
  input: BoxRegisterRequest,
  ctx: RegisterContext,
): Promise<BoxRegisterResponse> {
  const settings = boxSettings();
  const normalised = normaliseClaimCode(input.claimCode);
  const claimHash = sha256Hex(normalised);

  /**
   * Counted per code rather than per IP: the thing being guessed is the code,
   * and a box registers from whatever address its mall connection has today.
   * The key is the hash, so nothing derived from the code itself is written
   * into the throttle table.
   */
  await limitPrincipal(db, `box-claim:${claimHash.slice(0, 16)}`, 10, 900);

  const [candidate] = await db
    .select()
    .from(box)
    .where(and(eq(box.claimCodeHash, claimHash), isNull(box.archivedAt)))
    .limit(1);

  if (!candidate) {
    await limitPrincipal(db, `box-claim-miss:${ctx.ip}`, 20, 900);
    throw new AppError(
      401,
      'BOX_CLAIM_INVALID',
      'That claim code is not recognised, or it has already been used',
    );
  }
  if (candidate.claimCodeExpiresAt && candidate.claimCodeExpiresAt <= new Date()) {
    // Cleared as well as refused: an expired code left in the column is a
    // credential sitting in the database that nothing will ever honour.
    await db
      .update(box)
      .set({ claimCodeHash: null, claimCodeExpiresAt: null })
      .where(and(eq(box.id, candidate.id), eq(box.claimCodeHash, claimHash)));
    throw new AppError(401, 'BOX_CLAIM_EXPIRED', 'That claim code has expired — ask for a new one');
  }
  if (candidate.status === 'disabled') {
    throw new AppError(403, 'BOX_DISABLED', 'This box has been taken out of service');
  }

  const secret = mintSecret();
  return withTx(db, ctx, 'box.register', async (tx) => {
    const updated = await tx
      .update(box)
      .set({
        secretHash: sha256Hex(secret),
        claimCodeHash: null,
        claimCodeExpiresAt: null,
        registeredAt: new Date(),
        agentVersion: input.agentVersion,
        hostname: input.hostname ?? candidate.hostname,
        /**
         * Registered is not the same as alive. The first heartbeat is what
         * makes a box online, and until it arrives `offline` is the honest
         * answer — the Console must be able to show a box that registered and
         * then never said another word.
         */
        status: candidate.status === 'unclaimed' ? 'offline' : candidate.status,
      })
      // Still conditioned on the code: two registrations racing on the same
      // code must not both mint a secret, and the loser has to be told.
      .where(and(eq(box.id, candidate.id), eq(box.claimCodeHash, claimHash)))
      .returning();

    const row = updated[0];
    if (!row) {
      throw new AppError(
        409,
        'BOX_CLAIM_CONSUMED',
        'That claim code was used a moment ago — ask for a new one',
      );
    }

    await audit.record(tx, {
      // No person did this: a machine redeemed a code a person issued. Who
      // issued it is on the `box.claim_code_issue` row.
      actorAccountId: null,
      operatorId: row.operatorId,
      branchId: row.branchId,
      action: 'box.register',
      entityType: 'box',
      entityId: row.id,
      before: { status: candidate.status, registeredAt: candidate.registeredAt?.toISOString() ?? null },
      after: {
        slot: row.slot,
        role: row.role,
        hostname: row.hostname,
        agentVersion: row.agentVersion,
        epoch: row.currentEpoch,
        ip: ctx.ip,
      },
      requestId: ctx.requestId,
    });

    return {
      boxId: row.id,
      secret,
      name: row.name,
      slot: row.slot,
      role: row.role,
      branchId: row.branchId,
      operatorId: row.operatorId,
      epoch: row.currentEpoch,
      heartbeatIntervalS: settings.heartbeatIntervalS,
      minSupportedAgentVersion: settings.minAgentVersion,
    };
  });
}

/**
 * Issue a claim code for a box and return it once.
 *
 * The plaintext is returned to the caller and never logged, never audited and
 * never stored: the row keeps its hash and its expiry, which is everything
 * needed to honour it and nothing needed to use it.
 */
export async function issueClaimCode(
  exec: Exec,
  boxId: string,
  opts: { ttlSeconds?: number; issuedByAccountId?: string | null; requestId?: string | null } = {},
): Promise<string> {
  const settings = boxSettings();
  const code = mintClaimCode();
  const expiresAt = new Date(Date.now() + (opts.ttlSeconds ?? settings.claimCodeTtlS) * 1000);
  const updated = await exec
    .update(box)
    .set({ claimCodeHash: sha256Hex(normaliseClaimCode(code)), claimCodeExpiresAt: expiresAt })
    .where(and(eq(box.id, boxId), isNull(box.archivedAt)))
    .returning({ id: box.id, operatorId: box.operatorId, branchId: box.branchId, slot: box.slot });
  const row = updated[0];
  if (!row) throw new AppError(404, 'BOX_NOT_FOUND', 'No such box');
  await audit.record(exec, {
    actorAccountId: opts.issuedByAccountId ?? null,
    operatorId: row.operatorId,
    branchId: row.branchId,
    action: 'box.claim_code_issue',
    entityType: 'box',
    entityId: row.id,
    after: { slot: row.slot, expiresAt: expiresAt.toISOString() },
    requestId: opts.requestId ?? null,
  });
  return code;
}

// --- Heartbeat --------------------------------------------------------------

interface DeviceRow {
  id: string;
  kind: string;
  label: string;
  address: string | null;
}

export async function recordHeartbeat(
  db: Db,
  auth: BoxAuth,
  input: BoxHeartbeatRequest,
  ctx: OpContext,
): Promise<BoxHeartbeatAck> {
  const settings = boxSettings();
  const receivedAt = new Date();
  const reportedAt = new Date(input.reportedAt);
  const clockOffsetMs = reportedAt.getTime() - receivedAt.getTime();

  /**
   * Two rules, doing two different jobs.
   *
   * The skew bound says the box's clock is too far out to be worth recording
   * at all; refusing is also what stops a box banking a far-future timestamp
   * and locking itself out of the monotonic rule below for as long as that
   * timestamp stands. Fifteen minutes is generous for a machine that is
   * supposed to run NTP, and short enough that a box that got it wrong
   * recovers on its own.
   */
  if (Math.abs(clockOffsetMs) > settings.maxClockSkewS * 1000) {
    throw new AppError(
      400,
      'BOX_CLOCK_SKEW',
      `This box's clock is ${Math.round(clockOffsetMs / 1000)}s from the server's — fix the clock before reporting`,
    );
  }
  /**
   * And the monotonic rule is the replay defence: a heartbeat captured off the
   * wire and sent again would otherwise keep a box that has been unplugged
   * looking alive, which is the one lie this whole table exists to catch.
   */
  const watermark = readWatermark(auth.lastStatus);
  if (watermark !== null && reportedAt.getTime() <= watermark) {
    throw new AppError(
      409,
      'BOX_HEARTBEAT_STALE',
      'A heartbeat at or before the last one accepted from this box',
    );
  }

  const owned = (await db
    .select({ id: device.id, kind: device.kind, label: device.label, address: device.address })
    .from(device)
    .where(and(eq(device.boxId, auth.boxId), isNull(device.archivedAt)))) as DeviceRow[];
  const byId = new Map(owned.map((d) => [d.id, d]));
  const byAddress = new Map(owned.filter((d) => d.address).map((d) => [d.address!, d]));

  const matched: Array<{ row: DeviceRow; report: (typeof input.devices)[number] }> = [];
  const discovered: Array<Record<string, unknown>> = [];
  for (const report of input.devices) {
    // By id first, then by the address the box found it on. Both lookups are
    // over devices of THIS box only, so a report can never reach another
    // counter's printer however it is addressed.
    const row = (report.id ? byId.get(report.id) : undefined) ?? (report.address ? byAddress.get(report.address) : undefined);
    if (row) matched.push({ row, report });
    else {
      discovered.push({
        deviceAddress: report.address ?? null,
        kind: report.kind ?? null,
        model: report.model ?? null,
        reachability: report.reachability,
      });
    }
  }

  const lastStatus = scrubDetail({
    reportedAt: reportedAt.toISOString(),
    receivedAt: receivedAt.toISOString(),
    clockOffsetMs,
    agentVersion: input.agentVersion,
    uptimeS: input.uptimeS ?? null,
    tempC: input.tempC ?? null,
    outboxDepth: input.outboxDepth ?? 0,
    configVersion: input.configVersion ?? null,
    offline: input.offline ?? false,
    devices: matched.map(({ row, report }) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      reachability: report.reachability,
      paperStatus: report.paperStatus ?? 'unknown',
      lastError: report.lastError ?? null,
    })),
    /** Addresses the box can see that no device row claims — a wizard hint. */
    discovered,
    leases: input.leases,
    errors: input.errors,
  }) as Record<string, unknown>;

  await withTx(db, ctx, 'box.heartbeat', async (tx) => {
    await tx.insert(boxHeartbeat).values({
      id: newId(),
      boxId: auth.boxId,
      receivedAt,
      reportedAt,
      clockOffsetMs,
      agentVersion: input.agentVersion,
      uptimeS: input.uptimeS ?? null,
      tempC: input.tempC ?? null,
      outboxDepth: input.outboxDepth ?? null,
      payload: lastStatus as never,
    });

    for (const { row, report } of matched) {
      await tx
        .update(device)
        .set({
          reachability: report.reachability,
          paperStatus: report.paperStatus ?? 'unknown',
          lastError: report.lastError ?? null,
          lastSeenAt: receivedAt,
        })
        // The box id is in the WHERE and comes from the credential: the scope
        // is enforced by the statement, not only by the lookup above.
        .where(and(eq(device.id, row.id), eq(device.boxId, auth.boxId)));
    }

    await tx
      .update(box)
      .set({
        lastHeartbeatAt: receivedAt,
        lastStatus: lastStatus as never,
        agentVersion: input.agentVersion,
        // The watchdog decides `offline`; a box saying anything at all is
        // what decides `online`. `disabled` is a person's decision and is
        // never moved by a machine.
        status: auth.status === 'disabled' ? auth.status : 'online',
      })
      .where(eq(box.id, auth.boxId));
  });

  const bundle = await configBundle(db, auth);
  const pending = await countPendingCommands(db, auth.boxId);

  /**
   * The box reporting a config version it has applied, where the last one we
   * saw was different, is the only moment anybody can say "this box is now
   * running what it was told to". It belongs in `ops_run` rather than in the
   * audit log: nobody changed a record, a machine finished a job.
   */
  const previous = typeof auth.lastStatus?.configVersion === 'string' ? auth.lastStatus.configVersion : null;
  if (input.configVersion && input.configVersion !== previous) {
    await recordRun(db, {
      kind: 'device',
      name: 'device:box.config.applied',
      outcome: 'ok',
      startedAt: receivedAt,
      detail: {
        boxId: auth.boxId,
        slot: auth.slot,
        from: previous,
        to: input.configVersion,
        current: bundle.configVersion,
        stale: input.configVersion !== bundle.configVersion,
      },
      operatorId: auth.operatorId,
      branchId: auth.branchId,
      requestId: ctx.requestId ?? null,
    });
  }

  return {
    receivedAt: receivedAt.toISOString(),
    serverTime: receivedAt.toISOString(),
    clockOffsetMs,
    configVersion: bundle.configVersion,
    minSupportedAgentVersion: settings.minAgentVersion,
    heartbeatIntervalS: settings.heartbeatIntervalS,
    commandsPending: pending,
    epoch: auth.currentEpoch,
    devicesMatched: matched.length,
    devicesUnknown: discovered.length,
  };
}

function readWatermark(lastStatus: Record<string, unknown> | null): number | null {
  const reported = lastStatus?.reportedAt;
  if (typeof reported !== 'string') return null;
  const ms = Date.parse(reported);
  return Number.isFinite(ms) ? ms : null;
}

// --- Config bundle ----------------------------------------------------------

/**
 * Everything one box needs to run its counter, as one document with one
 * version over it.
 *
 * The version is a hash of the document rather than a counter, so it moves
 * when anything the box can see moves — a device's address, a payment route,
 * the branch's opening hours, the minimum agent version — and not only when
 * somebody remembers to increment a column. `station.config_version` is still
 * there and still shown: that is the number a person reads on the Console,
 * and this is the one a machine compares.
 */
export async function configBundle(db: Db, auth: BoxAuth): Promise<BoxConfigBundle> {
  const settings = boxSettings();

  const [branchRow] = await db.select().from(branch).where(eq(branch.id, auth.branchId)).limit(1);
  if (!branchRow) throw new AppError(404, 'BRANCH_NOT_FOUND', 'This box is not attached to a branch');

  const stationRows = await db
    .select()
    .from(station)
    .where(and(eq(station.boxId, auth.boxId), isNull(station.archivedAt)))
    .orderBy(asc(station.name));

  const assignments = stationRows.length
    ? await db
        .select({
          stationId: stationDevice.stationId,
          role: stationDevice.role,
          device,
        })
        .from(stationDevice)
        .innerJoin(device, eq(stationDevice.deviceId, device.id))
        .where(
          and(
            // Belt and braces: the join could only reach a device of another
            // box through a bad assignment, and a bad assignment must not
            // become a config bundle that reaches across counters.
            eq(device.boxId, auth.boxId),
            isNull(device.archivedAt),
            or(...stationRows.map((s) => eq(stationDevice.stationId, s.id))),
          ),
        )
        .orderBy(asc(stationDevice.role))
    : [];

  const devicesByStation = new Map<string, BoxConfigDevice[]>();
  for (const row of assignments) {
    const list = devicesByStation.get(row.stationId) ?? [];
    list.push({
      id: row.device.id,
      role: row.role,
      kind: row.device.kind,
      label: row.device.label,
      transport: row.device.transport,
      address: row.device.address,
      model: row.device.model,
      protocol: row.device.protocol,
      serialNumber: row.device.serialNumber,
      terminalId: row.device.terminalId,
      merchantId: row.device.merchantId,
    });
    devicesByStation.set(row.stationId, list);
  }

  const stations: BoxConfigStation[] = stationRows.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    codePrefix: s.codePrefix,
    capabilities: (s.capabilities ?? []) as string[],
    configVersion: s.configVersion,
    paymentRouting: s.paymentRouting ?? null,
    offlineWalletCapSatang: s.offlineWalletCapSatang,
    accessScope: s.accessScope,
    devices: devicesByStation.get(s.id) ?? [],
  }));

  // Public halves only, and only the ones still worth verifying against: a
  // retired key is dropped from the bundle once nothing it signed can still
  // be in a visitor's pocket.
  const keys = await db
    .select({
      purpose: signingKey.purpose,
      kid: signingKey.kid,
      algorithm: signingKey.algorithm,
      publicKey: signingKey.publicKey,
      expiresAt: signingKey.expiresAt,
      retiredAt: signingKey.retiredAt,
      operatorId: signingKey.operatorId,
    })
    .from(signingKey)
    .where(eq(signingKey.active, true))
    .orderBy(asc(signingKey.purpose), asc(signingKey.kid));

  const now = Date.now();
  const signingKeys = keys
    .filter((k) => k.operatorId === null || k.operatorId === auth.operatorId)
    .filter((k) => !k.retiredAt && (!k.expiresAt || k.expiresAt.getTime() > now))
    .map((k) => ({ purpose: k.purpose, kid: k.kid, algorithm: k.algorithm, publicKey: k.publicKey }));

  const body = {
    box: {
      id: auth.boxId,
      name: auth.name,
      slot: auth.slot,
      role: auth.role,
      epoch: auth.currentEpoch,
      status: auth.status,
    },
    branch: {
      id: branchRow.id,
      code: branchRow.code,
      name: branchRow.name,
      timezone: branchRow.timezone,
      openingHours: branchRow.openingHours ?? null,
      businessDayStart: branchRow.businessDayStart,
    },
    stations,
    signingKeys,
    heartbeatIntervalS: settings.heartbeatIntervalS,
    minSupportedAgentVersion: settings.minAgentVersion,
  };

  return { configVersion: sha256Hex(JSON.stringify(body)).slice(0, 16), ...body };
}

// --- Commands ---------------------------------------------------------------

async function countPendingCommands(db: Db, boxId: string): Promise<number> {
  const rows = await db.execute<{ pending: string }>(
    sql`select count(*)::text as pending from edge.box_command
        where box_id = ${boxId} and state = 'queued'
          and (expires_at is null or expires_at > now())`,
  );
  return Number(rows.rows[0]?.pending ?? 0);
}

/**
 * Snake case, because this one is read straight off the driver: the claim below
 * has to be a single `update … returning`, which Drizzle's query builder cannot
 * express with `for update skip locked` in its subquery.
 */
interface RawCommandRow extends Record<string, unknown> {
  id: string;
  kind: BoxCommandKind;
  payload: unknown;
  action_id: string | null;
  attempts: number;
  expires_at: Date | null;
  created_at: Date;
}

/**
 * Hand out the oldest queued commands for this box, and mark them taken in the
 * same statement.
 *
 * `for update skip locked` rather than a read followed by a write: two polls
 * arriving together — the heartbeat's follow-up and the timer's — must not
 * both be handed the same test print. `attempts` is incremented rather than
 * assumed to be one, so a box stuck taking a command it never finishes shows
 * up as a number climbing instead of as silence.
 */
export async function pollCommands(
  db: Db,
  auth: BoxAuth,
  max: number,
): Promise<BoxCommandHandout[]> {
  return db.transaction(async (tx) => {
    // A test print queued for a box that was offline all week must not fire
    // when it finally wakes up. Expiring them here rather than in a sweep
    // means it is true at the only moment it matters.
    await tx.execute(
      sql`update edge.box_command set state = 'expired', finished_at = now(), updated_at = now()
          where box_id = ${auth.boxId} and state = 'queued'
            and expires_at is not null and expires_at <= now()`,
    );
    const claimed = await tx.execute<RawCommandRow>(
      sql`update edge.box_command
             set state = 'running', claimed_at = now(), attempts = attempts + 1, updated_at = now()
           where id in (
             select id from edge.box_command
              where box_id = ${auth.boxId} and state = 'queued'
                and (expires_at is null or expires_at > now())
              order by created_at
              limit ${max}
              for update skip locked
           )
       returning id, kind, payload, action_id, attempts, expires_at, created_at`,
    );
    return claimed.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      payload: row.payload ?? null,
      actionId: row.action_id,
      attempts: row.attempts,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  });
}

/**
 * Record what the box made of a command.
 *
 * Replay matters here more than anywhere else on this surface: a box whose
 * acknowledgement was lost retries, and `reset_store` mints a new journal
 * epoch. The exactly-once property is not a check-then-write — it is the
 * `where state = 'running'` on the update. A second result finds nothing to
 * move, reads the row back and answers `replayed`, and the epoch is minted in
 * the same transaction as the state change or not at all.
 */
export async function completeCommand(
  db: Db,
  auth: BoxAuth,
  commandId: string,
  input: BoxCommandResultRequest,
  ctx: OpContext,
): Promise<BoxCommandResultResponse> {
  const [existing] = await db
    .select()
    .from(boxCommand)
    .where(and(eq(boxCommand.id, commandId), eq(boxCommand.boxId, auth.boxId)))
    .limit(1);
  // Scoped to this box: a command of another box is simply not found, which
  // is also the right answer to somebody probing for command ids.
  if (!existing) throw new AppError(404, 'BOX_COMMAND_NOT_FOUND', 'No such command for this box');

  if (existing.state !== 'running') {
    if (existing.state === 'queued') {
      throw new AppError(
        409,
        'BOX_COMMAND_NOT_CLAIMED',
        'This command has not been handed out — poll for it first',
      );
    }
    return { id: existing.id, state: existing.state, replayed: true, epoch: auth.currentEpoch };
  }

  const finishedAt = new Date();
  const outcome = await withTx(db, ctx, `box.command.${existing.kind}`, async (tx) => {
    const updated = await tx
      .update(boxCommand)
      .set({
        state: input.state,
        finishedAt,
        result: (input.result ?? null) as never,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
      })
      .where(and(eq(boxCommand.id, commandId), eq(boxCommand.state, 'running')))
      .returning({ id: boxCommand.id, state: boxCommand.state });
    if (!updated[0]) return { replayed: true as const, epoch: auth.currentEpoch };

    let epoch = auth.currentEpoch;
    if (existing.kind === 'reset_store' && input.state === 'succeeded') {
      const bumped = await tx
        .update(box)
        .set({ currentEpoch: sql`${box.currentEpoch} + 1` })
        .where(eq(box.id, auth.boxId))
        .returning({ currentEpoch: box.currentEpoch });
      epoch = bumped[0]?.currentEpoch ?? auth.currentEpoch;
      await audit.record(tx, {
        actorAccountId: existing.requestedByAccountId ?? null,
        operatorId: auth.operatorId,
        branchId: auth.branchId,
        action: 'box.epoch_reset',
        entityType: 'box',
        entityId: auth.boxId,
        before: { epoch: auth.currentEpoch },
        after: { epoch, commandId: existing.id, actionId: existing.actionId },
        requestId: ctx.requestId,
      });
    }
    return { replayed: false as const, epoch };
  });

  if (!outcome.replayed) {
    /**
     * `recordRun` reads a thrown value's code and message and nothing else, so
     * an `AppError` is the cheapest honest carrier for what the box reported;
     * the status on it is never looked at.
     */
    await recordRun(db, {
      kind: 'device',
      name: `device:box.${existing.kind}`,
      outcome: input.state === 'succeeded' ? 'ok' : 'failed',
      startedAt: existing.claimedAt ?? existing.createdAt,
      finishedAt,
      detail: { boxId: auth.boxId, slot: auth.slot, commandId: existing.id, result: input.result ?? null },
      error:
        input.state === 'failed'
          ? new AppError(
              502,
              input.errorCode ?? 'BOX_COMMAND_FAILED',
              input.errorMessage ?? 'The box reported a failure',
            )
          : undefined,
      operatorId: auth.operatorId,
      branchId: auth.branchId,
      actionId: existing.actionId,
      requestId: ctx.requestId ?? null,
    });
  }

  return {
    id: existing.id,
    state: outcome.replayed ? existing.state : input.state,
    replayed: outcome.replayed,
    epoch: outcome.epoch,
  };
}

// --- What the watchdog and the retention sweep call -------------------------

export interface SilentBox {
  id: string;
  name: string;
  slot: string;
  branchId: string;
  operatorId: string;
  lastHeartbeatAt: Date | null;
  timezone: string;
  openingHours: unknown;
  /** False when the branch has never said when it opens — see `withinOpeningHours`. */
  duringOpeningHours: boolean;
}

/**
 * Move boxes that have stopped saying anything from `online` to `offline`.
 *
 * A box that has crashed cannot tell anybody it is down, so the silence is the
 * whole signal and something has to go looking for it. This is the seam the
 * watchdog job calls; it decides only what is true and leaves raising the
 * alert to the caller, because whether a silent box is worth waking somebody
 * for depends on whether the park is open — which is a branch's business hours,
 * not a fleet fact.
 */
export async function markSilentBoxesOffline(db: Db, offlineAfterS?: number): Promise<SilentBox[]> {
  const seconds = offlineAfterS ?? boxSettings().offlineAfterS;
  const transitioned = await db.execute<{ id: string }>(
    sql`update core.box set status = 'offline', updated_at = now()
         where status = 'online' and archived_at is null
           and (last_heartbeat_at is null or last_heartbeat_at < now() - ${`${seconds} seconds`}::interval)
     returning id`,
  );
  if (transitioned.rows.length === 0) return [];
  const ids = transitioned.rows.map((r) => r.id);
  const rows = await db
    .select({
      id: box.id,
      name: box.name,
      slot: box.slot,
      branchId: box.branchId,
      operatorId: box.operatorId,
      lastHeartbeatAt: box.lastHeartbeatAt,
      timezone: branch.timezone,
      openingHours: branch.openingHours,
    })
    .from(box)
    .innerJoin(branch, eq(box.branchId, branch.id))
    .where(or(...ids.map((id) => eq(box.id, id))));
  const at = new Date();
  return rows.map((row) => ({
    ...row,
    duringOpeningHours: withinOpeningHours(row.openingHours, row.timezone, at),
  }));
}

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * Is the park open right now, per the branch's own clock?
 *
 * Null opening hours mean nobody has said yet, and that is answered `false` —
 * "do not raise" rather than "raise all night". Guessing the other way would
 * page somebody at three in the morning about a box that is off because the
 * park is shut.
 */
export function withinOpeningHours(openingHours: unknown, timezone: string, at: Date): boolean {
  if (!openingHours || typeof openingHours !== 'object') return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const read = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = read('weekday').slice(0, 3).toLowerCase();
  if (!WEEKDAY_KEYS.includes(weekday as (typeof WEEKDAY_KEYS)[number])) return false;
  const day = (openingHours as Record<string, unknown>)[weekday];
  if (!day || typeof day !== 'object') return false;
  const { open, close } = day as { open?: unknown; close?: unknown };
  if (typeof open !== 'string' || typeof close !== 'string') return false;
  const nowHm = `${read('hour').padStart(2, '0')}:${read('minute').padStart(2, '0')}`;
  // A close time earlier than the open time is a day that runs past midnight;
  // the park does not have one today, but a late party would.
  return close > open ? nowHm >= open && nowHm < close : nowHm >= open || nowHm < close;
}

/**
 * Delete heartbeats older than the retention window.
 *
 * One row a minute per box is around half a million a year each, so this table
 * is a retention problem from the day it exists. `box.last_heartbeat_at` and
 * `box.last_status` answer "is this box well right now" without touching it,
 * which is what makes throwing the history away after two weeks cheap.
 */
export async function purgeOldBoxHeartbeats(db: Db, retentionDays?: number): Promise<number> {
  const days = retentionDays ?? boxSettings().heartbeatRetentionDays;
  const result = await db.execute(
    sql`delete from edge.box_heartbeat where received_at < now() - ${`${days} days`}::interval`,
  );
  return result.rowCount ?? 0;
}

// --- The virtual box --------------------------------------------------------

let runningVirtualBox: BoxAgent | null = null;

/** The handle the Console's test controls reach the in-process box through. */
export function virtualBoxAgent(): BoxAgent | null {
  return runningVirtualBox;
}

/**
 * Give the seeded virtual box a claim code so the in-process agent can
 * register against it.
 *
 * This is the api doing, for a box it hosts itself, what an administrator does
 * on the Console for a Pi — so it is fenced the same way a Console action would
 * be, and then some: it will only ever touch a box whose role is `virtual`. A
 * real box's claim code always comes from a person.
 */
export async function provisionVirtualBox(
  db: Db,
  log: FastifyBaseLogger,
): Promise<{ boxId: string; claimCode: string } | null> {
  const settings = boxSettings();
  const [row] = await db
    .select({ id: box.id, role: box.role, slot: box.slot })
    .from(box)
    .innerJoin(branch, eq(box.branchId, branch.id))
    .where(
      and(
        eq(branch.code, settings.agentBranchCode),
        eq(box.slot, settings.agentSlot),
        isNull(box.archivedAt),
      ),
    )
    .limit(1);

  if (!row) {
    log.warn(
      { branchCode: settings.agentBranchCode, slot: settings.agentSlot },
      'no virtual box row for this deployment — the edge role has nothing to run',
    );
    return null;
  }
  if (row.role !== 'virtual') {
    log.error(
      { boxId: row.id, role: row.role },
      'refusing to provision a box that is not virtual — a real box is claimed by a person',
    );
    return null;
  }
  const claimCode = await issueClaimCode(db, row.id, { ttlSeconds: 300 });
  return { boxId: row.id, claimCode };
}

export interface VirtualBoxOptions {
  db: Db;
  env: Env;
  log: FastifyBaseLogger;
  /** The port this process is listening on; the agent talks to it over loopback. */
  port: number;
}

/**
 * Start the in-process box, if this process carries the `edge` role.
 *
 * **Where its identity lives, and why a redeploy does not disturb it.** The
 * box IS the `core.box` row found by branch code and slot — not a file, not a
 * container, not anything Render rebuilds. So a "Manual deploy" finds the same
 * row: the same box id, the same journal epoch, the same `last_status` and the
 * whole heartbeat history behind it. What the deploy does change is the
 * credential, because the agent keeps its secret in memory and a new process
 * has no memory: it mints itself a claim code, registers, and gets a fresh
 * secret. That is the right way round. A secret that survived a redeploy would
 * have to be written somewhere, and there is nowhere on a Render container to
 * write it that is both durable and private.
 *
 * Started from `index.ts` rather than from `buildApp`, for the same reason the
 * job runner is: the test suite builds an app per file, and an agent started
 * there would mean every one of them registering a box and firing timers.
 *
 * The `edge` role is single-instance by the same contract that keeps `jobs`
 * single-instance (see `services/jobs.ts`): two instances would each mint a
 * claim code, and the second would win.
 */
export async function startVirtualBox(opts: VirtualBoxOptions): Promise<BoxAgent | null> {
  const { db, env, log, port } = opts;
  if (!processRoles(env).includes('edge')) {
    log.info('virtual box not started — PROCESS_ROLES does not name edge');
    return null;
  }
  const settings = boxSettings();
  const apiBaseUrl = settings.agentApiUrl ?? `http://127.0.0.1:${port}`;
  const agent = createBoxAgent({
    apiBaseUrl,
    credentials: memoryCredentialStore(),
    hostname: `virtual-${env.DEPLOY_ENV}`,
    log: log.child({ module: 'virtual-box' }),
    heartbeatIntervalMs: settings.heartbeatIntervalS * 1000,
    claimCode: async () => (await provisionVirtualBox(db, log))?.claimCode ?? null,
  });
  try {
    await agent.start();
  } catch (err) {
    // A virtual box that cannot start is a demo that cannot be shown; it is
    // not a reason for the api in front of a branch to fall over.
    log.error({ err }, 'virtual box failed to start');
    return null;
  }
  runningVirtualBox = agent;
  return agent;
}

/** Stop the in-process box on shutdown. */
export function stopVirtualBox(): void {
  runningVirtualBox?.stop();
  runningVirtualBox = null;
}
