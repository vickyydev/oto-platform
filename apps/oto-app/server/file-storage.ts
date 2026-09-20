/**
 * FILE STORAGE UTILITY - PERMANENT CLOUD STORAGE
 * ================================================
 *
 * All file uploads in this application MUST use these functions.
 *
 * Storage backend is selected by the OBJECT_STORAGE environment variable:
 *   OBJECT_STORAGE=local   – local filesystem under uploads/ (Tilt / local dev)
 *   OBJECT_STORAGE=s3      – AWS S3 (App Runner / production)
 *   OBJECT_STORAGE=replit  – Replit GCS sidecar (legacy Replit hosting)
 *
 * OBJECT_STORAGE MUST be set; there is no default. Startup will fail without it.
 *
 * USAGE:
 *   import { uploadToObjectStorage, getFileFromObjectStorage, deleteFromObjectStorage } from "./file-storage";
 *
 *   // Upload: Returns URL like "/api/files/folder/filename.jpg"
 *   const url = await uploadToObjectStorage(buffer, "folder-name", "filename.jpg", "image/jpeg");
 *
 *   // Retrieve: Returns { stream, contentType } or null if not found
 *   const file = await getFileFromObjectStorage("folder-name", "filename.jpg");
 *
 *   // Delete: Removes file from storage
 *   await deleteFromObjectStorage("folder-name", "filename.jpg");
 *
 * MULTER CONFIG:
 *   Always use: multer({ storage: multer.memoryStorage() })
 *   NEVER use:  multer({ storage: multer.diskStorage(...) })
 */

import { OBJECT_STORAGE } from "./config/env";
import { s3Upload, s3Get, s3Delete, s3GetRange, type RangeFileResult } from "./storage/s3Storage";
import { objectStorageClient, ObjectStorageService } from "./replit_integrations/object_storage/objectStorage";
import fs from "fs";
import path from "path";
import { Readable } from "stream";

export type { RangeFileResult };

// ── local helpers ─────────────────────────────────────────────────────────────

const CONTENT_TYPE_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

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

function localPath(folder: string, filename: string): string {
  return path.join(process.cwd(), "uploads", folder, filename);
}

async function localUpload(
  buffer: Buffer,
  folder: string,
  filename: string,
): Promise<string> {
  const dir = path.join(process.cwd(), "uploads", folder);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(localPath(folder, filename), buffer);
  console.log(`[FileStorage] Saved locally: uploads/${folder}/${filename}`);
  return `/api/files/${folder}/${filename}`;
}

async function localGet(
  folder: string,
  filename: string,
): Promise<{ stream: NodeJS.ReadableStream; contentType: string } | null> {
  const p = localPath(folder, filename);
  if (!fs.existsSync(p)) return null;
  const ext = path.extname(filename).toLowerCase();
  return {
    stream: fs.createReadStream(p),
    contentType: CONTENT_TYPE_MAP[ext] ?? "application/octet-stream",
  };
}

async function localGetRange(
  folder: string,
  filename: string,
  rangeHeader?: string,
): Promise<RangeFileResult | null> {
  const p = localPath(folder, filename);
  if (!fs.existsSync(p)) return null;
  const stat = await fs.promises.stat(p);
  const ext = path.extname(filename).toLowerCase();
  const contentType = CONTENT_TYPE_MAP[ext] ?? "application/octet-stream";
  const { start, end, isPartial } = parseRangeHeader(rangeHeader, stat.size);
  return {
    stream: fs.createReadStream(p, { start, end }),
    contentType,
    totalSize: stat.size,
    start,
    end,
    isPartial,
  };
}

async function localDelete(folder: string, filename: string): Promise<boolean> {
  const p = localPath(folder, filename);
  if (!fs.existsSync(p)) return false;
  await fs.promises.unlink(p);
  return true;
}

// ── replit helpers ────────────────────────────────────────────────────────────

