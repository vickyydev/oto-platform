import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, idPk, inbox, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { fileObject } from './platform';

// --- The Unified Inbox (schema `inbox`) --------------------------------------
//
// S2-19 I1 (SCRUM-578; plan docs/progress/plans/inbox-build/PLAN.md §1, the
// design docs/features/inbox.md "Core tables"). One inbox for every customer
// message the park receives: the channel accounts it arrives on, the person
// behind it, the thread, its owners, its timeline, and the raw webhook that
// brought it.
//
// THE RULES EVERY TABLE HERE KEEPS.
//   - `operator_id` on every row, a real foreign key to `core.operator`.
//   - Enumerations are text with a CHECK, never a pg enum, so a new channel
//     is a constraint swap and not a type lock (as `crm.member`'s channels).
//   - THE TENANT FENCE. Every reference from one inbox row to another is a
//     COMPOSITE foreign key `(operator_id, x_id) → x(operator_id, id)`, so a
//     message, an assignment or a timeline event can never point into another
//     operator's thread — not by a bug in a service, not from psql. Each
//     referenced table carries a `<table>_tenant_key` unique constraint on
//     `(operator_id, id)` for the key to land on. A table-level constraint
//     rather than an index because Drizzle emits foreign keys before indexes.
//   - Cross-schema links to `crm` and to the OTO App (`member_id`,
//     `department_id`, `booking_ref`, `event_order_ref`) are SOFT: a plain
//     column, no foreign key across a schema boundary. `core` accounts,
//     branches and files are hard keys, as every other app schema has them.
//   - PDPA from day one. Message bodies, previews, transcripts and webhook
//     payloads are personal data: erasure columns (`erased_at`,
//     `redacted_at`, `payload_purged_at`) and the retention date
//     (`retain_until`) exist before any of it is written, so switching a
//     purge on later is configuration (owner Q19), not a migration.

/** Every channel a contact can be on. `telegram` is a contact value with no adapter (owner Q22). */
export const INBOX_CHANNELS = ['whatsapp', 'instagram', 'facebook', 'line', 'telegram', 'webform'] as const;
export type InboxChannel = (typeof INBOX_CHANNELS)[number];

/**
 * Who carries a channel account's traffic. `console` is the SMS console sender
 * the check-in confirmation already goes through (`can_reply = false`);
 * `simulator` is the twin of a Meta account that local, CI and staging play
 * conversations through.
 */
export const INBOX_PROVIDERS = [
  'meta_cloud',
  'meta_graph',
  'line',
  'respond_io',
  'webform',
  'simulator',
  'console',
] as const;
export type InboxProvider = (typeof INBOX_PROVIDERS)[number];

export const CHANNEL_ACCOUNT_STATUSES = ['active', 'paused', 'error'] as const;
export type ChannelAccountStatus = (typeof CHANNEL_ACCOUNT_STATUSES)[number];

/** The three categories of the IT Brief, each owned by a team. */
export const INBOX_CATEGORIES = ['birthdays', 'general', 'marketing'] as const;
export type InboxCategory = (typeof INBOX_CATEGORIES)[number];

/** A team's kind. `reception` is per branch; the other two are operator-wide. */
export const INBOX_TEAM_KEYS = ['birthdays', 'reception', 'marketing'] as const;
export type InboxTeamKey = (typeof INBOX_TEAM_KEYS)[number];

