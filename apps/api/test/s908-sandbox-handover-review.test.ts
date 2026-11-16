import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import { TWILIO_SANDBOX_NUMBER } from '@oto/messaging';
import { newId } from '@oto/shared';
import { teardownAll } from './helpers';
import { aiWorld, customer, decision, kb, nextPhone, simAccount, staff, teamOf, turnsOf, type AiWorld } from './inbox-ai-support';
import { runInboxAiJob } from '../src/services/inbox/ai-engine';
import { deliverHandoverNotices, handoverNoticesOf, queueHandoverNotices, runHandoverEscalationJob, TEST_LINE_SUPPRESSED, type HandoverNoticeDeps } from '../src/services/inbox/handover-notice';

// Adversarial regression review: fictional contacts, fake model and captured
// notice senders. No Twilio request or actual manager notification is made.
let w: AiWorld;
let bells = 0;
let pings = 0;
const deps: HandoverNoticeDeps = {
  directory: { configured: true, notify: async (b) => {
    bells += 1;
    return { ok: true, status: 201, body: { notification: { id: b.id, recipientUserId: b.recipientUserId, type: 'inbox_handover', createdAt: new Date().toISOString() }, replayed: false } };
  } },
  sender: { send: async () => { pings += 1; } },
  pingLive: true,
};

beforeAll(async () => {
  w = await aiWorld();
  const team = await teamOf(w, 'birthdays');
  const [actor] = await staff(w, '+66898700903', 'ZZ TEST review agent', 'inbox_agent', { scopeType: 'department', scopeId: team.departmentId! });
  await kb(w, actor, { key: 'faq.party-room', topic: 'faq', language: 'en', question: 'Do you have a party room?', body: 'Both parks have a private party room.' });
  await w.ctx.db.update(s.branch).set({ birthdayManagerContact: { name: 'ZZ TEST manager', appUserId: 'zz-manager', phone: '+66898700901', channel: 'whatsapp' }, gmContact: { name: 'ZZ TEST GM', appUserId: 'zz-gm', phone: '+66898700902', channel: 'whatsapp' } }).where(eq(s.branch.id, w.central));
}, 300_000);
afterAll(async () => { await w?.ctx.close(); await teardownAll(); });
afterEach(async () => {
  // Each review case owns its channels/notices; later sweeps must not consume
  // an earlier case's notices or collide with the sandbox's unique sender.
  await w.ctx.db.delete(s.handoverNotification);
  await w.ctx.db.update(s.channelAccount).set({ provider: 'simulator', externalId: sql`'zz-review-' || ${s.channelAccount.id}` }).where(eq(s.channelAccount.provider, 'twilio'));
});

async function handover() {
  const account = await simAccount(w, { branchId: w.central, defaultCategory: 'birthdays' });
  const conv = await customer(w, account, nextPhone(), 'Which branch do you recommend for 12 kids?');
  w.fake.push({ kind: 'decision', decision: decision({ intent: 'faq', grounding: ['faq.party-room'], reason: 'FACT_IN_KB', bubbles: ['Central Floresta is our biggest park, perfect for 12 kids.'] }) });
  const at = new Date(Date.now() + 25_000);
  const summary = await runInboxAiJob(w.ctx.db, { runtime: w.ctx.app.inboxAi, channels: w.ctx.app.inboxChannels, storage: w.ctx.app.fileStorage, now: () => at }, at);
  expect(summary.handedOver).toBe(1);
  const [turn] = await turnsOf(w, conv.id);
  expect(turn?.state).toBe('handed_over');
  return { account, conv, turn: turn!, at };
}
async function sandbox(account: string, externalId = TWILIO_SANDBOX_NUMBER) {
  await w.ctx.db.update(s.channelAccount).set({ provider: 'twilio', externalId }).where(eq(s.channelAccount.id, account));
}
const rowsOf = (id: string) => w.ctx.db.select().from(s.handoverNotification).where(eq(s.handoverNotification.conversationId, id));

