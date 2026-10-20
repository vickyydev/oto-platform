import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AI_CONTENT_LANGUAGES,
  AI_EXAMPLE_STATUSES,
  AI_EXAMPLE_VERDICTS,
  AI_MODES,
  KB_ENTRY_STATUSES,
  KB_TOPICS,
  schema as s,
} from '@oto/db';
import {
  INBOX_AI_CONTENT_LANGUAGES,
  INBOX_AI_EXAMPLE_STATUSES,
  INBOX_AI_EXAMPLE_VERDICTS,
  INBOX_AI_MODES,
  INBOX_KB_STATUSES,
  INBOX_KB_TOPICS,
  newId,
} from '@oto/shared';
import { loadTurnKnowledge } from '../src/services/inbox/ai-knowledge';
import { ADMIN, signInAs, teardownAll } from './helpers';
import {
  SENTINEL,
  aiLines,
  aiWorld,
  call,
  customer,
  decision,
  later,
  nextPhone,
  simAccount,
  staff,
  teamOf,
  tick,
  turnsOf,
  type AiWorld,
} from './inbox-ai-support';
import { NO_LEAKS, sentinelLeaks } from './inbox-sentinel';

/**
 * SCRUM-590 round A3 lane a — THE ASSISTANT'S SETTINGS API (plan
 * `docs/progress/plans/inbox-ai-build/PLAN.md` §C, §E, §D.2, §D.4; checks
 * §F.3 "A3"):
 *
 *   - the knowledge base: draft, edit (drafts only), approve (approver and
 *     time recorded; the engine then reads it), archive (frees the key), one
 *     live entry per key, language and park; inbox:kb:manage at the entry's
 *     park — a branch grant reaches its park only, the Marketing department's
 *     grant reaches the operator;
 *   - the examples: "Correct the assistant" from an AI line by whoever may
 *     reply there, capturing the turn's language and intent and the source
 *     links; approval REQUIRES the de-identification confirmation and severs
 *     the links — and the database refuses an approval without them;
 *   - the controls: a number's ai_mode (inbox:ai:manage), the per-thread
 *     pause cancelling the waiting turn in its own transaction, resume;
 *   - the read side the shell needs, and every write audited without a word.
 *
 * FICTIONAL TEST DATA throughout.
 */

let w: AiWorld;
let line: string;
let adminCookie: string;
let adminId: string;
let agentId: string;
let agentCookie: string;
let chalongAgentCookie: string;
let marketingKbCookie: string;
let marketingKbId: string;
let chalongKbCookie: string;

beforeAll(async () => {
  w = await aiWorld();
  line = await simAccount(w, { branchId: w.central });
  adminCookie = await signInAs(w.ctx.app, ADMIN.phone, ADMIN.password);
  const [admin] = await w.ctx.db.select({ id: s.account.id }).from(s.account).where(eq(s.account.phone, ADMIN.phone)).limit(1);
  adminId = admin!.id;
  const reception = await teamOf(w, 'reception', w.central);
  const chalongReception = await teamOf(w, 'reception', w.chalong);
  const marketing = await teamOf(w, 'marketing');
  [agentId, agentCookie] = await staff(w, '+66810019001', 'KB Test Agent', 'inbox_agent', {
    scopeType: 'department',
    scopeId: reception.departmentId!,
  });
  [, chalongAgentCookie] = await staff(w, '+66810019002', 'KB Test Chalong Agent', 'inbox_agent', {
    scopeType: 'department',
    scopeId: chalongReception.departmentId!,
  });
  // The marketing team's editor (§C.2): inbox:kb:manage at the Marketing department.
  const kbRole = newId();
  await w.ctx.db.insert(s.role).values({ id: kbRole, operatorId: w.oto, name: 'kb_editor_test', description: 'KB editor' });
  await w.ctx.db.insert(s.rolePermission).values({ id: newId(), roleId: kbRole, permission: 'inbox:kb:manage' });
  [marketingKbId, marketingKbCookie] = await staff(w, '+66810019003', 'KB Test Marketing', 'kb_editor_test', {
    scopeType: 'department',
    scopeId: marketing.departmentId!,
  });
  [, chalongKbCookie] = await staff(w, '+66810019004', 'KB Test Chalong Editor', 'kb_editor_test', {
    scopeType: 'branch',
    scopeId: w.chalong,
  });
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

async function auditOf(action: string, entityId: string) {
  return w.ctx.db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.action, action), eq(s.auditLog.entityId, entityId)))
    .orderBy(desc(s.auditLog.createdAt));
}

