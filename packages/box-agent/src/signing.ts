import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';

import { canonicalSyncBytes, type SyncEventEnvelope } from './contract';

/**
 * Identity and provenance for a queued fact (S2-05).
 *
 * The two are different jobs and the box does both, once, at the moment it
 * mints the event:
 *
 *   - **`payloadHash`** is SHA-256 over the canonical envelope. It is
 *     IDENTITY. Same event id with the same hash is a duplicate and is dropped
 *     silently, which is the ordinary shape of an acknowledgement that got
 *     lost. Same event id with a DIFFERENT hash is two facts wearing one
 *     identity, and the cloud quarantines rather than picking one. It protects
 *     against accidental divergence and against nothing an attacker does —
 *     anyone who rewrites the payload recomputes the hash.
 *   - **`sig`** is a detached Ed25519 signature over the same bytes. It is
 *     PROVENANCE: did this come from that box. The cloud verifies once, at
 *     push, and stores the signature as evidence, so rotating a keypair does
 *     not invalidate a year of history.
 *
 * The private half never leaves the box. The public half goes up at
 * registration and lands in `core.box.sync_public_key`.
 */

export interface SyncKeyPair {
  /** PKCS#8 PEM. Held beside the box secret, at mode 0600 on a Pi. */
  privateKeyPem: string;
  /** SPKI PEM. The half the cloud keeps. */
  publicKeyPem: string;
}

export function generateSyncKeyPair(): SyncKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** Recover the public half from a stored private key, so only one is persisted. */
export function publicKeyFor(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

/** Lower-case hex SHA-256, the form `edge.sync_event.payload_hash` is checked against. */
export function payloadHash(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Base64 of the detached signature over the canonical bytes. */
export function signCanonical(canonical: string, privateKeyPem: string): string {
  // Ed25519 signs the message itself; passing a digest algorithm here is an
  // error in Node rather than a second hash, which is why this reads `null`.
  return sign(null, Buffer.from(canonical, 'utf8'), createPrivateKey(privateKeyPem)).toString(
    'base64',
  );
}

/**
 * The same check the cloud runs, kept here so a test can prove the two ends
 * agree without standing up the api.
 */
export function verifyCanonical(canonical: string, sig: string, publicKeyPem: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonical, 'utf8'),
      createPublicKey(publicKeyPem),
      Buffer.from(sig, 'base64'),
    );
  } catch {
    // A malformed key or a signature that is not base64 is a failed
    // verification, not a crash in the middle of a push.
    return false;
  }
}

/**
 * Hash and sign an envelope that is otherwise complete.
 *
 * `boxId` is hashed but is NOT a field of the envelope: a box only ever speaks
 * about itself, so the cloud takes it from the credential the push arrived on
 * and adds it back before verifying. A compromised box therefore cannot even
 * express an event attributed to a healthy one — the bytes it signed would not
 * be the bytes the cloud checks.
 */
export function sealEnvelope(
  envelope: Omit<SyncEventEnvelope, 'payloadHash' | 'sig' | 'sigAlg'>,
  boxId: string,
  privateKeyPem: string,
): SyncEventEnvelope {
  const canonical = canonicalSyncBytes({ ...envelope, boxId });
  return {
    ...envelope,
    payloadHash: payloadHash(canonical),
    sig: signCanonical(canonical, privateKeyPem),
    sigAlg: 'ed25519',
  };
}

/**
 * UUIDv7: 48 bits of millisecond time, then randomness.
 *
 * `@oto/shared` owns the platform's generator, and this package cannot import
 * it yet (see `contract.ts`). Time-ordered ids are not decoration here: an
 * outbox is read in id order when the sequence is unavailable, and a v4 would
 * scatter a day's events across the index.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const buf = randomBytes(16);
  buf.writeUIntBE(nowMs, 0, 6);
  buf.writeUInt8((buf.readUInt8(6) & 0x0f) | 0x70, 6);
  buf.writeUInt8((buf.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
