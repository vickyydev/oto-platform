import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import {
  box,
  boothPrize,
  boxPrintJob,
  branch,
  spin,
  syncEvent,
  voucherDefinition,
  type Db,
} from '@oto/db';
import { businessDate, newId, type SpinResponse } from '@oto/shared';
import { renderJob, type PrintJob as RenderPrintJob } from '@oto/print';
import { PROFILES } from '@oto/print/fixtures';
import {
  BOX_CLOCK_SKEW_ERROR,
  BOX_HEARTBEAT_STALE_ERROR,
  createBoxAgent,
  memoryCredentialStore,
  postgresBoxDriver,
  SqlBoxStore,
  type AgentFetch,
  type Booth,
  type BoxAgent,
  type BoxClockSkewDetails,
  type BoxHeartbeatStaleDetails,
  type CredentialStore,
  type PgPoolLike,
} from '@oto/box-agent';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { provisionVirtualBox } from '../src/services/box';

/**
 * SCRUM-402 — the audit's scenario (closing audit M17), end to end.
 *
 * A power cut, no clock battery, a network that blocks time sync but lets
 * HTTPS out: the Pi comes back with its clock hours behind. Before this, its
 * heartbeats were refused as skewed for good, the Console showed it offline
 * and never named the clock, spins were filed on the wrong trading day once
 * the lag crossed 05:00, slips printed a stale issue time with the expiry
 * counted from it, and every event was filed as trusted.
 *
 * Nothing here writes a heartbeat or an envelope by hand. The box's own agent
 * runs against the api in-process, as `booth-sync.test.ts` drives it, with
 * its raw clock set where the case needs it; only the socket (`app.inject`)
 * and the printer (the simulator every virtual box uses) stand in for
 * hardware. What is asserted is what the platform ends up holding — the box
 * row, Health, the ledger, the spin — and the slip as it is rendered for the
 * printer.
 *
 * Each case builds its own agent with its own boot identity. They are the
 * same box row, so a measurement one case leaves in the store is from
 * "another boot" to the next, which is exactly the rule under test.
 */

const HOUR = 3_600_000;

let ctx: TestContext;
let adminCookie: string;
let pool: PgPoolLike;
let timeZone: string;
let dayStartMinutes: number;

interface Exchange {
  path: string;
  /** What the box sent. */
  sent: unknown;
  status: number;
  /** What the api answered. */
  body: unknown;
}

/**
 * `app.inject` behind the agent's transport, keeping every exchange for the
 * assertions. `firstHeartbeat: 'no-answer'` loses the box's first heartbeat
 * before it reaches the api — the router has no line yet after the power cut
 * — and keeps it in `seen` with status 0.
 */
function injectTransport(seen: Exchange[], firstHeartbeat?: 'no-answer'): AgentFetch {
  let heartbeats = 0;
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/box/v1/heartbeat') heartbeats += 1;
    if (path === '/box/v1/heartbeat' && heartbeats === 1 && firstHeartbeat === 'no-answer') {
      const sent = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
      seen.push({ path, sent, status: 0, body: null });
      throw new Error('connect ETIMEDOUT: the router has no line yet');
    }
    const res = await ctx.app.inject({
      method: init.method as 'GET',
      url: path,
      headers: init.headers,
      payload: init.body,
    });
    const body = res.body ? (JSON.parse(res.body) as unknown) : null;
    const sent = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    seen.push({ path, sent, status: res.statusCode, body });
    return {
      status: res.statusCode,
      json: async () => body,
      text: async () => res.body,
      header: (name) => {
        const value = res.headers[name.toLowerCase()];
        return typeof value === 'string' ? value : null;
      },
    };
  };
}

interface Rig {
  agent: BoxAgent;
  booth: Booth;
  seen: Exchange[];
  heartbeats(): Exchange[];
  stop(): void;
}

/**
 * The virtual box's own agent, on the `edge` store, with its raw clock
 * `offsetMs` from ours. `credentials` shared between two rigs is one box
 * rebooting or restarting: the second keeps the first's secret, as a Pi
 * keeps its credential file, rather than claiming the box again.
 */