describe('the vocabulary is said once (shared ↔ db CHECK lists)', () => {
  it('the topics, languages, statuses, verdicts and modes agree', () => {
    expect([...INBOX_KB_TOPICS]).toEqual([...KB_TOPICS]);
    expect([...INBOX_KB_STATUSES]).toEqual([...KB_ENTRY_STATUSES]);
    expect([...INBOX_AI_CONTENT_LANGUAGES]).toEqual([...AI_CONTENT_LANGUAGES]);
    expect([...INBOX_AI_EXAMPLE_VERDICTS]).toEqual([...AI_EXAMPLE_VERDICTS]);
    expect([...INBOX_AI_EXAMPLE_STATUSES]).toEqual([...AI_EXAMPLE_STATUSES]);
    expect([...INBOX_AI_MODES]).toEqual([...AI_MODES]);
  });
});

describe('the knowledge base (§C)', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: newId(),
    topic: 'socks',
    key: 'socks.rule',
    language: 'en',
    question: 'Do we need socks?',
    body: 'Socks are required on the play floor for children and adults.',
    ...over,
  });

  it('draft → edit → approve: the approver and the time recorded, and the engine then reads it', async () => {
    const draft = entry();
    const made = await call(w, marketingKbCookie, 'POST', '/inbox/kb', draft);
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body).toMatchObject({ id: draft.id, status: 'draft', branchId: null, canManage: true, approvedAt: null });
    // A draft is not the assistant's.
    let known = await loadTurnKnowledge(w.ctx.db, w.oto, new Date());
    expect(JSON.stringify(known.knowledge)).not.toContain('socks.rule');

    const edited = await call(w, marketingKbCookie, 'PATCH', `/inbox/kb/${draft.id}`, { body: 'Grip socks are required on the play floor.' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ body: 'Grip socks are required on the play floor.', status: 'draft' });

    const approved = await call(w, marketingKbCookie, 'POST', `/inbox/kb/${draft.id}/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', approvedByAccountId: marketingKbId });
    expect(approved.body['approvedAt']).not.toBeNull();
    known = await loadTurnKnowledge(w.ctx.db, w.oto, new Date());
    expect(JSON.stringify(known.knowledge)).toContain('socks.rule');

    // Approving again is the same act; editing an approved entry is refused in a sentence.
    expect((await call(w, marketingKbCookie, 'POST', `/inbox/kb/${draft.id}/approve`)).status).toBe(200);
    expect(await auditOf('inbox.kb.approve', draft.id)).toHaveLength(1);
    const late = await call<{ error: { code: string; message: string } }>(w, marketingKbCookie, 'PATCH', `/inbox/kb/${draft.id}`, { body: 'x' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('KB_NOT_DRAFT');
    expect(late.body.error.message).toMatch(/Only a draft can be edited/);

    // Audit: ids, key and lengths — never the words.
    for (const action of ['inbox.kb.create', 'inbox.kb.update', 'inbox.kb.approve']) {
      const [row] = await auditOf(action, draft.id);
      expect(row, action).toBeDefined();
      expect(row!.after).toMatchObject({ key: 'socks.rule', language: 'en' });
      expect(JSON.stringify([row!.before, row!.after])).not.toMatch(/socks are required|Grip socks/i);
    }
  });

  it('one live entry per key, language and park: 409 KB_KEY_TAKEN; archiving frees the key', async () => {
    const dup = await call<{ error: { code: string } }>(w, marketingKbCookie, 'POST', '/inbox/kb', entry());
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('KB_KEY_TAKEN');
    // The same key in Thai, or at one park, is another entry.
    expect((await call(w, marketingKbCookie, 'POST', '/inbox/kb', entry({ language: 'th', needsTranslation: true }))).status).toBe(200);
    expect((await call(w, marketingKbCookie, 'POST', '/inbox/kb', entry({ branchId: w.chalong }))).status).toBe(200);

    const [live] = await w.ctx.db
      .select()
      .from(s.kbEntry)
      .where(and(eq(s.kbEntry.key, 'socks.rule'), eq(s.kbEntry.language, 'en'), eq(s.kbEntry.status, 'approved')));
    const archived = await call(w, marketingKbCookie, 'POST', `/inbox/kb/${live!.id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ status: 'archived' });
    expect((await call(w, marketingKbCookie, 'POST', '/inbox/kb', entry())).status).toBe(200);
  });

  it('a caller-named id sent twice is one entry', async () => {
    const e = entry({ key: 'faq.replay', topic: 'faq' });
    const first = await w.ctx.app.inject({ method: 'POST', url: '/inbox/kb', headers: { cookie: marketingKbCookie, 'idempotency-key': newId() }, payload: e });
    const second = await w.ctx.app.inject({ method: 'POST', url: '/inbox/kb', headers: { cookie: marketingKbCookie, 'idempotency-key': newId() }, payload: e });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-oto-replay']).toBe('true');
    expect((await w.ctx.db.select().from(s.kbEntry).where(eq(s.kbEntry.key, 'faq.replay')))).toHaveLength(1);
  });

  it('the scope: a branch grant manages its park only; no grant, no access', async () => {
    const mine = await call(w, chalongKbCookie, 'POST', '/inbox/kb', entry({ key: 'parking.chalong', topic: 'parking', branchId: w.chalong }));
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect((await call(w, chalongKbCookie, 'POST', '/inbox/kb', entry({ key: 'parking.central', topic: 'parking', branchId: w.central }))).status).toBe(403);
    expect((await call(w, chalongKbCookie, 'POST', '/inbox/kb', entry({ key: 'parking.both', topic: 'parking' }))).status).toBe(403);
    // It lists everything, and says what it may manage.
    const list = await call<{ entries: { key: string; branchId: string | null; canManage: boolean }[] }>(w, chalongKbCookie, 'GET', '/inbox/kb?topic=parking');
    expect(list.status).toBe(200);
    expect(list.body.entries.map((e) => [e.key, e.canManage])).toEqual([['parking.chalong', true]]);
    const both = (await call<{ entries: { branchId: string | null; canManage: boolean }[] }>(w, chalongKbCookie, 'GET', '/inbox/kb?topic=socks')).body.entries;
    expect(both.filter((e) => e.branchId === null).every((e) => !e.canManage)).toBe(true);
    // An agent holds no inbox:kb:manage.
    expect((await call(w, agentCookie, 'GET', '/inbox/kb')).status).toBe(403);
    expect((await call(w, agentCookie, 'POST', '/inbox/kb', entry({ key: 'faq.agent', topic: 'faq' }))).status).toBe(403);
  });

  it('refuses what the CHECKs refuse, in a sentence', async () => {
    const bad = await call<{ error: { code: string; message: string } }>(w, marketingKbCookie, 'POST', '/inbox/kb', entry({ key: 'Not A Slug' }));
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('lower-case slug');
    expect((await call(w, marketingKbCookie, 'POST', '/inbox/kb', entry({ key: 'faq.long', body: 'x'.repeat(1201) }))).status).toBe(400);
    expect((await call(w, marketingKbCookie, 'POST', '/inbox/kb', entry({ key: 'faq.long', topic: 'weather' }))).status).toBe(400);
  });
});

