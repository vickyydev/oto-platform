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
import { createHash } from 'node:crypto';
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

/**
 * JSON with every object's keys in sorted order.
 *
 * A booth's `bundle_hash` is what the box compares to decide whether it is
 * already running a version, so it must not change because somebody wrote two
 * fields in a different order. The publish path (S2-07b) owns the canonical
 * form for versions a person creates; this is the same rule, applied to the
 * one version this file writes.
 */
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const src = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(src).sort().map((k) => [k, src[k]]));
  });

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

  // HKT Central opens 10:00-20:00 every day, which is what the park's own SOP
  // says ("Daily: 10:00 AM - 8:00 PM", order counter closes 19:30) and what
  // Radar has been measuring the live tills against for months. This was
  // seeded at 21:00 until 2026-09-21; the hour mattered because the watchdog
  // only raises when a box goes quiet DURING opening hours, so an hour of
  // padding is an hour of expecting every box to be alive after the park is
  // dark — a nightly false alarm, and false alarms are how people learn to
  // ignore the real ones. Work that happens after the doors close (the cash
  // count, an end-of-day print, a late party) is covered by
  // `businessDayStart`, not by pretending the park is still open.
  const openingHours = Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [
      day,
      { open: '10:00', close: '20:00' },
    ]),
  );
  const [branchRow] = await db
    .insert(s.branch)
    .values({
      id: newId(),
      operatorId,
      name: 'HKT Central',
      code: 'hkt-central',
      timezone: 'Asia/Bangkok',
      country: 'TH',
      openingHours,
    })
    .onConflictDoUpdate({
      target: [s.branch.operatorId, s.branch.code],
      set: { name: 'HKT Central', timezone: 'Asia/Bangkok', country: 'TH' },
    })
    .returning({ id: s.branch.id });
  const branchId = branchRow!.id;

  // Opening hours are edited from the Branches panel, so a sync must not push
  // them back — but a branch seeded before the column existed still has none,
  // and the watchdog reads "not set" as "do not raise". Backfill the null, and
  // leave any answer a person has given alone.
  await db
    .update(s.branch)
    .set({ openingHours })
    .where(and(eq(s.branch.id, branchId), isNull(s.branch.openingHours)));

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
  const receptionAccountId = await mkAccount(empSom, '+66900000002', 'reception1234', [
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

  // --- The fleet (S2-04, S2-05) ----------------------------------------------
  //
  // Two virtual boxes, the stations that sit on them, and the park's real
  // devices as simulations. A virtual box runs inside the api under
  // PROCESS_ROLES=edge, which is what lets pairing, config bundles, commands
  // and heartbeats all be exercised on Render months before anybody carries a
  // Raspberry Pi to Phuket.
  //
  // The SECOND box exists because half of S2-05 cannot be demonstrated with
  // one: the same phone typed at two counters while both are offline, merging
  // at sync with one member and an anomaly naming both events, needs two
  // journals that cannot see each other.

  // Found by (branch, slot) and then left entirely alone. Everything else a
  // box owns — its secret, its epoch, its last heartbeat — is runtime state,
  // and a sync that reset any of it would take a working box offline.
  const mkBox = async (name: string, slot: string) => {
    const [found] = await db
      .select({ id: s.box.id })
      .from(s.box)
      .where(and(eq(s.box.branchId, branchId), eq(s.box.slot, slot)))
      .limit(1);
    if (found) return found.id;
    const id = newId();
    await db.insert(s.box).values({
      id,
      operatorId,
      branchId,
      name,
      slot,
      role: 'virtual',
      // The agent registers into this row when the edge process starts; until
      // it has, the box genuinely is unclaimed and Health should say so.
      status: 'unclaimed',
    });
    return id;
  };

  const boxId = await mkBox('Virtual box 1', 'virtual-1');
  const box2Id = await mkBox('Virtual box 2', 'virtual-2');

  // The park's real devices (docs/architecture/DEVICE_INVENTORY.md §2) with
  // their real models, addresses, protocols and terminal identifiers — but on
  // the `simulated` transport, so the adapters are written against the truth
  // and only the physical link changes on site.
  const mkDevice = async (d: {
    kind: (typeof s.DEVICE_KINDS)[number];
    label: string;
    model: string;
    protocol: string;
    address?: string;
    serialNumber?: string;
    terminalId?: string;
    merchantId?: string;
    /** Which box reported it. Defaults to virtual box 1. */
    box?: string;
  }) => {
    const { box: onBox = boxId, ...fields } = d;
    const [found] = await db
      .select({ id: s.device.id })
      .from(s.device)
      .where(and(eq(s.device.boxId, onBox), eq(s.device.label, d.label)))
      .limit(1);
    if (found) return found.id;
    const id = newId();
    await db.insert(s.device).values({
      id,
      operatorId,
      branchId,
      boxId: onBox,
      transport: 'simulated',
      reachability: 'reachable',
      paperStatus: 'ok',
      ...fields,
    });
    return id;
  };

  const devReceipt = await mkDevice({
    kind: 'receipt_printer',
    label: 'Receipt Printer 1',
    model: 'Welltech G4 (Xprinter XP-C260)',
    protocol: 'escpos',
    address: '192.168.88.202:9100',
  });
  const devKitchen = await mkDevice({
    kind: 'kitchen_printer',
    label: 'Kitchen Printer',
    model: 'Xprinter XP-80',
    protocol: 'escpos',
    address: '192.168.88.206:9100',
  });
  const devBooth = await mkDevice({
    kind: 'receipt_printer',
    label: 'Receipt Printer 2',
    model: 'Xprinter XP-80',
    protocol: 'escpos',
    address: '192.168.88.207:9100',
  });
  const devKidsBand = await mkDevice({
    kind: 'band_printer',
    label: 'Band Printer (kids)',
    model: '4B-2082A',
    protocol: 'tspl2',
    address: '192.168.88.204:9100',
  });
  const devAdultBand = await mkDevice({
    kind: 'band_printer',
    label: 'Band Printer (adults)',
    model: '4B-2082A',
    protocol: 'tspl2',
    address: '192.168.88.210:9100',
  });
  const devScanner = await mkDevice({
    kind: 'scanner',
    label: 'Scanner 1',
    model: 'Zebra DS2278 (CR2278-PC cradle)',
    protocol: 'hid',
  });
  const devCard = await mkDevice({
    kind: 'terminal',
    label: 'EDC 1',
    model: 'NEXGO N5',
    protocol: 'ghl_linkpos',
    terminalId: '65703235',
    merchantId: '4648434010',
  });
  const devQr = await mkDevice({
    kind: 'terminal',
    label: 'EDC 3',
    model: 'PAX A920Pro',
    protocol: 'digio_tlv',
    serialNumber: '1854355548',
  });

  /**
   * Stations are demo rows: created once, then left to whoever configures them.
   * The one exception is a backfill of the two fields a station cannot work
   * without and that a Sprint 1 row has no answer for — its box and its code
   * prefix — which is the same thing the expand migration would do and is
   * still not an overwrite of anybody's choice.
   */
  const mkStation = async (st: {
    name: string;
    kind: (typeof s.STATION_KINDS)[number];
    codePrefix: string;
    capabilities: (typeof s.STATION_CAPABILITIES)[number][];
    accessScope: (typeof s.STATION_ACCESS_SCOPES)[number];
    /** The box that drives it. Defaults to virtual box 1. */
    box?: string;
  }) => {
    const { box: onBox = boxId, ...fields } = st;
    const [found] = await db
      .select({ id: s.station.id, boxId: s.station.boxId, codePrefix: s.station.codePrefix })
      .from(s.station)
      .where(and(eq(s.station.branchId, branchId), eq(s.station.name, st.name)))
      .limit(1);
    if (found) {
      if (!found.boxId || !found.codePrefix) {
        await db
          .update(s.station)
          .set({ boxId: found.boxId ?? onBox, codePrefix: found.codePrefix ?? st.codePrefix })
          .where(eq(s.station.id, found.id));
      }
      return found.id;
    }
    const id = newId();
    await db.insert(s.station).values({ id, operatorId, branchId, boxId: onBox, ...fields });
    return id;
  };

  const tillId = await mkStation({
    name: 'Reception Till 1',
    kind: 'till',
    codePrefix: 'T1',
    capabilities: ['tickets', 'fnb'],
    accessScope: 'all_staff',
  });
  /**
   * The booth is the seed's `selected_staff` station, and it is the one the
   * visibility rule is proved against: reception signing in sees Reception
   * Till 1 and does not see this at all. It is also the honest setting for a
   * booth — the wheel is run by whoever is looking after it, not by anybody
   * who happens to be on shift.
   */
  const boothId = await mkStation({
    name: 'Booth 1',
    kind: 'booth',
    codePrefix: 'B1',
    // Capabilities describe what a TILL sells; a booth's behaviour comes from
    // its kind, so the list stays empty.
    capabilities: [],
    accessScope: 'selected_staff',
  });

  const assign = async (stationId: string, role: (typeof s.STATION_DEVICE_ROLES)[number], deviceId: string) => {
    await db
      .insert(s.stationDevice)
      .values({ id: newId(), stationId, role, deviceId })
      .onConflictDoNothing({ target: [s.stationDevice.stationId, s.stationDevice.role] });
  };
  await assign(tillId, 'receipt', devReceipt);
  await assign(tillId, 'kitchen', devKitchen);
  await assign(tillId, 'kids_band', devKidsBand);
  await assign(tillId, 'adult_band', devAdultBand);
  await assign(tillId, 'scanner', devScanner);
  await assign(tillId, 'card_terminal', devCard);
  await assign(tillId, 'qr_terminal', devQr);
  await assign(boothId, 'receipt', devBooth);

  /**
   * Counter 2, on the second box (S2-05 seed line).
   *
   * Read "till, F&B capability" as a till that also sells food rather than one
   * that sells nothing else: the two-box scenario the ticket asks for begins
   * by creating a member at this counter, which is the ticket flow's identify
   * step, so removing `tickets` would make the demo it exists for impossible.
   *
   * It gets its own receipt printer because a device belongs to the box it is
   * plugged into and nowhere else — a station on box 2 cannot be assigned box
   * 1's printer, and the wizard will not offer it.
   */
  const devReceipt2 = await mkDevice({
    kind: 'receipt_printer',
    label: 'Receipt Printer 3',
    model: 'Xprinter XP-80',
    protocol: 'escpos',
    address: '192.168.88.208:9100',
    box: box2Id,
  });
  const counter2Id = await mkStation({
    name: 'Counter 2',
    kind: 'till',
    codePrefix: 'T2',
    capabilities: ['tickets', 'fnb'],
    accessScope: 'all_staff',
    box: box2Id,
  });
  await assign(counter2Id, 'receipt', devReceipt2);
  /**
   * The bar route (S2-06).
   *
   * `192.168.88.208` is the park's **Bar / F&B** printer — DEVICE_INVENTORY §2
   * row 7 — and it is the unit seeded above as Counter 2's receipt printer.
   * One 80 mm Xprinter at the food counter does both jobs, which is what the
   * park does today, and `ROLE_ACCEPTS.bar` in `services/fleet.ts` allows a
   * plain receipt printer to take the bar role for exactly that reason.
   *
   * Without this row nothing in the seeded fleet carries the `bar` role, and
   * the bar ticket — one of the nine printouts `@oto/print` renders — would
   * have no device to route to on any demo station.
   */
  await assign(counter2Id, 'bar', devReceipt2);

  // --- Print templates (S2-06) ------------------------------------------------
  //
  // The six editable printout types, with the prototype's own values
  // (`imports/oto-pos/artifacts/oto-till/src/store/catalogStore.ts:729-784`).
  // `@oto/print` holds the same list for its fixtures; this is the copy that
  // reaches a database, so that the Print Templates panel opens on something
  // and the renderer has a template to apply.
  //
  // Created once and then left alone, like every other demo row: a footer
  // edited on staging survives a re-seed. A branch with no rows at all is
  // still valid and prints every applicable field — that is what `printFieldOn`
  // does with no template — so this is a convenience, not a prerequisite.
  //
  // Two values in here look like mistakes and are not: the adult band has
  // `holderName: false`, and it has no allergy field to set.
  type TemplateSeed = Pick<
    typeof s.printTemplate.$inferInsert,
    'type' | 'name' | 'showLogo' | 'headerText' | 'footerText' | 'fields'
  >;
  const mkTemplate = async (t: TemplateSeed) => {
    const [found] = await db
      .select({ id: s.printTemplate.id })
      .from(s.printTemplate)
      .where(and(eq(s.printTemplate.branchId, branchId), eq(s.printTemplate.type, t.type)))
      .limit(1);
    if (found) return found.id;
    const id = newId();
    await db.insert(s.printTemplate).values({ id, operatorId, branchId, ...t });
    return id;
  };

  await mkTemplate({
    type: 'receipt',
    name: 'Standard receipt',
    showLogo: true,
    headerText: 'Oto Play Park',
    footerText: 'Thank you for visiting! · Tax ID 0105500000000',
    fields: { itemizedLines: true, taxServiceBreakdown: true, voucherInfo: true },
  });
  await mkTemplate({
    type: 'kids_wristband',
    name: 'Kids wristband',
    showLogo: false,
    fields: {
      holderName: true,
      durationTime: true,
      qr: true,
      allergyLine: true,
      startEndTime: true,
      partyName: true,
      dietaryRequirement: true,
      supervisionBadge: true,
      assignedNannyName: true,
    },
  });
  await mkTemplate({
    type: 'adult_wristband',
    name: 'Adult wristband',
    showLogo: false,
    fields: {
      holderName: false,
      durationTime: true,
      qr: true,
      startEndTime: true,
      partyName: true,
      dietaryRequirement: true,
      supervisionBadge: true,
      assignedNannyName: true,
    },
  });
  await mkTemplate({
    type: 'kitchen_ticket',
    name: 'Kitchen ticket',
    showLogo: false,
    fields: {
      itemizedLines: true,
      allergyLine: true,
      orderNotes: true,
      orderRefTime: true,
      holderName: true,
    },
  });
  await mkTemplate({
    type: 'bar_ticket',
    name: 'Bar ticket',
    showLogo: false,
    fields: {
      itemizedLines: true,
      allergyLine: true,
      orderNotes: true,
      orderRefTime: true,
      holderName: true,
    },
  });
  await mkTemplate({
    type: 'credit_voucher',
    name: 'Credit voucher',
    showLogo: true,
    headerText: 'Oto Play Park',
    footerText: 'Scan QR or wristband at the F&B or merch counter to spend.',
    fields: { creditVoucherBalance: true, creditVoucherQr: true },
  });

  // Only the administrator may pick Booth 1. Reception's picker must not show
  // it at all — that is the rule this row exists to exercise.
  await db
    .insert(s.stationStaff)
    .values({ id: newId(), stationId: boothId, accountId: adminAccountId, addedBy: adminAccountId })
    .onConflictDoNothing({ target: [s.stationStaff.stationId, s.stationStaff.accountId] });

  // --- The Lucky Wheel booth (S2-07a) -----------------------------------------
  //
  // A fixture wheel, so the game is playable before the admin panel (S2-07b)
  // exists: one layout, six voucher definitions, six prizes, the booth's own
  // settings, and version 1 of the bundle the box runs.
  //
  // The prizes and their odds are the ones the live booth is running today
  // (`imports/oto-wheel-fortune/artifacts/spin-win/src/config.ts`): 23.5 / 27.5
  // / 17.5 / 14.5 / 14.5 / 2.5 per cent, which is the owner's launch list with
  // the 3 % "Mystery Box — not available yet" spread across the rest. In basis
  // points those are 2350 / 2750 / 1750 / 1450 / 1450 / 250 and they add to
  // exactly 10000, which is the whole reason the column is an integer.
  //
  // Demo rows, so: created once and then left alone, like the members and the
  // print templates. A weight changed from the Console on staging survives a
  // re-sync — the prize editor is how weights change, not this file.

  const [existingLayout] = await db
    .select()
    .from(s.boothLayout)
    .where(and(eq(s.boothLayout.operatorId, operatorId), eq(s.boothLayout.name, 'Classic wheel')))
    .limit(1);
  /**
   * The design, and the SLOT its artwork arrives in.
   *
   * No licence-encumbered asset is copied out of `imports/`: the manifest
   * names what the wheel wants and where each one is expected to come from,
   * and the booth falls back to a generated face and silent audio for anything
   * nobody has uploaded. The palette is the live wheel's own six brand
   * colours. Thai on the television renders in Noto Sans Thai, because the
   * brand fonts have no Thai glyphs (`docs/features/booth.md`).
   */
  const layoutValues = {
    description: "The live booth's six-slice wheel, in the park's brand colours.",
    design: {
      palette: ['#FFE72E', '#FF7BC5', '#FF8A3D', '#55B9FF', '#A6E22C', '#CD8CFF'],
      defaultTextColor: '#111111',
      labelMaxLines: 2,
    },
    assetManifest: {
      face: { name: 'wheel-face', source: 'slot', fallback: 'generated' },
      tick: { name: 'wheel-tick', source: 'slot', fallback: 'silent' },
      win: { name: 'wheel-win', source: 'slot', fallback: 'silent' },
      thaiFont: { name: 'Noto Sans Thai', source: 'bundled' },
    },
  };
  const layoutId = existingLayout?.id ?? newId();
  if (!existingLayout) {
    await db
      .insert(s.boothLayout)
      .values({ id: layoutId, operatorId, name: 'Classic wheel', ...layoutValues });
  }
  const layout = existingLayout ?? { id: layoutId, name: 'Classic wheel', version: 1, ...layoutValues };

  /**
   * What each prize turns into.
   *
   * `cost_satang` is the face value for the money vouchers, which is what the
   * park actually gives up, and **zero for the activity prizes** — nobody has
   * costed a bracelet workshop, and zero here reads "not costed yet" rather
   * than "free". Putting a guess in would make a booth report that looks
   * authoritative and is not. The prize editor (S2-07b) is where the real
   * numbers are entered.
   *
   * The terms line is placeholder copy in the shape the printed voucher wants;
   * the park's own wording replaces it from the voucher-definition admin.
   */
  const fourteenDays = 14;
  const definitions = [
    {
      code: 'spin-voucher-100',
      nameEn: '100 THB Voucher',
      nameTh: 'บัตรกำนัล 100 บาท',
      kind: 'discount' as const,
      valueType: 'amount' as const,
      valueSatang: b(100),
      costSatang: b(100),
    },
    {
      code: 'spin-bracelet-workshop',
      nameEn: 'Free Bracelet Workshop',
      nameTh: 'เวิร์กช็อปทำสร้อยข้อมือฟรี',
      kind: 'free_item' as const,
      valueType: 'item' as const,
      costSatang: 0,
    },
    {
      code: 'spin-voucher-150',
      nameEn: '150 THB Voucher',
      nameTh: 'บัตรกำนัล 150 บาท',
      kind: 'discount' as const,
      valueType: 'amount' as const,
      valueSatang: b(150),
      costSatang: b(150),
    },
    {
      code: 'spin-voucher-200',
      nameEn: '200 THB Voucher',
      nameTh: 'บัตรกำนัล 200 บาท',
      kind: 'discount' as const,
      valueType: 'amount' as const,
      valueSatang: b(200),
      costSatang: b(200),
    },
    {
      code: 'spin-kids-pizza',
      nameEn: 'Kids Pizza',
      nameTh: 'พิซซ่าสำหรับเด็ก',
      kind: 'free_item' as const,
      valueType: 'item' as const,
      costSatang: 0,
    },
    {
      code: 'spin-kids-ticket-1-plus-1',
      nameEn: '1+1 Kids Ticket',
      nameTh: 'บัตรเด็ก 1 แถม 1',
      kind: 'free_ticket' as const,
      valueType: 'item' as const,
      costSatang: 0,
    },
  ];
  const definitionIds: Record<string, string> = {};
  for (const d of definitions) {
    const [found] = await db
      .select({ id: s.voucherDefinition.id })
      .from(s.voucherDefinition)
      .where(
        and(
          eq(s.voucherDefinition.operatorId, operatorId),
          eq(s.voucherDefinition.code, d.code),
        ),
      )
      .limit(1);
    const id = found?.id ?? newId();
    if (!found) {
      await db.insert(s.voucherDefinition).values({
        id,
        operatorId,
        expiryDays: fourteenDays,
        termsEn: 'Valid at OTO Play Park, HKT Central. One use only. No cash value.',
        termsTh: 'ใช้ได้ที่ OTO Play Park สาขา HKT Central ใช้ได้ครั้งเดียว ไม่สามารถแลกเป็นเงินสดได้',
        ...d,
      });
    }
    definitionIds[d.code] = id;
  }

  /**
   * The six slices, in the live wheel's own order — the money vouchers
   * alternate with the activity prizes so the 200 and the 100 are never side
   * by side.
   */
  const prizeSeeds = [
    {
      definition: 'spin-voucher-100',
      nameEn: '100 THB Voucher',
      nameTh: 'บัตรกำนัล 100 บาท',
      wheelLabel: '100 ฿',
      weightBp: 2350,
      sliceColor: '#FFE72E',
      costSatang: b(100),
    },
    {
      definition: 'spin-bracelet-workshop',
      nameEn: 'Free Bracelet Workshop',
      nameTh: 'เวิร์กช็อปทำสร้อยข้อมือฟรี',
      wheelLabel: 'Bracelet\nWorkshop',
      weightBp: 2750,
      sliceColor: '#FF7BC5',
      costSatang: 0,
    },
    {
      definition: 'spin-voucher-150',
      nameEn: '150 THB Voucher',
      nameTh: 'บัตรกำนัล 150 บาท',
      wheelLabel: '150 ฿',
      weightBp: 1750,
      sliceColor: '#FF8A3D',
      costSatang: b(150),
    },
    {
      definition: 'spin-voucher-200',
      nameEn: '200 THB Voucher',
      nameTh: 'บัตรกำนัล 200 บาท',
      wheelLabel: '200 ฿',
      weightBp: 1450,
      sliceColor: '#55B9FF',
      costSatang: b(200),
    },
    {
      definition: 'spin-kids-pizza',
      nameEn: 'Kids Pizza',
      nameTh: 'พิซซ่าสำหรับเด็ก',
      wheelLabel: 'Kids\nPizza',
      weightBp: 1450,
      sliceColor: '#A6E22C',
      costSatang: 0,
    },
    {
      definition: 'spin-kids-ticket-1-plus-1',
      nameEn: '1+1 Kids Ticket',
      nameTh: 'บัตรเด็ก 1 แถม 1',
      wheelLabel: '1+1 Kids\nTicket',
      weightBp: 250,
      sliceColor: '#CD8CFF',
      costSatang: 0,
    },
  ];
  for (const [i, p] of prizeSeeds.entries()) {
    const { definition, ...fields } = p;
    const [found] = await db
      .select({ id: s.boothPrize.id })
      .from(s.boothPrize)
      .where(and(eq(s.boothPrize.stationId, boothId), eq(s.boothPrize.nameEn, p.nameEn)))
      .limit(1);
    if (found) continue;
    await db.insert(s.boothPrize).values({
      id: newId(),
      operatorId,
      branchId,
      stationId: boothId,
      voucherDefinitionId: definitionIds[definition]!,
      textColor: '#111111',
      sortOrder: i,
      ...fields,
    });
  }

  // Booth settings. `Space` is a default, not an answer: which key the red
  // button sends has not been read off the real booth yet
  // (`docs/features/booth.md`). Eligibility is `none` because a mall visitor
  // has no wristband and the television asks for no phone number (D15).
  const [existingBoothSettings] = await db
    .select({ stationId: s.boothSettings.stationId })
    .from(s.boothSettings)
    .where(eq(s.boothSettings.stationId, boothId))
    .limit(1);
  if (!existingBoothSettings) {
    await db.insert(s.boothSettings).values({
      stationId: boothId,
      operatorId,
      branchId,
      layoutId: layout.id,
      buttonKey: 'Space',
      eligibility: 'none',
    });
  }

  /**
   * Version 1 of the published wheel.
   *
   * Read back from the rows rather than assembled from the arrays above, so
   * that a database seeded before this block existed — one whose prizes a
   * person has since edited — publishes what it actually has.
   */
  const [existingVersion] = await db
    .select({ id: s.boothConfigVersion.id })
    .from(s.boothConfigVersion)
    .where(
      and(eq(s.boothConfigVersion.stationId, boothId), eq(s.boothConfigVersion.version, 1)),
    )
    .limit(1);
  if (!existingVersion) {
    const prizeRows = await db
      .select()
      .from(s.boothPrize)
      .where(and(eq(s.boothPrize.stationId, boothId), isNull(s.boothPrize.archivedAt)))
      .orderBy(s.boothPrize.sortOrder);
    const bundle = {
      schemaVersion: 1,
      settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null },
      layout: {
        id: layout.id,
        name: layout.name,
        version: layout.version,
        design: layout.design,
        assetManifest: layout.assetManifest,
      },
      prizes: prizeRows.map((p) => ({
        id: p.id,
        nameEn: p.nameEn,
        nameTh: p.nameTh,
        wheelLabel: p.wheelLabel,
        weightBp: p.weightBp,
        active: p.active,
        dailyCap: p.dailyCap,
        expiryDays: p.expiryDays,
        costSatang: p.costSatang,
        sliceColor: p.sliceColor,
        textColor: p.textColor,
        sortOrder: p.sortOrder,
        voucherDefinitionId: p.voucherDefinitionId,
      })),
    };
    await db.insert(s.boothConfigVersion).values({
      id: newId(),
      operatorId,
      branchId,
      stationId: boothId,
      version: 1,
      layoutId: layout.id,
      bundle,
      bundleHash: createHash('sha256').update(stableJson(bundle)).digest('hex'),
      // Nobody published it — it came from this file, and the column says so.
      publishedByAccountId: null,
      note: 'Seeded launch wheel: the live booth\'s six prizes and their odds.',
    });
  }

  /**
   * Somebody to sign in at the booth, and a PIN to do it with.
   *
   * Reception rather than the administrator: the booth is worked by whoever is
   * looking after it, and this is also the account S2-07b's PIN management is
   * demonstrated on. `2468` is a local-dev value in the same class as the
   * seeded passwords — it is hashed with argon2id here, as every secret on
   * this platform is, and a staging deployment that wants a different one sets
   * it from the Console.
   */
  await db
    .insert(s.boothStaffAssignment)
    .values({
      id: newId(),
      stationId: boothId,
      accountId: receptionAccountId,
      addedBy: adminAccountId,
    })
    .onConflictDoNothing({
      target: [s.boothStaffAssignment.stationId, s.boothStaffAssignment.accountId],
    });
  const [existingPin] = await db
    .select({ id: s.credential.id })
    .from(s.credential)
    .where(and(eq(s.credential.accountId, receptionAccountId), eq(s.credential.kind, 'pin')))
    .limit(1);
  if (!existingPin) {
    await db.insert(s.credential).values({
      id: newId(),
      operatorId,
      accountId: receptionAccountId,
      kind: 'pin',
      secretHash: await hash('2468'),
      createdByAccountId: adminAccountId,
    });
  }

  console.log(
    'Seed complete: operator OTO, branch HKT Central, roles, accounts, members, catalog, two virtual boxes with three stations, the park\'s six printers, six print templates, and Booth 1 with six prizes at config version 1.',
  );
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
