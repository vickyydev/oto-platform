import { Client } from 'minio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { loadEnv } from '../src/env';
import { buildFileStorage } from '../src/services/files';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-16 — needs a reachable MinIO (docker compose locally; nothing runs
 * one in CI). The end-to-end pair self-skips when storage is unreachable so
 * the rest of the tests never depend on it.
 *
 * Storage is pinned to the compose container rather than taken from the
 * environment, for the same reason the SMS adapter is (env.ts): a developer
 * whose `.env` points at the deployment's bucket would otherwise have this
 * suite writing test objects into it — and a malformed value there would
 * fail the suite for a reason that is not its own. The bucket is a test
 * bucket, so nothing here shares a namespace with `pnpm dev`.
 */
const STORAGE_ENV = {
  MINIO_ENDPOINT: 'localhost',
  MINIO_PORT: '9000',
  MINIO_USE_SSL: 'false',
  MINIO_ACCESS_KEY: 'oto',
  MINIO_SECRET_KEY: 'otosecret123',
  MINIO_BUCKET: 'oto-files-test',
};

let ctx: TestContext;
let storageUp = false;
beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  storageUp = await ensureTestBucket(ctx.app);
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/**
 * The api no longer creates the bucket — on a deployment a person does, and
 * a bucket-scoped token could not anyway (S2-01d, finding B1) — so this
 * fixture creates its own, the way a test owns the data it needs. Returns
 * false only when there is no storage to talk to at all.
 */
async function ensureTestBucket(app: App): Promise<boolean> {
  const storage = app.fileStorage;
  if (!storage) return false;
  const probe = await storage.probe();
  if (probe.state === 'ready') return true;
  if (probe.state === 'unreachable') return false;
  const env = app.env;
  const client = new Client({
    endPoint: env.MINIO_ENDPOINT,
    port: env.MINIO_PORT,
    useSSL: env.MINIO_USE_SSL,
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
    region: env.MINIO_REGION,
  });
  await client.makeBucket(storage.bucket);
  return true;
}

describe('SCRUM-16 / SCRUM-25 — permission-bound files', () => {
  it('uploads and retrieves a profile photo end to end', async (t) => {
    if (!storageUp) return t.skip();
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    const accountId = me.json().account.id as string;

    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/files',
      headers: { cookie },
      payload: {
        contentType: 'image/png',
        ownerEntityType: 'account',
        ownerEntityId: accountId,
        filename: 'photo.png',
      },
    });
    expect(reg.statusCode).toBe(200);
    const { id, uploadUrl } = reg.json();

    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      body: bytes,
      headers: { 'content-type': 'image/png' },
    });
    expect(put.ok).toBe(true);

    const urlRes = await ctx.app.inject({ method: 'GET', url: `/files/${id}/url`, headers: { cookie } });
    expect(urlRes.statusCode).toBe(200);
    const got = await fetch(urlRes.json().url);
    expect(got.ok).toBe(true);
    const body = new Uint8Array(await got.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from(bytes));

    // /me surfaces the latest photo id.
    const me2 = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(me2.json().photoFileId).toBe(id);
  });

  it("denies access to another account's file (403) and requires auth (401)", async (t) => {
    if (!storageUp) return t.skip();
    const adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const meAdmin = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: adminCookie } });
    const adminId = meAdmin.json().account.id as string;
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/files',
      headers: { cookie: adminCookie },
      payload: { contentType: 'image/png', ownerEntityType: 'account', ownerEntityId: adminId },
    });
    const fileId = reg.json().id as string;

    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/files/${fileId}/url`,
      headers: { cookie: reception },
    });
    expect(denied.statusCode).toBe(403); // reception lacks admin:account:read

    const unauth = await ctx.app.inject({ method: 'GET', url: `/files/${fileId}/url` });
    expect(unauth.statusCode).toBe(401);
  });
});

/**
 * S2-01d, finding B1 — the storage client itself, with no storage running.
 * Both of these describe what the upload path does now: it signs, and it
 * never asks storage anything on the way.
 */
describe('object storage without a round trip (S2-01d)', () => {
  const offline = () =>
    buildFileStorage(
      loadEnv({
        ...STORAGE_ENV,
        NODE_ENV: 'test',
        // Nothing listens here, which is the point of both tests.
        MINIO_ENDPOINT: '127.0.0.1',
        MINIO_PORT: '1',
      }),
    );

  it('signs an upload and a download without reaching storage', async () => {
    // Only possible because the region is fixed on the client. Without it,
    // minio-js asks the bucket where it lives before it can sign, and this
    // would throw rather than return a URL.
    const put = await offline().presignedPut('operator/account/id/photo.png');
    expect(put).toContain('X-Amz-Signature');
    const get = await offline().presignedGet('operator/account/id/photo.png');
    expect(get).toContain('X-Amz-Signature');
  });

  it('reports unreachable storage instead of throwing something unknown', async () => {
    const probe = await offline().probe();
    expect(probe.state).toBe('unreachable');
    if (probe.state === 'unreachable') {
      expect(probe.reason).toBeTruthy();
    }
  });
});
