import {
  STATION_LANGUAGES,
  STATION_LEASE_TTL_S,
  STATION_SESSION_STAGES,
  type StationChannelMessage,
  type StationIntent,
  type StationIntentRefusal,
  type StationLanguage,
  type StationLease,
  type StationLeaseHolderKind,
  type StationScanMessage,
  type StationSessionDocument,
  type StationSessionStage,
  type StationView,
} from './contract';
import { uuidv7 } from './signing';
import type {
  BoxStore,
  QueuedFact,
  SessionWrite,
  StationEventSource,
  StationIdentity,
} from './store';
import { silentLog, type AgentLog } from './transport';

/**
 * The station session: one document, one writer, full snapshots (S2-05).
 *
 * In the park a till and a customer display are two devices, and the thing
 * between them is this document. The box owns it and is its only writer;
 * both screens receive a FULL SNAPSHOT after every change. Snapshots rather
 * than patches because the document is small and a screen that reconnects is
 * correct again after one message — nothing can drift, and a display that was
 * unplugged for an hour needs no catch-up protocol.
 *
 * Three ideas carry the whole file:
 *
 *   - **The lease is a fencing token, not a timer.** A till that was displaced
 *     and has not noticed is refused because the value it quotes is not the
 *     value on the row — a check that does not depend on two clocks agreeing.
 *     The 60-second TTL only decides when an ABANDONED lease becomes free, and
 *     even that decision is re-tested INSIDE the compare-and-set: a renewal
 *     keeps its lease id, so a claim that read an expired row quotes both the
 *     id and the expiry, or it would displace a till whose heartbeat landed
 *     while it was deciding.
 *   - **The token fences; the ACCOUNT authorises.** The lease id travels on
 *     the document, and the document goes to every screen allowed to read the
 *     station. So quoting it proves only that you can read the station, which
 *     every watcher can — it separates a current till from a displaced one and
 *     nothing more. What decides whether a caller may USE the lease is the
 *     account it was claimed by, which comes from the session and never from a
 *     request body, so it cannot be copied off a snapshot. `heldBy` below is
 *     that check, and renew, release and every lease-bearing intent run it.
 *   - **An observer is a first-class case.** The customer display and a
 *     manager watching from the Console hold no lease and receive every
 *     snapshot. The display may send the narrow set of intents a display is
 *     allowed; the Console may send none at all — a `console` source matches
 *     no spec below. Its one power over a live station is a takeover, which is
 *     a claim, carries a name, and is audited as `station.takeover`.
 */

export type IntentOutcome =
  { ok: true; write: SessionWrite } | { ok: false; refusal: StationIntentRefusal; message: string };

export interface IntentContext {
  document: StationSessionDocument;
  intent: StationIntent;
  source: StationEventSource;
  accountId: string | null;
}

export interface IntentSpec {
  /** Stages this intent is valid at. Absent means any stage. */
  stages?: readonly StationSessionStage[];
  /** Who may send it. A display sending a till's intent is `not_permitted`. */
  sources: readonly StationEventSource[];
  /** False for the display's own intents, which are sent with no lease held. */
  requiresLease: boolean;
  apply(ctx: IntentContext): IntentOutcome;
}

export interface StationSessionManagerOptions {
  store: BoxStore;
  boxId: string;
  /** Where a station's operator and branch come from: the config bundle. */
  resolveStation(stationId: string): StationIdentity | null;
  /** Queues a fact for the cloud. `station.takeover` is the one minted here. */
  queueFact?(fact: QueuedFact): Promise<void>;
  now?: () => Date;
  log?: AgentLog;
}

export interface ClaimRequest {
  stationId: string;
  /** An opaque per-client id — a browser tab, not a person. */
  holder: string;
  holderKind: StationLeaseHolderKind;
  accountId?: string | null;
  /** A manager displacing a LIVE lease. Audited as `station.takeover`. */
  takeover?: boolean;
  actionId?: string | null;
}

export type ClaimResult =
  | { ok: true; document: StationSessionDocument; lease: StationLease; takenOver: boolean }
  | { ok: false; refusal: StationIntentRefusal; message: string; document: StationSessionDocument };

