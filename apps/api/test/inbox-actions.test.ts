import { hash } from '@node-rs/argon2';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import type { SimulatedInbound } from '@oto/messaging';
import { newId, type InboxActionResult, type InboxBranchResult } from '@oto/shared';
import { HOSTING_RULE_PRIORITY, INBOX_ACTION_MESSAGES } from '../src/services/inbox/actions';
import { SESSION_COOKIE, hashToken, newSessionToken } from '../src/plugins/session';
import {
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-19 I2e (SCRUM-584) — assignment, Divert, move, branch, Handled and
 * reopen. Plan docs/progress/plans/inbox-build/PLAN.md §3.3 [B] and §6 "I2";
 * feature doc "Ownership and assignment" and "Status".
 *
 * Conversations are made the real way — a customer line played through the
 * simulator and the signed webhook, so the router has put its primary and
 * backup on each — and then acted on through the routes:
 *
 *   the GM            inbox_manager operator-wide
 *   a Chalong manager inbox_manager at the Chalong branch
 *   bdayA / bdayB     the EN birthday pair (agents in Birthdays & Events)
 *   host              a birthday agent who hosts at Chalong (the hosting rule)
 *   mkt               the marketing agent (the GM is the marketing backup)
 *   recCentral        an agent at Reception · Central
 *   coord             manual-only: reads the Inbox, in no team
 *   counter           a till account with no inbox role
 *   secondAdmin       the other operator's administrator
 */

const SECRET = 'inbox-actions-test-secret';
const SENTINEL = 'SENTINEL-actions-never-outside-the-message-table';
const PASSWORD = 'inboxactions1234';

let ctx: TestContext;
let oto: string;
let central: string;
let chalong: string;
let caCentral: string;
const cookies: Record<string, string> = {};
const people = {} as Record<
  'gm' | 'chalongMgr' | 'bdayA' | 'bdayB' | 'host' | 'mkt' | 'recCentral' | 'coord',
  string
>;
const teams = {} as Record<'birthdays' | 'marketing' | 'recCentral' | 'recChalong', { id: string; departmentId: string }>;
let phoneSeq = 0;

type Res<T> = { status: number; body: T };
type Refusal = { error: { code: string; message: string; details?: Record<string, unknown> } };

async function call<T = InboxActionResult>(
  who: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  key: string = newId(),
): Promise<Res<T>> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie: cookies[who]!, 'idempotency-key': key },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { status: res.statusCode, body: res.json() as T };
}

const at = (id: string, action: string) => `/inbox/conversations/${id}/${action}`;

