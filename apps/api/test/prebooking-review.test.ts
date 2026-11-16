import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema as s } from '@oto/db';
import {
  InboxPrebookingSchema,
  newId,
  type InboxBookDateBody,
  type InboxPrebooking,
} from '@oto/shared';
import { gatewayFor, pollPendingAttempts } from '../src/services/payments/gateway';
import {
  prebookingEventDeposit,
  verifiedPrebookingAttempt,
} from '../src/services/inbox/prebooking';
import * as partyMessages from '../src/services/inbox/party-messages';
import { runInboxSendJob } from '../src/services/inbox/send';
import { confirmAttempt } from '../src/services/payments/terminal';
import type { DirectoryInboxEventBody, OtoAppDirectory } from '../src/services/otoapp-directory';
import {
  ADMIN,
  RECEPTION,
  BRANCH_MANAGER,
  CHALONG_BRANCH_CODE,
  CENTRAL_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  SECOND_OPERATOR_ADMIN,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/** SCRUM-987 adversarial pins: the existing ledger is proof, a draft never reserves a date. */
let ctx: TestContext;
let operatorId: string;
let branchId: string;
let accountId: string;
let cookie: string;
let foreignCookie: string;
let channelId: string;
let teamId: string;
let birthdayCookie: string;
let managerCookie: string;
let otherBranchId: string;
const calls: DirectoryInboxEventBody[] = [];
const events = new Map<string, DirectoryInboxEventBody>();
let loseAnswer = false;
const directory: OtoAppDirectory = {
  configured: true,
  async addAttendee() {
    return { ok: false, status: null, code: 'unused', message: 'unused', retryable: true };
  },
  async checkinAttendee() {
    return { ok: false, status: null, code: 'unused', message: 'unused', retryable: true };
  },
  async createInboxEvent(body) {
    calls.push(body);
    const prior = events.get(body.id);
    events.set(body.id, prior ?? body);
    if (loseAnswer) {
      loseAnswer = false;
      return {
        ok: false,
        status: null,
        code: 'OTOAPP_DIRECTORY_UNREACHABLE',
        message: 'lost answer',
        retryable: true,
      };
    }
    const b = prior ?? body;
    return {
      ok: true,
      status: prior ? 200 : 201,
      body: {
        replayed: Boolean(prior),
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
const post = (conversationId: string, route: string, payload: unknown, auth = cookie) =>
  ctx.app.inject({
    method: 'POST',
    url: `/inbox/conversations/${conversationId}/${route}`,
    headers: { cookie: auth, 'idempotency-key': newId() },
    payload: payload as never,
  });
const read = async (conversationId: string) =>
  InboxPrebookingSchema.parse(
    (
      await ctx.app.inject({
        method: 'GET',
        url: `/inbox/conversations/${conversationId}/prebooking`,
        headers: { cookie },
      })
    ).json(),
  );
async function fixture() {
  const contactId = newId();
  const conversationId = newId();
  await ctx.db.insert(s.contact).values({
    id: contactId,
    operatorId,
    channel: 'whatsapp',
    externalHandle: newId(),
    displayName: 'ZZ TEST deposit parent',
  });
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
  return {
    conversationId,
    booking,
    request: { booking, amountSatang: 300_000, requestId: newId() },
  };
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
    .innerJoin(
      s.paymentAttempt,
      eq(s.paymentAttempt.id, s.prebookingDepositRequest.paymentAttemptId),
    )
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
}
beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      PGW_PROVIDER: 'simulator',
      PAYMENTS_SIMULATOR: 'on',
      PGW_MERCHANT_ID: 'ZZTEST987',
      PGW_SECRET_KEY: randomBytes(32).toString('hex'),
      PGW_WEBHOOK_SECRET: 'zz987',
      PGW_BACKEND_RETURN_URL: 'https://api.example.test/webhooks/2c2p/payment?t=zz987',
      INBOX_SIMULATOR: 'on',
      INBOX_SIMULATOR_SECRET: randomBytes(24).toString('hex'),
    },
  });
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const [account] = await ctx.db.select().from(s.account).where(eq(s.account.phone, ADMIN.phone));
  accountId = account!.id;
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  foreignCookie = await signInAs(
    ctx.app,
    SECOND_OPERATOR_ADMIN.phone,
    SECOND_OPERATOR_ADMIN.password,
  );
  const [team] = await ctx.db
    .select()
    .from(s.team)
    .where(and(eq(s.team.operatorId, operatorId), eq(s.team.key, 'birthdays')));
  teamId = team!.id;
  otherBranchId = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [birthdayAccount] = await ctx.db
    .select()
    .from(s.account)
    .where(eq(s.account.phone, RECEPTION.phone));
  const [managerAccount] = await ctx.db
    .select()
    .from(s.account)
    .where(eq(s.account.phone, BRANCH_MANAGER.phone));
  const [agentRole] = await ctx.db
    .select()
    .from(s.role)
    .where(and(eq(s.role.operatorId, operatorId), eq(s.role.name, 'inbox_agent')));
  const [managerRole] = await ctx.db
    .select()
    .from(s.role)
    .where(and(eq(s.role.operatorId, operatorId), eq(s.role.name, 'inbox_manager')));
  await ctx.db.insert(s.roleAssignment).values([
    {
      id: newId(),
      accountId: birthdayAccount!.id,
      roleId: agentRole!.id,
      scopeType: 'department',
      scopeId: team!.departmentId!,
    },
    {
      id: newId(),
      accountId: managerAccount!.id,
      roleId: managerRole!.id,
      scopeType: 'branch',
      scopeId: branchId,
    },
  ]);
  birthdayCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  channelId = newId();
  await ctx.db.insert(s.channelAccount).values({
    id: channelId,
    operatorId,
    branchId,
    channel: 'whatsapp',
    provider: 'simulator',
    externalId: `zz-test-${newId()}`,
    displayName: 'ZZ TEST deposit gate',
    canReply: true,
    status: 'active',
  });
  ctx.app.otoAppDirectory = directory;
});
afterAll(async () => {
  if (ctx) await ctx.close();
  await teardownAll();
});