/**
 * Who is asking, for the lease calls that are not a claim.
 *
 * One field and an object around it, because the alternative is a nullable
 * string in the third position of `release` — and the day somebody passes the
 * action id there instead, every caller becomes the anonymous one and the
 * check below silently stops checking.
 */
export interface LeaseCaller {
  /** Taken from the session by the caller. Null where nobody is signed in. */
  accountId: string | null;
}

export type ReleaseResult =
  | { ok: true; released: boolean }
  | { ok: false; refusal: StationIntentRefusal; message: string; document: StationSessionDocument };

/**
 * Whether this caller is the one the lease was granted to.
 *
 * Plain equality, including when both sides are null: a booth or a kiosk
 * claims its own station with nobody signed in, and a lease like that is
 * usable only by another caller who also names nobody. The api is never in
 * that position — every station route there runs behind a session — so every
 * lease it writes carries an account and only that account can drive it.
 *
 * This is safe to check on a READ and then write against the lease id alone,
 * because a lease id keeps one account for its whole life: `claim` reuses an
 * id only when renewing, which requires the same account, `renew` copies the
 * lease it read, and everything else mints a new id.
 */
function heldBy(lease: StationLease, accountId: string | null): boolean {
  return lease.accountId === accountId;
}

/** Said to a till that is standing at the station but is not the lease holder. */
const NOT_THE_HOLDER = 'Another till is holding this station. A manager can take it over.';

export type IntentResult =
  | { ok: true; document: StationSessionDocument }
  | {
      ok: false;
      refusal: StationIntentRefusal;
      message: string;
      document: StationSessionDocument | null;
    };

interface Subscriber {
  stationId: string;
  view: StationView;
  send(message: StationChannelMessage): void;
}

export class StationSessionManager {
  private readonly store: BoxStore;
  private readonly boxId: string;
  private readonly resolveStation: (stationId: string) => StationIdentity | null;
  private readonly queueFact: ((fact: QueuedFact) => Promise<void>) | null;
  private readonly clock: () => Date;
  private readonly log: AgentLog;
  private readonly intents = new Map<string, IntentSpec>();
  private readonly subscribers = new Set<Subscriber>();

  constructor(options: StationSessionManagerOptions) {
    this.store = options.store;
    this.boxId = options.boxId;
    this.resolveStation = options.resolveStation;
    this.queueFact = options.queueFact ?? null;
    this.clock = options.now ?? (() => new Date());
    this.log = options.log ?? silentLog;
    for (const [type, spec] of Object.entries(BUILT_IN_INTENTS)) this.intents.set(type, spec);
  }

