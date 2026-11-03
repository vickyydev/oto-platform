import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hash } from '@node-rs/argon2';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alert, auditLog, band, bandEvent, boothConfigVersion, boothPrize, redemptionThrottle, schema as s, spin, station, syncEvent, ticketPackage, voucher,
  voucherDefinition, voucherMiss,
} from '@oto/db';
import { bandShortCode, mintBoothCode, newId } from '@oto/shared';
import { FakeOtoApp, OTOAPP_WORDS, fakeUser, seedFakeOtoAppWorld, type FakeOtoAppWorld } from './fake-otoapp';
import {
  ADMIN, BRANCH_MANAGER, CENTRAL_BRANCH_CODE, CHALONG_BRANCH_CODE, CHALONG_MANAGER, OTO_OPERATOR_NAME, RECEPTION, SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME, boxBySlot, branchIdByCode, createTestContext, operatorIdByName, signInAs, takeStation, teardownAll, type TestContext,
} from './helpers';

/**
 * SCRUM-674 — the readers behind the Support lookup's three sections that said
 * "not built": each through real HTTP as the person asking, each with its
 * positive, empty, denied and foreign-scope answer, native to the app that owns
 * it. The OTO App's own fences are proved in its own process by
 * `apps/oto-app/tests/support-lookup.check.ts`; here the seam is proved against
 * a fake that exchanges every hand-off at this api.
 */

const PASSWORD = 'supportreaders1234';
const KID = 'k1';
const SECRET = 'support-readers-handoff-secret-0123456789abcdef';

let ctx: TestContext;
let oto: string, central: string, chalong: string, foreignBranch: string;
let admin: string, reception: string, centralManager: string, chalongManager: string, foreignAdmin: string;
/** The Console door and the lookup, and nothing that reads a gate or a voucher. */
let doorOnly: string;
/** The lookup operator-wide, with the gate and voucher readers at Central alone. */
let centralReader: string;
let centralLane: string, chalongLane: string;
let boxId: string;
let fake: FakeOtoApp;
let world: FakeOtoAppWorld;

type Res = { status: number; body: any; raw: string }; // eslint-disable-line @typescript-eslint/no-explicit-any -- asserted field by field
async function get(cookie: string | null, url: string): Promise<Res> {
  const res = await ctx.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  let body: unknown = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, raw: res.body };
}
const lookup = (cookie: string, q: string, kind: string) => get(cookie, `/console/support/lookup?q=${encodeURIComponent(q)}&kind=${kind}`);
const sectionOf = (res: Res, key: string) => (res.body.sections as Array<{ key: string; status: string; rows: any[]; rowCount: number; note: string | null; app: string; permission: string | null }>) // eslint-disable-line @typescript-eslint/no-explicit-any -- row shapes belong to each app
  .find(sec => sec.key === key)!;
const lookupAudits = () => ctx.db.select().from(auditLog).where(eq(auditLog.action, 'console.support.lookup')).orderBy(desc(auditLog.createdAt));
const totalAudits = async () => (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(auditLog))[0]!.n;

/** One active account holding a role of exactly these permissions at each scope named. */
async function person(phone: string, grants: Array<{ permissions: string[]; scopeType: 'operator' | 'branch'; scopeId: string }>): Promise<string> {
  const accountId = newId();
  await ctx.db.insert(s.account).values({ id: accountId, operatorId: oto, phone, passwordHash: await hash(PASSWORD), phoneVerifiedAt: new Date(), status: 'active' });
  for (const grant of grants) {
    const roleId = newId();
    await ctx.db.insert(s.role).values({ id: roleId, operatorId: oto, name: `ZZ TEST 674 ${roleId}` });
    await ctx.db.insert(s.rolePermission).values(grant.permissions.map(permission => ({ id: newId(), roleId, permission })));
    await ctx.db.insert(s.roleAssignment).values({ id: newId(), accountId, roleId, scopeType: grant.scopeType, scopeId: grant.scopeId });
  }
  return signInAs(ctx.app, phone, PASSWORD);
}

async function sellAdultBand(): Promise<{ id: string; code: string; saleId: string }> {
  const [till] = await ctx.db.select().from(station).where(eq(station.codePrefix, 'T1'));
  const [pkg] = await ctx.db.select().from(ticketPackage).where(and(eq(ticketPackage.branchId, till!.branchId), eq(ticketPackage.name, '2 Hours Play')));
  const saleId = newId();
  const rung = await ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie: reception },
    payload: { id: saleId, stationId: till!.id, lines: [{ id: newId(), packageId: pkg!.id, kids: 0, adults: 1 }] } });
  expect(rung.statusCode, rung.body).toBe(200);
  const paid = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload: {} });
  expect(paid.statusCode, paid.body).toBe(200);
  const [row] = await ctx.db.select().from(band).where(eq(band.saleId, saleId));
  return { id: row!.id, code: row!.code, saleId };
}

async function pass(bandId: string, kind: 'entry' | 'exit' | 'denied' | 'timeout' | 'alarm', stationId: string, at: Date, detail: Record<string, unknown> = {}) {
  const id = newId();
  await ctx.db.insert(bandEvent).values({ id, bandId, kind, stationId, boxId, detail: { direction: kind === 'exit' ? 'exit' : 'entry', side: 'left', ...detail }, createdAt: at });
  return id;
}

/** `count` refusals of one band at one lane, a minute apart. */
const refusals = (bandId: string, stationId: string, count: number, day: number) => ctx.db.insert(bandEvent).values(
  Array.from({ length: count }, (_, i) => ({ id: newId(), bandId, kind: 'denied' as const, stationId, boxId, detail: { reason: 'GATE_BUSY' }, createdAt: new Date(Date.UTC(2030, 3, day, 0, i)) })));

