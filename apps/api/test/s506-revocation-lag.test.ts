import { and, eq, isNull, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, alert, benefitCredential, box, branch, employee } from '@oto/db';
import { newId } from '@oto/shared';
import { CACHE_REFRESH_INTERVAL_MS } from '@oto/box-agent';
import { runWatchdog } from '../src/services/jobs';
import {
  evaluateBox,
  fleetHealth,
  revocationStaleAfterS,
  type AlertChannel,
  type BoxRevocationState,
  type BoxRuleSettings,
  type FleetCondition,
} from '../src/services/ops';
import {
  ADMIN,
  OTO_OPERATOR_NAME,
  boxBySlot,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-506 — the benefits plan's hazard H7, its alert half.
 *
 * The cloud refuses a revoked staff benefit card at once; a counter box
 * refuses it only once its next cache pull has brought the new revocation
 * list. This is the operations expectation over that window: a box that has
 * not confirmed taking a revocation within its refresh period is raised on
 * Health and by the watchdog, from what the box itself reports in its
 * heartbeat (`cache.checkedAt`, when the cloud last confirmed its copy
 * current), and the alert closes on the first heartbeat that confirms it.
 *
 * The pure rule first, on every case that decides it; then the watchdog and
 * the Health page on a real revoked card.
 */

const MIN = 60_000;
const NOW = Date.parse('2026-11-02T06:00:00.000Z');
const ALWAYS_OPEN = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [day, { open: '00:00', close: '00:00' }]),
);

const settings: BoxRuleSettings = {
  offlineAfterS: 180,
  minAgentVersion: '0.1.0',
  syncStaleAfterS: 300,
  revocationStaleAfterS: revocationStaleAfterS(180),
};

type Row = Parameters<typeof evaluateBox>[0];

/** A counter box that is calling home, whose last heartbeat says its copy was confirmed at `checkedAt`. */
function counterBox(over: { checkedAt?: string | null; heartbeatAgoMs?: number; errors?: unknown[]; status?: string; openingHours?: unknown } = {}): Row {
  const lastStatus: Record<string, unknown> = {
    reportedAt: new Date(NOW).toISOString(),
    agentVersion: '0.1.0',
    errors: over.errors ?? [],
  };
  if (over.checkedAt !== null) {
    lastStatus.cache = { appliedAt: over.checkedAt ?? new Date(NOW).toISOString(), checkedAt: over.checkedAt ?? new Date(NOW).toISOString(), scopes: 14 };
  }
  return {
    id: '018f0000-0000-7000-8000-00000000b0c1',
    operatorId: 'op-1',
    branchId: 'branch-1',
    name: 'Till box',
    slot: 'pi-1',
    role: 'counter',
    status: over.status ?? 'online',
    agentVersion: '0.1.0',
    registeredAt: new Date(NOW - 86_400_000),
    currentEpoch: 1,
    lastHeartbeatAt: new Date(NOW - (over.heartbeatAgoMs ?? 20_000)),
    lastStatus,
    branchName: 'Central Floresta',
    timezone: 'Asia/Bangkok',
    businessDayStart: '05:00:00',
    openingHours: over.openingHours === undefined ? ALWAYS_OPEN : over.openingHours,
  };
}

const ago = (ms: number) => new Date(NOW - ms);
const iso = (ms: number) => ago(ms).toISOString();
const revoked = (...msAgo: number[]): BoxRevocationState => ({ servesBenefits: true, revokedAt: msAgo.map(ago) });

function ruleOf(row: Row, revocations: BoxRevocationState | undefined): FleetCondition | undefined {
  return evaluateBox(row, [], settings, NOW, undefined, [], revocations).conditions.find(
    (c) => c.category === 'box.revocations_behind',
  );
}

