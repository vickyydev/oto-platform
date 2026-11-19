import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import { PERMISSIONS, newId, type InboxAccessSelection, type InboxConversationList, type InboxDashboard, type Permission } from '@oto/shared';
import { hashToken, newSessionToken, SESSION_COOKIE } from '../src/plugins/session';
import { createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-1016 — the redesigned list's three server filters (plan
 * docs/progress/plans/inbox-redesign/PROPOSAL.md §5): "Hide till notices"
 * (`replyable=true`, applied in the database so the paging and every count
 * leave the notices out), the Unread quick filter (`unread=true`, the row's
 * own unread rule, per caller) and the desktop views column's counts per
 * topic (`topicCounts`). Each is pinned allowed, refused and inside the
 * SCRUM-993 limits. ZZ TEST fixtures on a fresh operator; nothing real.
 */

let ctx: TestContext;
let f: Awaited<ReturnType<typeof fixture>>;
const inboxPermissions = PERMISSIONS.filter((p) => p.startsWith('inbox:') || p === 'app:inbox:access');

beforeAll(async () => {
  ctx = await createTestContext();
}, 180_000);
beforeEach(async () => {
  f = await fixture();
});
afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

type Actor = { accountId: string; cookie: string };

async function person(operatorId: string, permissions: readonly Permission[]): Promise<Actor> {
  const accountId = newId(), roleId = newId(), employeeId = newId();
  await ctx.db.insert(s.employee).values({ id: employeeId, operatorId, name: 'ZZ TEST list staff' });
  await ctx.db.insert(s.account).values({
    id: accountId, operatorId, employeeId, phone: `+66${randomBytes(6).readUIntBE(0, 6)}`, status: 'active', phoneVerifiedAt: new Date(),
  });
  await ctx.db.insert(s.role).values({ id: roleId, operatorId, name: `ZZ TEST ${roleId}` });
  if (permissions.length) await ctx.db.insert(s.rolePermission).values(permissions.map((permission) => ({ id: newId(), roleId, permission })));
  await ctx.db.insert(s.roleAssignment).values({ id: newId(), roleId, accountId, scopeType: 'operator', scopeId: operatorId });
  const token = newSessionToken();
  await ctx.db.insert(s.session).values({ id: newId(), accountId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000) });
  return { accountId, cookie: `${SESSION_COOKIE}=${token}` };
}

/**
 * One park, a birthdays team, a number that takes replies and the till's
 * notice sender (a console number, which cannot). Five threads, newest first:
 *   general     a customer question, unread for everyone
 *   birthday    the team's, a customer line
 *   notice      the till's check-in notice thread: no reply possible, routed,
 *               on no team (so held in General too)
 *   held        a general question held in General (SCRUM-789), a customer line
 *   marketing   an older customer line
 */
async function fixture() {
  const operatorId = newId(), branchId = newId(), departmentId = newId(), teamId = newId();
  await ctx.db.insert(s.operator).values({ id: operatorId, name: `ZZ TEST list operator ${operatorId}` });
  await ctx.db.insert(s.branch).values({ id: branchId, operatorId, code: `ZZ${randomBytes(2).toString('hex')}`, name: 'ZZ TEST park' });
  await ctx.db.insert(s.department).values({ id: departmentId, operatorId, name: 'ZZ TEST birthday team' });
  await ctx.db.insert(s.team).values({ id: teamId, operatorId, key: 'birthdays', departmentId, name: 'ZZ TEST birthdays', colour: '#000000' });
  const admin = await person(operatorId, PERMISSIONS);
  const subject = await person(operatorId, inboxPermissions);
  const reply = newId(), notices = newId();
  await ctx.db.insert(s.channelAccount).values([
    { id: reply, operatorId, branchId, channel: 'whatsapp', provider: 'simulator', externalId: newId(), displayName: 'ZZ TEST reply number' },
    { id: notices, operatorId, branchId, channel: 'whatsapp', provider: 'console', externalId: newId(), displayName: 'ZZ TEST check-in notices', canReply: false },
  ]);
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  const threads: Record<string, string> = {};
  const rows = [
    { key: 'general', category: 'general', channelAccountId: reply, teamId: null, at: 1, customer: true, routed: false },
    { key: 'birthday', category: 'birthdays', channelAccountId: reply, teamId, at: 2, customer: true, routed: false },
    { key: 'notice', category: 'general', channelAccountId: notices, teamId: null, at: 3, customer: false, routed: true },
    { key: 'held', category: 'general', channelAccountId: reply, teamId: null, at: 4, customer: true, routed: true },
    { key: 'marketing', category: 'marketing', channelAccountId: reply, teamId: null, at: 5, customer: true, routed: false },
  ] as const;
  for (const r of rows) {
    const id = newId(), contactId = newId(), at = minutesAgo(r.at);
    await ctx.db.insert(s.contact).values({ id: contactId, operatorId, channel: 'whatsapp', externalHandle: newId(), displayName: `ZZ TEST ${r.key}` });
    await ctx.db.insert(s.conversation).values({
      id, operatorId, channelAccountId: r.channelAccountId, contactId, branchId: r.key === 'held' ? null : branchId, category: r.category, teamId: r.teamId,
      lastCustomerMessageAt: r.customer ? at : null, lastRoutedAt: r.routed ? at : null, lastMessageAt: at, lastMessagePreview: `ZZ TEST ${r.key} line`,
    });
    if (r.customer) {
      await ctx.db.insert(s.message).values({
        id: newId(), operatorId, conversationId: id, channelAccountId: r.channelAccountId, authorKind: 'customer', direction: 'inbound',
        body: `ZZ TEST ${r.key} body`, createdAt: at,
      });
    }
    threads[r.key] = id;
  }
  return { operatorId, branchId, admin, subject, reply, notices, threads };
}

