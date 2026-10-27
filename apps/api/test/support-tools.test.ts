import { hash } from '@node-rs/argon2';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alert, auditLog, impersonationSession, opsRun, sale, schema as s, session as sessionTable, station, stationEvent, suiteControlApproval,
} from '@oto/db';
import { newId } from '@oto/shared';
import type { AuthContext } from '../src/plugins/session';
import { subjectRefusal } from '../src/services/impersonation';
import { detectQueryKinds } from '../src/services/support-lookup';
import {
  ADMIN, BRANCH_MANAGER, CENTRAL_BRANCH_CODE, OTO_OPERATOR_NAME, RECEPTION, branchIdByCode, createTestContext, operatorIdByName,
  signInAs, teardownAll, type TestContext,
} from './helpers';

/**
 * SCRUM-648 (S2-23 P5-6) — Support tools, through real HTTP: the cross-app
 * lookup, the one-action trace and audited, time-boxed impersonation. The
 * only fixtures written directly are the records a trace follows (a sale, a
 * run, a station tape row, an audit row) and a narrow custom role; every
 * refusal and every audit row is asserted on what the api actually wrote.
 */

const KID = 'k1';
const SECRET = 'support-tools-test-secret-0123456789abcdef';
const POS_ORIGIN = 'https://pos.test';
const CONSOLE_ORIGIN = 'https://console.test';
const PASSWORD = 'supporttools1234';
const MEMBER_PHONE = '+66811111111';
const TEMPLATE = 'https://observability.test/trace?request={requestId}';

let ctx: TestContext;
let oto: string, central: string;
let admin: string, adminId: string, admin2: string, admin2Id: string, narrow: string, narrowId: string;
let reception: string, receptionId: string, managerId: string;

type Res = { status: number; body: any; raw: string; cookies: string[] }; // eslint-disable-line @typescript-eslint/no-explicit-any -- asserted field by field
async function call(cookie: string | null, method: 'GET' | 'POST', url: string, payload?: unknown, opts: { key?: string | null; origin?: string } = {}): Promise<Res> {
  const key = opts.key === undefined ? newId() : opts.key;
  const res = await ctx.app.inject({ method, url, payload: payload as never, headers: {
    ...(cookie ? { cookie } : {}), ...(key && method !== 'GET' ? { 'idempotency-key': key } : {}), ...(opts.origin ? { origin: opts.origin } : {}),
  } });
  let body: unknown = null;
  try { body = res.json(); } catch { body = null; }
  const raw = res.headers['set-cookie'];
  return { status: res.statusCode, body, raw: res.body, cookies: raw === undefined ? [] : Array.isArray(raw) ? raw : [raw] };
}
const audits = (action: string) => ctx.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.createdAt));
const cookieOf = (res: Res) => res.cookies.find(c => c.startsWith('oto_session='))!.split(';')[0]!;
const tokenOf = (launchUrl: string) => launchUrl.slice(launchUrl.indexOf('#handoff=') + '#handoff='.length);
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      PROCESS_ROLES: 'api',
      HANDOFF_SIGNING_KEY: `${KID}:${SECRET}`,
      HANDOFF_APP_ORIGINS: `pos=${POS_ORIGIN},console=${CONSOLE_ORIGIN}`,
      ALLOWED_ORIGINS: `${POS_ORIGIN},${CONSOLE_ORIGIN}`,
      TRACE_URL_TEMPLATE: TEMPLATE,
    },
  });
  oto = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const idOf = async (phone: string) => (await ctx.db.select().from(s.account).where(eq(s.account.phone, phone)))[0]!.id;
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password); adminId = await idOf(ADMIN.phone);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password); receptionId = await idOf(RECEPTION.phone);
  managerId = await idOf(BRANCH_MANAGER.phone);

  // A second real platform administrator (dual control), and a narrow support reader: the lookup,
  // the member read and the Console door — nothing sensitive, no sales, no trace.
  admin2Id = newId(); narrowId = newId();
  const passwordHash = await hash(PASSWORD);
  await ctx.db.insert(s.account).values([
    { id: admin2Id, operatorId: oto, phone: '+66810648002', passwordHash, phoneVerifiedAt: new Date(), status: 'active' },
    { id: narrowId, operatorId: oto, phone: '+66810648003', passwordHash, phoneVerifiedAt: new Date(), status: 'active' },
  ]);
  const [platformRole] = await ctx.db.select().from(s.role).where(and(isNull(s.role.operatorId), eq(s.role.name, 'platform_admin')));
  const narrowRole = newId();
  await ctx.db.insert(s.role).values({ id: narrowRole, operatorId: oto, name: 'ZZ TEST 648 narrow support' });
  await ctx.db.insert(s.rolePermission).values(['console:support:lookup', 'pos:member:read', 'app:console:access']
    .map(permission => ({ id: newId(), roleId: narrowRole, permission })));
  await ctx.db.insert(s.roleAssignment).values([
    { id: newId(), accountId: admin2Id, roleId: platformRole!.id, scopeType: 'operator', scopeId: null },
    { id: newId(), accountId: narrowId, roleId: narrowRole, scopeType: 'operator', scopeId: oto },
  ]);
  admin2 = await signInAs(ctx.app, '+66810648002', PASSWORD);
  narrow = await signInAs(ctx.app, '+66810648003', PASSWORD);
}, 300_000);
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

