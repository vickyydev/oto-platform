import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { archivedAt, crm, idPk, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { station } from './fleet';

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
    /** Partial (SCRUM-273): an archived tier does not hold its code. */
    uniqueIndex('tier_code_unique')
      .on(t.operatorId, t.code)
      .where(sql`archived_at is null`),
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
    /**
     * Set when a merge put children recorded at two counters on this member
     * (plan `offline/PLAN.md` OD-7): the children are never merged
     * automatically, so staff confirm who is who at the next visit and no
     * allergy note disappears. Cleared by the next visit that confirms them.
     */
    childrenReviewSince: timestamp('children_review_since', { withTimezone: true, mode: 'date' }),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    /**
     * Partial (SCRUM-273): an archived member no longer holds the phone. The
     * prototype's admin delete removed the member outright and freed the
     * number; archiving keeps the history but must free it the same way, or a
     * mistyped duplicate reception archives blocks the real person for ever.
     */
    uniqueIndex('member_phone_unique')
      .on(t.operatorId, t.phone)
      .where(sql`archived_at is null`),
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
 * A member id that was merged into another (plan `offline/PLAN.md` §2.6, OD-7).
 *
 * The same phone typed at two counters while both were offline makes two
 * members with two till-minted ids. At sync the first to arrive survives and
 * the second is recorded as a merge (`member.created` in `services/sync.ts`).
 * Its id does not disappear with it: the child, visit and sale facts that
 * second counter queued afterwards all name it. This row is what lets them
 * land on the survivor instead of waiting in quarantine for a member that will
 * never exist.
 *
 * `alias_member_id` is the discarded id and the primary key: an id is merged
 * once, into one survivor. It has no foreign key because the member it names
 * was never written. `source_event_id` is the `member.created` event that was
 * merged, which is also on the `member.merge` audit row.
 */
export const memberAlias = crm.table(
  'member_alias',
  {
    aliasMemberId: uuid('alias_member_id').primaryKey(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'restrict' }),
    sourceEventId: uuid('source_event_id'),
    ...timestamps,
  },
  (t) => [
    index('member_alias_member_idx').on(t.memberId),
    index('member_alias_operator_idx').on(t.operatorId),
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
    /**
     * SCRUM-772 — the till the session that recorded it was signed in at,
     * from the SESSION like the verifier. With the Thai rate confirmed at the
     * till and no document behind it, who, where and when is the record.
     * Null on rows before this column and on rows a box replays.
     */
    stationId: uuid('station_id').references(() => station.id),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('mtv_member_idx').on(t.memberId),
    index('mtv_branch_idx').on(t.branchId),
    index('mtv_verified_by_idx').on(t.verifiedByAccountId),
    index('mtv_station_idx').on(t.stationId),
  ],
);

/**
 * How a family or a guardian row came to be (SCRUM-1024, plan
 * `docs/progress/plans/dropoff-beo-20261119/FAMILY_PROFILES_PLAN.md` §2.2):
 * `backfill` for records saved before families existed (and the demo seed,
 * which stands for them), `till` for a child added at a counter, `sync` for a
 * child a counter box recorded, `booking` for one the family added on the
 * booking site, `link` for a parent or guardian reception adds later.
 */
export const FAMILY_SOURCES = ['backfill', 'till', 'sync', 'booking', 'link'] as const;
export type FamilySource = (typeof FAMILY_SOURCES)[number];

/**
 * A family: the children several parents or guardians share (SCRUM-1024).
 *
 * Not to be confused with `crm.guardian` (schema `checkin.ts`), which is an
 * authorised collector on ONE drop-off registration. A family is the lasting
 * record: its parents and guardians are `crm.family_guardian` rows, and each
 * child names its family in `crm.child.family_id`. A member may be a guardian
 * in several families (a blended household); a child is in one.
 *
 * `(operator_id, id)` is the tenant fence, the inbox pattern: the guardian
 * rows reach their family by a composite foreign key onto it, so a guardian
 * row can never name another operator's family.
 *
 * Expand only (plan §3): the till, the box and the booking site still read a
 * child through `child.member_id`; nothing reads a family until the readers
 * are switched behind the `crm.family_profiles` switch.
 */
export const family = crm.table(
  'family',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    source: text('source').$type<FamilySource>().notNull(),
    /** The signed-in staff member whose action made it; null for the box, the booking site and the backfill. */
    createdByAccountId: uuid('created_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    unique('family_tenant_key').on(t.operatorId, t.id),
    index('family_created_by_idx').on(t.createdByAccountId),
    check('family_source_check', sql`${t.source} in ('backfill','till','sync','booking','link')`),
  ],
);

/**
 * A parent or guardian of a family (SCRUM-1024): one row per member per
 * family, with who added them, where and when (`created_at`).
 *
 * One LIVE row per family and member (`family_guardian_live_unique`); an
 * archived row is the record of a guardian who was taken off, which the plan
 * leaves for a later step. The member reference is a plain foreign key: the
 * member's operator is checked by the service that writes the row
 * (`apps/api/src/services/family.ts`), because `crm.member` carries no
 * `(operator_id, id)` key to fence onto and building one would lock the
 * member register while it is built.
 */
export const familyGuardian = crm.table(
  'family_guardian',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    familyId: uuid('family_id').notNull(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'restrict' }),
    source: text('source').$type<FamilySource>().notNull(),
    addedByAccountId: uuid('added_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branch.id, { onDelete: 'restrict' }),
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    foreignKey({
      columns: [t.operatorId, t.familyId],
      foreignColumns: [family.operatorId, family.id],
      name: 'family_guardian_family_fk',
    }).onDelete('restrict'),
    uniqueIndex('family_guardian_live_unique')
      .on(t.familyId, t.memberId)
      .where(sql`archived_at is null`),
    /** "Which families is this member a live guardian of" — every lookup by a parent's number. */
    index('family_guardian_member_live_idx')
      .on(t.memberId)
      .where(sql`archived_at is null`),
    // Every foreign key leads an index of its own, archived rows included, so
    // a RESTRICT check never scans the table.
    index('family_guardian_operator_idx').on(t.operatorId),
    index('family_guardian_family_idx').on(t.familyId),
    index('family_guardian_member_idx').on(t.memberId),
    index('family_guardian_added_by_idx').on(t.addedByAccountId),
    index('family_guardian_branch_idx').on(t.branchId),
    index('family_guardian_station_idx').on(t.stationId),
    check('family_guardian_source_check', sql`${t.source} in ('backfill','till','sync','booking','link')`),
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
 *
 * SCRUM-1024: `member_id` keeps its meaning, "first saved under", and every
 * reader still uses it. `family_id` is the family the child belongs to, set on
 * every child written from now on and by the backfill on the ones before;
 * null until then, which nothing may trip on. `merged_into_child_id` is set
 * only on a duplicate reception says is the same child (a later step).
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
    /** SCRUM-1024 — the child's family; null only on a child saved before it was set (the backfill's work). */
    familyId: uuid('family_id').references(() => family.id, { onDelete: 'restrict' }),
    /** SCRUM-1024 — on a duplicate only: the child reception said it is the same as. */
    mergedIntoChildId: uuid('merged_into_child_id').references((): AnyPgColumn => child.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    index('child_member_idx').on(t.memberId),
    index('child_family_idx').on(t.familyId),
    index('child_merged_into_idx').on(t.mergedIntoChildId),
  ],
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