/** The Console's compact list shows the first eight scalar facts of a row: `rowFacts` in `apps/console/src/lib/supportRules.ts`, pinned there on these shapes. */
const onTheScreen = (row: Record<string, unknown>) => Object.keys(row).filter(key => row[key] === null || typeof row[key] !== 'object').slice(0, 8);

beforeAll(async () => {
  fake = await FakeOtoApp.start();
  ctx = await createTestContext({ env: {
    PROCESS_ROLES: 'api',
    HANDOFF_SIGNING_KEY: `${KID}:${SECRET}`,
    HANDOFF_APP_ORIGINS: `oto_app=${fake.origin}`,
    // The fake exchanges with its own Origin, which the api's write check must allow.
    ALLOWED_ORIGINS: fake.origin,
  } });
  fake.platform = ctx.app;
  world = seedFakeOtoAppWorld(fake);
  oto = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  foreignBranch = await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  centralManager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  foreignAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  doorOnly = await person('+66810674001', [{ permissions: ['app:console:access', 'console:support:lookup'], scopeType: 'operator', scopeId: oto }]);
  centralReader = await person('+66810674002', [
    { permissions: ['app:console:access', 'console:support:lookup'], scopeType: 'operator', scopeId: oto },
    { permissions: ['pos:checkin:read', 'admin:booth:read'], scopeType: 'branch', scopeId: central },
  ]);
  boxId = (await boxBySlot(ctx.db, 'virtual-2')).id;
  centralLane = newId(); chalongLane = newId();
  await ctx.db.insert(station).values([
    { id: centralLane, operatorId: oto, branchId: central, boxId, name: 'ZZ TEST Central lane', kind: 'gate' },
    { id: chalongLane, operatorId: oto, branchId: chalong, boxId, name: 'ZZ TEST Chalong lane', kind: 'gate' },
  ]);
}, 300_000);
afterAll(async () => { try { await ctx?.close(); await fake?.stop(); } finally { await teardownAll(); } });

