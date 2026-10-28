import { describe, expect, it } from 'vitest';
import { applyGates } from '../src/gate';
import {
  AI_ACTIONS,
  AI_HOLDING_TEMPLATE_KEYS,
  AI_INTENTS,
  BIRTHDAY_INTENTS,
  INTENT_TABLE,
  type AiIntent,
} from '../src/intents';
import { decision, episode, fixtureKnowledge } from './support';

const handoverIntents = AI_INTENTS.filter((i) => INTENT_TABLE[i].action === 'handover');
const answerIntents = AI_INTENTS.filter((i) => INTENT_TABLE[i].action === 'answer');

describe('the intent table (PLAN §B.2)', () => {
  it('maps every intent to exactly one of the three server actions', () => {
    expect(Object.keys(INTENT_TABLE).sort()).toEqual([...AI_INTENTS].sort());
    for (const intent of AI_INTENTS) {
      const actions = AI_ACTIONS.filter((a) => INTENT_TABLE[intent].action === a);
      expect(actions, intent).toHaveLength(1);
    }
  });

  it('holds the brief: these answer, these hand over, and only `other` is silent', () => {
    expect(answerIntents.sort()).toEqual(
      [
        'about_oto',
        'address',
        'age_rules',
        'birthday_brochure',
        'directions_parking',
        'faq',
        'greeting',
        'hours',
        'identity_question',
        'socks',
        'thanks_closing',
        'ticket_prices',
      ].sort(),
    );
    expect(handoverIntents.sort()).toEqual(
      [
        'birthday_party',
        'complaint_online',
        'complaint_onsite',
        'custom_request',
        'discount_negotiation',
        'emotional_or_unclear',
        'events_groups',
        'human_requested',
        'influencer_marketing',
        'lost_item',
        'nanny_booking',
        'drop_off_care',
        'special_tickets',
      ].sort(),
    );
    expect(AI_INTENTS.filter((i) => INTENT_TABLE[i].action === 'silent')).toEqual(['other']);
  });

  it('drop_off_care (SCRUM-220 playbook) starts as exactly the nanny hand-over, for the playbook lane to refine', () => {
    expect(AI_INTENTS).toContain('drop_off_care');
    expect(INTENT_TABLE.drop_off_care).toEqual(INTENT_TABLE.nanny_booking);
  });

  it('routes and templates each handover as the plan says', () => {
    const plan = (i: AiIntent) => {
      const r = INTENT_TABLE[i];
      if (r.action !== 'handover') throw new Error(i);
      return r.plan;
    };
    expect(plan('birthday_party')).toEqual({
      templateKey: 'handover_birthday',
      route: 'birthdays',
      brochure: true,
    });
    expect(plan('events_groups')).toEqual({
      templateKey: 'handover_events',
      route: 'birthdays',
      brochure: false,
    });
    expect(plan('complaint_onsite')).toEqual({
      templateKey: 'handover_complaint_onsite',
      route: 'general',
      brochure: false,
    });
    expect(plan('complaint_online')).toEqual({
      templateKey: 'handover_complaint_online',
      route: 'marketing',
      brochure: false,
    });
    expect(plan('influencer_marketing')).toEqual({
      templateKey: 'handover_marketing',
      route: 'marketing',
      brochure: false,
    });
    expect(plan('lost_item')).toEqual({
      templateKey: 'handover_lost_found',
      route: 'general',
      brochure: false,
    });
    expect(plan('special_tickets').templateKey).toBe('handover_events');
    for (const i of [
      'discount_negotiation',
      'custom_request',
      'human_requested',
      'emotional_or_unclear',
    ] as const) {
      expect(plan(i)).toEqual({ templateKey: 'handover_general', route: 'keep', brochure: false });
    }
    for (const i of handoverIntents)
      expect(AI_HOLDING_TEMPLATE_KEYS).toContain(plan(i).templateKey);
  });

  it('lets only the birthday intents carry the brochure (never the events brochure)', () => {
    for (const intent of AI_INTENTS) {
      const r = INTENT_TABLE[intent];
      const brochure =
        r.action === 'handover'
          ? r.plan.brochure
          : r.action === 'answer'
            ? (r.thenHandover?.brochure ?? false)
            : false;
      expect(brochure, intent).toBe(BIRTHDAY_INTENTS.has(intent));
    }
  });
});

describe('the server overrules a model answer on every handover intent', () => {
  const knowledge = fixtureKnowledge();
  it.each(handoverIntents)(
    '%s: a sure model "answer" becomes a handover, and its answer text is not passed as an answer',
    (intent) => {
      const verdict = applyGates({
        decision: decision({
          intent,
          action: 'answer',
          certainty: 'sure',
          bubbles: ['Sure, happy to help with that 😊'],
        }),
        grounding: knowledge.grounding,
        episode: episode(),
      });
      expect(verdict.action).toBe('handover');
      if (verdict.action !== 'handover') return;
      expect(verdict.reason).toBe('OVERRULED_HANDOVER');
      const rule = INTENT_TABLE[intent];
      if (rule.action === 'handover') expect(verdict.plan).toEqual(rule.plan);
    },
  );

  it.each(handoverIntents)(
    '%s: a model "silent" still hands over (the safe direction)',
    (intent) => {
      const verdict = applyGates({
        decision: decision({ intent, action: 'silent', certainty: 'unsure', bubbles: [] }),
        grounding: knowledge.grounding,
        episode: episode(),
      });
      expect(verdict).toMatchObject({ action: 'handover', reason: 'OK', holdingBubbles: [] });
    },
  );

  it('`other` is silent even when the model answers', () => {
    const verdict = applyGates({
      decision: decision({ intent: 'other' }),
      grounding: knowledge.grounding,
      episode: episode(),
    });
    expect(verdict).toMatchObject({ action: 'silent', reason: 'INTENT_SILENT' });
  });
});
