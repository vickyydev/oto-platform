import type {
  StationLanguage,
  StationLease,
  StationSessionDocument,
  StationSessionStage,
  SyncActorKind,
  SyncChangeScope,
  SyncEventEnvelope,
  SyncEventOutcome,
} from './contract';

/**
 * What a box remembers (S2-05).
 *
 * The box is the system of action and the network is the unreliable part, so
 * everything a person did has to be on disk before they are told it worked.
 * That is the whole reason this is an interface rather than a class: a
 * Raspberry Pi and the virtual box running inside the api have genuinely
 * different right answers — SQLite on a memory card, and the `edge` schema of
 * the database the api is already holding open — and neither is a mock of the
 * other. The same is true of `CredentialStore` next door, for the same reason.
 *
 * Three things live here and nowhere else:
 *
 *   - **The station session document**, with its lease. One row per station,
 *     and the lease lives ON that row rather than in a table of its own: an
 *     intent is valid only if it comes from the current holder AND quotes the
 *     sequence it last saw, and on one row that is a single compare-and-set
 *     that either wins or changes nothing. Two tables would be
 *     read-decide-write with the lease free to move in between.
 *   - **The outbox**, which is the queue of facts that have happened and have
 *     not yet been accepted. A queued event has NOT been accepted, so it
 *     cannot sit in the ledger, whose rows mean the opposite.
 *   - **The box's own state**: the offline toggle, the journal epoch, the
 *     clock skew, and `nextBoxSeq` — the generator whose row lock is what
 *     makes `box_seq` gapless. In memory it would restart at 1 after a power
 *     cut and hand two different facts the same sequence.
 */

/**
 * The shape of what is on disk. Bumped when a stored shape changes MEANING.
 *
 * A box that was offline through a deploy comes back holding rows written by
 * the previous version, and losing its queue because the code moved on would
 * be losing sales. So every read migrates: `migrateSessionRow`,
 * `migrateOutboxRow` and `migrateCachedBundle` below are the only places that
 * know about older shapes, and each is a chain of small steps rather than one
 * branch, so a box two versions behind arrives at the current shape by
 * walking through the intermediate one.
 */
export const BOX_STORE_SCHEMA_VERSION = 1;

export interface BoxStateRecord {
  boxId: string;
  offline: boolean;
  offlineSince: string | null;
  offlineReason: string | null;
  offlineSetByAccountId: string | null;
  journalEpoch: number;
  /** The next sequence this box will hand out. Never reused within an epoch. */
  nextBoxSeq: number;
  storeSchemaVersion: number;
  /** Positive when the box is ahead of the cloud, as last measured. */
  clockSkewMs: number;
  appliedConfigVersion: string | null;
  lastCacheAppliedAt: string | null;
  lastResetAt: string | null;
}

export const OUTBOX_STATES = ['queued', 'sending', 'acked', 'quarantined', 'failed'] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

export interface OutboxRecord {
  /**
   * The signed envelope, exactly as it was minted.
   *
   * Nothing in here is ever rewritten, including by a migration: the hash and
   * the signature are over these bytes, and a fact re-canonicalised under a
   * newer shape would arrive at the cloud as a conflict with itself. What a
   * migration may touch is the bookkeeping beside it.
   */
  envelope: SyncEventEnvelope;
  state: OutboxState;
  attempts: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  ackedAt: string | null;
}

/** What a caller queues. Everything the envelope needs beyond this is the box's. */
export interface QueuedFact {
  /** `member.created`, `visit.opened`, `station.takeover`. */
  type: string;
  payload: Record<string, unknown>;
  /** Defaults to the box's clock. Pass it when the fact happened earlier. */
  occurredAt?: string;
  stationId?: string | null;
  actorKind?: SyncActorKind;
  actorAccountId?: string | null;
  actorCredentialId?: string | null;
  /** `x-oto-action-id`, minted where the person tapped. */
  actionId?: string | null;
}

/**
 * Seals an envelope: hashes it and signs it. Passed in rather than held by the
 * store so that the allocation of the sequence and the signing of the bytes
 * that carry it happen inside ONE transaction — a sequence handed out and then
 * not used is a gap, and a gap is indistinguishable from a lost event.
 */
export type EnvelopeSealer = (
  draft: Omit<SyncEventEnvelope, 'payloadHash' | 'sig' | 'sigAlg'>,
) => SyncEventEnvelope;

export interface OutboxBatch {
  events: SyncEventEnvelope[];
  /** The canonical size of the batch, which is what the 1 MB cap counts. */
  bytes: number;
}

export interface OutboxDepth {
  queued: number;
  /** What the watchdog's "oldest unacked" rule reads. Null when the queue is empty. */
  oldestQueuedAt: string | null;
}

/** Everything a session row needs that the document itself does not carry. */
export interface StationIdentity {
  stationId: string;
  boxId: string;
  operatorId: string;
  branchId: string;
}

