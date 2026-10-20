import { hash } from '@node-rs/argon2';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INBOX_TEMPLATE_KEYS, schema as s } from '@oto/db';
import type { RawWebhook, SimulatorChannel } from '@oto/messaging';
import {
  INBOX_TEMPLATE_KEY_NAMES,
  newId,
  renderTemplate,
  templateParameters,
  templateVariables,
  type InboxManagedTemplate,
  type InboxReply,
} from '@oto/shared';
import { SESSION_COOKIE, hashToken, newSessionToken } from '../src/plugins/session';
import type { FileStorage } from '../src/services/files';
import { buildDefaultJobs } from '../src/services/jobs';
import {
  INBOX_SEND_INTERVAL_S,
  INBOX_SEND_JOB,
  SEND_MAX_ATTEMPTS,
  runInboxSendJob,
  sendBackoffMs,
  sendQueuedMessage,
} from '../src/services/inbox/send';
import {
  ADMIN,
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
 * S2-19 I2f (SCRUM-585) — the Inbox's reply, templates and sending (plan
 * `docs/progress/plans/inbox-build/PLAN.md` §3.3, §3.5, §3.6 "Files", §6 "I2").
 *
 * What it holds:
 *   - a reply inside the 24-hour window goes as free text, through the
 *     simulator, and the provider's acknowledgement moves it to sent, then
 *     delivered and read; the thread is answered by its timestamps;
 *   - outside the window free text is refused in plain words with the
 *     templates that qualify, and a qualifying template is accepted;
 *   - template management: create, the same id again, a taken variant, edit,
 *     deactivate, archive — and who may (the template's own scope);
 *   - the send job resends QUEUED messages only — a sent message is never sent
 *     again — backs off on a retryable refusal, and a terminal refusal is
 *     marked failed and shown on the thread's timeline as an event;
 *   - inbound media are fetched through the channel, stored as
 *     `core.file_object`, and a signed URL is issued only to a caller who can
 *     see the conversation;
 *   - no message body reaches an audit row, a timeline event or an ops row.
 */

const SECRET = 'inbox-reply-test-secret';
const SENTINEL = 'SENTINEL-f00d-reply-never-outside-the-message-table';
const PASSWORD = 'inboxreply1234';

let ctx: TestContext;
let oto: string;
let central: string;
let chalong: string;
let caCentral: string;
let caConsole: string;
const cookies: Record<string, string> = {};
const puts: Array<{ objectKey: string; size: number; contentType: string }> = [];

const fakeStorage: FileStorage = {
  bucket: 'oto-files-test',
  presignedPut: async (objectKey) => `memory://oto-files-test/${objectKey}`,
  presignedGet: async (objectKey) => `memory://oto-files-test/${objectKey}?get`,
  put: async (objectKey, bytes, contentType) => {
    puts.push({ objectKey, size: bytes.length, contentType });
  },
  remove: async () => {},
  probe: async () => ({ state: 'ready' }),
};

async function call<T>(
  who: string,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie: cookies[who]!, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }), ...headers },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
}

