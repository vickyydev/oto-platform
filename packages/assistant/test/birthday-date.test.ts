import { describe, expect, it } from 'vitest';
import { AI_OUTCOME_REASONS, type AiDecision } from '../src/decision';
import { BIRTHDAY_DATE_RULE, applyGates, birthdayDateOverrule, namesPartyDayOrTime, type EpisodeState } from '../src/gate';
import { BIRTHDAY_DATE_OVERRULED, BIRTHDAYS_PLAN, BRANCH_PLAN, birthdayThreadOf } from '../src/intents';
import { BIRTHDAY_THREAD_LINES, STATIC_SYSTEM_TEXT, buildPrompt } from '../src/prompt';
import { PLAYBOOK_LINES } from '../src/persona';
import { context, decision, episode, fixtureKnowledge, NOW } from './support';

/**
 * SCRUM-817 (staging, 10 November, during the SCRUM-814 proof): in a
 * Birthdays & Events conversation on the simulator the family wrote "Можно в
 * субботу в 2 часа дня?" (can we do Saturday at 2 pm?) and the assistant read
 * it as a general question — "бронировать не нужно" and the opening hours, as
 * if they asked about a plain visit. In a birthday thread a day, a date or a
 * time is the party's: two layers, so a wrong label cannot reach the family.
 *
 *   1. The prompt tells the model the conversation's category and, on a
 *      birthday thread, that such a message is the party's.
 *   2. The gate overrules a walk-in label (hours, faq, greeting, address) on
 *      such a message to birthday_details: the Birthday & events team and
 *      the birthday manager's closing line, the model's words dropped.
 *
 * A thread that is not a birthday one is untouched.
 */

const knowledge = fixtureKnowledge();

const RU = 'Можно в субботу в 2 часа дня?';
const TH = 'เสาร์นี้บ่ายสองได้ไหมคะ';
const EN = 'Can we do Saturday at 2 pm?';

/** The walk-in answer the model gave on staging, per language: grounded, so a general thread would send it. */
const HOURS_ANSWER: Record<'ru' | 'th' | 'en', Partial<AiDecision>> = {
  ru: {
    language: 'ru',
    intent: 'hours',
    grounding: ['fact.hours.central'],
    bubbles: ['Мы открыты каждый день 10:00–20:00, бронировать не нужно 😊'],
    reason: 'FACT_IN_KB',
  },
  th: {
    language: 'th',
    intent: 'hours',
    grounding: ['fact.hours.central'],
    bubbles: ['เปิดทุกวัน 10:00–20:00 น. ค่ะ ไม่ต้องจองล่วงหน้านะคะ 😊'],
    reason: 'FACT_IN_KB',
  },
  en: {
    language: 'en',
    intent: 'hours',
    grounding: ['fact.hours.central'],
    bubbles: ["We're open every day 10:00–20:00, no booking needed 😊"],
    reason: 'FACT_IN_KB',
  },
};

const BIRTHDAYS: Partial<EpisodeState> = { threadCategory: 'birthdays', earlierIntents: [] };
const GENERAL: Partial<EpisodeState> = { threadCategory: 'general', earlierIntents: [] };

const gate = (d: Partial<AiDecision>, e: Partial<EpisodeState>, lines: readonly string[]) =>
  applyGates({ decision: decision(d), grounding: knowledge.grounding, episode: episode(e), openLines: lines });

/** The verdict the overrule makes: the birthday hand-over, the model's words never sent, and why. */
const BIRTHDAY_HANDOVER = {
  action: 'handover',
  reason: 'OVERRULED_BIRTHDAY',
  intent: 'birthday_details',
  plan: BIRTHDAYS_PLAN,
  holdingBubbles: [],
  droppedHoldingRule: BIRTHDAY_DATE_RULE,
} as const;

