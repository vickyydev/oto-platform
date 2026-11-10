import { describe, expect, it } from 'vitest';
import { adviceOpenerOn } from '../src/advice';
import {
  PARK_QUESTION,
  PART_JOIN,
  asksOnlyThePark,
  composeMessage,
  composeTurn,
  dependsOnPark,
  guessesOnePark,
  parkTopicsOf,
  parksDiffer,
  sameSentence,
  sentencesOf,
} from '../src/compose';
import type { AiDecision } from '../src/decision';
import { applyGates, type EpisodeQuestion, type EpisodeState, type GateInput, type GateVerdict } from '../src/gate';
import { BIRTHDAYS_PLAN, GM_PLAN, OWN_PARK_QUESTION_INTENTS, PARK_FIRST_INTENTS, topicsOfIntents } from '../src/intents';
import { EN_PERSONA, RU_PERSONA, TH_PERSONA } from '../src/persona';
import { buildKnowledge, type BranchFacts, type KbEntryInput, type OpeningHours } from '../src/prompt';
import { askedSlotsOf, readSlotAnswers } from '../src/slots';
import { decision, episode } from './support';

/**
 * SCRUM-832 (owner, 10 Nov 2026, APPROVED: "the two bubbles for Central say
 * the same thing on the same topic, so it should be one combined message in
 * one bubble"). The owner's case, on staging: in a general thread with no
 * park, "How to find you guys?" got both parks' locations (bubble 1) and
 * "which park?" (bubble 2); "Central" then got the walking directions, the
 * thread's park was set, and a second bubble repeated the location and added
 * the parking.
 *
 *   1. ONE MESSAGE PER TURN: the parts of an answer on one topic are one
 *      bubble; an answer on several topics keeps a bubble per part; the
 *      closing or hand-over line the playbook keeps separate follows on its
 *      own. Nothing a part says is lost: a sentence said again is dropped
 *      only between parts, never with a number, never a row of a list.
 *   2. PARK FIRST: on the owner's pattern (the model asked which park beside
 *      a park-dependent answer, or answered for one park nobody named), the
 *      park question ALONE, recorded for the memory (slot park), unless the
 *      family named the park this episode; "Central" is read as the answer.
 *      An overview of both parks that asks nothing goes as written; a burst
 *      with another question keeps every answer.
 *   3. NO REPETITION: once the family gave the park, what was said about the
 *      park while it was being resolved is not said again, unless they ask
 *      about it again.
 *
 * THE EXPECTATION is the reply the owner saved through "Correct the
 * assistant" on staging (10 Nov 2026, 08:44 UTC, intent directions_parking,
 * customer text "Central"), word for word. The Thai and Russian expectations
 * are that reply translated for these tests (the owner saved English only).
 * The knowledge mirrors staging's playbook entries (pb.address-central,
 * pb.directions-*, pb.parking, pb.hours), written here as FICTIONAL TEST DATA.
 */

/** The owner's saved reply ("Correct the assistant", 10 Nov 2026), as saved. */
const OWNER_SAVED_REPLY =
  "Easy! We're on the basement floor of Central Floresta, opposite the aquarium. It's the side with the luxury brands, not Festival. Please follow the signs for the Aquarium or Oto. Parking is free by the way.";

/** The model's reply to "Central" in two bubbles, each a part of the saved reply; and in Thai and Russian. */
const CENTRAL_REPLY: Record<'en' | 'th' | 'ru', [string, string]> = {
  en: [
    "Easy! We're on the basement floor of Central Floresta, opposite the aquarium. It's the side with the luxury brands, not Festival.",
    'Please follow the signs for the Aquarium or Oto. Parking is free by the way.',
  ],
  th: [
    'ง่ายมากค่ะ! เราอยู่ชั้นใต้ดินของ Central Floresta ตรงข้ามอควาเรียมค่ะ ฝั่งที่มีแบรนด์หรู ไม่ใช่ฝั่ง Festival นะคะ',
    'เดินตามป้าย Aquarium หรือ Oto ได้เลยค่ะ จอดรถฟรีด้วยนะคะ',
  ],
  ru: [
    'Легко! Мы на цокольном этаже Central Floresta, напротив океанариума. Это сторона с люксовыми брендами, не Festival.',
    'Идите по указателям Aquarium или Oto. Парковка, кстати, бесплатная.',
  ],
};

/** The first turn as staging sent it: both parks' locations, then the park question, in two bubbles. */
const BOTH_PARKS: Record<'en' | 'th' | 'ru', [string, string]> = {
  en: [
    "Hi! We've got two parks in Phuket 😊 One is at Central Floresta on the basement floor, opposite the aquarium, and the other is at Robinson Chalong on the 3rd floor, opposite the cinema.",
    EN_PERSONA.branchQuestion,
  ],
  th: [
    'สวัสดีค่ะ 😊 เรามีสองสาขาค่ะ Central Floresta อยู่ชั้นใต้ดิน ตรงข้ามอควาเรียม และ Robinson Chalong อยู่ชั้น 3 ตรงข้ามโรงภาพยนตร์ค่ะ',
    TH_PERSONA.branchQuestion,
  ],
  ru: [
    'Здравствуйте! У нас два парка на Пхукете 😊 Central Floresta на цокольном этаже, напротив океанариума, и Robinson Chalong на 3-м этаже, напротив кинотеатра.',
    RU_PERSONA.branchQuestion,
  ],
};

/** What each family writes, in the three languages: the question, then the park. */
const ASKS = { en: 'How to find you guys?', th: 'ไปทางไหนคะ หาไม่เจอค่ะ', ru: 'Как вас найти?' } as const;
const SAYS_CENTRAL = { en: 'Central', th: 'เซ็นทรัลค่ะ', ru: 'Централ' } as const;

const EVERY_DAY = (open: string, close: string): OpeningHours => ({
  mon: { open, close },
  tue: { open, close },
  wed: { open, close },
  thu: { open, close },
  fri: { open, close },
  sat: { open, close },
  sun: { open, close },
});

const parks = (chalongClose = '20:00'): BranchFacts[] => [
  { key: 'central', name: 'Central Floresta', address: 'Central Floresta, basement floor, Phuket (fixture)', openingHours: EVERY_DAY('10:00', '20:00'), packages: [] },
  { key: 'chalong', name: 'Robinson Chalong', address: 'Robinson Chalong, 3rd floor, Phuket (fixture)', openingHours: EVERY_DAY('10:00', chalongClose), packages: [] },
];

const row = (key: string, topic: KbEntryInput['topic'], language: 'en' | 'th' | 'ru', question: string, body: string): KbEntryInput => ({
  key,
  topic,
  language,
  branch: null,
  question,
  body,
  needsTranslation: false,
});

