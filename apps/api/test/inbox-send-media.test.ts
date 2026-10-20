import { hash } from '@node-rs/argon2';
import { and, eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import type { MessagingChannel, OutboundMessage, RawWebhook, SimulatorChannel } from '@oto/messaging';
import { newId, type InboxMessage } from '@oto/shared';
import { SESSION_COOKIE, hashToken, newSessionToken } from '../src/plugins/session';
import type { FileStorage } from '../src/services/files';
import type { InboxChannels } from '../src/services/inbox/channels';
import {
  AI_WITHDRAW_REASON,
  OUTBOUND_MEDIA_LINK_S,
  outboundMediaType,
  runInboxSendJob,
  sendBackoffMs,
  sendQueuedMessage,
  type SendDeps,
} from '../src/services/inbox/send';
import {
  CENTRAL_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  teardownAll,
  type TestContext,
} from './helpers';
import { NO_LEAKS, sentinelLeaks } from './inbox-sentinel';

/**
 * SCRUM-590 round A2, lane b — THE SEND PATH'S HALF OF THE CUSTOMER ASSISTANT
 * (plan `docs/progress/plans/inbox-ai-build/PLAN.md` §A.3, §C.5, rails change
 * R4, §D.1).
 *
 * What it holds:
 *   - a queued row carrying a file goes out as the contract's `media` content,
 *     its link a presigned GET minted inside the attempt for
 *     `OUTBOUND_MEDIA_LINK_S`, its body the caption; a retry re-mints the link;
 *   - only an inbox-owned file of the row's operator is ever linked; every way
 *     a file cannot be linked is a refusal value, retried only when it can
 *     come back;
 *   - an AI line a staff message overtook is never sent: the claim refuses it
 *     and the send path marks it `withdrawn`, with an `ai_withdrawn` event and
 *     an audit row, ids and the reason word only; a staff message before it,
 *     or a live lease, leaves it alone;
 *   - a withdrawal while the provider call is in flight does not hide a line
 *     the customer received; a late receipt never moves a withdrawn row;
 *   - staff read a withdrawn line as withdrawn;
 *   - no body reaches an audit row, an event, an ops row or a log line.
 */

const SECRET = 'inbox-send-media-test-secret';
const SENTINEL = 'SENTINEL-b40c-send-media-never-outside-the-message-table';
const PASSWORD = 'inboxsendmedia1234';

let ctx: TestContext;
let oto: string;
let central: string;
let caCentral: string;
let staffAccount: string;
let agentCookie: string;
const logLines: string[] = [];

/** Every presign the send path asked for, in order. */
const presigns: Array<{ objectKey: string; expiry: number | undefined; link: string }> = [];
let storageDown = false;
const fakeStorage: FileStorage = {
  bucket: 'oto-files-test',
  presignedPut: async (objectKey) => `memory://oto-files-test/${objectKey}?put`,
  presignedGet: async (objectKey, expiry) => {
    if (storageDown) throw new Error('storage is down');
    const link = `https://storage.test/oto-files-test/${objectKey}?X-Expires=${expiry}&n=${presigns.length + 1}`;
    presigns.push({ objectKey, expiry, link });
    return link;
  },
  put: async () => {},
  remove: async () => {},
  probe: async () => ({ state: 'ready' }),
};

/** What each channel send was handed — the simulator records only the kind. */
const handed: OutboundMessage[] = [];
/** A hook run inside the provider call, before the simulator answers. */
let duringSend: ((msg: OutboundMessage) => Promise<void>) | null = null;

function spyChannels(real: InboxChannels): InboxChannels {
  return {
    simulatorEnabled: real.simulatorEnabled,
    runId: real.runId,
    simulatorFor: (row) => real.simulatorFor(row),
    forAccount(row) {
      const found = real.forAccount(row);
      if (!found.ok) return found;
      const channel = found.channel;
      const spy = new Proxy(channel, {
        get(target, prop, receiver) {
          if (prop === 'send') {
            return async (msg: OutboundMessage) => {
              handed.push(msg);
              if (duringSend) await duringSend(msg);
              return target.send(msg);
            };
          }
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }) as MessagingChannel;
      return { ...found, channel: spy };
    },
  };
}

const deps = (over: Partial<SendDeps> = {}): SendDeps => ({
  channels: spyChannels(ctx.app.inboxChannels),
  storage: fakeStorage,
  log: ctx.app.log,
  ...over,
});

async function sim(): Promise<SimulatorChannel> {
  const [row] = await ctx.db.select().from(s.channelAccount).where(eq(s.channelAccount.id, caCentral)).limit(1);
  const found = ctx.app.inboxChannels.simulatorFor({ ...row! });
  if (!found) throw new Error('simulator off');
  return found;
}

async function deliver(webhook: RawWebhook): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/webhooks/inbox/${caCentral}`,
    headers: webhook.headers as Record<string, string>,
    payload: typeof webhook.rawBody === 'string' ? webhook.rawBody : Buffer.from(webhook.rawBody),
  });
  expect(res.statusCode).toBe(200);
}

/** A customer writes in on the central simulator number; answers their thread's id. */
async function customer(from: string, text: string): Promise<string> {
  const played = (await sim()).inbound({ from, name: 'Send Media Guest', text });
  await deliver(played.webhook);
  const [row] = await ctx.db
    .select({ id: s.conversation.id })
    .from(s.conversation)
    .innerJoin(s.contact, eq(s.contact.id, s.conversation.contactId))
    .where(and(eq(s.conversation.channelAccountId, caCentral), eq(s.contact.externalHandle, `+${from}`)))
    .limit(1);
  return row!.id;
}

async function messageRow(id: string) {
  const [row] = await ctx.db.select().from(s.message).where(eq(s.message.id, id)).limit(1);
  return row!;
}

/** A file in the store, owned as the test says (a template's brochure by default). */
async function file(opts: { objectKey: string; contentType: string; ownerEntityType?: string; operatorId?: string }) {
  const id = newId();
  await ctx.db.insert(s.fileObject).values({
    id,
    operatorId: opts.operatorId ?? oto,
    bucket: fakeStorage.bucket,
    objectKey: opts.objectKey,
    contentType: opts.contentType,
    size: 1024,
    ownerEntityType: opts.ownerEntityType ?? 'inbox.template',
    ownerEntityId: newId(),
  });
  return id;
}

/** A queued outbound line in the thread, written as the assistant's unless said otherwise. */
async function queued(
  conversationId: string,
  opts: { mediaFileIds?: string[]; authorKind?: 'ai' | 'system'; body?: string; createdAt?: Date; nextAttemptAt?: Date | null } = {},
) {
  const id = newId();
  await ctx.db.insert(s.message).values({
    id,
    operatorId: oto,
    conversationId,
    channelAccountId: caCentral,
    direction: 'outbound',
    authorKind: opts.authorKind ?? 'ai',
    body: opts.body ?? `Here are our birthday packages ${SENTINEL}`,
    bodyLanguage: 'en',
    mediaFileIds: opts.mediaFileIds ?? [],
    providerStatus: 'queued',
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    ...(opts.nextAttemptAt !== undefined ? { nextAttemptAt: opts.nextAttemptAt } : {}),
  });
  return id;
}

/** A staff line in the thread at the given time (already sent: only its existence matters to the claim). */
async function staffLine(conversationId: string, createdAt: Date) {
  const id = newId();
  await ctx.db.insert(s.message).values({
    id,
    operatorId: oto,
    conversationId,
    channelAccountId: caCentral,
    direction: 'outbound',
    authorKind: 'staff',
    authorAccountId: staffAccount,
    body: `A person answers ${SENTINEL}`,
    providerStatus: 'sent',
    externalMessageId: `wamid.STAFF.${id}`,
    sentAt: createdAt,
    createdAt,
  });
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: { INBOX_SIMULATOR: 'on', INBOX_SIMULATOR_SECRET: SECRET },
    logCapture: { stream: { write: (line) => void logLines.push(line) }, level: 'debug' },
  });
  (ctx.app as unknown as { fileStorage: FileStorage }).fileStorage = fakeStorage;
  oto = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);

  caCentral = newId();
  await ctx.db.insert(s.channelAccount).values({
    id: caCentral,
    operatorId: oto,
    branchId: central,
    channel: 'whatsapp',
    provider: 'simulator',
    externalId: 'send-media-test-wa-central',
    displayName: 'Send Media Test Central',
    defaultCategory: 'general',
    canReply: true,
    status: 'active',
  });

  // An agent at Reception · Central, where every general enquiry at Central routes.
  const [reception] = await ctx.db
    .select()
    .from(s.team)
    .where(and(eq(s.team.operatorId, oto), eq(s.team.key, 'reception'), eq(s.team.branchId, central)))
    .limit(1);
  const employeeId = newId();
  await ctx.db.insert(s.employee).values({ id: employeeId, operatorId: oto, name: 'Send Media Agent', phone: '+66810009001' });
  staffAccount = newId();
  await ctx.db.insert(s.account).values({
    id: staffAccount,
    operatorId: oto,
    employeeId,
    phone: '+66810009001',
    passwordHash: await hash(PASSWORD),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  const [role] = await ctx.db
    .select({ id: s.role.id })
    .from(s.role)
    .where(and(eq(s.role.operatorId, oto), eq(s.role.name, 'inbox_agent')))
    .limit(1);
  await ctx.db
    .insert(s.roleAssignment)
    .values({ id: newId(), accountId: staffAccount, roleId: role!.id, scopeType: 'department', scopeId: reception!.departmentId! });
  const token = newSessionToken();
  await ctx.db.insert(s.session).values({
    id: newId(),
    accountId: staffAccount,
    tokenHash: hashToken(token),
    branchId: null,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  agentCookie = `${SESSION_COOKIE}=${token}`;
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('media sends (R4)', () => {
  it('names a file by its content type the way a WhatsApp-shaped channel does', () => {
    expect(outboundMediaType('application/pdf')).toBe('document');
    expect(outboundMediaType('image/jpeg')).toBe('image');
    expect(outboundMediaType('video/mp4')).toBe('video');
    expect(outboundMediaType('audio/ogg')).toBe('audio');
    expect(outboundMediaType('text/plain')).toBe('document');
  });

  it('a brochure goes as a document: a link minted at send time for fifteen minutes, the body its caption, then delivered and read', async () => {
    const conv = await customer('66810009101', 'Do you do birthday parties?');
    const brochure = await file({ objectKey: 'inbox/templates/central/birthday-packages.pdf', contentType: 'application/pdf' });
    const id = await queued(conv, { mediaFileIds: [brochure] });
    // Nothing is minted before the attempt.
    expect(presigns.filter((p) => p.objectKey.endsWith('birthday-packages.pdf'))).toHaveLength(0);

    const out = await sendQueuedMessage(ctx.db, deps(), id);
    expect(out.outcome).toBe('sent');

    const minted = presigns.filter((p) => p.objectKey === 'inbox/templates/central/birthday-packages.pdf');
    expect(minted).toHaveLength(1);
    expect(minted[0]!.expiry).toBe(OUTBOUND_MEDIA_LINK_S);
    expect(OUTBOUND_MEDIA_LINK_S).toBe(15 * 60);
    const msg = handed.find((m) => m.clientRef === id)!;
    expect(msg.content).toEqual({
      kind: 'media',
      mediaType: 'document',
      link: minted[0]!.link,
      caption: `Here are our birthday packages ${SENTINEL}`,
      filename: 'birthday-packages.pdf',
    });
    const accepted = (await sim()).sent().filter((x) => x.clientRef === id);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.kind).toBe('media');

    const row = await messageRow(id);
    expect(row).toMatchObject({ providerStatus: 'sent', sendAttempts: 1, error: null, externalMessageId: accepted[0]!.externalMessageId });
    for (const webhook of (await sim()).takeScheduled()) await deliver(webhook);
    const after = await messageRow(id);
    expect(after.providerStatus).toBe('read');
    expect(after.deliveredAt).not.toBeNull();

    // The attempt's audit row names the file by id — never the link, never the caption.
    const [entry] = await ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.message.send'), eq(s.auditLog.entityId, id)));
    expect(entry!.after).toMatchObject({ messageId: id, mediaFileIds: [brochure], outcome: 'sent' });
    expect(JSON.stringify(entry)).not.toContain('storage.test');
  });

  it("an image from the thread's own media goes as an image, with no file name; the sweeper sends it too", async () => {
    const conv = await customer('66810009102', 'Can you send me the map?');
    const map = await file({ objectKey: `inbox/messages/${newId()}/map.png`, contentType: 'image/png', ownerEntityType: 'inbox.message' });
    const id = await queued(conv, { mediaFileIds: [map], body: '' });
    const sweep = await runInboxSendJob(ctx.db, deps(), new Date());
    expect(sweep.sent).toBeGreaterThanOrEqual(1);
    const msg = handed.find((m) => m.clientRef === id)!;
    expect(msg.content).toMatchObject({ kind: 'media', mediaType: 'image' });
    expect(msg.content).not.toHaveProperty('filename');
    expect(msg.content).not.toHaveProperty('caption');
    expect((await messageRow(id)).providerStatus).toBe('sent');
  });

  it('a retry re-mints the link: no attempt hands over a link minted for an earlier one', async () => {
    const conv = await customer('66810009103', 'Birthday info please');
    const brochure = await file({ objectKey: 'inbox/templates/central/retry-brochure.pdf', contentType: 'application/pdf' });
    const id = await queued(conv, { mediaFileIds: [brochure] });
    (await sim()).refuseNext('RATE_LIMITED', '130429');
    const first = await sendQueuedMessage(ctx.db, deps(), id);
    expect(first).toMatchObject({ outcome: 'retry', refusal: 'RATE_LIMITED', attempt: 1 });
    expect((await messageRow(id))).toMatchObject({ providerStatus: 'queued', error: 'RATE_LIMITED' });

    const later = new Date(Date.now() + sendBackoffMs(1) + 1_000);
    const second = await sendQueuedMessage(ctx.db, deps({ now: () => later }), id);
    expect(second).toMatchObject({ outcome: 'sent', attempt: 2 });

    const minted = presigns.filter((p) => p.objectKey === 'inbox/templates/central/retry-brochure.pdf');
    expect(minted).toHaveLength(2);
    const links = handed.filter((m) => m.clientRef === id).map((m) => (m.content.kind === 'media' ? m.content.link : null));
    expect(links).toEqual([minted[0]!.link, minted[1]!.link]);
    expect(links[0]).not.toBe(links[1]);
    expect((await sim()).sent().filter((x) => x.clientRef === id)).toHaveLength(1);
  });

  it('storage that is off or not answering is retried; the row stays queued and nothing is handed to the channel', async () => {
    const conv = await customer('66810009104', 'Brochure?');
    const brochure = await file({ objectKey: 'inbox/templates/central/later.pdf', contentType: 'application/pdf' });
    const off = await queued(conv, { mediaFileIds: [brochure] });
    expect(await sendQueuedMessage(ctx.db, deps({ storage: null }), off)).toMatchObject({ outcome: 'retry', refusal: 'MEDIA_UNAVAILABLE' });
    const down = await queued(conv, { mediaFileIds: [brochure] });
    storageDown = true;
    try {
      expect(await sendQueuedMessage(ctx.db, deps(), down)).toMatchObject({ outcome: 'retry', refusal: 'MEDIA_UNAVAILABLE' });
    } finally {
      storageDown = false;
    }
    expect(handed.filter((m) => m.clientRef === off || m.clientRef === down)).toHaveLength(0);
    expect((await messageRow(off)).providerStatus).toBe('queued');
    expect((await messageRow(down)).providerStatus).toBe('queued');
  });

  it("never links a file that is not the inbox's, another operator's, a missing one or two at once: failed, with the word on the timeline", async () => {
    const conv = await customer('66810009105', 'Send me something');
    const [other] = await ctx.db.select({ id: s.operator.id }).from(s.operator).where(ne(s.operator.id, oto)).limit(1);
    const otherOperator = other!.id;
    const checkinPhoto = await file({ objectKey: 'checkin/photo.jpg', contentType: 'image/jpeg', ownerEntityType: 'registration' });
    const foreign = await file({ objectKey: 'inbox/templates/other/brochure.pdf', contentType: 'application/pdf', operatorId: otherOperator });
    const a = await file({ objectKey: 'inbox/templates/central/a.pdf', contentType: 'application/pdf' });
    const b = await file({ objectKey: 'inbox/templates/central/b.pdf', contentType: 'application/pdf' });
    const cases = [[checkinPhoto], [foreign], [newId()], [a, b]];
    for (const media of cases) {
      const id = await queued(conv, { mediaFileIds: media });
      expect(await sendQueuedMessage(ctx.db, deps(), id), JSON.stringify(media)).toMatchObject({ outcome: 'failed', refusal: 'MEDIA_UNAVAILABLE' });
      expect(handed.some((m) => m.clientRef === id)).toBe(false);
      const [event] = await ctx.db
        .select()
        .from(s.inboxEvent)
        .where(and(eq(s.inboxEvent.conversationId, conv), eq(s.inboxEvent.kind, 'send_failed')))
        .orderBy(s.inboxEvent.createdAt);
      expect(event).toBeTruthy();
    }
    expect(presigns.some((p) => p.objectKey === 'checkin/photo.jpg' || p.objectKey === 'inbox/templates/other/brochure.pdf')).toBe(false);
  });

  it('outside the free-text window a media line is free text: the channel refuses TEMPLATE_REQUIRED', async () => {
    const conv = await customer('66810009106', 'Old thread');
    await ctx.db
      .update(s.conversation)
      .set({ lastCustomerMessageAt: new Date(Date.now() - 48 * 3_600_000) })
      .where(eq(s.conversation.id, conv));
    const brochure = await file({ objectKey: 'inbox/templates/central/window.pdf', contentType: 'application/pdf' });
    const id = await queued(conv, { mediaFileIds: [brochure] });
    expect(await sendQueuedMessage(ctx.db, deps(), id)).toMatchObject({ outcome: 'failed', refusal: 'TEMPLATE_REQUIRED' });
  });
});

describe('a person outranks the assistant in the send claim (§A.3)', () => {
  it('an AI line a staff message overtook is withdrawn — never sent — with its event and audit row, ids only', async () => {
    const conv = await customer('66810009201', 'What time do you open?');
    const t0 = new Date(Date.now() - 10_000);
    const ai = await queued(conv, { createdAt: t0 });
    await staffLine(conv, new Date(t0.getTime() + 2_000));

    const out = await sendQueuedMessage(ctx.db, deps(), ai);
    expect(out).toEqual({ messageId: ai, outcome: 'withdrawn' });
    const row = await messageRow(ai);
    expect(row).toMatchObject({ providerStatus: 'withdrawn', sendAttempts: 0, externalMessageId: null, sentAt: null, nextAttemptAt: null });
    expect(handed.some((m) => m.clientRef === ai)).toBe(false);
    expect((await sim()).sent().some((x) => x.clientRef === ai)).toBe(false);

    const events = await ctx.db
      .select()
      .from(s.inboxEvent)
      .where(and(eq(s.inboxEvent.conversationId, conv), eq(s.inboxEvent.kind, 'ai_withdrawn')));
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ messageId: ai, reason: AI_WITHDRAW_REASON });
    expect(events[0]!.actorKind).toBe('system');
    const audits = await ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.ai.message.withdraw'), eq(s.auditLog.entityId, ai)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: 'inbox.message', operatorId: oto, branchId: central });
    expect(audits[0]!.after).toEqual({ messageId: ai, conversationId: conv, reason: AI_WITHDRAW_REASON });

    // Final: asked again, by the sweeper or directly, nothing sends it and nothing withdraws it twice.
    expect((await sendQueuedMessage(ctx.db, deps(), ai)).outcome).toBe('skipped');
    await runInboxSendJob(ctx.db, deps(), new Date(Date.now() + 3_600_000));
    expect((await messageRow(ai)).providerStatus).toBe('withdrawn');
    expect(handed.some((m) => m.clientRef === ai)).toBe(false);
    expect(
      await ctx.db
        .select()
        .from(s.inboxEvent)
        .where(and(eq(s.inboxEvent.conversationId, conv), eq(s.inboxEvent.kind, 'ai_withdrawn'))),
    ).toHaveLength(1);
  });

  it('the sweeper withdraws an overtaken AI brochure rather than sending it, and counts it', async () => {
    const conv = await customer('66810009202', 'Party for 15 kids?');
    const t0 = new Date(Date.now() - 10_000);
    const brochure = await file({ objectKey: 'inbox/templates/central/overtaken.pdf', contentType: 'application/pdf' });
    const ai = await queued(conv, { createdAt: t0, mediaFileIds: [brochure] });
    await staffLine(conv, new Date(t0.getTime() + 1_000));
    const sweep = await runInboxSendJob(ctx.db, deps(), new Date());
    expect(sweep.withdrawn).toBeGreaterThanOrEqual(1);
    expect((await messageRow(ai)).providerStatus).toBe('withdrawn');
    // Never sent, so its link was never minted.
    expect(presigns.some((p) => p.objectKey === 'inbox/templates/central/overtaken.pdf')).toBe(false);
  });

  it('a staff message BEFORE the AI line, or a non-AI line, does not hold anything back', async () => {
    const conv = await customer('66810009203', 'Hi again');
    const t0 = new Date(Date.now() - 10_000);
    await staffLine(conv, t0);
    const ai = await queued(conv, { createdAt: new Date(t0.getTime() + 1_000) });
    expect((await sendQueuedMessage(ctx.db, deps(), ai)).outcome).toBe('sent');
    // The out-of-hours line is the platform's: a person speaking after it does not withdraw it.
    const system = await queued(conv, { authorKind: 'system', createdAt: new Date(t0.getTime() + 2_000), body: 'We are closed' });
    await staffLine(conv, new Date(t0.getTime() + 3_000));
    expect((await sendQueuedMessage(ctx.db, deps(), system)).outcome).toBe('sent');
  });

  it('an AI line under a live lease, or in its typing time, is not withdrawn by the send path (it is not due)', async () => {
    const conv = await customer('66810009204', 'Socks?');
    const t0 = new Date(Date.now() - 10_000);
    const ai = await queued(conv, { createdAt: t0, nextAttemptAt: new Date(Date.now() + 60_000) });
    await staffLine(conv, new Date(t0.getTime() + 1_000));
    expect((await sendQueuedMessage(ctx.db, deps(), ai)).outcome).toBe('skipped');
    expect((await messageRow(ai)).providerStatus).toBe('queued');
    // Once due, it is withdrawn, not sent.
    const later = new Date(Date.now() + 120_000);
    expect((await sendQueuedMessage(ctx.db, deps({ now: () => later }), ai)).outcome).toBe('withdrawn');
  });

  it('a withdrawal that lands while the provider call is in flight does not hide a line the customer received', async () => {
    const conv = await customer('66810009205', 'Parking?');
    const ai = await queued(conv);
    duringSend = async (msg) => {
      if (msg.clientRef !== ai) return;
      // A person replied while the provider was sending: someone withdrew the row meanwhile.
      await ctx.db.update(s.message).set({ providerStatus: 'withdrawn' }).where(eq(s.message.id, ai));
    };
    try {
      expect((await sendQueuedMessage(ctx.db, deps(), ai)).outcome).toBe('sent');
    } finally {
      duringSend = null;
    }
    const row = await messageRow(ai);
    expect(row.providerStatus).toBe('sent');
    expect(row.externalMessageId).toMatch(/^wamid\.SIM\./);
  });

  it('a late receipt can never resurrect a withdrawn line', async () => {
    const conv = await customer('66810009206', 'Late receipt?');
    const t0 = new Date(Date.now() - 10_000);
    const ai = await queued(conv, { createdAt: t0 });
    await staffLine(conv, new Date(t0.getTime() + 1_000));
    expect((await sendQueuedMessage(ctx.db, deps(), ai)).outcome).toBe('withdrawn');
    // A receipt naming it (forged, or for an id it was somehow given) moves nothing.
    const ext = `wamid.SIM.LATE.${ai}`;
    await ctx.db.update(s.message).set({ externalMessageId: ext }).where(eq(s.message.id, ai));
    for (const status of ['sent', 'delivered', 'read', 'failed'] as const) {
      await deliver((await sim()).statusWebhook(ext, status));
    }
    const row = await messageRow(ai);
    expect(row).toMatchObject({ providerStatus: 'withdrawn', sentAt: null, deliveredAt: null, readAt: null, error: null });
  });

  it('staff read a withdrawn line as withdrawn', async () => {
    const conv = await customer('66810009207', 'Read it back');
    const t0 = new Date(Date.now() - 10_000);
    const ai = await queued(conv, { createdAt: t0 });
    await staffLine(conv, new Date(t0.getTime() + 1_000));
    expect((await sendQueuedMessage(ctx.db, deps(), ai)).outcome).toBe('withdrawn');
    const res = await ctx.app.inject({ method: 'GET', url: `/inbox/conversations/${conv}/messages`, headers: { cookie: agentCookie } });
    expect(res.statusCode, res.body).toBe(200);
    const { messages } = res.json() as { messages: InboxMessage[] };
    const line = messages.find((m) => m.id === ai);
    expect(line).toMatchObject({ authorKind: 'ai', providerStatus: 'withdrawn', sentAt: null });
  });
});

describe('the no-body sentinel on every new path (§D.1)', () => {
  it('no caption or line reached an audit row, an event, an ops row or a log line', async () => {
    expect(logLines.length).toBeGreaterThan(10);
    expect(await sentinelLeaks(ctx.db, SENTINEL, logLines)).toEqual(NO_LEAKS);
    // Nor did a minted link reach a log line.
    expect(logLines.filter((l) => l.includes('storage.test'))).toEqual([]);
  });
});
