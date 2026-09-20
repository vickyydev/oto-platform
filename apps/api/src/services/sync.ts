import { createHash, createPublicKey, verify as verifyDetached, type KeyObject } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  account,
  band,
  booking,
  box,
  boxOutbox,
  branch,
  branchHoliday,
  branchTaxConfig,
  child,
  device,
  member,
  product,
  productCategory,
  station,
  stationDevice,
  stationStaff,
  syncAnomaly,
  syncChange,
  syncCursor,
  syncEvent,
  syncQuarantine,
  taxOverride,
  ticketPackage,
  tier,
  visit,
  visitChild,
  type Db,
  type SyncAnomalyKind,
  type SyncChangeOp,
  type SyncChangeScope,
  type SyncClockTrust,
  type SyncQuarantineReason,
  type SyncQuarantineStatus,
} from '@oto/db';
import {
  SYNC_EVENT_SCHEMA_VERSION,
  SyncEventEnvelopeSchema,
  businessDate,
  canonicalSyncBytes,
  newId,
  normalizePhone,
  parseDayStart,
  type BusinessDateSource,
  type SyncEventEnvelope,
  type SyncEventOutcome,
  type SyncEventResult,
  type SyncPullResponse,
  type SyncPushResponse,
} from '@oto/shared';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { pgErrorOf } from '../lib/scrub';
import { audit } from './audit';
import { errorInfo, raiseAlert, recordRun, scrubDetail } from './ops';
import { withTx, type Exec, type OpContext, type Tx } from './tx';
import type { BoxAuth } from './box';

/**
 * The cloud half of the box sync core (S2-05).
 *
 * `services/box.ts` is how a box says it is alive and asks what it should be.
 * This file is how it hands over FACTS — a member created at a counter with no
 * internet, a visit confirmed, later a sale — and how it gets back the records
 * the cloud owns. It is the one place in the platform where a machine standing
 * in a shopping mall writes into the park's money and member records, so
 * everything below is written from four assumptions rather than from the happy
 * path:
 *
 *  1. **A batch WILL arrive twice.** Not rarely: a mall's link drops mid-request
 *     and the box, which never saw an answer, sends the same two hundred events
 *     again. That has to be cheap and it has to change nothing. The cost is one
 *     row read — `edge.sync_cursor` holds the high-water mark — and one integer
 *     comparison per event. The ledger's `UNIQUE (box_id, journal_epoch,
 *     box_seq)` is the backstop under it, and the backstop is the database's,
 *     not a check-then-write in this file.
 *  2. **The same id does not mean the same event.** Same id AND same
 *     `payload_hash` is a duplicate and is dropped without a word. Same id and a
 *     DIFFERENT hash is two different facts wearing one identity — a box that
 *     regenerated an event after a crash, a half-written payload — and it is
 *     quarantined rather than resolved by picking one, because picking one
 *     silently loses a sale.
 *  3. **A wiped store looks exactly like a live one.** "Reset store" mints epoch
 *     N+1 and restarts the box's sequence at 1, so without the epoch in the key
 *     every sequence number would be ambiguous and a replayed batch from the old
 *     journal would land on top of live rows. The epoch is the fence, and an
 *     epoch older than `core.box.current_epoch` is refused rather than applied.
 *  4. **One bad event must not cost the other 199.** Each event applies inside
 *     its own SAVEPOINT. A handler that throws rolls back its own work, the
 *     event goes to quarantine, and the batch carries on — which is what makes
 *     "event 3 of 5 is poison, 1, 2, 4 and 5 apply exactly once" true.
 *
 * **What the hash is for and what the signature is for, since they look alike.**
 * `payload_hash` is IDENTITY: is this re-sent event the same event? It protects
 * against accidental divergence and against nothing an attacker does, because
 * anyone who can rewrite the payload can recompute the hash. `sig` is
 * PROVENANCE: did this come from that box? It is Ed25519 over the same
 * canonical bytes, verified once, at push, against `core.box.sync_public_key`.
 * Both bytes come from `canonicalSyncBytes` in `@oto/shared`, which is the only
 * definition of them — `JSON.stringify` is not a contract, and two ends
 * disagreeing about key order would make every re-send look like a conflict.
 */

// --- Settings ---------------------------------------------------------------

/**
 * Read from the process for the same reason `boxSettings` is: these are
 * deployment decisions with working defaults, and `env.ts` is shared with the
 * deploy blueprint and the boot guard. They are named in `env.ts` so the
 * Integrations page can say whether a deployment set them.
 */
export interface SyncSettings {
  /** How long a ledger row is kept. The sale it created is never pruned. */
  eventRetentionDays: number;
  /** A box away longer than this takes a whole cache bundle, not a month of deltas. */
  changeRetentionDays: number;
  /** Station telemetry: the tape of one till's afternoon, a month later. */
  stationEventRetentionDays: number;
  /**
   * A box that is calling home but whose oldest unacked event is older than
   * this is not syncing, which is a different and quieter fault than a box that
   * has gone silent — and the one with money behind it.
   */
  staleAfterS: number;
}

function num(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function syncSettings(): SyncSettings {
  return {
    eventRetentionDays: num('SYNC_EVENT_RETENTION_DAYS', 365),
    changeRetentionDays: num('SYNC_CHANGE_RETENTION_DAYS', 30),
    stationEventRetentionDays: num('STATION_EVENT_RETENTION_DAYS', 30),
    staleAfterS: num('SYNC_STALE_AFTER_S', 300),
  };
}

/**
 * Past this, the box's own `clock_trust` is overruled and the trading day is
 * resolved from our clock. The same minute `evaluateBox` calls a drifted clock
 * on the Health page, so a box the page says is drifting is a box whose events
 * say they were re-dated.
 */
const CLOCK_TOLERANCE_MS = 60_000;

/**
 * The cache bundle's own version, distinct from the event envelope's.
 *
 * It belongs beside `SYNC_EVENT_SCHEMA_VERSION` in `@oto/shared`; it is here
 * because that package was being written by another hand while this was, and
 * moving it is a one-line change the next time it is open.
 */
export const CACHE_BUNDLE_SCHEMA_VERSION = 1;

/** Applies per scope, so one enormous scope cannot starve the others. */
const CACHE_DEFAULT_LIMIT = 1_000;
const CACHE_MAX_LIMIT = 5_000;

// --- Keys -------------------------------------------------------------------

/**
 * The box's public half, as it was registered.
 *
 * Two accepted shapes, because a Pi's agent and a test both have to produce one
 * without a conversion step: a PEM SPKI document, or base64 of the raw 32-byte
 * Ed25519 key. The raw form is wrapped in the fixed SPKI prefix rather than
 * parsed, because for Ed25519 that prefix is a constant.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function parseSyncPublicKey(value: string): KeyObject {
  const trimmed = value.trim();
  if (trimmed.startsWith('-----BEGIN')) return createPublicKey(trimmed);
  const raw = Buffer.from(trimmed, 'base64');
  if (raw.length !== 32) {
    throw new AppError(
      400,
      'SYNC_KEY_INVALID',
      'An Ed25519 public key is a PEM document or 32 raw bytes in base64',
    );
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

export const SyncKeyRegisterSchema = z.object({
  /** PEM SPKI, or base64 of the raw 32 bytes. */
  publicKey: z.string().min(40).max(2_000),
  algorithm: z.literal('ed25519').default('ed25519'),
});
export type SyncKeyRegisterInput = z.infer<typeof SyncKeyRegisterSchema>;

export interface SyncKeyRegisterResponse {
  /** The fingerprint, so a person can compare what the box holds with what we do. */
  keyFingerprint: string;
  algorithm: string;
  registeredAt: string;
  /** True when this replaced a different key rather than confirming the same one. */
  rotated: boolean;
}

/**
 * The one place a public key is read, normalised and fingerprinted.
 *
 * There are three doors a key can arrive through, and they exist for three
 * different situations rather than out of indecision:
 *
 *   - **registration**, which is the ordinary one — a box mints a keypair at
 *     first start and presents the public half with its claim code;
 *   - **the heartbeat**, because a box that registered before S2-05 has a spent
 *     claim code and no way back through `/register`, and this is the only
 *     channel it still has;
 *   - **`POST /box/v1/sync/key`**, the explicit one, which is what a rotation
 *     uses and what a person reaches for when something has gone wrong.
 *
 * All three normalise here, so there is exactly one definition of what a stored
 * key looks like and one fingerprint a person can compare across a screen.
 * Normalising through the crypto library rather than storing the bytes as sent
 * also means a key that cannot be parsed is refused NOW, by a caller who can
 * act on it, instead of quarantining every event the box sends from then on.
 */
export function normaliseSyncPublicKey(value: string): { pem: string; fingerprint: string } {
  const pem = parseSyncPublicKey(value).export({ format: 'pem', type: 'spki' }).toString();
  return { pem, fingerprint: sha256Hex(pem).slice(0, 16) };
}

/**
 * Record the public half of the keypair a box signs its events with.
 *
 * The box's bearer secret is what authenticates this call, so the secret is the
 * root of trust and the keypair hangs off it. That ordering matters: a box
 * whose secret has been revoked cannot register a key, and re-issuing a claim
 * code (which drops the secret) therefore cuts off both at once.
 *
 * **Rotation has a cost, stated here rather than discovered later.** Events
 * already queued on the box were signed with the previous key, and the cloud
 * keeps only one. A box that rotates with a full outbox will see those events
 * quarantined as `signature_invalid`. The virtual box rotates on every restart
 * by design — its key lives in memory, like its secret — and its outbox is
 * empty at that moment for the same reason. A Pi keeps both on disk and should
 * rotate only when it has caught up.
 */
