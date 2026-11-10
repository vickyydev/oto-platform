import { describe, expect, it } from 'vitest';
import {
  PARK_QUESTION,
  PART_JOIN,
  composeMessage,
  composeTurn,
  dependsOnPark,
  parksDiffer,
  sameSentence,
  sentencesOf,
} from '../src/compose';
import type { AiDecision } from '../src/decision';
import { applyGates, type EpisodeQuestion, type EpisodeState, type GateVerdict } from '../src/gate';
import { GM_PLAN, OWN_PARK_QUESTION_INTENTS, PARK_FIRST_INTENTS } from '../src/intents';
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
 *   1. ONE MESSAGE PER TURN: a reply's parts are one bubble; the closing or
 *      hand-over line the playbook keeps separate follows on its own.
 *   2. PARK FIRST: a park-dependent answer in a thread with no park asks
 *      "Which branch…?" ALONE, recorded for the memory (slot park), unless
 *      the customer named the park; "Central" is read as the answer.
 *   3. NO REPETITION: once the park is known, nothing already sent is sent
 *      again.
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
];

const sameHours = buildKnowledge({ kb: PARK_KB, branches: parks(), examples: [] });
/** Robinson Chalong closes an hour later: the parks' hours differ. */
const otherHours = buildKnowledge({ kb: PARK_KB.filter((e) => e.key !== 'pb.hours'), branches: parks('21:00'), examples: [] });

const GENERAL: Partial<EpisodeState> = { threadCategory: 'general', earlierIntents: [] };
const TODAY = '2026-11-10';

const gate = (d: Partial<AiDecision>, e: Partial<EpisodeState>, lines: readonly string[], knowledge = sameHours): GateVerdict =>
  applyGates({ decision: decision(d), grounding: knowledge.grounding, episode: episode(e), openLines: lines });

const answer = (v: GateVerdict) => {
  if (v.action !== 'answer') throw new Error(`expected an answer, got ${v.action} ${v.reason}`);
  return v;
};

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
      expect(v.composition).toEqual({ parkFirst: true, bubbles: 2, duplicates: 0, repeats: 0 });
      // The memory records the slot from the line itself too.
      expect(askedSlotsOf(v.askedSlots, v.bubbles)).toEqual(['park']);
    });

    it(`${lang}: "${SAYS_CENTRAL[lang]}" is the answer; the next reply is ONE bubble with the directions and the parking, once`, () => {
      const questions = parkAnswered(SAYS_CENTRAL[lang]);
      expect(questions[0]).toMatchObject({ state: 'answered', answer: 'central' });
      const episodeAfter: Partial<EpisodeState> = { ...GENERAL, aiAnswers: 1, aiAnswersLast10Min: 1, questions, aiLines: [PARK_QUESTION[lang]] };
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
        { ...GENERAL, questions: parkAnswered('Central') },
        ['Central'],
      ),
    );
    expect(v.bubbles).toHaveLength(1);
    expect(oneParagraph(v.bubbles[0]!)).toBe(OWNER_SAVED_REPLY);
    expect(v.composition).toMatchObject({ parkFirst: false, bubbles: 2, duplicates: 1 });
  });

  it('staging’s own second turn after its first: the repeated location is dropped, the directions and the parking stay', () => {
    const staging = [
      'Easy! From the ground floor with Tops supermarket, walk to the other side of Tops and take the escalator down toward the aquarium. Just follow the signs for Oto or the aquarium 😊',
      "We're on the basement floor of Central Floresta, opposite the aquarium. It's the side with the luxury brands, not Festival. And parking is free!",
    ];
    const v = answer(
      gate(
        { intent: 'directions_parking', grounding: ['pb.address-central', 'pb.directions-central', 'pb.parking'], bubbles: staging, branchNamed: 'central', reason: 'FACT_IN_KB' },
        { ...GENERAL, aiAnswers: 1, aiAnswersLast10Min: 1, aiLines: BOTH_PARKS.en },
        ['Central'],
      ),
    );
    expect(v.bubbles).toEqual([`${staging[0]}${PART_JOIN}It's the side with the luxury brands, not Festival. And parking is free!`]);
    expect(v.composition).toMatchObject({ repeats: 1 });
    expect(v.bubbles[0]!.match(/parking/giu)).toHaveLength(1);
  });
});

