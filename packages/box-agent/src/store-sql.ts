import {
  canonicalSyncBytes,
  type StationSessionDocument,
  type SyncChangeScope,
  type SyncEventEnvelope,
  type SyncEventOutcome,
} from './contract';
import {
  BOX_STORE_SCHEMA_VERSION,
  migrateCachedBundle,
  migrateOutboxRecord,
  migrateSessionDocument,
  type BoxStateRecord,
  type BoxStore,
  type CachedBundle,
  type EnvelopeSealer,
  type LeaseWrite,
  type OutboxBatch,
  type OutboxDepth,
  type OutboxRecord,
  type OutboxState,
  type QueuedFact,
  type SessionWrite,
  type StationEventWrite,
  type StationIdentity,
} from './store';
import { uuidv7 } from './signing';

/**
 * One `BoxStore` over SQL, in two dialects (S2-05).
 *
 * The virtual box runs inside the api and its store IS the `edge` schema of
 * the platform database; a Pi's store is a SQLite file on its memory card.
 * The two have the same tables, the same column names and the same semantics,
 * so this is one implementation with a dialect flag rather than two — and the
 * value of that is not saved typing, it is that the behaviour proved against
 * one dialect is the behaviour of the other.
 *
 * Both are actually run. `packages/box-agent/test/store.test.ts` drives this
 * file over SQLite; `apps/api/test/station-session-api.test.ts` drives the
 * same file over the `edge` schema of a real Postgres — the lease
 * compare-and-set, the gapless sequence and the outbox — so neither dialect
 * is taken on trust.
 *
 * What genuinely differs is spelled out at each site: the schema prefix,
 * `?` versus `$1`, booleans as booleans versus 0 and 1, and whether the driver
 * hands back a `Date` or a string.
 */

export type SqlDialect = 'postgres' | 'sqlite';

export type SqlRow = Record<string, unknown>;

/**
 * The narrow database interface the store needs.
 *
 * Deliberately not a `pg.Pool` or a `DatabaseSync`: this package has no
 * database dependency and must not grow one, because the same file runs on a
 * Pi where `pg` would be dead weight and inside the api where a second pool
 * would be a second connection budget. The api passes its pool in; the Pi
 * passes `sqliteDriver(...)` from next door.
 */
