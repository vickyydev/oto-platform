import { hash } from '@node-rs/argon2';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '@oto/db';
import { schema as s } from '@oto/db';
import { DEMO_STAFF, DEMO_STAFF_PASSWORD, seedInboxDemo } from '@oto/db/seed';
import {
  INBOX_CATEGORY_KEYS,
  INBOX_CHANNEL_KEYS,
  INBOX_DAY_TIMEZONE,
  INBOX_STATUS_KEYS,
  INBOX_TEAM_KINDS,
  inTab,
  isUnanswered,
  isoDateInTz,
  isVisibleTo,
  newId,
  type InboxConversationDetail,
  type InboxConversationList,
  type InboxDashboard,
  type InboxMe,
  type InboxTab,
} from '@oto/shared';
import { mirrorNotice } from '../src/services/inbox/mirror';
import { SESSION_COOKIE, hashToken, newSessionToken } from '../src/plugins/session';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-19 I2b (SCRUM-581) — the Inbox's reads and who sees what.
 *
 * Plan docs/progress/plans/inbox-build/PLAN.md §3.2 (visibility), §3.3 (the
 * read routes), §3.6 (the sampled read audit), §6 "I2". On the full seed plus
 * the I1b demo conversations (`seedInboxDemo`), with two operators, every
 * viewer the feature doc names:
 *
 *   the GM            inbox_manager operator-wide — sees everything (a)
 *   a branch manager  inbox_manager at Chalong — that park's (b)
 *   team members      inbox_agent at a team's department (c)
 *   the coordinator   manual-only: a reader in no team, sees only what she is
 *                     put on (d)
 *   a counter account with no inbox role — refused
 *   the other operator's administrator — sees none of OTO's
 *
 * The tab and unanswered rules are `@oto/shared`'s, and the list states them
 * again as SQL; each check below computes the expectation with the shared
 * rule over the database's own rows and requires the api to agree.
 *
 * THE OWNER-NOTE, pinned on purpose. The prototype's code — ported as is —
 * differs from the IT Brief in two places: My Inbox is hidden for the owner
 * and reception (`tabsForRole`), and Team includes the viewer's own
 * conversations (`inTab`). The cases marked "owner-note" hold the CODE's
 * behaviour; the difference is with the owner on SCRUM-220
 * (plan "Open matters" 3), not a bug to fix here.
 */

let ctx: TestContext;
let oto: string;
let second: string;
let central: string;
let chalong: string;

const cookies: Record<string, string> = {};
/** demo key ('demo-01') → conversation id. */
const conv: Record<string, string> = {};
let secondConversationId: string;
let coordinatorId: string;

const PASSWORD = 'inboxread1234';

async function get<T>(who: string, url: string): Promise<{ status: number; body: T }> {
  const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie: cookies[who]! } });
  return { status: res.statusCode, body: res.json() as T };
}

async function post<T>(who: string, url: string, payload: unknown = {}): Promise<{ status: number; body: T }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url,
    headers: { cookie: cookies[who]!, 'idempotency-key': newId() },
    payload: payload as never,
  });
  return { status: res.statusCode, body: res.json() as T };
}

