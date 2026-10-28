import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GateVerdict, TurnContext } from '@oto/assistant';
import { schema as s } from '@oto/db';
import { DEFAULT_SILENT_INTENTS, INBOX_TEMPLATE_BODIES, defaultSilencePolicyFor, syncInboxSetup } from '@oto/db/seed';
import { isUnanswered, newId, satangFromBaht as b } from '@oto/shared';
import { CLOSING_KEY_OF, PLAYBOOK_ROUTE, silencedBy, silentIntentsOf } from '../src/services/inbox/ai-destination';
import { knowledgeWithTierPrices, loadTurnKnowledge, packageFact, priceFactText, type PricedPackageRow } from '../src/services/inbox/ai-knowledge';
import { callingCodeOf } from '../src/services/inbox/calling-code';
import { teardownAll } from './helpers';
import {
  SENTINEL,
  activeSlots,
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
 * SCRUM-220, THE PLAYBOOK IN THE TURN ENGINE (lane pb-engine). Tom's Inbox
 * Bot Playbook (28 Oct 2026) is the first rule for the customer assistant;
 * these are its engine-side rules, against a real embedded database and the
 * `FakeAssistantClient`:
 *
 *   - THE GM QUEUE: complaints (a checked apology first), refunds,
 *     collaborations, jobs and photography go to the GM team, not Marketing;
 *     an unclear message stays with the thread's park when it has one and
 *     goes to the GM when it has none.
 *   - DESTINATION-KEYED CLOSING LINES: the line names where the thread goes
 *     (the birthday manager, the general manager, the branch), falling back
 *     to the team-neutral general line when the destination's line is missing.
 *   - BIRTHDAYS (owner D1): the open and one combined question first; the
 *     birthday manager's line once the basics are in.
 *   - THE NANNY goes to Central Floresta's reception (`plan.branch`), the
 *     only park with the service.
 *   - THE NUMBER'S SILENCE POLICY: on the intents a number's policy names, the
 *     hand-over is silent — the thread routes, the assistant stops, and
 *     nothing goes, its answer included; a silent hand-over the policy does
 *     not cover sends the branch line.
 *   - THE ONE LANGUAGE OFFER reaches the gate with the caller's country code,
 *     and is made once per episode.
 *   - TIER PRICE FACTS: every tier the active packages carry, `expat` said as
 *     "resident", a "starts from" per tier, a weekend gap said as such — in a
 *     fact block that stays small.
 *   - THE CALLER'S COUNTRY CODE reaches the turn's context.
 *   - SPAM TIDY: spam the model read leaves the Unanswered queue, handled by
 *     the assistant, and the turn says why.
 *   - PLATFORM-SYNC lays the default policy on branch numbers only, and never
 *     over a policy an operator saved.
 *
 * FICTIONAL TEST DATA throughout.
 */

/**
 * The prompt's input and the gate's verdict, observed: `buildPrompt` is the
 * real one, recorded; `applyGates` is the real one, and a test may reshape
 * its verdict (to drive a `silent_handover` the gate only emits for drop-off
 * care and lost items through a plan it would not give one).
 */
const seen = vi.hoisted(() => ({
  contexts: [] as unknown[],
  reshape: null as null | ((v: unknown) => unknown),
}));
vi.mock('@oto/assistant', async (importOriginal) => {
  const real = await importOriginal<typeof import('@oto/assistant')>();
  return {
    ...real,
    buildPrompt: (input: Parameters<typeof real.buildPrompt>[0]) => {
      seen.contexts.push(input.context);
      return real.buildPrompt(input);
    },
    applyGates: (input: Parameters<typeof real.applyGates>[0]) => {
      const verdict = real.applyGates(input);
      return (seen.reshape ? seen.reshape(verdict) : verdict) as ReturnType<typeof real.applyGates>;
    },
  };
});

let w: AiWorld;
let central: string; // a Central number, live, no policy
let wide: string; // an operator-wide number, live
let approver: string;

beforeAll(async () => {
  w = await aiWorld();
  central = await simAccount(w, { branchId: w.central });
  wide = await simAccount(w, { branchId: null });
  const receptionCentral = await teamOf(w, 'reception', w.central);
  [approver] = await staff(w, '+66810009201', 'Playbook Test Approver', 'inbox_agent', {
    scopeType: 'department',
    scopeId: receptionCentral.departmentId!,
  });
  await kb(w, approver, {
    key: 'socks',
    topic: 'socks',
    language: 'en',
    question: 'Do we need socks?',
    body: 'Yes, everyone on the play floor wears grip socks. You can buy them at reception.',
  });
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

/** Settle every turn due now, so a test starts from a quiet queue. */
async function drain(): Promise<void> {
  await w.ctx.db
    .update(s.aiTurn)
    .set({ state: 'cancelled', reason: 'TEST_DRAIN', leaseUntil: null })
    .where(sql`state in ('pending','deciding')`);
}

async function templateRow(key: typeof s.template.$inferSelect.key, language: 'en' | 'th' | 'ru') {
  const [row] = await w.ctx.db
    .select()
    .from(s.template)
    .where(
      and(
        eq(s.template.operatorId, w.oto),
        eq(s.template.key, key),
        eq(s.template.language, language),
        isNull(s.template.channel),
        isNull(s.template.branchId),
        isNull(s.template.archivedAt),
      ),
    )
    .limit(1);
  return row!;
}

/** The playbook's unclear line, word for word (owner ruling, 28 Oct): it wins over the destination's line. */
const UNCLEAR_LINE = 'Thanks for your message! A team member will be with you shortly.';

async function handoverEvent(conversationId: string) {
  return (await eventsOf(w, conversationId)).find((e) => e.kind === 'ai_handover');
}

describe('the GM queue (playbook routing)', () => {
  it('the playbook moves the online complaint and the influencer to GM; unclear splits by the park', () => {
    expect(PLAYBOOK_ROUTE).toEqual({ complaint_online: 'gm', influencer_marketing: 'gm', emotional_or_unclear: 'branch_or_gm' });
    expect(CLOSING_KEY_OF).toEqual({
      birthdays: 'closing_birthday',
      gm: 'closing_gm',
      general: 'closing_branch',
      marketing: null,
    });
  });

  it('an online complaint goes to the GM team, with the general manager’s closing line verbatim', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), `your page is full of lies ${SENTINEL}`);
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'complaint_online', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);

    const gm = await teamOf(w, 'gm');
    const after = await conversationRow(w, conv.id);
    expect(after).toMatchObject({ category: 'gm', teamId: gm.id });
    const closing = await templateRow('closing_gm', 'en');
    expect(closing.body).toBe(INBOX_TEMPLATE_BODIES.closing_gm);
    const lines = await aiLines(w, conv.id);
    expect(lines.map((l) => ({ body: l.body, templateId: l.templateId }))).toEqual([{ body: closing.body, templateId: closing.id }]);
    // The plan carries the GM's line since the playbook (`GM_PLAN`), and the line sent is the destination's.
    expect((await handoverEvent(conv.id))!.payload).toMatchObject({
      intent: 'complaint_online',
      templateKey: 'closing_gm',
      destination: 'gm',
      closingKey: 'closing_gm',
      holdingLine: 'template',
      silent: false,
      reroutedTeamId: gm.id,
    });
    expect((await activeSlots(w, conv.id)).every((a) => a.assignedByKind === 'ai')).toBe(true);
  });

  it('a complaint: one sincere apology, then the general manager’s line; an apology that admits fault is dropped', async () => {
    await drain();
    const gm = await teamOf(w, 'gm');
    const apology = `I'm so sorry to hear about your visit ${SENTINEL}.`;
    const conv = await customer(w, central, nextPhone(), `my son got sick after your food ${SENTINEL}`);
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'complaint_onsite', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [apology] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([apology, INBOX_TEMPLATE_BODIES.closing_gm]);
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'gm', teamId: gm.id });
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', action: 'answer', intent: 'complaint_onsite' });
    expect((await handoverEvent(conv.id))!.payload).toMatchObject({ destination: 'gm', closingKey: 'closing_gm', silent: false });

    // Never admits fault: the apology is dropped, the GM's line goes alone.
    const fault = await customer(w, central, nextPhone(), 'the slide was broken and my kid got hurt');
    w.fake.push({
      kind: 'decision',
      decision: decision({ intent: 'complaint_onsite', action: 'handover', reason: 'NEEDS_PERSON', bubbles: ["We're so sorry, that was our fault."] }),
    });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((await aiLines(w, fault.id)).map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_gm]);
    expect(await conversationRow(w, fault.id)).toMatchObject({ category: 'gm', teamId: gm.id });
  });

  it('an influencer goes to the GM team, not Marketing', async () => {
    await drain();
    const conv = await customer(w, wide, nextPhone(), 'collab? I have 80k followers');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'influencer_marketing', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    const gm = await teamOf(w, 'gm');
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'gm', teamId: gm.id });
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_gm]);
  });

  it('an unclear message on a park’s thread stays with that park, with the playbook’s unclear line word for word', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'hmm not sure what to do now');
    const reception = await teamOf(w, 'reception', w.central);
    expect(conv.teamId).toBe(reception.id);
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'emotional_or_unclear', action: 'handover', reason: 'UNCLEAR', bubbles: [] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'general', teamId: reception.id, branchId: w.central });
    const unclear = await templateRow('closing_unclear', 'en');
    expect((await aiLines(w, conv.id)).map((l) => ({ body: l.body, templateId: l.templateId }))).toEqual([
      { body: UNCLEAR_LINE, templateId: unclear.id },
    ]);
    expect((await handoverEvent(conv.id))!.payload).toMatchObject({ destination: 'general', closingKey: 'closing_unclear', reroutedTeamId: null });
  });

  it('an unclear message on a thread with no park goes to the GM, with the same unclear line, not the GM’s', async () => {
    await drain();
    const conv = await customer(w, wide, nextPhone(), 'hmm not sure what to do now');
    expect(conv.branchId).toBeNull();
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'emotional_or_unclear', action: 'handover', reason: 'UNCLEAR', bubbles: [] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    const gm = await teamOf(w, 'gm');
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'gm', teamId: gm.id });
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([UNCLEAR_LINE]);
    expect((await handoverEvent(conv.id))!.payload).toMatchObject({ destination: 'gm', closingKey: 'closing_unclear' });
  });

  it('the unclear line in the customer’s language: Thai and Russian are real translations', async () => {
    for (const language of ['th', 'ru'] as const) {
      await drain();
      const unclear = await templateRow('closing_unclear', language);
      expect(unclear.needsTranslation).toBe(false);
      const conv = await customer(w, central, nextPhone(), language === 'th' ? 'ไม่แน่ใจค่ะ' : 'не знаю, что делать');
      w.fake.push({ kind: 'decision', decision: decision({ language, intent: 'emotional_or_unclear', action: 'handover', reason: 'UNCLEAR', bubbles: [] }) });
      expect((await tick(w, later(25_000))).handedOver, language).toBe(1);
      expect((await aiLines(w, conv.id)).map((l) => ({ body: l.body, templateId: l.templateId })), language).toEqual([
        { body: unclear.body, templateId: unclear.id },
      ]);
    }
  });

  it('with the unclear line inactive, the ladder goes on: the destination’s line', async () => {
    await drain();
    const unclear = await templateRow('closing_unclear', 'en');
    await w.ctx.db.update(s.template).set({ active: false }).where(eq(s.template.id, unclear.id));
    try {
      const conv = await customer(w, central, nextPhone(), 'hmm, no idea');
      w.fake.push({ kind: 'decision', decision: decision({ intent: 'emotional_or_unclear', action: 'handover', reason: 'UNCLEAR', bubbles: [] }) });
      expect((await tick(w, later(25_000))).handedOver).toBe(1);
      expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_branch]);
      expect((await handoverEvent(conv.id))!.payload).toMatchObject({ destination: 'general', closingKey: 'closing_branch', holdingLine: 'template' });
    } finally {
      await w.ctx.db.update(s.template).set({ active: true }).where(eq(s.template.id, unclear.id));
    }
  });

  // The playbook's routing row is "Unclear or not covered": a request the
  // knowledge does not cover, and the model handing over on its own, take the
  // unclear line too, to whichever queue the thread goes.
  for (const c of [
    { name: 'a request the knowledge does not cover', turnReason: 'OK', decide: () => decision({ intent: 'custom_request', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) },
    { name: 'the model handing over on its own', turnReason: 'MODEL_HANDOVER', decide: () => decision({ intent: 'hours', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) },
  ]) {
    it(`${c.name}: the unclear line, word for word, to the park and to the GM`, async () => {
      const gm = await teamOf(w, 'gm');
      const reception = await teamOf(w, 'reception', w.central);
      for (const [number, team, category] of [
        [central, reception, 'general'],
        [wide, gm, 'gm'],
      ] as const) {
        await drain();
        const conv = await customer(w, number, nextPhone(), 'can you host a dog show for us?');
        w.fake.push({ kind: 'decision', decision: c.decide() });
        expect((await tick(w, later(25_000))).handedOver, category).toBe(1);
        expect(await conversationRow(w, conv.id), category).toMatchObject({ category, teamId: team.id });
        expect((await aiLines(w, conv.id)).map((l) => l.body), category).toEqual([UNCLEAR_LINE]);
        expect((await handoverEvent(conv.id))!.payload, category).toMatchObject({ destination: category, closingKey: 'closing_unclear' });
        expect((await turnsOf(w, conv.id))[0], category).toMatchObject({ state: 'handed_over', reason: c.turnReason });
      }
    });
  }

  it('the discount pusher is the deals path, not the unclear row: the destination’s line, to the park and to the GM', async () => {
    const pushes = [
      () => decision({ intent: 'discount_insist', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }),
      // an objection the model hands over: its own fallback, the same deals path
      () => decision({ intent: 'discount_negotiation', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }),
    ];
    for (const push of pushes) {
      for (const [number, line] of [
        [central, INBOX_TEMPLATE_BODIES.closing_branch],
        [wide, INBOX_TEMPLATE_BODIES.closing_gm],
      ] as const) {
        await drain();
        const conv = await customer(w, number, nextPhone(), 'still too expensive, give me a discount');
        w.fake.push({ kind: 'decision', decision: push() });
        expect((await tick(w, later(25_000))).handedOver).toBe(1);
        expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([line]);
      }
    }
  });

  it('a birthday closes with the birthday manager’s line, in the customer’s language, once the basics are in', async () => {
    await drain();
    // The basics all at once (owner D1: the closing line follows the basics).
    const conv = await customer(w, central, nextPhone(), 'อยากจัดวันเกิดให้ลูกค่ะ วันเสาร์หน้า ประมาณ 15 คน ที่สาขาเซ็นทรัลค่ะ');
    w.fake.push({
      kind: 'decision',
      decision: decision({ language: 'th', intent: 'birthday_details', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }),
    });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    const birthdays = await teamOf(w, 'birthdays');
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'birthdays', teamId: birthdays.id });
    const closing = await templateRow('closing_birthday', 'th');
    expect(closing.needsTranslation).toBe(false);
    expect((await aiLines(w, conv.id)).map((l) => ({ body: l.body, templateId: l.templateId, bodyLanguage: l.bodyLanguage }))).toEqual([
      { body: closing.body, templateId: closing.id, bodyLanguage: 'th' },
    ]);
  });

  it('every hand-over the intent table routes to gm (jobs, photography, refunds) goes to GM, with a lead line where the playbook gives one', async () => {
    const gm = await teamOf(w, 'gm');
    const cases = [
      { intent: 'job_request', text: 'are you hiring?', bubbles: ["We're always looking for great people!"] },
      { intent: 'photography_question', text: 'can I do a photo shoot at the park?', bubbles: ['Good question!'] },
      { intent: 'refund_request', text: 'I want my money back for yesterday', bubbles: [] },
    ] as const;
    for (const c of cases) {
      await drain();
      const conv = await customer(w, central, nextPhone(), c.text);
      w.fake.push({ kind: 'decision', decision: decision({ intent: c.intent, action: 'handover', reason: 'NEEDS_PERSON', bubbles: [...c.bubbles] }) });
      expect((await tick(w, later(25_000))).handedOver, c.intent).toBe(1);
      expect(await conversationRow(w, conv.id), c.intent).toMatchObject({ category: 'gm', teamId: gm.id });
      expect((await aiLines(w, conv.id)).map((l) => l.body), c.intent).toEqual([...c.bubbles, INBOX_TEMPLATE_BODIES.closing_gm]);
    }
  });

  it('a table route of gm is honoured as is, whatever the intent', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'can I talk to a manager please');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'human_requested', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    seen.reshape = (v) => {
      const verdict = v as GateVerdict;
      return verdict.action === 'handover' ? { ...verdict, plan: { ...verdict.plan, route: 'gm' } } : verdict;
    };
    try {
      expect((await tick(w, later(25_000))).handedOver).toBe(1);
    } finally {
      seen.reshape = null;
    }
    const gm = await teamOf(w, 'gm');
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'gm', teamId: gm.id });
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_gm]);
  });

  it('a missing destination line falls back to the team-neutral general line, never to one that names another team', async () => {
    await drain();
    // Since the playbook a plan carries its destination's line (`GM_PLAN` is
    // `closing_gm`), so with that line gone the next is the plan-neutral
    // `handover_general` — not the old complaint line, which names reception.
    const closing = await templateRow('closing_gm', 'en');
    await w.ctx.db.update(s.template).set({ active: false }).where(eq(s.template.id, closing.id));
    try {
      const conv = await customer(w, central, nextPhone(), 'your instagram ad is misleading');
      w.fake.push({ kind: 'decision', decision: decision({ intent: 'complaint_online', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
      expect((await tick(w, later(25_000))).handedOver).toBe(1);
      const general = await templateRow('handover_general', 'en');
      expect((await aiLines(w, conv.id)).map((l) => ({ body: l.body, templateId: l.templateId }))).toEqual([
        { body: general.body, templateId: general.id },
      ]);
      expect((await handoverEvent(conv.id))!.payload).toMatchObject({ destination: 'gm', closingKey: null, holdingLine: 'template' });
    } finally {
      await w.ctx.db.update(s.template).set({ active: true }).where(eq(s.template.id, closing.id));
    }
  });

  it('a plan’s own template is the first fallback: the brochure request keeps the birthday template’s line', async () => {
    await drain();
    const closing = await templateRow('closing_birthday', 'en');
    await w.ctx.db.update(s.template).set({ active: false }).where(eq(s.template.id, closing.id));
    try {
      const conv = await customer(w, central, nextPhone(), 'can you send me your birthday packages?');
      const bubble = 'Of course! Here they are 🎂';
      w.fake.push({ kind: 'decision', decision: decision({ intent: 'birthday_brochure', sendBrochure: true, reason: 'CLEAR_INTENT', bubbles: [bubble] }) });
      expect((await tick(w, later(25_000))).handedOver).toBe(1);
      const own = await templateRow('handover_birthday', 'en');
      expect((await aiLines(w, conv.id)).filter((l) => l.body !== null).map((l) => l.body)).toEqual([bubble, own.body]);
      expect((await handoverEvent(conv.id))!.payload).toMatchObject({ destination: 'birthdays', templateKey: 'handover_birthday', closingKey: null });
    } finally {
      await w.ctx.db.update(s.template).set({ active: true }).where(eq(s.template.id, closing.id));
    }
  });
});

describe('the nanny (the playbook’s "Ages, nanny and drop-off")', () => {
  const facts = `Our nanny service is one-on-one care at Central Floresta, from 3 years old 😊 ${SENTINEL}`;
  const nanny = () =>
    decision({ intent: 'nanny_booking', grounding: ['nanny'], reason: 'FACT_IN_KB', bubbles: [facts] });

  it('answered from the knowledge, then Central Floresta’s reception takes the booking, whatever number it came in on', async () => {
    await drain();
    const chalongNumber = await simAccount(w, { branchId: w.chalong });
    const conv = await customer(w, chalongNumber, nextPhone(), 'do you have a nanny for my 3 year old?');
    expect(conv.branchId).toBe(w.chalong);
    w.fake.push({ kind: 'decision', decision: nanny() });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([facts, INBOX_TEMPLATE_BODIES.closing_branch]);
    const receptionCentral = await teamOf(w, 'reception', w.central);
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'general', teamId: receptionCentral.id, branchId: w.central });
    expect((await handoverEvent(conv.id))!.payload).toMatchObject({ destination: 'general', closingKey: 'closing_branch', reroutedTeamId: receptionCentral.id });
  });

  it('on Central’s own number, whose policy names the nanny, nothing is said — not even the answer — and the desk has it', async () => {
    await drain();
    const centralNumber = await simAccount(w, { branchId: w.central, silentIntents: [...DEFAULT_SILENT_INTENTS.withNanny] });
    const conv = await customer(w, centralNumber, nextPhone(), `is there a nanny today? ${SENTINEL}`);
    w.fake.push({ kind: 'decision', decision: nanny() });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect(await aiLines(w, conv.id)).toHaveLength(0);
    const receptionCentral = await teamOf(w, 'reception', w.central);
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'general', teamId: receptionCentral.id, branchId: w.central });
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', action: 'answer', reason: 'SILENCE_POLICY', messageIds: [] });
    const events = await eventsOf(w, conv.id);
    expect(events.some((e) => e.kind === 'ai_replied')).toBe(false);
    expect(events.find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({ silent: true, holdingLine: 'none', messageIds: [] });
  });
});