function request(method: 'GET' | 'POST' | 'PUT', url: string, who: Actor = f.subject, payload?: unknown) {
  return ctx.app.inject({
    method,
    url,
    headers: { cookie: who.cookie, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
}
async function list(query: string, who: Actor = f.subject): Promise<InboxConversationList> {
  const res = await request('GET', `/inbox/conversations?tab=team${query}`, who);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as InboxConversationList;
}
async function dashboard(query = '', who: Actor = f.subject): Promise<InboxDashboard> {
  const res = await request('GET', `/inbox/dashboard${query}`, who);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as InboxDashboard;
}
const keys = (page: InboxConversationList) =>
  page.conversations.map((c) => Object.entries(f.threads).find(([, id]) => id === c.id)?.[0] ?? c.id);
async function restrict(selection: InboxAccessSelection, target = f.subject) {
  const url = `/accounts/${target.accountId}/inbox-access`;
  const current = await request('GET', url, f.admin);
  expect(current.statusCode, current.body).toBe(200);
  const res = await request('PUT', url, f.admin, { ...selection, expectedVersion: current.json().version });
  expect(res.statusCode, res.body).toBe(200);
}

describe('SCRUM-1016: "Hide till notices" (replyable=true)', () => {
  it('without it the list is as before: the till notice thread is in the list and in every count', async () => {
    const page = await list('');
    expect(keys(page)).toEqual(['general', 'birthday', 'notice', 'held', 'marketing']);
    expect(page.conversations.find((c) => c.id === f.threads.notice)?.canReply).toBe(false);
    expect(page.tabCounts.team).toBe(5);
    // The notice thread is routed and on no team, so it is also held in General.
    expect(page.topicCounts).toEqual({ birthdays: 1, general: 3, marketing: 1, gm: 0, heldInGeneral: 2 });
    expect(await dashboard()).toMatchObject({ unanswered: 5, active: 5, newToday: 5, byCategory: { general: 3 } });
  });

  it('leaves the notice thread out of the page, the tab counts, the topic counts and every dashboard figure', async () => {
    const page = await list('&replyable=true');
    expect(keys(page)).toEqual(['general', 'birthday', 'held', 'marketing']);
    expect(page.conversations.every((c) => c.canReply)).toBe(true);
    expect(page.tabCounts.team).toBe(4);
    expect(page.topicCounts).toEqual({ birthdays: 1, general: 2, marketing: 1, gm: 0, heldInGeneral: 1 });
    const figures = await dashboard('?replyable=true');
    expect(figures).toMatchObject({ unanswered: 4, active: 4, newToday: 4, byCategory: { birthdays: 1, general: 2, marketing: 1, gm: 0 } });
  });

  it('pages in the database: one row a page walks the replyable rows only, never a short or empty page', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 6; i++) {
      const page: InboxConversationList = await list(`&replyable=true&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(page.conversations).toHaveLength(1);
      seen.push(...keys(page));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(['general', 'birthday', 'held', 'marketing']);
  });
});

describe('SCRUM-1016: the Unread quick filter (unread=true)', () => {
  it('keeps the threads with a customer line after the caller’s own read marker, by the row’s own rule', async () => {
    const page = await list('&unread=true');
    expect(keys(page)).toEqual(['general', 'birthday', 'held', 'marketing']);
    expect(page.conversations.every((c) => c.unread > 0)).toBe(true);
    const read = await request('POST', `/inbox/conversations/${f.threads.birthday}/read`, f.subject, {});
    expect(read.statusCode, read.body).toBe(200);
    expect(keys(await list('&unread=true'))).toEqual(['general', 'held', 'marketing']);
    // Per caller: the administrator has read nothing, so the birthday is still unread for them.
    expect(keys(await list('&unread=true', f.admin))).toEqual(['general', 'birthday', 'held', 'marketing']);
    // It combines with the other filters, and the tab counts stay before them.
    const both = await list('&unread=true&replyable=true&category=general');
    expect(keys(both)).toEqual(['general', 'held']);
    expect(both.tabCounts.team).toBe(4);
  });
});

describe('SCRUM-1016: the topics’ counts (topicCounts)', () => {
  it('count the tab and every filter but the topic’s own, and ride on the first page only', async () => {
    // A topic chosen: the list narrows, the counts still say what every other topic would show.
    const birthdays = await list('&category=birthdays&replyable=true');
    expect(keys(birthdays)).toEqual(['birthday']);
    expect(birthdays.topicCounts).toEqual({ birthdays: 1, general: 2, marketing: 1, gm: 0, heldInGeneral: 1 });
    // The held view (inbox=general) is the topic's own filter too.
    const held = await list('&category=general&inbox=general&replyable=true');
    expect(keys(held)).toEqual(['held']);
    expect(held.topicCounts).toMatchObject({ general: 2, heldInGeneral: 1 });
    // Another filter does narrow them: a park never holds a thread kept in General.
    const park = await list(`&branchId=${f.branchId}&replyable=true`);
    expect(park.topicCounts).toEqual({ birthdays: 1, general: 1, marketing: 1, gm: 0, heldInGeneral: 0 });
    // The search too.
    expect((await list('&q=marketing')).topicCounts).toEqual({ birthdays: 0, general: 0, marketing: 1, gm: 0, heldInGeneral: 0 });
    // A later page carries none.
    const first = await list('&limit=1');
    expect((await list(`&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).topicCounts).toBeUndefined();
  });
});

describe('SCRUM-1016: the new filters inside visibility and the SCRUM-993 limits', () => {
  it('a category and number limit fences the filtered list, both counts and the dashboard alike', async () => {
    await restrict({ categories: ['general'], channelAccountIds: [f.reply, f.notices] });
    const page = await list('&replyable=true&unread=true');
    expect(keys(page)).toEqual(['general', 'held']);
    expect(page.tabCounts.team).toBe(2);
    expect(page.topicCounts).toEqual({ birthdays: 0, general: 2, marketing: 0, gm: 0, heldInGeneral: 1 });
    expect(page.access).toMatchObject({ categories: ['general'] });
    expect(await dashboard('?replyable=true')).toMatchObject({ unanswered: 2, active: 2, byCategory: { general: 2, birthdays: 0, marketing: 0 } });
    // Without the switch the notice the limits allow is back, and nothing else.
    expect(keys(await list(''))).toEqual(['general', 'notice', 'held']);
    // An empty category list is none, whatever the filters ask.
    await restrict({ categories: [], channelAccountIds: null });
    const none = await list('&replyable=true&unread=true');
    expect(none.conversations).toEqual([]);
    expect(none.tabCounts.team).toBe(0);
    expect(none.topicCounts).toEqual({ birthdays: 0, general: 0, marketing: 0, gm: 0, heldInGeneral: 0 });
  });

  it('another operator’s caller sees none of these threads through any of the filters', async () => {
    const foreignOperatorId = newId();
    await ctx.db.insert(s.operator).values({ id: foreignOperatorId, name: `ZZ TEST foreign operator ${foreignOperatorId}` });
    const foreign = await person(foreignOperatorId, PERMISSIONS);
    const page = await list('&replyable=true&unread=true', foreign);
    expect(page.conversations).toEqual([]);
    expect(page.topicCounts).toEqual({ birthdays: 0, general: 0, marketing: 0, gm: 0, heldInGeneral: 0 });
    expect(await dashboard('?replyable=true', foreign)).toMatchObject({ unanswered: 0, active: 0 });
  });

  it('refuses a caller without the read or dashboard permission, and a value the api does not know', async () => {
    const outsider = await person(f.operatorId, ['app:inbox:access']);
    expect((await request('GET', '/inbox/conversations?tab=team&replyable=true&unread=true', outsider)).statusCode).toBe(403);
    expect((await request('GET', '/inbox/dashboard?replyable=true', outsider)).statusCode).toBe(403);
    const reader = await person(f.operatorId, ['app:inbox:access', 'inbox:conversation:read']);
    expect((await request('GET', '/inbox/conversations?tab=team&replyable=true', reader)).statusCode).toBe(200);
    expect((await request('GET', '/inbox/dashboard?replyable=true', reader)).statusCode).toBe(403);
    for (const url of ['/inbox/conversations?replyable=yes', '/inbox/conversations?unread=1', '/inbox/dashboard?replyable=on']) {
      expect((await request('GET', url)).statusCode, url).toBe(400);
    }
  });
});
