import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema as s } from '@oto/db';
import {
  InboxConversationListSchema,
  InboxPrebookingSchema,
  newId,
  type InboxBookDateBody,
  type InboxConversationList,
  type InboxPrebooking,
  type Permission,
} from '@oto/shared';
import { hashToken, newSessionToken, SESSION_COOKIE } from '../src/plugins/session';
import { gatewayFor, pollPendingAttempts, simulateGatewayEvent } from '../src/services/payments/gateway';
import { afterPrebookingDepositPaid } from '../src/services/inbox/prebooking';
import * as partyMessages from '../src/services/inbox/party-messages';
import { confirmAttempt } from '../src/services/payments/terminal';
import type {
  DirectoryInboxEventBody,
  DirectoryNotificationBody,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-996: a paid pre-booking deposit shows on the chat — the row's label,
 * the "Ready to book" group, the family's "received" line, the birthday
 * manager's bell — on the fixtures of `prebooking-review.test.ts`. "Paid" is
 * only ever the existing rule's answer (`view()` in `inbox/prebooking.ts`).
 */
let ctx: TestContext;
let operatorId: string;
let branchId: string;
let accountId: string;
let cookie: string;
let birthdayCookie: string;
let managerCookie: string;
let channelId: string;
let teamId: string;
let reader: { accountId: string; cookie: string };
let restricted: { accountId: string; cookie: string };
const managerAppUserId = newId();
let savedContact: unknown = null;
const notices: DirectoryNotificationBody[] = [];
let failNotify = false;
const events = new Map<string, DirectoryInboxEventBody>();
const directory: OtoAppDirectory = {
  configured: true,
  async addAttendee() {
    return { ok: false, status: null, code: 'unused', message: 'unused', retryable: true };
  },
  async checkinAttendee() {
    return { ok: false, status: null, code: 'unused', message: 'unused', retryable: true };
  },
  async notify(body) {
    notices.push(body);
    if (failNotify) throw new Error('ZZ TEST the app did not answer');
    return {
      ok: true,
      status: 201,
      body: {
        replayed: false,
        notification: { id: body.id, recipientUserId: body.recipientUserId, type: 'inbox_handover', createdAt: new Date().toISOString() },
      },
    };
  },
  async createInboxEvent(body) {
    const b = events.get(body.id) ?? body;
    events.set(body.id, b);
    return {
      ok: true,
      status: 201,
      body: {
        replayed: false,
        event: {
          id: b.id,
          branchId: b.coreBranchId,
          coreBranchId: b.coreBranchId,
          eventType: 'birthday',
          title: b.title,
          status: 'tentative',
          statusName: 'Tentative',
          eventDate: b.eventDate,
          startTime: b.startTime,
          numChildren: b.numChildren ?? null,
          numAdults: b.numAdults ?? null,
          inboxConversationId: b.inboxConversationId,
          createdAt: new Date().toISOString(),
        },
      },
    };
  },
};

const post = (conversationId: string, route: string, payload: unknown, auth = cookie, key = newId()) =>
  ctx.app.inject({
    method: 'POST',
    url: `/inbox/conversations/${conversationId}/${route}`,
    headers: { cookie: auth, 'idempotency-key': key },
    payload: payload as never,
  });
async function list(auth: string, query = 'tab=team&limit=100'): Promise<InboxConversationList> {
  const answer = await ctx.app.inject({ method: 'GET', url: `/inbox/conversations?${query}`, headers: { cookie: auth } });
  expect(answer.statusCode, answer.body).toBe(200);
  return InboxConversationListSchema.parse(answer.json());
}
const rowOf = (page: InboxConversationList, id: string) => page.conversations.find((r) => r.id === id);
const grouped = (page: InboxConversationList, ids: string[]) =>
  (page.readyToBook ?? []).map((r) => r.id).filter((id) => ids.includes(id));
async function readDeposit(conversationId: string, auth = cookie) {
  return ctx.app.inject({ method: 'GET', url: `/inbox/conversations/${conversationId}/prebooking`, headers: { cookie: auth } });
}

async function person(permissions: readonly Permission[]) {
  const id = newId(), roleId = newId(), employeeId = newId();
  await ctx.db.insert(s.employee).values({ id: employeeId, operatorId, branchId, name: 'ZZ TEST 996 reader' });
  await ctx.db.insert(s.account).values({ id, operatorId, employeeId, phone: `+66${randomBytes(6).readUIntBE(0, 6)}`, status: 'active', phoneVerifiedAt: new Date() });
  await ctx.db.insert(s.role).values({ id: roleId, operatorId, name: `ZZ TEST ${roleId}` });
  await ctx.db.insert(s.rolePermission).values(permissions.map((permission) => ({ id: newId(), roleId, permission })));
  await ctx.db.insert(s.roleAssignment).values({ id: newId(), roleId, accountId: id, scopeType: 'operator', scopeId: operatorId });
  const token = newSessionToken();
  await ctx.db.insert(s.session).values({ id: newId(), accountId: id, tokenHash: hashToken(token), branchId, expiresAt: new Date(Date.now() + 3_600_000) });
  return { accountId: id, cookie: `${SESSION_COOKIE}=${token}` };
}

async function fixture(name = 'ZZ TEST 996 parent') {
  const contactId = newId();
  const conversationId = newId();
  await ctx.db.insert(s.contact).values({ id: contactId, operatorId, channel: 'whatsapp', externalHandle: newId(), displayName: name });
  await ctx.db.insert(s.conversation).values({
    id: conversationId,
    operatorId,
    contactId,
    channelAccountId: channelId,
    branchId,
    teamId,
    category: 'birthdays',
    language: 'en',
    lastCustomerMessageAt: new Date(),
  });
  const booking: InboxBookDateBody = {
    id: newId(),
    branchId,
    date: '2099-11-21',
    startTime: '14:00',
    kids: 12,
    adults: 4,
    contactName: 'ZZ TEST parent',
    phone: null,
    childName: 'ZZ TEST child',
    childAge: 6,
  };
  return { conversationId, booking, request: { booking, amountSatang: 300_000, requestId: newId() } };
}
async function requested(f: Awaited<ReturnType<typeof fixture>>) {
  const answer = await post(f.conversationId, 'prebooking', f.request);
  expect(answer.statusCode, answer.body).toBe(200);
  return InboxPrebookingSchema.parse(answer.json()).draft!;
}
async function attemptOf(id: string) {
  const [row] = await ctx.db
    .select({ attempt: s.paymentAttempt })
    .from(s.prebookingDepositRequest)
    .innerJoin(s.paymentAttempt, eq(s.paymentAttempt.id, s.prebookingDepositRequest.paymentAttemptId))
    .where(eq(s.prebookingDepositRequest.draftId, id))
    .orderBy(sql`${s.prebookingDepositRequest.createdAt} desc`)
    .limit(1);
  return row!.attempt;
}
async function pay(draft: NonNullable<InboxPrebooking['draft']>) {
  const a = await attemptOf(draft.id);
  const answer = await ctx.app.inject({
    method: 'POST',
    url: `/webhooks/2c2p/hosted/${a.id}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'action=pay',
  });
  expect([200, 302, 303], answer.body).toContain(answer.statusCode);
  expect((await attemptOf(draft.id)).status).toBe('approved');
  return a;
}
const messagesOf = (conversationId: string) =>
  ctx.db.select().from(s.message).where(eq(s.message.conversationId, conversationId)).orderBy(s.message.createdAt);
const paidPills = (conversationId: string) =>
  ctx.db
    .select()
    .from(s.inboxEvent)
    .where(and(eq(s.inboxEvent.conversationId, conversationId), eq(s.inboxEvent.kind, 'deposit_paid')));
const bellsFor = (conversationId: string) => notices.filter((n) => n.referenceId === conversationId);
async function receivedTemplateIds() {
  const rows = await ctx.db
    .select({ id: s.template.id })
    .from(s.template)
    .where(and(eq(s.template.operatorId, operatorId), eq(s.template.key, 'party_deposit_received')));
  return new Set(rows.map((r) => r.id));
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      PGW_PROVIDER: 'simulator',
      PAYMENTS_SIMULATOR: 'on',
      PGW_MERCHANT_ID: 'ZZTEST996',
      PGW_SECRET_KEY: randomBytes(32).toString('hex'),
      PGW_WEBHOOK_SECRET: 'zz996',
      PGW_BACKEND_RETURN_URL: 'https://api.example.test/webhooks/2c2p/payment?t=zz996',
      INBOX_SIMULATOR: 'on',
      INBOX_SIMULATOR_SECRET: randomBytes(24).toString('hex'),
    },
  });
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const [account] = await ctx.db.select().from(s.account).where(eq(s.account.phone, ADMIN.phone));
  accountId = account!.id;
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [team] = await ctx.db.select().from(s.team).where(and(eq(s.team.operatorId, operatorId), eq(s.team.key, 'birthdays')));
  teamId = team!.id;
  const [birthdayAccount] = await ctx.db.select().from(s.account).where(eq(s.account.phone, RECEPTION.phone));
  const [managerAccount] = await ctx.db.select().from(s.account).where(eq(s.account.phone, BRANCH_MANAGER.phone));
  const [agentRole] = await ctx.db.select().from(s.role).where(and(eq(s.role.operatorId, operatorId), eq(s.role.name, 'inbox_agent')));
  const [managerRole] = await ctx.db.select().from(s.role).where(and(eq(s.role.operatorId, operatorId), eq(s.role.name, 'inbox_manager')));
  await ctx.db.insert(s.roleAssignment).values([
    { id: newId(), accountId: birthdayAccount!.id, roleId: agentRole!.id, scopeType: 'department', scopeId: team!.departmentId! },
    { id: newId(), accountId: managerAccount!.id, roleId: managerRole!.id, scopeType: 'branch', scopeId: branchId },
  ]);
  birthdayCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  // Sees every conversation of the operator, may book none of them.
  reader = await person(['app:inbox:access', 'inbox:conversation:read']);
  restricted = await person(['app:inbox:access', 'inbox:conversation:read']);
  channelId = newId();
  await ctx.db.insert(s.channelAccount).values({
    id: channelId,
    operatorId,
    branchId,
    channel: 'whatsapp',
    provider: 'simulator',
    externalId: `zz-test-${newId()}`,
    displayName: 'ZZ TEST 996 deposit line',
    canReply: true,
    status: 'active',
  });
  const [park] = await ctx.db.select({ contact: s.branch.birthdayManagerContact }).from(s.branch).where(eq(s.branch.id, branchId));
  savedContact = park?.contact ?? null;
  await ctx.db
    .update(s.branch)
    .set({ birthdayManagerContact: { name: 'ZZ TEST birthday manager', appUserId: managerAppUserId, phone: null, channel: 'whatsapp' } })
    .where(eq(s.branch.id, branchId));
  ctx.app.otoAppDirectory = directory;
}, 180_000);
afterAll(async () => {
  if (ctx) {
    await ctx.db.update(s.branch).set({ birthdayManagerContact: savedContact as never }).where(eq(s.branch.id, branchId));
    await ctx.close();
  }
  await teardownAll();
});

describe('SCRUM-996: the row label and the next action', () => {
  it('no label while unpaid; once the simulator payment is verified the birthdays team and an assign holder see "paid", and the list tells staff to act', async () => {
    const f = await fixture();
    const d = await requested(f);
    for (const auth of [birthdayCookie, managerCookie]) {
      const before = await list(auth);
      expect(rowOf(before, f.conversationId)?.depositSignal ?? null).toBeNull();
      expect(rowOf(before, f.conversationId)?.nextAction).not.toBe('staff_action_needed');
      expect(grouped(before, [f.conversationId])).toEqual([]);
    }
    await pay(d);
    for (const auth of [birthdayCookie, managerCookie]) {
      const after = await list(auth);
      expect(rowOf(after, f.conversationId)).toMatchObject({ depositSignal: 'paid', nextAction: 'staff_action_needed' });
      expect(grouped(after, [f.conversationId])).toEqual([f.conversationId]);
    }
    const detail = await ctx.app.inject({ method: 'GET', url: `/inbox/conversations/${f.conversationId}`, headers: { cookie: birthdayCookie } });
    expect(detail.json()).toMatchObject({ depositSignal: 'paid', nextAction: 'staff_action_needed' });
    // Payment never books by itself (SCRUM-987).
    expect(events.has(d.id)).toBe(false);
  });

  it('a person who sees the chat but cannot book gets the label and no deposit detail; a restricted viewer does not get the row', async () => {
    const f = await fixture();
    const d = await requested(f);
    await pay(d);
    const page = await list(reader.cookie);
    const row = rowOf(page, f.conversationId)!;
    expect(row.depositSignal).toBe('paid');
    expect(grouped(page, [f.conversationId])).toEqual([f.conversationId]);
    // The row's own deposit field is the words only: no amount, time, link or provider.
    for (const key of ['amountSatang', 'paidAt', 'paymentLink', 'simulator', 'draft', 'deposit'])
      expect(Object.keys(row)).not.toContain(key);
    // The amount, the verified time and the dialog stay with people who may book.
    expect((await readDeposit(f.conversationId, reader.cookie)).statusCode).toBe(403);
    expect((await readDeposit(f.conversationId, birthdayCookie)).statusCode).toBe(200);

    const current = await ctx.app.inject({ method: 'GET', url: `/accounts/${restricted.accountId}/inbox-access`, headers: { cookie } });
    expect(current.statusCode, current.body).toBe(200);
    const limited = await ctx.app.inject({
      method: 'PUT',
      url: `/accounts/${restricted.accountId}/inbox-access`,
      headers: { cookie, 'idempotency-key': newId() },
      payload: { categories: ['general'], channelAccountIds: null, expectedVersion: current.json().version },
    });
    expect(limited.statusCode, limited.body).toBe(200);
    const fenced = await list(restricted.cookie);
    expect(rowOf(fenced, f.conversationId)).toBeUndefined();
    expect(grouped(fenced, [f.conversationId])).toEqual([]);
  });

  it('"Deposit paid · date passed" when the party date has gone by, still in the group', async () => {
    const f = await fixture();
    const d = await requested(f);
    await pay(d);
    await ctx.db
      .update(s.prebookingDraft)
      .set({ booking: { ...f.booking, date: '2001-01-01' } })
      .where(eq(s.prebookingDraft.id, d.id));
    const page = await list(birthdayCookie);
    expect(rowOf(page, f.conversationId)?.depositSignal).toBe('paid_date_passed');
    expect(grouped(page, [f.conversationId])).toEqual([f.conversationId]);
  });
});

describe('SCRUM-996: the "Ready to book" group', () => {
  it('holds the tab\'s paid chats first, newest activity first, while the list keeps its last-activity order', async () => {
    const a = await fixture('ZZ TEST 996 group A');
    const b = await fixture('ZZ TEST 996 group B');
    const waiting = await fixture('ZZ TEST 996 group unpaid');
    await pay(await requested(a));
    await pay(await requested(b));
    await requested(waiting);
    await ctx.db
      .update(s.conversation)
      .set({ lastMessageAt: new Date(Date.now() + 60_000) })
      .where(eq(s.conversation.id, waiting.conversationId));
    const ours = [a.conversationId, b.conversationId, waiting.conversationId];
    const page = await list(cookie);
    expect(grouped(page, ours)).toEqual([b.conversationId, a.conversationId]);
    // The list itself is unchanged: last activity, the unpaid newest first.
    expect(page.conversations.map((r) => r.id).filter((id) => ours.includes(id))).toEqual([
      waiting.conversationId,
      b.conversationId,
      a.conversationId,
    ]);
    // Sent with the first page only.
    const first = await list(cookie, 'tab=team&limit=1');
    expect(first.readyToBook).toBeDefined();
    const next = await list(cookie, `tab=team&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(next.readyToBook).toBeUndefined();
    // Each tab holds its own: nothing of these in Handled, nor in a Mine that holds none of them.
    expect(grouped(await list(cookie, 'tab=handled&limit=100'), ours)).toEqual([]);
    expect(grouped(await list(reader.cookie, 'tab=mine&limit=100'), ours)).toEqual([]);
  });

  it('a chat marked Handled before the money arrives stays in Handled, with the label, in that tab\'s group', async () => {
    const f = await fixture();
    const d = await requested(f);
    const handled = await post(f.conversationId, 'handle', {});
    expect(handled.statusCode, handled.body).toBe(200);
    await pay(d);
    const [conv] = await ctx.db.select().from(s.conversation).where(eq(s.conversation.id, f.conversationId));
    expect(conv!.status).toBe('handled');
    const archive = await list(cookie, 'tab=handled&limit=100');
    expect(rowOf(archive, f.conversationId)).toMatchObject({ depositSignal: 'paid', nextAction: 'handled', status: 'handled' });
    expect(grouped(archive, [f.conversationId])).toEqual([f.conversationId]);
    const team = await list(cookie);
    expect(rowOf(team, f.conversationId)).toBeUndefined();
    expect(grouped(team, [f.conversationId])).toEqual([]);
  });
});