  /**
   * Later tickets add intents here rather than editing this file. The money
   * path owns `cart.*` and `payment.*`, the booth owns its own; each is a
   * registration, not a branch in a switch that grows to forty cases.
   */
  register(type: string, spec: IntentSpec): void {
    this.intents.set(type, spec);
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private identity(stationId: string): StationIdentity {
    const identity = this.resolveStation(stationId);
    if (!identity) {
      throw new Error(`Station ${stationId} is not on this box's config bundle`);
    }
    return identity;
  }

  /** The document as it stands, creating the row on first use. */
  async open(stationId: string): Promise<StationSessionDocument> {
    return this.store.ensureSession(this.identity(stationId), this.nowIso());
  }

  /**
   * Watch a station. An observer never holds a lease and is never asked to
   * prove anything beyond which view it is allowed — the redaction is applied
   * on the way out of the box, once, so no screen is trusted to hide anything.
   */
  subscribe(
    stationId: string,
    view: StationView,
    send: (message: StationChannelMessage) => void,
  ): () => void {
    const subscriber: Subscriber = { stationId, view, send };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * How many screens this MANAGER is fanning snapshots out to.
   *
   * Not the number the api's `/ready` reports: that one is counted where the
   * stream is opened and closed (`lib/station-channel.ts`), because a
   * connection is a property of the process holding it and the api may be
   * managing a box whose screens are attached to a different instance. This is
   * the box's own view, and what the tests assert a subscription against.
   */
  subscriberCount(stationId?: string): number {
    if (!stationId) return this.subscribers.size;
    let n = 0;
    for (const subscriber of this.subscribers) if (subscriber.stationId === stationId) n += 1;
    return n;
  }

  snapshotFor(document: StationSessionDocument, view: StationView, actionId: string | null) {
    return {
      kind: 'snapshot' as const,
      view,
      document: view === 'customer' ? redactForCustomer(document) : document,
      actionId,
      serverTime: this.nowIso(),
    };
  }

  private broadcast(document: StationSessionDocument, actionId: string | null): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.stationId !== document.stationId) continue;
      try {
        subscriber.send(this.snapshotFor(document, subscriber.view, actionId));
      } catch (error) {
        // One dead socket must not stop the other screen being told. The
        // transport removes it on its own close; this is only about the tab
        // that is still there.
        this.log.warn(
          { err: String(error), module: 'station-session' },
          'a station subscriber threw',
        );
      }
    }
  }

  /**
   * Fan a scan out to the screens watching this station (S2-06).
   *
   * Not a snapshot: a scan does not change the document — what it CAUSES will,
   * through the intent its handler sends — and a screen that missed one has
   * missed a moment rather than fallen behind. So it carries no sequence and
   * nothing rehydrates from it.
   *
   * `detail` is the handler's own answer and the one part of the message that
   * can name a person, so the customer display gets it through the same
   * key-stripping the document goes through. The fingerprint and the outcome
   * are safe for any screen: neither opens anything.
   */
  emitScan(stationId: string, message: StationScanMessage): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.stationId !== stationId) continue;
      const forView: StationScanMessage =
        subscriber.view === 'customer' ? { ...message, detail: stripKeys(message.detail) } : message;
      try {
        subscriber.send(forView);
      } catch (error) {
        /* see broadcast: one dead socket must not stop the other screen */
        this.log.warn(
          { err: String(error), module: 'station-session' },
          'a station subscriber threw on a scan',
        );
      }
    }
  }

  private emitLease(
    stationId: string,
    lease: StationLease | null,
    takenOver: boolean,
    displacedLeaseId: string | null,
  ): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.stationId !== stationId) continue;
      try {
        subscriber.send({ kind: 'lease', lease, takenOver, displacedLeaseId });
      } catch {
        /* see broadcast */
      }
    }
  }

  // --- The lease ------------------------------------------------------------

  async claim(request: ClaimRequest): Promise<ClaimResult> {
    const now = this.clock();
    const nowIso = now.toISOString();
    const current = await this.open(request.stationId);
    const held = current.lease;
    const live = held !== null && Date.parse(held.expiresAt) > now.getTime();

    /** One place to refuse from: the tape gets the line, the caller gets the row. */
    const refuse = async (
      refusal: StationIntentRefusal,
      message: string,
      document: StationSessionDocument,
      leaseId: string | null,
    ): Promise<ClaimResult> => {
      await this.store.recordStationEvent(
        {
          stationId: request.stationId,
          boxId: this.boxId,
          kind: 'lease',
          source: sourceForKind(request.holderKind),
          leaseId,
          outcome: 'refused',
          errorCode: refusal,
          actorAccountId: request.accountId ?? null,
          actionId: request.actionId ?? null,
        },
        nowIso,
      );
      return { ok: false, refusal, message, document };
    };

    /**
     * What makes a claim a RENEWAL rather than a second till arriving.
     *
     * The holder string says which screen the lease is for. It is published on
     * the document, so on its own it is something anybody watching can type
     * back: a till refused the takeover could read the holder off a snapshot,
     * send it as its own, and be handed the live lease as a renewal — no
     * displacement recorded, no manager asked, `takenOver: false`. The account
     * closes that, because it comes from the session and cannot be copied.
     *
     * So the same person's second tab, or a tab that reloaded, renews; anybody
     * else arriving is a second till and needs the manager gate, whatever
     * holder string they send.
     */
    const sameScreen =
      held !== null && held.holder === request.holder && heldBy(held, request.accountId ?? null);

    if (live && !sameScreen && !request.takeover) {
      return refuse(
        'no_lease',
        'Another till is using this station. A manager can take it over.',
        current,
        held.leaseId,
      );
    }

    if (live && !sameScreen && !request.accountId) {
      /**
       * A takeover is one person displacing another mid-sale, and it is the
       * one thing in this file that must have a name on it: the fact it
       * queues is what somebody reads a week later when they ask who moved
       * the sale. A request carrying no account is refused rather than
       * audited as "somebody". The CALLER's permission to do it is checked
       * where the session is — `pos:station:takeover` on the api's claim
       * route — because this file has no idea what an account may do.
       */
      return refuse(
        'not_permitted',
        'A takeover has to be somebody: sign in before taking a live till.',
        current,
        held.leaseId,
      );
    }

    const renewing = live && sameScreen;
    const lease: StationLease = {
      leaseId: renewing ? held.leaseId : uuidv7(now.getTime()),
      holder: request.holder,
      holderKind: request.holderKind,
      accountId: request.accountId ?? null,
      startedAt: renewing ? held.startedAt : nowIso,
      heartbeatAt: nowIso,
      expiresAt: new Date(now.getTime() + STATION_LEASE_TTL_S * 1000).toISOString(),
    };

    const takenOver = live && !renewing;
    const document = await this.store.applyLease(
      request.stationId,
      /**
       * Quoting the lease we just read, even when a manager is taking it by
       * force: if it moved between the read and the write, the manager's
       * takeover would displace somebody they never saw.
       *
       * And when the lease looked ABANDONED, the expiry goes into the same
       * compare-and-set. `live` above was decided on a row read a moment ago,
       * and a renewal keeps its lease id on purpose — so the id alone cannot
       * tell "still expired" from "renewed while we were deciding", and the
       * till that renewed would lose its station mid-sale. This is the one
       * place the 60-second TTL is allowed to decide anything, and it decides
       * it inside the write.
       */
      held
        ? { leaseId: held.leaseId, ...(live ? {} : { expiredBefore: nowIso }) }
        : { leaseId: null },
      { lease, incrementTakeover: takenOver },
      nowIso,
    );

    if (!document) {
      const fresh = await this.open(request.stationId);
      const stillHeld = fresh.lease;
      const stillLive = stillHeld !== null && Date.parse(stillHeld.expiresAt) > now.getTime();
      // The ordinary way this happens is the race the expiry check above
      // exists for: this claim judged the lease abandoned, its holder's
      // heartbeat landed, and the write found a lease that is alive after all.
      // "Somebody else claimed it" would send whoever is at this till looking
      // for a colleague who never moved.
      const stillSameScreen =
        stillHeld !== null &&
        stillHeld.holder === request.holder &&
        heldBy(stillHeld, request.accountId ?? null);
      if (stillLive && !stillSameScreen) {
        return refuse(
          'no_lease',
          'Another till is still working this station. A manager can take it over.',
          fresh,
          stillHeld.leaseId,
        );
      }
      return refuse(
        'stale',
        'This station was claimed by someone else a moment ago.',
        fresh,
        stillHeld?.leaseId ?? null,
      );
    }

    await this.store.recordStationEvent(
      {
        stationId: request.stationId,
        boxId: this.boxId,
        kind: 'lease',
        source: sourceForKind(request.holderKind),
        sequence: document.sequence,
        leaseId: lease.leaseId,
        outcome: takenOver ? 'taken_over' : renewing ? 'renewed' : 'claimed',
        actorAccountId: request.accountId ?? null,
        actionId: request.actionId ?? null,
      },
      nowIso,
    );

    if (takenOver && held) {
      // The fact, not just the log line: a manager taking a live till away
      // from a colleague mid-sale is exactly the thing somebody asks about a
      // week later, and it has to reach the cloud's audit even if the box is
      // offline when it happens.
      //
      // WHY IT IS ALLOWED TO FAIL. The station has already changed hands —
      // that was the compare-and-set above, and it is on the row. Answering an
      // error now would tell a manager who IS holding the station that they
      // are not, and the retry would take it a second time: another sequence,
      // another takeover count, another fact. A `taken_over` line naming the
      // new lease and the account behind it went onto the station's own tape a
      // moment ago, so what a failure here costs is the cloud's audit row, not
      // every trace that the station changed hands. The error log below is
      // what closes the gap: it carries the displaced lease id too, which the
      // tape line does not, so the audit row can be put back by hand.
      try {
        await this.queueFact?.({
          type: 'station.takeover',
          stationId: request.stationId,
          // Who did it. Guaranteed non-null by the refusal above, and repeated
          // in the payload because the envelope's actor is the box's own field
          // and the payload is what the cloud's handler reads.
          actorAccountId: request.accountId ?? null,
          actionId: request.actionId ?? null,
          payload: {
            displacedLeaseId: held.leaseId,
            displacedHolderKind: held.holderKind,
            displacedAccountId: held.accountId,
            newLeaseId: lease.leaseId,
            newHolderKind: lease.holderKind,
            newAccountId: lease.accountId,
            takeoverCount: document.takeoverCount,
          },
        });
      } catch (error) {
        this.log.error(
          {
            err: String(error),
            module: 'station-session',
            stationId: request.stationId,
            displacedLeaseId: held.leaseId,
            newLeaseId: lease.leaseId,
            actorAccountId: request.accountId ?? null,
            actionId: request.actionId ?? null,
          },
          'a station takeover happened but its fact could not be queued',
        );
      }
    }

    if (!renewing) {
      this.emitLease(request.stationId, lease, takenOver, held?.leaseId ?? null);
      this.broadcast(document, request.actionId ?? null);
    }
    return { ok: true, document, lease, takenOver };
  }

  /**
   * The 15-second renewal. It moves the expiry and nothing else — in
   * particular it does not move the sequence, or two tabs could never agree on
   * a number for longer than one heartbeat.
   */
  async renew(stationId: string, leaseId: string, by: LeaseCaller): Promise<ClaimResult> {
    const now = this.clock();
    const nowIso = now.toISOString();
    const current = await this.open(stationId);
    if (!current.lease || current.lease.leaseId !== leaseId) {
      return {
        ok: false,
        refusal: 'stale',
        message: 'Session moved to another till.',
        document: current,
      };
    }
    /**
     * Quoting the current lease id is not holding it — every screen watching
     * the station is sent that id. A reload of the holder's own browser lands
     * here and renews, because the account is the same one that claimed it;
     * anybody else is told to go through a manager, and is told it as
     * `not_permitted` rather than `stale`, because rehydrating will not help
     * them: the document they would rehydrate to is the one they already read.
     */
    if (!heldBy(current.lease, by.accountId)) {
      return { ok: false, refusal: 'not_permitted', message: NOT_THE_HOLDER, document: current };
    }
    const lease: StationLease = {
      ...current.lease,
      heartbeatAt: nowIso,
      expiresAt: new Date(now.getTime() + STATION_LEASE_TTL_S * 1000).toISOString(),
    };
    const document = await this.store.applyLease(stationId, { leaseId }, { lease }, nowIso);
    if (!document) {
      const fresh = await this.open(stationId);
      return {
        ok: false,
        refusal: 'stale',
        message: 'Session moved to another till.',
        document: fresh,
      };
    }
    return { ok: true, document, lease, takenOver: false };
  }

  /**
   * Give the station up.
   *
   * `released: false` is not an error — the lease had already moved on, which
   * is the ordinary case for a tab closing after a takeover. Being refused IS
   * one: a screen that is not the holder ending somebody else's sale is the
   * same displacement a takeover is, without the name on it.
   */
  async release(
    stationId: string,
    leaseId: string,
    by: LeaseCaller & { actionId?: string | null },
  ): Promise<ReleaseResult> {
    const nowIso = this.nowIso();
    const actionId = by.actionId ?? null;
    const current = await this.open(stationId);
    if (current.lease && current.lease.leaseId === leaseId && !heldBy(current.lease, by.accountId)) {
      return { ok: false, refusal: 'not_permitted', message: NOT_THE_HOLDER, document: current };
    }
    const document = await this.store.applyLease(stationId, { leaseId }, { lease: null }, nowIso);
    if (!document) return { ok: true, released: false };
    await this.store.recordStationEvent(
      {
        stationId,
        boxId: this.boxId,
        kind: 'lease',
        source: 'box',
        sequence: document.sequence,
        leaseId,
        outcome: 'released',
        actionId,
      },
      nowIso,
    );
    this.emitLease(stationId, null, false, leaseId);
    this.broadcast(document, actionId);
    return { ok: true, released: true };
  }

  // --- Intents --------------------------------------------------------------

  async applyIntent(
    stationId: string,
    intent: StationIntent,
    context: { source: StationEventSource; accountId?: string | null },
  ): Promise<IntentResult> {
    const nowIso = this.nowIso();
    const document = await this.open(stationId);
    const spec = this.intents.get(intent.type);

    const refuse = async (
      refusal: StationIntentRefusal,
      message: string,
      doc: StationSessionDocument | null,
    ): Promise<IntentResult> => {
      await this.store.recordStationEvent(
        {
          stationId,
          boxId: this.boxId,
          kind: 'intent',
          source: context.source,
          sequence: doc?.sequence ?? null,
          stage: doc?.stage ?? null,
          intentType: intent.type,
          leaseId: intent.leaseId ?? null,
          outcome: 'refused',
          errorCode: refusal,
          actorAccountId: context.accountId ?? null,
          actionId: intent.actionId ?? null,
          payload: redactIntentPayload(intent),
        },
        nowIso,
      );
      return { ok: false, refusal, message, document: doc };
    };

    if (!spec) {
      // Usually a till newer than the box, which is the ordinary state of a
      // fleet mid-rollout. Naming it is what turns "nothing happened" into
      // "this box needs updating".
      return refuse('unknown_intent', `This box does not understand ${intent.type}.`, document);
    }
    if (!spec.sources.includes(context.source)) {
      return refuse('not_permitted', `A ${context.source} may not send ${intent.type}.`, document);
    }
    if (spec.stages && !spec.stages.includes(document.stage)) {
      return refuse(
        'wrong_stage',
        `${intent.type} is not available while the screen is on ${document.stage}.`,
        document,
      );
    }
    if (spec.requiresLease && !intent.leaseId) {
      return refuse('no_lease', 'This till does not hold the station.', document);
    }
    if (spec.requiresLease && document.lease?.leaseId !== intent.leaseId) {
      return refuse('stale', 'Session moved to another till.', document);
    }
    /**
     * Holding the lease, not knowing its id.
     *
     * The check above is the FENCE: it separates this till from one whose
     * lease has moved on. It cannot be the authorisation as well, because the
     * id it compares is published — the snapshot every watcher of this station
     * receives carries it, so a second till that was refused the station could
     * read the id back and drive the sale with it. The account on the lease is
     * what a reader cannot copy: the claim took it from the session.
     *
     * `not_permitted` rather than `stale`, and so not carrying the hint to
     * rehydrate: nothing about the document is out of date for this caller.
     * They are simply not the till working here.
     */
    if (spec.requiresLease && document.lease && !heldBy(document.lease, context.accountId ?? null)) {
      return refuse('not_permitted', NOT_THE_HOLDER, document);
    }

    const outcome = spec.apply({
      document,
      intent,
      source: context.source,
      accountId: context.accountId ?? null,
    });
    if (!outcome.ok) return refuse(outcome.refusal, outcome.message, document);

    /**
     * A lease-free intent may write only the fields that belong to the screen
     * sending it.
     *
     * `requiresLease: false` is for the customer display: the language toggle
     * and the answer to the prompt the till has just put up. Both are the
     * visitor's own side of the conversation, and neither is something the till
     * is holding the station in order to do. The rule is enforced on the WRITE
     * rather than trusted to the spec, because the next lease-free intent
     * somebody adds will be written by reading these two — and a lease-free
     * intent that could set the cart would be a second till operating the sale.
     */
    if (!spec.requiresLease) {
      const reached = Object.keys(outcome.write).filter(
        (key) => !LEASE_FREE_FIELDS.includes(key as keyof SessionWrite),
      );
      if (reached.length > 0) {
        return refuse(
          'not_permitted',
          `${intent.type} may not change ${reached.join(', ')} without holding the station.`,
          document,
        );
      }
    }

    const next = await this.store.applySession(
      stationId,
      {
        sequence: intent.lastSeenSequence,
        // A display's intent is checked against the sequence only: it holds no
        // lease, so requiring one would make the display unable to answer the
        // prompt the till just put on it.
        leaseId: spec.requiresLease ? (intent.leaseId ?? null) : null,
        /**
         * **And it may not move the sequence the holder is fenced against.**
         *
         * The display and a second till both send these with no lease, so
         * bumping the sequence for them handed any screen that can reach the
         * station a way to make the holder's next intent `409 STALE`: toggle the
         * language, the number moves, and the till working the sale is told the
         * session moved to another till. It is fenced on the sequence it read —
         * so it still cannot overwrite a change it has not seen — and it leaves
         * the number where it was, the way the lease renewal does.
         */
        advanceSequence: spec.requiresLease,
      },
      { ...outcome.write, lastActionId: intent.actionId ?? null },
      nowIso,
    );

    if (!next) {
      const fresh = await this.open(stationId);
      const moved = fresh.lease?.leaseId !== intent.leaseId && spec.requiresLease;
      return refuse(
        'stale',
        moved ? 'Session moved to another till.' : 'The screen moved on; this is the latest.',
        fresh,
      );
    }

    await this.store.recordStationEvent(
      {
        stationId,
        boxId: this.boxId,
        kind: 'intent',
        source: context.source,
        sequence: next.sequence,
        stage: next.stage,
        intentType: intent.type,
        leaseId: intent.leaseId ?? null,
        outcome: 'applied',
        actorAccountId: context.accountId ?? null,
        actionId: intent.actionId ?? null,
        payload: redactIntentPayload(intent),
      },
      nowIso,
    );
    this.broadcast(next, intent.actionId ?? null);
    return { ok: true, document: next };
  }
}

