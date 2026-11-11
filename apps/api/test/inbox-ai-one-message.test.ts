import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EN_PERSONA, FakeCoherenceReviewer, PART_JOIN, REVIEW_VERSION, TH_PERSONA, reviewOps, type AiDecision, type FakeReviewScriptEntry } from '@oto/assistant';
import { INBOX_TEMPLATE_BODIES } from '@oto/db/seed';
import { schema as s } from '@oto/db';
import { teardownAll } from './helpers';
import {
  ON_DEFAULT_QUEUE,
  SENTINEL,
  aiLines,
  aiWorld,
  conversationRow,
  customer,
  decision,
  eventsOf,
  kb,
  nextPhone,
  simAccount,
  staff,
  teamOf,
  tick,
  turnsOf,
  type AiWorld,
} from './inbox-ai-support';

/**
 * SCRUM-832 — ONE MESSAGE PER TURN, PARK FIRST, through the real turn engine
 * (owner, 10 Nov 2026, APPROVED). The owner's case on staging: in a general
 * thread with no park, "How to find you guys?" got both parks' locations and
 * then "which park?" in a second bubble; "Central" got the walking directions,
 * the AI set the thread's park, and a second bubble said the location again
 * and added the parking.
 *
 *   - "How to find you guys?" with no park: ONE line, the park question, and
 *     the memory's open question (slot park) on that line;
 *   - "Central": read as the answer, the thread's park set, and ONE line with
 *     the directions and the parking — the reply the owner saved through
 *     "Correct the assistant" (10 Nov 2026), word for word;
 *   - the same when the model leaves the park unnamed: the memory's answer
 *     sets it;
 *   - once the park is known, a sentence already sent is not sent again;
 *   - a thread whose first line names the park is answered at once, in one
 *     line.
 *
 * FICTIONAL TEST DATA (the knowledge mirrors staging's playbook entries); the
 * fake model only, never the real one.
 */

/** The owner's saved reply ("Correct the assistant", staging, 10 Nov 2026, customer text "Central"). */
const OWNER_SAVED_REPLY =
  "Easy! We're on the basement floor of Central Floresta, opposite the aquarium. It's the side with the luxury brands, not Festival. Please follow the signs for the Aquarium or Oto. Parking is free by the way.";
const CENTRAL_PARTS = [
  "Easy! We're on the basement floor of Central Floresta, opposite the aquarium. It's the side with the luxury brands, not Festival.",
  'Please follow the signs for the Aquarium or Oto. Parking is free by the way.',
];
const BOTH_PARKS = [
  "Hi! We've got two parks in Phuket 😊 One is at Central Floresta on the basement floor, opposite the aquarium, and the other is at Robinson Chalong on the 3rd floor, opposite the cinema.",
  EN_PERSONA.branchQuestion,
];

let w: AiWorld;
let wide: string; // an operator-wide general number: a thread with no park
let central: string; // Central Floresta's own number: the thread has its park

