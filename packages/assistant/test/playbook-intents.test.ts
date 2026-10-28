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
  GM_PLAN,
  INTENT_TABLE,
  resolvePlan,
  UNCLEAR_BRANCH_PLAN,
  UNCLEAR_GM_PLAN,
  type AiIntent,
} from '../src/intents';
import { PLAYBOOK_LINES, PROHIBITIONS } from '../src/persona';
import { STATIC_SYSTEM_TEXT } from '../src/prompt';
import { HALLOWEEN_LINK, pgate, playbookKnowledge } from './playbook-support';
import { decision, episode } from './support';

/**
 * SCRUM-220, Tom's playbook — "Routing", "Birthdays, events and groups",
 * "Golden Ticket", "Ages, nanny and drop-off", "Hand-offs" and "Message
 * sources": every playbook row as an intent, its line, and the destination
 * the engine resolves (`closing_birthday` → Birthdays, `closing_gm` → the GM
 * queue, `closing_branch` → the branch, unclear → the branch when known,
 * else the GM).
 */

describe('D. the destinations', () => {
  it('three closing lines, keyed by destination; the holding keys include them', () => {
    expect(BIRTHDAYS_PLAN).toEqual({ templateKey: 'closing_birthday', route: 'birthdays', brochure: false });
    expect(GM_PLAN).toEqual({ templateKey: 'closing_gm', route: 'gm', brochure: false });
    expect(BRANCH_PLAN).toEqual({ templateKey: 'closing_branch', route: 'general', brochure: false });
    expect(CENTRAL_PLAN).toEqual({ ...BRANCH_PLAN, branch: 'central' });
    for (const k of ['closing_birthday', 'closing_gm', 'closing_branch', 'closing_unclear'] as const) expect(AI_HOLDING_TEMPLATE_KEYS).toContain(k);
  });

  it('unclear goes to the branch when it is known, else to the GM, with the playbook\'s team-member line', () => {
    expect(resolvePlan(BY_BRANCH, true)).toEqual(UNCLEAR_BRANCH_PLAN);
    expect(resolvePlan(BY_BRANCH, false)).toEqual(UNCLEAR_GM_PLAN);
    expect(UNCLEAR_BRANCH_PLAN).toEqual({ templateKey: 'handover_general', route: 'general', brochure: false });
    expect(UNCLEAR_GM_PLAN).toEqual({ templateKey: 'handover_general', route: 'gm', brochure: false });
    expect(resolvePlan(GM_PLAN, true)).toBe(GM_PLAN);
  });

  it('every intent maps to exactly one of the four server actions, and only `other` is silent', () => {
    expect(AI_ACTIONS).toEqual(['answer', 'handover', 'silent_handover', 'silent']);
    for (const intent of AI_INTENTS) expect(AI_ACTIONS).toContain(INTENT_TABLE[intent].action);
    expect(AI_INTENTS.filter((i) => INTENT_TABLE[i].action === 'silent')).toEqual(['other']);
    expect(AI_INTENTS.filter((i) => INTENT_TABLE[i].action === 'silent_handover').sort()).toEqual(['drop_off_care', 'lost_item']);
  });

  it('the playbook lines are in the compiled prompt', () => {
    expect(STATIC_SYSTEM_TEXT).toContain(PLAYBOOK_LINES);
  });
});

