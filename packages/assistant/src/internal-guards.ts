/**
 * The internal answer's guards (Phase 3 PLAN §E.3, §E.4). Pure; they return
 * rule ids, never the text they matched, so a result can go to an audit row
 * as it stands.
 *
 *   1. URL stripping: any http(s):// in the prose is removed (no exfiltration
 *      channel: links are keys the server resolves).
 *   2. Shape: non-empty, at most 1,200 characters. Lists are allowed here.
 *   3. Phase 2's traceability guard, with grounding = the tool summaries
 *      returned in THIS ask, plus the asker's own question.
 *
 * The persona guard is deliberately NOT applied (§D.2): this assistant is
 * labelled as one, and saying so is the truth.
 */

import { traceabilityGuard, type TraceReason } from './guards';
import {
  INTERNAL_MAX_ANSWER_CHARS,
  type InternalAnswer,
  type InternalLink,
} from './internal-answer';

/** A scheme URL up to whitespace or a closing bracket/quote. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]}]*/gi;

export function stripUrls(text: string): { text: string; stripped: number } {
  let stripped = 0;
  const out = text.replace(URL_PATTERN, (url) => {
    stripped += 1;
    // A sentence's own full stop or comma after a URL stays.
    return /[.,;:!?]+$/.exec(url)?.[0] ?? '';
  });
  if (stripped === 0) return { text, stripped };
  return {
    text: out
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +([.,;:!?])/g, '$1')
      .trim(),
    stripped,
  };
}

export type InternalGuardReason = TraceReason | 'GUARD_SHAPE';

export type InternalGuardResult =
  | {
      ok: true;
      /** The answer as it may be shown: URLs stripped. */
      answer: InternalAnswer;
      urlsStripped: number;
    }
  | {
      ok: false;
      reason: InternalGuardReason;
      rule: string;
      /** Links survive a guard failure: the engine shows them under the fixed line. */
      links: InternalLink[];
      urlsStripped: number;
    };

/**
 * @param groundingTexts the summaries the tools returned in this ask, and
 *   only those (`outcome.groundingTexts`): never a refusal envelope.
 * @param question the asker's own words. For the INTERNAL assistant they
 *   ground too: a phone number, a date or a month the asker typed is their
 *   input, not a figure the model found, and may be echoed back (a reply to
 *   "Why does September's payroll look wrong?" may say "September"). The
 *   customer assistant keeps the opposite rule in `traceabilityGuard`: a
 *   customer's "50%" is never confirmed by repeating it.
 */
export function internalAnswerGuard(
  answer: InternalAnswer,
  groundingTexts: readonly string[],
  question: string,
): InternalGuardResult {
  const { text, stripped } = stripUrls(answer.answer);
  const fail = (reason: InternalGuardReason, rule: string): InternalGuardResult => ({
    ok: false,
    reason,
    rule,
    links: answer.links,
    urlsStripped: stripped,
  });
  if (text.trim().length === 0) return fail('GUARD_SHAPE', 'empty');
  if (text.length > INTERNAL_MAX_ANSWER_CHARS) return fail('GUARD_SHAPE', 'length');
  const trace = traceabilityGuard([text], [...groundingTexts, question]);
  if (!trace.ok) return fail(trace.reason, trace.rule);
  return { ok: true, answer: { ...answer, answer: text }, urlsStripped: stripped };
}