/** IT Brief: two statuses, and no conversation is ever without an owner. */
export const CONVERSATION_STATUSES = ['active', 'handled'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/** `system` is a notice the platform sent (the check-in confirmation), never a person. */
export const MESSAGE_AUTHOR_KINDS = ['customer', 'staff', 'ai', 'system'] as const;
export type MessageAuthorKind = (typeof MESSAGE_AUTHOR_KINDS)[number];

export const MESSAGE_PROVIDER_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed'] as const;
export type MessageProviderStatus = (typeof MESSAGE_PROVIDER_STATUSES)[number];

/** Where a message came from: a channel, or a platform notice mirrored into the thread (plan §2.4). */
export const MESSAGE_SOURCES = ['channel', 'checkin.contact', 'booking.confirmation'] as const;
export type MessageSource = (typeof MESSAGE_SOURCES)[number];

export const ASSIGNMENT_SLOTS = ['primary', 'support'] as const;
export type AssignmentSlot = (typeof ASSIGNMENT_SLOTS)[number];
export const ASSIGNEE_KINDS = ['account', 'team', 'ai'] as const;
export type AssigneeKind = (typeof ASSIGNEE_KINDS)[number];
export const ASSIGNED_BY_KINDS = ['account', 'ai', 'system'] as const;
export type AssignedByKind = (typeof ASSIGNED_BY_KINDS)[number];
export const ASSIGNMENT_REASONS = ['auto', 'manual', 'divert', 'move', 'reopen'] as const;
export type AssignmentReason = (typeof ASSIGNMENT_REASONS)[number];

/** `team` is the reception phone of a branch, or a rule whose person nobody has named yet. */
export const ROUTING_PRIMARY_KINDS = ['account', 'team'] as const;
export type RoutingPrimaryKind = (typeof ROUTING_PRIMARY_KINDS)[number];

/** The template keys the briefs define (`inbox.md` "Templates"). */
export const INBOX_TEMPLATE_KEYS = [
  'welcome',
  'handover_birthday',
  'handover_events',
  'handover_complaint_online',
  'handover_complaint_onsite',
  'handover_lost_found',
  'handover_marketing',
  'out_of_hours',
] as const;
export type InboxTemplateKey = (typeof INBOX_TEMPLATE_KEYS)[number];

export const TEMPLATE_APPROVAL_STATUSES = ['not_required', 'pending', 'approved', 'rejected'] as const;
export type TemplateApprovalStatus = (typeof TEMPLATE_APPROVAL_STATUSES)[number];

/** The timeline's grey pills and the Console feed. `notice_mirrored` is the check-in feed (plan §2.4). */
export const INBOX_EVENT_KINDS = [
  'received',
  'ai_replied',
  'classified',
  'routed',
  'assigned',
  'released',
  'diverted',
  'moved_team',
  'branch_set',
  'handled',
  'reopened',
  'date_booked',
  'beo_saved',
  'translated',
  'pos_update',
  'sla_breached',
  'notice_mirrored',
] as const;
export type InboxEventKind = (typeof INBOX_EVENT_KINDS)[number];

export const INBOX_ACTOR_KINDS = ['customer', 'account', 'ai', 'system'] as const;
export type InboxActorKind = (typeof INBOX_ACTOR_KINDS)[number];

/** `'a','b'` for a CHECK, from one of the lists above, so the list is said once. */
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(','));

/** The null branch's stand-in inside a COALESCE, so a null and a null collide in a unique index. */
const NO_BRANCH = sql.raw(`'00000000-0000-0000-0000-000000000000'::uuid`);

/** The E.164 shape every phone column in the platform is held to (SCRUM-292). */
const E164 = sql.raw(`'^\\+[1-9][0-9]{6,14}$'`);

const tenantFk = () => ({ onDelete: 'restrict' as const });

// --- channel_account ---------------------------------------------------------

/**
 * A number, page or account the park receives messages on.
 *
 * `credential_ref` is the NAME of a secret in the hosting dashboard, never its
 * value. `branch_id` null means operator-wide. `default_category` is the
 * classification a conversation gets when nothing classifies it (no AI yet,
 * owner Q24). `can_reply` is false on a `console` account: the check-in
 * notices are read-only threads until a real channel exists.
 */
export const channelAccount = inbox.table(
  'channel_account',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, tenantFk()),
    branchId: uuid('branch_id').references(() => branch.id, { onDelete: 'restrict' }),
    channel: text('channel').$type<InboxChannel>().notNull(),
    provider: text('provider').$type<InboxProvider>().notNull(),
    /** The provider's id for it: a phone-number id, a page id, a LINE channel id; `console:<channel>` for the console sender. */
    externalId: text('external_id').notNull(),
    displayName: text('display_name').notNull(),
    credentialRef: text('credential_ref'),
    /** `{ mon: { open: "10:00", close: "20:00" }, … }` in the branch timezone; null = always open. */
    openingHours: jsonb('opening_hours'),
    outOfHoursTemplateKey: text('out_of_hours_template_key').$type<InboxTemplateKey>(),
    defaultCategory: text('default_category').$type<InboxCategory>().notNull().default('general'),
    canReply: boolean('can_reply').notNull().default(true),
    status: text('status').$type<ChannelAccountStatus>().notNull().default('active'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    unique('channel_account_tenant_key').on(t.operatorId, t.id),
    uniqueIndex('channel_account_external_unique')
      .on(t.operatorId, t.provider, t.externalId)
      .where(sql`archived_at is null`),
    index('channel_account_operator_idx').on(t.operatorId),
    index('channel_account_branch_idx').on(t.branchId),
    check('channel_account_channel_check', sql`${t.channel} in (${inList(INBOX_CHANNELS)})`),
    check('channel_account_provider_check', sql`${t.provider} in (${inList(INBOX_PROVIDERS)})`),
    check('channel_account_status_check', sql`${t.status} in (${inList(CHANNEL_ACCOUNT_STATUSES)})`),
    check(
      'channel_account_default_category_check',
      sql`${t.defaultCategory} in (${inList(INBOX_CATEGORIES)})`,
    ),
    check(
      'channel_account_out_of_hours_key_check',
      sql`${t.outOfHoursTemplateKey} is null or ${t.outOfHoursTemplateKey} in (${inList(INBOX_TEMPLATE_KEYS)})`,
    ),
    /** A console account only sends notices; it can never carry a reply. */
    check('channel_account_console_reply_check', sql`${t.provider} <> 'console' or not ${t.canReply}`),
  ],
);

