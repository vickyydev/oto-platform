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

export function loadEnv(overrides: Partial<Record<keyof Env, string>> = {}): Env {
  return EnvSchema.parse({ ...process.env, ...overrides });
}
