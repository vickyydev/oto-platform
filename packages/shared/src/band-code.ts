import { BOOTH_CODE_ALPHABET } from './booth-code';

/**
 * The signed band code (S2-11, DEVICE_INVENTORY §4 D4, PROJECT_CONTEXT §8).
 *
 * A band code is the credential a wristband carries: the gate admits a guest
 * on it, and a box with no internet has to be able to tell a band this park
 * printed from one somebody made up. So it is SIGNED, and the signature is
 * checkable with nothing but the string and the park's key — no table, no
 * network. It is one module, in `@oto/shared`, so the platform that mints a
 * band today and the box that will mint and verify one offline tomorrow
 * (SCRUM-269) run the same arithmetic rather than two copies of it.
 *
 * THE SHAPE, worked through once:
 *
 *   T1 · 2B7Q…(27)… · . · K4MX…(12)…
 *   ^^   ^^^^^^^^^^^^   ^   ^^^^^^^^^^^^
 *   │    │              │   └ signature: HMAC-SHA256(BAND_HMAC_KEY, prefix + body),
 *   │    │              │     first 8 bytes, in the band alphabet, 12 characters
 *   │    │              └ the one separator
 *   │    └ body: the band's ULID — 128 bits, the band row's own UUIDv7 id — in
 *   │      the band alphabet, 27 characters, fixed width, time-sortable
 *   └ station prefix: `core.station.code_prefix`, e.g. `T1`, as the park names it
 *
 * **The alphabet after the prefix is the booth's** (`BOOTH_CODE_ALPHABET`, D8):
 * no `0 1 I L O U`, so a code read off a band and typed on a Thai keyboard at
 * reception cannot be mistyped into another one by those pairs. That makes the
 * alphabet thirty characters, which is why the body and the signature are
 * radix-30 rather than the base32 the ULID specification uses — Crockford's
 * base32 keeps `0` and `1`, and a ULID minted this year always starts with
 * `0`. The ULID is the same 128 bits either way; only the spelling differs,
 * and `ulidOfBandCode` gives back the standard spelling.
 *
 * **The prefix is signed with the body.** A signature over the body alone
 * would let a tampered prefix through — `T2…` for `T1…` would still verify,
 * and "which till printed this band" would be a question the band could lie
 * about. So the MAC covers everything before the separator.
 *
 * **The body IS the band's id.** A UUIDv7 and a ULID are the same thing — a
 * 48-bit millisecond timestamp and 80 bits of randomness in 128 — so the
 * band row's own id is the ULID, and a verified code names its band record
 * with no lookup at all (`VerifiedBandCode.bandId`). That is what lets a box
 * resolve a scan offline, and what makes a reprint keep the same code: same
 * row, same id, same code.
 *
 * **Every character is QR alphanumeric.** Digits, upper-case letters and `.`
 * are all in the QR alphanumeric set, so the whole code packs at 5.5 bits a
 * character. A code is at most 6 + 27 + 1 + 12 = 46 characters, which is a
 * version-3 QR at ECC M — the size the band template draws at 4 dots a module.
 *
 * WHY 12 SIGNATURE CHARACTERS. 30^12 is about 5.3 × 10^17, a little under
 * 59 bits. A forger has to hit that at a gate that reads one band a second, in
 * front of staff; the length is chosen so the QR stays small on a 25 mm band,
 * not for resistance to an offline search, which a MAC with a secret key does
 * not face anyway — nobody can test a guess without the key.
 *
 * NOTHING HERE READS A CLOCK OR A RANDOM SOURCE, and nothing imports
 * `node:crypto`: `@oto/shared` is bundled into the browser, and a Node-only
 * import in the barrel breaks the POS build (the rule `booth-code.ts` states).
 * SHA-256 and HMAC are therefore implemented below, and pinned against
 * `node:crypto` by `test/band-code.test.ts`.
 */

/** The thirty characters a band code uses after its prefix. See the file header. */
export const BAND_CODE_ALPHABET = BOOTH_CODE_ALPHABET;
/** 128 bits in radix 30: 30^26 < 2^128 <= 30^27. */
export const BAND_CODE_BODY_LENGTH = 27;
/** About 59 bits. See the file header for why not more. */
export const BAND_CODE_SIGNATURE_LENGTH = 12;
export const BAND_CODE_SEPARATOR = '.';
/**
 * A station prefix as the park writes it: upper-case letters and digits, one
 * to six of them (`T1`, `B1`, `HKT1`). Unlike the body it may use `0` and `1`
 * — the park named its tills before this code existed, and a rule outlawing
 * `T1` would be a rule somebody works around (`booth-code.ts` makes the same
 * call for the booth prefix).
 */
export const BAND_CODE_PREFIX_PATTERN = /^[0-9A-Z]{1,6}$/;
/** How many body characters the short code shows. 30^6 is 729 million. */
export const BAND_SHORT_CODE_TAIL = 6;
/** Keys shorter than this are refused: a band key is a secret, not a label. */
export const BAND_KEY_MIN_BYTES = 16;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RADIX = BigInt(BAND_CODE_ALPHABET.length);
const MAX_128 = (1n << 128n) - 1n;
const SIGNATURE_SPACE = RADIX ** BigInt(BAND_CODE_SIGNATURE_LENGTH);

