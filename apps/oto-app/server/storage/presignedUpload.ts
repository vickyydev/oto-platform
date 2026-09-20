/**
 * Presigned upload URL generation.
 *
 * Dispatches on OBJECT_STORAGE:
 *   s3     — AWS S3 presigned PUT (IAM role or explicit credentials)
 *   replit — GCS presigned PUT via service account credentials
 *              (GCS_PROJECT_ID, GCS_BUCKET_NAME, GCS_SERVICE_ACCOUNT_JSON)
 *   local  — not applicable; local mode uploads are server-proxied
 */

import { OBJECT_STORAGE } from "../config/env";
import { s3PresignedPut } from "./s3Storage";

export async function presignedUploadUrl(
  storageKey: string,
  mimeType: string,
  expiresInSeconds = 600,
): Promise<string> {
  switch (OBJECT_STORAGE) {
    case "s3": {
      // storageKey is already the full key including prefix
      const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const bucket = process.env.S3_BUCKET!;
      const region = process.env.AWS_REGION || "ap-southeast-1";
      const client = new S3Client({
        region,
        ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
          ? {
              credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
              },
            }
          : {}),
      });
      return getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: storageKey, ContentType: mimeType }),
        { expiresIn: expiresInSeconds },
      );
    }

    case "replit": {
      const projectId = process.env.GCS_PROJECT_ID;
      const bucketName = process.env.GCS_BUCKET_NAME;
      const serviceAccountJson = process.env.GCS_SERVICE_ACCOUNT_JSON;

      if (!projectId || !bucketName || !serviceAccountJson) {
        throw new Error("GCS not configured: GCS_PROJECT_ID, GCS_BUCKET_NAME, and GCS_SERVICE_ACCOUNT_JSON are required");
      }

      const { Storage } = await import("@google-cloud/storage");
      const credentials = JSON.parse(serviceAccountJson);
      const storage = new Storage({ projectId, credentials });
      const [signedUrl] = await storage.bucket(bucketName).file(storageKey).getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + expiresInSeconds * 1000,
        contentType: mimeType,
      });
      return signedUrl;
    }

    case "local":
      throw new Error("Presigned upload URLs are not supported with OBJECT_STORAGE=local");

    default: {
      const _exhaustive: never = OBJECT_STORAGE;
      throw new Error(`Unhandled OBJECT_STORAGE value: ${_exhaustive}`);
    }
  }
}
