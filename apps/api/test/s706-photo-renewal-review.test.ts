import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog } from '@oto/db';
import { newId } from '@oto/shared';
import { AppError } from '../src/lib/errors';
import { CHALONG_MANAGER, RECEPTION, SECOND_OPERATOR_ADMIN, branchIdByCode, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let cookie: string;
let fileId: string;
let branchId: string;
let actorId: string;
const registrationId = newId();
const presign = vi.fn(async () => `https://photos.example.test/demo?X-Amz-Date=20261102T020000Z&X-Amz-Expires=300&read=${newId()}`);
beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  actorId = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json().account.id;
  branchId = await branchIdByCode(ctx.db, 'hkt-central');
  const registration = await ctx.app.inject({ method: 'POST', url: '/checkin/registrations', headers: { cookie }, payload: {
    id: registrationId, branchId, guardianName: 'ZZ TEST photo renewal', contactChannel: 'whatsapp', consentAcknowledged: true,
    acknowledgedConfirmationIds: ['confirm-15min', 'confirm-no-refund', 'confirm-evac'],
    children: [{ checkinId: newId(), name: 'ZZ TEST photo child', ageYears: 6, service: 'drop_off', foodProvision: { mode: 'none', paidSatang: 0 } }],
  } });
  expect(registration.statusCode).toBe(200);
  ctx.app.fileStorage = { bucket: 'test-photos', presignedPut: async () => 'memory://unused', presignedGet: presign,
    put: async () => {}, remove: async () => {}, probe: async () => ({ state: 'ready' }) };
  const file = await ctx.app.inject({ method: 'POST', url: '/files', headers: { cookie }, payload: {
    contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: registrationId, filename: 'demo.png',
  } });
  expect(file.statusCode).toBe(200); fileId = file.json().id;
});
afterAll(async () => { await ctx?.close(); await teardownAll(); });
const reads = () => ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'file.read'), eq(auditLog.entityId, fileId)));
const read = (session = cookie) => ctx.app.inject({ method: 'GET', url: `/files/${fileId}/url`, headers: { cookie: session } });

describe('SCRUM-706 review: renew through the existing photo access boundary', () => {
  it('HIGH pin: every fresh signed-link request records who read the photo and the owning park before answering', async () => {
    const first = await read(); const second = await read();
    expect(first.statusCode).toBe(200); expect(second.statusCode).toBe(200);
    expect(first.json().url).not.toBe(second.json().url);
    const log = await reads(); expect(log).toHaveLength(2);
    for (const entry of log) expect(entry).toMatchObject({ actorAccountId: actorId, branchId,
      entityType: 'file_object', after: { ownerEntityType: 'registration', ownerEntityId: registrationId } });
  });
  it('HIGH pin: renewal cannot cross the park or operator boundary and does not call storage when refused', async () => {
    const before = presign.mock.calls.length;
    const otherPark = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    const otherOperator = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
    expect((await read(otherPark)).statusCode).toBe(403);
    expect((await read(otherOperator)).statusCode).toBe(404);
    expect(presign).toHaveBeenCalledTimes(before);
    expect(await reads()).toHaveLength(2);
  });
  it('MEDIUM pin: a failed storage renewal does not claim a successful photo read', async () => {
    presign.mockRejectedValueOnce(new AppError(503, 'FILE_STORAGE_UNAVAILABLE', 'test storage unavailable'));
    expect((await read()).statusCode).toBe(503);
    expect(await reads()).toHaveLength(2);
  });
});