describe('the number’s silence policy', () => {
  it('reads a policy defensively: a list of words, or nothing', () => {
    expect(silentIntentsOf(null)).toBeNull();
    expect(silentIntentsOf({ silentIntents: 'lost_item' })).toBeNull();
    expect(silentIntentsOf({ silentIntents: ['lost_item', 3, 'nanny_booking'] })).toEqual(new Set(['lost_item', 'nanny_booking']));
    // Every hand-over part must be on the list; an answerable part does not count (and says nothing once silenced).
    const policy = new Set(['lost_item', 'nanny_booking']);
    expect(silencedBy(policy, ['lost_item'], 'lost_item', 'lost_item')).toBe(true);
    expect(silencedBy(policy, ['socks', 'lost_item'], 'lost_item', 'socks')).toBe(true);
    expect(silencedBy(policy, ['lost_item', 'complaint_onsite'], 'complaint_onsite', 'lost_item')).toBe(false);
    expect(silencedBy(null, ['lost_item'], 'lost_item', 'lost_item')).toBe(false);
    expect(silencedBy(new Set(), ['lost_item'], 'lost_item', 'lost_item')).toBe(false);
  });

  it('a lost item on a park number whose policy names it: no line, the thread goes to the park, the assistant stops', async () => {
    await drain();
    const policyNumber = await simAccount(w, {
      branchId: w.central,
      defaultCategory: 'marketing',
      silentIntents: [...DEFAULT_SILENT_INTENTS.withNanny],
    });
    const phone = nextPhone();
    const conv = await customer(w, policyNumber, phone, `I left my bag at the park yesterday ${SENTINEL}`);
    const marketing = await teamOf(w, 'marketing');
    expect(conv.teamId).toBe(marketing.id);
    w.fake.push({
      kind: 'decision',
      decision: decision({ intent: 'lost_item', action: 'handover', reason: 'NEEDS_PERSON', bubbles: ['Let me check with the team for you'] }),
    });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);

    const [turn] = await turnsOf(w, conv.id);
    expect(turn).toMatchObject({ state: 'handed_over', action: 'handover', reason: 'SILENCE_POLICY', intent: 'lost_item', messageIds: [] });
    expect(await aiLines(w, conv.id)).toHaveLength(0);
    const reception = await teamOf(w, 'reception', w.central);
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'general', teamId: reception.id, branchId: w.central });
    const events = await eventsOf(w, conv.id);
    expect(events.some((e) => e.kind === 'ai_silent')).toBe(false);
    expect(events.find((e) => e.kind === 'ai_handover')!.payload).toMatchObject({
      silent: true,
      reason: 'SILENCE_POLICY',
      holdingLine: 'none',
      closingKey: null,
      messageIds: [],
      destination: 'general',
      reroutedTeamId: reception.id,
    });
    expect((await activeSlots(w, conv.id)).every((a) => a.assignedByKind === 'ai')).toBe(true);
    // The assistant is done for the episode: the next bubble writes no turn.
    await customer(w, policyNumber, phone, 'hello?');
    expect((await turnsOf(w, conv.id)).filter((t) => t.state === 'pending')).toHaveLength(0);
  });

  it('drop-off care is silent on a Chalong number; nanny there is not on its list, so it gets the branch line', async () => {
    await drain();
    const chalongNumber = await simAccount(w, { branchId: w.chalong, silentIntents: [...DEFAULT_SILENT_INTENTS.withoutNanny] });
    const dropOff = await customer(w, chalongNumber, nextPhone(), 'can I leave my 6 year old with you?');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'drop_off_care', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect(await aiLines(w, dropOff.id)).toHaveLength(0);
    expect((await turnsOf(w, dropOff.id))[0]).toMatchObject({ state: 'handed_over', reason: 'SILENCE_POLICY' });

    const nanny = await customer(w, chalongNumber, nextPhone(), 'do you have a nanny for my 3 year old?');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'nanny_booking', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((await aiLines(w, nanny.id)).map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_branch]);
    expect((await turnsOf(w, nanny.id))[0]).toMatchObject({ state: 'handed_over', reason: 'OK' });
  });

  it('a number with no policy: a lost item, the gate’s silent hand-over, gets the branch closing line', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'I lost my sunglasses');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'lost_item', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_branch]);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', action: 'handover', reason: 'POLICY_MISSING' });
  });

  it('a lost item beside an answerable question on a policy number: nothing is said, whatever else was asked (the playbook)', async () => {
    await drain();
    const policyNumber = await simAccount(w, { branchId: w.central, silentIntents: ['lost_item'] });
    const conv = await customer(w, policyNumber, nextPhone(), 'do we need socks? also I lost my hat');
    const answer = `Yes, everyone on the play floor wears grip socks ${SENTINEL}.`;
    w.fake.push({
      kind: 'decision',
      decision: decision({ intent: 'socks', intents: ['socks', 'lost_item'], grounding: ['socks'], reason: 'MIXED_INTENTS', bubbles: [answer] }),
    });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect(await aiLines(w, conv.id)).toHaveLength(0);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', intent: 'lost_item', reason: 'SILENCE_POLICY' });
    expect((await handoverEvent(conv.id))!.payload).toMatchObject({ silent: true, holdingLine: 'none', intents: ['socks', 'lost_item'] });
  });

  it('a silent hand-over the gate names, with no policy covering it, goes as a normal hand-over with the branch line', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'birthday for 20 kids next month at Central');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'birthday_details', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    seen.reshape = (v) => toSilentHandover(v as GateVerdict);
    try {
      expect((await tick(w, later(25_000))).handedOver).toBe(1);
    } finally {
      seen.reshape = null;
    }
    // The branch line, whatever the destination: not the birthday manager's.
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_branch]);
    const birthdays = await teamOf(w, 'birthdays');
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'birthdays', teamId: birthdays.id });
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', action: 'handover', reason: 'POLICY_MISSING' });
    expect((await handoverEvent(conv.id))!.payload).toMatchObject({ silent: false, closingKey: 'closing_branch', holdingLine: 'template' });
  });

  it('a silent hand-over the gate names, on a number whose policy covers it, is silent', async () => {
    await drain();
    const policyNumber = await simAccount(w, { branchId: w.central, silentIntents: ['lost_item'] });
    const conv = await customer(w, policyNumber, nextPhone(), 'lost my phone in the ball pit');
    // Whatever words the model wrote: the gate's silent hand-over drops them.
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'lost_item', action: 'handover', reason: 'NEEDS_PERSON', bubbles: ['I will check for you'] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect(await aiLines(w, conv.id)).toHaveLength(0);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', action: 'handover', reason: 'SILENCE_POLICY' });
  });

  it('in shadow mode a silenced hand-over keeps no line for staff', async () => {
    await drain();
    const shadowNumber = await simAccount(w, { branchId: w.central, aiMode: 'shadow', silentIntents: ['lost_item'] });
    const conv = await customer(w, shadowNumber, nextPhone(), 'lost my scarf');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'lost_item', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    expect((await tick(w, later(25_000))).shadowed).toBe(1);
    expect(await aiLines(w, conv.id)).toHaveLength(0);
    const shadowPill = (await eventsOf(w, conv.id)).find((e) => e.kind === 'ai_shadow');
    expect(shadowPill!.payload).toMatchObject({ action: 'silent_handover', messageId: null, holdingLine: 'none' });
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'shadowed', reason: 'SILENCE_POLICY' });
  });
});