beforeAll(async () => {
  w = await aiWorld();
  // Due at once: each tick decides the burst just written.
  w.ctx.app.inboxAi.config.debounceMs = 0;
  wide = await simAccount(w, { branchId: null });
  central = await simAccount(w, { branchId: w.central });
  const reception = await teamOf(w, 'reception', w.central);
  const [approver] = await staff(w, '+66810083201', 'One Message Test Approver', 'inbox_agent', {
    scopeType: 'department',
    scopeId: reception.departmentId!,
  });
  const entry = (key: string, topic: 'address_note' | 'directions' | 'parking' | 'hours_note', question: string, body: string) =>
    kb(w, approver, { key, topic, language: 'en', question, body });
  await entry('pb.address-central', 'address_note', 'Where is Central Floresta?', 'We are at Central Floresta (the side of Central with the luxury brands, not Festival), on the basement floor, opposite the aquarium.');
  await entry('pb.address-chalong', 'address_note', 'Where is Robinson Chalong?', 'We are in Robinson Chalong on the 3rd floor, opposite the cinema.');
  await entry('pb.directions-central', 'directions', 'How do I find you at Central?', 'From the ground floor with Tops, take the escalator down toward the aquarium and follow the signs for the Aquarium or Oto.');
  await entry('pb.directions-chalong', 'directions', 'How do I find you at Chalong?', 'Take the escalator up, then the second escalator by the food court to the 3rd floor, opposite the cinema.');
  await entry('pb.parking', 'parking', 'Is there parking?', 'Parking is free at both malls.');
  await entry('pb.hours', 'hours_note', 'When are you open?', 'Both branches are open 10:00 to 20:00, 7 days a week.');
  await kb(w, approver, { key: 'pb.socks', topic: 'socks', language: 'en', question: 'Do we need socks?', body: 'Grip socks are required on the play floor; you can buy them at reception.' });
  await kb(w, approver, {
    key: 'nanny',
    topic: 'faq',
    language: 'en',
    question: 'Do you have a nanny service?',
    body: 'Our nanny service is one-on-one care at Central Floresta for children from 3 years old. Please book ahead.',
  });
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

async function drain(): Promise<void> {
  await w.ctx.db
    .update(s.aiTurn)
    .set({ state: 'cancelled', reason: 'TEST_DRAIN', leaseUntil: null })
    .where(sql`state in ('pending','deciding')`);
  expect(w.fake.remaining).toBe(0);
}

/** A provider stamps a line in whole seconds: a pause keeps the thread in the order it was written. */
const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1_100));

/** The customer writes after a pause; one tick decides the burst with the scripted decision; the lines are marked sent. */
async function say(phone: string, text: string, d: AiDecision, account = wide, opts: Parameters<typeof customer>[4] = {}) {
  await nextSecond();
  const conv = await customer(w, account, phone, text, opts);
  const before = (await aiLines(w, conv.id)).length;
  w.fake.push({ kind: 'decision', decision: d });
  const sweep = await tick(w, new Date());
  expect(w.fake.remaining).toBe(0);
  const all = await aiLines(w, conv.id);
  await w.ctx.db
    .update(s.message)
    .set({ providerStatus: 'sent' })
    .where(and(eq(s.message.conversationId, conv.id), eq(s.message.authorKind, 'ai'), eq(s.message.providerStatus, 'queued')));
  return { conv, sweep, lines: all.slice(before) };
}

async function questionsOf(conversationId: string) {
  return w.ctx.db
    .select()
    .from(s.conversationOpenQuestion)
    .where(eq(s.conversationOpenQuestion.conversationId, conversationId))
    .orderBy(asc(s.conversationOpenQuestion.askedAt), asc(s.conversationOpenQuestion.slot));
}

const repliedPayloads = async (conversationId: string) =>
  (await eventsOf(w, conversationId)).filter((e) => e.kind === 'ai_replied').map((e) => e.payload as Record<string, unknown>);

const howToFindYou = (bubbles = BOTH_PARKS) =>
  decision({
    intent: 'directions_parking',
    grounding: ['pb.address-central', 'pb.address-chalong'],
    bubbles,
    askBranch: true,
    askedSlots: ['park'],
    reason: 'FACT_IN_KB',
  });

const centralDirections = (branchNamed: 'central' | null, bubbles = CENTRAL_PARTS) =>
  decision({
    intent: 'directions_parking',
    grounding: ['pb.address-central', 'pb.directions-central', 'pb.parking'],
    bubbles,
    branchNamed,
    reason: 'FACT_IN_KB',
  });

