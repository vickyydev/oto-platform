/**
 * PDF STORAGE – signed contract / letter PDFs
 *
 * Storage backend is selected by the OBJECT_STORAGE environment variable
 * (same as file-storage.ts):
 *   OBJECT_STORAGE=local   – local filesystem under uploads/.private/contracts/
 *   OBJECT_STORAGE=s3      – AWS S3 under <bucket>/<STORAGE_ENV_PREFIX>/.private/contracts/
 *   OBJECT_STORAGE=replit  – Replit GCS sidecar bucket
 *
 * Paths stored in the database:
 *   s3      →  /<bucketId>/<prefix>/.private/contracts/signed_contract_<id>.pdf
 *   local   →  /uploads/.private/contracts/signed_contract_<id>.pdf
 *   replit  →  /<bucketId>/.private/contracts/signed_contract_<id>.pdf
 */

import { OBJECT_STORAGE } from "./config/env";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { objectStorageClient } from "./replit_integrations/object_storage";
import { Readable } from "stream";
import fs from "fs";
import path from "path";

const CONTRACTS_FOLDER = "contracts";
const LETTERS_FOLDER = "letters";

// ── S3 helpers ────────────────────────────────────────────────────────────────

function getS3Client(): S3Client {
  const region = process.env.AWS_REGION || "ap-southeast-1";
  return new S3Client({
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
}

function s3ContractKey(contractId: string): string {
  const prefix = process.env.STORAGE_ENV_PREFIX || "local";
  return `${prefix}/${CONTRACTS_FOLDER}/signed_contract_${contractId}.pdf`;
}

function s3LetterKey(letterId: string): string {
  const prefix = process.env.STORAGE_ENV_PREFIX || "local";
  return `${prefix}/${LETTERS_FOLDER}/signed_letter_${letterId}.pdf`;
}

function s3BucketName(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET environment variable is not set");
  return bucket;
}

// ── Replit helpers ────────────────────────────────────────────────────────────

function replitBucketName(): string {
  const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!bucketId) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");
  return bucketId;
}

function replitContractObjectPath(contractId: string): string {
  return `.private/${CONTRACTS_FOLDER}/signed_contract_${contractId}.pdf`;
}

function replitLetterObjectPath(letterId: string): string {
  return `.private/${LETTERS_FOLDER}/signed_letter_${letterId}.pdf`;
}

// ── local helpers ─────────────────────────────────────────────────────────────

function localContractPath(contractId: string): string {
  return path.join(process.cwd(), "uploads", CONTRACTS_FOLDER, `signed_contract_${contractId}.pdf`);
}

function localContractStoragePath(contractId: string): string {
  return `/uploads/${CONTRACTS_FOLDER}/signed_contract_${contractId}.pdf`;
}

function localLetterPath(letterId: string): string {
  return path.join(process.cwd(), "uploads", LETTERS_FOLDER, `signed_letter_${letterId}.pdf`);
}

function localLetterStoragePath(letterId: string): string {
  return `/uploads/${LETTERS_FOLDER}/signed_letter_${letterId}.pdf`;
}

// ── public API ────────────────────────────────────────────────────────────────

export async function uploadSignedPdf(contractId: string, pdfBuffer: Buffer): Promise<string> {
  switch (OBJECT_STORAGE) {
    case "s3": {
      const bucket = s3BucketName();
      const key = s3ContractKey(contractId);
      await getS3Client().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: pdfBuffer,
          ContentType: "application/pdf",
          Metadata: { contractId, uploadedAt: new Date().toISOString() },
        }),
      );
      return `/${bucket}/${key}`;
    }

    case "local": {
      const p = localContractPath(contractId);
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      await fs.promises.writeFile(p, pdfBuffer);
      console.log("[PdfStorage] Saved locally:", p);
      return localContractStoragePath(contractId);
    }

    case "replit": {
      const bucketId = replitBucketName();
      const objectPath = replitContractObjectPath(contractId);
      const bucket = objectStorageClient.bucket(bucketId);
      await bucket.file(objectPath).save(pdfBuffer, {
        contentType: "application/pdf",
        resumable: false,
        metadata: {
          cacheControl: "private, max-age=31536000",
          metadata: { contractId, uploadedAt: new Date().toISOString() },
        },
      });
      return `/${bucketId}/${objectPath}`;
    }
  }
}

export async function uploadSignedLetterPdf(letterId: string, pdfBuffer: Buffer): Promise<string> {
  switch (OBJECT_STORAGE) {
    case "s3": {
      const bucket = s3BucketName();
      const key = s3LetterKey(letterId);
      await getS3Client().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: pdfBuffer,
          ContentType: "application/pdf",
          Metadata: { letterId, uploadedAt: new Date().toISOString() },
        }),
      );
      return `/${bucket}/${key}`;
    }

    case "local": {
      const p = localLetterPath(letterId);
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      await fs.promises.writeFile(p, pdfBuffer);
      console.log("[PdfStorage] Saved letter locally:", p);
      return localLetterStoragePath(letterId);
    }

    case "replit": {
      const bucketId = replitBucketName();
      const objectPath = replitLetterObjectPath(letterId);
      const bucket = objectStorageClient.bucket(bucketId);
      await bucket.file(objectPath).save(pdfBuffer, {
        contentType: "application/pdf",
        resumable: false,
        metadata: {
          cacheControl: "private, max-age=31536000",
          metadata: { letterId, uploadedAt: new Date().toISOString() },
        },
      });
      return `/${bucketId}/${objectPath}`;
    }
  }
}

