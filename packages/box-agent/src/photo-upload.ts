import type { PhotoTarget } from '@oto/shared';
import { backoffMs } from './store';
import type { BlobMeta, BlobStore } from './blob-store';

/**
 * THE PHOTO UPLOAD WORKER (S2-13 round 4, plan §2.5).
 *
 * A photo taken with the link down waits in the box's photo store
 * (`blob-store.ts`) beside a row that says `photo_pending_upload`. When the
 * link is back this sends it, in three steps, each safe to repeat:
 *
 *   1. ask the platform for an upload URL, with the box's own credential
 *      (`POST /box/v1/photos/:id/upload-url`). The photo's id is the
 *      platform's `file_object` id, so asking again is answered with a fresh
 *      URL for the SAME object — never a second file;
 *   2. PUT the bytes to object storage. Again overwrites the same object;
 *   3. ask the platform to link it (`POST /box/v1/photos/:id/link`). The
 *      platform links a row's photo EXACTLY ONCE: the same photo again is a
 *      replay that writes nothing, another photo on that row is refused.
 *
 * So a worker that crashes between any two steps — the power, a dropped
 * answer — repeats from the step it had not recorded, and the row is linked
 * once with one audit line. The photo is purged seven days after the link.
 *
 * A row the platform has not filed yet (its fact still on the queue) answers
 * `PHOTO_TARGET_NOT_READY`: the photo waits for the next tick.
 */

export type UploadCrashPoint = 'after_presign' | 'after_put' | 'after_link';

export interface PhotoUploaderDeps {
  blobs: () => BlobStore | null;
  /** A box-credentialed call to the platform (the agent's `request`). */
  request: <T>(
    path: string,
    init: { method: string; body?: unknown },
  ) => Promise<{ status: number; body: T | null }>;
  /** PUT the bytes to the presigned URL; answers the HTTP status. */
  put: (url: string, bytes: Uint8Array, contentType: string) => Promise<number>;
  /** The row a photo was taken for, from what the counter recorded (`StationBridge.photoTarget`). */
  target: (photoId: string) => Promise<{ kind: PhotoTarget; id: string } | null>;
  isOnline: () => boolean;
  now: () => Date;
  note: (level: 'info' | 'warn' | 'error', msg: string, detail?: Record<string, unknown>) => void;
  /** A test's hand on the power lead between the steps. Nothing else sets it. */
  crashPoint?: (point: UploadCrashPoint, photoId: string) => void | Promise<void>;
}

export interface UploadTick {
  linked: number;
  waiting: number;
  failed: number;
  purged: number;
}

export interface PhotoUploader {
  /** One pass over the photos waiting. Never throws; concurrent calls share one pass. */
  tick(): Promise<UploadTick>;
}

/** The default PUT: global fetch, the bytes as they are. */
export async function fetchPut(url: string, bytes: Uint8Array, contentType: string): Promise<number> {
  const res = await fetch(url, { method: 'PUT', body: bytes, headers: { 'content-type': contentType } });
  return res.status;
}