async function rig(opts: {
  offsetMs: () => number;
  bootId: string;
  firstHeartbeat?: 'no-answer';
  credentials?: CredentialStore;
}): Promise<Rig> {
  const seen: Exchange[] = [];
  const agent = createBoxAgent({
    apiBaseUrl: 'http://box-clock.test',
    credentials: opts.credentials ?? memoryCredentialStore(),
    hostname: 'box-clock-test',
    fetch: injectTransport(seen, opts.firstHeartbeat),
    claimCode: async () => (await provisionVirtualBox(ctx.db as Db, ctx.app.log))?.claimCode ?? null,
    store: new SqlBoxStore({ driver: postgresBoxDriver(pool) }),
    now: () => Date.now() + opts.offsetMs(),
    bootId: opts.bootId,
    booth: { randomIndex: (max) => randomInt(max) },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  await agent.syncCache();
  const booth = agent.booth();
  if (!booth) throw new Error('the agent built no booth module');
  await booth.start();
  if (!booth.config()) throw new Error('the booth adopted no wheel');
  return {
    agent,
    booth,
    seen,
    heartbeats: () => seen.filter((e) => e.path === '/box/v1/heartbeat'),
    stop() {
      booth.stop();
      agent.stop();
    },
  };
}

interface HealthBox {
  id: string;
  clockOffsetMs: number | null;
  conditions: string[];
}

async function healthOf(boxId: string): Promise<HealthBox> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/ops/health',
    headers: { cookie: adminCookie },
  });
  expect(res.statusCode).toBe(200);
  const found = (res.json().boxes as HealthBox[]).find((b) => b.id === boxId);
  expect(found, 'Health did not list the box').toBeTruthy();
  return found!;
}

/** The slip's lines of text as the renderer lays them out for the printer. */
async function slipText(boxId: string, pressed: SpinResponse): Promise<string[]> {
  const jobs = await ctx.db
    .select()
    .from(boxPrintJob)
    .where(eq(boxPrintJob.boxId, boxId))
    .orderBy(desc(boxPrintJob.queuedAt));
  const record = jobs.find(
    (j) => (j.job as { data?: { voucherCode?: string } }).data?.voucherCode === pressed.voucherCode,
  );
  expect(record, 'the press left no slip on the box').toBeTruthy();
  const rendered = renderJob(record!.job as RenderPrintJob, { device: PROFILES.escpos576! });
  expect(rendered.bytes.length).toBeGreaterThan(0);
  return rendered.layout.items
    .filter((item) => item.k === 'text')
    .map((item) => (item as { text: string }).text);
}

/** The booth's own `formatStamp`: the issue time as the slip prints it. */
function issuedWords(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(ms))
    .replace(',', '');
}