describe('SCRUM-648 cross-app lookup', () => {
  it('detects what a typed value could be, searching every candidate when it is ambiguous', () => {
    expect(detectQueryKinds('081 111 1111')).toEqual(['phone']);
    expect(detectQueryKinds('+66811111111')).toEqual(['phone']);
    expect(detectQueryKinds(newId())).toEqual(['account', 'action']);
    expect(detectQueryKinds('HKT1-000428')).toEqual(['receipt', 'action']);
    expect(detectQueryKinds('AB12CD34')).toEqual(['booking', 'voucher', 'action']);
    expect(detectQueryKinds('   ')).toEqual([]);
  });

  it('refuses the anonymous and a reception session before any app is read', async () => {
    expect((await call(null, 'GET', `/console/support/lookup?q=${encodeURIComponent(MEMBER_PHONE)}`)).status).toBe(401);
    const refused = await call(reception, 'GET', `/console/support/lookup?q=${encodeURIComponent(MEMBER_PHONE)}`);
    expect([refused.status, refused.body.error.code]).toEqual([403, 'FORBIDDEN']);
  });

  it('masks member and children for a reader without the sensitive permission and reports each denied app as denied', async () => {
    const before = (await audits('console.support.lookup')).length;
    const res = await call(narrow, 'GET', `/console/support/lookup?q=${encodeURIComponent('081-111-1111')}`);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.kinds).toEqual(['phone']);
    const byKey = Object.fromEntries((res.body.sections as Array<{ key: string }>).map(sec => [sec.key, sec])) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- sections asserted by key
    expect(byKey['crm.member']).toMatchObject({ app: 'crm', status: 'found', masked: true, rowCount: 1, permission: 'pos:member:read' });
    const member = byKey['crm.member'].rows[0];
    expect(member.phone).toBe('[redacted]');
    expect(member.children.length).toBeGreaterThan(0);
    for (const child of member.children) {
      expect(child.allergies === null || child.allergies === '[redacted]').toBe(true);
      expect(child.name === null || child.name === '[redacted]').toBe(true);
    }
    expect(JSON.stringify(member)).not.toContain('Peanut');
    // Every other app answers through its own permission, which this reader does not hold: denied, never missing.
    for (const key of ['pos.sales', 'pos.checkins', 'pos.bookings', 'inbox.conversations', 'platform.accounts']) {
      expect(byKey[key]?.status, key).toBe('denied');
      expect(byKey[key]?.rowCount, key).toBe(0);
    }
    expect(byKey['oto_app.records']).toMatchObject({ app: 'oto_app', status: 'not_built' });
    expect(res.body.masked).toBe(true);

    // One data_access row: the kinds and which sections answered, never the searched or returned values.
    const rows = await audits('console.support.lookup');
    expect(rows.length).toBe(before + 1);
    const row = rows[0]!;
    expect(row).toMatchObject({ actorAccountId: narrowId, entityType: 'data_access', operatorId: oto, origin: 'console', targetApp: 'console' });
    expect(row.after).toMatchObject({ category: 'data_access', kinds: ['phone'], masked: true });
    expect((row.after as { sections: unknown[] }).sections).toContainEqual({ key: 'crm.member', app: 'crm', kind: 'phone', status: 'found', rows: 1 });
    expect((row.after as { sections: unknown[] }).sections).toContainEqual({ key: 'pos.sales', app: 'pos', kind: 'phone', status: 'denied', rows: 0 });
    const text = JSON.stringify(row);
    expect(text).not.toContain('1111111');
    expect(text).not.toContain('Peanut');
  });

  it('answers a sensitive reader unmasked, every app labelled, and still records only the shape', async () => {
    const res = await call(admin, 'GET', `/console/support/lookup?q=${encodeURIComponent(MEMBER_PHONE)}`);
    expect(res.status, res.raw).toBe(200);
    const sections = res.body.sections as Array<{ key: string; app: string; status: string; masked: boolean; rows: any[] }>; // eslint-disable-line @typescript-eslint/no-explicit-any -- row shapes belong to each app
    const member = sections.find(sec => sec.key === 'crm.member')!;
    expect(member).toMatchObject({ status: 'found', masked: false });
    expect(member.rows[0].phone).toBe(MEMBER_PHONE);
    expect(JSON.stringify(member.rows[0].children)).toContain('Peanut');
    expect(new Set(sections.map(sec => sec.app))).toEqual(new Set(['crm', 'pos', 'inbox', 'platform', 'oto_app']));
    for (const sec of sections) expect(['found', 'empty', 'not_built'], sec.key).toContain(sec.status);
    expect(res.body.masked).toBe(false);
    const [row] = await audits('console.support.lookup');
    expect(row!.actorAccountId).toBe(adminId);
    expect(JSON.stringify(row)).not.toContain('1111111');
  });

  it('labels unbuilt readers as not_built for a band, and searches a receipt through the sales reader', async () => {
    const band = await call(admin, 'GET', '/console/support/lookup?q=T1-7KMQ4X&kind=band');
    expect(band.status, band.raw).toBe(200);
    expect(band.body.sections.map((sec: { key: string; status: string }) => [sec.key, sec.status])).toEqual([
      ['pos.sales', 'empty'], ['pos.wallet', 'empty'], ['pos.gate_events', 'not_built'],
    ]);
    const receipt = await call(admin, 'GET', '/console/support/lookup?q=ZZ648-000001&kind=receipt');
    expect(receipt.status, receipt.raw).toBe(200);
    expect(receipt.body.sections).toEqual([expect.objectContaining({ key: 'pos.sales', status: 'empty', permission: 'pos:sale:read' })]);
  });

  it('answers an action id with a link into the trace only for a reader who may trace', async () => {
    const actionId = `zz-648-lookup-${newId()}`;
    await ctx.db.insert(auditLog).values({ id: newId(), operatorId: oto, branchId: central, actorAccountId: adminId, action: 'zz.test',
      entityType: 'zz', entityId: actionId, actionId });
    const traced = await call(admin, 'GET', `/console/support/lookup?q=${actionId}&kind=action`);
    expect(traced.body.sections[0]).toMatchObject({ key: 'platform.trace', status: 'found',
      rows: [expect.objectContaining({ href: `/support?trace=${actionId}&kind=action` })] });
    const denied = await call(narrow, 'GET', `/console/support/lookup?q=${actionId}&kind=action`);
    expect(denied.body.sections[0]).toMatchObject({ key: 'platform.trace', status: 'denied', rows: [] });
  });
});

