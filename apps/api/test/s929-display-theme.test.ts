import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { station } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-929 — THE CLOUD STATION KEEPS A PAIRED DISPLAY'S LOOK.
 *
 * The api's station is the box agent's `StationSessionManager` over the
 * `edge` schema (migration 0122 gives it the column), so a publication's
 * `theme` is kept exactly as a Pi keeps it
 * (packages/box-agent/test/s929-display-theme.test.ts). This file drives it
 * the two ways a till reaches it on the platform lane, the station routes and
 * the station bridge, and reads each result the way the paired display does.
 */

const welcomeFrame = (theme?: string) => ({
  stage: 'welcome', step: 2, cart: { supported: true, sale: { tier: 'tourist' } }, member: null, totals: null, payment: null,
  prompt: null, ...(theme === undefined ? {} : { theme }),
});

describe('SCRUM-929: the cloud station keeps the look a till tells its paired display', () => {
  let ctx: TestContext;
  let staff: string;
  let tillId: string;
  let authorization: string;

  const displayRead = async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/display/session', headers: { authorization } });
    expect(res.statusCode).toBe(200);
    return res.json().document as Record<string, unknown>;
  };
  const publish = (leaseId: string, lastSeenSequence: number, payload: Record<string, unknown>, base = `/stations/${tillId}`) =>
    ctx.app.inject({ method: 'POST', url: `${base}/intents`, headers: { cookie: staff },
      payload: { type: 'session.publish_display', leaseId, lastSeenSequence, actionId: newId(), payload } });
  const release = async (leaseId: string, base = `/stations/${tillId}`) => {
    const res = await ctx.app.inject({ method: 'POST', url: `${base}/lease/release`, headers: { cookie: staff }, payload: { leaseId } });
    expect(res.statusCode, res.body).toBe(200);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    const manager = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    staff = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const [row] = await ctx.db.select({ id: station.id }).from(station).where(eq(station.name, 'Reception Till 1')).limit(1);
    tillId = row!.id;
    expect((await ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie: staff },
      payload: { stationId: tillId } })).statusCode).toBe(200);
    authorization = `Bearer ${randomBytes(32).toString('hex')}`;
    const requested = await ctx.app.inject({ method: 'POST', url: '/display/pairing', headers: { authorization }, payload: {} });
    expect(requested.statusCode).toBe(200);
    const claimed = await ctx.app.inject({ method: 'POST', url: `/stations/${tillId}/displays/claim`,
      headers: { cookie: manager }, payload: { pairingCode: requested.json().pairingCode, name: 'ZZ TEST display' } });
    expect(claimed.statusCode).toBe(200);
  });
  afterAll(async () => { await ctx.close(); await teardownAll(); });

  it('through the station bridge (the till’s own path): never told, then kept and sent to the display', async () => {
    const base = `/box/v1/station/${tillId}`;
    const leased = await ctx.app.inject({ method: 'POST', url: `${base}/lease`, headers: { cookie: staff },
      payload: { holder: 'bridge-till' } });
    expect(leased.statusCode, leased.body).toBe(200);
    const leaseId = leased.json().lease.leaseId as string;
    // The field is there, so a till knows this box keeps a look.
    expect(leased.json().document).toHaveProperty('theme', null);
    expect(await displayRead()).toHaveProperty('theme', null);

    const told = await publish(leaseId, leased.json().document.sequence as number, welcomeFrame('light'), base);
    expect(told.statusCode, told.body).toBe(200);
    expect(told.json().document.theme).toBe('light');
    expect((await displayRead()).theme).toBe('light');
    const read = await ctx.app.inject({ method: 'GET', url: `${base}/session`, headers: { cookie: staff } });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().document.theme).toBe('light');

    // A publication without a look leaves it; a switch alone moves the fence.
    const quiet = await publish(leaseId, told.json().document.sequence as number, welcomeFrame(), base);
    expect(quiet.statusCode, quiet.body).toBe(200);
    expect(quiet.json().document.theme).toBe('light');
    const dark = await publish(leaseId, quiet.json().document.sequence as number, welcomeFrame('dark'), base);
    expect(dark.statusCode, dark.body).toBe(200);
    expect(dark.json().document.sequence).toBe((quiet.json().document.sequence as number) + 1);
    expect((await displayRead()).theme).toBe('dark');

    // Nothing but light or dark, and the screen is left as it was.
    const refused = await publish(leaseId, dark.json().document.sequence as number, welcomeFrame('blue'), base);
    expect(refused.statusCode).not.toBe(200);
    expect((await displayRead()).theme).toBe('dark');

    // Giving the station up clears the sale from the screen, not its look.
    await release(leaseId, base);
    const idle = await displayRead();
    expect(idle.cart).toBeNull();
    expect(idle.theme).toBe('dark');
  });

  it('the same through the station routes, which answer with the look too', async () => {
    const leased = await ctx.app.inject({ method: 'POST', url: `/stations/${tillId}/lease`, headers: { cookie: staff },
      payload: { holder: 'ipad-till' } });
    expect(leased.statusCode, leased.body).toBe(200);
    expect(leased.json().document.theme).toBe('dark');
    const shown = await publish(leased.json().lease.leaseId as string, leased.json().document.sequence as number, welcomeFrame('light'));
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json().document.theme).toBe('light');
    expect((await displayRead()).theme).toBe('light');
    await release(leased.json().lease.leaseId as string);
  });
});
