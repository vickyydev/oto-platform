import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { edge, idPk } from './helpers';
import { account, operator } from './tenancy';
import { box, device, station } from './fleet';

// --- Box-owned state (schema `edge`) ---------------------------------------
//
// S2-04 opens this schema with the two tables that make a box visible from the
// cloud: what somebody asked it to do, and what it said about itself. S2-05
// added the sync core beside them — the station session document, the outbox,
// the ledger, quarantine and the change feed — in `sync.ts`, which is a
// separate file for size rather than for any boundary: it is the same `edge`
// schema and the two are read together.
//
// Both tables are telemetry rather than business record, and both grow on a
// timer rather than on a sale, so both are written knowing a sweep will delete
// from them: they are indexed by age, and the questions the Console asks of
// them are bounded by a box and a date range rather than open scans.

/**
 * What the cloud can ask a box to do.
 *
 * `config_apply` re-pulls the station bundle, `clear_cache` throws the cached
 * catalogue and members away and pulls them whole, `reset_store` wipes the
 * box's store and mints a new journal epoch — the destructive one, which the
 * Console gates behind typed confirmation and refuses while the outbox is
 * unsynced.
 *
 * `simulate` (S2-06) is every instruction the Console's Simulators panel
 * sends: inject a paper-out, clear a fault, deliver a scan, press the counter
 * button. **One kind rather than one per action**, because this list is a CHECK
 * constraint and therefore a migration per addition, while the simulator grows
 * with every device ticket left in the sprint — the gate, the terminals, the
 * kiosk. The discrimination lives in `payload`, validated by
 * `SimulateCommandPayloadSchema` in `@oto/shared`, where extending it costs
 * nothing. `edge.sync_event.type` was left un-CHECKed for the same reason.
 *
 * Some simulator actions carry a secret — presenting a badge, typing a PIN,
 * setting the approval code a simulated terminal will print — and `payload` is
 * a stored column the Console renders, so those must not travel this way as
 * they stand. `SIMULATOR_ACTIONS_WITH_SECRETS` names them.
 *
 * `terminal_sale` and `drawer_kick` (S2-10a) are the two additions the
 * simulator's one-kind rule does NOT cover, and the reason is that neither is a
 * pretence: a tender really is sent to a terminal on a serial cable, and the
 * drawer really does open. They are ordinary work for the box, with an outcome
 * a person is waiting on at a counter.
 *
 * `terminal_sale` carries no result of its own. The terminal's answer travels
 * back on its own route — `POST /payments/attempts/:id/result` — exactly as a
 * print job's outcome does, because the answer can take the whole 120-second
 * customer-interaction budget to arrive and a command ack cannot wait that long.
 */
export const BOX_COMMAND_KINDS = [
  'test_print',
  'config_apply',
  'clear_cache',
  'collect_logs',
  'restart',
  'go_offline',
  'go_online',
  'reset_store',
  'simulate',
  'terminal_sale',
  'terminal_settle',
  'drawer_kick',
] as const;
export type BoxCommandKind = (typeof BOX_COMMAND_KINDS)[number];

/**
 * A command's life.
 *
 * `running` is kept as a state a command can be left in rather than being
 * collapsed into a failure, for the same reason `ops_last` keeps it: a command
 * the box took and never reported on is the most useful thing the Console
 * could show about that box, and it is a different fact from one that failed.
 * `expired` is what the sweep does to a command a box never came back for —
 * a test print queued for a box that was offline all week must not fire when
 * it finally wakes up.
 */
export const BOX_COMMAND_STATES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
] as const;
export type BoxCommandState = (typeof BOX_COMMAND_STATES)[number];

