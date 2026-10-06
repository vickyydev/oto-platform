import { generateKeyPairSync } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  child,
  member,
  memberAlias,
  memberTierVerification,
  product,
  station,
  staffToken,
  syncAnomaly,
  syncQuarantine,
  ticketPackage,
} from '@oto/db';
import type { BoxAgent, BridgeTillCaller } from '@oto/box-agent';
import { newId } from '@oto/shared';
import {
  ADMIN,
  RECEPTION,
  boxBySlot,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { boxStoreFor } from '../src/lib/box-store';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * THE CONVERGENCE HARNESS — offline plan Round 3 (SCRUM-269).
 *
 * The platform (`buildApp`) and two counter boxes (`createBoxAgent`, the same
 * code a Raspberry Pi runs) joined by a link this file can cut. Reception Till
 * 1 is reached the way a staging till reaches its VIRTUAL box — through the
 * api's mount of the station bridge, behind the platform session, with the
 * station forced offline so the platform's own trading routes refuse. Counter
 * 2 is reached the way a till reaches a Pi — through the box's own bridge, with
 * a box session from an offline unlock. Both write to their own outbox; the
 * link comes back; the platform converges.
 *
 * What it proves, in the plan's words:
 *   - with the toggle on, a till unlocks, finds and creates members, confirms
 *     children and builds a priced cart from the box's catalogue — and paying
 *     refuses politely (round 4);
 *   - the same family signed up at two counters converges on ONE member, the
 *     discarded id kept as an alias so the second counter's child lands on the
 *     survivor, both children kept and the member flagged (OD-7);
 *   - the deny-list refuses: a revoked shift token cannot unlock at the box.
 */

const pair = generateKeyPairSync('ed25519');
const STAFF_KEY = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let ctx: TestContext;
let cookieA: string;
let cookieB: string;
let adminCookie: string;
let tokenA: { token: string; jti: string };
let tokenB: { token: string; jti: string };
let tillId: string;
let counterId: string;
let receptionAccountId: string;
let packageId: string;
let agentA: BoxAgent;
let agentB: BoxAgent;
/** The mall's link, for both boxes. Cut, every call a box makes to the platform fails at the network. */
const link: CuttableLink = { cut: false };

const agentFor = (boxId: string, name: string): BoxAgent => linkedAgent(ctx, boxId, name, link);

async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  cookie: string | null,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return {
    statusCode: res.statusCode,
    body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
  };
}

const intent = (type: string, payload: Record<string, unknown>) => ({
  type,
  lastSeenSequence: 0,
  payload,
  actionId: `bridge-${newId()}`,
});

const bridgePath = (stationId: string, rest: string) => `/box/v1/station/${stationId}/${rest}`;

async function pick(cookie: string, stationId: string): Promise<{ token: string; jti: string }> {
  const res = await call('PUT', '/me/session/station', cookie, { stationId });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return res.body.staffToken as { token: string; jti: string };
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: { OPS_TEST_CONTROLS: 'true', STAFF_TOKEN_PRIVATE_KEY: STAFF_KEY },
  });
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  cookieA = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  cookieB = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  const box2 = await boxBySlot(ctx.db, 'virtual-2');
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
  const [counter] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.boxId, box2.id), eq(station.name, 'Counter 2')));
  tillId = till!.id;
  counterId = counter!.id;
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, till!.branchId), eq(ticketPackage.name, '2 Hours Play')));
  packageId = pkg!.id;

  tokenA = await pick(cookieA, tillId);
  tokenB = await pick(cookieB, counterId);
  const [staff] = await ctx.db
    .select({ accountId: staffToken.accountId })
    .from(staffToken)
    .where(eq(staffToken.jti, tokenA.jti));
  receptionAccountId = staff!.accountId;

  agentA = agentFor(box1.id, 'reception-box');
  agentB = agentFor(box2.id, 'counter-box');
  for (const agent of [agentA, agentB]) {
    expect(await agent.ensureRegistered()).toBe(true);
    await agent.syncConfig();
    // The picks above minted a token on each box, so the staff list the box
    // pulls now knows reception has been seen here (OD-6).
    await agent.syncCache();
    attachInProcessBox(agent);
  }
}, 180_000);

