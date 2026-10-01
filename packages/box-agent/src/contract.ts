/**
 * The sync and station-session contract, as the box holds it (S2-05).
 *
 * This is a MIRROR of `packages/shared/src/sync.ts` and
 * `packages/shared/src/station-session.ts`, written when `@oto/box-agent` had
 * no dependency on `@oto/shared`. It has one now (`"@oto/shared":
 * "workspace:*"` in this package's manifest, and `booth.ts` imports values
 * from it), so every export below could collapse into a re-export and this
 * file be three lines long; that has not been done yet.
 *
 * Until it is, the duplication is made safe rather than left to discipline:
 * `test/contract-drift.test.ts` imports both copies and asserts that every
 * vocabulary matches item for item and that `canonicalSyncBytes` produces
 * identical bytes for the same envelope. Two ends disagreeing about the bytes
 * would make every honest re-send look like a conflict, so it is the one piece
 * of duplication that cannot be allowed to drift quietly.
 *
 * `protocol.ts` next door owns the wire for registration, heartbeat, config
 * and commands. This file owns the wire for FACTS, and the document the till
 * and the customer display share.
 */

// --- Sync: the envelope a box wraps every fact in ---------------------------

/**
 * Bumped when a field changes MEANING, not when one is added. A box can be
 * offline for days, so an event minted before an upgrade has to be readable
 * after one: the writer stamps the version, the reader migrates on read.
 */
export const SYNC_EVENT_SCHEMA_VERSION = 1;

/** Bounded batches (R-46): a retry after a dropped link re-sends at most this. */
export const SYNC_PUSH_MAX_EVENTS = 200;
export const SYNC_PUSH_MAX_BYTES = 1_000_000;

/**
 * How much the cloud believes the box's clock. A Pi has no clock battery:
 * `untrusted` is a box that came up after a power cut and never reached NTP.
 */
export const SYNC_CLOCK_TRUST = ['trusted', 'skewed', 'untrusted'] as const;
export type SyncClockTrust = (typeof SYNC_CLOCK_TRUST)[number];

export const BUSINESS_DATE_SOURCES = ['occurred_at', 'received_at'] as const;
export type BusinessDateSource = (typeof BUSINESS_DATE_SOURCES)[number];

/** Who did the thing. A display, kiosk or booth acts as `device` on its credential. */
export const SYNC_ACTOR_KINDS = ['account', 'device', 'box', 'system'] as const;
export type SyncActorKind = (typeof SYNC_ACTOR_KINDS)[number];

/** `entity.verb`, lower snake case. The SHAPE is pinned; the list is open. */
export const SYNC_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** SHA-256 of the canonical envelope, lower-case hex. */
export const SYNC_PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Ed25519, not the HMAC the ticket text names.
 *
 * S2-04 stores only SHA-256 of the per-box secret (`core.box.secret_hash`),
 * and a hash cannot verify an HMAC. Honouring the wording would mean keeping a
 * second, recoverable per-box secret in the database — a credential that
 * forges a box's entire history if the database ever leaks. So the box holds a
 * private key and hands the public half over at registration. The schema agent
 * reached the same conclusion independently; `core.box.sync_public_key` and
 * this list are the two halves of it.
 */
export const SYNC_SIG_ALGORITHMS = ['ed25519'] as const;
export type SyncSigAlgorithm = (typeof SYNC_SIG_ALGORITHMS)[number];

/**
 * The stable fields of an envelope, in the order they are hashed and signed.
 * `receivedAt` is absent by design: it is the cloud's stamp and cannot be part
 * of what the box signed.
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

export interface SyncEventEnvelope {
  /** UUIDv7, minted on the box inside the transaction that queued the fact. */
  eventId: string;
  journalEpoch: number;
  boxSeq: number;
  type: string;
  schemaVersion: number;
  /** The box's own stamp. Kept as sent even when disbelieved. */
  occurredAt: string;
  clockTrust: SyncClockTrust;
  /** Positive when the box is ahead, as last measured against the cloud. */
  clockOffsetMs?: number;
  stationId?: string | null;
  actorKind: SyncActorKind;
  actorAccountId?: string | null;
  actorCredentialId?: string | null;
  /** `x-oto-action-id`, minted where the person tapped. */
  actionId?: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  sig: string;
  sigAlg: SyncSigAlgorithm;
}

