import { describe, expect, it } from 'vitest';
import {
  BUBBLE_GAP_MAX_MS,
  BUBBLE_GAP_MIN_MS,
  DEFAULT_PACING,
  bubbleDelaysMs,
  scheduleBubbles,
  TYPING_JITTER,
  TYPING_MAX_MS,
  TYPING_MIN_MS,
  typingMs,
} from '../src/pacing';

/** A seeded generator, so a sweep is reproducible. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('the two knobs (PLAN §B.6; test night 2026-10-21, P)', () => {
  it('default to today’s values: a 20 s first-bubble ceiling, a 6 s gap ceiling', () => {
    expect(DEFAULT_PACING).toEqual({ firstBubbleMaxMs: 20_000, bubbleGapMaxMs: 6_000 });
    expect(bubbleDelaysMs(['x'.repeat(60), 'y'], () => 0.5)).toEqual(bubbleDelaysMs(['x'.repeat(60), 'y'], () => 0.5, DEFAULT_PACING));
  });

  it('a lower first-bubble ceiling caps the typing time, and pulls the 3 s floor down with it', () => {
    expect(typingMs(400, { firstBubbleMaxMs: 5_000, bubbleGapMaxMs: 6_000 })).toBe(5_000);
    expect(typingMs(0, { firstBubbleMaxMs: 5_000, bubbleGapMaxMs: 6_000 })).toBe(TYPING_MIN_MS);
    expect(typingMs(0, { firstBubbleMaxMs: 1_000, bubbleGapMaxMs: 6_000 })).toBe(1_000);
    expect(typingMs(400, { firstBubbleMaxMs: 0, bubbleGapMaxMs: 6_000 })).toBe(0);
  });

  it('a lower gap ceiling bounds every further bubble, down to no gap at all', () => {
    const tight = { firstBubbleMaxMs: 20_000, bubbleGapMaxMs: 3_000 };
    const d = bubbleDelaysMs(['one', 'two', 'three'], () => 0.999999, tight);
    expect(d[1]! - d[0]!).toBeLessThanOrEqual(3_000);
    expect(d[2]! - d[1]!).toBeLessThanOrEqual(3_000);
    expect(d[1]! - d[0]!).toBeGreaterThanOrEqual(BUBBLE_GAP_MIN_MS);
    const none = bubbleDelaysMs(['one', 'two'], () => 0.5, { firstBubbleMaxMs: 0, bubbleGapMaxMs: 0 });
    expect(none).toEqual([0, 0]);
  });

  it('a knob that is not a number falls back to today’s value', () => {
    expect(typingMs(400, { firstBubbleMaxMs: Number.NaN, bubbleGapMaxMs: 6_000 })).toBe(TYPING_MAX_MS);
    const d = bubbleDelaysMs(['one', 'two'], () => 0.999999, { firstBubbleMaxMs: 20_000, bubbleGapMaxMs: -1 });
    expect(d[1]! - d[0]!).toBeLessThanOrEqual(BUBBLE_GAP_MAX_MS);
  });

  it('schedules with the knobs', () => {
    const now = new Date('2026-10-20T07:00:00.000Z');
    const at = scheduleBubbles(now, ['one', 'two'], () => 0.5, { firstBubbleMaxMs: 1_000, bubbleGapMaxMs: 2_000 });
    expect(at.map((d) => d.getTime() - now.getTime())).toEqual([1_000, 3_000]);
  });
});

describe('typing time (PLAN §B.6)', () => {
  it('is chars / 6 per second, clamped to 3–20 s', () => {
    expect(typingMs(0)).toBe(TYPING_MIN_MS);
    expect(typingMs(12)).toBe(TYPING_MIN_MS);
    expect(typingMs(60)).toBe(10_000);
    expect(typingMs(120)).toBe(TYPING_MAX_MS);
    expect(typingMs(400)).toBe(TYPING_MAX_MS);
  });

  it('jitter is ±25 %: a random of 0 is the floor, 0.5 the centre, just under 1 the ceiling', () => {
    expect(bubbleDelaysMs(['x'.repeat(60)], () => 0)).toEqual([7_500]);
    expect(bubbleDelaysMs(['x'.repeat(60)], () => 0.5)).toEqual([10_000]);
    expect(bubbleDelaysMs(['x'.repeat(60)], () => 0.999999)).toEqual([12_500]);
  });

  it('is deterministic under an injected random', () => {
    const bubbles = ['สวัสดีค่ะ 😊', 'สะดวกมาสาขาไหนคะ'];
    expect(bubbleDelaysMs(bubbles, seeded(42))).toEqual(bubbleDelaysMs(bubbles, seeded(42)));
  });

  it('every delay stays within its bounds, bubbles leave in order 2–6 s apart', () => {
    const rand = seeded(7);
    for (let run = 0; run < 500; run++) {
      const n = 1 + Math.floor(rand() * 3);
      const bubbles = Array.from({ length: n }, () => 'a'.repeat(Math.floor(rand() * 400)));
      const d = bubbleDelaysMs(bubbles, rand);
      expect(d[0]!).toBeGreaterThanOrEqual(TYPING_MIN_MS * (1 - TYPING_JITTER));
      expect(d[0]!).toBeLessThanOrEqual(TYPING_MAX_MS * (1 + TYPING_JITTER));
      for (let i = 1; i < d.length; i++) {
        const gap = d[i]! - d[i - 1]!;
        expect(gap).toBeGreaterThanOrEqual(BUBBLE_GAP_MIN_MS);
        expect(gap).toBeLessThanOrEqual(BUBBLE_GAP_MAX_MS);
      }
    }
  });

  it('a misbehaving random never yields an instant or an endless delay', () => {
    for (const bad of [Number.NaN, -1, 5, Number.POSITIVE_INFINITY]) {
      const [first] = bubbleDelaysMs(['hello'], () => bad);
      expect(first!).toBeGreaterThanOrEqual(TYPING_MIN_MS * (1 - TYPING_JITTER));
      expect(first!).toBeLessThanOrEqual(TYPING_MAX_MS * (1 + TYPING_JITTER));
    }
  });

  it('schedules each bubble as a next_attempt_at after now', () => {
    const now = new Date('2026-10-20T07:00:00.000Z');
    const at = scheduleBubbles(now, ['one', 'two'], () => 0.5);
    expect(at.map((d) => d.getTime() - now.getTime())).toEqual([3_000, 7_000]);
  });
});
