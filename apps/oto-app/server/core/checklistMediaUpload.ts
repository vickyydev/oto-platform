import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Transform, Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import type { Request } from "express";
import type { StorageEngine } from "multer";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

/**
 * A checklist photo or video sent through the app server (SCRUM-850).
 *
 * The browser sends reference media here whenever the bucket refuses its
 * direct upload, which on staging is every time. The route used to keep the
 * whole file in memory, 200 MB for a video, once for every upload in flight.
 * It now passes through: the file is written to a temporary file as it
 * arrives, counted and checksummed on the way, then read back as a stream
 * into the bucket and removed. Nothing here decides who may upload or where a
 * file goes; the route's own checks do, exactly as before.
 *
 * It is two hops, not one, because the bucket wants the length before the
 * first byte and a multipart form does not say how long its file is. The
 * count made here is the length the bucket is told, so a browser cannot
 * declare one size and send another.
 */

/** What the storage below adds to multer's file: no `buffer`, ever. */
export type TempUploadFile = Express.Multer.File & {
  /** CRC-32 of the stored bytes, base64 of its four big-endian bytes. */
  checksumCrc32?: string;
};

/** Where an upload waits between the browser and the bucket. */
export function uploadTempDir(): string {
  return path.join(os.tmpdir(), "oto-checklist-media");
}

/** A temporary file this old belongs to a process that stopped mid-upload. */
const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Remove what a stopped process left behind. An upload being written has a
 * fresh modified time however slow its connection is, so age alone is safe
 * when two processes share the folder. Never throws.
 */
export async function removeStaleUploads(dir = uploadTempDir(), now = Date.now()): Promise<number> {
  let removed = 0;
  try {
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith(".upload")) continue;
      const file = path.join(dir, name);
      try {
        if (now - (await fs.stat(file)).mtimeMs < STALE_AFTER_MS) continue;
        await fs.unlink(file);
        removed++;
      } catch {
        // Gone already, or another process holds it: not ours to settle.
      }
    }
  } catch {
    // No folder yet means nothing was left behind.
  }
  return removed;
}

const sweptDirs = new Set<string>();

async function removeQuietly(file: string | null | undefined): Promise<void> {
  if (!file) return;
  try {
    await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[ChecklistMedia] temporary upload not removed:", (error as NodeJS.ErrnoException).code);
    }
  }
}

/** Close the file a received upload was being written to, then remove it. */
async function discard(sink: Writable | null, file: string | null): Promise<void> {
  if (sink && !sink.closed) {
    await new Promise<void>((resolve) => {
      sink.once("close", () => resolve());
      sink.destroy();
    });
  }
  await removeQuietly(file);
}

function crc32Base64(value: number): string {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes.toString("base64");
}

const mimeTypeOfUpload = new WeakMap<object, string>();

/** The content type the browser gave the file part of this request, if one arrived. */
export function uploadMimeType(req: Request): string | undefined {
  return mimeTypeOfUpload.get(req);
}

async function receive(
  req: Request,
  source: Readable,
  limit: number,
  dir: string,
): Promise<Partial<TempUploadFile>> {
  // The browser went away mid-upload: multer hears nothing of it and would
  // wait on this file for ever, with the part already written left behind.
  const interrupted = new AbortController();
  const onClose = () => {
    if (!req.complete) interrupted.abort();
  };
  // The file passed the route's largest allowance. The form parser stops
  // handing bytes over but keeps the stream open to the end of the part, so
  // without this the refusal would wait for the whole of an endless file.
  const onLimit = () => interrupted.abort();
  req.once("close", onClose);
  source.once("limit", onLimit);

  let tempPath: string | null = null;
  let sink: Writable | null = null;
  try {
    if (req.destroyed && !req.complete) interrupted.abort();
    let size = 0;
    let checksum = 0;
    let overLimit = false;
    if (limit > 0) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      if (!sweptDirs.has(dir)) {
        sweptDirs.add(dir);
        void removeStaleUploads(dir);
      }
      // Opened here, not by the stream: a stream destroyed before it has
      // opened its file can still create it after the clean-up has looked.
      const created = path.join(dir, `${randomUUID()}.upload`);
      const handle = await fs.open(created, "wx", 0o600);
      tempPath = created;
      sink = handle.createWriteStream();
    }
    // Counts every byte, and lets through only what this type may store. A
    // type the route refuses has a limit of nothing and writes no file; a
    // photo past its limit stops being written where the limit is. Both are
    // still counted to the end, so the route answers them as it always has.
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (overLimit || size > limit) {
          overLimit = true;
          return done();
        }
        checksum = crc32(chunk, checksum);
        done(null, chunk);
      },
    });
    await pipeline(
      source,
      counter,
      sink ?? new Writable({ write: (_chunk, _encoding, done) => done() }),
      { signal: interrupted.signal },
    );
    if (overLimit || !tempPath) {
      await discard(sink, tempPath);
      return { size };
    }
    return {
      destination: dir,
      filename: path.basename(tempPath),
      path: tempPath,
      size,
      checksumCrc32: crc32Base64(checksum),
    };
  } catch (error) {
    await discard(sink, tempPath);
    throw error;
  } finally {
    req.off("close", onClose);
    source.off("limit", onLimit);
  }
}

