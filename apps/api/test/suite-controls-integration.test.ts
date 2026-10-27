import { hash } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appRegistry, auditLog, FLAG_CATALOGUE, featureFlag, flagCatalogueEntry, MESSAGING_PAUSE_KEY, schema as s,
  signInBlockKey, suiteControlApproval,
} from '@oto/db';
import { platformSync } from '@oto/db/seed';
import type { MessagingChannel } from '@oto/messaging';
import { newId } from '@oto/shared';
import { audit } from '../src/services/audit';
import type { InboxChannels } from '../src/services/inbox/channels';
import { sendQueuedMessage } from '../src/services/inbox/send';
import {
  effectiveFlag, endSpentMaintenance, resolveFlag, revertSpentFlag, runSuiteExpirySweep,
} from '../src/services/suite-flags';
import {
  ADMIN, CENTRAL_BRANCH_CODE, CHALONG_BRANCH_CODE, OTO_OPERATOR_NAME, RECEPTION, SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_NAME, branchIdByCode, createTestContext, operatorIdByName, signInAs, teardownAll, type TestContext,
} from './helpers';

/**
 * SCRUM-643 — the integration half of the suite controls (planner ruling Q24):
 * the six wiring boundaries and the preparation document's required pins.
 * Real HTTP through the app; the only fakes are the external adapters (a
 * channel that counts what it was handed, alert channels that collect).
 */

const KID = 'k1';
const SECRET = 'suite-controls-test-secret-0123456789abcdef';
const POS_ORIGIN = 'https://pos.test';
const CONSOLE_ORIGIN = 'https://console.test';
const INBOX_ORIGIN = 'https://inbox.test';
const PASSWORD = 'suitecontrols1234';

let ctx: TestContext;
let oto: string, second: string, central: string, chalong: string;
let adminId: string, admin: string, admin2Id: string, admin2: string, lookalikeId: string, lookalike: string;
let platformRole: string, lookalikeRole: string;

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      PROCESS_ROLES: 'api',
      HANDOFF_SIGNING_KEY: `${KID}:${SECRET}`,
      HANDOFF_APP_ORIGINS: `pos=${POS_ORIGIN},console=${CONSOLE_ORIGIN},inbox=${INBOX_ORIGIN}`,
      ALLOWED_ORIGINS: `${POS_ORIGIN},${CONSOLE_ORIGIN},${INBOX_ORIGIN}`,
    },
  });
  oto = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  second = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  adminId = (await ctx.db.select().from(s.account).where(eq(s.account.phone, ADMIN.phone)))[0]!.id;
  platformRole = (await ctx.db.select().from(s.role).where(and(isNull(s.role.operatorId), eq(s.role.name, 'platform_admin'))))[0]!.id;

  // A second, real platform administrator, and a look-alike: a custom role carrying every
  // suite permission at the platform-wide scope, but not the system platform_admin role.
  admin2Id = newId(); lookalikeId = newId(); lookalikeRole = newId();
  const passwordHash = await hash(PASSWORD);
  await ctx.db.insert(s.account).values([
    { id: admin2Id, operatorId: oto, phone: '+66810643002', passwordHash, phoneVerifiedAt: new Date(), status: 'active' },
    { id: lookalikeId, operatorId: oto, phone: '+66810643003', passwordHash, phoneVerifiedAt: new Date(), status: 'active' },
  ]);
  await ctx.db.insert(s.role).values({ id: lookalikeRole, operatorId: oto, name: 'ZZ TEST 643 suite look-alike' });
  await ctx.db.insert(s.rolePermission).values(['console:app_registry:read', 'console:app_registry:manage', 'console:release:read',
    'console:release:kill_switch', 'app:pos:access'].map(permission => ({ id: newId(), roleId: lookalikeRole, permission })));
  await ctx.db.insert(s.roleAssignment).values([
    { id: newId(), accountId: admin2Id, roleId: platformRole, scopeType: 'operator', scopeId: null },
    { id: newId(), accountId: lookalikeId, roleId: lookalikeRole, scopeType: 'operator', scopeId: null },
  ]);
  admin2 = await signInAs(ctx.app, '+66810643002', PASSWORD);
  lookalike = await signInAs(ctx.app, '+66810643003', PASSWORD);
}, 300_000);
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });
beforeEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

