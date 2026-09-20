import { z } from 'zod';

/**
 * The box-to-cloud sync contract (S2-05).
 *
 * `packages/box-agent/src/protocol.ts` owns the wire for registration,
 * heartbeat, config and commands. This file owns the wire for FACTS: the
 * envelope a box wraps every sale, member and passage in, the push and pull
 * bodies, and the vocabularies the cloud answers with. It lives in
 * `@oto/shared` rather than beside the protocol because three surfaces read it
 * — the api that applies events, the agent that mints them and the Console
 * that displays what went wrong — and only one of those three depends on the
 * agent package.
 *
 * The vocabularies below mirror the CHECK constraints on `edge.sync_event`,
 * `edge.sync_quarantine`, `edge.sync_anomaly` and `edge.sync_change` in
 * `@oto/db`. They are declared twice on purpose and for the same reason
 * `box-agent` declares its own: `@oto/db` depends on `@oto/shared`, so the
 * arrow cannot point the other way. The database is the authority — a value
 * missing from a CHECK is refused whatever this file says.
 *
 * Two rules the envelope follows, inherited from the box protocol:
 *
 *   - **A box only ever speaks about itself.** No envelope names another box.
 *     `box_id` is taken from the credential the push arrives on, never from
 *     the body, so a compromised box cannot write events attributed to a
 *     healthy one.
 *   - **The cloud never trusts the box's clock.** `occurredAt` is recorded as
 *     sent and the trading day is resolved from it only when the clock is
 *     believed; see `SYNC_CLOCK_TRUST`.
 */

/**
 * The envelope shape. A box queues events and may be offline for days, so an
 * event minted before an upgrade has to be readable after one: the writer
 * stamps the version, the reader migrates on read. Bumped when a field changes
 * MEANING, not when one is added.
 */
export const SYNC_EVENT_SCHEMA_VERSION = 1;

/** Bounded batches (R-46, PLATFORM_PLAN §7.5) — a retry after a dropped link re-sends at most this. */
export const SYNC_PUSH_MAX_EVENTS = 200;
export const SYNC_PUSH_MAX_BYTES = 1_000_000;

/**
 * How much the cloud believes the box's clock.
 *
 * A Pi has no clock battery. `trusted` is a box whose offset is inside
 * tolerance; `skewed` is a measurable drift the box reported; `untrusted` is a
 * box that could not say what time it was — it came up after a power cut and
 * never reached NTP. Anything but `trusted` makes the cloud resolve the
 * trading day from its own clock and say so on the row.
 */
export const SYNC_CLOCK_TRUST = ['trusted', 'skewed', 'untrusted'] as const;
export type SyncClockTrust = (typeof SYNC_CLOCK_TRUST)[number];

/** Which timestamp the stored `businessDate` was computed from. */
export const BUSINESS_DATE_SOURCES = ['occurred_at', 'received_at'] as const;
export type BusinessDateSource = (typeof BUSINESS_DATE_SOURCES)[number];

/** Who did the thing. A display, kiosk or booth acts as `device` on its credential. */
export const SYNC_ACTOR_KINDS = ['account', 'device', 'box', 'system'] as const;
export type SyncActorKind = (typeof SYNC_ACTOR_KINDS)[number];

/**
 * `entity.verb`, lower snake case, matching the database's CHECK.
 *
 * The type list itself is deliberately open: every ticket from here to S2-19
 * adds types, and a closed union would need a migration and a coordinated
 * deploy per ticket. What is pinned is the SHAPE, so a garbage type is refused
 * at the boundary rather than at apply time.
 */
export const SYNC_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/**
 * SHA-256 of the canonical envelope, lower-case hex. Identity, not
 * authenticity: same id + same hash is a duplicate and is dropped; same id +
 * different hash is two facts wearing one identity and is quarantined.
 */
export const SYNC_PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Detached signature over the same canonical bytes. Provenance, not identity. */
export const SYNC_SIG_ALGORITHMS = ['ed25519'] as const;
export type SyncSigAlgorithm = (typeof SYNC_SIG_ALGORITHMS)[number];