describe('SCRUM-674 one band’s gate journal', () => {
  it('answers a band’s passages at one park, newest first, by full or short code, and never its signed code', async () => {
    const worn = await sellAdultBand();
    await pass(worn.id, 'entry', centralLane, new Date('2030-03-01T03:00:00Z'));
    await pass(worn.id, 'denied', centralLane, new Date('2030-03-01T03:30:00Z'), { reason: 'ANTI_PASSBACK' });
    await pass(worn.id, 'alarm', centralLane, new Date('2030-03-01T03:40:00Z'), { alarm: 'tailgating' });
    await pass(worn.id, 'exit', centralLane, new Date('2030-03-01T04:00:00Z'), { exitWithoutEntry: true, offline: true });
    // Not a gate fact: the journal is the gate's, not everything that ever happened to the band.
    await ctx.db.insert(bandEvent).values({ id: newId(), bandId: worn.id, kind: 'reprinted', stationId: centralLane, boxId, detail: {}, createdAt: new Date('2030-03-01T05:00:00Z') });

    const short = bandShortCode(worn.code)!;
    for (const key of [worn.code, short]) {
      const res = await get(reception, `/branches/${central}/gate-events?band=${encodeURIComponent(key)}`);
      expect(res.status, res.raw).toBe(200);
      expect(res.body.truncated).toBe(false);
      expect(res.body.events.map((e: { kind: string }) => e.kind)).toEqual(['exit', 'alarm', 'denied', 'entry']);
      expect(res.body.events[0]).toMatchObject({ bandId: worn.id, bandShortCode: short, bandKind: 'adult', stationName: 'ZZ TEST Central lane', stationId: centralLane,
        at: '2030-03-01T04:00:00.000Z', clockTrusted: true, direction: 'exit', exitWithoutEntry: true, offline: true, revoked: false });
      expect(res.body.events[1]).toMatchObject({ alarm: 'tailgating' });
      expect(res.body.events[2]).toMatchObject({ reason: 'ANTI_PASSBACK' });
      expect(res.raw).not.toContain(worn.code);
    }
  });

  it('places a passage whose box clock was not trusted when the cloud took it, as the occupancy count does', async () => {
    const worn = await sellAdultBand();
    const envelope = newId();
    const stamp = new Date('2030-03-02T01:00:00Z');
    const receivedAt = new Date('2030-03-02T05:00:00Z');
    await ctx.db.insert(syncEvent).values({ eventId: envelope, boxId, journalEpoch: 1, boxSeq: randomInt(1_000_000), type: 'band.gate_event', occurredAt: stamp, receivedAt,
      clockTrust: 'untrusted', businessDate: '2030-03-02', operatorId: oto, branchId: central, stationId: centralLane, actorKind: 'box', payload: {}, payloadHash: 'a'.repeat(64), sig: 'test',
    } as typeof syncEvent.$inferInsert);
    await pass(worn.id, 'entry', centralLane, stamp, { sourceEventId: envelope });
    const res = await get(reception, `/branches/${central}/gate-events?band=${encodeURIComponent(worn.code)}`);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.events).toEqual([expect.objectContaining({ at: receivedAt.toISOString(), clockTrusted: false })]);
  });

  it('answers empty for a band with no journal and for a code that is no band, and is bounded', async () => {
    const quiet = await sellAdultBand();
    for (const key of [quiet.code, 'T1-ZZZZZZ', 'not-a-band']) {
      const res = await get(reception, `/branches/${central}/gate-events?band=${encodeURIComponent(key)}`);
      expect(res.status, res.raw).toBe(200);
      expect(res.body).toEqual({ events: [], limit: 50, truncated: false });
    }
    const busy = await sellAdultBand();
    await ctx.db.insert(bandEvent).values(Array.from({ length: 53 }, (_, i) => ({ id: newId(), bandId: busy.id, kind: 'denied' as const, stationId: centralLane, boxId,
      detail: { reason: 'GATE_BUSY' }, createdAt: new Date(Date.UTC(2030, 2, 3, 0, i)) })));
    const res = await get(reception, `/branches/${central}/gate-events?band=${encodeURIComponent(busy.code)}`);
    expect(res.body.events).toHaveLength(50);
    expect(res.body.truncated).toBe(true);
    expect(res.body.events[0].at).toBe(new Date(Date.UTC(2030, 2, 3, 0, 52)).toISOString());
    const console = await lookup(admin, busy.code, 'band');
    expect(sectionOf(console, 'pos.gate_events')).toMatchObject({ status: 'found', rowCount: 50, note: 'Showing the newest 50 at Oto Play Park, Central Floresta.' });
  });

  it('notes a limit only for the park the reader actually cut, not by how many rows the parks add up to', async () => {
    // Fifty-five between two parks, neither one cut.
    const twoParks = await sellAdultBand();
    await refusals(twoParks.id, centralLane, 30, 1);
    await refusals(twoParks.id, chalongLane, 25, 2);
    expect(sectionOf(await lookup(admin, twoParks.code, 'band'), 'pos.gate_events')).toMatchObject({ status: 'found', rowCount: 55, note: null });
    // Exactly the limit at one park: all of it is there.
    const exactly = await sellAdultBand();
    await refusals(exactly.id, centralLane, 50, 3);
    expect(sectionOf(await lookup(admin, exactly.code, 'band'), 'pos.gate_events')).toMatchObject({ status: 'found', rowCount: 50, note: null });
    // One cut and one not: only the one that was.
    const oneCut = await sellAdultBand();
    await refusals(oneCut.id, centralLane, 51, 4);
    await refusals(oneCut.id, chalongLane, 3, 5);
    expect(sectionOf(await lookup(admin, oneCut.code, 'band'), 'pos.gate_events')).toMatchObject({ status: 'found', rowCount: 53, note: 'Showing the newest 50 at Oto Play Park, Central Floresta.' });
  });

  it('leads each row with what the desk asks, so those facts reach the Console’s compact list', async () => {
    const worn = await sellAdultBand();
    await pass(worn.id, 'denied', centralLane, new Date('2030-03-08T03:30:00Z'), { reason: 'ANTI_PASSBACK' });
    await pass(worn.id, 'exit', centralLane, new Date('2030-03-08T04:00:00Z'), { exitWithoutEntry: true, offline: true });
    const untrusted = newId();
    const stamp = new Date('2030-03-08T01:00:00Z');
    await ctx.db.insert(syncEvent).values({ eventId: untrusted, boxId, journalEpoch: 1, boxSeq: randomInt(1_000_000), type: 'band.gate_event', occurredAt: stamp, receivedAt: new Date('2030-03-08T02:00:00Z'),
      clockTrust: 'untrusted', businessDate: '2030-03-08', operatorId: oto, branchId: central, stationId: centralLane, actorKind: 'box', payload: {}, payloadHash: 'b'.repeat(64), sig: 'test',
    } as typeof syncEvent.$inferInsert);
    await pass(worn.id, 'entry', centralLane, stamp, { sourceEventId: untrusted });
    await pass(worn.id, 'entry', chalongLane, new Date('2030-03-08T06:00:00Z'));

    const rows = sectionOf(await lookup(admin, worn.code, 'band'), 'pos.gate_events').rows as Array<Record<string, unknown>>;
    const byKind = (kind: string, stationName: string) => rows.find(row => row.kind === kind && row.stationName === stationName)!;
    expect(onTheScreen(byKind('entry', 'ZZ TEST Chalong lane'))).toEqual(['at', 'kind', 'direction', 'stationName', 'park', 'bandShortCode', 'bandKind', 'id']);
    expect(onTheScreen(byKind('denied', 'ZZ TEST Central lane'))).toEqual(['at', 'kind', 'direction', 'stationName', 'park', 'reason', 'bandShortCode', 'bandKind']);
    expect(onTheScreen(byKind('exit', 'ZZ TEST Central lane'))).toEqual(['at', 'kind', 'direction', 'stationName', 'park', 'exitWithoutEntry', 'offline', 'bandShortCode']);
    expect(onTheScreen(byKind('entry', 'ZZ TEST Central lane'))).toEqual(['at', 'kind', 'direction', 'stationName', 'park', 'clockTrusted', 'bandShortCode', 'bandKind']);
    expect(byKind('entry', 'ZZ TEST Central lane').clockTrusted).toBe(false);
    // Only the order changed: the rest of the row is behind them.
    expect(byKind('entry', 'ZZ TEST Chalong lane')).toMatchObject({ bandId: worn.id, stationId: chalongLane, reason: null, alarm: null, clockTrusted: true, revoked: false, side: 'left' });
  });

  it('refuses the anonymous, an account without the reader, and a park out of the caller’s reach', async () => {
    const worn = await sellAdultBand();
    await pass(worn.id, 'entry', centralLane, new Date('2030-03-04T03:00:00Z'));
    const url = `/branches/${central}/gate-events?band=${encodeURIComponent(worn.code)}`;
    expect((await get(null, url)).status).toBe(401);
    expect((await get(doorOnly, url)).status).toBe(403);
    expect((await get(chalongManager, url)).status).toBe(403);
    expect((await get(centralManager, url)).status).toBe(200);
  });

  it('holds to the gate’s park and to the operator', async () => {
    const worn = await sellAdultBand();
    await pass(worn.id, 'entry', centralLane, new Date('2030-03-05T03:00:00Z'));
    await pass(worn.id, 'entry', chalongLane, new Date('2030-03-05T06:00:00Z'));
    // A Central band through Chalong's gate is in Chalong's journal, and Chalong reads only that.
    const there = await get(chalongManager, `/branches/${chalong}/gate-events?band=${encodeURIComponent(worn.code)}`);
    expect(there.body.events.map((e: { stationName: string }) => e.stationName)).toEqual(['ZZ TEST Chalong lane']);
    const here = await get(centralManager, `/branches/${central}/gate-events?band=${encodeURIComponent(worn.code)}`);
    expect(here.body.events.map((e: { stationName: string }) => e.stationName)).toEqual(['ZZ TEST Central lane']);
    // Another operator: not this park, and not this band even at its own park.
    const foreignPark = await get(foreignAdmin, `/branches/${central}/gate-events?band=${encodeURIComponent(worn.code)}`);
    expect([foreignPark.status, foreignPark.body.error.code]).toEqual([404, 'BRANCH_NOT_FOUND']);
    const ownPark = await get(foreignAdmin, `/branches/${foreignBranch}/gate-events?band=${encodeURIComponent(worn.code)}`);
    expect([ownPark.status, ownPark.body.events]).toEqual([200, []]);
  });

  it('reaches the Console’s lookup through that reader, one data-access row, nothing else written', async () => {
    const worn = await sellAdultBand();
    await pass(worn.id, 'entry', centralLane, new Date('2030-03-06T03:00:00Z'));
    await pass(worn.id, 'entry', chalongLane, new Date('2030-03-06T06:00:00Z'));
    const before = await totalAudits();
    const res = await lookup(admin, worn.code, 'band');
    expect(res.status, res.raw).toBe(200);
    const gate = sectionOf(res, 'pos.gate_events');
    expect(gate).toMatchObject({ app: 'pos', status: 'found', rowCount: 2, permission: 'pos:checkin:read', note: null });
    expect(gate.rows.map(row => row.park).sort()).toEqual(['Oto Play Park, Central Floresta', 'Oto Play Park, Robinson Chalong'].sort());
    expect(res.raw).not.toContain(worn.code);
    expect(await totalAudits()).toBe(before + 1);
    const [row] = await lookupAudits();
    expect(row!.entityType).toBe('data_access');
    expect((row!.after as { sections: unknown[] }).sections).toContainEqual({ key: 'pos.gate_events', app: 'pos', kind: 'band', status: 'found', rows: 2 });
    expect(JSON.stringify(row)).not.toContain(worn.code);
    expect(JSON.stringify(row)).not.toContain(bandShortCode(worn.code)!);

    // Denied, not missing, for a reader without it; only the parks it reaches for a reader who holds it at one.
    expect(sectionOf(await lookup(doorOnly, worn.code, 'band'), 'pos.gate_events')).toMatchObject({ status: 'denied', rowCount: 0 });
    const partial = sectionOf(await lookup(centralReader, worn.code, 'band'), 'pos.gate_events');
    expect(partial).toMatchObject({ status: 'found', rowCount: 1 });
    expect(partial.rows[0]).toMatchObject({ stationName: 'ZZ TEST Central lane', park: 'Oto Play Park, Central Floresta' });
    expect(partial.note).toContain('Not readable at Oto Play Park, Robinson Chalong');
    expect(sectionOf(await lookup(admin, 'T1-ZZZZZZ', 'band'), 'pos.gate_events')).toMatchObject({ status: 'empty', rowCount: 0 });
  });
});