/** The gate's hand-over, as the silent hand-over the assistant lane will emit for it. */
function toSilentHandover(v: GateVerdict): GateVerdict {
  if (v.action !== 'handover') return v;
  return {
    action: 'silent_handover',
    reason: 'SILENCE_POLICY',
    intent: v.intent,
    intents: v.intents,
    language: v.language,
    plan: v.plan,
    branchNamed: v.branchNamed,
  };
}

// --- Tier price facts --------------------------------------------------------------------------

const ww = (weekday: number, weekend = weekday) => ({ weekday: b(weekday), weekend: b(weekend) });
const parents = (weekday: number, weekend: number) => ({ kind: 'set_price', price: ww(weekday, weekend) });

/** The playbook's Central Floresta table (28 Oct 2026), as catalogue rows. */
const PLAYBOOK_CENTRAL: PricedPackageRow[] = [
  {
    name: '1 Hour Play',
    hours: 1,
    prices: { tourist: ww(690), expat: ww(483, 552), thai: ww(420, 520) },
    adultRules: { tourist: parents(350, 500), expat: parents(350, 500), thai: { kind: 'free_adults', freeAdults: 1, overflow: 'set_price', price: ww(350, 500) } },
  },
  {
    name: '2 Hours Play',
    hours: 2,
    prices: { tourist: ww(890), expat: ww(623, 712), thai: ww(520, 620) },
    adultRules: { tourist: parents(350, 500), expat: parents(350, 500), thai: { kind: 'free_adults', freeAdults: 1, overflow: 'set_price', price: ww(350, 500) } },
  },
  {
    name: 'Full Day Pass',
    hours: 8,
    prices: { tourist: ww(1090), expat: ww(763, 872), thai: ww(620, 720) },
    adultRules: { tourist: parents(350, 500), expat: parents(350, 500), thai: { kind: 'free_adults', freeAdults: 1, overflow: 'set_price', price: ww(350, 500) } },
  },
  {
    name: 'Food & Play',
    hours: 8,
    prices: { tourist: ww(1300), expat: ww(1300), thai: ww(1300) },
    adultRules: { tourist: parents(350, 350), expat: parents(350, 350), thai: parents(350, 350) },
  },
];