describe('SCRUM-506 — the revocation window, as the rule decides it', () => {
  it('the window is two cache refreshes and the heartbeat’s silence window: five minutes at the defaults', () => {
    expect(CACHE_REFRESH_INTERVAL_MS).toBe(60_000);
    expect(revocationStaleAfterS(180)).toBe(300);
  });

  it('stale: a card revoked ten minutes ago, a box whose copy was last confirmed twenty minutes ago — raised, naming the wait', () => {
    const rule = ruleOf(counterBox({ checkedAt: iso(20 * MIN) }), revoked(10 * MIN));
    expect(rule).toMatchObject({
      key: 'box.revocations_behind:018f0000-0000-7000-8000-00000000b0c1',
      severity: 'warning',
      active: true,
      operatorId: 'op-1',
      branchId: 'branch-1',
    });
    expect(rule!.summary).toBe(
      'Till box (pi-1) has not confirmed taking the staff benefit card revocation made 10 minutes ago — until it does, its counter would still accept that card while working offline',
    );
    expect(rule!.detail).toMatchObject({ unconfirmed: 1, oldestRevokedAt: iso(10 * MIN), confirmedAt: iso(20 * MIN), staleAfterSeconds: 300 });
  });

  it('fresh: the same card, a box that confirmed its copy a minute ago — not raised, and the clear says it has taken it', () => {
    const rule = ruleOf(counterBox({ checkedAt: iso(1 * MIN) }), revoked(10 * MIN));
    expect(rule!.active).toBe(false);
    expect(rule!.clear).toEqual({
      category: 'box.revocations_behind',
      reason: 'recovered',
      summary: 'Till box (pi-1) has taken every staff benefit card revocation',
    });
  });

  it('inside the window: revoked two minutes ago and not yet confirmed — not raised yet', () => {
    expect(ruleOf(counterBox({ checkedAt: iso(5 * MIN) }), revoked(2 * MIN))!.active).toBe(false);
    // …and raised once the window has passed with nothing confirmed.
    expect(ruleOf(counterBox({ checkedAt: iso(5 * MIN) }), revoked(5 * MIN + 1_000))!.active).toBe(true);
  });

  it('a confirmation inside one refresh of the revocation does not count: it may have been asked before it', () => {
    const rule = ruleOf(counterBox({ checkedAt: iso(10 * MIN - 30_000) }), revoked(10 * MIN));
    expect(rule!.active).toBe(true);
    expect(ruleOf(counterBox({ checkedAt: iso(10 * MIN - CACHE_REFRESH_INTERVAL_MS) }), revoked(10 * MIN))!.active).toBe(false);
  });

  it('several revocations: the oldest the box has not confirmed is the one measured, and the count says how many', () => {
    const rule = ruleOf(counterBox({ checkedAt: iso(30 * MIN) }), revoked(60 * MIN, 20 * MIN, 8 * MIN));
    expect(rule!.active).toBe(true);
    expect(rule!.summary).toContain('has not confirmed taking 2 staff benefit card revocations, the first made 20 minutes ago');
    expect(rule!.detail).toMatchObject({ unconfirmed: 2, oldestRevokedAt: iso(20 * MIN) });
    // Confirmed past the old ones, and the newest still inside its window: closed, and said as such.
    const caught = ruleOf(counterBox({ checkedAt: iso(1 * MIN) }), revoked(60 * MIN, 20 * MIN, 30_000));
    expect(caught!.active).toBe(false);
    expect(caught!.clear.summary).toBe(
      'Till box (pi-1) has taken the revocations it was behind on; the one it has not confirmed yet is inside its 5 minutes window',
    );
  });

  it('a benefits scope its last pull could not apply leaves every revocation unconfirmed, however fresh the check', () => {
    const rule = ruleOf(
      counterBox({ checkedAt: iso(0), errors: [{ fingerprint: 'truncated:benefits', code: 'box.cache_truncated', count: 2 }] }),
      revoked(10 * MIN),
    );
    expect(rule!.active).toBe(true);
    expect(rule!.detail).toMatchObject({ benefitsFault: 'box.cache_truncated' });
  });

  it('nothing revoked: not raised', () => {
    expect(ruleOf(counterBox({ checkedAt: iso(20 * MIN) }), revoked())!.active).toBe(false);
  });

  it('a box that runs only booths is not sent the cards, and is never raised', () => {
    const rule = ruleOf(counterBox({ checkedAt: iso(20 * MIN) }), { servesBenefits: false, revokedAt: [ago(10 * MIN)] });
    expect(rule!.active).toBe(false);
    expect(rule!.clear.reason).toBe('runs only booths');
  });

  it('a silent box is raised while the park is open and not while it is shut, as box.offline is', () => {
    const silent = { checkedAt: iso(20 * MIN), heartbeatAgoMs: 30 * MIN };
    expect(ruleOf(counterBox(silent), revoked(10 * MIN))!.active).toBe(true);
    const shut = ruleOf(counterBox({ ...silent, openingHours: {} }), revoked(10 * MIN));
    expect(shut!.active).toBe(false);
    expect(shut!.clear.reason).toBe('Central Floresta is closed');
    expect(ruleOf(counterBox({ ...silent, openingHours: null }), revoked(10 * MIN))!.active).toBe(false);
  });

  it('a box taken out of service is not raised', () => {
    const rule = ruleOf(counterBox({ checkedAt: iso(20 * MIN), status: 'disabled' }), revoked(10 * MIN));
    expect(rule!.active).toBe(false);
    expect(rule!.clear.reason).toBe('taken out of service');
  });

  it('not evaluated where the revocations could not be read, or where the box has reported no cache block', () => {
    expect(ruleOf(counterBox({ checkedAt: iso(20 * MIN) }), undefined)).toBeUndefined();
    expect(ruleOf(counterBox({ checkedAt: null }), revoked(10 * MIN))).toBeUndefined();
  });

  it('raised, it is the worst thing about the box: the tile says it', () => {
    const { health } = evaluateBox(counterBox({ checkedAt: iso(20 * MIN) }), [], settings, NOW, undefined, [], revoked(10 * MIN));
    expect(health.state).toBe('warn');
    expect(health.conditions).toEqual(['box.revocations_behind:018f0000-0000-7000-8000-00000000b0c1']);
    expect(health.detail).toContain('has not confirmed taking the staff benefit card revocation');
  });
});

