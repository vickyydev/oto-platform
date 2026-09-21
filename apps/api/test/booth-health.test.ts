import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNotNull, like, or, sql } from 'drizzle-orm';
import { account, alert, box, boxOutbox, branch, spin, station, voucher, type Db } from '@oto/db';
import { newId } from '@oto/shared';
import {
  createBoxAgent,
  memoryCredentialStore,
  postgresBoxDriver,
  SqlBoxStore,
  type AgentFetch,
  type Booth,
  type BoxAgent,
  type PgPoolLike,
} from '@oto/box-agent';
import { runWatchdog } from '../src/services/jobs';
import { type AlertChannel, type AlertMessage } from '../src/services/ops';
import { provisionVirtualBox } from '../src/services/box';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-07a — a booth on the Health page, from the press to the panel.
 *
 * The seam this file crosses is the one a slice on either side of it cannot
 * test alone. Build only the box and the booth block travels up every
 * heartbeat with nothing on this side reading it. Build only the cloud and the
 * fields are never there: `GET /ops/health` reports a booth whose every
 * measurement is null, which looks exactly like a booth that has not been set
 * up. Both halves pass their own suites in both of those worlds.
 *
 * So nothing below writes a heartbeat by hand. A real booth module on a real
 * in-process agent draws a real prize, the facts land on the real durable
 * outbox, `flush()` goes through the real `POST /box/v1/sync/push`, the real
 * `heartbeat()` reports what the box measured, and the real watchdog decides
 * what is worth raising. Only the socket (`app.inject`) and the printer (the
 * simulator every virtual box uses) stand in for hardware.
 *
 * The exception is the last case, which edits the stored report directly and
 * says so: getting a seeded wheel to give away every one of a prize would take
 * hundreds of presses to prove one line of arithmetic that is the box's, not
 * this side's.
 */

let ctx: TestContext;
let agent: BoxAgent;
let booth: Booth;
let boothStationId: string;
let adminCookie: string;
let delivered: AlertMessage[] = [];
let channels: AlertChannel[] = [];

/** `app.inject` behind the agent's transport, as `booth-sync.test.ts` does it. */
function injectTransport(): AgentFetch {
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const res = await ctx.app.inject({
      method: init.method as 'GET',
      url: path,
      headers: init.headers,
      payload: init.body,
    });
    return {
      status: res.statusCode,
      json: async () => (res.body ? JSON.parse(res.body) : null),
      text: async () => res.body,
      header: (name) => {
        const value = res.headers[name.toLowerCase()];
        return typeof value === 'string' ? value : null;
      },
    };
  };
}

/** What `/ops/health` answers, narrowed to the parts this file reads. */
interface HealthBody {
  status: string;
  boxes: Array<{
    id: string;
    name: string;
    slot: string;
    state: string;
    detail: string | null;
    outboxDepth: number | null;
    conditions: string[];
    booths: Array<{
      stationId: string;
      name: string;
      codePrefix: string | null;
      reported: {
        configVersion: number | null;
        printerReachable: string;
        paperStatus: string;
        vouchersPending: number | null;
        lastSpinAt: string | null;
        staffSignedIn: boolean;
        dailyCapsReached: string[];
      } | null;
      unattributedToday: number | null;
      businessDate: string;
    }>;
  }>;
  alerts: Array<{ key: string; severity: string; title: string; detail: string | null }>;
}

const health = async (): Promise<HealthBody> =>
  (
    await ctx.app.inject({ method: 'GET', url: '/ops/health', headers: { cookie: adminCookie } })
  ).json<HealthBody>();

const theBooth = async () => {
  const body = await health();
  const box = body.boxes.find((b) => b.booths.some((s) => s.stationId === boothStationId));
  expect(box, 'Health reported no box driving the seeded booth').toBeTruthy();
  return { box: box!, booth: box!.booths.find((s) => s.stationId === boothStationId)! };
};

const watchdog = () => runWatchdog({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, channels });

/**
 * Midnight to midnight, so every case runs the same whatever the hour.
 * `withinOpeningHours` reads a close that is not after the open as a day that
 * runs past midnight.
 */