describe('SCRUM-996: money that went wrong needs checking, never paid', () => {
  it('a part payment, also after a staff receipt, reads "needs checking": not in the group, no family line, no bell', async () => {
    const f = await fixture();
    const d = await requested(f);
    const a = await attemptOf(d.id);
    await simulateGatewayEvent(ctx.db, ctx.app.env, ctx.app.log, { attemptId: a.id, event: 'paid', operatorId, amountSatang: 100 });
    expect((await attemptOf(d.id)).status).toBe('awaiting_staff_confirmation');
    let page = await list(birthdayCookie);
    expect(rowOf(page, f.conversationId)).toMatchObject({ depositSignal: 'needs_checking', nextAction: 'staff_action_needed' });
    expect(grouped(page, [f.conversationId])).toEqual([]);
    expect(rowOf(await list(reader.cookie), f.conversationId)?.depositSignal).toBe('needs_checking');
    expect((await readDeposit(f.conversationId)).json().draft.state).toBe('needs_review');
    await ctx.db.transaction((tx) =>
      confirmAttempt(tx, { operatorId, accountId, assertBranchAllowed: async () => undefined }, a.id, {
        took: true,
        note: 'ZZ TEST manual receipt is not gateway proof',
      }),
    );
    page = await list(birthdayCookie);
    expect(rowOf(page, f.conversationId)?.depositSignal).toBe('needs_checking');
    expect(grouped(page, [f.conversationId])).toEqual([]);
    expect(await messagesOf(f.conversationId)).toHaveLength(1);
    expect(await paidPills(f.conversationId)).toHaveLength(0);
    expect(bellsFor(f.conversationId)).toHaveLength(0);
  });

  it('a payment after the link ran out reads "needs checking" and never counts as paid', async () => {
    const f = await fixture();
    const d = await requested(f);
    const a = await attemptOf(d.id);
    await simulateGatewayEvent(ctx.db, ctx.app.env, ctx.app.log, { attemptId: a.id, event: 'late_paid', operatorId });
    expect((await attemptOf(d.id)).status).toBe('awaiting_staff_confirmation');
    const page = await list(birthdayCookie);
    expect(rowOf(page, f.conversationId)?.depositSignal).toBe('needs_checking');
    expect(grouped(page, [f.conversationId])).toEqual([]);
    expect(await messagesOf(f.conversationId)).toHaveLength(1);
    expect(bellsFor(f.conversationId)).toHaveLength(0);
  });

  it('an unpaid link that ran out carries no label', async () => {
    const f = await fixture();
    const d = await requested(f);
    const a = await attemptOf(d.id);
    (gatewayFor(ctx.app.env).qr as unknown as { apply(invoice: string, action: string): unknown }).apply(a.invoiceNo!, 'expire');
    await pollPendingAttempts(ctx.db, ctx.app.env, ctx.app.log, new Date(Date.now() + 60_000));
    expect(rowOf(await list(birthdayCookie), f.conversationId)?.depositSignal ?? null).toBeNull();
  });
});

