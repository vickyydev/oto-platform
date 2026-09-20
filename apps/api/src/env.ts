import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { parseAppOrigins, parseHandoffKeys } from './services/handoff';

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
   * The suite hand-off signing keyring (S2-02): comma-separated
   * `<kid>:<secret>` entries, **newest first** — the first signs, the rest
   * still verify. Rotation is the same expand/contract as a migration:
   * prepend the new key, deploy, and drop the old entry once nothing alive
   * can still be carrying it (one token lifetime).
   *
   * Empty means the launcher hand-off is unavailable and both routes answer
   * 503. That is deliberate: a key minted at boot would differ between
   * instances and between restarts, and a key nobody chose is a key nobody
   * can rotate.
   */
  HANDOFF_SIGNING_KEY: z
    .string()
    .default('')
    .superRefine((value, ctx) => {
      if (!value) return;
      try {
        parseHandoffKeys(value);
      } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `HANDOFF_SIGNING_KEY: ${(err as Error).message}` });
      }
    }),
  /**
   * Where each app lives, as `<app>=<origin>` pairs. The exchange compares
   * the request's `Origin` with the one recorded when the token was signed,
   * so a token for the till cannot be spent on the console. Each origin here
   * must also appear in `ALLOWED_ORIGINS`, or the write is refused before it
   * reaches the route.
   */
  HANDOFF_APP_ORIGINS: z
    .string()
    .default('')
    .superRefine((value, ctx) => {
      if (!value) return;
      try {
        parseAppOrigins(value);
      } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `HANDOFF_APP_ORIGINS: ${(err as Error).message}` });
      }
    }),
  /**
   * How long a hand-off lives. Long enough to carry a browser from one origin
   * to another, short enough that a token left in someone's history is worth
   * nothing by the time it is read.
   */
  HANDOFF_TOKEN_TTL_S: z.coerce.number().int().min(5).max(600).default(60),
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
  /**
   * Where an alert goes. `console` until the owner names a channel
   * (OPEN_QUESTIONS §4). A name with no implementation on this build stops the
   * process at boot rather than delivering nowhere — an alert channel that
   * silently swallows alerts is the exact failure S2-03 exists to make
   * impossible.
   */
  ALERT_CHANNELS: z.string().default('console'),
  /**
   * How often the watchdog compares what should have run with what did
   * (S2-03). Everything else records what happened; this is the only check
   * that can notice a silence, so it runs often and cheaply.
   */
  WATCHDOG_INTERVAL_S: z.coerce.number().int().min(5).default(60),
  /** How often the sweeps run: expired idempotency keys, hand-off tokens, old runs. */
  HOUSEKEEPING_INTERVAL_S: z.coerce.number().int().min(60).default(3600),
  /**
   * A condition that clears and comes back inside this window reuses its alert
   * row and is not delivered again. Something flipping every minute must not
   * put sixty messages in front of whoever is on shift: the reliable response
   * to that is to mute the channel, which is worse than the flapping.
   */
  ALERT_FLAP_WINDOW_S: z.coerce.number().int().min(0).default(300),
  /** Failures in a row before a run that keeps failing raises an alert. */
  ALERT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(3),
  /**
   * How long `ops_run` rows and resolved alerts are kept. This table grows
   * faster than anything else in the database — one row per failed request,
   * job run and device call — so it prunes itself from the day it exists.
   * `audit_log` is the permanent record and is never swept.
   */
  OPS_RUN_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  /**
   * The sync core's four dials (S2-05).
   *
   * Declared here so a deployment that sets one gets it VALIDATED at boot
   * rather than silently ignored, and so `.env.example` and the blueprint have
   * one list to work from. The defaults deliberately live in `syncSettings()`
   * in `services/sync.ts` and not here as well: `fleetHealth` and the watchdog
   * read them without an `Env` in hand — the same shape `boxSettings()` has —
   * and a number written in two places is a number that will one day disagree
   * with itself.
   *
   *   SYNC_EVENT_RETENTION_DAYS    how long `edge.sync_event` is kept (365).
   *                                Dedupe does NOT depend on it: `sync_cursor`
   *                                is never swept, so an event past the window
   *                                is still recognisably a replay.
   *   SYNC_CHANGE_RETENTION_DAYS   how long a delta stays on the feed (30). A
   *                                box away longer takes a whole bundle.
   *   STATION_EVENT_RETENTION_DAYS the tape of one station's afternoon (30).
   *                                Telemetry, not record.
   *   SYNC_STALE_AFTER_S           a box calling home whose oldest unsynced
   *                                event is older than this is not syncing
   *                                (300) — quieter than silence, and the fault
   *                                with money behind it.
   */
  SYNC_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).optional(),
  SYNC_CHANGE_RETENTION_DAYS: z.coerce.number().int().min(1).optional(),
  STATION_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).optional(),
  SYNC_STALE_AFTER_S: z.coerce.number().int().min(30).optional(),
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
  /** Always required with the twilio adapter: it names the account in the URL path. */
  TWILIO_ACCOUNT_SID: z.string().optional().or(z.literal('')),
  /**
   * Two credential shapes, one of which must be complete (`buildSmsSender`
   * refuses to construct a sender otherwise). The API key is the one to use:
   * it is revoked and rotated on its own, so replacing this deployment's
   * credential is not an event for every other integration on the account,
   * and a Standard key cannot manage keys or change the account. The account
   * auth token is the account's master password and is kept only as the
   * fallback for an account that has not issued a key.
   */
  TWILIO_API_KEY_SID: z.string().optional().or(z.literal('')),
  TWILIO_API_KEY_SECRET: z.string().optional().or(z.literal('')),
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
    // Same reason, for the hand-off keyring (S2-02): a real signing key in a
    // developer's `.env` would mint tokens a test then treats as evidence,
    // and a half-written one would stop every test building an app at all.
    // The suite supplies its own where it needs one.
    if (overrides.HANDOFF_SIGNING_KEY === undefined) raw.HANDOFF_SIGNING_KEY = '';
    if (overrides.HANDOFF_APP_ORIGINS === undefined) raw.HANDOFF_APP_ORIGINS = '';
  }
  const env = EnvSchema.parse(raw);
  assertProductionSafe(env);
  return env;
}