/** What the conversation detail says Divert would do (I3b): read as the divert route reads it. */
async function divertToOf(who: string, id: string): Promise<{ accountId: string } | null> {
  const res = await ctx.app.inject({ method: 'GET', url: `/inbox/conversations/${id}`, headers: { cookie: cookies[who]! } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { divertTo: { accountId: string } | null }).divertTo;
}

async function teamRow(key: 'birthdays' | 'reception' | 'marketing' | 'gm', branchId: string | null) {
  const [t] = await ctx.db
    .select()
    .from(s.team)
    .where(
      and(
        eq(s.team.operatorId, oto),
        eq(s.team.key, key),
        branchId === null ? isNull(s.team.branchId) : eq(s.team.branchId, branchId),
      ),
    )
    .limit(1);
  return { id: t!.id, departmentId: t!.departmentId! };
}

/** An active, verified staff account with one inbox role grant. */
async function staff(
  phone: string,
  name: string,
  roleName: 'inbox_agent' | 'inbox_manager',
  scope: { scopeType: 'operator' | 'branch' | 'department'; scopeId: string },
): Promise<string> {
  const employeeId = newId();
  await ctx.db.insert(s.employee).values({ id: employeeId, operatorId: oto, name, phone });
  const accountId = newId();
  await ctx.db.insert(s.account).values({
    id: accountId,
    operatorId: oto,
    employeeId,
    phone,
    passwordHash: await hash(PASSWORD),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  const [role] = await ctx.db
    .select({ id: s.role.id })
    .from(s.role)
    .where(and(eq(s.role.operatorId, oto), eq(s.role.name, roleName)))
    .limit(1);
  await ctx.db.insert(s.roleAssignment).values({ id: newId(), accountId, roleId: role!.id, ...scope });
  return accountId;
}

/**
 * A session minted straight into the table: sign-in cannot seat a
 * department-scoped `inbox_agent` yet (the concern on SCRUM-581, pinned in
 * `inbox-read.test.ts`), and the auth lane owns that.
 */
async function session(who: string, accountId: string) {
  const token = newSessionToken();
  await ctx.db.insert(s.session).values({
    id: newId(),
    accountId,
    tokenHash: hashToken(token),
    branchId: null,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  cookies[who] = `${SESSION_COOKIE}=${token}`;
}

/** Play one customer line through the signed webhook; answers the thread's id. */
async function customerWrites(input: SimulatedInbound, channelAccountId = caCentral): Promise<string> {
  const [row] = await ctx.db.select().from(s.channelAccount).where(eq(s.channelAccount.id, channelAccountId)).limit(1);
  const sim = ctx.app.inboxChannels.simulatorFor({ ...row! });
  if (!sim) throw new Error('simulator off');
  const played = sim.inbound(input);
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/webhooks/inbox/${channelAccountId}`,
    headers: played.webhook.headers as Record<string, string>,
    payload: played.webhook.rawBody as string,
  });
  expect(res.json().outcome).toBe('processed');
  const [m] = await ctx.db
    .select({ conversationId: s.message.conversationId })
    .from(s.message)
    .where(and(eq(s.message.channelAccountId, channelAccountId), eq(s.message.externalMessageId, played.externalMessageId)))
    .limit(1);
  return m!.conversationId;
}

/** A new thread from a new customer, routed by the real router. */
async function newThread(hint: SimulatedInbound['hint'], text = `hello ${SENTINEL}`): Promise<string> {
  phoneSeq += 1;
  return customerWrites({ from: `6681000${String(4000 + phoneSeq)}`, name: `Actions Guest ${phoneSeq}`, text, hint });
}

const bday = () => newThread({ category: 'birthdays', language: 'en' });
const general = () => newThread({ category: 'general', language: 'en' });

async function convRow(id: string) {
  const [c] = await ctx.db.select().from(s.conversation).where(eq(s.conversation.id, id)).limit(1);
  return c!;
}

async function slots(id: string, all = false) {
  return ctx.db
    .select()
    .from(s.assignment)
    .where(and(eq(s.assignment.conversationId, id), ...(all ? [] : [isNull(s.assignment.releasedAt)])))
    .orderBy(asc(s.assignment.slotIndex), asc(s.assignment.assignedAt));
}

const seated = async (id: string) =>
  (await slots(id)).map((a) => [a.slotIndex, a.accountId ?? a.teamId, a.reason] as const);

async function eventsOf(id: string, kind: string) {
  return ctx.db
    .select()
    .from(s.inboxEvent)
    .where(and(eq(s.inboxEvent.conversationId, id), eq(s.inboxEvent.kind, kind as never)))
    .orderBy(asc(s.inboxEvent.createdAt));
}

async function auditsOf(id: string, action: string) {
  return ctx.db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.entityId, id), eq(s.auditLog.action, action)));
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { INBOX_SIMULATOR: 'on', INBOX_SIMULATOR_SECRET: SECRET } });
  oto = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);

  teams.birthdays = await teamRow('birthdays', null);
  teams.marketing = await teamRow('marketing', null);
  teams.recCentral = await teamRow('reception', central);
  teams.recChalong = await teamRow('reception', chalong);

  people.gm = await staff('+66810004901', 'Actions GM', 'inbox_manager', { scopeType: 'operator', scopeId: oto });
  people.chalongMgr = await staff('+66810004902', 'Actions Chalong Manager', 'inbox_manager', {
    scopeType: 'branch',
    scopeId: chalong,
  });
  const bdayDept = { scopeType: 'department' as const, scopeId: teams.birthdays.departmentId };
  people.bdayA = await staff('+66810004903', 'Actions Birthday A', 'inbox_agent', bdayDept);
  people.bdayB = await staff('+66810004904', 'Actions Birthday B', 'inbox_agent', bdayDept);
  people.host = await staff('+66810004905', 'Actions Chalong Host', 'inbox_agent', bdayDept);
  people.mkt = await staff('+66810004906', 'Actions Marketing', 'inbox_agent', {
    scopeType: 'department',
    scopeId: teams.marketing.departmentId,
  });
  people.recCentral = await staff('+66810004907', 'Actions Reception Central', 'inbox_agent', {
    scopeType: 'department',
    scopeId: teams.recCentral.departmentId,
  });
  const entertainment = newId();
  await ctx.db.insert(s.department).values({ id: entertainment, operatorId: oto, branchId: null, name: 'actions-entertainment' });
  people.coord = await staff('+66810004908', 'Actions Coordinator', 'inbox_agent', {
    scopeType: 'department',
    scopeId: entertainment,
  });

  // The fixed pairs: EN birthdays bdayA ↔ bdayB; marketing mkt ↔ the GM.
  const name = async (category: 'birthdays' | 'marketing', language: string | null, primary: string, backup: string) =>
    ctx.db
      .update(s.routingRule)
      .set({ primaryKind: 'account', primaryAccountId: primary, backupAccountId: backup })
      .where(
        and(
          eq(s.routingRule.operatorId, oto),
          eq(s.routingRule.category, category),
          language === null ? isNull(s.routingRule.language) : eq(s.routingRule.language, language),
          eq(s.routingRule.priority, 10),
        ),
      );
  await name('birthdays', 'en', people.bdayA, people.bdayB);
  await name('marketing', null, people.mkt, people.gm);
  // The birthday manager who hosts at Chalong.
  await ctx.db.insert(s.routingRule).values({
    id: newId(),
    operatorId: oto,
    teamId: teams.birthdays.id,
    category: 'birthdays',
    language: null,
    branchId: chalong,
    primaryKind: 'account',
    primaryAccountId: people.host,
    autoAddBackup: false,
    priority: HOSTING_RULE_PRIORITY,
  });

  const id = newId();
  await ctx.db.insert(s.channelAccount).values({
    id,
    operatorId: oto,
    branchId: central,
    channel: 'whatsapp',
    provider: 'simulator',
    externalId: 'actions-wa-central',
    displayName: 'Actions WhatsApp Central',
    defaultCategory: 'general',
    canReply: true,
    status: 'active',
  });
  caCentral = id;

  cookies.gm = await signInAs(ctx.app, '+66810004901', PASSWORD);
  cookies.chalongMgr = await signInAs(ctx.app, '+66810004902', PASSWORD);
  for (const who of ['bdayA', 'bdayB', 'host', 'mkt', 'recCentral', 'coord'] as const) await session(who, people[who]);
  cookies.counter = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  cookies.secondAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('the router put the pair on (the starting point)', () => {
  it('an EN birthday opens with bdayA primary and bdayB as support', async () => {
    const id = await bday();
    expect(await seated(id)).toEqual([
      [0, people.bdayA, 'auto'],
      [1, people.bdayB, 'auto'],
    ]);
  });

  it('the hosting rule never routes a new conversation', async () => {
    // A Chalong birthday with no language rule would fall to the catch-all,
    // never to the host's rule, which sits below it.
    const chalongWa = newId();
    await ctx.db.insert(s.channelAccount).values({
      id: chalongWa,
      operatorId: oto,
      branchId: chalong,
      channel: 'whatsapp',
      provider: 'simulator',
      externalId: 'actions-wa-chalong',
      displayName: 'Actions WhatsApp Chalong',
      defaultCategory: 'birthdays',
      canReply: true,
      status: 'active',
    });
    phoneSeq += 1;
    const id = await customerWrites({ from: `66810005${String(100 + phoneSeq)}`, text: 'party?', hint: { language: 'de' } }, chalongWa);
    const owners = await seated(id);
    expect(owners.some(([, who]) => who === people.host)).toBe(false);
    expect(owners[0]).toEqual([0, teams.birthdays.id, 'auto']);
  });
});

describe('every action refuses who may not (wrong role, not visible, another operator)', () => {
  let id: string;
  beforeAll(async () => {
    id = await general();
  });

  const actions: Array<[string, 'POST' | 'PUT' | 'PATCH' | 'DELETE', string, unknown]> = [
    ['primary', 'PUT', 'primary', { assignee: { kind: 'account', id: '00000000-0000-4000-8000-000000000001' } }],
    ['support add', 'POST', 'support', { accountId: '00000000-0000-4000-8000-000000000001' }],
    ['support remove', 'DELETE', 'support/00000000-0000-4000-8000-000000000002', undefined],
    ['divert', 'POST', 'divert', undefined],
    ['move', 'POST', 'move', { dest: { kind: 'marketing' } }],
    ['branch', 'PATCH', 'branch', { branchId: null }],
    ['handle', 'POST', 'handle', undefined],
    ['reopen', 'POST', 'reopen', undefined],
  ];

  it.each(actions)('%s: a till account with no inbox role is 403', async (_n, method, path, body) => {
    const res = await call<Refusal>('counter', method, at(id, path), body);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it.each(actions)('%s: another operator’s administrator gets 404 — it does not exist for them', async (_n, method, path, body) => {
    const res = await call<Refusal>('secondAdmin', method, at(id, path), body);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Conversation not found' });
  });

  it('a conversation outside the caller’s sight is 404: the Chalong manager on a Central thread, the marketing agent on a reception one', async () => {
    expect((await call<Refusal>('chalongMgr', 'POST', at(id, 'move'), { dest: { kind: 'marketing' } })).status).toBe(404);
    expect((await call<Refusal>('mkt', 'POST', at(id, 'handle'))).status).toBe(404);
    expect((await call<Refusal>('coord', 'POST', at(id, 'handle'))).status).toBe(404);
  });

  it('visible but without the permission is 403 — a reception agent cannot add support, move or reopen', async () => {
    const add = await call<Refusal>('recCentral', 'POST', at(id, 'support'), { accountId: people.coord });
    expect(add.status).toBe(403);
    expect(add.body.error.message).toBe('Missing permission inbox:conversation:assign');
    expect((await call<Refusal>('recCentral', 'POST', at(id, 'move'), { dest: { kind: 'marketing' } })).body.error.message).toBe(
      'Missing permission inbox:conversation:move',
    );
    expect((await call<Refusal>('recCentral', 'POST', at(id, 'reopen'))).body.error.message).toBe(
      'Missing permission inbox:conversation:reopen',
    );
    // A team primary is not this person: the primary change needs `assign`.
    expect((await call<Refusal>('recCentral', 'PUT', at(id, 'primary'), { assignee: { kind: 'account', id: people.recCentral } })).status).toBe(403);
  });
});

describe('the primary: replace, and category follows the primary', () => {
  it('a replacement within the team moves nothing; the old slot is released, never deleted', async () => {
    const id = await bday();
    const res = await call('gm', 'PUT', at(id, 'primary'), { assignee: { kind: 'account', id: people.host } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.moved).toBe(false);
    expect(res.body.conversation.category).toBe('birthdays');
    expect(await seated(id)).toEqual([
      [0, people.host, 'manual'],
      [1, people.bdayB, 'auto'],
    ]);
    const history = await slots(id, true);
    expect(history.find((a) => a.accountId === people.bdayA)!.releasedAt).not.toBeNull();
    expect(history).toHaveLength(3);
    expect((await auditsOf(id, 'inbox.conversation.primary'))[0]!.after).toMatchObject({ moved: false, teamId: teams.birthdays.id });
  });

  it('another team’s person: 409 CATEGORY_MOVE_UNCONFIRMED and nothing changes, then the confirmed move', async () => {
    const id = await bday();
    const before = await seated(id);
    const refused = await call<Refusal>('gm', 'PUT', at(id, 'primary'), { assignee: { kind: 'account', id: people.mkt } });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'CATEGORY_MOVE_UNCONFIRMED',
      message: 'Changing primary owner will move this conversation to the new department. Continue?',
      details: { fromCategory: 'birthdays', toCategory: 'marketing', toTeamId: teams.marketing.id, toBranchId: central },
    });
    expect(await seated(id)).toEqual(before);
    expect((await convRow(id)).category).toBe('birthdays');
    // `confirmMove: false` is not a confirmation.
    expect(
      (await call<Refusal>('gm', 'PUT', at(id, 'primary'), { assignee: { kind: 'account', id: people.mkt }, confirmMove: false })).status,
    ).toBe(409);

    const ok = await call('gm', 'PUT', at(id, 'primary'), { assignee: { kind: 'account', id: people.mkt }, confirmMove: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ moved: true, conversation: { category: 'marketing', teamId: teams.marketing.id, branchId: central } });
    // The support places stay (:1712).
    expect(await seated(id)).toEqual([
      [0, people.mkt, 'manual'],
      [1, people.bdayB, 'auto'],
    ]);
    const [pill] = await eventsOf(id, 'moved_team');
    expect(pill!.payload).toMatchObject({ followsPrimary: true, fromCategory: 'birthdays', toCategory: 'marketing' });
    expect(pill!.actorAccountId).toBe(people.gm);
  });

  it('a person in no team keeps the category (management, :1153)', async () => {
    const id = await bday();
    const res = await call('gm', 'PUT', at(id, 'primary'), { assignee: { kind: 'account', id: people.coord } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ moved: false, conversation: { category: 'birthdays', teamId: teams.birthdays.id } });
  });

  it('a reception desk as primary moves the thread to that desk and its branch, after the confirmation', async () => {
    const id = await general();
    const team = { kind: 'team', id: teams.recChalong.id };
    expect((await call<Refusal>('gm', 'PUT', at(id, 'primary'), { assignee: team })).body.error.code).toBe('CATEGORY_MOVE_UNCONFIRMED');
    const ok = await call('gm', 'PUT', at(id, 'primary'), { assignee: team, confirmMove: true });
    expect(ok.body).toMatchObject({ moved: true, conversation: { category: 'general', teamId: teams.recChalong.id, branchId: chalong } });
  });

  it('the current primary may hand it on without `assign`; a support person may not', async () => {
    const id = await bday();
    expect((await call<Refusal>('bdayB', 'PUT', at(id, 'primary'), { assignee: { kind: 'account', id: people.host } })).status).toBe(403);
    const ok = await call('bdayA', 'PUT', at(id, 'primary'), { assignee: { kind: 'account', id: people.host } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('the one-seat rule is a clean 409: a support person cannot also be primary, nor the primary again', async () => {
    const id = await bday();
    for (const who of [people.bdayB, people.bdayA]) {
      const res = await call<Refusal>('gm', 'PUT', at(id, 'primary'), { assignee: { kind: 'account', id: who } });
      expect(res.status).toBe(409);
      expect(res.body.error).toEqual({ code: 'ALREADY_ON_CONVERSATION', message: INBOX_ACTION_MESSAGES.alreadyOn });
    }
    const team = await call<Refusal>('gm', 'PUT', at(await general(), 'primary'), { assignee: { kind: 'team', id: teams.recCentral.id } });
    expect(team.body.error).toEqual({ code: 'ALREADY_ON_CONVERSATION', message: INBOX_ACTION_MESSAGES.teamAlreadyOn });
  });

  it('only a person who reads the Inbox can hold a place', async () => {
    const id = await bday();
    const counterId = (await ctx.db.select({ id: s.account.id }).from(s.account).where(eq(s.account.phone, RECEPTION.phone)))[0]!.id;
    const res = await call<Refusal>('gm', 'PUT', at(id, 'primary'), { assignee: { kind: 'account', id: counterId } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Not a person who can hold a place in the Inbox.');
  });
});

describe('support: two places, managers add and remove', () => {
  it('fills the next free place, refuses a third, refuses a second seat; removal releases', async () => {
    const id = await bday(); // bdayA primary, bdayB support 1
    const add = await call('gm', 'POST', at(id, 'support'), { accountId: people.coord });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    expect(await seated(id)).toEqual([
      [0, people.bdayA, 'auto'],
      [1, people.bdayB, 'auto'],
      [2, people.coord, 'manual'],
    ]);

    const full = await call<Refusal>('gm', 'POST', at(id, 'support'), { accountId: people.mkt });
    expect(full.status).toBe(409);
    expect(full.body.error).toEqual({ code: 'SUPPORT_FULL', message: 'Both support places are taken. Remove someone first.' });

    const removed = await call('gm', 'DELETE', at(id, `support/${(await slots(id)).find((a) => a.slotIndex === 1)!.id}`));
    expect(removed.status).toBe(200);
    expect(removed.body.assignments.map((a) => a.slotIndex)).toEqual([0, 2]);

    const twice = await call<Refusal>('gm', 'POST', at(id, 'support'), { accountId: people.bdayA });
    expect(twice.body.error.code).toBe('ALREADY_ON_CONVERSATION');

    // Place 1 is free again, and is the one filled.
    await call('gm', 'POST', at(id, 'support'), { accountId: people.mkt });
    expect((await seated(id)).map(([i, who]) => [i, who])).toEqual([
      [0, people.bdayA],
      [1, people.mkt],
      [2, people.coord],
    ]);
    // History: four rows, one released, none deleted.
    const history = await slots(id, true);
    expect(history).toHaveLength(4);
    expect(history.filter((a) => a.releasedAt !== null).map((a) => a.accountId)).toEqual([people.bdayB]);
    expect(await eventsOf(id, 'released')).toHaveLength(1);
  });

  it('removing the primary through the support route, or an unknown slot, is 404', async () => {
    const id = await bday();
    const primary = (await slots(id)).find((a) => a.slot === 'primary')!;
    const res = await call<Refusal>('gm', 'DELETE', at(id, `support/${primary.id}`));
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Support assignment not found');
  });

  it('the support person is now able to read the thread; a team agent without `assign` cannot add', async () => {
    const id = await bday();
    expect((await call<Refusal>('bdayA', 'POST', at(id, 'support'), { accountId: people.coord })).status).toBe(403);
    await call('gm', 'POST', at(id, 'support'), { accountId: people.coord });
    const read = await ctx.app.inject({ method: 'GET', url: `/inbox/conversations/${id}`, headers: { cookie: cookies.coord! } });
    expect(read.statusCode).toBe(200);
  });
});

describe('Divert: the fixed pair swaps', () => {
  it('the primary presses it: the backup becomes primary, the old primary takes the backup’s place; again swaps back', async () => {
    const id = await bday();
    // The detail says who the press would seat, read as the action reads it (I3b).
    const divertTo = () => divertToOf('bdayA', id);
    expect((await divertTo())?.accountId).toBe(people.bdayB);
    const first = await call('bdayA', 'POST', at(id, 'divert'));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await seated(id)).toEqual([
      [0, people.bdayB, 'divert'],
      [1, people.bdayA, 'divert'],
    ]);
    const [pill] = await eventsOf(id, 'diverted');
    expect(pill!.payload).toMatchObject({ fromAccountId: people.bdayA, toAccountId: people.bdayB, oldPrimarySupportIndex: 1 });
    expect((await divertTo())?.accountId).toBe(people.bdayA);

    // bdayA is support now and holds no `assign`.
    expect((await call<Refusal>('bdayA', 'POST', at(id, 'divert'))).status).toBe(403);
    const back = await call('bdayB', 'POST', at(id, 'divert'));
    expect(back.status).toBe(200);
    expect((await seated(id)).map(([i, who]) => [i, who])).toEqual([
      [0, people.bdayA],
      [1, people.bdayB],
    ]);
    expect((await slots(id, true)).filter((a) => a.releasedAt !== null)).toHaveLength(4);
    expect(await auditsOf(id, 'inbox.conversation.divert')).toHaveLength(2);
  });

  it('a manager diverts on someone’s behalf; the old primary goes to the next free place when the backup was not on it', async () => {
    const id = await bday();
    await call('gm', 'DELETE', at(id, `support/${(await slots(id)).find((a) => a.slotIndex === 1)!.id}`));
    await call('gm', 'POST', at(id, 'support'), { accountId: people.coord }); // takes place 1
    const res = await call('gm', 'POST', at(id, 'divert'));
    expect(res.status).toBe(200);
    expect(await seated(id)).toEqual([
      [0, people.bdayB, 'divert'],
      [1, people.coord, 'manual'],
      [2, people.bdayA, 'divert'],
    ]);
  });

  it('reception has no backup: 409 DIVERT_NO_BACKUP', async () => {
    const id = await general();
    // The detail agrees: no Divert to show.
    expect(await divertToOf('gm', id)).toBeNull();
    const res = await call<Refusal>('gm', 'POST', at(id, 'divert'));
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'DIVERT_NO_BACKUP', message: 'This conversation has no backup to divert to.' });
  });
});

describe('move: another team, re-routed', () => {
  it('to Marketing: every slot released, the new team’s primary and its backup put on, the event logged', async () => {
    const id = await bday();
    await call('gm', 'POST', at(id, 'support'), { accountId: people.coord });
    const res = await call('gm', 'POST', at(id, 'move'), { dest: { kind: 'marketing' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ moved: true, conversation: { category: 'marketing', teamId: teams.marketing.id, branchId: central } });
    expect(await seated(id)).toEqual([
      [0, people.mkt, 'move'],
      [1, people.gm, 'move'],
    ]);
    const released = (await slots(id, true)).filter((a) => a.releasedAt !== null);
    expect(released.map((a) => a.accountId).sort()).toEqual([people.bdayA, people.bdayB, people.coord].sort());
    const [moved] = await eventsOf(id, 'moved_team');
    expect(moved!.payload).toMatchObject({
      followsPrimary: false,
      fromTeamName: 'Birthdays & Events',
      toTeamName: 'Marketing',
      fromCategory: 'birthdays',
      toCategory: 'marketing',
    });
    expect(moved!.actorAccountId).toBe(people.gm);
    const newSlots = await slots(id);
    expect(newSlots.every((a) => a.assignedByKind === 'account' && a.assignedByAccountId === people.gm)).toBe(true);
  });

  it('to a reception desk: the branch is set, the desk is primary, no backup; the same team again is 409', async () => {
    const id = await bday();
    const res = await call('gm', 'POST', at(id, 'move'), { dest: { kind: 'reception', branchId: chalong } });
    expect(res.body).toMatchObject({ conversation: { category: 'general', teamId: teams.recChalong.id, branchId: chalong } });
    expect(await seated(id)).toEqual([[0, teams.recChalong.id, 'move']]);
    const again = await call<Refusal>('gm', 'POST', at(id, 'move'), { dest: { kind: 'reception', branchId: chalong } });
    expect(again.body.error).toEqual({ code: 'ALREADY_IN_TEAM', message: 'The conversation is already with that team.' });
    // Now at Chalong: the Chalong manager sees it and may move it.
    const back = await call('chalongMgr', 'POST', at(id, 'move'), { dest: { kind: 'birthdays' } });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await seated(id)).toEqual([
      [0, people.bdayA, 'move'],
      [1, people.bdayB, 'move'],
    ]);
  });

  it('to the GM queue (SCRUM-220 playbook): category gm, the GM team, its blank rule seats the team itself', async () => {
    const gmTeam = await teamRow('gm', null);
    const id = await bday();
    const res = await call('gm', 'POST', at(id, 'move'), { dest: { kind: 'gm' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ moved: true, conversation: { category: 'gm', teamId: gmTeam.id, branchId: central } });
    expect(await seated(id)).toEqual([[0, gmTeam.id, 'move']]);
    const again = await call<Refusal>('gm', 'POST', at(id, 'move'), { dest: { kind: 'gm' } });
    expect(again.body.error.code).toBe('ALREADY_IN_TEAM');
  });

  it('a new gm-classified thread is routed to the GM team (SCRUM-220 playbook)', async () => {
    const gmTeam = await teamRow('gm', null);
    const id = await newThread({ category: 'gm', language: 'en' });
    expect(await convRow(id)).toMatchObject({ category: 'gm', teamId: gmTeam.id });
    expect(await seated(id)).toEqual([[0, gmTeam.id, 'auto']]);
  });

  it('a reception destination with no desk is 404', async () => {
    const id = await bday();
    const res = await call<Refusal>('gm', 'POST', at(id, 'move'), { dest: { kind: 'reception', branchId: newId() } });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('No reception team at that branch.');
  });
});

describe('the branch: confirming a birthday’s branch adds the hosting birthday manager', () => {
  /** The branch's name as the pill and the audit row carry it. */
  const branchName = async (id: string) => (await ctx.db.select({ name: s.branch.name }).from(s.branch).where(eq(s.branch.id, id)))[0]!.name;

  it('Chalong confirmed: the host joins the free support place, once — the result names them, the pill names the branch', async () => {
    const id = await bday(); // at Central (the channel account's park)
    const res = await call<InboxBranchResult>('gm', 'PATCH', at(id, 'branch'), { branchId: chalong });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      hostAdded: true,
      hostSkipped: null,
      host: { accountId: people.host, name: 'Actions Chalong Host' },
      conversation: { branchId: chalong },
    });
    expect(await seated(id)).toEqual([
      [0, people.bdayA, 'auto'],
      [1, people.bdayB, 'auto'],
      [2, people.host, 'auto'],
    ]);
    const host = (await slots(id)).find((a) => a.accountId === people.host)!;
    expect(host.assignedByKind).toBe('system');
    expect((await eventsOf(id, 'branch_set'))[0]!.payload).toEqual({
      fromBranchId: central,
      toBranchId: chalong,
      fromBranchName: await branchName(central),
      branchName: await branchName(chalong),
    });
    expect((await auditsOf(id, 'inbox.conversation.branch'))[0]!.after).toMatchObject({
      branchId: chalong,
      branchName: await branchName(chalong),
      changed: true,
      hostSkipped: null,
    });

    const again = await call<InboxBranchResult>('gm', 'PATCH', at(id, 'branch'), { branchId: chalong });
    expect(again.body).toMatchObject({ hostAdded: false, hostSkipped: 'already_on', host: null });
    expect(await eventsOf(id, 'branch_set')).toHaveLength(1);
    expect((await auditsOf(id, 'inbox.conversation.branch'))[1]!.after).toMatchObject({ changed: false, hostSkipped: 'already_on' });
  });

  it('no free place: the branch is set, the host is not added, and the result says why', async () => {
    const id = await bday();
    await call('gm', 'POST', at(id, 'support'), { accountId: people.coord });
    const res = await call<InboxBranchResult>('gm', 'PATCH', at(id, 'branch'), { branchId: chalong });
    expect(res.body).toMatchObject({ hostAdded: false, hostSkipped: 'support_full', host: null, conversation: { branchId: chalong } });
    expect((await auditsOf(id, 'inbox.conversation.branch'))[0]!.after).toMatchObject({ hostSkipped: 'support_full' });
  });

  it('a general conversation, or a branch with no host, adds nobody and says so; clearing the branch names nothing; an unknown branch is 404', async () => {
    const g = await general();
    // Not a birthday: the host step does not run, so there is no reason to give.
    expect((await call<InboxBranchResult>('gm', 'PATCH', at(g, 'branch'), { branchId: chalong })).body).toMatchObject({
      hostAdded: false,
      hostSkipped: null,
      host: null,
    });
    const b = await bday();
    // Central names no hosting manager.
    expect((await call<InboxBranchResult>('gm', 'PATCH', at(b, 'branch'), { branchId: central })).body).toMatchObject({
      hostAdded: false,
      hostSkipped: 'no_host',
      host: null,
    });
    const cleared = await call<InboxBranchResult>('gm', 'PATCH', at(b, 'branch'), { branchId: null });
    expect(cleared.body).toMatchObject({ hostAdded: false, hostSkipped: null, host: null, conversation: { branchId: null } });
    expect((await eventsOf(b, 'branch_set')).at(-1)!.payload).toEqual({
      fromBranchId: central,
      toBranchId: null,
      fromBranchName: await branchName(central),
      branchName: null,
    });
    const unknown = await call<Refusal>('gm', 'PATCH', at(b, 'branch'), { branchId: newId() });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.message).toBe('Branch not found');
  });
});

describe('Handled and reopen', () => {
  it('a support person may mark it handled; twice is 409; an agent may not reopen; a manager does', async () => {
    const id = await bday();
    const done = await call('bdayB', 'POST', at(id, 'handle'));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.conversation).toMatchObject({ status: 'handled', handledByKind: 'account', handledByAccountId: people.bdayB });
    expect((await call<Refusal>('bdayA', 'POST', at(id, 'handle'))).body.error).toEqual({
      code: 'ALREADY_HANDLED',
      message: 'This conversation is already handled.',
    });
    expect((await call<Refusal>('bdayA', 'POST', at(id, 'reopen'))).status).toBe(403);
    const open = await call('gm', 'POST', at(id, 'reopen'));
    expect(open.status).toBe(200);
    expect((await call<Refusal>('gm', 'POST', at(id, 'reopen'))).body.error).toEqual({
      code: 'NOT_HANDLED',
      message: 'This conversation is not handled.',
    });
  });

  it('a team member not on the thread may mark it handled (in its team); a manual-only person put on it may too', async () => {
    const id = await bday();
    expect((await call('host', 'POST', at(id, 'handle'))).status).toBe(200);
    const other = await general();
    await call('gm', 'POST', at(other, 'support'), { accountId: people.coord });
    expect((await call('coord', 'POST', at(other, 'handle'))).status).toBe(200);
  });

  it('REOPEN PARITY: a manager’s reopen and the customer’s automatic reopen leave identical column states', async () => {
    const byHand = await bday();
    const byCustomer = await bday();
    const phoneOf = async (id: string) => {
      const [c] = await ctx.db
        .select({ handle: s.contact.externalHandle })
        .from(s.conversation)
        .innerJoin(s.contact, eq(s.contact.id, s.conversation.contactId))
        .where(eq(s.conversation.id, id));
      return c!.handle.replace('+', '');
    };
    for (const id of [byHand, byCustomer]) expect((await call('bdayA', 'POST', at(id, 'handle'))).status).toBe(200);
    const handledBefore = { hand: await convRow(byHand), customer: await convRow(byCustomer) };
    const slotsBefore = { hand: await slots(byHand, true), customer: await slots(byCustomer, true) };

    expect((await call('gm', 'POST', at(byHand, 'reopen'))).status).toBe(200);
    await customerWrites({ from: await phoneOf(byCustomer), text: 'one more thing' });

    const cols = (c: Awaited<ReturnType<typeof convRow>>) => ({
      status: c.status,
      handledAt: c.handledAt,
      handledByKind: c.handledByKind,
      handledByAccountId: c.handledByAccountId,
      reopenedAtSet: c.reopenedAt !== null,
      category: c.category,
      teamId: c.teamId,
      branchId: c.branchId,
    });
    const hand = await convRow(byHand);
    const customer = await convRow(byCustomer);
    expect(cols(hand)).toEqual(cols(customer));
    expect(cols(hand)).toEqual({
      status: 'active',
      handledAt: null,
      handledByKind: null,
      handledByAccountId: null,
      reopenedAtSet: true,
      category: 'birthdays',
      teamId: teams.birthdays.id,
      branchId: central,
    });
    // The assignments are kept, untouched, by both.
    expect(await slots(byHand, true)).toEqual(slotsBefore.hand);
    expect(await slots(byCustomer, true)).toEqual(slotsBefore.customer);

    // The previous values are kept the same way on the pill and on the audit row.
    const [pillHand] = await eventsOf(byHand, 'reopened');
    const [pillCustomer] = await eventsOf(byCustomer, 'reopened');
    const { messageId: _m, ...customerPayload } = pillCustomer!.payload as Record<string, unknown>;
    expect(Object.keys(pillHand!.payload as object).sort()).toEqual(Object.keys(customerPayload).sort());
    expect(pillHand!.payload).toEqual({
      automatic: false,
      previousHandledAt: handledBefore.hand.handledAt!.toISOString(),
      previousHandledByKind: 'account',
      previousHandledByAccountId: people.bdayA,
    });
    expect(customerPayload).toEqual({
      automatic: true,
      previousHandledAt: handledBefore.customer.handledAt!.toISOString(),
      previousHandledByKind: 'account',
      previousHandledByAccountId: people.bdayA,
    });
    expect([pillHand!.actorKind, pillCustomer!.actorKind]).toEqual(['account', 'customer']);
    const [auditHand] = await auditsOf(byHand, 'inbox.conversation.reopen');
    const [auditCustomer] = await auditsOf(byCustomer, 'inbox.conversation.reopen');
    expect(Object.keys(auditHand!.before as object).sort()).toEqual(Object.keys(auditCustomer!.before as object).sort());
    expect(auditHand!.before).toMatchObject({ status: 'handled', handledByAccountId: people.bdayA, handledByKind: 'account' });
    expect(auditHand!.before).toMatchObject({ handledAt: handledBefore.hand.handledAt!.toISOString() });
  });
});

describe('the house rules: idempotent, audited with ids only', () => {
  it('the same Idempotency-Key replays the answer and seats once; a different body under it is 409', async () => {
    const id = await bday();
    const key = newId();
    const first = await call('gm', 'POST', at(id, 'support'), { accountId: people.coord }, key);
    const second = await call('gm', 'POST', at(id, 'support'), { accountId: people.coord }, key);
    expect(first.status).toBe(200);
    expect(second).toEqual(first);
    expect((await slots(id)).filter((a) => a.accountId === people.coord)).toHaveLength(1);
    const mismatch = await call<Refusal>('gm', 'POST', at(id, 'support'), { accountId: people.mkt }, key);
    expect(mismatch.status).toBe(409);
  });

  it('no message body reaches an audit row or a timeline event of the actions', async () => {
    const rows = await ctx.db.select().from(s.auditLog).where(eq(s.auditLog.entityType, 'inbox.conversation'));
    expect(rows.length).toBeGreaterThan(20);
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
    const events = await ctx.db.select().from(s.inboxEvent).where(eq(s.inboxEvent.operatorId, oto));
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
  });

  it('every action wrote an audit row', async () => {
    const actions = new Set(
      (await ctx.db.select({ action: s.auditLog.action }).from(s.auditLog).where(eq(s.auditLog.entityType, 'inbox.conversation'))).map(
        (r) => r.action,
      ),
    );
    for (const a of [
      'inbox.conversation.primary',
      'inbox.conversation.support_add',
      'inbox.conversation.support_remove',
      'inbox.conversation.divert',
      'inbox.conversation.move',
      'inbox.conversation.branch',
      'inbox.conversation.handle',
      'inbox.conversation.reopen',
    ]) {
      expect(actions.has(a), a).toBe(true);
    }
  });
});
