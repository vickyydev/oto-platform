import {
  SYNC_PUSH_MAX_BYTES,
  SYNC_PUSH_MAX_EVENTS,
  type SyncPushRequest,
  type SyncPushResponse,
} from './contract';
import { sealEnvelope } from './signing';
import {
  backoffMs,
  type BoxStore,
  type OutboxDepth,
  type OutboxRecord,
  type QueuedFact,
} from './store';
import { silentLog, type AgentLog } from './transport';

/**
 * The durable outbox (S2-05).
 *
 * The rule the whole thing exists for: **a fact is on disk before the person
 * who caused it is told it worked.** Everything after that — batching,
 * backoff, the cursor — is about getting it to the cloud eventually, and
 * "eventually" is allowed to be tomorrow. What is not allowed is losing it.
 *
 * Idempotency is not bolted on here, it is the shape: every event carries
 * `(box_id, journal_epoch, box_seq)`, the cloud holds a unique index on that
 * triple, and so a re-send is a `duplicate` rather than a second member. That
 * is why the box may always re-send when it is unsure, and it is unsure often
 * — a lost acknowledgement looks exactly like a lost request from this side.
 */

export interface PushTransport {
  (request: SyncPushRequest): Promise<{ status: number; body: SyncPushResponse | null }>;
}

export interface OutboxOptions {
  store: BoxStore;
  boxId: string;
  push: PushTransport;
  /** The private half of the box's signing key, or null before registration. */
  privateKey: () => string | null;
  /** Read fresh each tick, so the Console's toggle reaches a box mid-flight. */
  isOffline: () => Promise<boolean>;
  maxEvents?: number;
  maxBytes?: number;
  intervalMs?: number;
  now?: () => Date;
  log?: AgentLog;
  /** Called when the cloud reports an epoch this box is not on. */
  onEpoch?: (epoch: number) => void;
}

export type FlushOutcome =
  | { state: 'offline' }
  | { state: 'empty' }
  | { state: 'not_registered' }
  | { state: 'deferred'; events: number; errorCode: string }
  | {
      state: 'pushed';
      events: number;
      applied: number;
      duplicates: number;
      quarantined: number;
      rejected: number;
      cursorSeq: number;
      batchId: string;
    };

export interface Outbox {
  /** Queue a fact. It is on disk when this resolves. */
  queue(fact: QueuedFact): Promise<OutboxRecord>;
  /** Send one bounded batch. Safe to call concurrently; the second call is a no-op. */
  flush(): Promise<FlushOutcome>;
  depth(): Promise<OutboxDepth>;
  /** The Console's "Replay last batch": put the last N acked events back. */
  replayLastBatch(limit?: number): Promise<number>;
  start(): void;
  stop(): void;
}

export function createOutbox(options: OutboxOptions): Outbox {
  const {
    store,
    boxId,
    push,
    privateKey,
    isOffline,
    maxEvents = SYNC_PUSH_MAX_EVENTS,
    maxBytes = SYNC_PUSH_MAX_BYTES,
    intervalMs = 5_000,
    onEpoch,
  } = options;
  const clock = options.now ?? (() => new Date());
  const log = options.log ?? silentLog;
  let timer: ReturnType<typeof setInterval> | null = null;
  // One flush at a time. Two overlapping pushes would each take a batch and
  // the second would send events the first has already marked `sending`,
  // doubling the work for no gain — the cloud would dedupe them, but the box
  // would have spent a mall's uplink saying the same thing twice.
  let inFlight: Promise<FlushOutcome> | null = null;

  async function queue(fact: QueuedFact): Promise<OutboxRecord> {
    const key = privateKey();
    if (!key) {
      throw new Error('This box has no signing key yet; it cannot queue a fact');
    }
    return store.enqueue(
      boxId,
      fact,
      (draft) => sealEnvelope(draft, boxId, key),
      clock().toISOString(),
    );
  }

  async function flushOnce(): Promise<FlushOutcome> {
    if (!privateKey()) return { state: 'not_registered' };
    if (await isOffline()) return { state: 'offline' };

    const nowIso = clock().toISOString();
    const batch = await store.takeBatch(boxId, { maxEvents, maxBytes, now: nowIso });
    if (batch.events.length === 0) return { state: 'empty' };

    const ids = batch.events.map((event) => event.eventId);
    // What the box believes the cloud already has: everything below the oldest
    // event still queued. The cloud does not trust it — its own cursor is the
    // authority — but a disagreement is worth an anomaly, because it means one
    // of the two stores lost something.
    const cursorSeq = Math.max(0, (batch.events[0]?.boxSeq ?? 1) - 1);

    let response: { status: number; body: SyncPushResponse | null };
    try {
      response = await push({ events: batch.events, cursorSeq });
    } catch (error) {
      // The link went. The events go back on the queue with a backoff, and
      // nothing is lost — this is the ordinary weather of a shopping mall.
      await defer(ids, 'PUSH_FAILED', String(error));
      return { state: 'deferred', events: ids.length, errorCode: 'PUSH_FAILED' };
    }

    if (response.status !== 200 || !response.body) {
      const code = `PUSH_${response.status}`;
      await defer(ids, code, `The cloud answered ${response.status}`);
      return { state: 'deferred', events: ids.length, errorCode: code };
    }

    const body = response.body;
    // `sent` fences the settle: this answer may only move the rows this batch
    // handed over, whatever ids it names and wherever its cursor has got to.
    await store.settle(boxId, body.results, {
      sent: ids,
      cursorSeq: body.cursorSeq,
      now: clock().toISOString(),
      retryAt: (attempts) => new Date(clock().getTime() + backoffMs(attempts)).toISOString(),
    });

    const state = await store.readState(boxId);
    if (body.epoch !== state.journalEpoch) {
      // The cloud has moved the journal on — a `reset_store` somebody pressed
      // on the Console. Adopting it is right and the events still queued from
      // the old epoch are NOT quietly dropped: they go up, come back
      // `epoch_regressed`, and land on Failures where a person decides.
      log.warn(
        { boxId, localEpoch: state.journalEpoch, cloudEpoch: body.epoch, module: 'outbox' },
        'the cloud is on a different journal epoch; adopting it',
      );
      await store.setEpoch(boxId, body.epoch, clock().toISOString());
      onEpoch?.(body.epoch);
    }

    return {
      state: 'pushed',
      events: batch.events.length,
      applied: body.applied,
      duplicates: body.duplicates,
      quarantined: body.quarantined,
      rejected: body.rejected,
      cursorSeq: body.cursorSeq,
      batchId: body.batchId,
    };
  }

  async function defer(ids: string[], errorCode: string, errorMessage: string): Promise<void> {
    const depth = await store.depth(boxId);
    await store.releaseBatch(boxId, ids, {
      errorCode,
      errorMessage,
      // Backed off by how deep the queue is rather than by how many times this
      // batch failed: a box that has been away for a day should not hammer the
      // api the instant the link flickers.
      retryAt: new Date(
        clock().getTime() + backoffMs(Math.min(8, Math.ceil(depth.queued / 50) + 1)),
      ).toISOString(),
    });
  }

  function flush(): Promise<FlushOutcome> {
    if (inFlight) return inFlight;
    inFlight = flushOnce().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    queue,
    flush,
    depth: () => store.depth(boxId),
    replayLastBatch: (limit = 50) => store.requeueAcked(boxId, limit),
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void flush().catch((error: unknown) => {
          log.error({ err: String(error), boxId, module: 'outbox' }, 'outbox tick failed');
        });
      }, intervalMs);
      // A pending timer must never be the reason a process cannot exit.
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
