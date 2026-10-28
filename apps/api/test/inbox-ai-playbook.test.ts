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
 *   - THE GM QUEUE: an online complaint and an influencer go to the GM team,
 *     not Marketing; an unclear message stays with the thread's park when it
 *     has one and goes to the GM when it has none.
 *   - DESTINATION-KEYED CLOSING LINES: the line names where the thread goes
 *     (the birthday manager, the general manager, the branch), falling back
 *     to the intent's own template when the destination's line is missing.
 *   - THE NUMBER'S SILENCE POLICY: on the intents a number's policy names, the
 *     hand-over is silent — the thread routes, the assistant stops, and no line
 *     goes; a silent hand-over the policy does not cover sends the branch line.
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
 * its verdict (the gate does not emit `silent_handover` yet — the assistant
 * lane owns that — so the engine's handling of it is driven from here).
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
    expect((await handoverEvent(conv.id))!.payload).toMatchObject({
      intent: 'complaint_online',
      templateKey: 'handover_complaint_online',
      destination: 'gm',
      closingKey: 'closing_gm',
      holdingLine: 'template',
      silent: false,
      reroutedTeamId: gm.id,
    });
    expect((await activeSlots(w, conv.id)).every((a) => a.assignedByKind === 'ai')).toBe(true);
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

  it('an unclear message on a park’s thread stays with that park, with the branch closing line', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'hmm not sure what to do now');
    const reception = await teamOf(w, 'reception', w.central);
    expect(conv.teamId).toBe(reception.id);
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'emotional_or_unclear', action: 'handover', reason: 'UNCLEAR', bubbles: [] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'general', teamId: reception.id, branchId: w.central });
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_branch]);
    expect((await handoverEvent(conv.id))!.payload).toMatchObject({ destination: 'general', closingKey: 'closing_branch', reroutedTeamId: null });
  });

  it('an unclear message on a thread with no park goes to the GM', async () => {
    await drain();
    const conv = await customer(w, wide, nextPhone(), 'hmm not sure what to do now');
    expect(conv.branchId).toBeNull();
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'emotional_or_unclear', action: 'handover', reason: 'UNCLEAR', bubbles: [] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    const gm = await teamOf(w, 'gm');
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'gm', teamId: gm.id });
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_gm]);
  });

  it('a birthday closes with the birthday manager’s line, in the customer’s language', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'อยากจัดวันเกิดให้ลูกค่ะ');
    w.fake.push({
      kind: 'decision',
      decision: decision({ language: 'th', intent: 'birthday_party', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }),
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

  it('any hand-over the intent table routes to gm (jobs, photography, refunds, when the assistant names them) goes to GM', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'are you hiring? I am a photographer too');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'custom_request', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    // The table's own route, as the assistant lane's new intents will carry it.
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

  it('a missing destination line falls back to the intent’s own template', async () => {
    await drain();
    const closing = await templateRow('closing_gm', 'en');
    await w.ctx.db.update(s.template).set({ active: false }).where(eq(s.template.id, closing.id));
    try {
      const conv = await customer(w, central, nextPhone(), 'your instagram ad is misleading');
      w.fake.push({ kind: 'decision', decision: decision({ intent: 'complaint_online', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
      expect((await tick(w, later(25_000))).handedOver).toBe(1);
      const own = await templateRow('handover_complaint_online', 'en');
      expect((await aiLines(w, conv.id)).map((l) => ({ body: l.body, templateId: l.templateId }))).toEqual([{ body: own.body, templateId: own.id }]);
      expect((await handoverEvent(conv.id))!.payload).toMatchObject({ destination: 'gm', closingKey: null, holdingLine: 'template' });
    } finally {
      await w.ctx.db.update(s.template).set({ active: true }).where(eq(s.template.id, closing.id));
    }
  });
});

describe('the number’s silence policy', () => {
  it('reads a policy defensively: a list of words, or nothing', () => {
    expect(silentIntentsOf(null)).toBeNull();
    expect(silentIntentsOf({ silentIntents: 'lost_item' })).toBeNull();
    expect(silentIntentsOf({ silentIntents: ['lost_item', 3, 'nanny_booking'] })).toEqual(new Set(['lost_item', 'nanny_booking']));
    // Every hand-over part must be on the list; an answerable part rides along.
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

  it('a number with no policy: a lost item gets the branch closing line', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'I lost my sunglasses');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'lost_item', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([INBOX_TEMPLATE_BODIES.closing_branch]);
  });

  it('an answer with a silenced hand-over part: the answer goes, the hand-over is silent', async () => {
    await drain();
    const policyNumber = await simAccount(w, { branchId: w.central, silentIntents: ['lost_item'] });
    const conv = await customer(w, policyNumber, nextPhone(), 'do we need socks? also I lost my hat');
    const answer = `Yes, everyone on the play floor wears grip socks ${SENTINEL}.`;
    w.fake.push({
      kind: 'decision',
      decision: decision({ intent: 'socks', intents: ['socks', 'lost_item'], grounding: ['socks'], reason: 'MIXED_INTENTS', bubbles: [answer] }),
    });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([answer]);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', reason: 'SILENCE_POLICY' });
    expect((await handoverEvent(conv.id))!.payload).toMatchObject({ silent: true, holdingLine: 'none' });
  });

  it('a silent hand-over the gate names, with no policy covering it, goes as a normal hand-over with the branch line', async () => {
    await drain();
    const conv = await customer(w, central, nextPhone(), 'birthday for 20 kids next month');
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'birthday_party', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
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
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'lost_item', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }) });
    seen.reshape = (v) => toSilentHandover(v as GateVerdict);
    try {
      expect((await tick(w, later(25_000))).handedOver).toBe(1);
    } finally {
      seen.reshape = null;
    }
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
    expect(text).toContain('Resident: 1 Hour Play ฿483 weekday, ฿552 weekend');
    expect(text).toContain('Thai: 1 Hour Play ฿420 weekday, ฿520 weekend');
    expect(text).not.toMatch(/expat/i);
    expect(text).toContain('Tourist starts from ฿690 (1 Hour Play)');
    expect(text).toContain('Resident starts from ฿483 (1 Hour Play, weekday)');
    expect(text).toContain('Thai starts from ฿420 (1 Hour Play, weekday)');
    expect(text).toContain('Tourist adults: ฿350 weekday, ฿500 weekend (Food & Play ฿350 every day)');
    expect(text).toContain('Thai adults: first adult free, then ฿350 weekday, ฿500 weekend (Food & Play ฿350 every day)');
    // Tourist first, then resident, then Thai.
    expect(text.indexOf('Tourist:')).toBeLessThan(text.indexOf('Resident:'));
    expect(text.indexOf('Resident:')).toBeLessThan(text.indexOf('Thai:'));
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
    expect(centralPrices).toContain('Resident:');
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
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'faq', certainty: 'unsure', bubbles: ['Maybe'] }) });
    expect((await tick(w, later(25_000))).silent).toBe(1);
    await customer(w, central, phone, 'buy crypto now');
    w.fake.push({ kind: 'decision', decision: spam() });
    expect((await tick(w, later(25_000))).silent).toBe(1);
    expect((await conversationRow(w, conv.id)).status).toBe('active');
    const turns = await turnsOf(w, conv.id);
    expect(turns.map((t) => t.reason)).toEqual(['UNSURE', 'INTENT_SILENT']);
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