// --- ULID and UUID ------------------------------------------------------------

function ulidToBigInt(ulid: string): bigint {
  const upper = ulid.trim().toUpperCase();
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(upper)) {
    throw new Error(`Not a ULID: ${JSON.stringify(ulid)}`);
  }
  let value = 0n;
  for (const ch of upper) value = value * 32n + BigInt(CROCKFORD.indexOf(ch));
  return value;
}

function bigIntToUlid(value: bigint): string {
  let out = '';
  let rest = value;
  for (let i = 0; i < 26; i += 1) {
    out = (CROCKFORD[Number(rest % 32n)] ?? '0') + out;
    rest /= 32n;
  }
  return out;
}

function uuidToBigInt(uuid: string): bigint {
  const hex = uuid.trim().toLowerCase().replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`Not a UUID: ${JSON.stringify(uuid)}`);
  return BigInt(`0x${hex}`);
}

function bigIntToUuid(value: bigint): string {
  const hex = value.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The ULID spelling of a UUID — for a band, its row id — in Crockford base32. */
export function ulidFromUuid(uuid: string): string {
  return bigIntToUlid(uuidToBigInt(uuid));
}

/** The UUID spelling of a ULID: the band row id a code names. */
export function uuidFromUlid(ulid: string): string {
  return bigIntToUuid(ulidToBigInt(ulid));
}

// --- Radix 30 -------------------------------------------------------------------

function encodeRadix30(value: bigint, width: number): string {
  let out = '';
  let rest = value;
  for (let i = 0; i < width; i += 1) {
    out = (BAND_CODE_ALPHABET[Number(rest % RADIX)] ?? '') + out;
    rest /= RADIX;
  }
  if (rest !== 0n) throw new Error('value does not fit the width');
  return out;
}

function decodeRadix30(text: string): bigint | null {
  let value = 0n;
  for (const ch of text) {
    const digit = BAND_CODE_ALPHABET.indexOf(ch);
    if (digit < 0) return null;
    value = value * RADIX + BigInt(digit);
  }
  return value;
}

// --- SHA-256 and HMAC (FIPS 180-4, RFC 2104) -----------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of some bytes. Exported for the test that pins it to `node:crypto`. */
export function sha256(message: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLength = message.length * 8;
  const padded = new Uint8Array(Math.ceil((message.length + 9) / 64) * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  // Messages here are a few dozen bytes; the high word of the length is zero.
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const w = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i]!);
  return out;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** HMAC-SHA256. Exported for the test that pins it to `node:crypto`. */
export function hmacSha256(key: string | Uint8Array, message: string | Uint8Array): Uint8Array {
  let k = typeof key === 'string' ? utf8(key) : key;
  if (k.length > 64) k = sha256(k);
  const block = new Uint8Array(64);
  block.set(k);
  const inner = new Uint8Array(64);
  const outer = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) {
    inner[i] = block[i]! ^ 0x36;
    outer[i] = block[i]! ^ 0x5c;
  }
  const msg = typeof message === 'string' ? utf8(message) : message;
  const innerInput = new Uint8Array(64 + msg.length);
  innerInput.set(inner);
  innerInput.set(msg, 64);
  const innerHash = sha256(innerInput);
  const outerInput = new Uint8Array(64 + 32);
  outerInput.set(outer);
  outerInput.set(innerHash, 64);
  return sha256(outerInput);
}

// --- Minting and verifying ------------------------------------------------------

function keyBytes(key: string | Uint8Array): Uint8Array {
  const bytes = typeof key === 'string' ? utf8(key) : key;
  if (bytes.length < BAND_KEY_MIN_BYTES) {
    throw new Error(`A band key is at least ${BAND_KEY_MIN_BYTES} bytes`);
  }
  return bytes;
}

function signatureOf(head: string, key: Uint8Array): string {
  const mac = hmacSha256(key, head);
  let value = 0n;
  for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(mac[i]!);
  return encodeRadix30(value % SIGNATURE_SPACE, BAND_CODE_SIGNATURE_LENGTH);
}

/**
 * Mint the code for one band.
 *
 * `ulid` is the band's ULID in its standard Crockford spelling — for a band
 * row, `ulidFromUuid(band.id)`. `key` is `BAND_HMAC_KEY`.
 *
 * @throws on a prefix that is not one to six upper-case letters or digits
 *   (lower case is upper-cased first), on a string that is not a ULID, and on
 *   a key shorter than `BAND_KEY_MIN_BYTES`. A band printed with a code of the
 *   wrong shape is worse than a band not printed.
 */
