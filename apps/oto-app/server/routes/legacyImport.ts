import { Storage } from "@google-cloud/storage";
import { db } from "../db";
import { files, tenants, DEFAULT_TENANT_SLUG } from "../../shared/schema";
import { assertDevEnv } from "../config/env";
import { buildStorageKey } from "../storage/objectStorage";
import { eq, and } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import * as mime from "mime-types";

const LEGACY_UPLOADS_DIR = "legacy_uploads/core/uploads";
const SOURCE = "core_legacy";

interface FileInfo {
  filename: string;
  storageKey: string;
}

interface UploadResult {
  uploaded: FileInfo[];
  skipped: FileInfo[];
  failed: { filename: string; storageKey?: string; error: string }[];
}

function getGcsStorage(): { storage: Storage; bucketName: string } {
  const projectId = process.env.GCS_PROJECT_ID;
  const bucketName = process.env.GCS_BUCKET_NAME;
  const serviceAccountJson = process.env.GCS_SERVICE_ACCOUNT_JSON;

  if (!projectId) {
    throw new Error("GCS_PROJECT_ID environment variable is required");
  }
  if (!bucketName) {
    throw new Error("GCS_BUCKET_NAME environment variable is required");
  }
  if (!serviceAccountJson) {
    throw new Error("GCS_SERVICE_ACCOUNT_JSON environment variable is required");
  }

  let credentials;
  try {
    credentials = JSON.parse(serviceAccountJson);
  } catch (e) {
    throw new Error("GCS_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  const storage = new Storage({
    projectId,
    credentials,
  });

  return { storage, bucketName };
}

async function getDefaultTenantId(): Promise<string> {
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
    .limit(1);

  if (!tenant) {
    throw new Error(
      `Default tenant with slug '${DEFAULT_TENANT_SLUG}' not found. Run backfillTenant.ts first.`
    );
  }

  return tenant.id;
}

async function fileExistsInDb(
  tenantId: string,
  storageKey: string
): Promise<boolean> {
  const [existing] = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.tenantId, tenantId), eq(files.storageKey, storageKey)))
    .limit(1);

  return !!existing;
}

async function uploadFileToGcs(
  storage: Storage,
  bucketName: string,
  localPath: string,
  objectName: string,
  contentType: string
): Promise<void> {
  const bucket = storage.bucket(bucketName);

  await bucket.upload(localPath, {
    destination: objectName,
    metadata: {
      contentType,
      cacheControl: "private, max-age=31536000",
    },
  });
}

async function insertFileRecord(
  tenantId: string,
  originalFilename: string,
  storageKey: string,
  mimeType: string | null,
  sizeBytes: number
): Promise<void> {
  await db.insert(files).values({
    tenantId,
    source: SOURCE,
    originalFilename,
    storageKey,
    mimeType,
    sizeBytes,
  });
}

export async function importCoreLegacyUploads(): Promise<UploadResult> {
  assertDevEnv();

  const result: UploadResult = {
    uploaded: [],
    skipped: [],
    failed: [],
  };

  // Validate GCS credentials upfront
  let storage: Storage;
  let bucketName: string;
  try {
    const gcs = getGcsStorage();
    storage = gcs.storage;
    bucketName = gcs.bucketName;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`GCS configuration error: ${msg}`);
  }

  if (!fs.existsSync(LEGACY_UPLOADS_DIR)) {
    console.log(`[LegacyImport] Directory ${LEGACY_UPLOADS_DIR} does not exist. Nothing to import.`);
    return result;
  }

  const tenantId = await getDefaultTenantId();
  console.log(`[LegacyImport] Using tenant ID: ${tenantId}`);
  console.log(`[LegacyImport] GCS bucket: ${bucketName}`);

  const filenames = fs.readdirSync(LEGACY_UPLOADS_DIR);
  console.log(`[LegacyImport] Found ${filenames.length} files to process`);

  for (const filename of filenames) {
    const localPath = path.join(LEGACY_UPLOADS_DIR, filename);

    if (!fs.statSync(localPath).isFile()) {
      continue;
    }

    const storageKey = buildStorageKey(tenantId, [
      "legacy",
      "core",
      "uploads",
      filename,
    ]);

    try {
      if (await fileExistsInDb(tenantId, storageKey)) {
        result.skipped.push({ filename, storageKey });
        console.log(`[LegacyImport] Skipped ${filename} (already exists in DB)`);
        continue;
      }

      const stats = fs.statSync(localPath);
      const mimeType = mime.lookup(filename) || "application/octet-stream";

      console.log(`[LegacyImport] Uploading ${filename} to gs://${bucketName}/${storageKey}...`);
      await uploadFileToGcs(storage, bucketName, localPath, storageKey, mimeType);
      await insertFileRecord(
        tenantId,
        filename,
        storageKey,
        mimeType,
        stats.size
      );

      result.uploaded.push({ filename, storageKey });
      console.log(`[LegacyImport] Uploaded ${filename} -> ${storageKey}`);
    } catch (error: unknown) {
      let errorMessage: string;
      if (error instanceof Error) {
        errorMessage = error.message;
      } else {
        errorMessage = String(error);
      }
      result.failed.push({ filename, storageKey, error: errorMessage });
      console.error(`[LegacyImport] Failed ${filename}: ${errorMessage}`);
    }
  }

  return result;
}