describe('SCRUM-987 passing adversarial pins', () => {
  it('P0: only scoped managers choose/request the amount; the birthdays team can read and explicitly book the gateway-paid draft', async () => {
    const f = await fixture();
    expect((await post(f.conversationId, 'prebooking', f.request, birthdayCookie)).statusCode).toBe(
      403,
    );
    expect(
      (
        await post(
          f.conversationId,
          'prebooking',
          { ...f.request, booking: { ...f.booking, branchId: otherBranchId } },
          managerCookie,
        )
      ).statusCode,
    ).toBe(403);
    const own = await post(f.conversationId, 'prebooking', f.request, managerCookie);
    expect(own.statusCode, own.body).toBe(200);
    const d = InboxPrebookingSchema.parse(own.json()).draft!;
    await pay(d);
    const readByTeam = await ctx.app.inject({
      method: 'GET',
      url: `/inbox/conversations/${f.conversationId}/prebooking`,
      headers: { cookie: birthdayCookie },
    });
    expect(readByTeam.statusCode).toBe(200);
    expect(readByTeam.json().draft.state).toBe('paid');
    expect((await post(f.conversationId, 'book-date', f.booking, birthdayCookie)).statusCode).toBe(
      200,
    );
  });
  it('P1: the deposit date is the actual paid instant in the park timezone, even days after the invoice and across Bangkok midnight', async () => {
    for (const [stamp, expected] of [
      ['2026-11-17T16:59:00.000Z', '2026-11-17'],
      ['2026-11-17T17:01:00.000Z', '2026-11-18'],
    ]) {
      const f = await fixture();
      const d = await requested(f);
      await pay(d);
      const a = await attemptOf(d.id);
      await ctx.db
        .update(s.paymentAttempt)
        .set({ businessDate: '2026-11-16', paidAt: new Date(stamp!) })
        .where(eq(s.paymentAttempt.id, a.id));
      const answer = await post(f.conversationId, 'book-date', f.booking);
      expect(answer.statusCode, answer.body).toBe(200);
      expect(events.get(d.id)?.verifiedDeposit?.paidDate).toBe(expected);
    }
  });
  it('P0: a real gateway partial-payment report stays blocked even after the existing staff-confirmation service records taken', async () => {
    const f = await fixture();
    const d = await requested(f);
    const a = await attemptOf(d.id);
    const simulator = gatewayFor(ctx.app.env).qr as unknown as {
      apply(invoice: string, event: string, options?: { amountSatang: number }): unknown;
    };
    simulator.apply(a.invoiceNo!, 'suppress_webhook', { amountSatang: 100 });
    await pollPendingAttempts(ctx.db, ctx.app.env, ctx.app.log, new Date(Date.now() + 60_000));
    expect((await attemptOf(d.id)).status).toBe('awaiting_staff_confirmation');
    await ctx.db.transaction((tx) =>
      confirmAttempt(
        tx,
        { operatorId, accountId, assertBranchAllowed: async () => undefined },
        a.id,
        { took: true, note: 'ZZ TEST manual receipt is not gateway proof' },
      ),
    );
    expect((await attemptOf(d.id)).status).toBe('approved');
    const denied = await post(f.conversationId, 'book-date', f.booking);
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error.code).toBe('DEPOSIT_NOT_VERIFIED');
    expect(events.has(d.id)).toBe(false);
  });
  it('P0: one family cannot claim another draft or the original gateway receipt', async () => {
    const first = await fixture();
    const d = await requested(first);
    await pay(d);
    const other = await fixture();
    const changed = await post(other.conversationId, 'prebooking', {
      ...other.request,
      booking: { ...other.booking, id: d.id },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe('ID_IN_USE');
    expect(
      (await post(other.conversationId, 'book-date', { ...other.booking, id: d.id })).statusCode,
    ).toBe(409);
    expect(events.has(d.id)).toBe(false);
  });
  it('P1: a failed post recovers the persisted hosted result with the same invoice and one message', async () => {
    const f = await fixture();
    const posting = vi
      .spyOn(partyMessages, 'postPartyMessage')
      .mockRejectedValueOnce(new Error('ZZ TEST interrupted post'));
    const failed = await post(f.conversationId, 'prebooking', f.request);
    posting.mockRestore();
    expect(failed.statusCode).toBe(500);
    const original = await attemptOf(f.booking.id);
    expect((original.payload as Record<string, unknown>).webPaymentUrl).toBeTypeOf('string');
    const retry = await post(f.conversationId, 'prebooking', f.request);
    expect(retry.statusCode, retry.body).toBe(200);
    expect((await attemptOf(f.booking.id)).id).toBe(original.id);
    expect(
      await ctx.db.select().from(s.message).where(eq(s.message.conversationId, f.conversationId)),
    ).toHaveLength(1);
  });
  it('P1: replay leaves a committed outbox line for the existing send job, which delivers once', async () => {
    const f = await fixture();
    const held = vi.spyOn(partyMessages, 'sendPartyMessages').mockResolvedValueOnce(undefined);
    await requested(f);
    held.mockRestore();
    const [queued] = await ctx.db
      .select()
      .from(s.message)
      .where(eq(s.message.conversationId, f.conversationId));
    expect(queued!.providerStatus).toBe('queued');
    await post(f.conversationId, 'prebooking', f.request);
    await runInboxSendJob(
      ctx.db,
      { channels: ctx.app.inboxChannels, storage: null, log: ctx.app.log },
      new Date(),
    );
    await runInboxSendJob(
      ctx.db,
      { channels: ctx.app.inboxChannels, storage: null, log: ctx.app.log },
      new Date(),
    );
    const rows = await ctx.db
      .select()
      .from(s.message)
      .where(eq(s.message.conversationId, f.conversationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.providerStatus).toBe('sent');
    expect(
      await ctx.db
        .select()
        .from(s.prebookingDepositRequest)
        .where(eq(s.prebookingDepositRequest.draftId, f.booking.id)),
    ).toHaveLength(1);
  });
  it('P0: direct creation without a request, a staff receipt or AI slip cannot reach the calendar', async () => {
    const f = await fixture();
    const before = calls.length;
    const answer = await post(f.conversationId, 'book-date', f.booking);
    expect(answer.statusCode).toBe(409);
    expect(answer.json().error.code).toBe('DEPOSIT_REQUIRED');
    expect(calls.length).toBe(before);
    expect(
      (
        await post(f.conversationId, 'book-date', {
          ...f.booking,
          depositPaid: true,
          slipVerified: true,
        })
      ).statusCode,
    ).toBe(400);
  });
  it('P0: request creates no event; duplicate and concurrent presses retain one invoice and one request line', async () => {
    const f = await fixture();
    const before = calls.length;
    const both = await Promise.all([
      post(f.conversationId, 'prebooking', f.request),
      post(f.conversationId, 'prebooking', f.request),
    ]);
    expect(both.map((a) => a.statusCode)).toEqual([200, 200]);
    expect(
      await ctx.db
        .select()
        .from(s.prebookingDepositRequest)
        .where(eq(s.prebookingDepositRequest.draftId, f.booking.id)),
    ).toHaveLength(1);
    expect(
      await ctx.db.select().from(s.message).where(eq(s.message.conversationId, f.conversationId)),
    ).toHaveLength(1);
    expect(calls.length).toBe(before);
    expect(events.has(f.booking.id)).toBe(false);
    const denied = await post(f.conversationId, 'book-date', f.booking);
    expect(denied.statusCode).toBe(409);
    expect(
      (await post(f.conversationId, 'prebooking', { ...f.request, amountSatang: 100 })).json().error
        .code,
    ).toBe('DEPOSIT_DRAFT_CHANGED');
    expect((await post(f.conversationId, 'prebooking', f.request, foreignCookie)).statusCode).toBe(
      404,
    );
  });
  it('P0: gateway payment enables an explicit booking, replays one original receipt and never auto-books', async () => {
    const f = await fixture();
    const d = await requested(f);
    await pay(d);
    expect((await read(f.conversationId)).draft?.state).toBe('paid');
    expect(events.has(d.id)).toBe(false);
    const answers = await Promise.all([
      post(f.conversationId, 'book-date', f.booking),
      post(f.conversationId, 'book-date', f.booking),
    ]);
    expect(
      answers.map((a) => a.statusCode),
      answers.map((a) => a.body).join('\n'),
    ).toEqual([200, 200]);
    expect(events.get(d.id)?.verifiedDeposit).toMatchObject({
      draftId: d.id,
      attemptId: (await attemptOf(d.id)).id,
      amountSatang: 300_000,
    });
    expect(
      await ctx.db
        .select()
        .from(s.inboxEvent)
        .where(
          and(
            eq(s.inboxEvent.conversationId, f.conversationId),
            eq(s.inboxEvent.kind, 'date_booked'),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await ctx.db
        .select()
        .from(s.prebookingDepositRequest)
        .where(eq(s.prebookingDepositRequest.draftId, d.id)),
    ).toHaveLength(1);
  });
  it('P1: lost directory answer freezes details and retries the same event and receipt', async () => {
    const f = await fixture();
    const d = await requested(f);
    await pay(d);
    loseAnswer = true;
    const lost = await post(f.conversationId, 'book-date', f.booking);
    expect(lost.statusCode, lost.body).toBe(503);
    const changed = await post(f.conversationId, 'book-date', { ...f.booking, date: '2099-11-22' });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe('BOOKING_CLAIM_CHANGED');
    expect((await post(f.conversationId, 'book-date', f.booking)).statusCode).toBe(200);
    expect(events.get(d.id)?.eventDate).toBe('2099-11-21');
  });
  it('P0: approved manual, partial, reversal, foreign park and wrong currency records fail the receipt predicate', async () => {
    const f = await fixture();
    const d = await requested(f);
    await pay(d);
    const a = await attemptOf(d.id);
    const [draft] = await ctx.db
      .select()
      .from(s.prebookingDraft)
      .where(eq(s.prebookingDraft.id, d.id));
    expect(verifiedPrebookingAttempt(draft!, a)).toBe(true);
    for (const altered of [
      { ...a, provider: 'manual' as const },
      { ...a, staffConfirmedByAccountId: accountId },
      { ...a, amountSatang: 100 },
      { ...a, branchId: newId() },
      { ...a, status: 'cancelled' as const },
      { ...a, payload: { ...(a.payload as object), currency: 'USD' } },
      { ...a, payload: { ...(a.payload as object), settledBy: 'staff' } },
      {
        ...a,
        payload: {
          ...(a.payload as object),
          void: { reason: 'partial_approval', amountSatang: 100 },
        },
      },
    ])
      expect(verifiedPrebookingAttempt(draft!, altered)).toBe(false);
    await ctx.db
      .update(s.paymentAttempt)
      .set({ staffConfirmedByAccountId: accountId })
      .where(eq(s.paymentAttempt.id, a.id));
    expect((await post(f.conversationId, 'book-date', f.booking)).statusCode).toBe(409);
  });
  it('P1: expired gateway invoice cannot book; a fresh request keeps the old invoice and paid amount fixed', async () => {
    const f = await fixture();
    const d = await requested(f);
    const first = await attemptOf(d.id);
    const sim = gatewayFor(ctx.app.env).qr as unknown as {
      apply(invoice: string, action: string): unknown;
    };
    sim.apply(first.invoiceNo!, 'expire');
    await pollPendingAttempts(ctx.db, ctx.app.env, ctx.app.log, new Date(Date.now() + 60_000));
    expect((await post(f.conversationId, 'book-date', f.booking)).statusCode).toBe(409);
    const answer = await post(f.conversationId, 'prebooking', { ...f.request, requestId: newId() });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(
      await ctx.db
        .select()
        .from(s.prebookingDepositRequest)
        .where(eq(s.prebookingDepositRequest.draftId, d.id)),
    ).toHaveLength(2);
    expect((await attemptOf(d.id)).invoiceNo).not.toBe(first.invoiceNo);
  });
  it('P1: a paid draft for a passed date keeps its money and is refused before any calendar call', async () => {
    const f = await fixture();
    const d = await requested(f);
    await pay(d);
    const before = calls.length;
    const answer = await post(f.conversationId, 'book-date', { ...f.booking, date: '2001-01-01' });
    expect(answer.statusCode).toBe(409);
    expect(answer.json().error.code).toBe('EVENT_DATE_PASSED');
    expect(calls.length).toBe(before);
    expect((await attemptOf(d.id)).status).toBe('approved');
    expect((await read(f.conversationId)).draft?.state).toBe('paid');
  });
  it('P1: an interrupted hosted opening is inquired, never reopened blindly, and terminal unpaid proof permits a new invoice', async () => {
    const f = await fixture();
    const d = await requested(f);
    const first = await attemptOf(d.id);
    (gatewayFor(ctx.app.env).qr as unknown as { payments: Map<string, unknown> }).payments.delete(
      first.invoiceNo!,
    );
    const { webPaymentUrl: _lost, ...payload } = first.payload as Record<string, unknown>;
    await ctx.db
      .update(s.paymentAttempt)
      .set({
        status: 'created',
        expiresAt: null,
        createdAt: new Date(Date.now() - 70_000),
        payload,
      })
      .where(eq(s.paymentAttempt.id, first.id));
    expect((await read(f.conversationId)).draft?.state).toBe('needs_review');
    expect((await post(f.conversationId, 'prebooking', f.request)).statusCode).toBe(200);
    expect(
      await ctx.db
        .select()
        .from(s.prebookingDepositRequest)
        .where(eq(s.prebookingDepositRequest.draftId, d.id)),
    ).toHaveLength(1);
    await pollPendingAttempts(ctx.db, ctx.app.env, ctx.app.log);
    expect((await attemptOf(d.id)).status).toBe('not_found');
    expect(
      (await post(f.conversationId, 'prebooking', { ...f.request, requestId: newId() })).statusCode,
    ).toBe(200);
    expect(
      await ctx.db
        .select()
        .from(s.prebookingDepositRequest)
        .where(eq(s.prebookingDepositRequest.draftId, d.id)),
    ).toHaveLength(2);
  });
  it('P0: an actual refund allocation against the original receipt blocks booking even while the attempt remains approved', async () => {
    const f = await fixture();
    const d = await requested(f);
    await pay(d);
    const a = await attemptOf(d.id);
    expect(await prebookingEventDeposit(ctx.db, operatorId, d.id)).toMatchObject({
      state: 'paid',
      amountSatang: 300_000,
    });
    const [station] = await ctx.db
      .select()
      .from(s.station)
      .where(eq(s.station.branchId, branchId))
      .limit(1);
    const saleId = newId();
    await ctx.db.insert(s.sale).values({
      id: saleId,
      operatorId,
      branchId,
      stationId: station!.id,
      businessDate: '2026-11-16',
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
      amountSatang: 100,
      mode: 'custom',
      reason: 'ZZ TEST original receipt returned',
      approvedByAccountId: accountId,
      createdByAccountId: accountId,
      tenderAllocation: [
        {
          attemptId: a.id,
          amountSatang: 100,
          route: 'gateway_refund',
          status: 'done',
          methodCode: 'promptpay',
          method: 'qr',
          provider: 'simulator',
        },
      ],
    });
    expect((await attemptOf(d.id)).status).toBe('approved');
    expect((await read(f.conversationId)).draft?.state).toBe('needs_review');
    expect(await prebookingEventDeposit(ctx.db, operatorId, d.id)).toBeNull();
    expect((await post(f.conversationId, 'book-date', f.booking)).statusCode).toBe(409);
    expect(events.has(d.id)).toBe(false);
  });
});