/** The date `days` after the calendar date of `ms` in the branch's zone, as the slip prints it. */
function expiryWords(ms: number, days: number): string {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
  const at = new Date(`${ymd}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' })
    .format(at)
    .replace(',', '');
}

/** The days a prize's voucher runs: its own, or its voucher type's. Null never expires. */
async function expiryDaysOf(prizeId: string): Promise<number | null> {
  const [prize] = await ctx.db.select().from(boothPrize).where(eq(boothPrize.id, prizeId)).limit(1);
  if (prize!.expiryDays !== null) return prize!.expiryDays;
  if (prize!.voucherDefinitionId === null) return null;
  const [definition] = await ctx.db
    .select()
    .from(voucherDefinition)
    .where(eq(voucherDefinition.id, prize!.voucherDefinitionId))
    .limit(1);
  return definition?.expiryDays ?? null;
}

/** The ledger's copy of a press: its spin fact, as the platform filed it. */
async function filedSpinFact(pressed: SpinResponse) {
  const rows = await ctx.db
    .select()
    .from(syncEvent)
    .where(eq(syncEvent.type, 'booth.spin_recorded'));
  const row = rows.find((r) => (r.payload as { spinId?: string }).spinId === pressed.spinId);
  expect(row, 'the press never reached the ledger').toBeTruthy();
  return row!;
}

function near(actualMs: number, expectedMs: number, what: string): void {
  expect(
    Math.abs(actualMs - expectedMs),
    `${what}: ${new Date(actualMs).toISOString()} against ${new Date(expectedMs).toISOString()}`,
  ).toBeLessThan(10_000);
}

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  pool = (ctx.db as unknown as { $client: PgPoolLike }).$client;
  const [park] = await ctx.db
    .select({ timezone: branch.timezone, dayStart: branch.businessDayStart })
    .from(branch)
    .where(eq(branch.code, 'hkt-central'))
    .limit(1);
  timeZone = park!.timezone;
  const [hours, minutes] = String(park!.dayStart).split(':').map(Number);
  dayStartMinutes = (hours ?? 5) * 60 + (minutes ?? 0);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('a Pi that came back twelve hours behind (closing audit M17)', () => {
  it('is refused once, measures, is accepted, and stamps and prints the platform’s time', async () => {
    const behind = -12 * HOUR;
    const box12 = await rig({ offsetMs: () => behind, bootId: 'boot-power-cut' });
    try {
      expect(box12.agent.state.clockOffsetMs, 'measured before the platform answered').toBeNull();

      // 1. Refused for its clock — and the refusal says what time it is.
      const before = Date.now();
      expect(await box12.agent.heartbeat()).toBeNull();
      const after = Date.now();
      const refused = box12.heartbeats().at(-1)!;
      expect(refused.status).toBe(400);
      const error = (refused.body as { error: { code: string; details: BoxClockSkewDetails } }).error;
      expect(error.code).toBe(BOX_CLOCK_SKEW_ERROR);
      expect(Date.parse(error.details.serverTime)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(error.details.serverTime)).toBeLessThanOrEqual(after);

      // 2. The box measured itself against it.
      const measured = box12.agent.state.clockOffsetMs;
      expect(measured).not.toBeNull();
      expect(Math.abs(measured! - behind)).toBeLessThan(5_000);

      // 3. The next heartbeat carries the platform's time and is accepted.
      expect(await box12.agent.heartbeat(), 'the corrected heartbeat was refused').toBeTruthy();
      const boxId = box12.agent.state.boxId!;
      const [row] = await ctx.db.select().from(box).where(eq(box.id, boxId)).limit(1);
      expect(row!.status).toBe('online');

      // 4. Health names the clock, with the box's own measurement.
      const seen = await healthOf(boxId);
      expect(Math.abs(seen.clockOffsetMs! - behind)).toBeLessThan(5_000);
      expect(seen.conditions, 'Health did not name the clock').toContain(`box.clock:${boxId}`);

      // 5. A press: trusted, on the platform's time, flagged for the machine's clock.
      const pressedAt = Date.now();
      const pressed = await box12.booth.spin({ idempotencyKey: newId() });
      const pressedBy = Date.now();
      expect(pressed.clockSuspect, 'twelve hours out and the spin was not flagged').toBe(true);

      const flushed = await box12.agent.outbox()!.flush();
      expect(flushed.state).toBe('pushed');
      const fact = await filedSpinFact(pressed);
      expect(fact.clockTrust).toBe('trusted');
      expect(fact.clockOffsetMs, 'the raw offset rode on an event already corrected').toBe(0);
      expect(fact.businessDateSource).toBe('occurred_at');
      near(fact.occurredAt.getTime(), pressedAt, 'occurredAt');

      const [filed] = await ctx.db.select().from(spin).where(eq(spin.id, pressed.spinId)).limit(1);
      expect(filed!.clockSuspect).toBe(true);
      // The trading day the platform's clock gives, not the one twelve hours back.
      expect([
        businessDate(new Date(pressedAt), timeZone, dayStartMinutes),
        businessDate(new Date(pressedBy), timeZone, dayStartMinutes),
      ]).toContain(filed!.businessDate);

      // 6. The slip: the corrected issue time, and the expiry counted from it.
      const lines = await slipText(boxId, pressed);
      const issued = [issuedWords(pressedAt), issuedWords(pressedBy)];
      expect(
        lines.some((line) => issued.includes(line)),
        `the slip says ${JSON.stringify(lines)}`,
      ).toBe(true);
      expect(lines, 'the slip printed the stale issue time').not.toContain(issuedWords(pressedAt + behind));
      const days = await expiryDaysOf(pressed.prizeId!);
      if (days === null) {
        expect(pressed.expiresAt).toBeNull();
      } else {
        expect(
          lines.includes(expiryWords(pressedAt, days)) || lines.includes(expiryWords(pressedBy, days)),
          `the slip's expiry is not counted from the corrected time: ${JSON.stringify(lines)}`,
        ).toBe(true);
      }
    } finally {
      box12.stop();
    }
  });
});