export interface SessionWrite {
  stage?: StationSessionStage;
  step?: number | null;
  cart?: Record<string, unknown> | null;
  member?: Record<string, unknown> | null;
  totals?: Record<string, unknown> | null;
  payment?: Record<string, unknown> | null;
  prompt?: Record<string, unknown> | null;
  language?: StationLanguage;
  lastActionId?: string | null;
}

/** The lease as it is written; `null` releases it. */
export interface LeaseWrite {
  lease: StationLease | null;
  /** Set when a manager displaced a LIVE lease, so the row's counter moves. */
  incrementTakeover?: boolean;
}

export const STATION_EVENT_KINDS = ['intent', 'snapshot', 'lease', 'scan', 'error'] as const;
export type StationEventKind = (typeof STATION_EVENT_KINDS)[number];

export const STATION_EVENT_SOURCES = [
  'till',
  'display',
  'kiosk',
  'booth',
  'box',
  'console',
] as const;
export type StationEventSource = (typeof STATION_EVENT_SOURCES)[number];

/**
 * A line in the station's own log: what was asked for and what happened.
 * Thirty-day retention, and the payload is redacted before it gets here — a
 * log is read when something has already gone wrong, which is the worst moment
 * to discover it carries a phone number.
 */
export interface StationEventWrite {
  stationId: string;
  boxId: string;
  kind: StationEventKind;
  source: StationEventSource;
  sequence?: number | null;
  stage?: string | null;
  intentType?: string | null;
  leaseId?: string | null;
  outcome?: string | null;
  errorCode?: string | null;
  actorAccountId?: string | null;
  actionId?: string | null;
  payload?: Record<string, unknown> | null;
  occurredAt?: string | null;
}

/** One cache scope as the box holds it: applied whole, or not applied at all. */
export interface CachedBundle {
  scope: SyncChangeScope;
  schemaVersion: number;
  /** `edge.sync_change.seq` this bundle is current to. */
  cursorSeq: number;
  payload: Record<string, unknown>;
  appliedAt: string;
}

export interface BoxStore {
  /**
   * Prepare the store and recover from however the last process ended.
   *
   * Anything left `sending` is put back to `queued`: the box was cut off
   * mid-push and does not know whether the cloud saw the batch. Re-sending is
   * always safe and never losing is not, because the dedupe on
   * `(box_id, journal_epoch, box_seq)` turns a re-send into `duplicate`.
   */
  init(boxId: string): Promise<BoxStateRecord>;
  close(): Promise<void>;

  readState(boxId: string): Promise<BoxStateRecord>;
  setOffline(
    boxId: string,
    offline: boolean,
    opts?: { reason?: string | null; accountId?: string | null; now?: string },
  ): Promise<BoxStateRecord>;
  setClockSkew(boxId: string, clockSkewMs: number): Promise<BoxStateRecord>;
  /** A `reset_store` lands here: the new epoch, and the sequence back to 1. */
  setEpoch(boxId: string, journalEpoch: number, now?: string): Promise<BoxStateRecord>;
  setAppliedConfigVersion(boxId: string, configVersion: string | null): Promise<BoxStateRecord>;

  /** Allocate the next sequence and write the sealed envelope, in one transaction. */
  enqueue(
    boxId: string,
    fact: QueuedFact,
    seal: EnvelopeSealer,
    now?: string,
  ): Promise<OutboxRecord>;
  takeBatch(
    boxId: string,
    opts?: { maxEvents?: number; maxBytes?: number; now?: string },
  ): Promise<OutboxBatch>;
  /**
   * Apply the cloud's answer: acked, quarantined or to be retried.
   *
   * `sent` is the batch this answer is about, and it is the FENCE. Nothing
   * outside it is touched, however the answer is shaped: an outcome naming an
   * event the box did not hand over is ignored, and the cursor is read only as
   * the cloud's opinion about the events in `sent` that the answer did not
   * mention. Settling by sequence comparison alone is how one cursor that
   * jumped — a test control, a reset, a bug — swept an outbox full of facts
   * that had never been sent anywhere.
   */
  settle(
    boxId: string,
    outcomes: SyncEventOutcome[],
    opts: {
      sent: string[];
      cursorSeq: number;
      now: string;
      retryAt: (attempts: number) => string;
    },
  ): Promise<void>;
  /** The answer never came. Put the batch back with a backoff. */
  releaseBatch(
    boxId: string,
    eventIds: string[],
    opts: { errorCode: string; errorMessage: string; retryAt: string },
  ): Promise<void>;
  depth(boxId: string): Promise<OutboxDepth>;
  /** For "Replay last batch": the highest acked events, put back as queued. */
  requeueAcked(boxId: string, limit: number): Promise<number>;

