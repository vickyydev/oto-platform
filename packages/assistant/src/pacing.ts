/**
 * Typing time (PLAN §B.6, mechanism 3). Each AI message is queued with a
 * `next_attempt_at` in the future; the send claim already refuses a row
 * before that, so the rails hold it back.
 *
 *   first bubble   clamp(chars / 6 per second, 3 s, 20 s), then ±25 % jitter
 *   each further   a further 2–6 s after the previous one
 *
 * Deterministic under an injected `random` (a function returning [0, 1)).
 */

export const TYPING_CHARS_PER_SECOND = 6;
export const TYPING_MIN_MS = 3_000;
export const TYPING_MAX_MS = 20_000;
export const TYPING_JITTER = 0.25;
export const BUBBLE_GAP_MIN_MS = 2_000;
export const BUBBLE_GAP_MAX_MS = 6_000;

export type RandomSource = () => number;

function unit(random: RandomSource): number {
  const r = random();
  // A misbehaving source must not produce an instant or an endless delay.
  if (!Number.isFinite(r) || r < 0) return 0;
  return r >= 1 ? 1 - Number.EPSILON : r;
}

/** The first bubble's typing time, before jitter. */
export function typingMs(chars: number): number {
  const raw = (Math.max(0, chars) / TYPING_CHARS_PER_SECOND) * 1000;
  return Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, raw));
}

/**
 * Delays, in ms from the decision's commit, at which each bubble falls due.
 * Strictly increasing, so the bubbles leave in order.
 */
export function bubbleDelaysMs(
  bubbles: readonly string[],
  random: RandomSource = Math.random,
): number[] {
  const out: number[] = [];
  bubbles.forEach((bubble, i) => {
    if (i === 0) {
      const jitter = 1 + (unit(random) * 2 - 1) * TYPING_JITTER;
      out.push(Math.round(typingMs([...bubble].length) * jitter));
    } else {
      const gap = BUBBLE_GAP_MIN_MS + unit(random) * (BUBBLE_GAP_MAX_MS - BUBBLE_GAP_MIN_MS);
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
): Date[] {
  return bubbleDelaysMs(bubbles, random).map((ms) => new Date(now.getTime() + ms));
}
