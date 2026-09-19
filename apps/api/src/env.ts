import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// .env lives at the repository root; entrypoints may run from any package cwd.
loadDotenv({ path: join(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().optional(),
  API_PORT: z.coerce.number().int().default(3001),
  SESSION_TTL_HOURS: z.coerce.number().default(12),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  AUTH_MAX_FAILURES: z.coerce.number().int().default(5),
  AUTH_COOLDOWN_SECONDS: z.coerce.number().int().default(300),
  /** Wrong codes accepted before every outstanding code is invalidated. */
  CODE_MAX_ATTEMPTS: z.coerce.number().int().default(5),
  /**
   * How many proxy hops in front of the api are ours (S2-01a). 0 = none:
   * `req.ip` is the socket address and a forged X-Forwarded-For changes
   * nothing. On Render this is 1 — the client ip is then the first hop the
   * platform did not add, i.e. the entry before our own.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  /**
   * Browser origins allowed to send state-changing requests. Empty = same
   * origin only (the POS is served through the api's own origin rewrite).
   * Comma-separated, scheme + host + port, no trailing slash.
   */
  ALLOWED_ORIGINS: z.string().default(''),
  /** Secondary per-IP bucket on unauthenticated routes: generous, so one
   *  reception NAT is not locked out by one customer. */
  RATE_LIMIT_IP_MAX: z.coerce.number().int().default(120),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().default(60),
  /** Primary per-phone/per-account bucket on code-issuing routes. */
  RATE_LIMIT_CODE_MAX: z.coerce.number().int().default(5),
  RATE_LIMIT_CODE_WINDOW_SECONDS: z.coerce.number().int().default(900),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().default(24),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().int().default(9000),
  MINIO_USE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MINIO_ACCESS_KEY: z.string().default('oto'),
  MINIO_SECRET_KEY: z.string().default('otosecret123'),
  MINIO_BUCKET: z.string().default('oto-files'),
  SMS_ADAPTER: z.string().default('console'),
  TWILIO_ACCOUNT_SID: z.string().optional().or(z.literal('')),
  TWILIO_AUTH_TOKEN: z.string().optional().or(z.literal('')),
  TWILIO_FROM: z.string().optional().or(z.literal('')),
  SENTRY_DSN: z.string().optional().or(z.literal('')),
});

export type Env = z.infer<typeof EnvSchema>;

/** The values that exist so a fresh checkout runs; never a production value. */
const DEV_DEFAULTS = {
  minioAccessKey: 'oto',
  minioSecretKey: 'otosecret123',
} as const;

/**
 * Refuse to boot in production on a development default (S2-01b).
 *
 * The failure this prevents is quiet and expensive: a service that starts
 * happily against the local Postgres, or with the demo object-storage
 * credentials, and only reveals it when customer data is already in the
 * wrong place. Better to not start at all, loudly, on the deploy.
 */
export function assertProductionSafe(env: Env): void {
  if (env.NODE_ENV !== 'production') return;
  const problems: string[] = [];

  if (!env.DATABASE_URL) {
    problems.push('DATABASE_URL is not set');
  } else if (/@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL)) {
    problems.push('DATABASE_URL points at localhost');
  } else if (/:\/\/oto:oto@/.test(env.DATABASE_URL)) {
    problems.push('DATABASE_URL still carries the development credentials');
  }

  if (env.MINIO_ACCESS_KEY === DEV_DEFAULTS.minioAccessKey) {
    problems.push('MINIO_ACCESS_KEY is the development default');
  }
  if (env.MINIO_SECRET_KEY === DEV_DEFAULTS.minioSecretKey) {
    problems.push('MINIO_SECRET_KEY is the development default');
  }
  if (!env.COOKIE_SECURE) {
    problems.push('COOKIE_SECURE is false — the session cookie would travel in the clear');
  }

  if (problems.length) {
    throw new Error(
      `Refusing to start in production with development configuration:\n  - ${problems.join('\n  - ')}`,
    );
  }
}

export function loadEnv(overrides: Partial<Record<keyof Env, string>> = {}): Env {
  const env = EnvSchema.parse({ ...process.env, ...overrides });
  assertProductionSafe(env);
  return env;
}