/**
 * multer storage that never holds a file in memory. `limitFor` gives the most
 * bytes a content type may store, or 0 for a type the route refuses.
 */
export function tempFileStorage(limitFor: (mimeType: string) => number, dir: () => string = uploadTempDir): StorageEngine {
  return {
    _handleFile(req, file, callback) {
      mimeTypeOfUpload.set(req, file.mimetype);
      receive(req, file.stream, limitFor(file.mimetype), dir()).then(
        (info) => callback(null, info),
        (error) => callback(error),
      );
    },
    _removeFile(_req, file, callback) {
      const stored = file.path;
      delete (file as Partial<TempUploadFile>).path;
      void removeQuietly(stored).then(() => callback(null));
    },
  };
}

/** Remove a received file once the request is answered, stored or refused. */
export async function removeTempUpload(file: Express.Multer.File | undefined): Promise<void> {
  await removeQuietly(file?.path);
}

/**
 * A refusal worth a second try. The AWS client retries a buffer by itself and
 * never a stream; the file is on disk, so it can be read again from the start.
 */
function isTransient(error: unknown): boolean {
  const failure = error as { $metadata?: { httpStatusCode?: number }; code?: string; name?: string };
  const status = failure?.$metadata?.httpStatusCode;
  if (typeof status === "number") return status >= 500 || status === 429;
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"].includes(failure?.code ?? "")
    || failure?.name === "TimeoutError";
}

/**
 * Send a received file to the bucket as a stream.
 *
 * The length is the count made while receiving, and the checksum is given
 * rather than left to the client to work out: asked to checksum a stream, the
 * AWS client switches to a chunked encoding with a trailer, which is not the
 * request this bucket has been taking. Given the checksum, it sends the same
 * request a buffer would have made: a length, a checksum header and the bytes.
 */
export async function putTempUpload(
  s3Client: Pick<S3Client, "send">,
  target: { bucket: string; key: string; contentType: string },
  file: TempUploadFile,
  attempts = 3,
): Promise<void> {
  if (!file.path) throw new Error("The upload was not received");
  for (let attempt = 1; ; attempt++) {
    const handle = await fs.open(file.path, "r");
    const body = handle.createReadStream();
    const abort = new AbortController();
    const unreadable = new Promise<never>((_resolve, reject) => {
      body.once("error", (error) => {
        abort.abort();
        reject(error);
      });
    });
    unreadable.catch(() => {});
    try {
      await Promise.race([
        s3Client.send(new PutObjectCommand({
          Bucket: target.bucket,
          Key: target.key,
          ContentType: target.contentType,
          Body: body,
          ContentLength: file.size,
          ...(file.checksumCrc32 ? { ChecksumAlgorithm: "CRC32" as const, ChecksumCRC32: file.checksumCrc32 } : {}),
        }), { abortSignal: abort.signal }),
        unreadable,
      ]);
      return;
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    } finally {
      body.destroy();
      await handle.close().catch(() => {});
    }
  }
}
