import { randomBytes, scrypt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { compareOtoAppPassword, OTOAPP_SCRYPT_KEYLEN } from '../src/lib/otoapp-password';

/**
 * SCRUM-795 — the OTO App's password check, ported for the one-time adoption
 * at a first launcher sign-in.
 *
 * The fixtures are minted here, by the app's own `hashPassword` written out
 * verbatim below, from passwords this file makes up. No real hash is copied
 * from anywhere. The last case reads `apps/oto-app/server/auth.ts` itself, so
 * a change to how the app hashes or compares fails here rather than at the
 * launcher on somebody's first morning.
 */

// --- `hashPassword` from apps/oto-app/server/auth.ts, verbatim ---------------
const scryptAsync = promisify(scrypt);

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString('hex')}.${salt}`;
}
// -----------------------------------------------------------------------------

describe('compareOtoAppPassword (SCRUM-795)', () => {
  it('accepts the password a hash was made from, and nothing else', async () => {
    const stored = await hashPassword('zz-app-pass-795');
    expect(await compareOtoAppPassword('zz-app-pass-795', stored)).toBe(true);
    expect(await compareOtoAppPassword('zz-app-pass-796', stored)).toBe(false);
    expect(await compareOtoAppPassword('ZZ-APP-PASS-795', stored)).toBe(false);
    expect(await compareOtoAppPassword('', stored)).toBe(false);
  });

  it('uses each hash its own salt: two hashes of one password differ, and both match', async () => {
    const a = await hashPassword('zz-same');
    const b = await hashPassword('zz-same');
    expect(a).not.toBe(b);
    expect(await compareOtoAppPassword('zz-same', a)).toBe(true);
    expect(await compareOtoAppPassword('zz-same', b)).toBe(true);
    // A's digest under B's salt is nobody's password.
    const crossed = `${a.split('.')[0]}.${b.split('.')[1]}`;
    expect(await compareOtoAppPassword('zz-same', crossed)).toBe(false);
  });

  it('takes the salt as the string it is stored as, as the app does', async () => {
    const stored = await hashPassword('zz-salt-as-text');
    const [, salt] = stored.split('.');
    // Decoding the salt from hex would be a different scrypt input altogether.
    const decoded = (await scryptAsync('zz-salt-as-text', Buffer.from(salt!, 'hex'), 64)) as Buffer;
    expect(await compareOtoAppPassword('zz-salt-as-text', `${decoded.toString('hex')}.${salt}`)).toBe(false);
    expect(OTOAPP_SCRYPT_KEYLEN).toBe(64);
  });

  it('answers a malformed stored value with false instead of throwing', async () => {
    const good = await hashPassword('zz-malformed');
    const [digest, salt] = good.split('.');
    for (const stored of [
      '',
      'no-dot-at-all',
      `${digest}.`,
      `.${salt}`,
      `${digest!.slice(0, 126)}.${salt}`,
      `${digest}00.${salt}`,
      `${'z'.repeat(128)}.${salt}`,
    ]) {
      await expect(compareOtoAppPassword('zz-malformed', stored), stored.slice(0, 12)).resolves.toBe(false);
    }
  });

  it('is the method the OTO App itself uses: its hashPassword and comparePasswords are unchanged', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../oto-app/server/auth.ts', import.meta.url)),
      'utf8',
    ).replace(/\s+/g, ' ');
    expect(source).toContain(
      'export async function hashPassword(password: string) { const salt = randomBytes(16).toString("hex"); const buf = (await scryptAsync(password, salt, 64)) as Buffer; return `${buf.toString("hex")}.${salt}`; }',
    );
    expect(source).toContain(
      'export async function comparePasswords(supplied: string, stored: string) { const [hashed, salt] = stored.split("."); const hashedBuf = Buffer.from(hashed, "hex"); const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer; return timingSafeEqual(hashedBuf, suppliedBuf); }',
    );
    expect(source).toContain('const scryptAsync = promisify(scrypt);');
  });
});
