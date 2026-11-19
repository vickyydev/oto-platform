import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  branch,
  child,
  family,
  FAMILY_PROFILES_KEY,
  familyGuardian,
  featureFlag,
  flagCatalogueEntry,
  member,
  memberAlias,
  sale,
  station,
  ticketPackage,
} from '@oto/db';
import { newId } from '@oto/shared';
import { checkBookingFamilyLinks } from '../src/services/family-online';
import {
  childOfMember,
  childrenSeenBy,
  familyChildrenOfMembers,
  familyProfilesMode,
  memberSeesChild,
  type FamilyProfilesMode,
} from '../src/services/family';
import { salePrintSnapshotOf } from '../src/services/sale-printing';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_NAME,
  createTestContext,
  lastCode,
  operatorIdByName,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-1024 — family profiles, plan step F3: every reader of "a member's
 * children" on the platform reads through the family when the switch
 * `crm.family_profiles` is `read`, and exactly as before when it is `off`
 * (`docs/progress/plans/dropoff-beo-20261119/FAMILY_PROFILES_PLAN.md` §1.2,
 * §3 R1, §8).
 *
 * Three things are pinned here:
 *   1. EQUIVALENCE. While every family has the one guardian its first child
 *      was saved under (what the writers and the backfill make), every reader
 *      answers the same at `read` as at `off`: the same children, in the same
 *      order, with the same fields — for members with no child, several
 *      children, removed children, an archived member, a merged member's
 *      alias id and another park group's member.
 *   2. THE FENCE. At `read` a child reaches only a live guardian of its live
 *      family, inside the caller's park group: never another park group's
 *      member, never through a guardian row taken off the family, never
 *      through an archived member on the readers that serve live members,
 *      never through an alias. A hand-made second guardian row (the shape
 *      plan step F4 will write) sees exactly that family's children besides
 *      their own, and nothing else.
 *   3. THE SWITCH. `off` and `read` are set for a park group through the
 *      Console's switch route, with its permission and audit; `on` is refused.
 *
 * The whole api suite runs unchanged at `off` (the default); the readers'
 * suites are run again at `read` with OTO_TEST_FAMILY_PROFILES=read.
 */

let ctx: TestContext;
let reception: string;
let displayTill: string;
let admin: string;
let otoId: string;
let secondId: string;
let branchId: string;
let stationId: string;
let packageId: string;

/** The fixture of the equivalence: made once, at `off`, through the till's own routes. */
const fx = {
  none: { memberId: '', phone: '' },
  many: { memberId: '', phone: '', childIds: [] as string[] },
  gone: { memberId: '', phone: '', childIds: [] as string[] },
  aliasId: '',
  foreign: { memberId: '', phone: '', childIds: [] as string[] },
  seeded: [] as Array<{ memberId: string; phone: string }>,
};

let phoneSeq = 0;
/** A ZZ TEST number nothing else in this file has taken (Thai mobile, test range). */
const nextPhone = (): string => `06510241${String((phoneSeq += 1)).padStart(2, '0')}`;

let caller = 0;
const address = (): string => {
  caller += 1;
  return `10.224.${Math.floor(caller / 250)}.${(caller % 250) + 1}`;
};

type Res = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- answers are compared whole
async function call(cookie: string | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: unknown): Promise<Res> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as never }),
    headers: { ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) },
    remoteAddress: address(),
  });
  let body: unknown = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body };
}

async function newMember(nickname: string, kids: Array<Record<string, unknown>> = []) {
  const phone = nextPhone();
  const made = await call(reception, 'POST', '/members', { phone, nickname });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const memberId = made.body.member.id as string;
  const childIds: string[] = [];
  for (const kid of kids) {
    const added = await call(reception, 'POST', `/members/${memberId}/children`, kid);
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    childIds.push(added.body.child.id as string);
  }
  return { memberId, phone, childIds };
}

/** The switch for a park group, written straight to its row (the Console route is pinned on its own below). */
async function setMode(operatorId: string, mode: FamilyProfilesMode): Promise<void> {
  await ctx.db.delete(featureFlag).where(and(eq(featureFlag.key, FAMILY_PROFILES_KEY), eq(featureFlag.scopeId, operatorId)));
  if (mode === 'off') return;
  await ctx.db.insert(featureFlag).values({
    id: newId(), key: FAMILY_PROFILES_KEY, kind: 'feature', targetApp: 'pos', scopeType: 'operator', scopeId: operatorId,
    operatorId, value: mode, defaultValue: 'off', reason: 'ZZ TEST 1024 readers',
  });
}

