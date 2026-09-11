/**
 * Seed (CLAUDE.md §4): one operator "OTO", branch "HKT Central"
 * (Asia/Bangkok), departments, system roles generated from
 * @oto/shared ROLE_BUNDLES, a platform admin + a reception account with known
 * dev passwords, six members with children (≥1 allergy), the prototype's four
 * ticket packages (values ported 1:1 from catalogStore.ts seeds, in satang),
 * one holiday range, and the 7% inclusive VAT tax config.
 *
 * Safe to re-run: exits as a no-op when the OTO operator already exists.
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
  type TaxConfigShape,
  type WWPrice,
} from '@oto/shared';
import { eq } from 'drizzle-orm';
import { closeDb, getDb } from '../index';
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

export async function seed(db: import('../index').Db = getDb()): Promise<void> {
  const existing = await db.select().from(s.operator).where(eq(s.operator.name, 'OTO'));
  if (existing.length > 0) {
    console.log('Seed: operator "OTO" already exists — nothing to do.');
    return;
  }

  const operatorId = newId();
  await db.insert(s.operator).values({ id: operatorId, name: 'OTO' });

  const branchId = newId();
  await db.insert(s.branch).values({
    id: branchId,
    operatorId,
    name: 'HKT Central',
    code: 'hkt-central',
    timezone: 'Asia/Bangkok',
    country: 'TH',
  });

  // Departments (CLAUDE.md §4).
  const deptIds: Record<string, string> = {};
  for (const name of ['reception', 'restaurant', 'floor', 'nanny']) {
    const id = newId();
    deptIds[name] = id;
    await db.insert(s.department).values({ id, operatorId, branchId, name });
  }

  // Tiers — prototype seedTiers (catalogStore.ts:792), operator-wide.
  for (const [i, t] of (
    [
      { code: 'tourist', name: 'Tourist', isDefault: true, requiresVerification: false },
      { code: 'expat', name: 'Expat', isDefault: false, requiresVerification: true },
      { code: 'thai', name: 'Thai', isDefault: false, requiresVerification: true },
    ] as const
  ).entries()) {
    await db.insert(s.tier).values({ id: newId(), operatorId, ...t, sortOrder: i });
  }

  // System roles generated from the shared permission bundles.
  const roleIds: Record<string, string> = {};
  for (const roleName of SYSTEM_ROLES) {
    const id = newId();
    roleIds[roleName] = id;
    await db.insert(s.role).values({
      id,
      operatorId: null, // system role
      name: roleName,
      description: `System role: ${roleName}`,
    });
    for (const permission of ROLE_BUNDLES[roleName]) {
      await db.insert(s.rolePermission).values({ id: newId(), roleId: id, permission });
    }
  }

  // Employees (prototype roster, mockApi.ts:430) + dev accounts.
  const emp = async (name: string, dept: string, phone: string) => {
    const id = newId();
    await db.insert(s.employee).values({
      id,
      operatorId,
      name,
      branchId,
      departmentId: deptIds[dept] ?? null,
      phone: normalizePhone(phone),
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
    roles: Array<{ role: string; scopeType: 'operator' | 'branch'; scopeId: string | null }>,
  ) => {
    const id = newId();
    await db.insert(s.account).values({
      id,
      operatorId,
      employeeId,
      phone: normalizePhone(phone)!,
      passwordHash: await hash(password),
      phoneVerifiedAt: new Date(),
      status: 'active',
    });
    for (const r of roles) {
      await db.insert(s.roleAssignment).values({
        id: newId(),
        accountId: id,
        roleId: roleIds[r.role]!,
        scopeType: r.scopeType,
        scopeId: r.scopeId,
      });
    }
    return id;
  };

  // Known local-dev passwords (documented in .env.example / SPRINT_1_REPORT).
  await mkAccount(empAnan, '+66900000001', 'admin1234', [
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
    const id = newId();
    await db.insert(s.member).values({
      id,
      operatorId,
      phone: normalizePhone(m.phone)!,
      nickname: m.nickname,
      tierCode: m.tier ?? 'tourist',
      createdVia: 'import',
    });
    if (m.tier && m.tier !== 'tourist' && m.evidence) {
      await db.insert(s.memberTierVerification).values({
        id: newId(),
        memberId: id,
        fromTier: 'tourist',
        toTier: m.tier,
        evidenceType: m.evidence,
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
    return id;
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
  for (const p of packages) {
    await db.insert(s.ticketPackage).values({ id: newId(), operatorId, branchId, ...p });
  }

  // One holiday range (future-dated so "today" stays weekday-priced).
  await db.insert(s.branchHoliday).values({
    id: newId(),
    branchId,
    name: 'Loy Krathong',
    startsOn: '2026-11-24',
    endsOn: '2026-11-25',
  });

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
  await db.insert(s.branchTaxConfig).values({ id: newId(), branchId, config: taxConfig });

  // A product category + product so the tax-override resolver has targets.
  const catId = newId();
  await db.insert(s.productCategory).values({
    id: catId,
    operatorId,
    name: 'F&B',
    taxableCategory: 'fnb',
  });
  await db.insert(s.product).values({
    id: newId(),
    operatorId,
    branchId,
    categoryId: catId,
    name: 'Ice Cream Cone',
    priceSatang: b(60),
  });

  // A first till station for the branch.
  await db.insert(s.station).values({ id: newId(), branchId, name: 'Reception Till 1', kind: 'till' });

  console.log('Seed complete: operator OTO, branch HKT Central, roles, accounts, members, catalog.');
}

// Run directly (pnpm db:seed).
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('seed/index.ts');
if (isMain) {
  seed()
    .then(() => closeDb())
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
      return closeDb();
    });
}
