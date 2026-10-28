/**
 * Fixtures for the playbook checks (SCRUM-220, Tom's "Oto Inbox Bot
 * Playbook", 28 Oct 2026). FICTIONAL TEST DATA in the playbook's shape: the
 * KB rows paraphrase the `pb.*` entries staging carries, and the prices are
 * the playbook's tables in satang, so a reply can be checked against the
 * numbers the park really quotes. Kept apart from `support.ts` so the A1
 * fixtures (and every check pinned to them) stay as they were.
 */

import type { AiDecision } from '../src/decision';
import { applyGates, type EpisodeState, type GateVerdict } from '../src/gate';
import { buildKnowledge, WEEKDAY_KEYS, type BranchFacts, type KbEntryInput, type OpeningHours } from '../src/prompt';
import { decision, episode, FIXTURE_KB } from './support';

export const CALCULATOR_CENTRAL = 'https://phuket.otoplay.co/prices?branch=floresta&rate=tourist&calculator=open';
export const MENU_LINK = 'https://phuket.otoplay.co/menu';
export const HALLOWEEN_LINK = 'https://phuket.otoplay.co/events/halloween';

const en = (key: string, topic: KbEntryInput['topic'], question: string, body: string): KbEntryInput => ({
  key,
  topic,
  language: 'en',
  branch: null,
  question,
  body,
  needsTranslation: false,
});

export const PLAYBOOK_KB: KbEntryInput[] = [
  en(
    'pb.prices-central',
    'prices_note',
    'How much is Central Floresta?',
    `Central Floresta, per child: 1 hour 690 baht, 2 hours 890, full day 1,090. Tourist prices start from 690 baht per hour. Exact totals: use the price calculator at ${CALCULATOR_CENTRAL}`,
  ),
  en(
    'pb.prices-central-resident',
    'prices_note',
    'Is there a resident discount at Central?',
    'Residents and expats with ID get kids entry at Central Floresta for 30% off on weekdays and 20% off on weekends: 1 hour 483 weekday / 552 weekend. Resident prices start from 483 baht per hour.',
  ),
  en(
    'pb.parent-tickets',
    'prices_note',
    'Do parents pay to enter?',
    'Parents enter for a small fee that is always 100% food and drink credit in our restaurant. Kids under 1 are free.',
  ),
  en(
    'pb.deal-dinner-promo',
    'prices_note',
    'Is there an evening deal at Chalong?',
    'The Dinner Promo at Robinson Chalong applies after 6pm. Weekdays: 1,080 baht, all of it food and drink credit, plus free entry for 3 people.',
  ),
  en(
    'pb.golden-ticket',
    'prices_note',
    'What is the Golden Ticket?',
    'The Golden Ticket is 1,500 baht per child. Every child gets full-day play, OTO grip socks and a special mascot experience. Children 5 and up also get the drop-off service and entry for 1 parent; children under 5 get entry for 1 parent. The parent entry in the Golden Ticket has NO food credit.',
  ),
  en(
    'pb.nanny',
    'faq',
    'How does the nanny service work?',
    'The nanny service is one-on-one care at Central Floresta only, 330 baht per hour, from age 3 up to 4 years 11 months when the parent is not in the park. Book ahead.',
  ),
  en(
    'pb.dropoff',
    'faq',
    'What does the drop-off service include?',
    'Drop-off (from the 5th birthday, 225 baht per visit) includes regular photo updates to the parent and supervision by our child supervisors the whole time.',
  ),
  en(
    'pb.food',
    'faq',
    'What food do you have?',
    `We have a real restaurant with a proper kitchen and head chef. The menu for both branches: ${MENU_LINK} .`,
  ),
  en(
    'pb.special-needs',
    'faq',
    'Is the park suitable for children with special needs?',
    'Every child is welcome. For kids who find busy places hard, weekday mornings are the calmest time.',
  ),
  en(
    'pb.halloween',
    'faq',
    'Is there a Halloween event?',
    `Halloween at OTO: a spooky play day with costumes and games. Book here: ${HALLOWEEN_LINK}`,
  ),
];

/** The playbook's hours: both parks 10am to 8pm, every day. */
const DAILY: OpeningHours = Object.fromEntries(WEEKDAY_KEYS.map((d) => [d, { open: '10:00', close: '20:00' }]));

/** The playbook's price tables as the catalogue holds them (satang), with the Thai and resident tiers. */
export const TIER_BRANCHES: BranchFacts[] = [
  {
    key: 'central',
    name: 'Central Floresta',
    address: 'Central Floresta, basement floor, opposite the aquarium (fixture)',
    openingHours: DAILY,
    packages: [
      {
        name: '1 hour',
        kidWeekday: 69_000,
        kidWeekend: 69_000,
        adultWeekday: 35_000,
        adultWeekend: 50_000,
        includedAdults: 0,
        overflowAdult: null,
        tierPrices: [
          { tierCode: 'thai', kidWeekday: 42_000, kidWeekend: 52_000, adultWeekday: 0, adultWeekend: 0 },
          { tierCode: 'expat', kidWeekday: 48_300, kidWeekend: 55_200, adultWeekday: 35_000, adultWeekend: 50_000 },
        ],
      },
      {
        name: 'Full day',
        kidWeekday: 109_000,
        kidWeekend: 109_000,
        adultWeekday: 35_000,
        adultWeekend: 50_000,
        includedAdults: 0,
        overflowAdult: null,
        tierPrices: [
          { tierCode: 'thai', kidWeekday: 62_000, kidWeekend: 72_000, adultWeekday: 0, adultWeekend: 0 },
          { tierCode: 'expat', kidWeekday: 76_300, kidWeekend: 87_200, adultWeekday: 35_000, adultWeekend: 50_000 },
        ],
      },
    ],
  },
  {
    key: 'chalong',
    name: 'Robinson Chalong',
    address: 'Robinson Chalong, 3rd floor, opposite the cinema (fixture)',
    openingHours: DAILY,
    packages: [
      {
        name: '2 hours',
        kidWeekday: 40_000,
        kidWeekend: 45_000,
        adultWeekday: 27_000,
        adultWeekend: 43_200,
        includedAdults: 0,
        overflowAdult: null,
        tierPrices: [{ tierCode: 'thai', kidWeekday: 20_000, kidWeekend: 22_500, adultWeekday: 13_500, adultWeekend: 21_600 }],
      },
      {
        name: '1 hour',
        kidWeekday: 30_000,
        kidWeekend: 30_000,
        adultWeekday: 27_000,
        adultWeekend: 43_200,
        includedAdults: 0,
        overflowAdult: null,
        tierPrices: [{ tierCode: 'thai', kidWeekday: 15_000, kidWeekend: 15_000, adultWeekday: 13_500, adultWeekend: 21_600 }],
      },
    ],
  },
];

export const playbookKnowledge = () =>
  buildKnowledge({ kb: [...FIXTURE_KB, ...PLAYBOOK_KB], branches: TIER_BRANCHES, examples: [] });

const knowledge = playbookKnowledge();

/** The gate over the playbook knowledge. */
export function pgate(d: Partial<AiDecision>, e: Partial<EpisodeState> = {}): GateVerdict {
  return applyGates({ decision: decision(d), grounding: knowledge.grounding, episode: episode(e) });
}
