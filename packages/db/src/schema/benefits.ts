import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { BenefitProfile, BenefitRole } from '@oto/shared';
import { archivedAt, idPk, promo, timestamps } from './helpers';
import { account, employee, operator } from './tenancy';

// --- Staff benefits (schema `promo`) ---------------------------------------------
//
// S2-21 (SCRUM-218), round 1 of docs/progress/plans/benefits/PLAN.md §7: the
// role templates and each person's benefit, both with effective dates and a
// history. Round 2 adds the credential (`benefit_credential`, at the end of
// this file); the usage counters and the application record are round 3.
//
// **Versions, never edits.** A change is a NEW row. The row that was in force
// on the change's date is closed (`effective_to` set to that date) and the new
// one runs from that date to wherever the closed one ran. Nothing else on a
// row is ever updated, so the history is the table: who changed what (the
// row's profile and `created_by_account_id`), when (`created_at`), and from
// which day it counted (`effective_from`). A change dated tomorrow leaves
// today's row in force until then (plan H4, H5).
//
// **Ranges are half-open dates**, `[effective_from, effective_to)`, on the
// trading day; `effective_to` null runs on. A version replaced on the day it
// was due to start keeps its row with `effective_to = effective_from` — an
// empty range, in force on no day, kept so the history still shows it.
//
// **No two ranges of one template, or of one person, overlap** (plan H18). The
// service takes an advisory lock on the template or the person before it
// writes, and the partial unique indexes below hold the one case the database
// can state cheaply: at most one open-ended row. An exclusion constraint would
// state the whole rule but needs `btree_gist`; the plan leaves that choice for
// review (§7).

/**
 * One version of a role template — the profile every person with that benefit
 * role has unless they carry an override. Operator-wide, as in the prototype
 * (`getRoleBenefitTemplates` is global, catalogStore.ts:1150).
 */
