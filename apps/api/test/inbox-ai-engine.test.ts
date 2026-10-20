import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSONA_VERSION } from '@oto/assistant';
import { schema as s } from '@oto/db';
import { INBOX_TEMPLATE_BODIES } from '@oto/db/seed';
import { newId } from '@oto/shared';
import { AI_LEASE_MS, CIRCUIT_PAUSE_MS, INBOX_AI_JOB, claimAiTurn } from '../src/services/inbox/ai-engine';
import { loadEnv } from '../src/env';
import { buildInboxAiRuntime } from '../src/services/inbox/ai-runtime';
import { buildDefaultJobs } from '../src/services/jobs';
import { ADMIN, signInAs, teardownAll } from './helpers';
import {
  SENTINEL,
  activeSlots,
  aiLines,
  aiWorld,
  call,
  closedNowHours,
  conversationRow,
  customer,
  decision,
  eventsOf,
  kb,
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
 * SCRUM-590 round A2 lane a — the turn engine (plan
 * `docs/progress/plans/inbox-ai-build/PLAN.md` §A, §B.5, §B.6, §D; checks
 * §F.3 "A2"). The cancellation callers are `inbox-ai-cancel.test.ts`.
 *
 *   - the ingest writes one pending turn per thread in hours (debounced),
 *     none out of hours or with a kill switch off;
 *   - the claim is single, an expired lease is retried once, then silence;
 *   - an answer queues `author_kind 'ai'` lines that leave in order after
 *     their typing time and never count as a staff answer;
 *   - a handover queues the holding line and the brochure and re-routes a
 *     birthday with `assigned_by_kind 'ai'` — never over a person's seat;
 *   - every failure of the model is silence with its word and no line;
 *   - a newer customer message supersedes the decision;
 *   - the episode cap, the daily caps, the circuit breaker, shadow mode;
 *   - no customer line or assistant line reaches audit, events, ops or logs.
 */

let w: AiWorld;
let central: string; // a Central number, live
let wide: string; // an operator-wide number, live
let shadow: string; // a Central number in shadow mode
let adminCookie: string;
let agent: string;
let approver: string;

beforeAll(async () => {
  w = await aiWorld();
  central = await simAccount(w, { branchId: w.central });
  wide = await simAccount(w, { branchId: null });
  shadow = await simAccount(w, { branchId: w.central, aiMode: 'shadow' });
  adminCookie = await signInAs(w.ctx.app, ADMIN.phone, ADMIN.password);
  const receptionCentral = await teamOf(w, 'reception', w.central);
  [agent] = await staff(w, '+66810008001', 'AI Test Agent', 'inbox_agent', {
    scopeType: 'department',
    scopeId: receptionCentral.departmentId!,
  });
  approver = agent;
  await kb(w, approver, {
    key: 'socks',
    topic: 'socks',
    language: 'en',
    question: 'Do we need socks?',
    body: 'Yes, everyone on the play floor wears grip socks. You can buy them at reception.',
  });
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

describe('scheduling: the ingest writes the turn (§A.1)', () => {
  it('a customer message in hours writes one pending turn, debounced 20 s, and audits it', async () => {
    const before = Date.now();
    const conv = await customer(w, central, nextPhone(), `hello ${SENTINEL}`);
    const turns = await turnsOf(w, conv.id);
    expect(turns).toHaveLength(1);
    const [t] = turns;
    expect(t!.state).toBe('pending');
    const [msg] = await w.ctx.db
      .select()
      .from(s.message)
      .where(and(eq(s.message.conversationId, conv.id), eq(s.message.direction, 'inbound')));
    expect(t!.triggerMessageId).toBe(msg!.id);
    const wait = t!.dueAt.getTime() - before;
    expect(wait).toBeGreaterThanOrEqual(19_000);
    expect(wait).toBeLessThanOrEqual(25_000);
    const [row] = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.ai.turn.schedule'), eq(s.auditLog.entityId, t!.id)));
    expect(row!.after).toMatchObject({ turnId: t!.id, conversationId: conv.id, triggerMessageId: msg!.id, extended: false });
  });

  it('three bubbles make one turn whose trigger is the newest; its due time never passes first seen + 60 s', async () => {
    const phone = nextPhone();
    await customer(w, central, phone, 'hi');
    await customer(w, central, phone, 'we are three');
    const conv = await customer(w, central, phone, `how much is it ${SENTINEL}`);
    const turns = await turnsOf(w, conv.id);
    expect(turns).toHaveLength(1);
    const [newest] = await w.ctx.db
      .select()
      .from(s.message)
      .where(and(eq(s.message.conversationId, conv.id), eq(s.message.direction, 'inbound')))
      .orderBy(desc(s.message.createdAt), desc(s.message.id))
      .limit(1);
    expect(turns[0]!.triggerMessageId).toBe(newest!.id);
    expect(turns[0]!.dueAt.getTime()).toBeLessThanOrEqual(turns[0]!.firstSeenAt.getTime() + 60_000);
    expect(turns[0]!.dueAt.getTime()).toBeGreaterThan(turns[0]!.firstSeenAt.getTime());
  });

  it('out of hours writes no turn, and the rails’ out-of-hours reply still goes', async () => {
    const closed = await simAccount(w, { branchId: w.central, openingHours: closedNowHours() });
    const conv = await customer(w, closed, nextPhone(), 'are you open tomorrow?');
    expect(await turnsOf(w, conv.id)).toHaveLength(0);
    const lines = await w.ctx.db
      .select()
      .from(s.message)
      .where(and(eq(s.message.conversationId, conv.id), eq(s.message.direction, 'outbound')));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.authorKind).toBe('system');
  });

  it('each kill switch writes no turn: the deploy switch, the account’s mode, the thread’s pause', async () => {
    w.ctx.app.inboxAi.config.enabled = false;
    try {
      const conv = await customer(w, central, nextPhone(), 'hello');
      expect(await turnsOf(w, conv.id)).toHaveLength(0);
    } finally {
      w.ctx.app.inboxAi.config.enabled = true;
    }
    const off = await simAccount(w, { branchId: w.central, aiMode: 'off' });
    expect(await turnsOf(w, (await customer(w, off, nextPhone(), 'hello')).id)).toHaveLength(0);

    const phone = nextPhone();
    const conv = await customer(w, central, phone, 'hello');
    await w.ctx.db.update(s.aiTurn).set({ state: 'cancelled', reason: 'PAUSED' }).where(eq(s.aiTurn.conversationId, conv.id));
    await w.ctx.db.update(s.conversation).set({ aiPausedAt: new Date() }).where(eq(s.conversation.id, conv.id));
    await customer(w, central, phone, 'anyone?');
    expect((await turnsOf(w, conv.id)).filter((t) => t.state === 'pending')).toHaveLength(0);
  });
});

describe('the claim (§A.2)', () => {
  it('two concurrent claims: exactly one wins', async () => {
    const conv = await customer(w, central, nextPhone(), 'hi there');
    const [t] = await turnsOf(w, conv.id);
    const at = later(25_000);
    const both = await Promise.all([claimAiTurn(w.ctx.db, t!.id, at), claimAiTurn(w.ctx.db, t!.id, at)]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect(both.find(Boolean)!.attempts).toBe(1);
    // Not due before its time either.
    const early = await customer(w, central, nextPhone(), 'hi again');
    const [e] = await turnsOf(w, early.id);
    expect(await claimAiTurn(w.ctx.db, e!.id, new Date())).toBeNull();
  });

  it('an expired lease is retried once, then the turn is silence (PROVIDER_ERROR)', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'hello?');
    const [t] = await turnsOf(w, conv.id);
    const t0 = later(25_000);
    expect((await claimAiTurn(w.ctx.db, t!.id, t0))?.attempts).toBe(1);
    // The process "died": the lease runs out and the next claim retries.
    const t1 = new Date(t0.getTime() + AI_LEASE_MS + 1000);
    expect((await claimAiTurn(w.ctx.db, t!.id, t1))?.attempts).toBe(2);
    const t2 = new Date(t1.getTime() + AI_LEASE_MS + 1000);
    expect(await claimAiTurn(w.ctx.db, t!.id, t2)).toBeNull();
    const before = w.fake.remaining;
    const sweep = await tick(w, t2);
    expect(sweep.givenUp).toBeGreaterThanOrEqual(1);
    expect(w.fake.remaining).toBe(before);
    const [after] = await turnsOf(w, conv.id);
    expect(after).toMatchObject({ state: 'silent', reason: 'PROVIDER_ERROR', leaseUntil: null });
    expect((await eventsOf(w, conv.id)).filter((e) => e.kind === 'ai_silent')).toHaveLength(1);
    expect(await aiLines(w, conv.id)).toHaveLength(0);
  });
});

/** Settle every turn due now, so a test starts from a quiet queue. */
async function drain(): Promise<void> {
  const due = await w.ctx.db.select({ id: s.aiTurn.id }).from(s.aiTurn).where(sql`state in ('pending','deciding')`);
  if (due.length === 0) return;
  await w.ctx.db
    .update(s.aiTurn)
    .set({ state: 'cancelled', reason: 'TEST_DRAIN', leaseUntil: null })
    .where(sql`state in ('pending','deciding')`);
}

describe('an answer (§B.5, §B.6)', () => {
  it('queues author_kind ai lines, paced; they leave in order after their typing time; no staff clock moves', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), `do I need socks ${SENTINEL}?`);
    w.fake.push({
      kind: 'decision',
      decision: decision({
        intent: 'socks',
        grounding: ['socks'],
        reason: 'FACT_IN_KB',
        bubbles: [`Yes, everyone on the play floor wears grip socks ${SENTINEL}.`, 'You can buy them at reception 😊'],
      }),
    });
    const t0 = later(25_000);
    const sweep = await tick(w, t0);
    expect(sweep.answered).toBe(1);
    const [turn] = await turnsOf(w, conv.id);
    expect(turn).toMatchObject({
      state: 'answered',
      intent: 'socks',
      action: 'answer',
      certainty: 'sure',
      language: 'en',
      reason: 'OK',
      model: 'claude-opus-5-5',
      personaVersion: PERSONA_VERSION,
      inputTokens: 1500,
      outputTokens: 300,
      cacheReadTokens: 12000,
    });
    expect(turn!.kbVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(turn!.latencyMs).toBeGreaterThanOrEqual(0);

    const lines = await aiLines(w, conv.id);
    expect(lines).toHaveLength(2);
    expect(turn!.messageIds).toEqual(lines.map((l) => l.id));
    for (const l of lines) {
      expect(l).toMatchObject({ direction: 'outbound', authorKind: 'ai', providerStatus: 'queued', bodyLanguage: 'en' });
      expect(l.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(t0.getTime() + 3000);
    }
    expect(lines[1]!.nextAttemptAt!.getTime()).toBeGreaterThan(lines[0]!.nextAttemptAt!.getTime());

    const after = await conversationRow(w, conv.id);
    expect(after.lastStaffMessageAt).toBeNull();
    expect(after.firstResponseAt).toBeNull();
    expect(after.intent).toBe('socks');
    const kinds = (await eventsOf(w, conv.id)).map((e) => e.kind);
    expect(kinds).toContain('classified');
    expect(kinds).toContain('ai_replied');

    // Typing time: nothing leaves before it.
    const early = await tick(w, new Date(t0.getTime() + 1000));
    expect(early.aiMessagesSent).toBe(0);
    expect((await aiLines(w, conv.id)).every((l) => l.providerStatus === 'queued')).toBe(true);
    // Then both, in order.
    const due = await tick(w, new Date(lines[1]!.nextAttemptAt!.getTime() + 1000));
    expect(due.aiMessagesSent).toBe(2);
    const sent = (await sim(w, central)).sent().filter((x) => lines.some((l) => l.id === x.clientRef));
    expect(sent.map((x) => x.clientRef)).toEqual(lines.map((l) => l.id));
    expect((await aiLines(w, conv.id)).every((l) => l.providerStatus === 'sent')).toBe(true);
    expect((await conversationRow(w, conv.id)).lastStaffMessageAt).toBeNull();
  });

  it('only a customer starts a turn: the assistant’s own lines and sends write none', async () => {
    const convs = await w.ctx.db.select({ id: s.aiTurn.id }).from(s.aiTurn).where(eq(s.aiTurn.state, 'pending'));
    expect(convs).toHaveLength(0);
  });

  it('a closing on an AI-only episode marks the thread handled by the assistant (G4)', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'thank you so much!');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'thanks_closing', reason: 'CLOSING', bubbles: ['You’re welcome, see you soon 😊'] }) });
    expect((await tick(w, later(25_000))).answered).toBe(1);
    const after = await conversationRow(w, conv.id);
    expect(after).toMatchObject({ status: 'handled', handledByKind: 'ai', handledByAccountId: null });
    expect((await eventsOf(w, conv.id)).some((e) => e.kind === 'handled' && e.actorKind === 'ai')).toBe(true);
  });

  it('a burst with no words (an image) is silence without a model call (X8)', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), { image: true });
    const before = w.fake.remaining;
    expect((await tick(w, later(25_000))).silent).toBe(1);
    expect(w.fake.remaining).toBe(before);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'silent', reason: 'NO_TEXT' });
  });
});

