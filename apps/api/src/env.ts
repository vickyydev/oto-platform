import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { parseAppOrigins, parseHandoffKeys } from './services/handoff';
import { parseStaffTokenKey } from './lib/staff-token-key';

// .env lives at the repository root; entrypoints may run from any package cwd.
loadDotenv({ path: join(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

/**
 * `TRUST_PROXY_ADDRS` split into the entries `@fastify/proxy-addr` compiles:
 * one IP address or CIDR block each, in order, with blanks dropped.
 *
 * The check is here for the diagnosis, not the refusal. proxy-addr compiles
 * the list when the Fastify instance is built and throws on a bad entry, so a
 * mistyped block refuses the boot either way — but as a bare
 * `TypeError: invalid range on address` from inside the constructor, with
 * nothing pointing at the variable. Checking here names `TRUST_PROXY_ADDRS`
 * and the offending entry in the message the deploy log shows.
 *
 * Accepted: an address (`10.0.0.1`, `2400:cb00::1`) or an address with a
 * prefix length (`10.0.0.0/8`, `2400:cb00::/32`), the prefix checked against
 * the same bounds proxy-addr applies — 1 to 32 for IPv4 and 1 to 128 for IPv6.
 * NOT accepted, though proxy-addr would take them: its named ranges
 * (`loopback`, `linklocal`, `uniquelocal`) and an IPv4 netmask in place of a
 * prefix length. This variable names the proxies of one deployment, and a
 * shorter vocabulary is one fewer way for a typo to land as something valid.
 */
function parseTrustedProxies(value: string): string[] {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    const slash = entry.lastIndexOf('/');
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const kind = isIP(address);
    if (kind === 0) {
      throw new Error(`"${entry}" is not an IP address or a CIDR block`);
    }
    if (slash !== -1) {
      const prefix = entry.slice(slash + 1);
      const max = kind === 6 ? 128 : 32;
      if (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > max) {
        throw new Error(
          `"${entry}" needs a prefix length between 1 and ${max} for an IPv${kind} block`,
        );
      }
    }
  }

  return entries;
}

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
  /**
   * The SAME failures counted per ADDRESS, and why it is a separate number
   * (SCRUM-376).
   *
   * The address half of the sign-in throttle used to be `AUTH_MAX_FAILURES x
   * 4` — twenty on the deployed five — on the reading that a few tills share
   * one mall address. The measurement on 23 Sep 2026
   * (docs/qa/TRUST_PROXY_REWRITE_MEASUREMENT_2026-09-23.md) found the sharing
   * is very much wider than that: every till, the Console and the launcher
   * reach the api through their own site's `/api/*` rewrite, and the api sees
   * Render's shared regional proxy fleet as the caller. Two apps were measured
   * sharing one egress address and one bucket within the same minute. Twenty
   * mistyped passwords ANYWHERE in the estate therefore locked the whole
   * estate out of signing in for `AUTH_COOLDOWN_SECONDS`.
   *
   * `phone:<phone>` is the bucket that carries the security value here and it
   * is untouched at `AUTH_MAX_FAILURES`: guessing one person's password is
   * still five attempts a window. This one bounds a shared address, so it is
   * sized for a shared address.
   */
  AUTH_MAX_FAILURES_PER_ADDRESS: z.coerce.number().int().default(50),
  AUTH_COOLDOWN_SECONDS: z.coerce.number().int().default(300),
  /** Wrong codes accepted before every outstanding code is invalidated. */
  CODE_MAX_ATTEMPTS: z.coerce.number().int().default(5),
  /**
   * How many proxy hops in front of the api are ours (S2-01a, SCRUM-353).
   * THE FALLBACK: `TRUST_PROXY_ADDRS` below replaces this wherever it is set,
   * which on the deployments is everywhere. This is the local-development
   * form, and the form the api falls back to with no list configured.
   *
   * A COUNT INWARD FROM THE SOCKET. `X-Forwarded-For` is appended left to
   * right, so its rightmost entry is the one the nearest proxy wrote and its
   * leftmost is whatever the original client chose to send. 0 trusts nothing
   * and `req.ip` is the peer on the socket; 1 trusts the socket and so reads
   * the last entry of the header; each further hop reads one entry further
   * left. Every hop counted past the real ones is an entry the caller could
   * have written themselves, which is why this is small and deliberate rather
   * than generous: `req.ip` keys the per-IP rate-limit bucket
   * (plugins/rate-limit.ts) and the sign-in failure count (services/auth.ts).
   *
   * A COUNT CANNOT NAME A PROXY, which is why the deployments do not use one
   * (SCRUM-367): raising it to reach past a proxy trusts whatever wrote the
   * entry at that position, including on a request that never passed through
   * that proxy at all. Left at 1 it is the fail-closed choice — it trusts only
   * the entry the socket peer wrote — and on staging that reached Cloudflare's
   * edge and stopped there, filing every caller under the edge that answered
   * them.
   *
   * IT MUST REACH FASTIFY AS A FUNCTION, NOT AS THIS NUMBER. Since
   * fastify@5.12 a numeric `trustProxy` is failed closed — lib/request.js
   * returns `function () { return false }` for it, because a hop count cannot
   * validate the immediate peer — so a number enables the proxy-aware request
   * and then trusts nothing, and `req.ip` silently falls back to the socket
   * address whatever is set here. app.ts hands it over as the equivalent
   * function; apps/api/test/trust-proxy.test.ts is what keeps that true.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  /**
   * WHICH proxies in front of the api are ours, by address (SCRUM-367).
   * Comma-separated addresses and CIDR blocks; empty means the count above
   * decides instead.
   *
   * Set, it REPLACES the count. Fastify hands the list to `@fastify/proxy-addr`
   * (app.ts), which walks `X-Forwarded-For` from the RIGHT and steps over every
   * entry whose address is on the list, so `req.ip` is the first entry no
   * listed proxy wrote — however many listed proxies are in front of it, and
   * whatever the caller wrote in front of them. An entry only carries weight if
   * the address in it is one of ours, so a request that reached the api without
   * passing through those proxies cannot buy itself a hop.
   *
   * WHAT IT IS FOR. Measured on staging at deploy 2845135 (SCRUM-353's
   * measurement card): with the count at 1 the addresses keying the rate-limit
   * buckets, the per-address sign-in failure count and the booth and box
   * credential throttles were Cloudflare's — one trusted hop reaches the edge
   * that answered the caller, and the caller sits one entry further left. So
   * one machine spent four allowances across four edges while everyone behind
   * one edge shared a single one. The deployments therefore list the platform's
   * internal balancer (the socket peer) and Cloudflare's published ranges; the
   * value, its two sources and the date they were fetched are in render.yaml.
   *
   * A malformed entry refuses the boot here, naming the variable and the
   * entry, rather than as a bare `TypeError` from inside the Fastify
   * constructor.
   */
  TRUST_PROXY_ADDRS: z
    .string()
    .default('')
    .transform((value, ctx): string[] => {
      try {
        return parseTrustedProxies(value);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `TRUST_PROXY_ADDRS: ${(err as Error).message}`,
        });
        return z.NEVER;
      }
    }),
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
   * The Ed25519 private key that signs staff tokens (S2-06), PKCS#8 PEM.
   *
   * Its public half is published to `core.signing_key` at boot and travels to
   * every box in its config bundle, so a box can verify a shift token with no
   * internet and can never mint one. Accepted as a PEM, as a PEM with its
   * newlines escaped `\n`, or base64-encoded whole, because those are the
   * three shapes a deployment dashboard produces.
   *
   * Empty means the mint answers 503 and a till can only unlock online. It is
   * deliberately not generated at boot: a key minted per instance and per
   * restart would stop every outstanding token verifying on the next deploy —
   * including on a till that has been offline since the morning, which is the
   * exact case the token exists for.
   *
   * Generate one with:
   *   openssl genpkey -algorithm ed25519
   */
  STAFF_TOKEN_PRIVATE_KEY: z
    .string()
    .default('')
    .superRefine((value, ctx) => {
      if (!value.trim()) return;
      try {
        parseStaffTokenKey(value);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `STAFF_TOKEN_PRIVATE_KEY: ${(err as Error).message}`,
        });
      }
    }),
  /**
   * How long a shift token lives, in seconds. Default sixteen hours — long
   * enough for an opening-to-closing shift plus the close-down, short enough
   * that a credential left on a disk dies overnight.
   */
  STAFF_TOKEN_TTL_S: z.coerce.number().int().min(300).max(7 * 24 * 3600).optional(),
  /**
   * Whether somebody the box has minted a token for in the last thirty days
   * may unlock offline with their password once their token has expired
   * (S2-06).
   *
   * **Off by default**, which is the acceptance criterion: an expired token is
   * refused with "shift token expired, connect to sign in". Turning it on buys
   * a till that keeps working through an outage longer than a shift, at the
   * price of a password being the only thing between a stolen box and an
   * unlocked till for a month. The unlock is then recorded as
   * `offline_sign_in`, never as `offline_token`.
   */
  STAFF_OFFLINE_SIGN_IN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
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
   * How often the analytics rollup runs (S2-15b): today's figures on Today >
   * Performance and in Radar refresh within this interval, and a day a late
   * fact marked is corrected on the next run.
   */
  ROLLUP_INTERVAL_S: z.coerce.number().int().min(30).default(300),
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
  /**
   * A Twilio Verify service ("VA…") — the Thai-delivery route (OPEN_QUESTIONS
   * §2): Verify generates, sends and checks the code through Twilio's
   * pre-registered senders. Read by the twilio_verify adapter (SCRUM-455),
   * which `buildSmsSender` refuses to construct without it; ignored by every
   * other adapter.
   */
  TWILIO_VERIFY_SERVICE_SID: z.string().optional().or(z.literal('')),
  SENTRY_DSN: z.string().optional().or(z.literal('')),

  /**
   * THE PAYMENT GATEWAY (S2-10a, SCRUM-206, Slice D).
   *
   * `docs/architecture/PAYMENT_GATEWAY.md` §4 is the authority for every name
   * below (`DEVELOPMENT_PLAN.md:1208`) and none of them is to be re-derived
   * from anywhere else. Three rules attach to the whole block:
   *
   *  - **API SERVER ONLY.** Not one of these reaches a box or a browser
   *    (`PAYMENT_GATEWAY.md:762-763`). The customer display renders a QR from a
   *    payload stored on the attempt and never holds a key.
   *  - **`PGW_` replaces the `2C2P_` names earlier drafts used**, because a
   *    leading digit is not shell-safe.
   *  - **Declared even when optional**, so a deployment that sets one gets it
   *    VALIDATED at boot rather than silently ignored — the reason `.env.example`
   *    gives for listing everything (`:82-84`).
   */

  /** `2c2p` or `simulator` — which `QrPayment` is live. See `assertProductionSafe`. */
  PGW_PROVIDER: z.enum(['2c2p', 'simulator']).default('simulator'),
  /** `sandbox` or `production`: picks the hosts and marks every record. */
  PGW_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  /** Payment API host. Empty means the one `PGW_ENV` names. */
  PGW_BASE_URL: z.string().default(''),
  PGW_MERCHANT_ID: z.string().default(''),
  /** The HS256 signing and verifying key. **Secret.** Never logged, never on a page. */
  PGW_SECRET_KEY: z.string().default(''),
  /** Alphabetic, per ISO 4217 — `THB`, never the numeric 764 the 3.x API used. */
  PGW_CURRENCY_CODE: z.string().length(3).default('THB'),
  /** The public HTTPS URL 2C2P posts notifications to — this api's own webhook. */
  PGW_BACKEND_RETURN_URL: z.string().default(''),
  /** Where a browser comes back to after the booking site's hosted page (S2-12). */
  PGW_FRONTEND_RETURN_URL: z.string().default(''),
  /**
   * A token on the webhook URL. **A cheap filter for internet noise and NOT
   * authentication** — said twice in the document, and the JWT signature is
   * what authenticates. **Secret** all the same: a filter everyone knows is
   * not a filter.
   */
  PGW_WEBHOOK_SECRET: z.string().default(''),
  /** `PPQR`. `THQR` is a CATEGORY code in the Payment Option answer and is wrong. */
  PGW_QR_CHANNEL_CODE: z.string().default('PPQR'),
  /** `RAW`, so the display renders the payload itself and needs no outbound internet. */
  PGW_QR_TYPE: z.enum(['ALL', 'RAW', 'BASE64', 'URL']).default('RAW'),
  PGW_PAYMENT_EXPIRY_MIN: z.coerce.number().int().min(1).max(180).default(20),
  /**
   * Up to five characters on the front of every invoice number, so sandbox
   * invoices can never collide with production ones. Empty in production.
   * Refused here rather than at the counter: `buildInvoiceNo` throws on a bad
   * prefix, and the first sale of the day is a poor place to discover it.
   */
  PGW_INVOICE_PREFIX: z
    .string()
    .default('')
    .superRefine((value, ctx) => {
      if (value && !/^[A-Za-z0-9]{1,5}$/.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'PGW_INVOICE_PREFIX: up to five letters or digits, or empty',
        });
      }
    }),
  /**
   * TWO DIALS THAT ARE NOT THE SAME THING, and conflating them is the mistake
   * the plan names:
   *
   *   PGW_INQUIRY_INTERVAL_S  how often a QR still on a display is asked about.
   *   PGW_INQUIRY_MAX_MIN     when asking STOPS.
   *   PAYMENT_PENDING_MIN     ours, not 2C2P's — when an attempt nobody has
   *                           resolved is put on the Failures page. It is much
   *                           shorter than the polling window on purpose: the
   *                           point is to tell somebody at the counter, not to
   *                           wait for the gateway to give up.
   */
  PGW_INQUIRY_INTERVAL_S: z.coerce.number().int().min(1).max(600).default(3),
  PGW_INQUIRY_MAX_MIN: z.coerce.number().int().min(1).max(1440).default(30),
  PAYMENT_PENDING_MIN: z.coerce.number().int().min(1).max(1440).default(10),
  /** The Payment ACTION host — a DIFFERENT host from `PGW_BASE_URL`, not a path on it. */
  PGW_MAINT_BASE_URL: z.string().default(''),
  /** Our RSA private key, PEM. **Secret.** Signs the JWS and decrypts their JWE. */
  PGW_MAINT_PRIVATE_KEY: z.string().default(''),
  /** 2C2P's RSA public key, PEM. Encrypts our JWE and verifies their JWS. */
  PGW_MAINT_2C2P_PUBLIC_KEY: z.string().default(''),
  /**
   * The key every band code is signed with (S2-11) — HMAC-SHA256, see
   * `mintBandCode` in `@oto/shared`. **Secret**: anybody holding it can print
   * a band the gate admits. At least sixteen bytes; a long random string
   * (`openssl rand -base64 32`).
   *
   * Empty on a developer's machine uses a fixed development key
   * (`resolveBandKey`), so a fresh checkout prints bands. Empty on staging
   * means no band is minted — the sale still finalises and its receipt still
   * prints, and the finalise answer says the bands were not issued. Empty on
   * production refuses to boot: a park whose tills cannot issue a band is a
   * park whose gate lets nobody in.
   *
   * It is not generated at boot for the reason `STAFF_TOKEN_PRIVATE_KEY`
   * is not: a key minted per instance would stop every band printed before
   * the next deploy from verifying.
   */
  BAND_HMAC_KEY: z
    .string()
    .default('')
    .superRefine((value, ctx) => {
      if (!value) return;
      if (new TextEncoder().encode(value).length < 16) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'BAND_HMAC_KEY: at least 16 bytes',
        });
      }
    }),
});

