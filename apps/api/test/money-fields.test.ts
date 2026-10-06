import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-271 — EVERY MONEY FIELD IS WHOLE SATANG, ON EVERY ROUTE, BOTH WAYS.
 *
 * Plan `docs/progress/plans/offline/PLAN.md` §2.7 and Round 2: "a schema check
 * makes every money field `z.number().int()`". `CLAUDE.md` §3 decided it —
 * money is integers in satang, never floats — and the till's older baht
 * calculator was the last place a float could reach the wire from. What
 * stops the next one is not a reviewer remembering: it is this walk over the
 * OpenAPI document the routes generate, which fails on any field named for
 * satang that a schema lets carry a fraction, in any request or any answer.
 *
 * A DISCOUNT'S `value` is the one money figure not named for its unit — a
 * percentage for `percent`, satang for `fixed` (and for a free item's price on
 * a promo) — so a JSON schema cannot say it. The route refuses a fraction of a
 * satang there itself, and the second case pins that, beside a fractional
 * percentage it still accepts.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  items?: Schema | Schema[];
  additionalProperties?: Schema | boolean;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  not?: Schema;
};

/** Whether a schema admits only whole numbers (or nothing at all, where it is nullable). */
function isWhole(schema: Schema): boolean {
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) {
    return alternatives.every((s) => isWhole(s) || s.type === 'null');
  }
  if (schema.allOf) return schema.allOf.some(isWhole);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  return types.length > 0 && types.every((t) => t === 'integer' || t === 'null');
}

/** Every property in a schema, however deep, with the path it sits at. */
function* moneyFields(schema: Schema | undefined, at: string): Generator<[string, Schema]> {
  if (!schema || typeof schema !== 'object') return;
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    if (/Satang$/.test(key)) yield [`${at}.${key}`, sub];
    yield* moneyFields(sub, `${at}.${key}`);
  }
  const items = Array.isArray(schema.items) ? schema.items : schema.items ? [schema.items] : [];
  for (const sub of items) yield* moneyFields(sub, `${at}[]`);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    yield* moneyFields(schema.additionalProperties, `${at}{}`);
  }
  for (const sub of [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])]) {
    yield* moneyFields(sub, at);
  }
}

describe('money on the wire (SCRUM-271)', () => {
  it('declares every field named for satang as a whole number, in every request and every answer', async () => {
    await ctx.app.ready();
    const doc = ctx.app.swagger() as {
      paths: Record<
        string,
        Record<
          string,
          {
            parameters?: { name: string; schema?: Schema }[];
            requestBody?: { content?: Record<string, { schema?: Schema }> };
            responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
          }
        >
      >;
    };
    const seen: string[] = [];
    const fractional: string[] = [];
    for (const [url, operations] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const where = `${method.toUpperCase()} ${url}`;
        const roots: [string, Schema | undefined][] = [
          ...Object.values(operation.requestBody?.content ?? {}).map((c) => ['body', c.schema] as [string, Schema | undefined]),
          ...(operation.parameters ?? []).map(
            (p) => [p.name, { properties: { [p.name]: p.schema ?? {} } }] as [string, Schema | undefined],
          ),
          ...Object.entries(operation.responses ?? {}).flatMap(([status, response]) =>
            Object.values(response.content ?? {}).map((c) => [`${status}`, c.schema] as [string, Schema | undefined]),
          ),
        ];
        for (const [root, schema] of roots) {
          for (const [path, field] of moneyFields(schema, root)) {
            seen.push(`${where} ${path}`);
            if (!isWhole(field)) fractional.push(`${where} ${path}`);
          }
        }
      }
    }
    // The walk found the money it exists to check — the sale's own fields,
    // the tender, the refund — rather than passing over an empty document.
    expect(seen.length).toBeGreaterThan(20);
    expect(seen.some((f) => f.startsWith('POST /sales/ ') && f.endsWith('.expectedTotalSatang'))).toBe(true);
    expect(fractional).toEqual([]);
  });

  it('refuses a fraction of a satang where a discount carries money, and a fractional percentage stays a percentage', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const quote = (manual: { type: 'fixed' | 'percent'; value: number }) =>
      ctx.app.inject({
        method: 'POST',
        url: '/sales/quote',
        headers: { cookie },
        payload: {
          lines: [],
          items: [],
          manualDiscounts: [
            { id: '01926f3e-5e3f-7c3a-9d1a-3b2f4c5d6e7f', scope: 'order', reason: 'Service recovery', ...manual },
          ],
        },
      });
    const fixed = await quote({ type: 'fixed', value: 1_000.5 });
    expect(fixed.statusCode).toBe(400);
    expect(JSON.stringify(fixed.json())).toMatch(/whole satang/);
    // A percentage is not money: 12.5 % is a percentage, and the schema lets it
    // through to the pricing, which refuses this cart for being empty instead.
    const percent = await quote({ type: 'percent', value: 12.5 });
    expect(JSON.stringify(percent.json())).not.toMatch(/whole satang/);
  });
});
