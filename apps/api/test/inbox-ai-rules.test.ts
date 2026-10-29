import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPrompt, OPERATOR_RULES_HEADING, OPERATOR_RULES_LEAD } from '@oto/assistant';
import { AI_RULE_CONDITIONS, AI_RULE_SOURCES, AI_RULE_STATUSES, schema as s } from '@oto/db';
import { INBOX_AI_RULE_CONDITIONS, INBOX_AI_RULE_SOURCES, INBOX_AI_RULE_STATUSES, newId } from '@oto/shared';
import { loadTurnKnowledge } from '../src/services/inbox/ai-knowledge';
import { teardownAll } from './helpers';
import {
  SENTINEL,
  aiLines,
  aiWorld,
  call,
  conversationRow,
  customer,
  decision,
  eventsOf,
  later,
  nextPhone,
  simAccount,
  staff,
  teamOf,
  tick,
  turnsOf,
  type AiWorld,
} from './inbox-ai-support';

/**
 * SCRUM-696 — THE ASSISTANT'S BEHAVIOUR RULES:
 *
 *   - the rules API: draft, approve, edit (a draft in place; an approved rule
 *     revised under a new id, the old row archived with its words kept),
 *     archive; every write audited with lengths, never the words;
 *   - a rule only adds: one carrying digits or granting a discount is refused
 *     at save (400 RULE_UNSAFE);
 *   - an approved rule reaches the prompt's rules block, after the knowledge;
 *   - THE ENGINE: an approved ask-first rule on lost_item puts its one question
 *     before the silent hand-over on a branchless thread, and the next message
 *     naming a park proceeds exactly as today; the same rules on a complaint
 *     leave the complaint's hand-over exactly as without them.
 *
 * FICTIONAL TEST DATA throughout.
 */

let w: AiWorld;
let wide: string;
let editorId: string;
let editorCookie: string;
let chalongEditorCookie: string;

const QUESTION = 'Which park did you visit, Central Floresta or Robinson Chalong?';
const LOST_RULE = 'If someone says they lost something, first ask which park they visited.';

