import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { edge, idPk } from './helpers';
import { account, branch, operator } from './tenancy';
import { box, deviceCredential, station } from './fleet';

// --- The sync core (schema `edge`) -----------------------------------------
//
// S2-05. The box is the system of action and the cloud is the system of record
// (R-11), and this file is the joint between them. Four things live here:
//
//   the station session document  what is happening at one till right now,
//                                 with the lease that says who may change it
//   the outbox and the ledger     every fact a box produced, on its way up
//   quarantine and anomalies      the facts that could not be applied, and the
//                                 ones that were applied with a caveat
//   the change feed and cursor    what a box has to pull, and where it got to
//
// Two properties decide almost every choice below.
//
// **A box that loses the answer to a push re-sends.** Not occasionally — every
// time a mall's cellular link drops mid-request, which is the normal condition
// this design exists for. So a replayed batch must be cheap, must be provably
// idempotent, and must stay both after the ledger has been swept. That is what
// `sync_cursor` is for: the duplicate check is an integer comparison against
// one row the push already holds, not two hundred probes into a table with a
// year of rows in it.
//
// **The ledger is a record of transport, not the business record.** What an
// event CREATED — the sale, the member, the payment — lives in `pos` and `crm`
// and is never pruned. The envelope's value decays; the thing it created does
// not. That is what makes a retention policy on `sync_event` safe, and it is
// why the cursor, which never expires, is what keeps dedupe correct for ever.
//
// **ON DELETE.** S2-04 made every `core` foreign key restrict, with one
// cascade on `box_heartbeat` because it is prunable by definition. The same
// line is drawn here and it is drawn by what the row is EVIDENCE of, not by
// whether it is swept:
//
//   cascade   `station_event` — thirty days of intents and snapshots about a
//             box that no longer exists is worth nothing to anybody.
//   restrict  everything else. `sync_event` is swept on a dated policy after a
//             year; that is a deliberate act with a number attached to it. A
//             cascade would take the same rows away as a side effect of
//             somebody deleting a box, which is not the same thing at all.
//
// And a rule that falls out of retention: **a long-lived table never holds a
// foreign key into a shorter-lived one.** `sync_quarantine.event_id`,
// `sync_anomaly.event_id` and `core.audit_log.source_event_id` are plain uuids
// with no constraint, for the reason `box_command.action_id` carries no key to
// `ops_run` — the pointer has to outlive what it points at.

/**
 * How much the cloud believes the box's own clock when it stamped the event.
 *
 * A Pi has no clock battery (PLATFORM_PLAN §7.8). A box that came up after a
 * power cut with a 1970 clock, or one whose NTP never reached the internet,
 * stamps `occurred_at` wrongly on everything it queues — and on a business
 * that closes after midnight, a wrong timestamp silently moves a sale into the
 * wrong trading day. `skewed` is a measurable offset the box reported;
 * `untrusted` is a box that could not say what time it was at all.
 */
export const SYNC_CLOCK_TRUST = ['trusted', 'skewed', 'untrusted'] as const;
export type SyncClockTrust = (typeof SYNC_CLOCK_TRUST)[number];

/** Which timestamp the stored `business_date` was actually computed from. */
export const BUSINESS_DATE_SOURCES = ['occurred_at', 'received_at'] as const;
export type BusinessDateSource = (typeof BUSINESS_DATE_SOURCES)[number];

/** Who did the thing the event records. */
export const SYNC_ACTOR_KINDS = ['account', 'device', 'box', 'system'] as const;
export type SyncActorKind = (typeof SYNC_ACTOR_KINDS)[number];

/**
 * The envelope shape, so an event queued before an upgrade can be read after
 * one. The box writes the version it minted the row under and the reader
 * migrates on read — for the document, the cache bundle and the outbox alike.
 * Bumped when a field changes meaning, not when one is added.
 */
export const SYNC_EVENT_SCHEMA_VERSION = 1;

/**
 * Every fact a box has produced and the cloud has accepted.
 *
 * **UNIQUE (box_id, journal_epoch, box_seq) is the spine of the whole design.**
 * Everything else here is a convenience; this is the property that makes the
 * system safe to retry, and it is worth being explicit about why, because it
 * is not the obvious constraint — `event_id` alone would also stop a
 * double-insert.
 *
 * `box_seq` is a gapless counter the box mints inside the same transaction
 * that queues the event, so the triple is the box's own journal position:
 * "this is the 4,812th thing box 1 has done since its store was last reset".
 * Three things follow, and none of them follow from a unique id alone:
 *
 *   1. **A replay is recognisable without reading the payload.** The cursor
 *      holds the highest `box_seq` applied for that (box, epoch); anything at
 *      or below it has already been dealt with, whatever id it carries and
 *      whether or not its ledger row still exists. That is what lets this
 *      table be swept at all.
 *   2. **A gap is visible.** If seq 4,810 never arrives, the ledger says so.
 *      An id-keyed log cannot tell a missing event from one that was never
 *      created, so a store corruption on the box would be silent.
 *   3. **A wiped store cannot be confused with a live one.** "Reset store"
 *      mints epoch N+1, and a box replaying epoch N's journal after a reset
 *      collides with nothing and is rejected on the epoch rather than
 *      overwriting a sale that shares a sequence number by coincidence.
 *
 * Without the epoch in the key, (2) and (3) fight each other: a reset restarts
 * `box_seq` at 1 and every sequence number in the ledger becomes ambiguous.
 * With it, the triple is unique for the life of the park.
 *
 * **Size, after a year.** The park runs seven days a week; a branch producing
 * on the order of 5,000 events a day — sales, lines, payments, bands, prints,
 * passages, check-ins — reaches roughly 1.8 million rows a year. That is 0.06
 * inserts a second, so the nine indexes below cost nothing worth measuring on
 * the write path. What does grow is the heap: at a kilobyte of payload that is
 * around 2 GB a year, against a `basic_4gb` Postgres. The journal index itself
 * stays small (~30 bytes a row, under 100 MB a year) and, because `box_seq`
 * only ever increases, inserts land on the right-hand edge of the btree and
 * never rewrite an older page. So the heap is what retention is for, and the
 * index is what stays fast regardless.
 *
 * **Retention: 365 days**, swept by `job:housekeeping.retention` in
 * `apps/api/src/services/jobs.ts` beside `purgeOldOpsRuns` and
 * `purgeOldBoxHeartbeats`, deleting by `received_at` under a
 * `SYNC_EVENT_RETENTION_DAYS`. A year because that is the window in which
 * somebody still asks "what did counter 2 send on Songkran", it matches the
 * platform's existing stance on the audit log (PROJECT_CONTEXT §9), and past
 * it the envelope adds nothing the sale itself does not already say. Dedupe
 * does not depend on the sweep's window, because the cursor outlives it.
 */
