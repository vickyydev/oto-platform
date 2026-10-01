import { mkdir, open, readFile, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { OFFLINE_PHOTO_POLICY, type PhotoTarget } from '@oto/shared';

/**
 * THE BOX'S PHOTO STORE (S2-13 round 4, plan §2.5).
 *
 * A photo taken at a counter with the link down — the child with the
 * guardian at sign-up, a collector added on the spot, the live pickup photo —
 * cannot reach object storage, and a release must not wait for the internet.
 * So the photo is kept on the box's own disk, the row that names it carries
 * `photo_pending_upload`, and the upload worker (`photo-upload.ts`) sends it
 * through the platform when the link is back and links it, exactly once.
 *
 * BOUNDED, because a Raspberry Pi's card is also where the outbox lives:
 *
 *   - a photo over `maxPhotoBytes` is refused (the till shrinks box-lane
 *     photos first, so this is a guard, not a workflow);
 *   - capture is REFUSED in plain words once the store would pass `capBytes`,
 *     or the card would fall below `minFreeBytes` free — before the disk
 *     suffers, never after;
 *   - an uploaded photo is deleted `purgeAfterUploadDays` after the upload; one
 *     nothing ever named (a capture abandoned mid-flow) after
 *     `purgeUnlinkedAfterDays` from capture. A photo waiting to upload is never
 *     purged: it is evidence of who collected a child.
 *
 * Only images. NEVER a photo of an identity document (C9): nothing in this
 * store has a field for one, and the capture path asks for a face.
 */

export type BlobPurpose = 'consent' | 'collector' | 'pickup';

/** One photo's bookkeeping, kept beside its bytes. */
export interface BlobMeta {
  id: string;
  registrationId: string;
  purpose: BlobPurpose;
  contentType: string;
  size: number;
  capturedAt: string;
  /** The row the photo belongs to, once a write named it. */
  target: { kind: PhotoTarget; id: string } | null;
  /** When the bytes reached object storage. */
  uploadedAt: string | null;
  /** When the platform linked the file to its row. Purge counts from here. */
  linkedAt: string | null;
  attempts: number;
  lastError: string | null;
  /** Not before this time (a backoff after a failure). */
  nextAttemptAt: string | null;
}

export interface BlobUsage {
  count: number;
  bytes: number;
  /** What the disk itself has left, or null where that cannot be told (memory). */
  freeBytes: number | null;
  pending: number;
}

export interface BlobLimits {
  maxPhotoBytes: number;
  capBytes: number;
  minFreeBytes: number;
  purgeAfterUploadDays: number;
  purgeUnlinkedAfterDays: number;
}

export const DEFAULT_BLOB_LIMITS: BlobLimits = {
  maxPhotoBytes: OFFLINE_PHOTO_POLICY.maxPhotoBytes,
  capBytes: OFFLINE_PHOTO_POLICY.capBytes,
  minFreeBytes: OFFLINE_PHOTO_POLICY.minFreeBytes,
  purgeAfterUploadDays: OFFLINE_PHOTO_POLICY.purgeAfterUploadDays,
  purgeUnlinkedAfterDays: OFFLINE_PHOTO_POLICY.purgeUnlinkedAfterDays,
};

/** Why a photo was not kept. The bridge turns each into the counter's words. */
export class BlobStoreRefused extends Error {
  readonly reason: 'full' | 'too_big' | 'not_image';

  constructor(reason: BlobStoreRefused['reason'], message: string) {
    super(message);
    this.name = 'BlobStoreRefused';
    this.reason = reason;
  }
}

export interface BlobStore {
  /** True when a restart keeps what is stored (a disk), false in memory. */
  readonly durable: boolean;
  readonly limits: BlobLimits;
  /**
   * Keep a photo. The same id again with the same size is the till retrying
   * through a lost answer, and is answered with what is there. Refused, in a
   * `BlobStoreRefused`, past the cap or over the size bound.
   */
  put(input: Omit<BlobMeta, 'size' | 'target' | 'uploadedAt' | 'linkedAt' | 'attempts' | 'lastError' | 'nextAttemptAt'>, bytes: Uint8Array): Promise<BlobMeta>;
  get(id: string): Promise<BlobMeta | null>;
  bytes(id: string): Promise<Uint8Array | null>;
  /** Change a photo's bookkeeping. Absent keys are left alone. */
  update(id: string, patch: Partial<Omit<BlobMeta, 'id' | 'size' | 'capturedAt'>>): Promise<BlobMeta | null>;
  list(): Promise<BlobMeta[]>;
  usage(): Promise<BlobUsage>;
  /** Delete what the policy says may go; answers how many went. */
  purge(now: Date): Promise<number>;
}

const DAY_MS = 86_400_000;

/** Image bytes are recognised by their own first bytes, not by what the till claims. */
export function sniffImageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** `data:image/jpeg;base64,…` as its bytes. Null when it is not a base64 data URL. */
export function bytesOfDataUrl(dataUrl: string): Uint8Array | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match || !match[2]) return null;
  try {
    return new Uint8Array(Buffer.from(match[3] ?? '', 'base64'));
  } catch {
    return null;
  }
}

