import { createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const QA_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const QA_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let storage: { client: S3Client; bucket: string; prefix: string } | undefined;

/** The worker needs only object storage configuration, without browser/session configuration. */
export function qaStorage(): { client: S3Client; bucket: string; prefix: string } {
  if (storage) return storage;
  const host = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const prefix = process.env.STORAGE_ENV_PREFIX;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const port = Number(process.env.S3_PORT || 443);
  const ssl = process.env.S3_USE_SSL ?? "true";
  if (!host || !/^[a-z0-9.-]+$/i.test(host) || !bucket || !/^[a-z0-9][a-z0-9._-]{1,62}$/i.test(bucket) ||
      !prefix || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(prefix) || !accessKeyId || !secretAccessKey ||
      !Number.isInteger(port) || port < 1 || port > 65535 || !["true", "false"].includes(ssl)) {
    throw new Error("QA private storage is not configured");
  }
  const endpoint = `${ssl === "true" ? "https" : "http"}://${host}:${port}`;
  storage = {
    bucket, prefix,
    client: new S3Client({ endpoint, region: process.env.AWS_REGION || "auto", forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey }, requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 } }),
  };
  return storage;
}

export function validateQaAttachment(buffer: Buffer, contentType: string): void {
  if (!buffer.length || buffer.length > QA_MAX_ATTACHMENT_BYTES) throw new Error("Evidence must be between one byte and 25 MiB");
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  const isWebp = buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  const isMp4 = buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp";
  const isWebm = buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  if (!({ "image/png": isPng, "image/jpeg": isJpeg, "image/webp": isWebp, "video/mp4": isMp4, "video/webm": isWebm } as Record<string, boolean>)[contentType]) {
    throw new Error("Choose a PNG, JPEG, WebP screenshot or an MP4/WebM video matching its file type");
  }
}

export function qaAttachmentKey(tenantId: string, reportId: string, attachmentId: string): string {
  if (![tenantId, reportId, attachmentId].every(value => uuid.test(value))) throw new Error("Invalid evidence reference");
  // Matches buildStorageKey's environment/tenant layout without importing app-wide configuration.
  return `${qaStorage().prefix}/tenants/${tenantId}/qa-reports/${reportId}/${attachmentId}`;
}

function assertPrivateQaKey(objectKey: string): void {
  const prefix = qaStorage().prefix;
  const segments = objectKey.split("/");
  if (segments.length !== 6 || segments[0] !== prefix || segments[1] !== "tenants" || segments[3] !== "qa-reports" ||
      ![segments[2], segments[4], segments[5]].every(value => uuid.test(value))) throw new Error("Invalid evidence reference");
}

export async function putQaAttachment(input: {
  tenantId: string; reportId: string; attachmentId: string; buffer: Buffer; contentType: string; name: string;
}): Promise<{ objectKey: string; sha256: string }> {
  validateQaAttachment(input.buffer, input.contentType);
  const { client, bucket } = qaStorage();
  const objectKey = qaAttachmentKey(input.tenantId, input.reportId, input.attachmentId);
  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: input.buffer,
    ContentType: input.contentType, ContentLength: input.buffer.length, CacheControl: "private, no-store",
    Metadata: { sha256 } }));
  return { objectKey, sha256 };
}

export async function readQaObject(objectKey: string): Promise<Buffer> {
  assertPrivateQaKey(objectKey);
  const { client, bucket } = qaStorage();
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  if (!result.Body) throw new Error("Evidence is unavailable");
  const body = result.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
  return readBoundedQaBody(body, result.ContentLength);
}

export async function readBoundedQaBody(body: AsyncIterable<Uint8Array> & { destroy?: () => void }, contentLength?: number, deadlineMs = 30000): Promise<Buffer> {
  if ((contentLength ?? 0) > QA_MAX_ATTACHMENT_BYTES) { body.destroy?.(); throw new Error("Evidence exceeds its size limit"); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { body.destroy?.(); reject(new Error("Evidence read reached its time limit")); }, Math.max(1, Math.min(30000, deadlineMs)));
  });
  const collect = async () => {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of body) {
      length += chunk.length;
      if (length > QA_MAX_ATTACHMENT_BYTES) throw new Error("Evidence exceeds its size limit");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };
  try {
    return await Promise.race([collect(), deadline]);
  } finally { if (timer) clearTimeout(timer); body.destroy?.(); }
}

export async function deleteQaObject(objectKey: string): Promise<void> {
  assertPrivateQaKey(objectKey);
  const { client, bucket } = qaStorage();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
}