const ALWAYS_OPEN = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [
    day,
    { open: '00:00', close: '00:00' },
  ]),
);

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  channels = [
    {
      name: 'console',
      async deliver(message) {
        delivered.push(message);
        return { target: 'test' };
      },
    },
  ];

  const [seeded] = await ctx.db
    .select({ id: station.id })
    .from(station)
    .where(eq(station.name, 'Booth 1'))
    .limit(1);
  boothStationId = seeded!.id;

  // The park is open for the whole of this file, so the silence rules are
  // decided by what the box did rather than by what time the suite ran.
  await ctx.db
    .update(branch)
    .set({ openingHours: ALWAYS_OPEN as never })
    .where(eq(branch.code, 'hkt-central'));

  const pool = (ctx.db as unknown as { $client: PgPoolLike }).$client;
  agent = createBoxAgent({
    apiBaseUrl: 'http://booth-health.test',
    credentials: memoryCredentialStore(),
    hostname: 'booth-health-test',
    fetch: injectTransport(),
    claimCode: async () => (await provisionVirtualBox(ctx.db as Db, ctx.app.log))?.claimCode ?? null,
    store: new SqlBoxStore({ driver: postgresBoxDriver(pool) }),
    booth: { randomIndex: (max) => randomInt(max) },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  await agent.syncCache();

  const built = agent.booth();
  if (!built) throw new Error('the agent built no booth module — no spin can be taken on this box');
  booth = built;
  await booth.start();
  if (!booth.config()) {
    throw new Error('the booth adopted no wheel: the `booth` cache scope reached it empty');
  }
});

afterAll(async () => {
  booth?.stop();
  agent?.stop();
  await ctx.close();
  await teardownAll();
});

