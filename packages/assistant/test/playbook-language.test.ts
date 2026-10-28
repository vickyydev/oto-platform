import { describe, expect, it } from 'vitest';
import { languageOfferIn } from '../src/guards';
import { EN_PERSONA, LANGUAGE_RULE, PROHIBITIONS } from '../src/persona';
import { buildPrompt, STATIC_SYSTEM_TEXT } from '../src/prompt';
import { pgate, playbookKnowledge } from './playbook-support';
import { context, NOW } from './support';

/**
 * SCRUM-220, Tom's playbook — "Languages": English, Russian and Thai only;
 * any other language is answered in ENGLISH (no longer silence); the one
 * language offer, made once and early, to a Russian (+7) or Thai (+66)
 * number writing in English. Everyone else keeps the no-language-menu rule.
 */

describe('C. a language other than th/en/ru is answered in English', () => {
  it('a German question answered in English is an answer, in English', () => {
    expect(
      pgate({ language: 'other', intent: 'socks', grounding: ['socks'], bubbles: ['Yes, grip socks please, you can buy them at reception 😊'] }),
    ).toMatchObject({ action: 'answer', reason: 'OK', language: 'en' });
  });

  it('a greeting in another language gets the English one-liner', () => {
    expect(pgate({ language: 'other', bubbles: ['Hi! How can I help you?'] })).toMatchObject({ action: 'answer', language: 'en' });
  });

  it('a hand-over in another language hands over in English (the English closing line)', () => {
    expect(pgate({ language: 'other', intent: 'refund_request', action: 'handover', bubbles: [] })).toMatchObject({
      action: 'handover',
      language: 'en',
      plan: { templateKey: 'closing_gm', route: 'gm' },
    });
  });

  it('bubbles written in a non-Latin script under "other" are refused: the reply must be English', () => {
    expect(pgate({ language: 'other', intent: 'socks', grounding: ['socks'], bubbles: ['需要防滑袜 😊'] })).toMatchObject({
      action: 'silent',
      reason: 'LANGUAGE',
      rule: 'not_english',
    });
    expect(pgate({ language: 'other', intent: 'socks', grounding: ['socks'], bubbles: ['Да, нужны носки.'] })).toMatchObject({
      action: 'silent',
      reason: 'LANGUAGE',
    });
  });

  it('the prompt says so: other → English', () => {
    expect(STATIC_SYSTEM_TEXT).toContain(LANGUAGE_RULE);
    expect(LANGUAGE_RULE).toMatch(/Any other language[^.]*English/);
    expect(STATIC_SYSTEM_TEXT).not.toContain('anything else, another language, or no text');
  });
});

describe('C. the one language offer: +7 or +66 writing in English, once, early', () => {
  const offerRu = EN_PERSONA.languageOffer.ru;
  const offerTh = EN_PERSONA.languageOffer.th;

  it("the playbook's words", () => {
    expect(offerRu).toBe('Would you like to continue in English or Russian?');
    expect(offerTh).toBe('Would you like to continue in English or Thai?');
  });

  it('a +7 number writing in English may be offered Russian, and the verdict says the offer was made', () => {
    expect(
      pgate({ language: 'en', bubbles: [`Hi! ${offerRu}`] }, { contactCountryCode: '7', aiAnswers: 0 }),
    ).toMatchObject({ action: 'answer', languageOffer: 'ru' });
  });

  it('a +66 number writing in English may be offered Thai', () => {
    expect(
      pgate({ language: 'en', bubbles: [`Hi! ${offerTh}`] }, { contactCountryCode: '66', aiAnswers: 1 }),
    ).toMatchObject({ action: 'answer', languageOffer: 'th' });
  });

  it('every other case keeps the no-language-menu rule (GUARD_LANGUAGE)', () => {
    const refused = { action: 'silent', reason: 'GUARD_LANGUAGE', rule: 'language_menu' };
    // no country code, another country, the wrong language for the code
    expect(pgate({ bubbles: [`Hi! ${offerRu}`] })).toMatchObject(refused);
    expect(pgate({ bubbles: [`Hi! ${offerRu}`] }, { contactCountryCode: '44' })).toMatchObject(refused);
    expect(pgate({ bubbles: [`Hi! ${offerTh}`] }, { contactCountryCode: '7' })).toMatchObject(refused);
    // once: the offer was already made this episode
    expect(pgate({ bubbles: [`Hi! ${offerRu}`] }, { contactCountryCode: '7', languageOffered: true })).toMatchObject(refused);
    // early: not from the third reply on
    expect(pgate({ bubbles: [`Hi! ${offerRu}`] }, { contactCountryCode: '7', aiAnswers: 2 })).toMatchObject(refused);
    // the customer did not write in English
    expect(pgate({ language: 'ru', bubbles: ['Would you like to continue in English or Russian?'] }, { contactCountryCode: '7' })).toMatchObject(refused);
    // a general language menu is never allowed
    expect(pgate({ bubbles: ['Which language do you prefer? 😊'] }, { contactCountryCode: '7' })).toMatchObject(refused);
  });

  it('an ordinary answer carries no offer', () => {
    expect(pgate({ intent: 'socks', grounding: ['socks'], bubbles: ['Grip socks please 😊'] }, { contactCountryCode: '7' })).toMatchObject({
      action: 'answer',
      languageOffer: null,
    });
  });

  it('the detector reads the offer and a menu, and nothing else', () => {
    expect(languageOfferIn([offerRu])).toBe('ru');
    expect(languageOfferIn([offerTh])).toBe('th');
    expect(languageOfferIn(['Shall we chat in Russian or English?'])).toBe('ru');
    expect(languageOfferIn(['What language would you prefer?'])).toBe('menu');
    expect(languageOfferIn(['สะดวกคุยภาษาอะไรคะ'])).toBe('menu');
    expect(languageOfferIn(['На каком языке вам удобнее?'])).toBe('menu');
    expect(languageOfferIn(['Thai families get special prices!', 'We open 10:00–20:00 😊'])).toBeNull();
  });

  it('the prohibition keeps the menu rule for everyone except the one offer', () => {
    const rule = PROHIBITIONS.find((p) => p.id === 'no_language_menu')!;
    expect(rule.text).toMatch(/Never ask the customer to choose a language/);
    expect(rule.text).toMatch(/except/);
    expect(LANGUAGE_RULE).toContain('"7"');
    expect(LANGUAGE_RULE).toContain('"66"');
    expect(LANGUAGE_RULE).toContain('languageOffered');
    expect(LANGUAGE_RULE).toContain(offerRu);
  });

  it('the turn carries the contact’s calling code and whether the offer was made, below the cache breakpoint', () => {
    const built = buildPrompt({
      knowledge: playbookKnowledge(),
      episode: [{ from: 'customer', at: NOW, text: 'hello' }],
      context: context({
        contactCountryCode: '7',
        earlier: { answered: 1, brochureSent: false, branchAsked: false, identityAnswered: false, languageOffered: true },
      }),
    });
    if (!built.ok) throw new Error(built.reason);
    const user = built.prompt.messages[0].content;
    expect(user).toContain('"contactCountryCode":"7"');
    expect(user).toContain('"languageOffered":true');
    for (const block of built.prompt.system) expect(block.text).not.toContain('"contactCountryCode":"7"');
  });

  it('no country code renders as null', () => {
    const built = buildPrompt({ knowledge: playbookKnowledge(), episode: [], context: context() });
    if (!built.ok) throw new Error(built.reason);
    expect(built.prompt.messages[0].content).toContain('"contactCountryCode":null');
  });
});