describe('D. birthdays: open warmly, ONE combined question, then the closing line (owner D1)', () => {
  const open = "Amazing, thank you! We'd love to organize a party for you 🎈";
  const ask = 'What date(s) are you thinking of, roughly how many people, and which branch, Central Floresta or Robinson Chalong?';

  it('a party request is answered with the open and the one question — no hand-over yet, no brochure', () => {
    expect(INTENT_TABLE.birthday_party.action).toBe('answer');
    expect(pgate({ intent: 'birthday_party', action: 'answer', bubbles: [open, ask] })).toMatchObject({
      action: 'answer',
      reason: 'OK',
      intent: 'birthday_party',
      thenHandover: null,
      sendBrochure: false,
      askBranch: false,
      mayAutoHandle: false,
    });
  });

  it('never a party package or a party price', () => {
    expect(pgate({ intent: 'birthday_party', bubbles: [open, 'Our party package is ฿9,900 for 10 kids. What date?'] })).toMatchObject({
      action: 'silent',
      reason: 'GUARD_NUMBER',
    });
    expect(PROHIBITIONS.find((p) => p.id === 'no_party_prices')?.text).toMatch(/party packages or party prices/);
  });

  it('once the basics are in, the birthday manager\'s closing line and the Birthdays queue', () => {
    expect(pgate({ intent: 'birthday_details', action: 'handover', bubbles: [] })).toMatchObject({
      action: 'handover',
      plan: BIRTHDAYS_PLAN,
    });
    // a date in the model's words never rides: "the 14th is booked" is dropped
    expect(pgate({ intent: 'birthday_details', action: 'handover', bubbles: ['Great, the 14th is booked 🎈'] })).toMatchObject({
      action: 'handover',
      plan: BIRTHDAYS_PLAN,
      holdingBubbles: [],
      droppedHoldingRule: 'number',
    });
  });

  it('a birthday-cake question goes to the same place', () => {
    expect(pgate({ intent: 'birthday_cake', action: 'handover', bubbles: [] })).toMatchObject({ action: 'handover', plan: BIRTHDAYS_PLAN });
  });

  it('the basics beside another question: that one is answered, then the closing line', () => {
    expect(
      pgate({ intent: 'hours', intents: ['hours', 'birthday_details'], grounding: ['fact.hours.central'], bubbles: ["We're open every day 10:00–20:00 😊"] }),
    ).toMatchObject({ action: 'answer', thenHandover: BIRTHDAYS_PLAN, sendBrochure: false });
  });

  it('the brochure rides only an explicit brochure request', () => {
    expect(INTENT_TABLE.birthday_brochure).toMatchObject({ action: 'answer', thenHandover: { brochure: true, route: 'birthdays' } });
    for (const i of AI_INTENTS.filter((x) => x !== 'birthday_brochure')) {
      const r = INTENT_TABLE[i];
      const plan = r.action === 'handover' || r.action === 'silent_handover' ? r.plan : r.action === 'answer' ? r.thenHandover : null;
      expect(plan !== null && plan !== BY_BRANCH && plan.brochure, i).toBeFalsy();
    }
  });
});

describe('D. special events, schools and groups', () => {
  it('an event the knowledge holds is sold right away: its description and booking link', () => {
    expect(
      pgate({
        intent: 'special_event',
        grounding: ['pb.halloween'],
        bubbles: [`Halloween at OTO is a spooky play day with costumes and games 🎃 Book here: ${HALLOWEEN_LINK}`],
      }),
    ).toMatchObject({ action: 'answer', thenHandover: null });
  });

  it('an event the knowledge does not hold: the closing line and the Birthdays queue', () => {
    expect(pgate({ intent: 'special_event', action: 'handover', bubbles: [] })).toMatchObject({ action: 'handover', plan: BIRTHDAYS_PLAN });
    // an answer with nothing to rest on is overruled into that hand-over, never silence
    expect(pgate({ intent: 'special_event', grounding: [], bubbles: ['Easter is a big egg hunt!'] })).toMatchObject({
      action: 'handover',
      reason: 'OVERRULED_HANDOVER',
      plan: BIRTHDAYS_PLAN,
      holdingBubbles: [],
    });
  });

  it('a citation the prompt never offered is overruled the same way (a part with a fallback is never silence)', () => {
    expect(pgate({ intent: 'special_event', grounding: ['pb.easter'], bubbles: ['Easter is a big egg hunt!'] })).toMatchObject({
      action: 'handover',
      reason: 'OVERRULED_HANDOVER',
      plan: BIRTHDAYS_PLAN,
      holdingBubbles: [],
    });
    // a part with no fallback keeps the old silence
    expect(pgate({ intent: 'hours', grounding: ['pb.easter'], bubbles: ['We open at 10.'] })).toMatchObject({
      action: 'silent',
      reason: 'GROUNDING_UNKNOWN',
    });
  });

  it("schools and groups: the playbook's warm line, then the Birthdays queue", () => {
    const lead = "We'd love to welcome your school or group, and we can put together a special deal!";
    expect(pgate({ intent: 'events_groups', action: 'handover', bubbles: [lead] })).toMatchObject({
      action: 'answer',
      bubbles: [lead],
      groundingKeys: [],
      thenHandover: BIRTHDAYS_PLAN,
      mayAutoHandle: false,
    });
    expect(pgate({ intent: 'events_groups', action: 'handover', bubbles: [] })).toMatchObject({ action: 'handover', plan: BIRTHDAYS_PLAN });
    expect(pgate({ intent: 'events_groups', action: 'handover', bubbles: ['We can do 20% off for 30 kids!'] })).toMatchObject({
      action: 'handover',
      plan: BIRTHDAYS_PLAN,
      holdingBubbles: [],
    });
  });
});

