/**
 * Type-only: the store keeps a print job as data and never renders one, so it
 * has no reason to load the renderer, and the outbox and the station session
 * that open it do not pay for one. `import type` is erased before Node sees
 * the file.
 */
import type { PrintJob as RenderPrintJob } from '@oto/print';
import type {
  StationLanguage,
  StationLease,
  StationSessionDocument,
  StationSessionStage,
  SyncActorKind,
  SyncChangeScope,
  SyncClockTrust,
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
  /**
   * The Console's "Advance box clock": a deliberate move of this box's RAW
   * clock, in milliseconds, kept so a restart comes back to the same clock.
   * Zero on any box nobody is testing. It is not a measurement — the box
   * measures its clock against the platform on every heartbeat and keeps that
   * in `box_runtime` (SCRUM-402) — and it decides an event's `clockTrust` only
   * in a store no agent has stamped (see `stampClockWith`).
   */
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
 * How far an event's time may be believed, stamped on it as it is queued
 * (SCRUM-402).
 *
 * The agent decides it, because only the agent has measured the clock: with a
 * measurement made in this boot the event's `occurredAt` is already the
 * platform's time and the stamp is `trusted`, with `clockOffsetMs` whatever
 * the correction left over (zero, unless the test control has moved the clock
 * since); with none, it is `untrusted` with no offset, and the cloud files the
 * event under its own received time. Neither field is signed — see
 * `SYNC_CANONICAL_FIELDS` in `@oto/shared` for why that is acceptable.
 */
export interface ClockStamp {
  clockTrust: SyncClockTrust;
  /** Box minus platform in ms, positive when ahead. Absent: nothing to offer. */
  clockOffsetMs?: number;
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

// --- The box's own print queue (S2-07a) -------------------------------------

/**
 * What a job is doing, from the box's point of view.
 *
 * Three states and no terminal one, because a job the box has finished with is
 * DELETED rather than kept: `edge.print_job` in the cloud is the history, and
 * it is the copy with the retention sweep and the Console page. What is here is
 * only the work still outstanding, which is also what keeps a guest's name and
 * a child's allergy line out of this table for any longer than the paper takes
 * to come out.
 *
 *   - `queued`  — waiting: for its turn, for paper, for the next retry tick.
 *   - `sending` — bytes are going at a printer RIGHT NOW.
 *   - `interrupted` — it was `sending` when the process died (D12). Never
 *     retried; it exists so the cloud can be told the job failed, and it is
 *     deleted once it has been.
 */
export const BOX_PRINT_JOB_STATES = ['queued', 'sending', 'interrupted'] as const;
export type BoxPrintJobState = (typeof BOX_PRINT_JOB_STATES)[number];

/**
 * One outstanding print job on this box.
 *
 * `id` is the `edge.print_job` id minted where the job was raised, so the row
 * here and the row in the cloud are the same job under the same name — which is
 * what lets a restarted box report the outcome of work the cloud is still
 * showing as queued.
 *
 * `job` is the renderer's input, stored as JSON. Every `PrintJob` variant is
 * plain data — strings, numbers, arrays of them — so it survives the round
 * trip; `print-restart.test.ts` and `apps/api/test/print-restart.test.ts` both
 * assert that on a real job rather than trusting the sentence.
 */
export interface PrintJobRecord {
  id: string;
  boxId: string;
  /** One of `PRINT_KINDS`. Text here: the vocabulary belongs to `@oto/shared`. */
  kind: string;
  role: string | null;
  stationId: string | null;
  /** The printer the last attempt went to, so an interrupted job can name it. */
  deviceId: string | null;
  copies: number;
  job: RenderPrintJob;
  finish: Record<string, unknown> | null;
  templateId: string | null;
  templateVersion: number | null;
  actionId: string | null;
  state: BoxPrintJobState;
  attempts: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  queuedAt: string;
  updatedAt: string;
}

/** What an attempt changes about a stored job. Absent keys are left alone. */
export interface PrintJobPatch {
  state?: BoxPrintJobState;
  attempts?: number;
  nextAttemptAt?: string | null;
  deviceId?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
}

/**
 * The narrow view of the store that the print subsystem takes.
 *
 * Narrow on purpose: the printing side has no business reaching the outbox or
 * a station's lease, and a five-method port is a thing a test can stand in for
 * without building a database.
 */
export interface PrintJobStore {
  /**
   * Write the job down BEFORE anything is attempted. Insert or replace.
   *
   * The print subsystem calls this itself on `submit()`, so a service that
   * wrote the row inside its own transaction — a spin, whose facts, voucher,
   * print job and counter have to commit together — and then hands the same
   * job to `submit()` replaces its own row rather than creating a second one.
   * The job id is the fence, and it is the same id in both places.
   */
  putPrintJob(record: PrintJobRecord): Promise<void>;
  /** Everything still to do on this box, oldest first. */
  loadPendingPrintJobs(boxId: string): Promise<PrintJobRecord[]>;
  /**
   * Jobs the previous process was writing to a printer when it stopped.
   *
   * D12: these are NOT resumed. Bytes that reached the head are already paper
   * in somebody's hand, and an unattended retry puts a second voucher beside a
   * torn first one with nobody able to say which is the real one. They come
   * back so their failure can be reported, and then they are deleted.
   */
  loadInterruptedPrintJobs(boxId: string): Promise<PrintJobRecord[]>;
  updatePrintJob(id: string, patch: PrintJobPatch, now?: string): Promise<void>;
  deletePrintJob(id: string): Promise<void>;
}

// --- Booth runtime state (S2-07a) -------------------------------------------

/**
 * A counter the box keeps for one trading day.
 *
 * `businessDate` rather than a timestamp because every question asked of these
 * — how many spins today, how many of this prize today — is asked about the
 * park's trading day, which starts at `branch.business_day_start` and is not
 * midnight. The caller resolves the date; the store only counts.
 */
export interface CounterKey {
  scope: string;
  key: string;
  /** `YYYY-MM-DD`, from `businessDate()` in `@oto/shared`. */
  businessDate: string;
}

/** Who is signed in at a station, as the box remembers it across a restart. */
export interface BoxStaffSession {
  stationId: string;
  boxId: string;
  accountId: string;
  /** How they proved it: `pin`, `badge`, `password`. */
  credentialKind: string;
  /** The lookup value the sign-in resolved, where there is one. */
  staffCode: string | null;
  signedInAt: string;
  lastSeenAt: string;
  /** Null for a session that ends only when somebody signs out. */
  expiresAt: string | null;
}

/**
 * Failed attempts against one subject, counted on disk.
 *
 * On disk and not in memory, because a lockout a restart clears is not a
 * lockout: a booth in a mall is a kiosk anybody can reach the power lead of,
 * and "five wrong PINs, then wait" has to mean the same thing after somebody
 * has pulled the plug as before.
 *
 * The store counts and remembers; it does not decide. `lockedUntil` is written
 * by the caller that owns the policy — how many failures, how long, whether it
 * doubles — because that policy belongs to the service being defended and is
 * different for a booth PIN and a till password.
 */
export interface ThrottleRecord {
  boxId: string;
  scope: string;
  subject: string;
  failures: number;
  firstFailureAt: string;
  lastFailureAt: string;
  lockedUntil: string | null;
}

/**
 * What this store can actually do, as `init()` found it.
 *
 * Not a constant, because the two dialects genuinely differ: a Pi's SQLite file
 * is created by `prepareSqliteBoxStore` and always has every table, while the
 * `edge` schema of the platform database has only what the migrations have
 * created. A box whose tables are missing must say so rather than pretend — a
 * print queue that quietly forgets on restart is the defect this ticket exists
 * to fix, and a throttle that quietly forgets is a bypass.
 *
 * Before `init()` both are false, which is the safe answer to give.
 */
export interface BoxStoreFeatures {
  /** `box_print_job`: a job waiting on paper survives a restart. */
  printJobs: boolean;
  /** `box_counter`, `box_staff_session`, `box_throttle`, `box_runtime`. */
  boothRuntime: boolean;
  /**
   * `box_overlay`: the members, children and visits a counter recorded offline
   * (offline plan Round 3). Without it a counter box refuses those writes by
   * name rather than queue a fact its own lookup could not find again.
   */
  overlay: boolean;
}

/**
 * Raised when a caller asks for state this store has nowhere to keep.
 *
 * Thrown rather than swallowed. A daily cap that silently does not count, or a
 * sign-in throttle that silently does not lock, is worse than an outage,
 * because nothing about it looks wrong until somebody has been taking the
 * cash prize twice a day for a fortnight.
 */
export class BoxStoreFeatureMissingError extends Error {
  readonly feature: keyof BoxStoreFeatures;
  readonly missing: readonly string[];

  constructor(feature: keyof BoxStoreFeatures, missing: readonly string[]) {
    super(
      `This box store cannot keep ${feature}: ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } not in its database`,
    );
    this.name = 'BoxStoreFeatureMissingError';
    this.feature = feature;
    this.missing = missing;
  }
}

export interface BoxStore extends PrintJobStore {
  /**
   * Prepare the store and recover from however the last process ended.
   *
   * Anything left `sending` is put back to `queued`: the box was cut off
   * mid-push and does not know whether the cloud saw the batch. Re-sending is
   * always safe and never losing is not, because the dedupe on
   * `(box_id, journal_epoch, box_seq)` turns a re-send into `duplicate`.
   *
   * A print job left `sending` is recovered the other way — to `interrupted`,
   * never retried (D12). The two look alike and are opposites: an event the
   * cloud may already hold costs one deduplicated insert to send twice, and a
   * voucher the printer may already have cut costs a second voucher in
   * somebody's hand.
   */
  init(boxId: string): Promise<BoxStateRecord>;
  close(): Promise<void>;

  /** What this store can keep; see `BoxStoreFeatures`. Answered from `init()`. */
  features(): BoxStoreFeatures;
  /** The print port, or null when this store has nowhere durable to put a job. */
  printJobs(): PrintJobStore | null;

  /**
   * Run several writes as one unit: all of them, or none.
   *
   * A spin is the case this exists for. It queues two facts, mints a voucher,
   * writes a print job and moves a daily counter, and every half-landing of
   * that set is a real failure somebody would have to reconcile by hand — a
   * counter that moved for a spin with no voucher, a voucher with nothing to
   * print it, a print job for a spin the cloud will never hear about.
   *
   * The callback is handed a store bound to the transaction. Use THAT one;
   * the outer store's writes are not in the transaction. Nesting is safe and
   * joins the transaction already open rather than opening a second one.
   */
  atomically<T>(fn: (tx: BoxStore) => Promise<T>): Promise<T>;

  readState(boxId: string): Promise<BoxStateRecord>;
  setOffline(
    boxId: string,
    offline: boolean,
    opts?: { reason?: string | null; accountId?: string | null; now?: string },
  ): Promise<BoxStateRecord>;
  setClockSkew(boxId: string, clockSkewMs: number): Promise<BoxStateRecord>;
  /**
   * Stamp every event queued for this box with what `stamp` answers at that
   * moment (SCRUM-402), in place of the reading of `clockSkewMs` a store falls
   * back on.
   *
   * The agent installs it when it opens the store, because it is the agent
   * that measures the clock, and everything that queues a fact — the outbox,
   * the booth, the station sessions, the api's own routes for the virtual box
   * — goes through the store and gets the same stamp without having to ask.
   * In memory, per box, and shared by the store a transaction is handed. A
   * store no agent has stamped (the store's own tests, a tool that queues by
   * hand) keeps the older rule: `clockTrustFor(clockSkewMs)`. `null` removes
   * the stamp.
   */
  stampClockWith(boxId: string, stamp: (() => ClockStamp) | null): void;
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
  /**
   * Queue several facts as one: consecutive sequences, one transaction.
   *
   * A spin is `booth.spin_recorded` and `promo.voucher_issued`, and they must
   * not be able to half-land — a voucher the cloud has with no spin behind it
   * is a prize nobody can account for, and a spin with no voucher is a guest
   * holding a slip the park does not recognise. Sealing happens inside the
   * transaction, as it does for one fact, so a signing failure returns every
   * sequence it took and the journal keeps no gap.
   *
   * The records come back in the order the facts were given.
   */
  enqueueMany(
    boxId: string,
    facts: readonly QueuedFact[],
    seal: EnvelopeSealer,
    now?: string,
  ): Promise<OutboxRecord[]>;
  /**
   * The next events to send, oldest first, marked `sending`: queued or failed,
   * and due — never deferred, deferred to a time at or before `now`, or
   * deferred to a time further after `now` than `OUTBOX_BACKOFF_CAP_MS`, which
   * only a clock that has since gone back can have set (SCRUM-402).
   */
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

  // --- Booth runtime state (S2-07a) -----------------------------------------

  /** Add to a counter and return what it now reads. Creates it at zero first. */
  bumpCounter(boxId: string, key: CounterKey, by?: number, now?: string): Promise<number>;
  /** One counter's value, and zero for one that has never been touched. */
  readCounter(boxId: string, key: CounterKey): Promise<number>;
  /**
   * Every counter in one scope for one trading day, keyed by its `key`.
   *
   * This is what a daily cap is checked against: one read before the draw
   * rather than one read per prize, because eligibility is computed once per
   * press (D5) and a prize list that changed between two of those reads would
   * renormalise over a set that never existed.
   */
  readCounters(boxId: string, scope: string, businessDate: string): Promise<Record<string, number>>;

  readStaffSession(stationId: string): Promise<BoxStaffSession | null>;
  /** Sign somebody in at a station. One station holds one session. */
  writeStaffSession(session: BoxStaffSession): Promise<void>;
  /** Keep a session alive without changing who is in it. */
  touchStaffSession(stationId: string, now: string): Promise<void>;
  clearStaffSession(stationId: string): Promise<void>;

  readThrottle(boxId: string, scope: string, subject: string): Promise<ThrottleRecord | null>;
  /**
   * Count one failure and return the record as it now stands.
   *
   * `lockedUntil` is the caller's decision, taken with the new failure count
   * in hand — see `ThrottleRecord`. Passing `undefined` leaves whatever lock
   * is already on the row, so a policy that only locks on the fifth failure
   * does not have to clear the lock on the sixth.
   */
  recordThrottleFailure(
    boxId: string,
    scope: string,
    subject: string,
    opts?: { now?: string; lockedUntil?: string | null },
  ): Promise<ThrottleRecord>;
  /** A success wipes the count. */
  clearThrottle(boxId: string, scope: string, subject: string): Promise<void>;

  /**
   * Remember the latest time this box has good reason to believe in.
   *
   * A Pi with no clock battery comes back from a power cut with whatever time
   * it last saved — Raspberry Pi OS saves it every minute, so that is behind
   * by about the length of the cut — and a fresh card that never synced comes
   * back at the image's own date. Keeping the highest time already seen
   * catches the case where the clock is EARLIER than a time this box has
   * already lived through, which is wrong whatever it says and is part of what
   * `SpinResponse.clockSuspect` reports to the television. A clock behind by
   * the length of a cut is not earlier than anything lived through; what
   * catches that is the agent's measurement against the platform (SCRUM-402).
   *
   * Only ever moves forward. Returns the stored value after the write.
   */
  markTimeSeen(boxId: string, at: string): Promise<string>;
  lastGoodTime(boxId: string): Promise<string | null>;

  /**
   * A small value the box keeps for itself, by key (SCRUM-223).
   *
   * `box_runtime` already holds `last_good_time`; these two open it to the
   * booth's other singletons — the last vouchers it printed, so a reprint
   * after a power cut still has the slip to reprint, and the name of whoever
   * is signed in — and, one key per code, to every voucher code the booth
   * has minted, so a repeat is drawn again (SCRUM-414) — and to the agent's
   * last measurement of its clock, with the boot it was made in (SCRUM-402).
   * Text in, text out: the caller owns the encoding. The key
   * `last_good_time` is `markTimeSeen`'s, whose forward-only rule a plain
   * write would break, so it is refused here.
   */
  readRuntimeValue(boxId: string, key: string): Promise<string | null>;
  writeRuntimeValue(boxId: string, key: string, value: string, now?: string): Promise<void>;

  // --- The offline overlay (offline plan Round 3) -----------------------------

  /**
   * Record, or replace, what this counter now knows about one member, child or
   * visit it wrote offline. Written in the same transaction as the fact that
   * carries it to the platform (`atomically`), so a lookup and the outbox
   * cannot disagree about whether it happened.
   */
  putOverlay(boxId: string, write: OverlayWrite, now?: string): Promise<void>;
  readOverlay(boxId: string, kind: BoxOverlayKind, entityId: string): Promise<OverlayRecord | null>;
  /** Rows of one kind, by the phone a member row carries or the guardian a child or visit row names. */
  listOverlay(
    boxId: string,
    where: { kind: BoxOverlayKind; phone?: string; memberIds?: readonly string[] },
  ): Promise<OverlayRecord[]>;
  /** Every row this box holds, oldest first: what a prune after a pull walks. */
  allOverlay(boxId: string): Promise<OverlayRecord[]>;
  deleteOverlay(
    boxId: string,
    keys: ReadonlyArray<{ kind: BoxOverlayKind; entityId: string }>,
  ): Promise<number>;
  /**
   * Where these events stand in the outbox: queued, sending, acked (and
   * when), quarantined. An id the outbox no longer holds is absent from the
   * answer. What an overlay prune asks before it lets the cache speak for a
   * record again.
   */
  outboxStates(
    boxId: string,
    eventIds: readonly string[],
  ): Promise<Map<string, { state: OutboxState; ackedAt: string | null }>>;
}

// --- The offline overlay ------------------------------------------------------

/**
 * What a counter keeps offline. `member`, `child`, `visit` since offline plan
 * Round 3; the check-in domain's four since S2-13 round 4 (plan §2.5): a
 * registration, a stay, a person on a pickup list and a release. Their
 * `memberId` column carries the REGISTRATION's id (`member` on a registration
 * row), so one family's rows are listed together; `phone` is null on all four.
 * Migration 0044 widens the platform's twin; `prepareSqliteBoxStore` rebuilds
 * a Pi's table that predates them.
 */
export const BOX_OVERLAY_KINDS = [
  'member',
  'child',
  'visit',
  'registration',
  'checkin',
  'guardian',
  'release',
] as const;
export type BoxOverlayKind = (typeof BOX_OVERLAY_KINDS)[number];

/** What a producer writes. `record` is the entity as this counter now knows it. */
export interface OverlayWrite {
  kind: BoxOverlayKind;
  entityId: string;
  /** The guardian on a child or visit; the member itself on a member row. */
  memberId: string | null;
  /** E.164 on a member row, null otherwise. */
  phone: string | null;
  record: Record<string, unknown>;
  /** The fact that last changed it, so a prune can ask whether the platform has it. */
  eventId: string | null;
}

export interface OverlayRecord extends OverlayWrite {
  boxId: string;
  createdAt: string;
  updatedAt: string;
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
 * The longest the outbox ever defers an event: five minutes, `backoffMs`'s
 * cap. Every retry time is the box's clock plus at most this, so one further
 * off than this from the clock now was set by a clock that has since gone
 * back — a box that booted hours ahead, deferred a push before it heard the
 * platform, and then measured itself against it (SCRUM-402). `takeBatch`
 * treats such a time as due: waiting for it would hold those facts back for
 * as long as the clock had been out. A caller that deferred for longer on
 * purpose would be sent early by that rule; none does.
 */
export const OUTBOX_BACKOFF_CAP_MS = 300_000;

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
  const cap = opts?.capMs ?? OUTBOX_BACKOFF_CAP_MS;
  const bounded = Math.min(cap, base * 2 ** Math.max(0, attempts - 1));
  return Math.round(bounded / 2 + Math.random() * (bounded / 2));
}
