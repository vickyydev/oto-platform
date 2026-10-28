import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeCoherenceReviewer, reviewOps, type AiDecision, type FakeReviewScriptEntry, type FakeScriptEntry } from '@oto/assistant';
import { schema as s } from '@oto/db';
import { INBOX_TEMPLATE_BODIES } from '@oto/db/seed';
import { teardownAll } from './helpers';
import { NO_LEAKS, sentinelLeaks } from './inbox-sentinel';
import {
  SENTINEL,
  aiLines,
  aiWorld,
  customer,
  decision,
  eventsOf,
  kb,
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
 * SCRUM-678, THE RETHINK: the coherence reviewer may say the composed reply
 * answers something else than the customer asked (WRONG_TOPIC), with its own
 * reading of the message. It never rewrites: the turn goes back through the
 * WHOLE pipeline once — decide again with the reading beside the customer's
 * words, gate again, review again — and a second miss, or any second pass
 * that cannot be sent, becomes the unclear hand-over (item D). One rethink
 * per burst, never silence on a main channel, never a third round.
 *
 * FICTIONAL TEST DATA throughout.
 */

let w: AiWorld;
let reviewer: FakeCoherenceReviewer;
let central: string;

/** The owner's case: "do you have camp today?" answered with the group-deal script. */
const CAMP = `do you have camp today? ${SENTINEL}`;
const GROUP_DEAL = "We'd love to welcome your school or group, and we can put together a special deal!";
const READING = `Asks whether a kids' camp runs at the park today ${SENTINEL}`;
const groupDeal = (): AiDecision => decision({ intent: 'events_groups', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [GROUP_DEAL] });
const wrongTopic: FakeReviewScriptEntry = { kind: 'wrong_topic', reading: READING, suggestedIntent: 'special_event' };

beforeAll(async () => {
  w = await aiWorld();
  central = await simAccount(w, { branchId: w.central });
  const receptionCentral = await teamOf(w, 'reception', w.central);
  const [approver] = await staff(w, '+66810009401', 'Rethink Test Approver', 'inbox_agent', {
    scopeType: 'department',
    scopeId: receptionCentral.departmentId!,
  });
  await kb(w, approver, {
    key: 'hours-note',
    topic: 'hours_note',
    language: 'en',
    question: 'When are you open?',
    body: 'We are open every day from 10:00 to 20:00.',
  });
}, 300_000);

/** The lines that go to the customer: every AI line but the never-sent shadow rows. */
async function sentLines(conversationId: string) {
  return (await aiLines(w, conversationId)).filter((l) => (l.providerStatus as string) !== 'shadow');
}

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

async function fresh(...script: FakeReviewScriptEntry[]): Promise<void> {
  await w.ctx.db
    .update(s.aiTurn)
    .set({ state: 'cancelled', reason: 'TEST_DRAIN', leaseUntil: null })
    .where(sql`state in ('pending','deciding')`);
  reviewer = new FakeCoherenceReviewer(script);
  w.ctx.app.inboxAi.reviewer = reviewer;
  w.ctx.app.inboxAi.config.reviewTimeoutMs = 2_000;
}

async function decideAudit(turnId: string) {
  const [row] = await w.ctx.db
    .select({ after: s.auditLog.after })
    .from(s.auditLog)
    .where(and(eq(s.auditLog.action, 'inbox.ai.turn.decide'), eq(s.auditLog.entityId, turnId)))
    .limit(1);
  return (row?.after ?? {}) as Record<string, unknown>;
}

/** The camp question, the first decision the group-deal script, then whatever the second round scripts. */
async function campTurn(second: FakeScriptEntry[]) {
  const conv = await customer(w, central, nextPhone(), CAMP);
  const asked = w.fake.requests.length;
  w.fake.push({ kind: 'decision', decision: groupDeal() }, ...second);
  await tick(w, later(25_000));
  const [turn] = await turnsOf(w, conv.id);
  const all = await w.ctx.db.select().from(s.message).where(eq(s.message.conversationId, conv.id));
  return {
    conv,
    turn: turn!,
    lines: await sentLines(conv.id),
    events: await eventsOf(w, conv.id),
    prompts: w.fake.requests.slice(asked).map((r) => r.prompt.messages[0].content),
    readingRows: all.filter((m) => m.authorKind === 'ai' && (m.providerStatus as string) === 'shadow'),
  };
}

describe('the camps case: the reply answered something else, so the turn is decided again', () => {
  it('the second pass hands over without the deal line; two decisions, one review, and the reading rides as a hint', async () => {
    await fresh(wrongTopic);
    const t = await campTurn([
      { kind: 'decision', decision: decision({ intent: 'special_event', action: 'handover', reason: 'FACT_MISSING', bubbles: [] }) },
    ]);
    expect(t.prompts).toHaveLength(2);
    expect(reviewer.requests).toHaveLength(1);
    expect(w.fake.remaining).toBe(0);
    // The customer's own words stay what is answered; the reading sits beside them as data.
    expect(t.prompts[0]).not.toContain('second_reading');
    expect(t.prompts[1]).toContain(CAMP);
    expect(t.prompts[1]).toContain('<second_reading>');
    expect(t.prompts[1]).toContain('"suggestedIntent":"special_event"');
    expect(t.prompts[1]).toContain(READING);
    // No deal line went: the birthday & events desk's closing line alone.
    expect(t.lines.map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_birthday]);
    expect(t.lines.some((l) => (l.body ?? '').includes('special deal'))).toBe(false);
    expect(t.turn).toMatchObject({ state: 'handed_over', intent: 'special_event', reason: 'OK' });
  });

  it('the turn record says it was rethought and why, with both rounds, and the reading for staff where message text lives', async () => {
    await fresh(wrongTopic);
    const t = await campTurn([
      { kind: 'decision', decision: decision({ intent: 'special_event', action: 'handover', reason: 'FACT_MISSING', bubbles: [] }) },
    ]);
    expect(t.readingRows).toHaveLength(1);
    const reading = t.readingRows[0]!;
    expect(reading).toMatchObject({ body: READING, nextAttemptAt: null });
    const record = {
      rethought: true,
      why: 'WRONG_TOPIC',
      suggestedIntent: 'special_event',
      readingMessageId: reading.id,
      ended: 'reply',
      rounds: [
        { intent: 'events_groups', action: 'answer', reason: 'OK', topic: 'wrong_topic' },
        { intent: 'special_event', action: 'handover', reason: 'OK', topic: null },
      ],
    };
    expect(await decideAudit(t.turn.id)).toMatchObject({ rethink: record });
    expect(t.events.find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({ rethink: record });
    // The reading is staff's to read, never sent and never a reply in the episode.
    expect(reading.createdAt.getTime()).toBeLessThan(t.lines[0]!.createdAt.getTime());
    // No text of the thread, the reply or the reading reaches the audit, the timeline or the ops rows.
    expect(await sentinelLeaks(w.ctx.db, SENTINEL, w.logLines)).toEqual(NO_LEAKS);
  });

  it('a second pass that answers is sent, and is reviewed again for coherence', async () => {
    await fresh(wrongTopic, { kind: 'keep_all' });
    const t = await campTurn([
      {
        kind: 'decision',
        decision: decision({
          intent: 'hours',
          intents: ['hours', 'custom_request'],
          grounding: ['hours-note'],
          reason: 'FACT_IN_KB',
          bubbles: ['We are open every day from 10:00 to 20:00 😊'],
        }),
      },
    ]);
    expect(reviewer.requests).toHaveLength(2);
    expect(t.lines.map((l) => l.body)).toEqual(['We are open every day from 10:00 to 20:00 😊', INBOX_TEMPLATE_BODIES.closing_unclear]);
    expect(t.events.find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({
      coherence: { state: 'reviewed' },
      rethink: { rethought: true, ended: 'reply', rounds: [{ topic: 'wrong_topic' }, { intent: 'hours', topic: 'answers' }] },
    });
  });
});

describe('the bound: one rethink per burst, then the unclear line', () => {
  it('a second WRONG_TOPIC ends in the unclear line and the route: exactly two rounds, no third', async () => {
    await fresh(wrongTopic, { kind: 'wrong_topic', reading: 'Still asks about a camp', suggestedIntent: null });
    const t = await campTurn([{ kind: 'decision', decision: groupDeal() }]);
    expect(t.prompts).toHaveLength(2);
    expect(reviewer.requests).toHaveLength(2);
    expect(w.fake.remaining).toBe(0);
    expect(t.lines.map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_unclear]);
    expect(t.turn).toMatchObject({ state: 'handed_over', action: 'handover', reason: 'WRONG_TOPIC' });
    // The thread stays with its park (the unclear row: the branch when it is known).
    const receptionCentral = await teamOf(w, 'reception', w.central);
    const [conv] = await w.ctx.db.select().from(s.conversation).where(eq(s.conversation.id, t.conv.id));
    expect(conv!.teamId).toBe(receptionCentral.id);
    expect(await decideAudit(t.turn.id)).toMatchObject({
      reason: 'WRONG_TOPIC',
      rethink: {
        rethought: true,
        ended: 'unclear',
        rounds: [
          { intent: 'events_groups', topic: 'wrong_topic' },
          { intent: 'events_groups', topic: 'wrong_topic' },
        ],
      },
    });
  });

  it.each([
    ['the second decision fails at the provider', { kind: 'timeout' } as const, 'PROVIDER_TIMEOUT'],
    ['the model stays silent the second time', { kind: 'decision', decision: decision({ intent: 'other', action: 'silent', reason: 'OUT_OF_SCOPE', bubbles: [] }) } as const, 'INTENT_SILENT'],
  ])('%s: the unclear line and the route, never silence', async (_name, step, roundReason) => {
    await fresh(wrongTopic);
    const t = await campTurn([step]);
    expect(t.prompts).toHaveLength(2);
    expect(t.lines.map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_unclear]);
    expect(t.turn).toMatchObject({ state: 'handed_over', reason: 'WRONG_TOPIC' });
    expect((await decideAudit(t.turn.id)).rethink).toMatchObject({ ended: 'unclear', rounds: [{ topic: 'wrong_topic' }, { reason: roundReason }] });
  });

  it('a second reply the gate withholds goes the item D way: the unclear line, the guard named on the turn', async () => {
    await fresh(wrongTopic);
    const t = await campTurn([
      { kind: 'decision', decision: decision({ intent: 'hours', grounding: ['hours-note'], reason: 'FACT_IN_KB', bubbles: ['We are open until 23:00 tonight'] }) },
    ]);
    expect(t.lines.map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_unclear]);
    expect(t.turn).toMatchObject({ state: 'handed_over', reason: 'GUARD_NUMBER' });
    expect((await decideAudit(t.turn.id)).rethink).toMatchObject({ ended: 'unclear', rounds: [{ topic: 'wrong_topic' }, { action: 'silent', reason: 'GUARD_NUMBER' }] });
  });

  it('a turn re-claimed after its rethink began never rethinks again: a WRONG_TOPIC is the unclear line at once', async () => {
    await fresh(wrongTopic);
    const conv = await customer(w, central, nextPhone(), CAMP);
    const [pending] = await turnsOf(w, conv.id);
    // As a lease that ran out mid-rethink leaves it: claimed once, flagged, the lease gone.
    await w.ctx.db
      .update(s.aiTurn)
      .set({ state: 'deciding', attempts: 1, reason: 'RETHINK', leaseUntil: new Date(Date.now() - 1_000) })
      .where(eq(s.aiTurn.id, pending!.id));
    const asked = w.fake.requests.length;
    w.fake.push({ kind: 'decision', decision: groupDeal() });
    await tick(w, later(25_000));
    expect(w.fake.requests.length - asked).toBe(1);
    expect(reviewer.requests).toHaveLength(1);
    expect((await sentLines(conv.id)).map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_unclear]);
    const [turn] = await turnsOf(w, conv.id);
    expect(turn).toMatchObject({ state: 'handed_over', reason: 'WRONG_TOPIC', attempts: 2 });
  });
});

