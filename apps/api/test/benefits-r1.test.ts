import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, benefitProfile, benefitRoleTemplate, employee, productCategory } from '@oto/db';
import { BENEFIT_SEED_EFFECTIVE_FROM, seed } from '@oto/db/seed';
import { addDaysToIsoDate, newId, type BenefitProfile } from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-21 (SCRUM-218) round 1 — Admin > Staff Benefits on real data: the role
 * templates and each person's benefit, with effective dates and history
 * (plan docs/progress/plans/benefits/PLAN.md §8 round 1).
 *
 * The acceptance for the round, as the plan words it:
 *   - check 1 on seeded employees: every staff member listed comes from
 *     `core.employee` (seeded until the OTO App copy exists);
 *   - check 2 at the Q2 amounts: the Manager's credit edited to ฿600 from
 *     tomorrow leaves today at ฿500, and both versions are in the history.
 *
 * Every write is asserted with the audit row it must have written, and every
 * refusal with the row it must NOT have.
 */

let ctx: TestContext;
let admin: string;
let manager: string;
let reception: string;
let foreignAdmin: string;
let operatorId: string;
let coffeeCategoryId: string;
const people: Record<'anan' | 'som' | 'nok' | 'lek' | 'dao', string> = {
  anan: '',
  som: '',
  nok: '',
  lek: '',
  dao: '',
};

let key = 0;
const idem = () => `benefits-r1-${Date.now()}-${key++}`;

async function get<T = Record<string, unknown>>(
  cookie: string,
  url: string,
): Promise<{ status: number; body: T }> {
  const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
  return { status: res.statusCode, body: res.json() as T };
}

async function put<T = Record<string, unknown>>(
  cookie: string,
  url: string,
  payload: unknown,
  idempotencyKey = idem(),
): Promise<{ status: number; body: T }> {
  const res = await ctx.app.inject({
    method: 'PUT',
    url,
    headers: { cookie, 'idempotency-key': idempotencyKey },
    payload: payload as Record<string, unknown>,
  });
  return { status: res.statusCode, body: res.json() as T };
}

interface Version {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  createdBy: { accountId: string; name: string | null } | null;
}
interface TemplateVersion extends Version {
  profile: BenefitProfile;
}
interface Template {
  role: string;
  name: string;
  current: TemplateVersion | null;
  upcoming: TemplateVersion[];
}
interface ProfileVersion extends Version {
  benefitRole: string | null;
  override: BenefitProfile | null;
}
interface Staff {
  employeeId: string;
  name: string;
  source: string;
  current: ProfileVersion | null;
  upcoming: ProfileVersion[];
  effectiveProfile: BenefitProfile;
}

async function templates(cookie = admin): Promise<{ today: string; templates: Template[] }> {
  const res = await get<{ today: string; templates: Template[] }>(cookie, '/benefits/templates');
  expect(res.status).toBe(200);
  return res.body;
}