describe('D. the Golden Ticket: answer first, then the events team', () => {
  const info = 'The Golden Ticket is ฿1,500 per child: full-day play, OTO grip socks and a mascot experience 🎉 Children 5 and up also get drop-off and entry for 1 parent.';

  it('the ticket is answered from the knowledge', () => {
    expect(INTENT_TABLE.special_tickets.action).toBe('answer');
    expect(pgate({ intent: 'special_tickets', grounding: ['pb.golden-ticket'], bubbles: [info] })).toMatchObject({
      action: 'answer',
      thenHandover: null,
    });
  });

  it('wanting to buy: "Amazing!" and the Birthdays queue', () => {
    expect(pgate({ intent: 'special_tickets_buy', action: 'handover', bubbles: ['Amazing! 🎉'] })).toMatchObject({
      action: 'answer',
      bubbles: ['Amazing! 🎉'],
      thenHandover: BIRTHDAYS_PLAN,
    });
    expect(pgate({ intent: 'special_tickets', action: 'handover', bubbles: [] })).toMatchObject({ action: 'handover', plan: BIRTHDAYS_PLAN });
  });

  it("the prompt says the Golden Ticket's parent entry is never food credit", () => {
    expect(PLAYBOOK_LINES).toMatch(/Golden Ticket[^\n]*never call it food credit/);
  });
});

describe('D. a price objection is answered with the value line and a deal from the knowledge', () => {
  it('the value line and the Dinner Promo, grounded, is an answer', () => {
    expect(INTENT_TABLE.discount_negotiation.action).toBe('answer');
    expect(
      pgate({
        intent: 'discount_negotiation',
        grounding: ['pb.parent-tickets', 'pb.deal-dinner-promo'],
        bubbles: [
          'Parent tickets are food and drink credit at our restaurant, and everything inside is included 😊',
          'At Robinson Chalong the Dinner Promo after 6pm is ฿1,080 on weekdays, all of it food and drink credit.',
        ],
      }),
    ).toMatchObject({ action: 'answer', thenHandover: null });
  });

  it('an invented discount never passes: overruled into the unclear hand-over', () => {
    expect(
      pgate({ intent: 'discount_negotiation', grounding: ['pb.parent-tickets'], bubbles: ['OK, 20% discount for you!'] }),
    ).toMatchObject({ action: 'handover', reason: 'OVERRULED_HANDOVER', plan: UNCLEAR_GM_PLAN, holdingBubbles: [] });
    expect(
      pgate({ intent: 'discount_negotiation', grounding: ['pb.parent-tickets'], bubbles: ['We can give you a discount!'] }, { threadHasBranch: true }),
    ).toMatchObject({ action: 'handover', plan: UNCLEAR_BRANCH_PLAN, droppedHoldingRule: 'en:discount' });
  });

  it('still pushing after the deal: a colleague (branch if known, else the GM)', () => {
    expect(pgate({ intent: 'discount_insist', action: 'handover', bubbles: [] })).toMatchObject({ action: 'handover', plan: UNCLEAR_GM_PLAN });
    expect(pgate({ intent: 'discount_insist', action: 'handover', bubbles: [], branchNamed: 'chalong' })).toMatchObject({
      action: 'handover',
      plan: UNCLEAR_BRANCH_PLAN,
    });
  });
});

