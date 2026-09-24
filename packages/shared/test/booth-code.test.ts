import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BOOTH_CODE_ALPHABET,
  BOOTH_CODE_CHECK_REDRAWS,
  BOOTH_CODE_LENGTH,
  BOOTH_CODE_RANDOM_LENGTH,
  LEGACY_BOOTH_CODE_LENGTH,
  boothCodeCheckCharacter,
  isLegacyBoothCode,
  mintBoothCode,
  normaliseBoothCode,
  parseBoothCode,
  verifyBoothCode,
} from '../src/index';

/**
 * The voucher code a booth prints (S2-07a, D8), and its check character
 * (S2-10b).
 *
 * Nothing here tests randomness — the source is the caller's, which is the
 * point of the design — so what is tested is everything around it: that the
 * alphabet is the set it claims to be, that an index maps to a character with
 * no bias introduced in the middle, that a bad prefix or a bad index is
 * refused rather than printed, that a code read back off paper survives the
 * way people write it down, and that the check character catches the two
 * mistakes a person copying a slip actually makes: one wrong character, and
 * two neighbours swapped.
 */

/** Every character a code may be VALUED by, which is wider than the drawn alphabet. */
const SYMBOLS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A source that hands back 0, 1, 2 … (or from `start`) so the mapping is visible. */
const counter = (start = 0) => {
  let next = start;
  return () => next++ % BOOTH_CODE_ALPHABET.length;
};

/**
 * ISO/IEC 7064 MOD 37-2 as python-stdnum writes it (`stdnum/iso7064/mod_37_2.py`),
 * retyped here and NOT imported from the module under test, so a drift in the
 * module's arithmetic cannot drift this copy with it.
 */
const STANDARD_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ*';
const standardChecksum = (value: string): number => {
  let check = 0;
  for (const char of value) check = (2 * check + STANDARD_ALPHABET.indexOf(char)) % 37;
  return check;
};
const standardCheckDigit = (body: string): string =>
  STANDARD_ALPHABET[(((1 - 2 * standardChecksum(body)) % 37) + 37) % 37]!;
const standardIsValid = (value: string): boolean => standardChecksum(value) === 1;

/** A code a real box would print: the source `randomInt`, as `booth.ts` passes it. */
const minted = (prefix = 'B1'): string => mintBoothCode(prefix, (max) => randomInt(max));

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
  it('is a two-character prefix, eight drawn characters and a check character', () => {
    expect(BOOTH_CODE_LENGTH).toBe(11);
    const code = mintBoothCode('B1', counter());
    expect(code).toHaveLength(BOOTH_CODE_LENGTH);
    expect(code.slice(0, 2)).toBe('B1');
    // The counter's first draw, B123456789, has a printable check character (V).
    expect(code).toBe('B123456789V');
    expect(boothCodeCheckCharacter(code.slice(0, 10))).toBe(code.slice(10));
  });

  it('asks the source once per drawn character, for an index into the alphabet', () => {
    const asked: number[] = [];
    // B1 followed by eight 2s has a printable check (7), so this is one draw.
    const code = mintBoothCode('B1', (max) => {
      asked.push(max);
      return 0;
    });
    expect(code).toBe('B1222222227');
    expect(asked).toEqual(Array(BOOTH_CODE_RANDOM_LENGTH).fill(BOOTH_CODE_ALPHABET.length));
  });

  /**
   * About seven draws in thirty-seven have a check value that is not a symbol
   * the booth prints (`0 1 I L O U`, or the thirty-seventh value, which has no
   * symbol at all). Those are drawn again, whole, so a slip never carries an
   * ambiguous check character and every printable code stays equally likely.
   */
  it('draws all eight again when the check character would be unprintable', () => {
    // A counter starting at `A` draws B1ABCDEFGH first, whose check value is
    // `L` — one of the six the alphabet drops — so it draws JKMNPQRS next.
    expect(boothCodeCheckCharacter('B1ABCDEFGH')).toBeNull();
    expect(standardCheckDigit('B1ABCDEFGH')).toBe('L');
    let asked = 0;
    const next = counter(BOOTH_CODE_ALPHABET.indexOf('A'));
    const code = mintBoothCode('B1', () => {
      asked += 1;
      return next();
    });
    expect(code).toBe('B1JKMNPQRSB');
    expect(asked).toBe(2 * BOOTH_CODE_RANDOM_LENGTH);
  });

  it('refuses a source that never produces a printable code, rather than printing one', () => {
    // B0 followed by eight 2s needs a check value of 1 — the digit one, one of
    // the six characters the alphabet exists to drop — and a constant source
    // can only ever draw it again.
    expect(boothCodeCheckCharacter('B022222222')).toBeNull();
    expect(standardCheckDigit('B022222222')).toBe('1');
    let asked = 0;
    expect(() =>
      mintBoothCode('B0', () => {
        asked += 1;
        return 0;
      }),
    ).toThrow(/not random/);
    expect(asked).toBe(BOOTH_CODE_CHECK_REDRAWS * BOOTH_CODE_RANDOM_LENGTH);
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
    expect(mintBoothCode('B1', counter())).toMatch(/^B1/);
    expect(mintBoothCode('B0', counter())).toMatch(/^B0/);
    for (const bad of ['B', 'B12', 'B-', 'B ', '']) {
      expect(() => mintBoothCode(bad, () => 0)).toThrow(/prefix/);
    }
  });

  it('refuses an index the alphabet has no character for', () => {
    for (const bad of [-1, 30, 1.5, Number.NaN]) {
      expect(() => mintBoothCode('B1', () => bad)).toThrow(/random source/);
    }
  });

  it('produces codes that verify and parse, over the source a box actually uses', () => {
    for (let i = 0; i < 300; i += 1) {
      const code = minted();
      expect(verifyBoothCode(code)).toEqual({ ok: true, prefix: 'B1' });
      expect(parseBoothCode(code)?.code).toBe(code);
      // The check character is always one a person can read off a slip.
      expect(BOOTH_CODE_ALPHABET).toContain(code.slice(-1));
    }
  });
});