afterAll(async () => {
  for (const agent of [agentA, agentB]) {
    if (!agent) continue;
    agent.stop();
    detachInProcessBox(agent);
  }
  await ctx.close();
  await teardownAll();
});

describe('with the station forced offline, the till works through its box (plan §4, Round 3)', () => {
  const phone = '+66899990001';
  /** The id Counter 2 signed the same family up under, merged at sync. */
  const discardedId = newId();
  const survivorId = newId();
  const childAtReception = newId();
  const visitAtReception = newId();
  let platformGross = 0;
  let platformLineTotal = 0;
  const cartLineId = newId();

  it('prices a cart on the platform first, so the box can be held to the same figure', async () => {
    const quote = await call('POST', '/sales/quote', cookieA, {
      stationId: tillId,
      lines: [{ id: cartLineId, packageId, kids: 2, adults: 1 }],
    });
    expect(quote.statusCode, JSON.stringify(quote.body)).toBe(200);
    const q = quote.body.quote as {
      totals: { grossSatang: number };
      lineTotals: Record<string, number>;
    };
    platformGross = q.totals.grossSatang;
    platformLineTotal = q.lineTotals[cartLineId]!;
    expect(platformGross).toBeGreaterThan(0);
  });

  it('the platform refuses, and the box answers', async () => {
    await agentA.setOffline(true, { reason: 'forced offline for the convergence harness' });
    await agentB.setOffline(true, { reason: 'the mall link is down' });
    link.cut = true;

    const refused = await call(
      'GET',
      `/members/lookup?phone=${encodeURIComponent(phone)}`,
      cookieA,
    );
    expect(refused.statusCode).toBe(503);
    expect((refused.body.error as { code: string }).code).toBe('STATION_FORCED_OFFLINE');

    const status = await call('GET', bridgePath(tillId, 'status'), cookieA);
    expect(status.statusCode, JSON.stringify(status.body)).toBe(200);
    expect((status.body.link as { lane: string; offline: boolean }).offline).toBe(true);
    expect((status.body.link as { lane: string }).lane).toBe('box');
    expect((status.body.catalogue as { state: string }).state).toBe('fresh');
  });

  it('a locked till unlocks through its box: token and password against the box’s copy', async () => {
    expect((await call('POST', '/auth/lock', cookieA)).statusCode).toBe(200);
    // Locked: the platform's business routes refuse this session.
    expect(
      (await call('GET', bridgePath(tillId, `members/lookup?phone=${phone}`), cookieA)).statusCode,
    ).toBe(423);
    const wrong = await call('POST', bridgePath(tillId, 'unlock'), cookieA, {
      token: tokenA.token,
      password: 'not-the-password',
    });
    expect(wrong.statusCode).toBe(401);
    expect((wrong.body.error as { code: string }).code).toBe('OFFLINE_WRONG_PASSWORD');

    const unlocked = await call('POST', bridgePath(tillId, 'unlock'), cookieA, {
      token: tokenA.token,
      password: RECEPTION.password,
    });
    expect(unlocked.statusCode, JSON.stringify(unlocked.body)).toBe(200);
    expect(unlocked.body.method).toBe('offline_token');
    expect(String(unlocked.body.session)).toMatch(/^bs_/);
    const me = await call('GET', '/me', cookieA);
    expect(me.body.sessionLocked).toBe(false);
    const [row] = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'session.unlock'), eq(auditLog.actorAccountId, receptionAccountId)),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(row?.after).toMatchObject({
      authMethod: 'offline_token',
      through: 'bridge',
      stationId: tillId,
    });
  });

  it('finds nobody, signs the family up, adds a child and confirms the visit — all on the box', async () => {
    const missed = await call(
      'GET',
      bridgePath(tillId, `members/lookup?phone=${encodeURIComponent(phone)}`),
      cookieA,
    );
    expect(missed.statusCode).toBe(200);
    expect(missed.body.member).toBeNull();

    const created = await call(
      'POST',
      bridgePath(tillId, 'intents'),
      cookieA,
      intent('member.create', { memberId: survivorId, phone, nickname: 'Signed up at reception' }),
    );
    expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
    expect((created.body.result as { member: { id: string } }).member.id).toBe(survivorId);

    const child1 = await call(
      'POST',
      bridgePath(tillId, 'intents'),
      cookieA,
      intent('child.create', {
        childId: childAtReception,
        memberId: survivorId,
        name: 'Ploy',
        ageYears: 6,
        allergies: 'Peanuts',
      }),
    );
    expect(child1.statusCode, JSON.stringify(child1.body)).toBe(200);

    const edited = await call(
      'POST',
      bridgePath(tillId, 'intents'),
      cookieA,
      intent('child.update', { childId: childAtReception, allergies: 'Peanuts, sesame' }),
    );
    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);

    const visit = await call(
      'POST',
      bridgePath(tillId, 'intents'),
      cookieA,
      intent('visit.create', {
        visitId: visitAtReception,
        memberId: survivorId,
        childIds: [childAtReception],
      }),
    );
    expect(visit.statusCode, JSON.stringify(visit.body)).toBe(200);

    const found = await call(
      'GET',
      bridgePath(tillId, `members/lookup?phone=${encodeURIComponent('089 999 0001')}`),
      cookieA,
    );
    const family = found.body.member as {
      id: string;
      source: string;
      children: Array<{ id: string; allergies: string }>;
    };
    expect(family.id).toBe(survivorId);
    expect(family.source).toBe('overlay');
    expect(family.children).toEqual([
      expect.objectContaining({ id: childAtReception, allergies: 'Peanuts, sesame' }),
    ]);

    // Nothing has reached the platform: the link is down.
    expect(await ctx.db.select().from(member).where(eq(member.phone, phone))).toEqual([]);
  });

  it('builds a priced cart from the box’s catalogue, to the satang the platform quoted', async () => {
    const priced = await call(
      'POST',
      bridgePath(tillId, 'intents'),
      cookieA,
      intent('cart.quote', { lines: [{ id: cartLineId, packageId, kids: 2, adults: 1 }] }),
    );
    expect(priced.statusCode, JSON.stringify(priced.body)).toBe(200);
    const quote = (
      priced.body.result as {
        quote: {
          source: string;
          totals: { grossSatang: number };
          lineTotals: Record<string, number>;
          catalogueVersion: string | null;
        };
      }
    ).quote;
    expect(quote.source).toBe('box');
    expect(quote.totals.grossSatang).toBe(platformGross);
    expect(quote.lineTotals[cartLineId]).toBe(platformLineTotal);
    expect(quote.catalogueVersion).toMatch(/^[0-9a-f]{16}$/);
  });

  it('and paying reaches the box’s sale queue — round 4 (`offline-selling.test.ts` sells through it)', async () => {
    // A money intent is no longer refused as unavailable: it is read, and one
    // that names no sale is refused as the unreadable request it is.
    const pay = await call(
      'POST',
      bridgePath(tillId, 'intents'),
      cookieA,
      intent('sale.finalise', {}),
    );
    expect(pay.statusCode).toBe(400);
    expect(pay.body.error).toMatchObject({ code: 'VALIDATION' });
  });

  it('the same family at Counter 2, through that box’s own bridge with a fresh sign-in', async () => {
    const bridge = agentB.bridge()!;
    const opened = await bridge.unlock(counterId, {
      password: RECEPTION.password,
      accountId: receptionAccountId,
    });
    expect(opened.response.method).toBe('offline_sign_in');
    expect(opened.response.offlineFresh).toBe(true);
    const caller = (await bridge.authenticate(counterId, opened.session)) as BridgeTillCaller;
    // Counter 2's box has never heard of the family: the link was down.
    expect(await bridge.lookup(counterId, caller, phone)).toBeNull();
    await bridge.intent(
      counterId,
      caller,
      intent('member.create', { memberId: discardedId, phone, nickname: 'Signed up at counter 2' }),
    );
    await bridge.intent(
      counterId,
      caller,
      intent('child.create', {
        childId: newId(),
        memberId: discardedId,
        name: 'Ploy',
        allergies: 'Peanuts and milk',
      }),
    );
  });

  it('the link comes back: one member, the alias applied, both children kept and the member flagged (OD-7)', async () => {
    link.cut = false;
    await agentA.setOffline(false);
    await agentA.outbox()!.flush();
    await agentB.setOffline(false);
    await agentB.outbox()!.flush();

    const survivors = await ctx.db.select().from(member).where(eq(member.phone, phone));
    expect(survivors.map((m) => m.id)).toEqual([survivorId]);
    expect(survivors[0]!.childrenReviewSince).not.toBeNull();

    const [alias] = await ctx.db
      .select()
      .from(memberAlias)
      .where(eq(memberAlias.aliasMemberId, discardedId));
    expect(alias?.memberId).toBe(survivorId);

    const kids = await ctx.db.select().from(child).where(eq(child.memberId, survivorId));
    expect(kids.map((k) => k.allergies).sort()).toEqual(['Peanuts and milk', 'Peanuts, sesame']);

    const [merge] = await ctx.db
      .select()
      .from(syncAnomaly)
      .where(
        and(
          eq(syncAnomaly.kind, 'merge'),
          sql`${syncAnomaly.detail}->>'discardedMemberId' = ${discardedId}`,
        ),
      );
    expect(merge?.detail).toMatchObject({
      survivingMemberId: survivorId,
      discardedMemberId: discardedId,
    });

    // Nothing waited in quarantine for a member that was never written.
    const quarantined = await ctx.db.select().from(syncQuarantine);
    expect(quarantined.filter((q) => q.errorCode === 'SYNC_MEMBER_ABSENT')).toEqual([]);

    // The fresh sign-in is on the record of what it did.
    const [createdAtCounter] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'member.merge'), eq(auditLog.entityId, survivorId)))
      .limit(1);
    expect(createdAtCounter?.after).toMatchObject({ offlineFresh: true });
  });

  it('Counter 2 pulls: its overlay gives way to the survivor, who carries both children and the flag', async () => {
    await agentB.syncCache();
    const bridge = agentB.bridge()!;
    const opened = await bridge.unlock(counterId, {
      token: tokenB.token,
      password: RECEPTION.password,
    });
    const caller = (await bridge.authenticate(counterId, opened.session)) as BridgeTillCaller;
    const family = await bridge.lookup(counterId, caller, phone);
    expect(family?.id).toBe(survivorId);
    expect(family?.source).toBe('cache');
    expect(family?.children).toHaveLength(2);
    expect(family?.childrenReviewSince).not.toBeNull();
    expect(await bridge.survivorOf(discardedId)).toBe(survivorId);
    expect(await boxStoreFor(ctx.db).allOverlay(agentB.state.boxId!)).toEqual([]);
  });

  it('a visit that confirms the children clears the flag', async () => {
    const kids = await ctx.db
      .select({ id: child.id })
      .from(child)
      .where(eq(child.memberId, survivorId));
    const res = await call(
      'POST',
      '/visits',
      cookieA,
      { id: newId(), memberId: survivorId, childIds: kids.map((k) => k.id) },
      { 'idempotency-key': newId() },
    );
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const [after] = await ctx.db.select().from(member).where(eq(member.id, survivorId));
    expect(after!.childrenReviewSince).toBeNull();
  });
});

