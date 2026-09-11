import { Client } from 'minio';
import type { Env } from '../env';

/**
 * Permission-bound object storage (SCRUM-16, CLAUDE.md §3): MinIO locally,
 * any S3 API in production. Objects are NEVER public — access only through
 * short-lived signed URLs issued by the API after a permission check on the
 * owning entity (see routes/files.ts).
 */
export interface FileStorage {
  bucket: string;
  ensureBucket(): Promise<void>;
  presignedPut(objectKey: string, expirySeconds?: number): Promise<string>;
  presignedGet(objectKey: string, expirySeconds?: number): Promise<string>;
  /** Test/health probe. */
  reachable(): Promise<boolean>;
}

export function buildFileStorage(env: Env): FileStorage {
  const client = new Client({
    endPoint: env.MINIO_ENDPOINT,
    port: env.MINIO_PORT,
    useSSL: env.MINIO_USE_SSL,
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
  });
  const bucket = env.MINIO_BUCKET;
  return {
    bucket,
    async ensureBucket() {
      if (!(await client.bucketExists(bucket))) {
        await client.makeBucket(bucket);
      }
    },
    presignedPut(objectKey, expirySeconds = 15 * 60) {
      return client.presignedPutObject(bucket, objectKey, expirySeconds);
    },
    presignedGet(objectKey, expirySeconds = 5 * 60) {
      return client.presignedGetObject(bucket, objectKey, expirySeconds);
    },
    async reachable() {
      try {
        await client.bucketExists(bucket);
        return true;
      } catch {
        return false;
      }
    },
  };
}