/** Staging's playbook entries for the parks, as staging keeps them: both-parks rows named for one park. */
const PARK_KB: KbEntryInput[] = [
  row('pb.address-central', 'address_note', 'en', 'Where is Central Floresta?', 'We are at Central Floresta (the side of Central with the luxury brands, not Festival), on the basement floor, opposite the aquarium.'),
  row('pb.address-central', 'address_note', 'th', 'Central Floresta อยู่ที่ไหน', 'เราอยู่ที่ Central Floresta ฝั่งที่มีแบรนด์หรู ไม่ใช่ฝั่ง Festival ชั้นใต้ดิน ตรงข้ามอควาเรียมค่ะ'),
  row('pb.address-central', 'address_note', 'ru', 'Где Central Floresta?', 'Мы в Central Floresta (сторона с люксовыми брендами, не Festival), на цокольном этаже, напротив океанариума.'),
  row('pb.address-chalong', 'address_note', 'en', 'Where is Robinson Chalong?', 'We are in Robinson Chalong on the 3rd floor, opposite the cinema.'),
  row('pb.address-chalong', 'address_note', 'th', 'Robinson Chalong อยู่ที่ไหน', 'เราอยู่ที่ Robinson Chalong ชั้น 3 ตรงข้ามโรงภาพยนตร์ค่ะ'),
  row('pb.address-chalong', 'address_note', 'ru', 'Где Robinson Chalong?', 'Мы в Robinson Chalong на 3-м этаже, напротив кинотеатра.'),
  row('pb.directions-central', 'directions', 'en', 'How do I find you at Central?', 'From the ground floor with Tops, take the escalator down toward the aquarium and follow the signs for the Aquarium or Oto.'),
  row('pb.directions-chalong', 'directions', 'en', 'How do I find you at Chalong?', 'Take the escalator up, then the second escalator by the food court to the 3rd floor, opposite the cinema.'),
  row('pb.parking', 'parking', 'en', 'Is there parking?', 'Parking is free at both malls.'),
  row('pb.parking', 'parking', 'th', 'มีที่จอดรถไหม', 'จอดรถฟรีที่ห้างทั้งสองแห่งค่ะ'),
  row('pb.parking', 'parking', 'ru', 'Есть парковка?', 'Парковка бесплатная в обоих торговых центрах.'),
  row('pb.hours', 'hours_note', 'en', 'When are you open?', 'Both branches are open 10:00 to 20:00, 7 days a week.'),
  row('pb.cafe', 'faq', 'en', 'Do you have a café?', 'Yes, we have a café with meals and snacks at both parks.'),
  row('pb.socks', 'socks', 'en', 'Do we need socks?', 'Grip socks are required on the play floor for kids and adults; you can buy them at reception.'),
];

const sameHours = buildKnowledge({ kb: PARK_KB, branches: parks(), examples: [] });
/** Robinson Chalong closes an hour later: the parks' hours differ. */
const otherHours = buildKnowledge({ kb: PARK_KB.filter((e) => e.key !== 'pb.hours'), branches: parks('21:00'), examples: [] });

const GENERAL: Partial<EpisodeState> = { threadCategory: 'general', earlierIntents: [] };
const BIRTHDAYS: Partial<EpisodeState> = { threadCategory: 'birthdays', earlierIntents: [] };
const TODAY = '2026-11-10';

const gate = (d: Partial<AiDecision>, e: Partial<EpisodeState>, lines: readonly string[], knowledge = sameHours): GateVerdict =>
  applyGates({ decision: decision(d), grounding: knowledge.grounding, episode: episode(e), openLines: lines });

const answer = (v: GateVerdict) => {
  if (v.action !== 'answer') throw new Error(`expected an answer, got ${v.action} ${v.reason}`);
  return v;
};

type Answer = Extract<GateVerdict, { action: 'answer' }>;

/** An answer verdict as the gate passes it to `composeTurn`, for the composition alone (no guard runs here). */
const verdict = (o: Partial<Answer>): Answer => ({
  action: 'answer',
  reason: 'OK',
  intent: 'faq',
  intents: ['faq'],
  language: 'en',
  bubbles: [],
  groundingKeys: [],
  sendBrochure: false,
  askBranch: false,
  branchNamed: null,
  thenHandover: null,
  mayAutoHandle: false,
  languageOffer: null,
  ...o,
});

const compose = (v: Answer, e: Partial<EpisodeState> = GENERAL, lines: readonly string[] = [], d: Partial<AiDecision> = {}) =>
  answer(composeTurn(v, { decision: decision(d), grounding: sameHours.grounding, episode: episode(e), openLines: lines }));

/** One space between words: the one message read as the owner's one paragraph. */
const oneParagraph = (s: string) => s.replace(/\s+/gu, ' ').trim();

/** The memory after the family's reply to the park question (SCRUM-831's reader, as the engine reads it). */
function parkAnswered(reply: string): EpisodeQuestion[] {
  const read = readSlotAnswers(['park'], reply, TODAY);
  return [{ slot: 'park', state: 'park' in read ? 'answered' : 'open', answer: read.park ?? null }];
}

