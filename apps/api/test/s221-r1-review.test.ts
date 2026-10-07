import { hash } from '@node-rs/argon2';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  benefitProfile,
  benefitRoleTemplate,
  employee,
  product,
  productCategory,
  role,
  roleAssignment,
} from '@oto/db';
import { BENEFIT_SEED_EFFECTIVE_FROM } from '@oto/db/seed';
import {
  addDaysToIsoDate,
  newId,
  normalizePhone,
  ROLE_BUNDLES,
  type BenefitProfile,
  type BenefitRole,
} from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CHALONG_MANAGER,
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
 * SCRUM-218 review of lane I round 1 — Admin > Staff Benefits on the platform,
 * attacked from outside the builder's own test (`benefits-r1.test.ts`):
 *
 *   1. Who may (plan "Permissions"): `admin:benefit:read` for branch_manager —
 *      at either park — and operator_admin; `admin:benefit:manage` for
 *      operator_admin only; reception and staff open nothing. A refusal
 *      writes nothing and records nothing.
 *   2. Effective dates (H4, H5, H18), model-checked: a seeded random run of
 *      saves at today-or-later is replayed against a plain model (a list of
 *      start days), and after every save the database must agree with it on
 *      every day, hold exactly one version per day, never touch a row except
 *      to close it on the save's day, and leave every past day as it was.
 *   3. Saves racing each other on one template and on one person.
 *   4. Audit: every changed save has exactly one row with what was in force
 *      (before) and what replaces it (after); a no-op and a refusal have none.
 *   5. Idempotency, tenancy, the shapes a save refuses, and the staff list
 *      that no benefit route ever writes.
 */

let ctx: TestContext;
let operatorId: string;
let today: string;
const cookies: Record<'admin' | 'opAdmin' | 'lek' | 'dao' | 'reception' | 'staff' | 'foreign', string> = {
  admin: '',
  opAdmin: '',
  lek: '',
  dao: '',
  reception: '',
  staff: '',
  foreign: '',
};
const accountIds: Record<string, string> = {};
const people: Record<'anan' | 'som' | 'nok' | 'lek' | 'dao', string> = {
  anan: '',
  som: '',
  nok: '',
  lek: '',
  dao: '',
};
let employeeSnapshot: unknown[] = [];

let n = 0;
const key = () => `s221-review-${process.pid}-${Date.now()}-${n++}`;

async function call(
  cookie: string | null,
  method: 'GET' | 'PUT',
  url: string,
  payload?: unknown,
  idempotencyKey: string = key(),
) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (method === 'PUT') headers['idempotency-key'] = idempotencyKey;
  const res = await ctx.app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, raw: res.body };
}

async function makeAccount(phone: string, roleName: string, scope: 'operator' | 'branch') {
  const [roleRow] = await ctx.db.select().from(role).where(eq(role.name, roleName)).limit(1);
  const [central] = await ctx.db
    .select({ branchId: employee.branchId })
    .from(employee)
    .where(eq(employee.id, people.som));
  const id = newId();
  await ctx.db.insert(account).values({
    id,
    operatorId,
    phone: normalizePhone(phone)!,
    passwordHash: await hash('review1234'),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  await ctx.db.insert(roleAssignment).values({
    id: newId(),
    accountId: id,
    roleId: roleRow!.id,
    scopeType: scope,
    scopeId: scope === 'operator' ? operatorId : central!.branchId,
  });
  accountIds[phone] = id;
  return signInAs(ctx.app, phone, 'review1234');
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
};

const inForce = (r: { effectiveFrom: string; effectiveTo: string | null }, day: string) =>
  r.effectiveFrom <= day && (r.effectiveTo === null || r.effectiveTo > day);

const templateRows = (r: BenefitRole) =>
  ctx.db
    .select()
    .from(benefitRoleTemplate)
    .where(and(eq(benefitRoleTemplate.operatorId, operatorId), eq(benefitRoleTemplate.role, r)));

const profileRowsOf = (employeeId: string) =>
  ctx.db.select().from(benefitProfile).where(eq(benefitProfile.employeeId, employeeId));

const auditCount = async (action: string) =>
  (await ctx.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, action))).length;