type Res = { status: number; body: any; raw: string }; // eslint-disable-line @typescript-eslint/no-explicit-any -- test responses are asserted field by field
async function call(cookie: string | null, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown,
  key: string | null = newId(), origin?: string): Promise<Res> {
  const res = await ctx.app.inject({ method, url, payload: payload as never, headers: {
    ...(cookie ? { cookie } : {}), ...(key && method !== 'GET' ? { 'idempotency-key': key } : {}), ...(origin ? { origin } : {}),
  } });
  let body: unknown = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, raw: res.body };
}
const registry = async (key: 'pos' | 'console' | 'inbox' | 'oto_app' | 'radar' | 'booth') =>
  (await ctx.db.select().from(appRegistry).where(eq(appRegistry.key, key)))[0]!;
const auditsOf = (action: string) => ctx.db.select().from(auditLog).where(eq(auditLog.action, action));

async function maintain(app: 'pos' | 'inbox' | 'console', message: string, cookie = admin) {
  const res = await call(cookie, 'PUT', `/console/apps/${app}/maintenance`, { message, reason: 'ZZ TEST 643 planned work',
    expectedRevision: (await registry(app)).revision, confirmation: app });
  expect(res.status, res.raw).toBe(200);
  return res;
}
async function endMaintenance(app: 'pos' | 'inbox' | 'console') {
  const res = await call(admin, 'POST', `/console/apps/${app}/maintenance/clear`, { reason: 'ZZ TEST 643 done',
    expectedRevision: (await registry(app)).revision, confirmation: app });
  expect(res.status, res.raw).toBe(200);
}

/** Two administrators: one asks, the other approves, the first applies. */
async function switchOn(body: { key: string; scopeType: string; scopeId: string | null; operatorId: string | null; value?: unknown }) {
  const asked = await call(admin, 'POST', '/console/flags/approvals', { value: true, reason: 'ZZ TEST 643 incident',
    expectedRevision: 0, confirmation: body.key, ...body });
  expect(asked.status, asked.raw).toBe(200);
  const ref = { expectedPayloadSha256: asked.body.payloadSha256, confirmation: body.key };
  const approved = await call(admin2, 'POST', `/console/flags/approvals/${asked.body.id}/approve`, ref);
  expect(approved.status, approved.raw).toBe(200);
  const applyKey = newId();
  const applied = await call(admin, 'POST', `/console/flags/approvals/${asked.body.id}/apply`, ref, applyKey);
  expect(applied.status, applied.raw).toBe(200);
  return { approvalId: asked.body.id as string, ref, applyKey, flag: applied.body.flag, applied };
}
async function switchOff(flag: { flagKey: string; scopeType: string; scopeId: string | null; operatorId: string | null; revision: number }) {
  const res = await call(admin, 'POST', '/console/flags/clear', { key: flag.flagKey, scopeType: flag.scopeType, scopeId: flag.scopeId,
    operatorId: flag.operatorId, expectedRevision: flag.revision, reason: 'ZZ TEST 643 all clear', confirmation: flag.flagKey });
  expect(res.status, res.raw).toBe(200);
}

