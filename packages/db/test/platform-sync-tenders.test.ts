import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { newId } from '@oto/shared';
import { schema, type Db } from '../src/index';
import * as s from '../src/schema/index';
import { platformSync, seed, SECOND_OPERATOR_NAME } from '../src/seed/index';
import { DEFAULT_TENDERS } from '../src/seed/tenders';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-384 — the deploy-time convergence of a park's tender list.
 *
 * The defect this file exists for: since Slice E the till's method grid is
 * hydrated from `GET /payment-methods`, the only writer of `pos.payment_method`
 * was the full demo seed, and a deploy runs migrations plus `platform:sync`.
 * Staging therefore came up on 2026-09-23 with an empty table and a counter
 * that could not take money.
 *
 * So the assertions below are about two things and not one: that a park with
 * nothing gets the three defaults, and — the half that is easy to lose — that
 * a park which has ALREADY said what its tenders are is never argued with. A
 * sync that re-added a tender somebody archived, or renamed one they renamed,
 * would be a second defect wearing the first one's fix.
 *
 * Against a real database, because the guard is a `not exists` over a table
 * whose unique index is partial: neither half can be proved against the
 * TypeScript.
 */

interface Harness {
  db: Db;
  close: () => Promise<void>;
}

async function makeDatabase(): Promise<Harness> {
  const { url, drop } = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  return {
    db: drizzle(pool, { schema }) as Db,
    close: async () => {
      await pool.end();
      await drop();
    },
  };
}

/** A park of its own, so each test asserts against rows only it wrote. */
async function park(db: Db, name: string): Promise<string> {
  const id = newId();
  await db.insert(s.operator).values({ id, name });
  return id;
}

interface TenderRow {
  id: string;
  code: string;
  label: string;
  kind: string;
  enabled: boolean;
  sortOrder: number;
  archivedAt: Date | null;
  updatedAt: Date;
}

/** Every tender row a park has, archived ones included, in grid order. */
async function tendersOf(db: Db, operatorId: string): Promise<TenderRow[]> {
  return db
    .select({
      id: s.paymentMethod.id,
      code: s.paymentMethod.code,
      label: s.paymentMethod.label,
      kind: s.paymentMethod.kind,
      enabled: s.paymentMethod.enabled,
      sortOrder: s.paymentMethod.sortOrder,
      archivedAt: s.paymentMethod.archivedAt,
      updatedAt: s.paymentMethod.updatedAt,
    })
    .from(s.paymentMethod)
    .where(eq(s.paymentMethod.operatorId, operatorId))
    .orderBy(asc(s.paymentMethod.sortOrder), asc(s.paymentMethod.code));
}

/** What a converged park reads as: the three defaults, in order, ticked on. */
const THE_THREE = [
  { code: 'cash', label: 'Cash', kind: 'cash', enabled: true, sortOrder: 0, archivedAt: null },
  { code: 'card', label: 'Card', kind: 'card', enabled: true, sortOrder: 1, archivedAt: null },
  {
    code: 'promptpay',
    label: 'PromptPay',
    kind: 'qr',
    enabled: true,
    sortOrder: 2,
    archivedAt: null,
  },
];

const withoutVolatile = (rows: TenderRow[]) =>
  rows.map(({ id: _id, updatedAt: _updatedAt, ...rest }) => rest);