export async function registerSyncKey(
  db: Db,
  auth: BoxAuth,
  input: SyncKeyRegisterInput,
  ctx: OpContext,
): Promise<SyncKeyRegisterResponse> {
  const { pem: normalised, fingerprint } = normaliseSyncPublicKey(input.publicKey);

  const [current] = await db
    .select({ existing: box.syncPublicKey })
    .from(box)
    .where(eq(box.id, auth.boxId))
    .limit(1);
  const rotated = Boolean(current?.existing) && current?.existing !== normalised;
  const registeredAt = new Date();

  await withTx(db, ctx, 'box.sync_key', async (tx) => {
    await tx
      .update(box)
      .set({
        syncPublicKey: normalised,
        syncKeyAlgorithm: input.algorithm,
        syncKeyRegisteredAt: registeredAt,
      })
      .where(eq(box.id, auth.boxId));
    await audit.record(tx, {
      // A machine presented its own key. Who put the machine there is on the
      // `box.register` row above it.
      actorAccountId: null,
      operatorId: auth.operatorId,
      branchId: auth.branchId,
      action: rotated ? 'box.sync_key_rotate' : 'box.sync_key_register',
      entityType: 'box',
      entityId: auth.boxId,
      // The public half is public, and the fingerprint is what a person reads
      // off a screen to compare two machines.
      after: { algorithm: input.algorithm, keyFingerprint: fingerprint, slot: auth.slot },
      requestId: ctx.requestId,
    });
  });

  return {
    keyFingerprint: fingerprint,
    algorithm: input.algorithm,
    registeredAt: registeredAt.toISOString(),
    rotated,
  };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// --- What a box may say, and what the cloud does with it ---------------------

/** The rows a handler wants that are the same for every event in a batch. */
interface BatchScope {
  auth: BoxAuth;
  timezone: string;
  dayStartMinutes: number;
  /** Stations of THIS box. An event naming any other station is refused. */
  stationIds: Set<string>;
}

interface PreparedEvent {
  envelope: SyncEventEnvelope;
  canonical: string;
  computedHash: string;
  clockTrust: SyncClockTrust;
  businessDate: string;
  businessDateSource: BusinessDateSource;
  receivedAt: Date;
  occurredAt: Date;
}

/**
 * Enough of an event to file it and to name it in the answer.
 *
 * A well-formed envelope supplies all of it. A malformed one supplies whatever
 * is still legible, which is why everything but the three columns
 * `edge.sync_quarantine` insists on is nullable: an envelope the cloud cannot
 * parse still has to land somewhere a person can find it, and it still has to
 * be acknowledged by id and sequence or the box will send it again for ever.
 */
interface EventAddress {
  eventId: string;
  journalEpoch: number;
  boxSeq: number;
  type: string | null;
  schemaVersion: number | null;
  occurredAt: Date | null;
  payloadHash: string | null;
  sig: string | null;
  actionId: string | null;
  /** The value exactly as it arrived, so "replay" means replay, not reconstruct. */
  raw: unknown;
  /**
   * False when the id or the sequence had to be invented. Such an event cannot
   * be acknowledged individually — there is nothing to acknowledge it BY — so
   * it is filed and counted but never moves the high-water mark.
   */
  addressable: boolean;
}

/** What an applied handler wants recorded beside the ledger row. */
interface ApplyResult {
  entityType: string;
  entityId: string;
  anomalies?: Array<{
    kind: SyncAnomalyKind;
    relatedEventId?: string | null;
    detail?: Record<string, unknown>;
  }>;
  changes?: ChangeInput[];
}

interface EventHandler {
  /** What a payload of this type must look like before anything is written. */
  schema: z.ZodTypeAny;
  apply(tx: Tx, scope: BatchScope, event: PreparedEvent, payload: never): Promise<ApplyResult>;
}

/**
 * A refusal that carries the quarantine reason with it, so the classification
 * happens where the knowledge is rather than being inferred from a message.
 */
class RefuseEvent extends Error {
  constructor(
    readonly reason: SyncQuarantineReason,
    readonly errorCode: string,
    message: string,
    readonly existingPayloadHash?: string | null,
  ) {
    super(message);
    this.name = 'RefuseEvent';
  }
}

// --- The Sprint 1 cargo, as box-originated facts -----------------------------
//
// The ticket rewrites member and visit creation as events on purpose: the
// ledger is proved with cargo whose rules are already settled and already
// tested, before the first sale goes near it.
//
// Every handler below follows the same three rules:
//   - the tenancy comes from the CREDENTIAL, never from the payload. A box
//     writes into its own operator and its own branch or it writes nothing;
//   - the audit row carries `source_event_id` and `action_id`, so one action id
//     ties the till line, the box log and this row together (the ticket's last
//     acceptance criterion);
//   - what the cloud now owns is published to `sync_change`, so the OTHER box
//     at the branch learns about it without anybody thinking to tell it.

const MemberCreatedSchema = z.object({
  memberId: z.string().uuid(),
  phone: z.string().min(4).max(32),
  nickname: z.string().min(1).max(120),
  name: z.string().max(200).nullish(),
  preferredChannel: z.enum(['whatsapp', 'telegram', 'line']).nullish(),
  createdVia: z.enum(['pos', 'booking', 'import']).default('pos'),
});

const MemberUpdatedSchema = z.object({
  memberId: z.string().uuid(),
  nickname: z.string().min(1).max(120).optional(),
  name: z.string().max(200).nullish(),
  email: z.string().email().max(200).nullish(),
  notes: z.string().max(2_000).nullish(),
  preferredChannel: z.enum(['whatsapp', 'telegram', 'line']).nullish(),
});

const ChildFields = {
  name: z.string().min(1).max(120),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  ageYears: z.number().int().min(0).max(17).nullish(),
  allergies: z.string().max(1_000).nullish(),
  medicalNotes: z.string().max(1_000).nullish(),
  medicalAlert: z.boolean().optional(),
  dietary: z.string().max(1_000).nullish(),
  foodRestrictions: z.string().max(1_000).nullish(),
  notes: z.string().max(1_000).nullish(),
};

const ChildCreatedSchema = z.object({
  childId: z.string().uuid(),
  memberId: z.string().uuid(),
  ...ChildFields,
});

const ChildUpdatedSchema = z.object({
  childId: z.string().uuid(),
  ...ChildFields,
  name: ChildFields.name.optional(),
});

/**
 * A takeover, as the box queues it. Every field is what the audit row shows:
 * which lease was displaced, whose it was, and which one replaced it.
 */
const StationTakeoverSchema = z.object({
  displacedLeaseId: z.string().uuid(),
  displacedHolderKind: z.string().max(32).nullish(),
  displacedAccountId: z.string().uuid().nullish(),
  newLeaseId: z.string().uuid(),
  newHolderKind: z.string().max(32).nullish(),
  newAccountId: z.string().uuid().nullish(),
  takeoverCount: z.number().int().min(0).optional(),
});

const VisitCreatedSchema = z.object({
  visitId: z.string().uuid(),
  memberId: z.string().uuid().nullish(),
  visitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  childIds: z.array(z.string().uuid()).max(20).default([]),
  status: z.enum(['draft', 'active', 'closed']).default('draft'),
});

/** The member row a box's cache needs, and nothing a box has no use for. */
function memberChange(row: typeof member.$inferSelect, extra?: Record<string, unknown>): unknown {
  return {
    id: row.id,
    phone: row.phone,
    nickname: row.nickname,
    name: row.name,
    tierCode: row.tierCode,
    preferredChannel: row.preferredChannel,
    ...extra,
  };
}

function childChange(row: typeof child.$inferSelect): unknown {
  return {
    id: row.id,
    memberId: row.memberId,
    name: row.name,
    dateOfBirth: row.dateOfBirth,
    ageYears: row.ageYears,
    allergies: row.allergies,
    medicalNotes: row.medicalNotes,
    medicalAlert: row.medicalAlert,
    dietary: row.dietary,
    foodRestrictions: row.foodRestrictions,
  };
}

const HANDLERS: Record<string, EventHandler> = {
  /**
   * A member created at a counter, possibly with no internet.
   *
   * **The merge is the interesting half.** A family arrives, gives the same
   * phone number at Reception Till 1 and at Counter 2, and both boxes are
   * offline — so each mints its own member with its own id, and both are right.
   * At sync the operator's unique phone is what decides: the first to arrive
   * survives, the second is recorded as a merge naming BOTH event ids, and the
   * surviving member is published to the change feed carrying
   * `mergedFromMemberId` so the second box can repoint the sale it is holding.
   *
   * The alternative — refusing the second — would throw away a fact somebody
   * typed, and picking by timestamp would make the answer depend on two clocks
   * agreeing, which is the thing this whole file assumes they do not.
   */
  'member.created': {
    schema: MemberCreatedSchema,
    async apply(tx, scope, event, payload: z.infer<typeof MemberCreatedSchema>) {
      const phone = normalizePhone(payload.phone);
      if (!phone) {
        throw new RefuseEvent('poison', 'SYNC_PHONE_INVALID', 'The phone number is not usable');
      }
      const operatorId = scope.auth.operatorId;

      const [byId] = await tx
        .select()
        .from(member)
        .where(and(eq(member.id, payload.memberId), eq(member.operatorId, operatorId)))
        .limit(1);
      if (byId) {
        // Already here — created through the HTTP route with the same
        // client-minted id, or applied before the ledger was swept. Nothing to
        // do, and emphatically not a conflict.
        return { entityType: 'member', entityId: byId.id };
      }

      const [byPhone] = await tx
        .select()
        .from(member)
        .where(and(eq(member.operatorId, operatorId), eq(member.phone, phone)))
        .limit(1);

      if (byPhone) {
        // Which event created the survivor. The audit row is the index into
        // that, and it outlives the ledger row it points at.
        const [origin] = await tx
          .select({ sourceEventId: sql<string | null>`source_event_id` })
          .from(sql`core.audit_log`)
          .where(sql`entity_type = 'member' and entity_id = ${byPhone.id} and action = 'member.create'`)
          .orderBy(sql`created_at asc`)
          .limit(1);

        await audit.record(tx, {
          actorAccountId: event.envelope.actorAccountId ?? null,
          operatorId,
          branchId: scope.auth.branchId,
          action: 'member.merge',
          entityType: 'member',
          entityId: byPhone.id,
          before: { memberId: payload.memberId },
          after: { mergedIntoMemberId: byPhone.id, boxId: scope.auth.boxId },
          requestId: null,
          actionId: event.envelope.actionId ?? null,
          sourceEventId: event.envelope.eventId,
        });

        return {
          entityType: 'member',
          entityId: byPhone.id,
          anomalies: [
            {
              kind: 'merge',
              relatedEventId: origin?.sourceEventId ?? null,
              detail: {
                survivingMemberId: byPhone.id,
                discardedMemberId: payload.memberId,
                boxId: scope.auth.boxId,
              },
            },
          ],
          changes: [
            {
              scope: 'members',
              entityType: 'member',
              entityId: byPhone.id,
              payload: memberChange(byPhone, { mergedFromMemberId: payload.memberId }),
            },
          ],
        };
      }

      const [created] = await tx
        .insert(member)
        .values({
          id: payload.memberId,
          operatorId,
          phone,
          nickname: payload.nickname.trim(),
          name: payload.name ?? null,
          preferredChannel: payload.preferredChannel ?? null,
          createdVia: payload.createdVia,
        })
        .returning();

      await audit.record(tx, {
        actorAccountId: event.envelope.actorAccountId ?? null,
        operatorId,
        branchId: scope.auth.branchId,
        action: 'member.create',
        entityType: 'member',
        entityId: created!.id,
        after: { nickname: created!.nickname, createdVia: created!.createdVia },
        requestId: null,
        actionId: event.envelope.actionId ?? null,
        sourceEventId: event.envelope.eventId,
      });

      return {
        entityType: 'member',
        entityId: created!.id,
        changes: [
          {
            scope: 'members',
            entityType: 'member',
            entityId: created!.id,
            payload: memberChange(created!),
          },
        ],
      };
    },
  },

  'member.updated': {
    schema: MemberUpdatedSchema,
    async apply(tx, scope, event, payload: z.infer<typeof MemberUpdatedSchema>) {
      const [before] = await tx
        .select()
        .from(member)
        .where(
          and(eq(member.id, payload.memberId), eq(member.operatorId, scope.auth.operatorId)),
        )
        .limit(1);
      if (!before) {
        // The box is ahead of us: it edited a member whose creation has not
        // arrived. Quarantined rather than dropped, because the create is
        // probably in the next batch and a person can replay this afterwards.
        throw new RefuseEvent('apply_failed', 'SYNC_MEMBER_ABSENT', 'No such member here yet');
      }
      const patch: Partial<typeof member.$inferInsert> = {};
      if (payload.nickname !== undefined) patch.nickname = payload.nickname.trim();
      if (payload.name !== undefined) patch.name = payload.name ?? null;
      if (payload.email !== undefined) patch.email = payload.email ?? null;
      if (payload.notes !== undefined) patch.notes = payload.notes ?? null;
      if (payload.preferredChannel !== undefined) {
        patch.preferredChannel = payload.preferredChannel ?? null;
      }
      const [after] = await tx
        .update(member)
        .set(patch)
        .where(eq(member.id, payload.memberId))
        .returning();

      await audit.record(tx, {
        actorAccountId: event.envelope.actorAccountId ?? null,
        operatorId: scope.auth.operatorId,
        branchId: scope.auth.branchId,
        action: 'member.update',
        entityType: 'member',
        entityId: payload.memberId,
        before,
        after,
        requestId: null,
        actionId: event.envelope.actionId ?? null,
        sourceEventId: event.envelope.eventId,
      });

      return {
        entityType: 'member',
        entityId: payload.memberId,
        changes: [
          {
            scope: 'members',
            entityType: 'member',
            entityId: payload.memberId,
            payload: memberChange(after!),
          },
        ],
      };
    },
  },

  'child.created': {
    schema: ChildCreatedSchema,
    async apply(tx, scope, event, payload: z.infer<typeof ChildCreatedSchema>) {
      // The guardian proves the tenancy: a child is only reachable through a
      // member of this box's own operator, exactly as on the HTTP route.
      const [guardian] = await tx
        .select({ id: member.id })
        .from(member)
        .where(
          and(eq(member.id, payload.memberId), eq(member.operatorId, scope.auth.operatorId)),
        )
        .limit(1);
      if (!guardian) {
        throw new RefuseEvent('apply_failed', 'SYNC_MEMBER_ABSENT', 'No such member here yet');
      }
      const [existing] = await tx
        .select()
        .from(child)
        .where(eq(child.id, payload.childId))
        .limit(1);
      if (existing) return { entityType: 'child', entityId: existing.id };

      const [created] = await tx
        .insert(child)
        .values({
          id: payload.childId,
          memberId: payload.memberId,
          name: payload.name.trim(),
          dateOfBirth: payload.dateOfBirth ?? null,
          ageYears: payload.ageYears ?? null,
          allergies: payload.allergies ?? null,
          medicalNotes: payload.medicalNotes ?? null,
          medicalAlert: payload.medicalAlert ?? Boolean(payload.allergies),
          dietary: payload.dietary ?? null,
          foodRestrictions: payload.foodRestrictions ?? null,
          notes: payload.notes ?? null,
          consentRecordedAt: event.occurredAt,
        })
        .returning();

      await audit.record(tx, {
        actorAccountId: event.envelope.actorAccountId ?? null,
        operatorId: scope.auth.operatorId,
        branchId: scope.auth.branchId,
        action: 'child.create',
        entityType: 'child',
        entityId: created!.id,
        // Not the allergy text: an audit row is read on a Console page, and
        // what changed is enough to answer "who added this child and when".
        after: { memberId: payload.memberId, medicalAlert: created!.medicalAlert },
        requestId: null,
        actionId: event.envelope.actionId ?? null,
        sourceEventId: event.envelope.eventId,
      });

      return {
        entityType: 'child',
        entityId: created!.id,
        changes: [
          {
            scope: 'members',
            entityType: 'child',
            entityId: created!.id,
            payload: childChange(created!),
          },
        ],
      };
    },
  },

  'child.updated': {
    schema: ChildUpdatedSchema,
    async apply(tx, scope, event, payload: z.infer<typeof ChildUpdatedSchema>) {
      const [before] = await tx.select().from(child).where(eq(child.id, payload.childId)).limit(1);
      if (!before) {
        throw new RefuseEvent('apply_failed', 'SYNC_CHILD_ABSENT', 'No such child here yet');
      }
      const [guardian] = await tx
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.id, before.memberId), eq(member.operatorId, scope.auth.operatorId)))
        .limit(1);
      if (!guardian) {
        throw new RefuseEvent('poison', 'SYNC_CHILD_NOT_OURS', 'That child belongs elsewhere');
      }

      const patch: Partial<typeof child.$inferInsert> = {};
      if (payload.name !== undefined) patch.name = payload.name.trim();
      if (payload.dateOfBirth !== undefined) patch.dateOfBirth = payload.dateOfBirth ?? null;
      if (payload.ageYears !== undefined) patch.ageYears = payload.ageYears ?? null;
      if (payload.allergies !== undefined) {
        patch.allergies = payload.allergies ?? null;
        patch.medicalAlert = payload.medicalAlert ?? Boolean(payload.allergies);
      }
      if (payload.medicalNotes !== undefined) patch.medicalNotes = payload.medicalNotes ?? null;
      if (payload.medicalAlert !== undefined) patch.medicalAlert = payload.medicalAlert;
      if (payload.dietary !== undefined) patch.dietary = payload.dietary ?? null;
      if (payload.foodRestrictions !== undefined) {
        patch.foodRestrictions = payload.foodRestrictions ?? null;
      }
      if (payload.notes !== undefined) patch.notes = payload.notes ?? null;
      patch.lastConfirmedAt = event.occurredAt;

      const [after] = await tx
        .update(child)
        .set(patch)
        .where(eq(child.id, payload.childId))
        .returning();

      await audit.record(tx, {
        actorAccountId: event.envelope.actorAccountId ?? null,
        operatorId: scope.auth.operatorId,
        branchId: scope.auth.branchId,
        action: 'child.update',
        entityType: 'child',
        entityId: payload.childId,
        before,
        after,
        requestId: null,
        actionId: event.envelope.actionId ?? null,
        sourceEventId: event.envelope.eventId,
      });

      return {
        entityType: 'child',
        entityId: payload.childId,
        changes: [
          {
            scope: 'members',
            entityType: 'child',
            entityId: payload.childId,
            payload: childChange(after!),
          },
        ],
      };
    },
  },

  'visit.created': {
    schema: VisitCreatedSchema,
    async apply(tx, scope, event, payload: z.infer<typeof VisitCreatedSchema>) {
      const [existing] = await tx.select().from(visit).where(eq(visit.id, payload.visitId)).limit(1);
      if (existing) return { entityType: 'visit', entityId: existing.id };

      if (payload.memberId) {
        const [guardian] = await tx
          .select({ id: member.id })
          .from(member)
          .where(
            and(eq(member.id, payload.memberId), eq(member.operatorId, scope.auth.operatorId)),
          )
          .limit(1);
        if (!guardian) {
          throw new RefuseEvent('apply_failed', 'SYNC_MEMBER_ABSENT', 'No such member here yet');
        }
      }

      await tx.insert(visit).values({
        id: payload.visitId,
        operatorId: scope.auth.operatorId,
        // From the credential. A box cannot record a visit at another branch.
        branchId: scope.auth.branchId,
        memberId: payload.memberId ?? null,
        visitDate: payload.visitDate,
        status: payload.status,
        createdByAccountId: event.envelope.actorAccountId ?? null,
      });
      for (const childId of payload.childIds) {
        await tx
          .insert(visitChild)
          .values({ visitId: payload.visitId, childId, confirmedAt: event.occurredAt })
          .onConflictDoNothing();
      }

      await audit.record(tx, {
        actorAccountId: event.envelope.actorAccountId ?? null,
        operatorId: scope.auth.operatorId,
        branchId: scope.auth.branchId,
        action: 'visit.create',
        entityType: 'visit',
        entityId: payload.visitId,
        after: { memberId: payload.memberId ?? null, children: payload.childIds.length },
        requestId: null,
        actionId: event.envelope.actionId ?? null,
        sourceEventId: event.envelope.eventId,
      });

      return { entityType: 'visit', entityId: payload.visitId };
    },
  },

  /**
   * A manager took a live station away from the till that was holding it.
   *
   * Not a business record like the four above — nothing about the park changes
   * — but the ticket asks for it by name, and for a good reason: displacing a
   * colleague mid-sale is precisely the thing somebody asks about a week
   * later, and the answer has to survive the box having been offline when it
   * happened. That is why it travels as a fact rather than being written where
   * the button was pressed: the box that took the station may not have had the
   * internet at the time, and an audit trail with holes in it on exactly the
   * days the link was bad is worth very little.
   *
   * The station is checked against the credential's own stations by
   * `prepareEvent`, so a box cannot report a takeover at somebody else's
   * counter.
   */
  'station.takeover': {
    schema: StationTakeoverSchema,
    async apply(tx, scope, event, payload: z.infer<typeof StationTakeoverSchema>) {
      const stationId = event.envelope.stationId;
      if (!stationId) {
        throw new RefuseEvent('poison', 'SYNC_STATION_MISSING', 'A takeover names no station');
      }
      // Who did it. The box refuses to mint one of these without an account,
      // and the cloud refuses to file one that arrives without a name anyway:
      // an audit row reading "somebody took the till" answers nothing.
      const actorAccountId = event.envelope.actorAccountId ?? null;
      if (!actorAccountId) {
        throw new RefuseEvent(
          'actor_unknown',
          'SYNC_TAKEOVER_ANONYMOUS',
          'A takeover has to name the account that took the station',
        );
      }
      await recordStationTakeover(tx, {
        operatorId: scope.auth.operatorId,
        branchId: scope.auth.branchId,
        stationId,
        actorAccountId,
        payload,
        requestId: null,
        actionId: event.envelope.actionId ?? null,
        sourceEventId: event.envelope.eventId,
      });
      return { entityType: 'station', entityId: stationId };
    },
  },
};

