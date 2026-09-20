import { S3Client } from "@aws-sdk/client-s3";
import { S3_ENDPOINT, S3_PORT, S3_USE_SSL } from "../config/env";

/**
 * One place decides which bucket, on which host, with which credentials.
 *
 * There were four `S3Client` constructions, none of them with an `endpoint`,
 * and two different bucket variables between them — `S3_BUCKET` in three
 * places and `AWS_S3_BUCKET` (defaulting to a bucket called
 * "oto-studio-files") in the checklist media routes. With no endpoint the SDK
 * addresses AWS S3, and on the old stack an instance role made that work. The
 * platform bucket is Cloudflare R2 and Render has no instance role, so both
 * halves of that arrangement are gone: the endpoint has to be given, and so do
 * the credentials.
 *
 * The second bucket is merged into the first here (intake note 01, §10 item
 * 3). Two variables naming one bucket is the arrangement where checklist
 * photos quietly land somewhere nobody looks.
 */

/**
 * `S3_ENDPOINT` is a bare host — the shape the platform api takes in
 * `MINIO_ENDPOINT`, so one bucket is written the same way in both services.
 * The AWS SDK wants a URL, so the URL is composed here rather than asking a
 * person to write the value two ways. The boot guard refuses a value that
 * already carries a scheme, because that mistake is what took the platform api
 * down on its first deploy.
 */
function endpointUrl(): string | undefined {
  if (!S3_ENDPOINT) return undefined;
  const scheme = S3_USE_SSL ? "https" : "http";
  const defaultPort = S3_USE_SSL ? 443 : 80;
  return S3_PORT === defaultPort
    ? `${scheme}://${S3_ENDPOINT}`
    : `${scheme}://${S3_ENDPOINT}:${S3_PORT}`;
}

/**
 * The region is a signing input, not a location: R2 accepts `auto` and
 * ignores it. It is set explicitly so the SDK never asks the bucket where it
 * lives before signing — the same reason the platform api pins its own.
 */
function region(): string {
  return process.env.AWS_REGION || "auto";
}

export function s3Bucket(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET environment variable is not set");
  return bucket;
}

/**
 * Build a client. Cheap enough to call per request — the SDK's clients hold a
 * connection pool, not a session — but the modules that use it hold one each,
 * as they did before.
 */
export function createS3Client(): S3Client {
  const endpoint = endpointUrl();
  return new S3Client({
    region: region(),
    ...(endpoint
      ? {
          endpoint,
          /**
           * Path style: the bucket goes in the path, not in the hostname. R2,
           * MinIO and S3 all serve it, it needs no wildcard TLS certificate,
           * and it is what the platform api already signs (minio-js defaults
           * to path style against a custom endpoint). A presigned URL from
           * this app and one from the api therefore have the same shape,
           * which matters the first time someone compares two that behave
           * differently.
           */
          forcePathStyle: true,
        }
      : {}),
    ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
}