describe('SCRUM-832: the owner’s case through the engine', () => {
  it('"How to find you guys?" → the park question alone; "Central" → the park set and ONE message with the directions and the parking; then nothing said twice', async () => {
    await drain();
    const phone = nextPhone();

    // Turn 1: no park, a park-dependent answer: the park question, alone, recorded for the memory.
    const first = await say(phone, `Hello, how to find you guys? ${SENTINEL}`, howToFindYou());
    expect(first.sweep.answered).toBe(1);
    expect(first.lines.map((l) => l.body)).toEqual([EN_PERSONA.branchQuestion]);
    const convId = first.conv.id;
    expect((await conversationRow(w, convId)).branchId).toBeNull();
    const [asked] = await questionsOf(convId);
    expect(asked).toMatchObject({ slot: 'park', state: 'open', askedMessageId: first.lines[0]!.id });
    expect((await repliedPayloads(convId))[0]).toMatchObject({
      askBranch: true,
      intents: ['directions_parking'],
      composition: { parkFirst: true, bubbles: 2, duplicates: 0, repeats: 0 },
    });

    // Turn 2: "Central" is the answer; the thread's park is set; one message, the saved reply.
    const second = await say(phone, 'Central', centralDirections('central'));
    expect(second.sweep.answered).toBe(1);
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]!.body).toBe(CENTRAL_PARTS.join(PART_JOIN));
    expect(second.lines[0]!.body!.replace(/\s+/gu, ' ')).toBe(OWNER_SAVED_REPLY);
    expect(second.lines[0]!.body!.match(/parking/giu)).toHaveLength(1);
    expect((await conversationRow(w, convId)).branchId).toBe(w.central);
    const events = await eventsOf(w, convId);
    expect(events.find((e) => e.kind === 'branch_set')!.payload).toMatchObject({ toBranchId: w.central, byAi: true });
    const [answered] = await questionsOf(convId);
    expect(answered).toMatchObject({ slot: 'park', state: 'answered', answer: 'central' });
    // The model was told: the park question was asked and answered.
    const prompt = w.fake.requests.at(-1)!.prompt.messages[0].content;
    expect(prompt).toContain('"slot":"park"');
    expect(prompt).toContain('"state":"answered","answer":"central"');
    const [, t2] = await turnsOf(w, convId);
    expect(t2!.messageIds).toEqual([second.lines[0]!.id]);

    // Turn 3: the park is known; a sentence already sent is not sent again.
    const third = await say(
      phone,
      'What time do you close?',
      decision({
        intent: 'hours',
        grounding: ['pb.hours'],
        bubbles: ["We're open every day 10:00 to 20:00 😊", "We're on the basement floor of Central Floresta, opposite the aquarium."],
        reason: 'FACT_IN_KB',
      }),
    );
    expect(third.lines.map((l) => l.body)).toEqual(["We're open every day 10:00 to 20:00 😊"]);
    expect((await repliedPayloads(convId)).at(-1)).toMatchObject({ composition: { parkFirst: false, bubbles: 2, joined: true, repeats: 1 } });

    // Turn 4: the family asks where it is again: the location again, nothing dropped.
    const fourth = await say(
      phone,
      'Sorry, where is Central again?',
      decision({ intent: 'address', grounding: ['pb.address-central'], bubbles: ["We're on the basement floor of Central Floresta, opposite the aquarium. See you soon!"], reason: 'FACT_IN_KB' }),
    );
    expect(fourth.lines.map((l) => l.body)).toEqual(["We're on the basement floor of Central Floresta, opposite the aquarium. See you soon!"]);
    // Every turn of the episode was one message.
    expect((await turnsOf(w, convId)).map((t) => t.messageIds.length)).toEqual([1, 1, 1, 1]);
  }, 60_000);

  it('staging, 11 Nov: the model asks the park alone and cites nothing → the park question, never the GM; "Central" then sets the park and answers in one message', async () => {
    // On staging the bare question was refused as GROUNDING_MISSING and the family went to the GM's queue;
    // the thread's park then could not be set from "Central" (a GM thread).
    await drain();
    const phone = nextPhone();
    const first = await say(
      phone,
      `How to find you guys? ${SENTINEL}`,
      decision({ intent: 'directions_parking', grounding: [], bubbles: ['Which park are you planning to visit, Central Floresta or Robinson Chalong? 😊'], askBranch: true, askedSlots: ['park'], reason: 'FACT_IN_KB' }),
    );
    expect(first.sweep.answered).toBe(1);
    expect(first.lines.map((l) => l.body)).toEqual([EN_PERSONA.branchQuestion]);
    const convId = first.conv.id;
    const row = await conversationRow(w, convId);
    expect(row.branchId).toBeNull();
    expect(row.category).toBe('general');
    expect((await eventsOf(w, convId)).some((e) => e.kind === 'ai_handover')).toBe(false);
    const [asked] = await questionsOf(convId);
    expect(asked).toMatchObject({ slot: 'park', state: 'open', askedMessageId: first.lines[0]!.id });
    expect((await repliedPayloads(convId))[0]).toMatchObject({ askBranch: true, composition: { parkFirst: true, bubbles: 1 } });

    const second = await say(phone, 'Central', centralDirections(null));
    expect(second.lines.map((l) => l.body)).toEqual([CENTRAL_PARTS.join(PART_JOIN)]);
    expect((await conversationRow(w, convId)).branchId).toBe(w.central);
    expect((await eventsOf(w, convId)).find((e) => e.kind === 'branch_set')!.payload).toMatchObject({ toBranchId: w.central, byAi: true });
    expect((await questionsOf(convId))[0]).toMatchObject({ slot: 'park', state: 'answered', answer: 'central' });
  }, 60_000);

  it('"Where are you? And do we need socks?" with no park: every answer goes, a bubble per topic, the model’s own park question recorded', async () => {
    await drain();
    const phone = nextPhone();
    const socks = 'Yes, grip socks are required on the play floor, and you can buy them at reception 😊';
    const t = await say(
      phone,
      'Where are you? And do we need socks?',
      decision({
        intent: 'address',
        intents: ['address', 'socks'],
        grounding: ['pb.address-central', 'pb.address-chalong', 'pb.socks'],
        bubbles: [BOTH_PARKS[0]!, socks, EN_PERSONA.branchQuestion],
        askBranch: true,
        askedSlots: ['park'],
        reason: 'FACT_IN_KB',
      }),
    );
    expect(t.sweep.answered).toBe(1);
    expect(t.lines.map((l) => l.body)).toEqual([BOTH_PARKS[0], socks, EN_PERSONA.branchQuestion]);
    const [asked] = await questionsOf(t.conv.id);
    expect(asked).toMatchObject({ slot: 'park', state: 'open', askedMessageId: t.lines[2]!.id });
    const [replied] = await repliedPayloads(t.conv.id);
    expect(replied).toMatchObject({ intents: ['address', 'socks'], askBranch: true });
    expect(replied!.composition).toBeUndefined();
  }, 60_000);

  it('the model leaves the park unnamed: the family’s answer to the park question still sets it', async () => {
    await drain();
    const phone = nextPhone();
    const first = await say(phone, 'Where are you located?', howToFindYou());
    expect(first.lines.map((l) => l.body)).toEqual([EN_PERSONA.branchQuestion]);
    const second = await say(phone, 'central please', centralDirections(null));
    expect(second.lines.map((l) => l.body)).toEqual([CENTRAL_PARTS.join(PART_JOIN)]);
    expect((await conversationRow(w, first.conv.id)).branchId).toBe(w.central);
    expect((await questionsOf(first.conv.id))[0]).toMatchObject({ slot: 'park', state: 'answered', answer: 'central' });
  }, 60_000);

  it('Thai: the park question in Thai, "เซ็นทรัลค่ะ" read as the answer, one message', async () => {
    await drain();
    const phone = nextPhone();
    const th = ['สวัสดีค่ะ 😊 เรามีสองสาขาค่ะ Central Floresta อยู่ชั้นใต้ดิน และ Robinson Chalong อยู่ชั้น 3 ค่ะ', TH_PERSONA.branchQuestion];
    const first = await say(phone, 'ไปทางไหนคะ หาไม่เจอค่ะ', decision({ ...howToFindYou(th), language: 'th' }));
    expect(first.lines.map((l) => l.body)).toEqual([TH_PERSONA.branchQuestion]);
    expect((await questionsOf(first.conv.id))[0]).toMatchObject({ slot: 'park', state: 'open' });
    const parts = ['ง่ายมากค่ะ! เราอยู่ชั้นใต้ดินของ Central Floresta ตรงข้ามอควาเรียมค่ะ', 'เดินตามป้าย Aquarium หรือ Oto ได้เลยค่ะ จอดรถฟรีด้วยนะคะ'];
    const second = await say(phone, 'เซ็นทรัลค่ะ', decision({ ...centralDirections('central', parts), language: 'th' }));
    expect(second.lines.map((l) => l.body)).toEqual([parts.join(PART_JOIN)]);
    expect((await questionsOf(first.conv.id))[0]).toMatchObject({ slot: 'park', state: 'answered', answer: 'central' });
    expect((await conversationRow(w, first.conv.id)).branchId).toBe(w.central);
  }, 60_000);

  it('SCRUM-823’s opener beside an advice hand-over is the turn’s one message: exactly one line, the opener template', async () => {
    await drain();
    const phone = nextPhone();
    const t = await say(
      phone,
      'We would like to book a birthday party for our son. Which package would you recommend?',
      decision({ intent: 'birthday_advice', intents: ['birthday_advice', 'birthday_party'], action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }),
    );
    expect(t.sweep.handedOver).toBe(1);
    const [row] = await w.ctx.db
      .select()
      .from(s.template)
      .where(
        and(
          eq(s.template.operatorId, w.oto),
          eq(s.template.key, 'opener_birthday_advice'),
          eq(s.template.language, 'en'),
          isNull(s.template.channel),
          isNull(s.template.branchId),
          isNull(s.template.archivedAt),
        ),
      )
      .limit(1);
    expect(row).toBeDefined();
    expect(t.lines.map((l) => ({ body: l.body, templateId: l.templateId }))).toEqual([{ body: row!.body, templateId: row!.id }]);
    expect((await turnsOf(w, t.conv.id)).map((x) => x.messageIds.length)).toEqual([1]);
  }, 60_000);

  it('a thread whose first line names the park is answered at once, in one message', async () => {
    await drain();
    const phone = nextPhone();
    const t = await say(phone, 'Hi! How do we find you at Central Floresta?', centralDirections('central'));
    expect(t.sweep.answered).toBe(1);
    expect(t.lines.map((l) => l.body)).toEqual([CENTRAL_PARTS.join(PART_JOIN)]);
    expect(await questionsOf(t.conv.id)).toEqual([]);
    expect((await conversationRow(w, t.conv.id)).branchId).toBe(w.central);
    expect((await repliedPayloads(t.conv.id))[0]).toMatchObject({ askBranch: false, composition: { parkFirst: false, bubbles: 2 } });
  }, 60_000);
});