describe('SCRUM-643 maintenance: live scoped authority and replay', () => {
  it('P1 critical: only a live, genuine platform administrator may set maintenance; a keyed replay answers once', async () => {
    const body = (n = 0) => ({ message: 'ZZ TEST 643 back soon', reason: 'ZZ TEST 643 planned work', expectedRevision: n, confirmation: 'inbox' });
    const start = (await registry('inbox')).revision;
    expect((await call(null, 'PUT', '/console/apps/inbox/maintenance', body(start))).status).toBe(401);
    const foreign = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
    expect((await call(foreign, 'PUT', '/console/apps/inbox/maintenance', body(start))).status).toBe(403);
    // Platform-wide custom grants are not the system platform_admin role, re-checked in the transaction.
    expect((await call(lookalike, 'PUT', '/console/apps/inbox/maintenance', body(start))).status).toBe(403);
    expect((await call(admin, 'PUT', '/console/apps/inbox/maintenance', body(start), null)).status).toBe(400);
    expect((await call(admin, 'PUT', '/console/apps/inbox/maintenance', { ...body(start), confirmation: 'pos' })).body.error.code)
      .toBe('CONFIRMATION_MISMATCH');
    // A revoked administrator is refused at once, whatever their session cached.
    await ctx.db.update(s.roleAssignment).set({ archivedAt: new Date() }).where(eq(s.roleAssignment.accountId, admin2Id));
    expect((await call(admin2, 'PUT', '/console/apps/inbox/maintenance', body(start))).status).toBe(403);
    await ctx.db.update(s.roleAssignment).set({ archivedAt: null }).where(eq(s.roleAssignment.accountId, admin2Id));
    expect((await registry('inbox')).tileState).toBe('open');

    const key = newId();
    const first = await call(admin, 'PUT', '/console/apps/inbox/maintenance', body(start), key);
    expect(first.status, first.raw).toBe(200);
    expect(first.body.app).toMatchObject({ appKey: 'inbox', tileState: 'maintenance', maintenanceMessage: 'ZZ TEST 643 back soon',
      maintenanceRestoreState: 'open', revision: start + 1 });
    const expires = Date.parse(first.body.app.maintenanceExpiresAt) - Date.now();
    expect(expires).toBeGreaterThan(59 * 60_000); expect(expires).toBeLessThanOrEqual(60 * 60_000);
    const again = await call(admin, 'PUT', '/console/apps/inbox/maintenance', body(start), key);
    expect(again.status).toBe(200); expect(again.body).toEqual(first.body);
    const rows = (await auditsOf('app_registry.maintenance_set')).filter(r => r.targetApp === 'inbox');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorAccountId: adminId, targetApp: 'inbox', reason: 'ZZ TEST 643 planned work', origin: 'console' });
    // A stale revision is a conflict, never a silent overwrite.
    expect((await call(admin, 'PUT', '/console/apps/inbox/maintenance', body(start))).body.error.code).toBe('APP_REGISTRY_REVISION_CONFLICT');
    expect((await call(admin, 'PUT', '/console/apps/inbox/maintenance', { ...body(start + 1),
      expiresAt: new Date(Date.now() + 1441 * 60_000).toISOString() })).body.error.code).toBe('MAINTENANCE_EXPIRY_INVALID');
    await endMaintenance('inbox');
    expect(await registry('inbox')).toMatchObject({ tileState: 'open', maintenanceMessage: null, maintenanceExpiresAt: null });
    expect((await auditsOf('app_registry.maintenance_clear')).at(-1)).toMatchObject({ targetApp: 'inbox', origin: 'console' });
  });

  it('P2 high: an audit failure rolls the maintenance change back', async () => {
    const before = await registry('inbox');
    const original = audit.record.bind(audit);
    vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => {
      if (entry.action === 'app_registry.maintenance_set') throw Error('ZZ_TEST_AUDIT_FAILURE');
      return original(tx, entry);
    });
    const res = await call(admin, 'PUT', '/console/apps/inbox/maintenance', { message: 'ZZ TEST 643 never', reason: 'ZZ TEST 643',
      expectedRevision: before.revision, confirmation: 'inbox' });
    expect(res.status).toBe(500);
    vi.restoreAllMocks();
    expect(await registry('inbox')).toEqual(before);
  });
});

