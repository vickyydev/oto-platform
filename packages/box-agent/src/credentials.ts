import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Where a box keeps the credential it was given at registration.
 *
 * The cloud returns the secret exactly once, so losing it means a new claim
 * code from an administrator. That makes the store the most important twenty
 * lines in the agent, and it is deliberately an interface: a Raspberry Pi and
 * the virtual box that runs inside the api have genuinely different right
 * answers, and neither is a mock of the other.
 */
export interface BoxCredential {
  boxId: string;
  secret: string;
}

export interface CredentialStore {
  read(): Promise<BoxCredential | null>;
  write(credential: BoxCredential): Promise<void>;
  clear(): Promise<void>;
}

/**
 * For the virtual box, and for tests.
 *
 * The virtual box's IDENTITY is the `core.box` row found by branch and slot —
 * a row, not a file — so a redeploy finds the same box, the same epoch and the
 * same heartbeat history. Its CREDENTIAL is a different thing and is
 * deliberately not persisted: a secret held only in memory dies with the
 * process that held it, which is the correct life for one nobody can read out
 * of a container that no longer exists. Each boot registers again and rotates
 * it, and rotating a secret on every deploy is a property worth having rather
 * than a cost.
 */
export function memoryCredentialStore(initial: BoxCredential | null = null): CredentialStore {
  let held = initial;
  return {
    async read() {
      return held;
    },
    async write(credential) {
      held = credential;
    },
    async clear() {
      held = null;
    },
  };
}

/**
 * For a real box: one file, owner-readable only.
 *
 * A Pi in a shopping mall is rebooted by whoever trips over the power strip,
 * and it must come back up already itself rather than waiting for somebody to
 * read a claim code out over the phone. The file is written before the agent
 * acknowledges the registration, so the only window in which the secret can be
 * lost is the network answer itself.
 */
export function fileCredentialStore(path: string): CredentialStore {
  return {
    async read() {
      try {
        const raw = await readFile(path, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as BoxCredential).boxId === 'string' &&
          typeof (parsed as BoxCredential).secret === 'string'
        ) {
          return parsed as BoxCredential;
        }
        return null;
      } catch {
        // Absent, unreadable or not ours: the agent registers again, which is
        // the same path a brand-new box takes.
        return null;
      }
    },
    async write(credential) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(credential), { encoding: 'utf8', mode: 0o600 });
      // Explicit, because an existing file keeps the mode it already had.
      await chmod(path, 0o600);
    },
    async clear() {
      await writeFile(path, '', { encoding: 'utf8', mode: 0o600 });
    },
  };
}
