import Fastify from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { alert, box, branch, opsRun, syncAnomaly, syncQuarantine } from '@oto/db';
import { newId } from '@oto/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { opsRoutes } from '../src/routes/ops';
import {
  ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext,
} from './helpers';

/** SCRUM-682: lossless replies and a distinct route-missing envelope.
 * Medium: undeclared output loses the generated contract; a loose retry union
 * can drop integration fields. Prescribed fix: describe the native projections,
 * preserving null/absent/open detail and named refusal semantics.
 */
const replies = [
  ['POST', '/ops/alerts/:alertId/acknowledge'], ['GET', '/ops/failures'],
  ['GET', '/ops/runs'], ['POST', '/ops/runs/:runId/retry'],
  ['GET', '/ops/quarantine'], ['GET', '/ops/anomalies'],
  ['POST', '/ops/quarantine/:quarantineId/replay'],
  ['POST', '/ops/quarantine/:quarantineId/discard'],
  ['GET', '/ops/test-controls'], ['POST', '/ops/test-controls/:key'],
  ['GET', '/ops/demo-reset'], ['POST', '/ops/demo-reset'],
] as const;

const collected = Fastify();
collected.setValidatorCompiler(validatorCompiler);
collected.setSerializerCompiler(serializerCompiler);
const schemas = new Map<string, unknown>();
let ctx: TestContext, admin: string, reception: string;
const runId = newId(), fingerprint = 'zz-test-682-contract', quarantineId = newId(), anomalyId = newId();
const when = new Date('2026-10-29T00:00:00.000Z');
const detail = { positions: [1, null, { offsetMs: -0.5 }], future: { enabled: false, count: 0 } };

beforeAll(async () => {
  collected.addHook('onRoute', route => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const responses = route.schema?.response as Record<string, unknown> | undefined;
    for (const method of methods) schemas.set(`${method} /ops${route.url}`, responses?.['200']);
  });
  // Capture the actual registrations, without replacing a handler or importing
  // the new schema module before it exists. Fixtures below use Fastify's native
  // Zod serializer against those registered schemas.
  await opsRoutes(collected as unknown as App);
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api', OPS_TEST_CONTROLS: 'false' } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [device] = await ctx.db.select().from(box).limit(1);
  if (!device) throw new Error('ZZ TEST seeded box required');
  const [park] = await ctx.db.select().from(branch).where(eq(branch.id, device.branchId));
  if (!park) throw new Error('ZZ TEST seeded park required');
  await ctx.db.insert(opsRun).values({ id: runId, kind: 'job', name: 'ZZ TEST contract run', outcome: 'failed',
    startedAt: when, finishedAt: when, durationMs: 0, fingerprint, operatorId: park.operatorId,
    branchId: park.id, stationId: null, actionId: 'zz-test-682-action', requestId: 'zz-test-682-request' });
  await ctx.db.insert(syncQuarantine).values({ id: quarantineId, boxId: device.id, eventId: newId(),
    journalEpoch: 1, boxSeq: 7, reason: 'unknown_type', status: 'open', payload: {}, receivedAt: when,
    payloadHash: null, occurredAt: null, resolutionNote: null });
  await ctx.db.insert(syncAnomaly).values({ id: anomalyId, boxId: device.id, kind: 'sequence_gap',
    detail, eventId: null, relatedEventId: null, actionId: null, detectedAt: when });
}, 180_000);

afterAll(async () => {
  try { await collected.close(); } finally { try { await ctx?.close(); } finally { await teardownAll(); } }
});

const get = (url: string, cookie = admin) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });

function serialized(method: string, url: string, body: unknown): unknown {
  const schema = schemas.get(`${method} ${url}`);
  expect(schema, `${method} ${url} must declare its real successful reply`).toBeDefined();
  if (!(schema instanceof z.ZodType)) throw new Error('ZZ TEST registered Zod schema required');
  const serialize = serializerCompiler({ schema, method, url, httpStatus: '200' });
  return JSON.parse(serialize(body));
}

