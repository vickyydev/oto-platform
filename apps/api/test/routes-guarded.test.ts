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
        r.config.auth !== 'session',
    );
    expect(
      unguarded.map((r) => `${r.method} ${r.url}`),
      'routes with no declared guard — add config: { permission } (or public/auth/platformWide)',
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
      'POST /auth/password-reset/complete',
      'POST /auth/password-reset/request',
      'POST /auth/setup/complete',
      'POST /auth/setup/start',
      'POST /auth/sign-in',
      'POST /auth/sign-out',
      'POST /public/bookings',
    ]);
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
