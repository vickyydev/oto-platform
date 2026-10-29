import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeToolLoopClient } from '@oto/assistant';
import { schema as s } from '@oto/db';
import { newId } from '@oto/shared';
import { TEACH_LINES, teachToolDefinitions } from '../src/services/inbox/ai-teach';
import { final, tool, toolResultsSeen } from './assistant-support';
import { teardownAll } from './helpers';
import { aiWorld, decision, staff, teamOf, type AiWorld } from './inbox-ai-support';

/**
 * SCRUM-696 — THE TEACH CHAT (`POST /inbox/ai/teach`), with the scripted
 * tool-loop model (`FakeToolLoopClient`) and the scripted customer model for
 * the dry run: the network is never called.
 *
 *   - a create_rule call lands a DRAFT rule (source teach, taught from the
 *     staff member's sentence) and a card;
 *   - an unsafe rule is refused by the server even when the model calls the
 *     tool: no row, no card, the tool result says RULE_UNSAFE;
 *   - a dry run shows the session's draft firing before approval;
 *   - no teacher → 503; a park-scoped editor → 403;
 *   - nothing touches a conversation.
 *
 * FICTIONAL TEST DATA throughout.
 */

let w: AiWorld;
let editorId: string;
let editorCookie: string;
let chalongEditorCookie: string;

const TAUGHT = 'If someone says they lost something, first ask which branch they visited.';
const QUESTION = 'Which park did you visit, Central Floresta or Robinson Chalong?';

