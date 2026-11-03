import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hash } from '@node-rs/argon2';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alert, auditLog, band, bandEvent, redemptionThrottle, schema as s, station, syncEvent, ticketPackage, voucher, voucherDefinition, voucherMiss,
} from '@oto/db';
import { bandShortCode, mintBoothCode, newId } from '@oto/shared';
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

let ctx: TestContext;
let oto: string, central: string, chalong: string, foreignBranch: string;
let admin: string, reception: string, centralManager: string, chalongManager: string, foreignAdmin: string;
/** The Console door and the lookup, and nothing that reads a gate or a voucher. */
let doorOnly: string;
/** The lookup operator-wide, with the gate and voucher readers at Central alone. */
let centralReader: string;
let centralLane: string, chalongLane: string;
let boxId: string;

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

async function sellAdultBand(): Promise<{ id: string; code: string }> {
  const [till] = await ctx.db.select().from(station).where(eq(station.codePrefix, 'T1'));
  const [pkg] = await ctx.db.select().from(ticketPackage).where(and(eq(ticketPackage.branchId, till!.branchId), eq(ticketPackage.name, '2 Hours Play')));
  const saleId = newId();
  const rung = await ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie: reception },
    payload: { id: saleId, stationId: till!.id, lines: [{ id: newId(), packageId: pkg!.id, kids: 0, adults: 1 }] } });
  expect(rung.statusCode, rung.body).toBe(200);
  const paid = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload: {} });
  expect(paid.statusCode, paid.body).toBe(200);
  const [row] = await ctx.db.select().from(band).where(eq(band.saleId, saleId));
  return { id: row!.id, code: row!.code };
}

async function pass(bandId: string, kind: 'entry' | 'exit' | 'denied' | 'timeout' | 'alarm', stationId: string, at: Date, detail: Record<string, unknown> = {}) {
  const id = newId();
  await ctx.db.insert(bandEvent).values({ id, bandId, kind, stationId, boxId, detail: { direction: kind === 'exit' ? 'exit' : 'entry', side: 'left', ...detail }, createdAt: at });
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api' } });
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
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

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
    expect(sectionOf(console, 'pos.gate_events')).toMatchObject({ status: 'found', rowCount: 50, note: 'Showing the newest 50 at each park.' });
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

  it('answers a fixed-code type by its shared code, whatever its state', async () => {
    const id = newId();
    await ctx.db.insert(voucherDefinition).values({ id, operatorId: oto, code: `zz-674-fixed-${id}`, nameEn: 'ZZ TEST 674 fixed', kind: 'discount', valueType: 'percent', valueBp: 1000, codeMode: 'fixed', fixedCode: 'ZZFIX674', active: false });
    const res = await get(admin, '/vouchers/by-code?code=zzfix674');
    expect(res.status, res.raw).toBe(200);
    expect(res.body.vouchers).toEqual([expect.objectContaining({ record: 'voucher_type', id, codeLast4: 'X674', state: 'off', value: expect.objectContaining({ text: '10% off' }) })]);
    expect(res.raw).not.toContain('ZZFIX674');
  });

  it('answers empty for a code nobody issued and for one that cannot be a voucher', async () => {
    for (const code of [wrongCode(), 'zz', '!!!!']) {
      const res = await get(admin, `/vouchers/by-code?code=${encodeURIComponent(code)}`);
      expect(res.status, res.raw).toBe(200);
      expect(res.body).toEqual({ vouchers: [] });
    }
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
