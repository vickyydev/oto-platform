import { hash } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import type { SimulatedInbound } from '@oto/messaging';
import {
  INBOX_ERASED_CONTACT_NAME,
  INBOX_ERASE_CONFIRM_WORD,
  newId,
  type InboxContactCreated,
  type InboxContactView,
  type InboxConversationList,
  type InboxMe,
} from '@oto/shared';
import { INBOX_CONTACT_MESSAGES } from '../src/services/inbox/contacts';
import { SESSION_COOKIE, hashToken, newSessionToken } from '../src/plugins/session';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
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
 * SCRUM-860 — a contact made by staff, a contact's name set by staff (the
 * owner, 8 and 12 November 2026: "Allow users to create contacts and edit
 * contact names from the unified inbox").
 *
 * Contacts arrive the real way — a customer line played through the
 * simulator and the signed webhook — and are then named and made through
 * the routes:
 *
 *   gm           inbox_manager operator-wide
 *   recCentral   an agent at Reception · Central (the department grant)
 *   bdayA        a birthday agent (in no reception desk)
 *   counter      a till account with no inbox role
 *   secondAdmin  the other operator's administrator
 *   admin        the platform administrator (erasure)
 *
 * What it holds: the name staff set shows everywhere the list, the search
 * and the thread show a name; a later message's profile name never
 * overwrites it and is kept beside it; clearing returns to the profile
 * name; a staff-made contact has its thread, nothing is sent and no
 * assistant turn starts; a duplicate is refused naming the existing contact;
 * the customer's first message lands on the staff-made contact; the
 * permission is the reply permission, at the conversation; a replay under
 * the same key is the same answer; audit rows carry before and after; an
 * erased contact stays erased.
 */

const SECRET = 'inbox-contacts-test-secret';
const PASSWORD = 'inboxcontacts1234';
const GUEST_FROM = '66810005001';
const GUEST_PHONE = '+66810005001';
const GUEST_NAME = 'Contacts Guest';
const STAFF_NAME = 'ZZ TEST Khun Somchai';
const NEW_FROM = '66810005100';
const NEW_PHONE = '+66810005100';
const NEW_NAME = 'ZZ TEST New Contact';

let ctx: TestContext;
let oto: string;
let central: string;
let caCentral: string;
let consoleAccount: string;
let recCentralTeam: { id: string; departmentId: string; name: string };
const cookies: Record<string, string> = {};
const people = {} as Record<'gm' | 'recCentral' | 'bdayA', string>;
let guestConversation: string;
let guestContact: string;

type Res<T> = { status: number; body: T };
type Refusal = { error: { code: string; message: string; details?: Record<string, unknown> } };

async function call<T>(
  who: string,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
  key: string = newId(),
): Promise<Res<T>> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie: cookies[who]!, ...(method === 'GET' ? {} : { 'idempotency-key': key }) },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { status: res.statusCode, body: res.json() as T };
}

const contactUrl = (id: string) => `/inbox/conversations/${id}/contact`;
const rename = (who: string, id: string, displayName: string | null, key?: string) =>
  call<InboxContactView | Refusal>(who, 'PATCH', contactUrl(id), { displayName }, key);
const readContact = (who: string, id: string) => call<InboxContactView>(who, 'GET', contactUrl(id));
const create = (who: string, body: Record<string, unknown>, key?: string) =>
  call<InboxContactCreated | Refusal>(who, 'POST', '/inbox/contacts', body, key);
const list = (who: string, q?: string) =>
  call<InboxConversationList>(who, 'GET', `/inbox/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`);

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
  return { id: t!.id, departmentId: t!.departmentId!, name: t!.name };
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

/** A session minted straight into the table, as the actions test does for a department-scoped agent. */
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

async function contactRow(id: string) {
  const [c] = await ctx.db.select().from(s.contact).where(eq(s.contact.id, id)).limit(1);
  return c!;
}

async function convRow(id: string) {
  const [c] = await ctx.db.select().from(s.conversation).where(eq(s.conversation.id, id)).limit(1);
  return c!;
}