export const boxCommand = edge.table(
  'box_command',
  {
    id: idPk(),
    /**
     * Restrict, and this is the foreign key that actually enforces "a box is
     * archived, never deleted": every other table hanging off a box either
     * cascades or can be pruned, so if a delete is ever attempted this is
     * where it fails, loudly, before anything is lost.
     */
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<BoxCommandKind>().notNull(),
    /** Command arguments — which station to test-print on, how many log lines. */
    payload: jsonb('payload'),
    state: text('state').$type<BoxCommandState>().notNull().default('queued'),
    /**
     * Null for a command the watchdog raised on its own. Restrict, because an
     * instruction is always worth attributing and an account is never deleted.
     */
    requestedByAccountId: uuid('requested_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    /**
     * `x-oto-action-id`, minted where the person pressed the button and carried
     * cloud -> box -> back. It is what ties this row to the Box log drawer and
     * to the `ops_run` the result writes. There is no foreign key to `ops_run`
     * on purpose: runs are pruned after a month and this history outlives them.
     */
    actionId: text('action_id'),
    /** Bumped when a poll hands the command out; a loop is visible rather than silent. */
    attempts: integer('attempts').notNull().default(0),
    claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    /** After this, the sweep marks it `expired` rather than letting it fire late. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    result: jsonb('result'),
    errorCode: text('error_code'),
    /** Truncated and scrubbed, as `ops_run.error_message` is — it is read on a Console page. */
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * The poll, which every box runs every few seconds: the oldest queued
     * command for one box. Partial, so the index holds only work outstanding
     * rather than every command ever run.
     */
    index('box_command_poll_idx')
      .on(t.boxId, t.createdAt)
      .where(sql`state = 'queued'`),
    /** The command-history panel: one box, newest first. */
    index('box_command_history_idx').on(t.boxId, t.createdAt),
    /** The expiry sweep. */
    index('box_command_expires_idx').on(t.expiresAt),
    index('box_command_action_idx').on(t.actionId),
    index('box_command_requested_by_idx').on(t.requestedByAccountId),
    check(
      'box_command_kind_check',
      sql`${t.kind} in ('test_print','config_apply','clear_cache','collect_logs','restart','go_offline','go_online','reset_store','simulate','terminal_sale','terminal_settle','drawer_kick')`,
    ),
    check(
      'box_command_state_check',
      sql`${t.state} in ('queued','running','succeeded','failed','expired','cancelled')`,
    ),
  ],
);

/**
 * One row per heartbeat: every 60 seconds, per box, forever.
 *
 * That is 1,440 rows a day per box — around half a million a year each — so
 * this table is a retention problem from the day it exists, not later.
 *
 * Two things keep it honest. The hot question, "is this box well right now",
 * is answered from `box.last_heartbeat_at` and `box.last_status` and never
 * touches this table at all; what is kept here is the 24-hour graph and the
 * look back after an incident. And `job:housekeeping.retention` in
 * `apps/api/src/services/jobs.ts` — the hourly job that already calls
 * `purgeOldOpsRuns` and `purgeResolvedAlerts` — gets a third call beside them,
 * deleting by `received_at` under a `BOX_HEARTBEAT_RETENTION_DAYS` of 14.
 * `box_heartbeat_received_idx` exists for that delete as much as for any read:
 * without it the sweep degrades into a sequential scan of the largest table in
 * the `edge` schema, every hour.
 */
export const boxHeartbeat = edge.table(
  'box_heartbeat',
  {
    id: idPk(),
    /**
     * The one cascade in this ticket, and a deliberate exception to the rule
     * stated in `fleet.ts`. A heartbeat says nothing without its box, it is
     * already thrown away on a schedule, and nobody will ever ask what the
     * temperature was on a box that no longer exists. The guard that actually
     * stops a box being deleted is `box_command`'s restrict, not this.
     */
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'cascade' }),
    /** When the cloud received it. Authoritative, because the box's clock may be wrong. */
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** When the box thinks it sent it. The difference is `clock_offset_ms`. */
    reportedAt: timestamp('reported_at', { withTimezone: true, mode: 'date' }),
    /**
     * Positive means the box is ahead. Watched because a box whose clock has
     * drifted stamps business dates wrongly on everything it queues offline,
     * and that is invisible until the day is reconciled.
     */
    clockOffsetMs: integer('clock_offset_ms'),
    agentVersion: text('agent_version'),
    uptimeS: integer('uptime_s'),
    /** Null on the virtual box, which has no thermometer — not zero, which would read as cold. */
    tempC: real('temp_c'),
    /** Unsynced events waiting on the box. The number that says whether offline is safe. */
    outboxDepth: integer('outbox_depth'),
    /**
     * The rest of the report as the box sent it, redacted: device reachability
     * and paper, lease holders, error fingerprints. Held whole rather than
     * split into columns because it is read as one document on the Health
     * drawer and its shape still moves with S2-05 and S2-06.
     */
    payload: jsonb('payload'),
  },
  (t) => [
    /** The 24-hour drawer: one box, newest first. */
    index('box_heartbeat_box_received_idx').on(t.boxId, t.receivedAt),
    /** The retention sweep's delete, and nothing else. */
    index('box_heartbeat_received_idx').on(t.receivedAt),
  ],
);

