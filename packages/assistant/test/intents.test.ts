import { describe, expect, it } from 'vitest';
import { applyGates } from '../src/gate';
import {
  AI_ACTIONS,
  AI_HOLDING_TEMPLATE_KEYS,
  AI_INTENTS,
  BIRTHDAYS_PLAN,
  BRANCH_PLAN,
  BY_BRANCH,
  CENTRAL_PLAN,
  NANNY_BOOKING_PLAN,
  GM_PLAN,
  INTENT_TABLE,
  resolvePlan,
  type AiIntent,
  type AiPlanRef,
} from '../src/intents';
import { decision, episode, fixtureKnowledge } from './support';

const handoverIntents = AI_INTENTS.filter((i) => INTENT_TABLE[i].action === 'handover');
const answerIntents = AI_INTENTS.filter((i) => INTENT_TABLE[i].action === 'answer');
const leadIntents = handoverIntents.filter((i) => {
  const r = INTENT_TABLE[i];
  return r.action === 'handover' && r.lead;
});
const plainHandoverIntents = handoverIntents.filter((i) => !leadIntents.includes(i));

describe('the intent table (PLAN §B.2, SCRUM-220 playbook)', () => {
  it('maps every intent to exactly one of the four server actions', () => {
    expect(Object.keys(INTENT_TABLE).sort()).toEqual([...AI_INTENTS].sort());
    for (const intent of AI_INTENTS) {
      const actions = AI_ACTIONS.filter((a) => INTENT_TABLE[intent].action === a);
      expect(actions, intent).toHaveLength(1);
    }
  });

  it('holds the playbook: these answer, these hand over, two hand over in silence, and only `other` is silent', () => {
    expect(answerIntents.sort()).toEqual(
      [
        'about_oto',
        'address',
        'age_rules',
        'birthday_brochure',
        'birthday_party',
        'directions_parking',
        'discount_negotiation',
        'drop_off_service',
        'faq',
        'greeting',
        'hours',
        'identity_question',
        'nanny_booking',
        'socks',
        'special_event',
        'special_tickets',
        'thanks_closing',
        'ticket_prices',
      ].sort(),
    );
    expect(handoverIntents.sort()).toEqual(
      [
        'birthday_cake',
        'birthday_details',
        'complaint_online',
        'complaint_onsite',
        'custom_request',
        'discount_insist',
        'emotional_or_unclear',
        'events_groups',
        'human_requested',
        'influencer_marketing',
        'job_request',
        'photography_question',
        'refund_request',
        'special_tickets_buy',
      ].sort(),
    );
    expect(AI_INTENTS.filter((i) => INTENT_TABLE[i].action === 'silent_handover').sort()).toEqual(['drop_off_care', 'lost_item']);
    expect(AI_INTENTS.filter((i) => INTENT_TABLE[i].action === 'silent')).toEqual(['other']);
  });

  it('drop_off_care (refined from the foundation stub) is the silent hand-over to the branch; the service itself is answered', () => {
    expect(INTENT_TABLE.drop_off_care).toEqual({ action: 'silent_handover', plan: BRANCH_PLAN });
    expect(INTENT_TABLE.lost_item).toEqual({ action: 'silent_handover', plan: BRANCH_PLAN });
    expect(INTENT_TABLE.drop_off_service.action).toBe('answer');
  });

  it('routes and templates each handover to its playbook destination', () => {
    const plan = (i: AiIntent): AiPlanRef => {
      const r = INTENT_TABLE[i];
      if (r.action !== 'handover') throw new Error(i);
      return r.plan;
    };
    for (const i of ['birthday_details', 'birthday_cake', 'events_groups', 'special_tickets_buy'] as const) {
      expect(plan(i), i).toEqual(BIRTHDAYS_PLAN);
    }
    for (const i of ['complaint_onsite', 'complaint_online', 'refund_request', 'influencer_marketing', 'job_request', 'photography_question'] as const) {
      expect(plan(i), i).toEqual(GM_PLAN);
    }
    for (const i of ['custom_request', 'emotional_or_unclear', 'discount_insist'] as const) {
      expect(plan(i), i).toBe(BY_BRANCH);
    }
    expect(plan('human_requested')).toEqual({ templateKey: 'handover_general', route: 'keep', brochure: false });
    const nanny = INTENT_TABLE.nanny_booking;
    if (nanny.action !== 'answer') throw new Error('nanny_booking');
    // SCRUM-677: after the answer, the plan's own booking line; unanswered, Central's branch line.
    expect(nanny.thenHandover).toEqual(NANNY_BOOKING_PLAN);
    expect(NANNY_BOOKING_PLAN).toEqual({ ...CENTRAL_PLAN, templateKey: 'closing_booking' });
    expect(nanny.fallback?.plan).toEqual(CENTRAL_PLAN);
    for (const i of handoverIntents) {
      for (const known of [true, false]) expect(AI_HOLDING_TEMPLATE_KEYS).toContain(resolvePlan(plan(i), known).templateKey);
    }
  });

  it('the person-first intents stand alone; only a complaint carries an apology before the closing line', () => {
    const alone = handoverIntents.filter((i) => {
      const r = INTENT_TABLE[i];
      return r.action === 'handover' && !r.answerAlongside;
    });
    expect(alone.sort()).toEqual(['complaint_online', 'complaint_onsite', 'emotional_or_unclear', 'human_requested', 'refund_request'].sort());
    expect(leadIntents.filter((i) => alone.includes(i)).sort()).toEqual(['complaint_online', 'complaint_onsite']);
  });

  it('lets only the birthday brochure carry the brochure (never the events brochure)', () => {
    for (const intent of AI_INTENTS) {
      const r = INTENT_TABLE[intent];
      const ref =
        r.action === 'handover' || r.action === 'silent_handover' ? r.plan : r.action === 'answer' ? r.thenHandover : null;
      const brochure = ref !== null && ref !== BY_BRANCH ? ref.brochure : false;
      expect(brochure, intent).toBe(intent === 'birthday_brochure');
    }
  });
});