/**
 * The stable fields of an envelope, in the order they are hashed and signed.
 *
 * Both ends must produce the SAME BYTES or every event looks like a conflict,
 * so the order is fixed here and nowhere else. `receivedAt` is absent by
 * design — it is the cloud's stamp and cannot be part of what the box signed.
 */
export const SYNC_CANONICAL_FIELDS = [
  'eventId',
  'boxId',
  'journalEpoch',
  'boxSeq',
  'type',
  'schemaVersion',
  'occurredAt',
  'stationId',
  'actorKind',
  'actorAccountId',
  'actorCredentialId',
  'actionId',
  'payload',
] as const;

export const SyncEventEnvelopeSchema = z.object({
  /** UUIDv7, minted on the box inside the transaction that queued the fact. */
  eventId: z.string().uuid(),
  /** The box's epoch and gapless journal position: the spine of the dedupe. */
  journalEpoch: z.number().int().positive(),
  boxSeq: z.number().int().positive(),
  type: z.string().min(3).max(64).regex(SYNC_EVENT_TYPE_PATTERN),
  schemaVersion: z.number().int().positive().default(SYNC_EVENT_SCHEMA_VERSION),
  /** The box's own stamp. Kept as sent even when disbelieved. */
  occurredAt: z.string().datetime(),
  clockTrust: z.enum(SYNC_CLOCK_TRUST).default('trusted'),
  /** Positive when the box is ahead, as last measured against the cloud. */
  clockOffsetMs: z.number().int().optional(),
  /** Null for a box-wide fact: a cache pull, a config apply, a clock report. */
  stationId: z.string().uuid().nullable().optional(),
  actorKind: z.enum(SYNC_ACTOR_KINDS).default('account'),
  actorAccountId: z.string().uuid().nullable().optional(),
  actorCredentialId: z.string().uuid().nullable().optional(),
  /** `x-oto-action-id`, minted where the person tapped. */
  actionId: z.string().max(64).nullable().optional(),
  payload: z.record(z.unknown()),
  payloadHash: z.string().regex(SYNC_PAYLOAD_HASH_PATTERN),
  sig: z.string().min(16).max(512),
  sigAlg: z.enum(SYNC_SIG_ALGORITHMS).default('ed25519'),
});
export type SyncEventEnvelope = z.infer<typeof SyncEventEnvelopeSchema>;

export const SyncPushRequestSchema = z.object({
  /** In journal order. The cloud applies each under its own SAVEPOINT. */
  events: z.array(SyncEventEnvelopeSchema).min(1).max(SYNC_PUSH_MAX_EVENTS),
  /**
   * The box's view of its own high-water mark when it built the batch. Not
   * trusted — the cursor is — but a disagreement is worth an anomaly, because
   * it means one of the two stores lost something.
   */
  cursorSeq: z.number().int().min(0).optional(),
});
export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

/**
 * What became of one event.
 *
 * `duplicate` is the ordinary outcome of a retry and is not a failure:
 * "Replay last batch" showing `applied=0 duplicates=N` is the acceptance
 * criterion that proves the ledger is idempotent.
 */
export const SYNC_EVENT_RESULTS = ['applied', 'duplicate', 'quarantined', 'rejected'] as const;
export type SyncEventResult = (typeof SYNC_EVENT_RESULTS)[number];

export interface SyncEventOutcome {
  eventId: string;
  boxSeq: number;
  result: SyncEventResult;
  /** Set for `quarantined`; the vocabulary below. */
  reason?: SyncQuarantineReason;
  /** Set for `applied` when the trading day was resolved from the cloud's clock. */
  businessDate?: string;
  businessDateSource?: BusinessDateSource;
  errorCode?: string;
}

export interface SyncPushResponse {
  /** `applied + duplicate + quarantined + rejected === events.length`, always. */
  applied: number;
  duplicates: number;
  quarantined: number;
  rejected: number;
  results: SyncEventOutcome[];
  /** The new high-water mark. The box drops everything at or below it. */
  cursorSeq: number;
  /** The epoch the cloud believes this box is on; a mismatch is a regression. */
  epoch: number;
  /** The `ops_run` for this batch, so the Console can show the whole push. */
  batchId: string;
  serverTime: string;
}

