import { createHash, randomInt } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, lte } from 'drizzle-orm';
import { branch, deviceCredential, displayPairingRequest, operator, station, type Db } from '@oto/db';
import {
  KIOSK_DEVICE_SCOPES,
  KIOSK_PAIRING_CODE_PREFIX,
  newId,
  normaliseKioskPairingCode,
  type KioskPairingStatus,
} from '@oto/shared';
import { AppError } from '../lib/errors';
import { pgErrorOf } from '../lib/scrub';
import { audit } from './audit';
import { limitPrincipal } from './throttle';
import { withTx, type OpContext } from './tx';

/**
 * S2-20 K2 (SCRUM-217) — PAIRING A SELF-SERVICE KIOSK, the way a customer
 * display pairs today (`services/display.ts`).
 *
 * The kiosk's browser makes its own 256-bit secret before it asks for
 * anything, so a lost answer can never lose it. It asks for a short code and
 * shows it; a manager types the code into Console > Devices against a kiosk
 * station; the secret's hash becomes the kiosk's credential, carrying
 * `pos:kiosk:redeem` (K1) and nothing a person holds. Nobody types anything
 * on the kiosk itself, which is a touch screen facing the public.
 *
 * ONE STORE FOR BOTH KINDS OF SCREEN. A pairing request is "a browser holding
 * this secret wants to be paired", and `core.display_pairing_request` already
 * holds exactly that: the secret's hash, a code's hash, an expiry, and the
 * credential it became. What the browser becomes is decided by the claim, so
 * the codes are what keep a display and a kiosk apart: a display's is six
 * digits and its claim takes nothing else, a kiosk's is `K` and six digits and
 * its claim takes nothing else. A kiosk code typed into "Pair a display" fails
 * the display claim's own schema, and a display's code never matches here.
 * No migration: the round's plan expects none.
 */

const PAIRING_TTL_MS = 10 * 60 * 1000;

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

export const kioskPairingUnavailable = (): AppError =>
  new AppError(401, 'KIOSK_UNPAIRED', 'This screen is not paired to a kiosk');

/** The browser's bearer, as only its hash: the same 64-hex shape a display's has. */
export function kioskBearerHash(authorization: string | undefined): string {
  const match = /^Bearer ([0-9a-f]{64})$/i.exec(authorization ?? '');
  if (!match) throw kioskPairingUnavailable();
  return sha256Hex(match[1]!.toLowerCase());
}

/**
 * One outstanding code per browser; asking again rotates it. Codes that ran
 * out with nobody claiming them leave the short-code namespace first, as a
 * display's do — the namespace is shared.
 */