// --- contact -----------------------------------------------------------------

/**
 * The per-channel identity of a customer: a WhatsApp phone, an
 * Instagram-scoped id, a Messenger PSID, a LINE user id.
 *
 * `member_id` is a soft link to `crm.member` (joined by E.164 within the
 * operator for WhatsApp). PDPA erasure anonymises in place: the name becomes
 * "Erased contact", the handle a hash, phone and member link null, and
 * `erased_at` is set — the row stays so the counts still add up.
 */
export const contact = inbox.table(
  'contact',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, tenantFk()),
    channel: text('channel').$type<InboxChannel>().notNull(),
    externalHandle: text('external_handle').notNull(),
    displayName: text('display_name'),
    avatarFileId: uuid('avatar_file_id').references(() => fileObject.id, { onDelete: 'restrict' }),
    /** E.164 when known. */
    phone: text('phone'),
    /** Soft link to `crm.member` — no foreign key across schemas. */
    memberId: uuid('member_id'),
    language: text('language'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true, mode: 'date' }),
    erasedAt: timestamp('erased_at', { withTimezone: true, mode: 'date' }),
    erasedByAccountId: uuid('erased_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    unique('contact_tenant_key').on(t.operatorId, t.id),
    uniqueIndex('contact_handle_unique').on(t.operatorId, t.channel, t.externalHandle),
    index('contact_phone_idx').on(t.operatorId, t.phone),
    index('contact_member_idx').on(t.memberId),
    index('contact_avatar_file_idx').on(t.avatarFileId),
    index('contact_erased_by_idx').on(t.erasedByAccountId),
    check('contact_channel_check', sql`${t.channel} in (${inList(INBOX_CHANNELS)})`),
    check('contact_phone_check', sql`${t.phone} is null or ${t.phone} ~ ${E164}`),
    /** An erased contact carries no phone and no member link (PDPA). */
    check(
      'contact_erased_check',
      sql`${t.erasedAt} is null or (${t.phone} is null and ${t.memberId} is null)`,
    ),
  ],
);

// --- team --------------------------------------------------------------------

/**
 * A queue: Birthdays & Events, Reception per branch, Marketing.
 *
 * Membership is not stored here. `department_id` points (softly) at a
 * `core.department`, and a person is "in the team" by holding the
 * `inbox_agent` role scoped to that department — so a change of staff is a
 * Console edit, never code. Reception reuses each branch's own `reception`
 * department; the other two get operator-wide departments of their own.
 */
export const team = inbox.table(
  'team',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, tenantFk()),
    key: text('key').$type<InboxTeamKey>().notNull(),
    /** Set only for `reception`. */
    branchId: uuid('branch_id').references(() => branch.id, { onDelete: 'restrict' }),
    /** Soft link to `core.department`. */
    departmentId: uuid('department_id'),
    name: text('name').notNull(),
    colour: text('colour').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    unique('team_tenant_key').on(t.operatorId, t.id),
    uniqueIndex('team_key_unique').on(t.operatorId, t.key, sql`coalesce(${t.branchId}, ${NO_BRANCH})`),
    index('team_branch_idx').on(t.branchId),
    index('team_department_idx').on(t.departmentId),
    check('team_key_check', sql`${t.key} in (${inList(INBOX_TEAM_KEYS)})`),
    /** Reception is a branch's desk; the other teams serve every branch. */
    check('team_branch_check', sql`(${t.key} = 'reception') = (${t.branchId} is not null)`),
  ],
);

// --- routing_rule ------------------------------------------------------------

/**
 * The IT Brief's fixed pairs: for a category, language and branch, who is the
 * default primary and which backup is added as support from the first message.
 *
 * Null `language` / `branch_id` mean "any". `primary_kind = 'team'` is the
 * reception phone, and also every rule whose person nobody has named yet —
 * the seed lays the people BLANK (owner Q20) and naming them is an edit, not
 * code. One catch-all per team (`primary_kind = 'team'`, no language, no
 * branch) guarantees routing can never leave a conversation unowned.
 */
