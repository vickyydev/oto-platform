/**
 * S3 object storage adapter.
 *
 * Activated when the S3_BUCKET environment variable is set.
 * Provides the same interface used by the rest of the server code
 * (uploadToObjectStorage / getFileFromObjectStorage / deleteFromObjectStorage)
 * but backed by the platform's S3-compatible bucket rather than local disk.
 *
 * Files are stored at:
 *   s3://<S3_BUCKET>/<STORAGE_ENV_PREFIX>/<folder>/<filename>
 *
 * All access is via presigned URLs; the bucket is private.
 */

import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { STORAGE_ENV_PREFIX } from "../config/env";
import { createS3Client } from "./s3Client";
import { Readable } from "stream";

const bucket = process.env.S3_BUCKET!;

// Endpoint, region and credentials all come from s3Client.ts now — the four
// clients in this app pointed at four slightly different configurations, and
// none of them at the platform bucket.
const s3 = createS3Client();

function objectKey(folder: string, filename: string): string {
  return `${STORAGE_ENV_PREFIX}/${folder}/${filename}`;
}

export async function s3Upload(
  buffer: Buffer,
  folder: string,
  filename: string,
  contentType: string,
): Promise<string> {
  const key = objectKey(folder, filename);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  );
  return `/api/files/${folder}/${filename}`;
}

export async function s3Get(
  folder: string,
  filename: string,
): Promise<{ stream: NodeJS.ReadableStream; contentType: string } | null> {
  const key = objectKey(folder, filename);
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const stream = response.Body as Readable;
    return {
      stream,
      contentType: head.ContentType || "application/octet-stream",
    };
  } catch (err: any) {
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

export async function s3Exists(folder: string, filename: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey(folder, filename) }));
    return true;
  } catch (error) {
    const storageError = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (storageError.name === "NotFound" || storageError.name === "NoSuchKey" || storageError.$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}

export interface RangeFileResult {
  stream: NodeJS.ReadableStream;
  contentType: string;
  totalSize: number;
  start: number;
  end: number;
  isPartial: boolean;
}

function parseRangeHeader(rangeHeader: string | undefined, totalSize: number): { start: number; end: number; isPartial: boolean } {
  if (!rangeHeader) return { start: 0, end: totalSize - 1, isPartial: false };
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!match || (!match[1] && !match[2])) return { start: 0, end: totalSize - 1, isPartial: false };
  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
  if (end >= totalSize) end = totalSize - 1;
  if (start > end) start = 0;
  return { start, end, isPartial: true };
}

export async function s3GetRange(
  folder: string,
  filename: string,
  rangeHeader?: string,
): Promise<RangeFileResult | null> {
  const key = objectKey(folder, filename);
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const totalSize = head.ContentLength ?? 0;
    const contentType = head.ContentType || "application/octet-stream";
    const { start, end, isPartial } = parseRangeHeader(rangeHeader, totalSize);
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: isPartial ? `bytes=${start}-${end}` : undefined,
      }),
    );
    const stream = response.Body as Readable;
    return { stream, contentType, totalSize, start, end, isPartial };
  } catch (err: any) {
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

export async function s3Delete(folder: string, filename: string): Promise<boolean> {
  const key = objectKey(folder, filename);
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Presigned URL valid for 1 hour — use for direct browser uploads/downloads */
export async function s3PresignedGet(
  folder: string,
  filename: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const key = objectKey(folder, filename);
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}

export async function s3PresignedPut(
  folder: string,
  filename: string,
  contentType: string,
  expiresInSeconds = 900,
): Promise<string> {
  const key = objectKey(folder, filename);
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: expiresInSeconds },
  );
}

/**
 * Sign a PUT for a key that is already complete — `buildStorageKey` has
 * already put the environment prefix and the tenant on it, so this must not
 * add a second one. Kept separate from `s3PresignedPut` above, which composes
 * a key from a folder and a filename, because silently double-prefixing is the
 * kind of bug that only shows up as a file nobody can find.
 */
export async function s3PresignedPutForKey(
  key: string,
  contentType: string,
  expiresInSeconds = 900,
): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: expiresInSeconds },
  );
}

export const isS3Enabled = !!process.env.S3_BUCKET;