export async function requestKioskPairing(
  db: Db,
  ctx: OpContext,
  tokenHash: string,
  ip: string,
): Promise<{ pairingCode: string; expiresAt: string }> {
  await limitPrincipal(db, `kiosk-pairing:${ip}`, 100, 600);
  for (let retry = 0; retry < 5; retry += 1) {
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    try {
      return await withTx(db, ctx, 'kiosk.pairing_requested', async (tx) => {
        await tx
          .update(displayPairingRequest)
          .set({ pairingCodeHash: null, updatedAt: new Date() })
          .where(and(lte(displayPairingRequest.expiresAt, new Date()), isNull(displayPairingRequest.credentialId)));
        const [previous] = await tx
          .select({
            pairingCodeHash: displayPairingRequest.pairingCodeHash,
            credentialId: displayPairingRequest.credentialId,
          })
          .from(displayPairingRequest)
          .where(eq(displayPairingRequest.tokenHash, tokenHash))
          .limit(1)
          .for('update');
        if (previous?.credentialId) throw new AppError(409, 'KIOSK_ALREADY_PAIRED', 'This screen is already paired');
        // A secret that is already some device's live credential is that device's, however it was paired.
        const [live] = await tx
          .select({ id: deviceCredential.id })
          .from(deviceCredential)
          .where(and(eq(deviceCredential.secretHash, tokenHash), isNull(deviceCredential.revokedAt)))
          .limit(1);
        if (live) throw new AppError(409, 'KIOSK_ALREADY_PAIRED', 'This screen is already paired');
        let pairingCode = '';
        let codeHash = '';
        for (let rotation = 0; rotation < 5; rotation += 1) {
          const candidate = `${KIOSK_PAIRING_CODE_PREFIX}${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
          const candidateHash = sha256Hex(candidate);
          if (candidateHash === previous?.pairingCodeHash) continue;
          pairingCode = candidate;
          codeHash = candidateHash;
          break;
        }
        if (!pairingCode) throw new AppError(503, 'KIOSK_PAIRING_BUSY', 'Try pairing this screen again shortly');
        const [row] = await tx
          .insert(displayPairingRequest)
          .values({ id: newId(), tokenHash, pairingCodeHash: codeHash, expiresAt })
          .onConflictDoUpdate({
            target: displayPairingRequest.tokenHash,
            set: { pairingCodeHash: codeHash, expiresAt, updatedAt: new Date() },
            setWhere: isNull(displayPairingRequest.credentialId),
          })
          .returning({ id: displayPairingRequest.id });
        if (!row) throw new AppError(409, 'KIOSK_ALREADY_PAIRED', 'This screen is already paired');
        await audit.record(tx, {
          actorAccountId: null,
          operatorId: null,
          branchId: null,
          action: 'kiosk.pairing_requested',
          entityType: 'display_pairing_request',
          entityId: row.id,
          after: { kind: 'kiosk', expiresAt: expiresAt.toISOString() },
          requestId: ctx.requestId,
        });
        return { pairingCode, expiresAt: expiresAt.toISOString() };
      });
    } catch (error) {
      const pg = pgErrorOf(error);
      if (pg?.code !== '23505' || pg.constraint !== 'display_pairing_request_code_unique') throw error;
    }
  }
  throw new AppError(503, 'KIOSK_PAIRING_BUSY', 'Try pairing this screen again shortly');
}

/**
 * Waiting, paired (and to which kiosk), or a code that is no use any more.
 *
 * "Paired" is answered only for a live KIOSK credential at a kiosk station
 * that is not archived: a code a manager typed into the display claim by
 * mistake, a credential since revoked, a station since archived — each reads
 * as `expired`, and the screen starts again with a new secret.
 */
export async function kioskPairingStatus(db: Db, tokenHash: string): Promise<KioskPairingStatus> {
  const [request] = await db
    .select()
    .from(displayPairingRequest)
    .where(eq(displayPairingRequest.tokenHash, tokenHash))
    .limit(1);
  if (!request) return { status: 'expired' };
  if (request.credentialId) {
    const [row] = await db
      .select({ stationId: station.id, stationName: station.name })
      .from(deviceCredential)
      .innerJoin(
        station,
        and(eq(station.id, deviceCredential.stationId), eq(station.operatorId, deviceCredential.operatorId)),
      )
      .innerJoin(branch, and(eq(branch.id, station.branchId), eq(branch.operatorId, station.operatorId)))
      .innerJoin(operator, eq(operator.id, station.operatorId))
      .where(
        and(
          eq(deviceCredential.id, request.credentialId),
          eq(deviceCredential.kind, 'kiosk'),
          eq(deviceCredential.secretHash, tokenHash),
          isNull(deviceCredential.revokedAt),
          isNotNull(deviceCredential.pairedAt),
          eq(station.kind, 'kiosk'),
          isNull(station.archivedAt),
          isNull(branch.archivedAt),
          isNull(operator.archivedAt),
        ),
      )
      .limit(1);
    return row ? { status: 'paired', station: { id: row.stationId, name: row.stationName } } : { status: 'expired' };
  }
  return { status: request.expiresAt.getTime() > Date.now() ? 'pending' : 'expired' };
}

/** The unpaired kiosk can call its own code off without revoking anything. */
export async function expireKioskPairing(db: Db, ctx: OpContext, tokenHash: string): Promise<{ expired: true }> {
  return withTx(db, ctx, 'kiosk.pairing_expired', async (tx) => {
    const [request] = await tx
      .select()
      .from(displayPairingRequest)
      .where(eq(displayPairingRequest.tokenHash, tokenHash))
      .limit(1)
      .for('update');
    if (request?.credentialId) throw new AppError(409, 'KIOSK_ALREADY_PAIRED', 'This screen is already paired');
    if (request?.pairingCodeHash) {
      const now = new Date();
      await tx
        .update(displayPairingRequest)
        .set({ pairingCodeHash: null, expiresAt: now, updatedAt: now })
        .where(eq(displayPairingRequest.id, request.id));
      await audit.record(tx, {
        actorAccountId: null,
        operatorId: null,
        branchId: null,
        action: 'kiosk.pairing_expired',
        entityType: 'display_pairing_request',
        entityId: request.id,
        after: { kind: 'kiosk', expired: true },
        requestId: ctx.requestId,
      });
    }
    return { expired: true as const };
  });
}

/**
 * A MANAGER CLAIMS THE CODE ON THE KIOSK for one kiosk station. The code is
 * spent, the kiosk's credential written with its device scope, and who paired
 * it recorded — all in one transaction, under the station's row lock, so two
 * managers pairing the same kiosk at once make one credential.
 *
 * One live kiosk screen per kiosk station: a second is refused until the first
 * is revoked in Paired screens, as a display's is.
 */
export async function claimKiosk(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  target: typeof station.$inferSelect,
  input: { pairingCode: string; name: string },
): Promise<{ station: { id: string; name: string; kind: string }; device: { id: string; name: string } }> {
  await limitPrincipal(db, `kiosk-claim:${actor.accountId}`, 100, 600);
  const code = normaliseKioskPairingCode(input.pairingCode);
  if (!code) throw new AppError(409, 'KIOSK_PAIRING_INVALID', 'This pairing code has expired or already been used');
  return withTx(db, ctx, 'kiosk.paired', async (tx) => {
    const [current] = await tx
      .select()
      .from(station)
      .where(
        and(eq(station.id, target.id), eq(station.operatorId, actor.operatorId), eq(station.branchId, target.branchId)),
      )
      .limit(1)
      .for('update');
    if (!current || current.archivedAt) throw new AppError(404, 'STATION_NOT_FOUND', 'No such station');
    if (current.kind !== 'kiosk') {
      throw new AppError(409, 'KIOSK_STATION_INVALID', 'Pair a self-service kiosk to a kiosk station');
    }
    if (!current.boxId) throw new AppError(409, 'STATION_HAS_NO_BOX', 'Assign a box before pairing a kiosk');
    const [request] = await tx
      .select()
      .from(displayPairingRequest)
      .where(
        and(
          eq(displayPairingRequest.pairingCodeHash, sha256Hex(code)),
          isNull(displayPairingRequest.credentialId),
          gt(displayPairingRequest.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .for('update');
    if (!request) {
      throw new AppError(409, 'KIOSK_PAIRING_INVALID', 'This pairing code has expired or already been used');
    }
    const [active] = await tx
      .select({ id: deviceCredential.id })
      .from(deviceCredential)
      .where(
        and(
          eq(deviceCredential.stationId, current.id),
          eq(deviceCredential.kind, 'kiosk'),
          isNull(deviceCredential.revokedAt),
          isNotNull(deviceCredential.pairedAt),
          isNotNull(deviceCredential.secretHash),
        ),
      )
      .limit(1);
    if (active) {
      throw new AppError(
        409,
        'KIOSK_STATION_OCCUPIED',
        'Revoke the current kiosk screen before pairing another at this station',
      );
    }
    const id = newId();
    const claimedAt = new Date();
    await tx.insert(deviceCredential).values({
      id,
      operatorId: actor.operatorId,
      branchId: current.branchId,
      stationId: current.id,
      kind: 'kiosk',
      label: input.name,
      secretHash: request.tokenHash,
      // The kiosk's device scope from the moment it is paired: pos:kiosk:redeem, which no person holds.
      scopes: [...KIOSK_DEVICE_SCOPES],
      pairedAt: claimedAt,
      pairedByAccountId: actor.accountId,
    });
    await tx
      .update(displayPairingRequest)
      .set({ credentialId: id, claimedAt, pairingCodeHash: null, updatedAt: claimedAt })
      .where(eq(displayPairingRequest.id, request.id));
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: current.branchId,
      action: 'kiosk.paired',
      entityType: 'device_credential',
      entityId: id,
      after: { stationId: current.id, boxId: current.boxId, name: input.name },
      requestId: ctx.requestId,
    });
    return {
      station: { id: current.id, name: current.name, kind: current.kind },
      device: { id, name: input.name },
    };
  });
}
