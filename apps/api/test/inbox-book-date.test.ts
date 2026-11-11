import { hash } from '@node-rs/argon2';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import type { SimulatedInbound } from '@oto/messaging';
import {
  InboxBookDateResultSchema,
  InboxConversationDetailSchema,
  InboxDashboardSchema,
  InboxOpenBeoResultSchema,
  newId,
  readHandoffTarget,
  type InboxBookDateResult,
  type InboxOpenBeoResult,
} from '@oto/shared';
import { SESSION_COOKIE, hashToken, newSessionToken } from '../src/plugins/session';
import {
  BOOK_DATE_ACTION,
  BOOK_DATE_MESSAGES,
  OPEN_BEO_PURPOSE,
  eventTitleOf,
  eventStandingOf,
  isRemovedStanding,
} from '../src/services/inbox/book-date';
import { inboxToday, inboxWeekStart } from '../src/services/inbox/read';
import type {
  DirectoryInboxEventAnswer,
  DirectoryInboxEventBody,
  DirectoryOutcome,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import {
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-775 — Book Date on a birthday conversation makes a TENTATIVE birthday
 * in the OTO App's Events module and links the two (owner decision, 4
 * November: the Events module is the one home for birthday orders).
 *
 * The Events module here is the app's own directory write
 * (`apps/oto-app/server/directory/eventWrites.ts` `createInboxBirthdayEvent`)
 * on the app's own tables in this test database, behind a stub of the
 * directory client that can also play "no answer" and "answered but lost".
 * Conversations are made the real way, through the simulator's signed webhook.
 *
 *   the GM        inbox_manager operator-wide (holds assign)
 *   bdayA         an agent in Birthdays & Events (a department grant), who
 *                 may also open the OTO App (a department grant of its own)
 *   recCentral    an agent at Reception · Central (no assign)
 *   coord         manual-only: reads what they are put on, in no team
 *   mgrCentral    inbox_manager at the Central branch only (a branch manager)
 */

const SECRET = 'inbox-book-date-test-secret';
const PASSWORD = 'inboxbookdate1234';
const OTO_APP_ORIGIN = 'https://otoapp.book-date.test';
const HANDOFF_KEY = 'k775:inbox-book-date-handoff-secret-0123456789';

interface AppWrites {
  createInboxBirthdayEvent(
    pool: pg.Pool,
    tenantId: string,
    input: DirectoryInboxEventBody,
  ): Promise<
    | { ok: true; status: 200 | 201; body: DirectoryInboxEventAnswer }
    | { ok: false; status: 400 | 404 | 409; error: string; message: string }
  >;
}

let ctx: TestContext;
let oto: string;
let central: string;
let chalong: string;
let caCentral: string;
let appPool: pg.Pool;
let appWrites: AppWrites;
const appTenant = newId();
const appCentral = newId();
const cookies: Record<string, string> = {};
const people = {} as Record<'gm' | 'bdayA' | 'recCentral' | 'coord' | 'mgrCentral', string>;
let phoneSeq = 0;

type Plan = 'app' | 'unreachable' | 'lost_answer';
const plan: Plan[] = [];
const calls: DirectoryInboxEventBody[] = [];

const directory: OtoAppDirectory = {
  configured: true,
  async createInboxEvent(body): Promise<DirectoryOutcome<DirectoryInboxEventAnswer>> {
    calls.push(body);
    const next = plan.shift() ?? 'app';
    if (next === 'unreachable') {
      return { ok: false, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'The OTO App did not answer', retryable: true };
    }
    const outcome = await appWrites.createInboxBirthdayEvent(appPool, appTenant, body);
    if (next === 'lost_answer') {
      return { ok: false, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'The OTO App did not answer', retryable: true };
    }
    if (outcome.ok) return { ok: true, status: outcome.status, body: outcome.body };
    return {
      ok: false,
      status: outcome.status,
      code: `OTOAPP_${outcome.error.toUpperCase()}`,
      message: outcome.message,
      retryable: false,
    };
  },
  async addAttendee() {
    return { ok: false, status: null, code: 'OTOAPP_DIRECTORY_NOT_CONFIGURED', message: 'Not in this suite', retryable: true };
  },
  async checkinAttendee() {
    return { ok: false, status: null, code: 'OTOAPP_DIRECTORY_NOT_CONFIGURED', message: 'Not in this suite', retryable: true };
  },
};

type Res<T> = { status: number; body: T; headers: Record<string, unknown> };
type Refusal = { error: { code: string; message: string; details?: Record<string, unknown> } };

async function book<T = InboxBookDateResult>(
  who: string,
  conversationId: string,
  body: Record<string, unknown>,
  key: string = newId(),
): Promise<Res<T>> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/inbox/conversations/${conversationId}/book-date`,
    headers: { cookie: cookies[who]!, 'idempotency-key': key },
    payload: body,
  });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
}

async function get<T>(who: string, url: string): Promise<{ status: number; body: T }> {
  const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie: cookies[who]! } });
  return { status: res.statusCode, body: res.json() as T };
}

const bodyOf = (over: Record<string, unknown> = {}) => ({
  id: newId(),
  branchId: central,
  date: '2099-03-14',
  startTime: '14:00',
  kids: 12,
  adults: null,
  contactName: 'Book Date Parent',
  phone: '081 234 5678',
  childName: 'Mali',
  childAge: 6,
  ...over,
});

async function teamRow(key: 'birthdays' | 'reception', branchId: string | null) {
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

/** A session minted straight into the table, as inbox-actions.test.ts seats a department-scoped agent. */
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

async function newThread(hint: SimulatedInbound['hint']): Promise<string> {
  phoneSeq += 1;
  const [row] = await ctx.db.select().from(s.channelAccount).where(eq(s.channelAccount.id, caCentral)).limit(1);
  const sim = ctx.app.inboxChannels.simulatorFor({ ...row! });
  if (!sim) throw new Error('simulator off');
  const played = sim.inbound({
    from: `6681000${String(7700 + phoneSeq)}`,
    name: `Book Date Guest ${phoneSeq}`,
    text: 'Hi! Birthday party for 12 kids on 14 March please, my daughter turns 6',
    hint,
  });
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/webhooks/inbox/${caCentral}`,
    headers: played.webhook.headers as Record<string, string>,
    payload: played.webhook.rawBody as string,
  });
  expect(res.json().outcome).toBe('processed');
  const [m] = await ctx.db
    .select({ conversationId: s.message.conversationId })
    .from(s.message)
    .where(and(eq(s.message.channelAccountId, caCentral), eq(s.message.externalMessageId, played.externalMessageId)))
    .limit(1);
  return m!.conversationId;
}

