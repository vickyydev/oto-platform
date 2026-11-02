import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { holdStoreLock, StoreBusyError } from './runner/store-lock';

export const MIRROR_INTERVAL_MS = 60_000;
export const MIRROR_AFTER_UNSENT_MS = 10_000;
export const MIRROR_NAME = 'box.sqlite.mirror';
/**
 * Consecutive failed rounds before the mirror is called failing on the heartbeat.
 * Two, so one passing fault stays quiet: the alert then comes about three minutes
 * after a drive drops out, where the age alone took about twelve.
 */
export const MIRROR_FAILING_AFTER = 2;
/**
 * An unchanged store still gets a real copy this often. The round's check below
 * looks at what recovery needs, not at every row: this is what brings the rest
 * across. On a 50 MB store it costs about 1.2 GB a day, where copying every
 * minute cost about 144 GB.
 */
export const MIRROR_FULL_COPY_EVERY_MS = 60 * 60_000;
/**
 * A round still going after this long has been swallowed by a drive that stopped
 * answering. It never fails, so it never counts as a failed round: said here.
 */
export const MIRROR_STUCK_AFTER_MS = 120_000;
/** How long a stopping box waits for a round before it stops regardless. */
const STOP_WAIT_MS = 5_000;

/**
 * The worker, self-contained so it survives the single-file runner bundle.
 * SQLite and file copying run here, never on the sale's JS thread or its
 * connection. Three things it holds to:
 *
 *  - NOTHING IS REPLACED THAT THE STORE LACKS. Before a round writes anything it
 *    reads the three copies against the live store. A copy holding an unsent
 *    event the store does not have stops the whole round: a blank drive with the
 *    mirror attached used to rotate every sale away within three minutes.
 *    "Lacks" means the event's id is not there, and the journal has not passed
 *    its address with nothing else at it. The sequence has no gaps (a rollback
 *    returns its numbers) and only acknowledged rows are ever pruned, so a passed
 *    and empty address can only be a row that reached the cloud and aged out.
 *  - THE CURRENT COPY STAYS PRESENT throughout rotation, including a crash, and
 *    the outgoing copy moves by hard link, so a rotation writes nothing but the
 *    new copy. A medium with no hard links falls back to copying.
 *  - AN UNCHANGED STORE WRITES NO COPY. The file's time moves, so its age keeps
 *    saying when the copy was last known to match. The comparison is a logical
 *    one: a running box writes its clock measurement, the last time it trusts and
 *    its receipt mark every minute while nothing happens, so the file's own size
 *    and time never rest, and those keys are left out of it.
 */
const WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const NAME = 'box.sqlite.mirror';
const target = path.join(workerData.directory, NAME);
const temp = target + '.tmp-' + randomUUID();
const previous = temp + '.previous';
const UNSENT = "c.state in ('queued', 'sending', 'failed')";
const LACKING = 'select c.event_id as id from copy.box_outbox c not indexed where ' + UNSENT + ' and not exists (select 1 from main.box_outbox l where l.event_id = c.event_id) and not exists (select 1 from main.box_state s where s.box_id = c.box_id and s.journal_epoch = c.journal_epoch and c.box_seq < s.next_box_seq and not exists (select 1 from main.box_outbox o where o.box_id = c.box_id and o.journal_epoch = c.journal_epoch and o.box_seq = c.box_seq))';
const ALL_UNSENT = 'select c.event_id as id from copy.box_outbox c not indexed where ' + UNSENT;
const FINGERPRINT = "select (select coalesce(group_concat(box_id || '/' || journal_epoch || '/' || next_box_seq || '/' || offline || '/' || coalesce(applied_config_version, '-')), '') from box_state) as state, (select count(*) || '/' || coalesce(sum(state in ('queued', 'sending', 'failed')), 0) || '/' || coalesce(sum(state = 'acked'), 0) from box_outbox not indexed) as outbox, (select count(*) || '/' || coalesce(sum(counter_value), 0) from box_counter) as counters, (select count(*) || '/' || coalesce(max(updated_at), '') from box_overlay) as overlay, (select count(*) || '/' || coalesce(max(updated_at), '') from box_print_job) as prints, (select count(*) || '/' || coalesce(max(updated_at), '') from box_runtime where runtime_key not in ('box.clock_measurement', 'last_good_time')) as runtime";
const unreadable = (error) => {
  const primary = typeof error.errcode === 'number' ? error.errcode & 0xff : null;
  return primary === 11 || primary === 26 || /no such table/.test(String(error.message));
};
let source, check;
const send = (result) => parentPort.postMessage(result);
try {
  if (workerData.sweep) {
    // Whatever a kill or a power cut left mid-round. The caller holds the mirror lock.
    for (const name of fs.readdirSync(workerData.directory)) {
      if (name.startsWith(NAME + '.tmp-')) { try { fs.unlinkSync(path.join(workerData.directory, name)); } catch {} }
    }
  }
  const held = fs.existsSync(workerData.database);
  source = new DatabaseSync(held ? workerData.database : ':memory:', { readOnly: held });
  source.exec('pragma busy_timeout = 0');
  const tables = source.prepare("select count(*) as n from main.sqlite_master where name in ('box_state', 'box_outbox')").get().n;
  const blank = tables < 2 || Number(source.prepare('select count(*) as n from main.box_state').get().n) === 0;
  const lacking = new Set();
  for (const copy of [target, target + '.1', target + '.2']) {
    if (!fs.existsSync(copy)) continue;
    fs.accessSync(copy, fs.constants.R_OK);
    let attached = false;
    try {
      source.prepare('attach database ? as copy').run(copy);
      attached = true;
      for (const row of source.prepare(tables < 2 ? ALL_UNSENT : LACKING).all()) lacking.add(row.id);
    } catch (error) {
      // A damaged copy holds nothing a restore could read. A drive that will
      // not answer is another matter, and stops the round.
      if (!unreadable(error)) throw error;
    } finally {
      if (attached) source.exec('detach database copy');
    }
  }
  if (workerData.inspectOnly) {
    send({ ok: true, lacking: lacking.size });
  } else if (lacking.size > 0) {
    send({ ok: false, code: 'mirror_holds_unsent', lacking: lacking.size });
  } else if (blank) {
    send({ ok: true, blank: true });
  } else {
    const row = source.prepare(FINGERPRINT).get();
    const fingerprint = [row.state, row.outbox, row.counters, row.overlay, row.prints, row.runtime].join('|');
    const standing = fs.statSync(target, { throwIfNoEntry: false });
    const same = workerData.known && fingerprint === workerData.known.fingerprint && standing &&
      standing.ino === workerData.known.ino && standing.size === workerData.known.size;
    if (same && !workerData.forceCopy) {
      const now = new Date(workerData.now);
      fs.utimesSync(target, now, now);
      send({ ok: true, unchanged: true });
    } else {
      fs.closeSync(fs.openSync(temp, 'wx', 0o600));
      source.exec('pragma synchronous = FULL');
      source.prepare('VACUUM INTO ?').run(temp);
      source.close(); source = null;
      check = new DatabaseSync(temp, { readOnly: true });
      const rows = check.prepare('pragma quick_check').all();
      if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new Error('mirror_check_failed');
      check.close(); check = null;
      const fd = fs.openSync(temp, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (fs.existsSync(target)) {
        try {
          fs.linkSync(target, previous);
        } catch (error) {
          if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK'].includes(error.code)) throw error;
          fs.copyFileSync(target, previous, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(previous, 0o600);
          const old = fs.openSync(previous, 'r+');
          try { fs.fsyncSync(old); } finally { fs.closeSync(old); }
        }
        if (fs.existsSync(target + '.1')) fs.renameSync(target + '.1', target + '.2');
        fs.renameSync(previous, target + '.1');
      }
      fs.renameSync(temp, target);
      // Node on Windows cannot open a directory for fsync.
      if (process.platform !== 'win32') {
        const dir = fs.openSync(workerData.directory, 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
      const written = fs.statSync(target);
      send({ ok: true, fingerprint, ino: written.ino, size: written.size });
    }
  }
} catch (error) {
  send({ ok: false, code: typeof error.code === 'string' ? error.code : 'mirror_failed', errcode: error.errcode });
} finally {
  try { source?.close(); } catch {}
  try { check?.close(); } catch {}
  for (const file of [temp, temp + '-journal', temp + '-wal', temp + '-shm', previous]) { try { fs.unlinkSync(file); } catch {} }
}
`;

/** What the last good copy looked like, so an unchanged store need not write another. */
export interface MirrorKnown {
  fingerprint: string;
  ino?: number;
  size?: number;
}

interface WorkerResult extends Partial<MirrorKnown> {
  ok: boolean;
  code?: string;
  errcode?: number;
  lacking?: number;
  blank?: boolean;
  unchanged?: boolean;
}

interface WorkerJob {
  database: string;
  directory: string;
  sweep?: boolean;
  inspectOnly?: boolean;
  known?: MirrorKnown | null;
  forceCopy?: boolean;
  now?: number;
}

function runWorker(job: WorkerJob): Promise<WorkerResult> {
  return new Promise((done, reject) => {
    const worker = new Worker(WORKER, {
      eval: true,
      execArgv: ['--disable-warning=ExperimentalWarning'],
      workerData: job,
    });
    let result: WorkerResult | undefined;
    worker.once('message', (message: WorkerResult) => {
      result = message;
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0 && result) done(result);
      else reject(new Error('The store mirror could not be completed.'));
    });
  });
}

/** The error a refused or failed round rejects with; `code` says which. */
class MirrorRoundError extends Error {
  constructor(
    readonly code: string | undefined,
    readonly errcode: number | undefined,
    readonly lacking?: number,
  ) {
    super('The store mirror could not be completed.');
  }
}

/** What a round came to, as the one injected in a test may say it too. */
export type MirrorCopyOutcome =
  | void
  | ({ blank?: boolean; unchanged?: boolean } & Partial<MirrorKnown>);

/** One round: what the check below decides, and the copy when it decides to write one. */
export async function copyStoreMirror(
  database: string,
  directory: string,
  options: { known?: MirrorKnown | null; forceCopy?: boolean; now?: number } = {},
): Promise<Exclude<MirrorCopyOutcome, void>> {
  const result = await runWorker({
    database,
    directory,
    sweep: true,
    known: options.known ?? null,
    forceCopy: options.forceCopy ?? false,
    now: options.now ?? Date.now(),
  });
  if (!result.ok) throw new MirrorRoundError(result.code, result.errcode, result.lacking);
  return result;
}

/**
 * How many unsent events the copies hold that the store at `database` lacks.
 *
 * Read-only on both sides. Used before a claim, and by `oto-box status`, as well
 * as by every round. A store that is not there yet lacks all of them. A directory
 * that is not there holds none.
 */
export async function copiesHoldingUnsent(database: string, directory: string): Promise<number> {
  const found = await stat(directory).catch(() => null);
  if (!found) return 0;
  const result = await runWorker({ database, directory, inspectOnly: true });
  if (!result.ok) throw new MirrorRoundError(result.code, result.errcode);
  return result.lacking ?? 0;
}

export type MirrorResult =
  | 'mirrored'
  /** Nothing changed since the last good copy: its time moved, nothing was written. */
  | 'unchanged'
  /** The store holds no journal, so a copy of it would protect nothing. */
  | 'nothing_to_copy'
  | 'busy'
  | 'disabled'
  | 'too_soon'
  | 'failed'
  /** The mirror directory is on the store's own drive, or its own drive is not mounted. */
  | 'same_device'
  /** A copy holds an unsent event the store lacks, so nothing was replaced. */
  | 'holds_unsent';

/** The mirror's problem, on the heartbeat. Null while it is keeping up. */
export type MirrorProblem = 'same_device' | 'holds_unsent' | 'failing';

/**
 * The closest path that exists: an unmounted mirror drive leaves its mount
 * point, or nothing at all, and that path's device is what a mkdir would write to.
 */
async function deviceOfNearest(path: string): Promise<number> {
  let at = resolve(path);
  for (;;) {
    const found = await stat(at).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    if (found) return found.dev;
    const up = dirname(at);
    if (up === at) throw new Error(`Nothing exists above ${path}`);
    at = up;
  }
}

/** The switch a local proof needs: both directories on one disk. Never in production. */
function sameDeviceAllowedBy(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'test' && env.OTO_BOX_TEST_MIRROR_SAME_DEVICE === '1';
}

export class StoreMirror {
  failures = 0;
  private consecutive = 0;
  private reported: 'same_device' | 'holds_unsent' | null = null;
  private roundDone = false;
  private dirty = false;
  private running: Promise<MirrorResult> | null = null;
  private lastAttempt = -Infinity;
  private lastCopyAt = -Infinity;
  private known: MirrorKnown | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private trailing: ReturnType<typeof setTimeout> | null = null;
  private dueAt = -Infinity;
  private stopped = false;
  constructor(
    private readonly options: {
      database: string;
      directory?: string | null;
      now?: () => number;
      copy?: (
        database: string,
        directory: string,
        options?: { known?: MirrorKnown | null; forceCopy?: boolean; now?: number },
      ) => Promise<MirrorCopyOutcome>;
      /** Told of each round that failed or refused, which it names. Never fails a sale. */
      onFailure?: (result: 'failed' | 'same_device' | 'holds_unsent') => void;
      /** Both directories on one disk: a test, or a local proof that says so in `env`. */
      allowSameDevice?: boolean;
      env?: NodeJS.ProcessEnv;
      deviceOf?: (path: string) => Promise<number>;
      stopWaitMs?: number;
    },
  ) {}

  async ageSeconds(): Promise<number | null> {
    const age = await this.ageMs();
    return age === null ? null : Math.floor(age / 1000);
  }

  /** The problem Health should be told of, or null. See `MirrorProblem`. */
  get problem(): MirrorProblem | null {
    if (this.reported) return this.reported;
    if (this.running && this.now() - this.lastAttempt > MIRROR_STUCK_AFTER_MS) return 'failing';
    return this.consecutive >= MIRROR_FAILING_AFTER ? 'failing' : null;
  }

  /**
   * True until a round has had its chance in this process. The first round is a
   * minute after the start, and the first heartbeat goes before it, so a box that
   * was off for an hour is not yet a box with an hour-old mirror.
   */
  get settling(): boolean {
    return Boolean(this.options.directory) && !this.roundDone;
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

  /**
   * Fire-and-forget after the outer SQLite commit, never awaited by a sale.
   *
   * THE WINDOW. A record inside the ten-second floor, or one that arrives during
   * a round, is marked and gets a round of its own as soon as the floor has
   * passed, so nothing waits for the next minute. What a dead drive can lose is
   * then about ten seconds plus one round. While rounds keep failing no copy is
   * being made at all, so that bound does not hold: what can be lost is everything
   * since the last good copy. A failed round is retried at the next minute, or at
   * the next sale past the floor, and Health says so after two.
   */
  acceptedUnsent(): void {
    if (!this.options.directory || this.stopped) return;
    this.dirty = true;
    void this.run(true);
  }

  private armTrailing(): void {
    if (!this.dirty || this.stopped || this.trailing || this.running) return;
    this.trailing = setTimeout(() => {
      this.trailing = null;
      if (this.dirty) void this.run(true);
    }, Math.max(0, this.dueAt - this.now()));
    this.trailing.unref?.();
  }

  run(afterUnsent = false): Promise<MirrorResult> {
    if (!this.options.directory || this.stopped) return Promise.resolve('disabled');
    if (this.running) return Promise.resolve('busy');
    const task = this.perform(afterUnsent);
    this.running = task;
    void task.finally(() => {
      this.running = null;
      this.armTrailing();
    });
    return task;
  }

  /**
   * Whether the mirror directory is on the store's own device. A drive that
   * dropped out, or was never mounted, leaves a path on the store's drive, and a
   * copy written there dies with the store while reading as healthy.
   */
  async onStoresDrive(): Promise<boolean> {
    const directory = this.options.directory;
    if (!directory) return false;
    const allowed =
      this.options.allowSameDevice ?? sameDeviceAllowedBy(this.options.env ?? process.env);
    if (allowed) return false;
    const deviceOf = this.options.deviceOf ?? deviceOfNearest;
    const [store, mirror] = await Promise.all([
      deviceOf(dirname(resolve(this.options.database))),
      deviceOf(directory),
    ]);
    return store === mirror;
  }

  private refused(result: 'failed' | 'same_device' | 'holds_unsent'): MirrorResult {
    this.failures += 1;
    if (result === 'failed') this.consecutive += 1;
    else this.reported = result;
    this.roundDone = true;
    // Retried by the minute and by the next sale past the floor, never by itself.
    this.dirty = false;
    try {
      this.options.onFailure?.(result);
    } catch {
      /* reporting cannot fail a sale */
    }
    return result;
  }

  private async perform(afterUnsent: boolean): Promise<MirrorResult> {
    let release: (() => Promise<void>) | undefined;
    try {
      if (afterUnsent) {
        // Measured from the last round's start where this process made one, so a
        // sale during a slow round is not held for a further ten seconds after it.
        // The file's age speaks only for a copy another process or a restart left.
        const age = this.lastAttempt === -Infinity ? await this.ageMs() : this.now() - this.lastAttempt;
        if (age !== null && age <= MIRROR_AFTER_UNSENT_MS) {
          this.dueAt = this.now() + MIRROR_AFTER_UNSENT_MS - age + 1;
          return 'too_soon';
        }
      }
      this.lastAttempt = this.now();
      this.dueAt = this.lastAttempt + MIRROR_AFTER_UNSENT_MS + 1;
      const directory = this.options.directory!;
      // Before any write: an unmounted mirror must not grow a directory on the store's drive.
      if (await this.onStoresDrive()) return this.refused('same_device');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        release = await holdStoreLock(directory, 'mirror');
      } catch (error) {
        if (error instanceof StoreBusyError) return 'busy';
        throw error;
      }
      // Anything committed from here on is after the snapshot, and marks itself.
      this.dirty = false;
      const startedAt = this.now();
      const outcome =
        (await (this.options.copy ?? copyStoreMirror)(this.options.database, directory, {
          known: this.known,
          forceCopy: startedAt - this.lastCopyAt >= MIRROR_FULL_COPY_EVERY_MS,
          now: startedAt,
        })) ?? {};
      this.consecutive = 0;
      this.reported = null;
      this.roundDone = true;
      if (outcome.blank) return 'nothing_to_copy';
      if (outcome.unchanged) return 'unchanged';
      this.lastCopyAt = startedAt;
      this.known = outcome.fingerprint
        ? { fingerprint: outcome.fingerprint, ino: outcome.ino, size: outcome.size }
        : null;
      return 'mirrored';
    } catch (error) {
      if (error instanceof MirrorRoundError && error.code === 'mirror_holds_unsent') {
        this.known = null;
        return this.refused('holds_unsent');
      }
      return this.refused('failed');
    } finally {
      await release?.().catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.trailing) clearTimeout(this.trailing);
    this.trailing = null;
    // A round a dead drive has swallowed must not hold the service's stop.
    let waited: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.running,
      new Promise((done) => {
        waited = setTimeout(done, this.options.stopWaitMs ?? STOP_WAIT_MS);
      }),
    ]);
    if (waited) clearTimeout(waited);
  }
}
