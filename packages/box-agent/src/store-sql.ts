import {
  canonicalSyncBytes,
  type StationSessionDocument,
  type SyncChangeScope,
  type SyncEventEnvelope,
  type SyncEventOutcome,
} from './contract';
import {
  BOX_STORE_SCHEMA_VERSION,
  BoxStoreFeatureMissingError,
  migrateCachedBundle,
  migrateOutboxRecord,
  migrateSessionDocument,
  OUTBOX_BACKOFF_CAP_MS,
  type BoxPrintJobState,
  type BoxStateRecord,
  type BoxStaffSession,
  type BoxStore,
  type BoxStoreFeatures,
  type CachedBundle,
  type ClockStamp,
  type CounterKey,
  type EnvelopeSealer,
  type LeaseWrite,
  type OutboxBatch,
  type OutboxDepth,
  type OutboxRecord,
  type OutboxState,
  type PrintJobPatch,
  type PrintJobRecord,
  type PrintJobStore,
  type QueuedFact,
  type SessionWrite,
  type StationEventWrite,
  type StationIdentity,
  type ThrottleRecord,
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

/**
 * The tables a box keeps for ITSELF, added by S2-07a.
 *
 * They are probed rather than assumed because the two dialects arrive at them
 * differently. A Pi's file is created by `prepareSqliteBoxStore`, which runs the
 * DDL next door, so every table is always there. The `edge` schema of the
 * platform database has only what a migration created — migration 0013 created
 * all five — and a database that has not had it applied yet is a database where
 * `features()` says so, the print subsystem falls back to the in-memory queue
 * S2-06 shipped, and the booth's runtime methods throw rather than pretend. The
 * probe stays because the two ends are versioned separately: a Pi's card and a
 * platform database are never guaranteed to be at the same migration, and a
 * store that discovers its shape from a failed INSERT has already half-done
 * something.
 *
 * `EDGE_BOX_LOCAL_TABLES_SQL` below is the exact Postgres shape they must have.
 */
export const BOX_LOCAL_TABLES = [
  'box_print_job',
  'box_counter',
  'box_staff_session',
  'box_throttle',
  'box_runtime',
] as const;

const BOOTH_RUNTIME_TABLES = ['box_counter', 'box_staff_session', 'box_throttle', 'box_runtime'];

/**
 * The Postgres shape these five must have, as `packages/db` migration 0013
 * built it.
 *
 * Exported so the columns cannot drift from the SQL above them: every statement
 * here names the same columns the queries in this file read and write, and the
 * SQLite half in `store-sqlite.ts` is the same list again in SQLite's types. It
 * is a string and nothing executes it — the api creating tables in the platform
 * database at boot would be a shape `verify-schema` cannot see and
 * `pnpm db:generate` would offer to drop.
 */
export const EDGE_BOX_LOCAL_TABLES_SQL = `
create table if not exists "edge"."box_print_job" (
  id uuid primary key,
  box_id uuid not null references "core"."box" (id) on delete restrict,
  kind text not null,
  role text,
  station_id uuid references "core"."station" (id) on delete restrict,
  device_id uuid references "core"."device" (id) on delete restrict,
  copies smallint not null default 1,
  job jsonb not null,
  finish jsonb,
  template_id uuid,
  template_version integer,
  action_id text,
  state text not null default 'queued',
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  last_error_code text,
  last_error_message text,
  queued_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint box_print_job_state_check check (state in ('queued','sending','interrupted')),
  constraint box_print_job_copies_check check (copies > 0),
  constraint box_print_job_attempts_check check (attempts >= 0)
);
create index if not exists box_print_job_pending_idx on "edge"."box_print_job" (box_id, queued_at);
create index if not exists box_print_job_station_idx on "edge"."box_print_job" (station_id);
create index if not exists box_print_job_device_idx on "edge"."box_print_job" (device_id);

create table if not exists "edge"."box_counter" (
  box_id uuid not null references "core"."box" (id) on delete restrict,
  scope text not null,
  counter_key text not null,
  business_date date not null,
  counter_value integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (box_id, scope, counter_key, business_date)
);

create table if not exists "edge"."box_staff_session" (
  station_id uuid primary key references "core"."station" (id) on delete restrict,
  box_id uuid not null references "core"."box" (id) on delete restrict,
  account_id uuid not null references "core"."account" (id) on delete restrict,
  credential_kind text not null default 'pin',
  staff_code text,
  signed_in_at timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists box_staff_session_box_idx on "edge"."box_staff_session" (box_id);
create index if not exists box_staff_session_account_idx on "edge"."box_staff_session" (account_id);

create table if not exists "edge"."box_throttle" (
  box_id uuid not null references "core"."box" (id) on delete restrict,
  scope text not null,
  subject text not null,
  failures integer not null default 0,
  first_failure_at timestamptz not null,
  last_failure_at timestamptz not null,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (box_id, scope, subject),
  constraint box_throttle_failures_check check (failures >= 0)
);

create table if not exists "edge"."box_runtime" (
  box_id uuid not null references "core"."box" (id) on delete restrict,
  runtime_key text not null,
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (box_id, runtime_key)
);
`;

/** The one `box_runtime` key so far: see `markTimeSeen`. */
const LAST_GOOD_TIME_KEY = 'last_good_time';

export class SqlBoxStore implements BoxStore {
  private readonly driver: BoxSqlDriver;
  private readonly clock: () => Date;
  /**
   * Which of `BOX_LOCAL_TABLES` this database actually has, as `init()` found
   * them. Empty before `init()`, which reads as "keep nothing", and that is the
   * answer that fails loudly rather than the one that loses a lockout.
   */
  private present = new Set<string>();
  /**
   * The agent's clock stamp per box (SCRUM-402); see `stampClockWith`. Shared
   * by reference with every store `scopedTo` makes, so a spin's facts are
   * stamped inside its transaction exactly as they would be outside it.
   */
  private clockStamps = new Map<string, () => ClockStamp>();

  constructor(options: SqlBoxStoreOptions) {
    this.driver = options.driver;
    this.clock = options.now ?? (() => new Date());
  }

  /**
   * The same store, bound to an open transaction.
   *
   * It carries the parent's probe result by reference, so a store that knows
   * its tables does not forget them for the length of a spin. Private, because
   * handing one of these out after its transaction has committed would be a
   * store whose writes go nowhere.
   */
  private scopedTo(driver: BoxSqlDriver): SqlBoxStore {
    const child = new SqlBoxStore({ driver, now: this.clock });
    child.present = this.present;
    child.clockStamps = this.clockStamps;
    return child;
  }

  stampClockWith(boxId: string, stamp: (() => ClockStamp) | null): void {
    if (stamp) this.clockStamps.set(boxId, stamp);
    else this.clockStamps.delete(boxId);
  }

  features(): BoxStoreFeatures {
    return {
      printJobs: this.present.has('box_print_job'),
      boothRuntime: BOOTH_RUNTIME_TABLES.every((name) => this.present.has(name)),
    };
  }

  printJobs(): PrintJobStore | null {
    return this.features().printJobs ? this : null;
  }

  /** Throw with the missing tables named, rather than write into nowhere. */
  private requireFeature(feature: keyof BoxStoreFeatures): void {
    if (this.features()[feature]) return;
    const wanted = feature === 'printJobs' ? ['box_print_job'] : BOOTH_RUNTIME_TABLES;
    throw new BoxStoreFeatureMissingError(
      feature,
      wanted.filter((name) => !this.present.has(name)),
    );
  }

  async atomically<T>(fn: (tx: BoxStore) => Promise<T>): Promise<T> {
    return this.driver.transaction((tx) => fn(this.scopedTo(tx)));
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

    this.present = await this.probeBoxLocalTables();
    if (this.present.has('box_print_job')) {
      /**
       * The opposite recovery to the outbox's, three statements above, and
       * deliberately so (D12). A print job that was `sending` had bytes on
       * their way to a head: some of that voucher is already paper, and
       * re-sending it unattended puts a second one beside a torn first with
       * nobody able to say which is the real one. It is marked `interrupted`
       * — which no retry ever picks up — and waits to be reported and deleted.
       *
       * A job still `queued` is untouched and resumes. Nothing was written to
       * a printer, so nothing has been half-printed.
       */
      await this.driver.query(
        `update ${this.table('box_print_job')}
            set state = 'interrupted',
                last_error_code = 'PRINT_INTERRUPTED',
                last_error_message = 'The box restarted while this job was going to the printer',
                updated_at = ?
          where box_id = ? and state = 'sending'`,
        [now, boxId],
      );
    }
    return this.readState(boxId);
  }

  /**
   * Which box-local tables this database has.
   *
   * One query at boot rather than a try/catch around every write: a store that
   * discovers its shape from a failed INSERT has already half-done something,
   * and on Postgres a failed statement poisons the transaction it was in.
   */
  private async probeBoxLocalTables(): Promise<Set<string>> {
    const names = [...BOX_LOCAL_TABLES];
    const rows =
      this.dialect === 'postgres'
        ? await this.driver.query(
            `select table_name as name from information_schema.tables
              where table_schema = 'edge' and table_name in (${placeholders(names.length)})`,
            names,
          )
        : await this.driver.query(
            `select name from sqlite_master
              where type = 'table' and name in (${placeholders(names.length)})`,
            names,
          );
    return new Set(rows.map((row) => String(row.name)));
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
    const [record] = await this.enqueueMany(boxId, [fact], seal, now);
    // Unreachable with one fact in and none dropped, but the type says
    // `OutboxRecord` and a cast would be this file asserting that on the
    // reader's behalf.
    if (!record) throw new Error('enqueue wrote no row');
    return record;
  }

  async enqueueMany(
    boxId: string,
    facts: readonly QueuedFact[],
    seal: EnvelopeSealer,
    now?: string,
  ): Promise<OutboxRecord[]> {
    if (facts.length === 0) return [];
    const at = now ?? this.nowIso();
    return this.driver.transaction(async (tx) => {
      // The row lock this UPDATE takes is the generator. Two tills queueing a
      // sale in the same millisecond serialise here, and a transaction that
      // rolls back returns its sequences, so the journal has no gaps — and a
      // gap is indistinguishable from an event that went missing.
      //
      // Claiming the whole run in ONE statement is what makes a spin's two
      // facts consecutive: two separate claims could have another station's
      // sale land between them, which is legal but makes the pair unreadable
      // in the journal, and it would take the row lock twice for one act.
      const stateRows = await tx.query(
        `update ${this.table('box_state')}
            set next_box_seq = next_box_seq + ?, updated_at = ?
          where box_id = ?
          returning journal_epoch, next_box_seq, clock_skew_ms`,
        [facts.length, at, boxId],
      );
      const stateRow = stateRows[0];
      if (!stateRow) throw new Error(`No box_state row for ${boxId}; call init() first`);
      const journalEpoch = toNum(stateRow.journal_epoch);
      const firstSeq = toNum(stateRow.next_box_seq) - facts.length;
      /**
       * How far these facts' times may be believed: the agent's stamp when one
       * is installed (SCRUM-402), read once so every fact in the run carries
       * the same answer, and the test control's skew only in a store no agent
       * has stamped.
       */
      const stamped = this.clockStamps.get(boxId)?.();
      const stamp: ClockStamp = stamped ?? legacyClockStamp(toNum(stateRow.clock_skew_ms));

      const records: OutboxRecord[] = [];
      for (const [index, fact] of facts.entries()) {
        const envelope = seal({
          eventId: uuidv7(this.clock().getTime()),
          journalEpoch,
          boxSeq: firstSeq + index,
          type: fact.type,
          schemaVersion: BOX_STORE_SCHEMA_VERSION,
          occurredAt: fact.occurredAt ?? at,
          clockTrust: stamp.clockTrust,
          ...(stamp.clockOffsetMs === undefined ? {} : { clockOffsetMs: stamp.clockOffsetMs }),
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

        records.push({
          envelope,
          state: 'queued' as OutboxState,
          attempts: 0,
          nextAttemptAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          createdAt: at,
          ackedAt: null,
        });
      }
      return records;
    });
  }

  async takeBatch(
    boxId: string,
    opts?: { maxEvents?: number; maxBytes?: number; now?: string },
  ): Promise<OutboxBatch> {
    const maxEvents = opts?.maxEvents ?? 200;
    const maxBytes = opts?.maxBytes ?? 1_000_000;
    const now = opts?.now ?? this.nowIso();
    /**
     * Due, too: a retry time further off than any backoff can put one
     * (SCRUM-402). It was set from a clock that has since gone back — a box
     * that booted hours ahead and deferred a push before it measured itself
     * against the platform — and waiting for it would hold those facts for
     * as long as the clock had been out: filed late, by the time the platform
     * received them, and overtaken by everything queued after them.
     */
    const nowMs = Date.parse(now);
    // A `now` that is not a time leaves the rule as it was: nothing is that far off.
    const pastAnyBackoff = Number.isFinite(nowMs)
      ? new Date(nowMs + OUTBOX_BACKOFF_CAP_MS).toISOString()
      : '9999-12-31T23:59:59.999Z';
    const rows = await this.driver.query(
      `select * from ${this.table('box_outbox')}
        where box_id = ?
          and state in ('queued', 'failed')
          and (next_attempt_at is null or next_attempt_at <= ? or next_attempt_at > ?)
        order by journal_epoch asc, box_seq asc
        limit ?`,
      [boxId, now, pastAnyBackoff, maxEvents],
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
    expect: { sequence: number; leaseId: string | null; advanceSequence?: boolean },
    write: SessionWrite,
    now: string,
  ): Promise<StationSessionDocument | null> {
    const sets: string[] = ['updated_at = ?', 'last_intent_at = ?'];
    const params: unknown[] = [now, now];
    // Default true: every caller that does not say otherwise is a writer that
    // holds the station, and the sequence is what fences the next one.
    if (expect.advanceSequence !== false) sets.unshift('sequence = sequence + 1');

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

  /**
   * What this box is holding for a scope, in both dialects (SCRUM-275).
   *
   * One statement for the two of them, because `box_cache` is now a real table
   * on Postgres as well: until migration 0016 the `edge` schema had nowhere to
   * put a bundle, so the virtual box inside the api kept them in a `Map` and
   * lost the staff list and the deny-list on every deploy. The read below is
   * what makes a restarted api a box that still knows who may unlock a till.
   */
  async readBundle(boxId: string, scope: SyncChangeScope): Promise<CachedBundle | null> {
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
    /**
     * The one genuine difference between the dialects here: `operator_id`.
     *
     * A Pi's file is single-tenant and its table has no such column; the
     * platform database holds every operator's boxes in one `edge` schema, so
     * the row carries the tenant it belongs to. `writeBundle` is not given one
     * — its callers are the agent's cache pull, which knows a box id and
     * nothing about tenancy — so it is taken from `core.box` in the same
     * statement rather than added to the signature of an interface a Pi also
     * implements.
     *
     * `insert … select … from core.box` also makes the box's existence a
     * condition of the write: an id with no box writes NO row, and the
     * `returning` below turns that into a thrown error instead of a cache that
     * silently kept nothing. Casts are explicit because a parameter in a
     * SELECT list has no target column to take its type from.
     */
    const written = await this.driver.query(
      `insert into ${this.table('box_cache')} (
         box_id, operator_id, scope, schema_version, cursor_seq, payload, applied_at
       )
       select b.id, b.operator_id, ?::text, ?::integer, ?::bigint, ?::jsonb, ?::timestamptz
         from "core"."box" b
        where b.id = ?
       on conflict (box_id, scope) do update set
         schema_version = excluded.schema_version,
         cursor_seq = excluded.cursor_seq,
         payload = excluded.payload,
         applied_at = excluded.applied_at
       returning box_id`,
      [
        bundle.scope,
        bundle.schemaVersion,
        bundle.cursorSeq,
        JSON.stringify(bundle.payload),
        bundle.appliedAt,
        boxId,
      ],
    );
    if (written.length === 0) {
      throw new Error(`No core.box row for ${boxId}; the ${bundle.scope} bundle was not cached`);
    }
  }

  // --- The print queue on disk (S2-07a) -------------------------------------

  async putPrintJob(record: PrintJobRecord): Promise<void> {
    this.requireFeature('printJobs');
    /**
     * Insert or replace, keyed on the job id the cloud already minted.
     *
     * Replace rather than "insert, and ignore a clash": a box that re-submits
     * an id is either resuming after a restart or being handed the same job
     * twice by an api that lost the answer, and in both cases the version in
     * hand is the current one. The id is the fence that stops it becoming two
     * vouchers.
     */
    await this.driver.query(
      `insert into ${this.table('box_print_job')} (
         id, box_id, kind, role, station_id, device_id, copies, job, finish,
         template_id, template_version, action_id, state, attempts, next_attempt_at,
         last_error_code, last_error_message, queued_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
         kind = excluded.kind,
         role = excluded.role,
         station_id = excluded.station_id,
         device_id = excluded.device_id,
         copies = excluded.copies,
         job = excluded.job,
         finish = excluded.finish,
         template_id = excluded.template_id,
         template_version = excluded.template_version,
         action_id = excluded.action_id,
         state = excluded.state,
         attempts = excluded.attempts,
         next_attempt_at = excluded.next_attempt_at,
         last_error_code = excluded.last_error_code,
         last_error_message = excluded.last_error_message,
         updated_at = excluded.updated_at`,
      [
        record.id,
        record.boxId,
        record.kind,
        record.role,
        record.stationId,
        record.deviceId,
        record.copies,
        JSON.stringify(record.job),
        record.finish ? JSON.stringify(record.finish) : null,
        record.templateId,
        record.templateVersion,
        record.actionId,
        record.state,
        record.attempts,
        record.nextAttemptAt,
        record.lastErrorCode,
        record.lastErrorMessage,
        record.queuedAt,
        record.updatedAt,
      ],
    );
  }

  async loadPendingPrintJobs(boxId: string): Promise<PrintJobRecord[]> {
    // No table is honestly no jobs, and the print subsystem asks this at every
    // boot: throwing would stop a box that can still print perfectly well.
    // The writes are the other way round — see `putPrintJob`.
    if (!this.features().printJobs) return [];
    /**
     * `queued` and `sending` both come back, and `sending` is not a
     * contradiction here: `init()` has already turned every job the PREVIOUS
     * process left mid-flight into `interrupted`, so anything still `sending`
     * belongs to this process and is on a printer right now. Leaving it out
     * would make the pending count drop for the length of a print — and that
     * count is what the booth's restart criterion is read from.
     */
    const rows = await this.driver.query(
      `select * from ${this.table('box_print_job')}
        where box_id = ? and state in ('queued', 'sending')
        order by queued_at asc, id asc`,
      [boxId],
    );
    return rows.map(decodePrintJob);
  }

  async loadInterruptedPrintJobs(boxId: string): Promise<PrintJobRecord[]> {
    if (!this.features().printJobs) return [];
    const rows = await this.driver.query(
      `select * from ${this.table('box_print_job')}
        where box_id = ? and state = 'interrupted'
        order by queued_at asc, id asc`,
      [boxId],
    );
    return rows.map(decodePrintJob);
  }

  async updatePrintJob(id: string, patch: PrintJobPatch, now?: string): Promise<void> {
    this.requireFeature('printJobs');
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now ?? this.nowIso()];
    // Built from the keys present, so "clear the error" and "leave the error
    // alone" stay two different requests — the same rule `applySession` keeps.
    const columns: Array<[keyof PrintJobPatch, string]> = [
      ['state', 'state'],
      ['attempts', 'attempts'],
      ['nextAttemptAt', 'next_attempt_at'],
      ['deviceId', 'device_id'],
      ['lastErrorCode', 'last_error_code'],
      ['lastErrorMessage', 'last_error_message'],
    ];
    for (const [key, column] of columns) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      params.push(patch[key]);
    }
    params.push(id);
    await this.driver.query(
      `update ${this.table('box_print_job')} set ${sets.join(', ')} where id = ?`,
      params,
    );
  }

  async deletePrintJob(id: string): Promise<void> {
    // A delete with no table has nothing to delete: no state is lost by
    // saying so quietly, which is not true of a write that claims to keep.
    if (!this.features().printJobs) return;
    /**
     * Deleted, not kept as `printed`.
     *
     * `edge.print_job` in the cloud is the history — it has the Console page,
     * the retention sweep and the reprint chain. This table is the outstanding
     * work, and a finished job left here would be a guest's name and a child's
     * allergy line sitting on a box in a storeroom for no reason anybody could
     * name.
     */
    await this.driver.query(`delete from ${this.table('box_print_job')} where id = ?`, [id]);
  }

  // --- Booth runtime state (S2-07a) -----------------------------------------

  async bumpCounter(boxId: string, key: CounterKey, by = 1, now?: string): Promise<number> {
    this.requireFeature('boothRuntime');
    const at = now ?? this.nowIso();
    // One statement, so two presses in the same second cannot both read three
    // and both write four. A daily cap read from a counter that lost an
    // increment is a prize given away twice.
    const rows = await this.driver.query(
      `insert into ${this.table('box_counter')} as held (
         box_id, scope, counter_key, business_date, counter_value, updated_at
       ) values (?, ?, ?, ?, ?, ?)
       on conflict (box_id, scope, counter_key, business_date) do update set
         counter_value = held.counter_value + excluded.counter_value,
         updated_at = excluded.updated_at
       returning counter_value`,
      [boxId, key.scope, key.key, key.businessDate, by, at],
    );
    return toNum(rows[0]?.counter_value ?? by);
  }

  async readCounter(boxId: string, key: CounterKey): Promise<number> {
    this.requireFeature('boothRuntime');
    const rows = await this.driver.query(
      `select counter_value from ${this.table('box_counter')}
        where box_id = ? and scope = ? and counter_key = ? and business_date = ?`,
      [boxId, key.scope, key.key, key.businessDate],
    );
    return toNum(rows[0]?.counter_value ?? 0);
  }

  async readCounters(
    boxId: string,
    scope: string,
    businessDate: string,
  ): Promise<Record<string, number>> {
    this.requireFeature('boothRuntime');
    const rows = await this.driver.query(
      `select counter_key, counter_value from ${this.table('box_counter')}
        where box_id = ? and scope = ? and business_date = ?`,
      [boxId, scope, businessDate],
    );
    const out: Record<string, number> = {};
    for (const row of rows) out[String(row.counter_key)] = toNum(row.counter_value);
    return out;
  }

  async readStaffSession(stationId: string): Promise<BoxStaffSession | null> {
    this.requireFeature('boothRuntime');
    const rows = await this.driver.query(
      `select * from ${this.table('box_staff_session')} where station_id = ?`,
      [stationId],
    );
    const row = rows[0];
    return row ? decodeStaffSession(row) : null;
  }

  async writeStaffSession(session: BoxStaffSession): Promise<void> {
    this.requireFeature('boothRuntime');
    // One station holds one session: signing in replaces whoever was there.
    // Two people signed in at one booth is not a state the screen could show.
    await this.driver.query(
      `insert into ${this.table('box_staff_session')} (
         station_id, box_id, account_id, credential_kind, staff_code,
         signed_in_at, last_seen_at, expires_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (station_id) do update set
         box_id = excluded.box_id,
         account_id = excluded.account_id,
         credential_kind = excluded.credential_kind,
         staff_code = excluded.staff_code,
         signed_in_at = excluded.signed_in_at,
         last_seen_at = excluded.last_seen_at,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      [
        session.stationId,
        session.boxId,
        session.accountId,
        session.credentialKind,
        session.staffCode,
        session.signedInAt,
        session.lastSeenAt,
        session.expiresAt,
        this.nowIso(),
      ],
    );
  }

  async touchStaffSession(stationId: string, now: string): Promise<void> {
    this.requireFeature('boothRuntime');
    await this.driver.query(
      `update ${this.table('box_staff_session')}
          set last_seen_at = ?, updated_at = ?
        where station_id = ?`,
      [now, now, stationId],
    );
  }

  async clearStaffSession(stationId: string): Promise<void> {
    this.requireFeature('boothRuntime');
    await this.driver.query(
      `delete from ${this.table('box_staff_session')} where station_id = ?`,
      [stationId],
    );
  }

  async readThrottle(
    boxId: string,
    scope: string,
    subject: string,
  ): Promise<ThrottleRecord | null> {
    this.requireFeature('boothRuntime');
    const rows = await this.driver.query(
      `select * from ${this.table('box_throttle')}
        where box_id = ? and scope = ? and subject = ?`,
      [boxId, scope, subject],
    );
    const row = rows[0];
    return row ? decodeThrottle(row) : null;
  }

  async recordThrottleFailure(
    boxId: string,
    scope: string,
    subject: string,
    opts?: { now?: string; lockedUntil?: string | null },
  ): Promise<ThrottleRecord> {
    this.requireFeature('boothRuntime');
    const at = opts?.now ?? this.nowIso();
    /**
     * The count moves inside the statement, so two wrong PINs typed at once
     * count as two. `locked_until` is only written when the caller passed one:
     * `coalesce(excluded.locked_until, held.locked_until)` keeps a lock that is
     * already on the row when the caller says nothing, which is what lets a
     * policy that locks on the fifth failure stay silent about the sixth
     * without lifting the lock it set.
     */
    const rows = await this.driver.query(
      `insert into ${this.table('box_throttle')} as held (
         box_id, scope, subject, failures, first_failure_at, last_failure_at,
         locked_until, updated_at
       ) values (?, ?, ?, 1, ?, ?, ?, ?)
       on conflict (box_id, scope, subject) do update set
         failures = held.failures + 1,
         last_failure_at = excluded.last_failure_at,
         locked_until = coalesce(excluded.locked_until, held.locked_until),
         updated_at = excluded.updated_at
       returning *`,
      [boxId, scope, subject, at, at, opts?.lockedUntil ?? null, at],
    );
    const row = rows[0];
    if (!row) throw new Error(`The throttle for ${scope}/${subject} wrote no row`);
    return decodeThrottle(row);
  }

  async clearThrottle(boxId: string, scope: string, subject: string): Promise<void> {
    this.requireFeature('boothRuntime');
    await this.driver.query(
      `delete from ${this.table('box_throttle')} where box_id = ? and scope = ? and subject = ?`,
      [boxId, scope, subject],
    );
  }

  async markTimeSeen(boxId: string, at: string): Promise<string> {
    this.requireFeature('boothRuntime');
    /**
     * Forward only, decided in the statement.
     *
     * The comparison is string `<` over the value already stored, which orders
     * the same way as time for what this box writes: `Date#toISOString()` is
     * fixed-width UTC for every year from 1000 to 9999, and `markTimeSeen` is
     * the only writer of this key. It is not a general claim about ISO-8601 —
     * an offset like `+07:00`, or a year outside that range, would not order
     * this way, and neither reaches here.
     */
    await this.driver.query(
      `insert into ${this.table('box_runtime')} as held (box_id, runtime_key, value, updated_at)
       values (?, ?, ?, ?)
       on conflict (box_id, runtime_key) do update set
         value = excluded.value, updated_at = excluded.updated_at
       where held.value < excluded.value`,
      [boxId, LAST_GOOD_TIME_KEY, at, at],
    );
    return (await this.lastGoodTime(boxId)) ?? at;
  }

  async lastGoodTime(boxId: string): Promise<string | null> {
    this.requireFeature('boothRuntime');
    const rows = await this.driver.query(
      `select value from ${this.table('box_runtime')} where box_id = ? and runtime_key = ?`,
      [boxId, LAST_GOOD_TIME_KEY],
    );
    const value = rows[0]?.value;
    return value === undefined || value === null ? null : String(value);
  }

  async readRuntimeValue(boxId: string, key: string): Promise<string | null> {
    this.requireFeature('boothRuntime');
    const rows = await this.driver.query(
      `select value from ${this.table('box_runtime')} where box_id = ? and runtime_key = ?`,
      [boxId, key],
    );
    const value = rows[0]?.value;
    return value === undefined || value === null ? null : String(value);
  }

  async writeRuntimeValue(boxId: string, key: string, value: string, now?: string): Promise<void> {
    this.requireFeature('boothRuntime');
    if (key === LAST_GOOD_TIME_KEY) {
      // `markTimeSeen` only ever moves this forward; an overwrite here would
      // let a clock that jumped back rewrite the one time the box trusts.
      throw new Error(`${LAST_GOOD_TIME_KEY} is written by markTimeSeen only`);
    }
    const at = now ?? this.nowIso();
    await this.driver.query(
      `insert into ${this.table('box_runtime')} (box_id, runtime_key, value, updated_at)
       values (?, ?, ?, ?)
       on conflict (box_id, runtime_key) do update set
         value = excluded.value, updated_at = excluded.updated_at`,
      [boxId, key, value, at],
    );
  }
}

/**
 * A skew the box knows about is `skewed`; a box that cannot say what time it
 * is reports `untrusted` and lets the cloud resolve the trading day from its
 * own clock. Five minutes is the tolerance: longer than NTP's worst ordinary
 * correction, shorter than anything that could move a sale to the wrong day.
 *
 * The rule of a store no agent has stamped (see `stampClockWith`). A running
 * box stamps from its measurement against the platform instead (SCRUM-402):
 * the test control's skew moves its raw clock, and the measurement is what
 * notices.
 */
export function clockTrustFor(clockSkewMs: number): 'trusted' | 'skewed' | 'untrusted' {
  const skew = Math.abs(clockSkewMs);
  if (skew <= 5 * 60_000) return 'trusted';
  if (skew <= 24 * 60 * 60_000) return 'skewed';
  return 'untrusted';
}

function legacyClockStamp(clockSkewMs: number): ClockStamp {
  return { clockTrust: clockTrustFor(clockSkewMs), clockOffsetMs: clockSkewMs };
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

function decodePrintJob(row: SqlRow): PrintJobRecord {
  return {
    id: String(row.id),
    boxId: String(row.box_id),
    kind: String(row.kind),
    role: row.role === null || row.role === undefined ? null : String(row.role),
    stationId: row.station_id ? String(row.station_id) : null,
    deviceId: row.device_id ? String(row.device_id) : null,
    copies: toNum(row.copies),
    /**
     * Cast, and this is the one place the cast is honest: what comes back is
     * whatever `putPrintJob` wrote, and nothing else writes this column. A
     * `PrintJob` from a version of the renderer this agent no longer matches
     * would be caught where it is rendered — `renderJob` throws and the queue
     * ends the job `failed` with `RENDER_FAILED` — rather than here, where
     * refusing to read would strand a voucher somebody is standing waiting for.
     */
    job: (parseJson(row.job) ?? {}) as PrintJobRecord['job'],
    finish: (parseJson(row.finish) ?? null) as Record<string, unknown> | null,
    templateId: row.template_id ? String(row.template_id) : null,
    templateVersion:
      row.template_version === null || row.template_version === undefined
        ? null
        : toNum(row.template_version),
    actionId: row.action_id ? String(row.action_id) : null,
    state: String(row.state) as BoxPrintJobState,
    attempts: toNum(row.attempts),
    nextAttemptAt: toIso(row.next_attempt_at),
    lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
    lastErrorMessage: row.last_error_message ? String(row.last_error_message) : null,
    queuedAt: toIso(row.queued_at) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function decodeStaffSession(row: SqlRow): BoxStaffSession {
  return {
    stationId: String(row.station_id),
    boxId: String(row.box_id),
    accountId: String(row.account_id),
    credentialKind: String(row.credential_kind),
    staffCode: row.staff_code ? String(row.staff_code) : null,
    signedInAt: toIso(row.signed_in_at) ?? new Date(0).toISOString(),
    lastSeenAt: toIso(row.last_seen_at) ?? new Date(0).toISOString(),
    expiresAt: toIso(row.expires_at),
  };
}

function decodeThrottle(row: SqlRow): ThrottleRecord {
  return {
    boxId: String(row.box_id),
    scope: String(row.scope),
    subject: String(row.subject),
    failures: toNum(row.failures),
    firstFailureAt: toIso(row.first_failure_at) ?? new Date(0).toISOString(),
    lastFailureAt: toIso(row.last_failure_at) ?? new Date(0).toISOString(),
    lockedUntil: toIso(row.locked_until),
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