// --- What a box keeps for ITSELF (S2-07a) -----------------------------------
//
// Everything above this line is the cloud's record OF a box: what somebody
// asked it to do, and what it reported. The five tables below are the box's own
// working state — the print queue that still owes somebody a piece of paper,
// the counters a daily cap is read from, who is signed in at a booth, the PINs
// typed wrongly, and a couple of singletons the box must not forget over a
// power cut.
//
// They exist in two dialects. A Raspberry Pi keeps them in a SQLite file its
// own boot creates (`prepareSqliteBoxStore`); the virtual box runs inside the
// api and its store IS this schema. ONE implementation drives both —
// `SqlBoxStore` in `packages/box-agent/src/store-sql.ts` — so the columns here
// are a transcription rather than a design: `EDGE_BOX_LOCAL_TABLES_SQL` in that
// same file is the Postgres DDL its queries were written against, and this is
// that DDL in Drizzle, so `pnpm db:generate` and `scripts/verify-schema.ts` can
// both see the tables instead of finding them conjured at runtime. A column
// spelled differently on one side than the other is a box that behaves
// differently from its stand-in; where that would surface is
// `apps/api/test/print-restart.test.ts`, which drives the store over THIS
// schema and writes every one of these five tables.
//
// Until the migration that generated these, the tables were simply absent from
// `edge`. On staging that meant `features()` reported both false: the durable
// print queue fell back to memory, and every booth counter, staff session and
// throttle read threw `BoxStoreFeatureMissingError`. A Pi never hit it, which
// is exactly why it could have shipped.
//
// **No `created_at` on any of them**, and the omission is the SQLite mirror's
// too. These are working rows, not business records: a print job carries
// `queued_at`, a throttle carries `first_failure_at`, and the rest are
// last-writer rows whose whole content is their current value. A `created_at`
// here would be a column nothing writes and nothing reads, differing from the
// Pi's table for the sake of a convention about the record.

/**
 * What a box-local print job is doing. The same three words as
 * `BOX_PRINT_JOB_STATES` in `@oto/box-agent`, repeated because `@oto/db` does
 * not depend on that package — and the CHECK below is the copy the database
 * enforces, so a fourth state added on the agent side is refused at the insert
 * rather than stored and puzzled over later.
 *
 * There is no terminal state because a finished job is DELETED. `edge.print_job`
 * beside it is the history, with the Console page and the 90-day sweep; this
 * table is the outstanding work, which is also what keeps a guest's name and a
 * child's allergy line off a box in a storeroom for any longer than the paper
 * takes to come out.
 *
 *   - `queued`      — waiting: for its turn, for paper, for the next retry.
 *   - `sending`     — bytes are going at a printer right now.
 *   - `interrupted` — it was `sending` when the process died (D12). Never
 *     retried, because some of that voucher is already paper; it waits to be
 *     reported and deleted.
 */
export const BOX_PRINT_JOB_STATES = ['queued', 'sending', 'interrupted'] as const;
export type BoxPrintJobState = (typeof BOX_PRINT_JOB_STATES)[number];

/**
 * The box's own print queue.
 *
 * `id` is the `edge.print_job` id, minted where the job was raised, so the row
 * here and the row in the cloud are the same job under the same name — which is
 * what lets a restarted box report the outcome of work the cloud still shows as
 * queued.
 *
 * `job` is the renderer's INPUT, stored whole, and that is the difference from
 * `edge.print_job`, which deliberately stores nothing rendered. The point of
 * this table is that a voucher waiting on paper still prints after the power
 * has been off, and it cannot if what to print was only ever in memory. The
 * protection is lifetime, not redaction: the row is deleted the moment the
 * paper is out of the machine.
 *
 * `template_id` carries NO foreign key, unlike its namesake in
 * `edge.print_job`. A template archived in the cloud, or swept, must not be
 * able to stop a voucher somebody is standing waiting for; the id is stamped
 * here as a record of what was applied, and the Pi's table cannot hold a
 * foreign key into `pos` at all.
 */
