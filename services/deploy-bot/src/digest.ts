import type { Logger } from 'pino';
import { kvGet, kvSet, type Db } from './db.js';
import type { Env } from './env.js';
import { digestParts, sectionsFromCommits, type CommitInfo } from './message.js';
import { enqueue } from './outbox.js';
import { wentLive, type RenderApi, type RenderDeploy } from './render.js';
import { summarise } from './summary.js';

const LAST_COMMIT = 'last_announced_commit';
const LAST_COMMIT_AT = 'last_announced_commit_at';
const LAST_RUN_AT = 'last_digest_at';
const LAST_RUN_DAY = 'last_digest_day';

// How far behind the last digest to read deploys. Wide enough to find the
// commits of deploys that failed or were superseded before the last digest
// and only reached production afterwards, inside a later deploy.
const LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/**
 * - `preview`: build the digest and return it. Nothing is sent or recorded.
 * - `send`: the morning run, now. Sent and recorded, so the next digest
 *   starts after it.
 * - `test`: sent to the group exactly as a real one would be, but not
 *   recorded — the next real digest still covers the same changes. For trying
 *   the whole path live without using up the day's news.
 */
export type DigestMode = 'preview' | 'send' | 'test';

export interface DigestOptions {
  mode: DigestMode;
  /**
   * Look back this many hours and ignore what was already announced, instead
   * of continuing from the last digest. Lets a preview or a test show a full
   * message on a day when nothing is new.
   */
  hours?: number;
}

export type DigestResult =
  | { result: 'nothing_deployed' | 'nothing_new' }
  | {
      result: 'queued' | 'preview';
      /** Whether the markers moved — true only for a real send. */
      recorded: boolean;
      parts: string[];
      commits: number;
      summarised: boolean;
    };

export interface SeenDeploy {
  service: string;
  deploy: RenderDeploy;
}

export interface Release {
  /** Deploys that went live after the last digest, oldest first. */
  live: SeenDeploy[];
  /** The commit now running: that of whichever deploy finished last. */
  head: { sha: string; at: number | null } | null;
  /** What that commit brought with it since the last announcement, oldest first. */
  commits: CommitInfo[];
  rollback: boolean;
}

/**
 * Work out what is new from Render's deploy records alone.
 *
 * Render records one commit per deploy — the one it built. That is nearly the
 * whole history here, because almost every commit is pushed and deployed on
 * its own. The ones it would miss are commits whose deploy failed or was
 * cancelled by the next push: their deploy never went live, but on a linear
 * branch their changes did, inside the next deploy that succeeded. So commits
 * are collected from every deploy, whatever became of it, and kept when they
 * fall after the last announced commit and no later than the one now running.
 * A commit that was pushed together with others and never deployed by itself
 * is the one thing this cannot see.
 */
export function releaseSince(all: SeenDeploy[], since: Date, lastCommitAt: number | null): Release {
  const finished = (d: RenderDeploy) => (d.finishedAt ? Date.parse(d.finishedAt) : 0);
  const committed = (d: RenderDeploy) =>
    d.commit?.createdAt ? Date.parse(d.commit.createdAt) : null;

  const live = all
    .filter(({ deploy }) => wentLive(deploy) && finished(deploy) > since.getTime())
    .sort((a, b) => finished(a.deploy) - finished(b.deploy));

  const headDeploy = live.at(-1)?.deploy;
  if (!headDeploy?.commit) return { live, head: null, commits: [], rollback: false };
  const head = { sha: headDeploy.commit.id, at: committed(headDeploy) };

  const rollback =
    live.some(({ deploy }) => deploy.trigger === 'rollback') ||
    (head.at !== null && lastCommitAt !== null && head.at < lastCommitAt);

  const asCommit = (d: RenderDeploy): CommitInfo | null =>
    d.commit?.message ? { sha: d.commit.id, message: d.commit.message } : null;

  if (rollback || head.at === null) {
    const only = asCommit(headDeploy);
    return { live, head, commits: only ? [only] : [], rollback };
  }

  // With nothing announced yet, start from the oldest commit that went live in
  // this window rather than from the beginning of time.
  const liveTimes = live.map(({ deploy }) => committed(deploy)).filter((t) => t !== null);
  const after = lastCommitAt ?? Math.min(...liveTimes) - 1;

  const bySha = new Map<string, { at: number; commit: CommitInfo }>();
  for (const { deploy } of all) {
    const at = committed(deploy);
    const commit = asCommit(deploy);
    if (at === null || !commit || at <= after || at > head.at) continue;
    bySha.set(commit.sha, { at, commit });
  }
  const commits = [...bySha.values()].sort((a, b) => a.at - b.at).map((c) => c.commit);
  return { live, head, commits, rollback };
}

interface Deps {
  db: Db;
  env: Env;
  render: RenderApi;
  log: Logger;
  onQueued(): void;
}

