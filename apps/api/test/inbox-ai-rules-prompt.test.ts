/**
 * SCRUM-696 (R8 a, e1): the customer assistant's prompt with no operator rule
 * is byte-identical to the prompt before operator rules existed.
 *
 * The fixture `fixtures/inbox-ai-rules/prompt-no-rules.json` was written by
 * this test on the code BEFORE any operator-rule change and committed alone;
 * the build afterwards must still produce exactly those bytes.
 */

import { describe, expect, it } from 'vitest';
import {
  buildKnowledge,
  buildPrompt,
  type BranchFacts,
  type EpisodeMessage,
  type KnowledgeInput,
  type TurnContext,
} from '@oto/assistant';

const NOW = new Date('2026-10-29T05:00:00Z');

const BRANCHES: BranchFacts[] = [
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
      sat: { open: '10:00', close: '21:00' },
      sun: { open: '10:00', close: '21:00' },
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
    name: 'Robinson Chalong',
    address: 'Robinson Chalong, ground floor (fixture)',
    openingHours: null,
    packages: [
      {
        name: 'Play pass',
        kidWeekday: 30_000,
        kidWeekend: 39_000,
        adultWeekday: 12_000,
        adultWeekend: 12_000,
        includedAdults: 1,
        overflowAdult: null,
      },
    ],
  },
];

const KNOWLEDGE_INPUT: KnowledgeInput = {
  kb: [
    {
      key: 'faq.lost-property',
      topic: 'faq',
      language: 'en',
      branch: null,
      question: 'I lost something at the park',
      body: 'Reception keeps lost property for a week. Tell us what it looks like and we will check.',
      needsTranslation: false,
    },
  ],
  branches: BRANCHES,
  examples: [
    {
      intent: 'socks',
      language: 'en',
      customerText: 'Do kids need socks?',
      goodReply: 'Yes, grip socks for everyone on the play floor. Reception sells them.',
      verdict: 'should_answer',
    },
  ],
};

const EPISODE: EpisodeMessage[] = [
  { from: 'customer', at: new Date('2026-10-29T04:55:00Z'), text: 'Hello' },
  { from: 'customer', at: new Date('2026-10-29T04:58:00Z'), text: 'I think I left my bag at your park' },
];

const CONTEXT: TurnContext = {
  now: NOW,
  threadBranch: null,
  priceModeToday: { central: 'weekday', chalong: 'weekday' },
  contactCountryCode: null,
  earlier: { answered: 0, brochureSent: false, branchAsked: false, identityAnswered: false, languageOffered: false },
};

function noRules() {
  const built = buildPrompt({ knowledge: buildKnowledge(KNOWLEDGE_INPUT), episode: EPISODE, context: CONTEXT });
  if (!built.ok) throw new Error(built.reason);
  return built.prompt;
}

describe('SCRUM-696: the customer prompt with no operator rule', () => {
  it('is byte-identical to the prompt before operator rules existed', async () => {
    const p = noRules();
    await expect(
      JSON.stringify(
        {
          system: p.system,
          messages: p.messages,
          personaVersion: p.personaVersion,
          kbVersion: p.kbVersion,
          systemTokens: p.systemTokens,
        },
        null,
        2,
      ),
    ).toMatchFileSnapshot('./fixtures/inbox-ai-rules/prompt-no-rules.json');
  });
});
