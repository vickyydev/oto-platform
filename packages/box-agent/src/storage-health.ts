import { readFile, realpath, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { BoxHeartbeatRequest } from './protocol';
import type { SqliteDatabaseLike, SqliteStatementLike } from './store-sqlite';
import type { StoreMirror } from './store-mirror';

type Space = { bavail: number; blocks: number; bsize: number };
export type StorageHeartbeat = NonNullable<BoxHeartbeatRequest['storage']>;

/**
 * How long one reading may take before the heartbeat goes without it. A drive
 * that has gone away can leave a filesystem call that never returns, and the
 * heartbeat is how anybody learns that. Well under the heartbeat's own interval.
 */
export const STORAGE_READ_TIMEOUT_MS = 2_000;

/** Longest mount wins; a read-only bind mount can cover a writable device. */
export function readOnlyMount(file: string, mountinfo: string): boolean | null {
  const decode = (value: string) =>
    value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  let match: { path: string; readOnly: boolean } | null = null;
  for (const line of mountinfo.split('\n')) {
    const [mount, superblock] = line.split(' - ');
    const fields = mount?.split(' ') ?? [];
    const path = decode(fields[4] ?? '');
    if (
      !path ||
      !superblock ||
      !(file === path || file.startsWith(path === '/' ? '/' : `${path}/`))
    )
      continue;
    const readOnly =
      fields[5]?.split(',').includes('ro') ||
      superblock.split(' ')[2]?.split(',').includes('ro') ||
      false;
    if (!match || path.length > match.path.length) match = { path, readOnly };
  }
  return match?.readOnly ?? null;
}

async function mountedReadOnly(directory: string): Promise<boolean | null> {
  if (process.platform !== 'linux') return null;
  const [canonical, mounts] = await Promise.all([
    realpath(directory),
    readFile('/proc/self/mountinfo', 'utf8'),
  ]);
  return readOnlyMount(canonical, mounts);
}

export class StorageHealth {
  private errors = 0;
  private sawReadOnly = false;
  private readonly seen = new WeakSet<object>();
  constructor(
    private readonly options: {
      database: string;
      mirrorDirectory?: string | null;
      mirror: Pick<StoreMirror, 'ageSeconds' | 'failures'> &
        Partial<Pick<StoreMirror, 'problem' | 'settling'>>;
      statfs?: (path: string) => Promise<Space>;
      readOnly?: (path: string) => Promise<boolean | null>;
      env?: NodeJS.ProcessEnv;
      readTimeoutMs?: number;
    },
  ) {}

  /** A read still outstanding, by what it reads: never a second call beside a stuck one. */
  private readonly outstanding = new Map<string, Promise<unknown>>();

  /**
   * One reading, answered or not within the limit.
   *
   * A stuck call sits on a thread of Node's small pool until the kernel lets go of
   * it, so the same read is never started again while one is out: asking once a
   * minute would use the whole pool up in four minutes and stop every file call
   * in the process, the store's included.
   */
  private async bounded<T>(key: string, read: () => Promise<T>): Promise<{ value: T } | null> {
    let pending = this.outstanding.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = read().finally(() => {
        this.outstanding.delete(key);
      });
      this.outstanding.set(key, pending);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending.then((value) => ({ value })),
        new Promise<null>((done) => {
          timer = setTimeout(() => done(null), this.options.readTimeoutMs ?? STORAGE_READ_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  recordError(error: unknown): void {
    if (!error || typeof error !== 'object' || this.seen.has(error)) return;
    const { code, errcode } = error as { code?: string; errcode?: number };
    const primary = typeof errcode === 'number' ? errcode & 0xff : null;
    if (
      !['EIO', 'EROFS', 'SQLITE_IOERR', 'SQLITE_READONLY'].some(
        (prefix) => code === prefix || code?.startsWith(`${prefix}_`),
      ) &&
      primary !== 8 &&
      primary !== 10
    )
      return;
    this.seen.add(error);
    this.errors += 1;
    if (code === 'EROFS' || code?.startsWith('SQLITE_READONLY') || primary === 8)
      this.sawReadOnly = true;
  }

  /** Observe startup checks, statements and transaction control on the live connection. */
  observe(db: SqliteDatabaseLike): SqliteDatabaseLike {
    const capture = <T>(fn: () => T): T => {
      try {
        return fn();
      } catch (error) {
        this.recordError(error);
        throw error;
      }
    };
    return {
      exec: (sql) => capture(() => db.exec(sql)),
      close: () => capture(() => db.close()),
      prepare: (sql): SqliteStatementLike => {
        const statement = capture(() => db.prepare(sql));
        const recordError = (error: unknown) => this.recordError(error);
        return {
          all: (...params) => capture(() => statement.all(...params)),
          run: (...params) => capture(() => statement.run(...params)),
          ...(statement.iterate
            ? {
                *iterate(...params: unknown[]) {
                  try {
                    yield* statement.iterate!(...params);
                  } catch (error) {
                    recordError(error);
                    throw error;
                  }
                },
              }
            : {}),
        };
      },
    };
  }

  async snapshot(): Promise<StorageHeartbeat> {
    const directory = dirname(resolve(this.options.database));
    let storeSilent = false;
    let mirrorSilent = false;
    const space = async (path: string): Promise<Space | null> => {
      try {
        const answered = await this.bounded(`space:${path}`, () =>
          (this.options.statfs ?? statfs)(path),
        );
        if (!answered) {
          if (path === directory) storeSilent = true;
          else mirrorSilent = true;
        }
        return answered?.value ?? null;
      } catch (error) {
        if (path === directory) this.recordError(error);
        return null;
      }
    };
    const [store, mirrorSpace, readOnly, age] = await Promise.all([
      space(directory),
      this.options.mirrorDirectory ? space(this.options.mirrorDirectory) : null,
      this.bounded('read-only', () => (this.options.readOnly ?? mountedReadOnly)(directory))
        .then((answered) => answered?.value ?? null)
        .catch(() => null),
      this.bounded('mirror-age', () => this.options.mirror.ageSeconds()).then((answered) => {
        if (!answered) mirrorSilent = true;
        return answered?.value ?? null;
      }),
    ]);
    const bytes = (value: number | undefined) =>
      value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const env = this.options.env ?? process.env;
    const testFree =
      env.NODE_ENV === 'test' && env.OTO_BOX_TEST_STORAGE_FREE_BYTES !== undefined
        ? Number(env.OTO_BOX_TEST_STORAGE_FREE_BYTES)
        : NaN;
    return {
      freeBytes:
        Number.isSafeInteger(testFree) && testFree >= 0
          ? testFree
          : bytes(store ? store.bavail * store.bsize : undefined),
      totalBytes: bytes(store ? store.blocks * store.bsize : undefined),
      readOnly: readOnly ?? (this.sawReadOnly ? true : null),
      ioErrors: this.errors,
      mirrorConfigured: Boolean(this.options.mirrorDirectory),
      mirrorAgeS: age,
      mirrorFreeBytes: bytes(mirrorSpace ? mirrorSpace.bavail * mirrorSpace.bsize : undefined),
      mirrorErrors: this.options.mirror.failures,
      ...(storeSilent ? { driveNotAnswering: true } : {}),
      // What the drive just failed to answer outranks what the last round found.
      ...(mirrorSilent
        ? { mirrorProblem: 'not_answering' }
        : this.options.mirror.problem
          ? { mirrorProblem: this.options.mirror.problem }
          : {}),
      ...(this.options.mirror.settling ? { mirrorSettling: true } : {}),
    };
  }
}
