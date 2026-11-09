import { randomBytes } from 'node:crypto';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alert, auditLog, box, branch, deviceCredential, station } from '@oto/db';
import { newId } from '@oto/shared';
import { runWatchdog } from '../src/services/jobs';
import type { AlertChannel, AlertMessage } from '../src/services/ops';
import {
  displayPresence,
  evaluateDisplay,
  screenOfflineAfterS,
  screenPresence,
  tillScreen,
  type DisplayPresenceRow,
} from '../src/services/screen-presence';
import {
  ADMIN,
  RECEPTION,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-771 — a customer display's Offline and its alert, and the presence of a
 * till's own screen (the iPad) with its scanner's last use.
 *
 * The display rule is the box's offline rule pointed at a screen: the same
 * threshold (`BOX_OFFLINE_AFTER_S`), the same watchdog `open` / `close`, the
 * same opening-hours judgement. The till's screen is shown and never raised,
 * because the box rules raise nothing about a till station either.
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

  const VIRTUAL_BOX = { id: '01965b00-0000-7000-8000-0000000007b1', name: 'ZZ TEST virtual box', role: 'virtual' };
  const PI_BOX = { id: '01965b00-0000-7000-8000-0000000007b2', name: 'ZZ TEST counter box', role: 'counter' };

  it('answers a display only once it is paired and while it is not revoked', () => {
    const seen = new Date(NOW - 5_000);
    const paired = { kind: 'display', pairedAt: new Date(NOW - 60_000), revokedAt: null, lastSeenAt: seen };
    expect(displayPresence(paired, NOW, THRESHOLD, VIRTUAL_BOX)?.state).toBe('online');
    expect(displayPresence({ ...paired, pairedAt: null }, NOW, THRESHOLD, VIRTUAL_BOX)).toBeNull();
    expect(displayPresence({ ...paired, revokedAt: new Date(NOW) }, NOW, THRESHOLD, VIRTUAL_BOX)).toBeNull();
    expect(displayPresence({ ...paired, kind: 'booth' }, NOW, THRESHOLD, VIRTUAL_BOX)).toBeNull();
  });

  it('reads a display on a virtual box offline once quiet, and one on a Pi box as reading through it, never offline', () => {
    const quiet = { kind: 'display', pairedAt: new Date(NOW - 86_400_000), revokedAt: null, lastSeenAt: new Date(NOW - 86_400_000) };
    expect(displayPresence(quiet, NOW, THRESHOLD, VIRTUAL_BOX)).toMatchObject({ state: 'offline', box: null });
    expect(displayPresence(quiet, NOW, THRESHOLD, PI_BOX)).toMatchObject({
      state: 'via_box', box: { id: PI_BOX.id, name: PI_BOX.name }, lastSeenAgeSeconds: 86_400,
    });
    expect(displayPresence({ ...quiet, lastSeenAt: null }, NOW, THRESHOLD, PI_BOX)?.state).toBe('via_box');
    // A station on no box cannot hold a session for a display to show: not judged either.
    expect(displayPresence(quiet, NOW, THRESHOLD, null)).toMatchObject({ state: 'via_box', box: null });
    // Heard by the platform lately (its page served from the platform), it is online wherever it stands.
    expect(displayPresence({ ...quiet, lastSeenAt: new Date(NOW - 5_000) }, NOW, THRESHOLD, PI_BOX)).toMatchObject({
      state: 'online', box: { id: PI_BOX.id, name: PI_BOX.name },
    });
  });

  it('answers a till’s screen with its scanner’s last use, and nothing for any other kind', () => {
    const screen = tillScreen(
      { kind: 'till', lastSeenAt: new Date(NOW - 30_000), lastScanAt: new Date(NOW - 125_000) },
      NOW,
      THRESHOLD,
    );
    expect(screen).toMatchObject({
      state: 'online',
      lastSeenAgeSeconds: 30,
      scannerLastUsedAt: new Date(NOW - 125_000).toISOString(),
      scannerLastUsedAgeSeconds: 125,
    });
    expect(tillScreen({ kind: 'till', lastSeenAt: null, lastScanAt: null }, NOW, THRESHOLD)).toMatchObject({
      state: 'offline', scannerLastUsedAt: null, scannerLastUsedAgeSeconds: null,
    });
    for (const kind of ['booth', 'kiosk', 'gate', 'display']) {
      expect(tillScreen({ kind, lastSeenAt: new Date(NOW), lastScanAt: null }, NOW, THRESHOLD)).toBeNull();
    }
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

describe('SCRUM-771 — displays and till screens against the api and the watchdog', () => {
  let ctx: TestContext;
  let adminCookie: string;
  let receptionCookie: string;
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
  const stationRead = async (id = tillId) => {
    const res = await ctx.app.inject({ method: 'GET', url: `/stations/${id}`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    return res.json().station as { kind: string; lastSeenAt: string | null; screen: Record<string, unknown> | null };
  };
  const heartbeat = (cookie: string, payload: Record<string, unknown> = {}) =>
    ctx.app.inject({ method: 'POST', url: '/me/station/heartbeat', headers: { cookie }, payload });

  beforeAll(async () => {
    ctx = await createTestContext();
    adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const [till] = await ctx.db.select().from(station).where(eq(station.name, 'Reception Till 1'));
    tillId = till!.id;
    branchId = till!.branchId;
    branchName = (await ctx.db.select().from(branch).where(eq(branch.id, branchId)))[0]!.name;
    await takeStation(ctx.app, receptionCookie, tillId);
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

  it('stamps the till’s screen on its heartbeat, and the station read shows it online with its scanner’s last use', async () => {
    const before = (await ctx.db.select().from(station).where(eq(station.id, tillId)))[0]!;
    const res = await heartbeat(receptionCookie, { lastScanSecondsAgo: 30 });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { stationId: string; lastSeenAt: string; scannerLastUsedAt: string | null };
    expect(body.stationId).toBe(tillId);
    expect(Math.abs(Date.parse(body.lastSeenAt) - Date.now())).toBeLessThan(5_000);
    expect(Math.abs(Date.parse(body.scannerLastUsedAt!) - (Date.now() - 30_000))).toBeLessThan(5_000);

    const read = await stationRead();
    expect(read.lastSeenAt).toBe(body.lastSeenAt);
    expect(read.screen).toMatchObject({
      state: 'online', lastSeenAt: body.lastSeenAt, scannerLastUsedAt: body.scannerLastUsedAt,
      offlineAfterSeconds: screenOfflineAfterS(),
    });
    expect(read.screen!.scannerLastUsedAgeSeconds as number).toBeGreaterThanOrEqual(29);
    expect(read.screen!.scannerLastUsedAgeSeconds as number).toBeLessThan(40);

    const list = await ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/stations`, headers: { cookie: adminCookie } });
    const listed = (list.json().stations as Array<{ id: string; kind: string; screen: unknown }>);
    expect(listed.find((s) => s.id === tillId)!.screen).toMatchObject({ state: 'online' });
    // Only a till has a screen of its own: a booth is its box.
    for (const other of listed.filter((s) => s.kind !== 'till')) expect(other.screen).toBeNull();

    // Presence is not a change to the station: no version, no edit time, no audit row.
    const after = (await ctx.db.select().from(station).where(eq(station.id, tillId)))[0]!;
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.configVersion).toBe(before.configVersion);
    const audits = await ctx.db.select().from(auditLog)
      .where(and(eq(auditLog.entityId, tillId), like(auditLog.action, '%heartbeat%')));
    expect(audits).toHaveLength(0);
  });

  it('never moves the scanner’s time backwards, and a heartbeat with no scan keeps it', async () => {
    const first = (await heartbeat(receptionCookie, { lastScanSecondsAgo: 20 })).json().scannerLastUsedAt as string;
    // An older scan reported later — a second screen, or a heartbeat delivered late.
    expect((await heartbeat(receptionCookie, { lastScanSecondsAgo: 3_600 })).json().scannerLastUsedAt).toBe(first);
    expect((await heartbeat(receptionCookie, {})).json().scannerLastUsedAt).toBe(first);
    expect((await heartbeat(receptionCookie, { lastScanSecondsAgo: null })).json().scannerLastUsedAt).toBe(first);
    const newer = (await heartbeat(receptionCookie, { lastScanSecondsAgo: 0 })).json().scannerLastUsedAt as string;
    expect(Date.parse(newer)).toBeGreaterThan(Date.parse(first));
  });

  it('keeps reporting from a locked till, which may still do no business', async () => {
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    await takeStation(ctx.app, cookie, tillId);
    expect((await ctx.app.inject({ method: 'POST', url: '/auth/lock', headers: { cookie } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/me/station/link', headers: { cookie } })).statusCode).toBe(423);
    const res = await heartbeat(cookie, { lastScanSecondsAgo: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().stationId).toBe(tillId);
  });

  it('reads a till quiet past the threshold as offline, and raises nothing about it', async () => {
    await ctx.db.update(station).set({ lastSeenAt: new Date(Date.now() - (screenOfflineAfterS() + 120) * 1000) })
      .where(eq(station.id, tillId));
    expect((await stationRead()).screen).toMatchObject({ state: 'offline' });
    await watchdog();
    const raised = await ctx.db.select().from(alert).where(like(alert.key, `%${tillId}%`));
    expect(raised).toHaveLength(0);
    await heartbeat(receptionCookie);
    expect((await stationRead()).screen).toMatchObject({ state: 'online' });
  });

  it('refuses a session standing at no station, no session at all, and a scan age that is not one', async () => {
    const none = await heartbeat(adminCookie);
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe('NO_STATION_PICKED');
    expect((await ctx.app.inject({ method: 'POST', url: '/me/station/heartbeat', payload: {} })).statusCode).toBe(401);
    expect((await heartbeat(receptionCookie, { lastScanSecondsAgo: -1 })).statusCode).toBe(400);
    expect((await heartbeat(receptionCookie, { lastScanSecondsAgo: 1.5 })).statusCode).toBe(400);
  });

  it('neither raises nor reads as offline a display on a Pi box, which reads the box, and closes the alert it had on a virtual one', async () => {
    const [till] = await ctx.db.select().from(station).where(eq(station.id, tillId));
    const operatorId = till!.operatorId;
    const [piBox] = await ctx.db.insert(box).values({
      id: newId(), operatorId, branchId, name: 'ZZ TEST 771 counter box', slot: 'zz-test-771', role: 'counter',
    }).returning();
    // Stood first on the till's own virtual box, where the platform hears every call.
    const [counter] = await ctx.db.insert(station).values({
      id: newId(), operatorId, branchId, boxId: till!.boxId, name: 'ZZ TEST 771 counter till', kind: 'till', codePrefix: 'Z7',
    }).returning();
    const longAgo = new Date(Date.now() - 86_400_000);
    const [onBox] = await ctx.db.insert(deviceCredential).values({
      id: newId(), operatorId, branchId, kind: 'display', stationId: counter!.id, label: 'ZZ TEST 771 counter display',
      secretHash: randomBytes(32).toString('hex'), pairedAt: longAgo, lastSeenAt: longAgo,
    }).returning();
    const key = `display.offline:${onBox!.id}`;
    const presenceOf = async () => {
      const res = await ctx.app.inject({
        method: 'GET', url: `/branches/${branchId}/credentials`, headers: { cookie: adminCookie },
      });
      expect(res.statusCode).toBe(200);
      return (res.json().credentials as Array<{ id: string; presence: Record<string, unknown> | null }>)
        .find((c) => c.id === onBox!.id)!.presence;
    };

    await watchdog();
    expect((await alertsOf(key))[0]).toMatchObject({ status: 'open' });
    expect(await presenceOf()).toMatchObject({ state: 'offline', box: null });

    // The station moves to a Pi box: its display now reads the box, and the
    // platform's silence says nothing about it.
    await ctx.db.update(station).set({ boxId: piBox!.id }).where(eq(station.id, counter!.id));
    await watchdog();
    const [closed] = await alertsOf(key);
    expect(closed).toMatchObject({ status: 'resolved', resolvedReason: 'reads through its box' });
    expect(delivered.filter((d) => d.key === key && d.event === 'resolved')[0]!.summary)
      .toContain('reads through ZZ TEST 771 counter box');

    // A day quiet, the park open: nothing raised, and not offline.
    await ctx.db.delete(alert).where(eq(alert.key, key));
    await watchdog();
    await watchdog();
    expect(await alertsOf(key)).toHaveLength(0);
    const quiet = await presenceOf();
    expect(quiet).toMatchObject({ state: 'via_box', box: { id: piBox!.id, name: 'ZZ TEST 771 counter box' } });
    expect(quiet!.state).not.toBe('offline');

    // Heard by the platform lately, it is online.
    await ctx.db.update(deviceCredential).set({ lastSeenAt: new Date() }).where(eq(deviceCredential.id, onBox!.id));
    expect(await presenceOf()).toMatchObject({ state: 'online', box: { id: piBox!.id } });
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