const bday = () => newThread({ category: 'birthdays', language: 'en' });

async function convRow(id: string) {
  const [c] = await ctx.db.select().from(s.conversation).where(eq(s.conversation.id, id)).limit(1);
  return c!;
}

async function pills(id: string) {
  return ctx.db
    .select()
    .from(s.inboxEvent)
    .where(and(eq(s.inboxEvent.conversationId, id), eq(s.inboxEvent.kind, 'date_booked')))
    .orderBy(asc(s.inboxEvent.createdAt));
}

async function audits(id: string, action: string) {
  return ctx.db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.entityId, id), eq(s.auditLog.action, action)));
}

async function appEvents(conversationId: string) {
  const res = await appPool.query<{
    id: string;
    event_type: string;
    status: string;
    branch_id: string;
    event_date: string;
    start_time: string;
    num_children: number | null;
    child_name: string | null;
    kid_turning_age: number | null;
    booking_name: string | null;
    whatsapp_phone_e164: string | null;
    title: string;
  }>(`select * from core_events where inbox_conversation_id = $1 order by created_at`, [conversationId]);
  return res.rows;
}

beforeAll(async () => {
  ctx = await createTestContext({
    otoapp: true,
    env: {
      INBOX_SIMULATOR: 'on',
      INBOX_SIMULATOR_SECRET: SECRET,
      HANDOFF_SIGNING_KEY: HANDOFF_KEY,
      HANDOFF_APP_ORIGINS: `oto_app=${OTO_APP_ORIGIN}`,
    },
  });
  oto = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);

  // The app's pool, as the app runs it: its own tables on its search path.
  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as AppWrites;
  // The app's park group, with Central mapped to the platform's Central; Chalong has no app branch.
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-775')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;

  const birthdays = await teamRow('birthdays', null);
  const recCentral = await teamRow('reception', central);
  people.gm = await staff('+66810007701', 'Book Date GM', 'inbox_manager', { scopeType: 'operator', scopeId: oto });
  people.bdayA = await staff('+66810007702', 'Book Date Birthday A', 'inbox_agent', {
    scopeType: 'department',
    scopeId: birthdays.departmentId,
  });
  people.recCentral = await staff('+66810007703', 'Book Date Reception', 'inbox_agent', {
    scopeType: 'department',
    scopeId: recCentral.departmentId,
  });
  const elsewhere = newId();
  await ctx.db.insert(s.department).values({ id: elsewhere, operatorId: oto, branchId: null, name: 'book-date-elsewhere' });
  people.coord = await staff('+66810007704', 'Book Date Coordinator', 'inbox_agent', {
    scopeType: 'department',
    scopeId: elsewhere,
  });
  people.mgrCentral = await staff('+66810007705', 'Book Date Central Manager', 'inbox_manager', {
    scopeType: 'branch',
    scopeId: central,
  });
  // Opening the OTO App (Create BEO): the birthdays agent holds it at the team's department.
  const otoAppRole = newId();
  await ctx.db.insert(s.role).values({ id: otoAppRole, operatorId: oto, name: 'book_date_oto_app', description: 'Open the OTO App' });
  await ctx.db.insert(s.rolePermission).values({ id: newId(), roleId: otoAppRole, permission: 'app:oto_app:access' });
  await ctx.db.insert(s.roleAssignment).values({
    id: newId(),
    accountId: people.bdayA,
    roleId: otoAppRole,
    scopeType: 'department',
    scopeId: birthdays.departmentId,
  });

  caCentral = newId();
  await ctx.db.insert(s.channelAccount).values({
    id: caCentral,
    operatorId: oto,
    branchId: central,
    channel: 'whatsapp',
    provider: 'simulator',
    externalId: 'book-date-wa-central',
    displayName: 'Book Date WhatsApp Central',
    defaultCategory: 'general',
    canReply: true,
    status: 'active',
  });

  cookies.gm = await signInAs(ctx.app, '+66810007701', PASSWORD);
  for (const who of ['bdayA', 'recCentral', 'coord', 'mgrCentral'] as const) await session(who, people[who]);
}, 300_000);

