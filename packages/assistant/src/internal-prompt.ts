/**
 * The internal assistant's system blocks (Phase 3 PLAN §D.2).
 *
 *   tools            the tool definitions, sorted by name (the client sorts
 *                    them), so the same set is the same bytes.
 *   system block 1   STATIC: persona, rules, the data rule, the output
 *                    contract, the link map's keys and descriptions. Nothing
 *                    about the asker. A one-hour cache breakpoint ends it, so
 *                    tools + block 1 are one cached prefix shared by every
 *                    asker offered the same tools.
 *   ---------------- cache breakpoint: nothing about the asker above it -------
 *   system block 2   PER ASKER: name, seat branch, now in Bangkok, app tiles.
 *                    Small, not cached.
 *   messages         the question, then the loop's turns.
 *
 * Nothing here reads a clock, an environment variable or a database.
 */

import { INTERNAL_MAX_ANSWER_CHARS, INTERNAL_MAX_LINKS } from './internal-answer';
import {
  INTERNAL_ASSISTANT_LABEL,
  INTERNAL_DATA_RULE,
  INTERNAL_OUTPUT_CONTRACT,
  INTERNAL_PERSONA_VERSION,
  INTERNAL_RULES,
  INTERNAL_VOICE,
} from './persona/internal';
import { bangkokStamp, inertJson, type SystemBlock } from './prompt';

/**
 * One deep-link map entry as the model sees it. The map itself
 * (`packages/shared/src/suite-screens.ts`) is lane ia-1b's; the engine passes
 * the entries in.
 */
export interface InternalLinkEntry {
  key: string;
  /** What the screen shows, in a few words. */
  shows: string;
  /** Parameter names the key takes, e.g. `['employeeId', 'date']`. */
  params: readonly string[];
}

export interface InternalAsker {
  name: string;
  /** The session's seat branch name, or null for an operator-wide session. */
  seatBranch: string | null;
  /** The app tiles the asker may open (launcher keys). */
  tiles: readonly string[];
}

function compareKeys(a: InternalLinkEntry, b: InternalLinkEntry): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function renderLinks(links: readonly InternalLinkEntry[]): string {
  if (links.length === 0) return '(no links available)';
  return [...links]
    .sort(compareKeys)
    .map((l) => {
      const params = [...l.params].sort();
      return `- ${l.key}: ${l.shows}${params.length > 0 ? ` (params: ${params.join(', ')})` : ''}`;
    })
    .join('\n');
}

/**
 * Block 1. Pure in the link map: the same entries in any order give the same
 * bytes, whoever asks.
 */
export function buildInternalStaticSystem(links: readonly InternalLinkEntry[]): string {
  return [
    `You are the ${INTERNAL_ASSISTANT_LABEL.en} for OTO Play Park, an indoor children's play park in Phuket. Colleagues (reception, floor, managers, admins) ask you about the park's own records. You answer from the tools you are given, which read the park's systems as the asking colleague: each tool sees exactly what that colleague's own screens would show.`,
    '',
    '## Rules',
    ...INTERNAL_RULES.map((r) => `- ${r.text}`),
    '',
    '## Voice',
    INTERNAL_VOICE.th,
    INTERNAL_VOICE.en,
    INTERNAL_VOICE.ru,
    '',
    '## Tool results',
    INTERNAL_DATA_RULE,
    '',
    `## Links (at most ${INTERNAL_MAX_LINKS}; key and params only)`,
    renderLinks(links),
    '',
    '## Output',
    INTERNAL_OUTPUT_CONTRACT,
    `The answer is at most ${INTERNAL_MAX_ANSWER_CHARS} characters.`,
  ].join('\n');
}

/** Block 2: who is asking and when. JSON-escaped: a name is data. */
export function buildAskerSystem(asker: InternalAsker, now: Date): string {
  return [
    '<asker>',
    inertJson({
      name: asker.name,
      seatBranch: asker.seatBranch,
      now: `${bangkokStamp(now)} (Bangkok)`,
      apps: [...asker.tiles].sort(),
    }),
    '</asker>',
  ].join('\n');
}

export interface InternalSystemInput {
  links: readonly InternalLinkEntry[];
  asker: InternalAsker;
  now: Date;
}

export interface InternalSystem {
  system: [SystemBlock, SystemBlock];
  personaVersion: string;
}

export function buildInternalSystem(input: InternalSystemInput): InternalSystem {
  return {
    system: [
      {
        type: 'text',
        text: buildInternalStaticSystem(input.links),
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      { type: 'text', text: buildAskerSystem(input.asker, input.now) },
    ],
    personaVersion: INTERNAL_PERSONA_VERSION,
  };
}
