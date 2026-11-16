import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import { newId } from '@oto/shared';
import { listConversations } from '../src/services/inbox/read';
import type { InboxViewer } from '../src/services/inbox/read-visibility';
import { createTestContext, operatorIdByName, OTO_OPERATOR_NAME, teardownAll, type TestContext } from './helpers';

let ctx: TestContext, viewer: InboxViewer, otherViewer: InboxViewer;
let operatorId: string, channelId: string, conversationId: string, inboundId: string;
const beginning = new Date('2026-11-16T12:00:00Z');
beforeAll(async () => {
  ctx = await createTestContext();
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  const accounts = await ctx.db.select({ id: s.account.id }).from(s.account).where(eq(s.account.operatorId, operatorId)).limit(2);
  const makeViewer = (accountId: string): InboxViewer => ({ accountId, operatorId,
    scope: { accountId, operatorWide: true, branchIds: [], departmentIds: [] } });
  viewer = makeViewer(accounts[0]!.id); otherViewer = makeViewer(accounts[1]!.id);
  channelId = newId(); const contactId = newId(); conversationId = newId(); inboundId = newId();
  await ctx.db.insert(s.channelAccount).values({ id: channelId, operatorId, channel: 'whatsapp', provider: 'simulator', externalId: newId(), displayName: 'ZZ TEST next action', aiMode: 'live' });
  await ctx.db.insert(s.contact).values({ id: contactId, operatorId, channel: 'whatsapp', externalHandle: newId() });
  await ctx.db.insert(s.conversation).values({ id: conversationId, operatorId, channelAccountId: channelId, contactId,
    createdAt: beginning, lastCustomerMessageAt: beginning, lastMessageAt: beginning });
  await ctx.db.insert(s.message).values({ id: inboundId, operatorId, conversationId, channelAccountId: channelId,
    authorKind: 'customer', direction: 'inbound', body: 'ZZ TEST question', createdAt: beginning });
}, 180000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });
const read = async (as = viewer) => (await listConversations(ctx.db, as, ['team', 'handled'], { limit: 100 })).conversations.find(row => row.id === conversationId)!;

describe('SCRUM-992 adversarial SQL review: next action and personal unread', () => {
  it('HIGH: reading for one viewer never clears the other viewer or the staff-needed state', async () => {
    await ctx.db.insert(s.participant).values({ id: newId(), operatorId, conversationId, accountId: viewer.accountId,
      lastReadMessageId: inboundId, lastReadAt: beginning });
    expect(await read()).toMatchObject({ unread: 0, nextAction: 'staff_reply_needed', unanswered: true });
    expect(await read(otherViewer)).toMatchObject({ unread: 1, nextAction: 'staff_reply_needed', unanswered: true });
  });
  it.each(['queued', 'sent', 'delivered', 'read', 'failed', 'shadow', 'withdrawn'] as const)('HIGH: real %s outbound delivery drives the next-action label', async providerStatus => {
    const id = newId();
    await ctx.db.insert(s.message).values({ id, operatorId, conversationId, channelAccountId: channelId,
      direction: 'outbound', authorKind: 'ai', body: 'ZZ TEST reply',
      // The established shadow writer uses this database-only status too.
      providerStatus: providerStatus === 'shadow' ? 'shadow' as never : providerStatus,
      createdAt: new Date(beginning.getTime() + 1000) });
    const expected = providerStatus === 'queued' ? 'ai_replying' : providerStatus === 'shadow' ? 'shadow_preview'
      : ['sent', 'delivered', 'read'].includes(providerStatus) ? 'ai_sent' : 'staff_reply_needed';
    expect(await read()).toMatchObject({ nextAction: expected, unread: 0, unanswered: true });
    await ctx.db.delete(s.message).where(eq(s.message.id, id));
  });
  it('HIGH: a newer failed line cannot borrow an earlier successfully sent AI status', async () => {
    const ids = [newId(), newId()];
    await ctx.db.insert(s.message).values(ids.map((id, index) => ({ id, operatorId, conversationId,
      channelAccountId: channelId, direction: 'outbound' as const, authorKind: 'ai' as const,
      body: 'ZZ TEST delivery boundary', providerStatus: index === 0 ? 'sent' as const : 'failed' as const,
      createdAt: new Date(beginning.getTime() + 1000 + index) })));
    expect(await read()).toMatchObject({ nextAction: 'staff_reply_needed' });
    await ctx.db.delete(s.message).where(inArray(s.message.id, ids));
  });
  it('HIGH: a newer customer message invalidates an older successful AI reply', async () => {
    await ctx.db.insert(s.message).values({ id: newId(), operatorId, conversationId, channelAccountId: channelId,
      direction: 'outbound', authorKind: 'ai', body: 'ZZ TEST older reply', providerStatus: 'sent', createdAt: new Date(beginning.getTime() + 1000) });
    const latest = new Date(beginning.getTime() + 2000);
    const customer = newId();
    await ctx.db.insert(s.message).values({ id: customer, operatorId, conversationId, channelAccountId: channelId,
      direction: 'inbound', authorKind: 'customer', body: 'ZZ TEST newer question', createdAt: latest });
    await ctx.db.update(s.conversation).set({ lastCustomerMessageAt: latest, lastMessageAt: latest }).where(eq(s.conversation.id, conversationId));
    expect(await read()).toMatchObject({ nextAction: 'staff_reply_needed', unread: 1 });
    const turnId = newId();
    await ctx.db.insert(s.aiTurn).values({ id: turnId, operatorId, conversationId, triggerMessageId: customer, dueAt: latest });
    expect(await read()).toMatchObject({ nextAction: 'ai_replying', unread: 1 });
    await ctx.db.update(s.conversation).set({ aiPausedAt: latest }).where(eq(s.conversation.id, conversationId));
    expect(await read()).toMatchObject({ nextAction: 'staff_reply_needed', unread: 1 });
    await ctx.db.update(s.conversation).set({ aiPausedAt: null }).where(eq(s.conversation.id, conversationId));
    await ctx.db.update(s.channelAccount).set({ aiMode: 'shadow' }).where(eq(s.channelAccount.id, channelId));
    expect(await read()).toMatchObject({ nextAction: 'ai_previewing', unread: 1 });
    const staffMessageId = newId();
    await ctx.db.insert(s.message).values({ id: staffMessageId, operatorId, conversationId,
      channelAccountId: channelId, direction: 'outbound', authorKind: 'staff', authorAccountId: viewer.accountId,
      providerStatus: 'sent', body: 'ZZ TEST person took over', createdAt: new Date(latest.getTime() + 1000) });
    await ctx.db.update(s.channelAccount).set({ aiMode: 'live' }).where(eq(s.channelAccount.id, channelId));
    // The old turn deliberately remains pending: display must not trust cancellation timing.
    expect(await read()).toMatchObject({ nextAction: 'waiting_customer', unread: 1 });
    await ctx.db.delete(s.message).where(eq(s.message.id, staffMessageId));
    await ctx.db.insert(s.inboxEvent).values({ id: newId(), operatorId, conversationId, kind: 'branch_set',
      actorKind: 'account', actorAccountId: viewer.accountId, payload: {}, createdAt: new Date(latest.getTime() + 1000) });
    expect(await read()).toMatchObject({ nextAction: 'staff_reply_needed', unread: 1 });
    await ctx.db.update(s.conversation).set({ status: 'handled', handledAt: latest, handledByKind: 'account', handledByAccountId: viewer.accountId }).where(eq(s.conversation.id, conversationId));
    expect(await read()).toMatchObject({ nextAction: 'handled', unread: 1 });
  });
});