export const routingRule = inbox.table(
  'routing_rule',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, tenantFk()),
    teamId: uuid('team_id').notNull(),
    category: text('category').$type<InboxCategory>().notNull(),
    language: text('language'),
    branchId: uuid('branch_id').references(() => branch.id, { onDelete: 'restrict' }),
    primaryKind: text('primary_kind').$type<RoutingPrimaryKind>().notNull(),
    primaryAccountId: uuid('primary_account_id').references(() => account.id, { onDelete: 'restrict' }),
    backupAccountId: uuid('backup_account_id').references(() => account.id, { onDelete: 'restrict' }),
    autoAddBackup: boolean('auto_add_backup').notNull().default(true),
    /** Highest wins among the active rules that match. */
    priority: integer('priority').notNull().default(0),
    active: boolean('active').notNull().default(true),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    foreignKey({
      columns: [t.operatorId, t.teamId],
      foreignColumns: [team.operatorId, team.id],
      name: 'routing_rule_team_fk',
    }).onDelete('restrict'),
    index('routing_rule_team_idx').on(t.operatorId, t.teamId),
    index('routing_rule_lookup_idx').on(t.operatorId, t.category, t.active),
    index('routing_rule_branch_idx').on(t.branchId),
    index('routing_rule_primary_account_idx').on(t.primaryAccountId),
    index('routing_rule_backup_account_idx').on(t.backupAccountId),
    check('routing_rule_category_check', sql`${t.category} in (${inList(INBOX_CATEGORIES)})`),
    check('routing_rule_primary_kind_check', sql`${t.primaryKind} in (${inList(ROUTING_PRIMARY_KINDS)})`),
    /** A person-primary names the person; a team-primary names nobody. */
    check(
      'routing_rule_primary_account_check',
      sql`(${t.primaryKind} = 'account') = (${t.primaryAccountId} is not null)`,
    ),
    check(
      'routing_rule_backup_distinct_check',
      sql`${t.backupAccountId} is null or ${t.primaryAccountId} is null or ${t.backupAccountId} <> ${t.primaryAccountId}`,
    ),
  ],
);

// --- template ----------------------------------------------------------------

/**
 * The welcome line, the handover lines per category and the out-of-hours
 * reply, per language (and optionally per channel or branch — the birthday
 * brochure is per branch). `approval_status` is Meta's; `not_required` until
 * a Meta account exists. `needs_translation` marks a RU or TH row whose body
 * is still the English source.
 */
export const template = inbox.table(
  'template',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, tenantFk()),
    key: text('key').$type<InboxTemplateKey>().notNull(),
    language: text('language').notNull(),
    /** Null = any channel. */
    channel: text('channel').$type<InboxChannel>(),
    /** Null = any branch. */
    branchId: uuid('branch_id').references(() => branch.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    attachmentFileIds: uuid('attachment_file_ids').array().notNull().default(sql`'{}'::uuid[]`),
    providerTemplateName: text('provider_template_name'),
    approvalStatus: text('approval_status').$type<TemplateApprovalStatus>().notNull().default('not_required'),
    needsTranslation: boolean('needs_translation').notNull().default(false),
    active: boolean('active').notNull().default(true),
    updatedByAccountId: uuid('updated_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    unique('template_tenant_key').on(t.operatorId, t.id),
    uniqueIndex('template_key_unique')
      .on(
        t.operatorId,
        t.key,
        t.language,
        sql`coalesce(${t.channel}, '')`,
        sql`coalesce(${t.branchId}, ${NO_BRANCH})`,
      )
      .where(sql`archived_at is null`),
    index('template_branch_idx').on(t.branchId),
    index('template_updated_by_idx').on(t.updatedByAccountId),
    check('template_key_check', sql`${t.key} in (${inList(INBOX_TEMPLATE_KEYS)})`),
    check('template_channel_check', sql`${t.channel} is null or ${t.channel} in (${inList(INBOX_CHANNELS)})`),
    check(
      'template_approval_status_check',
      sql`${t.approvalStatus} in (${inList(TEMPLATE_APPROVAL_STATUSES)})`,
    ),
  ],
);

// --- conversation ------------------------------------------------------------

/**
 * One continuous thread per contact per channel account
 * (`conversation_thread_unique`): that is what makes "the customer writes
 * again" reopen the SAME thread rather than start another.
 *
 * `last_message_preview` is at most 140 characters and is cleared on
 * erasure. `retain_until` null means no purge (owner Q19's default).
 */