/**
 * SCRUM-832 follow-up (from the review): a hand-over with no usable closing
 * template sends the model's checked holding words — and those are ONE
 * message too, the bubbles joined by `PART_JOIN`, as the template path
 * already sends one line.
 */
describe('SCRUM-832 follow-up: a hand-over with no usable template is one message', () => {
  /** Every English row of these keys, switched off for one test and restored after. */
  async function withoutClosingTemplates<T>(keys: readonly string[], run: () => Promise<T>): Promise<T> {
    const rows = await w.ctx.db
      .select({ id: s.template.id })
      .from(s.template)
      .where(and(eq(s.template.operatorId, w.oto), inArray(s.template.key, [...keys] as never[]), eq(s.template.language, 'en'), eq(s.template.active, true)));
    const ids = rows.map((r) => r.id);
    expect(ids.length).toBeGreaterThan(0);
    await w.ctx.db.update(s.template).set({ active: false }).where(inArray(s.template.id, ids));
    try {
      return await run();
    } finally {
      await w.ctx.db.update(s.template).set({ active: true }).where(inArray(s.template.id, ids));
    }
  }

  it('the unclear, the GM and the general lines all switched off: the model’s two holding bubbles go as ONE line, persona-kind', async () => {
    await drain();
    const words = ['Thanks so much for your message.', 'A colleague will be with you shortly to help with this.'];
    await withoutClosingTemplates(['closing_unclear', 'closing_gm', 'handover_general'], async () => {
      const t = await say(
        nextPhone(),
        `I am not sure what I need, can you help? ${SENTINEL}`,
        decision({ intent: 'emotional_or_unclear', action: 'handover', reason: 'UNCLEAR', bubbles: words }),
      );
      expect(t.sweep.handedOver).toBe(1);
      expect(t.lines.map((l) => ({ body: l.body, templateId: l.templateId }))).toEqual([{ body: words.join(PART_JOIN), templateId: null }]);
      const handover = (await eventsOf(w, t.conv.id)).find((e) => e.kind === 'ai_handover')!.payload as Record<string, unknown>;
      expect(handover).toMatchObject({ holdingLine: 'persona', closingKey: null, templateId: null, messageIds: [t.lines[0]!.id] });
      expect((await turnsOf(w, t.conv.id)).map((x) => x.messageIds.length)).toEqual([1]);
    });
  }, 60_000);

  it('with the templates on, the same hand-over sends the template’s one line, as before', async () => {
    await drain();
    const words = ['Thanks so much for your message.', 'A colleague will be with you shortly to help with this.'];
    const t = await say(
      nextPhone(),
      `I am not sure what I need, can you help? ${SENTINEL}`,
      decision({ intent: 'emotional_or_unclear', action: 'handover', reason: 'UNCLEAR', bubbles: words }),
    );
    expect(t.sweep.handedOver).toBe(1);
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]!.templateId).not.toBeNull();
    expect((await eventsOf(w, t.conv.id)).find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({ holdingLine: 'template', closingKey: 'closing_unclear' });
  }, 60_000);
});