export type Env = z.infer<typeof EnvSchema>;

/** The values that exist so a fresh checkout runs; never a production value. */
const DEV_DEFAULTS = {
  minioAccessKey: 'oto',
  minioSecretKey: 'otosecret123',
  /** Signs bands on a developer's machine and in the test suite. Never a deployment's. */
  bandHmacKey: 'oto-local-development-band-key',
} as const;

/**
 * The key bands are signed with here, or null when this deployment cannot
 * mint one (S2-11). See `BAND_HMAC_KEY` for why each case is what it is.
 */
export function resolveBandKey(env: Env): string | null {
  if (env.BAND_HMAC_KEY) return env.BAND_HMAC_KEY;
  return env.DEPLOY_ENV === 'local' ? DEV_BAND_HMAC_KEY : null;
}

/** Exported so a test can mint the code a local deployment would. */
export const DEV_BAND_HMAC_KEY = DEV_DEFAULTS.bandHmacKey;

export interface GatewaySelection {
  provider: '2c2p' | 'simulator';
  /** One sentence for the startup log and the Console card. Never a value. */
  reason: string;
  /** The `PGW_*` names that are unset, by NAME. Never a partial value, never a mask. */
  missingVars: string[];
  /** True when the simulator was chosen by absence rather than by `PGW_PROVIDER`. */
  fellBack: boolean;
}