function due(meta: BlobMeta, now: Date, limits: BlobLimits): boolean {
  if (meta.linkedAt) {
    return now.getTime() - Date.parse(meta.linkedAt) >= limits.purgeAfterUploadDays * DAY_MS;
  }
  // Waiting to upload: never purged once a row names it.
  if (meta.target) return false;
  return now.getTime() - Date.parse(meta.capturedAt) >= limits.purgeUnlinkedAfterDays * DAY_MS;
}

function admit(
  limits: BlobLimits,
  usage: BlobUsage,
  size: number,
  bytes: Uint8Array,
): string {
  const type = sniffImageType(bytes);
  if (!type) throw new BlobStoreRefused('not_image', 'That is not an image');
  if (size > limits.maxPhotoBytes) {
    throw new BlobStoreRefused('too_big', `A photo is at most ${limits.maxPhotoBytes} bytes; this is ${size}`);
  }
  if (usage.bytes + size > limits.capBytes) {
    throw new BlobStoreRefused('full', `The photo store would pass its cap of ${limits.capBytes} bytes`);
  }
  if (usage.freeBytes !== null && usage.freeBytes - size < limits.minFreeBytes) {
    throw new BlobStoreRefused('full', `The disk would fall below ${limits.minFreeBytes} bytes free`);
  }
  return type;
}

// --- In memory: the tests, and a host with no disk to give -------------------------------

export function memoryBlobStore(
  opts: { limits?: Partial<BlobLimits>; freeBytes?: () => number | null } = {},
): BlobStore {
  const limits = { ...DEFAULT_BLOB_LIMITS, ...opts.limits };
  const metas = new Map<string, BlobMeta>();
  const data = new Map<string, Uint8Array>();
  const usage = async (): Promise<BlobUsage> => {
    let bytes = 0;
    let pending = 0;
    for (const m of metas.values()) {
      bytes += m.size;
      if (!m.linkedAt) pending += 1;
    }
    return { count: metas.size, bytes, freeBytes: opts.freeBytes?.() ?? null, pending };
  };
  return {
    durable: false,
    limits,
    async put(input, bytes) {
      const held = metas.get(input.id);
      if (held && held.size === bytes.length) return { ...held };
      const contentType = admit(limits, await usage(), bytes.length, bytes);
      const meta: BlobMeta = {
        ...input,
        contentType,
        size: bytes.length,
        target: null,
        uploadedAt: null,
        linkedAt: null,
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
      };
      data.set(input.id, new Uint8Array(bytes));
      metas.set(input.id, meta);
      return { ...meta };
    },
    async get(id) {
      const m = metas.get(id);
      return m ? { ...m } : null;
    },
    async bytes(id) {
      const b = data.get(id);
      return b ? new Uint8Array(b) : null;
    },
    async update(id, patch) {
      const m = metas.get(id);
      if (!m) return null;
      const next = { ...m, ...patch };
      metas.set(id, next);
      return { ...next };
    },
    async list() {
      return [...metas.values()].map((m) => ({ ...m })).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    },
    usage,
    async purge(now) {
      let gone = 0;
      for (const m of [...metas.values()]) {
        if (!due(m, now, limits)) continue;
        metas.delete(m.id);
        data.delete(m.id);
        gone += 1;
      }
      return gone;
    },
  };
}

