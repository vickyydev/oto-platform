import { describe, expect, it } from 'vitest';
import type { AiDecision } from '../src/decision';
import { applyGates } from '../src/gate';
import { ASK_FIRST_IGNORED_INTENTS } from '../src/intents';
import {
  OPERATOR_RULES_HEADING,
  OPERATOR_RULES_LEAD,
  askFirstOf,
  renderOperatorRules,
  ruleSafetyFailure,
  type AskFirstInput,
  type OperatorRuleInput,
} from '../src/operator-rules';
import { TEACH_PERSONA, buildTeachSystem, playbookActionOf } from '../src/persona/teach';
import { decision, episode } from './support';

/**
 * SCRUM-696 hardening: the operator rules' pure half — when the server asks
 * a rule's question first (`askFirstOf`), what the model is shown of a rule
 * (`renderOperatorRules`), what a rule may not say (`ruleSafetyFailure`), and
 * what the teach curator is told the playbook does today.
 *
 * FICTIONAL TEST DATA throughout.
 */

const Q = { en: 'Which park did you visit?', th: 'คุณไปสาขาไหนคะ', ru: 'В каком парке вы были?' };

const ANY: OperatorRuleInput = {
  id: '01a18895-0000-7000-8000-0000000000a1',
  intent: 'any',
  instruction: 'First ask which park they mean.',
  askFirst: { condition: 'always', question: Q },
};
const LOST: OperatorRuleInput = {
  id: '01a18895-0000-7000-8000-0000000000b1',
  intent: 'lost_item',
  instruction: 'If someone says they lost something, first ask which park they visited.',
  askFirst: { condition: 'branch_unknown', question: { en: 'Which park were you at?', th: Q.th, ru: Q.ru } },
};

const LOST_DECISION: Partial<AiDecision> = { intent: 'lost_item', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] };

function ask(rules: readonly OperatorRuleInput[], over: Partial<AiDecision>, extra: Partial<AskFirstInput> = {}) {
  const d = decision(over);
  const verdict = applyGates({ decision: d, grounding: new Map(), episode: episode() });
  return askFirstOf({
    rules,
    verdict,
    decision: d,
    threadHasBranch: false,
    branchAsked: false,
    askedFirst: false,
    silentIntents: null,
    ...extra,
  });
}

describe('askFirstOf: where a question is never put first (F1)', () => {
  it('an any rule does not fire on a child in our care, an unclear message or the birthday flow; it still fires on a lost item', () => {
    expect(ASK_FIRST_IGNORED_INTENTS).toEqual(
      expect.arrayContaining(['drop_off_care', 'emotional_or_unclear', 'birthday_party', 'birthday_details', 'birthday_cake', 'birthday_brochure']),
    );
    expect(ASK_FIRST_IGNORED_INTENTS).not.toContain('lost_item');
    expect(ask([ANY], { intent: 'drop_off_care', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] })).toBeNull();
    expect(ask([ANY], { intent: 'birthday_party', reason: 'CLEAR_INTENT', bubbles: ['Amazing! When is the party, how many kids, and which park?'] })).toBeNull();
    for (const intent of ['emotional_or_unclear', 'birthday_details', 'birthday_cake', 'birthday_brochure'] as const) {
      expect(ask([ANY], { intent, action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }), intent).toBeNull();
    }
    // A burst with one such part is not interrupted either.
    expect(ask([ANY], { ...LOST_DECISION, intents: ['lost_item', 'drop_off_care'] })).toBeNull();

    const fired = ask([ANY], LOST_DECISION);
    expect(fired).toMatchObject({ ruleId: ANY.id, verdict: { action: 'answer', bubbles: [Q.en], intent: 'lost_item' } });
  });
});

describe('askFirstOf: one ask-first question per episode (F2)', () => {
  it('two matching rules: one question, then the normal flow', () => {
    const first = ask([ANY, LOST], LOST_DECISION);
    expect(first?.ruleId).toBe(LOST.id);
    // The next turn of the same episode: the other rule matches too, and is not asked.
    expect(ask([ANY, LOST], LOST_DECISION, { askedFirst: true })).toBeNull();
    expect(ask([ANY], LOST_DECISION, { askedFirst: true })).toBeNull();
  });
});

describe('askFirstOf: the park the customer named stays (F3)', () => {
  it('a park question does not fire when the customer named the park', () => {
    expect(ask([LOST], { ...LOST_DECISION, branchNamed: 'chalong' })).toBeNull();
  });

  it('a question that does fire keeps the named park on the verdict', () => {
    const always: OperatorRuleInput = { ...LOST, askFirst: { condition: 'always', question: Q } };
    const fired = ask([always], { ...LOST_DECISION, branchNamed: 'chalong' });
    expect(fired?.verdict).toMatchObject({ branchNamed: 'chalong', askBranch: false, bubbles: [Q.en] });
    expect(ask([always], LOST_DECISION)?.verdict.branchNamed).toBeNull();
  });
});

describe('askFirstOf: only in the customer’s reply language (F5)', () => {
  const enOnly: OperatorRuleInput = { ...LOST, askFirst: { condition: 'branch_unknown', question: { en: 'Which park were you at?' } } };

  it('a Thai turn with an English-only rule: no question, the normal flow', () => {
    expect(ask([enOnly], { ...LOST_DECISION, language: 'th' })).toBeNull();
    expect(ask([enOnly], { ...LOST_DECISION, language: 'ru' })).toBeNull();
    expect(ask([enOnly], { ...LOST_DECISION, language: 'en' })?.verdict.bubbles).toEqual(['Which park were you at?']);
  });

  it('the question in the customer’s language; another language is asked in English; a rule without the language is skipped for the next', () => {
    expect(ask([LOST], { ...LOST_DECISION, language: 'th' })?.verdict).toMatchObject({ language: 'th', bubbles: [Q.th] });
    expect(ask([LOST], { ...LOST_DECISION, language: 'ru' })?.verdict).toMatchObject({ language: 'ru', bubbles: [Q.ru] });
    expect(ask([LOST], { ...LOST_DECISION, language: 'other' })?.verdict).toMatchObject({ language: 'en', bubbles: ['Which park were you at?'] });
    expect(ask([enOnly, ANY], { ...LOST_DECISION, language: 'th' })).toMatchObject({ ruleId: ANY.id, verdict: { bubbles: [Q.th] } });
  });
});