async function auditsOf(entityId: string, action: string) {
  return ctx.db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.entityId, entityId), eq(s.auditLog.action, action)))
    .orderBy(s.auditLog.createdAt);
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { INBOX_SIMULATOR: 'on', INBOX_SIMULATOR_SECRET: SECRET } });
  oto = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  recCentralTeam = await teamRow('reception', central);
  const birthdays = await teamRow('birthdays', null);

  people.gm = await staff('+66810005901', 'Contacts GM', 'inbox_manager', { scopeType: 'operator', scopeId: oto });
  people.recCentral = await staff('+66810005902', 'Contacts Reception Central', 'inbox_agent', {
    scopeType: 'department',
    scopeId: recCentralTeam.departmentId,
  });
  people.bdayA = await staff('+66810005903', 'Contacts Birthday A', 'inbox_agent', {
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
    externalId: 'contacts-wa-central',
    displayName: 'Contacts WhatsApp Central',
    defaultCategory: 'general',
    canReply: true,
    status: 'active',
  });
  consoleAccount = newId();
  await ctx.db.insert(s.channelAccount).values({
    id: consoleAccount,
    operatorId: oto,
    branchId: central,
    channel: 'line',
    provider: 'console',
    externalId: 'contacts-console-line',
    displayName: 'Contacts Console LINE',
    defaultCategory: 'general',
    canReply: false,
    status: 'active',
  });

  cookies.gm = await signInAs(ctx.app, '+66810005901', PASSWORD);
  for (const who of ['recCentral', 'bdayA'] as const) await session(who, people[who]);
  cookies.counter = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  cookies.secondAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  cookies.admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  guestConversation = await customerWrites({ from: GUEST_FROM, name: GUEST_NAME, text: 'hello, is the park open today?' });
  guestContact = (await convRow(guestConversation)).contactId;
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('the name staff set', () => {
  it('a contact arrives with the channel’s profile name, shown as the channel’s', async () => {
    const got = await readContact('recCentral', guestConversation);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({
      id: guestContact,
      channel: 'whatsapp',
      handle: GUEST_PHONE,
      displayName: GUEST_NAME,
      profileName: GUEST_NAME,
      nameSetByStaff: false,
      nameSetAt: null,
      erased: false,
    });
  });

  it('reception sets the name; the list, the search and the thread show it', async () => {
    const set = await rename('recCentral', guestConversation, `  ${STAFF_NAME}   `);
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ displayName: STAFF_NAME, profileName: GUEST_NAME, nameSetByStaff: true });
    expect((set.body as InboxContactView).nameSetAt).not.toBeNull();

    const rows = (await list('recCentral')).body.conversations;
    expect(rows.find((c) => c.id === guestConversation)?.contact.displayName).toBe(STAFF_NAME);
    const found = (await list('recCentral', 'ZZ TEST Khun')).body.conversations.map((c) => c.id);
    expect(found).toEqual([guestConversation]);
    const detail = await call<{ contact: { displayName: string } }>('gm', 'GET', `/inbox/conversations/${guestConversation}`);
    expect(detail.body.contact.displayName).toBe(STAFF_NAME);

    const row = await contactRow(guestContact);
    expect(row.nameSetByAccountId).toBe(people.recCentral);
  });

  it('a later message with another profile name never overwrites it; the newer profile name is kept beside it', async () => {
    const again = await customerWrites({ from: GUEST_FROM, name: 'Somchai J.', text: 'and on Sunday?' });
    expect(again).toBe(guestConversation);
    const got = await readContact('recCentral', guestConversation);
    expect(got.body).toMatchObject({ displayName: STAFF_NAME, profileName: 'Somchai J.', nameSetByStaff: true });
  });

  it('the same name again changes nothing and writes no second audit row', async () => {
    const before = (await auditsOf(guestContact, 'inbox.contact.rename')).length;
    const same = await rename('recCentral', guestConversation, STAFF_NAME);
    expect(same.status).toBe(200);
    expect((await auditsOf(guestContact, 'inbox.contact.rename')).length).toBe(before);
  });

  it('the same key replays the same answer; another body under the key is refused', async () => {
    const key = newId();
    const first = await rename('gm', guestConversation, 'ZZ TEST Replayed Name', key);
    const second = await rename('gm', guestConversation, 'ZZ TEST Replayed Name', key);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const rows = await auditsOf(guestContact, 'inbox.contact.rename');
    expect(rows.filter((r) => (r.after as { displayName: string }).displayName === 'ZZ TEST Replayed Name')).toHaveLength(1);
    const other = await rename('gm', guestConversation, 'ZZ TEST Other Name', key);
    expect(other.status).toBe(409);
    expect((other.body as Refusal).error.code).toBe('IDEMPOTENCY_MISMATCH');
    // Back to the reception's name for the cases below.
    expect((await rename('recCentral', guestConversation, STAFF_NAME)).status).toBe(200);
  });

  it('clearing (null, or blank) returns to the channel’s profile name; clearing an unset name changes nothing', async () => {
    const cleared = await rename('recCentral', guestConversation, '   ');
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ displayName: 'Somchai J.', profileName: 'Somchai J.', nameSetByStaff: false, nameSetAt: null });
    const rows = (await list('recCentral')).body.conversations;
    expect(rows.find((c) => c.id === guestConversation)?.contact.displayName).toBe('Somchai J.');

    const before = (await auditsOf(guestContact, 'inbox.contact.rename')).length;
    const again = await rename('recCentral', guestConversation, null);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ displayName: 'Somchai J.', nameSetByStaff: false });
    expect((await auditsOf(guestContact, 'inbox.contact.rename')).length).toBe(before);
  });

  it('audit rows carry before and after, the actor and the conversation', async () => {
    const rows = await auditsOf(guestContact, 'inbox.contact.rename');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const set = rows[0]!;
    expect(set.actorAccountId).toBe(people.recCentral);
    expect(set.entityType).toBe('inbox.contact');
    expect(set.operatorId).toBe(oto);
    expect(set.branchId).toBe(central);
    expect(set.before).toMatchObject({ displayName: GUEST_NAME, profileName: GUEST_NAME, nameSetByAccountId: null });
    expect(set.after).toMatchObject({ displayName: STAFF_NAME, nameSetByAccountId: people.recCentral, conversationId: guestConversation });
    const clear = rows.at(-1)!;
    expect(clear.before).toMatchObject({ displayName: STAFF_NAME, nameSetByAccountId: people.recCentral });
    expect(clear.after).toMatchObject({ displayName: 'Somchai J.', nameSetByAccountId: null, nameSetAt: null });
  });

  it('refused: a till account 403, another operator 404, a birthday agent who cannot see the desk’s thread 404', async () => {
    const counter = await rename('counter', guestConversation, 'ZZ TEST Counter');
    expect(counter.status).toBe(403);
    const other = await rename('secondAdmin', guestConversation, 'ZZ TEST Other Operator');
    expect(other.status).toBe(404);
    const bday = await rename('bdayA', guestConversation, 'ZZ TEST Birthday');
    expect(bday.status).toBe(404);
    expect((await readContact('bdayA', guestConversation)).status).toBe(404);
    expect((await contactRow(guestContact)).displayName).toBe('Somchai J.');
  });

  it('an erased contact cannot be named back into existence', async () => {
    expect((await rename('recCentral', guestConversation, STAFF_NAME)).status).toBe(200);
    const erase = await call<Record<string, unknown>>('admin', 'POST', `/inbox/contacts/${guestContact}/erase`, {
      confirmContactId: guestContact,
      confirm: INBOX_ERASE_CONFIRM_WORD,
    });
    expect(erase.status).toBe(200);
    const row = await contactRow(guestContact);
    expect(row.erasedAt).not.toBeNull();
    expect(row).toMatchObject({ displayName: INBOX_ERASED_CONTACT_NAME, profileName: null, nameSetByAccountId: null, nameSetAt: null });

    const back = await rename('gm', guestConversation, STAFF_NAME);
    expect(back.status).toBe(409);
    expect((back.body as Refusal).error).toMatchObject({ code: 'CONTACT_ERASED', message: INBOX_CONTACT_MESSAGES.erased });
    const got = await readContact('gm', guestConversation);
    expect(got.body).toMatchObject({ erased: true, displayName: INBOX_ERASED_CONTACT_NAME, profileName: null, nameSetByStaff: false });
    expect((await contactRow(guestContact)).displayName).toBe(INBOX_ERASED_CONTACT_NAME);
  });
});

