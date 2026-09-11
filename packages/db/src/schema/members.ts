import {
  boolean,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, idPk, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';

// --- Tiers -----------------------------------------------------------------
// Editable data, not an enum (prototype `TierDef`, ARCHITECTURE.md D2).
// `code` is the stable slug used by price maps and member.tier ('tourist' …).
export const tier = pgTable(
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

export const memberCreatedVia = pgEnum('member_created_via', ['pos', 'booking', 'import']);
export const contactChannel = pgEnum('contact_channel', ['whatsapp', 'telegram']);

export const member = pgTable(
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
    preferredChannel: contactChannel('preferred_channel'),
    notes: text('notes'),
    createdVia: memberCreatedVia('created_via').notNull().default('pos'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    uniqueIndex('member_phone_unique').on(t.operatorId, t.phone),
    index('member_operator_idx').on(t.operatorId),
    index('member_phone_idx').on(t.phone),
  ],
);

/**
 * Verified discounted-tier entitlement (prototype `TierVerification` +
 * CLAUDE.md §4 fields). Schema only this sprint; the till reads the LATEST
 * row per member as the active verification.
 */
export const memberTierVerification = pgTable(
  'member_tier_verification',
  {
    id: idPk(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
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
 */
export const child = pgTable(
  'child',
  {
    id: idPk(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
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

export const visitStatus = pgEnum('visit_status', ['draft', 'active', 'closed']);

export const visit = pgTable(
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
    status: visitStatus('status').notNull().default('draft'),
    createdByAccountId: uuid('created_by_account_id').references(() => account.id),
    ...timestamps,
  },
  (t) => [
    index('visit_operator_idx').on(t.operatorId),
    index('visit_branch_idx').on(t.branchId),
    index('visit_member_idx').on(t.memberId),
    index('visit_date_idx').on(t.visitDate),
  ],
);

export const visitChild = pgTable(
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
