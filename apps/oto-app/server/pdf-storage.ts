/**
 * PDF STORAGE – signed contract / letter PDFs
 *
 * Storage backend is selected by the OBJECT_STORAGE environment variable
 * (same as file-storage.ts):
 *   OBJECT_STORAGE=local   – local filesystem under uploads/.private/contracts/
 *   OBJECT_STORAGE=s3      – the platform bucket, under
 *                            <bucket>/<STORAGE_ENV_PREFIX>/contracts/
 *
 * Paths stored in the database:
 *   s3      →  /<bucket>/<prefix>/contracts/signed_contract_<id>.pdf
 *   local   →  /uploads/contracts/signed_contract_<id>.pdf
 */

import { OBJECT_STORAGE, STORAGE_ENV_PREFIX } from "./config/env";
import type { S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client, s3Bucket } from "./storage/s3Client";
import { Readable } from "stream";
import fs from "fs";
import path from "path";

const CONTRACTS_FOLDER = "contracts";
const LETTERS_FOLDER = "letters";

// ── S3 helpers ────────────────────────────────────────────────────────────────

// One client for the process. It was rebuilt on every call before, which is
// a credential resolution and an endpoint parse per contract PDF.
let s3: S3Client | undefined;
function getS3Client(): S3Client {
  if (!s3) s3 = createS3Client();
  return s3;
}

function s3ContractKey(contractId: string): string {
  return `${STORAGE_ENV_PREFIX}/${CONTRACTS_FOLDER}/signed_contract_${contractId}.pdf`;
}

function s3LetterKey(letterId: string): string {
  return `${STORAGE_ENV_PREFIX}/${LETTERS_FOLDER}/signed_letter_${letterId}.pdf`;
}

function finalizedFilename(contractId: string, version: number): string {
  return `finalized_contract_${contractId}_v${version}.pdf`;
}

const s3BucketName = s3Bucket;

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

export async function uploadFinalizedPdf(contractId: string, version: number, pdfBuffer: Buffer): Promise<string> {
  const filename = finalizedFilename(contractId, version);
  switch (OBJECT_STORAGE) {
    case "s3": {
      const bucket = s3BucketName();
      const key = `${STORAGE_ENV_PREFIX}/${CONTRACTS_FOLDER}/${filename}`;
      await getS3Client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: pdfBuffer, ContentType: "application/pdf" }));
      return `/${bucket}/${key}`;
    }
    case "local": {
      const p = path.join(process.cwd(), "uploads", CONTRACTS_FOLDER, filename);
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      await fs.promises.writeFile(p, pdfBuffer);
      return `/uploads/${CONTRACTS_FOLDER}/${filename}`;
    }
  }
}

/** A short-lived browser URL for a private contract or letter object. */
export async function presignedPdfUrl(storagePath: string, filename: string): Promise<string | null> {
  if (OBJECT_STORAGE !== "s3") return null;
  const bucket = s3BucketName();
  const root = `/${bucket}/${STORAGE_ENV_PREFIX}/`;
  if (!storagePath.startsWith(root)) return null;
  const key = storagePath.slice(`/${bucket}/`.length);
  if (!key.startsWith(`${STORAGE_ENV_PREFIX}/${CONTRACTS_FOLDER}/`) && !key.startsWith(`${STORAGE_ENV_PREFIX}/${LETTERS_FOLDER}/`)) return null;
  try {
    await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    const storageError = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (storageError?.name === "NotFound" || storageError?.name === "NoSuchKey" || storageError?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
  return getSignedUrl(getS3Client(), new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  }), { expiresIn: 300 });
}

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
  }
}

/**
 * Returns true when the stored path belongs to object storage rather than the
 * local filesystem. Used by routes to decide how to serve the file.
 */
export function isObjectStoragePath(storagePath: string): boolean {
  if (!storagePath) return false;
  switch (OBJECT_STORAGE) {
    case "s3": {
      const bucket = process.env.S3_BUCKET;
      return !!bucket && (storagePath.includes(bucket) || storagePath.startsWith(`/${bucket}/`));
    }
    case "local":
      return false;
  }
}
