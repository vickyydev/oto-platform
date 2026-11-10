import { hash } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import type { SimulatedInbound } from '@oto/messaging';
import {
  InboxBeoConfirmationSchema,
  InboxOpenBeoResultSchema,
  newId,
  readHandoffTarget,
  type InboxBeoConfirmation,
  type InboxOpenBeoResult,
} from '@oto/shared';
import { SESSION_COOKIE, hashToken, newSessionToken } from '../src/plugins/session';
import {
  BEO_CONFIRMATION_MESSAGES,
  BEO_CONFIRMATION_SCAN,
  BEO_TRANSCRIPT_DAYS,
  BEO_TRANSCRIPT_LIMIT,
  carriesBirthdayDetails,
} from '../src/services/inbox/beo-confirmation';
import { OPEN_BEO_PURPOSE } from '../src/services/inbox/book-date';
import {
  CENTRAL_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-660 — the message a birthday's BEO is filled from
 * (`GET /inbox/conversations/{id}/beo-confirmation`), and Create BEO asking
 * the BEO form to run its AI Fill on it (`POST …/open-beo` with
 * `aiFill: true`).
 *
 * The OTO App asks for the message server to server, as the person who
 * pressed Create BEO; the inbox's own read permission and visibility decide.
 *
 *   the GM        inbox_manager operator-wide
 *   bdayA         an agent in Birthdays & Events (a department grant), who may
 *                 also open the OTO App
 *   recCentral    an agent at Reception · Central: cannot see a birthday
 *   nobody        a signed-in person with no inbox grant at all
 */

const SECRET = 'inbox-beo-confirmation-test-secret';
const PASSWORD = 'inboxbeoconfirm1234';
const OTO_APP_ORIGIN = 'https://otoapp.beo-confirmation.test';
const HANDOFF_KEY = 'k660:inbox-beo-confirmation-handoff-0123456789';

let ctx: TestContext;
let oto: string;
let central: string;
let caCentral: string;
const cookies: Record<string, string> = {};
const people = {} as Record<'gm' | 'bdayA' | 'recCentral' | 'nobody', string>;
let phoneSeq = 0;
let clock = Date.parse('2026-11-01T03:00:00Z');

// The three confirmations a manager sends.
const THAI =
  'ยืนยันงานวันเกิดน้องมะลิ วันเสาร์ที่ 21 มีนาคม เวลา 14.00-16.00 น. เด็ก 15 คน ผู้ใหญ่ 10 คน ' +
  'เมนูเด็ก: นักเก็ตไก่ เฟรนช์ฟรายส์ เค้กนำมาเอง พิธีกร: น้องนก';
const ENGLISH =
  "Confirming Emma's 6th birthday on Saturday 21 March, 14:00 to 16:00. 15 kids, 10 adults. " +
  'Kids menu: nuggets and fries. You bring your own cake. Your host will be Nok.';
const RUSSIAN =
  'Подтверждаем день рождения Маши 21 марта в 14:00. 15 детей, 10 взрослых. ' +
  'Детское меню: наггетсы и картофель фри. Свой торт. Аниматор: Нок.';

type Res<T> = { status: number; body: T };
type Refusal = { error: { code: string; message: string } };

async function read<T = InboxBeoConfirmation>(who: string | null, conversationId: string): Promise<Res<T>> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/inbox/conversations/${conversationId}/beo-confirmation`,
    headers: who ? { cookie: cookies[who]! } : {},
  });
  return { status: res.statusCode, body: res.json() as T };
}

async function staff(
  phone: string,
  name: string,
  roleName: 'inbox_agent' | 'inbox_manager' | null,
  scope: { scopeType: 'operator' | 'branch' | 'department'; scopeId: string } | null,
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
  if (roleName && scope) {
    const [role] = await ctx.db
      .select({ id: s.role.id })
      .from(s.role)
      .where(and(eq(s.role.operatorId, oto), eq(s.role.name, roleName)))
      .limit(1);
    await ctx.db.insert(s.roleAssignment).values({ id: newId(), accountId, roleId: role!.id, ...scope });
  }
  return accountId;
}

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

/** A conversation made the real way: a customer's first message through the simulator's signed webhook. */
async function thread(hint: SimulatedInbound['hint'], text: string): Promise<string> {
  phoneSeq += 1;
  const [row] = await ctx.db.select().from(s.channelAccount).where(eq(s.channelAccount.id, caCentral)).limit(1);
  const sim = ctx.app.inboxChannels.simulatorFor({ ...row! });
  if (!sim) throw new Error('simulator off');
  const played = sim.inbound({ from: `6681006${String(6000 + phoneSeq)}`, name: `BEO Guest ${phoneSeq}`, text, hint });
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

const bday = (text = 'Hi, a birthday for my son please') => thread({ category: 'birthdays', language: 'en' }, text);

/** One more message on the thread, a minute after the last. */
async function say(
  conversationId: string,
  body: string,
  over: Partial<typeof s.message.$inferInsert> = {},
): Promise<string> {
  clock += 60_000;
  const id = newId();
  const at = new Date(clock);
  await ctx.db.insert(s.message).values({
    id,
    operatorId: oto,
    conversationId,
    channelAccountId: caCentral,
    direction: 'outbound',
    authorKind: 'staff',
    authorAccountId: people.gm,
    body,
    providerStatus: 'sent',
    sentAt: at,
    createdAt: at,
    ...over,
  });
  return id;
}

async function auditCount(): Promise<number> {
  return (await ctx.db.select({ id: s.auditLog.id }).from(s.auditLog)).length;
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      INBOX_SIMULATOR: 'on',
      INBOX_SIMULATOR_SECRET: SECRET,
      HANDOFF_SIGNING_KEY: HANDOFF_KEY,
      HANDOFF_APP_ORIGINS: `oto_app=${OTO_APP_ORIGIN}`,
    },
  });
  oto = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const teamDept = async (key: 'birthdays' | 'reception', branchId: string | null) => {
    const [t] = await ctx.db
      .select()
      .from(s.team)
      .where(and(eq(s.team.operatorId, oto), eq(s.team.key, key), branchId === null ? isNull(s.team.branchId) : eq(s.team.branchId, branchId)))
      .limit(1);
    return t!.departmentId!;
  };
  const birthdays = await teamDept('birthdays', null);
  people.gm = await staff('+66810066601', 'BEO Confirm GM', 'inbox_manager', { scopeType: 'operator', scopeId: oto });
  people.bdayA = await staff('+66810066602', 'BEO Confirm Birthday A', 'inbox_agent', { scopeType: 'department', scopeId: birthdays });
  people.recCentral = await staff('+66810066603', 'BEO Confirm Reception', 'inbox_agent', {
    scopeType: 'department',
    scopeId: await teamDept('reception', central),
  });
  people.nobody = await staff('+66810066604', 'BEO Confirm Nobody', null, null);
  const otoAppRole = newId();
  await ctx.db.insert(s.role).values({ id: otoAppRole, operatorId: oto, name: 'beo_confirm_oto_app', description: 'Open the OTO App' });
  await ctx.db.insert(s.rolePermission).values({ id: newId(), roleId: otoAppRole, permission: 'app:oto_app:access' });
  await ctx.db.insert(s.roleAssignment).values({ id: newId(), accountId: people.bdayA, roleId: otoAppRole, scopeType: 'department', scopeId: birthdays });

  caCentral = newId();
  await ctx.db.insert(s.channelAccount).values({
    id: caCentral,
    operatorId: oto,
    branchId: central,
    channel: 'whatsapp',
    provider: 'simulator',
    externalId: 'beo-confirmation-wa-central',
    displayName: 'BEO Confirmation WhatsApp Central',
    defaultCategory: 'general',
    canReply: true,
    status: 'active',
  });
  cookies.gm = await signInAs(ctx.app, '+66810066601', PASSWORD);
  for (const who of ['bdayA', 'recCentral', 'nobody'] as const) await session(who, people[who]);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('which message carries the birthday details', () => {
  it('a final confirmation in Thai, English or Russian: a date, a time and one more party detail', () => {
    expect(carriesBirthdayDetails(THAI)).toBe(true);
    expect(carriesBirthdayDetails(ENGLISH)).toBe(true);
    expect(carriesBirthdayDetails(RUSSIAN)).toBe(true);
    expect(carriesBirthdayDetails('Booked: 21/03 at 2pm, 12 kids')).toBe(true);
    expect(carriesBirthdayDetails('2027-03-21 14:00 — Jungle package, pizza for the kids')).toBe(true);
    expect(carriesBirthdayDetails('วันอาทิตย์ บ่าย 2 โมง เด็ก 12 คน')).toBe(true);
  });

  it('a reminder, a quote or a greeting is passed over', () => {
    expect(carriesBirthdayDetails('Reminder: see you on 21 March at 14:00!')).toBe(false);
    expect(carriesBirthdayDetails('The Jungle package is 9,900 THB for up to 15 kids.')).toBe(false);
    expect(carriesBirthdayDetails('Hello! Thank you for your message, how can we help?')).toBe(false);
    expect(carriesBirthdayDetails('Call me on 081-234-5678 about the 15 kids')).toBe(false);
    // A time alone is not a date, nor a dotted time ("14.00 น.") one.
    expect(carriesBirthdayDetails('เวลา 14.00 น. เด็ก 15 คน')).toBe(false);
  });
});

describe('GET /inbox/conversations/{id}/beo-confirmation', () => {
  it("answers the newest team message that carries the details, in its own words", async () => {
    const conv = await bday('Можно день рождения на 21 марта в 14:00 для 15 детей?');
    await say(conv, 'Здравствуйте! Сейчас проверю.');
    const confirmed = await say(conv, RUSSIAN);
    // After it: a reminder (no detail), the customer's own details, a message the channel refused,
    // an erased one, and the assistant's line: none of them is the confirmation.
    await say(conv, 'Напоминаем: 21 марта в 14:00!');
    await say(conv, 'Yes 21 марта 14:00, 15 детей, торт свой', { direction: 'inbound', authorKind: 'customer', authorAccountId: null, providerStatus: null, sentAt: null });
    await say(conv, `${RUSSIAN} (refused)`, { providerStatus: 'failed' });
    await say(conv, `${ENGLISH} (erased)`, { redactedAt: new Date(), body: null });
    await say(conv, ENGLISH, { authorKind: 'ai', authorAccountId: null });
    const res = await read('gm', conv);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(InboxBeoConfirmationSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({
      conversationId: conv,
      eventId: null,
      message: { id: confirmed, body: RUSSIAN, authorName: 'BEO Confirm GM' },
    });
    expect(res.body.message?.sentAt).toEqual(expect.any(String));
    // The team's own messages only were looked at: the greeting, the confirmation, the reminder
    // (the refused one and the assistant's are not the team's received messages).
    expect(res.body.scanned).toBe(3);
  });

  it('the newest of two confirmations wins, and the event Book Date made is named', async () => {
    const conv = await bday();
    await say(conv, THAI);
    const newer = await say(conv, ENGLISH);
    const eventId = newId();
    await ctx.db.update(s.conversation).set({ eventOrderRef: eventId }).where(eq(s.conversation.id, conv));
    const res = await read('bdayA', conv);
    expect(res.status).toBe(200);
    expect(res.body.message?.id).toBe(newer);
    expect(res.body.eventId).toBe(eventId);
  });

  it('a queued team message counts: it is on its way to the family', async () => {
    const conv = await bday();
    const queued = await say(conv, THAI, { providerStatus: 'queued', sentAt: null });
    const res = await read('gm', conv);
    expect(res.body.message).toMatchObject({ id: queued, sentAt: null });
  });

  it('no confirmation yet: message is null', async () => {
    const conv = await bday('Hi, can we book 21 March at 14:00 for 15 kids?');
    await say(conv, 'Hello! Which park would you like?');
    const res = await read('gm', conv);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ conversationId: conv, message: null, scanned: 1 });
  });

  it(`looks at the team's newest ${BEO_CONFIRMATION_SCAN} messages only`, async () => {
    const conv = await bday();
    await say(conv, ENGLISH);
    for (let i = 0; i < BEO_CONFIRMATION_SCAN; i += 1) await say(conv, `Noted, thank you (${i})`);
    const res = await read('gm', conv);
    expect(res.body).toMatchObject({ message: null, scanned: BEO_CONFIRMATION_SCAN });
  });

  it('outside Birthdays & Events: 409 NOT_A_BIRTHDAY', async () => {
    const conv = await thread({ category: 'general', language: 'en' }, 'What time do you open?');
    await say(conv, ENGLISH);
    const res = await read<Refusal>('gm', conv);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'NOT_A_BIRTHDAY', message: BEO_CONFIRMATION_MESSAGES.notABirthday });
  });

  it("the inbox's own permission decides: no session 401, no inbox grant 403, a conversation out of sight 404", async () => {
    const conv = await bday();
    await say(conv, ENGLISH);
    expect((await read(null, conv)).status).toBe(401);
    expect((await read('nobody', conv)).status).toBe(403);
    const unseen = await read<Refusal>('recCentral', conv);
    expect(unseen.status).toBe(404);
    expect(JSON.stringify(unseen.body)).not.toContain('Nok');
    expect((await read('gm', newId())).status).toBe(404);
    // The birthdays team sees its own conversation.
    expect((await read('bdayA', conv)).status).toBe(200);
  });

  it('is a read: nothing is written', async () => {
    const conv = await bday();
    await say(conv, ENGLISH);
    const before = await auditCount();
    expect((await read('gm', conv)).status).toBe(200);
    expect(await auditCount()).toBe(before);
  });
});

