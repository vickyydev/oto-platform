import { createHash, generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  box,
  child,
  family,
  FAMILY_PROFILES_KEY,
  familyGuardian,
  featureFlag,
  member,
  memberAlias,
  registration,
  station,
  syncQuarantine,
  visitChild,
} from '@oto/db';
import { boxCredential, type BoxAgent, type BridgeTillCaller } from '@oto/box-agent';
import { SYNC_EVENT_SCHEMA_VERSION, canonicalSyncBytes, newId, type SyncEventEnvelope } from '@oto/shared';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { childrenByMemberThroughFamilies, familyProfilesMode, type FamilyProfilesMode } from '../src/services/family';
import { linkedAgent, type CuttableLink } from './box-link';
import {
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_NAME,
  boxBySlot,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-1024 — family profiles, plan step F3, the counter box's side
 * (`docs/progress/plans/dropoff-beo-20261119/FAMILY_PROFILES_PLAN.md` §1.2
 * "Box: server side", §7 and §8).
 *
 * The box's readers of "a member's children" on the server: the bundle a box
 * pulls (the `members` scope: each member's children nested under it), and
 * the facts a box replays that name a member and a child — `child.created`'s
 * sibling check, `child.updated`'s owner check, `visit.created`,
 * `visit.children_added` and the registration (`checkin.created`). Each reads
 * the switch once per bundle or per batch.
 *
 * Pinned here:
 *   1. EQUIVALENCE. While every family has the one guardian its first child
 *      was saved under, the bundle is the same document at `off` and at
 *      `read` (same members, same children in the same order, same fields,
 *      same version), and every fact is applied or refused exactly the same.
 *   2. THE PLAN'S BOX TEST. An offline visit filed under a SECOND guardian's
 *      member id (a hand-made guardian row, the shape step F4 will write) for
 *      the family's child is refused at `off`, exactly as today — the child
 *      was first saved under the other parent, and `off` does not read the
 *      family, so it is "not on this member's saved list" (`apply_failed`,
 *      kept in the Failures list for a replay) — and taken at `read`. The
 *      same for a visit's added children and a registration. Driven once with
 *      raw facts and once with the counter box's own code (`createBoxAgent`,
 *      unchanged by this step) over a link that is cut.
 *   3. THE FENCE. At `read` a box's bundle and facts reach a child only
 *      through a live guardian row on its live family inside the box's park
 *      group: never through a row taken off, an archived family, another park
 *      group's member, or an alias id.
 */

const pair = generateKeyPairSync('ed25519');
const STAFF_KEY = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let ctx: TestContext;
let reception: string;
let otoId: string;
let secondId: string;
/** The other park group's seeded member with a child. */
const foreign = { memberId: '', childId: '' };

let phoneSeq = 0;
/** A ZZ TEST number nothing else in this file has taken (Thai mobile, test range). */
const nextPhone = (): string => `06510242${String((phoneSeq += 1)).padStart(2, '0')}`;
const e164 = (local: string): string => `+66${local.slice(1)}`;

let caller = 0;
const address = (): string => {
  caller += 1;
  return `10.242.${Math.floor(caller / 250)}.${(caller % 250) + 1}`;
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

interface Family { memberId: string; phone: string; childIds: string[] }

/** A member and their children through the till's own routes (so each has its family, as the writers make it). */
async function newMember(nickname: string, kids: string[] = [], removed: number[] = []): Promise<Family> {
  const phone = nextPhone();
  const made = await call(reception, 'POST', '/members', { phone, nickname });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const memberId = made.body.member.id as string;
  const childIds: string[] = [];
  for (const [i, name] of kids.entries()) {
    const added = await call(reception, 'POST', `/members/${memberId}/children`, { name, ageYears: 4 + i, allergies: i === 0 ? 'ZZ TEST allergy' : null });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    childIds.push(added.body.child.id as string);
  }
  for (const i of removed) expect((await call(reception, 'DELETE', `/members/children/${childIds[i]}`)).status).toBe(200);
  return { memberId, phone, childIds };
}

async function familyOf(childId: string): Promise<string> {
  const [row] = await ctx.db.select({ familyId: child.familyId }).from(child).where(eq(child.id, childId));
  return row!.familyId!;
}

/** A guardian row no writer makes before step F4: `memberId` added to the family of `childId`. */
async function addGuardian(childId: string, memberId: string, operatorId = otoId): Promise<string> {
  const id = newId();
  await ctx.db.insert(familyGuardian).values({ id, operatorId, familyId: await familyOf(childId), memberId, source: 'link' });
  return id;
}

/** The switch for a park group, written straight to its row (the Console route is pinned in s1024-family-readers). */
async function setMode(operatorId: string, mode: FamilyProfilesMode): Promise<void> {
  await ctx.db.delete(featureFlag).where(and(eq(featureFlag.key, FAMILY_PROFILES_KEY), eq(featureFlag.scopeId, operatorId)));
  if (mode === 'off') return;
  await ctx.db.insert(featureFlag).values({
    id: newId(), key: FAMILY_PROFILES_KEY, kind: 'feature', targetApp: 'pos', scopeType: 'operator', scopeId: operatorId,
    operatorId, value: mode, defaultValue: 'off', reason: 'ZZ TEST 1024 box',
  });
}

async function setBoth(mode: FamilyProfilesMode): Promise<void> {
  await setMode(otoId, mode);
  await setMode(secondId, mode);
}

/** One reader run at `off`, then at `read`, and the switch left at `off`. */
async function bothWays<T>(run: () => Promise<T>): Promise<{ off: T; read: T }> {
  await setBoth('off');
  const off = await run();
  await setBoth('read');
  try {
    expect(await familyProfilesMode(ctx.db, otoId)).toBe('read');
    return { off, read: await run() };
  } finally {
    await setBoth('off');
  }
}

/** A reader that writes, run on a fresh copy of its fixture at each setting. */
async function bothWaysFresh<F, T>(build: () => Promise<F>, act: (f: F) => Promise<T>): Promise<{ off: T; read: T }> {
  const offFixture = await build();
  const readFixture = await build();
  await setBoth('off');
  const off = await act(offFixture);
  await setBoth('read');
  try {
    return { off, read: await act(readFixture) };
  } finally {
    await setBoth('off');
  }
}

// --- A box that files raw facts ------------------------------------------------------

interface TestBox {
  boxId: string;
  credential: string;
  privateKey: KeyObject;
  nextSeq: number;
}

let slotCounter = 0;
/** A box of the main park group, registered and keyed: what a counter box is to the sync routes. */
async function freshBox(): Promise<TestBox> {
  const seeded = await boxBySlot(ctx.db, 'virtual-1');
  const slot = `test-1024-box-${(slotCounter += 1)}`;
  await ctx.db.insert(box).values({
    id: newId(), operatorId: seeded.operatorId, branchId: seeded.branchId, name: `ZZ TEST 1024 box ${slotCounter}`,
    slot, role: 'virtual', status: 'unclaimed',
  });
  const row = await boxBySlot(ctx.db, slot);
  const { code: claimCode } = await issueClaimCode(ctx.db, row.id);
  const res = await ctx.app.inject({
    method: 'POST', url: '/box/v1/register', payload: { claimCode, agentVersion: '0.1.0', hostname: `test-${slot}` },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { boxId: string; secret: string };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const b: TestBox = { boxId: body.boxId, credential: boxCredential(body.boxId, body.secret), privateKey, nextSeq: 1 };
  const key = await ctx.app.inject({
    method: 'POST', url: '/box/v1/sync/key', headers: { authorization: `Bearer ${b.credential}` },
    payload: { publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString() },
  });
  expect(key.statusCode).toBe(200);
  return b;
}

const sha256 = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

function mint(b: TestBox, type: string, payload: Record<string, unknown>): SyncEventEnvelope {
  const base = {
    eventId: newId(), journalEpoch: 1, boxSeq: b.nextSeq++, type, schemaVersion: SYNC_EVENT_SCHEMA_VERSION,
    occurredAt: new Date().toISOString(), clockTrust: 'trusted' as const, stationId: null, actorKind: 'account' as const,
    actorAccountId: null, actorCredentialId: null, actionId: `act-${Math.random().toString(36).slice(2, 10)}`, payload,
  };
  const canonical = canonicalSyncBytes({ ...base, boxId: b.boxId });
  return {
    ...base,
    payloadHash: sha256(canonical),
    sig: signDetached(null, Buffer.from(canonical, 'utf8'), b.privateKey).toString('base64'),
    sigAlg: 'ed25519',
  } as SyncEventEnvelope;
}

/** One fact, pushed on its own: what the platform did with it. */
async function file(b: TestBox, type: string, payload: Record<string, unknown>) {
  const res = await ctx.app.inject({
    method: 'POST', url: '/box/v1/sync/push', headers: { authorization: `Bearer ${b.credential}` },
    payload: { events: [mint(b, type, payload)] },
  });
  expect(res.statusCode, res.body).toBe(200);
  const { results } = res.json() as { results: Array<{ result: string; reason?: string; errorCode?: string }> };
  return { result: results[0]!.result, reason: results[0]!.reason ?? null, errorCode: results[0]!.errorCode ?? null };
}

/** The `members` scope of a box's bundle, and its version, as a box pulls it. */
async function bundleOf(b: TestBox, query = '') {
  const res = await ctx.app.inject({
    method: 'GET', url: `/box/v1/cache?schemaVersion=1&scopes=members${query}`, headers: { authorization: `Bearer ${b.credential}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { schemaVersion: number; bundleVersion: string; scopes: Record<string, unknown>; truncated: string[] };
  return { schemaVersion: body.schemaVersion, bundleVersion: body.bundleVersion, scopes: body.scopes, truncated: body.truncated };
}

type BundleItem = { id: string; children: Array<{ id: string; memberId: string; name: string }> } & Record<string, unknown>;
function itemOf(bundle: Awaited<ReturnType<typeof bundleOf>>, memberId: string): BundleItem | undefined {
  return ((bundle.scopes.members as { items: BundleItem[] }).items).find((m) => m.id === memberId);
}

const today = (): string => new Date().toISOString().slice(0, 10);

function registrationFact(memberId: string | null, childId: string) {
  return {
    registrationId: newId(), memberId, guardianName: 'ZZ TEST 1024 Guardian', guardianPhone: null, contactChannel: 'whatsapp',
    consentRecordedAt: null, acknowledgedConfirmations: [],
    children: [{ checkinId: newId(), childId, name: 'ZZ TEST 1024 Child', ageYears: 6, service: 'drop_off' }],
  };
}

// --- The counter box's own code ------------------------------------------------------

const link: CuttableLink = { cut: false };
let agent: BoxAgent | null = null;
let counterId = '';
let counterToken = { token: '', jti: '' };

beforeAll(async () => {
  ctx = await createTestContext({ env: { STAFF_TOKEN_PRIVATE_KEY: STAFF_KEY } });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  otoId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  secondId = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  const [kid] = await ctx.db
    .select({ childId: child.id, memberId: member.id })
    .from(child)
    .innerJoin(member, eq(member.id, child.memberId))
    .where(eq(member.operatorId, secondId))
    .limit(1);
  foreign.memberId = kid!.memberId;
  foreign.childId = kid!.childId;

  // Counter 2, on its own box, as a Pi runs it.
  const box2 = await boxBySlot(ctx.db, 'virtual-2');
  const [counter] = await ctx.db.select().from(station).where(and(eq(station.boxId, box2.id), eq(station.name, 'Counter 2')));
  counterId = counter!.id;
  const counterCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const picked = await call(counterCookie, 'PUT', '/me/session/station', { stationId: counterId });
  expect(picked.status, JSON.stringify(picked.body)).toBe(200);
  counterToken = picked.body.staffToken as { token: string; jti: string };
  agent = linkedAgent(ctx, box2.id, 'counter-box-1024', link);
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  await agent.syncCache();
  attachInProcessBox(agent);
}, 180_000);

afterAll(async () => {
  if (agent) {
    agent.stop();
    detachInProcessBox(agent);
  }
  await ctx.close();
  await teardownAll();
});

// --- 1. Equivalence -----------------------------------------------------------------------

describe('SCRUM-1024 F3 — the box readers answer the same at off and at read while each family has one guardian', () => {
  it('the bundle: the same members scope, children in the same order with the same fields, the same version, paged too', async () => {
    const many = await newMember('ZZ TEST 1024B Many', ['ZZ TEST 1024B Ann', 'ZZ TEST 1024B Ben', 'ZZ TEST 1024B Cal'], [1]);
    const none = await newMember('ZZ TEST 1024B None');
    const gone = await newMember('ZZ TEST 1024B Gone', ['ZZ TEST 1024B Dee']);
    expect((await call(reception, 'DELETE', `/members/${gone.memberId}`)).status).toBe(200);
    const aliasId = newId();
    await ctx.db.insert(memberAlias).values({ aliasMemberId: aliasId, operatorId: otoId, memberId: many.memberId });
    const b = await freshBox();

    const { off, read } = await bothWays(async () => ({
      whole: await bundleOf(b),
      first: await bundleOf(b, '&limit=3'),
      next: await bundleOf(b, `&limit=3&cursor=${many.memberId}`),
    }));
    expect(read).toEqual(off);

    // The fixture is what it says.
    const whole = off.whole;
    expect(itemOf(whole, many.memberId)!.children.map((c) => c.name)).toEqual(['ZZ TEST 1024B Ann', 'ZZ TEST 1024B Cal']);
    expect(itemOf(whole, many.memberId)!.children[0]).toMatchObject({ memberId: many.memberId, allergies: 'ZZ TEST allergy' });
    expect(itemOf(whole, many.memberId)!.aliasIds).toEqual([aliasId]);
    expect(itemOf(whole, none.memberId)!.children).toEqual([]);
    expect(itemOf(whole, gone.memberId)).toBeUndefined();
    expect(itemOf(whole, foreign.memberId)).toBeUndefined();
    const items = (whole.scopes.members as { items: BundleItem[] }).items;
    expect(items.filter((m) => m.children.length > 1).length).toBeGreaterThan(1);
    // No family field anywhere in it.
    expect(JSON.stringify(whole)).not.toMatch(/family/i);
    expect(off.first.truncated).toEqual(['members']);
  });

  it('every fact a box replays that names a member and a child: the same applied and the same refused', async () => {
    const build = async () => {
      const own = await newMember('ZZ TEST 1024B Own', ['ZZ TEST 1024B Eve', 'ZZ TEST 1024B Fay'], [1]);
      const other = await newMember('ZZ TEST 1024B Other', ['ZZ TEST 1024B Gus']);
      const survivor = await newMember('ZZ TEST 1024B Survivor', ['ZZ TEST 1024B Hal']);
      const emptied = await newMember('ZZ TEST 1024B Emptied', ['ZZ TEST 1024B Ivy'], [0]);
      return { own, other, survivor, emptied, box: await freshBox() };
    };
    const { off, read } = await bothWaysFresh(build, async ({ own, other, survivor, emptied, box: b }) => {
      const [ownLive, ownRemoved] = own.childIds as [string, string];
      const aliasOne = newId();
      const aliasTwo = newId();
      const visitId = newId();
      const merged = [
        // A family signed up again at a counter, then a child under that id: merged onto the survivor,
        // and the survivor flagged when it already has a live child (OD-7) — and not when it has none.
        await file(b, 'member.created', { memberId: aliasOne, phone: e164(survivor.phone), nickname: 'ZZ TEST 1024B Again', createdVia: 'pos' }),
        await file(b, 'child.created', { childId: newId(), memberId: aliasOne, name: 'ZZ TEST 1024B Late' }),
        await file(b, 'member.created', { memberId: aliasTwo, phone: e164(emptied.phone), nickname: 'ZZ TEST 1024B Again', createdVia: 'pos' }),
        await file(b, 'child.created', { childId: newId(), memberId: aliasTwo, name: 'ZZ TEST 1024B Later' }),
      ];
      // Read now: the visit under the alias below confirms the survivor's children and clears the flag.
      const flags = await ctx.db
        .select({ id: member.id, flagged: member.childrenReviewSince })
        .from(member)
        .where(inArray(member.id, [survivor.memberId, emptied.memberId]));
      const outcomes = [
        ...merged,
        // An edit from the box: its own child, a removed one, another park group's, one never heard of.
        await file(b, 'child.updated', { childId: ownLive, allergies: 'ZZ TEST box edit' }),
        await file(b, 'child.updated', { childId: ownRemoved, notes: 'ZZ TEST box note' }),
        await file(b, 'child.updated', { childId: foreign.childId, notes: 'ZZ TEST box note' }),
        await file(b, 'child.updated', { childId: newId(), notes: 'ZZ TEST box note' }),
        // A visit: its own live child, a removed one, another member's, another park group's, no member, an alias.
        await file(b, 'visit.created', { visitId, memberId: own.memberId, visitDate: today(), childIds: [ownLive] }),
        await file(b, 'visit.created', { visitId: newId(), memberId: own.memberId, visitDate: today(), childIds: [ownRemoved] }),
        await file(b, 'visit.created', { visitId: newId(), memberId: own.memberId, visitDate: today(), childIds: [other.childIds[0]] }),
        await file(b, 'visit.created', { visitId: newId(), memberId: own.memberId, visitDate: today(), childIds: [foreign.childId] }),
        await file(b, 'visit.created', { visitId: newId(), memberId: null, visitDate: today(), childIds: [ownLive] }),
        await file(b, 'visit.created', { visitId: newId(), memberId: aliasOne, visitDate: today(), childIds: [survivor.childIds[0]] }),
        // Children added to that visit: its own, another member's.
        await file(b, 'visit.children_added', { operationId: newId(), visitId, memberId: own.memberId, childIds: [ownLive] }),
        await file(b, 'visit.children_added', { operationId: newId(), visitId, memberId: own.memberId, childIds: [other.childIds[0]] }),
        // A drop-off registration naming saved children.
        await file(b, 'checkin.created', registrationFact(own.memberId, ownLive)),
        await file(b, 'checkin.created', registrationFact(own.memberId, other.childIds[0]!)),
        await file(b, 'checkin.created', registrationFact(own.memberId, ownRemoved)),
        await file(b, 'checkin.created', registrationFact(null, ownLive)),
        await file(b, 'checkin.created', registrationFact(own.memberId, foreign.childId)),
      ];
      const [cleared] = await ctx.db.select({ flagged: member.childrenReviewSince }).from(member).where(eq(member.id, survivor.memberId));
      const visitKids = await ctx.db.select({ childId: visitChild.childId }).from(visitChild).where(eq(visitChild.visitId, visitId));
      const [edited] = await ctx.db.select({ allergies: child.allergies }).from(child).where(eq(child.id, ownLive));
      return {
        outcomes,
        flagged: flags.map((f) => [f.id === survivor.memberId ? 'survivor' : 'emptied', f.flagged !== null]).sort(),
        clearedByTheVisit: cleared!.flagged === null,
        visitKids: visitKids.map((v) => (v.childId === ownLive ? 'own' : 'other')),
        edited: edited!.allergies,
      };
    });
    expect(read).toEqual(off);
    expect(off.outcomes.map((o) => (o.result === 'applied' ? 'applied' : `${o.reason} ${o.errorCode}`))).toEqual([
      'applied', 'applied', 'applied', 'applied',
      'applied', 'applied', 'poison SYNC_CHILD_NOT_OURS', 'apply_failed SYNC_CHILD_ABSENT',
      'applied', 'apply_failed SYNC_VISIT_CHILD_NOT_SAVED', 'apply_failed SYNC_VISIT_CHILD_NOT_SAVED',
      'apply_failed SYNC_VISIT_CHILD_NOT_SAVED', 'poison SYNC_VISIT_CHILD_NO_MEMBER', 'applied',
      'applied', `apply_failed ${off.outcomes[15]!.errorCode}`,
      'applied', 'apply_failed SYNC_CHECKIN_CHILD_UNKNOWN', 'applied', 'apply_failed SYNC_CHECKIN_CHILD_UNKNOWN',
      'apply_failed SYNC_CHECKIN_CHILD_UNKNOWN',
    ]);
    expect(off.outcomes[15]!.result).toBe('quarantined');
    expect(off.flagged).toEqual([['emptied', false], ['survivor', true]]);
    expect(off.clearedByTheVisit).toBe(true);
    expect(off.visitKids).toEqual(['own']);
    expect(off.edited).toBe('ZZ TEST box edit');
  });
});

// --- 2. The plan's box test: a second guardian -----------------------------------------

describe('SCRUM-1024 F3 — an offline visit filed under a second guardian, for the family\'s child', () => {
  const build = async () => {
    const first = await newMember('ZZ TEST 1024B First', ['ZZ TEST 1024B Kai', 'ZZ TEST 1024B Lin'], [1]);
    const second = await newMember('ZZ TEST 1024B Second', ['ZZ TEST 1024B Max']);
    const bystander = await newMember('ZZ TEST 1024B Bystander', ['ZZ TEST 1024B Ned']);
    await addGuardian(first.childIds[0]!, second.memberId);
    return { first, second, bystander, box: await freshBox() };
  };

  it('is refused at off as today, and taken at read; so are the visit\'s added children and a registration', async () => {
    const { off, read } = await bothWaysFresh(build, async ({ first, second, bystander, box: b }) => {
      const [kai, lin] = first.childIds as [string, string];
      const visitId = newId();
      const ownVisit = newId();
      const outcomes = [
        await file(b, 'visit.created', { visitId, memberId: second.memberId, visitDate: today(), childIds: [kai] }),
        await file(b, 'visit.created', { visitId: ownVisit, memberId: second.memberId, visitDate: today(), childIds: [second.childIds[0]] }),
        await file(b, 'visit.children_added', { operationId: newId(), visitId: ownVisit, memberId: second.memberId, childIds: [kai] }),
        await file(b, 'checkin.created', registrationFact(second.memberId, kai)),
        // Never: the family's removed child, a bystander's, or the second parent's own child to the first parent.
        await file(b, 'visit.created', { visitId: newId(), memberId: second.memberId, visitDate: today(), childIds: [lin] }),
        await file(b, 'visit.created', { visitId: newId(), memberId: second.memberId, visitDate: today(), childIds: [bystander.childIds[0]] }),
        await file(b, 'visit.created', { visitId: newId(), memberId: first.memberId, visitDate: today(), childIds: [second.childIds[0]] }),
        // An edit from the box names no member: the family's child is this park group's at both settings.
        await file(b, 'child.updated', { childId: kai, allergies: 'ZZ TEST from the second parent\'s box' }),
      ];
      const kids = await ctx.db.select({ visitId: visitChild.visitId, childId: visitChild.childId }).from(visitChild)
        .where(inArray(visitChild.visitId, [visitId, ownVisit]));
      return {
        outcomes: outcomes.map((o) => (o.result === 'applied' ? 'applied' : `${o.reason} ${o.errorCode}`)),
        kaiOnAVisit: kids.filter((k) => k.childId === kai).length,
        registrations: (await ctx.db.select({ id: registration.id }).from(registration).where(eq(registration.memberId, second.memberId))).length,
      };
    });
    const refusedAtOff = off.outcomes[2]!;
    expect(off).toEqual({
      outcomes: [
        'apply_failed SYNC_VISIT_CHILD_NOT_SAVED', 'applied', refusedAtOff, 'apply_failed SYNC_CHECKIN_CHILD_UNKNOWN',
        'apply_failed SYNC_VISIT_CHILD_NOT_SAVED', 'apply_failed SYNC_VISIT_CHILD_NOT_SAVED', 'apply_failed SYNC_VISIT_CHILD_NOT_SAVED',
        'applied',
      ],
      kaiOnAVisit: 0,
      registrations: 0,
    });
    expect(refusedAtOff).toMatch(/^apply_failed /);
    expect(read).toEqual({
      outcomes: [
        'applied', 'applied', 'applied', 'applied',
        'apply_failed SYNC_VISIT_CHILD_NOT_SAVED', 'apply_failed SYNC_VISIT_CHILD_NOT_SAVED', 'apply_failed SYNC_VISIT_CHILD_NOT_SAVED',
        'applied',
      ],
      kaiOnAVisit: 2,
      registrations: 1,
    });
  });

  it('the bundle nests the family\'s child under both parents at read, in the shape it always had; at off only under the first', async () => {
    const { first, second, bystander, box: b } = await build();
    const { off, read } = await bothWays(() => bundleOf(b));
    const names = (bundle: typeof off, memberId: string) => itemOf(bundle, memberId)!.children.map((c) => c.name).sort();
    expect(names(off, second.memberId)).toEqual(['ZZ TEST 1024B Max']);
    expect(names(read, second.memberId)).toEqual(['ZZ TEST 1024B Kai', 'ZZ TEST 1024B Max']);
    for (const bundle of [off, read]) {
      expect(names(bundle, first.memberId)).toEqual(['ZZ TEST 1024B Kai']);
      expect(names(bundle, bystander.memberId)).toEqual(['ZZ TEST 1024B Ned']);
    }
    // The same child, field for field, under each parent; it keeps the member it was first saved under.
    const underFirst = itemOf(read, first.memberId)!.children[0]!;
    const underSecond = itemOf(read, second.memberId)!.children.find((c) => c.id === first.childIds[0])!;
    expect(underSecond).toEqual(underFirst);
    expect(underSecond.memberId).toBe(first.memberId);
    expect(Object.keys(itemOf(read, second.memberId)!).sort()).toEqual(Object.keys(itemOf(off, second.memberId)!).sort());
    expect(JSON.stringify(read)).not.toMatch(/family/i);
    expect(read.bundleVersion).not.toBe(off.bundleVersion);
  });

  it('the counter box\'s own code, offline: at read the second parent\'s number shows the family\'s child and the visit lands; at off the counter itself refuses it', async () => {
    const { first, second } = await build();
    const kai = first.childIds[0]!;
    const bridge = agent!.bridge()!;
    const offline = async () => {
      await agent!.setOffline(true, { reason: 'ZZ TEST 1024 the mall link is down' });
      link.cut = true;
      const opened = await bridge.unlock(counterId, { token: counterToken.token, password: RECEPTION.password });
      return (await bridge.authenticate(counterId, opened.session)) as BridgeTillCaller;
    };
    const online = async () => {
      link.cut = false;
      await agent!.setOffline(false);
      await agent!.outbox()!.flush();
    };
    const visitIntent = (visitId: string) => ({
      type: 'visit.create', lastSeenSequence: 0, actionId: `bridge-${newId()}`,
      payload: { visitId, memberId: second.memberId, childIds: [kai] },
    });

    // At read: the box pulls the family into its copy, and the visit it records offline is taken.
    await setBoth('read');
    const atRead = newId();
    try {
      await agent!.syncCache();
      const till = await offline();
      const found = await bridge.lookup(counterId, till, second.phone);
      expect(found!.children.map((c) => c.name).sort()).toEqual(['ZZ TEST 1024B Kai', 'ZZ TEST 1024B Max']);
      await bridge.intent(counterId, till, visitIntent(atRead));
      await online();
      expect(await ctx.db.select().from(visitChild).where(eq(visitChild.visitId, atRead))).toEqual([
        expect.objectContaining({ visitId: atRead, childId: kai }),
      ]);

      // The switch turned back to off while the box still holds the copy it pulled at read: the visit it
      // records offline is filed and refused, as today (apply_failed: the Failures list can replay it).
      const turnedBack = newId();
      const till2 = await offline();
      await bridge.intent(counterId, till2, visitIntent(turnedBack));
      await setBoth('off');
      await online();
      expect(await ctx.db.select().from(visitChild).where(eq(visitChild.visitId, turnedBack))).toEqual([]);
      const held = await ctx.db.select().from(syncQuarantine)
        .where(and(eq(syncQuarantine.boxId, agent!.state.boxId!), eq(syncQuarantine.type, 'visit.created')));
      // The row keeps the envelope as it arrived.
      expect(held.map((q) => [q.reason, q.errorCode, JSON.stringify(q.payload).includes(turnedBack)])).toEqual([
        ['apply_failed', 'SYNC_VISIT_CHILD_NOT_SAVED', true],
      ]);
    } finally {
      link.cut = false;
      await agent!.setOffline(false);
      await setBoth('off');
    }

    // At off, from a fresh copy: the second parent's number shows only their own child, and the counter
    // refuses the family's child before anything is filed.
    await agent!.syncCache();
    const till = await offline();
    try {
      const found = await bridge.lookup(counterId, till, second.phone);
      expect(found!.children.map((c) => c.name)).toEqual(['ZZ TEST 1024B Max']);
      await expect(bridge.intent(counterId, till, visitIntent(newId()))).rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
    } finally {
      await online();
    }
  });
});

// --- 3. The fence ---------------------------------------------------------------------------

describe('SCRUM-1024 F3 — at read, a box reaches a child only through a live guardian row on its live family, inside the park group', () => {
  it('a guardian row taken off, an archived family, another park group\'s member and an alias id reach nothing', async () => {
    const first = await newMember('ZZ TEST 1024B Fence First', ['ZZ TEST 1024B Oli']);
    const second = await newMember('ZZ TEST 1024B Fence Second', ['ZZ TEST 1024B Pia']);
    const oli = first.childIds[0]!;
    const pia = second.childIds[0]!;
    const rowId = await addGuardian(oli, second.memberId);
    await ctx.db.update(familyGuardian).set({ archivedAt: new Date() }).where(eq(familyGuardian.id, rowId));
    // A row naming the other park group's member on this park group's family (no writer makes one).
    await addGuardian(oli, foreign.memberId);
    const aliasId = newId();
    await ctx.db.insert(memberAlias).values({ aliasMemberId: aliasId, operatorId: otoId, memberId: second.memberId });
    const b = await freshBox();

    await setBoth('read');
    try {
      // The row taken off: the second parent's copy and facts reach only their own child.
      const bundle = await bundleOf(b);
      expect(itemOf(bundle, second.memberId)!.children.map((c) => c.id)).toEqual([pia]);
      expect(await file(b, 'visit.created', { visitId: newId(), memberId: second.memberId, visitDate: today(), childIds: [oli] }))
        .toMatchObject({ reason: 'apply_failed', errorCode: 'SYNC_VISIT_CHILD_NOT_SAVED' });
      expect(await file(b, 'checkin.created', registrationFact(second.memberId, oli)))
        .toMatchObject({ reason: 'apply_failed', errorCode: 'SYNC_CHECKIN_CHILD_UNKNOWN' });
      // The other park group's member, through the row naming them, from either park group.
      for (const operatorId of [otoId, secondId]) {
        const nested = await childrenByMemberThroughFamilies(ctx.db, { operatorId, memberIds: [foreign.memberId], memberLive: false });
        expect([...nested.values()].flat().map((c) => c.id)).not.toContain(oli);
      }
      expect(await file(b, 'visit.created', { visitId: newId(), memberId: foreign.memberId, visitDate: today(), childIds: [oli] }))
        .toMatchObject({ reason: 'apply_failed', errorCode: 'SYNC_MEMBER_ABSENT' });
      // An alias id names no guardian row: a box's fact under it reads the survivor's family, nothing more.
      expect((await childrenByMemberThroughFamilies(ctx.db, { operatorId: otoId, memberIds: [aliasId], memberLive: false })).size).toBe(0);
      expect(await file(b, 'visit.created', { visitId: newId(), memberId: aliasId, visitDate: today(), childIds: [oli] }))
        .toMatchObject({ reason: 'apply_failed', errorCode: 'SYNC_VISIT_CHILD_NOT_SAVED' });
      expect(await file(b, 'visit.created', { visitId: newId(), memberId: aliasId, visitDate: today(), childIds: [pia] }))
        .toMatchObject({ result: 'applied' });

      // An archived family: nobody's copy carries its child, and no fact or edit reaches it.
      await ctx.db.update(family).set({ archivedAt: new Date() }).where(eq(family.id, await familyOf(oli)));
      const after = await bundleOf(b);
      expect(itemOf(after, first.memberId)!.children).toEqual([]);
      expect(await file(b, 'visit.created', { visitId: newId(), memberId: first.memberId, visitDate: today(), childIds: [oli] }))
        .toMatchObject({ reason: 'apply_failed', errorCode: 'SYNC_VISIT_CHILD_NOT_SAVED' });
      expect(await file(b, 'child.updated', { childId: oli, notes: 'ZZ TEST' }))
        .toMatchObject({ reason: 'poison', errorCode: 'SYNC_CHILD_NOT_OURS' });
    } finally {
      await setBoth('off');
    }
    // At off nothing of this is read: the first parent's copy and facts reach their child as today.
    const atOff = await bundleOf(b);
    expect(itemOf(atOff, first.memberId)!.children.map((c) => c.id)).toEqual([oli]);
    expect(await file(b, 'child.updated', { childId: oli, notes: 'ZZ TEST' })).toMatchObject({ result: 'applied' });
  });

  it('a child given to another park group\'s family by hand is never taken by this park group\'s box for its first member at read', async () => {
    const own = await newMember('ZZ TEST 1024B Moved', ['ZZ TEST 1024B Quin']);
    const quin = own.childIds[0]!;
    const [foreignChild] = await ctx.db.select({ familyId: child.familyId }).from(child).where(eq(child.id, foreign.childId));
    await ctx.db.update(child).set({ familyId: foreignChild!.familyId }).where(eq(child.id, quin));
    const b = await freshBox();
    await setBoth('read');
    try {
      expect(itemOf(await bundleOf(b), own.memberId)!.children).toEqual([]);
      expect(await file(b, 'visit.created', { visitId: newId(), memberId: own.memberId, visitDate: today(), childIds: [quin] }))
        .toMatchObject({ reason: 'apply_failed', errorCode: 'SYNC_VISIT_CHILD_NOT_SAVED' });
      expect(await file(b, 'child.updated', { childId: quin, notes: 'ZZ TEST' }))
        .toMatchObject({ reason: 'poison', errorCode: 'SYNC_CHILD_NOT_OURS' });
    } finally {
      await setBoth('off');
    }
  });
});