export const conversation = inbox.table(
  'conversation',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, tenantFk()),
    contactId: uuid('contact_id').notNull(),
    channelAccountId: uuid('channel_account_id').notNull(),
    teamId: uuid('team_id'),
    branchId: uuid('branch_id').references(() => branch.id, { onDelete: 'restrict' }),
    category: text('category').$type<InboxCategory>().notNull().default('general'),
    intent: text('intent'),
    language: text('language'),
    status: text('status').$type<ConversationStatus>().notNull().default('active'),
    handledAt: timestamp('handled_at', { withTimezone: true, mode: 'date' }),
    handledByKind: text('handled_by_kind').$type<'account' | 'ai'>(),
    handledByAccountId: uuid('handled_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    reopenedAt: timestamp('reopened_at', { withTimezone: true, mode: 'date' }),
    firstResponseAt: timestamp('first_response_at', { withTimezone: true, mode: 'date' }),
    lastCustomerMessageAt: timestamp('last_customer_message_at', { withTimezone: true, mode: 'date' }),
    lastStaffMessageAt: timestamp('last_staff_message_at', { withTimezone: true, mode: 'date' }),
    lastRoutedAt: timestamp('last_routed_at', { withTimezone: true, mode: 'date' }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true, mode: 'date' }),
    lastMessagePreview: text('last_message_preview'),
    /** Soft link to `crm.member`, denormalised from the contact. */
    memberId: uuid('member_id'),
    /** Soft keys: a POS booking, an OTO App event order (owner Q23 — unused). */
    bookingRef: text('booking_ref'),
    eventOrderRef: text('event_order_ref'),
    /** Unused until the AI (owner Q24). */
    aiSummary: text('ai_summary'),
    retainUntil: timestamp('retain_until', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    unique('conversation_tenant_key').on(t.operatorId, t.id),
    foreignKey({
      columns: [t.operatorId, t.contactId],
      foreignColumns: [contact.operatorId, contact.id],
      name: 'conversation_contact_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.operatorId, t.channelAccountId],
      foreignColumns: [channelAccount.operatorId, channelAccount.id],
      name: 'conversation_channel_account_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.operatorId, t.teamId],
      foreignColumns: [team.operatorId, team.id],
      name: 'conversation_team_fk',
    }).onDelete('restrict'),
    uniqueIndex('conversation_thread_unique').on(t.operatorId, t.contactId, t.channelAccountId),
    index('conversation_queue_idx').on(t.operatorId, t.status, t.teamId),
    index('conversation_recent_idx').on(t.operatorId, t.lastMessageAt.desc()),
    index('conversation_contact_idx').on(t.contactId),
    index('conversation_channel_account_idx').on(t.operatorId, t.channelAccountId),
    index('conversation_team_idx').on(t.operatorId, t.teamId),
    index('conversation_branch_idx').on(t.branchId),
    index('conversation_handled_at_idx').on(t.operatorId, t.handledAt),
    index('conversation_handled_by_idx').on(t.handledByAccountId),
    index('conversation_member_idx').on(t.memberId),
    index('conversation_retain_until_idx').on(t.retainUntil),
    check('conversation_category_check', sql`${t.category} in (${inList(INBOX_CATEGORIES)})`),
    check('conversation_status_check', sql`${t.status} in (${inList(CONVERSATION_STATUSES)})`),
    check(
      'conversation_handled_by_kind_check',
      sql`${t.handledByKind} is null or ${t.handledByKind} in ('account','ai')`,
    ),
    /** Handled always says when; handled by a person always says who. */
    check('conversation_handled_check', sql`${t.status} <> 'handled' or ${t.handledAt} is not null`),
    check(
      'conversation_handled_by_check',
      sql`${t.handledByKind} is distinct from 'account' or ${t.handledByAccountId} is not null`,
    ),
    check(
      'conversation_preview_length_check',
      sql`${t.lastMessagePreview} is null or char_length(${t.lastMessagePreview}) <= 140`,
    ),
  ],
);

// --- message -----------------------------------------------------------------

/**
 * One message in a thread, either way.
 *
 * `channel_account_id` is carried beside `conversation_id` (it is the
 * conversation's) because a provider's message id is unique only within one
 * provider account: `message_external_unique` is what makes a replayed
 * webhook one message. A mirrored notice gets a synthetic external id
 * (`checkin.contact:<regId>:<sentAt>`, plan §2.4) and its `source`.
 *
 * PDPA: erasure nulls `body`, `transcript` and `translated_body` and sets
 * `redacted_at`; the row, its direction and its times stay.
 */