// --- Redaction --------------------------------------------------------------

/**
 * Keys that never reach the customer display, at any depth.
 *
 * R-58: a screen a stranger can read over a shoulder shows nothing about a
 * child's health or a staff member's opinion. The list is matched
 * case-insensitively on the key name, so `medicalNotes` and `medical_notes`
 * are the same key.
 */
const CUSTOMER_DENIED_KEYS = [
  'note',
  'notes',
  'staffnote',
  'staffnotes',
  'internalnote',
  'internalnotes',
  'allergy',
  'allergies',
  'medical',
  'medicalnote',
  'medicalnotes',
  'medicalalert',
  'consent',
  'consents',
  'foodconsent',
  'dob',
  'dateofbirth',
];

/**
 * What a customer display may show OF A MEMBER. An allow-list rather than a
 * deny-list, because the member record grows and the display is the screen
 * where a wrong guess is read by the wrong person.
 */
const CUSTOMER_MEMBER_FIELDS = ['id', 'displayName', 'name', 'nickname', 'tier', 'childCount'];

export function redactForCustomer(document: StationSessionDocument): StationSessionDocument {
  return {
    ...document,
    // The till's wizard position means nothing on the display and tells anyone
    // watching how far through a sale the staff member is.
    step: null,
    cart: stripKeys(document.cart),
    totals: stripKeys(document.totals),
    payment: stripKeys(document.payment),
    prompt: stripKeys(document.prompt),
    member: pickMemberFields(document.member),
  };
}