async function staff(
  phone: string,
  name: string,
  roleName: string,
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

/** A session minted into the table: a department-scoped grant cannot be seated by sign-in (raised on SCRUM-581). */
async function session(who: string, accountId: string): Promise<void> {
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

async function teamOf(key: 'birthdays' | 'reception' | 'marketing', branchId: string | null = null) {
  const [t] = await ctx.db
    .select()
    .from(s.team)
    .where(
      and(eq(s.team.operatorId, oto), eq(s.team.key, key), branchId === null ? isNull(s.team.branchId) : eq(s.team.branchId, branchId)),
    )
    .limit(1);
  return t!;
}

async function sim(): Promise<SimulatorChannel> {
  const [row] = await ctx.db.select().from(s.channelAccount).where(eq(s.channelAccount.id, caCentral)).limit(1);
  const found = ctx.app.inboxChannels.simulatorFor({ ...row! });
  if (!found) throw new Error('simulator off');
  return found;
}

async function deliver(webhook: RawWebhook): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/webhooks/inbox/${caCentral}`,
    headers: webhook.headers as Record<string, string>,
    payload: typeof webhook.rawBody === 'string' ? webhook.rawBody : Buffer.from(webhook.rawBody),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { outcome: string }).outcome;
}

/** A customer writes in on the central simulator number; answers their thread. */
async function customer(from: string, text: string, name = 'Reply Test Guest') {
  const played = (await sim()).inbound({ from, name, text });
  expect(await deliver(played.webhook)).toBe('processed');
  const [row] = await ctx.db
    .select({ conv: s.conversation })
    .from(s.conversation)
    .innerJoin(s.contact, eq(s.contact.id, s.conversation.contactId))
    .where(and(eq(s.conversation.channelAccountId, caCentral), eq(s.contact.externalHandle, `+${from}`)))
    .limit(1);
  return row!.conv;
}

async function conversation(id: string) {
  const [row] = await ctx.db.select().from(s.conversation).where(eq(s.conversation.id, id)).limit(1);
  return row!;
}

async function messageRow(id: string) {
  const [row] = await ctx.db.select().from(s.message).where(eq(s.message.id, id)).limit(1);
  return row!;
}

async function templateId(key: string, language = 'en'): Promise<string> {
  const [row] = await ctx.db
    .select({ id: s.template.id })
    .from(s.template)
    .where(
      and(
        eq(s.template.operatorId, oto),
        eq(s.template.key, key as never),
        eq(s.template.language, language),
        isNull(s.template.channel),
        isNull(s.template.branchId),
        isNull(s.template.archivedAt),
      ),
    )
    .limit(1);
  return row!.id;
}

const reply = (who: string, conversationId: string, payload: Record<string, unknown>) =>
  call<InboxReply & { error?: { code: string; message: string; details?: Record<string, unknown> } }>(
    who,
    'POST',
    `/inbox/conversations/${conversationId}/messages`,
    payload,
  );

const sendDeps = () => ({ channels: ctx.app.inboxChannels, log: ctx.app.log });

beforeAll(async () => {
  ctx = await createTestContext({ env: { INBOX_SIMULATOR: 'on', INBOX_SIMULATOR_SECRET: SECRET } });
  (ctx.app as unknown as { fileStorage: FileStorage }).fileStorage = fakeStorage;
  oto = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);

  caCentral = newId();
  await ctx.db.insert(s.channelAccount).values({
    id: caCentral,
    operatorId: oto,
    branchId: central,
    channel: 'whatsapp',
    provider: 'simulator',
    externalId: 'reply-test-wa-central',
    displayName: 'Reply Test Central',
    defaultCategory: 'general',
    canReply: true,
    status: 'active',
  });
  const [consoleRow] = await ctx.db
    .select({ id: s.channelAccount.id })
    .from(s.channelAccount)
    .where(and(eq(s.channelAccount.operatorId, oto), eq(s.channelAccount.provider, 'console')))
    .limit(1);
  caConsole = consoleRow!.id;

  // The Reception · Central desk: an agent of the team every general enquiry at Central routes to.
  const receptionCentral = await teamOf('reception', central);
  await session('agent', await staff('+66810007001', 'Reply Test Agent', 'inbox_agent', { scopeType: 'department', scopeId: receptionCentral.departmentId! }));
  // Marketing's agent: reads and replies, but in another team.
  const marketing = await teamOf('marketing');
  await session('otherTeam', await staff('+66810007002', 'Reply Test Marketing', 'inbox_agent', { scopeType: 'department', scopeId: marketing.departmentId! }));
  // A reader who may not reply: an operator role of read alone, at Central's desk.
  const readerRole = newId();
  await ctx.db.insert(s.role).values({ id: readerRole, operatorId: oto, name: 'inbox_reader_test', description: 'read only' });
  for (const permission of ['app:inbox:access', 'inbox:conversation:read']) {
    await ctx.db.insert(s.rolePermission).values({ id: newId(), roleId: readerRole, permission });
  }
  await session('reader', await staff('+66810007003', 'Reply Test Reader', 'inbox_reader_test', { scopeType: 'department', scopeId: receptionCentral.departmentId! }));
  // A branch manager at Chalong: manages that park's templates, not the operator's.
  cookies['chalongManager'] = '';
  await staff('+66810007004', 'Reply Test Chalong Manager', 'inbox_manager', { scopeType: 'branch', scopeId: chalong });
  cookies['chalongManager'] = await signInAs(ctx.app, '+66810007004', PASSWORD);

  cookies['admin'] = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  cookies['counter'] = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  cookies['secondAdmin'] = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('the shared template rules (I2f)', () => {
  it('names the same eight keys as the database CHECK', () => {
    expect([...INBOX_TEMPLATE_KEY_NAMES]).toEqual([...INBOX_TEMPLATE_KEYS]);
  });

  it('renders {{name}} placeholders, reports the missing, and reads the parameters back', () => {
    const body = 'Hi {{name}}, your party on {{1}} is booked, {{name}}!';
    expect(templateVariables(body)).toEqual(['name', '1']);
    expect(renderTemplate(body, { name: 'Mai' }).missing).toEqual(['1']);
    const done = renderTemplate(body, { name: 'Mai', '1': '3 Nov' });
    expect(done).toEqual({ text: 'Hi Mai, your party on 3 Nov is booked, Mai!', missing: [], parameters: ['Mai', '3 Nov', 'Mai'] });
    expect(templateParameters(body, done.text)).toEqual(['Mai', '3 Nov', 'Mai']);
    expect(templateParameters(body, 'something else')).toBeNull();
    // A value is never read as a placeholder or a replacement pattern.
    expect(renderTemplate('A {{x}}', { x: '{{x}} $& $1' }).text).toBe('A {{x}} $& $1');
  });
});

describe('the write switch (I2f)', () => {
  it('GET /inbox/me says writes are on', async () => {
    const me = await call<{ capabilities: { writes: boolean } }>('admin', 'GET', '/inbox/me');
    expect(me.status).toBe(200);
    expect(me.body.capabilities.writes).toBe(true);
  });
});

describe('a reply inside the 24-hour window (I2f)', () => {
  it('goes as free text through the simulator, is acknowledged sent, then delivered and read; the thread is answered', async () => {
    const conv = await customer('66810007101', 'Is the park open on Sunday?');
    expect(conv.lastStaffMessageAt).toBeNull();
    const id = newId();
    const res = await reply('agent', conv.id, { id, text: `Yes, 10:00 to 20:00. ${SENTINEL}` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.window.open).toBe(true);
    expect(res.body.refusal).toBeNull();
    expect(res.body.message).toMatchObject({ id, direction: 'outbound', authorKind: 'staff', providerStatus: 'sent', authorName: 'Reply Test Agent' });

    const row = await messageRow(id);
    expect(row.externalMessageId).toMatch(/^wamid\.SIM\..+\.OUT\./);
    expect(row.sendAttempts).toBe(1);
    expect(row.sentAt).not.toBeNull();
    const sent = (await sim()).sent().filter((x) => x.clientRef === id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe('text');

    const after = await conversation(conv.id);
    expect(after.lastStaffMessageAt).not.toBeNull();
    expect(after.firstResponseAt).not.toBeNull();
    const list = await call<{ conversations: Array<{ id: string; unanswered: boolean }> }>('agent', 'GET', '/inbox/conversations?tab=team');
    expect(list.body.conversations.find((c) => c.id === conv.id)?.unanswered).toBe(false);

    // The simulator scheduled delivered and read: pushed through the real webhook.
    const pushed = await call<{ deliveries: Array<{ outcome: string }> }>('admin', 'POST', '/inbox/simulator/status', { channelAccountId: caCentral });
    expect(pushed.status).toBe(200);
    const read = await messageRow(id);
    expect(read.providerStatus).toBe('read');
    expect(read.deliveredAt).not.toBeNull();
    expect(read.readAt).not.toBeNull();
  });

  it('the same body id again is the same message: answered as it stands, never sent twice', async () => {
    const conv = await customer('66810007102', 'Do you sell socks?');
    const id = newId();
    const first = await reply('agent', conv.id, { id, text: 'Yes, at reception.' });
    expect(first.status).toBe(200);
    const again = await reply('agent', conv.id, { id, text: 'Yes, at reception.' });
    expect(again.status).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.body.message.id).toBe(id);
    expect((await sim()).sent().filter((x) => x.clientRef === id)).toHaveLength(1);
    const rows = await ctx.db.select().from(s.message).where(eq(s.message.id, id));
    expect(rows).toHaveLength(1);
    // Another conversation's message id is not this reply's to reuse.
    const other = await customer('66810007103', 'Hello');
    const clash = await reply('agent', other.id, { id, text: 'Hello' });
    expect(clash.status).toBe(409);
    expect(clash.body.error!.code).toBe('ID_IN_USE');
  });
});

describe('outside the 24-hour window (I2f)', () => {
  it('free text is refused in plain words with the templates that qualify; a template is then accepted', async () => {
    const conv = await customer('66810007201', 'Birthday party prices?');
    const longAgo = new Date(Date.now() - 25 * 3_600_000);
    await ctx.db.update(s.conversation).set({ lastCustomerMessageAt: longAgo }).where(eq(s.conversation.id, conv.id));

    // As a deployed operator may still stand (SCRUM-220 test night): a Thai
    // row that carries the English source, marked for translation. The
    // composer must be able to mark it in the refusal's list.
    const thaiOutOfHours = and(eq(s.template.key, 'out_of_hours'), eq(s.template.language, 'th'), isNull(s.template.channel), isNull(s.template.branchId));
    const [thRow] = await ctx.db.select({ id: s.template.id, body: s.template.body }).from(s.template).where(thaiOutOfHours).limit(1);
    await ctx.db.update(s.template).set({ body: 'Thanks for your message! We are closed right now.', needsTranslation: true }).where(thaiOutOfHours);

    const refused = await reply('agent', conv.id, { text: 'Sorry for the late answer!' });
    expect(refused.status).toBe(409);
    expect(refused.body.error!.code).toBe('TEMPLATE_REQUIRED');
    expect(refused.body.error!.message).toMatch(/more than 24 hours ago, so only a template can be sent/);
    const details = refused.body.error!.details as {
      window: { open: boolean; hours: number; closesAt: string };
      qualifyingTemplates: Array<{
        id: string;
        key: string;
        language: string;
        approvalStatus: string;
        needsTranslation: boolean;
        variables: string[];
      }>;
    };
    expect(details.window).toMatchObject({ open: false, hours: 24 });
    expect(new Date(details.window.closesAt).getTime()).toBe(longAgo.getTime() + 24 * 3_600_000);
    expect(details.qualifyingTemplates.length).toBeGreaterThan(0);
    expect(details.qualifyingTemplates.every((t) => ['approved', 'not_required'].includes(t.approvalStatus))).toBe(true);
    expect(details.qualifyingTemplates.map((t) => t.key)).toContain('welcome');
    // Every row says its key and whether it still waits for a translator: the flagged Thai row does, the rest do not.
    expect(details.qualifyingTemplates.every((t) => typeof t.key === 'string' && typeof t.needsTranslation === 'boolean')).toBe(true);
    const flagged = details.qualifyingTemplates.filter((t) => t.needsTranslation);
    expect(flagged.map((t) => t.id)).toContain(thRow!.id);
    expect(flagged.map((t) => [t.key, t.language])).toEqual([['out_of_hours', 'th']]);
    expect(details.qualifyingTemplates.find((t) => t.key === 'welcome' && t.language === 'en')).toMatchObject({ needsTranslation: false });
    // The fixture back: the Thai row in its own words.
    await ctx.db.update(s.template).set({ body: thRow!.body, needsTranslation: false }).where(thaiOutOfHours);
    // Nothing was written by the refusal.
    expect(await ctx.db.select().from(s.message).where(and(eq(s.message.conversationId, conv.id), eq(s.message.direction, 'outbound')))).toHaveLength(0);

    const welcome = await templateId('welcome');
    const ok = await reply('agent', conv.id, { templateId: welcome });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.message).toMatchObject({ providerStatus: 'sent', templateId: welcome, bodyLanguage: 'en' });
    const sent = (await sim()).sent().filter((x) => x.clientRef === ok.body.message.id);
    expect(sent[0]!.kind).toBe('template');
  });

  it('a customer who never wrote is outside every window; a pending template may not open it', async () => {
    const conv = await customer('66810007202', 'hi');
    await ctx.db.update(s.conversation).set({ lastCustomerMessageAt: null }).where(eq(s.conversation.id, conv.id));
    const refused = await reply('agent', conv.id, { text: 'Hello!' });
    expect(refused.status).toBe(409);
    expect(refused.body.error!.message).toMatch(/has not written on this channel yet/);

    const pending = await call<InboxManagedTemplate>('admin', 'POST', '/inbox/templates', {
      key: 'handover_events',
      language: 'en',
      channel: 'whatsapp',
      body: 'Our events team will write to you, {{name}}.',
      providerTemplateName: 'events_handover',
      approvalStatus: 'pending',
    });
    expect(pending.status, JSON.stringify(pending.body)).toBe(200);
    const notApproved = await reply('agent', conv.id, { templateId: pending.body.id, variables: { name: 'Ann' } });
    expect(notApproved.status).toBe(409);
    expect(notApproved.body.error!.code).toBe('TEMPLATE_NOT_APPROVED');
    expect((notApproved.body.error!.details as { qualifyingTemplates: Array<{ id: string }> }).qualifyingTemplates.map((t) => t.id)).not.toContain(pending.body.id);

    // Approved: it opens the window, its values going as body parameters.
    expect((await call('admin', 'PATCH', `/inbox/templates/${pending.body.id}`, { approvalStatus: 'approved' })).status).toBe(200);
    const missing = await reply('agent', conv.id, { templateId: pending.body.id });
    expect(missing.status).toBe(400);
    expect(missing.body.error!.message).toMatch(/Fill in the template's name/);
    const ok = await reply('agent', conv.id, { templateId: pending.body.id, variables: { name: 'Ann' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.message.body).toBe('Our events team will write to you, Ann.');
    expect(ok.body.message.providerStatus).toBe('sent');
  });
});

describe('what a reply is refused (I2f)', () => {
  it('a handled thread: reopen it to reply', async () => {
    const conv = await customer('66810007301', 'Thanks, all sorted');
    await ctx.db.update(s.conversation).set({ status: 'handled', handledAt: new Date(), handledByKind: 'ai' }).where(eq(s.conversation.id, conv.id));
    const res = await reply('agent', conv.id, { text: 'You are welcome' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONVERSATION_HANDLED', message: 'This conversation is handled. Reopen it to reply.' });
  });

  it('a check-in notice thread cannot carry a reply', async () => {
    const contactId = newId();
    await ctx.db.insert(s.contact).values({ id: contactId, operatorId: oto, channel: 'whatsapp', externalHandle: '+66810007302', phone: '+66810007302' });
    const convId = newId();
    const receptionCentral = await teamOf('reception', central);
    await ctx.db.insert(s.conversation).values({
      id: convId,
      operatorId: oto,
      contactId,
      channelAccountId: caConsole,
      branchId: central,
      teamId: receptionCentral.id,
      category: 'general',
      status: 'active',
      lastCustomerMessageAt: new Date(),
    });
    const res = await reply('agent', convId, { text: 'Hello' });
    expect(res.status).toBe(409);
    expect(res.body.error!.code).toBe('CHANNEL_CANNOT_REPLY');
  });

  it('permissions: no inbox grant 403; read without reply 403; another team 404; another operator 404', async () => {
    const conv = await customer('66810007303', 'Where do I park?');
    expect((await reply('counter', conv.id, { text: 'Basement' })).status).toBe(403);
    const reader = await reply('reader', conv.id, { text: 'Basement' });
    expect(reader.status).toBe(403);
    expect(reader.body.error!.message).toMatch(/inbox:conversation:reply/);
    expect((await reply('otherTeam', conv.id, { text: 'Basement' })).status).toBe(404);
    expect((await reply('secondAdmin', conv.id, { text: 'Basement' })).status).toBe(404);
    expect(await ctx.db.select().from(s.message).where(and(eq(s.message.conversationId, conv.id), eq(s.message.direction, 'outbound')))).toHaveLength(0);
  });
});

describe('template management (I2f)', () => {
  it('create under a caller-named id, the same id again, a taken variant, edit, deactivate, archive', async () => {
    const id = newId();
    const body = { id, key: 'handover_lost_found', language: 'th', channel: 'whatsapp', body: `ขอบคุณค่ะ ${SENTINEL}`, needsTranslation: false };
    const made = await call<InboxManagedTemplate>('admin', 'POST', '/inbox/templates', body);
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body).toMatchObject({ id, key: 'handover_lost_found', language: 'th', channel: 'whatsapp', approvalStatus: 'not_required', active: true, variables: [] });

    const again = await call<InboxManagedTemplate>('admin', 'POST', '/inbox/templates', body);
    expect(again.status).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(await ctx.db.select().from(s.template).where(eq(s.template.id, id))).toHaveLength(1);

    const clash = await call<{ error: { code: string } }>('admin', 'POST', '/inbox/templates', { ...body, id: newId() });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('TEMPLATE_EXISTS');

    const edited = await call<InboxManagedTemplate>('admin', 'PATCH', `/inbox/templates/${id}`, { body: `ขอบคุณ {{name}} ${SENTINEL}` });
    expect(edited.status).toBe(200);
    expect(edited.body.variables).toEqual(['name']);

    const composer = async () =>
      (await call<{ templates: Array<{ id: string }> }>('agent', 'GET', '/inbox/templates?language=th')).body.templates.map((t) => t.id);
    expect(await composer()).toContain(id);
    const off = await call<InboxManagedTemplate>('admin', 'PATCH', `/inbox/templates/${id}`, { active: false });
    expect(off.body.active).toBe(false);
    expect(await composer()).not.toContain(id);
    const all = await call<{ templates: InboxManagedTemplate[] }>('admin', 'GET', '/inbox/templates/manage?language=th');
    expect(all.body.templates.find((t) => t.id === id)?.active).toBe(false);

    const archived = await call<InboxManagedTemplate>('admin', 'POST', `/inbox/templates/${id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).not.toBeNull();
    const closed = await call<{ error: { code: string } }>('admin', 'PATCH', `/inbox/templates/${id}`, { active: true });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('TEMPLATE_ARCHIVED');
    // The variant is free again.
    expect((await call('admin', 'POST', '/inbox/templates', { ...body, id: newId() })).status).toBe(200);
    const listed = await call<{ templates: InboxManagedTemplate[] }>('admin', 'GET', '/inbox/templates/manage?language=th&archived=true');
    expect(listed.body.templates.some((t) => t.id === id && t.archivedAt !== null)).toBe(true);

    const actions = await ctx.db
      .select({ action: s.auditLog.action })
      .from(s.auditLog)
      .where(and(eq(s.auditLog.entityType, 'inbox.template'), eq(s.auditLog.entityId, id)))
      .orderBy(s.auditLog.createdAt);
    expect(actions.map((a) => a.action)).toEqual(['inbox.template.create', 'inbox.template.update', 'inbox.template.deactivate', 'inbox.template.archive']);
  });

  it("who may: the template's own scope; an agent may not manage at all", async () => {
    const wide = await call<{ error: { message: string } }>('chalongManager', 'POST', '/inbox/templates', { key: 'welcome', language: 'ru', body: 'Привет' });
    expect(wide.status).toBe(403);
    const park = await call<InboxManagedTemplate>('chalongManager', 'POST', '/inbox/templates', { key: 'welcome', language: 'en', branchId: chalong, body: 'Welcome to OTO Chalong!' });
    expect(park.status, JSON.stringify(park.body)).toBe(200);
    // Moving it to another park is outside their scope.
    expect((await call('chalongManager', 'PATCH', `/inbox/templates/${park.body.id}`, { branchId: central })).status).toBe(403);
    // The operator's welcome is not theirs to edit.
    expect((await call('chalongManager', 'PATCH', `/inbox/templates/${await templateId('welcome')}`, { active: false })).status).toBe(403);
    expect((await call('agent', 'GET', '/inbox/templates/manage')).status).toBe(403);
    expect((await call('agent', 'POST', '/inbox/templates', { key: 'welcome', language: 'de', body: 'Hallo' })).status).toBe(403);
    // Another operator's template is not found.
    expect((await call('secondAdmin', 'PATCH', `/inbox/templates/${park.body.id}`, { active: false })).status).toBe(404);
  });
});

