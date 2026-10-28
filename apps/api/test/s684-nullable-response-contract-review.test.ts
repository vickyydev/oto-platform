import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { branch } from '@oto/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/** SCRUM-684, medium: nullable enums omit null from the published enum.
 * Prescribed fix: correct only the three called routes' response documentation;
 * preserve native Zod, inputs, permissions, services and every other operation.
 */
interface JsonSchema {
  type?: string;
  nullable?: boolean;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}
interface ApiDocument {
  paths: Record<string, { get: { responses: Record<string, {
    content: { 'application/json': { schema: JsonSchema } };
  }> } }>;
}
const cases = [
  ['/console/analytics/drift', 'comparisons.items.reason'],
  ['/branches/{branchId}/menu', 'categories.items.taxableCategory'],
  ['/branches/{branchId}/menu', 'categories.items.defaultPrepStation'],
  ['/branches/{branchId}/menu', 'categories.items.effectiveTaxCategory'],
  ['/branches/{branchId}/menu', 'categories.items.effectivePrepStation'],
  ['/branches/{branchId}/menu', 'products.items.prepStationOverride'],
  ['/branches/{branchId}/menu', 'products.items.taxCategoryOverride'],
  ['/branches/{branchId}/credentials', 'credentials.items.lastRejectedCode'],
] as const;
let ctx: TestContext, cookie: string, branchId: string, document: ApiDocument;
const consumer = Fastify({ ajv: { customOptions: {
  coerceTypes: false, useDefaults: false, removeAdditional: false,
} } });
function field(operation: string, path: string): JsonSchema {
  let node = document.paths[operation]?.get.responses['200']?.content['application/json'].schema;
  if (!node) throw Error('ZZ TEST actual response schema required');
  for (const part of path.split('.')) {
    const next: JsonSchema | undefined = part === 'items' ? node.items : node.properties?.[part];
    if (!next) throw Error('ZZ TEST actual response field required');
    node = next;
  }
  return node;
}
function registerConsumer(url: string, value: JsonSchema) {
  consumer.post(url, { schema: { body: { type: 'object', required: ['value'],
    properties: { value }, additionalProperties: false } } }, async () => ({ ok: true }));
}
const validate = (url: string, value: unknown) => consumer.inject({
  method: 'POST', url, payload: { value },
});
beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api', OPS_TEST_CONTROLS: 'false',
    CONSOLE_DIGEST_ENABLED: 'false', ALERT_WEBHOOK_URL: '' } });
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
  const operatorId = me.json().operatorContext.effectiveOperatorId as string;
  const [park] = await ctx.db.select({ id: branch.id }).from(branch).where(eq(branch.operatorId, operatorId)).limit(1);
  if (!park) throw Error('ZZ TEST owned park required');
  branchId = park.id;
  document = ctx.app.swagger() as unknown as ApiDocument;
  for (const [index, [operation, path]] of cases.entries()) registerConsumer(`/nullable/${index}`, field(operation, path));
  for (const [index, path] of ['products.items.kind', 'products.items.effectivePrepStation', 'products.items.effectiveTaxCategory'].entries())
    registerConsumer(`/required/${index}`, field('/branches/{branchId}/menu', path));
  registerConsumer('/other', field('/payment-methods', 'methods.items.kind'));
  await consumer.ready();
}, 180_000);
afterAll(async () => {
  let databaseDropped = false, serverStopped = false;
  try { await consumer.close(); } finally {
    try { await ctx?.close(); databaseDropped = Boolean(ctx); }
    finally { await teardownAll(); serverStopped = true;
      console.info(JSON.stringify({ ticket: 'SCRUM-684', cleanup: { databaseDropped, serverStopped } })); }
  }
});

describe('SCRUM-684 actual buildApp.swagger nullable response enums', () => {
  it.each(cases)('R1 medium: %s %s documents the native null value', async (operation, path) => {
    const index = cases.findIndex(row => row[0] === operation && row[1] === path);
    expect(field(operation, path).nullable).toBe(true);
    expect((await validate(`/nullable/${index}`, null)).statusCode).toBe(200);
    expect(field(operation, path).enum).toContain(null);
  });
  it('R2 control: declared strings remain valid and unknown literals/types remain refused', async () => {
    for (const [index, [operation, path]] of cases.entries()) {
      const allowed = field(operation, path).enum?.filter(value => typeof value === 'string');
      expect(allowed?.length).toBeGreaterThan(0);
      for (const value of allowed ?? []) expect((await validate(`/nullable/${index}`, value)).statusCode).toBe(200);
      expect((await validate(`/nullable/${index}`, 'ZZ_TEST_UNKNOWN_ENUM')).statusCode).toBe(400);
      for (const value of [false, 0, { invalid: true }, []])
        expect((await validate(`/nullable/${index}`, value)).statusCode).toBe(400);
    }
  });
  it('R3 control: nonnullable menu kinds and resolved tax/prep values remain nonnullable', async () => {
    for (let index = 0; index < 3; index++) expect((await validate(`/required/${index}`, null)).statusCode).toBe(400);
  });
  it('R4 control: an unrelated native payment-method enum is unchanged', async () => {
    expect((await validate('/other', null)).statusCode).toBe(400);
    expect((await validate('/other', 'ZZ_TEST_UNKNOWN_ENUM')).statusCode).toBe(400);
  });
  it('R5 control: existing malformed input refusals remain 400', async () => {
    for (const url of ['/console/analytics/drift?branches=not-a-uuid', '/branches/not-a-uuid/menu',
      `/branches/${branchId}/credentials?includeRevoked=not-a-boolean`])
      expect((await ctx.app.inject({ method: 'GET', url, headers: { cookie } })).statusCode).toBe(400);
  });
  it('R6 control: all three reads retain their unauthenticated refusal', async () => {
    for (const url of ['/console/analytics/drift', `/branches/${branchId}/menu`, `/branches/${branchId}/credentials`])
      expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });
  it('R7 control: the real owned native reads still return JSON successfully', async () => {
    for (const url of ['/console/analytics/drift', `/branches/${branchId}/menu`, `/branches/${branchId}/credentials`]) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
    }
  });
});