afterAll(async () => {
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

beforeEach(() => {
  plan.length = 0;
  calls.length = 0;
});

describe('Book Date makes a tentative birthday in the Events module, linked both ways', () => {
  let conv: string;
  // Made in the first case: the branch ids are only known once the suite has set up.
  let body: ReturnType<typeof bodyOf>;
  let first: InboxBookDateResult;

  it('a birthdays agent books the date: one tentative event, named the conversation', async () => {
    conv = await bday();
    body = bodyOf();
    const res = await book('bdayA', conv, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(InboxBookDateResultSchema.safeParse(res.body).success).toBe(true);
    expect(res.headers['x-oto-replay']).toBeUndefined();
    first = res.body;
    expect(first).toMatchObject({
      conversationId: conv,
      created: true,
      event: {
        id: body.id,
        title: "Mali's 6th Birthday",
        date: '2099-03-14',
        startTime: '14:00',
        branchId: central,
        branchName: expect.any(String),
        status: 'tentative',
        statusName: 'Tentative',
        archived: false,
        kids: 12,
        adults: null,
        bookedByAccountId: people.bdayA,
        beoPath: `/studio/events/kanban?beo=${body.id}`,
      },
    });

    // The Events module's own row: a birthday, tentative, at the mapped branch.
    const rows = await appEvents(conv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.id,
      event_type: 'birthday',
      status: 'tentative',
      branch_id: appCentral,
      event_date: '2099-03-14',
      start_time: '14:00',
      num_children: 12,
      child_name: 'Mali',
      kid_turning_age: 6,
      booking_name: 'Book Date Parent',
      whatsapp_phone_e164: '+66812345678',
    });

    // The conversation's half: the soft key, the pill, the audit row.
    expect((await convRow(conv)).eventOrderRef).toBe(body.id);
    const p = await pills(conv);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ actorKind: 'account', actorAccountId: people.bdayA });
    expect(p[0]!.payload).toMatchObject({ eventId: body.id, date: '2099-03-14', branchId: central, status: 'tentative' });
    const a = await audits(conv, BOOK_DATE_ACTION);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actorAccountId: people.bdayA, entityType: 'inbox.conversation' });
    expect(a[0]!.before).toEqual({ eventOrderRef: null });
    expect(a[0]!.after).toMatchObject({ eventOrderRef: body.id, date: '2099-03-14', status: 'tentative' });
  });

  it('the same id again is the same event: a replay, nothing written twice', async () => {
    const again = await book('bdayA', conv, body);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.body).toEqual({ ...first, created: false });
    expect(await appEvents(conv)).toHaveLength(1);
    expect(await pills(conv)).toHaveLength(1);
    expect(await audits(conv, BOOK_DATE_ACTION)).toHaveLength(1);
  });

  it('the same Idempotency-Key is answered from the replay store, byte for byte', async () => {
    const key = newId();
    const c2 = await bday();
    const b = bodyOf();
    const one = await book('gm', c2, b, key);
    const two = await book('gm', c2, b, key);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(two.body).toEqual(one.body);
    expect(await appEvents(c2)).toHaveLength(1);
  });

  it('a double press at once under one id makes one event', async () => {
    const c3 = await bday();
    const b = bodyOf();
    const both = await Promise.all([book('bdayA', c3, b), book('bdayA', c3, b)]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(both.map((r) => r.body.created).sort()).toEqual([false, true]);
    expect(await appEvents(c3)).toHaveLength(1);
    expect(await pills(c3)).toHaveLength(1);
  });

  it('a second date on a booked conversation is refused, naming the event Create BEO opens', async () => {
    const res = await book<Refusal>('bdayA', conv, bodyOf());
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toEqual({
      code: 'EVENT_ALREADY_BOOKED',
      message: BOOK_DATE_MESSAGES.alreadyBooked,
      details: { eventId: body.id },
    });
    expect(await appEvents(conv)).toHaveLength(1);
  });

  it("an id another conversation holds is refused, and nothing is made", async () => {
    const other = await bday();
    const res = await book<Refusal>('bdayA', other, { ...bodyOf(), id: body.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ID_IN_USE');
    expect(await appEvents(other)).toHaveLength(0);
    expect((await convRow(other)).eventOrderRef).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('the conversation shows its event; a date moved in the Events module shows here', async () => {
    const res = await get<{ event: unknown }>('gm', `/inbox/conversations/${conv}`);
    expect(res.status).toBe(200);
    expect(InboxConversationDetailSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.event).toEqual(first.event);
    await appPool.query(`update core_events set event_date = '2099-03-21', status = 'upcoming' where id = $1`, [body.id]);
    const moved = await get<{ event: { date: string; status: string; statusName: string } }>('gm', `/inbox/conversations/${conv}`);
    expect(moved.body.event).toMatchObject({ date: '2099-03-21', status: 'upcoming', statusName: 'Upcoming' });
    // A thread with nothing booked says so.
    const plain = await bday();
    expect((await get<{ event: unknown }>('gm', `/inbox/conversations/${plain}`)).body.event).toBeNull();
  });

  it('an event restored from the archive in the Events module is the conversation’s again', async () => {
    await appPool.query(`update core_events set is_archived = true, archived_at = now() where id = $1`, [body.id]);
    try {
      const res = await get<{ event: { id: string; archived: boolean; removed: boolean } }>('gm', `/inbox/conversations/${conv}`);
      expect(res.status).toBe(200);
      expect(InboxConversationDetailSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.event).toMatchObject({ id: body.id, archived: true, removed: true });
    } finally {
      await appPool.query(`update core_events set is_archived = false, archived_at = null where id = $1`, [body.id]);
    }
    const restored = await get<{ event: { archived: boolean; removed: boolean } }>('gm', `/inbox/conversations/${conv}`);
    expect(restored.body.event).toMatchObject({ archived: false, removed: false });
    // Restored, it holds the conversation as before.
    const again = await book<Refusal>('bdayA', conv, bodyOf());
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'EVENT_ALREADY_BOOKED', details: { eventId: body.id } });
  });
});

describe('a party removed in the Events module (SCRUM-820)', () => {
  const open = async (who: string, conversationId: string): Promise<Res<Refusal & { eventId?: string }>> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/inbox/conversations/${conversationId}/open-beo`,
      headers: { cookie: cookies[who]! },
    });
    return { status: res.statusCode, body: res.json() as Refusal & { eventId?: string }, headers: res.headers };
  };
  type Shown = { event: { id: string; archived: boolean; removed: boolean; date: string } | null };
  const shown = async (conversationId: string) => (await get<Shown>('gm', `/inbox/conversations/${conversationId}`)).body.event;
  const handoffs = async () =>
    (
      await ctx.db
        .select({ id: s.auditLog.id })
        .from(s.auditLog)
        .where(and(eq(s.auditLog.actorAccountId, people.bdayA), eq(s.auditLog.action, 'auth.handoff_issue')))
    ).length;

  it('a live party is not removed: the chip’s event, Create BEO opens it, a second date is refused', async () => {
    const conv = await bday();
    const b = bodyOf();
    const made = await book('bdayA', conv, b);
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body.event.removed).toBe(false);
    expect(await shown(conv)).toMatchObject({ id: b.id, archived: false, removed: false });
    expect((await open('bdayA', conv)).status).toBe(200);
    expect((await book<Refusal>('bdayA', conv, bodyOf())).body.error.code).toBe('EVENT_ALREADY_BOOKED');
  });

  it('a party deleted there: the event says removed, Create BEO is refused cleanly, Book Date books again', async () => {
    const conv = await bday();
    const b = bodyOf();
    expect((await book('bdayA', conv, b)).status).toBe(200);
    await appPool.query(`delete from core_events where id = $1`, [b.id]);

    // The conversation keeps what was booked, and says it is gone.
    const ev = await shown(conv);
    expect(ev).toMatchObject({ id: b.id, date: '2099-03-14', archived: false, removed: true });

    // No hand-off is minted for a form that is not there.
    const before = await handoffs();
    const refused = await open('bdayA', conv);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toEqual({
      code: 'EVENT_REMOVED',
      message: BOOK_DATE_MESSAGES.partyRemoved,
      details: { eventId: b.id },
    });
    expect(await handoffs()).toBe(before);

    // Book Date is open again: the new event takes the conversation.
    const next = bodyOf({ date: '2099-04-18' });
    const again = await book('bdayA', conv, next);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ created: true, event: { id: next.id, date: '2099-04-18', removed: false } });
    expect((await convRow(conv)).eventOrderRef).toBe(next.id);
    expect(await shown(conv)).toMatchObject({ id: next.id, removed: false });
    // The old pill stays in the thread; the audit row names the event it replaced.
    expect(await pills(conv)).toHaveLength(2);
    const a = await audits(conv, BOOK_DATE_ACTION);
    expect(a).toHaveLength(2);
    const replaced = a.find((r) => (r.after as Record<string, unknown>).eventOrderRef === next.id)!;
    expect(replaced.before).toEqual({ eventOrderRef: b.id });
    expect(replaced.after).toMatchObject({ replacedRemovedEvent: b.id });
    expect((await open('bdayA', conv)).status).toBe(200);
    // The new event holds the conversation as any other.
    expect((await book<Refusal>('bdayA', conv, bodyOf())).body.error).toMatchObject({
      code: 'EVENT_ALREADY_BOOKED',
      details: { eventId: next.id },
    });
  });

  it('a party archived there: removed too, and Book Date books again', async () => {
    const conv = await bday();
    const b = bodyOf();
    expect((await book('bdayA', conv, b)).status).toBe(200);
    await appPool.query(`update core_events set is_archived = true, archived_at = now() where id = $1`, [b.id]);
    expect(await shown(conv)).toMatchObject({ id: b.id, archived: true, removed: true });
    const refused = await open('bdayA', conv);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('EVENT_REMOVED');
    const next = bodyOf({ date: '2099-05-02' });
    const again = await book('bdayA', conv, next);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((await convRow(conv)).eventOrderRef).toBe(next.id);
    expect(await appEvents(conv)).toHaveLength(2);
  });

  it('a party moved to another of the operator’s parks is still there', async () => {
    const conv = await bday();
    const b = bodyOf();
    expect((await book('bdayA', conv, b)).status).toBe(200);
    const appOther = newId();
    await ctx.db.execute(sql`
      insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
      values (${appOther}, ${appTenant}, 'Moved-to park', 'Phuket', ${chalong})`);
    try {
      await appPool.query(`update core_events set branch_id = $2 where id = $1`, [b.id, appOther]);
      expect(await eventStandingOf(ctx.db, oto, b.id)).toBe('live');
      expect(await shown(conv)).toMatchObject({ id: b.id, removed: false });
      expect((await open('bdayA', conv)).status).toBe(200);
      expect((await book<Refusal>('bdayA', conv, bodyOf())).body.error.code).toBe('EVENT_ALREADY_BOOKED');
    } finally {
      await appPool.query(`update core_events set branch_id = $2 where id = $1`, [b.id, appCentral]);
      await ctx.db.execute(sql`delete from otoapp.branches where id = ${appOther}`);
    }
  });

  it('nothing definite is never "removed": a park that is not the operator’s, an unreadable id, a failed read', async () => {
    const conv = await bday();
    const b = bodyOf();
    expect((await book('bdayA', conv, b)).status).toBe(200);
    // The event sits at a branch that is no park of this operator: unknown, so it stands as booked.
    const appForeign = newId();
    await ctx.db.execute(sql`
      insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
      values (${appForeign}, ${appTenant}, 'Not ours', 'Phuket', ${newId()})`);
    try {
      await appPool.query(`update core_events set branch_id = $2 where id = $1`, [b.id, appForeign]);
      expect(await eventStandingOf(ctx.db, oto, b.id)).toBe('unknown');
      expect(await shown(conv)).toMatchObject({ id: b.id, removed: false });
      expect((await book<Refusal>('bdayA', conv, bodyOf())).body.error.code).toBe('EVENT_ALREADY_BOOKED');
    } finally {
      await appPool.query(`update core_events set branch_id = $2 where id = $1`, [b.id, appCentral]);
      await ctx.db.execute(sql`delete from otoapp.branches where id = ${appForeign}`);
    }
    expect(await eventStandingOf(ctx.db, oto, 'not-a-uuid')).toBe('unknown');
    // Another operator asks after this event: none of its parks holds it, so nothing is said.
    const [other] = await ctx.db.select({ id: s.operator.id }).from(s.operator).where(sql`${s.operator.id} <> ${oto}`).limit(1);
    if (other) expect(await eventStandingOf(ctx.db, other.id, b.id)).toBe('unknown');
    // A read that fails is not an answer.
    const failing = {
      select() {
        throw new Error('the database did not answer');
      },
    } as unknown as Parameters<typeof eventStandingOf>[0];
    expect(await eventStandingOf(failing, oto, b.id)).toBe('unknown');
    expect(isRemovedStanding('unknown')).toBe(false);
    expect(isRemovedStanding('live')).toBe(false);
    expect(isRemovedStanding('gone')).toBe(true);
    expect(isRemovedStanding('archived')).toBe(true);
  });
});

describe('who may book, and where', () => {
  it('reception cannot see a birthday thread: 404, and nothing is asked of the Events module', async () => {
    const conv = await bday();
    const res = await book<Refusal>('recCentral', conv, bodyOf());
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('a person put on the thread who is neither in the birthdays team nor holds assign is refused', async () => {
    const conv = await bday();
    const added = await ctx.app.inject({
      method: 'POST',
      url: `/inbox/conversations/${conv}/support`,
      headers: { cookie: cookies.gm!, 'idempotency-key': newId() },
      payload: { accountId: people.coord },
    });
    // Both support places may be taken by the router's pair: free one for the coordinator.
    if (added.statusCode === 409) {
      const slots = await ctx.db
        .select()
        .from(s.assignment)
        .where(and(eq(s.assignment.conversationId, conv), eq(s.assignment.slot, 'support'), isNull(s.assignment.releasedAt)));
      await ctx.app.inject({
        method: 'DELETE',
        url: `/inbox/conversations/${conv}/support/${slots[0]!.id}`,
        headers: { cookie: cookies.gm!, 'idempotency-key': newId() },
      });
      const retry = await ctx.app.inject({
        method: 'POST',
        url: `/inbox/conversations/${conv}/support`,
        headers: { cookie: cookies.gm!, 'idempotency-key': newId() },
        payload: { accountId: people.coord },
      });
      expect(retry.statusCode, retry.body).toBe(200);
    } else {
      expect(added.statusCode, added.body).toBe(200);
    }
    const res = await book<Refusal>('coord', conv, bodyOf());
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('only a birthday conversation books a date', async () => {
    const conv = await newThread({ category: 'general', language: 'en' });
    const res = await book<Refusal>('gm', conv, bodyOf());
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'NOT_A_BIRTHDAY', message: BOOK_DATE_MESSAGES.notABirthday });
    expect(calls).toHaveLength(0);
  });

  it('a park the OTO App has no branch for is refused there, and nothing is written here', async () => {
    const conv = await bday();
    const res = await book<Refusal>('gm', conv, bodyOf({ branchId: chalong }));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'EVENT_BRANCH_NOT_MAPPED', message: BOOK_DATE_MESSAGES.branchNotMapped });
    expect((await convRow(conv)).eventOrderRef).toBeNull();
    expect(await pills(conv)).toHaveLength(0);
    expect(await audits(conv, `${BOOK_DATE_ACTION}.failed`)).toHaveLength(1);
  });

  it('a branch manager books into their own park’s calendar, never another park’s', async () => {
    const conv = await bday();
    expect((await convRow(conv)).branchId).toBe(central);
    const elsewhere = await book<Refusal>('mgrCentral', conv, bodyOf({ branchId: chalong }));
    expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(403);
    expect(calls).toHaveLength(0);
    expect((await convRow(conv)).eventOrderRef).toBeNull();
    const own = await book('mgrCentral', conv, bodyOf());
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.event.branchId).toBe(central);
    expect(calls).toHaveLength(1);
  });

  it('the birthdays team (every park’s) may put the event at another park', async () => {
    const conv = await bday();
    // Past the permission check: the Events module is asked, and answers that it has no branch there.
    const res = await book<Refusal>('bdayA', conv, bodyOf({ branchId: chalong }));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('EVENT_BRANCH_NOT_MAPPED');
    expect(calls).toHaveLength(1);
  });

  it('a phone that cannot be read is refused before anything is asked', async () => {
    const conv = await bday();
    const res = await book<Refusal>('gm', conv, bodyOf({ phone: 'not a phone' }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('when the Events module does not answer', () => {
  it('nothing is booked here, and the press can be made again', async () => {
    const conv = await bday();
    const b = bodyOf();
    plan.push('unreachable');
    const down = await book<Refusal>('bdayA', conv, b);
    expect(down.status).toBe(503);
    expect(down.body.error).toMatchObject({ code: 'EVENTS_CALENDAR_UNAVAILABLE', message: BOOK_DATE_MESSAGES.unavailable });
    expect((await convRow(conv)).eventOrderRef).toBeNull();
    expect(await appEvents(conv)).toHaveLength(0);
    const again = await book('bdayA', conv, b);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(true);
  });

  it('an answer lost on the way back: the same press again links the one event the app made', async () => {
    const conv = await bday();
    const b = bodyOf();
    plan.push('lost_answer');
    expect((await book<Refusal>('bdayA', conv, b)).status).toBe(503);
    expect(await appEvents(conv)).toHaveLength(1);
    expect((await convRow(conv)).eventOrderRef).toBeNull();
    const again = await book('bdayA', conv, b);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(true);
    expect(await appEvents(conv)).toHaveLength(1);
    expect((await convRow(conv)).eventOrderRef).toBe(b.id);
  });
});

describe('Create BEO opens the event’s BEO form in the OTO App, and says so in the activity log', () => {
  const open = async <T = InboxOpenBeoResult>(who: string, conversationId: string): Promise<Res<T>> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/inbox/conversations/${conversationId}/open-beo`,
      headers: { cookie: cookies[who]! },
    });
    return { status: res.statusCode, body: res.json() as T, headers: res.headers };
  };
  const handoffRows = async (accountId: string) =>
    ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.actorAccountId, accountId), eq(s.auditLog.action, 'auth.handoff_issue')));

  it('a booked birthday: a one-use hand-off landing on its BEO, recorded naming the conversation and the event', async () => {
    const conv = await bday();
    const b = bodyOf();
    expect((await book('bdayA', conv, b)).status).toBe(200);
    const before = (await handoffRows(people.bdayA)).length;
    const res = await open('bdayA', conv);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(InboxOpenBeoResultSchema.safeParse(res.body).success).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ conversationId: conv, eventId: b.id, beoPath: `/studio/events/kanban?beo=${b.id}` });
    const url = new URL(res.body.launchUrl);
    expect(url.origin).toBe(OTO_APP_ORIGIN);
    expect(url.hash).toMatch(/^#handoff=[^&]+&to=/);
    expect(readHandoffTarget(url.hash)).toBe(res.body.beoPath);
    const rows = await handoffRows(people.bdayA);
    expect(rows).toHaveLength(before + 1);
    const row = rows.find((r) => (r.after as Record<string, unknown> | null)?.conversationId === conv);
    expect(row?.after).toMatchObject({ audience: 'oto_app', purpose: OPEN_BEO_PURPOSE, conversationId: conv, eventId: b.id });
    // The token is never on the record.
    const token = /^#handoff=([^&]+)/.exec(url.hash)![1]!;
    expect(JSON.stringify(row)).not.toContain(token);
    // A second press is a second one-use hand-off, never the first one again.
    const again = await open('bdayA', conv);
    expect(again.status).toBe(200);
    expect(again.body.launchUrl).not.toBe(res.body.launchUrl);
    expect(await handoffRows(people.bdayA)).toHaveLength(before + 2);
  });

  it('before Book Date there is no event to open', async () => {
    const conv = await bday();
    const res = await open<Refusal>('bdayA', conv);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'NO_EVENT_YET', message: BOOK_DATE_MESSAGES.noEventYet });
  });

  it('opening the OTO App needs app:oto_app:access; a conversation the caller cannot see is 404', async () => {
    const conv = await bday();
    expect((await book('bdayA', conv, bodyOf())).status).toBe(200);
    const gmBefore = (await handoffRows(people.gm)).length;
    expect((await open('gm', conv)).status).toBe(403);
    expect(await handoffRows(people.gm)).toHaveLength(gmBefore);
    expect((await open('recCentral', conv)).status).toBe(404);
  });
});