describe('SCRUM-648 what happened to this sale', () => {
  let saleId: string, actionId: string, stationId: string;
  beforeAll(async () => {
    const [till] = await ctx.db.select().from(station).where(eq(station.branchId, central)).limit(1);
    stationId = till!.id;
    saleId = newId(); actionId = `zz-648-sale-${newId()}`;
    const at = new Date(Date.now() - 60_000);
    await ctx.db.insert(sale).values({
      id: saleId, operatorId: oto, branchId: central, stationId, businessDate: at.toISOString().slice(0, 10), businessDayStart: '05:00',
      timezone: 'Asia/Bangkok', occurredAt: at, origin: 'cloud', salesChannel: 'till', createdByAccountId: receptionId,
      pricingMode: 'weekday', pricingModeReason: 'Weekday pricing', customerTier: 'tourist', engineVersion: 'zz-648', taxConfig: {},
      taxBreakdown: {}, subtotalSatang: 10000, manualDiscountSatang: 0, discountSatang: 0, netSatang: 10000, taxInclusiveSatang: 0,
      grossSatang: 10000, receiptSeries: 'ZZT', receiptSeq: 1, receiptNumber: 'ZZT-000001', finalisedAt: at, status: 'finalised', actionId,
    } as never);
    await ctx.db.insert(opsRun).values({ id: newId(), kind: 'device', name: 'device:printer.ok', outcome: 'ok', startedAt: at,
      finishedAt: new Date(at.getTime() + 40), durationMs: 40, actionId, requestId: 'zz-648-req-1', operatorId: oto, branchId: central });
    if (till!.boxId) {
      await ctx.db.insert(stationEvent).values({ id: newId(), stationId, boxId: till!.boxId, kind: 'intent', source: 'till',
        intentType: 'sale.finalise', outcome: 'applied', actionId, occurredAt: new Date(at.getTime() - 500),
        receivedAt: new Date(at.getTime() - 400), payload: { phone: '+66899999999' } } as never);
    }
  });

  it('refuses a caller without the trace permission and answers 404 for an unknown key, audited either way', async () => {
    expect((await call(reception, 'GET', `/console/support/trace?id=${saleId}&kind=sale`)).status).toBe(403);
    expect((await call(narrow, 'GET', `/console/support/trace?id=${saleId}&kind=sale`)).status).toBe(403);
    const before = (await audits('console.support.trace')).length;
    const missing = await call(admin, 'GET', `/console/support/trace?id=${newId()}&kind=sale`);
    expect([missing.status, missing.body.error.code]).toEqual([404, 'TRACE_NOT_FOUND']);
    const rows = await audits('console.support.trace');
    expect(rows.length).toBe(before + 1);
    expect(rows[0]!.after).toMatchObject({ category: 'data_access', kind: 'sale', found: false });
  });

  it('follows the sale through its stages in pipeline order with gaps shown, never skipped, and projected detail only', async () => {
    const res = await call(admin, 'GET', `/console/support/trace?id=${saleId}&kind=sale`);
    expect(res.status, res.raw).toBe(200);
    const steps = res.body.steps as Array<{ stage: string; status: string; source: string | null; note: string | null; detail: object;
      opsRunId: string | null; latencyMs: number | null; traceUrl: string | null; requestId: string | null }>;
    const order = ['till_intent', 'box_session', 'device_call', 'outbox', 'cloud_apply', 'audit', 'payment', 'rollup'];
    expect([...new Set(steps.map(st => st.stage))]).toEqual(order);
    // A sale rung in the cloud has no outbox event and no payment yet: each is a GAP with its reasons, not an absence.
    for (const stage of ['outbox', 'payment']) {
      const gap = steps.find(st => st.stage === stage)!;
      expect(gap.status, stage).toBe('gap');
      expect(gap.note, stage).toBeTruthy();
    }
    expect(res.body.gaps).toEqual(expect.arrayContaining(['outbox', 'payment', 'box_session']));
    const run = steps.find(st => st.stage === 'device_call' && st.source === 'core.ops_run')!;
    expect(run).toMatchObject({ status: 'recorded', latencyMs: 40, requestId: 'zz-648-req-1',
      traceUrl: 'https://observability.test/trace?request=zz-648-req-1' });
    expect(run.opsRunId).toBeTruthy();
    expect(steps.find(st => st.stage === 'cloud_apply' && st.source === 'pos.sale')).toMatchObject({ status: 'recorded' });
    // The finalised sale marked its day for the rollup: pending until the next run.
    expect(steps.find(st => st.stage === 'rollup')!.status).toMatch(/pending|recorded|gap/);
    // Projected: no payload, no phone.
    expect(JSON.stringify(steps)).not.toContain('+66899999999');
    expect(res.body.anchor).toMatchObject({ kind: 'sale', saleId, receiptNumber: 'ZZT-000001' });
    expect(res.body.anchor.actionIds).toContain(actionId);
    const [row] = await audits('console.support.trace');
    expect(row!.after).toMatchObject({ category: 'data_access', kind: 'sale', found: true, saleId });
  });

  it('accepts exactly the Money oversight link shapes: receipt and action resolve to the same sale', async () => {
    const byReceipt = await call(admin, 'GET', '/console/support/trace?id=ZZT-000001&kind=receipt');
    expect(byReceipt.status, byReceipt.raw).toBe(200);
    expect(byReceipt.body.anchor.saleId).toBe(saleId);
    const byAction = await call(admin, 'GET', `/console/support/trace?id=${actionId}&kind=action`);
    expect(byAction.body.anchor.saleId).toBe(saleId);
    expect((await call(admin, 'GET', `/console/support/trace?id=${saleId}&kind=bogus`)).status).toBe(400);
  });
});