describe('SCRUM-996: the family\'s line and the birthday manager\'s bell', () => {
  it('after the payment is saved the family gets the received line and the manager\'s bell rings, once each, never again on a replay', async () => {
    const f = await fixture();
    const d = await requested(f);
    const a = await pay(d);
    const received = await receivedTemplateIds();
    const lines = (await messagesOf(f.conversationId)).filter((m) => m.templateId && received.has(m.templateId));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ direction: 'outbound', authorKind: 'ai' });
    expect(lines[0]!.body).toContain('฿3,000');
    expect(lines[0]!.body).toContain('21 November 2099');
    const pills = await paidPills(f.conversationId);
    expect(pills).toHaveLength(1);
    expect(pills[0]!.payload).toMatchObject({ draftId: d.id, paymentAttemptId: a.id, amountSatang: 300_000, simulator: true });
    const bells = bellsFor(f.conversationId);
    expect(bells).toHaveLength(1);
    expect(bells[0]).toMatchObject({ recipientUserId: managerAppUserId, referenceType: 'inbox_conversation' });
    // No family's name or number in the bell.
    expect(bells[0]!.body).not.toContain('ZZ TEST 996 parent');
    expect(bells[0]!.title).not.toContain('ZZ TEST');
    // The received line starts no assistant turn.
    expect(await ctx.db.select().from(s.aiTurn).where(eq(s.aiTurn.conversationId, f.conversationId))).toHaveLength(0);

    // A replayed gateway message, and the step itself run again.
    const replay = await simulateGatewayEvent(ctx.db, ctx.app.env, ctx.app.log, { attemptId: a.id, event: 'paid', operatorId });
    expect(['duplicate', 'already_settled']).toContain(replay.webhookOutcome);
    await afterPrebookingDepositPaid(ctx.db, ctx.app.log, { attemptId: a.id, source: 'webhook' });
    expect((await messagesOf(f.conversationId)).filter((m) => m.templateId && received.has(m.templateId))).toHaveLength(1);
    expect(await paidPills(f.conversationId)).toHaveLength(1);
    expect(bellsFor(f.conversationId)).toHaveLength(1);
  });

  it('a message or bell that fails leaves the payment settled and the chat paid', async () => {
    const f = await fixture();
    const d = await requested(f);
    const posting = vi.spyOn(partyMessages, 'postPartyMessage').mockRejectedValueOnce(new Error('ZZ TEST interrupted post'));
    failNotify = true;
    try {
      await pay(d);
    } finally {
      posting.mockRestore();
      failNotify = false;
    }
    expect((await attemptOf(d.id)).status).toBe('approved');
    expect((await readDeposit(f.conversationId)).json().draft.state).toBe('paid');
    expect(rowOf(await list(birthdayCookie), f.conversationId)?.depositSignal).toBe('paid');
    expect(await messagesOf(f.conversationId)).toHaveLength(1);
    expect(bellsFor(f.conversationId)).toHaveLength(1);
    const [noted] = await ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.entityId, d.id), eq(s.auditLog.action, 'inbox.prebooking.notify')));
    expect(noted?.after).toMatchObject({ state: 'failed' });
  });
});