describe('SCRUM-832: the owner’s case — park first, then one message with the directions and the parking', () => {
  for (const lang of ['en', 'th', 'ru'] as const) {
    it(`${lang}: "${ASKS[lang]}" with no park is the park question ALONE, recorded for the memory`, () => {
      const v = answer(
        gate(
          {
            language: lang,
            intent: 'directions_parking',
            grounding: ['pb.address-central', 'pb.address-chalong'],
            bubbles: BOTH_PARKS[lang],
            askBranch: true,
            askedSlots: ['park'],
            reason: 'FACT_IN_KB',
          },
          GENERAL,
          [ASKS[lang]],
        ),
      );
      expect(v.bubbles).toEqual([PARK_QUESTION[lang]]);
      expect(v).toMatchObject({ intent: 'directions_parking', askBranch: true, askedSlots: ['park'], thenHandover: null, mayAutoHandle: false, branchNamed: null });
      expect(v.composition).toEqual({ parkFirst: true, bubbles: 2, joined: true, duplicates: 0, repeats: 0, parkQuestions: 0 });
      // The memory records the slot from the line itself too.
      expect(askedSlotsOf(v.askedSlots, v.bubbles)).toEqual(['park']);
    });

    it(`${lang}: "${SAYS_CENTRAL[lang]}" is the answer; the next reply is ONE bubble with the directions and the parking, once`, () => {
      const questions = parkAnswered(SAYS_CENTRAL[lang]);
      expect(questions[0]).toMatchObject({ state: 'answered', answer: 'central' });
      const episodeAfter: Partial<EpisodeState> = {
        ...GENERAL,
        aiAnswers: 1,
        aiAnswersLast10Min: 1,
        questions,
        parkAnsweredNow: true,
        parkLines: [PARK_QUESTION[lang]],
      };
      const reply = {
        language: lang,
        intent: 'directions_parking' as const,
        grounding: ['pb.address-central', 'pb.directions-central', 'pb.parking'],
        bubbles: CENTRAL_REPLY[lang],
        reason: 'FACT_IN_KB' as const,
      };
      const v = answer(gate({ ...reply, branchNamed: 'central' }, episodeAfter, [SAYS_CENTRAL[lang]]));
      expect(v.bubbles).toEqual([CENTRAL_REPLY[lang].join(PART_JOIN)]);
      // The parts ride with the one message, for the coherence review to read one by one.
      expect(v.parts).toEqual(CENTRAL_REPLY[lang]);
      expect(v).toMatchObject({ branchNamed: 'central', askBranch: false, thenHandover: null });
      if (lang === 'en') expect(oneParagraph(v.bubbles[0]!)).toBe(OWNER_SAVED_REPLY);
      // The model left the park unnamed: the memory's answer is read, so the thread's park is still set.
      const unnamed = answer(gate({ ...reply, branchNamed: null }, episodeAfter, [SAYS_CENTRAL[lang]]));
      expect(unnamed).toMatchObject({ branchNamed: 'central', bubbles: v.bubbles });
    });
  }

  it('the location said twice inside the reply is said once: the saved reply exactly', () => {
    const v = answer(
      gate(
        {
          intent: 'directions_parking',
          grounding: ['pb.address-central', 'pb.directions-central', 'pb.parking'],
          bubbles: [
            CENTRAL_REPLY.en[0],
            "Please follow the signs for the Aquarium or Oto. We're on the basement floor of Central Floresta, opposite the aquarium. Parking is free by the way.",
          ],
          branchNamed: 'central',
          reason: 'FACT_IN_KB',
        },
        { ...GENERAL, questions: parkAnswered('Central'), parkAnsweredNow: true },
        ['Central'],
      ),
    );
    expect(v.bubbles).toHaveLength(1);
    expect(oneParagraph(v.bubbles[0]!)).toBe(OWNER_SAVED_REPLY);
    expect(v.composition).toMatchObject({ parkFirst: false, bubbles: 2, joined: true, duplicates: 1 });
  });

  it('staging’s own second turn after its first: the repeated location is dropped, the directions and the parking stay', () => {
    const staging = [
      'Easy! From the ground floor with Tops supermarket, walk to the other side of Tops and take the escalator down toward the aquarium. Just follow the signs for Oto or the aquarium 😊',
      "We're on the basement floor of Central Floresta, opposite the aquarium. It's the side with the luxury brands, not Festival. And parking is free!",
    ];
    const v = answer(
      gate(
        { intent: 'directions_parking', grounding: ['pb.address-central', 'pb.directions-central', 'pb.parking'], bubbles: staging, branchNamed: 'central', reason: 'FACT_IN_KB' },
        { ...GENERAL, aiAnswers: 1, aiAnswersLast10Min: 1, questions: parkAnswered('Central'), parkAnsweredNow: true, parkLines: BOTH_PARKS.en },
        ['Central'],
      ),
    );
    expect(v.bubbles).toEqual([`${staging[0]}${PART_JOIN}It's the side with the luxury brands, not Festival. And parking is free!`]);
    expect(v.composition).toMatchObject({ repeats: 1 });
    expect(v.bubbles[0]!.match(/parking/giu)).toHaveLength(1);
  });
});