export const boxPrintJob = edge.table(
  'box_print_job',
  {
    /** UUIDv7, minted with the job — on the box, or in the service that queued it. */
    id: idPk(),
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    /** One of `PRINT_KINDS` in `@oto/shared`. Text here: the vocabulary is not this table's. */
    kind: text('kind').notNull(),
    /** Which `station_device` role chose the printer — `receipt`, `kids_band`, `voucher`. */
    role: text('role'),
    /** Null for a job that belongs to the box rather than to a station — a test page. */
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    /** The printer the last attempt went to, so an interrupted job can name it. */
    deviceId: uuid('device_id').references(() => device.id, { onDelete: 'restrict' }),
    copies: smallint('copies').notNull().default(1),
    job: jsonb('job').notNull(),
    /** Cut and feed: what the head should do once the last line is out. */
    finish: jsonb('finish'),
    templateId: uuid('template_id'),
    templateVersion: integer('template_version'),
    /** `x-oto-action-id`, minted where the person tapped and carried through. */
    actionId: text('action_id'),
    state: text('state').$type<BoxPrintJobState>().notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    /** Backoff with jitter: the queue takes only jobs that are due. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    /** This table's `created_at`, under the name the queue reads it by. */
    queuedAt: timestamp('queued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    /** The recovery read at every boot and every tick: one box, oldest first. */
    index('box_print_job_pending_idx').on(t.boxId, t.queuedAt),
    index('box_print_job_station_idx').on(t.stationId),
    index('box_print_job_device_idx').on(t.deviceId),
    check('box_print_job_state_check', sql`${t.state} in ('queued','sending','interrupted')`),
    check('box_print_job_copies_check', sql`${t.copies} > 0`),
    check('box_print_job_attempts_check', sql`${t.attempts} >= 0`),
  ],
);

/**
 * Counters for one trading day: spins, and spins per prize.
 *
 * A `date` and not a timestamp, because the park's day starts at
 * `branch.business_day_start` and not at midnight — a spin at one in the
 * morning belongs to the evening that is still going on, and a cap read against
 * the wrong day is a prize given away twice.
 *
 * `scope` and `counter_key` are a pair rather than a column per thing counted,
 * so the booth's second counter costs a row instead of a migration. No CHECK on
 * `scope`: the vocabulary is still moving with the sprint, and `edge.sync_event
 * .type` was left open for the same reason.
 *
 * THE SCOPES IN USE. `booth` and `booth_prize` are the spin caps (S2-07), and
 * S2-10a adds `terminal_ref` (`TERMINAL_REF_COUNTER_SCOPE` in `@oto/shared`),
 * with `counter_key` set to the DEVICE id: the reference a payment terminal is
 * sent — a 12-character `pos_ref_no` for GHL, six digits for Digio — must be
 * unique per terminal per day, and that is this table's primary key rather than
 * a new one. `BoxStore.bumpCounter` already mints it atomically, so the whole
 * of the ticket's `terminal_counter (device_id, next_ref)` is this sentence:
 * no table, no migration, no store change, and the daily reset comes free.
 * Voids and inquiries draw from the same counter — both vendors require a
 * fresh reference for a void, never the original sale's.
 *
 * The primary key leads with `box_id`, which is also the index the foreign key
 * needs, and its `(box_id, scope)` prefix is what `readCounters` scans for a
 * whole day's prizes.
 */
export const boxCounter = edge.table(
  'box_counter',
  {
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    /** `booth`, `booth_prize` — what is being counted. */
    scope: text('scope').notNull(),
    /** What within the scope: a prize id, a station id, or the scope's one total. */
    counterKey: text('counter_key').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    counterValue: integer('counter_value').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.boxId, t.scope, t.counterKey, t.businessDate] })],
);