/** One reader run at `off`, then at `read` (both park groups), and the switch left at `off`. */
async function bothWays<T>(run: () => Promise<T>): Promise<{ off: T; read: T }> {
  await setMode(otoId, 'off');
  await setMode(secondId, 'off');
  const off = await run();
  await setMode(otoId, 'read');
  await setMode(secondId, 'read');
  try {
    expect(await familyProfilesMode(ctx.db, otoId)).toBe('read');
    return { off, read: await run() };
  } finally {
    await setMode(otoId, 'off');
    await setMode(secondId, 'off');
  }
}

/** A reader that writes, run on a fresh copy of its fixture at each setting, its answers made comparable by `same`. */
async function bothWaysFresh<F, T>(build: () => Promise<F>, act: (f: F) => Promise<T>): Promise<{ off: T; read: T }> {
  const offFixture = await build();
  const readFixture = await build();
  await setMode(otoId, 'off');
  const off = await act(offFixture);
  await setMode(otoId, 'read');
  try {
    return { off, read: await act(readFixture) };
  } finally {
    await setMode(otoId, 'off');
  }
}

/** An answer with the ids a fresh fixture mints, and times, put to one side. */
function same(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, v) =>
    ['id', 'requestId', 'lastConfirmedAt', 'visitDate', 'familyPassExpiresAt', 'familyPass'].includes(key) ? '<varies>' : v);
}

async function lookup(cookie: string, phone: string) {
  return call(cookie, 'GET', `/members/lookup?phone=${encodeURIComponent(phone)}`);
}

function childNames(res: Res): string[] {
  return ((res.body?.member?.children ?? []) as Array<{ name: string }>).map((c) => c.name).sort();
}

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  displayTill = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  otoId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  secondId = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  branchId = hkt!.id;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  await takeStation(ctx.app, displayTill, stationId);
  const [pkg] = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId)).limit(1);
  packageId = pkg!.id;

  fx.none = await newMember('ZZ TEST 1024R None');
  fx.many = await newMember('ZZ TEST 1024R Many', [
    { name: 'ZZ TEST 1024R Ann', ageYears: 6, allergies: 'ZZ TEST allergy', medicalNotes: 'ZZ TEST note' },
    { name: 'ZZ TEST 1024R Ben', dateOfBirth: '2019-04-01', dietary: 'ZZ TEST dietary' },
    { name: 'ZZ TEST 1024R Cal', ageYears: 3 },
  ]);
  expect((await call(reception, 'DELETE', `/members/children/${fx.many.childIds[2]}`)).status).toBe(200);
  fx.gone = await newMember('ZZ TEST 1024R Gone', [{ name: 'ZZ TEST 1024R Dee', ageYears: 5 }]);
  expect((await call(reception, 'DELETE', `/members/${fx.gone.memberId}`)).status).toBe(200);
  fx.aliasId = newId();
  await ctx.db.insert(memberAlias).values({ aliasMemberId: fx.aliasId, operatorId: otoId, memberId: fx.many.memberId });
  // The other park group's seeded member with a child.
  const [foreignKid] = await ctx.db
    .select({ childId: child.id, memberId: member.id, phone: member.phone })
    .from(child)
    .innerJoin(member, eq(member.id, child.memberId))
    .where(eq(member.operatorId, secondId))
    .limit(1);
  fx.foreign = { memberId: foreignKid!.memberId, phone: foreignKid!.phone, childIds: [foreignKid!.childId] };
  fx.seeded = await ctx.db
    .selectDistinct({ memberId: member.id, phone: member.phone })
    .from(member)
    .innerJoin(child, eq(child.memberId, member.id))
    .where(eq(member.operatorId, otoId));
  expect(fx.seeded.length).toBeGreaterThan(1);
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- 1. Equivalence -----------------------------------------------------------------------

