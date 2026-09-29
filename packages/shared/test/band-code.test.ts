import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BAND_CODE_ALPHABET,
  BAND_CODE_BODY_LENGTH,
  BAND_CODE_SIGNATURE_LENGTH,
  BOOTH_CODE_ALPHABET,
  bandShortCode,
  hmacSha256,
  isBandCodeShape,
  mintBandCode,
  newId,
  parseBandCode,
  parseBandShortCode,
  sha256,
  ulidFromUuid,
  ulidOfBandCode,
  uuidFromUlid,
  verifyBandCode,
} from '../src/index';

/**
 * The signed band code (S2-11). What the gate trusts, so what is tested is
 * the part a gate relies on: the same key verifies what it minted, a changed
 * character anywhere fails, another park's key fails, the code names its band
 * row with no lookup, and the characters after the prefix are the ones a Thai
 * keyboard cannot confuse.
 */

const KEY = 'test-band-key-0123456789';
const OTHER_KEY = 'another-park-key-987654321';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('the hash underneath is SHA-256 and HMAC exactly as node:crypto computes them', () => {
  it('agrees on empty, short, block-boundary and long inputs', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 200]) {
      const input = randomBytes(length);
      expect(hex(sha256(new Uint8Array(input)))).toBe(createHash('sha256').update(input).digest('hex'));
    }
  });

  it('agrees on HMAC with short and over-long keys', () => {
    for (const key of ['k', KEY, 'x'.repeat(64), 'y'.repeat(130)]) {
      const message = `T1${'2'.repeat(27)}`;
      expect(hex(hmacSha256(key, message))).toBe(createHmac('sha256', key).update(message).digest('hex'));
    }
  });
});

describe('minting and verifying', () => {
  it('verifies what it minted, and the code names its band row', () => {
    const bandId = newId();
    const code = mintBandCode('T1', ulidFromUuid(bandId), KEY);
    const verified = verifyBandCode(code, KEY);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.prefix).toBe('T1');
    expect(verified.bandId).toBe(bandId);
    expect(verified.ulid).toBe(ulidFromUuid(bandId));
    expect(uuidFromUlid(verified.ulid)).toBe(bandId);
  });

  it('has the documented shape: prefix, 27 body characters, a dot, 12 signature characters', () => {
    const code = mintBandCode('T1', ulidFromUuid(newId()), KEY);
    expect(code).toMatch(new RegExp(`^T1[${BAND_CODE_ALPHABET}]{${BAND_CODE_BODY_LENGTH}}\\.[${BAND_CODE_ALPHABET}]{${BAND_CODE_SIGNATURE_LENGTH}}$`));
    expect(code.length).toBe(2 + 27 + 1 + 12);
  });

  it('never uses 0, 1, I, L, O or U after the prefix', () => {
    expect(BAND_CODE_ALPHABET).toBe(BOOTH_CODE_ALPHABET);
    for (let i = 0; i < 200; i += 1) {
      const code = mintBandCode('T1', ulidFromUuid(newId()), KEY);
      expect(code.slice(2)).not.toMatch(/[01ILOU]/);
    }
  });

  it('fails a code with any one character changed — prefix, body or signature', () => {
    const code = mintBandCode('T1', ulidFromUuid(newId()), KEY);
    for (let i = 0; i < code.length; i += 1) {
      if (code[i] === '.') continue;
      const replacement = i < 2 ? (code[i] === 'T' ? 'B' : '2') : code[i] === 'Z' ? 'Y' : 'Z';
      const tampered = `${code.slice(0, i)}${replacement}${code.slice(i + 1)}`;
      const verdict = verifyBandCode(tampered, KEY);
      expect(verdict.ok, `position ${i}`).toBe(false);
    }
  });

  it('fails under another park’s key, and says it was the signature', () => {
    const code = mintBandCode('T1', ulidFromUuid(newId()), KEY);
    expect(verifyBandCode(code, OTHER_KEY)).toEqual({ ok: false, reason: 'signature' });
  });

  it('answers format for strings that are not band codes', () => {
    for (const raw of ['', 'B1RT7KMQ4XW', '8850000000017', 'T1.ABC', `T1${'2'.repeat(27)}`]) {
      expect(verifyBandCode(raw, KEY)).toEqual({ ok: false, reason: 'format' });
      expect(isBandCodeShape(raw)).toBe(false);
    }
  });

  it('reads a lower-case or space-padded scan as the same code', () => {
    const code = mintBandCode('t1', ulidFromUuid(newId()), KEY);
    expect(code.startsWith('T1')).toBe(true);
    expect(verifyBandCode(`  ${code.toLowerCase()}\n`, KEY).ok).toBe(true);
  });

  it('refuses a bad prefix, a non-ULID and a short key rather than printing a wrong band', () => {
    const ulid = ulidFromUuid(newId());
    expect(() => mintBandCode('T-1', ulid, KEY)).toThrow(/prefix/);
    expect(() => mintBandCode('TOOLONG1', ulid, KEY)).toThrow(/prefix/);
    expect(() => mintBandCode('T1', 'not-a-ulid', KEY)).toThrow(/ULID/);
    expect(() => mintBandCode('T1', ulid, 'short')).toThrow(/at least/);
  });

  it('keeps time order: a later band sorts after an earlier one', async () => {
    const first = mintBandCode('T1', ulidFromUuid(newId()), KEY);
    await new Promise((resolve) => setTimeout(resolve, 3));
    const second = mintBandCode('T1', ulidFromUuid(newId()), KEY);
    expect(parseBandCode(first)!.body < parseBandCode(second)!.body).toBe(true);
  });

  it('pins one worked example, so the format cannot drift unnoticed', () => {
    const bandId = '0192f3a4-5b6c-7d8e-9fa0-b1c2d3e4f506';
    const code = mintBandCode('T1', ulidFromUuid(bandId), 'example-band-key-not-secret');
    expect(ulidFromUuid(bandId)).toBe('01JBST8PVCFP79Z85HRB9Y9X86');
    expect(code).toBe('T1229E98P2DRXHTB6MKV5J2D4DQD2.AJRVQ9V6FDME');
    expect(bandShortCode(code)).toBe('T1-D4DQD2');
    expect(verifyBandCode(code, 'example-band-key-not-secret')).toMatchObject({ ok: true, bandId });
    expect(ulidOfBandCode(code)).toBe('01JBST8PVCFP79Z85HRB9Y9X86');
  });
});

describe('the short code', () => {
  it('is the prefix and the last six body characters, and reads back', () => {
    const code = mintBandCode('T1', ulidFromUuid(newId()), KEY);
    const short = bandShortCode(code)!;
    expect(short).toMatch(new RegExp(`^T1-[${BAND_CODE_ALPHABET}]{6}$`));
    expect(short.slice(3)).toBe(parseBandCode(code)!.body.slice(-6));
    expect(parseBandShortCode(short.toLowerCase())).toEqual({ prefix: 'T1', tail: short.slice(3) });
    expect(parseBandShortCode('T1-ABC')).toBeNull();
    expect(parseBandShortCode('T1-OOOOOO')).toBeNull();
  });
});
