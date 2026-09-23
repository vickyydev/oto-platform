import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';
import {
  createBoxAgent,
  memoryCredentialStore,
  type AgentFetch,
  type AgentResponse,
} from '@oto/box-agent';
import { createVirtualBoxLease, virtualBoxLockId } from '../src/lib/virtual-box-lease';

/**
 * SCRUM-331 — one instance runs the virtual box, and a refusal cannot storm.
 *
 * **What the measurements were.** Around every api deploy the virtual box at
 * Central Floresta went into a loop of `box.auth_denied` → `box.claim_code_issue`
 * → `box.register` at about one cycle every five seconds for a minute or two:
 * 637 refusals and 549 registrations of one box in a day, each registration
 * pulling the whole offline cache again because a fresh registration has no
 * etag. The suspected cause was a Render rollover running two api instances at
 * once, each with its own agent against the one `core.box` row, each taking the
 * other's credential away.
 *
 * **What these tests can and cannot prove.** A two-instance rollover is a
 * property of Render and cannot be reproduced here. What can be reproduced is
 * the mechanism underneath it, and that is what is below: two leases on one
 * key, only one of which owns the box; a lease that survives the other giving
 * it back; a lease whose connection dies stopping the box rather than running
 * without it; and an agent refused over and over registering once a minute
 * rather than once a tick. Two instances are two leases, which is exactly the
 * first case.
 */

let url: string;
let dropDatabase: () => Promise<void>;

beforeAll(async () => {
  // No app and no seed: a lease needs a database to hold a session in, and
  // nothing else in this file touches a table.
  ({ url, drop: dropDatabase } = await createTestDatabase());
});

afterAll(async () => {
  await dropDatabase();
  await stopTestServer();
});

/** Captures what the lease said, in the order it said it. */
function testLog(lines: string[]): FastifyBaseLogger {
  const write =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      lines.push(`${level} ${typeof obj === 'string' ? obj : (msg ?? '')}`);
    };
  const log = {
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('fatal'),
    debug: write('debug'),
    trace: write('trace'),
    silent: () => {},
    level: 'info',
    child: () => log,
  };
  // pino's type carries more than a lease uses, and a fake that implemented
  // all of it would be testing pino.
  return log as unknown as FastifyBaseLogger;
}

