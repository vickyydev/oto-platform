import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account,
  box,
  boxState,
  paymentAttempt,
  refund,
  sale,
  session as sessionTable,
  station,
  ticketPackage,
  voucherRedemption,
} from '@oto/db';
import { newId } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-295 — THE OFFLINE CAPABILITY LIST, ONE CASE PER ROW.
 *
 * Plan `docs/progress/plans/offline/PLAN.md` §2.8 is the list; `ARCHITECTURE.md`
 * §17 publishes it; this file enforces it (register Check 7). Every row gets a
 * case that runs its operation with the station offline and asserts the row:
 *
 *   - a REFUSAL row is asserted now, in the platform's own words — the answer a
 *     till gets for it with its station offline;
 *   - a WORKS row is a pending case naming the round that builds it (plan §4,
 *     rounds 3 and 4). It becomes an assertion in that round, driven through
 *     the box, and until then no row can claim "works offline" through a path
 *     that does not exist;
 *   - the check-in row belongs to S2-13 and is named, not claimed.
 *
 * THE LIST AND THE DOCUMENT ARE ONE LIST. The first case reads §17's table
 * and compares it, row for row, with `CAPABILITIES` below: a row added,
 * removed or reworded in one place fails here until it is in the other.
 *
 * "OFFLINE" HERE is the station forced offline (SCRUM-285): `OPS_TEST_CONTROLS`
 * on, the session's selected station on a virtual box, and that box's
 * `edge.box_state.offline` set. It is the platform's refusal a till meets
 * before the box lane exists, and it is the refusal these rows are asserted
 * against today.
 */

type Offline = string;

interface Capability {
  operation: string;
  offline: Offline;
  /** Where a works row is built. Absent on the rows asserted here. */
  pending?: string;
}

/** Plan §2.8, in its order, word for word in the first two columns. */
const CAPABILITIES: Capability[] = [
  { operation: 'Unlock a locked till', offline: 'Works', pending: 'round 3: bridge unlock and the box session' },
  { operation: 'Fresh sign-in', offline: 'Works, bounded', pending: 'round 3: the fresh-sign-in rule (OD-6)' },
  { operation: 'Find a member by phone', offline: 'Works', pending: 'round 3: the members cache and the offline overlay' },
  {
    operation: 'Create a member; add or edit a child; confirm who is visiting',
    offline: 'Works',
    pending: 'round 3: the member, child and visit producers (named before saving since round 1)',
  },
  { operation: 'Ticket, F&B and shop pricing', offline: 'Works, bounded', pending: 'round 3: the priced cart on the bridge (OD-5)' },
  { operation: 'Promo code', offline: 'Works', pending: 'round 3: the till’s copy, filed as applied (SCRUM-401)' },
  { operation: 'Manual discount, ฿0 comp, tier change', offline: 'Works', pending: 'rounds 3 and 4: cached permissions and the ฿0 replay (OD-11)' },
  { operation: 'Cash', offline: 'Works', pending: 'round 4: SaleQueue.record, drawer after disk' },
  { operation: 'Card on the terminal', offline: 'Works', pending: 'round 4: the box’s terminal adapter (OD-3)' },
  { operation: 'PAX (Digio) QR', offline: 'Works, flagged', pending: 'round 4: awaiting_settlement' },
  { operation: '2C2P QR', offline: 'Refused' },
  { operation: 'Gift or prize voucher', offline: 'Refused' },
  { operation: 'Wallet spend', offline: 'Refused' },
  { operation: 'Online booking redemption', offline: 'Refused' },
  { operation: 'Refund, void', offline: 'Refused; a "refund requested" note queues' },
  { operation: 'Receipt and bands for an offline sale', offline: 'Works', pending: 'round 4: the shared print composer and the box’s queue' },
  { operation: 'Reprint', offline: 'Works for today\'s sales on this box', pending: 'round 4: the box’s print log' },
  { operation: 'Customer display', offline: 'Works', pending: 'round 3: displaySession on the bridge (OD-10)' },
  { operation: 'History, Today, reports', offline: 'Refused politely' },
  { operation: 'Child check-in and release', offline: 'Rides this bridge in S2-13', pending: 'S2-13, not this cluster' },
];

