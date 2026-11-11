import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AiDecision } from '@oto/assistant';
import { schema as s } from '@oto/db';
import { isHeldInGeneral, newId } from '@oto/shared';
import { DEFAULT_LOCAL_TOPICS, INBOX_LOCAL_TOPICS_KEY, readLocalTopics } from '../src/services/inbox/placement';
import { teardownAll } from './helpers';
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
  simAccount,
  staff,
  teamOf,
  tick,
  turnsOf,
  type AiWorld,
} from './inbox-ai-support';

/**
 * SCRUM-789 — GENERAL QUESTIONS STAY OUT OF THE PARK INBOXES; A PARK INBOX
 * HOLDS ONLY WHAT ITS LOCAL TEAM MUST HANDLE (`services/inbox/placement.ts`).
 *
 * One real embedded database, the simulator channel and the fake model, as
 * every assistant suite: the real model is never called. FICTIONAL TEST DATA.
 *
 *   - a price, hours, directions or age question on a park's own number is
 *     held in the General inbox: no team, nobody seated, the park still on it;
 *     it is under All and General and in NO park view;
 *   - a nanny, a drop-off, a child in our care, lost property, something that
 *     happened on a visit and a booking the staff must change are seated at
 *     the park's reception, with the routing pills;
 *   - a general thread that turns local moves to the park;
 *   - nothing is stranded: wherever the assistant does not answer, the thread
 *     is seated as every general conversation was before;
 *   - the first message's own queue (SCRUM-830) is unchanged.
 */

let w: AiWorld;
let central: string; // Central's own number, live, no policy
let chalong: string; // Chalong's own number, live
let wide: string; // an operator-wide number, live
let owner: string; // an operator-wide reader's cookie
let ownerId: string;
let deskCentral: string; // Central reception's cookie (department grant)
let approver: string;