describe('SCRUM-996: the label goes', () => {
  it('after Book Date, and does not come back on a replay of the booking', async () => {
    const f = await fixture();
    const d = await requested(f);
    await pay(d);
    const key = newId();
    expect((await post(f.conversationId, 'book-date', f.booking, birthdayCookie, key)).statusCode).toBe(200);
    let page = await list(birthdayCookie);
    expect(rowOf(page, f.conversationId)?.depositSignal ?? null).toBeNull();
    expect(rowOf(page, f.conversationId)?.nextAction).not.toBe('staff_action_needed');
    expect(grouped(page, [f.conversationId])).toEqual([]);
    expect((await post(f.conversationId, 'book-date', f.booking, birthdayCookie, key)).statusCode).toBe(200);
    page = await list(birthdayCookie);
    expect(rowOf(page, f.conversationId)?.depositSignal ?? null).toBeNull();
    expect(grouped(page, [f.conversationId])).toEqual([]);
  });

  it('after a refund of the receipt, with no "needs checking" in its place', async () => {
    const f = await fixture();
    const d = await requested(f);
    const a = await pay(d);
    const [station] = await ctx.db.select().from(s.station).where(eq(s.station.branchId, branchId)).limit(1);
    const saleId = newId();
    await ctx.db.insert(s.sale).values({
      id: saleId,
      operatorId,
      branchId,
      stationId: station!.id,
      businessDate: '2026-11-19',
      businessDayStart: '06:00',
      timezone: 'Asia/Bangkok',
      occurredAt: new Date(),
      createdByAccountId: accountId,
      pricingMode: 'weekday',
      pricingModeReason: 'ZZ TEST',
      customerTier: 'tourist',
      engineVersion: 'ZZ TEST',
      taxConfig: {},
      taxBreakdown: {},
    });
    await ctx.db.insert(s.refund).values({
      id: newId(),
      operatorId,
      branchId,
      stationId: station!.id,
      saleId,
      number: `ZZ TEST-${newId()}`,
      amountSatang: 300_000,
      mode: 'custom',
      reason: 'ZZ TEST deposit returned',
      approvedByAccountId: accountId,
      createdByAccountId: accountId,
      tenderAllocation: [
        { attemptId: a.id, amountSatang: 300_000, route: 'gateway_refund', status: 'done', methodCode: 'promptpay', method: 'qr', provider: 'simulator' },
      ],
    });
    const page = await list(birthdayCookie);
    expect(rowOf(page, f.conversationId)?.depositSignal ?? null).toBeNull();
    expect(grouped(page, [f.conversationId])).toEqual([]);
  });

  it('when the chat is archived', async () => {
    const f = await fixture();
    const d = await requested(f);
    await pay(d);
    await ctx.db
      .update(s.conversation)
      .set({ archivedAt: new Date(), archivedByAccountId: accountId })
      .where(eq(s.conversation.id, f.conversationId));
    const page = await list(cookie);
    expect(rowOf(page, f.conversationId)).toBeUndefined();
    expect(grouped(page, [f.conversationId])).toEqual([]);
  });
});

