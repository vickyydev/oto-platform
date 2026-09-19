import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, crm, idPk, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';

// --- The customer (schema `crm`) -------------------------------------------

// --- Tiers -----------------------------------------------------------------
// Editable data, not an enum (prototype `TierDef`, ARCHITECTURE.md D2).
// `code` is the stable slug used by price maps and member.tier ('tourist' …).
// It lives in `crm` rather than with the catalogue: a tier is what a PERSON
// is, and the catalogue merely prices by it.
export const tier = crm.table(
  'tier',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** The no-verification baseline; exactly one per operator (enforced in service). */
    isDefault: boolean('is_default').notNull().default(false),
    requiresVerification: boolean('requires_verification').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    uniqueIndex('tier_code_unique').on(t.operatorId, t.code),
    index('tier_operator_idx').on(t.operatorId),
  ],
);

export const MEMBER_CREATED_VIA = ['pos', 'booking', 'import'] as const;
export type MemberCreatedVia = (typeof MEMBER_CREATED_VIA)[number];

/**
 * How a member is messaged. Text + CHECK rather than a pg enum (S2-01b): the
 * Unified Inbox adds channels as accounts are connected, and adding a value
 * must not take a DDL lock. `instagram` joins the set now (S2-19).
 */
export const CONTACT_CHANNELS = ['whatsapp', 'telegram', 'line', 'instagram'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export const member = crm.table(
  'member',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    /** E.164; unique per operator — the duplicate safeguard (SCRUM-31). */
    phone: text('phone').notNull(),
    name: text('name'),
    /** The prototype's primary display name. */
    nickname: text('nickname').notNull(),
    email: text('email'),
    /** Tier code ('tourist' default). Soft reference to tier.code. */
    tierCode: text('tier_code').notNull().default('tourist'),
    /** Prototype `preferredChannel` — how this member is messaged. */
    preferredChannel: text('preferred_channel').$type<ContactChannel>(),
    notes: text('notes'),
    createdVia: text('created_via').$type<MemberCreatedVia>().notNull().default('pos'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    uniqueIndex('member_phone_unique').on(t.operatorId, t.phone),
    index('member_operator_idx').on(t.operatorId),
    index('member_phone_idx').on(t.phone),
    check(
      'member_preferred_channel_check',
      sql`${t.preferredChannel} is null or ${t.preferredChannel} in ('whatsapp','telegram','line','instagram')`,
    ),
    check('member_created_via_check', sql`${t.createdVia} in ('pos','booking','import')`),
  ],
);

/**
 * Verified discounted-tier entitlement (prototype `TierVerification` +
 * CLAUDE.md §4 fields). The till reads the LATEST row per member as the
 * active verification.
 */
export const memberTierVerification = crm.table(
  'member_tier_verification',
  {
    id: idPk(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id),
    fromTier: text('from_tier').notNull(),
    toTier: text('to_tier').notNull(),
    /** Prototype `proofType`, e.g. 'Passport', 'Residence certificate'. */
    evidenceType: text('evidence_type').notNull(),
    evidenceExpiresAt: timestamp('evidence_expires_at', { withTimezone: true, mode: 'date' }),
    verifiedByAccountId: uuid('verified_by_account_id').references(() => account.id),
    branchId: uuid('branch_id').references(() => branch.id),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('mtv_member_idx').on(t.memberId),
    index('mtv_branch_idx').on(t.branchId),
    index('mtv_verified_by_idx').on(t.verifiedByAccountId),
  ],
);

/**
 * Child linked to a guardian member (prototype `SavedChild`; photo is NEVER
 * stored — re-taken each visit). `consent_recorded_at` is the minimum privacy
 * marker adopted pending the client's answer to Q3 (BACKEND_REQUIREMENTS.md).
 *
 * The member reference is RESTRICT, not CASCADE (S2-01b): a child record
 * carries allergies and medical notes, and deleting a guardian must never
 * silently take those with it. Members are archived, not deleted.
 */
export const child = crm.table(
  'child',
  {
    id: idPk(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    dateOfBirth: date('date_of_birth'),
    /** Age snapshot fallback for records captured before DOB existed (prototype rule). */
    ageYears: integer('age_years'),
    /** Prototype `allergiesMedical`. */
    allergies: text('allergies'),
    medicalNotes: text('medical_notes'),
    medicalAlert: boolean('medical_alert').notNull().default(false),
    dietary: text('dietary'),
    foodRestrictions: text('food_restrictions'),
    notes: text('notes'),
    lastConfirmedAt: timestamp('last_confirmed_at', { withTimezone: true, mode: 'date' }),
    consentRecordedAt: timestamp('consent_recorded_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [index('child_member_idx').on(t.memberId)],
);

export const VISIT_STATUSES = ['draft', 'active', 'closed'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export const visit = crm.table(
  'visit',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id),
    /** Null = walk-in with no membership. */
    memberId: uuid('member_id').references(() => member.id),
    visitDate: date('visit_date').notNull(),
    status: text('status').$type<VisitStatus>().notNull().default('draft'),
    createdByAccountId: uuid('created_by_account_id').references(() => account.id),
    ...timestamps,
  },
  (t) => [
    index('visit_operator_idx').on(t.operatorId),
    index('visit_branch_idx').on(t.branchId),
    index('visit_member_idx').on(t.memberId),
    index('visit_date_idx').on(t.visitDate),
    check('visit_status_check', sql`${t.status} in ('draft','active','closed')`),
  ],
);

export const visitChild = crm.table(
  'visit_child',
  {
    visitId: uuid('visit_id')
      .notNull()
      .references(() => visit.id, { onDelete: 'cascade' }),
    childId: uuid('child_id')
      .notNull()
      .references(() => child.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.visitId, t.childId] }), index('visit_child_child_idx').on(t.childId)],
);
