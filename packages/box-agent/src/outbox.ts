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
  /**
   * SCRUM-486 — the one adoption path of the agent that owns this outbox,
   * which every answer naming the platform's epoch goes through (heartbeat,
   * config, command acknowledgement, push). When it is given, a push answer is
   * handed to it and the outbox writes no epoch of its own; without it the
   * outbox adopts a NEWER epoch itself, and never an older one.
   */
  adoptEpoch?: (epoch: number) => Promise<unknown>;
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
  /**
   * Queue several facts as ONE: consecutive sequences, one transaction, all of
   * them or none (S2-10a).
   *
   * A sale is the case this exists for. Its money and the sale it paid for must
   * not be able to half-land — a tender in the cloud with no sale behind it is
   * money nobody can account for, and a sale with no tender is a receipt the
   * park thinks was never paid. `store.enqueueMany` seals inside the
   * transaction, so a signing failure hands every sequence back and the journal
   * keeps no gap.
   */
  queueAll(facts: readonly QueuedFact[]): Promise<OutboxRecord[]>;
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
    adoptEpoch,
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

  async function queueAll(facts: readonly QueuedFact[]): Promise<OutboxRecord[]> {
    const key = privateKey();
    if (!key) {
      throw new Error('This box has no signing key yet; it cannot queue a fact');
    }
    if (facts.length === 0) return [];
    return store.enqueueMany(
      boxId,
      facts,
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

    if (adoptEpoch) {
      await adoptEpoch(body.epoch);
    } else {
      const state = await store.readState(boxId);
      if (body.epoch > state.journalEpoch) {
        // The cloud has moved the journal on — a `reset_store` somebody pressed
        // on the Console. Adopting it is right and the events still queued from
        // the old epoch are NOT quietly dropped: they go up, come back
        // `epoch_regressed`, and land on Failures where a person decides.
        log.warn(
          { boxId, localEpoch: state.journalEpoch, cloudEpoch: body.epoch, module: 'outbox' },
          'the cloud is on a newer journal epoch; adopting it',
        );
        // A compare-and-set (SCRUM-486): another adoption may have moved the
        // store since the read above and a fact been sealed at (epoch, 1).
        const moved = await store.advanceEpoch(boxId, body.epoch, 'newer', clock().toISOString());
        if (moved.moved) onEpoch?.(body.epoch);
      } else if (body.epoch < state.journalEpoch) {
        // Never backwards (SCRUM-486): an older epoch would restart the
        // sequence on addresses the cloud may already hold.
        log.error(
          { boxId, localEpoch: state.journalEpoch, cloudEpoch: body.epoch, module: 'outbox' },
          'the cloud named an OLDER journal epoch than this store holds; not adopted',
        );
      }
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
    queueAll,
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

// --- A sale taken with no internet (S2-10a, Slice G) -------------------------

/**
 * THE TWO FACTS A SALE TRAVELS AS, and why there are two.
 *
 * `sale.finalised` is the whole thing — the cart and every tender that closed
 * it — in one event, because the sale and its money either both reach the
 * ledger or neither does. `payment.recorded` is for money that genuinely comes
 * later: the second half of a split tender taken after the first was pushed, a
 * terminal that answered minutes after the till gave up, a PAX QR the guest
 * paid while the sale sat open. The cloud refuses the second when its sale is
 * not there yet rather than filing money against nothing, so a box that can
 * send them in one batch should.
 *
 * Both names are the cloud's handler keys (`HANDLERS` in
 * `apps/api/src/services/sync.ts`); an api too old to know them answers
 * `unknown_type` and the event lands in quarantine with its payload intact,
 * which is survivable and visible.
 */
export const SALE_FINALISED = 'sale.finalised';
export const PAYMENT_RECORDED = 'payment.recorded';

/**
 * One tender, as the box took it.
 *
 * `methodCode` is the park's own token for the tender and `kind` is what kind
 * of money it is — the prototype's rule, ported: behaviour keys off the kind
 * and never off the token, so a park renaming "PromptPay" changes a label and
 * nothing else. The cloud resolves the token against its own tender list and
 * falls back to the kind for one it has no row for.
 *
 * A CARD TENDER CARRIES WHAT THE TERMINAL SAID and nothing more: the approval
 * code, four digits, the identities and the references. The box's own parser
 * has already reduced the masked PAN to `last4` and dropped the cardholder
 * name (`terminal/`), so there is nothing here that a queue file on a Pi in a
 * storeroom should not hold.
 */
export interface OfflineTenderFact {
  /** `x-oto-action-id` — the press. The cloud's replay key; one per tender. */
  actionId: string;
  methodCode: string;
  kind?: 'cash' | 'card' | 'qr' | 'other';
  provider?: 'simulator' | 'ghl' | 'digio' | '2c2p' | 'manual';
  amountSatang: number;
  /** Cash only: what was handed over, and what went back. */
  tenderedSatang?: number;
  changeSatang?: number;
  /**
   * `awaiting_settlement` for money taken on the terminal's own connection —
   * a PAX QR (Digio `A18`/`A3`), which the acquirer settles without the
   * platform ever seeing a gateway notification. It is money that is OURS, so
   * it closes the sale; what is unsettled about it is the reconciliation.
   */
  status?: 'approved' | 'awaiting_settlement';
  deviceId?: string | null;
  terminalRef?: string | null;
  tranRef?: string | null;
  invoiceNo?: string | null;
  approvalCode?: string | null;
  last4?: string | null;
  tid?: string | null;
  mid?: string | null;
  responseCode?: string | null;
  paidAt?: string;
  reference?: string | null;
  /**
   * OD-3 — a GHL card sale that gave no answer, which that dialect cannot be
   * asked about: staff read the terminal's own screen and typed its approval
   * code. The money is recorded as taken, named on the person who said so,
   * and flagged for end-of-day reconciliation against the terminal's slips.
   */
  staffConfirmation?: {
    accountId: string;
    at: string;
    approvalCode: string;
    note?: string | null;
  } | null;
}

/**
 * The receipt number the box printed and the guest holds (OD-4). The cloud
 * files the sale under it when it is free in the station's series, and under
 * the next free number — both named — when it is not.
 */
export interface OfflineReceiptFact {
  series: string;
  seq: number;
  number: string;
}

/**
 * A band the box minted for the sale (OD-13): its id and signed code, the
 * cart line it admits against and the ledger line that is (`deriveSaleLineId`),
 * and the child it names. The cloud records it as it is and mints nothing.
 */
export interface OfflineBandFact {
  id: string;
  code: string;
  kind: 'kid' | 'adult';
  cartLineId: string;
  saleLineId: string | null;
  childId: string | null;
  /**
   * Whether the band operates the entrance gate, from its line's ticket
   * package in the box's catalogue (SCRUM-494). Never on a kids band.
   */
  gateAccess?: boolean;
}

export interface OfflineSaleFact {
  /** Minted at the till, so a re-send finds the sale rather than writing a second. */
  saleId: string;
  stationId: string;
  /** Who took the money. The cloud refuses a sale that names nobody. */
  actorAccountId: string;
  /**
   * The cart, exactly as the till composed it.
   *
   * OPAQUE TO THE BOX, on purpose — with ONE field named. The box does not
   * price and must never start: the pricing engine, the tax rules, the tier and
   * the trading day all live in the cloud, and a second implementation on a Pi
   * would be a second answer to "what does this cost" that nobody would notice
   * diverging. What travels is what was sold; what it costs is re-priced on
   * arrival.
   *
   * `expectedTotalSatang` is the exception and it is required here for the
   * reason it is required on the cloud's own schema: it is what the till
   * believed it was charging, the cloud compares it and refuses the event on a
   * disagreement, and a box that could leave it out would be a box whose sales
   * are banked at a price only one end ever computed. Naming it costs the box
   * nothing — it does not read it — and it means a till that forgot it is a
   * type error here rather than a quarantined sale in Phuket.
   */
  cart: Record<string, unknown> & { expectedTotalSatang: number };
  /** Every tender that closed the sale. Empty for a ฿0 comp, which owes nothing. */
  tenders: readonly OfflineTenderFact[];
  receipt?: OfflineReceiptFact | null;
  /** The bands minted on the box for the sale's tickets (Round 4). */
  bands?: readonly OfflineBandFact[];
  /** The catalogue version the box priced the cart from (OD-8). */
  catalogueVersion?: string | null;
  /** The prices it priced from, so an older catalogue's price can be filed as taken (OD-8). */
  priceBasis?: Record<string, unknown> | null;
  /** The offline staff token the box verified, by its `jti`, where one was used. */
  staffTokenJti?: string | null;
  /** Taken under a fresh offline sign-in with no live token (OD-6). */
  offlineFresh?: boolean;
  /** The till's clock when the sale was rung up. The cloud weighs it against the box's skew. */
  occurredAt?: string;
  actionId?: string | null;
}

/** The whole sale as one queued fact. */
export function saleFinalisedFact(sale: OfflineSaleFact): QueuedFact {
  return {
    type: SALE_FINALISED,
    stationId: sale.stationId,
    actorKind: 'account',
    actorAccountId: sale.actorAccountId,
    actionId: sale.actionId ?? null,
    ...(sale.occurredAt ? { occurredAt: sale.occurredAt } : {}),
    payload: {
      saleId: sale.saleId,
      cart: sale.cart,
      tenders: sale.tenders.map((tender) => ({ ...tender })),
      receipt: sale.receipt ?? null,
      staffTokenJti: sale.staffTokenJti ?? null,
      ...(sale.offlineFresh ? { offlineFresh: true } : {}),
      ...(sale.bands && sale.bands.length > 0 ? { bands: sale.bands.map((band) => ({ ...band })) } : {}),
      ...(sale.catalogueVersion !== undefined ? { catalogueVersion: sale.catalogueVersion } : {}),
      ...(sale.priceBasis ? { priceBasis: sale.priceBasis } : {}),
    },
  };
}

/** A tender against a sale that has already been queued or pushed. */
export function paymentRecordedFact(input: {
  saleId: string;
  stationId: string;
  actorAccountId: string;
  tender: OfflineTenderFact;
  occurredAt?: string;
  actionId?: string | null;
}): QueuedFact {
  return {
    type: PAYMENT_RECORDED,
    stationId: input.stationId,
    actorKind: 'account',
    actorAccountId: input.actorAccountId,
    actionId: input.actionId ?? input.tender.actionId,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    payload: { saleId: input.saleId, tender: { ...input.tender } },
  };
}