describe('SCRUM-996 review: what stands, as found', () => {
  it('PIN: the thread is unchanged in who reads it — the family\'s own lines (the request since SCRUM-987, now the received line) name the amount to whoever sees the chat, in the preview too', async () => {
    const f = await fixture();
    const d = await requested(f);
    expect(rowOf(await list(reader.cookie), f.conversationId)?.lastMessagePreview).toContain('฿3,000');
    await pay(d);
    const row = rowOf(await list(reader.cookie), f.conversationId)!;
    expect(row.lastMessagePreview).toContain('฿3,000');
    expect(row.depositSignal).toBe('paid');
  });

  // FINDING (MEDIUM, owner question; the reused words are the owner's choice 6
  // and stay the default): the family is told "your party on <date> is
  // confirmed" when the money is verified, as the request line already
  // promised ("Your booking is confirmed as soon as the deposit arrives",
  // SCRUM-987), while the calendar booking still waits for a person to check
  // capacity and press Book Date. Prescribed fix only if the owner asks: a
  // pre-booking wording under its own template key, in English, Thai and
  // Russian. Recorded in deposit-paid-notice.md section 7.
  it.fails('FINDING: the received line does not tell the family the party is confirmed before Book Date', async () => {
    const f = await fixture();
    const d = await requested(f);
    await pay(d);
    const received = await receivedTemplateIds();
    const [line] = (await messagesOf(f.conversationId)).filter((m) => m.templateId && received.has(m.templateId));
    expect(line!.body).not.toContain('is confirmed');
  });
});
