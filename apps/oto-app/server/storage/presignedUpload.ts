/**
 * Presigned upload URL generation.
 *
 * Dispatches on OBJECT_STORAGE:
 *   s3     — presigned PUT against the platform bucket
 *   local  — not applicable; local mode uploads are server-proxied
 *
 * The third mode was `replit`, a presigned PUT against a Google Cloud bucket
 * reached through a service-account JSON in an environment variable. It is
 * gone with the rest of the Replit hosting: there is one bucket now, and it is
 * the platform's.
 */

import { OBJECT_STORAGE } from "../config/env";
import { s3PresignedPutForKey } from "./s3Storage";

export async function presignedUploadUrl(
  storageKey: string,
  mimeType: string,
  expiresInSeconds = 600,
): Promise<string> {
  switch (OBJECT_STORAGE) {
    // storageKey is already the full key including prefix. s3Storage owns the
    // client, so the endpoint and credentials are resolved in one place rather
    // than constructed again here.
    case "s3":
      return s3PresignedPutForKey(storageKey, mimeType, expiresInSeconds);

    case "local":
      throw new Error("Presigned upload URLs are not supported with OBJECT_STORAGE=local");

    default: {
      const _exhaustive: never = OBJECT_STORAGE;
      throw new Error(`Unhandled OBJECT_STORAGE value: ${_exhaustive}`);
    }
  }
}