export const message = inbox.table(
  'message',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, tenantFk()),
    conversationId: uuid('conversation_id').notNull(),
    channelAccountId: uuid('channel_account_id').notNull(),
    direction: text('direction').$type<MessageDirection>().notNull(),
    authorKind: text('author_kind').$type<MessageAuthorKind>().notNull(),
    authorAccountId: uuid('author_account_id').references(() => account.id, { onDelete: 'restrict' }),
    body: text('body'),
    bodyLanguage: text('body_language'),
    translatedBody: text('translated_body'),
    translatedTo: text('translated_to'),
    mediaFileIds: uuid('media_file_ids').array().notNull().default(sql`'{}'::uuid[]`),
    audioFileId: uuid('audio_file_id').references(() => fileObject.id, { onDelete: 'restrict' }),
    transcript: text('transcript'),
    templateId: uuid('template_id'),
    externalMessageId: text('external_message_id'),
    /** Delivery state of an outbound message; null on an inbound one. */
    providerStatus: text('provider_status').$type<MessageProviderStatus>(),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    source: text('source').$type<MessageSource>().notNull().default('channel'),
    /** The id of what a mirrored notice stands for (a registration, a booking). */
    sourceId: text('source_id'),
    redactedAt: timestamp('redacted_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    unique('message_tenant_key').on(t.operatorId, t.id),
    foreignKey({
      columns: [t.operatorId, t.conversationId],
      foreignColumns: [conversation.operatorId, conversation.id],
      name: 'message_conversation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.operatorId, t.channelAccountId],
      foreignColumns: [channelAccount.operatorId, channelAccount.id],
      name: 'message_channel_account_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.operatorId, t.templateId],
      foreignColumns: [template.operatorId, template.id],
      name: 'message_template_fk',
    }).onDelete('restrict'),
    uniqueIndex('message_external_unique')
      .on(t.channelAccountId, t.externalMessageId)
      .where(sql`external_message_id is not null`),
    /** The thread, oldest to newest, and its `before` cursor. */
    index('message_thread_idx').on(t.conversationId, t.createdAt),
    index('message_conversation_fk_idx').on(t.operatorId, t.conversationId),
    index('message_channel_account_idx').on(t.operatorId, t.channelAccountId),
    index('message_template_idx').on(t.operatorId, t.templateId),
    index('message_author_account_idx').on(t.authorAccountId),
    index('message_audio_file_idx').on(t.audioFileId),
    /** What a mirror looks for before it writes the same notice twice. */
    index('message_source_idx')
      .on(t.operatorId, t.source, t.sourceId)
      .where(sql`source <> 'channel'`),
    check('message_direction_check', sql`${t.direction} in (${inList(MESSAGE_DIRECTIONS)})`),
    check('message_author_kind_check', sql`${t.authorKind} in (${inList(MESSAGE_AUTHOR_KINDS)})`),
    check(
      'message_provider_status_check',
      sql`${t.providerStatus} is null or ${t.providerStatus} in (${inList(MESSAGE_PROVIDER_STATUSES)})`,
    ),
    check('message_source_check', sql`${t.source} in (${inList(MESSAGE_SOURCES)})`),
    /** The customer is the only one who writes in; everyone else writes out. */
    check('message_direction_author_check', sql`(${t.direction} = 'inbound') = (${t.authorKind} = 'customer')`),
    /** A staff message names its author. */
    check('message_staff_author_check', sql`${t.authorKind} <> 'staff' or ${t.authorAccountId} is not null`),
    /** A mirrored notice is the platform's, never a person's or a channel's. */
    check(
      'message_notice_check',
      sql`${t.source} = 'channel' or (${t.authorKind} = 'system' and ${t.sourceId} is not null)`,
    ),
  ],
);

// --- participant -------------------------------------------------------------

/** Per-viewer read state: the basis of unread counts. */
export const participant = inbox.table(
  'participant',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, tenantFk()),
    conversationId: uuid('conversation_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastReadMessageId: uuid('last_read_message_id'),
    lastReadAt: timestamp('last_read_at', { withTimezone: true, mode: 'date' }),
    mutedAt: timestamp('muted_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.operatorId, t.conversationId],
      foreignColumns: [conversation.operatorId, conversation.id],
      name: 'participant_conversation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.operatorId, t.lastReadMessageId],
      foreignColumns: [message.operatorId, message.id],
      name: 'participant_last_read_message_fk',
    }).onDelete('restrict'),
    uniqueIndex('participant_unique').on(t.conversationId, t.accountId),
    index('participant_conversation_fk_idx').on(t.operatorId, t.conversationId),
    index('participant_account_idx').on(t.accountId),
    index('participant_last_read_message_idx').on(t.operatorId, t.lastReadMessageId),
  ],
);

// --- assignment --------------------------------------------------------------

/**
 * Who owns a conversation: one primary, up to two support, from any team.
 *
 * A row is never deleted; it is released (`released_at`), so "who held it,
 * when" is the assignment history. Among the ACTIVE rows (released_at null):
 *   - `assignment_active_slot_unique` on (conversation, slot_index): index 0
 *     is the primary, 1 and 2 the two support places — the prototype's
 *     `primary` / `support1` / `support2` (`WhatsAppDemo.tsx` `Slot`). One
 *     primary and at most two support is therefore a property of the table,
 *     not of a count a service has to get right under concurrency.
 *   - one row per person (`assignment_active_account_unique`) and one per
 *     team (`assignment_active_team_unique`): a person holds one slot only.
 */
