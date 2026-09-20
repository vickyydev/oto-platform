/**
 * On-demand thumbnail/poster generation for Fix Report media.
 *
 * Fix Reports store the full-resolution original (image or video, up to
 * 20MB) in the "fix-media" object storage folder. Serving that original for
 * every list/card/gallery thumbnail is what makes the Fix module feel slow
 * on mobile. This module generates a small JPEG preview (resized photo, or
 * an extracted poster frame for videos) the first time it's requested, and
 * caches the result in the "fix-media-thumbs" folder so subsequent requests
 * are just a cache read — no re-processing.
 *
 * Backward compatible: works for media uploaded before this feature existed,
 * since thumbnails are derived from the original at request time rather than
 * at upload time.
 */

import sharp from "sharp";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { getFileFromObjectStorage, uploadToObjectStorage } from "./file-storage";

const THUMB_FOLDER = "fix-media-thumbs";
const THUMB_WIDTH = 480;
const THUMB_JPEG_QUALITY = 70;

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function extractVideoPosterFrame(buffer: Buffer): Promise<Buffer> {
  const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const inputPath = path.join(os.tmpdir(), `fixthumb_in_${tmpId}`);
  const outputPath = path.join(os.tmpdir(), `fixthumb_out_${tmpId}.jpg`);

  await fs.promises.writeFile(inputPath, buffer);
  try {
    await new Promise<void>((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-y",
        "-i", inputPath,
        "-ss", "00:00:00.5",
        "-frames:v", "1",
        "-vf", `scale=${THUMB_WIDTH}:-2`,
        outputPath,
      ]);
      let stderr = "";
      ff.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      ff.on("error", reject);
      ff.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      });
    });
    return await fs.promises.readFile(outputPath);
  } finally {
    fs.promises.unlink(inputPath).catch(() => {});
    fs.promises.unlink(outputPath).catch(() => {});
  }
}

/**
 * Returns a small JPEG preview for the given fix-media filename, generating
 * and caching it on first request. Returns null if the original can't be
 * found or a thumbnail can't be produced (caller should fall back to serving
 * the full original).
 */
export async function getOrCreateFixMediaThumbnail(
  filename: string,
  isVideo: boolean,
  localFallbackPath?: string,
): Promise<Buffer | null> {
  const thumbFilename = `${filename}.thumb.jpg`;

  const cached = await getFileFromObjectStorage(THUMB_FOLDER, thumbFilename);
  if (cached) {
    return streamToBuffer(cached.stream);
  }

  let originalBuffer: Buffer | null = null;
  const original = await getFileFromObjectStorage("fix-media", filename);
  if (original) {
    originalBuffer = await streamToBuffer(original.stream);
  } else if (localFallbackPath && fs.existsSync(localFallbackPath)) {
    originalBuffer = await fs.promises.readFile(localFallbackPath);
  }

  if (!originalBuffer) return null;

  let thumbBuffer: Buffer;
  try {
    if (isVideo) {
      thumbBuffer = await extractVideoPosterFrame(originalBuffer);
    } else {
      thumbBuffer = await sharp(originalBuffer)
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: THUMB_JPEG_QUALITY })
        .toBuffer();
    }
  } catch (err) {
    console.error(`[FixMediaThumbnail] Failed to generate thumbnail for ${filename}:`, err);
    return null;
  }

  uploadToObjectStorage(thumbBuffer, THUMB_FOLDER, thumbFilename, "image/jpeg").catch((err) => {
    console.error(`[FixMediaThumbnail] Failed to cache thumbnail for ${filename}:`, err);
  });

  return thumbBuffer;
}
