import { randomBytes } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alert, branch, deviceCredential, station } from '@oto/db';
import { runWatchdog } from '../src/services/jobs';
import type { AlertChannel, AlertMessage } from '../src/services/ops';
import {
  displayPresence,
  evaluateDisplay,
  screenOfflineAfterS,
  screenPresence,
  type DisplayPresenceRow,
} from '../src/services/screen-presence';
import {
  ADMIN,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-771 — a customer display's Offline and its alert.
 *
 * The display rule is the box's offline rule pointed at a screen: the same
 * threshold (`BOX_OFFLINE_AFTER_S`), the same watchdog `open` / `close`, the
 * same opening-hours judgement.
 */

const NOW = Date.parse('2026-11-09T05:00:00.000Z');
const THRESHOLD = 180;

/** Midnight to midnight, every day: open whenever the suite runs. */
const ALWAYS_OPEN = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [day, { open: '00:00', close: '00:00' }]),
);
/** Hours that have been answered, with no day open. */
const ALWAYS_SHUT = {};

describe('SCRUM-771 — presence, read the same way for every screen', () => {
  it('is online up to the boxes’ threshold, offline past it, and offline when never heard from', () => {
    expect(screenPresence(null, NOW, THRESHOLD)).toEqual({
      state: 'offline', lastSeenAt: null, lastSeenAgeSeconds: null, offlineAfterSeconds: THRESHOLD,
    });
    expect(screenPresence(new Date(NOW), NOW, THRESHOLD).state).toBe('online');
    expect(screenPresence(new Date(NOW - THRESHOLD * 1000), NOW, THRESHOLD).state).toBe('online');
    const quiet = screenPresence(new Date(NOW - (THRESHOLD + 1) * 1000), NOW, THRESHOLD);
    expect(quiet.state).toBe('offline');
    expect(quiet.lastSeenAgeSeconds).toBe(THRESHOLD + 1);
  });

  it('answers a display only once it is paired and while it is not revoked', () => {
    const seen = new Date(NOW - 5_000);
    const paired = { kind: 'display', pairedAt: new Date(NOW - 60_000), revokedAt: null, lastSeenAt: seen };
    expect(displayPresence(paired, NOW, THRESHOLD)?.state).toBe('online');
    expect(displayPresence({ ...paired, pairedAt: null }, NOW, THRESHOLD)).toBeNull();
    expect(displayPresence({ ...paired, revokedAt: new Date(NOW) }, NOW, THRESHOLD)).toBeNull();
    expect(displayPresence({ ...paired, kind: 'booth' }, NOW, THRESHOLD)).toBeNull();
  });

  describe('the display rule', () => {
    const row = (patch: Partial<DisplayPresenceRow> = {}): DisplayPresenceRow => ({
      credentialId: '01965b00-0000-7000-8000-000000000771',
      label: 'ZZ TEST 771 screen',
      operatorId: '01965b00-0000-7000-8000-000000000001',
      branchId: '01965b00-0000-7000-8000-000000000002',
      branchName: 'ZZ TEST park',
      timezone: 'Asia/Bangkok',
      openingHours: ALWAYS_OPEN,
      stationId: '01965b00-0000-7000-8000-000000000003',
      stationName: 'ZZ TEST till',
      lastSeenAt: new Date(NOW - 1_800_000),
      ...patch,
    });

    it('raises a quiet display while the park is open, naming the display, its till and its park', () => {
      const c = evaluateDisplay(row(), THRESHOLD, NOW);
      expect(c).toMatchObject({
        key: 'display.offline:01965b00-0000-7000-8000-000000000771',
        category: 'display.offline',
        severity: 'warning',
        active: true,
        operatorId: '01965b00-0000-7000-8000-000000000001',
        branchId: '01965b00-0000-7000-8000-000000000002',
      });
      expect(c.subject).toBe('ZZ TEST 771 screen (customer display at ZZ TEST till)');
      expect(c.summary).toContain('ZZ TEST park');
      expect(c.summary).toContain('30 minutes');
      expect(c.detail).toMatchObject({ quietSeconds: 1_800, offlineAfterSeconds: THRESHOLD, station: 'ZZ TEST till' });
    });

    it('says a display that never called since pairing is quiet', () => {
      const c = evaluateDisplay(row({ lastSeenAt: null }), THRESHOLD, NOW);
      expect(c.active).toBe(true);
      expect(c.summary).toContain('has not called since it was paired');
    });

    it('raises nothing with the park shut or its hours unset, and says which when it clears', () => {
      const shut = evaluateDisplay(row({ openingHours: ALWAYS_SHUT }), THRESHOLD, NOW);
      expect(shut.active).toBe(false);
      expect(shut.clear).toMatchObject({ category: 'display.offline', reason: 'ZZ TEST park is closed' });
      const unset = evaluateDisplay(row({ openingHours: null }), THRESHOLD, NOW);
      expect(unset.active).toBe(false);
      expect(unset.clear).toMatchObject({ category: 'display.offline', reason: 'opening hours are not set' });
    });

    it('clears as display.online once the display is calling again', () => {
      const c = evaluateDisplay(row({ lastSeenAt: new Date(NOW - 2_000) }), THRESHOLD, NOW);
      expect(c.active).toBe(false);
      expect(c.clear).toMatchObject({ category: 'display.online', reason: 'recovered' });
      expect(c.clear.summary).toContain('is calling again');
    });
  });
});