describe('SCRUM-643 maintenance at hand-off: mint and exchange', () => {
  const mint = (cookie: string, app: string) => call(cookie, 'POST', '/auth/handoff', { app }, null);
  const exchange = (token: string, origin: string) => call(null, 'POST', '/auth/handoff/exchange', { token }, null, origin);

  it('P3 critical: a token minted before maintenance is refused at exchange; other apps, existing sessions and platform sign-in keep working', async () => {
    const early = await mint(admin, 'pos'); expect(early.status, early.raw).toBe(200);
    const opened = await mint(admin, 'pos');
    const posCookie = (await ctx.app.inject({ method: 'POST', url: '/auth/handoff/exchange', headers: { origin: POS_ORIGIN },
      payload: { token: opened.body.token } })).headers['set-cookie'];
    const posSession = (Array.isArray(posCookie) ? posCookie[0]! : posCookie!).split(';')[0]!;

    await maintain('pos', 'ZZ TEST 643 the till is being updated');
    const refused = await exchange(early.body.token, POS_ORIGIN);
    expect(refused.status).toBe(503);
    expect(refused.body.error).toMatchObject({ code: 'APP_IN_MAINTENANCE', message: 'ZZ TEST 643 the till is being updated',
      details: { reason: 'maintenance' } });
    const rejected = (await auditsOf('auth.handoff_rejected')).filter(r => (r.after as { reason?: string }).reason === 'maintenance');
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    // The spent token stays spent: a retry after the window is a replay, not a way round it.
    expect((await mint(admin, 'pos')).body.error.code).toBe('APP_IN_MAINTENANCE');

    const consoleToken = await mint(admin, 'console'); expect(consoleToken.status).toBe(200);
    expect((await exchange(consoleToken.body.token, CONSOLE_ORIGIN)).status).toBe(200);
    expect((await call(posSession, 'GET', '/me')).status).toBe(200);
    expect((await call(admin, 'GET', '/me')).status).toBe(200);
    expect(await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password)).toBeTruthy();

    // The launcher's read needs no Console permission and carries the message.
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    expect((await call(reception, 'GET', '/console/apps')).status).toBe(403);
    const tiles = await call(reception, 'GET', '/suite/apps');
    expect(tiles.status).toBe(200);
    expect(tiles.body.apps.find((a: { key: string }) => a.key === 'pos')).toMatchObject({ state: 'maintenance',
      maintenance: { message: 'ZZ TEST 643 the till is being updated' } });
    expect(tiles.body.apps.some((a: { key: string }) => a.key === 'console')).toBe(false);
    expect(tiles.raw).not.toMatch(/origin|owningService|schemaName/);
    expect((await call(null, 'GET', '/suite/apps')).status).toBe(401);

    await endMaintenance('pos');
    const after = await mint(admin, 'pos'); expect(after.status).toBe(200);
    expect((await exchange(after.body.token, POS_ORIGIN)).status).toBe(200);
  });

  it('P4 high: an expired window refuses nothing, before any sweep has run', async () => {
    await maintain('pos', 'ZZ TEST 643 brief');
    await ctx.db.update(appRegistry).set({ maintenanceExpiresAt: new Date(Date.now() - 1) }).where(eq(appRegistry.key, 'pos'));
    const token = await mint(admin, 'pos'); expect(token.status, token.raw).toBe(200);
    expect((await exchange(token.body.token, POS_ORIGIN)).status).toBe(200);
    expect((await registry('pos')).tileState).toBe('maintenance');
    await runSuiteExpirySweep(ctx.db, { channels: [], flapWindowSeconds: 60 });
    expect(await registry('pos')).toMatchObject({ tileState: 'open', maintenanceMessage: null });
  });
});