export interface BoxSqlDriver {
  readonly dialect: SqlDialect;
  /** SQL written with `?` placeholders; the driver spells them for its dialect. */
  query(sql: string, params?: readonly unknown[]): Promise<SqlRow[]>;
  /** Serialises a unit of work. The gapless sequence depends on this being real. */
  transaction<T>(fn: (tx: BoxSqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface SqlBoxStoreOptions {
  driver: BoxSqlDriver;
  /** Defaults to the box's own clock; injected so a test can move it. */
  now?: () => Date;
}

/** `?, ?, ?` for an `in (…)` over a list whose length is only known at runtime. */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** `?` is what the store writes; Postgres wants `$1`. No SQL here holds a literal `?`. */
export function toPositionalPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${(n += 1)}`);
}

/**
 * Values a driver may be handed.
 *
 * `node:sqlite` binds null, numbers, bigints, strings and buffers and nothing
 * else — a boolean throws. Normalising here rather than at forty call sites is
 * what keeps the two dialects one implementation.
 */
export function normaliseParam(value: unknown, dialect: SqlDialect): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return dialect === 'sqlite' ? (value ? 1 : 0) : value;
  return value;
}

export class SqlBoxStore implements BoxStore {
  private readonly driver: BoxSqlDriver;
  private readonly clock: () => Date;
  /**
   * Cache bundles on Postgres, and only on Postgres.
   *
   * The `edge` schema has no table for a box's cached bundles — `box_state`
   * records only which config version was applied and when. On a Pi the
   * bundles are a real SQLite table and survive a power cut; the virtual box
   * holds them here and loses them when the api restarts, which is honest but
   * is a gap: a box toggled offline and then restarted has its outbox, its
   * offline flag and its session document, and an empty cache. Closing it is
   * one `edge.box_cache` table in the next migration.
   */
  private readonly memoryBundles = new Map<string, CachedBundle>();

  constructor(options: SqlBoxStoreOptions) {
    this.driver = options.driver;
    this.clock = options.now ?? (() => new Date());
  }

  private get dialect(): SqlDialect {
    return this.driver.dialect;
  }

  /** `"edge"."box_state"` in the platform database; `"box_state"` on a Pi. */
  private table(name: string): string {
    return this.dialect === 'postgres' ? `"edge"."${name}"` : `"${name}"`;
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  async init(boxId: string): Promise<BoxStateRecord> {
    const now = this.nowIso();
    await this.driver.query(
      `insert into ${this.table('box_state')} (box_id, created_at, updated_at)
       values (?, ?, ?)
       on conflict (box_id) do nothing`,
      [boxId, now, now],
    );
    // Whatever was mid-flight when the power went is put back on the queue. The
    // box cannot know whether the cloud saw that batch, and the dedupe on
    // (box_id, journal_epoch, box_seq) makes re-sending free while losing is
    // not recoverable at all.
    await this.driver.query(
      `update ${this.table('box_outbox')}
          set state = 'queued', next_attempt_at = null
        where box_id = ? and state = 'sending'`,
      [boxId],
    );
    return this.readState(boxId);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  async readState(boxId: string): Promise<BoxStateRecord> {
    const rows = await this.driver.query(
      `select * from ${this.table('box_state')} where box_id = ?`,
      [boxId],
    );
    const row = rows[0];
    if (!row) throw new Error(`No box_state row for ${boxId}; call init() first`);
    return decodeState(row);
  }

  async setOffline(
    boxId: string,
    offline: boolean,
    opts?: { reason?: string | null; accountId?: string | null; now?: string },
  ): Promise<BoxStateRecord> {
    const now = opts?.now ?? this.nowIso();
    await this.driver.query(
      `update ${this.table('box_state')}
          set offline = ?,
              offline_since = ?,
              offline_reason = ?,
              offline_set_by_account_id = ?,
              updated_at = ?
        where box_id = ?`,
      [
        offline,
        offline ? now : null,
        offline ? (opts?.reason ?? null) : null,
        offline ? (opts?.accountId ?? null) : null,
        now,
        boxId,
      ],
    );
    return this.readState(boxId);
  }

  async setClockSkew(boxId: string, clockSkewMs: number): Promise<BoxStateRecord> {
    await this.driver.query(
      `update ${this.table('box_state')} set clock_skew_ms = ?, updated_at = ? where box_id = ?`,
      [Math.trunc(clockSkewMs), this.nowIso(), boxId],
    );
    return this.readState(boxId);
  }

  async setEpoch(boxId: string, journalEpoch: number, now?: string): Promise<BoxStateRecord> {
    const at = now ?? this.nowIso();
    // The sequence restarts at 1 with the epoch, which is what makes a batch
    // replayed from the old store recognisable rather than plausible.
    await this.driver.query(
      `update ${this.table('box_state')}
          set journal_epoch = ?, next_box_seq = 1, last_reset_at = ?, updated_at = ?
        where box_id = ?`,
      [journalEpoch, at, at, boxId],
    );
    return this.readState(boxId);
  }

  async setAppliedConfigVersion(
    boxId: string,
    configVersion: string | null,
  ): Promise<BoxStateRecord> {
    const now = this.nowIso();
    await this.driver.query(
      `update ${this.table('box_state')}
          set applied_config_version = ?, last_cache_applied_at = ?, updated_at = ?
        where box_id = ?`,
      [configVersion, now, now, boxId],
    );
    return this.readState(boxId);
  }

  async enqueue(
    boxId: string,
    fact: QueuedFact,
    seal: EnvelopeSealer,
    now?: string,
  ): Promise<OutboxRecord> {
    const at = now ?? this.nowIso();
    return this.driver.transaction(async (tx) => {
      // The row lock this UPDATE takes is the generator. Two tills queueing a
      // sale in the same millisecond serialise here, and a transaction that
      // rolls back returns its sequence, so the journal has no gaps — and a
      // gap is indistinguishable from an event that went missing.
      const stateRows = await tx.query(
        `update ${this.table('box_state')}
            set next_box_seq = next_box_seq + 1, updated_at = ?
          where box_id = ?
          returning journal_epoch, next_box_seq, clock_skew_ms`,
        [at, boxId],
      );
      const stateRow = stateRows[0];
      if (!stateRow) throw new Error(`No box_state row for ${boxId}; call init() first`);
      const journalEpoch = toNum(stateRow.journal_epoch);
      const boxSeq = toNum(stateRow.next_box_seq) - 1;
      const clockSkewMs = toNum(stateRow.clock_skew_ms);

      const envelope = seal({
        eventId: uuidv7(this.clock().getTime()),
        journalEpoch,
        boxSeq,
        type: fact.type,
        schemaVersion: BOX_STORE_SCHEMA_VERSION,
        occurredAt: fact.occurredAt ?? at,
        clockTrust: clockTrustFor(clockSkewMs),
        clockOffsetMs: clockSkewMs,
        stationId: fact.stationId ?? null,
        actorKind: fact.actorKind ?? 'account',
        actorAccountId: fact.actorAccountId ?? null,
        actorCredentialId: fact.actorCredentialId ?? null,
        actionId: fact.actionId ?? null,
        payload: fact.payload,
      });

      await tx.query(
        `insert into ${this.table('box_outbox')} (
           event_id, box_id, journal_epoch, box_seq, type, schema_version, occurred_at,
           clock_trust, clock_offset_ms, station_id, actor_kind, actor_account_id,
           actor_credential_id, action_id, payload, payload_hash, sig, sig_alg,
           state, attempts, created_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
        [
          envelope.eventId,
          boxId,
          envelope.journalEpoch,
          envelope.boxSeq,
          envelope.type,
          envelope.schemaVersion,
          envelope.occurredAt,
          envelope.clockTrust,
          envelope.clockOffsetMs ?? null,
          envelope.stationId ?? null,
          envelope.actorKind,
          envelope.actorAccountId ?? null,
          envelope.actorCredentialId ?? null,
          envelope.actionId ?? null,
          JSON.stringify(envelope.payload),
          envelope.payloadHash,
          envelope.sig,
          envelope.sigAlg,
          at,
        ],
      );

      return {
        envelope,
        state: 'queued' as OutboxState,
        attempts: 0,
        nextAttemptAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        createdAt: at,
        ackedAt: null,
      };
    });
  }

  async takeBatch(
    boxId: string,
    opts?: { maxEvents?: number; maxBytes?: number; now?: string },
  ): Promise<OutboxBatch> {
    const maxEvents = opts?.maxEvents ?? 200;
    const maxBytes = opts?.maxBytes ?? 1_000_000;
    const now = opts?.now ?? this.nowIso();
    const rows = await this.driver.query(
      `select * from ${this.table('box_outbox')}
        where box_id = ?
          and state in ('queued', 'failed')
          and (next_attempt_at is null or next_attempt_at <= ?)
        order by journal_epoch asc, box_seq asc
        limit ?`,
      [boxId, now, maxEvents],
    );

    const events: SyncEventEnvelope[] = [];
    let bytes = 0;
    for (const row of rows) {
      const record = migrateOutboxRecord(decodeOutbox(row));
      const size = Buffer.byteLength(canonicalSyncBytes({ ...record.envelope }), 'utf8');
      // One event larger than the whole cap would otherwise never be sent, and
      // a queue that silently stops at the same row every minute is the worst
      // kind of stuck. It goes on its own, over the cap.
      if (events.length > 0 && bytes + size > maxBytes) break;
      events.push(record.envelope);
      bytes += size;
    }
    if (events.length === 0) return { events, bytes: 0 };

    const ids = events.map((event) => event.eventId);
    await this.driver.query(
      `update ${this.table('box_outbox')}
          set state = 'sending', attempts = attempts + 1
        where event_id in (${ids.map(() => '?').join(', ')})`,
      ids,
    );
    return { events, bytes };
  }

  async settle(
    boxId: string,
    outcomes: SyncEventOutcome[],
    opts: {
      sent: string[];
      cursorSeq: number;
      now: string;
      retryAt: (attempts: number) => string;
    },
  ): Promise<void> {
    const sent = new Set(opts.sent);
    await this.driver.transaction(async (tx) => {
      for (const outcome of outcomes) {
        /**
         * An answer may only speak about the events this box just handed over.
         * Anything else is the cloud talking about a row the box still has in
         * its hand, and acting on it would be acknowledging a fact that has
         * never left the building.
         */
        if (!sent.has(outcome.eventId)) continue;
        if (outcome.result === 'applied' || outcome.result === 'duplicate') {
          // A duplicate is not a failure. It is the ordinary shape of an
          // acknowledgement that was lost on the way back, and it means the
          // fact is safely in the cloud — which is exactly what `acked` means.
          await tx.query(
            `update ${this.table('box_outbox')}
                set state = 'acked', acked_at = ?, last_error_code = null, last_error_message = null
              where event_id = ? and box_id = ?`,
            [opts.now, outcome.eventId, boxId],
          );
        } else if (outcome.result === 'quarantined') {
          // Parked, not retried: it is now a person's problem on the Failures
          // tab, and re-sending it every minute would bury the ones that
          // matter. The reason is what the tab groups by; the cloud's own
          // error code is the detail underneath it.
          await tx.query(
            `update ${this.table('box_outbox')}
                set state = 'quarantined', last_error_code = ?, last_error_message = ?
              where event_id = ? and box_id = ?`,
            [outcome.reason ?? 'quarantined', outcome.errorCode ?? null, outcome.eventId, boxId],
          );
        } else {
          const rows = await tx.query(
            `select attempts from ${this.table('box_outbox')} where event_id = ? and box_id = ?`,
            [outcome.eventId, boxId],
          );
          const attempts = toNum(rows[0]?.attempts ?? 1);
          await tx.query(
            `update ${this.table('box_outbox')}
                set state = 'failed', next_attempt_at = ?, last_error_code = ?
              where event_id = ? and box_id = ?`,
            [opts.retryAt(attempts), outcome.errorCode ?? 'rejected', outcome.eventId, boxId],
          );
        }
      }

      /**
       * What is left: events this box handed over and the answer said nothing
       * about. Two readings, and the cursor decides between them.
       *
       * At or below the cloud's high-water mark, the cloud is saying it already
       * holds them — the ordinary shape of a batch whose answer was lost and
       * was acknowledged by the next answer to arrive. Above it, the cloud has
       * simply not spoken about them, and the honest answer is to send them
       * again after a backoff rather than to assume either way.
       *
       * The `sent` fence is what makes both safe. Sweeping on `box_seq <=
       * cursor` alone once emptied an outbox of facts that had never been sent:
       * a test control moved the cursor by a million, and every queued event on
       * the box was suddenly "below the cursor". A cursor that jumps is a thing
       * that happens; a queue that empties itself because of one must not be.
       */
      if (opts.sent.length === 0) return;
      const outstanding = await tx.query(
        `select event_id, journal_epoch, box_seq, attempts
           from ${this.table('box_outbox')}
          where box_id = ? and state = 'sending'
            and event_id in (${placeholders(opts.sent.length)})`,
        [boxId, ...opts.sent],
      );
      if (outstanding.length === 0) return;

      const stateRows = await tx.query(
        `select journal_epoch from ${this.table('box_state')} where box_id = ?`,
        [boxId],
      );
      const epoch = toNum(stateRows[0]?.journal_epoch ?? 1);
      for (const row of outstanding) {
        const eventId = String(row.event_id);
        const covered =
          toNum(row.journal_epoch) === epoch && toNum(row.box_seq) <= opts.cursorSeq;
        if (covered) {
          await tx.query(
            `update ${this.table('box_outbox')}
                set state = 'acked', acked_at = ?
              where event_id = ? and box_id = ?`,
            [opts.now, eventId, boxId],
          );
        } else {
          await tx.query(
            `update ${this.table('box_outbox')}
                set state = 'queued', next_attempt_at = ?, last_error_code = ?,
                    last_error_message = ?
              where event_id = ? and box_id = ?`,
            [
              opts.retryAt(toNum(row.attempts ?? 1)),
              'PUSH_UNANSWERED',
              'The cloud answered the batch but said nothing about this event',
              eventId,
              boxId,
            ],
          );
        }
      }
    });
  }

  async releaseBatch(
    boxId: string,
    eventIds: string[],
    opts: { errorCode: string; errorMessage: string; retryAt: string },
  ): Promise<void> {
    if (eventIds.length === 0) return;
    await this.driver.query(
      `update ${this.table('box_outbox')}
          set state = 'queued', next_attempt_at = ?, last_error_code = ?, last_error_message = ?
        where box_id = ? and event_id in (${eventIds.map(() => '?').join(', ')})`,
      [opts.retryAt, opts.errorCode, opts.errorMessage, boxId, ...eventIds],
    );
  }

  async depth(boxId: string): Promise<OutboxDepth> {
    const rows = await this.driver.query(
      `select count(*) as queued, min(created_at) as oldest
         from ${this.table('box_outbox')}
        where box_id = ? and state in ('queued', 'sending', 'failed')`,
      [boxId],
    );
    const row = rows[0];
    return {
      queued: toNum(row?.queued ?? 0),
      oldestQueuedAt: toIso(row?.oldest ?? null),
    };
  }

  async requeueAcked(boxId: string, limit: number): Promise<number> {
    const rows = await this.driver.query(
      `select event_id from ${this.table('box_outbox')}
        where box_id = ? and state = 'acked'
        order by journal_epoch desc, box_seq desc
        limit ?`,
      [boxId, limit],
    );
    const ids = rows.map((row) => String(row.event_id));
    if (ids.length === 0) return 0;
    await this.driver.query(
      `update ${this.table('box_outbox')}
          set state = 'queued', next_attempt_at = null, acked_at = null
        where event_id in (${ids.map(() => '?').join(', ')})`,
      ids,
    );
    return ids.length;
  }

  async readSession(stationId: string): Promise<StationSessionDocument | null> {
    const rows = await this.driver.query(
      `select * from ${this.table('station_session')} where station_id = ?`,
      [stationId],
    );
    const row = rows[0];
    return row ? migrateSessionDocument(decodeSession(row)) : null;
  }

  async ensureSession(identity: StationIdentity, now: string): Promise<StationSessionDocument> {
    await this.driver.query(
      `insert into ${this.table('station_session')} (
         station_id, box_id, operator_id, branch_id, schema_version, sequence,
         stage, language, takeover_count, created_at, updated_at
       ) values (?, ?, ?, ?, ?, 0, 'identify', 'en', 0, ?, ?)
       on conflict (station_id) do nothing`,
      [
        identity.stationId,
        identity.boxId,
        identity.operatorId,
        identity.branchId,
        BOX_STORE_SCHEMA_VERSION,
        now,
        now,
      ],
    );
    const document = await this.readSession(identity.stationId);
    if (!document) throw new Error(`Station session for ${identity.stationId} vanished on create`);
    return document;
  }

  async applySession(
    stationId: string,
    expect: { sequence: number; leaseId: string | null },
    write: SessionWrite,
    now: string,
  ): Promise<StationSessionDocument | null> {
    const sets: string[] = ['sequence = sequence + 1', 'updated_at = ?', 'last_intent_at = ?'];
    const params: unknown[] = [now, now];

    // Built from the keys actually present, so "set the cart to null" and
    // "leave the cart alone" stay two different requests. A COALESCE would
    // collapse them into one and make clearing a cart impossible.
    const columns: Array<[keyof SessionWrite, string, boolean]> = [
      ['stage', 'stage', false],
      ['step', 'step', false],
      ['cart', 'cart', true],
      ['member', 'member', true],
      ['totals', 'totals', true],
      ['payment', 'payment', true],
      ['prompt', 'prompt', true],
      ['language', 'language', false],
      ['lastActionId', 'last_action_id', false],
    ];
    for (const [key, column, isJson] of columns) {
      if (!(key in write)) continue;
      const value = write[key];
      sets.push(`${column} = ?`);
      params.push(isJson && value !== null && value !== undefined ? JSON.stringify(value) : value);
    }

    let predicate = 'station_id = ? and sequence = ?';
    params.push(stationId, expect.sequence);
    if (expect.leaseId !== null) {
      predicate += ' and lease_id = ?';
      params.push(expect.leaseId);
    }

    const rows = await this.driver.query(
      `update ${this.table('station_session')} set ${sets.join(', ')} where ${predicate} returning *`,
      params,
    );
    const row = rows[0];
    // Zero rows is the whole point: the lease moved, or somebody else advanced
    // the sequence first. The caller turns that into `409 STALE` with the
    // current document attached, so a displaced till rehydrates in one trip.
    return row ? migrateSessionDocument(decodeSession(row)) : null;
  }

  async applyLease(
    stationId: string,
    expect: { leaseId: string | null; expiredBefore?: string },
    write: LeaseWrite,
    now: string,
  ): Promise<StationSessionDocument | null> {
    const lease = write.lease;
    const params: unknown[] = [
      lease?.leaseId ?? null,
      lease?.holder ?? null,
      lease?.holderKind ?? null,
      lease?.accountId ?? null,
      lease?.startedAt ?? null,
      lease?.heartbeatAt ?? null,
      lease?.expiresAt ?? null,
      write.incrementTakeover ? 1 : 0,
      now,
    ];

    // A renewal every fifteen seconds must not move the sequence, or two tabs
    // could never agree on a number for longer than one heartbeat. A claim, a
    // takeover or a release is a real change to the document and does move it.
    const bumpSequence = (expect.leaseId ?? null) !== (lease?.leaseId ?? null);

    /**
     * The two halves of `expect` are ANDed, never chosen between.
     *
     * A claim of an abandoned lease quotes the id it read AND the instant it
     * judged that lease dead, because the id on its own says nothing about
     * expiry: a renewal keeps the same lease id on purpose, so `lease_id = X`
     * holds equally for a lease that ran out and for one its holder refreshed
     * a millisecond ago. Testing the expiry again HERE is what puts the
     * abandon decision inside the compare-and-set instead of leaving it in a
     * timer read before it — and a heartbeat that lands in that window is
     * otherwise a live till losing its station mid-sale.
     */
    let predicate = 'station_id = ?';
    const tail: unknown[] = [stationId];
    if (expect.leaseId !== null) {
      predicate += ' and lease_id = ?';
      tail.push(expect.leaseId);
    } else {
      predicate += ' and lease_id is null';
    }
    if (expect.expiredBefore) {
      predicate += ' and (lease_id is null or lease_expires_at <= ?)';
      tail.push(expect.expiredBefore);
    }

    const rows = await this.driver.query(
      `update ${this.table('station_session')}
          set lease_id = ?, lease_holder = ?, lease_holder_kind = ?, lease_account_id = ?,
              lease_started_at = ?, lease_heartbeat_at = ?, lease_expires_at = ?,
              takeover_count = takeover_count + ?,
              ${bumpSequence ? 'sequence = sequence + 1,' : ''}
              updated_at = ?
        where ${predicate}
        returning *`,
      [...params, ...tail],
    );
    const row = rows[0];
    return row ? migrateSessionDocument(decodeSession(row)) : null;
  }

  async recordStationEvent(event: StationEventWrite, now: string): Promise<void> {
    await this.driver.query(
      `insert into ${this.table('station_event')} (
         id, station_id, box_id, kind, source, sequence, stage, intent_type, lease_id,
         outcome, error_code, actor_account_id, action_id, payload, occurred_at, received_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv7(this.clock().getTime()),
        event.stationId,
        event.boxId,
        event.kind,
        event.source,
        event.sequence ?? null,
        event.stage ?? null,
        event.intentType ?? null,
        event.leaseId ?? null,
        event.outcome ?? null,
        event.errorCode ?? null,
        event.actorAccountId ?? null,
        event.actionId ?? null,
        event.payload ? JSON.stringify(event.payload) : null,
        event.occurredAt ?? now,
        now,
      ],
    );
  }

  async readBundle(boxId: string, scope: SyncChangeScope): Promise<CachedBundle | null> {
    if (this.dialect === 'sqlite') {
      const rows = await this.driver.query(
        `select * from ${this.table('box_cache')} where box_id = ? and scope = ?`,
        [boxId, scope],
      );
      const row = rows[0];
      if (!row) return null;
      return migrateCachedBundle(
        {
          scope,
          schemaVersion: toNum(row.schema_version),
          cursorSeq: toNum(row.cursor_seq),
          payload: parseJson(row.payload) as Record<string, unknown>,
          appliedAt: toIso(row.applied_at) ?? this.nowIso(),
        },
        BOX_STORE_SCHEMA_VERSION,
      );
    }
    const held = this.memoryBundles.get(`${boxId}:${scope}`);
    return held ? migrateCachedBundle(held, BOX_STORE_SCHEMA_VERSION) : null;
  }

  async writeBundle(boxId: string, bundle: CachedBundle): Promise<void> {
    if (this.dialect === 'sqlite') {
      // Whole or not at all: a catalogue half applied prices the wrong ticket,
      // and the till has no way to know it is holding half of one.
      await this.driver.transaction(async (tx) => {
        await tx.query(
          `insert into ${this.table('box_cache')} (box_id, scope, schema_version, cursor_seq, payload, applied_at)
           values (?, ?, ?, ?, ?, ?)
           on conflict (box_id, scope) do update set
             schema_version = excluded.schema_version,
             cursor_seq = excluded.cursor_seq,
             payload = excluded.payload,
             applied_at = excluded.applied_at`,
          [
            boxId,
            bundle.scope,
            bundle.schemaVersion,
            bundle.cursorSeq,
            JSON.stringify(bundle.payload),
            bundle.appliedAt,
          ],
        );
      });
      return;
    }
    this.memoryBundles.set(`${boxId}:${bundle.scope}`, bundle);
  }
}

/**
 * A skew the box knows about is `skewed`; a box that cannot say what time it
 * is reports `untrusted` and lets the cloud resolve the trading day from its
 * own clock. Five minutes is the tolerance: longer than NTP's worst ordinary
 * correction, shorter than anything that could move a sale to the wrong day.
 */
export function clockTrustFor(clockSkewMs: number): 'trusted' | 'skewed' | 'untrusted' {
  const skew = Math.abs(clockSkewMs);
  if (skew <= 5 * 60_000) return 'trusted';
  if (skew <= 24 * 60 * 60_000) return 'skewed';
  return 'untrusted';
}

// --- Row decoding -----------------------------------------------------------
//
// Postgres hands back `Date`, `boolean` and a parsed `jsonb`; SQLite hands back
// strings and 0/1. Every read goes through these four, so the difference is
// three functions rather than a condition in every method.

export function toNum(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}

export function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

export function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return JSON.parse(value) as unknown;
  return value;
}

function decodeState(row: SqlRow): BoxStateRecord {
  return {
    boxId: String(row.box_id),
    offline: toBool(row.offline),
    offlineSince: toIso(row.offline_since),
    offlineReason: row.offline_reason === null ? null : String(row.offline_reason ?? ''),
    offlineSetByAccountId: row.offline_set_by_account_id
      ? String(row.offline_set_by_account_id)
      : null,
    journalEpoch: toNum(row.journal_epoch),
    nextBoxSeq: toNum(row.next_box_seq),
    storeSchemaVersion: toNum(row.store_schema_version),
    clockSkewMs: toNum(row.clock_skew_ms),
    appliedConfigVersion: row.applied_config_version ? String(row.applied_config_version) : null,
    lastCacheAppliedAt: toIso(row.last_cache_applied_at),
    lastResetAt: toIso(row.last_reset_at),
  };
}

function decodeOutbox(row: SqlRow): OutboxRecord {
  return {
    envelope: {
      eventId: String(row.event_id),
      journalEpoch: toNum(row.journal_epoch),
      boxSeq: toNum(row.box_seq),
      type: String(row.type),
      schemaVersion: toNum(row.schema_version),
      occurredAt: toIso(row.occurred_at) ?? new Date(0).toISOString(),
      clockTrust: String(row.clock_trust) as SyncEventEnvelope['clockTrust'],
      clockOffsetMs: row.clock_offset_ms === null ? undefined : toNum(row.clock_offset_ms),
      stationId: row.station_id ? String(row.station_id) : null,
      actorKind: String(row.actor_kind) as SyncEventEnvelope['actorKind'],
      actorAccountId: row.actor_account_id ? String(row.actor_account_id) : null,
      actorCredentialId: row.actor_credential_id ? String(row.actor_credential_id) : null,
      actionId: row.action_id ? String(row.action_id) : null,
      payload: (parseJson(row.payload) ?? {}) as Record<string, unknown>,
      payloadHash: String(row.payload_hash),
      sig: String(row.sig),
      sigAlg: String(row.sig_alg) as SyncEventEnvelope['sigAlg'],
    },
    state: String(row.state) as OutboxState,
    attempts: toNum(row.attempts),
    nextAttemptAt: toIso(row.next_attempt_at),
    lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
    lastErrorMessage: row.last_error_message ? String(row.last_error_message) : null,
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    ackedAt: toIso(row.acked_at),
  };
}

function decodeSession(row: SqlRow): StationSessionDocument {
  const leaseId = row.lease_id ? String(row.lease_id) : null;
  return {
    stationId: String(row.station_id),
    boxId: String(row.box_id),
    schemaVersion: toNum(row.schema_version),
    sequence: toNum(row.sequence),
    stage: String(row.stage) as StationSessionDocument['stage'],
    step: row.step === null || row.step === undefined ? null : toNum(row.step),
    cart: parseJson(row.cart) as Record<string, unknown> | null,
    member: parseJson(row.member) as Record<string, unknown> | null,
    totals: parseJson(row.totals) as Record<string, unknown> | null,
    payment: parseJson(row.payment) as Record<string, unknown> | null,
    prompt: parseJson(row.prompt) as Record<string, unknown> | null,
    language: String(row.language) as StationSessionDocument['language'],
    lease: leaseId
      ? {
          leaseId,
          holder: String(row.lease_holder),
          holderKind: String(row.lease_holder_kind) as NonNullable<
            StationSessionDocument['lease']
          >['holderKind'],
          accountId: row.lease_account_id ? String(row.lease_account_id) : null,
          startedAt: toIso(row.lease_started_at) ?? new Date(0).toISOString(),
          heartbeatAt: toIso(row.lease_heartbeat_at) ?? new Date(0).toISOString(),
          expiresAt: toIso(row.lease_expires_at) ?? new Date(0).toISOString(),
        }
      : null,
    takeoverCount: toNum(row.takeover_count),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}
