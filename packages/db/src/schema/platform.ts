import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { core, idPk, timestamps } from './helpers';
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
 * How a person proves who they are.
 *
 * `password` is the phone-and-password sign-in the POS has had since Sprint 1.
 * `pin` and `badge` are what a booth takes (S2-07a): the staff overlay on a
 * mall booth asks for a PIN — exactly five digits since 28 September — or a
 * scanned badge, because a person standing at a wheel in a shopping centre is
 * not going to type a password on a television.
 */
export const CREDENTIAL_KINDS = ['password', 'pin', 'badge'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/**
 * A secret an ACCOUNT holds — as `core.device_credential` is a secret a
 * non-person holds.
 *
 * **Every secret here is an argon2id hash and nothing else.** No PIN in clear,
 * no reversible encoding, no "it is only four digits". The booth verifies a
 * PIN on the box rather than in the browser (D15), so once the staff cache
 * scope carries these they will travel to a Raspberry Pi standing in a
 * shopping mall — which is why the cost of one leaking has to be a brute force
 * per account rather than a list of PINs. Nothing puts them in a cache bundle
 * yet; the booth box role is what does that.
 *
 * **It does not replace `account.password_hash` yet.** The deployed release
 * still reads that column and this migration is expand-only, so the password
 * path is untouched and nothing writes a `password` row here today; the kind
 * exists so that moving it later is a backfill rather than a re-design. Until
 * then a `password` row would be a second answer to a question that already
 * has one.
 *
 * **The hash is not a lookup key.** argon2id salts per row, so there is no
 * query that turns a typed PIN into an account: whatever surface takes a PIN
 * has to know whose PIN it is first. That is a constraint on the sign-in
 * flow, not something this table can fix, and it is written down here so that
 * nobody designs a "type any PIN and we will find you" screen against it.
 */
export const credential = core.table(
  'credential',
  {
    id: idPk(),
    /** Denormalised from the account, as on every tenant-owned table (S2-01b). */
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<CredentialKind>().notNull(),
    /** argon2id. See the note above. */
    secretHash: text('secret_hash').notNull(),
    /** What a person calls this badge, so revoking the right one is possible. */
    label: text('label'),
    /**
     * Revocation is `active = false` plus `revoked_at`, never a delete: "this
     * person's PIN was withdrawn on the 3rd" is the fact an investigation
     * needs, and a deleted row does not carry it.
     */
    active: boolean('active').notNull().default(true),
    /** Who set it — a manager, an administrator, or the person themselves. */
    createdByAccountId: uuid('created_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedReason: text('revoked_reason'),
    /**
     * When this secret stops working (migration 0027). Null never expires.
     *
     * Set on a booth PIN from the Console (owner, 28 September). An expired
     * PIN is still `active` — nobody withdrew it — and opens nothing: the
     * platform stops handing its hash to boxes once the moment has passed
     * (`livePinsByAccount` in `apps/api/src/services/booth-admin.ts`), and a
     * box refuses it between pulls from the `pinExpiresAt` it was given beside
     * the hash, so a booth that is offline across the moment still refuses it.
     * Withdrawing it is still `active = false` with a reason, as above.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    /**
     * At most one LIVE credential of each kind per account, so two PINs can
     * never both open the booth: a second insert fails until the first is
     * revoked. Partial, so a revoked PIN stays on the record without blocking
     * its replacement.
     */
    uniqueIndex('credential_active_kind_unique')
      .on(t.accountId, t.kind)
      .where(sql`active`),
    index('credential_account_idx').on(t.accountId),
    index('credential_operator_idx').on(t.operatorId),
    index('credential_created_by_idx').on(t.createdByAccountId),
    check('credential_kind_check', sql`${t.kind} in ('password','pin','badge')`),
    /** A revoked credential is not active, and an active one is not revoked. */
    check(
      'credential_revocation_check',
      sql`(${t.active} and ${t.revokedAt} is null) or (not ${t.active} and ${t.revokedAt} is not null)`,
    ),
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
