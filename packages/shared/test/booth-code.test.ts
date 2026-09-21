import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BOOTH_CODE_ALPHABET,
  BOOTH_CODE_LENGTH,
  BOOTH_CODE_RANDOM_LENGTH,
  mintBoothCode,
  parseBoothCode,
} from '../src/index';

/**
 * The voucher code a booth prints (S2-07a, D8).
 *
 * Nothing here tests randomness — the source is the caller's, which is the
 * point of the design — so what is tested is everything around it: that the
 * alphabet is the set it claims to be, that an index maps to a character with
 * no bias introduced in the middle, that a bad prefix or a bad index is
 * refused rather than printed, and that a code read back off paper survives
 * the way people write it down.
 */

describe('the unambiguous alphabet', () => {
  it('is thirty distinct characters', () => {
    expect(BOOTH_CODE_ALPHABET).toHaveLength(30);
    expect(new Set(BOOTH_CODE_ALPHABET).size).toBe(30);
  });

  it('drops every pair whose members would otherwise both be printed', () => {
    for (const excluded of ['0', '1', 'I', 'L', 'O', 'U']) {
      expect(BOOTH_CODE_ALPHABET).not.toContain(excluded);
    }
  });

  /**
   * Asserted as a FACT, not as a virtue. `5`/`S`, `2`/`Z`, `8`/`B` and `6`/`G`
   * are all in the set and are confusable on a thermal slip; the module says
   * so and this is what makes that statement checkable. If somebody narrows
   * the alphabet later, this test fails and they read the reasoning before
   * deciding whether to delete it.
   */
  it('still contains the pairs it cannot normalise', () => {
    for (const kept of ['5', 'S', '2', 'Z', '8', 'B', '6', 'G']) {
      expect(BOOTH_CODE_ALPHABET).toContain(kept);
    }
  });
});

describe('mintBoothCode', () => {
  /** A source that hands back 0, 1, 2 … so the mapping is visible. */
  const counter = () => {
    let next = 0;
    return () => next++ % BOOTH_CODE_ALPHABET.length;
  };

  it('is a two-character prefix and eight drawn characters', () => {
    const code = mintBoothCode('B1', counter());
    expect(code).toHaveLength(BOOTH_CODE_LENGTH);
    expect(code.slice(0, 2)).toBe('B1');
    expect(code).toBe(`B1${BOOTH_CODE_ALPHABET.slice(0, BOOTH_CODE_RANDOM_LENGTH)}`);
  });

  it('asks the source once per character, for an index into the alphabet', () => {
    const asked: number[] = [];
    mintBoothCode('B1', (max) => {
      asked.push(max);
      return 0;
    });
    expect(asked).toEqual(Array(BOOTH_CODE_RANDOM_LENGTH).fill(BOOTH_CODE_ALPHABET.length));
  });

  it('uppercases the prefix, because paper and QR must agree', () => {
    expect(mintBoothCode('b1', () => 0).slice(0, 2)).toBe('B1');
  });

  /**
   * The prefix is the park's own label, so `B1` and `B0` are legal even though
   * `1` and `0` are not in the drawn alphabet — Booth 1 is called B1 by the
   * people working at it. What is refused is a prefix that is not two
   * printable alphanumerics.
   */
  it('takes the booth label as it is, and refuses what it cannot print', () => {
    expect(mintBoothCode('B1', () => 0)).toMatch(/^B1/);
    expect(mintBoothCode('B0', () => 0)).toMatch(/^B0/);
    for (const bad of ['B', 'B12', 'B-', 'B ', '']) {
      expect(() => mintBoothCode(bad, () => 0)).toThrow(/prefix/);
    }
  });

  it('refuses an index the alphabet has no character for', () => {
    for (const bad of [-1, 30, 1.5, Number.NaN]) {
      expect(() => mintBoothCode('B1', () => bad)).toThrow(/random source/);
    }
  });

  it('produces codes that parse, over the source a box actually uses', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = mintBoothCode('B1', (max) => randomInt(max));
      expect(parseBoothCode(code)?.code).toBe(code);
    }
  });
});

describe('parseBoothCode', () => {
  it('reads a code back the way somebody wrote it down', () => {
    const expected = { code: 'B1RT7KMQ4X', prefix: 'B1', random: 'RT7KMQ4X' };
    for (const written of ['B1RT7KMQ4X', 'b1-rt7k mq4x', ' B1 RT7K-MQ4X ', 'B1rt7kmq4x']) {
      expect(parseBoothCode(written)).toEqual(expected);
    }
  });

  it('refuses the legacy spin codes, which live in the same table', () => {
    for (const legacy of ['4821', 'A123', 'B12']) {
      expect(parseBoothCode(legacy)).toBeNull();
    }
  });

  it('refuses the wrong length and characters the booth never prints', () => {
    for (const bad of ['B1RT7KMQ4', 'B1RT7KMQ4XY', 'B1RT7KMQ4O', 'B1RT7KMQ4I', 'B1RT7KMQ40']) {
      expect(parseBoothCode(bad)).toBeNull();
    }
  });
});
