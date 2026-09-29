import { createHash, randomInt } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, lte } from 'drizzle-orm';
import { branch, deviceCredential, displayPairingRequest, operator, station, type Db } from '@oto/db';
import { newId, type StationIntent } from '@oto/shared';
import type { StationSessionDocument } from '@oto/box-agent';
import { AppError } from '../lib/errors';
import { pgErrorOf } from '../lib/scrub';
import { audit } from './audit';
import { managerForStation } from './station-session';
import { limitPrincipal } from './throttle';
import { withTx, type OpContext } from './tx';

const PAIRING_TTL_MS = 10 * 60 * 1000;
const CONNECTED_MS = 10_000;
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

export async function displaySession(db: Db, auth: DisplayDeviceAuth) {
  const { manager } = managerForStation(db, auth.station);
  const document = await manager.open(auth.station.id);
  return {
    station: stationView(auth.station), device: auth.device,
    document: customerDocument(manager.snapshotFor(document, 'customer', null).document),
  };
}

export async function displayIntent(db: Db, auth: DisplayDeviceAuth, intent: StationIntent) {
  const { manager } = managerForStation(db, auth.station);
  const result = await manager.applyIntent(auth.station.id, { ...intent, leaseId: undefined }, {
    source: 'display', deviceId: auth.credentialId,
  });
  if (!result.ok) {
    const document = result.document
      ? customerDocument(manager.snapshotFor(result.document, 'customer', null).document)
      : null;
    throw new AppError(
      result.refusal === 'stale' ? 409 : 403,
      result.refusal === 'stale' ? 'STATION_STALE' : 'DISPLAY_INTENT_REFUSED',
      result.message,
      { document, reason: result.refusal },
    );
  }
  return { document: customerDocument(manager.snapshotFor(result.document, 'customer', null).document) };
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