describe('SCRUM-817: the gate reads a birthday thread’s date as the party’s', () => {
  it('the rule’s pieces: the four walk-in labels, the reason word, the shared date and time reader', () => {
    expect([...BIRTHDAY_DATE_OVERRULED].sort()).toEqual(['address', 'faq', 'greeting', 'hours']);
    expect(AI_OUTCOME_REASONS).toContain('OVERRULED_BIRTHDAY');
    expect(birthdayThreadOf({ threadCategory: 'birthdays' })).toBe('category');
    expect(birthdayThreadOf({ threadCategory: 'general', earlierIntents: ['birthday_party'] })).toBe('earlier');
    expect(birthdayThreadOf({ threadCategory: 'general', earlierIntents: ['hours', 'socks'] })).toBeNull();
    expect(birthdayThreadOf({})).toBeNull();
    for (const line of [RU, TH, EN]) expect(namesPartyDayOrTime([line]), line).toBe(true);
    for (const line of ['What time do you open?', 'Здравствуйте', 'Do we need to book?', 'Где вы находитесь?']) {
      expect(namesPartyDayOrTime([line]), line).toBe(false);
    }
  });

  it.each([
    ['ru', RU],
    ['th', TH],
    ['en', EN],
  ] as const)('%s, in a Birthdays & Events thread: the hours label becomes birthday_details, to the birthday team', (lang, line) => {
    const v = gate(HOURS_ANSWER[lang], BIRTHDAYS, [line]);
    expect(v).toMatchObject({ ...BIRTHDAY_HANDOVER, intents: ['birthday_details'], language: lang });
  });

  it.each([
    ['ru', RU],
    ['th', TH],
    ['en', EN],
  ] as const)('%s, the same words in a general thread: the model’s label stands and the answer goes', (lang, line) => {
    const v = gate(HOURS_ANSWER[lang], GENERAL, [line]);
    expect(v).toMatchObject({ action: 'answer', reason: 'OK', intent: 'hours', bubbles: HOURS_ANSWER[lang].bubbles });
    // A thread whose category the caller does not give is a general one too.
    expect(gate(HOURS_ANSWER[lang], {}, [line])).toMatchObject({ action: 'answer', intent: 'hours' });
  });

  it('a general thread whose earlier reply this episode was a birthday one is a birthday thread', () => {
    const v = gate(HOURS_ANSWER.ru, { threadCategory: 'general', earlierIntents: ['greeting', 'birthday_party'] }, [RU]);
    expect(v).toMatchObject(BIRTHDAY_HANDOVER);
    // Earlier replies of other kinds do not make it one.
    expect(gate(HOURS_ANSWER.ru, { threadCategory: 'general', earlierIntents: ['greeting', 'ticket_prices'] }, [RU])).toMatchObject({
      action: 'answer',
      intent: 'hours',
    });
  });

  it('faq, greeting and address are overruled the same way; the staging reply ("бронировать не нужно") never goes', () => {
    const faq = gate(
      { language: 'ru', intent: 'faq', grounding: ['faq.food-outside'], bubbles: ['Бронировать не нужно, приходите 😊'], reason: 'FACT_IN_KB' },
      BIRTHDAYS,
      [RU],
    );
    expect(faq).toMatchObject(BIRTHDAY_HANDOVER);
    expect(gate({ intent: 'greeting' }, BIRTHDAYS, [`Hi! ${EN}`])).toMatchObject(BIRTHDAY_HANDOVER);
    expect(
      gate({ intent: 'address', grounding: ['fact.address.central'], bubbles: ['We are at Central Floresta, 2nd floor, Phuket (fixture)'] }, BIRTHDAYS, [EN]),
    ).toMatchObject(BIRTHDAY_HANDOVER);
  });

  it('never silence: an unsure or silent model on the party’s date still reaches the birthday team', () => {
    expect(gate({ ...HOURS_ANSWER.ru, certainty: 'unsure' }, BIRTHDAYS, [RU])).toMatchObject(BIRTHDAY_HANDOVER);
    expect(gate({ ...HOURS_ANSWER.ru, action: 'silent', bubbles: [] }, BIRTHDAYS, [RU])).toMatchObject(BIRTHDAY_HANDOVER);
  });

  it('a walk-in label beside an answerable part: the whole turn is the birthday hand-over, none of the mixed words go', () => {
    const v = gate(
      {
        intent: 'hours',
        intents: ['hours', 'ticket_prices'],
        grounding: ['fact.hours.central', 'fact.prices.central'],
        bubbles: ["We're open every day 10:00–20:00, no booking needed 😊", 'Kids are ฿350 on weekdays.'],
      },
      BIRTHDAYS,
      [`${EN} And how much is it for kids?`],
    );
    expect(v).toMatchObject({ ...BIRTHDAY_HANDOVER, intents: ['birthday_details', 'ticket_prices'] });
  });

  it('the model already read the party: its birthday flow stands (the one combined question is answered)', () => {
    const ask = "Amazing, thank you! We'd love to organize a party for you. Roughly how many people, and which branch, Central Floresta or Robinson Chalong?";
    const v = gate({ language: 'en', intent: 'birthday_party', bubbles: [ask], reason: 'CLEAR_INTENT' }, BIRTHDAYS, [EN]);
    expect(v).toMatchObject({ action: 'answer', reason: 'OK', intent: 'birthday_party', bubbles: [ask] });
    // Beside a walk-in part the model also read, the date is the birthday part's: nothing is overruled.
    expect(birthdayDateOverrule({ decision: decision({ intent: 'birthday_party', intents: ['birthday_party', 'hours'] }), grounding: knowledge.grounding, episode: episode(BIRTHDAYS), openLines: [EN] })).toBeNull();
  });

  it('a birthday thread message that names no day, date or time keeps the model’s label', () => {
    const hours = gate(HOURS_ANSWER.en, BIRTHDAYS, ['What time do you open?']);
    expect(hours).toMatchObject({ action: 'answer', intent: 'hours' });
    expect(gate({}, BIRTHDAYS, ['Hi!'])).toMatchObject({ action: 'answer', intent: 'greeting' });
  });

  it('only the four walk-in labels are overruled: a price question on the party’s date keeps its own label', () => {
    const v = gate(
      { intent: 'ticket_prices', grounding: ['fact.prices.central'], bubbles: ['Kids are ฿350 on weekdays and ฿450 on weekends.'] },
      BIRTHDAYS,
      ['How much is it on Saturday?'],
    );
    expect(v).toMatchObject({ action: 'answer', intent: 'ticket_prices' });
  });

  it('a part that outranks the party keeps its own verdict: a child in our care is still the silent hand-over', () => {
    const v = gate({ intent: 'hours', intents: ['hours', 'drop_off_care'], grounding: ['fact.hours.central'] }, BIRTHDAYS, [
      `${EN} And how is my son doing?`,
    ]);
    expect(v).toMatchObject({ action: 'silent_handover', intent: 'drop_off_care', plan: BRANCH_PLAN });
  });

  it('without the open lines the rule never fires (a caller that does not pass them gates as before)', () => {
    const v = applyGates({ decision: decision(HOURS_ANSWER.ru), grounding: knowledge.grounding, episode: episode(BIRTHDAYS) });
    expect(v).toMatchObject({ action: 'answer', intent: 'hours' });
  });
});