// --- The watchdog and Health, on a real revoked card ------------------------------------------

let ctx: TestContext;
let adminCookie: string;

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
}, 240_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('SCRUM-506 — the watchdog raises a box that has not taken a revocation, and closes it when the box does', () => {
  const channels: AlertChannel[] = [{ name: 'console', deliver: async () => ({ target: 'test' }) }];
  const watchdog = () => runWatchdog({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, channels });
  const theBox = () => boxBySlot(ctx.db, 'virtual-1');
  const alertsOf = (key: string) => ctx.db.select().from(alert).where(eq(alert.key, key));

  /** The box calling home now, its copy last confirmed at `checkedAt`. */
  const callingHome = async (checkedAt: Date) =>
    ctx.db
      .update(box)
      .set({
        status: 'online',
        registeredAt: new Date(Date.now() - 86_400_000),
        lastHeartbeatAt: new Date(),
        agentVersion: '0.1.0',
        lastStatus: {
          reportedAt: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
          clockOffsetMs: 0,
          agentVersion: '0.1.0',
          outboxDepth: 0,
          errors: [],
          cache: { appliedAt: checkedAt.toISOString(), checkedAt: checkedAt.toISOString(), scopes: 14 },
        } as never,
      })
      .where(eq(box.id, (await theBox()).id));

  beforeEach(async () => {
    await ctx.db.delete(alert).where(like(alert.key, 'box.%'));
    await ctx.db.update(branch).set({ openingHours: ALWAYS_OPEN as never });
  });

  it('a card revoked ten minutes ago and a box last confirmed before it: raised on Health and by the watchdog; confirmed, it closes', async () => {
    const operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
    const [admin] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, ADMIN.phone)).limit(1);
    const [person] = await ctx.db
      .select({ id: employee.id })
      .from(employee)
      .where(and(eq(employee.operatorId, operatorId), isNull(employee.archivedAt)))
      .limit(1);
    const revokedAt = new Date(Date.now() - 10 * MIN);
    await ctx.db.insert(benefitCredential).values({
      id: newId(),
      operatorId,
      employeeId: person!.id,
      kid: 's506-test',
      codeHash: `s506-${newId()}`,
      issuedByAccountId: admin!.id,
      issuedAt: new Date(Date.now() - 60 * MIN),
      expiresAt: new Date(Date.now() + 365 * 86_400_000),
      revokedAt,
      revokedByAccountId: admin!.id,
    });

    // Stale: last confirmed twenty minutes ago, before the revocation.
    await callingHome(new Date(Date.now() - 20 * MIN));
    const id = (await theBox()).id;
    const key = `box.revocations_behind:${id}`;

    const fleet = await fleetHealth({ db: ctx.db });
    const tile = fleet.boxes.find((b) => b.id === id)!;
    expect(tile.conditions).toContain(key);
    expect(fleet.conditions.find((c) => c.key === key)).toMatchObject({ active: true, severity: 'warning' });

    await watchdog();
    const [raised] = await alertsOf(key);
    expect(raised).toMatchObject({ status: 'open', category: 'box.revocations_behind', severity: 'warning', operatorId });
    expect(raised!.summary).toContain('has not confirmed taking');
    expect(raised!.summary).toContain('its counter would still accept that card while working offline');
    expect(raised!.detail).toMatchObject({ oldestRevokedAt: revokedAt.toISOString() });

    // Health shows it where the other conditions show: in the alerts and on the box.
    const health = await ctx.app.inject({ method: 'GET', url: '/ops/health', headers: { cookie: adminCookie } });
    expect(health.statusCode).toBe(200);
    const page = health.json<{ alerts: Array<{ key: string }>; boxes: Array<{ id: string; conditions: string[] }> }>();
    expect(page.alerts.map((a) => a.key)).toContain(key);
    expect(page.boxes.find((b) => b.id === id)!.conditions).toContain(key);

    // Fresh: the box's next heartbeat says its copy was confirmed just now.
    await callingHome(new Date());
    await watchdog();
    const [closed] = await alertsOf(key);
    expect(closed).toMatchObject({ status: 'resolved', resolvedReason: 'recovered' });
    expect((await fleetHealth({ db: ctx.db })).boxes.find((b) => b.id === id)!.conditions).not.toContain(key);
  });
});