/** Why an event was refused. Mirrors `edge.sync_quarantine.reason`. */
export const SYNC_QUARANTINE_REASONS = [
  'conflict',
  'poison',
  'epoch_regressed',
  'sequence_gap',
  'unknown_type',
  'schema_too_new',
  'actor_unknown',
  'signature_invalid',
  'apply_failed',
] as const;
export type SyncQuarantineReason = (typeof SYNC_QUARANTINE_REASONS)[number];

export const SYNC_QUARANTINE_STATUSES = ['open', 'replayed', 'discarded'] as const;
export type SyncQuarantineStatus = (typeof SYNC_QUARANTINE_STATUSES)[number];

/** Applied, with a caveat worth recording. Mirrors `edge.sync_anomaly.kind`. */
export const SYNC_ANOMALY_KINDS = [
  'clock_recomputed',
  'duplicate_replay',
  'sequence_gap',
  'merge',
  'epoch_regressed',
  'late_arrival',
] as const;
export type SyncAnomalyKind = (typeof SYNC_ANOMALY_KINDS)[number];

/** The cache-bundle scopes, which are also the change feed's partitions. */
export const SYNC_CHANGE_SCOPES = [
  'catalogue',
  'members',
  'staff',
  'deny_list',
  'bookings',
  'bands',
  'station_config',
  'receipt_series',
] as const;
export type SyncChangeScope = (typeof SYNC_CHANGE_SCOPES)[number];

export const SYNC_CHANGE_OPS = ['upsert', 'delete'] as const;
export type SyncChangeOp = (typeof SYNC_CHANGE_OPS)[number];

export const SyncPullRequestSchema = z.object({
  /** Where the box got to in `edge.sync_change.seq`. Zero means "from the start". */
  cursorSeq: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(200),
  /** Narrow the feed; absent means every scope this box holds a cache of. */
  scopes: z.array(z.enum(SYNC_CHANGE_SCOPES)).max(SYNC_CHANGE_SCOPES.length).optional(),
});
export type SyncPullRequest = z.infer<typeof SyncPullRequestSchema>;

export interface SyncChangeRecord {
  seq: number;
  scope: SyncChangeScope;
  op: SyncChangeOp;
  entityType: string;
  entityId: string;
  /** The record's own version, so two deltas applied out of order still settle. */
  version: number | null;
  schemaVersion: number;
  /** Null for a delete. */
  payload: unknown;
  createdAt: string;
}

export interface SyncPullResponse {
  changes: SyncChangeRecord[];
  cursorSeq: number;
  /** True when more is waiting; the box pulls again rather than waiting a tick. */
  hasMore: boolean;
  serverTime: string;
}

/**
 * The canonical bytes both ends hash and sign.
 *
 * `JSON.stringify` is not a contract: key order follows insertion order, so
 * two structurally identical envelopes built by different code produce
 * different bytes and every re-send looks like a conflict. This produces one
 * answer — fields in `SYNC_CANONICAL_FIELDS` order, object keys sorted, absent
 * and null collapsed to null — and it is the ONLY definition of that answer.
 * Changing it invalidates every stored hash, so it changes with
 * `SYNC_EVENT_SCHEMA_VERSION` or not at all.
 */
export function canonicalSyncBytes(
  envelope: Partial<SyncEventEnvelope> & Record<string, unknown>,
): string {
  const ordered: unknown[] = SYNC_CANONICAL_FIELDS.map((field) =>
    envelope[field] === undefined ? null : envelope[field],
  );
  return stableStringify(ordered);
}

/** Deterministic JSON: object keys sorted, arrays left in order, undefined as null. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  // Numbers, strings and booleans. JSON.stringify is deterministic for these,
  // and a number that is not finite has no JSON form at all, which is a bug
  // worth failing on rather than silently writing `null` into a signed field.
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`Cannot canonicalise a non-finite number in a sync envelope: ${String(value)}`);
  }
  return JSON.stringify(value);
}