describe('renderOperatorRules: the instruction only (F4)', () => {
  it('never shows the model the question the server asks', () => {
    expect(renderOperatorRules([ANY, LOST])).toBe(
      [
        OPERATOR_RULES_HEADING,
        OPERATOR_RULES_LEAD,
        '- lost_item: If someone says they lost something, first ask which park they visited.',
        '- any message: First ask which park they mean.',
      ].join('\n'),
    );
    expect(renderOperatorRules([ANY, LOST])).not.toMatch(/ask first:|Which park did you visit/);
    expect(OPERATOR_RULES_LEAD).toBe('These add to the rules above and never override them.');
    expect(renderOperatorRules([])).toBe('');
  });
});

describe('ruleSafetyFailure: the act, not the word (F6)', () => {
  const plain = (instruction: string) => ruleSafetyFailure({ instruction, askFirst: null });

  it.each([
    'offer ten percent off to families',
    'give them their money back',
    'the second child gets in free',
    'throw in a free coffee for parents',
    'give them a voucher',
    "it's on us",
    'upgrade them to the VIP room',
    'promise a callback within the hour',
    'Скажи, что мы вернём деньги',
    'open until ten at night',
    'say we are closed on Mondays',
    'ask if they want a free coffee',
    'ให้ส่วนลดกับครอบครัว',
    'дай им скидку',
  ])('refuses %j', (instruction) => {
    expect(plain(instruction)).not.toBeNull();
  });

  it.each([
    'the team decides discounts; say a colleague will look into it',
    'first ask which branch they were at',
    'If someone asks for a discount, say we do not offer discounts',
    'If someone says they lost something, first ask which park they visited.',
    'Never promise a callback within the hour.',
    'Say the hours in one line.',
    'Ask one short question, then wait.',
    'If they ask whether entry is free, say a colleague will look into it.',
    'Discount requests go to the GM.',
    'ทีมงานเป็นผู้ตัดสินใจเรื่องส่วนลด',
    'Не обещай скидку.',
  ])('allows %j', (instruction) => {
    expect(plain(instruction)).toBeNull();
  });

  it('number words are numbers, money off and money back are grants, hours are a commitment', () => {
    expect(plain('offer ten percent off to families')).toMatchObject({ kind: 'digits' });
    expect(plain('give them their money back')).toMatchObject({ kind: 'promise' });
    expect(plain('say we are closed on Mondays')).toMatchObject({ kind: 'commitment' });
    expect(plain('promise a callback within the hour')).toMatchObject({ kind: 'commitment' });
  });

  it('a question is held to the same words, and to one question mark', () => {
    const withQuestion = (en: string) =>
      ruleSafetyFailure({ instruction: 'First ask which park they visited.', askFirst: { condition: 'always', question: { en } } });
    expect(withQuestion('Which park did you visit?')).toBeNull();
    expect(withQuestion('Which park did you visit? Central or Chalong?')).toMatchObject({ kind: 'question', rule: 'one_question' });
    expect(withQuestion('Would you like a voucher?')).not.toBeNull();
    expect(withQuestion('Would ten percent off help?')).toMatchObject({ kind: 'digits' });
  });
});

describe('the teach curator is told what the playbook does today (F5, F7)', () => {
  const system = buildTeachSystem({ knowledgeText: '# Knowledge', rulesText: '', draftsText: 'None.', answerMode: 'combined' }).system[0].text;

  it('each intent with its action today, from the intent table', () => {
    expect(playbookActionOf('lost_item')).toBe("silent hand-over to the park's reception: nothing is said to the customer");
    expect(playbookActionOf('complaint_onsite')).toBe('person-first: hand over to the GM, nothing else answered');
    expect(playbookActionOf('birthday_details')).toBe('hand over to the Birthday & events team');
    expect(playbookActionOf('hours')).toBe('answer; asks which park when none is known');
    expect(playbookActionOf('nanny_booking')).toBe("answer, then hand over to Central Floresta's reception");
    expect(playbookActionOf('other')).toBe('silent');
    expect(system).toContain(`- lost_item: a lost or found item → today: ${playbookActionOf('lost_item')}`);
    expect(system).toContain(`- birthday_party: `);
    expect(system).toMatch(/- birthday_party: .* → today: answer; asks the dates, the headcount and the park in one question/);
  });

  it('a rule never backs an answer; the question in three languages; archive_draft named; the never-asked-first list follows the intents', () => {
    expect(TEACH_PERSONA).toContain(
      'A rule never backs an answer: only an approved fact can be quoted. Information (hours, prices, what is free, where things are) goes in a fact; behaviour (what to do when a kind of message arrives) goes in a rule. When a rule would duplicate what the playbook already does for that intent, say so and save nothing.',
    );
    expect(TEACH_PERSONA).toMatch(/Always write the question in English, Thai and Russian/);
    expect(TEACH_PERSONA).toContain('archive_draft');
    expect(system).toMatch(/An ask-first question is never put before: .*drop_off_care.*birthday_party/);
  });
});