export function mintBandCode(prefix: string, ulid: string, key: string | Uint8Array): string {
  const station = prefix.trim().toUpperCase();
  if (!BAND_CODE_PREFIX_PATTERN.test(station)) {
    throw new Error(`A band code prefix is one to six letters or digits; got ${JSON.stringify(prefix)}`);
  }
  const body = encodeRadix30(ulidToBigInt(ulid), BAND_CODE_BODY_LENGTH);
  const head = `${station}${body}`;
  return `${head}${BAND_CODE_SEPARATOR}${signatureOf(head, keyBytes(key))}`;
}

/** The parts of a well-formed code, before anybody has checked its signature. */
export interface ParsedBandCode {
  /** The code as the table stores it: trimmed and upper-cased. */
  code: string;
  prefix: string;
  /** The 27 body characters. */
  body: string;
  signature: string;
  /** The standard Crockford spelling of the body. */
  ulid: string;
  /** The band row the code names. */
  bandId: string;
}

/** How a code read at a counter is put into the one form the table stores. */
export function normaliseBandCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Read a code's parts WITHOUT checking its signature — for a lookup, where the
 * database is the authority and the key is not needed. Null for anything that
 * is not the shape of a band code. Never admit anybody on this alone.
 */
export function parseBandCode(raw: string): ParsedBandCode | null {
  const code = normaliseBandCode(raw);
  const at = code.indexOf(BAND_CODE_SEPARATOR);
  if (at < 0 || at !== code.lastIndexOf(BAND_CODE_SEPARATOR)) return null;
  const head = code.slice(0, at);
  const signature = code.slice(at + 1);
  if (head.length <= BAND_CODE_BODY_LENGTH) return null;
  const prefix = head.slice(0, head.length - BAND_CODE_BODY_LENGTH);
  const body = head.slice(head.length - BAND_CODE_BODY_LENGTH);
  if (!BAND_CODE_PREFIX_PATTERN.test(prefix)) return null;
  if (signature.length !== BAND_CODE_SIGNATURE_LENGTH || decodeRadix30(signature) === null) {
    return null;
  }
  const value = decodeRadix30(body);
  if (value === null || value > MAX_128) return null;
  return {
    code,
    prefix,
    body,
    signature,
    ulid: bigIntToUlid(value),
    bandId: bigIntToUuid(value),
  };
}

/** Whether a string is shaped like a band code — the scanner's classifier. */
export function isBandCodeShape(raw: string): boolean {
  return parseBandCode(raw) !== null;
}

export type VerifiedBandCode = { ok: true } & ParsedBandCode;
export type BandCodeVerification =
  | VerifiedBandCode
  | {
      ok: false;
      /**
       * `format`: not the shape of a band code at all. `signature`: the right
       * shape and the wrong signature — a tampered or invented code, or one
       * signed with another park's key.
       */
      reason: 'format' | 'signature';
    };

/**
 * Check a code with the park's key. The box's question at the gate, answerable
 * with no network: is this a band this park printed, and which band is it?
 *
 * The comparison runs over every character whatever the first difference, so
 * the time it takes says nothing about how close a guess was.
 */
export function verifyBandCode(raw: string, key: string | Uint8Array): BandCodeVerification {
  const parsed = parseBandCode(raw);
  if (!parsed) return { ok: false, reason: 'format' };
  const expected = signatureOf(`${parsed.prefix}${parsed.body}`, keyBytes(key));
  let difference = 0;
  for (let i = 0; i < BAND_CODE_SIGNATURE_LENGTH; i += 1) {
    difference |= expected.charCodeAt(i) ^ parsed.signature.charCodeAt(i);
  }
  if (difference !== 0) return { ok: false, reason: 'signature' };
  return { ok: true, ...parsed };
}

/** The standard ULID a code names, or null when the string is not a band code. */
export function ulidOfBandCode(raw: string): string | null {
  return parseBandCode(raw)?.ulid ?? null;
}

/**
 * The short line printed under the band's QR and on the receipt: the prefix,
 * a dash and the last six body characters — `T1-7KMQ4X`.
 *
 * NOT a credential. It carries no signature, so it can be printed on a
 * receipt, typed into History and read aloud; the gate never admits on it.
 * The last characters are the ULID's random tail, so two bands from one till
 * collide in it about once in 729 million.
 */
export function bandShortCode(raw: string): string | null {
  const parsed = parseBandCode(raw);
  if (!parsed) return null;
  return `${parsed.prefix}-${parsed.body.slice(-BAND_SHORT_CODE_TAIL)}`;
}

/** A short code as somebody typed it: `t1-7kmq4x` or `T1 7KMQ4X`. Null when it is not one. */
export function parseBandShortCode(raw: string): { prefix: string; tail: string } | null {
  const match = /^([0-9A-Z]{1,6})[\s-]+([0-9A-Z]{6})$/.exec(raw.trim().toUpperCase());
  if (!match) return null;
  const [, prefix, tail] = match;
  if (!prefix || !tail) return null;
  if ([...tail].some((ch) => !BAND_CODE_ALPHABET.includes(ch))) return null;
  return { prefix, tail };
}