export interface SyncPushRequest {
  /** In journal order. The cloud applies each under its own SAVEPOINT. */
  events: SyncEventEnvelope[];
  /** The box's view of its own high-water mark when it built the batch. */
  cursorSeq?: number;
}

export const SYNC_EVENT_RESULTS = ['applied', 'duplicate', 'quarantined', 'rejected'] as const;
export type SyncEventResult = (typeof SYNC_EVENT_RESULTS)[number];

export interface SyncEventOutcome {
  eventId: string;
  boxSeq: number;
  result: SyncEventResult;
  reason?: SyncQuarantineReason;
  businessDate?: string;
  businessDateSource?: BusinessDateSource;
  errorCode?: string;
}

export interface SyncPushResponse {
  applied: number;
  duplicates: number;
  quarantined: number;
  rejected: number;
  results: SyncEventOutcome[];
  /** The new high-water mark. The box drops everything at or below it. */
  cursorSeq: number;
  /** The epoch the cloud believes this box is on; a mismatch is a regression. */
  epoch: number;
  batchId: string;
  serverTime: string;
}

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

export const SYNC_ANOMALY_KINDS = [
  'clock_recomputed',
  'duplicate_replay',
  'sequence_gap',
  'merge',
  'epoch_regressed',
  'late_arrival',
  'receipt_collision',
  'revoked_actor',
  'wallet_overdraft',
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
  /** The booth's published wheel (S2-07a). */
  'booth',
  /** S2-13 round 4 — in-park children, pickup lists, registrations awaiting check-in. */
  'checkin',
  /** S2-14a round 4 — wallet balance snapshots and the offline cap. */
  'wallets',
] as const;
export type SyncChangeScope = (typeof SYNC_CHANGE_SCOPES)[number];

export const SYNC_CHANGE_OPS = ['upsert', 'delete'] as const;
export type SyncChangeOp = (typeof SYNC_CHANGE_OPS)[number];

export interface SyncPullRequest {
  cursorSeq: number;
  limit: number;
  scopes?: SyncChangeScope[];
}

export interface SyncChangeRecord {
  seq: number;
  scope: SyncChangeScope;
  op: SyncChangeOp;
  entityType: string;
  entityId: string;
  version: number | null;
  schemaVersion: number;
  payload: unknown;
  createdAt: string;
}

export interface SyncPullResponse {
  changes: SyncChangeRecord[];
  cursorSeq: number;
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
 * and null collapsed to null. Changing it invalidates every stored hash, so it
 * changes with `SYNC_EVENT_SCHEMA_VERSION` or not at all.
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
  // A number that is not finite has no JSON form at all, which is a bug worth
  // failing on rather than silently writing `null` into a signed field.
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`Cannot canonicalise a non-finite number in a sync envelope: ${String(value)}`);
  }
  return JSON.stringify(value);
}

// --- The station session document and its lease -----------------------------

export const STATION_SESSION_STAGES = [
  'identify',
  'welcome',
  'order',
  'input',
  'payment',
  'thankyou',
] as const;
export type StationSessionStage = (typeof STATION_SESSION_STAGES)[number];

/** What holds a lease. A read-only observer holds none and never appears here. */
export const STATION_LEASE_HOLDER_KINDS = ['till', 'kiosk', 'booth', 'console'] as const;
export type StationLeaseHolderKind = (typeof STATION_LEASE_HOLDER_KINDS)[number];

/** The five customer-facing languages; mirrors `SUPPORTED_LANGS` in `@oto/shared`. */
export const STATION_LANGUAGES = ['en', 'zh', 'th', 'ru', 'fr'] as const;
export type StationLanguage = (typeof STATION_LANGUAGES)[number];

/** Bumped when a field changes MEANING. Readers migrate on read. */
export const STATION_SESSION_SCHEMA_VERSION = 1;

/** The till renews every 15 seconds; a lease unrenewed for 60 is free to take. */
export const STATION_LEASE_HEARTBEAT_S = 15;
export const STATION_LEASE_TTL_S = 60;

/**
 * `staff` is the till's view — the whole document. `customer` is what the box
 * computes for the display: no staff notes, no allergy, medical or food-consent
 * data (R-58). The redaction happens on the way out of the box, once, so no
 * screen is trusted to hide anything.
 */