export const syncEvent = edge.table(
  'sync_event',
  {
    /**
     * Minted on the box, in the transaction that queued the fact (UUIDv7, so
     * it sorts by time). Named `event_id` rather than `id` because the same
     * value appears in `sync_quarantine`, `sync_anomaly` and
     * `core.audit_log.source_event_id`, and one name across four tables is
     * what makes the correlation obvious to somebody reading a query.
     */
    eventId: uuid('event_id').primaryKey(),
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    /** `core.box.current_epoch` as it stood when the box queued this. */
    journalEpoch: integer('journal_epoch').notNull(),
    /** The box's gapless journal position within that epoch. */
    boxSeq: bigint('box_seq', { mode: 'number' }).notNull(),
    /**
     * `member.created`, `sale.completed`, `gate.passage`. Deliberately NOT a
     * CHECK against a fixed list: every ticket from here to S2-19 adds types,
     * and a vocabulary that needs a migration per ticket is a vocabulary
     * people work around. The shape is constrained instead — `entity.verb` —
     * and the list itself is a zod union in `@oto/shared`, validated at the
     * API boundary the way the catalogue jsonb already is.
     */
    type: text('type').notNull(),
    schemaVersion: integer('schema_version').notNull().default(SYNC_EVENT_SCHEMA_VERSION),
    /** When the box says it happened. Never overwritten, even when disbelieved. */
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** When the cloud took it. Authoritative, because this clock is known good. */
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    clockTrust: text('clock_trust').$type<SyncClockTrust>().notNull().default('trusted'),
    /**
     * The box's clock offset in milliseconds as last measured, positive when
     * the box is ahead. Kept on the event rather than only on the heartbeat so
     * that a batch reconciled months later can be read without hunting for the
     * heartbeat that was current when it was queued.
     */
    clockOffsetMs: integer('clock_offset_ms'),
    /**
     * Which trading day this belongs to, resolved once on receipt from
     * `branch.business_day_start` (see `businessDate` in `@oto/shared`).
     * Stored rather than derived because every reconciliation and rollup reads
     * it and none of them should re-derive a park's 05:00 boundary.
     */
    businessDate: date('business_date').notNull(),
    /**
     * **This is what makes a recomputation visible instead of silent.** With
     * `clock_trust` of `skewed` or `untrusted` the cloud recomputes the
     * business date from `received_at` and writes `received_at` here; a
     * `sync_anomaly` of kind `clock_recomputed` records both candidate dates
     * beside it. Between the three columns — `occurred_at` untouched,
     * `business_date` resolved, `business_date_source` naming which clock won
     * — a day's takings that look wrong can be explained from the row itself,
     * months later, without re-deriving anything.
     */
    businessDateSource: text('business_date_source')
      .$type<BusinessDateSource>()
      .notNull()
      .default('occurred_at'),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    /**
     * Denormalised onto this table and `sync_change` — and only these two —
     * because they are the ones the Console filters by branch over a date
     * range. Quarantine and anomalies reach their tenancy through `box_id`,
     * which is free at their size.
     */
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** Null for a box-wide fact: a cache pull, a config apply, a clock report. */
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    actorKind: text('actor_kind').$type<SyncActorKind>().notNull().default('account'),
    /**
     * The staff account, resolved on the box from its cached staff bundle. An
     * event naming an account the cloud has never heard of fails this key,
     * rolls back its own SAVEPOINT and lands in quarantine as
     * `actor_unknown` — which is the right outcome: an unattributable sale is
     * a thing a person should look at, not a row to wave through.
     */
    actorAccountId: uuid('actor_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    /** Set instead when a display, kiosk or booth acted on its own credential. */
    actorCredentialId: uuid('actor_credential_id').references(() => deviceCredential.id, {
      onDelete: 'restrict',
    }),
    /**
     * `x-oto-action-id`, minted where the person tapped and carried PWA -> box
     * -> cloud. One value ties the till line, the Box log drawer, the
     * `ops_run` for the batch and the audit row this event wrote.
     */
    actionId: text('action_id'),
    /** The fact itself. Shape is per `type` and validated by zod before apply. */
    payload: jsonb('payload').notNull(),
    /**
     * SHA-256, lower-case hex, over the canonical JSON of the envelope's
     * stable fields (event id, box, epoch, seq, type, schema version,
     * occurred_at, actor, action id, payload).
     *
     * **Its job is identity, not authenticity.** It answers one question: is
     * this re-sent event the SAME event? Same id and same hash is a duplicate
     * and is dropped without a word, because that is the expected shape of a
     * lost acknowledgement. Same id and a DIFFERENT hash is two different
     * facts wearing one identity — a box that regenerated an event after a
     * crash, a half-written payload, a queue migrated wrongly — and is
     * quarantined rather than resolved by picking one, because picking one
     * silently loses a sale. It protects against accidental divergence; it
     * protects against nothing an attacker does, since anyone who can change
     * the payload can recompute the hash.
     */
    payloadHash: text('payload_hash').notNull(),
    /**
     * Detached signature over the same canonical bytes, **Ed25519 by default**
     * (`sig_alg`), verified against `core.box.sync_public_key`.
     *
     * **Its job is provenance.** It answers the other question: did this come
     * from that box? It protects against a forged or tampered batch — someone
     * on the park LAN, or anyone who reaches the public `/box/v1` surface —
     * and it is a separate job from the hash, which is why there are two
     * columns: an attacker who rewrites the payload can recompute
     * `payload_hash` and cannot produce `sig`.
     *
     * Ed25519 rather than the HMAC the ticket sketches, because S2-04 stores
     * only SHA-256 of the per-box secret (`core.box.secret_hash`) and a hash
     * cannot verify an HMAC. Keeping the ticket's wording would mean storing a
     * second, recoverable per-box secret — a credential in the database that
     * forges a box's entire history if the database leaks. With a keypair the
     * box holds the private half and the cloud holds only the public one, so
     * there is nothing here to steal. Recorded as a departure from the ticket.
     *
     * Verification happens ONCE, at push. What is stored is evidence, not
     * something re-checked later, which is why a box that rotates its keypair
     * does not invalidate its own history.
     */
    sig: text('sig').notNull(),
    sigAlg: text('sig_alg').notNull().default('ed25519'),
    /** The `ops_run` for the push batch this arrived in, for the Raw record panel. */
    batchId: text('batch_id'),
  },
  (t) => [
    /** The spine. See the note above the table — this is the constraint the design rests on. */
    uniqueIndex('sync_event_journal_unique').on(t.boxId, t.journalEpoch, t.boxSeq),
    /** The retention sweep's delete, and "what has arrived in the last hour". */
    index('sync_event_received_idx').on(t.receivedAt),
    /** Reconciliation: everything that belongs to one trading day at one branch. */
    index('sync_event_branch_business_idx').on(t.branchId, t.businessDate),
    /** Following one action across the till, the box and the cloud. */
    index('sync_event_action_idx').on(t.actionId),
    index('sync_event_operator_idx').on(t.operatorId),
    index('sync_event_station_idx').on(t.stationId),
    index('sync_event_actor_account_idx').on(t.actorAccountId),
    index('sync_event_actor_credential_idx').on(t.actorCredentialId),
    check('sync_event_seq_check', sql`${t.boxSeq} > 0`),
    check('sync_event_epoch_check', sql`${t.journalEpoch} > 0`),
    check('sync_event_schema_version_check', sql`${t.schemaVersion} > 0`),
    /** `entity.verb`, lower snake case. Cheap, and it catches a garbage type. */
    check('sync_event_type_check', sql`${t.type} ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'`),
    check('sync_event_clock_trust_check', sql`${t.clockTrust} in ('trusted','skewed','untrusted')`),
    check(
      'sync_event_business_date_source_check',
      sql`${t.businessDateSource} in ('occurred_at','received_at')`,
    ),
    check('sync_event_actor_kind_check', sql`${t.actorKind} in ('account','device','box','system')`),
    /** Fixed width, lower case: a hash that is not one of those is a bug upstream. */
    check('sync_event_payload_hash_check', sql`${t.payloadHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Where a box is in both directions, per journal epoch.
 *
 * This is the smallest table in the file and the one that must never be
 * deleted from. It is the answer to "what makes a replayed batch cheap":
 *
 *   - `last_box_seq` is the high-water mark of what has been applied. A box
 *     re-sending 200 events costs ONE row read and 200 integer comparisons,
 *     rather than 200 index probes into the ledger.
 *   - It stays correct after the ledger has been swept. An event older than
 *     the retention window has no row left to compare hashes against, but its
 *     `box_seq` is still at or below the high-water mark, so it is still
 *     recognisably a replay and is still dropped. Without this table, pruning
 *     `sync_event` would silently re-open the door to double-applying a
 *     year-old sale.
 *   - A row per (box, epoch) rather than per box is what makes
 *     `sync.epoch_regressed` detectable: the epochs a box has lived through
 *     are all still here, closed, with their final sequence numbers.
 *
 * `pull_cursor_seq` sits on the same row because a store reset mints a new
 * epoch AND throws the cache away, so a box's position in both directions
 * resets together.
 */
export const syncCursor = edge.table(
  'sync_cursor',
  {
    id: idPk(),
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    journalEpoch: integer('journal_epoch').notNull(),
    /** Highest applied `box_seq`. The duplicate check, in one integer. */
    lastBoxSeq: bigint('last_box_seq', { mode: 'number' }).notNull().default(0),
    /** The event that set it, for the Raw record panel. No key: the ledger is swept. */
    lastEventId: uuid('last_event_id'),
    eventsApplied: bigint('events_applied', { mode: 'number' }).notNull().default(0),
    eventsDuplicate: bigint('events_duplicate', { mode: 'number' }).notNull().default(0),
    eventsQuarantined: bigint('events_quarantined', { mode: 'number' }).notNull().default(0),
    lastPushAt: timestamp('last_push_at', { withTimezone: true, mode: 'date' }),
    /** How far down `sync_change.seq` this box has pulled. */
    pullCursorSeq: bigint('pull_cursor_seq', { mode: 'number' }).notNull().default(0),
    lastPullAt: timestamp('last_pull_at', { withTimezone: true, mode: 'date' }),
    /** Set when a newer epoch supersedes this one; the row itself is kept for ever. */
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /** The lookup every push and every pull starts with. */
    uniqueIndex('sync_cursor_box_epoch_unique').on(t.boxId, t.journalEpoch),
    check('sync_cursor_epoch_check', sql`${t.journalEpoch} > 0`),
    check('sync_cursor_seq_check', sql`${t.lastBoxSeq} >= 0`),
    check('sync_cursor_pull_check', sql`${t.pullCursorSeq} >= 0`),
  ],
);

/** Why an event could not be applied. Bounded: widening it is a real decision. */
export const SYNC_QUARANTINE_REASONS = [
  /** Same event id already in the ledger with a different `payload_hash`. */
  'conflict',
  /** Malformed: the payload does not validate for its own `type`. */
  'poison',
  /** The epoch is older than `core.box.current_epoch` — a replay from a wiped store. */
  'epoch_regressed',
  /** `box_seq` skipped ahead; events were lost on the box. */
  'sequence_gap',
  /** A `type` the cloud has no handler for — usually a box newer than the api. */
  'unknown_type',
  /** `schema_version` above what this api can read. */
  'schema_too_new',
  /** The actor account or credential does not exist here. */
  'actor_unknown',
  /** `sig` did not verify against the box's public key. */
  'signature_invalid',
  /** The handler ran and threw; its SAVEPOINT rolled back. */
  'apply_failed',
] as const;
export type SyncQuarantineReason = (typeof SYNC_QUARANTINE_REASONS)[number];

export const SYNC_QUARANTINE_STATUSES = ['open', 'replayed', 'discarded'] as const;
export type SyncQuarantineStatus = (typeof SYNC_QUARANTINE_STATUSES)[number];

/**
 * Events the cloud refused, held whole so a person can decide.
 *
 * The row carries the payload ITSELF rather than pointing at the ledger, for
 * two reasons: a quarantined event was never accepted, so there is no ledger
 * row to point at; and replaying one has to be possible after the ledger's
 * retention window has passed, which a pointer could not survive.
 *
 * **Not swept.** It is small by construction — a row here means something went
 * wrong — and it is exactly what an investigation opens first. If it ever does
 * grow, that growth is itself the signal, and the watchdog's "quarantine
 * non-empty" rule says so long before size is a question.
 */
export const syncQuarantine = edge.table(
  'sync_quarantine',
  {
    id: idPk(),
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    /**
     * No foreign key, deliberately. Often there is no ledger row at all — that
     * is what quarantine means — and where there is one it is swept on a
     * shorter clock than this table. Same rule as `box_command.action_id`.
     */
    eventId: uuid('event_id').notNull(),
    journalEpoch: integer('journal_epoch').notNull(),
    boxSeq: bigint('box_seq', { mode: 'number' }).notNull(),
    type: text('type'),
    schemaVersion: integer('schema_version'),
    reason: text('reason').$type<SyncQuarantineReason>().notNull(),
    status: text('status').$type<SyncQuarantineStatus>().notNull().default('open'),
    /** Short, non-leaking, as `ops_run.error_code` is — this is read on a Console page. */
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /** The envelope as it was sent, so "replay" means replay and not reconstruct. */
    payload: jsonb('payload').notNull(),
    payloadHash: text('payload_hash'),
    /** For a `conflict`: the hash already in the ledger, so the two are comparable. */
    existingPayloadHash: text('existing_payload_hash'),
    sig: text('sig'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    actionId: text('action_id'),
    batchId: text('batch_id'),
    /** The alert raised for it, so resolving one resolves the other. */
    alertKey: text('alert_key'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    resolvedByAccountId: uuid('resolved_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    /** Why a person replayed or discarded it. A discard with no reason is not a decision. */
    resolutionNote: text('resolution_note'),
    /** Set when a replay succeeded, so the accepted event is reachable from here. */
    replayedEventId: uuid('replayed_event_id'),
  },
  (t) => [
    /** The Failures > Quarantine tab: what is still open, newest first. */
    index('sync_quarantine_open_idx')
      .on(t.receivedAt)
      .where(sql`status = 'open'`),
    index('sync_quarantine_box_received_idx').on(t.boxId, t.receivedAt),
    /** "Show me everything about this event id" across all four tables. */
    index('sync_quarantine_event_idx').on(t.eventId),
    index('sync_quarantine_action_idx').on(t.actionId),
    index('sync_quarantine_resolved_by_idx').on(t.resolvedByAccountId),
    check('sync_quarantine_epoch_check', sql`${t.journalEpoch} > 0`),
    check(
      'sync_quarantine_reason_check',
      sql`${t.reason} in ('conflict','poison','epoch_regressed','sequence_gap','unknown_type','schema_too_new','actor_unknown','signature_invalid','apply_failed')`,
    ),
    check('sync_quarantine_status_check', sql`${t.status} in ('open','replayed','discarded')`),
  ],
);

/**
 * Applied, but with something worth recording.
 *
 * The distinction from quarantine is the whole reason both exist: quarantine
 * means NOT applied and a person has to choose; an anomaly means applied, and
 * here is the caveat. Different lifecycles, different pages, and collapsing
 * them into one table with a status would mean the Quarantine tab's count — the
 * number the watchdog alerts on — was diluted by routine clock notes.
 *
 * Swept with the ledger at `SYNC_EVENT_RETENTION_DAYS`: an anomaly about an
 * event that is gone has nothing left to explain.
 */
export const SYNC_ANOMALY_KINDS = [
  /** Low clock trust; `business_date` was recomputed from `received_at`. */
  'clock_recomputed',
  /** A batch arrived that had already been applied. Normal; counted, not alarming. */
  'duplicate_replay',
  /** `box_seq` skipped; the box lost events it had already minted. */
  'sequence_gap',
  /** The same member created at two boxes offline and merged at sync. */
  'merge',
  /** An epoch older than the box's current one turned up. */
  'epoch_regressed',
  /** Applied a long time after it happened — a box back from days offline. */
  'late_arrival',
] as const;
export type SyncAnomalyKind = (typeof SYNC_ANOMALY_KINDS)[number];

export const syncAnomaly = edge.table(
  'sync_anomaly',
  {
    id: idPk(),
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    /** No key, for the same reason as quarantine's: the ledger is swept first. */
    eventId: uuid('event_id'),
    /**
     * The OTHER event, when the anomaly is about a pair: the second
     * `member.created` in a merge, the event whose sequence was skipped. The
     * merge acceptance criterion asks for both ids, and this is the one that
     * carries the second.
     */
    relatedEventId: uuid('related_event_id'),
    kind: text('kind').$type<SyncAnomalyKind>().notNull(),
    /**
     * Scrubbed, like `ops_run.detail`: both candidate business dates, the
     * offset in milliseconds, the two member ids in a merge. Never a phone,
     * never a name.
     */
    detail: jsonb('detail'),
    actionId: text('action_id'),
    detectedAt: timestamp('detected_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('sync_anomaly_box_detected_idx').on(t.boxId, t.detectedAt),
    index('sync_anomaly_kind_detected_idx').on(t.kind, t.detectedAt),
    index('sync_anomaly_event_idx').on(t.eventId),
    /** The sweep's delete. */
    index('sync_anomaly_detected_idx').on(t.detectedAt),
    check(
      'sync_anomaly_kind_check',
      sql`${t.kind} in ('clock_recomputed','duplicate_replay','sequence_gap','merge','epoch_regressed','late_arrival')`,
    ),
  ],
);

/**
 * The cache-bundle scopes, which are also the change feed's partitions —
 * exactly the list in the ticket, so a change and the bundle that would
 * replace it speak the same word.
 */
export const SYNC_CHANGE_SCOPES = [
  'catalogue',
  'members',
  'staff',
  'deny_list',
  'bookings',
  'bands',
  'station_config',
  'receipt_series',
] as const;
export type SyncChangeScope = (typeof SYNC_CHANGE_SCOPES)[number];

export const SYNC_CHANGE_OPS = ['upsert', 'delete'] as const;
export type SyncChangeOp = (typeof SYNC_CHANGE_OPS)[number];

/**
 * What a box has to pull: the cloud-authoritative side of the traffic.
 *
 * Mutable records — a member's profile, a price, a station's devices — are
 * cloud-authoritative (PLATFORM_PLAN §7.3) and reach a box either as a whole
 * versioned bundle or as this feed. Facts travel the other way, in
 * `sync_event`; nothing travels both.
 *
 * **Why `seq` is a bigserial and not a uuid.** A pull is `where seq > cursor
 * order by seq limit n`, and that needs a total order the reader can resume
 * from. A sequence gives one cheaply. It also has the classic hazard: two
 * concurrent inserts can commit out of order, so a reader that has already
 * passed a number could miss the row that lands behind it. That is survivable
 * HERE and would not be in the ledger, because every row in this feed is an
 * idempotent upsert or delete keyed by `entity_type` + `entity_id`: re-reading
 * an overlap changes nothing, so the puller simply rewinds a small window. The
 * ledger cannot make that trade, which is why it is keyed on the box's own
 * gapless sequence instead.
 *
 * **Retention: 30 days**, swept by the same hourly job. A box away longer than
 * that pulls a whole bundle rather than replaying a month of deltas — which is
 * both cheaper and the only correct thing after a store reset.
 */
export const syncChange = edge.table(
  'sync_change',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    /** Null for an operator-wide change — a system role, a signing key. */
    branchId: uuid('branch_id').references(() => branch.id, { onDelete: 'restrict' }),
    /**
     * Null means every box at the branch. Set only when a change concerns one
     * box — its own station config, its device list. Cascade, because this
     * table is swept anyway and a delta addressed to a box that no longer
     * exists is addressed to nobody.
     */
    boxId: uuid('box_id').references(() => box.id, { onDelete: 'cascade' }),
    scope: text('scope').$type<SyncChangeScope>().notNull(),
    op: text('op').$type<SyncChangeOp>().notNull().default('upsert'),
    entityType: text('entity_type').notNull(),
    /** Text, not uuid: a receipt series and a deny-list entry are not uuids. */
    entityId: text('entity_id').notNull(),
    /**
     * The record's own version, so a box applying two deltas out of order
     * keeps the newer one. Null where the entity has no version of its own,
     * in which case `seq` is the tiebreak.
     */
    version: integer('version'),
    schemaVersion: integer('schema_version').notNull().default(SYNC_EVENT_SCHEMA_VERSION),
    /** Null for a delete. Redacted to what a box actually needs to hold. */
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    /** The pull, for a box that takes its branch's changes. */
    index('sync_change_branch_seq_idx').on(t.branchId, t.seq),
    /** The pull, for the deltas addressed to one box. */
    index('sync_change_box_seq_idx')
      .on(t.boxId, t.seq)
      .where(sql`box_id is not null`),
    /** "What has happened to this member?" and the sweep's delete. */
    index('sync_change_entity_idx').on(t.entityType, t.entityId),
    index('sync_change_created_idx').on(t.createdAt),
    index('sync_change_operator_idx').on(t.operatorId),
    check(
      'sync_change_scope_check',
      sql`${t.scope} in ('catalogue','members','staff','deny_list','bookings','bands','station_config','receipt_series')`,
    ),
    check('sync_change_op_check', sql`${t.op} in ('upsert','delete')`),
    check('sync_change_delete_check', sql`${t.op} <> 'delete' or ${t.payload} is null`),
  ],
);

/**
 * The customer-facing stage of a station's session.
 *
 * Ported unchanged from the prototype's `CustomerStage`
 * (`apps/pos/src/components/till/CustomerDisplay.tsx:70`), which the till
 * derives from its wizard step at `pages/Till.tsx:1504-1510`. Keeping the
 * prototype's six words means the display component that already exists reads
 * this document without a translation layer.
 */
export const STATION_SESSION_STAGES = [
  'identify',
  'welcome',
  'order',
  'input',
  'payment',
  'thankyou',
] as const;
export type StationSessionStage = (typeof STATION_SESSION_STAGES)[number];

/** What is holding the lease. An observer holds none and does not appear here. */
export const STATION_LEASE_HOLDER_KINDS = ['till', 'kiosk', 'booth', 'console'] as const;
export type StationLeaseHolderKind = (typeof STATION_LEASE_HOLDER_KINDS)[number];

/** Bumped when a field in the document changes MEANING, not when one is added. */
export const STATION_SESSION_SCHEMA_VERSION = 1;

/**
 * What is happening at one station right now, and who may change it.
 *
 * One row per station — `station_id` is the primary key, because "one live
 * session per station" is the invariant, not a query result. The box is the
 * only writer; the till sends intents, the box applies them and pushes a full
 * snapshot to both screens (PLATFORM_PLAN §6). Snapshots rather than patches,
 * so a screen that reconnects is correct again after one message.
 *
 * **The lease lives on the same row as the document, on purpose.** An intent
 * is valid only if it comes from the current lease holder AND quotes the
 * sequence it last saw, and both have to be checked against the state it is
 * about to change. On one row that is a single compare-and-set — `update …
 * where station_id = $1 and lease_id = $2 and sequence = $3` — which either
 * wins or returns zero rows and becomes a `409 STALE`. Split across two tables
 * it would be a read, a decision and a write, with the lease free to move in
 * between. The same lesson as the idempotency claim and the hand-off jti: only
 * a single statement settles a race.
 *
 * The cost of that choice is that a 15-second lease heartbeat touches the row
 * the document is on. At a handful of stations per branch that is four writes
 * a minute each, and the document's jsonb is TOASTed out of line and not
 * rewritten when only the lease columns change.
 */
export const stationSession = edge.table(
  'station_session',
  {
    stationId: uuid('station_id')
      .primaryKey()
      .references(() => station.id, { onDelete: 'restrict' }),
    /**
     * Denormalised from the station. Every intent arrives on a box credential
     * and has to be checked against the station's box; doing that without a
     * join keeps the hottest path in the system to one row.
     */
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    schemaVersion: integer('schema_version')
      .notNull()
      .default(STATION_SESSION_SCHEMA_VERSION),
    /**
     * Stamped by the box on every change and never reused. Both screens show
     * the same number after a change — that is the acceptance criterion — and
     * an intent quoting an older one is stale.
     */
    sequence: bigint('sequence', { mode: 'number' }).notNull().default(0),
    stage: text('stage').$type<StationSessionStage>().notNull().default('identify'),
    /**
     * The till's wizard position (the prototype's `step`, 1-6). `stage` is
     * derived from it by the box using the prototype's own mapping, and both
     * are stored so the display's redacted snapshot is a read rather than a
     * computation — the box being the only writer is what keeps them agreeing.
     */
    step: smallint('step'),
    /** Lines, quantities, tiers, add-ons. Shape validated by zod in `@oto/shared`. */
    cart: jsonb('cart'),
    /**
     * The member attached to this sale. **Staff-only fields never reach the
     * display**: allergy, medical and food-consent data are redacted by the
     * box when it computes the display's view (R-58). What is stored here is
     * the till's full view; the redaction happens on the way out.
     */
    member: jsonb('member'),
    /** Subtotal, discounts, VAT, service charge, rounding, total — in satang. */
    totals: jsonb('totals'),
    /** Tender, terminal state, the QR to render, approval codes. */
    payment: jsonb('payment'),
    /** What the display is being asked for: a phone number, a consent tick, a signature. */
    prompt: jsonb('prompt'),
    /** The display's language toggle. One of `SUPPORTED_LANGS` in `@oto/shared`. */
    language: text('language').notNull().default('en'),
    /**
     * The fencing token. Minted on every claim and quoted by every intent, so
     * a till that was displaced and did not notice is refused by value rather
     * than by timing.
     */
    leaseId: uuid('lease_id'),
    /** An opaque per-client id — a browser tab, not a person. */
    leaseHolder: text('lease_holder'),
    leaseHolderKind: text('lease_holder_kind').$type<StationLeaseHolderKind>(),
    /** Who is signed in at the holding till, which is what an audit asks. */
    leaseAccountId: uuid('lease_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    leaseStartedAt: timestamp('lease_started_at', { withTimezone: true, mode: 'date' }),
    /** Every 15 seconds while the till is alive. */
    leaseHeartbeatAt: timestamp('lease_heartbeat_at', { withTimezone: true, mode: 'date' }),
    /**
     * 60-second TTL. Past it the lease is claimable by anybody without a
     * manager — which is what makes "close the tab and the second till takes
     * over within a minute" true — while a LIVE lease needs a manager's
     * takeover, audited as `station.takeover`.
     */
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    /** Bumped on every takeover of a live lease. Zero means nobody has been displaced. */
    takeoverCount: integer('takeover_count').notNull().default(0),
    lastIntentAt: timestamp('last_intent_at', { withTimezone: true, mode: 'date' }),
    /** The action id of the change that produced the current sequence. */
    lastActionId: text('last_action_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('station_session_box_idx').on(t.boxId),
    index('station_session_branch_idx').on(t.branchId),
    index('station_session_operator_idx').on(t.operatorId),
    index('station_session_lease_account_idx').on(t.leaseAccountId),
    /** The reaper, and the Health drawer's "who is holding what right now". */
    index('station_session_lease_expires_idx').on(t.leaseExpiresAt),
    check('station_session_sequence_check', sql`${t.sequence} >= 0`),
    check('station_session_step_check', sql`${t.step} is null or (${t.step} >= 1 and ${t.step} <= 9)`),
    check(
      'station_session_stage_check',
      sql`${t.stage} in ('identify','welcome','order','input','payment','thankyou')`,
    ),
    check('station_session_language_check', sql`${t.language} in ('en','zh','th','ru','fr')`),
    check(
      'station_session_lease_holder_kind_check',
      sql`${t.leaseHolderKind} is null or ${t.leaseHolderKind} in ('till','kiosk','booth','console')`,
    ),
    /**
     * A lease is all four columns or none of them. A row with a holder and no
     * expiry is a lease nothing can ever reclaim — a till nobody can use until
     * somebody edits the database — so the database refuses it.
     */
    check(
      'station_session_lease_complete_check',
      sql`(${t.leaseId} is null and ${t.leaseHolder} is null and ${t.leaseExpiresAt} is null)
          or (${t.leaseId} is not null and ${t.leaseHolder} is not null and ${t.leaseExpiresAt} is not null)`,
    ),
    check('station_session_takeover_check', sql`${t.takeoverCount} >= 0`),
  ],
);

/** What a station event records. */
export const STATION_EVENT_KINDS = ['intent', 'snapshot', 'lease', 'scan', 'error'] as const;
export type StationEventKind = (typeof STATION_EVENT_KINDS)[number];

/** Which surface sent it. */
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
 * The tape of one station: every intent that arrived and every snapshot that
 * went out.
 *
 * This is what makes "one action id links the till line, the Box log drawer
 * and the cloud audit row" a thing somebody can actually follow, and what
 * answers "the display stopped updating at 3pm" the next morning.
 *
 * **Telemetry, not record. Retention: 30 days**, per the ticket, swept by
 * `job:housekeeping.retention` by `received_at`; `station_event_received_idx`
 * exists for that delete as much as for any read. Its foreign keys cascade for
 * the same reason `box_heartbeat`'s does and the ledger's do not — thirty days
 * of intents about a station that no longer exists is worth nothing, whereas a
 * year of the facts that station produced is worth a great deal.
 *
 * `payload` is a REDACTED summary of the intent: which field was filled, not
 * what was typed into it. Nothing personal goes up a telemetry channel — the
 * rule `packages/box-agent/src/protocol.ts` sets for the heartbeat — and this
 * one outlives the incident by a month.
 */
export const stationEvent = edge.table(
  'station_event',
  {
    id: idPk(),
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'cascade' }),
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<StationEventKind>().notNull(),
    source: text('source').$type<StationEventSource>().notNull(),
    /** The document sequence this row is about. */
    sequence: bigint('sequence', { mode: 'number' }),
    stage: text('stage'),
    /** `cart.add_line`, `payment.start`, `display.set_language`. Null for a snapshot. */
    intentType: text('intent_type'),
    /** Which lease it was sent under, so a rejected stale intent is explicable. */
    leaseId: uuid('lease_id'),
    /** `applied`, `stale`, `refused`, `sent` — what became of it. */
    outcome: text('outcome'),
    errorCode: text('error_code'),
    actorAccountId: uuid('actor_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    actionId: text('action_id'),
    payload: jsonb('payload'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** The station's tape, newest first. */
    index('station_event_station_received_idx').on(t.stationId, t.receivedAt),
    index('station_event_box_received_idx').on(t.boxId, t.receivedAt),
    /** Following one action across the till, the box and the cloud. */
    index('station_event_action_idx').on(t.actionId),
    index('station_event_actor_idx').on(t.actorAccountId),
    /** The 30-day sweep's delete, and nothing else. */
    index('station_event_received_idx').on(t.receivedAt),
    check('station_event_kind_check', sql`${t.kind} in ('intent','snapshot','lease','scan','error')`),
    check(
      'station_event_source_check',
      sql`${t.source} in ('till','display','kiosk','booth','box','console')`,
    ),
  ],
);

/** A queued event's life on the box, before the cloud has said anything about it. */
export const BOX_OUTBOX_STATES = [
  'queued',
  'sending',
  'acked',
  'quarantined',
  'failed',
] as const;
export type BoxOutboxState = (typeof BOX_OUTBOX_STATES)[number];

/**
 * The durable outbox — the box's side of the wire.
 *
 * It looks almost exactly like `sync_event` because it holds the same
 * envelope; what differs is who owns it. This is the box's queue of facts it
 * has produced and the cloud has not yet acknowledged. On a Pi it is a SQLite
 * table of this shape behind the same `Store` interface; on the virtual box it
 * is this one, in Postgres, which is what lets "toggle offline, create three
 * members, restart the api, outbox depth is still 3" be a thing anybody can
 * demonstrate on Render.
 *
 * Keeping it separate from the ledger is not duplication: a queued event has
 * NOT been accepted, so it cannot sit in a table whose rows mean "accepted",
 * and the acceptance criterion about an outbox depth of three is exactly the
 * count of rows the ledger must not contain yet.
 *
 * The same UNIQUE (box_id, journal_epoch, box_seq) as the ledger, because the
 * box's journal is gapless at the point it is minted, not at the point it is
 * accepted — if it were only unique upstream, a crash between minting and
 * queueing could hand two facts one sequence number and the ledger would find
 * out about it hours later.
 */
export const boxOutbox = edge.table(
  'box_outbox',
  {
    eventId: uuid('event_id').primaryKey(),
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    journalEpoch: integer('journal_epoch').notNull(),
    boxSeq: bigint('box_seq', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    schemaVersion: integer('schema_version').notNull().default(SYNC_EVENT_SCHEMA_VERSION),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    clockTrust: text('clock_trust').$type<SyncClockTrust>().notNull().default('trusted'),
    clockOffsetMs: integer('clock_offset_ms'),
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    actorKind: text('actor_kind').$type<SyncActorKind>().notNull().default('account'),
    actorAccountId: uuid('actor_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    actorCredentialId: uuid('actor_credential_id').references(() => deviceCredential.id, {
      onDelete: 'restrict',
    }),
    actionId: text('action_id'),
    payload: jsonb('payload').notNull(),
    payloadHash: text('payload_hash').notNull(),
    sig: text('sig').notNull(),
    sigAlg: text('sig_alg').notNull().default('ed25519'),
    state: text('state').$type<BoxOutboxState>().notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    /** Backoff with jitter: the send query takes only rows that are due. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /**
     * When the cloud acknowledged it. A row is kept briefly after the ack so a
     * lost response can be answered from the box's own store, then swept — the
     * ledger is the copy that lasts.
     */
    ackedAt: timestamp('acked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('box_outbox_journal_unique').on(t.boxId, t.journalEpoch, t.boxSeq),
    /**
     * The send: the oldest due events of one box, in journal order. Partial,
     * so the index holds the queue rather than everything ever sent — which
     * also makes `count(*)` over it the outbox depth the heartbeat reports.
     */
    index('box_outbox_send_idx')
      .on(t.boxId, t.boxSeq)
      .where(sql`state in ('queued','sending')`),
    /** "Oldest unacked age", the watchdog's `SYNC_STALE_AFTER_S` rule. */
    index('box_outbox_created_idx').on(t.createdAt),
    index('box_outbox_station_idx').on(t.stationId),
    index('box_outbox_actor_account_idx').on(t.actorAccountId),
    index('box_outbox_actor_credential_idx').on(t.actorCredentialId),
    index('box_outbox_action_idx').on(t.actionId),
    check('box_outbox_seq_check', sql`${t.boxSeq} > 0`),
    check('box_outbox_epoch_check', sql`${t.journalEpoch} > 0`),
    check('box_outbox_type_check', sql`${t.type} ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'`),
    check('box_outbox_clock_trust_check', sql`${t.clockTrust} in ('trusted','skewed','untrusted')`),
    check('box_outbox_actor_kind_check', sql`${t.actorKind} in ('account','device','box','system')`),
    check('box_outbox_payload_hash_check', sql`${t.payloadHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'box_outbox_state_check',
      sql`${t.state} in ('queued','sending','acked','quarantined','failed')`,
    ),
  ],
);

/**
 * What the box knows about ITSELF, which is a different thing from what the
 * cloud knows about it.
 *
 * `core.box.status` is the cloud's view, decided by the watchdog from silence
 * — a box that has crashed cannot announce that it is down. This row is the
 * agent's own persistent state inside the `Store`, and it exists because three
 * things have to survive a restart:
 *
 *   - **The offline toggle.** The ticket requires it persisted in the `edge`
 *     schema across restarts, and the acceptance criterion is a Render
 *     "Restart" of the api with the box offline and three events queued: the
 *     offline state, the session document and the outbox depth all still
 *     there afterwards. A process-memory flag fails that test by definition.
 *   - **The journal counter.** `next_box_seq` is the generator behind
 *     `box_outbox.box_seq`. Incrementing it inside the same transaction that
 *     queues the event takes a row lock on this row, which is what makes the
 *     sequence gapless even with two intents landing in the same millisecond.
 *     Keeping it in memory would restart the journal at 1 after a crash and
 *     hand two facts one sequence number.
 *   - **The store's schema version**, so migrate-on-read has something to read.
 *
 * `clock_skew_ms` is the test instrument: the injection that lets a low
 * `clock_trust` path be demonstrated without waiting for a Pi with a dead
 * clock battery. It is zero on any box nobody is testing.
 */
export const boxState = edge.table(
  'box_state',
  {
    boxId: uuid('box_id')
      .primaryKey()
      .references(() => box.id, { onDelete: 'restrict' }),
    offline: boolean('offline').notNull().default(false),
    offlineSince: timestamp('offline_since', { withTimezone: true, mode: 'date' }),
    /** `console`, `command`, `link_down` — why it is offline, in one word. */
    offlineReason: text('offline_reason'),
    offlineSetByAccountId: uuid('offline_set_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    /** The box's own view of its epoch; `core.box.current_epoch` is the cloud's. */
    journalEpoch: integer('journal_epoch').notNull().default(1),
    /** The next `box_seq` to mint. Claimed under this row's lock; never reused. */
    nextBoxSeq: bigint('next_box_seq', { mode: 'number' }).notNull().default(1),
    storeSchemaVersion: integer('store_schema_version')
      .notNull()
      .default(SYNC_EVENT_SCHEMA_VERSION),
    /** Deliberate skew for tests, in milliseconds. Zero everywhere else. */
    clockSkewMs: integer('clock_skew_ms').notNull().default(0),
    /** The cache bundle the box has actually applied, whole or not at all. */
    appliedConfigVersion: text('applied_config_version'),
    lastCacheAppliedAt: timestamp('last_cache_applied_at', { withTimezone: true, mode: 'date' }),
    lastResetAt: timestamp('last_reset_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /** The Console's "which boxes are deliberately offline". */
    index('box_state_offline_idx').on(t.offline),
    index('box_state_offline_set_by_idx').on(t.offlineSetByAccountId),
    check('box_state_epoch_check', sql`${t.journalEpoch} > 0`),
    check('box_state_seq_check', sql`${t.nextBoxSeq} > 0`),
    check('box_state_schema_version_check', sql`${t.storeSchemaVersion} > 0`),
  ],
);