describe('the heartbeat’s own rules under a measured clock', () => {
  it('“Advance box clock” moves the raw clock; Health shows it after the next heartbeat, events stay trusted', async () => {
    const advanced = await rig({ offsetMs: () => 0, bootId: 'boot-advance' });
    try {
      expect(await advanced.agent.heartbeat()).toBeTruthy();
      const boxId = advanced.agent.state.boxId!;

      await advanced.agent.advanceClock(2 * HOUR);
      // Two hours is past the platform's fifteen minutes: refused, and measured by the refusal.
      expect(await advanced.agent.heartbeat()).toBeNull();
      expect(advanced.heartbeats().at(-1)!.status).toBe(400);
      // The next one is accepted, and Health carries the two hours.
      expect(await advanced.agent.heartbeat()).toBeTruthy();
      const seen = await healthOf(boxId);
      expect(Math.abs(seen.clockOffsetMs! - 2 * HOUR)).toBeLessThan(5_000);
      expect(seen.conditions).toContain(`box.clock:${boxId}`);

      const pressedAt = Date.now();
      const pressed = await advanced.booth.spin({ idempotencyKey: newId() });
      expect(pressed.clockSuspect).toBe(true);
      expect((await advanced.agent.outbox()!.flush()).state).toBe('pushed');
      const fact = await filedSpinFact(pressed);
      expect(fact.clockTrust).toBe('trusted');
      expect(fact.clockOffsetMs).toBe(0);
      expect(fact.businessDateSource).toBe('occurred_at');
      near(fact.occurredAt.getTime(), pressedAt, 'occurredAt');
    } finally {
      // Put the clock back: the skew is persisted on the box's row.
      await advanced.agent.advanceClock(-advanced.agent.state.clockSkewMs);
      advanced.stop();
    }
  });

  /**
   * The gate's case for the floor under `reportedAt` (SCRUM-402, round 1): a
   * Pi twelve hours AHEAD whose first heartbeat never reached the api — the
   * router had no line yet — had raised its floor to that future time, and
   * after the refusal that measured it went on sending the future time plus a
   * millisecond, refused and shown offline until real time caught up.
   */
  it('a box twelve hours AHEAD whose first heartbeat got no answer is online on the heartbeat after the refusal', async () => {
    const ahead = await rig({
      offsetMs: () => 12 * HOUR,
      bootId: 'boot-ahead-no-line',
      firstHeartbeat: 'no-answer',
    });
    try {
      await expect(ahead.agent.heartbeat()).rejects.toThrow();
      expect(await ahead.agent.heartbeat()).toBeNull();
      expect(ahead.agent.state.clockOffsetMs, 'the refusal measured nothing').not.toBeNull();
      expect(await ahead.agent.heartbeat(), 'the unanswered future reportedAt held the box out').toBeTruthy();
      expect(ahead.heartbeats().map((e) => e.status)).toEqual([0, 400, 200]);
      near(
        Date.parse((ahead.heartbeats().at(-1)!.sent as { reportedAt: string }).reportedAt),
        Date.now(),
        'the accepted report',
      );

      const boxId = ahead.agent.state.boxId!;
      const [row] = await ctx.db.select().from(box).where(eq(box.id, boxId)).limit(1);
      expect(row!.status).toBe('online');
      const seen = await healthOf(boxId);
      expect(Math.abs(seen.clockOffsetMs! - 12 * HOUR)).toBeLessThan(5_000);
      expect(seen.conditions).toContain(`box.clock:${boxId}`);
    } finally {
      ahead.stop();
    }
  });

  /**
   * A reboot after the correction (SCRUM-402, round 2): the gate's case.
   *
   * A Pi five minutes behind is accepted on its raw clock, measured, and from
   * then on reports the platform's time, which the api keeps as its
   * watermark. Rebooted — same credential, a new boot — it sets the
   * measurement aside and reports its raw clock again: five minutes behind,
   * inside the api's fifteen, and before the watermark. It used to be
   * refused as stale on every heartbeat until real time passed the
   * watermark, measuring nothing, and shown offline. The refusal now says
   * what time it is and where the watermark stands.
   */
  it('a corrected box five minutes behind that reboots is refused as stale at most once, then accepted and measured', async () => {
    const credentials = memoryCredentialStore();
    const behind = -5 * 60_000;
    const beforeReboot = await rig({ offsetMs: () => behind, bootId: 'boot-before-reboot', credentials });
    let boxId: string;
    try {
      /**
       * Measured, whichever way the first answer goes: accepted on the raw
       * clock when this case runs alone, or — after the cases above, which
       * left the row's watermark on the platform's time, ahead of a clock
       * five minutes behind — refused as stale once and measured off that.
       * Then corrected: the platform's time, and the watermark with it.
       */
      await beforeReboot.agent.heartbeat();
      expect(Math.abs((beforeReboot.agent.state.clockOffsetMs ?? 0) - behind)).toBeLessThan(5_000);
      expect(await beforeReboot.agent.heartbeat(), 'the corrected heartbeat was refused').toBeTruthy();
      expect([
        [200, 200],
        [409, 200],
      ]).toContainEqual(beforeReboot.heartbeats().map((e) => e.status));
      near(
        Date.parse((beforeReboot.heartbeats().at(-1)!.sent as { reportedAt: string }).reportedAt),
        Date.now(),
        'the corrected report before the reboot',
      );
      boxId = beforeReboot.agent.state.boxId!;
    } finally {
      beforeReboot.stop();
    }
    const [held] = await ctx.db.select().from(box).where(eq(box.id, boxId)).limit(1);
    const acceptedBefore = held!.lastHeartbeatAt!.getTime();

    const rebooted = await rig({ offsetMs: () => behind, bootId: 'boot-after-reboot', credentials });
    try {
      expect(rebooted.agent.state.clockOffsetMs, 'a measurement crossed the reboot').toBeNull();
      await rebooted.agent.heartbeat();
      await rebooted.agent.heartbeat();
      const statuses = rebooted.heartbeats().map((e) => e.status);
      expect(statuses.filter((status) => status === 409).length).toBeLessThanOrEqual(1);
      expect(statuses.at(-1)).toBe(200);
      // Here the first one is refused, or the case proves nothing.
      expect(statuses).toEqual([409, 200]);
      const refused = rebooted.heartbeats()[0]!;
      const error = (refused.body as { error: { code: string; details: BoxHeartbeatStaleDetails } }).error;
      expect(error.code).toBe(BOX_HEARTBEAT_STALE_ERROR);
      expect(Math.abs(Date.parse(error.details.serverTime) - Date.now())).toBeLessThan(10_000);
      const accepted = rebooted.heartbeats()[1]!;
      expect(Date.parse((accepted.sent as { reportedAt: string }).reportedAt)).toBeGreaterThan(
        Date.parse(error.details.lastAcceptedReportedAt),
      );

      // Measured off the refusal, online, and Health shows the Pi's own clock.
      const measured = rebooted.agent.state.clockOffsetMs;
      expect(measured, 'nothing was measured after the reboot').not.toBeNull();
      expect(Math.abs(measured! - behind)).toBeLessThan(5_000);
      const [row] = await ctx.db.select().from(box).where(eq(box.id, boxId)).limit(1);
      expect(row!.status).toBe('online');
      expect(row!.lastHeartbeatAt!.getTime()).toBeGreaterThan(acceptedBefore);
      const seen = await healthOf(boxId);
      expect(Math.abs(seen.clockOffsetMs! - behind)).toBeLessThan(5_000);
    } finally {
      rebooted.stop();
    }
  });

  /**
   * Last of the agent cases, on purpose: it leaves the api's watermark a few
   * seconds ahead of real time. A NEW process — whose floor starts at nothing
   * — would be refused as stale once, and report after the watermark the
   * refusal names; the cases above count every status from their first
   * heartbeat, so none of them follows this one.
   */
  it('keeps reportedAt rising when a re-measurement moves the clock back a few seconds', async () => {
    let shift = 0;
    const stepping = await rig({ offsetMs: () => shift, bootId: 'boot-step' });
    try {
      const reported = (e: Exchange): number => Date.parse((e.sent as { reportedAt: string }).reportedAt);
      expect(await stepping.agent.heartbeat()).toBeTruthy();
      // The machine's clock steps five seconds forward: reported, then measured.
      shift = 5_000;
      expect(await stepping.agent.heartbeat()).toBeTruthy();
      const high = reported(stepping.heartbeats().at(-1)!);
      near(high, Date.now() + 5_000, 'the report after the step');
      // Corrected, the clock now reads about five seconds EARLIER than that
      // report. The next one must still be after it, or the api refuses it as
      // a replay.
      expect(await stepping.agent.heartbeat(), 'a re-measurement made the box repeat itself').toBeTruthy();
      expect(reported(stepping.heartbeats().at(-1)!)).toBeGreaterThan(high);
      expect(
        stepping.heartbeats().map((e) => e.status),
        'a heartbeat was refused — as stale, or for its clock',
      ).toEqual([200, 200, 200]);
    } finally {
      stepping.stop();
    }
  });
});