describe('SCRUM-817: the prompt tells the model the conversation’s category', () => {
  const at = new Date(NOW.getTime() - 60_000);
  const userTurn = (ctx: Parameters<typeof context>[0], text = RU) => {
    const built = buildPrompt({ knowledge, episode: [{ from: 'customer', at, text }], context: context(ctx) });
    if (!built.ok) throw new Error(built.reason);
    return built.prompt;
  };

  it('a Birthdays & Events thread: its category in the context line, and that a day, a date or a time is the party’s', () => {
    const plain = userTurn({});
    const p = userTurn({ threadCategory: 'birthdays', earlierIntents: [] });
    // Blocks 1 and 2 are the plain prompt's: the persona and its cache are untouched.
    expect(p.system).toEqual(plain.system);
    expect(p.system[0].text).toBe(STATIC_SYSTEM_TEXT);
    const user = p.messages[0].content;
    expect(user).toContain('"threadCategory":"birthdays"');
    expect(user).toContain(`${BIRTHDAY_THREAD_LINES.category} ${BIRTHDAY_THREAD_LINES.rule}`);
    // The line rides after the conversation, outside its data.
    expect(user.indexOf('</conversation>')).toBeLessThan(user.indexOf(BIRTHDAY_THREAD_LINES.category));
    expect(user.trimEnd().endsWith('Decide this turn.')).toBe(true);
  });

  it('the line names the party, never the hours, and leaves the birthday flow to the playbook lines', () => {
    const rule = BIRTHDAY_THREAD_LINES.rule;
    for (const example of [RU, TH, EN]) expect(rule).toContain(example);
    expect(rule).toContain('never the park\'s opening hours');
    expect(rule).toContain('birthday_details');
    expect(rule).toContain('birthday_party');
    expect(rule).toContain('"no booking needed"');
    // The playbook's own birthday lines are block 1's, word for word.
    expect(STATIC_SYSTEM_TEXT).toContain(PLAYBOOK_LINES);
    expect(PLAYBOOK_LINES).toContain('birthday_details (the basics are in, after your question or all at once)');
  });

  it('a general thread whose earlier reply was a birthday one is told so', () => {
    const user = userTurn({ threadCategory: 'general', earlierIntents: ['birthday_party'] }).messages[0].content;
    expect(user).toContain('"threadCategory":"general"');
    expect(user).toContain(`${BIRTHDAY_THREAD_LINES.earlier} ${BIRTHDAY_THREAD_LINES.rule}`);
    expect(user).not.toContain(BIRTHDAY_THREAD_LINES.category);
  });

  it('a general thread is told its category and nothing else; a caller that gives none builds the prompt it built before', () => {
    const general = userTurn({ threadCategory: 'general', earlierIntents: ['hours'] }).messages[0].content;
    expect(general).toContain('"threadCategory":"general"');
    expect(general).not.toContain(BIRTHDAY_THREAD_LINES.rule);
    const before = userTurn({}).messages[0].content;
    expect(before).not.toContain('threadCategory');
    expect(before).not.toContain(BIRTHDAY_THREAD_LINES.rule);
    expect(general.replace(',"threadCategory":"general"', '')).toBe(before);
  });
});
