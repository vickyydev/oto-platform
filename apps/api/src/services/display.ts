import { createHash, randomInt } from 'node:crypto';
import { and, desc, eq, gt, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { box, boxState, branch, deviceCredential, displayPairingRequest, displayResponseSnapshot, operator, station, stationEvent, type Db } from '@oto/db';
import { newId, projectDisplayDiagnosticDocument, type DisplaySnapshotResponse, type StationIntent } from '@oto/shared';
import type { StationSessionDocument } from '@oto/box-agent';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../lib/errors';
import { pgErrorOf } from '../lib/scrub';
import { audit } from './audit';
import { managerForStation } from './station-session';
import { limitPrincipal } from './throttle';
import { withTx, type OpContext } from './tx';

const PAIRING_TTL_MS = 10 * 60 * 1000;
const CONNECTED_MS = 10_000;
const REJECTION_OBSERVATION_MS = 60_000;
export type DisplayScope = 'display:read' | 'display:intents';
const DISPLAY_SCOPES: DisplayScope[] = ['display:read', 'display:intents'];

export const displayUnpaired = (): AppError =>
  new AppError(401, 'DISPLAY_UNPAIRED', 'This screen is not paired to a station');

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The browser makes its bearer before pairing, so a lost answer cannot lose it. */
export function displayBearerHash(authorization: string | undefined): string {
  const match = /^Bearer ([0-9a-f]{64})$/i.exec(authorization ?? '');
  if (!match) throw displayUnpaired();
  return hash(match[1]!.toLowerCase());
}

export interface DisplayDeviceAuth {
  credentialId: string;
  station: typeof station.$inferSelect;
  device: { id: string; name: string };
}

const stationView = (row: typeof station.$inferSelect) => ({ id: row.id, name: row.name, kind: row.kind });

/** Live target and scope checks apply on every call, independently of staff cookies. */
export async function authenticateDisplay(
  db: Db,
  tokenHash: string,
  scope: DisplayScope,
  touch = true,
): Promise<DisplayDeviceAuth> {
  const [row] = await db.select({ credential: deviceCredential, station })
    .from(deviceCredential)
    .innerJoin(station, and(
      eq(deviceCredential.stationId, station.id),
      eq(deviceCredential.operatorId, station.operatorId),
      eq(deviceCredential.branchId, station.branchId),
    ))
    .innerJoin(branch, and(eq(branch.id, station.branchId), eq(branch.operatorId, station.operatorId)))
    .innerJoin(operator, eq(operator.id, station.operatorId))
    .where(and(
      eq(deviceCredential.secretHash, tokenHash), eq(deviceCredential.kind, 'display'),
      isNull(deviceCredential.revokedAt), isNull(station.archivedAt),
      isNull(branch.archivedAt), isNull(operator.archivedAt),
    )).limit(1);
  if (!row || !row.credential.pairedAt || !row.credential.scopes.includes(scope)) throw displayUnpaired();
  if (touch) {
    const seen = await db.update(deviceCredential).set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(and(eq(deviceCredential.id, row.credential.id), isNull(deviceCredential.revokedAt)))
      .returning({ id: deviceCredential.id });
    if (!seen.length) throw displayUnpaired();
  }
  return {
    credentialId: row.credential.id,
    station: row.station,
    device: { id: row.credential.id, name: row.credential.label ?? 'Customer display' },
  };
}

/** Observe a real protected-call refusal, never a pairing-status answer or an unknown bearer. */
export async function observeRejectedDisplayCall(
  db: Db,
  tokenHash: string,
  intentType: 'display.session' | 'display.intents',
): Promise<void> {
  await db.transaction(async (tx) => {
    const [request] = await tx.select({ credentialId: displayPairingRequest.credentialId })
      .from(displayPairingRequest).where(eq(displayPairingRequest.tokenHash, tokenHash)).limit(1);
    if (!request?.credentialId) return;
    // The credential lock bounds observations across API instances and concurrent polls.
    const [credential] = await tx.select({
      id: deviceCredential.id, operatorId: deviceCredential.operatorId,
      branchId: deviceCredential.branchId, stationId: deviceCredential.stationId,
    }).from(deviceCredential).where(and(
      eq(deviceCredential.id, request.credentialId), eq(deviceCredential.kind, 'display'),
      isNotNull(deviceCredential.revokedAt), isNotNull(deviceCredential.pairedAt),
    )).limit(1).for('update');
    if (!credential?.stationId) return;
    const [target] = await tx.select({ stationId: station.id, boxId: box.id })
      .from(station).innerJoin(box, and(
        eq(box.id, station.boxId), eq(box.operatorId, station.operatorId), eq(box.branchId, station.branchId),
      )).innerJoin(branch, and(eq(branch.id, station.branchId), eq(branch.operatorId, station.operatorId)))
      .innerJoin(operator, eq(operator.id, station.operatorId)).where(and(
        eq(station.id, credential.stationId), eq(station.operatorId, credential.operatorId),
        eq(station.branchId, credential.branchId),
      )).limit(1);
    if (!target) return;
    const now = new Date();
    const [previous] = await tx.select({ at: stationEvent.receivedAt }).from(stationEvent).where(and(
      eq(stationEvent.stationId, target.stationId), eq(stationEvent.boxId, target.boxId),
      eq(stationEvent.kind, 'error'), eq(stationEvent.source, 'display'),
      eq(stationEvent.outcome, 'refused'), eq(stationEvent.errorCode, 'DISPLAY_UNPAIRED'),
      sql`${stationEvent.payload}->>'deviceId' = ${credential.id}`,
    )).orderBy(desc(stationEvent.receivedAt)).limit(1);
    if (previous && now.getTime() - previous.at.getTime() < REJECTION_OBSERVATION_MS) return;
    await tx.insert(stationEvent).values({
      id: newId(), stationId: target.stationId, boxId: target.boxId,
      kind: 'error', source: 'display', intentType, outcome: 'refused', errorCode: 'DISPLAY_UNPAIRED',
      payload: { deviceId: credential.id }, occurredAt: now, receivedAt: now,
    });
  });
}

/** One outstanding code per bearer; retrying an unanswered mint rotates that code. */
export async function requestDisplayPairing(
  db: Db,
  ctx: OpContext,
  tokenHash: string,
  ip: string,
): Promise<{ pairingCode: string; expiresAt: string }> {
  await limitPrincipal(db, `display-pairing:${ip}`, 100, 600);
  for (let retry = 0; retry < 5; retry += 1) {
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    try {
      return await withTx(db, ctx, 'display.pairing_requested', async (tx) => {
        // Expired anonymous codes no longer occupy the short-code namespace.
        await tx.update(displayPairingRequest).set({ pairingCodeHash: null, updatedAt: new Date() })
          .where(and(lte(displayPairingRequest.expiresAt, new Date()), isNull(displayPairingRequest.credentialId)));
        const [previous] = await tx.select({
          pairingCodeHash: displayPairingRequest.pairingCodeHash,
          credentialId: displayPairingRequest.credentialId,
        }).from(displayPairingRequest).where(eq(displayPairingRequest.tokenHash, tokenHash)).limit(1).for('update');
        if (previous?.credentialId) throw new AppError(409, 'DISPLAY_ALREADY_PAIRED', 'This screen is already paired');
        let pairingCode = '';
        let codeHash = '';
        for (let rotation = 0; rotation < 5; rotation += 1) {
          const candidate = String(randomInt(0, 1_000_000)).padStart(6, '0');
          const candidateHash = hash(candidate);
          if (candidateHash === previous?.pairingCodeHash) continue;
          pairingCode = candidate;
          codeHash = candidateHash;
          break;
        }
        if (!pairingCode) throw new AppError(503, 'DISPLAY_PAIRING_BUSY', 'Try pairing this screen again shortly');
        const [row] = await tx.insert(displayPairingRequest).values({
          id: newId(), tokenHash, pairingCodeHash: codeHash, expiresAt,
        }).onConflictDoUpdate({
          target: displayPairingRequest.tokenHash,
          set: { pairingCodeHash: codeHash, expiresAt, updatedAt: new Date() },
          setWhere: isNull(displayPairingRequest.credentialId),
        }).returning({ id: displayPairingRequest.id });
        if (!row) throw new AppError(409, 'DISPLAY_ALREADY_PAIRED', 'This screen is already paired');
        await audit.record(tx, {
          actorAccountId: null, operatorId: null, branchId: null,
          action: 'display.pairing_requested', entityType: 'display_pairing_request', entityId: row.id,
          after: { expiresAt: expiresAt.toISOString() }, requestId: ctx.requestId,
        });
        return { pairingCode, expiresAt: expiresAt.toISOString() };
      });
    } catch (error) {
      const pg = pgErrorOf(error);
      if (pg?.code !== '23505' || pg.constraint !== 'display_pairing_request_code_unique') throw error;
    }
  }
  throw new AppError(503, 'DISPLAY_PAIRING_BUSY', 'Try pairing this screen again shortly');
}

export async function displayPairingStatus(db: Db, tokenHash: string) {
  const [request] = await db.select().from(displayPairingRequest)
    .where(eq(displayPairingRequest.tokenHash, tokenHash)).limit(1);
  if (!request) return { status: 'expired' as const };
  if (request.credentialId) {
    try {
      const auth = await authenticateDisplay(db, tokenHash, 'display:read');
      return { status: 'paired' as const, station: stationView(auth.station), device: auth.device };
    } catch (error) {
      if (error instanceof AppError && error.code === 'DISPLAY_UNPAIRED') return { status: 'expired' as const };
      throw error;
    }
  }
  return { status: request.expiresAt.getTime() > Date.now() ? 'pending' as const : 'expired' as const };
}

/** The unpaired browser can invalidate its own code without revoking a device. */
export async function expireDisplayPairing(db: Db, ctx: OpContext, tokenHash: string) {
  return withTx(db, ctx, 'display.pairing_expired', async (tx) => {
    const [request] = await tx.select().from(displayPairingRequest)
      .where(eq(displayPairingRequest.tokenHash, tokenHash)).limit(1).for('update');
    if (request?.credentialId) throw new AppError(409, 'DISPLAY_ALREADY_PAIRED', 'This screen is already paired');
    if (request?.pairingCodeHash) {
      const now = new Date();
      await tx.update(displayPairingRequest).set({ pairingCodeHash: null, expiresAt: now, updatedAt: now })
        .where(eq(displayPairingRequest.id, request.id));
      await audit.record(tx, {
        actorAccountId: null, operatorId: null, branchId: null,
        action: 'display.pairing_expired', entityType: 'display_pairing_request', entityId: request.id,
        after: { expired: true }, requestId: ctx.requestId,
      });
    }
    return { expired: true as const };
  });
}

/** Code consumption, credential and manager attribution commit together. */
export async function claimDisplay(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  target: typeof station.$inferSelect,
  input: { pairingCode: string; name: string },
) {
  await limitPrincipal(db, `display-claim:${actor.accountId}`, 100, 600);
  return withTx(db, ctx, 'display.paired', async (tx) => {
    const [current] = await tx.select().from(station).where(and(
      eq(station.id, target.id), eq(station.operatorId, actor.operatorId), eq(station.branchId, target.branchId),
    )).limit(1).for('update');
    if (!current || current.archivedAt) throw new AppError(404, 'STATION_NOT_FOUND', 'No such station');
    if (current.kind !== 'till' && current.kind !== 'kiosk') {
      throw new AppError(409, 'DISPLAY_STATION_INVALID', 'Pair a customer display to a till or kiosk');
    }
    if (!current.boxId) throw new AppError(409, 'STATION_HAS_NO_BOX', 'Assign a box before pairing a display');
    const [request] = await tx.select().from(displayPairingRequest)
      .where(and(
        eq(displayPairingRequest.pairingCodeHash, hash(input.pairingCode)),
        isNull(displayPairingRequest.credentialId), gt(displayPairingRequest.expiresAt, new Date()),
      )).limit(1).for('update');
    if (!request) throw new AppError(409, 'DISPLAY_PAIRING_INVALID', 'This pairing code has expired or already been used');
    const [active] = await tx.select({ id: deviceCredential.id }).from(deviceCredential).where(and(
      eq(deviceCredential.stationId, current.id), eq(deviceCredential.kind, 'display'),
      isNull(deviceCredential.revokedAt), isNotNull(deviceCredential.pairedAt), isNotNull(deviceCredential.secretHash),
    )).limit(1);
    if (active) throw new AppError(409, 'DISPLAY_STATION_OCCUPIED', 'Revoke the current display before pairing another at this station');
    const id = newId();
    const claimedAt = new Date();
    await tx.insert(deviceCredential).values({
      id, operatorId: actor.operatorId, branchId: current.branchId, stationId: current.id,
      kind: 'display', label: input.name, secretHash: request.tokenHash, scopes: DISPLAY_SCOPES,
      pairedAt: claimedAt, pairedByAccountId: actor.accountId,
    });
    await tx.update(displayPairingRequest).set({
      credentialId: id, claimedAt, pairingCodeHash: null, updatedAt: claimedAt,
    }).where(eq(displayPairingRequest.id, request.id));
    const answer = { station: stationView(current), device: { id, name: input.name } };
    await audit.record(tx, {
      actorAccountId: actor.accountId, operatorId: actor.operatorId, branchId: current.branchId,
      action: 'display.paired', entityType: 'device_credential', entityId: id,
      after: { stationId: current.id, name: input.name }, requestId: ctx.requestId,
    });
    return answer;
  });
}

/** No staff lease or holder identity belongs on the customer-facing screen. */
function customerDocument(document: StationSessionDocument): StationSessionDocument {
  return { ...document, lease: null };
}

interface SnapshotEpoch { cloud: number; local: number | null }

const snapshotFailure = (log?: FastifyBaseLogger) => log?.warn({ event: 'display.snapshot_capture_failed' },
  'The last display response could not be recorded');

/** Freeze before reading a document that itself has no box journal epoch. */
async function snapshotEpoch(db: Db, auth: DisplayDeviceAuth, log?: FastifyBaseLogger): Promise<SnapshotEpoch | null> {
  try {
    const [target] = await db.select({ cloud: box.currentEpoch, local: boxState.journalEpoch }).from(box)
      .leftJoin(boxState, eq(boxState.boxId, box.id))
      .innerJoin(branch, and(eq(branch.id, box.branchId), eq(branch.operatorId, box.operatorId)))
      .innerJoin(operator, eq(operator.id, box.operatorId)).where(and(
        eq(box.id, auth.station.boxId ?? ''), eq(box.operatorId, auth.station.operatorId), eq(box.branchId, auth.station.branchId),
        isNull(box.archivedAt), isNull(branch.archivedAt), isNull(operator.archivedAt),
      )).limit(1);
    return target ?? null;
  } catch { snapshotFailure(log); return null; }
}

/**
 * Serial response preparation, not proof of browser receipt. Station first,
 * then credential follows pairing's lock order; revoke locks only credential.
 * A refused credential, changed target/epoch, or absent document never replaces history.
 */
async function recordDisplayResponse(db: Db, auth: DisplayDeviceAuth, expectedEpoch: SnapshotEpoch | null,
  document: StationSessionDocument | null, responseKind: 'session' | 'intent', statusCode: 200 | 403 | 409,
  log?: FastifyBaseLogger): Promise<void> {
  if (!expectedEpoch || !document || !auth.station.boxId) return;
  try {
    await db.transaction(async (tx) => {
      const [target] = await tx.select().from(station).where(and(
        eq(station.id, auth.station.id), eq(station.operatorId, auth.station.operatorId),
        eq(station.branchId, auth.station.branchId), eq(station.boxId, auth.station.boxId!), isNull(station.archivedAt),
      )).limit(1).for('share');
      if (!target) return;
      const [credential] = await tx.select().from(deviceCredential).where(and(
        eq(deviceCredential.id, auth.credentialId), eq(deviceCredential.kind, 'display'),
        eq(deviceCredential.stationId, target.id), eq(deviceCredential.operatorId, target.operatorId),
        eq(deviceCredential.branchId, target.branchId), isNull(deviceCredential.revokedAt),
        isNotNull(deviceCredential.secretHash), isNotNull(deviceCredential.pairedAt),
      )).limit(1).for('update');
      if (!credential?.scopes.includes(responseKind === 'session' ? 'display:read' : 'display:intents')) return;
      const [epoch] = await tx.select({ cloud: box.currentEpoch, local: boxState.journalEpoch }).from(box)
        .leftJoin(boxState, eq(boxState.boxId, box.id))
        .innerJoin(branch, and(eq(branch.id, box.branchId), eq(branch.operatorId, box.operatorId)))
        .innerJoin(operator, eq(operator.id, box.operatorId)).where(and(eq(box.id, target.boxId!),
          eq(box.operatorId, target.operatorId), eq(box.branchId, target.branchId),
          isNull(box.archivedAt), isNull(branch.archivedAt), isNull(operator.archivedAt))).limit(1);
      if (!epoch || epoch.cloud !== expectedEpoch.cloud || epoch.local !== expectedEpoch.local
        || document.stationId !== target.id || document.boxId !== target.boxId) return;
      // This locked projection and timestamp define the recording order even
      // for language responses that deliberately keep the same sequence.
      const projected = projectDisplayDiagnosticDocument(document);
      if (!projected) throw new Error('Display diagnostic projection is invalid');
      const recorded = { credentialId: credential.id, operatorId: target.operatorId, branchId: target.branchId,
        stationId: target.id, boxId: target.boxId!, journalEpoch: epoch.local ?? epoch.cloud,
        preparedAt: new Date(), responseKind, statusCode, document: projected };
      await tx.insert(displayResponseSnapshot).values(recorded).onConflictDoUpdate({
        target: displayResponseSnapshot.credentialId, set: recorded,
      });
    });
  } catch { snapshotFailure(log); }
}

/** Current and captured park permissions are both required for retained history. */
export async function readDisplaySnapshot(db: Db, credential: typeof deviceCredential.$inferSelect,
  authorize: (branchId: string) => Promise<void>): Promise<DisplaySnapshotResponse> {
  if (credential.kind !== 'display' || !credential.branchId) throw new AppError(404, 'DISPLAY_NOT_FOUND', 'No such display');
  await authorize(credential.branchId);
  const [saved] = await db.select().from(displayResponseSnapshot).where(and(
    eq(displayResponseSnapshot.credentialId, credential.id), eq(displayResponseSnapshot.operatorId, credential.operatorId),
  )).limit(1);
  const empty = { snapshot: null, revoked: credential.revokedAt !== null, targetChanged: false };
  if (!saved) return empty;
  const [historicalPark] = await db.select({ id: branch.id }).from(branch).where(and(
    eq(branch.id, saved.branchId), eq(branch.operatorId, credential.operatorId),
  )).limit(1);
  if (!historicalPark) return empty;
  await authorize(saved.branchId);
  const document = projectDisplayDiagnosticDocument(saved.document);
  if (!document || document.stationId !== saved.stationId || document.boxId !== saved.boxId) return empty;
  const [current] = credential.stationId ? await db.select({ stationId: station.id, boxId: box.id,
    cloud: box.currentEpoch, local: boxState.journalEpoch }).from(station)
    .leftJoin(box, and(eq(box.id, station.boxId), eq(box.operatorId, station.operatorId), eq(box.branchId, station.branchId), isNull(box.archivedAt)))
    .innerJoin(branch, and(eq(branch.id, station.branchId), eq(branch.operatorId, station.operatorId), isNull(branch.archivedAt)))
    .innerJoin(operator, and(eq(operator.id, station.operatorId), isNull(operator.archivedAt)))
    .leftJoin(boxState, eq(boxState.boxId, box.id)).where(and(eq(station.id, credential.stationId),
      eq(station.operatorId, credential.operatorId), eq(station.branchId, credential.branchId), isNull(station.archivedAt),
    )).limit(1) : [];
  const targetChanged = !current || current.stationId !== saved.stationId || current.boxId !== saved.boxId
    || credential.branchId !== saved.branchId || current.cloud !== saved.journalEpoch
    || current.local !== null && current.local !== saved.journalEpoch;
  return { snapshot: { stationId: saved.stationId, boxId: saved.boxId, journalEpoch: saved.journalEpoch,
    preparedAt: saved.preparedAt.toISOString(), responseKind: saved.responseKind, statusCode: saved.statusCode, document },
    revoked: credential.revokedAt !== null, targetChanged };
}

export async function displaySession(db: Db, auth: DisplayDeviceAuth, log?: FastifyBaseLogger) {
  const epoch = await snapshotEpoch(db, auth, log);
  const { manager } = managerForStation(db, auth.station);
  const document = await manager.open(auth.station.id);
  const answer = {
    station: stationView(auth.station), device: auth.device,
    document: customerDocument(manager.snapshotFor(document, 'customer', null).document),
  };
  await recordDisplayResponse(db, auth, epoch, answer.document, 'session', 200, log);
  return answer;
}

export async function displayIntent(db: Db, auth: DisplayDeviceAuth, intent: StationIntent, log?: FastifyBaseLogger) {
  const epoch = await snapshotEpoch(db, auth, log);
  const { manager } = managerForStation(db, auth.station);
  const result = await manager.applyIntent(auth.station.id, { ...intent, leaseId: undefined }, {
    source: 'display', deviceId: auth.credentialId,
  });
  if (!result.ok) {
    const document = result.document
      ? customerDocument(manager.snapshotFor(result.document, 'customer', null).document)
      : null;
    const statusCode = result.refusal === 'stale' ? 409 : 403;
    await recordDisplayResponse(db, auth, epoch, document, 'intent', statusCode, log);
    throw new AppError(
      statusCode,
      result.refusal === 'stale' ? 'STATION_STALE' : 'DISPLAY_INTENT_REFUSED',
      result.message,
      { document, reason: result.refusal },
    );
  }
  const answer = { document: customerDocument(manager.snapshotFor(result.document, 'customer', null).document) };
  await recordDisplayResponse(db, auth, epoch, answer.document, 'intent', 200, log);
  return answer;
}

export async function stationDisplays(db: Db, stationId: string, operatorId: string) {
  const rows = await db.select({ id: deviceCredential.id, name: deviceCredential.label, lastSeenAt: deviceCredential.lastSeenAt })
    .from(deviceCredential).where(and(
      eq(deviceCredential.stationId, stationId), eq(deviceCredential.operatorId, operatorId),
      eq(deviceCredential.kind, 'display'), isNull(deviceCredential.revokedAt),
      isNotNull(deviceCredential.pairedAt), isNotNull(deviceCredential.secretHash),
    ));
  return { displays: rows.map((row) => ({
    id: row.id, name: row.name ?? 'Customer display', lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    connected: Boolean(row.lastSeenAt && row.lastSeenAt.getTime() >= Date.now() - CONNECTED_MS),
  })) };
}