async function effective(employeeId: string, on?: string) {
  const res = await get<{
    benefitRole: string | null;
    hasOverride: boolean;
    profile: BenefitProfile;
    isEmpty: boolean;
  }>(admin, `/benefits/profiles/${employeeId}/effective${on ? `?on=${on}` : ''}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function auditRows(action: string, entityIds?: string[]) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(
      entityIds
        ? and(eq(auditLog.action, action), inArray(auditLog.entityId, entityIds))
        : eq(auditLog.action, action),
    );
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  foreignAdmin = await signInAs(
    ctx.app,
    SECOND_OPERATOR_ADMIN.phone,
    SECOND_OPERATOR_ADMIN.password,
  );
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  const rows = await ctx.db
    .select({ id: employee.id, name: employee.name })
    .from(employee)
    .where(eq(employee.operatorId, operatorId));
  const byName = (name: string) => rows.find((r) => r.name === name)!.id;
  people.anan = byName('Khun Anan (Owner)');
  people.som = byName('Som (Reception)');
  people.nok = byName('Nok (Reception)');
  people.lek = byName('Khun Lek (Manager)');
  people.dao = byName('Khun Dao (Manager)');
  const [coffee] = await ctx.db
    .select({ id: productCategory.id })
    .from(productCategory)
    .where(
      and(eq(productCategory.operatorId, operatorId), eq(productCategory.code, 'DRINKS-COFFEE')),
    );
  coffeeCategoryId = coffee!.id;
}, 120_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('the seeded park (check 1 on seeded employees; the Q2 amounts)', () => {
  it('lists every current staff member from core.employee, seeded, with the prototype roster’s roles', async () => {
    const res = await get<{ today: string; staff: Staff[] }>(admin, '/benefits/profiles');
    expect(res.status).toBe(200);
    const byId = new Map(res.body.staff.map((s) => [s.employeeId, s]));
    const dbRows = await ctx.db
      .select({ id: employee.id })
      .from(employee)
      .where(eq(employee.operatorId, operatorId));
    // Exactly the employee table: nothing invented, nothing left out.
    expect(new Set(byId.keys())).toEqual(new Set(dbRows.map((r) => r.id)));
    expect(res.body.staff.every((s) => s.source === 'platform')).toBe(true);

    expect(byId.get(people.anan)!.current!.benefitRole).toBe('owner');
    expect(byId.get(people.som)!.current!.benefitRole).toBe('staff');
    expect(byId.get(people.lek)!.current!.benefitRole).toBe('manager');
    // Not in the prototype's roster: no role, no benefit.
    expect(byId.get(people.dao)!.current).toBeNull();
    expect(byId.get(people.dao)!.effectiveProfile).toEqual({});

    // Nok: the plan's named fixture — the Staff template with four coffees.
    const nok = byId.get(people.nok)!;
    expect(nok.current!.benefitRole).toBe('staff');
    expect(nok.current!.override!.freeItems?.[0]?.quotaPerPeriod).toBe(4);
    expect(nok.effectiveProfile.freeItems?.[0]?.quotaPerPeriod).toBe(4);
    expect(nok.effectiveProfile.standingDiscount).toEqual({ percent: 30, target: { kind: 'fnb' } });
  });

  it('carries the prototype’s three templates at its own amounts (plan Q2)', async () => {
    const body = await templates();
    const by = Object.fromEntries(body.templates.map((t) => [t.role, t]));
    expect(body.templates.map((t) => [t.role, t.name])).toEqual([
      ['owner', 'Owner'],
      ['manager', 'Manager'],
      ['staff', 'Staff'],
    ]);
    const coffee = {
      id: 'coffee',
      label: 'Free coffee',
      target: { kind: 'fnbCategory', category: coffeeCategoryId },
      quotaPerPeriod: 2,
      period: 'daily',
    };
    expect(by.owner!.current!.profile).toEqual({ comp: true });
    expect(by.manager!.current!.profile).toEqual({
      freeItems: [coffee],
      credit: { amountSatang: 50_000, period: 'monthly' },
      standingDiscount: { percent: 30, target: { kind: 'fnb' } },
    });
    expect(by.staff!.current!.profile).toEqual({
      freeItems: [coffee],
      standingDiscount: { percent: 30, target: { kind: 'fnb' } },
    });
    for (const t of body.templates) {
      expect(t.current!.effectiveFrom).toBe(BENEFIT_SEED_EFFECTIVE_FROM);
      expect(t.current!.createdBy).toBeNull();
      expect(t.upcoming).toEqual([]);
    }
    const lek = await effective(people.lek);
    expect(lek.profile.credit).toEqual({ amountSatang: 50_000, period: 'monthly' });
  });
});

describe('check 2 — a Manager edit dated tomorrow leaves today alone (H4, H5)', () => {
  let today: string;
  let tomorrow: string;
  let seededManagerId: string;
  let futureId: string;

  it('saves ฿600 from tomorrow; today stays ฿500', async () => {
    const before = await templates();
    today = before.today;
    tomorrow = addDaysToIsoDate(today, 1);
    const manager0 = before.templates.find((t) => t.role === 'manager')!;
    seededManagerId = manager0.current!.id;

    const profile = {
      ...manager0.current!.profile,
      credit: { amountSatang: 60_000, period: 'monthly' },
    };
    const res = await put<{ changed: boolean; template: Template }>(
      admin,
      '/benefits/templates/manager',
      {
        profile,
        effectiveFrom: tomorrow,
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.template.current!.id).toBe(seededManagerId);
    expect(res.body.template.current!.profile.credit?.amountSatang).toBe(50_000);
    expect(res.body.template.upcoming).toHaveLength(1);
    futureId = res.body.template.upcoming[0]!.id;
    expect(res.body.template.upcoming[0]!.effectiveFrom).toBe(tomorrow);
    expect(res.body.template.upcoming[0]!.profile.credit?.amountSatang).toBe(60_000);

    // What a scan of Khun Lek applies: ฿500 today, ฿600 tomorrow.
    expect((await effective(people.lek)).profile.credit?.amountSatang).toBe(50_000);
    expect((await effective(people.lek, today)).profile.credit?.amountSatang).toBe(50_000);
    expect((await effective(people.lek, tomorrow)).profile.credit?.amountSatang).toBe(60_000);
    // Nok's override does not follow the template (Q1): unchanged, and she is Staff anyway.
    expect((await effective(people.nok, tomorrow)).profile.freeItems?.[0]?.quotaPerPeriod).toBe(4);
  });

  it('keeps both versions: the seeded row closed on tomorrow, its profile untouched', async () => {
    const res = await get<{ versions: TemplateVersion[] }>(admin, '/benefits/templates/manager');
    expect(res.status).toBe(200);
    expect(res.body.versions.map((v) => v.id)).toEqual([futureId, seededManagerId]);
    const [future, seeded] = res.body.versions;
    expect(seeded!.effectiveFrom).toBe(BENEFIT_SEED_EFFECTIVE_FROM);
    expect(seeded!.effectiveTo).toBe(tomorrow);
    expect(seeded!.profile.credit?.amountSatang).toBe(50_000);
    expect(future!.effectiveFrom).toBe(tomorrow);
    expect(future!.effectiveTo).toBeNull();
    // Who changed it and when.
    expect(future!.createdBy!.name).toBe('Khun Anan (Owner)');
    expect(Date.now() - Date.parse(future!.createdAt)).toBeLessThan(60_000);

    const [row] = await ctx.db
      .select()
      .from(benefitRoleTemplate)
      .where(eq(benefitRoleTemplate.id, seededManagerId));
    expect(row!.profile.credit?.amountSatang).toBe(50_000);
  });

  it('audits benefit.template_update with what was in force and what replaces it', async () => {
    const [row] = await auditRows('benefit.template_update', [futureId]);
    expect(row).toBeDefined();
    expect(row!.entityType).toBe('benefit_role_template');
    expect(row!.operatorId).toBe(operatorId);
    expect((row!.before as { id: string; effectiveTo: string | null }).id).toBe(seededManagerId);
    expect((row!.before as { effectiveTo: string | null }).effectiveTo).toBeNull();
    const after = row!.after as {
      effectiveFrom: string;
      closedVersionId: string;
      profile: { credit: { amountSatang: number } };
    };
    expect(after.effectiveFrom).toBe(tomorrow);
    expect(after.closedVersionId).toBe(seededManagerId);
    expect(after.profile.credit?.amountSatang).toBe(60_000);
  });

  it('a second save for the same day replaces the scheduled one, which stays in the history', async () => {
    const current = (await templates()).templates.find((t) => t.role === 'manager')!.upcoming[0]!;
    const res = await put<{ template: Template }>(admin, '/benefits/templates/manager', {
      profile: { ...current.profile, credit: { amountSatang: 70_000, period: 'monthly' } },
      effectiveFrom: tomorrow,
    });
    expect(res.status).toBe(200);
    expect(res.body.template.upcoming.map((v) => v.profile.credit?.amountSatang)).toEqual([70_000]);
    const history = await get<{ versions: TemplateVersion[] }>(
      admin,
      '/benefits/templates/manager',
    );
    const replaced = history.body.versions.find((v) => v.id === futureId)!;
    // Replaced before it started: an empty range, in force on no day.
    expect(replaced.effectiveFrom).toBe(tomorrow);
    expect(replaced.effectiveTo).toBe(tomorrow);
    expect(history.body.versions).toHaveLength(3);
    expect((await effective(people.lek, tomorrow)).profile.credit?.amountSatang).toBe(70_000);
  });

  it('a change dated today in front of a scheduled one runs until it, and the scheduled one still happens', async () => {
    const before = (await templates()).templates.find((t) => t.role === 'manager')!;
    const res = await put<{ template: Template }>(admin, '/benefits/templates/manager', {
      profile: {
        ...before.current!.profile,
        standingDiscount: { percent: 20, target: { kind: 'fnb' } },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.template.current!.effectiveFrom).toBe(today);
    expect(res.body.template.current!.effectiveTo).toBe(tomorrow);
    expect(res.body.template.upcoming.map((v) => v.profile.credit?.amountSatang)).toEqual([70_000]);
    expect((await effective(people.lek)).profile.standingDiscount?.percent).toBe(20);
    expect((await effective(people.lek, tomorrow)).profile.standingDiscount?.percent).toBe(30);
    // And the seeded version now ends today.
    const [seeded] = await ctx.db
      .select()
      .from(benefitRoleTemplate)
      .where(eq(benefitRoleTemplate.id, seededManagerId));
    expect(seeded!.effectiveTo).toBe(today);
  });

  it('never has two versions in force on one day (H18)', async () => {
    const rows = await ctx.db
      .select()
      .from(benefitRoleTemplate)
      .where(
        and(
          eq(benefitRoleTemplate.operatorId, operatorId),
          eq(benefitRoleTemplate.role, 'manager'),
        ),
      );
    for (let d = -2; d <= 5; d++) {
      const day = addDaysToIsoDate(today, d);
      const inForce = rows.filter(
        (r) => r.effectiveFrom <= day && (r.effectiveTo === null || r.effectiveTo > day),
      );
      expect(inForce, day).toHaveLength(1);
    }
  });

  it('refuses a day before today, writing nothing', async () => {
    const count = (await ctx.db.select().from(benefitRoleTemplate)).length;
    const res = await put<{ error: { code: string } }>(admin, '/benefits/templates/staff', {
      profile: { comp: true },
      effectiveFrom: addDaysToIsoDate(today, -1),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BENEFIT_EFFECTIVE_DATE_PAST');
    expect((await ctx.db.select().from(benefitRoleTemplate)).length).toBe(count);
  });

  it('a save identical to the version in force writes and records nothing', async () => {
    const staff = (await templates()).templates.find((t) => t.role === 'staff')!;
    const audits = (await auditRows('benefit.template_update')).length;
    const res = await put<{ changed: boolean; template: Template }>(
      admin,
      '/benefits/templates/staff',
      {
        // Key order differs; the content does not.
        profile: {
          standingDiscount: staff.current!.profile.standingDiscount,
          freeItems: staff.current!.profile.freeItems,
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.template.current!.id).toBe(staff.current!.id);
    expect((await auditRows('benefit.template_update')).length).toBe(audits);
  });

  it('a replayed key saves once and answers the same', async () => {
    const k = idem();
    const body = {
      profile: { comp: true, freeItems: [] },
      effectiveFrom: addDaysToIsoDate(today, 3),
    };
    const first = await put<{ template: Template }>(admin, '/benefits/templates/owner', body, k);
    const second = await put<{ template: Template }>(admin, '/benefits/templates/owner', body, k);
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const rows = await ctx.db
      .select()
      .from(benefitRoleTemplate)
      .where(
        and(eq(benefitRoleTemplate.operatorId, operatorId), eq(benefitRoleTemplate.role, 'owner')),
      );
    expect(rows).toHaveLength(2);
  });

  it('refuses a category this park does not have', async () => {
    const res = await put<{ error: { code: string } }>(admin, '/benefits/templates/staff', {
      profile: {
        standingDiscount: { percent: 10, target: { kind: 'fnbCategory', category: newId() } },
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BENEFIT_TARGET_UNKNOWN');
  });

  it('refuses a profile the engine would misread', async () => {
    const dup = {
      id: 'coffee',
      label: 'x',
      target: { kind: 'fnb' },
      quotaPerPeriod: 1,
      period: 'daily',
    };
    expect(
      (await put(admin, '/benefits/templates/staff', { profile: { freeItems: [dup, dup] } }))
        .status,
    ).toBe(400);
    expect(
      (
        await put(admin, '/benefits/templates/staff', {
          profile: { credit: { amountTHB: 500, period: 'daily' } },
        })
      ).status,
    ).toBe(400);
  });
});

describe('each person’s benefit', () => {
  let today: string;

  it('assigns a benefit role from today, audited benefit.profile_update', async () => {
    today = (await templates()).today;
    const res = await put<{ changed: boolean; staff: Staff }>(
      admin,
      `/benefits/profiles/${people.dao}`,
      {
        benefitRole: 'staff',
        override: null,
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.staff.current!.benefitRole).toBe('staff');
    expect(res.body.staff.current!.effectiveFrom).toBe(today);
    expect(res.body.staff.effectiveProfile.freeItems?.[0]?.quotaPerPeriod).toBe(2);
    const [row] = await auditRows('benefit.profile_update', [res.body.staff.current!.id]);
    expect(row!.entityType).toBe('benefit_profile');
    expect(row!.before).toBeNull();
    expect((row!.after as { employeeId: string; benefitRole: string }).employeeId).toBe(people.dao);
    expect((row!.after as { benefitRole: string }).benefitRole).toBe('staff');
  });

  it('an override is the whole profile while on, and switching it off returns to the template', async () => {
    const on = await put<{ staff: Staff }>(admin, `/benefits/profiles/${people.som}`, {
      benefitRole: 'staff',
      override: { standingDiscount: { percent: 50 } },
    });
    expect(on.status).toBe(200);
    expect(on.body.staff.effectiveProfile).toEqual({ standingDiscount: { percent: 50 } });
    expect((await effective(people.som)).hasOverride).toBe(true);

    const off = await put<{ staff: Staff }>(admin, `/benefits/profiles/${people.som}`, {
      benefitRole: 'staff',
      override: null,
    });
    expect(off.body.staff.effectiveProfile.freeItems?.[0]?.id).toBe('coffee');
    const history = await get<{ versions: ProfileVersion[] }>(
      admin,
      `/benefits/profiles/${people.som}`,
    );
    // Seeded, override on, override off: the same-day pair replaced in turn.
    expect(history.body.versions).toHaveLength(3);
    expect(history.body.versions[0]!.override).toBeNull();
    expect(history.body.versions[1]!.override).toEqual({ standingDiscount: { percent: 50 } });
  });

  it('a role change dated tomorrow leaves today’s benefit as it is', async () => {
    const tomorrow = addDaysToIsoDate(today, 1);
    const res = await put<{ staff: Staff }>(admin, `/benefits/profiles/${people.som}`, {
      benefitRole: 'manager',
      override: null,
      effectiveFrom: tomorrow,
    });
    expect(res.body.staff.current!.benefitRole).toBe('staff');
    expect(res.body.staff.upcoming.map((v) => [v.benefitRole, v.effectiveFrom])).toEqual([
      ['manager', tomorrow],
    ]);
    expect((await effective(people.som)).benefitRole).toBe('staff');
    expect((await effective(people.som, tomorrow)).benefitRole).toBe('manager');
  });

  it('removing the role removes the benefit, and an override without a role is refused', async () => {
    const refused = await put<{ error: { code: string } }>(
      admin,
      `/benefits/profiles/${people.anan}`,
      {
        benefitRole: null,
        override: { comp: true },
      },
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BENEFIT_OVERRIDE_WITHOUT_ROLE');

    const none = await put<{ staff: Staff }>(admin, `/benefits/profiles/${people.anan}`, {
      benefitRole: null,
      override: null,
      effectiveFrom: addDaysToIsoDate(today, 2),
    });
    expect(none.status).toBe(200);
    const later = await effective(people.anan, addDaysToIsoDate(today, 2));
    expect(later.benefitRole).toBeNull();
    expect(later.isEmpty).toBe(true);
    expect((await effective(people.anan)).profile).toEqual({ comp: true });
  });

  it('refuses someone who has left, and another operator’s staff member is not found', async () => {
    const leaverId = newId();
    await ctx.db
      .insert(employee)
      .values({ id: leaverId, operatorId, name: 'Leaver', archivedAt: new Date() });
    const left = await put<{ error: { code: string } }>(admin, `/benefits/profiles/${leaverId}`, {
      benefitRole: 'staff',
      override: null,
    });
    expect(left.status).toBe(409);
    expect(left.body.error.code).toBe('EMPLOYEE_ARCHIVED');
    expect(
      await ctx.db.select().from(benefitProfile).where(eq(benefitProfile.employeeId, leaverId)),
    ).toEqual([]);
    // Not listed either.
    const list = await get<{ staff: Staff[] }>(admin, '/benefits/profiles');
    expect(list.body.staff.some((s) => s.employeeId === leaverId)).toBe(false);

    const foreign = await put(foreignAdmin, `/benefits/profiles/${people.lek}`, {
      benefitRole: 'owner',
      override: null,
    });
    expect(foreign.status).toBe(404);
    expect((await get(foreignAdmin, `/benefits/profiles/${people.lek}`)).status).toBe(404);
    const theirs = await get<{ staff: Staff[] }>(foreignAdmin, '/benefits/profiles');
    expect(theirs.body.staff.some((s) => Object.values(people).includes(s.employeeId))).toBe(false);
    // And their operator has no templates of its own: three empty roles.
    const theirTemplates = await templates(foreignAdmin);
    expect(theirTemplates.templates.every((t) => t.current === null)).toBe(true);
  });
});

describe('who may', () => {
  it('a branch manager reads and cannot change; reception cannot open the screen', async () => {
    expect((await get(manager, '/benefits/templates')).status).toBe(200);
    expect((await get(manager, '/benefits/profiles')).status).toBe(200);
    expect(
      (await put(manager, '/benefits/templates/staff', { profile: { comp: true } })).status,
    ).toBe(403);
    expect(
      (
        await put(manager, `/benefits/profiles/${people.som}`, {
          benefitRole: 'owner',
          override: null,
        })
      ).status,
    ).toBe(403);
    expect((await get(reception, '/benefits/templates')).status).toBe(403);
    expect((await get(reception, '/benefits/profiles')).status).toBe(403);
  });
});

describe('core.employee (plan §7)', () => {
  it('every row is a platform row until the OTO App copy writes one', async () => {
    const rows = await ctx.db.select({ source: employee.source }).from(employee);
    expect(rows.every((r) => r.source === 'platform')).toBe(true);
  });

  it('an OTO App id is unique per operator among live rows, and archiving frees it', async () => {
    const first = newId();
    await ctx.db
      .insert(employee)
      .values({ id: first, operatorId, name: 'Copied', source: 'otoapp', externalId: 'otoapp-42' });
    await expect(
      ctx.db
        .insert(employee)
        .values({
          id: newId(),
          operatorId,
          name: 'Copied twice',
          source: 'otoapp',
          externalId: 'otoapp-42',
        }),
    ).rejects.toThrow();
    await ctx.db.update(employee).set({ archivedAt: new Date() }).where(eq(employee.id, first));
    await ctx.db
      .insert(employee)
      .values({
        id: newId(),
        operatorId,
        name: 'Rehired',
        source: 'otoapp',
        externalId: 'otoapp-42',
      });
    await expect(
      ctx.db
        .insert(employee)
        .values({ id: newId(), operatorId, name: 'Bad', source: 'somewhere' as never }),
    ).rejects.toThrow();
  });
});

describe('the seed', () => {
  it('re-run, leaves every change made on screen as it was', async () => {
    const templatesBefore = await ctx.db.select().from(benefitRoleTemplate);
    const profilesBefore = await ctx.db.select().from(benefitProfile);
    await seed(ctx.db);
    const byId = <T extends { id: string }>(rows: T[]) =>
      [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(byId(await ctx.db.select().from(benefitRoleTemplate))).toEqual(byId(templatesBefore));
    expect(byId(await ctx.db.select().from(benefitProfile))).toEqual(byId(profilesBefore));
  }, 120_000);
});
