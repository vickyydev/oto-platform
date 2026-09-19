/**
 * Seed (CLAUDE.md §4): one operator "OTO", branch "HKT Central"
 * (Asia/Bangkok), departments, system roles generated from
 * @oto/shared ROLE_BUNDLES, a platform admin + a reception account with known
 * dev passwords, six members with children (≥1 allergy), the prototype's four
 * ticket packages (values ported 1:1 from catalogStore.ts seeds, in satang),
 * one holiday range, and the 7% inclusive VAT tax config.
 *
 * Re-runnable — this is the `platform:sync` step (S2-01b). Sprint 1's seed
 * bailed out once the OTO operator existed, so a permission added to a bundle
 * never reached a database that had already been seeded. Now every write is
 * an upsert or a find-or-create: what the platform owns (system roles and
 * their permissions, tiers, the catalogue) converges on each run, while the
 * demo rows (accounts, members, children) are created once and then left
 * alone, so a password changed or a note edited on staging survives a sync.
 */
import { hash } from '@node-rs/argon2';
import {
  newId,
  normalizePhone,
  ROLE_BUNDLES,
  SYSTEM_ROLES,
  satangFromBaht,
  wwp,
  TAXABLE_CATEGORIES,
  type SystemRole,
  type TaxConfigShape,
  type WWPrice,
} from '@oto/shared';
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { closeDb, getDb, type Db } from '../index';
import * as s from '../schema/index';

const b = satangFromBaht;

// Prototype pricing constants (catalogStore.ts:176-258), in satang.
const ADULT_ADMISSION: WWPrice = wwp(b(350), b(500));
const STANDARD_ADULT_RULES = {
  tourist: { kind: 'set_price', price: ADULT_ADMISSION },
  expat: { kind: 'set_price', price: ADULT_ADMISSION },
  thai: { kind: 'set_price', price: ADULT_ADMISSION },
};
const ADULTS_FULL_CREDIT = { appliesTo: 'adults', basis: 'full_price' };
// Expat kid pricing derives from Tourist: −30% weekday, −20% weekend.
const expatFromTourist = (t: WWPrice): WWPrice =>
  wwp(Math.round(t.weekday * 0.7), Math.round(t.weekend * 0.8));

/**
 * The rows the platform owns rather than any operator: the system role
 * bundles. Separate from the demo tenant below so a deploy can re-sync access
 * against a real database without seeding fixtures into it.
 */
export async function platformSync(db: Db = getDb()): Promise<Record<SystemRole, string>> {
  const roleIds = {} as Record<SystemRole, string>;
  for (const roleName of SYSTEM_ROLES) {
    const description = `System role: ${roleName}`;
    const [row] = await db
      .insert(s.role)
      .values({ id: newId(), operatorId: null, name: roleName, description, isSystem: true })
      .onConflictDoUpdate({
        // A system role's operator_id is null and Postgres treats nulls as
        // distinct, so role_name_unique never fires for one: the conflict
        // lands on the partial index over name alone.
        target: s.role.name,
        targetWhere: sql`${s.role.operatorId} is null`,
        set: { description, isSystem: true },
      })
      .returning({ id: s.role.id });
    const roleId = row!.id;
    roleIds[roleName] = roleId;

    const bundle = ROLE_BUNDLES[roleName];
    // A sync has to be able to take a permission away, not only hand one out.
    await db
      .delete(s.rolePermission)
      .where(
        and(eq(s.rolePermission.roleId, roleId), notInArray(s.rolePermission.permission, bundle)),
      );
    await db
      .insert(s.rolePermission)
      .values(bundle.map((permission) => ({ id: newId(), roleId, permission })))
      .onConflictDoNothing({ target: [s.rolePermission.roleId, s.rolePermission.permission] });
  }
  return roleIds;
}

