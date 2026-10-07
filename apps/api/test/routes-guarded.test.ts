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

/**
 * Routes Fastify or a plugin registers for us, which we do not configure.
 *
 * `/docs/json` was on this list until SCRUM-254 and is ours after all: the
 * OpenAPI document served to anyone with no session. It was exempt here
 * because it was declared above the guard plugins, where `permissionPlugin`'s
 * `onRoute` hook never saw it — so it was absent from `routeRegistry` and the
 * exemption made that absence look deliberate. It is declared below the
 * plugins now and takes `admin:health:read`, so it walks with everything else.
 */
const NOT_OURS = new Set(['/*']);

describe('route guards (S2-01b)', () => {
  it('pins the cloud trading surface refused by a selected forced-offline station', () => {
    const trading = ctx.app.routeRegistry
      .filter((r) => r.config.stationTrading && r.method !== 'HEAD' && r.method !== 'OPTIONS')
      .map((r) => `${r.method} ${r.url.replace(/\/$/, '')}`)
      .sort();
    expect(trading).toEqual([
      'DELETE /members/:id',
      'DELETE /members/:id/tier-verification',
      'DELETE /members/children/:childId',
      'DELETE /sales/:id/vouchers/:voucherId',
      // SCRUM-477: a booking is read where it is redeemed — on the box, once
      // the station is forced offline — so the three lookups refuse with it.
      'GET /bookings/:id',
      'GET /bookings/by-qr',
      'GET /bookings/by-reference/:reference',
      'GET /members/lookup',
      'GET /vouchers/lookup',
      'PATCH /members/:id',
      'PATCH /members/children/:childId',
      'POST /bookings/:id/redeem',
      'POST /members',
      'POST /members/:id/children',
      'POST /members/:id/tier-verification',
      'POST /payments/attempts',
      'POST /payments/attempts/:id/confirm',
      'POST /payments/attempts/:id/inquire',
      'POST /payments/manual',
      'POST /print-jobs/:id/reprint',
      'POST /sales',
      // SCRUM-495: extra time is a new charge against a cloud admission and
      // its bracelets, online only like the refund that corrects a sale; the
      // bracelet repair changes which bands the paid minutes sit on.
      'POST /sales/:id/extensions',
      'POST /sales/:id/extensions/:extensionId/bands',
      'POST /sales/:id/finalise',
      // S2-11: a refund and a reprint are online-only, like the sale they correct.
      'POST /sales/:id/refunds',
      'POST /sales/:id/reprints',
      'POST /sales/:id/void',
      'POST /sales/:id/vouchers',
      'POST /sales/quote',
      'POST /sales/tier-claims',
      'POST /visits',
      // S2-14a round 5: a voucher is issued and its credit printed by the
      // platform, at the till — online only, like a voucher's redemption.
      'POST /vouchers/:id/credit/print',
      'POST /vouchers/issue',
    ]);
    expect(ctx.app.routeRegistry.filter((r) => r.config.stationTrading &&
      (r.config.public || r.config.credential || r.url.startsWith('/boxes/')))).toEqual([]);
  });

  it('retires the staff-session display mailbox after independent display rollout', () => {
    expect(ctx.app.routeRegistry.some(route => route.url.includes('pending-lookup'))).toBe(false);
  });

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
      /**
       * S2-12 (SCRUM-209) — the booking site's waiting page, polling one
       * booking by its own id. It answers the booking's state and, once the
       * gateway has confirmed the money, its signed QR — no name, no phone, no
       * child.
       */
      'GET /public/bookings/:id/status',
      /** The same browser return as the POST below, reached by a GET. Writes nothing. */
      'GET /public/bookings/return',
      'GET /public/branches/:code/catalog',
      'GET /public/member-tier',
      'GET /ready',
      /**
       * S2-12 — the SIMULATED hosted payment page, the guest's stand-in for
       * 2C2P's own public page. 404 on any deployment with the real gateway,
       * which is every live park (`assertProductionSafe`).
       */
      'GET /webhooks/2c2p/hosted/:attemptId',
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
      // SCRUM-244 — the one open route the Lucky Wheel has left.
      //
      // Six `/booth/*` routes were on this list until the booth learned to
      // pair: the television carried nothing (D15 forbids a token in a bundle
      // on a screen in a shopping centre) and `POST /booth/spin` was therefore
      // a URL a stranger could press to mint a voucher. They now declare
      // `credential: 'booth'` and are pinned in their own list below, the same
      // separation the box surface has.
      //
      // This one cannot be anything else: a screen with no credential is
      // exactly what it is for, and the six digits it takes ARE the credential
      // for that one call — single use, ten minutes, counted per address on
      // failure. Same shape as `POST /box/v1/register`.
      'POST /booth/pair',
      'POST /public/bookings',
      /**
       * S2-12 — the booking's ONE payment: an attempt on the `WEB` invoice
       * segment and the hosted page's address. It pays nothing; a booking is
       * paid only by the webhook below plus an inquiry, or by the poller.
       */
      'POST /public/bookings/:id/checkout',
      /**
       * S2-12 — the hosted page sending the guest's browser back. Verified,
       * read as a display hint, and it WRITES NOTHING — the invariant of the
       * round, held by `route-write-conformance.test.ts`'s no-write list.
       */
      'POST /public/bookings/return',
      /** S2-12 — a press of pay / fail on the simulated hosted page. Simulator only. */
      'POST /webhooks/2c2p/hosted/:attemptId',
      /**
       * S2-10a — what the payment gateway posts to us.
       *
       * Its caller is 2C2P's server, which has no session and never will: the
       * HS256 signature on the body IS the authentication, verified before a
       * single claim is read, and `PGW_WEBHOOK_SECRET` on the URL is a filter
       * for internet noise that this file's readers should not mistake for a
       * credential check. It is the one route on this list that must answer
       * **200 even when it refuses** — a 4xx makes 2C2P redeliver all evening
       * — so "open" here means open to being told something, never open to
       * being believed.
       */
      'POST /webhooks/2c2p/payment',
    ]);
  });

  /**
   * SCRUM-244 — the booth's television surface, pinned the way the box's is.
   *
   * Its own list for the same reason the box has one: a route added here
   * cannot be mistaken for an open endpoint, and an open endpoint cannot be
   * smuggled in as a booth route, because both lists have to be edited on
   * purpose. The behavioural half — an anonymous press writes no spin row — is
   * in `booth-pairing.test.ts`, which is where the database is.
   */
  it('the booth surface is only what it should be, and is credential-guarded', () => {
    const boothRoutes = ctx.app.routeRegistry
      .filter((r) => r.url.startsWith('/booth/') && r.method !== 'HEAD')
      .map((r) => `${r.method} ${r.url} [${r.config.credential ?? (r.config.public ? 'public' : '')}]`)
      .sort();
    expect(boothRoutes).toEqual([
      'GET /booth/config [booth]',
      'GET /booth/staff [booth]',
      'GET /booth/status [booth]',
      // The pairing exchange, and the only open one. It is on the open list
      // above as well, deliberately: it belongs to both surfaces and a reader
      // of either list should see it.
      'POST /booth/pair [public]',
      'POST /booth/print [booth]',
      'POST /booth/reprint [booth]',
      'POST /booth/spin [booth]',
      'POST /booth/staff/sign-in [booth]',
      'POST /booth/staff/sign-out [booth]',
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
  /**
   * The station bridge's mount (offline plan Round 3) shares the box's version
   * prefix — it is the contract a Pi serves at the same path — but its caller
   * is a till or a display, not a box, so it is pinned on its own below.
   */
  const isBridge = (url: string): boolean => url.startsWith('/box/v1/station/');

  it('the box surface is only what it should be, and is credential-guarded', async () => {
    const boxRoutes = ctx.app.routeRegistry
      .filter((r) => r.url.startsWith('/box/') && !isBridge(r.url) && r.method !== 'HEAD')
      .map((r) => `${r.method} ${r.url} [${r.config.credential}]`)
      .sort();
    expect(boxRoutes).toEqual([
      // The cache bundle (S2-05): the branch's members, children and prices, so
      // a counter keeps working with no internet. It is the single largest
      // thing a box is ever given, which is why the list it appears on is one
      // somebody has to edit deliberately.
      'GET /box/v1/cache [box]',
      'GET /box/v1/config [box]',
      // S2-11: the content of a sale's print job, fetched as the box prints it,
      // so no printout's member, allergy line or band code is ever stored in a
      // command.
      'GET /box/v1/print-jobs/:id/document [box]',
      'GET /box/v1/sync/pull [box]',
      // SCRUM-223: a booth box asks whether a phone and password typed at one
      // of ITS booths may sign in there. The password is the body; the box is
      // the caller.
      'POST /box/v1/booth/staff/verify [box]',
      'POST /box/v1/commands/:commandId/result [box]',
      'POST /box/v1/commands/poll [box]',
      'POST /box/v1/heartbeat [box]',
      // S2-13 round 4: a photo a counter took with the link down — an upload
      // URL for it, then its link to its row, exactly once. Photos of faces
      // only, never a document.
      'POST /box/v1/photos/:id/link [box]',
      'POST /box/v1/photos/:id/upload-url [box]',
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
      (r) =>
        r.url.startsWith('/box/') &&
        !isBridge(r.url) &&
        r.method !== 'HEAD' &&
        r.method !== 'OPTIONS',
    );
    expect(boxUrls.length).toBe(14);

    const bodies: Record<string, unknown> = {
      'POST:/box/v1/register': { claimCode: undefined, agentVersion: '0.1.0' },
      'POST:/box/v1/heartbeat': { reportedAt: new Date().toISOString(), agentVersion: '0.1.0' },
      'POST:/box/v1/commands/poll': { max: 5 },
      'POST:/box/v1/commands/:commandId/result': { state: 'succeeded' },
      'POST:/box/v1/print-jobs/:id/result': { status: 'printed', attempts: 1 },
      'POST:/box/v1/photos/:id/upload-url': { target: { kind: 'release', id: '00000000-0000-7000-8000-000000000000' } },
      'POST:/box/v1/photos/:id/link': { target: { kind: 'release', id: '00000000-0000-7000-8000-000000000000' } },
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

  /**
   * THE STATION BRIDGE ON THE API (offline plan §2.2, Round 3): the platform
   * session for a till standing at the station (OD-2), a paired display's own
   * credential for the customer display (OD-10), and nothing for anybody else.
   * Deliberately NOT `stationTrading`: it is the box's surface and keeps
   * answering with the station forced offline — `offline-capability.test.ts`
   * is where that is proved.
   */
  it('the station bridge is only what it should be, and refuses a caller with neither credential', async () => {
    const bridge = ctx.app.routeRegistry
      .filter((r) => isBridge(r.url) && r.method !== 'HEAD' && r.method !== 'OPTIONS')
      .map((r) => `${r.method} ${r.url} [${r.config.credential ?? (r.config.dynamicPermission ? 'session' : '?')}]`)
      .sort();
    expect(bridge).toEqual([
      'GET /box/v1/station/:stationId/channel [session]',
      'GET /box/v1/station/:stationId/display/session [display]',
      'GET /box/v1/station/:stationId/members/lookup [session]',
      'GET /box/v1/station/:stationId/session [session]',
      'GET /box/v1/station/:stationId/status [session]',
      'POST /box/v1/station/:stationId/display/intents [display]',
      'POST /box/v1/station/:stationId/intents [session]',
      // S2-20 K1 — the self-service kiosk, on its own paired credential and device scope.
      'POST /box/v1/station/:stationId/kiosk/redeem [kiosk]',
      'POST /box/v1/station/:stationId/lease [session]',
      'POST /box/v1/station/:stationId/lease/release [session]',
      'POST /box/v1/station/:stationId/lease/renew [session]',
      'POST /box/v1/station/:stationId/lock [session]',
      'POST /box/v1/station/:stationId/unlock [session]',
    ]);
    expect(
      ctx.app.routeRegistry.filter((r) => isBridge(r.url) && r.config.stationTrading),
    ).toEqual([]);
    const station = '00000000-0000-7000-8000-000000000000';
    for (const route of ctx.app.routeRegistry.filter(
      (r) => isBridge(r.url) && r.method !== 'HEAD' && r.method !== 'OPTIONS',
    )) {
      const res = await ctx.app.inject({
        method: route.method as 'GET' | 'POST',
        url: `${route.url.replace(':stationId', station)}${route.url.endsWith('lookup') ? '?phone=1' : ''}`,
        ...(route.method === 'GET' ? {} : { payload: {} as never }),
      });
      expect([400, 401], `${route.method} ${route.url}`).toContain(res.statusCode);
      if (res.statusCode === 400) {
        // A body schema checked before the session: still nothing done.
        expect(res.json().error.code, `${route.method} ${route.url}`).toBe('VALIDATION');
      }
    }
  });

  /**
   * The declared guard is not always the guard.
   *
   * `config: { permission }` installs a preHandler, so declaring it IS the
   * guard. `dynamicPermission: true` installs nothing — it says "the handler
   * asks, because the permission depends on the request" — and forty routes
   * declare it. Nothing above checks that any of them actually asks. That is
   * the same shape of hole `credential` had before the box test below was
   * widened: a label that reads as protection and enforces nothing, which the
   * next route to declare it and forget would inherit.
   *
   * Authentication is not global here — `sessionPlugin` loads `req.auth` and
   * leaves it to the handler to call `requireAuth()` — so a handler that never
   * asks runs for a caller with no cookie at all. Every guarded route refuses
   * one before it does any work: 401 from `requireAuth`, or 400 where a body
   * schema is validated first.
   *
   * **What this does not cover.** On a route with a body schema, validation
   * runs before the handler, so an unguarded one would answer 400 here and
   * pass. The 400s are therefore an admission, not a result: what this pins is
   * that no route answers an anonymous caller with a 2xx, or reaches a lookup
   * and answers 404.
   */
  it('no route answers an anonymous caller', async () => {
    const reachable = ctx.app.routeRegistry.filter(
      (r) =>
        !NOT_OURS.has(r.url) &&
        r.method !== 'HEAD' &&
        r.method !== 'OPTIONS' &&
        !r.config.public &&
        !r.config.credential,
    );
    expect(reachable.length).toBeGreaterThan(40);

    const answered: string[] = [];
    for (const route of reachable) {
      const url = route.url.replace(/:[A-Za-z]+/g, '00000000-0000-7000-8000-000000000000');
      const res = await ctx.app.inject({
        method: route.method as 'GET',
        url,
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} as never }),
      });
      if (![400, 401].includes(res.statusCode)) {
        answered.push(`${route.method} ${route.url} → ${res.statusCode}`);
      }
    }
    expect(
      answered,
      'these routes did something for a caller with no session — a handler that never calls requireAuth/requirePermission',
    ).toEqual([]);
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
