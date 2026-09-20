import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { edge, idPk } from './helpers';
import { account } from './tenancy';
import { box } from './fleet';

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
      sql`${t.kind} in ('test_print','config_apply','clear_cache','collect_logs','restart','go_offline','go_online','reset_store')`,
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