/** The playbook's Robinson Chalong table: no resident tier, and no 1-hour ticket at weekends. */
const PLAYBOOK_CHALONG: PricedPackageRow[] = [
  { name: '1 Hour Play', hours: 1, prices: { tourist: ww(300, 0), thai: ww(150, 0) }, adultRules: { tourist: parents(270, 432), thai: parents(135, 216) } },
  { name: '2 Hours Play', hours: 2, prices: { tourist: ww(400, 450), thai: ww(200, 225) }, adultRules: { tourist: parents(270, 432), thai: parents(135, 216) } },
  { name: 'Full Day Pass', hours: 8, prices: { tourist: ww(550), thai: ww(275) }, adultRules: { tourist: parents(270, 432), thai: parents(135, 216) } },
];

describe('tier price facts (the playbook’s pricing flow)', () => {
  it('every tier on the packages, expat said as resident, a starts-from per tier, the adult rule', () => {
    const text = priceFactText('Central Floresta', PLAYBOOK_CENTRAL);
    expect(text).toContain('Tourist: 1 Hour Play ฿690 every day');
    // SCRUM-670 (A): the resident line says "discount" itself, so a reply citing the park's price fact grounds the word.
    expect(text).toContain('Resident (discount with ID): 1 Hour Play ฿483 weekday, ฿552 weekend');
    expect(text).toContain('Thai: 1 Hour Play ฿420 weekday, ฿520 weekend');
    expect(text).not.toMatch(/expat/i);
    expect(text).toContain('Tourist starts from ฿690 (1 Hour Play)');
    expect(text).toContain('Resident starts from ฿483 (1 Hour Play, weekday)');
    expect(text).toContain('Thai starts from ฿420 (1 Hour Play, weekday)');
    expect(text).toContain('Tourist adults: ฿350 weekday, ฿500 weekend (Food & Play ฿350 every day)');
    expect(text).toContain('Thai adults: first adult free, then ฿350 weekday, ฿500 weekend (Food & Play ฿350 every day)');
    // Tourist first, then resident, then Thai.
    expect(text.indexOf('Tourist:')).toBeLessThan(text.indexOf('Resident (discount with ID):'));
    expect(text.indexOf('Resident (discount with ID):')).toBeLessThan(text.indexOf('Thai:'));
    // "free" is already there, through the Thai tier's free adult.
    expect(text).toMatch(/\bfree\b/);
  });

  it('a package with no weekend price is said to be not available on weekends', () => {
    const text = priceFactText('Robinson Chalong', PLAYBOOK_CHALONG);
    expect(text).toContain('Tourist: 1 Hour Play ฿300 weekday, not available on weekends');
    expect(text).toContain('Thai: 1 Hour Play ฿150 weekday, not available on weekends');
    expect(text).toContain('Tourist starts from ฿300 (1 Hour Play, weekday)');
    expect(text).toContain('Thai starts from ฿150 (1 Hour Play, weekday)');
    expect(text).not.toContain('Resident');
  });

  it('no priced package says so, as the standard line did', () => {
    expect(priceFactText('Robinson Chalong', [])).toBe('Robinson Chalong ticket prices: not set (do not state prices)');
  });

  it('a package fact carries its other tiers for the prompt type', () => {
    const fact = packageFact({ name: '1 Hour Play', prices: PLAYBOOK_CENTRAL[0]!.prices, adultRules: PLAYBOOK_CENTRAL[0]!.adultRules });
    expect(fact).toMatchObject({ kidWeekday: b(690), kidWeekend: b(690), adultWeekday: b(350), adultWeekend: b(500) });
    expect(fact!.tierPrices).toEqual([
      { tierCode: 'expat', kidWeekday: b(483), kidWeekend: b(552), adultWeekday: b(350), adultWeekend: b(500) },
      { tierCode: 'thai', kidWeekday: b(420), kidWeekend: b(520), adultWeekday: b(350), adultWeekend: b(500) },
    ]);
  });

  it('the two parks’ whole fact block stays under 4,000 characters, cited by the same keys', () => {
    const hours = { open: '10:00', close: '20:00' };
    const week = { mon: hours, tue: hours, wed: hours, thu: hours, fri: hours, sat: hours, sun: hours };
    const block = knowledgeWithTierPrices(
      {
        kb: [],
        examples: [],
        branches: [
          { key: 'central', name: 'Central Floresta', address: '199 Chalermprakiat Ror 9 Rd, Wichit, Phuket 83000', openingHours: week, packages: [] },
          { key: 'chalong', name: 'Robinson Chalong', address: '10/53 Moo 1, Chaofah East Road, Chalong, Phuket 83130', openingHours: week, packages: [] },
        ],
      },
      [
        { key: 'central', name: 'Central Floresta', rows: PLAYBOOK_CENTRAL },
        { key: 'chalong', name: 'Robinson Chalong', rows: PLAYBOOK_CHALONG },
      ],
    );
    const live = block.text.slice(block.text.indexOf('## Live facts'), block.text.indexOf('## Approved answers'));
    expect(live.length).toBeGreaterThan(500);
    expect(live.length).toBeLessThan(4000);
    expect(block.grounding.get('fact.prices.central')).toMatchObject({ topic: 'prices', text: priceFactText('Central Floresta', PLAYBOOK_CENTRAL) });
    expect(block.text).toContain(`[fact.prices.chalong] ${priceFactText('Robinson Chalong', PLAYBOOK_CHALONG)}`);
    expect(block.text).not.toContain('standard ticket prices');
    expect(block.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it('the live knowledge reads every tier from the catalogue, and the model is given it', async () => {
    const known = await loadTurnKnowledge(w.ctx.db, w.oto, new Date());
    const centralPrices = known.knowledge.grounding.get('fact.prices.central')!.text;
    expect(centralPrices).toContain('Resident (discount with ID):');
    expect(centralPrices).toContain('Thai:');
    expect(centralPrices).toContain('starts from');
    const live = known.knowledge.text.slice(known.knowledge.text.indexOf('## Live facts'), known.knowledge.text.indexOf('## Approved answers'));
    expect(live.length).toBeLessThan(4000);

    await drain();
    await customer(w, central, nextPhone(), 'how much for one kid?');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'other', action: 'silent', reason: 'OUT_OF_SCOPE', bubbles: [], language: 'other' }) });
    await tick(w, later(25_000));
    const prompt = w.fake.requests.at(-1)!.prompt;
    expect(prompt.system[1].text).toContain(`[fact.prices.central] ${centralPrices}`);
  });
});

