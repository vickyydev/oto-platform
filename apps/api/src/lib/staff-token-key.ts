import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';

/**
 * Reading `STAFF_TOKEN_PRIVATE_KEY` (S2-06).
 *
 * A leaf module with no imports of its own beyond `node:crypto`, because two
 * places need it and one of them is `env.ts`: the variable is validated at
 * boot, the way `HANDOFF_SIGNING_KEY` is, so a deployment that pastes half a
 * key is told at start-up rather than at the first locked till. Putting the
 * parser in the service would make `env.ts` import the service, which imports
 * the database, the audit log and the box agent — to check a string.
 */

export interface StaffTokenKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

/**
 * Accept the key in whichever of three shapes a deployment dashboard produced.
 *
 * A PEM is multi-line, and the number of ways that survives a copy into a web
 * form is one more than anybody expects: intact, with its newlines escaped as
 * `\n`, or base64-encoded whole because a runbook said so. All three are
 * accepted — the alternative is an api that boots and then refuses every
 * unlock with a message about padding.
 */
export function parseStaffTokenKey(raw: string): StaffTokenKeyPair {
  let text = raw.trim();
  if (!text.includes('BEGIN')) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8');
      if (decoded.includes('BEGIN')) text = decoded.trim();
    } catch {
      // Not base64 either. The key parse below produces the real message.
    }
  }
  text = text.replace(/\\n/g, '\n');
  const privateKey = createPrivateKey(text);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `this is ${privateKey.asymmetricKeyType ?? 'not an asymmetric key'}; staff tokens are ed25519 (openssl genpkey -algorithm ed25519)`,
    );
  }
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/**
 * The `kid`: the first sixteen hex characters of SHA-256 over the public half.
 *
 * Derived rather than configured, which is what makes a rotation safe to do by
 * hand: set a new key and its public half publishes itself under a new `kid`
 * beside the old row, so tokens already in the park keep verifying until they
 * expire. A `kid` somebody typed could be reused for a different key, and then
 * every box would check new tokens against an old public half.
 */
export function staffTokenKid(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}
