import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors';

/**
 * SCRUM-539 — the OTO App's provisioning key, as this platform holds it:
 * `OTOAPP_PROVISION_KEYS`, one `<operator uuid>:<sha256 hex>` per operator.
 * Only the digest is configured here, so this platform's environment leaking
 * hands nobody a working key. Kept apart from the service so `env.ts` can
 * validate the variable at boot without importing the database; what the key
 * may do is written down in `services/otoapp-provision.ts`.
 */

/** One operator's key, as configured: never the key itself, only its digest. */
export interface OtoAppProvisionKey {
  operatorId: string;
  /** SHA-256 of the key, 32 bytes. */
  digest: Buffer;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

/**
 * `OTOAPP_PROVISION_KEYS`: `<operator uuid>:<sha256 hex of the key>`,
 * comma-separated. Throws on a malformed entry, naming its position only.
 */
export function parseOtoAppProvisionKeys(raw: string): OtoAppProvisionKey[] {
  const keys: OtoAppProvisionKey[] = [];
  const entries = raw
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  entries.forEach((entry, i) => {
    const at = entry.indexOf(':');
    const operatorId = at > 0 ? entry.slice(0, at).trim().toLowerCase() : '';
    const digest = at > 0 ? entry.slice(at + 1).trim() : '';
    if (!UUID_RE.test(operatorId)) {
      throw new Error(`entry ${i + 1} does not start with an operator uuid and a colon`);
    }
    if (!SHA256_HEX_RE.test(digest)) {
      throw new Error(
        `entry ${i + 1} (operator ${operatorId}) is not the 64-hex SHA-256 of a key — store the digest, never the key`,
      );
    }
    keys.push({ operatorId, digest: Buffer.from(digest, 'hex') });
  });
  return keys;
}

/** The digest a key is configured by: `sha256(key)` as hex. */
export function otoAppProvisionKeyDigest(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export const PROVISION_UNAUTHORIZED = 'OTOAPP_PROVISION_UNAUTHORIZED';

/**
 * Which operator the presented key belongs to. Every configured digest is
 * compared, whatever matched first, so the answer takes the same time for a
 * key that is first in the list, last, or absent.
 */
export function authenticateOtoAppProvisioner(
  configured: readonly OtoAppProvisionKey[],
  authorization: string | undefined,
): { operatorId: string } {
  const refused = new AppError(
    401,
    PROVISION_UNAUTHORIZED,
    'This request does not carry a provisioning key this platform accepts',
  );
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!match || configured.length === 0) throw refused;
  const presented = createHash('sha256').update(match[1]!, 'utf8').digest();
  let operatorId: string | null = null;
  for (const key of configured) {
    if (timingSafeEqual(presented, key.digest) && operatorId === null) operatorId = key.operatorId;
  }
  if (!operatorId) throw refused;
  return { operatorId };
}