describe('the send job (I2f)', () => {
  it('is registered on the runner every thirty seconds', () => {
    const jobs = buildDefaultJobs({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, channels: [], inboxChannels: ctx.app.inboxChannels });
    const job = jobs.find((j) => j.name === INBOX_SEND_JOB);
    expect(job, 'the send job is not registered').toBeTruthy();
    expect(job!.intervalSeconds).toBe(INBOX_SEND_INTERVAL_S);
  });

  it('THE RESEND RULE: only queued messages are sent — a sent one is never sent again', async () => {
    const conv = await customer('66810007401', 'Ping');
    const sentId = newId();
    const queuedId = newId();
    const before = (await sim()).sent().length;
    // A message the provider already accepted, and one waiting.
    await ctx.db.insert(s.message).values([
      { id: sentId, operatorId: oto, conversationId: conv.id, channelAccountId: caCentral, direction: 'outbound', authorKind: 'system', body: 'already out', providerStatus: 'sent', externalMessageId: 'wamid.ALREADY.SENT', sentAt: new Date() },
      { id: queuedId, operatorId: oto, conversationId: conv.id, channelAccountId: caCentral, direction: 'outbound', authorKind: 'system', body: 'waiting', providerStatus: 'queued' },
    ]);
    const sweep = await runInboxSendJob(ctx.db, sendDeps(), new Date());
    expect(sweep.sent).toBeGreaterThanOrEqual(1);
    const out = (await sim()).sent().slice(before);
    expect(out.map((x) => x.clientRef)).toEqual([queuedId]);
    expect(await messageRow(sentId)).toMatchObject({ providerStatus: 'sent', externalMessageId: 'wamid.ALREADY.SENT', sendAttempts: 0 });
    expect((await messageRow(queuedId)).providerStatus).toBe('sent');
    // Asked directly, the sent rows are skipped — and so is a second sweep.
    expect((await sendQueuedMessage(ctx.db, sendDeps(), sentId)).outcome).toBe('skipped');
    expect((await sendQueuedMessage(ctx.db, sendDeps(), queuedId)).outcome).toBe('skipped');
    await runInboxSendJob(ctx.db, sendDeps(), new Date());
    expect((await sim()).sent().slice(before)).toHaveLength(1);
  });

  it('a retryable refusal stays queued and backs off; the sweeper sends it once it is due', async () => {
    const conv = await customer('66810007402', 'Are you busy today?');
    (await sim()).refuseNext('RATE_LIMITED', '130429');
    const res = await reply('agent', conv.id, { text: 'Quiet this morning!' });
    expect(res.status).toBe(200);
    expect(res.body.refusal).toBe('RATE_LIMITED');
    expect(res.body.message.providerStatus).toBe('queued');
    const id = res.body.message.id;
    const waiting = await messageRow(id);
    expect(waiting).toMatchObject({ sendAttempts: 1, error: 'RATE_LIMITED' });
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // Not due yet: the sweep leaves it.
    expect((await sendQueuedMessage(ctx.db, sendDeps(), id)).outcome).toBe('skipped');
    // Past the back-off: sent.
    const later = new Date(Date.now() + sendBackoffMs(1) + 1_000);
    const sweep = await runInboxSendJob(ctx.db, { ...sendDeps(), now: () => later }, later);
    expect(sweep.sent).toBeGreaterThanOrEqual(1);
    const done = await messageRow(id);
    expect(done).toMatchObject({ providerStatus: 'sent', sendAttempts: 2, error: null });
    expect((await sim()).sent().filter((x) => x.clientRef === id)).toHaveLength(1);
  });

  it('a terminal refusal is marked failed and shown on the timeline as an event — ids and the word, never the words', async () => {
    const conv = await customer('66810007403', 'Can I bring a cake?');
    (await sim()).refuseNext('REJECTED', '131026');
    const res = await reply('agent', conv.id, { text: `Yes, of course ${SENTINEL}` });
    expect(res.status).toBe(200);
    expect(res.body.message.providerStatus).toBe('failed');
    expect(res.body.refusal).toBe('REJECTED');
    const detail = await call<{ events: Array<{ kind: string; payload: Record<string, unknown> }> }>('agent', 'GET', `/inbox/conversations/${conv.id}`);
    const failed = detail.body.events.find((e) => e.kind === 'send_failed');
    expect(failed?.payload).toMatchObject({ messageId: res.body.message.id, refusal: 'REJECTED', providerCode: '131026', attempts: 1 });
    expect(JSON.stringify(failed)).not.toContain(SENTINEL);
    // A failed message is never sent again.
    await runInboxSendJob(ctx.db, sendDeps(), new Date(Date.now() + 3_600_000));
    expect((await messageRow(res.body.message.id)).providerStatus).toBe('failed');
  });

  it('a retryable refusal on the last attempt is given up on, and the failure surfaces', async () => {
    const conv = await customer('66810007404', 'Hello?');
    const id = newId();
    await ctx.db.insert(s.message).values({
      id,
      operatorId: oto,
      conversationId: conv.id,
      channelAccountId: caCentral,
      direction: 'outbound',
      authorKind: 'system',
      body: 'retrying',
      providerStatus: 'queued',
      sendAttempts: SEND_MAX_ATTEMPTS - 1,
      error: 'UNREACHABLE',
    });
    (await sim()).refuseNext('UNREACHABLE');
    const out = await sendQueuedMessage(ctx.db, sendDeps(), id);
    expect(out).toMatchObject({ outcome: 'failed', refusal: 'UNREACHABLE', attempt: SEND_MAX_ATTEMPTS });
    const [event] = await ctx.db
      .select()
      .from(s.inboxEvent)
      .where(and(eq(s.inboxEvent.conversationId, conv.id), eq(s.inboxEvent.kind, 'send_failed')));
    expect(event!.payload).toMatchObject({ messageId: id, refusal: 'UNREACHABLE', attempts: SEND_MAX_ATTEMPTS });
    const [run] = await ctx.db
      .select()
      .from(s.opsRun)
      .where(and(eq(s.opsRun.name, 'adapter:inbox.send'), eq(s.opsRun.outcome, 'failed')))
      .orderBy(desc(s.opsRun.startedAt))
      .limit(1);
    expect(run!.detail).toMatchObject({ messageId: id, refusal: 'UNREACHABLE' });
  });

  it('a claim whose sender died is sent by the sweeper once its lease runs out', async () => {
    const conv = await customer('66810007405', 'Anyone there?');
    const id = newId();
    await ctx.db.insert(s.message).values({
      id,
      operatorId: oto,
      conversationId: conv.id,
      channelAccountId: caCentral,
      direction: 'outbound',
      authorKind: 'system',
      body: 'claimed then lost',
      providerStatus: 'queued',
      sendAttempts: 1,
      // A lease that ran out a minute ago.
      nextAttemptAt: new Date(Date.now() - 60_000),
    });
    await runInboxSendJob(ctx.db, sendDeps(), new Date());
    expect(await messageRow(id)).toMatchObject({ providerStatus: 'sent', sendAttempts: 2 });
  });
});