describe('the dashboard counts the week’s booked birthdays', () => {
  it('BEOs this week: birthday conversations whose event was booked since Monday, of those the viewer sees', async () => {
    // Last week's booking: a pill a minute before this week's Monday, Bangkok.
    const weekStart = inboxWeekStart(inboxToday(new Date()));
    const lastWeek = await bday();
    const lastWeekEvent = newId();
    await ctx.db.update(s.conversation).set({ eventOrderRef: lastWeekEvent }).where(eq(s.conversation.id, lastWeek));
    await ctx.db.insert(s.inboxEvent).values({
      id: newId(),
      operatorId: oto,
      conversationId: lastWeek,
      kind: 'date_booked',
      actorKind: 'account',
      actorAccountId: people.gm,
      payload: { eventId: lastWeekEvent, branchId: central, date: '2099-01-01' },
      createdAt: new Date(Date.parse(`${weekStart}T00:00:00+07:00`) - 60_000),
    });
    // This week's booking at a park the Central manager does not see.
    const atChalong = await bday();
    expect((await book('gm', atChalong, bodyOf())).status).toBe(200);
    await ctx.db.update(s.conversation).set({ branchId: chalong }).where(eq(s.conversation.id, atChalong));

    const linked = async (branchId?: string) =>
      (
        await ctx.db
          .select({ n: sql<number>`count(*)::int` })
          .from(s.conversation)
          .where(
            and(
              eq(s.conversation.operatorId, oto),
              sql`${s.conversation.eventOrderRef} is not null`,
              branchId ? eq(s.conversation.branchId, branchId) : undefined,
            ),
          )
      )[0]!.n;

    const res = await get<Record<string, unknown>>('gm', '/inbox/dashboard');
    expect(res.status).toBe(200);
    expect(InboxDashboardSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.weekStart).toBe(inboxWeekStart(res.body.day as string));
    // Every linked conversation but last week's.
    expect(res.body.beosThisWeek).toBe((await linked()) - 1);
    expect(res.body.beosThisWeek).toBeGreaterThanOrEqual(5);

    // The Central manager: Central's, last week's aside; never the one at Chalong.
    const mgr = await get<Record<string, unknown>>('mgrCentral', '/inbox/dashboard');
    expect(mgr.status).toBe(200);
    expect(mgr.body.beosThisWeek).toBe((await linked(central)) - 1);
    expect(mgr.body.beosThisWeek).toBeLessThan(res.body.beosThisWeek as number);

    // Reception sees no birthday thread at all.
    const rec = await get<Record<string, unknown>>('recCentral', '/inbox/dashboard');
    expect(rec.status).toBe(200);
    expect(rec.body.beosThisWeek).toBe(0);
  });

  it('the week starts on Monday, Bangkok day', () => {
    expect(inboxWeekStart('2026-11-04')).toBe('2026-11-02'); // a Wednesday
    expect(inboxWeekStart('2026-11-02')).toBe('2026-11-02'); // the Monday itself
    expect(inboxWeekStart('2026-11-08')).toBe('2026-11-02'); // the Sunday
    expect(inboxWeekStart('2026-01-01')).toBe('2025-12-29'); // across a year
  });
});

describe('the event title', () => {
  it('names the child and the age the Events module suggests, else the contact', () => {
    expect(eventTitleOf({ childName: 'Mali', childAge: 6, contactName: 'May' })).toBe("Mali's 6th Birthday");
    expect(eventTitleOf({ childName: 'Ben', childAge: 1, contactName: 'May' })).toBe("Ben's 1st Birthday");
    expect(eventTitleOf({ childName: 'Ben', childAge: 12, contactName: 'May' })).toBe("Ben's 12th Birthday");
    expect(eventTitleOf({ childName: 'Ben', childAge: 22, contactName: 'May' })).toBe("Ben's 22nd Birthday");
    expect(eventTitleOf({ childName: 'Ben', childAge: null, contactName: 'May' })).toBe("Ben's Birthday");
    expect(eventTitleOf({ childName: null, childAge: 5, contactName: 'May' })).toBe('Birthday · May');
  });
});
