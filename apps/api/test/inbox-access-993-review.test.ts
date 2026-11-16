import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema as s } from '@oto/db';
import { PERMISSIONS, newId, type InboxAccessSelection, type Permission } from '@oto/shared';
import { hashToken, newSessionToken, SESSION_COOKIE } from '../src/plugins/session';
import type { FileStorage } from '../src/services/files';
import { inboxAdministratorSql } from '../src/services/inbox/access';
import { createTestContext, teardownAll, type TestContext } from './helpers';

let ctx: TestContext, f: Awaited<ReturnType<typeof fixture>>;
const inboxPermissions = PERMISSIONS.filter(p => p.startsWith('inbox:') || p === 'app:inbox:access');
const signedGet = vi.fn(async () => 'https://files.example.invalid/ZZ-TEST');
beforeAll(async () => {
  ctx = await createTestContext({ env: { INBOX_SIMULATOR: 'on', INBOX_SIMULATOR_SECRET: randomBytes(24).toString('hex'),
    PGW_PROVIDER: 'simulator', PGW_MERCHANT_ID: 'ZZTEST993', PGW_SECRET_KEY: randomBytes(32).toString('hex'),
    PGW_WEBHOOK_SECRET: randomBytes(24).toString('hex'), PGW_BACKEND_RETURN_URL: 'https://api.example.test/webhooks/2c2p/payment' } });
  const storage: FileStorage = { bucket: 'ZZ-TEST', presignedGet: signedGet, presignedPut: async () => '',
    put: async () => undefined, remove: async () => undefined, probe: async () => ({ state: 'ready' }) };
  (ctx.app as { fileStorage: FileStorage | null }).fileStorage = storage;
}, 180000);
beforeEach(async () => { signedGet.mockClear(); f = await fixture(); });
afterAll(async () => { await ctx?.close(); await teardownAll(); });