/** An active, verified staff account with one role grant. */
async function staff(
  operatorId: string,
  phone: string,
  name: string,
  roleName: string,
  scope: { scopeType: 'operator' | 'branch' | 'department'; scopeId: string },
): Promise<string> {
  const employeeId = newId();
  await ctx.db.insert(s.employee).values({ id: employeeId, operatorId, name, phone });
  const accountId = newId();
  await ctx.db.insert(s.account).values({
    id: accountId,
    operatorId,
    employeeId,
    phone,
    passwordHash: await hash(PASSWORD),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  const [role] = await ctx.db
    .select({ id: s.role.id })
    .from(s.role)
    .where(and(eq(s.role.operatorId, operatorId), eq(s.role.name, roleName)))
    .limit(1);
  await ctx.db.insert(s.roleAssignment).values({ id: newId(), accountId, roleId: role!.id, ...scope });
  return accountId;
}

async function teamOf(operatorId: string, key: 'birthdays' | 'reception' | 'marketing', branchId: string | null = null) {
  const [t] = await ctx.db
    .select()
    .from(s.team)
    .where(
      and(
        eq(s.team.operatorId, operatorId),
        eq(s.team.key, key),
        branchId === null ? isNull(s.team.branchId) : eq(s.team.branchId, branchId),
      ),
    )
    .limit(1);
  return t!;
}

beforeAll(async () => {
  ctx = await createTestContext();
  oto = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  second = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);

  await seedInboxDemo(ctx.db, { env: {} });
  const threads = await ctx.db
    .select({ id: s.conversation.id, ext: s.message.externalMessageId })
    .from(s.conversation)
    .innerJoin(s.message, eq(s.message.conversationId, s.conversation.id))
    .where(eq(s.conversation.operatorId, oto));
  for (const t of threads) {
    const key = t.ext?.split(':')[0];
    if (key?.startsWith('demo-')) conv[key] = t.id;
  }
  expect(Object.keys(conv)).toHaveLength(10);

  // Reception · Central: a desk member, by the department grant.
  const receptionCentral = await teamOf(oto, 'reception', central);
  await staff(oto, '+66810000981', 'Read Test Reception Central', 'inbox_agent', {
    scopeType: 'department',
    scopeId: receptionCentral.departmentId!,
  });
  // A branch manager at Chalong.
  await staff(oto, '+66810000982', 'Read Test Chalong Manager', 'inbox_manager', {
    scopeType: 'branch',
    scopeId: chalong,
  });
  // The coordinator: manual-only — reads the Inbox through a department that
  // is no team's, and is put on one conversation by hand.
  const entertainment = newId();
  await ctx.db.insert(s.department).values({ id: entertainment, operatorId: oto, branchId: null, name: 'entertainment' });
  coordinatorId = await staff(oto, '+66810000983', 'Read Test Coordinator', 'inbox_agent', {
    scopeType: 'department',
    scopeId: entertainment,
  });
  await ctx.db.insert(s.assignment).values({
    id: newId(),
    operatorId: oto,
    conversationId: conv['demo-01']!,
    slot: 'support',
    slotIndex: 2,
    assigneeKind: 'account',
    accountId: coordinatorId,
    assignedByKind: 'system',
    reason: 'manual',
  });

  // One conversation at the other operator, on its console account.
  const [secondConsole] = await ctx.db
    .select({ id: s.channelAccount.id })
    .from(s.channelAccount)
    .where(and(eq(s.channelAccount.operatorId, second), eq(s.channelAccount.provider, 'console')))
    .limit(1);
  const secondContact = newId();
  await ctx.db.insert(s.contact).values({
    id: secondContact,
    operatorId: second,
    channel: 'whatsapp',
    externalHandle: '+66810000990',
    displayName: 'Other Operator Guest',
    phone: '+66810000990',
  });
  secondConversationId = newId();
  const at = new Date();
  await ctx.db.insert(s.conversation).values({
    id: secondConversationId,
    operatorId: second,
    contactId: secondContact,
    channelAccountId: secondConsole!.id,
    category: 'general',
    status: 'active',
    lastCustomerMessageAt: at,
    lastMessageAt: at,
    lastMessagePreview: 'Hello from the other operator',
  });
  await ctx.db.insert(s.message).values({
    id: newId(),
    operatorId: second,
    conversationId: secondConversationId,
    channelAccountId: secondConsole!.id,
    direction: 'inbound',
    authorKind: 'customer',
    body: 'Hello from the other operator',
  });

  const sign = async (who: string, phone: string, password: string) => {
    cookies[who] = await signInAs(ctx.app, phone, password);
  };
  /**
   * A session minted straight into the table, for the people sign-in cannot
   * seat today. A DEPARTMENT-scoped grant reaches no branch at all
   * (`reachOf`, `services/access-control.ts`, reads operator and branch
   * grants only), so `seatBranch` answers NO_BRANCH_ACCESS and every
   * `inbox_agent` — each team member, reception included, and the
   * coordinator — cannot sign in at all. That is a concern raised on SCRUM-581 for the auth lane,
   * not something the reads can fix; it does not change what they may read,
   * which is what this file tests.
   */
  const session = async (who: string, phone: string) => {
    const token = newSessionToken();
    await ctx.db.insert(s.session).values({
      id: newId(),
      accountId: await accountIdOf(phone),
      tokenHash: hashToken(token),
      branchId: null,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    cookies[who] = `${SESSION_COOKIE}=${token}`;
  };
  await sign('gm', DEMO_STAFF.gm.phone, DEMO_STAFF_PASSWORD);
  await session('bdayTh', DEMO_STAFF.bday_th.phone);
  await session('bdayEnru', DEMO_STAFF.bday_enru.phone);
  await session('marketing', DEMO_STAFF.marketing.phone);
  await session('receptionCentral', '+66810000981');
  await sign('chalongManager', '+66810000982', PASSWORD);
  await session('coordinator', '+66810000983');
  await sign('admin', ADMIN.phone, ADMIN.password);
  await sign('counter', RECEPTION.phone, RECEPTION.password);
  await sign('secondAdmin', SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

const keysOf = (ids: string[]) =>
  ids
    .map((id) => Object.entries(conv).find(([, v]) => v === id)?.[0] ?? (id === secondConversationId ? 'second' : id))
    .sort();

async function listAll(who: string, query = ''): Promise<InboxConversationList> {
  const res = await get<InboxConversationList>(who, `/inbox/conversations${query ? `?${query}` : ''}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** The database's own rows, with what the shared rules read. */
async function factsOf() {
  const rows = await ctx.db.select().from(s.conversation).where(eq(s.conversation.operatorId, oto));
  const teams = await ctx.db.select().from(s.team).where(eq(s.team.operatorId, oto));
  const slots = await ctx.db
    .select()
    .from(s.assignment)
    .where(and(eq(s.assignment.operatorId, oto), isNull(s.assignment.releasedAt)));
  return rows.map((r) => ({
    ...r,
    teamDepartmentId: teams.find((t) => t.id === r.teamId)?.departmentId ?? null,
    assignedAccountIds: slots.filter((a) => a.conversationId === r.id && a.accountId).map((a) => a.accountId!),
  }));
}

const accountIdOf = async (phone: string) =>
  (await ctx.db.select({ id: s.account.id }).from(s.account).where(eq(s.account.phone, phone)).limit(1))[0]!.id;

describe('sign-in, as it stands', () => {
  it('cannot seat an inbox_agent, whose grant is department-scoped (the concern raised on SCRUM-581)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { phone: DEMO_STAFF.bday_th.phone, password: DEMO_STAFF_PASSWORD },
    });
    // Pinned so the day the auth lane seats them, this fails and the minted
    // sessions above can go.
    expect(res.json().error.code).toBe('NO_BRANCH_ACCESS');
  });
});

describe('the shared vocabulary is the schema’s', () => {
  it('categories, statuses, team kinds and channels match @oto/db', () => {
    expect([...INBOX_CATEGORY_KEYS]).toEqual([...db.INBOX_CATEGORIES]);
    expect([...INBOX_STATUS_KEYS]).toEqual([...db.CONVERSATION_STATUSES]);
    expect([...INBOX_TEAM_KINDS]).toEqual([...db.INBOX_TEAM_KEYS]);
    expect([...INBOX_CHANNEL_KEYS]).toEqual([...db.INBOX_CHANNELS]);
  });
});

describe('who sees which conversation (plan §3.2)', () => {
  const ALL = ['demo-01', 'demo-02', 'demo-03', 'demo-04', 'demo-05', 'demo-06', 'demo-07', 'demo-08', 'demo-09', 'demo-10'];

  it.each([
    // (a) operator-wide: the GM and the administrator see everything of OTO, nothing of the other operator.
    ['gm', ALL],
    ['admin', ALL],
    // (c) a team member sees the team's.
    ['bdayTh', ['demo-01', 'demo-02', 'demo-03', 'demo-04']],
    ['marketing', ['demo-09', 'demo-10']],
    ['receptionCentral', ['demo-05', 'demo-07', 'demo-08']],
    // (b) a branch grant sees that park's — and not the operator-wide birthdays.
    ['chalongManager', ['demo-04', 'demo-06']],
    // (d) the manual-only person sees only the conversation she is on.
    ['coordinator', ['demo-01']],
    // The other operator's administrator sees only its own.
    ['secondAdmin', ['second']],
  ])('%s sees %j', async (who, expected) => {
    const list = await listAll(who, 'limit=100');
    expect(keysOf(list.conversations.map((c) => c.id))).toEqual([...expected].sort());
  });

  it('agrees with the shared isVisibleTo over every row, for every viewer', async () => {
    const facts = await factsOf();
    const viewers: Array<[string, string, Parameters<typeof isVisibleTo>[1]]> = [];
    const bdayDept = (await teamOf(oto, 'birthdays')).departmentId!;
    const recDept = (await teamOf(oto, 'reception', central)).departmentId!;
    viewers.push(['bdayTh', DEMO_STAFF.bday_th.phone, { accountId: '', operatorWide: false, branchIds: [], departmentIds: [bdayDept] }]);
    viewers.push(['receptionCentral', '+66810000981', { accountId: '', operatorWide: false, branchIds: [], departmentIds: [recDept] }]);
    viewers.push(['chalongManager', '+66810000982', { accountId: '', operatorWide: false, branchIds: [chalong], departmentIds: [] }]);
    viewers.push(['coordinator', '+66810000983', { accountId: '', operatorWide: false, branchIds: [], departmentIds: [] }]);
    viewers.push(['gm', DEMO_STAFF.gm.phone, { accountId: '', operatorWide: true, branchIds: [], departmentIds: [] }]);
    for (const [who, phone, scope] of viewers) {
      const viewer = { ...scope, accountId: await accountIdOf(phone) };
      const expected = facts.filter((f) => isVisibleTo(f, viewer)).map((f) => f.id).sort();
      const list = await listAll(who, 'limit=100');
      expect(list.conversations.map((c) => c.id).sort(), who).toEqual(expected);
    }
  });

  it('a conversation the caller cannot see is a 404 on every by-id read — never a 403', async () => {
    const hidden = conv['demo-05']!; // Reception · Central's, handled.
    for (const url of [`/inbox/conversations/${hidden}`, `/inbox/conversations/${hidden}/messages`]) {
      expect((await get('bdayTh', url)).status, url).toBe(404);
      expect((await get('coordinator', url)).status, url).toBe(404);
      expect((await get('secondAdmin', url)).status, url).toBe(404);
    }
    expect((await post('bdayTh', `/inbox/conversations/${hidden}/read`)).status).toBe(404);
    // The other operator's id, from inside OTO.
    expect((await get('gm', `/inbox/conversations/${secondConversationId}`)).status).toBe(404);
    // A conversation that does not exist reads the same.
    expect((await get('gm', `/inbox/conversations/${newId()}`)).status).toBe(404);
  });

  it('the manual-only person reads the thread she is on', async () => {
    const res = await get<InboxConversationDetail>('coordinator', `/inbox/conversations/${conv['demo-01']}`);
    expect(res.status).toBe(200);
    expect(res.body.assignments.map((a) => a.slotIndex)).toEqual([0, 1, 2]);
    expect(res.body.assignments.find((a) => a.slotIndex === 2)?.accountId).toBe(coordinatorId);
  });

  it('refuses a caller who holds no inbox permission, on every read', async () => {
    for (const url of ['/inbox/me', '/inbox/conversations', '/inbox/dashboard', '/inbox/templates', `/inbox/conversations/${conv['demo-01']}`]) {
      const res = await get<{ error: { code: string } }>('counter', url);
      expect(res.status, url).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('refuses an anonymous caller', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/inbox/conversations' });
    expect(res.statusCode).toBe(401);
  });
});

describe('the tabs (ported code, the owner-note pinned on purpose)', () => {
  it.each([
    // Owner-note: the owner's view has no My Inbox (the code, not the Brief).
    ['gm', ['owner'], ['team', 'handled']],
    // Owner-note: reception has no My Inbox either.
    ['receptionCentral', ['reception'], ['team', 'handled']],
    ['bdayTh', ['events'], ['mine', 'team', 'handled']],
    ['marketing', ['marketing'], ['mine', 'team', 'handled']],
    // A reader in no team: the default arm of tabsForRole.
    ['coordinator', ['staff'], ['mine', 'team', 'handled']],
    ['chalongManager', ['staff'], ['mine', 'team', 'handled']],
  ])('%s is %j with tabs %j', async (who, roles, tabs) => {
    const me = await get<InboxMe>(who, '/inbox/me');
    expect(me.status).toBe(200);
    expect(me.body.roles).toEqual(roles);
    expect(me.body.tabs).toEqual(tabs);
  });

  it("each tab holds exactly what the shared inTab says, and tabCounts count it before filters", async () => {
    const facts = await factsOf();
    for (const [who, phone] of [
      ['bdayTh', DEMO_STAFF.bday_th.phone],
      ['bdayEnru', DEMO_STAFF.bday_enru.phone],
      ['marketing', DEMO_STAFF.marketing.phone],
      ['gm', DEMO_STAFF.gm.phone],
      ['coordinator', '+66810000983'],
    ] as const) {
      const me = (await get<InboxMe>(who, '/inbox/me')).body;
      const accountId = await accountIdOf(phone);
      const visible = (await listAll(who, 'limit=100')).conversations.map((c) => c.id);
      const counts = (await listAll(who, 'q=zzzz-nothing')).tabCounts;
      for (const tab of ['mine', 'team', 'handled'] as InboxTab[]) {
        const expected = facts
          .filter((f) => visible.includes(f.id))
          .filter((f) => inTab({ status: f.status, assignedToViewer: f.assignedAccountIds.includes(accountId) }, tab))
          .map((f) => f.id)
          .sort();
        const got = (await listAll(who, `tab=${tab}&limit=100`)).conversations.map((c) => c.id).sort();
        expect(got, `${who} ${tab}`).toEqual(expected);
        if (me.tabs.includes(tab)) expect(counts[tab], `${who} count ${tab}`).toBe(expected.length);
        else expect(counts[tab], `${who} has no ${tab}`).toBeUndefined();
      }
    }
  });

  it('owner-note: Team Inbox includes the viewer’s own conversations (the code, not the Brief)', async () => {
    const team = await listAll('bdayTh', 'tab=team&limit=100');
    const mine = await listAll('bdayTh', 'tab=mine&limit=100');
    expect(keysOf(mine.conversations.map((c) => c.id))).toEqual(['demo-03']);
    // demo-03 is hers, and it is in Team as well.
    expect(keysOf(team.conversations.map((c) => c.id))).toEqual(['demo-01', 'demo-02', 'demo-03']);
    expect(team.conversations.find((c) => c.id === conv['demo-03'])?.mine).toBe(true);
  });

  it('the handled archive, and "resolved by" on it only', async () => {
    const handled = await listAll('gm', 'tab=handled&limit=100');
    expect(keysOf(handled.conversations.map((c) => c.id))).toEqual(['demo-04', 'demo-05', 'demo-08']);
    expect((await listAll('gm', 'tab=handled&resolvedBy=human')).conversations).toHaveLength(3);
    expect((await listAll('gm', 'tab=handled&resolvedBy=ai')).conversations).toHaveLength(0);
    // On another tab the prototype ignores it (:1071).
    expect((await listAll('gm', 'tab=team&resolvedBy=ai&limit=100')).conversations).toHaveLength(7);
    const from = new Date(Date.now() - 10 * 60_000).toISOString();
    const recent = await listAll('gm', `tab=handled&handledFrom=${encodeURIComponent(from)}`);
    // demo-05 was handled ~585 minutes ago, demo-04 and demo-08 a day ago: none in the last ten minutes.
    expect(recent.conversations).toHaveLength(0);
    const wide = await listAll('gm', `tab=handled&handledFrom=${encodeURIComponent(new Date(Date.now() - 2 * 86_400_000).toISOString())}`);
    expect(wide.conversations).toHaveLength(3);
  });
});

describe('the filters', () => {
  it('unanswered: five of the demo threads wait on staff, as the shared rule says', async () => {
    const facts = await factsOf();
    const expected = facts.filter((f) => isUnanswered(f)).map((f) => f.id).sort();
    expect(keysOf(expected)).toEqual(['demo-01', 'demo-03', 'demo-06', 'demo-07', 'demo-09']);
    const list = await listAll('gm', 'unanswered=true&limit=100');
    expect(list.conversations.map((c) => c.id).sort()).toEqual(expected);
    // Each row says it too, by the same rule.
    const all = await listAll('gm', 'limit=100');
    for (const c of all.conversations) expect(c.unanswered, c.id).toBe(expected.includes(c.id));
    // AI lines are not an answer: demo-09 has one and is still waiting.
    expect(all.conversations.find((c) => c.id === conv['demo-09'])?.unanswered).toBe(true);
  });

  it('category, status, language', async () => {
    expect(keysOf((await listAll('gm', 'category=marketing')).conversations.map((c) => c.id))).toEqual(['demo-09', 'demo-10']);
    expect((await listAll('gm', 'status=handled&limit=100')).conversations).toHaveLength(3);
    expect(keysOf((await listAll('gm', 'language=th&limit=100')).conversations.map((c) => c.id))).toEqual([
      'demo-03',
      'demo-04',
      'demo-06',
    ]);
    // Status and tab both apply, as the prototype's filters stack (:1064, :1067).
    expect((await listAll('gm', 'tab=team&status=handled')).conversations).toHaveLength(0);
  });

  it('branch: that park’s and the operator-wide ones (the prototype’s "all")', async () => {
    const list = await listAll('gm', `branchId=${chalong}&limit=100`);
    // Chalong's own (04, 06) and those with no branch (01, 03, 09, 10).
    expect(keysOf(list.conversations.map((c) => c.id))).toEqual(['demo-01', 'demo-03', 'demo-04', 'demo-06', 'demo-09', 'demo-10']);
  });

  it('search: customer, intent and last message; wildcards are literal', async () => {
    expect(keysOf((await listAll('gm', 'q=SOCKS')).conversations.map((c) => c.id))).toEqual(['demo-07']);
    expect(keysOf((await listAll('gm', 'q=lost%20items')).conversations.map((c) => c.id))).toEqual(['demo-06']);
    expect(keysOf((await listAll('gm', 'q=sarah')).conversations.map((c) => c.id))).toEqual(['demo-01']);
    expect((await listAll('gm', 'q=%25')).conversations).toHaveLength(0);
    // Search stays inside visibility.
    expect((await listAll('bdayTh', 'q=SOCKS')).conversations).toHaveLength(0);
  });

  it('pages by cursor, newest activity first, without repeating or dropping a row', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: InboxConversationList = await listAll('gm', `limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.conversations.map((c) => c.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(10);
    const whole = (await listAll('gm', 'limit=100')).conversations;
    expect(seen).toEqual(whole.map((c) => c.id));
    const times = whole.map((c) => Date.parse(c.lastMessageAt ?? c.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect((await get('gm', '/inbox/conversations?cursor=not-a-cursor')).status).toBe(400);
  });
});

describe('one conversation', () => {
  it('the header, the assignment strip, and the timeline without a body', async () => {
    const res = await get<InboxConversationDetail>('gm', `/inbox/conversations/${conv['demo-09']}`);
    expect(res.status).toBe(200);
    const d = res.body;
    expect(d.category).toBe('marketing');
    expect(d.teamName).toBe('Marketing');
    expect(d.contact.displayName).toBe('Jess Demo');
    expect(d.canReply).toBe(true);
    expect(d.assignments.map((a) => [a.slot, a.name])).toEqual([
      ['primary', DEMO_STAFF.marketing.name],
      ['support', DEMO_STAFF.gm.name],
    ]);
    expect(d.events.map((e) => e.kind)).toEqual(['routed', 'assigned', 'assigned']);
    const pills = JSON.stringify(d.events);
    expect(pills).not.toContain('family travel videos');
    expect(d.member).toBeNull();
  });

  it('a reception desk primary is named by its team', async () => {
    const d = (await get<InboxConversationDetail>('receptionCentral', `/inbox/conversations/${conv['demo-07']}`)).body;
    expect(d.assignments[0]).toMatchObject({ slot: 'primary', assigneeKind: 'team', name: 'Reception · Central Floresta' });
  });

  it('messages page oldest-first, with an older cursor', async () => {
    const first = await get<{ messages: Array<{ id: string; body: string | null; authorName: string | null }>; olderCursor: string | null }>(
      'gm',
      `/inbox/conversations/${conv['demo-02']}/messages?limit=2`,
    );
    expect(first.status).toBe(200);
    expect(first.body.messages).toHaveLength(2);
    expect(first.body.messages.map((m) => m.authorName)).toEqual([null, DEMO_STAFF.bday_enru_backup.name]);
    expect(first.body.olderCursor).toBe(first.body.messages[0]!.id);
    const older = await get<{ messages: Array<{ id: string }>; olderCursor: string | null }>(
      'gm',
      `/inbox/conversations/${conv['demo-02']}/messages?limit=2&before=${first.body.olderCursor}`,
    );
    expect(older.body.messages).toHaveLength(2);
    expect(older.body.olderCursor).toBeNull();
    // A message of another conversation is not a cursor here.
    const foreign = (await ctx.db.select({ id: s.message.id }).from(s.message).where(eq(s.message.conversationId, conv['demo-01']!)).limit(1))[0]!.id;
    expect((await get('gm', `/inbox/conversations/${conv['demo-02']}/messages?before=${foreign}`)).status).toBe(400);
  });
});

describe('reading, and the sampled read audit (plan §3.6)', () => {
  it('advances the marker, clears unread, and audits once per account, conversation and day', async () => {
    const id = conv['demo-03']!;
    const before = (await listAll('bdayTh', 'limit=100')).conversations.find((c) => c.id === id)!;
    expect(before.unread).toBe(1);

    const first = await post<{ audited: boolean; lastReadMessageId: string | null }>('bdayTh', `/inbox/conversations/${id}/read`);
    expect(first.status).toBe(200);
    expect(first.body.audited).toBe(true);
    expect(first.body.lastReadMessageId).not.toBeNull();
    const second = await post<{ audited: boolean }>('bdayTh', `/inbox/conversations/${id}/read`);
    expect(second.body.audited).toBe(false);

    const after = (await listAll('bdayTh', 'limit=100')).conversations.find((c) => c.id === id)!;
    expect(after.unread).toBe(0);

    const rows = await ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.conversation.read'), eq(s.auditLog.entityId, id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operatorId).toBe(oto);
    expect(rows[0]!.after).toMatchObject({ category: 'birthdays' });
    // The access is recorded, never the words.
    expect(JSON.stringify(rows[0])).not.toContain('สวัสดีค่ะ');

    // Another person reading the same thread is their own row.
    const gm = await post<{ audited: boolean }>('gm', `/inbox/conversations/${id}/read`);
    expect(gm.body.audited).toBe(true);
  });

  it('the marker only moves forward, and a message of another thread is refused', async () => {
    const id = conv['demo-02']!;
    const msgs = await ctx.db.select().from(s.message).where(eq(s.message.conversationId, id)).orderBy(s.message.createdAt);
    const newest = await post<{ lastReadMessageId: string }>('bdayEnru', `/inbox/conversations/${id}/read`, { messageId: msgs.at(-1)!.id });
    expect(newest.body.lastReadMessageId).toBe(msgs.at(-1)!.id);
    const back = await post<{ lastReadMessageId: string }>('bdayEnru', `/inbox/conversations/${id}/read`, { messageId: msgs[0]!.id });
    expect(back.body.lastReadMessageId).toBe(msgs.at(-1)!.id);
    const foreign = (await ctx.db.select({ id: s.message.id }).from(s.message).where(eq(s.message.conversationId, conv['demo-01']!)).limit(1))[0]!.id;
    expect((await post('bdayEnru', `/inbox/conversations/${id}/read`, { messageId: foreign })).status).toBe(400);
  });
});

describe('the dashboard', () => {
  it('counts within what the viewer sees, by the shared rules and the Bangkok day', async () => {
    const facts = await factsOf();
    const day = isoDateInTz(new Date(), INBOX_DAY_TIMEZONE);
    const dayStart = new Date(`${day}T00:00:00+07:00`).getTime();
    const check = async (who: string, ids: string[]) => {
      const mine = facts.filter((f) => ids.includes(f.id));
      const answered = mine.filter((f) => f.firstResponseAt);
      const res = await get<InboxDashboard>(who, '/inbox/dashboard');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        newToday: mine.filter((f) => f.createdAt.getTime() >= dayStart).length,
        unanswered: mine.filter((f) => isUnanswered(f)).length,
        handledToday: mine.filter((f) => f.status === 'handled' && f.handledAt!.getTime() >= dayStart).length,
        active: mine.filter((f) => f.status === 'active').length,
        averageFirstResponseSeconds:
          answered.length === 0
            ? null
            : Math.round(
                answered.reduce((sum, f) => sum + (f.firstResponseAt!.getTime() - f.createdAt.getTime()) / 1000, 0) /
                  answered.length,
              ),
        byCategory: {
          birthdays: mine.filter((f) => f.category === 'birthdays').length,
          general: mine.filter((f) => f.category === 'general').length,
          marketing: mine.filter((f) => f.category === 'marketing').length,
        },
        day,
      });
    };
    await check('gm', Object.values(conv));
    await check('bdayTh', ['demo-01', 'demo-02', 'demo-03', 'demo-04'].map((k) => conv[k]!));
    await check('coordinator', [conv['demo-01']!]);
    const all = (await get<InboxDashboard>('gm', '/inbox/dashboard')).body;
    expect(all.byCategory).toEqual({ birthdays: 4, general: 4, marketing: 2 });
    expect(all.unanswered).toBe(5);
  });
});

describe('the viewer and the templates', () => {
  it('/inbox/me: teams, the people who can hold a slot, and the write switch off', async () => {
    const me = (await get<InboxMe>('bdayTh', '/inbox/me')).body;
    expect(me.name).toBe(DEMO_STAFF.bday_th.name);
    expect(me.teams.map((t) => [t.kind, t.member])).toEqual([
      ['birthdays', true],
      ['reception', false],
      ['reception', false],
      ['marketing', false],
    ]);
    expect(me.capabilities).toEqual({ writes: false, dashboard: true, assign: false, move: false, reopen: false });
    expect(me.defaultReceptionBranchId).toBe(central);
    const people = new Map(me.people.map((p) => [p.name, p]));
    expect(people.get(DEMO_STAFF.gm.name)).toMatchObject({ operatorWide: true, teamIds: [] });
    expect(people.get('Read Test Coordinator')).toMatchObject({ operatorWide: false, teamIds: [] });
    expect(people.get(DEMO_STAFF.bday_th.name)?.teamIds).toEqual([me.teams[0]!.id]);
    // Nobody of the other operator.
    expect(me.people.some((p) => p.name === 'Other Operator Guest')).toBe(false);
    const gm = (await get<InboxMe>('gm', '/inbox/me')).body;
    expect(gm.capabilities).toMatchObject({ assign: true, move: true, reopen: true });
  });

  it('templates: the active rows, optionally one language', async () => {
    const all = await get<{ templates: Array<{ key: string; language: string; needsTranslation: boolean }> }>('bdayTh', '/inbox/templates');
    expect(all.status).toBe(200);
    expect(all.body.templates).toHaveLength(24);
    const th = await get<{ templates: Array<{ language: string; needsTranslation: boolean }> }>('bdayTh', '/inbox/templates?language=th');
    expect(th.body.templates).toHaveLength(8);
    expect(th.body.templates.every((t) => t.language === 'th' && t.needsTranslation)).toBe(true);
    // An archived template is gone from the composer.
    const [one] = await ctx.db
      .select({ id: s.template.id })
      .from(s.template)
      .where(and(eq(s.template.operatorId, oto), eq(s.template.key, 'welcome'), eq(s.template.language, 'ru')));
    await ctx.db.update(s.template).set({ archivedAt: new Date() }).where(inArray(s.template.id, [one!.id]));
    expect((await get<{ templates: unknown[] }>('bdayTh', '/inbox/templates')).body.templates).toHaveLength(23);
  });
});

describe('a mirrored check-in notice (I2c) reads like any thread', () => {
  it('is the reception team’s and its park’s, read-only, never unanswered, and its read is audited', async () => {
    const out = await ctx.db.transaction((tx) =>
      mirrorNotice(tx, {
        operatorId: oto,
        branchId: central,
        channel: 'whatsapp',
        phone: '+66810000995',
        displayName: 'Notice Guest',
        body: 'Your check-in is confirmed (read test)',
        source: 'checkin.contact',
        sourceId: newId(),
        sentAt: new Date(),
        sender: { send: () => Promise.resolve() },
      }),
    );
    expect(out.mirrored).toBe(true);
    const id = (out as { conversationId: string }).conversationId;

    // Reception · Central (its team) and the GM see it; the birthday team and
    // Chalong's manager do not.
    const row = (await listAll('receptionCentral', 'limit=100')).conversations.find((c) => c.id === id);
    expect(row).toMatchObject({ category: 'general', canReply: false, unanswered: false, status: 'active' });
    expect((await listAll('gm', 'limit=100')).conversations.some((c) => c.id === id)).toBe(true);
    expect((await listAll('bdayTh', 'limit=100')).conversations.some((c) => c.id === id)).toBe(false);
    expect((await listAll('chalongManager', 'limit=100')).conversations.some((c) => c.id === id)).toBe(false);
    expect((await get('bdayTh', `/inbox/conversations/${id}`)).status).toBe(404);

    const msgs = await get<{ messages: Array<{ authorKind: string; source: string; direction: string }> }>(
      'receptionCentral',
      `/inbox/conversations/${id}/messages`,
    );
    expect(msgs.body.messages).toEqual([expect.objectContaining({ authorKind: 'system', source: 'checkin.contact', direction: 'outbound' })]);

    const read = await post<{ audited: boolean }>('receptionCentral', `/inbox/conversations/${id}/read`);
    expect(read.body.audited).toBe(true);
    const rows = await ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.conversation.read'), eq(s.auditLog.entityId, id)));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain('read test');
  });
});
