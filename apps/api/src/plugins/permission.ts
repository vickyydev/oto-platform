import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import type { KioskDeviceScope, Permission } from '@oto/shared';

/**
 * Permissions declared on the route, not remembered in the handler (S2-01b).
 *
 * Sprint 1 opened every handler with `await req.requirePermission(...)`. That
 * works right up until someone adds a route and forgets the line — and
 * nothing anywhere would have noticed. Declaring the guard in the route
 * options moves it somewhere a test can enumerate: `permission.test.ts`
 * walks every registered route and fails if one is neither guarded nor
 * explicitly, deliberately open.
 *
 * Scope targets are paths into the request (`params.branchId`), because the
 * branch a caller is acting on is usually in the URL and the guard has to
 * know it before the handler runs.
 */

export type TargetPath = `params.${string}` | `query.${string}` | `body.${string}`;

export interface PermissionConfig {
  /** The permission required to enter this route. */
  permission?: Permission;
  /** Where in the request the scope target is found. */
  target?: {
    operatorId?: TargetPath;
    branchId?: TargetPath;
    departmentId?: TargetPath;
    recordId?: TargetPath;
  };
  /**
   * Deliberately open: no session needed. Only the health probes, the OpenAPI
   * document and the customer-facing `/public/*` surface, which is fenced by
   * rate limits instead.
   */
  public?: true;
  /**
   * S2-12 — a public route ANOTHER SITE sends the browser to with a form POST:
   * the payment gateway's hosted page returning the guest to
   * `/public/bookings/return`. The Origin check on writes (`app.ts`) lets it
   * through, because the POST comes from the gateway's page by design and
   * because such a route writes nothing — `route-write-conformance.test.ts`
   * holds it on the no-write list, so a write added to it fails there.
   */
  crossSiteReturn?: true;
  /** A signed-in caller is enough; no permission applies (e.g. `/me`). */
  auth?: 'session';
  /**
   * The permission depends on the request (e.g. read vs write of the same
   * resource), so the handler calls `requirePermission` itself. Named, so
   * that "the guard is in the handler" is a decision rather than an
   * oversight.
   */
  dynamicPermission?: true;
  /**
   * Guarded by a platform-wide assignment rather than a named permission:
   * managing operators themselves is not an operator's business.
   */
  platformWide?: true;
  /**
   * Authenticated by a MACHINE credential, verified by `plugins/credential.ts`
   * before the handler runs (S2-04). `box` is a registered box's secret;
   * `box-claim` is the single-use code a box redeems to get one; `booth` is
   * the credential a booth television was paired with (SCRUM-244).
   *
   * Its own kind rather than `public: true`, because these routes are not
   * open: they refuse an anonymous caller. Calling them public would have
   * satisfied the "every route declares a guard" test while quietly adding
   * five entries to the pinned list of genuinely open endpoints, which is the
   * one thing that list exists to stop.
   */
  credential?: 'box' | 'box-claim' | 'booth' | 'display' | 'display-pairing' | 'kiosk' | 'kiosk-pairing';
  /** Required capability of a paired display, checked without a staff cookie. */
  displayScope?: 'display:read' | 'display:intents';
  /**
   * S2-20 K1 — the device scope a paired kiosk must carry on a
   * `credential: 'kiosk'` route. Its own word rather than a `permission`: no
   * role holds it, so no session could ever pass a `permission` guard on it.
   */
  kioskScope?: KioskDeviceScope;
  /**
   * This route's answer IS a credential — a box secret, a temporary password,
   * a hand-off token — so it must never enter the idempotency store, which
   * keeps a response body for a day and replays it to anyone holding the key.
   *
   * Declared on the ROUTE rather than remembered at the callsite. Three
   * places used to dodge the store by hand — `createBox` and `pairCredential`
   * keep the code out of the value `withTx` returns, `/auth/handoff` gave the
   * claim back — and each was a habit the next credential-minting route would
   * have had to know about. Saying it here makes the plugin refuse the key
   * outright: no row is claimed, so there is nothing to store and nothing to
   * replay, and a genuine retry does the work again rather than waiting out a
   * key whose answer is never written.
   */
  secretResponse?: true;
  /**
   * S2-21 round 2 — SOME of this route's answers carry a credential that was
   * scanned rather than minted: the scan door hands a staff benefit QR back to
   * the staff screen, which presents it to the cloud for free items or credit.
   * Its other answers — a product added, a band read — are worth replaying, so
   * `secretResponse` would cost the till every retry. Declared, an answer that
   * carries one (`carriesSecret`, `plugins/idempotency.ts`) is kept out of the
   * store and its key given back, and the backstop does not log it as a route
   * that forgot to say so.
   */
  scannedCredential?: true;
  /**
   * S2-20 E5 (review E5R-1) — this route answers a repeat by the id the client
   * minted in its BODY, and decides that repeat against what is true NOW. The
   * replay store must not answer for it: a stored answer is a snapshot taken
   * when the press was made, and it goes on being handed out for a day after
   * the thing it names has been taken back. The event check-in is the case:
   * the till retries a press under the same key and the same check-in id, and
   * a stored "checked in" would name the short codes of bands revoked since
   * (the OTO App undid the check-in and the child was checked in again), where
   * the route itself says the check-in was taken back.
   *
   * Declared, the plugin claims no key for the route — exactly as for
   * `secretResponse` — and the route's own replay is the answer: the id's row
   * is read before anything else, and two presses of one id at once are
   * decided one after the other under the route's own locks.
   */
  replaysByOwnId?: true;
  /** Cloud trading calls that a station's forced-offline test must refuse. */
  stationTrading?: true;
  /**
   * The forced-offline refusal this route speaks, when the generic
   * "go online before taking payment" is the wrong thing to say — a voucher is
   * not a payment, so it gets its own offline sentence in the same voice. The
   * code stays `STATION_FORCED_OFFLINE` so the till's lane arbiter still reads
   * it; only the message changes. Ignored unless `stationTrading` is set.
   */
  stationOfflineMessage?: string;
}

declare module 'fastify' {
  // Empty on purpose: this merges the declaration above into Fastify's own
  // config bag, so `config: { permission: … }` type-checks at every route.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface FastifyContextConfig extends PermissionConfig {}
  interface FastifyInstance {
    /** Every registered route, for the enumeration test. */
    routeRegistry: Array<{ method: string; url: string; config: PermissionConfig }>;
  }
}

function readPath(req: FastifyRequest, path: TargetPath): string | undefined {
  const [where, ...rest] = path.split('.');
  const key = rest.join('.');
  const bag = (req as unknown as Record<string, Record<string, unknown> | undefined>)[where!];
  const value = bag?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** Also used before the forced-offline refusal, ahead of idempotency. */
export async function requireRoutePermission(
  req: FastifyRequest,
  config: PermissionConfig,
): Promise<void> {
  if (!config.permission) return;
  const target: Record<string, string | undefined> = {};
  for (const [key, path] of Object.entries(config.target ?? {})) {
    target[key] = readPath(req, path as TargetPath);
  }
  await req.requirePermission(config.permission, target);
}

export const permissionPlugin = fp(async (app: FastifyInstance) => {
  app.decorate('routeRegistry', [] as FastifyInstance['routeRegistry']);

  app.addHook('onRoute', (route: RouteOptions) => {
    const config = (route.config ?? {}) as PermissionConfig;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      app.routeRegistry.push({ method, url: route.url, config });
    }
    if (!config.permission) return;

    const guard = (req: FastifyRequest) => requireRoutePermission(req, config);

    const existing = route.preHandler;
    route.preHandler = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), guard]
      : [guard];
  });
});