describe('SCRUM-674 one voucher code', () => {
  let defId: string;
  async function issue(branchId: string, values: Partial<typeof voucher.$inferInsert> = {}) {
    const code = mintBoothCode('B1', max => randomInt(max));
    const id = newId();
    await ctx.db.insert(voucher).values({ id, operatorId: oto, branchId, voucherDefinitionId: defId, code, source: 'booth', status: 'issued',
      issuedAt: new Date(), expiresAt: new Date(Date.now() + 14 * 86_400_000), ...values });
    return { id, code };
  }
  const wrongCode = () => mintBoothCode('B1', max => randomInt(max));
  const writesOfVouchers = async () => ({
    throttles: (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(redemptionThrottle))[0]!.n,
    misses: (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(voucherMiss))[0]!.n,
    locks: (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(eq(auditLog.action, 'voucher.redemption_locked')))[0]!.n,
    alerts: (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(alert).where(eq(alert.category, 'redemption.probing')))[0]!.n,
  });

  beforeAll(async () => {
    defId = newId();
    await ctx.db.insert(voucherDefinition).values({ id: defId, operatorId: oto, code: `zz-674-${defId}`, nameEn: 'ZZ TEST 674 voucher', kind: 'discount', valueType: 'amount', valueSatang: 10_000 });
  });

  it('answers what a code is, with its last four characters and no person', async () => {
    const accountId = (await ctx.db.select().from(s.account).where(eq(s.account.phone, RECEPTION.phone)))[0]!.id;
    const { id, code } = await issue(central, { issuedByAccountId: accountId });
    const res = await get(admin, `/vouchers/by-code?code=${code}`);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.vouchers).toEqual([expect.objectContaining({ record: 'voucher', id, branchId: central, branchName: 'Oto Play Park, Central Floresta', status: 'issued', codeLast4: code.slice(-4), redeemed: null,
      type: expect.objectContaining({ id: defId, nameEn: 'ZZ TEST 674 voucher', kind: 'discount' }), value: expect.objectContaining({ kind: 'money' }) })]);
    expect(res.raw).not.toContain(code);
    expect(Object.keys(res.body.vouchers[0])).not.toEqual(expect.arrayContaining(['issuedBy']));
    expect(Object.keys(res.body.vouchers[0])).not.toEqual(expect.arrayContaining(['staffLabel']));
    expect(res.raw).not.toContain(accountId);
  });

  it('answers a redeemed prize voucher: its worth, where it was used, on which receipt, and nobody by name', async () => {
    const staffOf = async (phone: string) => {
      const [row] = await ctx.db.select({ id: s.account.id, name: s.employee.name, nickname: s.employee.nickname }).from(s.account)
        .leftJoin(s.employee, eq(s.employee.id, s.account.employeeId)).where(eq(s.account.phone, phone));
      return row!;
    };
    const [redeemer, issuer] = [await staffOf(RECEPTION.phone), await staffOf(BRANCH_MANAGER.phone)];
    expect(redeemer.name ?? redeemer.nickname).toBeTruthy();
    const [booth] = await ctx.db.select().from(station).where(eq(station.name, 'Booth 1')).limit(1);
    const [version] = await ctx.db.select().from(boothConfigVersion).where(eq(boothConfigVersion.stationId, booth!.id)).orderBy(desc(boothConfigVersion.version)).limit(1);
    const [prize] = await ctx.db.select().from(boothPrize).where(and(eq(boothPrize.stationId, booth!.id), eq(boothPrize.nameEn, '100 THB Voucher')));
    const [till] = await ctx.db.select().from(station).where(eq(station.codePrefix, 'T1'));
    const { saleId } = await sellAdultBand();
    const [sale] = await ctx.db.select().from(s.sale).where(eq(s.sale.id, saleId));
    const [type] = await ctx.db.select().from(voucherDefinition).where(eq(voucherDefinition.id, prize!.voucherDefinitionId!));
    const redeemedAt = new Date('2030-03-09T05:00:00Z');
    const { id, code } = await issue(booth!.branchId, { voucherDefinitionId: type!.id, status: 'redeemed', issuedByAccountId: issuer.id, redeemedAt, saleId,
      redeemedByAccountId: redeemer.id, redeemedBranchId: till!.branchId, redeemedStationId: till!.id, printCount: 2 });
    const spinId = newId();
    await ctx.db.insert(spin).values({ id: spinId, operatorId: oto, branchId: booth!.branchId, stationId: booth!.id, boxId: booth!.boxId!, boothConfigVersionId: version!.id, outcome: 'prize',
      prizeId: prize!.id, voucherId: id, staffAccountId: issuer.id, simulated: false, occurredAt: new Date('2030-03-08T05:00:00Z'), businessDate: '2030-03-08' });
    // What the slip printed in its Staff row, which the ledger answers and this reader does not.
    await ctx.db.insert(auditLog).values({ id: newId(), action: 'spin.record', entityType: 'spin', entityId: spinId, after: { staffLabel: 'ZZ TEST ROSTER NAME' } });

    const res = await get(admin, `/vouchers/by-code?code=${code}`);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.vouchers).toEqual([expect.objectContaining({
      record: 'voucher', id, status: 'redeemed', codeLast4: code.slice(-4), printCount: 2, prize: { id: prize!.id, nameEn: '100 THB Voucher' },
      type: expect.objectContaining({ id: type!.id, nameEn: type!.nameEn }), value: expect.objectContaining({ kind: 'money', text: expect.stringContaining('off') }),
      redeemed: { at: redeemedAt.toISOString(), branchName: 'Oto Play Park, Central Floresta', stationName: till!.name, saleId, receiptNumber: sale!.receiptNumber },
      place: expect.objectContaining({ kind: 'booth', stationId: booth!.id }),
    })]);
    for (const person of [redeemer.id, issuer.id, redeemer.name, redeemer.nickname, issuer.name, issuer.nickname, 'ZZ TEST ROSTER NAME']) {
      if (person) expect(res.raw).not.toContain(person);
    }

    // On the Console: flat, and the facts asked about are the ones listed.
    const console = await lookup(admin, code, 'voucher');
    expect(console.status, console.raw).toBe(200);
    const [row] = sectionOf(console, 'pos.promo_voucher').rows as Array<Record<string, unknown>>;
    expect(onTheScreen(row!)).toEqual(['status', 'type', 'value', 'codeLast4', 'park', 'redeemedAt', 'redeemedWhere', 'receiptNumber']);
    expect(row).toMatchObject({ status: 'redeemed', type: type!.nameEn, redeemedAt: redeemedAt.toISOString(), redeemedWhere: `Oto Play Park, Central Floresta, ${till!.name}`,
      receiptNumber: sale!.receiptNumber, prize: '100 THB Voucher', saleId, printCount: 2, id });
    expect(Object.values(row!).filter(value => value !== null && typeof value === 'object')).toEqual([]);
    expect(console.raw).not.toContain(code);
    for (const person of [redeemer.id, issuer.id, 'ZZ TEST ROSTER NAME']) expect(console.raw).not.toContain(person);
  });

  it('lists a voucher not yet used by status, worth, park and expiry', async () => {
    const { code } = await issue(central);
    const [row] = sectionOf(await lookup(admin, code, 'voucher'), 'pos.promo_voucher').rows as Array<Record<string, unknown>>;
    expect(onTheScreen(row!)).toEqual(['status', 'type', 'value', 'codeLast4', 'park', 'expiresAt', 'issuedAt', 'issuedFrom']);
    expect(row).toMatchObject({ status: 'issued', type: 'ZZ TEST 674 voucher', redeemedAt: null, receiptNumber: null, prize: null });
  });

  it('answers a fixed-code type by its shared code, whatever its state', async () => {
    const id = newId();
    await ctx.db.insert(voucherDefinition).values({ id, operatorId: oto, code: `zz-674-fixed-${id}`, nameEn: 'ZZ TEST 674 fixed', kind: 'discount', valueType: 'percent', valueBp: 1000, codeMode: 'fixed', fixedCode: 'ZZFIX674', active: false });
    const res = await get(admin, '/vouchers/by-code?code=zzfix674');
    expect(res.status, res.raw).toBe(200);
    expect(res.body.vouchers).toEqual([expect.objectContaining({ record: 'voucher_type', id, codeLast4: 'X674', state: 'off', value: expect.objectContaining({ text: '10% off' }) })]);
    expect(res.raw).not.toContain('ZZFIX674');
    const [row] = sectionOf(await lookup(admin, 'ZZFIX674', 'voucher'), 'pos.promo_voucher').rows as Array<Record<string, unknown>>;
    expect(onTheScreen(row!)).toEqual(['record', 'state', 'type', 'value', 'codeLast4', 'id', 'typeKind']);
    expect(row).toMatchObject({ record: 'voucher_type', state: 'off', type: 'ZZ TEST 674 fixed', value: '10% off', codeLast4: 'X674' });
  });

  it('answers empty for a code nobody issued and for one that cannot be a voucher', async () => {
    for (const code of [wrongCode(), 'zz', '!!!!']) {
      const res = await get(admin, `/vouchers/by-code?code=${encodeURIComponent(code)}`);
      expect(res.status, res.raw).toBe(200);
      expect(res.body).toEqual({ vouchers: [] });
    }
  });

  it('finds a booth code in the grouped form people read off the screen, without being told it is a voucher', async () => {
    const { id, code } = await issue(central);
    const parts = [code.slice(0, 2), code.slice(2, 6), code.slice(6, 10), code.slice(10)];
    for (const typed of [parts.join(' '), parts.join('-'), code.toLowerCase()]) {
      const res = await get(admin, `/console/support/lookup?q=${encodeURIComponent(typed)}`);
      expect(res.status, res.raw).toBe(200);
      expect(res.body.kinds, typed).toContain('voucher');
      expect(sectionOf(res, 'pos.promo_voucher').rows.map(row => row.id), typed).toEqual([id]);
      // The wallet's reader takes the same text and answers that it has no such key, not that it failed.
      expect(sectionOf(res, 'pos.wallet').status, typed).toBe('empty');
    }
  });

  it('says what it did not search when it found nothing: a park promo code a till takes is not a voucher code', async () => {
    const empty = sectionOf(await lookup(admin, 'STAFF10', 'voucher'), 'pos.promo_voucher');
    expect(empty).toMatchObject({ status: 'empty', rowCount: 0 });
    expect(empty.note).toContain('A park promo code that a till takes as a discount is not searched here.');
    const { code } = await issue(central);
    expect(sectionOf(await lookup(admin, code, 'voucher'), 'pos.promo_voucher').note).toBeNull();
    expect(sectionOf(await lookup(doorOnly, code, 'voucher'), 'pos.promo_voucher').note).not.toContain('promo code');
  });

  it('refuses the anonymous and an account without the reader', async () => {
    const { code } = await issue(central);
    expect((await get(null, `/vouchers/by-code?code=${code}`)).status).toBe(401);
    const refused = await get(reception, `/vouchers/by-code?code=${code}`);
    expect([refused.status, refused.body.error.code]).toEqual([403, 'FORBIDDEN']);
    expect((await get(doorOnly, `/vouchers/by-code?code=${code}`)).status).toBe(403);
  });

  it('reads as nothing out of the caller’s park and out of the operator', async () => {
    const atChalong = await issue(chalong);
    expect((await get(centralReader, `/vouchers/by-code?code=${atChalong.code}`)).body).toEqual({ vouchers: [] });
    expect((await get(admin, `/vouchers/by-code?code=${atChalong.code}`)).body.vouchers).toHaveLength(1);
    expect((await get(foreignAdmin, `/vouchers/by-code?code=${atChalong.code}`)).body).toEqual({ vouchers: [] });
  });

  it('never counts a miss: ten different wrong codes from a till-seated person leave no throttle, no miss, no lock and no alert', async () => {
    const [till] = await ctx.db.select().from(station).where(eq(station.codePrefix, 'T1'));
    await takeStation(ctx.app, centralManager, till!.id);
    const { code: real } = await issue(central);
    const before = await writesOfVouchers();
    const auditsBefore = await totalAudits();
    for (let i = 0; i < 10; i += 1) {
      const res = await get(centralManager, `/vouchers/by-code?code=${wrongCode()}`);
      expect(res.status, res.raw).toBe(200);
    }
    expect(await writesOfVouchers()).toEqual(before);
    expect(await totalAudits()).toBe(auditsBefore);
    // Through the Console as well: each lookup adds its one data-access row and nothing against a till.
    for (let i = 0; i < 6; i += 1) {
      const res = await lookup(admin, wrongCode(), 'voucher');
      expect(sectionOf(res, 'pos.promo_voucher')).toMatchObject({ status: 'empty', rowCount: 0 });
    }
    expect(await writesOfVouchers()).toEqual(before);
    expect(await totalAudits()).toBe(auditsBefore + 6);
    // And the till the person stands at still answers a real code.
    const atTill = await get(centralManager, `/vouchers/lookup?code=${real}`);
    expect(atTill.status, atTill.raw).toBe(200);
    expect(await writesOfVouchers()).toEqual(before);
  });

  it('reaches the Console’s lookup through that reader and never through the till’s', async () => {
    const { code } = await issue(central);
    const res = await lookup(admin, code, 'voucher');
    expect(sectionOf(res, 'pos.promo_voucher')).toMatchObject({ app: 'pos', status: 'found', rowCount: 1, permission: 'admin:booth:read', note: null });
    expect(res.raw).not.toContain(code);
    expect(sectionOf(await lookup(doorOnly, code, 'voucher'), 'pos.promo_voucher')).toMatchObject({ status: 'denied', rowCount: 0 });
    const [row] = await lookupAudits();
    expect(JSON.stringify(row)).not.toContain(code);
    const source = readFileSync(new URL('../src/services/support-lookup.ts', import.meta.url), 'utf8');
    // The route template and the URL a call would need; the comment naming why it is not called does not count.
    expect(source).not.toMatch(/['"]GET \/vouchers\/lookup['"]/);
    expect(source).not.toMatch(/get\(caller, [`'"]\/vouchers\/lookup/);
    expect(source).toContain("'GET /vouchers/by-code'");
    const reader = readFileSync(new URL('../src/services/voucher-ledger.ts', import.meta.url), 'utf8');
    const readerCode = reader.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const write of ['recordVoucherMiss', 'findForRedemption', 'lookupVoucher', 'redemptionThrottle', 'voucherMiss']) expect(readerCode).not.toContain(write);
  });
});

describe('SCRUM-674 the OTO App’s records by phone', () => {
  const PHONE = '+66810674099';
  const accountOf = async (phone: string) => (await ctx.db.select().from(s.account).where(eq(s.account.phone, phone)))[0]!.id;
  /** A person who may search and open the OTO App, held at this scope. */
  let tileHolder: string, tileHolderId: string, noUser: string, disabledUser: string, staffUser: string, centralUser: string;

  beforeAll(async () => {
    const grants = [{ permissions: ['app:console:access', 'console:support:lookup', 'app:oto_app:access'], scopeType: 'operator' as const, scopeId: oto }];
    tileHolder = await person('+66810674010', grants);
    tileHolderId = await accountOf('+66810674010');
    noUser = await person('+66810674011', grants);
    disabledUser = await person('+66810674012', grants);
    staffUser = await person('+66810674013', grants);
    centralUser = await person('+66810674014', grants);
    fakeUser(fake, world, { platformAccountId: tileHolderId, role: 'manager', branchId: null });
    fakeUser(fake, world, { platformAccountId: await accountOf('+66810674012'), role: 'manager', branchId: null, isActive: false });
    fakeUser(fake, world, { platformAccountId: await accountOf('+66810674013'), role: 'staff', branchId: world.central });
    fakeUser(fake, world, { platformAccountId: await accountOf('+66810674014'), role: 'manager', branchId: world.central });
    fake.data.supportRecords.push(
      { phone: PHONE, tenantId: world.tenantId, branchId: world.central, row: { record: 'person', id: 'zz-person-central', personKind: 'employee', name: 'ZZ TEST Central Person', nickname: 'ZZ', status: 'active', park: 'ZZ Central' } },
      { phone: PHONE, tenantId: world.tenantId, branchId: world.chalong, row: { record: 'event', id: 'zz-event-chalong', name: 'ZZ TEST Chalong Party', guardianName: 'ZZ TEST Parent', status: 'upcoming', park: 'ZZ Chalong' } },
      { phone: PHONE, tenantId: newId(), branchId: world.central, row: { record: 'person', id: 'zz-person-foreign', name: 'ZZ TEST Other Group' } },
    );
  });

  const recordsOf = async (cookie: string, q = PHONE) => {
    const res = await lookup(cookie, q, 'phone');
    expect(res.status, res.raw).toBe(200);
    return { res, section: sectionOf(res, 'oto_app.records') };
  };

  it('answers as the person asking, masked for a reader without the sensitive permission, and logs the app session out', async () => {
    fake.resetObservations();
    const { res, section } = await recordsOf(tileHolder);
    expect(section).toMatchObject({ app: 'oto_app', status: 'found', rowCount: 2, permission: 'app:oto_app:access', note: null });
    expect(section.rows.map(row => row.id)).toEqual(['zz-person-central', 'zz-event-chalong']);
    expect(section.rows[0]).toMatchObject({ record: 'person', name: '[redacted]', nickname: '[redacted]', status: 'active', park: 'ZZ Central' });
    expect(section.rows[1]).toMatchObject({ record: 'event', name: '[redacted]', guardianName: '[redacted]' });
    expect(res.raw).not.toContain('ZZ TEST');
    expect(res.body.masked).toBe(true);
    // The app was asked once, GET only, with the phone the platform normalised; the session it opened is gone.
    const reads = fake.requests.filter(r => r.path === '/api/support/by-phone');
    expect(reads).toEqual([expect.objectContaining({ method: 'GET', query: `?phone=${encodeURIComponent(PHONE)}`, status: 200 })]);
    expect(fake.requests.filter(r => r.method === 'POST').map(r => r.path).sort()).toEqual(['/api/auth/handoff', '/api/logout']);
    expect(fake.logouts).toHaveLength(1);
    expect(fake.sessions.size).toBe(0);
  });

  it('finds the record however the phone was typed, with one data-access row that names no value', async () => {
    const before = (await lookupAudits()).length;
    const { res, section } = await recordsOf(tileHolder, '081-067-4099');
    expect(section.status).toBe('found');
    const rows = await lookupAudits();
    expect(rows.length).toBe(before + 1);
    expect(rows[0]!.entityType).toBe('data_access');
    expect((rows[0]!.after as { sections: unknown[] }).sections).toContainEqual({ key: 'oto_app.records', app: 'oto_app', kind: 'phone', status: 'found', rows: 2 });
    const written = JSON.stringify(rows[0]);
    expect(written).not.toContain('0674099');
    expect(written).not.toContain('ZZ TEST');
    expect(res.raw).not.toContain('0674099');
    // The hand-off row is the seam's own, correlated with this lookup and in its own category.
    const [issue] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'auth.handoff_issue'), eq(auditLog.requestId, rows[0]!.requestId!)));
    expect(issue).toBeDefined();
    expect(JSON.stringify(issue)).not.toContain('0674099');
  });

  it('answers empty when the app has nobody by that phone', async () => {
    expect((await recordsOf(tileHolder, '+66810674098')).section).toMatchObject({ status: 'empty', rowCount: 0, note: null });
  });

  it('answers only what the app’s own fences let this person see: another park and another park group are not there', async () => {
    const { res, section } = await recordsOf(centralUser);
    expect(section.rows.map(row => row.id)).toEqual(['zz-person-central']);
    expect(res.raw).not.toContain('zz-event-chalong');
    expect(res.raw).not.toContain('zz-person-foreign');
    expect((await recordsOf(tileHolder)).res.raw).not.toContain('zz-person-foreign');
  });

  it('says denied, in the app’s or the launcher’s own words, and reads nothing', async () => {
    fake.resetObservations();
    // No tile on the platform: refused before the app is contacted.
    const noTile = (await recordsOf(doorOnly)).section;
    expect(noTile).toMatchObject({ status: 'denied', rowCount: 0, permission: 'app:oto_app:access' });
    expect(noTile.note).toContain('app:oto_app:access');
    expect(fake.requests).toEqual([]);
    // The tile but no user in the app, and a disabled one: the app's sentence, and no permission named, because they hold it.
    expect((await recordsOf(noUser)).section).toMatchObject({ status: 'denied', rowCount: 0, permission: null, note: OTOAPP_WORDS.notProvisioned });
    expect((await recordsOf(disabledUser)).section).toMatchObject({ status: 'denied', rowCount: 0, permission: null, note: OTOAPP_WORDS.disabled });
    // A staff rank in the app: the reader's own refusal, and the session is still logged out.
    fake.resetObservations();
    expect((await recordsOf(staffUser)).section).toMatchObject({ status: 'denied', rowCount: 0, permission: null, note: OTOAPP_WORDS.insufficient });
    expect(fake.logouts).toHaveLength(1);
  });

  it('leads each kind of record with what tells a person which one it is, for the Console’s compact list', async () => {
    // Each row as the app's own reader writes it: `apps/oto-app/server/support-lookup-routes.ts`.
    const phone = '+66810674097';
    const common = { branchId: world.central, park: 'ZZ Central', name: 'ZZ TEST Child', guardianName: 'ZZ TEST Parent' };
    const of = (id: string, row: Record<string, unknown>) => ({ phone, tenantId: world.tenantId, branchId: world.central, row: { record: row.record, id, ...row } });
    fake.data.supportRecords.push(
      of('zz-p', { record: 'person', personKind: 'employee', name: 'ZZ TEST Person', nickname: 'ZZ', status: 'active', branchId: world.central, park: 'ZZ Central' }),
      of('zz-e', { record: 'event', eventType: 'party', name: 'ZZ TEST Party', guardianName: 'ZZ TEST Parent', date: '2030-03-01', startTime: '10:00', status: 'upcoming', branchId: world.central, park: 'ZZ Central' }),
      of('zz-r', { record: 'event_registration', registrationKind: 'camp', eventId: 'zz-e', eventType: 'camp', date: '2030-03-01', ...common }),
      of('zz-s', { record: 'checkin', checkinKind: 'service', serviceType: 'nanny', status: 'checked_out', name: common.name, guardianName: common.guardianName,
        registeredAt: '2030-03-01T02:00:00.000Z', checkedInAt: '2030-03-01T03:00:00.000Z', checkedOutAt: '2030-03-01T04:00:00.000Z', branchId: world.central, park: 'ZZ Central' }),
      of('zz-d', { record: 'checkin', checkinKind: 'dropoff', status: 'picked_up', guardianName: common.guardianName, children: 2,
        createdAt: '2030-03-01T02:00:00.000Z', pickedUpAt: '2030-03-01T05:00:00.000Z', branchId: world.central, park: 'ZZ Central' }),
      of('zz-c', { record: 'checkin', checkinKind: 'camp', date: '2030-03-01', status: 'present', checkedInAt: '2030-03-01T03:00:00.000Z', checkedOutAt: null,
        eventId: 'zz-e', name: common.name, guardianName: common.guardianName, branchId: world.central, park: 'ZZ Central' }),
    );
    const rows = (await recordsOf(tileHolder, phone)).section.rows as Array<Record<string, unknown>>;
    const shown = Object.fromEntries(rows.map(row => [row.id, onTheScreen(row)]));
    expect(shown).toEqual({
      'zz-p': ['personKind', 'name', 'nickname', 'status', 'park', 'record', 'id', 'branchId'],
      'zz-e': ['eventType', 'name', 'guardianName', 'date', 'startTime', 'status', 'park', 'record'],
      'zz-r': ['registrationKind', 'eventType', 'name', 'guardianName', 'date', 'park', 'record', 'id'],
      'zz-s': ['checkinKind', 'serviceType', 'status', 'name', 'guardianName', 'park', 'checkedInAt', 'checkedOutAt'],
      'zz-d': ['checkinKind', 'status', 'guardianName', 'children', 'park', 'createdAt', 'pickedUpAt', 'record'],
      'zz-c': ['checkinKind', 'status', 'name', 'guardianName', 'park', 'date', 'checkedInAt', 'record'],
    });
    // Reordered, not reduced, and still masked.
    expect(rows.find(row => row.id === 'zz-s')).toMatchObject({ name: '[redacted]', guardianName: '[redacted]', branchId: world.central, registeredAt: '2030-03-01T02:00:00.000Z' });
  });

  it('says unavailable when the app fails, and logs the session out', async () => {
    fake.data.supportBroken = true;
    fake.resetObservations();
    try {
      const { res, section } = await recordsOf(tileHolder);
      expect(section).toMatchObject({ status: 'unavailable', rowCount: 0, note: 'The OTO App answered 500, so its records could not be searched.' });
      expect(fake.logouts).toHaveLength(1);
      // The other apps still answer.
      expect(sectionOf(res, 'crm.member').status).not.toBe('unavailable');
    } finally {
      fake.data.supportBroken = false;
    }
  });

  it('never reads an OTO App table and never carries the hand-off or the app’s cookie out', async () => {
    fake.resetObservations();
    const { res } = await recordsOf(tileHolder);
    for (const secret of [...fake.tokensSeen, ...fake.sidsIssued]) expect(res.raw).not.toContain(secret);
    const lines = await ctx.db.select().from(auditLog).where(eq(auditLog.requestId, (await lookupAudits())[0]!.requestId!));
    for (const secret of [...fake.tokensSeen, ...fake.sidsIssued]) expect(JSON.stringify(lines)).not.toContain(secret);
    for (const file of ['../src/services/support-lookup.ts', '../src/services/support-otoapp.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(/(?<![-/\w])otoapp\.|otoapp_v|\bfetch\s*\(/);
    }
  });
});
