import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * S2-01b — every route is guarded, and the proof does not depend on anyone
 * remembering to write a test for their route.
 *
 * This walks the registry the permission plugin fills as routes register and
 * fails if a route declares none of: a permission, a platform-wide gate, a
 * session requirement, a deliberate `public: true`, or an explicit
 * `dynamicPermission` where the permission depends on the request. A new
 * route with no `config` fails here on the day it is written.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** Routes Fastify or a plugin registers for us, which we do not configure. */
const NOT_OURS = new Set(['/docs/json', '/*']);

describe('route guards (S2-01b)', () => {
  it('every registered route declares how it is guarded', () => {
    const routes = ctx.app.routeRegistry.filter(
      (r) => !NOT_OURS.has(r.url) && r.method !== 'HEAD' && r.method !== 'OPTIONS',
    );
    expect(routes.length).toBeGreaterThan(40);

    const unguarded = routes.filter(
      (r) =>
        !r.config.permission &&
        !r.config.platformWide &&
        !r.config.dynamicPermission &&
        !r.config.public &&
        !r.config.credential &&
        r.config.auth !== 'session',
    );
    expect(
      unguarded.map((r) => `${r.method} ${r.url}`),
      'routes with no declared guard — add config: { permission } (or public/auth/platformWide/credential)',
    ).toEqual([]);
  });

  it('the open surface is only what it should be', () => {
    const open = ctx.app.routeRegistry
      .filter((r) => r.config.public && r.method !== 'HEAD')
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    // Anything added here is a deliberate decision, made visible in a diff.
    expect(open).toEqual([
      'GET /health',
      'GET /public/branches/:code/catalog',
      'GET /public/member-tier',
      'GET /ready',
      // S2-02: the app's origin has no session yet — that is the point. The
      // token is the credential, fenced by its signature, its one-minute life
      // and its single-use jti.
      'POST /auth/handoff/exchange',
      'POST /auth/password-reset/complete',
      'POST /auth/password-reset/request',
      'POST /auth/setup/complete',
      'POST /auth/setup/start',
      'POST /auth/sign-in',
      'POST /auth/sign-out',
      'POST /public/bookings',
    ]);
  });

  /**
   * S2-04 — the machine surface, pinned separately from the open one.
   *
   * A box carries a credential and these routes refuse a caller without one,
   * so they are emphatically not public; but there is no session and no
   * account behind them either, which is why they declare a third kind of
   * guard. Keeping them in their own list means a route added here cannot be
   * mistaken for an open endpoint, and an open endpoint cannot be smuggled in
   * as a box route: both lists have to be edited on purpose.
   */
  it('the box surface is only what it should be, and is credential-guarded', async () => {
    const boxRoutes = ctx.app.routeRegistry
      .filter((r) => r.url.startsWith('/box/') && r.method !== 'HEAD')
      .map((r) => `${r.method} ${r.url} [${r.config.credential}]`)
      .sort();
    expect(boxRoutes).toEqual([
      'GET /box/v1/config [box]',
      'POST /box/v1/commands/:commandId/result [box]',
      'POST /box/v1/commands/poll [box]',
      'POST /box/v1/heartbeat [box]',
      // The one route a box reaches before it has a credential: the claim
      // code IS the credential, single-use and short-lived.
      'POST /box/v1/register [box-claim]',
    ]);
    // None of them is also marked public — the two are different guards and a
    // route carrying both would be read as open by anyone skimming.
    expect(
      ctx.app.routeRegistry.filter((r) => r.config.credential && r.config.public),
    ).toEqual([]);
  });

  it('a box route refuses a caller with no credential', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/heartbeat',
      payload: { reportedAt: new Date().toISOString(), agentVersion: '0.1.0' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('BOX_UNAUTHORIZED');
  });

  it('refuses a route registered without a guard', async () => {
    // The check itself, run against a deliberately bad route.
    const registry = [
      ...ctx.app.routeRegistry,
      { method: 'POST', url: '/oops', config: {} },
    ];
    const unguarded = registry.filter(
      (r) =>
        !r.config.permission &&
        !r.config.platformWide &&
        !r.config.dynamicPermission &&
        !r.config.public &&
        !r.config.credential &&
        r.config.auth !== 'session' &&
        !NOT_OURS.has(r.url) &&
        r.method !== 'HEAD' &&
        r.method !== 'OPTIONS',
    );
    expect(unguarded.map((r) => r.url)).toEqual(['/oops']);
  });

  it('the declared guard actually runs — no session, no entry', async () => {
    const guarded = ctx.app.routeRegistry.find(
      (r) => r.method === 'GET' && /^\/accounts\/?$/.test(r.url),
    );
    expect(guarded?.config.permission).toBe('admin:account:read');
    const res = await ctx.app.inject({ method: 'GET', url: '/accounts' });
    expect(res.statusCode).toBe(401);
  });
});
