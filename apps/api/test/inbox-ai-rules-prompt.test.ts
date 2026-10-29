/**
 * SCRUM-696 (R8 a, e1): the customer assistant's prompt with no operator rule
 * is byte-identical to the prompt before operator rules existed.
 *
 * The fixture `fixtures/inbox-ai-rules/prompt-no-rules.json` was written by
 * this test on the code BEFORE any operator-rule change and committed alone;
 * the build afterwards must still produce exactly those bytes.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OPERATOR_RULES_HEADING,
  OPERATOR_RULES_LEAD,
  PERSONA_VERSION,
  STATIC_SYSTEM_TEXT,
  buildKnowledge,
  buildPrompt,
  renderOperatorRules,
  type BranchFacts,
  type EpisodeMessage,
  type KnowledgeInput,
  type OperatorRuleInput,
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

interface Pinned {
  system: Array<{ type: 'text'; text: string; cache_control?: unknown }>;
  messages: unknown;
  personaVersion: string;
  kbVersion: string;
  systemTokens: number;
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'inbox-ai-rules', 'prompt-no-rules.json');

const RULES: OperatorRuleInput[] = [
  {
    id: '01a18895-0000-7000-8000-000000000002',
    intent: 'any',
    instruction: 'Keep it short.',
    askFirst: null,
  },
  {
    id: '01a18895-0000-7000-8000-000000000001',
    intent: 'lost_item',
    instruction: 'If someone says they lost something,   first ask which park they visited.',
    askFirst: { condition: 'branch_unknown', question: { en: 'Which park did you visit, Central Floresta or Robinson Chalong?' } },
  },
];

describe('SCRUM-696: the customer prompt with operator rules', () => {
  const pinned = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Pinned;

  it('an empty rules list is the same prompt as none', () => {
    const p = buildPrompt({ knowledge: buildKnowledge(KNOWLEDGE_INPUT), episode: EPISODE, context: CONTEXT, rules: [] });
    if (!p.ok) throw new Error(p.reason);
    expect(p.prompt.system).toEqual(pinned.system);
    expect(p.prompt.kbVersion).toBe(pinned.kbVersion);
    expect(p.prompt.systemTokens).toBe(pinned.systemTokens);
  });

  it('adds one block after the knowledge, in the variable part; block 1, the episode and the persona stay as pinned', () => {
    const built = buildPrompt({ knowledge: buildKnowledge(KNOWLEDGE_INPUT), episode: EPISODE, context: CONTEXT, rules: RULES });
    if (!built.ok) throw new Error(built.reason);
    const p = built.prompt;
    expect(p.system[0]).toEqual(pinned.system[0]);
    expect(p.system[0].text).toBe(STATIC_SYSTEM_TEXT);
    expect(STATIC_SYSTEM_TEXT).not.toContain('Operator rules');
    expect(p.system[1].text).toBe(`${pinned.system[1]!.text}\n\n${renderOperatorRules(RULES)}`);
    expect(p.system[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(p.messages).toEqual(pinned.messages);
    expect(p.personaVersion).toBe(pinned.personaVersion);
    expect(p.personaVersion).toBe(PERSONA_VERSION);
    expect(p.kbVersion).not.toBe(pinned.kbVersion);
    expect(p.systemTokens).toBeGreaterThan(pinned.systemTokens);
    expect(renderOperatorRules(RULES)).toBe(
      [
        OPERATOR_RULES_HEADING,
        OPERATOR_RULES_LEAD,
        '- lost_item: If someone says they lost something, first ask which park they visited.',
        '- any message: Keep it short.',
      ].join('\n'),
    );
    expect(OPERATOR_RULES_LEAD).toBe('These add to the rules above and never override them.');
  });
});