/**
 * Who is signed in at a station, kept where a restart cannot lose it.
 *
 * One row per station: signing in replaces whoever was there, because two
 * people signed in at one booth is not a state the screen could show. The
 * station's own id is the primary key, which is what makes that a property of
 * the table rather than a rule somebody remembered to apply.
 *
 * `staff_code` is the lookup value the sign-in resolved, where there is one — a
 * badge number, a staff code. The credential itself is never here: `core
 * .credential` holds the argon2id hash, and a PIN or a badge is verified by
 * iterating the booth's allowed staff and verifying against those (D18). This
 * row is only the answer.
 */
export const boxStaffSession = edge.table(
  'box_staff_session',
  {
    stationId: uuid('station_id')
      .primaryKey()
      .references(() => station.id, { onDelete: 'restrict' }),
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    /** How they proved it: `pin`, `badge`, `password`. What the booth shows and the fact records. */
    credentialKind: text('credential_kind').notNull().default('pin'),
    staffCode: text('staff_code'),
    signedInAt: timestamp('signed_in_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Bumped on activity; what an idle sign-out is measured from. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Null for a session that ends only when somebody signs out. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    /** "Who is signed in across this box", and the index `box_id`'s key needs. */
    index('box_staff_session_box_idx').on(t.boxId),
    index('box_staff_session_account_idx').on(t.accountId),
  ],
);

/**
 * Failed sign-ins, counted on disk.
 *
 * In memory a lockout would last until somebody pulled the booth's power lead,
 * which is not a lockout. `failures` moves inside the upsert, so two wrong PINs
 * typed at once count as two.
 *
 * `subject` is text and carries no foreign key: what is being throttled is a
 * station id today and may be a badge number or an account tomorrow, and a
 * constraint cannot express a column whose type changes per row — the same rule
 * `sync_quarantine.event_id` follows.
 */
export const boxThrottle = edge.table(
  'box_throttle',
  {
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    /** `booth_pin`, `booth_badge` — which attempt is being counted. */
    scope: text('scope').notNull(),
    subject: text('subject').notNull(),
    failures: integer('failures').notNull().default(0),
    firstFailureAt: timestamp('first_failure_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true, mode: 'date' }).notNull(),
    /**
     * Null until a policy sets one. `recordThrottleFailure` coalesces it, so a
     * later failure that names no lock leaves the one already on the row — which
     * is what lets a policy that locks on the fifth failure say nothing about
     * the sixth without lifting its own lock.
     */
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.boxId, t.scope, t.subject] }),
    check('box_throttle_failures_check', sql`${t.failures} >= 0`),
  ],
);

/**
 * Small singletons the box owns, as key and value.
 *
 * One key so far: `last_good_time`, the latest instant this box has reason to
 * believe in. It is how a Pi whose clock battery is dead can tell that the time
 * it booted with is behind a moment it has already lived through, and it is
 * what stops the business day moving backwards (D11). Forward-only is decided
 * in `markTimeSeen`'s statement, not here — the column holds any text, and
 * nothing but that method writes this key.
 *
 * A key/value table rather than a column per setting because these are the
 * box's own scratch notes, added and dropped by whichever ticket needs one; a
 * value worth a column of its own belongs in `box_state` beside the journal
 * counter, where it can be typed and constrained.
 */
export const boxRuntime = edge.table(
  'box_runtime',
  {
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    runtimeKey: text('runtime_key').notNull(),
    /** Text in both dialects: SQLite has no timestamp, and every value so far is an ISO instant. */
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.boxId, t.runtimeKey] })],
);