describe('SCRUM-643 flags: catalogue, scope and dual control', () => {
  it('P5 critical: unknown and unsupported keys are refused on every write and the preview, and never stored', async () => {
    const unsupported = FLAG_CATALOGUE.filter(entry => !entry.supported).map(entry => entry.key);
    expect(unsupported.sort()).toEqual(['analytics.rollups_frozen', 'booth.stopped', 'gate.closed', 'payments.card_tender_disabled',
      'payments.manual_recording_forced', 'payments.qr_tender_disabled']);
    for (const key of unsupported) {
      const value = flagCatalogueEntry(key)!.valueType === 'enum' ? 'deny_all' : true;
      const body = { key, scopeType: 'operator', scopeId: oto, operatorId: oto, value, reason: 'ZZ TEST 643', expectedRevision: 0, confirmation: key };
      expect((await call(admin, 'PUT', '/console/flags', body)).body.error.code, key).toBe('FLAG_UNSUPPORTED');
      expect((await call(admin, 'POST', '/console/flags/approvals', body)).body.error.code, key).toBe('FLAG_UNSUPPORTED');
      expect((await call(admin, 'GET', `/console/flags/preview?key=${key}&scopeType=operator&scopeId=${oto}&operatorId=${oto}&value=${value}`)).body.error.code).toBe('FLAG_UNSUPPORTED');
    }
    const unknown = { key: 'zz.not.a.switch', scopeType: 'platform', scopeId: null, operatorId: null, value: true, reason: 'ZZ', expectedRevision: 0, confirmation: 'zz.not.a.switch' };
    expect((await call(admin, 'PUT', '/console/flags', unknown)).body.error.code).toBe('FLAG_UNKNOWN');
    expect((await call(admin, 'POST', '/console/flags/approvals', unknown)).body.error.code).toBe('FLAG_UNKNOWN');
    expect(await ctx.db.select().from(featureFlag)).toEqual([]);
    expect(await ctx.db.select().from(suiteControlApproval)).toEqual([]);
    const listed = await call(admin, 'GET', '/console/flags');
    expect(listed.status).toBe(200);
    expect(listed.body.catalogue.find((e: { flagKey: string }) => e.flagKey === 'payments.qr_tender_disabled')).toMatchObject({ supported: false });
    expect(listed.body.killSwitchDualControl).toBe(true);
  });

  it('P6 critical: foreign and mismatched scope ids are refused; authority never comes from the target', async () => {
    const base = { key: MESSAGING_PAUSE_KEY, value: true, reason: 'ZZ TEST 643', expectedRevision: 0, confirmation: MESSAGING_PAUSE_KEY };
    for (const scope of [
      { scopeType: 'branch', scopeId: central, operatorId: second },
      { scopeType: 'branch', scopeId: newId(), operatorId: oto },
      { scopeType: 'operator', scopeId: oto, operatorId: second },
      { scopeType: 'platform', scopeId: oto, operatorId: null },
      { scopeType: 'station', scopeId: central, operatorId: oto },
    ]) {
      const res = await call(admin, 'POST', '/console/flags/approvals', { ...base, ...scope });
      expect([res.status, res.body.error.code], JSON.stringify(scope)).toEqual([400, scope.scopeType === 'station' ? 'FLAG_SCOPE_NOT_ALLOWED' : 'SCOPE_TARGET_INVALID']);
    }
    expect((await call(admin, 'GET', `/console/flags/preview?key=${MESSAGING_PAUSE_KEY}&scopeType=branch&scopeId=${central}&operatorId=${second}&value=true`)).body.error.code).toBe('SCOPE_TARGET_INVALID');
    expect(await ctx.db.select().from(suiteControlApproval)).toEqual([]);
  });

  it('P7 critical: a kill switch cannot be set alone; self-approval and an expired approval are refused without effect', async () => {
    const body = { key: MESSAGING_PAUSE_KEY, scopeType: 'branch', scopeId: chalong, operatorId: oto, value: true,
      reason: 'ZZ TEST 643', expectedRevision: 0, confirmation: MESSAGING_PAUSE_KEY };
    expect((await call(admin, 'PUT', '/console/flags', body)).body.error.code).toBe('SECOND_APPROVAL_REQUIRED');
    const asked = await call(admin, 'POST', '/console/flags/approvals', body);
    expect(asked.status, asked.raw).toBe(200);
    expect(Date.parse(asked.body.requestExpiresAt) - Date.parse(asked.body.createdAt)).toBe(600_000);
    expect(Date.parse(asked.body.operation.expiresAt) - Date.parse(asked.body.createdAt)).toBeLessThanOrEqual(60 * 60_000);
    const ref = { expectedPayloadSha256: asked.body.payloadSha256, confirmation: MESSAGING_PAUSE_KEY };
    expect((await call(admin, 'POST', `/console/flags/approvals/${asked.body.id}/approve`, ref)).status).toBe(403);
    expect((await call(admin2, 'POST', `/console/flags/approvals/${asked.body.id}/approve`, { ...ref, confirmation: 'x' })).body.error.code)
      .toBe('CONFIRMATION_MISMATCH');
    expect((await call(admin, 'POST', `/console/flags/approvals/${asked.body.id}/apply`, ref)).status).toBe(409);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(asked.body.requestExpiresAt));
    try {
      const late = await call(admin2, 'POST', `/console/flags/approvals/${asked.body.id}/approve`, ref);
      expect([late.status, late.body.error.code]).toEqual([409, 'APPROVAL_EXPIRED']);
    } finally { vi.useRealTimers(); }
    const [row] = await ctx.db.select().from(suiteControlApproval).where(eq(suiteControlApproval.id, asked.body.id));
    expect(row!.state).toBe('expired');

    // Approved in time, but applied after the ten minutes: refused, and nothing is switched.
    const again = await call(admin, 'POST', '/console/flags/approvals', body);
    const ref2 = { expectedPayloadSha256: again.body.payloadSha256, confirmation: MESSAGING_PAUSE_KEY };
    expect((await call(admin2, 'POST', `/console/flags/approvals/${again.body.id}/approve`, ref2)).status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(again.body.requestExpiresAt));
    try {
      const late = await call(admin, 'POST', `/console/flags/approvals/${again.body.id}/apply`, ref2);
      expect([late.status, late.body.error.code]).toEqual([409, 'APPROVAL_EXPIRED']);
    } finally { vi.useRealTimers(); }
    expect(await ctx.db.select().from(featureFlag)).toEqual([]);
    expect((await auditsOf('suite_control.approval_expired')).length).toBe(2);
  });
});