describe('SCRUM-908 sandbox handover review', () => {
  it('P1 FIXED: sandbox advice remains a staff-visible handover but queues no real manager notice, even without a branch', async () => {
    const { account, conv, turn, at } = await handover();
    await w.ctx.db.delete(s.handoverNotification).where(eq(s.handoverNotification.conversationId, conv.id));
    await sandbox(account);
    await w.ctx.db.update(s.conversation).set({ branchId: null }).where(eq(s.conversation.id, conv.id));
    const count = await w.ctx.db.transaction((tx) => queueHandoverNotices(tx, { operatorId: w.oto, conversationId: conv.id, turnId: turn.id, branchId: null, destination: 'birthdays', intents: ['birthday_advice'], at }));
    expect(count).toBe(0);
    expect(await rowsOf(conv.id)).toEqual([]);
    const events = await w.ctx.db.select().from(s.inboxEvent).where(and(eq(s.inboxEvent.conversationId, conv.id), eq(s.inboxEvent.kind, 'ai_handover')));
    expect(events).toHaveLength(1);
    expect((await w.ctx.db.select().from(s.conversation).where(eq(s.conversation.id, conv.id)))[0]?.category).toBe('birthdays');
  });

  it('P1 FIXED: pending manager bells, phone pings and already queued GM notices are skipped before any sender runs', async () => {
    const { account, conv, turn, at } = await handover();
    const originals = await rowsOf(conv.id);
    expect(originals).toHaveLength(2);
    await w.ctx.db.insert(s.handoverNotification).values({ id: newId(), operatorId: w.oto, conversationId: conv.id, turnId: turn.id, branchId: w.central, destination: 'birthdays', intent: 'birthday_advice', kind: 'escalation', channel: 'app', target: 'zz-gm', createdAt: at, updatedAt: at });
    await sandbox(account);
    bells = 0; pings = 0;
    const sent = await deliverHandoverNotices(w.ctx.db, deps, new Date(at.getTime() + 60_000));
    expect(sent).toMatchObject({ claimed: 3, sent: 0, skipped: 3 });
    expect({ bells, pings }).toEqual({ bells: 0, pings: 0 });
    expect((await rowsOf(conv.id)).every((r) => r.state === 'skipped' && r.errorCode === TEST_LINE_SUPPRESSED && r.sentAt === null)).toBe(true);
    expect(await handoverNoticesOf(w.ctx.db, w.oto, conv.id)).toEqual([]);
    expect((await runHandoverEscalationJob(w.ctx.db, deps, new Date(at.getTime() + 20 * 60_000))).escalated).toBe(0);
    expect(await rowsOf(conv.id)).toHaveLength(3);
  });

  it('P1 control: a non-sandbox Twilio sender still notifies the manager and escalates to the GM normally', async () => {
    const { account, conv, turn, at } = await handover();
    await sandbox(account, '+66898700999');
    await w.ctx.db.delete(s.handoverNotification).where(eq(s.handoverNotification.conversationId, conv.id));
    expect(await w.ctx.db.transaction((tx) => queueHandoverNotices(tx, { operatorId: w.oto, conversationId: conv.id, turnId: turn.id, branchId: w.central, destination: 'birthdays', intents: ['birthday_advice'], at }))).toBe(2);
    bells = 0; pings = 0;
    expect((await deliverHandoverNotices(w.ctx.db, deps, at)).sent).toBe(2);
    expect({ bells, pings }).toEqual({ bells: 1, pings: 1 });
    expect((await runHandoverEscalationJob(w.ctx.db, deps, new Date(at.getTime() + 20 * 60_000))).escalated).toBe(1);
    expect((await rowsOf(conv.id)).filter((r) => r.kind === 'escalation' && r.state === 'sent')).toHaveLength(2);
    expect({ bells, pings }).toEqual({ bells: 2, pings: 2 });
  });

  it('P2 FIXED: more than a full batch of historical sent sandbox turns cannot starve a real overdue handover', async () => {
    const demo = await handover();
    const original = (await rowsOf(demo.conv.id))[0]!;
    await w.ctx.db.update(s.handoverNotification).set({ state: 'sent', sentAt: demo.at }).where(eq(s.handoverNotification.conversationId, demo.conv.id));
    const history = Array.from({ length: 26 }, () => ({ ...demo.turn, id: newId() }));
    await w.ctx.db.insert(s.aiTurn).values(history);
    await w.ctx.db.insert(s.handoverNotification).values(history.map((t) => ({ ...original, id: newId(), turnId: t.id, state: 'sent' as const, sentAt: demo.at })));
    await sandbox(demo.account);
    const real = await handover();
    bells = 0; pings = 0;
    const sweep = await runHandoverEscalationJob(w.ctx.db, deps, new Date(real.at.getTime() + 20 * 60_000));
    expect(sweep).toMatchObject({ checked: 1, escalated: 1 });
    expect((await rowsOf(real.conv.id)).filter((r) => r.kind === 'escalation' && r.state === 'sent')).toHaveLength(2);
    const old = await rowsOf(demo.conv.id);
    expect(old).toHaveLength(28);
    expect(old.every((r) => r.kind === 'notice' && r.state === 'sent' && r.sentAt !== null && r.errorCode === null && r.escalatedAt === null && r.pickedUpAt === null)).toBe(true);
  });
});