export const STATION_VIEWS = ['staff', 'customer'] as const;
export type StationView = (typeof STATION_VIEWS)[number];

export interface StationLease {
  /**
   * The fencing token. Minted on every claim and quoted by every intent, so a
   * till that was displaced and has not noticed is refused by VALUE rather than
   * by timing — the check does not depend on two clocks agreeing.
   */
  leaseId: string;
  /** An opaque per-client id — a browser tab, not a person. */
  holder: string;
  holderKind: StationLeaseHolderKind;
  /** Who is signed in at the holding till. What an audit of a takeover asks. */
  accountId: string | null;
  startedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface StationSessionDocument {
  stationId: string;
  boxId: string;
  schemaVersion: number;
  /**
   * The fence around the station's writer: stamped by the box, never reused,
   * and moved by every change made by whoever is HOLDING the station. Two tabs
   * on one station showing the same number is the acceptance criterion; an
   * intent quoting an older one is stale. The lease renewal and an intent sent
   * with no lease change the document without moving it — see
   * `StationSessionDocumentSchema` in `@oto/shared`.
   */
  sequence: number;
  stage: StationSessionStage;
  step?: number | null;
  cart?: Record<string, unknown> | null;
  member?: Record<string, unknown> | null;
  totals?: Record<string, unknown> | null;
  payment?: Record<string, unknown> | null;
  prompt?: Record<string, unknown> | null;
  language: StationLanguage;
  lease: StationLease | null;
  takeoverCount: number;
  updatedAt: string;
}

export interface StationIntent {
  /** `cart.add_line`, `payment.start`, `display.set_language`. */
  type: string;
  /** Absent only for an observer's first read, which changes nothing. */
  leaseId?: string | null;
  /** The sequence the sender last saw. The other half of the compare-and-set. */
  lastSeenSequence: number;
  payload: Record<string, unknown>;
  actionId?: string;
}

export const STATION_INTENT_REFUSALS = [
  'stale',
  'no_lease',
  'wrong_stage',
  'not_permitted',
  'unknown_intent',
] as const;
export type StationIntentRefusal = (typeof STATION_INTENT_REFUSALS)[number];

export const STATION_CHANNEL_MESSAGES = ['snapshot', 'refused', 'lease', 'ping', 'scan'] as const;
export type StationChannelMessageKind = (typeof STATION_CHANNEL_MESSAGES)[number];

export interface StationSnapshotMessage {
  kind: 'snapshot';
  view: StationView;
  document: StationSessionDocument;
  actionId: string | null;
  serverTime: string;
}

export interface StationRefusedMessage {
  kind: 'refused';
  reason: StationIntentRefusal;
  message: string;
  /** Sent with a `stale` refusal so the client rehydrates in the same round trip. */
  document: StationSessionDocument | null;
  actionId: string | null;
}

export interface StationLeaseMessage {
  kind: 'lease';
  lease: StationLease | null;
  /** True when a manager took a LIVE lease; false when an expired one was claimed. */
  takenOver: boolean;
  /** The lease that was displaced, so the losing till recognises itself. */
  displacedLeaseId: string | null;
}

export interface StationPingMessage {
  kind: 'ping';
  serverTime: string;
  sequence: number;
}

/**
 * A scan, as the screens watching a station see it (S2-06).
 *
 * It carries the FINGERPRINT and never the code, for the same reason the tape
 * does: this message reaches the customer display, which a stranger can read
 * over a shoulder. `detail` is the handler's own answer and is the one part
 * that may say something about a person, so a display-side redaction applies
 * to it exactly as it does to the document.
 */
export interface StationScanMessage {
  kind: 'scan';
  /** The hardware it came from: `box_hid`, `camera`, `simulator`, … */
  source: string;
  codeKind: string;
  codeFingerprint: string;
  outcome: string;
  /** Which registered handler took it. Null when none claimed the code. */
  handler: string | null;
  errorCode: string | null;
  detail: Record<string, unknown> | null;
  actionId: string | null;
  scannedAt: string;
}

export type StationChannelMessage =
  | StationSnapshotMessage
  | StationRefusedMessage
  | StationLeaseMessage
  | StationPingMessage
  | StationScanMessage;
