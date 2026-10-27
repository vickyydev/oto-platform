import { sql } from 'drizzle-orm';
import { check, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { archivedAt, core, idPk, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';

// --- Alert routing and fingerprint mutes (schema `core`) --------------------
//
// SCRUM-644, planner ruling Q25. Two records the watchdog consults before it
// tells anybody about an alert, kept beside `core.alert` and
// `core.alert_delivery` (schema/ops.ts) rather than inside them so that the
// alert's own life — raised, repeated, resolved — is not changed by either.
//
// Neither is `ops_expectation.muted_until`. That column is a named JOB's
// planned silence (a maintenance window on one expectation) and stays exactly
// what it is; a fingerprint mute is a person deciding, with a reason, that one
// condition need not be delivered for a bounded time.

/** What a recipient row may name. Only `console` is delivered on this build. */
export const ALERT_RECIPIENT_CHANNELS = ['console', 'email', 'webhook'] as const;
export type AlertRecipientChannel = (typeof ALERT_RECIPIENT_CHANNELS)[number];

/** The longest a single mute may last: a longer silence is re-decided daily (Q25). */
export const ALERT_MUTE_MAX_MINUTES = 24 * 60;
/** What a mute lasts when the person muting does not say. */
export const ALERT_MUTE_DEFAULT_MINUTES = 60;

/**
 * The shape an address REFERENCE must have: the NAME of an environment
 * variable, prefixed `ALERT_`, never the address itself. An email address or a
 * webhook URL is the value that variable would hold — and a webhook URL is a
 * bearer credential — so neither can be written here; the CHECK below refuses
 * `@` and `://` outright as well as anything that is not an upper-case name.
 */
export const ALERT_ADDRESS_REF_PATTERN = '^ALERT_[A-Z0-9_]{2,58}$';

const NO_ID = sql.raw(`'00000000-0000-0000-0000-000000000000'::uuid`);

/**
 * Where an alert of a category goes: a channel and, for anything but the
 * console, the name of the environment variable that holds its address.
 *
 * `operator_id` null is a platform-wide row (a platform administrator's); a
 * `branch_id` narrows an operator's row to one park. `category` is an alert
 * family (`ops.missing`, `box.offline`) or `*` for every family.
 *
 * Rows may name `email` or `webhook`, and the watchdog records that it did
 * NOT deliver to them (`alert_delivery.status = 'unsupported'`): delivery is
 * console-only until a provider integration is its own ticket.
 */
export const alertRecipient = core.table(
  'alert_recipient',
  {
    id: idPk(),
    operatorId: uuid('operator_id').references(() => operator.id),
    branchId: uuid('branch_id').references(() => branch.id),
    category: text('category').notNull(),
    channel: text('channel').$type<AlertRecipientChannel>().notNull(),
    /** An environment variable NAME (`ALERT_ONCALL_EMAIL`), never its value. */
    addressRef: text('address_ref'),
    /** What a person calls this row on the screen. */
    label: text('label'),
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => account.id),
    updatedByAccountId: uuid('updated_by_account_id').references(() => account.id),
    ...archivedAt,
    ...timestamps,
  },
  (t) => [
    uniqueIndex('alert_recipient_route_unique')
      .on(
        sql`coalesce(${t.operatorId}, ${NO_ID})`,
        sql`coalesce(${t.branchId}, ${NO_ID})`,
        t.category,
        t.channel,
        sql`coalesce(${t.addressRef}, '')`,
      )
      .where(sql`archived_at is null`),
    index('alert_recipient_operator_idx').on(t.operatorId),
    index('alert_recipient_branch_idx').on(t.branchId),
    index('alert_recipient_category_idx').on(t.category),
    index('alert_recipient_created_by_idx').on(t.createdByAccountId),
    index('alert_recipient_updated_by_idx').on(t.updatedByAccountId),
    check('alert_recipient_channel_check', sql`${t.channel} in ('console','email','webhook')`),
    check(
      'alert_recipient_category_check',
      sql`${t.category} ~ '^(\\*|[a-z][a-z0-9_]*(\\.[a-z0-9_]+)*)$' and length(${t.category}) <= 80`,
    ),
    /** The console needs no address; every other channel names one, by reference. */
    check(
      'alert_recipient_address_shape_check',
      sql`(${t.channel} = 'console' and ${t.addressRef} is null) or (${t.channel} <> 'console' and ${t.addressRef} is not null)`,
    ),
    /** A reference, never an address: no `@`, no `://`, an upper-case ALERT_ name only. */
    check(
      'alert_recipient_address_ref_check',
      sql`${t.addressRef} is null or (position('@' in ${t.addressRef}) = 0 and position('://' in ${t.addressRef}) = 0 and ${t.addressRef} ~ '^ALERT_[A-Z0-9_]{2,58}$')`,
    ),
    check('alert_recipient_branch_operator_check', sql`${t.branchId} is null or ${t.operatorId} is not null`),
    check('alert_recipient_label_check', sql`${t.label} is null or length(${t.label}) <= 120`),
  ],
);

/**
 * One decision not to deliver one condition for a while.
 *
 * Per FINGERPRINT: the `ops_run` fingerprint the Failures page groups by (the
 * same one a `ops.failing` alert carries in its detail), or an alert's key.
 * `operator_id` null is a platform condition's mute, which only a
 * platform-wide caller may make. The alert itself is still raised, counted and
 * shown; what the mute changes is delivery, and each delivery it held back is
 * recorded as `alert_delivery.status = 'muted'` pointing here — a muted alert
 * is recorded as muted, never dropped.
 *
 * Bounded by the database as well as by the route: a reason is required, and
 * `muted_until` is at most 24 hours after `starts_at`.
 */
export const alertMute = core.table(
  'alert_mute',
  {
    id: idPk(),
    fingerprint: text('fingerprint').notNull(),
    operatorId: uuid('operator_id').references(() => operator.id),
    reason: text('reason').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    mutedUntil: timestamp('muted_until', { withTimezone: true, mode: 'date' }).notNull(),
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => account.id),
    /** Ended early by a person (or superseded by a fresh decision). Never deleted. */
    liftedAt: timestamp('lifted_at', { withTimezone: true, mode: 'date' }),
    liftedByAccountId: uuid('lifted_by_account_id').references(() => account.id),
    ...timestamps,
  },
  (t) => [
    index('alert_mute_fingerprint_idx').on(t.fingerprint, t.mutedUntil),
    index('alert_mute_operator_idx').on(t.operatorId),
    index('alert_mute_created_by_idx').on(t.createdByAccountId),
    index('alert_mute_lifted_by_idx').on(t.liftedByAccountId),
    check('alert_mute_fingerprint_check', sql`length(${t.fingerprint}) between 4 and 200`),
    check('alert_mute_reason_check', sql`length(btrim(${t.reason})) between 1 and 500`),
    check(
      'alert_mute_window_check',
      sql`${t.mutedUntil} > ${t.startsAt} and ${t.mutedUntil} <= ${t.startsAt} + interval '24 hours'`,
    ),
    check(
      'alert_mute_lifted_check',
      sql`(${t.liftedAt} is null) = (${t.liftedByAccountId} is null)`,
    ),
  ],
);
