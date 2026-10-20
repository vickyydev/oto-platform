/**
 * The internal assistant's final answer (Phase 3 PLAN §D.1 step 5) and the
 * words an ask can end with.
 *
 * `{ answer ≤ 1,200, links ≤ 3, language }`. Links are KEYS of the deep-link
 * map with parameters, never URLs: the server resolves each key, drops the
 * ones the asker may not open, and the launcher renders the rest (§C).
 *
 * Link parameters are name/value pairs, not a record: the SDK's structured
 * output helper compiles a zod record to an object with no properties and
 * `additionalProperties: false`, so the model could only ever send `{}`.
 * `linkParams` turns the pairs back into a record for the resolver.
 *
 * Written against `zod/v4` for the same reason as `decision.ts`.
 */

import { z } from 'zod/v4';
import { PROVIDER_FAILURES } from './client';

export const INTERNAL_LANGUAGES = ['th', 'en', 'ru'] as const;
export type InternalLanguage = (typeof INTERNAL_LANGUAGES)[number];

export const INTERNAL_MAX_ANSWER_CHARS = 1_200;
export const INTERNAL_MAX_LINKS = 3;
export const INTERNAL_MAX_LINK_PARAMS = 4;

export const InternalLinkSchema = z.object({
  /** A deep-link map key, e.g. `oto.timekeeping.employee`. */
  key: z.string().min(1).max(64),
  params: z
    .array(z.object({ name: z.string().min(1).max(32), value: z.string().max(128) }))
    .max(INTERNAL_MAX_LINK_PARAMS),
});
export type InternalLink = z.infer<typeof InternalLinkSchema>;

export const InternalAnswerSchema = z.object({
  /** Plain text in the asker's language: figures first, one line of context. */
  answer: z.string().min(1).max(INTERNAL_MAX_ANSWER_CHARS),
  links: z.array(InternalLinkSchema).max(INTERNAL_MAX_LINKS),
  language: z.enum(INTERNAL_LANGUAGES),
});
export type InternalAnswer = z.infer<typeof InternalAnswerSchema>;

/**
 * How the final answer travels (§D.1).
 *
 *   trailing_json  THE DEFAULT, the plan's fallback: no structured output
 *                  format on any request. The final turn is plain text, the
 *                  answer, ending with ONE JSON object carrying the link keys
 *                  and the language, which the server parses
 *                  (`parseTrailingAnswer`). The live check of 2026-10-20 got
 *                  a 400 for tools and the format in one request on
 *                  claude-opus-5-5.
 *   combined       tools and the answer format in the same request; the
 *                  final turn is the schema's JSON. Kept so one option
 *                  restores it if the API accepts the combination.
 *
 * Either way the result is validated by `InternalAnswerSchema`, so the
 * engine sees the same `InternalAnswer`.
 */
export const INTERNAL_ANSWER_MODES = ['trailing_json', 'combined'] as const;
export type InternalAnswerMode = (typeof INTERNAL_ANSWER_MODES)[number];
export const DEFAULT_INTERNAL_ANSWER_MODE: InternalAnswerMode = 'trailing_json';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The trailing-JSON final turn, parsed: the prose before the LAST JSON object
 * in the text is the answer; that object holds `links` and `language` and
 * nothing after it but whitespace (or a closing code fence). A text with no
 * such block, or whose parts fail the schema, is null (MALFORMED).
 */
export function parseTrailingAnswer(text: string): InternalAnswer | null {
  const body = text.replace(/\s*```\s*$/, '').trimEnd();
  if (!body.endsWith('}')) return null;
  for (let i = body.lastIndexOf('{'); i >= 0; i = body.lastIndexOf('{', i - 1)) {
    let block: unknown;
    try {
      block = JSON.parse(body.slice(i));
    } catch {
      if (i === 0) break;
      continue;
    }
    if (!isPlainObject(block) || !('language' in block) || !('links' in block)) return null;
    const keys = Object.keys(block);
    if (keys.some((k) => k !== 'links' && k !== 'language')) return null;
    const prose = body
      .slice(0, i)
      .replace(/```(?:json)?\s*$/i, '')
      .trim();
    const parsed = InternalAnswerSchema.safeParse({
      answer: prose,
      links: block['links'],
      language: block['language'],
    });
    return parsed.success ? parsed.data : null;
  }
  return null;
}

/** The trailing form of an answer: what the model is asked to write (and the fake writes). */
export function renderTrailingAnswer(answer: InternalAnswer): string {
  return `${answer.answer}\n${JSON.stringify({ links: answer.links, language: answer.language })}`;
}

/** The pairs as a record for the link resolver. A repeated name keeps its first value. */
export function linkParams(link: InternalLink): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of link.params) if (!(name in out)) out[name] = value;
  return out;
}

/**
 * Every way a tool loop ends without an answer. The provider words are
 * Phase 2's, unchanged (the same reason word for the same failure); the loop
 * adds its own three.
 */
export const TOOL_LOOP_FAILURES = [
  ...PROVIDER_FAILURES,
  /** The model asked for more tool calls than `maxToolCalls` (§E.2, Q12). */
  'TOOL_CAP',
  /** The ask ran past `wallMs` (§D.1 step 4). */
  'WALL_TIME',
  /** The tool executor threw: an engine fault, closed rather than guessed. */
  'TOOL_ERROR',
] as const;
export type ToolLoopFailure = (typeof TOOL_LOOP_FAILURES)[number];

/**
 * The `assistant.ask.state` vocabulary (§D.3) and the reason words the
 * package can produce for the `reason` column. The engine (I2) adds its own
 * (caps, switches) beside these.
 */
export const INTERNAL_ASK_STATES = [
  'answered',
  'refused',
  'link_only',
  'failed',
  'capped',
  'off',
] as const;
export type InternalAskState = (typeof INTERNAL_ASK_STATES)[number];