const auditFor = (action: string, entityId: string) =>
  ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));

beforeAll(async () => {
  ctx = await createTestContext();
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
  cookies.admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  cookies.lek = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  cookies.dao = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  cookies.reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  cookies.foreign = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  cookies.opAdmin = await makeAccount('+66900002181', 'operator_admin', 'operator');
  cookies.staff = await makeAccount('+66900002182', 'staff', 'branch');
  const [adminRow] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.phone, normalizePhone(ADMIN.phone)!));
  accountIds.admin = adminRow!.id;
  today = (await call(cookies.admin, 'GET', '/benefits/templates')).body.today as string;
  employeeSnapshot = await ctx.db.select().from(employee).orderBy(employee.id);
}, 180_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

// --- 1. Who may ------------------------------------------------------------------------

describe('who may (plan "Permissions")', () => {
  it('the bundles: branch_manager reads, operator_admin manages, the counter roles only apply', () => {
    const has = (r: keyof typeof ROLE_BUNDLES, p: string) =>
      (ROLE_BUNDLES[r] as readonly string[]).includes(p);
    expect(has('branch_manager', 'admin:benefit:read')).toBe(true);
    expect(has('branch_manager', 'admin:benefit:manage')).toBe(false);
    expect(has('branch_manager', 'admin:benefit:credential_issue')).toBe(false);
    for (const p of ['admin:benefit:read', 'admin:benefit:manage', 'admin:benefit:credential_issue']) {
      expect(has('operator_admin', p), p).toBe(true);
      expect(has('reception', p), p).toBe(false);
      expect(has('staff', p), p).toBe(false);
    }
    expect(has('reception', 'pos:benefit:apply')).toBe(true);
    expect(has('staff', 'pos:benefit:apply')).toBe(true);
  });

  it('every /benefits route is guarded, and they are exactly round 1’s seven, round 2’s five and round 3’s one', () => {
    const routes = ctx.app.routeRegistry
      .filter((r) => r.url.startsWith('/benefits') && r.method !== 'HEAD')
      .map((r) => `${r.method} ${r.url} ${r.config.permission ?? 'UNGUARDED'}`)
      .sort();
    expect(routes).toEqual(
      [
        'GET /benefits/templates admin:benefit:read',
        'GET /benefits/templates/:role admin:benefit:read',
        'PUT /benefits/templates/:role admin:benefit:manage',
        'GET /benefits/profiles admin:benefit:read',
        'GET /benefits/profiles/:employeeId admin:benefit:read',
        'PUT /benefits/profiles/:employeeId admin:benefit:manage',
        'GET /benefits/profiles/:employeeId/effective admin:benefit:read',
        // Round 2 (the benefit QR): printing, issuing and revoking are the
        // operator admin's; a branch manager reads; the till resolves.
        'GET /benefits/credentials admin:benefit:read',
        'POST /benefits/credentials admin:benefit:credential_issue',
        'GET /benefits/credentials/:credentialId/qr admin:benefit:credential_issue',
        'POST /benefits/credentials/:credentialId/revoke admin:benefit:credential_issue',
        'POST /benefits/resolve pos:benefit:apply',
        // Round 3 (checkout): the Audit log, read by whoever reads the screen.
        'GET /benefits/applications admin:benefit:read',
      ].sort(),
    );
  });

  it('reads: both branch managers and the operator admin in; reception, staff and nobody out', async () => {
    const urls = [
      '/benefits/templates',
      '/benefits/templates/owner',
      '/benefits/profiles',
      `/benefits/profiles/${people.som}`,
      `/benefits/profiles/${people.som}/effective`,
    ];
    for (const url of urls) {
      for (const who of ['admin', 'opAdmin', 'lek', 'dao'] as const) {
        expect((await call(cookies[who], 'GET', url)).status, `${who} ${url}`).toBe(200);
      }
      for (const who of ['reception', 'staff'] as const) {
        expect((await call(cookies[who], 'GET', url)).status, `${who} ${url}`).toBe(403);
      }
      expect((await call(null, 'GET', url)).status, `anonymous ${url}`).toBe(401);
    }
  });

  it('writes: only the operator admin; every refusal writes and records nothing', async () => {
    const tplBefore = (await templateRows('staff')).length;
    const somBefore = (await profileRowsOf(people.som)).length;
    const audits = (await auditCount('benefit.template_update')) + (await auditCount('benefit.profile_update'));
    const body = { profile: { comp: true }, effectiveFrom: addDaysToIsoDate(today, 30) };
    const person = { benefitRole: 'owner', override: null, effectiveFrom: addDaysToIsoDate(today, 30) };
    for (const who of ['lek', 'dao', 'reception', 'staff'] as const) {
      expect((await call(cookies[who], 'PUT', '/benefits/templates/staff', body)).status, who).toBe(403);
      expect((await call(cookies[who], 'PUT', `/benefits/profiles/${people.som}`, person)).status, who).toBe(403);
    }
    expect((await call(null, 'PUT', '/benefits/templates/staff', body)).status).toBe(401);
    expect((await templateRows('staff')).length).toBe(tplBefore);
    expect((await profileRowsOf(people.som)).length).toBe(somBefore);
    expect((await auditCount('benefit.template_update')) + (await auditCount('benefit.profile_update'))).toBe(audits);

    // The operator admin alone (no platform role) may, and is the audited actor.
    const ok = await call(cookies.opAdmin, 'PUT', '/benefits/templates/staff', body);
    expect(ok.status).toBe(200);
    expect(ok.body.changed).toBe(true);
    const newest = (await templateRows('staff')).find(
      (r) => r.effectiveFrom === body.effectiveFrom && r.effectiveTo === null,
    )!;
    expect(newest.createdByAccountId).toBe(accountIds['+66900002181']);
    const [row] = await auditFor('benefit.template_update', newest.id);
    expect(row!.actorAccountId).toBe(accountIds['+66900002181']);
  });
});