describe('inbound media (I2f)', () => {
  it('is fetched through the channel and stored as a file object; a signed URL only for a caller who can see the thread', async () => {
    const played = (await sim()).inbound({ from: '66810007501', name: 'Photo Guest', image: { caption: 'Is this lost bag yours?' } });
    expect(await deliver(played.webhook)).toBe('processed');
    const [msg] = await ctx.db.select().from(s.message).where(eq(s.message.externalMessageId, played.externalMessageId));
    expect(msg!.body).toBe('Is this lost bag yours?');
    expect(msg!.mediaFileIds).toHaveLength(1);
    const fileId = msg!.mediaFileIds[0]!;
    const [file] = await ctx.db.select().from(s.fileObject).where(eq(s.fileObject.id, fileId));
    expect(file).toMatchObject({ operatorId: oto, ownerEntityType: 'inbox.message', ownerEntityId: msg!.id, contentType: 'image/png', uploadedByAccountId: null });
    expect(file!.objectKey).toBe(`${oto}/inbox.message/${msg!.id}/${fileId}.png`);
    expect(puts.some((p) => p.objectKey === file!.objectKey && p.size === file!.size)).toBe(true);

    // The thread's own team reads it, access-logged.
    const ok = await call<{ url: string; contentType: string }>('agent', 'GET', `/files/${fileId}/url`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.url).toContain(file!.objectKey);
    const logged = await ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'file.read'), eq(s.auditLog.entityId, fileId)));
    expect(logged).toHaveLength(1);
    // Another team cannot see the thread: nor its file.
    expect((await call('otherTeam', 'GET', `/files/${fileId}/url`)).status).toBe(404);
    // No Inbox at all: refused.
    expect((await call('counter', 'GET', `/files/${fileId}/url`)).status).toBe(403);
    // Another operator: not found.
    expect((await call('secondAdmin', 'GET', `/files/${fileId}/url`)).status).toBe(404);
    // Never written through the files api.
    expect((await call('admin', 'POST', '/files', { contentType: 'image/png', ownerEntityType: 'inbox.message', ownerEntityId: msg!.id })).status).toBe(400);
  });

  it('a fetch the channel cannot answer leaves the message without the file, and says so on the ops record', async () => {
    const played = (await sim()).inbound({ from: '66810007502', image: {} });
    // Tamper with the media id so the simulator cannot resolve it: the delivery is re-signed by hand.
    const raw = (played.webhook.rawBody as string).replace(/SIMMEDIA\.[^"]+/, 'SIMMEDIA.unknown.000000');
    const { signMetaPayload } = await import('@oto/messaging');
    const outcome = await deliver({ ...played.webhook, rawBody: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMetaPayload(raw, SECRET) } });
    expect(outcome).toBe('processed');
    const [msg] = await ctx.db.select().from(s.message).where(eq(s.message.externalMessageId, played.externalMessageId));
    expect(msg!.mediaFileIds).toEqual([]);
    const runs = await ctx.db
      .select()
      .from(s.opsRun)
      .where(and(eq(s.opsRun.name, 'adapter:inbox.media'), eq(s.opsRun.outcome, 'failed')));
    expect(runs.some((r) => (r.detail as { messageId?: string; reason?: string }).messageId === msg!.id && (r.detail as { reason: string }).reason === 'MEDIA_NOT_FOUND')).toBe(true);
  });
});

describe('no body outside the message table (I2f)', () => {
  it('the sentinel is in no audit row, no timeline event and no ops row', async () => {
    const leaks = async (table: string, column: string) =>
      (
        await ctx.db.execute<{ n: number }>(
          sql.raw(`select count(*)::int as n from ${table} where ${column}::text like '%${SENTINEL}%'`),
        )
      ).rows[0]!.n;
    expect(await leaks('core.audit_log', 'coalesce(before::text, \'\') || coalesce(after::text, \'\')')).toBe(0);
    expect(await leaks('inbox.event', 'payload')).toBe(0);
    expect(await leaks('core.ops_run', 'coalesce(detail::text, \'\') || coalesce(error_message, \'\')')).toBe(0);
    // And it really is in the message table, so the check is not empty.
    expect(await leaks('inbox.message', 'body')).toBeGreaterThan(0);
  });
});