/**
 * The copy of the cloud a box is holding (SCRUM-275).
 *
 * One row per scope of `GET /box/v1/cache`: the staff list and the deny-list an
 * offline unlock is decided from, the catalogue a cart is priced against, the
 * members a counter can identify, the booth's published wheel. A scope is
 * applied WHOLE — `payload` is the whole document, never a page of it — because
 * half a staff list silently refuses the people who fell off the end of it and
 * half a catalogue prices the wrong ticket.
 *
 * WHY IT IS A TABLE. A Pi has held these in SQLite since S2-05 and they survive
 * a power cut; the virtual box that runs inside the api held them in a `Map` on
 * `SqlBoxStore`, so every Render deploy threw the staff list and the deny-list
 * away until the next pull. A revocation is the sharp half of that: the box
 * decides an offline unlock from ITS copy, so a box with no copy is a box that
 * refuses everybody, and a box that re-pulls without the deny-list is worse.
 *
 * `operator_id` is here rather than on the debt list its nine siblings in this
 * schema are on (`packages/db/test/schema-shape.test.ts`). Those carry only
 * `box_id` and the column is owed on each of them; adding it once the boxes are
 * in the field means a backfill against rows that are still arriving. A table
 * born today is born conforming, and its writer already knows the operator: the
 * upsert takes it from `core.box` in the same statement.
 *
 * The primary key leads with `box_id`, which is also the index the box's foreign
 * key needs and the scan "everything this box is holding" reads — the same shape
 * `box_counter` above is keyed in.
 */
export const boxCache = edge.table(
  'box_cache',
  {
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    /** A `SyncChangeScope` — `staff`, `deny_list`, `catalogue`, `members`, `booth`, … */
    scope: text('scope').notNull(),
    /** `BOX_STORE_SCHEMA_VERSION` as the writing agent understood it. A newer one is dropped, not half read. */
    schemaVersion: integer('schema_version').notNull().default(1),
    /** `edge.sync_change.seq` this copy is current to. */
    cursorSeq: bigint('cursor_seq', { mode: 'number' }).notNull().default(0),
    payload: jsonb('payload').notNull(),
    /** When the box applied it — what the till's "cache is this old" banner reads. */
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.boxId, t.scope] }),
    index('box_cache_operator_idx').on(t.operatorId),
  ],
);

/**
 * What a counter box recorded while it could not reach the platform
 * (plan `offline/PLAN.md` §2.3, Round 3).
 *
 * A member signed up, a child added or corrected, a visit confirmed — each is a
 * fact in the outbox, and each is ALSO a row here, written in the same store
 * transaction, so the next lookup at this counter finds the family it just
 * signed up. Lookup reads the `members` scope of `box_cache` with this laid
 * over it; once the fact is acknowledged and a later pull brings the
 * platform's own copy of the record, the row here has done its job and is
 * pruned.
 *
 * `kind` is one of three, and the record is built from the fact's own
 * payload, so what a counter shows offline is what the platform will be told. `phone` is
 * the member's number in E.164, set on a `member` row only, and is what a
 * lookup by phone reads; `member_id` names the guardian on a `child` or
 * `visit` row, and has no foreign key because the member it names may exist
 * only on this box until the next sync.
 *
 * Born with `operator_id`, as `box_cache` beside it was: the writer already
 * knows the operator, and a table added later with no tenancy column is the
 * debt `schema-shape.test.ts` lists for the older edge tables.
 */
/**
 * S2-13 round 4 (migration 0044): a counter box also keeps the check-in domain
 * offline — a registration, a stay, a person on a pickup list, a release —
 * with the registration's id in `member_id` so one family's rows list together.
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

export const boxOverlay = edge.table(
  'box_overlay',
  {
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<BoxOverlayKind>().notNull(),
    /** The till-minted id of the member, child or visit. */
    entityId: uuid('entity_id').notNull(),
    /** The guardian, on a child or visit row; the member itself on a member row. */
    memberId: uuid('member_id'),
    /** E.164, on a member row only: what a lookup by phone reads. */
    phone: text('phone'),
    /**
     * `{ record, eventId }`: the entity as this counter now knows it, and the
     * outbox event that last changed it — what a prune asks the outbox about
     * before letting the cache speak for the record again.
     */
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.boxId, t.kind, t.entityId] }),
    index('box_overlay_operator_idx').on(t.operatorId),
    index('box_overlay_phone_idx').on(t.boxId, t.phone),
    index('box_overlay_member_idx').on(t.boxId, t.memberId),
    check(
      'box_overlay_kind_check',
      sql`${t.kind} in ('member','child','visit','registration','checkin','guardian','release')`,
    ),
    check(
      'box_overlay_phone_check',
      sql`${t.phone} is null or ${t.phone} ~ '^\\+[1-9][0-9]{6,14}$'`,
    ),
  ],
);
