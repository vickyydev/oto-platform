/**
 * Seed (CLAUDE.md §4): one operator "OTO", the park's two trading branches —
 * Oto Play Park, Central Floresta and Oto Play Park, Robinson Chalong (both
 * Asia/Bangkok) — departments, system roles generated from
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
import { createHash, randomInt } from 'node:crypto';
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
import { reconcileAppBranches } from '../schema/otoapp';
import { seedMenu } from './menu';
import { DEFAULT_TENDERS, syncDefaultTenders, upsertDefaultTenders } from './tenders';
import * as s from '../schema/index';

/**
 * A trading day of sales across every tender (S2-10a), re-exported so that
 * `@oto/db/seed` is the one door to every fixture. It is NOT part of `seed()`:
 * the seed builds a park and this fills its till, and a deploy that wants the
 * first without the second — which is every deploy that has real sales — runs
 * `pnpm --filter @oto/db seed:demo-day` or nothing at all.
 */
export { seedDemoDay, type DemoDayCounts } from './demo-day';

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
 * bundles, and the tender list a park cannot take money without. Separate
 * from the demo tenant below so a deploy can re-sync access against a real
 * database without seeding fixtures into it.
 *
 * Both halves converge the same way — the platform writes a starting point,
 * and a park that has since made its own decision keeps it. For roles that
 * means a permission added to a bundle reaches a database already seeded; for
 * tenders it means a park with NO list gets the three defaults and a park with
 * any list at all is left alone (`./tenders.ts`).
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

  // The till's method grid is hydrated from `pos.payment_method`, so a park
  // with no rows is a counter that cannot take money (staging, 2026-09-23).
  const converged = await syncDefaultTenders(db);
  if (converged.length > 0) {
    console.log(
      `Payment methods: wrote the ${DEFAULT_TENDERS.length} default tenders for ${converged.length} park(s) that had none.`,
    );
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

  // Both parks open 10:00-20:00 every day, which is what the park's own SOP
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

  /**
   * The park's two trading sites.
   *
   * Names and addresses are the park's own rows, from the committed sample cut
   * of its export (`apps/oto-app/script/sample/data.generated.ts`, `BRANCHES`).
   * The export's Central Floresta name carries a trailing space; it is trimmed
   * here rather than reproduced.
   *
   * "HKT Central" was the prototype's invention — HKT is Phuket's airport code,
   * not a mall — standing in for Central Floresta. It is RENAMED below rather
   * than replaced by a third row, because its id already carries every station,
   * box, device, package price, holiday, print template and the T1/T2 receipt
   * series; a new row would strand all of it.
   *
   * Its `code` deliberately stays `hkt-central`. The slug is not decoration: the
   * edge agent finds the branch it is running at by it (`boxSettings()` in
   * `apps/api/src/services/box.ts` defaults `agentBranchCode` to the literal
   * `'hkt-central'`, and `registerVirtualBox` matches `branch.code` against it),
   * and `/public/branches/:code/catalog` serves the till its catalogue under it.
   * Changing the slug without also setting `BOX_AGENT_BRANCH_CODE` on every
   * deployment would leave the virtual boxes unable to find their branch. The
   * name is what people read; the code is an identifier, and this one is already
   * load-bearing.
   *
   * Head Office — the third row in the export — is deliberately not here. It is
   * an office: it sells no tickets, has no till and no gate, and a `branch` on
   * this platform is a place that trades. The people who work there are staff
   * records, not a trading site.
   */
  const CENTRAL_CODE = 'hkt-central';
  const CHALONG_CODE = 'robinson-chalong';
  /** What the prototype seeded, and the only name the rename below will touch. */
  const STANDIN_NAME = 'HKT Central';

  const branchSeeds = [
    {
      code: CENTRAL_CODE,
      name: 'Oto Play Park, Central Floresta',
      address: '199 Moo 4, Vichitsongkram Road, Wichit, Muang, Phuket 83000, Thailand',
    },
    {
      code: CHALONG_CODE,
      name: 'Oto Play Park, Robinson Chalong',
      address:
        '10/53 Moo 1, Chaofah East Road, Tambon Chalong, Mueang Phuket District, Phuket 83130, Thailand',
    },
  ] as const;

  const branchIds: Record<string, string> = {};
  for (const br of branchSeeds) {
    // A branch someone has since renamed, re-addressed or re-hour-ed stays
    // theirs: on conflict this does nothing at all. Everything the seed still
    // owes an existing row is a backfill of a null, below.
    const [created] = await db
      .insert(s.branch)
      .values({
        id: newId(),
        operatorId,
        name: br.name,
        code: br.code,
        timezone: 'Asia/Bangkok',
        country: 'TH',
        address: br.address,
        openingHours,
      })
      .onConflictDoNothing({ target: [s.branch.operatorId, s.branch.code] })
      .returning({ id: s.branch.id });
    const [row] = created
      ? [created]
      : await db
          .select({ id: s.branch.id })
          .from(s.branch)
          .where(and(eq(s.branch.operatorId, operatorId), eq(s.branch.code, br.code)))
          .limit(1);
    branchIds[br.code] = row!.id;
  }
  const branchId = branchIds[CENTRAL_CODE]!;
  const chalongId = branchIds[CHALONG_CODE]!;

  /**
   * The one-time rename of the stand-in.
   *
   * Guarded on BOTH the seeded code and the seeded name, so it fires exactly
   * once: a database already renamed, or one where somebody chose their own
   * name for the branch, matches no row and is left alone. A re-run after the
   * first therefore changes nothing.
   *
   * No migration accompanies this. A migration changes the shape of the schema;
   * nothing about this row's shape changes, only the text in one column of one
   * seeded row.
   */
  await db
    .update(s.branch)
    .set({ name: branchSeeds[0].name })
    .where(
      and(
        eq(s.branch.operatorId, operatorId),
        eq(s.branch.code, CENTRAL_CODE),
        eq(s.branch.name, STANDIN_NAME),
      ),
    );

  // Backfills only. Opening hours, address and country are all edited from the
  // Branches panel, so a sync must never push them back — but a branch seeded
  // before a column existed still has none, and for opening hours the watchdog
  // reads "not set" as "do not raise". Fill the nulls; leave every answer a
  // person has given alone.
  for (const br of branchSeeds) {
    const id = branchIds[br.code]!;
    await db
      .update(s.branch)
      .set({ openingHours })
      .where(and(eq(s.branch.id, id), isNull(s.branch.openingHours)));
    await db
      .update(s.branch)
      .set({ address: br.address })
      .where(and(eq(s.branch.id, id), isNull(s.branch.address)));
    await db
      .update(s.branch)
      .set({ country: 'TH' })
      .where(and(eq(s.branch.id, id), isNull(s.branch.country)));
  }

  /**
   * The OTO App's own branch list, joined to these two (SCRUM-268).
   *
   * The app's rows are not seeded here and never will be: they come from the
   * park's export through that app's own importer
   * (`apps/oto-app/script/sample/main.ts`, which find-or-creates each of the
   * three branches by its exact exported name — trailing space and all). So
   * this is a reconciliation, not a seed: it matches what is there by trimmed,
   * case-folded name, writes `core_branch_id`, and from then on the two are
   * joined by id.
   *
   * It runs here rather than being left to an administrator because a database
   * that has just been seeded and then has the app's baseline imported into it
   * — which is the order every local and staging build uses — would otherwise
   * carry two unjoined lists until somebody noticed. Idempotent, so running the
   * sync a second time changes nothing, and silent when the app is not
   * installed on this database at all, which is every platform-only deployment
   * and almost every test.
   *
   * Only OTO's branches. `seedSecondOperator` below never reaches this: the
   * second operator has no anchor in the app and its parks are not the app's
   * parks, and putting one tenant's branch inside another's would be a leak
   * dressed up as a convenience.
   */
  const appBranches = await reconcileAppBranches(db, { operatorId });
  if (appBranches.installed && appBranches.writes > 0) {
    console.log(
      `OTO App branches: ${appBranches.matchedByName.length} matched by name, ${appBranches.created.length} created, ${appBranches.appOnly.length} app-only (Head Office and its like).`,
    );
  }

  // Departments (CLAUDE.md §4) — per branch, because a department is where a
  // person is rostered and both parks roster their own reception and kitchen.
  const departmentsFor = async (forBranch: string): Promise<Record<string, string>> => {
    const ids: Record<string, string> = {};
    for (const name of ['reception', 'restaurant', 'floor', 'nanny']) {
      const [found] = await db
        .select({ id: s.department.id })
        .from(s.department)
        .where(
          and(
            eq(s.department.operatorId, operatorId),
            eq(s.department.branchId, forBranch),
            eq(s.department.name, name),
          ),
        )
        .limit(1);
      const id = found?.id ?? newId();
      if (!found)
        await db.insert(s.department).values({ id, operatorId, branchId: forBranch, name });
      ids[name] = id;
    }
    return ids;
  };
  const deptIds = await departmentsFor(branchId);
  const chalongDeptIds = await departmentsFor(chalongId);

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

  /**
   * Payment methods — the prototype's `seedPaymentMethods`
   * (catalogStore.ts:786-790), operator-wide because the store says so in as
   * many words: "paymentMethods (same physical tenders everywhere)"
   * (catalogStore.ts:71).
   *
   * The three rows and both ways of writing them live in `./tenders.ts`, which
   * `platformSync` reads as well — so the tenders a deploy converges and the
   * tenders this fixture writes can never be two different lists. This call is
   * the upsert: a label corrected in that file reaches a database that already
   * has the row, while `enabled` is left as the park set it.
   *
   * On a fresh database the sync at the top of `seed()` wrote nothing here —
   * the operator did not exist yet — so this is what gives the demo tenant its
   * list. On every run after, the sync has already seen a park with rows and
   * left it alone, and this keeps the labels current.
   */
  await upsertDefaultTenders(db, operatorId);

  // Employees (prototype roster, mockApi.ts:430) + dev accounts.
  const emp = async (
    name: string,
    dept: string,
    phone: string,
    /** Which park they work at. Defaults to Central Floresta. */
    at: { branch: string; depts: Record<string, string> } = {
      branch: branchId,
      depts: deptIds,
    },
  ) => {
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
      branchId: at.branch,
      departmentId: at.depts[dept] ?? null,
      phone: e164,
    });
    return id;
  };
  const empAnan = await emp('Khun Anan (Owner)', 'reception', '+66900000001');
  const empSom = await emp('Som (Reception)', 'reception', '+66900000002');
  await emp('Nok (Reception)', 'reception', '+66900000003');
  const empLek = await emp('Khun Lek (Manager)', 'reception', '+66900000004');
  const empDao = await emp('Khun Dao (Manager)', 'reception', '+66900000005', {
    branch: chalongId,
    depts: chalongDeptIds,
  });

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

  /**
   * A branch manager at each park.
   *
   * One grant each, `branch_manager` scoped to their own branch and nothing
   * wider — no operator-scoped assignment, which is what an operator admin has.
   * That is the whole point of the pair: Khun Lek manages Central Floresta's
   * equipment, prices, holidays and staff and reads its sales and audit; Khun
   * Dao does the same at Robinson Chalong; neither can see the other's, and
   * neither can grant past their own branch. With one branch seeded, a
   * branch-scoped grant and an operator-wide one are indistinguishable at
   * runtime, so nothing was holding the scope resolver honest. Now something is.
   */
  await mkAccount(empLek, '+66900000004', 'manager1234', [
    { role: 'branch_manager', scopeType: 'branch', scopeId: branchId },
  ]);
  await mkAccount(empDao, '+66900000005', 'manager1234', [
    { role: 'branch_manager', scopeType: 'branch', scopeId: chalongId },
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
  /**
   * Priced at BOTH parks. A ticket package is branch-owned — the schema keys it
   * on `branch_id` and the unique key is (branch, name) — because the same
   * product can carry a different price at a different mall. Seeding it once
   * would leave Robinson Chalong a branch whose till shows an empty catalogue.
   *
   * Same figures at both, because the export says nothing about Chalong pricing
   * differently; when the park sets its own, it sets them from the Catalogue
   * panel and the upsert below leaves the name alone but would push a price
   * back, so a real divergence belongs in this array, per branch, not in a
   * hand-edit on staging.
   */
  for (const forBranch of [branchId, chalongId]) {
    for (const { name, ...rest } of packages) {
      // The catalogue is reference data: a price corrected here reaches a
      // database that already has the package.
      await db
        .insert(s.ticketPackage)
        .values({ id: newId(), operatorId, branchId: forBranch, name, ...rest })
        .onConflictDoUpdate({
          target: [s.ticketPackage.branchId, s.ticketPackage.name],
          set: rest,
        });
    }
  }

  // One holiday range (future-dated so "today" stays weekday-priced). Loy
  // Krathong is a national holiday, so it closes over both parks — but it is
  // stored per branch, because a branch may trade through a day its neighbour
  // does not.
  const holiday = { name: 'Loy Krathong', startsOn: '2026-11-24', endsOn: '2026-11-25' };
  for (const forBranch of [branchId, chalongId]) {
    const [holidayRow] = await db
      .select({ id: s.branchHoliday.id })
      .from(s.branchHoliday)
      .where(
        and(eq(s.branchHoliday.branchId, forBranch), eq(s.branchHoliday.name, holiday.name)),
      )
      .limit(1);
    if (!holidayRow) {
      await db.insert(s.branchHoliday).values({ id: newId(), branchId: forBranch, ...holiday });
    }
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
  // Per branch: VAT is national, but the rule row is branch-owned and a branch
  // without one cannot total a sale.
  for (const forBranch of [branchId, chalongId]) {
    await db
      .insert(s.branchTaxConfig)
      .values({ id: newId(), branchId: forBranch, config: taxConfig })
      .onConflictDoUpdate({ target: s.branchTaxConfig.branchId, set: { config: taxConfig } });
  }

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
      code: 'FB',
      name: 'F&B',
      taxableCategory: 'fnb',
    });
  }
  // A category the spreadsheet can address: the sheet matches categories by
  // code, and this row predates codes (seen on staging — a brownie imported
  // 'under F&B' landed elsewhere). Filled once, never overwritten.
  await db
    .update(s.productCategory)
    .set({ code: 'FB' })
    .where(and(eq(s.productCategory.id, catId), isNull(s.productCategory.code)));
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
  // The menu the park actually runs (SCRUM-232): the prototype's twenty items
  // in their categories and sub-categories, the modifier library, the add-ons
  // and the launch discount codes — find-or-create on code, so a re-seed
  // changes nothing a manager has since edited. Written by the menu slice and
  // hooked here afterwards, because this file was another slice's that night.
  await seedMenu(db, { operatorId, branchId });

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
  const mkBox = async (name: string, slot: string, forBranch: string = branchId) => {
    const [found] = await db
      .select({ id: s.box.id })
      .from(s.box)
      .where(and(eq(s.box.branchId, forBranch), eq(s.box.slot, slot)))
      .limit(1);
    if (found) return found.id;
    const id = newId();
    await db.insert(s.box).values({
      id,
      operatorId,
      branchId: forBranch,
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
    /** Optional: the column is nullable, and an unsurveyed unit has no model. */
    model?: string;
    protocol: string;
    address?: string;
    serialNumber?: string;
    terminalId?: string;
    merchantId?: string;
    /** Which box reported it. Defaults to virtual box 1. */
    box?: string;
    /** The park it is plugged in at. Defaults to Central Floresta. */
    branch?: string;
  }) => {
    const { box: onBox = boxId, branch: onBranch = branchId, ...fields } = d;
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
      branchId: onBranch,
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
    /** The park it stands in. Defaults to Central Floresta. */
    branch?: string;
  }) => {
    const { box: onBox = boxId, branch: onBranch = branchId, ...fields } = st;
    const [found] = await db
      .select({ id: s.station.id, boxId: s.station.boxId, codePrefix: s.station.codePrefix })
      .from(s.station)
      .where(and(eq(s.station.branchId, onBranch), eq(s.station.name, st.name)))
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
    await db
      .insert(s.station)
      .values({ id, operatorId, branchId: onBranch, boxId: onBox, ...fields });
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

  // --- Robinson Chalong, as a place that can trade ----------------------------
  //
  // A branch is not a row; it is a counter that can take money. Chalong already
  // has its opening hours, its tax rule, its holiday and its four ticket
  // packages from the loops above. What it still needs is somewhere to ring a
  // sale: a box to run the edge, a printer on that box, and a till whose code
  // prefix can number a receipt.
  //
  // The prefix is `T3` rather than a second `T1`. `station_code_prefix_unique`
  // is keyed on (branch, prefix), so `T1` here would be legal — and wrong:
  // `allocateReceiptNumber` in `apps/api/src/services/sale.ts` uses the prefix
  // AS the series name, so two branches both numbering from `T1` would hand two
  // different visitors a receipt reading `T1-000001`. The prefixes have to be
  // distinct across the operator even though the database only asks for them to
  // be distinct within a branch.
  const chalongBoxId = await mkBox('Virtual box 3', 'virtual-3', chalongId);

  // No address, and no model. Nobody has surveyed Chalong's hardware — the
  // models, addresses and terminal identifiers seeded above are Central
  // Floresta's real units from DEVICE_INVENTORY §2, and there is no equivalent
  // list for this park. `simulated` transport with an empty address is the
  // honest shape: it prints in the simulator, and it claims nothing about a
  // machine on a wall in Chalong. `escpos` is set because the renderer needs a
  // dialect to speak; it is the one every 80 mm thermal unit here uses.
  const chalongPrinter = await mkDevice({
    kind: 'receipt_printer',
    label: 'Receipt Printer 1',
    protocol: 'escpos',
    box: chalongBoxId,
    branch: chalongId,
  });
  const chalongTillId = await mkStation({
    name: 'Reception Till 1',
    kind: 'till',
    codePrefix: 'T3',
    capabilities: ['tickets', 'fnb'],
    accessScope: 'all_staff',
    box: chalongBoxId,
    branch: chalongId,
  });
  await assign(chalongTillId, 'receipt', chalongPrinter);

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
  const mkTemplate = async (t: TemplateSeed, forBranch: string = branchId) => {
    const [found] = await db
      .select({ id: s.printTemplate.id })
      .from(s.printTemplate)
      .where(and(eq(s.printTemplate.branchId, forBranch), eq(s.printTemplate.type, t.type)))
      .limit(1);
    if (found) return found.id;
    const id = newId();
    await db.insert(s.printTemplate).values({ id, operatorId, branchId: forBranch, ...t });
    return id;
  };

  const templateSeeds: TemplateSeed[] = [
    {
      type: 'receipt',
      name: 'Standard receipt',
      showLogo: true,
      headerText: 'Oto Play Park',
      footerText: 'Thank you for visiting! · Tax ID 0105500000000',
      fields: { itemizedLines: true, taxServiceBreakdown: true, voucherInfo: true },
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
      type: 'credit_voucher',
      name: 'Credit voucher',
      showLogo: true,
      headerText: 'Oto Play Park',
      footerText: 'Scan QR or wristband at the F&B or merch counter to spend.',
      fields: { creditVoucherBalance: true, creditVoucherQr: true },
    },
  ];
  // Both parks. The header and footer are the operator's own wording and read
  // the same at either mall; a branch that wants its own edits them, and the
  // find-first above then leaves it alone.
  for (const forBranch of [branchId, chalongId]) {
    for (const t of templateSeeds) await mkTemplate(t, forBranch);
  }

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
        // The booth stands at Central Floresta, so that is the park its
        // vouchers name. Placeholder wording in the shape the printed voucher
        // wants; the park's own replaces it from the voucher-definition admin.
        termsEn:
          'Valid at Oto Play Park, Central Floresta. One use only. No cash value.',
        termsTh:
          'ใช้ได้ที่ Oto Play Park สาขา Central Floresta ใช้ได้ครั้งเดียว ไม่สามารถแลกเป็นเงินสดได้',
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
   * demonstrated on. A new seed receives a random five-digit PIN, stored
   * only as its hash. Set or generate a usable PIN from the Console.
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
      secretHash: await hash(String(randomInt(100_000)).padStart(5, '0')),
      createdByAccountId: adminAccountId,
    });
  }

  await seedSecondOperator(db, roleIds);

  console.log(
    'Seed complete: operator OTO; branches Oto Play Park, Central Floresta and Oto Play Park, Robinson Chalong, each with opening hours, tax, a holiday, four priced packages and six print templates; roles, accounts (including a branch manager scoped to each park), members; three virtual boxes and four stations (T1, T2, B1 at Floresta, T3 at Chalong); the park\'s printers; Booth 1 with six prizes at config version 1; and a second operator with one branch, one administrator, one box and one till.',
  );
}

