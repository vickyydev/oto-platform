/**
 * Fixtures for the A1 checks. FICTIONAL TEST DATA: the KB rows, prices and
 * hours below are written for these tests only; marketing's real entries
 * replace them on staging (PLAN §F.4).
 */

import type { AiDecision } from '../src/decision';
import {
  buildKnowledge,
  type BranchFacts,
  type KbEntryInput,
  type KnowledgeInput,
  type TurnContext,
} from '../src/prompt';
import type { EpisodeState } from '../src/gate';

/** A string no real message contains; it must never surface where it should not. */
export const SENTINEL = 'ZZ-SENTINEL-7f3c-a1a';

export const FIXTURE_BRANCHES: BranchFacts[] = [
  {
    key: 'central',
    name: 'Central Floresta',
    address: 'Central Floresta, 2nd floor, Phuket (fixture)',
    openingHours: {
      mon: { open: '10:00', close: '20:00' },
      tue: { open: '10:00', close: '20:00' },
      wed: { open: '10:00', close: '20:00' },
      thu: { open: '10:00', close: '20:00' },
      fri: { open: '10:00', close: '20:00' },
      sat: { open: '10:00', close: '20:00' },
      sun: { open: '10:00', close: '20:00' },
    },
    packages: [
      {
        name: 'Play pass',
        kidWeekday: 35_000,
        kidWeekend: 45_000,
        adultWeekday: 15_000,
        adultWeekend: 15_000,
        includedAdults: 1,
        overflowAdult: 15_000,
      },
    ],
  },
  {
    key: 'chalong',
    name: 'Chalong',
    address: 'Chalong, Chao Fa West Road (fixture)',
    openingHours: null,
    packages: [
      {
        name: 'Play pass',
        kidWeekday: 30_000,
        kidWeekend: 39_000,
        adultWeekday: 12_000,
        adultWeekend: 12_000,
        includedAdults: 1,
        overflowAdult: 12_000,
      },
    ],
  },
];

export const FIXTURE_KB: KbEntryInput[] = [
  {
    key: 'socks',
    topic: 'socks',
    language: 'en',
    branch: null,
    question: 'Do we need socks?',
    body: 'Yes, everyone on the play floor wears grip socks. You can buy them at reception.',
    needsTranslation: false,
  },
  {
    key: 'socks',
    topic: 'socks',
    language: 'ru',
    branch: null,
    question: 'Нужны ли носки?',
    body: 'Да, на игровой площадке все в нескользящих носках. Их можно купить на ресепшене.',
    needsTranslation: false,
  },
  {
    key: 'age-rules',
    topic: 'age_rules',
    language: 'en',
    branch: null,
    question: 'Is there an age limit?',
    body: 'The park is for children up to 12. Children under 1 enter free with a paying adult.',
    needsTranslation: false,
  },
  {
    key: 'age-rules',
    topic: 'age_rules',
    language: 'th',
    branch: null,
    question: 'มีจำกัดอายุไหม',
    body: 'สวนสนุกสำหรับเด็กอายุไม่เกิน 12 ปี เด็กอายุต่ำกว่า 1 ปี เข้าฟรีเมื่อมากับผู้ใหญ่ที่ซื้อบัตร',
    needsTranslation: false,
  },
  {
    key: 'age-rules',
    topic: 'age_rules',
    language: 'ru',
    branch: null,
    question: 'Есть ли ограничение по возрасту?',
    body: 'Парк для детей до 12 лет. Дети до 1 года проходят бесплатно со взрослым с билетом.',
    needsTranslation: false,
  },
  {
    key: 'parking',
    topic: 'parking',
    language: 'en',
    branch: 'central',
    question: 'Where do I park?',
    body: 'Park in the mall car park, level 3 is closest to us.',
    needsTranslation: false,
  },
  {
    key: 'faq.food-outside',
    topic: 'faq',
    language: 'en',
    branch: null,
    question: 'Can we bring food?',
    body: 'Outside food is not allowed; our cafe serves meals and snacks.',
    needsTranslation: false,
  },
  {
    key: 'faq.food-outside',
    topic: 'faq',
    language: 'th',
    branch: null,
    question: 'นำอาหารเข้ามาได้ไหม',
    body: 'Outside food is not allowed; our cafe serves meals and snacks.',
    needsTranslation: true,
  },
];

export const FIXTURE_KNOWLEDGE_INPUT: KnowledgeInput = {
  kb: FIXTURE_KB,
  branches: FIXTURE_BRANCHES,
  examples: [],
};

export const fixtureKnowledge = () => buildKnowledge(FIXTURE_KNOWLEDGE_INPUT);

export const NOW = new Date('2026-10-20T07:00:00.000Z'); // 14:00 Bangkok, a Tuesday

export function context(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    now: NOW,
    threadBranch: null,
    priceModeToday: { central: 'weekday', chalong: 'weekday' },
    earlier: { answered: 0, brochureSent: false, branchAsked: false, identityAnswered: false },
    ...overrides,
  };
}

export function episode(overrides: Partial<EpisodeState> = {}): EpisodeState {
  return {
    aiAnswers: 0,
    aiAnswersLast10Min: 0,
    identityAnswered: false,
    threadHasBranch: false,
    ...overrides,
  };
}

export function decision(overrides: Partial<AiDecision> = {}): AiDecision {
  return {
    language: 'en',
    intent: 'greeting',
    certainty: 'sure',
    action: 'answer',
    grounding: [],
    bubbles: ['Hi! 👋 Welcome to OTO Play Park, how can we help?'],
    sendBrochure: false,
    branchNamed: null,
    askBranch: false,
    reason: 'GREETING_ONLY',
    ...overrides,
  };
}