describe('a tier changed at a counter with no internet (OD-11)', () => {
  it('is a member.tier_changed fact: the evidence and the tier land together, once', async () => {
    const [seeded] = await ctx.db.select().from(member).where(eq(member.phone, '+66844444444'));
    expect(seeded).toBeTruthy();
    const verificationId = newId();
    link.cut = true;
    await agentB.setOffline(true, { reason: 'tier change offline' });
    const bridge = agentB.bridge()!;
    const opened = await bridge.unlock(counterId, {
      token: tokenB.token,
      password: RECEPTION.password,
    });
    const caller = (await bridge.authenticate(counterId, opened.session)) as BridgeTillCaller;
    const answer = await bridge.intent(
      counterId,
      caller,
      intent('member.tier_change', {
        direction: 'upgrade',
        memberId: seeded!.id,
        verificationId,
        toTier: 'expat',
        evidenceType: 'Passport',
        evidenceExpiresAt: '2030-01-01',
      }),
    );
    expect((answer.result as { member: { tierCode: string } }).member.tierCode).toBe('expat');
    link.cut = false;
    await agentB.setOffline(false);
    await agentB.outbox()!.flush();
    const [after] = await ctx.db.select().from(member).where(eq(member.id, seeded!.id));
    expect(after!.tierCode).toBe('expat');
    const [evidence] = await ctx.db
      .select()
      .from(memberTierVerification)
      .where(eq(memberTierVerification.id, verificationId));
    expect(evidence).toMatchObject({
      memberId: seeded!.id,
      toTier: 'expat',
      evidenceType: 'Passport',
    });
    expect(evidence!.verifiedByAccountId).toBe(receptionAccountId);
  });

  it('a document with no expiry date replays as evidence that never expires', async () => {
    const [seeded] = await ctx.db.select().from(member).where(eq(member.phone, '+66844444444'));
    const verificationId = newId();
    link.cut = true;
    await agentB.setOffline(true, { reason: 'tier change offline, no expiry' });
    const bridge = agentB.bridge()!;
    const opened = await bridge.unlock(counterId, {
      token: tokenB.token,
      password: RECEPTION.password,
    });
    const caller = (await bridge.authenticate(counterId, opened.session)) as BridgeTillCaller;
    const answer = await bridge.intent(
      counterId,
      caller,
      intent('member.tier_change', {
        direction: 'upgrade',
        memberId: seeded!.id,
        verificationId,
        toTier: 'thai',
        evidenceType: 'Residence certificate',
      }),
    );
    expect((answer.result as { member: { tierCode: string } }).member.tierCode).toBe('thai');
    link.cut = false;
    await agentB.setOffline(false);
    await agentB.outbox()!.flush();
    const [after] = await ctx.db.select().from(member).where(eq(member.id, seeded!.id));
    expect(after!.tierCode).toBe('thai');
    const [evidence] = await ctx.db
      .select()
      .from(memberTierVerification)
      .where(eq(memberTierVerification.id, verificationId));
    expect(evidence).toMatchObject({ toTier: 'thai', evidenceType: 'Residence certificate' });
    expect(evidence!.evidenceExpiresAt).toBeNull();
    const [row] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, verificationId), eq(auditLog.action, 'member.tier_verify')));
    expect((row!.after as { evidenceExpiresAt: unknown }).evidenceExpiresAt).toBeNull();
  });
});