/** The second operator's own handles, so a test names them rather than re-deriving them. */
export const SECOND_OPERATOR_NAME = 'Second Operator';
export const SECOND_OPERATOR_BRANCH_CODE = 'second-operator-1';
export const SECOND_OPERATOR_ADMIN_PHONE = '+66900000009';
export const SECOND_OPERATOR_ADMIN_PASSWORD = 'second1234';

/**
 * A second operator, present by default (SCRUM-289).
 *
 * Row-scoped tenancy is the platform's oldest decision and, until this, the
 * least exercised one: with a single operator in the fixture, a query that
 * filtered by operator and a query that filtered by nothing returned the same
 * rows, so the two were indistinguishable in every test in the suite. Four
 * cross-operator holes reached staging that way (SCRUM-280, SCRUM-281) — not
 * because anybody skipped a test, but because the test that would have failed
 * could not have been written against a database with one tenant in it.
 *
 * It is seeded by default rather than behind a flag, and for the same reason
 * the second BRANCH is: a fixture narrower than the world is how the gap
 * opened, and a fixture that is only wide in tests is the same gap wearing a
 * different hat. Every route test now runs with a foreign row present whether
 * its author thought about tenancy or not.
 *
 * Deliberately NOT the park. The name says what it is, so nobody reading a
 * picker on staging mistakes it for a real business or a third OTO site, and
 * so the rows it owns are obvious the moment they appear somewhere they should
 * not. It gets what a tenant needs to be a tenant and nothing more: one
 * branch, one administrator, one box and one till.
 *
 * Its administrator's phone is distinct from every OTO phone on purpose.
 * `findAccountByPhone` in `apps/api/src/services/auth.ts` searches on the phone
 * alone when the caller has not said which operator it means, and takes the
 * first row: the same number in two operators would make sign-in answer with
 * whichever row Postgres happened to return.
 *
 * Its grant is `operator_admin` scoped to itself — never `platform_admin`.
 * A platform-wide grant would see across tenants, which would make this
 * account useless as the foreign principal it exists to be.
 */