describe('D. complaints, refunds and the GM list', () => {
  const apology = "I'm so sorry to hear that, that's not the visit we want for you 🙏";

  it('a complaint: one sincere apology, then the GM closing line and the GM queue', () => {
    for (const intent of ['complaint_onsite', 'complaint_online'] as const) {
      expect(pgate({ intent, action: 'handover', bubbles: [apology] })).toMatchObject({
        action: 'answer',
        intent,
        bubbles: [apology],
        thenHandover: GM_PLAN,
        mayAutoHandle: false,
      });
      expect(pgate({ intent, action: 'handover', bubbles: [] })).toMatchObject({ action: 'handover', plan: GM_PLAN });
    }
  });

  it('an apology that admits fault, offers anything or argues is dropped: the closing line goes alone', () => {
    expect(pgate({ intent: 'complaint_onsite', action: 'handover', bubbles: ['So sorry, it was our fault.'] })).toMatchObject({
      action: 'handover',
      plan: GM_PLAN,
      holdingBubbles: [],
      droppedHoldingRule: 'en:fault',
    });
    expect(pgate({ intent: 'complaint_onsite', action: 'handover', bubbles: ["So sorry! We'll give you a free visit."] })).toMatchObject({
      action: 'handover',
      plan: GM_PLAN,
      droppedHoldingRule: 'en:free',
    });
    expect(pgate({ language: 'th', intent: 'complaint_onsite', action: 'handover', bubbles: ['ขออภัยค่ะ เราจะชดเชยให้นะคะ'] })).toMatchObject({
      action: 'handover',
      plan: GM_PLAN,
      holdingBubbles: [],
    });
  });

  it('a complaint stands alone: an answer to another part never rides the apology', () => {
    expect(
      pgate({
        intent: 'complaint_onsite',
        intents: ['complaint_onsite', 'hours'],
        grounding: ['fact.hours.central'],
        bubbles: [apology, "We're open 10:00–20:00."],
      }),
    ).toMatchObject({ action: 'handover', plan: GM_PLAN, holdingBubbles: [] });
    expect(
      pgate({ intent: 'hours', intents: ['hours', 'complaint_online'], grounding: [], bubbles: [apology] }),
    ).toMatchObject({ action: 'answer', bubbles: [apology], thenHandover: GM_PLAN });
  });

  it('a refund: never yes or no, the GM line and the GM queue', () => {
    expect(pgate({ intent: 'refund_request', action: 'handover', bubbles: [] })).toMatchObject({ action: 'handover', plan: GM_PLAN });
    expect(pgate({ intent: 'refund_request', action: 'answer', bubbles: ["Yes, we'll refund you."] })).toMatchObject({
      action: 'handover',
      plan: GM_PLAN,
      holdingBubbles: [],
    });
    expect(
      pgate({ intent: 'refund_request', intents: ['refund_request', 'hours'], grounding: ['fact.hours.central'], bubbles: ['Open 10:00–20:00'] }),
    ).toMatchObject({ action: 'handover', plan: GM_PLAN, holdingBubbles: [] });
  });

  it('bloggers and collaborations go to the GM (no longer Marketing)', () => {
    expect(pgate({ intent: 'influencer_marketing', action: 'handover', bubbles: [] })).toMatchObject({ action: 'handover', plan: GM_PLAN });
  });

  it("a job request: the playbook's warm line, then the GM", () => {
    const lead = "We're always looking for great people!";
    expect(pgate({ intent: 'job_request', action: 'handover', bubbles: [lead] })).toMatchObject({
      action: 'answer',
      bubbles: [lead],
      thenHandover: GM_PLAN,
    });
  });

  it('a photography question: "Good question!", then the GM', () => {
    expect(pgate({ intent: 'photography_question', action: 'handover', bubbles: ['Good question!'] })).toMatchObject({
      action: 'answer',
      thenHandover: GM_PLAN,
    });
  });
});

describe('D. nanny and drop-off', () => {
  const nanny = 'Our nanny service is one-on-one care at Central Floresta, ฿330 per hour, from age 3 up to 4 years 11 months. Best to book ahead 😊';

  it('a nanny question is answered from the facts, then Central takes the booking', () => {
    expect(pgate({ intent: 'nanny_booking', grounding: ['pb.nanny'], bubbles: [nanny] })).toMatchObject({
      action: 'answer',
      thenHandover: CENTRAL_PLAN,
    });
  });

  it('never framed as safer; an answer that does is overruled into the Central hand-over', () => {
    expect(
      pgate({ intent: 'nanny_booking', grounding: ['pb.nanny'], bubbles: ['A nanny is safer for little ones, ฿330 per hour at Central Floresta.'] }),
    ).toMatchObject({ action: 'handover', reason: 'OVERRULED_HANDOVER', plan: CENTRAL_PLAN, droppedHoldingRule: 'en:safer' });
    expect(pgate({ intent: 'nanny_booking', action: 'handover', bubbles: [] })).toMatchObject({ action: 'handover', plan: CENTRAL_PLAN });
  });

  it('a question about the drop-off SERVICE is answered from the knowledge', () => {
    expect(
      pgate({
        intent: 'drop_off_service',
        grounding: ['pb.dropoff'],
        bubbles: ['Drop-off is from the 5th birthday, ฿225 per visit, with regular photo updates and our child supervisors the whole time 😊'],
      }),
    ).toMatchObject({ action: 'answer', thenHandover: null });
  });

  it('a child CURRENTLY in our care: a silent hand-over to the branch, whatever the model wrote', () => {
    for (const action of ['answer', 'handover', 'silent'] as const) {
      const v = pgate({ intent: 'drop_off_care', action, bubbles: action === 'silent' ? [] : ["He's doing great!"] });
      expect(v, action).toEqual({
        action: 'silent_handover',
        reason: 'SILENCE_POLICY',
        intent: 'drop_off_care',
        intents: ['drop_off_care'],
        language: 'en',
        plan: BRANCH_PLAN,
        branchNamed: null,
      });
    }
  });

  it('a child in care beside another question: still nothing said', () => {
    expect(
      pgate({ intent: 'hours', intents: ['hours', 'drop_off_care'], grounding: ['fact.hours.central'], bubbles: ['Open 10:00–20:00'] }),
    ).toMatchObject({
      action: 'silent_handover',
      reason: 'SILENCE_POLICY',
      // the part that made it silent, which a number's silence policy is keyed by
      intent: 'drop_off_care',
      intents: ['hours', 'drop_off_care'],
      plan: BRANCH_PLAN,
    });
  });
});