beforeAll(async () => {
  w = await aiWorld();
  wide = await simAccount(w, { branchId: null });
  const marketing = await teamOf(w, 'marketing');
  const kbRole = newId();
  await w.ctx.db.insert(s.role).values({ id: kbRole, operatorId: w.oto, name: 'rule_editor_test', description: 'Rule editor' });
  await w.ctx.db.insert(s.rolePermission).values({ id: newId(), roleId: kbRole, permission: 'inbox:kb:manage' });
  [editorId, editorCookie] = await staff(w, '+66810029001', 'Rule Test Marketing', 'rule_editor_test', {
    scopeType: 'department',
    scopeId: marketing.departmentId!,
  });
  [, chalongEditorCookie] = await staff(w, '+66810029002', 'Rule Test Chalong Editor', 'rule_editor_test', {
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

/** Every rule out of the assistant, so each engine check starts from the rules it names. */
async function archiveAllRules(): Promise<void> {
  await w.ctx.db.update(s.aiRule).set({ status: 'archived' }).where(sql`status <> 'archived'`);
}

/** Every waiting turn out of the way, so a tick decides only the test's own thread. */
async function drain(): Promise<void> {
  await w.ctx.db
    .update(s.aiTurn)
    .set({ state: 'cancelled', reason: 'TEST_DRAIN', leaseUntil: null })
    .where(sql`state in ('pending','deciding')`);
}

type RuleBody = { id: string; status: string; intent: string; instruction: string; askFirst: unknown; approvedByAccountId: string | null };

async function approvedRule(body: Record<string, unknown>): Promise<string> {
  const made = await call<RuleBody>(w, editorCookie, 'POST', '/inbox/ai/rules', body);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const approved = await call<RuleBody>(w, editorCookie, 'POST', `/inbox/ai/rules/${made.body.id}/approve`);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return made.body.id;
}

describe('the vocabulary is said once (shared ↔ db CHECK lists)', () => {
  it('the statuses, sources and conditions agree', () => {
    expect([...INBOX_AI_RULE_STATUSES]).toEqual([...AI_RULE_STATUSES]);
    expect([...INBOX_AI_RULE_SOURCES]).toEqual([...AI_RULE_SOURCES]);
    expect([...INBOX_AI_RULE_CONDITIONS]).toEqual([...AI_RULE_CONDITIONS]);
  });
});

describe('the rules API', () => {
  it('draft → approve → revise on edit; an archived rule is not edited; audited without the words', async () => {
    const id = newId();
    const instruction = `If someone says they lost something, first ask which park ${SENTINEL}.`;
    const question = `Which park did you visit ${SENTINEL}, Central Floresta or Robinson Chalong?`;
    const made = await call<RuleBody & { source: string; taughtFrom: string | null; canManage: boolean }>(
      w,
      editorCookie,
      'POST',
      '/inbox/ai/rules',
      { id, intent: 'lost_item', instruction, askFirst: { condition: 'branch_unknown', question: { en: question } } },
    );
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body).toMatchObject({ id, status: 'draft', source: 'manual', taughtFrom: null, branchId: null, canManage: true, approvedAt: null });

    // A draft is not the assistant's.
    let known = await loadTurnKnowledge(w.ctx.db, w.oto, new Date());
    expect((known.rules ?? []).map((r) => r.id)).not.toContain(id);

    const listed = await call<{ rules: RuleBody[] }>(w, editorCookie, 'GET', '/inbox/ai/rules');
    expect(listed.body.rules.map((r) => r.id)).toContain(id);

    const approved = await call<RuleBody>(w, editorCookie, 'POST', `/inbox/ai/rules/${id}/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', approvedByAccountId: editorId });
    known = await loadTurnKnowledge(w.ctx.db, w.oto, new Date());
    expect((known.rules ?? []).find((r) => r.id === id)).toMatchObject({ intent: 'lost_item', branchId: null });
    // Approving again is the same act.
    expect((await call(w, editorCookie, 'POST', `/inbox/ai/rules/${id}/approve`)).status).toBe(200);
    expect(await auditOf('inbox.ai_rule.approve', id)).toHaveLength(1);

    // Editing the APPROVED rule revises it under a new id; the old row keeps its words.
    const edit = 'If someone says they lost something, first ask which park they were at.';
    const revised = await call<RuleBody>(w, editorCookie, 'PATCH', `/inbox/ai/rules/${id}`, { instruction: edit });
    expect(revised.status, JSON.stringify(revised.body)).toBe(200);
    expect(revised.body.id).not.toBe(id);
    expect(revised.body).toMatchObject({ status: 'approved', approvedByAccountId: editorId, instruction: edit, intent: 'lost_item' });
    expect(revised.body.askFirst).toEqual({ condition: 'branch_unknown', question: { en: question } });
    const [old] = await w.ctx.db.select().from(s.aiRule).where(eq(s.aiRule.id, id));
    expect(old).toMatchObject({ status: 'archived', instruction });
    const [retiredAudit] = await auditOf('inbox.ai_rule.archive', id);
    expect(retiredAudit!.after).toMatchObject({ status: 'archived', replacedById: revised.body.id });
    const [reviseAudit] = await auditOf('inbox.ai_rule.revise', revised.body.id);
    expect(reviseAudit!.after).toMatchObject({ replacesId: id, instructionChanged: true, askFirstChanged: false, approvedByAccountId: editorId });

    // An archived rule is neither edited nor approved.
    const late = await call<{ error: { code: string } }>(w, editorCookie, 'PATCH', `/inbox/ai/rules/${id}`, { instruction: 'Keep it short.' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('RULE_ARCHIVED');
    expect((await call<{ error: { code: string } }>(w, editorCookie, 'POST', `/inbox/ai/rules/${id}/approve`)).body.error.code).toBe('RULE_ARCHIVED');

    // Archive; the default list leaves it out, status=archived lists it.
    const archived = await call<RuleBody>(w, editorCookie, 'POST', `/inbox/ai/rules/${revised.body.id}/archive`);
    expect(archived.body).toMatchObject({ status: 'archived' });
    const live = await call<{ rules: RuleBody[] }>(w, editorCookie, 'GET', '/inbox/ai/rules');
    expect(live.body.rules.map((r) => r.id)).not.toContain(revised.body.id);
    const gone = await call<{ rules: RuleBody[] }>(w, editorCookie, 'GET', '/inbox/ai/rules?status=archived');
    expect(gone.body.rules.map((r) => r.id)).toEqual(expect.arrayContaining([id, revised.body.id]));

    // Audit: ids, the intent, statuses and lengths — never the instruction or the question.
    const rows = await w.ctx.db.select().from(s.auditLog).where(eq(s.auditLog.entityType, 'inbox.ai_rule'));
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
    const [created] = await auditOf('inbox.ai_rule.create', id);
    expect(created!.after).toMatchObject({
      intent: 'lost_item',
      status: 'draft',
      askFirstCondition: 'branch_unknown',
      instructionLength: [...instruction].length,
      questionLengths: { en: [...question].length, th: null, ru: null },
    });
  });

  it('a draft is changed in place, under the same checks', async () => {
    const made = await call<RuleBody>(w, editorCookie, 'POST', '/inbox/ai/rules', { intent: 'socks', instruction: 'Mention the grip socks.' });
    const edited = await call<RuleBody>(w, editorCookie, 'PATCH', `/inbox/ai/rules/${made.body.id}`, { instruction: 'Mention the grip socks at reception.' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ id: made.body.id, status: 'draft', instruction: 'Mention the grip socks at reception.' });
    expect(await auditOf('inbox.ai_rule.update', made.body.id)).toHaveLength(1);
    const unsafe = await call<{ error: { code: string } }>(w, editorCookie, 'PATCH', `/inbox/ai/rules/${made.body.id}`, {
      instruction: 'Give them free socks.',
    });
    expect(unsafe.status).toBe(400);
    expect(unsafe.body.error.code).toBe('RULE_UNSAFE');
  });

  it('a rule only adds: digits, a discount, an unknown intent and an unsafe question are refused at save', async () => {
    const before = await w.ctx.db.select({ id: s.aiRule.id }).from(s.aiRule);
    const digits = await call<{ error: { code: string; message: string; details: { rule: string } } }>(w, editorCookie, 'POST', '/inbox/ai/rules', {
      intent: 'complaint_onsite',
      instruction: 'Offer 10% off to anyone who complains',
    });
    expect(digits.status).toBe(400);
    expect(digits.body.error).toMatchObject({ code: 'RULE_UNSAFE', details: { rule: 'digits' } });
    expect(digits.body.error.message).toMatch(/cannot carry numbers/);

    const discount = await call<{ error: { code: string; details: { rule: string } } }>(w, editorCookie, 'POST', '/inbox/ai/rules', {
      intent: 'discount_negotiation',
      instruction: 'Offer them a discount',
    });
    expect(discount.status).toBe(400);
    expect(discount.body.error).toMatchObject({ code: 'RULE_UNSAFE', details: { rule: 'commitment' } });

    const question = await call<{ error: { code: string; details: { rule: string } } }>(w, editorCookie, 'POST', '/inbox/ai/rules', {
      intent: 'lost_item',
      instruction: LOST_RULE,
      askFirst: { condition: 'always', question: { en: 'Are you talking to a bot? Which park?' } },
    });
    expect(question.status).toBe(400);
    expect(question.body.error).toMatchObject({ code: 'RULE_UNSAFE', details: { rule: 'question' } });

    const unknown = await call<{ error: { code: string } }>(w, editorCookie, 'POST', '/inbox/ai/rules', { intent: 'weather', instruction: 'Say it is sunny.' });
    expect(unknown.status).toBe(409);
    expect(unknown.body.error.code).toBe('INTENT_UNKNOWN');

    // Saying what we do NOT do is an instruction, not a grant.
    const honest = await call(w, editorCookie, 'POST', '/inbox/ai/rules', {
      intent: 'discount_negotiation',
      instruction: 'If someone asks for a discount, say we do not offer discounts',
    });
    expect(honest.status, JSON.stringify(honest.body)).toBe(200);
    const after = await w.ctx.db.select({ id: s.aiRule.id }).from(s.aiRule);
    expect(after).toHaveLength(before.length + 1);
  });

  it('a caller-named id sent twice is one rule; a park editor reaches only their park', async () => {
    const body = { id: newId(), intent: 'hours', instruction: 'Say the hours in one line.' };
    const first = await w.ctx.app.inject({ method: 'POST', url: '/inbox/ai/rules', headers: { cookie: editorCookie, 'idempotency-key': newId() }, payload: body });
    const second = await w.ctx.app.inject({ method: 'POST', url: '/inbox/ai/rules', headers: { cookie: editorCookie, 'idempotency-key': newId() }, payload: body });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-oto-replay']).toBe('true');
    expect(await w.ctx.db.select().from(s.aiRule).where(eq(s.aiRule.id, body.id))).toHaveLength(1);

    expect((await call(w, chalongEditorCookie, 'POST', '/inbox/ai/rules', { intent: 'hours', instruction: 'Say the hours.', branchId: w.chalong })).status).toBe(200);
    expect((await call(w, chalongEditorCookie, 'POST', '/inbox/ai/rules', { intent: 'hours', instruction: 'Say the hours.' })).status).toBe(403);
  });

  it('an approved rule reaches the prompt after the knowledge, opening with the one sentence', async () => {
    await archiveAllRules();
    await approvedRule({ intent: 'lost_item', instruction: LOST_RULE, askFirst: { condition: 'branch_unknown', question: { en: QUESTION } } });
    const known = await loadTurnKnowledge(w.ctx.db, w.oto, new Date());
    const rules = known.rules ?? [];
    expect(rules).toHaveLength(1);
    const built = buildPrompt({
      knowledge: known.knowledge,
      episode: [{ from: 'customer', at: new Date(), text: 'I think I left my bag at your park' }],
      context: {
        now: new Date(),
        threadBranch: null,
        priceModeToday: known.priceModeToday,
        earlier: { answered: 0, brochureSent: false, branchAsked: false, identityAnswered: false },
      },
      rules,
    });
    if (!built.ok) throw new Error(built.reason);
    expect(built.prompt.system[1].text).toBe(
      `${known.knowledge.text}\n\n${OPERATOR_RULES_HEADING}\n${OPERATOR_RULES_LEAD}\n- lost_item: ${LOST_RULE}\n  ask first: ${QUESTION}`,
    );
    expect(built.prompt.system[0].text).not.toContain('Operator rules');
  });
});

describe('the engine follows an approved ask-first rule (and nothing else changes)', () => {
  it('a lost item on a branchless thread: one question, no hand-over; the next message naming a park proceeds as today', async () => {
    await drain();
    await archiveAllRules();
    const ruleId = await approvedRule({
      intent: 'lost_item',
      instruction: LOST_RULE,
      askFirst: { condition: 'branch_unknown', question: { en: QUESTION } },
    });
    const phone = nextPhone();
    const conv = await customer(w, wide, phone, 'I think I left my bag at your park');
    expect(conv.branchId).toBeNull();
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'lost_item', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [], grounding: [] }) });
    expect((await tick(w, later(25_000))).answered).toBe(1);

    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([QUESTION]);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'answered', action: 'answer', reason: 'OK', intent: 'lost_item' });
    let events = await eventsOf(w, conv.id);
    expect(events.some((e) => e.kind === 'ai_handover')).toBe(false);
    expect(events.find((e) => e.kind === 'ai_replied')!.payload).toMatchObject({ askBranch: true, askFirstRuleId: ruleId, intent: 'lost_item' });
    expect((await conversationRow(w, conv.id)).branchId).toBeNull();

    // The customer names the park: the silent hand-over goes exactly as it does today, and no second question.
    await customer(w, wide, phone, 'Central');
    w.fake.push({
      kind: 'decision',
      decision: decision({ intent: 'lost_item', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [], grounding: [], branchNamed: 'central' }),
    });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    const lines = (await aiLines(w, conv.id)).map((l) => l.body);
    expect(lines).toHaveLength(2);
    expect(lines.filter((b) => b === QUESTION)).toHaveLength(1);
    expect((await turnsOf(w, conv.id))[1]).toMatchObject({ state: 'handed_over', intent: 'lost_item' });
    events = await eventsOf(w, conv.id);
    const handover = events.find((e) => e.kind === 'ai_handover');
    expect(handover).toBeDefined();
    expect(handover!.payload).not.toHaveProperty('askFirstRuleId');
    expect((await conversationRow(w, conv.id)).branchId).toBe(w.central);
  });

  it('a complaint is never interrupted: the same hand-over as with no rule at all', async () => {
    const complaint = () =>
      decision({ intent: 'complaint_onsite', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [], grounding: [] });
    const run = async () => {
      await drain();
      const conv = await customer(w, wide, nextPhone(), 'my son got hurt on the slide today');
      w.fake.push({ kind: 'decision', decision: complaint() });
      expect((await tick(w, later(25_000))).handedOver).toBe(1);
      const [turn] = await turnsOf(w, conv.id);
      const events = await eventsOf(w, conv.id);
      const after = await conversationRow(w, conv.id);
      const handover = events.find((e) => e.kind === 'ai_handover')!.payload as Record<string, unknown>;
      return {
        lines: (await aiLines(w, conv.id)).map((l) => ({ body: l.body, templateId: l.templateId })),
        turn: { state: turn!.state, action: turn!.action, reason: turn!.reason, intent: turn!.intent },
        kinds: events.map((e) => e.kind).sort(),
        handover: { ...handover, turnId: null, messageIds: (handover['messageIds'] as unknown[]).length, reroutedTeamId: null },
        routed: { category: after.category, teamId: after.teamId, branchId: after.branchId },
        askFirst: events.some((e) => JSON.stringify(e.payload ?? {}).includes('askFirstRuleId')),
      };
    };

    await archiveAllRules();
    const without = await run();
    await approvedRule({
      intent: 'complaint_onsite',
      instruction: 'Before anything, ask which park it was.',
      askFirst: { condition: 'always', question: { en: 'Which park were you at?' } },
    });
    await approvedRule({
      intent: 'any',
      instruction: 'Ask which park first.',
      askFirst: { condition: 'always', question: { en: 'Which park are you asking about?' } },
    });
    const withRules = await run();
    expect(withRules.askFirst).toBe(false);
    expect(withRules).toEqual(without);
    expect(without.turn.state).toBe('handed_over');
  });
});