beforeAll(async () => {
  w = await aiWorld();
  central = await simAccount(w, { branchId: w.central });
  chalong = await simAccount(w, { branchId: w.chalong });
  wide = await simAccount(w, { branchId: null });
  const receptionCentral = await teamOf(w, 'reception', w.central);
  [ownerId, owner] = await staff(w, '+66810009711', 'General Test Owner', 'inbox_manager', { scopeType: 'operator', scopeId: w.oto });
  [approver, deskCentral] = await staff(w, '+66810009712', 'General Test Desk', 'inbox_agent', {
    scopeType: 'department',
    scopeId: receptionCentral.departmentId!,
  });
  await kb(w, approver, {
    key: 'g789.hours',
    topic: 'hours_note',
    language: 'en',
    question: 'When are you open?',
    body: 'We are open every day from ten in the morning until eight in the evening.',
  });
  await kb(w, approver, {
    key: 'g789.directions',
    topic: 'directions',
    language: 'en',
    question: 'How do we get there?',
    body: 'We are on the second floor of the mall, next to the food court. Parking is free in the mall car park.',
  });
  await kb(w, approver, {
    key: 'g789.ages',
    topic: 'age_rules',
    language: 'en',
    question: 'Is there an age limit?',
    body: 'Our play park is for children up to twelve years old.',
  });
  await kb(w, approver, {
    key: 'g789.dropoff',
    topic: 'faq',
    language: 'en',
    question: 'Do you have drop-off?',
    body: 'Drop-off is supervised play for children from five years old. Please ask reception on the day.',
  });
  await kb(w, approver, {
    key: 'g789.socks',
    topic: 'socks',
    language: 'en',
    question: 'Do we need socks?',
    body: 'Yes, everyone on the play floor wears grip socks.',
  });
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

// Every test starts from a quiet queue: a turn an earlier test left pending is settled.
beforeEach(async () => {
  await w.ctx.db
    .update(s.aiTurn)
    .set({ state: 'cancelled', reason: 'TEST_DRAIN', leaseUntil: null })
    .where(sql`state in ('pending','deciding')`);
});

interface Row {
  id: string;
  teamId: string | null;
  category: string;
  branchId: string | null;
}

/** Every page of a list, as this viewer sees it. */
async function listIds(cookie: string, query: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await call<{ conversations: Row[]; nextCursor: string | null }>(
      w,
      cookie,
      'GET',
      `/inbox/conversations?tab=team&limit=100${query ? `&${query}` : ''}${cursor ? `&cursor=${cursor}` : ''}`,
    );
    expect(res.status).toBe(200);
    ids.push(...res.body.conversations.map((c) => c.id));
    cursor = res.body.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

/** Where a conversation shows for the operator-wide reader. */
async function shownIn(id: string) {
  return {
    all: (await listIds(owner, '')).includes(id),
    general: (await listIds(owner, 'inbox=general')).includes(id),
    central: (await listIds(owner, `branchId=${w.central}`)).includes(id),
    chalong: (await listIds(owner, `branchId=${w.chalong}`)).includes(id),
  };
}

const answer = (over: Partial<AiDecision>): AiDecision =>
  decision({ reason: 'FACT_IN_KB', bubbles: [`Happy to help ${SENTINEL}`], ...over });

/** The assistant's one turn on the thread, with this decision. */
async function turn(d: AiDecision) {
  w.fake.push({ kind: 'decision', decision: d });
  return tick(w, later(25_000));
}

async function routedPills(conversationId: string) {
  return (await eventsOf(w, conversationId)).filter((e) => e.kind === 'routed').map((e) => e.payload as Record<string, unknown>);
}

describe('a general question is held in the General inbox, in no park inbox', () => {
  const cases: Array<{ name: string; text: string; d: Partial<AiDecision> }> = [
    { name: 'opening hours', text: 'what time do you open?', d: { intent: 'hours', grounding: ['g789.hours'] } },
    { name: 'how to get there and parking', text: 'how do we get there, is there parking?', d: { intent: 'directions_parking', grounding: ['g789.directions'] } },
    { name: 'age rules', text: 'is there any age limit', d: { intent: 'age_rules', grounding: ['g789.ages'] } },
  ];
  for (const c of cases) {
    it(`${c.name} on Central's own number: held, the park still on it, under All and General only`, async () => {
      const conv = await customer(w, central, nextPhone(), c.text);
      // Held at ingest: no team, nobody seated, the number's park kept (prices differ by park).
      expect(conv).toMatchObject({ category: 'general', teamId: null, branchId: w.central });
      expect(conv.lastRoutedAt).not.toBeNull();
      expect(isHeldInGeneral(conv)).toBe(true);
      expect(await activeSlots(w, conv.id)).toHaveLength(0);
      expect(await routedPills(conv.id)).toEqual([expect.objectContaining({ held: 'general', teamId: null, branchId: w.central, source: 'default' })]);

      expect((await turn(answer(c.d))).answered).toBe(1);
      expect(await aiLines(w, conv.id)).toHaveLength(1);
      // Answered, and still held: the assistant's answer seats nobody.
      const after = await conversationRow(w, conv.id);
      expect(after).toMatchObject({ category: 'general', teamId: null, branchId: w.central, intent: c.d.intent });
      expect(await activeSlots(w, conv.id)).toHaveLength(0);
      expect(await shownIn(conv.id)).toEqual({ all: true, general: true, central: false, chalong: false });
      // The park's desk does not have it on its list.
      expect(await listIds(deskCentral, '')).not.toContain(conv.id);
    });
  }

  it('a price question on a park’s own number: held, and the assistant is still given that park’s own prices', async () => {
    const conv = await customer(w, central, nextPhone(), 'how much is a ticket for one kid?');
    expect(conv).toMatchObject({ teamId: null, branchId: w.central });
    // The model's reply is not the point here (a price needs the live fact's key): what it was GIVEN is.
    await turn(decision({ intent: 'other', action: 'silent', reason: 'OUT_OF_SCOPE', bubbles: [], language: 'other' }));
    const prompt = w.fake.requests.at(-1)!.prompt;
    expect(prompt.system[1].text).toContain('[fact.prices.central]');
  });

  it('on a number with no park: held with no branch, and in no park view (it used to show in every one)', async () => {
    const conv = await customer(w, wide, nextPhone(), 'do we need socks?');
    expect(conv).toMatchObject({ category: 'general', teamId: null, branchId: null });
    expect((await turn(answer({ intent: 'socks', grounding: ['g789.socks'] }))).answered).toBe(1);
    expect(await shownIn(conv.id)).toEqual({ all: true, general: true, central: false, chalong: false });
  });

  it('the park the customer names is kept for the answer, and still seats nobody', async () => {
    const conv = await customer(w, wide, nextPhone(), 'what time do you open at Chalong?');
    expect(conv).toMatchObject({ teamId: null, branchId: null });
    expect((await turn(answer({ intent: 'hours', grounding: ['g789.hours'], branchNamed: 'chalong' }))).answered).toBe(1);
    const after = await conversationRow(w, conv.id);
    expect(after).toMatchObject({ category: 'general', teamId: null, branchId: w.chalong });
    expect((await eventsOf(w, conv.id)).some((e) => e.kind === 'branch_set')).toBe(true);
    expect((await eventsOf(w, conv.id)).some((e) => e.kind === 'moved_team')).toBe(false);
    expect(await shownIn(conv.id)).toEqual({ all: true, general: true, central: false, chalong: false });
  });
});

describe('what the local team must handle is seated at that park', () => {
  it('lost property on Central’s number: Central reception has it, with the pills; the park view shows it', async () => {
    const conv = await customer(w, central, nextPhone(), `I left my bag at the park yesterday ${SENTINEL}`);
    expect(conv.teamId).toBeNull();
    expect((await turn(decision({ intent: 'lost_item', action: 'handover', reason: 'NEEDS_PERSON', bubbles: ['Let me check with the team'] }))).handedOver).toBe(1);
    const reception = await teamOf(w, 'reception', w.central);
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'general', teamId: reception.id, branchId: w.central });
    const slots = await activeSlots(w, conv.id);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0]).toMatchObject({ slot: 'primary' });
    const events = await eventsOf(w, conv.id);
    expect(events.find((e) => e.kind === 'moved_team')!.payload).toMatchObject({ fromGeneral: true, fromTeamId: null, toTeamId: reception.id, byAi: true });
    expect(events.filter((e) => e.kind === 'routed')).toHaveLength(2);
    expect(events.find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({ destination: 'general', reroutedTeamId: reception.id });
    expect(await shownIn(conv.id)).toEqual({ all: true, general: false, central: true, chalong: false });
    // The park's desk sees it now, unanswered.
    expect(await listIds(deskCentral, 'unanswered=true')).toContain(conv.id);
  });

  it('a child in our care on Chalong’s number: Chalong reception', async () => {
    const conv = await customer(w, chalong, nextPhone(), 'my son is in your drop-off now, can I speak to the nanny?');
    expect((await turn(decision({ intent: 'drop_off_care', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }))).handedOver).toBe(1);
    const reception = await teamOf(w, 'reception', w.chalong);
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'general', teamId: reception.id, branchId: w.chalong });
    expect(await shownIn(conv.id)).toEqual({ all: true, general: false, central: false, chalong: true });
  });

  it('a nanny booking asked on Chalong’s number: Central reception, the only park with the service', async () => {
    const conv = await customer(w, chalong, nextPhone(), 'can I book a nanny for Saturday?');
    expect((await turn(decision({ intent: 'nanny_booking', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }))).handedOver).toBe(1);
    const reception = await teamOf(w, 'reception', w.central);
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'general', teamId: reception.id, branchId: w.central });
    expect(await shownIn(conv.id)).toMatchObject({ general: false, central: true, chalong: false });
  });

  it('a drop-off question is the park’s own topic: answered, and seated at the park all the same', async () => {
    const conv = await customer(w, central, nextPhone(), 'do you have drop-off for a six year old?');
    expect(conv.teamId).toBeNull();
    expect((await turn(answer({ intent: 'drop_off_service', grounding: ['g789.dropoff'] }))).answered).toBe(1);
    expect(await aiLines(w, conv.id)).toHaveLength(1);
    const reception = await teamOf(w, 'reception', w.central);
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'general', teamId: reception.id, branchId: w.central });
    // No hand-over was said: the assistant answered, and the desk has the thread.
    expect((await eventsOf(w, conv.id)).some((e) => e.kind === 'ai_handover')).toBe(false);
    expect(await shownIn(conv.id)).toEqual({ all: true, general: false, central: true, chalong: false });
  });

  it('something that happened on a visit (unclear, not a complaint): the park’s desk, with the unclear line', async () => {
    const conv = await customer(w, chalong, nextPhone(), 'my daughter was upset after her visit today and I do not know what happened');
    expect((await turn(decision({ intent: 'emotional_or_unclear', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }))).handedOver).toBe(1);
    const reception = await teamOf(w, 'reception', w.chalong);
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'general', teamId: reception.id, branchId: w.chalong });
    expect(await shownIn(conv.id)).toMatchObject({ general: false, chalong: true });
  });

  it('a booking the staff must change (a request the knowledge does not cover; a customer asking for a person): the park’s desk', async () => {
    const custom = await customer(w, central, nextPhone(), 'I booked tickets for Sunday at Central, can you move them to Monday?');
    expect((await turn(decision({ intent: 'custom_request', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }))).handedOver).toBe(1);
    const reception = await teamOf(w, 'reception', w.central);
    expect(await conversationRow(w, custom.id)).toMatchObject({ category: 'general', teamId: reception.id });

    const human = await customer(w, central, nextPhone(), 'can I talk to a person please');
    expect((await turn(decision({ intent: 'human_requested', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }))).handedOver).toBe(1);
    expect(await conversationRow(w, human.id)).toMatchObject({ category: 'general', teamId: reception.id, branchId: w.central });
    expect(await shownIn(human.id)).toMatchObject({ general: false, central: true });
  });

  it('local work on a number with no park: the first reception team takes it, as a branchless general thread always did', async () => {
    const conv = await customer(w, wide, nextPhone(), `I lost my phone at your park ${SENTINEL}`);
    expect(conv).toMatchObject({ teamId: null, branchId: null });
    expect((await turn(decision({ intent: 'lost_item', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }))).handedOver).toBe(1);
    const after = await conversationRow(w, conv.id);
    expect(after.teamId).not.toBeNull();
    const [seated] = await w.ctx.db.select().from(s.team).where(eq(s.team.id, after.teamId!)).limit(1);
    expect(seated!.key).toBe('reception');
    // No park was claimed for it.
    expect(after.branchId).toBeNull();
    expect((await activeSlots(w, conv.id)).length).toBeGreaterThan(0);
  });

  it('the simulator’s hint of a local topic seats the thread at once', async () => {
    const conv = await customer(w, central, nextPhone(), 'hello', { hint: { category: 'general', intent: 'lost_item' } });
    const reception = await teamOf(w, 'reception', w.central);
    expect(conv).toMatchObject({ category: 'general', teamId: reception.id });
    expect((await routedPills(conv.id))[0]).not.toHaveProperty('held');
  });
});