function parseObjectPath(storagePath: string): { bucketName: string; objectName: string } {
  if (!storagePath.startsWith("/")) storagePath = `/${storagePath}`;
  const parts = storagePath.split("/");
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

async function replitUpload(
  buffer: Buffer,
  folder: string,
  filename: string,
  contentType: string,
): Promise<string> {
  const objectStorageService = new ObjectStorageService();
  const publicPaths = objectStorageService.getPublicObjectSearchPaths();

  if (publicPaths.length === 0) {
    throw new Error("No public object storage paths configured (PUBLIC_OBJECT_SEARCH_PATHS)");
  }

  const { bucketName, objectName: basePath } = parseObjectPath(publicPaths[0]);
  const objectName = basePath ? `${basePath}/${folder}/${filename}` : `${folder}/${filename}`;

  const bucket = objectStorageClient.bucket(bucketName);
  await bucket.file(objectName).save(buffer, {
    contentType,
    metadata: { folder, uploadedAt: new Date().toISOString() },
  });

  console.log(`[FileStorage] Uploaded to Replit object storage: ${objectName}`);
  return `/api/files/${folder}/${filename}`;
}

async function replitGet(
  folder: string,
  filename: string,
): Promise<{ stream: NodeJS.ReadableStream; contentType: string } | null> {
  const objectStorageService = new ObjectStorageService();
  const publicPaths = objectStorageService.getPublicObjectSearchPaths();

  for (const publicPath of publicPaths) {
    const { bucketName, objectName: basePath } = parseObjectPath(publicPath);
    const objectName = basePath ? `${basePath}/${folder}/${filename}` : `${folder}/${filename}`;
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    try {
      const [exists] = await file.exists();
      if (exists) {
        const [metadata] = await file.getMetadata();
        return {
          stream: file.createReadStream() as unknown as NodeJS.ReadableStream,
          contentType: (metadata.contentType as string) || "application/octet-stream",
        };
      }
    } catch (err) {
      console.error(`[FileStorage] Replit bucket error for ${objectName}:`, err);
    }
  }
  return null;
}

async function replitGetRange(
  folder: string,
  filename: string,
  rangeHeader?: string,
): Promise<RangeFileResult | null> {
  const objectStorageService = new ObjectStorageService();
  const publicPaths = objectStorageService.getPublicObjectSearchPaths();

  for (const publicPath of publicPaths) {
    const { bucketName, objectName: basePath } = parseObjectPath(publicPath);
    const objectName = basePath ? `${basePath}/${folder}/${filename}` : `${folder}/${filename}`;
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    try {
      const [exists] = await file.exists();
      if (exists) {
        const [metadata] = await file.getMetadata();
        const totalSize = Number(metadata.size) || 0;
        const contentType = (metadata.contentType as string) || "application/octet-stream";
        const { start, end, isPartial } = parseRangeHeader(rangeHeader, totalSize);
        return {
          stream: file.createReadStream({ start, end }) as unknown as NodeJS.ReadableStream,
          contentType,
          totalSize,
          start,
          end,
          isPartial,
        };
      }
    } catch (err) {
      console.error(`[FileStorage] Replit bucket error for ${objectName}:`, err);
    }
  }
  return null;
}

async function replitDelete(folder: string, filename: string): Promise<boolean> {
  const objectStorageService = new ObjectStorageService();
  const publicPaths = objectStorageService.getPublicObjectSearchPaths();

  for (const publicPath of publicPaths) {
    const { bucketName, objectName: basePath } = parseObjectPath(publicPath);
    const objectName = basePath ? `${basePath}/${folder}/${filename}` : `${folder}/${filename}`;
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    const [exists] = await file.exists();
    if (exists) {
      await file.delete();
      console.log(`[FileStorage] Deleted from Replit object storage: ${objectName}`);
      return true;
    }
  }
  return false;
}

// ── public API ────────────────────────────────────────────────────────────────

export async function uploadToObjectStorage(
  buffer: Buffer,
  folder: string,
  filename: string,
  contentType: string = "image/jpeg",
): Promise<string> {
  switch (OBJECT_STORAGE) {
    case "s3":     return s3Upload(buffer, folder, filename, contentType);
    case "local":  return localUpload(buffer, folder, filename);
    case "replit": return replitUpload(buffer, folder, filename, contentType);
  }
}

export async function getFileFromObjectStorage(
  folder: string,
  filename: string,
): Promise<{ stream: NodeJS.ReadableStream; contentType: string } | null> {
  switch (OBJECT_STORAGE) {
    case "s3":     return s3Get(folder, filename);
    case "local":  return localGet(folder, filename);
    case "replit": return replitGet(folder, filename);
  }
}

export async function deleteFromObjectStorage(
  folder: string,
  filename: string,
): Promise<boolean> {
  switch (OBJECT_STORAGE) {
    case "s3":     return s3Delete(folder, filename);
    case "local":  return localDelete(folder, filename);
    case "replit": return replitDelete(folder, filename);
  }
}

/**
 * Same as getFileFromObjectStorage, but supports HTTP Range requests
 * (used for video streaming so playback can start without downloading
 * the whole file first).
 */
export async function getFileRangeFromObjectStorage(
  folder: string,
  filename: string,
  rangeHeader?: string,
): Promise<RangeFileResult | null> {
  switch (OBJECT_STORAGE) {
    case "s3":     return s3GetRange(folder, filename, rangeHeader);
    case "local":  return localGetRange(folder, filename, rangeHeader);
    case "replit": return replitGetRange(folder, filename, rangeHeader);
  }
}