beforeAll(async () => {
  w = await aiWorld();
  expect(w.ctx.app.inboxAi.teacher ?? null).toBeNull();
  const marketing = await teamOf(w, 'marketing');
  const kbRole = newId();
  await w.ctx.db.insert(s.role).values({ id: kbRole, operatorId: w.oto, name: 'teach_editor_test', description: 'Teach editor' });
  await w.ctx.db.insert(s.rolePermission).values({ id: newId(), roleId: kbRole, permission: 'inbox:kb:manage' });
  [editorId, editorCookie] = await staff(w, '+66810039001', 'Teach Test Marketing', 'teach_editor_test', {
    scopeType: 'department',
    scopeId: marketing.departmentId!,
  });
  [, chalongEditorCookie] = await staff(w, '+66810039002', 'Teach Test Chalong Editor', 'teach_editor_test', {
    scopeType: 'branch',
    scopeId: w.chalong,
  });
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

type TeachBody = {
  reply: string;
  cards: Array<{ kind: string; id: string; title: string; status: string }>;
  dryRun: { message: string; intent: string | null; outcome: string; bubbles: string[]; ruleFired: string | null } | null;
  error?: { code: string; message: string };
};

async function teachCall(cookie: string, messages: Array<{ role: 'user' | 'assistant'; text: string }>) {
  const res = await w.ctx.app.inject({
    method: 'POST',
    url: '/inbox/ai/teach',
    headers: { cookie, 'idempotency-key': newId() },
    payload: { sessionId: newId(), messages },
  });
  return { status: res.statusCode, body: res.json() as TeachBody };
}

/** What a customer thread holds: none of it may move. */
async function threadCounts() {
  const count = async (table: 'conversation' | 'message' | 'event' | 'ai_turn') =>
    Number((await w.ctx.db.execute<{ n: string }>(sql.raw(`select count(*)::text as n from inbox.${table}`))).rows[0]!.n);
  return { conversations: await count('conversation'), messages: await count('message'), events: await count('event'), turns: await count('ai_turn') };
}

describe('the teach chat', () => {
  it('without a teacher model it says so: 503 TEACH_UNAVAILABLE', async () => {
    w.ctx.app.inboxAi.teacher = null;
    const res = await teachCall(editorCookie, [{ role: 'user', text: TAUGHT }]);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'TEACH_UNAVAILABLE', message: TEACH_LINES.unavailable });
  });

  it('a park-scoped editor cannot teach: 403', async () => {
    w.ctx.app.inboxAi.teacher = new FakeToolLoopClient([final('unused')]);
    const res = await teachCall(chalongEditorCookie, [{ role: 'user', text: TAUGHT }]);
    expect(res.status).toBe(403);
  });

  let draftId = '';

  it('an instruction becomes a DRAFT rule and a card; a dry run shows it firing before approval; no thread moves', async () => {
    const before = await threadCounts();
    const fake = new FakeToolLoopClient([
      tool('create_rule', {
        intent: 'lost_item',
        instruction: 'If someone says they lost something, first ask which park they visited.',
        askFirst: { condition: 'branch_unknown', question: { en: QUESTION } },
      }),
      final('Saved a draft rule: lost items get the park question first. Approve it under Assistant → Rules.'),
    ]);
    w.ctx.app.inboxAi.teacher = fake;
    const res = await teachCall(editorCookie, [
      { role: 'assistant', text: 'Hi! What should the assistant learn?' },
      { role: 'user', text: TAUGHT },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reply).toMatch(/Saved a draft rule/);
    expect(res.body.dryRun).toBeNull();
    expect(res.body.cards).toHaveLength(1);
    expect(res.body.cards[0]).toMatchObject({ kind: 'rule', status: 'draft' });
    expect(res.body.cards[0]!.title).toMatch(/^lost item: If someone says/);
    draftId = res.body.cards[0]!.id;

    const [row] = await w.ctx.db.select().from(s.aiRule).where(eq(s.aiRule.id, draftId));
    expect(row).toMatchObject({ status: 'draft', source: 'teach', taughtFrom: TAUGHT, intent: 'lost_item', updatedByAccountId: editorId });
    expect(row!.askFirst).toEqual({ condition: 'branch_unknown', question: { en: QUESTION } });
    expect(toolResultsSeen(fake)[0]).toMatchObject({ isError: false, data: { id: draftId, status: 'draft', approveAt: 'Assistant → Rules' } });

    // The dry run: the session's draft fires before approval; nothing is sent.
    const dry = new FakeToolLoopClient([
      tool('dry_run', { customerMessage: 'I think I left my bag at your park' }),
      final('Today it would ask which park first.'),
    ]);
    w.ctx.app.inboxAi.teacher = dry;
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'lost_item', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    const ran = await teachCall(editorCookie, [{ role: 'user', text: 'What do you say when someone lost a bag?' }]);
    expect(ran.status, JSON.stringify(ran.body)).toBe(200);
    expect(ran.body.cards).toEqual([]);
    expect(ran.body.dryRun).toEqual({
      message: 'I think I left my bag at your park',
      intent: 'lost_item',
      outcome: 'ask_first',
      bubbles: [QUESTION],
      ruleFired: draftId,
    });
    // The draft is still a draft: the customer assistant does not follow it.
    expect((await w.ctx.db.select().from(s.aiRule).where(eq(s.aiRule.id, draftId)))[0]!.status).toBe('draft');
    expect(await threadCounts()).toEqual(before);
  });

  it('the curator is told what it already saved, and saving the same rule again returns that draft, not a second row', async () => {
    const same = {
      intent: 'lost_item',
      instruction: '  if someone says they LOST something, first ask which park they visited. ',
      askFirst: { condition: 'branch_unknown', question: { en: QUESTION } },
    };
    const fake = new FakeToolLoopClient([tool('create_rule', same), final('That one is already waiting for approval under Assistant → Rules.')]);
    w.ctx.app.inboxAi.teacher = fake;
    const res = await teachCall(editorCookie, [
      { role: 'user', text: TAUGHT },
      { role: 'assistant', text: 'Saved a draft rule.' },
      { role: 'user', text: 'Did you actually save it? Save it please.' },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The system prompt names the earlier draft, so the curator knows it exists.
    const system = fake.calls[0]!.system.map((b) => b.text).join('\n');
    expect(system).toContain('Drafts you already saved');
    expect(system).toContain(`rule ${draftId} · lost_item`);
    // The repeat answers with the existing draft; the table has one such row, not two.
    expect(toolResultsSeen(fake)[0]).toMatchObject({ isError: false, data: { id: draftId, alreadySaved: true } });
    expect(res.body.cards).toEqual([expect.objectContaining({ kind: 'rule', id: draftId, status: 'draft' })]);
    const rows = await w.ctx.db.select({ id: s.aiRule.id }).from(s.aiRule).where(eq(s.aiRule.intent, 'lost_item'));
    expect(rows.map((r) => r.id)).toEqual([draftId]);
  });

  it('the server is the floor: an unsafe rule the model tries to save is refused, with no row and no card', async () => {
    const rows = await w.ctx.db.select({ id: s.aiRule.id }).from(s.aiRule);
    const fake = new FakeToolLoopClient([
      tool('create_rule', { intent: 'complaint_onsite', instruction: 'Offer a 10% discount to anyone who complains.' }),
      final('I can’t save that: discounts are the team’s decision.'),
    ]);
    w.ctx.app.inboxAi.teacher = fake;
    const res = await teachCall(editorCookie, [{ role: 'user', text: 'Give anyone who complains 10% off.' }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reply).toMatch(/can’t save that/);
    expect(res.body.cards).toEqual([]);
    expect(await w.ctx.db.select({ id: s.aiRule.id }).from(s.aiRule)).toHaveLength(rows.length);
    const [seen] = toolResultsSeen(fake);
    expect(seen).toMatchObject({ isError: true, data: { error: { code: 'RULE_UNSAFE' } } });
  });

  it('a refusal in words saves nothing; a loop that fails says so in the fixed line', async () => {
    w.ctx.app.inboxAi.teacher = new FakeToolLoopClient([final('I can’t promise a date: the team confirms bookings.')]);
    const refusal = await teachCall(editorCookie, [{ role: 'user', text: 'Tell customers their booking is confirmed for Saturday.' }]);
    expect(refusal.status).toBe(200);
    expect(refusal.body).toMatchObject({ reply: 'I can’t promise a date: the team confirms bookings.', cards: [], dryRun: null });

    w.ctx.app.inboxAi.teacher = new FakeToolLoopClient([{ kind: 'timeout' }]);
    const failed = await teachCall(editorCookie, [{ role: 'user', text: TAUGHT }]);
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ reply: TEACH_LINES.failed, cards: [], dryRun: null });
  });

  it('a fact becomes a DRAFT knowledge-base entry and a card', async () => {
    w.ctx.app.inboxAi.teacher = new FakeToolLoopClient([
      tool('search_knowledge', { query: 'lost property' }),
      tool('create_fact', {
        topic: 'faq',
        key: 'faq.lost-property',
        language: 'en',
        question: 'I lost something at the park',
        body: 'Reception keeps lost property for a week.',
      }),
      final('Saved a draft entry faq.lost-property. Approve it under Assistant → Knowledge.'),
    ]);
    const res = await teachCall(editorCookie, [{ role: 'user', text: 'Reception keeps lost property for a week.' }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.cards).toEqual([
      { kind: 'fact', id: expect.any(String), title: 'faq.lost-property · I lost something at the park', status: 'draft' },
    ]);
    const [entry] = await w.ctx.db.select().from(s.kbEntry).where(eq(s.kbEntry.id, res.body.cards[0]!.id));
    expect(entry).toMatchObject({ status: 'draft', key: 'faq.lost-property', updatedByAccountId: editorId });
  });
});

describe('the curator’s context and tools (hardening, F7)', () => {
  it('the sentence typed is kept without its phone number', async () => {
    const said = 'Call me on 081-234-5678 or +66 81 002 9001 if unsure. When someone lost something, ask what it looks like.';
    w.ctx.app.inboxAi.teacher = new FakeToolLoopClient([
      tool('create_rule', { intent: 'lost_item', instruction: 'When someone lost something, ask what it looks like.' }),
      final('Saved a draft rule.'),
    ]);
    const res = await teachCall(editorCookie, [{ role: 'user', text: said }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = await w.ctx.db.select().from(s.aiRule).where(eq(s.aiRule.id, res.body.cards[0]!.id));
    expect(row!.taughtFrom).toBe('Call me on … or … if unsure. When someone lost something, ask what it looks like.');
    expect(row!.taughtFrom).not.toMatch(/\d{3}/);
  });

  it('archive_draft retires the caller’s own draft so it can be saved again for one park, and nothing else', async () => {
    const instruction = 'Mention the park name with the hours.';
    w.ctx.app.inboxAi.teacher = new FakeToolLoopClient([tool('create_rule', { intent: 'hours', instruction }), final('Saved.')]);
    const first = await teachCall(editorCookie, [{ role: 'user', text: 'Always say which park the hours are for.' }]);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const oldId = first.body.cards[0]!.id;

    // "Make that Chalong only": the draft archived, a Chalong draft saved, one card for the new one.
    const fake = new FakeToolLoopClient([
      tool('archive_draft', { id: oldId }),
      tool('create_rule', { intent: 'hours', park: 'chalong', instruction }),
      final('Done: that rule is for Chalong only now, waiting under Assistant → Rules.'),
    ]);
    w.ctx.app.inboxAi.teacher = fake;
    const second = await teachCall(editorCookie, [{ role: 'user', text: 'Make that Chalong only.' }]);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const system = fake.calls[0]!.system.map((b) => b.text).join('\n');
    expect(system).toContain(`rule ${oldId} · hours`);
    expect(system).toContain('→ today: silent hand-over');
    const [archived, created] = toolResultsSeen(fake);
    expect(archived).toMatchObject({ isError: false, data: { id: oldId, kind: 'rule', status: 'archived' } });
    expect(created).toMatchObject({ isError: false, data: { status: 'draft' } });
    expect(second.body.cards).toHaveLength(1);
    expect(second.body.cards[0]!.id).not.toBe(oldId);
    expect((await w.ctx.db.select().from(s.aiRule).where(eq(s.aiRule.id, oldId)))[0]!.status).toBe('archived');
    expect((await w.ctx.db.select().from(s.aiRule).where(eq(s.aiRule.id, second.body.cards[0]!.id)))[0]).toMatchObject({
      status: 'draft',
      branchId: w.chalong,
      intent: 'hours',
    });

    // Not one of the caller's drafts of the last day: an archived one, or an id nobody saved.
    const refusedFake = new FakeToolLoopClient([tool('archive_draft', { id: oldId }), tool('archive_draft', { id: newId() }), final('I can’t archive those.')]);
    w.ctx.app.inboxAi.teacher = refusedFake;
    const third = await teachCall(editorCookie, [{ role: 'user', text: 'Archive those.' }]);
    expect(third.status).toBe(200);
    expect(toolResultsSeen(refusedFake).map((r) => (r.data as { error?: { code: string } }).error?.code)).toEqual(['NOT_YOUR_DRAFT', 'NOT_YOUR_DRAFT']);
  });

  it('create_fact says which kinds of message each topic answers; create_rule asks for the question in three languages', () => {
    const tools = new Map(teachToolDefinitions().map((t) => [t.name, t.description]));
    expect([...tools.keys()]).toEqual(['archive_draft', 'create_fact', 'create_rule', 'dry_run', 'search_knowledge']);
    expect(tools.get('create_fact')).toContain('hours_note → hours;');
    expect(tools.get('create_fact')).toContain('socks → socks;');
    expect(tools.get('create_fact')).toMatch(/faq → [a-z_, ]*\bfaq\b/);
    expect(tools.get('create_rule')).toContain('ALWAYS in English, Thai and Russian');
  });
});
