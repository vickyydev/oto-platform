import { describe, expect, it } from 'vitest';
import { applyGates } from '../src/gate';
import { AI_INTENTS, CAMPS_PLAN, INTENT_TABLE } from '../src/intents';
import { PLAYBOOK_LINES } from '../src/persona';
import { INTENT_MEANING, STATIC_SYSTEM_TEXT, buildKnowledge, type KbEntryInput } from '../src/prompt';
import { PLAYBOOK_KB, TIER_BRANCHES, pgate } from './playbook-support';
import { FIXTURE_KB, decision, episode } from './support';

/**
 * SCRUM-676, the real-chat replay (2 Nov 2026): "Do you have camp today? And
 * next week?" was read as a school or group (`events_groups`), answered with
 * the group line's "we can put together a special deal!" and closed with the
 * birthday manager's line. A camp is its own intent now: answered from the
 * knowledge when it holds a camp, else handed to the Birthday & events team
 * with the events team's neutral line, and never with deal words.
 *
 * FICTIONAL TEST DATA: the camp entry is written for these checks only.
 */

/** The group line the replay sent: it must never answer a camp. */
const GROUP_LINE = "We'd love to welcome your little ones, and we can put together a special deal!";

const CAMP_ROW: KbEntryInput = {
  key: 'faq.kids-camp',
  topic: 'faq',
  language: 'en',
  branch: null,
  question: 'Do you run a kids camp?',
  body: 'Our kids camp (fixture) runs in the school holidays at Central Floresta: games, crafts and lunch, for children from 5 years old.',
  needsTranslation: false,
};

/** The playbook knowledge with a camp in it. */
const withCamp = buildKnowledge({ kb: [...FIXTURE_KB, ...PLAYBOOK_KB, CAMP_ROW], branches: TIER_BRANCHES, examples: [] });

describe('SCRUM-676: a camp question is its own intent', () => {
  it('is in the intent table, answered from the same sources as an event, with the events line as its fallback', () => {
    expect(AI_INTENTS).toContain('camps');
    expect(INTENT_TABLE.camps).toEqual({
      action: 'answer',
      groundingTopics: ['faq', 'about_oto', 'prices_note'],
      general: false,
      thenHandover: null,
      mayAutoHandle: false,
      fallback: { plan: CAMPS_PLAN, lead: false },
    });
    expect(CAMPS_PLAN).toEqual({ templateKey: 'handover_events', route: 'birthdays', brochure: false });
  });

  it('the prompt names the camp intent, and a camp is no longer a school or a group', () => {
    expect(STATIC_SYSTEM_TEXT).toContain(`- camps: ${INTENT_MEANING.camps} -> answer from the knowledge; when it cannot be answered, handover`);
    expect(INTENT_MEANING.camps).toMatch(/camp/);
    expect(INTENT_MEANING.events_groups).not.toMatch(/camp/);
    expect(PLAYBOOK_LINES).toMatch(/camps \(a kids' camp[^\n]*no deal, no group line/);
    expect(STATIC_SYSTEM_TEXT).toContain(PLAYBOOK_LINES);
  });

  it('a camp the knowledge holds is answered from it, and nobody takes over', () => {
    const v = applyGates({
      decision: decision({
        intent: 'camps',
        reason: 'FACT_IN_KB',
        grounding: ['faq.kids-camp'],
        bubbles: ['Yes! Our kids camp runs in the school holidays at Central Floresta, with games, crafts and lunch 😊'],
      }),
      grounding: withCamp.grounding,
      episode: episode(),
    });
    expect(v).toMatchObject({ action: 'answer', reason: 'OK', intent: 'camps', groundingKeys: ['faq.kids-camp'], thenHandover: null });
  });

  it('a camp the knowledge does not hold: the events team, its own line, and no words of the model', () => {
    expect(pgate({ intent: 'camps', action: 'handover', reason: 'FACT_MISSING', bubbles: [] })).toMatchObject({
      action: 'handover',
      reason: 'OK',
      intent: 'camps',
      plan: CAMPS_PLAN,
      holdingBubbles: [],
    });
  });

  it('the replay\'s deal line, written as an answer with nothing to rest on, is overruled: none of its words ride', () => {
    const v = pgate({ intent: 'camps', reason: 'FACT_IN_KB', bubbles: [GROUP_LINE] });
    expect(v).toMatchObject({ action: 'handover', reason: 'OVERRULED_HANDOVER', plan: CAMPS_PLAN, holdingBubbles: [] });
  });

  it('an invented camp date is overruled the same way, never sent', () => {
    expect(pgate({ intent: 'camps', grounding: ['pb.halloween'], bubbles: ['Yes, camp runs today from 9 to 3!'] })).toMatchObject({
      action: 'handover',
      reason: 'OVERRULED_HANDOVER',
      plan: CAMPS_PLAN,
      holdingBubbles: [],
    });
  });
});
