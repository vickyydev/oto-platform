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
 * single-tenant file genuinely has: no schema prefix, and no foreign keys into
 * a `core` schema that does not exist here.
 *
 * Every one of them now has a counterpart in `edge` — the five box-local
 * tables since 0013 (S2-07a) and `box_cache` since 0016 (SCRUM-275). A Pi
 * creates them here at boot; the platform database gets them from its
 * migrations. The store still probes for the five box-local tables rather
 * than assuming (`BOX_LOCAL_TABLES` and `EDGE_BOX_LOCAL_TABLES_SQL` in
 * `store-sql.ts`), because a Pi's card and the platform database version
 * separately.
 */

export interface SqliteStatementLike {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
  /**
   * Rows one at a time (`node:sqlite` from 22.13). Optional: only the salvage
   * of a damaged store uses it, to keep the rows read before the damage.
   */
  iterate?(...params: unknown[]): Iterable<unknown>;
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

-- The box's own print queue (S2-07a).
--
-- Not the cloud's edge.print_job, which is the HISTORY and deliberately
-- stores nothing rendered. This is the outstanding work, and it has to carry
-- the renderer's input, because the point of the table is that a voucher
-- waiting on paper still prints after the power has been off. A finished job
-- is deleted, so a guest's name and a child's allergy line stay here only as
-- long as the paper takes to come out.
create table if not exists box_print_job (
  id text primary key,
  box_id text not null,
  kind text not null,
  role text,
  station_id text,
  device_id text,
  copies integer not null default 1,
  job text not null,
  finish text,
  template_id text,
  template_version integer,
  action_id text,
  state text not null default 'queued',
  attempts integer not null default 0,
  next_attempt_at text,
  last_error_code text,
  last_error_message text,
  queued_at text not null,
  updated_at text not null,
  check (state in ('queued', 'sending', 'interrupted')),
  check (copies > 0),
  check (attempts >= 0)
);

create index if not exists box_print_job_pending_idx on box_print_job (box_id, queued_at);
create index if not exists box_print_job_station_idx on box_print_job (station_id);
create index if not exists box_print_job_device_idx on box_print_job (device_id);

-- Counters for one trading day: spins, and spins per prize, which is what a
-- daily cap is read from. A business date and not a timestamp, because the
-- park's day starts at branch.business_day_start and not at midnight.
create table if not exists box_counter (
  box_id text not null,
  scope text not null,
  counter_key text not null,
  business_date text not null,
  counter_value integer not null default 0,
  updated_at text not null,
  primary key (box_id, scope, counter_key, business_date)
);

-- Who is signed in at a station, kept where a restart cannot lose it.
create table if not exists box_staff_session (
  station_id text primary key,
  box_id text not null,
  account_id text not null,
  credential_kind text not null default 'pin',
  staff_code text,
  signed_in_at text not null,
  last_seen_at text not null,
  expires_at text,
  updated_at text not null
);

create index if not exists box_staff_session_box_idx on box_staff_session (box_id);

-- Failed sign-ins, counted on disk. In memory a lockout would last until
-- somebody pulled the booth's power lead, which is not a lockout.
create table if not exists box_throttle (
  box_id text not null,
  scope text not null,
  subject text not null,
  failures integer not null default 0,
  first_failure_at text not null,
  last_failure_at text not null,
  locked_until text,
  updated_at text not null,
  primary key (box_id, scope, subject),
  check (failures >= 0)
);

-- Small values the box owns, by key: the latest time this box has reason to
-- believe in (how a Pi with no clock battery can tell that the time it booted
-- with is behind a moment it has already lived through), the last measurement
-- of its clock against the platform and the boot it was made in (SCRUM-402),
-- the booth's last vouchers and who is signed in — and, one key per code,
-- every voucher code the booth has minted, so a repeat is drawn again
-- (SCRUM-414).
create table if not exists box_runtime (
  box_id text not null,
  runtime_key text not null,
  value text not null,
  updated_at text not null,
  primary key (box_id, runtime_key)
);

-- What a counter recorded while it could not reach the platform (offline plan
-- Round 3): members, children and visits, each written in the same
-- transaction as the fact that carries it up, so the next lookup at this
-- counter finds the family it just signed up. Pruned once a cache pull brings
-- the platform's own copy. The platform database's twin is migration 0035.
create table if not exists box_overlay (
  box_id text not null,
  kind text not null,
  entity_id text not null,
  member_id text,
  phone text,
  payload text not null,
  created_at text not null,
  updated_at text not null,
  primary key (box_id, kind, entity_id),
  check (kind in ('member', 'child', 'visit', 'registration', 'checkin', 'guardian', 'release'))
);

create index if not exists box_overlay_phone_idx on box_overlay (box_id, phone);
create index if not exists box_overlay_member_idx on box_overlay (box_id, member_id);
`;

/** Create the tables if they are absent and set the durability pragmas. */
export function prepareSqliteBoxStore(db: SqliteDatabaseLike): void {
  for (const pragma of SQLITE_PRAGMAS) db.exec(pragma);
  db.exec(SQLITE_BOX_SCHEMA);
  widenSqliteOverlayKinds(db);
}

/**
 * S2-13 round 4 — a Pi whose card predates the check-in overlay kinds.
 *
 * `create table if not exists` leaves an older `box_overlay` as it was, and
 * SQLite cannot alter a CHECK, so a card made before this round would refuse
 * the first offline check-in with a constraint error. The table is rebuilt
 * once, in one transaction, keeping every row it holds (the members, children
 * and visits a counter recorded offline): a power cut in the middle leaves the
 * old table whole, and the next boot does it again. A table that already
 * allows the new kinds is left alone, so this costs one read on every boot.
 */
export function widenSqliteOverlayKinds(db: SqliteDatabaseLike): boolean {
  const rows = db
    .prepare(`select sql from sqlite_master where type = 'table' and name = 'box_overlay'`)
    .all() as Array<{ sql?: unknown }>;
  const ddl = typeof rows[0]?.sql === 'string' ? rows[0].sql : '';
  if (!ddl || ddl.includes("'checkin'")) return false;
  db.exec('begin immediate');
  try {
    db.exec(`create table box_overlay_widened (
      box_id text not null,
      kind text not null,
      entity_id text not null,
      member_id text,
      phone text,
      payload text not null,
      created_at text not null,
      updated_at text not null,
      primary key (box_id, kind, entity_id),
      check (kind in ('member', 'child', 'visit', 'registration', 'checkin', 'guardian', 'release'))
    )`);
    db.exec(`insert into box_overlay_widened
      (box_id, kind, entity_id, member_id, phone, payload, created_at, updated_at)
      select box_id, kind, entity_id, member_id, phone, payload, created_at, updated_at from box_overlay`);
    db.exec('drop table box_overlay');
    db.exec('alter table box_overlay_widened rename to box_overlay');
    db.exec('create index if not exists box_overlay_phone_idx on box_overlay (box_id, phone)');
    db.exec('create index if not exists box_overlay_member_idx on box_overlay (box_id, member_id)');
    db.exec('commit');
  } catch (err) {
    try {
      db.exec('rollback');
    } catch {
      // The transaction is already gone; the old table stands either way.
    }
    throw err;
  }
  return true;
}

// --- A store the box cannot use (SCRUM-403) ----------------------------------

/**
 * What is wrong with a store file.
 *
 * `unreadable`: SQLite cannot read it as a database at all — a card that lost
 * the writes it said were saved, a file overwritten, a read that fails.
 * `damaged`: it opens, and its integrity check finds pages that contradict
 * each other — or an index of the outbox that contradicts the outbox
 * (SCRUM-446). Both leave the booth unable to record a spin, and both are
 * mended the same way (PI_BOOTH.md §7, "A damaged store").
 */
export type SqliteStoreProblem = 'unreadable' | 'damaged';

export type SqliteStoreCheck =
  | { ok: true }
  | {
      ok: false;
      problem: SqliteStoreProblem;
      /**
       * SQLite's own words, for the box log: page numbers, never contents —
       * or, for an index that contradicts its table, the index's name and
       * the two counts.
       */
      detail: string;
    };

/** SQLite's primary result code for a file whose pages contradict each other. */
const SQLITE_CORRUPT = 11;

/** The outbox and the two indexes the box reads it through, as `sqlite_master` names them. */
const OUTBOX_TABLE = 'box_outbox';
const OUTBOX_SEND_INDEX = 'box_outbox_send_idx';
const OUTBOX_JOURNAL_INDEX = 'box_outbox_journal_unique';

/**
 * The outbox counted three ways at open, for `checkSqliteStore` (SCRUM-446).
 *
 * `table`: the outbox itself, `not indexed`, in one walk — every row, and
 * the unsent ones among them. `sendIndex`: the unsent rows as
 * `box_outbox_send_idx` has them; `indexed by` pins the read to the index
 * where a plain read only usually goes there, and the condition is the
 * index's own, so the walk is of the index and of nothing else.
 * `journalIndex`: every row as `box_outbox_journal_unique` has them —
 * `box_id is not null` is every row (the column is `not null`) and gives
 * `indexed by` a condition to hold, where a bare `count(*)` takes whichever
 * b-tree is smallest whatever it is told. A test pins the three plans.
 */
export const OUTBOX_COUNT_SQL = {
  table: `select count(*) as total, count(case when state in ('queued', 'sending') then 1 end) as unsent from box_outbox not indexed`,
  sendIndex: `select count(*) as n from box_outbox indexed by box_outbox_send_idx where state in ('queued', 'sending')`,
  journalIndex: `select count(*) as n from box_outbox indexed by box_outbox_journal_unique where box_id is not null`,
} as const;

/**
 * Is this store fit to run a booth on?
 *
 * `pragma quick_check` rather than `integrity_check`: it reads every page and
 * checks every b-tree, which is what a card that lost writes breaks, and skips
 * matching each index entry against its table row, which is what makes the
 * full check slow. Run BEFORE `prepareSqliteBoxStore`, because preparing
 * writes — the WAL switch, a missing table — and nothing should be written
 * into a file that is about to be read for what it still holds. A damaged
 * file is found here and not at the first press: `prepareSqliteBoxStore`
 * succeeds on a file whose outbox page is gone, and every press then failed
 * while the kiosk's health said all was well (closing audit M16, "nearby").
 *
 * Then the outbox's indexes are counted against the outbox (SCRUM-446).
 * `quick_check` counts the entries of a whole index against its table's rows
 * ("wrong # of entries in index …"), but a partial index holds only the rows
 * its condition picks, so there is no number to count it against — and
 * `box_outbox_send_idx` is partial. A card that lost the write to that one
 * page leaves a store `quick_check` passes, whose unsent rows are in the
 * table and not in the index: the salvage reads the table
 * (`UNSENT_OUTBOX_SQL`), but a box that RUNS on such a store runs on a file
 * the card has already lost a write to. So the unsent rows are counted in
 * the table and in the index, and a difference is damage, named by the
 * index. The journal index — the one `takeBatch` and `depth` search by box
 * id — is counted the same way, so the hot path's index does not rest on
 * which counts a build of SQLite makes in quick mode. One table walk of a
 * file `quick_check` has just read, and two index walks; all of it in one
 * read transaction, so the counts are of the file `quick_check` saw and not
 * of one a running box writes to between two statements (`oto-box claim`
 * looks at the store while the service may be running on it).
 */
export function checkSqliteStore(db: SqliteDatabaseLike): SqliteStoreCheck {
  try {
    db.exec('begin');
  } catch (err) {
    return { ok: false, problem: sqliteProblemOf(err), detail: sqliteMessage(err) };
  }
  try {
    const quick = quickCheck(db);
    return quick.ok ? checkOutboxIndexes(db) : quick;
  } finally {
    endRead(db);
  }
}

/** `pragma quick_check`, as SQLite answers it: one row `ok`, or what it found. */
function quickCheck(db: SqliteDatabaseLike): SqliteStoreCheck {
  let rows: unknown[];
  try {
    rows = db.prepare('pragma quick_check(10)').all();
  } catch (err) {
    return { ok: false, problem: sqliteProblemOf(err), detail: sqliteMessage(err) };
  }
  const lines = rows
    .map(firstColumn)
    .map((value) => String(value ?? '').trim())
    .filter((line) => line !== '');
  if (lines.length === 1 && lines[0] === 'ok') return { ok: true };
  return {
    ok: false,
    problem: 'damaged',
    detail: (lines.join(' | ') || 'the integrity check gave no answer').slice(0, 500),
  };
}

/**
 * The outbox's indexes against the outbox (`OUTBOX_COUNT_SQL`). A store
 * without the table, or without an index — a file made before the index was,
 * which `prepareSqliteBoxStore` then gives it — has nothing to compare yet.
 */
function checkOutboxIndexes(db: SqliteDatabaseLike): SqliteStoreCheck {
  try {
    const present = new Set(
      db
        .prepare('select name from sqlite_master where name in (?, ?, ?)')
        .all(OUTBOX_TABLE, OUTBOX_SEND_INDEX, OUTBOX_JOURNAL_INDEX)
        .map((row) => String(firstColumn(row) ?? '')),
    );
    if (!present.has(OUTBOX_TABLE)) return { ok: true };
    const [counted] = db.prepare(OUTBOX_COUNT_SQL.table).all();
    const total = countIn(counted, 'total');
    const unsent = countIn(counted, 'unsent');
    if (present.has(OUTBOX_SEND_INDEX)) {
      const indexed = countIn(db.prepare(OUTBOX_COUNT_SQL.sendIndex).all()[0], 'n');
      if (indexed !== unsent) {
        return {
          ok: false,
          problem: 'damaged',
          detail: `index ${OUTBOX_SEND_INDEX} holds ${indexed} unsent row(s) where the table holds ${unsent}`,
        };
      }
    }
    if (present.has(OUTBOX_JOURNAL_INDEX)) {
      const indexed = countIn(db.prepare(OUTBOX_COUNT_SQL.journalIndex).all()[0], 'n');
      if (indexed !== total) {
        return {
          ok: false,
          problem: 'damaged',
          detail: `index ${OUTBOX_JOURNAL_INDEX} holds ${indexed} row(s) where the table holds ${total}`,
        };
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, problem: sqliteProblemOf(err), detail: sqliteMessage(err) };
  }
}

/**
 * The read transaction `checkSqliteStore` opened, ended. A read has nothing
 * to keep: a commit that fails is rolled back, and one that cannot be is let
 * go — whoever opened the connection is about to close it.
 */
function endRead(db: SqliteDatabaseLike): void {
  try {
    db.exec('commit');
  } catch {
    try {
      db.exec('rollback');
    } catch {
      /* nothing was open */
    }
  }
}

function firstColumn(row: unknown): unknown {
  return row && typeof row === 'object' ? Object.values(row)[0] : row;
}

/** One named count out of a row, as a number; a row that is not there counts nothing. */
function countIn(row: unknown, column: string): number {
  const value = row && typeof row === 'object' ? (row as Record<string, unknown>)[column] : undefined;
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/**
 * The unsent outbox, read out of a store that cannot be run on.
 *
 * Every column of every row still `queued` or `sending`, exactly as the file
 * holds it: the envelope is signed, and a copy that re-encoded it would be a
 * copy nothing can verify. Read row by row where the binding can, so the
 * rows before a damaged page are kept when the read stops at it.
 *
 * Read from the table itself, never through an index (`UNSENT_OUTBOX_SQL`).
 */
export interface OutboxSalvage {
  rows: Array<Record<string, unknown>>;
  /** False when the read stopped part-way, or never started. */
  complete: boolean;
  /** Why nothing, or not everything, could be read. */
  error: string | null;
}

/**
 * Which rows are unsent, read from the outbox table and from nothing else.
 *
 * `not indexed` because the condition is exactly the one the partial index
 * `box_outbox_send_idx` is built on, so without it SQLite reads the unsent
 * rows THROUGH that index (`SCAN box_outbox USING INDEX box_outbox_send_idx`)
 * — and an index is a copy of the table on pages of its own, which a card
 * damages or leaves stale like any other. A damaged index page stopped the
 * read before its first row, with every row intact in the table; a stale one
 * that still reads well answered "none", complete, while the table held
 * vouchers the cloud never had — and none is what the heartbeat then told
 * the Console, which allows Reset the store only for a box with nothing
 * unsent. No ORDER BY either, for the same reason: the table is walked in its
 * own order, and the rows are put in journal order after. `oto-box status`
 * counts the outbox with the same condition (`runner/cli.ts`). Since
 * SCRUM-446 a stale send index is found at open (`checkSqliteStore`), so a
 * box never runs on one; the salvage still reads the table, for the store
 * whose damage is somewhere else.
 */
export const UNSENT_OUTBOX_SQL = `select * from box_outbox not indexed where state in ('queued', 'sending')`;

export function salvageSqliteOutbox(db: SqliteDatabaseLike): OutboxSalvage {
  const rows: Array<Record<string, unknown>> = [];
  try {
    const statement = db.prepare(UNSENT_OUTBOX_SQL);
    const source = statement.iterate ? statement.iterate() : statement.all();
    for (const row of source) {
      if (row && typeof row === 'object') rows.push({ ...(row as Record<string, unknown>) });
    }
    return { rows: inJournalOrder(rows), complete: true, error: null };
  } catch (err) {
    return { rows: inJournalOrder(rows), complete: false, error: sqliteMessage(err) };
  }
}

function inJournalOrder(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const n = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));
  return [...rows].sort(
    (a, b) => n(a.journal_epoch) - n(b.journal_epoch) || n(a.box_seq) - n(b.box_seq),
  );
}

/**
 * What an error SQLite threw says about the store: `damaged` for its
 * "database disk image is malformed" (SQLITE_CORRUPT), `unreadable` for
 * anything else — not a database, a read or a write the card refused, a file
 * that cannot be opened. One rule for every place a store is looked at, opened
 * or prepared, so the same fault is never named two ways.
 */
export function sqliteProblemOf(err: unknown): SqliteStoreProblem {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  // Extended codes carry the primary one in their low byte.
  return typeof code === 'number' && (code & 0xff) === SQLITE_CORRUPT ? 'damaged' : 'unreadable';
}

/** SQLite's primary result codes for a write that met another writer's lock. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/**
 * SCRUM-502 — whether SQLite refused a write only because another write held
 * the store at that moment: the box's one connection already inside another
 * press's transaction (`cannot start a transaction within a transaction`), or
 * the file locked past `busy_timeout`. Nothing of the refused write was kept,
 * so the same write may be made again once the other one has finished. Any
 * other fault is not this, and is never read as it.
 */
export function sqliteWriterBusy(err: unknown): boolean {
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  if (!e || e.code !== 'ERR_SQLITE_ERROR') return false;
  if (typeof e.errcode === 'number' && [SQLITE_BUSY, SQLITE_LOCKED].includes(e.errcode & 0xff)) return true;
  return typeof e.message === 'string' && e.message.includes('cannot start a transaction within a transaction');
}

/** The error's own words, one line: `file is not a database`, `database disk image is malformed`. */
export function sqliteMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n')[0]!.slice(0, 300);
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