describe('a contact made by staff', () => {
  let made: InboxContactCreated;

  it('/inbox/me lists the accounts a contact can be made on: those that carry a reply, never the console sender', async () => {
    const me = await call<InboxMe>('gm', 'GET', '/inbox/me');
    expect(me.status).toBe(200);
    const ids = (me.body.contactChannels ?? []).map((a) => a.id);
    expect(ids).toContain(caCentral);
    expect(ids).not.toContain(consoleAccount);
    expect(me.body.contactChannels?.find((a) => a.id === caCentral)).toEqual({
      id: caCentral,
      channel: 'whatsapp',
      displayName: 'Contacts WhatsApp Central',
      branchId: central,
    });
    const agent = await call<InboxMe>('recCentral', 'GET', '/inbox/me');
    expect(agent.body.contactChannels?.map((a) => a.id)).toContain(caCentral);
  });

  it('the GM makes a contact from a Thai local number: its thread exists, nothing is sent, no assistant turn starts', async () => {
    const res = await create('gm', { channelAccountId: caCentral, displayName: `  ${NEW_NAME}  `, identity: '081 000 5100' });
    expect(res.status).toBe(200);
    made = res.body as InboxContactCreated;
    expect(made.contact).toMatchObject({
      channel: 'whatsapp',
      handle: NEW_PHONE,
      displayName: NEW_NAME,
      phone: NEW_PHONE,
      profileName: null,
      nameSetByStaff: true,
      erased: false,
    });
    expect(made.visible).toBe(true);
    expect(made.teamName).toBe(recCentralTeam.name);

    const conv = await convRow(made.conversationId);
    expect(conv).toMatchObject({
      contactId: made.contact.id,
      channelAccountId: caCentral,
      teamId: recCentralTeam.id,
      branchId: central,
      category: 'general',
      status: 'active',
      lastRoutedAt: null,
      lastMessageAt: null,
      lastCustomerMessageAt: null,
    });
    const messages = await ctx.db.select().from(s.message).where(eq(s.message.conversationId, made.conversationId));
    expect(messages).toHaveLength(0);
    const turns = await ctx.db.select().from(s.aiTurn).where(eq(s.aiTurn.conversationId, made.conversationId));
    expect(turns).toHaveLength(0);
    const slots = await ctx.db.select().from(s.assignment).where(eq(s.assignment.conversationId, made.conversationId));
    expect(slots).toHaveLength(0);

    const created = await auditsOf(made.contact.id, 'inbox.contact.create');
    expect(created).toHaveLength(1);
    expect(created[0]!.actorAccountId).toBe(people.gm);
    expect(created[0]!.after).toMatchObject({ handle: NEW_PHONE, displayName: NEW_NAME, conversationId: made.conversationId, createdBy: 'staff' });
    const thread = await auditsOf(made.conversationId, 'inbox.conversation.create');
    expect(thread).toHaveLength(1);
    expect(thread[0]!.after).toMatchObject({ contactId: made.contact.id, createdBy: 'staff' });

    const rows = (await list('gm', 'ZZ TEST New')).body.conversations;
    expect(rows.map((c) => c.id)).toEqual([made.conversationId]);
    expect(rows[0]!.contact.displayName).toBe(NEW_NAME);
    expect(rows[0]!.unanswered).toBe(false);
    expect((await list('recCentral', 'ZZ TEST New')).body.conversations.map((c) => c.id)).toEqual([made.conversationId]);
  });

  it('the same number again — in another shape — is refused, naming the existing contact and its thread', async () => {
    const dup = await create('recCentral', { channelAccountId: caCentral, displayName: 'ZZ TEST Twice', identity: '+66 81 000 5100' });
    expect(dup.status).toBe(409);
    const { error } = dup.body as Refusal;
    expect(error.code).toBe('CONTACT_EXISTS');
    expect(error.message).toBe(INBOX_CONTACT_MESSAGES.exists(NEW_NAME, 'WhatsApp'));
    expect(error.details).toEqual({
      contactId: made.contact.id,
      displayName: NEW_NAME,
      handle: NEW_PHONE,
      conversationId: made.conversationId,
    });
    const contacts = await ctx.db.select().from(s.contact).where(and(eq(s.contact.operatorId, oto), eq(s.contact.externalHandle, NEW_PHONE)));
    expect(contacts).toHaveLength(1);
  });

  it('the customer’s first message lands on the staff-made contact and thread; the staff name stays, the profile name arrives', async () => {
    const id = await customerWrites({ from: NEW_FROM, name: 'Somchai WA', text: 'hi, do you have a party package?' });
    expect(id).toBe(made.conversationId);
    const got = await readContact('gm', made.conversationId);
    expect(got.body).toMatchObject({ id: made.contact.id, displayName: NEW_NAME, profileName: 'Somchai WA', nameSetByStaff: true });
    const conv = await convRow(made.conversationId);
    expect(conv.lastRoutedAt).not.toBeNull();
    expect(conv.lastCustomerMessageAt).not.toBeNull();
    const rows = (await list('gm', 'ZZ TEST New')).body.conversations;
    expect(rows.map((c) => c.id)).toEqual([made.conversationId]);
    expect(rows[0]!.contact.displayName).toBe(NEW_NAME);
    expect(rows[0]!.unanswered).toBe(true);
  });

  it('refused: a number the helper cannot read 400, the console sender 409, another operator’s account 404, a till account 403', async () => {
    const bad = await create('gm', { channelAccountId: caCentral, displayName: 'ZZ TEST Bad Number', identity: '12' });
    expect(bad.status).toBe(400);
    expect((bad.body as Refusal).error.message).toBe(INBOX_CONTACT_MESSAGES.invalidPhone);
    const console_ = await create('gm', { channelAccountId: consoleAccount, displayName: 'ZZ TEST Console', identity: '+66810005101' });
    expect(console_.status).toBe(409);
    expect((console_.body as Refusal).error.code).toBe('CHANNEL_CANNOT_CARRY_CONTACT');
    const other = await create('secondAdmin', { channelAccountId: caCentral, displayName: 'ZZ TEST Other', identity: '+66810005102' });
    expect(other.status).toBe(404);
    const counter = await create('counter', { channelAccountId: caCentral, displayName: 'ZZ TEST Counter', identity: '+66810005103' });
    expect(counter.status).toBe(403);
    const none = await ctx.db.select().from(s.contact).where(and(eq(s.contact.operatorId, oto), eq(s.contact.displayName, 'ZZ TEST Counter')));
    expect(none).toHaveLength(0);
  });

  it('the same key replays the same answer and makes one contact; another body under the key is refused', async () => {
    const key = newId();
    const body = { channelAccountId: caCentral, displayName: 'ZZ TEST Replayed Contact', identity: '0810005104' };
    const first = await create('gm', body, key);
    const second = await create('gm', body, key);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const contacts = await ctx.db.select().from(s.contact).where(and(eq(s.contact.operatorId, oto), eq(s.contact.externalHandle, '+66810005104')));
    expect(contacts).toHaveLength(1);
    const other = await create('gm', { ...body, displayName: 'ZZ TEST Changed Contact' }, key);
    expect(other.status).toBe(409);
    expect((other.body as Refusal).error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('a birthday agent may make one too; the desk’s thread is outside their view, and the answer says so', async () => {
    const res = await create('bdayA', { channelAccountId: caCentral, displayName: 'ZZ TEST Birthday Family', identity: '0810005105' });
    expect(res.status).toBe(200);
    const b = res.body as InboxContactCreated;
    expect(b.visible).toBe(false);
    expect(b.teamName).toBe(recCentralTeam.name);
    expect((await call('bdayA', 'GET', `/inbox/conversations/${b.conversationId}`)).status).toBe(404);
    expect((await call('recCentral', 'GET', `/inbox/conversations/${b.conversationId}`)).status).toBe(200);
  });

  it('the erased number can be a contact again; the erased one stays erased', async () => {
    const res = await create('gm', { channelAccountId: caCentral, displayName: 'ZZ TEST After Erasure', identity: GUEST_PHONE });
    expect(res.status).toBe(200);
    const again = res.body as InboxContactCreated;
    expect(again.contact.id).not.toBe(guestContact);
    expect(again.conversationId).not.toBe(guestConversation);
    const old = await contactRow(guestContact);
    expect(old.erasedAt).not.toBeNull();
    expect(old.displayName).toBe(INBOX_ERASED_CONTACT_NAME);
    expect(old.phone).toBeNull();
  });
});