export const benefitRoleTemplate = promo.table(
  'benefit_role_template',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    role: text('role').$type<BenefitRole>().notNull(),
    /** The prototype's display name: "Owner", "Manager", "Staff". */
    name: text('name').notNull(),
    /** The prototype's `BenefitProfile`, amounts in satang (`@oto/shared` benefits.ts). */
    profile: jsonb('profile').$type<BenefitProfile>().notNull(),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    /** Exclusive. Null = in force from `effective_from` on. */
    effectiveTo: date('effective_to', { mode: 'string' }),
    /** Who saved this version. Null for a version the seed wrote. */
    createdByAccountId: uuid('created_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    ...timestamps,
  },
  (t) => [
    index('benefit_role_template_operator_idx').on(t.operatorId, t.role, t.effectiveFrom),
    index('benefit_role_template_created_by_idx').on(t.createdByAccountId),
    uniqueIndex('benefit_role_template_open_unique')
      .on(t.operatorId, t.role)
      .where(sql`effective_to is null`),
    check('benefit_role_template_role_check', sql`${t.role} in ('owner','manager','staff')`),
    check(
      'benefit_role_template_range_check',
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/**
 * One version of a person's benefit: which role template they take, and their
 * override while one is switched on. The person is a `core.employee` — copied
 * from the OTO App once the mirror exists, seeded until then — and never the
 * login account: the benefit role is separate from the login role (prototype
 * `Operator.benefitRole`, types.ts:7-12).
 */
export const benefitProfile = promo.table(
  'benefit_profile',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    /** Null = no benefit and no QR (prototype: an operator with no `benefitRole`). */
    benefitRole: text('benefit_role').$type<BenefitRole>(),
    /**
     * Null = the role template as it stands on the day. Set = this person's
     * WHOLE profile while it is on (plan Q1; prototype
     * `resolveEffectiveBenefitProfile`), amounts in satang.
     */
    override: jsonb('override').$type<BenefitProfile>(),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    /** Exclusive. Null = in force from `effective_from` on. */
    effectiveTo: date('effective_to', { mode: 'string' }),
    /** Who saved this version. Null for a version the seed wrote. */
    createdByAccountId: uuid('created_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('benefit_profile_operator_idx').on(t.operatorId),
    index('benefit_profile_employee_idx').on(t.employeeId, t.effectiveFrom),
    index('benefit_profile_created_by_idx').on(t.createdByAccountId),
    uniqueIndex('benefit_profile_open_unique')
      .on(t.employeeId)
      .where(sql`effective_to is null and archived_at is null`),
    check(
      'benefit_profile_role_check',
      sql`${t.benefitRole} is null or ${t.benefitRole} in ('owner','manager','staff')`,
    ),
    check(
      'benefit_profile_range_check',
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/**
 * One staff benefit QR (S2-21 round 2; plan §4 and §7): a credential the
 * platform signed for one person, revocable, with an expiry of its own.
 *
 * **The row is the credential's record, never the credential.** The QR is
 * `OTO-BEN:v1:<employee>:<id>:<exp>:<kid>` and an Ed25519 signature
 * (`@oto/shared` benefit-credential.ts); none of that is a secret except the
 * private key, which lives in the api's environment and nowhere else. What is
 * kept is what a revocation and an audit need: whose it is, which key signed
 * it, when it ends, who issued and who revoked it. `code_hash` is SHA-256 over
 * the whole printed code, so the cloud can tell the QR it issued from another
 * string that happens to verify — and it is a hash, so this table cannot be
 * read back into QRs. The printable code is re-derived when an administrator
 * asks for it (Ed25519 signatures are deterministic), which needs the same key
 * still configured.
 *
 * **What ends one.** `revoked_at` — the administrator's revoke, refused by
 * the cloud at once and by a box from its next `benefits` pull; `expires_at`
 * — its own terms; and the person leaving (`core.employee.archived_at`),
 * which refuses every QR of theirs without touching these rows.
 */
export const benefitCredential = promo.table(
  'benefit_credential',
  {
    /** The `<credential>` in the QR, and the value a revocation names. UUIDv7. */
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    /**
     * Which `core.signing_key` row (purpose `benefit_qr`) verifies it. Text,
     * not a foreign key, for the reason `core.staff_token.kid` gives: a QR
     * signed under a key since retired is still a fact about what was issued.
     */
    kid: text('kid').notNull(),
    /** The QR format's version (`BENEFIT_CREDENTIAL_VERSION`). */
    version: integer('version').notNull().default(1),
    /** Lower-case hex SHA-256 of the printed code. Never the code. */
    codeHash: text('code_hash').notNull(),
    issuedByAccountId: uuid('issued_by_account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedByAccountId: uuid('revoked_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    /** When the cloud last resolved it — "is this card in use". Not audited. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    index('benefit_credential_operator_idx').on(t.operatorId),
    /** One person's QRs, newest first — the Staff Benefits QR dialog. */
    index('benefit_credential_employee_idx').on(t.employeeId, t.issuedAt),
    index('benefit_credential_issued_by_idx').on(t.issuedByAccountId),
    index('benefit_credential_revoked_by_idx').on(t.revokedByAccountId),
    /**
     * The revocation list the `benefits` scope carries: revoked and still
     * inside their own lifetime. Partial, so it holds what a box is sent.
     */
    index('benefit_credential_revoked_idx')
      .on(t.operatorId, t.expiresAt)
      .where(sql`revoked_at is not null`),
    uniqueIndex('benefit_credential_code_hash_unique').on(t.codeHash),
    check('benefit_credential_expiry_check', sql`${t.expiresAt} > ${t.issuedAt}`),
    check('benefit_credential_version_check', sql`${t.version} >= 1`),
    /** A revoker without a revocation reads as revoked and is not. */
    check(
      'benefit_credential_revocation_check',
      sql`${t.revokedAt} is not null or ${t.revokedByAccountId} is null`,
    ),
  ],
);
