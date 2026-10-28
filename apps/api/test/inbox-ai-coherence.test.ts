import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_USAGE, FakeCoherenceReviewer, REVIEW_VERSION, reviewOps, type FakeReviewScriptEntry } from '@oto/assistant';
import { schema as s } from '@oto/db';
import { INBOX_TEMPLATE_BODIES } from '@oto/db/seed';
import { newId } from '@oto/shared';
import { ADMIN, signInAs, teardownAll } from './helpers';
import { NO_LEAKS, sentinelLeaks } from './inbox-sentinel';
import {
  SENTINEL,
  aiLines,
  aiWorld,
  conversationRow,
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
 * SCRUM-677, THE COHERENCE REVIEWER IN THE TURN ENGINE: an outgoing reply
 * reads as ONE message. After the gate and before the bubbles are scheduled,
 * a send that mixes the model's words and an appended fixed line is shown to
 * the reviewer, which returns operations only; the engine applies them under
 * its own rules and fails open on anything else. Against a real embedded
 * database, the `FakeAssistantClient` and the `FakeCoherenceReviewer`.
 *
 * FICTIONAL TEST DATA throughout.
 */

let w: AiWorld;
let reviewer: FakeCoherenceReviewer;
let central: string;
let chalong: string;
/** An operator-wide number: a thread with no park (the live case of 29 Oct). */
let wide: string;
let adminCookie: string;

const BOOKING_LINE = INBOX_TEMPLATE_BODIES.closing_booking;
const FACTS = `Our nanny is one-on-one care at Central Floresta, from 3 years old 😊 ${SENTINEL}`;
/** A wrap-up that already says who follows up and why. */
const COVERED = 'A colleague at Central Floresta will message you to confirm it. Have a lovely day!';
/** A wrap-up that only says goodbye. */
const GOODBYE = 'Have a lovely day!';

const nanny = (bubbles: string[]) => decision({ intent: 'nanny_booking', grounding: ['nanny'], reason: 'FACT_IN_KB', bubbles });

beforeAll(async () => {
  w = await aiWorld();
  reviewer = new FakeCoherenceReviewer();
  w.ctx.app.inboxAi.reviewer = reviewer;
  central = await simAccount(w, { branchId: w.central });
  chalong = await simAccount(w, { branchId: w.chalong });
  wide = await simAccount(w, { branchId: null });
  const receptionCentral = await teamOf(w, 'reception', w.central);
  const [approver] = await staff(w, '+66810009301', 'Coherence Test Approver', 'inbox_agent', {
    scopeType: 'department',
    scopeId: receptionCentral.departmentId!,
  });
  await kb(w, approver, {
    key: 'nanny',
    topic: 'faq',
    language: 'en',
    question: 'Do you have a nanny service?',
    body: 'Our nanny service is one-on-one care at Central Floresta for children from 3 years old. Please book ahead.',
  });
  await kb(w, approver, {
    key: 'hours-note',
    topic: 'hours_note',
    language: 'en',
    question: 'When are you open?',
    body: 'We are open every day from 10:00 to 20:00.',
  });
  adminCookie = await signInAs(w.ctx.app, ADMIN.phone, ADMIN.password);
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

/** Settle every turn due now, and give each test a reviewer with its own script. */
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

async function nannyTurn(bubbles: string[], account = chalong) {
  const conv = await customer(w, account, nextPhone(), `do you have a nanny for my 3 year old? ${SENTINEL}`);
  w.fake.push({ kind: 'decision', decision: nanny(bubbles) });
  const sweep = await tick(w, later(25_000));
  const [turn] = await turnsOf(w, conv.id);
  return { conv, sweep, turn: turn!, lines: await aiLines(w, conv.id), events: await eventsOf(w, conv.id) };
}

describe('the owner’s case: a nanny answer that wraps up, and the closing line after it', () => {
  it('the model already said who follows up: the canned closing is dropped — one goodbye, the hand-over still made', async () => {
    await fresh({ kind: 'review', decision: reviewOps({ drop: [2] }) });
    const t = await nannyTurn([FACTS, COVERED]);
    expect(t.sweep.handedOver).toBe(1);
    expect(t.lines.map((l) => l.body)).toEqual([FACTS, COVERED]);
    // The reviewer saw the items in order, with their origins, nothing locked.
    expect(reviewer.requests).toHaveLength(1);
    expect(reviewer.requests[0]!.items).toEqual([
      { origin: 'model', text: FACTS, locked: false },
      { origin: 'model', text: COVERED, locked: false },
      { origin: 'template', text: BOOKING_LINE, locked: false },
    ]);
    expect(reviewer.requests[0]!.thread.at(-1)).toMatchObject({ from: 'customer' });
    // The hand-over is unchanged: Central's desk has the thread.
    const receptionCentral = await teamOf(w, 'reception', w.central);
    expect(await conversationRow(w, t.conv.id)).toMatchObject({ teamId: receptionCentral.id, branchId: w.central });
    const record = { state: 'reviewed', version: REVIEW_VERSION, items: 3, sent: 2, merged: 0, dropped: [{ index: 2, origin: 'template', key: 'closing_booking' }] };
    expect(t.events.find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({ closingKey: 'closing_booking', coherence: record, messageIds: t.lines.map((l) => l.id) });
    expect(t.events.find((e) => e.kind === 'ai_replied')!.payload).toMatchObject({ coherence: record });
    expect(await decideAudit(t.turn.id)).toMatchObject({ coherence: record });
    expect(t.turn).toMatchObject({ state: 'handed_over', messageIds: t.lines.map((l) => l.id) });
  });

  it('the model only said goodbye: its sign-off goes, and the line that says WHY Central writes survives', async () => {
    await fresh({ kind: 'review', decision: reviewOps({ drop: [1] }) });
    const t = await nannyTurn([FACTS, GOODBYE]);
    expect(t.lines.map((l) => l.body)).toEqual([FACTS, BOOKING_LINE]);
    // The booking line still goes verbatim from its template.
    const [tpl] = await w.ctx.db.select({ key: s.template.key }).from(s.template).where(eq(s.template.id, t.lines[1]!.templateId!));
    expect(tpl!.key).toBe('closing_booking');
    expect(t.events.find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({
      coherence: { state: 'reviewed', dropped: [{ index: 1, origin: 'model', key: null }] },
    });
  });

  it('the live case (29 Oct): the model’s last line already promises the follow-up, so the booking line after it goes', async () => {
    await fresh({ kind: 'review', decision: reviewOps({ drop: [2] }) });
    const LIVE = 'A colleague at Central Floresta will help you with the booking.';
    const t = await nannyTurn([FACTS, LIVE], wide);
    // On the parkless thread the appended line is the booking one, and the reviewer is shown it after the model's promise.
    expect(reviewer.requests[0]!.items.map((i) => [i.origin, i.text, i.locked])).toEqual([
      ['model', FACTS, false],
      ['model', LIVE, false],
      ['template', BOOKING_LINE, false],
    ]);
    // Dropped: the follow-up is said once, in the model's own words; nothing is lost.
    expect(t.lines.map((l) => l.body)).toEqual([FACTS, LIVE]);
    expect(t.events.find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({
      closingKey: 'closing_booking',
      coherence: { state: 'reviewed', sent: 2, dropped: [{ index: 2, origin: 'template', key: 'closing_booking' }] },
    });
  });

  it('merges join neighbours into one bubble with no new words; a merged line is no verbatim template line', async () => {
    await fresh({ kind: 'review', decision: reviewOps({ merge: [{ index: 1, joiner: 'space' }] }) });
    const t = await nannyTurn([FACTS, GOODBYE]);
    expect(t.lines.map((l) => l.body)).toEqual([FACTS, `${GOODBYE} ${BOOKING_LINE}`]);
    expect(t.lines[1]!.templateId).toBeNull();
    // The paced schedule is the reviewed reply's: two bubbles, in order.
    expect(t.lines[1]!.nextAttemptAt!.getTime()).toBeGreaterThan(t.lines[0]!.nextAttemptAt!.getTime());
    expect(t.events.find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({ coherence: { state: 'reviewed', merged: 1, sent: 2, dropped: [] } });
  });

  it('the review’s tokens are the turn’s: the daily caps count them; its run is an ops row of its own', async () => {
    await fresh({ kind: 'keep_all' });
    const t = await nannyTurn([FACTS, GOODBYE]);
    expect(t.lines.map((l) => l.body)).toEqual([FACTS, GOODBYE, BOOKING_LINE]);
    expect(t.turn).toMatchObject({
      inputTokens: FAKE_USAGE.inputTokens * 2,
      outputTokens: FAKE_USAGE.outputTokens * 2,
      cacheReadTokens: FAKE_USAGE.cacheReadTokens * 2,
    });
    const runs = await w.ctx.db.execute<{ outcome: string; detail: Record<string, unknown> }>(
      sql`select outcome, detail from core.ops_run where name = 'adapter:inbox.ai.review' and detail->>'turnId' = ${t.turn.id}`,
    );
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({ outcome: 'ok', detail: { turnId: t.turn.id, outcome: 'ok', version: REVIEW_VERSION } });
  });

  it('no text of the reply or the thread reaches the audit, the timeline or the ops rows', async () => {
    await fresh({ kind: 'review', decision: reviewOps({ drop: [2] }) });
    await nannyTurn([FACTS, COVERED]);
    expect(await sentinelLeaks(w.ctx.db, SENTINEL, w.logLines)).toEqual(NO_LEAKS);
  });
});

describe('fail open: the reply is never blocked', () => {
  it.each([
    ['a reviewer that does not answer within the cap', { kind: 'hang' } as const, 'failed', 'PROVIDER_TIMEOUT'],
    ['a provider failure', { kind: 'server_error' } as const, 'failed', 'PROVIDER_UNAVAILABLE'],
    ['a malformed verdict', { kind: 'malformed' } as const, 'failed', 'MALFORMED'],
    ['a verdict that drops everything', { kind: 'review', decision: reviewOps({ drop: [0, 1, 2] }) } as const, 'ignored', 'DROP_ALL'],
    ['an index that is not in the reply', { kind: 'review', decision: reviewOps({ drop: [7] }) } as const, 'ignored', 'INVALID_INDEX'],
    ['a merge across a dropped line', { kind: 'review', decision: reviewOps({ drop: [1], merge: [{ index: 0, joiner: 'space' }] }) } as const, 'ignored', 'BAD_MERGE'],
  ])('%s: the reply goes as composed, and the turn says why', async (_name, step, state, reason) => {
    await fresh(step);
    w.ctx.app.inboxAi.config.reviewTimeoutMs = 50;
    const started = Date.now();
    const t = await nannyTurn([FACTS, GOODBYE]);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(t.lines.map((l) => l.body)).toEqual([FACTS, GOODBYE, BOOKING_LINE]);
    expect(t.turn.state).toBe('handed_over');
    expect(t.events.find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({ coherence: { state, reason } });
    expect(await decideAudit(t.turn.id)).toMatchObject({ coherence: { state, reason } });
  });

  it('the unclear line is locked: a verdict that drops it is ignored', async () => {
    await fresh({ kind: 'review', decision: reviewOps({ drop: [1] }) });
    const conv = await customer(w, central, nextPhone(), 'when are you open, and can you do a pirate show?');
    w.fake.push({
      kind: 'decision',
      decision: decision({
        intent: 'hours',
        intents: ['hours', 'custom_request'],
        grounding: ['hours-note'],
        reason: 'FACT_IN_KB',
        bubbles: ['We are open every day from 10:00 to 20:00 😊'],
      }),
    });
    await tick(w, later(25_000));
    const lines = await aiLines(w, conv.id);
    expect(lines.map((l) => l.body)).toEqual(['We are open every day from 10:00 to 20:00 😊', INBOX_TEMPLATE_BODIES.closing_unclear]);
    expect(reviewer.requests[0]!.items.map((i) => i.locked)).toEqual([false, true]);
    expect((await eventsOf(w, conv.id)).find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({
      coherence: { state: 'ignored', reason: 'LOCKED_DROP' },
    });
  });

  it('a composition that changed between the review and the commit goes unreviewed', async () => {
    const [row] = await w.ctx.db
      .select()
      .from(s.template)
      .where(and(eq(s.template.operatorId, w.oto), eq(s.template.key, 'closing_booking'), eq(s.template.language, 'en'), isNull(s.template.branchId)));
    const edited = `${row!.body} See you soon!`;
    await fresh({
      kind: 'review',
      decision: reviewOps({ drop: [1] }),
      // While the reviewer reads, an admin rewords the closing line.
      during: async () => {
        await w.ctx.db.update(s.template).set({ body: edited }).where(eq(s.template.id, row!.id));
      },
    });
    try {
      const t = await nannyTurn([FACTS, GOODBYE]);
      expect(t.lines.map((l) => l.body)).toEqual([FACTS, GOODBYE, edited]);
      expect(t.events.find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({ coherence: { state: 'stale', reason: 'CHANGED' } });
    } finally {
      await w.ctx.db.update(s.template).set({ body: row!.body }).where(eq(s.template.id, row!.id));
    }
  });
});

describe('only a mixed send is reviewed', () => {
  it('the model’s bubbles alone make no reviewer call', async () => {
    await fresh();
    const conv = await customer(w, central, nextPhone(), 'when are you open?');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'hours', grounding: ['hours-note'], reason: 'FACT_IN_KB', bubbles: ['Every day 10:00 to 20:00 😊', 'See you soon!'] }) });
    expect((await tick(w, later(25_000))).answered).toBe(1);
    expect(reviewer.requests).toHaveLength(0);
    expect((await eventsOf(w, conv.id)).find((e) => e.kind === 'ai_replied')!.payload).toMatchObject({ coherence: { state: 'skipped', reason: 'NOT_MIXED' } });
  });

  it('a fixed line alone — the only line, load-bearing — makes no reviewer call', async () => {
    await fresh();
    const conv = await customer(w, central, nextPhone(), 'I want to speak to a person');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'human_requested', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect(reviewer.requests).toHaveLength(0);
    // The thread keeps its category, so the branch's own line goes, alone.
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_branch]);
    expect((await eventsOf(w, conv.id)).find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({ coherence: { state: 'skipped', reason: 'NOT_MIXED' } });
  });

  it('a silent turn writes no review record at all', async () => {
    await fresh();
    const conv = await customer(w, central, nextPhone(), 'buy cheap followers now');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'other', action: 'silent', reason: 'OUT_OF_SCOPE', bubbles: [] }) });
    await tick(w, later(25_000));
    expect(reviewer.requests).toHaveLength(0);
    const [turn] = await turnsOf(w, conv.id);
    expect(await decideAudit(turn!.id)).toMatchObject({ coherence: null });
  });

  it('with no reviewer configured the reply goes as composed, and the turn says so', async () => {
    await fresh();
    w.ctx.app.inboxAi.reviewer = null;
    try {
      const t = await nannyTurn([FACTS, GOODBYE]);
      expect(t.lines.map((l) => l.body)).toEqual([FACTS, GOODBYE, BOOKING_LINE]);
      expect(t.events.find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({ coherence: { state: 'skipped', reason: 'NO_REVIEWER' } });
    } finally {
      w.ctx.app.inboxAi.reviewer = reviewer;
    }
  });
});

describe('the kill switch: the live-tunable setting', () => {
  const settings = () => w.ctx.app.inject({ method: 'GET', url: '/assistant-settings', headers: { cookie: adminCookie } });
  const save = (inbox: Record<string, unknown>, expectedRevision: number) =>
    w.ctx.app.inject({
      method: 'PUT',
      url: '/assistant-settings',
      headers: { cookie: adminCookie, 'idempotency-key': newId() },
      payload: { expectedRevision, schemaVersion: 1, overrides: { internal: {}, inbox }, rates: [] },
    });

  it('defaults on; switched off it is honoured on the very next turn; back on, the review returns', async () => {
    const before = await settings();
    expect(before.statusCode).toBe(200);
    expect(before.json().effective.inbox.coherenceReview).toBe(true);
    const off = await save({ coherenceReview: false }, before.json().revision);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ overrides: { inbox: { coherenceReview: false } }, effective: { inbox: { coherenceReview: false } } });
    // Revision-checked: a stale revision cannot flip it back.
    expect((await save({}, before.json().revision)).statusCode).toBe(409);
    // Audited like every other setting.
    const [audit] = await w.ctx.db
      .select({ after: s.auditLog.after })
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'assistant_settings.update'), eq(s.auditLog.operatorId, w.oto)))
      .orderBy(sql`${s.auditLog.createdAt} desc`)
      .limit(1);
    expect(audit!.after).toMatchObject({ overrides: { inbox: { coherenceReview: false } } });

    await fresh({ kind: 'review', decision: reviewOps({ drop: [1] }) });
    const t = await nannyTurn([FACTS, GOODBYE]);
    expect(reviewer.requests).toHaveLength(0);
    expect(t.lines.map((l) => l.body)).toEqual([FACTS, GOODBYE, BOOKING_LINE]);
    expect(t.events.find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({ coherence: { state: 'skipped', reason: 'SWITCHED_OFF' } });

    const on = await save({}, off.json().revision);
    expect(on.json().effective.inbox.coherenceReview).toBe(true);
    const again = await nannyTurn([FACTS, GOODBYE]);
    expect(reviewer.requests).toHaveLength(1);
    expect(again.lines.map((l) => l.body)).toEqual([FACTS, BOOKING_LINE]);
  });

  it('refuses a value that is not a boolean', async () => {
    const current = (await settings()).json();
    expect((await save({ coherenceReview: 'off' }, current.revision)).statusCode).toBe(400);
    expect((await save({ coherenceReview: 0 }, current.revision)).statusCode).toBe(400);
  });
});