describe('SCRUM-1024 F3 — every reader answers the same at off and at read while each family has one guardian', () => {
  it('the counter lookup and the member page: whole answers, children in the same order, for every kind of member', async () => {
    const phones = [fx.none.phone, fx.many.phone, fx.gone.phone, fx.foreign.phone, ...fx.seeded.map((s) => s.phone)];
    const ids = [fx.none.memberId, fx.many.memberId, fx.gone.memberId, fx.aliasId, fx.foreign.memberId, newId(),
      ...fx.seeded.map((s) => s.memberId)];
    const { off, read } = await bothWays(async () => ({
      lookups: await Promise.all(phones.map((p) => lookup(reception, p))),
      pages: await Promise.all(ids.map((id) => call(reception, 'GET', `/members/${id}`))),
    }));
    expect(read).toEqual(off);
    // The fixture is what it says: several children with one removed, none, an archived member, an alias, another park group.
    expect(childNames(off.lookups[1]!)).toEqual(['ZZ TEST 1024R Ann', 'ZZ TEST 1024R Ben']);
    expect(off.lookups[1]!.body.member.children[0]).toMatchObject({ allergies: 'ZZ TEST allergy', medicalNotes: 'ZZ TEST note' });
    expect(off.lookups[0]!.body.member.children).toEqual([]);
    expect(off.lookups[2]!.body).toEqual({ member: null });
    expect(off.lookups[3]!.body).toEqual({ member: null });
    expect(off.pages.slice(2, 6).map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect(off.lookups.slice(4).some((r) => r.body.member.children.length > 1)).toBe(true);
  });

  it('the Console register: the whole page, searched and not, every row its children by name', async () => {
    const { off, read } = await bothWays(async () => [
      await call(admin, 'GET', '/members?q=ZZ%20TEST%201024R&limit=50'),
      await call(admin, 'GET', '/members?limit=200'),
      await call(admin, 'GET', '/members?limit=3&offset=2'),
    ]);
    expect(read).toEqual(off);
    expect(off[0]!.status).toBe(200);
    const many = (off[0]!.body.members as Array<{ id: string; children: Array<{ name: string }> }>).find((r) => r.id === fx.many.memberId);
    expect(many!.children.map((c) => c.name)).toEqual(['ZZ TEST 1024R Ann', 'ZZ TEST 1024R Ben']);
  });

  it('the condition itself, for every member of the park group: by id, and by the column the Inbox count correlates on', async () => {
    const members = await ctx.db.select({ id: member.id, archivedAt: member.archivedAt }).from(member).where(eq(member.operatorId, otoId));
    const read = async (mode: FamilyProfilesMode, memberId: string, memberLive: boolean) =>
      (await ctx.db.select({ id: child.id }).from(child)
        .where(childOfMember(mode, { operatorId: otoId, memberId, memberLive })).orderBy(asc(child.id))).map((r) => r.id);
    for (const m of [...members, { id: fx.aliasId, archivedAt: null }]) {
      // Readers that never ask the member's state.
      expect(await read('read', m.id, false), m.id).toEqual(await read('off', m.id, false));
      // Readers that serve live members only have found the member live first.
      if (!m.archivedAt) expect(await read('read', m.id, true), m.id).toEqual(await read('off', m.id, true));
    }
    const counts = async (mode: FamilyProfilesMode) => ctx.db
      .select({
        id: member.id,
        n: sql<number>`(select count(*)::int from ${child} where ${childOfMember(mode, { operatorId: otoId, memberId: member.id, memberLive: false })} and ${child.archivedAt} is null)`,
      })
      .from(member)
      .where(eq(member.operatorId, otoId))
      .orderBy(asc(member.id));
    expect(await counts('read')).toEqual(await counts('off'));
  });

  it('opening a visit and adding children to it: the same acceptances and the same refusals', async () => {
    const build = async () => {
      const own = await newMember('ZZ TEST 1024R Visit', [{ name: 'ZZ TEST 1024R Eve', ageYears: 7 }, { name: 'ZZ TEST 1024R Fay', ageYears: 4 }]);
      await call(reception, 'DELETE', `/members/children/${own.childIds[1]}`);
      const other = await newMember('ZZ TEST 1024R Other', [{ name: 'ZZ TEST 1024R Gus', ageYears: 8 }]);
      return { own, other };
    };
    const { off, read } = await bothWaysFresh(build, async ({ own, other }) => {
      const open = (childIds: string[]) => call(reception, 'POST', '/visits', { branchId, memberId: own.memberId, childIds });
      const opened = await open([own.childIds[0]!]);
      const add = (childIds: string[]) => call(reception, 'POST', `/visits/${opened.body.id}/children`, { childIds });
      return same([
        opened,
        await open([own.childIds[1]!]),
        await open([other.childIds[0]!]),
        await open([fx.foreign.childIds[0]!]),
        await add([own.childIds[0]!]),
        await add([own.childIds[1]!]),
        await add([other.childIds[0]!]),
        await add([fx.foreign.childIds[0]!]),
      ]);
    });
    expect(read).toEqual(off);
    expect((off as Res[]).map((r) => r.status)).toEqual([200, 400, 400, 400, 200, 400, 400, 400]);
  });

  it('a drop-off registration naming saved children: the same acceptance and the same refusal', async () => {
    const build = async () => ({
      own: await newMember('ZZ TEST 1024R Drop', [{ name: 'ZZ TEST 1024R Hal', ageYears: 6 }]),
      other: await newMember('ZZ TEST 1024R Drop Other', [{ name: 'ZZ TEST 1024R Ivy', ageYears: 6 }]),
    });
    const register = (memberId: string, childId: string) => call(reception, 'POST', '/checkin/registrations', {
      id: newId(), branchId, stationId, memberId, guardianName: 'ZZ TEST 1024R Guardian', guardianPhone: nextPhone(),
      contactChannel: 'whatsapp', consentAcknowledged: true,
      acknowledgedConfirmationIds: ['confirm-15min', 'confirm-no-refund', 'confirm-evac'],
      children: [{ checkinId: newId(), childId, name: 'ZZ TEST 1024R Child', ageYears: 6, service: 'drop_off', allergies: null,
        foodRestrictions: null, foodProvision: { mode: 'none', paidSatang: 0 } }],
    });
    const { off, read } = await bothWaysFresh(build, async ({ own, other }) => [
      await register(own.memberId, own.childIds[0]!),
      await register(own.memberId, other.childIds[0]!),
    ]);
    expect(off.map((r) => r.status)).toEqual([200, 400]);
    expect(read.map((r) => r.status)).toEqual(off.map((r) => r.status));
    expect(read[1]!.body).toEqual(off[1]!.body);
  });

  it("the owner checks of an edit, a care note from the paired display and a removal", async () => {
    const build = async () => {
      const own = await newMember('ZZ TEST 1024R Owner', [
        { name: 'ZZ TEST 1024R Jo', ageYears: 6 }, { name: 'ZZ TEST 1024R Kit', ageYears: 5 }, { name: 'ZZ TEST 1024R Lee', ageYears: 4 },
      ]);
      await call(reception, 'DELETE', `/members/children/${own.childIds[2]}`);
      const other = await newMember('ZZ TEST 1024R Owner Other');
      const archived = await newMember('ZZ TEST 1024R Owner Gone', [{ name: 'ZZ TEST 1024R Mo', ageYears: 6 }]);
      await call(reception, 'DELETE', `/members/${archived.memberId}`);
      return { own, other, archived };
    };
    const { off, read } = await bothWaysFresh(build, async ({ own, other, archived }) => same([
      await call(reception, 'PATCH', `/members/children/${own.childIds[0]}`, { allergies: 'ZZ TEST changed' }),
      await call(reception, 'PATCH', `/members/children/${own.childIds[2]}`, { notes: 'ZZ TEST' }),
      await call(reception, 'PATCH', `/members/children/${archived.childIds[0]}`, { notes: 'ZZ TEST' }),
      await call(reception, 'PATCH', `/members/children/${fx.foreign.childIds[0]}`, { notes: 'ZZ TEST' }),
      await call(displayTill, 'PATCH', `/members/children/${own.childIds[1]}`,
        { source: 'customer_display', memberId: own.memberId, allergies: 'ZZ TEST from the display' }),
      await call(displayTill, 'PATCH', `/members/children/${own.childIds[1]}`,
        { source: 'customer_display', memberId: other.memberId, allergies: 'ZZ TEST not theirs' }),
      await call(reception, 'DELETE', `/members/children/${own.childIds[0]}`),
      await call(reception, 'DELETE', `/members/children/${own.childIds[0]}`),
      await call(reception, 'DELETE', `/members/children/${archived.childIds[0]}`),
      await call(reception, 'DELETE', `/members/children/${fx.foreign.childIds[0]}`),
      await call(reception, 'DELETE', `/members/children/${newId()}`),
    ]));
    expect(read).toEqual(off);
    expect((off as Res[]).map((r) => r.status)).toEqual([200, 404, 404, 404, 200, 404, 200, 200, 200, 404, 404]);
    expect((off as Res[])[7]!.body).toEqual({ ok: true, alreadyArchived: true });
  });

  it("the booking site: the code check's children, the family's save and its refusals, and the booking's saved-child check", async () => {
    const build = async () => ({
      own: await newMember('ZZ TEST 1024R Online', [
        { name: 'ZZ TEST 1024R Ned', ageYears: 6, allergies: 'ZZ TEST allergy' }, { name: 'ZZ TEST 1024R Oz', ageYears: 4 },
      ]),
      other: await newMember('ZZ TEST 1024R Online Other', [{ name: 'ZZ TEST 1024R Pip', ageYears: 5 }]),
    });
    const { off, read } = await bothWaysFresh(build, async ({ own, other }) => {
      const sent = await call(null, 'POST', '/public/saved-children/code', { phone: own.phone, branch: CENTRAL_BRANCH_CODE });
      const verified = await call(null, 'POST', '/public/saved-children/verify',
        { phone: own.phone, branch: CENTRAL_BRANCH_CODE, code: lastCode(ctx.smsLog) });
      const pass = verified.body.familyPass as string;
      const save = (payload: Record<string, unknown>) =>
        call(null, 'POST', '/public/saved-children/save', { branch: CENTRAL_BRANCH_CODE, phone: own.phone, pass, children: [], ...payload });
      const links = async (ids: string[]) => {
        try {
          const { checkedMemberId } = await checkBookingFamilyLinks(ctx.db, { operatorId: otoId, phone: `+66${own.phone.slice(1)}`, pass, savedChildIds: ids });
          return { checked: checkedMemberId === own.memberId };
        } catch (err) {
          return { refused: (err as { code?: string }).code };
        }
      };
      return same([
        sent.status,
        verified,
        await links([own.childIds[0]!]),
        await links([other.childIds[0]!]),
        await save({ children: [{ savedChildId: own.childIds[0], name: 'ZZ TEST 1024R Ned', ageYears: 6, allergies: 'ZZ TEST changed online' }] }),
        await save({ children: [{ savedChildId: other.childIds[0], name: 'ZZ TEST 1024R Pip', ageYears: 5 }] }),
        await save({ remove: [other.childIds[0]] }),
        await save({ remove: [own.childIds[1]] }),
      ]);
    });
    expect(read).toEqual(off);
    const [status, verified, ownLink, otherLink, changed, notTheirs, removeOther, removed] = off as [number, Res, ...unknown[]];
    expect(status).toBe(200);
    expect((verified.body.children as Array<{ name: string }>).map((c) => c.name)).toEqual(['ZZ TEST 1024R Ned', 'ZZ TEST 1024R Oz']);
    expect(ownLink).toEqual({ checked: true });
    expect(otherLink).toHaveProperty('refused');
    expect([changed, notTheirs, removeOther, removed].map((r) => (r as Res).status)).toEqual([200, 400, 400, 200]);
  });

  it("the kitchen slip of a sale with no visit: the member's children, for every kind of member", async () => {
    const saleId = newId();
    const made = await call(displayTill, 'POST', '/sales', { id: saleId, stationId, lines: [{ id: newId(), packageId, kids: 0, adults: 1 }] });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const slips = async () => Promise.all(
      [fx.none.memberId, fx.many.memberId, fx.gone.memberId, fx.aliasId, ...fx.seeded.map((s) => s.memberId)].map(async (memberId) =>
        (await salePrintSnapshotOf(ctx.db, { ...row!, memberId, visitId: null })).orderChildren),
    );
    const { off, read } = await bothWays(slips);
    expect(read).toEqual(off);
    expect(off[1]!.map((c) => c.name)).toEqual(['ZZ TEST 1024R Ann', 'ZZ TEST 1024R Ben']);
    // An archived member's old sale keeps its allergy line at both settings, as it always did.
    expect(off[2]!.map((c) => c.name)).toEqual(['ZZ TEST 1024R Dee']);
  });
});

// --- 2. The fence -------------------------------------------------------------------------

describe('SCRUM-1024 F3 — at read, a child reaches only a live guardian of its live family, inside the park group', () => {
  async function familyOf(childId: string): Promise<string> {
    const [row] = await ctx.db.select({ familyId: child.familyId }).from(child).where(eq(child.id, childId));
    return row!.familyId!;
  }
  async function addGuardian(familyId: string, memberId: string, operatorId = otoId): Promise<string> {
    const id = newId();
    await ctx.db.insert(familyGuardian).values({ id, operatorId, familyId, memberId, source: 'link' });
    return id;
  }

  it('a hand-made second guardian sees exactly that family\'s live children besides their own, and nothing else, on every reader', async () => {
    const first = await newMember('ZZ TEST 1024R First', [{ name: 'ZZ TEST 1024R Quin', ageYears: 6 }, { name: 'ZZ TEST 1024R Rae', ageYears: 4 }]);
    await call(reception, 'DELETE', `/members/children/${first.childIds[1]}`);
    const second = await newMember('ZZ TEST 1024R Second', [{ name: 'ZZ TEST 1024R Sam', ageYears: 5 }]);
    const bystander = await newMember('ZZ TEST 1024R Bystander', [{ name: 'ZZ TEST 1024R Tia', ageYears: 7 }]);
    await addGuardian(await familyOf(first.childIds[0]!), second.memberId);

    await setMode(otoId, 'read');
    try {
      expect(childNames(await lookup(reception, second.phone))).toEqual(['ZZ TEST 1024R Quin', 'ZZ TEST 1024R Sam']);
      expect(childNames(await call(reception, 'GET', `/members/${second.memberId}`))).toEqual(['ZZ TEST 1024R Quin', 'ZZ TEST 1024R Sam']);
      // The first parent does not gain the second parent's own family, and a bystander gains nothing.
      expect(childNames(await lookup(reception, first.phone))).toEqual(['ZZ TEST 1024R Quin']);
      expect(childNames(await lookup(reception, bystander.phone))).toEqual(['ZZ TEST 1024R Tia']);
      const register = await call(admin, 'GET', '/members?q=ZZ%20TEST%201024R&limit=100');
      const rowOf = (id: string) => (register.body.members as Array<{ id: string; childCount: number; children: Array<{ name: string }> }>)
        .find((r) => r.id === id)!;
      expect(rowOf(second.memberId).children.map((c) => c.name)).toEqual(['ZZ TEST 1024R Quin', 'ZZ TEST 1024R Sam']);
      expect(rowOf(first.memberId).children.map((c) => c.name)).toEqual(['ZZ TEST 1024R Quin']);
      expect((await childrenSeenBy(ctx.db, { operatorId: otoId, memberId: second.memberId })).map((c) => c.name).sort())
        .toEqual(['ZZ TEST 1024R Quin', 'ZZ TEST 1024R Sam']);
      // A visit: the second parent may bring the family's child; the first may not bring the second's own.
      expect((await call(reception, 'POST', '/visits', { branchId, memberId: second.memberId, childIds: [first.childIds[0]] })).status).toBe(200);
      expect((await call(reception, 'POST', '/visits', { branchId, memberId: first.memberId, childIds: [second.childIds[0]] })).status).toBe(400);
      expect((await call(reception, 'POST', '/visits', { branchId, memberId: second.memberId, childIds: [bystander.childIds[0]] })).status).toBe(400);
      // A care note from the paired display, naming the second parent, reaches the family's child; never the bystander's.
      expect((await call(displayTill, 'PATCH', `/members/children/${first.childIds[0]}`,
        { source: 'customer_display', memberId: second.memberId, allergies: 'ZZ TEST from the second parent' })).status).toBe(200);
      expect((await call(displayTill, 'PATCH', `/members/children/${bystander.childIds[0]}`,
        { source: 'customer_display', memberId: second.memberId, allergies: 'ZZ TEST not theirs' })).status).toBe(404);
      // The removed child stays removed for both.
      expect(await memberSeesChild(ctx.db, { operatorId: otoId, memberId: second.memberId, childId: first.childIds[1]! })).toBe(false);
    } finally {
      await setMode(otoId, 'off');
    }
    // At off nothing of this is read: each parent finds the children first saved under them, as today.
    expect(childNames(await lookup(reception, second.phone))).toEqual(['ZZ TEST 1024R Sam']);
    expect(childNames(await lookup(reception, first.phone))).toEqual(['ZZ TEST 1024R Quin']);
  });

  it('a guardian row taken off the family sees nothing of it; an archived family is seen by nobody', async () => {
    const first = await newMember('ZZ TEST 1024R Removed First', [{ name: 'ZZ TEST 1024R Uma', ageYears: 6 }]);
    const second = await newMember('ZZ TEST 1024R Removed Second', [{ name: 'ZZ TEST 1024R Vic', ageYears: 5 }]);
    const familyId = await familyOf(first.childIds[0]!);
    const rowId = await addGuardian(familyId, second.memberId);
    await ctx.db.update(familyGuardian).set({ archivedAt: new Date() }).where(eq(familyGuardian.id, rowId));
    await setMode(otoId, 'read');
    try {
      expect(childNames(await lookup(reception, second.phone))).toEqual(['ZZ TEST 1024R Vic']);
      expect((await call(reception, 'POST', '/visits', { branchId, memberId: second.memberId, childIds: [first.childIds[0]] })).status).toBe(400);
      // The first parent's own row taken off too: the child has no live guardian, so no edit or removal reaches it.
      await ctx.db.update(familyGuardian).set({ archivedAt: new Date() })
        .where(and(eq(familyGuardian.familyId, familyId), eq(familyGuardian.memberId, first.memberId)));
      expect(childNames(await lookup(reception, first.phone))).toEqual([]);
      expect((await call(reception, 'PATCH', `/members/children/${first.childIds[0]}`, { notes: 'ZZ TEST' })).status).toBe(404);
      expect((await call(reception, 'DELETE', `/members/children/${first.childIds[0]}`)).status).toBe(404);
      // An archived family: the second parent's own, with its live guardian row still on it.
      await ctx.db.update(family).set({ archivedAt: new Date() }).where(eq(family.id, await familyOf(second.childIds[0]!)));
      expect(childNames(await lookup(reception, second.phone))).toEqual([]);
    } finally {
      await setMode(otoId, 'off');
    }
  });

  it("another park group's member never sees this park group's children, even through a guardian row naming them", async () => {
    const own = await newMember('ZZ TEST 1024R Fenced', [{ name: 'ZZ TEST 1024R Wes', ageYears: 6 }]);
    const familyId = await familyOf(own.childIds[0]!);
    // A row in this park group's family naming the other park group's member (no writer makes one).
    await addGuardian(familyId, fx.foreign.memberId);
    await setMode(otoId, 'read');
    await setMode(secondId, 'read');
    try {
      for (const operatorId of [otoId, secondId]) {
        const seen = await ctx.db.select({ id: child.id }).from(child)
          .where(childOfMember('read', { operatorId, memberId: fx.foreign.memberId, memberLive: false }));
        expect(seen.map((r) => r.id)).not.toContain(own.childIds[0]);
        expect(await familyChildrenOfMembers(ctx.db, { operatorId, memberIds: [fx.foreign.memberId], memberLive: false }))
          .not.toContainEqual(expect.objectContaining({ childId: own.childIds[0] }));
      }
      // And this park group's staff reach nothing of the other's.
      expect((await lookup(reception, fx.foreign.phone)).body).toEqual({ member: null });
      expect((await call(reception, 'GET', `/members/${fx.foreign.memberId}`)).status).toBe(404);
      expect((await call(reception, 'PATCH', `/members/children/${fx.foreign.childIds[0]}`, { notes: 'ZZ TEST' })).status).toBe(404);
      expect((await call(reception, 'DELETE', `/members/children/${fx.foreign.childIds[0]}`)).status).toBe(404);
      expect(await memberSeesChild(ctx.db, { operatorId: otoId, memberId: own.memberId, childId: fx.foreign.childIds[0]! })).toBe(false);
    } finally {
      await setMode(otoId, 'off');
      await setMode(secondId, 'off');
    }
  });

  it('an archived member and a merged member\'s alias see nothing on the readers that serve a member', async () => {
    const gone = await newMember('ZZ TEST 1024R Archived Guardian', [{ name: 'ZZ TEST 1024R Xan', ageYears: 6 }]);
    await call(reception, 'DELETE', `/members/${gone.memberId}`);
    await setMode(otoId, 'read');
    try {
      expect((await lookup(reception, gone.phone)).body).toEqual({ member: null });
      expect((await call(reception, 'GET', `/members/${gone.memberId}`)).status).toBe(404);
      expect(await childrenSeenBy(ctx.db, { operatorId: otoId, memberId: gone.memberId })).toEqual([]);
      expect(await familyChildrenOfMembers(ctx.db, { operatorId: otoId, memberIds: [gone.memberId], memberLive: true })).toEqual([]);
      expect((await call(reception, 'GET', `/members/${fx.aliasId}`)).status).toBe(404);
      expect(await childrenSeenBy(ctx.db, { operatorId: otoId, memberId: fx.aliasId })).toEqual([]);
      expect(await familyChildrenOfMembers(ctx.db, { operatorId: otoId, memberIds: [fx.aliasId], memberLive: false })).toEqual([]);
    } finally {
      await setMode(otoId, 'off');
    }
  });

  it('a child saved before families and not yet backfilled is seen by nobody at read: why the checks must be zero first', async () => {
    const own = await newMember('ZZ TEST 1024R Unfilled', [{ name: 'ZZ TEST 1024R Yul', ageYears: 6 }]);
    const loose = newId();
    await ctx.db.insert(child).values({ id: loose, memberId: own.memberId, name: 'ZZ TEST 1024R Zed', ageYears: 4 });
    expect(childNames(await lookup(reception, own.phone))).toEqual(['ZZ TEST 1024R Yul', 'ZZ TEST 1024R Zed']);
    await setMode(otoId, 'read');
    try {
      expect(childNames(await lookup(reception, own.phone))).toEqual(['ZZ TEST 1024R Yul']);
    } finally {
      await setMode(otoId, 'off');
    }
  });
});

// --- 3. The switch --------------------------------------------------------------------------

describe('SCRUM-1024 F3 — the switch is set to read for a park group through the Console route; on is refused', () => {
  it('is catalogued as supported, read the only value a write may set, off the default', () => {
    expect(flagCatalogueEntry(FAMILY_PROFILES_KEY)).toMatchObject({
      kind: 'feature', valueType: 'enum', values: ['off', 'read', 'on'], defaultValue: 'off', scopes: ['operator'],
      supported: true, settableValues: ['read'],
    });
  });

  it('read is set and cleared with the platform administrator\'s permission and an audit row; on and other scopes are refused', async () => {
    const body = (value: string, scopeType = 'operator', scopeId: string = otoId) => ({
      key: FAMILY_PROFILES_KEY, scopeType, scopeId, operatorId: otoId, value, reason: 'ZZ TEST 1024 readers', expectedRevision: 0,
      expiresAt: null, confirmation: FAMILY_PROFILES_KEY,
    });
    const preview = (value: string) => call(admin, 'GET',
      `/console/flags/preview?key=${FAMILY_PROFILES_KEY}&scopeType=operator&scopeId=${otoId}&operatorId=${otoId}&value=${value}`);
    expect((await preview('on')).body.error.code).toBe('FLAG_VALUE_UNSUPPORTED');
    expect((await preview('read')).status).toBe(200);
    expect((await call(admin, 'PUT', '/console/flags', body('on'))).body.error.code).toBe('FLAG_VALUE_UNSUPPORTED');
    expect((await call(admin, 'PUT', '/console/flags', body('off'))).body.error.code).toBe('FLAG_VALUE_INVALID');
    expect((await call(admin, 'PUT', '/console/flags', body('read', 'branch', branchId))).body.error.code).toBe('FLAG_SCOPE_NOT_ALLOWED');
    expect((await call(reception, 'PUT', '/console/flags', body('read'))).status).toBe(403);
    expect(await familyProfilesMode(ctx.db, otoId)).toBe('off');

    const set = await call(admin, 'PUT', '/console/flags', body('read'));
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(await familyProfilesMode(ctx.db, otoId)).toBe('read');
    expect(await familyProfilesMode(ctx.db, secondId)).toBe('off');
    const [setAudit] = await ctx.db.select().from(auditLog)
      .where(and(eq(auditLog.action, 'feature_flag.set'), eq(auditLog.entityId, set.body.flag.id as string)));
    expect(setAudit).toMatchObject({ operatorId: otoId, actorAccountId: expect.any(String) });
    expect(childNames(await lookup(reception, fx.many.phone))).toEqual(['ZZ TEST 1024R Ann', 'ZZ TEST 1024R Ben']);

    const cleared = await call(admin, 'POST', '/console/flags/clear', {
      key: FAMILY_PROFILES_KEY, scopeType: 'operator', scopeId: otoId, operatorId: otoId,
      expectedRevision: set.body.flag.revision, reason: 'ZZ TEST 1024 readers', confirmation: FAMILY_PROFILES_KEY,
    });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(await familyProfilesMode(ctx.db, otoId)).toBe('off');
    expect(await ctx.db.select().from(auditLog)
      .where(and(eq(auditLog.action, 'feature_flag.clear'), inArray(auditLog.entityId, [set.body.flag.id as string])))).toHaveLength(1);
  });
});