export const assignment = inbox.table(
  'assignment',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, tenantFk()),
    conversationId: uuid('conversation_id').notNull(),
    slot: text('slot').$type<AssignmentSlot>().notNull(),
    /** 0 = primary; 1 and 2 = the two support places. */
    slotIndex: smallint('slot_index').notNull(),
    assigneeKind: text('assignee_kind').$type<AssigneeKind>().notNull(),
    accountId: uuid('account_id').references(() => account.id, { onDelete: 'restrict' }),
    teamId: uuid('team_id'),
    assignedByKind: text('assigned_by_kind').$type<AssignedByKind>().notNull(),
    assignedByAccountId: uuid('assigned_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    reason: text('reason').$type<AssignmentReason>().notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.operatorId, t.conversationId],
      foreignColumns: [conversation.operatorId, conversation.id],
      name: 'assignment_conversation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.operatorId, t.teamId],
      foreignColumns: [team.operatorId, team.id],
      name: 'assignment_team_fk',
    }).onDelete('restrict'),
    uniqueIndex('assignment_active_slot_unique')
      .on(t.conversationId, t.slotIndex)
      .where(sql`released_at is null`),
    uniqueIndex('assignment_active_account_unique')
      .on(t.conversationId, t.accountId)
      .where(sql`released_at is null and account_id is not null`),
    uniqueIndex('assignment_active_team_unique')
      .on(t.conversationId, t.teamId)
      .where(sql`released_at is null and team_id is not null`),
    index('assignment_conversation_fk_idx').on(t.operatorId, t.conversationId),
    index('assignment_team_idx').on(t.operatorId, t.teamId),
    /** "My Inbox": the conversations I am on. */
    index('assignment_account_idx').on(t.accountId, t.releasedAt),
    index('assignment_assigned_by_idx').on(t.assignedByAccountId),
    check('assignment_slot_check', sql`${t.slot} in (${inList(ASSIGNMENT_SLOTS)})`),
    check(
      'assignment_slot_index_check',
      sql`(${t.slot} = 'primary' and ${t.slotIndex} = 0) or (${t.slot} = 'support' and ${t.slotIndex} in (1,2))`,
    ),
    check('assignment_assignee_kind_check', sql`${t.assigneeKind} in (${inList(ASSIGNEE_KINDS)})`),
    check('assignment_assigned_by_kind_check', sql`${t.assignedByKind} in (${inList(ASSIGNED_BY_KINDS)})`),
    check('assignment_reason_check', sql`${t.reason} in (${inList(ASSIGNMENT_REASONS)})`),
    /** The assignee is exactly what its kind says: a person, a team, or the AI. */
    check(
      'assignment_assignee_check',
      sql`(${t.assigneeKind} = 'account' and ${t.accountId} is not null and ${t.teamId} is null)
          or (${t.assigneeKind} = 'team' and ${t.teamId} is not null and ${t.accountId} is null)
          or (${t.assigneeKind} = 'ai' and ${t.accountId} is null and ${t.teamId} is null)`,
    ),
    check(
      'assignment_assigned_by_check',
      sql`${t.assignedByKind} <> 'account' or ${t.assignedByAccountId} is not null`,
    ),
  ],
);

// --- tag / conversation_tag (created, unused) --------------------------------

/** Free tags. Unused: the briefs use the structured category and intent. */
export const tag = inbox.table(
  'tag',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, tenantFk()),
    name: text('name').notNull(),
    colour: text('colour'),
    ...timestamps,
  },
  (t) => [unique('tag_tenant_key').on(t.operatorId, t.id), uniqueIndex('tag_name_unique').on(t.operatorId, t.name)],
);

export const conversationTag = inbox.table(
  'conversation_tag',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, tenantFk()),
    conversationId: uuid('conversation_id').notNull(),
    tagId: uuid('tag_id').notNull(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.operatorId, t.conversationId],
      foreignColumns: [conversation.operatorId, conversation.id],
      name: 'conversation_tag_conversation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.operatorId, t.tagId],
      foreignColumns: [tag.operatorId, tag.id],
      name: 'conversation_tag_tag_fk',
    }).onDelete('restrict'),
    uniqueIndex('conversation_tag_unique').on(t.conversationId, t.tagId),
    index('conversation_tag_conversation_fk_idx').on(t.operatorId, t.conversationId),
    index('conversation_tag_tag_idx').on(t.operatorId, t.tagId),
  ],
);

// --- sla_policy (created, unused — owner Q25) --------------------------------