export function createDigest({ db, env, render, log, onQueued }: Deps) {
  const s = db.s;

  /**
   * Work out what went live since the last digest and, unless this is only a
   * preview, queue the messages. Nothing about the deploys is stored: Render
   * is asked what it deployed at the moment the digest is written.
   *
   * "New" is judged by commit, not by deploy. A day of restarts and settings
   * changes redeploys the same code, and a digest that said so every morning
   * would teach the group to stop reading it.
   */
  async function run(opts: DigestOptions): Promise<DigestResult> {
    const now = new Date();
    const record = opts.mode === 'send';
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60_000);

    // An explicit window starts from a clean slate: the stored markers are
    // what would make it answer "nothing new".
    const storedSince = opts.hours ? null : await kvGet(db.pool, s, LAST_RUN_AT);
    const since = opts.hours
      ? hoursAgo(opts.hours)
      : storedSince
        ? new Date(storedSince)
        : hoursAgo(24);
    const lastCommit = opts.hours ? null : await kvGet(db.pool, s, LAST_COMMIT);
    const storedCommitAt = opts.hours ? null : await kvGet(db.pool, s, LAST_COMMIT_AT);
    const lastCommitAt = storedCommitAt ? Number(storedCommitAt) : null;

    const services = (await render.listServices()).filter(
      (svc) =>
        svc.id !== env.RENDER_SERVICE_ID &&
        !env.IGNORE_SERVICES.includes(svc.name) &&
        (env.WATCH_SERVICES.length === 0 || env.WATCH_SERVICES.includes(svc.name)),
    );

    const all: SeenDeploy[] = [];
    const from = new Date(since.getTime() - LOOKBACK_MS);
    for (const svc of services) {
      for (const deploy of await render.listDeploys(svc.id, from)) {
        all.push({ service: svc.name, deploy });
      }
    }
    const { live, head, commits, rollback } = releaseSince(all, since, lastCommitAt);

    const finish = async (result: 'nothing_deployed' | 'nothing_new'): Promise<DigestResult> => {
      if (record) await kvSet(db.pool, s, LAST_RUN_AT, now.toISOString());
      log.info({ result, services: services.length, deploys: live.length }, 'digest skipped');
      return { result };
    };
    if (live.length === 0) return finish('nothing_deployed');
    if (head !== null && head.sha === lastCommit) return finish('nothing_new');

    const written = await summarise(env.ANTHROPIC_API_KEY, env.SUMMARY_MODEL, commits, log);
    const parts = digestParts({
      envLabel: env.ENV_LABEL,
      at: now,
      timeZone: env.DIGEST_TZ,
      sections: written ?? sectionsFromCommits(commits),
      services: live.map((l) => l.service),
      commitCount: commits.length,
      rollback,
      maxChars: env.PART_MAX_CHARS,
      maxParts: env.MAX_PARTS,
    });

    const summary = {
      recorded: record,
      parts,
      commits: commits.length,
      summarised: written !== null,
    };
    if (opts.mode === 'preview') return { result: 'preview', ...summary };

    // The messages and the markers move together: a crash before this point
    // repeats the whole digest next time, a crash after it repeats nothing.
    // A test queues the same messages and leaves the markers where they were.
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      for (const [n, body] of parts.entries()) {
        await enqueue(client, s, body, n * env.PART_INTERVAL_MIN, env.MESSAGE_TTL_HOURS);
      }
      if (record) {
        await kvSet(client, s, LAST_RUN_AT, now.toISOString());
        if (head) await kvSet(client, s, LAST_COMMIT, head.sha);
        if (head?.at != null) await kvSet(client, s, LAST_COMMIT_AT, String(head.at));
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    log.info(
      {
        mode: opts.mode,
        parts: parts.length,
        commits: commits.length,
        summarised: written !== null,
      },
      'digest queued',
    );
    onQueued();
    return { result: 'queued', ...summary };
  }

  let retryAt = 0;

  /**
   * Called every minute. Runs the digest once per local day, at or after
   * DIGEST_TIME and no later than DIGEST_LATEST. The day is marked only when
   * a run completes, so a failed run is tried again — ten minutes apart, so a
   * Render outage is not answered with a request a minute.
   */
  async function tick(): Promise<void> {
    const now = new Date();
    const { day, minutes } = localClock(now, env.DIGEST_TZ);
    if (minutes < env.DIGEST_TIME || minutes > env.DIGEST_LATEST) return;
    if (now.getTime() < retryAt) return;
    if ((await kvGet(db.pool, s, LAST_RUN_DAY)) === day) return;
    if (!env.RENDER_API_KEY) return;

    try {
      await run({ mode: 'send' });
      await kvSet(db.pool, s, LAST_RUN_DAY, day);
    } catch (err) {
      retryAt = now.getTime() + 10 * 60_000;
      log.error({ err }, 'digest failed; will retry in ten minutes');
    }
  }

  return { run, tick };
}

/** The calendar day and minutes past midnight, as a clock in `timeZone` shows them. */
export function localClock(at: Date, timeZone: string): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}