describe('SCRUM-771 — displays against the api and the watchdog', () => {
  let ctx: TestContext;
  let adminCookie: string;
  let tillId: string;
  let branchId: string;
  let branchName: string;
  let displayId: string;
  let authorization: string;
  let delivered: AlertMessage[];
  let channels: AlertChannel[];
  const DISPLAY_NAME = 'ZZ TEST 771 display';

  const watchdog = () => runWatchdog({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, channels });
  const alertsOf = (key: string) => ctx.db.select().from(alert).where(eq(alert.key, key));
  const setHours = (openingHours: unknown) => ctx.db.update(branch).set({ openingHours: openingHours as never });
  const displayQuietFor = (seconds: number) =>
    ctx.db.update(deviceCredential).set({ lastSeenAt: new Date(Date.now() - seconds * 1000) })
      .where(eq(deviceCredential.id, displayId));
  const displayPolls = async () => {
    const reply = await ctx.app.inject({ method: 'GET', url: `/box/v1/station/${tillId}/display/session`, headers: { authorization } });
    expect(reply.statusCode).toBe(200);
  };
  const credentialRead = async (includeRevoked = false) => {
    const res = await ctx.app.inject({
      method: 'GET', url: `/branches/${branchId}/credentials${includeRevoked ? '?includeRevoked=true' : ''}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().credentials as Array<{ id: string; presence: Record<string, unknown> | null }>)
      .find((c) => c.id === displayId)!;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const [till] = await ctx.db.select().from(station).where(eq(station.name, 'Reception Till 1'));
    tillId = till!.id;
    branchId = till!.branchId;
    branchName = (await ctx.db.select().from(branch).where(eq(branch.id, branchId)))[0]!.name;
    authorization = `Bearer ${randomBytes(32).toString('hex')}`;
    const mint = await ctx.app.inject({ method: 'POST', url: '/display/pairing', headers: { authorization }, payload: {} });
    expect(mint.statusCode).toBe(200);
    const paired = await ctx.app.inject({
      method: 'POST', url: `/stations/${tillId}/displays/claim`, headers: { cookie: adminCookie },
      payload: { pairingCode: mint.json().pairingCode, name: DISPLAY_NAME },
    });
    expect(paired.statusCode).toBe(200);
    displayId = paired.json().device.id;
  });

  afterAll(async () => {
    await ctx.close();
    await teardownAll();
  });

  beforeEach(async () => {
    delivered = [];
    channels = [{ name: 'console', async deliver(message) { delivered.push(message); return { target: 'test' }; } }];
    // Deleted rather than resolved: a resolved row inside the flap window would
    // be reopened silently, and a case expecting a delivery would then be
    // asserting the flap rule instead of its own.
    await ctx.db.delete(alert).where(like(alert.key, 'display.%'));
    await setHours(ALWAYS_OPEN);
    await displayPolls();
  });

  it('reads a calling display as online, and one quiet past the boxes’ threshold as offline', async () => {
    expect((await credentialRead()).presence).toMatchObject({
      state: 'online', offlineAfterSeconds: screenOfflineAfterS(),
    });
    await displayQuietFor(screenOfflineAfterS() + 60);
    const quiet = await credentialRead();
    expect(quiet.presence).toMatchObject({ state: 'offline' });
    expect(quiet.presence!.lastSeenAgeSeconds as number).toBeGreaterThan(screenOfflineAfterS());
  });

  it('raises display.offline once while the park is open, with the display’s name and park, and clears it when the display calls again', async () => {
    await displayQuietFor(1_800);
    const key = `display.offline:${displayId}`;

    const summary = await watchdog();
    expect(summary).toMatchObject({ displaysEvaluated: true });
    expect(summary.displays).toBeGreaterThanOrEqual(1);
    const [raised] = await alertsOf(key);
    expect(raised).toMatchObject({ status: 'open', category: 'display.offline', severity: 'warning', branchId });
    expect(raised!.operatorId).not.toBeNull();
    expect(raised!.subject).toBe(`${DISPLAY_NAME} (customer display at Reception Till 1)`);
    expect(raised!.summary).toContain(branchName);
    expect(delivered.filter((d) => d.key === key && d.event === 'opened')).toHaveLength(1);

    // Still quiet a minute later is the same condition, not a second alert.
    await watchdog();
    expect(await alertsOf(key)).toHaveLength(1);
    expect(delivered.filter((d) => d.key === key)).toHaveLength(1);

    // What the display's own next call does to the credential row.
    await displayPolls();
    await watchdog();
    const [cleared] = await alertsOf(key);
    expect(cleared).toMatchObject({ status: 'resolved', resolvedReason: 'recovered' });
    const closing = delivered.filter((d) => d.key === key && d.event === 'resolved');
    expect(closing).toHaveLength(1);
    expect(closing[0]!.category).toBe('display.online');
    expect(closing[0]!.summary).toContain('is calling again');
  });

  it('shows the same silence with the park shut as offline and raises nothing', async () => {
    await setHours(ALWAYS_SHUT);
    await displayQuietFor(1_800);
    await watchdog();
    expect(await alertsOf(`display.offline:${displayId}`)).toHaveLength(0);
    expect(delivered.filter((d) => d.key.startsWith('display.'))).toHaveLength(0);
    expect((await credentialRead()).presence).toMatchObject({ state: 'offline' });
  });

  // Last: it revokes the one display this file pairs.
  it('closes the alert of a display revoked while it stood, as no longer paired', async () => {
    await displayQuietFor(1_800);
    const key = `display.offline:${displayId}`;
    await watchdog();
    expect((await alertsOf(key))[0]!.status).toBe('open');

    const revoked = await ctx.app.inject({
      method: 'POST', url: `/credentials/${displayId}/revoke`, headers: { cookie: adminCookie },
      payload: { reason: 'ZZ TEST 771 revoked' },
    });
    expect(revoked.statusCode).toBe(200);
    await watchdog();
    const [closed] = await alertsOf(key);
    expect(closed).toMatchObject({ status: 'resolved', resolvedReason: 'no longer paired' });
    expect((await credentialRead(true)).presence).toBeNull();
  });
});
