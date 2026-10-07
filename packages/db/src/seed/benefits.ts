/**
 * Staff benefits for the demo tenant (S2-21, SCRUM-218, round 1 of
 * docs/progress/plans/benefits/PLAN.md).
 *
 * The prototype's three role templates (`seedRoleBenefitTemplates`,
 * catalogStore.ts:802-841) at its own amounts — plan Q2's default — and the
 * prototype roster's benefit roles (`mockOperators`, mockApi.ts:430-435) on
 * the seeded employees of the same names:
 *
 *   Owner    comp
 *   Manager  2 free coffees a day, ฿500 a month credit, 30 % off F&B
 *   Staff    2 free coffees a day, 30 % off F&B
 *
 *   Khun Anan  owner      Som  staff      Khun Lek  manager
 *   Nok        staff, with an override: the Staff template with 4 coffees a
 *              day (the plan's named fixture, §6 row 1)
 *
 * Khun Dao (Robinson Chalong) is not in the prototype's roster and is given
 * no benefit role, which is the prototype's "no role, no benefit".
 *
 * "Coffee" is the prototype's `drinks-coffee` category, which the menu seed
 * writes as `DRINKS-COFFEE`; the templates point at that row's id.
 *
 * Find-or-create: a template role or a person that already has ANY version is
 * left alone, so a change made on screen survives a re-seed.
 */
import {
  BENEFIT_ROLE_NAMES,
  newId,
  satangFromBaht,
  type BenefitProfile,
  type BenefitRole,
} from '@oto/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../index';
import * as s from '../schema/index';

/** The day the seeded versions are in force from: before any demo trading day. */
export const BENEFIT_SEED_EFFECTIVE_FROM = '2026-01-01';

/** The prototype's three templates, the free coffee pointed at `coffeeCategoryId`. */
export function seedBenefitTemplates(
  coffeeCategoryId: string,
): Record<BenefitRole, BenefitProfile> {
  const coffee = {
    id: 'coffee',
    label: 'Free coffee',
    target: { kind: 'fnbCategory' as const, category: coffeeCategoryId },
    quotaPerPeriod: 2,
    period: 'daily' as const,
  };
  return {
    owner: { comp: true },
    manager: {
      freeItems: [coffee],
      credit: { amountSatang: satangFromBaht(500), period: 'monthly' },
      standingDiscount: { percent: 30, target: { kind: 'fnb' } },
    },
    staff: {
      freeItems: [coffee],
      standingDiscount: { percent: 30, target: { kind: 'fnb' } },
    },
  };
}

export async function seedBenefits(
  db: Db,
  input: {
    operatorId: string;
    /** Employee ids by the prototype roster's names. */
    employees: { anan: string; som: string; nok: string; lek: string };
  },
): Promise<void> {
  const [coffeeCategory] = await db
    .select({ id: s.productCategory.id })
    .from(s.productCategory)
    .where(
      and(
        eq(s.productCategory.operatorId, input.operatorId),
        eq(s.productCategory.code, 'DRINKS-COFFEE'),
      ),
    )
    .limit(1);
  if (!coffeeCategory) {
    throw new Error('Benefits seed: the menu seed did not write the DRINKS-COFFEE category');
  }
  const templates = seedBenefitTemplates(coffeeCategory.id);

  for (const role of ['owner', 'manager', 'staff'] as const) {
    const [held] = await db
      .select({ id: s.benefitRoleTemplate.id })
      .from(s.benefitRoleTemplate)
      .where(
        and(
          eq(s.benefitRoleTemplate.operatorId, input.operatorId),
          eq(s.benefitRoleTemplate.role, role),
        ),
      )
      .limit(1);
    if (held) continue;
    await db.insert(s.benefitRoleTemplate).values({
      id: newId(),
      operatorId: input.operatorId,
      role,
      name: BENEFIT_ROLE_NAMES[role],
      profile: templates[role],
      effectiveFrom: BENEFIT_SEED_EFFECTIVE_FROM,
    });
  }

  // Nok's override: the Staff template, filled in as the override dialog
  // fills it, with the coffee quota raised to four.
  const nokOverride: BenefitProfile = {
    ...templates.staff,
    freeItems: (templates.staff.freeItems ?? []).map((f) => ({ ...f, quotaPerPeriod: 4 })),
  };
  const people: Array<{ employeeId: string; role: BenefitRole; override: BenefitProfile | null }> =
    [
      { employeeId: input.employees.anan, role: 'owner', override: null },
      { employeeId: input.employees.som, role: 'staff', override: null },
      { employeeId: input.employees.nok, role: 'staff', override: nokOverride },
      { employeeId: input.employees.lek, role: 'manager', override: null },
    ];
  for (const person of people) {
    const [held] = await db
      .select({ id: s.benefitProfile.id })
      .from(s.benefitProfile)
      .where(eq(s.benefitProfile.employeeId, person.employeeId))
      .limit(1);
    if (held) continue;
    await db.insert(s.benefitProfile).values({
      id: newId(),
      operatorId: input.operatorId,
      employeeId: person.employeeId,
      benefitRole: person.role,
      override: person.override,
      effectiveFrom: BENEFIT_SEED_EFFECTIVE_FROM,
    });
  }
}