/**
 * What a takeover records, wherever it was decided.
 *
 * Shared by the handler above and by the station-session service, which writes
 * it directly when the claim was made against an api instance that is not
 * hosting that box's agent — there is no ledger to travel through in that
 * case, because the fact has already arrived where it was going. One function
 * so the two cannot produce two different-looking rows for one event.
 */
export async function recordStationTakeover(
  exec: Exec,
  input: {
    operatorId: string;
    branchId: string | null;
    stationId: string;
    actorAccountId: string;
    payload: z.infer<typeof StationTakeoverSchema>;
    requestId: string | null;
    actionId: string | null;
    sourceEventId?: string | null;
  },
): Promise<void> {
  await audit.record(exec, {
    actorAccountId: input.actorAccountId,
    operatorId: input.operatorId,
    branchId: input.branchId,
    action: 'station.takeover',
    entityType: 'station',
    entityId: input.stationId,
    // The lease that was displaced and who was standing behind it, because
    // "who lost the sale" is half of the question this row is read for.
    before: {
      leaseId: input.payload.displacedLeaseId,
      holderKind: input.payload.displacedHolderKind ?? null,
      accountId: input.payload.displacedAccountId ?? null,
    },
    after: {
      leaseId: input.payload.newLeaseId,
      holderKind: input.payload.newHolderKind ?? null,
      accountId: input.payload.newAccountId ?? null,
      takeoverCount: input.payload.takeoverCount ?? null,
    },
    requestId: input.requestId,
    actionId: input.actionId,
    sourceEventId: input.sourceEventId ?? null,
  });
}

/** What the cloud knows how to apply today, for the OpenAPI description. */
export const SYNC_EVENT_TYPES = Object.keys(HANDLERS).sort();

// --- The change feed --------------------------------------------------------

export interface ChangeInput {
  scope: SyncChangeScope;
  entityType: string;
  entityId: string;
  op?: SyncChangeOp;
  payload?: unknown;
  version?: number | null;
  /** Null (the default) means every box at the branch. */
  boxId?: string | null;
  /** Null means operator-wide — a system role, a signing key. */
  branchId?: string | null;
}

/**
 * Publish one cloud-owned record to the boxes that hold a copy of it.
 *
 * Called inside the transaction that made the change, so a member that exists
 * and a delta that says so commit together. A delta written afterwards, on the
 * pool, would be a second thing to go wrong — and the box would find out about
 * a member it can already be asked for.
 *
 * Deletes carry no payload, which the database also enforces: a delta that says
 * "forget this" has nothing to say about what it looked like.
 */
export async function recordChange(
  exec: Exec,
  scope: { operatorId: string; branchId?: string | null },
  change: ChangeInput,
): Promise<void> {
  const op = change.op ?? 'upsert';
  await exec.insert(syncChange).values({
    operatorId: scope.operatorId,
    branchId: change.branchId === undefined ? (scope.branchId ?? null) : change.branchId,
    boxId: change.boxId ?? null,
    scope: change.scope,
    op,
    entityType: change.entityType,
    entityId: change.entityId,
    version: change.version ?? null,
    payload: (op === 'delete' ? null : (scrubForBox(change.payload) ?? null)) as never,
  });
}

/**
 * A change payload reaches a machine in a mall, so it is trimmed to what that
 * machine needs — which the handlers above already do field by field. This is
 * the guard against a handler that grows a field nobody looked at: anything
 * that is not a plain object is refused rather than published.
 */
function scrubForBox(payload: unknown): unknown {
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError(500, 'SYNC_CHANGE_PAYLOAD', 'A change payload must be an object');
  }
  return payload;
}

// --- Push -------------------------------------------------------------------

export interface PushInput {
  /**
   * `unknown`, not `SyncEventEnvelope[]`, and the type is the contract: the
   * route validates the BATCH and this function validates each event, so that
   * one malformed envelope is a quarantined event rather than a 400 that
   * refuses the other hundred and ninety-nine every time they are re-sent.
   */
  events: unknown[];
  cursorSeq?: number;
}

export interface PushOptions {
  /**
   * Where this batch came from, which changes two things and nothing else.
   *
   *   `box`               an ordinary push. Every rule applies.
   *   `replay`            the box's own batch re-sent from the ledger — its
   *                       bytes, its hashes, its signatures — so every rule
   *                       applies here too, and the expected answer is
   *                       `applied=0 duplicates=N`.
   *   `quarantine_replay` one event a PERSON chose to put back. The cursor
   *                       shortcut is skipped for it: the cursor moved past
   *                       this event when it was filed, so treating it as a
   *                       replay would drop the very thing somebody just asked
   *                       to apply. The ledger's own keys still decide whether
   *                       it is genuinely a duplicate.
   *   `injected`          the staging test control minting a deliberately bad
   *                       event. There is no box private key in this process,
   *                       so the signature step is skipped and the quarantine
   *                       row says the event was injected.
   *   `injected_replay`   somebody pressing Replay on one of those. It is both
   *                       of the two above at once — unsigned, because it never
   *                       was a fact a box sealed, and deliberate, because a
   *                       person asked for it — and neither alone describes it.
   *
   * Three questions are asked of this value and nothing else is: may the
   * signature step be skipped, is this news about where the box has got to, and
   * does the quarantine row say the event was injected. They are named below as
   * `unsigned` and `fromQuarantine` so each rule reads as the question it is
   * answering rather than as a list of sources.
   */
  source?: 'box' | 'replay' | 'quarantine_replay' | 'injected' | 'injected_replay';
  /** The account that pressed a test control, for the `ops_run`. */
  actorAccountId?: string | null;
}

/**
 * Apply a batch of facts from one box.
 *
 * The shape of the whole function is: take the cursor row's lock, walk the
 * events in journal order applying each under its own SAVEPOINT, move the
 * cursor, commit — and only then record the run and raise whatever the batch
 * turned up. Alerts and the `ops_run` are deliberately outside the transaction:
 * the record of what happened must outlive a rollback, which is the same rule
 * `services/tx.ts` states for the failure audit row.
 */