describe('a handover (§B.5, §C.5)', () => {
  it('a birthday: the brochure, then the holding line verbatim, and the thread moves to Birthdays as the assistant', async () => {
    await drain();
    const fileId = newId();
    await w.ctx.db.insert(s.fileObject).values({
      id: fileId,
      operatorId: w.oto,
      bucket: 'oto-files-test',
      objectKey: 'inbox/templates/brochure.pdf',
      contentType: 'application/pdf',
      size: 2048,
      ownerEntityType: 'inbox.template',
      ownerEntityId: newId(),
    });
    await w.ctx.db
      .update(s.template)
      .set({ attachmentFileIds: [fileId] })
      .where(and(eq(s.template.operatorId, w.oto), eq(s.template.key, 'handover_birthday'), eq(s.template.language, 'en')));
    const [holding] = await w.ctx.db
      .select()
      .from(s.template)
      .where(and(eq(s.template.operatorId, w.oto), eq(s.template.key, 'handover_birthday'), eq(s.template.language, 'en')))
      .limit(1);

    const conv = await customer(w, central, nextPhone(), `a birthday party for my son on the fourteenth ${SENTINEL}`);
    const reception = await teamOf(w, 'reception', w.central);
    expect(conv.teamId).toBe(reception.id);
    w.fake.push({
      kind: 'decision',
      decision: decision({ intent: 'birthday_party', action: 'handover', reason: 'NEEDS_PERSON', sendBrochure: true, bubbles: [] }),
    });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);

    const [turn] = await turnsOf(w, conv.id);
    expect(turn).toMatchObject({ state: 'handed_over', intent: 'birthday_party', action: 'handover' });
    const lines = await aiLines(w, conv.id);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.mediaFileIds).toEqual([fileId]);
    expect(lines[1]).toMatchObject({ body: holding!.body, templateId: holding!.id, mediaFileIds: [] });

    const after = await conversationRow(w, conv.id);
    const birthdays = await teamOf(w, 'birthdays');
    expect(after).toMatchObject({ category: 'birthdays', teamId: birthdays.id });
    const slots = await activeSlots(w, conv.id);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((a) => a.assignedByKind === 'ai' && a.assignedByAccountId === null)).toBe(true);
    const events = await eventsOf(w, conv.id);
    const handover = events.find((e) => e.kind === 'ai_handover');
    expect(handover!.payload).toMatchObject({ intent: 'birthday_party', templateKey: 'handover_birthday', holdingLine: 'template', brochureFileIds: [fileId], reroutedTeamId: birthdays.id });
    expect(events.some((e) => e.kind === 'moved_team' && e.actorKind === 'ai')).toBe(true);

    // The brochure leaves as media, through the send path, after its typing time.
    await tick(w, new Date(lines[1]!.nextAttemptAt!.getTime() + 1000));
    const sent = (await sim(w, central)).sent().filter((x) => x.clientRef === lines[0]!.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe('media');
    expect(w.presigns.length).toBeGreaterThan(0);

    // The handover ends the assistant's episode: the next bubble writes no turn.
    await customer(w, central, `${(await w.ctx.db.select().from(s.contact).where(eq(s.contact.id, conv.contactId)))[0]!.externalHandle.slice(1)}`, 'hello?');
    expect((await turnsOf(w, conv.id)).filter((t) => t.state === 'pending')).toHaveLength(0);
  });

  it('does not re-route a thread a person already assigned (an earlier episode’s seat)', async () => {
    await drain();
    const phone = nextPhone();
    const conv = await customer(w, central, phone, 'hello');
    await drain();
    const primary = await call(w, adminCookie, 'PUT', `/inbox/conversations/${conv.id}/primary`, { assignee: { kind: 'account', id: agent } });
    expect(primary.status, JSON.stringify(primary.body)).toBe(200);
    expect((await call(w, adminCookie, 'POST', `/inbox/conversations/${conv.id}/handle`)).status).toBe(200);
    // The customer writes again: a new episode, the assistant eligible, the person still seated.
    await customer(w, central, phone, 'can we book a birthday?');
    expect((await turnsOf(w, conv.id)).filter((t) => t.state === 'pending')).toHaveLength(1);
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'birthday_party', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    const after = await conversationRow(w, conv.id);
    expect(after.category).toBe('general');
    expect(after.teamId).toBe(conv.teamId);
    const slots = await activeSlots(w, conv.id);
    expect(slots.find((a) => a.slot === 'primary')!.accountId).toBe(agent);
    const handover = (await eventsOf(w, conv.id)).find((e) => e.kind === 'ai_handover');
    expect(handover!.payload).toMatchObject({ reroutedTeamId: null });
  });

  it('a Thai complaint: the Thai template still needs translation, so the checked persona words go; it stays with reception', async () => {
    await drain();
    // The premise, set here since the test night (SCRUM-220 R1) laid every
    // template in its own words: an operator whose Thai complaint line still
    // carries the English source, marked for translation.
    await w.ctx.db
      .update(s.template)
      .set({ body: INBOX_TEMPLATE_BODIES.handover_complaint_onsite, needsTranslation: true })
      .where(and(eq(s.template.operatorId, w.oto), eq(s.template.key, 'handover_complaint_onsite'), eq(s.template.language, 'th')));
    const conv = await customer(w, central, nextPhone(), `พนักงานไม่สุภาพเลยค่ะ ${SENTINEL}`);
    const words = `ขอบคุณที่แจ้งนะคะ ทีมแอดมินจะติดต่อกลับโดยเร็วค่ะ ${SENTINEL}`;
    w.fake.push({
      kind: 'decision',
      decision: decision({ language: 'th', intent: 'complaint_onsite', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [words] }),
    });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    const lines = await aiLines(w, conv.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ body: words, templateId: null, bodyLanguage: 'th' });
    expect((await eventsOf(w, conv.id)).find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({ holdingLine: 'persona' });
    expect((await conversationRow(w, conv.id)).teamId).toBe(conv.teamId);
  });

  it('a park named on a branchless general thread: the branch is set and the thread goes to that park’s reception, as the assistant', async () => {
    await drain();
    const conv = await customer(w, wide, nextPhone(), 'hi, we are coming to Chalong');
    expect(conv.branchId).toBeNull();
    w.fake.push({ kind: 'decision', decision: decision({ branchNamed: 'chalong' }) });
    expect((await tick(w, later(25_000))).answered).toBe(1);
    const after = await conversationRow(w, conv.id);
    const receptionChalong = await teamOf(w, 'reception', w.chalong);
    expect(after).toMatchObject({ branchId: w.chalong, category: 'general', teamId: receptionChalong.id });
    expect((await activeSlots(w, conv.id)).every((a) => a.assignedByKind === 'ai')).toBe(true);
    const events = await eventsOf(w, conv.id);
    expect(events.find((e) => e.kind === 'branch_set')).toMatchObject({ actorKind: 'ai' });
  });

  it('the server overrules a model answer on a handover intent: no words of its answer go', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'can I get a discount for three kids?');
    w.fake.push({
      kind: 'decision',
      decision: decision({ intent: 'discount_negotiation', action: 'answer', bubbles: ['Sure, let me sort that out for you'] }),
    });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    const [turn] = await turnsOf(w, conv.id);
    expect(turn).toMatchObject({ state: 'handed_over', reason: 'OVERRULED_HANDOVER' });
    const lines = await aiLines(w, conv.id);
    const [general] = await w.ctx.db
      .select()
      .from(s.template)
      .where(and(eq(s.template.operatorId, w.oto), eq(s.template.key, 'handover_general'), eq(s.template.language, 'en')))
      .limit(1);
    expect(lines.map((l) => l.body)).toEqual([general!.body]);
  });
});