describe('SCRUM-815: the conversation the fill reads (transcript)', () => {
  /**
   * A birthday thread whose first line (the simulator's, written at the real
   * time) comes before every line said on it afterwards.
   */
  const freshBday = async (text?: string) => {
    const id = await bday(text);
    clock = Math.max(clock, Date.now() + 1_000);
    return id;
  };

  it("is the family's lines and the team's, oldest first, each in its own words and time", async () => {
    const conv = await freshBday('Здравствуйте! Хотим день рождения 21 марта, пакет Флореста, пиццу Маргарита');
    const team = await say(conv, 'Здравствуйте! Да, 21 марта свободно.');
    const family = await say(conv, 'И ещё бабл-шоу, если можно', {
      direction: 'inbound', authorKind: 'customer', authorAccountId: null, providerStatus: null, sentAt: null,
    });
    const ruling = await say(conv, RUSSIAN);
    const res = await read('gm', conv);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(InboxBeoConfirmationSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.message?.id).toBe(ruling);
    const lines = res.body.transcript;
    // The first line is the family's first message, which the simulator wrote.
    expect(lines.map((l) => l.author)).toEqual(['customer', 'staff', 'customer', 'staff']);
    expect(lines[0]!.text).toBe('Здравствуйте! Хотим день рождения 21 марта, пакет Флореста, пиццу Маргарита');
    expect(lines.slice(1).map((l) => l.id)).toEqual([team, family, ruling]);
    expect(lines[2]).toMatchObject({ author: 'customer', text: 'И ещё бабл-шоу, если можно' });
    expect(lines[3]).toMatchObject({ author: 'staff', text: RUSSIAN });
    // Oldest first, each with its time.
    const times = lines.map((l) => Date.parse(l.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(res.body.transcriptCut).toBe(false);
  });

  it("leaves out the assistant's, system notices, erased lines and lines the channel refused", async () => {
    const conv = await freshBday('Hi, a birthday on 21 March please');
    const kept = await say(conv, 'Kept: the team');
    await say(conv, 'AI-LINE-815', { authorKind: 'ai', authorAccountId: null });
    await say(conv, 'SYSTEM-LINE-815', { authorKind: 'system', authorAccountId: null });
    await say(conv, 'FAILED-LINE-815', { providerStatus: 'failed' });
    await say(conv, 'WITHDRAWN-LINE-815', { providerStatus: 'withdrawn' });
    await say(conv, 'ERASED-TEAM-815', { redactedAt: new Date(), body: null });
    await say(conv, 'ERASED-CUSTOMER-815', {
      direction: 'inbound', authorKind: 'customer', authorAccountId: null, providerStatus: null, redactedAt: new Date(),
    });
    // A voice note: no body, its transcript is what the family said.
    const voice = await say(conv, 'unused', {
      direction: 'inbound', authorKind: 'customer', authorAccountId: null, providerStatus: null, body: null,
      transcript: 'VOICE-TRANSCRIPT-815 pizza please',
    });
    const res = await read('gm', conv);
    expect(res.status).toBe(200);
    const all = JSON.stringify(res.body.transcript);
    for (const gone of ['AI-LINE-815', 'SYSTEM-LINE-815', 'FAILED-LINE-815', 'WITHDRAWN-LINE-815', 'ERASED-CUSTOMER-815']) {
      expect(all).not.toContain(gone);
    }
    expect(res.body.transcript.map((l) => l.id).slice(1)).toEqual([kept, voice]);
    // SCRUM-824: marked as spoken, so the fill's model knows it was a voice note.
    expect(res.body.transcript.at(-1)).toMatchObject({ author: 'customer', text: '[voice note] VOICE-TRANSCRIPT-815 pizza please' });
  });

  it(`is bounded: the newest ${BEO_TRANSCRIPT_LIMIT} lines, none older than ${BEO_TRANSCRIPT_DAYS} days before the newest`, async () => {
    const many = await freshBday('OLDEST-LINE-815');
    for (let i = 0; i < BEO_TRANSCRIPT_LIMIT; i += 1) await say(many, `line ${i}`);
    const cut = await read('gm', many);
    expect(cut.body.transcript).toHaveLength(BEO_TRANSCRIPT_LIMIT);
    expect(cut.body.transcriptCut).toBe(true);
    expect(JSON.stringify(cut.body.transcript)).not.toContain('OLDEST-LINE-815');
    expect(cut.body.transcript.at(-1)!.text).toBe(`line ${BEO_TRANSCRIPT_LIMIT - 1}`);

    const old = await freshBday('Hi');
    // A line from long before the conversation's newest: out of the window.
    const longAgo = new Date(clock - (BEO_TRANSCRIPT_DAYS + 1) * 86_400_000);
    await say(old, 'OLD-LINE-815', { createdAt: longAgo, sentAt: longAgo });
    const recent = await say(old, 'Recent line');
    const res = await read('gm', old);
    expect(JSON.stringify(res.body.transcript)).not.toContain('OLD-LINE-815');
    expect(res.body.transcript.at(-1)!.id).toBe(recent);
    expect(res.body.transcriptCut).toBe(true);
  });

  it('is read under the same visibility: out of sight 404, outside Birthdays & Events 409, and nothing leaks', async () => {
    const conv = await freshBday('SECRET-FAMILY-LINE-815');
    await say(conv, ENGLISH);
    const unseen = await read<Refusal>('recCentral', conv);
    expect(unseen.status).toBe(404);
    expect(JSON.stringify(unseen.body)).not.toContain('SECRET-FAMILY-LINE-815');
    expect((await read('nobody', conv)).status).toBe(403);
    const general = await thread({ category: 'general', language: 'en' }, 'GENERAL-LINE-815');
    const refused = await read<Refusal>('gm', general);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).not.toContain('GENERAL-LINE-815');
    // The birthdays team sees it, whole.
    const seen = await read('bdayA', conv);
    expect(seen.status).toBe(200);
    expect(seen.body.transcript[0]!.text).toBe('SECRET-FAMILY-LINE-815');
  });

  it('a conversation with no confirmation yet still carries its lines', async () => {
    const conv = await freshBday('Can we book 21 March at 14:00 for 15 kids?');
    await say(conv, 'Hello! Which park would you like?');
    const res = await read('gm', conv);
    expect(res.body.message).toBeNull();
    expect(res.body.transcript.map((l) => l.author)).toEqual(['customer', 'staff']);
  });
});

describe('Create BEO asks the BEO form to run its AI Fill', () => {
  const open = async (who: string, conversationId: string, payload?: unknown): Promise<Res<InboxOpenBeoResult>> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/inbox/conversations/${conversationId}/open-beo`,
      headers: { cookie: cookies[who]! },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: res.statusCode, body: res.json() as InboxOpenBeoResult };
  };

  it('aiFill: true lands on the form with fill=inbox, and the hand-off record says so; the message never rides it', async () => {
    const conv = await bday();
    await say(conv, ENGLISH);
    const eventId = newId();
    await ctx.db.update(s.conversation).set({ eventOrderRef: eventId }).where(eq(s.conversation.id, conv));
    const res = await open('bdayA', conv, { aiFill: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(InboxOpenBeoResultSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.beoPath).toBe(`/studio/events/kanban?beo=${eventId}&fill=inbox`);
    const url = new URL(res.body.launchUrl);
    expect(readHandoffTarget(url.hash)).toBe(res.body.beoPath);
    expect(res.body.launchUrl).not.toContain('Nok');
    expect(decodeURIComponent(res.body.launchUrl)).not.toContain('Emma');
    const rows = await ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.actorAccountId, people.bdayA), eq(s.auditLog.action, 'auth.handoff_issue')));
    const mine = rows.find((r) => (r.after as Record<string, unknown> | null)?.conversationId === conv);
    expect(JSON.stringify(mine)).not.toContain('Emma');
    expect(mine?.after).toMatchObject({ purpose: OPEN_BEO_PURPOSE, conversationId: conv, eventId, fill: 'inbox' });
  });

  it('without it (the event chip) the form opens as before', async () => {
    const conv = await bday();
    const eventId = newId();
    await ctx.db.update(s.conversation).set({ eventOrderRef: eventId }).where(eq(s.conversation.id, conv));
    for (const payload of [undefined, {}, { aiFill: false }]) {
      const res = await open('bdayA', conv, payload);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.beoPath).toBe(`/studio/events/kanban?beo=${eventId}`);
    }
  });

  it('a body with anything else is refused', async () => {
    const conv = await bday();
    await ctx.db.update(s.conversation).set({ eventOrderRef: newId() }).where(eq(s.conversation.id, conv));
    expect((await open('bdayA', conv, { aiFill: true, text: ENGLISH })).status).toBe(400);
    expect((await open('bdayA', conv, { aiFill: 'yes' })).status).toBe(400);
  });
});