/**
 * SCRUM-832 follow-up (from the review): the coherence record's `sent` counts
 * the review items kept, not the messages that went once `oneMessage` joined
 * the answer's parts; the record now says both (`messages`), and rides the
 * ai_replied and ai_handover payloads as before.
 */
describe('SCRUM-832 follow-up: the coherence record counts the messages that went', () => {
  const FACTS = `Our nanny is one-on-one care at Central Floresta, from 3 years old ${SENTINEL}`;
  const MORE = 'Please book ahead so we can have a nanny ready for you.';
  const SOCKS = 'Yes, grip socks are required on the play floor, and you can buy them at reception.';
  const BOOKING_LINE = INBOX_TEMPLATE_BODIES.closing_booking;

  /** A reviewer with its own script for one turn, the runtime's restored after. */
  async function reviewed<T>(script: FakeReviewScriptEntry[], run: (reviewer: FakeCoherenceReviewer) => Promise<T>): Promise<T> {
    const saved = w.ctx.app.inboxAi.reviewer;
    const reviewer = new FakeCoherenceReviewer([...script]);
    w.ctx.app.inboxAi.reviewer = reviewer;
    w.ctx.app.inboxAi.config.reviewTimeoutMs = 2_000;
    try {
      const out = await run(reviewer);
      expect(reviewer.remaining).toBe(0);
      return out;
    } finally {
      w.ctx.app.inboxAi.reviewer = saved;
    }
  }

  const recordsOf = async (conversationId: string) => {
    const events = await eventsOf(w, conversationId);
    const of = (kind: string) => (events.find((e) => e.kind === kind)?.payload as Record<string, unknown> | undefined)?.coherence;
    return { replied: of('ai_replied'), handover: of('ai_handover') };
  };

  it('a joined turn (one topic, two parts, the closing line): 3 items reviewed, 3 kept, 2 messages went', async () => {
    await drain();
    await reviewed([{ kind: 'keep_all' }], async (reviewer) => {
      const t = await say(nextPhone(), `do you have a nanny for my 3 year old? ${SENTINEL}`, decision({ intent: 'nanny_booking', grounding: ['nanny'], reason: 'FACT_IN_KB', bubbles: [FACTS, MORE] }));
      expect(t.sweep.handedOver).toBe(1);
      // The reviewer still read the parts one by one; what went was one message and the closing line.
      expect(reviewer.requests[0]!.items.map((i) => i.text)).toEqual([FACTS, MORE, BOOKING_LINE]);
      expect(t.lines.map((l) => l.body)).toEqual([[FACTS, MORE].join(PART_JOIN), BOOKING_LINE]);
      const record = { state: 'reviewed', version: REVIEW_VERSION, items: 3, sent: 3, messages: 2, merged: 0, dropped: [] };
      const r = await recordsOf(t.conv.id);
      expect(r.replied).toEqual(record);
      expect(r.handover).toEqual(record);
      expect((await turnsOf(w, t.conv.id)).map((x) => x.messageIds.length)).toEqual([2]);
    });
  }, 60_000);

  it('the same joined turn with the closing line dropped: 2 kept, 1 message went', async () => {
    await drain();
    await reviewed([{ kind: 'review', decision: reviewOps({ drop: [2] }) }], async () => {
      const t = await say(nextPhone(), `do you have a nanny for my 3 year old? ${SENTINEL}`, decision({ intent: 'nanny_booking', grounding: ['nanny'], reason: 'FACT_IN_KB', bubbles: [FACTS, MORE] }));
      expect(t.lines.map((l) => l.body)).toEqual([[FACTS, MORE].join(PART_JOIN)]);
      expect((await recordsOf(t.conv.id)).replied).toMatchObject({ items: 3, sent: 2, messages: 1, dropped: [{ index: 2, origin: 'template', key: 'closing_booking' }] });
    });
  }, 60_000);

  it('a multi-topic turn (the nanny and the socks): a bubble per part, so the messages are the items kept', async () => {
    await drain();
    await reviewed([{ kind: 'keep_all' }], async () => {
      const t = await say(
        nextPhone(),
        `do you have a nanny? and do we need socks? ${SENTINEL}`,
        decision({ intent: 'nanny_booking', intents: ['nanny_booking', 'socks'], grounding: ['nanny', 'pb.socks'], reason: 'FACT_IN_KB', bubbles: [FACTS, SOCKS] }),
      );
      expect(t.sweep.handedOver).toBe(1);
      expect(t.lines.map((l) => l.body)).toEqual([FACTS, SOCKS, BOOKING_LINE]);
      expect((await recordsOf(t.conv.id)).replied).toMatchObject({ items: 3, sent: 3, messages: 3, merged: 0, dropped: [] });
    });
  }, 60_000);
});

