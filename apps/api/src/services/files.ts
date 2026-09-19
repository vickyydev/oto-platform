import { Client } from 'minio';
import { AppError } from '../lib/errors';
import type { Env } from '../env';

/**
 * Permission-bound object storage (SCRUM-16, CLAUDE.md §3): MinIO locally,
 * any S3 API on a deployment — Cloudflare R2 today. Objects are NEVER public
 * — access only through short-lived signed URLs issued by the API after a
 * permission check on the owning entity (see routes/files.ts).
 *
 * The api does not create the bucket, here or anywhere else (S2-01d, finding
 * B1). Until now every upload called `ensureBucket()` — a HEAD followed by a
 * PUT of the bucket itself — on the request path. A deployment token is
 * scoped to one bucket with object read and write, which is the correct scope
 * for a service that only ever puts and gets objects, and it cannot create a
 * bucket: R2 answered 403, minio-js turned that into a throw rather than
 * `false`, and reception saw 500 on a profile photo. A bucket is an
 * operational resource that a person creates once. What is left here is a
 * probe that reports on it, called at boot and never during a request.
 */

/**
 * A storage call that never answers is worse than one that fails: it holds a
 * request open, and the database connection behind it, until the OS gives up.
 * Presigning is local arithmetic once the region is fixed (below), so this
 * deadline only ever applies to a call that genuinely leaves the process.
 */
const STORAGE_TIMEOUT_MS = 5_000;

/** What the boot probe found. The three answers need different responses. */
export type StorageProbe =
  | { state: 'ready' }
  | { state: 'no-bucket' }
  | { state: 'unreachable'; reason: string };

export interface FileStorage {
  bucket: string;
  presignedPut(objectKey: string, expirySeconds?: number): Promise<string>;
  presignedGet(objectKey: string, expirySeconds?: number): Promise<string>;
  /** Boot and test probe — deliberately never on the request path. */
  probe(): Promise<StorageProbe>;
}

/**
 * What propagates when storage cannot answer: an AppError, so the route
 * renders the usual envelope instead of an unknown throw becoming a bare 500
 * in front of reception. 503 rather than 400 — the caller did nothing wrong.
 * The reason travels on `cause`, for the log line at the call site that has
 * the request id; it never reaches the caller.
 */
function unavailable(cause: unknown): AppError {
  const err = new AppError(
    503,
    'STORAGE_UNAVAILABLE',
    'File storage is unavailable — try again in a moment',
  );
  (err as { cause?: unknown }).cause = cause;
  return err;
}

/**
 * The short reason behind a storage failure, for our own log: an S3 error
 * code ('AccessDenied', 'NoSuchBucket') where there is one, the message
 * otherwise. Never the endpoint, the key or the signature.
 */
export function storageFailureReason(err: unknown): string {
  const cause = err instanceof AppError ? (err as { cause?: unknown }).cause : err;
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return cause instanceof Error ? cause.message : 'unknown';
}

/** Every call that can leave the process gets a deadline and a clean failure. */
async function bounded<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              unavailable(new Error(`object storage did not answer in ${STORAGE_TIMEOUT_MS}ms`)),
            ),
          STORAGE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    throw err instanceof AppError ? err : unavailable(err);
  } finally {
    clearTimeout(timer);
  }
}

export function buildFileStorage(env: Env): FileStorage {
  const client = new Client({
    endPoint: env.MINIO_ENDPOINT,
    port: env.MINIO_PORT,
    useSSL: env.MINIO_USE_SSL,
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
    /**
     * Fixing the region removes a round trip before every signature: with no
     * region set, minio-js first asks the bucket where it lives
     * (`GET /bucket?location=`) and only then signs. It also removes the
     * question of what that probe would have answered. The default is what
     * the probe already resolved to locally — MinIO answers with no region
     * and minio-js falls back to `us-east-1` — so nothing about a developer's
     * machine changes. R2 wants `auto`, which the deployment sets.
     */
    region: env.MINIO_REGION,
  });
  const bucket = env.MINIO_BUCKET;
  return {
    bucket,
    presignedPut: (objectKey, expirySeconds = 15 * 60) =>
      bounded(() => client.presignedPutObject(bucket, objectKey, expirySeconds)),
    presignedGet: (objectKey, expirySeconds = 5 * 60) =>
      bounded(() => client.presignedGetObject(bucket, objectKey, expirySeconds)),
    async probe() {
      try {
        return (await bounded(() => client.bucketExists(bucket)))
          ? { state: 'ready' }
          : { state: 'no-bucket' };
      } catch (err) {
        // Includes the case where the token may not ask: a bucket-scoped
        // token can be refused a HEAD on the bucket and still read and write
        // every object in it, so this is "could not answer", not "broken".
        return { state: 'unreachable', reason: storageFailureReason(err) };
      }
    },
  };
}