describe('the deny-list refuses (OD-2, OD-6)', () => {
  it('a shift token revoked while the box was online cannot unlock at the box once the link is down', async () => {
    try {
      await revokedCannotUnlock();
    } finally {
      link.cut = false;
      await agentA.setOffline(false);
    }
  });
});

async function revokedCannotUnlock(): Promise<void> {
  await ctx.db
    .update(staffToken)
    .set({ revokedAt: new Date(), revokedReason: 'admin' })
    .where(eq(staffToken.jti, tokenA.jti));
  await agentA.syncCache();
  const deny = await boxStoreFor(ctx.db).readBundle(agentA.state.boxId!, 'deny_list');
  expect(JSON.stringify(deny?.payload)).toContain(tokenA.jti);
  link.cut = true;
  await agentA.setOffline(true, { reason: 'the mall link is down again' });
  expect((await call('POST', '/auth/lock', cookieA)).statusCode).toBe(200);
  const refused = await call('POST', bridgePath(tillId, 'unlock'), cookieA, {
    token: tokenA.token,
    password: RECEPTION.password,
  });
  expect(refused.statusCode).toBe(401);
  expect((refused.body.error as { code: string }).code).toBe('STAFF_TOKEN_REVOKED');
  // And through the box's own bridge, the same answer.
  await expect(
    agentA.bridge()!.unlock(tillId, { token: tokenA.token, password: RECEPTION.password }),
  ).rejects.toMatchObject({ code: 'STAFF_TOKEN_REVOKED' });
}

