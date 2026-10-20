import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import { newId } from '@oto/shared';
import { cancelAiForThread } from '../src/services/inbox/ai-turns';
import { withTx } from '../src/services/tx';
import { ADMIN, signInAs, teardownAll } from './helpers';
import {
  SENTINEL,
  aiLines,
  aiWorld,
  call,
  customer,
  decision,
  eventsOf,
  later,
  nextPhone,
  sim,
  simAccount,
  staff,
  teamOf,
  tick,
  turnsOf,
  type AiWorld,
} from './inbox-ai-support';
import { NO_LEAKS, sentinelLeaks } from './inbox-sentinel';

/**
 * SCRUM-590 round A2 lane a — A PERSON ALWAYS OUTRANKS THE ASSISTANT (plan
 * `docs/progress/plans/inbox-ai-build/PLAN.md` §A.3, §D.5, rails change R5;
 * checks §F.3 "A2"):
 *
 *   - a staff reply during the debounce cancels the turn and the assistant
 *     says nothing (golden G11); during typing time it withdraws the unsent
 *     lines;
 *   - each of the eight action callers — primary, add support, remove
 *     support, Divert, move, branch, handled, reopen — cancels the thread's
 *     turn in the action's own transaction, audited with the person;
 *   - the PDPA erasure cancels, and an erasure DURING the model call leaves
 *     the commit nothing to write;
 *   - the per-thread pause;
 *   - and no body reaches audit, events, ops or the log on any of it.
 */

let w: AiWorld;
let central: string;
let adminCookie: string;
let adminId: string;
let agent: string;
let agentCookie: string;
let agent2: string;
let eraserCookie: string;
let eraserId: string;

beforeAll(async () => {
  w = await aiWorld();
  central = await simAccount(w, { branchId: w.central });
  adminCookie = await signInAs(w.ctx.app, ADMIN.phone, ADMIN.password);
  const [admin] = await w.ctx.db.select({ id: s.account.id }).from(s.account).where(eq(s.account.phone, ADMIN.phone)).limit(1);
  adminId = admin!.id;
  const reception = await teamOf(w, 'reception', w.central);
  [agent, agentCookie] = await staff(w, '+66810009001', 'Cancel Test Agent', 'inbox_agent', {
    scopeType: 'department',
    scopeId: reception.departmentId!,
  });
  [agent2] = await staff(w, '+66810009002', 'Cancel Test Agent Two', 'inbox_agent', {
    scopeType: 'department',
    scopeId: reception.departmentId!,
  });
  const roleId = newId();
  await w.ctx.db.insert(s.role).values({ id: roleId, operatorId: w.oto, name: 'pdpa_eraser_ai', description: 'PDPA erasure' });
  await w.ctx.db.insert(s.rolePermission).values({ id: newId(), roleId, permission: 'inbox:contact:erase' });
  [eraserId, eraserCookie] = await staff(w, '+66810009003', 'Cancel Test Eraser', 'pdpa_eraser_ai', {
    scopeType: 'operator',
    scopeId: w.oto,
  });
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

/** A fresh thread whose turn is pending. */
async function pendingThread(text = `hello there ${SENTINEL}`) {
  const conv = await customer(w, central, nextPhone(), text);
  const turns = await turnsOf(w, conv.id);
  expect(turns.map((t) => t.state)).toEqual(['pending']);
  return { conv, turn: turns[0]! };
}

async function expectCancelled(turnId: string, reason: string, actor: string) {
  const [t] = await w.ctx.db.select().from(s.aiTurn).where(eq(s.aiTurn.id, turnId)).limit(1);
  expect(t).toMatchObject({ state: 'cancelled', reason, leaseUntil: null });
  const [row] = await w.ctx.db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.action, 'inbox.ai.turn.cancel'), eq(s.auditLog.entityId, turnId)))
    .limit(1);
  expect(row).toMatchObject({ actorAccountId: actor });
  expect(row!.after).toMatchObject({ turnId, reason, actorAccountId: actor });
  // And the job then has nothing to say on it.
  const before = w.fake.remaining;
  await tick(w, later(25_000));
  expect(w.fake.remaining).toBe(before);
  expect(await aiLines(w, t!.conversationId)).toHaveLength(0);
}

const reply = (cookie: string, conversationId: string, text: string) =>
  call(w, cookie, 'POST', `/inbox/conversations/${conversationId}/messages`, { id: newId(), text });

