import { normaliseParam, type BoxSqlDriver, type SqlRow } from './store-sql';

/**
 * A Raspberry Pi's store: one SQLite file on the memory card (S2-05).
 *
 * Kept behind its own entry point (`@oto/box-agent/sqlite`) rather than the
 * package barrel, because importing `node:sqlite` prints an experimental
 * warning on every boot and the api — which will never open a SQLite file —
 * should not wear that for a module it does not use.
 *
 * The tables below are the same tables, with the same column names, as the
 * `edge` schema the virtual box writes to. The differences are the ones a
 * single-tenant file genuinely has: no schema prefix, no foreign keys into a
 * `core` schema that does not exist here, and `box_cache`, which the `edge`
 * schema has no table for yet.
 */

export interface SqliteStatementLike {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

export interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

/**
 * A commit has to survive the power strip somebody trips over.
 *
 * WAL so a reader never blocks the till's writer, and `synchronous = FULL`
 * because the default (`NORMAL`) lets a WAL commit sit in the card's buffer:
 * fast, and exactly the sale that goes missing. The cost is one fsync per
 * transaction on a box doing a few writes a minute.
 */
export const SQLITE_PRAGMAS = [
  'pragma journal_mode = WAL',
  'pragma synchronous = FULL',
  'pragma busy_timeout = 5000',
  'pragma foreign_keys = ON',
] as const;

export const SQLITE_BOX_SCHEMA = `
create table if not exists box_state (
  box_id text primary key,
  offline integer not null default 0,
  offline_since text,
  offline_reason text,
  offline_set_by_account_id text,
  journal_epoch integer not null default 1,
  next_box_seq integer not null default 1,
  store_schema_version integer not null default 1,
  clock_skew_ms integer not null default 0,
  applied_config_version text,
  last_cache_applied_at text,
  last_reset_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists box_outbox (
  event_id text primary key,
  box_id text not null,
  journal_epoch integer not null,
  box_seq integer not null,
  type text not null,
  schema_version integer not null default 1,
  occurred_at text not null,
  clock_trust text not null default 'trusted',
  clock_offset_ms integer,
  station_id text,
  actor_kind text not null default 'account',
  actor_account_id text,
  actor_credential_id text,
  action_id text,
  payload text not null,
  payload_hash text not null,
  sig text not null,
  sig_alg text not null default 'ed25519',
  state text not null default 'queued',
  attempts integer not null default 0,
  next_attempt_at text,
  last_error_code text,
  last_error_message text,
  created_at text not null,
  acked_at text
);

create unique index if not exists box_outbox_journal_unique
  on box_outbox (box_id, journal_epoch, box_seq);
create index if not exists box_outbox_send_idx
  on box_outbox (box_id, box_seq) where state in ('queued', 'sending');

create table if not exists station_session (
  station_id text primary key,
  box_id text not null,
  operator_id text not null,
  branch_id text not null,
  schema_version integer not null default 1,
  sequence integer not null default 0,
  stage text not null default 'identify',
  step integer,
  cart text,
  member text,
  totals text,
  payment text,
  prompt text,
  language text not null default 'en',
  lease_id text,
  lease_holder text,
  lease_holder_kind text,
  lease_account_id text,
  lease_started_at text,
  lease_heartbeat_at text,
  lease_expires_at text,
  takeover_count integer not null default 0,
  last_intent_at text,
  last_action_id text,
  created_at text not null,
  updated_at text not null
);

create table if not exists station_event (
  id text primary key,
  station_id text not null,
  box_id text not null,
  kind text not null,
  source text not null,
  sequence integer,
  stage text,
  intent_type text,
  lease_id text,
  outcome text,
  error_code text,
  actor_account_id text,
  action_id text,
  payload text,
  occurred_at text,
  received_at text not null
);

create index if not exists station_event_station_received_idx
  on station_event (station_id, received_at);

create table if not exists box_cache (
  box_id text not null,
  scope text not null,
  schema_version integer not null default 1,
  cursor_seq integer not null default 0,
  payload text not null,
  applied_at text not null,
  primary key (box_id, scope)
);
`;

/** Create the tables if they are absent and set the durability pragmas. */
export function prepareSqliteBoxStore(db: SqliteDatabaseLike): void {
  for (const pragma of SQLITE_PRAGMAS) db.exec(pragma);
  db.exec(SQLITE_BOX_SCHEMA);
}

export function sqliteBoxDriver(db: SqliteDatabaseLike): BoxSqlDriver {
  return driverFor(db, false);
}

function driverFor(db: SqliteDatabaseLike, inTransaction: boolean): BoxSqlDriver {
  const driver: BoxSqlDriver = {
    dialect: 'sqlite',
    async query(sql, params = []) {
      const bound = params.map((value) => normaliseParam(value, 'sqlite'));
      const statement = db.prepare(sql);
      // `all()` on a statement that returns no rows is not portable across
      // SQLite bindings, and guessing wrong turns a write into an exception on
      // a Pi at a counter. The shape of the statement is knowable, so it is
      // read rather than guessed.
      if (returnsRows(sql)) return statement.all(...bound) as SqlRow[];
      statement.run(...bound);
      return [];
    },
    async transaction(fn) {
      if (inTransaction) return fn(driver);
      // IMMEDIATE takes the write lock now rather than when the first write
      // arrives, so the sequence generator cannot deadlock against a reader
      // that upgraded mid-transaction.
      db.exec('begin immediate');
      try {
        const value = await fn(driverFor(db, true));
        db.exec('commit');
        return value;
      } catch (error) {
        try {
          db.exec('rollback');
        } catch {
          /* nothing was open; the original error is the one that matters */
        }
        throw error;
      }
    },
    async close() {
      db.close();
    },
  };
  return driver;
}

function returnsRows(sql: string): boolean {
  const head = sql.trimStart().toLowerCase();
  return head.startsWith('select') || head.startsWith('with') || /\breturning\b/i.test(sql);
}