describe('the check character', () => {
  /**
   * The whole reason it exists (S2-10b): "a booth code with one altered
   * character shows 'Invalid code'". Every position, the prefix and the check
   * itself included, and every one of the thirty-six characters a person could
   * put there — not a sample of them.
   */
  it('catches every single-character error, in every position', () => {
    for (let n = 0; n < 60; n += 1) {
      const code = minted(n % 2 === 0 ? 'B1' : 'Z9');
      for (let i = 0; i < code.length; i += 1) {
        for (const symbol of SYMBOLS) {
          if (symbol === code[i]) continue;
          const altered = code.slice(0, i) + symbol + code.slice(i + 1);
          expect(verifyBoothCode(altered).ok, `${code} → ${altered}`).toBe(false);
        }
      }
    }
  });

  it('catches every swap of two neighbouring characters', () => {
    for (let n = 0; n < 400; n += 1) {
      const code = minted();
      for (let i = 0; i + 1 < code.length; i += 1) {
        if (code[i] === code[i + 1]) continue;
        const swapped = code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2);
        expect(verifyBoothCode(swapped).ok, `${code} → ${swapped}`).toBe(false);
      }
    }
  });

  it('is a known value for a known code, so the box, the till and a reviewer agree', () => {
    // ISO/IEC 7064 MOD 37-2: B1RT7KMQ4X needs W to bring the checksum of the
    // eleven characters to 1 modulo 37, the standard's target.
    expect(boothCodeCheckCharacter('B1RT7KMQ4X')).toBe('W');
    expect(standardCheckDigit('B1RT7KMQ4X')).toBe('W');
    expect(verifyBoothCode('B1RT7KMQ4XW')).toEqual({ ok: true, prefix: 'B1' });
  });

  /**
   * CONFORMANCE, not resemblance: a standard implementation of MOD 37-2 must
   * accept every code a booth prints and compute the same check character for
   * every body — and refuse the codes this module refuses. The copy above is
   * the standard's algorithm, written independently of the module.
   */
  it('is ISO/IEC 7064 MOD 37-2 exactly: a standard implementation agrees on every code', () => {
    for (let n = 0; n < 1000; n += 1) {
      const code = minted(n % 2 === 0 ? 'B1' : 'Z9');
      expect(standardIsValid(code), code).toBe(true);
      expect(standardCheckDigit(code.slice(0, 10)), code).toBe(code.slice(10));
    }
    for (let n = 0; n < 2000; n += 1) {
      let body = n % 2 === 0 ? 'B1' : 'A0';
      for (let i = 0; i < 8; i += 1) body += BOOTH_CODE_ALPHABET[randomInt(30)];
      const standard = standardCheckDigit(body);
      // The standard's answer, unless it is a character the booth never prints.
      const printable = BOOTH_CODE_ALPHABET.includes(standard) ? standard : null;
      expect(boothCodeCheckCharacter(body), body).toBe(printable);
      // And the two agree about every one of the thirty possible last characters.
      for (const last of BOOTH_CODE_ALPHABET) {
        expect(verifyBoothCode(body + last).ok, body + last).toBe(standardIsValid(body + last));
      }
    }
    // Sixty thousand comparisons: the CI runner needs more than vitest's 5 s default.
  }, 30_000);

  it('is only ever a character of the booth alphabet, or nothing', () => {
    for (let n = 0; n < 2000; n += 1) {
      let body = 'B1';
      for (let i = 0; i < 8; i += 1) body += BOOTH_CODE_ALPHABET[randomInt(30)];
      const check = boothCodeCheckCharacter(body);
      if (check !== null) expect(BOOTH_CODE_ALPHABET).toContain(check);
    }
    expect(boothCodeCheckCharacter('B1RT7KMQ4')).toBeNull();
    expect(boothCodeCheckCharacter('B1RT7KMQ4.')).toBeNull();
  });
});

