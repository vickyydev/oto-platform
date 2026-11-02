import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { holdStoreLock, StoreBusyError } from './runner/store-lock';

export const MIRROR_INTERVAL_MS = 60_000;
export const MIRROR_AFTER_UNSENT_MS = 10_000;
export const MIRROR_NAME = 'box.sqlite.mirror';

// A self-contained worker survives the single-file runner bundle. SQLite and
// file copying run here, never on the sale's JS thread or its connection.
const WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const target = path.join(workerData.directory, 'box.sqlite.mirror');
const temp = target + '.tmp-' + randomUUID();
const previous = temp + '.previous';
let source, check;
try {
  fs.closeSync(fs.openSync(temp, 'wx', 0o600));
  source = new DatabaseSync(workerData.database, { readOnly: true });
  source.exec('pragma busy_timeout = 0; pragma synchronous = FULL');
  source.prepare('VACUUM INTO ?').run(temp);
  source.close(); source = null;
  check = new DatabaseSync(temp, { readOnly: true });
  const rows = check.prepare('pragma quick_check').all();
  if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new Error('mirror_check_failed');
  check.close(); check = null;
  const fd = fs.openSync(temp, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // The current mirror stays present throughout rotation, including a crash.
  if (fs.existsSync(target)) {
    fs.copyFileSync(target, previous, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(previous, 0o600);
    const old = fs.openSync(previous, 'r+');
    try { fs.fsyncSync(old); } finally { fs.closeSync(old); }
    if (fs.existsSync(target + '.1')) fs.renameSync(target + '.1', target + '.2');
    fs.renameSync(previous, target + '.1');
  }
  fs.renameSync(temp, target);
  // Node on Windows cannot open a directory for fsync.
  if (process.platform !== 'win32') {
    const dir = fs.openSync(workerData.directory, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, code: typeof error.code === 'string' ? error.code : 'mirror_failed', errcode: error.errcode });
} finally {
  try { source?.close(); } catch {}
  try { check?.close(); } catch {}
  try { fs.unlinkSync(temp); } catch {}
  try { fs.unlinkSync(previous); } catch {}
}
`;

export function copyStoreMirror(database: string, directory: string): Promise<void> {
  return new Promise((done, reject) => {
    const worker = new Worker(WORKER, {
      eval: true,
      execArgv: ['--disable-warning=ExperimentalWarning'],
      workerData: { database, directory },
    });
    let result: { ok: boolean; code?: string; errcode?: number } | undefined;
    worker.once('message', (message: typeof result) => {
      result = message;
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0 && result?.ok) done();
      else
        reject(
          Object.assign(new Error('The store mirror could not be completed.'), {
            code: result?.code,
            errcode: result?.errcode,
          }),
        );
    });
  });
}

export type MirrorResult = 'mirrored' | 'busy' | 'disabled' | 'too_soon' | 'failed';

export class StoreMirror {
  failures = 0;
  private running: Promise<MirrorResult> | null = null;
  private lastAttempt = -Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  constructor(
    private readonly options: {
      database: string;
      directory?: string | null;
      now?: () => number;
      copy?: typeof copyStoreMirror;
      onFailure?: () => void;
    },
  ) {}

  async ageSeconds(): Promise<number | null> {
    const age = await this.ageMs();
    return age === null ? null : Math.floor(age / 1000);
  }

  private async ageMs(): Promise<number | null> {
    if (!this.options.directory) return null;
    const info = await stat(join(this.options.directory, MIRROR_NAME)).catch(() => null);
    return info ? Math.max(0, this.now() - info.mtimeMs) : null;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  start(): void {
    if (!this.options.directory || this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.run();
    }, MIRROR_INTERVAL_MS);
    this.timer.unref();
  }

  /** Fire-and-forget after the outer SQLite commit, never awaited by a sale. */
  acceptedUnsent(): void {
    void this.run(true);
  }

  run(afterUnsent = false): Promise<MirrorResult> {
    if (!this.options.directory || this.stopped) return Promise.resolve('disabled');
    if (this.running) return Promise.resolve('busy');
    const task = this.perform(afterUnsent);
    this.running = task;
    void task.finally(() => {
      this.running = null;
    });
    return task;
  }

  private async perform(afterUnsent: boolean): Promise<MirrorResult> {
    let release: (() => Promise<void>) | undefined;
    try {
      if (afterUnsent) {
        const age = await this.ageMs();
        if (
          (age !== null && age <= MIRROR_AFTER_UNSENT_MS) ||
          this.now() - this.lastAttempt < MIRROR_AFTER_UNSENT_MS
        )
          return 'too_soon';
      }
      this.lastAttempt = this.now();
      const directory = this.options.directory!;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        release = await holdStoreLock(directory, 'mirror');
      } catch (error) {
        if (error instanceof StoreBusyError) return 'busy';
        throw error;
      }
      await (this.options.copy ?? copyStoreMirror)(this.options.database, directory);
      return 'mirrored';
    } catch {
      this.failures += 1;
      try {
        this.options.onFailure?.();
      } catch {
        /* reporting cannot fail a sale */
      }
      return 'failed';
    } finally {
      await release?.().catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