describe('the kill switch governs the whole review stage', () => {
  it('switched off: no review, so no rethink — the first reply goes', async () => {
    await fresh(wrongTopic);
    await w.ctx.db.execute(sql`delete from core.setting where operator_id = ${w.oto} and key = 'assistant_settings'`);
    await w.ctx.db.execute(sql`insert into core.setting(operator_id, key, value) values (${w.oto}, 'assistant_settings',
      ${JSON.stringify({ schemaVersion: 1, overrides: { internal: {}, inbox: { coherenceReview: false } }, rates: [] })}::jsonb)`);
    try {
      const t = await campTurn([]);
      expect(t.prompts).toHaveLength(1);
      expect(reviewer.requests).toHaveLength(0);
      expect(t.lines.map((l) => l.body)).toEqual([GROUP_DEAL, INBOX_TEMPLATE_BODIES.closing_birthday]);
      expect((await decideAudit(t.turn.id)).rethink).toBeNull();
    } finally {
      await w.ctx.db.execute(sql`delete from core.setting where operator_id = ${w.oto} and key = 'assistant_settings'`);
    }
  });

  it('an ordinary review keeps the first reply and records no rethink', async () => {
    await fresh({ kind: 'review', decision: reviewOps({}) });
    const t = await campTurn([]);
    expect(t.prompts).toHaveLength(1);
    expect(t.lines.map((l) => l.body)).toEqual([GROUP_DEAL, INBOX_TEMPLATE_BODIES.closing_birthday]);
    expect(t.readingRows).toHaveLength(0);
    expect((await decideAudit(t.turn.id)).rethink).toBeNull();
  });
});