// --- 2 + 4. Effective dates, model-checked, with the audit -------------------------------

/** A tiny deterministic generator. */
function rng(seed: number) {
  let s = seed >>> 0;
  return (k: number) => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s % k;
  };
}

/** The model: start day → what applies from it, until the next start. */
class Model<T> {
  private readonly starts = new Map<string, T>();
  constructor(first: string, value: T) {
    this.starts.set(first, value);
  }
  on(day: string): T | undefined {
    let best: string | undefined;
    for (const s of this.starts.keys()) if (s <= day && (best === undefined || s > best)) best = s;
    return best === undefined ? undefined : this.starts.get(best);
  }
  set(day: string, value: T) {
    this.starts.set(day, value);
  }
}

const TEMPLATE_CHOICES: BenefitProfile[] = [
  { comp: true },
  { standingDiscount: { percent: 10 } },
  { standingDiscount: { percent: 20, target: { kind: 'fnb' } } },
  { credit: { amountSatang: 10_000, period: 'daily' } },
  { credit: { amountSatang: 60_000, period: 'monthly' }, standingDiscount: { percent: 30 } },
];
const OFFSETS = [0, 0, 1, 1, 2, 3, 5, 8, 13];

describe('effective dates, model-checked (H4, H5, H18)', () => {
  it('40 random template saves: the database is the model on every day, history intact, audited', async () => {
    const rnd = rng(0x2182);
    const seeded = await templateRows('owner');
    expect(seeded).toHaveLength(1);
    const model = new Model<string>(BENEFIT_SEED_EFFECTIVE_FROM, canonical(seeded[0]!.profile));
    const yesterday = addDaysToIsoDate(today, -1);
    const days = Array.from({ length: 20 }, (_, i) => addDaysToIsoDate(today, i));

    for (let step = 0; step < 40; step++) {
      const from = addDaysToIsoDate(today, OFFSETS[rnd(OFFSETS.length)]!);
      const profile = TEMPLATE_CHOICES[rnd(TEMPLATE_CHOICES.length)]!;
      const expectChange = model.on(from) !== canonical(profile);
      const before = await templateRows('owner');
      const auditsBefore = await auditCount('benefit.template_update');

      const res = await call(cookies.admin, 'PUT', '/benefits/templates/owner', {
        profile,
        effectiveFrom: from,
      });
      const label = `step ${step}: ${canonical(profile)} from ${from}`;
      expect(res.status, `${label} ${res.raw}`).toBe(200);
      expect(res.body.changed, label).toBe(expectChange);
      if (expectChange) model.set(from, canonical(profile));

      const after = await templateRows('owner');
      expect(after.length, label).toBe(before.length + (expectChange ? 1 : 0));
      expect(await auditCount('benefit.template_update'), label).toBe(auditsBefore + (expectChange ? 1 : 0));

      // No row is rewritten: only one may change, and only its end, to the save's day.
      const closed: string[] = [];
      for (const old of before) {
        const now = after.find((r) => r.id === old.id)!;
        expect(
          { p: canonical(now.profile), f: now.effectiveFrom, c: now.createdAt.getTime(), b: now.createdByAccountId, n: now.name },
          label,
        ).toEqual({ p: canonical(old.profile), f: old.effectiveFrom, c: old.createdAt.getTime(), b: old.createdByAccountId, n: old.name });
        if (now.effectiveTo !== old.effectiveTo) {
          closed.push(old.id);
          expect(now.effectiveTo, label).toBe(from);
          expect(inForce(old, from), `${label}: only the row in force that day is closed`).toBe(true);
        }
      }
      expect(closed.length, label).toBe(expectChange ? 1 : 0);

      // Exactly one version on every day, and it is the model's.
      for (const d of [yesterday, ...days]) {
        const live = after.filter((r) => inForce(r, d));
        expect(live.length, `${label}: versions in force on ${d}`).toBe(1);
        expect(canonical(live[0]!.profile), `${label}: ${d}`).toBe(model.on(d));
      }
      // The past never moves.
      expect(canonical(after.find((r) => inForce(r, yesterday))!.profile)).toBe(canonical(seeded[0]!.profile));
      expect(after.filter((r) => r.effectiveTo === null).length, label).toBe(1);

      if (expectChange) {
        const created = after.find((r) => !before.some((b) => b.id === r.id))!;
        expect(created.effectiveFrom).toBe(from);
        expect(created.createdByAccountId).toBe(accountIds.admin);
        const [a] = await auditFor('benefit.template_update', created.id);
        const closedRow = before.find((r) => r.id === closed[0])!;
        expect(a!.actorAccountId).toBe(accountIds.admin);
        expect(a!.before, label).toMatchObject({
          id: closedRow.id,
          effectiveFrom: closedRow.effectiveFrom,
          effectiveTo: closedRow.effectiveTo,
        });
        expect(canonical((a!.before as { profile: unknown }).profile)).toBe(canonical(closedRow.profile));
        expect(a!.after, label).toMatchObject({
          id: created.id,
          effectiveFrom: from,
          effectiveTo: created.effectiveTo,
          closedVersionId: closedRow.id,
        });
        expect(canonical((a!.after as { profile: unknown }).profile)).toBe(canonical(profile));
      }

      // What a scan of Khun Anan (owner, no override) gets, through the API, on three days.
      for (const d of [today, from, addDaysToIsoDate(from, 1)]) {
        const eff = await call(cookies.admin, 'GET', `/benefits/profiles/${people.anan}/effective?on=${d}`);
        expect(eff.status).toBe(200);
        expect(canonical(eff.body.profile), `${label}: Anan on ${d}`).toBe(model.on(d));
      }
    }
  });

  it('30 random saves of one person’s role and override, checked the same way', async () => {
    const rnd = rng(0x5011);
    const seeded = await profileRowsOf(people.som);
    expect(seeded).toHaveLength(1);
    type Person = { benefitRole: BenefitRole | null; override: BenefitProfile | null };
    const keyOf = (p: Person) => canonical({ r: p.benefitRole, o: p.override });
    const model = new Model<Person>(BENEFIT_SEED_EFFECTIVE_FROM, {
      benefitRole: seeded[0]!.benefitRole,
      override: seeded[0]!.override,
    });
    const roles: Array<BenefitRole | null> = [null, 'staff', 'staff', 'manager', 'owner'];
    const days = Array.from({ length: 16 }, (_, i) => addDaysToIsoDate(today, i));
    const templates = await ctx.db
      .select()
      .from(benefitRoleTemplate)
      .where(eq(benefitRoleTemplate.operatorId, operatorId));
    const expectedProfile = (p: Person | undefined, day: string): string => {
      if (!p?.benefitRole) return canonical({});
      if (p.override) return canonical(p.override);
      const t = templates.find((r) => r.role === p.benefitRole && inForce(r, day));
      return canonical(t?.profile ?? {});
    };

    for (let step = 0; step < 30; step++) {
      const from = addDaysToIsoDate(today, OFFSETS[rnd(OFFSETS.length)]!);
      const benefitRole = roles[rnd(roles.length)]!;
      const override = benefitRole && rnd(2) === 0 ? TEMPLATE_CHOICES[rnd(TEMPLATE_CHOICES.length)]! : null;
      const next: Person = { benefitRole, override };
      const expectChange = keyOf(model.on(from)!) !== keyOf(next);
      const before = await profileRowsOf(people.som);
      const auditsBefore = await auditCount('benefit.profile_update');
      const res = await call(cookies.admin, 'PUT', `/benefits/profiles/${people.som}`, {
        ...next,
        effectiveFrom: from,
      });
      const label = `step ${step}: ${keyOf(next)} from ${from}`;
      expect(res.status, `${label} ${res.raw}`).toBe(200);
      expect(res.body.changed, label).toBe(expectChange);
      if (expectChange) model.set(from, next);

      const after = await profileRowsOf(people.som);
      expect(after.length, label).toBe(before.length + (expectChange ? 1 : 0));
      expect(await auditCount('benefit.profile_update'), label).toBe(auditsBefore + (expectChange ? 1 : 0));
      for (const old of before) {
        const now = after.find((r) => r.id === old.id)!;
        expect(
          { r: now.benefitRole, o: canonical(now.override), f: now.effectiveFrom, c: now.createdAt.getTime() },
          label,
        ).toEqual({ r: old.benefitRole, o: canonical(old.override), f: old.effectiveFrom, c: old.createdAt.getTime() });
        if (now.effectiveTo !== old.effectiveTo) expect(now.effectiveTo, label).toBe(from);
      }
      for (const d of [addDaysToIsoDate(today, -1), ...days]) {
        const live = after.filter((r) => inForce(r, d));
        expect(live.length, `${label}: versions on ${d}`).toBe(1);
        expect(keyOf({ benefitRole: live[0]!.benefitRole, override: live[0]!.override }), `${label}: ${d}`).toBe(
          keyOf(model.on(d)!),
        );
      }
      if (expectChange) {
        const created = after.find((r) => !before.some((b) => b.id === r.id))!;
        const [a] = await auditFor('benefit.profile_update', created.id);
        expect(a!.after, label).toMatchObject({ id: created.id, employeeId: people.som, benefitRole, effectiveFrom: from });
        expect(canonical((a!.after as { override: unknown }).override)).toBe(canonical(override));
        const closedRow = before.find((b) => after.find((r) => r.id === b.id)!.effectiveTo !== b.effectiveTo)!;
        expect(a!.before, label).toMatchObject({
          id: closedRow.id,
          benefitRole: closedRow.benefitRole,
          effectiveFrom: closedRow.effectiveFrom,
          effectiveTo: closedRow.effectiveTo,
        });
      }
      for (const d of [today, from]) {
        const eff = await call(cookies.admin, 'GET', `/benefits/profiles/${people.som}/effective?on=${d}`);
        expect(canonical(eff.body.profile), `${label}: Som on ${d}`).toBe(expectedProfile(model.on(d), d));
      }
    }
  });

  it('a day before today, or a day that does not exist, is refused and writes nothing', async () => {
    const before = (await templateRows('manager')).length;
    const audits = await auditCount('benefit.template_update');
    const past = await call(cookies.admin, 'PUT', '/benefits/templates/manager', {
      profile: { comp: true },
      effectiveFrom: addDaysToIsoDate(today, -1),
    });
    expect(past.status).toBe(400);
    expect((past.body.error as { code: string }).code).toBe('BENEFIT_EFFECTIVE_DATE_PAST');
    const bogus = await call(cookies.admin, 'PUT', '/benefits/templates/manager', {
      profile: { comp: true },
      effectiveFrom: '2027-02-30',
    });
    expect(bogus.status).toBe(400);
    const personPast = await call(cookies.admin, 'PUT', `/benefits/profiles/${people.lek}`, {
      benefitRole: 'owner',
      override: null,
      effectiveFrom: addDaysToIsoDate(today, -3),
    });
    expect(personPast.status).toBe(400);
    expect((await templateRows('manager')).length).toBe(before);
    expect(await auditCount('benefit.template_update')).toBe(audits);
  });

  it('“no benefit” for someone who never had one writes nothing', async () => {
    const res = await call(cookies.admin, 'PUT', `/benefits/profiles/${people.dao}`, {
      benefitRole: null,
      override: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(await profileRowsOf(people.dao)).toHaveLength(0);
  });
});

// --- 3. Races ---------------------------------------------------------------------------

describe('saves racing each other', () => {
  it('ten simultaneous template saves: every one lands, one version per day, one open end', async () => {
    const before = await templateRows('manager');
    const audits = await auditCount('benefit.template_update');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call(cookies.admin, 'PUT', '/benefits/templates/manager', {
          // Ten distinct profiles, none equal to anything already saved.
          profile: { standingDiscount: { percent: 41 + i } },
          effectiveFrom: addDaysToIsoDate(today, i % 4),
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(results.every((r) => r.body.changed === true)).toBe(true);
    const after = await templateRows('manager');
    expect(after.length).toBe(before.length + 10);
    expect(await auditCount('benefit.template_update')).toBe(audits + 10);
    expect(after.filter((r) => r.effectiveTo === null)).toHaveLength(1);
    for (let i = -1; i < 10; i++) {
      const d = addDaysToIsoDate(today, i);
      expect(after.filter((r) => inForce(r, d)).length, d).toBe(1);
    }
    // Ranges never overlap: sorted by start, each non-empty range ends where the next begins.
    const ranges = after
      .filter((r) => r.effectiveTo === null || r.effectiveTo > r.effectiveFrom)
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    for (let i = 1; i < ranges.length; i++) expect(ranges[i - 1]!.effectiveTo).toBe(ranges[i]!.effectiveFrom);
  });

  it('ten simultaneous saves of one person: the same', async () => {
    const before = await profileRowsOf(people.nok);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call(cookies.admin, 'PUT', `/benefits/profiles/${people.nok}`, {
          benefitRole: 'staff',
          override: { standingDiscount: { percent: 11 + i } },
          effectiveFrom: addDaysToIsoDate(today, i % 3),
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    const after = await profileRowsOf(people.nok);
    expect(after.length).toBe(before.length + 10);
    expect(after.filter((r) => r.effectiveTo === null && r.archivedAt === null)).toHaveLength(1);
    for (let i = -1; i < 6; i++) {
      const d = addDaysToIsoDate(today, i);
      expect(after.filter((r) => inForce(r, d)).length, d).toBe(1);
    }
  });
});

// --- 5. Idempotency, tenancy, shapes, the read-only staff list --------------------------

describe('idempotency', () => {
  it('one key, one body: one version, one audit row, the same answer twice; a new body under it is 409', async () => {
    const k = key();
    const body = { profile: { credit: { amountSatang: 12_345, period: 'daily' } }, effectiveFrom: addDaysToIsoDate(today, 20) };
    const before = (await templateRows('staff')).length;
    const audits = await auditCount('benefit.template_update');
    const first = await call(cookies.admin, 'PUT', '/benefits/templates/staff', body, k);
    const second = await call(cookies.admin, 'PUT', '/benefits/templates/staff', body, k);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect((await templateRows('staff')).length).toBe(before + 1);
    expect(await auditCount('benefit.template_update')).toBe(audits + 1);
    const mismatch = await call(
      cookies.admin,
      'PUT',
      '/benefits/templates/staff',
      { ...body, profile: { comp: true } },
      k,
    );
    expect(mismatch.status).toBe(409);
    expect((await templateRows('staff')).length).toBe(before + 1);
  });
});

describe('tenancy', () => {
  it('the second operator sees none of OTO’s templates or staff, and cannot reach them', async () => {
    const otoTemplateIds = (
      await ctx.db.select({ id: benefitRoleTemplate.id }).from(benefitRoleTemplate).where(eq(benefitRoleTemplate.operatorId, operatorId))
    ).map((r) => r.id);
    const list = await call(cookies.foreign, 'GET', '/benefits/templates');
    expect(list.status).toBe(200);
    for (const id of otoTemplateIds) expect(list.raw).not.toContain(id);
    const staff = await call(cookies.foreign, 'GET', '/benefits/profiles');
    expect(staff.status).toBe(200);
    for (const id of Object.values(people)) expect(staff.raw).not.toContain(id);

    expect((await call(cookies.foreign, 'GET', `/benefits/profiles/${people.som}`)).status).toBe(404);
    expect((await call(cookies.foreign, 'GET', `/benefits/profiles/${people.som}/effective`)).status).toBe(404);
    const somBefore = (await profileRowsOf(people.som)).length;
    const put = await call(cookies.foreign, 'PUT', `/benefits/profiles/${people.som}`, {
      benefitRole: 'owner',
      override: null,
    });
    expect(put.status).toBe(404);
    expect((await profileRowsOf(people.som)).length).toBe(somBefore);

    // Its own template saves land on its own operator only.
    const ownerBefore = await templateRows('owner');
    const own = await call(cookies.foreign, 'PUT', '/benefits/templates/owner', { profile: { comp: true } });
    expect(own.status).toBe(200);
    expect(own.body.changed).toBe(true);
    expect((await templateRows('owner')).map((r) => r.id).sort()).toEqual(ownerBefore.map((r) => r.id).sort());

    // And OTO's coffee category is not one of its targets.
    const [coffee] = await ctx.db
      .select({ id: productCategory.id })
      .from(productCategory)
      .where(and(eq(productCategory.operatorId, operatorId), eq(productCategory.code, 'DRINKS-COFFEE')));
    const borrowed = await call(cookies.foreign, 'PUT', '/benefits/templates/staff', {
      profile: { freeItems: [{ id: 'coffee', label: 'Free coffee', target: { kind: 'fnbCategory', category: coffee!.id }, quotaPerPeriod: 2, period: 'daily' }] },
    });
    expect(borrowed.status).toBe(400);
    expect((borrowed.body.error as { code: string }).code).toBe('BENEFIT_TARGET_UNKNOWN');
  });
});

describe('the shapes a save refuses, each writing nothing', () => {
  it('ticket scopes, out-of-range numbers, unknown keys, twin free-item ids, a shop item as a menu item', async () => {
    const [merch] = await ctx.db
      .select({ id: product.id })
      .from(product)
      .where(and(eq(product.operatorId, operatorId), eq(product.kind, 'merch')))
      .limit(1);
    const free = (over: Record<string, unknown> = {}) => ({
      id: 'x',
      label: 'X',
      target: { kind: 'fnb' },
      quotaPerPeriod: 1,
      period: 'daily',
      ...over,
    });
    const bad: Array<[string, unknown]> = [
      ['a ticket scope', { standingDiscount: { percent: 10, target: { kind: 'tickets' } } }],
      ['a category that is not a uuid', { freeItems: [free({ target: { kind: 'fnbCategory', category: 'drinks-coffee' } })] }],
      ['over 100 %', { standingDiscount: { percent: 101 } }],
      ['a negative percent', { standingDiscount: { percent: -1 } }],
      ['negative credit', { credit: { amountSatang: -1, period: 'daily' } }],
      ['a fractional satang', { credit: { amountSatang: 10.5, period: 'daily' } }],
      ['a zero quota', { freeItems: [free({ quotaPerPeriod: 0 })] }],
      ['an unknown period', { freeItems: [free({ period: 'weekly' })] }],
      ['an unknown key', { comp: true, vip: true }],
      ['twin free-item ids', { freeItems: [free(), free()] }],
      ...(merch ? ([['a shop item named as a menu item', { freeItems: [free({ target: { kind: 'menuItems', menuItemIds: [merch.id] } })] }]] as Array<[string, unknown]>) : []),
    ];
    expect(merch, 'the seed has a shop item to try').toBeDefined();
    const before = (await templateRows('staff')).length;
    const audits = await auditCount('benefit.template_update');
    for (const [name, profile] of bad) {
      const res = await call(cookies.admin, 'PUT', '/benefits/templates/staff', { profile, effectiveFrom: addDaysToIsoDate(today, 40) });
      expect(res.status, `${name}: ${res.raw}`).toBe(400);
      const asOverride = await call(cookies.admin, 'PUT', `/benefits/profiles/${people.lek}`, {
        benefitRole: 'manager',
        override: profile,
        effectiveFrom: addDaysToIsoDate(today, 40),
      });
      expect(asOverride.status, `${name} as an override: ${asOverride.raw}`).toBe(400);
    }
    expect((await templateRows('staff')).length).toBe(before);
    expect(await auditCount('benefit.template_update')).toBe(audits);
  });

  it('a role name the platform does not have is refused', async () => {
    expect((await call(cookies.admin, 'PUT', '/benefits/templates/boss', { profile: { comp: true } })).status).toBe(400);
    expect((await call(cookies.admin, 'GET', '/benefits/templates/boss')).status).toBe(400);
  });
});

describe('the staff list is read only', () => {
  it('after every save above, not one core.employee row has changed', async () => {
    const now = await ctx.db.select().from(employee).orderBy(employee.id);
    expect(now).toEqual(employeeSnapshot);
  });

  it('the database holds the rule the service relies on: one open-ended row per template and per live person', async () => {
    const code = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return null;
      } catch (err) {
        const e = err as { code?: string; cause?: { code?: string } };
        return e.code ?? e.cause?.code ?? 'unknown';
      }
    };
    expect(
      await code(() =>
        ctx.db.insert(benefitRoleTemplate).values({
          id: newId(),
          operatorId,
          role: 'owner',
          name: 'Owner',
          profile: { comp: true },
          effectiveFrom: addDaysToIsoDate(today, 400),
        }),
      ),
    ).toBe('23505');
    expect(
      await code(() =>
        ctx.db.insert(benefitProfile).values({
          id: newId(),
          operatorId,
          employeeId: people.som,
          benefitRole: 'staff',
          effectiveFrom: addDaysToIsoDate(today, 400),
        }),
      ),
    ).toBe('23505');
    // Nothing was left behind by the refusals.
    expect(
      await ctx.db
        .select({ id: benefitRoleTemplate.id })
        .from(benefitRoleTemplate)
        .where(and(eq(benefitRoleTemplate.operatorId, operatorId), gt(benefitRoleTemplate.effectiveFrom, addDaysToIsoDate(today, 300)))),
    ).toEqual([]);
    expect(
      await ctx.db
        .select({ id: benefitProfile.id })
        .from(benefitProfile)
        .where(and(inArray(benefitProfile.employeeId, [people.som]), gt(benefitProfile.effectiveFrom, addDaysToIsoDate(today, 300)))),
    ).toEqual([]);
  });
});