describe('verifyBoothCode', () => {
  it('names why a code is not one', () => {
    expect(verifyBoothCode('B1RT7KMQ4X')).toEqual({ ok: false, reason: 'length' });
    expect(verifyBoothCode('B1RT7KMQ4XWW')).toEqual({ ok: false, reason: 'length' });
    expect(verifyBoothCode('ZZZZ9')).toEqual({ ok: false, reason: 'length' });
    // An O among the drawn characters, and a character no code carries.
    expect(verifyBoothCode('B1RT7KMQ4OW')).toEqual({ ok: false, reason: 'alphabet' });
    expect(verifyBoothCode('B1RT7KMQ4X.')).toEqual({ ok: false, reason: 'alphabet' });
    expect(verifyBoothCode('B1RT7KMQ4XV')).toEqual({ ok: false, reason: 'check' });
  });

  it('reads the code the way it was written down', () => {
    for (const written of [
      'B1RT7KMQ4XW',
      'b1-rt7k mq4x w',
      ' B1 RT7K-MQ4X W\n',
      'B1rt7kmq4xw\r\n',
    ]) {
      expect(verifyBoothCode(written)).toEqual({ ok: true, prefix: 'B1' });
    }
  });
});

describe('normaliseBoothCode', () => {
  it('upper-cases and drops spaces, dashes and a scanner’s line ending — and nothing else', () => {
    expect(normaliseBoothCode(' b1-rt7k mq4x w\r\n')).toBe('B1RT7KMQ4XW');
    // A stray character stays, so it is an invalid code rather than another one.
    expect(normaliseBoothCode('B1RT7KMQ4X.W')).toBe('B1RT7KMQ4X.W');
  });
});

describe('codes printed before the check character', () => {
  it('are ten characters of the old shape, and still recognised', () => {
    expect(LEGACY_BOOTH_CODE_LENGTH).toBe(10);
    expect(isLegacyBoothCode('B1RT7KMQ4X')).toBe(true);
    expect(isLegacyBoothCode('b1-rt7k mq4x')).toBe(true);
    // Eleven characters is the current shape, never the legacy one.
    expect(isLegacyBoothCode('B1RT7KMQ4XW')).toBe(false);
    expect(isLegacyBoothCode('B1RT7KMQ4O')).toBe(false);
  });
});

describe('parseBoothCode', () => {
  it('reads a current code back the way somebody wrote it down', () => {
    const expected = { code: 'B1RT7KMQ4XW', prefix: 'B1', random: 'RT7KMQ4X', check: 'W' };
    for (const written of ['B1RT7KMQ4XW', 'b1-rt7k mq4x w', ' B1 RT7K-MQ4X W ', 'B1rt7kmq4xw']) {
      expect(parseBoothCode(written)).toEqual(expected);
    }
  });

  it('reads a legacy ten-character code, with no check to hold it to', () => {
    expect(parseBoothCode('b1-rt7k mq4x')).toEqual({
      code: 'B1RT7KMQ4X',
      prefix: 'B1',
      random: 'RT7KMQ4X',
      check: null,
    });
  });

  it('refuses a current-length code with the wrong check, which is a mistyped code', () => {
    expect(parseBoothCode('B1RT7KMQ4XV')).toBeNull();
  });

  it('refuses the legacy spin codes, which live in the same table', () => {
    for (const legacy of ['4821', 'A123', 'B12']) {
      expect(parseBoothCode(legacy)).toBeNull();
    }
  });

  it('refuses the wrong length and characters the booth never prints', () => {
    for (const bad of ['B1RT7KMQ4', 'B1RT7KMQ4XWW', 'B1RT7KMQ4O', 'B1RT7KMQ4I', 'B1RT7KMQ40']) {
      expect(parseBoothCode(bad)).toBeNull();
    }
  });
});
