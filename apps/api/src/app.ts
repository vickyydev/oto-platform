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

export async function buildApp(opts: BuildAppOptions): Promise<App> {
  const log = buildLogger(opts.env.NODE_ENV);
  // Cast: the concrete pino logger generic differs from FastifyBaseLogger in
  // the instance type parameters; behaviour is identical.
  const app = Fastify({
    loggerInstance: log,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    disableRequestLogging: opts.env.NODE_ENV === 'test',
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

  // Error envelope { error: { code, message, details? } } — CLAUDE.md §3.
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
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
    const fe = err as FastifyError;
    if (fe.statusCode && fe.statusCode < 500) {
      return reply
        .status(fe.statusCode)
        .send({ error: { code: fe.code ?? 'BAD_REQUEST', message: fe.message } });
    }
    app.reporter.report(err, { requestId: req.id, url: req.url });
    req.log.error({ err }, 'request failed');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

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