describe('SCRUM-648 audited, time-boxed impersonation', () => {
  const start = (cookie: string, body: Record<string, unknown>) => call(cookie, 'POST', '/console/support/impersonations', body, { key: null });
  const exchange = (launchUrl: string) => call(null, 'POST', '/auth/handoff/exchange', { token: tokenOf(launchUrl) }, { key: null, origin: POS_ORIGIN });
  const refusedRows = async () => (await audits('console.impersonation.refused')).map(r => (r.after as { code: string }).code);

  it('refuses self, a platform administrator, a Console holder and a non-holder — each refusal audited before it is answered', async () => {
    const self = await start(admin, { subjectAccountId: adminId, targetApp: 'pos' });
    expect([self.status, self.body.error.code]).toEqual([403, 'IMPERSONATION_SELF']);
    const platform = await start(admin, { subjectAccountId: admin2Id, targetApp: 'pos' });
    expect([platform.status, platform.body.error.code]).toEqual([403, 'IMPERSONATION_SUBJECT_PRIVILEGED']);
    const manager = await start(admin, { subjectAccountId: managerId, targetApp: 'pos' });
    expect([manager.status, manager.body.error.code]).toEqual([403, 'IMPERSONATION_SUBJECT_PRIVILEGED']);
    expect(await refusedRows()).toEqual(expect.arrayContaining(['IMPERSONATION_SELF', 'IMPERSONATION_SUBJECT_PRIVILEGED']));
    expect((await audits('console.impersonation.refused')).filter(r => r.entityId === managerId).length).toBe(1);
    // Neither reception nor the narrow support role holds impersonation at all.
    expect((await start(reception, { subjectAccountId: narrowId, targetApp: 'pos' })).status).toBe(403);
    expect((await start(narrow, { subjectAccountId: receptionId, targetApp: 'pos' })).status).toBe(403);
    expect(await ctx.db.select().from(impersonationSession).where(eq(impersonationSession.subjectAccountId, managerId))).toEqual([]);
  });

  it('refuses a window opened from a window (the service rule; over HTTP the read-only fence answers first)', async () => {
    const actor = { accountId: adminId, operatorId: oto, sessionId: newId(), impersonation: { id: newId() } } as unknown as AuthContext;
    await expect(subjectRefusal(ctx.db, actor, receptionId, 'pos')).resolves.toMatchObject({ code: 'IMPERSONATION_NESTED' });
  });

  it('opens a read-only window: marked token, marked session, banner data, every request audited, writes refused', async () => {
    const before = (await ctx.db.select().from(alert).where(eq(alert.category, 'console.impersonation.start'))).length;
    const opened = await start(admin, { subjectAccountId: receptionId, targetApp: 'pos' });
    expect(opened.status, opened.raw).toBe(200);
    const win = opened.body.impersonation;
    expect(win).toMatchObject({ mode: 'read_only', targetApp: 'pos', state: 'active', actor: { accountId: adminId }, subject: { accountId: receptionId } });
    expect(Date.parse(win.expiresAt) - Date.parse(win.startedAt)).toBe(15 * 60_000);
    expect(opened.body.launchUrl).toMatch(/^https:\/\/pos\.test\/#handoff=/);
    // The hand-off is marked with the window and the real actor.
    expect(claimsOf(tokenOf(opened.body.launchUrl))).toMatchObject({ aud: 'pos', sub: receptionId, imp: win.id, act: adminId });
    const [started] = await audits('console.impersonation.start');
    expect(started).toMatchObject({ actorAccountId: adminId, onBehalfOf: receptionId, entityId: win.id, targetApp: 'pos', origin: 'console' });
    expect((await ctx.db.select().from(alert).where(eq(alert.category, 'console.impersonation.start'))).length).toBe(before + 1);

    const exchanged = await exchange(opened.body.launchUrl);
    expect(exchanged.status, exchanged.raw).toBe(200);
    expect(exchanged.body.impersonation).toMatchObject({ id: win.id, actorAccountId: adminId, subjectAccountId: receptionId, mode: 'read_only' });
    const windowCookie = cookieOf(exchanged);

    // The banner reads both people from /me for the whole window.
    const me = await call(windowCookie, 'GET', '/me');
    expect(me.body.account.id).toBe(receptionId);
    expect(me.body.impersonation).toMatchObject({ id: win.id, actor: { accountId: adminId }, subject: { accountId: receptionId }, mode: 'read_only' });
    const actorMe = await call(admin, 'GET', '/me');
    expect(actorMe.body.impersonating.map((w: { id: string }) => w.id)).toContain(win.id);

    // Reads work as the subject; every request is its own audit row with the real actor.
    expect((await call(windowCookie, 'GET', `/members/lookup?phone=${encodeURIComponent(MEMBER_PHONE)}`)).status).toBe(200);
    const write = await call(windowCookie, 'POST', '/members', { phone: '+66810648099', nickname: 'ZZ TEST 648' }, { origin: POS_ORIGIN });
    expect([write.status, write.body.error.code]).toEqual([403, 'IMPERSONATION_READ_ONLY']);
    // The launcher hand-off and a nested window are writes, refused the same way.
    expect((await call(windowCookie, 'POST', '/auth/handoff', { app: 'pos' }, { key: null })).body.error.code).toBe('IMPERSONATION_READ_ONLY');
    expect((await call(windowCookie, 'POST', '/console/support/impersonations', { subjectAccountId: narrowId, targetApp: 'pos' }, { key: null }))
      .body.error.code).toBe('IMPERSONATION_READ_ONLY');
    const requests = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'impersonation.request'), eq(auditLog.entityId, win.id)));
    expect(requests.length).toBeGreaterThanOrEqual(5);
    for (const r of requests) expect(r).toMatchObject({ actorAccountId: adminId, actorType: 'impersonated', onBehalfOf: receptionId, targetApp: 'pos' });
    expect(requests.map(r => (r.after as { route: string; status: number }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: '/members/lookup', status: 200 }), expect.objectContaining({ route: '/members', status: 403 }),
    ]));
    expect(await ctx.db.select().from(s.member).where(eq(s.member.phone, '+66810648099'))).toEqual([]);

    // The subject sees the window on their own account afterwards.
    const history = await call(reception, 'GET', '/me/impersonations');
    expect(history.body.impersonations.map((h: { id: string }) => h.id)).toContain(win.id);

    // Ending it revokes the window everywhere at once.
    const ended = await call(admin, 'POST', `/console/support/impersonations/${win.id}/end`, {});
    expect(ended.status, ended.raw).toBe(200);
    expect(ended.body.impersonation).toMatchObject({ state: 'ended', endReason: 'ended' });
    expect((await call(windowCookie, 'GET', '/me')).status).toBe(401);
    const [endRow] = await audits('console.impersonation.end');
    expect(endRow).toMatchObject({ actorAccountId: adminId, entityId: win.id, onBehalfOf: receptionId });
    // The subject's own session was never touched.
    expect((await call(reception, 'GET', '/me')).status).toBe(200);
  });

  it('ends at its expiry and at the actor’s sign-out, whichever comes first', async () => {
    const first = await start(admin, { subjectAccountId: receptionId, targetApp: 'pos' });
    const firstCookie = cookieOf(await exchange(first.body.launchUrl));
    expect((await call(firstCookie, 'GET', '/me')).status).toBe(200);
    await ctx.db.update(impersonationSession).set({ expiresAt: new Date(Date.now() - 1000), startedAt: new Date(Date.now() - 60_000) })
      .where(eq(impersonationSession.id, first.body.impersonation.id));
    expect((await call(firstCookie, 'GET', '/me')).status).toBe(401);

    const actorSession = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const second = await start(actorSession, { subjectAccountId: receptionId, targetApp: 'pos' });
    expect(second.status, second.raw).toBe(200);
    const secondCookie = cookieOf(await exchange(second.body.launchUrl));
    expect((await call(secondCookie, 'GET', '/me')).status).toBe(200);
    expect((await call(actorSession, 'POST', '/auth/sign-out', {}, { key: null })).status).toBe(200);
    expect((await call(secondCookie, 'GET', '/me')).status).toBe(401);
    const [row] = await ctx.db.select().from(impersonationSession).where(eq(impersonationSession.id, second.body.impersonation.id));
    expect(row).toMatchObject({ endReason: 'actor_signed_out' });
    expect(row!.endedAt).not.toBeNull();
    const [seat] = await ctx.db.select().from(sessionTable).where(eq(sessionTable.id, row!.sessionId));
    expect(seat!.revokedAt).not.toBeNull();
  });

  it('write_allowed needs a reason, a reference and a second platform administrator, and its writes are marked as the actor’s', async () => {
    const bare = await start(admin, { subjectAccountId: receptionId, targetApp: 'pos', mode: 'write_allowed' });
    expect([bare.status, bare.body.error.code]).toEqual([400, 'IMPERSONATION_REASON_REQUIRED']);
    const unapproved = await start(admin, { subjectAccountId: receptionId, targetApp: 'pos', mode: 'write_allowed',
      reason: 'ZZ TEST 648 fix a stuck member', reference: 'SCRUM-648' });
    expect([unapproved.status, unapproved.body.error.code]).toEqual([403, 'SECOND_APPROVAL_REQUIRED']);

    const asked = await call(admin, 'POST', '/console/support/impersonations/approvals',
      { subjectAccountId: receptionId, targetApp: 'pos', reason: 'ZZ TEST 648 fix a stuck member', reference: 'SCRUM-648' });
    expect(asked.status, asked.raw).toBe(200);
    expect(asked.body.state).toBe('pending');
    const ref = { expectedPayloadSha256: asked.body.payloadSha256 };
    expect((await call(admin, 'POST', `/console/support/impersonations/approvals/${asked.body.id}/approve`, ref)).status).toBe(403);
    // The kill-switch door does not approve an impersonation, whatever is typed.
    expect((await call(admin2, 'POST', `/console/flags/approvals/${asked.body.id}/approve`, { ...ref, confirmation: 'x' })).status).toBe(400);
    const approved = await call(admin2, 'POST', `/console/support/impersonations/approvals/${asked.body.id}/approve`, ref);
    expect(approved.status, approved.raw).toBe(200);
    expect(approved.body).toMatchObject({ state: 'approved', approverAccountId: admin2Id });

    const approval = { id: asked.body.id, expectedPayloadSha256: asked.body.payloadSha256 };
    // The approver may not use it; a changed reason is not the approved window.
    expect((await start(admin2, { subjectAccountId: receptionId, targetApp: 'pos', mode: 'write_allowed',
      reason: 'ZZ TEST 648 fix a stuck member', reference: 'SCRUM-648', approval })).status).toBe(403);
    expect((await start(admin, { subjectAccountId: receptionId, targetApp: 'pos', mode: 'write_allowed',
      reason: 'something else', reference: 'SCRUM-648', approval })).status).toBe(409);
    const opened = await start(admin, { subjectAccountId: receptionId, targetApp: 'pos', mode: 'write_allowed',
      reason: 'ZZ TEST 648 fix a stuck member', reference: 'SCRUM-648', approval });
    expect(opened.status, opened.raw).toBe(200);
    expect(opened.body.impersonation).toMatchObject({ mode: 'write_allowed', approvalId: asked.body.id, reference: 'SCRUM-648' });
    const [consumed] = await ctx.db.select().from(suiteControlApproval).where(eq(suiteControlApproval.id, asked.body.id));
    expect(consumed!.state).toBe('consumed');

    const windowCookie = cookieOf(await exchange(opened.body.launchUrl));
    const created = await call(windowCookie, 'POST', '/members', { phone: '+66810648098', nickname: 'ZZ TEST 648 write' }, { origin: POS_ORIGIN });
    expect(created.status, created.raw).toBe(200);
    const [memberRow] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'member.create'), eq(auditLog.entityId, created.body.member.id)));
    expect(memberRow).toMatchObject({ actorAccountId: adminId, actorType: 'impersonated', onBehalfOf: receptionId });
    // Even a write window cannot mint itself a launcher hand-off.
    const minted = await call(windowCookie, 'POST', '/auth/handoff', { app: 'pos' }, { key: null });
    expect([minted.status, minted.body.error.code]).toEqual([401, 'HANDOFF_REJECTED']);
    await call(admin, 'POST', `/console/support/impersonations/${opened.body.impersonation.id}/end`, {});
  });

  it('lists the caller’s windows and open write requests on the Console card', async () => {
    const card = await call(admin, 'GET', '/console/support/impersonations');
    expect(card.status, card.raw).toBe(200);
    expect(card.body).toMatchObject({ maxMinutes: 15, dualControl: true, targetApps: ['pos', 'oto_app', 'radar', 'inbox'] });
    expect(card.body.windows.length).toBeGreaterThanOrEqual(3);
    expect(card.body.windows.every((w: { actor: { accountId: string } }) => w.actor.accountId === adminId)).toBe(true);
    expect((await call(narrow, 'GET', '/console/support/impersonations')).status).toBe(403);
    const leftOpen = await ctx.db.select().from(impersonationSession).where(and(inArray(impersonationSession.subjectAccountId, [receptionId]),
      isNull(impersonationSession.endedAt)));
    expect(leftOpen.every(w => w.expiresAt.getTime() <= Date.now() || w.endedAt !== null)).toBe(true);
  });
});