  readSession(stationId: string): Promise<StationSessionDocument | null>;
  /** Create the row if it is absent; return whatever is there either way. */
  ensureSession(identity: StationIdentity, now: string): Promise<StationSessionDocument>;
  /**
   * The compare-and-set the whole design rests on. Returns the new document
   * when it won and `null` when the row had moved on — which is `409 STALE`.
   *
   * `advanceSequence: false` writes the document without moving the sequence.
   * The caller is still fenced on the sequence it read, so it cannot overwrite a
   * change it has not seen; what it does not do is invalidate what everybody
   * else read. That is for the intents a screen holding no lease may send — see
   * `applyIntent` — and it is the same move `applyLease` makes for the
   * 15-second renewal.
   */
  applySession(
    stationId: string,
    expect: { sequence: number; leaseId: string | null; advanceSequence?: boolean },
    write: SessionWrite,
    now: string,
  ): Promise<StationSessionDocument | null>;
  /**
   * Claim, renew, release or take over, as one compare-and-set on the same
   * row.
   *
   * The two halves of `expect` COMBINE, and a claim of an abandoned lease has
   * to send both. `leaseId` is the lease the caller believes is on the row;
   * `expiredBefore` is the instant at which the caller judged it dead. The id
   * alone cannot carry that judgement, because a renewal deliberately keeps
   * the same lease id — so `lease_id = X` is equally true of a lease that ran
   * out a minute ago and one its holder refreshed while we were deciding.
   * Re-testing the expiry inside the write is what makes the abandon decision
   * part of the compare-and-set rather than a timer read outside it; without
   * it, a heartbeat landing in that window costs a live till its station
   * mid-sale.
   *
   * `{ leaseId: null }` means "the row holds no lease" and is how a free
   * station is claimed.
   */
  applyLease(
    stationId: string,
    expect: { leaseId: string | null; expiredBefore?: string },
    write: LeaseWrite,
    now: string,
  ): Promise<StationSessionDocument | null>;
  recordStationEvent(event: StationEventWrite, now: string): Promise<void>;

  readBundle(boxId: string, scope: SyncChangeScope): Promise<CachedBundle | null>;
  /** Whole or not at all: a half-applied catalogue prices the wrong ticket. */
  writeBundle(boxId: string, bundle: CachedBundle): Promise<void>;
}

// --- Migrate on read --------------------------------------------------------

/**
 * A stored shape newer than this code can read.
 *
 * A box downgraded by a failed deploy would otherwise read a field it does not
 * understand and write back a document missing it. Refusing to read is the
 * honest answer: the row stays on disk, intact, for the version that can.
 */
export class StoreSchemaTooNewError extends Error {
  readonly what: string;
  readonly found: number;
  readonly supported: number;

  constructor(what: string, found: number, supported: number) {
    super(`This box reads ${what} up to schema ${supported}; the store holds ${found}`);
    this.name = 'StoreSchemaTooNewError';
    this.what = what;
    this.found = found;
    this.supported = supported;
  }
}

/**
 * Bring a stored session document up to the current shape.
 *
 * There is one version today, so the chain is empty and the function is a
 * guard. It is written as a chain anyway because the first migration is always
 * added under time pressure, and the shape of the thing decides whether that
 * goes well.
 */
export function migrateSessionDocument(raw: StationSessionDocument): StationSessionDocument {
  let doc = raw;
  if (doc.schemaVersion > BOX_STORE_SCHEMA_VERSION) {
    throw new StoreSchemaTooNewError(
      'a station session',
      doc.schemaVersion,
      BOX_STORE_SCHEMA_VERSION,
    );
  }
  // for (const step of SESSION_MIGRATIONS) doc = step(doc);
  doc = { ...doc, schemaVersion: BOX_STORE_SCHEMA_VERSION };
  return doc;
}

/**
 * Bring a stored outbox row up to the current shape.
 *
 * The envelope is deliberately untouched — see `OutboxRecord.envelope`. What a
 * migration may change is the row's bookkeeping: its state, its attempt count,
 * when it may next be tried. An event whose own `schemaVersion` is ahead of
 * this agent is still SENT: the cloud is the reader that has to understand it,
 * and holding a sale hostage to a box's age would be the wrong failure.
 */
export function migrateOutboxRecord(raw: OutboxRecord): OutboxRecord {
  return raw;
}

export function migrateCachedBundle(raw: CachedBundle, supported: number): CachedBundle | null {
  if (raw.schemaVersion > supported) {
    // Not an error: a cache is rebuildable. The box drops it and pulls again,
    // where the cloud refuses a bundle above the agent's version with an alert.
    return null;
  }
  return raw;
}

/**
 * Exponential backoff with jitter.
 *
 * The jitter is not decoration. Every box in a branch loses the link at the
 * same moment — the mall's internet, not their own — and comes back at the
 * same moment, so a bare doubling would have all of them push in lockstep
 * forever. Half the delay is fixed so the backoff still backs off, half is
 * random so the herd spreads.
 */
export function backoffMs(attempts: number, opts?: { baseMs?: number; capMs?: number }): number {
  const base = opts?.baseMs ?? 1_000;
  const cap = opts?.capMs ?? 300_000;
  const bounded = Math.min(cap, base * 2 ** Math.max(0, attempts - 1));
  return Math.round(bounded / 2 + Math.random() * (bounded / 2));
}
