import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { alert, branch, deviceCredential, station } from '@oto/db';
import { newId } from '@oto/shared';
import { runWatchdog } from '../src/services/jobs';
import type { AlertChannel, AlertMessage } from '../src/services/ops';
import { screenOfflineAfterS } from '../src/services/screen-presence';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

const alwaysOpen = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(day => [day, { open: '00:00', close: '00:00' }]),
);

describe('SCRUM-819 adversarial review: the first display sighting', () => {
  let ctx: TestContext;
  let cookie: string;
  let seedTill: typeof station.$inferSelect;
  let sequence = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
    cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const [till] = await ctx.db.select().from(station).where(eq(station.name, 'Reception Till 1'));
    if (!till) throw new Error('The seeded till is required');
    seedTill = till;
    await ctx.db.update(branch).set({ openingHours: alwaysOpen }).where(eq(branch.id, seedTill.branchId));
  });

  afterAll(async () => {
    vi.useRealTimers();
    await ctx.close();
    await teardownAll();
  });

  async function pair() {
    sequence += 1;
    const [till] = await ctx.db.insert(station).values({
      id: newId(), operatorId: seedTill.operatorId, branchId: seedTill.branchId,
      boxId: seedTill.boxId, name: `ZZ TEST SCRUM-819 till ${sequence}`, kind: 'till', codePrefix: `Z819${sequence}`,
    }).returning();
    const authorization = `Bearer ${randomBytes(32).toString('hex')}`;
    const mint = await ctx.app.inject({ method: 'POST', url: '/display/pairing', headers: { authorization }, payload: {} });
    expect(mint.statusCode).toBe(200);
    const claimed = await ctx.app.inject({
      method: 'POST', url: `/stations/${till!.id}/displays/claim`, headers: { cookie },
      payload: { pairingCode: mint.json().pairingCode, name: `ZZ TEST SCRUM-819 display ${sequence}` },
    });
    expect(claimed.statusCode).toBe(200);
    const [credential] = await ctx.db.select().from(deviceCredential).where(eq(deviceCredential.id, claimed.json().device.id));
    return { till: till!, credential: credential!, authorization };
  }

  it('keeps the pairing tied to the chosen till, park and manager', async () => {
    const { till, credential } = await pair();
    expect(credential).toMatchObject({ stationId: till.id, branchId: till.branchId, operatorId: till.operatorId, kind: 'display' });
    expect(credential.pairedByAccountId).not.toBeNull();
    expect(credential.pairedAt).not.toBeNull();
  });

  it('MEDIUM FINDING fixed: the claim transaction stamps the first sighting with the pairing time', async () => {
    const { credential } = await pair();
    expect(credential.lastSeenAt).toEqual(credential.pairedAt);
  });

  it('MEDIUM FINDING fixed: the first real silence is delivered and genuine flaps remain suppressed', async () => {
    const { till, credential, authorization } = await pair();
    const key = `display.offline:${credential.id}`;
    const delivered: AlertMessage[] = [];
    const channels: AlertChannel[] = [{ name: 'console', async deliver(message) { delivered.push(message); return { target: 'test' }; } }];
    const watchdog = () => runWatchdog({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, channels });
    const rows = () => ctx.db.select().from(alert).where(eq(alert.key, key));
    const opened = () => delivered.filter(d => d.key === key && d.event === 'opened');
    const poll = async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/box/v1/station/${till.id}/display/session`, headers: { authorization } });
      expect(response.statusCode).toBe(200);
    };
    const pairedAt = credential.pairedAt!.getTime();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(pairedAt + 2_000);
      await watchdog();
      expect(await rows()).toHaveLength(0);
      expect(opened()).toHaveLength(0);
      await poll();
      await watchdog();
      expect(await rows()).toHaveLength(0);

      // A real silence soon after pairing must be a new, delivered condition.
      vi.setSystemTime(pairedAt + (screenOfflineAfterS() + 3) * 1_000);
      await watchdog();
      const [first] = await rows();
      expect(first).toMatchObject({ status: 'open', reopenCount: 0 });
      expect(first!.lastNotifiedAt).not.toBeNull();
      expect(opened()).toHaveLength(1);
      await watchdog();
      expect(await rows()).toHaveLength(1);
      expect(opened()).toHaveLength(1);

      // Recovery and an actual flap still obey the established single-send rule.
      await poll();
      await watchdog();
      expect((await rows())[0]).toMatchObject({ id: first!.id, status: 'resolved' });
      await ctx.db.update(deviceCredential).set({ lastSeenAt: new Date(pairedAt) }).where(eq(deviceCredential.id, credential.id));
      await watchdog();
      expect((await rows())[0]).toMatchObject({ id: first!.id, status: 'open', reopenCount: 1 });
      expect(opened()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
