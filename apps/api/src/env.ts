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
   * exist. Everything that must never be true in front of a live branch is
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
   * nothing. On Render this is 1 — the caller's ip is then the first hop the
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
   * the park's team something to play with; `production` starts empty and is
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
  /**
   * Signing region. Set explicitly so the storage client never has to ask the bucket
   * where it lives before signing (S2-01d). The default is what that question
   * already resolved to against local MinIO; Cloudflare R2 wants `auto`.
   */
  MINIO_REGION: z.string().default('us-east-1'),
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
 * Three refusals, because there are three different mistakes:
 *
 *  - ON ANY DEPLOYMENT (`NODE_ENV=production`), a development default. The
 *    failure it prevents is quiet and expensive: a service that starts
 *    happily against the local Postgres, or with the demo object-storage
 *    credentials, and only reveals it once real data is in the wrong place.
 *  - ON PRODUCTION ONLY (`DEPLOY_ENV=production`), anything that makes a
 *    deployment a playground. Staging deliberately carries the demo reset and
 *    the seeded tenant; in front of a real branch each of those is a way to
 *    lose its data. `NODE_ENV` cannot make this distinction — staging IS a
 *    production build — so `DEPLOY_ENV` does.
 *  - ON EVERY DEPLOYMENT, STAGING INCLUDED (`DEPLOY_ENV` other than `local`),
 *    a dependency that only exists on a developer's machine: an SMS adapter
 *    that only writes to the log, or object storage on localhost. Staging is
 *    where people sign up with their real
 *    phones to try the system, so a code that reaches nothing but a log
 *    stream is a person who cannot finish setting up their account — and the
 *    code itself sitting somewhere it must never be. These are properties of
 *    the deployment rather than of the build, which is why they are tested on
 *    `DEPLOY_ENV` and not on `NODE_ENV` (S2-01d, finding B2).
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
      problems.push('OPS_TEST_CONTROLS is true — "Reset demo data" would be live on a real branch');
    }
    if (env.SEED_PROFILE === 'staging') {
      problems.push('SEED_PROFILE is staging — the demo tenant would be seeded into production');
    }
  }

  if (env.DEPLOY_ENV !== 'local') {
    if (env.SMS_ADAPTER === 'console') {
      problems.push(
        'SMS_ADAPTER is console — verification codes would go to the log, not to the phone, ' +
          'so nobody reaching this deployment could finish setting up an account or reset a password',
      );
    }
    /**
     * The endpoint is the variable a deploy is most likely to leave at its
     * default, because it is the one nothing complains about: the api boots
     * clean and healthy, and the first profile photo is what discovers that
     * there is no object storage on this host at all.
     */
    if (env.MINIO_ENDPOINT === 'localhost' || env.MINIO_ENDPOINT === '127.0.0.1') {
      problems.push(
        'MINIO_ENDPOINT is localhost — there is no object storage on a deployment host, ' +
          'so every profile photo would fail against a port nothing answers on',
      );
    }
    /**
     * A host, not a URL: the scheme is MINIO_USE_SSL and the port is
     * MINIO_PORT. Pasting the endpoint as it appears in a storage console
     * takes the api down at boot — the storage client refuses the value before
     * anything of ours runs — so it is named here instead.
     */
    if (env.MINIO_ENDPOINT.includes('://') || env.MINIO_ENDPOINT.includes('/')) {
      problems.push(
        'MINIO_ENDPOINT is a URL — it must be the bare host, e.g. ' +
          '<account>.r2.cloudflarestorage.com, with the scheme in MINIO_USE_SSL and the port in MINIO_PORT',
      );
    }
    /**
     * 9000 is the port the local MinIO container listens on and nothing
     * else. It is also embedded in every presigned URL, so getting it wrong
     * fails in the visitor's browser rather than here.
     */
    if (env.MINIO_PORT === 9000) {
      problems.push(
        'MINIO_PORT is 9000, the local MinIO default — an S3 endpoint over TLS answers on 443',
      );
    }
    // A presigned URL carries its own signature: it is a bearer credential
    // for the object, and plain HTTP hands it to anyone on the path.
    if (!env.MINIO_USE_SSL) {
      problems.push(
        'MINIO_USE_SSL is false — presigned upload and download URLs would travel in the clear',
      );
    }
  }

  if (problems.length) {
    throw new Error(
      `Refusing to start: this configuration does not belong to a ${env.DEPLOY_ENV} deployment.\n  - ${problems.join('\n  - ')}`,
    );
  }
}

export function loadEnv(overrides: Partial<Record<keyof Env, string>> = {}): Env {
  const raw: Record<string, unknown> = { ...process.env, ...overrides };
  /**
   * A test process is not a deployment, and it must never depend on what a
   * developer happens to have in `.env`: real Twilio credentials there would
   * let `pnpm test` send real messages and spend real money, and half-filled
   * ones would stop every test building an app at all, now that a missing
   * credential refuses to boot instead of falling back. The harness swaps in
   * a capturing adapter anyway; a test that wants something else passes it
   * explicitly and that is honoured.
   */
  if (raw.NODE_ENV === 'test') {
    if (overrides.SMS_ADAPTER === undefined) raw.SMS_ADAPTER = 'console';
    if (overrides.DEPLOY_ENV === undefined) raw.DEPLOY_ENV = 'local';
  }
  const env = EnvSchema.parse(raw);
  assertProductionSafe(env);
  return env;
}