describe('the Console’s clock line (SCRUM-402)', () => {
  /**
   * The helper the box drawer renders its clock line from. The Console has no
   * unit runner of its own, so it is loaded here; by a path worked out at run
   * time, because `api/fleet.ts` reaches the browser's `window` through its
   * client, and the api's type check has no DOM to check that against.
   */
  interface ConsoleClock {
    clockLine(vitals: { clockOffsetMs: number | null; clockMeasuredAgeSeconds: number | null }): {
      words: string;
      warn: boolean;
    };
    clockOffsetWords(offsetMs: number): string;
  }
  let consoleClock: ConsoleClock;
  beforeAll(async () => {
    const path = fileURLToPath(new URL('../../console/src/api/fleet.ts', import.meta.url));
    consoleClock = (await import(/* @vite-ignore */ path)) as ConsoleClock;
  });

  it('says the three states in words', () => {
    expect(consoleClock.clockLine({ clockOffsetMs: null, clockMeasuredAgeSeconds: null })).toEqual({
      words: 'Clock not measured yet',
      warn: false,
    });
    expect(consoleClock.clockLine({ clockOffsetMs: 350, clockMeasuredAgeSeconds: 40 })).toEqual({
      words: 'Clock in step with the platform',
      warn: false,
    });
    expect(
      consoleClock.clockLine({ clockOffsetMs: -12 * HOUR + 1_234, clockMeasuredAgeSeconds: 180 }),
    ).toEqual({ words: 'Clock 12 h behind the platform (measured 3 min ago)', warn: true });
  });

  it('warns only past ten minutes, and says ahead as readily as behind', () => {
    expect(consoleClock.clockLine({ clockOffsetMs: 3 * 60_000, clockMeasuredAgeSeconds: 5 })).toEqual({
      words: 'Clock 3 min ahead of the platform (measured just now)',
      warn: false,
    });
    expect(consoleClock.clockLine({ clockOffsetMs: 11 * 60_000, clockMeasuredAgeSeconds: null }).warn).toBe(
      true,
    );
    expect(consoleClock.clockOffsetWords(-12 * HOUR)).toBe('12 h behind');
    expect(consoleClock.clockOffsetWords(30_000)).toBe('in step');
    expect(consoleClock.clockOffsetWords(-90 * 24 * HOUR)).toBe('90 days behind');
  });
});
