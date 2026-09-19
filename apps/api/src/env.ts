import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// .env lives at the repository root; entrypoints may run from any package cwd.
loadDotenv({ path: join(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * WHICH deployment this is, as distinct from how the code is built
   * (S2-01c). Staging runs the production build — same bundle, same
   * optimisations, same secure cookie — against throwaway data, so
   * `NODE_ENV` cannot be the thing that decides whether the demo controls
   * exist. Everything that must never be true in front of real customers is
   * gated on this instead.
   */
  DEPLOY_ENV: z.enum(['local', 'staging', 'production']).default('local'),
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
  /**
   * Staging opt-in for the destructive operational controls — today the demo
   * reset (S2-01c). Deliberately its own flag rather than a NODE_ENV test:
   * the staging deployment runs as a production build, so the only honest way
   * to say "this database is a playground" is to say it.
   */
  OPS_TEST_CONTROLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Whether a deploy seeds the demo tenant after migrating. `staging` gives
   * the client something to play with; `production` starts empty and is
   * filled by the real data restore (S2-22).
   */
  SEED_PROFILE: z.enum(['staging', 'production']).default('staging'),
  /**
   * Which roles this process runs (S2-05). One Render service carries all
   * three for the demo; splitting `jobs` out means removing it here, or the
   * runner competes with itself for its own locks.
   */
  PROCESS_ROLES: z.string().default('api'),
  /** Where an alert goes. `console` until the owner names a channel. */
  ALERT_CHANNELS: z.string().default('console'),
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
 * Refuse to boot on a configuration that does not belong to this deployment
 * (S2-01b, extended in S2-01c).
 *
 * Two different refusals, because there are two different mistakes:
 *
 *  - ON ANY DEPLOYMENT (`NODE_ENV=production`), a development default. The
 *    failure it prevents is quiet and expensive: a service that starts
 *    happily against the local Postgres, or with the demo object-storage
 *    credentials, and only reveals it once real data is in the wrong place.
 *  - ON PRODUCTION ONLY (`DEPLOY_ENV=production`), anything that makes a
 *    deployment a playground. Staging deliberately carries the demo reset,
 *    the seeded tenant and an SMS adapter that prints codes to the log; in
 *    front of real customers each of those is a way to lose their data or
 *    their account. `NODE_ENV` cannot make this distinction — staging IS a
 *    production build — so `DEPLOY_ENV` does.
 */
export function assertProductionSafe(env: Env): void {
  const problems: string[] = [];

  if (env.NODE_ENV === 'production') {
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
  }

  if (env.DEPLOY_ENV === 'production') {
    if (env.OPS_TEST_CONTROLS) {
      problems.push('OPS_TEST_CONTROLS is true — "Reset demo data" would be live for real customers');
    }
    if (env.SEED_PROFILE === 'staging') {
      problems.push('SEED_PROFILE is staging — the demo tenant would be seeded into production');
    }
    if (env.SMS_ADAPTER === 'console') {
      problems.push('SMS_ADAPTER is console — verification codes would go to the log, not the customer');
    }
  }

  if (problems.length) {
    throw new Error(
      `Refusing to start: this configuration does not belong to a ${env.DEPLOY_ENV} deployment.\n  - ${problems.join('\n  - ')}`,
    );
  }
}

export function loadEnv(overrides: Partial<Record<keyof Env, string>> = {}): Env {
  const env = EnvSchema.parse({ ...process.env, ...overrides });
  assertProductionSafe(env);
  return env;
}