describe('SCRUM-832: park first, only on the owner’s pattern', () => {
  it('a message naming the park is answered at once, in one bubble, and the park is set', () => {
    for (const [lang, line] of [
      ['en', 'How do we find you at Central Floresta?'],
      ['th', 'ไปสาขาเซ็นทรัลยังไงคะ'],
      ['ru', 'Как вас найти в Централ Флоресте?'],
    ] as const) {
      // The model may not have named it: the customer's own words do.
      const v = answer(
        gate(
          { language: lang, intent: 'directions_parking', grounding: ['pb.address-central', 'pb.directions-central', 'pb.parking'], bubbles: CENTRAL_REPLY[lang], reason: 'FACT_IN_KB' },
          GENERAL,
          [line],
        ),
      );
      expect(v.bubbles, line).toEqual([CENTRAL_REPLY[lang].join(PART_JOIN)]);
      expect(v.askBranch, line).toBe(false);
      expect(v.branchNamed, line).toBe('central');
    }
  });

  it('an overview of both parks that asks nothing goes as written: where are your branches, a branch in Patong, the closest to Kata', () => {
    const overview = BOTH_PARKS.en[0];
    for (const line of ['Where are your branches?', 'Do you have a branch in Patong?', 'Which of your parks is closest to Kata?']) {
      const v = answer(gate({ intent: 'address', grounding: ['pb.address-central', 'pb.address-chalong'], bubbles: [overview], reason: 'FACT_IN_KB' }, GENERAL, [line]));
      expect(v.bubbles, line).toEqual([overview]);
      expect(v.askBranch, line).toBe(false);
      expect(v.askedSlots, line).toBeUndefined();
      expect(v.composition, line).toBeUndefined();
    }
    // Two bubbles of an overview: one message, nothing asked.
    const two = answer(
      gate(
        { intent: 'address', grounding: ['pb.address-central', 'pb.address-chalong'], bubbles: [overview, 'Robinson Chalong is the closer one to Kata 😊'], reason: 'FACT_IN_KB' },
        GENERAL,
        ['Which of your parks is closest to Kata?'],
      ),
    );
    expect(two.bubbles).toEqual([`${overview}${PART_JOIN}Robinson Chalong is the closer one to Kata 😊`]);
  });

  it('"Which one is closer to Patong?" after the park question: answered, and the park question is never asked here again', () => {
    const waiting: Partial<EpisodeState> = { ...GENERAL, aiAnswers: 1, aiAnswersLast10Min: 1, questions: [{ slot: 'park', state: 'open', answer: null }] };
    const comparison = 'Central Floresta is the closer one to Patong 😊';
    const v = answer(gate({ intent: 'address', grounding: ['pb.address-central', 'pb.address-chalong'], bubbles: [comparison], reason: 'FACT_IN_KB' }, waiting, ['Which one is closer to Patong?']));
    expect(v.bubbles).toEqual([comparison]);
    // The model asks again beside it: its own reply goes, the comparison kept (the repeat guard counts the asks).
    const again = answer(
      gate(
        { intent: 'address', grounding: ['pb.address-central', 'pb.address-chalong'], bubbles: [comparison, EN_PERSONA.branchQuestion], askBranch: true, askedSlots: ['park'], reason: 'FACT_IN_KB' },
        waiting,
        ['Which one is closer to Patong?'],
      ),
    );
    expect(again.bubbles).toEqual([`${comparison}${PART_JOIN}${EN_PERSONA.branchQuestion}`]);
    expect(again.composition?.parkFirst).toBe(false);
  });

  it('hours with no park: answered at once when both parks keep the same hours; the park question when they differ and the model asks', () => {
    const same = answer(
      gate({ intent: 'hours', grounding: ['fact.hours.central', 'fact.hours.chalong'], bubbles: ["We're open every day 10:00–20:00 at both parks 😊"], reason: 'FACT_IN_KB' }, GENERAL, ['What time do you open?']),
    );
    expect(same.bubbles).toEqual(["We're open every day 10:00–20:00 at both parks 😊"]);
    expect(parksDiffer('hours', sameHours.grounding)).toBe(false);
    expect(parksDiffer('hours', otherHours.grounding)).toBe(true);

    // Both parks' hours told, nothing asked: an overview, as written.
    const both = 'Central Floresta is open 10:00–20:00 and Robinson Chalong 10:00–21:00 😊';
    const overview = answer(gate({ intent: 'hours', grounding: ['fact.hours.central', 'fact.hours.chalong'], bubbles: [both], reason: 'FACT_IN_KB' }, GENERAL, ['What time do you close?'], otherHours));
    expect(overview.bubbles).toEqual([both]);
    // The model asks which park beside them: the park question alone.
    const asked = gate(
      { intent: 'hours', grounding: ['fact.hours.central', 'fact.hours.chalong'], bubbles: [both, EN_PERSONA.branchQuestion], askBranch: true, reason: 'FACT_IN_KB' },
      GENERAL,
      ['What time do you close?'],
      otherHours,
    );
    expect(asked).toMatchObject({ bubbles: [PARK_QUESTION.en], askBranch: true, askedSlots: ['park'] });
    // The same question, the park named: Robinson Chalong's hours at once.
    const named = answer(
      gate(
        { intent: 'hours', grounding: ['fact.hours.chalong'], bubbles: ['Robinson Chalong is open every day 10:00–21:00 😊'], branchNamed: 'chalong', reason: 'FACT_IN_KB' },
        GENERAL,
        ['What time does Robinson close?'],
        otherHours,
      ),
    );
    expect(named.bubbles).toEqual(['Robinson Chalong is open every day 10:00–21:00 😊']);
  });

  it('parking, free at both malls, is answered at once; a guess at one park nobody named is the park question', () => {
    const parking = answer(gate({ intent: 'directions_parking', grounding: ['pb.parking'], bubbles: ['Yes! Parking is free at both malls 😊'], reason: 'FACT_IN_KB' }, GENERAL, ['Is there parking?']));
    expect(parking.bubbles).toEqual(['Yes! Parking is free at both malls 😊']);
    expect(dependsOnPark({ intents: ['directions_parking'], groundingKeys: ['pb.parking'] }, sameHours.grounding)).toBe(false);
    expect(dependsOnPark({ intents: ['address'], groundingKeys: ['fact.address.central', 'fact.address.chalong'] }, sameHours.grounding)).toBe(true);
    expect(dependsOnPark({ intents: ['directions_parking'], groundingKeys: ['pb.directions-central'] }, sameHours.grounding)).toBe(true);
    expect(guessesOnePark({ groundingKeys: ['pb.directions-central', 'pb.parking'] }, sameHours.grounding)).toBe(true);
    expect(guessesOnePark({ groundingKeys: ['pb.address-central', 'pb.address-chalong'] }, sameHours.grounding)).toBe(false);
    expect(guessesOnePark({ groundingKeys: ['pb.parking'] }, sameHours.grounding)).toBe(false);
    // A guess at one park, the family having named none: the question.
    const guess = gate({ intent: 'directions_parking', grounding: ['pb.directions-central'], bubbles: ['Take the escalator down toward the aquarium 😊'], reason: 'FACT_IN_KB' }, GENERAL, ['Where are you?']);
    expect(guess).toMatchObject({ action: 'answer', bubbles: [PARK_QUESTION.en], askedSlots: ['park'] });
  });

  it('a park the family named in an earlier message is never asked: the answer for that park, and the thread’s park set', () => {
    const chalong = ['We are in Robinson Chalong on the 3rd floor, opposite the cinema.', 'Take the escalator up, then the second escalator by the food court to the 3rd floor.'];
    const earlier: Partial<EpisodeState> = { ...GENERAL, aiAnswers: 1, aiAnswersLast10Min: 1, customerLines: ['Is Robinson Chalong open on Sundays?', 'How do we find you?'] };
    const v = answer(gate({ intent: 'directions_parking', grounding: ['pb.address-chalong', 'pb.directions-chalong'], bubbles: chalong, reason: 'FACT_IN_KB' }, earlier, ['How do we find you?']));
    expect(v.bubbles).toEqual([chalong.join(PART_JOIN)]);
    expect(v).toMatchObject({ branchNamed: 'chalong', askBranch: false });
    expect(v.askedSlots).toBeUndefined();
    // The model asks which park beside it all the same: the park is known, so the question goes and the answer stays.
    const asked = answer(
      gate(
        { intent: 'directions_parking', grounding: ['pb.address-chalong', 'pb.directions-chalong'], bubbles: [...chalong, EN_PERSONA.branchQuestion], askBranch: true, askedSlots: ['park'], reason: 'FACT_IN_KB' },
        earlier,
        ['How do we find you?'],
      ),
    );
    expect(asked).toMatchObject({ bubbles: [chalong.join(PART_JOIN)], branchNamed: 'chalong', askBranch: false, askedSlots: [] });
    // The same burst with no earlier message naming a park: a guess at Chalong, so the question.
    expect(gate({ intent: 'directions_parking', grounding: ['pb.address-chalong', 'pb.directions-chalong'], bubbles: chalong, reason: 'FACT_IN_KB' }, GENERAL, ['How do we find you?'])).toMatchObject({
      bubbles: [PARK_QUESTION.en],
    });
  });

  it('never: a thread with a park, a park already answered, both parks named, a birthday, the price question, a hand-over to follow', () => {
    const where = { intent: 'directions_parking' as const, grounding: ['pb.address-central', 'pb.address-chalong'], bubbles: BOTH_PARKS.en, askBranch: true, reason: 'FACT_IN_KB' as const };
    const message = [BOTH_PARKS.en.join(PART_JOIN)];
    // The park is known: the reply goes, its park question dropped.
    expect(gate(where, { ...GENERAL, threadHasBranch: true }, ['How to find you?'])).toMatchObject({ bubbles: [BOTH_PARKS.en[0]], askBranch: false });
    expect(gate(where, { ...GENERAL, questions: parkAnswered('Central') }, ['How to find you?'])).toMatchObject({ bubbles: [BOTH_PARKS.en[0]] });
    // Both parks named: a choice, answered as written.
    expect(gate(where, GENERAL, ['Which is closer to Kata, Central or Chalong?'])).toMatchObject({ bubbles: message });
    // A birthday thread asks the park in its own combined question.
    expect(gate(where, { threadCategory: 'birthdays', earlierIntents: [] }, ['How to find you?'])).toMatchObject({ bubbles: message });
    expect(gate(where, { ...GENERAL, earlierIntents: ['birthday_party'] }, ['How to find you?'])).toMatchObject({ bubbles: message });
    // The price conversation asks the branch and the residency together, before the prices (the playbook): two topics, a bubble each.
    const price = gate(
      { ...where, intent: 'directions_parking', intents: ['directions_parking', 'ticket_prices'], grounding: ['pb.address-central', 'pb.address-chalong', 'fact.prices.central'], bubbles: [BOTH_PARKS.en[0], EN_PERSONA.branchResidencyQuestion] },
      GENERAL,
      ['Where are you and how much is it?'],
    );
    expect(price).toMatchObject({ action: 'answer', bubbles: [BOTH_PARKS.en[0], EN_PERSONA.branchResidencyQuestion] });
    // A colleague takes over after the answer: the colleague asks; two topics, a bubble each.
    const job = answer(
      gate({ ...where, intents: ['directions_parking', 'job_request'], bubbles: [BOTH_PARKS.en[0], "We're always looking for great people!"] }, GENERAL, ['Where are you? Also, are you hiring?']),
    );
    expect(job).toMatchObject({ thenHandover: GM_PLAN, bubbles: [BOTH_PARKS.en[0], "We're always looking for great people!"] });
    expect(job.askedSlots).toBeUndefined();
  });

  it('the intents it reads, and the flows it leaves to their own question', () => {
    expect([...PARK_FIRST_INTENTS].sort()).toEqual(['address', 'directions_parking', 'hours']);
    expect(OWN_PARK_QUESTION_INTENTS.has('ticket_prices')).toBe(true);
    expect(OWN_PARK_QUESTION_INTENTS.has('birthday_party')).toBe(true);
    for (const i of OWN_PARK_QUESTION_INTENTS) expect(PARK_FIRST_INTENTS.has(i)).toBe(false);
    expect(PARK_QUESTION).toEqual({ en: EN_PERSONA.branchQuestion, th: TH_PERSONA.branchQuestion, ru: RU_PERSONA.branchQuestion });
    for (const q of Object.values(PARK_QUESTION)) {
      expect(askedSlotsOf([], [q])).toEqual(['park']);
      expect(asksOnlyThePark(q)).toBe(true);
    }
    // The birthday's combined question asks more than the park: never dropped as the park question.
    expect(asksOnlyThePark('What date are you thinking of, roughly how many people, and which branch, Central Floresta or Robinson Chalong?')).toBe(false);
  });
});