function pickMemberFields(
  member: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!member) return null;
  const out: Record<string, unknown> = {};
  for (const key of CUSTOMER_MEMBER_FIELDS) {
    if (key in member) out[key] = member[key];
  }
  return out;
}

function stripKeys(value: unknown): Record<string, unknown> | null {
  return deepStrip(value) as Record<string, unknown> | null;
}

function deepStrip(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(deepStrip);
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (CUSTOMER_DENIED_KEYS.includes(key.toLowerCase().replace(/_/g, ''))) continue;
    out[key] = deepStrip(inner);
  }
  return out;
}

/**
 * What a station log line keeps of an intent: which keys were sent, never what
 * was in them. A phone number in a log is a phone number in a log whether or
 * not anybody meant it to be there.
 */
function redactIntentPayload(intent: StationIntent): Record<string, unknown> {
  return { keys: Object.keys(intent.payload ?? {}).sort() };
}

// --- The intents the box understands today ----------------------------------
//
// Deliberately only identify-and-member: the cart, payment and booth intents
// belong to the tickets that own those flows, and each registers its own.

/**
 * The till's own intents — and deliberately NOT `console`.
 *
 * A manager watching a station from the Console is an OBSERVER, and the claim
 * at the top of this file — that an observer "can never change the document" —
 * was false while `console` sat in this list: a Console tab that held a lease
 * could set the stage, attach a member and clear the prompt on a till
 * somebody was standing at, from a screen in a back office. The one thing the
 * Console may do to a live station is TAKE IT OVER, which is a claim rather
 * than an intent, needs `pos:station:takeover`, and is audited by name.
 *
 * So a `console` source now matches no intent spec at all and is refused
 * `not_permitted` whatever it sends. That is the whole of read-only: not a
 * flag a screen is trusted to honour, but a source that no rule admits.
 */