// --- The caller's country code -----------------------------------------------------------------

describe('the caller’s country code', () => {
  it('reads the calling code off an E.164 phone', () => {
    expect(callingCodeOf('+66812345678')).toBe('66');
    expect(callingCodeOf('+79161234567')).toBe('7');
    expect(callingCodeOf('+12025550123')).toBe('1');
    expect(callingCodeOf('+447911123456')).toBe('44');
    expect(callingCodeOf('+85512345678')).toBe('855');
    expect(callingCodeOf('+380441234567')).toBe('380');
    expect(callingCodeOf(null)).toBeNull();
    expect(callingCodeOf('0812345678')).toBeNull();
    expect(callingCodeOf('ig-scoped-id')).toBeNull();
  });

  it('a turn’s context carries the contact’s calling code: Thai, then Russian', async () => {
    await drain();
    seen.contexts.length = 0;
    await customer(w, central, nextPhone(), 'hello');
    w.fake.push({ kind: 'decision', decision: decision() });
    await tick(w, later(25_000));
    expect((seen.contexts.at(-1) as TurnContext).contactCountryCode).toBe('66');

    await drain();
    await customer(w, central, '79161230001', 'здравствуйте');
    w.fake.push({ kind: 'decision', decision: decision({ language: 'ru', bubbles: ['Здравствуйте! Чем можем помочь?'] }) });
    await tick(w, later(25_000));
    expect((seen.contexts.at(-1) as TurnContext).contactCountryCode).toBe('7');
  });

  it('the gate reads it too: a +7 number writing in English is made the one Russian offer once, and a second is refused', async () => {
    await drain();
    seen.contexts.length = 0;
    const phone = '79161230002';
    const offer = 'Hi there! Would you like to continue in English or Russian?';
    const conv = await customer(w, central, phone, 'hi');
    w.fake.push({ kind: 'decision', decision: decision({ bubbles: [offer] }) });
    expect((await tick(w, later(25_000))).answered).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([offer]);
    expect((await eventsOf(w, conv.id)).find((e) => e.kind === 'ai_replied')!.payload).toMatchObject({ languageOffer: 'ru' });

    // The same episode: the offer was made, so the model is told and the gate refuses another —
    // and since item D a withheld reply on a main channel is the unclear line, never dead air.
    await customer(w, central, phone, 'hello again');
    w.fake.push({ kind: 'decision', decision: decision({ bubbles: [offer] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((seen.contexts.at(-1) as TurnContext).earlier.languageOffered).toBe(true);
    expect((await turnsOf(w, conv.id))[1]).toMatchObject({ state: 'handed_over', reason: 'GUARD_LANGUAGE' });
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([offer, UNCLEAR_LINE]);
  });

  it('a +66 number is never made the Russian offer', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'hi');
    w.fake.push({ kind: 'decision', decision: decision({ bubbles: ['Hi there! Would you like to continue in English or Russian?'] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', reason: 'GUARD_LANGUAGE' });
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([UNCLEAR_LINE]);
  });
});

// --- Spam tidy ---------------------------------------------------------------------------------

describe('spam tidy', () => {
  const spam = () => decision({ intent: 'other', action: 'silent', reason: 'OUT_OF_SCOPE', bubbles: [] });

  it('spam the model read leaves the Unanswered queue, handled by the assistant, and the turn says why', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), `cheap followers, click here ${SENTINEL}`);
    expect(isUnanswered(await conversationRow(w, conv.id))).toBe(true);
    w.fake.push({ kind: 'decision', decision: spam() });
    expect((await tick(w, later(25_000))).silent).toBe(1);
    const after = await conversationRow(w, conv.id);
    expect(after).toMatchObject({ status: 'handled', handledByKind: 'ai', handledByAccountId: null });
    expect(isUnanswered(after)).toBe(false);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'silent', reason: 'SPAM_TIDIED', intent: 'other' });
    const events = await eventsOf(w, conv.id);
    expect(events.find((e) => e.kind === 'handled')).toMatchObject({ actorKind: 'ai', payload: { handledByKind: 'ai', reason: 'SPAM' } });
    expect(events.find((e) => e.kind === 'ai_silent')!.payload).toMatchObject({ reason: 'SPAM_TIDIED' });
    // Still readable: the customer's line is there, untouched.
    const inbound = await w.ctx.db.select().from(s.message).where(and(eq(s.message.conversationId, conv.id), eq(s.message.direction, 'inbound')));
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.body).toContain('cheap followers');
    expect(await aiLines(w, conv.id)).toHaveLength(0);
  });

  it('a message in a language the model could not read is not tidied: a person reads it', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), '你好，请问营业时间？');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'other', action: 'silent', reason: 'LANGUAGE_UNSUPPORTED', bubbles: [], language: 'other' }) });
    expect((await tick(w, later(25_000))).silent).toBe(1);
    expect((await conversationRow(w, conv.id)).status).toBe('active');
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'silent', reason: 'INTENT_SILENT' });
  });

  it('spam after a question the assistant left to a person is not tidied: the question still waits', async () => {
    await drain();
    const phone = nextPhone();
    const conv = await customer(w, central, phone, 'can I bring my own cake?');
    // The model left the question to a person (its own silence: since item D an
    // UNSURE model on a main channel sends the unclear line and hands over instead).
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'faq', action: 'silent', certainty: 'unsure', reason: 'UNCLEAR', bubbles: [] }) });
    expect((await tick(w, later(25_000))).silent).toBe(1);
    await customer(w, central, phone, 'buy crypto now');
    w.fake.push({ kind: 'decision', decision: spam() });
    expect((await tick(w, later(25_000))).silent).toBe(1);
    expect((await conversationRow(w, conv.id)).status).toBe('active');
    const turns = await turnsOf(w, conv.id);
    expect(turns.map((t) => t.reason)).toEqual(['MODEL_SILENT', 'INTENT_SILENT']);
  });
});