describe('SCRUM-832: a burst with another question keeps every answer', () => {
  const where = { grounding: ['pb.address-central', 'pb.address-chalong'], askBranch: true, askedSlots: ['park'] as AiDecision['askedSlots'], reason: 'FACT_IN_KB' as const };
  const cases: Array<{ line: string; intents: AiDecision['intents']; key: string; bubble: string }> = [
    { line: 'Do you have a café? And where are you?', intents: ['faq', 'directions_parking'], key: 'pb.cafe', bubble: 'Yes, we have a café with meals and snacks at both parks 😊' },
    { line: 'Do we need socks? where are you located', intents: ['socks', 'address'], key: 'pb.socks', bubble: 'Yes, grip socks are required on the play floor, and you can buy them at reception 😊' },
    { line: 'Where are you? And do we need socks?', intents: ['address', 'socks'], key: 'pb.socks', bubble: 'Yes, grip socks are required on the play floor, and you can buy them at reception 😊' },
  ];

  for (const c of cases) {
    it(`"${c.line}" in a general thread with no park: the other answer stays, beside the model’s own park question`, () => {
      const bubbles = c.intents![0] === 'address' ? [BOTH_PARKS.en[0], c.bubble, EN_PERSONA.branchQuestion] : [c.bubble, BOTH_PARKS.en[0], EN_PERSONA.branchQuestion];
      const v = answer(gate({ ...where, intent: c.intents![0]!, intents: c.intents, grounding: [...where.grounding, c.key], bubbles }, GENERAL, [c.line]));
      // Several topics: a bubble per part, every answer, the park asked by the model's own words.
      expect(v.bubbles).toEqual(bubbles);
      expect(v.bubbles).toContain(c.bubble);
      expect(v).toMatchObject({ askBranch: true });
      expect(v.composition).toBeUndefined();
    });
  }
});

describe('SCRUM-832: one message per turn — on one topic', () => {
  it('a reply on several topics keeps a bubble per part (test night W2); one topic is one message; a greeting is no topic', () => {
    expect(topicsOfIntents(['directions_parking', 'faq'])).toEqual(['where', 'faq']);
    expect(topicsOfIntents(['address', 'directions_parking'])).toEqual(['where']);
    expect(topicsOfIntents(['greeting', 'socks'])).toEqual(['socks']);
    expect(topicsOfIntents(['greeting'])).toEqual(['greeting']);
    expect(topicsOfIntents(['birthday_party', 'birthday_advice'])).toEqual(['birthday']);
    const parts = ['Parking is free at both malls 😊', 'Outside food isn’t allowed, but our café has meals and snacks.'];
    expect(compose(verdict({ intent: 'directions_parking', intents: ['directions_parking', 'faq'], bubbles: parts })).bubbles).toEqual(parts);
    const one = compose(verdict({ intent: 'directions_parking', intents: ['greeting', 'directions_parking'], bubbles: ['Hi there! 😊', parts[0]!] }));
    expect(one.bubbles).toEqual([`Hi there! 😊${PART_JOIN}${parts[0]}`]);
    expect(one.composition).toMatchObject({ joined: true, bubbles: 2 });
  });

  it('a complaint’s apology stays one bubble, the GM’s closing line follows on its own', () => {
    const v = answer(gate({ intent: 'complaint_onsite', action: 'handover', bubbles: ["We're so sorry to hear about your visit today."], reason: 'NEEDS_PERSON' }, GENERAL, ['Your staff were rude.']));
    expect(v).toMatchObject({ bubbles: ["We're so sorry to hear about your visit today."], thenHandover: GM_PLAN });
    expect(v.composition).toBeUndefined();
  });

  it('answer parts and the birthday opener are one bubble each turn; a single bubble is returned as it was', () => {
    const opener = answer(
      gate(
        { intent: 'birthday_party', bubbles: ["Amazing, thank you! We'd love to organize a party for your son 🎈", 'What date are you thinking of, roughly how many people, and which branch, Central Floresta or Robinson Chalong?'] },
        GENERAL,
        ['We want a birthday party for our son'],
      ),
    );
    expect(opener.bubbles).toHaveLength(1);
    expect(opener.bubbles[0]).toContain(`🎈${PART_JOIN}What date`);
    const single = decision({ intent: 'greeting', bubbles: ['Hi! How can I help you? 😊'] });
    const v = applyGates({ decision: single, grounding: sameHours.grounding, episode: episode(GENERAL) });
    expect(answer(v).bubbles).toEqual(['Hi! How can I help you? 😊']);
    expect(answer(v).composition).toBeUndefined();
  });
});

