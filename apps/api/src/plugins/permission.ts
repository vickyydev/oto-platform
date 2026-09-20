import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import type { Permission } from '@oto/shared';

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
   * Authenticated by a MACHINE credential the handler checks itself (S2-04).
   * `box` is a registered box's secret; `box-claim` is the single-use code a
   * box redeems to get one.
   *
   * Its own kind rather than `public: true`, because these routes are not
   * open: they refuse an anonymous caller. Calling them public would have
   * satisfied the "every route declares a guard" test while quietly adding
   * five entries to the pinned list of genuinely open endpoints, which is the
   * one thing that list exists to stop.
   */
  credential?: 'box' | 'box-claim';
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

export const permissionPlugin = fp(async (app: FastifyInstance) => {
  app.decorate('routeRegistry', [] as FastifyInstance['routeRegistry']);

  app.addHook('onRoute', (route: RouteOptions) => {
    const config = (route.config ?? {}) as PermissionConfig;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      app.routeRegistry.push({ method, url: route.url, config });
    }
    if (!config.permission) return;

    const guard = async (req: FastifyRequest) => {
      const target: Record<string, string | undefined> = {};
      for (const [key, path] of Object.entries(config.target ?? {})) {
        target[key] = readPath(req, path as TargetPath);
      }
      await req.requirePermission(config.permission!, target);
    };

    const existing = route.preHandler;
    route.preHandler = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), guard]
      : [guard];
  });
});
