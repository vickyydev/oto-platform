import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { core, idPk } from './helpers';
import { account, branch, operator } from './tenancy';

// --- The platform's own records (schema `core`) ----------------------------

/**
 * A place a session can be held: a till, a kiosk, a gate, a customer display
 * — and from S2-07 a booth. Text + CHECK rather than a pg enum so a new kind
 * arrives without a DDL lock (S2-01b).
 */
export const STATION_KINDS = ['till', 'kiosk', 'gate', 'display', 'booth'] as const;
export type StationKind = (typeof STATION_KINDS)[number];

export const station = core.table(
  'station',
  {
    id: idPk(),
    /**
     * Denormalised from the branch (S2-01b): every tenant-owned table carries
     * its operator, so a tenancy filter never has to join through the branch
     * to find out whose station this is.
     */
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id),
    name: text('name').notNull(),
    kind: text('kind').$type<StationKind>().notNull().default('till'),
    deviceKeyHash: text('device_key_hash'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('station_branch_idx').on(t.branchId),
    index('station_operator_idx').on(t.operatorId),
    check('station_kind_check', sql`${t.kind} in ('till','kiosk','gate','display','booth')`),
  ],
);

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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_entity_idx').on(t.entityType, t.entityId),
    index('audit_actor_idx').on(t.actorAccountId),
    index('audit_operator_idx').on(t.operatorId),
    index('audit_branch_idx').on(t.branchId),
    index('audit_created_idx').on(t.createdAt),
    index('audit_action_idx').on(t.action, t.createdAt),
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