describe('SCRUM-832: a hand-over passes as it is — SCRUM-823’s opener is the turn’s one message', () => {
  const C2 = 'We would like to book a birthday party for our son. Which package would you recommend?';
  const c2: Partial<AiDecision> = { intent: 'birthday_advice', intents: ['birthday_advice', 'birthday_party'], action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] };

  for (const [what, e] of [
    ['a Birthdays & Events thread', BIRTHDAYS],
    ['a general thread with no park', GENERAL],
  ] as const) {
    it(`C2 (a party and advice) in ${what}: the real adviceOpenerOn marks the hand-over, and composeTurn leaves it untouched`, () => {
      const input: GateInput = { decision: decision(c2), grounding: sameHours.grounding, episode: episode(e), openLines: [C2] };
      const v = applyGates(input);
      expect(v).toMatchObject({ action: 'handover', plan: BIRTHDAYS_PLAN, adviceOpener: 'full', holdingBubbles: [] });
      expect(v.intents).toContain('birthday_advice');
      // The opener's one message is the template's (the engine's), never a bubble of the verdict: nothing to compose.
      expect(composeTurn(v, input)).toBe(v);
      // The gate's own order: the opener read on the gated verdict, then the turn composed.
      const read = adviceOpenerOn(v, input);
      expect(composeTurn(read, input)).toBe(read);
    });
  }

  it('a hand-over with no words of its own is left as it is', () => {
    const handover = gate({ intent: 'birthday_details', action: 'handover', bubbles: [], reason: 'NEEDS_PERSON' }, GENERAL, ['14 November, 12 kids']);
    expect(handover).toMatchObject({ action: 'handover', holdingBubbles: [] });
    const withWords: GateVerdict = { ...(handover as Extract<GateVerdict, { action: 'handover' }>), holdingBubbles: ['one message'] };
    expect(composeTurn(withWords, { decision: decision({}), grounding: sameHours.grounding, episode: episode(GENERAL) })).toBe(withWords);
  });
});

describe('SCRUM-832: the park question asked once — a park the model asks for while it is known is dropped', () => {
  const directions = [CENTRAL_REPLY.en[0], EN_PERSONA.branchQuestion];
  const asking = { intent: 'directions_parking' as const, grounding: ['pb.address-central', 'pb.directions-central'], bubbles: directions, askBranch: true, askedSlots: ['park'] as AiDecision['askedSlots'], reason: 'FACT_IN_KB' as const };

  it('"How do we find you at Central?" (the park read): the directions go, the park question does not', () => {
    const v = answer(gate({ ...asking, branchNamed: 'central' }, GENERAL, ['How do we find you at Central?']));
    expect(v.bubbles).toEqual([CENTRAL_REPLY.en[0]]);
    expect(v).toMatchObject({ askBranch: false, askedSlots: [], branchNamed: 'central' });
    expect(v.composition).toMatchObject({ parkQuestions: 1 });
    expect(askedSlotsOf(v.askedSlots, v.bubbles)).toEqual([]);
  });

  it('a thread with its park: the same', () => {
    const v = answer(gate(asking, { ...GENERAL, threadHasBranch: true }, ['How do we find you?']));
    expect(v.bubbles).toEqual([CENTRAL_REPLY.en[0]]);
    expect(v).toMatchObject({ askBranch: false, askedSlots: [] });
  });

  it('the birthday’s and the price conversation’s own one question are never cut, the park known or not', () => {
    // The Russian combined question: the slot reader sees only the park in it, yet it asks how many guests too.
    const ru = 'Как здорово, спасибо! Будем рады организовать праздник. Сколько примерно будет гостей и в каком парке, Central Floresta или Robinson Chalong?';
    const party = compose(verdict({ intent: 'birthday_party', intents: ['birthday_party'], language: 'ru', bubbles: [ru] }), { ...BIRTHDAYS, threadHasBranch: true });
    expect(party.bubbles).toEqual([ru]);
    const price = compose(
      verdict({ intent: 'ticket_prices', intents: ['ticket_prices'], bubbles: [EN_PERSONA.branchResidencyQuestion] }),
      { ...GENERAL, threadHasBranch: true },
    );
    expect(price.bubbles).toEqual([EN_PERSONA.branchResidencyQuestion]);
  });

  it('only the question: the model’s answer goes as written, never an empty message', () => {
    const v = answer(gate({ ...asking, bubbles: [EN_PERSONA.branchQuestion] }, { ...GENERAL, threadHasBranch: true }, ['How do we find you?']));
    expect(v.bubbles).toEqual([EN_PERSONA.branchQuestion]);
  });

  it('a part of several lines keeps its line breaks when the question is cut out of it', () => {
    const part = 'Take the escalator down toward the aquarium.\nParking is free at both malls. Which branch are you thinking of, Central Floresta or Robinson Chalong?';
    const v = compose(verdict({ intent: 'directions_parking', intents: ['directions_parking'], bubbles: [part] }), { ...GENERAL, threadHasBranch: true });
    expect(v.bubbles).toEqual(['Take the escalator down toward the aquarium.\nParking is free at both malls.']);
  });
});

