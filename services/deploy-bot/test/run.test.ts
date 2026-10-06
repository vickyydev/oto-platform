import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { createDigest } from '../src/digest.js';
import { loadEnv } from '../src/env.js';
import type { RenderApi, RenderDeploy } from '../src/render.js';

/**
 * Just enough of Postgres for the digest: the key-value markers and the
 * outbox, held in memory. Transactions are accepted and ignored.
 */
function fakeDb() {
  const kv = new Map<string, string>();
  const outbox: { body: string; delayMinutes: number }[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (/select value from .*\.kv/.test(sql)) {
      const value = kv.get(String(params[0]));
      return {
        rows: value === undefined ? [] : [{ value }],
        rowCount: value === undefined ? 0 : 1,
      };
    }
    if (/insert into .*\.kv/.test(sql)) kv.set(String(params[0]), String(params[1]));
    if (/insert into .*\.outbox/.test(sql)) {
      outbox.push({ body: String(params[0]), delayMinutes: Number(params[1]) });
    }
    return { rows: [], rowCount: 1 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { db: { pool, s: '"t"', close: async () => undefined } as unknown as Db, kv, outbox };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function deployOf(sha: string, committedMinutesAgo: number, subject: string): RenderDeploy {
  return {
    id: `dep-${sha}`,
    status: 'live',
    trigger: 'new_commit',
    finishedAt: minutesAgo(committedMinutesAgo - 4),
    commit: {
      id: sha,
      message: `feat(pos): ${subject}`,
      createdAt: minutesAgo(committedMinutesAgo),
    },
  };
}

function setup(deploys: RenderDeploy[], overrides: Record<string, string> = {}) {
  const { db, kv, outbox } = fakeDb();
  let queuedSignals = 0;
  const render: RenderApi = {
    listServices: async () => [{ id: 'srv-1', name: 'oto-pos-staging' }],
    listDeploys: async () => deploys,
  };
  const digest = createDigest({
    db,
    // No model key: the digest is written from the commit subjects, so these
    // tests never leave the machine.
    env: loadEnv({ DATABASE_URL: 'postgres://x', ADMIN_TOKEN: 'x'.repeat(32), ...overrides }),
    render,
    log: pino({ level: 'silent' }),
    onQueued: () => {
      queuedSignals += 1;
    },
  });
  return { digest, kv, outbox, queuedSignals: () => queuedSignals };
}

const today = [
  deployOf('aaa', 300, 'choose a station on sign-in'),
  deployOf('bbb', 120, 'print the band'),
];

describe('digest.run', () => {
  it('preview builds the message and touches nothing', async () => {
    const { digest, kv, outbox, queuedSignals } = setup(today);
    const result = await digest.run({ mode: 'preview' });
    expect(result).toMatchObject({ result: 'preview', recorded: false, commits: 2 });
    expect(outbox).toEqual([]);
    expect(kv.size).toBe(0);
    expect(queuedSignals()).toBe(0);
  });

  it('test sends the message now and records nothing, so the real digest still covers it', async () => {
    const { digest, kv, outbox, queuedSignals } = setup(today);
    const result = await digest.run({ mode: 'test' });
    expect(result).toMatchObject({ result: 'queued', recorded: false });
    expect(outbox.length).toBe(1);
    expect(outbox[0]?.body).toContain('• Choose a station on sign-in');
    expect(outbox[0]?.delayMinutes).toBe(0);
    expect(queuedSignals()).toBe(1);
    expect(kv.size).toBe(0);

    const morning = await digest.run({ mode: 'send' });
    expect(morning).toMatchObject({ result: 'queued', recorded: true, commits: 2 });
  });

  it('send records what it announced, and the next run has nothing new to say', async () => {
    const { digest, kv, outbox } = setup(today);
    await digest.run({ mode: 'send' });
    expect(kv.get('last_announced_commit')).toBe('bbb');
    expect(kv.has('last_digest_at')).toBe(true);

    expect(await digest.run({ mode: 'send' })).toEqual({ result: 'nothing_deployed' });
    expect(outbox.length).toBe(1);
  });

  it('a window of hours ignores what was already announced', async () => {
    const { digest, outbox } = setup(today);
    await digest.run({ mode: 'send' });

    const again = await digest.run({ mode: 'test', hours: 24 });
    expect(again).toMatchObject({ result: 'queued', recorded: false, commits: 2 });
    expect(outbox.length).toBe(2);
  });

  it('a window only reaches as far back as it says', async () => {
    const { digest } = setup(today);
    const result = await digest.run({ mode: 'preview', hours: 3 });
    expect(result).toMatchObject({ result: 'preview', commits: 1 });
  });

  it('spaces the parts of a long digest apart', async () => {
    const many = Array.from({ length: 12 }, (_, n) =>
      deployOf(
        `c${n}`,
        600 - n * 10,
        `change number ${n + 1} that reception staff will notice today`,
      ),
    );
    const { digest, outbox } = setup(many, { PART_MAX_CHARS: '400', PART_INTERVAL_MIN: '30' });
    await digest.run({ mode: 'test' });
    expect(outbox.length).toBeGreaterThan(1);
    expect(outbox.map((m) => m.delayMinutes)).toEqual(outbox.map((_, n) => n * 30));
  });

  it('says so when nothing was deployed', async () => {
    const { digest, outbox } = setup([]);
    expect(await digest.run({ mode: 'test' })).toEqual({ result: 'nothing_deployed' });
    expect(outbox).toEqual([]);
  });
});

describe('loadEnv', () => {
  it('refuses a catch-up deadline earlier than the send time', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://x',
        ADMIN_TOKEN: 'x'.repeat(32),
        DIGEST_TIME: '11:00',
        DIGEST_LATEST: '10:00',
      }),
    ).toThrow(/DIGEST_LATEST/);
  });
});
