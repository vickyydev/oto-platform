import { BAND_KEY_MIN_BYTES, hmacSha256, sha256, ulidFromUuid, uuidFromUlid } from './band-code';

/**
 * THE SIGNED BOOKING QR (S2-12, SCRUM-209; plan `docs/progress/plans/arrival/PLAN.md` §2.2).
 *
 * What a family carries to the park after paying online: one QR that names
 * their booking and that no one but this park could have made. Reception scans
 * it; the box checks the signature itself, with no network, the same way it
 * checks a band — and with the same key (`BAND_HMAC_KEY`,
 * `docs/briefs/OWNER_DIRECTION.md:30-33`: one key on every box verifies both).
 *
 * THE SHAPE, worked through once:
 *
 *   BK1: · 01J9ZK3Q…(26)… · . · 7M4Q…(16)…
 *   ^^^^   ^^^^^^^^^^^^^^   ^   ^^^^^^^^^^^
 *   │      │                │   └ signature: HMAC-SHA256(key, "oto.booking-qr.v1|" + ULID),
 *   │      │                │     first 10 bytes (80 bits), Crockford base32, 16 characters
 *   │      │                └ the one separator
 *   │      └ the booking's id as a ULID — the row's own UUIDv7 in the standard
 *   │        Crockford spelling, so a verified code names its booking with no lookup
 *   └ the header: format 1 of a booking QR
 *
 * WHY A BAND CODE CAN NEVER BE READ AS ONE OF THESE, AND THE REVERSE:
 *
 *  - **The header carries a colon.** A band code is one to six upper-case
 *    letters or digits, 27 body characters, a dot and a signature
 *    (`band-code.ts`): no colon anywhere. A product barcode is digits. So a
 *    string that starts `BK1:` is not either, and neither of them can start so.
 *    `parseBandCode` refuses this shape because its prefix would contain the
 *    colon; `parseBookingQr` refuses a band because it has no header.
 *  - **The signatures are domain-separated.** A band's MAC is over its prefix
 *    and body, letters and digits only; this one is over
 *    `oto.booking-qr.v1|<ULID>`, which contains a `|` and a `.` that no band
 *    head can. The same key signing both therefore never produces a band
 *    signature that replays as a booking signature, or the reverse — "booking"
 *    never equals "band" at the input to the MAC.
 *
 * Every character is QR alphanumeric (upper-case letters, digits, `:` and
 * `.`), so the whole 47-character code packs at 5.5 bits a character.
 *
 * NOTHING HERE READS A CLOCK OR A RANDOM SOURCE, and nothing imports
 * `node:crypto`: this file is bundled into the browser (the booking site draws
 * the QR) and runs on the box. It reuses the SHA-256 and HMAC `band-code.ts`
 * implements and pins against `node:crypto`.
 */

/** Format 1 of a booking QR. A future format is a new header, never a reuse. */
export const BOOKING_QR_HEADER = 'BK1:';
/** A ULID in its standard spelling. */
export const BOOKING_QR_BODY_LENGTH = 26;
/** 80 bits in Crockford base32. */
export const BOOKING_QR_SIGNATURE_LENGTH = 16;
export const BOOKING_QR_SEPARATOR = '.';
/** The domain the MAC is computed in — never a band's, whose heads are letters and digits. */
const DOMAIN = 'oto.booking-qr.v1|';
/** The domain a key's public fingerprint is computed in — never a signature's. */
const KEY_ID_DOMAIN = 'oto.key-id.v1|';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function keyBytes(key: string | Uint8Array): Uint8Array {
  const bytes = typeof key === 'string' ? utf8(key) : key;
  if (bytes.length < BAND_KEY_MIN_BYTES) {
    throw new Error(`A booking QR key is at least ${BAND_KEY_MIN_BYTES} bytes`);
  }
  return bytes;
}

/** The first `length` characters of some bytes in Crockford base32, five bits at a time. */
function crockford(bytes: Uint8Array, length: number): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += CROCKFORD[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
    if (out.length >= length) break;
  }
  return out;
}