describe('a general conversation that turns into a local matter moves to the park inbox', () => {
  it('hours first (held), then lost property: moved to Central reception with the routing pills', async () => {
    const phone = nextPhone();
    const conv = await customer(w, central, phone, 'what time do you open?');
    expect((await turn(answer({ intent: 'hours', grounding: ['g789.hours'] }))).answered).toBe(1);
    expect(await shownIn(conv.id)).toEqual({ all: true, general: true, central: false, chalong: false });

    await customer(w, central, phone, `also I think I left my bag there yesterday ${SENTINEL}`);
    expect((await turn(decision({ intent: 'lost_item', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }))).handedOver).toBe(1);
    const reception = await teamOf(w, 'reception', w.central);
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'general', teamId: reception.id, branchId: w.central });
    const kinds = (await eventsOf(w, conv.id)).map((e) => e.kind);
    expect(kinds).toContain('moved_team');
    expect(kinds.filter((k) => k === 'routed')).toHaveLength(2);
    expect(kinds).toContain('assigned');
    expect(await shownIn(conv.id)).toEqual({ all: true, general: false, central: true, chalong: false });
  });

  it('a person moves a held conversation to a park by hand, as before', async () => {
    const conv = await customer(w, central, nextPhone(), 'is there any age limit');
    expect(conv.teamId).toBeNull();
    const res = await call(w, owner, 'POST', `/inbox/conversations/${conv.id}/move`, { dest: { kind: 'reception', branchId: w.chalong } });
    expect(res.status).toBe(200);
    const reception = await teamOf(w, 'reception', w.chalong);
    expect(await conversationRow(w, conv.id)).toMatchObject({ teamId: reception.id, branchId: w.chalong });
    expect(await shownIn(conv.id)).toMatchObject({ general: false, chalong: true, central: false });
  });
});