describe('SCRUM-832: nothing about the park said twice once the family gave it — unless they ask again', () => {
  // The episode after "Central": the park question, then the reply that answered it.
  const TURN2 = "We're on the basement floor of Central Floresta, opposite the aquarium. It's the side with the luxury brands, not Festival.\n\nParking is free at both malls.";
  const later: Partial<EpisodeState> = {
    ...GENERAL,
    threadHasBranch: true,
    aiAnswers: 2,
    aiAnswersLast10Min: 2,
    questions: parkAnswered('Central'),
    parkAnsweredNow: false,
    parkLines: [PARK_QUESTION.en, TURN2],
  };
  const LOCATION = "We're on the basement floor of Central Floresta, opposite the aquarium.";

  it('a later turn on another topic: the location already given is dropped, the rest goes', () => {
    const v = answer(
      gate({ intent: 'hours', grounding: ['pb.hours'], bubbles: ["We're open every day 10:00 to 20:00 😊", LOCATION], reason: 'FACT_IN_KB' }, later, ['What time do you close?']),
    );
    expect(v.bubbles).toEqual(["We're open every day 10:00 to 20:00 😊"]);
    expect(v.composition).toMatchObject({ repeats: 1 });
  });

  it('"Sorry, where is Central again?": the location again', () => {
    const v = answer(gate({ intent: 'address', grounding: ['pb.address-central'], bubbles: [LOCATION, 'See you soon at OTO!'], reason: 'FACT_IN_KB' }, later, ['Sorry, where is Central again?']));
    expect(v.bubbles).toEqual([`${LOCATION}${PART_JOIN}See you soon at OTO!`]);
    expect(v.composition).toMatchObject({ repeats: 0 });
  });

  it('"We are lost in the mall, help!": the location and the way in again', () => {
    const bubbles = [`No worries! ${LOCATION}`, 'Please follow the signs for the Aquarium or Oto.'];
    const v = answer(gate({ intent: 'directions_parking', grounding: ['pb.address-central', 'pb.directions-central'], bubbles, reason: 'FACT_IN_KB' }, later, ['We are lost in the mall, help!']));
    expect(v.bubbles).toEqual([bubbles.join(PART_JOIN)]);
    expect(v.composition).toMatchObject({ repeats: 0 });
  });

  it('"Where do we leave the car?": the parking again', () => {
    const bubbles = ['Parking is free at both malls.', 'Just follow the signs to the car park when you arrive 😊'];
    const v = answer(gate({ intent: 'directions_parking', grounding: ['pb.parking'], bubbles, reason: 'FACT_IN_KB' }, later, ['Where do we leave the car?']));
    expect(v.bubbles).toEqual([bubbles.join(PART_JOIN)]);
    expect(v.composition).toMatchObject({ repeats: 0 });
  });

  it('a park’s own number, no park question ever asked: nothing is dropped as a repeat', () => {
    const own: Partial<EpisodeState> = { ...GENERAL, threadHasBranch: true, aiAnswers: 1, aiAnswersLast10Min: 1 };
    const v = answer(gate({ intent: 'hours', grounding: ['pb.hours'], bubbles: ["We're open every day 10:00 to 20:00 😊", LOCATION], reason: 'FACT_IN_KB' }, own, ['What time do you close?']));
    expect(v.bubbles).toEqual([`We're open every day 10:00 to 20:00 😊${PART_JOIN}${LOCATION}`]);
  });

  it('only once the family gave the park: with no park nothing is dropped as a repeat', () => {
    const v = answer(
      gate(
        { intent: 'faq', grounding: ['pb.cafe'], bubbles: ['Yes, we have a café 😊', LOCATION], reason: 'FACT_IN_KB' },
        { ...GENERAL, parkLines: [LOCATION] },
        ['Do you have a café?'],
      ),
    );
    expect(v.bubbles).toEqual([`Yes, we have a café 😊${PART_JOIN}${LOCATION}`]);
  });

  it('what a sentence is about is read from the knowledge: the location, the way in, the parking; a sign-off is about nothing', () => {
    expect(parkTopicsOf(LOCATION, sameHours.grounding)).toContain('address_note');
    expect(parkTopicsOf('Please follow the signs for the Aquarium or Oto.', sameHours.grounding)).toContain('directions');
    expect(parkTopicsOf('Parking is free at both malls.', sameHours.grounding)).toEqual(['parking']);
    expect(parkTopicsOf('See you soon at OTO!', sameHours.grounding)).toEqual([]);
    expect(parkTopicsOf('See you at Central Floresta!', sameHours.grounding)).toEqual([]);
    expect(parkTopicsOf('จอดรถฟรีที่ห้างทั้งสองแห่งค่ะ', sameHours.grounding)).toEqual(['parking']);
  });

  it('a reply of nothing but repeats goes as it is (never silence); a question is never dropped as a repeat', () => {
    const only = composeMessage([`${LOCATION} 😊`], { said: [TURN2], keepRepeat: () => false });
    expect(only).toEqual({ bubbles: [`${LOCATION} 😊`], parts: [`${LOCATION} 😊`], duplicates: 0, repeats: 0, parkQuestions: 0 });
    const asks = composeMessage(['Take the escalator right by Tops down to the aquarium.', EN_PERSONA.branchQuestion], { said: [EN_PERSONA.branchQuestion], keepRepeat: () => false });
    expect(asks.bubbles[0]).toContain(EN_PERSONA.branchQuestion);
  });
});

describe('SCRUM-832: nothing a part says is lost (en, th, ru)', () => {
  const unchanged = (parts: readonly string[], what: string) => {
    const m = composeMessage(parts);
    expect(m.parts, what).toEqual(parts.map((p) => p.trim()));
    expect(m.bubbles, what).toEqual([parts.map((p) => p.trim()).join(PART_JOIN)]);
    expect(m.duplicates, what).toBe(0);
  };

  it('a price table in one bubble keeps every row and its line breaks', () => {
    const tables = [
      'Weekday: kids 350 baht. Adults 150 baht.\nWeekend: kids 450 baht. Adults 150 baht.',
      'ราคาวันธรรมดา เด็ก 350 บาท ผู้ใหญ่ 150 บาทค่ะ\nราคาวันหยุด เด็ก 450 บาท ผู้ใหญ่ 150 บาทค่ะ',
      'Будни: дети 350 бат. Взрослые 150 бат.\nВыходные: дети 450 бат. Взрослые 150 бат.',
    ];
    for (const t of tables) {
      unchanged([t], t);
      // As the gate passes it: one bubble, nothing to change, returned as it is.
      const v = verdict({ intent: 'ticket_prices', intents: ['ticket_prices'], bubbles: [t] });
      expect(composeTurn(v, { decision: decision({}), grounding: sameHours.grounding, episode: episode(GENERAL), openLines: [] }), t).toBe(v);
    }
    // The same rows in two bubbles: both, in one message.
    unchanged(['Weekday: kids 350 baht. Adults 150 baht.', 'Weekend: kids 450 baht. Adults 150 baht.'], 'two bubbles');
  });

  it('two packages with the same inclusion: each keeps it', () => {
    const packages: Array<[string, string]> = [
      ['Package A (1,990 baht): 10 kids, 2 hours.\nIncludes a cake and decorations.', 'Package B (2,990 baht): 15 kids, 3 hours.\nIncludes a cake and decorations.'],
      ['Package A (1,990 baht): 10 kids, 2 hours. Includes a cake and decorations.', 'Package B (2,990 baht): 15 kids, 3 hours. Includes a cake and decorations.'],
      ['แพ็กเกจ A (1,990 บาท): เด็ก 10 คน 2 ชั่วโมงค่ะ\nรวมเค้กและการตกแต่งค่ะ', 'แพ็กเกจ B (2,990 บาท): เด็ก 15 คน 3 ชั่วโมงค่ะ\nรวมเค้กและการตกแต่งค่ะ'],
      ['Пакет A (1 990 бат): 10 детей, 2 часа.\nВключены торт и украшения.', 'Пакет B (2 990 бат): 15 детей, 3 часа.\nВключены торт и украшения.'],
    ];
    for (const p of packages) unchanged(p, p[1]);
    unchanged([packages[0]!.join('\n')], 'one bubble, both packages');
  });

  it('two parks with the same adult price, or the same words: each park keeps them', () => {
    unchanged(['Central Floresta: kids 450 baht. Adults pay 150 baht.', 'Robinson Chalong: kids 390 baht. Adults pay 150 baht.'], 'en');
    unchanged(['Central Floresta: เด็ก 450 บาท ผู้ใหญ่ 150 บาทค่ะ', 'Robinson Chalong: เด็ก 390 บาท ผู้ใหญ่ 150 บาทค่ะ'], 'th');
    unchanged(['Central Floresta: дети 450 бат. Взрослые 150 бат.', 'Robinson Chalong: дети 390 бат. Взрослые 150 бат.'], 'ru');
    unchanged(['Central Floresta is on the basement floor. Grip socks are sold at reception.', 'Robinson Chalong is on the third floor. Grip socks are sold at reception.'], 'no number');
  });

  it('a list under each heading keeps its identical lines (per park, per day)', () => {
    unchanged(['Central Floresta\nSocks: 40 baht\nKids under 2: free\n\nRobinson Chalong\nSocks: 40 baht\nKids under 2: free'], 'per park, one bubble');
    unchanged(['Weekdays\nKids under 2: free\nSocks: 40 baht', 'Weekends\nKids under 2: free\nSocks: 40 baht'], 'per day, two bubbles');
    unchanged(['Central Floresta\nGrip socks are sold at reception.', 'Robinson Chalong\nGrip socks are sold at reception.'], 'per park, no number');
  });

  it('long sentences one word apart are two facts: weekdays and weekends, the restaurant and reception, adults and babies', () => {
    const pairs: Array<[string, string]> = [
      ['Adults enter free with every child ticket on weekdays at both parks.', 'Adults enter free with every child ticket on weekends at both parks.'],
      ['Kids under two play free with a paying adult on weekdays only.', 'Kids under two play free with a paying adult on weekends only.'],
      ['Grip socks are required for everyone, and you can buy them at the restaurant.', 'Grip socks are required for everyone, and you can buy them at reception.'],
      ['The soft play area is for children and adults together, all day long.', 'The soft play area is for children and babies together, all day long.'],
    ];
    for (const [a, b] of pairs) {
      expect(sameSentence(b, a), b).toBe(false);
      expect(sameSentence(a, b), a).toBe(false);
      unchanged([a, b], b);
    }
  });

  it('a Thai polite particle stays with its clause', () => {
    unchanged(['ยินดีต้อนรับ ค่ะ', 'จอดรถฟรี ค่ะ'], 'th particle');
    unchanged(['เปิดทุกวันค่ะ', 'จอดรถฟรีค่ะ'], 'th particle, no space');
  });

  it('a sentence one part says again after another is dropped, never inside one part; a part keeps its words around it', () => {
    const m = composeMessage([
      "Easy! We're on the basement floor of Central Floresta, opposite the aquarium.",
      "Please follow the signs for the Aquarium or Oto. We're on the basement floor of Central Floresta, opposite the aquarium. Parking is free by the way.",
    ]);
    expect(m.parts[1]).toBe('Please follow the signs for the Aquarium or Oto. Parking is free by the way.');
    expect(m.duplicates).toBe(1);
    // The same sentence twice inside one part: the part as written.
    const inside = "We're on the basement floor of Central Floresta, opposite the aquarium. Follow the signs. We're on the basement floor of Central Floresta, opposite the aquarium.";
    expect(composeMessage([inside]).bubbles).toEqual([inside]);
    // Under twelve letters, even word for word: kept.
    expect(composeMessage(['Easy! See you.', 'Easy! Parking is free.']).duplicates).toBe(0);
  });
});

