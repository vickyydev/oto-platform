import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { idPk } from './helpers';
import { account, branch, operator } from './tenancy';

export const stationKind = pgEnum('station_kind', ['till', 'kiosk', 'gate', 'display']);

export const station = pgTable(
  'station',
  {
    id: idPk(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id),
    name: text('name').notNull(),
    kind: stationKind('kind').notNull().default('till'),
    deviceKeyHash: text('device_key_hash'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('station_branch_idx').on(t.branchId)],
);

/** Append-only audit log (CLAUDE.md §3). Written by audit.record — no exceptions. */
export const auditLog = pgTable(
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
  ],
);

/** Idempotency middleware storage (CLAUDE.md §3, Safeguards). */
export const idempotencyKey = pgTable(
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
export const fileObject = pgTable(
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