describe('SCRUM-682 native response registrations and serialization', () => {
  it.each(replies)('R1 medium: %s %s declares its existing JSON response', (method, url) => {
    expect(schemas.get(`${method} ${url}`)).toBeDefined();
    const path = url.replace(/:([A-Za-z]+)/g, '{$1}');
    const document = ctx.app.swagger() as { paths: Record<string, Record<string, {
      responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
    }>> };
    expect(document.paths[path]?.[method.toLowerCase()]?.responses?.['200']?.content?.['application/json']?.schema)
      .toBeDefined();
  });

  it('R2 medium: job and integration retry replies round-trip without field stripping', () => {
    for (const body of [
      { ok: true, outcome: 'failed', syncState: 'pending', sent: 3, synced: 2, waiting: 1 },
      { ok: true, outcome: 'ok', syncState: 'synced', sent: 0, synced: 0, waiting: 0 },
      { ok: true, outcome: 'failed' },
    ]) expect(serialized('POST', '/ops/runs/:runId/retry', body)).toEqual(body);
  });

  it('R3 medium: refused replay stays a complete HTTP-success answer with ok false', () => {
    const body = { ok: false, status: 'open', eventId: newId(), errorCode: 'ZZ_TEST_REFUSAL',
      errorMessage: 'ZZ TEST still refused', result: 'quarantined', message: 'ZZ TEST no change',
      outcome: { eventId: newId(), boxSeq: 7, result: 'quarantined', reason: 'unknown_type',
        businessDate: '2026-10-29', businessDateSource: 'received_at', errorCode: 'ZZ_TEST_REFUSAL' } };
    expect(serialized('POST', '/ops/quarantine/:quarantineId/replay', body)).toEqual(body);
    const accepted = { ...body, ok: true, status: 'replayed', errorCode: null, errorMessage: null,
      result: 'duplicate', outcome: { eventId: body.eventId, boxSeq: 7, result: 'duplicate' } };
    expect(serialized('POST', '/ops/quarantine/:quarantineId/replay', accepted)).toEqual(accepted);
  });

  it('R4 medium: sparse and null measurements, arbitrary detail and dynamic reset counts survive', () => {
    const bodies: Array<[string, string, unknown]> = [
      ['GET', '/ops/failures', { groups: [], nextCursor: null, reach: { scope: 'branch', branches: [] } }],
      ['GET', '/ops/quarantine', { events: [], nextCursor: 'zz-test-cursor', openCount: null }],
      ['GET', '/ops/anomalies', { anomalies: [{ id: anomalyId, boxId: newId(), boxName: null,
        kind: 'sequence_gap', eventId: null, relatedEventId: null, detail, actionId: null,
        detectedAt: when.toISOString() }], nextCursor: null, reach: { scope: 'operator', branches: [] } }],
      ['POST', '/ops/demo-reset', { deleted: { future_table: 0, 'ZZ TEST nested count': 3 } }],
      ['POST', '/ops/quarantine/:quarantineId/discard', { ok: true, status: 'discarded' }],
      ['POST', '/ops/alerts/:alertId/acknowledge', { ok: true }],
      ['POST', '/ops/test-controls/:key', { ok: true, message: 'ZZ TEST captured result' }],
      ['GET', '/ops/test-controls', { available: true, controls: [
        { key: 'zz-test', label: 'ZZ TEST control', description: 'ZZ TEST captured only', sticky: false },
      ] }],
    ];
    for (const [method, path, body] of bodies) expect(serialized(method, path, body)).toEqual(body);
  });

  it('CONTROL: real failure/run reads retain native context fields and optional cursor counts', async () => {
    const response = await get(`/ops/runs?fingerprint=${fingerprint}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().runs.find((run: { id: string }) => run.id === runId)).toEqual({
      id: runId, kind: 'job', name: 'ZZ TEST contract run', outcome: 'failed', startedAt: when.toISOString(),
      finishedAt: when.toISOString(), durationMs: 0, error: null, fingerprint, requestId: 'zz-test-682-request',
      actionId: 'zz-test-682-action', branchId: expect.any(String), stationId: null,
    });
    const groups = await get('/ops/failures?windowHours=2160&limit=1');
    expect(groups.statusCode).toBe(200); expect(groups.json()).toHaveProperty('ungrouped', 0);
    expect(groups.json().reach).toEqual({ scope: 'operator', branches: [] });
    const cursor = groups.json().nextCursor;
    expect(cursor).toEqual(expect.any(String));
    const next = await get(`/ops/failures?windowHours=2160&cursor=${encodeURIComponent(cursor)}`);
    expect(next.statusCode).toBe(200); expect(next.json()).not.toHaveProperty('ungrouped');
  });

  it('CONTROL: real quarantine/anomaly reads keep nulls, safe detail, slot and privacy projection', async () => {
    const response = await get('/ops/quarantine?limit=1');
    expect(response.statusCode).toBe(200);
    const row = response.json().events.find((event: { id: string }) => event.id === quarantineId);
    expect(row).toMatchObject({ slot: expect.any(String), payloadHash: null, existingPayloadHash: null,
      type: null, schemaVersion: null, occurredAt: null, resolvedAt: null, resolutionNote: null });
    expect(row).not.toHaveProperty('payload'); expect(row).not.toHaveProperty('sig');
    const next = await get(`/ops/quarantine?cursor=${encodeURIComponent(response.json().nextCursor)}`);
    expect(next.statusCode).toBe(200); expect(next.json().openCount).toBeNull();
    const anomalies = await get('/ops/anomalies');
    expect(anomalies.statusCode).toBe(200);
    expect(anomalies.json().anomalies.find((value: { id: string }) => value.id === anomalyId))
      .toMatchObject({ detail, eventId: null, relatedEventId: null, actionId: null });
  });

  it('CONTROL: unavailable controls/reset are answered as unavailable without invoking a control', async () => {
    const controls = await get('/ops/test-controls');
    expect(controls.statusCode).toBe(200); expect(controls.json()).toEqual({ available: false, controls: [] });
    const reset = await get('/ops/demo-reset');
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ available: false, playground: false, confirmationPhrase: expect.any(String) });
  });
});

describe('SCRUM-682 route-missing envelope without changing native refusals', () => {
  it('R5 medium: unknown routes use a safe distinct envelope and correlation without echoing the URL', async () => {
    const reference = 'zz-test-682-route';
    const response = await ctx.app.inject({ method: 'GET', url: '/__zz_test_682_missing?private=zz-private-canary',
      headers: { 'x-request-id': reference } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'ROUTE_NOT_FOUND', message: 'This API endpoint is not available.' } });
    expect(response.headers['x-request-id']).toBe(reference);
    expect(response.body.includes('zz-private-canary')).toBe(false);
  });

  it('CONTROL: named record absence remains NOT_FOUND, and auth/permission/validation stay native', async () => {
    const absent = await ctx.app.inject({ method: 'POST', url: `/ops/runs/${newId()}/retry`, headers: { cookie: admin } });
    expect(absent.statusCode).toBe(404);
    expect(absent.json()).toMatchObject({ error: { code: 'NOT_FOUND', message: 'No such run' } });
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/ops/failures' });
    expect(anonymous.statusCode).toBe(401); expect(anonymous.json().error.code).toBe('UNAUTHORIZED');
    const refused = await get('/ops/failures', reception);
    expect(refused.statusCode).toBe(403); expect(refused.json().error.code).toBe('FORBIDDEN');
    const invalid = await get('/ops/runs?fingerprint=x');
    expect(invalid.statusCode).toBe(400); expect(invalid.json().error.code).toBe('VALIDATION');
  });

  it('CONTROL: alert acknowledgement still serializes only its existing success after a native audit', async () => {
    const [device] = await ctx.db.select().from(box).limit(1);
    const id = newId();
    await ctx.db.insert(alert).values({ id, key: `zz-test-682-${id}`, category: 'ZZ TEST contract',
      subject: 'ZZ TEST alert', summary: 'ZZ TEST acknowledgement', operatorId: device!.operatorId,
      branchId: device!.branchId });
    const response = await ctx.app.inject({ method: 'POST', url: `/ops/alerts/${id}/acknowledge`,
      headers: { cookie: admin, 'idempotency-key': newId() } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ ok: true });
  });
});
