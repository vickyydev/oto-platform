import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ProductVariantSchema } from '@oto/shared';
import type { ProductVariant } from '../src/schema/catalog';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-09b — a product's sizes (`pos.product.variants`, migration 0020), asserted
 * against a live database built from the committed migrations.
 *
 * The column is jsonb, so almost everything about a size is the API's to hold.
 * What the database can hold is the one thing below every rule: the value is an
 * ARRAY. An object, a string or a bare number in that column would reach every
 * reader that iterates it — the menu read, the scanner, the sale — as something
 * that is not a list of sizes, and the check is what makes that a refused write
 * instead of a later crash on a till.
 */

let db: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
}, 180_000);

afterAll(async () => {
  await client?.end();
  await db?.drop();
  await stopTestServer();
});

/** A minimal tenant, so a product has an operator and a branch to belong to. */
async function tenancy(): Promise<{ operatorId: string; branchId: string }> {
  const { rows } = await client.query<{ operator_id: string; branch_id: string }>(
    `with o as (
       insert into core.operator (id, name) values (gen_random_uuid(), 'Sizes Op') returning id
     ), b as (
       insert into core.branch (id, operator_id, name, code)
       select gen_random_uuid(), o.id, 'Sizes Park', 'SZ' from o returning id, operator_id
     )
     select operator_id, id as branch_id from b`,
  );
  return { operatorId: rows[0]!.operator_id, branchId: rows[0]!.branch_id };
}

/** Insert a merch row, optionally naming `variants` as raw SQL text. Returns its id. */
async function insertProduct(
  at: { operatorId: string; branchId: string },
  variantsJson?: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    variantsJson === undefined
      ? `insert into pos.product (id, operator_id, branch_id, kind, name)
         values (gen_random_uuid(), $1, $2, 'merch', 'Socks') returning id`
      : `insert into pos.product (id, operator_id, branch_id, kind, name, variants)
         values (gen_random_uuid(), $1, $2, 'merch', 'Socks', $3::jsonb) returning id`,
    variantsJson === undefined ? [at.operatorId, at.branchId] : [at.operatorId, at.branchId, variantsJson],
  );
  return rows[0]!.id;
}

describe('pos.product.variants — the column', () => {
  it('is jsonb, not null, and defaults to an empty list', async () => {
    const { rows } = await client.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'pos' and table_name = 'product' and column_name = 'variants'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ data_type: 'jsonb', is_nullable: 'NO' });
    expect(rows[0]!.column_default).toBe(`'[]'::jsonb`);
  });

  it('gives a row written before sizes existed an empty list, which is one size', async () => {
    // Every product already on a database when 0020 runs takes the default —
    // the column is added NOT NULL with it — and so does any writer that never
    // names the column: the menu import, and the seed as it stood before 0020.
    // The branch clone is not one of them: it copies the source row whole,
    // sizes included.
    const at = await tenancy();
    const id = await insertProduct(at);
    const { rows } = await client.query<{ variants: unknown }>(
      `select variants from pos.product where id = $1`,
      [id],
    );
    expect(rows[0]!.variants).toEqual([]);
  });

  it('keeps the sizes it is given, in order, id and label and barcode', async () => {
    const at = await tenancy();
    const sizes: ProductVariant[] = [
      { id: 's', label: 'S' },
      { id: 'm', label: 'M', barcode: '8850000000017' },
      { id: 'l', label: 'L', sku: 'SOCK-L' },
    ];
    const id = await insertProduct(at, JSON.stringify(sizes));
    const { rows } = await client.query<{ variants: unknown }>(
      `select variants from pos.product where id = $1`,
      [id],
    );
    expect(rows[0]!.variants).toEqual(sizes);
  });
});

describe('what the database refuses', () => {
  it.each([
    ['an object', '{"id":"m","label":"M"}'],
    ['a string', '"M"'],
    ['a number', '3'],
    ['a JSON null', 'null'],
  ])('PLANT — %s where the list of sizes goes', async (_what, value) => {
    const at = await tenancy();
    await expect(insertProduct(at, value)).rejects.toThrow(/product_variants_array_check/);
  });

  it('refuses SQL NULL too, which is not an empty list', async () => {
    const at = await tenancy();
    await expect(
      client.query(
        `insert into pos.product (id, operator_id, branch_id, kind, name, variants)
         values (gen_random_uuid(), $1, $2, 'merch', 'Socks', null)`,
        [at.operatorId, at.branchId],
      ),
    ).rejects.toThrow(/null value in column "variants"/);
  });
});

describe('the scanner can ask for a size by its barcode from an index', () => {
  it('has a GIN index over the sizes with jsonb_path_ops', async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'pos' and tablename = 'product' and indexname = 'product_variants_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/USING gin \(variants jsonb_path_ops\)/);
  });

  it('answers the containment question the resolver asks', async () => {
    // `resolveProductBarcode` in the api asks exactly this: which live item has
    // a size whose tag carries these digits. Asked here so the operator the
    // index supports and the one the resolver uses are the same operator.
    const at = await tenancy();
    const withSize = await insertProduct(
      at,
      JSON.stringify([{ id: 'm', label: 'M', barcode: '8859999999994' }]),
    );
    await insertProduct(at, JSON.stringify([{ id: 'm', label: 'M' }]));
    const { rows } = await client.query<{ id: string }>(
      `select id from pos.product where operator_id = $1 and variants @> $2::jsonb`,
      [at.operatorId, JSON.stringify([{ barcode: '8859999999994' }])],
    );
    expect(rows.map((r) => r.id)).toEqual([withSize]);
  });
});

describe('the size is one shape, spelled the same in both copies', () => {
  it('@oto/shared names the same fields the schema type does', () => {
    // `ProductVariant` in `schema/catalog.ts` is a TypeScript interface and has
    // no runtime keys to compare, so the check is the other way round: a value
    // typed as the schema's interface, with every field set, is one the API's
    // schema takes whole — nothing stripped, nothing refused.
    const full: Required<ProductVariant> = {
      id: 'm',
      label: 'M',
      sku: 'OTO-SOCK-M',
      barcode: '8850000000017',
    };
    const parsed = ProductVariantSchema.safeParse(full);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(full);
    expect(Object.keys(ProductVariantSchema.shape).sort()).toEqual(Object.keys(full).sort());
  });
});
