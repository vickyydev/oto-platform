/**
 * Typing time (PLAN §B.6, mechanism 3). Each AI message is queued with a
 * `next_attempt_at` in the future; the send claim already refuses a row
 * before that, so the rails hold it back.
 *
 *   first bubble   clamp(chars / 6 per second, 3 s, FIRST), then ±25 % jitter
 *   each further   a further 2 s to GAP after the previous one
 *
 * FIRST and GAP are the two knobs the park can turn (test night 2026-10-21,
 * P): `INBOX_AI_FIRST_BUBBLE_MS` and `INBOX_AI_BUBBLE_GAP_MS`, read by the
 * api into a `PacingConfig`. Their defaults are the values above (20 s and
 * 6 s), so nothing changes until somebody sets them. A floor never exceeds
 * its ceiling: a first-bubble ceiling of 1 s makes the floor 1 s too.
 *
 * Deterministic under an injected `random` (a function returning [0, 1)).
 */

export const TYPING_CHARS_PER_SECOND = 6;
export const TYPING_MIN_MS = 3_000;
export const TYPING_MAX_MS = 20_000;
export const TYPING_JITTER = 0.25;
export const BUBBLE_GAP_MIN_MS = 2_000;
export const BUBBLE_GAP_MAX_MS = 6_000;

/** The two pacing knobs (§B.6; test night P). */
export interface PacingConfig {
  /** The longest the first bubble's typing time can be, in ms (`INBOX_AI_FIRST_BUBBLE_MS`). */
  firstBubbleMaxMs: number;
  /** The longest gap between one bubble and the next, in ms (`INBOX_AI_BUBBLE_GAP_MS`). */
  bubbleGapMaxMs: number;
}

/** Today's values: what the park had before the knobs existed. */
export const DEFAULT_PACING: PacingConfig = {
  firstBubbleMaxMs: TYPING_MAX_MS,
  bubbleGapMaxMs: BUBBLE_GAP_MAX_MS,
};

export type RandomSource = () => number;

function unit(random: RandomSource): number {
  const r = random();
  // A misbehaving source must not produce an instant or an endless delay.
  if (!Number.isFinite(r) || r < 0) return 0;
  return r >= 1 ? 1 - Number.EPSILON : r;
}

/** A knob read as a whole number of milliseconds, never negative, never NaN. */
function ms(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
}

/** The first bubble's typing time, before jitter. */
export function typingMs(chars: number, pacing: PacingConfig = DEFAULT_PACING): number {
  const max = ms(pacing.firstBubbleMaxMs, TYPING_MAX_MS);
  const min = Math.min(TYPING_MIN_MS, max);
  const raw = (Math.max(0, chars) / TYPING_CHARS_PER_SECOND) * 1000;
  return Math.min(max, Math.max(min, raw));
}

/**
 * Delays, in ms from the decision's commit, at which each bubble falls due.
 * Strictly increasing while the gap ceiling is above zero, so the bubbles
 * leave in order; at a ceiling of zero they fall due together and the ids
 * (written a millisecond apart) still order them.
 */
export function bubbleDelaysMs(
  bubbles: readonly string[],
  random: RandomSource = Math.random,
  pacing: PacingConfig = DEFAULT_PACING,
): number[] {
  const gapMax = ms(pacing.bubbleGapMaxMs, BUBBLE_GAP_MAX_MS);
  const gapMin = Math.min(BUBBLE_GAP_MIN_MS, gapMax);
  const out: number[] = [];
  bubbles.forEach((bubble, i) => {
    if (i === 0) {
      const jitter = 1 + (unit(random) * 2 - 1) * TYPING_JITTER;
      out.push(Math.round(typingMs([...bubble].length, pacing) * jitter));
    } else {
      const gap = gapMin + unit(random) * (gapMax - gapMin);
      out.push(out[i - 1]! + Math.round(gap));
    }
  });
  return out;
}

/** The `next_attempt_at` of each bubble. */
export function scheduleBubbles(
  now: Date,
  bubbles: readonly string[],
  random: RandomSource = Math.random,
  pacing: PacingConfig = DEFAULT_PACING,
): Date[] {
  return bubbleDelaysMs(bubbles, random, pacing).map((delay) => new Date(now.getTime() + delay));
}