describe('SCRUM-832: the sentence reader', () => {
  it('splits English, Russian and Thai sentences, a Thai line at its clauses only, never a Latin name inside Thai', () => {
    expect(sentencesOf(BOTH_PARKS.en[0])).toEqual([
      'Hi!',
      "We've got two parks in Phuket 😊",
      'One is at Central Floresta on the basement floor, opposite the aquarium, and the other is at Robinson Chalong on the 3rd floor, opposite the cinema.',
    ]);
    expect(sentencesOf(CENTRAL_REPLY.ru[0])).toHaveLength(3);
    expect(sentencesOf(CENTRAL_REPLY.th[0])).toEqual(['ง่ายมากค่ะ!', 'เราอยู่ชั้นใต้ดินของ Central Floresta ตรงข้ามอควาเรียมค่ะ', 'ฝั่งที่มีแบรนด์หรู ไม่ใช่ฝั่ง Festival นะคะ']);
    // A row of a Thai price table is one clause, never its phrases.
    expect(sentencesOf('ราคาวันธรรมดา เด็ก 350 บาท ผู้ใหญ่ 150 บาทค่ะ\nราคาวันหยุด เด็ก 450 บาท ผู้ใหญ่ 150 บาทค่ะ')).toEqual([
      'ราคาวันธรรมดา เด็ก 350 บาท ผู้ใหญ่ 150 บาทค่ะ',
      'ราคาวันหยุด เด็ก 450 บาท ผู้ใหญ่ 150 บาทค่ะ',
    ]);
  });

  it('reads a near repeat, never one with a number, a park or a word of its own', () => {
    expect(sameSentence("We're on the basement floor of Central Floresta, opposite the aquarium.", sentencesOf(BOTH_PARKS.en[0])[2]!)).toBe(true);
    expect(sameSentence('Robinson Chalong is on the 3rd floor, opposite the cinema.', 'Central Floresta is on the basement floor, opposite the aquarium.')).toBe(false);
    expect(sameSentence('We are open 10:00–21:00 every day.', 'We are open 10:00–20:00 every day.')).toBe(false);
    // One word of its own is a different fact; so is a "not" one side lacks.
    expect(sameSentence('Weekend: 690 baht per child.', 'Weekday: 690 baht per child.')).toBe(false);
    expect(sameSentence('Grip socks are required.', 'Grip socks are not required for adults.')).toBe(false);
    expect(sameSentence('Outside food is allowed.', "Outside food isn't allowed.")).toBe(false);
    // A heading is not a repeat of the line it heads, a name not one of the paragraph it sits in, an emoji not one of another.
    expect(sameSentence('For the children', '6 children, 2 hours of play')).toBe(false);
    expect(sameSentence('OTO Play Park — Robinson Chalong', 'Halloween is coming, and we are waiting for you at OTO Play Park — Robinson Chalong with games, treats and a costume parade!')).toBe(false);
    expect(sameSentence('🧙‍♀️', '🕸️🦇')).toBe(false);
    expect(sameSentence('Парковка бесплатная в обоих торговых центрах.', 'Парковка бесплатная в обоих торговых центрах!')).toBe(true);
    expect(sameSentence('Парковка платная в обоих торговых центрах.', 'Парковка бесплатная в обоих торговых центрах.')).toBe(false);
    expect(sameSentence('เราอยู่ชั้นใต้ดินของ Central Floresta ตรงข้ามอควาเรียมค่ะ', 'เราอยู่ชั้นใต้ดินของ Central Floresta ตรงข้ามอควาเรียมนะคะ')).toBe(true);
    expect(sameSentence('ราคาวันธรรมดาเริ่มต้น 690 บาทค่ะ', 'ราคาวันหยุดเริ่มต้น 690 บาทค่ะ')).toBe(false);
    expect(sameSentence('Easy!', 'Easy!')).toBe(true);
    expect(sameSentence('Easy!', 'Easy peasy!')).toBe(false);
  });
});