async function waitFor(what: string, ready: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface Instance {
  lease: ReturnType<typeof createVirtualBoxLease>;
  /** Every time this instance was told to start the box. */
  starts: number;
  /** Every reason this instance was told to stop it. */
  stops: string[];
  lines: string[];
}

/** One api instance's view of one leased box. */
function instance(
  name: string,
  opts: { retryIntervalMs?: number; applicationName?: string; onAcquire?: () => void } = {},
): Instance {
  const lines: string[] = [];
  const held: Instance = {
    starts: 0,
    stops: [],
    lines,
    lease: createVirtualBoxLease({
      name,
      databaseUrl: url,
      log: testLog(lines),
      retryIntervalMs: opts.retryIntervalMs,
      applicationName: opts.applicationName,
      onAcquire: () => {
        held.starts += 1;
        opts.onAcquire?.();
      },
      onLoss: (reason) => {
        held.stops.push(reason);
      },
    }),
  };
  return held;
}

describe('the virtual box lease (SCRUM-331)', () => {
  it('derives one lock key per box, and a different one per box', () => {
    const [namespace, key] = virtualBoxLockId('virtual-box:hkt-central/virtual-1');
    expect(virtualBoxLockId('virtual-box:hkt-central/virtual-1')).toEqual([namespace, key]);
    expect(virtualBoxLockId('virtual-box:robinson-chalong/virtual-1')[1]).not.toBe(key);
    // Postgres takes two int4s; anything wider would be silently wrong.
    expect(Number.isInteger(key) && key >= -(2 ** 31) && key < 2 ** 31).toBe(true);
  });

  it('gives the box to one instance, and to the next one only when it is given back', async () => {
    const name = `virtual-box:test/${randomUUID()}`;
    const first = instance(name);
    const second = instance(name);

    expect(await first.lease.tick()).toBe(true);
    expect(first.lease.held).toBe(true);
    expect(first.starts).toBe(1);

    // The other instance of the same deployment, doing exactly what it does on
    // boot. It must not construct an agent at all: an agent that registers is
    // an agent that has already taken the first one's credential away.
    expect(await second.lease.tick()).toBe(false);
    expect(second.lease.held).toBe(false);
    expect(second.starts).toBe(0);
    expect(second.lines.filter((l) => l.includes('standing by'))).toHaveLength(1);
    // Standing by is a state, not news: the line is said once, not every tick.
    expect(await second.lease.tick()).toBe(false);
    expect(second.lines.filter((l) => l.includes('standing by'))).toHaveLength(1);

    // Render stops the outgoing container; its connection goes with it.
    await first.lease.stop();
    expect(first.stops).toEqual([]); // a graceful stop is not a loss

    expect(await second.lease.tick()).toBe(true);
    expect(second.starts).toBe(1);
    expect(second.lines.filter((l) => l.includes('acquired'))).toHaveLength(1);

    await second.lease.stop();
  });

  it('takes the box on its own retry, with nobody ticking it', async () => {
    const name = `virtual-box:test/${randomUUID()}`;
    const first = instance(name);
    const second = instance(name, { retryIntervalMs: 50 });

    await first.lease.start();
    expect(first.lease.held).toBe(true);

    await second.lease.start();
    expect(second.lease.held).toBe(false);
    expect(second.starts).toBe(0);

    await first.lease.stop();
    await waitFor('the standing-by instance to take the lease', () => second.lease.held);
    expect(second.starts).toBe(1);

    await second.lease.stop();
  });

  it('stops the box when its lease connection dies, and does not run without it', async () => {
    const name = `virtual-box:test/${randomUUID()}`;
    const applicationName = `oto-lease-test-${randomUUID().slice(0, 8)}`;
    const owner = instance(name, { applicationName });

    expect(await owner.lease.tick()).toBe(true);
    expect(owner.starts).toBe(1);

    // What a Postgres restart does to the session holding the lock. Done from
    // another connection, because the point is that the lease finds out about
    // it rather than being told.
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const killed = await admin.query(
      'select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1',
      [applicationName],
    );
    expect(killed.rowCount).toBe(1);

    // The connection's own error reaches the lease; a pass finds it either way.
    await owner.lease.tick();
    await waitFor('the lease to report the loss', () => owner.stops.length > 0);
    expect(owner.stops).toHaveLength(1);
    expect(owner.lines.filter((l) => l.includes('lease lost'))).toHaveLength(1);
    // The box runs exactly when the lease is held, and never without it. Which
    // of the two it is depends on whether the loop has already taken the lease
    // back by now — that it cannot be running WITHOUT one is the invariant.
    expect(owner.starts - owner.stops.length).toBe(owner.lease.held ? 1 : 0);

    // And it goes back to asking rather than giving up: the lock died with the
    // terminated session, so the box comes back on a fresh connection — once,
    // not once per pass.
    expect(await owner.lease.tick()).toBe(true);
    expect(owner.starts).toBe(2);
    await owner.lease.stop();

    // The same key is free again for any instance, which is what a session
    // holding it dying is supposed to mean.
    const next = instance(name);
    expect(await next.lease.tick()).toBe(true);

    await next.lease.stop();
    await admin.end();
  });
});

// --- The refusal back-off ---------------------------------------------------

const BOX_ID = '018f0000-0000-7000-8000-00000000b0c5';

function answer(status: number, body: unknown): AgentResponse {
  return {
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    header: () => null,
  };
}

/**
 * The agent from `@oto/box-agent`, pointed at a cloud that refuses everything
 * it is asked and accepts every registration — which is what the far side of
 * two agents fighting over one credential looks like from here.
 */
function refusedAgent() {
  let now = Date.parse('2026-09-23T05:00:00.000Z');
  const counts = { registrations: 0, polls: 0 };
  const fetch: AgentFetch = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/box/v1/register' && init.method === 'POST') {
      counts.registrations += 1;
      return answer(200, {
        boxId: BOX_ID,
        secret: `${'a'.repeat(63)}${counts.registrations}`,
        name: 'Virtual Box',
        slot: 'virtual-1',
        role: 'virtual',
        branchId: '018f0000-0000-7000-8000-0000000000b2',
        operatorId: '018f0000-0000-7000-8000-0000000000b1',
        epoch: 1,
        heartbeatIntervalS: 60,
        minSupportedAgentVersion: '0.1.0',
      });
    }
    if (path === '/box/v1/commands/poll') {
      counts.polls += 1;
      return answer(401, { error: { code: 'BOX_UNAUTHORIZED', message: 'not valid' } });
    }
    return answer(404, null);
  };
  const agent = createBoxAgent({
    apiBaseUrl: 'http://virtual-box.test',
    credentials: memoryCredentialStore(),
    hostname: 'virtual-test',
    claimCode: async () => 'ABCDE-FGHJK',
    fetch,
    now: () => now,
  });
  return {
    agent,
    counts,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('the refusal back-off (SCRUM-331)', () => {
  it('registers once for a storm of refusals, and again only after the window', async () => {
    const { agent, counts, advance } = refusedAgent();

    expect(await agent.ensureRegistered()).toBe(true);
    // The boot registration is not what this measures.
    counts.registrations = 0;

    // First refusal: dropped and registered again at once, which is how a
    // rotated claim code brings a box back.
    await agent.runPendingCommands();
    expect(counts.registrations).toBe(1);

    // Everything after it inside the minute is counted and nothing else.
    await agent.runPendingCommands();
    await agent.runPendingCommands();
    expect(counts.registrations).toBe(1);
    // Three polls, so the credential was KEPT while the door was shut: an
    // agent that dropped it would have stopped asking and gone silent.
    expect(counts.polls).toBe(3);
    expect(agent.recentLogs().filter((l) => l.includes('inside the back-off window'))).toHaveLength(
      2,
    );

    advance(60_000);
    await agent.runPendingCommands();
    expect(counts.registrations).toBe(2);
    expect(counts.polls).toBe(4);

    // Before this, the same four polls cost four registrations and four full
    // cache pulls — one per tick, for as long as the other agent was alive.
    advance(1_000);
    await agent.runPendingCommands();
    expect(counts.registrations).toBe(2);
  });
});