describe('a booth reaches the Health page (S2-07a)', () => {
  it('reports the wheel it is running, what it is holding, and that nobody is signed in', async () => {
    await booth.signOut();

    /**
     * Two presses, and only the first is handed over.
     *
     * The first is what the cloud can count: D13's condition is evaluated from
     * `promo.voucher.issued_by_account_id`, which does not exist here until a
     * push arrives. The second is what the box is still holding, which is what
     * the heartbeat reports and what the panel calls "waiting to sync". A
     * single press could only ever show one of the two.
     */
    const first = await booth.spin({ idempotencyKey: newId() });
    expect(first.staffAccountId, 'the booth attributed a spin nobody signed in for').toBeNull();
    const pushed = await agent.outbox()!.flush();
    expect(pushed.state).toBe('pushed');

    await booth.spin({ idempotencyKey: newId() });
    const held = await agent.outbox()!.depth();
    expect(held.queued, 'the second press left nothing queued to report').toBeGreaterThan(0);

    // The real heartbeat, carrying whatever the booth module measured.
    const ack = await agent.heartbeat();
    expect(ack, 'the box could not call home, so nothing below is about a booth').toBeTruthy();

    const { box: boxRow, booth: seen } = await theBooth();
    expect(seen.name).toBe('Booth 1');
    expect(seen.codePrefix).toBe('B1');

    /**
     * The block itself. A null here is the exact failure this file exists to
     * catch: the box measured all of it and the cloud dropped it on the floor.
     */
    expect(
      seen.reported,
      'the booth block never reached Health — the box measured it and this side stored nothing',
    ).toBeTruthy();
    const reported = seen.reported!;

    // The wheel, by the number the box actually drew on, not by the newest
    // version somebody published.
    expect(reported.configVersion).toBe(booth.config()!.version);
    expect(reported.configVersion).toBe(first.configVersion);

    expect(reported.staffSignedIn).toBe(false);
    expect(reported.lastSpinAt, 'a booth that has spun twice reported no last spin').toBeTruthy();
    expect(reported.vouchersPending).toBe(held.queued);
    // Measured, never defaulted: the simulator answers, so this is not `unknown`.
    expect(reported.printerReachable).toBe('reachable');
    expect(reported.paperStatus).toBe('ok');
    expect(reported.dailyCapsReached).toEqual([]);

    // And the one number only this side can answer: the voucher that arrived
    // with nobody's name against it.
    expect(seen.unattributedToday).toBe(1);
    expect(seen.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    /**
     * D13 — one condition with a count, and the page knows it before the
     * watchdog has run, because both read the same evaluation.
     */
    expect(boxRow.conditions).toContain(`booth.unattributed:${boothStationId}`);

    const [raised] = await ctx.db
      .select()
      .from(alert)
      .where(eq(alert.key, `booth.unattributed:${boothStationId}`));
    expect(raised, 'a booth gave a prize away to nobody and nothing was raised').toBeTruthy();
    expect(raised!.status).toBe('open');
    expect(raised!.category).toBe('booth.unattributed');
    /**
     * The wording is not asserted beyond the phrase both sides share. The push
     * raises this row naming the BOX ("Virtual box 1 is issuing booth vouchers
     * with nobody signed in") and the evaluation here raises it naming the
     * BOOTH, so whichever wrote last decides how the row reads. That is a real
     * disagreement, and it belongs to the file that raises from the push
     * rather than to this one.
     */
    expect(raised!.summary).toContain('nobody signed in');
  });

  it('counts vouchers, not presses: sixty unattributed ones are one row', async () => {
    // Hand over anything an earlier case left queued, so what is counted below
    // is this case's three presses and not a carry-over.
    await agent.outbox()!.flush();
    const before = (await theBooth()).booth.unattributedToday!;

    for (let i = 0; i < 3; i += 1) await booth.spin({ idempotencyKey: newId() });
    await agent.outbox()!.flush();

    const after = (await theBooth()).booth.unattributedToday!;
    expect(after).toBe(before + 3);

    // Still one alert row, with a count that has moved rather than four rows.
    const rows = await ctx.db
      .select()
      .from(alert)
      .where(eq(alert.key, `booth.unattributed:${boothStationId}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrences).toBeGreaterThan(1);
    expect(rows[0]!.status).toBe('open');
  });

  it('does not count a voucher that arrived with a name against it', async () => {
    /**
     * Attributed on the row rather than at the wheel, and the reason is worth
     * stating: **no booth can sign anybody in today.** The seed hashes a PIN
     * into `core.credential`, the box verifies against `pinHash` on its cached
     * staff list, and the cloud's `staff` cache scope does not carry that field
     * — so `booth.signIn({ pin })` refuses on every box, and every voucher the
     * park issues is unattributed until S2-07b fills the scope in.
     *
     * What is under test here is this side's rule, and the rule is which
     * column it reads: `promo.voucher.issued_by_account_id`, the same column
     * the push raises D13 from. So one arrived voucher is given an issuer and
     * the count must drop by exactly one.
     */
    const before = (await theBooth()).booth.unattributedToday!;
    expect(before, 'this case needs an unattributed voucher to attribute').toBeGreaterThan(0);

    const [mine] = await ctx.db
      .select({ voucherId: spin.voucherId })
      .from(spin)
      .where(and(eq(spin.stationId, boothStationId), isNotNull(spin.voucherId)))
      .limit(1);
    const [admin] = await ctx.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.phone, ADMIN.phone))
      .limit(1);
    await ctx.db
      .update(voucher)
      .set({ issuedByAccountId: admin!.id })
      .where(eq(voucher.id, mine!.voucherId!));

    const { booth: seen } = await theBooth();
    expect(seen.unattributedToday, 'a voucher with an issuer was still counted').toBe(before - 1);
  });

  it('closes the condition when the trading day it counted has rolled over', async () => {
    /**
     * The rollover, staged as the rows it changes.
     *
     * Within one trading day this count only grows — a spin filed with nobody
     * signed in keeps its null for ever — so the only thing that ever closes
     * this condition is the day turning over. Moving yesterday's presses back
     * a day is that, expressed as data, and it is what a watchdog tick at five
     * past five in the morning sees.
     */
    await ctx.db
      .update(spin)
      .set({ businessDate: sql`${spin.businessDate} - interval '1 day'` })
      .where(eq(spin.stationId, boothStationId));

    const { box: boxRow, booth: seen } = await theBooth();
    expect(seen.unattributedToday).toBe(0);
    expect(boxRow.conditions).not.toContain(`booth.unattributed:${boothStationId}`);

    delivered = [];
    await watchdog();
    const [row] = await ctx.db
      .select()
      .from(alert)
      .where(eq(alert.key, `booth.unattributed:${boothStationId}`));
    expect(row!.status).toBe('resolved');
    expect(row!.resolvedAt).toBeTruthy();
    // Not "recovered": nobody fixed a sign-in, the day turned over.
    expect(row!.resolvedReason).toBe('nothing unattributed today');

    /**
     * No channel hears about it, and the reason is upstream of this ticket: a
     * resolution is only delivered where the raise was, and this row was
     * opened by the PUSH, which writes the alert without delivering it. So the
     * first thing any channel would ever hear about an unattributed booth is
     * silence. Asserted as it is rather than as it ought to be.
     */
    expect(delivered.map((m) => m.key)).not.toContain(`booth.unattributed:${boothStationId}`);
  });

  it('a prize at its daily cap is news and not a fault — it never paints the booth amber', async () => {
    /**
     * The one report this file writes by hand, and what that costs.
     *
     * Everything above came off the real booth; this does not, because making
     * the seeded wheel exhaust a prize takes hundreds of presses to exercise
     * arithmetic that lives on the box and is proved in `box-agent`'s own
     * suite. What is under test here is this side's rule: that a cap reached
     * is carried at `info`, and that `info` moves neither the box's tile nor
     * the platform's verdict.
     */
    await ctx.db.delete(alert).where(or(like(alert.key, 'booth.%'), like(alert.key, 'box.%')));
    const [row] = await ctx.db.select().from(box).where(eq(box.slot, 'virtual-1')).limit(1);
    const last = row!.lastStatus as Record<string, unknown>;
    const reported = last.booth as Record<string, unknown>;
    expect(reported, 'this case depends on the booth block the heartbeat above stored').toBeTruthy();
    await ctx.db
      .update(box)
      .set({
        lastStatus: {
          ...last,
          booth: { ...reported, dailyCapsReached: [newId(), newId()] },
        } as never,
      })
      .where(eq(box.id, row!.id));

    const { box: boxRow, booth: seen } = await theBooth();
    expect(seen.reported!.dailyCapsReached).toHaveLength(2);
    expect(boxRow.conditions).toContain(`booth.prize_cap:${boothStationId}`);
    // The tile is not amber, and the sentence is still on it.
    expect(boxRow.state).toBe('ok');
    expect(boxRow.detail).toContain("today's cap");

    delivered = [];
    await watchdog();
    const [raised] = await ctx.db
      .select()
      .from(alert)
      .where(eq(alert.key, `booth.prize_cap:${boothStationId}`));
    expect(raised!.severity).toBe('info');
    expect(raised!.status).toBe('open');

    // Open, listed, and not dragging the page's verdict to amber.
    const body = await health();
    expect(body.alerts.some((a) => a.key === `booth.prize_cap:${boothStationId}`)).toBe(true);
    expect(body.status).toBe('ok');
  });

  it('an offline booth still says it is holding events, which is not the same as broken (D10)', async () => {
    await ctx.db.delete(alert).where(or(like(alert.key, 'booth.%'), like(alert.key, 'box.%')));
    await ctx.db.delete(alert).where(like(alert.key, 'sync.%'));

    /**
     * A booth that went offline this morning and is still spinning.
     *
     * Staged as the two facts the cloud would hold: a queue whose oldest entry
     * is hours old, and a box that stopped calling home — which is what going
     * offline actually does, because the agent returns from `heartbeat()`
     * before the send once the offline flag is set.
     */
    await booth.spin({ idempotencyKey: newId() });
    const hoursAgo = new Date(Date.now() - 4 * 3_600_000);
    await ctx.db
      .update(boxOutbox)
      .set({ createdAt: hoursAgo })
      .where(and(eq(boxOutbox.boxId, agent.state.boxId!), eq(boxOutbox.state, 'queued')));
    await ctx.db
      .update(box)
      .set({ lastHeartbeatAt: hoursAgo })
      .where(eq(box.id, agent.state.boxId!));

    const { box: boxRow } = await theBooth();
    const stale = `sync.stale:${agent.state.boxId}`;
    expect(
      boxRow.conditions,
      'a booth that has been offline all day reported nothing about the queue it is sitting on',
    ).toContain(stale);
    // Both sentences, because they are different ones.
    expect(boxRow.conditions).toContain(`box.offline:${agent.state.boxId}`);

    await watchdog();
    const [raised] = await ctx.db.select().from(alert).where(eq(alert.key, stale));
    expect(raised!.status).toBe('open');
    expect(raised!.summary).toContain('still working');
    expect(raised!.summary).not.toContain('is calling home');
  });
});
