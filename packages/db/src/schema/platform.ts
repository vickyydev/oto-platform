import { index, integer, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { core, idPk } from './helpers';
import { account, branch, operator } from './tenancy';

// --- The platform's own records (schema `core`) ----------------------------
//
// `station` used to live here. S2-04 moved the declaration to `fleet.ts`, next
// to the boxes and devices it is now defined in terms of; the table itself did
// not move schema, change name or lose a column.

/** Append-only audit log (CLAUDE.md §3). Written by audit.record — no exceptions. */
export const auditLog = core.table(
  'audit_log',
  {
    id: idPk(),
    operatorId: uuid('operator_id').references(() => operator.id),
    branchId: uuid('branch_id').references(() => branch.id),
    actorAccountId: uuid('actor_account_id').references(() => account.id),
    requestId: text('request_id'),
    /** e.g. 'member.create', 'ticket_package.update'. */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    /**
     * `x-oto-action-id`, minted where the person tapped and carried PWA -> box
     * -> cloud (S2-05). The audit row is the last of the four records one
     * action writes — the till line, the Box log drawer, the `ops_run` for the
     * batch, and this — and without the id here the chain stops one short.
     */
    actionId: text('action_id'),
    /**
     * The `edge.sync_event` this change arrived as, for anything a box
     * originated. No foreign key, deliberately: the ledger is swept after a
     * year and the audit log is not, so the pointer has to outlive what it
     * points at. Same rule as `edge.box_command.action_id` and `ops_run`.
     */
    sourceEventId: uuid('source_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_entity_idx').on(t.entityType, t.entityId),
    index('audit_actor_idx').on(t.actorAccountId),
    index('audit_operator_idx').on(t.operatorId),
    index('audit_branch_idx').on(t.branchId),
    index('audit_created_idx').on(t.createdAt),
    index('audit_action_idx').on(t.action, t.createdAt),
    index('audit_action_id_idx').on(t.actionId),
    index('audit_source_event_idx').on(t.sourceEventId),
  ],
);

/** Idempotency middleware storage (CLAUDE.md §3, Safeguards). */
export const idempotencyKey = core.table(
  'idempotency_key',
  {
    key: text('key').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.key] }), index('idempotency_expires_idx').on(t.expiresAt)],
);

/** S3/MinIO object metadata; access only via permission-checked signed URLs. */
export const fileObject = core.table(
  'file_object',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    bucket: text('bucket').notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size'),
    ownerEntityType: text('owner_entity_type').notNull(),
    ownerEntityId: uuid('owner_entity_id').notNull(),
    uploadedByAccountId: uuid('uploaded_by_account_id').references(() => account.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('file_object_owner_idx').on(t.ownerEntityType, t.ownerEntityId),
    index('file_object_operator_idx').on(t.operatorId),
  ],
);

/**
 * Failure throttle for sign-in, unlock and code verification, and the fixed
 * windows behind the rate limiter (S2-01a).
 *
 * Sprint 1 kept these counters in a Map, which a Render restart wiped — an
 * attacker only had to wait for a deploy. Postgres makes the cooldown
 * survive restarts and, later, hold across more than one api instance.
 *
 * `key` is the bucket: "phone:+66...", "ip:1.2.3.4", "unlock:<sessionId>",
 * "code:<accountId>:<purpose>", "rl:<route>:<ip>". Rows are disposable — the
 * housekeeping job added in S2-03 deletes expired ones.
 */
export const authThrottle = core.table(
  'auth_throttle',
  {
    key: text('key').primaryKey(),
    failures: integer('failures').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('auth_throttle_locked_until_idx').on(t.lockedUntil)],
);
