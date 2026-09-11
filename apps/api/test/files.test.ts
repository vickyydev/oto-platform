import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-16 — needs a reachable MinIO (docker compose locally, container in
 * CI). The whole suite self-skips when storage is unreachable so the rest of
 * the tests never depend on it.
 */
let ctx: TestContext;
let storageUp = false;
beforeAll(async () => {
  ctx = await createTestContext({ files: true });
  storageUp = (await ctx.app.fileStorage?.reachable()) ?? false;
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

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
