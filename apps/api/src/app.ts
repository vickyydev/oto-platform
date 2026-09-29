import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import Fastify, {
  type FastifyError,
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import type { Db } from '@oto/db';
import type { Env } from './env';
import { buildErrorReporter, type ErrorReporter } from './lib/error-reporting';
import { buildLogger } from './lib/logger';
import { AppError } from './lib/errors';
import { healthRoutes } from './routes/health';
import { authRoutes } from './routes/auth';
import { meRoutes } from './routes/me';
import { accountRoutes } from './routes/accounts';
import { appIdentityRoutes } from './routes/app-identities';
import { operatorRoutes } from './routes/operators';
import { branchRoutes } from './routes/branches';
import { memberRoutes } from './routes/members';
import { visitRoutes } from './routes/visits';
import { bookingRoutes } from './routes/bookings';
import { saleRoutes } from './routes/sales';
import { paymentRoutes } from './routes/payments';
import { webhookRoutes } from './routes/webhooks';
import { saleTierRoutes } from './routes/sale-tier';
import { catalogRoutes } from './routes/catalog';
import { branchCloneRoutes } from './routes/branch-clone';
import { menuRoutes } from './routes/menu';
import { auditRoutes } from './routes/audit';
import { fileRoutes } from './routes/files';
import { publicRoutes } from './routes/public';
import { opsRoutes } from './routes/ops';
import { boxRoutes } from './routes/box';
import { fleetRoutes } from './routes/fleet';
import { stationSessionRoutes } from './routes/stations';
import { printRoutes } from './routes/print';
import { scanningRoutes } from './routes/scanning';
import { staffTokenRoutes } from './routes/staff-token';
import { boothRoutes } from './routes/booth';
import { PermissionDeniedError, sessionPlugin } from './plugins/session';
import { idempotencyPlugin } from './plugins/idempotency';
import { rateLimitPlugin } from './plugins/rate-limit';
import { permissionPlugin } from './plugins/permission';
import { stationOfflinePlugin } from './plugins/station-offline';
import { credentialPlugin } from './plugins/credential';
import { telemetryPlugin } from './plugins/telemetry';
import { pgErrorOf, scrubPgError, scrubUrl, uniqueViolationToAppError } from './lib/scrub';
import { audit } from './services/audit';
import type { FileStorage } from './services/files';
import { buildSmsSender, type SmsSender } from './services/sms';

/** The Fastify instance with the Zod type provider — route schemas infer req.body/params. */
export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    env: Env;
    reporter: ErrorReporter;
    fileStorage: FileStorage | null;
    sms: SmsSender;
  }
}

export interface BuildAppOptions {
  env: Env;
  db: Db;
  /** Injected in tests; built from env when omitted (see services/files). */
  fileStorage?: FileStorage | null;
}