describe('silence (§B.1, §B.3): every failure of the model', () => {
  const failures = [
    { step: { kind: 'timeout' as const }, word: 'PROVIDER_TIMEOUT' },
    { step: { kind: 'rate_limit' as const }, word: 'PROVIDER_RATE_LIMIT' },
    { step: { kind: 'server_error' as const, status: 503 }, word: 'PROVIDER_UNAVAILABLE' },
    { step: { kind: 'throw' as const, error: new Error(`the request echoed ${SENTINEL}`) }, word: 'PROVIDER_ERROR' },
    { step: { kind: 'refusal' as const }, word: 'REFUSAL' },
    { step: { kind: 'malformed' as const, text: `not json ${SENTINEL}` }, word: 'MALFORMED' },
    { step: { kind: 'max_tokens' as const }, word: 'MAX_TOKENS' },
  ];
  for (const f of failures) {
    it(`${f.step.kind} is silence with ${f.word}, its pill, an ops failure and no line`, async () => {
      await drain();
      const conv = await customer(w, central, nextPhone(), `what time do you open ${SENTINEL}?`);
      w.fake.push(f.step);
      expect((await tick(w, later(25_000))).silent).toBe(1);
      const [turn] = await turnsOf(w, conv.id);
      expect(turn).toMatchObject({ state: 'silent', reason: f.word, action: 'silent' });
      expect(await aiLines(w, conv.id)).toHaveLength(0);
      const pill = (await eventsOf(w, conv.id)).find((e) => e.kind === 'ai_silent');
      expect(pill!.payload).toMatchObject({ turnId: turn!.id, reason: f.word });
      const [run] = await w.ctx.db
        .select()
        .from(s.opsRun)
        .where(and(eq(s.opsRun.name, 'adapter:inbox.ai'), sql`${s.opsRun.detail}->>'turnId' = ${turn!.id}`))
        .limit(1);
      expect(run).toMatchObject({ outcome: 'failed', errorCode: f.word });
      expect((await conversationRow(w, conv.id)).lastStaffMessageAt).toBeNull();
    });
  }

  it('a gate that fails is silence with the gate’s word: an ungrounded number', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'how much?');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'socks', grounding: ['socks'], bubbles: ['Socks are 99 baht'] }) });
    await tick(w, later(25_000));
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'silent', reason: 'GUARD_NUMBER' });
    expect(await aiLines(w, conv.id)).toHaveLength(0);
  });
});

