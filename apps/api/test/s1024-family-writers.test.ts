import { createHash, generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  box,
  child,
  family,
  FAMILY_PROFILES_KEY,
  familyGuardian,
  featureFlag,
  flagCatalogueEntry,
  member,
  station,
} from '@oto/db';
import {
  SYNC_EVENT_SCHEMA_VERSION,
  canonicalSyncBytes,
  newId,
  type SyncEventEnvelope,
} from '@oto/shared';
import { boxCredential } from '@oto/box-agent';
import { issueClaimCode } from '../src/services/box';
import { resetDemoData } from '../src/services/demo-reset';
import {
  childrenSeenBy,
  ensureFamilyFor,
  familyProfilesMode,
  liveFamiliesOf,
  memberSeesChild,
} from '../src/services/family';
import {
  CENTRAL_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_NAME,
  boxBySlot,
  createTestContext,
  lastCode,
  operatorIdByName,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-1024 — family profiles, plan step F1: every writer of a child gives
 * the new child a family (`docs/progress/plans/dropoff-beo-20261119/
 * FAMILY_PROFILES_PLAN.md` §2.2 and §3, W1). Nothing reads a family yet.
 *
 * What is pinned, writer by writer — the till's route, the box's replayed
 * `child.created`, the booking site's save, and the seed:
 *   - a member's first child makes exactly one family and one guardian row,
 *     and the second child joins it;
 *   - a replayed create makes nothing new, and two first children saved at
 *     the same moment share one family;
 *   - the answers keep exactly the fields they had;
 *   - another operator's member, or a family the member does not hold, is
 *     refused and nothing is written;
 *   - a child with no family (saved before this release) breaks nothing.
 * Then the read rule written for step F3 (called from nowhere yet), the
 * switch and its three values, and the demo reset with families in it.
 */

let ctx: TestContext;
let reception: string;
let otoId: string;
let secondId: string;
let receptionAccountId: string;

/** The fields the till's child answer has always had: no family in this step. */
const CHILD_ANSWER_KEYS = [
  'ageYears',
  'allergies',
  'dateOfBirth',
  'dietary',
  'foodRestrictions',
  'id',
  'lastConfirmedAt',
  'medicalAlert',
  'medicalNotes',
  'name',
  'notes',
];

let phoneSeq = 0;
/** A ZZ TEST number nothing else in this file has taken (Thai mobile, test range). */
const nextPhone = (): string => `06510240${String((phoneSeq += 1)).padStart(2, '0')}`;
const e164 = (local: string): string => `+66${local.slice(1)}`;

async function newMember(nickname: string): Promise<{ memberId: string; phone: string }> {
  const phone = nextPhone();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/members',
    headers: { cookie: reception },
    payload: { phone, nickname },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { memberId: res.json().member.id as string, phone };
}

function addChild(memberId: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/members/${memberId}/children`,
    headers: { cookie: reception },
    payload,
  });
}

async function childRow(id: string) {
  const [row] = await ctx.db.select().from(child).where(eq(child.id, id));
  return row!;
}

async function guardiansOf(memberId: string) {
  return ctx.db.select().from(familyGuardian).where(eq(familyGuardian.memberId, memberId));
}

async function familiesOf(memberId: string) {
  const rows = await guardiansOf(memberId);
  return rows.length
    ? ctx.db.select().from(family).where(inArray(family.id, rows.map((r) => r.familyId)))
    : [];
}

async function familyAudit(familyIds: string[]) {
  return familyIds.length
    ? ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'family.create'), inArray(auditLog.entityId, familyIds)))
    : [];
}

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  otoId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  secondId = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  const [staff] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.phone, RECEPTION.phone), eq(account.operatorId, otoId)));
  receptionAccountId = staff!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-1024 — the seed', () => {
  it('gives every seeded child a family, with the member it was saved under as its one guardian', async () => {
    const kids = await ctx.db.select().from(child);
    expect(kids.length).toBeGreaterThan(0);
    expect(kids.filter((k) => k.familyId === null)).toEqual([]);
    for (const k of kids) {
      const rows = await ctx.db.select().from(familyGuardian).where(eq(familyGuardian.familyId, k.familyId!));
      expect(rows.map((r) => [r.memberId, r.source, r.archivedAt]), k.name).toEqual([[k.memberId, 'backfill', null]]);
      const [f] = await ctx.db.select().from(family).where(eq(family.id, k.familyId!));
      const [m] = await ctx.db.select().from(member).where(eq(member.id, k.memberId));
      expect(f!.operatorId).toBe(m!.operatorId);
    }
    // Mali's two children share one family; the second operator's child has its own, in its own operator.
    const [mali] = await ctx.db.select().from(member).where(and(eq(member.phone, '+66811111111'), eq(member.operatorId, otoId)));
    const maliKids = kids.filter((k) => k.memberId === mali!.id);
    expect(maliKids).toHaveLength(2);
    expect(new Set(maliKids.map((k) => k.familyId)).size).toBe(1);
    const foreign = await ctx.db.select().from(family).where(eq(family.operatorId, secondId));
    expect(foreign).toHaveLength(1);
  });
});

describe('SCRUM-1024 — the till adds a child (POST /members/:id/children)', () => {
  let memberId: string;
  let firstId: string;
  let familyId: string;

  it("the first child makes one family with the member as its one guardian; the answer is the one it always was", async () => {
    ({ memberId } = await newMember('ZZ TEST 1024 Till'));
    expect(await guardiansOf(memberId)).toEqual([]);
    const [till] = await ctx.db.select().from(station).where(and(eq(station.operatorId, otoId), eq(station.codePrefix, 'T1')));
    await takeStation(ctx.app, reception, till!.id);
    const res = await addChild(memberId, { name: 'ZZ TEST 1024 Nong One', allergies: 'Peanuts' });
    expect(res.statusCode, res.body).toBe(200);
    expect(Object.keys(res.json().child).sort()).toEqual(CHILD_ANSWER_KEYS);
    firstId = res.json().child.id as string;

    const row = await childRow(firstId);
    expect(row.familyId).not.toBeNull();
    expect(row.mergedIntoChildId).toBeNull();
    familyId = row.familyId!;
    const families = await familiesOf(memberId);
    expect(families.map((f) => [f.id, f.operatorId, f.source, f.createdByAccountId, f.archivedAt])).toEqual([
      [familyId, otoId, 'till', receptionAccountId, null],
    ]);
    const guardians = await guardiansOf(memberId);
    expect(guardians).toHaveLength(1);
    expect(guardians[0]).toMatchObject({
      operatorId: otoId,
      familyId,
      memberId,
      source: 'till',
      addedByAccountId: receptionAccountId,
      branchId: till!.branchId,
      stationId: till!.id,
      archivedAt: null,
    });
    const audits = await familyAudit([familyId]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorAccountId: receptionAccountId, operatorId: otoId, branchId: till!.branchId, entityType: 'family' });
    expect(audits[0]!.after).toEqual({ source: 'till', memberId, guardianId: guardians[0]!.id, childId: firstId, stationId: till!.id });
  });

  it('the second child joins that family, and nothing new is made', async () => {
    const res = await addChild(memberId, { name: 'ZZ TEST 1024 Nong Two' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await childRow(res.json().child.id as string)).familyId).toBe(familyId);
    expect(await familiesOf(memberId)).toHaveLength(1);
    expect(await guardiansOf(memberId)).toHaveLength(1);
    expect(await familyAudit([familyId])).toHaveLength(1);
  });

  it('a replayed create (the same child id) answers the child and makes nothing new', async () => {
    const id = newId();
    const first = await addChild(memberId, { id, name: 'ZZ TEST 1024 Nong Three' });
    expect(first.statusCode, first.body).toBe(200);
    const again = await addChild(memberId, { id, name: 'ZZ TEST 1024 Nong Three' });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect((await childRow(id)).familyId).toBe(familyId);
    expect(await familiesOf(memberId)).toHaveLength(1);
    expect(await guardiansOf(memberId)).toHaveLength(1);
    expect(await familyAudit([familyId])).toHaveLength(1);
  });

  it('two first children saved at the same moment share one family: the second waits for the first to commit', async () => {
    const { memberId: twins } = await newMember('ZZ TEST 1024 Twins');
    const input = (childId: string) => ({
      operatorId: otoId,
      memberId: twins,
      childId,
      source: 'till' as const,
      context: { accountId: null, branchId: null, stationId: null },
    });
    // The first save holds its transaction open after making the family.
    let made!: (familyId: string) => void;
    const madeFamily = new Promise<string>((resolve) => (made = resolve));
    let commit!: () => void;
    const held = new Promise<void>((resolve) => (commit = resolve));
    const first = ctx.db.transaction(async (tx) => {
      const out = await ensureFamilyFor(tx, input(newId()));
      made(out.familyId);
      await held;
      return out;
    });
    const familyId = await madeFamily;
    // The second, at the same moment, cannot read past the member it waits on.
    let secondDone = false;
    const second = ctx.db.transaction((tx) => ensureFamilyFor(tx, input(newId()))).finally(() => {
      secondDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(secondDone, 'the second save waits on the member row the first holds').toBe(false);
    commit();
    expect(await first).toEqual({ familyId, created: true, ambiguous: false });
    expect(await second).toEqual({ familyId, created: false, ambiguous: false });
    expect(await familiesOf(twins)).toHaveLength(1);
    expect(await guardiansOf(twins)).toHaveLength(1);
  });

  it('two children added through the till at once both land in the one family', async () => {
    const { memberId: twins } = await newMember('ZZ TEST 1024 Twins Till');
    const [a, b] = await Promise.all([
      addChild(twins, { name: 'ZZ TEST 1024 Twin A' }),
      addChild(twins, { name: 'ZZ TEST 1024 Twin B' }),
    ]);
    expect(a!.statusCode, a!.body).toBe(200);
    expect(b!.statusCode, b!.body).toBe(200);
    const families = await familiesOf(twins);
    expect(families).toHaveLength(1);
    expect(await guardiansOf(twins)).toHaveLength(1);
    expect((await childRow(a!.json().child.id as string)).familyId).toBe(families[0]!.id);
    expect((await childRow(b!.json().child.id as string)).familyId).toBe(families[0]!.id);
  });

  it("a member of another operator is still a 404, and no family is made for them", async () => {
    const [foreign] = await ctx.db.select().from(member).where(eq(member.operatorId, secondId));
    const before = await ctx.db.select().from(family).where(eq(family.operatorId, secondId));
    const res = await addChild(foreign!.id, { name: 'ZZ TEST 1024 Not Ours' });
    expect(res.statusCode).toBe(404);
    expect(await ctx.db.select().from(family).where(eq(family.operatorId, secondId))).toEqual(before);
  });

  it('a member whose children were saved before families gets a family with the next child; the old ones keep NULL for the backfill', async () => {
    const { memberId: older } = await newMember('ZZ TEST 1024 Older');
    const legacyId = newId();
    await ctx.db.insert(child).values({ id: legacyId, memberId: older, name: 'ZZ TEST 1024 Legacy' });
    // The lookup and the member detail read a child with no family exactly as before.
    const detail = await ctx.app.inject({ method: 'GET', url: `/members/${older}`, headers: { cookie: reception } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().member.children.map((c: { id: string }) => c.id)).toEqual([legacyId]);
    const res = await addChild(older, { name: 'ZZ TEST 1024 Newer' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await childRow(res.json().child.id as string)).familyId).not.toBeNull();
    expect((await childRow(legacyId)).familyId).toBeNull();
    expect(await guardiansOf(older)).toHaveLength(1);
  });
});

// --- The box ------------------------------------------------------------------

interface TestBox {
  boxId: string;
  credential: string;
  privateKey: KeyObject;
  publicKeyPem: string;
  nextSeq: number;
}

let slotCounter = 0;
async function freshBox(): Promise<TestBox> {
  const seeded = await boxBySlot(ctx.db, 'virtual-1');
  const slot = `test-1024-${(slotCounter += 1)}`;
  await ctx.db.insert(box).values({
    id: newId(),
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    name: `ZZ TEST 1024 box ${slotCounter}`,
    slot,
    role: 'virtual',
    status: 'unclaimed',
  });
  const row = await boxBySlot(ctx.db, slot);
  const { code: claimCode } = await issueClaimCode(ctx.db, row.id);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/register',
    payload: { claimCode, agentVersion: '0.1.0', hostname: `test-${slot}` },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { boxId: string; secret: string };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const b: TestBox = {
    boxId: body.boxId,
    credential: boxCredential(body.boxId, body.secret),
    privateKey,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    nextSeq: 1,
  };
  const key = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/sync/key',
    headers: { authorization: `Bearer ${b.credential}` },
    payload: { publicKey: b.publicKeyPem },
  });
  expect(key.statusCode).toBe(200);
  return b;
}

const sha256 = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

function mint(b: TestBox, type: string, payload: Record<string, unknown>): SyncEventEnvelope {
  const base = {
    eventId: newId(),
    journalEpoch: 1,
    boxSeq: b.nextSeq++,
    type,
    schemaVersion: SYNC_EVENT_SCHEMA_VERSION,
    occurredAt: new Date().toISOString(),
    clockTrust: 'trusted' as const,
    stationId: null,
    actorKind: 'account' as const,
    actorAccountId: null,
    actorCredentialId: null,
    actionId: `act-${Math.random().toString(36).slice(2, 10)}`,
    payload,
  };
  const canonical = canonicalSyncBytes({ ...base, boxId: b.boxId });
  return {
    ...base,
    payloadHash: sha256(canonical),
    sig: signDetached(null, Buffer.from(canonical, 'utf8'), b.privateKey).toString('base64'),
    sigAlg: 'ed25519',
  } as SyncEventEnvelope;
}

async function push(b: TestBox, events: SyncEventEnvelope[]) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/sync/push',
    headers: { authorization: `Bearer ${b.credential}` },
    payload: { events },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { applied: number; duplicates?: number };
}

describe("SCRUM-1024 — the box's child.created", () => {
  it("lands a box's first child in a new family of the member, the next in the same, and a replay makes nothing new", async () => {
    const b = await freshBox();
    const memberId = newId();
    const phone = e164(nextPhone());
    const first = newId();
    const second = newId();
    const batch = [
      mint(b, 'member.created', { memberId, phone, nickname: 'ZZ TEST 1024 Box', createdVia: 'pos' }),
      mint(b, 'child.created', { childId: first, memberId, name: 'ZZ TEST 1024 Box One', allergies: 'Milk' }),
      mint(b, 'child.created', { childId: second, memberId, name: 'ZZ TEST 1024 Box Two' }),
    ];
    expect((await push(b, batch)).applied).toBe(3);
    const families = await familiesOf(memberId);
    expect(families.map((f) => [f.operatorId, f.source, f.createdByAccountId])).toEqual([[otoId, 'sync', null]]);
    const guardians = await guardiansOf(memberId);
    expect(guardians.map((g) => [g.familyId, g.source, g.addedByAccountId, g.stationId])).toEqual([[families[0]!.id, 'sync', null, null]]);
    expect((await childRow(first)).familyId).toBe(families[0]!.id);
    expect((await childRow(second)).familyId).toBe(families[0]!.id);
    const audits = await familyAudit([families[0]!.id]);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.sourceEventId).toBe(batch[1]!.eventId);
    expect(audits[0]!.actionId).toBe(batch[1]!.actionId);

    // The same batch again (the answer was lost): nothing new anywhere.
    const again = await push(b, batch);
    expect(again.applied).toBe(0);
    expect(await familiesOf(memberId)).toHaveLength(1);
    expect(await guardiansOf(memberId)).toHaveLength(1);
    expect(await familyAudit([families[0]!.id])).toHaveLength(1);
  });

  it("a child an old box recorded under a merged member id lands in the survivor's family", async () => {
    const one = await freshBox();
    const two = await freshBox();
    const survivor = newId();
    const merged = newId();
    const phone = e164(nextPhone());
    const kept = newId();
    const late = newId();
    expect(
      (
        await push(one, [
          mint(one, 'member.created', { memberId: survivor, phone, nickname: 'ZZ TEST 1024 Survivor', createdVia: 'pos' }),
          mint(one, 'child.created', { childId: kept, memberId: survivor, name: 'ZZ TEST 1024 Kept' }),
        ])
      ).applied,
    ).toBe(2);
    // The same phone typed at a second counter while both were offline, then a child under that counter's id.
    expect(
      (
        await push(two, [
          mint(two, 'member.created', { memberId: merged, phone, nickname: 'ZZ TEST 1024 Merged', createdVia: 'pos' }),
          mint(two, 'child.created', { childId: late, memberId: merged, name: 'ZZ TEST 1024 Late' }),
        ])
      ).applied,
    ).toBe(2);
    const lateRow = await childRow(late);
    expect(lateRow.memberId).toBe(survivor);
    expect(lateRow.familyId).toBe((await childRow(kept)).familyId);
    expect(await guardiansOf(survivor)).toHaveLength(1);
    expect(await guardiansOf(merged)).toEqual([]);
  });
});

// --- The booking site ------------------------------------------------------------

let caller = 0;
const address = (): string => {
  caller += 1;
  return `10.124.${Math.floor(caller / 250)}.${(caller % 250) + 1}`;
};

async function passFor(phone: string): Promise<string> {
  const sent = await ctx.app.inject({
    method: 'POST',
    url: '/public/saved-children/code',
    remoteAddress: address(),
    payload: { phone, branch: CENTRAL_BRANCH_CODE },
  });
  expect(sent.statusCode, sent.body).toBe(200);
  const verified = await ctx.app.inject({
    method: 'POST',
    url: '/public/saved-children/verify',
    remoteAddress: address(),
    payload: { phone, branch: CENTRAL_BRANCH_CODE, code: lastCode(ctx.smsLog) },
  });
  expect(verified.statusCode, verified.body).toBe(200);
  return verified.json().familyPass as string;
}

function save(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/public/saved-children/save',
    remoteAddress: address(),
    payload: { branch: CENTRAL_BRANCH_CODE, children: [], remove: [], ...payload },
  });
}

describe("SCRUM-1024 — the booking site's save", () => {
  it('a child the family adds joins the family their first child made, and a replayed save makes nothing new', async () => {
    const { memberId, phone } = await newMember('ZZ TEST 1024 Online');
    const tillChild = await addChild(memberId, { name: 'ZZ TEST 1024 At Till', ageYears: 6 });
    expect(tillChild.statusCode).toBe(200);
    const familyId = (await childRow(tillChild.json().child.id as string)).familyId!;
    const pass = await passFor(phone);
    const added = newId();
    const body = { phone, pass, children: [{ newChildId: added, name: 'ZZ TEST 1024 Online Sib', ageYears: 3 }] };
    const res = await save(body);
    expect(res.statusCode, res.body).toBe(200);
    expect((await childRow(added)).familyId).toBe(familyId);
    expect(await guardiansOf(memberId)).toHaveLength(1);
    const again = await save(body);
    expect(again.statusCode, again.body).toBe(200);
    expect(await familiesOf(memberId)).toHaveLength(1);
    expect(await guardiansOf(memberId)).toHaveLength(1);
    expect(await familyAudit([familyId])).toHaveLength(1);
  });

  it('a member with no family yet gets one from the booking site, made with no staff actor, for both children it adds', async () => {
    const { memberId, phone } = await newMember('ZZ TEST 1024 Online First');
    const pass = await passFor(phone);
    const first = newId();
    const second = newId();
    const res = await save({
      phone,
      pass,
      children: [
        { newChildId: first, name: 'ZZ TEST 1024 Online First Kid', ageYears: 4 },
        { newChildId: second, name: 'ZZ TEST 1024 Online Second Kid', ageYears: 2 },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const families = await familiesOf(memberId);
    expect(families.map((f) => [f.source, f.createdByAccountId])).toEqual([['booking', null]]);
    expect((await guardiansOf(memberId)).map((g) => [g.source, g.addedByAccountId, g.stationId])).toEqual([['booking', null, null]]);
    expect((await childRow(first)).familyId).toBe(families[0]!.id);
    expect((await childRow(second)).familyId).toBe(families[0]!.id);
    const audits = await familyAudit([families[0]!.id]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorAccountId: null, origin: 'booking_site' });
    expect((audits[0]!.after as { childId: string }).childId).toBe(first);
  });
});

// --- The service itself -------------------------------------------------------------

describe('SCRUM-1024 — ensureFamilyFor refuses across operators and families', () => {
  it("refuses another operator's member, writing nothing", async () => {
    const [foreign] = await ctx.db.select().from(member).where(eq(member.operatorId, secondId));
    const familiesBefore = await ctx.db.select().from(family);
    await expect(
      ctx.db.transaction((tx) =>
        ensureFamilyFor(tx, {
          operatorId: otoId,
          memberId: foreign!.id,
          childId: newId(),
          source: 'till',
          context: { accountId: null, branchId: null, stationId: null },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await ctx.db.select().from(family)).toEqual(familiesBefore);
  });

  it("refuses a named family of another operator, and one the member is not a guardian of", async () => {
    const { memberId } = await newMember('ZZ TEST 1024 Named');
    const kid = await addChild(memberId, { name: 'ZZ TEST 1024 Named Kid' });
    const own = (await childRow(kid.json().child.id as string)).familyId!;
    const [theirs] = await ctx.db.select().from(family).where(eq(family.operatorId, secondId));
    const { memberId: stranger } = await newMember('ZZ TEST 1024 Stranger');
    const attempt = (who: string, familyId: string) =>
      ctx.db.transaction((tx) =>
        ensureFamilyFor(tx, {
          operatorId: otoId,
          memberId: who,
          childId: newId(),
          familyId,
          source: 'till',
          context: { accountId: null, branchId: null, stationId: null },
        }),
      );
    await expect(attempt(memberId, theirs!.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(attempt(stranger, own)).rejects.toMatchObject({ statusCode: 404 });
    // Its own family, named, is the answer, and nothing new is made.
    await expect(attempt(memberId, own)).resolves.toEqual({ familyId: own, created: false, ambiguous: false });
    expect(await guardiansOf(stranger)).toEqual([]);
  });

  it("keeps a branch or till of another operator off the guardian row", async () => {
    const { memberId } = await newMember('ZZ TEST 1024 Place');
    const [foreignTill] = await ctx.db.select().from(station).where(eq(station.operatorId, secondId));
    const made = await ctx.db.transaction((tx) =>
      ensureFamilyFor(tx, {
        operatorId: otoId,
        memberId,
        childId: newId(),
        source: 'till',
        context: { accountId: null, branchId: foreignTill!.branchId, stationId: foreignTill!.id },
      }),
    );
    expect(made.created).toBe(true);
    const [g] = await guardiansOf(memberId);
    expect([g!.branchId, g!.stationId]).toEqual([null, null]);
  });

  it('takes the oldest live family when the member is a guardian in several, and says so', async () => {
    const { memberId } = await newMember('ZZ TEST 1024 Blended');
    const kid = await addChild(memberId, { name: 'ZZ TEST 1024 Blended Kid' });
    const own = (await childRow(kid.json().child.id as string)).familyId!;
    // A second family that holds this member too (how a later step's link will look).
    const later = newId();
    await ctx.db.insert(family).values({ id: later, operatorId: otoId, source: 'link', createdAt: new Date(Date.now() + 60_000) });
    await ctx.db.insert(familyGuardian).values({ id: newId(), operatorId: otoId, familyId: later, memberId, source: 'link' });
    expect(await liveFamiliesOf(ctx.db, otoId, memberId)).toEqual([own, later]);
    const chosen = await ctx.db.transaction((tx) =>
      ensureFamilyFor(tx, {
        operatorId: otoId,
        memberId,
        childId: newId(),
        source: 'till',
        context: { accountId: null, branchId: null, stationId: null },
      }),
    );
    expect(chosen).toEqual({ familyId: own, created: false, ambiguous: true });
  });
});

// --- The read rule (for step F3; called from nowhere yet) ----------------------------

describe('SCRUM-1024 — the read rule: a member sees a child through a live guardian row in its family', () => {
  it('sees the live, unmerged children of their families, a second guardian sees them too, and nobody else does', async () => {
    const { memberId: parent } = await newMember('ZZ TEST 1024 Parent');
    const { memberId: other } = await newMember('ZZ TEST 1024 Other Parent');
    const { memberId: outsider } = await newMember('ZZ TEST 1024 Outsider');
    const ids: string[] = [];
    for (const name of ['ZZ TEST 1024 Kid A', 'ZZ TEST 1024 Kid B', 'ZZ TEST 1024 Kid C', 'ZZ TEST 1024 Kid D']) {
      const res = await addChild(parent, { name });
      ids.push(res.json().child.id as string);
    }
    const [a, b, c, d] = ids as [string, string, string, string];
    const familyId = (await childRow(a)).familyId!;
    // B archived; C merged into A (as a later step will mark a duplicate).
    await ctx.db.update(child).set({ archivedAt: new Date() }).where(eq(child.id, b));
    await ctx.db.update(child).set({ mergedIntoChildId: a }).where(eq(child.id, c));
    const seen = async (memberId: string) =>
      (await childrenSeenBy(ctx.db, { operatorId: otoId, memberId })).map((r) => r.id);

    expect(await seen(parent)).toEqual([a, d]);
    expect(await seen(other)).toEqual([]);
    expect(await memberSeesChild(ctx.db, { operatorId: otoId, memberId: other, childId: a })).toBe(false);

    // A second guardian on the family sees the same children, and only those.
    const second = newId();
    await ctx.db.insert(familyGuardian).values({ id: second, operatorId: otoId, familyId, memberId: other, source: 'link' });
    expect(await seen(other)).toEqual([a, d]);
    expect(await memberSeesChild(ctx.db, { operatorId: otoId, memberId: other, childId: d })).toBe(true);
    expect(await memberSeesChild(ctx.db, { operatorId: otoId, memberId: other, childId: b })).toBe(false);
    expect(await memberSeesChild(ctx.db, { operatorId: otoId, memberId: other, childId: c })).toBe(false);
    expect(await seen(outsider)).toEqual([]);

    // Through another operator, never.
    expect(await childrenSeenBy(ctx.db, { operatorId: secondId, memberId: parent })).toEqual([]);

    // A guardian row taken off, or an archived member, sees nothing.
    await ctx.db.update(familyGuardian).set({ archivedAt: new Date() }).where(eq(familyGuardian.id, second));
    expect(await seen(other)).toEqual([]);
    await ctx.db.update(member).set({ archivedAt: new Date() }).where(eq(member.id, parent));
    expect(await seen(parent)).toEqual([]);
    await ctx.db.update(member).set({ archivedAt: null }).where(eq(member.id, parent));

    // A child with no family yet is seen by nobody through the rule: the backfill gives it one first.
    const loose = newId();
    await ctx.db.insert(child).values({ id: loose, memberId: parent, name: 'ZZ TEST 1024 Loose' });
    expect(await memberSeesChild(ctx.db, { operatorId: otoId, memberId: parent, childId: loose })).toBe(false);
  });
});

// --- The switch ---------------------------------------------------------------------------

describe('SCRUM-1024 — the crm.family_profiles switch', () => {
  it('is catalogued off, read, on at operator scope, defaults off, and is not yet settable', () => {
    expect(flagCatalogueEntry(FAMILY_PROFILES_KEY)).toEqual({
      key: 'crm.family_profiles',
      kind: 'feature',
      targetApp: 'pos',
      label: 'Family profiles',
      effect: 'Not integrated: the till, the counter box and the booking site do not read this switch yet.',
      valueType: 'enum',
      values: ['off', 'read', 'on'],
      defaultValue: 'off',
      scopes: ['operator'],
      supported: false,
    });
  });

  it('reads off with nothing set, then each of its three values at operator scope, and never another operator\'s', async () => {
    expect(await familyProfilesMode(ctx.db, otoId)).toBe('off');
    expect(await familyProfilesMode(ctx.db, secondId)).toBe('off');
    const rowId = newId();
    await ctx.db.insert(featureFlag).values({
      id: rowId,
      key: FAMILY_PROFILES_KEY,
      kind: 'feature',
      targetApp: 'pos',
      scopeType: 'operator',
      scopeId: otoId,
      operatorId: otoId,
      value: 'read',
      defaultValue: 'off',
      reason: 'ZZ TEST 1024',
    });
    try {
      expect(await familyProfilesMode(ctx.db, otoId)).toBe('read');
      expect(await familyProfilesMode(ctx.db, secondId)).toBe('off');
      await ctx.db.update(featureFlag).set({ value: 'on' }).where(eq(featureFlag.id, rowId));
      expect(await familyProfilesMode(ctx.db, otoId)).toBe('on');
      await ctx.db.update(featureFlag).set({ value: 'off' }).where(eq(featureFlag.id, rowId));
      expect(await familyProfilesMode(ctx.db, otoId)).toBe('off');
      // A value the switch does not take, or one past its expiry, is the default.
      await ctx.db.update(featureFlag).set({ value: 'everything' }).where(eq(featureFlag.id, rowId));
      expect(await familyProfilesMode(ctx.db, otoId)).toBe('off');
      await ctx.db
        .update(featureFlag)
        .set({ value: 'on', expiresAt: new Date(Date.now() - 1000) })
        .where(eq(featureFlag.id, rowId));
      expect(await familyProfilesMode(ctx.db, otoId)).toBe('off');
    } finally {
      await ctx.db.delete(featureFlag).where(eq(featureFlag.id, rowId));
    }
  });

  it('changes nothing a writer does: with it at "on" a new child still gets the same family, and the answer is the same', async () => {
    const { memberId } = await newMember('ZZ TEST 1024 Switch');
    const off = await addChild(memberId, { name: 'ZZ TEST 1024 Switch Off' });
    const rowId = newId();
    await ctx.db.insert(featureFlag).values({
      id: rowId,
      key: FAMILY_PROFILES_KEY,
      kind: 'feature',
      targetApp: 'pos',
      scopeType: 'operator',
      scopeId: otoId,
      operatorId: otoId,
      value: 'on',
      defaultValue: 'off',
      reason: 'ZZ TEST 1024',
    });
    try {
      const on = await addChild(memberId, { name: 'ZZ TEST 1024 Switch On' });
      expect(Object.keys(on.json().child).sort()).toEqual(Object.keys(off.json().child).sort());
      expect((await childRow(on.json().child.id as string)).familyId).toBe((await childRow(off.json().child.id as string)).familyId);
    } finally {
      await ctx.db.delete(featureFlag).where(eq(featureFlag.id, rowId));
    }
  });
});

// --- The demo reset (last: it clears what the session made) ---------------------------

describe('SCRUM-1024 — the demo reset with families in it', () => {
  it("takes the session's families and guardian rows with their members, and keeps every seeded family", async () => {
    const seededFamilies = await ctx.db
      .select({ id: family.id })
      .from(family)
      .where(eq(family.source, 'backfill'))
      .orderBy(asc(family.id));
    const [mali] = await ctx.db.select().from(member).where(and(eq(member.phone, '+66811111111'), eq(member.operatorId, otoId)));
    const added = await addChild(mali!.id, { name: 'ZZ TEST 1024 Mali Extra' });
    expect(added.statusCode).toBe(200);
    const maliFamily = (await childRow(added.json().child.id as string)).familyId!;
    expect(seededFamilies.map((f) => f.id)).toContain(maliFamily);
    const { memberId: walkIn } = await newMember('ZZ TEST 1024 Walk-in');
    await addChild(walkIn, { name: 'ZZ TEST 1024 Walk-in Kid' });
    const walkInFamily = (await familiesOf(walkIn))[0]!.id;

    const counts = await resetDemoData(ctx.db);
    // The answer keeps its fields: families are not counted in this step.
    expect(Object.keys(counts)).not.toContain('family');
    expect(Object.keys(counts)).not.toContain('family_guardian');

    expect(await ctx.db.select().from(member).where(eq(member.id, walkIn))).toEqual([]);
    expect(await ctx.db.select().from(family).where(eq(family.id, walkInFamily))).toEqual([]);
    expect(await ctx.db.select().from(familyGuardian).where(eq(familyGuardian.familyId, walkInFamily))).toEqual([]);
    // Only the seed's members are left, each with the families the seed gave them.
    expect(await ctx.db.select({ id: family.id }).from(family).orderBy(asc(family.id))).toEqual(seededFamilies);
    expect(await ctx.db.select().from(familyGuardian).where(isNull(familyGuardian.archivedAt))).toHaveLength(seededFamilies.length);
    // No family is left without a guardian, and no child points at a family that went.
    const kids = await ctx.db.select().from(child);
    for (const k of kids) {
      if (k.familyId) expect(seededFamilies.map((f) => f.id)).toContain(k.familyId);
    }
    expect(await ctx.db.select().from(auditLog).where(eq(auditLog.entityType, 'family'))).toEqual([]);
  });
});