describe('never stranded: where the assistant does not answer, the park has the thread, as before', () => {
  it('a number in shadow mode: seated at the park on the first message', async () => {
    const shadow = await simAccount(w, { branchId: w.central, aiMode: 'shadow' });
    const conv = await customer(w, shadow, nextPhone(), 'what time do you open?');
    const reception = await teamOf(w, 'reception', w.central);
    expect(conv).toMatchObject({ category: 'general', teamId: reception.id });
    expect((await routedPills(conv.id))[0]).not.toHaveProperty('held');
  });

  it('a number with the assistant off, and a park that is closed: seated at the park on the first message', async () => {
    const off = await simAccount(w, { branchId: w.chalong, aiMode: 'off' });
    const closed = await simAccount(w, { branchId: w.chalong, openingHours: closedNowHours() });
    const reception = await teamOf(w, 'reception', w.chalong);
    expect(await customer(w, off, nextPhone(), 'how much is it?')).toMatchObject({ teamId: reception.id });
    expect(await customer(w, closed, nextPhone(), 'how much is it?')).toMatchObject({ teamId: reception.id });
  });

  it('a turn that fails says nothing: the held thread is seated at its park, the pill says why', async () => {
    const conv = await customer(w, central, nextPhone(), 'what time do you open?');
    expect(conv.teamId).toBeNull();
    w.fake.push({ kind: 'throw', error: new Error('provider down') });
    await tick(w, later(25_000));
    const [t] = await turnsOf(w, conv.id);
    expect(t!.state).toBe('silent');
    const reception = await teamOf(w, 'reception', w.central);
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'general', teamId: reception.id, branchId: w.central });
    expect((await routedPills(conv.id)).at(-1)).toMatchObject({ teamId: reception.id, placed: 'assistant_away' });
    expect((await activeSlots(w, conv.id)).length).toBeGreaterThan(0);
    expect(await listIds(deskCentral, 'unanswered=true')).toContain(conv.id);
    // The route is audited.
    const audits = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.entityId, conv.id), eq(s.auditLog.action, 'inbox.conversation.route')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ placed: 'assistant_away', teamId: reception.id });
  });

  it('a held thread a person paused the assistant on: the customer’s next line seats it at the park', async () => {
    const phone = nextPhone();
    const conv = await customer(w, central, phone, 'what time do you open?');
    expect((await turn(answer({ intent: 'hours', grounding: ['g789.hours'] }))).answered).toBe(1);
    expect((await conversationRow(w, conv.id)).teamId).toBeNull();
    await w.ctx.db.update(s.conversation).set({ aiPausedAt: new Date() }).where(eq(s.conversation.id, conv.id));
    await customer(w, central, phone, 'and on Sunday?');
    const reception = await teamOf(w, 'reception', w.central);
    expect(await conversationRow(w, conv.id)).toMatchObject({ teamId: reception.id });
    expect((await routedPills(conv.id)).at(-1)).toMatchObject({ placed: 'assistant_away' });
  });

  it('a held thread a person in no team took as primary is theirs: nothing is seated over them', async () => {
    const phone = nextPhone();
    const conv = await customer(w, central, phone, 'what time do you open?');
    expect(conv.teamId).toBeNull();
    // As the GM or a coordinator taking it from the General inbox: a person's seat, no team.
    await w.ctx.db.insert(s.assignment).values({
      id: newId(),
      operatorId: w.oto,
      conversationId: conv.id,
      slot: 'primary',
      slotIndex: 0,
      assigneeKind: 'account',
      accountId: ownerId,
      teamId: null,
      assignedByKind: 'account',
      assignedByAccountId: ownerId,
      reason: 'manual',
      assignedAt: new Date(),
    });
    // The assistant stands back (a person assigned): the next line writes no turn, and seats nobody else.
    await customer(w, central, phone, 'and on Sunday?');
    expect(await conversationRow(w, conv.id)).toMatchObject({ teamId: null });
    const slots = await activeSlots(w, conv.id);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ slot: 'primary', accountId: ownerId });
  });

  it('a line that needs no reply ("thanks, bye"): the model chooses silence and the thread stays in General', async () => {
    const phone = nextPhone();
    const conv = await customer(w, central, phone, 'what time do you open?');
    expect((await turn(answer({ intent: 'hours', grounding: ['g789.hours'] }))).answered).toBe(1);
    await customer(w, central, phone, 'thanks, bye');
    expect((await turn(decision({ intent: 'thanks_closing', action: 'silent', reason: 'CLOSING', bubbles: [] }))).silent).toBe(1);
    expect((await turnsOf(w, conv.id)).at(-1)).toMatchObject({ state: 'silent', reason: 'MODEL_SILENT' });
    expect((await conversationRow(w, conv.id)).teamId).toBeNull();
    expect(await shownIn(conv.id)).toEqual({ all: true, general: true, central: false, chalong: false });
  });

  it('spam the assistant tidied stays out of the park inbox', async () => {
    const conv = await customer(w, central, nextPhone(), 'BUY FOLLOWERS CHEAP visit our site');
    expect((await turn(decision({ intent: 'other', action: 'silent', reason: 'OUT_OF_SCOPE', bubbles: [] }))).silent).toBe(1);
    const after = await conversationRow(w, conv.id);
    expect(after).toMatchObject({ status: 'handled', teamId: null });
    expect(await shownIn(conv.id)).toMatchObject({ central: false });
  });
});