describe('a staff reply (§A.3)', () => {
  it('during the debounce cancels the turn: the assistant says nothing (G11)', async () => {
    const { conv, turn } = await pendingThread();
    const res = await reply(agentCookie, conv.id, `Hi, Mai here ${SENTINEL}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectCancelled(turn.id, 'STAFF_REPLY', agent);
  });

  it('during typing time withdraws the unsent assistant lines; they never leave', async () => {
    const { conv } = await pendingThread();
    w.fake.push({ kind: 'decision', decision: decision({ bubbles: [`Hi ${SENTINEL}!`, 'How can we help today?'] }) });
    expect((await tick(w, later(25_000))).answered).toBe(1);
    const lines = await aiLines(w, conv.id);
    expect(lines.map((l) => l.providerStatus)).toEqual(['queued', 'queued']);

    expect((await reply(agentCookie, conv.id, 'Hello! This is reception.')).status).toBe(200);
    const after = await aiLines(w, conv.id);
    expect(after.map((l) => l.providerStatus)).toEqual(['withdrawn', 'withdrawn']);
    const pills = (await eventsOf(w, conv.id)).filter((e) => e.kind === 'ai_withdrawn');
    expect(pills.map((p) => p.payload)).toEqual(lines.map((l) => ({ messageId: l.id, reason: 'STAFF_REPLY' })));
    const audits = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.ai.message.withdraw'), sql`${s.auditLog.entityId} in (${sql.join(lines.map((l) => sql`${l.id}`), sql`, `)})`));
    expect(audits).toHaveLength(2);

    // Their typing time passes: nothing goes.
    await tick(w, new Date(lines[1]!.nextAttemptAt!.getTime() + 5000));
    expect((await sim(w, central)).sent().some((x) => lines.some((l) => l.id === x.clientRef))).toBe(false);
    expect((await aiLines(w, conv.id)).map((l) => l.providerStatus)).toEqual(['withdrawn', 'withdrawn']);
  });
});

describe('each of the eight action callers cancels the turn in its own transaction (§A.3, R5)', () => {
  it('primary', async () => {
    const { conv, turn } = await pendingThread();
    const res = await call(w, adminCookie, 'PUT', `/inbox/conversations/${conv.id}/primary`, { assignee: { kind: 'account', id: agent } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectCancelled(turn.id, 'ASSIGNED', adminId);
  });

  it('add support', async () => {
    const { conv, turn } = await pendingThread();
    const res = await call(w, adminCookie, 'POST', `/inbox/conversations/${conv.id}/support`, { accountId: agent2 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectCancelled(turn.id, 'ASSIGNED', adminId);
  });

  it('remove support', async () => {
    const { conv, turn } = await pendingThread();
    // A backup the routing seated: the system's, so the assistant was still eligible.
    const supportId = newId();
    await w.ctx.db.insert(s.assignment).values({
      id: supportId,
      operatorId: w.oto,
      conversationId: conv.id,
      slot: 'support',
      slotIndex: 1,
      assigneeKind: 'account',
      accountId: agent2,
      assignedByKind: 'system',
      reason: 'auto',
    });
    const res = await call(w, adminCookie, 'DELETE', `/inbox/conversations/${conv.id}/support/${supportId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectCancelled(turn.id, 'ASSIGNED', adminId);
  });

  it('Divert', async () => {
    const reception = await teamOf(w, 'reception', w.central);
    const [rule] = await w.ctx.db
      .select()
      .from(s.routingRule)
      .where(and(eq(s.routingRule.teamId, reception.id), eq(s.routingRule.category, 'general')))
      .orderBy(desc(s.routingRule.priority))
      .limit(1);
    await w.ctx.db.update(s.routingRule).set({ backupAccountId: agent }).where(eq(s.routingRule.id, rule!.id));
    try {
      const { conv, turn } = await pendingThread();
      const res = await call(w, adminCookie, 'POST', `/inbox/conversations/${conv.id}/divert`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectCancelled(turn.id, 'ASSIGNED', adminId);
    } finally {
      await w.ctx.db.update(s.routingRule).set({ backupAccountId: rule!.backupAccountId }).where(eq(s.routingRule.id, rule!.id));
    }
  });

  it('move', async () => {
    const { conv, turn } = await pendingThread();
    const res = await call(w, adminCookie, 'POST', `/inbox/conversations/${conv.id}/move`, { dest: { kind: 'marketing' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectCancelled(turn.id, 'ASSIGNED', adminId);
  });

  it('branch', async () => {
    const { conv, turn } = await pendingThread();
    const res = await call(w, adminCookie, 'PATCH', `/inbox/conversations/${conv.id}/branch`, { branchId: w.chalong });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectCancelled(turn.id, 'ASSIGNED', adminId);
  });

  it('handled', async () => {
    const { conv, turn } = await pendingThread();
    const res = await call(w, adminCookie, 'POST', `/inbox/conversations/${conv.id}/handle`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectCancelled(turn.id, 'HANDLED', adminId);
  });

  it('reopen', async () => {
    const { conv, turn } = await pendingThread();
    expect((await call(w, adminCookie, 'POST', `/inbox/conversations/${conv.id}/handle`)).status).toBe(200);
    // A turn still waiting on a handled thread (written as the ingest would have, before the handle).
    const waiting = newId();
    await w.ctx.db.insert(s.aiTurn).values({
      id: waiting,
      operatorId: w.oto,
      conversationId: conv.id,
      triggerMessageId: turn.triggerMessageId,
      state: 'pending',
      dueAt: new Date(Date.now() + 20_000),
    });
    const res = await call(w, adminCookie, 'POST', `/inbox/conversations/${conv.id}/reopen`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectCancelled(waiting, 'REOPENED', adminId);
  });

  it('a refused action cancels nothing: its transaction rolled back', async () => {
    const { conv, turn } = await pendingThread();
    const res = await call(w, adminCookie, 'POST', `/inbox/conversations/${conv.id}/reopen`);
    expect(res.status).toBe(409);
    const [t] = await w.ctx.db.select().from(s.aiTurn).where(eq(s.aiTurn.id, turn.id)).limit(1);
    expect(t!.state).toBe('pending');
    await w.ctx.db.update(s.aiTurn).set({ state: 'cancelled', reason: 'TEST_DRAIN' }).where(eq(s.aiTurn.id, turn.id));
  });
});

describe('the PDPA erasure (§D.5)', () => {
  const erase = (contactId: string) =>
    call(w, eraserCookie, 'POST', `/inbox/contacts/${contactId}/erase`, { confirmContactId: contactId, confirm: 'ERASE' });

  it('cancels the subject’s pending turn', async () => {
    const { conv, turn } = await pendingThread();
    const res = await erase(conv.contactId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectCancelled(turn.id, 'ERASED', eraserId);
  });

  it('an erasure during the model call: the commit finds the turn cancelled and writes nothing', async () => {
    const { conv, turn } = await pendingThread();
    w.fake.push({
      kind: 'decision',
      decision: decision(),
      during: async () => {
        const res = await erase(conv.contactId);
        expect(res.status).toBe(200);
      },
    });
    const sweep = await tick(w, later(25_000));
    expect(sweep.skipped).toBe(1);
    const [t] = await w.ctx.db.select().from(s.aiTurn).where(eq(s.aiTurn.id, turn.id)).limit(1);
    expect(t).toMatchObject({ state: 'cancelled', reason: 'ERASED', messageIds: [] });
    expect(await aiLines(w, conv.id)).toHaveLength(0);
    expect((await eventsOf(w, conv.id)).some((e) => e.actorKind === 'ai')).toBe(false);
  });
});

describe('the per-thread pause (§D.4 guard 6)', () => {
  it('cancels the waiting turn and, while set, the ingest writes none', async () => {
    const { conv, turn } = await pendingThread();
    await withTx(w.ctx.db, { operatorId: w.oto }, 'test.pause', async (tx) => {
      await tx.update(s.conversation).set({ aiPausedAt: new Date(), aiPausedByAccountId: adminId }).where(eq(s.conversation.id, conv.id));
      const out = await cancelAiForThread(tx, w.oto, conv.id, 'PAUSED', adminId);
      expect(out.turnsCancelled).toEqual([turn.id]);
    });
    await expectCancelled(turn.id, 'PAUSED', adminId);
    const [contact] = await w.ctx.db.select().from(s.contact).where(eq(s.contact.id, conv.contactId)).limit(1);
    await customer(w, central, contact!.externalHandle.slice(1), 'anyone there?');
    expect((await turnsOf(w, conv.id)).filter((t) => t.state === 'pending')).toHaveLength(0);
  });
});

describe('the no-body sentinel on the cancellation paths (§D.1)', () => {
  it('no customer line and no assistant line reached audit, events, ops or the log', async () => {
    const [held] = (
      await w.ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from inbox.message where body like ${`%${SENTINEL}%`}`)
    ).rows as [{ n: number }];
    expect(Number(held.n)).toBeGreaterThan(3);
    expect(w.logLines.length).toBeGreaterThan(0);
    expect(await sentinelLeaks(w.ctx.db, SENTINEL, w.logLines)).toEqual(NO_LEAKS);
  });
});