// --- The guarded-reply fallback (SCRUM-671, item D) -------------------------------------------

describe('a reply the gate withholds is never dead air on a main channel (owner ruling, item D)', () => {
  // A socks answer with a price no source holds: the number guard withholds it.
  const tripped = () =>
    decision({ intent: 'socks', grounding: ['socks'], reason: 'FACT_IN_KB', bubbles: [`Grip socks are 79 baht at reception ${SENTINEL}`] });

  it('on a park number with no policy: the unclear line goes, the park keeps the thread, the turn names the guard', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'do we need socks and how much are they?');
    w.fake.push({ kind: 'decision', decision: tripped() });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([UNCLEAR_LINE]);
    const reception = await teamOf(w, 'reception', w.central);
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'general', teamId: reception.id });
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', reason: 'GUARD_NUMBER', intent: 'socks' });
    expect((await handoverEvent(conv.id))!.payload).toMatchObject({ reason: 'GUARD_NUMBER', closingKey: 'closing_unclear', silent: false });
    // Nothing of the withheld words reached the thread.
    expect((await aiLines(w, conv.id)).some((l) => (l.body ?? '').includes('79'))).toBe(false);
  });

  it('on a main number with no park: the unclear line goes and the GM queue has it', async () => {
    await drain();
    const conv = await customer(w, wide, nextPhone(), 'do we need socks and how much are they?');
    w.fake.push({ kind: 'decision', decision: tripped() });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([UNCLEAR_LINE]);
    const gm = await teamOf(w, 'gm');
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'gm', teamId: gm.id });
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', reason: 'GUARD_NUMBER' });
  });

  it('on a branch number whose silence policy covers the intent: true silence, as before', async () => {
    await drain();
    const policyNumber = await simAccount(w, { branchId: w.central, silentIntents: ['socks'] });
    const conv = await customer(w, policyNumber, nextPhone(), 'do we need socks and how much are they?');
    w.fake.push({ kind: 'decision', decision: tripped() });
    expect((await tick(w, later(25_000))).silent).toBe(1);
    expect(await aiLines(w, conv.id)).toHaveLength(0);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'silent', reason: 'GUARD_NUMBER' });
    expect((await eventsOf(w, conv.id)).some((e) => e.kind === 'ai_handover')).toBe(false);
  });

  it('a park mismatch (SCRUM-669) on a main number: the unclear line, the guard named on the turn', async () => {
    await drain();
    const conv = await customer(w, wide, nextPhone(), 'how much at Chalong?');
    w.fake.push({
      kind: 'decision',
      decision: decision({
        intent: 'ticket_prices',
        branchNamed: 'chalong',
        grounding: ['fact.prices.central'],
        reason: 'FACT_IN_KB',
        bubbles: ['Prices start from ฿690 per child 😊'],
      }),
    });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([UNCLEAR_LINE]);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', reason: 'GUARD_PARK' });
    expect((await aiLines(w, conv.id)).some((l) => (l.body ?? '').includes('690'))).toBe(false);
  });

  it('the model choosing silence, or spam, is not a withheld reply: no line', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'buy followers cheap');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'other', action: 'silent', reason: 'OUT_OF_SCOPE', bubbles: [] }) });
    expect((await tick(w, later(25_000))).silent).toBe(1);
    expect(await aiLines(w, conv.id)).toHaveLength(0);
  });

  it('an unsure model: the customer asked and gets the unclear line — the park when it is known, else the GM', async () => {
    const unsure = () => decision({ intent: 'faq', certainty: 'unsure', reason: 'UNCLEAR', bubbles: ['Maybe, I think so'] });
    const gm = await teamOf(w, 'gm');
    const reception = await teamOf(w, 'reception', w.central);
    for (const [number, team, category] of [
      [central, reception, 'general'],
      [wide, gm, 'gm'],
    ] as const) {
      await drain();
      const conv = await customer(w, number, nextPhone(), 'can I bring my own cake?');
      w.fake.push({ kind: 'decision', decision: unsure() });
      expect((await tick(w, later(25_000))).handedOver, category).toBe(1);
      expect((await aiLines(w, conv.id)).map((l) => l.body), category).toEqual([UNCLEAR_LINE]);
      expect(await conversationRow(w, conv.id), category).toMatchObject({ category, teamId: team.id });
      expect((await turnsOf(w, conv.id))[0], category).toMatchObject({ state: 'handed_over', reason: 'UNSURE' });
      expect((await handoverEvent(conv.id))!.payload, category).toMatchObject({ reason: 'UNSURE', closingKey: 'closing_unclear' });
    }
  });

  it('a message that needs no reply ("thanks, bye"): the model chooses silence and the customer gets nothing', async () => {
    await drain();
    const conv = await customer(w, wide, nextPhone(), 'thanks, bye');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'thanks_closing', action: 'silent', reason: 'CLOSING', bubbles: [] }) });
    expect((await tick(w, later(25_000))).silent).toBe(1);
    expect(await aiLines(w, conv.id)).toHaveLength(0);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'silent', reason: 'MODEL_SILENT' });
  });
});