// --- On disk: a Raspberry Pi -------------------------------------------------------------

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Write a file so that a power cut leaves either the old one or the new one, never half. */
async function writeAtomic(path: string, bytes: Uint8Array | string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

/**
 * The store on a directory: `<id>.img` beside `<id>.json`. The bytes are
 * written first and the bookkeeping second, both by rename, so a power cut
 * leaves at worst an image with no bookkeeping — which `purge` removes — and
 * never bookkeeping that names bytes that are not there.
 */
export function fsBlobStore(dir: string, opts: { limits?: Partial<BlobLimits> } = {}): BlobStore {
  const limits = { ...DEFAULT_BLOB_LIMITS, ...opts.limits };
  const imgPath = (id: string) => join(dir, `${id}.img`);
  const metaPath = (id: string) => join(dir, `${id}.json`);
  let ready: Promise<void> | null = null;
  const ensure = (): Promise<void> => {
    ready ??= mkdir(dir, { recursive: true, mode: 0o700 }).then(() => undefined);
    return ready;
  };

  async function readMeta(id: string): Promise<BlobMeta | null> {
    if (!ID.test(id)) return null;
    try {
      return JSON.parse(await readFile(metaPath(id), 'utf8')) as BlobMeta;
    } catch {
      return null;
    }
  }

  async function list(): Promise<BlobMeta[]> {
    await ensure();
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: BlobMeta[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const meta = await readMeta(name.slice(0, -5));
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }

  async function freeBytes(): Promise<number | null> {
    try {
      const fs = await statfs(dir);
      return Number(fs.bavail) * Number(fs.bsize);
    } catch {
      return null;
    }
  }

  async function usage(): Promise<BlobUsage> {
    const metas = await list();
    return {
      count: metas.length,
      bytes: metas.reduce((sum, m) => sum + m.size, 0),
      freeBytes: await freeBytes(),
      pending: metas.filter((m) => !m.linkedAt).length,
    };
  }

  return {
    durable: true,
    limits,
    async put(input, bytes) {
      await ensure();
      if (!ID.test(input.id)) throw new BlobStoreRefused('not_image', 'A photo id is a UUID');
      const held = await readMeta(input.id);
      if (held && held.size === bytes.length) return held;
      const contentType = admit(limits, await usage(), bytes.length, bytes);
      const meta: BlobMeta = {
        ...input,
        contentType,
        size: bytes.length,
        target: null,
        uploadedAt: null,
        linkedAt: null,
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
      };
      await writeAtomic(imgPath(input.id), bytes);
      await writeAtomic(metaPath(input.id), JSON.stringify(meta));
      return meta;
    },
    get: readMeta,
    async bytes(id) {
      if (!ID.test(id)) return null;
      try {
        return new Uint8Array(await readFile(imgPath(id)));
      } catch {
        return null;
      }
    },
    async update(id, patch) {
      const meta = await readMeta(id);
      if (!meta) return null;
      const next = { ...meta, ...patch };
      await writeAtomic(metaPath(id), JSON.stringify(next));
      return next;
    },
    list,
    usage,
    async purge(now) {
      await ensure();
      let gone = 0;
      for (const meta of await list()) {
        if (!due(meta, now, limits)) continue;
        await rm(imgPath(meta.id), { force: true });
        await rm(metaPath(meta.id), { force: true });
        gone += 1;
      }
      // Bytes a power cut left without bookkeeping, and temporaries.
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        const orphanImage = name.endsWith('.img') && !names.includes(`${name.slice(0, -4)}.json`);
        if (!orphanImage && !name.includes('.tmp-')) continue;
        const info = await stat(join(dir, name)).catch(() => null);
        if (info && now.getTime() - info.mtimeMs > 60_000) {
          await rm(join(dir, name), { force: true });
        }
      }
      return gone;
    },
  };
}

// --- One store per box, found by the bridge that runs beside it ----------------------------

const registry = new Map<string, BlobStore>();

/**
 * The agent registers its box's store here, so a station bridge in the same
 * process — its own (a Pi) or the api's mount for a virtual box — keeps a
 * captured photo in the store the upload worker reads.
 */
export function registerBoxBlobs(boxId: string, store: BlobStore | null): void {
  if (store) registry.set(boxId, store);
  else registry.delete(boxId);
}

export function boxBlobs(boxId: string): BlobStore | null {
  return registry.get(boxId) ?? null;
}