describe('the customer display follows its box (OD-10)', () => {
  it('reads the redacted document through the bridge with its paired credential, toggle on', async () => {
    const bearer = 'ab'.repeat(32);
    const minted = await call(
      'POST',
      '/display/pairing',
      null,
      {},
      { authorization: `Bearer ${bearer}` },
    );
    expect(minted.statusCode, JSON.stringify(minted.body)).toBe(200);
    const claimed = await call(
      'POST',
      `/stations/${tillId}/displays/claim`,
      adminCookie,
      {
        pairingCode: minted.body.pairingCode,
        name: 'Reception display',
      },
      { 'idempotency-key': newId() },
    );
    expect(claimed.statusCode, JSON.stringify(claimed.body)).toBe(200);

    await agentA.setOffline(true, { reason: 'display follows the box' });
    const read = await call('GET', bridgePath(tillId, 'display/session'), null, undefined, {
      authorization: `Bearer ${bearer}`,
    });
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
    const document = read.body.document as { stationId: string; lease: unknown };
    expect(document.stationId).toBe(tillId);
    expect(document.lease).toBeNull();
    // Another station's path is refused for this display.
    const other = await call('GET', bridgePath(counterId, 'display/session'), null, undefined, {
      authorization: `Bearer ${bearer}`,
    });
    expect(other.statusCode).toBe(403);

    // A Pi holds only the hash, from its station_config scope.
    await agentA.setOffline(false);
    await agentA.syncCache();
    const onBox = await agentA.bridge()!.displayCaller(tillId, bearer);
    expect(onBox?.kind).toBe('display');
  });
});