describe('D. lost and found, unclear, spam', () => {
  it('lost and found: a silent hand-over to the branch (the engine decides by the number whether its line goes)', () => {
    expect(pgate({ intent: 'lost_item', action: 'handover', bubbles: ['We found a blue jacket!'] })).toMatchObject({
      action: 'silent_handover',
      reason: 'SILENCE_POLICY',
      plan: BRANCH_PLAN,
    });
    expect(pgate({ language: 'other', intent: 'lost_item', action: 'handover', bubbles: [] })).toMatchObject({
      action: 'silent_handover',
      language: 'en',
    });
  });

  it('unclear or not covered: the team-member line, to the branch when known, else the GM', () => {
    for (const intent of ['emotional_or_unclear', 'custom_request'] as const) {
      expect(pgate({ intent, action: 'handover', bubbles: [] })).toMatchObject({ action: 'handover', plan: UNCLEAR_GM_PLAN });
      expect(pgate({ intent, action: 'handover', bubbles: [] }, { threadHasBranch: true })).toMatchObject({ plan: UNCLEAR_BRANCH_PLAN });
      expect(pgate({ intent, action: 'handover', bubbles: [], branchNamed: 'central' })).toMatchObject({ plan: UNCLEAR_BRANCH_PLAN });
    }
  });

  it('the model handing over a question the table answers goes the same way', () => {
    expect(pgate({ intent: 'hours', action: 'handover', bubbles: [] })).toMatchObject({
      action: 'handover',
      reason: 'MODEL_HANDOVER',
      plan: UNCLEAR_GM_PLAN,
    });
  });

  it('spam stays silent', () => {
    expect(pgate({ intent: 'other', bubbles: ['Click here'] })).toMatchObject({ action: 'silent', reason: 'INTENT_SILENT' });
  });
});

describe('D. lead lines are checked against no source at all', () => {
  const leadIntents = AI_INTENTS.filter((i) => {
    const r = INTENT_TABLE[i];
    return r.action === 'handover' && r.lead;
  });

  it('the intents with a lead line are the playbook\'s', () => {
    expect([...leadIntents].sort()).toEqual(
      ['complaint_online', 'complaint_onsite', 'events_groups', 'job_request', 'photography_question', 'special_tickets_buy'].sort(),
    );
  });

  it.each(leadIntents)('%s: a lead with a number, a link or a busy word is dropped', (intent: AiIntent) => {
    for (const bad of ['See you at 10:00!', 'Details: otoplay.co/jobs', "It's busy today but we'll help!"]) {
      const v = applyGates({
        decision: decision({ intent, action: 'handover', bubbles: [bad] }),
        grounding: playbookKnowledge().grounding,
        episode: episode(),
      });
      expect(v.action, `${intent}: ${bad}`).toBe('handover');
    }
  });

  it('two bubbles are not a lead line: the closing line goes alone', () => {
    expect(pgate({ intent: 'job_request', action: 'handover', bubbles: ["We're always looking for great people!", 'Send your CV!'] })).toMatchObject({
      action: 'handover',
      plan: GM_PLAN,
    });
  });
});