async function person(operatorId: string, permissions: readonly Permission[], scopeType: 'operator' | 'branch' | 'department' = 'operator', scopeId = operatorId, branchId?: string) {
  const accountId = newId(), roleId = newId(), employeeId = newId();
  await ctx.db.insert(s.employee).values({ id: employeeId, operatorId, branchId, name: 'ZZ TEST access staff' });
  await ctx.db.insert(s.account).values({ id: accountId, operatorId, employeeId, phone: `+66${randomBytes(6).readUIntBE(0, 6)}`, status: 'active', phoneVerifiedAt: new Date() });
  await ctx.db.insert(s.role).values({ id: roleId, operatorId, name: `ZZ TEST ${roleId}` });
  if (permissions.length) await ctx.db.insert(s.rolePermission).values(permissions.map(permission => ({ id: newId(), roleId, permission })));
  await ctx.db.insert(s.roleAssignment).values({ id: newId(), roleId, accountId, scopeType, scopeId });
  const token = newSessionToken();
  await ctx.db.insert(s.session).values({ id: newId(), accountId, tokenHash: hashToken(token), branchId,
    expiresAt: new Date(Date.now() + 3600000) });
  return { accountId, roleId, cookie: `${SESSION_COOKIE}=${token}` };
}
async function fixture() {
  const operatorId = newId(), foreignOperatorId = newId(), branchA = newId(), branchB = newId(), departmentId = newId();
  await ctx.db.insert(s.operator).values([{ id: operatorId, name: 'ZZ TEST access operator' }, { id: foreignOperatorId, name: 'ZZ TEST foreign operator' }]);
  await ctx.db.insert(s.branch).values([{ id: branchA, operatorId, code: 'ZZA', name: 'ZZ TEST park A' }, { id: branchB, operatorId, code: 'ZZB', name: 'ZZ TEST park B' }]);
  await ctx.db.insert(s.department).values({ id: departmentId, operatorId, name: 'ZZ TEST birthday team' });
  const admin = await person(operatorId, PERMISSIONS);
  const subject = await person(operatorId, inboxPermissions, 'operator', operatorId, branchA);
  const foreign = await person(foreignOperatorId, PERMISSIONS);
  const teamId = newId();
  await ctx.db.insert(s.team).values({ id: teamId, operatorId, key: 'birthdays', departmentId, name: 'ZZ TEST birthdays', colour: '#000000' });
  const channelA = newId(), channelB = newId(), foreignChannel = newId();
  await ctx.db.insert(s.channelAccount).values([
    { id: channelA, operatorId, branchId: branchA, channel: 'whatsapp', provider: 'simulator', externalId: newId(), displayName: 'ZZ TEST allowed source' },
    { id: channelB, operatorId, branchId: branchB, channel: 'whatsapp', provider: 'simulator', externalId: newId(), displayName: 'ZZ TEST excluded source' },
    { id: foreignChannel, operatorId: foreignOperatorId, channel: 'whatsapp', provider: 'simulator', externalId: newId(), displayName: 'ZZ TEST foreign source' },
  ]);
  const threads: { id: string; messageId: string; contactId: string }[] = [];
  for (const [category, channelAccountId, branchId] of [['general', channelA, branchA], ['birthdays', channelA, branchA], ['general', channelB, branchB]] as const) {
    const id = newId(), contactId = newId(), messageId = newId();
    await ctx.db.insert(s.contact).values({ id: contactId, operatorId, channel: 'whatsapp', externalHandle: newId(), displayName: `ZZ TEST ${category} ${threads.length}` });
    await ctx.db.insert(s.conversation).values({ id, operatorId, channelAccountId, contactId, branchId, category,
      teamId: category === 'birthdays' ? teamId : null, lastCustomerMessageAt: new Date(), lastMessageAt: new Date(), lastMessagePreview: `ZZ TEST searchable ${threads.length}` });
    await ctx.db.insert(s.message).values({ id: messageId, operatorId, conversationId: id, channelAccountId, authorKind: 'customer', direction: 'inbound', body: `ZZ TEST private body ${threads.length}` });
    threads.push({ id, messageId, contactId });
  }
  return { operatorId, foreignOperatorId, branchA, branchB, departmentId, teamId, admin, subject, foreign,
    channelA, channelB, foreignChannel, general: threads[0]!, birthday: threads[1]!, other: threads[2]! };
}
type Actor = { cookie: string; accountId: string };
function request(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, who: Actor = f.subject, payload?: unknown, key = newId()) {
  return ctx.app.inject({ method, url, headers: { cookie: who.cookie, ...(method === 'GET' ? {} : { 'idempotency-key': key }) }, ...(payload === undefined ? {} : { payload: payload as never }) });
}
const accountUrl = (id = f.subject.accountId) => `/accounts/${id}/inbox-access`;
async function restrict(selection: InboxAccessSelection, target = f.subject) {
  const current = await request('GET', accountUrl(target.accountId), f.admin);
  expect(current.statusCode, current.body).toBe(200);
  const response = await request('PUT', accountUrl(target.accountId), f.admin, { ...selection, expectedVersion: current.json().version });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
const list = (who = f.subject, query = '') => request('GET', `/inbox/conversations?tab=team${query}`, who);
const detail = (id: string, who = f.subject) => request('GET', `/inbox/conversations/${id}`, who);
const ids = (response: Awaited<ReturnType<typeof request>>) => response.json().conversations.map((r: { id: string }) => r.id).sort();

describe('SCRUM-993 adversarial category/channel policy review', () => {
  it('HIGH: initially empty policies preserve existing reads and never create grants on GET or preview', async () => {
    expect(ids(await list())).toEqual([f.general.id, f.birthday.id, f.other.id].sort());
    expect((await request('GET', accountUrl(), f.admin)).json()).toMatchObject({ version: 0, categories: null, channelAccountIds: null, canManage: true });
    const preview = await request('POST', `${accountUrl()}/preview`, f.admin, { expectedVersion: 0, categories: [], channelAccountIds: null });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ before: { categories: null }, after: { categories: [] }, changed: true });
    expect(await ctx.db.select().from(s.accountInboxAccess).where(eq(s.accountInboxAccess.operatorId, f.operatorId))).toHaveLength(0);
  });
  it.each(['categories', 'channelAccountIds'] as const)('HIGH: explicit empty %s means none while null restores existing reach', async field => {
    await restrict({ categories: null, channelAccountIds: null, [field]: [] });
    const empty = await list();
    expect(ids(empty)).toEqual([]); expect(empty.json().tabCounts.team).toBe(0);
    expect((await detail(f.general.id)).statusCode).toBe(404);
    const me = await request('GET', '/inbox/me');
    expect(me.json().contactChannels).toEqual([]);
    await restrict({ categories: null, channelAccountIds: null });
    expect(ids(await list())).toHaveLength(3);
  });
  it('HIGH: fresh category and channel intersection fences list, counts, search, direct detail, messages and contacts with the same session', async () => {
    await restrict({ categories: ['general'], channelAccountIds: [f.channelA] });
    const rows = await list(); expect(ids(rows)).toEqual([f.general.id]);
    expect(rows.json()).toMatchObject({ tabCounts: { team: 1 }, access: { categories: ['general'], channelAccountIds: [f.channelA], version: 1 } });
    expect(ids(await list(f.subject, '&q=searchable%201'))).toEqual([]);
    for (const hidden of [f.birthday.id, f.other.id]) {
      for (const suffix of ['', '/messages', '/contact', '/prebooking']) expect((await request('GET', `/inbox/conversations/${hidden}${suffix}`)).statusCode).toBe(404);
    }
    const dashboard = await request('GET', '/inbox/dashboard');
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    expect(dashboard.json()).toMatchObject({ active: 1, byCategory: { general: 1, birthdays: 0, gm: 0, marketing: 0 } });
  });
  it('HIGH: department and held-assignment reach remain intersected and a policy never adds branch reach', async () => {
    const team = await person(f.operatorId, inboxPermissions, 'department', f.departmentId, f.branchA);
    const branch = await person(f.operatorId, inboxPermissions, 'branch', f.branchA, f.branchA);
    expect(ids(await list(team))).toEqual([f.birthday.id]);
    await ctx.db.insert(s.assignment).values({ id: newId(), operatorId: f.operatorId, conversationId: f.other.id,
      slot: 'support', slotIndex: 1, assigneeKind: 'account', accountId: team.accountId, assignedByKind: 'system', reason: 'manual' });
    expect(ids(await list(team))).toEqual([f.birthday.id, f.other.id].sort());
    await restrict({ categories: ['birthdays'], channelAccountIds: [f.channelA] }, team);
    expect(ids(await list(team))).toEqual([f.birthday.id]);
    expect((await detail(f.other.id, team)).statusCode).toBe(404);
    await restrict({ categories: null, channelAccountIds: null }, branch);
    expect((await detail(f.other.id, branch)).statusCode).toBe(404);
  });
  it('HIGH: foreign and branch-scoped administrator markers do not bypass limits; an actual administrator still has tenant and read-scope fences', async () => {
    const markerRole = newId();
    await ctx.db.insert(s.role).values({ id: markerRole, operatorId: f.operatorId, name: 'ZZ TEST administrator marker' });
    await ctx.db.insert(s.rolePermission).values({ id: newId(), roleId: markerRole, permission: 'admin:operator:all' });
    for (const scope of [{ scopeType: 'operator' as const, scopeId: f.foreignOperatorId }, { scopeType: 'branch' as const, scopeId: f.branchA }]) {
      await ctx.db.insert(s.roleAssignment).values({ id: newId(), accountId: f.subject.accountId, roleId: markerRole, ...scope });
    }
    await restrict({ categories: [], channelAccountIds: [] });
    expect(ids(await list())).toEqual([]);
    await ctx.db.insert(s.roleAssignment).values({ id: newId(), accountId: f.subject.accountId, roleId: markerRole, scopeType: 'operator', scopeId: f.operatorId });
    expect(ids(await list())).toHaveLength(3);
    expect((await detail(f.general.id, f.foreign)).statusCode).toBe(404);
    await ctx.db.delete(s.rolePermission).where(and(eq(s.rolePermission.roleId, f.subject.roleId), eq(s.rolePermission.permission, 'inbox:conversation:read')));
    const narrowReadRole = newId();
    await ctx.db.insert(s.role).values({ id: narrowReadRole, operatorId: f.operatorId, name: 'ZZ TEST narrow read' });
    await ctx.db.insert(s.rolePermission).values({ id: newId(), roleId: narrowReadRole, permission: 'inbox:conversation:read' });
    await ctx.db.insert(s.roleAssignment).values({ id: newId(), accountId: f.subject.accountId, roleId: narrowReadRole, scopeType: 'branch', scopeId: f.branchA });
    expect((await detail(f.other.id)).statusCode).toBe(404);
    const actual = await ctx.db.execute(sql`select ${inboxAdministratorSql({ accountId: f.subject.accountId, operatorId: f.operatorId })} as administrator`);
    expect(actual.rows[0]).toMatchObject({ administrator: true });
  });
  it('HIGH: signed media URLs are not issued after policy revocation', async () => {
    const fileId = newId();
    await ctx.db.insert(s.fileObject).values({ id: fileId, operatorId: f.operatorId, bucket: 'ZZ-TEST', objectKey: 'ZZ-TEST', contentType: 'image/png',
      ownerEntityType: 'inbox.message', ownerEntityId: f.birthday.messageId });
    const url = `/files/${fileId}/url`;
    expect((await request('GET', url)).statusCode).toBe(200); expect(signedGet).toHaveBeenCalledTimes(1);
    await restrict({ categories: ['general'], channelAccountIds: null });
    expect((await request('GET', url)).statusCode).toBe(404); expect(signedGet).toHaveBeenCalledTimes(1);
  });
  it.each(['categories', 'channelAccountIds'] as const)('HIGH: cached actions replay exactly while allowed, then deny revoked %s without repeating the action', async field => {
    const key = newId(), url = `/inbox/conversations/${f.birthday.id}/handle`;
    const first = await request('POST', url, f.subject, undefined, key);
    expect(first.statusCode, first.body).toBe(200);
    const same = await request('POST', url, f.subject, undefined, key);
    expect(same.statusCode).toBe(200); expect(same.body).toBe(first.body); expect(same.headers['x-oto-replay']).toBe('true');
    await restrict(field === 'categories' ? { categories: ['general'], channelAccountIds: null } : { categories: null, channelAccountIds: [f.channelB] });
    const denied = await request('POST', url, f.subject, undefined, key);
    expect(denied.statusCode).toBe(404); expect(denied.headers['x-oto-replay']).toBeUndefined(); expect(denied.body).not.toBe(first.body);
    const events = await ctx.db.select().from(s.inboxEvent).where(and(eq(s.inboxEvent.conversationId, f.birthday.id), eq(s.inboxEvent.kind, 'handled')));
    expect(events).toHaveLength(1);
  });
  it('HIGH: cached contact name and read-marker answers are denied after category revocation', async () => {
    for (const [method, suffix, body] of [['PATCH', 'contact', { displayName: 'ZZ TEST reviewed name' }], ['POST', 'read', {}]] as const) {
      const key = newId(), url = `/inbox/conversations/${f.birthday.id}/${suffix}`;
      const first = await request(method, url, f.subject, body, key); expect(first.statusCode, first.body).toBe(200);
      await restrict({ categories: ['general'], channelAccountIds: null });
      expect((await request(method, url, f.subject, body, key)).statusCode).toBe(404);
      await restrict({ categories: null, channelAccountIds: null });
    }
  });
  it.each(['archived', 'cannotReply', 'category', 'channel'] as const)('HIGH: cached contact creation rechecks current %s eligibility', async change => {
    const key = newId(), body = { channelAccountId: f.channelA, displayName: 'ZZ TEST created contact', identity: '+66819999301' };
    const first = await request('POST', '/inbox/contacts', f.subject, body, key); expect(first.statusCode, first.body).toBe(200);
    const replay = await request('POST', '/inbox/contacts', f.subject, body, key); expect(replay.body).toBe(first.body); expect(replay.headers['x-oto-replay']).toBe('true');
    if (change === 'archived') await ctx.db.update(s.channelAccount).set({ archivedAt: new Date() }).where(eq(s.channelAccount.id, f.channelA));
    else if (change === 'cannotReply') await ctx.db.update(s.channelAccount).set({ canReply: false }).where(eq(s.channelAccount.id, f.channelA));
    else await restrict(change === 'category' ? { categories: ['birthdays'], channelAccountIds: null } : { categories: null, channelAccountIds: [f.channelB] });
    const denied = await request('POST', '/inbox/contacts', f.subject, body, key);
    expect(denied.statusCode).toBe(change === 'cannotReply' ? 409 : 404); expect(denied.headers['x-oto-replay']).toBeUndefined();
  });
  it('HIGH: archived Start over checks fresh limits before already-cleared and cached answers', async () => {
    await ctx.db.update(s.conversation).set({ archivedAt: new Date() }).where(eq(s.conversation.id, f.birthday.id));
    const key = newId(), url = `/inbox/conversations/${f.birthday.id}/start-over`;
    const first = await request('POST', url, f.subject, undefined, key); expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ alreadyCleared: true });
    await restrict({ categories: ['general'], channelAccountIds: null });
    expect((await request('POST', url, f.subject, undefined, key)).statusCode).toBe(404);
    expect((await request('POST', url)).statusCode).toBe(404);
  });
  it('HIGH: the landed prebooking request keeps its stronger replay guard and denies revoked channel access before cached deposit details', async () => {
    const key = newId(), url = `/inbox/conversations/${f.birthday.id}/prebooking`;
    const body = { requestId: newId(), amountSatang: 300000, booking: { id: newId(), branchId: f.branchA,
      date: '2099-11-21', startTime: '14:00', kids: 12, adults: 4, contactName: 'ZZ TEST parent', phone: null, childName: 'ZZ TEST child', childAge: 6 } };
    const first = await request('POST', url, f.subject, body, key); expect(first.statusCode, first.body).toBe(200);
    const replay = await request('POST', url, f.subject, body, key); expect(replay.body).toBe(first.body); expect(replay.headers['x-oto-replay']).toBe('true');
    await restrict({ categories: null, channelAccountIds: [f.channelB] });
    const denied = await request('POST', url, f.subject, body, key); expect(denied.statusCode).toBe(404); expect(denied.headers['x-oto-replay']).toBeUndefined();
    expect(await ctx.db.select().from(s.prebookingDepositRequest).where(eq(s.prebookingDepositRequest.draftId, body.booking.id))).toHaveLength(1);
  });
  it('HIGH: channel/category names and proposed AI source text disappear from all matching pickers and queues', async () => {
    const exampleId = newId();
    await ctx.db.insert(s.aiExample).values({ id: exampleId, operatorId: f.operatorId, intent: 'hours', language: 'en', customerText: 'ZZ TEST restricted source question',
      goodReply: 'ZZ TEST answer', verdict: 'should_answer', proposedByAccountId: f.subject.accountId, sourceConversationId: f.birthday.id, sourceMessageId: f.birthday.messageId });
    expect((await request('GET', '/inbox/ai/examples')).body).toContain(exampleId);
    const key = newId(), patch = { goodReply: 'ZZ TEST reviewed answer' }, exampleUrl = `/inbox/ai/examples/${exampleId}`;
    const first = await request('PATCH', exampleUrl, f.subject, patch, key); expect(first.statusCode, first.body).toBe(200);
    expect((await request('PATCH', exampleUrl, f.subject, patch, key)).body).toBe(first.body);
    await restrict({ categories: ['general'], channelAccountIds: [f.channelA] });
    const me = await request('GET', '/inbox/me'); expect(me.statusCode, me.body).toBe(200);
    expect(me.body).not.toContain(f.channelB); expect(me.body).not.toContain('ZZ TEST excluded source'); expect(me.json().teams).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: 'birthdays' })]));
    const queue = await request('GET', '/inbox/ai/examples'); expect(queue.statusCode, queue.body).toBe(200); expect(queue.body).not.toContain(exampleId); expect(queue.body).not.toContain('restricted source question');
    expect((await request('PATCH', exampleUrl, f.subject, patch, key)).statusCode).toBe(404);
    expect((await request('PATCH', `/inbox/ai/examples/${exampleId}`, f.subject, { customerText: 'ZZ TEST edited' })).statusCode).toBe(404);
    const channels = await request('GET', '/inbox/ai/channel-accounts'); expect(channels.statusCode, channels.body).toBe(200); expect(channels.body).not.toContain(f.channelB);
  });
  it('HIGH: erasure preview and execution cannot expose or erase a subject whose other thread is outside the current limits', async () => {
    await ctx.db.update(s.contact).set({ phone: '+66819999302' }).where(eq(s.contact.id, f.birthday.contactId));
    await ctx.db.update(s.contact).set({ phone: '+66819999302' }).where(eq(s.contact.id, f.general.contactId));
    await restrict({ categories: ['general'], channelAccountIds: null });
    const url = `/inbox/contacts/${f.general.contactId}/erase`;
    const preview = await request('POST', url, f.subject, {}); expect(preview.statusCode, preview.body).toBe(404);
    const erase = await request('POST', url, f.subject, { confirmContactId: f.general.contactId, confirm: 'ERASE' }); expect(erase.statusCode).toBe(404);
    const [message] = await ctx.db.select().from(s.message).where(eq(s.message.id, f.general.messageId)); expect(message!.body).toBe('ZZ TEST private body 0');
  });
  it('HIGH: category changes cannot move a visible conversation into a forbidden category', async () => {
    await restrict({ categories: ['general'], channelAccountIds: null });
    const denied = await request('POST', `/inbox/conversations/${f.general.id}/move`, f.subject, { dest: { kind: 'birthdays' } });
    expect(denied.statusCode, denied.body).toBe(404);
    const [row] = await ctx.db.select().from(s.conversation).where(eq(s.conversation.id, f.general.id)); expect(row!.category).toBe('general');
  });
  it('HIGH: foreign target/channel policy writes fail and actual administrator targets cannot be restricted', async () => {
    expect((await request('GET', accountUrl(f.foreign.accountId), f.admin)).statusCode).toBe(404);
    expect((await request('PUT', accountUrl(), f.admin, { expectedVersion: 0, categories: null, channelAccountIds: [f.foreignChannel] })).statusCode).toBe(404);
    expect((await request('PUT', accountUrl(f.admin.accountId), f.admin, { expectedVersion: 0, categories: [], channelAccountIds: [] })).statusCode).toBe(403);
    expect(await ctx.db.select().from(s.accountInboxAccess).where(eq(s.accountInboxAccess.operatorId, f.operatorId))).toHaveLength(0);
  });
  it('HIGH: branch-only role managers can read a dominated local account but cannot write a global policy or see foreign park channel names', async () => {
    const local = await person(f.operatorId, [], 'branch', f.branchA, f.branchA);
    const manager = await person(f.operatorId, ['admin:role:read', 'admin:role:assign'], 'branch', f.branchA, f.branchA);
    const read = await request('GET', accountUrl(local.accountId), manager); expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ canManage: false }); expect(read.body).not.toContain(f.channelB);
    const body = { expectedVersion: 0, categories: [], channelAccountIds: [] };
    expect((await request('POST', `${accountUrl(local.accountId)}/preview`, manager, body)).statusCode).toBe(403);
    expect((await request('PUT', accountUrl(local.accountId), manager, body)).statusCode).toBe(403);
  });
  it('HIGH: expected-version CAS serializes different concurrent writes; stale retries cannot overwrite or duplicate the audit', async () => {
    const choices = [{ expectedVersion: 0, categories: ['general'], channelAccountIds: null }, { expectedVersion: 0, categories: ['birthdays'], channelAccountIds: null }];
    const replies = await Promise.all(choices.map(choice => request('PUT', accountUrl(), f.admin, choice)));
    expect(replies.map(r => r.statusCode).sort()).toEqual([200, 409]);
    const winner = replies.findIndex(r => r.statusCode === 200), first = replies[winner]!;
    const replay = await request('PUT', accountUrl(), f.admin, choices[winner]); expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().version).toBe(1);
    const stale = await request('POST', `${accountUrl()}/preview`, f.admin, choices[1 - winner]); expect(stale.statusCode).toBe(409);
    const audits = await ctx.db.select().from(s.auditLog).where(and(eq(s.auditLog.entityId, f.subject.accountId), eq(s.auditLog.action, 'inbox.account_access.update')));
    expect(audits).toHaveLength(1); expect(first.json().version).toBe(1);
  });
  it('HIGH: policy resend rechecks actor permission before any replay answer', async () => {
    const key = newId(), body = { expectedVersion: 0, categories: [], channelAccountIds: null };
    const first = await request('PUT', accountUrl(), f.admin, body, key); expect(first.statusCode, first.body).toBe(200);
    await ctx.db.delete(s.rolePermission).where(and(eq(s.rolePermission.roleId, f.admin.roleId), eq(s.rolePermission.permission, 'admin:role:assign')));
    const denied = await request('PUT', accountUrl(), f.admin, body, key); expect(denied.statusCode).toBe(403); expect(denied.body).not.toBe(first.body);
    expect((await request('GET', accountUrl(), f.admin)).json().version).toBe(1);
  });
});