describe('the first message’s own queue (SCRUM-830) is unchanged', () => {
  it('a birthday goes to Birthdays & Events and a refund to the GM, from the message, on a park’s own number', async () => {
    const birthday = await customer(w, central, nextPhone(), 'I want to book a birthday party for my daughter');
    const birthdays = await teamOf(w, 'birthdays');
    expect(birthday).toMatchObject({ category: 'birthdays', teamId: birthdays.id });
    expect((await routedPills(birthday.id))[0]).toMatchObject({ source: 'message', cue: 'birthday' });
    expect((await routedPills(birthday.id))[0]).not.toHaveProperty('held');

    const refund = await customer(w, central, nextPhone(), 'I want a refund for yesterday');
    const gm = await teamOf(w, 'gm');
    expect(refund).toMatchObject({ category: 'gm', teamId: gm.id });
    expect((await activeSlots(w, refund.id)).length).toBeGreaterThan(0);
  });

  it('a held general thread the assistant reads as a birthday still moves to Birthdays & Events', async () => {
    const conv = await customer(w, central, nextPhone(), 'hello, a question');
    expect(conv.teamId).toBeNull();
    expect((await turn(decision({ intent: 'birthday_details', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }))).handedOver).toBe(1);
    const birthdays = await teamOf(w, 'birthdays');
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'birthdays', teamId: birthdays.id });
  });
});