describe('a newer customer message during the call (§A.2)', () => {
  it('supersedes the decision: nothing written, and the newer bubble holds its own pending turn', async () => {
    await drain();
    const phone = nextPhone();
    const conv = await customer(w, central, phone, 'hi');
    w.fake.push({
      kind: 'decision',
      decision: decision(),
      during: async () => {
        await customer(w, central, phone, `wait, one more thing ${SENTINEL}`);
      },
    });
    expect((await tick(w, later(25_000))).superseded).toBe(1);
    const turns = await turnsOf(w, conv.id);
    expect(turns.map((t) => t.state).sort()).toEqual(['pending', 'superseded']);
    expect(await aiLines(w, conv.id)).toHaveLength(0);
    expect((await eventsOf(w, conv.id)).some((e) => e.actorKind === 'ai')).toBe(false);
  });
});

describe('the guards (§D.4)', () => {
  it('the episode cap: three answers in ten minutes, then the fourth question is a CAP_EPISODE handover', async () => {
    await drain();
    // Real time here: each answer's lines must sort before the next question.
    const cfg = w.ctx.app.inboxAi.config;
    const saved = [cfg.debounceMs, cfg.debounceMaxMs] as const;
    cfg.debounceMs = 0;
    cfg.debounceMaxMs = 0;
    const phone = nextPhone();
    let conv = await customer(w, central, phone, 'hi');
    try {
      for (let i = 0; i < 3; i += 1) {
        if (i > 0) conv = await customer(w, central, phone, `another question ${i}`);
        w.fake.push({ kind: 'decision', decision: decision() });
        expect((await tick(w, new Date())).answered).toBe(1);
      }
      await customer(w, central, phone, 'and one more');
      w.fake.push({ kind: 'decision', decision: decision() });
      expect((await tick(w, new Date())).handedOver).toBe(1);
    } finally {
      [cfg.debounceMs, cfg.debounceMaxMs] = saved;
    }
    const turns = await turnsOf(w, conv.id);
    expect(turns.at(-1)).toMatchObject({ state: 'handed_over', reason: 'CAP_EPISODE' });
    const handover = (await eventsOf(w, conv.id)).find((e) => e.kind === 'ai_handover');
    expect(handover!.payload).toMatchObject({ templateKey: 'handover_general', holdingLine: 'template' });
  });

  it('the daily caps: over the turn cap, then the token cap, every turn is CAP_DAILY, raised once', async () => {
    await drain();
    const cfg = w.ctx.app.inboxAi.config;
    const [{ n }] = (
      await w.ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from inbox.ai_turn where latency_ms is not null`)
    ).rows as [{ n: number }];
    const saved = { turns: cfg.dailyTurnCap, tokens: cfg.dailyTokenCap };
    try {
      cfg.dailyTurnCap = Number(n);
      const before = w.fake.remaining;
      const a = await customer(w, central, nextPhone(), 'hello');
      const b = await customer(w, central, nextPhone(), 'hello');
      await tick(w, later(25_000));
      expect(w.fake.remaining).toBe(before);
      expect((await turnsOf(w, a.id))[0]).toMatchObject({ state: 'silent', reason: 'CAP_DAILY' });
      expect((await turnsOf(w, b.id))[0]).toMatchObject({ state: 'silent', reason: 'CAP_DAILY' });
      const raised = await w.ctx.db
        .select()
        .from(s.opsRun)
        .where(and(eq(s.opsRun.name, 'adapter:inbox.ai'), eq(s.opsRun.errorCode, 'CAP_DAILY')));
      expect(raised).toHaveLength(1);

      cfg.dailyTurnCap = saved.turns;
      cfg.dailyTokenCap = 1;
      const c = await customer(w, central, nextPhone(), 'hello');
      await tick(w, later(25_000));
      expect((await turnsOf(w, c.id))[0]).toMatchObject({ state: 'silent', reason: 'CAP_DAILY' });
      expect(
        await w.ctx.db.select().from(s.opsRun).where(and(eq(s.opsRun.name, 'adapter:inbox.ai'), eq(s.opsRun.errorCode, 'CAP_DAILY'))),
      ).toHaveLength(1);
    } finally {
      cfg.dailyTurnCap = saved.turns;
      cfg.dailyTokenCap = saved.tokens;
    }
  });

  it('a kill switch thrown while a turn waits cancels it: the account’s mode, then the deploy switch', async () => {
    await drain();
    const acct = await simAccount(w, { branchId: w.central });
    const conv = await customer(w, acct, nextPhone(), 'hello');
    await w.ctx.db.update(s.channelAccount).set({ aiMode: 'off' }).where(eq(s.channelAccount.id, acct));
    await tick(w, later(25_000));
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'cancelled', reason: 'MODE_OFF' });

    const other = await customer(w, central, nextPhone(), 'hello');
    w.ctx.app.inboxAi.config.enabled = false;
    try {
      await tick(w, later(25_000));
    } finally {
      w.ctx.app.inboxAi.config.enabled = true;
    }
    expect((await turnsOf(w, other.id))[0]).toMatchObject({ state: 'cancelled', reason: 'DISABLED' });
    expect(await aiLines(w, other.id)).toHaveLength(0);
  });

  it('shadow mode records the decision on the turn and writes nothing to the thread', async () => {
    await drain();
    const conv = await customer(w, shadow, nextPhone(), `do I need socks ${SENTINEL}`);
    const eventsBefore = (await eventsOf(w, conv.id)).length;
    const previewBefore = (await conversationRow(w, conv.id)).lastMessagePreview;
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'socks', grounding: ['socks'], bubbles: [`Yes, grip socks ${SENTINEL}`] }) });
    expect((await tick(w, later(25_000))).shadowed).toBe(1);
    const [turn] = await turnsOf(w, conv.id);
    expect(turn).toMatchObject({ state: 'shadowed', intent: 'socks', action: 'answer', certainty: 'sure', reason: 'OK', messageIds: [] });
    expect(await aiLines(w, conv.id)).toHaveLength(0);
    expect(await eventsOf(w, conv.id)).toHaveLength(eventsBefore);
    const after = await conversationRow(w, conv.id);
    expect(after.lastMessagePreview).toBe(previewBefore);
    expect(after.intent).toBe(conv.intent);
  });

  it('the job is registered beside the send job, every five seconds', () => {
    const jobs = buildDefaultJobs({ db: w.ctx.db, env: w.ctx.app.env, log: w.ctx.app.log, channels: [], inboxAi: w.ctx.app.inboxAi });
    expect(jobs.find((j) => j.name === INBOX_AI_JOB)?.intervalSeconds).toBe(5);
  });

  it('the circuit breaker: five provider failures in a row pause the assistant ten minutes, raised once', async () => {
    await drain();
    const convs = [];
    for (let i = 0; i < 5; i += 1) convs.push(await customer(w, central, nextPhone(), 'hello'));
    for (let i = 0; i < 5; i += 1) w.fake.push({ kind: 'timeout' });
    const t0 = later(25_000);
    await tick(w, t0);
    for (const c of convs) expect((await turnsOf(w, c.id))[0]).toMatchObject({ state: 'silent', reason: 'PROVIDER_TIMEOUT' });
    const opened = await w.ctx.db
      .select()
      .from(s.opsRun)
      .where(and(eq(s.opsRun.name, 'adapter:inbox.ai'), eq(s.opsRun.errorCode, 'CIRCUIT_OPEN')));
    expect(opened).toHaveLength(1);

    // Open: the next turn is silence without a call.
    const next = await customer(w, central, nextPhone(), 'hello');
    const before = w.fake.remaining;
    await tick(w, new Date(t0.getTime() + 1000));
    expect(w.fake.remaining).toBe(before);
    expect((await turnsOf(w, next.id))[0]).toMatchObject({ state: 'silent', reason: 'CIRCUIT_OPEN' });

    // Ten minutes on, one call is tried again (half-open), and an answer closes it.
    const after = await customer(w, central, nextPhone(), 'hello');
    const [pending] = await turnsOf(w, after.id);
    await w.ctx.db.update(s.aiTurn).set({ dueAt: new Date(t0.getTime() + CIRCUIT_PAUSE_MS + 1000) }).where(eq(s.aiTurn.id, pending!.id));
    w.fake.push({ kind: 'decision', decision: decision() });
    await tick(w, new Date(t0.getTime() + CIRCUIT_PAUSE_MS + 2000));
    expect((await turnsOf(w, after.id))[0]).toMatchObject({ state: 'answered' });
  });
});

describe('the environment (§D.6)', () => {
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused' } as const;

  it('the assistant on without ANTHROPIC_API_KEY refuses the boot, naming the variable', () => {
    expect(() => loadEnv({ ...base, INBOX_AI_ENABLED: 'true' })).toThrow(/INBOX_AI_ENABLED is true but ANTHROPIC_API_KEY is not set/);
    expect(() => loadEnv({ ...base, INBOX_AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'k' })).not.toThrow();
  });

  it('defaults: off, Opus at low effort, 20 / 60 s, 1500 turns and 30 M tokens a day; a test never gets a real client', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({
      INBOX_AI_ENABLED: 'false',
      INBOX_AI_MODEL: 'claude-opus-5-5',
      INBOX_AI_EFFORT: 'low',
      INBOX_AI_TIMEOUT_MS: 20_000,
      INBOX_AI_DEBOUNCE_S: 20,
      INBOX_AI_DEBOUNCE_MAX_S: 60,
      INBOX_AI_DAILY_TURN_CAP: 1500,
      INBOX_AI_DAILY_TOKEN_CAP: 30_000_000,
    });
    const on = buildInboxAiRuntime(loadEnv({ ...base, INBOX_AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'k' }));
    expect(on.config).toMatchObject({ enabled: true, debounceMs: 20_000, debounceMaxMs: 60_000 });
    expect(on.client).toBeNull();
  });
});

describe('the no-body sentinel on every path (§D.1)', () => {
  it('no customer line and no assistant line reached audit, events, ops or the log', async () => {
    // Not vacuous: the string is in the message table, and the log was captured.
    const [held] = (
      await w.ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from inbox.message where body like ${`%${SENTINEL}%`}`)
    ).rows as [{ n: number }];
    expect(Number(held.n)).toBeGreaterThan(5);
    expect(w.logLines.length).toBeGreaterThan(0);
    expect(await sentinelLeaks(w.ctx.db, SENTINEL, w.logLines)).toEqual(NO_LEAKS);
    // The turn rows hold no text either: every text column is a word or null.
    const [bad] = (
      await w.ctx.db.execute<{ n: number }>(
        sql`select count(*)::int as n from inbox.ai_turn where coalesce(reason,'') || coalesce(intent,'') || coalesce(model,'') like ${`%${SENTINEL}%`}`,
      )
    ).rows as [{ n: number }];
    expect(Number(bad.n)).toBe(0);
  });
});