// --- Staging-shaped knowledge: English rows flagged for translation (SCRUM-670, SCRUM-671 E) -----

describe('the playbook entries as staging holds them: English, flagged for their translations', () => {
  beforeAll(async () => {
    await kb(w, approver, {
      key: 'pb.ages',
      topic: 'age_rules',
      language: 'en',
      needsTranslation: true,
      question: 'Is there an age limit?',
      body: 'Our play park is for children up to 12 years old. Children under 1 get free entry with a paying adult. The nanny service (one-on-one, from age 3) is 330 baht per hour, and drop-off (from age 5) is 225 baht per visit, both at Central Floresta.',
    });
    await kb(w, approver, {
      key: 'pb.deal-dinner-promo',
      topic: 'prices_note',
      language: 'en',
      needsTranslation: true,
      question: 'Is there an evening deal at Chalong?',
      body: 'The Dinner Promo at Robinson Chalong applies after 6pm. Weekdays: 1,080 baht, all of it food and drink credit, plus free entry for 3 people.',
    });
  });

  it('E: "is there any age limit" on a main channel is ANSWERED from the cited entry, "free entry" and all', async () => {
    await drain();
    const conv = await customer(w, wide, nextPhone(), 'is there any age limit');
    const answer = `Our park is for kids up to 12 years old, and little ones under 1 get free entry 😊 ${SENTINEL}`;
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'age_rules', grounding: ['pb.ages'], reason: 'FACT_IN_KB', bubbles: [answer] }) });
    expect((await tick(w, later(25_000))).answered).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([answer]);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'answered', reason: 'OK', intent: 'age_rules' });
    // The entry reached the model's knowledge, citable by its key.
    const prompt = w.fake.requests.at(-1)!.prompt;
    expect(prompt.system[1].text).toContain('[pb.ages] (age_rules, en)');
  });

  it('SCRUM-670: "too expensive" at Chalong is answered with the Dinner Promo, not handed over', async () => {
    await drain();
    const chalongNumber = await simAccount(w, { branchId: w.chalong });
    const conv = await customer(w, chalongNumber, nextPhone(), 'that is too expensive');
    const deal = 'Everything inside is included 😊 And at Robinson Chalong the Dinner Promo after 6pm is ฿1,080 on weekdays, plus free entry for 3 people.';
    w.fake.push({
      kind: 'decision',
      decision: decision({ intent: 'discount_negotiation', grounding: ['pb.deal-dinner-promo'], reason: 'FACT_IN_KB', bubbles: [deal] }),
    });
    expect((await tick(w, later(25_000))).answered).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([deal]);
    expect((await eventsOf(w, conv.id)).some((e) => e.kind === 'ai_handover')).toBe(false);
  });
});