describe('SCRUM-832: park first, only where the answer depends on the park', () => {
  it('a message naming the park is answered at once, in one bubble', () => {
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
    }
  });

  it('hours with no park: answered at once when both parks keep the same hours; the park question when they differ', () => {
    const same = answer(
      gate({ intent: 'hours', grounding: ['fact.hours.central', 'fact.hours.chalong'], bubbles: ["We're open every day 10:00–20:00 at both parks 😊"], reason: 'FACT_IN_KB' }, GENERAL, ['What time do you open?']),
    );
    expect(same.bubbles).toEqual(["We're open every day 10:00–20:00 at both parks 😊"]);
    expect(parksDiffer('hours', sameHours.grounding)).toBe(false);

    const differ = answer(
      gate(
        { intent: 'hours', grounding: ['fact.hours.central', 'fact.hours.chalong'], bubbles: ['Central Floresta is open 10:00–20:00 and Robinson Chalong 10:00–21:00 😊'], reason: 'FACT_IN_KB' },
        GENERAL,
        ['What time do you close?'],
        otherHours,
      ),
    );
    expect(differ).toMatchObject({ bubbles: [PARK_QUESTION.en], askBranch: true, askedSlots: ['park'] });
    expect(parksDiffer('hours', otherHours.grounding)).toBe(true);
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

  it('parking, free at both malls, is answered at once; the address and the way in are not', () => {
    const parking = answer(gate({ intent: 'directions_parking', grounding: ['pb.parking'], bubbles: ['Yes! Parking is free at both malls 😊'], reason: 'FACT_IN_KB' }, GENERAL, ['Is there parking?']));
    expect(parking.bubbles).toEqual(['Yes! Parking is free at both malls 😊']);
    expect(dependsOnPark({ intents: ['directions_parking'], groundingKeys: ['pb.parking'] }, sameHours.grounding)).toBe(false);
    expect(dependsOnPark({ intents: ['address'], groundingKeys: ['fact.address.central', 'fact.address.chalong'] }, sameHours.grounding)).toBe(true);
    expect(dependsOnPark({ intents: ['directions_parking'], groundingKeys: ['pb.directions-central'] }, sameHours.grounding)).toBe(true);
    // A guess at one park, the family having named none: the question.
    const guess = gate({ intent: 'directions_parking', grounding: ['pb.directions-central'], bubbles: ['Take the escalator down toward the aquarium 😊'], reason: 'FACT_IN_KB' }, GENERAL, ['Where are you?']);
    expect(guess).toMatchObject({ action: 'answer', bubbles: [PARK_QUESTION.en] });
  });

  it('never: a thread with a park, a park already answered, both parks named, a birthday, the price question, a hand-over to follow', () => {
    const where = { intent: 'directions_parking' as const, grounding: ['pb.address-central', 'pb.address-chalong'], bubbles: BOTH_PARKS.en, reason: 'FACT_IN_KB' as const };
    const message = [BOTH_PARKS.en.join(PART_JOIN)];
    expect(gate(where, { ...GENERAL, threadHasBranch: true }, ['How to find you?'])).toMatchObject({ bubbles: message });
    expect(gate(where, { ...GENERAL, questions: parkAnswered('Central') }, ['How to find you?'])).toMatchObject({ bubbles: message });
    expect(gate(where, GENERAL, ['Which is closer to Kata, Central or Chalong?'])).toMatchObject({ bubbles: message });
    // A birthday thread asks the park in its own combined question.
    expect(gate(where, { threadCategory: 'birthdays', earlierIntents: [] }, ['How to find you?'])).toMatchObject({ bubbles: message });
    expect(gate(where, { ...GENERAL, earlierIntents: ['birthday_party'] }, ['How to find you?'])).toMatchObject({ bubbles: message });
    // The price conversation asks the branch and the residency together, before the prices (the playbook).
    const price = gate(
      { ...where, intent: 'directions_parking', intents: ['directions_parking', 'ticket_prices'], grounding: ['pb.address-central', 'pb.address-chalong', 'fact.prices.central'], bubbles: [BOTH_PARKS.en[0], EN_PERSONA.branchResidencyQuestion] },
      GENERAL,
      ['Where are you and how much is it?'],
    );
    expect(price).toMatchObject({ action: 'answer', bubbles: [[BOTH_PARKS.en[0], EN_PERSONA.branchResidencyQuestion].join(PART_JOIN)] });
    // A colleague takes over after the answer: the colleague asks.
    const job = answer(
      gate({ ...where, intents: ['directions_parking', 'job_request'], bubbles: [BOTH_PARKS.en[0], "We're always looking for great people!"] }, GENERAL, ['Where are you? Also, are you hiring?']),
    );
    expect(job).toMatchObject({ thenHandover: GM_PLAN, bubbles: [`${BOTH_PARKS.en[0]}${PART_JOIN}We're always looking for great people!`] });
    expect(job.askedSlots).toBeUndefined();
  });

  it('the intents it reads, and the flows it leaves to their own question', () => {
    expect([...PARK_FIRST_INTENTS].sort()).toEqual(['address', 'directions_parking', 'hours']);
    expect(OWN_PARK_QUESTION_INTENTS.has('ticket_prices')).toBe(true);
    expect(OWN_PARK_QUESTION_INTENTS.has('birthday_party')).toBe(true);
    expect(PARK_QUESTION).toEqual({ en: EN_PERSONA.branchQuestion, th: TH_PERSONA.branchQuestion, ru: RU_PERSONA.branchQuestion });
    for (const q of Object.values(PARK_QUESTION)) expect(askedSlotsOf([], [q])).toEqual(['park']);
  });
});

describe('SCRUM-832: one message per turn — a hand-over keeps its one bubble', () => {
  it('a complaint’s apology stays one bubble, the GM’s closing line follows on its own', () => {
    const v = answer(gate({ intent: 'complaint_onsite', action: 'handover', bubbles: ["We're so sorry to hear about your visit today."], reason: 'NEEDS_PERSON' }, GENERAL, ['Your staff were rude.']));
    expect(v).toMatchObject({ bubbles: ["We're so sorry to hear about your visit today."], thenHandover: GM_PLAN });
    expect(v.composition).toBeUndefined();
  });

  it('a hand-over with no words of its own, and a template line that is already one message, are left as they are', () => {
    const handover = gate({ intent: 'birthday_details', action: 'handover', bubbles: [], reason: 'NEEDS_PERSON' }, GENERAL, ['14 November, 12 kids']);
    expect(handover).toMatchObject({ action: 'handover', holdingBubbles: [] });
    // SCRUM-823's opener beside an advice hand-over sends ONE template line: a hand-over verdict, untouched here.
    const opener: GateVerdict = { ...(handover as Extract<GateVerdict, { action: 'handover' }>), holdingBubbles: ['one message'] };
    expect(composeTurn(opener, { decision: decision({}), grounding: sameHours.grounding, episode: episode(GENERAL) })).toBe(opener);
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

describe('SCRUM-832: nothing said twice once the park is known', () => {
  const said = ["We're on the basement floor of Central Floresta, opposite the aquarium. It's the side with the luxury brands, not Festival."];

  it('a sentence already sent is dropped from a later message; the rest goes', () => {
    const m = composeMessage(["We're open every day 10:00–20:00 😊", "We're on the basement floor of Central Floresta, opposite the aquarium."], { said, openLines: ['What time do you close?'] });
    expect(m).toEqual({ text: "We're open every day 10:00–20:00 😊", parts: ["We're open every day 10:00–20:00 😊"], duplicates: 0, repeats: 1 });
  });

  it('a family asking again gets the answer again; a reply of nothing but repeats goes as it is (never silence)', () => {
    const again = composeMessage(["We're on the basement floor of Central Floresta, opposite the aquarium.", 'See you soon at OTO!'], { said, openLines: ['Sorry, which floor are you on?'] });
    expect(again.repeats).toBe(0);
    const only = composeMessage(["We're on the basement floor of Central Floresta, opposite the aquarium 😊"], { said, openLines: ['ok'] });
    expect(only).toEqual({
      text: "We're on the basement floor of Central Floresta, opposite the aquarium 😊",
      parts: ["We're on the basement floor of Central Floresta, opposite the aquarium 😊"],
      duplicates: 0,
      repeats: 0,
    });
  });

  it('only once the park is known: with no park nothing is dropped as a repeat', () => {
    const v = answer(
      gate(
        { intent: 'faq', grounding: ['pb.cafe'], bubbles: ['Yes, we have a café 😊', "We're on the basement floor of Central Floresta, opposite the aquarium."], reason: 'FACT_IN_KB' },
        { ...GENERAL, aiLines: said },
        ['Do you have a café?'],
      ),
    );
    expect(v.bubbles).toEqual([`Yes, we have a café 😊${PART_JOIN}We're on the basement floor of Central Floresta, opposite the aquarium.`]);
  });

  it('a question is never dropped as a repeat (the repeat guard owns those)', () => {
    const m = composeMessage(['Parking is free at both malls, and the escalator is right by Tops.', EN_PERSONA.branchQuestion], { said: [EN_PERSONA.branchQuestion] });
    expect(m.text).toContain(EN_PERSONA.branchQuestion);
  });
});

describe('SCRUM-832: the sentence reader', () => {
  it('splits English, Russian and Thai sentences, never a Latin name inside Thai', () => {
    expect(sentencesOf(BOTH_PARKS.en[0])).toEqual([
      'Hi!',
      "We've got two parks in Phuket 😊",
      'One is at Central Floresta on the basement floor, opposite the aquarium, and the other is at Robinson Chalong on the 3rd floor, opposite the cinema.',
    ]);
    expect(sentencesOf(CENTRAL_REPLY.ru[0])).toHaveLength(3);
    expect(sentencesOf(CENTRAL_REPLY.th[0])).toEqual(['ง่ายมากค่ะ!', 'เราอยู่ชั้นใต้ดินของ Central Floresta ตรงข้ามอควาเรียมค่ะ', 'ฝั่งที่มีแบรนด์หรู', 'ไม่ใช่ฝั่ง Festival นะคะ']);
  });

  it('reads a near repeat, never one with a number or a park of its own', () => {
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