export async function pushEvents(
  db: Db,
  auth: BoxAuth,
  input: PushInput,
  ctx: OpContext,
  opts: PushOptions = {},
): Promise<SyncPushResponse> {
  const source = opts.source ?? 'box';
  /** A seal the cloud minted itself and therefore cannot verify. */
  const unsigned = source === 'injected' || source === 'injected_replay';
  /** One filed event a person put back, rather than news from the box. */
  const fromQuarantine = source === 'quarantine_replay' || source === 'injected_replay';
  const startedAt = new Date();
  const batchId = newId();

  const [boxRow] = await db
    .select({
      syncPublicKey: box.syncPublicKey,
      syncKeyAlgorithm: box.syncKeyAlgorithm,
      currentEpoch: box.currentEpoch,
    })
    .from(box)
    .where(eq(box.id, auth.boxId))
    .limit(1);
  if (!boxRow) throw new AppError(404, 'BOX_NOT_FOUND', 'No such box');

  /**
   * No key, no batch — and nothing is quarantined for it.
   *
   * Refusing the whole push rather than filing two hundred events as
   * `signature_invalid` is the difference between a recoverable state and a
   * pile of rows somebody has to replay by hand: there is nothing wrong with
   * the events, only with what the cloud is holding about the box. The box
   * registers its key and sends the same batch again, which costs nothing
   * because the cursor makes a replay cheap.
   */
  let publicKey: KeyObject | null = null;
  if (!unsigned) {
    if (!boxRow.syncPublicKey) {
      throw new AppError(
        409,
        'SYNC_KEY_UNKNOWN',
        'This box has not registered a signing key — POST /box/v1/sync/key first',
      );
    }
    publicKey = parseSyncPublicKey(boxRow.syncPublicKey);
  }

  const [branchRow] = await db
    .select({ timezone: branch.timezone, businessDayStart: branch.businessDayStart })
    .from(branch)
    .where(eq(branch.id, auth.branchId))
    .limit(1);
  if (!branchRow) {
    throw new AppError(404, 'BRANCH_NOT_FOUND', 'This box is not attached to a branch');
  }

  const stations = await db
    .select({ id: station.id })
    .from(station)
    .where(eq(station.boxId, auth.boxId));
  const scope: BatchScope = {
    auth,
    timezone: branchRow.timezone,
    dayStartMinutes: parseDayStart(branchRow.businessDayStart),
    stationIds: new Set(stations.map((s) => s.id)),
  };

  const epoch = boxRow.currentEpoch;
  const results: SyncEventOutcome[] = [];
  const anomalies: Array<{
    kind: SyncAnomalyKind;
    eventId: string | null;
    relatedEventId?: string | null;
    actionId?: string | null;
    detail?: Record<string, unknown>;
  }> = [];
  const quarantined: Array<{ reason: SyncQuarantineReason; eventId: string }> = [];
  /**
   * Sequences counted as duplicates on the cursor's word alone, with no row
   * anywhere to back it up. Never silent: see where it is filled, and the alert
   * it raises after the transaction.
   */
  const droppedWithoutRecord: number[] = [];
  /** Positions the cloud can claim but the mark could not walk to, for the run record. */
  const markHeldFor: number[] = [];
  let applied = 0;
  let duplicates = 0;
  let cursorSeq = 0;
  /**
   * The first action id the batch carries, for the `ops_run`. Read from the
   * parsed events rather than from `input.events[0]`, which is now `unknown`
   * and may not be an envelope at all.
   */
  let batchActionId: string | null = null;
  /**
   * Nothing is `rejected` today, and that is the design rather than an
   * omission: an event the cloud will not apply is FILED — whole, replayable,
   * with a reason — so every refusal is `quarantined`. The count stays in the
   * answer because the shared contract has it and because a later rule might
   * genuinely drop an event on the floor; the day one does, this stops being a
   * constant and somebody has to say why.
   */
  const rejected = 0;

  await db.transaction(async (tx) => {
    /**
     * One row per (box, epoch), taken FOR UPDATE.
     *
     * This is what serialises two pushes from the same box — the ordinary
     * retry racing the original — so the high-water mark cannot be read by
     * both and written by both. Everything downstream can then reason about
     * one batch at a time.
     */
    await tx
      .insert(syncCursor)
      .values({ id: newId(), boxId: auth.boxId, journalEpoch: epoch })
      .onConflictDoNothing({ target: [syncCursor.boxId, syncCursor.journalEpoch] });
    const [cursorRow] = await tx
      .select()
      .from(syncCursor)
      .where(and(eq(syncCursor.boxId, auth.boxId), eq(syncCursor.journalEpoch, epoch)))
      .for('update')
      .limit(1);
    /**
     * The mark as it stands. It does NOT move while the batch is walked — see
     * `accountFor` — so every event in this batch is judged against the same
     * frontier, whatever order they arrive in.
     */
    const startMark = cursorRow?.lastBoxSeq ?? 0;
    let lastEventId = cursorRow?.lastEventId ?? null;

    /**
     * What the cloud already holds ABOVE the mark, read before the batch runs.
     *
     * **The ledger is the authority on what the box has delivered; the cursor is
     * a cache of a question the ledger can always answer.** The mark used to be
     * computed from this batch alone, and that is what froze it: a batch that
     * could not step over a hole left the mark behind, and every batch after it
     * — dealing only with its own positions — had no way to notice that the
     * hole had since been filled. `[@1, truncated, @3, @4, @5]` left the mark on
     * 1; the re-send of @2 moved it to 2; and @6, @7 and everything after moved
     * it nowhere, with 1..7 all sitting in the ledger.
     *
     * Deriving it from what the ledger holds is self-healing by construction:
     * fill the hole and the next push walks the whole run in one step, because
     * the run is what the query returns.
     *
     * What it still costs is a mark that stalls while a hole is genuinely open —
     * a box that has lost journal positions, which is what "Reset store" is for.
     * Its events still apply and are still acknowledged one by one in `results`,
     * so nothing is lost and the queue still drains. That draining is exactly
     * why the oldest-unacked watchdog cannot see this: `sync.stale` reads an age
     * computed from queued and sending rows, and an emptying queue has none. The
     * rule that does see it is `sync.cursor_stalled` in `evaluateBox`, which
     * compares this mark with the ledger's own high-water mark for the box's
     * current epoch, and closes itself when the hole is filled or the store is
     * reset.
     */
    const held = await loadHeldPositions(tx, auth, epoch, startMark);
    /**
     * Positions the mark may CLAIM. Seeded from the ledger and from the filed
     * events whose position the box has genuinely finished with, then added to
     * by this batch through `accountFor`.
     */
    const sealed = held.sealed;
    /**
     * Positions the cloud holds ANYTHING for, claimable or not — an injected
     * event, a row whose identity had to be invented. A gap is measured against
     * this rather than against `sealed`, because "the box skipped a position" is
     * a claim about facts that never arrived, and one that did arrive and was
     * refused is not one of those.
     */
    const known = held.known;
    /** The highest position the cloud held BEFORE this batch. See the gap below. */
    const headBefore = held.head;

    /**
     * Account for a position, or decline to.
     *
     * A refused event DOES account for its position: being refused is a way of
     * being dealt with — it is filed whole in a table a person works through —
     * and a box whose answer was lost in flight needs the cursor to retire it
     * rather than send it for ever.
     *
     * Three kinds are `known` without being `sealed`, each for its own reason.
     * An event whose identity had to be invented was never acknowledged under an
     * id the box holds, so the box will send that position again and the mark
     * must leave it alone. An INJECTED event was minted in the cloud by a test
     * control and the box will itself mint that very sequence next. And anything
     * FROM QUARANTINE is one filed event a person put back: its position was
     * dealt with when it was filed — or deliberately was not, for an injected
     * one — so re-pushing it says nothing new about where the box has got to.
     * That last one is what made "Inject poison event" followed by "Replay"
     * swallow the box's next real fact: the injection carefully left the mark
     * alone and the replay moved it to the very sequence the box was about to
     * use.
     *
     * The first two are exclusions `loadHeldPositions` applies again to the rows
     * it reads back, so a position filed by an earlier batch is treated the same
     * way it was when it was filed. The third is a property of this push rather
     * than of any row, so it has nothing to apply.
     */
    const accountFor = (boxSeq: number, addressable: boolean): void => {
      if (boxSeq > 0) known.add(boxSeq);
      if (!addressable || source === 'injected' || fromQuarantine) return;
      sealed.add(boxSeq);
    };

    /**
     * The frontier as this batch walks it, which is a different question from
     * the mark: it is what a gap is measured against, and a gap is about the
     * order the box sent things in rather than about what may be claimed. It
     * steps over everything the cloud already holds, so a batch that starts
     * above a filed position is not reporting that position missing.
     */
    let walked = startMark;
    const absorbKnown = (): void => {
      while (known.has(walked + 1)) walked += 1;
    };
    absorbKnown();
    /**
     * Positions this batch stepped past that the cloud holds nothing for, as far
     * as it looked. Collected here and filed as one anomaly at the end.
     */
    const missing = new Set<number>();
    let gapWitness: { eventId: string; actionId: string | null; boxSeq: number } | null = null;

    for (const raw of input.events) {
      /**
       * Parsed HERE, one at a time, rather than by the route's schema. See
       * `SyncPushRequestSchema`: a zod array fails whole, and a batch that
       * fails whole is a batch that can never be re-sent successfully.
       */
      const envelopeParse = SyncEventEnvelopeSchema.safeParse(raw);
      const address = envelopeParse.success
        ? addressOf(envelopeParse.data)
        : salvageAddress(raw, epoch);
      batchActionId ??= address.actionId;
      const outcome: SyncEventOutcome = {
        eventId: address.eventId,
        boxSeq: address.boxSeq,
        result: 'applied',
      };
      // Read before the checks below use it, so a gap is measured against what
      // this batch had reached rather than against what it reaches later.
      const walkedBefore = walked;
      if (address.addressable) {
        walked = Math.max(walked, address.boxSeq);
        absorbKnown();
      }

      // --- The epoch, first, because it decides whether the rest means anything.
      if (address.journalEpoch !== epoch) {
        const ahead = address.journalEpoch > epoch;
        outcome.result = 'quarantined';
        outcome.reason = 'epoch_regressed';
        outcome.errorCode = ahead ? 'SYNC_EPOCH_AHEAD' : 'SYNC_EPOCH_REGRESSED';
        await fileQuarantine(tx, auth, address, {
          reason: 'epoch_regressed',
          errorCode: outcome.errorCode,
          errorMessage: ahead
            ? `This box sent epoch ${address.journalEpoch}; the cloud has it on ${epoch}`
            : `A batch from epoch ${address.journalEpoch}, which was replaced by ${epoch} when the store was reset`,
          batchId,
          alertKey: `sync.epoch_regressed:${auth.boxId}`,
        });
        anomalies.push({
          kind: 'epoch_regressed',
          eventId: address.eventId,
          actionId: address.actionId,
          detail: { sentEpoch: address.journalEpoch, currentEpoch: epoch, boxSeq: address.boxSeq },
        });
        quarantined.push({ reason: 'epoch_regressed', eventId: address.eventId });
        results.push(outcome);
        continue;
      }

      /**
       * --- Already dealt with? The cursor answers in one integer.
       *
       * Asked of the ADDRESS rather than of a parsed envelope, and before the
       * envelope is judged, so that a malformed event coming round again is a
       * duplicate too. It was filed the first time and the mark moved past it;
       * refusing it afresh on every retry would file the same broken event once
       * a minute and bury the Failures tab under it.
       *
       * Two exceptions. An event whose identity had to be invented has no
       * position to compare, so there is nothing the cursor can say about it. A
       * person replaying one filed event is the other: its position was dealt
       * with when it was filed — or, for an injected one, deliberately was not —
       * and either way this shortcut would answer about the past rather than
       * about the thing they just asked to apply. The ledger is asked directly
       * instead, which is slower and is exactly right for a single deliberate
       * act.
       *
       * The comparison is against `startMark`, the frontier as this batch found
       * it, and not against a mark rising as the batch is walked. A batch is one
       * answer about one frontier: if an earlier element could move the line the
       * later ones are judged against, a single bad sequence would sweep the
       * good events standing behind it, which is exactly the fault the walk at
       * the end of this loop exists to prevent.
       */
      const belowWatermark = address.addressable && address.boxSeq <= startMark && !fromQuarantine;
      const deliberateReplay = address.addressable && fromQuarantine;
      if (belowWatermark || deliberateReplay) {
        const verdict = await classifyReplay(tx, auth, address, epoch, {
          // A deliberate replay is asking whether this was ever APPLIED. It is
          // in quarantine by definition — that is where the person found it —
          // so reading quarantine here would answer "already dealt with" about
          // the very row they are putting back.
          consultQuarantine: !deliberateReplay,
        });
        if (verdict === 'absent') {
          if (belowWatermark) {
            /**
             * Below the mark, and yet the cloud holds no record of it at all:
             * no ledger row, no quarantine row.
             *
             * The mark only passes a position by applying an event there or by
             * filing one, so every position under it should have a row in one
             * of those two tables. Exactly two things break that. The ledger's
             * retention sweep, which is ordinary and is the whole reason the
             * cursor is never swept — an event older than the window has
             * nothing left to compare hashes against and must still be
             * recognised as a replay. And a mark that has run ahead of the
             * ledger, which is not ordinary and is precisely the shape of a
             * fact a till recorded being counted a duplicate and dropped.
             *
             * From here the two are indistinguishable, so the safer of the two
             * readings still wins — applying a year-old sale a second time is
             * the worse mistake — but it is no longer done without a word. The
             * anomaly and the alert below are what turn "three facts vanished
             * with no signal" into "three facts vanished and here is the row
             * naming the box, the sequence and the mark that was ahead of it".
             */
            anomalies.push({
              kind: 'late_arrival',
              eventId: address.eventId,
              actionId: address.actionId,
              detail: {
                boxSeq: address.boxSeq,
                mark: startMark,
                droppedWithoutRecord: true,
              },
            });
            droppedWithoutRecord.push(address.boxSeq);
            duplicates += 1;
            outcome.result = 'duplicate';
            results.push(outcome);
            continue;
          }
        } else if (verdict === 'duplicate') {
          duplicates += 1;
          outcome.result = 'duplicate';
          results.push(outcome);
          continue;
        } else {
          outcome.result = 'quarantined';
          outcome.reason = 'conflict';
          outcome.errorCode = 'SYNC_CONFLICT';
          await fileQuarantine(tx, auth, address, {
            reason: 'conflict',
            errorCode: 'SYNC_CONFLICT',
            errorMessage:
              'An event with this identity is already recorded with different content — two facts are wearing one id',
            existingPayloadHash: verdict.existingPayloadHash,
            batchId,
            alertKey: `sync.quarantine:${auth.boxId}`,
          });
          anomalies.push({
            kind: 'duplicate_replay',
            eventId: address.eventId,
            actionId: address.actionId,
            detail: { boxSeq: address.boxSeq, conflict: true },
          });
          quarantined.push({ reason: 'conflict', eventId: address.eventId });
          results.push(outcome);
          continue;
        }
      }

      /**
       * --- Is it an envelope at all?
       *
       * Everything below reads its contents, so this is where a shape that
       * cannot be read stops. A failure here is `poison` like any other
       * malformed event: filed whole, alertable, replayable from the Console
       * once whatever produced it is fixed — and the batch carries on to the
       * next one, which is the whole reason the events are validated singly.
       */
      if (!envelopeParse.success) {
        outcome.result = 'quarantined';
        outcome.reason = 'poison';
        outcome.errorCode = address.addressable
          ? 'SYNC_ENVELOPE_INVALID'
          : 'SYNC_ENVELOPE_UNADDRESSABLE';
        await fileQuarantine(tx, auth, address, {
          reason: 'poison',
          errorCode: outcome.errorCode,
          errorMessage: envelopeIssues(envelopeParse.error, address.addressable),
          batchId,
          alertKey: `sync.quarantine:${auth.boxId}`,
          injected: unsigned,
        });
        quarantined.push({ reason: 'poison', eventId: address.eventId });
        results.push(outcome);
        accountFor(address.boxSeq, address.addressable);
        continue;
      }
      const envelope = envelopeParse.data;

      /**
       * A gap means the box lost facts it had already minted — a corrupted
       * store, a queue migrated wrongly. The event is still applied: refusing
       * would wedge the box for ever behind events that no longer exist, and
       * the sales that were lost are not recovered by also losing the ones
       * that survived.
       *
       * **What is missing is measured against the cloud's rows, not against the
       * cursor.** The old test was `boxSeq > walkedBefore + 1` with `walked`
       * seeded from the mark, so one hole made every later batch report the
       * positions BEHIND it missing for ever — real rows read
       * `{missing 3, expectedBoxSeq 3, receivedBoxSeq 6}` while 3, 4, 5, 6 and 7
       * were all in the ledger. A position the cloud holds a row for is not
       * missing, however that row got there, so `known` is what the step is
       * judged against and `absorbKnown` walks over it.
       *
       * **And only positions above `headBefore`.** A position below the highest
       * one the cloud already held is not news: the batch that first reached
       * past it is the batch that had the chance to say so, and re-saying it on
       * every push afterwards is the same "once per batch for ever" fault in a
       * different place. The ceiling is the same window the mark walks, so a box
       * that jumps thousands of positions in one go has the first thousand named
       * and the rest neither named nor examined — `lookedUpTo` on the row says
       * how far the look went, because a longer list on a tab is worth less than
       * a bounded query here.
       *
       * It records an anomaly and does NOT raise an alert. A standing hole is a
       * live condition and it has one now — `sync.cursor_stalled` in
       * `evaluateBox`, which is true while the cursor is behind the ledger and
       * stops being true when the hole is filled or the store is reset. This row
       * is what one batch saw and is not the same question: a hole whose
       * position DID reach the cloud, in a row that could not be applied, opens
       * that condition and records nothing here, because nothing is missing.
       */
      if (!fromQuarantine) {
        const ceiling = Math.min(envelope.boxSeq - 1, startMark + MARK_WINDOW);
        for (let seq = walkedBefore + 1; seq <= ceiling; seq += 1) {
          if (known.has(seq) || seq <= headBefore) continue;
          missing.add(seq);
          gapWitness ??= {
            eventId: envelope.eventId,
            actionId: envelope.actionId ?? null,
            boxSeq: envelope.boxSeq,
          };
        }
      }

      const prepared = prepareEvent(envelope, scope);
      let refusal: RefuseEvent | null = null;

      try {
        // The SAVEPOINT. One bad event rolls back its own work and nothing
        // else's — which is what makes a batch of two hundred worth sending.
        await tx.transaction(async (sp) => {
          assertEnvelopeUsable(prepared, publicKey, unsigned);
          if (envelope.stationId && !scope.stationIds.has(envelope.stationId)) {
            throw new RefuseEvent(
              'poison',
              'SYNC_STATION_NOT_ON_BOX',
              'That station is not on this box',
            );
          }
          const handler = HANDLERS[envelope.type];
          if (!handler) {
            throw new RefuseEvent(
              'unknown_type',
              'SYNC_TYPE_UNKNOWN',
              `This api does not know how to apply "${envelope.type}"`,
            );
          }
          const parsed = handler.schema.safeParse(envelope.payload);
          if (!parsed.success) {
            throw new RefuseEvent(
              'poison',
              'SYNC_PAYLOAD_INVALID',
              // The issues, not the values: a payload is a member's phone.
              parsed.error.issues
                .map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`)
                .join('; ')
                .slice(0, 400),
            );
          }

          const result = await handler.apply(sp, scope, prepared, parsed.data as never);

          await sp.insert(syncEvent).values({
            eventId: envelope.eventId,
            boxId: auth.boxId,
            journalEpoch: epoch,
            boxSeq: envelope.boxSeq,
            type: envelope.type,
            schemaVersion: envelope.schemaVersion,
            occurredAt: prepared.occurredAt,
            receivedAt: prepared.receivedAt,
            clockTrust: prepared.clockTrust,
            clockOffsetMs: envelope.clockOffsetMs ?? null,
            businessDate: prepared.businessDate,
            businessDateSource: prepared.businessDateSource,
            operatorId: auth.operatorId,
            branchId: auth.branchId,
            stationId: envelope.stationId ?? null,
            actorKind: envelope.actorKind,
            actorAccountId: envelope.actorAccountId ?? null,
            actorCredentialId: envelope.actorCredentialId ?? null,
            actionId: envelope.actionId ?? null,
            payload: envelope.payload as never,
            payloadHash: envelope.payloadHash,
            sig: envelope.sig,
            sigAlg: envelope.sigAlg,
            batchId,
          });

          for (const change of result.changes ?? []) {
            await recordChange(sp, { operatorId: auth.operatorId, branchId: auth.branchId }, change);
          }
          for (const a of result.anomalies ?? []) {
            anomalies.push({
              kind: a.kind,
              eventId: envelope.eventId,
              relatedEventId: a.relatedEventId ?? null,
              actionId: envelope.actionId ?? null,
              detail: a.detail,
            });
          }
          if (prepared.businessDateSource === 'received_at') {
            anomalies.push({
              kind: 'clock_recomputed',
              eventId: envelope.eventId,
              actionId: envelope.actionId ?? null,
              detail: {
                clockTrust: prepared.clockTrust,
                clockOffsetMs: envelope.clockOffsetMs ?? null,
                // Both candidates, so a day's takings that look wrong are
                // explainable from the row months later.
                fromOccurredAt: businessDate(
                  prepared.occurredAt,
                  scope.timezone,
                  scope.dayStartMinutes,
                ),
                fromReceivedAt: prepared.businessDate,
              },
            });
          }
        });
      } catch (err) {
        refusal = classifyFailure(err);
      }

      if (refusal) {
        const r: RefuseEvent = refusal;
        /**
         * A unique violation on the journal is not always a conflict.
         *
         * Above the mark nothing asked the ledger whether it had seen this
         * event — the cursor shortcut is what usually answers that — so an
         * honest re-send reaches the insert and the index refuses it. A box
         * re-sends whenever it is unsure, and it is unsure whenever an answer
         * was lost on the way back, so this is ordinary weather rather than a
         * corner. Now that the mark can legitimately sit behind the sequences a
         * box is sending, the ledger is asked directly: the same id at the same
         * position with the same hash is the re-send it looks like, and parking
         * it on the Failures tab as a conflict would put a person in front of a
         * fact that is already safely applied.
         */
        if (r.errorCode === 'SYNC_EVENT_ID_TAKEN' || r.errorCode === 'SYNC_JOURNAL_TAKEN') {
          const verdict = await classifyReplay(tx, auth, address, epoch, {
            consultQuarantine: false,
          });
          if (verdict === 'duplicate') {
            duplicates += 1;
            outcome.result = 'duplicate';
            results.push(outcome);
            accountFor(address.boxSeq, address.addressable);
            continue;
          }
        }
        outcome.result = 'quarantined';
        outcome.reason = r.reason;
        outcome.errorCode = r.errorCode;
        await fileQuarantine(tx, auth, address, {
          reason: r.reason,
          errorCode: r.errorCode,
          errorMessage: r.message,
          existingPayloadHash: r.existingPayloadHash ?? null,
          batchId,
          alertKey: `sync.quarantine:${auth.boxId}`,
          injected: unsigned,
        });
        quarantined.push({ reason: r.reason, eventId: envelope.eventId });
        results.push(outcome);
        accountFor(address.boxSeq, address.addressable);
        continue;
      }

      applied += 1;
      accountFor(envelope.boxSeq, true);
      lastEventId = envelope.eventId;
      outcome.businessDate = prepared.businessDate;
      outcome.businessDateSource = prepared.businessDateSource;
      results.push(outcome);
    }

    /**
     * The walk. One step per position the cloud can claim, stopping at the
     * first hole — which is the whole rule, and the reason the mark could not be
     * computed until every element had been seen.
     *
     * It normally stops at the very first position it looks at, because the
     * common case is a mark already sitting at the head of the journal: nothing
     * was loaded above it, and the only positions in `sealed` are the ones this
     * batch just dealt with. Bounded without needing to be told: `sealed` holds
     * at most `MARK_WINDOW` loaded positions plus one per element of the batch,
     * so this loop runs at most that many times.
     */
    let mark = startMark;
    while (sealed.has(mark + 1)) mark += 1;
    for (const seq of sealed) if (seq > mark) markHeldFor.push(seq);
    markHeldFor.sort((a, b) => a - b);
    cursorSeq = mark;

    /**
     * One row for the batch, rather than one per event. The positions are what
     * an investigation needs; the first event that stepped past one of them is
     * where to start reading.
     *
     * Filtered against `known` once more, now that the whole batch has been
     * seen: a damaged queue row is the one input that arrives out of journal
     * order, so a position can be stepped over by one element and filed by
     * another later in the same batch, and the answer must not depend on which
     * of the two the box happened to put first.
     */
    const seqs = [...missing].filter((seq) => !known.has(seq)).sort((a, b) => a - b);
    if (seqs.length > 0 && gapWitness) {
      anomalies.push({
        kind: 'sequence_gap',
        eventId: gapWitness.eventId,
        actionId: gapWitness.actionId,
        detail: {
          /** How many were found, which is not the same as how many there are. */
          missing: seqs.length,
          missingBoxSeqs: seqs.slice(0, 20),
          expectedBoxSeq: seqs[0],
          receivedBoxSeq: gapWitness.boxSeq,
          /** The highest position the cloud held before this batch. */
          knownBoxSeq: headBefore,
          /** How far above the mark this looked. Past it, nothing was examined. */
          lookedUpTo: startMark + MARK_WINDOW,
        },
      });
    }

    await tx
      .update(syncCursor)
      .set({
        lastBoxSeq: mark,
        lastEventId,
        eventsApplied: sql`${syncCursor.eventsApplied} + ${applied}`,
        eventsDuplicate: sql`${syncCursor.eventsDuplicate} + ${duplicates}`,
        eventsQuarantined: sql`${syncCursor.eventsQuarantined} + ${quarantined.length}`,
        lastPushAt: startedAt,
      })
      .where(and(eq(syncCursor.boxId, auth.boxId), eq(syncCursor.journalEpoch, epoch)));

    for (const a of anomalies) {
      await tx.insert(syncAnomaly).values({
        id: newId(),
        boxId: auth.boxId,
        eventId: a.eventId,
        relatedEventId: a.relatedEventId ?? null,
        kind: a.kind,
        detail: scrubDetail(a.detail ?? {}) as never,
        actionId: a.actionId ?? null,
      });
    }
  });

  /**
   * One `ops_run` per batch, with the counts. `duplicates` on a replayed batch
   * is the number the acceptance criterion reads — `applied=0 duplicates=N` is
   * how the ledger proves it is idempotent — so it is a first-class count here
   * rather than something to be inferred from the absence of others.
   */
  await recordRun(db, {
    id: batchId,
    kind: 'sync',
    name: 'sync:push',
    outcome: quarantined.length > 0 ? 'failed' : 'ok',
    startedAt,
    detail: {
      boxId: auth.boxId,
      slot: auth.slot,
      epoch,
      events: input.events.length,
      applied,
      duplicates,
      quarantined: quarantined.length,
      rejected,
      cursorSeq,
      source,
      /** What the box thought its own high-water mark was, when it said. */
      boxCursorSeq: input.cursorSeq ?? null,
      /**
       * Positions the cloud can claim — from this batch or from an earlier one —
       * that the mark could not walk to, because something between them and the
       * mark is missing. The fingerprint of a box sending sequences a gapless
       * journal could not have reached from here: a damaged queue row, or a
       * store that has lost part of its journal. The events themselves were
       * still applied or still filed; what did not happen is the cursor claiming
       * the positions in between. The standing condition is
       * `sync.cursor_stalled`; this is what one batch saw.
       */
      markHeldFor: markHeldFor.length > 0 ? markHeldFor.slice(0, 20) : undefined,
    },
    error:
      quarantined.length > 0
        ? new AppError(
            422,
            'SYNC_QUARANTINED',
            `${quarantined.length} event(s) could not be applied: ${[
              ...new Set(quarantined.map((q) => q.reason)),
            ].join(', ')}`,
          )
        : undefined,
    operatorId: auth.operatorId,
    branchId: auth.branchId,
    actionId: batchActionId,
    requestId: ctx.requestId ?? null,
  });

  /**
   * The loudest thing this file can say, and the reason it says it.
   *
   * Counting an event a duplicate on the cursor's word, with no ledger row and
   * no quarantine row to back the word up, is the only way a fact a till
   * recorded can leave this function without being written down somewhere. It
   * has a legitimate cause — the ledger's retention sweep — and it had an
   * illegitimate one, a mark thrown ahead by a single bad sequence, which is
   * what the ceiling above now prevents. Neither is something to find out about
   * from a row count months later, so this alert stands whichever it was, and
   * the anomaly beside it names the sequence and the mark that was ahead of it.
   */
  if (droppedWithoutRecord.length > 0) {
    await raiseAlert(
      db,
      {
        key: `sync.dropped_without_record:${auth.boxId}`,
        category: 'sync.dropped_without_record',
        severity: 'critical',
        subject: `${auth.name} (${auth.slot})`,
        summary: `${droppedWithoutRecord.length} event(s) from ${auth.name} were counted duplicates with nothing recorded for them — the sync cursor is ahead of the ledger, or they are older than its retention window`,
        detail: {
          boxId: auth.boxId,
          epoch,
          batchId,
          cursorSeq,
          boxSeqs: droppedWithoutRecord.slice(0, 20),
        },
        operatorId: auth.operatorId,
        branchId: auth.branchId,
      },
      { flapWindowSeconds: 0 },
    );
  }

  if (quarantined.length > 0) {
    const epochRegressed = quarantined.filter((q) => q.reason === 'epoch_regressed').length;
    if (epochRegressed > 0) {
      await raiseAlert(
        db,
        {
          key: `sync.epoch_regressed:${auth.boxId}`,
          category: 'sync.epoch_regressed',
          severity: 'warning',
          subject: `${auth.name} (${auth.slot})`,
          summary: `${auth.name} sent ${epochRegressed} event(s) from a journal epoch the cloud has replaced — a replay from a store that was reset`,
          detail: { boxId: auth.boxId, epoch, count: epochRegressed },
          operatorId: auth.operatorId,
          branchId: auth.branchId,
        },
        { flapWindowSeconds: 0 },
      );
    }
    const others = quarantined.length - epochRegressed;
    if (others > 0) {
      await raiseAlert(
        db,
        {
          key: `sync.quarantine:${auth.boxId}`,
          category: 'sync.quarantine',
          severity: 'warning',
          subject: `${auth.name} (${auth.slot})`,
          summary: `${others} event(s) from ${auth.name} could not be applied and are waiting on Failures > Quarantine`,
          detail: {
            boxId: auth.boxId,
            batchId,
            reasons: [...new Set(quarantined.map((q) => q.reason))],
          },
          operatorId: auth.operatorId,
          branchId: auth.branchId,
        },
        { flapWindowSeconds: 0 },
      );
    }
  }

  return {
    applied,
    duplicates,
    quarantined: quarantined.length,
    rejected,
    results,
    cursorSeq,
    epoch,
    batchId,
    serverTime: new Date().toISOString(),
  };
}

/**
 * Resolve the clock, and say which clock won.
 *
 * A Pi has no clock battery, so `occurred_at` can be hours out on a box that
 * came up after a power cut — and on a park that closes after midnight a wrong
 * timestamp silently moves a sale into the wrong trading day. `occurred_at` is
 * kept exactly as sent whatever happens; what changes is which of the two
 * clocks the business date is derived from, and `business_date_source` says so
 * on the row itself.
 */
function prepareEvent(envelope: SyncEventEnvelope, scope: BatchScope): PreparedEvent {
  const receivedAt = new Date();
  const occurredAt = new Date(envelope.occurredAt);
  /**
   * The box's id goes back into the bytes before they are hashed or verified.
   *
   * It is in `SYNC_CANONICAL_FIELDS` and it is not a field of the envelope, so
   * it has to be put back from somewhere, and the credential the push arrived
   * on is the only honest source: the body cannot name a box. Canonicalising
   * without it writes a null into the slot the box filled with a uuid, and
   * then nothing a real box sends ever hashes to what it carries.
   */
  const canonical = canonicalSyncBytes({ ...envelope, boxId: scope.auth.boxId });
  const offset = envelope.clockOffsetMs ?? 0;
  /**
   * The box's own verdict, overruled downwards when the offset it reported is
   * outside the tolerance. A box that says `trusted` while its clock is ten
   * minutes out is not lying — it simply has not measured recently — and the
   * cloud has the measurement.
   */
  const clockTrust: SyncClockTrust =
    envelope.clockTrust !== 'trusted'
      ? envelope.clockTrust
      : Math.abs(offset) > CLOCK_TOLERANCE_MS
        ? 'skewed'
        : 'trusted';
  const source: BusinessDateSource = clockTrust === 'trusted' ? 'occurred_at' : 'received_at';
  const basis = source === 'occurred_at' ? occurredAt : receivedAt;
  return {
    envelope,
    canonical,
    computedHash: sha256Hex(canonical),
    clockTrust,
    businessDate: businessDate(basis, scope.timezone, scope.dayStartMinutes),
    businessDateSource: source,
    receivedAt,
    occurredAt,
  };
}

/**
 * The two checks that are about the envelope rather than about its contents:
 * does it hash to what it claims, and did the box we think it came from sign it.
 *
 * Hash first, because it is free and because a mismatch means the envelope is
 * internally inconsistent — there is nothing to verify a signature against.
 */
function assertEnvelopeUsable(
  prepared: PreparedEvent,
  publicKey: KeyObject | null,
  /**
   * True for the test controls' own events, which the cloud minted and cannot
   * verify because it holds only the public half of the box's key. Decided by
   * the CALLER from the push's source and never from anything in the envelope:
   * a box that could reach this by writing an agreed string into `sig` would be
   * a box that never has to sign anything.
   */
  unsigned: boolean,
): void {
  const { envelope } = prepared;
  if (envelope.schemaVersion > SYNC_EVENT_SCHEMA_VERSION) {
    throw new RefuseEvent(
      'schema_too_new',
      'SYNC_SCHEMA_TOO_NEW',
      `This event is schema version ${envelope.schemaVersion}; this api reads up to ${SYNC_EVENT_SCHEMA_VERSION}`,
    );
  }
  if (prepared.computedHash !== envelope.payloadHash) {
    throw new RefuseEvent(
      'poison',
      'SYNC_HASH_MISMATCH',
      'The envelope does not hash to the value it carries — it was changed after it was sealed',
    );
  }
  if (unsigned || !publicKey) return;
  let ok = false;
  try {
    ok = verifyDetached(
      null,
      Buffer.from(prepared.canonical, 'utf8'),
      publicKey,
      Buffer.from(envelope.sig, 'base64'),
    );
  } catch {
    // A malformed signature is a failed verification, not a server fault.
    ok = false;
  }
  if (!ok) {
    throw new RefuseEvent(
      'signature_invalid',
      'SYNC_SIGNATURE_INVALID',
      'The signature does not verify against this box’s registered key',
    );
  }
}

/**
 * How far above the mark one push may look.
 *
 * The walk reads positions out of the ledger rather than out of the batch, so it
 * needs a ceiling or a box carrying a year-old hole would read a year of
 * sequences on every push. A batch is at most `SYNC_PUSH_MAX_EVENTS` (200)
 * events, so a thousand is five batches of headroom: a hole filled several
 * batches later is absorbed in one step, and a hole that is never filled reads
 * at most a thousand index entries per push — see the cost note on
 * `loadHeldPositions` for the whole of it. Past the ceiling the cloud does not
 * look and does not claim: the mark catches up a window at a time, and
 * `sync.cursor_stalled` says it is behind while it does.
 */
const MARK_WINDOW = 1_000;

/** Positions above the mark, and what the cloud may say about each of them. */
interface HeldPositions {
  /** Positions the mark may claim: applied, or filed under the id the box sent. */
  sealed: Set<number>;
  /** Positions the cloud holds anything at all for. What a gap is measured against. */
  known: Set<number>;
  /** The highest position in `known`, or the mark itself when nothing is above it. */
  head: number;
}

/**
 * Read what the cloud holds above the mark, in one bounded window.
 *
 * **Cost.** Two reads per push. The ledger one is an index-only range scan on
 * `sync_event_journal_unique` over at most `MARK_WINDOW` rows, and in the
 * ordinary case — a mark sitting at the head of the journal — it returns none.
 * The quarantine one has no index on the position, so it is a scan of this box's
 * quarantine rows filtered by epoch and window; that table is small by
 * construction, and the watchdog's "quarantine non-empty" rule is what says so
 * long before its size is a question. At a park doing 5,000 events a day, where
 * the agent flushes every five seconds, that is of the order of ten thousand
 * pairs of small reads a day against an index and a table of tens of rows.
 *
 * Two kinds of filed row are `known` without being `sealed`, and both exclusions
 * exist to stop the mark retiring a position the box is going to send again:
 *
 *   - an event the test controls INJECTED, which the box never minted and whose
 *     sequence it is about to use;
 *   - an event whose identity had to be invented, because the id in the answer
 *     is then not one the box can match against its queue — it never retires the
 *     row, and re-sends it whole. `payload->>'eventId'` is the id the box
 *     actually sent: `fileQuarantine` writes the raw element as the payload and
 *     `salvageAddress` mints `event_id` only when it could not read one, so the
 *     two agree exactly when the identity came off the wire.
 */
async function loadHeldPositions(
  tx: Tx,
  auth: BoxAuth,
  epoch: number,
  mark: number,
): Promise<HeldPositions> {
  const ceiling = mark + MARK_WINDOW;
  const applied = await tx
    .select({ boxSeq: syncEvent.boxSeq })
    .from(syncEvent)
    .where(
      and(
        eq(syncEvent.boxId, auth.boxId),
        eq(syncEvent.journalEpoch, epoch),
        gt(syncEvent.boxSeq, mark),
        lte(syncEvent.boxSeq, ceiling),
      ),
    )
    .orderBy(asc(syncEvent.boxSeq))
    .limit(MARK_WINDOW);

  const filed = await tx
    .select({
      boxSeq: syncQuarantine.boxSeq,
      eventId: syncQuarantine.eventId,
      sig: syncQuarantine.sig,
      errorMessage: syncQuarantine.errorMessage,
      /** Null where the element was not even an object, which is not an identity. */
      sentEventId: sql<
        string | null
      >`case when jsonb_typeof(${syncQuarantine.payload}) = 'object' then ${syncQuarantine.payload}->>'eventId' else null end`,
    })
    .from(syncQuarantine)
    .where(
      and(
        eq(syncQuarantine.boxId, auth.boxId),
        eq(syncQuarantine.journalEpoch, epoch),
        gt(syncQuarantine.boxSeq, mark),
        lte(syncQuarantine.boxSeq, ceiling),
      ),
    )
    .limit(MARK_WINDOW);

  const sealed = new Set<number>();
  const known = new Set<number>();
  let head = mark;
  for (const row of applied) {
    sealed.add(row.boxSeq);
    known.add(row.boxSeq);
    if (row.boxSeq > head) head = row.boxSeq;
  }
  for (const row of filed) {
    known.add(row.boxSeq);
    if (row.boxSeq > head) head = row.boxSeq;
    if (wasInjected(row)) continue;
    if (row.sentEventId !== row.eventId) continue;
    sealed.add(row.boxSeq);
  }
  return { sealed, known, head };
}

/**
 * An event at or below the high-water mark: is it the same event coming round
 * again, or a different one wearing its id?
 *
 * The ledger row may be gone — it is swept after a year and the cursor is not —
 * and that case is still a duplicate, which is the whole reason the cursor
 * exists. What is NOT a duplicate is a ledger row with this id and a different
 * hash, or a different id sitting at this journal position.
 *
 * `absent` is the answer that means "no record of it anywhere", and the caller
 * treats it as the serious answer it is, so quarantine is read here too: an
 * event that was refused has no ledger row — that is what being refused means —
 * and calling it unrecorded would make the ordinary case of a box re-sending a
 * batch that contained one bad event raise an alarm on every retry.
 */
async function classifyReplay(
  tx: Tx,
  auth: BoxAuth,
  address: EventAddress,
  epoch: number,
  opts: { consultQuarantine: boolean },
): Promise<'duplicate' | 'absent' | { existingPayloadHash: string | null }> {
  const [byId] = await tx
    .select({ payloadHash: syncEvent.payloadHash, boxSeq: syncEvent.boxSeq })
    .from(syncEvent)
    .where(eq(syncEvent.eventId, address.eventId))
    .limit(1);
  if (byId) {
    if (byId.payloadHash === address.payloadHash && byId.boxSeq === address.boxSeq) {
      return 'duplicate';
    }
    return { existingPayloadHash: byId.payloadHash };
  }
  const [bySeq] = await tx
    .select({ eventId: syncEvent.eventId, payloadHash: syncEvent.payloadHash })
    .from(syncEvent)
    .where(
      and(
        eq(syncEvent.boxId, auth.boxId),
        eq(syncEvent.journalEpoch, epoch),
        eq(syncEvent.boxSeq, address.boxSeq),
      ),
    )
    .limit(1);
  if (bySeq && bySeq.eventId !== address.eventId) {
    return { existingPayloadHash: bySeq.payloadHash };
  }
  if (opts.consultQuarantine) {
    const [filed] = await tx
      .select({ id: syncQuarantine.id })
      .from(syncQuarantine)
      .where(
        and(
          eq(syncQuarantine.boxId, auth.boxId),
          eq(syncQuarantine.journalEpoch, epoch),
          eq(syncQuarantine.eventId, address.eventId),
        ),
      )
      .limit(1);
    // Filed is dealt with, whatever became of it afterwards. A replayed or
    // discarded row is still a decision somebody took about this event, and
    // re-sending it is still a retry rather than news.
    if (filed) return 'duplicate';
  }
  /**
   * Nothing left to compare against, in either table. What that MEANS depends
   * on why we are asking: under the high-water mark it is a swept replay, or a
   * mark that has run ahead of the ledger, and the caller tells both apart from
   * neither by saying so out loud; for an event a person is deliberately
   * replaying it is the opposite — this has never been applied — so it goes
   * through.
   */
  return 'absent';
}

/**
 * What a thrown value means for quarantine.
 *
 * A `RefuseEvent` already knows. Everything else is the database saying no, and
 * the two that matter are worth telling apart: a foreign key on the actor means
 * the box attributed a sale to somebody this cloud has never heard of, which a
 * person has to look at; a unique violation on the journal means two facts
 * reached one position.
 */
function classifyFailure(err: unknown): RefuseEvent {
  if (err instanceof RefuseEvent) return err;
  const pg = pgErrorOf(err);
  const constraint = typeof pg?.constraint === 'string' ? pg.constraint : '';
  if (pg?.code === '23503' && constraint.includes('actor')) {
    return new RefuseEvent(
      'actor_unknown',
      'SYNC_ACTOR_UNKNOWN',
      'The account or device credential this event names does not exist here',
    );
  }
  if (pg?.code === '23505' && constraint.includes('journal')) {
    return new RefuseEvent(
      'conflict',
      'SYNC_JOURNAL_TAKEN',
      'Another event already holds this journal position',
    );
  }
  if (pg?.code === '23505' && constraint.includes('sync_event_pkey')) {
    return new RefuseEvent('conflict', 'SYNC_EVENT_ID_TAKEN', 'That event id is already recorded');
  }
  const info = errorInfo(err);
  return new RefuseEvent('apply_failed', info.code, info.message);
}

/** A parsed envelope always knows where it lives. */
function addressOf(envelope: SyncEventEnvelope): EventAddress {
  return {
    eventId: envelope.eventId,
    journalEpoch: envelope.journalEpoch,
    boxSeq: envelope.boxSeq,
    type: envelope.type,
    schemaVersion: envelope.schemaVersion,
    occurredAt: new Date(envelope.occurredAt),
    payloadHash: envelope.payloadHash,
    sig: envelope.sig,
    actionId: envelope.actionId ?? null,
    raw: envelope,
    addressable: true,
  };
}

/**
 * Read an identity out of something that is not an envelope.
 *
 * The box writes `event_id`, `journal_epoch` and `box_seq` as NOT NULL columns,
 * so a real box cannot produce a row without them; what reaches here instead is
 * a half-written queue row, a proxy that truncated a body, or something that is
 * not a box at all. Whatever it is, taking the three fields that ARE legible
 * lets the event be filed under its own identity and acknowledged by it, which
 * is the difference between the box retiring the row and re-sending it for
 * ever. Where even those are unreadable the id is minted so nothing is dropped
 * silently, and `addressable` says the mark must not move for it.
 */
function salvageAddress(raw: unknown, epoch: number): EventAddress {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const positiveInt = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
  const text = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;

  const eventId = typeof o.eventId === 'string' && UUID_PATTERN.test(o.eventId) ? o.eventId : null;
  const boxSeq = positiveInt(o.boxSeq);
  const occurredAt = typeof o.occurredAt === 'string' ? new Date(o.occurredAt) : null;

  return {
    eventId: eventId ?? newId(),
    // The current epoch when it cannot be read, so the event is refused for
    // being malformed rather than for a regression it never claimed.
    journalEpoch: positiveInt(o.journalEpoch) ?? epoch,
    boxSeq: boxSeq ?? 0,
    type: text(o.type, 64),
    schemaVersion: positiveInt(o.schemaVersion),
    occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null,
    payloadHash: text(o.payloadHash, 64),
    sig: text(o.sig, 512),
    actionId: text(o.actionId, 64),
    // A null would violate `sync_quarantine.payload`'s NOT NULL, and an empty
    // object at least records that the batch carried something unreadable here.
    raw: raw ?? {},
    addressable: eventId !== null && boxSeq !== null,
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why an envelope would not parse, as field names and zod codes.
 *
 * The issues and never the values: a sync payload is a member's phone number,
 * and this message is read on a Console page by whoever is on shift.
 */
function envelopeIssues(error: z.ZodError | undefined, addressable: boolean): string {
  // Optional because the caller reaches this from `!envelope` rather than from
  // `!parsedEnvelope.success`, and the two are the same fact only to a reader.
  // An unparsed envelope always has issues; saying so rather than asserting it
  // keeps a future caller from finding out with a crash inside a batch.
  const issues = (error?.issues ?? [])
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`)
    .join('; ')
    .slice(0, 400);
  const preface = addressable
    ? 'This is not a valid sync envelope'
    : 'This is not a valid sync envelope, and it carries no id or sequence to acknowledge it by';
  return `${preface} — ${issues}`;
}

/**
 * The sentence that says a quarantine row came from the test controls rather
 * than from a box. Written here and only here — a box has no way to put text in
 * `error_message`, which is what makes it the half of `wasInjected` that cannot
 * be forged from the wire.
 */
const INJECTED_MARKER = 'injected from the Console test controls — not a real box fault';

/**
 * What an injected event carries where a signature would be.
 *
 * There is no box private key in this process — that is the point of a keypair
 * — so `injectPoisonEvent` cannot sign what it mints. This sentinel goes in the
 * slot so the row is legible to whoever reads it. It is NOT what makes the push
 * skip verification; the push skips verification because it was told its source
 * is `injected`.
 */
export const INJECTED_EVENT_SIG = 'injected-from-the-console-test-controls';

/**
 * Was this quarantine row minted by the test controls rather than sent by a box?
 *
 * It decides whether Replay skips the signature, so it has to be a question a
 * box cannot answer for itself. The marker is the half that does that work: it
 * is written by `fileQuarantine` when the push's source was `injected`, and a
 * box has no way to put text into `error_message` — every message a refusal
 * before the payload check produces is a fixed string. The sentinel in `sig` is
 * checked beside it because an event carrying it could not have been verified
 * against any key, so the two together describe exactly one origin.
 *
 * This belongs in a column on `edge.sync_quarantine`. It is read out of two text
 * fields because adding one is a migration, and this is not the change that
 * should carry it.
 */
function wasInjected(row: { sig: string | null; errorMessage: string | null }): boolean {
  return row.sig === INJECTED_EVENT_SIG && (row.errorMessage ?? '').includes(INJECTED_MARKER);
}

/** File a refused event whole, so "replay" means replay and not reconstruct. */
async function fileQuarantine(
  tx: Tx,
  auth: BoxAuth,
  address: EventAddress,
  info: {
    reason: SyncQuarantineReason;
    errorCode: string;
    errorMessage: string;
    existingPayloadHash?: string | null;
    batchId: string;
    alertKey: string;
    injected?: boolean;
  },
): Promise<void> {
  const values = {
    boxId: auth.boxId,
    eventId: address.eventId,
    journalEpoch: address.journalEpoch,
    boxSeq: address.boxSeq,
    type: address.type,
    schemaVersion: address.schemaVersion,
    reason: info.reason,
    status: 'open' as const,
    errorCode: info.errorCode,
    errorMessage: info.injected ? `${info.errorMessage} (${INJECTED_MARKER})` : info.errorMessage,
    // The envelope as it was sent, personal data and all. It has to be, to be
    // replayable — which is why the list route below never returns it.
    payload: address.raw as never,
    payloadHash: address.payloadHash,
    existingPayloadHash: info.existingPayloadHash ?? null,
    sig: address.sig,
    occurredAt: address.occurredAt,
    actionId: address.actionId,
    batchId: info.batchId,
    alertKey: info.alertKey,
  };

  /**
   * One open row per event, refreshed rather than repeated.
   *
   * Replay puts an event back through this same door, and an event that is
   * still refused arrives back here. Filing a second row for it means somebody
   * who presses Replay twice on one bad event is looking at three rows for it,
   * none of them more true than the others, and the watchdog's "quarantine
   * non-empty" count grows with the pressing rather than with the fault. There
   * is no unique index to upsert against — the same event id may legitimately
   * be filed again under a different epoch after a store reset — so the open
   * row for this epoch is looked up and updated.
   *
   * `received_at` is deliberately left alone: it is when this event first came
   * back refused, which is the question an investigation opens with. The latest
   * attempt is named by `batch_id`.
   */
  const [existing] = await tx
    .select({ id: syncQuarantine.id })
    .from(syncQuarantine)
    .where(
      and(
        eq(syncQuarantine.boxId, auth.boxId),
        eq(syncQuarantine.eventId, address.eventId),
        eq(syncQuarantine.journalEpoch, address.journalEpoch),
        eq(syncQuarantine.status, 'open'),
      ),
    )
    .limit(1);
  if (existing) {
    await tx.update(syncQuarantine).set(values).where(eq(syncQuarantine.id, existing.id));
    return;
  }
  await tx.insert(syncQuarantine).values({ id: newId(), ...values });
}

// --- Pull -------------------------------------------------------------------

export interface PullQuery {
  cursorSeq: number;
  limit: number;
  scopes?: SyncChangeScope[];
}

/**
 * The cloud-authoritative traffic, in the other direction.
 *
 * A box takes the changes addressed to its branch, plus the operator-wide ones,
 * plus the ones addressed to it by name. It never sees another branch's
 * catalogue or another box's station config, and the WHERE below is what
 * enforces that rather than a filter applied afterwards.
 *
 * `seq` is a bigserial, which means two concurrent inserts can commit out of
 * order and a reader that has passed a number could miss the row that lands
 * behind it. That is survivable here and would not be in the ledger: every row
 * is an idempotent upsert or delete keyed by entity, so a box that rewinds its
 * cursor a little re-applies harmlessly. Which is also why the cloud honours
 * whatever cursor it is given rather than insisting on its own.
 */
export async function pullChanges(
  db: Db,
  auth: BoxAuth,
  query: PullQuery,
): Promise<SyncPullResponse> {
  const where = and(
    eq(syncChange.operatorId, auth.operatorId),
    or(isNull(syncChange.branchId), eq(syncChange.branchId, auth.branchId)),
    or(isNull(syncChange.boxId), eq(syncChange.boxId, auth.boxId)),
    gt(syncChange.seq, query.cursorSeq),
    query.scopes?.length ? inArray(syncChange.scope, query.scopes) : undefined,
  );

  const rows = await db
    .select()
    .from(syncChange)
    .where(where)
    .orderBy(asc(syncChange.seq))
    .limit(query.limit);

  const cursorSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : query.cursorSeq;

  // Where the box has got to, on the same row as its push position: a store
  // reset mints a new epoch AND throws the cache away, so both reset together.
  await db
    .update(syncCursor)
    .set({ pullCursorSeq: cursorSeq, lastPullAt: new Date() })
    .where(
      and(
        eq(syncCursor.boxId, auth.boxId),
        eq(syncCursor.journalEpoch, auth.currentEpoch),
        lt(syncCursor.pullCursorSeq, cursorSeq),
      ),
    );

  return {
    changes: rows.map((r) => ({
      seq: r.seq,
      scope: r.scope,
      op: r.op,
      entityType: r.entityType,
      entityId: r.entityId,
      version: r.version,
      schemaVersion: r.schemaVersion,
      payload: r.payload ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    // A full page may not be the last one, and a short page always is.
    hasMore: rows.length === query.limit,
    cursorSeq,
    serverTime: new Date().toISOString(),
  };
}

// --- The cache bundle -------------------------------------------------------

export const CACHE_SCOPES = [
  'catalogue',
  'members',
  'staff',
  'deny_list',
  'bookings',
  'bands',
  'station_config',
  'receipt_series',
] as const;
export type CacheScope = (typeof CACHE_SCOPES)[number];

export interface CacheQuery {
  scopes?: CacheScope[];
  /** The bundle version this agent can read. A newer bundle is refused. */
  supportedSchemaVersion?: number;
  limit?: number;
  /** Only with exactly one scope: paging one scope is unambiguous, paging eight is not. */
  cursor?: string;
}

export interface CacheBundle {
  schemaVersion: number;
  /** One hash over everything below; the box applies whole or not at all. */
  bundleVersion: string;
  generatedAt: string;
  /**
   * Where `sync_change` stood when this was built. A box that applies the
   * bundle sets its pull cursor here and never re-applies a delta the bundle
   * already contains — which is the whole reason a bundle and a feed can
   * coexist without fighting.
   */
  cursorSeq: number;
  scopes: Record<string, { items: unknown[]; nextCursor: string | null }>;
  /** Scopes cut off at the limit, so the box knows to ask for them alone. */
  truncated: string[];
}

/**
 * Everything one box needs to keep its counter working with no internet.
 *
 * **What it does NOT carry, and why.** A box is a Raspberry Pi standing in a
 * shopping mall that anybody can unplug and walk out with, so the bundle is
 * sized to what a counter must DO without the internet and to nothing else:
 *
 *   - **no other branch, and no other operator.** Everything is scoped by the
 *     credential's own branch;
 *   - **no sales history, no payments, no audit log, no reporting.** A box acts;
 *     it does not answer questions about the past. A stolen Pi must not be a
 *     copy of the business;
 *   - **no wallet balances and no payment instruments.** An offline box must
 *     not be able to spend money it cannot verify;
 *   - **no member notes, email or tier evidence.** Staff notes are free text and
 *     can say anything; the till's identify step does not read them;
 *   - **of staff, only what an offline unlock needs** — the account id, the
 *     argon2id hash and the status. Not a phone, not an employee record, not a
 *     role assignment;
 *   - **no private keys.** The signing keys in the config bundle are public
 *     halves, and this adds nothing to them.
 *
 * What it DOES carry that is personal is the branch's members and their
 * children, including allergy and medical alerts — because a till with no
 * internet still has to warn the kitchen. Those fields are staff-only (R-58):
 * the box redacts them on the way to the customer display, once, so no screen
 * is trusted to hide anything.
 */
export async function cacheBundle(
  db: Db,
  auth: BoxAuth,
  query: CacheQuery,
): Promise<CacheBundle> {
  const wanted = query.scopes?.length ? query.scopes : [...CACHE_SCOPES];
  const limit = Math.min(query.limit ?? CACHE_DEFAULT_LIMIT, CACHE_MAX_LIMIT);
  if (query.cursor && wanted.length !== 1) {
    throw new AppError(
      400,
      'CACHE_CURSOR_AMBIGUOUS',
      'A cursor pages one scope — ask for that scope on its own',
    );
  }

  const scopes: CacheBundle['scopes'] = {};
  const truncated: string[] = [];
  const operatorId = auth.operatorId;
  const branchId = auth.branchId;

  const put = (name: string, items: unknown[], cursorOf?: (last: unknown) => string): void => {
    const full = items.length === limit;
    if (full) truncated.push(name);
    scopes[name] = {
      items,
      nextCursor: full && cursorOf ? cursorOf(items[items.length - 1]) : null,
    };
  };

  for (const scope of wanted) {
    if (scope === 'catalogue') {
      const packages = await db
        .select()
        .from(ticketPackage)
        .where(and(eq(ticketPackage.branchId, branchId), isNull(ticketPackage.archivedAt)))
        .orderBy(asc(ticketPackage.name));
      const categories = await db
        .select()
        .from(productCategory)
        .where(eq(productCategory.operatorId, operatorId))
        .orderBy(asc(productCategory.name));
      const products = await db
        .select()
        .from(product)
        .where(and(eq(product.branchId, branchId), isNull(product.archivedAt)))
        .orderBy(asc(product.name));
      const tiers = await db
        .select()
        .from(tier)
        .where(eq(tier.operatorId, operatorId))
        .orderBy(asc(tier.code));
      const holidays = await db
        .select()
        .from(branchHoliday)
        .where(eq(branchHoliday.branchId, branchId))
        .orderBy(asc(branchHoliday.startsOn));
      const [taxConfig] = await db
        .select()
        .from(branchTaxConfig)
        .where(eq(branchTaxConfig.branchId, branchId))
        .limit(1);
      const overrides = await db
        .select()
        .from(taxOverride)
        .where(eq(taxOverride.branchId, branchId));
      // One item, because the catalogue is applied as a unit: half a price list
      // is worse than none.
      put('catalogue', [
        { packages, categories, products, tiers, holidays, taxConfig: taxConfig ?? null, overrides },
      ]);
      continue;
    }

    if (scope === 'members') {
      const after = query.cursor ?? '';
      const rows = await db
        .select()
        .from(member)
        .where(
          and(
            eq(member.operatorId, operatorId),
            isNull(member.archivedAt),
            after ? gt(member.id, after) : undefined,
          ),
        )
        .orderBy(asc(member.id))
        .limit(limit);
      const children = rows.length
        ? await db
            .select()
            .from(child)
            .where(
              and(
                inArray(
                  child.memberId,
                  rows.map((m) => m.id),
                ),
                isNull(child.archivedAt),
              ),
            )
        : [];
      const byMember = new Map<string, unknown[]>();
      for (const c of children) {
        const list = byMember.get(c.memberId) ?? [];
        list.push(childChange(c));
        byMember.set(c.memberId, list);
      }
      put(
        'members',
        rows.map((m) => ({
          ...(memberChange(m) as Record<string, unknown>),
          children: byMember.get(m.id) ?? [],
        })),
        (last) => (last as { id: string }).id,
      );
      continue;
    }

    if (scope === 'staff') {
      /**
       * Only accounts that may actually stand at a station on THIS box, which
       * is the same rule the station picker applies: a box holds the unlock
       * credentials of the people who work at its counter and of nobody else.
       */
      const rows = await db
        .selectDistinct({
          id: account.id,
          passwordHash: account.passwordHash,
          status: account.status,
          mustChangePassword: account.mustChangePassword,
        })
        .from(account)
        .innerJoin(stationStaff, eq(stationStaff.accountId, account.id))
        .innerJoin(station, eq(stationStaff.stationId, station.id))
        .where(
          and(
            eq(station.boxId, auth.boxId),
            isNull(station.archivedAt),
            eq(account.operatorId, operatorId),
          ),
        )
        .limit(limit);
      put(
        'staff',
        rows.map((a) => ({
          accountId: a.id,
          // The argon2id hash, which is what an offline unlock verifies
          // against. Never a password, and never anything that identifies the
          // person to somebody holding the disk.
          passwordHash: a.passwordHash,
          status: a.status,
          mustChangePassword: a.mustChangePassword,
        })),
      );
      continue;
    }

    if (scope === 'deny_list') {
      /**
       * Who must NOT be let in, which is the half that has to be right. An
       * account the cloud has deactivated is refused offline from the moment
       * the box next pulls, and the box drops cached staff who are not in the
       * latest bundle (S2-06).
       */
      const rows = await db
        .select({ id: account.id, status: account.status })
        .from(account)
        .where(and(eq(account.operatorId, operatorId), sql`${account.status} <> 'active'`))
        .limit(limit);
      put('deny_list', [
        {
          revokedAccountIds: rows.map((r) => r.id),
          /** Staff tokens revoked by jti — filled by S2-06, empty until then. */
          revokedTokenIds: [] as string[],
        },
      ]);
      continue;
    }

    if (scope === 'bookings') {
      // Today and tomorrow only: a box needs the bookings it might redeem, not
      // the diary. `business_date` decides "today" at the branch, not UTC.
      const rows = await db
        .select()
        .from(booking)
        .where(
          and(
            eq(booking.branchId, branchId),
            isNull(booking.archivedAt),
            sql`${booking.bookingDate} >= current_date - 1 and ${booking.bookingDate} <= current_date + 1`,
          ),
        )
        .orderBy(asc(booking.bookingDate))
        .limit(limit);
      put('bookings', rows);
      continue;
    }

    if (scope === 'bands') {
      const rows = await db
        .select()
        .from(band)
        .where(and(eq(band.branchId, branchId), eq(band.status, 'active')))
        .orderBy(asc(band.id))
        .limit(limit);
      put('bands', rows, (last) => (last as { id: string }).id);
      continue;
    }

    if (scope === 'station_config') {
      const stations = await db
        .select()
        .from(station)
        .where(and(eq(station.boxId, auth.boxId), isNull(station.archivedAt)))
        .orderBy(asc(station.name));
      const assignments = stations.length
        ? await db
            .select({ stationId: stationDevice.stationId, role: stationDevice.role, device })
            .from(stationDevice)
            .innerJoin(device, eq(stationDevice.deviceId, device.id))
            .where(
              and(
                eq(device.boxId, auth.boxId),
                isNull(device.archivedAt),
                inArray(
                  stationDevice.stationId,
                  stations.map((s) => s.id),
                ),
              ),
            )
        : [];
      put(
        'station_config',
        stations.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          codePrefix: s.codePrefix,
          capabilities: s.capabilities ?? [],
          accessScope: s.accessScope,
          configVersion: s.configVersion,
          offlineWalletCapSatang: s.offlineWalletCapSatang,
          devices: assignments
            .filter((a) => a.stationId === s.id)
            .map((a) => ({ id: a.device.id, role: a.role, kind: a.device.kind })),
        })),
      );
      continue;
    }

    // receipt_series — the high-water marks a box continues from when it is
    // offline, so two boxes cannot mint the same receipt number. The series
    // itself arrives with the money path (S2-11); what is here is the shape and
    // the per-station counter the prefix is built from.
    const stations = await db
      .select({ id: station.id, codePrefix: station.codePrefix, name: station.name })
      .from(station)
      .where(and(eq(station.boxId, auth.boxId), isNull(station.archivedAt)))
      .orderBy(asc(station.name));
    put(
      'receipt_series',
      stations.map((s) => ({
        stationId: s.id,
        prefix: s.codePrefix,
        /** Nothing has been issued yet; S2-11 fills this from the sale ledger. */
        highWaterMark: 0,
      })),
    );
  }

  const [head] = await db
    .select({ seq: sql<number>`coalesce(max(${syncChange.seq}), 0)::bigint` })
    .from(syncChange);

  const body = { schemaVersion: CACHE_BUNDLE_SCHEMA_VERSION, scopes };
  return {
    schemaVersion: CACHE_BUNDLE_SCHEMA_VERSION,
    bundleVersion: sha256Hex(JSON.stringify(body)).slice(0, 16),
    generatedAt: new Date().toISOString(),
    cursorSeq: Number(head?.seq ?? 0),
    scopes,
    truncated,
  };
}

/**
 * A box too old to read the bundle this api would build gets a refusal and an
 * alert, not a document it will half-apply.
 *
 * The failure this prevents is the quiet one: an agent that does not recognise
 * a field silently drops it, and a counter then runs on a price list missing
 * whatever was added last week. Better to say so, loudly, to somebody who can
 * update the box.
 */
export async function assertBundleReadable(
  db: Db,
  auth: BoxAuth,
  supported: number | undefined,
): Promise<void> {
  if (supported === undefined || supported >= CACHE_BUNDLE_SCHEMA_VERSION) return;
  await raiseAlert(
    db,
    {
      key: `sync.bundle_unsupported:${auth.boxId}`,
      category: 'sync.bundle_unsupported',
      severity: 'warning',
      subject: `${auth.name} (${auth.slot})`,
      summary: `${auth.name} reads cache bundles up to version ${supported}; this api builds version ${CACHE_BUNDLE_SCHEMA_VERSION} — the box needs updating before it can cache anything`,
      detail: { boxId: auth.boxId, supported, built: CACHE_BUNDLE_SCHEMA_VERSION },
      operatorId: auth.operatorId,
      branchId: auth.branchId,
    },
    { flapWindowSeconds: 0 },
  );
  throw new AppError(
    409,
    'CACHE_SCHEMA_TOO_NEW',
    `This api builds cache bundles at schema version ${CACHE_BUNDLE_SCHEMA_VERSION}, which this agent cannot read`,
  );
}

// --- What Health and the watchdog read --------------------------------------

export interface BoxSyncFacts {
  boxId: string;
  /** Queued or sending, from the box's own store where that store is ours. */
  outboxDepth: number;
  /** The age of the oldest thing still waiting, in seconds. */
  oldestUnackedAgeS: number | null;
  quarantineOpen: number;
  epochRegressedOpen: number;
  lastPushAt: Date | null;
  lastBoxSeq: number;
}

/**
 * The outbox as the CLOUD can see it.
 *
 * On a Pi the outbox is a SQLite table and this returns nothing, which is
 * correct — the box reports its own depth on the heartbeat and that is the only
 * honest source for hardware we cannot reach. On the virtual box the store IS
 * this database: `startVirtualBox` hands the agent a `SqlBoxStore` over this
 * pool (`lib/box-store.ts`), so every fact it queues is a row in
 * `edge.box_outbox` and nothing about the queue lives in the process's memory.
 * That is what makes "toggle offline, create three members, restart the api,
 * the depth is still three" a thing anybody can watch happen on Render rather
 * than a claim about what would happen.
 */
export async function boxOutboxState(
  exec: Exec,
  boxId: string,
): Promise<{ depth: number; oldestCreatedAt: Date | null }> {
  const [row] = await exec
    .select({
      depth: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${boxOutbox.createdAt})`,
    })
    .from(boxOutbox)
    .where(and(eq(boxOutbox.boxId, boxId), sql`${boxOutbox.state} in ('queued','sending')`));
  return { depth: row?.depth ?? 0, oldestCreatedAt: row?.oldest ?? null };
}

// --- Quarantine, from the Console -------------------------------------------

export interface QuarantineRow {
  id: string;
  boxId: string;
  boxName: string;
  slot: string;
  eventId: string;
  journalEpoch: number;
  boxSeq: number;
  type: string | null;
  reason: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  receivedAt: string;
  actionId: string | null;
  batchId: string | null;
  resolvedAt: string | null;
  replayedEventId: string | null;
}

/**
 * The Failures > Quarantine tab.
 *
 * **The payload is not here, on purpose.** A quarantined `member.created`
 * carries a phone number and a child's allergy note, because it has to be
 * replayable as sent. This page is read by whoever is on call, on a screen in a
 * back office, and what they need is which box, which event, why, and the two
 * buttons — none of which is the payload.
 */
export async function listQuarantine(
  db: Db,
  q: { operatorId: string; status?: SyncQuarantineStatus; limit: number },
): Promise<QuarantineRow[]> {
  const rows = await db
    .select({
      q: syncQuarantine,
      boxName: box.name,
      slot: box.slot,
    })
    .from(syncQuarantine)
    .innerJoin(box, eq(syncQuarantine.boxId, box.id))
    .where(
      and(
        eq(box.operatorId, q.operatorId),
        q.status ? eq(syncQuarantine.status, q.status) : undefined,
      ),
    )
    .orderBy(desc(syncQuarantine.receivedAt))
    .limit(q.limit);

  return rows.map((r) => ({
    id: r.q.id,
    boxId: r.q.boxId,
    boxName: r.boxName,
    slot: r.slot,
    eventId: r.q.eventId,
    journalEpoch: r.q.journalEpoch,
    boxSeq: r.q.boxSeq,
    type: r.q.type,
    reason: r.q.reason,
    status: r.q.status,
    errorCode: r.q.errorCode,
    errorMessage: r.q.errorMessage,
    receivedAt: r.q.receivedAt.toISOString(),
    actionId: r.q.actionId,
    batchId: r.q.batchId,
    resolvedAt: r.q.resolvedAt?.toISOString() ?? null,
    replayedEventId: r.q.replayedEventId,
  }));
}

/**
 * Put a quarantined event back through the door it was refused at.
 *
 * It goes through `pushEvents` rather than being inserted directly, so a replay
 * is held to every rule a first attempt was: the signature is verified again,
 * the epoch is checked again, and an event that is still poison is still poison.
 * The only thing that has changed is whatever the person fixed in between — an
 * account that now exists, an api that now knows the type.
 *
 * Two things a replay must not do, both learnt the hard way. It must not move
 * the high-water mark: the mark dealt with this event when it was filed, and
 * moving it again lands it on the sequence the box is about to mint, which is
 * how pressing Inject and then Replay used to swallow a till's next real fact.
 * And it must not file a second row when the answer is the same as last time —
 * see `fileQuarantine` — so pressing the button twice leaves one row, not three.
 */
export async function replayQuarantined(
  db: Db,
  auth: BoxAuth,
  quarantineId: string,
  ctx: OpContext,
  actorAccountId: string,
): Promise<{ result: SyncEventResult; outcome: SyncEventOutcome; message: string }> {
  const [row] = await db
    .select()
    .from(syncQuarantine)
    .where(and(eq(syncQuarantine.id, quarantineId), eq(syncQuarantine.boxId, auth.boxId)))
    .limit(1);
  if (!row) throw new AppError(404, 'QUARANTINE_NOT_FOUND', 'No such quarantined event');
  if (row.status !== 'open') {
    throw new AppError(409, 'QUARANTINE_CLOSED', `That event has already been ${row.status}`);
  }

  const envelope = row.payload as SyncEventEnvelope;
  /**
   * An injected row goes back through the door the way it came in: unsigned.
   *
   * It never was a fact a box sealed, so holding it to a signature check
   * answers every press with `signature_invalid` — a complaint about a seal
   * that never existed, standing in front of the failure the control was
   * pressed to demonstrate. Replayed as injected, it is refused for its
   * payload, which is the true thing about it, the row it already has is
   * refreshed rather than duplicated, and it stays open for Discard. That is
   * what the button can honestly promise for an event that was never real: it
   * goes back through, and it comes back with the real reason.
   */
  const injected = wasInjected(row);
  const response = await pushEvents(db, auth, { events: [envelope] }, ctx, {
    source: injected ? 'injected_replay' : 'quarantine_replay',
    actorAccountId,
  });
  const outcome = response.results[0]!;
  const message =
    outcome.result === 'applied'
      ? 'Applied. The event is in the ledger and the records it makes exist.'
      : outcome.result === 'duplicate'
        ? 'Already in the ledger — nothing was applied twice.'
        : injected
          ? `Refused again: ${outcome.errorCode ?? outcome.reason ?? 'quarantined'}. This event was injected from the test controls and cannot be applied — its payload is not a member. Discard it.`
          : `Refused again: ${outcome.errorCode ?? outcome.reason ?? 'quarantined'}. It is still open, with the reason updated.`;

  if (outcome.result === 'applied' || outcome.result === 'duplicate') {
    await withTx(db, ctx, 'sync.quarantine_replay', async (tx) => {
      await tx
        .update(syncQuarantine)
        .set({
          status: 'replayed',
          resolvedAt: new Date(),
          resolvedByAccountId: actorAccountId,
          replayedEventId: envelope.eventId,
        })
        .where(and(eq(syncQuarantine.id, quarantineId), eq(syncQuarantine.status, 'open')));
      await audit.record(tx, {
        actorAccountId,
        operatorId: auth.operatorId,
        branchId: auth.branchId,
        action: 'sync.quarantine_replay',
        entityType: 'sync_quarantine',
        entityId: quarantineId,
        before: { reason: row.reason, status: 'open' },
        after: { status: 'replayed', result: outcome.result },
        requestId: ctx.requestId,
        actionId: row.actionId,
        sourceEventId: envelope.eventId,
      });
    });
  }

  return { result: outcome.result, outcome, message };
}

/** Decide not to apply it, with a reason. A discard with no reason is not a decision. */
export async function discardQuarantined(
  db: Db,
  auth: BoxAuth,
  quarantineId: string,
  note: string,
  ctx: OpContext,
  actorAccountId: string,
): Promise<{ ok: true }> {
  const [row] = await db
    .select()
    .from(syncQuarantine)
    .where(and(eq(syncQuarantine.id, quarantineId), eq(syncQuarantine.boxId, auth.boxId)))
    .limit(1);
  if (!row) throw new AppError(404, 'QUARANTINE_NOT_FOUND', 'No such quarantined event');
  if (row.status !== 'open') {
    throw new AppError(409, 'QUARANTINE_CLOSED', `That event has already been ${row.status}`);
  }
  await withTx(db, ctx, 'sync.quarantine_discard', async (tx) => {
    await tx
      .update(syncQuarantine)
      .set({
        status: 'discarded',
        resolvedAt: new Date(),
        resolvedByAccountId: actorAccountId,
        resolutionNote: note,
      })
      .where(and(eq(syncQuarantine.id, quarantineId), eq(syncQuarantine.status, 'open')));
    await audit.record(tx, {
      actorAccountId,
      operatorId: auth.operatorId,
      branchId: auth.branchId,
      action: 'sync.quarantine_discard',
      entityType: 'sync_quarantine',
      entityId: quarantineId,
      before: { reason: row.reason, status: 'open' },
      after: { status: 'discarded', note },
      requestId: ctx.requestId,
      actionId: row.actionId,
      sourceEventId: row.eventId,
    });
  });
  return { ok: true };
}

// --- Retention --------------------------------------------------------------
//
// Four windows, and the reasoning behind each is on its table in
// `packages/db/src/schema/sync.ts`. What matters here: DEDUPE DOES NOT DEPEND ON
// ANY OF THEM. `sync_cursor` is never swept, so an event older than the ledger's
// window has no row left to compare hashes against and is still recognisably a
// replay, because its sequence is still at or below the high-water mark.
//
// It is no longer a quiet one. A replay the push can find no record of — neither
// in the ledger nor in quarantine — is still dropped, and now says so with a
// `late_arrival` anomaly and a `sync.dropped_without_record` alert, because from
// inside the push a swept row and a mark that has run ahead of the ledger look
// identical and only one of them is harmless. A box re-sending something older
// than a year is rare enough to be worth a person's minute.

export async function purgeOldSyncEvents(db: Db, retentionDays: number): Promise<number> {
  const result = await db.execute(
    sql`delete from edge.sync_event where received_at < now() - ${`${retentionDays} days`}::interval`,
  );
  return result.rowCount ?? 0;
}

export async function purgeOldSyncAnomalies(db: Db, retentionDays: number): Promise<number> {
  const result = await db.execute(
    sql`delete from edge.sync_anomaly where detected_at < now() - ${`${retentionDays} days`}::interval`,
  );
  return result.rowCount ?? 0;
}

export async function purgeOldSyncChanges(db: Db, retentionDays: number): Promise<number> {
  const result = await db.execute(
    sql`delete from edge.sync_change where created_at < now() - ${`${retentionDays} days`}::interval`,
  );
  return result.rowCount ?? 0;
}

export async function purgeOldStationEvents(db: Db, retentionDays: number): Promise<number> {
  const result = await db.execute(
    sql`delete from edge.station_event where received_at < now() - ${`${retentionDays} days`}::interval`,
  );
  return result.rowCount ?? 0;
}

/**
 * Close the cursor rows of epochs a box has left behind.
 *
 * The row itself is kept for ever — it is what makes a replay from the old
 * journal recognisable rather than ambiguous — and `closed_at` is what says the
 * box has moved on. Called where the epoch is minted, which is the only place
 * that knows.
 */
export async function closeCursorEpoch(exec: Exec, boxId: string, epoch: number): Promise<void> {
  await exec
    .update(syncCursor)
    .set({ closedAt: new Date() })
    .where(
      and(
        eq(syncCursor.boxId, boxId),
        eq(syncCursor.journalEpoch, epoch),
        isNull(syncCursor.closedAt),
      ),
    );
}

// --- The staging test controls ----------------------------------------------

/**
 * Re-send the newest batch this box pushed, exactly as it was sent.
 *
 * The envelopes come out of the ledger — the box's own bytes, its own hashes,
 * its own signatures — so this is a genuine replay rather than a reconstruction,
 * and it is verified like any other push. The answer is the acceptance
 * criterion: `applied=0 duplicates=N`, one member row, and the cursor exactly
 * where it was.
 */
export async function replayLastBatch(
  db: Db,
  auth: BoxAuth,
  ctx: OpContext,
): Promise<SyncPushResponse> {
  const [newest] = await db
    .select({ batchId: syncEvent.batchId })
    .from(syncEvent)
    .where(and(eq(syncEvent.boxId, auth.boxId), sql`${syncEvent.batchId} is not null`))
    .orderBy(desc(syncEvent.receivedAt))
    .limit(1);
  if (!newest?.batchId) {
    throw new AppError(
      409,
      'SYNC_NO_BATCH',
      'This box has not pushed anything yet — there is no batch to replay',
    );
  }
  const rows = await db
    .select()
    .from(syncEvent)
    .where(and(eq(syncEvent.boxId, auth.boxId), eq(syncEvent.batchId, newest.batchId)))
    .orderBy(asc(syncEvent.boxSeq));

  const events: SyncEventEnvelope[] = rows.map((r) => ({
    eventId: r.eventId,
    journalEpoch: r.journalEpoch,
    boxSeq: r.boxSeq,
    type: r.type,
    schemaVersion: r.schemaVersion,
    occurredAt: r.occurredAt.toISOString(),
    clockTrust: r.clockTrust,
    clockOffsetMs: r.clockOffsetMs ?? undefined,
    stationId: r.stationId,
    actorKind: r.actorKind,
    actorAccountId: r.actorAccountId,
    actorCredentialId: r.actorCredentialId,
    actionId: r.actionId,
    payload: r.payload as Record<string, unknown>,
    payloadHash: r.payloadHash,
    sig: r.sig,
    sigAlg: r.sigAlg as SyncEventEnvelope['sigAlg'],
  }));

  return pushEvents(db, auth, { events }, ctx, { source: 'replay' });
}

/**
 * Make one event go wrong on purpose, so the quarantine path can be watched
 * doing its job.
 *
 * **It skips the signature check, and the row says so.** There is no box
 * private key in this process to sign with — that is the point of a keypair —
 * so the alternative would be an event quarantined as `signature_invalid`,
 * which demonstrates the wrong thing. What lands instead is a real `poison`:
 * a known type whose payload does not validate, filed whole, alertable,
 * replayable and discardable like any other. The quarantine row carries
 * "injected from the Console test controls" in its message so nobody reads it
 * back six months later as a box fault.
 *
 * **It must not cost the box anything.** This is a button on a demo, and the
 * two ways it could wedge the box it is aimed at are both about the sequence
 * number it borrows. It sits at `lastBoxSeq + 1` — adjacent, so no fabricated
 * gap and no anomaly claiming a million events went missing — and `pushEvents`
 * does not move the high-water mark for an injected event, because the box has
 * no such event and will itself mint that very sequence next. A mark moved past
 * it would make the box's next real fact land below the watermark, be counted a
 * duplicate, and be dropped for ever. Replaying one is held to the same rule by
 * the `injected_replay` source, which is the other half of the same promise:
 * the first press of Replay used to do exactly what the injection was careful
 * not to.
 *
 * Both gates of `OPS_TEST_CONTROLS` stand in front of it, and `assertProductionSafe`
 * refuses to boot a production deployment with that flag set.
 */
export async function injectPoisonEvent(
  db: Db,
  auth: BoxAuth,
  ctx: OpContext,
  actorAccountId: string,
): Promise<SyncPushResponse> {
  const [cursorRow] = await db
    .select({ lastBoxSeq: syncCursor.lastBoxSeq })
    .from(syncCursor)
    .where(
      and(eq(syncCursor.boxId, auth.boxId), eq(syncCursor.journalEpoch, auth.currentEpoch)),
    )
    .limit(1);

  const envelope: SyncEventEnvelope = {
    eventId: newId(),
    journalEpoch: auth.currentEpoch,
    /** The next position, not a distant one: see the note above. */
    boxSeq: (cursorRow?.lastBoxSeq ?? 0) + 1,
    type: 'member.created',
    schemaVersion: SYNC_EVENT_SCHEMA_VERSION,
    occurredAt: new Date().toISOString(),
    clockTrust: 'trusted',
    stationId: null,
    actorKind: 'system',
    actorAccountId: null,
    actorCredentialId: null,
    actionId: `inject-${Date.now()}`,
    // A member with no phone and no nickname: a known type the cloud will try
    // to apply and whose payload cannot possibly be one.
    payload: { poison: true, injectedBy: actorAccountId },
    payloadHash: '',
    sig: INJECTED_EVENT_SIG,
    sigAlg: 'ed25519',
  };
  // Hashed like any other envelope — with the box id put back, the way the
  // push recomputes it — so the quarantine row is internally consistent and the
  // failure it demonstrates is the payload, not the seal.
  envelope.payloadHash = sha256Hex(canonicalSyncBytes({ ...envelope, boxId: auth.boxId }));

  return pushEvents(db, auth, { events: [envelope] }, ctx, {
    source: 'injected',
    actorAccountId,
  });
}