const TILL_ONLY: readonly StationEventSource[] = ['till', 'kiosk'];
const DISPLAY_AND_TILL: readonly StationEventSource[] = ['till', 'display', 'kiosk', 'booth'];

/**
 * The fields an intent sent with no lease may write — the visitor's own side of
 * the screen and nothing else. Enforced in `applyIntent`, which is where the
 * reasoning for it is.
 */
const LEASE_FREE_FIELDS: ReadonlyArray<keyof SessionWrite> = ['language', 'prompt'];

function ok(write: SessionWrite): IntentOutcome {
  return { ok: true, write };
}

function wrong(message: string): IntentOutcome {
  return { ok: false, refusal: 'wrong_stage', message };
}

export const BUILT_IN_INTENTS: Record<string, IntentSpec> = {
  /** The display's language toggle, which the prototype already shows. */
  'display.set_language': {
    sources: DISPLAY_AND_TILL,
    requiresLease: false,
    apply({ intent }) {
      const language = intent.payload.language;
      if (typeof language !== 'string' || !isLanguage(language)) {
        return { ok: false, refusal: 'not_permitted', message: 'That is not a language we serve.' };
      }
      return ok({ language });
    },
  },

  /** The visitor typing their number on the display, answering the till's prompt. */
  'display.answer_prompt': {
    sources: DISPLAY_AND_TILL,
    requiresLease: false,
    apply({ document, intent }) {
      if (!document.prompt) return wrong('Nothing is being asked on this screen.');
      return ok({
        prompt: {
          ...document.prompt,
          answer: intent.payload.value ?? null,
          answeredAt: intent.payload.at ?? null,
        },
      });
    },
  },

  'session.set_stage': {
    sources: TILL_ONLY,
    requiresLease: true,
    apply({ intent }) {
      const stage = intent.payload.stage;
      if (typeof stage !== 'string' || !isStage(stage)) {
        return { ok: false, refusal: 'unknown_intent', message: `Unknown stage ${String(stage)}.` };
      }
      const step = intent.payload.step;
      return ok({ stage, step: typeof step === 'number' ? step : null });
    },
  },

  'session.reset': {
    sources: TILL_ONLY,
    requiresLease: true,
    apply() {
      return ok({
        stage: 'identify',
        step: null,
        cart: null,
        member: null,
        totals: null,
        payment: null,
        prompt: null,
      });
    },
  },

  'prompt.set': {
    sources: TILL_ONLY,
    requiresLease: true,
    apply({ intent }) {
      return ok({ prompt: intent.payload });
    },
  },

  'prompt.clear': {
    sources: TILL_ONLY,
    requiresLease: true,
    apply() {
      return ok({ prompt: null });
    },
  },

  'member.attach': {
    sources: TILL_ONLY,
    requiresLease: true,
    apply({ intent }) {
      const member = intent.payload.member;
      if (!member || typeof member !== 'object') {
        return { ok: false, refusal: 'not_permitted', message: 'No member was sent.' };
      }
      return ok({ member: member as Record<string, unknown>, stage: 'welcome', prompt: null });
    },
  },

  'member.clear': {
    sources: TILL_ONLY,
    requiresLease: true,
    apply() {
      return ok({ member: null, stage: 'identify' });
    },
  },
};

function isLanguage(value: string): value is StationLanguage {
  return (STATION_LANGUAGES as readonly string[]).includes(value);
}

function isStage(value: string): value is StationSessionStage {
  return (STATION_SESSION_STAGES as readonly string[]).includes(value);
}

function sourceForKind(kind: StationLeaseHolderKind): StationEventSource {
  return kind;
}