describe('the cache a counter box holds (plan §2.3)', () => {
  it('catalogue, staff, members and station_config carry what the box reads offline', async () => {
    const store = boxStoreFor(ctx.db);
    const boxId = agentA.state.boxId!;
    const catalogue = (await store.readBundle(boxId, 'catalogue'))!.payload.items as Array<
      Record<string, unknown>
    >;
    expect(Object.keys(catalogue[0]!)).toEqual(
      expect.arrayContaining([
        'modifierGroups',
        'modifierOptions',
        'modifierLinks',
        'paymentMethods',
        'promotions',
        'receiptHeader',
        'version',
      ]),
    );
    const staff = (await store.readBundle(boxId, 'staff'))!.payload.items as Array<{
      accountId: string;
      permissions: string[];
    }>;
    const reception = staff.find((s) => s.accountId === receptionAccountId)!;
    expect(reception.permissions).toEqual(
      expect.arrayContaining(['pos:member:read', 'pos:member:create', 'pos:sale:create']),
    );
    expect(reception.permissions).not.toContain('pos:member:tier_downgrade');
    const config = (await store.readBundle(boxId, 'station_config'))!.payload.items as Array<{
      id: string;
      offlinePolicy: unknown;
    }>;
    expect(config.find((s) => s.id === tillId)?.offlinePolicy).toMatchObject({
      catalogueRefuseAfterS: 604800,
    });
    // Operator-wide products are on the box too, as the platform's cart reads them.
    const wide = await ctx.db
      .select({ id: product.id })
      .from(product)
      .where(sql`${product.branchId} is null and ${product.archivedAt} is null`);
    const held = new Set((catalogue[0]!.products as Array<{ id: string }>).map((p) => p.id));
    expect(wide.every((p) => held.has(p.id))).toBe(true);
  });
});
