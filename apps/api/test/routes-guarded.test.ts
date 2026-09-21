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
      // The cache bundle (S2-05): the branch's members, children and prices, so
      // a counter keeps working with no internet. It is the single largest
      // thing a box is ever given, which is why the list it appears on is one
      // somebody has to edit deliberately.
      'GET /box/v1/cache [box]',
      'GET /box/v1/config [box]',
      'GET /box/v1/sync/pull [box]',
      'POST /box/v1/commands/:commandId/result [box]',
      'POST /box/v1/commands/poll [box]',
      'POST /box/v1/heartbeat [box]',
      // What happened to a print job (S2-06). Its own route rather than a
      // command result, because a job that waited on an empty roll reports
      // long after the command that queued it was acknowledged.
      'POST /box/v1/print-jobs/:id/result [box]',
      // The one route a box reaches before it has a credential: the claim
      // code IS the credential, single-use and short-lived.
      'POST /box/v1/register [box-claim]',
      'POST /box/v1/sync/key [box]',
      'POST /box/v1/sync/push [box]',
    ]);
    // None of them is also marked public — the two are different guards and a
    // route carrying both would be read as open by anyone skimming.
    expect(
      ctx.app.routeRegistry.filter((r) => r.config.credential && r.config.public),
    ).toEqual([]);
  });

  /**
   * EVERY box route, anonymously — the behaviour, not the label.
   *
   * `config.credential` used to be a label: the permission plugin installed a
   * preHandler only for `config.permission`, so the box surface was safe purely
   * because each handler remembered to call `authenticateBox` itself. A sixth
   * route that forgot would have been open and would still have passed this
   * file, because the two tests above pin the declared labels and the URL list.
   * So the guard now lives in `plugins/credential.ts` and this walks the whole
   * surface rather than one route of it — including the poll and the result,
   * which had no anonymous test at all.
   */
  it('every box route refuses a caller with no credential', async () => {
    const boxUrls = ctx.app.routeRegistry.filter(
      (r) => r.url.startsWith('/box/') && r.method !== 'HEAD' && r.method !== 'OPTIONS',
    );
    expect(boxUrls.length).toBe(10);

    const bodies: Record<string, unknown> = {
      'POST:/box/v1/register': { claimCode: undefined, agentVersion: '0.1.0' },
      'POST:/box/v1/heartbeat': { reportedAt: new Date().toISOString(), agentVersion: '0.1.0' },
      'POST:/box/v1/commands/poll': { max: 5 },
      'POST:/box/v1/commands/:commandId/result': { state: 'succeeded' },
      'POST:/box/v1/print-jobs/:id/result': { status: 'printed', attempts: 1 },
      'POST:/box/v1/sync/key': { publicKey: 'x'.repeat(44) },
      // A whole batch of facts, sent by nobody. It must be refused before the
      // body is looked at, which is what preValidation buys.
      'POST:/box/v1/sync/push': { events: [] },
    };

    for (const route of boxUrls) {
      const url = route.url
        .replace(':commandId', '00000000-0000-7000-8000-000000000000')
        .replace(':id', '00000000-0000-7000-8000-000000000000');
      const res = await ctx.app.inject({
        method: route.method as 'GET' | 'POST',
        url,
        ...(route.method === 'GET'
          ? {}
          : { payload: (bodies[`${route.method}:${route.url}`] ?? {}) as never }),
      });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
      // Register answers with its own code — the claim code IS the credential
      // there — and everything else with the box one. Both are refusals, and
      // neither is a schema complaint about a body nobody was entitled to send.
      expect(
        ['BOX_UNAUTHORIZED', 'BOX_CLAIM_INVALID'],
        `${route.method} ${route.url}`,
      ).toContain(res.json().error.code);
    }
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
