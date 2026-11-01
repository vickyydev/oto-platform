import { describe, expect, it } from 'vitest';
import { applyGates } from '../src/gate';
import { AI_HOLDING_TEMPLATE_KEYS, AI_INTENTS, CAMPS_PLAN, INTENT_TABLE } from '../src/intents';
import { PLAYBOOK_LINES } from '../src/persona';
import { INTENT_MEANING, STATIC_SYSTEM_TEXT, buildKnowledge, type KbEntryInput } from '../src/prompt';
import { PLAYBOOK_KB, TIER_BRANCHES, pgate } from './playbook-support';
import { FIXTURE_KB, decision, episode } from './support';

/**
 * SCRUM-676, the real-chat replay (2 Nov 2026): "Do you have camp today? And
 * next week?" was read as a school or group (`events_groups`), answered with
 * the group line's "we can put together a special deal!" and closed with the
 * birthday manager's line. A camp is its own intent now, and a HAND-OVER: to
 * the Birthday & events team with the playbook's neutral "not covered" line,
 * never answered, never with the model's deal words. The gate cannot tell a
 * camp fact from any other entry an answer cites, so no citation lets a camp
 * answer through; the burst's other parts are still answered first (D1a).
 *
 * FICTIONAL TEST DATA: the camp entry is written for these checks only.
 */

/** The group line the replay sent: it must never answer a camp. */
const GROUP_LINE = "We'd love to welcome your little ones, and we can put together a special deal!";
/** The hours as the playbook fixture holds them. */
const HOURS_LINE = "We're open every day 10:00–20:00 😊";

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

describe('SCRUM-676: a camp question is its own intent, and a hand-over', () => {
  it('is a hand-over row to Birthdays & events with the unclear line, answered alongside, with no lead line', () => {
    expect(AI_INTENTS).toContain('camps');
    expect(INTENT_TABLE.camps).toEqual({ action: 'handover', plan: CAMPS_PLAN, answerAlongside: true, lead: false });
    expect(CAMPS_PLAN).toEqual({ templateKey: 'closing_unclear', route: 'birthdays', brochure: false });
    expect(AI_HOLDING_TEMPLATE_KEYS).toContain(CAMPS_PLAN.templateKey);
  });

  it('the prompt names the camp intent as a hand-over, and a camp is no longer a school or a group', () => {
    expect(STATIC_SYSTEM_TEXT).toContain(
      `- camps: ${INTENT_MEANING.camps} -> handover: no words of your own, the closing line is sent; a colleague takes over`,
    );
    expect(INTENT_MEANING.camps).toMatch(/camp/);
    expect(INTENT_MEANING.events_groups).not.toMatch(/camp/);
    expect(PLAYBOOK_LINES).toMatch(/camps \(a kids' camp[^\n]*never answered[^\n]*no deal, no group line/);
    expect(STATIC_SYSTEM_TEXT).toContain(PLAYBOOK_LINES);
  });

  it('the model hands a camp over: the camps plan, nothing of the model\'s', () => {
    expect(pgate({ intent: 'camps', action: 'handover', reason: 'FACT_MISSING', bubbles: [] })).toMatchObject({
      action: 'handover',
      reason: 'OK',
      intent: 'camps',
      plan: CAMPS_PLAN,
      holdingBubbles: [],
    });
  });

  it('the replay\'s deal line, written as an answer, is overruled into the hand-over whatever it cites', () => {
    for (const grounding of [[], ['pb.food'], ['pb.halloween'], ['pb.parent-tickets']]) {
      const v = pgate({ intent: 'camps', reason: 'FACT_IN_KB', grounding, bubbles: [GROUP_LINE] });
      expect(v, grounding.join(',') || 'uncited').toMatchObject({ action: 'handover', reason: 'OVERRULED_HANDOVER', intent: 'camps', plan: CAMPS_PLAN });
    }
  });

  it('a "yes, camp today" or an invented camp date is never sent as an answer, whatever it cites', () => {
    for (const bubble of ['Yes, we have a kids camp today', 'Yes! Our camp runs next week', 'Yes, camp runs today from 9 to 3!']) {
      for (const grounding of [['pb.food'], ['pb.halloween'], ['pb.parent-tickets']]) {
        const v = pgate({ intent: 'camps', reason: 'FACT_IN_KB', grounding, bubbles: [bubble] });
        expect(v.action, `${bubble} / ${grounding.join(',')}`).toBe('handover');
      }
    }
  });

  it('a camp entry in the knowledge does not make a camp answerable: the gate cannot tell it from any other entry', () => {
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
    expect(v).toMatchObject({ action: 'handover', reason: 'OVERRULED_HANDOVER', intent: 'camps', plan: CAMPS_PLAN });
  });

  it('beside another question, that part is answered first and the camp hand-over follows (D1a), either part first', () => {
    for (const intents of [['hours', 'camps'], ['camps', 'hours']] as const) {
      const v = pgate({
        intent: intents[0],
        intents: [...intents],
        reason: 'FACT_IN_KB',
        grounding: ['fact.hours.central'],
        bubbles: [HOURS_LINE],
      });
      expect(v, intents.join(',')).toMatchObject({
        action: 'answer',
        reason: 'OK',
        bubbles: [HOURS_LINE],
        groundingKeys: ['fact.hours.central'],
        thenHandover: CAMPS_PLAN,
        mayAutoHandle: false,
      });
    }
  });

  it('beside another question, the bubbles are checked as the answered part\'s: the D1a limit, no weaker than the group part a camp was read as', () => {
    // The gate checks every bubble against the sources the reply cites (the
    // number, date, link and promise guards); it does not read which part a
    // bubble speaks to. So a camp time the cited hours do not state is
    // refused, while a camp claim with no number in it rides the answered
    // part, as it would beside any hand-over part; the prompt says nothing
    // about the camp is written. Pinned here as the limit it is.
    const mixed = (handoverPart: 'camps' | 'events_groups', bubble: string) =>
      pgate({
        intent: 'hours',
        intents: ['hours', handoverPart],
        reason: 'FACT_IN_KB',
        grounding: ['fact.hours.central'],
        bubbles: [HOURS_LINE, bubble],
      });
    expect(mixed('camps', 'And camp runs today from 9 to 3!').action).not.toBe('answer');
    for (const bubble of ['And camp runs today from 9 to 3!', 'And yes, we have a camp today!']) {
      const asCamp = mixed('camps', bubble);
      const asGroup = mixed('events_groups', bubble);
      expect({ action: asCamp.action, reason: asCamp.reason }, bubble).toEqual({ action: asGroup.action, reason: asGroup.reason });
    }
  });
});
