import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAMPS_PLAN } from '@oto/assistant';
import { INBOX_TEMPLATE_BODIES } from '@oto/db/seed';
import { closingKeysOf } from '../src/services/inbox/ai-destination';
import { teardownAll } from './helpers';
import {
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
 * SCRUM-676, THE REAL-CHAT REPLAY (2 Nov 2026), IN THE TURN ENGINE. Nine real
 * customer questions from the exported chat history, anonymised, were played
 * against the assistant on staging; two were handled wrongly. Each is played
 * here through the real webhook, the real prompt builder, the real gates and
 * the real send path, with the `FakeAssistantClient` returning the decision
 * the live model made (read off the staging turn: its intent, parts and
 * citations).
 *
 *   - "Do you have camp today? And next week?" was read as a school or group,
 *     answered with the group line's "special deal" and closed with the
 *     birthday manager's line. A camp is its own intent now: the events
 *     team's neutral line and the Birthday & events inbox, no deal words.
 *
 * FICTIONAL TEST DATA: the KB rows are written for these checks only.
 */

let w: AiWorld;
let wide: string; // an operator-wide number, live, no park
let approver: string;

beforeAll(async () => {
  w = await aiWorld();
  wide = await simAccount(w, { branchId: null });
  const receptionCentral = await teamOf(w, 'reception', w.central);
  [approver] = await staff(w, '+66810009676', 'Replay Test Approver', 'inbox_agent', {
    scopeType: 'department',
    scopeId: receptionCentral.departmentId!,
  });
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

/** The replay's camp question, anonymised. */
const CAMP_QUESTION = 'Hello, is there a camp today? And what about next week?';
/** No line the assistant sends about a camp offers a deal. */
const DEAL_WORDS = /deal|discount|special offer|ส่วนลด|โปร|скидк/i;

async function handoverEvent(conversationId: string) {
  return (await eventsOf(w, conversationId)).find((e) => e.kind === 'ai_handover');
}

describe('SCRUM-676: a camp question (the replay\'s first miss)', () => {
  it('the camps plan closes with the events line, to Birthdays & events; that inbox\'s own line is the fallback', () => {
    expect(closingKeysOf({ plan: CAMPS_PLAN, branchLine: false, unclear: false }, 'birthdays')).toEqual(['handover_events', 'closing_birthday']);
  });

  it('no camp in the knowledge: the events team\'s neutral line, the Birthday & events inbox, no deal and no birthday manager', async () => {
    const conv = await customer(w, wide, nextPhone(), CAMP_QUESTION);
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'camps', action: 'handover', reason: 'FACT_MISSING', bubbles: [] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    const lines = (await aiLines(w, conv.id)).map((l) => l.body);
    expect(lines).toEqual([INBOX_TEMPLATE_BODIES.handover_events]);
    expect(lines.some((l) => DEAL_WORDS.test(l ?? ''))).toBe(false);
    expect(lines).not.toContain(INBOX_TEMPLATE_BODIES.closing_birthday);
    const birthdays = await teamOf(w, 'birthdays');
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'birthdays', teamId: birthdays.id, intent: 'camps' });
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', intent: 'camps' });
    expect((await handoverEvent(conv.id))!.payload).toMatchObject({
      intent: 'camps',
      destination: 'birthdays',
      templateKey: 'handover_events',
      closingKey: 'handover_events',
      holdingLine: 'template',
    });
  });

  it('the replay\'s own reply — the group line\'s deal, written as an answer — is overruled: none of it reaches the customer', async () => {
    const conv = await customer(w, wide, nextPhone(), CAMP_QUESTION);
    w.fake.push({
      kind: 'decision',
      decision: decision({
        intent: 'camps',
        reason: 'CLEAR_INTENT',
        bubbles: ["We'd love to welcome your little ones, and we can put together a special deal!"],
      }),
    });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    const lines = (await aiLines(w, conv.id)).map((l) => l.body);
    expect(lines).toEqual([INBOX_TEMPLATE_BODIES.handover_events]);
    expect(lines.some((l) => DEAL_WORDS.test(l ?? ''))).toBe(false);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', reason: 'OVERRULED_HANDOVER', intent: 'camps' });
  });

  it('a camp the knowledge holds is answered from it, and the thread stays where it was', async () => {
    await kb(w, approver, {
      key: 'faq.kids-camp',
      topic: 'faq',
      language: 'en',
      question: 'Do you run a kids camp?',
      body: 'Our kids camp (fixture) runs in the school holidays at Central Floresta: games, crafts and lunch, for children from 5 years old.',
    });
    const conv = await customer(w, wide, nextPhone(), CAMP_QUESTION);
    const answer = 'Our kids camp runs in the school holidays at Central Floresta, with games, crafts and lunch 😊';
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'camps', reason: 'FACT_IN_KB', grounding: ['faq.kids-camp'], bubbles: [answer] }) });
    expect((await tick(w, later(25_000))).answered).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([answer]);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'answered', reason: 'OK', intent: 'camps' });
    expect(await handoverEvent(conv.id)).toBeUndefined();
    // The camp entry reached the model's knowledge, citable by its key.
    expect(w.fake.requests.at(-1)!.prompt.system[1].text).toContain('[faq.kids-camp] (faq, en)');
  });
});