export const slaPolicy = inbox.table(
  'sla_policy',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, tenantFk()),
    teamId: uuid('team_id').notNull(),
    firstResponseTargetS: integer('first_response_target_s'),
    followUpTargetS: integer('follow_up_target_s'),
    businessHours: jsonb('business_hours'),
    alertChannel: text('alert_channel'),
    active: boolean('active').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.operatorId, t.teamId],
      foreignColumns: [team.operatorId, team.id],
      name: 'sla_policy_team_fk',
    }).onDelete('restrict'),
    index('sla_policy_team_idx').on(t.operatorId, t.teamId),
    check(
      'sla_policy_targets_check',
      sql`(${t.firstResponseTargetS} is null or ${t.firstResponseTargetS} > 0) and (${t.followUpTargetS} is null or ${t.followUpTargetS} > 0)`,
    ),
  ],
);

// --- event -------------------------------------------------------------------

/**
 * The timeline's system pills and the Console feed: routed, assigned,
 * handled, reopened, a notice mirrored.
 *
 * `payload` NEVER holds a message body — ids, slots, statuses, the team, the
 * branch, template keys. Append-only by trigger (migration 0078): an UPDATE
 * is refused except inside the PDPA erasure (`oto.inbox_erasure = on`, and
 * then only `payload` may change), a DELETE except inside a retention purge
 * (`oto.inbox_purge = on`).
 */
export const inboxEvent = inbox.table(
  'event',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, tenantFk()),
    conversationId: uuid('conversation_id').notNull(),
    kind: text('kind').$type<InboxEventKind>().notNull(),
    actorKind: text('actor_kind').$type<InboxActorKind>().notNull(),
    actorAccountId: uuid('actor_account_id').references(() => account.id, { onDelete: 'restrict' }),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.operatorId, t.conversationId],
      foreignColumns: [conversation.operatorId, conversation.id],
      name: 'event_conversation_fk',
    }).onDelete('restrict'),
    index('event_timeline_idx').on(t.conversationId, t.createdAt),
    index('event_conversation_fk_idx').on(t.operatorId, t.conversationId),
    index('event_actor_account_idx').on(t.actorAccountId),
    check('event_kind_check', sql`${t.kind} in (${inList(INBOX_EVENT_KINDS)})`),
    check('event_actor_kind_check', sql`${t.actorKind} in (${inList(INBOX_ACTOR_KINDS)})`),
    check('event_actor_account_check', sql`${t.actorKind} <> 'account' or ${t.actorAccountId} is not null`),
    check('event_payload_object_check', sql`jsonb_typeof(${t.payload}) = 'object'`),
  ],
);

// --- note (reserved, unused) -------------------------------------------------

/** Reserved: the IT Brief forbids staff-only notes inside a thread. */
export const inboxNote = inbox.table(
  'note',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, tenantFk()),
    conversationId: uuid('conversation_id').notNull(),
    authorAccountId: uuid('author_account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    body: text('body'),
    redactedAt: timestamp('redacted_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.operatorId, t.conversationId],
      foreignColumns: [conversation.operatorId, conversation.id],
      name: 'note_conversation_fk',
    }).onDelete('restrict'),
    index('note_conversation_fk_idx').on(t.operatorId, t.conversationId),
    index('note_author_account_idx').on(t.authorAccountId),
  ],
);

// --- webhook_receipt ---------------------------------------------------------

/**
 * Every webhook delivery, written FIRST, before anything is parsed: the
 * provider's event id is its own idempotency key, unique per channel account
 * (a provider's ids are only unique within one of its accounts). A replay
 * conflicts here and ends. `payload` is a raw duplicate of personal data, so
 * it has the shortest retention once a period is set (`payload_purged_at`).
 */
export const webhookReceipt = inbox.table(
  'webhook_receipt',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, tenantFk()),
    channelAccountId: uuid('channel_account_id').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    signatureOk: boolean('signature_ok').notNull(),
    payload: jsonb('payload'),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    error: text('error'),
    payloadPurgedAt: timestamp('payload_purged_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.operatorId, t.channelAccountId],
      foreignColumns: [channelAccount.operatorId, channelAccount.id],
      name: 'webhook_receipt_channel_account_fk',
    }).onDelete('restrict'),
    uniqueIndex('webhook_receipt_event_unique').on(t.channelAccountId, t.providerEventId),
    index('webhook_receipt_channel_account_fk_idx').on(t.operatorId, t.channelAccountId),
    index('webhook_receipt_received_idx').on(t.receivedAt),
    /** A purged payload is gone. */
    check('webhook_receipt_purged_check', sql`${t.payloadPurgedAt} is null or ${t.payload} is null`),
  ],
);