describe('the server overrules a model answer on every handover intent', () => {
  const knowledge = fixtureKnowledge();
  const gate = (intent: AiIntent, action: 'answer' | 'silent', bubbles: string[]) =>
    applyGates({
      decision: decision({ intent, action, certainty: action === 'answer' ? 'sure' : 'unsure', bubbles }),
      grounding: knowledge.grounding,
      episode: episode(),
    });

  it.each(plainHandoverIntents)(
    '%s: a sure model "answer" becomes a handover, and its answer text is not passed as an answer',
    (intent) => {
      const verdict = gate(intent, 'answer', ['Sure, happy to help with that 😊']);
      expect(verdict.action).toBe('handover');
      if (verdict.action !== 'handover') return;
      expect(verdict.reason).toBe('OVERRULED_HANDOVER');
      const rule = INTENT_TABLE[intent];
      if (rule.action === 'handover') expect(verdict.plan).toEqual(resolvePlan(rule.plan, false));
    },
  );

  it.each(leadIntents)(
    '%s: the model\'s one line rides only as the lead line, with the hand-over after it',
    (intent) => {
      const rule = INTENT_TABLE[intent];
      if (rule.action !== 'handover') throw new Error(intent);
      expect(gate(intent, 'answer', ['Sure, happy to help with that 😊'])).toMatchObject({
        action: 'answer',
        groundingKeys: [],
        thenHandover: resolvePlan(rule.plan, false),
        mayAutoHandle: false,
      });
    },
  );

  it.each(handoverIntents)(
    '%s: a model "silent" still hands over (the safe direction)',
    (intent) => {
      expect(gate(intent, 'silent', [])).toMatchObject({ action: 'handover', reason: 'OK', holdingBubbles: [] });
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
