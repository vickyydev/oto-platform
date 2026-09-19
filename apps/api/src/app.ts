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
import { operatorRoutes } from './routes/operators';
import { branchRoutes } from './routes/branches';
import { memberRoutes } from './routes/members';
import { visitRoutes } from './routes/visits';
import { catalogRoutes } from './routes/catalog';
import { auditRoutes } from './routes/audit';
import { fileRoutes } from './routes/files';
import { publicRoutes } from './routes/public';
import { sessionPlugin } from './plugins/session';
import { idempotencyPlugin } from './plugins/idempotency';
import { rateLimitPlugin } from './plugins/rate-limit';
import { isPgError, scrubPgError, scrubUrl, uniqueViolationToAppError } from './lib/scrub';
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
     * carries phone numbers (`/members/lookup?phone=…`). They are replaced
     * below by one completion line with the query string stripped. S2-03
     * takes this over with the telemetry package.
     */
    disableRequestLogging: true,
    // Cast: Fastify's types omit the documented hop-count form ("trust N hops
    // from the front-facing proxy"), which proxy-addr accepts underneath.
    trustProxy: (opts.env.TRUST_PROXY > 0 ? opts.env.TRUST_PROXY : false) as unknown as boolean,
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
        twilioFrom: opts.env.TWILIO_FROM || undefined,
      },
      log,
    ),
  );

  await app.register(cookie);

  // OpenAPI generated from the zod route schemas (CLAUDE.md §3); JSON at /docs/json.
  await app.register(swagger, {
    openapi: { info: { title: 'OTO Platform API', version: '0.1.0' } },
    transform: jsonSchemaTransform,
  });
  app.get('/docs/json', { schema: { hide: true } }, async () => app.swagger());

  // Request id on every response for log correlation.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
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
   * One completion line per request, with the query string stripped. Phone
   * numbers, verification codes and search terms live in query strings.
   */
  app.addHook('onResponse', async (req, reply) => {
    req.log.info(
      {
        method: req.method,
        url: scrubUrl(req.url),
        statusCode: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
        accountId: req.auth?.accountId,
        reqId: req.id,
      },
      'request completed',
    );
  });

  /**
   * Refusals worth a record: an administrator being told "no" is exactly the
   * signal the Login Users panel's "Recent denials" list shows, and the first
   * thing to look at if someone is probing (S2-01a).
   */
  const DENIAL_CODES = new Set([
    'FORBIDDEN',
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
            action: 'access.denied',
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
      req.log.warn({ pg: scrubPgError(err as never), reqId: req.id }, 'unique violation');
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
    if (isPgError(err)) {
      app.reporter.report(new Error('database error'), {
        requestId: req.id,
        url: safeUrl,
        pg: scrubPgError(err),
      });
      req.log.error({ pg: scrubPgError(err), url: safeUrl, reqId: req.id }, 'request failed');
    } else {
      app.reporter.report(err, { requestId: req.id, url: safeUrl });
      req.log.error({ err, url: safeUrl, reqId: req.id }, 'request failed');
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  await app.register(rateLimitPlugin);
  await app.register(sessionPlugin);
  await app.register(idempotencyPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(meRoutes, { prefix: '/me' });
  await app.register(accountRoutes, { prefix: '/accounts' });
  await app.register(operatorRoutes, { prefix: '/operators' });
  await app.register(branchRoutes, { prefix: '/branches' });
  await app.register(memberRoutes, { prefix: '/members' });
  await app.register(visitRoutes, { prefix: '/visits' });
  await app.register(catalogRoutes);
  await app.register(auditRoutes, { prefix: '/audit' });
  await app.register(fileRoutes, { prefix: '/files' });
  await app.register(publicRoutes);

  return app;
}