// --- Platform-sync: the default policies (LAST: it writes to every number in this database) -----

describe('platform-sync lays the default silence policy', () => {
  it('Central with nanny, Chalong without; nothing on a number with no park', () => {
    expect(defaultSilencePolicyFor('hkt-central')).toEqual({ silentIntents: ['drop_off_care', 'nanny_booking', 'lost_item'] });
    expect(defaultSilencePolicyFor('robinson-chalong')).toEqual({ silentIntents: ['drop_off_care', 'lost_item'] });
  });

  it('on park numbers only, insert-if-absent: a saved policy, even an empty one, is never overwritten', async () => {
    const make = async (branchId: string | null, policy: { silentIntents: string[] } | null) => {
      const id = newId();
      await w.ctx.db.insert(s.channelAccount).values({
        id,
        operatorId: w.oto,
        branchId,
        channel: 'whatsapp',
        provider: 'simulator',
        externalId: `pb-policy-${id}`,
        displayName: 'Playbook policy test',
        defaultCategory: 'general',
        canReply: true,
        status: 'active',
        silencePolicy: policy,
      });
      return id;
    };
    const centralNumber = await make(w.central, null);
    const chalongNumber = await make(w.chalong, null);
    const mainNumber = await make(null, null);
    const savedEmpty = await make(w.central, { silentIntents: [] });
    const savedOwn = await make(w.chalong, { silentIntents: ['nanny_booking'] });

    const first = await syncInboxSetup(w.ctx.db);
    expect(first.silencePolicies).toBeGreaterThanOrEqual(2);
    const policyOf = async (id: string) =>
      (await w.ctx.db.select({ p: s.channelAccount.silencePolicy }).from(s.channelAccount).where(eq(s.channelAccount.id, id)))[0]!.p;
    expect(await policyOf(centralNumber)).toEqual({ silentIntents: ['drop_off_care', 'nanny_booking', 'lost_item'] });
    expect(await policyOf(chalongNumber)).toEqual({ silentIntents: ['drop_off_care', 'lost_item'] });
    expect(await policyOf(mainNumber)).toBeNull();
    expect(await policyOf(savedEmpty)).toEqual({ silentIntents: [] });
    expect(await policyOf(savedOwn)).toEqual({ silentIntents: ['nanny_booking'] });
    // The console's notice numbers have no park and keep no policy.
    const consoles = await w.ctx.db.select({ p: s.channelAccount.silencePolicy }).from(s.channelAccount).where(eq(s.channelAccount.provider, 'console'));
    expect(consoles.length).toBeGreaterThan(0);
    expect(consoles.every((c) => c.p === null)).toBe(true);

    const second = await syncInboxSetup(w.ctx.db);
    expect(second.silencePolicies).toBe(0);
  });
});
