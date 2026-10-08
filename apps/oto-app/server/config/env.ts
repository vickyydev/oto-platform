/**
 * Configuration and the boot guard.
 *
 * The app arrived here configured for Replit: the cookie decided by Replit
 * variables, object storage reached through a sidecar on 127.0.0.1, and four
 * secrets that each fall back to a string written into the source. Every one
 * of those fails quietly on Render — the process starts, reports healthy, and
 * only a person clocking in at a kiosk discovers that every kiosk code hashes
 * under "default-kiosk-pepper-change-in-production".
 *
 * So this file does what `apps/api/src/env.ts` does for the platform api: it
 * collects everything that does not belong to this deployment and refuses to
 * start, naming all of the problems at once rather than the first one. The
 * distinction it draws is the same one, and it is worth restating because it
 * is not obvious: NODE_ENV says how the code was BUILT, DEPLOY_ENV says WHERE
 * it is running. Staging runs the production build against throwaway data, so
 * "is this a real deployment" cannot be read off NODE_ENV.
 */

import { readJobsMode, type JobsMode } from "../lib/routeFences";

const APP_ENV = process.env.APP_ENV;
const STORAGE_ENV_PREFIX = process.env.STORAGE_ENV_PREFIX;
const OBJECT_STORAGE = process.env.OBJECT_STORAGE as "local" | "s3";

if (!APP_ENV) {
  throw new Error("APP_ENV environment variable is required. Set APP_ENV=dev for development.");
}

if (!STORAGE_ENV_PREFIX) {
  throw new Error("STORAGE_ENV_PREFIX environment variable is required. Example: dev, staging, prod");
}

if (!OBJECT_STORAGE) {
  throw new Error(
    "OBJECT_STORAGE environment variable is required. " +
    "Allowed values: local, s3"
  );
}

/**
 * `replit` was the third mode and is gone. It spoke to a token sidecar on
 * 127.0.0.1:1106 that exists only inside a Replit container, so off Replit it
 * was not a fallback — it was a mode that could never answer.
 */
if (OBJECT_STORAGE !== "local" && OBJECT_STORAGE !== "s3") {
  throw new Error(
    `OBJECT_STORAGE must be one of: local, s3. Got: "${OBJECT_STORAGE}"`
  );
}

/** `local` on a laptop, `staging` and `production` on Render. */
export type DeployEnv = "local" | "staging" | "production";

const DEPLOY_ENV = ((): DeployEnv => {
  const raw = process.env.DEPLOY_ENV ?? "local";
  if (raw !== "local" && raw !== "staging" && raw !== "production") {
    throw new Error(`DEPLOY_ENV must be one of: local, staging, production. Got: "${raw}"`);
  }
  return raw;
})();

/** True on anything that is not a developer's machine. */
const IS_DEPLOYMENT = DEPLOY_ENV !== "local";

/**
 * Who runs the night work (plan section 5): this process's own timers
 * (`inprocess`, the default and what runs today) or the platform's job
 * runner (`platform`, round 3). Three things read it:
 *   - the scheduler (`startScheduledJobs`): under `platform` it starts no
 *     timer at all;
 *   - the directory job endpoint (`directory/jobRoutes.ts`): under
 *     `inprocess` it refuses in words, so the platform never runs a batch
 *     beside this process's own timers;
 *   - the two manual job triggers (round 1): under `platform` they point at
 *     the Console instead of racing the scheduled run (`lib/routeFences.ts`).
 * Unknown values are a boot problem below, never a silent default.
 */
const OTOAPP_JOBS_RAW = process.env.OTOAPP_JOBS;
const JOBS_MODE: JobsMode = readJobsMode(OTOAPP_JOBS_RAW) ?? "inprocess";

/**
 * A number, or a refusal naming the variable. `parseInt` answers a typo with
 * NaN, and NaN travels: `app.set("trust proxy", NaN)` and a port of NaN both
 * fail somewhere far from the thing that was mistyped.
 */
function wholeNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative whole number. Got: "${raw}"`);
  }
  return value;
}

/**
 * The schema this app's 184 tables live in. The app emits unqualified table
 * names, so the schema is chosen by `search_path` rather than by qualifying
 * every definition; `server/db.ts` puts it on the connection and checks at
 * boot that it resolved. A wrong value here does not misfile a row — it stops
 * the process.
 */
const DB_SCHEMA = process.env.DB_SCHEMA || "otoapp";

/**
 * Proxy hops in front of this container. Render's load balancer is one, and
 * the number matters for more than `req.ip`: express-session refuses to set a
 * `secure` cookie unless the request looks secure, and behind a TLS
 * terminator the only evidence of that is `X-Forwarded-Proto`, which Express
 * reads only when it has been told to trust the proxy. At 0 on Render the app
 * would sign people in and then silently issue no cookie at all.
 */
const TRUST_PROXY = wholeNumber("TRUST_PROXY", process.env.TRUST_PROXY, 1);

/**
 * The bucket host, as a bare host with no scheme and no path — e.g.
 * `<account>.r2.cloudflarestorage.com`. The same shape the platform api takes
 * in `MINIO_ENDPOINT`, deliberately: both services address one bucket, and a
 * value written two different ways in two places is the one that gets pasted
 * into the wrong field at two in the morning. `s3Client.ts` composes the URL
 * the AWS SDK wants from this, the port and the TLS flag.
 *
 * Unset, the SDK addresses AWS S3. That is the quiet failure this variable
 * exists to prevent: on Render there is no bucket at AWS and no instance role
 * to sign with, so the first upload fails somewhere far from the cause.
 */
const S3_ENDPOINT = process.env.S3_ENDPOINT || "";
const S3_PORT = wholeNumber("S3_PORT", process.env.S3_PORT, 443);
const S3_USE_SSL = (process.env.S3_USE_SSL ?? "true") === "true";

/** The values that exist so a fresh checkout runs; never a deployment value. */
const DEV_DEFAULTS = {
  sessionSecret: "contract-sender-secret-key-change-in-production",
  sessionPepper: "default-session-pepper-change-in-production",
  kioskCodePepper: "default-kiosk-pepper-change-in-production",
  pinFingerprintSecret: "default-pin-secret",
} as const;

function assertDevEnv(): void {
  if (APP_ENV !== "dev") {
    throw new Error(`This operation is only allowed in dev environment. Current APP_ENV=${APP_ENV}`);
  }
}

/**
 * Refuse to boot on a configuration that does not belong to this deployment,
 * naming every problem at once rather than the first one — a deploy where four
 * variables are missing should be four lines and one fix, not four rounds of
 * set-one, redeploy, read-the-next.
 *
 * It runs at the bottom of this module rather than from `server/index.ts`, and
 * that is load-bearing. `server/db.ts` builds its connection pool when it is
 * imported and every route file imports it, so by the time any statement in
 * index.ts executes, the database module has already run — and a check placed
 * there would only ever get to speak after something else had already thrown.
 * Importing this module is what db.ts does first, so this is the earliest
 * point in the program that can see the whole configuration.
 */
export function assertProductionSafe(): void {
  const problems: string[] = [];

  if (readJobsMode(OTOAPP_JOBS_RAW) === null) {
    problems.push(`OTOAPP_JOBS must be one of: inprocess, platform (or unset). Got: "${OTOAPP_JOBS_RAW}"`);
  }

  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl) {
    problems.push("DATABASE_URL is not set");
  } else if (IS_DEPLOYMENT && /@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl)) {
    problems.push("DATABASE_URL points at localhost");
  }

  if (IS_DEPLOYMENT) {

    /**
     * Each of these four hashes something that is already in the park: a
     * kiosk activation code, a check-in QR token, an advisor's PIN, a session
     * id. Leaving one at its source default means every deployment that ever
     * ran this code can forge the others' tokens — and because the fallback
     * works perfectly, nothing would ever say so.
     */
    if (!process.env.SESSION_SECRET) {
      problems.push("SESSION_SECRET is not set — sessions and check-in tokens would be signed with a value from the source");
    } else if (process.env.SESSION_SECRET === DEV_DEFAULTS.sessionSecret) {
      problems.push("SESSION_SECRET is the value written in the source");
    }
    if (!process.env.SESSION_PEPPER || process.env.SESSION_PEPPER === DEV_DEFAULTS.sessionPepper) {
      problems.push("SESSION_PEPPER is unset or the value written in the source — kiosk session tokens would be forgeable");
    }
    if (!process.env.KIOSK_CODE_PEPPER || process.env.KIOSK_CODE_PEPPER === DEV_DEFAULTS.kioskCodePepper) {
      problems.push("KIOSK_CODE_PEPPER is unset or the value written in the source — kiosk activation codes would be forgeable");
    }
    if (!process.env.PIN_FINGERPRINT_SECRET || process.env.PIN_FINGERPRINT_SECRET === DEV_DEFAULTS.pinFingerprintSecret) {
      problems.push("PIN_FINGERPRINT_SECRET is unset or the value written in the source — advisor PIN fingerprints would be forgeable");
    }

    if (TRUST_PROXY === 0) {
      problems.push("TRUST_PROXY is 0 — Render terminates TLS in front of the container, so the session cookie would never be set");
    }

    if (OBJECT_STORAGE === "local") {
      problems.push("OBJECT_STORAGE is local — a Render container's disk is discarded on every deploy, so every uploaded file would vanish with it");
    }

    if (OBJECT_STORAGE === "s3") {
      if (!process.env.S3_BUCKET) {
        problems.push("S3_BUCKET is not set");
      }
      if (!S3_ENDPOINT) {
        problems.push(
          "S3_ENDPOINT is not set — without it the SDK addresses AWS S3, and the platform bucket is not at AWS",
        );
      } else if (S3_ENDPOINT.includes("://") || S3_ENDPOINT.includes("/")) {
        /**
         * The same mistake took the platform api down on its first deploy: an
         * endpoint pasted as it appears in a storage console, scheme and all.
         * Named here rather than left to the SDK, which answers a bad
         * endpoint with a URL parse error from inside a signing call.
         */
        problems.push(
          "S3_ENDPOINT is a URL — it must be the bare host, e.g. " +
            "<account>.r2.cloudflarestorage.com, with the scheme in S3_USE_SSL and the port in S3_PORT",
        );
      }
      if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
        problems.push(
          "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not both set — there is no instance role on Render for the SDK to fall back to",
        );
      }
      // A presigned URL is a bearer credential for the object it names, and
      // plain HTTP hands it to anyone on the path.
      if (!S3_USE_SSL) {
        problems.push("S3_USE_SSL is false — presigned upload and download URLs would travel in the clear");
      }
    }

    /**
     * The seed exists so a brand-new empty database has someone to sign in
     * as. Against the shared platform database it is a credential pair in an
     * environment panel that creates an admin the platform never provisioned.
     */
    if (process.env.SEED_ADMIN_EMAIL || process.env.SEED_ADMIN_PASSWORD) {
      problems.push("SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD are set — accounts on a deployment come from the platform, not from a boot-time seed");
    }
  }

  if (DEPLOY_ENV === "production") {
    // Face recognition is an open decision (SPRINT_2_PLAN, decision 29) and
    // the mock path returns the first enrolled employee for any face
    // (face-recognition.ts). Neither belongs in front of a real clock-in.
    if (process.env.USE_AWS_REKOGNITION === "true") {
      problems.push("USE_AWS_REKOGNITION is true — face clock-in is not a settled decision for production");
    }
  }

  if (problems.length) {
    throw new Error(
      `Refusing to start: this configuration does not belong to a ${DEPLOY_ENV} deployment.\n  - ${problems.join("\n  - ")}`,
    );
  }
}

assertProductionSafe();

export {
  APP_ENV,
  DEPLOY_ENV,
  JOBS_MODE,
  STORAGE_ENV_PREFIX,
  OBJECT_STORAGE,
  DB_SCHEMA,
  TRUST_PROXY,
  S3_ENDPOINT,
  S3_PORT,
  S3_USE_SSL,
  assertDevEnv,
};