export function createPhotoUploader(deps: PhotoUploaderDeps): PhotoUploader {
  let running: Promise<UploadTick> | null = null;

  async function fail(blobs: BlobStore, meta: BlobMeta, code: string): Promise<void> {
    const attempts = meta.attempts + 1;
    await blobs.update(meta.id, {
      attempts,
      lastError: code,
      nextAttemptAt: new Date(deps.now().getTime() + backoffMs(attempts, { baseMs: 5_000 })).toISOString(),
    });
  }

  async function one(blobs: BlobStore, meta: BlobMeta): Promise<'linked' | 'waiting' | 'failed'> {
    let target = meta.target;
    if (!target) {
      target = await deps.target(meta.id);
      if (!target) return 'waiting';
      await blobs.update(meta.id, { target });
    }
    const body = { target, contentType: meta.contentType, size: meta.size };

    if (!meta.uploadedAt) {
      const presigned = await deps.request<{ uploadUrl: string | null; linked: boolean; error?: { code: string } }>(
        `/box/v1/photos/${meta.id}/upload-url`,
        { method: 'POST', body },
      );
      if (presigned.status === 409 && presigned.body?.error?.code === 'PHOTO_TARGET_NOT_READY') {
        await fail(blobs, meta, 'PHOTO_TARGET_NOT_READY');
        return 'waiting';
      }
      if (presigned.status !== 200 || !presigned.body) {
        await fail(blobs, meta, presigned.body?.error?.code ?? `STATUS_${presigned.status}`);
        return 'failed';
      }
      await deps.crashPoint?.('after_presign', meta.id);
      if (presigned.body.linked) {
        // Linked by a pass whose answer was lost: nothing to send.
        const at = deps.now().toISOString();
        await blobs.update(meta.id, { uploadedAt: meta.uploadedAt ?? at, linkedAt: at, lastError: null, nextAttemptAt: null });
        return 'linked';
      }
      const bytes = await blobs.bytes(meta.id);
      if (!bytes || !presigned.body.uploadUrl) {
        await fail(blobs, meta, bytes ? 'NO_UPLOAD_URL' : 'BYTES_MISSING');
        return 'failed';
      }
      const status = await deps.put(presigned.body.uploadUrl, bytes, meta.contentType).catch(() => 0);
      if (status < 200 || status >= 300) {
        await fail(blobs, meta, `PUT_${status}`);
        return 'failed';
      }
      await blobs.update(meta.id, { uploadedAt: deps.now().toISOString() });
      await deps.crashPoint?.('after_put', meta.id);
    }

    const linked = await deps.request<{ linked: boolean; replay: boolean; error?: { code: string; message?: string } }>(
      `/box/v1/photos/${meta.id}/link`,
      { method: 'POST', body },
    );
    if (linked.status === 409 && linked.body?.error?.code === 'PHOTO_TARGET_NOT_READY') {
      await fail(blobs, meta, 'PHOTO_TARGET_NOT_READY');
      return 'waiting';
    }
    if (linked.status === 409 && linked.body?.error?.code === 'PHOTO_TARGET_TAKEN') {
      // The row already has a photo (another counter's): the first one stands.
      // This one is kept a week like any uploaded photo, then purged.
      deps.note('warn', 'a photo was not linked: its row already holds another', { photoId: meta.id, target });
      await blobs.update(meta.id, { linkedAt: deps.now().toISOString(), lastError: 'PHOTO_TARGET_TAKEN', nextAttemptAt: null });
      return 'failed';
    }
    if (linked.status !== 200 || !linked.body?.linked) {
      await fail(blobs, meta, linked.body?.error?.code ?? `STATUS_${linked.status}`);
      return 'failed';
    }
    await deps.crashPoint?.('after_link', meta.id);
    await blobs.update(meta.id, { linkedAt: deps.now().toISOString(), lastError: null, nextAttemptAt: null });
    return 'linked';
  }

  async function pass(): Promise<UploadTick> {
    const out: UploadTick = { linked: 0, waiting: 0, failed: 0, purged: 0 };
    const blobs = deps.blobs();
    if (!blobs) return out;
    const now = deps.now();
    out.purged = await blobs.purge(now).catch(() => 0);
    if (!deps.isOnline()) return out;
    for (const meta of await blobs.list()) {
      if (meta.linkedAt) continue;
      if (meta.nextAttemptAt && Date.parse(meta.nextAttemptAt) > now.getTime()) {
        out.waiting += 1;
        continue;
      }
      try {
        out[await one(blobs, meta)] += 1;
      } catch (err) {
        // A dropped link mid-pass: the photo stays, and the next tick repeats
        // from the step it had not recorded.
        deps.note('warn', 'a photo could not be sent this pass', { photoId: meta.id, err: String(err) });
        await fail(blobs, meta, 'UNREACHABLE').catch(() => undefined);
        out.failed += 1;
        if (!deps.isOnline()) break;
      }
    }
    if (out.linked > 0) deps.note('info', 'photos taken offline were linked', { ...out });
    return out;
  }

  return {
    tick() {
      running ??= pass().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