describe('SCRUM-643 named consumers (Q24): pause outbound messaging and block new sign-ins', () => {
  const handed: string[] = [];
  const channel = {
    capabilities: { reply: true, media: false, freeTextWindowHours: null },
    send: async (msg: { clientRef: string }) => { handed.push(msg.clientRef); return { ok: true, externalMessageId: `fake.${msg.clientRef}`, acceptedAt: new Date() }; },
  } as unknown as MessagingChannel;
  const channels: InboxChannels = { forAccount: () => ({ ok: true, channel }), simulatorFor: () => null, simulatorEnabled: false, runId: 'zz-643' };

  async function queuedAt(branchId: string): Promise<string> {
    const accountId = newId(), contactId = newId(), conversationId = newId(), id = newId();
    await ctx.db.insert(s.channelAccount).values({ id: accountId, operatorId: oto, branchId, channel: 'whatsapp', provider: 'simulator',
      externalId: `zz-643-${accountId}`, displayName: 'ZZ TEST 643', defaultCategory: 'general', canReply: true, status: 'active' });
    await ctx.db.insert(s.contact).values({ id: contactId, operatorId: oto, channel: 'whatsapp', externalHandle: `+6681${Math.floor(Math.random() * 1e7)}` });
    await ctx.db.insert(s.conversation).values({ id: conversationId, operatorId: oto, contactId, channelAccountId: accountId, branchId });
    await ctx.db.insert(s.message).values({ id, operatorId: oto, conversationId, channelAccountId: accountId, direction: 'outbound',
      authorKind: 'system', body: 'ZZ TEST 643 hello', providerStatus: 'queued' });
    return id;
  }
  const messageRow = async (id: string) => (await ctx.db.select().from(s.message).where(eq(s.message.id, id)))[0]!;

  it('P8 critical: the preview and the send path agree; a paused park hands nothing to the channel; replay answers once', async () => {
    const preview = await call(admin, 'GET', `/console/flags/preview?key=${MESSAGING_PAUSE_KEY}&scopeType=branch&scopeId=${central}&operatorId=${oto}&value=true`);
    expect(preview.status, preview.raw).toBe(200);
    expect(preview.body.branches).toEqual([expect.objectContaining({ branchId: central, current: false, after: true })]);
    expect(preview.body.changes).toBeGreaterThanOrEqual(1);
    expect(typeof preview.body.openSessions).toBe('number');
    const wide = await call(admin, 'GET', `/console/flags/preview?key=${MESSAGING_PAUSE_KEY}&scopeType=operator&scopeId=${oto}&operatorId=${oto}&value=true`);
    expect(wide.body.branches.map((b: { branchId: string }) => b.branchId)).toEqual(expect.arrayContaining([central, chalong]));
    expect(wide.body.branches.every((b: { operatorId: string }) => b.operatorId === oto)).toBe(true);

    const on = await switchOn({ key: MESSAGING_PAUSE_KEY, scopeType: 'branch', scopeId: central, operatorId: oto });
    expect(on.flag).toMatchObject({ flagKey: MESSAGING_PAUSE_KEY, value: true, revision: 1, targetApp: 'inbox' });
    const replay = await call(admin, 'POST', `/console/flags/approvals/${on.approvalId}/apply`, on.ref, on.applyKey);
    expect(replay.status).toBe(200); expect(replay.body).toEqual(on.applied.body);
    expect(await ctx.db.select().from(featureFlag)).toHaveLength(1);
    expect((await auditsOf('feature_flag.set')).at(-1)).toMatchObject({ targetApp: 'inbox', reason: 'ZZ TEST 643 incident',
      origin: 'console', operatorId: oto, branchId: central });

    // The same resolver, now answering for enforcement.
    for (const row of preview.body.branches as Array<{ branchId: string; after: boolean }>) {
      expect((await effectiveFlag(ctx.db, MESSAGING_PAUSE_KEY, { operatorId: oto, branchId: row.branchId, stationId: null })).value).toBe(row.after);
    }
    const paused = await queuedAt(central), open = await queuedAt(chalong);
    handed.length = 0;
    expect((await sendQueuedMessage(ctx.db, { channels }, paused)).outcome).toBe('paused');
    expect((await sendQueuedMessage(ctx.db, { channels }, open)).outcome).toBe('sent');
    expect(handed).toEqual([open]);
    expect(await messageRow(paused)).toMatchObject({ providerStatus: 'queued', sendAttempts: 0, error: null });

    await switchOff(on.flag);
    const later = new Date(Date.now() + 120_000);
    expect((await sendQueuedMessage(ctx.db, { channels, now: () => later }, paused)).outcome).toBe('sent');
    expect(handed).toEqual([open, paused]);
  });

  it('P9 critical: "block new sign-ins" refuses that app at its park group only, with its own reason word', async () => {
    const on = await switchOn({ key: signInBlockKey('inbox'), scopeType: 'operator', scopeId: oto, operatorId: oto });
    const blocked = await call(admin, 'POST', '/auth/handoff', { app: 'inbox' }, null);
    expect([blocked.status, blocked.body.error.code, blocked.body.error.details.reason]).toEqual([503, 'APP_SIGN_IN_BLOCKED', 'sign_in_blocked']);
    expect((await call(admin, 'POST', '/auth/handoff', { app: 'pos' }, null)).status).toBe(200);
    const foreign = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
    const theirs = await call(foreign, 'POST', '/auth/handoff', { app: 'inbox' }, null);
    expect(theirs.status, theirs.raw).toBe(200);
    // A token minted for another park group's session is untouched; one minted here before the switch is refused.
    expect((await call(null, 'POST', '/auth/handoff/exchange', { token: theirs.body.token }, null, INBOX_ORIGIN)).status).toBe(200);
    await switchOff(on.flag);
    const early = await call(admin, 'POST', '/auth/handoff', { app: 'inbox' }, null); expect(early.status).toBe(200);
    const again = await switchOn({ key: signInBlockKey('inbox'), scopeType: 'operator', scopeId: oto, operatorId: oto });
    const refused = await call(null, 'POST', '/auth/handoff/exchange', { token: early.body.token }, null, INBOX_ORIGIN);
    expect([refused.status, refused.body.error.code]).toEqual([503, 'APP_SIGN_IN_BLOCKED']);
    await switchOff(again.flag);
  });
});