/**
 * SCRUM-832 follow-up (staging, 10 Nov 2026, the Demo WhatsApp · Central
 * Floresta number): the model's combined birthday question asked "which
 * branch, Central Floresta or Robinson Chalong?" on the park's own number.
 * Through the engine: the question goes without its park clause, the date
 * and the headcount are recorded as asked (SCRUM-831), the park is not.
 */
describe('SCRUM-832 follow-up: the birthday question on a park’s own number', () => {
  const OPEN = "Amazing, thank you! We'd love to organize a party for your son 🎈";
  const ASK = 'What date(s) are you thinking of, roughly how many people, and which branch, Central Floresta or Robinson Chalong?';
  const ASK_PARK_KNOWN = 'What date(s) are you thinking of, and roughly how many people?';
  const opener = () => decision({ intent: 'birthday_party', reason: 'CLEAR_INTENT', bubbles: [OPEN, ASK], askedSlots: ['date', 'guests_count', 'park'] });

  it('on Central’s number: ONE message without "which branch"; the date and the headcount open on it, no park question', async () => {
    await drain();
    const t = await say(nextPhone(), `Hi, we would like a birthday party for our son ${SENTINEL}`, opener(), central);
    expect(t.sweep.answered).toBe(1);
    expect(t.lines.map((l) => l.body)).toEqual([[OPEN, ASK_PARK_KNOWN].join(PART_JOIN)]);
    expect(t.lines[0]!.body).not.toMatch(/which branch|Central Floresta or Robinson Chalong/i);
    const qs = await questionsOf(t.conv.id);
    expect(qs.map((q) => ({ slot: q.slot, state: q.state, askedMessageId: q.askedMessageId }))).toEqual([
      { slot: 'date', state: 'open', askedMessageId: t.lines[0]!.id },
      { slot: 'guests_count', state: 'open', askedMessageId: t.lines[0]!.id },
    ]);
    expect((await repliedPayloads(t.conv.id))[0]).toMatchObject({ askBranch: false, composition: { parkFirst: false, bubbles: 2, joined: true, parkQuestions: 1 } });
    expect((await conversationRow(w, t.conv.id)).branchId).toBe(w.central);
    expect((await turnsOf(w, t.conv.id)).map((x) => x.messageIds.length)).toEqual([1]);
  }, 60_000);

  it('on the number with no park: the whole question, the park among the three questions recorded', async () => {
    await drain();
    const t = await say(nextPhone(), `Hi, we would like a birthday party for our son ${SENTINEL}`, opener());
    expect(t.sweep.answered).toBe(1);
    expect(t.lines.map((l) => l.body)).toEqual([[OPEN, ASK].join(PART_JOIN)]);
    expect((await questionsOf(t.conv.id)).map((q) => q.slot).sort()).toEqual(['date', 'guests_count', 'park']);
    expect((await repliedPayloads(t.conv.id))[0]).toMatchObject({ composition: { parkQuestions: 0 } });
  }, 60_000);

  it('on the number with no park, the model read the park the family named ("coming to Central"): no "which branch" back, the date and the headcount open; the park set on a general thread', async () => {
    await drain();
    const line = `Hi, we're coming to Central for a birthday party for our son ${SENTINEL}`;
    const read = (): AiDecision => ({ ...opener(), branchNamed: 'central' });
    // The first line says "birthday party": the ingest lands the thread on the birthdays queue, whose park is the
    // birthday manager's to set (the assistant sets a park from the model's reading on a general thread only).
    const t = await say(nextPhone(), line, read());
    expect(t.conv.category).toBe('birthdays');
    expect(t.sweep.answered).toBe(1);
    expect(t.lines.map((l) => l.body)).toEqual([[OPEN, ASK_PARK_KNOWN].join(PART_JOIN)]);
    expect(t.lines[0]!.body).not.toMatch(/which branch|Central Floresta or Robinson Chalong/i);
    const qs = await questionsOf(t.conv.id);
    expect(qs.map((q) => ({ slot: q.slot, state: q.state, askedMessageId: q.askedMessageId }))).toEqual([
      { slot: 'date', state: 'open', askedMessageId: t.lines[0]!.id },
      { slot: 'guests_count', state: 'open', askedMessageId: t.lines[0]!.id },
    ]);
    expect((await repliedPayloads(t.conv.id))[0]).toMatchObject({ askBranch: false, composition: { parkFirst: false, bubbles: 2, joined: true, parkQuestions: 1 } });
    expect((await conversationRow(w, t.conv.id)).branchId).toBeNull();
    expect((await turnsOf(w, t.conv.id)).map((x) => x.messageIds.length)).toEqual([1]);

    // The same line kept on the general queue (the simulator's hint): the same message, and the park the model
    // read sets the thread's park, as on any general thread with none — the question asked what was about to be known.
    const g = await say(nextPhone(), line, read(), wide, ON_DEFAULT_QUEUE);
    expect(g.conv.category).toBe('general');
    expect(g.sweep.answered).toBe(1);
    expect(g.lines.map((l) => l.body)).toEqual([[OPEN, ASK_PARK_KNOWN].join(PART_JOIN)]);
    expect((await questionsOf(g.conv.id)).map((q) => q.slot).sort()).toEqual(['date', 'guests_count']);
    expect((await conversationRow(w, g.conv.id)).branchId).toBe(w.central);
    expect((await eventsOf(w, g.conv.id)).find((e) => e.kind === 'branch_set')!.payload).toMatchObject({ toBranchId: w.central, byAi: true });
    expect((await turnsOf(w, g.conv.id)).map((x) => x.messageIds.length)).toEqual([1]);
  }, 90_000);
});