describe('"Correct the assistant" and the examples queue (§E, §D.5)', () => {
  let convId: string;
  let aiLineId: string;
  let customerLineId: string;

  beforeAll(async () => {
    const conv = await customer(w, line, nextPhone(), `how much for two kids ${SENTINEL}`);
    convId = conv.id;
    w.fake.push({ kind: 'decision', decision: decision() });
    expect((await tick(w, later(25_000))).answered).toBe(1);
    const lines = await aiLines(w, convId);
    aiLineId = lines[0]!.id;
    const [turn] = await turnsOf(w, convId);
    customerLineId = turn!.triggerMessageId;
  });

  it('whoever may reply on the thread proposes an example: the turn’s intent and language, the source links, a draft', async () => {
    const id = newId();
    const res = await call(w, agentCookie, 'POST', '/inbox/ai/examples', {
      id,
      messageId: aiLineId,
      customerText: `hello there ${SENTINEL}`,
      goodReply: 'Hi! Welcome to OTO Play Park, how can we help?',
      verdict: 'should_answer',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id,
      intent: 'greeting',
      language: 'en',
      status: 'proposed',
      sourceMessageId: aiLineId,
      sourceConversationId: convId,
      proposedByAccountId: agentId,
      deidentifiedConfirmed: false,
    });
    // The thread is not changed: no new message.
    expect(await aiLines(w, convId)).toHaveLength(1);
  });

  it('refuses a thread the caller cannot see (404), a should_answer without a reply, and a non-replier', async () => {
    const hidden = await call(w, chalongAgentCookie, 'POST', '/inbox/ai/examples', {
      messageId: customerLineId,
      customerText: 'x',
      verdict: 'should_handover',
    });
    expect(hidden.status).toBe(404);
    const noReply = await call<{ error: { code: string } }>(w, agentCookie, 'POST', '/inbox/ai/examples', {
      messageId: customerLineId,
      customerText: 'How much?',
      verdict: 'should_answer',
    });
    expect(noReply.status).toBe(409);
    expect(noReply.body.error.code).toBe('GOOD_REPLY_REQUIRED');
    // The marketing editor holds no reply permission.
    expect(
      (await call(w, marketingKbCookie, 'POST', '/inbox/ai/examples', { messageId: customerLineId, customerText: 'x', verdict: 'should_handover' })).status,
    ).toBe(403);
  });

  it('approval REQUIRES the de-identification confirmation, then severs the source links', async () => {
    const [ex] = await w.ctx.db.select().from(s.aiExample).where(eq(s.aiExample.sourceMessageId, aiLineId)).limit(1);
    // An agent cannot review.
    expect((await call(w, agentCookie, 'POST', `/inbox/ai/examples/${ex!.id}/approve`, { deidentifiedConfirmed: true })).status).toBe(403);
    // A branch editor has no operator reach: the queue is not theirs.
    expect((await call(w, chalongKbCookie, 'GET', '/inbox/ai/examples')).status).toBe(403);
    for (const body of [{}, { deidentifiedConfirmed: false }]) {
      const res = await call<{ error: { code: string; message: string } }>(w, marketingKbCookie, 'POST', `/inbox/ai/examples/${ex!.id}/approve`, body);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DEIDENTIFICATION_REQUIRED');
      expect(res.body.error.message).toMatch(/no personal data/);
    }
    // The editor removes the personal data first.
    const edited = await call(w, marketingKbCookie, 'PATCH', `/inbox/ai/examples/${ex!.id}`, { customerText: 'hello there, a corrected greeting' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const ok = await call(w, marketingKbCookie, 'POST', `/inbox/ai/examples/${ex!.id}/approve`, { deidentifiedConfirmed: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'approved',
      deidentifiedConfirmed: true,
      approvedByAccountId: marketingKbId,
      sourceMessageId: null,
      sourceConversationId: null,
    });
    // An approved example reaches the assistant; it can no longer be edited or deleted.
    const known = await loadTurnKnowledge(w.ctx.db, w.oto, new Date());
    expect(JSON.stringify(known.knowledge)).toContain('hello there, a corrected greeting');
    expect((await call(w, marketingKbCookie, 'PATCH', `/inbox/ai/examples/${ex!.id}`, { verdict: 'should_handover' })).status).toBe(409);
    expect((await call(w, marketingKbCookie, 'DELETE', `/inbox/ai/examples/${ex!.id}`)).status).toBe(409);
    // Rejecting takes it out of the assistant.
    expect((await call(w, marketingKbCookie, 'POST', `/inbox/ai/examples/${ex!.id}/reject`)).body).toMatchObject({ status: 'rejected' });
  });

  it('the database backs it: an approval without the confirmation, or with a source link, is refused', async () => {
    const id = newId();
    await w.ctx.db.insert(s.aiExample).values({
      id,
      operatorId: w.oto,
      intent: 'socks',
      language: 'en',
      customerText: 'Socks?',
      verdict: 'should_handover',
      proposedByAccountId: agentId,
      sourceConversationId: convId,
    });
    const approve = (set: Partial<typeof s.aiExample.$inferInsert>) =>
      w.ctx.db
        .update(s.aiExample)
        .set({ status: 'approved', approvedByAccountId: adminId, approvedAt: new Date(), ...set })
        .where(eq(s.aiExample.id, id));
    await expect(approve({ deidentifiedConfirmed: false, sourceConversationId: null })).rejects.toThrow();
    await expect(approve({ deidentifiedConfirmed: true })).rejects.toThrow();
  });

  it('a proposed example on the silent customer line takes the language from the thread; the draft can be deleted', async () => {
    const res = await call<{ id: string; language: string; intent: string }>(w, agentCookie, 'POST', '/inbox/ai/examples', {
      messageId: customerLineId,
      customerText: 'How much?',
      verdict: 'should_stay_silent',
      intent: 'other',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ language: 'en', intent: 'other' });
    const list = await call<{ examples: { id: string }[]; intents: string[] }>(w, marketingKbCookie, 'GET', '/inbox/ai/examples?status=proposed');
    expect(list.body.examples.map((e) => e.id)).toContain(res.body.id);
    expect(list.body.intents).toContain('ticket_prices');
    const gone = await call(w, marketingKbCookie, 'DELETE', `/inbox/ai/examples/${res.body.id}`);
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual({ id: res.body.id, deleted: true });
    expect(await auditOf('inbox.ai_example.delete', res.body.id)).toHaveLength(1);
  });
});

describe('the controls (§D.4)', () => {
  it('a number’s ai_mode: inbox:ai:manage switches it, audited; an agent cannot', async () => {
    const list = await call<{ channelAccounts: { id: string; aiMode: string }[] }>(w, adminCookie, 'GET', '/inbox/ai/channel-accounts');
    expect(list.status).toBe(200);
    expect(list.body.channelAccounts.find((a) => a.id === line)).toMatchObject({ aiMode: 'live' });
    expect((await call(w, agentCookie, 'PATCH', `/inbox/channel-accounts/${line}/ai-mode`, { aiMode: 'off' })).status).toBe(403);
    expect((await call(w, marketingKbCookie, 'GET', '/inbox/ai/channel-accounts')).status).toBe(403);

    const shadow = await call(w, adminCookie, 'PATCH', `/inbox/channel-accounts/${line}/ai-mode`, { aiMode: 'shadow' });
    expect(shadow.status, JSON.stringify(shadow.body)).toBe(200);
    expect(shadow.body).toMatchObject({ id: line, aiMode: 'shadow' });
    const [row] = await auditOf('inbox.ai.mode', line);
    expect(row).toMatchObject({ before: { aiMode: 'live' }, after: { aiMode: 'shadow' } });
    expect((await call(w, adminCookie, 'PATCH', `/inbox/channel-accounts/${line}/ai-mode`, { aiMode: 'live' })).status).toBe(200);
  });

  it('pause: whoever may reply cancels the waiting turn in the same transaction; the thread read says paused; resume clears it', async () => {
    const conv = await customer(w, line, nextPhone(), 'are you open today?');
    const [turn] = await turnsOf(w, conv.id);
    expect(turn!.state).toBe('pending');
    // Not their thread: 404.
    expect((await call(w, chalongAgentCookie, 'POST', `/inbox/conversations/${conv.id}/ai-pause`)).status).toBe(404);

    const paused = await call(w, agentCookie, 'POST', `/inbox/conversations/${conv.id}/ai-pause`);
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(paused.body).toMatchObject({ conversationId: conv.id, aiPaused: true, aiPausedByAccountId: agentId, turnsCancelled: 1 });
    const [t] = await w.ctx.db.select().from(s.aiTurn).where(eq(s.aiTurn.id, turn!.id));
    expect(t).toMatchObject({ state: 'cancelled', reason: 'PAUSED' });
    const [cancel] = await auditOf('inbox.ai.turn.cancel', turn!.id);
    expect(cancel).toMatchObject({ actorAccountId: agentId });
    expect((await auditOf('inbox.ai.pause', conv.id))[0]!.after).toMatchObject({ paused: true });

    const detail = await call(w, agentCookie, 'GET', `/inbox/conversations/${conv.id}`);
    expect(detail.body).toMatchObject({ aiMode: 'live', aiPaused: true, aiPausedByAccountId: agentId });
    // Pausing again is the same act.
    expect((await call(w, agentCookie, 'POST', `/inbox/conversations/${conv.id}/ai-pause`)).body).toMatchObject({ aiPaused: true, turnsCancelled: 0 });
    expect(await auditOf('inbox.ai.pause', conv.id)).toHaveLength(1);

    const resumed = await call(w, agentCookie, 'POST', `/inbox/conversations/${conv.id}/ai-resume`);
    expect(resumed.body).toMatchObject({ aiPaused: false, aiPausedAt: null, aiPausedByAccountId: null });
    expect((await call(w, agentCookie, 'GET', `/inbox/conversations/${conv.id}`)).body).toMatchObject({ aiPaused: false });
    expect((await auditOf('inbox.ai.pause', conv.id))[0]!.after).toMatchObject({ paused: false });
  });

  it('the viewer says what the Assistant page may show', async () => {
    const me = (cookie: string) => call<{ capabilities: Record<string, boolean> }>(w, cookie, 'GET', '/inbox/me');
    expect((await me(adminCookie)).body.capabilities).toMatchObject({ kb: true, ai: true });
    expect((await me(agentCookie)).body.capabilities).toMatchObject({ kb: false, ai: false });
  });
});

describe('the no-body sentinel on the settings paths (§D.1)', () => {
  it('no customer text an example holds reached audit, events, ops or the log', async () => {
    expect(await sentinelLeaks(w.ctx.db, SENTINEL, w.logLines)).toEqual(NO_LEAKS);
  });
});