describe('SCRUM-643 expiry: read-time fallback and the sweep', () => {
  const entry = flagCatalogueEntry(MESSAGING_PAUSE_KEY)!;
  async function stored(expiresAt: Date, scopeId = chalong) {
    const [row] = await ctx.db.insert(featureFlag).values({ id: newId(), key: MESSAGING_PAUSE_KEY, kind: 'kill_switch', targetApp: 'inbox',
      scopeType: 'branch', scopeId, operatorId: oto, value: true, defaultValue: false, expiresAt, reason: 'ZZ TEST 643 timed',
      updatedBy: adminId }).returning();
    return row!;
  }

  it('P10 critical: the exact expiry instant already resolves to the safe fallback', async () => {
    const at = new Date('2026-10-27T03:00:00.000Z');
    const row = { id: newId(), key: MESSAGING_PAUSE_KEY, kind: 'kill_switch' as const, targetApp: 'inbox' as const, scopeType: 'branch' as const,
      scopeId: chalong, operatorId: oto, value: true, defaultValue: false, expiresAt: at, reason: 'r', updatedBy: null, revision: 1,
      createdAt: at, updatedAt: at };
    const lineage = { operatorId: oto, branchId: chalong, stationId: null };
    expect(resolveFlag(entry, [row], lineage, new Date(at.getTime() - 1)).value).toBe(true);
    expect(resolveFlag(entry, [row], lineage, at).value).toBe(false);
    // A row owned by another park group never answers for this lineage.
    expect(resolveFlag(entry, [{ ...row, expiresAt: null, operatorId: second }], lineage, at).value).toBe(false);
  });

  it('P11 critical: the sweep reverts what expired, alerts, and never overwrites a later edit', async () => {
    const spent = await stored(new Date(Date.now() - 1000));
    const delivered: Array<{ category: string; event: string }> = [];
    const out = await runSuiteExpirySweep(ctx.db, { channels: [{ name: 'console', deliver: async m => { delivered.push(m); return { target: 'test' }; } }], flapWindowSeconds: 60 });
    expect(out.flagsReverted).toBe(1);
    expect(await ctx.db.select().from(featureFlag).where(eq(featureFlag.id, spent.id))).toEqual([]);
    expect((await auditsOf('feature_flag.auto_revert')).at(-1)).toMatchObject({ entityId: spent.id, targetApp: 'inbox', reason: 'expired',
      origin: 'job', actorAccountId: null, operatorId: oto });
    expect(delivered.some(m => m.category === 'suite_control.ended')).toBe(true);

    // The sweep read a spent row, then a person extended it before the sweep acted.
    const seen = await stored(new Date(Date.now() - 1000));
    await ctx.db.update(featureFlag).set({ revision: 2, expiresAt: new Date(Date.now() + 30 * 60_000) }).where(eq(featureFlag.id, seen.id));
    expect(await revertSpentFlag(ctx.db, seen, new Date())).toBeNull();
    expect((await ctx.db.select().from(featureFlag).where(eq(featureFlag.id, seen.id)))[0]).toMatchObject({ revision: 2 });
    await ctx.db.delete(featureFlag).where(eq(featureFlag.id, seen.id));

    await maintain('inbox', 'ZZ TEST 643 window');
    await ctx.db.update(appRegistry).set({ maintenanceExpiresAt: new Date(Date.now() - 1) }).where(eq(appRegistry.key, 'inbox'));
    const before = await registry('inbox');
    await ctx.db.update(appRegistry).set({ revision: before.revision + 1, maintenanceExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(appRegistry.key, 'inbox'));
    expect(await endSpentMaintenance(ctx.db, before, new Date())).toBeNull();
    expect((await registry('inbox')).tileState).toBe('maintenance');
    await endMaintenance('inbox');
  });
});

describe('SCRUM-643 seed replay and deploy history', () => {
  it('P12 high: a platform sync keeps saved maintenance and flags, and restores only a missing app', async () => {
    await maintain('inbox', 'ZZ TEST 643 kept across a deploy');
    const [flag] = await ctx.db.insert(featureFlag).values({ id: newId(), key: signInBlockKey('radar'), kind: 'kill_switch', targetApp: 'radar',
      scopeType: 'platform', scopeId: null, operatorId: null, value: true, defaultValue: false,
      expiresAt: new Date(Date.now() + 30 * 60_000), reason: 'ZZ TEST 643 kept', updatedBy: adminId }).returning();
    await ctx.db.update(appRegistry).set({ tileState: 'hidden', sortOrder: 99 }).where(eq(appRegistry.key, 'booth'));
    const registryBefore = await ctx.db.select().from(appRegistry);
    await ctx.db.delete(appRegistry).where(eq(appRegistry.key, 'oto_app'));
    await platformSync(ctx.db);
    const after = await ctx.db.select().from(appRegistry);
    for (const row of registryBefore.filter(r => r.key !== 'oto_app')) expect(after.find(r => r.key === row.key)).toEqual(row);
    expect(after.find(r => r.key === 'oto_app')).toMatchObject({ tileState: 'open', requiredPermission: 'app:oto_app:access' });
    expect(await ctx.db.select().from(featureFlag).where(eq(featureFlag.id, flag!.id))).toEqual([flag]);
    await ctx.db.delete(featureFlag).where(eq(featureFlag.id, flag!.id));
    await ctx.db.update(appRegistry).set({ tileState: 'open', sortOrder: 50 }).where(eq(appRegistry.key, 'booth'));
    await endMaintenance('inbox');
  });

  it('P13 high: deploy facts are recorded exactly as supplied, by a platform administrator, once per id', async () => {
    const event = { id: newId(), app: 'pos', status: 'live', version: null, commit: 'abc1234', ciGreen: null, deployedAt: null };
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    expect((await call(reception, 'POST', '/console/deploy-events', event)).status).toBe(403);
    const first = await call(admin, 'POST', '/console/deploy-events', event);
    expect(first.status, first.raw).toBe(200); expect(first.body).toEqual({ id: event.id, replay: false });
    expect((await call(admin, 'POST', '/console/deploy-events', event)).body).toEqual({ id: event.id, replay: true });
    expect((await call(admin, 'POST', '/console/deploy-events', { ...event, status: 'failed' })).body.error.code).toBe('DEPLOY_EVENT_CONFLICT');
    const history = await call(admin, 'GET', '/console/releases?app=pos');
    expect(history.body.deployments.find((d: { id: string }) => d.id === event.id)).toMatchObject({ version: null, ciGreen: null,
      deployedAt: null, commit: 'abc1234', actorAccountId: adminId });
    expect((await auditsOf('deploy_event.record')).filter(r => r.entityId === event.id)).toHaveLength(1);
  });
});