describe('the local topics are one list, and the operator can save its own', () => {
  it('the default list is the ticket’s: nanny, drop-off, a child in care, lost property', () => {
    expect([...DEFAULT_LOCAL_TOPICS].sort()).toEqual(['drop_off_care', 'drop_off_service', 'lost_item', 'nanny_booking']);
  });

  it('a saved list is read defensively: intent words only, else the default stands', () => {
    expect(readLocalTopics({ topics: ['socks', 'not_an_intent', 7] })).toEqual(new Set(['socks']));
    expect(readLocalTopics({ topics: [] })).toBeNull();
    expect(readLocalTopics({ topics: 'socks' })).toBeNull();
    expect(readLocalTopics(['socks'])).toBeNull();
    expect(readLocalTopics(null)).toBeNull();
  });

  it('with the operator’s own list saved, its topics seat the thread and the default ones no longer do', async () => {
    await w.ctx.db.insert(s.setting).values({ operatorId: w.oto, key: INBOX_LOCAL_TOPICS_KEY, value: { topics: ['socks'] } });
    try {
      const socks = await customer(w, central, nextPhone(), 'do we need socks?');
      expect((await turn(answer({ intent: 'socks', grounding: ['g789.socks'] }))).answered).toBe(1);
      const reception = await teamOf(w, 'reception', w.central);
      expect(await conversationRow(w, socks.id)).toMatchObject({ teamId: reception.id });

      const dropoff = await customer(w, central, nextPhone(), 'do you have drop-off?');
      expect((await turn(answer({ intent: 'drop_off_service', grounding: ['g789.dropoff'] }))).answered).toBe(1);
      expect((await conversationRow(w, dropoff.id)).teamId).toBeNull();
    } finally {
      await w.ctx.db.delete(s.setting).where(and(eq(s.setting.operatorId, w.oto), eq(s.setting.key, INBOX_LOCAL_TOPICS_KEY)));
    }
  });
});

// Kept last: it only reads.
describe('conversations seated before the rule stay where they are', () => {
  it('a general conversation already on a park’s reception team is still in that park’s view', async () => {
    const reception = await teamOf(w, 'reception', w.chalong);
    const [contact] = await w.ctx.db.select().from(s.contact).where(eq(s.contact.operatorId, w.oto)).limit(1);
    const id = newId();
    const fresh = newId();
    await w.ctx.db.insert(s.contact).values({ ...contact!, id: fresh, externalHandle: `+6689${fresh.slice(0, 7).replace(/\D/g, '0')}`, phone: null });
    await w.ctx.db.insert(s.conversation).values({
      id,
      operatorId: w.oto,
      contactId: fresh,
      channelAccountId: chalong,
      teamId: reception.id,
      branchId: w.chalong,
      category: 'general',
      status: 'active',
      lastRoutedAt: new Date(),
    });
    expect(await shownIn(id)).toEqual({ all: true, general: false, central: false, chalong: true });
  });
});