async function seedSecondOperator(
  db: Db,
  roleIds: Record<SystemRole, string>,
): Promise<void> {
  const [existing] = await db
    .select({ id: s.operator.id })
    .from(s.operator)
    .where(eq(s.operator.name, SECOND_OPERATOR_NAME))
    .limit(1);
  const operatorId = existing?.id ?? newId();
  if (!existing) await db.insert(s.operator).values({ id: operatorId, name: SECOND_OPERATOR_NAME });

  const [createdBranch] = await db
    .insert(s.branch)
    .values({
      id: newId(),
      operatorId,
      name: 'Second Operator, Branch 1',
      code: SECOND_OPERATOR_BRANCH_CODE,
      timezone: 'Asia/Bangkok',
      country: 'TH',
      openingHours: Object.fromEntries(
        ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [
          day,
          { open: '10:00', close: '20:00' },
        ]),
      ),
    })
    .onConflictDoNothing({ target: [s.branch.operatorId, s.branch.code] })
    .returning({ id: s.branch.id });
  const [branchRow] = createdBranch
    ? [createdBranch]
    : await db
        .select({ id: s.branch.id })
        .from(s.branch)
        .where(
          and(
            eq(s.branch.operatorId, operatorId),
            eq(s.branch.code, SECOND_OPERATOR_BRANCH_CODE),
          ),
        )
        .limit(1);
  const branchId = branchRow!.id;

  const phone = normalizePhone(SECOND_OPERATOR_ADMIN_PHONE)!;
  const [foundEmployee] = await db
    .select({ id: s.employee.id })
    .from(s.employee)
    .where(and(eq(s.employee.operatorId, operatorId), eq(s.employee.phone, phone)))
    .limit(1);
  const employeeId = foundEmployee?.id ?? newId();
  if (!foundEmployee) {
    await db.insert(s.employee).values({
      id: employeeId,
      operatorId,
      name: 'Second Operator administrator',
      branchId,
      phone,
    });
  }

  const [createdAccount] = await db
    .insert(s.account)
    .values({
      id: newId(),
      operatorId,
      employeeId,
      phone,
      passwordHash: await hash(SECOND_OPERATOR_ADMIN_PASSWORD),
      phoneVerifiedAt: new Date(),
      status: 'active',
    })
    .onConflictDoNothing({ target: [s.account.operatorId, s.account.phone] })
    .returning({ id: s.account.id });
  const [accountRow] = createdAccount
    ? [createdAccount]
    : await db
        .select({ id: s.account.id })
        .from(s.account)
        .where(and(eq(s.account.operatorId, operatorId), eq(s.account.phone, phone)))
        .limit(1);
  const accountId = accountRow!.id;

  const roleId = roleIds.operator_admin;
  const [held] = await db
    .select({ id: s.roleAssignment.id })
    .from(s.roleAssignment)
    .where(
      and(
        eq(s.roleAssignment.accountId, accountId),
        eq(s.roleAssignment.roleId, roleId),
        eq(s.roleAssignment.scopeType, 'operator'),
        eq(s.roleAssignment.scopeId, operatorId),
      ),
    )
    .limit(1);
  if (!held) {
    await db.insert(s.roleAssignment).values({
      id: newId(),
      accountId,
      roleId,
      scopeType: 'operator',
      scopeId: operatorId,
    });
  }

  // Slot `virtual-1`, the same slot the park's first box sits in, and that is
  // the point rather than a clash to tidy up: `box_slot_unique` is keyed on
  // (branch, slot), so this is what the second box in any real second operator
  // would be called. Ten lookups in the api's test suite were reading a box by
  // that slot with no operator on the predicate, and five of them were finding
  // the wrong row the moment this existed. `fixture-tenancy.test.ts` asserts
  // the collision stays, so the habit cannot grow back.
  const [foundBox] = await db
    .select({ id: s.box.id })
    .from(s.box)
    .where(and(eq(s.box.branchId, branchId), eq(s.box.slot, 'virtual-1')))
    .limit(1);
  const boxId = foundBox?.id ?? newId();
  if (!foundBox) {
    await db.insert(s.box).values({
      id: boxId,
      operatorId,
      branchId,
      name: 'Virtual box 1',
      slot: 'virtual-1',
      role: 'virtual',
      status: 'unclaimed',
    });
  }

  // `S1` rather than `T1`. The prefix IS the receipt series name
  // (`allocateReceiptNumber` in `apps/api/src/services/sale.ts`), so a prefix
  // shared with an OTO till would make two rows that read alike in a log line
  // belong to two different tenants — which is the confusion this operator
  // exists to make visible, not to add to.
  const [foundStation] = await db
    .select({ id: s.station.id })
    .from(s.station)
    .where(and(eq(s.station.branchId, branchId), eq(s.station.name, 'Reception Till 1')))
    .limit(1);
  if (!foundStation) {
    await db.insert(s.station).values({
      id: newId(),
      operatorId,
      branchId,
      boxId,
      name: 'Reception Till 1',
      kind: 'till',
      codePrefix: 'S1',
      capabilities: ['tickets'],
      accessScope: 'all_staff',
    });
  }

  // A member with a child, so the foreign operator has a row on the ONE
  // surface that matters most: the member register is the park's primary
  // customer key and carries children's allergies and medical notes. The
  // conformance register's Check 1 asked for this and the first cut of the
  // fixture left it out — a tenancy test against an operator with no members
  // proves nothing about member isolation. The phone is a +6699… test number
  // like the rest of this fixture; the allergy is invented.
  const [foreignMember] = await db
    .insert(s.member)
    .values({
      id: newId(),
      operatorId,
      phone: normalizePhone('0990000010')!,
      nickname: 'Second-Op Member',
      tierCode: 'tourist',
      createdVia: 'import',
    })
    .onConflictDoNothing({ target: [s.member.operatorId, s.member.phone] })
    .returning({ id: s.member.id });
  if (foreignMember) {
    await db.insert(s.child).values({
      id: newId(),
      memberId: foreignMember.id,
      name: 'Second-Op Child',
      ageYears: 6,
      allergies: 'Eggs',
      medicalAlert: true,
      consentRecordedAt: new Date(),
    });
  }
}

/**
 * Run directly. One command is correct on every deployment, because the
 * deployment says which it is:
 *
 *   SEED_PROFILE=staging     the demo tenant as well, so there is something
 *                            to sign in as and play with
 *   SEED_PROFILE=production  the platform's own rows only — system roles,
 *                            their permissions, and the default tender list
 *                            for a park that has none. A real branch's data
 *                            arrives by restore (S2-22), never from a fixture
 *                            file.
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
      ? `Platform sync only (SEED_PROFILE=${profile}): system roles, permissions and tenders.`
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