/**
 * A caller-supplied request id is echoed into every log line and the response
 * header, so it is only accepted in a shape that cannot forge a log entry or
 * smuggle a header (S2-01a).
 */
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export async function buildApp(opts: BuildAppOptions): Promise<App> {
  const log = buildLogger(opts.env.NODE_ENV);
  // Cast: the concrete pino logger generic differs from FastifyBaseLogger in
  // the instance type parameters; behaviour is identical.
  const app = Fastify({
    loggerInstance: log,
    genReqId: (req) => {
      const supplied = req.headers['x-request-id'];
      return typeof supplied === 'string' && REQUEST_ID.test(supplied) ? supplied : randomUUID();
    },
    /**
     * Fastify's own request/response lines carry the full URL, and the URL
     * carries phone numbers (`/members/lookup?phone=…`). `plugins/telemetry`
     * replaces both with one completion line that never sees a query string.
     */
    disableRequestLogging: true,
    /**
     * Which address `req.ip` reports: the peer on the socket, or an entry of
     * `X-Forwarded-For`. Two forms below, and the list wins wherever it is set.
     *
     * BY ADDRESS — `env.TRUST_PROXY_ADDRS`, what the deployments use
     * (SCRUM-367). proxy-addr walks the header from the RIGHT and steps over
     * every entry whose address is on the list, so `req.ip` is the first entry
     * no listed proxy wrote. The list is the platform's internal balancer — the
     * peer on the socket — and Cloudflare's published ranges, because the
     * measurement at 2845135 found one trusted hop reaching Cloudflare's edge
     * and stopping there: callers were filed under the edge that answered them,
     * so one machine held four allowances and everyone behind one edge shared
     * one (SCRUM-353). Only an address list can reach past a proxy safely: a
     * count trusts whatever wrote the entry at that position, so raising it
     * would trust the same position on a request that never passed through
     * Cloudflare at all.
     *
     * BY COUNT — `env.TRUST_PROXY`, for local development and as the fallback
     * with no list set: hop 0 is the socket, hop 1 the last `X-Forwarded-For`
     * entry, and `hop < n` trusts n of them inward. It has to reach Fastify as
     * a FUNCTION. Since fastify@5.12 a NUMBER is failed closed —
     * `getTrustProxyFn` (lib/request.js) returns `function () { return false }`
     * for one, on the reasoning that a hop count cannot validate the immediate
     * peer — so handing over the number built the proxy-aware request and then
     * trusted no hop at all, leaving `req.ip` on the socket address whatever
     * was configured (SCRUM-353).
     *
     * `req.ip` keys the per-IP rate-limit bucket (plugins/rate-limit.ts), the
     * sign-in failure count (services/auth.ts) and the booth and box credential
     * throttles (plugins/credential.ts), so apps/api/test/trust-proxy.test.ts
     * holds this line to the behaviour those depend on.
     */
    trustProxy:
      opts.env.TRUST_PROXY_ADDRS.length > 0
        ? opts.env.TRUST_PROXY_ADDRS
        : opts.env.TRUST_PROXY > 0
          ? (_addr: string, hop: number) => hop < opts.env.TRUST_PROXY
          : false,
  }).withTypeProvider<ZodTypeProvider>() as unknown as App;

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('db', opts.db);
  app.decorate('env', opts.env);
  app.decorate('reporter', buildErrorReporter(opts.env.SENTRY_DSN || undefined, log));
  app.decorate('fileStorage', opts.fileStorage ?? null);
  app.decorate(
    'sms',
    buildSmsSender(
      {
        adapter: opts.env.SMS_ADAPTER,
        twilioAccountSid: opts.env.TWILIO_ACCOUNT_SID || undefined,
        twilioAuthToken: opts.env.TWILIO_AUTH_TOKEN || undefined,
        twilioApiKeySid: opts.env.TWILIO_API_KEY_SID || undefined,
        twilioApiKeySecret: opts.env.TWILIO_API_KEY_SECRET || undefined,
        twilioFrom: opts.env.TWILIO_FROM || undefined,
      },
      log,
    ),
  );

  await app.register(cookie);
  // First, so its onSend and onResponse hooks see every request — including
  // the ones the origin check below refuses before a route is ever chosen.
  await app.register(telemetryPlugin);

  // OpenAPI generated from the zod route schemas (CLAUDE.md §3). The document
  // is collected by this plugin's own onRoute hook, so it is registered before
  // the routes; the route that SERVES it is declared below the guard plugins
  // (SCRUM-254).
  await app.register(swagger, {
    openapi: { info: { title: 'OTO Platform API', version: '0.1.0' } },
    transform: jsonSchemaTransform,
  });

  /**
   * Origin check on state-changing requests (S2-01a). The session cookie is
   * SameSite=Lax, which already stops cross-site form posts, but the POS and
   * the console will be served from sibling Render hosts and one day a real
   * domain — so the rule is stated here rather than left to the cookie.
   * A request with no Origin (server-to-server, curl, the test harness) is
   * allowed; a browser always sends one on a cross-origin write.
   */
  const allowedOrigins = new Set(
    opts.env.ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean),
  );
  const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  app.addHook('onRequest', async (req) => {
    if (!WRITE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (!origin) return;
    if (allowedOrigins.has(origin.replace(/\/$/, ''))) return;
    const host = req.headers.host;
    if (host && origin.replace(/\/$/, '').endsWith(`://${host}`)) return;
    throw new AppError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
  });

  /**
   * Refusals worth a record: an administrator being told "no" is exactly the
   * signal the Login Users panel's "Recent denials" list shows, and the first
   * thing to look at if someone is probing (S2-01a).
   */
  const DENIAL_CODES = new Set([
    'FORBIDDEN',
    /**
     * SCRUM-300 — somebody reaching for the other park, which is the single
     * most interesting thing on that list and was the one refusal missing from
     * it. Every time a refusal has been made more precise, the new code landed
     * outside this set and the event stopped being recorded: SCRUM-266 moved
     * the account writes off `ROLE_NOT_DOMINATED` and SCRUM-264 gave the
     * session-branch switch a code of its own, and both went quiet here. A
     * refusal that says which branch is still a refusal.
     */
    'OUT_OF_BRANCH_SCOPE',
    'ROLE_NOT_DOMINATED',
    'SCOPE_NOT_OWNED',
    'ACCOUNT_NOT_FOUND',
    'SESSION_LOCKED',
    'MUST_CHANGE_PASSWORD',
    'ORIGIN_NOT_ALLOWED',
  ]);

  // Error envelope { error: { code, message, details? } } — CLAUDE.md §3.
  app.setErrorHandler(async (err: unknown, req, reply) => {
    if (err instanceof AppError) {
      // Only for a known caller: anonymous traffic is the rate limiter's
      // problem, and writing a row per anonymous 403 is a free write amplifier.
      if (DENIAL_CODES.has(err.code) && req.auth) {
        try {
          await audit.record(app.db, {
            actorAccountId: req.auth.accountId,
            operatorId: req.auth.operatorId,
            branchId: req.auth.branchId,
            /**
             * A permission the caller simply does not hold is its own event
             * (S2-03): it is the one refusal that means "this person is not
             * set up for this job" rather than "this request was malformed or
             * aimed at someone else's data". The HTTP code stays `FORBIDDEN`
             * either way, so nothing a caller reads changes.
             */
            action:
              err instanceof PermissionDeniedError ? 'auth.permission_denied' : 'access.denied',
            entityType: 'request',
            entityId: req.id,
            after: {
              code: err.code,
              message: err.message,
              method: req.method,
              url: scrubUrl(req.url),
            },
            requestId: req.id,
          });
        } catch (auditErr) {
          // A failed audit write must never turn a 403 into a 500.
          req.log.error({ err: auditErr, reqId: req.id }, 'denial audit failed');
        }
      }
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: 'Request does not match the schema',
          details: err.validation,
        },
      });
    }
    // A unique violation that reached here is a business conflict, not a
    // server fault: 409 with the constraint name — never the value, which is
    // what Postgres puts in `detail` (S2-01a).
    const conflict = uniqueViolationToAppError(err);
    if (conflict) {
      req.log.warn({ pg: scrubPgError(pgErrorOf(err) ?? {}), reqId: req.id }, 'unique violation');
      return reply
        .status(conflict.statusCode)
        .send({ error: { code: conflict.code, message: conflict.message, details: conflict.details } });
    }
    const fe = err as FastifyError;
    if (fe.statusCode && fe.statusCode < 500) {
      return reply
        .status(fe.statusCode)
        .send({ error: { code: fe.code ?? 'BAD_REQUEST', message: fe.message } });
    }
    // Scrubbed both ways: the reporter is an external service, and the log is
    // a hosted stream. A pg error is reduced to its structural fields.
    const safeUrl = scrubUrl(req.url);
    /**
     * Unwrapped, because Drizzle hands us a `DrizzleQueryError` whose `cause`
     * is the database error and whose own fields are the SQL and its bound
     * PARAMETERS — a phone number, a name, a child's note. Asking `isPgError`
     * about the wrapper answered no, and the whole error then went to the
     * reporter and the log with those parameters attached (S2-04).
     */
    const pg = pgErrorOf(err);
    if (pg) {
      app.reporter.report(new Error('database error'), {
        requestId: req.id,
        url: safeUrl,
        pg: scrubPgError(pg),
      });
      req.log.error({ pg: scrubPgError(pg), url: safeUrl, reqId: req.id }, 'request failed');
    } else {
      app.reporter.report(err, { requestId: req.id, url: safeUrl });
      req.log.error({ err, url: safeUrl, reqId: req.id }, 'request failed');
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  await app.register(rateLimitPlugin);
  await app.register(sessionPlugin);
  await app.register(permissionPlugin);
  // Registered after the permission plugin so both see every route below: one
  // installs the session guard a route declares, the other the box credential.
  await app.register(credentialPlugin);
  // Refuse cloud trading before claiming or replaying an HTTP idempotency key.
  await app.register(stationOfflinePlugin);
  await app.register(idempotencyPlugin);

  /**
   * THE OPENAPI DOCUMENT (SCRUM-254) — every path, method, parameter and
   * request body on this api, the admin surface and `/box/v1/*` included. It
   * was served to anyone on the internet: 174 paths, ~190 KB, no cookie.
   *
   * DECLARED HERE, below the plugins, and not beside `app.register(swagger)`
   * above. `permissionPlugin` installs its guard from an `onRoute` hook, and
   * Fastify applies a hook only to routes registered after it — so up there
   * this route got no guard and no entry in `routeRegistry` at all. Adding a
   * permission to it in its old position would have changed nothing, and the
   * enumeration test that walks the registry could never have seen it.
   *
   * `admin:health:read` is the permission the Console's ops pages take: whoever
   * reads how the platform is running reads what it exposes. Anonymous gets the
   * 401 every guarded route gives; a signed-in reception gets 403.
   *
   * GUARDED IN EVERY ENVIRONMENT, deliberately. `NODE_ENV` and `DEPLOY_ENV`
   * both default to their permissive value (`development`, `local`), so a door
   * left open on either stands open on any host that forgets to set one —
   * which is the shape of this defect: it was open by omission, not by
   * decision. A developer reads the document by signing in; `pnpm db:seed`
   * makes a platform admin.
   */
  app.get(
    '/docs/json',
    { config: { permission: 'admin:health:read' }, schema: { hide: true } },
    async () => app.swagger(),
  );

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(meRoutes, { prefix: '/me' });
  await app.register(accountRoutes, { prefix: '/accounts' });
  await app.register(appIdentityRoutes, { prefix: '/admin/apps' });
  await app.register(operatorRoutes, { prefix: '/operators' });
  await app.register(branchRoutes, { prefix: '/branches' });
  await app.register(memberRoutes, { prefix: '/members' });
  await app.register(visitRoutes, { prefix: '/visits' });
  // The counter's half of the booking site (SCRUM-234). `/public/bookings`
  // writes them; these read and redeem them.
  await app.register(bookingRoutes, { prefix: '/bookings' });
  await app.register(saleRoutes, { prefix: '/sales' });
  // A document reception checked for a visitor who is not a member yet
  // (SCRUM-307), so the cart can be priced at that tier without the tier ever
  // being taken from the cart.
  await app.register(saleTierRoutes, { prefix: '/sales' });
  await app.register(catalogRoutes);
  await app.register(branchCloneRoutes);
  // The menu, the modifier library and the discount codes (SCRUM-232). No
  // prefix, like the catalogue it belongs to: its items hang off
  // `/branches/:branchId/menu` and the operator-wide rows off `/menu`.
  await app.register(menuRoutes);
  // No prefix, like the catalogue: the fleet's branch-scoped resources are
  // nested under /branches/:branchId/… and its by-id routes are not, so the
  // paths are declared in full rather than assembled from two places.
  await app.register(fleetRoutes);
  // The station session document (S2-05), beside the fleet for the same
  // reason: its routes hang off `/stations/:id` and `/me`, two prefixes that
  // are already spoken for, so the paths are declared in full.
  await app.register(stationSessionRoutes);
  // Printing (S2-06), beside the fleet and for the same reason: its resources
  // hang off /branches/:branchId, /boxes/:id, /stations/:id and /devices/:id,
  // four prefixes already spoken for, so the paths are declared in full.
  await app.register(printRoutes);
  // Scanning and the shift token (S2-06), declared in full for the same reason
  // the fleet's are: their paths hang off `/stations/:id`, `/me` and `/auth`,
  // three prefixes that are already spoken for.
  await app.register(scanningRoutes);
  await app.register(staffTokenRoutes);
  // The Lucky Wheel (S2-07a): the television's `/booth/*` and the Console's
  // `/booths/:id/status`. Declared in full like the fleet's, because the two
  // halves answer to different callers and share no prefix.
  await app.register(boothRoutes);
  await app.register((await import('./routes/vouchers')).voucherRoutes);
  await app.register((await import('./routes/voucher-definitions')).voucherDefinitionRoutes);
  /**
   * The tender surface (S2-10a): card routing, the inquiry, the audited staff
   * confirmation. Under `/payments` and not `/sales` because `/sales` is the
   * ledger's surface, with its path list and its guards pinned exactly — a
   * tender in flight is not a sale. Empty until the terminal slice lands; the
   * registration is here now so that this file is not reopened for it.
   */
  await app.register(paymentRoutes, { prefix: '/payments' });
  /**
   * What the payment gateway posts to us (S2-10a). Its caller is a machine
   * with no session and its own signature is the authentication, so it sits
   * beside the public routes rather than behind the session plugin.
   */
  await app.register(webhookRoutes, { prefix: '/webhooks' });
  await app.register(auditRoutes, { prefix: '/audit' });
  await app.register(fileRoutes, { prefix: '/files' });
  await app.register(opsRoutes, { prefix: '/ops' });
  // Versioned separately from everything else: a box in a mall is updated on
  // its own schedule, so the one surface that has to stay compatible with a
  // machine nobody can reach says so in its path (S2-04).
  await app.register(boxRoutes, { prefix: '/box/v1' });
  await app.register((await import('./routes/box-booth-staff')).boxBoothStaffRoutes);
  await app.register(publicRoutes);

  return app;
}