/** The platform's words for a station that is offline — the answer a till gets. */
const OFFLINE_REFUSAL = {
  code: 'STATION_FORCED_OFFLINE',
  message:
    'This station is forced offline for testing. Go online before taking payment or changing the sale.',
};

const byOperation = (operation: string): Capability => {
  const row = CAPABILITIES.find((c) => c.operation === operation);
  if (!row) throw new Error(`no such capability row: ${operation}`);
  return row;
};

/** §17's table, as rows of cells, read from the document itself. */
function publishedRows(): string[][] {
  const doc = readFileSync(
    fileURLToPath(new URL('../../../docs/architecture/ARCHITECTURE.md', import.meta.url)),
    'utf8',
  );
  const start = doc.indexOf('\n## 17.');
  expect(start, 'ARCHITECTURE.md has no section 17').toBeGreaterThan(0);
  const next = doc.indexOf('\n## ', start + 1);
  const section = doc.slice(start, next < 0 ? undefined : next);
  return section
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Operation |'))
    .map((line) =>
      line
        .slice(1, -1)
        .split(' | ')
        .map((cell) => cell.trim()),
    );
}

describe('the list is the one ARCHITECTURE.md publishes', () => {
  it('§17 lists exactly these operations, in this order, with the same offline answer', () => {
    const published = publishedRows().map(([operation, offline]) => ({
      operation: operation!.replace(/`/g, ''),
      offline: offline!.replace(/`/g, ''),
    }));
    expect(published).toEqual(CAPABILITIES.map(({ operation, offline }) => ({ operation, offline })));
  });

  it('says "pending" in §17 exactly where this file has a pending case', () => {
    const pendingInDoc = publishedRows()
      .filter(([, , , status]) => /^Pending|^S2-13$/.test(status ?? ''))
      .map(([operation]) => operation!.replace(/`/g, ''));
    expect(pendingInDoc).toEqual(CAPABILITIES.filter((c) => c.pending).map((c) => c.operation));
  });
});

describe('what works offline arrives with the box lane (plan §4)', () => {
  for (const row of CAPABILITIES.filter((c) => c.pending)) {
    it.todo(`${row.operation} — ${row.offline.toLowerCase()} offline; asserted from ${row.pending}`);
  }
});

describe('what is refused offline is refused in the platform’s own words', () => {
  let ctx: TestContext;
  let cookie: string;
  let branchId: string;
  let stationId: string;
  let boxId: string;
  let packageId: string;

  const offline = async (value: boolean): Promise<void> => {
    await ctx.db
      .insert(boxState)
      .values({ boxId, offline: value })
      .onConflictDoUpdate({ target: boxState.boxId, set: { offline: value } });
  };

  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

  /** A sale rung up while the station was online, left unpaid. */
  const rungUp = async (): Promise<string> => {
    const id = newId();
    const res = await call('POST', '/sales', {
      id,
      stationId,
      finalise: false,
      lines: [{ id: newId(), packageId, kids: 1, adults: 1 }],
    });
    expect(res.statusCode, res.body).toBe(200);
    return id;
  };

  /** A sale rung up and paid in cash while the station was online. */
  const paidInCash = async (): Promise<string> => {
    const id = await rungUp();
    const paid = await call('POST', `/sales/${id}/finalise`, { method: 'cash' });
    expect(paid.statusCode, paid.body).toBe(200);
    return id;
  };

  const expectRefusedOffline = (res: { statusCode: number; json: () => unknown; headers: Record<string, unknown> }) => {
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: unknown }).error).toEqual(OFFLINE_REFUSAL);
    expect(res.headers['x-oto-replay']).toBeUndefined();
  };

  beforeAll(async () => {
    ctx = await createTestContext({ env: { OPS_TEST_CONTROLS: 'true' } });
    cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    // The branch reception signed in at, as the SCRUM-285 proof finds it.
    const [staff] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone));
    const [seat] = await ctx.db
      .select({ branchId: sessionTable.branchId })
      .from(sessionTable)
      .where(eq(sessionTable.accountId, staff!.id))
      .limit(1);
    branchId = seat!.branchId!;
    const tills = await ctx.db
      .select()
      .from(station)
      .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
    const till = tills.find((row) => row.name === 'Reception Till 1') ?? tills[0]!;
    stationId = till.id;
    boxId = till.boxId!;
    // The toggle is the VIRTUAL box's; a Pi is never fenced by it (SCRUM-285).
    await ctx.db.update(box).set({ role: 'virtual' }).where(eq(box.id, boxId));
    const picked = await call('PUT', '/me/session/station', { stationId });
    expect(picked.statusCode, picked.body).toBe(200);
    const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
    packageId = packages.find((row) => row.name === '2 Hours Play')!.id;
  }, 180_000);

  beforeEach(async () => {
    await offline(false);
  });

  afterAll(async () => {
    await ctx.close();
    await teardownAll();
  });

  it(`2C2P QR — ${byOperation('2C2P QR').offline}: minting is a server call, and no attempt is written`, async () => {
    const saleId = await rungUp();
    await offline(true);
    expectRefusedOffline(
      await call('POST', '/payments/attempts', {
        saleId,
        tender: 'qr',
        qrDirection: 'show',
        requestQrPayload: true,
        actionId: newId(),
      }),
    );
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toEqual([]);
  });

  it(`Gift or prize voucher — ${byOperation('Gift or prize voucher').offline}: single use is the server's to judge`, async () => {
    const saleId = await rungUp();
    const heldBefore = await ctx.db.select().from(voucherRedemption);
    await offline(true);
    expectRefusedOffline(await call('GET', '/vouchers/lookup?code=OFFLINE-VOUCHER'));
    expectRefusedOffline(await call('POST', `/sales/${saleId}/vouchers`, { code: 'OFFLINE-VOUCHER' }));
    expect(await ctx.db.select().from(voucherRedemption)).toHaveLength(heldBefore.length);
  });

  it(`Wallet spend — ${byOperation('Wallet spend').offline}: no route spends a wallet, online or offline (OD-14)`, () => {
    // A tripwire rather than a request: there is nothing to refuse yet. The day
    // the wallet ticket adds a spend, this fails until its capped offline row
    // is written here and in §17.
    const spends = ctx.app.routeRegistry
      .filter((r) => r.method !== 'GET' && r.method !== 'HEAD' && /wallet/i.test(r.url))
      .map((r) => `${r.method} ${r.url}`);
    expect(spends).toEqual([]);
  });

  it(`Online booking redemption — ${byOperation('Online booking redemption').offline}: refused before the booking is read`, async () => {
    await offline(true);
    expectRefusedOffline(await call('POST', `/bookings/${newId()}/redeem`, { stationId }));
  });

  it(`Refund, void — refused, and the sale is left as it was (decision 8)`, async () => {
    const paid = await paidInCash();
    const open = await rungUp();
    await offline(true);
    expectRefusedOffline(
      await call('POST', `/sales/${paid}/refunds`, { mode: 'whole', reason: 'Offline proof', actionId: newId() }),
    );
    expectRefusedOffline(await call('POST', `/sales/${open}/void`, { reason: 'Offline proof' }));
    const [paidRow] = await ctx.db.select().from(sale).where(eq(sale.id, paid));
    const [openRow] = await ctx.db.select().from(sale).where(eq(sale.id, open));
    expect(paidRow!.status).toBe('finalised');
    expect(openRow!.status).toBe('tendering');
    expect(await ctx.db.select().from(refund).where(eq(refund.saleId, paid))).toEqual([]);
    // The "refund requested" note is the till's to keep (`lib/refundRequests.ts`):
    // what the platform owes it is this refusal, so it knows to keep one.
  });

  it(`History, Today, reports — ${byOperation('History, Today, reports').offline}: platform reads, which no box serves`, async () => {
    const saleId = await paidInCash();
    await offline(true);
    // The platform does not pretend: its reads are the ledger's, offline flag
    // or not, and the sale is there the moment the till can ask again.
    const listed = await call('GET', `/sales?branchId=${branchId}`);
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { sales: { id: string }[] }).sales.map((s) => s.id)).toContain(saleId);
    // And nothing on a box's surface answers them: offline, the till has
    // nobody to ask, and says so (`pages/History.tsx`, "No connection to the
    // platform, so … cannot be read here").
    const boxServed = ctx.app.routeRegistry
      .filter((r) => r.url.startsWith('/box/') && /sale|report|today|history/i.test(r.url))
      .map((r) => `${r.method} ${r.url}`);
    expect(boxServed).toEqual([]);
  });
});