export async function streamSignedPdf(storagePath: string): Promise<{
  stream: Readable | null;
  exists: boolean;
  size?: number;
  contentType?: string;
}> {
  switch (OBJECT_STORAGE) {
    case "s3": {
      try {
        const pathWithoutSlash = storagePath.startsWith("/") ? storagePath.slice(1) : storagePath;
        const parts = pathWithoutSlash.split("/");
        const bucket = parts[0];
        const key = parts.slice(1).join("/");

        const head = await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const response = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return {
          stream: response.Body as Readable,
          exists: true,
          size: head.ContentLength,
          contentType: head.ContentType || "application/pdf",
        };
      } catch (err: any) {
        if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") {
          return { stream: null, exists: false };
        }
        console.error("[PdfStorage] S3 stream error:", err);
        return { stream: null, exists: false };
      }
    }

    case "local": {
      const localFilePath = storagePath.startsWith("/uploads")
        ? path.join(process.cwd(), storagePath)
        : storagePath;
      if (!fs.existsSync(localFilePath)) return { stream: null, exists: false };
      const stat = fs.statSync(localFilePath);
      return {
        stream: fs.createReadStream(localFilePath),
        exists: true,
        size: stat.size,
        contentType: "application/pdf",
      };
    }

    case "replit": {
      try {
        const pathWithoutSlash = storagePath.startsWith("/") ? storagePath.slice(1) : storagePath;
        const parts = pathWithoutSlash.split("/");
        if (parts.length < 2) return { stream: null, exists: false };
        const bucketId = parts[0];
        const objectPath = parts.slice(1).join("/");
        const bucket = objectStorageClient.bucket(bucketId);
        const file = bucket.file(objectPath);
        const [exists] = await file.exists();
        if (!exists) return { stream: null, exists: false };
        const [metadata] = await file.getMetadata();
        return {
          stream: file.createReadStream(),
          exists: true,
          size: metadata.size ? Number(metadata.size) : undefined,
          contentType: (metadata.contentType as string) || "application/pdf",
        };
      } catch (error) {
        console.error("[PdfStorage] Replit stream error:", error);
        return { stream: null, exists: false };
      }
    }
  }
}

export async function downloadSignedPdf(storagePath: string): Promise<{ buffer: Buffer; exists: boolean }> {
  const { stream, exists } = await streamSignedPdf(storagePath);
  if (!exists || !stream) return { buffer: Buffer.alloc(0), exists: false };
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve({ buffer: Buffer.concat(chunks), exists: true }));
    stream.on("error", reject);
  });
}

export async function deleteSignedPdf(storagePath: string): Promise<boolean> {
  switch (OBJECT_STORAGE) {
    case "s3": {
      try {
        const pathWithoutSlash = storagePath.startsWith("/") ? storagePath.slice(1) : storagePath;
        const parts = pathWithoutSlash.split("/");
        const bucket = parts[0];
        const key = parts.slice(1).join("/");
        await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch {
        return false;
      }
    }

    case "local": {
      const localFilePath = storagePath.startsWith("/uploads")
        ? path.join(process.cwd(), storagePath)
        : storagePath;
      if (!fs.existsSync(localFilePath)) return true;
      await fs.promises.unlink(localFilePath);
      return true;
    }

    case "replit": {
      try {
        const pathWithoutSlash = storagePath.startsWith("/") ? storagePath.slice(1) : storagePath;
        const parts = pathWithoutSlash.split("/");
        if (parts.length < 2) return false;
        const bucketId = parts[0];
        const objectPath = parts.slice(1).join("/");
        const bucket = objectStorageClient.bucket(bucketId);
        const file = bucket.file(objectPath);
        const [exists] = await file.exists();
        if (!exists) return true;
        await file.delete();
        return true;
      } catch {
        return false;
      }
    }
  }
}

/**
 * Returns true when the stored path belongs to object storage (S3 or Replit)
 * rather than the local filesystem. Used by routes to decide how to serve the file.
 */
export function isObjectStoragePath(storagePath: string): boolean {
  if (!storagePath) return false;
  switch (OBJECT_STORAGE) {
    case "s3": {
      const bucket = process.env.S3_BUCKET;
      return !!bucket && (storagePath.includes(bucket) || storagePath.startsWith(`/${bucket}/`));
    }
    case "replit": {
      const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
      return !!bucketId && (storagePath.includes(bucketId) || storagePath.startsWith(`/${bucketId}/`));
    }
    case "local":
      return false;
  }
}