/**
 * WHICH `QrPayment` THIS DEPLOYMENT RUNS, decided in one place.
 *
 * `PAYMENT_GATEWAY.md:786-788` asks for a missing `PGW_MERCHANT_ID` or
 * `PGW_SECRET_KEY` to **silently select the simulator** so that CI and a fresh
 * checkout never need the sandbox, and says so in the startup log and on the
 * Console's Integrations page.
 *
 * THAT RULE IS NARROWED HERE, deliberately, and the narrowing is the one
 * deviation from the document in this slice. Silent fallback applies on
 * `DEPLOY_ENV` `local` and `staging` only. On a **production** deployment a
 * missing credential REFUSES THE BOOT (`assertProductionSafe` below), because
 * the failure the silent version produces in front of a real branch is the
 * worst one this platform can have: a till that shows a guest a QR code that
 * is not a payment instruction, takes their word for it, and closes the sale.
 * A park would find out at the bank. A service that will not start is a
 * deployment somebody fixes in five minutes.
 *
 * "Silently" also never meant quietly: the fallback is announced at boot and
 * on Integrations in both environments where it is allowed.
 */
export function resolveGatewayProvider(env: Env): GatewaySelection {
  /**
   * THE READS ARE GUARDED BECAUSE NOT EVERY CALLER HANDS THIS A PARSED ENV.
   * `loadEnv` gives both fields a `''` default, so at runtime they are always
   * strings; `assertProductionSafe` is also called directly, and its own tests
   * build a partial `Env` naming only the fields each rule reads. An unguarded
   * `.trim()` there throws a `TypeError` before any refusal is reached, which
   * turns the whole boot guard into a test that cannot fail for the right
   * reason. An absent credential and an empty one are the same fact — there is
   * nothing to be 2C2P with — so both take the same path.
   */
  const missingVars: string[] = [];
  if (!(env.PGW_MERCHANT_ID ?? '').trim()) missingVars.push('PGW_MERCHANT_ID');
  if (!(env.PGW_SECRET_KEY ?? '').trim()) missingVars.push('PGW_SECRET_KEY');

  if (env.PGW_PROVIDER === 'simulator') {
    return {
      provider: 'simulator',
      reason: 'PGW_PROVIDER is simulator — QR payments are pretend, and the Console can drive them.',
      missingVars,
      fellBack: false,
    };
  }
  if (missingVars.length > 0) {
    return {
      provider: 'simulator',
      reason:
        `PGW_PROVIDER is 2c2p but ${missingVars.join(' and ')} ${missingVars.length > 1 ? 'are' : 'is'} unset, ` +
        'so the gateway simulator is running instead. No QR shown here is a real payment instruction.',
      missingVars,
      fellBack: true,
    };
  }
  return {
    provider: '2c2p',
    reason: `2C2P, ${env.PGW_ENV}, channel ${env.PGW_QR_CHANNEL_CODE}.`,
    missingVars,
    fellBack: false,
  };
}

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
    /**
     * A LIVE PARK MUST NEVER QUIETLY RUN A PRETEND GATEWAY (S2-10a).
     *
     * The gateway simulator mints a well-formed EMVCo payload that is
     * deliberately unpayable and then lets the Console mark it paid. On a
     * developer's machine and on staging that is exactly what is wanted. In
     * front of a real counter it is a QR a family scans, a bank that says the
     * merchant is unknown, and a sale the platform will happily close on
     * somebody pressing a button — money not taken, recorded as taken.
     *
     * So production refuses BOTH shapes of it: choosing the simulator
     * explicitly, and choosing 2C2P with nothing to be 2C2P with. The
     * variables are named, never their values.
     */
    /**
     * S2-11 — a live park with no band key issues no bands, and a guest with
     * no band does not get through the gate. The development key is refused
     * for the same reason as the storage defaults: it is in this repository.
     */
    if (!env.BAND_HMAC_KEY) {
      problems.push('BAND_HMAC_KEY is not set — no till could issue a band a gate would admit');
    } else if (env.BAND_HMAC_KEY === DEV_DEFAULTS.bandHmacKey) {
      problems.push('BAND_HMAC_KEY is the development key');
    }
    const gateway = resolveGatewayProvider(env);
    if (gateway.provider === 'simulator') {
      problems.push(
        gateway.fellBack
          ? `PGW_PROVIDER is 2c2p but ${gateway.missingVars.join(' and ')} ${gateway.missingVars.length > 1 ? 'are' : 'is'} unset — ` +
            'the QR tender would fall back to the gateway simulator, which shows guests a code that cannot be paid'
          : 'PGW_PROVIDER is simulator — the QR tender would be pretend on a live branch',
      );
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
