import { sql } from 'drizzle-orm';
import { check, date, index, jsonb, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { BenefitProfile, BenefitRole } from '@oto/shared';
import { archivedAt, idPk, promo, timestamps } from './helpers';
import { account, employee, operator } from './tenancy';

// --- Staff benefits (schema `promo`) ---------------------------------------------
//
// S2-21 (SCRUM-218), round 1 of docs/progress/plans/benefits/PLAN.md §7: the
// role templates and each person's benefit, both with effective dates and a
// history. The credential, the usage counters and the application record are
// rounds 2 and 3.
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