function signatureOf(ulid: string, key: Uint8Array): string {
  return crockford(hmacSha256(key, `${DOMAIN}${ulid}`), BOOKING_QR_SIGNATURE_LENGTH);
}

/**
 * Sign one booking. `bookingId` is the booking row's UUID; `key` is
 * `BAND_HMAC_KEY`.
 *
 * @throws on an id that is not a UUID and on a key shorter than
 *   `BAND_KEY_MIN_BYTES`. A QR that cannot be honoured is worse than none.
 */
export function mintBookingQr(bookingId: string, key: string | Uint8Array): string {
  const ulid = ulidFromUuid(bookingId);
  return `${BOOKING_QR_HEADER}${ulid}${BOOKING_QR_SEPARATOR}${signatureOf(ulid, keyBytes(key))}`;
}

/** The parts of a well-formed booking QR, before anybody has checked its signature. */
export interface ParsedBookingQr {
  /** The code as it is compared: trimmed and upper-cased. */
  code: string;
  ulid: string;
  /** The booking row the code names. */
  bookingId: string;
  signature: string;
}

/**
 * Read a booking QR's parts WITHOUT checking its signature. Null for anything
 * that is not the shape of one — a band code, a barcode, a typed reference.
 * Never let anybody in on this alone.
 */
export function parseBookingQr(raw: string): ParsedBookingQr | null {
  const code = raw.trim().toUpperCase();
  if (!code.startsWith(BOOKING_QR_HEADER)) return null;
  const rest = code.slice(BOOKING_QR_HEADER.length);
  const at = rest.indexOf(BOOKING_QR_SEPARATOR);
  if (at !== BOOKING_QR_BODY_LENGTH || at !== rest.lastIndexOf(BOOKING_QR_SEPARATOR)) return null;
  const ulid = rest.slice(0, at);
  const signature = rest.slice(at + 1);
  if (!ULID_PATTERN.test(ulid)) return null;
  if (signature.length !== BOOKING_QR_SIGNATURE_LENGTH) return null;
  if ([...signature].some((ch) => !CROCKFORD.includes(ch))) return null;
  return { code, ulid, bookingId: uuidFromUlid(ulid), signature };
}

/** Whether a string is shaped like a booking QR — the scanner's classifier. */
export function isBookingQrShape(raw: string): boolean {
  return parseBookingQr(raw) !== null;
}

export type BookingQrVerification =
  | ({ ok: true } & ParsedBookingQr)
  | {
      ok: false;
      /**
       * `format`: not the shape of a booking QR at all (a band code lands
       * here). `signature`: the right shape and the wrong signature — a
       * tampered or invented code, or one signed with another park's key.
       */
      reason: 'format' | 'signature';
    };

/**
 * Check a booking QR with the park's key — the box's question at reception,
 * answerable with no network. The comparison runs over every character
 * whatever the first difference, so its time says nothing about a guess.
 */
export function verifyBookingQr(raw: string, key: string | Uint8Array): BookingQrVerification {
  const parsed = parseBookingQr(raw);
  if (!parsed) return { ok: false, reason: 'format' };
  const expected = signatureOf(parsed.ulid, keyBytes(key));
  let difference = 0;
  for (let i = 0; i < BOOKING_QR_SIGNATURE_LENGTH; i += 1) {
    difference |= expected.charCodeAt(i) ^ parsed.signature.charCodeAt(i);
  }
  if (difference !== 0) return { ok: false, reason: 'signature' };
  return { ok: true, ...parsed };
}

/**
 * A public name for the key that signed a QR, stored beside the signature
 * (`pos.booking.qr_key_id`) so a rotation can tell which key to check a
 * booking against. It is a fingerprint in its own domain — a hash of the key,
 * never the key and never a signature it could stand in for.
 */
export function bookingQrKeyId(key: string | Uint8Array): string {
  const bytes = keyBytes(key);
  const prefix = utf8(KEY_ID_DOMAIN);
  const joined = new Uint8Array(prefix.length + bytes.length);
  joined.set(prefix);
  joined.set(bytes, prefix.length);
  return `k${crockford(sha256(joined), 8)}`;
}