export async function seed(db: Db = getDb()): Promise<void> {
  const roleIds = await platformSync(db);

  // `operator` has no natural business key, so the name is the seed's own
  // handle on the demo tenant.
  const [existingOperator] = await db
    .select({ id: s.operator.id })
    .from(s.operator)
    .where(eq(s.operator.name, 'OTO'))
    .limit(1);
  const operatorId = existingOperator?.id ?? newId();
  if (!existingOperator) await db.insert(s.operator).values({ id: operatorId, name: 'OTO' });

  const [branchRow] = await db
    .insert(s.branch)
    .values({
      id: newId(),
      operatorId,
      name: 'HKT Central',
      code: 'hkt-central',
      timezone: 'Asia/Bangkok',
      country: 'TH',
    })
    .onConflictDoUpdate({
      target: [s.branch.operatorId, s.branch.code],
      set: { name: 'HKT Central', timezone: 'Asia/Bangkok', country: 'TH' },
    })
    .returning({ id: s.branch.id });
  const branchId = branchRow!.id;

  // Departments (CLAUDE.md §4).
  const deptIds: Record<string, string> = {};
  for (const name of ['reception', 'restaurant', 'floor', 'nanny']) {
    const [found] = await db
      .select({ id: s.department.id })
      .from(s.department)
      .where(
        and(
          eq(s.department.operatorId, operatorId),
          eq(s.department.branchId, branchId),
          eq(s.department.name, name),
        ),
      )
      .limit(1);
    const id = found?.id ?? newId();
    if (!found) await db.insert(s.department).values({ id, operatorId, branchId, name });
    deptIds[name] = id;
  }

  // Tiers — prototype seedTiers (catalogStore.ts:792), operator-wide.
  for (const [i, t] of (
    [
      { code: 'tourist', name: 'Tourist', isDefault: true, requiresVerification: false },
      { code: 'expat', name: 'Expat', isDefault: false, requiresVerification: true },
      { code: 'thai', name: 'Thai', isDefault: false, requiresVerification: true },
    ] as const
  ).entries()) {
    await db
      .insert(s.tier)
      .values({ id: newId(), operatorId, ...t, sortOrder: i })
      .onConflictDoUpdate({
        target: [s.tier.operatorId, s.tier.code],
        set: {
          name: t.name,
          isDefault: t.isDefault,
          requiresVerification: t.requiresVerification,
          sortOrder: i,
        },
      });
  }

  // Employees (prototype roster, mockApi.ts:430) + dev accounts.
  const emp = async (name: string, dept: string, phone: string) => {
    const e164 = normalizePhone(phone);
    const [found] = await db
      .select({ id: s.employee.id })
      .from(s.employee)
      .where(and(eq(s.employee.operatorId, operatorId), eq(s.employee.phone, e164!)))
      .limit(1);
    if (found) return found.id;
    const id = newId();
    await db.insert(s.employee).values({
      id,
      operatorId,
      name,
      branchId,
      departmentId: deptIds[dept] ?? null,
      phone: e164,
    });
    return id;
  };
  const empAnan = await emp('Khun Anan (Owner)', 'reception', '+66900000001');
  const empSom = await emp('Som (Reception)', 'reception', '+66900000002');
  await emp('Nok (Reception)', 'reception', '+66900000003');
  await emp('Khun Lek (Manager)', 'reception', '+66900000004');

  const mkAccount = async (
    employeeId: string,
    phone: string,
    password: string,
    roles: Array<{ role: SystemRole; scopeType: 'operator' | 'branch'; scopeId: string | null }>,
  ) => {
    const e164 = normalizePhone(phone)!;
    // A dev password someone has since changed stays changed.
    const [created] = await db
      .insert(s.account)
      .values({
        id: newId(),
        operatorId,
        employeeId,
        phone: e164,
        passwordHash: await hash(password),
        phoneVerifiedAt: new Date(),
        status: 'active',
      })
      .onConflictDoNothing({ target: [s.account.operatorId, s.account.phone] })
      .returning({ id: s.account.id });
    const [existing] = created
      ? []
      : await db
          .select({ id: s.account.id })
          .from(s.account)
          .where(and(eq(s.account.operatorId, operatorId), eq(s.account.phone, e164)))
          .limit(1);
    const id = (created ?? existing)!.id;
    // The assignments are re-checked even on an existing account: the dev
    // admin has to keep working after a role is added to the seed.
    for (const r of roles) {
      const roleId = roleIds[r.role];
      const [held] = await db
        .select({ id: s.roleAssignment.id })
        .from(s.roleAssignment)
        .where(
          and(
            eq(s.roleAssignment.accountId, id),
            eq(s.roleAssignment.roleId, roleId),
            eq(s.roleAssignment.scopeType, r.scopeType),
            r.scopeId === null
              ? isNull(s.roleAssignment.scopeId)
              : eq(s.roleAssignment.scopeId, r.scopeId),
          ),
        )
        .limit(1);
      if (held) continue;
      await db.insert(s.roleAssignment).values({
        id: newId(),
        accountId: id,
        roleId,
        scopeType: r.scopeType,
        scopeId: r.scopeId,
      });
    }
    return id;
  };

  // Known local-dev passwords (documented in .env.example / SPRINT_1_REPORT).
  const adminAccountId = await mkAccount(empAnan, '+66900000001', 'admin1234', [
    { role: 'platform_admin', scopeType: 'operator', scopeId: null }, // platform-wide
    { role: 'operator_admin', scopeType: 'operator', scopeId: operatorId },
  ]);
  await mkAccount(empSom, '+66900000002', 'reception1234', [
    { role: 'reception', scopeType: 'branch', scopeId: branchId },
  ]);

  // Members + children — ported from mockApi.ts seeds (Mali family incl.
  // peanut allergy) and extended to the six the brief asks for.
  const mkMember = async (m: {
    phone: string;
    nickname: string;
    tier?: string;
    evidence?: string;
    children?: Array<{
      name: string;
      age?: number;
      dob?: string;
      allergies?: string;
      dietary?: string;
      foodRestrictions?: string;
      medicalAlert?: boolean;
    }>;
  }) => {
    const [created] = await db
      .insert(s.member)
      .values({
        id: newId(),
        operatorId,
        phone: normalizePhone(m.phone)!,
        nickname: m.nickname,
        tierCode: m.tier ?? 'tourist',
        createdVia: 'import',
      })
      .onConflictDoNothing({ target: [s.member.operatorId, s.member.phone] })
      .returning({ id: s.member.id });
    // A demo family is written once. Its children and tier evidence carry no
    // unique key of their own, so the guardian's own row is what stops a
    // second run from giving Mali a second Nong Ploy.
    if (!created) return;
    const id = created.id;
    if (m.tier && m.tier !== 'tourist' && m.evidence) {
      // Demo records carry the full audit shape the counter flow now writes:
      // who checked (the seeded admin), where, and a document expiry.
      const expires = new Date();
      expires.setUTCFullYear(expires.getUTCFullYear() + 2);
      await db.insert(s.memberTierVerification).values({
        id: newId(),
        memberId: id,
        fromTier: 'tourist',
        toTier: m.tier,
        evidenceType: m.evidence,
        evidenceExpiresAt: expires,
        verifiedByAccountId: adminAccountId,
        branchId,
      });
    }
    for (const c of m.children ?? []) {
      await db.insert(s.child).values({
        id: newId(),
        memberId: id,
        name: c.name,
        ageYears: c.age ?? null,
        dateOfBirth: c.dob ?? null,
        allergies: c.allergies ?? null,
        dietary: c.dietary ?? null,
        foodRestrictions: c.foodRestrictions ?? null,
        medicalAlert: c.medicalAlert ?? Boolean(c.allergies),
        consentRecordedAt: new Date(),
      });
    }
  };

  await mkMember({
    phone: '+66811111111',
    nickname: 'Mali',
    tier: 'thai',
    evidence: 'Residence certificate',
    children: [
      {
        name: 'Nong Ploy',
        age: 5,
        allergies: 'Peanut allergy — carries an EpiPen',
        foodRestrictions: 'No pork',
        medicalAlert: true,
      },
      { name: 'Nong Tan', age: 7 },
    ],
  });
  await mkMember({ phone: '+66822222222', nickname: 'James', tier: 'expat', evidence: 'Passport' });
  await mkMember({
    phone: '+66833333333',
    nickname: 'Siti',
    tier: 'thai',
    evidence: 'Residence certificate',
  });
  await mkMember({ phone: '+66844444444', nickname: 'Alex' });
  await mkMember({
    phone: '+66855555555',
    nickname: 'Mama Som',
    children: [{ name: 'Little Emma', age: 6, dietary: 'Vegetarian' }],
  });
  await mkMember({
    phone: '+66866666666',
    nickname: 'Tom',
    children: [
      { name: 'Oliver', age: 4, allergies: 'Lactose intolerant', medicalAlert: true },
      { name: 'Sophia', age: 6 },
    ],
  });

  // Ticket packages — prototype seedTicketTypes (catalogStore.ts:196), satang.
  const T1H = wwp(b(690));
  const T2H = wwp(b(890));
  const TFD = wwp(b(1090));
  // Full display translations (5 customer languages) — real copy, extending
  // the prototype's seeded zh/th/ru/fr names to every package + descriptions.
  const packages = [
    {
      name: '1 Hour Play',
      description: 'One hour of play — perfect for a quick visit.',
      durationLabel: '1 Hour',
      hours: 1,
      prices: { tourist: T1H, expat: expatFromTourist(T1H), thai: wwp(b(420), b(520)) },
      adultRules: STANDARD_ADULT_RULES,
      creditRule: ADULTS_FULL_CREDIT,
      gateAccess: true,
      translations: {
        zh: { name: '1小时畅玩', description: '畅玩一小时——适合短暂到访。' },
        th: { name: 'เล่น 1 ชั่วโมง', description: 'เล่นสนุก 1 ชั่วโมง เหมาะกับการแวะมาเล่นสั้น ๆ' },
        ru: { name: 'Игра 1 час', description: 'Один час игры — идеально для короткого визита.' },
        fr: { name: 'Jeu 1 heure', description: 'Une heure de jeu — parfait pour une visite rapide.' },
      },
    },
    {
      name: '2 Hours Play',
      description: 'Two full hours in the park.',
      durationLabel: '2 Hours',
      hours: 2,
      prices: { tourist: T2H, expat: expatFromTourist(T2H), thai: wwp(b(520), b(620)) },
      adultRules: STANDARD_ADULT_RULES,
      creditRule: ADULTS_FULL_CREDIT,
      gateAccess: true,
      translations: {
        zh: { name: '2小时畅玩', description: '在乐园尽情玩两小时。' },
        th: { name: 'เล่น 2 ชั่วโมง', description: 'สนุกเต็มที่ 2 ชั่วโมงในสวนสนุก' },
        ru: { name: 'Игра 2 часа', description: 'Два полных часа в парке.' },
        fr: { name: 'Jeu 2 heures', description: 'Deux heures complètes dans le parc.' },
      },
    },
    {
      name: 'Full Day Pass',
      description: 'Unlimited play from open to close.',
      durationLabel: 'All Day',
      hours: 8,
      prices: { tourist: TFD, expat: expatFromTourist(TFD), thai: wwp(b(620), b(720)) },
      // Thai families: 1 free adult, overflow at the flat admission rate.
      adultRules: {
        tourist: { kind: 'set_price', price: ADULT_ADMISSION },
        expat: { kind: 'set_price', price: ADULT_ADMISSION },
        thai: { kind: 'free_adults', freeAdults: 1, overflow: 'set_price', price: ADULT_ADMISSION },
      },
      creditRule: ADULTS_FULL_CREDIT,
      gateAccess: true,
      translations: {
        zh: { name: '全日通票', description: '从开园玩到闭园，不限时畅玩。' },
        th: { name: 'บัตรเล่นทั้งวัน', description: 'เล่นไม่จำกัดตั้งแต่เปิดถึงปิด' },
        ru: { name: 'Билет на весь день', description: 'Неограниченная игра с открытия до закрытия.' },
        fr: { name: 'Pass journée complète', description: "Jeu illimité de l'ouverture à la fermeture." },
      },
    },
    {
      name: 'Eat & Play Kids Pass',
      description: "All-day play plus a kids' meal — the full ticket value comes back as F&B credit.",
      durationLabel: 'All Day + Meal',
      hours: 8,
      prices: { tourist: wwp(b(1300)), expat: wwp(b(1300)), thai: wwp(b(1300)) },
      // Fixed ฿350 adult even on weekends (prototype comment).
      adultRules: {
        tourist: { kind: 'set_price', price: wwp(b(350)) },
        expat: { kind: 'set_price', price: wwp(b(350)) },
        thai: { kind: 'set_price', price: wwp(b(350)) },
      },
      creditRule: { appliesTo: 'both', basis: 'full_price' },
      gateAccess: true,
      translations: {
        zh: { name: '吃喝玩乐儿童通票', description: '全天畅玩加儿童餐，票面金额全额返还为餐饮额度。' },
        th: { name: 'บัตรเด็ก กิน & เล่น', description: 'เล่นทั้งวันพร้อมอาหารเด็ก รับเครดิตอาหารเต็มมูลค่าบัตร' },
        ru: { name: 'Детский билет «Ешь и играй»', description: 'Игра весь день и детское питание; стоимость билета возвращается кредитом на еду.' },
        fr: { name: 'Pass enfant Manger & Jouer', description: 'Jeu toute la journée avec repas enfant — valeur du billet créditée en restauration.' },
      },
    },
  ];
  for (const { name, ...rest } of packages) {
    // The catalogue is reference data: a price corrected here reaches a
    // database that already has the package.
    await db
      .insert(s.ticketPackage)
      .values({ id: newId(), operatorId, branchId, name, ...rest })
      .onConflictDoUpdate({ target: [s.ticketPackage.branchId, s.ticketPackage.name], set: rest });
  }

  // One holiday range (future-dated so "today" stays weekday-priced).
  const holiday = { name: 'Loy Krathong', startsOn: '2026-11-24', endsOn: '2026-11-25' };
  const [holidayRow] = await db
    .select({ id: s.branchHoliday.id })
    .from(s.branchHoliday)
    .where(and(eq(s.branchHoliday.branchId, branchId), eq(s.branchHoliday.name, holiday.name)))
    .limit(1);
  if (!holidayRow) {
    await db.insert(s.branchHoliday).values({ id: newId(), branchId, ...holiday });
  }

  // Tax: 7% VAT inclusive on every category, stored_value untaxed, service 0,
  // discounts before tax — prototype seedTaxConfig (catalogStore.ts:719).
  const taxConfig: TaxConfigShape = {
    rates: [{ id: 'vat', name: 'VAT', percent: 7 }],
    categoryRules: TAXABLE_CATEGORIES.map((category) =>
      category === 'stored_value'
        ? { category, taxMode: 'none' as const, serviceChargePercent: 0, taxOnServiceCharge: false }
        : {
            category,
            taxRateId: 'vat',
            taxMode: 'inclusive' as const,
            serviceChargePercent: 0,
            taxOnServiceCharge: false,
          },
    ),
    discountPlacement: 'before_tax',
  };
  await db
    .insert(s.branchTaxConfig)
    .values({ id: newId(), branchId, config: taxConfig })
    .onConflictDoUpdate({ target: s.branchTaxConfig.branchId, set: { config: taxConfig } });

  // A product category + product so the tax-override resolver has targets.
  const [catRow] = await db
    .select({ id: s.productCategory.id })
    .from(s.productCategory)
    .where(and(eq(s.productCategory.operatorId, operatorId), eq(s.productCategory.name, 'F&B')))
    .limit(1);
  const catId = catRow?.id ?? newId();
  if (!catRow) {
    await db.insert(s.productCategory).values({
      id: catId,
      operatorId,
      name: 'F&B',
      taxableCategory: 'fnb',
    });
  }
  const [productRow] = await db
    .select({ id: s.product.id })
    .from(s.product)
    .where(and(eq(s.product.branchId, branchId), eq(s.product.name, 'Ice Cream Cone')))
    .limit(1);
  if (!productRow) {
    await db.insert(s.product).values({
      id: newId(),
      operatorId,
      branchId,
      categoryId: catId,
      name: 'Ice Cream Cone',
      priceSatang: b(60),
    });
  }

  // A first till station for the branch.
  const [stationRow] = await db
    .select({ id: s.station.id })
    .from(s.station)
    .where(and(eq(s.station.branchId, branchId), eq(s.station.name, 'Reception Till 1')))
    .limit(1);
  if (!stationRow) {
    await db
      .insert(s.station)
      .values({ id: newId(), operatorId, branchId, name: 'Reception Till 1', kind: 'till' });
  }

  console.log('Seed complete: operator OTO, branch HKT Central, roles, accounts, members, catalog.');
}

/**
 * Run directly. One command is correct on every deployment, because the
 * deployment says which it is:
 *
 *   SEED_PROFILE=staging     the demo tenant as well, so there is something
 *                            to sign in as and play with
 *   SEED_PROFILE=production  the platform's own rows only — system roles and
 *                            their permissions. A real branch's data arrives
 *                            by restore (S2-22), never from a fixture file.
 *
 * `--platform-only` forces the second regardless, and `--demo` the first, for
 * the times a person wants one without changing the environment.
 */
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('seed/index.ts');
if (isMain) {
  const forcedPlatform = process.argv.includes('--platform-only');
  const forcedDemo = process.argv.includes('--demo');
  const profile = process.env.SEED_PROFILE ?? 'staging';
  const platformOnly = forcedPlatform || (!forcedDemo && profile === 'production');
  console.log(
    platformOnly
      ? `Platform sync only (SEED_PROFILE=${profile}): system roles and permissions.`
      : `Full seed (SEED_PROFILE=${profile}): platform rows plus the demo tenant.`,
  );
  (platformOnly ? platformSync() : seed())
    .then(() => closeDb())
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
      return closeDb();
    });
}