describe('platformSync converges the tenders of a park that has none', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await makeDatabase();
  }, 180_000);

  afterAll(async () => {
    await h?.close();
    await stopTestServer();
  });

  it('the array in tenders.ts is the three the till was built around', () => {
    // Cheap, and it fails before any of the database assertions below do: the
    // list is what both writers read, so a fourth row or a changed token here
    // is a change to what every park with no list is given.
    expect(DEFAULT_TENDERS.map((t) => [t.code, t.label, t.kind])).toEqual([
      ['cash', 'Cash', 'cash'],
      ['card', 'Card', 'card'],
      ['promptpay', 'PromptPay', 'qr'],
    ]);
  });

  it('writes the three, in order and enabled, for a park with an empty table', async () => {
    // The staging case exactly: migrations applied, a park exists, nothing has
    // ever written a tender.
    const operatorId = await park(h.db, 'Empty Park');
    await platformSync(h.db);
    expect(withoutVolatile(await tendersOf(h.db, operatorId))).toEqual(THE_THREE);
  });

  it('writes nothing on the second run — same rows, same ids, same updated_at', async () => {
    const operatorId = await park(h.db, 'Twice-Synced Park');
    await platformSync(h.db);
    const before = await tendersOf(h.db, operatorId);
    expect(before).toHaveLength(3);

    await platformSync(h.db);
    const after = await tendersOf(h.db, operatorId);
    // Ids would change on a re-insert and `updated_at` on any write to the
    // row, so comparing the whole row is the assertion that nothing ran.
    expect(after).toEqual(before);
  });

  it('PLANT — leaves a park that renamed one tender and archived another alone', async () => {
    // The half a naive fix loses. This park's list is two rows and deliberate:
    // Cash was renamed at the counter, PromptPay was archived. If the sync
    // converged on "the three are missing" instead of "the list is empty", it
    // would add Card and a second PromptPay beside them.
    const operatorId = await park(h.db, 'Opinionated Park');
    const rows = [
      {
        id: newId(),
        operatorId,
        code: 'cash',
        label: 'Cash at the counter',
        kind: 'cash' as const,
        sortOrder: 0,
      },
      {
        id: newId(),
        operatorId,
        code: 'promptpay',
        label: 'PromptPay',
        kind: 'qr' as const,
        enabled: false,
        sortOrder: 1,
        archivedAt: new Date(),
      },
    ];
    await h.db.insert(s.paymentMethod).values(rows);
    const before = await tendersOf(h.db, operatorId);

    await platformSync(h.db);

    const after = await tendersOf(h.db, operatorId);
    expect(after).toEqual(before);
    expect(after.map((row) => row.code)).toEqual(['cash', 'promptpay']);
    expect(after.map((row) => row.label)).toEqual(['Cash at the counter', 'PromptPay']);
    expect(after.find((row) => row.code === 'card')).toBeUndefined();
    expect(after[1]!.archivedAt).not.toBeNull();
  });

  it('converges the park with none and not the park beside it', async () => {
    const emptyPark = await park(h.db, 'Quiet Park');
    const tradingPark = await park(h.db, 'Trading Park');
    await h.db.insert(s.paymentMethod).values({
      id: newId(),
      operatorId: tradingPark,
      code: 'cash',
      label: 'Notes and coins',
      kind: 'cash',
      sortOrder: 0,
    });
    const tradingBefore = await tendersOf(h.db, tradingPark);

    await platformSync(h.db);

    expect(withoutVolatile(await tendersOf(h.db, emptyPark))).toEqual(THE_THREE);
    expect(await tendersOf(h.db, tradingPark)).toEqual(tradingBefore);
  });
});

describe('the sync and the full seed do not write two lists', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await makeDatabase();
    // `seed()` runs the sync itself before it creates anything: the sync sees
    // no park at all, then the seed's own upsert writes the three. Each test
    // below runs a further sync of its own, so neither depends on the other
    // having run first.
    await seed(h.db);
  }, 300_000);

  afterAll(async () => {
    await h?.close();
    await stopTestServer();
  });

  it('a seeded park keeps exactly three tenders through a later sync', async () => {
    // A duplicate would show up here as a fourth row or a second `cash`.
    const [oto] = await h.db
      .select({ id: s.operator.id })
      .from(s.operator)
      .where(eq(s.operator.name, 'OTO'))
      .limit(1);
    const seeded = await tendersOf(h.db, oto!.id);
    expect(withoutVolatile(seeded)).toEqual(THE_THREE);

    await platformSync(h.db);

    expect(await tendersOf(h.db, oto!.id)).toEqual(seeded);
  });

  it('gives the tenders to a park created after the sync ran', async () => {
    // The seed builds its second operator AFTER calling `platformSync`, so
    // that park leaves `pnpm db:seed` with no tender list — which is the very
    // shape staging was in. The next deploy's sync is what converges it, and
    // this is that deploy.
    const [second] = await h.db
      .select({ id: s.operator.id })
      .from(s.operator)
      .where(eq(s.operator.name, SECOND_OPERATOR_NAME))
      .limit(1);
    expect(second, 'the seed builds a second operator').toBeDefined();

    await platformSync(h.db);

    expect(withoutVolatile(await tendersOf(h.db, second!.id))).toEqual(THE_THREE);
  });
});
